import { withRelayerLock, relayerNonce } from './relayer-lock.js';
import { outboxIdentity, saveOutboxIdentity, saveOutboxConsumption } from './relayer-nonce-consumption.js';
import type { FundingNonceConsumption } from './relayer-nonce-consumption.js';
import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, http, isAddress, keccak256, parseAbi } from 'viem';
import type { Address, Hex, PublicClient, TransactionReceipt } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';
import { getConfig, loadFaucetConfig } from './config.js';
import type { FaucetConfig } from './config.js';
import { query, withTransaction } from './db.js';
import type { QueryFn } from './snapshot.js';
import { AppError } from './errors.js';
import { TESTNET_97 } from './testnet-profile.js';
import { saveRelayerTransaction, validateRelayerTransaction } from './relayer-outbox.js';
import type { SignedSubmission } from './relayer-outbox.js';

export const FAUCET_ABI = parseAbi([
  'function claimFor(address to, uint256 amount)',
  'function claimable(address account) view returns (uint256 remaining, uint256 windowEndsAt)',
  'function isFaucet(address account) view returns (bool)',
  'event Claimed(address indexed to, uint256 amount, address indexed by)',
]);
type ClaimState = 'reserved' | 'submitted' | 'confirmed' | 'failed' | 'unknown';
export type FaucetClaim = { id: string; chainId: number; day: string; owner: Address; account: Address; amountWei: bigint };
export type FaucetResult = { claimId: string; state: ClaimState; amountWei: string; txHash: Hex | null; replayed?: true };
type ClaimRequest = { config: FaucetConfig; owner: Address; account: Address };
const unavailable = () => new AppError(503, 'FAUCET_STORAGE_UNAVAILABLE', 'faucet quota storage unavailable');
const quota = () => new AppError(429, 'FAUCET_QUOTA_EXCEEDED', 'one claim per owner per UTC day; site daily cap also applies');
const lockSql = "select pg_advisory_xact_lock(hashtextextended('faucet_claims:' || $1::bigint::text || ':' || to_char($2::date, 'YYYY-MM-DD'), 0))";

/** Replay only the same owner/recipient/day. An active claim for another recipient still consumes the owner cap. */
export async function findDailyFaucetClaim(chainId: number, owner: string, account: string): Promise<FaucetResult | null> {
  try {
    const row = (await query<{ id: string; account: Address; amount: string; state: ClaimState; tx_hash: Hex | null }>(`
      select id::text,account,amount_wei::text as amount,state,tx_hash from faucet_claims
      where chain_id=$1 and owner=$2 and utc_day=(statement_timestamp() at time zone 'UTC')::date
      and (state<>'failed' or account=$3) order by (state<>'failed') desc,id desc limit 1`, [chainId, owner.toLowerCase(), account.toLowerCase()])).rows[0];
    if (!row) return null;
    if (row.account !== account.toLowerCase()) throw quota();
    if (!/^[1-9]\d*$/.test(row.id) || !/^\d+$/.test(row.amount) || !['reserved','submitted','unknown','confirmed','failed'].includes(row.state) ||
        (row.tx_hash !== null && !/^0x[0-9a-f]{64}$/.test(row.tx_hash))) throw unavailable();
    return { claimId: row.id, state: row.state, amountWei: row.amount, txHash: row.tx_hash, replayed: true };
  } catch (error) { throw error instanceof AppError ? error : unavailable(); }
}

