import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWaitlistInviteService, hashInviteCode } from '../src/waitlist-invites.js';
import type { InviteRepository } from '../src/waitlist-invites.js';
import { AppError } from '../src/errors.js';
import { UnauthorizedError } from '../src/errors.js';
import { MAX_PRIVY_TOKEN_LENGTH } from '../src/privy.js';
import { createServer } from '../src/server.js';
import type { ServerDeps } from '../src/server.js';
import { loadRateLimitConfig } from '../src/config.js';
import { MemoryRateLimitStore, RateLimitError, RequestRateLimiter } from '../src/ratelimit.js';
import type { InviteEntry } from '../src/waitlist-invites.js';
import { SignJWT } from 'jose';
import { privyFixture } from './fixtures/privy.js';

const twitter = { type: 'twitter_oauth', subject: '12345', username: 'cre8_test' };
const operator = '0x1234567890abcdef1234567890abcdef12345678';
const isError = (status: number, code: string) => (error: unknown) => error instanceof AppError && error.status === status && error.code === code;
function harness(overrides: Partial<InviteRepository> = {}) {
  const fixture = privyFixture();
  const writes: unknown[] = [];
  const repository: InviteRepository = {
    issue: async input => { writes.push(input); return input.codes.map((code, i) => ({ id: String(i + 1), codeHash: code.codeHash })); },
    redeem: async (identity, codeHash) => { writes.push({ identity, codeHash }); return { status: 'approved', xHandle: identity.xHandle, joinedAt: '2026-11-16T00:00:00.000001Z' }; },
    list: async () => [], summary: async () => [], revoke: async () => { writes.push('revoke'); },
    ...overrides,
  };
  let now = fixture.now;
  const service = createWaitlistInviteService({ repository, config: () => fixture.config, now: () => now });
  const sign = () => fixture.sign({ linked_accounts: JSON.stringify([twitter]) });
  return { fixture, service, repository, writes, sign, setNow: (value: number) => { now = value; } };
}

test('#131 redeem trusts signed X identity and passes only normalized code hash to storage', async () => {
  const h = harness();
  const result = await h.service.redeem({ identityToken: await h.sign(), code: ' abcdefgh23 ', xHandle: 'forged', privyUserId: 'forged' });
  assert.deepEqual(result, { status: 'approved', xHandle: twitter.username, joinedAt: '2026-11-16T00:00:00.000001Z' });
  assert.deepEqual(h.writes, [{ identity: { privyUserId: h.fixture.userId, xUserId: twitter.subject, xHandle: twitter.username }, codeHash: hashInviteCode('ABCDEFGH23') }]);
});

test('#131 issuance bounds, secure unique codes and one-time plaintext projection', async () => {
  for (const count of [1, 500]) {
    const h = harness();
    const result = await h.service.issue({ count, issuedTo: 'alice', batchNote: 'launch' }, operator.toUpperCase());
    assert.equal(result.items.length, count);
    assert.equal(new Set(result.items.map(r => r.code)).size, count);
    assert.ok(result.items.every(r => /^[A-HJ-KM-NP-Z2-9]{10}$/.test(r.code)));
    assert.ok(!JSON.stringify(h.writes).includes(result.items[0]?.code ?? 'missing'));
    assert.equal((await h.service.list(new URLSearchParams())).items.length, 0);
  }
  const h = harness();
  for (const count of [0, -1, 501, 1.5, '1', null, undefined]) {
    await assert.rejects(h.service.issue({ count }, operator), isError(400, 'INVALID_INVITE_INPUT'));
  }
  for (const expiresAt of ['', 'bad', '2026-02-30T00:00:00.000Z', new Date(h.fixture.now).toISOString(), new Date(h.fixture.now - 1).toISOString()]) {
    await assert.rejects(h.service.issue({ count: 1, expiresAt }, operator), isError(400, 'INVALID_INVITE_INPUT'));
  }
  await h.service.issue({ count: 1, expiresAt: new Date(h.fixture.now + 1).toISOString() }, operator);
});

test('#131 IP and verified user budgets reject exactly after the allowance and reset at the window', async () => {
  const h = harness(); h.setNow(1000);
  for (let i = 0; i < 10; i++) await h.service.checkIp('127.0.0.1');
  await assert.rejects(h.service.checkIp('127.0.0.1'), error => error instanceof RateLimitError && error.retryAfterSeconds === 59);
  await h.service.checkIp('127.0.0.2');
  h.setNow(h.fixture.now);
  const token = await h.sign();
  for (let i = 0; i < 5; i++) await h.service.redeem({ identityToken: token, code: 'ABCDEFGH23' });
  await assert.rejects(h.service.redeem({ identityToken: token, code: 'ABCDEFGH23' }), isError(429, 'RATE_LIMITED'));
  h.setNow((Math.floor(h.fixture.now / 60000) + 1) * 60000);
  await h.service.redeem({ identityToken: token, code: 'ABCDEFGH23' });
});

