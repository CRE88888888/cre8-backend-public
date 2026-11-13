/** Explicit acceptance only; every mutation is guarded to #47's isolated local fork and DB. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { createKernelAccount, createKernelAccountClient } from '@zerodev/sdk';
import { KERNEL_V3_3 } from '@zerodev/sdk/constants';
import { createPublicClient, createWalletClient, decodeEventLog, encodeAbiParameters, encodeFunctionData, getAddress,
  http, isHex, keccak256, parseAbi, toHex, zeroAddress } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';
import { EXECUTOR_ABI, EXECUTOR_SELECTOR, PANCAKE_UR } from '../src/chain.js';
import { readContract } from 'viem/actions';
import { chooseBestPath } from '../src/routing.js';
import { KERNEL_V3_3_ADDRESSES, V3_FACTORY_ADDRESS, WBNB_ADDRESS } from '../src/addresses.js';
import { MULTICALL3_ADDRESS } from '../src/positions.js';
import { closePool, query } from '../src/db.js';
import { enrollPortfolio } from '../src/portfolios.js';
import { createStrategy, publishVersion } from '../src/strategies.js';
import { buildRoutedStep, minGrossFor, refreshFloors, PANCAKE_QUOTE_GAS_LIMIT } from '../src/rebalance-plan.js';
import { quoteKyberSwap } from '../src/aggregator.js';
import { readRebalanceReceipt, rebalanceCallGasLimit } from '../src/scheduler.js';
import { checkVenues } from '../scripts/preflight.js';

const rpc = 'http://127.0.0.1:8616';
const bundler = 'http://127.0.0.1:3076';
const mnemonic = 'test test test test test test test test test test test junk';
const deployer = mnemonicToAccount(mnemonic);
const operator = mnemonicToAccount(mnemonic, { addressIndex: 4 });
const owner = mnemonicToAccount(mnemonic, { addressIndex: 7 });
const client = createPublicClient({ chain: bsc, transport: http(rpc, { timeout: 120000, retryCount: 0 }) });
const wallet = createWalletClient({ account: deployer, chain: bsc, transport: http(rpc) });
const usdt = getAddress('0x55d398326f99059fF775485246999027B3197955');
const doge = getAddress('0xba2ae424d960c26247dd6c32edc70b295c744c43');
const wbnb = getAddress('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c');
const eth = getAddress('0x2170ed0880ac9a755fd29b2688956bd959f933f8');
const kyber = getAddress('0x6131B5fae19EA4f9D964eAc0408E4408b66337b5');
const entryPoint = { address: KERNEL_V3_3_ADDRESSES.entryPointV07, version: '0.7' } as const;
const registryAbi = parseAbi(['constructor()', 'function setOperator(address)', 'function transferOwnership(address)', 'function acceptOwnership()']);
const routerAbi = parseAbi(['constructor(address)', 'function setOracle(address,address,uint32,uint16,uint32) returns(address)',
  'function previewSwap(address,address,uint256) view returns(uint256,uint256)', 'function transferOwnership(address)', 'function acceptOwnership()']);
const executorAbi = parseAbi(['constructor(address,address,address,address,address,address,uint16)', 'function setVenue(address,uint8,address)', 'function removeVenue(address)',
  'event SwapExecuted(address indexed account,address tokenIn,address tokenOut,uint256 amountIn,uint256 gross,uint256 fee,uint256 net,uint256 oracleFloor)']);
const tokenAbi = parseAbi(['function approve(address,uint256) returns(bool)', 'function balanceOf(address) view returns(uint256)',
  'function decimals() view returns(uint8)']);

async function local(method: string, params: readonly unknown[] = []) {
  const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const result: unknown = await response.json();
  assert.ok(typeof result === 'object' && result !== null && !('error' in result), `local RPC ${method} failed`);
  return Reflect.get(result, 'result');
}
async function bytecode(source: string, name: string): Promise<Hex> {
  const artifact: unknown = JSON.parse(await readFile(`${process.env.CONTRACT_ARTIFACTS_DIR ?? '.bun-cache/contracts-47/out'}/${source}/${name}.json`, 'utf8'));
  assert.ok(typeof artifact === 'object' && artifact !== null);
  const code: unknown = Reflect.get(artifact, 'bytecode'); assert.ok(typeof code === 'object' && code !== null);
  const object: unknown = Reflect.get(code, 'object'); assert.ok(typeof object === 'string' && isHex(object) && object.length > 2);
  return object;
}
async function landed(hash: Hex) {
  // A pending local receipt can otherwise be forwarded upstream and rejected as an archive query.
  await local('evm_mine');
  const receipt = await client.waitForTransactionReceipt({ hash }); assert.equal(receipt.status, 'success'); return receipt;
}
async function deployed(hash: Hex): Promise<Address> {
  const receipt = await landed(hash); assert.ok(receipt.contractAddress); return receipt.contractAddress;
}

after(closePool);

test('#47 latest main: Safe-whitelisted Kyber DOGE 1000 USDT, Pancake fallback, scheduler live and new session CallPolicy', async () => {
  assert.equal(process.env.RUN_CHAIN_TESTS, '1');
  assert.equal(process.env.RPC_URL, rpc);
  assert.equal(process.env.BUNDLER_URL, bundler);
  const dbUrl = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(dbUrl.pathname, '/cre8_x1h');
  assert.ok(['', 'localhost', '127.0.0.1'].includes(dbUrl.hostname));
  await local('anvil_nodeInfo'); assert.equal(await client.getChainId(), 56);
  const startingBlock = await client.getBlockNumber({ cacheTime: 0 });
  const started = Date.now();
  while (await client.getBlockNumber({ cacheTime: 0 }) < startingBlock + 120n) {
    assert.ok(Date.now() - started < 30000, 'run the isolated anvil with --block-time 0.1');
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
  // A real 2-of-3 Safe proxy, administered only via local anvil impersonation for this test.
  const safeAbi = parseAbi(['function setup(address[],uint256,address,bytes,address,address,uint256,address)',
    'function createProxyWithNonce(address,bytes,uint256) returns(address)']);
  const setup = encodeFunctionData({ abi: safeAbi, functionName: 'setup', args: [[1, 2, 3].map((addressIndex) =>
    mnemonicToAccount(mnemonic, { addressIndex }).address), 2n, zeroAddress, '0x',
    getAddress('0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99'), zeroAddress, 0n, zeroAddress] });
  const factory = getAddress('0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67');
  const safeRequest = await client.simulateContract({ account: deployer, address: factory, abi: safeAbi,
    functionName: 'createProxyWithNonce', args: [getAddress('0x29fcB43b46531BcA003ddC8FCB67FFE91900C762'), setup, BigInt(Date.now())] });
  await landed(await wallet.writeContract(safeRequest.request));
  const safe = safeRequest.result;
  const registry = await deployed(await wallet.deployContract({ abi: registryAbi, bytecode: await bytecode('AtpRegistry.sol', 'AtpRegistry') }));
  const router = await deployed(await wallet.deployContract({ abi: routerAbi, bytecode: await bytecode('AtpMultiPoolOracle.sol', 'AtpMultiPoolOracle'), args: [usdt] }));
  for (const [asset, pool, slippage] of [[doge, getAddress('0x89da4102853c6cf3f4e9979cbb1dc4a166f38e84'), 300],
    [eth, getAddress('0x9f599f3d64a9d99ea21e68127bb6ce99f893da61'), 100],
    [wbnb, getAddress('0x36696169c63e42cd08ce11f5deebbcebae652050'), 100]] as const) {
    await landed(await wallet.writeContract({ address: router, abi: routerAbi, functionName: 'setOracle', args: [asset, pool, 1800, slippage, 3600] }));
  }
  const executorReceipt = await landed(await wallet.deployContract({ abi: executorAbi, bytecode: await bytecode('AtpExecutor.sol', 'AtpExecutor'),
    args: [registry, PANCAKE_UR, router, getAddress('0x31c2f6fcff4f8759b3bd5bf0e1084a055615c768'), safe, usdt, 10000] }));
  assert.ok(executorReceipt.contractAddress);
  const executor = executorReceipt.contractAddress;
  await landed(await wallet.writeContract({ address: registry, abi: registryAbi, functionName: 'setOperator', args: [operator.address] }));
  for (const address of [registry, router]) await landed(await wallet.writeContract({ address, abi: registryAbi, functionName: 'transferOwnership', args: [safe] }));
  await local('anvil_impersonateAccount', [safe]); await local('anvil_setBalance', [safe, toHex(10n ** 19n)]);
  try {
    for (const address of [registry, router]) await landed(await wallet.writeContract({ address, abi: registryAbi, functionName: 'acceptOwnership', account: safe }));
    await landed(await wallet.writeContract({ address: executor, abi: executorAbi, functionName: 'setVenue', args: [kyber, 2, kyber], account: safe }));
  } finally { await local('anvil_stopImpersonatingAccount', [safe]); }
  const executorDeploymentBlock = executorReceipt.blockNumber;
  const venueChecks = await checkVenues(client, executor, executorDeploymentBlock);
  assert.equal(venueChecks.length, 2); assert.ok(venueChecks.every((check) => check.level === 'ok'));
  process.env.REGISTRY_ADDRESS = registry; process.env.EXECUTOR_ADDRESS = executor;
  const operatorKey = operator.getHdKey().privateKey; assert.ok(operatorKey);
  process.env.OPERATOR_PRIVATE_KEY = toHex(operatorKey);
  process.env.SESSION_KEY_MASTER_SEED = `0x${'11'.repeat(32)}`;
  assert.equal((await query<{ name: string }>('select current_database() as name')).rows[0]?.name, 'cre8_x1h');
  await query("delete from portfolios where strategy_id in (select id from strategies where name like '#47 isolated %')");
  await query("delete from strategies where name like '#47 isolated %'");
  const strategy = await createStrategy({ name: `#47 isolated ${Date.now()}` }, owner.address);
  await publishVersion(strategy.id, { allocation: { assets: [{ address: doge, weightBps: 4500 }, { address: eth, weightBps: 1000 }, { address: usdt, weightBps: 4500 }] },
    schedule: { kind: 'interval', intervalSeconds: 86400 } }, owner.address);
  console.log('[fork #47] latest contracts and Safe whitelist ready; enrolling Kernel');
  const portfolio = await enrollPortfolio(strategy.id, owner.address);
  const smart = portfolio.smartAccounts[0]; assert.ok(smart); const account = getAddress(smart.address);
  await local('anvil_setBalance', [account, toHex(10n ** 19n)]);
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [account, 1n]));
  await local('anvil_setStorageAt', [usdt, slot, toHex(4000n * 10n ** 18n, { size: 32 })]);
  await local('anvil_setStorageAt', [eth, slot, toHex(10n ** 16n, { size: 32 })]);
  assert.equal(await client.readContract({ address: eth, abi: tokenAbi, functionName: 'balanceOf', args: [account] }), 10n ** 16n);
  const sudo = await signerToEcdsaValidator(client, { signer: owner, entryPoint, kernelVersion: KERNEL_V3_3 });
  const kernel = await createKernelAccount(client, { address: account, plugins: { sudo }, entryPoint, kernelVersion: KERNEL_V3_3, useMetaFactory: true });
  const ownerClient = createKernelAccountClient({ account: kernel, client, chain: bsc, bundlerTransport: http(bundler),
    userOperation: { estimateFeesPerGas: async () => { const gas = await client.getGasPrice(); return { maxFeePerGas: gas, maxPriorityFeePerGas: gas }; } } });
  console.log('[fork #47] Kernel enrolled and funded; approving tokens');
  const approval = await ownerClient.sendUserOperation({ calls: [usdt, doge, eth].map((token) => ({ to: token,
    data: encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [executor, (1n << 256n) - 1n] }) })) });
  assert.equal((await ownerClient.waitForUserOperationReceipt({ hash: approval, timeout: 90000 })).success, true);
  console.log('[fork #47] owner approval confirmed; requesting live DOGE route');
  const amountIn = 1000n * 10n ** 18n;
  const [, floor] = await client.readContract({ address: router, abi: routerAbi, functionName: 'previewSwap', args: [usdt, doge, amountIn] });
  const deadline = (await client.getBlock()).timestamp + 1800n;
  const step = await buildRoutedStep({ publicClient: client, executor, tokenIn: usdt, tokenOut: doge, amountIn,
    oracleFloor: floor, minGross: minGrossFor(floor, 0), feeBps: 0, poolFee: 10000, deadline, blockNumber: await client.getBlockNumber({ cacheTime: 0 }) },
    { quoteAggregator: async (request) => {
      const quote = await quoteKyberSwap(request);
      console.log(`[fork #47] DOGE aggregator quote: ${quote?.amountOut ?? 'unavailable'}; minimum=${request.minimum}`);
      return quote;
    } });
  assert.ok(step); assert.equal(step.venue, kyber, 'DOGE 1000 USDT must select Kyber by real net quote');
  console.log('[fork #47] Kyber chosen; refreshing floor');
  const refreshed = await refreshFloors({ publicClient: client, executor, oracle: router, steps: [step], feeBps: 0, deadline });
  assert.ok(refreshed.ok);
  const data = encodeFunctionData({ abi: EXECUTOR_ABI, functionName: 'executeRebalance', args: [account, refreshed.steps, deadline] });
  assert.equal(data.slice(0, 10), EXECUTOR_SELECTOR);
  console.log('[fork #47] warming the exact DOGE calldata from the Kernel account');
  await client.call({ account, to: executor, data });
  console.log('[fork #47] warmup passed; sending DOGE buy with alto gas estimation');
  const calls = [{ to: executor, data }];
  const estimate = await ownerClient.estimateUserOperationGas({ calls });
  const swapHash = await ownerClient.sendUserOperation({ calls, callGasLimit: rebalanceCallGasLimit(estimate.callGasLimit) });
  const swapped = await ownerClient.waitForUserOperationReceipt({ hash: swapHash, timeout: 90000 }); assert.equal(swapped.success, true);
  assert.equal(swapped.receipt.status, 'success');
  const swaps = swapped.logs.flatMap((log) => {
    if (log.address.toLowerCase() !== executor.toLowerCase()) return [];
    try { return [decodeEventLog({ abi: executorAbi, data: log.data, topics: log.topics })]; } catch { return []; }
  });
  assert.equal(swaps.length, 1);
  assert.equal(swaps[0]?.args.amountIn, amountIn);
  for (const event of swaps) assert.ok(event.args.gross >= event.args.oracleFloor && event.args.gross >= step.amountOutMin);
  console.log(`[fork #47] Kyber receipt=${swapped.receipt.transactionHash}; gross=${swaps[0]?.args.gross}; floor=${swaps[0]?.args.oracleFloor}`);
  // Exercise the real unlisted-aggregator fallback; current live prices need not favor Pancake.
  await local('anvil_impersonateAccount', [safe]);
  try {
    await landed(await wallet.writeContract({ address: executor, abi: executorAbi, functionName: 'removeVenue', args: [kyber], account: safe }));
  } finally { await local('anvil_stopImpersonatingAccount', [safe]); }
  assert.equal((await client.readContract({ address: executor, abi: EXECUTOR_ABI, functionName: 'venues', args: [kyber] }))[0], 0);
  assert.equal((await checkVenues(client, executor, executorDeploymentBlock)).length, 1);
  const quoteClient: PublicClient = { ...client,
    call: (request) => client.call({ ...request, gas: PANCAKE_QUOTE_GAS_LIMIT }),
    readContract: (request) => readContract(quoteClient, request),
  };
  const directSteps = [];
  for (const [tokenIn, tokenOut, amountIn] of [[usdt, eth, 10n ** 18n], [eth, usdt, 10n ** 15n]] as const) {
    const [, directFloor] = await client.readContract({ address: router, abi: routerAbi, functionName: 'previewSwap', args: [tokenIn, tokenOut, amountIn] });
    // Warm real candidate pools before the product's five-second comparison budget starts.
    const warm = await chooseBestPath(quoteClient, { tokenIn, tokenOut, amountIn, via: WBNB_ADDRESS,
      factory: V3_FACTORY_ADDRESS, pinnedFee: 100 });
    assert.ok(warm);
    console.log(`[fork #47] warmed Pancake quote: ${warm.amountOut}; floor=${directFloor}`);
    const candidate = await buildRoutedStep({ publicClient: client, executor, tokenIn, tokenOut, amountIn,
      oracleFloor: directFloor, minGross: minGrossFor(directFloor, 0), feeBps: 0, poolFee: 100, deadline,
      blockNumber: await client.getBlockNumber({ cacheTime: 0 }) });
    console.log(`[fork #47] direct comparison ${tokenIn} -> ${tokenOut}: venue=${candidate?.venue}`);
    if (candidate?.venue === PANCAKE_UR) directSteps.push(candidate);
  }
  const pancake = directSteps[0];
  assert.ok(pancake, 'deep ETH/USDT must fall back to the allowed Pancake venue when Kyber is removed');
  const freshPancake = await refreshFloors({ publicClient: client, executor, oracle: router, steps: [pancake], feeBps: 0, deadline });
  assert.ok(freshPancake.ok);
  const pancakeData = encodeFunctionData({ abi: EXECUTOR_ABI, functionName: 'executeRebalance', args: [account, freshPancake.steps, deadline] });
  await client.call({ account, to: executor, data: pancakeData });
  const pancakeCalls = [{ to: executor, data: pancakeData }];
  const pancakeEstimate = await ownerClient.estimateUserOperationGas({ calls: pancakeCalls });
  const pancakeHash = await ownerClient.sendUserOperation({ calls: pancakeCalls,
    callGasLimit: rebalanceCallGasLimit(pancakeEstimate.callGasLimit) });
  const pancakeReceipt = await ownerClient.waitForUserOperationReceipt({ hash: pancakeHash, timeout: 90000 });
  assert.equal(pancakeReceipt.success, true);
  assert.equal(pancakeReceipt.receipt.status, 'success');
  const pancakeSwaps = pancakeReceipt.logs.flatMap((log) => {
    if (log.address.toLowerCase() !== executor.toLowerCase()) return [];
    try { return [decodeEventLog({ abi: executorAbi, data: log.data, topics: log.topics })]; } catch { return []; }
  });
  assert.equal(pancakeSwaps.length, 1);
  assert.equal(pancakeSwaps[0]?.args.tokenIn.toLowerCase(), pancake.tokenIn.toLowerCase());
  const freshPancakeStep = freshPancake.steps[0]; assert.ok(freshPancakeStep);
  for (const event of pancakeSwaps) assert.ok(event.args.gross >= event.args.oracleFloor && event.args.gross >= freshPancakeStep.amountOutMin);
  console.log(`[fork #47] Pancake receipt=${pancakeReceipt.receipt.transactionHash}; gross=${pancakeSwaps[0]?.args.gross}; floor=${pancakeSwaps[0]?.args.oracleFloor}`);
  await local('anvil_impersonateAccount', [safe]);
  try {
    await landed(await wallet.writeContract({ address: executor, abi: executorAbi, functionName: 'setVenue', args: [kyber, 2, kyber], account: safe }));
  } finally { await local('anvil_stopImpersonatingAccount', [safe]); }
  assert.equal((await client.readContract({ address: executor, abi: EXECUTOR_ABI, functionName: 'venues', args: [kyber] }))[0], 2);
  console.log('[fork #47] Kyber restored; warming scheduler holdings Multicall3');
  const multicallCode = await client.getCode({ address: MULTICALL3_ADDRESS });
  assert.ok(multicallCode && multicallCode !== '0x');
  const warmHoldings = await client.multicall({ allowFailure: false, contracts: [usdt, doge, eth].flatMap((token) => [
    { address: token, abi: tokenAbi, functionName: 'balanceOf' as const, args: [account] as const },
    { address: token, abi: tokenAbi, functionName: 'decimals' as const },
  ]) });
  assert.equal(warmHoldings.length, 6);
  await query('update portfolios set next_run_at = now() - interval \'1 minute\' where id = $1', [portfolio.id]);
  await query("update portfolios set schedule_state = 'paused' where id <> $1", [portfolio.id]);
  const run = spawnSync('bun', ['run', 'scripts/scheduler.ts', '--once', '--live'], { env: process.env, encoding: 'utf8', timeout: 240000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /executed/);
  console.log(run.stdout);
  const confirmed = await query<{ count: string }>("select count(*)::text as count from operations where portfolio_id = $1 and state = 'confirmed'", [portfolio.id]);
  assert.equal(confirmed.rows[0]?.count, '1', run.stdout);
  const operation = (await query<{ user_op_hash: Hex; tx_hash: Hex; payload_hash: Hex; user_op_nonce: string }>(
    "select user_op_hash, tx_hash, payload_hash, user_op_nonce from operations where portfolio_id = $1 and state = 'confirmed'", [portfolio.id])).rows[0];
  assert.ok(operation);
  const original = await ownerClient.getUserOperation({ hash: operation.user_op_hash });
  assert.equal(original.userOperation.nonce.toString(), operation.user_op_nonce);
  assert.ok(original.userOperation.nonce >> 64n > 0n, 'scheduler used a permission nonce, not the owner nonce');
  const reconciled = await readRebalanceReceipt({ userOpHash: operation.user_op_hash, txHash: operation.tx_hash,
    payloadHash: operation.payload_hash, account, executor, chainId: 56 }, {
    getReceipt: (hash) => ownerClient.getUserOperationReceipt({ hash }),
    getOperation: (hash) => ownerClient.getUserOperation({ hash }),
    getBlockHash: async (blockNumber) => (await client.getBlock({ blockNumber })).hash,
  });
  assert.equal(reconciled.kind, 'found');
  if (reconciled.kind === 'found') assert.equal(reconciled.outcome.status, 'success');
  const policy = (await query<{ selector: string }>(
    "select permissions #>> '{call,permissions,0,selector}' as selector from session_keys where portfolio_id = $1 and status = 'active'", [portfolio.id])).rows[0];
  assert.equal(policy?.selector, EXECUTOR_SELECTOR);
  console.log(`[fork #47] session receipt=${operation.tx_hash}; original UserOp and venue/data planHash reconciled`);
  console.log(`[fork #47] DOGE input=1000 USDT venue=${step.venue}; swaps=${swaps.length}; floor=passed; Pancake=passed; scheduler-confirmed=1; selector=${EXECUTOR_SELECTOR}`);
  console.log(`[fork #47] registry=${registry} executor=${executor} Safe=${safe}`);
});
