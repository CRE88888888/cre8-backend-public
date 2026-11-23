import { decodeEventLog, encodeFunctionData, keccak256, parseAbiItem, parseTransaction, recoverTransactionAddress, serializeTransaction, TransactionReceiptNotFoundError } from 'viem';
import type { Address, Hex, PublicClient, TransactionReceipt } from 'viem';
import { bscTestnet } from 'viem/chains';
import type { ChainConfig } from './chain.js';
import { query, withTransaction } from './db.js';
import { withMixCreationLock, mixRequestHash } from './mix-creation.js';
import { mixUnavailable, untilNodesCatchUp } from './mix-store.js';
import { withRelayerLock, relayerNonce } from './relayer-lock.js';
import { REGISTRY_ABI, REGISTRY_VERSION_ABI } from './registry-abi.js';
import { registryConfigHash, typedVersionSettings } from './registry-versioning.js';
import type { VersionSettings } from './registry-versioning.js';
import { validateAssetConfig } from './strategy-execution.js';
import type { AssetExecution } from './strategy-execution.js';
import type { Allocation } from './strategies.js';
import { TESTNET_97 as T } from './testnet-profile.js';
import { AppError, errorChain } from './errors.js';
import { recordAlerts } from './alerts.js';
import { findPublicationNonceConsumption, verifyPublicationNonceConsumption } from './mix-publication-nonce.js';
import type { NonceConsumption } from './mix-publication-nonce.js';

export type MixPublication = {
  strategy_id: string; chain_id: string; registry: Address; onchain_strategy_id: string; creation_request_id: string | null;
  allocation: Allocation & { p11: VersionSettings }; schedule: { kind: 'funding' }; execution: AssetExecution; config_hash: Hex; calldata: Hex;
  state: 'prepared' | 'submitted' | 'confirmed' | 'quarantined'; created_at: Date; alerted_at: Date | null;
  published_tx_hash: Hex | null; published_block_number: string | null; published_block_hash: Hex | null; last_error_code?: string | null;
};
type Attempt = { strategy_id: string; attempt: number; signer: Address; nonce: string; tx_hash: Hex; signed_raw_tx: Hex;
  checked_block_number: string; checked_block_hash: Hex; checked_block_time: Date; status: 'success' | 'reverted' | null;
  block_number: string | null; block_hash: Hex | null; foreign_tx_hash: Hex | null;
  consumed_block_number: string | null; consumed_block_hash: Hex | null; consumed_block_time: Date | null };
type Anchor = { number: bigint; hash: Hex; at: Date };
export type PublicationDeps = { client: PublicClient; chain?: ChainConfig; operator?: Address; query: typeof query; transaction: typeof withTransaction;
  lock?: typeof withRelayerLock; jobLock?: typeof withMixCreationLock; timeoutMs?: number; nonceLockMs?: number; deadlineAt?: number; now?: () => Date };
export const PUBLICATION_ALERT_MS = 60_000;
const jobColumns = `strategy_id,chain_id,registry,onchain_strategy_id,creation_request_id,allocation,schedule,execution,config_hash,calldata,state,
  created_at,alerted_at,published_tx_hash,published_block_number,published_block_hash,last_error_code`;
/**
 * Quarantines that can come from reading the chain through a lagging or briefly forked node (load-balanced RPC):
 * a block/receipt hash that did not match at that moment, or the old combined config/anchor check. They are lifted
 * only by `healQuarantine`, which re-proves the whole publication against the chain now. Version-count, nonce
 * consumption and other identity conflicts never self-heal.
 */