test('#131 redeem rejects invalid signatures/algorithms and every required identity claim before storage', async () => {
  const h = harness(); const f = h.fixture; const seconds = Math.floor(f.now / 1000);
  const claims: Record<string, unknown>[] = [
    { exp: seconds }, { exp: seconds - 1 }, { exp: 0 }, { exp: undefined }, { exp: 'never' }, { exp: seconds + 0.5 },
    { aud: 'wrong' }, { aud: undefined }, { aud: [f.config.appId] }, { iss: 'https://privy.io' }, { iss: undefined },
    { sub: '' }, { sub: undefined }, { sub: 'did:privy: ' }, { sub: 'did:privy:' + 'a'.repeat(247) },
    { iat: seconds + 1 }, { iat: -1 }, { iat: undefined }, { iat: seconds + 0.5 }, { exp: seconds + 1, iat: seconds + 1 }, { nbf: seconds + 1 },
    { linked_accounts: undefined }, { linked_accounts: [] }, { linked_accounts: '{' }, { linked_accounts: '{}' },
    { linked_accounts: '[null]' }, { linked_accounts: '[1]' },
  ];
  const valid = await h.sign();
  const tokens = await Promise.all(claims.map(c => f.signRaw(c)));
  tokens.push(await privyFixture().sign(), 'broken', valid.slice(0, -16) + 'AAAAAAAAAAAAAAAA',
    Buffer.from('{"alg":"none"}').toString('base64url') + '.' + valid.split('.')[1] + '.',
    await new SignJWT({ sub: f.userId }).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(f.config.verificationKey)));
  for (const identityToken of tokens) await assert.rejects(h.service.redeem({ identityToken, code: 'ABCDEFGH23' }), isError(401, 'UNAUTHORIZED'));
  assert.equal(h.writes.length, 0);
});

test('#131 identity token and X account boundaries match join; no wallet or CRE8 session is required', async () => {
  const h = harness();
  for (const body of [null, [], 'token', {}, { identityToken: 0 }, { identityToken: '' }, { identityToken: ' ' },
    { identityToken: 'x'.repeat(MAX_PRIVY_TOKEN_LENGTH + 1) }]) await assert.rejects(h.service.redeem(body), isError(400, 'INVALID_AUTH'));
  await assert.rejects(h.service.redeem({ identityToken: 'x'.repeat(MAX_PRIVY_TOKEN_LENGTH) }), isError(401, 'UNAUTHORIZED'));
  for (const config of [null, { ...h.fixture.config, verificationKey: 'invalid-key' }]) {
    const service = createWaitlistInviteService({ config: () => config, repository: h.repository });
    await assert.rejects(service.redeem({ identityToken: await h.sign(), code: 'ABCDEFGH23' }), isError(503, 'PRIVY_UNAVAILABLE'));
  }
  const seconds = Math.floor(h.fixture.now / 1000);
  const token = await h.fixture.sign({ linked_accounts: JSON.stringify([twitter]), iat: seconds, exp: seconds + 1, nbf: seconds });
  h.setNow(seconds * 1000 + 999);
  await h.service.redeem({ identityToken: token, code: 'ABCDEFGH23' });
  h.setNow((seconds + 1) * 1000);
  await assert.rejects(h.service.redeem({ identityToken: token, code: 'ABCDEFGH23' }), isError(401, 'UNAUTHORIZED'));
  for (const accounts of [[], [h.fixture.wallet], [{ ...twitter, type: 'twitter' }], [twitter, twitter],
    ...[undefined, '', '0', '01', 123, '1'.repeat(21), 'abc'].map(subject => [{ ...twitter, subject }]),
    ...[undefined, '', 123, 'a'.repeat(16), '@handle', 'a-b', ' '].map(username => [{ ...twitter, username }])]) {
    const service = createWaitlistInviteService({ repository: h.repository, config: () => h.fixture.config, now: () => h.fixture.now });
    await assert.rejects(service.redeem({ identityToken: await h.fixture.sign({ linked_accounts: JSON.stringify(accounts) }), code: 'ABCDEFGH23' }), isError(409, 'X_REQUIRED'));
  }
  for (const subject of ['1', '1'.repeat(20)]) for (const username of ['a', 'a'.repeat(15)]) {
    const sub = 'did:privy:' + 'a'.repeat(246);
    await createWaitlistInviteService({ repository: h.repository, config: () => h.fixture.config, now: () => h.fixture.now })
      .redeem({ identityToken: await h.fixture.sign({ sub, linked_accounts: JSON.stringify([{ ...twitter, subject, username }]) }), code: 'ABCDEFGH23' });
  }
});

