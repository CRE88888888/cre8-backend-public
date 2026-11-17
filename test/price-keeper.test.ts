import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { getAddress, HttpRequestError, RpcRequestError, TimeoutError } from 'viem';
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
    swaps: [] as string[], targets: [] as bigint[], pushes: [] as bigint[], mints: [] as string[], logs: [] as string[], alerts: [] as string[], balances: new Map<string, bigint>([[addr(1), 2_000_000n * unit]]) };
  const observations: Observation[] = TESTNET_ASSETS.map((spec, index) => ({
    market: { symbol: spec.symbol, token: addr(index + 10), pool: addr(index + 1000), oracle: addr(index + 2000),
      fee: spec.fee, decimals: spec.decimals, maxFeedAge: spec.maxFeedAge,
      ...(spec.hasFeed ? { feed: addr(index + 3000), secondary: addr(index + 4000) } : {}) },
    spotE18: BigInt(spec.priceE18), twapE18: BigInt(spec.priceE18), lastObservation: 1000n,
    feedUpdatedAt: spec.hasFeed ? 1000n : null,
  }));
  const fail = (name: string) => { if (state.fail === name) throw new Error('secret RPC credential'); };
  const io: KeeperIO = {
    head: async () => { fail('head'); return state.head; },
    inspect: async () => { fail('inspect'); state.inspections += 1; return state.refreshMissing && state.inspections > 1 ? [] : observations; },
    balance: async (token) => { fail('balance'); return state.balances.get(token) ?? 0n; },
    mint: async (token, amount) => { fail('mint'); state.mints.push(token); state.balances.set(token, (state.balances.get(token) ?? 0n) + amount); },
    swap: async (o, target) => {
      fail('swap'); state.swaps.push(o.market.symbol); state.targets.push(target);
      const cash = state.balances.get(addr(1));
      if (cash !== undefined && target > o.spotE18) { assert.ok(cash >= 10_000n * unit, 'cash must cover the next swap'); state.balances.set(addr(1), cash - 10_000n * unit); }
    },
    push: async (_feed, answer) => { fail('push'); state.pushes.push(answer); },
  };
  const keeper = new PriceKeeper(io, scenario, addr(1), addr(2), {
    start: 1000n, minimumUsdtE18: 10_000n * unit, inventoryUsdtE18: 100_000n * unit,
    swapBudgetUsdtE18: 10_000n * unit, stallSeconds: 90,
  }, (line) => state.logs.push(line), async (line) => { state.alerts.push(line); fail('alert'); }, () => state.now);
  return { scenario, state, observations, keeper, io };
}

