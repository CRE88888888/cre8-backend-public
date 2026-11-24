import type { Address } from 'viem';
import type { Stable } from './strategy-earn-mainnet.js';
import type { V2AccountRead } from './strategy-earn-v2-chain.js';

/**
 * USDC / USD1 / U <-> USDT for routing v2 (cre8-contracts docs/borrow-routing-v2 §7: "the contracts never swap; the backend
 * sources the old loan token through the normal trade path").
 *
 * Two cases need it:
 * - dust: a close pays the vault's surplus (interest earned above the debt) back to the account in the loan token. For USDT
 *   that is the portfolio's cash; for another token it is a small balance no flow uses — sell it to USDT.
 * - gap: the box's money plus the account's own balance of the loan token is less than a route's debt (a vault that earned
 *   less than the loan cost, e.g. after a spell of negative carry), so the route cannot be closed in full. Buy the missing
 *   amount (+0.5% for the interest until it lands), then close.
 *
 * The trade itself is an ordinary AtpExecutor.executeRebalance step, so it is bound by that contract's rules: selling X
 * needs X to have been an asset of the account's strategy (`wasAssetAllowed`), buying X needs it to be one now
 * (`isAssetAllowed`), and both need the TWAP oracle to price the X/USDT pool. None of the four loan tokens is a strategy
 * asset today, and on chain 97 the simulated USDC / USD1 / U have no pool at all. So this module plans (pure, tested) and
 * reports what cannot be traded and why; `quote` is the hook the trade path plugs into once the stablecoins are tradable.
 */
export type LoanTokenNeed = { symbol: Stable; token: Address; kind: 'dust' | 'gap';
  /** dust: the amount of the token to sell. gap: the amount of the token to buy. */
  amountRaw: bigint; why: string };
/** Dust under this (raw, 18 decimals) is not worth a trade: 1 token. */
export const SWAP_DUST_MIN_RAW = 10n ** 18n;
/** Bought on top of a gap, for the interest that accrues until the repayment lands. */
export const SWAP_GAP_BUFFER_BPS = 50n;

/**
 * What an account needs swapped, from one chain read. `numeraire`: the portfolio's cash token (never swapped).
 * Dust is only counted for a token the account no longer owes (while a route in that token is open its balance is the
 * repayment fallback, `maxCashIn`).
 */
export function loanTokenNeeds(read: Pick<V2AccountRead, 'tokens' | 'routes' | 'vaults'>, numeraire: Address): LoanTokenNeed[] {
  const needs: LoanTokenNeed[] = [];
  for (const [symbol, t] of Object.entries(read.tokens) as [Stable, V2AccountRead['tokens'][string]][]) {
    if (t.token.toLowerCase() === numeraire.toLowerCase()) continue;
    const routes = read.routes.filter(r => r.route.loan === t.token);
    // Venus reports the account's whole debt in the token on each of its routes: count it once, plus every Lista market.
    const owed = (routes.find(r => r.route.venue === 'venus')?.debtRaw ?? 0n) + routes.filter(r => r.route.venue === 'lista').reduce((s, r) => s + r.debtRaw, 0n);
    const box = read.vaults.filter(v => v.vault.token === t.token).reduce((s, v) => s + v.assetsRaw, 0n) + t.idleRaw;
    if (owed === 0n) {
      if (t.cashRaw >= SWAP_DUST_MIN_RAW) needs.push({ symbol, token: t.token, kind: 'dust', amountRaw: t.cashRaw, why: `${symbol} left in the account after its routes closed` });
      continue;
    }
    const have = box + t.cashRaw;
    if (have < owed) {
      const gap = owed - have;
      needs.push({ symbol, token: t.token, kind: 'gap', amountRaw: gap + gap * SWAP_GAP_BUFFER_BPS / 10_000n + 1n, why: `${symbol} debt ${owed} against ${have} in the box and the account` });
    }
  }
  return needs;
}

/** One planned trade for a need, or why there is none. `Step` is whatever the trade path sends (a rebalance SwapStep). */
export type SwapPlan<Step> = { steps: { need: LoanTokenNeed; step: Step }[]; unavailable: { need: LoanTokenNeed; reason: string }[] };
export type SwapQuoter<Step> = {
  /** Sell exactly `amountRaw` of `token` for the numeraire. */
  sell(token: Address, amountRaw: bigint): Promise<Step | { unavailable: string }>;
  /** Buy at least `amountRaw` of `token` with the numeraire. */
  buy(token: Address, amountRaw: bigint): Promise<Step | { unavailable: string }>;
};
/** Gaps first (they unblock a close), then dust. Without a quoter every need is reported as not tradable on this chain. */
export async function planLoanTokenSwaps<Step extends object>(needs: readonly LoanTokenNeed[], quoter: SwapQuoter<Step> | null): Promise<SwapPlan<Step>> {
  const plan: SwapPlan<Step> = { steps: [], unavailable: [] };
  for (const need of [...needs].sort((a, b) => Number(b.kind === 'gap') - Number(a.kind === 'gap'))) {
    if (quoter === null) { plan.unavailable.push({ need, reason: 'no trade path for this token on this chain' }); continue; }
    try {
      const r = need.kind === 'gap' ? await quoter.buy(need.token, need.amountRaw) : await quoter.sell(need.token, need.amountRaw);
      if ('unavailable' in r) plan.unavailable.push({ need, reason: r.unavailable }); else plan.steps.push({ need, step: r });
    } catch (error) { plan.unavailable.push({ need, reason: String((error as Error)?.message ?? error).split('\n')[0]!.slice(0, 120) }); }
  }
  return plan;
}
