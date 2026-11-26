import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mnemonicToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { AuthStore, sha256Hex, SESSION_TTL_MS } from '../src/auth.js';
import { loadRateLimitConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { createPrivyLogin } from '../src/privy.js';
import { MemoryRateLimitStore, RequestRateLimiter } from '../src/ratelimit.js';
import { createServer } from '../src/server.js';
import type { ServerDeps } from '../src/server.js';
import { createWaitlistAccess, resolveOperatorWallets } from '../src/waitlist-access.js';
import type { WaitlistStatus } from '../src/waitlist.js';
import { createWaitlistService } from '../src/waitlist.js';
import { privyFixture, privyMemory } from './fixtures/privy.js';

// Public local-test mnemonic; signatures are computed offline and never submitted to a chain.
const account = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 8 });
const pending = (error: unknown) => error instanceof AppError && error.status === 403 && error.code === 'WAITLIST_PENDING';

function harness(initial: WaitlistStatus | null = null) {
  const f = privyFixture();
  const memory = privyMemory();
  const states = new Map<string, WaitlistStatus>();
  if (initial !== null) states.set(f.userId, initial);
  let operators: readonly string[] = [];
  let lookups = 0;
  let now = f.now;
  const access = createWaitlistAccess({ operatorWallets: () => operators, lookup: async (userId) => {
    lookups++;
    return states.get(userId) === 'approved';
  } });
  const auth = new AuthStore({ sessions: memory.sessions, access, now: () => now,
    auth: { authDomain: 'localhost', authUri: 'http://localhost', chainId: 1337 } });
  const login = createPrivyLogin({ config: () => f.config, users: memory.users, access, now: () => now,
    issueSession: (owner, userId) => auth.issueSession(owner, userId) });
  const sign = async () => {
    const challenge = auth.issueNonce();
    const message = createSiweMessage({ ...challenge, address: account.address, issuedAt: new Date(challenge.issuedAt) });
    return { message, signature: await account.signMessage({ message }) };
  };
  return { f, memory, states, auth, login, sign, access,
    operators: (wallets: readonly string[]) => { operators = wallets; },
    clock: (value: number) => { now = value; }, lookups: () => lookups };
}

async function withServer(h: ReturnType<typeof harness>, run: (base: string) => Promise<void>, overrides: Partial<ServerDeps> = {}) {
  const server = createServer({ auth: { issueNonce: () => h.auth.issueNonce(),
    login: (m, s) => h.auth.login(m, s), authenticate: header => h.auth.authenticate(header), logout: header => h.auth.logout(header) },
  privyLogin: h.login, rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore()), ...overrides });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

async function expectError(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null && 'error' in body);
  assert.ok(typeof body.error === 'object' && body.error !== null && 'code' in body.error);
  assert.equal(body.error.code, code);
  return body;
}

test('#133 Privy denies unjoined/waiting/revoked; only approved Privy gets sessions and all ordinary SIWE is denied', async () => {
  const errors: unknown[] = [];
  for (const status of [null, 'waiting', 'revoked', 'approved'] as const) {
    const h = harness(status);
    h.memory.mappings.set(h.f.userId, account.address.toLowerCase());
    await withServer(h, async base => {
      for (const path of ['privy', 'login']) {
        const input = path === 'privy' ? { identityToken: await h.f.sign(),
          privyUserId: 'did:privy:forged-approved', xUserId: 'forged', status: 'approved', owner: h.f.other } : await h.sign();
        const response = await fetch(base + '/auth/' + path, { method: 'POST', body: JSON.stringify(input) });
        if (status !== 'approved' || path === 'login') errors.push(await expectError(response, 403, 'WAITLIST_PENDING'));
        else {
          assert.equal(response.status, 200);
          const session: unknown = await response.json();
          assert.ok(typeof session === 'object' && session !== null && 'token' in session && typeof session.token === 'string');
          assert.equal(await h.auth.authenticate('Bearer ' + session.token), account.address.toLowerCase());
        }
      }
      assert.equal(h.memory.rows.size, status === 'approved' ? 1 : 0);
    });
  }
  for (const error of errors) assert.deepEqual(error, errors[0], 'do not disclose missing/waiting/revoked status');
});

