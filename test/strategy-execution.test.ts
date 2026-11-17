import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer as httpServer } from 'node:http';
import { createPublicClient, createWalletClient, custom, decodeFunctionData, encodeFunctionData, formatUnits, http } from 'viem';
import { toAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import golden from './fixtures/strategy-config-golden.json' with { type: 'json' };
import v2Golden from './fixtures/strategy-config-v2-golden.json' with { type: 'json' };
import { canonicalConfig, canonicalConfigHash, defaultAmountUsdt, minimumAllocationRaw, UINT256_MAX, usdtRaw, utcDate, validateExecution, validateAssetConfig, minimumAssetContribution } from '../src/strategy-execution.js';
import { typedVersionInput, validateAllocation, previewContribution } from '../src/strategies.js';
import type { StrategyVersion } from '../src/strategies.js';
import { createPortfolioStrategyService, readWalletFundingEvidence } from '../src/portfolio-strategies.js';
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

const walletSource = { chainId: 97, owner: TEST_OWNER, account: TEST_ACCOUNT, txHash: OTHER_HASH };
function walletRpc() {
  const rpc = strategyRpc(allocation, hash, activeAt);
  rpc.state.mint = true;
  rpc.state.transferFrom = TEST_OWNER;
  return rpc;
}

test('#151 wallet proof reads the manifest token Transfer amount at the canonical receipt block, including uint256 boundaries', async () => {
  for (const amount of [1n, usdtRaw('50'), TEST_AMOUNT, UINT256_MAX]) {
    const rpc = walletRpc(); rpc.state.amount = amount;
    assert.deepEqual(await readWalletFundingEvidence(walletSource, rpc.client), {
      txHash: OTHER_HASH, logIndex: 0, blockNumber: 130n, blockHash: BLOCK_HASH, amountRaw: amount.toString(), confirmedAt: activeAt,
    });
    assert.deepEqual(rpc.state.reads, ['eth_chainId', 'eth_getTransactionReceipt', 'eth_getBlockByNumber']);
    assert.deepEqual(rpc.state.broadcasts, []);
  }
});

test('#151 one matching Transfer remains eligible alongside unrelated token logs', async () => {
  const rpc = walletRpc();
  const client = createPublicClient({ transport: custom({ request: async ({ method, params }) => {
    const response: unknown = await rpc.client.transport.request({ method, params });
    if (method === 'eth_getBlockByNumber') assert.deepEqual(params, ['0x82', false]);
    if (method === 'eth_getTransactionReceipt') {
      assert.ok(response && typeof response === 'object');
      const logs: unknown = Reflect.get(response, 'logs'); assert.ok(Array.isArray(logs) && logs[0]);
      logs.push({ ...logs[0], address: TEST_OWNER, logIndex: '0x1' });
    }
    return response;
  } }, { retryCount: 0 }) });
  const evidence = await readWalletFundingEvidence(walletSource, client);
  assert.equal(evidence.logIndex, 0); assert.equal(evidence.amountRaw, TEST_AMOUNT.toString());
});

test('#151 wallet proof rejects foreign origins/recipients/tokens, zero, ambiguous logs and invalid receipts', async () => {
  for (const scenario of ['from', 'to', 'token', 'zero', 'duplicate', 'missing', 'removed', 'reverted', 'malformed', 'claimed', 'reorg', 'chain', 'pending']) {
    const rpc = walletRpc();
    if (scenario === 'from') rpc.state.transferFrom = TEST_ACCOUNT;
    if (scenario === 'to') rpc.state.to = TEST_OWNER;
    if (scenario === 'token') rpc.state.token = TEST_OWNER;
    if (scenario === 'zero') rpc.state.amount = 0n;
    if (scenario === 'duplicate') rpc.state.duplicateLog = true;
    if (scenario === 'missing') rpc.state.logs = false;
    if (scenario === 'removed') rpc.state.removed = true;
    if (scenario === 'reverted') rpc.state.success = false;
    if (scenario === 'malformed') rpc.state.malformed = true;
    if (scenario === 'claimed') rpc.state.mint = false;
    if (scenario === 'reorg') rpc.state.blockHash = OTHER_HASH;
    if (scenario === 'chain') rpc.state.chainId = 56;
    if (scenario === 'pending') rpc.state.missingReceipt = true;
    const code = scenario === 'reorg' ? 'FUNDING_REORGED' : ['chain', 'pending'].includes(scenario) ? 'FUNDING_RPC_UNAVAILABLE' : 'FUNDING_NOT_CONFIRMED';
    await assert.rejects(readWalletFundingEvidence(walletSource, rpc.client), denied(code), scenario);
  }
});

test('#151 receipt/log/block identities and timestamps must be complete and match the requested event', async () => {
  for (const [target, key, value] of [
    ['receipt', 'transactionHash', BLOCK_HASH], ['receipt', 'blockNumber', '-0x1'],
    ['log', 'transactionHash', BLOCK_HASH], ['log', 'blockHash', OTHER_HASH], ['log', 'blockNumber', '0x81'],
    ['log', 'logIndex', null], ['log', 'logIndex', '-0x1'], ['log', 'logIndex', '0x20000000000000'],
    ['block', 'number', '0x81'], ['block', 'timestamp', '0x20000000000000'],
  ] as const) {
    const rpc = walletRpc();
    const client = createPublicClient({ transport: custom({ request: async ({ method, params }) => {
      const response: unknown = await rpc.client.transport.request({ method, params });
      if ((method === 'eth_getTransactionReceipt' && target !== 'block') || (method === 'eth_getBlockByNumber' && target === 'block')) {
        assert.ok(response && typeof response === 'object');
        if (target === 'log') {
          const logs: unknown = Reflect.get(response, 'logs'); assert.ok(Array.isArray(logs) && logs[0]);
          Reflect.set(logs[0], key, value);
        } else Reflect.set(response, key, value);
      }
      return response;
    } }, { retryCount: 0 }) });
    await assert.rejects(readWalletFundingEvidence(walletSource, client), error => error instanceof AppError && !error.message.includes('SECRET'), `${target}.${key}`);
  }
});

test('#151 wallet funding rejects malformed input and non-97 chains before ownership, RPC or storage reads', async () => {
  let reads = 0;
  const owned = async (): Promise<never> => { reads++; throw new Error('unexpected ownership read'); };
  const service = createPortfolioStrategyService({ chainId: () => 97, owned });
  for (const source of [
    { kind: 'wallet_transfer' }, ...[null, '', '0x', '0x01', `0x${'gg'.repeat(32)}`, 1].map(txHash => ({ kind: 'wallet_transfer', txHash })),
    { kind: 'wallet_transfer', txHash: OTHER_HASH, amountRaw: '1' }, { kind: 'wallet_transfer', txHash: OTHER_HASH, claimId: '1' },
  ]) await assert.rejects(service.funding(82, TEST_OWNER, { source }), denied('INVALID_FUNDING_SOURCE'));
  for (const chainId of [56, 1337, 31337]) {
    await assert.rejects(createPortfolioStrategyService({ chainId: () => chainId, owned }).funding(82, TEST_OWNER,
      { source: { kind: 'wallet_transfer', txHash: OTHER_HASH } }), denied('FUNDING_SOURCE_DISABLED'));
    await assert.rejects(readWalletFundingEvidence({ ...walletSource, chainId }), denied('FUNDING_SOURCE_DISABLED'));
  }
  assert.equal(reads, 0);
});

test('#151 wallet RPC failures and transport timeouts expose only a fixed error', async () => {
  for (const method of ['eth_chainId', 'eth_getTransactionReceipt', 'eth_getBlockByNumber']) {
    const rpc = walletRpc(); rpc.state.fail = method;
    await assert.rejects(readWalletFundingEvidence(walletSource, rpc.client), error => error instanceof AppError && error.code === 'FUNDING_RPC_UNAVAILABLE' && !error.message.includes('SECRET'));
  }
  const server = httpServer(() => {});
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const client = createPublicClient({ transport: http(`http://127.0.0.1:${address.port}`, { timeout: 20, retryCount: 0 }) });
    await assert.rejects(readWalletFundingEvidence(walletSource, client), denied('FUNDING_RPC_UNAVAILABLE'));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('#83 typed HTTP defaults explicitly preserve per-asset hold, funding schedule and disabled yield', () => {
  const input = typedVersionInput({ allocation, chainId: 97 });
  assert.deepEqual(input, { allocation, chainId: 97, execution: { kind: 'per_asset', numeraire: cash, rebalance: 'none',
    assets: allocation.assets.map(({address,weightBps}) => address === cash
      ? {asset:address,weightBps,yield:null} : {asset:address,weightBps,execution:{kind:'hold'},yield:null}).sort((a,b)=>a.asset.localeCompare(b.asset)) },
    schedule: { kind: 'funding' }, idleYield: { enabled: false } });
  assert.equal(parseSchedule(input.schedule).kind, 'unsupported', 'funding must not silently become a legacy drift interval');
  for (const execution of [{kind:'hold'}, {kind:'stack'}, {kind:'target_weight'}, {kind:'custom'}, {kind:'dips'}, {kind:'range'}, {kind:'trend'}, {kind:'lp'}, {kind:'carry'}, null, []]) {
    assert.throws(() => typedVersionInput({allocation, chainId:97, execution}), denied('INVALID_EXECUTION'));
  }
  for (const extra of [{plays:['hold','stack']}, {amountUsdt:'100'}, {stackInstruction:{}}, {unknown:true}]) {
    assert.throws(() => typedVersionInput({allocation, chainId:97, ...extra}), denied('INVALID_VERSION'));
  }
  for (const schedule of [{kind:'interval',intervalSeconds:604800}, {kind:'cron',cron:'*'}, {kind:'funding',periodSeconds:86400}]) {
    assert.throws(() => typedVersionInput({allocation, chainId:97, schedule}), denied('INVALID_SCHEDULE'));
  }
  for (const idleYield of [{enabled:true}, {enabled:false,marketId:'venus'}, null]) {
    assert.throws(() => typedVersionInput({allocation, chainId:97, idleYield}), denied('YIELD_UNAVAILABLE'));
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

test('#83 contribution minimum keeps new 50 inclusive fee without changing legacy basket limits', () => {
  for (const [cashWeight,noncash,expected] of [[0,[5000,5000],'50'],[5000,[2500,2500],'100'],[0,[9900,100],'500'],[10000,[],'50']] as const) {
    const assets=noncash.map((weightBps,index)=>({address:index===0?risky:TESTNET_97.assets.AMZNB.token,weightBps}));
    const basket={assets:[...assets,{address:cash,weightBps:cashWeight}]};
    assert.equal(minimumAllocationRaw(basket,97),usdtRaw(expected));
    assert.equal(defaultAmountUsdt(basket,97),expected);
    const execution=validateAssetConfig(undefined,basket,97);
    assert.equal(minimumAssetContribution(execution),usdtRaw('50'));
  }
});

test('#83 per-asset creator calendars validate daily/weekly bounds and reject holder instruction writes', async () => {
  const base={kind:'per_asset',numeraire:cash,rebalance:'none',assets:[
    {asset:risky,weightBps:5000,execution:{kind:'stack',every:'weekly',weekday:1,timeUtc:'01:00',slices:12},yield:null},
    {asset:cash,weightBps:5000,yield:null}]};
  for (const slices of [2,52,365]) {
    const value={...base,assets:[{...base.assets[0],execution:{kind:'stack',every:'daily',weekday:null,timeUtc:'23:59',slices}},base.assets[1]]};
    assert.equal(validateAssetConfig(value,allocation,97).kind,'per_asset');
  }
  assert.equal(validateAssetConfig(base,allocation,97).kind,'per_asset');
  for (const execution of [
    {kind:'stack',every:'daily',weekday:1,timeUtc:'09:00',slices:12},
    {kind:'stack',every:'weekly',weekday:null,timeUtc:'09:00',slices:12},
    ...[0,1,53,2.5,'12'].map(slices=>({kind:'stack',every:'weekly',weekday:1,timeUtc:'09:00',slices})),
    ...[-1,7,1.5,'1'].map(weekday=>({kind:'stack',every:'weekly',weekday,timeUtc:'09:00',slices:12})),
    ...['9:00','24:00','09:60','09:00:00'].map(timeUtc=>({kind:'stack',every:'weekly',weekday:1,timeUtc,slices:12})),
    {kind:'stack',every:'monthly',weekday:1,timeUtc:'09:00',slices:12}, {kind:'stack'}, {kind:'dips'}, {kind:'hold',stopLoss:1}]) {
    assert.throws(()=>validateAssetConfig({...base,assets:[{...base.assets[0],execution},base.assets[1]]},allocation,97));
  }
  for (const rebalance of ['monthly','drift']) assert.throws(()=>validateAssetConfig({...base,rebalance},allocation,97));
  for (const value of ['2026-02-30T09:00:00Z','2026-11-16T09:00:00','2026-11-16','2026-11-16T24:00:00Z','infinity']) assert.throws(()=>utcDate(value,'startAt'));
  const service=createPortfolioStrategyService();
  await assert.rejects(service.instruct(82,TEST_OWNER,{expectedRevision:'0',enabled:true}),denied('STACK_INSTRUCTIONS_RETIRED'));
  await assert.rejects(service.instructionState(82,TEST_OWNER,{revision:'1',state:'stopped'}),denied('STACK_INSTRUCTIONS_RETIRED'));
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
    if(scenario==='ok')assert.deepEqual(await action,{txHash:OTHER_HASH,logIndex:0,blockNumber:130n,blockHash:BLOCK_HASH,amountRaw:TEST_AMOUNT.toString(),confirmedAt:activeAt});
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

test('#124 publication gas estimation failure or zero never broadcasts a transaction', async () => {
  for (const scenario of ['rpc', 'zero']) {
    const rpc = strategyRpc(allocation, hash, activeAt); rpc.state.version = 0;
    if (scenario === 'rpc') rpc.state.fail = 'eth_estimateGas'; else rpc.state.gasEstimate = 0n;
    let sends = 0;
    const wallet = createWalletClient({ account: toAccount(TEST_OWNER), transport: custom({ request: async () => { sends++; throw new Error('unexpected broadcast'); } }) });
    const chain = { chainId: 97, rpcUrl: 'http://127.0.0.1:8561', registryAddress: TESTNET_97.contracts.registry,
      account: toAccount(TEST_OWNER), wallet, publicClient: rpc.client, kernel: kernelAddressesForChain(97) };
    await assert.rejects(publishVersionOnchain(82, { assets: allocation.assets.map(a => a.address as Hex), weightsBps: allocation.assets.map(a => a.weightBps),
      schedule: { kind: 'funding' }, activeAt, configHash: hash, expectedVersion: 1 },
    { chain, lock: async (_chainId, run) => run(() => {}) }), denied('VERSION_PUBLISH_UNAVAILABLE'));
    assert.equal(sends, 0);
  }
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
    for(const action of ['execution','funding-lots','execution-state']){
      const method=action==='execution'?'GET':'POST';
      assert.equal((await fetch(`${base}/${action}`,{method,...(method==='POST'?{body:'invalid'}:{})})).status,401);
      assert.equal((await fetch(`${base}/${action}`,{method:'PUT'})).status,405);
    }
    for(const action of ['stack-instructions','stack-instruction-state']) assert.equal((await fetch(`${base}/${action}`,{method:'POST',body:'invalid'})).status,404);
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

// Python JSON + Foundry cast keccak generated independently from the TypeScript encoder.
test('#83 schema 2 canonical goldens bind every creator execution/yield/rebalance field and preserve schema 1', () => {
  for (const vector of v2Golden) {
    const execution=validateAssetConfig(vector.config.execution,vector.config.allocation,vector.config.chainId);
    const value={chainId:vector.config.chainId,execution,allocation:vector.config.allocation,schedule:{kind:'funding' as const},activeAt:new Date(Number(vector.config.activeAt)*1000)};
    assert.equal(canonicalConfig(value),vector.canonical);assert.equal(canonicalConfigHash(value),vector.hash);
    assert.equal(canonicalConfigHash({...value,execution:{...execution,assets:[...execution.assets].reverse()},allocation:{assets:[...value.allocation.assets].reverse()}}),vector.hash);
    const changed={...execution,rebalance:execution.rebalance==='none'?'monthly' as const:'none' as const};
    if (!execution.assets.some(a=>a.execution?.kind==='stack')) assert.notEqual(canonicalConfigHash({...value,execution:changed}),vector.hash);
    const yielded={...execution,assets:execution.assets.map((a,index)=>index===0?{...a,yield:{market:'venus_mock'}}:a)};
    assert.notEqual(canonicalConfigHash({...value,execution:yielded}),vector.hash);
    assert.notEqual(canonicalConfigHash({...value,activeAt:new Date(value.activeAt.getTime()+1000)}),vector.hash);
    assert.notEqual(canonicalConfigHash({...value,chainId:1337}),vector.hash);
  }
});

test('#83 per-asset full configuration rejects cash execution, tampered weights, duplicate/missing assets and unknown fields', () => {
  const normalized=validateAssetConfig(undefined,allocation,97);
  const cashEntry=normalized.assets.find(a=>a.asset===cash);const riskyEntry=normalized.assets.find(a=>a.asset===risky);
  assert.ok(cashEntry);assert.ok(riskyEntry);
  for(const assets of [
    [{...cashEntry,execution:null},riskyEntry],[{...cashEntry,execution:{kind:'hold'}},riskyEntry],
    [cashEntry,{...riskyEntry,weightBps:4999}],[cashEntry,cashEntry],
    [cashEntry],[cashEntry,riskyEntry,{...riskyEntry,asset:TESTNET_97.assets.AMZNB.token}],
    [cashEntry,{...riskyEntry,thresholdBps:500}],
    [cashEntry,{...riskyEntry,yield:{market:'venus',target:TEST_ACCOUNT}}],
    [cashEntry,{...riskyEntry,yield:{market:'https://untrusted.invalid'}}],
  ]) assert.throws(()=>validateAssetConfig({...normalized,assets},allocation,97));
  for(const extra of [{thresholdBps:500},{idleYield:{enabled:true}},{numeraire:TEST_ACCOUNT},{rebalance:'annual'}]) assert.throws(()=>validateAssetConfig({...normalized,...extra},allocation,97));
  for(const rebalance of ['none','monthly','drift'] as const) assert.equal(validateAssetConfig({...normalized,rebalance},allocation,97).rebalance,rebalance);
  const all=Array.from({length:15},(_,i)=>({address:`0x${(i+1).toString(16).padStart(40,'0')}`,weightBps:0}));
  // #92: 16 and 17 entries retain exact correspondence with the allocation.
  const sized={assets:[...all.map((a,index)=>({...a,weightBps:index===0?676:666})),{address:'0x55d398326f99059ff775485246999027b3197955',weightBps:0}]};
  assert.equal(validateAssetConfig(undefined,sized,56).assets.length,16);
  const larger={assets:[...sized.assets.map((a,i)=>({...a,weightBps:a.weightBps-(i===0?1:0)})),{address:'0x0000000000000000000000000000000000000010',weightBps:1}]};
  assert.equal(validateAssetConfig(undefined,larger,56).assets.length,17);
});


test('#96 chain 56 HTTP preserves interval schema 0 and caps the final allocation at 16',()=>{
  const cash56='0x55d398326f99059ff775485246999027b3197955';
  const basket={assets:[{address:cash56,weightBps:10000}]};
  assert.deepEqual(typedVersionInput({allocation:basket,chainId:56,schedule:{kind:'interval',intervalSeconds:60}}),{allocation:basket,schedule:{kind:'interval',intervalSeconds:60}});
  assert.throws(()=>typedVersionInput({allocation:basket,chainId:56,execution:{kind:'per_asset'}}),denied('EXECUTION_UNAVAILABLE'));
  const entries=Array.from({length:16},(_,n)=>({address:`0x${(n+1).toString(16).padStart(40,'0')}`,weightBps:625}));
  assert.throws(()=>validateAllocation({assets:entries},56),denied('TOO_MANY_ASSETS'),'appending USDT would exceed mainnet registry capacity');
  assert.equal(validateAllocation({assets:[...entries.slice(0,15).map(a=>({...a,weightBps:600})),{address:cash56,weightBps:1000}]},56).assets.length,16);
});

test('#118 subscription minimum follows the risky-weight batch floor',()=>{
  for(const weightBps of [0,5000,9900,10000]){
    const basket={assets:weightBps===10000?[{address:cash,weightBps}]:[{address:risky,weightBps:10000-weightBps},{address:cash,weightBps}]};
    assert.equal(minimumAssetContribution(validateAssetConfig(undefined,basket,97)),(weightBps===9900?1000n:50n)*10n**18n);
  }
});


test('#96 legacy HTTP normalization cannot erase an explicit wrong chain identity',()=>{
  const allocation={assets:[{address:'0x55d398326f99059ff775485246999027b3197955',weightBps:10000}]};
  assert.throws(()=>typedVersionInput({allocation,chainId:1337,schedule:{kind:'interval',intervalSeconds:60}}),denied('CHAIN_MISMATCH'));
});


test('#118 preview keeps short calendars unique, advances equal confirmation times and omits pure cash slots',()=>{
  const at=new Date('2026-11-16T13:00:00Z'),U=10n**18n;
  const basket=validateAllocation({assets:[{address:risky,weightBps:10000},{address:cash,weightBps:0}]},97);
  const execution=validateAssetConfig({kind:'per_asset',numeraire:cash,assets:[
    {asset:risky,weightBps:10000,execution:{kind:'stack',every:'daily',weekday:null,timeUtc:'13:00',slices:2},yield:null},
    {asset:cash,weightBps:0,yield:null}]},basket,97);
  const preview=previewContribution({chainId:97,execution,amountRaw:(50n*U).toString()},at);
  assert.deepEqual(preview.slots,[{at:'2026-11-17T13:00:00.000Z',budgetRaw:(25n*U).toString()},{at:'2026-11-18T13:00:00.000Z',budgetRaw:(25n*U).toString()}]);
  const only=validateAssetConfig(undefined,{assets:[{address:cash,weightBps:10000}]},97);
  assert.deepEqual(previewContribution({chainId:97,execution:only,amountRaw:(50n*U).toString()},at),{minimumRaw:(50n*U).toString(),effectiveSlices:{},slots:[]});
});
