import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, http, keccak256, parseAbi, zeroAddress } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';
import { RECEIPT_POLLING_MS } from './chain-object.js';
import { getConfig, loadWelcomeConfig, WELCOME_AMOUNT_WEI } from './config.js';
import type { WelcomeConfig } from './config.js';
import { query, withTransaction } from './db.js';
import { AppError } from './errors.js';
import { withRelayerLock, relayerNonce } from './relayer-lock.js';
import { TESTNET_97 } from './testnet-profile.js';
import type { FaucetFundingEvidence } from './faucet.js';
import { saveRelayerTransaction } from './relayer-outbox.js';
import type { SignedSubmission } from './relayer-outbox.js';
import { validateRelayerTransaction } from './relayer-outbox.js';
import { outboxIdentity, saveOutboxIdentity, saveOutboxConsumption } from './relayer-nonce-consumption.js';
import type { FundingNonceConsumption } from './relayer-nonce-consumption.js';
import { recordAlerts, welcomeNonceConsumedAlert } from './alerts.js';
import { rpcTransport } from './rpc-transport.js';

export const WELCOME_ABI = parseAbi([
  'function welcomeFor(address to)',
  'function isFaucet(address account) view returns(bool)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
export type WelcomeState = 'reserved' | 'submitted' | 'unknown' | 'confirmed' | 'failed';
export type WelcomeGrant = {
  id: string; chainId: 97; day: string; owner: Address; portfolioId: number; account: Address;
  amountWei: bigint; state: WelcomeState; txHash: Hex | null;
  logIndex: number | null; blockNumber: bigint | null; blockHash: Hex | null;
};
type GrantRow = { id: string; chain_id: string; day: string; owner: Address; portfolio_id: string; account: Address;
  amount_wei: string; state: WelcomeState; tx_hash: Hex | null; log_index: string | null; block_number: string | null; block_hash: Hex | null };
type Recipient = Pick<WelcomeGrant, 'chainId' | 'owner' | 'portfolioId' | 'account'>;
const columns = "*,to_char(utc_day,'YYYY-MM-DD') as day";
const lockSql = "select pg_advisory_xact_lock(hashtextextended('welcome_grants:' || $1::bigint::text || ':' || to_char($2::date,'YYYY-MM-DD'),0))";
const storage = () => new AppError(503, 'WELCOME_STORAGE_UNAVAILABLE', 'welcome storage unavailable; retry the original purchase');
function mapGrant(row: GrantRow): WelcomeGrant {
  if (row.chain_id !== '97' || BigInt(row.amount_wei) !== WELCOME_AMOUNT_WEI || !Number.isSafeInteger(Number(row.portfolio_id))) throw storage();
  return { id: row.id, chainId: 97, day: row.day, owner: row.owner, portfolioId: Number(row.portfolio_id), account: row.account,
    amountWei: BigInt(row.amount_wei), state: row.state, txHash: row.tx_hash, logIndex: row.log_index === null ? null : Number(row.log_index),
    blockNumber: row.block_number === null ? null : BigInt(row.block_number), blockHash: row.block_hash };
}
export async function findWelcomeGrant(chainId: number, owner: string): Promise<WelcomeGrant | null> {
  try {
    const row = (await query<GrantRow>(`select ${columns} from welcome_grants where chain_id=$1 and owner=$2`, [chainId, owner.toLowerCase()])).rows[0];
    return row ? mapGrant(row) : null;
  } catch { throw storage(); }
}

/** 0033: lifetime identity includes failed. Only the caller receiving a NEW committed reservation may prepare once. */
export async function reserveWelcomeGrant(recipient: Recipient, c: WelcomeConfig, transaction = withTransaction) {
  try {
    return await transaction(async client => {
      await client.query('set transaction isolation level read committed');
      await client.query("select set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)", [String(c.timeoutMs)]);
      const day = (await client.query<{ day: string }>("select to_char(transaction_timestamp() at time zone 'UTC','YYYY-MM-DD') as day")).rows[0]?.day;
      if (!day || recipient.chainId !== 97) throw storage();
      await client.query(lockSql, [recipient.chainId, day]);
      const old = (await client.query<GrantRow>(`select ${columns} from welcome_grants where chain_id=$1 and owner=$2`, [recipient.chainId, recipient.owner.toLowerCase()])).rows[0];
      if (old) return { grant: mapGrant(old), created: false };
      const used = (await client.query<{ amount: string }>("select coalesce(sum(amount_wei),0)::text as amount from welcome_grants where chain_id=$1 and utc_day=$2::date and state<>'failed'", [recipient.chainId, day])).rows[0]?.amount;
      if (!used || !/^\d+$/.test(used)) throw storage();
      if (BigInt(used) + WELCOME_AMOUNT_WEI > c.siteDailyWei) throw new AppError(429, 'WELCOME_QUOTA_EXCEEDED', 'welcome site daily cap reached; try again tomorrow');
      const row = (await client.query<GrantRow>(`insert into welcome_grants(chain_id,owner,portfolio_id,account,amount_wei)
        values($1,$2,$3,$4,$5) returning ${columns}`, [recipient.chainId, recipient.owner.toLowerCase(), recipient.portfolioId, recipient.account.toLowerCase(), WELCOME_AMOUNT_WEI.toString()])).rows[0];
      if (!row) throw storage();
      return { grant: mapGrant(row), created: true };
    });
  } catch (error) { throw error instanceof AppError ? error : storage(); }
}

/** Every update locks the original reservation day, then reads FOR UPDATE and applies a state/hash CAS. */
export async function settleWelcomeGrant(grant: WelcomeGrant, state: WelcomeState, hash: Hex | null,
  evidence?: FaucetFundingEvidence, transaction = withTransaction, signed?: SignedSubmission, consumption?: FundingNonceConsumption): Promise<void> {
  try {
    await transaction(async client => {
      await client.query('set transaction isolation level read committed');
      await client.query("set local statement_timeout='5s'");
      await client.query("set local lock_timeout='5s'");
      await client.query(lockSql, [grant.chainId, grant.day]);
      const old = (await client.query<GrantRow>(`select ${columns} from welcome_grants where id=$1 for update`, [grant.id])).rows[0];
      if (!old || old.state !== grant.state || old.tx_hash !== grant.txHash || old.day !== grant.day || old.owner !== grant.owner ||
          old.account !== grant.account || Number(old.portfolio_id) !== grant.portfolioId || old.chain_id !== '97' || BigInt(old.amount_wei) !== grant.amountWei) throw storage();
      if (consumption) {
        if (!hash || hash !== old.tx_hash || !['submitted','unknown'].includes(old.state) || state !== 'failed' || evidence !== undefined) throw storage();
        await validateRelayerTransaction({ ...grant, kind: 'welcome' }, hash, consumption.raw, consumption.operator);
        const original = await outboxIdentity(hash, consumption.raw, consumption.operator);
        await saveOutboxIdentity(client, original, { fundingTxHash: hash });
        await saveOutboxConsumption(client, original, consumption.proof);
      }
      if (state === 'submitted') {
        if (!hash || !signed || grant.state !== 'reserved' || grant.txHash !== null) throw storage();
        await saveRelayerTransaction(client, { ...grant, kind: 'welcome' }, hash, signed);
      }
      const result = await client.query(`update welcome_grants set state=$2,tx_hash=coalesce(tx_hash,$3),log_index=$4,block_number=$5,block_hash=$6,updated_at=clock_timestamp()
        where id=$1 and state=$7 returning id`, [grant.id, state, hash, evidence?.logIndex ?? null, evidence?.blockNumber.toString() ?? null, evidence?.blockHash ?? null, grant.state]);
      if (result.rows.length !== 1) throw storage();
    });
    // Auxiliary alert storage must not roll back proven consumption or hold the
    // shared nonce hostage. The scheduler can retry from the durable source,
    // including when a lost COMMIT response interrupts this immediate attempt.
    if (consumption && hash) {
      try { await recordAlerts(query, [welcomeNonceConsumedAlert({ ...grant, txHash: hash })]); }
      catch { console.warn('[welcome] 外部 nonce 消耗補發告警儲存失敗，保留持久來源待排程重試。'); }
    }
  } catch { throw storage(); }
}

/** Do not infer funding from balances. Verify the original operator mint and one canonical zero-origin event. */
export async function readWelcomeFundingEvidence(grant: { chainId: number; account: Address; amountWei: bigint; txHash: Hex }, suppliedClient?: PublicClient, operator: Address = TESTNET_97.roles.operator): Promise<FaucetFundingEvidence> {
  try {
    if (grant.chainId !== 97 || grant.amountWei !== WELCOME_AMOUNT_WEI) throw new AppError(400, 'FUNDING_SOURCE_DISABLED', 'welcome requires chain 97 and exactly 10000 test USDT');
    const client = suppliedClient ?? createPublicClient({ transport: rpcTransport('welcome-grants', getConfig().rpcUrl ?? undefined, { timeout: 5_000, retryCount: 0 }) });
    if (!suppliedClient && !getConfig().rpcUrl || await client.getChainId() !== 97) throw new Error('wrong RPC chain');
    const [receipt, tx] = await Promise.all([client.getTransactionReceipt({ hash: grant.txHash }), client.getTransaction({ hash: grant.txHash })]);
    if (receipt.transactionHash.toLowerCase() !== grant.txHash || tx.hash.toLowerCase() !== grant.txHash ||
        receipt.blockNumber < 0n || !/^0x[0-9a-f]{64}$/.test(receipt.blockHash)) throw new Error('missing receipt identity');
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (block.hash !== receipt.blockHash || block.number !== receipt.blockNumber) throw new AppError(409, 'FUNDING_REORGED', 'welcome receipt is not canonical; reconciliation required');
    if (tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber || tx.from.toLowerCase() !== operator.toLowerCase() ||
        tx.to?.toLowerCase() !== TESTNET_97.contracts.usdt || tx.value !== 0n ||
        tx.input.toLowerCase() !== encodeFunctionData({ abi: WELCOME_ABI, functionName: 'welcomeFor', args: [grant.account] }).toLowerCase()) {
      throw new AppError(409, 'FUNDING_NOT_CONFIRMED', 'original authorized operator mint is required');
    }
    if (receipt.status === 'reverted') throw new AppError(409, 'WELCOME_REVERTED', 'welcome mint reverted; use the daily faucet');
    if (receipt.status !== 'success' || !await client.readContract({ address: TESTNET_97.contracts.usdt, abi: WELCOME_ABI, functionName: 'isFaucet',
      args: [operator], blockNumber: receipt.blockNumber })) throw new AppError(409, 'FUNDING_NOT_CONFIRMED', 'authorized successful mint is required');
    const matches = receipt.logs.filter(log => {
      if (log.address.toLowerCase() !== TESTNET_97.contracts.usdt || log.removed || log.transactionHash?.toLowerCase() !== grant.txHash ||
          log.blockHash !== receipt.blockHash || log.blockNumber !== receipt.blockNumber || log.logIndex === null || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0) return false;
      try {
        const event = decodeEventLog({ abi: WELCOME_ABI, eventName: 'Transfer', data: log.data, topics: log.topics });
        return event.args.from === zeroAddress && event.args.to.toLowerCase() === grant.account.toLowerCase() && event.args.value === WELCOME_AMOUNT_WEI;
      } catch { return false; }
    });
    const log = matches[0];
    if (matches.length !== 1 || !log || log.logIndex === null) throw new AppError(409, 'FUNDING_NOT_CONFIRMED', 'one exact canonical welcome Transfer is required');
    const confirmedAt = new Date(Number(block.timestamp) * 1000);
    if (!Number.isSafeInteger(Number(block.timestamp)) || block.timestamp < 0n || !Number.isFinite(confirmedAt.getTime())) throw new Error('invalid confirmation time');
    return { txHash: grant.txHash, logIndex: log.logIndex, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, amountRaw: WELCOME_AMOUNT_WEI.toString(), confirmedAt };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'FUNDING_RPC_UNAVAILABLE', 'welcome confirmation unavailable; retry original purchase');
  }
}

export type PreparedWelcome = { hash: Hex; raw: Hex; broadcast: () => Promise<void>; wait: () => Promise<void> };
async function prepareWelcome(grant: WelcomeGrant, c: WelcomeConfig): Promise<PreparedWelcome> {
  const config = getConfig();
  if (!config.rpcUrl || !config.operatorPrivateKey || !/^0x[0-9a-fA-F]{64}$/.test(config.operatorPrivateKey)) throw new Error('operator unavailable');
  const operator = privateKeyToAccount(config.operatorPrivateKey as Hex);
  if (operator.address.toLowerCase() !== TESTNET_97.roles.operator) throw new Error('operator mismatch');
  const transport = rpcTransport('welcome-grants', config.rpcUrl, { retryCount: 0, timeout: c.timeoutMs });
  const client = createPublicClient({ chain: bscTestnet, transport });
  if (await client.getChainId() !== 97 || !await client.readContract({ address: TESTNET_97.contracts.usdt, abi: WELCOME_ABI, functionName: 'isFaucet', args: [operator.address] })) throw new Error('operator not authorized');
  const wallet = createWalletClient({ account: operator, chain: bscTestnet, transport });
  const signed = await wallet.signTransaction(await wallet.prepareTransactionRequest({ to: TESTNET_97.contracts.usdt, ...(await relayerNonce(client, operator.address)),
    data: encodeFunctionData({ abi: WELCOME_ABI, functionName: 'welcomeFor', args: [grant.account] }) }));
  const hash = keccak256(signed);
  return { hash, raw: signed, broadcast: async () => { if (await client.sendRawTransaction({ serializedTransaction: signed }) !== hash) throw new Error('unexpected hash'); },
    wait: async () => { await client.waitForTransactionReceipt({ hash, timeout: c.timeoutMs, confirmations: 1, pollingInterval: RECEIPT_POLLING_MS }); } };
}
async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('welcome timeout')), ms); })]); }
  finally { clearTimeout(timer); }
}
export type WelcomeDeps = { config?: WelcomeConfig | null; find?: typeof findWelcomeGrant; reserve?: typeof reserveWelcomeGrant;
  settle?: typeof settleWelcomeGrant; prepare?: typeof prepareWelcome; lock?: typeof withRelayerLock };
