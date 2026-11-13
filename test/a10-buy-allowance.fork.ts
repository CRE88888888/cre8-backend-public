/** Explicit RUN_CHAIN_TESTS=1 command only. All writes require the isolated #36 anvil + DB. */
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { HDKey } from '@scure/bip32';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { toECDSASigner } from '@zerodev/permissions/signers';
import { addressToEmptyAccount, createKernelAccount, createKernelAccountClient } from '@zerodev/sdk';
import { KERNEL_V3_3 } from '@zerodev/sdk/constants';
import { BaseError, decodeErrorResult, decodeEventLog, encodeAbiParameters, encodeErrorResult, encodeFunctionData, getAddress, hexToBytes, http, keccak256, parseAbi, toHex } from 'viem';
import type { Address, Hex } from 'viem';
import { entryPoint07Abi } from 'viem/account-abstraction';
import { hdKeyToAccount, mnemonicToAccount } from 'viem/accounts';
import { EXECUTOR_BUY_ABI, getChain } from '../src/chain.js';
import { KERNEL_V3_3_ADDRESSES } from '../src/addresses.js';
import { getSessionKeyConfig, requireSessionKeyConfig } from '../src/config.js';
import { closePool, query } from '../src/db.js';
import { runOperatorRebalance, runOperatorRedeem, runOperatorClose, previewOperatorRebalance } from '../src/operator.js';
import { enrollPortfolio } from '../src/portfolios.js';
import { buildSessionPermissions } from '../src/permissions.js';
import type { SessionPolicySnapshot } from '../src/permissions.js';
import { buildStep, minGrossFor } from '../src/rebalance-plan.js';
import type { PlannedStep } from '../src/rebalance-plan.js';
import { createStrategy, publishVersion } from '../src/strategies.js';

const rpcUrl = 'http://127.0.0.1:8576';
const bundlerUrl = 'http://127.0.0.1:3036';
const mnemonic = 'test test test test test test test test test test test junk';
const owner = mnemonicToAccount(mnemonic, { addressIndex: 6 });
const operator = mnemonicToAccount(mnemonic, { addressIndex: 4 });
const usdt = getAddress('0x55d398326f99059fF775485246999027B3197955');
const wbnb = getAddress('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c');
const entryPoint = { address: KERNEL_V3_3_ADDRESSES.entryPointV07, version: '0.7' } as const;
const abi = parseAbi([
  'function executeRebalance(address account, (address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOutMin,address venue,bytes data)[] steps,uint256 deadline)',
  'function setMaxBuyBps(uint16 bps)', 'function owner() view returns(address)',
  'function oracle() view returns(address)',
  'function previewSwap(address tokenIn,address tokenOut,uint256 amountIn) view returns(uint256 quoted,uint256 minimum)',
  'function approve(address spender,uint256 amount) returns(bool)',
  'function balanceOf(address holder) view returns(uint256)',
  'function permissionConfig(bytes4 id) view returns((bytes2 permissionFlag,address signer,bytes22[] policyData))',
]);
let portfolioId: number;
let account: Address;
let executor: Address;
let safe: Address;
let router: Address;
let initialBought: bigint;
let directClient: Awaited<ReturnType<typeof makeDirectClient>>;

async function localRpc(method: string, params: readonly unknown[]): Promise<void> {
  const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const result: unknown = await response.json();
  assert.ok(typeof result === 'object' && result !== null && !('error' in result), `local anvil ${method} failed`);
}

async function setCap(bps: number): Promise<void> {
  const chain = getChain();
  await localRpc('anvil_impersonateAccount', [safe]);
  try {
    const hash = await chain.wallet.writeContract({ address: executor, abi, functionName: 'setMaxBuyBps', args: [bps], account: safe, chain: null });
    assert.equal((await chain.publicClient.waitForTransactionReceipt({ hash })).status, 'success');
  } finally { await localRpc('anvil_stopImpersonatingAccount', [safe]); }
}

