import { createPublicClient, http, parseTransaction, TransactionReceiptNotFoundError } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { getConfig } from './config.js';
import { query } from './db.js';
import { AppError } from './errors.js';
import { withRelayerLock } from './relayer-lock.js';
import { validateRelayerTransaction } from './relayer-outbox.js';
import { findWelcomeGrant, readWelcomeFundingEvidence, settleWelcomeGrant } from './welcome-grants.js';
import { readFaucetFundingEvidence, settleFaucetClaim } from './faucet.js';
import { reconcileMixRegistration } from './mix-registration.js';
import { withTransaction } from './db.js';
import { reconcileMixPublication } from './mix-publication.js';
import { getChain } from './chain.js';
import type { ChainConfig } from './chain.js';
import { TESTNET_97 } from './testnet-profile.js';

type Pending = { kind: 'welcome' | 'faucet'; id: string; chain_id: string; day: string; owner: Address; account: Address;
  amount_wei: string; state: 'submitted' | 'unknown'; tx_hash: Hex; signed_raw_tx: Hex | null };
type Options = { chain?: ChainConfig; client?: PublicClient; operator?: Address; replay?: boolean; timeoutMs?: number };
async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('relayer reconciliation timeout')), ms); })]); }
  finally { clearTimeout(timer); }
}

/** One relayer session lock across read/validation/replay/settlement. No key or new nonce.
 * Legacy hash-only rows and ambiguous outcomes remain charged, including across UTC days.
 * Returns counts only: never put signed bytes, driver errors or RPC URLs in output.
 */
