import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData, maxUint256 } from 'viem';
import type { Address, Hex } from 'viem';
import { planAccount } from '../src/strategy-earn-routing.js';
import { createStrategyEarnV2Api } from '../src/strategy-earn-v2-api.js';
import { createV2Reader, v2PublicRpcs } from '../src/strategy-earn-v2-chain.js';
import { fromMainnetRates, fromTestnetMocks, reportCalldata, reportDue, runRateReport } from '../src/strategy-earn-v2-rates.js';
import { runV2KeeperRound, v2AutoRound, v2RewardHolders, v2UnwindForSale } from '../src/strategy-earn-v2-scheduler.js';
import type { V2Ledger, V2Tx } from '../src/strategy-earn-v2-scheduler.js';
import { loanTokenNeeds, planLoanTokenSwaps } from '../src/strategy-earn-v2-swap.js';
import { boxRewardSignature, V2_EXECUTOR_ABI, V2_REGISTRY_ABI } from '../src/strategy-earn-v2.js';
import type { Call, RouteEvent } from '../src/strategy-earn-v2.js';
import type { RewardEvent } from '../src/strategy-rewards.js';
import { E18, W, WORLD_NOW as NOW, world } from './fixtures/v2-world.js';

const fn = (c: Call) => c.to === W.v2.executor ? decodeFunctionData({ abi: V2_EXECUTOR_ABI, data: c.data }).functionName : c.to === W.v2.registry ? decodeFunctionData({ abi: V2_REGISTRY_ABI, data: c.data }).functionName : `approve:${c.to}`;
const argsOf = (c: Call) => decodeFunctionData({ abi: V2_EXECUTOR_ABI, data: c.data }).args as readonly unknown[];
const USDT = W.v2.loanTokens.USDT!, USDC = W.v2.loanTokens.USDC!;
/** A consenting account with `nvda` NVDAB free. */
function consenting(w: ReturnType<typeof world>, nvda = 10n * E18) {
  w.state.policy = { maxDebt: 10_000n * E18, rewardRecipient: W.owner, strategyId: 57n, enabled: true };
  w.setBalance(W.NVDA, W.account, nvda);
}
/** An open NVDAB position on Venus/USDT with its money in Aave. */
function openVenus(w: ReturnType<typeof world>, o: { debt?: bigint; vault?: bigint; since?: number } = {}) {
  consenting(w, 0n);
  const debt = o.debt ?? 441n * E18;
  w.state.positions.set(w.ids.nvdaVenusUsdt, { collateral: 10n * E18, collateralValue: 1500n * E18, debt, routeDebt: debt, principal: debt, openedAt: o.since ?? 1_795_000_000, ltvBps: 2940 });
  w.state.holdings.set(w.ids.aaveUsdt, { assets: o.vault ?? debt + E18, since: o.since ?? 1_795_000_000 });
  w.state.principalUsd = debt;
}
function ledger() { const routes: RouteEvent[] = [], rewards: RewardEvent[] = []; const l: V2Ledger = { routes: async (_c, e) => { routes.push(...e); }, rewards: async (_c, e) => { rewards.push(...e); } }; return { l, routes, rewards }; }
const tx = (n: number): V2Tx => ({ hash: ('0x' + String(n).padStart(64, '0')) as Hex, blockNumber: 1n, logs: [] });

test('reader: routes and vaults are discovered from the registry; rates, limits and gates come from the lens in one bulk read', async () => {
  const w = world(), reader = createV2Reader({ ...w.readerDeps, bookTtlMs: 600_000 });
  const book = await reader.book();
  assert.deepEqual([book.routes.map(r => `${r.symbol}/${r.venue}/${r.loanSymbol}`), book.vaults.map(v => `${v.venue}/${v.tokenSymbol}`)],
    [['QQQB/lista/USDC', 'NVDAB/venus/USDT', 'NVDAB/venus/USDC', 'NVDAB/lista/USDT'], ['lista/USDC', 'venus/USDT', 'aave/USDT', 'venus/USDC']]);
  const before = w.state.requests;
  const m = await reader.market();
  assert.equal(w.state.requests - before, 1, 'the whole market is one multicall (the route and vault list is cached)');
  const qqq = m.snapshot.options.QQQB![0]!;
  // QQQB on Lista: borrow 2.20% − 0.50% incentive, into the USDC vault (4.00% + 0.50%); carry 2.80% × 35% + 1.00% collateral incentive.
  assert.deepEqual([qqq.venue, qqq.loan, qqq.marketId, qqq.borrowApyBps, qqq.incentiveBps, qqq.ratioBps, qqq.factorBps, qqq.vault.venue, qqq.vault.apyBps, qqq.carryBps, qqq.extraBps, qqq.liquidityUsd],
    ['lista', 'USDC', W.listaQqqUsdc, 220, 50, 3500, 7500, 'lista', 450, 280, 198, 100_000]);
  // Venus routes carry the loan vToken as the engine's market id.
  assert.deepEqual(m.snapshot.options.NVDAB!.map(o => [o.venue, o.loan, o.marketId]), [['venus', 'USDT', W.vUSDT], ['venus', 'USDC', W.vUSDC], ['lista', 'USDT', W.listaNvdaUsdt]]);
  assert.deepEqual(m.limits(w.ids.nvdaListaUsdt), { minLoanRaw: 15n * E18, minDebtRaw: 15_150_000_000_000_000_000n });
  assert.deepEqual(m.limits(w.ids.nvdaVenusUsdt), { minLoanRaw: 0n, minDebtRaw: 0n });
  assert.deepEqual([m.lookup.route(w.ids.nvdaVenusUsdt), m.lookup.vault(w.ids.aaveUsdt), m.lookup.route(('0x' + '99'.repeat(32)) as Hex)], [{ asset: 'NVDAB', venue: 'venus', loan: 'USDT' }, { venue: 'aave' }, null]);
  // Every source is the chain, read now.
  assert.deepEqual(Object.values(m.snapshot.sourceAt).every(at => at === m.at), true);
});