test('#133 first Privy registration checks the verified sub; approval enables retry without X claims', async () => {
  const h = harness('waiting');
  const identityToken = await h.f.sign();
  await assert.rejects(h.login({ identityToken, privyUserId: 'approved', status: 'approved' }), pending);
  assert.equal(h.memory.rows.size, 0);
  assert.equal(h.memory.mappings.size, 0);
  h.states.set(h.f.userId, 'approved');
  const session = await h.login({ identityToken });
  assert.equal(await h.auth.authenticate('Bearer ' + session.token), h.f.owner);
  const second = await h.login({ identityToken: await h.f.sign({ linked_accounts: '[]' }) });
  assert.equal(await h.auth.authenticate('Bearer ' + second.token), h.f.owner);
  await assert.rejects(h.login({ identityToken: await h.f.sign({ sub: 'did:privy:someone-else' }),
    privyUserId: h.f.userId }), pending);
});

test('#133 revoked approval rejects all old sessions on the next protected request, including a fresh store', async () => {
  const h = harness('approved');
  const sessions = [await h.login({ identityToken: await h.f.sign() }), await h.login({ identityToken: await h.f.sign() })];
  const [first] = sessions; assert.ok(first);
  const fresh = new AuthStore({ sessions: h.memory.sessions, access: h.access });
  assert.equal(await fresh.authenticate('Bearer ' + first.token), h.f.owner);
  h.states.set(h.f.userId, 'revoked');
  let domainCalls = 0;
  await withServer(h, async base => {
    for (const session of sessions) {
      await assert.rejects(fresh.authenticate('Bearer ' + session.token), pending);
      for (const [path, method] of [['/portfolios', 'GET'], ['/assets', 'GET'], ['/bundler', 'POST'],
        ['/paymaster/sponsor', 'POST'], ['/faucet/usdt', 'POST'], ['/operator/waitlist', 'GET']]) {
        await expectError(await fetch(base + path, { method, headers: { authorization: 'Bearer ' + session.token } }), 403, 'WAITLIST_PENDING');
      }
    }
    assert.equal(domainCalls, 0);
    // Logout remains available even after revocation.
    assert.equal((await fetch(base + '/auth/logout', { method: 'POST', headers: { authorization: 'Bearer ' + first.token } })).status, 204);
  }, { listPortfolios: async () => { domainCalls++; return []; }, listAssets: async () => { domainCalls++; return []; } });
});

test('#133 operator exception bypasses waitlist on both login paths and old sessions; removal is immediate', async () => {
  const h = harness('revoked');
  h.operators([account.address.toUpperCase(), h.f.owner.toUpperCase()]);
  const privy = await h.login({ identityToken: await h.f.sign() });
  const signed = await h.sign();
  const siwe = await h.auth.login(signed.message, signed.signature);
  assert.equal(await h.auth.authenticate('Bearer ' + privy.token), h.f.owner);
  assert.equal(await h.auth.authenticate('Bearer ' + siwe.token), account.address.toLowerCase());
  assert.equal(h.lookups(), 0, 'operator bypass does not depend on waitlist storage availability');
  await withServer(h, async base => {
    const response = await fetch(base + '/operator/waitlist', { headers: { authorization: 'Bearer ' + siwe.token } });
    assert.equal(response.status, 200);
  }, { operatorWallets: [account.address], waitlist: { ...createWaitlistService(), list: async () => ({ items: [], nextCursor: null }) } });
  h.operators([]);
  for (const token of [privy.token, siwe.token]) await assert.rejects(h.auth.authenticate('Bearer ' + token), pending);
});

test('#133 operator whitelist is read each time and invalid configuration never partially bypasses', async () => {
  const env: NodeJS.ProcessEnv = {};
  let lookups = 0;
  const access = createWaitlistAccess({ operatorWallets: () => resolveOperatorWallets(env), lookup: async () => { lookups++; return false; } });
  await assert.rejects(access(account.address), pending);
  env.OPERATOR_WALLETS = ' ' + account.address + ' ';
  await access(account.address);
  assert.equal(lookups, 0);
  env.OPERATOR_WALLETS += ',0x' + '0'.repeat(40);
  await assert.rejects(access(account.address), error => error instanceof AppError && error.code === 'INVALID_OPERATOR_WALLETS');
  assert.equal(lookups, 0);
});

