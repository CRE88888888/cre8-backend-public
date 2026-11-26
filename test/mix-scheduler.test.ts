import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runSchedulerOnce, judgeRebalanceOutcome, claimDuePortfolios } from '../src/scheduler.js';
import type { SchedulerDeps, SchedulerQueryFn, ExecutionOutcome } from '../src/scheduler.js';
import { mixRuntimeFixture, mixClock } from './fixtures/mix.js';
import { MIX_EXIT_COOLDOWN_MS, MIX_EXIT_MAX_RETRIES } from '../src/mix-runtime.js';
import { encodeErrorResult, zeroHash, maxUint256 } from 'viem';
import { PRICE_SOURCE_ABI } from '../src/chain.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';

function fixture() {
  const { state, plan } = mixRuntimeFixture();
  let quotes = 0, sends = 0, writes = 0, held = false;
  const query: SchedulerQueryFn = async sql => {
    if (sql.includes("to_regclass('mixes')")) return { rows: [{ ready: true }] };
    if (sql.includes('for update of p skip locked')) return { rows: [{ personal_mix: true, portfolio_id: '1', strategy_id: '1',
      address: plan.account, account_type: 'KERNEL', schedule: { kind: 'funding' }, execution_schema_version: 2,
      execution: { kind: 'per_asset' }, version: 1, schedule_state: 'active' }] };
    return { rows: [] };
  };
  const deps: SchedulerDeps = { query, chainId: 97, strategyEarnV2: null, executor: T.contracts.executor,
    withTransaction: work => work({ query }), withMixPortfolioLock: async (_id, work) => { held = true; try { return await work(); } finally { held = false; } },
    withDexLock: async (_chain, work) => work(), dexGate: async () => null, readGlobalPaused: async () => false, log: () => {},
    yieldRound: async () => ({ checked: 0, blocked: 0 }), planPortfolio: async () => plan,
    mixRuntime: async () => state, reconcileMix: async () => false, cacheMix: async () => {}, mixExitMinimum: async () => false, mixExitFailure: async () => { state.retries++; },
    prepareMixTick: async (_m, tick) => { assert.equal(held, true); writes++; if (tick.trigger) state.triggered = true; },
    planRebalance: async input => {
      quotes++;
      assert.equal(input.purpose, 'exit');
      assert.equal(input.idleCashBuys, undefined, 'an exit only sells');
      assert.equal(input.canTradeAsset?.(T.assets.NVDAB.token), false);
      assert.equal(input.canTradeAsset?.(T.assets.WBNB.token), true);
      assert.equal(input.plan.targets.find(t => t.asset === T.contracts.usdt)?.weightBps, 10000);
      return { kind: 'blocked', reason: 'fixture quote unavailable' };
    },
    executeRebalance: async () => { sends++; throw new Error('unexpected send'); } };
  return { state, plan, deps, counts: () => ({ quotes, sends, writes }) };
}
test('scheduler evaluates mix stops before monthly timing/new-money, carries market filters and persists the latch before quoting', async () => {
  const f = fixture();
  f.state.newMoney = true;
  const result = await runSchedulerOnce({ dryRun: false, now: mixClock, skipAlerts: true }, f.deps);
  assert.equal(result.results[0]?.outcome, 'blocked');
  assert.match(result.results[0]?.reason ?? '', /fixture quote unavailable/);
  assert.deepEqual(f.counts(), { quotes: 1, sends: 0, writes: 1 });
  assert.equal(f.state.triggered, true);
});
test('dry-run mix stop computes the same target while leaving its latch and all budget writes untouched', async () => {
  const f = fixture();
  await runSchedulerOnce({ dryRun: true, now: mixClock, skipAlerts: true }, f.deps);
  assert.equal(f.state.triggered, false);
  assert.deepEqual(f.counts(), { quotes: 1, sends: 0, writes: 0 });
});
test('scheduler never quotes or sends pending/exited/missing-state mixes, and DB/RPC errors cannot authorize', async () => {
  for (const mode of ['pending','exited','missing','rpc','db'] as const) {
    const f = fixture();
    if (mode === 'pending') f.state.pending = true;
    if (mode === 'exited') f.state.status = 'exited';
    if (mode === 'missing') f.deps.mixRuntime = async () => null;
    if (mode === 'rpc') f.deps.planPortfolio = async () => { throw new Error('secret RPC credential'); };
    if (mode === 'db') f.deps.mixRuntime = async () => { throw new Error('secret DB credential'); };
    const result = await runSchedulerOnce({ dryRun: false, now: mixClock, skipAlerts: true }, f.deps);
    assert.ok(['noop','blocked'].includes(result.results[0]?.outcome ?? ''));
    assert.doesNotMatch(result.results[0]?.reason ?? '', /credential/);
    // 2026-11-26: an account that could not be read has nothing in flight and sent nothing — the reason must not say
    // "reconcile first" (the app showed "an earlier trade is still being confirmed" for a plain read timeout).
    if (mode === 'rpc') { assert.match(result.results[0]?.reason ?? '', /^\[STRATEGY_UNAVAILABLE\] 帳戶的鏈上資料這一輪沒讀完，沒有規劃也沒有送出/); assert.doesNotMatch(result.results[0]?.reason ?? '', /先對帳|結果未知/); }
    assert.deepEqual(f.counts(), { quotes: 0, sends: 0, writes: mode === 'pending' ? 1 : 0 });
  }
});


