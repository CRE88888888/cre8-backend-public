import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData, encodeFunctionData } from 'viem';
import type { Address, Hex } from 'viem';
import { createStrategyEarn, STRATEGY_EARN_97, STRATEGY_EARN_ABI, STRATEGY_EARN_MARKETS_PER_USER_OP, strategyEarnAutoOpen, strategyEarnBatches, strategyEarnUnwindForSale, strategyMarkets } from '../src/strategy-earn.js';
import type { Call, StatusReading, StrategyEarnChain, StrategyEarnStepArgs, StrategyMarket } from '../src/strategy-earn.js';
import { strategyEarnOpenDelay } from '../src/scheduler.js';
import { AppError } from '../src/errors.js';

/**
 * Portfolio 8 (2026-11-24): the scheduler's auto-open put every market of the portfolio into ONE session-key UserOp; with
 * the doubled gas estimate it went over the 14M per-UserOp cap and was rejected (PAYMASTER_USER_OP_CAPACITY) every round.
 * The steps now send several small UserOps in order.
 */
const E18 = 10n ** 18n, account = '0x1000000000000000000000000000000000000005' as Address, now = new Date('2026-11-24T13:00:00Z');
const lista = strategyMarkets().filter(m => m.protocol === 'lista' && m.decimals === 18).slice(0, 8), venus = strategyMarkets().filter(m => m.protocol === 'venus').slice(0, 2);
const ten: StrategyMarket[] = [...venus, ...lista]; // 2 Venus (shared debt) + 8 Lista
const decode = (c: Call) => decodeFunctionData({ abi: STRATEGY_EARN_ABI, data: c.data });
const marketOf = (c: Call) => String((decode(c).args as readonly unknown[])[1]).toLowerCase();
const symbolOf = (c: Call) => ten.find(m => m.marketId === marketOf(c))!.symbol;
const status = (patch: Partial<StatusReading> = {}): StatusReading => ({ gate: 0, shouldDeleverage: false, shouldUnwind: false, borrowRate: 0n, collateralRate: 0n, vaultRate: 0n,
  collateralIncentiveRate: 0n, borrowIncentiveRate: 0n, vaultIncentiveRate: 0n, borrowUtilizationBps: 0n, vaultUtilizationBps: 0n, ltv: 0n, targetLtv: 3n * 10n ** 17n,
  deleverageLtv: 5n * 10n ** 17n, liquidationLtv: 75n * 10n ** 16n, debt: 0n, vaultAssets: 0n, health: { collateralValue: 0n, liquidationValue: 0n, debtValue: 0n, healthFactor: 0n }, ...patch });
