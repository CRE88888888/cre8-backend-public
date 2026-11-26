import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { detectPortfolioFailures, detectPortfolioStuck, noteRoundOutcome, resetRoundOutcomes, restoreRoundOutcomes, roundOutcomeSnapshot, ROUND_OUTCOME_TTL_MS, scheduledRebalanceAhead, waitingReason } from '../src/alerts.js';

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
  noteRoundOutcome(17, 'noop', '下一次再平衡為 2026-11-24T00:00:00.000Z。', NOW); // a private basket whose rebalance date has passed: it should have rebalanced
  noteRoundOutcome(18, 'noop', 'Planner returned noop: [BELOW_MIN_BATCH] 待買入 8.62 USDT（1 個來源）湊不成每筆10 USDT的完整批次，已取消並留作可用現金', NOW);
  noteRoundOutcome(19, 'noop', '目前無法確認組合價值，停利停損暫不觸發。', NOW); // a basket that cannot be valued still needs someone
  const found = await detectPortfolioStuck(stuckRows([7, 8, 9, 13, 14, 15, 16, 17, 18, 19].map(id => ({ portfolio_id: id, hours_since: 72, gross_drift_bps: 2584 }))), 6, NOW);
  assert.deepEqual(found.map(f => [f.portfolioId, f.severity]), [[7, 'warn'], [8, 'warn'], [9, 'warn'], [13, 'critical'], [14, 'critical'], [15, 'critical'], [16, 'critical'], [17, 'warn'], [18, 'warn'], [19, 'critical']]);
  assert.match(found[7]!.detail, /waiting, nothing to fix: 下一次再平衡為 2026-11-24T00:00:00\.000Z。$/);
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

