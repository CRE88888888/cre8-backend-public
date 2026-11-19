import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from '../src/server.js';
import { AppError, UnauthorizedError, ValidationError } from '../src/errors.js';
import { MemoryRateLimitStore, RequestRateLimiter } from '../src/ratelimit.js';
import { loadRateLimitConfig } from '../src/config.js';
import { affectedFunds, readInfoCatalogue } from '../src/info/catalogue.js';
import { createInfoService, parseInfoFilters } from '../src/info/service.js';
import type { InfoFilters } from '../src/info/service.js';
import { TESTNET_97 } from '../src/testnet-profile.js';

const operator = '0x0000000000000000000000000000000000000159';
const other = '0x0000000000000000000000000000000000000160';
const funds = [{ id: '1', name: 'Tech', assetSymbols: ['NVDAB', 'MSFTB', 'BTCB'] }, { id: '2', name: 'Bitcoin', assetSymbols: ['BTC'] }];

test('#159 info query validation bounds 1/100, dates, equal threshold, category/fund/include and rejects bad input', () => {
  assert.equal(parseInfoFilters(new URLSearchParams()).limit, 50);
  for (const limit of ['1', '100']) assert.equal(parseInfoFilters(new URLSearchParams({ limit })).limit, Number(limit));
  for (const limit of ['0', '-1', '101', '1.5', 'nan', 'Infinity', '1e2', '']) assert.throws(() => parseInfoFilters(new URLSearchParams({ limit })), ValidationError);
  for (const category of ['economy', 'company', 'person']) assert.equal(parseInfoFilters(new URLSearchParams({ category })).category, category);
  const invalidQueries: Record<string, string>[] = [{ category: 'invalid' }, { include: 'published' }, { from: '2026-02-30' }, { from: '2026-01-01T00:00:00' },
    { to: 'invalid' }, { from: '2026-11-21', to: '2026-11-20' }, { fund: '0' }, { fund: '-1' }, { fund: '1; drop table info_events' }, { fund: '9223372036854775808' }];
  for (const params of invalidQueries) {
    assert.throws(() => parseInfoFilters(new URLSearchParams(params)), ValidationError);
  }
  const filters = parseInfoFilters(new URLSearchParams({ from: '2026-11-20', to: '2026-11-20', fund: '9223372036854775807', include: 'collected' }));
  assert.equal(filters.from, filters.to); assert.equal(filters.includeCollected, true);
});

test('#159 affected fund mapping handles token suffixes, mixed assets, no matches, absent symbols and stable IDs', async () => {
  assert.deepEqual(affectedFunds(['NVDA'], funds), [{ id: '1', name: 'Tech' }]);
  assert.deepEqual(affectedFunds(['BTC'], funds), [{ id: '1', name: 'Tech' }, { id: '2', name: 'Bitcoin' }]);
  assert.deepEqual(affectedFunds([], funds), []); assert.deepEqual(affectedFunds(['UNKNOWN'], funds), []);
  const collisionFunds = [{ id: '3', name: 'Crypto', assetSymbols: ['TRX', 'BCH', 'BNB', 'BTCB'] },
    { id: '4', name: 'Stocks', assetSymbols: ['TRXB', 'BCHB'] }];
  assert.deepEqual(affectedFunds(['BN'], collisionFunds), []);
  assert.deepEqual(affectedFunds(['TRX', 'BCH'], collisionFunds, 'company'), [{ id: '4', name: 'Stocks' }]);
  assert.deepEqual(affectedFunds(['BTC'], collisionFunds, 'person'), [{ id: '3', name: 'Crypto' }]);
  assert.deepEqual(affectedFunds(['AXP'], [{ id: '5', name: 'Ondo', assetSymbols: ['AXPon'] }], 'company'), [{ id: '5', name: 'Ondo' }]);
  const seen: string[] = [];
  const catalogue = await readInfoCatalogue(async sql => { seen.push(sql); return { rows: [
    { id: '1', name: 'Tech', address: '0xa', symbol: 'NVDAB', allocation_symbol: 'AAPLB' }, { id: '1', name: 'Tech', address: '0xb', symbol: 'NVDAB' },
    { id: '2', name: 'Missing symbol', address: '0xc', symbol: null },
  ] }; }, 56);
  assert.deepEqual(catalogue, [{ id: '1', name: 'Tech', assetSymbols: ['NVDAB'] }, { id: '2', name: 'Missing symbol', assetSymbols: [] }]);
  assert.match(seen[0] ?? '', /s\.is_public/); assert.match(seen[0] ?? '', /active_at<=now\(\)/);
  const profileCatalogue = await readInfoCatalogue(async () => ({ rows: [{ id: '1', name: 'Tech', address: TESTNET_97.assets.NVDAB.token,
    symbol: 'AAPLB', allocation_symbol: 'MSFTB' }] }), 97);
  assert.deepEqual(profileCatalogue[0]?.assetSymbols, ['NVDAB']);
  await assert.rejects(readInfoCatalogue(async () => ({ rows: [{ id: 1 }] }), 56), /catalogue unavailable/);
});

