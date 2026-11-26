/** Opt-in #168 acceptance, never auto-discovered by bun test.
 * Start a fresh chain-97 anvil fork at 127.0.0.1:8568 and create an EMPTY
 * cre8_x1_168_fork database, then: bun run test/testnet-launch-funds.fork.ts
 * Only the public anvil mnemonic is used. Impersonation is local test setup.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createPublicClient, createTestClient, createWalletClient, http, parseAbi, erc20Abi, keccak256, encodeAbiParameters, encodeFunctionData, toHex } from 'viem';
import type { Address, Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';
import { closePool, migrate, query } from '../src/db.js';
import { createStrategy, publishVersion, getStrategy, listStrategies, validateAllocation } from '../src/strategies.js';
import { REGISTRY_ABI, REGISTRY_VERSION_ABI, EXECUTOR_ABI } from '../src/chain.js';
import { minimumFeeReserve, quoteNewMoney, checkTradeMinimums } from '../src/rebalance-plan.js';
import { assetBatchBudget } from '../src/asset-plan.js';
import { launchFunds } from '../scripts/testnet-launch-funds.js';
import lineup from './fixtures/launch-lineup.json' with { type: 'json' };
import { TESTNET_97 as T } from '../src/testnet-profile.js';
import { countSwapExecuted } from '../src/scheduler.js';
import { record } from '../src/strategy-execution.js';
import { refreshP11Markets } from './fixtures/p11-kernel.js';
import { launchKernel } from './fixtures/launch-kernel.js';

const rpc = 'http://127.0.0.1:8568';
const client = createPublicClient({ chain: bscTestnet, pollingInterval: 20, cacheTime: 0, transport: http(rpc, { retryCount: 0, timeout: 15000 }) });
const local = createTestClient({ chain: bscTestnet, mode: 'anvil', transport: http(rpc) });
const owner = mnemonicToAccount('test test test test test test test test test test test junk');
const U = 10n ** 18n;
const journal = '.bun-cache/launch-168-fork-' + randomUUID();
let passes = 0;
function check(value: unknown, label: string): asserts value { assert.ok(value, label); console.log('PASS ' + label); passes++; }
async function landed(hash: Hex) { await local.mine({ blocks: 1 }); const r = await client.waitForTransactionReceipt({ hash, timeout: 30000 }); assert.equal(r.status, 'success'); return r; }
async function cli(args: string[], expectedExit = 0, env: Record<string, string> = {}) {
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/testnet-launch-funds.ts', '--journal', journal, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += String(data); });
    child.stderr.on('data', data => { output += String(data); });
    child.once('error', reject); child.once('exit', code => resolve({ code, output }));
  });
  assert.equal(result.code, expectedExit, 'unexpected launcher exit: ' + result.output.split('\n').filter(line => line.startsWith('[testnet-launch]')).join('\n'));
  return result.output.split('\n').filter(line => line.startsWith('{')).map((line): unknown => JSON.parse(line));
}
async function main() {
  check(await client.getChainId() === 97 && await local.getAutomine(), 'dedicated local chain-97 anvil');
  process.env.CHAIN_ID = '97'; process.env.RPC_URL = rpc; process.env.DATABASE_URL = 'postgres:///cre8_x1_168_fork';
  const privateKey = owner.getHdKey().privateKey; assert.ok(privateKey);
  process.env.OPERATOR_PRIVATE_KEY = '0x' + Buffer.from(privateKey).toString('hex');
  process.env.OPERATOR_WALLETS = owner.address;
  await migrate();
  assert.equal((await query('select id from strategies')).rows.length, 0, 'use a fresh disposable DB');
  // The original fork owner appoints the public anvil operator locally. No key is read.
  const adminAbi = parseAbi(['function owner() view returns(address)', 'function setOperator(address)']);
  const admin = await client.readContract({ address: T.contracts.registry, abi: adminAbi, functionName: 'owner' });
  await local.impersonateAccount({ address: admin }); await local.setBalance({ address: admin, value: 100n * U });
  const adminWallet = createWalletClient({ chain: bscTestnet, account: admin, transport: http(rpc) });
  await landed(await adminWallet.writeContract({ address: T.contracts.registry, abi: adminAbi, functionName: 'setOperator', args: [owner.address] }));
  await local.stopImpersonatingAccount({ address: admin });
  const beforeMissingSchema = await client.getTransactionCount({ address: owner.address });
  await query('alter table strategies rename column category to unavailable_category');
  try { await cli(['--execute'], 1); }
  finally { await query('alter table strategies rename column unavailable_category to category'); }
  check(await client.getTransactionCount({ address: owner.address }) === beforeMissingSchema &&
    (await query('select id from strategies')).rows.length === 0, 'missing 0054 rejected before registration even on an empty DB');
  const mag7 = await createStrategy({ name: 'Mag7', isPublic: true }, owner.address);
  await publishVersion(mag7.id, { allocation: { assets: [{ address: T.assets.AAPLB.token, weightBps: 10000 }] },
    schedule: { kind: 'interval', intervalSeconds: 60 }, activeAt: new Date(Number((await client.getBlock()).timestamp + 2n) * 1000) }, owner.address);
  const old = await createStrategy({ name: '舊示範基金', isPublic: true }, owner.address);
  const oldVersion = (await getStrategy(mag7.id)).versions[0]; assert.ok(oldVersion?.activeAt);
  // Represent an old demo whose publication was more than seven days ago.
  // AtpRegistry's source layout puts lastPublishedAt in mapping slot 10. Verify
  // that slot against the getter before changing this local fixture; retain the
  // real publication interval and the real 24h activation rule in product code.
  assert.ok(mag7.onchainId);
  const slot = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [BigInt(mag7.onchainId), 10n]));
  const publishedAt = await client.readContract({ address: T.contracts.registry, abi: REGISTRY_VERSION_ABI, functionName: 'lastPublishedAt', args: [BigInt(mag7.onchainId)] });
  assert.ok(publishedAt > 0n);
  assert.equal(BigInt(await client.getStorageAt({ address: T.contracts.registry, slot }) ?? '0x0'), publishedAt);
  await local.setStorageAt({ address: T.contracts.registry, index: slot, value: toHex(publishedAt - 604801n, { size: 32 }) });
  const current = (await client.getBlock()).timestamp;
  const firstActive = BigInt(Date.parse(oldVersion.activeAt) / 1000);
  await local.setNextBlockTimestamp({ timestamp: (current > firstActive ? current : firstActive) + 1n }); await local.mine({ blocks: 1 });
  const args = ['--mag7-id', String(mag7.id), '--hide-ids', String(old.id)];
  const before = await client.getTransactionCount({ address: owner.address });
  const plan = await cli(args);
  const planned = plan.find(v => record(v) && v.mode === 'dry-run');
  check(record(planned) && Array.isArray(planned.funds) && planned.funds.length === 21 && await client.getTransactionCount({ address: owner.address }) === before &&
    (await query('select id from strategies')).rows.length === 2, 'dry-run: 21 planned, no DB writes or transactions');
  const otherKey = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 1 }).getHdKey().privateKey; assert.ok(otherKey);
  await cli([...args, '--execute'], 1, { OPERATOR_PRIVATE_KEY: '0x' + Buffer.from(otherKey).toString('hex') });
  check(await client.getTransactionCount({ address: owner.address }) === before && (await query('select id from strategies')).rows.length === 2, 'nonoperator signer rejected before DB or chain writes');
  await cli([...args, '--execute'], 1, { CHAIN_ID: '56' });
  check(await client.getTransactionCount({ address: owner.address }) === before, 'mainnet configuration rejected before any write');
  await cli([...args, '--execute']);
  const catalogue = (await listStrategies({ provider: owner.address, isPublic: true })).items;
  check(catalogue.length === 21 && catalogue.every(s => s.catalogKey !== null && s.category !== null), '21 catalogue funds published with categories');
  check(!(await getStrategy(old.id)).isPublic && (await getStrategy(old.id)).id === old.id, 'old demo hidden and still directly readable');
  const updated = await getStrategy(mag7.id);
  check(updated.catalogKey === 'mag7' && updated.versions.length === 2 && updated.onchainId === mag7.onchainId, 'Mag7 reused its identity and published v2');
  const nonce = await client.getTransactionCount({ address: owner.address });
  await cli([...args, '--execute']);
  check(await client.getTransactionCount({ address: owner.address }) === nonce &&
    (await getStrategy(mag7.id)).versions.length === 2, 'rerun sends no registration/publication transaction');

  const fund = launchFunds(lineup).find(f => f.key === 'ai-chips'); assert.ok(fund);
  const strategy = catalogue.find(s => s.catalogKey === fund.key); assert.ok(strategy?.onchainId);
  const version = (await getStrategy(strategy.id)).versions[0]; assert.ok(version?.activeAt);
  await local.setNextBlockTimestamp({ timestamp: BigInt(Math.max(Date.parse(updated.versions[0]?.activeAt ?? '') / 1000, Date.parse(version.activeAt) / 1000)) + 1n });
  await local.mine({ blocks: 1 });
  const kernel = await launchKernel(client, rpc, owner, BigInt(strategy.id));
  await kernel.send([
    { to: T.contracts.registry, data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'enroll', args: [kernel.address, BigInt(strategy.onchainId), version.version] }) },
    { to: T.contracts.usdt, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [T.contracts.executor, 50n * U] }) },
  ]);
  check(true, 'real owner-signed Kernel UserOp enrolled and approved USDT through EntryPoint');
  // Fund/refresh the existing mocks through their real methods. No oracle storage is replaced.
  const allocation = validateAllocation(fund.input.allocation, 97);
  const selected = Object.values(T.assets).filter(a => allocation.assets.some(target => target.address === a.token && target.weightBps > 0));
  await refreshP11Markets(client, rpc, selected.map(a => a.token));
  console.log('SETUP refreshed real pool observations with keeper swaps');
  await local.impersonateAccount({ address: T.roles.keeper }); await local.setBalance({ address: T.roles.keeper, value: 100n * U });
  const keeper = createWalletClient({ chain: bscTestnet, account: T.roles.keeper, transport: http(rpc, { timeout: 15000, retryCount: 0 }) });
  await landed(await keeper.writeContract({ address: T.contracts.usdt, abi: erc20Abi, functionName: 'transfer', args: [kernel.address, 50n * U] }));
  console.log('SETUP transferred 50 USDT');
  await local.stopImpersonatingAccount({ address: T.roles.keeper });
  const block = await client.getBlock();
  const reserve = await minimumFeeReserve(client, T.contracts.executor, BigInt(strategy.onchainId), block.number, kernel.address, true);
  const budgets = Object.fromEntries(selected.map(a => [a.token, (50n * U * BigInt(allocation.assets.find(t => t.address === a.token)?.weightBps ?? 0) / 10000n).toString()]));
  const batch = assetBatchBudget(budgets, reserve, new Map(selected.map(a => [a.token, null])), 50n * U, 16, new Set(selected.map(a => a.token)), true); assert.ok(batch);
  const oracle = await client.readContract({ address: T.contracts.executor, abi: parseAbi(['function oracle() view returns(address)']), functionName: 'oracle' });
  const quoted = await quoteNewMoney({ publicClient: client, executor: T.contracts.executor, registry: T.contracts.registry, oracle,
    strategyId: BigInt(strategy.onchainId), blockNumber: block.number, cash: T.contracts.usdt, inputs: batch.inputs, deadline: block.timestamp + 1800n });
  assert.equal(quoted.kind, 'ready', JSON.stringify(quoted, (_key, v) => typeof v === 'bigint' ? v.toString() : v));
  if (quoted.kind !== 'ready') throw new Error('missing quote');
  const balances = new Map<Address, bigint>();
  for (const asset of selected) balances.set(asset.token, await client.readContract({ address: asset.token, abi: erc20Abi, functionName: 'balanceOf', args: [kernel.address] }));
  check(await checkTradeMinimums(client, T.contracts.executor, quoted.steps, 'ordinary', block.number, 50n * U, new Set(selected.map(a => a.token))) === null, '$50/5% trade minimum passes the actual RPC reader');
  const receipt = await kernel.send([{ to: T.contracts.executor, data: encodeFunctionData({ abi: EXECUTOR_ABI, functionName: 'executeRebalance', args: [kernel.address, quoted.steps, quoted.deadline] }) }]);
  check(countSwapExecuted(receipt.logs, T.contracts.executor) === selected.length, '$50 swap produced an event for every component');
  for (const asset of selected) assert.ok(await client.readContract({ address: asset.token, abi: erc20Abi, functionName: 'balanceOf', args: [kernel.address] }) > (balances.get(asset.token) ?? 0n));
  check(true, 'every core and 5% satellite actual balance increased');
  console.log(`LAUNCH_168_FORK: ${passes} pass / 0 skip / 0 fail`);
}
main().catch(error => { console.error('[LAUNCH_168_FORK] failed: ' + (error instanceof Error ? error.name + ': ' + error.message.replace(/(?:https?|postgres(?:ql)?):\S+/g, '<endpoint>') : 'Error')); process.exitCode = 1; }).finally(closePool);