test('drift alert: scheduled principal that is not due yet is left out (portfolio 4: 8 weekly periods, 8755 bps until the last one was bought)', async () => {
  const { pendingScheduleDrift, unbuyableIdleCash } = await import('../src/alerts.js');
  const E8 = 10n ** 8n, E18 = 10n ** 18n;
  // 800 USDT portfolio, first of 8 periods bought: 700 waits as cash for the 7 periods to come.
  assert.deepEqual(pendingScheduleDrift(8755, (800n * E8).toString(), (700n * E18).toString()), { driftBps: 40, pendingBps: 8750 });
  // One period overdue and unbought (600 still not due): (8755 − 7500) / (1 − 0.75).
  assert.deepEqual(pendingScheduleDrift(8755, (800n * E8).toString(), (600n * E18).toString()), { driftBps: 5020, pendingBps: 7500 });
  // Nothing pending, or a row without the numbers (older stubs): the alert is left exactly as it was.
  for (const [total, pending] of [[(800n * E8).toString(), '0'], [(800n * E8).toString(), undefined], [undefined, (700n * E18).toString()], ['0', '1'], ['x', 'y'], [(800n * E8).toString(), '9999999999']] as const)
    assert.equal(pendingScheduleDrift(8755, total, pending), null, `${String(total)}/${String(pending)}`);
  // More pending than the snapshot's total, or more than the observed drift: nothing left to report, never negative.
  assert.deepEqual(pendingScheduleDrift(8755, (800n * E8).toString(), (900n * E18).toString()), { driftBps: 0, pendingBps: 10_000 });
  assert.deepEqual(pendingScheduleDrift(300, (800n * E8).toString(), (700n * E18).toString()), { driftBps: 0, pendingBps: 8750 });

  // Idle cash under the minimum batch (10 USDT, fee included) cannot be bought: it is taken out too, on top of any
  // scheduled principal; 10 USDT or more is a batch and stays; a row without the cash number changes nothing.
  assert.deepEqual(unbuyableIdleCash((862n * E18 / 100n).toString(), '0'), { excludedRaw: (862n * E18 / 100n).toString(), scheduled: false });
  assert.deepEqual(unbuyableIdleCash((705n * E18).toString(), (700n * E18).toString()), { excludedRaw: (705n * E18).toString(), scheduled: true });
  for (const [cashRaw, pendingRaw] of [[(10n * E18).toString(), '0'], [(712n * E18).toString(), (700n * E18).toString()], [(700n * E18).toString(), (700n * E18).toString()], ['0', '0'], [undefined, '0'], ['x', '0'], [null, undefined]] as const)
    assert.equal(unbuyableIdleCash(cashRaw, pendingRaw), null, `${String(cashRaw)}/${String(pendingRaw)}`);
  const idleRows = [
    { portfolio_id: 7, hours_since: 30, gross_drift_bps: 2584, threshold_bps: 100, total_usd_e8: (3336n * E8 / 100n).toString(), pending_raw: '0', cash_raw: (862n * E18 / 100n).toString() }, // testnet portfolio 7
    { portfolio_id: 8, hours_since: 30, gross_drift_bps: 3266, threshold_bps: 100, total_usd_e8: (3674n * E8 / 100n).toString(), pending_raw: '0', cash_raw: (12n * E18).toString() },          // 12 USDT can be bought
    { portfolio_id: 9, hours_since: 30, gross_drift_bps: 4000, threshold_bps: 100, total_usd_e8: (3336n * E8 / 100n).toString(), pending_raw: '0', cash_raw: (862n * E18 / 100n).toString() }, // un-buyable cash + real drift
    { portfolio_id: 10, hours_since: 30, gross_drift_bps: 8800, threshold_bps: 100, total_usd_e8: (800n * E8).toString(), pending_raw: (700n * E18).toString(), cash_raw: (705n * E18).toString() }, // schedule + 5 USDT of dust
  ];
  const idle = await detectPortfolioStuck(async () => ({ rows: idleRows }), 6, NOW);
  assert.deepEqual(idle.map(f => f.portfolioId), [8, 9], 'portfolio 7 (and the scheduled one with dust) no longer alert');
  assert.match(String(idle[0]!.detail), /^portfolio 8: last observation showed 3266 bps drift \(still above the threshold\)/);
  assert.match(String(idle[1]!.detail), /^portfolio 9: last observation showed 1910 bps drift \(4000 bps observed; 2583 bps of the portfolio is idle cash under the minimum batch, which cannot be bought, and is left out\)/);

  const seen: unknown[][] = [];
  const rows = [
    { portfolio_id: 4, hours_since: 25.7, gross_drift_bps: 8755, threshold_bps: 100, total_usd_e8: (800n * E8).toString(), pending_raw: (700n * E18).toString() }, // waiting for its periods
    { portfolio_id: 5, hours_since: 25.7, gross_drift_bps: 8755, threshold_bps: 100, total_usd_e8: (800n * E8).toString(), pending_raw: (600n * E18).toString() }, // one period overdue
    { portfolio_id: 6, hours_since: 25.7, gross_drift_bps: 8755, threshold_bps: 100, total_usd_e8: (800n * E8).toString(), pending_raw: '0' },                     // no schedule: real drift
    { portfolio_id: 7, hours_since: 25.7, gross_drift_bps: 8755 },                                                                                                  // a row without the new columns
  ];
  const found = await detectPortfolioStuck(async (_sql: string, params: readonly unknown[] = []) => { seen.push([...params]); return { rows }; }, 6, NOW);
  assert.deepEqual(seen, [[6, NOW.toISOString()]], 'the query gets the alert window and the evaluation time');
  assert.deepEqual(found.map(f => f.portfolioId), [5, 6, 7], 'portfolio 4 no longer alerts');
  assert.match(String(found[0]!.detail), /^portfolio 5: last observation showed 5020 bps drift \(8755 bps observed; 7500 bps of the portfolio is scheduled principal not due yet and is left out\) \(still above the threshold\) 25\.7 hours ago/);
  for (const f of found.slice(1)) assert.match(String(f.detail), /last observation showed 8755 bps drift \(still above the threshold\) 25\.7 hours ago/);
  assert.deepEqual(found.map(f => f.severity), ['critical', 'critical', 'critical']);
});

