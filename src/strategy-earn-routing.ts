import type { RouteOption, RoutingSnapshot, RoutingVault, Stable, Venue } from './strategy-earn-mainnet.js';
import { STABLES } from './strategy-earn-mainnet.js';

/**
 * Routing engine for the yield strategy (docs/strategy-earn-mainnet-routing.zh-TW.md §3). Pure: no I/O, no clock, no config.
 *
 * In: one market snapshot (every borrow option per asset and every supply vault, from strategy-earn-mainnet.ts), one
 * account's holdings and open positions, and the cost of moving. Out: per asset, the route it should be on and what to
 * do about it — open / hold / migrate / reduce / close — with a reason code and a one-line rationale for the scheduler log.
 *
 * Rules:
 * - A route = borrow market (venue + market + loan token) + the supply vault for that same token. No swaps.
 * - New borrowing only at positive carry, into a vault that passes the "realistic" filter.
 * - An open position moves only when ALL of MIGRATE_MIN_GAIN_BPS, MIGRATE_COST_MULTIPLE over MIGRATE_WINDOW_DAYS and
 *   MIN_HOLD_MS hold. Negative carry, a market or vault that is paused / removed / drained, or a vault that cannot pay the
 *   debt back are acted on at once (move if a good route exists, else close) with no hysteresis.
 * - Nothing is decided from stale data: a venue whose source was not read within MAX_SOURCE_AGE_MS is neither a target
 *   nor a reason to leave (the on-chain safety line still protects the position).
 * - Venus is one loan per account: all of an account's Venus collateral backs the same debt, so its Venus positions use
 *   one loan token, switch it together (one move, judged on the group's total), and share one debt ceiling.
 */
export const ROUTING = {
  /** The new route must add at least this much APY on the holding (carry × ratio + collateral incentive), in bps. */
  MIGRATE_MIN_GAIN_BPS: 50,
  /** Extra earnings over this many days ... */
  MIGRATE_WINDOW_DAYS: 30,
  /** ... must be at least this many times the cost of moving. */
  MIGRATE_COST_MULTIPLE: 3,
  /** The current route must have been held this long. */
  MIN_HOLD_MS: 7 * 86_400_000,
  /** Transactions in a full move: repay, withdraw collateral, post collateral, borrow, deposit. */
  MIGRATE_TXS: 5,
  /** Transactions when only the vault changes: withdraw, deposit. */
  VAULT_SWITCH_TXS: 2,
  /** A source older than this is not acted on. */
  MAX_SOURCE_AGE_MS: 30 * 60_000,
  /** Positions that would borrow less than this are not opened. */
  MIN_BORROW_USD: 10,
  /** An open position is topped up only when its debt is more than this far under the target (bps of the target): the
   * executor borrows 2% under the target on purpose, and small price moves are not worth a transaction. */
  TOP_UP_MIN_GAP_BPS: 500,
} as const;

export type RouteKey = { venue: 'venus' | 'lista'; marketId: string; loan: Stable; vault: { venue: Venue; address: string } };
export type PricedRoute = RouteKey & {
  ratioBps: number; factorBps: number;
  /** Base borrow rate and its incentive (LISTA / XVS, paid to the account) are kept apart. */
  borrowApyBps: number; borrowIncentiveBps: number;
  vaultApyBps: number; vaultName: string;
  /** vault APY − (borrow − incentive). */
  carryBps: number;
  collateralIncentiveBps: number;
  /** carry × ratio + collateral incentive: APY on the holding. */
  extraBps: number;
  liquidityUsd: number | null;
  /** USD of new collateral the venue can still take (Venus supply cap); null = no limit known. */
  collateralRoomUsd?: number | null;
};
export type Holding = {
  symbol: string;
  /** USD value of the asset this account holds (posted collateral included). */
  collateralUsd: number;
  /** Owner consent for the yield strategy on this asset. */
  enabled: boolean;
  position: null | {
    route: RouteKey; debtUsd: number;
    /** When the position entered this route (ms). */
    since: number;
    /** On-chain LTV and safety line (bps), when read. */
    ltvBps?: number; deleverageLtvBps?: number;
    /** The venue's own answer (routing v2 lens `shouldDeleverage`: debt value ≥ deleverage value; Venus is account-wide,
     * so one position's LTV cannot be compared with its own line). When given it replaces the LTV comparison. */
    shouldDeleverage?: boolean;
    /** USD of this asset already posted on the route (the rest of `collateralUsd` is free in the account). */
    postedUsd?: number;
  };
};
export type Costs = { /** USD per transaction (gas). */ gasUsdPerTx: number; /** Slippage of a move, bps of the debt moved; 0 for same-token routes. */ slippageBps?: number };
export type Action = 'open' | 'hold' | 'migrate' | 'reduce' | 'close';
export type Reason =
  | 'best_route' | 'top_up' | 'no_route' | 'negative_carry' | 'too_small' | 'stale_data' | 'disabled'
  | 'market_unavailable' | 'vault_unavailable' | 'vault_liquidity' | 'safety_line'
  | 'better_route' | 'venus_loan_switch' | 'gain_below_threshold' | 'cost_not_covered' | 'min_hold';