test('#133 unknown/expired sessions do not query waitlist; exact expiry still returns 401', async () => {
  const h = harness('approved');
  const session = await h.login({ identityToken: await h.f.sign() });
  const before = h.lookups();
  for (const header of [undefined, 'Basic token', 'Bearer unknown']) {
    await assert.rejects(h.auth.authenticate(header), error => error instanceof AppError && error.status === 401);
  }
  assert.equal(h.lookups(), before);
  h.clock(h.f.now + SESSION_TTL_MS - 1);
  await h.auth.authenticate('Bearer ' + session.token);
  const last = h.lookups();
  h.clock(h.f.now + SESSION_TTL_MS);
  await assert.rejects(h.auth.authenticate('Bearer ' + session.token), error => error instanceof AppError && error.status === 401);
  assert.equal(h.lookups(), last);
});

test('#133 rejected/failed access consumes SIWE nonce; invalid signatures never reach the gate', async () => {
  const h = harness();
  const signed = await h.sign();
  await assert.rejects(h.auth.login(signed.message, '0xdeadbeef'), error => error instanceof AppError && error.code === 'INVALID_SIGNATURE');
  assert.equal(h.lookups(), 0);
  const next = await h.sign();
  await assert.rejects(h.auth.login(next.message, next.signature), pending);
  await assert.rejects(h.auth.login(next.message, next.signature), error => error instanceof AppError && error.code === 'INVALID_NONCE');
  assert.equal(h.memory.rows.size, 0);
});

test('#133 DB errors/timeouts/missing migration fail closed at issuance and authentication, sanitized through HTTP/logs', async () => {
  for (const code of ['ECONNREFUSED', '57014', 'ETIMEDOUT', '42P01']) {
    const h = harness();
    const access = createWaitlistAccess({ operatorWallets: () => [], lookup: async () => {
      throw Object.assign(new Error('secret-seed-token-connection'), { code });
    } });
    const auth = new AuthStore({ sessions: h.memory.sessions, access });
    const login = createPrivyLogin({ config: () => h.f.config, users: h.memory.users, access,
      issueSession: (owner, id) => auth.issueSession(owner, id) });
    const legacyToken = 'local-legacy-session';
    await h.memory.sessions.save(sha256Hex(legacyToken), h.f.owner, new Date(Date.now() + SESSION_TTL_MS), h.f.userId);
    const identityToken = await h.f.sign();
    const logs: string[] = [];
    const originalLog = console.log, originalError = console.error;
    console.log = console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    try {
      for (const call of [() => auth.issueSession(h.f.owner, h.f.userId), () => auth.authenticate('Bearer ' + legacyToken), () => login({ identityToken })]) {
        await assert.rejects(call(), error => {
          assert.ok(error instanceof AppError); assert.equal(error.status, 503); assert.equal(error.code, 'WAITLIST_UNAVAILABLE');
          assert.equal(error.cause, undefined); assert.doesNotMatch(error.message, /secret|seed|token|connection/); return true;
        });
      }
      await withServer(h, async base => {
        const response = await fetch(base + '/auth/privy', { method: 'POST', body: JSON.stringify({ identityToken }) });
        await expectError(response, 503, 'WAITLIST_UNAVAILABLE');
        await expectError(await fetch(base + '/assets', { headers: { authorization: 'Bearer ' + legacyToken } }), 503, 'WAITLIST_UNAVAILABLE');
      }, { privyLogin: login, auth: { issueNonce: () => auth.issueNonce(), login: (m, s) => auth.login(m, s),
        authenticate: header => auth.authenticate(header), logout: header => auth.logout(header) } });
      assert.equal(h.memory.rows.size, 1, 'only the preexisting session remains');
      assert.equal(h.memory.mappings.size, 0, 'lookup errors must precede owner registration');
      assert.doesNotMatch(logs.join('\n'), /secret|seed|token|connection/);
      assert.ok(!logs.join('\n').includes(identityToken));
    } finally { console.log = originalLog; console.error = originalError; }
  }
});

test('#133 public preview and waitlist join/me do not invoke the CRE8 session gate', async () => {
  const h = harness();
  const waitlist = createWaitlistService({ config: () => h.f.config, repository: {
    join: async () => { throw new AppError(503, 'WAITLIST_UNAVAILABLE', 'unavailable'); }, find: async () => null,
    list: async () => [], transition: async () => { throw new Error('unused'); },
  } });
  await withServer(h, async base => {
    assert.equal((await fetch(base + '/auth/nonce', { method: 'POST' })).status, 200);
    assert.equal((await fetch(base + '/waitlist/me', { headers: { authorization: 'Bearer ' + await h.f.sign() } })).status, 404);
    await expectError(await fetch(base + '/waitlist/join', { method: 'POST', body: JSON.stringify({ identityToken: await h.f.sign() }) }), 409, 'X_REQUIRED');
    assert.equal((await fetch(base + '/strategies/preview-contribution', { method: 'POST', body: '{}' })).status, 400);
    assert.equal(h.lookups(), 0);
  }, { waitlist });
});