test('mix immediate target pass sells open holdings while closed funding sources wait without cancelling their budgets', async () => {
  const f = fixture(); f.state.last = null; f.state.newMoney = true; f.state.takeProfit = null; f.state.stopLoss = null;
  const crypto = f.plan.snapshot.holdings.find(h => h.asset === T.assets.WBNB.token); assert.ok(crypto); crypto.amountWei *= 2n;
  f.deps.prepareNewMoney = async () => ({ job: null, context: { chainId: 97, portfolioId: 1, strategyId: 1, version: 1, kind: 'asset',
    account: f.plan.account, allocation: { assets: [] }, cash: T.contracts.usdt, now: mixClock, reserve: 0n, caps: new Map(), buyLimit: 0n,
    observedCash: 0n, enabled: true, marketOpen: false }, rebalance: { kind: 'noop', reason: '[MARKET_CLOSED] 股票等待開盤' } });
  const query = f.deps.query; assert.ok(query);
  f.deps.query = (sql, params) => sql.includes('from strategy_cash_balances') ? Promise.resolve({ rows: [{
    allocated_cash_raw: '0', unallocated_hold_raw: '0', stack_prefund_raw: '0', reserved_input_raw: '0', reserved_fee_raw: '0',
    withdrawal_raw: '0', yield_raw: '0', unclassified_raw: '0' }] }) : query(sql, params);
  let quotes = 0;
  f.deps.planRebalance = async input => { quotes++; assert.equal(input.cashBudgetRaw, 0n);
    assert.equal(input.plan.thresholdBps, 0); return { kind: 'blocked', reason: 'fixture immediate target pass' }; };
  const result = await runSchedulerOnce({ dryRun: false, now: mixClock, skipAlerts: true }, f.deps);
  assert.match(result.results[0]?.reason ?? '', /fixture immediate target pass/); assert.equal(quotes, 1);
  assert.equal(f.counts().sends, 0);
});

test('monthly mix completes a planner noop once, stays quiet inside the period and retries closed markets', async () => {
  const f = fixture(); f.state.takeProfit = null; f.state.stopLoss = null; f.state.last = null;
  const h = f.plan.snapshot.holdings.find(h => h.asset === T.assets.WBNB.token); assert.ok(h); h.amountWei *= 2n;
  const query = f.deps.query; assert.ok(query);
  let quotes = 0, completed = 0, closed = false;
  f.deps.query = async (sql, params) => {
    if (sql.includes('update mixes set last_rebalanced_at')) { completed++; f.state.last = mixClock; return { rows: [] }; }
    return query(sql, params);
  };
  f.deps.planRebalance = async () => { quotes++; return closed ? { kind: 'blocked', reason: '[MARKET_CLOSED] 等待開盤' }
    : { kind: 'noop', reason: '無超過最小交易額的可執行交易' }; };
  await runSchedulerOnce({ dryRun: false, now: mixClock, skipAlerts: true }, f.deps);
  assert.equal(completed, 1);
  await runSchedulerOnce({ dryRun: false, now: new Date('2026-11-22T12:00Z'), skipAlerts: true }, f.deps);
  assert.equal(quotes, 1); assert.equal(completed, 1);
  closed = true;
  await runSchedulerOnce({ dryRun: false, now: new Date('2026-12-01T00:00Z'), skipAlerts: true }, f.deps);
  await runSchedulerOnce({ dryRun: false, now: new Date('2026-12-01T00:01Z'), skipAlerts: true }, f.deps);
  assert.equal(quotes, 3); assert.equal(completed, 1);
  closed = false;
  await runSchedulerOnce({ dryRun: true, now: new Date('2026-12-01T00:02Z'), skipAlerts: true }, f.deps);
  assert.equal(completed, 1, 'dry run cannot consume a calendar period');
});