export const PUBLICATION_HEALABLE_CODES: ReadonlySet<string> = new Set(['PUBLICATION_RECEIPT_REORG', 'PUBLICATION_HISTORY_REORG', 'PUBLICATION_CONFIG_CONFLICT']);
const event = parseAbiItem('event VersionPublished(uint256 indexed id,uint16 version,bytes32 scheduleHash)');
async function bounded<R>(work: Promise<R>, deps: PublicationDeps): Promise<R> {
  const requested = deps.timeoutMs ?? 5000;
  const ms = deps.deadlineAt === undefined ? requested : Math.min(requested, deps.deadlineAt - Date.now());
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > 30000) throw mixUnavailable();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(mixUnavailable()), ms); })]); }
  finally { clearTimeout(timer); }
}
async function load(id: string, deps: PublicationDeps): Promise<MixPublication> {
  const row = (await deps.query<MixPublication>(`select ${jobColumns} from mix_publication_jobs where strategy_id=$1`, [id])).rows[0];
  if (!row) throw mixUnavailable();
  validatePublication(row); return row;
}
/** Recompute the complete immutable public payload, never trusting a stored hash alone. */
export function validatePublication(job: MixPublication): void {
  try {
    if (job.chain_id !== '97' || job.registry !== T.contracts.registry || !/^[1-9][0-9]*$/.test(job.onchain_strategy_id) ||
        BigInt(job.onchain_strategy_id) > BigInt(Number.MAX_SAFE_INTEGER) || mixRequestHash(job.schedule) !== mixRequestHash({ kind: 'funding' })) throw mixUnavailable();
    const allocation = { assets: job.allocation.assets }, execution = validateAssetConfig(job.execution, allocation, 97);
    if (execution.rebalance !== 'none' || execution.assets.some(a => a.yield !== null || a.asset !== T.contracts.usdt && a.execution?.kind !== 'hold')) throw mixUnavailable();
    const settings = typedVersionSettings({ chainId: 97, allocation, execution, schedule: job.schedule, activeAt: new Date(0) });
    const expected = { ...allocation, p11: settings };
    if (mixRequestHash(job.allocation) !== mixRequestHash(expected) || mixRequestHash(job.execution) !== mixRequestHash(execution) ||
        job.config_hash !== registryConfigHash(allocation.assets.map(a => a.address as Address), allocation.assets.map(a => a.weightBps), settings) ||
        job.calldata !== encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'publishSettingsVersion', args: [BigInt(job.onchain_strategy_id),
          allocation.assets.map(a => a.address as Address), allocation.assets.map(a => a.weightBps), settings.scheduleHash, settings.settingsHash, settings.performanceFeeBps, 0n] })) throw mixUnavailable();
  } catch (error) { throw mixUnavailable(undefined, error); }
}
export async function validatePublicationTransaction(job: MixPublication, attempt: Pick<Attempt, 'tx_hash' | 'signed_raw_tx' | 'signer' | 'nonce'>): Promise<void> {
  try {
    validatePublication(job);
    if (!/^0x[0-9a-f]{64}$/.test(attempt.tx_hash) || !/^0x([0-9a-f]{2})+$/.test(attempt.signed_raw_tx) || keccak256(attempt.signed_raw_tx) !== attempt.tx_hash) throw mixUnavailable();
    const tx = parseTransaction(attempt.signed_raw_tx);
    if ((tx.type !== 'legacy' && tx.type !== 'eip1559') || tx.chainId !== 97 || !Number.isSafeInteger(tx.nonce) || tx.nonce === undefined || tx.nonce < 0 ||
        tx.nonce.toString() !== attempt.nonce || !tx.gas || tx.gas <= 0n || (tx.value ?? 0n) !== 0n || tx.to?.toLowerCase() !== job.registry ||
        tx.data !== job.calldata || !tx.r || !tx.s) throw mixUnavailable();
    const raw = serializeTransaction(tx, { r: tx.r, s: tx.s, v: tx.v ?? BigInt(27 + (tx.yParity ?? 0)) });
    if (keccak256(raw) !== attempt.tx_hash || (await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase() !== attempt.signer.toLowerCase()) throw mixUnavailable();
  } catch (error) { throw mixUnavailable(undefined, error); }
}
async function anchor(deps: PublicationDeps, number?: bigint): Promise<Anchor> {
  const block = await bounded(deps.client.getBlock(number === undefined ? { blockTag: 'latest' } : { blockNumber: number }), deps);
  if (block.number === null || number !== undefined && block.number !== number || block.number < 0n || block.hash === null || block.timestamp < 0n || block.timestamp > 8_640_000_000_000n) throw mixUnavailable();
  return { number: block.number, hash: block.hash, at: new Date(Number(block.timestamp) * 1000) };
}
async function state(job: MixPublication, deps: PublicationDeps) {
  if (await bounded(deps.client.getChainId(), deps) !== 97) throw mixUnavailable();
  const block = await anchor(deps);
  const count = await bounded(deps.client.readContract({ address: job.registry, abi: REGISTRY_VERSION_ABI,
    functionName: 'versionCount', args: [BigInt(job.onchain_strategy_id)], blockNumber: block.number }), deps);
  if ((await anchor(deps, block.number)).hash !== block.hash) throw mixUnavailable();
  return { block, count };
}
async function mark(job: MixPublication, deps: PublicationDeps, code: string, quarantine = false) {
  const alert = quarantine || (deps.now?.() ?? new Date()).getTime() - job.created_at.getTime() >= PUBLICATION_ALERT_MS;
  await deps.transaction(async db => {
    await db.query("set local statement_timeout='5s'");
    await db.query("set local lock_timeout='3s'");
    await db.query(`update mix_publication_jobs set last_error_code=$2,updated_at=clock_timestamp(),
      state=case when $3 then 'quarantined' else state end,alerted_at=case when $4 then coalesce(alerted_at,clock_timestamp()) else alerted_at end
      where strategy_id=$1`, [job.strategy_id, code, quarantine, alert]);
    if (alert) await recordAlerts((sql, params) => db.query(sql, params ? [...params] : []), [{ kind: 'portfolio_stuck', severity: 'critical', portfolioId: null,
      detail: `私人組合首版發布待營運確認，strategy ${job.strategy_id}，代碼 ${code}；其他組合與已占用 nonce 的證據保持獨立。` }], deps.now?.() ?? new Date());
  });
}
async function attempt(job: MixPublication, deps: PublicationDeps): Promise<Attempt | null> {
  return (await deps.query<Attempt>(`select o.strategy_id,o.attempt,o.signer,o.nonce::text,o.tx_hash,o.signed_raw_tx,
    o.checked_block_number::text,o.checked_block_hash,o.checked_block_time,r.status,r.block_number::text,r.block_hash,
    c.foreign_tx_hash,c.block_number::text as consumed_block_number,c.block_hash as consumed_block_hash,c.block_time as consumed_block_time
    from mix_publication_outbox o left join mix_publication_receipts r using(strategy_id,attempt)
    left join mix_publication_nonce_consumptions c using(strategy_id,attempt)
    where o.strategy_id=$1 order by o.attempt desc limit 1`, [job.strategy_id])).rows[0] ?? null;
}
function consumption(current: Attempt): NonceConsumption | null {
  if (current.foreign_tx_hash === null) return null;
  if (current.consumed_block_number === null || current.consumed_block_hash === null || !(current.consumed_block_time instanceof Date)) throw mixUnavailable();
  return { foreign_tx_hash: current.foreign_tx_hash, block_number: current.consumed_block_number, block_hash: current.consumed_block_hash, block_time: current.consumed_block_time };
}
async function saveConsumption(job: MixPublication, current: Attempt, proof: NonceConsumption, deps: PublicationDeps): Promise<void> {
  await (deps.lock ?? withRelayerLock)(97, async held => deps.transaction(async db => {
    held();
    await db.query("set local statement_timeout='5s'");
    await db.query("set local lock_timeout='3s'");
    const locked = (await db.query<{ state: string }>('select state from mix_publication_jobs where strategy_id=$1 for update', [job.strategy_id])).rows[0];
    if (!locked || !['submitted','quarantined'].includes(locked.state)) throw mixUnavailable();
    await db.query(`insert into mix_publication_nonce_consumptions(strategy_id,attempt,chain_id,signer,nonce,foreign_tx_hash,block_number,block_hash,block_time)
      values($1,$2,97,$3,$4,$5,$6,$7,$8)`, [job.strategy_id, current.attempt, current.signer.toLowerCase(), current.nonce,
        proof.foreign_tx_hash, proof.block_number, proof.block_hash, proof.block_time]);
    await db.query(`update mix_publication_jobs set state=case when state='submitted' then 'prepared' else state end,
      last_error_code='PUBLICATION_NONCE_CONSUMED',updated_at=clock_timestamp() where strategy_id=$1`, [job.strategy_id]);
    held();
  }), { reconcile: true });
}
async function findConsumption(current: Attempt, observed: Anchor, deps: PublicationDeps) {
  const lookup = { ...deps, deadlineAt: Math.min(deps.deadlineAt ?? Infinity, Date.now() + 5000) };
  return findPublicationNonceConsumption(deps.client, current, observed, work => bounded(work, lookup), number => anchor(lookup, number));
}
async function historyCanonical(job: MixPublication, deps: PublicationDeps): Promise<boolean> {
  const rows = (await deps.query<{ block_number: string; block_hash: Hex }>(`select coalesce(r.block_number,c.block_number)::text as block_number,
    coalesce(r.block_hash,c.block_hash) as block_hash from mix_publication_outbox o
    left join mix_publication_receipts r using(strategy_id,attempt) left join mix_publication_nonce_consumptions c using(strategy_id,attempt)
    where o.strategy_id=$1 and (r.strategy_id is not null or c.strategy_id is not null)`, [job.strategy_id])).rows;
  for (const row of rows) if ((await anchor(deps, BigInt(row.block_number))).hash !== row.block_hash) return false;
  return true;
}
async function receipt(job: MixPublication, current: Attempt, deps: PublicationDeps) {
  await validatePublicationTransaction(job, current);
  if (current.signer.toLowerCase() !== (deps.operator ?? deps.chain?.account.address ?? T.roles.operator).toLowerCase()) throw mixUnavailable();
  let result: TransactionReceipt;
  try { result = await bounded(deps.client.getTransactionReceipt({ hash: current.tx_hash }), deps); }
  catch (error) { if (error instanceof TransactionReceiptNotFoundError) return null; throw error; }
  const [block, tx] = await Promise.all([anchor(deps, result.blockNumber), bounded(deps.client.getTransaction({ hash: current.tx_hash }), deps)]);
  if (result.from.toLowerCase() !== current.signer.toLowerCase() || result.to?.toLowerCase() !== job.registry ||
      result.transactionHash !== current.tx_hash || block.hash !== result.blockHash || tx.hash !== current.tx_hash || tx.blockNumber !== block.number ||
      tx.blockHash !== block.hash || tx.from.toLowerCase() !== current.signer.toLowerCase() || tx.nonce.toString() !== current.nonce ||
      tx.to?.toLowerCase() !== job.registry || tx.input !== job.calldata || tx.value !== 0n ||
      !['success','reverted'].includes(result.status) || (await anchor(deps, block.number)).hash !== block.hash) throw mixUnavailable();
  return { receipt: result, block };
}
async function resolution(job: MixPublication, current: Attempt, observed: Anchor, deps: PublicationDeps) {
  let proof: Awaited<ReturnType<typeof receipt>> = null, unavailable = false;
  try { proof = await receipt(job, current, deps); }
  catch { unavailable = true; }
  if (proof) return { proof, foreign: null };
  // Some RPCs error on an unknown original hash rather than returning null.
  // Independent canonical same-nonce evidence remains authoritative; an RPC
  // error alone still cannot release the original or permit a fresh signature.
  const foreign = await findConsumption(current, observed, deps);
  if (unavailable && !foreign) throw mixUnavailable();
  return { proof: null, foreign };
}
function publicationLog(job: MixPublication, result: TransactionReceipt) {
  const matches = result.logs.filter(log => {
    if (log.address.toLowerCase() !== job.registry || log.removed || log.transactionHash !== result.transactionHash || log.blockNumber !== result.blockNumber ||
        log.blockHash !== result.blockHash || log.logIndex === null || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0) return false;
    try { const e = decodeEventLog({ abi: REGISTRY_ABI, data: log.data, topics: log.topics });
      return e.eventName === 'VersionPublished' && e.args.id.toString() === job.onchain_strategy_id && e.args.version === 1 && e.args.scheduleHash === job.allocation.p11.scheduleHash;
    } catch { return false; }
  });
  const log = matches[0]; if (matches.length !== 1 || !log || log.logIndex === null) throw mixUnavailable();
  return log;
}
/** The RPC half of `complete`: every check unchanged. `onConflict` runs right before a quarantining mismatch. */
async function verifyComplete(job: MixPublication, proof: { receipt: TransactionReceipt; block: Anchor }, observed: Anchor, deps: PublicationDeps, onConflict = () => {}) {
  if (proof.receipt.status !== 'success') throw mixUnavailable('receipt-not-success');
  if (observed.number < proof.block.number) throw mixUnavailable(`latest-behind-receipt:${observed.number}<${proof.block.number}`);
  const log = publicationLog(job, proof.receipt);
  const params = { address: job.registry, abi: REGISTRY_VERSION_ABI, blockNumber: observed.number };
  const version = await bounded(deps.client.readContract({ ...params, functionName: 'version', args: [BigInt(job.onchain_strategy_id), 1] }), deps);
  if (version.configHash !== job.config_hash || version.activeAt > BigInt(Math.floor(observed.at.getTime() / 1000)) ||
      registryConfigHash(version.assets, version.weightsBps, version) !== job.config_hash ||
      await bounded(deps.client.readContract({ ...params, functionName: 'activeVersion', args: [BigInt(job.onchain_strategy_id)] }), deps) !== 1 ||
      (await anchor(deps, observed.number)).hash !== observed.hash || (await anchor(deps, proof.block.number)).hash !== proof.block.hash) {
    onConflict(); await mark(job, deps, 'PUBLICATION_CONFIG_CONFLICT', true); throw mixUnavailable('publication-config-conflict');
  }
  return { log, version };
}
async function complete(job: MixPublication, current: Attempt | null, proof: { receipt: TransactionReceipt; block: Anchor }, observed: Anchor, deps: PublicationDeps,
  checked?: Awaited<ReturnType<typeof verifyComplete>>, heal = false) {
  // Same checks as before (verifyComplete); `checked` = they already passed for exactly this proof and observation.
  const { log, version } = checked ?? await verifyComplete(job, proof, observed, deps);
  await deps.transaction(async db => {
    await db.query("set local statement_timeout='5s'");
    await db.query("set local lock_timeout='3s'");
    const locked = (await db.query<{ state: string }>('select state from mix_publication_jobs where strategy_id=$1 for update', [job.strategy_id])).rows[0];
    if (locked?.state === 'confirmed') return;
    if (!locked || locked.state === 'quarantined' && !heal) throw mixUnavailable();
    // A healed job may already hold this exact receipt row (verified canonical above); never rewrite audit rows.
    if (current && !(await db.query('select 1 from mix_publication_receipts where strategy_id=$1 and attempt=$2', [job.strategy_id, current.attempt])).rows.length) {
      await db.query(`insert into mix_publication_receipts(strategy_id,attempt,status,block_number,block_hash,block_time)
        values($1,$2,'success',$3,$4,$5)`, [job.strategy_id, current.attempt, proof.block.number.toString(), proof.block.hash, proof.block.at]);
    }
    await db.query(`insert into strategy_versions(strategy_id,version,allocation,schedule,execution_schema_version,execution,execution_chain_id,config_hash,active_at)
      values($1,1,$2,$3,2,$4,97,$5,$6)`, [job.strategy_id, JSON.stringify(job.allocation), JSON.stringify(job.schedule), JSON.stringify(job.execution), job.config_hash, new Date(Number(version.activeAt) * 1000)]);
    await db.query(`update mix_publication_jobs set state='confirmed',last_error_code=null,published_tx_hash=$2,published_log_index=$3,
      published_block_number=$4,published_block_hash=$5,published_block_time=$6,verified_block_number=$7,verified_block_hash=$8,verified_block_time=$9,
      published_active_at=$10,resolved_at=clock_timestamp(),updated_at=clock_timestamp() where strategy_id=$1`,
      [job.strategy_id, proof.receipt.transactionHash, log.logIndex, proof.block.number.toString(), proof.block.hash, proof.block.at,
        observed.number.toString(), observed.hash, observed.at, new Date(Number(version.activeAt) * 1000)]);
    if (job.creation_request_id) await db.query('update mix_creation_requests set last_error_code=null,updated_at=clock_timestamp() where id=$1', [job.creation_request_id]);
  });
}

/**
 * Re-prove a read-flagged quarantine against the chain now (all evidence was just checked canonical by the caller):
 * our original transaction's receipt and block, success, exactly one VersionPublished(version 1) with this schedule,
 * versionCount = 1, activeVersion = 1, version 1's config hash recomputed from its assets/weights equal to the job's,
 * and every block hash stable. All of it must match exactly (read through lagging nodes with the same bounded
 * retry as a fresh send); then the job is confirmed and its alert stops. Any genuine mismatch keeps the quarantine.
 */
async function healQuarantine(job: MixPublication, current: Attempt, deps: PublicationDeps): Promise<boolean> {
  if (current.status === 'reverted') return false;
  let conflict = false;
  let proved: { proof: NonNullable<Awaited<ReturnType<typeof receipt>>>; observed: Anchor; checked: Awaited<ReturnType<typeof verifyComplete>> };
  try {
    proved = await untilNodesCatchUp(async () => {
      try {
        const proof = await receipt(job, current, deps);
        if (!proof) throw mixUnavailable('heal-receipt-not-visible');
        if (proof.receipt.status !== 'success') { conflict = true; throw mixUnavailable('heal-receipt-not-success'); }
        if (current.block_number !== null && (BigInt(current.block_number) !== proof.block.number || current.block_hash !== proof.block.hash)) {
          conflict = true; throw mixUnavailable('heal-stored-receipt-differs');
        }
        const after = await state(job, deps);
        if (after.count !== 1n) throw mixUnavailable(`heal-version-count:${after.count}`);
        return { proof, observed: after.block, checked: await verifyComplete(job, proof, after.block, deps, () => { conflict = true; }) };
      } catch (error) {
        if (conflict) throw new AppError(409, 'PUBLICATION_CONFIG_CONFLICT', 'publication does not match the chain', { cause: error });
        throw error instanceof AppError ? error : mixUnavailable('heal-read', error);
      }
    }, () => true);
  } catch (error) {
    console.warn(JSON.stringify({ level: 'warn', msg: 'mix_publication_heal_failed', strategyId: job.strategy_id, code: job.last_error_code, cause: errorChain(error) }));
    return false;
  }
  try { await complete(job, current, proved.proof, proved.observed, deps, proved.checked, true); }
  catch (error) {
    console.warn(JSON.stringify({ level: 'warn', msg: 'mix_publication_heal_failed', strategyId: job.strategy_id, code: job.last_error_code, cause: errorChain(error) }));
    return false;
  }
  console.info(JSON.stringify({ level: 'info', msg: 'mix_publication_healed', strategyId: job.strategy_id, previousCode: job.last_error_code,
    txHash: current.tx_hash, blockNumber: proved.proof.block.number.toString() }));
  return true;
}

/** One job lock; shared nonce exclusion covers preparation+commit+broadcast only.
 * An ambiguous COMMIT returns before broadcast. A restart reads this same attempt. */
export async function reconcileMixPublication(id: string, deps: PublicationDeps, replay = false): Promise<'confirmed' | 'replayed' | 'reverted' | 'consumed' | 'unresolved'> {
  return (deps.jobLock ?? withMixCreationLock)('publication:' + id, async () => {
    let job = await load(id, deps);
    try {
      const observed = await state(job, deps);
      if (observed.count > 1n) { await mark(job, deps, 'PUBLICATION_VERSION_CONFLICT', true); job = await load(id, deps); }
      let current = await attempt(job, deps);
      if (current) {
        await validatePublicationTransaction(job, current);
        if (current.signer.toLowerCase() !== (deps.operator ?? deps.chain?.account.address ?? T.roles.operator).toLowerCase()) throw mixUnavailable();
      }
      if (current && consumption(current)) {
        const proof = consumption(current); if (!proof) throw mixUnavailable();
        if ((await anchor(deps, BigInt(proof.block_number))).hash !== proof.block_hash) {
          await mark(job, deps, 'PUBLICATION_NONCE_PROOF_REORG', true); return 'unresolved';
        }
        await verifyPublicationNonceConsumption(deps.client, current, proof, work => bounded(work, deps), number => anchor(deps, number));
      }
      if (current?.status && current.block_number !== null && (await anchor(deps, BigInt(current.block_number))).hash !== current.block_hash) {
        const orphan = current;
        await mark(job, deps, 'PUBLICATION_RECEIPT_REORG', true);
        if (replay && observed.count === 0n) await (deps.lock ?? withRelayerLock)(97, held =>
          replayPublicationNonceGap(deps.client, orphan.signer, BigInt(orphan.nonce), held).then(() => {}), { reconcile: true });
        return 'unresolved';
      }
      if (!await historyCanonical(job, deps)) { await mark(job, deps, 'PUBLICATION_HISTORY_REORG', true); return 'unresolved'; }
      if (job.state === 'quarantined') {
        if (current && !consumption(current) && job.last_error_code != null && PUBLICATION_HEALABLE_CODES.has(job.last_error_code) &&
            await healQuarantine(job, current, deps)) return 'confirmed';
        if (current && current.status === null && !consumption(current)) {
          const pending = current, { proof, foreign } = await resolution(job, pending, observed.block, deps);
          if (proof) await deps.transaction(async db => {
            await db.query("set local statement_timeout='5s'");
            await db.query("set local lock_timeout='3s'");
            await db.query('select strategy_id from mix_publication_jobs where strategy_id=$1 for update', [id]);
            if (!(await db.query('select 1 from mix_publication_receipts where strategy_id=$1 and attempt=$2', [id, pending.attempt])).rows.length) {
              await db.query(`insert into mix_publication_receipts(strategy_id,attempt,status,block_number,block_hash,block_time)
                values($1,$2,$3,$4,$5,$6)`, [id, pending.attempt, proof.receipt.status, proof.block.number.toString(), proof.block.hash, proof.block.at]);
            }
          });
          else {
            if (foreign) await saveConsumption(job, pending, foreign, deps);
            else if (replay && observed.count === 0n) await (deps.lock ?? withRelayerLock)(97, held =>
              replayPublicationNonceGap(deps.client, pending.signer, BigInt(pending.nonce), held).then(() => {}), { reconcile: true });
          }
        }
        return 'unresolved';
      }
      if (job.state === 'confirmed') {
        if (observed.count !== 1n || job.published_block_number === null ||
            (await anchor(deps, BigInt(job.published_block_number))).hash !== job.published_block_hash) {
          await mark(job, deps, 'PUBLICATION_RECEIPT_REORG', true); return 'unresolved';
        }
        const confirmed = await bounded(deps.client.readContract({ address: job.registry, abi: REGISTRY_VERSION_ABI, functionName: 'version',
          args: [BigInt(job.onchain_strategy_id), 1], blockNumber: observed.block.number }), deps);
        if (confirmed.configHash !== job.config_hash || registryConfigHash(confirmed.assets, confirmed.weightsBps, confirmed) !== job.config_hash ||
            await bounded(deps.client.readContract({ address: job.registry, abi: REGISTRY_VERSION_ABI, functionName: 'activeVersion',
              args: [BigInt(job.onchain_strategy_id)], blockNumber: observed.block.number }), deps) !== 1 ||
            (await anchor(deps, observed.block.number)).hash !== observed.block.hash) { await mark(job, deps, 'PUBLICATION_CONFIG_CONFLICT', true); return 'unresolved'; }
        return 'confirmed';
      }
      if (current && current.status === null && !consumption(current)) {
        const pending = current;
        const { proof, foreign } = await resolution(job, pending, observed.block, deps);
        if (proof) {
          if (proof.receipt.status === 'success') {
            const after = await state(job, deps);
            if (after.count !== 1n) throw mixUnavailable();
            await complete(job, pending, proof, after.block, deps); return 'confirmed';
          }
          await deps.transaction(async db => {
            await db.query("set local statement_timeout='5s'");
            await db.query("set local lock_timeout='3s'");
            await db.query('select strategy_id from mix_publication_jobs where strategy_id=$1 for update', [id]);
            await db.query(`insert into mix_publication_receipts(strategy_id,attempt,status,block_number,block_hash,block_time)
              values($1,$2,'reverted',$3,$4,$5)`, [id, pending.attempt, proof.block.number.toString(), proof.block.hash, proof.block.at]);
            await db.query("update mix_publication_jobs set state='prepared',last_error_code='PUBLICATION_REVERTED',updated_at=clock_timestamp() where strategy_id=$1", [id]);
          });
          return 'reverted';
        }
        if (foreign) { await saveConsumption(job, pending, foreign, deps); return 'consumed'; }
        if (!replay || observed.count !== 0n) { await mark(job, deps, 'PUBLICATION_RECEIPT_PENDING'); return 'unresolved'; }
        await (deps.lock ?? withRelayerLock)(97, async held => {
          await validatePublicationTransaction(job, pending);
          held();
          if (await bounded(deps.client.sendRawTransaction({ serializedTransaction: pending.signed_raw_tx }), deps) !== pending.tx_hash) throw mixUnavailable();
        }, { reconcile: true });
        await mark(job, deps, 'PUBLICATION_RECEIPT_PENDING'); return 'replayed';
      }
      if (observed.count === 1n) {
        // No unresolved local nonce: recover a matching independently published first version.
        const logs = await bounded(deps.client.getLogs({ address: job.registry, event, args: { id: BigInt(job.onchain_strategy_id) },
          fromBlock: current ? BigInt(current.checked_block_number) : 0n, toBlock: observed.block.number }), deps);
        const matching = logs.filter(log => log.args.version === 1 && !log.removed && log.transactionHash !== null);
        if (matching.length !== 1 || !matching[0]?.transactionHash) throw mixUnavailable();
        const txHash = matching[0].transactionHash;
        const result = await bounded(deps.client.getTransactionReceipt({ hash: txHash }), deps);
        const tx = await bounded(deps.client.getTransaction({ hash: txHash }), deps);
        if (tx.from.toLowerCase() !== (deps.operator ?? deps.chain?.account.address ?? T.roles.operator).toLowerCase() || tx.to?.toLowerCase() !== job.registry ||
            tx.input !== job.calldata || tx.value !== 0n || tx.blockHash !== result.blockHash || tx.blockNumber !== result.blockNumber || tx.hash !== result.transactionHash) throw mixUnavailable();
        await complete(job, null, { receipt: result, block: await anchor(deps, result.blockNumber) }, observed.block, deps); return 'confirmed';
      }
      if (!replay || !deps.chain) { await mark(job, deps, 'PUBLICATION_PENDING'); return 'unresolved'; }
      await (deps.lock ?? withRelayerLock)(97, async lockHeld => {
        const duration = deps.nonceLockMs ?? 15000;
        if (!Number.isSafeInteger(duration) || duration < 1 || duration > 30000) throw mixUnavailable();
        const critical = { ...deps, deadlineAt: Date.now() + duration };
        const held = () => { lockHeld(); if (Date.now() >= critical.deadlineAt) throw mixUnavailable(); };
        held();
        job = await load(id, deps);
        const checked = await state(job, critical);
        if (job.state !== 'prepared' || checked.count !== 0n) throw mixUnavailable();
        if (!await historyCanonical(job, critical)) throw mixUnavailable();
        current = await attempt(job, deps);
        if (current && current.status !== 'reverted' && !consumption(current)) throw mixUnavailable();
        if (current?.block_number !== null && current?.block_number !== undefined && (await anchor(critical, BigInt(current.block_number))).hash !== current.block_hash) throw mixUnavailable();
        if (current) {
          const proof = consumption(current);
          if (proof) await verifyPublicationNonceConsumption(deps.client, current, proof, work => bounded(work, critical), number => anchor(critical, number));
        }
        const chain = deps.chain; if (!chain) throw mixUnavailable();
        const request = await bounded(chain.wallet.prepareTransactionRequest({ account: chain.account, chain: bscTestnet, to: job.registry,
          data: job.calldata, value: 0n, ...(await relayerNonce(deps.client, chain.account.address)) }), critical);
        const raw = await bounded(chain.wallet.signTransaction(request), critical), hash = keccak256(raw);
        const fresh = { signer: chain.account.address.toLowerCase() as Address, nonce: request.nonce.toString(), tx_hash: hash, signed_raw_tx: raw };
        await validatePublicationTransaction(job, fresh);
        held();
        await deps.transaction(async db => {
          await db.query("set local statement_timeout='5s'");
          await db.query("set local lock_timeout='3s'");
          const locked = (await db.query<{ state: string }>('select state from mix_publication_jobs where strategy_id=$1 for update', [id])).rows[0];
          if (locked?.state !== 'prepared') throw mixUnavailable();
          held();
          const index = (current?.attempt ?? 0) + 1;
          await db.query(`insert into mix_publication_outbox(strategy_id,attempt,chain_id,signer,nonce,tx_hash,signed_raw_tx,checked_block_number,checked_block_hash,checked_block_time)
            values($1,$2,97,$3,$4,$5,$6,$7,$8,$9)`, [id, index, fresh.signer, fresh.nonce, hash, raw, checked.block.number.toString(), checked.block.hash, checked.block.at]);
          held();
          await db.query("update mix_publication_jobs set state='submitted',last_attempt_at=clock_timestamp(),updated_at=clock_timestamp() where strategy_id=$1", [id]);
          held();
        });
        held();
        if (await bounded(deps.client.sendRawTransaction({ serializedTransaction: raw }), critical) !== hash) throw mixUnavailable();
      });
      // Receipt work runs after releasing the shared EOA lock.
      const sent = await attempt(job, deps); if (!sent) throw mixUnavailable();
      let proof = await receipt(job, sent, deps);
      if (!proof) {
        try { await bounded(deps.client.waitForTransactionReceipt({ hash: sent.tx_hash, timeout: deps.timeoutMs ?? 5000, pollingInterval: 100 }), deps); }
        catch { await mark(job, deps, 'PUBLICATION_RECEIPT_PENDING'); return 'unresolved'; }
      }
      // Our own transaction is included (one node returned its receipt). A load-balanced RPC may route the next reads
      // to a node a few blocks behind: receipt/block not found yet, or `latest` still before the version. Re-read the
      // same evidence until it is visible everywhere it is checked, bounded; no check is relaxed and a conflict still
      // quarantines immediately (never retried).
      let conflict = false;
      const confirmed = await untilNodesCatchUp(async () => {
        try {
          const visible = proof ?? await receipt(job, sent, deps);
          if (!visible) throw mixUnavailable('receipt-not-visible-yet');
          proof = visible;
          if (visible.receipt.status === 'reverted') return 'reverted' as const;
          const after = await state(job, deps);
          if (after.count !== 1n) throw mixUnavailable('version-not-visible-yet');
          return { observed: after.block, checked: await verifyComplete(job, visible, after.block, deps, () => { conflict = true; }) };
        } catch (error) {
          if (conflict) throw new AppError(409, 'PUBLICATION_CONFIG_CONFLICT', 'publication config conflict', { cause: error });
          proof = null; // re-read the receipt too: the node that had it may not be the one answering next
          throw error instanceof AppError ? error : mixUnavailable('confirm-read', error); // other AppErrors are not retried
        }
      }, () => true);
      if (!proof) { await mark(job, deps, 'PUBLICATION_RECEIPT_PENDING'); return 'unresolved'; }
      if (confirmed === 'reverted') return 'unresolved'; // next tick records the original revert before a fresh attempt
      await complete(job, sent, proof, confirmed.observed, deps, confirmed.checked); return 'confirmed';
    } catch {
      try { const latest = await load(id, deps); if (latest.state !== 'quarantined') await mark(latest, deps, 'PUBLICATION_UNAVAILABLE'); }
      catch { /* A lost DB connection preserves the durable attempt for the next worker. */ }
      return 'unresolved';
    }
  }).catch(error => {
    if (error instanceof AppError && ['MIX_CREATE_BUSY','MIX_UNAVAILABLE'].includes(error.code)) throw error;
    throw mixUnavailable('publication', error);
  });
}

export async function publishMixStrategy(strategyId: string, onchainId: number, creationId: string | undefined,
  allocation: Allocation, execution: AssetExecution, deps: PublicationDeps): Promise<void> {
  const schedule = { kind: 'funding' as const };
  const settings = typedVersionSettings({ chainId: 97, allocation, execution, schedule, activeAt: new Date(0) });
  const hash = registryConfigHash(allocation.assets.map(a => a.address as Address), allocation.assets.map(a => a.weightBps), settings);
  const calldata = encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'publishSettingsVersion', args: [BigInt(onchainId), allocation.assets.map(a => a.address as Address),
    allocation.assets.map(a => a.weightBps), settings.scheduleHash, settings.settingsHash, settings.performanceFeeBps, 0n] });
  await deps.query(`insert into mix_publication_jobs(strategy_id,chain_id,registry,onchain_strategy_id,creation_request_id,allocation,schedule,execution,config_hash,calldata)
    values($1,97,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(strategy_id) do nothing`, [strategyId, T.contracts.registry, onchainId, creationId ?? null,
      JSON.stringify({ ...allocation, p11: settings }), JSON.stringify(schedule), JSON.stringify(execution), hash, calldata]);
  const saved = await load(strategyId, deps);
  if (saved.calldata !== calldata || saved.config_hash !== hash) { await mark(saved, deps, 'PUBLICATION_CONFIG_CONFLICT', true); throw mixUnavailable(); }
  const settled = await reconcileMixPublication(strategyId, deps, true);
  if (settled !== 'confirmed') throw mixUnavailable(`publication-${settled}`);
}


