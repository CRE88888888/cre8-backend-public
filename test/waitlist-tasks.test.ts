import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JWTPayload } from 'jose';
import { loadRateLimitConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { MemoryRateLimitStore, RequestRateLimiter } from '../src/ratelimit.js';
import { createServer } from '../src/server.js';
import { createWaitlistService } from '../src/waitlist.js';
import type { WaitlistEntry } from '../src/waitlist.js';
import { createWaitlistTaskService, postUrl, quizAnswers } from '../src/waitlist-tasks.js';
import type { TaskEvidence, TaskId, WaitlistTaskRepository } from '../src/waitlist-tasks.js';
import { privyFixture } from './fixtures/privy.js';

const twitter = { type: 'twitter_oauth', subject: '1234567890123456789', username: 'Cre8_Test' };
const google = { type: 'google_oauth', subject: '109876543210987654321', email: 'ada@example.com' };
const entry: WaitlistEntry = { id: '7', privyUserId: 'did:privy:tasks', xUserId: twitter.subject, xHandle: 'cre8_test', loginMethod: 'twitter',
  loginLabel: null, status: 'waiting', joinedAt: '2026-11-22T01:02:03.000001Z', approvedAt: null, approvedBy: null, points: 0 };
const isError = (status: number, code: string) => (error: unknown) => error instanceof AppError && error.status === status && error.code === code;

function harness(found: WaitlistEntry | null = entry) {
  const fixture = privyFixture();
  const rows = new Map<TaskId, TaskEvidence>();
  const calls: string[] = [];
  const repository: WaitlistTaskRepository = {
    done: async (id) => { calls.push('done:' + id); return [...rows.keys()]; },
    complete: async (id, task, evidence) => { calls.push(`complete:${id}:${task}`); if (!rows.has(task)) rows.set(task, evidence); },
  };
  const service = createWaitlistTaskService({ repository, entries: { find: async () => found }, config: () => fixture.config, now: () => fixture.now });
  const bearer = async (accounts: unknown[] = [twitter], overrides: JWTPayload = {}) =>
    'Bearer ' + await fixture.sign({ linked_accounts: JSON.stringify(accounts), ...overrides });
  return { fixture, rows, calls, service, bearer };
}
const empty = { points: 0, max: 35, tasks: [
  { id: 'post', points: 5, done: false }, { id: 'gmail', points: 5, done: false }, { id: 'quiz', points: 15, done: false }, { id: 'tg', points: 10, done: false }] };

test('#198 GET tasks: fixed list and max; all four tasks add up to 35; repeats add nothing and keep the first evidence', async () => {
  const h = harness();
  assert.deepEqual(await h.service.tasks(await h.bearer()), empty);
  const url = 'https://x.com/cre8_test/status/1990000000000000001';
  let state = await h.service.complete(await h.bearer(), 'post', { url });
  assert.equal(state.points, 5); assert.equal(state.tasks[0]?.done, true);
  state = await h.service.complete(await h.bearer([twitter, google]), 'gmail', {});
  state = await h.service.complete(await h.bearer(), 'quiz', { answers: { hold: 'Yes', where: 'Binance', type: 'Passive' } });
  state = await h.service.complete(await h.bearer(), 'tg', {});
  assert.deepEqual(state, { points: 35, max: 35, tasks: empty.tasks.map(t => ({ ...t, done: true })) });
  // Idempotent: a second post with another (valid) URL keeps the first and does not add points.
  const again = await h.service.complete(await h.bearer(), 'post', { url: 'https://twitter.com/cre8_test/status/2' });
  assert.equal(again.points, 35);
  assert.deepEqual(h.rows.get('post'), { postUrl: url, answers: null });
  assert.deepEqual(h.rows.get('quiz'), { postUrl: null, answers: { hold: 'Yes', where: 'Binance', type: 'Passive' } });
  assert.deepEqual(h.rows.get('tg'), { postUrl: null, answers: null });
});

test('#198 post URL: x.com/twitter.com status of the member\'s own handle (any case), normalized; everything else TASK_INVALID_URL', () => {
  const own = ['Cre8_Test'];
  for (const [url, normalized] of [
    ['https://x.com/cre8_test/status/123', 'https://x.com/cre8_test/status/123'],
    ['https://twitter.com/CRE8_TEST/status/123?s=20&t=abc', 'https://x.com/CRE8_TEST/status/123'],
    ['http://www.x.com/cre8_test/status/123/photo/1', 'https://x.com/cre8_test/status/123'],
    ['https://mobile.twitter.com/cre8_test/status/' + '9'.repeat(25), 'https://x.com/cre8_test/status/' + '9'.repeat(25)],
    ['  https://x.com/cre8_test/status/1  ', 'https://x.com/cre8_test/status/1'],
  ]) assert.equal(postUrl({ url }, own), normalized, url);
  for (const body of [{ url: 'https://x.com/someone_else/status/1' }, { url: 'https://x.com/cre8_test' }, { url: 'https://x.com/cre8_test/status/' },
    { url: 'https://x.com/cre8_test/status/abc' }, { url: 'https://evil.com/cre8_test/status/1' }, { url: 'https://x.com.evil.com/cre8_test/status/1' },
    { url: 'ftp://x.com/cre8_test/status/1' }, { url: 'https://x.com/cre8_test/status/' + '1'.repeat(26) }, { url: 'https://x.com/cre8_test/status/1 x' },
    { url: 'https://x.com/cre8_test/status/1#' + 'a'.repeat(512) }, { url: 5 }, {}, null, 'https://x.com/cre8_test/status/1']) {
    assert.throws(() => postUrl(body, own), isError(400, 'TASK_INVALID_URL'), JSON.stringify(body));
  }
  assert.throws(() => postUrl({ url: 'https://x.com/cre8_test/status/1' }, []), isError(400, 'TASK_INVALID_URL'));
});

test('#198 post uses the signed X handle or the stored one; a member without X cannot claim it', async () => {
  const h = harness({ ...entry, xHandle: 'old_handle' });
  // Renamed on X: the current signed username counts, and so does the stored handle.
  assert.equal((await h.service.complete(await h.bearer([{ ...twitter, username: 'new_handle' }]), 'post', { url: 'https://x.com/new_handle/status/1' })).points, 5);
  const stored = harness({ ...entry, xHandle: 'old_handle' });
  assert.equal((await stored.service.complete(await stored.bearer([google]), 'post', { url: 'https://x.com/old_handle/status/1' })).points, 5);
  const noX = harness({ ...entry, xUserId: null, xHandle: null, loginMethod: 'email', loginLabel: 'a@b.co' });
  await assert.rejects(noX.service.complete(await noX.bearer([google]), 'post', { url: 'https://x.com/cre8_test/status/1' }), isError(400, 'TASK_INVALID_URL'));
  assert.equal(noX.rows.size, 0);
});

test('#198 gmail needs a linked Google account in the identity token', async () => {
  const h = harness();
  for (const accounts of [[twitter], [twitter, { ...google, subject: '' }], [twitter, { ...google, subject: 'a b' }], [twitter, { type: 'email', address: 'a@gmail.com' }]]) {
    await assert.rejects(h.service.complete(await h.bearer(accounts), 'gmail', {}), isError(409, 'TASK_NOT_LINKED'));
  }
  assert.equal(h.rows.size, 0);
  assert.equal((await h.service.complete(await h.bearer([google]), 'gmail', {})).points, 5);
});

test('#198 quiz: follows the page\'s branching, drops stale answers, rejects missing/unknown/invalid answers', () => {
  assert.deepEqual(quizAnswers({ answers: { hold: 'Yes', where: 'Both', type: 'Just exploring' } }), { hold: 'Yes', where: 'Both', type: 'Just exploring' });
  assert.deepEqual(quizAnswers({ answers: { hold: 'Not yet', other: 'No', type: 'Active trader' } }), { hold: 'Not yet', other: 'No', type: 'Active trader' });
  assert.deepEqual(quizAnswers({ answers: { hold: 'Not yet', other: 'Yes', otherWhere: 'Exchange', type: 'Yield-focused' } }),
    { hold: 'Not yet', other: 'Yes', otherWhere: 'Exchange', type: 'Yield-focused' });
  // The page keeps earlier picks after the user changes a branch; those are dropped, not stored.
  assert.deepEqual(quizAnswers({ answers: { hold: 'Yes', where: 'Binance', other: 'Yes', otherWhere: 'Both', type: 'Passive' } }),
    { hold: 'Yes', where: 'Binance', type: 'Passive' });
  for (const answers of [{}, { hold: 'Yes', type: 'Passive' }, { hold: 'Not yet', type: 'Passive' }, { hold: 'Not yet', other: 'Yes', type: 'Passive' },
    { hold: 'Yes', where: 'Binance' }, { hold: 'Maybe', where: 'Binance', type: 'Passive' }, { hold: 'Yes', where: 'Exchange', type: 'Passive' },
    { hold: 'Yes', where: 'Binance', type: 'passive' }, { hold: 'Yes', where: 'Binance', type: 'Passive', age: '30' },
    { hold: 'Yes', where: 'Binance', type: 'Passive', other: 5 }, { hold: 'Yes', where: 'Binance', type: 'Passive', toString: 'x' }]) {
    assert.throws(() => quizAnswers({ answers }), isError(400, 'TASK_INVALID_ANSWERS'), JSON.stringify(answers));
  }
  for (const body of [null, {}, { answers: null }, { answers: [] }, { answers: 'Yes' }]) assert.throws(() => quizAnswers(body), isError(400, 'TASK_INVALID_ANSWERS'));
});

test('#198 errors: unknown task 404 before auth, not joined 404, bad token 401, storage failure 503 without writes', async () => {
  const h = harness();
  for (const id of ['follow', '', 'POST', '__proto__', 'toString']) await assert.rejects(h.service.complete(undefined, id, {}), isError(404, 'TASK_NOT_FOUND'));
  const out = harness(null);
  await assert.rejects(out.service.tasks(await out.bearer()), isError(404, 'NOT_JOINED'));
  await assert.rejects(out.service.complete(await out.bearer(), 'tg', {}), isError(404, 'NOT_JOINED'));
  assert.equal(out.rows.size, 0);
  for (const header of [undefined, '', 'Bearer', 'Basic abc', 'Bearer not-a-jwt']) {
    await assert.rejects(h.service.tasks(header), (e: unknown) => e instanceof AppError && e.status === 401);
  }
  await assert.rejects(h.service.tasks(await h.bearer([twitter], { exp: Math.floor(h.fixture.now / 1000) - 1, iat: Math.floor(h.fixture.now / 1000) - 10 })),
    (e: unknown) => e instanceof AppError && e.status === 401);
  const fixture = privyFixture();
  const broken = createWaitlistTaskService({ repository: { done: async () => { throw new Error('db secret'); }, complete: async () => { throw new Error('db secret'); } },
    entries: { find: async () => entry }, config: () => fixture.config, now: () => fixture.now });
  const token = 'Bearer ' + await fixture.sign({ linked_accounts: JSON.stringify([twitter]) });
  await assert.rejects(broken.tasks(token), isError(503, 'WAITLIST_UNAVAILABLE'));
  await assert.rejects(broken.complete(token, 'tg', {}), isError(503, 'WAITLIST_UNAVAILABLE'));
  const lost = createWaitlistTaskService({ repository: { done: async () => [], complete: async () => {} },
    entries: { find: async () => { throw new Error('db secret'); } }, config: () => fixture.config, now: () => fixture.now });
  await assert.rejects(lost.tasks(token), isError(503, 'WAITLIST_UNAVAILABLE'));
});

test('#198 operator list cursor carries points (0..35) for the release order', async () => {
  const pages: unknown[] = [];
  const service = createWaitlistService({ repository: { join: async () => entry, find: async () => entry, transition: async () => entry,
    list: async (input) => { pages.push(input.cursor); return [{ ...entry, points: 15 }, { ...entry, id: '8', points: 5 }]; } } });
  const first = await service.list(new URLSearchParams({ limit: '1' }));
  assert.equal(first.items[0]?.points, 15);
  assert.ok(first.nextCursor);
  assert.deepEqual(JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8')), { points: 15, joinedAt: entry.joinedAt, id: '7', status: null });
  await service.list(new URLSearchParams({ limit: '1', cursor: first.nextCursor }));
  assert.deepEqual(pages[1], { points: 15, joinedAt: entry.joinedAt, id: '7' });
  for (const points of [undefined, -1, 36, 1.5, '5']) {
    const cursor = Buffer.from(JSON.stringify({ points, joinedAt: entry.joinedAt, id: '7', status: null })).toString('base64url');
    await assert.rejects(service.list(new URLSearchParams({ cursor })), isError(400, 'INVALID_QUERY'));
  }
});

test('#198 HTTP: GET/POST under /waitlist/tasks, 405 on wrong methods, 404 unknown task, error codes reach the client', async () => {
  const h = harness();
  const server = createServer({ waitlistTasks: h.service, rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore()) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const code = async (response: Response) => { const body: unknown = await response.json(); return (body as { error?: { code?: string } }).error?.code; };
  try {
    const auth = { authorization: await h.bearer() };
    const got = await fetch(`${base}/waitlist/tasks`, { headers: auth });
    assert.equal(got.status, 200); assert.deepEqual(await got.json(), empty);
    assert.equal((await fetch(`${base}/waitlist/tasks`)).status, 401);
    assert.equal((await fetch(`${base}/waitlist/tasks`, { method: 'POST', headers: auth })).status, 405);
    assert.equal((await fetch(`${base}/waitlist/tasks/tg`, { headers: auth })).status, 405);
    const unknown = await fetch(`${base}/waitlist/tasks/follow`, { method: 'POST', headers: auth, body: '{}' });
    assert.equal(unknown.status, 404); assert.equal(await code(unknown), 'TASK_NOT_FOUND');
    const badUrl = await fetch(`${base}/waitlist/tasks/post`, { method: 'POST', headers: auth, body: JSON.stringify({ url: 'https://x.com/other/status/1' }) });
    assert.equal(badUrl.status, 400); assert.equal(await code(badUrl), 'TASK_INVALID_URL');
    const notLinked = await fetch(`${base}/waitlist/tasks/gmail`, { method: 'POST', headers: auth, body: '{}' });
    assert.equal(notLinked.status, 409); assert.equal(await code(notLinked), 'TASK_NOT_LINKED');
    const tg = await fetch(`${base}/waitlist/tasks/tg`, { method: 'POST', headers: auth, body: '{}' });
    assert.equal(tg.status, 200); assert.equal(((await tg.json()) as { points: number }).points, 10);
    assert.equal((await fetch(`${base}/waitlist/tasks/tg/x`, { method: 'POST', headers: auth, body: '{}' })).status, 404);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
