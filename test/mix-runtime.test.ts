import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideMixTick, loadMixRuntime, mixAvailableCash, mixBelowExecutorMinimum, mixExitCooldownMs, mixSwitchExitsPending, recordMixSwitchResidual } from '../src/mix-runtime.js';
import { mixRuntimeFixture, mixClock, WAD } from './fixtures/mix.js';
import { zeroHash, toHex } from 'viem';
import { TESTNET_97 as T } from '../src/testnet-profile.js';

test('mix stops at the exact oracle return threshold on a non-rebalance day, including a closed stock', () => {
  const { state, plan } = mixRuntimeFixture();
  const tick = decideMixTick(state, plan, mixClock);
  assert.equal(tick.mode, 'exit'); assert.equal(tick.trigger, 'take_profit'); assert.equal(tick.returnBps, '3000');
  assert.equal(tick.plan.targets.find(t => t.asset === T.contracts.usdt)?.weightBps, 10000);
  assert.ok(tick.plan.targets.filter(t => t.asset !== T.contracts.usdt).every(t => t.weightBps === 0));
  assert.equal(plan.targets[0]?.weightBps, 5000);
  assert.equal(tick.complete, false);
  const first = plan.snapshot.holdings[0]; assert.ok(first); first.amountWei--;
  assert.equal(decideMixTick(state, plan, mixClock).mode, 'wait');
});
test('mix loss-only, no threshold, zero/negative principal, and top-up do not fabricate a stop', () => {
  const { state, plan } = mixRuntimeFixture(); state.takeProfit = null;
  assert.equal(decideMixTick(state, plan, mixClock).mode, 'wait');
  state.deposits = 0n; assert.equal(decideMixTick(state, plan, mixClock).trigger, null);
  state.withdrawals = WAD; assert.equal(decideMixTick(state, plan, mixClock).returnBps, null);
  state.withdrawals = 0n; state.deposits = 200n * WAD;
  assert.equal(decideMixTick(state, plan, mixClock).trigger, 'stop_loss');
  state.stopLoss = null; assert.equal(decideMixTick(state, plan, mixClock).trigger, null);
  state.takeProfit = 3000;
  const cash = plan.snapshot.holdings.find(h => h.asset === T.contracts.usdt); assert.ok(cash); cash.amountWei = 100n * WAD;
  assert.equal(decideMixTick(state, plan, mixClock).returnBps, '1500');
  assert.equal(decideMixTick(state, plan, mixClock).trigger, null);
});
test('mix exit stays latched after prices recover, and exited/pending/missing valuation never authorize buying', () => {
  const { state, plan } = mixRuntimeFixture(); state.triggered = true; state.deposits = 1000n * WAD;
  assert.equal(decideMixTick(state, plan, mixClock).mode, 'exit');
  state.status = 'exited'; assert.equal(decideMixTick(state, plan, mixClock).mode, 'wait');
  state.status = 'active'; state.pending = true; assert.equal(decideMixTick(state, plan, mixClock).mode, 'exit', 'pending still evaluates the latched stop');
  state.pending = false; plan.report = null;
  assert.equal(decideMixTick(state, plan, mixClock).mode, 'wait');
});
test('mix preserves fresh funding budgets before target rebalancing and sells sub-dollar exit holdings', () => {
  const { state, plan } = mixRuntimeFixture(); state.takeProfit = null; state.stopLoss = null;
  state.last = null; state.newMoney = true;
  assert.equal(decideMixTick(state, plan, mixClock).mode, 'new_money');
  state.last = new Date('2026-11-01Z');
  assert.equal(decideMixTick(state, plan, mixClock).mode, 'new_money');
  state.newMoney = false;
  assert.equal(decideMixTick(state, plan, new Date('2026-12-01Z')).mode, 'rebalance');
  state.triggered = true;
  for (const h of plan.snapshot.holdings) h.amountWei = 0n;
  const holding = plan.snapshot.holdings[0]; assert.ok(holding); holding.amountWei = 10n ** 16n;
  assert.equal(decideMixTick(state, plan, mixClock).complete, false);
  holding.amountWei--;
  assert.equal(decideMixTick(state, plan, mixClock).complete, true);
  const other = plan.snapshot.holdings[1]; assert.ok(other); other.amountWei = 1n;
  assert.equal(decideMixTick(state, plan, mixClock).complete, false, 'sum of several dust positions at exactly $0.01 still needs selling');
});

test('restart baseline opens a fresh return period and future cash flows remain neutral', () => {
  const { state, plan } = mixRuntimeFixture();
  state.deposits = 130n * WAD;
  assert.equal(decideMixTick(state, plan, mixClock).trigger, null);
  state.deposits += 100n * WAD;
  const cash = plan.snapshot.holdings.find(h => h.asset === T.contracts.usdt); assert.ok(cash); cash.amountWei = 100n * WAD;
  assert.equal(decideMixTick(state, plan, mixClock).returnBps, '0');
  state.withdrawals = 100n * WAD; cash.amountWei = 0n;
  assert.equal(decideMixTick(state, plan, mixClock).returnBps, '0');
});

