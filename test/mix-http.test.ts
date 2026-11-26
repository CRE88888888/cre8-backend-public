import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from '../src/server.js';
import { createMixAssetList, createMixPreview } from '../src/mix-preview.js';
import { loadRateLimitConfig } from '../src/config.js';
import { RequestRateLimiter, MemoryRateLimitStore } from '../src/ratelimit.js';
import { emptyModel } from '../src/model-returns/calculation.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
import { UnauthorizedError } from '../src/errors.js';

const body = JSON.stringify({ assets: [{ assetId: T.assets.NVDAB.token, weightBps: 10000 }] });
test('mix preview HTTP is public, strict on method/path/body, preserves CORS and enforces an IP budget before parsing', async () => {
  let clock = 1000;
  const server = createServer({
    mixPreview: createMixPreview({ chainId: 97, now: () => new Date('2026-11-21T12:00:00Z'), gasPrice: async () => 1n, model: async () => emptyModel() }),
    rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore(), () => clock),
    auth: { authenticate: async () => { throw new Error('public route attempted authentication'); }, issueNonce: () => { throw new Error('unused'); },
      login: async () => { throw new Error('unused'); }, logout: async () => {} },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/mixes/preview`;
  try {
    assert.equal((await fetch(url)).status, 405);
    assert.equal((await fetch(url + '/extra', { method: 'POST', body })).status, 404);
    const response = await fetch(url, { method: 'POST', body, headers: { origin: 'http://localhost:5173' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result: unknown = await response.json();
    assert.ok(result && typeof result === 'object' && 'minimumDepositRaw' in result);
    assert.equal(result.minimumDepositRaw, (50n * 10n ** 18n).toString());
    for (const invalid of ['', '{broken', 'null', '{}']) assert.equal((await fetch(url, { method: 'POST', body: invalid })).status, 400);
    // Both malformed attempts and valid previews consume the same 30/minute budget.
    for (let index = 5; index < 30; index++) assert.equal((await fetch(url, { method: 'POST', body })).status, 200);
    const limited = await fetch(url, { method: 'POST', body: '{broken', headers: { 'x-forwarded-for': '198.51.100.1' } });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '59');
    assert.equal(limited.headers.get('access-control-expose-headers'), 'Retry-After');
    clock = 60000;
    assert.equal((await fetch(url, { method: 'POST', body })).status, 200);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('mix preview HTTP reports budget backend failures safely before evaluating the model', async () => {
  let reads = 0;
  const server = createServer({
    rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), { consume: async () => { throw new Error('private database credential'); } }),
    mixPreview: createMixPreview({ chainId: 97, model: async () => { reads++; return emptyModel(); } }),
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/mixes/preview`, { method: 'POST', body });
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /private database credential/);
    assert.equal(reads, 0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});


test('mix creation has wallet-scoped minute and UTC day budgets with exact reset boundaries', async () => {
  let now = 0;
  const limit = new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore(), () => now);
  for (let i = 0; i < 20; i++) {
    now = Math.floor(i / 3) * 60000;
    await limit.mixCreate(T.roles.keeper.toUpperCase(), 'wallet-test-' + i);
    if (i === 2) await assert.rejects(limit.mixCreate(T.roles.keeper), { status: 429 });
  }
  now = 10 * 60000;
  await assert.rejects(limit.mixCreate(T.roles.keeper), { status: 429 });
  await limit.mixCreate(T.roles.operator);
  now = 86400000 - 1; await assert.rejects(limit.mixCreate(T.roles.keeper), { status: 429 });
  now = 86400000; await limit.mixCreate(T.roles.keeper);
});

test('mix registration budgets bind IP and global hour across different wallets, including equality and failed store', async () => {
  let now = 0;
  const limiter = new RequestRateLimiter(loadRateLimitConfig({ RATE_LIMIT_MIX_CREATE_GLOBAL_PER_HOUR: '11' }), new MemoryRateLimitStore(), () => now);
  for (let i = 0; i < 10; i++) { now = i * 60000; await limiter.mixCreate(`0x${(100 + i).toString(16).padStart(40, '0')}`, 'ip1'); }
  await assert.rejects(limiter.mixCreate(T.roles.keeper, 'ip1'), { status: 429 });
  await limiter.mixCreate(T.roles.operator, 'ip2');
  await assert.rejects(limiter.mixCreate(T.roles.keeper, 'ip3'), { status: 429 });
  now = 3600000 - 1; await assert.rejects(limiter.mixCreate(T.roles.keeper, 'ip3'), { status: 429 });
  now++; await limiter.mixCreate(T.roles.keeper, 'ip1');
  const denied = new RequestRateLimiter(loadRateLimitConfig({ RATE_LIMIT_MIX_CREATE_GLOBAL_PER_HOUR: '0' }), new MemoryRateLimitStore());
  await assert.rejects(denied.mixCreate(T.roles.keeper, 'ip4'), { status: 429 });
  const failed = new RequestRateLimiter(loadRateLimitConfig({}), { consume: async () => { throw new Error('private connection'); } });
  await assert.rejects(failed.mixCreate(T.roles.keeper, 'ip4'), e => e instanceof Error && !e.message.includes('private'));
});