test('planner deferrals, oracle/RPC failures, closed markets and dry-run do not spend exit retry allowance', async () => {
  const f = fixture();
  for (let i = 0; i < 6; i++) await runSchedulerOnce({ dryRun: false, now: mixClock, skipAlerts: true }, f.deps);
  assert.equal(f.state.retries, 0); assert.equal(f.counts().quotes, 6); assert.equal(f.counts().sends, 0);
  const closed = fixture();
  closed.deps.planRebalance = async () => ({ kind: 'blocked', reason: '[MARKET_CLOSED] 股票收盤，等待開盤' });
  await runSchedulerOnce({ dryRun: false, now: mixClock, skipAlerts: true }, closed.deps);
  assert.equal(closed.state.retries, 0);
  const dry = fixture(); await runSchedulerOnce({ dryRun: true, now: mixClock, skipAlerts: true }, dry.deps);
  assert.equal(dry.state.retries, 0);
});

test('monthly due pass below the batch minimum completes the period, while a deferred quote keeps it due', async () => {
  const f = fixture(); f.state.last = null; f.state.takeProfit = null; f.state.stopLoss = null;
  const h = f.plan.snapshot.holdings.find(h => h.asset === T.assets.WBNB.token); assert.ok(h); h.amountWei += 20n * 10n ** 18n;
  const query = f.deps.query; assert.ok(query); let completed = 0;
  f.deps.query = async (sql, params) => {
    if (sql.startsWith('update mixes set last_rebalanced_at')) { completed++; f.state.last = new Date('2026-11-20T16:00Z'); return { rows: [] }; }
    return query(sql, params);
  };
  f.deps.planRebalance = async () => ({ kind: 'blocked', reason: '[BELOW_MIN_BATCH] 不足批次門檻', retryable: false });
  await runSchedulerOnce({ dryRun: false, now: new Date('2026-11-20T16:00Z'), skipAlerts: true }, f.deps);
  assert.equal(completed, 1);
  f.state.last = null;
  f.deps.planRebalance = async () => ({ kind: 'blocked', reason: '[BELOW_MIN_BATCH] 不足批次門檻', retryable: true });
  await runSchedulerOnce({ dryRun: false, now: mixClock, skipAlerts: true }, f.deps);
  assert.equal(completed, 1, 'a closed/RPC-deferred leg cannot consume the occurrence');
});


