import assert from 'node:assert/strict';
import { randomUUID, randomInt } from 'node:crypto';
import { after, test } from 'node:test';
import { closePool, getPool, query } from '../src/db.js';
import { AppError } from '../src/errors.js';
import { createWaitlistService, PostgresWaitlistRepository } from '../src/waitlist.js';
import type { WaitlistEntry, WaitlistStatus } from '../src/waitlist.js';
import { privyFixture } from './fixtures/privy.js';

const operator = '0x1234567890abcdef1234567890abcdef12345678';
const otherOperator = '0xabcdef1234567890abcdef1234567890abcdef12';
const isError = (status: number, code: string) => (error: unknown) => error instanceof AppError && error.status === status && error.code === code;
const repository = new PostgresWaitlistRepository();
function identity() {
  return { privyUserId: 'did:privy:be127:' + randomUUID(), xUserId: String(randomInt(1, 2 ** 48 - 1)), xHandle: 'cre8_test' };
}
async function pages(status: WaitlistStatus | null, limit: number) {
  const service = createWaitlistService(); const rows: WaitlistEntry[] = []; let cursor: string | null = null;
  do {
    const params = new URLSearchParams({ limit: String(limit) });
    if (status) params.set('status', status);
    if (cursor) params.set('cursor', cursor);
    const page = await service.list(params); rows.push(...page.items); cursor = page.nextCursor;
  } while (cursor);
  return rows;
}
after(closePool);

