import assert from 'node:assert/strict';
import { test } from 'node:test';
import { annualizedReturn, calculateModel, DAY_MS, emptyModel, lastClosedDay, MAX_NAV_POINTS, MODEL_ANNUALIZED_MIN_DAYS } from '../src/model-returns/calculation.js';
import type { ClosePoint } from '../src/model-returns/calculation.js';
import { collectCloses, createCloseJob, klineUrl, loadCloseConfig, parseKlines } from '../src/model-returns/collector.js';
import { MODEL_ASSETS, modelSymbol } from '../src/model-returns/catalogue.js';
import { createModelReader, currentWeights } from '../src/model-returns/service.js';
import type { ModelStrategy } from '../src/model-returns/service.js';
import { createInfoGet, MAX_SOURCE_BYTES } from '../src/info/source.js';
import { createInfoBackgroundJob } from '../src/info/job.js';
import { TESTNET_97 } from '../src/testnet-profile.js';
import { createServer } from '../src/server.js';
import { loadRateLimitConfig } from '../src/config.js';
import { MemoryRateLimitStore, RequestRateLimiter } from '../src/ratelimit.js';
import { getStrategyWithVersionState } from '../src/strategies.js';

const now = new Date('2026-11-20T12:00:00Z');
const asOf = '2026-11-19';
const assetA = MODEL_ASSETS.find(a => a.symbol === 'AAPLB');
const assetB = MODEL_ASSETS.find(a => a.symbol === 'NVDAB');
assert.ok(assetA && assetB);
const weights = [{ symbol: 'AAPLB', weightBps: 5000 }, { symbol: 'NVDAB', weightBps: 5000 }];
const date = (start: string, index: number) => new Date(Date.parse(start) + index * DAY_MS).toISOString().slice(0, 10);
function points(count: number, value = '100', start = date(asOf, 1 - count)): ClosePoint[] {
  return Array.from({ length: count }, (_, index) => ({ date: date(start, index), value }));
}
const strategy: ModelStrategy = { id: 1, onchainId: null, versions: [{ version: 1, activeAt: '2026-11-01T00:00:00Z', allocation: {
  assets: [{ address: assetA.address, symbol: 'spoof', weightBps: 5000 }, { address: assetB.address, weightBps: 5000 },
    { address: TESTNET_97.contracts.usdt, weightBps: 0 }],
} }] };

test('#173 daily target-weight rebalancing compounds returns and preserves positive/negative rounding at half threshold', () => {
  const a = points(8), b = points(8);
  a[1] = { date: date(asOf, -6), value: '200' };
  const result = calculateModel(weights, new Map([['AAPLB', a], ['NVDAB', b]]), asOf);
  // Equal weight: +50%, then -25%, then flat => 1.125 (buy-and-hold would be 1).
  assert.equal(result.modelReturns?.d7, '12.50000000'); assert.equal(result.modelReturns?.all, '12.50000000');
  assert.equal(result.modelReturns?.d30, null); assert.equal(result.modelNav[0]?.value, '1.000000000000');
  assert.equal(result.modelNav.at(-1)?.value, '1.125000000000');
  for (const [close, expected] of [['100.000000005', '0.00000001'], ['99.999999995', '-0.00000001'], ['100.0000000049', '0.00000000']]) {
    const data = points(8); assert.ok(close); data[7] = { date: asOf, value: close };
    assert.equal(calculateModel([{ symbol: 'A', weightBps: 10000 }], new Map([['A', data]]), asOf).modelReturns?.d7, expected);
  }
});

test('#173 exact 7/30/90/365-day boundaries need N+1 closes, zero return is valid and insufficient history is null', () => {
  for (const [days, field] of [[7, 'd7'], [30, 'd30'], [90, 'd90'], [365, 'y1']] as const) {
    for (const count of [days, days + 1]) {
      const result = calculateModel([{ symbol: 'A', weightBps: 10000 }], new Map([['A', points(count)]]), asOf);
      assert.equal(result.modelReturns?.[field], count === days ? null : '0.00000000');
    }
  }
  assert.deepEqual(calculateModel(weights, new Map(), asOf), emptyModel());
  assert.deepEqual(calculateModel([{ symbol: 'A', weightBps: 10000 }], new Map([['A', points(1)]]), asOf), emptyModel());
});

