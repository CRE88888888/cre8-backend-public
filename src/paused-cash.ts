import { formatUnits } from 'viem';
import type { Address } from 'viem';
import { reconcileCashWithdrawals } from './cash-reconciliation.js';
import type { CashWithdrawal } from './cash-reconciliation.js';
import { numeraireFor } from './strategy-execution.js';
import { lockCash, unresolvedSql } from './strategy-jobs.js';
import type { SchedulerQueryFn, WithTransactionFn } from './scheduler.js';
import type { PortfolioPlan } from './snapshot.js';

/**
 * Withdrawals from a paused portfolio (2026-11-25, testnet portfolios 28 / 30 / 32 and every other "sell all").
 *
 * "Sell all" (`/close`) books the sale's USDT as the portfolio's own cash and pauses the portfolio; the owner then moves
 * that USDT to the wallet. A withdrawal is only booked by `reconcileCashWithdrawals`, which runs inside the buy path of a
 * scheduler round, and the scheduler never claims a paused portfolio. So the cash ledger kept claiming USDT that had
 * left the account for as long as the portfolio stayed paused: `/execution` showed it as a deficit, and a DCA could not
 * be started on that portfolio (it only takes USDT no bucket claims).
 *
 * This step does that one reconciliation for paused portfolios: same evidence (`withdrawals`, the source a round of
 * this portfolio would use), same rule (`reconcileCashWithdrawals`), under the portfolio's lock. It trades nothing and
 * never changes the schedule state. A paused portfolio whose ledger is covered by its balance costs one balance read.
 */
export type PausedCashPortfolio = { portfolioId: number; strategyId: number; account: Address; personalMix: boolean };
export type PausedCashDeps = {
  chainId: number;
  query: SchedulerQueryFn;
  withTransaction: WithTransactionFn;
  /** USDT the account holds now: the cheap check that decides whether anything else is read. */
  readCash: (account: Address) => Promise<bigint>;
  /** One observation of the portfolio (block + balances; My mix: its cash flows are synced through that block). */
  planPortfolio: (portfolioId: number) => Promise<PortfolioPlan>;
  /** Proven withdrawals up to the plan's block: what a scheduler round of this portfolio reconciles. */
  withdrawals: (portfolio: PausedCashPortfolio, plan: PortfolioPlan) => Promise<CashWithdrawal[]>;
  /** The portfolio's round lock; null = busy (an owner action is running), tried again next round. */
  lock: <T>(portfolio: PausedCashPortfolio, work: () => Promise<T>) => Promise<T | null>;
  log: (line: string) => void;
  now?: () => number;
  limit?: number;
};
export type PausedCashResult = { checked: number; reconciled: number; unresolved: number };

/** Portfolios read per round (most recently changed ledger first). */
export const PAUSED_CASH_LIMIT = 50;
/** Portfolios reconciled per round (each is one full observation of the portfolio); the rest wait for the next round. */
export const PAUSED_CASH_RECONCILES_PER_ROUND = 5;
/** A portfolio whose deficit could not be cleared is read again when its ledger or balance changes, or after this long. */
export const PAUSED_CASH_RETRY_MS = 30 * 60_000;
const CLAIMED = 'b.unallocated_hold_raw+b.stack_prefund_raw+b.allocated_cash_raw+b.reserved_input_raw+b.reserved_fee_raw+b.withdrawal_raw+b.yield_raw';
const LIVE_JOB = "exists(select 1 from strategy_jobs j where j.portfolio_id=p.id and j.state in ('reserved','running','unknown','paused'))";
// A paused portfolio with a live job is still claimed by the scheduler itself (SCHEDULER_ACTIVE_PREDICATE): left to it.
const SQL_CANDIDATES = `select b.portfolio_id::text as portfolio_id,b.account,p.strategy_id::text as strategy_id,(${CLAIMED})::text as claimed,
    coalesce((select (to_jsonb(s)->>'is_personal_mix')::boolean from strategies s where s.id=p.strategy_id),false) as personal_mix
  from strategy_cash_balances b join portfolios p on p.id=b.portfolio_id
  join smart_accounts a on (a.chain_id,a.portfolio_id,a.address)=(b.chain_id,b.portfolio_id,b.account) and a.retired_at is null
  where b.chain_id=$1 and p.schedule_state='paused' and ${CLAIMED}>0 and not ${LIVE_JOB}
  order by b.updated_at desc,b.portfolio_id limit $2`;
