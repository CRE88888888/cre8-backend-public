import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Address } from 'viem';
import { zeroAddress } from 'viem';
import { ConfigurationError, loadWelcomeConfig, WELCOME_AMOUNT_WEI } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { createWelcomeService, readWelcomeFundingEvidence } from '../src/welcome-grants.js';
import type { WelcomeDeps, WelcomeGrant } from '../src/welcome-grants.js';
import { strategyRpc, TEST_ACCOUNT, TEST_OWNER, OTHER_HASH } from './fixtures/strategy-rpc.js';
import { validateAllocation } from '../src/strategies.js';
import { TESTNET_97 } from '../src/testnet-profile.js';
import { createPointsService } from '../src/points.js';
import { loadPointsConfig } from '../src/config.js';
import { createServer } from '../src/server.js';
import { createPortfolioStrategyService } from '../src/portfolio-strategies.js';
import { UnauthorizedError } from '../src/errors.js';
import { RequestRateLimiter } from '../src/ratelimit.js';
import { loadRateLimitConfig } from '../src/config.js';

const c = { chainId: 97 as const, siteDailyWei: 5_000_000n * 10n ** 18n, timeoutMs: 20 };
const grant: WelcomeGrant = { id: '91', chainId: 97, owner: TEST_OWNER, account: TEST_ACCOUNT, portfolioId: 91, amountWei: 10_000n * 10n ** 18n,
  day: '2026-11-15', state: 'reserved', txHash: null, logIndex: null, blockNumber: null, blockHash: null };
const denied = (code: string) => (e: unknown) => e instanceof AppError && e.code === code && !e.message.includes('SECRET');
function harness(extra: WelcomeDeps = {}) {
  const events: string[] = [];
  let sends = 0;
  const service = createWelcomeService({ config: c, find: async () => null,
    lock: async (_chain, run) => run(() => {}), reserve: async () => { events.push('reserve-commit'); return { grant, created: true }; },
    settle: async (_grant, state) => { events.push(state); },
    prepare: async () => { events.push('prepare'); return { hash: OTHER_HASH, raw: '0x01', broadcast: async () => { events.push('send'); sends++; }, wait: async () => {} }; }, ...extra });
  return { service, events, sends: () => sends };
}

test('#91 welcome configuration is chain 97 only, fixed 10000, default 5M; zero, uint256 boundaries and invalid values', () => {
  assert.equal(WELCOME_AMOUNT_WEI, 10000000000000000000000n);
  assert.equal(loadWelcomeConfig({}), null);
  assert.equal(loadWelcomeConfig({ CHAIN_ID: '56' }), null);
  assert.deepEqual(loadWelcomeConfig({ CHAIN_ID: '97' }), { ...c, timeoutMs: 5000 });
  assert.equal(loadWelcomeConfig({ CHAIN_ID: '97', WELCOME_USDT_SITE_DAILY_WEI: '0' })?.siteDailyWei, 0n);
  assert.equal(loadWelcomeConfig({ CHAIN_ID: '97', WELCOME_USDT_SITE_DAILY_WEI: ((1n << 256n) - 1n).toString() })?.siteDailyWei, (1n << 256n) - 1n);
  for (const value of ['-1', '0.1', 'SECRET', (1n << 256n).toString()]) {
    assert.throws(() => loadWelcomeConfig({ CHAIN_ID: '97', WELCOME_USDT_SITE_DAILY_WEI: value }), (e: unknown) => e instanceof ConfigurationError && !e.message.includes('SECRET'));
  }
});

test('#91 only a new committed reservation prepares; hash commit precedes the single broadcast', async () => {
  const h = harness();
  assert.equal((await h.service.issue(grant)).state, 'submitted');
  assert.deepEqual(h.events, ['reserve-commit', 'prepare', 'submitted', 'send']);
  assert.equal(h.sends(), 1);
});

test('#91 all lifetime states, restarts, other portfolios and dates return the original grant without preparing', async () => {
  for (const state of ['reserved', 'submitted', 'unknown', 'confirmed', 'failed'] as const) {
    const original = { ...grant, state, day: '2000-01-01' };
    const h = harness({ find: async () => original });
    assert.deepEqual(await h.service.issue({ ...grant, portfolioId: 92 }), original);
    assert.deepEqual(h.events, []);
  }
  const h = harness({ reserve: async () => ({ grant, created: false }) });
  assert.deepEqual(await h.service.issue(grant), grant); assert.equal(h.sends(), 0);
  await assert.rejects(createWelcomeService({ config: null }).issue(grant), denied('FUNDING_SOURCE_DISABLED'));
});

