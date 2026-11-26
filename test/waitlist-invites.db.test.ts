import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomInt, randomUUID } from 'node:crypto';
import { closePool, getPool, query } from '../src/db.js';
import { AppError } from '../src/errors.js';
import { createWaitlistInviteService, hashInviteCode, PostgresInviteRepository } from '../src/waitlist-invites.js';
import type { InviteEntry, InviteStatus } from '../src/waitlist-invites.js';
import { PostgresWaitlistRepository } from '../src/waitlist.js';
import { privyFixture } from './fixtures/privy.js';
import { createServer } from '../src/server.js';
import { MemoryRateLimitStore, RequestRateLimiter } from '../src/ratelimit.js';
import { loadRateLimitConfig } from '../src/config.js';

const operator = '0x1234567890abcdef1234567890abcdef12345678';
const otherOperator = '0xabcdef1234567890abcdef1234567890abcdef12';
const repository = new PostgresInviteRepository();
const waitlist = new PostgresWaitlistRepository();
const service = createWaitlistInviteService();
const isError = (status: number, code: string) => (error: unknown) => error instanceof AppError && error.status === status && error.code === code;
function identity() { return { privyUserId: 'did:privy:be131:' + randomUUID(), method: 'twitter' as const, xUserId: String(randomInt(1, 2 ** 48 - 1)), xHandle: 'invite_user', label: '@invite_user' }; }
async function issue(count = 1, issuedTo: string | null = 'alice') {
  const batch = await service.issue({ count, issuedTo, batchNote: 'be131 ' + randomUUID() }, operator);
  const first = batch.items[0]; assert.ok(first);
  return { ...batch, first };
}
async function stored(id: string) {
  const row = (await query<{ status: string; code: string; used_by_waitlist_id: string | null; used_at: Date | null; revoked_at: Date | null; revoked_by: string | null }>(
    'select status,code,used_by_waitlist_id::text,used_at,revoked_at,revoked_by from waitlist_invites where id=$1', [id])).rows[0];
  assert.ok(row); return row;
}
async function pages(batch: string, status: InviteStatus | null, limit: number) {
  const rows: InviteEntry[] = []; let cursor: string | null = null;
  do {
    const params = new URLSearchParams({ batch, limit: String(limit) });
    if (status) params.set('status', status);
    if (cursor) params.set('cursor', cursor);
    const page = await service.list(params); rows.push(...page.items); cursor = page.nextCursor;
  } while (cursor);
  return rows;
}
after(closePool);

