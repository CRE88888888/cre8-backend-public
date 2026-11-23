import type { Address, Hex } from 'viem';
import { AsyncLocalStorage } from 'node:async_hooks';
import { query, withConnection, withTransaction, withPortfolioLock } from './db.js';
import { AppError } from './errors.js';
import type { MixAsset, MixFrequency } from './mix-domain.js';
import { record } from './strategy-execution.js';
import type { MixOwnerCall } from './mix-approval.js';
import { cancelJob, readJob } from './strategy-jobs.js';

export type MixRow = {
  id: string; owner: Address; name: string; chain_id: string; account: Address; initial_strategy_id: string;
  account_salt: Hex; share_code: string; imported_from_share_code: string | null; cover_image_id: string | null;
  frequency: MixFrequency; start_date: string; last_rebalanced_at: Date | null;
  take_profit_bps: number | null; stop_loss_bps: number | null; status: 'active' | 'exited';
  triggered_at: Date | null; triggered_return_bps: string | null; created_at: Date;
  performance_started_at: Date | null; performance_baseline_raw: string | null;
  performance_start_block: string | null; performance_start_block_hash: Hex | null;
  exit_retry_count: number; exit_last_attempt_at: Date | null; exit_alerted_at: Date | null;
  delete_requested_at: Date | null;
};
export type MixHistory = { id: string; mix_id: string; portfolio_id: string; strategy_id: string; version: number;
  enroll_block_number: string; enroll_block_hash: Hex; enroll_tx_hash: Hex; enroll_log_index: string;
  started_at: Date; closed_cash_raw: string | null; handover_minimum_raw: string; residual_cash_raw: string; residual_cash_reason: string | null };
export type MixIntent = { id: string; mix_id: string; strategy_id: string; from_history_id: string | null;
  owner_calls: MixOwnerCall[]; state: string; user_op_hash: Hex | null; confirmed_history_id: string | null;
  nonce: string | null; enroll_from_block: string; created_at: Date; expires_at: Date };
export type MixSnapshot = { strategy_id: string; mix_id: string; user_allocation: Record<string, number>; exit_assets: Address[] };
export type MixEnrollmentProof = { txHash: Hex; logIndex: number; blockNumber: bigint; blockHash: Hex; at: Date; userOpHash: Hex; cashRaw: string; nonce: bigint };
export type MixDb = { query: typeof query };
export const MIX_COLUMNS = `m.id,m.owner,m.name,m.chain_id,m.account,m.initial_strategy_id,m.account_salt,m.share_code,
  m.imported_from_share_code,m.frequency,to_char(m.start_date,'YYYY-MM-DD') as start_date,m.last_rebalanced_at,
  m.take_profit_bps,m.stop_loss_bps,m.status,m.triggered_at,m.triggered_return_bps::text,m.created_at,
  m.performance_started_at,m.performance_baseline_raw::text,m.performance_start_block::text,m.performance_start_block_hash,
  m.exit_retry_count,m.exit_last_attempt_at,m.exit_alerted_at,m.cover_image_id::text as cover_image_id,m.delete_requested_at`;
export const pendingMixSql = "state in ('prepared','submitted','unknown')";
export const mixUnavailable = () => new AppError(503, 'MIX_UNAVAILABLE', '目前無法確認組合資料，請稍後以原請求重試。');
export const mixBusy = () => new AppError(409, 'MIX_BUSY', '組合正在處理交易，確認完成後才能再次變更。');
const mixLockState = new AsyncLocalStorage<{ lost: boolean; check: () => Promise<void> }>();
export function assertMixLock(): void {
  if (mixLockState.getStore()?.lost) throw mixUnavailable();
}
/** A disconnect notification can arrive after an RPC resolves. Probe the SAME
 * lock connection immediately before signing/sending, rather than trusting timing.
 */