test('route discovery: a vault that takes no deposit and a Venus market at its supply cap are never chosen for new money, but stay priced for who is already there', async () => {
  const w = world();
  // The USDC Lista vault's supply queue is empty (maxDeposit 0), as the Gauntlet USDT vault on mainnet.
  w.state.vaults.get(w.ids.listaUsdc)!.maxDeposit = 0n;
  // vNVDAB: cap 1,500, 1,499.2 supplied (mainnet 2026-11-24) -> 0.8 NVDAB of room = $120.
  w.state.supplyCaps.set(W.vNVDA, { cap: 1500n * E18, supply: 14992n * 10n ** 7n, rate: 10n ** 28n });
  const m = await createV2Reader(w.readerDeps).market();
  const usdcVault = m.snapshot.vaults.find(v => v.venue === 'lista' && v.token === 'USDC')!;
  assert.deepEqual([usdcVault.eligible, usdcVault.apyBps], [false, 450]); // still priced
  // QQQB's only route borrows USDC: the vault it is offered is the next best one that takes deposits (Venus vUSDC, 0%).
  assert.deepEqual([m.snapshot.options.QQQB![0]!.vault.venue, m.snapshot.options.QQQB![0]!.carryBps], ['venus', -170]);
  const venus = m.snapshot.options.NVDAB!.filter(o => o.venue === 'venus');
  assert.ok(venus.every(o => Math.abs(o.collateralRoomUsd! - 120) < 1e-6), JSON.stringify(venus.map(o => o.collateralRoomUsd)));
  assert.equal(m.snapshot.options.NVDAB!.find(o => o.venue === 'lista')!.collateralRoomUsd, undefined);
  // Engine: $1,500 of NVDAB does not fit under the Venus cap -> Lista; $100 fits -> Venus/USDT (Aave vault) pays more.
  const plan = (collateralUsd: number) => planAccount({ snapshot: m.snapshot, holdings: [{ symbol: 'NVDAB', collateralUsd, enabled: true, position: null }], costs: { gasUsdPerTx: 0.05 }, now: m.at }).decisions[0]!;
  // (Lista NVDAB/USDT pays no incentive in this world: Venus 4.20% − 2.50% = Lista. Make Lista clearly worse to see the cap decide.)
  w.state.routes.get(w.ids.nvdaListaUsdt)!.status.borrowBps = 400;
  const m2 = await createV2Reader(w.readerDeps).market();
  const plan2 = (collateralUsd: number) => planAccount({ snapshot: m2.snapshot, holdings: [{ symbol: 'NVDAB', collateralUsd, enabled: true, position: null }], costs: { gasUsdPerTx: 0.05 }, now: m2.at }).decisions[0]!;
  assert.deepEqual([plan2(100).to?.venue, plan2(1500).to?.venue], ['venus', 'lista']);
  void plan;
  // A holding already posted on that Venus market is inside the cap: its position is not pushed out by it.
  const held = planAccount({ snapshot: m2.snapshot, costs: { gasUsdPerTx: 0.05 }, now: m2.at, holdings: [{ symbol: 'NVDAB', collateralUsd: 1500, enabled: true,
    position: { route: { venue: 'venus', marketId: W.vUSDT, loan: 'USDT', vault: { venue: 'aave', address: W.aavePool } }, debtUsd: 441, since: m2.at - 86_400_000, postedUsd: 1500 } }] }).decisions[0]!;
  assert.deepEqual([held.action, held.reason], ['hold', 'best_route']);
});

