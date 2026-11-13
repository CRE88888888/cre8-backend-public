// Explicit integration command only; requires DeployAtpMainnet on the isolated X1 #35 fork.
// bun test ./test/a10-pause-operator.fork.ts --timeout=120000
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';
import { parseAbi } from 'viem';
import type { Address } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { enrollOnchain, getChain, REGISTRY_ABI } from '../src/chain.js';
import { closePool, query } from '../src/db.js';
import { createPortfolioStatusReader } from '../src/operator.js';
import { enrollPortfolio } from '../src/portfolios.js';
import { createStrategy, publishVersion } from '../src/strategies.js';

const exec = promisify(execFile);
const rpcUrl = 'http://127.0.0.1:8566';
const mnemonic = 'test test test test test test test test test test test junk';
const owner = mnemonicToAccount(mnemonic, { addressIndex: 6 });
const otherOwner = mnemonicToAccount(mnemonic, { addressIndex: 7 });
const operator = mnemonicToAccount(mnemonic, { addressIndex: 4 });
const usdt: Address = '0x55d398326f99059fF775485246999027B3197955';
const controls = parseAbi(['function setPaused(address account, bool paused)', 'function setGlobalPaused(bool paused)']);
let strategyId: number;
let onchainId: number;
let otherStrategyId: number;
let portfolioId: number;
let account: Address;
let safe: Address;
let executor: Address;

