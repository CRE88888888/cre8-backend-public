import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RouteOption, RoutingSnapshot, RoutingVault, Stable } from '../src/strategy-earn-mainnet.js';
import { liquidityOf, minOpenValueUsd, planAccount, ROUTING } from '../src/strategy-earn-routing.js';
import type { Holding, RouteKey } from '../src/strategy-earn-routing.js';

const DAY = 86_400_000, NOW = 100 * DAY;
const vault = (token: Stable, venue: 'venus' | 'lista' | 'aave', apyBps: number, extra: Partial<RoutingVault> = {}): RoutingVault =>
  ({ token, venue, name: `${venue} ${token}`, address: `0x${venue}${token}`.toLowerCase(), apyBps, baseBps: apyBps, incentiveBps: 0, tvlUsd: 5e6, eligible: true, ...extra });
/** A borrow option. The engine prices it against the snapshot's vaults itself; `vault` / `carryBps` / `extraBps` here are not read. */
const opt = (venue: 'venus' | 'lista', loan: Stable, borrowApyBps: number, o: Partial<RouteOption> = {}): RouteOption =>
  ({ protocol: venue, venue, loan, marketId: `${venue}-${loan}`, ratioBps: 3000, factorBps: 7500, lltvBps: 7500, borrowApyBps, incentiveBps: 0, netBorrowBps: borrowApyBps,
    liquidityUsd: 1_000_000, limited: false, vault: vault(loan, 'venus', 0), carryBps: 0, extraBps: 0, collateralIncentiveBps: 0, ...o });
const snap = (options: Record<string, RouteOption[]>, vaults: RoutingVault[], at = NOW): RoutingSnapshot =>
  ({ at, sourceAt: { venus: at, lista: at, aave: at }, options, vaults });
const key = (venue: 'venus' | 'lista', loan: Stable, vaultVenue: 'venus' | 'lista' | 'aave' = 'venus', marketId = `${venue}-${loan}`): RouteKey =>
  ({ venue, marketId, loan, vault: { venue: vaultVenue, address: `0x${vaultVenue}${loan}`.toLowerCase() } });
const held = (symbol: string, collateralUsd: number, route: RouteKey, debtUsd: number, sinceDays: number, extra: Partial<NonNullable<Holding['position']>> = {}): Holding =>
  ({ symbol, collateralUsd, enabled: true, position: { route, debtUsd, since: NOW - sinceDays * DAY, ...extra } });
const idle = (symbol: string, collateralUsd: number): Holding => ({ symbol, collateralUsd, enabled: true, position: null });
const costs: { gasUsdPerTx: number; slippageBps?: number } = { gasUsdPerTx: 0.05 };
const one = (s: RoutingSnapshot, h: Holding, c = costs, now = NOW) => planAccount({ snapshot: s, holdings: [h], costs: c, now }).decisions[0]!;

test('thresholds are the decided ones, in one place', () => {
  assert.deepEqual([ROUTING.MIGRATE_MIN_GAIN_BPS, ROUTING.MIGRATE_WINDOW_DAYS, ROUTING.MIGRATE_COST_MULTIPLE, ROUTING.MIN_HOLD_MS, ROUTING.MIGRATE_TXS], [50, 30, 3, 7 * DAY, 5]);
});

test('open: best route by what it earns; borrow cost and incentive stay separate; same token in and out', () => {
  // USDT: vault 5.00 − (4.00 − 0) = 1.00 carry. USDC on Lista: vault 4.95 − (1.17 − 0.54) = 4.32 carry.
  const s = snap({ QQQB: [opt('venus', 'USDT', 400), opt('lista', 'USDC', 117, { incentiveBps: 54, ratioBps: 3500 })] }, [vault('USDT', 'venus', 500), vault('USDC', 'lista', 495), vault('USDC', 'aave', 326)]);
  const d = one(s, idle('QQQB', 10_000));
  assert.deepEqual([d.action, d.reason, d.to?.venue, d.to?.loan, d.to?.vault.venue, d.to?.borrowApyBps, d.to?.borrowIncentiveBps, d.to?.carryBps, d.to?.extraBps, d.targetDebtUsd],
    ['open', 'best_route', 'lista', 'USDC', 'lista', 117, 54, 432, 151, 3500]);
  assert.match(d.rationale, /^QQQB open lista\/USDC→lista: borrow 1\.17% − incentive 0\.54%, vault 4\.95%, ratio 35\.00%, extra 1\.51%/);
});