test('#159 info domain parameterizes filters and reports DB/catalogue failure safely', async () => {
  let params: readonly unknown[] = [];
  const service = createInfoService({ catalogue: async () => funds, query: async (_sql, bound) => {
    params = bound ?? [];
    return { rows: [{ id: '1', category: 'company', asset_symbols: ['NVDA'], reviewed_by: operator }] };
  } });
  const filters = parseInfoFilters(new URLSearchParams({ category: 'company', from: '2026-11-20', to: '2026-11-20', fund: '1', limit: '100' }));
  const result = await service.events(filters);
  assert.deepEqual(params, [false, 'company', filters.from, filters.to, ['NVDA', 'NVDAB', 'MSFT', 'MSFTB', 'BTCB', 'BTC'], ['NVDA', 'NVDAB', 'MSFT', 'MSFTB'], 100]);
  assert.deepEqual(result.events[0]?.affectedFunds, [{ id: '1', name: 'Tech' }]);
  assert.ok(!('reviewedBy' in (result.events[0] ?? {})));
  await service.events({ ...filters, fund: '999' }); assert.deepEqual(params[4], []);
  const failed = createInfoService({ catalogue: async () => { throw new Error('secret'); }, query: async () => { throw new Error('secret'); } });
  for (const operation of [() => failed.events(filters), () => failed.markets(), () => failed.review('1', { title_zh: '標題', status: 'published' }, operator)]) {
    await assert.rejects(operation(), error => error instanceof AppError && error.status === 503 && !error.message.includes('secret'));
  }
});

test('#159 markets label broad USD accurately, preserve exact decimals, empty/one-point values and zero/negative changes', async () => {
  const service = createInfoService({ query: async () => ({ rows: [
    { series: 'usd_broad', position: 1, observed_on: '2026-11-20', value: '120.0010', change: '-0.0010' },
    { series: 'usd_broad', position: 2, observed_on: '2026-11-19', value: '120.0020' },
    { series: 'ust_2y', position: 1, observed_on: '2026-11-20', value: '0.00' },
  ] }) });
  const markets = (await service.markets()).markets;
  assert.equal(markets[0]?.change, null); assert.equal(markets[1]?.points.length, 0);
  assert.equal(markets[2]?.change, '-0.0010'); assert.match(markets[2]?.label ?? '', /廣義.*非 DXY/);
  assert.equal(markets[2]?.points[0]?.value, '120.0010');
});

test('#159 review validates title/status/ID, missing rows, rejects unknown fields and records the controlling wallet', async () => {
  let params: readonly unknown[] = [];
  const service = createInfoService({ query: async (_sql, bound) => { params = bound ?? []; return { rows: [{ id: '1', title_zh: bound?.[1], status: bound?.[2], reviewed_by: bound?.[3], reviewed_at: new Date() }] }; } });
  for (const status of ['reviewed', 'published', 'rejected']) {
    assert.equal((await service.review('1', { title_zh: ' 標題 ', status }, operator.toUpperCase())).status, status);
    assert.deepEqual(params.slice(0, 4), ['1', '標題', status, operator]);
  }
  for (const title of ['一', '中'.repeat(500)]) await service.review('1', { title_zh: title, status: 'published' }, operator);
  for (const input of [null, [], {}, { title_zh: '', status: 'published' }, { title_zh: '   ', status: 'published' },
    { title_zh: '中'.repeat(501), status: 'published' }, { title_zh: '中', status: 'collected' }, { title_zh: '中', status: 'published', reviewed_by: other }]) {
    await assert.rejects(service.review('1', input, operator), ValidationError);
  }
  for (const id of ['0', '-1', '1.1', '9223372036854775808']) await assert.rejects(service.review(id, {}, operator), ValidationError);
  await assert.rejects(createInfoService({ query: async () => ({ rows: [] }) }).review('1', { title_zh: '中', status: 'published' }, operator), error => error instanceof AppError && error.status === 404);
});