async function localRpc(method: string, params: readonly unknown[]): Promise<void> {
  const response = await fetch(rpcUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const result: unknown = await response.json();
  assert.ok(typeof result === 'object' && result !== null && !('error' in result), 'local anvil RPC failed');
}

async function setPause(sender: Address, paused: boolean, global = false): Promise<void> {
  const chain = getChain();
  await localRpc('anvil_impersonateAccount', [sender]);
  await localRpc('anvil_setBalance', [sender, '0x16345785D8A0000']);
  try {
    const hash = global
      ? await chain.wallet.writeContract({ address: executor, abi: controls, functionName: 'setGlobalPaused', args: [paused], account: sender, chain: null })
      : await chain.wallet.writeContract({ address: chain.registryAddress, abi: controls, functionName: 'setPaused', args: [account, paused], account: sender, chain: null });
    assert.equal((await chain.publicClient.waitForTransactionReceipt({ hash })).status, 'success');
  } finally {
    await localRpc('anvil_stopImpersonatingAccount', [sender]);
  }
}

async function flags(): Promise<number> {
  const chain = getChain();
  return chain.publicClient.readContract({ address: chain.registryAddress, abi: REGISTRY_ABI, functionName: 'pauseFlags', args: [account] });
}

async function scheduler(): Promise<string> {
  await query('update portfolios set next_run_at = null where strategy_id = $1', [strategyId]);
  const result = await exec(process.execPath, ['scripts/scheduler.ts', '--once', '--live']);
  return result.stdout;
}

before(async () => {
  assert.equal(process.env.RPC_URL, rpcUrl, 'this suite only accepts the isolated local fork');
  assert.equal((await query<{ name: string }>('select current_database() as name')).rows[0]?.name, 'cre8_x1c');
  await localRpc('anvil_nodeInfo', []); // A public BSC endpoint cannot satisfy this check.
  const chain = getChain();
  assert.equal(chain.account.address.toLowerCase(), operator.address.toLowerCase(), 'only the public anvil operator key is allowed');
  assert.equal(await chain.publicClient.getChainId(), 56);
  const ownership = parseAbi(['function owner() view returns (address)']);
  safe = await chain.publicClient.readContract({ address: chain.registryAddress, abi: ownership, functionName: 'owner' });
  assert.ok(process.env.EXECUTOR_ADDRESS);
  executor = process.env.EXECUTOR_ADDRESS as Address;
  const strategy = await createStrategy({ name: `A10 #35 ${Date.now()}` }, owner.address);
  strategyId = strategy.id;
  assert.ok(strategy.onchainId !== null);
  onchainId = strategy.onchainId;
  await publishVersion(strategyId, {
    allocation: { assets: [{ address: usdt, symbol: 'USDT', weightBps: 10000 }] },
    schedule: { kind: 'interval', intervalSeconds: 60 },
  }, owner.address);
  const first = await enrollPortfolio(strategyId, owner.address);
  portfolioId = first.id;
  assert.ok(first.smartAccounts[0]);
  account = first.smartAccounts[0].address as Address;
  await enrollPortfolio(strategyId, otherOwner.address);
  otherStrategyId = (await createStrategy({ name: `A10 conflict ${Date.now()}` }, owner.address)).onchainId ?? 0;
  await publishVersion(strategyId, {
    allocation: { assets: [{ address: usdt, symbol: 'USDT', weightBps: 10000 }] },
    schedule: { kind: 'interval', intervalSeconds: 60 },
  }, owner.address);
});

test('operator retries preserve v1 after v2 publication and reject a different strategy without a transaction', async () => {
  const chain = getChain();
  const nonce = await chain.publicClient.getTransactionCount({ address: operator.address });
  assert.equal(await enrollOnchain(account, onchainId), 1);
  await assert.rejects(() => enrollOnchain(account, otherStrategyId), /AlreadyEnrolled/);
  assert.equal(await chain.publicClient.getTransactionCount({ address: operator.address }), nonce);
});

test('Safe/account pauses survive backend enroll retries; status exposes all three sources', async () => {
  await setPause(safe, true);
  assert.equal(await enrollOnchain(account, onchainId), 1);
  assert.equal(await flags(), 1);
  await setPause(operator.address, true);
  await setPause(account, true);
  const status = await createPortfolioStatusReader()(portfolioId, owner.address);
  assert.equal(status.pauseFlags, 7);
  assert.deepEqual(status.pauseSources, ['safe', 'operator', 'account']);
  await setPause(operator.address, false);
  assert.equal(await flags(), 5, 'operator may only clear its own bit');
  assert.equal(await enrollOnchain(account, onchainId), 1);
  assert.equal(await flags(), 5);
  await setPause(account, false);
  assert.equal(await flags(), 0);
});

test('Safe global pause makes the real --once --live CLI block every claimed account, with no transaction', async () => {
  await setPause(safe, true, true);
  const chain = getChain();
  const nonce = await chain.publicClient.getTransactionCount({ address: operator.address });
  const operations = (await query<{ count: number }>('select count(*)::int as count from operations')).rows[0]?.count;
  const log = await scheduler();
  assert.match(log, /blocked（被擋下，沒送交易）：2/);
  assert.ok(!log.includes('→ executed'));
  assert.equal(await chain.publicClient.getTransactionCount({ address: operator.address }), nonce);
  assert.equal((await query<{ count: number }>('select count(*)::int as count from operations')).rows[0]?.count, operations);
  const alerts = await query<{ severity: string; occurrences: number }>("select severity, occurrences from scheduler_alerts where kind = 'executor_paused' and portfolio_id is null and resolved_at is null");
  assert.equal(alerts.rows.length, 1);
  assert.equal(alerts.rows[0]?.severity, 'critical');
  await scheduler();
  assert.equal((await query<{ occurrences: number }>("select occurrences from scheduler_alerts where kind = 'executor_paused' and resolved_at is null")).rows[0]?.occurrences, 2);
});

test('strict preflight fails specifically on the paused executor', async () => {
  try {
    await exec(process.execPath, ['scripts/preflight.ts', '--strict']);
    assert.fail('strict preflight must reject global pause');
  } catch (error) {
    assert.ok(typeof error === 'object' && error !== null && 'stdout' in error);
    assert.match(String(error.stdout), /✗ executor\.globalPaused/);
  }
});

test('Safe resume restores normal planning, resolves the alert and synchronizes only the chain version', async () => {
  await setPause(safe, false, true);
  // Deliberately stale DB mirror; the chain still pins v1 and only the user can change it.
  await query('update portfolios set version = 2 where strategy_id = $1', [strategyId]);
  const log = await scheduler();
  assert.match(log, /noop（不需要動）：2/); // Empty USDT-only accounts have no trades to perform.
  assert.equal((await query("select 1 from scheduler_alerts where kind = 'executor_paused' and resolved_at is null")).rows.length, 0);
  const versions = await query<{ version: number }>('select version from portfolios where strategy_id = $1', [strategyId]);
  assert.ok(versions.rows.every((row) => row.version === 1));
});

after(async () => {
  if (safe !== undefined && executor !== undefined) await setPause(safe, false, true);
  if (strategyId !== undefined) {
    await query('update portfolios set schedule_state = $1 where strategy_id = $2', ['idle', strategyId]);
    await query('delete from scheduler_alerts where portfolio_id in (select id from portfolios where strategy_id = $1)', [strategyId]);
  }
  await closePool();
});
