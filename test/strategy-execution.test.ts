import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer as httpServer } from 'node:http';
import { createPublicClient, createWalletClient, custom, decodeFunctionData, encodeFunctionData, formatUnits, http } from 'viem';
import { toAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import golden from './fixtures/strategy-config-golden.json' with { type: 'json' };
import { canonicalConfig, canonicalConfigHash, defaultAmountUsdt, minimumAllocationRaw, UINT256_MAX, usdtRaw, utcDate, validateExecution } from '../src/strategy-execution.js';
import { typedVersionInput, validateAllocation } from '../src/strategies.js';
import type { StrategyVersion } from '../src/strategies.js';
import { validateStackInstruction, createPortfolioStrategyService } from '../src/portfolio-strategies.js';
import { assertVersionOnchain, publishVersionOnchain, REGISTRY_ABI } from '../src/chain.js';
import { kernelAddressesForChain } from '../src/addresses.js';
import { readFaucetFundingEvidence } from '../src/faucet.js';
import { parseSchedule } from '../src/scheduler.js';
import { AppError, UnauthorizedError } from '../src/errors.js';
import { createServer } from '../src/server.js';
import { strategyRpc, BLOCK_HASH, OTHER_HASH, TEST_ACCOUNT, TEST_AMOUNT, TEST_OWNER } from './fixtures/strategy-rpc.js';
import { TESTNET_97 } from '../src/testnet-profile.js';
const cash = TESTNET_97.contracts.usdt;
const risky = TESTNET_97.assets.AAPLB.token;
const allocation = validateAllocation({ assets: [{ address: risky, weightBps: 5000 }, { address: cash, weightBps: 5000 }] }, 97);
const activeAt = new Date('2026-11-15T00:00:00Z');
const config = { chainId: 97, execution: { kind: 'stack' as const }, allocation, schedule: { kind: 'funding' as const }, activeAt };
const hash = canonicalConfigHash(config);
const version: StrategyVersion = { strategyId: 82, version: 1, ...config, activeAt: activeAt.toISOString(), changeLog: null, createdAt: activeAt.toISOString(),
  executionSchemaVersion: 1, executionChainId: 97, configHash: hash, idleYield: { enabled: false } };
const denied = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;

test('#82 typed HTTP defaults explicitly preserve hold, funding schedule and disabled yield', () => {
  const input = typedVersionInput({ allocation });
  assert.deepEqual(input, { allocation, execution: { kind: 'hold' }, schedule: { kind: 'funding' }, idleYield: { enabled: false } });
  assert.equal(parseSchedule(input.schedule).kind, 'unsupported', 'legacy drift scheduler must not execute this version before BE-2');
  for (const execution of [{ kind: 'target_weight' }, { kind: 'custom' }, { kind: 'dips' }, { kind: 'range' }, { kind: 'trend' }, { kind: 'lp' }, { kind: 'carry' }, { kind: 'hold', stopLoss: 10 }, null, []]) {
    assert.throws(() => typedVersionInput({ allocation, execution }), denied('INVALID_EXECUTION'));
  }
  for (const extra of [{ plays: ['hold', 'stack'] }, { amountUsdt: '100' }, { stackInstruction: {} }, { unknown: true }]) {
    assert.throws(() => typedVersionInput({ allocation, ...extra }), denied('INVALID_VERSION'));
  }
  for (const schedule of [{ kind: 'interval', intervalSeconds: 604800 }, { kind: 'cron', cron: '*' }, { kind: 'funding', periodSeconds: 86400 }]) {
    assert.throws(() => typedVersionInput({ allocation, schedule }), denied('INVALID_SCHEDULE'));
  }
  for (const idleYield of [{ enabled: true }, { enabled: false, marketId: 'venus' }, null]) {
    assert.throws(() => typedVersionInput({ allocation, idleYield }), denied('YIELD_UNAVAILABLE'));
  }
});

test('#82 independent Python JSON / cast keccak goldens match canonical JSON, metadata/order normalization and existing Solidity ABI', () => {
  for (const vector of golden) {
    assert.ok(vector.config.execution.kind === 'hold' || vector.config.execution.kind === 'stack');
    const value = { chainId: vector.config.chainId, execution: validateExecution(vector.config.execution), allocation: vector.config.allocation,
      schedule: { kind: 'funding' as const }, activeAt: new Date(Number(vector.config.activeAt) * 1000) };
    assert.equal(canonicalConfig(value), vector.canonical);
    assert.equal(canonicalConfigHash(value), vector.hash);
    assert.equal(canonicalConfigHash({ ...value, allocation: { assets: value.allocation.assets.map((asset) => ({ ...asset, symbol: 'display only', address: asset.address.toUpperCase().replace('0X','0x') })).reverse() } }), vector.hash);
    const data = encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'publishVersion', args: [82n,
      value.allocation.assets.map((asset) => asset.address as Hex), value.allocation.assets.map((asset) => asset.weightBps), vector.hash as Hex, BigInt(vector.config.activeAt)] });
    const decoded = decodeFunctionData({ abi: REGISTRY_ABI, data });
    assert.equal(decoded.functionName, 'publishVersion');
    assert.equal(decoded.args[3], vector.hash);
    assert.equal(decoded.args[4], BigInt(vector.config.activeAt));
    assert.notEqual(canonicalConfigHash({ ...value, chainId: value.chainId + 1 }), vector.hash);
    assert.notEqual(canonicalConfigHash({ ...value, execution: { kind: value.execution.kind === 'hold' ? 'stack' : 'hold' } }), vector.hash);
    assert.notEqual(canonicalConfigHash({ ...value, activeAt: new Date(value.activeAt.getTime() + 1000) }), vector.hash);
  }
});