export function createWelcomeService(deps: WelcomeDeps = {}) {
  return { async issue(recipient: Recipient): Promise<WelcomeGrant> {
    const c = deps.config === undefined ? loadWelcomeConfig() : deps.config;
    if (!c || recipient.chainId !== 97) throw new AppError(400, 'FUNDING_SOURCE_DISABLED', 'welcome is only available on chain 97');
    const old = await (deps.find ?? findWelcomeGrant)(recipient.chainId, recipient.owner);
    if (old) return old; // includes reserved/failed; never assume an earlier process did not send
    return (deps.lock ?? withRelayerLock)(97, async assertHeld => {
      assertHeld();
      const { grant, created } = await (deps.reserve ?? reserveWelcomeGrant)(recipient, c);
      if (!created) return grant;
      const settle = deps.settle ?? settleWelcomeGrant;
      let prepared: PreparedWelcome;
      try { assertHeld(); prepared = await bounded((deps.prepare ?? prepareWelcome)(grant, c), c.timeoutMs); }
      catch {
        await settle(grant, 'failed', null);
        throw new AppError(503, 'WELCOME_PREPARE_UNAVAILABLE', 'welcome preparation unavailable; no transaction sent; use daily faucet');
      }
      await settle(grant, 'submitted', prepared.hash, undefined, withTransaction, { raw: prepared.raw }); // unknown commit: no broadcast
      const submitted: WelcomeGrant = { ...grant, state: 'submitted', txHash: prepared.hash };
      try { assertHeld(); await bounded(prepared.broadcast(), c.timeoutMs); await bounded(prepared.wait(), c.timeoutMs); }
      catch { await settle(submitted, 'unknown', prepared.hash); return { ...submitted, state: 'unknown' }; }
      return submitted; // caller verifies canonical mint evidence and settles before creating its lot
    });
  } };
}