test('#173 missing component/day, malformed/zero/negative price, duplicates and invalid weights never produce partial returns', () => {
  const data = points(40);
  const missing = data.filter((_, i) => i !== 5);
  const recent = calculateModel(weights, new Map([['AAPLB', data], ['NVDAB', missing]]), asOf);
  assert.equal(recent.modelReturns?.d7, '0.00000000'); assert.equal(recent.modelReturns?.all, null); assert.deepEqual(recent.modelNav, []);
  for (const broken of [[], data.slice(0, -1), data.filter((_, i) => i !== 38)]) {
    const result = calculateModel(weights, new Map([['AAPLB', data], ['NVDAB', broken]]), asOf);
    assert.equal(result.modelReturns?.d7 ?? null, null);
  }
  for (const value of ['0', '-1', 'NaN', 'Infinity', '1e3', '1.' + '1'.repeat(37), '9'.repeat(101)]) {
    assert.deepEqual(calculateModel([{ symbol: 'A', weightBps: 10000 }], new Map([['A', points(8, value)]]), asOf), emptyModel());
  }
  assert.deepEqual(calculateModel(weights, new Map([['AAPLB', data], ['NVDAB', [...data, ...data]]]), asOf), emptyModel());
  for (const weightBps of [0, -1, 9999, 10001, 1.5]) assert.deepEqual(calculateModel([{ symbol: 'A', weightBps }], new Map([['A', data]]), asOf), emptyModel());
});

test('#173 annualized compounds modelNav head/tail over actual days, null under the minimum span or when unprintable', () => {
  const min = MODEL_ANNUALIZED_MIN_DAYS;
  const nav = (span: number, first: string, last: string, middle = '7') => [{ date: date(asOf, -span), value: first },
    ...(span > 1 ? [{ date: date(asOf, -1), value: middle }] : []), { date: asOf, value: last }];
  assert.equal(annualizedReturn(nav(365, '1.000000000000', '2.000000000000')), '100.00000000');
  assert.equal(annualizedReturn(nav(730, '1.000000000000', '0.500000000000')), '-29.28932188');
  assert.equal(annualizedReturn(nav(730, '2.000000000000', '8.000000000000')), '100.00000000');
  assert.equal(annualizedReturn(nav(min - 1, '1.000000000000', '2.000000000000')), null);
  assert.equal(annualizedReturn(nav(min, '1.000000000000', '1.000000000000')), '0.00000000');
  assert.equal(annualizedReturn(nav(min, '1.000000000000', '0.999999000000')), ((0.999999 ** (365 / min) - 1) * 100).toFixed(8));
  assert.equal(annualizedReturn(nav(min, '1.000000000000', '0.999999999999')), '0.00000000'); // never "-0.00000000".
  assert.equal(annualizedReturn([]), null);
  assert.equal(annualizedReturn(nav(min, '1.000000000000', '1000000.000000000000')), null);
  for (const broken of ['0', '-1', 'x']) assert.equal(annualizedReturn(nav(min, broken, '1')), null);
  const history = points(366); history[0] = { date: date(asOf, -365), value: '50' };
  const result = calculateModel([{ symbol: 'A', weightBps: 10000 }], new Map([['A', history]]), asOf);
  assert.equal(result.modelReturns?.all, '100.00000000'); assert.equal(result.modelReturns?.annualized, '100.00000000');
  assert.equal(calculateModel([{ symbol: 'A', weightBps: 10000 }], new Map([['A', points(min)]]), asOf).modelReturns?.annualized, null);
  assert.equal(calculateModel([{ symbol: 'A', weightBps: 10000 }], new Map([['A', points(min + 1)]]), asOf).modelReturns?.annualized, '0.00000000');
});

