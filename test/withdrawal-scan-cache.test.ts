import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createPublicClient, custom } from 'viem';
import { readCashWithdrawals, resetWithdrawalScanCache, WITHDRAWAL_LOG_CHUNK, WITHDRAWAL_LOG_CONCURRENCY, WITHDRAWAL_REORG_MARGIN } from '../src/cash-reconciliation.js';
import type { SchedulerQueryFn } from '../src/scheduler.js';
import { TESTNET_97 } from '../src/testnet-profile.js';
import { strategyRpc, TEST_ACCOUNT, TEST_OWNER, TEST_AMOUNT, OTHER_HASH } from './fixtures/strategy-rpc.js';

/**
 * Scheduler rounds took 30–57 s per portfolio: every round re-read owner withdrawals with sequential 10k-block
 * eth_getLogs from the first funding lot to head, even while the market was closed. Stable ranges (64 blocks
 * behind head) are now scanned once per process, chunks run concurrently, and cached withdrawals are still
 * re-verified (receipt + block hash) every round.
 */
// The cache is process-wide and bun runs every test file in one process: never leak entries to other files.
afterEach(() => resetWithdrawalScanCache());

function fixture() {
  resetWithdrawalScanCache();
  const rpc = strategyRpc({ assets: [] }, OTHER_HASH, new Date('2026-11-15T00:00:00Z'));
  Object.assign(rpc.state, { mint: true, transferFrom: TEST_ACCOUNT, to: TEST_OWNER, logIndex: 1 });
  const ranges: [bigint, bigint][] = [];
  let inFlight = 0, peak = 0;
  const client = createPublicClient({ transport: custom({ request: async ({ method, params }) => {
    if (method === 'eth_getLogs') {
      const filter = (params as [{ fromBlock: string; toBlock: string }])[0];
      const range: [bigint, bigint] = [BigInt(filter.fromBlock), BigInt(filter.toBlock)];
      ranges.push(range);
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      const logs = (await rpc.client.request({ method: 'eth_getTransactionReceipt', params: [OTHER_HASH] }))?.logs ?? [];
      return logs.filter((log) => BigInt(log.blockNumber ?? -1n) >= range[0] && BigInt(log.blockNumber ?? -1n) <= range[1]);
    }
    return rpc.client.transport.request({ method, params });
  } }, { retryCount: 0 }) });
  const query: SchedulerQueryFn = async (sql) => ({ rows: sql.includes('smart_accounts') ? [{ owner: TEST_OWNER }] : [{ block_number: '130', log_index: '0' }] });
  return { rpc, client, query, ranges, peak: () => peak, args: (blockNumber: bigint) => ({ chainId: 97, portfolioId: 1, account: TEST_ACCOUNT, cash: TESTNET_97.contracts.usdt, blockNumber }) };
}

test('the next round only scans past the stable height; the known withdrawal is still returned and re-verified', async () => {
  const f = fixture();
  const head = 130n + 5n * WITHDRAWAL_LOG_CHUNK;
  assert.equal((await readCashWithdrawals(f.client, f.query, f.args(head)))[0]?.amount, TEST_AMOUNT);
  assert.equal(f.ranges[0]?.[0], 130n);
  assert.ok(f.peak() > 1 && f.peak() <= WITHDRAWAL_LOG_CONCURRENCY, `concurrent chunks (peak ${f.peak()})`);
  f.ranges.length = 0;
  const next = head + 100n;
  const second = await readCashWithdrawals(f.client, f.query, f.args(next));
  assert.equal(second.length, 1, 'cached withdrawal is still counted');
  assert.deepEqual(f.ranges, [[head - WITHDRAWAL_REORG_MARGIN + 1n, next]], 'only the unstable tail and new blocks are scanned');
});

test('a cached withdrawal that no longer verifies fails closed and forces a full rescan next round', async () => {
  const f = fixture();
  const head = 130n + 2n * WITHDRAWAL_LOG_CHUNK;
  await readCashWithdrawals(f.client, f.query, f.args(head));
  const original = f.rpc.state.blockHash;
  f.rpc.state.blockHash = OTHER_HASH;
  await assert.rejects(readCashWithdrawals(f.client, f.query, f.args(head + 10n)), /CASH_RECONCILIATION_UNAVAILABLE/);
  f.rpc.state.blockHash = original;
  f.ranges.length = 0;
  assert.equal((await readCashWithdrawals(f.client, f.query, f.args(head + 20n))).length, 1);
  assert.equal(f.ranges.map((r) => r[0]).sort((a, b) => (a < b ? -1 : 1))[0], 130n, 'rescanned from the first funding block');
});

test('an older observation block reuses the cache without scanning and never caches past its own block', async () => {
  const f = fixture();
  const head = 130n + 3n * WITHDRAWAL_LOG_CHUNK;
  await readCashWithdrawals(f.client, f.query, f.args(head));
  f.ranges.length = 0;
  assert.equal((await readCashWithdrawals(f.client, f.query, f.args(head - 1000n))).length, 1);
  assert.deepEqual(f.ranges, []);
  assert.deepEqual(await readCashWithdrawals(f.client, f.query, f.args(head + 1n)).then((r) => r.length), 1);
  assert.deepEqual(f.ranges, [[head - WITHDRAWAL_REORG_MARGIN + 1n, head + 1n]], 'the newer cache entry survived the older read');
});