test('never borrow at negative carry; no market -> no route; vaults that fail the realistic filter take no new money', () => {
  const s = snap({ NVDAB: [opt('venus', 'USDT', 515)], AAPLB: [] }, [vault('USDT', 'venus', 352), vault('USDT', 'lista', 1237, { eligible: false })]);
  const plan = planAccount({ snapshot: s, holdings: [idle('NVDAB', 5000), idle('AAPLB', 5000), { ...idle('TSLAB', 5000), enabled: false }], costs, now: NOW });
  assert.deepEqual(plan.decisions.map(d => [d.symbol, d.action, d.reason, d.targetDebtUsd]), [['NVDAB', 'hold', 'negative_carry', 0], ['AAPLB', 'hold', 'no_route', 0]]);
  assert.equal(plan.venus, null);
});

test('hysteresis: all three conditions must hold to move', () => {
  const vaults = [vault('USDT', 'venus', 500), vault('USDC', 'lista', 500)];
  const cur = key('lista', 'USDT');
  // current carry 1.00% × 30% = 0.30% extra on $10k. Candidate USDC borrow rate decides the gain.
  const s = (usdcBorrow: number) => snap({ QQQB: [opt('lista', 'USDT', 400), opt('lista', 'USDC', usdcBorrow)] }, vaults);
  // gain = (carry 2.60% − 1.00%) × 30% = 0.48% < 0.50%
  let d = one(s(240), held('QQQB', 10_000, cur, 3000, 30));
  assert.deepEqual([d.action, d.reason], ['hold', 'gain_below_threshold']);
  // gain = (2.70% − 1.00%) × 30% = 0.51% ≥ 0.50%; 30d = $51 × 30/365 = $4.19 ≥ 3 × $0.25; held 30d -> move
  d = one(s(230), held('QQQB', 10_000, cur, 3000, 30));
  assert.deepEqual([d.action, d.reason, d.urgent, d.to?.loan, d.targetDebtUsd, Math.round(d.gainBps!)], ['migrate', 'better_route', false, 'USDC', 3000, 51]);
  assert.match(d.rationale, /QQQB migrate lista\/USDT→venus → lista\/USDC→lista: \+0\.51% \(need 0\.50%\), 30d \+\$4\.19 vs 3×\$0\.25, held 30\.0d \(need 7d\)/);
  // same rates, held 6.9 days -> stay
  d = one(s(230), held('QQQB', 10_000, cur, 3000, 6.9));
  assert.deepEqual([d.action, d.reason], ['hold', 'min_hold']);
  // same rates, held long enough, but the move costs too much: 30d gain $4.19 < 3 × (5 × $0.30)
  d = one(s(230), held('QQQB', 10_000, cur, 3000, 30), { gasUsdPerTx: 0.30 });
  assert.deepEqual([d.action, d.reason, d.costUsd], ['hold', 'cost_not_covered', 1.5]);
  // a small position never covers the cost even with a big gain: $100 × 3% × 30/365 = $0.25 < $0.75
  d = one(snap({ QQQB: [opt('lista', 'USDT', 400), opt('lista', 'USDC', 0, { incentiveBps: 600 })] }, vaults), held('QQQB', 100, cur, 30, 30));
  assert.deepEqual([d.action, d.reason], ['hold', 'cost_not_covered']);
  // slippage counts as cost: 20 bps of $3000 debt = $6 -> $4.19 < 3 × $6.25
  d = one(s(230), held('QQQB', 10_000, cur, 3000, 30), { gasUsdPerTx: 0.05, slippageBps: 20 });
  assert.deepEqual([d.action, d.reason, d.costUsd], ['hold', 'cost_not_covered', 6.25]);
});

