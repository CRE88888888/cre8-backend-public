/** Explicit command only: real swaps on the isolated #40 anvil; never a mainnet signer. */
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createPublicClient, createWalletClient, decodeEventLog, encodeAbiParameters, getAddress, http, isHex, keccak256, parseAbi, toHex } from 'viem';
import type { Address, Hex } from 'viem';
import { bsc } from 'viem/chains';
import { mnemonicToAccount } from 'viem/accounts';
import { closePool, query } from '../src/db.js';
import { computeDrift } from '../src/drift.js';
import type { Holding } from '../src/drift.js';
import { planRebalance, readMaxLegUsdE8 } from '../src/rebalance-plan.js';

const rpc = 'http://127.0.0.1:8586';
const owner = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 7 });
const client = createPublicClient({ chain: bsc, transport: http(rpc) });
const wallet = createWalletClient({ account: owner, chain: bsc, transport: http(rpc) });
const USDT = getAddress('0x55d398326f99059ff775485246999027b3197955');
const DOGE = getAddress('0xba2ae424d960c26247dd6c32edc70b295c744c43');
const POOL = getAddress('0x89da4102853c6cf3f4e9979cbb1dc4a166f38e84');
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
  'constructor(address,address,address,address,address,address,uint16)',
  'event SwapExecuted(address indexed account,address tokenIn,address tokenOut,uint256 amountIn,uint256 gross,uint256 fee,uint256 net,uint256 oracleFloor)',
]);
const accountAbi = parseAbi([
  'constructor()', 'function approveToken(address,address,uint256)',
  'function executeRebalance(address,(address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOutMin,address venue,bytes data)[],uint256)',
]);
const erc20 = parseAbi(['function balanceOf(address) view returns(uint256)']);
let snapshotId: unknown;