/** db 0028: separate lock and aggregate statements, one READ COMMITTED client, commit before sending. */
export async function reserveFaucetClaim(r: ClaimRequest, transaction: typeof withTransaction = withTransaction): Promise<FaucetClaim> {
  try {
    if (r.config.amountWei <= 0n || r.config.siteDailyWei < r.config.amountWei) throw quota();
    return await transaction(async (client) => {
      await client.query('set transaction isolation level read committed');
      await client.query("select set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)", [String(r.config.timeoutMs)]);
      const pinned = await client.query<{ day: string }>("select to_char(transaction_timestamp() at time zone 'UTC', 'YYYY-MM-DD') as day");
      const day = pinned.rows[0]?.day;
      if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw unavailable();
      await client.query(lockSql, [r.config.chainId, day]);
      const usage = await client.query<{ owner_count: string; amount: string }>(`select count(*) filter (where owner=$3)::text as owner_count,
        coalesce(sum(amount_wei),0)::text as amount from faucet_claims where chain_id=$1 and utc_day=$2::date and state <> 'failed'`,
        [r.config.chainId, day, r.owner.toLowerCase()]);
      const used = usage.rows[0];
      if (!used || !/^\d+$/.test(used.amount) || !/^\d+$/.test(used.owner_count)) throw unavailable();
      if (BigInt(used.owner_count) > 0n || BigInt(used.amount) + r.config.amountWei > r.config.siteDailyWei) throw quota();
      const result = await client.query<{ id: string }>(`insert into faucet_claims(chain_id,owner,account,amount_wei)
        values($1,$2,$3,$4) returning id::text`, [r.config.chainId, r.owner.toLowerCase(), r.account.toLowerCase(), r.config.amountWei.toString()]);
      const id = result.rows[0]?.id;
      if (!id || !/^\d+$/.test(id)) throw unavailable();
      return { id, chainId: r.config.chainId, day, owner: r.owner, account: r.account, amountWei: r.config.amountWei };
    });
  } catch (error) { throw error instanceof AppError ? error : unavailable(); }
}

/** Settlement always locks the ORIGINAL UTC day, including after midnight. Never changes immutable fields. */
export async function settleFaucetClaim(claim: FaucetClaim, from: ClaimState, state: ClaimState, hash: Hex | null,
  transaction: typeof withTransaction = withTransaction, signed?: SignedSubmission, consumption?: FundingNonceConsumption): Promise<void> {
  try {
    await transaction(async (client) => {
      await client.query('set transaction isolation level read committed');
      await client.query("set local statement_timeout='5s'");
      await client.query("set local lock_timeout='5s'");
      await client.query(lockSql, [claim.chainId, claim.day]);
      const row = await client.query<{ state: string; tx_hash: Hex | null }>(`select state,tx_hash from faucet_claims where id=$1 and chain_id=$2 and utc_day=$3::date
        and owner=$4 and account=$5 and amount_wei=$6::numeric for update`,
        [claim.id, claim.chainId, claim.day, claim.owner.toLowerCase(), claim.account.toLowerCase(), claim.amountWei.toString()]);
      if (row.rows[0]?.state !== from) throw unavailable();
      if (consumption) {
        if (!hash || row.rows[0].tx_hash !== hash || !['submitted','unknown'].includes(from) || state !== 'failed') throw unavailable();
        await validateRelayerTransaction({ ...claim, kind: 'faucet' }, hash, consumption.raw, consumption.operator);
        const original = await outboxIdentity(hash, consumption.raw, consumption.operator);
        await saveOutboxIdentity(client, original, { fundingTxHash: hash });
        await saveOutboxConsumption(client, original, consumption.proof);
      }
      if (state === 'submitted') {
        if (!hash || !signed || from !== 'reserved') throw unavailable();
        await saveRelayerTransaction(client, { ...claim, kind: 'faucet' }, hash, signed);
      }
      const updated = await client.query(`update faucet_claims set state=$2,tx_hash=coalesce(tx_hash,$3),updated_at=clock_timestamp()
        where id=$1 and state=$4 and (tx_hash is null or tx_hash=$3) returning id`, [claim.id, state, hash, from]);
      if (updated.rows.length !== 1) throw unavailable();
    });
  } catch { throw unavailable(); }
}

export type PreparedClaim = { hash: Hex; raw: Hex; broadcast: () => Promise<void>; receipt: () => Promise<'confirmed' | 'failed' | 'unknown'> };