test('#134 regression: approved wallet cannot lend its approval to a pure SIWE login', async () => {
  const h = harness('approved');
  h.memory.mappings.set(h.f.userId, account.address.toLowerCase());
  const signed = await h.sign();
  await assert.rejects(h.auth.login(signed.message, signed.signature), pending);
  assert.equal(h.memory.rows.size, 0);
});

test('#134 regression: unapproved Privy login never writes an owner mapping or blocks an approved identity', async () => {
  const h = harness('approved');
  const approved = await h.login({ identityToken: await h.f.sign() });
  for (const status of [null, 'waiting', 'revoked'] as const) {
    const otherId = 'did:privy:other-' + String(status);
    if (status !== null) h.states.set(otherId, status);
    await assert.rejects(h.login({ identityToken: await h.f.sign({ sub: otherId }) }), pending);
    assert.equal(h.memory.mappings.has(otherId), false);
    assert.equal(await h.auth.authenticate('Bearer ' + approved.token), h.f.owner);
    await h.login({ identityToken: await h.f.sign() });
  }
});

test('#134 regression: a fresh auth store checks only the persisted session Privy identity', async () => {
  const h = harness('approved');
  const otherId = 'did:privy:shared-wallet';
  h.states.set(otherId, 'approved');
  const first = await h.login({ identityToken: await h.f.sign() });
  const second = await h.login({ identityToken: await h.f.sign({ sub: otherId }) });
  h.states.set(otherId, 'revoked');
  const fresh = new AuthStore({ sessions: h.memory.sessions, access: h.access });
  assert.equal(await fresh.authenticate('Bearer ' + first.token), h.f.owner);
  await assert.rejects(fresh.authenticate('Bearer ' + second.token), pending);
});

test('#134 missing, empty, whitespace and oversized identities fail closed before lookup; valid DB bounds are accepted', async () => {
  const ids: string[] = [];
  const access = createWaitlistAccess({ operatorWallets: () => [], lookup: async id => { ids.push(id); return true; } });
  for (const id of [undefined, '', ' ', 'x'.repeat(257)]) await assert.rejects(access(account.address, id), pending);
  assert.equal(ids.length, 0);
  for (const id of ['x', 'x'.repeat(256)]) await access(account.address, id);
  assert.deepEqual(ids.map(id => id.length), [1, 256]);
});

test('#134 Privy subject limit rejects 257 characters before owner lookup and accepts the exact 256 boundary', async () => {
  const h = harness();
  const maxId = 'did:privy:' + 'x'.repeat(246);
  assert.equal(maxId.length, 256);
  h.states.set(maxId, 'approved');
  await h.login({ identityToken: await h.f.sign({ sub: maxId }) });
  await assert.rejects(h.login({ identityToken: await h.f.sign({ sub: maxId + 'x' }) }),
    error => error instanceof AppError && error.status === 401);
  assert.equal(h.memory.mappings.has(maxId + 'x'), false);
});

test('#134 revocation between registration check and minting denies the session', async () => {
  const h = harness('approved');
  const login = createPrivyLogin({ config: () => h.f.config, access: h.access, users: {
    find: h.memory.users.find, create: async (id, owner) => {
      const saved = await h.memory.users.create(id, owner);
      h.states.set(id, 'revoked');
      return saved;
    },
  }, issueSession: (owner, id) => h.auth.issueSession(owner, id) });
  await assert.rejects(login({ identityToken: await h.f.sign() }), pending);
  assert.equal(h.memory.rows.size, 0);
});

test('#134 unapproved social-only Privy login is denied before wallet registration validation', async () => {
  for (const status of [null, 'waiting', 'revoked'] as const) {
    const h = harness(status);
    await assert.rejects(h.login({ identityToken: await h.f.sign({ linked_accounts: '[]' }) }), pending);
    assert.equal(h.memory.mappings.size, 0);
    assert.equal(h.memory.rows.size, 0);
  }
});
