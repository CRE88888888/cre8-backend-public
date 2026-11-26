import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../src/server.js';
import { MemoryRateLimitStore, RequestRateLimiter } from '../src/ratelimit.js';
import { loadRateLimitConfig } from '../src/config.js';
import { largestContributionExecution } from './fixtures/contribution-preview.js';
import { ContributionPreviewPool, PREVIEW_TIMEOUT_MS, previewContributionAsync } from '../src/contribution-preview.js';
import { AppError } from '../src/errors.js';
import { contributionPreviewInput, previewContribution } from '../src/strategies.js';
import { record } from '../src/strategy-execution.js';
import { TESTNET_97 } from '../src/testnet-profile.js';

const at = new Date('2026-11-16T12:59:00Z');
const cash = TESTNET_97.contracts.usdt;
const simple = { chainId: 97, execution: { kind: 'per_asset', numeraire: cash, rebalance: 'none',
  assets: [{ asset: cash, weightBps: 10000, yield: null }] }, amountRaw: (50n * 10n ** 18n).toString() };
const fixtureUrl = new URL('./fixtures/contribution-preview-worker.ts', import.meta.url);
const preparedSimple = contributionPreviewInput(simple);

test('#123 background preview preserves timestamp, results, amount boundaries and validation errors', async () => {
  const execution = largestContributionExecution();
  for (const amount of [10_000_000n * 10n ** 18n - 1n, 10_000_000n * 10n ** 18n]) {
    const body = { chainId: 97, execution, amountRaw: amount.toString() };
    assert.deepEqual(await previewContributionAsync(body, at), previewContribution(body, at));
  }
  for (const [amountRaw, status, code] of [
    ['0', 422, 'BELOW_MINIMUM_ALLOCATION'],
    [(10_000_000n * 10n ** 18n + 1n).toString(), 422, 'PREVIEW_AMOUNT_TOO_LARGE'],
    [((1n << 256n) - 1n).toString(), 422, 'PREVIEW_AMOUNT_TOO_LARGE'],
    [(1n << 256n).toString(), 400, 'INVALID_AMOUNT'],
  ] as const) {
    await assert.rejects(previewContributionAsync({ ...simple, amountRaw }, at), (e: unknown) => e instanceof AppError && e.status === status && e.code === code);
  }
  assert.deepEqual(await previewContributionAsync(simple, at), previewContribution(simple, at));
});

test('#123 two active workers and four queued requests are shared across servers; excess gets 429 and capacity recovers', async () => {
  const pool = new ContributionPreviewPool(fixtureUrl);
  const control = new Int32Array(new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT));
  const servers = [0, 1].map(() => createServer({
    rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore()),
    previewContribution: (body, confirmedAt) => pool.run({ body: contributionPreviewInput(body), control: control.buffer }, confirmedAt),
  }));
  for (const server of servers) await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const bases = servers.map(server => { const address = server.address(); assert.ok(address && typeof address !== 'string'); return `http://127.0.0.1:${address.port}`; });
  const post = async (i: number) => {
    const response = await fetch(bases[i % 2] + '/strategies/preview-contribution', { method: 'POST', body: JSON.stringify(simple) });
    const body: unknown = await response.json();
    return { status: response.status, retry: response.headers.get('retry-after'), body };
  };
  // Admit synchronously so HTTP connection scheduling cannot reorder the six accepted jobs.
  const pending = Array.from({ length: 6 }, () => pool.run({ body: preparedSimple, control: control.buffer }, at));
  try {
    const overflow = await Promise.all([post(6), post(7)]);
    assert.deepEqual(overflow.map(r => r.status), [429, 429]);
    assert.ok(overflow.every(r => r.retry === '1'));
    assert.ok(overflow.every(r => record(r.body) && record(r.body.error) && r.body.error.code === 'RATE_LIMITED'));
    const until = performance.now() + 800;
    while (Atomics.load(control, 2) < 2 && performance.now() < until) await delay(5);
    assert.equal(Atomics.load(control, 2), 2, 'only the two active requests can reach workers');
    assert.equal(Atomics.load(control, 0), 2);
    const started = performance.now();
    await (await fetch(bases[0] + '/health')).arrayBuffer();
    assert.ok(performance.now() - started < 200);
    Atomics.store(control, 3, 1); Atomics.notify(control, 3);
    for (const value of await Promise.all(pending)) assert.deepEqual(value, previewContribution(simple, at));
    assert.equal(Atomics.load(control, 2), 6);
    assert.equal(Atomics.load(control, 1), 2, 'physical worker concurrency must never exceed two');
    assert.equal((await post(8)).status, 200, 'finished work releases queue capacity');
  } finally {
    Atomics.store(control, 3, 1); Atomics.notify(control, 3);
    await Promise.allSettled(pending);
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});

