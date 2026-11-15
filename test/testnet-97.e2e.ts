/** #87 opt-in acceptance. Run with bun run test/testnet-97.e2e.ts after the CLEAN
 * contracts b767bf6 deploy-97.sh fork on 8562 and a 30-minute warm-up. No automatic bun-test discovery.
 * Env only: CHAIN_ID=97, RPC_URL=http://127.0.0.1:8562, PORT=3062, DATABASE_URL
 * (cre8_be87), MIGRATIONS_DIR, OPERATOR_PRIVATE_KEY, SESSION_KEY_MASTER_SEED,
 * PAYMASTER_SIGNER_PRIVATE_KEY, BUNDLER_EXECUTOR_PRIVATE_KEY, BUNDLER_UTILITY_PRIVATE_KEY,
 * ALTO_CLI_PATH (installed alto CLI), BUNDLER_URL=http://127.0.0.1:3162,
 * EXECUTOR_DEPLOYMENT_BLOCK (actual fork deployment receipt block),
 * TESTNET_ACCEPTANCE_GAS_PRICE_WEI (explicit local fork base-fee scenario; never a public-chain claim).
 * Keys may be loaded into env by a local launcher; this file never reads key files.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { openSync, closeSync, mkdirSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import { createPublicClient, createTestClient, encodeFunctionData, erc20Abi, getAddress, http, parseAbi } from 'viem';
import type { Address } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';
import { createSiweMessage } from 'viem/siwe';
import { createKernelAccount, createKernelAccountClient } from '@zerodev/sdk';
import { KERNEL_V3_3 } from '@zerodev/sdk/constants';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { closePool, query } from '../src/db.js';
import { getConfig } from '../src/config.js';
import { TESTNET_97 as P } from '../src/testnet-profile.js';
import { countSwapExecuted, runSchedulerOnce } from '../src/scheduler.js';
import { checkTestnetProfile } from '../src/testnet-preflight.js';
import { buildRedeemPlan } from '../src/operator.js';
import { EXECUTOR_ABI } from '../src/chain.js';
import { schedulerPaymaster, estimationPaymaster } from '../src/paymaster.js';
import { planPortfolio } from '../src/snapshot.js';
import { publishVersion } from '../src/strategies.js';
const RPC = 'http://127.0.0.1:8562';
const API = 'http://127.0.0.1:3062';
const BUNDLER = 'http://127.0.0.1:3162';
const client = createPublicClient({ chain: bscTestnet, transport: http(RPC, { timeout: 120000, retryCount: 0 }), cacheTime: 0 });
const local = createTestClient({ chain: bscTestnet, mode: 'anvil', transport: http(RPC) });
const owner = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 7 });
const pmAbi = parseAbi(['function getDeposit() view returns(uint256)']);
let passes = 0;
function check(value: unknown, label: string): asserts value { assert.ok(value, label); console.log('PASS ' + label); passes++; }
function obj(value: unknown): Record<string, unknown> { assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value)); return Object.fromEntries(Object.entries(value)); }
function str(value: unknown): string { assert.equal(typeof value, 'string'); return String(value); }
function addr(value: unknown): Address { return getAddress(str(value)); }
let token = '';
async function request(path: string, method = 'GET', body?: unknown, status = 200) {
  const response = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) });
  const result: unknown = await response.json();
  assert.equal(response.status, status, path + ' status; code=' + String(obj(result).code ?? 'none'));
  return obj(result);
}
async function ready(url: string, rpc: boolean) {
  for (let n = 0; n < 100; n++) {
    try {
      const response = await fetch(url, rpc ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_supportedEntryPoints', params: [] }), signal: AbortSignal.timeout(1000) } : { signal: AbortSignal.timeout(1000) });
      const body: unknown = await response.json();
      if (response.ok && (!rpc || Array.isArray(obj(body).result))) return;
    } catch { /* readiness only; never print URLs or upstream payloads */ }
    await pause(300);
  }
  throw new Error('local service readiness failed');
}
async function main() {
  const config = getConfig();
  check(config.chainId === 97 && config.rpcUrl === RPC && config.port === 3062 && new URL(config.databaseUrl).pathname === '/cre8_be87', 'dedicated chain/ports/DB guard');
  check(process.env.BUNDLER_URL === BUNDLER && process.env.ALTO_CLI_PATH && process.env.PAYMASTER_SIGNER_PRIVATE_KEY && process.env.BUNDLER_EXECUTOR_PRIVATE_KEY && process.env.BUNDLER_UTILITY_PRIVATE_KEY, 'required env only');
  // anvil_nodeInfo is intentionally unavailable on a public RPC.
  const info = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_nodeInfo', params: [] }) }).then((r) => r.json());
  check(obj(info).result && await client.getChainId() === 97, 'local anvil chain 97');
  // Local fee scenarios: EOA setup needs room for anvil's suggested 1 gwei tip.
  // UserOps later use the local fork fee scenario under the unchanged USD budget.
  await local.setNextBlockBaseFeePerGas({ baseFeePerGas: 10_000_000_000n });
  await local.mine({ blocks: 1 });
  check((await checkTestnetProfile(client)).every((c) => c.level === 'ok'), '319 pinned runtime hashes and selectors');
  mkdirSync('.bun-cache', { recursive: true });
  const log = openSync('.bun-cache/testnet-services-87.log', 'a', 0o600);
  const alto = spawn('sh', ['alto/entrypoint.sh'], { stdio: ['ignore', log, log], env: { ...process.env, CHAIN_ID: '97', PORT: '3162', RPC_URL: RPC,
    EXECUTOR_PRIVATE_KEY: process.env.BUNDLER_EXECUTOR_PRIVATE_KEY, UTILITY_PRIVATE_KEY: process.env.BUNDLER_UTILITY_PRIVATE_KEY } });
  const backend = spawn(process.execPath, ['src/index.ts'], { stdio: ['ignore', log, log], env: process.env });
  let strategyId: number | undefined;
  try {
    await ready(BUNDLER, true); await ready(API + '/health', false);
    check((await request('/health')).chainId === 97, 'backend starts on 3062 with chain 97');
    const challenge = await request('/auth/nonce', 'POST');
    const message = createSiweMessage({ address: owner.address, chainId: 97, domain: str(challenge.domain), uri: str(challenge.uri), nonce: str(challenge.nonce), statement: str(challenge.statement), version: '1', issuedAt: new Date(str(challenge.issuedAt)) });
    token = str((await request('/auth/login', 'POST', { message, signature: await owner.signMessage({ message }) })).token);
    check(token.length > 0, 'real SIWE HTTP login');
    const strategy = await request('/strategies', 'POST', { name: '#87 local testnet acceptance', isPublic: false }, 201);
    assert.equal(typeof strategy.id, 'number'); strategyId = Number(strategy.id);
    // #86 HTTP publication creates hold/stack funding schedules, intentionally rejected by
    // the legacy drift scheduler until BE-2. Build its existing interval fixture through
    // the retained production service; enrollment/faucet remain real authenticated HTTP.
    const version = await publishVersion(strategyId, { allocation: { assets: [{ address: P.assets.TONCOIN.token, weightBps: 10000 }] }, schedule: { kind: 'interval', intervalSeconds: 3600 }, activeAt: new Date(Number((await client.getBlock()).timestamp) * 1000) }, owner.address);
    check(version.executionSchemaVersion === 0, 'production legacy interval fixture (BE-2 hold/stack not asserted)');
    const portfolio = await request('/portfolios', 'POST', { strategyId }, 201);
    check(typeof portfolio.id === 'number' && Array.isArray(portfolio.smartAccounts), 'real strategy publish and Kernel enrollment');
    const portfolioId = Number(portfolio.id);
    const account = addr(obj(portfolio.smartAccounts[0]).address);
    const claimed = await request('/faucet/usdt', 'POST', { account });
    check(claimed.state === 'confirmed' && claimed.amountWei === String(1000n * 10n ** 18n), 'HTTP faucet receipt and exact 1000 MockUSDT');
    const repeat = await request('/faucet/usdt', 'POST', { account }, 429);
    check(obj(repeat.error).code === 'FAUCET_QUOTA_EXCEEDED', 'repeat owner claim rejected durably');
    // Approval is owner-authorized and self-funded; #66 intentionally does not sponsor approve.
    await local.setBalance({ address: account, value: 10n ** 16n });
    const entryPoint = { address: P.contracts.entryPoint, version: '0.7' } as const;
    const sudo = await signerToEcdsaValidator(client, { signer: owner, entryPoint, kernelVersion: KERNEL_V3_3, validatorAddress: P.contracts.ecdsaValidatorV31 });
    const kernel = await createKernelAccount(client, { address: account, plugins: { sudo }, entryPoint, kernelVersion: KERNEL_V3_3,
      factoryAddress: P.contracts.kernelFactoryV33, metaFactoryAddress: P.contracts.kernelMetaFactory, accountImplementationAddress: P.contracts.kernelImplV33 });
    const ownerClient = createKernelAccountClient({ account: kernel, chain: bscTestnet, client, bundlerTransport: http(BUNDLER, { timeout: 120000 }),
      userOperation: { estimateFeesPerGas: async () => { const price = await client.getGasPrice(); return { maxFeePerGas: price, maxPriorityFeePerGas: price }; } } });
    const approveHash = await ownerClient.sendUserOperation({ calls: [{ to: P.contracts.usdt, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [P.contracts.executor, (1n << 256n) - 1n] }) }], callGasLimit: 300000n });
    check((await ownerClient.waitForUserOperationReceipt({ hash: approveHash, timeout: 120000 })).success, 'owner-authorized approve through local alto');
    await local.setBalance({ address: account, value: 0n });
    const localBaseFee = process.env.TESTNET_ACCEPTANCE_GAS_PRICE_WEI;
    assert.ok(localBaseFee && /^[1-9][0-9]*$/.test(localBaseFee), 'supply an explicit local fork base-fee scenario');
    await local.setNextBlockBaseFeePerGas({ baseFeePerGas: BigInt(localBaseFee) });
    await local.mine({ blocks: 1 });
    const depositBefore = await client.readContract({ address: P.contracts.paymaster, abi: pmAbi, functionName: 'getDeposit' });
    // TWAP warm-up advances the local fork. Align ONLY this acceptance process's wall clock
    // to simulated time so the production signer still uses its normal 300-second expiry.
    const now = Date.now;
    const block = await client.getBlock({ blockTag: 'latest' });
    const offset = Number(block.timestamp) * 1000 - now();
    Date.now = () => now() + offset;
    try {
      await query('update portfolios set next_run_at=null where id=$1', [portfolioId]);
      const round = await runSchedulerOnce({ dryRun: false, limit: 10, skipAlerts: true });
      const result = round.results.find((r) => r.portfolioId === portfolioId);
      check(result?.outcome === 'executed', 'production scheduler session-key rebalance executed: ' + (result?.reason ?? 'missing'));
      check(result.plan?.steps.every((step) => step.venue.toLowerCase() === P.contracts.universalRouter), 'all steps use chain 97 Pancake V3');
      assert.ok(result.execution?.txHash);
      const receipt = await client.getTransactionReceipt({ hash: result.execution.txHash });
      check(countSwapExecuted(receipt.logs, P.contracts.executor) === result.plan?.steps.length, 'all executor SwapExecuted events observed');
      const snapshot = await planPortfolio(portfolioId);
      check(snapshot.snapshot.unpriced.length === 0 && snapshot.snapshot.holdings.some((h) => h.asset.toLowerCase() === P.assets.TONCOIN.token && h.amountWei > 0n), '97 snapshot prices bought assets from profile');
      check(await client.readContract({ address: P.assets.TONCOIN.token, abi: erc20Abi, functionName: 'decimals' }) === 9, 'new TONCOIN trades with its real 9-decimal token');
      const status = await request(`/portfolios/${portfolioId}/status`);
      check(JSON.stringify(status).includes('TONCOIN') && !JSON.stringify(status).includes('0x55d398'), 'status ticker uses profile');
      const redeem = await buildRedeemPlan({ portfolioId, plan: snapshot, account }, { close: true }, { publicClient: client, executor: P.contracts.executor, query });
      check(redeem.plan.kind === 'ready' && redeem.plan.steps.every((step) => step.tokenOut.toLowerCase() === P.contracts.usdt), 'redeem plan returns MockUSDT');
      assert.equal(redeem.plan.kind, 'ready');
      const hooks = schedulerPaymaster(account);
      assert.ok(hooks);
      const gaslessOwner = createKernelAccountClient({ account: kernel, paymaster: hooks, chain: bscTestnet, client, bundlerTransport: http(BUNDLER, { timeout: 120000 }),
        userOperation: { estimateFeesPerGas: async () => { const price = await client.getGasPrice(); return { maxFeePerGas: price, maxPriorityFeePerGas: price }; } } });
      const send = async (calls: { to: Address; data: `0x${string}` }[]) => {
        const estimate = await gaslessOwner.estimateUserOperationGas({ calls, paymaster: estimationPaymaster(hooks) });
        const hash = await gaslessOwner.sendUserOperation({ calls, callGasLimit: estimate.callGasLimit * 3n / 2n });
        const receipt = await gaslessOwner.waitForUserOperationReceipt({ hash, timeout: 120000 });
        assert.ok(receipt.success, 'owner withdrawal UserOp must succeed');
        return receipt;
      };
      await send([{ to: P.assets.TONCOIN.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [P.contracts.executor, (1n << 256n) - 1n] }) }]);
      const closed = await send([{ to: P.contracts.executor, data: encodeFunctionData({ abi: EXECUTOR_ABI, functionName: 'executeRebalance', args: [account, redeem.plan.steps, BigInt(redeem.plan.deadline)] }) }]);
      check(countSwapExecuted(closed.receipt.logs, P.contracts.executor) === redeem.plan.steps.length, 'full close actually sells assets through executor floors');
      const cash = await client.readContract({ address: P.contracts.usdt, abi: erc20Abi, functionName: 'balanceOf', args: [account] });
      const before = await client.readContract({ address: P.contracts.usdt, abi: erc20Abi, functionName: 'balanceOf', args: [owner.address] });
      assert.ok(cash > 0n);
      await send([{ to: P.contracts.usdt, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [owner.address, cash] }) }]);
      check(await client.readContract({ address: P.contracts.usdt, abi: erc20Abi, functionName: 'balanceOf', args: [account] }) === 0n &&
        await client.readContract({ address: P.contracts.usdt, abi: erc20Abi, functionName: 'balanceOf', args: [owner.address] }) === before + cash, 'owner receives exact full MockUSDT withdrawal');
    } finally { Date.now = now; }
    check(await client.readContract({ address: P.contracts.paymaster, abi: pmAbi, functionName: 'getDeposit' }) < depositBefore, 'own paymaster paid scheduler gas');
    check(await client.getBalance({ address: account }) === 0n, 'scheduler required no account BNB');
    const sponsored = await query<{ n: string }>('select count(*)::text as n from paymaster_sponsorships where chain_id=97 and sender=$1', [account.toLowerCase()]);
    check(Number(sponsored.rows[0]?.n) >= 1, 'production paymaster persisted authorization');
    // --prune-history cannot serve a deployment-era state binary search. Use the
    // real deployment receipt block supplied by the fork launcher for venue logs.
    const deploymentBlock = process.env.EXECUTOR_DEPLOYMENT_BLOCK;
    assert.ok(deploymentBlock && /^[1-9][0-9]*$/.test(deploymentBlock), 'executor deployment receipt block required');
    const preflight = spawn(process.execPath, ['scripts/preflight.ts', '--chain', '97', '--strict'], { stdio: ['ignore', log, log], env: { ...process.env, EXECUTOR_DEPLOYMENT_BLOCK: deploymentBlock } });
    const code = await new Promise<number | null>((resolve) => preflight.once('exit', resolve));
    check(code === 0, 'strict preflight all green (details in service log)');
    console.log(`TESTNET_97_ACCEPTANCE: ${passes} pass / 0 skip / 0 fail`);
  } finally {
    token = '';
    backend.kill('SIGTERM'); alto.kill('SIGTERM'); closeSync(log);
    if (strategyId !== undefined) {
      await query('delete from paymaster_sponsorships where sender in (select address from smart_accounts where portfolio_id in (select id from portfolios where strategy_id=$1))', [strategyId]);
      await query('delete from portfolios where strategy_id=$1', [strategyId]);
      await query('delete from strategies where id=$1', [strategyId]);
      await query('delete from enrollment_intents where strategy_id=$1', [strategyId]);
      await query('delete from faucet_claims where owner=$1 and chain_id=97', [owner.address.toLowerCase()]);
      await query('delete from auth_sessions where wallet=$1', [owner.address.toLowerCase()]);
    }
    await closePool();
  }
}
main().catch((error: unknown) => { console.error('TESTNET_97_ACCEPTANCE failed: ' + (error instanceof Error ? error.message.split('\n')[0] : 'unknown')); process.exitCode = 1; });