test('#173 model NAV is ascending, capped to two calendar years, excludes current/future day and ALL retains inception', () => {
  const data = points(1000), start = data[0]; assert.ok(start);
  start.value = '50';
  const result = calculateModel([{ symbol: 'A', weightBps: 10000 }], new Map([['A', [...data, { date: '2026-11-20', value: '9999' }]]]), asOf);
  assert.equal(result.modelReturns?.all, '100.00000000');
  assert.equal(result.modelNav.length, MAX_NAV_POINTS); assert.equal(result.modelNav[0]?.date, '2024-11-19');
  assert.equal(result.modelNav.at(-1)?.date, asOf); assert.equal(result.modelNav[0]?.value, '2.000000000000');
  // annualized follows the App: modelNav head/tail (flat 2.0 here), not the uncapped ALL history.
  assert.equal(result.modelReturns?.annualized, '0.00000000');
  for (const instant of ['2026-11-20T00:00:00.000Z', '2026-11-20T23:59:59.999Z']) assert.equal(lastClosedDay(new Date(instant)), asOf);
  assert.equal(lastClosedDay(new Date('2026-11-21T00:00:00Z')), '2026-11-20');
  const leap = calculateModel([{ symbol: 'A', weightBps: 10000 }], new Map([['A', points(1000, '1', '2021-06-05')]]), '2024-02-29');
  assert.ok(leap.modelNav.length <= MAX_NAV_POINTS);
});

test('#173 current effective weights override old weights, ignore pending/cancelled versions and resolve addresses instead of display symbols', async () => {
  assert.deepEqual(currentWeights(strategy, 56, now), weights);
  const version = strategy.versions[0]; assert.ok(version);
  const changed = { ...version, version: 2, allocation: { assets: [{ address: assetA.address, weightBps: 10000 }] } };
  const latest: ModelStrategy = { ...strategy, versions: [version, changed, { ...version, version: 3, activeAt: '2027-01-01T00:00:00Z' }] };
  assert.deepEqual(currentWeights(latest, 56, now), [{ symbol: 'AAPLB', weightBps: 10000 }]);
  const chain = { ...latest, onchainId: 1, versions: [{ ...version, status: 'active' }, { ...changed, status: 'cancelled' }] };
  assert.deepEqual(currentWeights(chain, 56, now), weights);
  assert.equal(currentWeights({ ...chain, versions: [{ ...changed, status: 'pending' }] }, 56, now), null);
  assert.equal(modelSymbol('0x0000000000000000000000000000000000000173', 56), null);
  assert.equal(modelSymbol(TESTNET_97.assets.NVDAB.token, 97), 'NVDAB');
  const rows = [...points(8).map((p, i) => ({ series: 'close:AAPLB', date: p.date, value: i === 7 ? '200' : p.value })),
    ...points(8).map(p => ({ series: 'close:NVDAB', ...p }))];
  let reads = 0;
  const read = createModelReader({ chainId: 56, now: () => now, query: async (_sql, params) => {
    reads++; assert.deepEqual(params, [reads === 1 ? ['close:AAPLB', 'close:NVDAB'] : ['close:AAPLB'], asOf]); return { rows };
  } });
  assert.equal((await read([strategy])).get(1)?.modelReturns?.d7, '50.00000000');
  assert.equal((await read([latest])).get(1)?.modelReturns?.d7, '100.00000000');
  assert.equal(reads, 2);
  const failed = createModelReader({ chainId: 56, now: () => now, query: async () => { throw new Error('SECRET_DB'); } });
  assert.deepEqual((await failed([strategy])).get(1), emptyModel());
});

function candle(at: number, value = '100.00000000'): unknown[] { return [at, '1', '1', '1', value, '1', at + DAY_MS - 1, '1', 1, '1', '1', '0']; }
test('#173 Binance klines preserve close decimals, paginate at exactly 1000 and exclude incomplete candles', async () => {
  const end = Date.parse(asOf) + DAY_MS - 1;
  const open = Date.parse(asOf);
  assert.equal(parseKlines(JSON.stringify([candle(open)]), 0, end)[0]?.value, '100.00000000');
  for (const raw of ['{}', 'broken', JSON.stringify([candle(open), candle(open)]), JSON.stringify([candle(open, '0')]),
    JSON.stringify([candle(open + 1)]), JSON.stringify([candle(open + DAY_MS)])]) assert.throws(() => parseKlines(raw, 0, end));
  // Live BTCUSDT/BNBUSDT shape: Binance halted on 2018-02-08 and that 1d candle closes at 00:28:14.788 UTC.
  const halted = Date.parse('2018-02-08'), short = [halted, '1', '1', '1', '8100.00', '1', halted + 1_694_788, '1', 1, '1', '1', '0'];
  assert.deepEqual(parseKlines(JSON.stringify([short, candle(halted + DAY_MS)]), 0, end).map(p => [p.date, p.value]),
    [['2018-02-08', '8100.00'], ['2018-02-09', '100.00000000']]);
  for (const closeAt of [halted - 1, halted + DAY_MS]) {
    assert.throws(() => parseKlines(JSON.stringify([[...short.slice(0, 6), closeAt, ...short.slice(7)]]), 0, end), /invalid_klines/);
  }
  assert.throws(() => klineUrl('../secret', 0, end));
  const first = Date.parse('2020-01-01'), requested: string[] = [];
  const batch = await collectCloses({ symbol: 'AAPLB', pair: 'AAPLBUSDT' }, async url => {
    requested.push(url); return JSON.stringify(requested.length === 1 ? Array.from({ length: 1000 }, (_, i) => candle(first + i * DAY_MS)) : [candle(first + 1000 * DAY_MS)]);
  }, now);
  assert.equal(batch.markets.length, 1001); assert.equal(requested.length, 2);
  assert.match(requested[1] ?? '', new RegExp(`startTime=${first + 1000 * DAY_MS}`));
  assert.ok(batch.markets.every(p => p.series === 'close:AAPLB' && p.source === 'binance'));
});

