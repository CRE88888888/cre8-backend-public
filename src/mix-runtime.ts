import { reconcileCashWithdrawals } from './cash-reconciliation.js';
import type { CashWithdrawal } from './cash-reconciliation.js';
import { computeDrift } from './drift.js';
import type { PortfolioPlan } from './snapshot.js';
import type { DuePortfolio, SchedulerQueryFn, WithTransactionFn } from './scheduler.js';
import { mixPerformance, nextMixRebalance } from './mix-domain.js';
import type { MixFrequency } from './mix-domain.js';
import { record } from './strategy-execution.js';
import { quiesceMix, mixUnavailable } from './mix-store.js';
import { TESTNET_97 as T } from './testnet-profile.js';
import { mixAnchor } from './mix-valuation.js';
import type { MixAnchor } from './mix-valuation.js';
import { recordAlerts } from './alerts.js';
import { getChain, PRICE_SOURCE_ABI } from './chain.js';
import type { Address } from 'viem';
import { loadTradingConfig } from './config.js';
import { assetsMarketOpen } from './trading-calendar.js';

export type MixRuntime = { id: string; owner: string; status: 'active' | 'exited'; triggered: boolean;
  userAllocation: Record<string, number>; frequency: MixFrequency; startDate: string; last: Date | null; takeProfit: number | null; stopLoss: number | null;
  deposits: bigint; withdrawals: bigint; pending: boolean; exits: Set<string>; newMoney: boolean; retries: number; lastExitAttempt: Date | null };
export type MixTick = { mode: 'wait' | 'new_money' | 'rebalance' | 'exit'; reason: string; trigger: 'take_profit' | 'stop_loss' | null;
  returnBps: string | null; plan: PortfolioPlan; complete: boolean };
const cash = T.contracts.usdt;
export const MIX_MIN_TRADE_RAW = 10n ** 18n;
// C3: the TOTAL remaining noncash basket, strictly below 0.01 USD.
export const MIX_EXIT_DUST_RAW = 10n ** 16n;
export const MIX_EXIT_MAX_RETRIES = 5;
export const MIX_EXIT_COOLDOWN_MS = 5 * 60_000;
export const MIX_EXIT_MAX_COOLDOWN_MS = 6 * 60 * 60_000;
export const MIX_EXIT_RETRY_COUNT_CAP = MIX_EXIT_MAX_RETRIES + 3;
export function mixExitCooldownMs(retries: number): number {
  if (!Number.isSafeInteger(retries) || retries < 0) throw mixUnavailable();
  if (retries < MIX_EXIT_MAX_RETRIES) return 0;
  return [MIX_EXIT_COOLDOWN_MS, 15 * 60_000, 60 * 60_000][retries - MIX_EXIT_MAX_RETRIES] ?? MIX_EXIT_MAX_COOLDOWN_MS;
}
// The claim predicate and in-lock admission must use the same persisted streak.
export const MIX_EXIT_COOLDOWN_SQL = `(case when m.exit_retry_count<${MIX_EXIT_MAX_RETRIES} then 0
  when m.exit_retry_count=${MIX_EXIT_MAX_RETRIES} then ${MIX_EXIT_COOLDOWN_MS}
  when m.exit_retry_count=${MIX_EXIT_MAX_RETRIES + 1} then 900000
  when m.exit_retry_count=${MIX_EXIT_MAX_RETRIES + 2} then 3600000 else ${MIX_EXIT_MAX_COOLDOWN_MS} end)`;

export function mixSwitchExitsPending(m: Pick<MixRuntime, 'last' | 'exits'>, plan: PortfolioPlan): boolean {
  if (m.last !== null || m.exits.size === 0) return false;
  const minimum = loadTradingConfig().minStepUsdE8 * 10n ** 10n;
  return plan.snapshot.holdings.some(h => h.amountWei > 0n && m.exits.has(h.asset.toLowerCase()) &&
    h.amountWei * h.usdPriceE8 * 10n ** 10n / 10n ** BigInt(h.decimals) >= minimum);
}

/** Called under the stable mix lock only after a non-retryable minimum noop.
 * A closed/unpriced exit is never residual. Audit and completion commit together. */
