import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from '../src/server.js';
import { AppError, UnauthorizedError } from '../src/errors.js';
import { ConfigurationError, loadPointsConfig } from '../src/config.js';
import { bindInvite, createPointsService, freezePoints, pointsHistory, pointsLeaderboard, pointsMetrics, receiptOperations, scanPoints } from '../src/points.js';
import { TESTNET_97 } from '../src/testnet-profile.js';
import { ACCOUNT, OWNER, OCCURRED, address, catalog, config, enrolled, hash, jsonObject, operation, reader, receipt, registered, swapped, transfer } from './fixtures/points.js';

test('My mix StrategyRegistered never awards create_fund while public funds still do', () => {
  const known = catalog();
  known.strategies.set('1', { owner: OWNER, name: 'Test fund', personalMix: true });
  assert.deepEqual(receiptOperations(receipt([registered()]), config(), known), []);
  known.strategies.set('1', { owner: OWNER, name: 'Test fund', personalMix: false });
  assert.equal(receiptOperations(receipt([registered()]), config(), known)[0]?.kind, 'create_fund');
});
import { loadRateLimitConfig } from '../src/config.js';
import { RequestRateLimiter } from '../src/ratelimit.js';
import { createServer as createHttpServer } from 'node:http';
import { encodeAbiParameters, toHex, zeroAddress } from 'viem';
import { KERNEL_V3_3_ADDRESSES } from '../src/addresses.js';

const chainFailure = (error: unknown) => error instanceof AppError && error.code === 'POINTS_CHAIN_UNAVAILABLE' && !error.message.includes('secret');
test('#67 points config: opt-in, test chains, required full-history block, zero boundaries and sanitized errors', () => {
  assert.equal(loadPointsConfig({}), null);
  assert.equal(loadPointsConfig({ POINTS_ENABLED: '0', POINTS_DEPOSIT: 'invalid' }), null);
  const env = { POINTS_ENABLED: '1', CHAIN_ID: '1337', RPC_URL: config().rpcUrl, REGISTRY_ADDRESS: config().registry,
    EXECUTOR_ADDRESS: config().executor, PAYMASTER_MOCK_USDT_ADDRESS: config().token, POINTS_FROM_BLOCK: '0' };
  const c = loadPointsConfig(env); assert.ok(c);
  assert.equal(c.delaySeconds, 86400); assert.equal(c.confirmations, 12n);
  assert.equal(loadPointsConfig({ ...env, POINTS_DEPOSIT: '0', POINTS_DEPOSIT_DAILY_COUNT: '0', POINTS_DELAY_SECONDS: '0' })?.rules.deposit.points, 0n);
  assert.equal(loadPointsConfig({ ...env, POINTS_DEPOSIT: '9007199254740993' })?.rules.deposit.points, 9007199254740993n);
  const testnet = loadPointsConfig({ POINTS_ENABLED: '1', CHAIN_ID: '97', RPC_URL: config().rpcUrl, POINTS_FROM_BLOCK: '0' });
  assert.equal(testnet?.registry, TESTNET_97.contracts.registry);
  assert.equal(testnet?.token, TESTNET_97.contracts.usdt);
  assert.equal(loadPointsConfig({ ...env, CHAIN_ID: '31337' })?.chainId, 31337);
  for (const entry of [ { POINTS_ENABLED: 'true' }, { CHAIN_ID: '56' }, { POINTS_FROM_BLOCK: '' }, { RPC_URL: '' },
    { RPC_URL: 'secret' }, { RPC_URL: 'file:///secret' },
    { REGISTRY_ADDRESS: address(0).replace(/./g, 'x') }, { REGISTRY_ADDRESS: zeroAddress }, { POINTS_CONFIRMATIONS: '0' }, { POINTS_DELAY_SECONDS: '-1' },
    { POINTS_TIMEOUT_MS: '0' }, { POINTS_DEPOSIT: 'secret' }, { POINTS_DEPOSIT_DAILY_COUNT: '1.5' }, { POINTS_FROM_BLOCK: '-1' } ]) {
    assert.throws(() => loadPointsConfig({ ...env, ...entry }), (e: unknown) => e instanceof ConfigurationError && !e.message.includes('secret'));
  }
});