test('#173 daily opt-in job checks pairs, isolates source/DB failures, bounds timing and logs fixed codes only', async () => {
  assert.equal(loadCloseConfig({}), false); assert.equal(loadCloseConfig({ MODEL_RETURNS_ENABLED: '0' }), false);
  assert.throws(() => loadCloseConfig({ MODEL_RETURNS_ENABLED: 'yes' }), /MODEL_RETURNS_ENABLED/);
  assert.deepEqual(await createCloseJob({ env: {}, lock: async () => assert.fail('disabled') })(), []);
  let time = now.getTime(), calls = 0;
  const logs: unknown[] = [];
  const job = createCloseJob({ env: { MODEL_RETURNS_ENABLED: '1' }, now: () => new Date(time), lock: action => action(),
    assets: [{ symbol: 'MISSING', pair: 'MISSINGUSDT' }, { symbol: 'FAIL', pair: 'FAILUSDT' }, { symbol: 'AAPLB', pair: 'AAPLBUSDT' }],
    get: () => async url => {
      calls++;
      if (url.endsWith('ticker/price')) return JSON.stringify(['AAPLBUSDT', 'FAILUSDT'].map(symbol => ({ symbol, price: '1.00' })));
      if (url.includes('FAILUSDT')) throw new Error('SECRET_RPC');
      return JSON.stringify([candle(Date.parse(asOf))]);
    }, save: async batch => ({ events: 0, markets: batch.markets.length }), log: result => logs.push(result) });
  const [first, overlap] = await Promise.all([job(), job()]); assert.deepEqual(overlap, []);
  assert.deepEqual(first.map(r => r.error), ['pair_not_found', 'dependency_unavailable', null]);
  assert.equal(first[2]?.savedMarkets, 1); assert.doesNotMatch(JSON.stringify(logs), /SECRET/);
  const before = calls; time += DAY_MS - 1; await job(); assert.equal(calls, before);
  time++; await job(); assert.ok(calls > before);
  const failed = await createCloseJob({ env: { MODEL_RETURNS_ENABLED: '1' }, now: () => now, lock: action => action(),
    assets: [{ symbol: 'AAPLB', pair: 'AAPLBUSDT' }], get: () => async url => url.endsWith('ticker/price')
      ? '[{"symbol":"AAPLBUSDT","price":"1.00"}]' : '[]',
    save: async () => { throw new Error('SECRET_DB'); }, log: () => {} })();
  assert.equal(failed[0]?.error, 'dependency_unavailable');
  const seen: string[] = [];
  await createInfoBackgroundJob(async () => { seen.push('info'); throw new Error('SECRET'); }, async () => { seen.push('draft'); },
    () => {}, async () => { seen.push('closes'); })();
  assert.deepEqual(seen, ['info', 'draft', 'closes']);
});