test('a basket rebalance asks the planner to buy idle cash back, and such a batch is checked against the buy minimum (10 USDT with its fee), not the 50 between assets', async () => {
  const f = fixture(); f.state.last = null; f.state.takeProfit = null; f.state.stopLoss = null;
  const cash = f.plan.snapshot.holdings.find(h => h.asset === T.contracts.usdt); assert.ok(cash); cash.amountWei = 12n * 10n ** 18n;
  const reserve = 27n * 10n ** 16n;
  const steps = [{ tokenIn: T.contracts.usdt, tokenOut: T.assets.WBNB.token, amountIn: 12n * 10n ** 18n - reserve, amountOutMin: 1n, oracleFloor: 1n, venue: T.contracts.router, data: '0x' as const }];
  let asked: boolean | undefined;
  const checks: unknown[][] = [];
  f.deps.planRebalance = async input => { asked = input.idleCashBuys; assert.equal(input.purpose, undefined);
    return { kind: 'ready', steps, deadline: 2000000000n, rationale: 'fixture idle cash', idleCashBuy: { feeReserveRaw: reserve } }; };
  f.deps.clock = () => mixClock;
  f.deps.readBuyVersionWindow = async () => ({ activeVersion: 1, timestamp: BigInt(Math.floor(mixClock.getTime() / 1000)), pendingActiveAt: null });
  f.deps.checkTradingMinimums = async (...args) => { checks.push(args); return '[FIXTURE_STOP] stop before sending'; };
  const result = await runSchedulerOnce({ dryRun: false, now: mixClock, skipAlerts: true }, f.deps);
  assert.equal(asked, true);
  assert.match(result.results[0]?.reason ?? '', /FIXTURE_STOP/);
  // Budget = what is bought + the fee reserve (12 USDT), and no 50-USDT rebalance reserve is passed.
  assert.deepEqual(checks.map(([planned, purpose, , budget, , rebalanceReserve]) => [planned, purpose, budget, rebalanceReserve]), [[steps, 'ordinary', 12n * 10n ** 18n, undefined]]);
  // A batch of that size under the minimum stays as cash: a quiet noop, not an error each round.
  f.deps.checkTradingMinimums = async () => '[BELOW_MIN_BATCH] 含費批次不足10 USDT';
  const small = await runSchedulerOnce({ dryRun: false, now: mixClock, skipAlerts: true }, f.deps);
  assert.equal(small.results[0]?.outcome, 'noop'); assert.match(small.results[0]?.reason ?? '', /\[BELOW_MIN_BATCH\].*留作現金/);
  assert.equal(f.counts().sends, 0);
});

test('keeper outage for five minutes does not exhaust exits and the next priced tick completes without restart', async () => {
  const f = fixture();
  f.deps.planRebalance = async () => ({ kind: 'blocked', reason: '[StaleFeed] keeper stopped', retryable: true });
  for (let i = 0; i < 5; i++) await runSchedulerOnce({ dryRun: false, now: new Date(mixClock.getTime() + i * 60000), skipAlerts: true }, f.deps);
  assert.equal(f.state.retries, 0);
  for (const h of f.plan.snapshot.holdings) if (h.asset !== T.contracts.usdt) h.amountWei = 0n;
  const finished = await runSchedulerOnce({ dryRun: false, now: new Date(mixClock.getTime() + 300000), skipAlerts: true }, f.deps);
  assert.match(finished.results[0]?.reason ?? '', /組合已退出/);
  assert.equal(f.state.triggered, true);
});


function tradableExit() {
  const f = fixture();
  const query = f.deps.query; assert.ok(query);
  const key = { key_ref: "m/44'/60'/0'/0/1", permissions: { permissionId: '0x12345678',
    sessionKeyAddress: T.roles.keeper, timestamp: { validUntil: 2000000000 } }, owner: T.roles.keeper };
  f.deps.query = async (sql, params) => {
    if (sql.includes('select m.id from mixes')) return { rows: [{ id: f.state.id }] };
    if (sql.includes('from session_keys')) return { rows: [key] };
    if (sql.includes('insert into operations')) return { rows: [{ attempts: 1 }] };
    if (sql.includes('select state from operations')) return { rows: [{ state: 'submitted' }] };
    if (sql.includes('update operations')) return { rows: [{ id: '1' }] };
    if (sql.includes('update mixes set exit_retry_count=0')) { f.state.retries = 0; f.state.lastExitAttempt = null; }
    return query(sql, params);
  };
  const tradeQuery = f.deps.query;
  f.deps.withTransaction = work => work({ query: tradeQuery });
  f.deps.mixExitFailure = async (_m, _due, now) => { f.state.retries++; f.state.lastExitAttempt = now; };
  f.deps.planRebalance = async () => ({ kind: 'ready', steps: [{ tokenIn: T.assets.WBNB.token, tokenOut: T.contracts.usdt,
    amountIn: 10n ** 18n, amountOutMin: 1n, oracleFloor: 1n, venue: T.contracts.router, data: '0x' }],
    deadline: 2000000000n, rationale: 'fixture exit', purpose: 'exit' });
  f.deps.refreshFloors = async input => ({ ok: true, steps: [...input.steps], refreshes: [], note: 'fixture oracle floor' });
  f.deps.checkTradingMinimums = async () => null;
  f.deps.readPermissionConfig = async () => ({ signer: T.roles.keeper, policyCount: 3 });
  f.deps.deriveSessionKeyAddress = async () => T.roles.keeper;
  f.deps.readAllowance = async () => maxUint256;
  f.deps.readBalance = async () => maxUint256;
  f.deps.readRebalanceNonce = async () => 0n;
  f.deps.clock = () => mixClock;
  let outcome: ExecutionOutcome = { status: 'reverted', txHash: zeroHash, userOpHash: zeroHash, gasUsed: '1', error: 'fixture trade failure' };
  let sends = 0;
  f.deps.executeRebalance = async () => { sends++; return { ...outcome }; };
  f.deps.reconcileRebalance = async () => ({ kind: 'found', outcome: { ...outcome, cashDeltaRaw: '1' } });
  return { ...f, setOutcome: (value: ExecutionOutcome) => { outcome = value; }, sends: () => sends };
}