test('#67 invalid bind, freeze and paging inputs fail before touching storage', async () => {
  const bad = (error: unknown) => error instanceof AppError && error.code === 'POINTS_INVALID_REQUEST';
  for (const input of [null, [], {}, { code: 'short' }, { code: 'a'.repeat(65) }, { code: 'abcdefgh', owner: OWNER }]) {
    await assert.rejects(bindInvite(input, OWNER, config()), bad);
  }
  for (const input of [{}, { owner: OWNER, frozen: 1 }, { owner: zeroAddress, frozen: false },
    { owner: OWNER, frozen: true }, { owner: OWNER, frozen: true, reason: 'x'.repeat(501) },
    { owner: OWNER, frozen: false, unexpected: true }]) await assert.rejects(freezePoints(input, OWNER, config()), bad);
  for (const params of [{ limit: '0' }, { limit: '101' }, { limit: '1.0' }, { before: 'invalid' }, { owner: OWNER }]) {
    await assert.rejects(pointsHistory(OWNER, params), bad);
  }
  for (const params of [{ score: '1' }, { owner: OWNER }, { score: 'NaN', owner: OWNER }, { limit: '101' }]) {
    await assert.rejects(pointsLeaderboard(params), bad);
  }
});

test('#67 confirmed business classification: enroll, cash movement, executed swaps and fund ownership mapping', () => {
  for (const [log, kind] of [[enrolled(), 'enroll'], [transfer(), 'deposit'], [transfer(ACCOUNT, OWNER), 'withdraw'], [swapped(), 'rebalance'], [registered(), 'create_fund']] as const) {
    const result = receiptOperations(receipt([log]), config(), catalog());
    assert.equal(result.length, 1); assert.equal(result[0]?.kind, kind); assert.equal(result[0]?.owner, OWNER);
  }
  assert.equal(receiptOperations(receipt([swapped(0), swapped(1)]), config(), catalog()).length, 1);
  assert.equal(receiptOperations(receipt([transfer(ACCOUNT, OWNER, 1n, 0), transfer(ACCOUNT, OWNER, 2n, 1)]), config(), catalog()).length, 1);
  const excluded = [transfer(zeroAddress, ACCOUNT), transfer(OWNER, ACCOUNT, 0n), transfer(address(999), ACCOUNT),
    transfer(ACCOUNT, address(999)), transfer(ACCOUNT, address(102)), { ...transfer(), address: address(999) }];
  for (const log of excluded) assert.equal(receiptOperations(receipt([log]), config(), catalog()).length, 0);
  assert.deepEqual(receiptOperations({ ...receipt([swapped()]), status: 'reverted' }, config(), catalog()), []);
  const missing = catalog(); missing.accounts.clear(); missing.strategies.clear();
  assert.deepEqual(receiptOperations(receipt([enrolled(), transfer(), registered()]), config(), missing), []);
});

test('#67 scan verifies confirmation equality, canonical receipts and historical controlling owner, including block zero', async () => {
  assert.equal((await scanPoints(config(), catalog(), reader())).operations.length, 1);
  assert.equal((await scanPoints({ ...config(), confirmations: 4n }, catalog(), reader({ logs: async () => [] }))).operations.length, 0);
  assert.equal((await scanPoints({ ...config(), fromBlock: 11n }, catalog(), reader())).timestamp, null);
  const log = { ...transfer(), blockNumber: 0n };
  const result = await scanPoints({ ...config(), confirmations: 1n }, catalog(), reader({ head: async () => 0n, logs: async () => [log], receipt: async () => ({ ...receipt([log]), blockNumber: 0n }) }));
  assert.equal(result.operations.length, 1); assert.equal(result.operations[0]?.occurredAt.toISOString(), OCCURRED.toISOString());
  const actual = await reader().owner(ACCOUNT, 10n);
  for (const changed of [{ ...actual, owner: address(99) }, { ...actual, owner: zeroAddress }, { ...actual, root: '0x01' + address(999).slice(2) }]) {
    assert.equal((await scanPoints(config(), catalog(), reader({ owner: async () => changed }))).operations.length, 0);
  }
  let ranges = 0;
  await scanPoints({ ...config(), fromBlock: 0n, confirmations: 1n }, catalog(), reader({ head: async () => 2000n, logs: async (from, to) => { ranges++; assert.ok(to - from < 1000n); return []; } }));
  assert.equal(ranges, 3);
});

