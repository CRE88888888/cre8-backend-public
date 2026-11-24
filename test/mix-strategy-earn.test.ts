import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { decodeFunctionData, encodeFunctionData, erc20Abi, maxUint256 } from 'viem';
import type { Address, Hex } from 'viem';
import { mixFlowDirection } from '../src/mix-flows.js';
import { mixOwnerCalls } from '../src/mix-approval.js';
import { assertMixOwnerCalls, MIX_SUDO_NONCE_KEY } from '../src/mix-sponsorship.js';
import { runSchedulerOnce } from '../src/scheduler.js';
import type { SchedulerDeps, SchedulerQueryFn } from '../src/scheduler.js';
import {
  consentCalls, consentedMarkets, mixStrategyConsentCalls, STRATEGY_EARN_97 as S, STRATEGY_EARN_ABI, strategyEarnAutoOpen, strategyMarkets,
} from '../src/strategy-earn.js';
import type { StatusReading, StrategyEarnChain } from '../src/strategy-earn.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
import { mixClock, mixRuntimeFixture } from './fixtures/mix.js';
import { resetStrategyEarnOpenBackoff } from '../src/scheduler.js';
// A failed auto-open backs off for minutes (process-wide, real clock): each case starts with a clean slate.
beforeEach(resetStrategyEarnOpenBackoff);

/**
 * Yield strategy (策略加息) on a My mix: the mix's own account posts its eligible holdings, borrows into the strategy
 * vault, and keeps it consistent across weight changes. Product rules: docs EARN_UX B/D, same UX as official funds.
 */
const E18 = 10n ** 18n, E16 = 10n ** 16n;
const account = T.roles.keeper.toLowerCase() as Address;
const markets = strategyMarkets();
const bySymbol = (s: string) => { const m = markets.find(x => x.symbol === s); assert.ok(m, s); return m; };
const nvda = bySymbol('NVDAB'), wbnb = bySymbol('WBNB'), tsla = bySymbol('TSLAB'), aapl = bySymbol('AAPLB');
const tqqq = T.assets.TQQQB.token.toLowerCase();
const status = (patch: Partial<StatusReading> = {}): StatusReading => ({ gate: 0, shouldDeleverage: false, shouldUnwind: false,
  borrowRate: 250n * E16 / 100n, collateralRate: 0n, vaultRate: 450n * E16 / 100n, collateralIncentiveRate: 0n, borrowIncentiveRate: 0n,
  vaultIncentiveRate: 0n, borrowUtilizationBps: 0n, vaultUtilizationBps: 0n, ltv: 0n, targetLtv: 30n * E16, deleverageLtv: 40n * E16,
  liquidationLtv: 60n * E16, debt: 0n, vaultAssets: 0n, health: { collateralValue: 0n, liquidationValue: 0n, debtValue: 0n, healthFactor: maxUint256 }, ...patch });
type Policy = { maxDebt: bigint; enabled: boolean; strategyId?: bigint; version?: number };
type Fake = { ids?: Hex[]; collateral?: Record<string, bigint>; balances?: Record<string, bigint>; statuses?: Record<string, StatusReading>;
  policies?: Record<string, Policy>; enrollment?: { strategyId: bigint; version: number } };
function chainOf(f: Fake, reads: string[] = []): StrategyEarnChain {
  return {
    head: async () => ({ number: 9n, timestamp: 1_795_400_000n }),
    status: async id => { reads.push('status'); return f.statuses?.[id] ?? status(); },
    accountMarkets: async () => { reads.push('accountMarkets'); return f.ids ?? []; },
    collateral: async id => { reads.push('collateral'); return f.collateral?.[id] ?? 0n; },
    balance: async token => { reads.push('balance'); return f.balances?.[token.toLowerCase()] ?? 0n; },
    price: async () => { reads.push('price'); return 10n ** 8n; },
    rewards: async () => ({ vault: 0n, collateral: 0n }),
    policy: async (_a, id) => { reads.push('policy'); return f.policies?.[id] ?? { maxDebt: 0n, enabled: false, strategyId: 0n, version: 0 }; },
    enrollment: async () => { reads.push('enrollment'); return f.enrollment ?? { strategyId: 12n, version: 1 }; },
    weights: async () => [],
  };
}
const decode = (data: Hex) => decodeFunctionData({ abi: STRATEGY_EARN_ABI, data });
const current = (maxDebt: bigint): Policy => ({ maxDebt, enabled: true, strategyId: 12n, version: 1 });
const stale = (maxDebt: bigint): Policy => ({ maxDebt, enabled: true, strategyId: 11n, version: 1 });