async function allowance() {
  return getChain().publicClient.readContract({ address: executor, abi: EXECUTOR_BUY_ABI, functionName: 'buyAllowance', args: [account] });
}
async function balance(token: Address): Promise<bigint> {
  return getChain().publicClient.readContract({ address: token, abi, functionName: 'balanceOf', args: [account] });
}
async function step(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<PlannedStep> {
  const [, floor] = await getChain().publicClient.readContract({ address: router, abi, functionName: 'previewSwap', args: [tokenIn, tokenOut, amountIn] });
  assert.ok(floor > 0n);
  return buildStep({ executor, tokenIn, tokenOut, amountIn, oracleFloor: floor, minGross: minGrossFor(floor, 0), poolFee: 500 });
}
async function makeDirectClient() {
  const chain = getChain();
  const row = (await query<{ key_ref: string; permissions: SessionPolicySnapshot }>('select key_ref, permissions from session_keys where portfolio_id = $1 and status = $2', [portfolioId, 'active'])).rows[0];
  assert.ok(row);
  assert.ok(row.key_ref.startsWith("m/44'/60'/"));
  const path = row.key_ref;
  // Narrow the DB string by validating its format, without accepting another derivation namespace.
  function isSessionPath(value: string): value is `m/44'/60'/${string}` { return /^m\/44'\/60'\/0'\/0\/\d+$/.test(value); }
  assert.ok(isSessionPath(path));
  const signer = hdKeyToAccount(HDKey.fromMasterSeed(hexToBytes(requireSessionKeyConfig().masterSeed)), { path });
  assert.equal(signer.address.toLowerCase(), row.permissions.sessionKeyAddress.toLowerCase());
  const permission = await buildSessionPermissions({ publicClient: chain.publicClient, executorAddress: executor,
    sessionKeyAddress: signer.address, validUntil: row.permissions.timestamp.validUntil, signer: await toECDSASigner({ signer }) });
  assert.equal(permission.permissionId, row.permissions.permissionId);
  const installation = await chain.publicClient.readContract({ address: account, abi, functionName: 'permissionConfig', args: [permission.permissionId] });
  assert.equal(installation.policyData.length, 3, 'EXPECTED_POLICY_COUNT remains 3');
  const kernel = await createKernelAccount(chain.publicClient, { address: account, entryPoint, kernelVersion: KERNEL_V3_3,
    plugins: { sudo: await signerToEcdsaValidator(chain.publicClient, { signer: addressToEmptyAccount(owner.address), entryPoint, kernelVersion: KERNEL_V3_3 }), regular: permission.permissionValidator }, useMetaFactory: true });
  return createKernelAccountClient({ account: kernel, client: chain.publicClient, chain: chain.publicClient.chain,
    bundlerTransport: http(bundlerUrl), userOperation: { estimateFeesPerGas: async () => {
      const gas = await chain.publicClient.getGasPrice(); return { maxFeePerGas: gas, maxPriorityFeePerGas: gas };
    } } });
}

async function directSwap(steps: PlannedStep[]) {
  const { timestamp } = await getChain().publicClient.getBlock();
  const data = encodeFunctionData({ abi, functionName: 'executeRebalance', args: [account, steps, timestamp + 1800n] });
  // Supply every gas field: the SDK must sign and call eth_sendUserOperation, not stop at
  // an estimate with a dummy signature. No backend API/planner/scheduler or pre-send eth_call.
  const hash = await directClient.sendUserOperation({ calls: [{ to: executor, data }],
    callGasLimit: 2_000_000n, verificationGasLimit: 500_000n, preVerificationGas: 100_000n });
  const receipt = await directClient.waitForUserOperationReceipt({ hash, timeout: 90000 });
  if (!receipt.success) {
    // EntryPoint emits the executor revert in UserOperationRevertReason.
    const reasons = receipt.logs.flatMap((log) => {
      if (log.address.toLowerCase() !== entryPoint.address.toLowerCase()) return [];
      try {
        const event = decodeEventLog({ abi: entryPoint07Abi, data: log.data, topics: log.topics });
        return event.eventName === 'UserOperationRevertReason' && event.args.userOpHash === hash ? [event.args.revertReason] : [];
      } catch { return []; }
    });
    assert.equal(reasons.length, 1, 'failed UserOp must have its own EntryPoint revert reason');
    const reason = reasons[0];
    assert.ok(reason);
    assert.equal(decodeErrorResult({ abi: EXECUTOR_BUY_ABI, data: reason }).errorName, 'BuyLimitExceeded');
  }
  return receipt;
}

function hasBuyLimitError(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  const selector = encodeErrorResult({ abi: EXECUTOR_BUY_ABI, errorName: 'BuyLimitExceeded', args: [0n, 0n] }).slice(2, 10);
  const seen = new Set<unknown>();
  function walk(value: unknown, depth: number): boolean {
    if (depth > 15 || value === null || seen.has(value)) return false;
    if (typeof value === 'string') return value.includes('BuyLimitExceeded') || value.toLowerCase().includes(selector);
    if (typeof value !== 'object') return false;
    seen.add(value);
    return Object.getOwnPropertyNames(value).some((key) => walk(Reflect.get(value, key), depth + 1));
  }
  return walk(error, 0);
}

before(async () => {
  assert.equal(process.env.RUN_CHAIN_TESTS, '1', 'explicit chain-test gate is required');
  assert.equal(process.env.RPC_URL, rpcUrl);
  assert.equal(process.env.BUNDLER_URL, bundlerUrl);
  assert.equal((await query<{ name: string }>('select current_database() as name')).rows[0]?.name, 'cre8_x1d');
  await localRpc('anvil_nodeInfo', []);
  const chain = getChain();
  assert.equal(chain.account.address.toLowerCase(), operator.address.toLowerCase());
  assert.equal(await chain.publicClient.getChainId(), 56);
  const config = getSessionKeyConfig();
  assert.ok(config.executorAddress);
  executor = config.executorAddress;
  safe = await chain.publicClient.readContract({ address: chain.registryAddress, abi, functionName: 'owner' });
  router = await chain.publicClient.readContract({ address: executor, abi, functionName: 'oracle' });
  await setCap(10000);
  const strategy = await createStrategy({ name: `A10 #36 ${Date.now()}` }, owner.address);
  await publishVersion(strategy.id, { allocation: { assets: [{ address: wbnb, symbol: 'WBNB', weightBps: 1000 }, { address: usdt, symbol: 'USDT', weightBps: 9000 }] }, schedule: { kind: 'interval', intervalSeconds: 86400 } }, owner.address);
  console.log(`[A10 setup] published strategy ${strategy.id}; deploying Kernel + 3 policies`);
  const portfolio = await enrollPortfolio(strategy.id, owner.address);
  portfolioId = portfolio.id;
  assert.ok(portfolio.smartAccounts[0]);
  account = getAddress(portfolio.smartAccounts[0].address);
  await localRpc('anvil_setBalance', [account, toHex(10n ** 19n)]);
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [account, 1n]));
  const deposit = 100000n * 10n ** 18n;
  await localRpc('anvil_setStorageAt', [usdt, slot, toHex(deposit, { size: 32 })]);
  assert.equal(await balance(usdt), deposit);
  const sudo = await signerToEcdsaValidator(chain.publicClient, { signer: owner, entryPoint, kernelVersion: KERNEL_V3_3 });
  const kernel = await createKernelAccount(chain.publicClient, { address: account, plugins: { sudo }, entryPoint, kernelVersion: KERNEL_V3_3, useMetaFactory: true });
  const ownerClient = createKernelAccountClient({ account: kernel, client: chain.publicClient, chain: chain.publicClient.chain, bundlerTransport: http(bundlerUrl),
    userOperation: { estimateFeesPerGas: async () => { const gas = await chain.publicClient.getGasPrice(); return { maxFeePerGas: gas, maxPriorityFeePerGas: gas }; } } });
  console.log('[A10 setup] Kernel enrolled and funded; owner approves via bundler');
  const hash = await ownerClient.sendUserOperation({ calls: [usdt, wbnb].map((token) => ({ to: token, data: encodeFunctionData({ abi, functionName: 'approve', args: [executor, 2n ** 256n - 1n] }) })) });
  assert.equal((await ownerClient.waitForUserOperationReceipt({ hash, timeout: 90000 })).success, true);
  directClient = await makeDirectClient();
  console.log('[A10 setup] on-chain policy count=3; direct session client ready');
});