async function bytecode(source: string, name: string): Promise<Hex> {
  const value: unknown = JSON.parse(await readFile(`${process.env.CONTRACT_ARTIFACTS_DIR ?? '.bun-cache/contracts-47/out'}/${source}/${name}.json`, 'utf8'));
  assert.ok(typeof value === 'object' && value !== null);
  const code: unknown = Reflect.get(value, 'bytecode');
  assert.ok(typeof code === 'object' && code !== null);
  const object: unknown = Reflect.get(code, 'object');
  assert.ok(typeof object === 'string' && isHex(object) && object.length > 2);
  return object;
}
async function receipt(hash: Hex) {
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

after(async () => {
  if (typeof snapshotId === 'string') await local('evm_revert', [snapshotId]);
  await closePool();
});

test('#40 DOGE direct pool: 2000 USDT / 10% target converges across capped rounds; every real swap clears the floor', async () => {
  assert.equal(process.env.RUN_CHAIN_TESTS, '1');
  assert.equal(process.env.RPC_URL, rpc);
  assert.equal((await query<{ name: string }>('select current_database() as name')).rows[0]?.name, 'cre8_x1e');
  await local('anvil_nodeInfo', []);
  assert.equal(await client.getChainId(), 56);
  snapshotId = await local('evm_snapshot', []);
  const registry = await deployed(await wallet.deployContract({ abi: registryAbi, bytecode: await bytecode('AtpRegistry.sol', 'AtpRegistry') }));
  const router = await deployed(await wallet.deployContract({ abi: routerAbi, bytecode: await bytecode('AtpMultiPoolOracle.sol', 'AtpMultiPoolOracle'), args: [USDT] }));
  await receipt(await wallet.writeContract({ address: router, abi: routerAbi, functionName: 'setOracle', args: [DOGE, POOL, 1800, 300, 3600] }));
  const oracle = await client.readContract({ address: router, abi: routerAbi, functionName: 'oracleOf', args: [DOGE] });
  const executor = await deployed(await wallet.deployContract({ abi: executorAbi, bytecode: await bytecode('AtpExecutor.sol', 'AtpExecutor'), args: [registry, UR, router, PERMIT2, owner.address, USDT, 10000] }));
  const account = await deployed(await wallet.deployContract({ abi: accountAbi, bytecode: await bytecode('AtpExecutorFork.t.sol', 'MockSmartAccount') }));
  await receipt(await wallet.writeContract({ address: registry, abi: registryAbi, functionName: 'setOperator', args: [owner.address] }));
  const registered = await client.simulateContract({ account: owner, address: registry, abi: registryAbi, functionName: 'registerStrategy', args: ['#40 DOGE 10%', 'isolated anvil acceptance', true] });
  await receipt(await wallet.writeContract(registered.request));
  const strategyId = registered.result;
  await receipt(await wallet.writeContract({ address: registry, abi: registryAbi, functionName: 'publishVersion', args: [strategyId, [DOGE, USDT], [1000, 9000], toHex(0, { size: 32 }), 0n] }));
  await receipt(await wallet.writeContract({ address: registry, abi: registryAbi, functionName: 'enroll', args: [account, strategyId] }));
  for (const token of [USDT, DOGE]) await receipt(await wallet.writeContract({ address: account, abi: accountAbi, functionName: 'approveToken', args: [token, executor, 2n ** 256n - 1n] }));
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [account, 1n]));
  await local('anvil_setStorageAt', [USDT, slot, toHex(2000n * 10n ** 18n, { size: 32 })]);
  const targets = [{ asset: DOGE, weightBps: 1000 }, { asset: USDT, weightBps: 9000 }];
  const limits = await readMaxLegUsdE8([DOGE, USDT]);
  assert.equal(limits.get(DOGE.toLowerCase()), 15000000000n);
  const observed = async () => {
    const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
    const cash = await client.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [account], blockNumber });
    const doge = await client.readContract({ address: DOGE, abi: erc20, functionName: 'balanceOf', args: [account], blockNumber });
    const [unitQuote] = await client.readContract({ address: router, abi: routerAbi, functionName: 'previewSwap', args: [DOGE, USDT, 10n ** 8n], blockNumber });
    const holdings: Holding[] = [{ asset: USDT, amountWei: cash, decimals: 18, usdPriceE8: 100000000n }, { asset: DOGE, amountWei: doge, decimals: 8, usdPriceE8: unitQuote / 10n ** 10n }];
    return { blockNumber, holdings, drift: computeDrift(holdings, targets, 100) };
  };
  assert.equal((await observed()).holdings[0]?.amountWei, 2000n * 10n ** 18n);
  let rounds = 0;
  let swaps = 0;
  for (; rounds < 6; rounds += 1) {
    const before = await observed();
    if (!before.drift.needsRebalance) break;
    // Pinned per-pair oracle forces the researched direct pool. Disable the optional impact
    // estimator only for this acceptance: its 80bps default is below this pool's 100bps fee.
    const plan = await planRebalance({ publicClient: client, account, executor, registry, oracle,
      strategyId, holdings: before.holdings, targets, drift: before.drift, thresholdBps: 100,
      blockNumber: before.blockNumber, maxLegUsdE8: limits, maxImpactBps: null });
    assert.ok(plan.kind === 'ready', plan.kind === 'ready' ? '' : plan.reason);
    assert.equal(plan.steps.length, 1);
    const step = plan.steps[0]; assert.ok(step);
    assert.equal(step.tokenIn.toLowerCase(), USDT.toLowerCase());
    assert.ok(step.amountIn <= 150n * 10n ** 18n);
    if (rounds === 0) assert.equal(step.amountIn, 150n * 10n ** 18n);
    // Anvil's exact estimate can run out at the reentrancy sentry on a later batch;
    // keep the same 1.5x estimation margin used by the production send pipeline.
    const gas = await client.estimateContractGas({ account: owner, address: account, abi: accountAbi,
      functionName: 'executeRebalance', args: [executor, plan.steps, plan.deadline] });
    const landed = await receipt(await wallet.writeContract({ address: account, abi: accountAbi,
      functionName: 'executeRebalance', args: [executor, plan.steps, plan.deadline], gas: gas * 3n / 2n }));
    for (const log of landed.logs) {
      if (log.address.toLowerCase() !== executor.toLowerCase()) continue;
      const event = decodeEventLog({ abi: executorAbi, data: log.data, topics: log.topics });
      assert.ok(event.args.gross >= event.args.oracleFloor);
      assert.ok(event.args.gross >= step.amountOutMin);
      swaps += 1;
      console.log(`[DOGE fork round ${rounds + 1}] input=${step.amountIn} gross=${event.args.gross} floor=${event.args.oracleFloor}`);
    }
    await local('evm_increaseTime', [1800]); await local('evm_mine', []);
  }
  const after = await observed();
  assert.ok(rounds >= 2 && rounds < 6);
  assert.equal(swaps, rounds);
  assert.equal(after.drift.needsRebalance, false);
  const doge = after.drift.assets.find((asset) => asset.asset.toLowerCase() === DOGE.toLowerCase());
  assert.ok(doge && Math.abs(doge.currentBps - 1000) < 100);
  console.log(`[DOGE fork result] rounds=${rounds}; swaps=${swaps}; DOGE=${doge.currentBps}bps target=1000bps; drift=${after.drift.grossDriftBps}bps`);
});
