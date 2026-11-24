import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicClient, custom } from 'viem';
import { readCashWithdrawals, WITHDRAWAL_LOG_CHUNK } from '../src/cash-reconciliation.js';
import { errorChain, type SchedulerQueryFn } from '../src/scheduler.js';
import { TESTNET_97 } from '../src/testnet-profile.js';
import { TEST_ACCOUNT, TEST_OWNER } from './fixtures/strategy-rpc.js';

// tst 2026-11-21：入金幾小時後提領對帳一次查整段 eth_getLogs，超過 RPC 跨度上限，組合每輪都被擋，
// 而且真正的錯誤被 STRATEGY_UNAVAILABLE 蓋掉，log 看不到。

test('withdrawal logs are read in chunks no wider than WITHDRAWAL_LOG_CHUNK, covering every block once', async () => {
  const ranges: [bigint, bigint][] = [];
  const client = createPublicClient({ transport: custom({ request: async ({ method, params }) => {
    if (method === 'eth_chainId') return '0x61';
    if (method === 'eth_getLogs') {
      const filter = (params as [{ fromBlock: string; toBlock: string }])[0];
      ranges.push([BigInt(filter.fromBlock), BigInt(filter.toBlock)]);
      return [];
    }
    throw new Error(`unexpected ${method}`);
  } }, { retryCount: 0 }) });
  const query: SchedulerQueryFn = async (sql) => ({ rows: sql.includes('smart_accounts') ? [{ owner: TEST_OWNER }] : [{ block_number: '100', log_index: '0' }] });
  const to = 100n + 2n * WITHDRAWAL_LOG_CHUNK + 5n;
  assert.deepEqual(await readCashWithdrawals(client, query, { chainId: 97, portfolioId: 1, account: TEST_ACCOUNT, cash: TESTNET_97.contracts.usdt, blockNumber: to }), []);
  assert.deepEqual(ranges, [
    [100n, 100n + WITHDRAWAL_LOG_CHUNK - 1n],
    [100n + WITHDRAWAL_LOG_CHUNK, 100n + 2n * WITHDRAWAL_LOG_CHUNK - 1n],
    [100n + 2n * WITHDRAWAL_LOG_CHUNK, to],
  ]);
});

test('the scheduler log line shows the real error and its cause, with URLs masked', () => {
  const rpc = new Error('HTTP request failed.\nURL: https://rpc.example/key-SECRET\nexceed maximum block range: 50000');
  const wrapped = new Error('[CASH_RECONCILIATION_UNAVAILABLE] 提領證據無法確認', { cause: rpc });
  const line = errorChain(wrapped);
  assert.match(line, /CASH_RECONCILIATION_UNAVAILABLE.* ← HTTP request failed\. \| URL: <url> \| exceed maximum block range: 50000$/);
  assert.ok(!line.includes('SECRET'));
  assert.equal(errorChain(new Error('see https://rpc.example/key-SECRET now')), 'see <url> now');
});

test('a masked send failure keeps its real cause for the log: public message stays generic, errorChain shows the chain with URLs masked', async () => {
  const { paymasterExecutionError } = await import('../src/paymaster.js');
  const { AppError } = await import('../src/errors.js');
  const original = new Error('UserOperation reverted during simulation with reason: AA23 reverted (details at https://rpc.example/v1/SECRET-KEY)');
  const masked = paymasterExecutionError(original);
  assert.equal(masked.code, 'PAYMASTER_SUBMISSION_UNAVAILABLE');
  assert.doesNotMatch(masked.message, /AA23|SECRET|UserOperation/, 'nothing of the original reaches the public message');
  const line = errorChain(masked);
  assert.match(line, /AA23 reverted/);
  assert.doesNotMatch(line, /SECRET-KEY|rpc\.example/);
  // A paymaster rejection keeps its own code, and still carries the original for the log.
  const rejected = paymasterExecutionError(new AppError(403, 'PAYMASTER_CALL_FORBIDDEN', 'my mix: pending mix change'));
  assert.equal(rejected.code, 'PAYMASTER_CALL_FORBIDDEN');
  assert.match(errorChain(rejected), /my mix: pending mix change/);
});
