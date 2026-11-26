import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AppError } from '../src/errors.js';
import { createPrivyLogin } from '../src/privy.js';
import { createWaitlistAccess } from '../src/waitlist-access.js';
import { createOpenSignup, openSignupIdentity, parseWaitlistGate, viewPassMatches } from '../src/waitlist-gate.js';
import { hashInviteCode } from '../src/waitlist-invites.js';
import { createWaitlistService } from '../src/waitlist.js';
import type { WaitlistEntry, WaitlistRepository } from '../src/waitlist.js';
import { privyFixture, privyMemory } from './fixtures/privy.js';

const x = { type: 'twitter_oauth', subject: '123456789', username: 'cre8_user' };
const google = { type: 'google_oauth', subject: 'g-123', email: 'User@Gmail.com' };
const email = { type: 'email', address: 'user@example.com' };
const pending = (error: unknown) => error instanceof AppError && error.status === 403 && error.code === 'WAITLIST_PENDING';
const HASH = hashInviteCode('BBWCRE8');

test('the switch file is parsed fail-closed: only an explicit false opens sign-up; the view pass needs a valid hash', () => {
  const closed = { inviteRequired: true, accessCodeHash: null };
  assert.deepEqual(parseWaitlistGate(null), closed);
  assert.deepEqual(parseWaitlistGate('not json'), closed);
  assert.deepEqual(parseWaitlistGate('{}'), closed);
  assert.deepEqual(parseWaitlistGate('{"inviteRequired":"false"}'), closed);
  assert.deepEqual(parseWaitlistGate('{"inviteRequired":true}'), closed);
  assert.deepEqual(parseWaitlistGate('{"inviteRequired":false}'), { inviteRequired: false, accessCodeHash: null });
  assert.deepEqual(parseWaitlistGate(JSON.stringify({ inviteRequired: true, accessCodeHash: HASH })), { inviteRequired: true, accessCodeHash: HASH });
  assert.deepEqual(parseWaitlistGate(JSON.stringify({ accessCodeHash: HASH, accessCodeEnabled: false })), closed);
  assert.deepEqual(parseWaitlistGate(JSON.stringify({ accessCodeHash: 'BBWCRE8' })), closed);
  const checkedIn = parseWaitlistGate(readFileSync(new URL('../deploy/waitlist-gate.json', import.meta.url), 'utf8'));
  assert.equal(typeof checkedIn.inviteRequired, 'boolean');
});

test('the view pass matches trimmed and case-insensitive, and nothing when off', () => {
  assert.equal(viewPassMatches('BBWCRE8', HASH), true);
  assert.equal(viewPassMatches('  bbwcre8 ', HASH), true);
  assert.equal(viewPassMatches('BBWCRE9', HASH), false);
  assert.equal(viewPassMatches(undefined, HASH), false);
  assert.equal(viewPassMatches('x'.repeat(65), HASH), false);
  assert.equal(viewPassMatches('BBWCRE8', null), false);
});

test('open sign-up needs both X and Google', () => {
  assert.equal(openSignupIdentity('did:privy:a', [x, google])?.method, 'twitter');
  assert.equal(openSignupIdentity('did:privy:a', [google, x, email])?.xHandle, 'cre8_user');
  assert.equal(openSignupIdentity('did:privy:a', [x]), null);
  assert.equal(openSignupIdentity('did:privy:a', [google]), null);
  assert.equal(openSignupIdentity('did:privy:a', [email]), null);
  assert.equal(openSignupIdentity('did:privy:a', [google, email]), null);
  assert.equal(openSignupIdentity('did:privy:a', [{ ...x, username: 'bad handle!' }, google]), null);
  assert.equal(openSignupIdentity('did:privy:a', [{ type: 'wallet', chain_type: 'ethereum', address: '0x' + '1'.repeat(40) }]), null);
});

function harness(required: boolean) {
  const f = privyFixture();
  const memory = privyMemory();
  const approved = new Set<string>();
  const approvals: { privyUserId: string; method: string }[] = [];
  const openSignup = createOpenSignup({ inviteRequired: () => required, approve: async (identity) => {
    approvals.push({ privyUserId: identity.privyUserId, method: identity.method });
    approved.add(identity.privyUserId);
  } });
  const access = createWaitlistAccess({ operatorWallets: () => [], lookup: async (id) => approved.has(id) });
  const login = createPrivyLogin({ config: () => f.config, users: memory.users, access, openSignup, now: () => f.now,
    issueSession: async (owner, userId) => ({ token: 'session:' + owner + ':' + userId, expiresAt: new Date(f.now + 1000).toISOString() }) });
  const signWith = (...accounts: object[]) => f.sign({ linked_accounts: JSON.stringify([f.wallet, ...accounts]) });
  return { f, login, approved, approvals, openSignup, signWith };
}

