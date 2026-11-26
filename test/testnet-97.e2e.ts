import { stockMarketOpen } from '../src/trading-calendar.js';
import { refreshP11Markets, ownerSetupPaymaster } from './fixtures/p11-kernel.js';
/** #87 opt-in acceptance. Run with bun run test/testnet-97.e2e.ts after the CLEAN
 * contracts main e699bd8 deploy-97.sh on the lane-selected local fork and a 30-minute warm-up. No automatic bun-test discovery.
 * Env only: CHAIN_ID=97, RPC_URL, PORT, DATABASE_URL, TEST_DATABASE_NAME, MIGRATIONS_DIR, OPERATOR_PRIVATE_KEY, SESSION_KEY_MASTER_SEED,
 * PAYMASTER_SIGNER_PRIVATE_KEY, BUNDLER_EXECUTOR_PRIVATE_KEY, BUNDLER_UTILITY_PRIVATE_KEY,
 * ALTO_CLI_PATH (installed alto CLI), BUNDLER_URL (distinct localhost port),
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
import { EXECUTOR_ABI, REGISTRY_ABI } from '../src/chain.js';
import { schedulerPaymaster, estimationPaymaster } from '../src/paymaster.js';
import { planPortfolio } from '../src/snapshot.js';
import { signPreparedOperation } from '../src/user-operation.js';
import { publishVersion } from '../src/strategies.js';
import { localAcceptanceEnv } from './fixtures/local-acceptance.js';
const endpoints = localAcceptanceEnv(process.env, true);
assert.ok(endpoints.bundler);
const RPC = endpoints.rpcUrl, API = endpoints.apiUrl, BUNDLER = endpoints.bundler.url;
const bundlerPort = endpoints.bundler.port;
const localPreload = process.env.P11_LOCAL_ROLES === '1' ? ['--preload', './test/fixtures/p11-local-roles.ts'] : [];
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
function hex(value: unknown): `0x${string}` { assert.ok(typeof value === 'string' && /^0x[0-9a-f]*$/i.test(value)); return value as `0x${string}`; }
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
  check(config.chainId === 97 && config.rpcUrl === RPC && config.port === endpoints.backendPort && new URL(config.databaseUrl).pathname === '/' + endpoints.databaseName, 'dedicated chain/ports/DB guard');
  check(process.env.BUNDLER_URL === BUNDLER && process.env.ALTO_CLI_PATH && process.env.PAYMASTER_SIGNER_PRIVATE_KEY && process.env.BUNDLER_EXECUTOR_PRIVATE_KEY && process.env.BUNDLER_UTILITY_PRIVATE_KEY, 'required env only');
  // anvil_nodeInfo is intentionally unavailable on a public RPC.
  const info = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_nodeInfo', params: [] }) }).then((r) => r.json());
  check(obj(info).result && await client.getChainId() === 97, 'local anvil chain 97');
  // Local fee scenarios: EOA setup needs room for anvil's suggested 1 gwei tip.
  // UserOps later use the local fork fee scenario under the unchanged USD budget.
  await local.setNextBlockBaseFeePerGas({ baseFeePerGas: 10_000_000_000n });
  await local.mine({ blocks: 1 });
  check((await checkTestnetProfile(client)).every((c) => c.level === 'ok'), 'all configured local runtime hashes and selectors');
  mkdirSync('.bun-cache', { recursive: true });
  const log = openSync('.bun-cache/testnet-services-87.log', 'a', 0o600);
  const alto = spawn('sh', ['alto/entrypoint.sh'], { stdio: ['ignore', log, log], env: { ...process.env, CHAIN_ID: '97', PORT: String(bundlerPort), RPC_URL: RPC,
    EXECUTOR_PRIVATE_KEY: process.env.BUNDLER_EXECUTOR_PRIVATE_KEY, UTILITY_PRIVATE_KEY: process.env.BUNDLER_UTILITY_PRIVATE_KEY } });
  const backend = spawn(process.execPath, [...localPreload, 'src/index.ts'], { stdio: ['ignore', log, log], env: process.env });
  let strategyId: number | undefined;
  try {
    await ready(BUNDLER, true); await ready(API + '/health', false);
    check((await request('/health')).chainId === 97, 'backend starts on the selected local port with chain 97');
    const challenge = await request('/auth/nonce', 'POST');
    const message = createSiweMessage({ address: owner.address, chainId: 97, domain: str(challenge.domain), uri: str(challenge.uri), nonce: str(challenge.nonce), statement: str(challenge.statement), version: '1', issuedAt: new Date(str(challenge.issuedAt)) });
    token = str((await request('/auth/login', 'POST', { message, signature: await owner.signMessage({ message }) })).token);
    check(token.length > 0, 'real SIWE HTTP login');
    const strategy = await request('/strategies', 'POST', { name: '#87 local testnet acceptance', isPublic: false }, 201);
    assert.equal(typeof strategy.id, 'number'); strategyId = Number(strategy.id);
    // #86 HTTP publication creates hold/stack funding schedules, intentionally rejected by
    // the legacy drift scheduler until BE-2. Build its existing interval fixture through
    // the retained production service; enrollment/faucet remain real authenticated HTTP.
    const version = await publishVersion(strategyId, { allocation: { assets: [{ address: P.assets.TONCOIN.token, weightBps: 10000 }] }, schedule: { kind: 'interval', intervalSeconds: 3600 }, activeAt: new Date(Number((await client.getBlock()).timestamp + 86500n) * 1000) }, owner.address);
    check(version.executionSchemaVersion === 0, 'production legacy interval fixture (BE-2 hold/stack not asserted)');
    assert.ok(version.activeAt);
    await local.setNextBlockTimestamp({ timestamp: BigInt(Math.max(Date.parse(version.activeAt) / 1000, Math.floor(Date.now() / 1000))) }); await local.mine({ blocks: 1 });
    await refreshP11Markets(client, RPC, [P.assets.TONCOIN.token, P.assets.WBNB.token]);
    const prepared = await request('/portfolios', 'POST', { strategyId });
    check(prepared.signingMode === 'sudo' && prepared.expectedVersion === 1 && !('id' in prepared), 'HTTP preparation requires owner sudo and creates no portfolio');
    const account = addr(prepared.account);
    const accountCode = await client.getCode({ address: account });
    check(prepared.accountDeployed === true && accountCode && accountCode !== '0x', 'operator deploys Kernel before owner setup; API confirms deployment');
    check(!('factory' in prepared) && !('factoryData' in prepared), 'setup API provides no initCode deployment arguments');
    const deploymentNonce = await client.getTransactionCount({ address: P.roles.operator });
    const repeated = await request('/portfolios/enrollment-params', 'POST', { strategyId });
    const afterRetryNonce = await client.getTransactionCount({ address: P.roles.operator });
    check(repeated.account === prepared.account && repeated.accountDeployed === true && afterRetryNonce === deploymentNonce, 'HTTP retry reuses deployed account without another operator transaction');
    await request('/portfolios/enrollment-confirm', 'POST', { strategyId }, 409);
    // The owner signs enrollment only; the real paymaster sponsors the deployed Kernel at zero BNB.
    assert.equal(await client.getBalance({ address: account }), 0n);
    const setupTime = Number((await client.getBlock()).timestamp);
    const setupPaymaster = ownerSetupPaymaster(account, owner.address, () => setupTime); assert.ok(setupPaymaster);
    const entryPoint = { address: P.contracts.entryPoint, version: '0.7' } as const;
    const sudo = await signerToEcdsaValidator(client, { signer: owner, entryPoint, kernelVersion: KERNEL_V3_3, validatorAddress: P.contracts.ecdsaValidatorV31 });
    const kernel = await createKernelAccount(client, { address: account, plugins: { sudo }, entryPoint, kernelVersion: KERNEL_V3_3,
      factoryAddress: P.contracts.kernelFactoryV33, metaFactoryAddress: P.contracts.kernelMetaFactory, accountImplementationAddress: P.contracts.kernelImplV33 });
    const ownerClient = createKernelAccountClient({ account: kernel, paymaster: setupPaymaster, chain: bscTestnet, client, bundlerTransport: http(BUNDLER, { timeout: 120000 }),
      userOperation: { estimateFeesPerGas: async () => { const price = await client.getGasPrice(); return { maxFeePerGas: price, maxPriorityFeePerGas: price }; } } });
    const enrollCall = obj(prepared.call);
    const setupCalls = [
      { to: addr(enrollCall.to), data: hex(enrollCall.data) },
      { to: P.contracts.usdt, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [P.contracts.executor, (1n << 256n) - 1n] }) },
    ];
    const nonce = await kernel.getNonce();
    const estimate = await ownerClient.estimateUserOperationGas({ calls: setupCalls, nonce, paymaster: estimationPaymaster(setupPaymaster) });
    const setupOperation = await ownerClient.prepareUserOperation({ calls: setupCalls, nonce, callGasLimit: estimate.callGasLimit * 3n / 2n,
      verificationGasLimit: estimate.verificationGasLimit, preVerificationGas: estimate.preVerificationGas });
    assert.equal(setupOperation.factory, undefined); assert.equal(setupOperation.factoryData, undefined);
    const setupHash = await ownerClient.sendUserOperation(await signPreparedOperation(setupOperation, op => kernel.signUserOperation(op)));
    const setup = await ownerClient.waitForUserOperationReceipt({ hash: setupHash, timeout: 120000 });
    check(setup.success && setup.receipt.status === 'success', 'one real owner sudo UserOp without initCode enrolls expected version and approves USDT');
    check((await client.readContract({ address: P.contracts.registry, abi: REGISTRY_ABI, functionName: 'enrollments', args: [account] }))[1] === 1, 'registry records owner-accepted version');
    const portfolio = await request('/portfolios/enrollment-confirm', 'POST', { strategyId });
    check(typeof portfolio.id === 'number' && Array.isArray(portfolio.smartAccounts), 'only canonical owner enrollment creates the portfolio');
    const portfolioId = Number(portfolio.id);
    const claimed = await request('/faucet/usdt', 'POST', { account });
    check(claimed.state === 'confirmed' && claimed.amountWei === String(1000n * 10n ** 18n), 'HTTP faucet receipt and exact 1000 MockUSDT');
    const repeat = await request('/faucet/usdt', 'POST', { account });
    check(repeat.replayed === true && repeat.claimId === claimed.claimId && repeat.txHash === claimed.txHash && repeat.state === claimed.state, 'same-recipient retry returns the original durable claim');
    check(await client.getBalance({ address: account }) === 0n, 'owner setup requires zero account BNB');
    let openTime = (await client.getBlock()).timestamp;
    const lastOpenTime = openTime + 7n * 86400n;
    while (!stockMarketOpen(new Date(Number(openTime) * 1000)) && openTime < lastOpenTime) openTime += 60n;
    assert.ok(stockMarketOpen(new Date(Number(openTime) * 1000)), 'ordinary scheduler requires an admitted open session');
    await refreshP11Markets(client, RPC);
    const localBaseFee = process.env.TESTNET_ACCEPTANCE_GAS_PRICE_WEI;
    assert.ok(localBaseFee && /^[1-9][0-9]*$/.test(localBaseFee), 'supply an explicit local fork base-fee scenario');
    await local.setNextBlockBaseFeePerGas({ baseFeePerGas: BigInt(localBaseFee) });
    await local.mine({ blocks: 1 });
    const depositBefore = await client.readContract({ address: P.contracts.paymaster, abi: pmAbi, functionName: 'getDeposit' });
    // Calendar admission is an explicit scenario input. RPC and DB observations keep
    // the real wall clock, including every production freshness/expiry check.
    const calendarNow = new Date(Number(openTime) * 1000);
    {
      await query('update portfolios set next_run_at=null where id=$1', [portfolioId]);
      const round = await runSchedulerOnce({ dryRun: false, limit: 10, skipAlerts: true, now: calendarNow });
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
      const redeem = await buildRedeemPlan({ portfolioId, plan: snapshot, account }, { close: true }, { publicClient: client, executor: P.contracts.executor, query, now: () => calendarNow });
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
    }
    check(await client.readContract({ address: P.contracts.paymaster, abi: pmAbi, functionName: 'getDeposit' }) < depositBefore, 'own paymaster paid scheduler gas');
    check(await client.getBalance({ address: account }) === 0n, 'scheduler required no account BNB');
    const sponsored = await query<{ n: string }>('select count(*)::text as n from paymaster_sponsorships where chain_id=97 and sender=$1', [account.toLowerCase()]);
    check(Number(sponsored.rows[0]?.n) >= 1, 'production paymaster persisted authorization');
    // Use the actual deployment receipt block, retaining enough local state
    // history to verify code creation as well as all venue events.
    const deploymentBlock = process.env.EXECUTOR_DEPLOYMENT_BLOCK;
    assert.ok(deploymentBlock && /^[1-9][0-9]*$/.test(deploymentBlock), 'executor deployment receipt block required');
    const preflight = spawn(process.execPath, [...localPreload, 'scripts/preflight.ts', '--chain', '97', '--strict'], { stdio: ['ignore', log, log], env: { ...process.env, EXECUTOR_DEPLOYMENT_BLOCK: deploymentBlock } });
    const code = await new Promise<number | null>((resolve) => preflight.once('exit', resolve));
    check(code === 0, 'strict preflight all green (details in service log)');
  } finally {
    token = '';
    backend.kill('SIGTERM'); alto.kill('SIGTERM'); closeSync(log);
    try {
      if (strategyId !== undefined) {
        await query('delete from paymaster_sponsorships where sender in (select address from smart_accounts where portfolio_id in (select id from portfolios where strategy_id=$1))', [strategyId]);
        await query('delete from portfolios where strategy_id=$1', [strategyId]);
        await query('delete from enrollment_intents where strategy_id=$1', [strategyId]);
        await query('delete from strategies where id=$1', [strategyId]);
        // Faucet claims and original outbox bytes are immutable evidence. Keep both;
        // this isolated disposable DB is reset by the acceptance launcher between suites.
        await query('delete from auth_sessions where wallet=$1', [owner.address.toLowerCase()]);
      }
    } finally { await closePool(); }
  }
  console.log(`TESTNET_97_ACCEPTANCE: ${passes} pass / 0 skip / 0 fail`);
}
main().catch((error: unknown) => {
  const trail: { name: string; code?: string | number; aa?: string; selector?: string; reason?: string }[] = [];
  for (let value = error, depth = 0; depth < 8 && typeof value === 'object' && value !== null; depth++) {
    const name = Reflect.get(value, 'name'), code = Reflect.get(value, 'code'), message = Reflect.get(value, 'message'), data = Reflect.get(value, 'data');
    const item: (typeof trail)[number] = { name: typeof name === 'string' && /^[A-Za-z]{1,64}$/.test(name) ? name : 'Error' };
    if (typeof code === 'number' || typeof code === 'string' && /^[A-Z_]{1,80}$/.test(code)) item.code = code;
    if ((code === -32502 || code === -32500) && typeof message === 'string') item.reason = message.replace(/0x[0-9a-f]+/gi, '<hex>').replace(/(?:https?|postgres(?:ql)?):\S+/g, '<endpoint>').slice(0, 240);
    if (typeof message === 'string') item.aa = message.match(/\bAA[0-9]{2}\b/)?.[0];
    if (typeof data === 'string' && /^0x[0-9a-f]+$/i.test(data)) item.selector = data.slice(0, 10);
    trail.push(item); value = Reflect.get(value, 'cause');
  }
  console.error('TESTNET_97_ACCEPTANCE failed ' + JSON.stringify(trail)); process.exitCode = 1;
});
