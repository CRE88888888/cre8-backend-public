import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { closePool, migrate, query } from '../src/db.js';
import { detectPortfolioStuck, noteRoundOutcome, resetRoundOutcomes, waitingReason } from '../src/alerts.js';
import { readSchedulerStatus, restoreSavedRoundOutcomes, writeHeartbeat } from '../src/scheduler-status.js';

after(closePool);
const DB = process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('127.0.0.1:1/');
beforeEach(resetRoundOutcomes);
const heartbeat = { startedAt: new Date(), dryRun: false, limit: 20, thresholdBps: 100, intervalSeconds: 60, rounds: 1 };
const round = { claimed: 2, dryRun: false, results: [] };

test('heartbeat row: each portfolio outcome (reason + time) survives a restart; the operator view still gets counts only', { skip: !DB }, async () => {
  await migrate();
  await query('delete from scheduler_status');
  assert.equal(await restoreSavedRoundOutcomes(), 0, 'no row yet: nothing to restore, no error');
  const now = new Date();
  noteRoundOutcome(4, 'noop', 'Planner returned noop: [NO_DUE_SLOT] 沒有新投入或到期期次', now);
  noteRoundOutcome(13, 'blocked', '[STRATEGY_EXECUTION_UNAVAILABLE] 無法確認執行結果', now);
  await writeHeartbeat({ ...heartbeat, round });
  const status = await readSchedulerStatus();
  assert.deepEqual(status?.lastSummary, { claimed: 2, executed: 0, noop: 0, blocked: 0, failed: 0, readyDryRun: 0 });
  // The process dies; the next one starts with an empty map.
  resetRoundOutcomes();
  const stuck = async () => (await detectPortfolioStuck(async () => ({ rows: [4, 13].map(id => ({ portfolio_id: id, hours_since: 30, gross_drift_bps: 8755 })) }), 6, new Date())).map(f => f.severity);
  assert.deepEqual(await stuck(), ['critical', 'critical']);
  assert.equal(await restoreSavedRoundOutcomes(), 2);
  assert.deepEqual(await stuck(), ['warn', 'critical']);
  assert.equal(waitingReason(4, new Date()), '[NO_DUE_SLOT] 沒有新投入或到期期次');
  // A round that threw writes no summary: the saved outcomes stay as they were.
  resetRoundOutcomes();
  await writeHeartbeat({ ...heartbeat, round: null, error: 'boom' });
  assert.equal(await restoreSavedRoundOutcomes(), 2);
  // The next finished round replaces them with the current map.
  resetRoundOutcomes(); noteRoundOutcome(5, 'noop', '[MARKET_CLOSED] 股票休市', new Date());
  await writeHeartbeat({ ...heartbeat, round, rounds: 2 });
  resetRoundOutcomes();
  assert.equal(await restoreSavedRoundOutcomes(), 1);
  assert.equal(waitingReason(5, new Date()), '[MARKET_CLOSED] 股票休市'); assert.equal(waitingReason(4, new Date()), null);
});
