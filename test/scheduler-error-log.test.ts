import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicClient, custom } from 'viem';
import { readCashWithdrawals, WITHDRAWAL_LOG_CHUNK } from '../src/cash-reconciliation.js';
import { errorChain, type SchedulerQueryFn } from '../src/scheduler.js';
import { TESTNET_97 } from '../src/testnet-profile.js';
import { TEST_ACCOUNT, TEST_OWNER } from './fixtures/strategy-rpc.js';

// tst 2026-11-21：入金幾小時後提領對帳一次查整段 eth_getLogs，超過 RPC 跨度上限，組合每輪都被擋，
// 而且真正的錯誤被 STRATEGY_UNAVAILABLE 蓋掉，log 看不到。

test('withdrawal logs are read 10,000 blocks at a time; a range the node refuses for its width is read again 5,000 at a time, covering every block once; any other failure still fails the read', async () => {
  const { WITHDRAWAL_LOG_NARROW, resetWithdrawalScanCache } = await import('../src/cash-reconciliation.js');
  const { CASH_SWAP_LOG_CHUNK } = await import('../src/strategy-cash-swaps.js');
  assert.equal(WITHDRAWAL_LOG_CHUNK, 10_000n); assert.equal(WITHDRAWAL_LOG_NARROW, 5_000n); assert.equal(CASH_SWAP_LOG_CHUNK, 5_000n);
  const node = (answer: (from: bigint, to: bigint) => void) => {
    const asked: [bigint, bigint][] = [], answered: [bigint, bigint][] = [];
    const client = createPublicClient({ transport: custom({ request: async ({ method, params }) => {
      if (method === 'eth_chainId') return '0x61';
      if (method === 'eth_getLogs') {
        const filter = (params as [{ fromBlock: string; toBlock: string }])[0];
        const range: [bigint, bigint] = [BigInt(filter.fromBlock), BigInt(filter.toBlock)];
        asked.push(range); answer(...range); answered.push(range);
        return [];
      }
      throw new Error(`unexpected ${method}`);
    } }, { retryCount: 0 }) });
    return { client, asked, answered };
  };
  const query: SchedulerQueryFn = async (sql) => ({ rows: sql.includes('smart_accounts') ? [{ owner: TEST_OWNER }] : [{ block_number: '100', log_index: '0' }] });
  const to = 100n + 2n * WITHDRAWAL_LOG_CHUNK + 5n;
  const read = (client: ReturnType<typeof node>['client']) => { resetWithdrawalScanCache(); return readCashWithdrawals(client, query, { chainId: 97, portfolioId: 1, account: TEST_ACCOUNT, cash: TESTNET_97.contracts.usdt, blockNumber: to }); };
  const byStart = (ranges: [bigint, bigint][]) => [...ranges].sort((x, y) => Number(x[0] - y[0]));

  // publicnode (takes 50,000 blocks): one request per 10,000 blocks, as before.
  const wide = node(() => {});
  assert.deepEqual(await read(wide.client), []);
  assert.deepEqual(wide.asked, [[100n, 100n + WITHDRAWAL_LOG_CHUNK - 1n], [100n + WITHDRAWAL_LOG_CHUNK, 100n + 2n * WITHDRAWAL_LOG_CHUNK - 1n], [100n + 2n * WITHDRAWAL_LOG_CHUNK, to]]);

  // bsc-prebsc-dataseed, where a log read lands when publicnode rate-limits (probed 2026-11-25; portfolio 4 ended
  // [CASH_RECONCILIATION_UNAVAILABLE] on exactly this answer): the refused ranges are read again in halves.
  const narrow = node((from, end) => { if (end - from > 5_000n) throw new Error('exceed maximum block range 5000'); });
  assert.deepEqual(await read(narrow.client), []);
  assert.deepEqual(byStart(narrow.answered), [[100n, 5_099n], [5_100n, 10_099n], [10_100n, 15_099n], [15_100n, 20_099n], [20_100n, to]], 'every block answered exactly once');
  assert.equal(narrow.asked.length, 2 + 5, 'two wide ranges refused once each; the 6-block tail was never too wide');

  // Anything else (rate limit on every node, a dead RPC) is not a width problem: no second attempt, the read fails closed.
  const dead = node(() => { throw new Error('fixture RPC unavailable'); });
  await assert.rejects(read(dead.client), /CASH_RECONCILIATION_UNAVAILABLE/);
  assert.ok(dead.asked.every(([from, end]) => end - from + 1n > WITHDRAWAL_LOG_NARROW || end === to), 'no narrow re-read');
  // A node that refuses even the narrow ranges fails the read too.
  const tiny = node((from, end) => { if (end - from > 1_000n) throw new Error('exceed maximum block range 1000'); });
  await assert.rejects(read(tiny.client), /CASH_RECONCILIATION_UNAVAILABLE/);
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