test('mix flows: yield strategy transfers stay inside the mix; owner deposits and withdrawals are still booked', () => {
  const m = { id: '5', owner: '0x' + '0a'.repeat(20) as Address, account };
  for (const contract of [S.executor, S.earnVault, S.listaMoolah, S.vUSDT, nvda.collateralVToken as string]) {
    assert.equal(mixFlowDirection(account, contract, m), null, `post / repay to ${contract}`);
    assert.equal(mixFlowDirection(contract, account, m), null, `shares back / vault / incentive from ${contract}`);
  }
  assert.equal(mixFlowDirection(m.owner, account, m), 'deposit');
  assert.equal(mixFlowDirection(account, m.owner, m), 'withdrawal');
  assert.equal(mixFlowDirection(account, T.contracts.executor, m), null, 'AtpExecutor stays internal');
});

// ---- weight change: consent re-signed with the enroll ---------------------------------------------------------

const enrollCalls = mixOwnerCalls({ account, registry: T.contracts.registry, executor: T.contracts.executor, onchainId: 13n,
  previousAssets: [nvda.collateral, T.contracts.usdt], assets: [nvda.collateral, aapl.collateral, T.contracts.usdt], allowances: new Map([[aapl.collateral, 0n]]) });
const tail = consentCalls([{ market: nvda, maxDebtRaw: 100n * E18 }, { market: aapl, maxDebtRaw: 50n * E18 }]);
const asActual = (calls: readonly { to: string; data: string }[]) => calls.map(c => ({ target: c.to as Address, value: 0n, callData: c.data as Hex }));
const check = (stored: readonly { to: string; data: string; value: '0' }[], selected: string[] = [nvda.collateral, aapl.collateral]) => assertMixOwnerCalls({
  account, onchainId: 13n, previousAssets: [nvda.collateral, T.contracts.usdt], selectedAssets: selected,
  stored: stored as never, calls: asActual(stored), nonce: MIX_SUDO_NONCE_KEY << 64n });

test('mix owner calls: approval+enroll, then the yield strategy consent for the new weights (re-pinned by the enroll)', () => {
  check(enrollCalls);
  check([...enrollCalls, ...tail]);
  // Consent only for a Venus market: no Lista grant needed, and vice versa.
  check([...enrollCalls, ...consentCalls([{ market: nvda, maxDebtRaw: 1n }])]);
  const reject = (calls: readonly { to: string; data: string; value: '0' }[], selected?: string[], why = '') => assert.throws(() => check(calls, selected), /待確認/, why);
  reject([...tail, ...enrollCalls], undefined, 'consent before the enroll would be voided by it');
  reject([...enrollCalls, ...tail], [nvda.collateral], 'ceiling for an asset the owner did not pick');
  const approve = (token: string, spender: string) => ({ to: token as Address, value: '0' as const, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender as Address, maxUint256] }) });
  const policy = (id: Hex, maxDebt: bigint, enabled: boolean) => ({ to: S.registry as Address, value: '0' as const,
    data: encodeFunctionData({ abi: STRATEGY_EARN_ABI, functionName: 'setBorrowPolicy', args: [id, maxDebt, enabled] }) });
  reject([...enrollCalls, ...tail, approve(S.earnVault, T.contracts.executor)], undefined, 'strategy vault shares to AtpExecutor');
  reject([...enrollCalls, ...tail.map(c => c.to === S.earnVault ? approve(S.earnVault, T.contracts.executor) : c)], undefined, 'vault approval swapped to AtpExecutor');
  reject([...enrollCalls, ...tail, approve(T.contracts.usdt, S.executor)], undefined, 'duplicate approval');
  reject([...enrollCalls, ...tail.filter(c => !(c.to.toLowerCase() === T.contracts.usdt))], undefined, 'missing USDT approval (repay needs it)');
  reject([...enrollCalls, ...tail.filter(c => !(c.to.toLowerCase() === aapl.collateral))], undefined, 'ceiling without its collateral approval');
  reject([...enrollCalls, ...tail.filter(c => c.to !== S.listaMoolah)], undefined, 'Lista ceiling without the Lista grant');
  reject([...enrollCalls, ...tail.map(c => c.to === S.registry && decode(c.data as Hex).args[0] === aapl.marketId ? policy(aapl.marketId, 0n, true) : c)], undefined, 'zero ceiling');
  reject([...enrollCalls, ...tail.map(c => c.to === S.registry && decode(c.data as Hex).args[0] === aapl.marketId ? policy(aapl.marketId, 1n, false) : c)], undefined, 'disabled consent');
  reject([...enrollCalls, ...tail, approve(tqqq, S.executor)], [nvda.collateral, aapl.collateral, tqqq], 'leveraged products are never eligible');
  reject([...enrollCalls, { to: S.executor as Address, value: '0', data: encodeFunctionData({ abi: STRATEGY_EARN_ABI, functionName: 'executeBorrow', args: [account, nvda.marketId, 1n, 1n] }) }],
    undefined, 'no borrowing inside the owner change');
});

