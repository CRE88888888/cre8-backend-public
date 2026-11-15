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
import { announceAlerts, createSchedulerPriceSourceTracker } from '../src/scheduler.js';
import { checkSecondarySources } from '../scripts/preflight.js';
import { computeDrift } from '../src/drift.js';
import type { Holding } from '../src/drift.js';
import { planRebalance, refreshFloors } from '../src/rebalance-plan.js';
import { chooseBestPath } from '../src/routing.js';
import { pancakeRoutingForChain } from '../src/addresses.js';

const rpc = 'http://127.0.0.1:8557';
const account = mnemonicToAccount('test test test test test test test test test test test junk');
const client = createPublicClient({ chain: bsc, transport: http(rpc, { timeout: 120000, retryCount: 0 }) });
const wallet = createWalletClient({ account, chain: bsc, transport: http(rpc) });
const wbnb = getAddress('0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c');
const eth = getAddress('0x2170ed0880ac9a755fd29b2688956bd959f933f8');
const usdt = getAddress('0x55d398326f99059ff775485246999027b3197955');
const registryAbi = parseAbi(['constructor()', 'function setOperator(address)', 'function enroll(address,uint256)',
  'function registerStrategy(string,string,bool) returns(uint256)', 'function publishVersion(uint256,address[],uint16[],bytes32,uint64) returns(uint16)']);
const oracleAbi = parseAbi(['constructor(address)', 'function setOracle(address,address,uint32,uint16,uint32) returns(address)',
  'function setSecondary(address,address,address,uint32,uint32,uint16) returns(address)',
  'error TwapUnavailable()', 'function clearSecondary(address)', 'function previewSwap(address,address,uint256) view returns(uint256,uint256)']);