test('drift alert: a basket waiting for its own scheduled rebalance date reports nothing while the date is ahead; a passed date, a stale round or a failing one reports as before', async () => {
  // Testnet portfolio 7: 1882 bps between its assets, next rebalance 2026-12-21. The weights are meant to drift until then.
  const drift = (id: number, hours = 72) => ({ portfolio_id: id, hours_since: hours, gross_drift_bps: 1882 });
  noteRoundOutcome(7, 'noop', '下一次再平衡為 2026-12-21T00:00:00.000Z。', NOW);
  noteRoundOutcome(8, 'noop', '下一次再平衡為 2026-11-24T13:29:59.000Z。', NOW); // due a second ago and still drifting: reported
  noteRoundOutcome(9, 'failed', '下一次再平衡為 2026-12-21T00:00:00.000Z。', NOW); // the round failed: reported, critical
  noteRoundOutcome(10, 'noop', '下一次再平衡為 2026-12-21T00:00:00.000Z。；[STRATEGY_EARN_UNWINDING] something else is going on', NOW); // not exactly that wait
  noteRoundOutcome(11, 'noop', '下一次再平衡為 not-a-date。', NOW);
  assert.equal(scheduledRebalanceAhead(7, NOW)?.toISOString(), '2026-12-21T00:00:00.000Z');
  assert.deepEqual([8, 9, 10, 11, 12].map(id => scheduledRebalanceAhead(id, NOW)), [null, null, null, null, null]);
  const found = await detectPortfolioStuck(stuckRows([7, 8, 9, 10, 11, 12].map(id => drift(id))), 6, NOW);
  assert.deepEqual(found.map(f => [f.portfolioId, f.severity]), [[8, 'warn'], [9, 'critical'], [10, 'warn'], [11, 'warn'], [12, 'critical']]);
  // The same basket once the scheduler has not said so for longer than the TTL (it stopped running, or a restart lost it):
  // the strict rule again — nothing is hidden on an old word.
  const later = new Date(NOW.getTime() + ROUND_OUTCOME_TTL_MS + 1);
  assert.equal(scheduledRebalanceAhead(7, later), null);
  assert.deepEqual((await detectPortfolioStuck(stuckRows([drift(7)]), 6, later)).map(f => [f.portfolioId, f.severity]), [[7, 'critical']]);
  // And once its date has come while the last word is still fresh: reported (a warn that says what it was waiting for).
  const due = new Date('2026-12-21T00:00:01Z');
  noteRoundOutcome(7, 'noop', '下一次再平衡為 2026-12-21T00:00:00.000Z。', new Date(due.getTime() - 60_000));
  assert.deepEqual((await detectPortfolioStuck(stuckRows([drift(7)]), 6, due)).map(f => [f.portfolioId, f.severity]), [[7, 'warn']]);
});

