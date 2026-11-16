import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JWTPayload } from 'jose';
import { SignJWT } from 'jose';
import { mnemonicToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { AuthStore } from '../src/auth.js';
import { AppError, UnauthorizedError } from '../src/errors.js';
import { MAX_PRIVY_TOKEN_LENGTH } from '../src/privy.js';
import { createWaitlistService } from '../src/waitlist.js';
import type { WaitlistEntry, WaitlistRepository } from '../src/waitlist.js';
import { createServer } from '../src/server.js';
import type { ServerDeps } from '../src/server.js';
import { loadRateLimitConfig } from '../src/config.js';
import { MemoryRateLimitStore, RequestRateLimiter } from '../src/ratelimit.js';
import { privyFixture, privyMemory } from './fixtures/privy.js';

const operator = '0x1234567890abcdef1234567890abcdef12345678';
const twitter = { type: 'twitter_oauth', subject: '1234567890123456789', username: 'cre8_test' };
const entry: WaitlistEntry = { id: '1', privyUserId: 'did:privy:waitlist-test', xUserId: twitter.subject,
  xHandle: twitter.username, status: 'waiting', joinedAt: '2026-11-16T01:02:03.000001Z', approvedAt: null, approvedBy: null };
const isError = (status: number, code: string) => (error: unknown) => error instanceof AppError && error.status === status && error.code === code;
function harness(overrides: Partial<WaitlistRepository> = {}) {
  const fixture = privyFixture();
  const writes: unknown[] = [];
  const repository: WaitlistRepository = {
    join: async (identity) => { writes.push(identity); return { ...entry, ...identity }; },
    find: async () => entry,
    list: async () => [entry],
    transition: async (_id, status, approvedBy) => ({ ...entry, status, approvedBy }),
    ...overrides,
  };
  const service = createWaitlistService({ repository, config: () => fixture.config, now: () => fixture.now });
  const sign = (overrides: JWTPayload = {}) => fixture.sign({ linked_accounts: JSON.stringify([twitter]), ...overrides });
  return { fixture, repository, service, sign, writes };
}
async function withServer(deps: Partial<ServerDeps>, fn: (base: string) => Promise<void>) {
  const server = createServer({ rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore()), ...deps });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try { await fn(`http://127.0.0.1:${address.port}`); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
async function responseErrorCode(response: Response): Promise<string> {
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null && 'error' in body);
  const error = body.error;
  assert.ok(typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string');
  return error.code;
}

test('#127 join trusts only signed twitter_oauth subject/username; social-only users need no wallet or CRE8 session', async () => {
  const h = harness();
  const result = await h.service.join({ identityToken: await h.sign(), xUserId: 'forged', xHandle: 'forged', privyUserId: 'forged' });
  assert.deepEqual(h.writes, [{ privyUserId: h.fixture.userId, xUserId: twitter.subject, xHandle: twitter.username }]);
  assert.deepEqual(result, { status: 'waiting', xHandle: twitter.username, joinedAt: entry.joinedAt });
  for (const status of ['waiting', 'approved', 'revoked'] as const) {
    const s = harness({ find: async () => ({ ...entry, status }) });
    assert.deepEqual(await s.service.me('Bearer ' + await s.sign()), { ...result, status: status === 'approved' ? 'approved' : 'waiting' });
  }
});

test('#127 Privy verification rejects bad signatures, algorithms and all invalid required claims before storage', async () => {
  const h = harness(); const f = h.fixture; const seconds = Math.floor(f.now / 1000);
  const claims: Record<string, unknown>[] = [
    { exp: seconds }, { exp: seconds - 1 }, { exp: 0 }, { exp: undefined }, { exp: 'never' }, { exp: seconds + 0.5 },
    { aud: 'wrong' }, { aud: undefined }, { aud: [f.config.appId] }, { iss: 'https://privy.io' }, { iss: undefined },
    { sub: '' }, { sub: undefined }, { sub: 'did:privy: ' }, { iat: seconds + 1 }, { iat: -1 },
    { iat: undefined }, { iat: seconds + 0.5 }, { exp: seconds + 1, iat: seconds + 1 }, { nbf: seconds + 1 },
    { linked_accounts: undefined }, { linked_accounts: [] }, { linked_accounts: '{' }, { linked_accounts: '{}' },
    { linked_accounts: '[null]' }, { linked_accounts: '[1]' },
  ];
  const valid = await h.sign();
  const tokens = await Promise.all(claims.map(c => f.signRaw(c)));
  tokens.push(await privyFixture().sign(), 'broken', valid.slice(0, -16) + 'AAAAAAAAAAAAAAAA',
    Buffer.from('{"alg":"none"}').toString('base64url') + '.' + valid.split('.')[1] + '.',
    await new SignJWT({ sub: f.userId }).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(f.config.verificationKey)));
  for (const identityToken of tokens) {
    await assert.rejects(h.service.join({ identityToken }), isError(401, 'UNAUTHORIZED'));
    await assert.rejects(h.service.me('Bearer ' + identityToken), isError(401, 'UNAUTHORIZED'));
  }
  assert.equal(h.writes.length, 0);
});

test('#127 identity expiry/nbf accept the last millisecond and reject exactly at exp', async () => {
  const h = harness(); const seconds = Math.floor(h.fixture.now / 1000);
  const token = await h.sign({ iat: seconds, exp: seconds + 1, nbf: seconds });
  const service = (now: number) => createWaitlistService({ repository: h.repository, config: () => h.fixture.config, now: () => now });
  await service(seconds * 1000 + 999).join({ identityToken: token });
  await assert.rejects(service((seconds + 1) * 1000).join({ identityToken: token }), isError(401, 'UNAUTHORIZED'));
});

test('#127 malformed join bodies, exact token cap, missing bearer and unavailable Privy config fail closed', async () => {
  const h = harness();
  for (const body of [null, [], 'token', {}, { identityToken: 0 }, { identityToken: '' }, { identityToken: ' ' },
    { identityToken: 'x'.repeat(MAX_PRIVY_TOKEN_LENGTH + 1) }]) await assert.rejects(h.service.join(body), isError(400, 'INVALID_AUTH'));
  await assert.rejects(h.service.join({ identityToken: 'x'.repeat(MAX_PRIVY_TOKEN_LENGTH) }), isError(401, 'UNAUTHORIZED'));
  for (const header of [undefined, '', 'Bearer', 'Basic token', 'Bearer token extra']) await assert.rejects(h.service.me(header), isError(401, 'UNAUTHORIZED'));
  for (const config of [null, { ...h.fixture.config, verificationKey: 'bad-secret-key' }]) {
    const s = createWaitlistService({ config: () => config, repository: h.repository });
    await assert.rejects(s.join({ identityToken: await h.sign() }), isError(503, 'PRIVY_UNAVAILABLE'));
  }
  assert.equal(h.writes.length, 0);
});

test('#127 missing, ambiguous or malformed X claims are 409; X id/handle length boundaries are checked', async () => {
  const h = harness();
  for (const accounts of [[], [h.fixture.wallet], [{ ...twitter, type: 'twitter' }], [twitter, twitter],
    ...[undefined, '', '0', '01', 123, '1'.repeat(21), 'abc'].map(subject => [{ ...twitter, subject }]),
    ...[undefined, '', 123, 'a'.repeat(16), '@handle', 'a-b', ' '].map(username => [{ ...twitter, username }])]) {
    await assert.rejects(h.service.join({ identityToken: await h.sign({ linked_accounts: JSON.stringify(accounts) }) }), isError(409, 'X_REQUIRED'));
  }
  assert.equal(h.writes.length, 0);
  await h.service.join({ identityToken: await h.sign({ sub: 'did:privy:' + 'a'.repeat(246) }) });
  await assert.rejects(h.service.join({ identityToken: await h.sign({ sub: 'did:privy:' + 'a'.repeat(247) }) }), isError(401, 'UNAUTHORIZED'));
  for (const subject of ['1', '1'.repeat(20)]) for (const username of ['a', 'a'.repeat(15)]) {
    await h.service.join({ identityToken: await h.sign({ linked_accounts: JSON.stringify([{ ...twitter, subject, username }]) }) });
  }
});

test('#127 storage failures/timeouts on every operation are sanitized; NOT_JOINED and conflicts retain their codes', async () => {
  for (const code of ['ECONNREFUSED', '57014', 'ETIMEDOUT']) {
    const fail = async (): Promise<never> => { throw Object.assign(new Error('secret-token-seed-database-url'), { code }); };
    const h = harness({ join: fail, find: fail, list: fail, transition: fail });
    const token = await h.sign();
    for (const call of [() => h.service.join({ identityToken: token }), () => h.service.me('Bearer ' + token),
      () => h.service.list(new URLSearchParams()), () => h.service.transition('1', 'approved', operator)]) {
      await assert.rejects(call(), error => {
        assert.ok(error instanceof AppError); assert.equal(error.status, 503); assert.equal(error.code, 'WAITLIST_UNAVAILABLE');
        assert.equal(error.cause, undefined); assert.doesNotMatch(error.message, /secret|token|seed|database/); return true;
      });
    }
  }
  const h = harness({ find: async () => null });
  await assert.rejects(h.service.me('Bearer ' + await h.sign()), isError(404, 'NOT_JOINED'));
  const c = harness({ join: async () => { throw new AppError(409, 'X_ALREADY_JOINED', 'X already joined'); } });
  await assert.rejects(c.service.join({ identityToken: await c.sign() }), isError(409, 'X_ALREADY_JOINED'));
});

test('#127 operator query/id bounds reject zero, over-limit, malformed and mismatched cursors before storage', async () => {
  const h = harness();
  for (const query of ['limit=0', 'limit=101', 'limit=-1', 'limit=1.5', 'limit=', 'limit=01', 'status=bad', 'cursor=', 'cursor=!!!',
    'cursor=' + 'x'.repeat(513), 'cursor=' + Buffer.from('{}').toString('base64url')]) {
    await assert.rejects(h.service.list(new URLSearchParams(query)), isError(400, 'INVALID_QUERY'));
  }
  for (const id of ['0', '-1', '1.1', '01', '', '9223372036854775808', '1'.repeat(100)]) {
    await assert.rejects(h.service.transition(id, 'approved', operator), isError(400, 'INVALID_ID'));
  }
  for (const limit of [1, 100]) await h.service.list(new URLSearchParams({ limit: String(limit) }));
  await h.service.transition('9223372036854775807', 'approved', operator);
  for (const joinedAt of ['2026-02-30T01:02:03.000001Z', 'not-date']) {
    await assert.rejects(h.service.list(new URLSearchParams({ cursor: Buffer.from(JSON.stringify({ id: '1', status: null, joinedAt })).toString('base64url') })), isError(400, 'INVALID_QUERY'));
  }
});

test('#127 empty/exact/full pages expose only bounded items and a filter-bound next cursor', async () => {
  for (const count of [0, 1, 2]) {
    const h = harness({ list: async input => {
      assert.equal(input.status, 'waiting'); assert.equal(input.limit, 1);
      return Array.from({ length: count }, (_, index) => ({ ...entry, id: String(index + 1) }));
    } });
    const page = await h.service.list(new URLSearchParams({ limit: '1', status: 'waiting' }));
    assert.equal(page.items.length, Math.min(count, 1));
    if (count < 2) assert.equal(page.nextCursor, null);
    else {
      assert.ok(page.nextCursor);
      const decoded: unknown = JSON.parse(Buffer.from(page.nextCursor, 'base64url').toString('utf8'));
      assert.deepEqual(decoded, { joinedAt: entry.joinedAt, id: '1', status: 'waiting' });
    }
  }
});

test('#127 HTTP methods/JSON/header handling and shared auth IP budget enforce 429 at the exact allowance', async () => {
  const h = harness();
  const rateLimiter = new RequestRateLimiter({ ...loadRateLimitConfig({}), authPerMinute: 4 }, new MemoryRateLimitStore(), () => 1000);
  await withServer({ waitlist: h.service, rateLimiter }, async base => {
    const wrong = await fetch(base + '/waitlist/join'); assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get('allow'), 'POST');
    assert.equal((await fetch(base + '/waitlist/join', { method: 'POST', body: '{' })).status, 400);
    assert.equal((await fetch(base + '/waitlist/me?identityToken=not-a-header-token')).status, 401);
    assert.equal((await fetch(base + '/auth/nonce', { method: 'POST' })).status, 200);
    const limited = await fetch(base + '/waitlist/me', { headers: { authorization: 'Bearer ' + await h.sign() } });
    assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '59');
  });
  await withServer({ waitlist: h.service }, async base => {
    const joined = await fetch(base + '/waitlist/join', { method: 'POST', body: JSON.stringify({ identityToken: await h.sign() }) });
    assert.equal(joined.status, 200); assert.equal(joined.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await joined.json(), { status: 'waiting', xHandle: twitter.username, joinedAt: entry.joinedAt });
    assert.equal((await fetch(base + '/waitlist/me', { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/waitlist/me', { headers: { authorization: 'Bearer ' + await h.sign() } })).status, 200);
  });
});

test('#127 waitlist uses the shared 401/403 whitelist guard independently of the rebalance switch; approval records the authenticated wallet', async () => {
  const paths = ['/operator/waitlist', '/operator/waitlist/1/approve', '/operator/waitlist/1/revoke'];
  let calls = 0; const h = harness({ list: async () => { calls++; return [entry]; },
    transition: async (_id, status, approvedBy) => { calls++; return { ...entry, status, approvedBy }; } });
  for (const enabled of [false, true]) for (const authState of ['missing', 'outsider', 'empty', 'allowed'] as const) {
    await withServer({ waitlist: h.service, operatorWallets: authState === 'empty' ? [] : [operator], operatorRebalanceEnabled: () => enabled,
      auth: { authenticate: async () => { if (authState === 'missing') throw new UnauthorizedError(); return authState === 'outsider' ? '0x' + '2'.repeat(40) : operator.toUpperCase(); },
        issueNonce: () => { throw new Error(); }, login: async () => { throw new Error(); }, logout: async () => {} } }, async base => {
      for (const path of paths) {
        const before = calls;
        const response = await fetch(base + path, { method: path.endsWith('waitlist') ? 'GET' : 'POST' });
        const expected = authState === 'missing' ? 401 : authState === 'allowed' ? 200 : 403;
        assert.equal(response.status, expected, `${path}: ${authState}, rebalance enabled=${enabled}`);
        assert.equal(calls - before, expected === 200 ? 1 : 0, 'denied requests must not reach storage');
        if (expected !== 200) assert.equal(await responseErrorCode(response), expected === 401 ? 'UNAUTHORIZED' : 'OPERATOR_FORBIDDEN');
        if (expected === 200 && !path.endsWith('waitlist')) {
          const body: unknown = await response.json();
          assert.ok(typeof body === 'object' && body !== null && 'approvedBy' in body);
          assert.equal(body.approvedBy, operator);
        }
      }
    });
  }
  assert.equal(calls, 6, 'only whitelisted calls reach storage, with either switch value');
});

test('#127 a signed-in non-whitelisted SIWE wallet gets 403 for waitlist list/approve/revoke with either rebalance switch value', async () => {
  // Public anvil account only; signing is local and sends no chain transaction.
  const outsider = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 7 });
  const store = new AuthStore({ sessions: privyMemory().sessions,
    auth: { authDomain: 'localhost', authUri: 'http://localhost', chainId: 1337 } });
  const challenge = store.issueNonce();
  const message = createSiweMessage({ ...challenge, address: outsider.address, issuedAt: new Date(challenge.issuedAt) });
  const { token } = await store.login(message, await outsider.signMessage({ message }));
  assert.equal(await store.authenticate('Bearer ' + token), outsider.address.toLowerCase());
  const fail = async (): Promise<never> => { assert.fail('non-whitelisted wallet reached waitlist storage'); };
  const h = harness({ list: fail, transition: fail });
  for (const enabled of [false, true]) {
    await withServer({ waitlist: h.service, operatorWallets: [operator], operatorRebalanceEnabled: () => enabled,
      auth: { authenticate: header => store.authenticate(header), issueNonce: () => store.issueNonce(),
        login: (message, signature) => store.login(message, signature), logout: header => store.logout(header) } }, async base => {
      for (const action of ['', '/1/approve', '/1/revoke']) {
        const response = await fetch(base + '/operator/waitlist' + action, {
          method: action === '' ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + token },
        });
        assert.equal(response.status, 403);
        assert.equal(await responseErrorCode(response), 'OPERATOR_FORBIDDEN');
      }
    });
  }
});