export async function recordMixSwitchResidual(m: MixRuntime, due: DuePortfolio, plan: PortfolioPlan, now: Date,
  run: WithTransactionFn, anchor = mixAnchor): Promise<boolean> {
  try {
    if (m.last !== null || plan.chainId !== 97 || plan.portfolioId !== due.portfolioId || plan.snapshot.portfolioId !== due.portfolioId ||
        plan.account.toLowerCase() !== due.account.toLowerCase() || plan.blocked.length || plan.report === null ||
        plan.snapshot.unpriced.some(h => h.amountWei > 0n)) return false;
    const held = plan.snapshot.holdings.filter(h => m.exits.has(h.asset.toLowerCase()) && h.amountWei > 0n);
    if (held.length === 0 || !assetsMarketOpen(97, held.map(h => h.asset), now) ||
        held.some(h => h.usdPriceE8 <= 0n || !Number.isInteger(h.decimals) || h.decimals < 0 || h.decimals > 255 ||
          typeof h.priceSource !== 'string' || h.priceSource.length === 0)) return false;
    const policy = loadTradingConfig();
    const residuals = held.map(h => ({ asset: h.asset.toLowerCase(), quantityRaw: h.amountWei.toString(), decimals: h.decimals,
      priceUsdE8: h.usdPriceE8.toString(), priceSource: h.priceSource,
      valueRaw: (h.amountWei * h.usdPriceE8 * 10n ** 10n / 10n ** BigInt(h.decimals)).toString() }));
    if (residuals.reduce((sum, h) => sum + BigInt(h.valueRaw), 0n) >= policy.minBatchUsdE8 * 10n ** 10n) return false;
    const proof = await anchor(plan.snapshot.block);
    const checked = await anchor(plan.snapshot.block);
    if (!/^0x[0-9a-f]{64}$/.test(proof.hash) || !Number.isFinite(proof.at.getTime()) ||
        checked.hash !== proof.hash || checked.at.getTime() !== proof.at.getTime()) throw mixUnavailable();
    const payload = { message: '移除成分的剩餘持倉低於批次最小額，已記錄殘留並完成本次檢查；下期仍會檢查。',
      reason: 'below_batch_minimum', blockNumber: plan.snapshot.block.toString(), blockHash: proof.hash, pricedAt: proof.at.toISOString(),
      minimumStepUsdE8: policy.minStepUsdE8.toString(), minimumBatchUsdE8: policy.minBatchUsdE8.toString(), residuals };
    return await run(async db => {
      const locked = (await db.query(`select id from mixes where id=$1 and status='active' and triggered_at is null
        and last_rebalanced_at is null for update`, [m.id])).rows[0];
      if (!locked) return false;
      const history = (await db.query('select id,enroll_block_number::text from mix_portfolio_history where mix_id=$1 and portfolio_id=$2 and ended_at is null', [m.id, due.portfolioId])).rows[0];
      if (!record(history) || typeof history.id !== 'string' || typeof history.enroll_block_number !== 'string' ||
          plan.snapshot.block < BigInt(history.enroll_block_number)) throw mixUnavailable();
      const saved = await db.query(`insert into user_notifications(chain_id,portfolio_id,owner,kind,dedup_key,payload)
        select 97,$2,owner,'mix_switch_residual',$3,$4 from mixes where id=$1
        on conflict(chain_id,kind,dedup_key) do nothing returning id`, [m.id, due.portfolioId,
          `${history.id}:${plan.snapshot.block}`, JSON.stringify(payload)]);
      if (saved.rows.length !== 1) throw mixUnavailable();
      await db.query('update mixes set last_rebalanced_at=$2 where id=$1', [m.id, now]);
      return true;
    });
  } catch { throw mixUnavailable(); }
}

/** All values are oracle-priced, from the same snapshot. A closed stock remains
 * in the valuation and target; the quote planner decides which legs can trade.
 */