test('only canonical non-oracle sell failures count; RPC errors, unknown receipts and StaleFeed reverts retain the allowance', async () => {
  for (const status of ['reverted', 'error', 'unknown'] as const) {
    const f = tradableExit();
    f.setOutcome({ status, txHash: status === 'error' ? null : zeroHash, userOpHash: status === 'error' ? null : zeroHash, gasUsed: null, error: 'fixture failure' });
    const result = await runSchedulerOnce({ dryRun: false, now: mixClock, skipAlerts: true }, f.deps);
    assert.equal(f.sends(), 1, result.results[0]?.reason);
    assert.equal(f.state.retries, status === 'reverted' ? 1 : 0);
  }
  const f = tradableExit();
  const stale = judgeRebalanceOutcome({ txStatus: 'success', userOpSuccess: false, swapExecuted: 0, expectedSwaps: 1,
    txHash: zeroHash, userOpHash: zeroHash, gasUsed: '1', revertReason: encodeErrorResult({ abi: PRICE_SOURCE_ABI,
      errorName: 'StaleFeed', args: [T.assets.WBNB.token, 1n] }) });
  f.setOutcome(stale);
  await runSchedulerOnce({ dryRun: false, now: mixClock, skipAlerts: true }, f.deps);
  assert.equal(f.sends(), 1); assert.equal(f.state.retries, 0);
});

test('five consecutive failed sells cool down at the exact boundary, recover with a successful batch and keep exiting', async () => {
  const f = tradableExit();
  for (let i = 0; i < MIX_EXIT_MAX_RETRIES; i++) await runSchedulerOnce({ dryRun: false, now: mixClock, skipAlerts: true }, f.deps);
  assert.equal(f.state.retries, 5); assert.equal(f.sends(), 5);
  await runSchedulerOnce({ dryRun: false, now: new Date(mixClock.getTime() + MIX_EXIT_COOLDOWN_MS - 1), skipAlerts: true }, f.deps);
  assert.equal(f.sends(), 5);
  f.setOutcome({ status: 'success', txHash: zeroHash, userOpHash: zeroHash, gasUsed: '1', error: null });
  const recovered = await runSchedulerOnce({ dryRun: false, now: new Date(mixClock.getTime() + MIX_EXIT_COOLDOWN_MS), skipAlerts: true }, f.deps);
  assert.equal(recovered.results[0]?.outcome, 'executed', recovered.results[0]?.reason);
  assert.equal(f.sends(), 6); assert.equal(f.state.retries, 0); assert.equal(f.state.triggered, true);
  for (const h of f.plan.snapshot.holdings) if (h.asset !== T.contracts.usdt) h.amountWei = 0n;
  const finished = await runSchedulerOnce({ dryRun: false, now: new Date(mixClock.getTime() + MIX_EXIT_COOLDOWN_MS + 60000), skipAlerts: true }, f.deps);
  assert.match(finished.results[0]?.reason ?? '', /組合已退出/);
});


