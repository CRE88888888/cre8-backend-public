import type { Address, Hex } from 'viem';
import type { PortfolioPlan } from './snapshot.js';
import type { PlannedStep } from './rebalance-plan.js';
import { fresh, raw, unavailable } from './yield-domain.js';
import type { YieldPosition } from './yield-domain.js';

export function yieldRebalanceDue(mode: unknown, last: Date | null, delta: number | null, now: Date): boolean {
  if ((mode === 'monthly' || mode === 'monthly_drift') && last !== null &&
    (last.getUTCFullYear() !== now.getUTCFullYear() || last.getUTCMonth() !== now.getUTCMonth())) return true;
  return (mode === 'drift' || mode === 'monthly_drift') && (delta === null || delta > 500);
}

export type RebalanceWithdrawal = { marketId: Hex; amount: bigint; blocked: boolean };

/** Only the shortfall in this rebalance's inputs is redeemable. Receipt claims never become spendable holdings. */
export function rebalanceWithdrawals(plan: PortfolioPlan, positions: readonly YieldPosition[], steps: readonly PlannedStep[],
  cash: Address, reserve: bigint, now: Date): RebalanceWithdrawal[] {
  if (!plan.report || plan.blocked.length || reserve < 0n) throw unavailable('rebalance-plan-blocked');
  const balances = new Map(plan.snapshot.holdings.map(h => [h.asset.toLowerCase(), h.amountWei]));
  balances.set(cash, (balances.get(cash) ?? 0n) - reserve);
  const deficits = new Map<string,bigint>();
  for (const step of steps) {
    const asset = step.tokenIn.toLowerCase(), output = step.tokenOut.toLowerCase();
    const shortfall = step.amountIn - (balances.get(asset) ?? 0n);
    if (shortfall > 0n) deficits.set(asset, (deficits.get(asset) ?? 0n) + shortfall);
    balances.set(asset, shortfall > 0n ? 0n : -shortfall);
    // Existing minGross / floor checks guarantee at least oracleFloor after proportional fees.
    balances.set(output, (balances.get(output) ?? 0n) + step.oracleFloor);
  }
  const result: RebalanceWithdrawal[] = [];
  for (const [asset, needed] of deficits) {
    let shortfall = needed;
    const markets = positions.filter(p => p.market.asset === asset).sort((a,b) => a.market.marketId.localeCompare(b.market.marketId));
    for (const p of markets) {
      if (p.state !== 'known' || p.block !== plan.snapshot.block || !fresh(p.at, now) ||
        p.receipt === null || p.claim === null || p.rate === null || p.rate <= 0n || p.scale === null || p.scale <= 0n ||
        p.maxRedeem === null || p.maxWithdraw === null || p.observedUnits === null || p.trackedUnits !== p.observedUnits)
        throw unavailable(p.state !== 'known' ? `rebalance-position-unknown:${p.market.id}` : p.block !== plan.snapshot.block ? `rebalance-position-block:${p.block}/plan:${plan.snapshot.block}`
          : !fresh(p.at, now) ? `rebalance-position-stale:${p.market.id}:age-${now.getTime() - p.at.getTime()}ms` : `rebalance-position-incomplete:${p.market.id}`);
      if (p.receipt === 0n) continue;
      const wanted = p.market.protocol === 'aave_v3' ? shortfall : (shortfall * p.scale + p.rate - 1n) / p.rate;
      const shares = wanted < p.receipt ? wanted : p.receipt;
      const amount = p.maxRedeem < shares ? p.maxRedeem : shares;
      result.push({marketId:p.market.marketId,amount:raw(amount),blocked:p.withdrawPaused === true || amount === 0n});
      const redeemed = p.market.protocol === 'aave_v3' ? amount : amount * p.rate / p.scale;
      shortfall -= redeemed;
      if (shortfall <= 0n) break;
    }
    // Never sell a smaller portion while another required market is still illiquid / unknown.
    if (shortfall > 0n && !result.some(r => markets.some(p => p.market.marketId === r.marketId))) throw unavailable(`rebalance-shortfall:${asset}`);
  }
  return result;
}
