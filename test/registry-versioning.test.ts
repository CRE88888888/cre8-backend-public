import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { test } from 'node:test';
import { createPublicClient, createWalletClient, custom, decodeFunctionData, encodeErrorResult, encodeFunctionResult, http, parseAbi, toFunctionSelector, zeroHash } from 'viem';
import { toAccount } from 'viem/accounts';
import { kernelAddressesForChain } from '../src/addresses.js';
import { getStrategyWithVersionState, typedVersionInput } from '../src/strategies.js';
import { REGISTRY_ABI, REGISTRY_VERSION_ABI, readOwnerEnrollment } from '../src/chain.js';
import { defaultPublicationActiveAt, enrollmentApprovalHash, FIRST_VERSION_LEAD_SECONDS, FOLLOW_VERSIONS_TERMS, performanceFee, p11Error, prepareEnrollmentApproval, readBuyVersionWindow, readVersionState, registryConfigHash, typedVersionSettings } from '../src/registry-versioning.js';
import type { Address, Hex } from 'viem';
import { AppError } from '../src/errors.js';
import golden from './fixtures/p11-config-golden.json' with { type: 'json' };
import { createServer } from '../src/server.js';
import { UnauthorizedError } from '../src/errors.js';
import { RequestRateLimiter, MemoryRateLimitStore } from '../src/ratelimit.js';
import { loadRateLimitConfig } from '../src/config.js';

test('#124 registry exposes only expected-version enroll and account consent', () => {
  const enroll = REGISTRY_ABI.filter(item => item.type === 'function' && item.name === 'enroll');
  assert.equal(enroll.length, 1);
  assert.ok(enroll[0]);
  assert.equal(toFunctionSelector(enroll[0]), toFunctionSelector('enroll(address,uint256,uint16)'));
  const functions = REGISTRY_ABI.filter(item => item.type === 'function').map(item => toFunctionSelector(item));
  for (const signature of ['approveEnrollment(uint256,uint16)', 'cancelVersion(uint256)']) {
    assert.ok(functions.includes(toFunctionSelector(signature)));
  }
});

const asset: Address = '0x0000000000000000000000000000000000000001';
const account: Address = '0x0000000000000000000000000000000000000002';
const config = { chainId: 97, allocation: { assets: [{ address: asset, weightBps: 10000 }] }, execution: { kind: 'hold' as const }, schedule: { kind: 'funding' as const }, activeAt: new Date(0) };

test('#124 structured contract rejections are safe; RPC messages never become public errors', () => {
  for (const data of [encodeErrorResult({ abi: REGISTRY_ABI, errorName: 'ConsentRequired' }),
    encodeErrorResult({ abi: REGISTRY_ABI, errorName: 'UnexpectedVersion', args: [1, 2] }),
    encodeErrorResult({ abi: REGISTRY_ABI, errorName: 'PublicationTooSoon', args: [604800n] }),
    encodeErrorResult({ abi: REGISTRY_ABI, errorName: 'StrategyAssetLimitExceeded', args: [129n] }),
    encodeErrorResult({ abi: REGISTRY_ABI, errorName: 'ActivationTooSoon', args: [86400n] })]) {
    const error = p11Error(new Error('private RPC token', { cause: { data } }));
    assert.equal(error?.status, 409); assert.ok(!error?.message.includes('private'));
  }
  assert.equal(p11Error(new Error('private RPC token')), null);
  assert.equal(p11Error({ data: '0xdeadbeef' }), null);
});

test('#124 independent cast abi-encode / keccak goldens match Solidity full settings encoding', () => {
  for (const vector of golden) {
    const addresses = vector.assets.map(value => { assert.match(value, /^0x[0-9a-f]{40}$/); return value as Address; });
    assert.equal(registryConfigHash(addresses, vector.weights, { scheduleHash: vector.scheduleHash as Hex,
      settingsHash: vector.settingsHash as Hex, performanceFeeBps: vector.performanceFeeBps }), vector.configHash);
    assert.notEqual(registryConfigHash([...addresses].reverse(), vector.weights, { scheduleHash: vector.scheduleHash as Hex,
      settingsHash: vector.settingsHash as Hex, performanceFeeBps: vector.performanceFeeBps }), vector.configHash);
  }
});

