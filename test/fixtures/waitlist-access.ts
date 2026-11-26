import { randomUUID } from 'node:crypto';
import { query } from '../../src/db.js';
import type { WaitlistAccess } from '../../src/waitlist-access.js';
import type { SessionCredentials } from '../../src/auth.js';
import { createPrivyLogin } from '../../src/privy.js';
import { privyFixture } from './privy.js';
import assert from 'node:assert/strict';

/** Unrelated unit tests inject a successful access decision; policy has its own real-gate tests. */
export const approvedTestAccess: WaitlistAccess = async () => {};

/** HTTP integration fixtures keep the real gate and explicitly approve their disposable identities. */
export async function approveTestUser(privyUserId: string): Promise<void> {
  await query(`insert into waitlist (privy_user_id, x_user_id, x_handle)
    values ($1, $2, 'auth_test') on conflict (privy_user_id) do nothing`, [privyUserId, randomUUID()]);
  await query(`update waitlist set status='approved', approved_at=clock_timestamp(),
    approved_by='test-fixture', revoked_at=null where privy_user_id=$1`, [privyUserId]);
}

export async function approveTestWallet(owner: string): Promise<string> {
  const wallet = owner.toLowerCase();
  const userId = 'did:privy:test-wallet:' + wallet;
  await approveTestUser(userId);
  return userId;
}

const fixture = privyFixture();
/** Real offline Privy verification + Postgres gate/session for unrelated HTTP route tests. */
export const testPrivyLogin = createPrivyLogin({ config: () => fixture.config });
export async function loginTestWallet(base: string, owner: string): Promise<SessionCredentials> {
  const userId = await approveTestWallet(owner);
  const identityToken = await fixture.sign({ sub: userId,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    linked_accounts: JSON.stringify([{ ...fixture.wallet, address: owner }]) });
  const response = await fetch(base + '/auth/privy', { method: 'POST', body: JSON.stringify({ identityToken }) });
  assert.equal(response.status, 200);
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null && 'token' in body && typeof body.token === 'string' &&
    'expiresAt' in body && typeof body.expiresAt === 'string');
  return { token: body.token, expiresAt: body.expiresAt };
}

/** Scope the real environment exception to one offline SIWE operator test and restore it afterward. */
export async function withTestOperator<T>(owner: string, run: () => Promise<T>): Promise<T> {
  const before = process.env.OPERATOR_WALLETS;
  process.env.OPERATOR_WALLETS = owner;
  try { return await run(); }
  finally {
    if (before === undefined) delete process.env.OPERATOR_WALLETS;
    else process.env.OPERATOR_WALLETS = before;
  }
}