test('a round that never looked at the portfolio (lane busy, lock busy, pause flag unreadable) keeps the last real word, across a restart too; a failed round, a passed date or two hours without a real look report as before', async () => {
  const drift = (id: number, hours = 102.1) => ({ portfolio_id: id, hours_since: hours, gross_drift_bps: 1882 });
  const severities = async (ids: number[], at: Date) => (await detectPortfolioStuck(stuckRows(ids.map(id => drift(id))), 6, at)).map(f => [f.portfolioId, f.severity]);
  const DEX = '[DEX_QUEUED] 共用市場正處理另一基金，稍後重報價';
  // The previous process: portfolio 7 waits for 2026-12-21, 8's date has passed, 9's last round failed. Then a deploy.
  noteRoundOutcome(7, 'noop', '下一次再平衡為 2026-12-21T00:00:00.000Z。', NOW);
  noteRoundOutcome(8, 'noop', '下一次再平衡為 2026-11-24T13:29:59.000Z。', NOW);
  noteRoundOutcome(9, 'failed', 'send failed', NOW);
  const saved = JSON.parse(JSON.stringify(roundOutcomeSnapshot(NOW))) as unknown;
  resetRoundOutcomes();
  const started = new Date(NOW.getTime() + 60_000);
  assert.equal(restoreRoundOutcomes(saved, started), 3);
  assert.deepEqual(await severities([7, 8, 9, 10], started), [[8, 'warn'], [9, 'critical'], [10, 'critical']]);
  // The first rounds of the new process find the lane taken (2026-11-25 19:05 UTC): nothing was looked at.
  const queued = new Date(started.getTime() + 4 * 60_000);
  for (const reason of [DEX, '[DEX_QUEUED] 共用市場仍有未知操作，等待對帳', '[PORTFOLIO_LOCK_BUSY] 投組已被另一輪鎖定，這一輪不規劃、不送交易',
    '[EXECUTOR_PAUSE_UNAVAILABLE] 讀不到 executor.globalPaused()，這一輪全部 blocked，不送交易']) {
    for (const id of [7, 8, 9, 10]) noteRoundOutcome(id, 'blocked', reason, queued);
    assert.equal(scheduledRebalanceAhead(7, queued)?.toISOString(), '2026-12-21T00:00:00.000Z');
    // 7 stays silent; the passed date, the failed round and the portfolio nobody ever looked at are still reported.
    assert.deepEqual(await severities([7, 8, 9, 10], queued), [[8, 'warn'], [9, 'critical'], [10, 'critical']]);
  }
  // The heartbeat keeps saving the real word with its own time, so the next restart has it too.
  assert.deepEqual(roundOutcomeSnapshot(queued)[7], { outcome: 'noop', reason: '下一次再平衡為 2026-12-21T00:00:00.000Z。', at: NOW.toISOString() });
  // Any other blocked round did look and replaces it, as before.
  noteRoundOutcome(7, 'blocked', '[STRATEGY_EXECUTION_UNAVAILABLE] 無法確認執行結果', queued);
  assert.deepEqual(await severities([7], queued), [[7, 'critical']]);
  // A real round says the date again, then that round fails: critical.
  noteRoundOutcome(7, 'noop', '下一次再平衡為 2026-12-21T00:00:00.000Z。', queued);
  assert.deepEqual(await severities([7], queued), []);
  noteRoundOutcome(7, 'failed', 'send failed', queued); noteRoundOutcome(7, 'blocked', DEX, queued);
  assert.deepEqual(await severities([7], queued), [[7, 'critical']]);
  // Nobody has really looked for longer than the TTL (the lane never frees): the old word no longer counts.
  resetRoundOutcomes();
  noteRoundOutcome(7, 'noop', '下一次再平衡為 2026-12-21T00:00:00.000Z。', NOW);
  const stale = new Date(NOW.getTime() + ROUND_OUTCOME_TTL_MS + 1);
  noteRoundOutcome(7, 'blocked', DEX, new Date(stale.getTime() - 60_000));
  assert.deepEqual(await severities([7], new Date(stale.getTime() - 60_000)), []);
  assert.deepEqual(await severities([7], stale), [[7, 'critical']]);
  noteRoundOutcome(7, 'blocked', DEX, stale);
  assert.equal(roundOutcomeSnapshot(stale)[7]?.reason, DEX);
  assert.deepEqual(await severities([7], stale), [[7, 'critical']]);
  // The date itself arrives while the lane is taken: reported (the wait is over).
  resetRoundOutcomes();
  const due = new Date('2026-12-21T00:00:01Z');
  noteRoundOutcome(7, 'noop', '下一次再平衡為 2026-12-21T00:00:00.000Z。', new Date(due.getTime() - 60_000));
  noteRoundOutcome(7, 'blocked', DEX, due);
  assert.deepEqual(await severities([7], due), [[7, 'warn']]);
});

test('PegExceeded on a top-up or a cash-out is a critical alert on that portfolio while it keeps happening; it joins a drift alert on the same portfolio and resolves once it has not been seen for two hours', async () => {
  const { detectAlerts, noteStrategyPegExceeded, resetStrategyPegSightings, strategyPegFindings, STRATEGY_PEG_TTL_MS } = await import('../src/alerts.js');
  resetStrategyPegSightings();
  noteStrategyPegExceeded(31, 'PegExceeded(1003000000000000000, 1000000000000000000) via https://rpc.example/secret-key', NOW);
  noteStrategyPegExceeded(31, 'PegExceeded(1003000000000000000, 1000000000000000000)', new Date(NOW.getTime() + 60_000));
  noteStrategyPegExceeded(12, 'PegExceeded', NOW);
  const later = new Date(NOW.getTime() + 120_000);
  const found = strategyPegFindings(later);
  assert.deepEqual(found.map(f => [f.kind, f.severity, f.portfolioId]), [['portfolio_stuck', 'critical', 12], ['portfolio_stuck', 'critical', 31]]);
  assert.match(found[1]!.detail, /^\[STRATEGY_PEG_EXCEEDED\] .*（2 次，最近 2026-11-24T13:31:00\.000Z）；重送沒有用，需要人查看池子：PegExceeded\(1003000000000000000, 1000000000000000000\)$/);
  assert.ok(!found.some(f => /rpc\.example/.test(f.detail)), 'a URL never reaches an alert');
  // In the whole evaluation: its own row for portfolio 12, and appended to portfolio 31's drift row (one row per kind and portfolio).
  const query = async (sql: string) => ({ rows: /from latest l/.test(sql) ? [{ portfolio_id: 31, hours_since: 3, gross_drift_bps: 900, threshold_bps: 100, total_usd_e8: '100000000000', pending_raw: '0', cash_raw: null }] : [] });
  const all = (await detectAlerts(query, { now: later, env: { CHAIN_ID: '56', PAYMASTER_URL: '' }, readNativeBalance: async () => 10n ** 18n, readGasPrice: async () => 1n })).filter(f => f.kind === 'portfolio_stuck');
  assert.deepEqual(all.map(f => [f.portfolioId, f.severity]), [[31, 'critical'], [12, 'critical']]);
  assert.match(all[0]!.detail, /900 bps drift.*；\[STRATEGY_PEG_EXCEEDED\]/);
  // Not seen for two hours: gone (the alert round then resolves the row).
  assert.deepEqual(strategyPegFindings(new Date(NOW.getTime() + 60_000 + STRATEGY_PEG_TTL_MS + 1)), []);
  resetStrategyPegSightings();
});

