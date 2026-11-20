import { decodeEventLog, encodeFunctionData, keccak256, parseTransaction, recoverTransactionAddress, serializeTransaction, TransactionReceiptNotFoundError } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { bscTestnet } from 'viem/chains';
import { getChain } from './chain.js';
import type { ChainConfig } from './chain.js';
import { REGISTRY_ABI } from './registry-abi.js';
import { query, withTransaction } from './db.js';
import { withRelayerLock, relayerNonce } from './relayer-lock.js';
import { MIX_CREATION_COLUMNS } from './mix-creation.js';
import type { MixCreation } from './mix-creation.js';
import { mixUnavailable } from './mix-store.js';
import { TESTNET_97 as T } from './testnet-profile.js';

export const MIX_REGISTRATION_DATA = encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'registerStrategy', args: ['CRE8 mix', 'My mix', false] });
type Identity = { operator?: Address; registry?: Address };
export type MixRegistrationDeps = Identity & { client: PublicClient; query: typeof query; transaction: typeof withTransaction; assertHeld?: () => void; timeoutMs?: number };
const load = async (id: string, db: typeof query) => {
  const row = (await db<MixCreation>(`select ${MIX_CREATION_COLUMNS} from mix_creation_requests where id=$1`, [id])).rows[0];
  if (!row || row.chain_id !== '97') throw mixUnavailable();
  return row;
};
/** Pure validation before storage AND replay. Never expose raw, signatures or parser errors. */
export async function validateMixRegistration(hash: Hex, raw: Hex, identity: Identity = {}, expectedNonce?: number): Promise<void> {
  try {
    if (!/^0x[0-9a-f]{64}$/.test(hash) || !/^0x([0-9a-f]{2})+$/.test(raw) || keccak256(raw) !== hash) throw mixUnavailable();
    const tx = parseTransaction(raw);
    if ((tx.type !== 'legacy' && tx.type !== 'eip1559') || tx.chainId !== 97 || !Number.isSafeInteger(tx.nonce) || tx.nonce === undefined || tx.nonce < 0 ||
        expectedNonce !== undefined && tx.nonce !== expectedNonce || !tx.gas || tx.gas <= 0n || (tx.value ?? 0n) !== 0n ||
        tx.to?.toLowerCase() !== (identity.registry ?? T.contracts.registry).toLowerCase() || tx.data !== MIX_REGISTRATION_DATA || !tx.r || !tx.s) throw mixUnavailable();
    const serialized = serializeTransaction(tx, { r: tx.r, s: tx.s, v: tx.v ?? BigInt(27 + (tx.yParity ?? 0)) });
    if (keccak256(serialized) !== hash || (await recoverTransactionAddress({ serializedTransaction: serialized })).toLowerCase() !==
        (identity.operator ?? T.roles.operator).toLowerCase()) throw mixUnavailable();
  } catch { throw mixUnavailable(); }
}