test('executor dust requires a zero oracle minimum for every full balance; RPC errors and one viable asset never count', async () => {
  const { plan } = mixRuntimeFixture();
  assert.equal(await mixBelowExecutorMinimum(plan, async (_asset, quantity, block) => { assert.ok(quantity > 0n); assert.equal(block, plan.snapshot.block); return 0n; }), true);
  assert.equal(await mixBelowExecutorMinimum({ ...plan, report: null }, async () => 0n), false);
  assert.equal(await mixBelowExecutorMinimum(plan, async asset => asset === T.assets.NVDAB.token ? 1n : 0n), false);
  await assert.rejects(mixBelowExecutorMinimum(plan, async () => { throw new Error('fixture timeout'); }));
  for (const h of plan.snapshot.holdings) h.amountWei = 0n;
  assert.equal(await mixBelowExecutorMinimum(plan, async () => 0n), false);
});
test('mix runtime fails closed on DB failure or incomplete state', async () => {
  const due = { personalMix: true, portfolioId: 1, strategyId: 1, account: T.roles.keeper, accountType: 'KERNEL',
    intervalSeconds: 60, unsupportedReason: null, nextRunAt: mixClock };
  assert.equal(await loadMixRuntime(due, async () => ({ rows: [] })), null);
  await assert.rejects(loadMixRuntime(due, async () => { throw new Error('DB unavailable'); }));
  await assert.rejects(loadMixRuntime(due, async () => ({ rows: [{ id: '1' }] })), /目前無法確認/);
});


test('mix target cash excludes closed sources and rejects missing, reserved, mismatched and unavailable accounting', async () => {
  const { plan } = mixRuntimeFixture();
  const due = { portfolioId: 1, strategyId: 1, account: T.roles.keeper, accountType: 'KERNEL', intervalSeconds: 60, unsupportedReason: null, nextRunAt: mixClock };
  const cash = plan.snapshot.holdings.find(h => h.asset === T.contracts.usdt); assert.ok(cash); cash.amountWei = 100n * WAD;
  const row = { allocated_cash_raw: '0', unallocated_hold_raw: cash.amountWei.toString(), stack_prefund_raw: '0', reserved_input_raw: '0',
    reserved_fee_raw: '0', withdrawal_raw: '0', yield_raw: '0', unclassified_raw: '0' };
  assert.equal(await mixAvailableCash(due, plan, async () => ({ rows: [row] })), 0n);
  row.allocated_cash_raw = WAD.toString(); row.unallocated_hold_raw = (99n * WAD).toString();
  assert.equal(await mixAvailableCash(due, plan, async () => ({ rows: [row] })), WAD);
  for (const bad of [{ ...row, unclassified_raw: '1' }, { ...row, reserved_input_raw: '1' }, { ...row, allocated_cash_raw: '0' }, {}]) {
    await assert.rejects(mixAvailableCash(due, plan, async () => ({ rows: [bad] })), /目前無法確認/);
  }
  await assert.rejects(mixAvailableCash(due, plan, async () => ({ rows: [] })), /目前無法確認/);
  await assert.rejects(mixAvailableCash(due, plan, async () => { throw new Error('fixture query unavailable'); }));
});

test('mix uses the saved user allocation as its rebalance target and drives a 1bp exit fully to zero', () => {
  const { state, plan } = mixRuntimeFixture(); state.takeProfit = null; state.stopLoss = null; state.last = null;
  state.exits = new Set([T.assets.WBNB.token]);
  state.userAllocation = { [T.assets.NVDAB.token]: 10000 };
  const stock = plan.targets.find(t => t.asset === T.assets.NVDAB.token), old = plan.targets.find(t => t.asset === T.assets.WBNB.token);
  assert.ok(stock && old); stock.weightBps = 9999; old.weightBps = 1;
  const tick = decideMixTick(state, plan, mixClock);
  assert.equal(tick.mode, 'rebalance'); assert.equal(tick.plan.targets.find(t => t.asset === old.asset)?.weightBps, 0);
  assert.equal(tick.plan.targets.find(t => t.asset === stock.asset)?.weightBps, 10000);
  assert.equal(old.weightBps, 1);
});