test('late canonical failed exit receipt counts once after unknown, while late oracle failures do not count', async () => {
  for (const oracle of [false, true]) {
    const f = tradableExit();
    const query = f.deps.query; assert.ok(query);
    let unresolved = true;
    f.deps.query = async (sql, params) => {
      if (sql.includes('select idempotency_key, payload_hash')) return { rows: unresolved ? [{ idempotency_key: 'late-exit',
        payload_hash: zeroHash, state: 'submitted', user_op_hash: zeroHash, tx_hash: zeroHash, strategy_job_id: null }] : [] };
      if (sql.includes('update operations')) unresolved = false;
      return query(sql, params);
    };
    const lateQuery = f.deps.query;
    f.deps.withTransaction = work => work({ query: lateQuery });
    f.setOutcome({ status: 'reverted', txHash: zeroHash, userOpHash: zeroHash, gasUsed: '1', error: 'fixture failed exit',
      ...(oracle ? { priceSourceFailure: { code: 'StaleFeed', detail: 'fixture keeper stale' } as const } : {}) });
    await runSchedulerOnce({ dryRun: false, now: mixClock, skipAlerts: true }, f.deps);
    assert.equal(f.sends(), 0); assert.equal(f.state.retries, oracle ? 0 : 1);
  }
});


test('mix exit recovery requires schema readiness; historical and non-testnet claims retain their original SQL and DB failures stop claiming', async () => {
  for (const [chainId, ready] of [[97, true], [97, false], [56, false]] as const) {
    const statements: string[] = [];
    const query: SchedulerQueryFn = async sql => { statements.push(sql); return { rows: sql.includes('to_regclass') ? [{ ready }] : [] }; };
    assert.deepEqual(await claimDuePortfolios(1, mixClock, { chainId, withTransaction: work => work({ query }) }), []);
    const claim = statements.find(sql => sql.includes('for update of p skip locked')); assert.ok(claim);
    assert.equal(claim.includes('from mixes m'), chainId === 97 && ready);
    assert.equal(statements.filter(sql => sql.includes('to_regclass')).length, chainId === 97 ? 1 : 0);
  }
  for (const rows of [[], [{ ready: null }], [{ ready: 'true' }]]) {
    await assert.rejects(claimDuePortfolios(1, mixClock, { chainId: 97,
      withTransaction: work => work({ query: async () => ({ rows }) }) }), /metadata unavailable/);
  }
  await assert.rejects(claimDuePortfolios(1, mixClock, { chainId: 97, withTransaction: work => work({
    query: async () => { throw new Error('private DB credential'); },
  }) }), error => error instanceof Error && /metadata unavailable/.test(error.message) && !error.message.includes('private'));
});

test('continued canonical sell failures back off through 5m, 15m, 1h and capped 6h, then reset on success', async () => {
  const f = tradableExit();
  for (let i = 0; i < 5; i++) await runSchedulerOnce({ dryRun: false, now: mixClock, skipAlerts: true }, f.deps);
  let at = mixClock.getTime(), sends = 5;
  f.deps.clock = () => new Date(at);
  for (const delay of [300000, 900000, 3600000, 21600000, 21600000]) {
    await runSchedulerOnce({ dryRun: false, now: new Date(at + delay - 1), skipAlerts: true }, f.deps);
    assert.equal(f.sends(), sends, `no sponsored attempt before ${delay}ms`);
    at += delay;
    await runSchedulerOnce({ dryRun: false, now: new Date(at), skipAlerts: true }, f.deps);
    assert.equal(f.sends(), ++sends, 'the exact boundary permits one retry');
  }
  f.setOutcome({ status: 'success', txHash: zeroHash, userOpHash: zeroHash, gasUsed: '1', error: null });
  await runSchedulerOnce({ dryRun: false, now: new Date(at + 21600000), skipAlerts: true }, f.deps);
  assert.equal(f.state.retries, 0);
});

test('a forced switch noop cannot consume the period while a closed 1bp stock exit remains sellable', async () => {
  const f = fixture(); f.state.last = null; f.state.takeProfit = null; f.state.stopLoss = null;
  f.state.exits = new Set([T.assets.NVDAB.token, T.assets.WBNB.token]);
  f.state.userAllocation = { [T.contracts.usdt]: 10000 };
  const crypto = f.plan.snapshot.holdings.find(h => h.asset === T.assets.WBNB.token); assert.ok(crypto); crypto.amountWei = 0n;
  const query = f.deps.query; assert.ok(query); let completed = 0;
  f.deps.query = async (sql, params) => { if (sql.startsWith('update mixes set last_rebalanced_at')) completed++; return query(sql, params); };
  f.deps.planRebalance = async () => ({ kind: 'noop', reason: '[BELOW_MIN_BATCH] closed stock excluded', retryable: false });
  await runSchedulerOnce({ dryRun: false, now: mixClock, skipAlerts: true }, f.deps);
  assert.equal(completed, 0);
  f.state.last = new Date('2026-11-01Z');
  await runSchedulerOnce({ dryRun: false, now: new Date('2026-12-01Z'), skipAlerts: true }, f.deps);
  assert.equal(completed, 1, 'a general calendar pass still completes after its executable batch/noop');
});