export async function checkMixLock(): Promise<void> {
  await mixLockState.getStore()?.check();
}
export function userMixAssets(s: MixSnapshot): MixAsset[] {
  return Object.entries(s.user_allocation).map(([assetId, weightBps]) => ({ assetId: assetId as Address, weightBps }));
}
export async function currentMixHistory(id: string, db: MixDb = { query }): Promise<MixHistory | null> {
  return (await db.query<MixHistory>('select * from mix_portfolio_history where mix_id=$1 and ended_at is null', [id])).rows[0] ?? null;
}
export async function pendingMixIntent(id: string, db: MixDb = { query }): Promise<MixIntent | null> {
  return (await db.query<MixIntent>(`select * from mix_switch_intents where mix_id=$1 and ${pendingMixSql}`, [id])).rows[0] ?? null;
}
/** Stable identity lock precedes the existing portfolio/cash locks, including RPCs.
 * Session-scoped locks survive short transactions and use a separate two-int namespace.
 */
export async function withMixLock<T>(id: string, work: () => Promise<T>): Promise<T> {
  if (!/^[1-9][0-9]*$/.test(id)) throw new RangeError('invalid mix id');
  return withConnection(async (client, discard) => {
    let held = false;
    const state = { lost: false, check: async () => {
      if (state.lost) throw mixUnavailable();
      try { await client.query('select 1'); }
      catch { state.lost = true; discard(); throw mixUnavailable(); }
    } };
    const lost = () => { state.lost = true; discard(); };
    client.on('error', lost);
    try {
      held = (await client.query<{ held: boolean }>("select pg_try_advisory_lock(178,hashtext($1)) as held", [id])).rows[0]?.held === true;
      if (!held) throw mixBusy();
      const result = await mixLockState.run(state, work);
      if (state.lost) throw mixUnavailable();
      return result;
    } finally {
      if (held) {
        try { if ((await client.query<{ released: boolean }>('select pg_advisory_unlock(178,hashtext($1)) as released', [id])).rows[0]?.released !== true) discard(); }
        catch { discard(); }
      }
      client.removeListener('error', lost);
    }
  });
}

export async function withMixPortfolioLock<T>(portfolioId: number, work: () => Promise<T>): Promise<T | null> {
  const m = (await query<{ id: string }>(`select m.id from mixes m join smart_accounts a
    on (a.chain_id,a.address)=(m.chain_id,m.account) where a.portfolio_id=$1 and a.retired_at is null`, [portfolioId])).rows[0];
  if (!m) return withPortfolioLock(portfolioId, work);
  try { return await withMixLock(m.id, work); }
  catch (error) { if (error instanceof AppError && error.code === 'MIX_BUSY') return null; throw error; }
}

/** A 1-bp exit is an execution allowlist, never a new-money purchase. Cancel its
 * unstarted slice and keep that tiny budget as free USDT. Existing/sent slices are
 * never rewritten; they must reconcile before a strategy can be switched.
 */
export async function excludeMixExitBudgets(db: { query: import('./scheduler.js').SchedulerQueryFn }, portfolioId: number): Promise<void> {
  const exits = (await db.query(`select a.lot_id,a.asset,a.budget_raw::text
    from strategy_lot_assets a join strategy_funding_lots l on l.id=a.lot_id
    join mix_strategy_settings ms on ms.strategy_id=l.strategy_id
    where l.portfolio_id=$1 and a.state='active' and ms.exit_assets ? a.asset
      and not exists(select 1 from strategy_asset_slices s where (s.lot_id,s.asset)=(a.lot_id,a.asset)) for update of a`, [portfolioId])).rows;
  for (const exit of exits) {
    if (!record(exit) || typeof exit.lot_id !== 'string' || typeof exit.asset !== 'string' || typeof exit.budget_raw !== 'string') throw mixUnavailable();
    await db.query("update strategy_lot_assets set state='cancelled',updated_at=clock_timestamp() where lot_id=$1 and asset=$2 and state='active'", [exit.lot_id, exit.asset]);
    await db.query(`update strategy_cash_balances set unallocated_hold_raw=unallocated_hold_raw-$2::numeric,
      allocated_cash_raw=allocated_cash_raw+$2::numeric,updated_at=clock_timestamp() where portfolio_id=$1`, [portfolioId, exit.budget_raw]);
  }
}