export type Decision = {
  symbol: string; action: Action; reason: Reason;
  /** Acted on now, outside hysteresis. */
  urgent: boolean;
  from: RouteKey | null;
  /** The route the asset should be on after this decision (null = none). */
  to: PricedRoute | null;
  /** Debt after the action, USD. */
  targetDebtUsd: number;
  /** Hysteresis numbers, when a better route was weighed. */
  gainBps?: number; gain30dUsd?: number; costUsd?: number; heldMs?: number;
  rationale: string;
};
export type AccountPlan = {
  decisions: Decision[];
  /** Venus: the account's single loan token and the total debt planned across its Venus positions (one ceiling for all of them). */
  venus: { loan: Stable; debtUsd: number } | null;
};

const marketKey = (r: { venue: string; marketId: string | null; loan: string }) => `${r.venue}:${String(r.marketId).toLowerCase()}:${r.loan}`;
const vaultKey = (v: { venue: string; address: string }, token: string) => `${v.venue}:${v.address.toLowerCase()}:${token}`;
const sameRoute = (a: RouteKey, b: RouteKey) => marketKey(a) === marketKey(b) && vaultKey(a.vault, a.loan) === vaultKey(b.vault, b.loan);
const pct = (bps: number) => (bps / 100).toFixed(2) + '%';
const usd = (n: number) => '$' + n.toFixed(2);
const label = (r: RouteKey | null) => r ? `${r.venue}/${r.loan}→${r.vault.venue}` : 'none';

function price(o: RouteOption, v: RoutingVault): PricedRoute {
  const carryBps = v.apyBps - (o.borrowApyBps - o.incentiveBps);
  return { venue: o.venue, marketId: String(o.marketId).toLowerCase(), loan: o.loan, vault: { venue: v.venue, address: v.address.toLowerCase() },
    ratioBps: o.ratioBps, factorBps: o.factorBps, borrowApyBps: o.borrowApyBps, borrowIncentiveBps: o.incentiveBps, vaultApyBps: v.apyBps, vaultName: v.name,
    carryBps, collateralIncentiveBps: o.collateralIncentiveBps, extraBps: Math.trunc(carryBps * o.ratioBps / 10_000) + o.collateralIncentiveBps, liquidityUsd: o.liquidityUsd,
    collateralRoomUsd: o.collateralRoomUsd ?? null };
}
/** USD per year a holding earns on a route with `debtUsd` borrowed. */
const yearly = (r: PricedRoute, collateralUsd: number, debtUsd: number) => (debtUsd * r.carryBps + collateralUsd * r.collateralIncentiveBps) / 10_000;

export type Liquidity = Map<string, number>;
/** Remaining borrowable USD per market, shared across the accounts planned in one scheduler round. */
export function liquidityOf(snapshot: RoutingSnapshot): Liquidity {
  const m: Liquidity = new Map();
  for (const list of Object.values(snapshot.options)) for (const o of list) if (o.liquidityUsd !== null) m.set(marketKey(o), o.liquidityUsd);
  return m;
}