const executorAbi = parseAbi(['constructor(address,address,address,address,address,address,uint16,uint256)',
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
  const artifact: unknown = JSON.parse(await readFile(`${process.env.CONTRACTS_DIR ?? '.bun-cache/issue-76/contracts'}/out/${source}/${name}.json`, 'utf8'));
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
  const db = new URL(process.env.DATABASE_URL ?? ''); assert.equal(db.pathname, '/cre8_x1c');
  assert.ok(['', 'localhost', '127.0.0.1'].includes(db.hostname));
  assert.equal((await query<{ name: string }>('select current_database() as name')).rows[0]?.name, 'cre8_x1c');
  await local('anvil_nodeInfo'); assert.equal(await client.getChainId(), 56);
  snapshot = await local('evm_snapshot');
  await local('anvil_setBlockTimestampInterval', [0]);
  const registry = await deployed(await wallet.deployContract({ abi: registryAbi, bytecode: await bytecode('AtpRegistry.sol', 'AtpRegistry') }));
  const oracle = await deployed(await wallet.deployContract({ abi: oracleAbi, bytecode: await bytecode('AtpMultiPoolOracle.sol', 'AtpMultiPoolOracle'), args: [usdt] }));
  // Retain #52's pools/slippage: this fixture isolates source failures, not the mainnet tier sizing.
  for (const [asset, pool] of [[wbnb, getAddress('0x36696169c63e42cd08ce11f5deebbcebae652050')], [eth, getAddress('0x9f599f3d64a9d99ea21e68127bb6ce99f893da61')]] as const) {
    await landed(await wallet.writeContract({ address: oracle, abi: oracleAbi, functionName: 'setOracle', args: [asset, pool, 1800, 300, 3600] }));
  }
  const [wbnbUnit] = await client.readContract({ address: oracle, abi: oracleAbi, functionName: 'previewSwap', args: [wbnb, usdt, 10n ** 18n] });
  const [ethUnit] = await client.readContract({ address: oracle, abi: oracleAbi, functionName: 'previewSwap', args: [eth, usdt, 10n ** 18n] });
  const assetFeed = await deployed(await wallet.deployContract({ abi: feedAbi, bytecode: await bytecode('AtpMultiPoolOracleSecondary.t.sol', 'MockAggregator'), args: [8, wbnbUnit / 10n ** 10n] }));
  const cashFeed = await deployed(await wallet.deployContract({ abi: feedAbi, bytecode: await bytecode('AtpMultiPoolOracleSecondary.t.sol', 'MockAggregator'), args: [8, 100000000n] }));
  await landed(await wallet.writeContract({ address: oracle, abi: oracleAbi, functionName: 'setSecondary', args: [wbnb, assetFeed, cashFeed, 60, 2700, 1000] }));
  const executor = await deployed(await wallet.deployContract({ abi: executorAbi, bytecode: await bytecode('AtpExecutor.sol', 'AtpExecutor'),
    args: [registry, PANCAKE_UR, oracle, getAddress('0x31c2f6fcff4f8759b3bd5bf0e1084a055615c768'), account.address, usdt, 10000, 0n] }));
  const smart = await deployed(await wallet.deployContract({ abi: mockAbi, bytecode: await bytecode('AtpExecutorFork.t.sol', 'MockSmartAccount') }));
  await landed(await wallet.writeContract({ address: registry, abi: registryAbi, functionName: 'setOperator', args: [account.address] }));
  const registered = await client.simulateContract({ account, address: registry, abi: registryAbi, functionName: 'registerStrategy', args: ['#52 isolated secondary', '', true] });
  await landed(await wallet.writeContract(registered.request)); const strategyId = registered.result;
  const targets = [{ asset: wbnb, weightBps: 0 }, { asset: eth, weightBps: 0 }, { asset: usdt, weightBps: 10000 }];
  await landed(await wallet.writeContract({ address: registry, abi: registryAbi, functionName: 'publishVersion', args: [strategyId, targets.map((target) => target.asset), targets.map((target) => target.weightBps), toHex(0, { size: 32 }), 0n] }));
  await landed(await wallet.writeContract({ address: registry, abi: registryAbi, functionName: 'enroll', args: [smart, strategyId] }));
  for (const token of [wbnb, eth]) await landed(await wallet.writeContract({ address: smart, abi: mockAbi, functionName: 'approveToken', args: [token, executor, (1n << 256n) - 1n] }));
  for (const [token, slot, amount] of [[wbnb, 3n, 2n * 10n ** 17n], [eth, 1n, 10n ** 17n]] as const) {
    await local('anvil_setStorageAt', [token, keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [smart, slot])), toHex(amount, { size: 32 })]);
    assert.equal(await client.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [smart] }), amount);
  }
  const holdings: Holding[] = [
    { asset: wbnb, amountWei: 2n * 10n ** 17n, decimals: 18, usdPriceE8: wbnbUnit / 10n ** 10n },
    { asset: eth, amountWei: 10n ** 17n, decimals: 18, usdPriceE8: ethUnit / 10n ** 10n },
    { asset: usdt, amountWei: 0n, decimals: 18, usdPriceE8: 100000000n },
  ];
  const limits = new Map(targets.map((target) => [target.asset.toLowerCase(), null]));
  const plan = async () => planRebalance({ publicClient: client, account: smart, executor, oracle, registry, strategyId,
    holdings, targets, drift: computeDrift(holdings, targets, 100), thresholdBps: 100,
    blockNumber: await client.getBlockNumber({ cacheTime: 0 }), maxLegUsdE8: limits, maxImpactBps: null }, { quoteAggregator: async () => null });
  // Cold anvil storage fetches can exceed the product's five-second quote budget (pitfalls #47/#54).
  // Warm real candidate calls at this block, retaining the normal product timeout and real floor.
  const warmBlock = await client.getBlockNumber({ cacheTime: 0 });
  for (const [tokenIn, amountIn, pinnedFee] of [[wbnb, 2n * 10n ** 17n, 500], [eth, 10n ** 17n, 100]] as const) {
    const route = await chooseBestPath(client, { tokenIn, tokenOut: usdt, amountIn, pinnedFee, blockNumber: warmBlock, ...pancakeRoutingForChain(56) });
    assert.ok(route, 'real Pancake route required to warm the isolated fork');
  }
  assert.ok((await checkSecondarySources(client, oracle, [wbnb, eth], true)).every((check) => check.level === 'ok'));
  const healthySnapshot = await local('evm_snapshot');
  await local('evm_setNextBlockTimestamp', [Number((await client.getBlock()).timestamp) + 61]); await local('evm_mine');
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
  assert.ok(executedStep.amountIn > 0n && executedStep.amountIn <= 10n ** 17n);
  assert.equal(await client.readContract({ address: eth, abi: erc20, functionName: 'balanceOf', args: [smart] }), 10n ** 17n - executedStep.amountIn);
  assert.ok(await client.readContract({ address: usdt, abi: erc20, functionName: 'balanceOf', args: [smart] }) > 0n);
  assert.equal(await local('evm_revert', [healthySnapshot]), true);
  await round(); assert.equal((await alerts()).length, 0);
  const recovered = await plan(); assert.ok(recovered.kind === 'ready'); assert.equal(recovered.steps.length, 2);
  console.log(`#52 fork: stale asset blocked=1; healthy SwapExecuted=1; critical round=3; global rows=1; recovered rows=0; tx=${receipt.transactionHash}`);

  // #76: a real pool with no secondary must still block the whole ordinary batch.
  await landed(await wallet.writeContract({ address: oracle, abi: oracleAbi, functionName: 'clearSecondary', args: [wbnb] }));
  const pool = getAddress('0x36696169c63e42cd08ce11f5deebbcebae652050');
  const poolAbi = parseAbi(['function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint32,bool)',
    'function observations(uint256) view returns(uint32,int56,uint160,bool)']);
  const slot0 = await client.readContract({ address: pool, abi: poolAbi, functionName: 'slot0' });
  const observation = await client.readContract({ address: pool, abi: poolAbi, functionName: 'observations', args: [BigInt(slot0[2])] });
  const observationSlot = toHex(9n + BigInt(slot0[2]));
  const observationWord = await client.getStorageAt({ address: pool, slot: observationSlot }); assert.ok(observationWord);
  assert.equal(BigInt(observationWord) & 0xffffffffn, BigInt(observation[0]), 'verify real Pancake observation storage layout before modifying it');
  const at = (await client.getBlock()).timestamp;
  await local('anvil_setStorageAt', [pool, observationSlot,
    toHex((BigInt(observationWord) & ~0xffffffffn) | ((at - 3601n) & 0xffffffffn), { size: 32 })]);
  const unavailable = await plan(); assert.equal(unavailable.kind, 'blocked'); assert.match(unavailable.reason, /\[ORACLE_UNAVAILABLE:WBNB\]/);
  const nonce = await client.getTransactionCount({ address: account.address });
  const twapTracker = createSchedulerPriceSourceTracker({}); const messages: string[] = [];
  const twapRound = () => announceAlerts({ query, now: new Date(), chainId: 56, executorPaused: false, dryRun: false,
    priceSourceChecks: () => inspectPriceSources(client, oracle, [wbnb, eth]), priceSourceTracker: twapTracker,
    gasChecks: { readGasPrice: async () => 0n, readNativeBalance: async () => 0n }, sendNotification: async (message) => { messages.push(message); }, log: () => {} });
  for (let n = 1; n <= 6; n += 1) { await twapRound(); assert.equal((await alerts()).length, n < 6 ? 0 : 1); }
  await twapRound(); assert.equal(messages.length, 1);
  assert.equal(await client.getTransactionCount({ address: account.address }), nonce, 'unavailable rounds send no transactions');
  assert.equal(await client.readContract({ address: eth, abi: erc20, functionName: 'balanceOf', args: [smart] }), 10n ** 17n);
  await local('anvil_setStorageAt', [pool, observationSlot, observationWord]);
  await twapRound(); assert.equal((await alerts()).length, 0); assert.equal(messages.length, 2);
  const retried = await plan(); assert.ok(retried.kind === 'ready'); assert.equal(retried.steps.length, 2);

  // Cardinality < 2 gives the same typed failure, with no fallback to spot or secondary.
  const rawSlot0 = await client.getStorageAt({ address: pool, slot: '0x0' }); assert.ok(rawSlot0);
  const cardinalityMask = 0xffffn << 200n;
  assert.equal((BigInt(rawSlot0) & cardinalityMask) >> 200n, BigInt(slot0[3]));
  await local('anvil_setStorageAt', [pool, '0x0', toHex((BigInt(rawSlot0) & ~cardinalityMask) | (1n << 200n), { size: 32 })]);
  const immature = await plan(); assert.equal(immature.kind, 'blocked'); assert.match(immature.reason, /ORACLE_UNAVAILABLE:WBNB/);
  await local('anvil_setStorageAt', [pool, '0x0', rawSlot0]);

  // The oracle allows exactly maxOracleAge; one second later it fails closed.
  const boundarySnapshot = await local('evm_snapshot');
  await local('evm_setNextBlockTimestamp', [observation[0] + 3600]); await local('evm_mine');
  const boundary = await client.readContract({ address: oracle, abi: oracleAbi, functionName: 'previewSwap', args: [wbnb, usdt, 10n ** 18n] });
  assert.ok(boundary[0] > 0n && boundary[1] > 0n);
  await local('evm_setNextBlockTimestamp', [observation[0] + 3601]); await local('evm_mine');
  await assert.rejects(client.readContract({ address: oracle, abi: oracleAbi, functionName: 'previewSwap', args: [wbnb, usdt, 10n ** 18n] }), /TwapUnavailable/);
  assert.equal(await local('evm_revert', [boundarySnapshot]), true);
  console.log('#76 fork: idle batch blocked; no-secondary critical round=6; Telegram opened/resolved=2; cardinality=1 blocked; age=3600 accepted/3601 blocked; retry steps=2');
});