export function decideMixTick(m: MixRuntime, plan: PortfolioPlan, now: Date): MixTick {
  const value = plan.snapshot.holdings.reduce((sum, h) => sum + h.amountWei * h.usdPriceE8 * 10n ** 10n / 10n ** BigInt(h.decimals), 0n);
  const perf = mixPerformance(value, m.deposits, m.withdrawals, { takeProfitBps: m.takeProfit, stopLossBps: m.stopLoss });
  const base = { trigger: null, returnBps: perf.returnBps, plan, complete: false };
  if (plan.blocked.length || plan.report === null || plan.snapshot.unpriced.some(h => h.amountWei > 0n)) {
    return { ...base, mode: 'wait', reason: '目前無法確認組合價值，停利停損暫不觸發。' };
  }
  if (m.status === 'exited') return { ...base, mode: 'wait', reason: '組合已退出；重新開始後才會買入。' };
  if (m.triggered || perf.trigger) {
    const targets = plan.targets.map(t => ({ ...t, weightBps: t.asset.toLowerCase() === cash ? 10000 : 0 }));
    if (!targets.some(t => t.asset.toLowerCase() === cash)) targets.push({ asset: cash, weightBps: 10000, symbol: 'USDT' });
    const report = computeDrift(plan.snapshot.holdings, targets, 0);
    const complete = plan.snapshot.holdings.filter(h => h.asset.toLowerCase() !== cash).reduce((sum, h) => sum +
      h.amountWei * h.usdPriceE8 * 10n ** 10n / 10n ** BigInt(h.decimals), 0n) < MIX_EXIT_DUST_RAW;
    return { ...base, mode: 'exit', reason: '已觸發整籃退出；加密資產立即賣出，美股於開盤時處理。',
      trigger: m.triggered ? null : perf.trigger, plan: { ...plan, targets, report, thresholdBps: 0 }, complete };
  }
  if (m.pending) return { ...base, mode: 'wait', reason: '組合變更等待鏈上確認，暫不交易。' };
  const targets = plan.targets.map(t => ({ ...t, weightBps: m.userAllocation[t.asset.toLowerCase()] ?? 0 }));
  if (targets.reduce((sum, t) => sum + t.weightBps, 0) !== 10000 ||
      Object.keys(m.userAllocation).some(asset => !targets.some(t => t.asset.toLowerCase() === asset))) {
    return { ...base, mode: 'wait', reason: '目前無法確認組合比例，暫不交易。' };
  }
  plan = { ...plan, targets };
  const at = nextMixRebalance({ frequency: m.frequency, startDate: m.startDate }, m.last);
  if (m.newMoney) return { ...base, mode: 'new_money', reason: '按目前組合處理已確認的新投入。' };
  if (at > now && m.last !== null) return { ...base, mode: 'wait', reason: `下一次再平衡為 ${at.toISOString()}。` };
  // A freshly confirmed switch/restart has last=null and always gets an immediate pass.
  const report = computeDrift(plan.snapshot.holdings, plan.targets, 0);
  const complete = !mixSwitchExitsPending(m, plan) && report.assets.every(a => {
    const delta = a.usdValueE8 * 10000n - report.totalUsdE8 * BigInt(a.targetBps);
    return (delta < 0n ? -delta : delta) * 10n ** 10n < MIX_MIN_TRADE_RAW * 10000n;
  });
  return { ...base, mode: 'rebalance', reason: '依設定日期與頻率檢查再平衡。', complete,
    plan: { ...plan, report, thresholdBps: 0 } };
}

