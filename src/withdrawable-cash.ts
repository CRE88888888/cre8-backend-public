/**
 * USDT the owner may take out of a portfolio account right now (2026-11-23, portfolio 12).
 *
 * A running buy job (reserved_input/reserved_fee) and the withdrawal/yield reservations are money the scheduler will
 * still spend. If the owner takes it, the account holds less than is reserved: the job stops with [CASH_DEFICIT] and
 * cash reconciliation refuses the withdrawal ("提領已碰觸保留款"), so the portfolio is stuck. Every other bucket
 * (unclassified, allocated cash, not-yet-reserved funding) absorbs a withdrawal in reconcileCashWithdrawals, so it
 * stays withdrawable. DCA money is in its vault, not account cash, and is returned through its own flow.
 */
export const RESERVED_CASH_BUCKETS = ['reserved_input_raw', 'reserved_fee_raw', 'withdrawal_raw', 'yield_raw'] as const;

export function reservedCash(balances: Record<string, unknown> | null | undefined): bigint {
  if (!balances) return 0n;
  return RESERVED_CASH_BUCKETS.reduce((sum, key) => {
    const value = balances[key];
    if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(`invalid cash bucket ${key}`);
    return sum + BigInt(value);
  }, 0n);
}
/**
 * Every bucket of the cash ledger that claims USDT sitting in the account (all but `unclassified_raw`): funding waiting to
 * be bought, the portfolio's own cash, running jobs, reservations. strategy-jobs refuses to work ([CASH_DEFICIT] 現金分類
 * 與鏈上不符) as soon as their sum is above what the account holds, and only a transfer to the owner is ever reconciled
 * as a withdrawal. So anything else that spends account USDT — a cash-swapper top-up (src/strategy-earn-v2.ts) — may only
 * take what no bucket claims.
 */
export const CLAIMED_CASH_BUCKETS = ['unallocated_hold_raw', 'stack_prefund_raw', 'allocated_cash_raw', ...RESERVED_CASH_BUCKETS] as const;
export function claimedCash(balances: Record<string, unknown> | null | undefined): bigint {
  if (!balances) return 0n;
  return CLAIMED_CASH_BUCKETS.reduce((sum, key) => {
    const value = balances[key];
    if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(`invalid cash bucket ${key}`);
    return sum + BigInt(value);
  }, 0n);
}
export function withdrawableCash(observed: bigint, balances: Record<string, unknown> | null | undefined): bigint {
  const reserved = reservedCash(balances);
  return observed > reserved ? observed - reserved : 0n;
}
/**
 * Account USDT a routing v2 cash swapper top-up may spend (src/strategy-cash-swaps.ts): what no bucket claims, plus the
 * portfolio's own cash (`allocated_cash_raw`: its cash weight and what its sales brought in). The top-up is booked against
 * that bucket when it lands and the cash-out is booked back into it, so the ledger never ends up above the chain balance.
 * Never: funding waiting to be bought, a running job's money, the withdrawal and yield reservations. Wallet cash, Cash
 * Earn and other portfolios live in other accounts and are never part of `observed`.
 */
export function strategySpendableCash(observed: bigint, balances: Record<string, unknown> | null | undefined): bigint {
  if (!balances) return observed;
  const own = balances.allocated_cash_raw;
  if (typeof own !== 'string' || !/^\d+$/.test(own)) throw new Error('invalid cash bucket allocated_cash_raw');
  const others = claimedCash(balances) - BigInt(own);
  return observed > others ? observed - others : 0n;
}
