import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError, NotFoundError } from '../src/errors.js';
import { lastGoodVersionState } from '../src/strategies.js';

const unavailable = () => new AppError(503, 'VERSION_STATE_UNAVAILABLE', 'version state unavailable', { cause: new Error('header not found') });

function harness(results: Array<string | Error>) {
  let clock = 0, reads = 0;
  const logs: string[] = [];
  const read = async () => {
    reads++;
    const next = results.shift();
    if (next === undefined) throw new Error('unexpected read');
    if (next instanceof Error) throw next;
    return next;
  };
  const state = lastGoodVersionState(read, { ttlMs: 15_000, now: () => clock, log: line => logs.push(line), retryDelayMs: 0 });
  return { state, logs, reads: () => reads, tick: (ms: number) => { clock += ms; } };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('fund detail serves the last good version state when a refresh fails (04:23 UTC 503s)', async () => {
  const h = harness(['v1', unavailable()]);
  assert.equal(await h.state(7, 1), 'v1');
  h.tick(16_000);
  assert.equal(await h.state(7, 1), 'v1'); // stale value returned at once, refresh runs in the background
  await settle();
  assert.equal(h.reads(), 2);
  assert.match(h.logs.join('\n'), /version_state_stale.*header not found/);
  assert.equal(await h.state(7, 1), 'v1');
});

test('a stale value is replaced by the background refresh, and concurrent requests share one read', async () => {
  const h = harness(['v1', 'v2']);
  assert.equal(await h.state(7, 1), 'v1');
  h.tick(16_000);
  assert.deepEqual(await Promise.all([h.state(7, 1), h.state(7, 1), h.state(7, 1)]), ['v1', 'v1', 'v1']);
  await settle();
  assert.equal(h.reads(), 2);
  assert.equal(await h.state(7, 1), 'v2');
  assert.equal(h.reads(), 2); // fresh: no chain read
});

test('a fund never read before retries once, then reports the failure', async () => {
  const ok = harness([unavailable(), 'v1']);
  assert.equal(await ok.state(7, 1), 'v1');
  assert.match(ok.logs.join('\n'), /version_state_retry/);
  const down = harness([unavailable(), unavailable()]);
  await assert.rejects(down.state(7, 1), (error: unknown) => error instanceof AppError && error.code === 'VERSION_STATE_UNAVAILABLE');
});

test('request errors are not retried or masked', async () => {
  const h = harness([new NotFoundError('missing')]);
  await assert.rejects(h.state(7, 1), NotFoundError);
  assert.equal(h.reads(), 1);
});