test('mix weight change: strategy on -> consent for every eligible asset in the new weights; off, voided or removed-only -> none', async () => {
  const assets = [{ address: nvda.collateral, weightBps: 4000 }, { address: aapl.collateral, weightBps: 4000 }, { address: tqqq, weightBps: 2000 },
    { address: T.contracts.usdt, weightBps: 0 }];
  const input = { account, previousAssets: [nvda.collateral, tsla.collateral, T.contracts.usdt], assets, totalValueUsd: 1000n * E18 };
  // Off: nothing posted, no current consent.
  assert.deepEqual(await mixStrategyConsentCalls(input, chainOf({})), []);
  // Consent from before an earlier weight change is void on chain: still off.
  assert.deepEqual(await mixStrategyConsentCalls(input, chainOf({ policies: { [nvda.marketId]: stale(10n * E18) } })), []);
  // On (shares posted for TSLAB, which this change removes): NVDAB stays and AAPLB is new -> both get a ceiling; TSLAB
  // (removed, sold later after repaying) and TQQQB (leveraged) get none. 400 USD x 30% x 98% x 110% = 129.36 USDT each.
  const posted = await mixStrategyConsentCalls(input, chainOf({ ids: [tsla.marketId], collateral: { [tsla.marketId]: E18 } }));
  const policies = posted.filter(c => c.to === S.registry).map(c => decode(c.data).args);
  assert.deepEqual(policies, [[nvda.marketId, 12936n * E16, true], [aapl.marketId, 12936n * E16, true]]);
  assert.deepEqual(posted.map(c => [c.to.toLowerCase(), decode(c.data).functionName]), [[S.venusComptroller, 'updateDelegate'], [S.listaMoolah, 'setAuthorization'],
    [S.registry, 'setBorrowPolicy'], [nvda.collateral, 'approve'], [S.registry, 'setBorrowPolicy'], [aapl.collateral, 'approve'],
    [T.contracts.usdt.toLowerCase(), 'approve'], [S.earnVault, 'approve']]);
  assert.ok(posted.every(c => !c.data.toLowerCase().includes(T.contracts.executor.slice(2).toLowerCase())), 'never AtpExecutor');
  // On (consent waiting for a fill, under the current enrollment) -> same; a closed gate skips that market (EARN_UX D).
  const armed = await mixStrategyConsentCalls(input, chainOf({ policies: { [tsla.marketId]: current(5n * E18) }, statuses: { [aapl.marketId]: status({ gate: 4 }) } }));
  assert.deepEqual(armed.filter(c => c.to === S.registry).map(c => decode(c.data).args[0]), [nvda.marketId]);
  // The consent the mix change carries passes the sponsor's tail check.
  const stored = [...enrollCalls, ...posted];
  check(stored);
  // A chain read failure propagates (the mix service answers 503 and nothing is published).
  await assert.rejects(mixStrategyConsentCalls(input, { ...chainOf({}), accountMarkets: async () => { throw new Error('rpc'); } }), /rpc/);
});

