import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AppError } from '../src/errors.js';
import { createPrivyLogin } from '../src/privy.js';
import { createWaitlistAccess } from '../src/waitlist-access.js';
import { createOpenSignup, openSignupIdentity, parseWaitlistGate } from '../src/waitlist-gate.js';
import { createWaitlistService } from '../src/waitlist.js';
import type { WaitlistEntry, WaitlistRepository } from '../src/waitlist.js';
import { privyFixture, privyMemory } from './fixtures/privy.js';

const x = { type: 'twitter_oauth', subject: '123456789', username: 'cre8_user' };
const google = { type: 'google_oauth', subject: 'g-123', email: 'User@Gmail.com' };
const email = { type: 'email', address: 'user@example.com' };
const pending = (error: unknown) => error instanceof AppError && error.status === 403 && error.code === 'WAITLIST_PENDING';

test('the switch file is parsed fail-closed: only an explicit false opens sign-up', () => {
  assert.deepEqual(parseWaitlistGate(null), { inviteRequired: true });
  assert.deepEqual(parseWaitlistGate('not json'), { inviteRequired: true });
  assert.deepEqual(parseWaitlistGate('{}'), { inviteRequired: true });
  assert.deepEqual(parseWaitlistGate('{"inviteRequired":"false"}'), { inviteRequired: true });
  assert.deepEqual(parseWaitlistGate('{"inviteRequired":true}'), { inviteRequired: true });
  assert.deepEqual(parseWaitlistGate('{"inviteRequired":false}'), { inviteRequired: false });
  const checkedIn = parseWaitlistGate(readFileSync(new URL('../deploy/waitlist-gate.json', import.meta.url), 'utf8'));
  assert.equal(typeof checkedIn.inviteRequired, 'boolean');
});

test('open sign-up admits X or Google only, never email-only or wallet-only', () => {
  assert.equal(openSignupIdentity('did:privy:a', [x])?.method, 'twitter');
  assert.equal(openSignupIdentity('did:privy:a', [google, email])?.method, 'google');
  assert.equal(openSignupIdentity('did:privy:a', [google])?.label, 'user@gmail.com');
  assert.equal(openSignupIdentity('did:privy:a', [email]), null);
  assert.equal(openSignupIdentity('did:privy:a', [{ type: 'wallet', chain_type: 'ethereum', address: '0x' + '1'.repeat(40) }]), null);
});

function harness(required: boolean) {
  const f = privyFixture();
  const memory = privyMemory();
  const approved = new Set<string>();
  const approvals: { privyUserId: string; method: string; label: string }[] = [];
  const openSignup = createOpenSignup({ inviteRequired: () => required, approve: async (identity) => {
    approvals.push({ privyUserId: identity.privyUserId, method: identity.method, label: identity.label });
    approved.add(identity.privyUserId);
  } });
  const access = createWaitlistAccess({ operatorWallets: () => [], lookup: async (id) => approved.has(id) });
  const login = createPrivyLogin({ config: () => f.config, users: memory.users, access, openSignup, now: () => f.now,
    issueSession: async (owner, userId) => ({ token: 'session:' + owner + ':' + userId, expiresAt: new Date(f.now + 1000).toISOString() }) });
  return { f, login, approved, approvals, openSignup };
}

for (const [name, account] of [['X', x], ['Google', google]] as const) {
  test(`inviteRequired false: a ${name} login without an invite is approved and gets a session`, async () => {
    const h = harness(false);
    const session = await h.login({ identityToken: await h.f.sign({ linked_accounts: JSON.stringify([h.f.wallet, account]) }) });
    assert.equal(session.token, 'session:' + h.f.owner + ':' + h.f.userId);
    assert.deepEqual(h.approvals.map(a => a.method), [name === 'X' ? 'twitter' : 'google']);
  });
  test(`inviteRequired true: a ${name} login without an invite stays WAITLIST_PENDING`, async () => {
    const h = harness(true);
    await assert.rejects(h.login({ identityToken: await h.f.sign({ linked_accounts: JSON.stringify([h.f.wallet, account]) }) }), pending);
    assert.equal(h.approvals.length, 0);
  });
}

test('inviteRequired false: email-only and wallet-only logins still need an invite', async () => {
  const h = harness(false);
  await assert.rejects(h.login({ identityToken: await h.f.sign({ linked_accounts: JSON.stringify([h.f.wallet, email]) }) }), pending);
  await assert.rejects(h.login({ identityToken: await h.f.sign() }), pending);
  assert.equal(h.approvals.length, 0);
});

test('a failed auto-approval falls through to the normal access check', async () => {
  const f = privyFixture();
  const login = createPrivyLogin({ config: () => f.config, users: privyMemory().users, now: () => f.now,
    access: createWaitlistAccess({ operatorWallets: () => [], lookup: async () => false }),
    openSignup: createOpenSignup({ inviteRequired: () => false, approve: async () => { throw new Error('db down'); } }),
    issueSession: async () => { throw new Error('unreachable'); } });
  await assert.rejects(login({ identityToken: await f.sign({ linked_accounts: JSON.stringify([f.wallet, x]) }) }), pending);
});

test('/waitlist/me and /waitlist/join report approved while sign-up is open', async () => {
  const h = harness(false);
  const rows = new Map<string, WaitlistEntry>();
  const entry = (privyUserId: string): WaitlistEntry => ({ id: '1', privyUserId, xUserId: x.subject, xHandle: x.username, loginMethod: 'twitter',
    loginLabel: null, status: h.approved.has(privyUserId) ? 'approved' : 'waiting', joinedAt: '2026-11-26T00:00:00.000000Z',
    approvedAt: null, approvedBy: null, points: 0 });
  const repository: WaitlistRepository = {
    join: async (identity) => { const row = entry(identity.privyUserId); rows.set(identity.privyUserId, row); return row; },
    find: async (id) => (rows.has(id) || h.approved.has(id) ? entry(id) : null),
    list: async () => [], transition: async () => { throw new Error('unused'); },
  };
  const service = createWaitlistService({ repository, config: () => h.f.config, now: () => h.f.now, openSignup: h.openSignup });
  const token = await h.f.sign({ linked_accounts: JSON.stringify([x]) });
  assert.equal((await service.me('Bearer ' + token)).status, 'approved');
  assert.equal((await service.join({ identityToken: token })).status, 'approved');

  const closed = harness(true);
  const closedService = createWaitlistService({ repository, config: () => closed.f.config, now: () => closed.f.now, openSignup: closed.openSignup });
  assert.equal((await closedService.join({ identityToken: await closed.f.sign({ linked_accounts: JSON.stringify([x]) }) })).status, 'waiting');
});