/** No unknown operation can be cancelled, even if it has not produced a receipt yet. */
export async function quiesceMix(db: { query: import('./scheduler.js').SchedulerQueryFn }, chainId: number, portfolioId: number): Promise<void> {
  const run = (sql: string, params?: readonly unknown[]) => db.query(sql, params ? [...params] : []);
  if ((await run(`select 1 from operations where portfolio_id=$1 and
      (state in ('pending','submitted') or (state='failed' and (tx_hash is not null or user_op_hash is not null))) limit 1`, [portfolioId])).rows.length) throw mixBusy();
  const job = await readJob(run, { chainId, portfolioId });
  if (job?.state === 'unknown') throw mixBusy();
  if (job) await cancelJob(run, { chainId, portfolioId }, job);
  await db.query('select strategy_replan_quiescent($1,$2)', [chainId, portfolioId]);
}

export async function recordMixExecution(find: import('./scheduler.js').SchedulerQueryFn, portfolioId: number, key: string, mode: 'new_money' | 'rebalance', switchExitsPending = true): Promise<void> {
  // Called inside canonical receipt settlement, never for a send or timeout.
  if (mode === 'rebalance') await find(`update mixes set last_rebalanced_at=clock_timestamp() where id in
    (select mix_id from mix_portfolio_history where portfolio_id=$1 and ended_at is null)
    and status='active' and triggered_at is null
    and (not $2::boolean or last_rebalanced_at is not null or not exists(select 1 from mix_portfolio_history h
      join mix_strategy_settings s on s.strategy_id=h.strategy_id where h.mix_id=mixes.id and h.ended_at is null
        and jsonb_array_length(s.exit_assets)>0))`, [portfolioId, switchExitsPending]);
  // A canonical successful sell ends the consecutive-failure streak. Resume only
  // a portfolio paused by this exit guard; the exit latch itself stays set.
  await find(`update portfolios set schedule_state='active' where id=$1 and schedule_state='paused'
    and exists(select 1 from mixes m join mix_portfolio_history h on h.mix_id=m.id and h.ended_at is null
      where h.portfolio_id=$1 and m.status='active' and m.triggered_at is not null and m.exit_alerted_at is not null)`, [portfolioId]);
  await find(`update mixes set exit_retry_count=0,exit_last_attempt_at=null,exit_alerted_at=null where id in
    (select mix_id from mix_portfolio_history where portfolio_id=$1 and ended_at is null)
    and status='active' and triggered_at is not null`, [portfolioId]);
  await find(`insert into user_notifications(chain_id,portfolio_id,owner,kind,dedup_key,payload)
    select m.chain_id,h.portfolio_id,m.owner,'mix_rebalanced',$2,jsonb_build_object('message',case when m.triggered_at is null
      then '已依組合設定完成一批買入或再平衡。' else '已完成一批停利停損賣出；未完成的股票會於開盤續作。' end)
    from mixes m join mix_portfolio_history h on h.mix_id=m.id and h.ended_at is null where h.portfolio_id=$1
    on conflict(chain_id,kind,dedup_key) do nothing`, [portfolioId, key]);
}

/** All RPC proof must be verified before entering this transaction. A failed COMMIT
 * is retried against the original intent/history, never by re-enrolling or deriving a key.
 */