test('#131 malformed guesses consume the verified-user budget, with 8/10 accepted and 7/11 rejected', async () => {
  for (const code of [undefined, null, 123, '', 'A'.repeat(7), 'A'.repeat(11), 'O'.repeat(10), '1'.repeat(10), 'I'.repeat(10), 'L'.repeat(10), 'Ａ'.repeat(10), 'A'.repeat(65)]) {
    const h = harness(); const token = await h.sign();
    for (let i = 0; i < 5; i++) await assert.rejects(h.service.redeem({ identityToken: token, code }), isError(404, 'INVITE_INVALID'));
    await assert.rejects(h.service.redeem({ identityToken: token, code: 'ABCDEFGH23' }), isError(429, 'RATE_LIMITED'));
    assert.equal(h.writes.length, 0);
  }
  const h = harness();
  for (const code of ['ABCDEFGH', 'ABCDEFGH2', 'ABCDEFGH23']) await h.service.redeem({ identityToken: await h.sign(), code });
  assert.equal(h.writes.length, 3);
});

test('#131 all DB/timeout errors and rate store failure fail closed without sensitive details', async () => {
  for (const code of ['ECONNREFUSED', '57014', 'ETIMEDOUT', '42P01']) {
    const fail = async (): Promise<never> => { throw Object.assign(new Error('sensitive-dependency-value'), { code }); };
    const h = harness({ issue: fail, redeem: fail, list: fail, summary: fail, revoke: fail });
    const token = await h.sign();
    for (const call of [() => h.service.redeem({ identityToken: token, code: 'ABCDEFGH23' }), () => h.service.issue({ count: 1 }, operator),
      () => h.service.list(new URLSearchParams()), () => h.service.summary(new URLSearchParams()), () => h.service.revoke('1', operator)]) {
      await assert.rejects(call(), error => {
        assert.ok(isError(503, 'INVITES_UNAVAILABLE')(error)); assert.ok(error instanceof AppError);
        assert.equal(error.cause, undefined); assert.doesNotMatch(error.message, /sensitive/); return true;
      });
    }
    const service = createWaitlistInviteService({ repository: h.repository, config: () => h.fixture.config, now: () => h.fixture.now, rateStore: { consume: fail } });
    await assert.rejects(service.checkIp('127.0.0.1'), isError(503, 'RATE_LIMIT_UNAVAILABLE'));
    await assert.rejects(service.redeem({ identityToken: token, code: 'ABCDEFGH23' }), isError(503, 'RATE_LIMIT_UNAVAILABLE'));
    assert.equal(h.writes.length, 0);
  }
  for (const [status, code] of [[404, 'INVITE_INVALID'], [409, 'INVITE_USED'], [410, 'INVITE_EXPIRED'], [409, 'ALREADY_APPROVED'],
    [409, 'X_ALREADY_JOINED'], [409, 'INVALID_WAITLIST_TRANSITION']] as const) {
    const h = harness({ redeem: async () => { throw new AppError(status, code, 'safe domain error'); } });
    await assert.rejects(h.service.redeem({ identityToken: await h.sign(), code: 'ABCDEFGH23' }), isError(status, code));
  }
});

const invite: InviteEntry = { id: '1', batchId: '12345678-1234-1234-1234-123456789abc', batchNote: 'launch', issuedTo: 'alice',
  status: 'unused', createdBy: operator, createdAt: '2026-11-16T00:00:00.000001Z', expiresAt: null,
  usedByWaitlistId: null, xHandle: null, usedAt: null, revokedAt: null, revokedBy: null };