test('#127 disabled rebalance allows waitlist approve/revoke but blocks portfolio close/rebalance before transaction dependencies', async () => {
  const h = harness(); const called: string[] = [];
  await withServer({ waitlist: h.service, operatorWallets: [operator], operatorRebalanceEnabled: () => false,
    auth: { authenticate: async () => operator, issueNonce: () => { throw new Error(); },
      login: async () => { throw new Error(); }, logout: async () => {} },
    operatorForceClose: async () => { called.push('close'); throw new Error('must not submit a transaction'); },
    operatorForceRebalance: async () => { called.push('rebalance'); throw new Error('must not submit a transaction'); } }, async base => {
    for (const action of ['approve', 'revoke']) {
      const response = await fetch(base + '/operator/waitlist/1/' + action, { method: 'POST' });
      assert.equal(response.status, 200);
      const body: unknown = await response.json();
      assert.ok(typeof body === 'object' && body !== null && 'status' in body);
      assert.equal(body.status, action === 'approve' ? 'approved' : 'revoked');
    }
    for (const id of ['0', '1']) for (const action of ['close', 'rebalance']) {
      const response = await fetch(base + `/operator/portfolios/${id}/${action}`, { method: 'POST' });
      assert.equal(response.status, 403);
      assert.equal(await responseErrorCode(response), 'OPERATOR_REBALANCE_DISABLED');
    }
  });
  assert.deepEqual(called, []);
});

test('#127 HTTP/log errors never contain identity tokens or dependency credentials', async () => {
  const fail = async (): Promise<never> => { throw new Error('secret-seed-database-url'); };
  const h = harness({ join: fail }); const token = await h.sign(); const logs: string[] = [];
  const originalLog = console.log; const originalError = console.error;
  console.log = console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  try {
    await withServer({ waitlist: h.service }, async base => {
      const result = await fetch(base + '/waitlist/join', { method: 'POST', body: JSON.stringify({ identityToken: token }) });
      assert.equal(result.status, 503);
      assert.doesNotMatch(await result.text(), /secret|seed|database-url/);
    });
    assert.ok(logs.length > 0); assert.ok(!logs.join('\n').includes(token));
    assert.doesNotMatch(logs.join('\n'), /secret|seed|database-url/);
  } finally { console.log = originalLog; console.error = originalError; }
});