export async function confirmMixSegment(m: MixRow, intent: MixIntent, proof: MixEnrollmentProof,
  options: { initialPortfolioId?: number; transaction?: typeof withTransaction } = {}): Promise<number> {
  return (options.transaction ?? withTransaction)(async db => {
    await db.query('select id from mixes where id=$1 for update', [m.id]);
    const saved = (await db.query<MixIntent>('select * from mix_switch_intents where id=$1 for update', [intent.id])).rows[0];
    if (!saved || saved.mix_id !== m.id || saved.strategy_id !== intent.strategy_id) throw mixUnavailable();
    if (saved.state === 'confirmed') {
      const prior = (await db.query<{ portfolio_id: string }>('select portfolio_id from mix_portfolio_history where id=$1', [saved.confirmed_history_id])).rows[0];
      if (!prior) throw mixUnavailable();
      return Number(prior.portfolio_id);
    }
    if (!['prepared', 'submitted', 'unknown'].includes(saved.state) || saved.user_op_hash !== null && saved.user_op_hash !== proof.userOpHash ||
        saved.nonce !== null && BigInt(saved.nonce) !== proof.nonce) throw mixBusy();
    const previous = await currentMixHistory(m.id, db);
    if ((previous?.id ?? null) !== saved.from_history_id) throw mixBusy();
    const chainId = Number(m.chain_id);
    let handover = '0';
    if (previous) {
      const oldId = Number(previous.portfolio_id);
      await quiesceMix(db, chainId, oldId);
      if (!/^(0|[1-9][0-9]*)$/.test(proof.cashRaw)) throw mixUnavailable();
      const reconciled = await db.query(`update strategy_cash_balances set unallocated_hold_raw=$3,allocated_cash_raw=0,updated_at=clock_timestamp()
        where chain_id=$1 and portfolio_id=$2 and stack_prefund_raw+reserved_input_raw+reserved_fee_raw+withdrawal_raw+yield_raw+unclassified_raw=0 returning portfolio_id`,
        [chainId, oldId, proof.cashRaw]);
      if (reconciled.rows.length !== 1) throw mixUnavailable();
      await db.query("update strategy_lot_assets set state='cancelled',updated_at=clock_timestamp() where lot_id in (select id from strategy_funding_lots where portfolio_id=$1) and state='active'", [oldId]);
      await db.query("update strategy_replan_assets set state='cancelled',updated_at=clock_timestamp() where replan_id in (select id from strategy_replans where portfolio_id=$1) and state='active'", [oldId]);
      const closed = (await db.query<{ closed_cash_raw: string }>('update mix_portfolio_history set ended_at=$2 where id=$1 returning closed_cash_raw::text', [previous.id, proof.at])).rows[0];
      if (!closed || closed.closed_cash_raw !== proof.cashRaw) throw mixUnavailable();
      handover = closed.closed_cash_raw;
      await db.query("update portfolios set schedule_state='paused' where id=$1", [oldId]);
      await db.query('update smart_accounts set retired_at=$2 where portfolio_id=$1 and retired_at is null', [oldId, proof.at]);
    }
    const portfolioId = previous ? Number((await db.query<{ id: string }>(`insert into portfolios(user_id,strategy_id,version,schedule_state)
      values($1,$2,1,'active') returning id`, [m.owner, saved.strategy_id])).rows[0]?.id) : options.initialPortfolioId;
    if (!portfolioId || !Number.isSafeInteger(portfolioId)) throw mixUnavailable();
    if (previous) await db.query(`insert into smart_accounts(portfolio_id,chain_id,address,owner,account_type)
      values($1,$2,$3,$4,'KERNEL')`, [portfolioId, chainId, m.account, m.owner]);
    await db.query(`insert into strategy_cash_balances(chain_id,portfolio_id,account) values($1,$2,$3)
      on conflict(chain_id,portfolio_id) do nothing`, [chainId, portfolioId, m.account]);
    const history = (await db.query<{ id: string; handover_minimum_raw: string; residual_cash_raw: string }>(`insert into mix_portfolio_history(mix_id,chain_id,portfolio_id,strategy_id,version,
      previous_history_id,started_at,enroll_tx_hash,enroll_log_index,enroll_block_number,enroll_block_hash,handover_raw)
      values($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11) returning id,handover_minimum_raw::text,residual_cash_raw::text`,
      [m.id, chainId, portfolioId, saved.strategy_id, previous?.id ?? null, proof.at, proof.txHash, proof.logIndex,
        proof.blockNumber.toString(), proof.blockHash, handover])).rows[0];
    if (!history) throw mixUnavailable();
    if (previous) {
      await db.query(`update strategy_cash_balances set unallocated_hold_raw=0,allocated_cash_raw=0,updated_at=clock_timestamp()
        where chain_id=$1 and portfolio_id=$2`, [chainId, previous.portfolio_id]);
      await db.query(`update strategy_cash_balances set unallocated_hold_raw=$3,updated_at=clock_timestamp()
        where chain_id=$1 and portfolio_id=$2`, [chainId, portfolioId, handover]);
      if (BigInt(handover) > 0n && history.residual_cash_raw === '0') {
        const settings = (await db.query<MixSnapshot>('select * from mix_strategy_settings where mix_id=$1 and strategy_id=$2', [m.id, saved.strategy_id])).rows[0];
        if (!settings) throw mixUnavailable();
        const lot = (await db.query<{ id: string }>(`insert into strategy_funding_lots(chain_id,portfolio_id,strategy_id,version,kind,
          tx_hash,log_index,block_number,block_hash,amount_raw,created_at,updated_at,source_kind,mix_history_id,minimum_contribution_raw,
          effective_allocation,allocation_reason)
          values($1,$2,$3,1,'asset',$4,$5,$6,$7,$8,$9,$9,'mix_handover',$10,$11,$12,'mix_handover') returning id`,
          [chainId, portfolioId, saved.strategy_id, proof.txHash, proof.logIndex, proof.blockNumber.toString(), proof.blockHash,
            handover, proof.at, history.id, history.handover_minimum_raw, JSON.stringify(settings.user_allocation)])).rows[0];
        if (!lot) throw mixUnavailable();
        const cash = (await db.query<{ cash: string }>(`select coalesce(sum(budget_raw),0)::text as cash from strategy_lot_assets
          where lot_id=$1 and effective_slices=0`, [lot.id])).rows[0];
        if (!cash) throw mixUnavailable();
        await db.query(`update strategy_cash_balances set unallocated_hold_raw=$3::numeric-$4::numeric,allocated_cash_raw=$4,
          updated_at=clock_timestamp() where chain_id=$1 and portfolio_id=$2`, [chainId, portfolioId, handover, cash.cash]);
      } else await db.query(`update strategy_cash_balances set unallocated_hold_raw=0,allocated_cash_raw=$3,updated_at=clock_timestamp()
        where chain_id=$1 and portfolio_id=$2`, [chainId, portfolioId, handover]);
      await db.query('update session_keys set portfolio_id=$2 where portfolio_id=$1', [previous.portfolio_id, portfolioId]);
      await db.query(`insert into portfolio_scan_cursors(portfolio_id,start_block,last_scanned_block)
        select $2,start_block,last_scanned_block from portfolio_scan_cursors where portfolio_id=$1 on conflict(portfolio_id) do nothing`, [previous.portfolio_id, portfolioId]);
    }
    await db.query(`update mix_switch_intents set state='confirmed',user_op_hash=$2,confirmed_history_id=$3,nonce=$4,updated_at=clock_timestamp() where id=$1`,
      [saved.id, proof.userOpHash, history.id, proof.nonce.toString()]);
    await db.query(`insert into user_notifications(chain_id,portfolio_id,owner,kind,dedup_key,payload)
      values($1,$2,$3,$4,$5,$6) on conflict(chain_id,kind,dedup_key) do nothing`,
      [chainId, portfolioId, m.owner, previous ? 'mix_allocation_changed' : 'mix_enrolled', history.id,
        JSON.stringify({ message: previous ? '新比例已生效；收盤中的股票會於開盤交易。' : '私人組合已建立，將依設定處理買入。' })]);
    // NULL means the newly confirmed allocation needs one immediate pass, regardless of frequency.
    await db.query('update mixes set last_rebalanced_at=null where id=$1', [m.id]);
    await db.query('update portfolios set next_run_at=null where id=$1', [portfolioId]);
    return portfolioId;
  });
}