test('route discovery: a route closed for new borrowing lends nothing but its positions are held, a retired route is gone, a vault above its exit line reads as unable to pay', async () => {
  const w = world();
  w.state.routes.get(w.ids.nvdaVenusUsdt)!.status.open = false; // registry pause / disabled: admission only
  w.state.routes.get(w.ids.nvdaListaUsdt)!.retired = true;
  w.state.vaults.get(w.ids.aaveUsdt)!.status.shouldExit = true;
  w.state.vaults.get(w.ids.venusUsdc)!.status.utilizationBps = 9_100; // above 90%: no new deposits
  const m = await createV2Reader(w.readerDeps).market();
  assert.deepEqual(m.snapshot.options.NVDAB!.map(o => [o.venue, o.loan, o.liquidityUsd]), [['venus', 'USDT', 0], ['venus', 'USDC', 100_000]]);
  assert.deepEqual(m.snapshot.vaults.map(v => [v.venue, v.token, v.eligible, v.liquidityUsd]), [['lista', 'USDC', true, undefined], ['venus', 'USDT', true, 500_000], ['aave', 'USDT', true, 0], ['venus', 'USDC', false, 500_000]]);
  const position = { route: { venue: 'venus' as const, marketId: W.vUSDT, loan: 'USDT' as const, vault: { venue: 'venus' as const, address: W.vUSDT } }, debtUsd: 441, since: m.at - 86_400_000 };
  // Paused for new borrowing: the position stays (no forced exit, no top-up); it is not offered to a new holding.
  w.state.vaults.get(w.ids.venusUsdt)!.status.supplyBps = 300;
  const m2 = await createV2Reader(w.readerDeps).market();
  const d = planAccount({ snapshot: m2.snapshot, costs: { gasUsdPerTx: 0.05 }, now: m2.at, holdings: [{ symbol: 'NVDAB', collateralUsd: 3000, enabled: true, position }] }).decisions[0]!;
  assert.deepEqual([d.action, d.targetDebtUsd], ['hold', 441]);
});

test('account read: positions, the box (vault holdings + idle), cash, consent pinned to the enrollment — and the net value counts idle money', async () => {
  const w = world(), reader = createV2Reader(w.readerDeps);
  openVenus(w, { debt: 441n * E18, vault: 440n * E18 });
  w.state.idle.set(USDT, 3n * E18);
  w.setBalance(USDT, W.account, 7n * E18);
  w.setBalance(W.NVDA, W.account, 2n * E18);
  const read = await reader.account(W.account, [W.NVDA, W.QQQ]);
  assert.deepEqual([read.consent, read.box, read.routes.length, read.vaults.length], [true, W.box, 1, 1]);
  const h = read.state.holdings.find(x => x.symbol === 'NVDAB')!;
  assert.deepEqual([h.freeCollateralRaw, h.postedRaw, h.routeDebtRaw, h.vaultAssetsRaw, h.idleRaw, h.cashRaw, h.collateralUsd], [2n * E18, 10n * E18, 441n * E18, 440n * E18, 3n * E18, 7n * E18, 1800]);
  assert.deepEqual([h.position!.route, h.position!.debtUsd, h.position!.postedUsd], [{ venue: 'venus', marketId: W.vUSDT, loan: 'USDT', vault: { venue: 'aave', address: W.aavePool } }, 441, 1500]);
  // draft4: net value of the strategy money = vault holdings + idle in the box − debt (440 + 3 − 441).
  assert.equal(read.earnNetUsd, 2n * E18);
  // QQQB is eligible but not held: no holding row is needed for it to stay out of the plan.
  assert.equal(read.state.holdings.find(x => x.symbol === 'QQQB')!.collateralUsd, 0);
  // Consent given under another strategy id (a My mix weight change re-enrolled the account) is void; so is a paused enrollment.
  w.state.enrollment = [58n, 1, false];
  assert.equal((await reader.account(W.account)).consent, false);
  w.state.enrollment = [57n, 1, true];
  assert.equal((await reader.account(W.account)).state.enabled, false);
});

test('review round 3: with only interest left in a token, lens.routeDebt answers the whole debt on every Venus route of it — the shares are capped so the account\'s debt is counted once', async () => {
  const w = world(), reader = createV2Reader(w.readerDeps);
  consenting(w, 0n);
  // Same collateral, two Venus routes in USDT... the lens reports the token's whole debt (0.205 USDT of interest) as each route's share.
  const dust = 205n * 10n ** 15n;
  w.state.routes.set(('0x' + 'c1'.repeat(32)) as Hex, { ...w.state.routes.get(w.ids.nvdaVenusUsdt)!, collateral: W.QQQ });
  w.state.positions.set(w.ids.nvdaVenusUsdt, { collateral: 10n * E18, collateralValue: 1500n * E18, debt: dust, routeDebt: dust, principal: 0n, openedAt: 0 });
  w.state.positions.set(('0x' + 'c1'.repeat(32)) as Hex, { collateral: E18, collateralValue: 500n * E18, debt: dust, routeDebt: dust, principal: 0n, openedAt: 0 });
  w.state.holdings.set(w.ids.aaveUsdt, { assets: E18, since: 1 });
  const read = await reader.account(W.account);
  assert.deepEqual(read.routes.map(r => r.routeDebtRaw), [dust, 0n]);
  assert.equal(read.routes.reduce((s, r) => s + r.routeDebtRaw, 0n), dust);
  assert.equal(read.earnNetUsd, E18 - dust); // one vault holding minus the debt once
  assert.deepEqual(read.state.holdings.filter(h => h.position).map(h => h.position!.debtUsd), [0.205, 0]);
  // The swap planner counts the token's debt once too.
  assert.deepEqual(loanTokenNeeds(read, USDC), []);
});