test('mix yield status is absent and consent, revoke and exit cannot read chain or write a yield authorization', async () => {
  const { createYieldService } = await import('../src/yield-service.js');
  const { yieldProfile } = await import('../src/yield-domain.js');
  let reads = 0;
  const service = createYieldService({ owned: async () => ({ id: 1, personalMix: true, userId: T.roles.keeper,
    strategyId: 1, version: 1, createdAt: '2026-11-21T00:00:00Z', scheduleState: 'active', accountAddress: T.roles.operator, ownerAddress: T.roles.keeper,
    chainId: 97, existingKeyRefs: [], accountType: 'KERNEL' }), profile: () => yieldProfile(),
    client: () => { reads++; throw new Error('mix must never request a yield client'); } });
  assert.equal(await service.status(1, T.roles.keeper), null);
  for (const method of [service.consent, service.revoke, service.exit]) await assert.rejects(method(1, T.roles.keeper, {}), { code: 'MIX_NO_YIELD' });
  assert.equal(reads, 0);
});

test('#189 GET /mixes/assets lists 103 assets publicly with kinds, backtest flags and a short public cache', async () => {
  const server = createServer({
    mixAssets: createMixAssetList({ chainId: 97 }),
    rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore()),
    auth: { authenticate: async () => { throw new Error('public route attempted authentication'); }, issueNonce: () => { throw new Error('unused'); },
      login: async () => { throw new Error('unused'); }, logout: async () => {} },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/mixes/assets`;
  try {
    assert.equal((await fetch(url, { method: 'POST' })).status, 405);
    assert.equal((await fetch(url + '/extra')).status, 404);
    const response = await fetch(url, { headers: { origin: 'http://localhost:5173' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=300');
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    const result: unknown = await response.json();
    assert.ok(result && typeof result === 'object' && 'assets' in result && Array.isArray(result.assets));
    const assets: unknown[] = result.assets;
    assert.equal(assets.length, 103);
    const bySymbol = new Map(assets.map(item => {
      assert.ok(item && typeof item === 'object' && 'symbol' in item && typeof item.symbol === 'string');
      return [item.symbol, item];
    }));
    assert.deepEqual(bySymbol.get('NVDAB'), { assetId: T.assets.NVDAB.token, symbol: 'NVDAB', kind: 'stock', hasBacktest: true });
    assert.deepEqual(bySymbol.get('Cake'), { assetId: T.assets.Cake.token, symbol: 'Cake', kind: 'crypto', hasBacktest: true });
    assert.deepEqual(bySymbol.get('XAUt'), { assetId: T.assets.XAUt.token, symbol: 'XAUt', kind: 'gold', hasBacktest: true });
    for (const excluded of ['USDT', 'USDC', 'DAI']) assert.equal(bySymbol.has(excluded), false, excluded);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('#189 GET /mixes/assets refuses chains other than 97', async () => {
  const server = createServer({ mixAssets: createMixAssetList({ chainId: 56 }),
    rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore()) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/mixes/assets`);
    assert.equal(response.status, 503);
    assert.match(await response.text(), /MIX_CHAIN_UNAVAILABLE/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('POST /me/mixes/:id/delete authenticates, rate-limits and returns the delete status', async () => {
  const calls: unknown[] = [];
  const server = createServer({
    rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore()),
    auth: { authenticate: async header => { if (header !== 'Bearer ok') throw new UnauthorizedError('no'); return T.roles.keeper; },
      issueNonce: () => { throw new Error('unused'); }, login: async () => { throw new Error('unused'); }, logout: async () => {} },
    mixes: { remove: async (id: number, wallet: string) => { calls.push([id, wallet]); return { mixId: id, status: 'deleting' as const }; } } as never,
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/me/mixes/7/delete`;
  try {
    const response = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ok' } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { mixId: 7, status: 'deleting' });
    assert.deepEqual(calls, [[7, T.roles.keeper]]);
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    assert.equal((await fetch(url, { method: 'GET', headers: { authorization: 'Bearer ok' } })).status, 405);
    assert.equal(calls.length, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('mix preview HTTP: a session is optional and only the market-hours bypass wallet gets a different answer', async () => {
  const canary = '0xd3ab39b62e221bf9e8ba19fe19b2638767d3d6d9', other = '0x00000000000000000000000000000000000000a1';
  let lookups = 0, clock = new Date('2026-11-21T12:00:00Z');
  const server = createServer({
    mixPreview: createMixPreview({ chainId: 97, now: () => clock, gasPrice: async () => 1n, model: async () => emptyModel() }),
    rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore(), () => 1000),
    auth: { authenticate: async header => { lookups++; if (header === 'Bearer canary') return canary; if (header === 'Bearer other') return other; throw new UnauthorizedError('missing or invalid session token'); },
      issueNonce: () => { throw new Error('unused'); }, login: async () => { throw new Error('unused'); }, logout: async () => {} },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const ask = async (authorization?: string) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/mixes/preview`, { method: 'POST', body, ...(authorization === undefined ? {} : { headers: { authorization } }) });
    assert.equal(response.status, 200);
    return (await response.json() as { markets: { open: boolean; nextOpenAt: string | null }[] }).markets.map(m => [m.open, m.nextOpenAt]);
  };
  try {
    const closed = [[false, '2026-11-23T14:30:00.000Z']];
    assert.deepEqual(await ask(), closed); assert.equal(lookups, 0, 'no session, no lookup');
    assert.deepEqual(await ask('Bearer other'), closed);
    assert.deepEqual(await ask('Bearer stale'), closed, 'a bad session is still an anonymous preview, never a 401');
    assert.deepEqual(await ask('Bearer canary'), [[true, null]]);
    assert.equal(lookups, 3);
    clock = new Date('2026-11-23T15:00:00Z');
    assert.deepEqual(await ask('Bearer other'), [[true, null]]); assert.equal(lookups, 3, 'session open: nobody is looked up');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