test('#67 RPC failures, timeouts, missing receipts, insufficient confirmations and reorg never become valid operations', async () => {
  for (const overrides of [
    { chainId: async () => 56 }, { head: async () => { throw new Error('secret'); } },
    { receipt: async () => null }, { receipt: async () => ({ ...receipt(), blockNumber: 11n }) },
    { receipt: async () => ({ ...receipt(), blockHash: hash(5) }) }, { logs: async () => [{ ...transfer(), removed: true }] },
    { logs: async () => [{ ...transfer(), blockHash: null }] }, { owner: async () => { throw new Error('secret'); } },
    { receipt: async () => ({ ...receipt(), transactionHash: hash(5) }) },
  ]) await assert.rejects(scanPoints(config(), catalog(), reader(overrides)), chainFailure);
  await assert.rejects(scanPoints({ ...config(), timeoutMs: 10 }, catalog(), reader({ receipt: async () => new Promise(() => {}) })), chainFailure);
  let blocks = 0;
  await assert.rejects(scanPoints(config(), catalog(), reader({ block: async () => ({ hash: ++blocks > 2 ? hash(8) : receipt().blockHash, timestamp: BigInt(OCCURRED.getTime() / 1000) }) })), chainFailure);
});

test('#67 same-block operations follow global log order instead of transaction hash lexical order', async () => {
  const earlier = { ...transfer(OWNER, ACCOUNT, 1n, 2), transactionHash: `0x${'ff'.repeat(32)}` as const };
  const later = { ...transfer(OWNER, ACCOUNT, 1n, 3), transactionHash: `0x${'01'.repeat(32)}` as const };
  const result = await scanPoints(config(), catalog(), reader({ logs: async () => [later, earlier],
    receipt: async (txHash) => ({ ...receipt([txHash === earlier.transactionHash ? earlier : later]), transactionHash: txHash }) }));
  assert.deepEqual(result.operations.map((op) => op.logIndex), [2, 3]);
});

test('#67 candidate logs and canonical receipts must agree on their block', async () => {
  const moved = { ...transfer(), blockNumber: 11n };
  await assert.rejects(scanPoints(config(), catalog(), reader({ head: async () => 15n,
    receipt: async () => ({ ...receipt([moved]), blockNumber: 11n }) })), chainFailure);
});

test('#67 metrics count uncapped unique chain operations and exact mature UTC D1/D7 cohorts', () => {
  const at = (id: number, days: number, owner = OWNER) => ({ ...operation(id, owner), occurredAt: new Date(OCCURRED.getTime() + days * 86400000) });
  const metrics = pointsMetrics([at(1, 0), at(1, 0), at(2, 1), at(3, 7), at(4, 7, address(2)), at(5, 0, address(3))], at(6, 7).occurredAt);
  assert.equal(metrics.successfulOperations, 5); assert.equal(metrics.uniqueOwners, 3);
  assert.deepEqual(metrics.d1, { eligible: 2, returned: 1, rate: 0.5 });
  assert.deepEqual(metrics.d7, { eligible: 2, returned: 1, rate: 0.5 });
  assert.deepEqual(pointsMetrics([], OCCURRED).d1, { eligible: 0, returned: 0, rate: null });
});

