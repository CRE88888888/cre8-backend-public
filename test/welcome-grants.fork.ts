import { ownerEnroll } from './fixtures/p11-kernel.js';
import { REGISTRY_VERSION_ABI } from '../src/registry-abi.js';
/** Explicit local acceptance, not discovered by bun test. Run after clean contracts main
 * deploy-97.sh on the lane-selected local fork. Env: CHAIN_ID=97, RPC_URL,
 * PORT, DATABASE_URL, TEST_DATABASE_NAME, MIGRATIONS_DIR, OPERATOR_PRIVATE_KEY,
 * TESTNET_MANIFEST (the generated contracts manifest). Never use a public RPC.
 * Current-main registry is an explicit fixture dependency; profile refresh is outside #91.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPublicClient, createTestClient, createWalletClient, decodeEventLog, erc20Abi, http, isAddress } from 'viem';
import type { Address, Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';
import { createSiweMessage } from 'viem/siwe';
import { closePool, query } from '../src/db.js';
import { getConfig, WELCOME_AMOUNT_WEI } from '../src/config.js';
import { REGISTRY_ABI, assertVersionOnchain, readAccountCash } from '../src/chain.js';
import { getKernelAccountParams, computeSalt } from '../src/kernel.js';
import { createPortfolioStrategyService } from '../src/portfolio-strategies.js';
import { requireTypedVersion } from '../src/strategies.js';
import { createWelcomeService, findWelcomeGrant, readWelcomeFundingEvidence } from '../src/welcome-grants.js';
import { readFaucetFundingEvidence } from '../src/faucet.js';
import { createServer } from '../src/server.js';
import { minimumFeeReserve } from '../src/rebalance-plan.js';
import { TESTNET_97 as P } from '../src/testnet-profile.js';
import { welcomeFixture } from './fixtures/welcome.js';

import { localAcceptanceEnv } from './fixtures/local-acceptance.js';
const endpoints = localAcceptanceEnv(process.env, true);
assert.ok(endpoints.bundler);
const BUNDLER = endpoints.bundler.url;
const RPC = endpoints.rpcUrl, API = endpoints.apiUrl;
const client = createPublicClient({ chain: bscTestnet, transport: http(RPC, { retryCount: 0, timeout: 120000 }), cacheTime: 0 });
const local = createTestClient({ chain: bscTestnet, mode: 'anvil', transport: http(RPC) });
const operator = createWalletClient({ account: P.roles.operator, chain: bscTestnet, transport: http(RPC) });
let passes = 0, token = '';
function check(value: unknown, label: string): asserts value { assert.ok(value, label); passes++; console.log('PASS ' + label); }
function obj(value: unknown): Record<string, unknown> { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return Object.fromEntries(Object.entries(value)); }
function str(value: unknown): string { assert.equal(typeof value, 'string'); return String(value); }
function addr(value: unknown): Address { const s = str(value); assert.ok(isAddress(s, { strict: false })); return s; }
async function landed(hash: Hex) { await local.mine({ blocks: 1 }); const r = await client.getTransactionReceipt({ hash }); assert.equal(r.status, 'success'); return r; }
async function request(path: string, method = 'GET', body?: unknown, expected = 200) {
  const response = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) });
  const data = obj(await response.json()); assert.equal(response.status, expected, path + ': ' + String(obj(data.error ?? {}).code ?? 'ok')); return data;
}
async function main() {
  const c = getConfig();
  check(c.chainId === 97 && c.rpcUrl === RPC && c.port === endpoints.backendPort && new URL(c.databaseUrl).pathname === '/' + endpoints.databaseName, 'dedicated local ports, chain and DB');
  const info = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_nodeInfo', params: [] }) }).then(r => r.json());
  check(obj(info).result && await client.getChainId() === 97, 'anvil chain 97 guard');
  assert.ok(process.env.TESTNET_MANIFEST);
  const manifest = obj(JSON.parse(await readFile(process.env.TESTNET_MANIFEST, 'utf8')));
  const contracts = obj(manifest.contracts), registry = addr(contracts.registry), executor = addr(contracts.executor);
  check(addr(contracts.usdt).toLowerCase() === P.contracts.usdt, 'current-main manifest USDT matches product funding token');
  await local.impersonateAccount({ address: P.roles.operator }); await local.setBalance({ address: P.roles.operator, value: 100n * 10n ** 18n });
  const owner = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 5 });
  async function prepareFund(name: string) {
    const f = await welcomeFixture(owner.address.toLowerCase() as Address, 'hold', { p11: true, activeAt: new Date(Number((await client.getBlock()).timestamp + 86500n) * 1000) });
    const registration = await landed(await operator.writeContract({ address: registry, abi: REGISTRY_ABI, functionName: 'registerStrategy', args: [name, '', false] }));
    let onchainId: bigint | undefined;
    for (const log of registration.logs) {
      try { onchainId = decodeEventLog({ abi: REGISTRY_ABI, eventName: 'StrategyRegistered', data: log.data, topics: log.topics }).args.id; } catch { /* unrelated log */ }
    }
    assert.ok(onchainId);
    await query('update strategies set onchain_id=$2 where id=$1', [f.strategyId, onchainId.toString()]);
    const v = await requireTypedVersion(f.strategyId, 1, Number(onchainId), undefined, { chainId: 97, verifyChain: false });
    assert.ok(v.configHash && v.activeAt && v.versionSettings);
    await landed(await operator.writeContract({ address: registry, abi: REGISTRY_ABI, functionName: 'publishSettingsVersion', args: [onchainId,
      v.allocation.assets.map(a => addr(a.address)), v.allocation.assets.map(a => a.weightBps), v.versionSettings.scheduleHash, v.versionSettings.settingsHash,
      v.versionSettings.performanceFeeBps, BigInt(Date.parse(v.activeAt) / 1000)] }));
    const kernel = await getKernelAccountParams(client, owner.address, computeSalt(owner.address, BigInt(f.strategyId)));
    await landed(await operator.sendTransaction({ to: kernel.factory, data: kernel.factoryData }));
    check((await client.getCode({ address: kernel.address })) !== '0x', 'real Kernel deployed');
    await query('update smart_accounts set address=$2 where portfolio_id=$1', [f.id, kernel.address.toLowerCase()]);
    return { f, kernel, onchainId, activeAt: BigInt(Date.parse(v.activeAt) / 1000) };
  }
  const first = await prepareFund('welcome124-local'), otherFund = await prepareFund('welcome124-second-local');
  const wall = BigInt(Math.floor(Date.now() / 1000));
  assert.ok(first.activeAt <= wall && otherFund.activeAt <= wall, 'the old fork must cover both full notice periods');
  await local.setNextBlockTimestamp({ timestamp: wall }); await local.mine({ blocks: 1 });
  const { f, kernel, onchainId } = first;
  await ownerEnroll(client, owner, kernel.address, onchainId, RPC, BUNDLER);
  check(await client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'isEnrolled', args: [kernel.address] }), 'real current-main receipt-time enrollment');
  const service = createPortfolioStrategyService({ ...f.deps, welcome: createWelcomeService(),
    feeReserve: async p => {
      const row = (await query<{ onchain_id: string }>('select onchain_id from strategies where id=$1', [p.strategyId])).rows[0]; assert.ok(row);
      return minimumFeeReserve(client, executor, BigInt(row.onchain_id), await client.getBlockNumber({ cacheTime: 0 }), addr(p.accountAddress), true);
    },
    version: (sid, version, chainSid, account, options) => requireTypedVersion(sid, version, chainSid, account, { ...options, chainId: 97,
      assertOnchain: (sid, version, expected, account, opts) => assertVersionOnchain(sid, version, expected, account, { ...opts, client, registry }) }),
    cash: (chain, account) => readAccountCash(chain, account, client), welcomeEvidence: g => readWelcomeFundingEvidence(g, client), evidence: g => readFaucetFundingEvidence(g, client) });
  const server = createServer({ portfolioStrategies: service });
  await new Promise<void>(resolve => server.listen(endpoints.backendPort, '127.0.0.1', resolve));
  try {
    const challenge = await request('/auth/nonce', 'POST');
    const message = createSiweMessage({ address: owner.address, chainId: 97, domain: str(challenge.domain), uri: str(challenge.uri), nonce: str(challenge.nonce), statement: str(challenge.statement), version: '1', issuedAt: new Date(str(challenge.issuedAt)) });
    token = str((await request('/auth/login', 'POST', { message, signature: await owner.signMessage({ message }) })).token);
    check(token.length > 0, 'real SIWE authenticated HTTP');
    const beforeNonce = await client.getTransactionCount({ address: P.roles.operator, blockTag: 'latest' });
    const path = `/portfolios/${f.id}/buy-funding`;
    const concurrent = await Promise.all([fetch(API + path, { method: 'POST', body: '{}', headers: { authorization: 'Bearer ' + token } }), fetch(API + path, { method: 'POST', body: '{}', headers: { authorization: 'Bearer ' + token } })]);
    if (!concurrent.some(r => r.status === 200)) {
      const outcomes = await Promise.all(concurrent.map(async r => { const body = obj(await r.json()), error = obj(body.error ?? {}); return { status: r.status, code: typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'unknown' }; }));
      console.error('WELCOME_CONCURRENT_FAILURE ' + JSON.stringify(outcomes));
    }
    check(concurrent.filter(r => r.status === 200).length === 1 && concurrent.filter(r => r.status === 409).length === 1, 'concurrent first buys: one success, one portfolio busy');
    const grant = await findWelcomeGrant(97, owner.address); assert.ok(grant?.txHash);
    check(grant.state === 'confirmed' && grant.amountWei === WELCOME_AMOUNT_WEI, 'original grant confirmed for exactly 10000');
    check(await client.readContract({ address: P.contracts.usdt, abi: erc20Abi, functionName: 'balanceOf', args: [kernel.address] }) === WELCOME_AMOUNT_WEI, 'real mint deposited 10000');
    const nonceAfter = await client.getTransactionCount({ address: P.roles.operator, blockTag: 'latest' });
    check(nonceAfter === beforeNonce + 1, 'exactly one operator mint broadcast');
    const replay = await request(path, 'POST', {}); check(obj(replay.lot).replayed === true, 'HTTP retry reuses original lot');
    check(await client.getTransactionCount({ address: P.roles.operator, blockTag: 'latest' }) === nonceAfter, 'retry sends no new nonce');
    // A second genuinely deployed/enrolled fund for the same controlling owner.
    const { f: other, kernel: otherKernel, onchainId: otherOnchainId } = otherFund;
    await ownerEnroll(client, owner, otherKernel.address, otherOnchainId, RPC, BUNDLER);
    const second = await request(`/portfolios/${other.id}/buy-funding`, 'POST', {}, 409);
    check(obj(second.error).code === 'DAILY_FAUCET_REQUIRED', 'same owner second fund cannot receive welcome');
    const daily = await request('/faucet/usdt', 'POST', { account: kernel.address });
    check(daily.state === 'confirmed' && daily.amountWei === (1000n * 10n ** 18n).toString(), 'same-day real daily claimFor receives 1000');
    const lot = await request(`/portfolios/${f.id}/funding-lots`, 'POST', { source: { kind: 'faucet_claim', claimId: daily.claimId } });
    check(obj(lot.source).kind === 'faucet_claim', 'daily lot has explicit independent source');
    const rows = (await query<{ total: string; n: string }>('select sum(amount_raw)::text as total,count(*)::text as n from strategy_funding_lots where portfolio_id=$1', [f.id])).rows[0];
    check(rows?.total === (11000n * 10n ** 18n).toString() && rows.n === '2', '2 lots, exactly 11000 total approved input');
    check(await client.readContract({ address: P.contracts.usdt, abi: erc20Abi, functionName: 'balanceOf', args: [kernel.address] }) === 11000n * 10n ** 18n, 'real account balance equals 11000');
    const repeat = await request('/faucet/usdt', 'POST', { account: kernel.address });
    check(repeat.replayed === true && repeat.claimId === daily.claimId && repeat.txHash === daily.txHash && repeat.state === daily.state, 'daily retry returns the original claim without minting');
    const disabled = await request('/points/tasks', 'GET', undefined, 503);
    check(obj(disabled.error).code === 'POINTS_DISABLED', 'testnet points remain disabled');
    console.log(`WELCOME_91_FORK: ${passes} pass / 0 skip / 0 fail`);
  } finally { token = ''; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
try { await main(); } catch { console.error(`WELCOME_91_FORK: ${passes} pass / 0 skip / 1 fail (local assertion failed; no credentials logged)`); process.exitCode = 1; }
finally { await closePool(); }