/** Signing has no network side effect. Persist its hash before eth_sendRawTransaction; never send a fresh nonce on retry. */
async function prepareClaim(claim: FaucetClaim, c: FaucetConfig): Promise<PreparedClaim> {
  const config = getConfig();
  if (!config.rpcUrl || !config.operatorPrivateKey) throw new Error('faucet operator unavailable');
  const key = config.operatorPrivateKey;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('faucet operator unavailable');
  const operator = privateKeyToAccount(key as Hex);
  if (operator.address.toLowerCase() !== TESTNET_97.roles.operator) throw new Error('faucet operator mismatch');
  const transport = http(config.rpcUrl, { retryCount: 0, timeout: c.timeoutMs });
  const client = createPublicClient({ chain: bscTestnet, transport });
  const wallet = createWalletClient({ account: operator, chain: bscTestnet, transport });
  await checkFaucetRecipient(client, operator.address, claim);
  const token = TESTNET_97.contracts.usdt;
  const data = encodeFunctionData({ abi: FAUCET_ABI, functionName: 'claimFor', args: [claim.account, claim.amountWei] });
  const request = await wallet.prepareTransactionRequest({ to: token, data, ...(await relayerNonce(client, operator.address)) });
  const signed = await wallet.signTransaction(request);
  const hash = keccak256(signed);
  return { hash, raw: signed,
    broadcast: async () => { if (await client.sendRawTransaction({ serializedTransaction: signed }) !== hash) throw new Error('unexpected transaction hash'); },
    receipt: async () => {
      await client.waitForTransactionReceipt({ hash, timeout: c.timeoutMs, confirmations: 1 });
      return readFaucetSettlementState(client, claim, hash, operator.address);
    },
  };
}

/** Separate readonly validation so RPC failures and rolling-window boundaries can be tested. */
export async function checkFaucetRecipient(client: PublicClient, operator: Address, claim: Pick<FaucetClaim, 'account' | 'amountWei'>): Promise<void> {
  if (await client.getChainId() !== 97) throw new AppError(503, 'FAUCET_CHAIN_MISMATCH', 'faucet RPC must report chain 97');
  const token = TESTNET_97.contracts.usdt;
  const [faucet, [remaining]] = await Promise.all([
    client.readContract({ address: token, abi: FAUCET_ABI, functionName: 'isFaucet', args: [operator] }),
    client.readContract({ address: token, abi: FAUCET_ABI, functionName: 'claimable', args: [claim.account] }),
  ]);
  if (!faucet) throw new AppError(503, 'FAUCET_OPERATOR_UNAVAILABLE', 'faucet operator is not authorized');
  if (remaining < claim.amountWei) throw new AppError(429, 'FAUCET_RECIPIENT_LIMIT', 'recipient rolling 24-hour limit reached');
}

export function faucetReceiptState(receipt: Pick<TransactionReceipt, 'status' | 'logs'>, claim: Pick<FaucetClaim, 'account' | 'amountWei'>, operator: Address): 'confirmed' | 'failed' | 'unknown' {
  if (receipt.status === 'reverted') return 'failed';
  const issued = receipt.logs.some((log) => {
    if (log.address.toLowerCase() !== TESTNET_97.contracts.usdt) return false;
    try {
      const event = decodeEventLog({ abi: FAUCET_ABI, eventName: 'Claimed', data: log.data, topics: log.topics });
      return event.args.to.toLowerCase() === claim.account.toLowerCase() && event.args.amount === claim.amountWei && event.args.by.toLowerCase() === operator.toLowerCase();
    } catch { return false; }
  });
  return issued ? 'confirmed' : 'unknown';
}

