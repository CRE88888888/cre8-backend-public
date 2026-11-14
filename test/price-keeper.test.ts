import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { getAddress } from 'viem';
import { TESTNET_ASSETS } from '../src/keeper/assets.js';
import { boundedTarget, canSwap, parseScenario, targetAt } from '../src/keeper/scenario.js';
import { PriceKeeper } from '../src/keeper/engine.js';
import type { Head, KeeperIO, Observation } from '../src/keeper/engine.js';
import { loadKeeperSettings } from '../src/keeper/run.js';
import { sqrtPriceFor, spotPrice, validateFeed, signingAccount } from '../src/keeper/chain.js';

const unit = 10n ** 18n;
const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
function rawScenario() {
  return { version: 1, stepSeconds: 60, maxStepBps: 5,
    assets: Object.fromEntries(TESTNET_ASSETS.map((s) => [s.symbol, s.priceE18])),
    timeline: [{ steps: 120, mode: 'rise', stepBps: 5 }], overrides: {} };
}

function fixture() {
  const scenario = parseScenario(rawScenario());
  const state = { head: { number: 100n, timestamp: 1060n }, now: 1_060_000, fail: '', refreshMissing: false, inspections: 0,
    swaps: [] as string[], targets: [] as bigint[], pushes: [] as bigint[], mints: [] as string[], logs: [] as string[], alerts: [] as string[], balances: new Map<string, bigint>() };
  const observations: Observation[] = TESTNET_ASSETS.map((spec, index) => ({
    market: { symbol: spec.symbol, token: addr(index + 10), pool: addr(index + 100), oracle: addr(index + 200),
      fee: spec.fee, decimals: spec.decimals, maxFeedAge: spec.maxFeedAge,
      ...(spec.hasFeed ? { feed: addr(index + 300), secondary: addr(index + 400) } : {}) },
    spotE18: BigInt(spec.priceE18), twapE18: BigInt(spec.priceE18), lastObservation: 1000n,
    feedUpdatedAt: spec.hasFeed ? 1000n : null,
  }));
  const fail = (name: string) => { if (state.fail === name) throw new Error('secret RPC credential'); };
  const io: KeeperIO = {
    head: async () => { fail('head'); return state.head; },
    inspect: async () => { fail('inspect'); state.inspections += 1; return state.refreshMissing && state.inspections > 1 ? [] : observations; },
    balance: async (token) => { fail('balance'); return state.balances.get(token) ?? 1_000_000n * unit; },
    mint: async (token, amount) => { fail('mint'); state.mints.push(token); state.balances.set(token, (state.balances.get(token) ?? 0n) + amount); },
    swap: async (o, target) => {
      fail('swap'); state.swaps.push(o.market.symbol); state.targets.push(target);
      const cash = state.balances.get(addr(1));
      if (cash !== undefined) { assert.ok(cash >= 10_000n * unit, 'cash must cover the next swap'); state.balances.set(addr(1), cash - 10_000n * unit); }
    },
    push: async (_feed, answer) => { fail('push'); state.pushes.push(answer); },
  };
  const keeper = new PriceKeeper(io, scenario, addr(1), addr(2), {
    start: 1000n, minimumUsdtE18: 10_000n * unit, inventoryUsdtE18: 100_000n * unit,
    swapBudgetUsdtE18: 10_000n * unit, stallSeconds: 90,
  }, (line) => state.logs.push(line), async (line) => { state.alerts.push(line); fail('alert'); }, () => state.now);
  return { scenario, state, observations, keeper, io };
}

test('keeper examples: exact 38 baselines, 11 secondary feeds and three valid scenarios', async () => {
  assert.equal(TESTNET_ASSETS.length, 38);
  assert.equal(TESTNET_ASSETS.filter((s) => s.hasFeed).length, 11);
  for (const file of ['gentle-rise', 'gentle-fall', 'market-holiday']) {
    const value: unknown = JSON.parse(await readFile(new URL(`../scripts/price-scenarios/${file}.json`, import.meta.url), 'utf8'));
    assert.equal(Object.keys(parseScenario(value).assets).length, 38);
  }
});

