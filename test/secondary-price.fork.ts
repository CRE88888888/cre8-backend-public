/** #52 explicit acceptance: all writes are guarded to the dedicated local anvil and DB. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createPublicClient, createWalletClient, decodeEventLog, encodeAbiParameters, getAddress, http, isHex, keccak256, parseAbi, toHex } from 'viem';
import type { Address, Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';
import { closePool, query } from '../src/db.js';
import { inspectPriceSources, PANCAKE_UR } from '../src/chain.js';
import { createPriceSourceTracker, listOpenAlerts } from '../src/alerts.js';
import { announceAlerts } from '../src/scheduler.js';
import { checkSecondarySources } from '../scripts/preflight.js';
import { computeDrift } from '../src/drift.js';
import type { Holding } from '../src/drift.js';
import { planRebalance, refreshFloors } from '../src/rebalance-plan.js';

const rpc = 'http://127.0.0.1:8636';
const account = mnemonicToAccount('test test test test test test test test test test test junk');
const client = createPublicClient({ chain: bsc, transport: http(rpc, { timeout: 120000, retryCount: 0 }) });
const wallet = createWalletClient({ account, chain: bsc, transport: http(rpc) });
const wbnb = getAddress('0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c');
const eth = getAddress('0x2170ed0880ac9a755fd29b2688956bd959f933f8');
const usdt = getAddress('0x55d398326f99059ff775485246999027b3197955');
const registryAbi = parseAbi(['constructor()', 'function setOperator(address)', 'function enroll(address,uint256)',
  'function registerStrategy(string,string,bool) returns(uint256)', 'function publishVersion(uint256,address[],uint16[],bytes32,uint64) returns(uint16)']);
const oracleAbi = parseAbi(['constructor(address)', 'function setOracle(address,address,uint32,uint16,uint32) returns(address)',
  'function setSecondary(address,address,address,uint32,uint16) returns(address)', 'function previewSwap(address,address,uint256) view returns(uint256,uint256)']);
const executorAbi = parseAbi(['constructor(address,address,address,address,address,address,uint16)',
  'event SwapExecuted(address indexed account,address tokenIn,address tokenOut,uint256 amountIn,uint256 gross,uint256 fee,uint256 net,uint256 oracleFloor)']);
const mockAbi = parseAbi(['constructor()', 'function approveToken(address,address,uint256)',
  'function executeRebalance(address,(address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOutMin,address venue,bytes data)[],uint256)']);
const feedAbi = parseAbi(['constructor(uint8,int256)']);
const erc20 = parseAbi(['function balanceOf(address) view returns(uint256)']);
let snapshot: unknown;
async function local(method: string, params: readonly unknown[] = []) {
  const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body: unknown = await response.json(); assert.ok(typeof body === 'object' && body !== null && !('error' in body), method);
  return Reflect.get(body, 'result');
}
async function bytecode(source: string, name: string): Promise<Hex> {
  const artifact: unknown = JSON.parse(await readFile(`.bun-cache/contracts-52/out/${source}/${name}.json`, 'utf8'));
  assert.ok(typeof artifact === 'object' && artifact !== null);
  const code: unknown = Reflect.get(artifact, 'bytecode'); assert.ok(typeof code === 'object' && code !== null);
  const value: unknown = Reflect.get(code, 'object'); assert.ok(typeof value === 'string' && isHex(value) && value.length > 2); return value;
}
async function landed(hash: Hex) {
  await local('evm_mine'); const receipt = await client.waitForTransactionReceipt({ hash }); assert.equal(receipt.status, 'success'); return receipt;
}
async function deployed(hash: Hex): Promise<Address> { const receipt = await landed(hash); assert.ok(receipt.contractAddress); return receipt.contractAddress; }
after(async () => { if (typeof snapshot === 'string') await local('evm_revert', [snapshot]); await closePool(); });

test('#52 real router secondary: stale blocks one asset; round 3 critical; healthy ETH swaps; restored time resolves', { timeout: 120000 }, async () => {
  assert.equal(process.env.RUN_CHAIN_TESTS, '1'); assert.equal(process.env.RPC_URL, rpc);
  const db = new URL(process.env.DATABASE_URL ?? ''); assert.equal(db.pathname, '/cre8_x1j');
  assert.ok(['', 'localhost', '127.0.0.1'].includes(db.hostname));
  assert.equal((await query<{ name: string }>('select current_database() as name')).rows[0]?.name, 'cre8_x1j');
  await local('anvil_nodeInfo'); assert.equal(await client.getChainId(), 56);
  const registry = await deployed(await wallet.deployContract({ abi: registryAbi, bytecode: await bytecode('AtpRegistry.sol', 'AtpRegistry') }));
  const oracle = await deployed(await wallet.deployContract({ abi: oracleAbi, bytecode: await bytecode('AtpMultiPoolOracle.sol', 'AtpMultiPoolOracle'), args: [usdt] }));
  for (const [asset, pool] of [[wbnb, getAddress('0x36696169c63e42cd08ce11f5deebbcebae652050')], [eth, getAddress('0x9f599f3d64a9d99ea21e68127bb6ce99f893da61')]] as const) {
    await landed(await wallet.writeContract({ address: oracle, abi: oracleAbi, functionName: 'setOracle', args: [asset, pool, 1800, 300, 3600] }));
  }
  const [wbnbUnit] = await client.readContract({ address: oracle, abi: oracleAbi, functionName: 'previewSwap', args: [wbnb, usdt, 10n ** 18n] });
  const [ethUnit] = await client.readContract({ address: oracle, abi: oracleAbi, functionName: 'previewSwap', args: [eth, usdt, 10n ** 18n] });
  const assetFeed = await deployed(await wallet.deployContract({ abi: feedAbi, bytecode: await bytecode('AtpMultiPoolOracleSecondary.t.sol', 'MockAggregator'), args: [8, wbnbUnit / 10n ** 10n] }));
  const cashFeed = await deployed(await wallet.deployContract({ abi: feedAbi, bytecode: await bytecode('AtpMultiPoolOracleSecondary.t.sol', 'MockAggregator'), args: [8, 100000000n] }));
  await landed(await wallet.writeContract({ address: oracle, abi: oracleAbi, functionName: 'setSecondary', args: [wbnb, assetFeed, cashFeed, 60, 1000] }));
  const executor = await deployed(await wallet.deployContract({ abi: executorAbi, bytecode: await bytecode('AtpExecutor.sol', 'AtpExecutor'),
    args: [registry, PANCAKE_UR, oracle, getAddress('0x31c2f6fcff4f8759b3bd5bf0e1084a055615c768'), account.address, usdt, 10000] }));
  const smart = await deployed(await wallet.deployContract({ abi: mockAbi, bytecode: await bytecode('AtpExecutorFork.t.sol', 'MockSmartAccount') }));
  await landed(await wallet.writeContract({ address: registry, abi: registryAbi, functionName: 'setOperator', args: [account.address] }));
  const registered = await client.simulateContract({ account, address: registry, abi: registryAbi, functionName: 'registerStrategy', args: ['#52 isolated secondary', '', true] });
  await landed(await wallet.writeContract(registered.request)); const strategyId = registered.result;
  const targets = [{ asset: wbnb, weightBps: 0 }, { asset: eth, weightBps: 0 }, { asset: usdt, weightBps: 10000 }];
  await landed(await wallet.writeContract({ address: registry, abi: registryAbi, functionName: 'publishVersion', args: [strategyId, targets.map((target) => target.asset), targets.map((target) => target.weightBps), toHex(0, { size: 32 }), 0n] }));
  await landed(await wallet.writeContract({ address: registry, abi: registryAbi, functionName: 'enroll', args: [smart, strategyId] }));
  for (const token of [wbnb, eth]) await landed(await wallet.writeContract({ address: smart, abi: mockAbi, functionName: 'approveToken', args: [token, executor, (1n << 256n) - 1n] }));
  for (const [token, slot, amount] of [[wbnb, 3n, 10n ** 17n], [eth, 1n, 10n ** 16n]] as const) {
    await local('anvil_setStorageAt', [token, keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [smart, slot])), toHex(amount, { size: 32 })]);
    assert.equal(await client.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [smart] }), amount);
  }
  const holdings: Holding[] = [
    { asset: wbnb, amountWei: 10n ** 17n, decimals: 18, usdPriceE8: wbnbUnit / 10n ** 10n },
    { asset: eth, amountWei: 10n ** 16n, decimals: 18, usdPriceE8: ethUnit / 10n ** 10n },
    { asset: usdt, amountWei: 0n, decimals: 18, usdPriceE8: 100000000n },
  ];
  const limits = new Map(targets.map((target) => [target.asset.toLowerCase(), null]));
  const plan = async () => planRebalance({ publicClient: client, account: smart, executor, oracle, registry, strategyId,
    holdings, targets, drift: computeDrift(holdings, targets, 100), thresholdBps: 100,
    blockNumber: await client.getBlockNumber({ cacheTime: 0 }), maxLegUsdE8: limits, maxImpactBps: null }, { quoteAggregator: async () => null });
  assert.ok((await checkSecondarySources(client, oracle, [wbnb, eth], true)).every((check) => check.level === 'ok'));
  snapshot = await local('evm_snapshot');
  await local('evm_increaseTime', [61]); await local('evm_mine');
  const strict = await checkSecondarySources(client, oracle, [wbnb, eth], true);
  assert.ok(strict.some((check) => check.level === 'fail' && check.detail.includes('StaleFeed')));
  const blocked = await plan(); assert.ok(blocked.kind === 'ready', blocked.kind === 'ready' ? '' : blocked.reason);
  assert.equal(blocked.steps.length, 1); assert.equal(blocked.steps[0]?.tokenIn, eth); assert.match(blocked.rationale, /StaleFeed/);
  await query("delete from scheduler_alerts where kind = 'price_source_unavailable'");
  const tracker = createPriceSourceTracker();
  const alerts = async () => (await listOpenAlerts(query)).filter((alert) => alert.kind === 'price_source_unavailable');
  const round = () => announceAlerts({ query, now: new Date(), chainId: 56, executorPaused: false,
    priceSourceChecks: () => inspectPriceSources(client, oracle, [wbnb, eth]), priceSourceTracker: tracker,
    gasChecks: { readGasPrice: async () => 0n, readNativeBalance: async () => 0n }, sendNotification: async () => {}, log: () => {} });
  for (let count = 1; count <= 3; count += 1) { await round(); assert.equal((await alerts()).length, count < 3 ? 0 : 1); }
  assert.equal((await alerts())[0]?.portfolioId, null); assert.equal((await alerts())[0]?.severity, 'critical');
  const fresh = await refreshFloors({ publicClient: client, oracle, executor, deadline: blocked.deadline, steps: blocked.steps, feeBps: 0 });
  assert.ok(fresh.ok, fresh.ok ? '' : fresh.reason);
  const receipt = await landed(await wallet.writeContract({ address: smart, abi: mockAbi, functionName: 'executeRebalance', args: [executor, fresh.steps, blocked.deadline] }));
  const logs = receipt.logs.filter((log) => log.address.toLowerCase() === executor.toLowerCase())
    .map((log) => decodeEventLog({ abi: executorAbi, eventName: 'SwapExecuted', data: log.data, topics: log.topics }));
  assert.equal(logs.length, 1); assert.equal(logs[0]?.args.tokenIn, eth);
  assert.ok(logs[0].args.gross >= logs[0].args.oracleFloor);
  const executedStep = fresh.steps[0]; assert.ok(executedStep);
  assert.ok(executedStep.amountIn > 0n && executedStep.amountIn <= 10n ** 16n);
  assert.equal(await client.readContract({ address: eth, abi: erc20, functionName: 'balanceOf', args: [smart] }), 10n ** 16n - executedStep.amountIn);
  assert.ok(await client.readContract({ address: usdt, abi: erc20, functionName: 'balanceOf', args: [smart] }) > 0n);
  assert.equal(await local('evm_revert', [snapshot]), true); snapshot = undefined;
  await round(); assert.equal((await alerts()).length, 0);
  const recovered = await plan(); assert.ok(recovered.kind === 'ready'); assert.equal(recovered.steps.length, 2);
  console.log(`#52 fork: stale asset blocked=1; healthy SwapExecuted=1; critical round=3; global rows=1; recovered rows=0; tx=${receipt.transactionHash}`);
});