test('draft5 ForeignDebt: a token owed on Venus without a v2 Venus position in it is reported; with one (even repaid to interest only) it is not', async () => {
  const w = world(), reader = createV2Reader(w.readerDeps);
  consenting(w);
  w.state.venusOwed.set(W.vUSDT, 50n * E18);
  assert.deepEqual((await reader.account(W.account, [W.NVDA])).state.foreignVenusLoans, ['USDT']);
  w.state.positions.set(w.ids.nvdaVenusUsdt, { collateral: 10n * E18, collateralValue: 1500n * E18, debt: 50n * E18, routeDebt: 50n * E18, principal: 0n, openedAt: 0 });
  assert.equal((await reader.account(W.account, [W.NVDA])).state.foreignVenusLoans, undefined);
});

test('API auto / open / close: one account-level consent to the configured v2 contracts, an open on today\'s best route, an exit cut into UserOps', async () => {
  const w = world(), reader = createV2Reader(w.readerDeps);
  const api = createStrategyEarnV2Api({ v2: W.v2, reader, now: () => NOW, estimateGas: async () => 700_000n });
  w.setBalance(W.NVDA, W.account, 10n * E18);
  assert.equal(await api.active(W.account), false);
  // Buy confirmation: 1,000 USDT into a 60/40 NVDAB/QQQB portfolio that already holds 10 NVDAB ($1,500).
  const auto = await api.auto(W.account, W.owner, { budgetRaw: 1_000n * E18, weights: [{ asset: W.NVDA, weightBps: 6000 }, { asset: W.QQQ, weightBps: 4000 }], keyReady: false });
  assert.equal(auto.status, 'ready');
  if (auto.status !== 'ready') return;
  assert.deepEqual([auto.authorization, auto.version, auto.assets.map(a => [a.asset, a.status])], ['renewal_required', 2, [['NVDAB', 'ready'], ['QQQB', 'ready']]]);
  // Delegations for both venues, ONE setStrategyPolicy, approvals to the v2 executor for the collateral, the loan tokens and the reward token.
  assert.deepEqual(auto.calls.map(c => c.to), [W.v2.venusComptroller, W.v2.moolah, W.v2.registry, W.QQQ, W.NVDA, USDT, USDC, W.v2.rewardTokens[0]]);
  const policy = decodeFunctionData({ abi: V2_REGISTRY_ABI, data: auto.calls[2]!.data }).args as readonly [bigint, Address, boolean];
  // NVDAB (1,500 + 600) × 30% + QQQB 400 × 35% = 770, +10%.
  assert.deepEqual([policy[0], policy[1], policy[2]], [847n * E18, W.owner, true]);
  // The owner opens NVDAB now (the app sends one asset per UserOp): consent + one executeOpen with 98% of the target.
  const open = await api.open(W.account, W.owner, { symbol: 'NVDAB', collateralRaw: 10n * E18, weights: [{ asset: W.NVDA, weightBps: 10_000 }], keyReady: true });
  assert.equal(open.status, 'ready');
  if (open.status !== 'ready') return;
  assert.deepEqual([open.calls.slice(-1).map(fn), open.authorization, open.borrowRaw], [['executeOpen'], 'ready', (441n * E18).toString()]);
  assert.deepEqual(argsOf(open.calls.at(-1)!).slice(0, 5), [W.account, w.ids.nvdaVenusUsdt, w.ids.aaveUsdt, 10n * E18, 441n * E18]);
  assert.deepEqual(await api.open(W.account, W.owner, { symbol: 'NVDAB', collateralRaw: 11n * E18, weights: [], keyReady: true }), { status: 'insufficient', asset: 'NVDAB' });
  assert.equal((await api.open(W.account, W.owner, { symbol: 'TQQQB', collateralRaw: 1n, weights: [], keyReady: true })).status, 'unavailable');

  // With the position open: the view, then turning everything off.
  openVenus(w, { debt: 441n * E18, vault: 443n * E18 });
  w.state.holdings.set(w.ids.venusUsdt, { assets: 5n * E18, since: 1 }); // a second USDT vault still holds a little
  w.setBalance(W.v2.rewardTokens[0]!, W.box, 3n * E18); w.setBalance(W.v2.rewardTokens[0]!, W.account, 2n * E18);
  w.state.allowances.set(`${W.v2.rewardTokens[0]}:${W.account}`, maxUint256);
  assert.equal(await api.active(W.account), true);
  const view = await api.portfolio(9, W.account);
  assert.deepEqual([view.version, view.positions.length, view.positions[0]!.asset, view.positions[0]!.route.source, view.positions[0]!.route.venue, view.positions[0]!.route.vault?.venue, view.autoOpen],
    [2, 1, 'NVDAB', 'onchain', 'venus', 'aave', false]);
  assert.equal(view.earnNetUsd, (443n * E18 + 5n * E18 - 441n * E18).toString());
  // Turn off: a plain close keeps the rewards in the account; `exit` sends box + account balance to the owner's wallet.
  const off = await api.close(W.account, { symbols: ['NVDAB'] });
  assert.deepEqual(off.status === 'ready' && off.batches.map(b => b.map(fn)), [['executeReduce', 'executeRelease', 'setStrategyPolicy']]);
  if (off.status === 'ready') assert.deepEqual(argsOf(off.calls[1]!).slice(0, 2), [W.account, w.ids.venusUsdt]); // the vault the close does not name
  const exit = await api.close(W.account, { symbols: ['NVDAB'], exit: true });
  // Three executor calls per UserOp; withdrawing the consent rides in the last one.
  assert.deepEqual(exit.status === 'ready' && exit.batches.map(b => b.map(fn)), [['executeReduce', 'executeRelease', 'executeSweepRewards', 'setStrategyPolicy']]);
  if (exit.status === 'ready') assert.deepEqual(argsOf(exit.calls[2]!).slice(1, 3), [W.v2.rewardTokens[0], maxUint256]);
  // Rescue is refused while the vault's token is owed, and offered (owner only) once it is not.
  assert.deepEqual(await api.rescue(W.account, w.ids.aaveUsdt), { status: 'unavailable', reason: 'debt_outstanding', message: 'Temporarily unavailable.' });
  w.state.positions.clear();
  const rescue = await api.rescue(W.account, w.ids.aaveUsdt);
  assert.deepEqual(rescue.status === 'ready' && [rescue.ownerOnly, rescue.calls.map(fn)], [true, ['executeRescue']]);
});