/** A tiny chain: `posted` moves a market's balance from the account into the position, as the executor would. */
function world() {
  const held = new Map(ten.map(m => [m.collateral as string, 10n * E18])), posted = new Map<string, bigint>(), debt = new Map<string, bigint>();
  const chain: StrategyEarnChain = {
    head: async () => ({ number: 1n, timestamp: 1_795_500_000n }),
    status: async id => status({ debt: debt.get(id) ?? 0n, vaultAssets: debt.get(id) ?? 0n, health: { collateralValue: (posted.get(id) ?? 0n) * 100n, liquidationValue: 0n, debtValue: debt.get(id) ?? 0n, healthFactor: 0n } }),
    accountMarkets: async () => ten.filter(m => (posted.get(m.marketId) ?? 0n) > 0n).map(m => m.marketId),
    collateral: async id => posted.get(id) ?? 0n,
    balance: async token => held.get(token.toLowerCase()) ?? 0n,
    price: async () => 100n * 10n ** 8n,
    rewards: async () => ({ vault: 0n, collateral: 0n }),
    policy: async () => ({ maxDebt: 1_000_000n * E18, enabled: true }),
    weights: async () => [],
  };
  const apply = (calls: Call[]) => { for (const c of calls) { const d = decode(c), [, id, amount] = d.args as unknown as readonly [Address, Hex, bigint]; const m = ten.find(x => x.marketId === id.toLowerCase())!;
    if (d.functionName === 'executeSupplyCollateral') { posted.set(m.marketId, (posted.get(m.marketId) ?? 0n) + amount); held.set(m.collateral, (held.get(m.collateral) ?? 0n) - amount); }
    if (d.functionName === 'executeBorrow') debt.set(m.marketId, (debt.get(m.marketId) ?? 0n) + amount);
    if (d.functionName === 'executeRepay') debt.set(m.marketId, 0n);
    if (d.functionName === 'executeWithdrawCollateral') { held.set(m.collateral, (held.get(m.collateral) ?? 0n) + (posted.get(m.marketId) ?? 0n)); posted.set(m.marketId, 0n); } } };
  return { chain, apply, posted, debt };
}
function step(w: ReturnType<typeof world>, o: { fail?: (batch: Call[], n: number) => Error | null } = {}) {
  const ops: Call[][] = [], recorded: Hex[] = [], lines: string[] = [];
  const args: StrategyEarnStepArgs = { chain: w.chain, account, portfolioId: 8, now, dryRun: false, held: ten.map(m => m.collateral), log: l => lines.push(l),
    ledger: { record: async (_chain, events) => { void events; } },
    send: async calls => { const failure = o.fail?.(calls, ops.length) ?? null; if (failure) throw failure; ops.push(calls); w.apply(calls);
      const hash = ('0x' + String(ops.length).padStart(64, '0')) as Hex; recorded.push(hash); return { hash, blockNumber: BigInt(ops.length), logs: [] }; } };
  return { args, ops, recorded, lines };
}
const capacity = () => new AppError(400, 'PAYMASTER_USER_OP_CAPACITY', 'paymaster sponsorship rejected: PAYMASTER_USER_OP_CAPACITY');

test('batches: same-market calls stay together, at most three markets per UserOp, order kept', () => {
  assert.equal(STRATEGY_EARN_MARKETS_PER_USER_OP, 3);
  const call = (fn: 'executeRepay' | 'executeWithdrawCollateral' | 'executeSupplyCollateral', m: StrategyMarket): Call => ({ to: account, value: '0',
    data: encodeFunctionData({ abi: STRATEGY_EARN_ABI, functionName: fn, args: (fn === 'executeRepay' ? [account, m.marketId, 1n, true, 9n] : [account, m.marketId, 1n, 9n]) as never }) });
  const [a, b, c, d] = ten as [StrategyMarket, StrategyMarket, StrategyMarket, StrategyMarket];
  assert.deepEqual(strategyEarnBatches([]), []);
  const shape = (calls: Call[], per?: number) => strategyEarnBatches(calls, per).map(batch => batch.map(x => `${decode(x).functionName.replace('execute', '')[0]}:${symbolOf(x)}`));
  // repay + withdraw of one market travel together
  assert.deepEqual(shape([call('executeRepay', a), call('executeWithdrawCollateral', a), call('executeRepay', b), call('executeWithdrawCollateral', b), call('executeRepay', c),
    call('executeWithdrawCollateral', c), call('executeRepay', d), call('executeWithdrawCollateral', d)]),
    [[`R:${a.symbol}`, `W:${a.symbol}`, `R:${b.symbol}`, `W:${b.symbol}`, `R:${c.symbol}`, `W:${c.symbol}`], [`R:${d.symbol}`, `W:${d.symbol}`]]);
  // Venus shared debt: all repayments first, then the withdrawals — the order is never changed, only cut
  assert.deepEqual(shape([call('executeRepay', a), call('executeRepay', b), call('executeWithdrawCollateral', a), call('executeWithdrawCollateral', b)]),
    [[`R:${a.symbol}`, `R:${b.symbol}`, `W:${a.symbol}`], [`W:${b.symbol}`]]);
  assert.deepEqual(shape([call('executeSupplyCollateral', a), call('executeSupplyCollateral', b)], 1), [[`S:${a.symbol}`], [`S:${b.symbol}`]]);
});