test('#124 canonical settings bind all execution parameters but fee/time are separate; fees enforce both inclusive bounds', () => {
  const settings = typedVersionSettings(config, 500);
  assert.deepEqual(typedVersionSettings({ ...config, activeAt: new Date(86400000) }), settings);
  const hash = registryConfigHash([asset], [10000], settings);
  assert.notEqual(registryConfigHash([asset], [10000], { ...settings, performanceFeeBps: 501 }), hash);
  assert.notEqual(registryConfigHash([asset], [10000], { ...settings, settingsHash: zeroHash }), hash);
  assert.notEqual(registryConfigHash([asset], [10000], { ...settings, scheduleHash: zeroHash }), hash);
  assert.notEqual(typedVersionSettings({ ...config, execution: { kind: 'stack' } }).settingsHash, settings.settingsHash);
  for (const fee of [500, 2000]) assert.equal(performanceFee(fee), fee);
  for (const fee of [0, 499, 2001, 500.5, null, '500']) assert.throws(() => performanceFee(fee));
  assert.notEqual(enrollmentApprovalHash(1n, 1, hash), enrollmentApprovalHash(1n, 2, hash));
  assert.notEqual(enrollmentApprovalHash(1n, 1, hash), enrollmentApprovalHash(2n, 1, hash));
});

function stateRpc() {
  const state = { active: 1, pending: 2, cancelled: false, now: 100n, activeAt: 101n, fail: '', reorg: false, allowLatest: false, enrolled: true, id: 7n, accepted: 1, paused: false, autoActivate: false };
  const reads: string[] = [];
  let blocks = 0;
  const client = createPublicClient({ transport: custom({ request: async ({ method, params }) => {
    if (state.fail === method) throw new Error('private upstream credential');
    if (state.fail === 'timeout') throw new DOMException('private upstream credential', 'TimeoutError');
    if (state.fail === 'missing_block' && method === 'eth_getBlockByNumber') return { number: '0x64', hash: zeroHash, transactions: [] };
    if (state.fail === 'missing_hash' && method === 'eth_getBlockByNumber') return { number: '0x64', timestamp: '0x64', transactions: [] };
    if (state.fail === 'missing_number' && method === 'eth_getBlockByNumber') return { number: null, hash: zeroHash, timestamp: '0x64', transactions: [] };
    if (method === 'eth_chainId') return '0x38';
    if (method === 'eth_blockNumber') return '0x64';
    if (method === 'eth_getBlockByNumber') return { number: '0x64', hash: state.reorg && ++blocks > 1 ? FOLLOW_VERSIONS_TERMS : zeroHash, timestamp: `0x${state.now.toString(16)}`, transactions: [] };
    assert.equal(method, 'eth_call');
    if (state.fail === 'empty_call') return '0x';
    assert.ok(Array.isArray(params));
    const call: unknown = params[0]; assert.ok(typeof call === 'object' && call !== null);
    const data: unknown = Reflect.get(call, 'data'); assert.ok(typeof data === 'string' && data.startsWith('0x'));
    const decoded = decodeFunctionData({ abi: [...REGISTRY_VERSION_ABI, ...REGISTRY_ABI], data: data as Hex });
    reads.push(decoded.functionName); assert.ok(params[1] === '0x64' || state.allowLatest && params[1] === 'latest');
    switch (decoded.functionName) {
      case 'isEnrolled': return encodeFunctionResult({ abi: REGISTRY_ABI, functionName: 'isEnrolled', result: state.enrolled });
      case 'enrollments': return encodeFunctionResult({ abi: REGISTRY_ABI, functionName: 'enrollments', result: [state.id, state.accepted, state.paused] });
      case 'MAX_STRATEGY_ASSETS': return encodeFunctionResult({ abi: REGISTRY_VERSION_ABI, functionName: 'MAX_STRATEGY_ASSETS', result: 128n });
      case 'version': return encodeFunctionResult({ abi: REGISTRY_VERSION_ABI, functionName: 'version', result: { assets: [asset], weightsBps: [10000], scheduleHash: zeroHash, activeAt: state.activeAt, settingsHash: zeroHash, performanceFeeBps: 500, configHash: zeroHash } });
      case 'activeVersion': return encodeFunctionResult({ abi: REGISTRY_VERSION_ABI, functionName: 'activeVersion', result: state.autoActivate && state.pending !== 0 && state.now >= state.activeAt ? state.pending : state.active });
      case 'pendingVersion': return encodeFunctionResult({ abi: REGISTRY_VERSION_ABI, functionName: 'pendingVersion', result: state.autoActivate && state.now >= state.activeAt ? 0 : state.pending });
      case 'lastPublishedAt': return encodeFunctionResult({ abi: REGISTRY_VERSION_ABI, functionName: 'lastPublishedAt', result: 1n });
      case 'cancelledVersion': return encodeFunctionResult({ abi: REGISTRY_VERSION_ABI, functionName: 'cancelledVersion', result: state.cancelled });
      default: throw new Error('unexpected read');
    }
  } }, { retryCount: 0 }) });
  return { state, client, reads };
}

