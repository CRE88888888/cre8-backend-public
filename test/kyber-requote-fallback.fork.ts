/** Explicit command only: real swaps on the isolated #54 anvil; never a mainnet signer. */
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { createPublicClient, createWalletClient, decodeEventLog, encodeAbiParameters, getAddress, http, isHex, keccak256, parseAbi, toHex } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { bsc } from 'viem/chains';
import { mnemonicToAccount } from 'viem/accounts';
import { quoteKyberSwap } from '../src/aggregator.js';
import { buildRedeemPlan } from '../src/operator.js';
import { readContract } from 'viem/actions';
import { chooseBestPath, V3_QUOTER } from '../src/routing.js';
import { V3_FACTORY_ADDRESS, WBNB_ADDRESS } from '../src/addresses.js';
import { NUMERAIRE_PRICE_SOURCE, TWAP_PRICE_SOURCE } from '../src/positions.js';
import type { PortfolioPlan } from '../src/snapshot.js';
import { closePool, query } from '../src/db.js';
import { computeDrift } from '../src/drift.js';
import { planRebalance, readMaxLegUsdE8, refreshFloors, PANCAKE_QUOTE_GAS_LIMIT } from '../src/rebalance-plan.js';

const rpc = 'http://127.0.0.1:8646';
const owner = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 7 });
const client = createPublicClient({ chain: bsc, transport: http(rpc) });
const wallet = createWalletClient({ account: owner, chain: bsc, transport: http(rpc) });
const USDT = getAddress('0x55d398326f99059ff775485246999027b3197955');
const ETH = getAddress('0x2170ed0880ac9a755fd29b2688956bd959f933f8');
const POOL = getAddress('0x9f599f3d64a9d99ea21e68127bb6ce99f893da61');
const UR = getAddress('0x1a0a18ac4becddbd6389559687d1a73d8927e416');
const PERMIT2 = getAddress('0x31c2f6fcff4f8759b3bd5bf0e1084a055615c768');
const registryAbi = parseAbi([
  'constructor()', 'function setOperator(address)', 'function enroll(address,uint256)',
  'function registerStrategy(string,string,bool) returns(uint256)',
  'function publishVersion(uint256,address[],uint16[],bytes32,uint64) returns(uint16)',
]);
const routerAbi = parseAbi([
  'constructor(address)', 'function setOracle(address,address,uint32,uint16,uint32) returns(address)',
  'function oracleOf(address) view returns(address)',
  'function previewSwap(address,address,uint256) view returns(uint256,uint256)',
]);
const executorAbi = parseAbi([
  'constructor(address,address,address,address,address,address,uint16)', 'function setVenue(address,uint8,address)',
  'event SwapExecuted(address indexed account,address tokenIn,address tokenOut,uint256 amountIn,uint256 gross,uint256 fee,uint256 net,uint256 oracleFloor)',
]);
const accountAbi = parseAbi([
  'constructor()', 'function approveToken(address,address,uint256)',
  'function executeRebalance(address,(address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOutMin,address venue,bytes data)[],uint256)',
]);
const erc20 = parseAbi(['function balanceOf(address) view returns(uint256)']);

async function bytecode(source: string, name: string): Promise<Hex> {
  const value: unknown = JSON.parse(await readFile(`${process.env.CONTRACT_ARTIFACTS_DIR ?? '.bun-cache/issue54/contracts/out'}/${source}/${name}.json`, 'utf8'));
  assert.ok(typeof value === 'object' && value !== null);
  const code: unknown = Reflect.get(value, 'bytecode');
  assert.ok(typeof code === 'object' && code !== null);
  const object: unknown = Reflect.get(code, 'object');
  assert.ok(typeof object === 'string' && isHex(object) && object.length > 2);
  return object;
}
async function receipt(hash: Hex) {
  await local('evm_mine', []);
  const result = await client.waitForTransactionReceipt({ hash });
  assert.equal(result.status, 'success');
  return result;
}
async function deployed(hash: Hex): Promise<Address> {
  const result = await receipt(hash); assert.ok(result.contractAddress); return result.contractAddress;
}
async function local(method: string, params: readonly unknown[]) {
  const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const result: unknown = await response.json();
  assert.ok(typeof result === 'object' && result !== null && !('error' in result), method);
  return Reflect.get(result, 'result');
}

after(closePool);