test('My mix weight change: an account on v2 re-consents (policy + approvals for added collateral) sized for the NEW weights; an account not on v2 gets nothing here', async () => {
  const w = world(), reader = createV2Reader(w.readerDeps);
  const api = createStrategyEarnV2Api({ v2: W.v2, reader, now: () => NOW });
  assert.deepEqual(await api.reconsent(W.account, W.owner, { assets: [{ address: W.NVDA, weightBps: 10_000 }], totalValueUsd: 2_000n * E18 }), []);
  openVenus(w);
  const calls = await api.reconsent(W.account, W.owner, { assets: [{ address: W.NVDA, weightBps: 5000 }, { address: W.QQQ, weightBps: 5000 }], totalValueUsd: 2_000n * E18 });
  assert.deepEqual(calls.map(c => c.to), [W.v2.registry, W.QQQ, W.NVDA]);
  const [maxDebt, recipient, enabled] = decodeFunctionData({ abi: V2_REGISTRY_ABI, data: calls[0]!.data }).args as readonly [bigint, Address, boolean];
  // Never below the ceiling already consented to (10,000) nor below what is open.
  assert.deepEqual([maxDebt, recipient, enabled], [10_000n * E18, W.owner, true]);
});

test('scheduler round: nothing on v2 -> silent; consent + a filled buy -> one executeOpen; v1 still in use -> nothing is added; no v2 session scope -> reported, not sent', async () => {
  const w = world(), reader = createV2Reader(w.readerDeps);
  const sent: Call[][] = [], lines: string[] = [], led = ledger();
  const args = (o: object = {}) => ({ v2: W.v2, reader, account: W.account, portfolioId: 9, now: NOW, dryRun: false, send: async (calls: Call[]) => { sent.push(calls); return tx(sent.length); }, ledger: led.l, log: (l: string) => lines.push(l), held: [W.NVDA], ...o });
  w.setBalance(W.NVDA, W.account, 10n * E18);
  assert.equal(await v2AutoRound(args()), null);
  consenting(w);
  // Hard rule: v1 still holds something on this account -> v2 adds nothing.
  assert.match(await v2AutoRound(args({ v1Active: async () => true })) ?? '', /v1 加息部位或同意，v2 不動作/);
  assert.equal(sent.length, 0);
  assert.match(await v2AutoRound(args({ send: null })) ?? '', /沒有路由 v2 的 session 權限，等 owner 續期/);
  assert.match(await v2AutoRound(args({ dryRun: true })) ?? '', /dry-run/);
  assert.equal(sent.length, 0);
  const note = await v2AutoRound(args({ v1Active: async () => false }));
  assert.match(note ?? '', /^\[STRATEGY_ROUTING\] 已執行：NVDAB open\(best_route\) tx=0x0+1$/);
  assert.deepEqual([sent.length, sent[0]!.map(fn), argsOf(sent[0]![0]!).slice(1, 5)], [1, ['executeOpen'], [w.ids.nvdaVenusUsdt, w.ids.aaveUsdt, 10n * E18, 441n * E18]]);
  // A failed UserOp makes the round throw (the scheduler's back-off applies), with what did land.
  await assert.rejects(v2AutoRound(args({ send: async () => { throw new Error('PAYMASTER_USER_OP_CAPACITY'); } })), /0 筆完成、1 筆未完成/);
});