test('#82 amounts reject zero, negatives, exponents, >18 decimals and uint256 overflow without rounding', () => {
  assert.equal(usdtRaw('0.000000000000000001'), 1n);
  assert.equal(usdtRaw('4.999999999999999999'), 5n * 10n ** 18n - 1n);
  assert.equal(usdtRaw('5'), 5n * 10n ** 18n);
  assert.equal(usdtRaw(formatUnits(UINT256_MAX, 18)), UINT256_MAX);
  for (const value of ['0', '0.0', '-1', '1e2', '01', '1.', '.5', 'NaN', 'Infinity', '1.0000000000000000000', formatUnits(UINT256_MAX + 1n, 18), 100, null]) {
    assert.throws(() => usdtRaw(value), denied('INVALID_AMOUNT'));
  }
});

test('#82 allocation minimum includes the total batch, cash share and every small component', () => {
  for (const [cashWeight, noncash, expected] of [[0, [5000,5000], '50'], [5000, [2500,2500], '100'], [0, [9900,100], '500'], [10000, [], '50']] as const) {
    const assets = noncash.map((weightBps, index) => ({ address: index === 0 ? risky : TESTNET_97.assets.AMZNB.token, weightBps }));
    const basket = { assets: [...assets, { address: cash, weightBps: cashWeight }] };
    assert.equal(minimumAllocationRaw(basket, 97), usdtRaw(expected));
    assert.equal(defaultAmountUsdt(basket, 97), expected);
  }
  const startAt = '2026-11-16T09:00:00+08:00';
  assert.equal(validateStackInstruction({ expectedRevision: '0', enabled: true, startAt }, version).amountRaw, usdtRaw('100').toString());
  for (const amountUsdt of ['49.999999999999999999','50','99.999999999999999999']) {
    assert.throws(() => validateStackInstruction({ expectedRevision:'0', enabled:true, startAt, amountUsdt }, version), denied('BELOW_MINIMUM_ALLOCATION'));
  }
  for (const amountUsdt of ['100', formatUnits(UINT256_MAX,18)]) assert.equal(validateStackInstruction({ expectedRevision:'0', enabled:true, startAt, amountUsdt }, version).amountRaw, usdtRaw(amountUsdt).toString());
});

test('#82 personal instructions require authorization, UTC anchor, future revision input and internal prefunding', () => {
  const base = { expectedRevision: '0', startAt:'2026-11-16T09:00:00+08:00', enabled:true };
  const parsed = validateStackInstruction(base, version);
  assert.equal(parsed.startAt.toISOString(), '2026-11-16T01:00:00.000Z');
  assert.equal(parsed.periodSeconds,604800);
  for (const periodSeconds of [86400,604800]) assert.equal(validateStackInstruction({ ...base,periodSeconds },version).periodSeconds,periodSeconds);
  for (const periodSeconds of [0,60,86399,604801,'86400']) assert.throws(() => validateStackInstruction({ ...base,periodSeconds },version), denied('INVALID_PERIOD'));
  for (const fundingSource of ['external_wallet','bank','cash_account']) assert.throws(() => validateStackInstruction({ ...base,fundingSource },version), denied('INVALID_FUNDING_SOURCE'));
  for (const enabled of [undefined,1,'true']) assert.throws(() => validateStackInstruction({ ...base,enabled },version), denied('AUTHORIZATION_REQUIRED'));
  assert.throws(() => validateStackInstruction({ ...base,amountRaw:'100' },version), denied('INVALID_INSTRUCTION'));
  for (const endAt of [base.startAt,'2026-11-15T00:00:00Z']) assert.throws(() => validateStackInstruction({ ...base,endAt },version), denied('INVALID_TIME'));
  for (const value of ['2026-02-30T09:00:00Z','2026-11-16T09:00:00','2026-11-16','2026-11-16T24:00:00Z','infinity']) assert.throws(() => utcDate(value,'startAt'));
});