export async function reconcileRelayerTransactions(options: Options = {}) {
  const counts = { confirmed: 0, failed: 0, replayed: 0, unresolved: 0 };
  const config = getConfig();
  if (!options.client && config.chainId !== 97) return counts;
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('invalid reconciliation timeout');
  const client = options.client ?? options.chain?.publicClient ?? createPublicClient({ transport: http(config.rpcUrl ?? undefined, { timeout: timeoutMs, retryCount: 0 }) });
  await withRelayerLock(97, async held => {
    const rows = (await query<Pending>(`select 'welcome' as kind,g.id,g.chain_id,to_char(g.utc_day,'YYYY-MM-DD') as day,
        g.owner,g.account,g.amount_wei,g.state,g.tx_hash,o.signed_raw_tx
      from welcome_grants g left join relayer_transaction_outbox o on o.welcome_grant_id=g.id and o.tx_hash=g.tx_hash and o.chain_id=g.chain_id
      where g.chain_id=97 and g.state in ('submitted','unknown') and g.tx_hash is not null
      union all select 'faucet',g.id,g.chain_id,to_char(g.utc_day,'YYYY-MM-DD'),g.owner,g.account,g.amount_wei,g.state,g.tx_hash,o.signed_raw_tx
      from faucet_claims g left join relayer_transaction_outbox o on o.faucet_claim_id=g.id and o.tx_hash=g.tx_hash and o.chain_id=g.chain_id
      where g.chain_id=97 and g.state in ('submitted','unknown') and g.tx_hash is not null limit 20`)).rows;
    for (const row of rows) {
      try {
        held();
        if (!row.signed_raw_tx || (!options.client && !config.rpcUrl)) throw new Error('original transaction unavailable');
        const source = { kind: row.kind, id: row.id, chainId: Number(row.chain_id), account: row.account, amountWei: BigInt(row.amount_wei) };
        await validateRelayerTransaction(source, row.tx_hash, row.signed_raw_tx, options.operator);
        if (await bounded(client.getChainId(), timeoutMs) !== 97) throw new Error('RPC chain mismatch');
        let receipt;
        try { receipt = await bounded(client.getTransactionReceipt({ hash: row.tx_hash }), timeoutMs); }
        catch (error) {
          if (!(error instanceof TransactionReceiptNotFoundError) || !options.replay) throw error;
          held();
          const hash = await bounded(client.sendRawTransaction({ serializedTransaction: row.signed_raw_tx }), timeoutMs);
          if (hash.toLowerCase() !== row.tx_hash) throw new Error('replay hash mismatch');
          counts.replayed++;
          // Even successful replay is unresolved until canonical evidence is observed.
          counts.unresolved++;
          continue;
        }
        const [block, tx] = await bounded(Promise.all([client.getBlock({ blockNumber: receipt.blockNumber }), client.getTransaction({ hash: row.tx_hash })]), timeoutMs);
        const original = parseTransaction(row.signed_raw_tx);
        if (receipt.transactionHash.toLowerCase() !== row.tx_hash || receipt.blockNumber < 0n || !/^0x[0-9a-f]{64}$/.test(receipt.blockHash) ||
            block.hash !== receipt.blockHash || block.number !== receipt.blockNumber || tx.hash.toLowerCase() !== row.tx_hash ||
            tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber || tx.nonce !== original.nonce ||
            tx.from.toLowerCase() !== (options.operator ?? TESTNET_97.roles.operator).toLowerCase() || tx.to?.toLowerCase() !== original.to?.toLowerCase() ||
            tx.value !== (original.value ?? 0n) || tx.input.toLowerCase() !== original.data?.toLowerCase()) throw new Error('original canonical transaction required');
        if (receipt.status !== 'success' && receipt.status !== 'reverted') throw new Error('unknown receipt status');
        const claim = { ...source, owner: row.owner, day: row.day };
        const state = receipt.status === 'reverted' ? 'failed' : 'confirmed';
        if (row.kind === 'welcome') {
          const grant = await findWelcomeGrant(97, row.owner);
          if (!grant || grant.id !== row.id || grant.txHash !== row.tx_hash || grant.state !== row.state || grant.day !== row.day ||
              grant.account !== row.account || grant.amountWei !== source.amountWei) throw new Error('source changed');
          const evidence = state === 'confirmed' ? await bounded(readWelcomeFundingEvidence({ ...source, txHash: row.tx_hash }, client, options.operator), timeoutMs) : undefined;
          held(); await settleWelcomeGrant(grant, state, row.tx_hash, evidence);
        } else {
          if (state === 'confirmed') await bounded(readFaucetFundingEvidence({ ...source, txHash: row.tx_hash }, client, options.operator), timeoutMs);
          held(); await settleFaucetClaim(claim, row.state, state, row.tx_hash);
        }
        counts[state]++;
      } catch { counts.unresolved++; }
    }
    const mixes = (await query<{ id: string; state: string }>(`select id,state from mix_creation_requests where chain_id=97 and registration_tx_hash is not null
      and (state='submitted' or state='registered' and last_error_code='VERSION_PUBLICATION_PENDING') order by id limit 20`)).rows;
    for (const mix of mixes) {
      // A confirmed registration must not be replayed to resolve a different publication.
      if (mix.state === 'registered') { counts.unresolved++; continue; }
      try {
        held();
        const result = await reconcileMixRegistration(mix.id, { client, query, transaction: withTransaction,
          operator: options.operator, assertHeld: held, timeoutMs }, options.replay);
        if (result === 'registered') counts.confirmed++;
        else { counts.unresolved++; if (result === 'replayed') counts.replayed++; }
      } catch { counts.unresolved++; }
    }
    return counts;
  }, { reconcile: true }).catch(() => { throw new AppError(503, 'RELAYER_RECONCILIATION_UNAVAILABLE', 'relayer reconciliation unavailable; original transactions retained'); });
  // Each publication owns only its job lock during RPC/receipt work. One bad mix
  // cannot keep the faucet's shared nonce lock while waiting for a receipt.
  const jobs = (await query<{ strategy_id: string }>("select strategy_id from mix_publication_jobs where chain_id=97 and state<>'confirmed' order by updated_at,strategy_id limit 20")).rows;
  for (const job of jobs) {
    try {
      const chain = options.chain ?? (options.client ? undefined : getChain());
      const result = await reconcileMixPublication(job.strategy_id, { client, chain, operator: options.operator,
        query, transaction: withTransaction, timeoutMs }, options.replay);
      if (result === 'confirmed') counts.confirmed++;
      else if (result === 'reverted') counts.failed++;
      else { counts.unresolved++; if (result === 'replayed') counts.replayed++; }
    } catch { counts.unresolved++; }
  }
  return counts;
}