test('fresh switch cannot complete a below-batch-minimum noop while a 1bp exit remains at the per-step minimum', () => {
  const { state, plan } = mixRuntimeFixture();
  state.last = null; state.takeProfit = null; state.stopLoss = null;
  state.exits = new Set([T.assets.WBNB.token]); state.userAllocation = { [T.assets.NVDAB.token]: 10000 };
  const old = plan.snapshot.holdings.find(h => h.asset === T.assets.WBNB.token); assert.ok(old);
  old.amountWei = WAD;
  assert.equal(decideMixTick(state, plan, mixClock).complete, false);
  old.amountWei--;
  assert.equal(decideMixTick(state, plan, mixClock).complete, true);
  old.amountWei = 0n;
  assert.equal(decideMixTick(state, plan, mixClock).complete, true);
});

test('exit backoff validates persisted counts and caps arbitrarily long failure streaks', () => {
  for (const [count, delay] of [[0, 0], [4, 0], [5, 300000], [6, 900000], [7, 3600000], [8, 21600000], [Number.MAX_SAFE_INTEGER, 21600000]] as const) {
    assert.equal(mixExitCooldownMs(count), delay);
  }
  for (const count of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => mixExitCooldownMs(count));
});

test('forced switch exit thresholds follow the configured step minimum, including equality and a disabled minimum', () => {
  const previous = process.env.MIN_STEP_USD_E8;
  try {
    const { state, plan } = mixRuntimeFixture(); state.last = null; state.takeProfit = null; state.stopLoss = null;
    state.exits = new Set([T.assets.WBNB.token]); state.userAllocation = { [T.assets.NVDAB.token]: 10000 };
    const old = plan.snapshot.holdings.find(h => h.asset === T.assets.WBNB.token); assert.ok(old);
    process.env.MIN_STEP_USD_E8 = '200000000'; old.amountWei = 2n * WAD - 1n;
    assert.equal(mixSwitchExitsPending(state, plan), false);
    old.amountWei++; assert.equal(mixSwitchExitsPending(state, plan), true);
    process.env.MIN_STEP_USD_E8 = '0'; old.amountWei = 1n;
    assert.equal(mixSwitchExitsPending(state, plan), true);
    assert.equal(decideMixTick(state, plan, mixClock).complete, false);
    old.amountWei = 0n; assert.equal(mixSwitchExitsPending(state, plan), false);
  } finally { if (previous === undefined) delete process.env.MIN_STEP_USD_E8; else process.env.MIN_STEP_USD_E8 = previous; }
});

test('switch residuals require open markets, complete same-account valuation and a total strictly below the batch minimum', async () => {
  const open = new Date('2026-11-23T15:00Z');
  for (const mode of ['closed', 'unpriced', 'blocked', 'report', 'account', 'equal', 'zero'] as const) {
    const { state, plan } = mixRuntimeFixture(); state.last = null; state.exits = new Set([T.assets.NVDAB.token]);
    for (const h of plan.snapshot.holdings) h.amountWei = h.asset === T.assets.NVDAB.token ? 2n * WAD : 0n;
    if (mode === 'unpriced') plan.snapshot.unpriced.push({ asset: T.assets.TSLAB.token, amountWei: 1n, decimals: 18, symbol: 'TSLA', reason: 'fixture unavailable' });
    if (mode === 'blocked') plan.blocked.push({ code: 'UNPRICED_HOLDINGS', detail: 'unavailable' });
    if (mode === 'report') plan.report = null;
    if (mode === 'account') plan.account = T.roles.operator;
    if (mode === 'equal' || mode === 'zero') { const h = plan.snapshot.holdings[0]; assert.ok(h); h.amountWei = mode === 'equal' ? 50n * WAD : 0n; }
    const due = { portfolioId: 1, strategyId: 1, account: T.roles.keeper, accountType: 'KERNEL', intervalSeconds: 60, unsupportedReason: null, nextRunAt: open };
    assert.equal(await recordMixSwitchResidual(state, due, plan, mode === 'closed' ? mixClock : open,
      async () => { throw new Error('unexpected DB write'); }, async () => { throw new Error('unexpected RPC'); }), false);
  }
  const { state, plan } = mixRuntimeFixture(); state.last = null; state.exits = new Set([T.assets.NVDAB.token]);
  for (const h of plan.snapshot.holdings) h.amountWei = h.asset === T.assets.NVDAB.token ? 2n * WAD : 0n;
  const due = { portfolioId: 1, strategyId: 1, account: T.roles.keeper, accountType: 'KERNEL', intervalSeconds: 60, unsupportedReason: null, nextRunAt: open };
  for (const fault of ['rpc', 'db', 'reorg'] as const) {
    let reads = 0, writes = 0;
    await assert.rejects(recordMixSwitchResidual(state, due, plan, open, async () => { writes++; throw new Error('private DB'); }, async () => {
      if (fault === 'rpc') throw new Error('private RPC');
      return { hash: fault === 'reorg' && reads++ > 0 ? toHex(1n, { size: 32 }) : zeroHash, at: mixClock };
    }), error => error instanceof Error && !error.message.includes('private'));
    assert.equal(writes, fault === 'db' ? 1 : 0);
  }
});