/** Called inside the shared nonce lock, without acquiring another lock or signing.
 * Replay only immutable, unresolved originals whose first version is still absent.
 * This fills gaps before ordinary entry points ask the node for their next nonce. */
export async function replayPublicationNonceGap(client: PublicClient, signer: Address, from: bigint, held: () => void, deadlineAt = Date.now() + 5000): Promise<bigint | null> {
  const deps: PublicationDeps = { client, query, transaction: withTransaction, deadlineAt };
  const rows = (await query<Attempt>(`select o.*,o.nonce::text,r.status,r.block_number::text,r.block_hash from mix_publication_outbox o
    left join mix_publication_receipts r using(strategy_id,attempt)
    left join mix_publication_nonce_consumptions c using(strategy_id,attempt)
    where o.chain_id=97 and o.signer=$1 and o.nonce>=$2::numeric and c.strategy_id is null
    order by o.nonce limit 20`, [signer.toLowerCase(), from.toString()])).rows;
  let next = from;
  for (const current of rows) {
    if (BigInt(current.nonce) !== next) break;
    const job = await load(current.strategy_id, deps);
    await validatePublicationTransaction(job, current);
    // Quarantine does not invalidate immutable bytes. A stored receipt may have
    // been orphaned; never let that receipt hide a now-empty canonical nonce.
    if (current.status !== null && (current.block_number === null ||
        (await anchor(deps, BigInt(current.block_number))).hash === current.block_hash)) break;
    if ((await state(job, deps)).count !== 0n) break;
    held();
    let accepted: Hex;
    try { accepted = await bounded(client.sendRawTransaction({ serializedTransaction: current.signed_raw_tx }), deps); }
    catch {
      // Do not trust an RPC error's wording (including "already known"). The
      // exact original must independently be visible at the node before it
      // can supply a local pending floor.
      const known = await bounded(client.getTransaction({ hash: current.tx_hash }), deps);
      if (known.hash !== current.tx_hash || known.from.toLowerCase() !== current.signer.toLowerCase() || known.nonce.toString() !== current.nonce ||
          known.to?.toLowerCase() !== job.registry || known.input !== job.calldata || known.value !== 0n) throw mixUnavailable();
      accepted = known.hash;
    }
    if (accepted !== current.tx_hash) throw mixUnavailable();
    next++;
  }
  return next === from ? null : next - 1n;
}