test('scheduler round: a vault that stopped paying is left at once (negative carry is not subject to the 7-day hold); a healthy position younger than 7 days stays', async () => {
  const w = world(), reader = createV2Reader(w.readerDeps);
  const sent: Call[][] = [], led = ledger();
  const args = () => ({ v2: W.v2, reader, account: W.account, portfolioId: 9, now: NOW, dryRun: false, send: async (calls: Call[]) => { sent.push(calls); return tx(sent.length); }, ledger: led.l, log: () => {}, held: [W.NVDA] });
  const young = Math.floor(NOW.getTime() / 1000) - 3600;
  openVenus(w, { since: young });
  assert.equal(await v2AutoRound(args()), null); // on the best route already
  // The money was moved to Venus vUSDT (0%): borrow 2.50% against 0% -> switch the vault back to Aave now.
  w.state.holdings.clear(); w.state.holdings.set(w.ids.venusUsdt, { assets: 442n * E18, since: young });
  assert.match(await v2AutoRound(args()) ?? '', /NVDAB migrate\(negative_carry\)/);
  assert.deepEqual([sent[0]!.map(fn), argsOf(sent[0]![0]!).slice(1, 4)], [['executeSwitchVault'], [w.ids.venusUsdt, w.ids.aaveUsdt, maxUint256]]);
});

test('before a sale: only assets the sale needs more of than is free are unwound; a full exit also sweeps the rewards with the session key; nothing posted -> the sale goes ahead', async () => {
  const w = world(), reader = createV2Reader(w.readerDeps);
  const sent: Call[][] = [], led = ledger();
  const args = <T extends object>(o: T) => ({ v2: W.v2, reader, account: W.account, portfolioId: 9, now: NOW, dryRun: false, send: async (calls: Call[]) => { sent.push(calls); return tx(sent.length); }, ledger: led.l, log: () => {}, ...o });
  assert.equal(await v2UnwindForSale(args({ steps: [{ tokenIn: W.NVDA, amountIn: E18 }] })), null);
  openVenus(w, { debt: 441n * E18, vault: 445n * E18 });
  w.setBalance(W.NVDA, W.account, 2n * E18);
  // Selling 1 NVDAB with 2 free: nothing to unwind.
  assert.equal(await v2UnwindForSale(args({ steps: [{ tokenIn: W.NVDA, amountIn: E18 }] })), null);
  // Selling 5: repay and take the shares back first; the trade waits for the next round.
  const blocked = await v2UnwindForSale(args({ steps: [{ tokenIn: W.NVDA, amountIn: 5n * E18 }] }));
  assert.match(blocked ?? '', /^\[STRATEGY_EARN_UNWINDING\] 賣出前已還款取回：NVDAB repay .* USDT, take back tx=0x0+1；下一輪再賣$/);
  assert.deepEqual([sent[0]!.map(fn), argsOf(sent[0]![0]!).slice(1, 5)], [['executeReduce'], [w.ids.nvdaVenusUsdt, w.ids.aaveUsdt, maxUint256, maxUint256]]);
  // Without the session scope it still blocks the sale and says why.
  assert.match(await v2UnwindForSale(args({ send: null, steps: [{ tokenIn: W.NVDA, amountIn: 5n * E18 }] })) ?? '', /沒有路由 v2 的 session 權限/);
  // Full exit: the same UserOp also sends the reward tokens (box + the account's approved balance) to the owner's wallet.
  sent.length = 0;
  w.setBalance(W.v2.rewardTokens[0]!, W.box, 3n * E18);
  await v2UnwindForSale(args({ steps: [{ tokenIn: W.NVDA, amountIn: 5n * E18 }], exit: true }));
  assert.deepEqual(sent.map(b => b.map(fn)), [['executeReduce', 'executeSweepRewards']]);
  assert.deepEqual(argsOf(sent[0]![1]!).slice(1, 3), [W.v2.rewardTokens[0], 0n]); // the account's own balance is not approved here
});