test('#123 CPU timeout returns 503 within one budget and terminates work before queued jobs resume', async () => {
  const pool = new ContributionPreviewPool(fixtureUrl);
  let startedCount = 0;
  let notifyStarted = () => {};
  const bothStarted = new Promise<void>(resolve => { notifyStarted = resolve; });
  const server = createServer({
    rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore()),
    previewContribution: () => {
      const pending = pool.run({ action: 'spin', body: preparedSimple }, at);
      if (++startedCount === 2) notifyStarted();
      return pending;
    },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const started = performance.now();
    const pending = [0, 1].map(async () => {
      const response = await fetch(`http://127.0.0.1:${address.port}/strategies/preview-contribution`, { method: 'POST', body: '{}' });
      const body: unknown = await response.json();
      assert.equal(response.status, 503);
      assert.ok(record(body) && record(body.error)); assert.equal(body.error.code, 'PREVIEW_TIMEOUT');
    });
    await bothStarted;
    const queued = pool.run({ body: preparedSimple }, at);
    await Promise.all(pending);
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= PREVIEW_TIMEOUT_MS && elapsed < PREVIEW_TIMEOUT_MS + 500, `timeout took ${elapsed.toFixed(0)}ms`);
    assert.deepEqual(await queued, previewContribution(simple, at));
    assert.deepEqual(await pool.run({ body: preparedSimple }, at), previewContribution(simple, at));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('#123 worker crash, early exit, startup and serialization failures fail closed without exposing details or leaking slots', async () => {
  const pool = new ContributionPreviewPool(fixtureUrl);
  const unavailable = (e: unknown) => e instanceof AppError && e.status === 503 && e.code === 'PREVIEW_UNAVAILABLE' && !e.message.includes('SECRET');
  for (const action of ['crash', 'exit']) {
    await assert.rejects(pool.run({ action, body: preparedSimple }, at), unavailable);
    assert.deepEqual(await pool.run({ body: preparedSimple }, at), previewContribution(simple, at));
  }
  await assert.rejects(pool.run({ body: preparedSimple, uncloneable: () => {} }, at), unavailable);
  assert.deepEqual(await pool.run({ body: preparedSimple }, at), previewContribution(simple, at));
  await assert.rejects(new ContributionPreviewPool(new URL('./fixtures/missing-preview-worker.ts', import.meta.url)).run(preparedSimple, at), unavailable);
});

test('#123 two maximum previews keep concurrent health requests under 200ms', async () => {
  const server = createServer({ rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore()) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    await (await fetch(base + '/health')).arrayBuffer();
    const body = { chainId: 97, execution: largestContributionExecution(), amountRaw: (10_000_000n * 10n ** 18n).toString() };
    const pending = Promise.all([0, 1].map(async () => {
      const response = await fetch(base + '/strategies/preview-contribution', { method: 'POST', body: JSON.stringify(body) });
      const result: unknown = await response.json();
      assert.ok(response.status === 200 || response.status === 503);
      if (response.status === 503) {
        assert.ok(record(result) && record(result.error));
        assert.equal(result.error.code, 'PREVIEW_TIMEOUT');
      } else {
        assert.ok(record(result));
        assert.ok(typeof result.minimumRaw === 'string' && /^[0-9]+$/.test(result.minimumRaw));
        assert.ok(Array.isArray(result.slots) && result.slots.length > 0);
      }
      const healthStarted = performance.now();
      await (await fetch(base + '/health')).arrayBuffer();
      assert.ok(performance.now() - healthStarted < 200, 'health remains responsive after either preview outcome');
    }));
    await delay(20);
    const healthStarted = performance.now();
    await (await fetch(base + '/health')).arrayBuffer();
    const healthMs = performance.now() - healthStarted;
    await pending;
    assert.ok(healthMs < 200, `concurrent health took ${healthMs.toFixed(0)}ms`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});


test('#123 injected short preview budget deterministically returns PREVIEW_TIMEOUT while health remains responsive', async () => {
  const nativeTimeout = globalThis.setTimeout;
  // Test-only clock injection; the production pool still requests its unchanged 1000ms budget.
  const timer = mock.method(globalThis, 'setTimeout', (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    nativeTimeout(callback, ms === PREVIEW_TIMEOUT_MS ? 25 : ms, ...args));
  const pool = new ContributionPreviewPool(fixtureUrl);
  const server = createServer({
    rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore()),
    previewContribution: () => pool.run({ action: 'spin', body: preparedSimple }, at),
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const pending = fetch(base + '/strategies/preview-contribution', { method: 'POST', body: '{}' });
    const started = performance.now();
    await (await fetch(base + '/health')).arrayBuffer();
    assert.ok(performance.now() - started < 200);
    const response = await pending;
    const body: unknown = await response.json();
    assert.equal(response.status, 503);
    assert.ok(record(body) && record(body.error)); assert.equal(body.error.code, 'PREVIEW_TIMEOUT');
    const after = performance.now();
    await (await fetch(base + '/health')).arrayBuffer();
    assert.ok(performance.now() - after < 200);
    assert.equal(PREVIEW_TIMEOUT_MS, 1_000);
  } finally {
    timer.mock.restore();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