/** First broadcast follows the same canonical-result rule as recovery. Missing proof is never a refund. */
export async function readFaucetSettlementState(client: PublicClient, claim: Pick<FaucetClaim, 'account' | 'amountWei'>, hash: Hex, operator: Address): Promise<'confirmed' | 'failed' | 'unknown'> {
  try {
    if (await client.getChainId() !== 97) return 'unknown';
    const receipt = await client.getTransactionReceipt({ hash });
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (receipt.transactionHash.toLowerCase() !== hash || receipt.blockNumber < 0n || !/^0x[0-9a-f]{64}$/.test(receipt.blockHash) ||
        block.hash !== receipt.blockHash || block.number !== receipt.blockNumber) return 'unknown';
    if (receipt.status === 'reverted') return 'failed';
    const matches = receipt.logs.filter(log => !log.removed && log.blockHash === receipt.blockHash && log.blockNumber === receipt.blockNumber &&
      log.transactionHash?.toLowerCase() === hash && log.logIndex !== null && Number.isSafeInteger(log.logIndex) && log.logIndex >= 0 &&
      faucetReceiptState({ status: receipt.status, logs: [log] }, claim, operator) === 'confirmed');
    return receipt.status === 'success' && matches.length === 1 ? 'confirmed' : 'unknown';
  } catch { return 'unknown'; }
}

export type FaucetFundingEvidence = { txHash: Hex; logIndex: number; blockNumber: bigint; blockHash: Hex; amountRaw: string; confirmedAt: Date };

/** Funding evidence is stricter than a quota settlement: check canonical block and exact log identity. */
export async function readFaucetFundingEvidence(claim: Pick<FaucetClaim, 'chainId' | 'account' | 'amountWei'> & { txHash: Hex },
  suppliedClient?: PublicClient, operator: Address = TESTNET_97.roles.operator): Promise<FaucetFundingEvidence> {
  try {
    if (claim.chainId !== 97) throw new AppError(400, 'FUNDING_SOURCE_DISABLED', 'faucet funding is only available on chain 97');
    const config = getConfig();
    if (!suppliedClient && !config.rpcUrl) throw new Error('missing RPC');
    const client = suppliedClient ?? createPublicClient({ transport: http(config.rpcUrl ?? undefined, { timeout: 5_000, retryCount: 0 }) });
    if (await client.getChainId() !== 97) throw new Error('wrong RPC chain');
    const receipt = await client.getTransactionReceipt({ hash: claim.txHash });
    if (receipt.status !== 'success' || receipt.transactionHash.toLowerCase() !== claim.txHash || receipt.blockNumber < 0n || !/^0x[0-9a-f]{64}$/.test(receipt.blockHash)) {
      throw new AppError(409, 'FUNDING_NOT_CONFIRMED', 'successful funding receipt is required');
    }
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (block.hash !== receipt.blockHash || block.number !== receipt.blockNumber) {
      throw new AppError(409, 'FUNDING_REORGED', 'funding receipt is not on the canonical chain; reconciliation required');
    }
    const matches = receipt.logs.filter((log) => !log.removed && log.blockHash === receipt.blockHash && log.blockNumber === receipt.blockNumber &&
      log.transactionHash?.toLowerCase() === claim.txHash && Number.isSafeInteger(log.logIndex) && log.logIndex !== null && log.logIndex >= 0 &&
      faucetReceiptState({ status: 'success', logs: [log] }, claim, operator) === 'confirmed');
    const log = matches[0];
    if (matches.length !== 1 || log === undefined || log.logIndex === null) throw new AppError(409, 'FUNDING_NOT_CONFIRMED', 'one exact canonical Claimed event is required');
    const confirmedAt = new Date(Number(block.timestamp) * 1000);
    if (!Number.isSafeInteger(Number(block.timestamp)) || block.timestamp < 0n || !Number.isFinite(confirmedAt.getTime())) throw new Error('invalid confirmation time');
    return { txHash: claim.txHash, logIndex: log.logIndex, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, amountRaw: claim.amountWei.toString(), confirmedAt };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'FUNDING_RPC_UNAVAILABLE', 'funding confirmation unavailable; no new lot credited');
  }
}

async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('faucet timeout')), ms); })]); }
  finally { clearTimeout(timer); }
}