test('a forced switch records a proven below-batch residual instead of leaving a tradable-sized tail due forever', async () => {
  const f = fixture(); f.state.last = null; f.state.takeProfit = null; f.state.stopLoss = null;
  f.state.exits = new Set([T.assets.NVDAB.token]); f.state.userAllocation = { [T.contracts.usdt]: 10000 };
  for (const h of f.plan.snapshot.holdings) h.amountWei = h.asset === T.assets.NVDAB.token ? 2n * 10n ** 18n : 0n;
  f.deps.planRebalance = async () => ({ kind: 'blocked', reason: '[BELOW_MIN_BATCH] 不足批次門檻', retryable: false });
  let recorded = 0;
  f.deps.mixSwitchResidual = async () => { recorded++; return true; };
  const result = await runSchedulerOnce({ dryRun: false, now: new Date('2026-11-23T15:00Z'), skipAlerts: true }, f.deps);
  assert.equal(recorded, 1);
  assert.match(result.results[0]?.reason ?? '', /殘留/);
});

for (const late of [false, true]) test(`a ${late ? 'late' : 'fresh'} canonical batch completes a switch once its crypto exits are gone while its target stock is closed`, async () => {
  const f = tradableExit();
  f.state.last = null; f.state.takeProfit = null; f.state.stopLoss = null;
  f.state.exits = new Set([T.assets.BTCB.token]);
  f.plan.targets.push({ asset: T.assets.BTCB.token, weightBps: 1, symbol: 'BTCB' });
  f.plan.snapshot.holdings.push({ asset: T.assets.BTCB.token, amountWei: 0n, decimals: 18, usdPriceE8: 100000000n, priceSource: 'numeraire' });
  const crypto = f.plan.snapshot.holdings.find(h => h.asset === T.assets.WBNB.token); assert.ok(crypto);
  crypto.amountWei *= 2n;
  const query = f.deps.query; assert.ok(query);
  let completed = 0, unresolved = late;
  f.deps.query = async (sql, params) => {
    if (sql.includes('select idempotency_key, payload_hash')) return { rows: unresolved ? [{ idempotency_key: 'late-switch',
      payload_hash: zeroHash, state: 'submitted', user_op_hash: zeroHash, tx_hash: zeroHash, strategy_job_id: null }] : [] };
    if (sql.startsWith('update mixes set last_rebalanced_at') && params?.[1] === false) { completed++; f.state.last = mixClock; }
    if (sql.includes('update operations')) unresolved = false;
    return query(sql, params);
  };
  const settlementQuery = f.deps.query;
  f.deps.withTransaction = work => work({ query: settlementQuery });
  f.setOutcome({ status: 'success', txHash: zeroHash, userOpHash: zeroHash, gasUsed: '1', error: null });
  const result = await runSchedulerOnce({ dryRun: false, now: mixClock, skipAlerts: true }, f.deps);
  assert.equal(result.results[0]?.outcome, 'executed', result.results[0]?.reason);
  assert.equal(completed, 1);
  const sends = f.sends();
  await runSchedulerOnce({ dryRun: false, now: new Date(mixClock.getTime() + 60000), skipAlerts: true }, f.deps);
  assert.equal(f.sends(), sends, 'no second trade in the completed calendar period');
});