test('large deposit first allocation fits the cap using the production scheduler', async () => {
  const result = await runOperatorRebalance(portfolioId, owner.address, { log: () => {} });
  assert.equal(result.outcome, 'executed', result.reason);
  const [cap, bought] = await allowance();
  initialBought = bought;
  assert.ok(bought > 0n && bought <= cap * 98n / 100n);
  console.log(`[A10 first allocation] deposit=100000 USDT; buys=${bought}; cap=${cap}; swaps=${result.expectedSwaps}`);
});

test('leaked session key directly cycles USDT -> WBNB -> USDT until BuyLimitExceeded; sales remain usable', async () => {
  let rejected = false;
  let cycles = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const beforeBought = (await allowance())[1];
    const cash = await balance(usdt);
    const held = await balance(wbnb);
    const buy = await step(usdt, wbnb, 20000n * 10n ** 18n);
    let denied = false;
    try {
      const receipt = await directSwap([buy]);
      denied = !receipt.success;
    } catch (error) {
      assert.ok(hasBuyLimitError(error), `bundler must surface the on-chain BuyLimitExceeded selector (${error instanceof Error ? error.message.split('\n')[0] : 'unknown error'})`);
      denied = true;
    }
    if (denied) {
      assert.equal(await balance(usdt), cash, 'rejected buy must not move USDT');
      assert.equal(await balance(wbnb), held, 'rejected buy must not move the asset');
      assert.equal((await allowance())[1], beforeBought, 'rejected buy must not consume allowance');
      rejected = true;
      break;
    }
    assert.equal((await allowance())[1], beforeBought + buy.amountIn);
    const received = await balance(wbnb) - held;
    assert.ok(received > 0n);
    assert.equal((await directSwap([await step(wbnb, usdt, received)])).success, true);
    assert.equal((await allowance())[1], beforeBought + buy.amountIn, 'sales do not consume or reset allowance');
    cycles += 1;
  }
  assert.ok(rejected, 'repeated swaps must eventually hit the on-chain limit');
  assert.ok(cycles > 0);
  const beforeSell = (await allowance())[1];
  const sale = await directSwap([await step(wbnb, usdt, await balance(wbnb))]);
  assert.equal(sale.success, true, 'selling the initial allocation is still allowed after rejection');
  assert.equal((await allowance())[1], beforeSell);
  assert.ok(beforeSell > initialBought);
  console.log(`[A10 attack] direct Kernel/session-key/bundler cycles=${cycles}; rejected=BuyLimitExceeded; bought=${beforeSell}; sell-after-rejection=success`);
});