export function planAccount(input: { snapshot: RoutingSnapshot; holdings: readonly Holding[]; costs: Costs; now: number; liquidity?: Liquidity }): AccountPlan {
  const { snapshot, costs, now } = input;
  const liquidity = input.liquidity ?? liquidityOf(snapshot);
  const fresh = (venue: Venue) => { const at = snapshot.sourceAt[venue]; return at !== null && now - at <= ROUTING.MAX_SOURCE_AGE_MS; };
  const vaults = new Map(snapshot.vaults.map(v => [vaultKey(v, v.token), v]));
  // Best vault per token that may take new deposits, from fresh sources only.
  const open = snapshot.vaults.filter(v => v.eligible && fresh(v.venue)).sort((a, b) => b.apyBps - a.apyBps);
  const bestVault = (token: Stable, avoid?: string) => open.find(v => v.token === token && vaultKey(v, token) !== avoid);
  const room = (r: { venue: string; marketId: string | null; loan: string }) => liquidity.get(marketKey(r)) ?? Infinity;

  /** Routes this asset could newly borrow on: fresh venue, positive carry. `venusLoan` limits Venus to the account's loan token. */
  const candidates = (symbol: string, venusLoan: Stable | null, avoidVault?: string): PricedRoute[] => (snapshot.options[symbol] ?? [])
    .filter(o => fresh(o.venue) && (o.venue !== 'venus' || o.loan === venusLoan) && bestVault(o.loan, avoidVault))
    .map(o => price(o, bestVault(o.loan, avoidVault)!)).filter(r => r.carryBps > 0);
  /** A position's own route at today's rates; `problem` set when it has to be left at once; `stale` when it cannot be judged.
   * `marketOk`: the borrow market itself still pays with the best vault open to new deposits (so the problem is only the vault). */
  const current = (h: Holding): { route: PricedRoute | null; problem: Reason | null; stale: boolean; marketOk?: boolean } => {
    const p = h.position!;
    if (!fresh(p.route.venue) || !fresh(p.route.vault.venue)) return { route: null, problem: null, stale: true };
    const o = (snapshot.options[h.symbol] ?? []).find(x => marketKey(x) === marketKey(p.route));
    if (!o) return { route: null, problem: 'market_unavailable', stale: false };
    const v = vaults.get(vaultKey(p.route.vault, p.route.loan));
    if (!v) return { route: null, problem: 'vault_unavailable', stale: false };
    const route = price(o, v);
    if (route.carryBps <= 0) { const other = bestVault(p.route.loan); return { route, problem: 'negative_carry', stale: false, marketOk: other !== undefined && price(o, other).carryBps > 0 }; }
    if (v.liquidityUsd !== undefined && v.liquidityUsd !== null && v.liquidityUsd < p.debtUsd) return { route, problem: 'vault_liquidity', stale: false };
    return { route, problem: null, stale: false };
  };
  const targetDebt = (h: Holding, r: PricedRoute) => h.collateralUsd * r.ratioBps / 10_000;
  /** Best route for this holding. `needFull`: the market must be able to lend the whole target (a move); otherwise whatever fits. */
  const best = (h: Holding, venusLoan: Stable | null, needFull: boolean, own?: RouteKey, avoidVault?: string): { route: PricedRoute; debtUsd: number; perYear: number } | null => {
    let top: { route: PricedRoute; debtUsd: number; perYear: number } | null = null;
    for (const r of candidates(h.symbol, venusLoan, avoidVault)) {
      const want = targetDebt(h, r);
      // Debt already borrowed on this same market does not need new room.
      const have = own && marketKey(own) === marketKey(r) ? h.position?.debtUsd ?? 0 : 0;
      const fits = Math.min(want, have + room(r));
      if (needFull && fits < want) continue;
      // A venue with a supply cap (Venus bStock markets) can only take what is left under it. What this holding already
      // posted on the same venue and collateral market is inside the cap.
      const posted = own && own.venue === r.venue ? h.position?.postedUsd ?? h.collateralUsd : 0;
      if (r.collateralRoomUsd !== null && r.collateralRoomUsd !== undefined && h.collateralUsd - posted > r.collateralRoomUsd) continue;
      const perYear = yearly(r, h.collateralUsd, fits);
      if (!top || perYear > top.perYear) top = { route: r, debtUsd: fits, perYear };
    }
    return top;
  };

  // ---- Venus: one loan token per account ----
  const venusHeld = input.holdings.filter(h => h.position?.route.venue === 'venus');
  const venusNow: Stable | null = venusHeld[0]?.position!.route.loan ?? null;
  const groupScore = (loan: Stable | null) => input.holdings.filter(h => h.enabled && h.collateralUsd > 0)
    .reduce((sum, h) => sum + (best(h, loan, false, h.position?.route)?.perYear ?? 0), 0);
  const bestVenusLoan = (): Stable | null => {
    let pick: Stable | null = null, score = groupScore(null);
    for (const t of STABLES) { const s = groupScore(t); if (s > score) { score = s; pick = t; } }
    return pick;
  };
  let venusLoan: Stable | null = venusNow, venusSwitch: { reason: Reason; urgent: boolean; note: string; numbers?: Pick<Decision, 'gainBps' | 'gain30dUsd' | 'costUsd'> } | null = null;
  if (venusNow === null) venusLoan = bestVenusLoan();
  else if (fresh('venus')) {
    const states = venusHeld.map(h => current(h));
    // The shared loan itself is the problem when no Venus position can stay on it; a single delisted collateral is handled per asset.
    // A position whose own vault stopped paying while the same loan still pays into another vault is not that: it only changes vault.
    const broken = states.every(s => s.problem === 'market_unavailable' || s.problem === 'negative_carry' && !s.marketOk) ? states[0] : undefined;
    const wanted = bestVenusLoan();
    if (broken) {
      // Every Venus position leaves this loan token now.
      const others = STABLES.filter(t => t !== venusNow);
      let pick: Stable | null = null, score = groupScore(null);
      for (const t of others) { const s = groupScore(t); if (s > score) { score = s; pick = t; } }
      venusLoan = pick; venusSwitch = { reason: broken.problem!, urgent: true, note: `venus ${venusNow} ${broken.problem}` };
    } else if (wanted !== null && wanted !== venusNow && !states.some(s => s.stale || s.problem)) {
      // A better loan token for the whole group: one move, judged on the group's total.
      const collateral = venusHeld.reduce((s, h) => s + h.collateralUsd, 0), debt = venusHeld.reduce((s, h) => s + h.position!.debtUsd, 0);
      const gainYear = groupScore(wanted) - groupScore(venusNow);
      const gainBps = collateral > 0 ? gainYear / collateral * 10_000 : 0, gain30 = gainYear * ROUTING.MIGRATE_WINDOW_DAYS / 365;
      const cost = costs.gasUsdPerTx * ROUTING.MIGRATE_TXS + debt * (costs.slippageBps ?? 0) / 10_000;
      const held = now - Math.max(...venusHeld.map(h => h.position!.since));
      if (gainBps >= ROUTING.MIGRATE_MIN_GAIN_BPS && gain30 >= ROUTING.MIGRATE_COST_MULTIPLE * cost && held >= ROUTING.MIN_HOLD_MS) {
        venusLoan = wanted; venusSwitch = { reason: 'venus_loan_switch', urgent: false, note: `venus ${venusNow}→${wanted} group +${pct(gainBps)}, 30d +${usd(gain30)} ≥ ${ROUTING.MIGRATE_COST_MULTIPLE}×${usd(cost)}`,
          numbers: { gainBps, gain30dUsd: gain30, costUsd: cost } };
      }
    }
  }

  // ---- Per asset ----
  const take = (r: PricedRoute, debtUsd: number, already: number) => { const k = marketKey(r); if (liquidity.has(k)) liquidity.set(k, Math.max(0, liquidity.get(k)! - Math.max(0, debtUsd - already))); };
  const decisions: Decision[] = [];
  const order = [...input.holdings].sort((a, b) => Number(!!b.position) - Number(!!a.position) || b.collateralUsd - a.collateralUsd);
  for (const h of order) {
    const p = h.position;
    const base = { symbol: h.symbol, from: p?.route ?? null };
    if (!p) {
      if (!h.enabled || h.collateralUsd <= 0) continue;
      const b = best(h, venusLoan, false);
      if (!b) {
        const any = (snapshot.options[h.symbol] ?? []).length > 0;
        const reason: Reason = !any ? 'no_route' : (snapshot.options[h.symbol] ?? []).every(o => !fresh(o.venue)) ? 'stale_data' : 'negative_carry';
        decisions.push({ ...base, action: 'hold', reason, urgent: false, to: null, targetDebtUsd: 0, rationale: `${h.symbol} hold: ${reason}, nothing borrowed` });
      } else if (b.debtUsd < ROUTING.MIN_BORROW_USD) {
        decisions.push({ ...base, action: 'hold', reason: 'too_small', urgent: false, to: null, targetDebtUsd: 0, rationale: `${h.symbol} hold: would borrow ${usd(b.debtUsd)} < ${usd(ROUTING.MIN_BORROW_USD)}` });
      } else {
        take(b.route, b.debtUsd, 0);
        decisions.push({ ...base, action: 'open', reason: 'best_route', urgent: false, to: b.route, targetDebtUsd: b.debtUsd,
          rationale: `${h.symbol} open ${label(b.route)}: borrow ${pct(b.route.borrowApyBps)} − incentive ${pct(b.route.borrowIncentiveBps)}, vault ${pct(b.route.vaultApyBps)}, ratio ${pct(b.route.ratioBps)}, extra ${pct(b.route.extraBps)}, debt ${usd(b.debtUsd)}` });
      }
      continue;
    }
    if (!h.enabled) {
      decisions.push({ ...base, action: 'close', reason: 'disabled', urgent: true, to: null, targetDebtUsd: 0, rationale: `${h.symbol} close ${label(p.route)}: strategy turned off` });
      continue;
    }
    const cur = current(h);
    if (cur.stale) {
      decisions.push({ ...base, action: 'hold', reason: 'stale_data', urgent: false, to: null, targetDebtUsd: p.debtUsd, rationale: `${h.symbol} hold ${label(p.route)}: market data older than ${ROUTING.MAX_SOURCE_AGE_MS / 60_000} min, not acting on it` });
      continue;
    }
    const forced = p.route.venue === 'venus' && venusSwitch !== null && venusLoan !== p.route.loan ? venusSwitch : null;
    const problem: Reason | null = cur.problem ?? (forced?.urgent ? forced.reason : null);
    if (problem || forced) {
      // Leave now: the best route that can take the whole debt, else close. A planned group switch takes what fits.
      const reason = problem ?? forced!.reason, urgent = problem !== null;
      const badVault = cur.problem === 'vault_liquidity' || cur.problem === 'vault_unavailable' ? vaultKey(p.route.vault, p.route.loan) : undefined;
      const b = best(h, venusLoan, urgent, p.route, badVault);
      if (b && !sameRoute(b.route, p.route)) {
        take(b.route, b.debtUsd, marketKey(b.route) === marketKey(p.route) ? p.debtUsd : 0);
        decisions.push({ ...base, ...forced?.numbers, action: 'migrate', reason, urgent, to: b.route, targetDebtUsd: b.debtUsd, heldMs: now - p.since,
          rationale: `${h.symbol} migrate ${label(p.route)} → ${label(b.route)}: ${forced ? forced.note : reason}${urgent ? ', acting now' : ''}; new extra ${pct(b.route.extraBps)}` });
      } else {
        decisions.push({ ...base, action: 'close', reason, urgent: true, to: null, targetDebtUsd: 0, heldMs: now - p.since,
          rationale: `${h.symbol} close ${label(p.route)}: ${forced ? forced.note : reason}, no route with positive carry and room for ${usd(p.debtUsd)}` });
      }
      continue;
    }
    const route = cur.route!;
    if (p.shouldDeleverage ?? (p.ltvBps !== undefined && p.deleverageLtvBps !== undefined && p.ltvBps >= p.deleverageLtvBps)) {
      const to = Math.min(p.debtUsd, targetDebt(h, route));
      decisions.push({ ...base, action: 'reduce', reason: 'safety_line', urgent: true, to: route, targetDebtUsd: to,
        rationale: `${h.symbol} reduce ${label(p.route)}: ${p.ltvBps !== undefined && p.deleverageLtvBps !== undefined ? `LTV ${pct(p.ltvBps)} vs safety line ${pct(p.deleverageLtvBps)}` : 'at the safety line'}, repay to ${usd(to)}` });
      continue;
    }
    const b = best(h, venusLoan, true, p.route);
    // What this route earns once topped up to its own target (a fill since the last borrow), so a move is not credited for that.
    const ownDebt = Math.max(p.debtUsd, Math.min(targetDebt(h, route), p.debtUsd + room(route)));
    const nowYear = yearly(route, h.collateralUsd, ownDebt);
    const stay = (reason: Reason, why: string, numbers: Partial<Decision> = {}) => {
      if (ownDebt - p.debtUsd >= Math.max(ROUTING.MIN_BORROW_USD, targetDebt(h, route) * ROUTING.TOP_UP_MIN_GAP_BPS / 10_000)) {
        take(route, ownDebt, p.debtUsd);
        decisions.push({ ...base, ...numbers, action: 'open', reason: 'top_up', urgent: false, to: route, targetDebtUsd: ownDebt,
          rationale: `${h.symbol} open ${label(p.route)}: top up debt ${usd(p.debtUsd)} → ${usd(ownDebt)} at ratio ${pct(route.ratioBps)}; ${why}` });
      } else decisions.push({ ...base, ...numbers, action: 'hold', reason, urgent: false, to: route, targetDebtUsd: p.debtUsd, rationale: `${h.symbol} hold ${label(p.route)}: ${why}` });
    };
    if (!b || sameRoute(b.route, p.route) || b.perYear <= nowYear) { stay('best_route', `extra ${pct(route.extraBps)}, no better route`); continue; }
    const vaultOnly = marketKey(b.route) === marketKey(p.route);
    const gainYear = b.perYear - nowYear, gainBps = h.collateralUsd > 0 ? gainYear / h.collateralUsd * 10_000 : 0;
    const gain30dUsd = gainYear * ROUTING.MIGRATE_WINDOW_DAYS / 365;
    const costUsd = costs.gasUsdPerTx * (vaultOnly ? ROUTING.VAULT_SWITCH_TXS : ROUTING.MIGRATE_TXS) + p.debtUsd * (costs.slippageBps ?? 0) / 10_000;
    const heldMs = now - p.since;
    const fail: Reason | null = gainBps < ROUTING.MIGRATE_MIN_GAIN_BPS ? 'gain_below_threshold'
      : gain30dUsd < ROUTING.MIGRATE_COST_MULTIPLE * costUsd ? 'cost_not_covered' : heldMs < ROUTING.MIN_HOLD_MS ? 'min_hold' : null;
    const numbers = `+${pct(gainBps)} (need ${pct(ROUTING.MIGRATE_MIN_GAIN_BPS)}), ${ROUTING.MIGRATE_WINDOW_DAYS}d +${usd(gain30dUsd)} vs ${ROUTING.MIGRATE_COST_MULTIPLE}×${usd(costUsd)}, held ${(heldMs / 86_400_000).toFixed(1)}d (need ${ROUTING.MIN_HOLD_MS / 86_400_000}d)`;
    if (fail) stay(fail, `${label(b.route)} is ${numbers} → ${fail}`, { gainBps, gain30dUsd, costUsd, heldMs });
    else {
      take(b.route, b.debtUsd, vaultOnly ? p.debtUsd : 0);
      decisions.push({ ...base, action: 'migrate', reason: 'better_route', urgent: false, to: b.route, targetDebtUsd: b.debtUsd, gainBps, gain30dUsd, costUsd, heldMs,
        rationale: `${h.symbol} migrate ${label(p.route)} → ${label(b.route)}: ${numbers}` });
    }
  }
  const onVenus = decisions.filter(d => d.to?.venue === 'venus' && d.action !== 'close');
  const loan = onVenus[0]?.to?.loan ?? null;
  return { decisions, venus: loan ? { loan, debtUsd: onVenus.reduce((s, d) => s + d.targetDebtUsd, 0) } : null };
}
