/** Explicit fork acceptance. All writes require this issue's isolated anvil, bundler and DB. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { createKernelAccount, createKernelAccountClient } from '@zerodev/sdk';
import { KERNEL_V3_3 } from '@zerodev/sdk/constants';
import { createPublicClient, createWalletClient, encodeAbiParameters, encodeFunctionData, getAddress,
  http, isHex, keccak256, parseAbi, toHex } from 'viem';
import type { Address, Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';
import { closePool, query } from '../src/db.js';
import { singlePortfolioClaim } from '../src/operator.js';
import { enrollPortfolio } from '../src/portfolios.js';
import { runSchedulerOnce } from '../src/scheduler.js';
import type { SchedulerDeps } from '../src/scheduler.js';
import { createStrategy, publishVersion } from '../src/strategies.js';
import { KERNEL_V3_3_ADDRESSES } from '../src/addresses.js';

const rpc = 'http://127.0.0.1:8606';
const bundler = 'http://127.0.0.1:3066';
const mnemonic = 'test test test test test test test test test test test junk';
const deployer = mnemonicToAccount(mnemonic);
const operator = mnemonicToAccount(mnemonic, { addressIndex: 4 });
const owner = mnemonicToAccount(mnemonic, { addressIndex: 7 });
const client = createPublicClient({ chain: bsc, transport: http(rpc) });
const wallet = createWalletClient({ account: deployer, chain: bsc, transport: http(rpc) });
const usdt = getAddress('0x55d398326f99059fF775485246999027B3197955');
const wbnb = getAddress('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c');
const entryPoint = { address: KERNEL_V3_3_ADDRESSES.entryPointV07, version: '0.7' } as const;
const registryAbi = parseAbi(['constructor()', 'function setOperator(address)']);
const routerAbi = parseAbi(['constructor(address)', 'function setOracle(address,address,uint32,uint16,uint32) returns(address)']);
const executorAbi = parseAbi(['constructor(address,address,address,address,address,address,uint16)',
  'event SwapExecuted(address indexed account,address tokenIn,address tokenOut,uint256 amountIn,uint256 gross,uint256 fee,uint256 net,uint256 oracleFloor)']);
const tokenAbi = parseAbi(['function approve(address,uint256) returns(bool)', 'function balanceOf(address) view returns(uint256)']);

async function rpcCall(url: string, method: string, params: readonly unknown[] = []): Promise<unknown> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const result: unknown = await response.json();
  assert.ok(typeof result === 'object' && result !== null && !('error' in result), `local RPC ${method} failed`);
  return Reflect.get(result, 'result');
}
async function bytecode(source: string, name: string): Promise<Hex> {
  // d62d1c3 matches this backend's SwapStep ABI, before the separately tracked A11 venue change.
  const artifact: unknown = JSON.parse(await readFile(`.bun-cache/contracts-39-v1/out/${source}/${name}.json`, 'utf8'));
  assert.ok(typeof artifact === 'object' && artifact !== null);
  const code: unknown = Reflect.get(artifact, 'bytecode');
  assert.ok(typeof code === 'object' && code !== null);
  const object: unknown = Reflect.get(code, 'object');
  assert.ok(typeof object === 'string' && isHex(object) && object.length > 2);
  return object;
}
async function landed(hash: Hex) {
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success');
  return receipt;
}
async function deployed(hash: Hex): Promise<Address> {
  const receipt = await landed(hash);
  assert.ok(receipt.contractAddress);
  return receipt.contractAddress;
}
after(async () => {
  await rpcCall(bundler, 'debug_bundler_setBundlingMode', ['auto']);
  await closePool();
});

test('#39 real Kernel UserOp dropped from alto: deadline release, fresh plan, exactly one on-chain rebalance', async () => {
  assert.equal(process.env.RUN_CHAIN_TESTS, '1');
  assert.equal(process.env.RPC_URL, rpc);
  assert.equal(process.env.BUNDLER_URL, bundler);
  await rpcCall(rpc, 'anvil_nodeInfo');
  assert.equal(await client.getChainId(), 56);
  await rpcCall(rpc, 'anvil_mine', [toHex(120)]);
  const registry = await deployed(await wallet.deployContract({ abi: registryAbi, bytecode: await bytecode('AtpRegistry.sol', 'AtpRegistry') }));
  const router = await deployed(await wallet.deployContract({ abi: routerAbi, bytecode: await bytecode('AtpMultiPoolOracle.sol', 'AtpMultiPoolOracle'), args: [usdt] }));
  await landed(await wallet.writeContract({ address: router, abi: routerAbi, functionName: 'setOracle',
    args: [wbnb, getAddress('0x172fcd41e0913e95784454622d1c3724f546f849'), 1800, 300, 3600] }));
  const executor = await deployed(await wallet.deployContract({ abi: executorAbi, bytecode: await bytecode('AtpExecutor.sol', 'AtpExecutor'),
    args: [registry, getAddress('0x1a0a18ac4becddbd6389559687d1a73d8927e416'), router,
      getAddress('0x31c2f6fcff4f8759b3bd5bf0e1084a055615c768'), deployer.address, usdt, 10000] }));
  const executorBlock = await client.getBlockNumber({ cacheTime: 0 });
  await landed(await wallet.writeContract({ address: registry, abi: registryAbi, functionName: 'setOperator', args: [operator.address] }));
  process.env.REGISTRY_ADDRESS = registry;
  process.env.EXECUTOR_ADDRESS = executor;
  // Public anvil derivation only. This process never loads a deployed service's environment.
  const operatorKey = operator.getHdKey().privateKey;
  assert.ok(operatorKey);
  process.env.OPERATOR_PRIVATE_KEY = toHex(operatorKey);
  process.env.SESSION_KEY_MASTER_SEED = `0x${'11'.repeat(32)}`;
  assert.equal((await query<{ name: string }>('select current_database() as name')).rows[0]?.name, 'cre8_x1g');
  // Each run deploys a fresh registry whose strategy ids restart at 1. Only remove this fixture's prior runs.
  await query("delete from portfolios where strategy_id in (select id from strategies where name like '#39 isolated %')");
  await query("delete from strategies where name like '#39 isolated %'");
  const strategy = await createStrategy({ name: `#39 isolated ${Date.now()}` }, owner.address);
  await publishVersion(strategy.id, { allocation: { assets: [{ address: wbnb, weightBps: 1000 }, { address: usdt, weightBps: 9000 }] },
    schedule: { kind: 'interval', intervalSeconds: 86400 } }, owner.address);
  console.log('[fork #39] registry/oracle/executor ready; enrolling Kernel');
  const portfolio = await enrollPortfolio(strategy.id, owner.address);
  const smartAccount = portfolio.smartAccounts[0];
  assert.ok(smartAccount);
  const account = getAddress(smartAccount.address);
  await rpcCall(rpc, 'anvil_setBalance', [account, toHex(10n ** 19n)]);
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [account, 1n]));
  await rpcCall(rpc, 'anvil_setStorageAt', [usdt, slot, toHex(200n * 10n ** 18n, { size: 32 })]);
  const sudo = await signerToEcdsaValidator(client, { signer: owner, entryPoint, kernelVersion: KERNEL_V3_3 });
  const kernel = await createKernelAccount(client, { address: account, plugins: { sudo }, entryPoint, kernelVersion: KERNEL_V3_3, useMetaFactory: true });
  const ownerClient = createKernelAccountClient({ account: kernel, client, chain: bsc, bundlerTransport: http(bundler),
    userOperation: { estimateFeesPerGas: async () => { const gas = await client.getGasPrice(); return { maxFeePerGas: gas, maxPriorityFeePerGas: gas }; } } });
  const approval = await ownerClient.sendUserOperation({ calls: [usdt, wbnb].map((token) => ({ to: token,
    data: encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [executor, (1n << 256n) - 1n] }) })) });
  assert.equal((await ownerClient.waitForUserOperationReceipt({ hash: approval, timeout: 90000 })).success, true);
  console.log('[fork #39] Kernel enrolled, funded and approved; queuing real session UserOp');
  await rpcCall(bundler, 'debug_bundler_setBundlingMode', ['manual']);
  let crash = true;
  const options: SchedulerDeps = { withTransaction: singlePortfolioClaim(portfolio.id), log: console.log,
    query: async (sql, params) => {
      const result = await query(sql, params);
      if (crash && sql.includes("set state = 'submitted'")) {
        crash = false;
        throw new Error('test: crash after submitted commit, before receipt wait');
      }
      return result;
    } };
  const send = await runSchedulerOnce({ dryRun: false }, options);
  assert.equal(send.results[0]?.outcome, 'blocked', send.results[0]?.reason);
  const old = (await query<{ state: string; user_op_hash: Hex; deadline: Date; user_op_nonce: string; idempotency_key: string }>(
    'select state, user_op_hash, deadline, user_op_nonce, idempotency_key from operations where portfolio_id = $1', [portfolio.id])).rows[0];
  assert.ok(old && old.deadline && old.user_op_nonce && old.user_op_hash);
  assert.equal(old.state, 'submitted');
  const queued = await rpcCall(bundler, 'debug_bundler_dumpMempool', [entryPoint.address]);
  assert.ok(Array.isArray(queued) && queued.length === 1, '真實 UserOp 已被 alto 接受但尚未打包');
  const queuedOp: unknown = queued[0];
  assert.ok(typeof queuedOp === 'object' && queuedOp !== null);
  const queuedNonce: unknown = Reflect.get(queuedOp, 'nonce');
  assert.ok(typeof queuedNonce === 'string');
  assert.equal(BigInt(queuedNonce), BigInt(old.user_op_nonce), '實際簽送的 nonce 與 pending 保存值完全相同');
  assert.equal(await rpcCall(bundler, 'eth_getUserOperationReceipt', [old.user_op_hash]), null);
  await rpcCall(bundler, 'debug_bundler_clearState');
  assert.deepEqual(await rpcCall(bundler, 'debug_bundler_dumpMempool', [entryPoint.address]), []);
  assert.equal(await rpcCall(bundler, 'eth_getUserOperationByHash', [old.user_op_hash]), null);
  const beforeDeadline = await runSchedulerOnce({ dryRun: false }, options);
  assert.equal(beforeDeadline.results[0]?.outcome, 'blocked');
  const now = (await client.getBlock()).timestamp;
  await rpcCall(rpc, 'evm_increaseTime', [Number(BigInt(old.deadline.getTime() / 1000) + 301n - now)]);
  await rpcCall(rpc, 'evm_mine');
  const release = await runSchedulerOnce({ dryRun: false }, options);
  assert.equal(release.results[0]?.outcome, 'noop', release.results[0]?.reason);
  assert.equal((await query<{ state: string }>('select state from operations where idempotency_key = $1', [old.idempotency_key])).rows[0]?.state, 'expired');
  await rpcCall(bundler, 'debug_bundler_setBundlingMode', ['auto']);
  const redo = await runSchedulerOnce({ dryRun: false }, options);
  assert.equal(redo.results[0]?.outcome, 'executed', redo.results[0]?.reason);
  const rows = (await query<{ state: string; idempotency_key: string; attempts: number; user_op_nonce: string }>(
    'select state, idempotency_key, attempts, user_op_nonce from operations where portfolio_id = $1 order by id', [portfolio.id])).rows;
  assert.deepEqual(rows.map((row) => [row.state, row.attempts]), [['expired', 1], ['confirmed', 1]]);
  assert.equal(rows[1]?.user_op_nonce, old.user_op_nonce, '丟棄未消耗 nonce，新 plan 明確重取並保存');
  assert.notEqual(rows[1]?.idempotency_key, old.idempotency_key);
  assert.equal(await rpcCall(bundler, 'eth_getUserOperationReceipt', [old.user_op_hash]), null);
  const logs = await client.getLogs({ address: executor, event: executorAbi[1], fromBlock: executorBlock, toBlock: 'latest' });
  assert.equal(logs.length, 1, '只有新 plan 的一筆真實交換，舊 UserOp 永未上鏈');
  assert.ok(await client.readContract({ address: wbnb, abi: tokenAbi, functionName: 'balanceOf', args: [account] }) > 0n);
  console.log(`[fork #39] dropped=1; expired=1; fresh-confirmed=1; swaps=${logs.length}; duplicate=0`);
});