test('only the vault changes: a 2-transaction move, same thresholds', () => {
  const s = snap({ QQQB: [opt('lista', 'USDT', 200)] }, [vault('USDT', 'venus', 400), vault('USDT', 'lista', 600)]);
  const d = one(s, held('QQQB', 10_000, key('lista', 'USDT', 'venus'), 3000, 8));
  assert.deepEqual([d.action, d.reason, d.to?.vault.venue, d.costUsd], ['migrate', 'better_route', 'lista', 2 * 0.05]);
});

test('flapping rates: the position does not chase them (at most one move per 7 days)', () => {
  const vaults = [vault('USDT', 'venus', 500), vault('USDC', 'lista', 500)];
  let route = key('lista', 'USDT'), since = NOW, moves = 0;
  // Every 10-minute round for 21 days the two markets swap which one is 3% cheaper.
  for (let i = 0; i < 21 * 144; i++) {
    const now = NOW + i * 600_000, flip = i % 2 === 0;
    const s = snap({ QQQB: [opt('lista', 'USDT', flip ? 400 : 100), opt('lista', 'USDC', flip ? 100 : 400)] }, vaults, now);
    const d = planAccount({ snapshot: s, holdings: [{ symbol: 'QQQB', collateralUsd: 50_000, enabled: true, position: { route, debtUsd: 15_000, since } }], costs, now }).decisions[0]!;
    assert.ok(d.action === 'hold' || d.action === 'migrate');
    if (d.action === 'migrate') { assert.ok(now - since >= ROUTING.MIN_HOLD_MS); route = d.to!; since = now; moves++; }
  }
  assert.equal(moves, 2); // day 7 and day 14; the round on day 21 is outside the loop
});

test('property: across random snapshots, a non-urgent move always satisfies all three conditions and nothing opens at carry ≤ 0', () => {
  let seed = 42; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
  const loans: Stable[] = ['USDT', 'USDC', 'USD1', 'U'];
  for (let i = 0; i < 2000; i++) {
    const vaults = loans.flatMap(t => [vault(t, 'venus', Math.round(rnd() * 600)), vault(t, 'lista', Math.round(rnd() * 600), { eligible: rnd() > 0.2 })]);
    const options = loans.flatMap(t => [opt('lista', t, Math.round(rnd() * 600), { incentiveBps: Math.round(rnd() * 200), liquidityUsd: Math.round(rnd() * 20_000) + 1000, ratioBps: 2000 + Math.round(rnd() * 1500) }),
      ...(rnd() > 0.5 ? [opt('venus', t, Math.round(rnd() * 600), { collateralIncentiveBps: 25 })] : [])]).filter(() => rnd() > 0.15);
    const collateralUsd = 50 + rnd() * 20_000, debtUsd = collateralUsd * 0.25, sinceDays = rnd() * 14;
    const cur = key(rnd() > 0.5 ? 'lista' : 'venus', loans[Math.floor(rnd() * 4)]!, rnd() > 0.5 ? 'venus' : 'lista');
    const h: Holding = rnd() > 0.3 ? held('X', collateralUsd, cur, debtUsd, sinceDays) : idle('X', collateralUsd);
    const c = { gasUsdPerTx: rnd() * 0.3 };
    const plan = planAccount({ snapshot: snap({ X: options }, vaults), holdings: [h], costs: c, now: NOW });
    for (const d of plan.decisions) {
      assert.ok(d.rationale.startsWith('X '));
      if (d.action === 'open' || d.action === 'migrate') { assert.ok(d.to!.carryBps > 0, 'never borrow at carry ≤ 0'); assert.ok(d.targetDebtUsd <= collateralUsd * d.to!.ratioBps / 10_000 + 1e-9); }
      if (d.action === 'migrate' && !d.urgent) {
        assert.ok(d.gainBps! >= ROUTING.MIGRATE_MIN_GAIN_BPS && d.gain30dUsd! >= ROUTING.MIGRATE_COST_MULTIPLE * d.costUsd! && d.heldMs! >= ROUTING.MIN_HOLD_MS, d.rationale);
      }
      if (d.action === 'close') assert.equal(d.targetDebtUsd, 0);
    }
  }
});