test('10-asset portfolio: auto-open goes out as 4 UserOps of at most 3 markets (6 calls), never one UserOp of 20 calls', async () => {
  const w = world(), s = step(w);
  const note = await strategyEarnAutoOpen(s.args);
  assert.deepEqual(s.ops.map(b => b.length), [6, 6, 6, 2]);
  assert.deepEqual(s.ops.map(b => [...new Set(b.map(symbolOf))]), [ten.slice(0, 3), ten.slice(3, 6), ten.slice(6, 9), ten.slice(9)].map(g => g.map(m => m.symbol)));
  for (const b of s.ops) for (let i = 0; i < b.length; i += 2) { // post + borrow of one market always travel together
    assert.deepEqual([decode(b[i]!).functionName, decode(b[i + 1]!).functionName, marketOf(b[i]!) === marketOf(b[i + 1]!)], ['executeSupplyCollateral', 'executeBorrow', true]); }
  assert.match(note ?? '', /^\[STRATEGY_EARN_OPEN\] 已自動開啟：.* tx=0x0+1,0x0+2,0x0+3,0x0+4（分 4 筆）$/);
  assert.equal(ten.every(m => w.posted.get(m.marketId) === 10n * E18), true);
  // Venus shares one loan: the second Venus market is planned on top of the first one's borrow, as in a single UserOp.
  const borrowOf = (m: StrategyMarket) => (decode(s.ops.flat().find(c => marketOf(c) === m.marketId && decode(c).functionName === 'executeBorrow')!).args as readonly unknown[])[2] as bigint;
  assert.equal(borrowOf(venus[0]!), borrowOf(venus[1]!));
  // Retry is idempotent: everything is posted, so the next round finds nothing to send.
  const again = step(w);
  assert.equal(await strategyEarnAutoOpen(again.args), null);
  assert.equal(again.ops.length, 0);
});

test('10-asset portfolio: a UserOp failing midway leaves the earlier ones done; the next round sends only what is left', async () => {
  const w = world(), s = step(w, { fail: (_b, n) => n === 2 ? new Error('bundler timeout\n  at ...') : null });
  await assert.rejects(strategyEarnAutoOpen(s.args), /^Error: 已完成 2 筆（tx=0x0+1,0x0+2），其餘未完成：bundler timeout$/);
  assert.equal(ten.filter(m => (w.posted.get(m.marketId) ?? 0n) > 0n).length, 6);
  const next = step(w);
  assert.match(await strategyEarnAutoOpen(next.args) ?? '', /（分 2 筆）$/);
  assert.deepEqual(next.ops.map(b => [...new Set(b.map(symbolOf))].length), [3, 1]); // only the four markets not opened yet
  assert.equal(ten.every(m => w.posted.get(m.marketId) === 10n * E18), true);
});

test('a batch that still exceeds the UserOp cap is retried one market at a time; a single market over the cap reports it', async () => {
  const w = world(), s = step(w, { fail: b => new Set(b.map(marketOf)).size > 1 ? capacity() : null });
  assert.match(await strategyEarnAutoOpen(s.args) ?? '', /（分 10 筆）$/);
  assert.deepEqual(s.ops.map(b => b.length), Array(10).fill(2));
  const stuck = step(world(), { fail: () => capacity() });
  await assert.rejects(strategyEarnAutoOpen(stuck.args), (e: unknown) => e instanceof AppError && e.code === 'PAYMASTER_USER_OP_CAPACITY');
  assert.equal(stuck.ops.length, 0);
});

test('10-asset portfolio: repay-and-take-back before a sale is split the same way', async () => {
  const w = world();
  await strategyEarnAutoOpen(step(w).args);
  const s = step(w);
  const steps = lista.map(m => ({ tokenIn: m.collateral, amountIn: 10n * E18 })); // sell the eight Lista assets
  const note = await strategyEarnUnwindForSale({ ...s.args, steps });
  assert.deepEqual(s.ops.map(b => [...new Set(b.map(marketOf))].length), [3, 3, 2]);
  assert.ok(s.ops.flat().every(c => ['executeRepay', 'executeWithdrawCollateral'].includes(decode(c).functionName)));
  assert.match(note ?? '', /^\[STRATEGY_EARN_UNWINDING\] 賣出前已還款取回：.*（分 3 筆）；下一輪再賣$/);
  assert.equal(lista.every(m => w.posted.get(m.marketId) === 0n), true);
  assert.equal(venus.every(m => w.posted.get(m.marketId) === 10n * E18), true); // not being sold: untouched
});

