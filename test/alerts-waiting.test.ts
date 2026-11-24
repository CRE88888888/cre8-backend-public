import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { detectPortfolioFailures, detectPortfolioStuck, noteRoundOutcome, resetRoundOutcomes, ROUND_OUTCOME_TTL_MS, waitingReason } from '../src/alerts.js';

const NOW = new Date('2026-11-24T13:30:00Z');
const stuckRows = (rows: { portfolio_id: number; hours_since: number; gross_drift_bps: number }[]) => async () => ({ rows });
beforeEach(resetRoundOutcomes);

test('drift alert: a portfolio the scheduler just looked at and is waiting on (market closed, minimum trade, budget) is a warn with the reason, at any age', async () => {
  noteRoundOutcome(7, 'noop', 'Planner returned noop: [MARKET_CLOSED] 股票部分等待下一個開盤時段', NOW);
  noteRoundOutcome(8, 'noop', '偏離低於最小交易額，本次再平衡檢查完成。', NOW);
  noteRoundOutcome(9, 'blocked', '[GAS_BUDGET_EXCEEDED] daily budget used', NOW);
  noteRoundOutcome(13, 'noop', 'Planner returned noop: 繼續原工作，後續期次不補扣', NOW); // a job that is not moving: not a known harmless wait
  noteRoundOutcome(14, 'blocked', '[STRATEGY_EXECUTION_UNAVAILABLE] 無法確認執行結果', NOW);
  noteRoundOutcome(15, 'failed', '[MARKET_CLOSED] but the round itself failed', NOW);
  const found = await detectPortfolioStuck(stuckRows([7, 8, 9, 13, 14, 15, 16].map(id => ({ portfolio_id: id, hours_since: 72, gross_drift_bps: 2584 }))), 6, NOW);
  assert.deepEqual(found.map(f => [f.portfolioId, f.severity]), [[7, 'warn'], [8, 'warn'], [9, 'warn'], [13, 'critical'], [14, 'critical'], [15, 'critical'], [16, 'critical']]);
  assert.equal(found[0]!.detail, 'portfolio 7: last observation showed 2584 bps drift (still above the threshold) 72.0 hours ago, with no successful execution since — waiting, nothing to fix: [MARKET_CLOSED] 股票部分等待下一個開盤時段');
  assert.match(found[3]!.detail, /or the scheduler is not running$/); // unchanged wording for the ones that need someone
  // Under 24h everything is a warn as before; the waiting ones still say why.
  const young = await detectPortfolioStuck(stuckRows([{ portfolio_id: 7, hours_since: 8, gross_drift_bps: 300 }, { portfolio_id: 13, hours_since: 8, gross_drift_bps: 300 }]), 6, NOW);
  assert.deepEqual(young.map(f => f.severity), ['warn', 'warn']);
});

test('drift alert: the waiting reason only counts while it is fresh — an old round or a restart falls back to the strict rule', async () => {
  noteRoundOutcome(7, 'noop', '[MARKET_CLOSED] 股票休市', NOW);
  assert.equal(waitingReason(7, new Date(NOW.getTime() + ROUND_OUTCOME_TTL_MS)), '[MARKET_CLOSED] 股票休市');
  const later = new Date(NOW.getTime() + ROUND_OUTCOME_TTL_MS + 1);
  assert.equal(waitingReason(7, later), null);
  assert.equal((await detectPortfolioStuck(stuckRows([{ portfolio_id: 7, hours_since: 30, gross_drift_bps: 300 }]), 6, later))[0]!.severity, 'critical');
  resetRoundOutcomes(); // what a scheduler restart does
  assert.equal((await detectPortfolioStuck(stuckRows([{ portfolio_id: 7, hours_since: 30, gross_drift_bps: 300 }]), 6, NOW))[0]!.severity, 'critical');
  // A later round that is no longer waiting replaces the reason.
  noteRoundOutcome(7, 'noop', '[MARKET_CLOSED] 股票休市', NOW); noteRoundOutcome(7, 'blocked', '[STRATEGY_EXECUTION_UNAVAILABLE] x', NOW);
  assert.equal(waitingReason(7, NOW), null);
});

test('failing-tail alert: real failures stay critical; the query gets the clean-rounds window', async () => {
  const seen: unknown[][] = [];
  const query = async (_sql: string, params: readonly unknown[] = []) => { seen.push([...params]);
    return { rows: [{ portfolio_id: 13, failed_count: 3, last_state: 'failed', last_error: '[STRATEGY_EXECUTION_UNAVAILABLE] 無法確認執行結果，保留原身分待對帳' }] }; };
  const [f] = await detectPortfolioFailures(query, 3);
  assert.deepEqual([f!.severity, f!.kind, seen[0]], ['critical', 'portfolio_repeatedly_failing', [3, 6]]);
  await detectPortfolioFailures(query, 3, 12);
  assert.deepEqual(seen[1], [3, 12]);
});