const SQL_STATE = `select (${CLAIMED})::text as claimed,p.schedule_state,${LIVE_JOB} as live_job,
    exists(select 1 from operations o where o.portfolio_id=p.id and ${unresolvedSql}) as unresolved,
    exists(select 1 from strategy_funding_lots l where l.chain_id=b.chain_id and l.portfolio_id=p.id and l.state='reorged') as reorged
  from strategy_cash_balances b join portfolios p on p.id=b.portfolio_id where b.chain_id=$1 and b.portfolio_id=$2`;

const waiting = new Map<string, { mark: string; at: number }>();
/** Test hook: forget which portfolios are waiting for new evidence. */
export function resetPausedCashMemory(): void { waiting.clear(); }

const usdt = (raw: bigint) => formatUnits(raw, 18);
const field = (row: unknown, key: string): unknown => typeof row === 'object' && row !== null ? Reflect.get(row, key) : undefined;
function amount(value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('paused cash: unreadable ledger');
  return BigInt(value);
}

export async function runPausedCashRound(d: PausedCashDeps): Promise<PausedCashResult> {
  const result: PausedCashResult = { checked: 0, reconciled: 0, unresolved: 0 };
  const cashToken = numeraireFor(d.chainId), now = d.now ?? Date.now;
  const rows = (await d.query(SQL_CANDIDATES, [d.chainId, d.limit ?? PAUSED_CASH_LIMIT])).rows;
  let attempts = 0;
  for (const row of rows) {
    const portfolioId = Number(field(row, 'portfolio_id')), strategyId = Number(field(row, 'strategy_id')), account = field(row, 'account');
    if (!Number.isSafeInteger(portfolioId) || portfolioId <= 0 || !Number.isSafeInteger(strategyId) || typeof account !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(account)) continue;
    const portfolio: PausedCashPortfolio = { portfolioId, strategyId, account: account as Address, personalMix: field(row, 'personal_mix') === true };
    const key = `${d.chainId}:${portfolioId}`;
    let mark = '';
    try {
      const claimed = amount(field(row, 'claimed')), held = await d.readCash(portfolio.account);
      result.checked++;
      if (claimed <= held) { waiting.delete(key); continue; }
      mark = `${claimed}:${held}`;
      const last = waiting.get(key);
      if (last && last.mark === mark && now() - last.at < PAUSED_CASH_RETRY_MS) { result.unresolved++; continue; }
      if (attempts >= PAUSED_CASH_RECONCILES_PER_ROUND) continue;
      attempts++;
      const done = await d.lock(portfolio, async () => {
        const plan = await d.planPortfolio(portfolioId);
        const observedCash = plan.snapshot.holdings.find(h => h.asset.toLowerCase() === cashToken)?.amountWei ?? 0n;
        const events = await d.withdrawals(portfolio, plan);
        return d.withTransaction(async ({ query }) => {
          await lockCash(query, { chainId: d.chainId, portfolioId });
          const state = (await query(SQL_STATE, [d.chainId, portfolioId])).rows[0];
          // Resumed, a job started or an operation is in flight since the list was read: the scheduler's own round reconciles.
          if (field(state, 'schedule_state') !== 'paused' || field(state, 'live_job') !== false || field(state, 'unresolved') !== false || field(state, 'reorged') !== false) return null;
          const before = amount(field(state, 'claimed'));
          await reconcileCashWithdrawals(query, { chainId: d.chainId, portfolioId, observedCash }, events);
          const after = amount(field((await query(SQL_STATE, [d.chainId, portfolioId])).rows[0], 'claimed'));
          return { before, after, observedCash };
        });
      });
      if (done === null) continue;
      if (done.after < done.before) {
        result.reconciled++;
        d.log(`[paused-cash] portfolio ${portfolioId} 領回錢包的 ${usdt(done.before - done.after)} USDT 已入帳（現金帳本 ${usdt(done.before)} → ${usdt(done.after)}，鏈上 ${usdt(done.observedCash)}）`);
      }
      if (done.after > done.observedCash) {
        result.unresolved++;
        waiting.set(key, { mark: `${done.after}:${done.observedCash}`, at: now() });
        d.log(`[paused-cash] portfolio ${portfolioId} 現金帳本 ${usdt(done.after)} USDT 仍高於鏈上 ${usdt(done.observedCash)}：沒有可證明的領回錢包紀錄，保留原帳`);
      } else waiting.delete(key);
    } catch (error) {
      result.unresolved++;
      if (mark) waiting.set(key, { mark, at: now() });
      const tag = error instanceof Error ? /^\[[A-Z_]+\]/.exec(error.message)?.[0] : undefined;
      d.log(`[paused-cash] portfolio ${portfolioId} 對帳未完成，保留原帳${tag ? `：${tag}` : ''}`);
    }
  }
  return result;
}
