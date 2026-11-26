import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { mnemonicToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { AuthStore, PostgresSessionRepository, SESSION_TTL_MS, sha256Hex } from '../src/auth.js';
import { closePool, getPool, migrate, query } from '../src/db.js';
import { AppError } from '../src/errors.js';
import { createWaitlistInviteService } from '../src/waitlist-invites.js';
import { PostgresPrivyUserRepository, createPrivyLogin } from '../src/privy.js';
import { loadRateLimitConfig } from '../src/config.js';
import { MemoryRateLimitStore, RequestRateLimiter } from '../src/ratelimit.js';
import { createServer } from '../src/server.js';
import { postgresWaitlistAccess } from '../src/waitlist-access.js';
import { createWaitlistService, PostgresWaitlistRepository } from '../src/waitlist.js';
import { approveTestUser } from './fixtures/waitlist-access.js';
import { privyFixture } from './fixtures/privy.js';
import { runScript } from './fixtures/secret-output.js';

const wallet = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 9 });
const pending = (error: unknown) => error instanceof AppError && error.status === 403 && error.code === 'WAITLIST_PENDING';
const repository = new PostgresWaitlistRepository();
before(migrate);
after(closePool);

async function addUser(owner = '0x' + randomBytes(20).toString('hex')) {
  const userId = 'did:privy:be133:' + randomUUID();
  await query('insert into privy_users (privy_user_id,owner_address) values ($1,$2)', [userId, owner]);
  return { userId, owner };
}
async function removeUser(userId: string, owner: string) {
  await query('delete from auth_sessions where wallet=$1', [owner]);
  await query('delete from privy_users where privy_user_id=$1', [userId]);
}

async function withServer(login: ReturnType<typeof createPrivyLogin>, fn: (base: string) => Promise<void>, waitlist = createWaitlistService(), waitlistInvites = createWaitlistInviteService()) {
  const server = createServer({ privyLogin: login, waitlist, waitlistInvites, rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore()) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try { await fn(`http://127.0.0.1:${address.port}`); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

async function responseToken(response: Response) {
  assert.equal(response.status, 200);
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null && 'token' in body && typeof body.token === 'string');
  return body.token;
}
async function expectPending(response: Response) {
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: { code: 'WAITLIST_PENDING', message: 'waitlist approval is required; sign in with X' } });
}

test('#133 Postgres real Privy/SIWE HTTP gates Privy states and rejects borrowed approved wallets through SIWE', async () => {
  for (const status of [null, 'waiting', 'revoked', 'approved'] as const) {
    const f = privyFixture(); const owner = wallet.address.toLowerCase();
    if (status !== null) {
      const row = await repository.join({ privyUserId: f.userId, xUserId: randomUUID(), xHandle: 'gate_test' });
      if (status !== 'waiting') await approveTestUser(f.userId); // Direct DB approval models #131's successful redemption.
      if (status === 'revoked') await repository.transition(row.id, 'revoked', owner);
    }
    const login = createPrivyLogin({ config: () => f.config });
    try {
      await withServer(login, async base => {
        const identityToken = await f.sign({ linked_accounts: JSON.stringify([{ ...f.wallet, address: owner }]) });
        const privy = await fetch(base + '/auth/privy', { method: 'POST', body: JSON.stringify({ identityToken, status: 'approved' }) });
        if (status === 'approved') {
          const token = await responseToken(privy);
          assert.equal(await new AuthStore().authenticate('Bearer ' + token), owner);
        } else await expectPending(privy);
        const nonce: unknown = await (await fetch(base + '/auth/nonce', { method: 'POST' })).json();
        assert.ok(typeof nonce === 'object' && nonce !== null);
        const field = (name: string): string => {
          const value: unknown = Reflect.get(nonce, name);
          assert.equal(typeof value, 'string'); return String(value);
        };
        const chainId: unknown = Reflect.get(nonce, 'chainId'); assert.ok(typeof chainId === 'number');
        const siweMessage = createSiweMessage({ address: wallet.address, domain: field('domain'), uri: field('uri'),
          statement: field('statement'), nonce: field('nonce'), version: '1', chainId, issuedAt: new Date(field('issuedAt')) });
        const siwe = await fetch(base + '/auth/login', { method: 'POST', body: JSON.stringify({ message: siweMessage,
          signature: await wallet.signMessage({ message: siweMessage }) }) });
        await expectPending(siwe);
        const rows = await query('select 1 from auth_sessions where wallet=$1', [owner]);
        assert.equal(rows.rows.length, status === 'approved' ? 1 : 0);
        assert.equal(await new PostgresPrivyUserRepository().find(f.userId), status === 'approved' ? owner : null);
        assert.equal((await fetch(base + '/health')).status, 200);
        assert.equal((await fetch(base + '/strategies?limit=1')).status, 200);
        const ownStatus = await fetch(base + '/waitlist/me', { headers: { authorization: 'Bearer ' + identityToken } });
        assert.equal(ownStatus.status, status === null ? 404 : 200);
      }, createWaitlistService({ config: () => f.config }));
    } finally { await removeUser(f.userId, owner); }
  }
});