test('#131 operator validation rejects invalid notes, filters, cursors and bigint IDs before storage', async () => {
  const h = harness();
  for (const body of [null, [], {}, { count: 1, issuedTo: 1 }, { count: 1, batchNote: false }, { count: 1, issuedTo: 'x'.repeat(257) },
    { count: 1, batchNote: 'x'.repeat(257) }, { count: 1, batchNote: '\0' }]) await assert.rejects(h.service.issue(body, operator), isError(400, 'INVALID_INVITE_INPUT'));
  for (const id of ['0', '-1', '1.1', '01', '', '9223372036854775808', '1'.repeat(100)]) {
    await assert.rejects(h.service.revoke(id, operator), isError(400, 'INVALID_ID'));
  }
  for (const query of ['limit=0', 'limit=101', 'limit=-1', 'limit=1.5', 'limit=', 'limit=01', 'status=bad', 'batch=', 'batch=bad',
    'cursor=', 'cursor=!!!', 'cursor=' + 'x'.repeat(513), 'cursor=' + Buffer.from('{}').toString('base64url')]) {
    await assert.rejects(h.service.list(new URLSearchParams(query)), isError(400, 'INVALID_QUERY'));
  }
  await assert.rejects(h.service.summary(new URLSearchParams('batch=bad')), isError(400, 'INVALID_QUERY'));
  assert.equal(h.writes.length, 0);
  for (const limit of [1, 100]) await h.service.list(new URLSearchParams({ limit: String(limit) }));
  await h.service.revoke('9223372036854775807', operator);
  await h.service.issue({ count: 1, issuedTo: 'x'.repeat(256), batchNote: 'x'.repeat(256) }, operator);
  await h.service.issue({ count: 1, issuedTo: ' ', batchNote: null }, operator);
});

test('#131 list explicitly masks every code/hash, preserves microseconds and binds cursors to both filters', async () => {
  for (const count of [0, 1, 2]) {
    const h = harness({ list: async input => {
      assert.equal(input.limit, 1); assert.equal(input.status, 'unused'); assert.equal(input.batch, invite.batchId);
      return Array.from({ length: count }, (_, i) => ({ ...invite, id: String(i + 1), code: 'sensitive-bearer', codeHash: 'sensitive-hash' }));
    } });
    const params = new URLSearchParams({ limit: '1', status: 'unused', batch: invite.batchId });
    const page = await h.service.list(params);
    assert.equal(page.items.length, Math.min(count, 1)); assert.doesNotMatch(JSON.stringify(page), /sensitive/);
    if (count < 2) assert.equal(page.nextCursor, null);
    else {
      assert.ok(page.nextCursor); assert.equal(page.items[0]?.codeMasked, '**********');
      const decoded: unknown = JSON.parse(Buffer.from(page.nextCursor, 'base64url').toString('utf8'));
      assert.deepEqual(decoded, { id: '1', createdAt: invite.createdAt, status: 'unused', batch: invite.batchId });
      for (const changes of [{ status: 'used' }, { batch: '87654321-1234-1234-1234-123456789abc' }]) {
        const changed = new URLSearchParams(params); changed.set('cursor', page.nextCursor);
        for (const [key, value] of Object.entries(changes)) changed.set(key, value);
        await assert.rejects(h.service.list(changed), isError(400, 'INVALID_QUERY'));
      }
      await h.service.list(new URLSearchParams({ ...Object.fromEntries(params), cursor: page.nextCursor }));
    }
  }
  const h = harness();
  for (const createdAt of ['2026-02-30T00:00:00.000001Z', 'bad']) {
    const cursor = Buffer.from(JSON.stringify({ id: '1', createdAt, status: null, batch: null })).toString('base64url');
    await assert.rejects(h.service.list(new URLSearchParams({ cursor })), isError(400, 'INVALID_QUERY'));
  }
  for (const rows of [[], [{ id: '1', codeHash: 'wrong-hash' }]]) {
    const broken = harness({ issue: async () => rows });
    await assert.rejects(broken.service.issue({ count: 1 }, operator), isError(503, 'INVITES_UNAVAILABLE'));
  }
  const summary = harness({ summary: async () => [{ issuedTo: null, issued: '9007199254740993', used: '1', code: 'sensitive-bearer' }] });
  assert.deepEqual(await summary.service.summary(new URLSearchParams()), { items: [{ issuedTo: null, issued: '9007199254740993', used: '1' }] });
});