test('#127 Postgres concurrent join is idempotent, refreshes only handles and rejects X ownership/relink conflicts', async () => {
  const i = identity();
  const joined = await Promise.all(Array.from({ length: 12 }, () => repository.join(i)));
  assert.equal(new Set(joined.map(r => r.id)).size, 1);
  assert.equal(new Set(joined.map(r => r.joinedAt)).size, 1);
  const first = joined[0]; assert.ok(first);
  await repository.transition(first.id, 'approved', operator);
  const updated = await repository.join({ ...i, xHandle: 'changed_handle' });
  assert.equal(updated.xHandle, 'changed_handle'); assert.equal(updated.status, 'approved');
  assert.equal(updated.joinedAt, first.joinedAt); assert.equal(updated.approvedBy, operator);
  const rival = identity();
  await assert.rejects(repository.join({ ...rival, xUserId: i.xUserId }), isError(409, 'X_ALREADY_JOINED'));
  await assert.rejects(repository.join({ ...i, xUserId: rival.xUserId }), isError(409, 'X_ALREADY_JOINED'));
  assert.equal(await repository.find(rival.privyUserId), null);
  assert.deepEqual(await repository.find(i.privyUserId), updated);
  const x = identity();
  const race = await Promise.allSettled(Array.from({ length: 8 }, () => repository.join({ ...identity(), xUserId: x.xUserId })));
  assert.equal(race.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(race.filter(r => r.status === 'rejected' && isError(409, 'X_ALREADY_JOINED')(r.reason)).length, 7);
});

test('#127 Postgres approve/revoke/reapprove preserve audit values on retries and expose revoked as waiting', async () => {
  const i = identity(); const f = privyFixture();
  const service = createWaitlistService({ config: () => f.config });
  const token = await f.sign({ sub: i.privyUserId, linked_accounts: JSON.stringify([{ type: 'twitter_oauth', subject: i.xUserId, username: i.xHandle }]) });
  await assert.rejects(service.me('Bearer ' + token), isError(404, 'NOT_JOINED'));
  const first = await service.join({ identityToken: token }); assert.equal(first.status, 'waiting');
  const row = await repository.find(i.privyUserId); assert.ok(row);
  await assert.rejects(service.transition(row.id, 'revoked', operator), isError(409, 'INVALID_WAITLIST_TRANSITION'));
  const approved = await service.transition(row.id, 'approved', operator.toUpperCase());
  assert.equal(approved.status, 'approved'); assert.ok(approved.approvedAt); assert.equal(approved.approvedBy, operator);
  const attempts = await Promise.all(Array.from({ length: 8 }, () => service.transition(row.id, 'approved', otherOperator)));
  for (const attempt of attempts) assert.deepEqual(attempt, approved);
  assert.equal((await service.me('Bearer ' + token)).status, 'approved');
  const revoked = await service.transition(row.id, 'revoked', operator);
  assert.equal(revoked.status, 'revoked');
  const revokedAt = (await query<{ revoked_at: Date }>('select revoked_at from waitlist where id=$1', [row.id])).rows[0]; assert.ok(revokedAt?.revoked_at);
  assert.deepEqual(await service.transition(row.id, 'revoked', otherOperator), revoked);
  const retriedRevocation = (await query<{ revoked_at: Date }>('select revoked_at from waitlist where id=$1', [row.id])).rows[0];
  assert.deepEqual(retriedRevocation, revokedAt);
  assert.equal((await service.me('Bearer ' + token)).status, 'waiting');
  assert.equal((await service.join({ identityToken: token })).status, 'waiting');
  const again = await service.transition(row.id, 'approved', otherOperator);
  assert.equal(again.approvedBy, otherOperator); assert.equal(again.joinedAt, first.joinedAt);
  assert.ok(again.approvedAt && again.approvedAt >= (approved.approvedAt ?? ''));
  await assert.rejects(service.transition('9223372036854775807', 'approved', operator), isError(404, 'NOT_JOINED'));
  // The waitlist must not register a wallet or mint a CRE8 session.
  assert.equal((await query('select 1 from privy_users where privy_user_id=$1', [i.privyUserId])).rows.length, 0);
});

test('#127 Postgres pagination handles limit 1/100, equal timestamps, microsecond ties and every status filter', async () => {
  const prefix = 'did:privy:be127:' + randomUUID();
  const inserted = await query<{ id: string }>(`insert into waitlist (privy_user_id,x_user_id,x_handle,joined_at,updated_at)
    select $1||':'||n, $1||':'||n, 'page_user',
      '2026-01-01T00:00:00Z'::timestamptz + (n/3)*interval '1 microsecond',
      clock_timestamp() from generate_series(1,103) n returning id::text`, [prefix]);
  const ids = new Set(inserted.rows.map(r => r.id));
  const two = inserted.rows.slice(0, 2); assert.equal(two.length, 2);
  for (const r of two) await repository.transition(r.id, 'approved', operator);
  const second = two[1]; assert.ok(second); await repository.transition(second.id, 'revoked', operator);
  for (const limit of [1, 100]) {
    const all = await pages(null, limit);
    assert.equal(all.length, new Set(all.map(r => r.id)).size, 'no duplicate cursor rows');
    const local = all.filter(r => ids.has(r.id));
    assert.equal(local.length, 103, 'no missing equal-time or sub-millisecond rows');
    assert.deepEqual(local.map(r => r.id), inserted.rows.map(r => r.id));
    for (const status of ['waiting', 'approved', 'revoked'] as const) {
      const filtered = await pages(status, limit);
      assert.ok(filtered.every(r => r.status === status));
      assert.equal(filtered.filter(r => ids.has(r.id)).length, status === 'waiting' ? 101 : 1);
    }
  }
  const service = createWaitlistService();
  const first = await service.list(new URLSearchParams({ status: 'waiting', limit: '1' })); assert.ok(first.nextCursor);
  await assert.rejects(service.list(new URLSearchParams({ status: 'approved', cursor: first.nextCursor })), isError(400, 'INVALID_QUERY'));
  // Cross a decimal digit boundary at the same microsecond; text ORDER BY would skip the smaller id.
  const suffix = BigInt(randomInt(1, 1_000_000_000));
  const bigIds = [(9_000_000_000_000_000n + suffix).toString(), (10_000_000_000_000_000n + suffix).toString()];
  for (const [index, id] of bigIds.entries()) {
    await query(`insert into waitlist (id,privy_user_id,x_user_id,x_handle,joined_at,updated_at)
      values ($1,$2,$2,'large_id','2026-01-01T00:00:01.000001Z',clock_timestamp())`, [id, prefix + ':big:' + index]);
    assert.equal((await repository.transition(id, 'approved', operator)).id, id);
  }
  const large = (await pages(null, 1)).filter(row => bigIds.includes(row.id));
  assert.deepEqual(large.map(row => row.id), bigIds);
});

test('#127 Postgres competing approvals preserve the first operator; lock timeout fails closed and rolls back', { timeout: 15000 }, async () => {
  const i = identity(); const row = await repository.join(i);
  const approved = await Promise.all([repository.transition(row.id, 'approved', operator), repository.transition(row.id, 'approved', otherOperator)]);
  assert.deepEqual(approved[0], approved[1]);
  const locked = await repository.join(identity()); const client = await getPool().connect();
  try {
    await client.query('begin'); await client.query('select id from waitlist where id=$1 for update', [locked.id]);
    await assert.rejects(createWaitlistService().transition(locked.id, 'approved', operator), error => {
      assert.ok(error instanceof AppError); assert.equal(error.status, 503); assert.equal(error.code, 'WAITLIST_UNAVAILABLE');
      assert.equal(error.cause, undefined); return true;
    });
  } finally { await client.query('rollback'); client.release(); }
  assert.equal((await repository.find(locked.privyUserId))?.status, 'waiting');
  assert.equal((await repository.transition(locked.id, 'approved', operator)).status, 'approved');
});