/** Called under the shared relayer lock. Unknown receipt may replay ONLY durable original bytes. */
export async function reconcileMixRegistration(id: string, deps: MixRegistrationDeps, replay = false): Promise<'registered' | 'replayed' | 'unresolved'> {
  const row = await load(id, deps.query);
  const outbox = (await deps.query<{ tx_hash: Hex; signed_raw_tx: Hex }>(`select tx_hash,signed_raw_tx from mix_registration_outbox
    where request_id=$1 and chain_id=97`, [id])).rows[0];
  if (!outbox || row.registration_tx_hash !== outbox.tx_hash) throw mixUnavailable();
  await validateMixRegistration(outbox.tx_hash, outbox.signed_raw_tx, deps);
  const client = deps.client;
  const rpc = async <R>(work: Promise<R>): Promise<R> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(mixUnavailable()), deps.timeoutMs ?? 5000); })]); }
    finally { clearTimeout(timer); }
  };
  if (await rpc(client.getChainId()) !== 97) throw mixUnavailable();
  let receipt;
  try { receipt = await rpc(client.getTransactionReceipt({ hash: outbox.tx_hash })); }
  catch (error) {
    if (!(error instanceof TransactionReceiptNotFoundError) || !replay || row.state !== 'submitted') throw mixUnavailable();
    deps.assertHeld?.();
    const hash = await rpc(client.sendRawTransaction({ serializedTransaction: outbox.signed_raw_tx }));
    if (hash !== outbox.tx_hash) throw mixUnavailable();
    return 'replayed';
  }
  const original = parseTransaction(outbox.signed_raw_tx);
  const [block, tx] = await rpc(Promise.all([client.getBlock({ blockNumber: receipt.blockNumber }), client.getTransaction({ hash: outbox.tx_hash })]));
  if (receipt.transactionHash !== outbox.tx_hash || receipt.status !== 'success' || block.number !== receipt.blockNumber || block.hash !== receipt.blockHash ||
      tx.hash !== outbox.tx_hash || tx.blockNumber !== receipt.blockNumber || tx.blockHash !== receipt.blockHash || tx.nonce !== original.nonce ||
      tx.from.toLowerCase() !== (deps.operator ?? T.roles.operator).toLowerCase() || tx.to?.toLowerCase() !== (deps.registry ?? T.contracts.registry).toLowerCase() ||
      tx.value !== 0n || tx.input !== MIX_REGISTRATION_DATA) throw mixUnavailable();
  const events = receipt.logs.flatMap(log => {
    if (log.address.toLowerCase() !== (deps.registry ?? T.contracts.registry).toLowerCase() || log.removed || log.transactionHash !== outbox.tx_hash ||
        log.blockHash !== receipt.blockHash || log.blockNumber !== receipt.blockNumber || log.logIndex === null) return [];
    try { const event = decodeEventLog({ abi: REGISTRY_ABI, data: log.data, topics: log.topics });
      return event.eventName === 'StrategyRegistered' && event.args.provider.toLowerCase() === (deps.operator ?? T.roles.operator).toLowerCase() &&
        event.args.name === 'CRE8 mix' && event.args.id > 0n ? [event.args.id] : [];
    } catch { return []; }
  });
  const onchainId = events[0];
  if (events.length !== 1 || !onchainId || onchainId > BigInt(Number.MAX_SAFE_INTEGER) ||
      (await rpc(client.getBlock({ blockNumber: receipt.blockNumber }))).hash !== receipt.blockHash) throw mixUnavailable();
  if (row.onchain_strategy_id !== null) {
    if (row.onchain_strategy_id !== onchainId.toString() || row.registration_block_number !== receipt.blockNumber.toString() || row.registration_block_hash !== receipt.blockHash) throw mixUnavailable();
  } else {
    deps.assertHeld?.();
    await deps.query(`update mix_creation_requests set state='registered',onchain_strategy_id=$2,registration_block_number=$3,
      registration_block_hash=$4,updated_at=clock_timestamp() where id=$1 and state='submitted' and registration_tx_hash=$5`,
      [id, onchainId.toString(), receipt.blockNumber.toString(), receipt.blockHash, outbox.tx_hash]);
    if ((await load(id, deps.query)).onchain_strategy_id !== onchainId.toString()) throw mixUnavailable();
  }
  return 'registered';
}

export async function registerMixCreation(id: string, overrides: Partial<MixRegistrationDeps> & { chain?: ChainConfig; lock?: typeof withRelayerLock } = {}): Promise<MixCreation> {
  try {
    const chain = overrides.chain ?? getChain();
    if (chain.chainId !== 97 || chain.registryAddress.toLowerCase() !== T.contracts.registry) throw mixUnavailable();
    const deps: MixRegistrationDeps = { query, transaction: withTransaction, client: chain.publicClient, operator: chain.account.address, registry: chain.registryAddress, ...overrides };
    const initial = await load(id, deps.query);
    if (initial.state === 'registered' || initial.state === 'completed') {
      await reconcileMixRegistration(id, deps); return load(id, deps.query);
    }
    await (overrides.lock ?? withRelayerLock)(97, async held => {
      const row = await load(id, deps.query);
      if (row.state === 'prepared') {
        if (await deps.client.getChainId() !== 97) throw mixUnavailable();
        const request = await chain.wallet.prepareTransactionRequest({ account: chain.account, chain: bscTestnet,
          to: chain.registryAddress, data: MIX_REGISTRATION_DATA, value: 0n, ...(await relayerNonce(deps.client, chain.account.address)) });
        const raw = await chain.wallet.signTransaction(request), hash = keccak256(raw);
        await validateMixRegistration(hash, raw, deps, request.nonce);
        held();
        await deps.transaction(async client => {
          const current = (await client.query<MixCreation>(`select ${MIX_CREATION_COLUMNS} from mix_creation_requests where id=$1 for update`, [id])).rows[0];
          if (!current || current.state !== 'prepared' || current.registration_tx_hash !== null) throw mixUnavailable();
          await client.query('insert into mix_registration_outbox(request_id,chain_id,tx_hash,signed_raw_tx) values($1,97,$2,$3)', [id, hash, raw]);
          await client.query("update mix_creation_requests set state='submitted',registration_tx_hash=$2,updated_at=clock_timestamp() where id=$1", [id, hash]);
        });
        // Even an ambiguous COMMIT throws above: do not broadcast until a later read/retry.
        held();
        if (await deps.client.sendRawTransaction({ serializedTransaction: raw }) !== hash) throw mixUnavailable();
        await deps.client.waitForTransactionReceipt({ hash, timeout: 30000 });
      }
      held();
      if (await reconcileMixRegistration(id, { ...deps, assertHeld: held }, true) !== 'registered') throw mixUnavailable();
    }, { reconcile: initial.state === 'submitted' });
    return load(id, deps.query);
  } catch { throw mixUnavailable(); }
}