export async function loadMixRuntime(due: DuePortfolio, find: SchedulerQueryFn, blockNumber?: bigint, anchor = mixAnchor): Promise<MixRuntime | null> {
  const r = (await find(`select m.id,m.owner,m.status,m.triggered_at,m.frequency,to_char(m.start_date,'YYYY-MM-DD') as start_date,
    m.last_rebalanced_at,m.take_profit_bps,m.stop_loss_bps,m.exit_retry_count,m.exit_last_attempt_at,m.performance_start_block::text,m.performance_start_block_hash,s.exit_assets,s.user_allocation,
    exists(select 1 from mix_switch_intents i where i.mix_id=m.id and i.state in ('prepared','submitted','unknown')) as pending,
    exists(select 1 from strategy_lot_assets a join strategy_funding_lots l on l.id=a.lot_id where l.portfolio_id=h.portfolio_id and a.state='active') as new_money,
    (coalesce(m.performance_baseline_raw,0)+coalesce((select sum(amount_raw) from mix_cash_flows f where f.mix_id=m.id and f.kind='deposit'
      and f.state='canonical' and (m.performance_start_block is null or f.block_number>m.performance_start_block) and ($2::bigint is null or f.block_number<=$2)),0))::text as deposits,
    coalesce((select sum(amount_raw) from mix_cash_flows f where f.mix_id=m.id and f.kind='withdrawal' and f.state='canonical'
      and (m.performance_start_block is null or f.block_number>m.performance_start_block) and ($2::bigint is null or f.block_number<=$2)),0)::text as withdrawals
    from mixes m join mix_portfolio_history h on h.mix_id=m.id and h.ended_at is null
    join mix_strategy_settings s on s.strategy_id=h.strategy_id where h.portfolio_id=$1 and m.deleted_at is null`, [due.portfolioId, blockNumber?.toString() ?? null])).rows[0];
  if (r === undefined) return null;
  if (record(r) && typeof r.performance_start_block === 'string') {
    const start = BigInt(r.performance_start_block);
    if (blockNumber !== undefined && start > blockNumber || (await anchor(start)).hash !== r.performance_start_block_hash) throw mixUnavailable();
  }
  if (!record(r) || typeof r.id !== 'string' || typeof r.owner !== 'string' || !['active','exited'].includes(String(r.status)) ||
      !['daily','weekly','monthly','quarterly'].includes(String(r.frequency)) || typeof r.start_date !== 'string' ||
      !(r.last_rebalanced_at === null || r.last_rebalanced_at instanceof Date) ||
      !(r.take_profit_bps === null || typeof r.take_profit_bps === 'number') || !(r.stop_loss_bps === null || typeof r.stop_loss_bps === 'number') ||
      typeof r.deposits !== 'string' || typeof r.withdrawals !== 'string' || typeof r.pending !== 'boolean' || typeof r.new_money !== 'boolean' ||
      !(r.exit_last_attempt_at === null || r.exit_last_attempt_at instanceof Date) ||
      typeof r.exit_retry_count !== 'number' || !Number.isSafeInteger(r.exit_retry_count) || r.exit_retry_count < 0 ||
      !Array.isArray(r.exit_assets) || !r.exit_assets.every((a: unknown): a is string => typeof a === 'string')) throw mixUnavailable();
  if (!record(r.user_allocation) || Object.values(r.user_allocation).some(v => typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 10000)) throw mixUnavailable();
  const userAllocation = Object.fromEntries(Object.entries(r.user_allocation).map(([asset, weight]) => {
    if (typeof weight !== 'number') throw mixUnavailable();
    return [asset, weight];
  }));
  if (Object.values(userAllocation).reduce((sum, weight) => sum + weight, 0) !== 10000) throw mixUnavailable();
  if (r.status !== 'active' && r.status !== 'exited') throw mixUnavailable();
  const frequency = r.frequency;
  if (frequency !== 'daily' && frequency !== 'weekly' && frequency !== 'monthly' && frequency !== 'quarterly') throw mixUnavailable();
  return { userAllocation, id: r.id, owner: r.owner, status: r.status, triggered: r.triggered_at !== null, frequency, startDate: r.start_date,
    last: r.last_rebalanced_at, takeProfit: r.take_profit_bps, stopLoss: r.stop_loss_bps,
    deposits: BigInt(r.deposits), withdrawals: BigInt(r.withdrawals), pending: r.pending, exits: new Set(r.exit_assets), newMoney: r.new_money, retries: r.exit_retry_count, lastExitAttempt: r.exit_last_attempt_at };
}

/** A target rebalance/exit consumes free cash only after old business jobs have
 * reconciled. No source amount or confirmed receipt is rewritten.
 */