test('keeper parser rejects missing, extra, nonnumeric, unbounded and unsafe input', () => {
  const baseline = rawScenario();
  const invalid: unknown[] = [null, [], {}, { ...baseline, extra: true }, { ...baseline, version: 2 },
    ...[0, 59, 301, 60.1, '60', NaN].map((stepSeconds) => ({ ...baseline, stepSeconds })),
    ...[0, 6, '1', 1.5].map((maxStepBps) => ({ ...baseline, maxStepBps })),
    { ...baseline, assets: {} }, { ...baseline, assets: { ...baseline.assets, ETH: '0' } },
    { ...baseline, assets: { ...baseline.assets, ETH: '1' } },
    { ...baseline, overrides: { UNKNOWN: baseline.timeline } },
    ...[[], [{ steps: 0, mode: 'rise', stepBps: 1 }], [{ steps: 10_081, mode: 'rise', stepBps: 1 }],
      [{ steps: 1, mode: 'unknown', stepBps: 1 }], [{ steps: 1, mode: 'rise', stepBps: 6 }],
      [{ steps: 1, mode: 'closed', stepBps: 1 }], [{ steps: 1, mode: 'paused', stepBps: 1 }],
      [{ steps: 1, mode: 'fall', stepBps: -1 }]].map((timeline) => ({ ...baseline, timeline }))];
  for (const value of invalid) assert.throws(() => parseScenario(value));
  for (const stepSeconds of [60, 300]) for (const maxStepBps of [1, 5]) {
    assert.equal(parseScenario({ ...baseline, stepSeconds, maxStepBps, timeline: [{ steps: 10_080, mode: 'rise', stepBps: maxStepBps }] }).stepSeconds, stepSeconds);
  }
});

test('keeper targets: deterministic compounding, final step, alternating, closed and paused boundaries', () => {
  const scenario = parseScenario({ ...rawScenario(), timeline: [
    { steps: 2, mode: 'rise', stepBps: 5 }, { steps: 2, mode: 'paused', stepBps: 0 },
    { steps: 2, mode: 'fall', stepBps: 5 }, { steps: 2, mode: 'sideways', stepBps: 5 },
    { steps: 2, mode: 'closed', stepBps: 0 },
  ] });
  const base = scenario.assets.ETH; assert.ok(base);
  const at = (step: number) => targetAt(scenario, 'ETH', 1000n, 1000n + BigInt(step * 60));
  const rise = base * 10_005n / 10_000n * 10_005n / 10_000n;
  assert.equal(at(0).price, base); assert.equal(at(1).price, base * 10_005n / 10_000n);
  assert.deepEqual(at(2), { price: rise, mode: 'rise' });
  assert.deepEqual(at(3), { price: rise, mode: 'paused' }); assert.equal(at(4).price, rise);
  const fall = rise * 9995n / 10_000n * 9995n / 10_000n;
  assert.equal(at(6).price, fall); assert.equal(at(7).price, fall * 10_005n / 10_000n);
  assert.equal(at(8).price, fall); assert.deepEqual(at(11), { price: fall, mode: 'closed' });
  assert.throws(() => targetAt(scenario, 'toString', 1000n, 1060n));
  assert.throws(() => targetAt(scenario, 'ETH', 0n, 1060n));
  assert.throws(() => targetAt(scenario, 'ETH', 1000n, 999n));
});

test('keeper bounds and frequency: exact thresholds, zero movement, dust and delayed replay', () => {
  assert.equal(boundedTarget(10_000n, 20_000n, 5), 10_005n);
  assert.equal(boundedTarget(10_000n, 1n, 5), 9995n);
  assert.equal(boundedTarget(10_000n, 10_003n, 5), 10_003n);
  assert.equal(boundedTarget(1n, 2n, 5), 1n);
  assert.equal(boundedTarget(100n, 100n, 1), 100n);
  assert.throws(() => boundedTarget(0n, 1n, 1)); assert.throws(() => boundedTarget(1n, 0n, 1));
  assert.equal(canSwap(1059n, 1000n, 60), false); assert.equal(canSwap(1060n, 1000n, 60), true);
  assert.equal(canSwap(1300n, 1000n, 300), true);
  assert.throws(() => canSwap(999n, 1000n, 60)); assert.throws(() => canSwap(1000n, 0n, 60));
});

test('keeper tops up USDT between swaps and never exceeds one swap per asset per round', async () => {
  const { state, keeper } = fixture(); state.balances.set(addr(1), 15_000n * unit);
  await keeper.round();
  assert.equal(state.swaps.length, 38); assert.equal(new Set(state.swaps).size, 38);
  assert.ok(state.mints.length >= 4); assert.equal(state.pushes.length, 12);
  await keeper.round(); assert.equal(state.swaps.length, 38); assert.equal(state.pushes.length, 12);
});

test('keeper refuses incomplete refreshed observations instead of publishing a partial feed set', async () => {
  const { state, keeper } = fixture(); state.refreshMissing = true;
  await assert.rejects(keeper.round(), /halted/); assert.equal(state.pushes.length, 0); assert.equal(state.alerts.length, 1);
});

test('keeper closed/paused assets keep their pool price while their secondary feed stays fresh', async () => {
  const { state, keeper, scenario } = fixture();
  for (const [symbol, mode] of [['AAPLB', 'closed'], ['ETH', 'paused']] as const) scenario.overrides[symbol] = [{ steps: 120, mode, stepBps: 0 }];
  await keeper.round();
  assert.equal(state.swaps.length, 36); assert.ok(!state.swaps.includes('AAPLB')); assert.ok(!state.swaps.includes('ETH'));
  assert.equal(state.pushes.length, 12);
});

