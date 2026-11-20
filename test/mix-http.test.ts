import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from '../src/server.js';
import { createMixPreview } from '../src/mix-preview.js';
import { loadRateLimitConfig } from '../src/config.js';
import { RequestRateLimiter, MemoryRateLimitStore } from '../src/ratelimit.js';
import { emptyModel } from '../src/model-returns/calculation.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';

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