test('#143 first publication uses canonical chain time plus 60 seconds, including timestamp zero and the Date ceiling', async () => {
  assert.equal(FIRST_VERSION_LEAD_SECONDS, 60);
  for (const timestamp of [0n, 100n, 1_800_000_000n, 8_640_000_000_000n - 60n]) {
    const f = stateRpc(); f.state.active = 0; f.state.now = timestamp;
    const result = await defaultPublicationActiveAt(f.client, asset, 7, 500_999);
    assert.equal(BigInt(result.getTime() / 1000) - timestamp, 60n);
    assert.deepEqual(f.reads, ['activeVersion'], 'read effective state at the observed block, without consulting DB history');
  }
});

test('#143 existing effective versions keep the 24-hour wall-clock default, including uint16 maximum', async () => {
  for (const active of [1, 65535]) {
    const f = stateRpc(); f.state.active = active;
    assert.equal((await defaultPublicationActiveAt(f.client, asset, 7, 500_999)).getTime(), 86_960_000);
  }
});

test('#143 a just-matured first version requires notice for the next publication at and after activeAt', async () => {
  const f = stateRpc(); f.state.active = 0; f.state.pending = 1; f.state.activeAt = 160n; f.state.autoActivate = true;
  for (const [now, expected] of [[159n, 219_000], [160n, 86_960_000], [161n, 86_960_000]] as const) {
    f.state.now = now;
    assert.equal((await defaultPublicationActiveAt(f.client, asset, 7, 500_999)).getTime(), expected);
  }
});

for (const failure of ['eth_call', 'eth_getBlockByNumber', 'timeout', 'missing_block', 'missing_hash', 'missing_number', 'empty_call', 'reorg', 'overflow'] as const) {
  test(`#143 activation default fails closed and sanitizes ${failure}`, async () => {
    const f = stateRpc(); f.state.active = 0;
    if (failure === 'reorg') f.state.reorg = true;
    else if (failure === 'overflow') f.state.now = 8_640_000_000_000n - 59n;
    else f.state.fail = failure;
    await assert.rejects(defaultPublicationActiveAt(f.client, asset, 7), (error: unknown) =>
      error instanceof AppError && error.code === 'VERSION_PUBLICATION_UNAVAILABLE' && !error.message.includes('credential'));
  });
}