test('keeper inventory only mints below threshold; threshold equality and exact target verified', async () => {
  const { state, keeper, observations } = fixture();
  const asset = observations[0]; assert.ok(asset);
  const min = 10_000n * unit * unit / asset.spotE18;
  state.balances.set(asset.market.token, min);
  await keeper.round(); assert.ok(!state.mints.includes(asset.market.token));
  const next = fixture(); const token = next.observations[0]; assert.ok(token);
  next.state.balances.set(token.market.token, 0n); await next.keeper.round();
  assert.equal(next.state.balances.get(token.market.token), 100_000n * unit * unit / token.spotE18);
});

test('keeper RPC/read/write failures halt permanently, alert once and redact upstream errors', async () => {
  for (const failure of ['head', 'inspect', 'balance', 'mint', 'swap', 'push']) {
    const { state, keeper } = fixture(); state.fail = failure; state.balances.set(addr(1), 0n);
    await assert.rejects(keeper.round(), /halted/);
    assert.equal(state.alerts.length, 1); assert.doesNotMatch(state.logs.join('\n') + state.alerts.join('\n'), /secret|credential/);
    await assert.rejects(keeper.round(), /stopped/); assert.equal(state.alerts.length, 1);
    if (failure === 'head' || failure === 'inspect') { assert.equal(state.mints.length, 0); assert.equal(state.swaps.length, 0); }
  }
});

test('keeper observes frequency across restart via on-chain timestamps and bounds catch-up', async () => {
  const { state, observations, keeper } = fixture();
  for (const o of observations) o.lastObservation = 1001n;
  await keeper.round(); assert.equal(state.swaps.length, 0);
  state.head = { number: 101n, timestamp: 1120n }; state.now += 60_000;
  await keeper.round(); assert.equal(state.swaps.length, 38);
});

test('keeper delayed replay caps each actual swap and publishes observed TWAP instead of scenario targets', async () => {
  const { state, observations, keeper } = fixture();
  state.head = { number: 200n, timestamp: 4600n }; state.now = 4_600_000;
  for (const observation of observations) {
    observation.lastObservation = 4540n;
    if (observation.market.feed) observation.feedUpdatedAt = 4540n;
    observation.twapE18 = observation.spotE18 * 10_001n / 10_000n;
  }
  await keeper.round();
  assert.deepEqual(state.targets, observations.map((o) => o.spotE18 * 10_005n / 10_000n));
  assert.deepEqual(state.pushes, [100_000_000n, ...observations.filter((o) => o.market.feed).map((o) => o.twapE18 / 10n ** 10n)]);
});

test('keeper fresh feeds are not republished before their step is due', async () => {
  const { observations, keeper, state } = fixture();
  for (const observation of observations) if (observation.market.feed) observation.feedUpdatedAt = 1001n;
  await keeper.round();
  assert.equal(state.swaps.length, 38); assert.equal(state.pushes.length, 0); assert.equal(state.inspections, 1);
});

test('keeper unconfirmed inventory top-up stops before swaps and alerts once', async () => {
  const { keeper, io, state } = fixture(); state.balances.set(addr(1), 0n);
  io.mint = async () => {};
  await assert.rejects(keeper.round(), /halted/);
  assert.equal(state.swaps.length, 0); assert.equal(state.pushes.length, 0); assert.equal(state.alerts.length, 1);
});

test('keeper halts on stalled, old, reversed blocks, missing data and zero price', async () => {
  const old = fixture(); old.state.now += 91_000; await assert.rejects(old.keeper.round(), /halted/);
  const future = fixture(); future.state.head.timestamp += 91n; await assert.rejects(future.keeper.round(), /halted/);
  const boundary = fixture(); boundary.state.now += 90_000; await boundary.keeper.round();
  for (const update of [
    (head: Head) => ({ ...head, number: head.number - 1n }),
    (head: Head) => ({ number: head.number + 1n, timestamp: head.timestamp - 1n }),
    (head: Head) => head,
  ]) {
    const f = fixture(); await f.keeper.round(); f.state.now += 90_000; f.state.head = update(f.state.head);
    await assert.rejects(f.keeper.round(), /halted/); assert.equal(f.state.alerts.length, 1);
  }
  for (const mutate of [(o: Observation[]) => { o.pop(); }, (o: Observation[]) => { const first = o[0]; assert.ok(first); o[1] = first; },
    (o: Observation[]) => { const first = o[0]; assert.ok(first); first.spotE18 = 0n; }]) {
    const f = fixture(); mutate(f.observations); await assert.rejects(f.keeper.round(), /halted/);
    assert.equal(f.state.swaps.length, 0); assert.equal(f.state.mints.length, 0);
  }
});