test('negative carry on the current route: move at once when a good route exists (no 7-day wait), else close', () => {
  const vaults = [vault('USDT', 'venus', 300), vault('USDC', 'lista', 500)];
  const cur = key('lista', 'USDT');
  let d = one(snap({ QQQB: [opt('lista', 'USDT', 450), opt('lista', 'USDC', 480)] }, vaults), held('QQQB', 10_000, cur, 3000, 1));
  assert.deepEqual([d.action, d.reason, d.urgent, d.to?.loan], ['migrate', 'negative_carry', true, 'USDC']); // +0.20% carry only, held 1 day: still moves
  d = one(snap({ QQQB: [opt('lista', 'USDT', 450), opt('lista', 'USDC', 520)] }, vaults), held('QQQB', 10_000, cur, 3000, 1));
  assert.deepEqual([d.action, d.reason, d.urgent, d.to, d.targetDebtUsd], ['close', 'negative_carry', true, null, 0]);
  // carry exactly 0 is not worth a loan either
  d = one(snap({ QQQB: [opt('lista', 'USDT', 300)] }, vaults), held('QQQB', 10_000, cur, 3000, 1));
  assert.deepEqual([d.action, d.reason], ['close', 'negative_carry']);
});

test('market paused / removed / drained: the option is gone from discovery -> move or close at once', () => {
  const vaults = [vault('USDT', 'venus', 500), vault('USDC', 'lista', 500)];
  const h = held('QQQB', 10_000, key('lista', 'USDT'), 3000, 2);
  let d = one(snap({ QQQB: [opt('lista', 'USDC', 300)] }, vaults), h);
  assert.deepEqual([d.action, d.reason, d.urgent, d.to?.loan], ['migrate', 'market_unavailable', true, 'USDC']);
  d = one(snap({ QQQB: [] }, vaults), h);
  assert.deepEqual([d.action, d.reason, d.urgent], ['close', 'market_unavailable', true]);
  d = one(snap({}, vaults), h);
  assert.deepEqual([d.action, d.reason], ['close', 'market_unavailable']);
});