test('#82 chain version checks hash, basket, chain, activeAt equality and pinned enrollment', async () => {
  for (const scenario of ['ok','before','hash','weights','chain','version','pinned','strategy','missing','rpc']) {
    const rpc = strategyRpc(allocation,hash,activeAt);
    if (scenario === 'before') rpc.state.now--;
    if (scenario === 'hash') rpc.state.configHash=OTHER_HASH;
    if (scenario === 'weights') rpc.state.weights=[1,9999];
    if (scenario === 'chain') rpc.state.chainId=56;
    if (scenario === 'version') rpc.state.version=2;
    if (scenario === 'pinned') rpc.state.pinned=2;
    if (scenario === 'strategy') rpc.state.strategyId=83n;
    if (scenario === 'missing' || scenario === 'rpc') rpc.state.fail='eth_call';
    const action=assertVersionOnchain(82,1,{...config,configHash:hash}, ['pinned','strategy'].includes(scenario)?TEST_ACCOUNT:undefined,{client:rpc.client,registry:TESTNET_97.contracts.registry});
    if (scenario==='ok') await action;
    else await assert.rejects(action,(error:unknown)=>error instanceof AppError && !error.message.includes('SECRET'));
  }
});

test('#82 faucet lot proof needs one exact canonical Claimed event; Transfer/donation, removed/reverted/malformed receipts cannot credit', async () => {
  for (const scenario of ['ok','chain','reorg','missing','duplicate','removed','revert','amount','recipient','token','operator','malformed','rpc']) {
    const rpc=strategyRpc(allocation,hash,activeAt);
    if(scenario==='chain')rpc.state.chainId=56;
    if(scenario==='reorg')rpc.state.blockHash=OTHER_HASH;
    if(scenario==='missing')rpc.state.logs=false;
    if(scenario==='duplicate')rpc.state.duplicateLog=true;
    if(scenario==='removed')rpc.state.removed=true;
    if(scenario==='revert')rpc.state.success=false;
    if(scenario==='amount')rpc.state.amount++;
    if(scenario==='recipient')rpc.state.to=TEST_OWNER;
    if(scenario==='token')rpc.state.token=TEST_OWNER;
    if(scenario==='operator')rpc.state.by=TEST_OWNER;
    if(scenario==='malformed')rpc.state.malformed=true;
    if(scenario==='rpc')rpc.state.fail='eth_getTransactionReceipt';
    const action=readFaucetFundingEvidence({chainId:97,account:TEST_ACCOUNT,amountWei:TEST_AMOUNT,txHash:OTHER_HASH},rpc.client);
    if(scenario==='ok')assert.deepEqual(await action,{txHash:OTHER_HASH,logIndex:0,blockNumber:130n,blockHash:BLOCK_HASH,amountRaw:TEST_AMOUNT.toString()});
    else await assert.rejects(action,(error:unknown)=>error instanceof AppError && !error.message.includes('SECRET'));
  }
  await assert.rejects(readFaucetFundingEvidence({chainId:56,account:TEST_ACCOUNT,amountWei:TEST_AMOUNT,txHash:OTHER_HASH}),denied('FUNDING_SOURCE_DISABLED'));
});