test('#173 pair listing fits the real source byte cap (unfiltered exchangeInfo is ~18 MB) and a missing pair stays isolated', async () => {
  const requested: string[] = [];
  // Emulates live Binance through the real createInfoGet byte cap: the full exchangeInfo body exceeds MAX_SOURCE_BYTES.
  const send = async (raw: string) => {
    const url = new URL(raw); requested.push(url.pathname);
    if (url.pathname === '/api/v3/exchangeInfo') return new Response('x'.repeat(MAX_SOURCE_BYTES + 1));
    if (url.pathname === '/api/v3/ticker/price') return new Response(JSON.stringify(['AAPLBUSDT', 'BTCUSDT'].map(symbol => ({ symbol, price: '1.00' }))));
    if (url.pathname === '/api/v3/klines') return new Response(JSON.stringify([candle(Date.parse(asOf))]));
    return new Response('', { status: 404 });
  };
  const results = await createCloseJob({ env: { MODEL_RETURNS_ENABLED: '1' }, now: () => now, lock: action => action(), log: () => {},
    assets: [{ symbol: 'AAPLB', pair: 'AAPLBUSDT' }, { symbol: 'GONEB', pair: 'GONEBUSDT' }, { symbol: 'BTCB', pair: 'BTCUSDT' }],
    get: () => createInfoGet(send, 1000, 5000, Date.now, ['data-api.binance.vision']),
    save: async batch => ({ events: 0, markets: batch.markets.length }) })();
  assert.deepEqual(results.map(r => [r.collector, r.error, r.savedMarkets]),
    [['close:AAPLB', null, 1], ['close:GONEB', 'pair_not_found', 0], ['close:BTCB', null, 1]]);
  assert.ok(!requested.includes('/api/v3/exchangeInfo'));
  assert.equal(requested.filter(path => path === '/api/v3/klines').length, 2);
  for (const body of ['{}', '[{"price":"1"}]', '[{"symbol":1}]']) {
    const broken = createCloseJob({ env: { MODEL_RETURNS_ENABLED: '1' }, now: () => now, lock: action => action(), log: () => {},
      assets: [{ symbol: 'AAPLB', pair: 'AAPLBUSDT' }], get: () => async () => body, save: async () => assert.fail('no save') });
    await assert.rejects(broken(), /invalid_format|missing_field/);
  }
});

test('#173 Binance GET uses HTTPS host boundary, bounds bytes/time and never exposes upstream bodies', async () => {
  const make = (send: (url: string, init: RequestInit) => Promise<Response>, timeout = 15) => createInfoGet(send, timeout, 1000, Date.now, ['data-api.binance.vision']);
  const url = klineUrl('AAPLBUSDT', 0, Date.now());
  for (const status of [400, 403, 429, 500]) await assert.rejects(make(async () => new Response('SECRET', { status }))(url), new RegExp(`http_${status}`));
  await assert.rejects(make(async () => { throw new Error('SECRET'); })(url), /network_unavailable/);
  await assert.rejects(make(async (_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('SECRET')), { once: true })), 5)(url), /timeout/);
  await assert.rejects(make(async () => new Response('[]'))('https://evil.example/'), /invalid_source_url/);
  await assert.rejects(make(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }))(url), /invalid_source_url/);
});

test('#173 HTTP detail adds model fields and model failure leaves original metadata, versions and other APIs usable', async () => {
  for (const failure of [false, true]) {
    const api = createServer({
      strategyDetail: id => getStrategyWithVersionState(id, { strategy: async () => ({ id, provider: 'owner', name: 'Model', description: '',
        isPublic: true, category: null, catalogKey: null, swapFeeBps: 0, onchainId: null, createdAt: now.toISOString(), versions: [] }) }),
      modelReturns: async () => { if (failure) throw new Error('SECRET'); return new Map([[1, { modelReturns: { asOf, d7: '0.00000000', d30: null, d90: null, y1: null, all: '0.00000000', annualized: null }, modelNav: [{ date: asOf, value: '1.000000000000' }] }]]); },
      strategyExposure: async () => [], rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore()),
    });
    await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
    const address = api.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const response = await fetch(base + '/strategies/1'); assert.equal(response.status, 200);
      const body: unknown = await response.json(); assert.ok(typeof body === 'object' && body !== null);
      assert.equal(Reflect.get(body, 'name'), 'Model'); assert.deepEqual(Reflect.get(body, 'versions'), []);
      assert.equal(Reflect.get(body, 'modelReturns') === null, failure);
      assert.equal((await fetch(base + '/does-not-exist')).status, 404); assert.doesNotMatch(JSON.stringify(body), /SECRET/);
    } finally { await new Promise<void>(resolve => api.close(() => resolve())); }
  }
});
