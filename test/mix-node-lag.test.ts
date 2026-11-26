import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError, errorChain } from '../src/errors.js';
import { logMixFailure, mixUnavailable, untilNodesCatchUp } from '../src/mix-store.js';

const fakeTime = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };

test('untilNodesCatchUp retries MIX_UNAVAILABLE until the work succeeds, within the budget', async () => {
  const clock = fakeTime();
  let calls = 0;
  const result = await untilNodesCatchUp(async () => { calls++; if (calls < 3) throw mixUnavailable('receipt-not-visible-yet'); return 'registered'; }, (r) => r === 'registered', clock);
  assert.equal(result, 'registered'); assert.equal(calls, 3); assert.ok(clock.now() <= 10_000);
});

test('untilNodesCatchUp gives up after the budget with the last error; other errors are never retried', async () => {
  const clock = fakeTime();
  let calls = 0;
  await assert.rejects(untilNodesCatchUp(async () => { calls++; throw mixUnavailable('version-not-visible-yet'); }, () => true, { ...clock, budgetMs: 2_000 }),
    (e: unknown) => e instanceof AppError && e.code === 'MIX_UNAVAILABLE' && errorChain(e).includes('version-not-visible-yet'));
  assert.ok(calls >= 2 && clock.now() <= 2_000, `${calls} calls in ${clock.now()} ms`);
  calls = 0;
  await assert.rejects(untilNodesCatchUp(async () => { calls++; throw new AppError(503, 'RELAYER_BUSY', 'busy'); }, () => true, clock), /busy/);
  assert.equal(calls, 1);
  // A result that is not final yet is retried too, then returned as is.
  assert.equal(await untilNodesCatchUp(async () => 'replayed', (r) => r === 'registered', { ...fakeTime(), budgetMs: 1_000 }), 'replayed');
});

test('mixUnavailable keeps the public message and logs where it was thrown and why, without request data', () => {
  const rpc = Object.assign(new Error('Block at number "144362669" could not be found.\nURL: https://rpc.example/key-SECRET'), { name: 'BlockNotFoundError' });
  const thrower = () => { throw mixUnavailable('confirm-read', rpc); };
  let caught: unknown; try { thrower(); } catch (e) { caught = e; }
  assert.ok(caught instanceof AppError);
  assert.equal(caught.message, '目前無法確認組合資料，請稍後以原請求重試。');
  const lines: string[] = [];
  const warn = console.warn; console.warn = (line: unknown) => { lines.push(String(line)); };
  try { logMixFailure('mixes', caught); } finally { console.warn = warn; }
  const line = JSON.parse(lines[0] ?? '{}') as { code?: string; cause?: string };
  assert.equal(line.code, 'MIX_UNAVAILABLE');
  assert.match(line.cause ?? '', /\[mix:confirm-read @ thrower@test\/mix-node-lag\.test\.ts:\d+[^\]]*\] ← BlockNotFoundError: Block at number "144362669" could not be found\. \| URL: <url>$/);
  assert.ok(!(line.cause ?? '').includes('SECRET'));
  // A bare call still names its call site.
  assert.match(errorChain(mixUnavailable()), /\[mix:[^\]]*mix-node-lag\.test\.ts:\d+/);
});