test('inviteRequired false: an X + Google login without an invite is approved and gets a session', async () => {
  const h = harness(false);
  const session = await h.login({ identityToken: await h.signWith(x, google) });
  assert.equal(session.token, 'session:' + h.f.owner + ':' + h.f.userId);
  assert.deepEqual(h.approvals.map(a => a.method), ['twitter']);
});

test('inviteRequired false: X only, Google only, email and wallet-only still need an invite', async () => {
  const h = harness(false);
  for (const accounts of [[x], [google], [email], [google, email], []]) {
    await assert.rejects(h.login({ identityToken: await h.signWith(...accounts) }), pending);
  }
  assert.equal(h.approvals.length, 0);
});

test('inviteRequired true: an X + Google login without an invite stays WAITLIST_PENDING', async () => {
  const h = harness(true);
  await assert.rejects(h.login({ identityToken: await h.signWith(x, google) }), pending);
  assert.equal(h.approvals.length, 0);
});

test('a failed auto-approval falls through to the normal access check', async () => {
  const f = privyFixture();
  const login = createPrivyLogin({ config: () => f.config, users: privyMemory().users, now: () => f.now,
    access: createWaitlistAccess({ operatorWallets: () => [], lookup: async () => false }),
    openSignup: createOpenSignup({ inviteRequired: () => false, approve: async () => { throw new Error('db down'); } }),
    issueSession: async () => { throw new Error('unreachable'); } });
  await assert.rejects(login({ identityToken: await f.sign({ linked_accounts: JSON.stringify([f.wallet, x, google]) }) }), pending);
});

test('/waitlist/me and /waitlist/join report approved for X + Google while sign-up is open', async () => {
  const h = harness(false);
  const entry = (privyUserId: string): WaitlistEntry => ({ id: '1', privyUserId, xUserId: x.subject, xHandle: x.username, loginMethod: 'twitter',
    loginLabel: null, status: h.approved.has(privyUserId) ? 'approved' : 'waiting', joinedAt: '2026-11-26T00:00:00.000000Z',
    approvedAt: null, approvedBy: null, points: 0 });
  const rows = new Set<string>();
  const repository: WaitlistRepository = {
    join: async (identity) => { rows.add(identity.privyUserId); return entry(identity.privyUserId); },
    find: async (id) => (rows.has(id) || h.approved.has(id) ? entry(id) : null),
    list: async () => [], transition: async () => { throw new Error('unused'); },
  };
  const service = createWaitlistService({ repository, config: () => h.f.config, now: () => h.f.now, openSignup: h.openSignup });
  assert.equal((await service.join({ identityToken: await h.f.sign({ linked_accounts: JSON.stringify([x]) }) })).status, 'waiting');
  const both = await h.f.sign({ linked_accounts: JSON.stringify([x, google]) });
  assert.equal((await service.me('Bearer ' + both)).status, 'approved');
  assert.equal((await service.join({ identityToken: both })).status, 'approved');
});

test('HTTP /waitlist/gate reports the checked-in switches and checks the view pass without granting anything', async () => {
  const { createServer } = await import('../src/server.js');
  const { loadRateLimitConfig } = await import('../src/config.js');
  const { MemoryRateLimitStore, RequestRateLimiter } = await import('../src/ratelimit.js');
  const file = parseWaitlistGate(readFileSync(new URL('../deploy/waitlist-gate.json', import.meta.url), 'utf8'));
  const server = createServer({ rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore()) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const gate = await fetch(base + '/waitlist/gate');
    assert.equal(gate.status, 200);
    assert.deepEqual(await gate.json(), { openSignup: !file.inviteRequired, viewPass: file.accessCodeHash !== null });
    const post = (code: unknown) => fetch(base + '/waitlist/gate', { method: 'POST', body: JSON.stringify({ code }) });
    const wrong = await post('NOTTHIS1');
    assert.equal(wrong.status, 404);
    assert.equal(((await wrong.json()) as { error: { code: string } }).error?.code ?? 'INVITE_INVALID', 'INVITE_INVALID');
    const right = await post(' bbwcre8 ');
    if (file.accessCodeHash === null) assert.equal(right.status, 404);
    else {
      assert.equal(right.status, 200);
      const body = await right.json() as Record<string, unknown>;
      assert.deepEqual(body, { viewPass: true });
      assert.equal(right.headers.get('set-cookie'), null);
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
