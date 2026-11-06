import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import type { SiweChallenge } from '../src/auth.js';
import { canonicalScheduleHash } from '../src/chain.js';
import { closePool, migrate } from '../src/db.js';
import { enrollPortfolio } from '../src/portfolios.js';
import type { Portfolio } from '../src/portfolios.js';
import { createServer } from '../src/server.js';
import type { ServerDeps } from '../src/server.js';

/** DB + chain integration tests only run when both are configured; otherwise they are skipped. */
const skipIntegration: boolean | string =
  process.env.DATABASE_URL && process.env.RPC_URL
    ? false
    : 'DATABASE_URL and RPC_URL are required for the enroll integration test';

const ROUTE_WALLET = privateKeyToAccount(generatePrivateKey());

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function withServer<T>(run: (baseUrl: string) => Promise<T>, deps?: Partial<ServerDeps>): Promise<T> {
  const server = createServer(deps);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server did not bind');
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function postJson(baseUrl: string, path: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function loginToken(baseUrl: string): Promise<string> {
  const nonceResponse = await fetch(`${baseUrl}/auth/nonce`, { method: 'POST' });
  assert.equal(nonceResponse.status, 200);
  const challenge = (await nonceResponse.json()) as SiweChallenge;
  const message = createSiweMessage({
    address: ROUTE_WALLET.address,
    chainId: challenge.chainId,
    domain: challenge.domain,
    uri: challenge.uri,
    statement: challenge.statement,
    version: '1',
    nonce: challenge.nonce,
    issuedAt: new Date(challenge.issuedAt),
  });
  const loginResponse = await postJson(baseUrl, '/auth/login', {
    message,
    signature: await ROUTE_WALLET.signMessage({ message }),
  });
  assert.equal(loginResponse.status, 200);
  const { token } = (await loginResponse.json()) as { token: string };
  return token;
}

function samplePortfolio(id = 1): Portfolio {
  return {
    id,
    userId: ROUTE_WALLET.address.toLowerCase(),
    strategyId: 1,
    version: 1,
    scheduleState: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    smartAccounts: [
      { chainId: 56, address: ROUTE_WALLET.address.toLowerCase(), owner: ROUTE_WALLET.address.toLowerCase(), accountType: 'EOA' },
    ],
  };
}

// ---------------------------------------------------------------------------
// route: POST /portfolios (enrollPortfolio injected, no DB)
// ---------------------------------------------------------------------------

test('POST /portfolios requires a bearer token (401)', async () => {
  await withServer(async (baseUrl) => {
    const res = await postJson(baseUrl, '/portfolios', { strategyId: 1 });
    assert.equal(res.status, 401);
  });
});

test('POST /portfolios calls enrollPortfolio(strategyId, session wallet) and returns 201', async () => {
  const calls: Array<{ strategyId: number; wallet: string }> = [];
  const fake: typeof enrollPortfolio = async (strategyId, wallet) => {
    calls.push({ strategyId, wallet });
    return samplePortfolio(1);
  };

  await withServer(async (baseUrl) => {
    const token = await loginToken(baseUrl);
    const res = await postJson(baseUrl, '/portfolios', { strategyId: 42 }, token);
    assert.equal(res.status, 201);
    const body = (await res.json()) as Portfolio;
    assert.equal(body.id, 1);
    assert.equal(res.headers.get('location'), '/portfolios/1');
  }, { enrollPortfolio: fake });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.strategyId, 42);
  assert.equal(calls[0]?.wallet, ROUTE_WALLET.address.toLowerCase());
});

test('POST /portfolios rejects a non-integer strategyId (400)', async () => {
  await withServer(async (baseUrl) => {
    const token = await loginToken(baseUrl);
    const res = await postJson(baseUrl, '/portfolios', { strategyId: 'abc' }, token);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'INVALID_ID');
  });
});

test('POST /portfolios rejects a non-object body (400)', async () => {
  await withServer(async (baseUrl) => {
    const token = await loginToken(baseUrl);
    const res = await fetch(`${baseUrl}/portfolios`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: 'null',
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'INVALID_PORTFOLIO');
  });
});

test('GET /portfolios is not allowed (405)', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/portfolios`);
    assert.equal(res.status, 405);
  });
});

// ---------------------------------------------------------------------------
// chain: canonical schedule hash
// ---------------------------------------------------------------------------

test('canonicalScheduleHash is deterministic and distinct per schedule', () => {
  const a = canonicalScheduleHash({ kind: 'interval', intervalSeconds: 86_400 });
  const b = canonicalScheduleHash({ kind: 'interval', intervalSeconds: 86_400 });
  const c = canonicalScheduleHash({ kind: 'interval', intervalSeconds: 3_600 });
  const d = canonicalScheduleHash({ kind: 'cron', cron: '0 0 * * *' });

  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
});

// ---------------------------------------------------------------------------
// integration: full enroll against the configured chain + DB (gated)
// ---------------------------------------------------------------------------

test('enrollPortfolio mirrors to chain and writes portfolio + smart account', { skip: skipIntegration }, async () => {
  await migrate();

  // Requires a running chain with a deployed AtpRegistry and a strategy already registered +
  // published on-chain (its DB row has onchain_id set). Create the DB strategy + mirror first via
  // the real domain path, then enroll a fresh wallet.
  const { createStrategy, publishVersion } = await import('../src/strategies.js');
  const provider = ROUTE_WALLET.address.toLowerCase();

  const strategy = await createStrategy(
    { provider, name: 'Integration Index', description: 'integration', isPublic: true, swapFeeBps: 0 },
    provider,
  );
  assert.ok(strategy.onchainId !== null, 'expected createStrategy to mirror to chain (RPC_URL set)');

  await publishVersion(
    strategy.id,
    {
      allocation: {
        assets: [
          { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', symbol: 'WBNB', weightBps: 5000 },
          { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', weightBps: 5000 },
        ],
      },
      schedule: { kind: 'interval', intervalSeconds: 86_400 },
      changeLog: 'integration',
    },
    provider,
  );

  const wallet = privateKeyToAccount(generatePrivateKey());
  const portfolio = await enrollPortfolio(strategy.id, wallet.address);
  assert.equal(portfolio.strategyId, strategy.id);
  assert.equal(portfolio.userId, wallet.address.toLowerCase());
  assert.equal(portfolio.smartAccounts.length, 1);
  assert.equal(portfolio.smartAccounts[0]?.accountType, 'EOA');
});

after(async () => {
  await closePool();
});