// ---- scheduler step: only current consent, only held collateral ----------------------------------------------

test('auto-open reads only the collateral the mix holds and ignores consent voided by a weight change', async () => {
  const send = async () => ({ hash: ('0x' + '02'.repeat(32)) as Hex, blockNumber: 1n, logs: [] });
  const args = (f: Fake, reads: string[], held?: string[]) => ({ chain: chainOf(f, reads), account, portfolioId: 3, now: mixClock, dryRun: false, send,
    ledger: { record: async () => {} }, log: () => {}, ...(held === undefined ? {} : { held }) });
  const f: Fake = { policies: { [nvda.marketId]: stale(100n * E18) }, balances: { [nvda.collateral]: 10n * E18 } };
  let reads: string[] = [];
  assert.equal(await strategyEarnAutoOpen(args(f, reads, [nvda.collateral, wbnb.collateral, T.contracts.usdt])), null, 'stale consent: nothing to open');
  assert.deepEqual(reads, ['policy', 'policy', 'enrollment'], 'two held eligible assets -> two policy reads, not one per market');
  reads = [];
  assert.equal(await strategyEarnAutoOpen(args(f, reads, [T.contracts.usdt])), null);
  assert.deepEqual(reads, [], 'only USDT held: no chain read at all');
  reads = [];
  const note = await strategyEarnAutoOpen(args({ ...f, policies: { [nvda.marketId]: current(100n * E18) } }, reads, [nvda.collateral]));
  assert.match(note ?? '', /^\[STRATEGY_EARN_OPEN\] 已自動開啟：NVDAB 10／借 2\.94 USDT 存 vault/);
  // consentedMarkets: enabled + ceiling + same enrollment only.
  const c = await consentedMarkets(chainOf({ policies: { [nvda.marketId]: current(1n), [aapl.marketId]: stale(1n), [tsla.marketId]: { ...current(0n) } } }), account, 9n, markets);
  assert.deepEqual([...c.keys()], [nvda.marketId]);
});

// ---- scheduler wiring for a mix -------------------------------------------------------------------------------

function mixScheduler(patch: (state: ReturnType<typeof mixRuntimeFixture>['state']) => void = () => {}) {
  const { state, plan } = mixRuntimeFixture();
  state.takeProfit = null; state.stopLoss = null;
  patch(state);
  const calls: string[] = [];
  const query: SchedulerQueryFn = async sql => {
    if (sql.includes("to_regclass('mixes')")) return { rows: [{ ready: true }] };
    if (sql.includes('for update of p skip locked')) return { rows: [{ personal_mix: true, portfolio_id: '1', strategy_id: '1', address: plan.account, account_type: 'KERNEL',
      schedule: { kind: 'funding' }, execution_schema_version: 2, execution: { kind: 'per_asset' }, version: 1, schedule_state: 'active' }] };
    return { rows: [] };
  };
  const deps: SchedulerDeps = { query, chainId: 97, executor: T.contracts.executor, withTransaction: work => work({ query }),
    withMixPortfolioLock: async (_id, work) => work(), withDexLock: async (_c, work) => work(), dexGate: async () => null, readGlobalPaused: async () => false,
    log: () => {}, yieldRound: async () => ({ checked: 0, blocked: 0 }), strategyEarnRound: async () => null, planPortfolio: async () => plan,
    mixRuntime: async () => state, reconcileMix: async () => false, cacheMix: async () => {}, mixExitMinimum: async () => false, mixExitFailure: async () => {},
    prepareMixTick: async () => {}, planRebalance: async () => ({ kind: 'blocked', reason: '[FIXTURE_STOP] stop before sending' }),
    executeRebalance: async () => { throw new Error('unexpected send'); },
    strategyEarn: { open: async (_d, dry, held) => { calls.push(`open:${dry}:${(held ?? []).length}`); return null; },
      unwind: async (_d, s, dry) => { calls.push(`unwind:${dry}:${s.length}`); return '[STRATEGY_EARN_UNWINDING] fixture'; } } };
  return { deps, calls, plan, state };
}