test('Safe smaller cap scales the plan; exhaustion schedules the window; redeem and close still sell', async () => {
  // The attacker sold everything above. Advance to a fresh window, then lower the cap via Safe.
  const end = (await allowance())[2];
  const now = (await getChain().publicClient.getBlock()).timestamp;
  await localRpc('evm_increaseTime', [Number(end - now + 1n)]);
  await localRpc('evm_mine', []);
  await setCap(500);
  const preview = await previewOperatorRebalance(portfolioId, owner.address, { log: () => {} });
  assert.equal(preview.outcome, 'ready', preview.reason);
  const [cap] = await allowance();
  const planned = preview.steps.reduce((sum, value) => sum + BigInt(value.amountIn), 0n);
  assert.ok(planned > 0n && planned <= cap * 98n / 100n);
  const result = await runOperatorRebalance(portfolioId, owner.address, { log: () => {} });
  assert.equal(result.outcome, 'executed', result.reason);
  await setCap(0);
  const windowEnd = (await allowance())[2];
  const blocked = await runOperatorRebalance(portfolioId, owner.address, { log: () => {} });
  assert.equal(blocked.outcome, 'blocked');
  const row = (await query<{ next_run_at: Date }>('select next_run_at from portfolios where id = $1', [portfolioId])).rows[0];
  assert.equal(row?.next_run_at.getTime(), Number(windowEnd) * 1000);
  const redeem = await runOperatorRedeem(portfolioId, owner.address, 100n * 10n ** 8n, { log: () => {} });
  assert.equal(redeem.outcome, 'executed', redeem.reason);
  assert.ok(redeem.steps.every((value) => value.tokenOut.toLowerCase() === usdt.toLowerCase()));
  const close = await runOperatorClose(portfolioId, owner.address, { log: () => {} });
  assert.equal(close.outcome, 'executed', close.reason);
  assert.equal(await balance(wbnb), 0n);
  console.log(`[A10 reduced cap] maxBuyBps=500; scaled=${planned}; cap=${cap}; exhausted=blocked; next_run_at=${windowEnd}; redeem=executed; close=executed`);
});

test('after the next 24h window the same direct session key may buy again', async () => {
  await setCap(10000);
  const end = (await allowance())[2];
  const now = (await getChain().publicClient.getBlock()).timestamp;
  await localRpc('evm_increaseTime', [Number(end - now + 1n)]);
  await localRpc('evm_mine', []);
  assert.equal((await allowance())[1], 0n);
  assert.equal((await allowance())[2], 0n);
  const receipt = await directSwap([await step(usdt, wbnb, 100n * 10n ** 18n)]);
  assert.equal(receipt.success, true);
  assert.equal((await allowance())[1], 100n * 10n ** 18n);
  console.log('[A10 next window] same session key, direct UserOp=success; bought=100 USDT');
});

after(async () => {
  if (safe !== undefined && executor !== undefined) await setCap(10000);
  if (portfolioId !== undefined) await query('update portfolios set schedule_state = $1 where id = $2', ['idle', portfolioId]);
  await closePool();
});