export type FaucetDeps = {
  config?: FaucetConfig | null; query?: QueryFn; reserve?: typeof reserveFaucetClaim;
  settle?: typeof settleFaucetClaim; prepare?: typeof prepareClaim; lock?: typeof withRelayerLock;
  find?: typeof findDailyFaucetClaim;
};
export function createFaucetService(deps: FaucetDeps = {}) {
  return { async claim(input: unknown, wallet: string): Promise<FaucetResult> {
    const c = deps.config === undefined ? loadFaucetConfig() : deps.config;
    if (c === null) throw new AppError(503, 'FAUCET_DISABLED', 'USDT faucet requires chain 97');
    if (typeof input !== 'object' || input === null || Array.isArray(input) || Object.keys(input).some((name) => name !== 'account')) {
      throw new AppError(400, 'FAUCET_INVALID_REQUEST', 'expected { account: owned smart account address }');
    }
    const account: unknown = Reflect.get(input, 'account');
    if (typeof account !== 'string' || !isAddress(account, { strict: false }) || /^0x0{40}$/i.test(account) || !isAddress(wallet, { strict: false })) {
      throw new AppError(400, 'FAUCET_INVALID_REQUEST', 'invalid account address');
    }
    try {
      const known = await bounded((deps.query ?? query)(`select s.owner,p.user_id from smart_accounts s join portfolios p on p.id=s.portfolio_id
        where s.chain_id=$1 and s.address=$2 and s.account_type='KERNEL' and s.retired_at is null`, [c.chainId, account.toLowerCase()]), c.timeoutMs);
      if (known.rows.length !== 1) throw new AppError(403, 'FAUCET_ACCOUNT_FORBIDDEN', 'account does not belong to this owner');
      const row = known.rows[0];
      if (typeof row !== 'object' || row === null || Reflect.get(row, 'owner') !== wallet.toLowerCase() || Reflect.get(row, 'user_id') !== wallet.toLowerCase()) {
        throw new AppError(403, 'FAUCET_ACCOUNT_FORBIDDEN', 'account does not belong to this owner');
      }
    } catch (error) { throw error instanceof AppError ? error : unavailable(); }
    const find = async () => {
      try { return await bounded((deps.find ?? findDailyFaucetClaim)(c.chainId, wallet, account), c.timeoutMs); }
      catch (error) { throw error instanceof AppError ? error : unavailable(); }
    };
    const previous = await find();
    if (previous) return previous;
    try {
      return await (deps.lock ?? withRelayerLock)(c.chainId, async (assertHeld) => {
        assertHeld();
        const previous = await find();
        if (previous) return previous;
        const claim = await (deps.reserve ?? reserveFaucetClaim)({ config: c, account: account.toLowerCase() as Address, owner: wallet.toLowerCase() as Address });
        const settle = deps.settle ?? settleFaucetClaim;
        assertHeld();
        let prepared: PreparedClaim;
        try { prepared = await bounded((deps.prepare ?? prepareClaim)(claim, c), c.timeoutMs); }
        catch (error) {
          // Preparation cannot broadcast, even if its RPC completes after the timeout.
          await settle(claim, 'reserved', 'failed', null);
          throw error instanceof AppError ? error : new AppError(503, 'FAUCET_PREPARE_UNAVAILABLE', 'claim preparation unavailable; no transaction sent');
        }
        await settle(claim, 'reserved', 'submitted', prepared.hash, withTransaction, { raw: prepared.raw }); // unknown commit => stop, never broadcast
        let state: 'confirmed' | 'failed' | 'unknown' = 'unknown';
        try { assertHeld(); await bounded(prepared.broadcast(), c.timeoutMs); state = await bounded(prepared.receipt(), c.timeoutMs); }
        catch { /* unknown broadcast/receipt; retain BOTH owner and site quota */ }
        await settle(claim, 'submitted', state, prepared.hash);
        return { claimId: claim.id, state, amountWei: claim.amountWei.toString(), txHash: prepared.hash };
      });
    } catch (error) {
      if (error instanceof AppError && ['RELAYER_BUSY', 'FAUCET_QUOTA_EXCEEDED'].includes(error.code)) {
        const previous = await find();
        if (previous) return previous;
      }
      throw error;
    }
  } };
}
export async function claimFaucetUsdt(input: unknown, wallet: string) { return createFaucetService().claim(input, wallet); }