test('scheduler: a mix waiting for its next rebalance posts consented shares like a fund\'s quiet round; exiting / pending mixes never do', async () => {
  const quiet = mixScheduler();
  const r = await runSchedulerOnce({ dryRun: false, now: mixClock, skipAlerts: true }, quiet.deps);
  assert.equal(r.results[0]?.outcome, 'noop');
  assert.deepEqual(quiet.calls, ['open:false:2'], 'NVDAB + WBNB held, USDT at 0');
  for (const patch of [(s: { triggered: boolean }) => { s.triggered = true; }, (s: { pending: boolean }) => { s.pending = true; },
    (s: { status: string }) => { s.status = 'exited'; }] as ((s: never) => void)[]) {
    const busy = mixScheduler(patch as never);
    await runSchedulerOnce({ dryRun: false, now: mixClock, skipAlerts: true }, busy.deps);
    assert.equal(busy.calls.some(c => c.startsWith('open')), false);
  }
});

test('scheduler: a mix sale (rebalance or take-profit exit) with posted shares repays and takes them back first', async () => {
  const f = mixScheduler(s => { s.last = null; });
  const nvdaToken = T.assets.NVDAB.token as Address;
  f.plan.snapshot.strategyEarnCollateral = [{ asset: nvdaToken.toLowerCase() as Address, marketId: nvda.marketId, amount: E18 }];
  const h = f.plan.snapshot.holdings.find(x => x.asset === nvdaToken); assert.ok(h); h.amountWei *= 2n;
  f.deps.planRebalance = async () => ({ kind: 'ready', deadline: 2_000_000_000n, rationale: 'fixture', steps: [{ tokenIn: nvdaToken, tokenOut: T.contracts.usdt as Address,
    amountIn: E18, amountOutMin: 1n, oracleFloor: 1n, venue: T.contracts.executor as Address, data: '0x' as Hex }] });
  const at = new Date('2026-11-23T15:30:00Z'); // US market hours
  const r = await runSchedulerOnce({ dryRun: true, now: at, skipAlerts: true }, f.deps);
  assert.equal(r.results[0]?.reason, '[STRATEGY_EARN_UNWINDING] fixture');
  assert.deepEqual(f.calls, ['unwind:true:1']);
  const exit = mixScheduler(s => { s.takeProfit = 1000; });
  exit.plan.snapshot.strategyEarnCollateral = f.plan.snapshot.strategyEarnCollateral;
  exit.deps.planRebalance = f.deps.planRebalance;
  const e = await runSchedulerOnce({ dryRun: true, now: at, skipAlerts: true }, exit.deps);
  assert.equal(e.results[0]?.reason, '[STRATEGY_EARN_UNWINDING] fixture');
  assert.deepEqual(exit.calls, ['unwind:true:1'], 'exit never auto-opens');
});

test('scheduler: a failed auto-open backs off instead of failing again every round; the log says when it retries', async () => {
  const s = mixScheduler(), lines: string[] = [];
  let attempts = 0;
  s.deps.log = l => { lines.push(l); };
  s.deps.strategyEarn = { ...s.deps.strategyEarn!, open: async () => { attempts++; throw new Error('paymaster sponsorship rejected: PAYMASTER_USER_OP_CAPACITY'); } };
  for (let round = 0; round < 3; round++) await runSchedulerOnce({ dryRun: false, now: mixClock, skipAlerts: true }, s.deps);
  assert.equal(attempts, 1, 'rounds 2 and 3 fall inside the 5-minute delay: not attempted, nothing logged');
  assert.deepEqual(lines.filter(l => l.includes('STRATEGY_EARN_OPEN_FAILED')), ['[scheduler] portfolio 1 [STRATEGY_EARN_OPEN_FAILED] 自動開啟未完成，5 分鐘後再試：paymaster sponsorship rejected: PAYMASTER_USER_OP_CAPACITY']);
  // Cleared (here by the per-test reset; in production by the delay passing): the next attempt runs, and a success removes the delay.
  resetStrategyEarnOpenBackoff();
  s.deps.strategyEarn = { ...s.deps.strategyEarn!, open: async () => { attempts++; return null; } };
  for (let round = 0; round < 2; round++) await runSchedulerOnce({ dryRun: false, now: mixClock, skipAlerts: true }, s.deps);
  assert.equal(attempts, 3);
});
