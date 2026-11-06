import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem/accounts';
import {
  AuthStore,
  NONCE_TTL_MS,
  SESSION_TTL_MS,
  authenticate,
  buildLoginMessage,
  issueNonce,
  login,
  parseLoginBody,
} from '../src/auth.js';
import type { NonceChallenge, SessionCredentials } from '../src/auth.js';
import { closePool, migrate, query } from '../src/db.js';
import { ForbiddenError, UnauthorizedError, ValidationError } from '../src/errors.js';
import { createServer } from '../src/server.js';
import type { ServerDeps } from '../src/server.js';
import { assertProviderOwns, createStrategy } from '../src/strategies.js';
import type { PublishVersionInput, Strategy, StrategyVersion } from '../src/strategies.js';

const ASSET_A = '0x00000000000000000000000000000000000000a1';
const ASSET_B = '0x00000000000000000000000000000000000000b2';

const PUBLISH_BODY = {
  allocation: {
    assets: [
      { address: ASSET_A, symbol: 'AAPLB', weightBps: 6000 },
      { address: ASSET_B, weightBps: 4000 },
    ],
  },
  schedule: { kind: 'interval', intervalSeconds: 86_400 },
  changeLog: 'rebalance',
};

/** DB-backed tests only run when DATABASE_URL is present; otherwise they are reported as skipped. */
const skipDb: boolean | string = process.env.DATABASE_URL ? false : 'DATABASE_URL is not set';

/** Fresh random wallet per test: no key material is ever written to the repository. */
function newAccount(): PrivateKeyAccount {
  return privateKeyToAccount(generatePrivateKey());
}

async function signMessage(account: PrivateKeyAccount, nonce: string): Promise<string> {
  return account.signMessage({ message: buildLoginMessage(nonce) });
}

function isAppError(err: unknown, status: number, code: string): boolean {
  assert.ok(err instanceof Error, `expected an AppError, got ${String(err)}`);
  const { status: actualStatus, code: actualCode } = err as { status?: unknown; code?: unknown };
  assert.equal(actualStatus, status);
  assert.equal(actualCode, code);
  return true;
}

// ---------------------------------------------------------------------------
// Nonce challenge
// ---------------------------------------------------------------------------

test('issueNonce returns 64 hex chars with a 5 minute TTL, unique per call', () => {
  const before = Date.now();
  const challenge = issueNonce();

  assert.match(challenge.nonce, /^[0-9a-f]{64}$/);
  const ttl = Date.parse(challenge.expiresAt) - before;
  assert.ok(ttl > NONCE_TTL_MS - 2_000, `TTL too short: ${ttl}`);
  assert.ok(ttl <= NONCE_TTL_MS + 2_000, `TTL too long: ${ttl}`);
  assert.notEqual(issueNonce().nonce, challenge.nonce);
});

test('buildLoginMessage is the exact EIP-191 personal_sign payload', () => {
  assert.equal(buildLoginMessage('abc123'), 'Sign in to CRE8 ATP\n\nNonce: abc123');
});

// ---------------------------------------------------------------------------
// login / authenticate (store level)
// ---------------------------------------------------------------------------

test('login recovers the wallet from a personal_sign signature and mints a 24h session', async () => {
  const store = new AuthStore();
  const account = newAccount();
  const { nonce } = store.issueNonce();

  const session = await store.login(account.address, nonce, await signMessage(account, nonce));

  assert.match(session.token, /^[0-9a-f]{64}$/);
  const ttl = Date.parse(session.expiresAt) - Date.now();
  assert.ok(ttl > SESSION_TTL_MS - 2_000, `TTL too short: ${ttl}`);
  assert.ok(ttl <= SESSION_TTL_MS + 2_000, `TTL too long: ${ttl}`);

  // The trusted identity is the lowercased recovered address, not the casing the client sent.
  assert.equal(store.authenticate(`Bearer ${session.token}`), account.address.toLowerCase());
  assert.equal(store.authenticate(`Bearer   ${session.token}`), account.address.toLowerCase());
});

test('login accepts any address casing for the wallet', async () => {
  const store = new AuthStore();
  const account = newAccount();
  const { nonce } = store.issueNonce();

  const session = await store.login(
    ` ${account.address.toLowerCase()} `,
    nonce,
    await signMessage(account, nonce),
  );

  assert.equal(store.authenticate(`Bearer ${session.token}`), account.address.toLowerCase());
});

