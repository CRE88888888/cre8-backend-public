import type { Address } from 'viem';
import { maxUint256 } from 'viem';
import { V2_CASH_OUT_MIN_RAW, cashOutMinUsdt, v2Calls } from './strategy-earn-v2.js';
import type { Call, StrategyEarnV2 } from './strategy-earn-v2.js';

/**
 * USDC / USD1 / U <-> USDT for routing v2: `AtpBorrowCashSwapper` (cre8-contracts docs/borrow-routing-v2 §17), an add-on
 * bound to one v2 executor. The executor itself never swaps; a route in a token other than USDT whose vault grew slower
 * than its debt could not be closed, and what a close leaves in the account could not become USDT again. The swapper is
 * the only thing that turns the account's USDT into a loan token it owes (`topUp`, straight into its strategy box) and
 * back (`cashOut`, to the account). The caller is the account: no account argument, no receiver.
 *
 * Where each half lives:
 * - `topUp` is planned with the repayment it serves, in the same UserOp (src/strategy-earn-v2.ts `settleRepayment`):
 *   before a close, a repayment, or a move off a route. Inputs are the swapper's own `shortfall` / `topUpCap` /
 *   `topUpWindowOf`, read with the account (src/strategy-earn-v2-chain.ts, eth_call with 30M gas).
 * - `cashOut` rides with the close that leaves the token behind when the leftover is certain (same function), and
 *   otherwise is the follow-up below: any round that finds a loan token other than USDT in the account with nothing owed
 *   in it sells it. Until then the net value counts it at 1 USD.
 */
export type Leftover = { symbol: string; token: Address;
  /** The account's own balance of the token, what it still owes in it, and what it approved of it to the cash swapper. */
  cashRaw: bigint; debtRaw: bigint; allowanceRaw: bigint };

/**
 * Cash-outs for what is left: every token with a balance worth selling (`V2_CASH_OUT_MIN_RAW`) and no debt in it — while
 * a route in the token is open, the account's balance is that route's repayment fallback (`maxCashIn`). `amountIn` = all
 * the account holds, `minUsdtOut` = the balance read × 0.997 (the contract's own bound is 0.25% off 1:1).
 * `unapproved`: balances that cannot be sold because the owner never approved the token to the swapper.
 * `minRaw`: the smallest balance sold. The default is for cash-outs that ride in a UserOp sent anyway; a caller whose
 * cash-outs would be a UserOp of their own passes `V2_CASH_OUT_ALONE_MIN_RAW`.
 */
export function leftoverCashOuts(v2: StrategyEarnV2, leftovers: readonly Leftover[], deadline: bigint, minRaw: bigint = V2_CASH_OUT_MIN_RAW): { calls: Call[]; sold: Leftover[]; unapproved: Leftover[] } {
  const out = { calls: [] as Call[], sold: [] as Leftover[], unapproved: [] as Leftover[] };
  if (!v2.swapper) return out;
  for (const l of leftovers) {
    if (l.debtRaw > 0n || l.cashRaw < minRaw) continue;
    if (l.allowanceRaw < l.cashRaw) { out.unapproved.push(l); continue; }
    out.calls.push(v2Calls.cashOut(v2, l.token, maxUint256, cashOutMinUsdt(l.cashRaw), deadline));
    out.sold.push(l);
  }
  return out;
}