test('a failed auto-open backs off: 5, 10, 20, 40, then 60 minutes', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(n => strategyEarnOpenDelay(n) / 60_000), [5, 10, 20, 40, 60, 60]);
});


test('owner turn-off (API close): up to three markets is one UserOp as before; ten markets come as batches that each finish what they touch', async () => {
  const w = world();
  await strategyEarnAutoOpen(step(w).args);
  const earn = createStrategyEarn({ chainId: 97, chain: () => w.chain, owned: (async () => ({ chainId: 97, ownerAddress: account, accountAddress: account })) as never, now: () => now });
  const isOff = (c: Call) => c.to.toLowerCase() === STRATEGY_EARN_97.registry && decode(c).functionName === 'setBorrowPolicy';
  const marketsOf = (batch: Call[]) => [...new Set(batch.map(c => isOff(c) ? String((decode(c).args as readonly unknown[])[0]).toLowerCase() : marketOf(c)))];
  const small = await earn.close(8, account, { assets: lista.slice(0, 3).map(m => m.symbol) });
  assert.ok(small.status === 'ready');
  assert.deepEqual(small.batches, [small.calls]);
  const all = await earn.close(8, account, { assets: ten.map(m => m.symbol) });
  assert.ok(all.status === 'ready');
  // Venus (shared debt) first with its two consent withdrawals in the same UserOp, then Lista three markets at a time.
  assert.deepEqual(all.batches.map(b => marketsOf(b).length), [2, 3, 3, 2]);
  assert.deepEqual(marketsOf(all.batches[0]!).sort(), venus.map(m => m.marketId).sort());
  for (const batch of all.batches) {
    const closed = [...new Set(batch.filter(c => !isOff(c)).map(marketOf))], off = batch.filter(isOff).map(c => String((decode(c).args as readonly unknown[])[0]).toLowerCase());
    assert.deepEqual([...off].sort(), [...closed].sort(), 'every market a UserOp closes also has its consent withdrawn in that UserOp');
    for (const id of closed) assert.ok(batch.findIndex(c => isOff(c) && String((decode(c).args as readonly unknown[])[0]).toLowerCase() === id) > batch.map(c => !isOff(c) && marketOf(c) === id).lastIndexOf(true), 'settle before withdrawing consent');
  }
  assert.equal(all.batches.flat().length, all.calls.length); // same calls, only grouped differently
  // Retry after the second UserOp failed: the wallet asks again for what is still on and gets only those.
  for (const batch of all.batches.slice(0, 2)) w.apply(batch.filter(c => !isOff(c)));
  const stillOn = ten.filter(m => (w.posted.get(m.marketId) ?? 0n) > 0n);
  assert.equal(stillOn.length, 5);
  const retry = await earn.close(8, account, { assets: stillOn.map(m => m.symbol) });
  assert.ok(retry.status === 'ready');
  assert.deepEqual(retry.batches.map(b => marketsOf(b).length), [3, 2]);
});

test('consent and single-asset open also carry batches (one batch in practice)', async () => {
  const w = world();
  const earn = createStrategyEarn({ chainId: 97, chain: () => ({ ...w.chain, weights: async () => ten.map(m => ({ asset: m.collateral, weightBps: 1000 })) }),
    owned: (async () => ({ chainId: 97, ownerAddress: account, accountAddress: account, personalMix: false })) as never, now: () => now,
    query: (async () => ({ rows: [] })) as never });
  const open = await earn.open(8, account, { asset: lista[0]!.symbol, collateralRaw: (10n * E18).toString() });
  assert.ok(open.status === 'ready' && open.batches.length === 1 && open.batches[0]!.length === open.calls.length);
  const auto = await earn.auto(8, account, { budgetRaw: (1000n * E18).toString() });
  assert.ok(auto.status === 'ready');
  assert.deepEqual([auto.batches.length, auto.batches[0]!.length], [1, auto.calls.length]); // 2 delegations + 10 × (ceiling + approval) + 2 approvals = 24 light calls
});