test('liquidity dry-up: a move needs room for the whole debt; an open takes what fits; rounds share the remaining room', () => {
  const vaults = [vault('USDT', 'venus', 500), vault('USDC', 'lista', 500)];
  // Urgent exit, but the only other market can lend $2,000 of the $3,000 needed -> close rather than half-move.
  let d = one(snap({ QQQB: [opt('lista', 'USDC', 100, { liquidityUsd: 2000 })] }, vaults), held('QQQB', 10_000, key('lista', 'USDT'), 3000, 2));
  assert.deepEqual([d.action, d.reason], ['close', 'market_unavailable']);
  // Not urgent: a much better market without room is not a reason to move.
  d = one(snap({ QQQB: [opt('lista', 'USDT', 400), opt('lista', 'USDC', 0, { liquidityUsd: 2000 })] }, vaults), held('QQQB', 10_000, key('lista', 'USDT'), 3000, 30));
  assert.deepEqual([d.action, d.reason], ['hold', 'best_route']);
  // Vault cannot pay the debt back: leave now.
  d = one(snap({ QQQB: [opt('lista', 'USDT', 100), opt('lista', 'USDC', 100)] }, [vault('USDT', 'venus', 500, { liquidityUsd: 1200 }), vault('USDC', 'lista', 400)]), held('QQQB', 10_000, key('lista', 'USDT'), 3000, 1));
  assert.deepEqual([d.action, d.reason, d.urgent, d.to?.loan], ['migrate', 'vault_liquidity', true, 'USDC']);
  // Opening: two accounts in one round share a $4,000 market; the second gets the rest, the third nothing worth opening.
  const s = snap({ QQQB: [opt('lista', 'USDC', 100, { liquidityUsd: 4000 })] }, vaults), liquidity = liquidityOf(s);
  const open = () => planAccount({ snapshot: s, holdings: [idle('QQQB', 10_000)], costs, now: NOW, liquidity }).decisions[0]!;
  assert.deepEqual([open(), open(), open()].map(x => [x.action, x.reason, x.targetDebtUsd]), [['open', 'best_route', 3000], ['open', 'best_route', 1000], ['hold', 'too_small', 0]]);
  // A bigger market at a lower carry beats a tiny one at a higher carry: $3,000 × 2% > $1,000 × 4%.
  d = one(snap({ QQQB: [opt('lista', 'USDC', 100, { liquidityUsd: 1000 }), opt('lista', 'USDT', 300)] }, vaults), idle('QQQB', 10_000));
  assert.deepEqual([d.to?.loan, d.targetDebtUsd], ['USDT', 3000]);
});

test('stale data is never acted on: no exit, no move, no open on a source older than 30 minutes', () => {
  const vaults = [vault('USDT', 'venus', 500), vault('USDC', 'lista', 500)];
  const s: RoutingSnapshot = { ...snap({ QQQB: [opt('lista', 'USDC', 100)] }, vaults), sourceAt: { venus: NOW, lista: NOW - 31 * 60_000, aave: null } };
  // The position's Lista market is "missing", but Lista was not read: hold, do not close.
  let d = one(s, held('QQQB', 10_000, key('lista', 'USDT'), 3000, 30));
  assert.deepEqual([d.action, d.reason, d.targetDebtUsd], ['hold', 'stale_data', 3000]);
  d = one(s, idle('QQQB', 10_000));
  assert.deepEqual([d.action, d.reason], ['hold', 'stale_data']);
  // A position on a fresh venue does not move into a stale one.
  const s2: RoutingSnapshot = { ...snap({ NVDAB: [opt('venus', 'USDT', 400), opt('lista', 'USDC', 0)] }, vaults), sourceAt: { venus: NOW, lista: NOW - 31 * 60_000, aave: NOW } };
  d = one(s2, held('NVDAB', 10_000, key('venus', 'USDT'), 3000, 30));
  assert.deepEqual([d.action, d.reason], ['hold', 'best_route']);
});

test('safety line: reduce to the target ratio; a fill since the last borrow tops the same route up; turned off -> close', () => {
  const s = snap({ QQQB: [opt('lista', 'USDT', 200)] }, [vault('USDT', 'venus', 500)]);
  let d = one(s, held('QQQB', 6000, key('lista', 'USDT'), 3000, 3, { ltvBps: 5000, deleverageLtvBps: 5000 }));
  assert.deepEqual([d.action, d.reason, d.urgent, d.targetDebtUsd], ['reduce', 'safety_line', true, 1800]);
  d = one(s, held('QQQB', 20_000, key('lista', 'USDT'), 3000, 3, { ltvBps: 1500, deleverageLtvBps: 5000 }));
  assert.deepEqual([d.action, d.reason, d.targetDebtUsd, d.to?.loan], ['open', 'top_up', 6000, 'USDT']);
  // 2% under the target is where the executor leaves it on purpose: no top-up for that, nor for a small price move.
  d = one(s, held('QQQB', 10_000, key('lista', 'USDT'), 2940, 3));
  assert.deepEqual([d.action, d.reason, d.targetDebtUsd], ['hold', 'best_route', 2940]);
  d = one(s, held('QQQB', 10_000, key('lista', 'USDT'), 2840, 3));
  assert.deepEqual([d.action, d.reason, d.targetDebtUsd], ['open', 'top_up', 3000]);
  d = one(s, { ...held('QQQB', 10_000, key('lista', 'USDT'), 3000, 3), enabled: false });
  assert.deepEqual([d.action, d.reason, d.targetDebtUsd], ['close', 'disabled', 0]);
});