test('#91 DB failures, unknown reservation/hash commits and lost relayer lock never broadcast', async () => {
  const unavailable = () => { throw new AppError(503, 'WELCOME_STORAGE_UNAVAILABLE', 'storage unavailable'); };
  for (const extra of [{ find: unavailable }, { reserve: unavailable }, { settle: unavailable },
    { lock: async () => { throw new AppError(503, 'RELAYER_BUSY', 'busy'); } }]) {
    const h = harness(extra); await assert.rejects(h.service.issue(grant)); assert.equal(h.sends(), 0);
  }
  let held = 0;
  const h = harness({ lock: async (_chain, run) => run(() => { if (++held === 3) throw new Error('SECRET_LOCK_LOST'); }) });
  assert.equal((await h.service.issue(grant)).state, 'unknown'); assert.equal(h.sends(), 0);
});

test('#91 pre-broadcast RPC failure or timeout fails the lifetime record; late preparation cannot send', async () => {
  for (const timeout of [false, true]) {
    const h = harness({ prepare: async () => {
      if (!timeout) throw new Error('SECRET_RPC');
      await new Promise(resolve => setTimeout(resolve, 40));
      return { hash: OTHER_HASH, raw: '0x01', broadcast: async () => { throw new Error('must never send'); }, wait: async () => {} };
    } });
    await assert.rejects(h.service.issue(grant), denied('WELCOME_PREPARE_UNAVAILABLE'));
    await new Promise(resolve => setTimeout(resolve, 45));
    assert.deepEqual(h.events, ['reserve-commit', 'failed']); assert.equal(h.sends(), 0);
  }
});

test('#91 ambiguous broadcast/receipt error and timeout retain hash as unknown', async () => {
  for (const stage of ['broadcast-error', 'broadcast-timeout', 'receipt-error', 'receipt-timeout']) {
    const h = harness({ prepare: async () => ({ hash: OTHER_HASH, raw: '0x01',
      broadcast: async () => { if (stage === 'broadcast-error') throw new Error('SECRET'); if (stage === 'broadcast-timeout') await new Promise(() => {}); },
      wait: async () => { if (stage === 'receipt-error') throw new Error('SECRET'); if (stage === 'receipt-timeout') await new Promise(() => {}); } }) });
    const result = await h.service.issue(grant);
    assert.equal(result.state, 'unknown'); assert.equal(result.txHash, OTHER_HASH);
    assert.deepEqual(h.events, ['reserve-commit', 'submitted', 'unknown']);
  }
});

function rpc() {
  const allocation = validateAllocation({ assets: [{ address: TESTNET_97.assets.AAPLB.token, weightBps: 10000 }] }, 97);
  const r = strategyRpc(allocation, OTHER_HASH, new Date('2026-11-15T00:00:00Z'));
  r.state.mint = true; r.state.amount = grant.amountWei;
  return r;
}
const source = { chainId: 97, account: TEST_ACCOUNT, amountWei: grant.amountWei, txHash: OTHER_HASH };

test('#91 viem welcome evidence verifies original mint calldata, authorized minter, canonical block and exact zero-origin Transfer', async () => {
  const r = rpc();
  const evidence = await readWelcomeFundingEvidence(source, r.client);
  assert.equal(evidence.amountRaw, '10000000000000000000000'); assert.equal(evidence.logIndex, 0); assert.equal(evidence.blockNumber, 130n);
  for (const [key, value] of Object.entries({ chainId: 56, minter: false, duplicateLog: true, logs: false, malformed: true, removed: true,
    txFrom: TEST_OWNER, txTo: TEST_ACCOUNT, transferFrom: TEST_OWNER, txValue: 1n, wrongInput: true, amount: 0n })) {
    const bad = rpc(); Reflect.set(bad.state, key, value);
    await assert.rejects(readWelcomeFundingEvidence(source, bad.client));
  }
  const noMint = rpc(); noMint.state.mint = false;
  await assert.rejects(readWelcomeFundingEvidence(source, noMint.client), denied('FUNDING_NOT_CONFIRMED'));
  for (const amountWei of [0n, grant.amountWei - 1n, grant.amountWei + 1n]) await assert.rejects(readWelcomeFundingEvidence({ ...source, amountWei }, r.client), denied('FUNDING_SOURCE_DISABLED'));
  await assert.rejects(readWelcomeFundingEvidence({ ...source, chainId: 56 }, r.client), denied('FUNDING_SOURCE_DISABLED'));
  await assert.rejects(readWelcomeFundingEvidence({ ...source, account: zeroAddress }, r.client));
});

