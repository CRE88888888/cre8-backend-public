import { MIX_EXIT_DUST_RAW } from './mix-runtime.js';
import { planPortfolio, valuationHoldings } from './snapshot.js';
import type { PortfolioPlan } from './snapshot.js';
import { numeraireFor } from './strategy-execution.js';

/**
 * New money after "sell all" (2026-11-25, testnet portfolio 32).
 *
 * "Sell all" (`/close`) pauses the portfolio and the scheduler only claims active ones. A fund buy calls
 * `/portfolios/:id/rebalance`, which sets it active again; My mix funding and DCA do not, so the new money was recorded
 * and never bought. The owner's new money now resumes the portfolio itself: a new funding lot (`funding-lots`,
 * `buy-funding`) and a confirmed DCA deposit.
 *
 * `schedule_state='paused'` has other writers and no column says which one wrote it:
 *   - `/close` (operator.ts)                      -> resumed here
 *   - owner pause (`execution-state`)             -> stays paused
 *   - My mix exited / deleting / deleted, exit retry guard, old portfolio of a re-enrolled mix -> stay paused
 * The mix cases are rows (`mixes`, `mix_portfolio_history`): RESUME_AFTER_SELL_ALL_SQL excludes them. `/close` and the
 * owner pause leave no row at all, so they are told apart by what the account holds on chain: after "sell all" it holds
 * nothing but USDT. A paused portfolio that still holds assets is never resumed here. (An owner pause of an account
 * that holds no asset reads the same as "sell all"; no client calls `execution-state`.)
 */

/** What `/rebalance` runs for the owner (operator.ts `resumeIfPaused`). */
export const RESUME_PAUSED_SQL = `update portfolios set schedule_state = 'active' where id = $1 and schedule_state = 'paused'`;

/** The same statement, minus the My mix states that paused it on purpose or made this portfolio the old one. */
export const RESUME_AFTER_SELL_ALL_SQL = `${RESUME_PAUSED_SQL}
  and not exists(select 1 from mix_portfolio_history h join mixes m on m.id = h.mix_id where h.portfolio_id = $1
    and (h.ended_at is not null or m.status <> 'active' or m.triggered_at is not null
      or m.delete_requested_at is not null or m.deleted_at is not null))`;

/**
 * True when the account holds nothing but cash: wallet balances, shares posted for Strategy Earn and yield positions
 * of every other asset are worth less than 0.01 USDT in total (the "empty" rule of My mix deletion). An asset that is
 * held without a price, or a yield position without a value, is a holding.
 */
export function holdsOnlyCash(plan: PortfolioPlan): boolean {
  const cash = numeraireFor(plan.chainId);
  const other = (asset: string) => asset.toLowerCase() !== cash;
  if (plan.snapshot.unpriced.some(a => other(a.asset) && a.amountWei > 0n)) return false;
  if ((plan.snapshot.yieldPositions ?? []).some(p => other(p.market.asset) && p.value === null)) return false;
  const usdE8 = valuationHoldings(plan.snapshot).filter(h => other(h.asset)).reduce((sum, h) => sum + h.amountWei, 0n);
  return usdE8 * 10n ** 10n < MIX_EXIT_DUST_RAW;
}

/** One observation of the account (no log scan, nothing written, no lock). Throws when the chain cannot answer. */
export async function accountHoldsOnlyCash(portfolioId: number): Promise<boolean> {
  return holdsOnlyCash(await planPortfolio(portfolioId, { observeOnly: true }));
}

/**
 * Whether the owner's new money should resume this portfolio. Never fails the funding itself: when the account cannot
 * be read the money is still recorded and the portfolio stays as it is.
 */
export async function pausedBySellAll(portfolio: { id: number; scheduleState: string }, holdsOnlyCashNow: (portfolioId: number) => Promise<boolean>,
  log: (line: string) => void = console.warn): Promise<boolean> {
  if (portfolio.scheduleState !== 'paused') return false;
  try { return await holdsOnlyCashNow(portfolio.id); }
  catch { log(`[resume] portfolio ${portfolio.id} 暫停中，帳戶持倉這次讀不到：新的入金照記，排程狀態不變`); return false; }
}