test('#54 null Kyber refresh: first allocation and redeem execute on Pancake with real receipts', async () => {
  assert.equal(process.env.RUN_CHAIN_TESTS, '1');
  assert.equal(process.env.RPC_URL, rpc);
  const dbUrl = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(dbUrl.pathname, '/cre8_x1k');
  assert.ok(['', 'localhost', '127.0.0.1'].includes(dbUrl.hostname));
  assert.equal((await query<{ name: string }>('select current_database() as name')).rows[0]?.name, 'cre8_x1k');
  await local('anvil_nodeInfo', []);
  assert.equal(await client.getChainId(), 56);
  console.log('[fork #54] local guards passed; deploying contracts');
  const registry = await deployed(await wallet.deployContract({ abi: registryAbi, bytecode: await bytecode('AtpRegistry.sol', 'AtpRegistry') }));
  const router = await deployed(await wallet.deployContract({ abi: routerAbi, bytecode: await bytecode('AtpMultiPoolOracle.sol', 'AtpMultiPoolOracle'), args: [USDT] }));
  await receipt(await wallet.writeContract({ address: router, abi: routerAbi, functionName: 'setOracle', args: [ETH, POOL, 1800, 100, 3600] }));
  await receipt(await wallet.writeContract({ address: router, abi: routerAbi, functionName: 'setOracle', args: [WBNB_ADDRESS, getAddress('0x36696169c63e42cd08ce11f5deebbcebae652050'), 1800, 100, 3600] }));
  const executor = await deployed(await wallet.deployContract({ abi: executorAbi, bytecode: await bytecode('AtpExecutor.sol', 'AtpExecutor'), args: [registry, UR, router, PERMIT2, owner.address, USDT, 10000] }));
  const kyber = getAddress('0x6131B5fae19EA4f9D964eAc0408E4408b66337b5');
  await receipt(await wallet.writeContract({ address: executor, abi: executorAbi, functionName: 'setVenue', args: [kyber, 2, kyber] }));
  const account = await deployed(await wallet.deployContract({ abi: accountAbi, bytecode: await bytecode('AtpExecutorFork.t.sol', 'MockSmartAccount') }));
  await receipt(await wallet.writeContract({ address: registry, abi: registryAbi, functionName: 'setOperator', args: [owner.address] }));
  const registered = await client.simulateContract({ account: owner, address: registry, abi: registryAbi, functionName: 'registerStrategy', args: ['#54 ETH 50%', 'isolated anvil acceptance', true] });
  await receipt(await wallet.writeContract(registered.request));
  const strategyId = registered.result;
  await receipt(await wallet.writeContract({ address: registry, abi: registryAbi, functionName: 'publishVersion', args: [strategyId, [ETH, USDT], [5000, 5000], toHex(0, { size: 32 }), 0n] }));
  await receipt(await wallet.writeContract({ address: registry, abi: registryAbi, functionName: 'enroll', args: [account, strategyId] }));
  for (const token of [USDT, ETH]) await receipt(await wallet.writeContract({ address: account, abi: accountAbi, functionName: 'approveToken', args: [token, executor, 2n ** 256n - 1n] }));
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [account, 1n]));
  await local('anvil_setStorageAt', [USDT, slot, toHex(200n * 10n ** 18n, { size: 32 })]);
  await writeFile('.bun-cache/issue54/deployed.json', JSON.stringify({ registry, executor, router }));
  console.log('[fork #54] contracts deployed and account funded');
  const targets = [{ asset: ETH, weightBps: 5000 }, { asset: USDT, weightBps: 5000 }];
  const limits = await readMaxLegUsdE8([ETH, USDT]);
  // Simulate unavailable Pancake at planning only; Kyber data and output are real, never inflated.
  const planningClient: PublicClient = { ...client, call: (request) => {
    if (request.to?.toLowerCase() === V3_QUOTER.toLowerCase()) return Promise.reject(new Error('injected planning quoter outage'));
    return client.call(request);
  }, readContract: (request) => readContract(planningClient, request) };
  const observed = async () => {
    const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
    const cash = await client.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [account], blockNumber });
    const eth = await client.readContract({ address: ETH, abi: erc20, functionName: 'balanceOf', args: [account], blockNumber });
    const [unitQuote] = await client.readContract({ address: router, abi: routerAbi, functionName: 'previewSwap', args: [ETH, USDT, 10n ** 18n], blockNumber });
    const holdings: PortfolioPlan['snapshot']['holdings'] = [{ asset: USDT, amountWei: cash, decimals: 18, usdPriceE8: 100000000n, priceSource: NUMERAIRE_PRICE_SOURCE },
      { asset: ETH, amountWei: eth, decimals: 18, usdPriceE8: unitQuote / 10n ** 10n, priceSource: TWAP_PRICE_SOURCE }];
    return { blockNumber, holdings, drift: computeDrift(holdings, targets, 100) };
  };
  console.log('[fork #54] observing holdings and planning real Kyber allocation');
  const before = await observed();
  const plan = await planRebalance({ publicClient: planningClient, account, executor, registry, oracle: router,
    strategyId, holdings: before.holdings, targets, drift: before.drift, thresholdBps: 100,
    blockNumber: before.blockNumber, maxLegUsdE8: limits, maxImpactBps: null }, { quoteAggregator: quoteKyberSwap });
  assert.ok(plan.kind === 'ready', plan.kind === 'ready' ? '' : plan.reason);
  assert.equal(plan.steps.length, 1); assert.equal(plan.steps[0]?.venue, kyber);
  let nullRefreshes = 0;
  const execute = async (planned: typeof plan, label: string) => {
    // Capture a fresh pre-send block, then warm and refresh against that same snapshot.
    const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
    // Warm cold fork state before starting the production five-second fallback budget.
    const quoteClient: PublicClient = { ...client, call: (request) => client.call({ ...request, gas: PANCAKE_QUOTE_GAS_LIMIT }),
      readContract: (request) => readContract(quoteClient, request) };
    for (const step of planned.steps) {
      const route = await chooseBestPath(quoteClient, { ...step, factory: V3_FACTORY_ADDRESS, via: WBNB_ADDRESS, pinnedFee: null, blockNumber });
      assert.ok(route, 'real Pancake route required');
      console.log(`[fork #54 ${label}] warmed Pancake=${route.amountOut}; planned-min=${step.amountOutMin}`);
    }
    const logs: string[] = [];
    const fresh = await refreshFloors({ publicClient: client, oracle: router, executor, account, steps: planned.steps,
      deadline: planned.deadline, feeBps: 0, blockNumber, log: (line) => logs.push(line),
      quoteAggregator: async () => { nullRefreshes += 1; return null; } });
    assert.ok(fresh.ok, fresh.ok ? '' : fresh.reason);
    assert.ok(logs.some((line) => line.includes('api-failed')));
    assert.ok(fresh.steps.every((step) => step.venue === UR));
    const gas = await client.estimateContractGas({ account: owner, address: account, abi: accountAbi,
      functionName: 'executeRebalance', args: [executor, fresh.steps, planned.deadline] });
    const landed = await receipt(await wallet.writeContract({ address: account, abi: accountAbi,
      functionName: 'executeRebalance', args: [executor, fresh.steps, planned.deadline], gas: gas * 3n / 2n }));
    const swaps = landed.logs.filter((log) => log.address.toLowerCase() === executor.toLowerCase()).map((log) =>
      decodeEventLog({ abi: executorAbi, data: log.data, topics: log.topics }));
    assert.equal(swaps.length, fresh.steps.length);
    swaps.forEach((event, index) => {
      const step = fresh.steps[index]; assert.ok(step);
      assert.equal(event.args.amountIn, step.amountIn);
      assert.ok(event.args.gross >= event.args.oracleFloor && event.args.gross >= step.amountOutMin);
      console.log(`[fork #54 ${label}] receipt=${landed.transactionHash}; input=${step.amountIn}; gross=${event.args.gross}; floor=${event.args.oracleFloor}`);
    });
    return landed;
  };
  await execute(plan, 'first-allocation');
  const invested = await observed(); assert.ok((invested.holdings[1]?.amountWei ?? 0n) > 0n);
  const portfolioPlan: PortfolioPlan = {
    portfolioId: 54, strategyId: 54, account, chainId: 56,
    snapshot: { portfolioId: 54, block: invested.blockNumber, nativeBalanceWei: 0n, holdings: invested.holdings, unpriced: [] },
    scan: { portfolioId: 54, block: invested.blockNumber, cursor: { portfolioId: 54, startBlock: invested.blockNumber, lastScannedBlock: invested.blockNumber },
      scannedRange: null, candidateCount: 0, unknownHoldings: [], zeroBalanceCount: 0, unreadableCandidates: [],
      deployment: { block: null, reason: 'rpc_cannot_answer', detail: 'unused scan fixture for redeem planner' }, universeComplete: false, incompleteReasons: ['scan is outside this test'] },
    report: invested.drift, blocked: [], targets: targets.map((target) => ({ ...target, symbol: target.asset === ETH ? 'ETH' : 'USDT' })),
    pinnedVersion: { version: 1, onchainStrategyId: Number(strategyId), paused: false },
    allocationCheck: { consistent: true, chain: [], mismatches: [] }, thresholdBps: 100,
  };
  const redemption = await buildRedeemPlan({ portfolioId: 54, account, plan: portfolioPlan }, { sellUsdE8: 10n * 100000000n },
    { publicClient: planningClient, executor, registry, quoteAggregator: quoteKyberSwap });
  assert.ok(redemption.plan.kind === 'ready', redemption.plan.kind === 'ready' ? '' : redemption.plan.reason);
  assert.equal(redemption.plan.steps.length, 1); assert.equal(redemption.plan.steps[0]?.venue, kyber);
  const cashBefore = invested.holdings[0]?.amountWei; assert.ok(cashBefore);
  await execute(redemption.plan, 'redeem');
  assert.ok((await observed()).holdings[0]!.amountWei > cashBefore);
  assert.equal(nullRefreshes, 2);
  // Public addresses only, for subsequent read-only crosschecks on this task-owned anvil.
  await writeFile('.bun-cache/issue54/deployed.json', JSON.stringify({ registry, executor, router }));
  console.log(`[fork #54] null-refreshes=${nullRefreshes}; first-allocation=1; redeem=1; local-only=8646`);
});