test('#143 activation reads have an actual bounded HTTP timeout', async () => {
  const server = httpServer(() => {});
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const bound = server.address(); assert.ok(bound && typeof bound !== 'string');
    const client = createPublicClient({ transport: http(`http://127.0.0.1:${bound.port}`, { timeout: 20, retryCount: 0 }) });
    await assert.rejects(defaultPublicationActiveAt(client, asset, 7), (error: unknown) =>
      error instanceof AppError && error.code === 'VERSION_PUBLICATION_UNAVAILABLE');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('#143 legacy HTTP normalization preserves omission/null and explicit activation timestamps', () => {
  const input = { allocation: { assets: [{ address: asset, weightBps: 10000 }] }, schedule: { kind: 'interval', intervalSeconds: 60 } };
  assert.equal(typedVersionInput(input).activeAt, undefined);
  assert.equal(typedVersionInput({ ...input, activeAt: null }).activeAt, null);
  const at = new Date('2026-11-17T00:01:00Z');
  assert.deepEqual(typedVersionInput({ ...input, activeAt: at.toISOString() }).activeAt, at);
});

test('#143 first version detail reports pending/active at the exact boundary with its minimum deposit intact', async () => {
  const f = stateRpc(); f.state.active = 0; f.state.pending = 1; f.state.activeAt = 160n; f.state.autoActivate = true;
  const detail = () => getStrategyWithVersionState(7, {
    strategy: async () => ({ id: 7, provider: account, name: 'First version', description: '', isPublic: true, swapFeeBps: 0, onchainId: 7, createdAt: new Date(0).toISOString(),
      versions: [{ strategyId: 7, version: 1, allocation: { assets: [{ address: asset, weightBps: 10000 }] }, schedule: { kind: 'funding' },
        executionSchemaVersion: 1, execution: { kind: 'hold' }, executionChainId: 97, configHash: zeroHash, idleYield: { enabled: false }, changeLog: null,
        activeAt: new Date(160_000).toISOString(), createdAt: new Date(0).toISOString() }] }),
    state: (id, version) => readVersionState(f.client, asset, id, version),
  });
  const server = createServer({ strategyDetail: detail });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const bound = server.address(); assert.ok(bound && typeof bound !== 'string');
    for (const [now, status] of [[159n, 'pending'], [160n, 'active'], [161n, 'active']] as const) {
      f.state.now = now;
      const response = await fetch(`http://127.0.0.1:${bound.port}/strategies/7`);
      assert.equal(response.status, 200);
      const body: unknown = await response.json(); assert.ok(typeof body === 'object' && body !== null && 'versions' in body && 'minDepositUsdtWei' in body);
      assert.equal(body.minDepositUsdtWei, '50000000000000000000'); assert.ok(Array.isArray(body.versions));
      assert.equal(body.versions[0]?.status, status);
      assert.equal(body.versions[0]?.activeAt, new Date(160_000).toISOString());
      assert.equal(body.versions[0]?.minDepositUsdtWei, body.minDepositUsdtWei);
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('#124 consent preparation is read-only, pins the effective version and returns only owner sudo calldata', async () => {
  const f = stateRpc();
  const result = await prepareEnrollmentApproval(f.client, asset, account, 7);
  assert.equal(result.expectedVersion, 1); assert.equal(result.signingMode, 'sudo'); assert.equal(result.termsHash, FOLLOW_VERSIONS_TERMS);
  assert.deepEqual(decodeFunctionData({ abi: REGISTRY_ABI, data: result.call.data }), { functionName: 'approveEnrollment', args: [7n, 1] });
  f.state.active = 0;
  await assert.rejects(prepareEnrollmentApproval(f.client, asset, account, 7), (error: unknown) => error instanceof AppError && error.code === 'VERSION_NOT_ACTIVE');
  f.state.fail = 'eth_call';
  await assert.rejects(prepareEnrollmentApproval(f.client, asset, account, 7), (error: unknown) => error instanceof AppError && error.code === 'ENROLLMENT_APPROVAL_UNAVAILABLE' && !error.message.includes('credential'));
  const reorg = stateRpc(); reorg.state.reorg = true;
  await assert.rejects(prepareEnrollmentApproval(reorg.client, asset, account, 7));
});

test('#124 direct enrollment preparation binds sender, strategy and uint16 expected version', async () => {
  const f = stateRpc(); f.state.active = 65535;
  const prepared = await prepareEnrollmentApproval(f.client, asset, account, 7, true);
  assert.deepEqual(decodeFunctionData({ abi: REGISTRY_ABI, data: prepared.call.data }), { functionName: 'enroll', args: [account, 7n, 65535] });
  assert.equal(prepared.signingMode, 'sudo');
});

test('#124 owner enrollment confirmation is read-only and rejects missing, foreign, paused, reorg and RPC state', async () => {
  for (const scenario of ['ok', 'missing', 'id', 'version', 'paused', 'reorg', 'rpc']) {
    const f = stateRpc();
    if (scenario === 'missing') f.state.enrolled = false;
    if (scenario === 'id') f.state.id = 8n;
    if (scenario === 'version') f.state.accepted = 0;
    if (scenario === 'paused') f.state.paused = true;
    if (scenario === 'reorg') f.state.reorg = true;
    if (scenario === 'rpc') f.state.fail = 'eth_call';
    const signer = toAccount(account);
    const wallet = createWalletClient({ account: signer, transport: custom({ request: async () => { throw new Error('must not write'); } }) });
    const chain = { chainId: 56, rpcUrl: 'http://127.0.0.1:8597', registryAddress: asset, account: signer, publicClient: f.client, wallet, kernel: kernelAddressesForChain(56) };
    if (scenario === 'ok') assert.equal(await readOwnerEnrollment(account, 7, chain), 1);
    else await assert.rejects(readOwnerEnrollment(account, 7, chain), (error: unknown) => error instanceof AppError && !error.message.includes('credential'));
  }
});

test('#124 public strategy detail combines execution metadata with chain-authoritative assets and pending state', async () => {
  const f = stateRpc();
  const detail = await getStrategyWithVersionState(7, {
    strategy: async () => ({ id: 7, provider: account, name: 'P11', description: '', isPublic: true, swapFeeBps: 0, onchainId: 7, createdAt: new Date(0).toISOString(),
      versions: [{ strategyId: 7, version: 2, allocation: { assets: [{ address: account, weightBps: 10000 }] }, schedule: { kind: 'interval', intervalSeconds: 60 },
        executionSchemaVersion: 0, execution: { kind: 'target_weight' }, executionChainId: null, configHash: null, idleYield: { enabled: false }, changeLog: null, activeAt: null, createdAt: new Date(0).toISOString() }] }),
    state: (id, version) => readVersionState(f.client, asset, id, version),
  });
  const version = detail.versions[0]; assert.ok(version);
  assert.equal(version.status, 'pending'); assert.equal(version.canCancel, false);
  assert.equal(version.allocation.assets[0]?.address, asset); assert.equal(version.execution.kind, 'target_weight');
  assert.equal('performanceFeeBps' in version && version.performanceFeeBps, 500);
  f.state.fail = 'eth_call';
  await assert.rejects(getStrategyWithVersionState(7, { strategy: async () => detail, state: (id, v) => readVersionState(f.client, asset, id, v) }));
});

test('#124 activation boundary and history are explicit while API cancellation stays disabled; reorg/RPC fail closed', async () => {
  const f = stateRpc();
  assert.equal((await readVersionState(f.client, asset, 7, 2)).canCancel, false);
  f.state.now = f.state.activeAt; f.state.pending = 0; f.state.active = 2;
  assert.equal((await readVersionState(f.client, asset, 7, 2)).canCancel, false);
  assert.equal((await readVersionState(f.client, asset, 7, 2)).status, 'active');
  assert.equal((await readVersionState(f.client, asset, 7, 1)).status, 'historical');
  f.state.cancelled = true;
  assert.equal((await readVersionState(f.client, asset, 7, 2)).status, 'cancelled');
  f.state.reorg = true;
  await assert.rejects(readVersionState(f.client, asset, 7, 2));
  f.state.fail = 'eth_call';
  await assert.rejects(readVersionState(f.client, asset, 7, 2), (error: unknown) => error instanceof AppError && !error.message.includes('credential'));
});

test('#124 cancellation API is absent for anonymous and authenticated requests and never reads chain state', async () => {
  let calls = 0;
  const server = createServer({ strategyVersionState: async () => { calls++; throw new Error('must not read chain'); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    for (const method of ['GET', 'POST', 'DELETE']) {
      for (const authorization of ['', 'Bearer invalid']) {
        const response = await fetch(`http://127.0.0.1:${address.port}/strategies/7/versions/cancel`, { method, headers: { authorization } });
        assert.equal(response.status, 404);
      }
    }
    assert.equal(calls, 0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('#124 version and consent routes authenticate before parsing and forward the session owner', async () => {
  let authenticated = false;
  const calls: unknown[][] = [];
  const f = stateRpc();
  const server = createServer({ rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore()),
    auth: { authenticate: async () => { if (!authenticated) throw new UnauthorizedError(); return account; },
    issueNonce: () => { throw new Error('unused'); }, login: async () => { throw new Error('unused'); }, logout: async () => {} },
    enrollPortfolio: async (id, wallet) => { calls.push(['confirm', id, wallet]); throw new AppError(409, 'ENROLLMENT_NOT_CONFIRMED', 'owner enrollment missing'); },
    preparePortfolioEnrollment: async (id, wallet) => { calls.push(['consent', id, wallet]); return prepareEnrollmentApproval(f.client, asset, account, id); },
    strategyVersionState: async (id, version) => { calls.push(['state', id, version]); return readVersionState(f.client, asset, id, version); },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    for (const path of ['/portfolios/enrollment-confirm', '/portfolios/enrollment-params']) {
      assert.equal((await fetch(base + path, { method: 'POST', body: 'invalid' })).status, 401);
    }
    assert.equal((await fetch(base + '/strategies/7/versions/2')).status, 401);
    assert.equal(calls.length, 0);
    authenticated = true;
    assert.equal((await fetch(base + '/portfolios/enrollment-params', { method: 'POST', body: '{}' })).status, 400);
    const consent = await fetch(base + '/portfolios/enrollment-params', { method: 'POST', body: JSON.stringify({ strategyId: 7 }) });
    assert.equal(consent.status, 200);
    const state = await fetch(base + '/strategies/7/versions/2'); assert.equal(state.status, 200);
    const body: unknown = await state.json(); assert.ok(typeof body === 'object' && body !== null && 'canCancel' in body);
    assert.equal(body.canCancel, false);
    assert.equal((await fetch(base + '/strategies/7/versions/cancel', { method: 'POST' })).status, 404);
    assert.deepEqual(calls, [['consent', 7, account], ['state', 7, 2]]);
    const previousChain = process.env.CHAIN_ID;
    try {
      process.env.CHAIN_ID = '97';
      assert.equal((await fetch(base + '/portfolios', { method: 'POST', body: JSON.stringify({ strategyId: 7 }) })).status, 200);
      assert.equal((await fetch(base + '/portfolios/enrollment-confirm', { method: 'POST', body: JSON.stringify({ strategyId: 7 }) })).status, 409);
      assert.deepEqual(calls.slice(-2), [['consent', 7, account], ['confirm', 7, account]]);
    } finally {
      if (previousChain === undefined) delete process.env.CHAIN_ID; else process.env.CHAIN_ID = previousChain;
    }
    assert.equal((await fetch(base + '/portfolios/enrollment-params')).status, 405);
    assert.equal((await fetch(base + '/strategies/7/versions/2', { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/strategies/7/versions/65536')).status, 400);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('#124 Version tuple contains all seven contract fields in ABI order', () => {
  const expected = parseAbi(['function version(uint256,uint16) view returns ((address[] assets,uint16[] weightsBps,bytes32 scheduleHash,uint64 activeAt,bytes32 settingsHash,uint16 performanceFeeBps,bytes32 configHash))']);
  const version = REGISTRY_VERSION_ABI.find(item => item.name === 'version');
  assert.deepEqual(version?.outputs, expected[0].outputs);
});

test('#124 twenty deployment polls do not exhaust confirmation; prepare and confirm have independent minute budgets',async()=>{
  const previousChain=process.env.CHAIN_ID;process.env.CHAIN_ID='97';
  let confirms=0,prepares=0,now=1000;
  const server=createServer({
    rateLimiter:new RequestRateLimiter(loadRateLimitConfig({}),new MemoryRateLimitStore(),()=>now),
    auth:{authenticate:async()=>account,issueNonce:()=>{throw new Error('unused');},login:async()=>{throw new Error('unused');},logout:async()=>{}},
    preparePortfolioEnrollment:async()=>{prepares++;throw new AppError(202,'ACCOUNT_DEPLOYMENT_PENDING','pending');},
    enrollPortfolio:async()=>{confirms++;return {id:1,userId:account,strategyId:7,strategyName:'P11',version:1,scheduleState:'active',
      createdAt:new Date(0).toISOString(),smartAccounts:[],gas:null,minDepositUsdtWei:'0'};},
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const addr=server.address();assert.ok(addr&&typeof addr!=='string');
    const post=(route:string)=>fetch(`http://127.0.0.1:${addr.port}/portfolios/${route}`,{method:'POST',body:JSON.stringify({strategyId:7})});
    for(let i=0;i<20;i++)assert.equal((await post('enrollment-params')).status,202);
    assert.equal((await post('enrollment-confirm')).status,200);assert.equal(confirms,1);
    for(let i=20;i<30;i++)assert.equal((await post('enrollment-params')).status,202);
    assert.equal((await post('enrollment-params')).status,429);assert.equal(prepares,30);
    for(let i=1;i<30;i++)assert.equal((await post('enrollment-confirm')).status,200);
    assert.equal((await post('enrollment-confirm')).status,429);assert.equal(confirms,30);
    now=60000;assert.equal((await post('enrollment-params')).status,202);
    assert.equal((await post('enrollment-confirm')).status,200);
  }finally{
    if(previousChain===undefined)delete process.env.CHAIN_ID;else process.env.CHAIN_ID=previousChain;
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});

for (const activeVersion of [1, 65535]) {
  test(`#124 fresh buy version ${activeVersion} has no pending deadline when pending is zero`, async () => {
    const f = stateRpc(); f.state.active = activeVersion; f.state.pending = 0;
    assert.deepEqual(await readBuyVersionWindow(f.client, asset, 7n), { activeVersion, timestamp: 100n, pendingActiveAt: null });
    assert.deepEqual(f.reads.sort(), ['activeVersion', 'pendingVersion']);
  });
}

test('#124 fresh buy version reads pending time at the identical canonical block', async () => {
  const f = stateRpc(); f.state.activeAt = 1000n;
  assert.deepEqual(await readBuyVersionWindow(f.client, asset, 7n), { activeVersion: 1, timestamp: 100n, pendingActiveAt: 1000n });
  assert.deepEqual(f.reads.sort(), ['activeVersion', 'pendingVersion', 'version']);
});

for (const failure of ['block', 'rpc', 'timeout', 'missing-block', 'reorg', 'zero', 'elapsed', 'equal', 'invalid-pending', 'missing'] as const) {
  test(`#124 fresh buy evidence fails closed and masks ${failure}`, async () => {
    const f = stateRpc();
    if (failure === 'block') f.state.fail = 'eth_getBlockByNumber';
    if (failure === 'rpc') f.state.fail = 'eth_call';
    if (failure === 'timeout') f.state.fail = 'timeout';
    if (failure === 'missing-block') f.state.fail = 'missing_block';
    if (failure === 'reorg') f.state.reorg = true;
    if (failure === 'zero') f.state.active = 0;
    if (failure === 'elapsed') f.state.activeAt = 99n;
    if (failure === 'equal') f.state.activeAt = 100n;
    if (failure === 'invalid-pending') f.state.pending = 1;
    if (failure === 'missing') f.state.fail = 'empty_call';
    await assert.rejects(readBuyVersionWindow(f.client, asset, 7n), (error: unknown) =>
      error instanceof AppError && error.code === 'VERSION_STATE_UNAVAILABLE' && !error.message.includes('credential'));
  });
}
