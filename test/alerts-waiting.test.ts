import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { detectPortfolioFailures, detectPortfolioStuck, noteRoundOutcome, resetRoundOutcomes, restoreRoundOutcomes, roundOutcomeSnapshot, ROUND_OUTCOME_TTL_MS, waitingReason } from '../src/alerts.js';

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

test('drift alert: the outcomes saved by one process keep their reason and time in the next one (a deploy no longer turns waiting portfolios critical)', async () => {
  noteRoundOutcome(4, 'noop', 'Planner returned noop: [NO_DUE_SLOT] 沒有新投入或到期期次', NOW);
  noteRoundOutcome(13, 'blocked', '[STRATEGY_EXECUTION_UNAVAILABLE] 無法確認執行結果', NOW);
  noteRoundOutcome(20, 'noop', '[MARKET_CLOSED] 股票休市', new Date(NOW.getTime() - ROUND_OUTCOME_TTL_MS - 1)); // already too old to matter
  const saved = JSON.parse(JSON.stringify(roundOutcomeSnapshot(NOW))) as unknown; // what the heartbeat row holds (jsonb)
  assert.deepEqual(saved, {
    4: { outcome: 'noop', reason: 'Planner returned noop: [NO_DUE_SLOT] 沒有新投入或到期期次', at: NOW.toISOString() },
    13: { outcome: 'blocked', reason: '[STRATEGY_EXECUTION_UNAVAILABLE] 無法確認執行結果', at: NOW.toISOString() },
  });
  resetRoundOutcomes(); // the restart
  const strict = async (at: Date) => (await detectPortfolioStuck(stuckRows([4, 13].map(id => ({ portfolio_id: id, hours_since: 25.7, gross_drift_bps: 8755 }))), 6, at)).map(f => f.severity);
  assert.deepEqual(await strict(NOW), ['critical', 'critical'], 'what every deploy did before');
  const started = new Date(NOW.getTime() + 90_000);
  assert.equal(restoreRoundOutcomes(saved, started), 2);
  assert.deepEqual(await strict(started), ['warn', 'critical'], 'the waiting one stays a warn; the one that needs someone stays critical');
  assert.equal(waitingReason(4, started), '[NO_DUE_SLOT] 沒有新投入或到期期次');
  // The saved time is the round's time, not the restart's: the reason still expires two hours after that round.
  assert.equal(waitingReason(4, new Date(NOW.getTime() + ROUND_OUTCOME_TTL_MS)), '[NO_DUE_SLOT] 沒有新投入或到期期次');
  assert.equal(waitingReason(4, new Date(NOW.getTime() + ROUND_OUTCOME_TTL_MS + 1)), null);
  // A round of the new process wins over what was saved, and a later restore never overwrites it.
  noteRoundOutcome(4, 'failed', 'send failed', started);
  assert.equal(restoreRoundOutcomes(saved, started), 0);
  assert.equal(waitingReason(4, started), null);
});

test('drift alert: restoring ignores stale, future-dated and malformed entries, and saved reasons never carry a URL', () => {
  const at = NOW.toISOString();
  const old = new Date(NOW.getTime() - ROUND_OUTCOME_TTL_MS - 1).toISOString(), future = new Date(NOW.getTime() + 1).toISOString();
  assert.equal(restoreRoundOutcomes({ 1: { outcome: 'noop', reason: '[MARKET_CLOSED] a', at: old }, 2: { outcome: 'noop', reason: '[MARKET_CLOSED] b', at: future },
    3: { outcome: 'noop', reason: 7, at }, 4: null, x: { outcome: 'noop', reason: '[MARKET_CLOSED] c', at }, '-5': { outcome: 'noop', reason: '[MARKET_CLOSED] d', at },
    6: { outcome: 'noop', reason: '[MARKET_CLOSED] e', at: 'yesterday' }, 7: { outcome: 'noop', reason: '[MARKET_CLOSED] ok', at } }, NOW), 1);
  assert.equal(waitingReason(7, NOW), '[MARKET_CLOSED] ok');
  for (const id of [1, 2, 3, 4, 5, 6]) assert.equal(waitingReason(id, NOW), null);
  for (const nothing of [null, undefined, 'text', 7, [], [{ outcome: 'noop', reason: '[MARKET_CLOSED]', at }]]) assert.equal(restoreRoundOutcomes(nothing, NOW), 0);
  resetRoundOutcomes();
  noteRoundOutcome(9, 'blocked', `quote failed: https://rpc.invalid/v1/secret-key-value and postgres://user:pw@db.invalid/x ${'x'.repeat(600)}`, NOW);
  const saved = roundOutcomeSnapshot(NOW)[9];
  assert.ok(saved); assert.ok(!/secret-key-value|user:pw|rpc\.invalid|db\.invalid/.test(saved.reason)); assert.ok(saved.reason.length <= 301);
  assert.deepEqual(roundOutcomeSnapshot(new Date(NOW.getTime() + ROUND_OUTCOME_TTL_MS + 1)), {});
});
