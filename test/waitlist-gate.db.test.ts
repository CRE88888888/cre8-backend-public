import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { closePool, migrate, query } from '../src/db.js';
import { postgresWaitlistAccess } from '../src/waitlist-access.js';
import { openSignupIdentity, postgresOpenApprove } from '../src/waitlist-gate.js';

before(migrate);
after(closePool);

const row = async (id: string) => (await query<{ status: string; login_method: string; login_label: string | null; x_handle: string | null; approved_by: string | null }>(
  'select status,login_method,login_label,x_handle,approved_by from waitlist where privy_user_id=$1', [id])).rows[0];

test('open sign-up inserts and approves a new X or Google identity, recording the login like a redemption', async () => {
  const xId = 'did:privy:gate:' + randomUUID();
  const xSubject = String(1_000_000_000 + Math.floor(Math.random() * 1e9));
  const xIdentity = openSignupIdentity(xId, [{ type: 'twitter_oauth', subject: xSubject, username: 'gate_x' }]);
  assert.ok(xIdentity);
  await postgresOpenApprove(xIdentity);
  await postgresOpenApprove(xIdentity); // idempotent
  assert.deepEqual(await row(xId), { status: 'approved', login_method: 'twitter', login_label: null, x_handle: 'gate_x', approved_by: 'open-signup' });
  assert.equal(await postgresWaitlistAccess(xId), true);

  const gId = 'did:privy:gate:' + randomUUID();
  const gIdentity = openSignupIdentity(gId, [{ type: 'google_oauth', subject: 'g' + randomUUID().slice(0, 8), email: 'gate@gmail.com' }]);
  assert.ok(gIdentity);
  await postgresOpenApprove(gIdentity);
  assert.deepEqual(await row(gId), { status: 'approved', login_method: 'google', login_label: 'gate@gmail.com', x_handle: null, approved_by: 'open-signup' });
});

test('open sign-up approves a waiting entry but never re-admits a revoked one', async () => {
  const waitingId = 'did:privy:gate:' + randomUUID();
  const subject = String(2_000_000_000 + Math.floor(Math.random() * 1e9));
  await query('insert into waitlist (privy_user_id,x_user_id,x_handle) values ($1,$2,$3)', [waitingId, subject, 'gate_wait']);
  const identity = openSignupIdentity(waitingId, [{ type: 'twitter_oauth', subject, username: 'gate_wait' }]);
  assert.ok(identity);
  await postgresOpenApprove(identity);
  assert.equal((await row(waitingId))?.status, 'approved');

  await query("update waitlist set status='revoked', revoked_at=clock_timestamp() where privy_user_id=$1", [waitingId]);
  await postgresOpenApprove(identity);
  assert.equal((await row(waitingId))?.status, 'revoked');
});