test('keeper round: executeDeleverage only when the venue says the health line is reached, reward tokens box -> account; report-only without a key; never anything else', async () => {
  const w = world(), reader = createV2Reader(w.readerDeps);
  const sent: { to: Address; name: string }[] = [], lines: string[] = [], led = ledger();
  const run = (send: boolean, dryRun = false) => runV2KeeperRound({ dryRun, log: l => lines.push(l) }, { v2: W.v2, reader, ledger: led.l, accounts: async () => [{ account: W.account, portfolioId: 9, owner: W.owner }],
    send: send ? async (to, data) => { sent.push({ to, name: to === W.v2.executor ? decodeFunctionData({ abi: V2_EXECUTOR_ABI, data }).functionName : 'claimReward' }); return tx(sent.length); } : null });
  assert.deepEqual(await run(true), { accounts: 1, checked: 0, deleveraged: 0, collected: 0, stranded: 0, failed: 0, writer: true });
  openVenus(w);
  assert.deepEqual([(await run(true)).checked, sent.length], [1, 0]); // healthy: nothing is sent
  w.state.positions.get(w.ids.nvdaVenusUsdt)!.shouldDeleverage = true;
  assert.deepEqual([(await run(false)).deleveraged, (await run(true, true)).deleveraged, sent.length], [0, 0, 0]);
  assert.ok(lines.some(l => /需要減倉.*沒有 keeper 金鑰/.test(l)));
  const r = await run(true);
  assert.deepEqual([r.deleveraged, sent.map(s => s.name)], [1, ['executeDeleverage']]);
  // Rewards: the simulated vault's pending incentive is claimed to the box (chain 97 only), then the box's balance is collected.
  w.state.positions.get(w.ids.nvdaVenusUsdt)!.shouldDeleverage = false;
  sent.length = 0;
  w.state.holdings.set(w.ids.listaUsdc, { assets: 100n * E18, since: 1 });
  w.state.vaultReward = 2n * E18;
  w.setBalance(W.v2.rewardTokens[0]!, W.box, 2n * E18);
  const r2 = await run(true);
  assert.deepEqual([r2.collected, sent.map(s => `${s.name}@${s.to === W.listaUsdcVault ? 'vault' : s.to === W.v2.executor ? 'executor' : 'venue'}`)], [1, ['claimReward@vault', 'claimReward@venue', 'collectRewards@executor']]);
  // Dust under 0.01 stays in the box.
  sent.length = 0; w.state.vaultReward = 0n; w.setBalance(W.v2.rewardTokens[0]!, W.box, 10n ** 15n);
  assert.deepEqual([(await run(true)).collected, sent.length], [0, 0]);
});

test('rewards round: the strategy box is an extra holder, signed for in its own form — abi.encode(message, account signature) — and only once it exists', async () => {
  const sig = { message: '2026-11-24T12:00:00.000Z\nThank you for your support of listaDAO.', signature: '0xabcd' as Hex, signedAt: new Date('2026-11-24T12:00:00.000Z') };
  assert.deepEqual(await v2RewardHolders(async () => ({ box: W.box, deployed: false }))(W.account, sig), []);
  const holders = await v2RewardHolders(async () => ({ box: W.box, deployed: true }))(W.account, sig);
  assert.deepEqual(holders, [{ holder: W.box, sig: { ...sig, signature: boxRewardSignature(sig.message, sig.signature) } }]);
  const w = world();
  assert.deepEqual(await createV2Reader(w.readerDeps).box(W.account), { box: W.box, deployed: false });
  w.state.holdings.set(w.ids.aaveUsdt, { assets: 1n, since: 1 });
  assert.deepEqual(await createV2Reader(w.readerDeps).box(W.account), { box: W.box, deployed: true });
});