test('Venus shared debt: one loan token per account, chosen on the group total, one debt figure for every Venus market', () => {
  // NVDAB alone would prefer USDC (carry 2.0 vs 1.5), TSLAB is 4× bigger and prefers USDT (USDC vault same, but only via group) -> group picks the token that earns most in total.
  const vaults = [vault('USDT', 'venus', 500), vault('USDC', 'venus', 500)];
  const s = snap({ NVDAB: [opt('venus', 'USDT', 350, { ratioBps: 3000 }), opt('venus', 'USDC', 300, { ratioBps: 3000 })],
    TSLAB: [opt('venus', 'USDT', 350, { ratioBps: 3000 })], QQQB: [opt('lista', 'USDC', 100, { ratioBps: 3500 })] }, vaults);
  const plan = planAccount({ snapshot: s, holdings: [idle('NVDAB', 10_000), idle('TSLAB', 40_000), idle('QQQB', 10_000)], costs, now: NOW });
  assert.deepEqual(plan.decisions.map(d => [d.symbol, d.action, d.to?.venue, d.to?.loan, d.targetDebtUsd]),
    [['TSLAB', 'open', 'venus', 'USDT', 12_000], ['NVDAB', 'open', 'venus', 'USDT', 3000], ['QQQB', 'open', 'lista', 'USDC', 3500]]);
  assert.deepEqual(plan.venus, { loan: 'USDT', debtUsd: 15_000 }); // Lista debt is not in it
});

test('Venus shared debt: a new Venus position joins the loan the account already has, even when another token is cheaper', () => {
  const vaults = [vault('USDT', 'venus', 500), vault('USDC', 'venus', 500)];
  const s = snap({ NVDAB: [opt('venus', 'USDT', 350), opt('venus', 'USDC', 320)], TSLAB: [opt('venus', 'USDT', 350), opt('venus', 'USDC', 320)] }, vaults);
  const plan = planAccount({ snapshot: s, holdings: [held('NVDAB', 10_000, key('venus', 'USDT'), 3000, 2), idle('TSLAB', 10_000)], costs, now: NOW });
  assert.deepEqual(plan.decisions.map(d => [d.symbol, d.action, d.reason, d.to?.loan]), [['NVDAB', 'hold', 'best_route', 'USDT'], ['TSLAB', 'open', 'best_route', 'USDT']]);
  assert.deepEqual(plan.venus, { loan: 'USDT', debtUsd: 6000 });
});

test('Venus shared debt: the loan token switches for the whole group in one move, judged on the group total and its newest position', () => {
  const vaults = [vault('USDT', 'venus', 500), vault('USDC', 'venus', 500)];
  // USDC is 2% cheaper: each position gains 2% × 30% = 0.60%.
  const s = snap({ NVDAB: [opt('venus', 'USDT', 400), opt('venus', 'USDC', 200)], TSLAB: [opt('venus', 'USDT', 400), opt('venus', 'USDC', 200)] }, vaults);
  const run = (tslaDays: number) => planAccount({ snapshot: s, holdings: [held('NVDAB', 10_000, key('venus', 'USDT'), 3000, 30), held('TSLAB', 10_000, key('venus', 'USDT'), 3000, tslaDays)], costs, now: NOW });
  let plan = run(3); // TSLAB joined 3 days ago: nobody moves, and nobody splits off into a second Venus loan
  assert.deepEqual(plan.decisions.map(d => [d.action, d.to?.loan]), [['hold', 'USDT'], ['hold', 'USDT']]);
  plan = run(8);
  assert.deepEqual(plan.decisions.map(d => [d.symbol, d.action, d.reason, d.urgent, d.to?.loan]), [['NVDAB', 'migrate', 'venus_loan_switch', false, 'USDC'], ['TSLAB', 'migrate', 'venus_loan_switch', false, 'USDC']]);
  assert.deepEqual(plan.venus, { loan: 'USDC', debtUsd: 6000 });
  assert.match(plan.decisions[0]!.rationale, /venus USDT→USDC group \+0\.60%/);
});