async function withServer(deps: Partial<ServerDeps>, fn: (base: string) => Promise<void>) {
  const server = createServer({ rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore()), ...deps });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try { await fn(`http://127.0.0.1:${address.port}`); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('#131 HTTP operator authorization, method routing and one-time cleartext obey the shared guard', async () => {
  for (const state of ['missing', 'outsider', 'empty', 'allowed'] as const) for (const enabled of [false, true]) {
    const h = harness({ list: async () => [invite], summary: async () => [{ issuedTo: 'alice', issued: '1', used: '0' }] });
    await withServer({ waitlistInvites: h.service, operatorWallets: state === 'empty' ? [] : [operator], operatorRebalanceEnabled: () => enabled,
      auth: { authenticate: async () => { if (state === 'missing') throw new UnauthorizedError(); return state === 'outsider' ? '0x' + '2'.repeat(40) : operator.toUpperCase(); },
        issueNonce: () => { throw new Error(); }, login: async () => { throw new Error(); }, logout: async () => {} } }, async base => {
      let cleartext = '';
      for (const [path, method] of [['/operator/waitlist/invites', 'POST'], ['/operator/waitlist/invites', 'GET'],
        ['/operator/waitlist/invites/summary', 'GET'], ['/operator/waitlist/invites/1/revoke', 'POST']] as const) {
        const before = h.writes.length;
        const response = await fetch(base + path, { method, ...(method === 'POST' && path.endsWith('invites') ? { body: JSON.stringify({ count: 1 }) } : {}) });
        assert.equal(response.status, state === 'missing' ? 401 : state === 'allowed' ? 200 : 403);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        if (state !== 'allowed') { assert.equal(h.writes.length, before); continue; }
        const text = await response.text();
        if (method === 'POST' && path.endsWith('invites')) {
          const body: unknown = JSON.parse(text); assert.ok(typeof body === 'object' && body !== null && 'items' in body && Array.isArray(body.items));
          const item: unknown = body.items[0]; assert.ok(typeof item === 'object' && item !== null && 'code' in item && typeof item.code === 'string');
          cleartext = item.code;
        } else assert.ok(cleartext && !text.includes(cleartext));
      }
      if (state === 'allowed') for (const [path, method, allow] of [['/operator/waitlist/invites', 'DELETE', 'GET, POST'],
        ['/operator/waitlist/invites/summary', 'POST', 'GET'], ['/operator/waitlist/invites/1/revoke', 'GET', 'POST']]) {
        const response = await fetch(base + path, { method }); assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), allow);
      }
    });
  }
});

test('#131 HTTP IP/user limits resist untrusted forwarded headers and user rotation across trusted IPs', async () => {
  const h = harness({ redeem: async () => { throw new AppError(404, 'INVITE_INVALID', 'invite code is invalid'); } });
  await withServer({ waitlistInvites: h.service }, async base => {
    const wrong = await fetch(base + '/waitlist/redeem'); assert.equal(wrong.status, 405); assert.equal(wrong.headers.get('allow'), 'POST');
    assert.equal((await fetch(base + '/waitlist/redeem', { method: 'POST', body: '{' })).status, 400);
    for (let i = 0; i < 9; i++) {
      const token = await h.fixture.sign({ sub: 'did:privy:ip-test-' + i, linked_accounts: JSON.stringify([twitter]) });
      const response = await fetch(base + '/waitlist/redeem', { method: 'POST', headers: { 'x-forwarded-for': '192.0.2.' + i }, body: JSON.stringify({ identityToken: token, code: 'ABCDEFGH23' }) });
      assert.equal(response.status, 404);
    }
    const response = await fetch(base + '/waitlist/redeem', { method: 'POST', body: '{}' });
    assert.equal(response.status, 429); assert.ok(Number(response.headers.get('retry-after')) > 0);
  });
  const user = harness(); const token = await user.sign();
  const rateLimiter = new RequestRateLimiter({ ...loadRateLimitConfig({}), trustedProxyIps: ['127.0.0.1'] }, new MemoryRateLimitStore());
  await withServer({ waitlistInvites: user.service, rateLimiter }, async base => {
    for (let i = 0; i < 6; i++) {
      const response = await fetch(base + '/waitlist/redeem', { method: 'POST', headers: { 'x-forwarded-for': '192.0.2.' + i }, body: JSON.stringify({ identityToken: token, code: 'ABCDEFGH23' }) });
      assert.equal(response.status, i < 5 ? 200 : 429);
      if (i < 5) assert.deepEqual(await response.json(), { status: 'approved', xHandle: twitter.username, joinedAt: '2026-11-16T00:00:00.000001Z' });
      else assert.ok(Number(response.headers.get('retry-after')) > 0);
    }
  });
});

test('#131 HTTP errors and logs contain no input code, token or dependency secrets', async () => {
  const h = harness({ redeem: async () => { throw new Error('sensitive-dependency-value'); } });
  const code = 'KJHGFEDC98', token = await h.sign(); const logs: string[] = [];
  const originalLog = console.log, originalError = console.error;
  console.log = console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  try {
    await withServer({ waitlistInvites: h.service }, async base => {
      const response = await fetch(base + '/waitlist/redeem', { method: 'POST', body: JSON.stringify({ identityToken: token, code }) });
      assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /sensitive/);
    });
    assert.ok(logs.length > 0);
    for (const secret of [code, token, 'sensitive-dependency-value']) assert.ok(!logs.join('\n').includes(secret));
  } finally { console.log = originalLog; console.error = originalError; }
});