test('#67 routes enforce login/operator permissions before reading bodies; administration never enables chain execution', async () => {
  let authenticated = false; let wallet = OWNER; let calls = 0;
  const service = createPointsService({ config: null });
  const server = createServer({ operatorWallets: [OWNER], operatorRebalanceEnabled: () => false,
    auth: { authenticate: async () => { if (!authenticated) throw new UnauthorizedError(); return wallet; },
      issueNonce: () => { throw new Error('unexpected'); }, login: async () => { throw new Error('unexpected'); }, logout: async () => {} },
    points: { ...service, freeze: async (_input, operator) => { assert.equal(operator, OWNER); calls++; return {}; }, sync: async () => { calls++; return { throughBlock: '10', operations: 0, capped: 0 }; } },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const listening = server.address(); assert.ok(listening && typeof listening !== 'string');
  const base = 'http://127.0.0.1:' + listening.port;
  try {
    for (const [path, method] of [['/points/me', 'GET'], ['/points/history', 'GET'], ['/points/leaderboard', 'GET'], ['/points/tasks', 'GET'],
      ['/invites/me', 'GET'], ['/invites/bind', 'POST'], ['/operator/points/freeze', 'POST'], ['/operator/points/sync', 'POST'], ['/operator/points/metrics', 'GET']]) {
      assert.equal((await fetch(base + path, { method, ...(method === 'POST' ? { body: 'invalid' } : {}) })).status, 401);
    }
    authenticated = true; wallet = address(2);
    assert.equal((await fetch(base + '/operator/points/freeze', { method: 'POST', body: 'invalid' })).status, 403);
    wallet = OWNER;
    assert.equal((await fetch(base + '/operator/points/freeze', { method: 'POST', body: '{}' })).status, 200);
    assert.equal((await fetch(base + '/operator/points/sync', { method: 'POST' })).status, 200);
    assert.equal(calls, 2);
    const disabled = await fetch(base + '/points/me'); assert.equal(disabled.status, 503);
    assert.equal(jsonObject(jsonObject(await disabled.json()).error).code, 'POINTS_DISABLED');
    const method = await fetch(base + '/invites/bind'); assert.equal(method.status, 405); assert.equal(method.headers.get('allow'), 'POST');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('#67 task rules are public score snapshots and the shared wallet request budget applies', async () => {
  const service = createPointsService({ config: config() });
  const server = createServer({ points: service,
    rateLimiter: new RequestRateLimiter(loadRateLimitConfig({ RATE_LIMIT_PLAN_PER_MINUTE: '1' })),
    auth: { authenticate: async () => OWNER, issueNonce: () => { throw new Error('unexpected'); }, login: async () => { throw new Error('unexpected'); }, logout: async () => {} } });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const listening = server.address(); assert.ok(listening && typeof listening !== 'string'); const base = 'http://127.0.0.1:' + listening.port;
  try {
    const response = await fetch(base + '/points/tasks'); assert.equal(response.status, 200);
    const tasks = jsonObject(await response.json()).tasks; assert.ok(Array.isArray(tasks));
    assert.deepEqual(tasks[1], { kind: 'deposit', points: '10', dailyCount: '10', dailyPoints: '100' });
    assert.equal((await fetch(base + '/points/tasks')).status, 429);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('#67 production viem reader uses real JSON-RPC formatting and historical owner calls; RPC errors/null/timeout are sanitized', async () => {
  let fault = '';
  const ownerBlocks: unknown[] = [];
  const wireLog = { ...transfer(), blockNumber: '0xa', logIndex: '0x0', transactionIndex: '0x0' };
  const server = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = jsonObject(JSON.parse(Buffer.concat(chunks).toString()));
    const params = request.params ?? []; assert.ok(Array.isArray(params));
    if (fault === 'timeout') return;
    if (fault === 'rpc') { res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'secret RPC credentials' } })); return; }
    let result: unknown;
    if (request.method === 'eth_chainId') result = '0x539';
    else if (request.method === 'eth_blockNumber') result = '0xc';
    else if (request.method === 'eth_getBlockByNumber') result = { hash: receipt().blockHash, number: '0xa', timestamp: toHex(BigInt(OCCURRED.getTime() / 1000)), transactions: [] };
    else if (request.method === 'eth_getLogs') result = [wireLog];
    else if (request.method === 'eth_getTransactionReceipt') result = fault === 'missing' ? null : { ...receipt(), type: '0x0', status: '0x1', blockNumber: '0xa', transactionIndex: '0x0', logs: [wireLog] };
    else if (request.method === 'eth_call') {
      ownerBlocks.push(params[1]); const call = jsonObject(params[0]);
      result = call.to === ACCOUNT
        ? encodeAbiParameters([{ type: 'bytes21' }], [`0x01${KERNEL_V3_3_ADDRESSES.ecdsaValidatorV31.slice(2)}`])
        : encodeAbiParameters([{ type: 'address' }], [OWNER]);
    } else throw new Error('unexpected RPC method');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }, (_key, value: unknown) => typeof value === 'bigint' ? toHex(value) : value));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const info = server.address(); assert.ok(info && typeof info !== 'string');
  const conf = { ...config(), rpcUrl: 'http://127.0.0.1:' + info.port, timeoutMs: 200 };
  try {
    const service = createPointsService({ config: conf, catalog: async () => catalog() });
    assert.equal((await service.metrics()).successfulOperations, 1);
    assert.deepEqual(ownerBlocks, ['0xa', '0xa']);
    for (const failure of ['rpc', 'missing', 'timeout']) {
      fault = failure;
      await assert.rejects(createPointsService({ config: { ...conf, timeoutMs: 20 }, catalog: async () => catalog() }).metrics(), chainFailure);
    }
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