test('login rejects a signature from another wallet with 401 INVALID_SIGNATURE', async () => {
  const store = new AuthStore();
  const alice = newAccount();
  const mallory = newAccount();
  const { nonce } = store.issueNonce();

  await assert.rejects(
    store.login(alice.address, nonce, await signMessage(mallory, nonce)),
    (err: unknown) => isAppError(err, 401, 'INVALID_SIGNATURE'),
  );
});

test('login rejects a malformed signature with 401 INVALID_SIGNATURE', async () => {
  const store = new AuthStore();
  const account = newAccount();
  const { nonce } = store.issueNonce();

  await assert.rejects(
    store.login(account.address, nonce, '0xdeadbeef'),
    (err: unknown) => isAppError(err, 401, 'INVALID_SIGNATURE'),
  );
});

test('login rejects an unknown nonce with 400 INVALID_NONCE', async () => {
  const store = new AuthStore();
  const account = newAccount();
  const unknownNonce = 'ab'.repeat(32);

  await assert.rejects(
    store.login(account.address, unknownNonce, await signMessage(account, unknownNonce)),
    (err: unknown) => isAppError(err, 400, 'INVALID_NONCE'),
  );
});

test('a nonce is single use: replaying it after login is 400 INVALID_NONCE', async () => {
  const store = new AuthStore();
  const account = newAccount();
  const { nonce } = store.issueNonce();
  const signature = await signMessage(account, nonce);

  await store.login(account.address, nonce, signature);

  await assert.rejects(
    store.login(account.address, nonce, signature),
    (err: unknown) => isAppError(err, 400, 'INVALID_NONCE'),
  );
});

test('an expired nonce is 400 NONCE_EXPIRED', async () => {
  let now = 1_700_000_000_000;
  const store = new AuthStore({ now: () => now });
  const account = newAccount();
  const { nonce } = store.issueNonce();
  const signature = await signMessage(account, nonce);

  now += NONCE_TTL_MS + 1;

  await assert.rejects(
    store.login(account.address, nonce, signature),
    (err: unknown) => isAppError(err, 400, 'NONCE_EXPIRED'),
  );
});

test('an expired session is 401 UNAUTHORIZED', async () => {
  let now = 1_700_000_000_000;
  const store = new AuthStore({ now: () => now });
  const account = newAccount();
  const { nonce } = store.issueNonce();

  const session = await store.login(account.address, nonce, await signMessage(account, nonce));

  now += SESSION_TTL_MS + 1;

  assert.throws(
    () => store.authenticate(`Bearer ${session.token}`),
    (err: unknown) => isAppError(err, 401, 'UNAUTHORIZED'),
  );
});

test('authenticate rejects missing, malformed and unknown bearer tokens with 401 UNAUTHORIZED', () => {
  const store = new AuthStore();

  for (const header of [null, undefined, '', 'Bearer', 'Bearer ', 'Basic abc', 'deadbeef', 'Bearer deadbeef']) {
    assert.throws(
      () => store.authenticate(header),
      (err: unknown) => isAppError(err, 401, 'UNAUTHORIZED'),
      `expected 401 for header ${String(header)}`,
    );
  }
});

test('the module-level store shares sessions between issueNonce, login and authenticate', async () => {
  const account = newAccount();
  const { nonce } = issueNonce();
  const session = await login(account.address, nonce, await signMessage(account, nonce));

  assert.equal(authenticate(`Bearer ${session.token}`), account.address.toLowerCase());
  assert.throws(
    () => authenticate('Bearer not-a-session'),
    (err: unknown) => err instanceof UnauthorizedError && err.code === 'UNAUTHORIZED',
  );
});

test('parseLoginBody requires string fields and reports 400 INVALID_AUTH', () => {
  assert.deepEqual(
    parseLoginBody({ wallet: ' 0xabc ', nonce: 'n', signature: '0xsig' }),
    { wallet: '0xabc', nonce: 'n', signature: '0xsig' },
  );

  for (const body of [null, [], 'x', {}, { wallet: '0xabc', nonce: 'n' }, { wallet: 1, nonce: 'n', signature: 's' }]) {
    assert.throws(
      () => parseLoginBody(body),
      (err: unknown) => err instanceof ValidationError && err.code === 'INVALID_AUTH',
    );
  }
});