test('#82 RPC receipt timeout is bounded and sanitized',async()=>{
  const server=httpServer(()=>{});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const address=server.address();assert.ok(address && typeof address!=='string');
    const client=createPublicClient({transport:http(`http://127.0.0.1:${address.port}`,{timeout:20,retryCount:0})});
    await assert.rejects(readFaucetFundingEvidence({chainId:97,account:TEST_ACCOUNT,amountWei:TEST_AMOUNT,txHash:OTHER_HASH},client),denied('FUNDING_RPC_UNAVAILABLE'));
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('#82 retrying an unconfirmed stored version never submits a new publish transaction', async () => {
  const rpc = strategyRpc(allocation, hash, activeAt);
  let sends = 0;
  const wallet = createWalletClient({ account: toAccount(TEST_OWNER), transport: custom({ request: async () => { sends++; throw new Error('unexpected broadcast'); } }) });
  const chain = { chainId: 97, rpcUrl: 'http://127.0.0.1:8561', registryAddress: TESTNET_97.contracts.registry,
    account: toAccount(TEST_OWNER), wallet, publicClient: rpc.client, kernel: kernelAddressesForChain(97) };
  const input = { assets: allocation.assets.map(asset => asset.address as Hex), weightsBps: allocation.assets.map(asset => asset.weightBps),
    schedule: { kind: 'funding' as const }, activeAt, configHash: hash, expectedVersion: 1, allowPublish: false };
  const deps = { chain, lock: async <T,>(_chainId: number, run: (assertHeld: () => void) => Promise<T>) => run(() => {}) };
  rpc.state.version = 0;
  await assert.rejects(publishVersionOnchain(82, input, deps), denied('VERSION_PENDING_RECONCILIATION'));
  rpc.state.version = 1;
  assert.equal(await publishVersionOnchain(82, input, deps), 1);
  rpc.state.configHash = OTHER_HASH;
  await assert.rejects(publishVersionOnchain(82, input, deps), denied('CHAIN_CONFIG_MISMATCH'));
  assert.equal(sends, 0);
});

test('#82 services sanitize DB failures and reject unsupported sources before receipt reads',async()=>{
  const service=createPortfolioStrategyService({owned:async()=>{throw new Error('SECRET_DB_URL');}});
  await assert.rejects(service.read(82,TEST_OWNER),denied('EXECUTION_STORAGE_UNAVAILABLE'));
  for(const source of [{kind:'transfer',txHash:OTHER_HASH},{kind:'bank'},{kind:'faucet_claim',claimId:'1',amountRaw:'1'}]){
    await assert.rejects(service.funding(82,TEST_OWNER,{source}),error=>error instanceof AppError && error.status===400);
  }
  await assert.rejects(createPortfolioStrategyService({chainId:()=>56}).funding(82,TEST_OWNER,{source:{kind:'faucet_claim',claimId:'1'}}),denied('FUNDING_SOURCE_DISABLED'));
});

test('#82 new portfolio HTTP routes authenticate before body parsing and return stored contract without dropping fields',async()=>{
  let authenticated=false;
  const calls:string[]=[];
  const service=createPortfolioStrategyService({owned:async()=>{calls.push('owned');throw new AppError(403,'FORBIDDEN','foreign owner');}});
  const server=createServer({auth:{authenticate:async()=>{if(!authenticated)throw new UnauthorizedError();return TEST_OWNER;},issueNonce:()=>{throw new Error('unexpected');},login:async()=>{throw new Error('unexpected');},logout:async()=>{}},portfolioStrategies:service});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const address=server.address();assert.ok(address && typeof address!=='string');
    const base=`http://127.0.0.1:${address.port}/portfolios/82`;
    for(const action of ['execution','funding-lots','stack-instructions','stack-instruction-state','execution-state']){
      const method=action==='execution'?'GET':'POST';
      assert.equal((await fetch(`${base}/${action}`,{method,...(method==='POST'?{body:'invalid'}:{})})).status,401);
      assert.equal((await fetch(`${base}/${action}`,{method:'PUT'})).status,405);
    }
    assert.deepEqual(calls,[]);
    authenticated=true;
    assert.equal((await fetch(base+'/execution')).status,403);
    assert.deepEqual(calls,['owned']);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});


test('#82 source hash and canonical block after version reads must still match the receipt block', async () => {
  const expected = { ...config, configHash: hash };
  const before = strategyRpc(allocation, hash, activeAt);
  await assert.rejects(assertVersionOnchain(82, 1, expected, TEST_ACCOUNT,
    { client: before.client, registry: TESTNET_97.contracts.registry, blockNumber: 130n, blockHash: OTHER_HASH }), denied('FUNDING_REORGED'));
  const after = strategyRpc(allocation, hash, activeAt); after.state.reorgAtBlockRead = 2;
  await assert.rejects(assertVersionOnchain(82, 1, expected, TEST_ACCOUNT,
    { client: after.client, registry: TESTNET_97.contracts.registry, blockNumber: 130n, blockHash: BLOCK_HASH }), denied('FUNDING_REORGED'));
});