test('keeper examples: exact 92 baselines, 11 secondary feeds and three valid scenarios', async () => {
  assert.equal(TESTNET_ASSETS.length, 92);
  assert.equal(TESTNET_ASSETS.filter((s) => s.hasFeed).length, 11);
  for (const file of ['gentle-rise', 'gentle-fall', 'market-holiday']) {
    const value: unknown = JSON.parse(await readFile(new URL(`../scripts/price-scenarios/${file}.json`, import.meta.url), 'utf8'));
    assert.equal(Object.keys(parseScenario(value).assets).length, 92);
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

test('keeper uses prefunded USDT and never exceeds one swap per asset per round', async () => {
  const { state, keeper } = fixture(); state.balances.set(addr(1), 2_000_000n * unit);
  await keeper.round();
  assert.equal(state.swaps.length, 92); assert.equal(new Set(state.swaps).size, 92);
  assert.ok(state.mints.length >= 4); assert.equal(state.pushes.length, 12);
  assert.ok(!state.mints.includes(addr(1)));
  await keeper.round(); assert.equal(state.swaps.length, 92); assert.equal(state.pushes.length, 12);
});

test('#97 keeper never mints USDT: zero and below minimum halt; equality covers the next swap', async () => {
  for (const balance of [0n, 10_000n * unit - 1n, 10_000n * unit]) {
    const f = fixture(); f.state.balances.set(addr(1), balance);
    await assert.rejects(f.keeper.round(), /halted/);
    assert.ok(!f.state.mints.includes(addr(1)));
    assert.equal(f.state.swaps.length, balance === 10_000n * unit ? 1 : 0);
    assert.equal(f.state.alerts.length, 1);
  }
});

test('keeper refuses incomplete refreshed observations instead of publishing a partial feed set', async () => {
  const { state, keeper } = fixture(); state.refreshMissing = true;
  await assert.rejects(keeper.round(), /halted/); assert.equal(state.pushes.length, 0); assert.equal(state.alerts.length, 1);
});

test('keeper closed/paused assets keep their pool price while their secondary feed stays fresh', async () => {
  const { state, keeper, scenario } = fixture();
  for (const [symbol, mode] of [['AAPLB', 'closed'], ['ETH', 'paused']] as const) scenario.overrides[symbol] = [{ steps: 120, mode, stepBps: 0 }];
  await keeper.round();
  assert.equal(state.swaps.length, 90); assert.ok(!state.swaps.includes('AAPLB')); assert.ok(!state.swaps.includes('ETH'));
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
    const { state, keeper } = fixture(); state.fail = failure;
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
  await keeper.round(); assert.equal(state.swaps.length, 92);
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
  assert.deepEqual(state.pushes, [100_000_000n, ...observations.filter((o) => o.market.feed).map((o) => { assert.ok(o.twapE18 !== null); return o.twapE18 / 10n ** 10n; })]);
});

test('keeper fresh feeds are not republished before their step is due', async () => {
  const { observations, keeper, state } = fixture();
  for (const observation of observations) if (observation.market.feed) observation.feedUpdatedAt = 1001n;
  await keeper.round();
  assert.equal(state.swaps.length, 92); assert.equal(state.pushes.length, 0); assert.equal(state.inspections, 1);
});

test('keeper unconfirmed inventory top-up stops before swaps and alerts once', async () => {
  const { keeper, io, state } = fixture(); state.balances.set(addr(1), 0n);
  io.mint = async () => {};
  await assert.rejects(keeper.round(), /halted/);
  assert.equal(state.swaps.length, 0); assert.equal(state.pushes.length, 0); assert.equal(state.alerts.length, 1);
});

test('keeper halts on old/future blocks, persistent reversed/stalled blocks, missing data and zero price', async () => {
  const old = fixture(); old.state.now += 91_000; await assert.rejects(old.keeper.round(), /halted/);
  const future = fixture(); future.state.head.timestamp += 91n; await assert.rejects(future.keeper.round(), /halted/);
  const boundary = fixture(); boundary.state.now += 90_000; await boundary.keeper.round();
  for (const update of [
    (head: Head) => ({ ...head, number: head.number - 1n }),
    (head: Head) => ({ number: head.number + 1n, timestamp: head.timestamp - 1n }),
    (head: Head) => head,
  ]) {
    const f = fixture(); await f.keeper.round(); f.state.now += 90_000; f.state.head = update(f.state.head);
    for (let i = 1; i < 5; i++) await f.keeper.round();
    await assert.rejects(f.keeper.round(), /halted/); assert.equal(f.state.alerts.length, 1);
    assert.match(f.state.logs.join('\n'), /block progress unavailable/);
  }
  for (const mutate of [(o: Observation[]) => { o.pop(); }, (o: Observation[]) => { const first = o[0]; assert.ok(first); o[1] = first; },
    (o: Observation[]) => { const first = o[0]; assert.ok(first); first.spotE18 = 0n; }]) {
    const f = fixture(); mutate(f.observations); await assert.rejects(f.keeper.round(), /halted/);
    assert.equal(f.state.swaps.length, 0); assert.equal(f.state.mints.length, 0);
  }
});

test('#139 expired feeds recover at and beyond max age using validated TWAPs', async () => {
  for (const excess of [0n, 1n, 100_000n]) {
    const f = fixture(); f.state.head = { number: 200n, timestamp: 200_000n }; f.state.now = 200_000_000;
    for (const o of f.observations) {
      o.lastObservation = f.state.head.timestamp - 60n;
      if (o.market.feed) o.feedUpdatedAt = f.state.head.timestamp - BigInt(o.market.maxFeedAge) - excess;
    }
    await f.keeper.round();
    assert.equal(f.state.pushes.length, 12); assert.equal(f.state.alerts.length, 0);
    assert.deepEqual(f.state.pushes, [100_000_000n, ...f.observations.filter((o) => o.market.feed).map((o) => { assert.ok(o.twapE18 !== null); return o.twapE18 / 10n ** 10n; })]);
  }
});

test('#139 a regressed or repeated head skips all IO until progress resumes and resets the five-round limit', async () => {
  const f = fixture(); await f.keeper.round();
  const inspections = f.state.inspections; const swaps = f.state.swaps.length; const pushes = f.state.pushes.length;
  for (const head of [{ number: 99n, timestamp: 1059n }, { number: 100n, timestamp: 1060n },
    { number: 101n, timestamp: 1059n }, { number: 99n, timestamp: 1060n }]) {
    f.state.head = head; await f.keeper.round();
    assert.equal(f.state.inspections, inspections); assert.equal(f.state.swaps.length, swaps); assert.equal(f.state.pushes.length, pushes);
  }
  f.state.head = { number: 101n, timestamp: 1061n }; await f.keeper.round(); // Progress also counts before the scenario step is due.
  for (let i = 1; i < 5; i++) await f.keeper.round();
  assert.equal(f.state.alerts.length, 0);
  await assert.rejects(f.keeper.round(), /halted/); assert.equal(f.state.alerts.length, 1);
  await assert.rejects(f.keeper.round(), /stopped/); assert.equal(f.state.alerts.length, 1);
});

test('#139 all 92 unavailable TWAPs receive only a 1 bp recovery swap, then normal validation and feed pushes resume', async () => {
  const f = fixture(); f.state.head = { number: 200n, timestamp: 200_000n }; f.state.now = 200_000_000;
  const prices = f.observations.map((o) => o.spotE18);
  for (const o of f.observations) o.twapE18 = null;
  await f.keeper.round();
  assert.equal(f.state.swaps.length, 92); assert.equal(new Set(f.state.swaps).size, 92);
  assert.deepEqual(f.state.targets, prices.map((p) => p * 10_001n / 10_000n));
  assert.equal(f.state.pushes.length, 0); assert.equal(f.state.inspections, 1); assert.equal(f.state.alerts.length, 0);
  await f.keeper.round(); assert.equal(f.state.swaps.length, 92);
  for (const [i, o] of f.observations.entries()) {
    const price = prices[i]; assert.ok(price); o.twapE18 = price; o.lastObservation = 200_000n;
    const target = f.state.targets[i]; assert.ok(target); o.spotE18 = target;
  }
  f.state.head = { number: 201n, timestamp: 200_060n }; f.state.now += 60_000;
  await f.keeper.round(); assert.equal(f.state.pushes.length, 12); assert.equal(f.state.alerts.length, 0);
});

test('#139 partial TWAP recovery leaves healthy markets alone and validates every market before writes', async () => {
  const f = fixture(); const first = f.observations[0]; assert.ok(first); first.twapE18 = null;
  await f.keeper.round(); assert.deepEqual(f.state.swaps, [first.market.symbol]); assert.equal(f.state.pushes.length, 0);
  for (const bad of ['missing', 'zero spot', 'zero twap', 'future observation', 'missing feed']) {
    const f = fixture(); const first = f.observations[0]; const last = f.observations.at(-1); assert.ok(first && last);
    first.twapE18 = null;
    if (bad === 'missing') f.observations.pop();
    if (bad === 'zero spot') last.spotE18 = 0n;
    if (bad === 'zero twap') last.twapE18 = 0n;
    if (bad === 'future observation') last.lastObservation = 1061n;
    if (bad === 'missing feed') { const feed = f.observations.find((o) => o.market.feed); assert.ok(feed); feed.feedUpdatedAt = null; }
    await assert.rejects(f.keeper.round(), /halted/);
    assert.equal(f.state.mints.length, 0); assert.equal(f.state.swaps.length, 0); assert.equal(f.state.pushes.length, 0);
  }
});

test('#139 recovery retains the observation interval, precision, inventory and failed-write guards', async () => {
  const early = fixture(); for (const o of early.observations) { o.twapE18 = null; o.lastObservation = 1001n; }
  await early.keeper.round(); assert.equal(early.state.swaps.length, 0); assert.equal(early.state.pushes.length, 0);
  for (const fault of ['swap', 'cash', 'dust']) {
    const f = fixture(); const first = f.observations[0]; assert.ok(first); first.twapE18 = null;
    if (fault === 'swap') f.state.fail = 'swap';
    if (fault === 'cash') f.state.balances.set(addr(1), 0n);
    if (fault === 'dust') first.spotE18 = 1n;
    await assert.rejects(f.keeper.round(), /halted/); assert.equal(f.state.pushes.length, 0); assert.equal(f.state.alerts.length, 1);
    await assert.rejects(f.keeper.round(), /stopped/); assert.equal(f.state.swaps.length, 0);
  }
});

test('#139 stopped logs explain the stage and safe local/RPC reason without upstream secrets', async () => {
  const local = fixture(); local.observations.pop();
  await assert.rejects(local.keeper.round(), /halted/);
  assert.match(local.state.logs.join('\n'), /inspect.*incomplete market observations/);
  for (const error of [new TimeoutError({ body: {}, url: 'https://private-token.invalid/key' }),
    new RpcRequestError({ body: {}, url: 'https://private-token.invalid/key', error: { code: -32000, message: 'seed=private-token' } }),
    new HttpRequestError({ url: 'https://private-token.invalid/key', status: 503, details: 'seed=private-token' })]) {
    const f = fixture(); f.io.head = async () => { throw error; };
    await assert.rejects(f.keeper.round(), /halted/);
    const output = f.state.logs.join('\n') + f.state.alerts.join('\n');
    assert.match(output, new RegExp(`head.*${error.name}`));
    if (error instanceof HttpRequestError) assert.match(output, /503/);
    if (error instanceof RpcRequestError) assert.match(output, /-32000/);
    assert.doesNotMatch(output, /private-token|https:|seed=/);
  }
});

test('#139 TWAP unavailable during the post-swap refresh halts before publishing even the cash feed', async () => {
  const f = fixture(); const inspect = f.io.inspect;
  f.io.inspect = async (head) => {
    const observations = await inspect(head);
    return f.state.inspections > 1 ? observations.map((o) => ({ ...o, twapE18: null })) : observations;
  };
  await assert.rejects(f.keeper.round(), /halted/);
  assert.equal(f.state.swaps.length, 92); assert.equal(f.state.pushes.length, 0);
  assert.match(f.state.logs.join('\n'), /refresh inspect.*TWAP unavailable after swaps/);
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

test('keeper price encoding handles both token orders and 6/8/9/18 decimals', () => {
  for (const [index, spec] of TESTNET_ASSETS.entries()) for (const order of [true, false]) {
    const price = BigInt(spec.priceE18); const sqrt = sqrtPriceFor(price, spec.decimals, order);
    const result = spotPrice(sqrt, spec.decimals, order);
    // sqrtPriceFor floors the integer sqrt: bracket the raw price by adjacent sqrt values.
    // Tiny SHIB/PEPE prices cannot express a relative 1e-15 tolerance in one integer wei.
    const adjacent = spotPrice(sqrt + 1n, spec.decimals, order);
    if (order) { assert.ok(result <= price); assert.ok(adjacent >= price); }
    else { assert.ok(result >= price); assert.ok(adjacent <= price); }
    if (index < 38) assert.ok((result > price ? result - price : price - result) * 10n ** 15n <= price);
  }
  assert.throws(() => sqrtPriceFor(0n, 18, true)); assert.throws(() => sqrtPriceFor(1n, 19, true));
  assert.throws(() => sqrtPriceFor(1n << 254n, 0, false)); assert.throws(() => spotPrice(0n, 18, true));
});

test('keeper feed health validates exact max age, missing/negative/future/incomplete rounds', () => {
  const round = [1n, 100_000_000n, 1000n, 1000n, 1n] as const;
  validateFeed(round, 4600n, 3600);
  validateFeed(round, 4601n, 3600, true);
  for (const value of [[0n, 1n, 1000n, 1000n, 1n], [2n, 1n, 1000n, 1000n, 1n], [1n, 0n, 1000n, 1000n, 1n],
    [1n, -1n, 1000n, 1000n, 1n], [1n, 1n, 0n, 0n, 1n], [1n, 1n, 1001n, 1001n, 1n]] as const) {
    assert.throws(() => validateFeed(value, 1000n, 3600));
    assert.throws(() => validateFeed(value, 1000n, 3600, true));
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

test('#87 held, paused and completed markets refresh at 30 minutes and retain restart frequency', async () => {
  for (const mode of ['closed', 'paused', 'completed'] as const) {
    const f = fixture();
    f.scenario.timeline = [{ steps: mode === 'completed' ? 1 : 120, mode: mode === 'completed' ? 'rise' : mode, stepBps: 0 }];
    for (const o of f.observations) { o.lastObservation = 1000n; if (o.market.feed) o.feedUpdatedAt = 1000n; }
    f.state.head = { number: 101n, timestamp: 2799n }; f.state.now = 2_799_000;
    await f.keeper.round(); assert.equal(f.state.swaps.length, 0, mode + ' before threshold');
    f.state.head = { number: 102n, timestamp: 2800n }; f.state.now = 2_800_000;
    // A fresh process has no lastRoundTimestamp; the on-chain observation is authoritative.
    const restarted = new PriceKeeper(f.io, f.scenario, addr(1), addr(2), {
      start: 1000n, minimumUsdtE18: 10_000n * unit, inventoryUsdtE18: 100_000n * unit,
      swapBudgetUsdtE18: 10_000n * unit, stallSeconds: 90,
    }, () => {}, async () => {}, () => f.state.now);
    await restarted.round();
    assert.equal(f.state.swaps.length, 92, mode + ' exact threshold');
    assert.equal(new Set(f.state.swaps).size, 92);
    f.state.targets.forEach((price, i) => {
      const o = f.observations[i]; assert.ok(o);
      assert.ok(price < o.spotE18);
      assert.ok((o.spotE18 - price) * 10_000n <= o.spotE18 * BigInt(f.scenario.maxStepBps));
      o.spotE18 = price; o.lastObservation = 2800n;
    });
    f.state.head = { number: 103n, timestamp: 4599n }; f.state.now = 4_599_000;
    await restarted.round(); assert.equal(f.state.swaps.length, 92, mode + ' no early maintenance');
    for (const o of f.observations) if (o.market.feed) o.feedUpdatedAt = 4599n;
    f.state.head = { number: 104n, timestamp: 4660n }; f.state.now = 4_660_000;
    await restarted.round(); assert.equal(f.state.swaps.length, 184);
    f.state.targets.slice(92).forEach((price, i) => { const o = f.observations[i]; assert.ok(o); assert.ok(price > o.spotE18); });
    assert.equal(f.state.alerts.length, 0);
  }
});

test('#87 maintenance swap failure halts, alerts once and never retries', async () => {
  const f = fixture(); f.scenario.timeline = [{ steps: 1, mode: 'closed', stepBps: 0 }];
  f.state.head = { number: 101n, timestamp: 2800n }; f.state.now = 2_800_000; f.state.fail = 'swap';
  await assert.rejects(f.keeper.round(), /halted/); assert.equal(f.state.alerts.length, 1);
  await assert.rejects(f.keeper.round(), /stopped/); assert.equal(f.state.alerts.length, 1);
  assert.doesNotMatch(f.state.logs.join(''), /secret|credential/);
});

test('#87 active flat targets use maintenance only once the on-chain observation is 1800 seconds old', async () => {
  for (const maxStepBps of [1, 5]) {
    const f = fixture(); f.scenario.maxStepBps = maxStepBps;
    f.scenario.timeline = [{ steps: 120, mode: 'sideways', stepBps: 0 }];
    f.state.head = { number: 101n, timestamp: 2799n }; f.state.now = 2_799_000;
    await f.keeper.round(); assert.equal(f.state.swaps.length, 0);
    // The round gate also stays in place: use a fresh instance at the exact threshold.
    const keeper = new PriceKeeper(f.io, f.scenario, addr(1), addr(2), {
      start: 1000n, minimumUsdtE18: 10_000n * unit, inventoryUsdtE18: 100_000n * unit,
      swapBudgetUsdtE18: 10_000n * unit, stallSeconds: 90,
    }, () => {}, async () => {}, () => f.state.now);
    f.state.head = { number: 102n, timestamp: 2800n }; f.state.now = 2_800_000;
    await keeper.round(); assert.equal(f.state.swaps.length, 92);
    await keeper.round(); assert.equal(f.state.swaps.length, 92);
    f.state.targets.forEach((p, i) => { const o = f.observations[i]; assert.ok(o); assert.ok(p < o.spotE18); assert.ok((o.spotE18 - p) * 10_000n <= o.spotE18 * BigInt(maxStepBps)); });
  }
});