test('rate report: due when never reported, 12 hours old, or a value moved 0.25%; sent only by the registry\'s reporter; values come from the simulated venues', async () => {
  const w = world(), reader = createV2Reader(w.readerDeps);
  const rates = await fromTestnetMocks(W.v2, await reader.book(), w.multicall);
  // Lista routes: the market's incentives; Venus routes: the vTokens'; only ERC4626 (Lista) vaults carry a rate.
  assert.deepEqual(rates.routes.map(r => [r.borrowIncentiveBps, r.collateralIncentiveBps]), [[50, 100], [0, 50], [0, 50], [50, 100]]);
  assert.deepEqual(rates.vaults, [{ vaultId: w.ids.listaUsdc, baseBps: 400, incentiveBps: 50 }]);
  const now = 1_800_000_000_000, at = (ageMs: number) => BigInt(Math.floor((now - ageMs) / 1000));
  const store = (ageMs: number) => { for (const r of rates.routes) w.state.reports.set(r.routeId, [at(ageMs), BigInt(r.borrowIncentiveBps) * 10n ** 14n, BigInt(r.collateralIncentiveBps) * 10n ** 14n]);
    w.state.reports.set(w.ids.listaUsdc, [at(ageMs), 400n * 10n ** 14n, 50n * 10n ** 14n]); };
  const sent: Hex[] = [];
  const signer = (address: Address) => ({ address, send: async (_to: Address, data: Hex) => { sent.push(data); return ('0x' + 'ab'.repeat(32)) as Hex; } });
  const run = (address: Address | null = w.state.rateReporter) => runRateReport({ v2: W.v2, reader, multicall: w.multicall, now: () => now, rates: async book => fromTestnetMocks(W.v2, book, w.multicall), signer: address === null ? null : signer(address) });
  assert.deepEqual(await run(null), { status: 'skipped', reason: 'no operator key in this service' });
  assert.match((await run(W.owner) as { reason: string }).reason, /rateReporter is .* not this service's operator/);
  const first = await run();
  assert.deepEqual([first.status, first.status === 'sent' && [first.routes, first.vaults, first.reason], sent.length], ['sent', [4, 1, 'never reported'], 1]);
  assert.equal(sent[0], reportCalldata(rates));
  const [routeReports, vaultReports] = decodeFunctionData({ abi: V2_REGISTRY_ABI, data: sent[0]! }).args as readonly [readonly { borrowIncentive: bigint }[], readonly { baseRate: bigint; incentive: bigint }[]];
  assert.deepEqual([routeReports[0]!.borrowIncentive, vaultReports[0]!.baseRate, vaultReports[0]!.incentive], [5n * 10n ** 15n, 4n * 10n ** 16n, 5n * 10n ** 15n]);
  store(11 * 3_600_000);
  assert.deepEqual(await run(), { status: 'skipped', reason: 'fresh' });
  store(12 * 3_600_000);
  assert.equal(((await run()) as { reason: string }).reason, 'older than 12 hours');
  // 0.25% moves a report; 0.24% does not.
  store(3_600_000);
  w.state.mock.vaultApr = 424; assert.equal((await run()).status, 'skipped');
  w.state.mock.vaultApr = 425; assert.equal(((await run()) as { reason: string }).reason, 'a rate moved by 0.25% or more');
  // The contract caps each value at 50%: anything above is clamped rather than reverting the whole report.
  w.state.mock.moolahBorrowIncentive = 9_000;
  assert.equal((await fromTestnetMocks(W.v2, await reader.book(), w.multicall)).routes[0]!.borrowIncentiveBps, 5_000);
  assert.deepEqual(reportDue({ routes: [], vaults: [] }, () => undefined, now), { due: false, reason: 'nothing to report' });
  // Mainnet: the display snapshot (api.venus.io / api.lista.org) matched to the registry's routes and vaults.
  const m = await reader.market();
  assert.deepEqual(fromMainnetRates(await reader.book(), m.snapshot).routes.map(r => [r.borrowIncentiveBps, r.collateralIncentiveBps]), [[50, 100], [0, 0], [0, 0], [0, 0]]);
});

test('swap needs: another loan token left after its routes closed is dust to sell; a route the box and the account cannot repay is a gap to buy; the cash token is never swapped', async () => {
  const w = world(), reader = createV2Reader(w.readerDeps);
  consenting(w, 0n);
  w.setBalance(USDC, W.account, 3n * E18); w.setBalance(USDT, W.account, 500n * E18);
  assert.deepEqual(loanTokenNeeds(await reader.account(W.account), USDT).map(n => [n.symbol, n.kind, n.amountRaw]), [['USDC', 'dust', 3n * E18]]);
  w.setBalance(USDC, W.account, 5n * 10n ** 17n);
  assert.deepEqual(loanTokenNeeds(await reader.account(W.account), USDT), []); // under 1 token: not worth a trade
  // QQQB on Lista/USDC: 300 owed, 280 in the vault + 5 idle + 0.5 in the account -> buy the 14.5 gap +0.5%.
  w.state.positions.set(w.ids.qqqListaUsdc, { collateral: 2n * E18, collateralValue: 1000n * E18, debt: 300n * E18, routeDebt: 300n * E18, principal: 300n * E18, openedAt: 1 });
  w.state.holdings.set(w.ids.listaUsdc, { assets: 280n * E18, since: 1 }); w.state.idle.set(USDC, 5n * E18);
  const needs = loanTokenNeeds(await reader.account(W.account), USDT);
  const gap = 145n * 10n ** 17n;
  assert.deepEqual(needs.map(n => [n.symbol, n.kind, n.amountRaw]), [['USDC', 'gap', gap + gap * 50n / 10_000n + 1n]]);
  // No trade path on this chain (the stablecoins are not strategy assets, chain 97 has no pool): reported, not guessed.
  assert.deepEqual((await planLoanTokenSwaps(needs, null)).unavailable.map(u => u.reason), ['no trade path for this token on this chain']);
  const quoted = await planLoanTokenSwaps([...needs, { symbol: 'USDC', token: USDC, kind: 'dust', amountRaw: 2n * E18, why: '' }],
    { sell: async (_t, amount) => ({ side: 'sell', amount }), buy: async () => ({ unavailable: 'asset not allowed for this strategy' }) });
  assert.deepEqual([quoted.steps.map(s => s.step), quoted.unavailable.map(u => u.reason)], [[{ side: 'sell', amount: 2n * E18 }], ['asset not allowed for this strategy']]);
});

test('reads never use the paid RPC: the public node list is the default, replaceable for a fork', () => {
  assert.deepEqual([v2PublicRpcs(97, {}).length >= 2, v2PublicRpcs(97, {}).every(u => /publicnode|bnbchain/.test(u))], [true, true]);
  assert.deepEqual(v2PublicRpcs(97, { STRATEGY_EARN_V2_RPC_URLS: 'http://127.0.0.1:8597, http://127.0.0.1:8598' }), ['http://127.0.0.1:8597', 'http://127.0.0.1:8598']);
  assert.throws(() => v2PublicRpcs(1337, {}), /no public RPC/);
});
