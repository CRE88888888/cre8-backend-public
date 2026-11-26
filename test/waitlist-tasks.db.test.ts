import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { closePool, query } from '../src/db.js';
import { createWaitlistService, PostgresWaitlistRepository } from '../src/waitlist.js';
import type { WaitlistEntry } from '../src/waitlist.js';
import { createWaitlistTaskService, PostgresWaitlistTaskRepository } from '../src/waitlist-tasks.js';
import { privyFixture } from './fixtures/privy.js';

const members = new PostgresWaitlistRepository();
const tasks = new PostgresWaitlistTaskRepository();
after(closePool);

async function pages(limit: number) {
  const service = createWaitlistService(); const rows: WaitlistEntry[] = []; let cursor: string | null = null;
  do {
    const params = new URLSearchParams({ limit: String(limit), status: 'waiting' });
    if (cursor) params.set('cursor', cursor);
    const page = await service.list(params); rows.push(...page.items); cursor = page.nextCursor;
  } while (cursor);
  return rows;
}

test('#198 Postgres: full service path stores normalized URL and kept answers; concurrent repeats add points once', async () => {
  const fixture = privyFixture();
  const xUserId = String(randomInt(1, 2 ** 48 - 1));
  const twitter = { type: 'twitter_oauth', subject: xUserId, username: 'Task_User' };
  const entry = await members.join({ privyUserId: fixture.userId, xUserId, xHandle: 'task_user' });
  const service = createWaitlistTaskService({ config: () => fixture.config, now: () => fixture.now });
  const bearer = async (accounts: unknown[]) => 'Bearer ' + await fixture.sign({ linked_accounts: JSON.stringify(accounts) });
  assert.equal((await service.tasks(await bearer([twitter]))).points, 0);
  const results = await Promise.all(Array.from({ length: 8 }, async () =>
    service.complete(await bearer([twitter]), 'post', { url: 'https://twitter.com/TASK_USER/status/42?s=20' })));
  assert.ok(results.every(r => r.points === 5));
  await service.complete(await bearer([twitter]), 'quiz', { answers: { hold: 'Yes', where: 'Both', other: 'No', type: 'Passive' } });
  await service.complete(await bearer([twitter, { type: 'google_oauth', subject: '1234567890', email: 'a@gmail.com' }]), 'gmail', {});
  const state = await service.complete(await bearer([twitter]), 'quiz', { answers: { hold: 'Not yet', other: 'No', type: 'Active trader' } });
  assert.equal(state.points, 25);
  const rows = (await query<{ task: string; points: number; post_url: string | null; answers: unknown }>(
    'select task,points,post_url,answers from waitlist_tasks where waitlist_id=$1 order by task', [entry.id])).rows;
  assert.deepEqual(rows, [
    { task: 'gmail', points: 5, post_url: null, answers: null },
    { task: 'post', points: 5, post_url: 'https://x.com/TASK_USER/status/42', answers: null },
    // First answers are kept; the stale "other" pick was dropped before storing.
    { task: 'quiz', points: 15, post_url: null, answers: { hold: 'Yes', where: 'Both', type: 'Passive' } },
  ]);
  assert.equal((await members.find(fixture.userId))?.points, 25);
});

test('#198 Postgres: operator list orders by points (high first), then earlier join, then id; cursor pages are stable', async () => {
  const prefix = 'did:privy:be198:' + randomUUID();
  // a: earliest, 0 points; b and c: same 15 points, b joined first; d: latest, all 35 points.
  const inserted = (await query<{ id: string; privy_user_id: string }>(`insert into waitlist (privy_user_id,x_user_id,x_handle,joined_at,updated_at)
    select $1||':'||n, $1||':'||n, 'order_user', '2026-01-01T00:00:00Z'::timestamptz + n*interval '1 second', clock_timestamp()
    from unnest(array['a','b','c','d']) with ordinality as t(n0,n) returning id::text, privy_user_id`, [prefix])).rows;
  const id = (suffix: number) => { const row = inserted.find(r => r.privy_user_id === `${prefix}:${suffix}`); assert.ok(row); return row.id; };
  const [a, b, c, d] = [id(1), id(2), id(3), id(4)];
  await tasks.complete(b, 'quiz', { postUrl: null, answers: { hold: 'Yes', where: 'Both', type: 'Passive' } });
  await tasks.complete(c, 'tg', { postUrl: null, answers: null });
  await tasks.complete(c, 'post', { postUrl: 'https://x.com/order_user/status/1', answers: null });
  await tasks.complete(d, 'post', { postUrl: 'https://x.com/order_user/status/2', answers: null });
  await tasks.complete(d, 'gmail', { postUrl: null, answers: null });
  await tasks.complete(d, 'quiz', { postUrl: null, answers: { hold: 'Not yet', other: 'No', type: 'Passive' } });
  await tasks.complete(d, 'tg', { postUrl: null, answers: null });
  for (const limit of [1, 2, 100]) {
    const all = await pages(limit);
    assert.equal(all.length, new Set(all.map(r => r.id)).size, 'no duplicate cursor rows');
    const local = all.filter(r => [a, b, c, d].includes(r.id));
    assert.deepEqual(local.map(r => [r.id, r.points]), [[d, 35], [b, 15], [c, 15], [a, 0]]);
    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1], cur = all[i]; assert.ok(prev && cur);
      assert.ok(prev.points > cur.points || (prev.points === cur.points && prev.joinedAt <= cur.joinedAt), 'release order');
    }
  }
});