test('#133 Postgres old sessions and two fresh instances observe revocation immediately; no cached allowance', async () => {
  const user = await addUser();
  await approveTestUser(user.userId);
  const first = new AuthStore(), second = new AuthStore();
  const sessions = [await first.issueSession(user.owner, user.userId), await second.issueSession(user.owner, user.userId)];
  try {
    for (const session of sessions) assert.equal(await second.authenticate('Bearer ' + session.token), user.owner);
    const row = await repository.find(user.userId); assert.ok(row);
    await repository.transition(row.id, 'revoked', wallet.address.toLowerCase());
    await withServer(createPrivyLogin({ config: () => null }), async base => {
      for (const session of sessions) {
        await assert.rejects(first.authenticate('Bearer ' + session.token), pending);
        await assert.rejects(new AuthStore().authenticate('Bearer ' + session.token), pending);
        await expectPending(await fetch(base + '/assets', { headers: { authorization: 'Bearer ' + session.token } }));
      }
    });
    await assert.rejects(second.issueSession(user.owner), pending);
    await repository.transition(row.id, 'approved', wallet.address.toLowerCase());
    for (const session of sessions) assert.equal(await first.authenticate('Bearer ' + session.token), user.owner);
  } finally { await removeUser(user.userId, user.owner); }
});

test('#133 Postgres rejects legacy NULL sessions even for approved wallets; other wallet identities cannot affect a session', async () => {
  const user = await addUser();
  const other = await addUser(user.owner);
  const token = randomUUID();
  try {
    assert.equal(await postgresWaitlistAccess(user.userId), false);
    await approveTestUser(user.userId);
    assert.equal(await postgresWaitlistAccess(user.userId), true, 'missing other waitlist entry cannot block approval');
    assert.equal(await postgresWaitlistAccess('did:privy:wrong'), false);
    const first = await new AuthStore().issueSession(user.owner, user.userId);
    await approveTestUser(other.userId);
    const second = await new AuthStore().issueSession(other.owner, other.userId);
    const row = await repository.find(other.userId); assert.ok(row);
    await repository.transition(row.id, 'revoked', wallet.address.toLowerCase());
    assert.equal(await new AuthStore().authenticate('Bearer ' + first.token), user.owner);
    await assert.rejects(new AuthStore().authenticate('Bearer ' + second.token), pending);
    await assert.rejects(new AuthStore().issueSession(other.owner, other.userId), pending);
    await new PostgresSessionRepository().save(sha256Hex(token), user.owner, new Date(Date.now() + SESSION_TTL_MS));
    assert.equal((await new PostgresSessionRepository().find(sha256Hex(token)))?.privyUserId, null);
    await assert.rejects(new AuthStore().authenticate('Bearer ' + token), pending);
    await query('delete from privy_users where privy_user_id=$1', [user.userId]);
    assert.equal(await new AuthStore().authenticate('Bearer ' + first.token), user.owner, 'gate uses only the saved verified identity');
  } finally { await removeUser(user.userId, user.owner); await removeUser(other.userId, other.owner); }
});

test('#133 real Postgres waitlist statement timeout fails closed for login and old sessions without leaking credentials', { timeout: 15000 }, async () => {
  const user = await addUser();
  await approveTestUser(user.userId);
  const session = await new AuthStore().issueSession(user.owner, user.userId);
  const client = await getPool().connect();
  try {
    await client.query('begin'); await client.query('lock table waitlist in access exclusive mode');
    const result = await runScript('src/auth.ts', { DATABASE_URL: process.env.DATABASE_URL, DB_STATEMENT_TIMEOUT_MS: '50', OPERATOR_WALLETS: '' }, `
      const { AuthStore } = await import('./src/auth.ts');
      const { closePool } = await import('./src/db.ts');
      try {
        const store = new AuthStore();
        for (const call of [() => store.issueSession(${JSON.stringify(user.owner)}, ${JSON.stringify(user.userId)}),
          () => store.authenticate('Bearer ' + ${JSON.stringify(session.token)})]) {
          let rejected = false;
          try { await call(); } catch (error) {
            if (error.status !== 503 || error.code !== 'WAITLIST_UNAVAILABLE' || error.cause !== undefined) throw new Error('unexpected gate error');
            rejected = true;
          }
          if (!rejected) throw new Error('timeout admitted a session');
        }
        console.log('expected waitlist timeout');
      } finally { await closePool(); }
    `);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /expected waitlist timeout/);
    assert.ok(!result.output.includes(session.token));
    assert.doesNotMatch(result.output, /postgres:|DATABASE_URL|seed/);
  } finally { await client.query('rollback'); client.release(); await removeUser(user.userId, user.owner); }
});