test('keeper rejects missing/future/stale feed metadata before mint, tolerates alert failure and prohibits concurrent rounds', async () => {
  for (const timestamp of [null, 0n, 1061n, -3000n]) {
    const f = fixture(); const feed = f.observations.find((o) => o.market.feed); assert.ok(feed);
    feed.feedUpdatedAt = timestamp; await assert.rejects(f.keeper.round(), /halted/); assert.equal(f.state.mints.length, 0);
  }
  const f = fixture(); f.io.head = async () => { throw new Error('secret RPC'); };
  f.state.fail = 'alert'; await assert.rejects(f.keeper.round(), /halted/);
  assert.match(f.state.logs.join('\n'), /Telegram 通知失敗/); assert.doesNotMatch(f.state.logs.join('\n'), /secret/);
  const concurrent = fixture(); let release: (() => void) | undefined;
  concurrent.io.head = async () => { await new Promise<void>((resolve) => { release = resolve; }); return concurrent.state.head; };
  const round = concurrent.keeper.round(); await assert.rejects(concurrent.keeper.round(), /already running/);
  assert.ok(release); release();
  // Keep the second, post-swap head read from waiting on another manual release.
  concurrent.io.head = async () => concurrent.state.head;
  await round; assert.equal(concurrent.state.alerts.length, 0);
});

test('keeper price encoding handles both token orders and 6/8/18 decimals', () => {
  for (const spec of TESTNET_ASSETS) for (const order of [true, false]) {
    const price = BigInt(spec.priceE18); const sqrt = sqrtPriceFor(price, spec.decimals, order);
    const result = spotPrice(sqrt, spec.decimals, order);
    // Integer sqrt quantization is relative to the raw ratio (6-decimal tokens need >1 wei tolerance).
    assert.ok((result > price ? result - price : price - result) * 10n ** 15n <= price);
  }
  assert.throws(() => sqrtPriceFor(0n, 18, true)); assert.throws(() => sqrtPriceFor(1n, 19, true));
  assert.throws(() => sqrtPriceFor(1n << 254n, 0, false)); assert.throws(() => spotPrice(0n, 18, true));
});

test('keeper feed health validates exact max age, missing/negative/future/incomplete rounds', () => {
  const round = [1n, 100_000_000n, 1000n, 1000n, 1n] as const;
  validateFeed(round, 4600n, 3600);
  for (const value of [[0n, 1n, 1000n, 1000n, 1n], [2n, 1n, 1000n, 1000n, 1n], [1n, 0n, 1000n, 1000n, 1n],
    [1n, -1n, 1000n, 1000n, 1n], [1n, 1n, 0n, 0n, 1n], [1n, 1n, 1001n, 1001n, 1n]] as const) {
    assert.throws(() => validateFeed(value, 1000n, 3600));
  }
  assert.throws(() => validateFeed(round, 4601n, 3600));
});

test('keeper configuration defaults disabled, requires explicit chain settings and validates thresholds', () => {
  assert.equal(loadKeeperSettings({}), null); assert.equal(loadKeeperSettings({ PRICE_KEEPER_ENABLED: '0' }), null);
  assert.throws(() => loadKeeperSettings({ PRICE_KEEPER_ENABLED: 'true' }));
  const env = { PRICE_KEEPER_ENABLED: '1', PRICE_KEEPER_RPC_URL: 'http://127.0.0.1:8557', PRICE_KEEPER_MANIFEST: 'manifest.json',
    PRICE_KEEPER_SCENARIO: 'scenario.json', PRICE_KEEPER_START_TIMESTAMP: '1000', PRICE_KEEPER_PRIVATE_KEY: `0x${'0'.repeat(63)}1` };
  assert.ok(loadKeeperSettings(env));
  for (const patch of [{ PRICE_KEEPER_RPC_URL: '' }, { PRICE_KEEPER_RPC_URL: 'file:///secret' }, { PRICE_KEEPER_START_TIMESTAMP: '0' },
    { PRICE_KEEPER_PRIVATE_KEY: 'secret' }, { PRICE_KEEPER_MIN_INVENTORY_E18: '0' },
    { PRICE_KEEPER_MIN_INVENTORY_E18: (100_000n * unit).toString() }, { PRICE_KEEPER_SWAP_BUDGET_E18: (10_000n * unit + 1n).toString() }]) {
    assert.throws(() => loadKeeperSettings({ ...env, ...patch }));
  }
  for (const value of [undefined, '', 'secret', `0x${'0'.repeat(64)}`]) assert.throws(() => signingAccount(value));
});