test('Venus shared debt: the loan turning bad moves every Venus position now; one delisted collateral leaves alone', () => {
  const vaults = [vault('USDT', 'venus', 300), vault('USDC', 'venus', 500)];
  // Venus USDT borrow now costs more than its vault pays. NVDAB can go to Lista, TSLAB to Venus USDC.
  const s = snap({ NVDAB: [opt('venus', 'USDT', 450), opt('lista', 'USDC', 100)], TSLAB: [opt('venus', 'USDT', 450), opt('venus', 'USDC', 300)] }, vaults);
  let plan = planAccount({ snapshot: s, holdings: [held('NVDAB', 10_000, key('venus', 'USDT'), 3000, 1), held('TSLAB', 10_000, key('venus', 'USDT'), 3000, 1)], costs, now: NOW });
  assert.deepEqual(plan.decisions.map(d => [d.symbol, d.action, d.reason, d.urgent, d.to?.venue, d.to?.loan]),
    [['NVDAB', 'migrate', 'negative_carry', true, 'lista', 'USDC'], ['TSLAB', 'migrate', 'negative_carry', true, 'venus', 'USDC']]);
  assert.deepEqual(plan.venus, { loan: 'USDC', debtUsd: 3000 });
  // Venus stops taking TSLAB as collateral: only TSLAB leaves; NVDAB keeps the shared USDT loan.
  const good = [vault('USDT', 'venus', 500)];
  plan = planAccount({ snapshot: snap({ NVDAB: [opt('venus', 'USDT', 300)], TSLAB: [] }, good), holdings: [held('NVDAB', 10_000, key('venus', 'USDT'), 3000, 1), held('TSLAB', 10_000, key('venus', 'USDT'), 3000, 1)], costs, now: NOW });
  assert.deepEqual(plan.decisions.map(d => [d.symbol, d.action, d.reason]), [['NVDAB', 'hold', 'best_route'], ['TSLAB', 'close', 'market_unavailable']]);
  assert.deepEqual(plan.venus, { loan: 'USDT', debtUsd: 3000 });
});