test('#91 reverted canonical mint is definitive; missing receipt/RPC failure and orphan blocks are never credited', async () => {
  const reverted = rpc(); reverted.state.success = false;
  await assert.rejects(readWelcomeFundingEvidence(source, reverted.client), denied('WELCOME_REVERTED'));
  const orphan = rpc(); orphan.state.blockHash = `0x${'ff'.repeat(32)}`;
  await assert.rejects(readWelcomeFundingEvidence(source, orphan.client), denied('FUNDING_REORGED'));
  for (const method of ['eth_chainId', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getBlockByNumber', 'eth_call']) {
    const r = rpc(); r.state.fail = method;
    await assert.rejects(readWelcomeFundingEvidence(source, r.client), denied('FUNDING_RPC_UNAVAILABLE'));
  }
  const missing = rpc(); missing.state.missingReceipt = true;
  await assert.rejects(readWelcomeFundingEvidence(source, missing.client), denied('FUNDING_RPC_UNAVAILABLE'));
});

test('#91 points, tasks, invitations and operator campaign methods all report disabled by default or POINTS_ENABLED=0', async () => {
  for (const env of [{ CHAIN_ID: '97' }, { CHAIN_ID: '97', POINTS_ENABLED: '0', RPC_URL: 'SECRET' }]) {
    assert.equal(loadPointsConfig(env), null);
    const service = createPointsService({ config: loadPointsConfig(env) });
    const calls = [() => service.balance(TEST_OWNER), () => service.history(TEST_OWNER, {}), () => service.leaderboard({}),
      () => service.invites(TEST_OWNER), () => service.bind({}, TEST_OWNER), () => service.freeze({}, TEST_OWNER),
      () => service.tasks(), () => service.metrics(), () => service.sync()];
    for (const run of calls) await assert.rejects(async () => run(), denied('POINTS_DISABLED'));
  }
});

test('#91 buy-funding HTTP authenticates before parsing, applies wallet budget, and returns ready 200/pending 202', async () => {
  let loggedIn = false, pending = false, calls = 0;
  const server = createServer({
    auth: { authenticate: async () => { if (!loggedIn) throw new UnauthorizedError(); return TEST_OWNER; },
      issueNonce: () => { throw new Error('unexpected'); }, login: async () => { throw new Error('unexpected'); }, logout: async () => {} },
    rateLimiter: new RequestRateLimiter(loadRateLimitConfig({ RATE_LIMIT_PLAN_PER_MINUTE: '3' })),
    portfolioStrategies: { ...createPortfolioStrategyService(), buyFunding: async (id, wallet, input) => {
      assert.equal(id, 91); assert.equal(wallet, TEST_OWNER); assert.deepEqual(input, {}); calls++;
      return pending ? { state: 'pending', grantId: '91', txHash: null, funding: 'welcome_grant', lot: null }
        : { state: 'ready', funding: 'existing_cash', lot: null };
    } },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/portfolios/91/buy-funding`;
    const post = (body: string) => fetch(url, { method: 'POST', body });
    assert.equal((await fetch(url)).status, 405); assert.equal((await post('invalid')).status, 401);
    loggedIn = true;
    assert.equal((await post('invalid')).status, 400);
    assert.equal((await post('{}')).status, 200); pending = true;
    assert.equal((await post('{}')).status, 202);
    assert.equal((await post('{}')).status, 429); assert.equal(calls, 2);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('#91 every points/invite HTTP endpoint reports POINTS_DISABLED when explicitly disabled', async () => {
  const server = createServer({ points: createPointsService({ config: null }), operatorWallets: [TEST_OWNER],
    auth: { authenticate: async () => TEST_OWNER, issueNonce: () => { throw new Error('unexpected'); },
      login: async () => { throw new Error('unexpected'); }, logout: async () => {} } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    for (const [path, method] of [['/points/me', 'GET'], ['/points/history', 'GET'], ['/points/leaderboard', 'GET'], ['/points/tasks', 'GET'],
      ['/invites/me', 'GET'], ['/invites/bind', 'POST'], ['/operator/points/freeze', 'POST'], ['/operator/points/sync', 'POST'], ['/operator/points/metrics', 'GET']]) {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method, ...(method === 'POST' ? { body: '{}' } : {}) });
      assert.equal(response.status, 503); const body: unknown = await response.json();
      assert.ok(body && typeof body === 'object'); const error: unknown = Reflect.get(body, 'error'); assert.ok(error && typeof error === 'object');
      assert.equal(Reflect.get(error, 'code'), 'POINTS_DISABLED');
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