test('a "sell all" the scheduler has not finished after the stuck threshold is an alert: a warn while the market is closed, critical when nothing explains it or sends keep failing', async () => {
  const { detectAlerts, detectSellAllOverdue } = await import('../src/alerts.js');
  resetRoundOutcomes();
  const since = new Date(NOW.getTime() - 9 * 3_600_000);
  const seen: unknown[][] = [];
  const rows = [{ portfolio_id: '33', since, failures: 0 }, { portfolio_id: '34', since, failures: 0 }, { portfolio_id: '35', since, failures: 6 }];
  const query = async (sql: string, params: readonly unknown[] = []) => {
    if (!/sell_all_requested/.test(sql)) return { rows: [] };
    seen.push([...params]);
    return { rows };
  };
  // 33 and 35: the latest round waited for the stock market; 34: the latest round failed.
  noteRoundOutcome(33, 'blocked', '規劃器擋下（不執行）：[MARKET_CLOSED] 股票休市，等待交易時段', NOW);
  noteRoundOutcome(35, 'blocked', '規劃器擋下（不執行）：[MARKET_CLOSED] 股票休市，等待交易時段', NOW);
  noteRoundOutcome(34, 'blocked', '[STRATEGY_EARN_UNWIND_FAILED] 賣出前還款取回未完成，下一輪重試：bundler down', NOW);
  const found = await detectSellAllOverdue(query, 6, NOW);
  assert.deepEqual(seen, [[NOW.toISOString(), 6]], 'only requests older than the threshold are asked for');
  assert.deepEqual(found.map(f => [f.kind, f.severity, f.portfolioId]), [['portfolio_stuck', 'warn', 33], ['portfolio_stuck', 'critical', 34], ['portfolio_stuck', 'critical', 35]]);
  assert.match(found[0]!.detail, /^\[SELL_ALL_PENDING\] portfolio 33 的全部賣出從 .*（9\.0 小時）還沒賣完；等待中，不需處理：.*MARKET_CLOSED/);
  assert.match(found[1]!.detail, /還沒賣完；排程器會繼續重試/);
  assert.match(found[2]!.detail, /連續 6 次送出失敗；排程器會繼續重試/, 'failing sends are critical whatever the latest round said');
  // In the whole evaluation it joins the portfolio's drift row (one row per kind and portfolio) and raises it to critical.
  const all = (await detectAlerts(async (sql, params) => /from latest l/.test(sql)
    ? { rows: [{ portfolio_id: 34, hours_since: 3, gross_drift_bps: 900, threshold_bps: 100, total_usd_e8: '100000000000', pending_raw: '0', cash_raw: null }] }
    : query(sql, params), { now: NOW, env: { CHAIN_ID: '56', PAYMASTER_URL: '' }, readNativeBalance: async () => 10n ** 18n, readGasPrice: async () => 1n })).filter(f => f.kind === 'portfolio_stuck');
  assert.deepEqual(all.map(f => [f.portfolioId, f.severity]), [[34, 'critical'], [33, 'warn'], [35, 'critical']]);
  assert.match(all[0]!.detail, /900 bps drift.*；\[SELL_ALL_PENDING\]/);
  // A row that is not a request (another shape) is ignored rather than reported.
  assert.deepEqual(await detectSellAllOverdue(async () => ({ rows: [{ portfolio_id: 7, release_count: 3 }] }), 6, NOW), []);
  resetRoundOutcomes();
});