test('minimum size: our floor is 1 USD of debt, a venue\'s own minimum loan is a hard limit per route, and too small is its own reason', () => {
  assert.equal(ROUTING.MIN_BORROW_USD, 1);
  const vaults = [vault('USDT', 'venus', 500)];
  const s = snap({ PDDB: [opt('lista', 'USDT', 200)] }, vaults);
  // A minimum buy: 50 USDT over two assets = 25 USD each at 30% = 7.50. It opens (the old 10 USD floor refused it).
  let d = one(s, idle('PDDB', 25));
  assert.deepEqual([d.action, d.reason, d.targetDebtUsd], ['open', 'best_route', 7.5]);
  // The floor itself: 3.30 USD would borrow 0.99, 3.40 USD 1.02.
  d = one(s, idle('PDDB', 3.3));
  assert.deepEqual([d.action, d.reason, d.to, d.targetDebtUsd], ['hold', 'too_small', null, 0]);
  assert.match(d.rationale, /^PDDB hold: would borrow \$0\.99 < \$1\.00$/);
  assert.deepEqual([one(s, idle('PDDB', 3.4)).action, one(s, idle('PDDB', 3.4)).targetDebtUsd], ['open', 1.02]);
  // A venue minimum (Moolah minLoan 15 on mainnet = a target of 15.31): 25 USD at 30% cannot open there; 52 USD can.
  const lista = opt('lista', 'USDT', 200, { minBorrowUsd: 15.31 });
  d = one(snap({ PDDB: [lista] }, vaults), idle('PDDB', 25));
  assert.deepEqual([d.action, d.reason], ['hold', 'too_small']);
  assert.match(d.rationale, /would borrow \$7\.50 < \$15\.31/);
  d = one(snap({ PDDB: [lista] }, vaults), idle('PDDB', 52));
  assert.deepEqual([d.action, d.to?.venue, d.to?.minBorrowUsd, Math.round(d.targetDebtUsd * 100)], ['open', 'lista', 15.31, 1560]);
  // An asset that also has a route without a minimum (Venus) opens there while it is small, and on the better-paying
  // Lista route once it is large enough.
  const both = snap({ NVDAB: [lista, opt('venus', 'USDT', 300)] }, vaults);
  d = one(both, idle('NVDAB', 25));
  assert.deepEqual([d.action, d.to?.venue, d.targetDebtUsd], ['open', 'venus', 7.5]);
  d = one(both, idle('NVDAB', 100));
  assert.deepEqual([d.action, d.to?.venue, d.targetDebtUsd], ['open', 'lista', 30]);
  // Too small is only said when a larger holding would open: negative carry and no route keep their own reasons.
  assert.equal(one(snap({ PDDB: [opt('lista', 'USDT', 600)] }, vaults), idle('PDDB', 2)).reason, 'negative_carry');
  assert.equal(one(snap({ PDDB: [] }, vaults), idle('PDDB', 2)).reason, 'no_route');
  // An open position under the minimum is not closed for its size (only never opened): it holds.
  d = one(s, held('PDDB', 3, key('lista', 'USDT'), 0.9, 30));
  assert.deepEqual([d.action, d.reason], ['hold', 'best_route']);
});

test('minOpenValueUsd: the least value of an asset the strategy opens with = minimum loan ÷ ratio over the routes it could borrow on now', () => {
  const vaults = [vault('USDT', 'venus', 500)];
  const round = (n: number | null) => n === null ? null : Math.round(n * 1e4) / 1e4;
  // 1 USD ÷ 30%; a 35% route needs less; a venue minimum of 15.31 needs 51.03.
  assert.equal(round(minOpenValueUsd(snap({ PDDB: [opt('lista', 'USDT', 200)] }, vaults), 'PDDB', NOW)), 3.3333);
  assert.equal(round(minOpenValueUsd(snap({ QQQB: [opt('lista', 'USDT', 200, { ratioBps: 3500 })] }, vaults), 'QQQB', NOW)), 2.8571);
  assert.equal(round(minOpenValueUsd(snap({ PDDB: [opt('lista', 'USDT', 200, { minBorrowUsd: 15.31 })] }, vaults), 'PDDB', NOW)), 51.0333);
  // The route without a minimum decides when there is one.
  assert.equal(round(minOpenValueUsd(snap({ NVDAB: [opt('lista', 'USDT', 200, { minBorrowUsd: 15.31 }), opt('venus', 'USDT', 300)] }, vaults), 'NVDAB', NOW)), 3.3333);
  // Nothing to borrow on now (negative carry, no vault that takes deposits, stale data, unknown asset): null.
  assert.equal(minOpenValueUsd(snap({ PDDB: [opt('lista', 'USDT', 600)] }, vaults), 'PDDB', NOW), null);
  assert.equal(minOpenValueUsd(snap({ PDDB: [opt('lista', 'USDT', 200)] }, [vault('USDT', 'venus', 500, { eligible: false })]), 'PDDB', NOW), null);
  assert.equal(minOpenValueUsd(snap({ PDDB: [opt('lista', 'USDT', 200)] }, vaults, NOW - ROUTING.MAX_SOURCE_AGE_MS - 1), 'PDDB', NOW), null);
  assert.equal(minOpenValueUsd(snap({}, vaults), 'PDDB', NOW), null);
});