// ---------------------------------------------------------------------------
// Provider ownership (pure gate, no DB)
// ---------------------------------------------------------------------------

test('assertProviderOwns accepts the owner (any casing) and rejects another wallet', () => {
  const owner = newAccount();

  assert.doesNotThrow(() => assertProviderOwns(owner.address, owner.address.toLowerCase()));
  assert.throws(
    () => assertProviderOwns(owner.address, newAccount().address),
    (err: unknown) => err instanceof ForbiddenError && err.status === 403 && err.code === 'FORBIDDEN',
  );
});

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

type TestDeps = Partial<ServerDeps>;

async function withServer<T>(run: (baseUrl: string) => Promise<T>, deps: TestDeps = {}): Promise<T> {
  const server = createServer(deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server did not bind to a TCP port');
  }

  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function postJson(
  baseUrl: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function requestNonce(baseUrl: string): Promise<NonceChallenge> {
  const response = await postJson(baseUrl, '/auth/nonce');
  assert.equal(response.status, 200);
  return (await response.json()) as NonceChallenge;
}

async function loginOverHttp(
  baseUrl: string,
  account: PrivateKeyAccount,
): Promise<SessionCredentials> {
  const challenge = await requestNonce(baseUrl);
  const response = await postJson(baseUrl, '/auth/login', {
    wallet: account.address,
    nonce: challenge.nonce,
    signature: await signMessage(account, challenge.nonce),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as SessionCredentials;
}

test('HTTP: nonce → login → POST /strategies creates a strategy owned by the wallet', async () => {
  const account = newAccount();
  const calls: Array<{ provider: string; body: unknown }> = [];

  const fakeCreate: typeof createStrategy = async (body, provider) => {
    calls.push({ provider, body });
    return {
      id: 42,
      provider,
      name: 'Index 500',
      description: '',
      isPublic: true,
      swapFeeBps: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
  };

  await withServer(
    async (baseUrl) => {
      const challenge = await requestNonce(baseUrl);
      assert.match(challenge.nonce, /^[0-9a-f]{64}$/);

      const session = await loginOverHttp(baseUrl, account);
      assert.equal(session.token.length, 64);
      assert.ok(Date.parse(session.expiresAt) > Date.now());

      const response = await postJson(
        baseUrl,
        '/strategies',
        // The body claims another provider; the session wallet must win.
        { provider: '0x000000000000000000000000000000000000dEaD', name: 'Index 500' },
        session.token,
      );

      assert.equal(response.status, 201);
      assert.equal(response.headers.get('location'), '/strategies/42');
      const strategy = (await response.json()) as Strategy;
      assert.equal(strategy.provider, account.address.toLowerCase());
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.provider, account.address.toLowerCase());
    },
    { createStrategy: fakeCreate },
  );
});

test('HTTP: POST /strategies without a token is 401 and never reaches the domain layer', async () => {
  let called = false;

  await withServer(
    async (baseUrl) => {
      for (const token of [undefined, 'wrong-token']) {
        const response = await postJson(baseUrl, '/strategies', { name: 'Index 500' }, token);
        assert.equal(response.status, 401);
        assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'UNAUTHORIZED');
      }
      assert.equal(called, false);
    },
    {
      createStrategy: async () => {
        called = true;
        throw new Error('createStrategy must not run for an unauthenticated request');
      },
    },
  );
});

test('HTTP: POST /strategies/:id/versions without a token is 401, with a token it is 201', async () => {
  const published: StrategyVersion = {
    strategyId: 1,
    version: 1,
    allocation: { assets: [{ address: ASSET_A, weightBps: 10_000 }] },
    schedule: { kind: 'interval', intervalSeconds: 86_400 },
    changeLog: 'rebalance',
    activeAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const providers: string[] = [];

  await withServer(
    async (baseUrl) => {
      const unauthorized = await postJson(baseUrl, '/strategies/1/versions', PUBLISH_BODY);
      assert.equal(unauthorized.status, 401);

      const account = newAccount();
      const session = await loginOverHttp(baseUrl, account);
      const authorized = await postJson(baseUrl, '/strategies/1/versions', PUBLISH_BODY, session.token);
      assert.equal(authorized.status, 201);
      assert.deepEqual(await authorized.json(), published);
      assert.deepEqual(providers, [account.address.toLowerCase()]);
    },
    {
      publishVersion: async (_id: number, _input: PublishVersionInput, provider: string) => {
        providers.push(provider);
        return published;
      },
    },
  );
});

test('HTTP: login with a bad signature is 401 INVALID_SIGNATURE', async () => {
  await withServer(async (baseUrl) => {
    const alice = newAccount();
    const mallory = newAccount();
    const challenge = await requestNonce(baseUrl);

    const response = await postJson(baseUrl, '/auth/login', {
      wallet: alice.address,
      nonce: challenge.nonce,
      signature: await signMessage(mallory, challenge.nonce),
    });

    assert.equal(response.status, 401);
    const payload = (await response.json()) as { error: { code: string } };
    assert.equal(payload.error.code, 'INVALID_SIGNATURE');
  });
});

test('HTTP: replaying a used nonce is 400 INVALID_NONCE', async () => {
  await withServer(async (baseUrl) => {
    const account = newAccount();
    const challenge = await requestNonce(baseUrl);
    const body = {
      wallet: account.address,
      nonce: challenge.nonce,
      signature: await signMessage(account, challenge.nonce),
    };

    const first = await postJson(baseUrl, '/auth/login', body);
    assert.equal(first.status, 200);

    const replay = await postJson(baseUrl, '/auth/login', body);
    assert.equal(replay.status, 400);
    const payload = (await replay.json()) as { error: { code: string } };
    assert.equal(payload.error.code, 'INVALID_NONCE');
  });
});

test('HTTP: an authenticated non-owner publishing a version is 403 FORBIDDEN', async () => {
  const ownerAddress = '0x1111111111111111111111111111111111111111';

  await withServer(
    async (baseUrl) => {
      const stranger = newAccount();
      const session = await loginOverHttp(baseUrl, stranger);

      const response = await postJson(baseUrl, '/strategies/7/versions', PUBLISH_BODY, session.token);

      assert.equal(response.status, 403);
      const payload = (await response.json()) as { error: { code: string } };
      assert.equal(payload.error.code, 'FORBIDDEN');
    },
    {
      // Mirrors what the real publishVersion does after loading the strategy row.
      publishVersion: async (_id: number, _input: PublishVersionInput, provider: string) => {
        assertProviderOwns(ownerAddress, provider);
        throw new Error('ownership gate must throw before the insert');
      },
    },
  );
});

test('HTTP: POST /auth/login requires a JSON object body', async () => {
  await withServer(async (baseUrl) => {
    const noBody = await postJson(baseUrl, '/auth/login');
    assert.equal(noBody.status, 400);
    assert.equal(((await noBody.json()) as { error: { code: string } }).error.code, 'INVALID_JSON');

    const missing = await postJson(baseUrl, '/auth/login', { wallet: '0xabc' });
    assert.equal(missing.status, 400);
    assert.equal(((await missing.json()) as { error: { code: string } }).error.code, 'INVALID_AUTH');
  });
});

// ---------------------------------------------------------------------------
// DB integration (gated on DATABASE_URL)
// ---------------------------------------------------------------------------

after(async () => {
  await closePool();
});

test('DB: provider ownership is enforced end to end over HTTP', { skip: skipDb }, async () => {
  await migrate();
  const owner = newAccount();
  const stranger = newAccount();
  const strategy = await createStrategy(
    { name: `it-auth-${randomUUID()}`, isPublic: false },
    owner.address.toLowerCase(),
  );

  try {
    await withServer(async (baseUrl) => {
      const ownerSession = await loginOverHttp(baseUrl, owner);
      const created = await postJson(
        baseUrl,
        `/strategies/${strategy.id}/versions`,
        PUBLISH_BODY,
        ownerSession.token,
      );
      assert.equal(created.status, 201);
      assert.equal(((await created.json()) as StrategyVersion).version, 1);

      const strangerSession = await loginOverHttp(baseUrl, stranger);
      const denied = await postJson(
        baseUrl,
        `/strategies/${strategy.id}/versions`,
        PUBLISH_BODY,
        strangerSession.token,
      );
      assert.equal(denied.status, 403);
      assert.equal(((await denied.json()) as { error: { code: string } }).error.code, 'FORBIDDEN');
    });
  } finally {
    await query('delete from strategies where id = $1', [strategy.id]);
  }
});