for (const failure of ['rpc', 'db', 'missing', 'unpriced', 'blocked'] as const) test(`late switch settlement retains its operation when refreshed exit valuation is ${failure}`, async () => {
  const f = tradableExit(); f.state.last = null;
  const query = f.deps.query; assert.ok(query);
  let settled = 0;
  f.deps.query = async (sql, params) => {
    if (sql.includes('select idempotency_key, payload_hash')) return { rows: [{ idempotency_key: 'late-switch', payload_hash: zeroHash,
      state: 'submitted', user_op_hash: zeroHash, tx_hash: zeroHash, strategy_job_id: null }] };
    if (sql.includes('update operations')) settled++;
    return query(sql, params);
  };
  const settlementQuery = f.deps.query;
  f.deps.withTransaction = work => work({ query: settlementQuery });
  if (failure === 'rpc') f.deps.planPortfolio = async () => { throw new Error('private RPC credential'); };
  if (failure === 'db') f.deps.mixRuntime = async () => { throw new Error('private DB credential'); };
  if (failure === 'missing') f.deps.mixRuntime = async () => null;
  if (failure === 'unpriced') f.plan.snapshot.unpriced.push({ asset: T.assets.WBNB.token, symbol: 'WBNB', decimals: 18, amountWei: 1n, reason: 'pricing_failed' });
  if (failure === 'blocked') f.plan.report = null;
  f.setOutcome({ status: 'success', txHash: zeroHash, userOpHash: zeroHash, gasUsed: '1', error: null });
  const result = await runSchedulerOnce({ dryRun: false, now: mixClock, skipAlerts: true }, f.deps);
  assert.equal(result.results[0]?.outcome, 'blocked');
  assert.doesNotMatch(result.results[0]?.reason ?? '', /private|credential/);
  assert.equal(settled, 0); assert.equal(f.state.last, null); assert.equal(f.sends(), 0);
});

test('market-hours bypass: the listed test wallet\'s basket buys and sells its stock legs while the session is closed; other baskets wait', async () => {
  const canary = '0xd3ab39b62e221bf9e8ba19fe19b2638767d3d6d9';
  for (const [owner, account, open] of [[canary, '0x' + 'c7'.repeat(20), true], ['0x00000000000000000000000000000000000000a1', '0x' + 'c8'.repeat(20), false]] as const) {
    const f = fixture(); f.plan.account = account as `0x${string}`; f.state.owner = owner;
    f.state.last = null; f.state.newMoney = true; f.state.takeProfit = null; f.state.stopLoss = null;
    const crypto = f.plan.snapshot.holdings.find(h => h.asset === T.assets.WBNB.token); assert.ok(crypto); crypto.amountWei *= 2n;
    const query = f.deps.query; assert.ok(query);
    f.deps.query = (sql, params) => sql.includes('select owner from smart_accounts') ? Promise.resolve({ rows: [{ owner }] })
      : sql.includes('from strategy_cash_balances') ? Promise.resolve({ rows: [{ allocated_cash_raw: '0', unallocated_hold_raw: '0', stack_prefund_raw: '0',
        reserved_input_raw: '0', reserved_fee_raw: '0', withdrawal_raw: '0', yield_raw: '0', unclassified_raw: '0' }] }) : query(sql, params);
    const seen: unknown[] = [];
    // New money: the scheduler hands the owner to the buy planner (strategy-runtime.ts decides the session with it).
    f.deps.prepareNewMoney = async args => { seen.push(['buy', args.owner]); return { job: null, context: { chainId: 97, portfolioId: 1, strategyId: 1, version: 1, kind: 'asset',
      account: f.plan.account, allocation: { assets: [] }, cash: T.contracts.usdt, now: mixClock, reserve: 0n, caps: new Map(), buyLimit: 0n,
      observedCash: 0n, enabled: true, marketOpen: open }, rebalance: { kind: 'noop', reason: '[BASKET_WAITING] fixture' } }; };
    // The basket's own rebalance: the per-asset session filter says the stock leg can trade for the listed wallet only.
    f.deps.planRebalance = async input => { seen.push(['rebalance', input.owner, input.canTradeAsset?.(T.assets.NVDAB.token), input.canTradeAsset?.(T.assets.WBNB.token)]);
      return { kind: 'blocked', reason: 'fixture stop' }; };
    const result = await runSchedulerOnce({ dryRun: false, now: mixClock, skipAlerts: true }, f.deps);
    assert.match(result.results[0]?.reason ?? '', /fixture stop/);
    assert.deepEqual(seen, [['buy', owner], ['rebalance', owner, open, true]]);
  }
});
