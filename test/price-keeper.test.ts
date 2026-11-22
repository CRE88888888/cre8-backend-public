import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { ContractFunctionRevertedError, getAddress, HttpRequestError, parseAbi, RpcRequestError, SocketClosedError, TimeoutError } from 'viem';
import { TESTNET_ASSETS } from '../src/keeper/assets.js';
import { boundedTarget, canSwap, parseScenario, targetAt } from '../src/keeper/scenario.js';
import { feedDue, isTransientRpcError, maintenanceSeconds, PriceKeeper, RpcRetry, safeReason } from '../src/keeper/engine.js';
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

function fixture(rpcFailureTimeoutSeconds = 1800) {
  const scenario = parseScenario(rawScenario());
  const state = { head: { number: 100n, timestamp: 1060n }, now: 1_060_000, fail: '', refreshMissing: false, inspections: 0,
    swaps: [] as string[], targets: [] as bigint[], pushes: [] as bigint[], mints: [] as string[], logs: [] as string[], alerts: [] as string[], balances: new Map<string, bigint>([[addr(1), BigInt(TESTNET_ASSETS.length) * 20_000n * unit]]) };
  const observations: Observation[] = TESTNET_ASSETS.map((spec, index) => ({
    market: { symbol: spec.symbol, token: addr(index + 10), pool: addr(index + 1000), oracle: addr(index + 2000),
      fee: spec.fee, decimals: spec.decimals, maxFeedAge: spec.maxFeedAge,
      ...(spec.hasFeed ? { feed: addr(index + 3000), secondary: addr(index + 4000) } : {}) },
    spotE18: BigInt(spec.priceE18), twapE18: BigInt(spec.priceE18), lastObservation: 1000n,
    feedUpdatedAt: spec.hasFeed ? 1000n : null,
    // Start every feed 1% away from its TWAP so the one-step push paths stay exercised; #187 tests cover age/drift gates.
    feedAnswerE8: spec.hasFeed ? BigInt(spec.priceE18) * 99n / 100n / 10n ** 10n : null,
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
    swapBudgetUsdtE18: 10_000n * unit, stallSeconds: 90, rpcFailureTimeoutSeconds,
  }, (line) => state.logs.push(line), async (line) => { state.alerts.push(line); fail('alert'); }, () => state.now);
  return { scenario, state, observations, keeper, io };
}

// docs/research/2026-11-20-launch-lineup/新增模擬資產.csv raw-token prices;
// ANTB has no quote: TestnetAssets.sol deliberately uses a 300 USDT test constant.
const launchPrices = {
  AMCB: '2.92', ANTB: '300', BMNRB: '15.71', BNCB: '3.53', COINB: '112.37',
  CYPHB: '1.85', GMEB: '26.31', MRVLB: '147.983', PDDB: '86.36', PENGB: '45.03',
  RDDTB: '92.97', SOXLB: '50.8725', TQQQB: '53.0915',
};

test('#167 all 13 launch baselines use raw prices, including ANTB and multiplied stock/ETF prices', () => {
  for (const [symbol, price] of Object.entries(launchPrices)) {
    const [whole, fraction = ''] = price.split('.');
    const expected = BigInt(whole + fraction.padEnd(18, '0'));
    const spec = TESTNET_ASSETS.find((asset) => asset.symbol === symbol);
    assert.ok(spec, symbol);
    assert.deepEqual(spec, { symbol, decimals: 18, fee: symbol === 'MRVLB' ? 10000 : 2500,
      priceE18: String(expected), hasFeed: false, maxFeedAge: 0 });
  }
});

test('#167 launch stocks/ETFs rise and fall, but remain frozen throughout the holiday scenario', async () => {
  for (const file of ['gentle-rise', 'gentle-fall', 'market-holiday']) {
    const scenario = parseScenario(JSON.parse(await readFile(new URL(`../scripts/price-scenarios/${file}.json`, import.meta.url), 'utf8')));
    for (const symbol of Object.keys(launchPrices)) {
      const baseline = scenario.assets[symbol]; assert.ok(baseline, symbol);
      if (file === 'market-holiday') {
        for (const step of [0, 1, 120, 121]) {
          assert.deepEqual(targetAt(scenario, symbol, 1000n, 1000n + BigInt(step * 60)), { price: baseline, mode: 'closed' });
        }
      } else {
        assert.equal(targetAt(scenario, symbol, 1000n, 1000n).price, baseline);
        assert.equal(targetAt(scenario, symbol, 1000n, 1060n).price, baseline * (file === 'gentle-rise' ? 10001n : 9999n) / 10000n);
      }
    }
  }
});

test('#167 launch scenario prices reject zero, missing, substituted and out-of-range amounts', () => {
  for (const symbol of Object.keys(launchPrices)) {
    const baseline = rawScenario();
    delete baseline.assets[symbol];
    assert.throws(() => parseScenario(baseline), /unexpected or missing fields/);
    for (const price of ['0', '1', String(1n << 255n)]) {
      assert.throws(() => parseScenario({ ...rawScenario(), assets: { ...rawScenario().assets, [symbol]: price } }));
    }
  }
});

test('keeper examples: exact 105 baselines, 11 secondary feeds and three valid scenarios', async () => {
  assert.equal(TESTNET_ASSETS.length, 105);
  assert.equal(TESTNET_ASSETS.filter((s) => s.hasFeed).length, 11);
  for (const file of ['gentle-rise', 'gentle-fall', 'market-holiday']) {
    const value: unknown = JSON.parse(await readFile(new URL(`../scripts/price-scenarios/${file}.json`, import.meta.url), 'utf8'));
    assert.equal(Object.keys(parseScenario(value).assets).length, 105);
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
  assert.equal(state.swaps.length, 105); assert.equal(new Set(state.swaps).size, 105);
  assert.ok(state.mints.length >= 4); assert.equal(state.pushes.length, 12);
  assert.ok(!state.mints.includes(addr(1)));
  await keeper.round(); assert.equal(state.swaps.length, 105); assert.equal(state.pushes.length, 12);
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
  assert.equal(state.swaps.length, 103); assert.ok(!state.swaps.includes('AAPLB')); assert.ok(!state.swaps.includes('ETH'));
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

test('#162 one transient market inventory failure skips that market and recovers next round', async () => {
  const f = fixture();
  const market = f.observations.find((o) => o.market.symbol === 'COHRB'); assert.ok(market);
  const balance = f.io.balance;
  let failed = false;
  f.io.balance = async (token) => {
    if (token === market.market.token && !failed) {
      failed = true;
      throw new HttpRequestError({ url: 'https://private-token.invalid/key', status: 503 });
    }
    return balance(token);
  };
  // Model confirmed on-chain observations so a retry cannot duplicate healthy swaps.
  const swap = f.io.swap;
  f.io.swap = async (o, target, budget) => { await swap(o, target, budget); o.lastObservation = f.state.head.timestamp; };
  await f.keeper.round();
  assert.equal(f.state.swaps.length, 104); assert.ok(!f.state.swaps.includes('COHRB'));
  assert.equal(f.state.alerts.length, 0);
  f.state.now += 60_000; f.state.head = { number: 101n, timestamp: 1120n };
  await f.keeper.round();
  assert.ok(f.state.swaps.includes('COHRB')); assert.equal(f.state.alerts.length, 0);
  assert.doesNotMatch(f.state.logs.join('\n'), /private-token|https:/);
});

test('#162 transient RPC failure window starts at zero, survives equality and halts only beyond 30 minutes', async () => {
  const f = fixture(); f.state.now = 0;
  let reads = 0;
  f.io.head = async () => { reads++; throw new HttpRequestError({ url: 'http://127.0.0.1:1', status: 503 }); };
  await f.keeper.round(); assert.equal(f.state.alerts.length, 0);
  f.state.now = 1_799_999; await f.keeper.round(); assert.equal(f.state.alerts.length, 0);
  f.state.now = 1_800_000; await f.keeper.round(); assert.equal(f.state.alerts.length, 0);
  const before = reads;
  f.state.now = 1_800_001; await assert.rejects(f.keeper.round(), /halted/);
  assert.equal(reads, before); assert.equal(f.state.alerts.length, 1);
  assert.match(f.state.logs.join('\n'), /RPC failure timeout exceeded/);
  await assert.rejects(f.keeper.round(), /stopped/); assert.equal(f.state.alerts.length, 1);
});

test('#162 backoff prevents early RPC calls, grows exponentially to 60 seconds and resets after full success', async () => {
  const f = fixture(); const head = f.io.head;
  let failing = true; let reads = 0;
  f.io.head = async () => {
    reads++;
    if (failing) throw new TimeoutError({ body: {}, url: 'http://127.0.0.1:1' });
    return head();
  };
  for (const delay of [2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]) {
    await f.keeper.round(); assert.equal(f.keeper.retryDelayMs, delay);
    const before = reads;
    f.state.now += delay - 1; await f.keeper.round(); assert.equal(reads, before);
    f.state.now++;
  }
  failing = false;
  f.state.head = { number: 101n, timestamp: BigInt(f.state.now / 1000) };
  await f.keeper.round(); assert.equal(f.keeper.retryDelayMs, 0); assert.equal(f.state.alerts.length, 0);
  failing = true;
  f.state.now += 1_800_001; // A successful round starts a new outage even after the old deadline.
  await f.keeper.round(); assert.equal(f.keeper.retryDelayMs, 2000); assert.equal(f.state.alerts.length, 0);
});

test('#162 partial market success and a skipped repeated head cannot reset the outage window', async () => {
  const f = fixture();
  const failed = f.observations.find((o) => o.market.symbol === 'COHRB'); assert.ok(failed);
  f.io.balance = async (token) => {
    if (token === failed.market.token) throw new HttpRequestError({ url: 'http://127.0.0.1:1', status: 429 });
    return 10n ** 40n;
  };
  await f.keeper.round(); assert.equal(f.state.swaps.length, 104);
  f.state.now += 2000; await f.keeper.round(); // Repeated head: no successful round.
  f.state.now += 1_798_000;
  f.state.head = { number: 101n, timestamp: BigInt(f.state.now / 1000) };
  await f.keeper.round(); assert.equal(f.state.swaps.length, 208); assert.equal(f.state.alerts.length, 0);
  f.state.now++; await assert.rejects(f.keeper.round(), /halted/); assert.equal(f.state.alerts.length, 1);
});

test('#162 transient recovery retries fresh observations before the script step without duplicate swaps', async () => {
  const f = fixture(); const first = f.observations[0]; assert.ok(first); first.twapE18 = null;
  const second = f.observations[1]; assert.ok(second); second.twapE18 = null;
  const balance = f.io.balance; let failed = false;
  f.io.balance = async (token) => {
    if (token === first.market.token && !failed) { failed = true; throw new SocketClosedError(); }
    return balance(token);
  };
  const swap = f.io.swap;
  f.io.swap = async (o, target, budget) => { await swap(o, target, budget); o.lastObservation = f.state.head.timestamp; };
  await f.keeper.round(); assert.deepEqual(f.state.swaps, [second.market.symbol]);
  f.state.now += 2000; f.state.head = { number: 101n, timestamp: 1062n };
  await f.keeper.round(); assert.deepEqual(f.state.swaps, [second.market.symbol, first.market.symbol]);
  assert.equal(f.state.alerts.length, 0); assert.equal(f.state.pushes.length, 0);
});

test('#162 transient faults across read stages resume from fresh inspection without repeating completed swaps', async () => {
  for (const fault of ['head', 'inspect', 'cash', 'mint preflight', 'swap preflight', 'refresh head', 'refresh inspect', 'push preflight']) {
    const f = fixture(); let failed = false; let heads = 0; let inspections = 0;
    const fail = (at: string) => {
      if (fault === at && !failed) { failed = true; throw new HttpRequestError({ url: 'http://127.0.0.1:1', status: 503 }); }
    };
    const { head, inspect, balance, mint, swap, push } = f.io;
    f.io.head = async () => { fail(++heads === 1 ? 'head' : 'refresh head'); return head(); };
    f.io.inspect = async (block) => { fail(++inspections === 1 ? 'inspect' : 'refresh inspect'); return inspect(block); };
    f.io.balance = async (token) => { if (token === addr(1)) fail('cash'); return balance(token); };
    f.io.mint = async (token, amount) => { fail('mint preflight'); await mint(token, amount); };
    f.io.swap = async (o, target, budget) => {
      fail('swap preflight'); await swap(o, target, budget); o.lastObservation = f.state.head.timestamp;
    };
    f.io.push = async (feed, answer) => { fail('push preflight'); await push(feed, answer); };
    await f.keeper.round(); assert.ok(failed, fault); assert.equal(f.state.alerts.length, 0, fault);
    f.state.now += 2000; f.state.head = { number: 101n, timestamp: 1062n };
    await f.keeper.round(); assert.equal(f.keeper.retryDelayMs, 0, fault);
    assert.equal(f.state.swaps.length, 105, fault); assert.equal(new Set(f.state.swaps).size, 105, fault);
    assert.equal(f.state.alerts.length, 0, fault);
  }
});

test('#162 long partial rounds stop new writes once the first failure exceeds the deadline', async () => {
  const f = fixture(1); const first = f.observations[0]; assert.ok(first);
  f.io.balance = async (token) => {
    if (token === first.market.token) throw new HttpRequestError({ url: 'http://127.0.0.1:1', status: 503 });
    return 10n ** 40n;
  };
  let swaps = 0;
  f.io.swap = async () => { swaps++; f.state.now += 2000; };
  await assert.rejects(f.keeper.round(), /halted/);
  assert.equal(swaps, 1, 'no new swaps after the outage deadline');
  assert.match(f.state.logs.join('\n'), /RPC failure timeout exceeded/); assert.equal(f.state.alerts.length, 1);
});

test('#162 a failed post-mint balance check halts instead of losing the exact target validation', async () => {
  const f = fixture(); const first = f.observations[0]; assert.ok(first);
  const balance = f.io.balance;
  f.io.balance = async (token) => {
    if (token === first.market.token && f.state.mints.includes(token)) throw new HttpRequestError({ url: 'https://private-token.invalid/key', status: 503 });
    return balance(token);
  };
  await assert.rejects(f.keeper.round(), /halted/);
  assert.equal(f.state.mints.length, 1); assert.equal(f.state.swaps.length, 0); assert.equal(f.state.alerts.length, 1);
  await assert.rejects(f.keeper.round(), /stopped/);
  assert.match(f.state.logs.join('\n'), /mint balance verification unavailable/);
  assert.doesNotMatch(f.state.logs.join('\n'), /private-token|https:/);
});

test('#162 classification retries only transport/node faults, traverses wrappers and never hides a permanent cause', async () => {
  const rpc = (code: number, message: string, data?: string) => new RpcRequestError({ body: {}, url: 'https://private-token.invalid/key', error: { code, message, ...(data ? { data } : {}) } });
  const transient = [new TimeoutError({ body: {}, url: 'http://127.0.0.1:1' }), new SocketClosedError(),
    ...[undefined, 408, 429, 500, 599].map((status) => new HttpRequestError({ url: 'http://127.0.0.1:1', ...(status ? { status } : {}) })),
    ...[-32603, -32002, -32005].map((code) => rpc(code, 'private-token')),
    rpc(-32000, 'rate limit private-token'), rpc(-32000, 'node unavailable private-token'),
    Object.assign(new Error('private-token'), { code: 'ECONNRESET' })];
  for (const error of transient) {
    assert.equal(isTransientRpcError(new Error('private-token wrapper', { cause: error })), true);
    const f = fixture(); f.io.head = async () => { throw error; };
    await f.keeper.round(); assert.equal(f.state.alerts.length, 0); assert.equal(f.keeper.retryDelayMs, 2000);
    assert.doesNotMatch(f.state.logs.join('\n'), /private-token|https:/);
  }
  const permanent = [new Error('private-token'),
    ...[400, 401, 403, 404].map((status) => new HttpRequestError({ url: 'http://127.0.0.1:1', status })),
    rpc(-32000, 'invalid input'), rpc(-32602, 'invalid params'), rpc(3, 'execution reverted'),
    rpc(-32603, 'execution reverted'), rpc(-32005, 'rate limit', '0x12345678'),
    new ContractFunctionRevertedError({ abi: parseAbi(['function fail()']), functionName: 'fail', data: '0x' }),
    new Error('transaction not confirmed', { cause: transient[0] }),
    ...['swap result mismatch', 'feed unavailable', 'market configuration mismatch', 'invalid timeline'].map((message) => new Error(message))];
  for (const error of permanent) {
    assert.equal(isTransientRpcError(error), false);
    const f = fixture(); f.io.head = async () => { throw error; };
    await assert.rejects(f.keeper.round(), /halted/); assert.equal(f.state.alerts.length, 1);
    await assert.rejects(f.keeper.round(), /stopped/); assert.equal(f.state.alerts.length, 1);
  }
  const wrapped = new HttpRequestError({ url: 'http://127.0.0.1:1', cause: new Error('swap result mismatch') });
  assert.equal(isTransientRpcError(wrapped), false);
  assert.doesNotMatch(safeReason(new Error('private-token')), /private-token/);
});

test('#162 RPC outage settings validate zero, exact limits and invalid input without echoing values', () => {
  const env = { PRICE_KEEPER_ENABLED: '1', PRICE_KEEPER_RPC_URL: 'http://127.0.0.1:8562', PRICE_KEEPER_MANIFEST: 'manifest.json',
    PRICE_KEEPER_SCENARIO: 'scenario.json', PRICE_KEEPER_START_TIMESTAMP: '1000', PRICE_KEEPER_PRIVATE_KEY: `0x${'0'.repeat(63)}1` };
  assert.equal(loadKeeperSettings(env)?.settings.rpcFailureTimeoutSeconds, 1800);
  for (const value of [1, 86_400]) {
    assert.equal(loadKeeperSettings({ ...env, PRICE_KEEPER_RPC_FAILURE_TIMEOUT_SECONDS: String(value) })?.settings.rpcFailureTimeoutSeconds, value);
    const retry = new RpcRetry(value, () => 0); assert.equal(retry.fail(), 2000);
  }
  for (const value of [0, -1, 86_401, 1.5, NaN, Infinity]) assert.throws(() => new RpcRetry(value));
  for (const value of ['', '0', '-1', '86401', '1.5', 'Infinity', '1e3', 'private-token']) {
    assert.throws(() => loadKeeperSettings({ ...env, PRICE_KEEPER_RPC_FAILURE_TIMEOUT_SECONDS: value }), (error: unknown) => {
      assert.ok(error instanceof Error); assert.match(error.message, /PRICE_KEEPER_RPC_FAILURE_TIMEOUT_SECONDS/);
      assert.doesNotMatch(error.message, /private-token/); return true;
    });
  }
});

test('keeper observes frequency across restart via on-chain timestamps and bounds catch-up', async () => {
  const { state, observations, keeper } = fixture();
  for (const o of observations) o.lastObservation = 1001n;
  await keeper.round(); assert.equal(state.swaps.length, 0);
  state.head = { number: 101n, timestamp: 1120n }; state.now += 60_000;
  await keeper.round(); assert.equal(state.swaps.length, 105);
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
  assert.equal(state.swaps.length, 105); assert.equal(state.pushes.length, 0); assert.equal(state.inspections, 1);
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

test('#139 all 105 unavailable TWAPs receive only a 1 bp recovery swap, then normal validation and feed pushes resume', async () => {
  const f = fixture(); f.state.head = { number: 200n, timestamp: 200_000n }; f.state.now = 200_000_000;
  const prices = f.observations.map((o) => o.spotE18);
  for (const o of f.observations) o.twapE18 = null;
  await f.keeper.round();
  assert.equal(f.state.swaps.length, 105); assert.equal(new Set(f.state.swaps).size, 105);
  assert.deepEqual(f.state.targets, prices.map((p) => p * 10_001n / 10_000n));
  assert.equal(f.state.pushes.length, 0); assert.equal(f.state.inspections, 1); assert.equal(f.state.alerts.length, 0);
  await f.keeper.round(); assert.equal(f.state.swaps.length, 105);
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
  for (const error of [new Error('transaction not confirmed', { cause: new TimeoutError({ body: {}, url: 'https://private-token.invalid/key' }) }),
    new RpcRequestError({ body: {}, url: 'https://private-token.invalid/key', error: { code: -32000, message: 'seed=private-token' } }),
    new HttpRequestError({ url: 'https://private-token.invalid/key', status: 401, details: 'seed=private-token' })]) {
    const f = fixture(); f.io.head = async () => { throw error; };
    await assert.rejects(f.keeper.round(), /halted/);
    const output = f.state.logs.join('\n') + f.state.alerts.join('\n');
    assert.match(output, /head/);
    if (error instanceof HttpRequestError) assert.match(output, /HttpRequestError.*401/);
    if (error.cause instanceof TimeoutError) assert.match(output, /transaction not confirmed.*TimeoutError/);
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
  assert.equal(f.state.swaps.length, 105); assert.equal(f.state.pushes.length, 0);
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
    assert.equal(f.state.swaps.length, 105, mode + ' exact threshold');
    assert.equal(new Set(f.state.swaps).size, 105);
    f.state.targets.forEach((price, i) => {
      const o = f.observations[i]; assert.ok(o);
      assert.ok(price < o.spotE18);
      assert.ok((o.spotE18 - price) * 10_000n <= o.spotE18 * BigInt(f.scenario.maxStepBps));
      o.spotE18 = price; o.lastObservation = 2800n;
    });
    f.state.head = { number: 103n, timestamp: 4599n }; f.state.now = 4_599_000;
    await restarted.round(); assert.equal(f.state.swaps.length, 105, mode + ' no early maintenance');
    for (const o of f.observations) if (o.market.feed) o.feedUpdatedAt = 4599n;
    f.state.head = { number: 104n, timestamp: 4660n }; f.state.now = 4_660_000;
    await restarted.round(); assert.equal(f.state.swaps.length, 210);
    f.state.targets.slice(105).forEach((price, i) => { const o = f.observations[i]; assert.ok(o); assert.ok(price > o.spotE18); });
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
    await keeper.round(); assert.equal(f.state.swaps.length, 105);
    await keeper.round(); assert.equal(f.state.swaps.length, 105);
    f.state.targets.forEach((p, i) => { const o = f.observations[i]; assert.ok(o); assert.ok(p < o.spotE18); assert.ok((o.spotE18 - p) * 10_000n <= o.spotE18 * BigInt(maxStepBps)); });
  }
});

test('#187 feed sets refresh at half the shorter of feed/cash max age, not every scenario step', () => {
  const { observations } = fixture();
  const hourly = observations.find((o) => o.market.feed && o.market.maxFeedAge === 3600);
  const daily = observations.find((o) => o.market.feed && o.market.maxFeedAge === 86_400);
  const stock = observations.find((o) => !o.market.feed);
  assert.ok(hourly && daily && stock && hourly.twapE18 !== null);
  for (const o of [hourly, daily]) {
    // Exactly at the published TWAP: only age can make the set due.
    const at = { ...o, feedUpdatedAt: 10_000n, feedAnswerE8: (o.twapE18 ?? 0n) / 10n ** 10n };
    assert.equal(feedDue(at, 11_799n, 60), false, o.market.symbol + ' one second early');
    assert.equal(feedDue(at, 11_800n, 60), true, o.market.symbol + ' exact half of the cash max age');
    assert.equal(feedDue(at, 13_600n, 60), true, o.market.symbol + ' expired');
  }
  assert.equal(feedDue({ ...stock, feedUpdatedAt: null }, 99_999n, 60), false);
  // A scenario step longer than half the max age still bounds the cadence from below.
  assert.equal(feedDue({ ...hourly, feedUpdatedAt: 0n }, 1799n, 1900), false);
  assert.equal(feedDue({ ...hourly, feedUpdatedAt: 0n }, 1900n, 1900), true);
});

test('#187 TWAP drift republishes at exactly 100 bps, once a step has passed, and never on unknown data', () => {
  const { observations } = fixture();
  const o = observations.find((candidate) => candidate.market.feed); assert.ok(o);
  const answer = 100_000_000_000n; // 1000.00000000
  const at = (twapE8: bigint, age: bigint, extra: Partial<Observation> = {}) =>
    feedDue({ ...o, twapE18: twapE8 * 10n ** 10n, feedUpdatedAt: 5_000n, feedAnswerE8: answer, ...extra }, 5_000n + age, 60);
  assert.equal(at(answer * 10_099n / 10_000n, 60n), false, '99 bps up');
  assert.equal(at(answer * 10_100n / 10_000n, 60n), true, '100 bps up');
  assert.equal(at(answer * 9_901n / 10_000n, 60n), false, '99 bps down');
  assert.equal(at(answer * 9_900n / 10_000n, 60n), true, '100 bps down');
  assert.equal(at(answer * 10_500n / 10_000n, 59n), false, 'drift inside the current step');
  assert.equal(at(answer * 10_500n / 10_000n, 60n, { twapE18: null }), false, 'TWAP unavailable');
  assert.equal(at(answer * 10_500n / 10_000n, 60n, { feedAnswerE8: null }), false, 'no answer');
  assert.equal(at(answer * 10_500n / 10_000n, 60n, { feedAnswerE8: undefined }), false, 'unknown answer');
  assert.equal(at(answer * 10_500n / 10_000n, 60n, { feedAnswerE8: 0n }), false, 'zero answer');
});

test('#187 held markets with feeds at their TWAP push nothing until the oldest feed is 1800 seconds old', async () => {
  const f = fixture(); f.scenario.timeline = [{ steps: 1, mode: 'closed', stepBps: 0 }];
  for (const o of f.observations) {
    o.lastObservation = 1000n;
    if (o.market.feed) { o.feedUpdatedAt = 1000n; o.feedAnswerE8 = (o.twapE18 ?? 0n) / 10n ** 10n; }
  }
  f.state.head = { number: 101n, timestamp: 2799n }; f.state.now = 2_799_000;
  await f.keeper.round();
  assert.equal(f.state.pushes.length, 0); assert.equal(f.state.swaps.length, 0);
  // The per-step round gate would skip a second round one second later; a fresh process sees the exact boundary.
  const restarted = new PriceKeeper(f.io, f.scenario, addr(1), addr(2), {
    start: 1000n, minimumUsdtE18: 10_000n * unit, inventoryUsdtE18: 100_000n * unit, swapBudgetUsdtE18: 10_000n * unit, stallSeconds: 90,
  }, () => {}, async () => {}, () => f.state.now);
  f.state.head = { number: 102n, timestamp: 2800n }; f.state.now = 2_800_000;
  await restarted.round();
  assert.equal(f.state.pushes.length, 12); assert.equal(f.state.pushes[0], 100_000_000n);
  assert.equal(f.state.swaps.length, 105);
});

test('#187 maintenance interval: default 1800, configurable within 600-3000, invalid values rejected', async () => {
  assert.equal(maintenanceSeconds(undefined), 1800);
  for (const value of [600, 2400, 3000]) assert.equal(maintenanceSeconds(value), value);
  for (const value of [0, 599, 3001, 1800.5, Number.NaN]) assert.throws(() => maintenanceSeconds(value), /between 600 and 3000/);
  const env = { PRICE_KEEPER_ENABLED: '1', PRICE_KEEPER_RPC_URL: 'http://127.0.0.1:8557', PRICE_KEEPER_MANIFEST: 'manifest.json',
    PRICE_KEEPER_SCENARIO: 'scenario.json', PRICE_KEEPER_START_TIMESTAMP: '1000', PRICE_KEEPER_PRIVATE_KEY: `0x${'0'.repeat(63)}1` };
  assert.equal(loadKeeperSettings(env)?.settings.maintenanceSeconds, 1800);
  assert.equal(loadKeeperSettings({ ...env, PRICE_KEEPER_MAINTENANCE_SECONDS: '2400' })?.settings.maintenanceSeconds, 2400);
  for (const value of ['', '599', '3001', '2400.0', '-1', 'abc', ' 2400']) {
    assert.throws(() => loadKeeperSettings({ ...env, PRICE_KEEPER_MAINTENANCE_SECONDS: value }), /between 600 and 3000/, value);
  }
  const f = fixture(); f.scenario.timeline = [{ steps: 1, mode: 'closed', stepBps: 0 }];
  const keeper = new PriceKeeper(f.io, f.scenario, addr(1), addr(2), {
    start: 1000n, minimumUsdtE18: 10_000n * unit, inventoryUsdtE18: 100_000n * unit,
    swapBudgetUsdtE18: 10_000n * unit, stallSeconds: 90, maintenanceSeconds: 2400,
  }, () => {}, async () => {}, () => f.state.now);
  f.state.head = { number: 101n, timestamp: 3399n }; f.state.now = 3_399_000;
  await keeper.round(); assert.equal(f.state.swaps.length, 0, 'one second before 2400');
  const fresh = new PriceKeeper(f.io, f.scenario, addr(1), addr(2), {
    start: 1000n, minimumUsdtE18: 10_000n * unit, inventoryUsdtE18: 100_000n * unit,
    swapBudgetUsdtE18: 10_000n * unit, stallSeconds: 90, maintenanceSeconds: 2400,
  }, () => {}, async () => {}, () => f.state.now);
  f.state.head = { number: 102n, timestamp: 3400n }; f.state.now = 3_400_000;
  await fresh.round(); assert.equal(f.state.swaps.length, 105, 'exactly 2400');
  assert.throws(() => new PriceKeeper(f.io, f.scenario, addr(1), addr(2), {
    start: 1000n, minimumUsdtE18: 10_000n * unit, inventoryUsdtE18: 100_000n * unit,
    swapBudgetUsdtE18: 10_000n * unit, stallSeconds: 90, maintenanceSeconds: 3001,
  }, () => {}, async () => {}), /between 600 and 3000/);
});