export async function prepareMixTick(m: MixRuntime, tick: MixTick, due: DuePortfolio, now: Date, run: WithTransactionFn, withdrawals: readonly CashWithdrawal[] = [],
  residue?: { reason: 'below_total_dust' | 'below_executor_minimum'; anchor: MixAnchor }): Promise<void> {
  if (tick.mode === 'wait' || tick.mode === 'new_money') return;
  const held = tick.plan.snapshot.holdings.filter(h => h.asset.toLowerCase() !== cash && h.amountWei > 0n);
  const residualProof = tick.mode === 'exit' && tick.complete && held.length > 0 ? residue ?? {
    reason: 'below_total_dust' as const, anchor: await mixAnchor(tick.plan.snapshot.block) } : null;
  await run(async db => {
    await db.query('select id from mixes where id=$1 for update', [m.id]);
    await quiesceMix(db, 97, due.portfolioId);
    const observedCash = tick.plan.snapshot.holdings.find(h => h.asset.toLowerCase() === cash)?.amountWei ?? 0n;
    await reconcileCashWithdrawals(db.query, { chainId: 97, portfolioId: due.portfolioId, observedCash }, withdrawals);
    const balances = (await db.query('select * from strategy_cash_balances where chain_id=97 and portfolio_id=$1 for update', [due.portfolioId])).rows[0];
    if (!record(balances)) throw mixUnavailable();
    const free = ['unallocated_hold_raw', 'allocated_cash_raw'];
    const reserved = ['stack_prefund_raw','reserved_input_raw','reserved_fee_raw','withdrawal_raw','yield_raw','unclassified_raw'];
    for (const key of [...free, ...reserved]) if (typeof balances[key] !== 'string' || !/^(0|[1-9][0-9]*)$/.test(String(balances[key]))) throw mixUnavailable();
    if (reserved.some(key => BigInt(String(balances[key])) !== 0n) || tick.mode === 'rebalance' &&
        free.reduce((sum, key) => sum + BigInt(String(balances[key])), 0n) !== observedCash) {
      throw new Error('[MIX_CASH_RECONCILIATION] 現金與已確認的投資預算尚未對齊，暫不買入。');
    }
    await db.query("update strategy_lot_assets set state='cancelled',updated_at=clock_timestamp() where lot_id in (select id from strategy_funding_lots where portfolio_id=$1) and state='active'", [due.portfolioId]);
    await db.query(`update strategy_cash_balances set allocated_cash_raw=allocated_cash_raw+unallocated_hold_raw,
      unallocated_hold_raw=0,updated_at=clock_timestamp() where chain_id=97 and portfolio_id=$1`, [due.portfolioId]);
    if (tick.trigger !== null) {
      await db.query('update mixes set triggered_at=$2,triggered_return_bps=$3 where id=$1 and triggered_at is null', [m.id, now, tick.returnBps]);
      await db.query(`insert into user_notifications(chain_id,portfolio_id,owner,kind,dedup_key,payload)
        values(97,$1,$2,'mix_exit_triggered',$3,$4) on conflict(chain_id,kind,dedup_key) do nothing`,
        [due.portfolioId, m.owner, `${m.id}:${now.toISOString()}`, JSON.stringify({ message: tick.reason, returnBps: tick.returnBps, trigger: tick.trigger })]);
    }
    if (tick.complete) {
      if (tick.mode === 'exit') {
        if (residualProof) for (const h of held) {
          await db.query(`insert into mix_exit_residuals(mix_id,history_id,exit_triggered_at,asset,quantity_raw,asset_decimals,
            value_raw,price_usd_e8,price_source,priced_at,block_number,block_hash,reason)
            select m.id,h.id,m.triggered_at,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12 from mixes m join mix_portfolio_history h
              on h.mix_id=m.id and h.ended_at is null where m.id=$1 and h.portfolio_id=$2
            on conflict(mix_id,exit_triggered_at,asset) do nothing`, [m.id, due.portfolioId, h.asset, h.amountWei.toString(), h.decimals,
              (h.amountWei * h.usdPriceE8 * 10n ** 10n / 10n ** BigInt(h.decimals)).toString(), h.usdPriceE8.toString(), h.priceSource,
              residualProof.anchor.at, tick.plan.snapshot.block.toString(), residualProof.anchor.hash, residualProof.reason]);
        }
        await db.query("update mixes set status='exited' where id=$1", [m.id]);
        await db.query("update portfolios set schedule_state='paused' where id=$1", [due.portfolioId]);
      } else await db.query('update mixes set last_rebalanced_at=$2 where id=$1', [m.id, now]);
    }
  });
}