test('#159 HTTP publishes only public reads; collected/review require SIWE operator, deny empty allowlist, keep rebalance off', async () => {
  let authCalls = 0, eventCalls = 0, reviewCalls = 0;
  const observed: InfoFilters[] = [];
  const service = createInfoService({ catalogue: async () => [], query: async () => ({ rows: [] }) });
  const server = createServer({ operatorWallets: [operator], operatorRebalanceEnabled: () => false,
    info: { ...service, events: async filters => { eventCalls++; observed.push(filters); return { events: [], limit: filters.limit }; },
      review: async (id, _input, wallet) => { reviewCalls++; return { id, status: 'published', titleZh: '標題', reviewedBy: wallet, reviewedAt: new Date() }; } },
    auth: { authenticate: async header => { authCalls++; if (!header) throw new UnauthorizedError(); return header === 'Bearer operator' ? operator : other; },
      issueNonce: () => { throw new Error('unused'); }, login: async () => { throw new Error('unused'); }, logout: async () => {} },
    rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore()) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const root = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: 'Bearer operator', 'content-type': 'application/json' };
  const reviewPath = '/operator/info/events/1/review';
  try {
    assert.equal((await fetch(root + '/info/events')).status, 200);
    assert.equal((await fetch(root + '/info/markets')).status, 200); assert.equal(authCalls, 0);
    assert.equal(observed[0]?.includeCollected, false);
    assert.equal((await fetch(root + '/info/events?include=collected')).status, 401);
    assert.equal((await fetch(root + '/info/events?include=collected', { headers: { authorization: 'Bearer other' } })).status, 403);
    assert.equal((await fetch(root + '/info/events?include=collected', { headers })).status, 200);
    assert.equal(observed[1]?.includeCollected, true); assert.equal(eventCalls, 2);
    assert.equal((await fetch(root + reviewPath, { method: 'POST', body: 'broken' })).status, 401);
    assert.equal((await fetch(root + reviewPath, { method: 'POST', headers: { authorization: 'Bearer other' }, body: 'broken' })).status, 403);
    assert.equal(reviewCalls, 0);
    assert.equal((await fetch(root + reviewPath, { method: 'POST', headers, body: 'broken' })).status, 400);
    assert.equal((await fetch(root + reviewPath, { method: 'POST', headers, body: '{"title_zh":"標題","status":"published"}' })).status, 200);
    assert.equal(reviewCalls, 1);
    for (const url of ['/info/events', '/info/markets']) assert.equal((await fetch(root + url, { method: 'POST' })).status, 405);
    assert.equal((await fetch(root + reviewPath, { headers })).status, 405);
    for (const url of ['/info/events/1', '/info/markets/extra', '/operator/info/events/1/review/extra']) assert.equal((await fetch(root + url, { headers })).status, 404);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  const closed = createServer({ operatorWallets: [], auth: { authenticate: async () => operator,
    issueNonce: () => { throw new Error('unused'); }, login: async () => { throw new Error('unused'); }, logout: async () => {} } });
  await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve));
  const second = closed.address(); assert.ok(second && typeof second !== 'string');
  try {
    assert.equal((await fetch(`http://127.0.0.1:${second.port}/info/events?include=collected`)).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${second.port}${reviewPath}`, { method: 'POST', body: '{}' })).status, 403);
  } finally { await new Promise<void>((resolve, reject) => closed.close(error => error ? reject(error) : resolve())); }
});