test('#133 default session gate uses the operator environment whitelist without a waitlist or Privy mapping', async () => {
  const owner = wallet.address.toLowerCase();
  const result = await runScript('src/auth.ts', { DATABASE_URL: process.env.DATABASE_URL, OPERATOR_WALLETS: owner.toUpperCase() }, `
    const { AuthStore } = await import('./src/auth.ts');
    const { closePool } = await import('./src/db.ts');
    try {
      const store = new AuthStore();
      const session = await store.issueSession(${JSON.stringify(owner)});
      const saved = await new (await import('./src/auth.ts')).PostgresSessionRepository().find((await import('./src/auth.ts')).sha256Hex(session.token));
      if (saved?.privyUserId !== null) throw new Error('operator SIWE must store NULL identity');
      if (await new AuthStore().authenticate('Bearer ' + session.token) !== ${JSON.stringify(owner)}) throw new Error('operator blocked');
      await store.logout('Bearer ' + session.token);
      console.log('operator admitted');
    } finally { await closePool(); }
  `);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /operator admitted/);
});


test('#134 real HTTP invitation redemption enables Privy login with a persisted identity across instances', async () => {
  const f = privyFixture();
  const invites = createWaitlistInviteService({ config: () => f.config });
  const batch = await invites.issue({ count: 1 }, wallet.address);
  const code = batch.items[0]; assert.ok(code);
  const identityToken = await f.sign({ linked_accounts: JSON.stringify([f.wallet,
    { type: 'twitter_oauth', subject: (BigInt('0x' + randomBytes(8).toString('hex')) + 1n).toString(), username: 'invite_gate' }]) });
  try {
    await withServer(createPrivyLogin({ config: () => f.config }), async base => {
      const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', body: JSON.stringify(body) });
      await expectPending(await post('/auth/privy', { identityToken }));
      assert.equal(await new PostgresPrivyUserRepository().find(f.userId), null);
      const redeemed = await post('/waitlist/redeem', { identityToken, code: code.code });
      assert.equal(redeemed.status, 200);
      const row = await repository.find(f.userId); assert.ok(row);
      assert.equal(row.status, 'approved');
      assert.equal(row.approvedBy, 'invite:' + code.id);
      const token = await responseToken(await post('/auth/privy', { identityToken }));
      const saved = await new PostgresSessionRepository().find(sha256Hex(token));
      assert.equal(saved?.privyUserId, f.userId);
      assert.equal(await new AuthStore().authenticate('Bearer ' + token), f.owner);
      assert.equal((await fetch(base + '/assets', { headers: { authorization: 'Bearer ' + token } })).status, 200);
      await repository.transition(row.id, 'revoked', wallet.address.toLowerCase());
      await expectPending(await fetch(base + '/assets', { headers: { authorization: 'Bearer ' + token } }));
    }, createWaitlistService({ config: () => f.config }), invites);
  } finally { await removeUser(f.userId, f.owner); }
});

test('#134 Postgres unapproved login leaves no mapping and cannot poison an approved shared wallet', async () => {
  const f = privyFixture();
  const otherId = 'did:privy:be134-unapproved:' + randomUUID();
  const login = createPrivyLogin({ config: () => f.config });
  await approveTestUser(f.userId);
  try {
    const first = await login({ identityToken: await f.sign() });
    await withServer(login, async base => {
      const denied = await fetch(base + '/auth/privy', { method: 'POST', body: JSON.stringify({ identityToken: await f.sign({ sub: otherId }) }) });
      await expectPending(denied);
      assert.equal(await new PostgresPrivyUserRepository().find(otherId), null);
      assert.equal(await new AuthStore().authenticate('Bearer ' + first.token), f.owner);
      const token = await responseToken(await fetch(base + '/auth/privy', { method: 'POST', body: JSON.stringify({ identityToken: await f.sign() }) }));
      assert.equal(await new AuthStore().authenticate('Bearer ' + token), f.owner);
    });
  } finally { await removeUser(f.userId, f.owner); await removeUser(otherId, f.owner); }
});

test('#134 Postgres session upsert replaces and clears its Privy identity without keeping a previous approval', async () => {
  const sessions = new PostgresSessionRepository();
  const hash = sha256Hex(randomUUID());
  const owner = wallet.address.toLowerCase();
  const id = 'did:privy:be134:' + randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  try {
    await sessions.save(hash, owner, expiresAt, id);
    assert.deepEqual(await new PostgresSessionRepository().find(hash), { wallet: owner, expiresAt, privyUserId: id });
    await sessions.save(hash, owner, expiresAt, null);
    assert.equal((await sessions.find(hash))?.privyUserId, null);
  } finally { await sessions.remove(hash); }
});