export async function mixBelowExecutorMinimum(plan: PortfolioPlan, floor: (asset: Address, quantity: bigint, block: bigint) => Promise<bigint> = async (asset, quantity, block) => {
  return (await getChain().publicClient.readContract({ address: T.contracts.router, abi: PRICE_SOURCE_ABI,
    functionName: 'previewSwap', args: [asset, T.contracts.usdt, quantity], blockNumber: block }))[1];
}): Promise<boolean> {
  const held = plan.snapshot.holdings.filter(h => h.asset.toLowerCase() !== cash && h.amountWei > 0n);
  if (plan.blocked.length || plan.report === null || plan.snapshot.unpriced.some(h => h.amountWei > 0n) || held.length === 0) return false;
  for (const h of held) {
    if (h.amountWei > (1n << 160n) - 1n || await floor(h.asset as Address, h.amountWei, plan.snapshot.block) !== 0n) return false;
  }
  return true;
}

export async function recordMixExitFailure(m: Pick<MixRuntime, 'id'>, due: Pick<DuePortfolio, 'portfolioId'>, now: Date, run: WithTransactionFn): Promise<void> {
  await run(async db => {
    const row = (await db.query(`update mixes set exit_retry_count=least(exit_retry_count,$3-1)+1,exit_last_attempt_at=$2
      where id=$1 and triggered_at is not null and status='active'
      returning exit_retry_count,exit_alerted_at`, [m.id, now, MIX_EXIT_RETRY_COUNT_CAP])).rows[0];
    if (!record(row) || typeof row.exit_retry_count !== 'number') throw mixUnavailable();
    if (row.exit_retry_count >= MIX_EXIT_MAX_RETRIES) {
      await db.query("update portfolios set schedule_state='paused' where id=$1", [due.portfolioId]);
      if (row.exit_alerted_at !== null && (!(row.exit_alerted_at instanceof Date) ||
          now.getTime() - row.exit_alerted_at.getTime() < MIX_EXIT_MAX_COOLDOWN_MS)) return;
      const message = '組合退出連續遇到交易問題，已告警並逐次延長重試間隔（5 分、15 分、1 小時，最多每 6 小時一次）；系統會重新確認條件後續作退出。';
      await db.query('update mixes set exit_alerted_at=$2 where id=$1', [m.id, now]);
      await db.query(`insert into user_notifications(chain_id,portfolio_id,owner,kind,dedup_key,payload)
        select 97,$1,owner,'mix_exit_stuck',$2,$3 from mixes where id=$4
        on conflict(chain_id,kind,dedup_key) do nothing`,
        [due.portfolioId, `${m.id}:${now.toISOString()}`, JSON.stringify({ message }), m.id]);
      await recordAlerts(db.query, [{ kind: 'portfolio_stuck', severity: 'critical', portfolioId: due.portfolioId, detail: message }], now);
    }
  });
}


/** Pending stock sources retain their budget. Only classified free cash may fund
 * an immediate/calendar target pass; valuation still includes the entire basket. */
export async function mixAvailableCash(due: DuePortfolio, plan: PortfolioPlan, find: SchedulerQueryFn): Promise<bigint> {
  const row = (await find('select * from strategy_cash_balances where chain_id=97 and portfolio_id=$1', [due.portfolioId])).rows[0];
  if (!record(row)) throw mixUnavailable();
  const keys = ['allocated_cash_raw','unallocated_hold_raw','stack_prefund_raw','reserved_input_raw','reserved_fee_raw','withdrawal_raw','yield_raw','unclassified_raw'];
  for (const key of keys) if (typeof row[key] !== 'string' || !/^(0|[1-9][0-9]*)$/.test(String(row[key]))) throw mixUnavailable();
  if (keys.slice(2).some(key => BigInt(String(row[key])) !== 0n) ||
      BigInt(String(row.allocated_cash_raw)) + BigInt(String(row.unallocated_hold_raw)) !==
      (plan.snapshot.holdings.find(h => h.asset.toLowerCase() === cash)?.amountWei ?? 0n)) throw mixUnavailable();
  return BigInt(String(row.allocated_cash_raw));
}