test('#131 signed social-only HTTP redemption persists approval and prevents a second code from being consumed', async () => {
  const f = privyFixture(); const user = identity(); const batch = await issue(2);
  const token = await f.sign({ sub: user.privyUserId, linked_accounts: JSON.stringify([
    { type: 'twitter_oauth', subject: user.xUserId, username: user.xHandle },
  ]) });
  const server = createServer({ waitlistInvites: createWaitlistInviteService({ config: () => f.config }),
    rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore()) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const post = (code: string) => fetch(`http://127.0.0.1:${address.port}/waitlist/redeem`, {
      method: 'POST', body: JSON.stringify({ identityToken: token, code: ' ' + code.toLowerCase() + ' ', xHandle: 'forged' }),
    });
    const response = await post(batch.first.code); assert.equal(response.status, 200);
    const entry = await waitlist.find(user.privyUserId); assert.ok(entry);
    assert.deepEqual(await response.json(), { status: 'approved', loginMethod: 'twitter', xHandle: user.xHandle, joinedAt: entry.joinedAt });
    assert.equal(entry.approvedBy, 'invite:' + batch.first.id);
    const second = batch.items[1]; assert.ok(second);
    const repeated = await post(second.code); assert.equal(repeated.status, 409);
    assert.deepEqual(await repeated.json(), { error: { code: 'ALREADY_APPROVED', message: 'waitlist entry is already approved' } });
    assert.equal((await stored(second.id)).status, 'unused');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('#131 Postgres creates a whole 500-code batch of hashes and never returns plaintext/hash in later reads', async () => {
  const batch = await issue(500, 'boundary-' + randomUUID());
  assert.equal(batch.items.length, 500);
  const storedRows = (await query<{ id: string; code: string; created_by: string }>('select id::text,code,created_by from waitlist_invites where batch_id=$1', [batch.batchId])).rows;
  assert.equal(storedRows.length, 500);
  const hashes = new Map(batch.items.map(item => [item.id, hashInviteCode(item.code)]));
  for (const row of storedRows) { assert.equal(row.code, hashes.get(row.id)); assert.equal(row.created_by, operator); }
  const page = await pages(batch.batchId, null, 100);
  assert.equal(page.length, 500);
  for (const item of batch.items) {
    assert.ok(!JSON.stringify(page).includes(item.code)); assert.ok(!JSON.stringify(page).includes(hashInviteCode(item.code)));
  }
  assert.deepEqual((await service.summary(new URLSearchParams({ batch: batch.batchId }))).items,
    [{ issuedTo: batch.issuedTo, issued: '500', used: '0' }]);
});

test('#131 Postgres concurrent redemption of one code has one winner and no losing registrations', async () => {
  const batch = await issue(); const users = Array.from({ length: 12 }, identity);
  const results = await Promise.allSettled(users.map(user => repository.redeem(user, hashInviteCode(batch.first.code))));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected' && isError(409, 'INVITE_USED')(r.reason)).length, 11);
  const invite = await stored(batch.first.id); assert.equal(invite.status, 'used'); assert.ok(invite.used_at);
  const entries = (await query<{ id: string; status: string; approved_by: string; same_time: boolean }>(`select id::text,status,approved_by,
    approved_at=(select used_at from waitlist_invites where id=$2) as same_time from waitlist where privy_user_id=any($1::text[])`, [users.map(u => u.privyUserId), batch.first.id])).rows;
  assert.equal(entries.length, 1); const entry = entries[0]; assert.ok(entry);
  assert.equal(entry.status, 'approved'); assert.equal(entry.approved_by, 'invite:' + batch.first.id);
  assert.equal(entry.same_time, true); assert.equal(invite.used_by_waitlist_id, entry.id);
  const listed = await pages(batch.batchId, 'used', 1); assert.equal(listed[0]?.xHandle, 'invite_user');
  assert.deepEqual((await service.summary(new URLSearchParams({ batch: batch.batchId }))).items, [{ issuedTo: 'alice', issued: '1', used: '1' }]);
});

test('#131 Postgres same-user different-code race approves once and keeps the second code unused', async () => {
  const batch = await issue(2); const user = identity();
  const results = await Promise.allSettled(batch.items.map(item => repository.redeem(user, hashInviteCode(item.code))));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected' && isError(409, 'ALREADY_APPROVED')(r.reason)).length, 1);
  const rows = await pages(batch.batchId, null, 100);
  assert.equal(rows.filter(row => row.status === 'used').length, 1); assert.equal(rows.filter(row => row.status === 'unused').length, 1);
  const entry = await waitlist.find(user.privyUserId); assert.ok(entry);
  const before = { ...entry };
  for (const item of batch.items) await assert.rejects(repository.redeem(user, hashInviteCode(item.code)), isError(409, 'ALREADY_APPROVED'));
  assert.deepEqual(await waitlist.find(user.privyUserId), before);
});

test('#131 Postgres existing waiting identity refreshes handle; approved/revoked/conflicting identities consume nothing', async () => {
  const batch = await issue(4); const user = identity();
  const entry = await waitlist.join(user);
  const result = await repository.redeem({ ...user, xHandle: 'new_handle' }, hashInviteCode(batch.first.code));
  assert.equal(result.status, 'approved'); assert.equal(result.joinedAt, entry.joinedAt); assert.equal(result.xHandle, 'new_handle');
  const second = batch.items[1], third = batch.items[2], fourth = batch.items[3]; assert.ok(second && third && fourth);
  await assert.rejects(repository.redeem(user, hashInviteCode(second.code)), isError(409, 'ALREADY_APPROVED'));
  await assert.rejects(repository.redeem({ ...identity(), xUserId: user.xUserId }, hashInviteCode(second.code)), isError(409, 'X_ALREADY_JOINED'));
  await assert.rejects(repository.redeem({ ...user, xUserId: identity().xUserId }, hashInviteCode(third.code)), isError(409, 'X_ALREADY_JOINED'));
  await waitlist.transition(entry.id, 'revoked', operator);
  await assert.rejects(repository.redeem(user, hashInviteCode(fourth.code)), isError(409, 'INVALID_WAITLIST_TRANSITION'));
  for (const item of [second, third, fourth]) assert.equal((await stored(item.id)).status, 'unused');
  assert.equal((await query('select 1 from privy_users where privy_user_id=$1', [user.privyUserId])).rows.length, 0);
  const unknown = identity();
  await assert.rejects(repository.redeem(unknown, hashInviteCode(randomUUID())), isError(404, 'INVITE_INVALID'));
  assert.equal(await waitlist.find(unknown.privyUserId), null);
});

test('#131 Postgres revoke is idempotent and terminal, used codes cannot revoke, revoked codes cannot create a registration', async () => {
  const batch = await issue(2); const second = batch.items[1]; assert.ok(second);
  await service.revoke(batch.first.id, operator.toUpperCase());
  const before = await stored(batch.first.id); assert.equal(before.status, 'revoked'); assert.equal(before.revoked_by, operator); assert.ok(before.revoked_at);
  await service.revoke(batch.first.id, otherOperator); assert.deepEqual(await stored(batch.first.id), before);
  const user = identity(); await assert.rejects(repository.redeem(user, hashInviteCode(batch.first.code)), isError(410, 'INVITE_EXPIRED'));
  assert.equal(await waitlist.find(user.privyUserId), null);
  await repository.redeem(user, hashInviteCode(second.code));
  const used = await stored(second.id);
  await assert.rejects(service.revoke(second.id, operator), isError(409, 'INVITE_USED'));
  assert.deepEqual(await stored(second.id), used);
  await assert.rejects(service.revoke('9223372036854775807', operator), isError(404, 'INVITE_INVALID'));
  assert.equal((await pages(batch.batchId, 'revoked', 100)).length, 1);
});

test('#131 Postgres expired code stays unused and expired-at-lock-release checks DB clock after both locks', { timeout: 15000 }, async () => {
  const user = identity(); const entry = await waitlist.join(user);
  const code = hashInviteCode(randomUUID()); const batchId = randomUUID();
  const row = (await query<{ id: string }>(`insert into waitlist_invites(code,batch_id,created_by,created_at,expires_at)
    values($1,$2,$3,clock_timestamp()-interval '1 second',clock_timestamp()+interval '500 milliseconds') returning id::text`, [code, batchId, operator])).rows[0]; assert.ok(row);
  const client = await getPool().connect();
  try {
    await client.query('begin'); await client.query('select id from waitlist where id=$1 for update', [entry.id]);
    const attempt = repository.redeem(user, code);
    // Hold the second lock across expiry while the redemption transaction has already begun.
    await client.query('select pg_sleep(0.8)'); await client.query('rollback');
    await assert.rejects(attempt, isError(410, 'INVITE_EXPIRED'));
  } finally { await client.query('rollback'); client.release(); }
  assert.equal((await stored(row.id)).status, 'unused'); assert.equal((await waitlist.find(user.privyUserId))?.status, 'waiting');
  assert.equal((await pages(batchId, 'expired', 1)).length, 1); assert.equal((await pages(batchId, 'unused', 1)).length, 0);
  const newcomer = identity(); await assert.rejects(repository.redeem(newcomer, code), isError(410, 'INVITE_EXPIRED'));
  assert.equal(await waitlist.find(newcomer.privyUserId), null);
});

test('#131 Postgres keyset pagination keeps microseconds, bigint order, filters and null-recipient summary', async () => {
  const batchId = randomUUID();
  const inserted = (await query<{ id: string }>(`insert into waitlist_invites(code,batch_id,created_by,created_at)
    select upper(replace(gen_random_uuid()::text,'-','')),$1,$2,'2026-01-01T00:00:00Z'::timestamptz+(n/3)*interval '1 microsecond'
    from generate_series(1,103) n returning id::text`, [batchId, operator])).rows;
  assert.equal(inserted.length, 103);
  for (const limit of [1, 100]) {
    const rows = await pages(batchId, 'unused', limit);
    assert.equal(rows.length, 103); assert.equal(new Set(rows.map(row => row.id)).size, 103);
    assert.deepEqual(rows.map(row => row.id), inserted.map(row => row.id));
  }
  const suffix = BigInt(randomInt(1, 1_000_000_000));
  const ids = [(9_000_000_000_000_000n + suffix).toString(), (10_000_000_000_000_000n + suffix).toString()];
  for (const id of ids) await query(`insert into waitlist_invites(id,code,batch_id,created_by,created_at)
    values($1,$2,$3,$4,'2026-01-01T00:00:01.000001Z')`, [id, hashInviteCode(randomUUID()), batchId, operator]);
  assert.deepEqual((await pages(batchId, null, 1)).filter(row => ids.includes(row.id)).map(row => row.id), ids);
  assert.deepEqual((await service.summary(new URLSearchParams({ batch: batchId }))).items, [{ issuedTo: null, issued: '105', used: '0' }]);
  assert.deepEqual((await service.list(new URLSearchParams({ batch: randomUUID() }))), { items: [], nextCursor: null });
});

test('#131 Postgres invite row-lock timeout fails closed and leaves both rows unchanged', { timeout: 15000 }, async () => {
  const batch = await issue(); const user = identity(); const entry = await waitlist.join(user);
  const f = privyFixture(); const token = await f.sign({ sub: user.privyUserId, linked_accounts: JSON.stringify([
    { type: 'twitter_oauth', subject: user.xUserId, username: user.xHandle },
  ]) });
  const client = await getPool().connect();
  try {
    await client.query('begin'); await client.query('select id from waitlist_invites where id=$1 for update', [batch.first.id]);
    const s = createWaitlistInviteService({ config: () => f.config });
    for (const call of [() => s.redeem({ identityToken: token, code: batch.first.code }), () => s.revoke(batch.first.id, operator)]) {
      await assert.rejects(call(), error => {
        assert.ok(error instanceof AppError); assert.equal(error.status, 503); assert.equal(error.code, 'INVITES_UNAVAILABLE');
        assert.equal(error.cause, undefined); assert.doesNotMatch(error.message, /postgres|token|seed/); return true;
      });
    }
  } finally { await client.query('rollback'); client.release(); }
  assert.equal((await stored(batch.first.id)).status, 'unused'); assert.deepEqual(await waitlist.find(user.privyUserId), entry);
  assert.equal((await repository.redeem(user, hashInviteCode(batch.first.code))).status, 'approved');
});

test('#196 Postgres email/Google redemptions approve without X, record the login, and X users cannot collide with them', async () => {
  const batch = await issue(4);
  const [a, b, c, d] = batch.items; assert.ok(a && b && c && d);
  const emailUser = { privyUserId: 'did:privy:be196:' + randomUUID(), method: 'email' as const, xUserId: null, xHandle: null, label: 'ada@example.com' };
  const result = await repository.redeem(emailUser, hashInviteCode(a.code));
  assert.equal(result.status, 'approved'); assert.equal(result.loginMethod, 'email'); assert.equal(result.xHandle, null);
  const entry = await waitlist.find(emailUser.privyUserId); assert.ok(entry);
  assert.deepEqual([entry.status, entry.loginMethod, entry.loginLabel, entry.xUserId, entry.xHandle], ['approved', 'email', 'ada@example.com', null, null]);
  await assert.rejects(repository.redeem(emailUser, hashInviteCode(b.code)), isError(409, 'ALREADY_APPROVED'));
  // The same Privy user later redeeming with an X link is the same person, not an identity conflict.
  await assert.rejects(repository.redeem({ ...identity(), privyUserId: emailUser.privyUserId }, hashInviteCode(b.code)), isError(409, 'ALREADY_APPROVED'));
  const googleUser = { privyUserId: 'did:privy:be196:' + randomUUID(), method: 'google' as const, xUserId: null, xHandle: null, label: 'Google account' };
  assert.equal((await repository.redeem(googleUser, hashInviteCode(c.code))).loginMethod, 'google');
  const xUser = identity();
  const xResult = await repository.redeem(xUser, hashInviteCode(d.code));
  assert.deepEqual([xResult.loginMethod, xResult.xHandle], ['twitter', xUser.xHandle]);
  const xEntry = await waitlist.find(xUser.privyUserId); assert.ok(xEntry);
  assert.deepEqual([xEntry.loginMethod, xEntry.loginLabel, xEntry.xUserId], ['twitter', null, xUser.xUserId]);
  assert.equal((await stored(b.id)).status, 'unused');
  // Listing shows who used each code, including non-X users (xHandle null).
  const used = (await pages(batch.batchId, 'used', 100)).map(row => row.xHandle).sort();
  assert.deepEqual(used, [null, null, xUser.xHandle].sort());
});
