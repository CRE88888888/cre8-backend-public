import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, maxUint256, parseAbi } from 'viem';
import type { Address, Hex, Log } from 'viem';
import { planAccount } from '../src/strategy-earn-routing.js';
import { createStrategyEarnV2Api } from '../src/strategy-earn-v2-api.js';
import { createV2Reader, v2HasState, v2Multicall, v2PublicRpcs, v2RpcTransport, V2_RPC_COOLDOWN_MS, V2_RPC_TIMEOUT_MS, V2_UNTOUCHED_TTL_MS } from '../src/strategy-earn-v2-chain.js';
import { fromMainnetRates, fromTestnetMocks, reportCalldata, reportDue, runRateReport } from '../src/strategy-earn-v2-rates.js';
import { runV2KeeperRound, v2AutoRound, v2MinCollectRaw, v2QuietRound, v2RewardHolders, v2UnwindForSale } from '../src/strategy-earn-v2-scheduler.js';
import type { V2Ledger, V2Tx } from '../src/strategy-earn-v2-scheduler.js';
import { boxRewardSignature, cashOutMinUsdt, topUpMaxUsdtIn, v2ConsentCalls, V2_CASH_OUT_ALONE_MIN_RAW, V2_EXECUTOR_ABI, V2_REGISTRY_ABI, V2_SWAPPER_ABI } from '../src/strategy-earn-v2.js';
import type { Call, RouteEvent, SwapEvent } from '../src/strategy-earn-v2.js';
import type { RewardEvent } from '../src/strategy-rewards.js';
import { V2_CONSENT_KEY } from '../src/strategy-earn-after-sell-all.js';
import type { ConsentBefore, ConsentSinceSellAll } from '../src/strategy-earn-after-sell-all.js';
import { toFunctionSelector } from 'viem';
import { E18, SWAPPER, USDC_POOL, W, WORLD_NOW as NOW, WS, world } from './fixtures/v2-world.js';

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
function ledger() { const routes: RouteEvent[] = [], rewards: RewardEvent[] = [], swaps: SwapEvent[] = []; const l: V2Ledger = { routes: async (_c, e) => { routes.push(...e); }, rewards: async (_c, e) => { rewards.push(...e); }, swaps: async (_p, _a, e) => { swaps.push(...e); } }; return { l, routes, rewards, swaps }; }
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
  // The account's debt in the token is lens.tokenDebt, read once (draft6 §5), and it is what the net value and the swap planner use.
  assert.equal(read.tokens.USDT!.debtRaw, dust);
  // MAX goes only on the route that carries the share; the other one just gets its collateral back (repay 0).
  const api = createStrategyEarnV2Api({ v2: W.v2, reader, now: () => NOW });
  const off = await api.close(W.account, { symbols: ['NVDAB', 'QQQB'] });
  assert.deepEqual(off.status === 'ready' && off.calls.filter(c => c.to === W.v2.executor).map(c => argsOf(c).slice(3, 5)), [[maxUint256, maxUint256], [0n, maxUint256]]);
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
  w.state.delegated = { venus: true, lista: true }; // the first consent delegated both venues
  const calls = await api.reconsent(W.account, W.owner, { assets: [{ address: W.NVDA, weightBps: 5000 }, { address: W.QQQ, weightBps: 5000 }], totalValueUsd: 2_000n * E18 });
  assert.deepEqual(calls.map(c => c.to), [W.v2.registry, W.QQQ, W.NVDA]);
  const [maxDebt, recipient, enabled] = decodeFunctionData({ abi: V2_REGISTRY_ABI, data: calls[0]!.data }).args as readonly [bigint, Address, boolean];
  // Never below the ceiling already consented to (10,000) nor below what is open.
  assert.deepEqual([maxDebt, recipient, enabled], [10_000n * E18, W.owner, true]);
});

test('consent (auto / open) delegates only the venues the account has not delegated yet: both, one, none — a venue already delegated is never sent again', async () => {
  const w = world(), reader = createV2Reader(w.readerDeps);
  const api = createStrategyEarnV2Api({ v2: W.v2, reader, now: () => NOW, estimateGas: async () => 700_000n });
  w.setBalance(W.NVDA, W.account, 10n * E18);
  const weights = [{ asset: W.NVDA, weightBps: 6000 }, { asset: W.QQQ, weightBps: 4000 }];
  const rest = [W.v2.registry, W.QQQ, W.NVDA, USDT, USDC, W.v2.rewardTokens[0]];
  const auto = async () => { const r = await api.auto(W.account, W.owner, { budgetRaw: 1_000n * E18, weights, keyReady: true }); assert.equal(r.status, 'ready'); return r.status === 'ready' ? r.calls.map(c => c.to) : []; };
  const open = async () => { const r = await api.open(W.account, W.owner, { symbol: 'NVDAB', collateralRaw: 10n * E18, weights, keyReady: true }); assert.equal(r.status, 'ready');
    return r.status === 'ready' ? r.calls.slice(0, -1).map(c => c.to) : []; }; // the last call is the executeOpen
  const cases: [string, { venus: boolean; lista: boolean }, Address[]][] = [
    ['neither delegated (a first consent)', { venus: false, lista: false }, [W.v2.venusComptroller, W.v2.moolah]],
    ['only Lista missing', { venus: true, lista: false }, [W.v2.moolah]],
    ['only Venus missing', { venus: false, lista: true }, [W.v2.venusComptroller]],
    // Before: both were sent every time; on mainnet either one reverts the whole UserOp once it is already set
    // (Venus "Delegation status unchanged", Moolah "already set"): a second consent, or every open after the first.
    ['both already delegated', { venus: true, lista: true }, []],
  ];
  for (const [name, delegated, expected] of cases) {
    w.state.delegated = delegated;
    assert.deepEqual(await auto(), [...expected, ...rest], `auto: ${name}`);
    // `open` lists the asset being opened first among the approvals; everything else is the same consent.
    const opened = await open();
    assert.deepEqual([opened.slice(0, expected.length + 1), [...opened.slice(expected.length + 1)].sort()], [[...expected, W.v2.registry], [...rest.slice(1)].sort()], `open: ${name}`);
  }
  // The delegation that is sent is exactly the grant to the v2 executor.
  w.state.delegated = { venus: false, lista: false };
  const r = await api.auto(W.account, W.owner, { budgetRaw: 1_000n * E18, weights, keyReady: true });
  assert.ok(r.status === 'ready');
  const grants = v2ConsentCalls(W.v2, { maxDebtUsdRaw: 1n, rewardRecipient: W.owner, venues: ['venus', 'lista'], collaterals: [] });
  assert.deepEqual(r.calls.slice(0, 2).map(c => c.data), grants.slice(0, 2).map(c => c.data));
  // A portfolio whose assets only route through Lista never asks for the Venus delegation, delegated or not.
  w.setBalance(W.QQQ, W.account, 4n * E18);
  const lista = await api.auto(W.account, W.owner, { budgetRaw: 1_000n * E18, weights: [{ asset: W.QQQ, weightBps: 10_000 }], keyReady: true });
  assert.ok(lista.status === 'ready');
  assert.deepEqual(lista.calls.map(c => c.to).slice(0, 2), [W.v2.moolah, W.v2.registry]);
});

test('My mix weight change adds an asset whose only route is on the other venue: the re-consent also delegates that venue — only when the account has not yet', async () => {
  const w = world(), reader = createV2Reader(w.readerDeps);
  const api = createStrategyEarnV2Api({ v2: W.v2, reader, now: () => NOW });
  openVenus(w);
  // The first consent covered Venus only (the account's assets had no Lista route then). QQQB borrows on Lista only.
  w.state.delegated = { venus: true, lista: false };
  const added = [{ address: W.NVDA, weightBps: 5000 }, { address: W.QQQ, weightBps: 5000 }];
  const calls = await api.reconsent(W.account, W.owner, { assets: added, totalValueUsd: 2_000n * E18 });
  // Before: [registry, QQQ, NVDA] — QQQB could never open (Moolah refuses the executor).
  assert.deepEqual(calls.map(c => c.to), [W.v2.moolah, W.v2.registry, W.QQQ, W.NVDA]);
  assert.equal(calls[0]!.data, v2ConsentCalls(W.v2, { maxDebtUsdRaw: 1n, rewardRecipient: W.owner, venues: ['lista'], collaterals: [] })[0]!.data, 'setAuthorization(v2 executor, true)');
  // The other way round, and both at once: exactly the missing ones, in the first consent's order (Venus, Lista, policy, approvals).
  w.state.delegated = { venus: false, lista: true };
  assert.deepEqual((await api.reconsent(W.account, W.owner, { assets: added, totalValueUsd: 2_000n * E18 })).map(c => c.to), [W.v2.venusComptroller, W.v2.registry, W.QQQ, W.NVDA]);
  w.state.delegated = { venus: false, lista: false };
  assert.deepEqual((await api.reconsent(W.account, W.owner, { assets: added, totalValueUsd: 2_000n * E18 })).map(c => c.to), [W.v2.venusComptroller, W.v2.moolah, W.v2.registry, W.QQQ, W.NVDA]);
  // A venue none of the new weights' routes use is left alone even when it is not delegated: QQQB alone needs only Lista.
  w.state.delegated = { venus: false, lista: true };
  assert.deepEqual((await api.reconsent(W.account, W.owner, { assets: [{ address: W.QQQ, weightBps: 10_000 }], totalValueUsd: 2_000n * E18 })).map(c => c.to), [W.v2.registry, W.QQQ]);
  // Already delegated on both: nothing is sent twice (the real venues refuse a delegation that changes nothing).
  w.state.delegated = { venus: true, lista: true };
  assert.deepEqual((await api.reconsent(W.account, W.owner, { assets: added, totalValueUsd: 2_000n * E18 })).map(c => c.to), [W.v2.registry, W.QQQ, W.NVDA]);
});

test('2026-11-26 portfolio 55: before an owner\'s partial sale only the shares it is short of are repaid for and taken back, and the step says the sale can go on now', async () => {
  const w = world(), reader = createV2Reader(w.readerDeps);
  openVenus(w); // 10 NVDAB posted, none free, 441 USDT owed, 442 in the vault
  const sent: Call[][] = [], led = ledger();
  const args = <T extends object>(o: T) => ({ v2: W.v2, reader, account: W.account, portfolioId: 55, now: NOW, dryRun: false, ledger: led.l, log: () => {},
    send: async (calls: Call[]) => { sent.push(calls); return { ...tx(sent.length), blockNumber: 144_893_940n + BigInt(sent.length) }; }, steps: [{ tokenIn: W.NVDA, amountIn: 4n * E18 }], ...o });
  // Partial: one executeReduce for 4 of the 10 shares and their share of the debt (2% more), never the whole position.
  const freed = await v2UnwindForSale(args({ partial: true }));
  const pay = (441n * E18 * 4n * E18 * 10_000n + 10n * E18 * 9_800n - 1n) / (10n * E18 * 9_800n);
  assert.deepEqual([sent.length, sent[0]!.map(fn), argsOf(sent[0]![0]!).slice(3, 5)], [1, ['executeReduce'], [pay, 4n * E18]]);
  assert.ok(freed !== null && typeof freed === 'object' && 'freed' in freed, String(freed));
  assert.equal(freed.block, 144_893_941n, 'the block the take-back landed in: the sale must not read anything older');
  assert.match(freed.freed, /^\[STRATEGY_EARN_UNWINDING\] 賣出前已還款取回：NVDAB repay \d+ of 441000000000000000000 USDT, take back 4000000000000000000 of 10000000000000000000; the position stays open tx=0x0+1$/);
  // The same sale as it was before (and as a full exit still is): the whole position is closed and the sale waits a round.
  sent.length = 0;
  const whole = await v2UnwindForSale(args({}));
  assert.deepEqual([argsOf(sent[0]![0]!).slice(3, 5), typeof whole], [[maxUint256, maxUint256], 'string']);
  assert.match(String(whole), /；下一輪再賣$/);
  sent.length = 0;
  assert.match(String(await v2UnwindForSale(args({ partial: true, exit: true }))), /；下一輪再賣$/, '`partial` never applies to a full exit');
  assert.deepEqual(argsOf(sent[0]![0]!).slice(3, 5), [maxUint256, maxUint256]);
  // The box cannot pay that share: the old "short" repayment goes out, fewer shares come back than the sale needs, so the
  // answer is the old one — the sale waits for the next round.
  sent.length = 0;
  w.state.holdings.set(w.ids.aaveUsdt, { assets: 50n * E18, since: 1_795_000_000 });
  const short = await v2UnwindForSale(args({ partial: true }));
  assert.deepEqual([sent.length, typeof short], [1, 'string']);
  assert.match(String(short), /short of USDT.*；下一輪再賣$/);
  // The venue (or the bundler's simulation) refuses the partial repayment and nothing landed: the same call falls back to
  // what every sale did before — the whole position repaid and taken back — and the sale waits for the next round.
  sent.length = 0;
  w.state.holdings.set(w.ids.aaveUsdt, { assets: 442n * E18, since: 1_795_000_000 });
  const lines: string[] = [];
  const refused = await v2UnwindForSale(args({ partial: true, log: (l: string) => lines.push(l),
    send: async (calls: Call[]) => { sent.push(calls); if (argsOf(calls[0]!)[3] !== maxUint256) throw new Error('UserOperation reverted during simulation with reason: BudgetExceeded()'); return tx(sent.length); } }));
  assert.deepEqual([sent.length, argsOf(sent[1]![0]!).slice(3, 5), typeof refused], [2, [maxUint256, maxUint256], 'string']);
  assert.match(String(refused), /；下一輪再賣$/);
  assert.ok(lines.some(l => /部分還款取回沒送出（UserOperation reverted during simulation with reason: BudgetExceeded\(\)），這次賣出改走整個部位還款取回/.test(l)));
  // Enough free shares for the sale: nothing to do, nothing sent.
  sent.length = 0;
  w.setBalance(W.NVDA, W.account, 4n * E18);
  assert.deepEqual([await v2UnwindForSale(args({ partial: true })), sent.length], [null, 0]);
});

test('turn off keeps the reward recipient on the withdrawn consent; a later full exit with no route and no vault left still sends the reward tokens to the owner', async () => {
  const w = world(), reader = createV2Reader(w.readerDeps);
  const api = createStrategyEarnV2Api({ v2: W.v2, reader, now: () => NOW });
  const LISTA = W.v2.rewardTokens[0]!;
  // 1. A plain turn-off (not an exit): close, withdraw consent — the recipient the owner set stays; rewards stay in the account.
  openVenus(w);
  const off = await api.close(W.account, { symbols: ['NVDAB'] });
  if (off.status !== 'ready') throw new Error('close not ready');
  const last = off.calls.at(-1)!;
  assert.deepEqual([last.to, decodeFunctionData({ abi: V2_REGISTRY_ABI, data: last.data }).args], [W.v2.registry, [0n, W.owner, false]]);
  assert.ok(!off.calls.some(c => c.to === W.v2.executor && fn(c) === 'executeSweepRewards'));
  // 2. The chain after it: nothing open, nothing in a vault, consent off with the recipient kept; LISTA in the box and the account.
  w.state.positions.clear(); w.state.holdings.clear(); w.state.principalUsd = 0n;
  w.state.policy = { maxDebt: 0n, rewardRecipient: W.owner, strategyId: 57n, enabled: false };
  w.setBalance(LISTA, W.box, 5n * E18); w.setBalance(LISTA, W.account, 3n * E18);
  w.state.allowances.set(`${LISTA}:${W.account}`.toLowerCase(), maxUint256);
  const sent: Call[][] = [], lines: string[] = [], led = ledger();
  const args = <T extends object>(o: T) => ({ v2: W.v2, reader, account: W.account, portfolioId: 9, now: NOW, dryRun: false, send: async (calls: Call[]) => { sent.push(calls); return tx(sent.length); }, ledger: led.l, log: (l: string) => lines.push(l), steps: [{ tokenIn: W.NVDA, amountIn: E18 }], ...o });
  // An ordinary sale never moves rewards.
  assert.equal(await v2UnwindForSale(args({})), null);
  assert.equal(sent.length, 0);
  // 3. Sell all / delete: before the fix this returned at once (no route, no vault) and the tokens never left the account.
  assert.equal(await v2UnwindForSale(args({ exit: true })), null, 'the sale itself is not held back');
  assert.deepEqual([sent.map(b => b.map(fn)), argsOf(sent[0]![0]!).slice(1, 3)], [[['executeSweepRewards']], [LISTA, maxUint256]]);
  assert.ok(lines.some(l => /激勵代幣已送到 owner 錢包/.test(l)));
  // A sweep that fails never blocks the sale: logged, tried again at the next exit round.
  assert.equal(await v2UnwindForSale(args({ exit: true, send: async () => { throw new Error('PAYMASTER_QUOTA_EXCEEDED'); } })), null);
  assert.ok(lines.some(l => /激勵代幣這一輪沒送出（不擋賣出）：PAYMASTER_QUOTA_EXCEEDED/.test(l)));
  // dry-run and a key without the v2 scope: nothing sent, sale not blocked.
  sent.length = 0;
  assert.deepEqual([await v2UnwindForSale(args({ exit: true, dryRun: true })), await v2UnwindForSale(args({ exit: true, send: null })), sent.length], [null, null, 0]);
  // No recipient on the policy (never set): the contract only moves box -> account, and a sweep of the account's own tokens
  // alone would revert — so only the box is swept, with nothing asked from the account.
  w.state.policy = { maxDebt: 0n, rewardRecipient: ('0x' + '00'.repeat(20)) as Address, strategyId: 57n, enabled: false };
  w.state.holdings.set(w.ids.aaveUsdt, { assets: E18, since: 1 }); // something left in a vault keeps the account "touched"
  await v2UnwindForSale(args({ exit: true }));
  assert.deepEqual([sent.map(b => b.map(fn)), argsOf(sent[0]![0]!).slice(1, 3)], [[['executeSweepRewards']], [LISTA, 0n]]);
  sent.length = 0; w.setBalance(LISTA, W.box, 0n);
  assert.deepEqual([await v2UnwindForSale(args({ exit: true })), sent.length], [null, 0]);
  // An account that never used v2 (no recipient, nothing held) costs one read and nothing else.
  const fresh = world(), before = fresh.state.requests;
  assert.equal(await v2UnwindForSale({ ...args({ exit: true }), reader: createV2Reader(fresh.readerDeps) }), null);
  assert.equal(fresh.state.requests - before, 1);
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
  assert.match(String(blocked ?? ''), /^\[STRATEGY_EARN_UNWINDING\] 賣出前已還款取回：NVDAB repay .* USDT, take back tx=0x0+1；下一輪再賣$/);
  assert.deepEqual([sent[0]!.map(fn), argsOf(sent[0]![0]!).slice(1, 5)], [['executeReduce'], [w.ids.nvdaVenusUsdt, w.ids.aaveUsdt, maxUint256, maxUint256]]);
  // Without the session scope it still blocks the sale and says why.
  assert.match(String(await v2UnwindForSale(args({ send: null, steps: [{ tokenIn: W.NVDA, amountIn: 5n * E18 }] })) ?? ''), /沒有路由 v2 的 session 權限/);
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
  assert.deepEqual(await run(true), { accounts: 1, managed: 0, checked: 0, deleveraged: 0, collected: 0, stranded: 0, failed: 0, writer: true });
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
  // Dust stays in the box: under 0.001 on chain 97 (simulated tokens, small test positions), under 0.01 elsewhere.
  sent.length = 0; w.state.vaultReward = 0n; w.setBalance(W.v2.rewardTokens[0]!, W.box, 10n ** 15n - 1n);
  assert.deepEqual([(await run(true)).collected, sent.length], [0, 0]);
  assert.deepEqual([v2MinCollectRaw(97), v2MinCollectRaw(56)], [10n ** 15n, 10n ** 16n]);
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

// ---------------------------------------------------------------------------
// Cash swapper (AtpBorrowCashSwapper, spec §17) against the fake chain: `world(WS)`
// ---------------------------------------------------------------------------
const swapFn = (c: Call) => c.to === SWAPPER ? decodeFunctionData({ abi: V2_SWAPPER_ABI, data: c.data }).functionName : fn(c);
const swapArgs = (c: Call) => (decodeFunctionData({ abi: V2_SWAPPER_ABI, data: c.data }).args as readonly unknown[]).map(x => typeof x === 'string' ? x.toLowerCase() : x);
/** QQQB on Lista/USDC: 300 owed, `vault` in the USDC vault; consent given; USDT and USDC approved to the swapper unless `approved` is false. */
function shortUsdc(w: ReturnType<typeof world>, o: { vault?: bigint; usdt?: bigint; approved?: boolean; enabled?: boolean } = {}) {
  w.state.policy = { maxDebt: 10_000n * E18, rewardRecipient: W.owner, strategyId: 57n, enabled: o.enabled ?? true };
  w.state.positions.set(w.ids.qqqListaUsdc, { collateral: 2n * E18, collateralValue: 1000n * E18, debt: 300n * E18, routeDebt: 300n * E18, principal: 300n * E18, openedAt: 1_795_000_000, ltvBps: 3000 });
  w.state.holdings.set(w.ids.listaUsdc, { assets: o.vault ?? 280n * E18, since: 1_795_000_000 });
  w.state.principalUsd = 300n * E18;
  w.setBalance(USDT, W.account, o.usdt ?? 100n * E18);
  if (o.approved !== false) { w.setAllowance(USDT, W.account, SWAPPER, maxUint256); w.setAllowance(USDC, W.account, SWAPPER, maxUint256); }
}
const DRIFT = 300n * E18 / 5_000n + 1n, SHORT = 300n * E18 + DRIFT - 280n * E18, BOUGHT = SHORT + SHORT / 100n + 1n;

test('cash swapper, account read: shortfall and topUpCap (their own request, 30M gas), the window, allowances to the swapper; leftover loan token counts in the net value', async () => {
  const w = world(WS), reader = createV2Reader(w.readerDeps);
  const gas: (bigint | undefined)[] = [], inner = w.readerDeps.multicall;
  const watched = createV2Reader({ ...w.readerDeps, multicall: (reads, opts) => { gas.push(opts?.gas); return inner(reads, opts); } });
  shortUsdc(w, { approved: false });
  w.state.swap.windowStart = 1_800_000_000;
  w.setBalance(USDC, W.account, 2n * E18);
  w.setAllowance(USDT, W.account, SWAPPER, 7n);
  const read = await watched.account(W.account);
  // gap = 300 − 280 (vault) − 0 (idle); cap = (debt − idle) × 1.01; the window resets 24 hours after it opened.
  assert.deepEqual(read.tokens.USDC!.swap, { token: USDC, gapRaw: 20n * E18, capRaw: 303n * E18, windowEndsAt: 1_800_086_400, usdtRaw: 100n * E18, usdtAllowanceRaw: 7n, tokenAllowanceRaw: 0n });
  assert.equal(read.tokens.USDT!.swap, undefined); // the cash token is never swapped
  assert.deepEqual(read.swapperAllowances, { [USDT]: 7n, [USDC]: 0n });
  assert.deepEqual(gas.filter(g => g !== undefined), [30_000_000n], 'only the shortfall request carries a gas limit, and it is not under 10M');
  // The position carries the quote; the net value counts the account's own USDC at 1 USD: 280 + 2 − 300.
  assert.deepEqual([read.state.holdings.find(h => h.symbol === 'QQQB')!.swap, read.earnNetUsd], [read.tokens.USDC!.swap, -18n * E18]);
  // A vault that cannot be read: `shortfall` reverts -> the gap is unknown (null), the cap still answers.
  w.state.swap.unreadable = true;
  assert.deepEqual([(await reader.account(W.account)).tokens.USDC!.swap!.gapRaw, (await reader.account(W.account)).tokens.USDC!.swap!.capRaw], [null, 303n * E18]);
  // Nothing owed in the token: no shortfall read at all (one request fewer), the quote only carries the allowances.
  const count = async () => { const before = w.state.requests; const r = await reader.account(W.account); return { requests: w.state.requests - before, r }; };
  const owing = await count();
  w.state.positions.clear(); w.state.holdings.clear();
  const idle = await count();
  assert.deepEqual([owing.requests - idle.requests, idle.r.tokens.USDC!.swap!.gapRaw, idle.r.tokens.USDC!.swap!.capRaw], [1, 0n, 0n]);
  assert.deepEqual(await reader.leftovers(W.account), [{ symbol: 'USDC', token: USDC, cashRaw: 2n * E18, debtRaw: 0n, allowanceRaw: 0n }]);
  // Without a swapper on the deployment nothing of this is read.
  const plain = world(), plainRead = await createV2Reader(plain.readerDeps).account(W.account);
  assert.deepEqual([plainRead.swapperAllowances, plainRead.tokens.USDC!.swap, await createV2Reader(plain.readerDeps).leftovers(W.account)], [{}, undefined, []]);
});

test('cash swapper, scheduler: the round that closes a short USDC route tops up, closes and sells the leftover in one UserOp; reserved cash is never spent', async () => {
  const run = async (o: Parameters<typeof shortUsdc>[1] & { reserved?: bigint | Error; own?: bigint; noSwapLedger?: boolean; fail?: (calls: Call[]) => Error | null } = {}) => {
    const w = world(WS), reader = createV2Reader(w.readerDeps), sent: Call[][] = [], lines: string[] = [], led = ledger(), needs: bigint[] = [];
    shortUsdc(w, { enabled: false, ...o }); // the strategy was turned off: the engine closes
    const { swaps: _swaps, ...plainLedger } = led.l;
    const note = await v2AutoRound({ v2: WS, reader, account: W.account, portfolioId: 9, now: NOW, dryRun: false, ledger: o.noSwapLedger ? plainLedger : led.l, log: l => lines.push(l), onCashNeed: n => needs.push(n),
      ...(o.reserved === undefined ? {} : { cashClaims: async () => { if (o.reserved instanceof Error) throw o.reserved; return { claimedRaw: o.reserved as bigint, ownRaw: o.own ?? 0n }; } }),
      send: async calls => { const e = o.fail?.(calls); if (e) throw e; sent.push(calls); return tx(sent.length); } }).then(n => ({ note: n, error: null as Error | null }), (error: Error) => ({ note: null, error }));
    return { ...note, sent, lines, needs };
  };
  const ok = await run();
  assert.deepEqual(ok.sent.map(c => c.map(swapFn)), [['topUp', 'executeReduce', 'cashOut']]);
  assert.deepEqual(swapArgs(ok.sent[0]![0]!).slice(0, 3), [USDC, BOUGHT, topUpMaxUsdtIn(BOUGHT)]);
  assert.deepEqual(swapArgs(ok.sent[0]![2]!).slice(0, 3), [USDC, maxUint256, cashOutMinUsdt(280n * E18 + BOUGHT - 300n * E18 - DRIFT)]);
  assert.match(ok.note!, /已執行：QQQB close/);
  // 100 USDT in the account, 90 of it held for a running buy job: 10 cannot buy the ~20.3 gap. The reserved cash is never
  // spent: the box repays the 280 it holds and that share of the collateral comes back; the rest waits for USDT, and the
  // round says how much (the scheduler raises it from the portfolio's own holdings).
  const reserved = await run({ reserved: 90n * E18 });
  assert.deepEqual([reserved.sent.map(c => c.map(swapFn)), reserved.error], [[['executeReduce']], null]);
  assert.deepEqual((argsOf(reserved.sent[0]![0]!) as readonly unknown[]).slice(3, 5), [280n * E18 - 1n, 2n * E18 * (280n * E18 - 1n) / (300n * E18) * 9_800n / 10_000n]);
  assert.deepEqual(reserved.needs, [topUpMaxUsdtIn(BOUGHT) - 10n * E18]);
  // The same 90 is the portfolio's own cash (allocated_cash_raw): a top-up may spend it — it is booked against it when it lands.
  const own = await run({ reserved: 90n * E18, own: 90n * E18 });
  assert.deepEqual([own.sent.map(c => c.map(swapFn)), own.needs], [[['topUp', 'executeReduce', 'cashOut']], []]);
  // ...but only with a ledger to book it in: without one the own cash is not offered either.
  const unbooked = await run({ reserved: 90n * E18, own: 90n * E18, noSwapLedger: true });
  assert.deepEqual(unbooked.sent.map(c => c.map(swapFn)), [['executeReduce']]);
  // The box was already used up and there is no USDT: nothing is sent, the need is reported every round until it is met.
  const empty = await run({ reserved: 100n * E18, vault: 1n });
  assert.deepEqual([empty.sent.length, empty.needs.length], [0, 1]);
  assert.ok(empty.lines.some(l => /not sent: needs \d+ more USDT in the account/.test(l)), empty.lines.join('\n'));
  // The reservation cannot be read: no USDT is spent on a guess (the box still repays what it holds).
  const blind = await run({ reserved: new Error('db down') });
  assert.deepEqual(blind.sent.map(c => c.map(swapFn)), [['executeReduce']]);
  assert.ok(blind.lines.some(l => /cash ledger is unreadable/.test(l)));
  // The owner has not approved the swapper (consented before it existed): waits, says so.
  const unapproved = await run({ approved: false });
  assert.equal(unapproved.sent.length, 0);
  assert.ok(unapproved.lines.some(l => /not approved USDT to the cash swapper/.test(l)));
});

test('cash swapper, scheduler: PegExceeded is an alert (tagged failure + a structured error line); WindowExceeded waits for the window without a failure', async () => {
  const run = async (selector: string) => {
    const w = world(WS), reader = createV2Reader(w.readerDeps), lines: string[] = [], led = ledger();
    shortUsdc(w, { enabled: false });
    let tries = 0;
    const result = await v2AutoRound({ v2: WS, reader, account: W.account, portfolioId: 9, now: NOW, dryRun: false, ledger: led.l, log: l => lines.push(l),
      send: async () => { tries++; throw new Error(`UserOperation reverted during simulation with reason: ${toFunctionSelector(selector)}${'00'.repeat(64)}`); } }).then(note => ({ note, error: null as Error | null }), (error: Error) => ({ note: null, error }));
    return { ...result, lines, tries };
  };
  const peg = await run('PegExceeded(uint256,uint256)');
  assert.match(peg.error!.message, /^\[STRATEGY_PEG_EXCEEDED\] \[STRATEGY_ROUTING\]/);
  const alert = peg.lines.map(l => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } }).find(x => x?.msg === 'strategy_peg_exceeded');
  assert.deepEqual([alert?.level, alert?.portfolioId, alert?.account], ['error', 9, W.account]);
  const window = await run('WindowExceeded(uint256,uint256)');
  assert.equal(window.error, null, 'not a failure: nothing to back off from');
  assert.match(window.note!, /^\[STRATEGY_TOPUP_WINDOW\]/);
  assert.equal(window.lines.filter(l => /WindowExceeded/.test(l) && /等視窗重開/.test(l)).length, 1, 'the reason is logged once');
  // The next round reads the used-up window itself and does not send at all.
  const w = world(WS), reader = createV2Reader(w.readerDeps), lines: string[] = [], led = ledger();
  shortUsdc(w, { enabled: false });
  w.state.swap.cap = 0n; w.state.swap.windowStart = Math.floor(NOW.getTime() / 1000) - 3600;
  let sent = 0;
  assert.equal(await v2AutoRound({ v2: WS, reader, account: W.account, portfolioId: 9, now: NOW, dryRun: false, ledger: led.l, log: l => lines.push(l), send: async () => { sent++; return tx(1); } }), null);
  assert.equal(sent, 0);
  assert.ok(lines.some(l => /24-hour top-up window is used up .*it resets at 2026-11-26T02:00:00.000Z/.test(l)), lines.join('\n'));
});

test('cash swapper, scheduler: loan token a close left in the account is sold by a later round — also after the strategy was turned off; a swap that landed is written to the log', async () => {
  const w = world(WS), reader = createV2Reader(w.readerDeps), sent: Call[][] = [], lines: string[] = [], led = ledger();
  // Turned off earlier: no route, no vault, consent off with the recipient kept; 3 USDC from the vault's surplus in the account.
  w.state.policy = { maxDebt: 0n, rewardRecipient: W.owner, strategyId: 57n, enabled: false };
  w.setBalance(USDC, W.account, 3n * E18); w.setAllowance(USDC, W.account, SWAPPER, maxUint256);
  const cashed = { address: SWAPPER, topics: ['0x' + '00'.repeat(32)], data: '0x', logIndex: 0 };
  void cashed;
  const args = { v2: WS, reader, account: W.account, portfolioId: 9, now: NOW, dryRun: false, ledger: led.l, log: (l: string) => lines.push(l), send: async (calls: Call[]) => { sent.push(calls); return tx(sent.length); } };
  assert.match((await v2AutoRound(args))!, /USDC 已換回 USDT tx=0x0+1$/);
  assert.deepEqual([sent.map(c => c.map(swapFn)), swapArgs(sent[0]![0]!).slice(0, 3)], [[['cashOut']], [USDC, maxUint256, 3n * E18 * 997n / 1_000n]]);
  // Not approved to the swapper: said once per round, nothing sent. Dust: nothing at all. Never used v2: not even read.
  sent.length = 0; w.setAllowance(USDC, W.account, SWAPPER, 0n);
  assert.equal(await v2AutoRound(args), null);
  assert.ok(lines.some(l => /cannot sell for USDT yet/.test(l)));
  w.setAllowance(USDC, W.account, SWAPPER, maxUint256); w.setBalance(USDC, W.account, 10n ** 11n);
  assert.equal(await v2AutoRound(args), null);
  w.setBalance(USDC, W.account, 3n * E18); w.state.policy.rewardRecipient = '0x0000000000000000000000000000000000000000';
  const before = w.state.requests;
  assert.equal(await v2AutoRound(args), null);
  assert.deepEqual([sent.length, w.state.requests - before], [0, 1]);
  // A full exit (sell all / delete) sells it too, without holding the sale back.
  w.state.policy.rewardRecipient = W.owner;
  assert.equal(await v2UnwindForSale({ ...args, steps: [{ tokenIn: W.NVDA, amountIn: E18 }], exit: true }), null);
  assert.deepEqual(sent.map(c => c.map(swapFn)), [['cashOut']]);
  assert.ok(lines.some(l => /剩餘借款幣已換回 USDT/.test(l)));
  // An ordinary sale does not touch it.
  sent.length = 0;
  assert.equal(await v2UnwindForSale({ ...args, steps: [{ tokenIn: W.NVDA, amountIn: E18 }] }), null);
  assert.equal(sent.length, 0);
});

test('cash swapper: a cash-out that would be a UserOp of its own needs 0.01 of the token; a smaller leftover is still sold when it rides in a UserOp that is sent anyway', async () => {
  const w = world(WS), reader = createV2Reader(w.readerDeps), sent: Call[][] = [], led = ledger(), LISTA = WS.rewardTokens[0]!;
  w.state.policy = { maxDebt: 0n, rewardRecipient: W.owner, strategyId: 57n, enabled: false };
  w.setAllowance(USDC, W.account, SWAPPER, maxUint256);
  const args = { v2: WS, reader, account: W.account, portfolioId: 9, now: NOW, dryRun: false, ledger: led.l, log: () => {}, send: async (calls: Call[]) => { sent.push(calls); return tx(sent.length); } };
  const exit = { ...args, steps: [{ tokenIn: W.NVDA, amountIn: E18 }], exit: true };
  const api = createStrategyEarnV2Api({ v2: WS, reader, now: () => NOW });
  const ownerCalls = async () => { const r = await api.close(W.account, { symbols: [], exit: true }); if (r.status !== 'ready') throw new Error('close not ready'); return r.calls.map(swapFn); };
  // 2026-11-25: 0.0000026 USD1 was sold in a sponsored UserOp of its own. Alone: nothing is sent under 0.01 —
  // the scheduler's follow-up round, a full exit with nothing else to do, and the owner-signed exit.
  for (const raw of [2_600_000_000_000n, V2_CASH_OUT_ALONE_MIN_RAW - 1n]) {
    w.setBalance(USDC, W.account, raw);
    assert.deepEqual([await v2AutoRound(args), await v2UnwindForSale(exit), await ownerCalls(), sent.length], [null, null, [], 0]);
  }
  // The same dust rides along when the UserOp is sent anyway (here: the reward tokens of a full exit).
  w.setBalance(USDC, W.account, 2_600_000_000_000n); w.setBalance(LISTA, W.box, 3n * E18);
  assert.equal(await v2UnwindForSale(exit), null);
  assert.deepEqual(sent.map(c => c.map(swapFn)), [['cashOut', 'executeSweepRewards']]);
  assert.deepEqual(await ownerCalls(), ['cashOut', 'executeSweepRewards']);
  // From 0.01 it is worth a UserOp of its own.
  sent.length = 0; w.setBalance(LISTA, W.box, 0n); w.setBalance(USDC, W.account, V2_CASH_OUT_ALONE_MIN_RAW);
  assert.match((await v2AutoRound(args))!, /USDC 已換回 USDT/);
  assert.deepEqual([sent.map(c => c.map(swapFn)), await ownerCalls()], [[['cashOut']], ['cashOut']]);
  assert.equal(await v2UnwindForSale(exit), null);
  assert.deepEqual(sent.map(c => c.map(swapFn)), [['cashOut'], ['cashOut']]);
});

test('cash swapper, before a sale (session key): top-up + close + cash-out; with too little free USDT the part it can free; pools are internal to the portfolio', async () => {
  const run = async (usdt: bigint) => {
    const w = world(WS), reader = createV2Reader(w.readerDeps), sent: Call[][] = [], led = ledger();
    shortUsdc(w, { usdt });
    const note = await v2UnwindForSale({ v2: WS, reader, account: W.account, portfolioId: 9, now: NOW, dryRun: false, ledger: led.l, log: () => {}, steps: [{ tokenIn: W.QQQ, amountIn: E18 }],
      send: async calls => { sent.push(calls); return tx(sent.length); } });
    return { note, sent };
  };
  const full = await run(100n * E18);
  assert.deepEqual(full.sent.map(c => c.map(swapFn)), [['topUp', 'executeReduce', 'cashOut']]);
  assert.match(full.note as string, /賣出前已還款取回/);
  const part = await run(5n * E18);
  const bought = 5n * E18 * 1_000n / 1_003n;
  assert.deepEqual([part.sent.map(c => c.map(swapFn)), swapArgs(part.sent[0]![0]!)[1], (argsOf(part.sent[0]![1]!) as readonly unknown[])[3]], [[['topUp', 'executeReduce']], bought, 280n * E18 + bought - 1n]);
  // My mix flow accounting: USDT paid into / out of the swapper's pool is not a withdrawal or a deposit of the mix.
  const { mixFlowDirection } = await import('../src/mix-flows.js');
  const env = process.env.STRATEGY_EARN_V2_DEPLOYMENT;
  process.env.STRATEGY_EARN_V2_DEPLOYMENT = JSON.stringify({ ...WS, cashSwapper: { address: SWAPPER, pools: { USDC: USDC_POOL } } });
  try {
    const m = { account: W.account, owner: W.owner } as never;
    assert.deepEqual([mixFlowDirection(W.account, USDC_POOL, m), mixFlowDirection(USDC_POOL, W.account, m), mixFlowDirection(W.account, W.owner, m)], [null, null, 'withdrawal']);
  } finally { if (env === undefined) delete process.env.STRATEGY_EARN_V2_DEPLOYMENT; else process.env.STRATEGY_EARN_V2_DEPLOYMENT = env; }
});

test('cash swapper, before a sale: when the top-up cannot go through (pool off its peg, window used up) the sale is not held back — the same round repays and frees without the swapper', async () => {
  for (const [name, selector] of [['PegExceeded', 'PegExceeded(uint256,uint256)'], ['WindowExceeded', 'WindowExceeded(uint256,uint256)']] as const) {
    const w = world(WS), reader = createV2Reader(w.readerDeps), sent: Call[][] = [], lines: string[] = [], led = ledger();
    shortUsdc(w);
    const note = await v2UnwindForSale({ v2: WS, reader, account: W.account, portfolioId: 9, now: NOW, dryRun: false, ledger: led.l, log: l => lines.push(l), steps: [{ tokenIn: W.QQQ, amountIn: E18 }],
      send: async calls => {
        // The pool refuses every swap; everything else lands.
        if (calls.some(c => c.to === SWAPPER)) throw new Error(`UserOperation reverted during simulation with reason: ${toFunctionSelector(selector)}${'00'.repeat(64)}`);
        sent.push(calls); return tx(sent.length);
      } });
    // What landed: the plan without the swapper — repay what the box holds (280 of 300, less 1 wei) and take back that share less 2%.
    assert.deepEqual(sent.map(c => c.map(swapFn)), [['executeReduce']], name);
    assert.deepEqual((argsOf(sent[0]![0]!) as readonly unknown[]).slice(3, 5), [280n * E18 - 1n, 2n * E18 * (280n * E18 - 1n) / (300n * E18) * 9_800n / 10_000n], name);
    assert.match(note as string, /賣出前已還款取回：QQQB short of USDC: repay \d+, take back \d+ of \d+; the sale pays the rest tx=0x0+1；下一輪再賣$/, name);
    assert.ok(lines.some(l => new RegExp(`補差額／換回現金這一輪做不了（${name}），這次賣出改走不補差額的還款取回`).test(l)), lines.join('\n'));
    if (name === 'PegExceeded') assert.ok(lines.some(l => /"msg":"strategy_peg_exceeded"/.test(l)), 'the alert line is still written');
  }
  // A failure that has nothing to do with the swapper (no swapper call in the plan) is reported as before.
  const w = world(), reader = createV2Reader(w.readerDeps), led = ledger();
  openVenus(w, { debt: 441n * E18, vault: 442n * E18 });
  await assert.rejects(v2UnwindForSale({ v2: W.v2, reader, account: W.account, portfolioId: 9, now: NOW, dryRun: false, ledger: led.l, log: () => {}, steps: [{ tokenIn: W.NVDA, amountIn: 10n * E18 }],
    send: async () => { throw new Error('PAYMASTER_QUOTA_EXCEEDED'); } }), /PAYMASTER_QUOTA_EXCEEDED/);
});

test('cash swapper, owner API: consent adds the swapper approvals an account lacks; an owner close signs them with its top-up and cash-out; a close it cannot cover is not handed out', async () => {
  const w = world(WS), reader = createV2Reader(w.readerDeps);
  const api = createStrategyEarnV2Api({ v2: WS, reader, now: () => NOW, cashClaims: async () => ({ claimedRaw: w.state.vaultReward, ownRaw: 0n }) });
  consenting(w);
  const weights = [{ asset: W.NVDA, weightBps: 10_000 }];
  // First consent: USDT and USDC to the swapper, then the consent exactly as before.
  const first = await api.auto(W.account, W.owner, { budgetRaw: 0n, weights, keyReady: true });
  if (first.status !== 'ready') throw new Error('auto not ready');
  const approves = (calls: readonly Call[]) => calls.filter(c => c.data.startsWith('0x095ea7b3')).map(c => [c.to, ('0x' + c.data.slice(34, 74)) as Address]);
  assert.deepEqual(approves(first.calls!).filter(([, spender]) => spender === SWAPPER), [[USDT, SWAPPER], [USDC, SWAPPER]]);
  assert.deepEqual(first.calls!.slice(0, 2).map(c => c.to), [USDT, USDC]);
  // Already approved: not asked again.
  w.setAllowance(USDT, W.account, SWAPPER, maxUint256); w.setAllowance(USDC, W.account, SWAPPER, maxUint256);
  const again = await api.auto(W.account, W.owner, { budgetRaw: 0n, weights, keyReady: true });
  assert.deepEqual(approves((again as { calls: Call[] }).calls).filter(([, spender]) => spender === SWAPPER), []);
  // Owner close of a short USDC route on an account that never approved the swapper: the approvals ride in the exit.
  let ownCash = 0n; const booked: SwapEvent[] = [];
  const w2 = world(WS), api2 = createStrategyEarnV2Api({ v2: WS, reader: createV2Reader(w2.readerDeps), now: () => NOW, cashClaims: async () => ({ claimedRaw: w2.state.vaultReward, ownRaw: ownCash }),
    bookSwaps: async (_id, _account, events) => { booked.push(...events); }, log: () => {} });
  shortUsdc(w2, { approved: false });
  const off = await api2.close(W.account, { symbols: ['QQQB'] });
  if (off.status !== 'ready') throw new Error('close not ready');
  assert.deepEqual(off.calls.map(c => c.data.startsWith('0x095ea7b3') ? `approve:${c.to}` : swapFn(c)), [`approve:${USDT}`, `approve:${USDC}`, 'topUp', 'executeReduce', 'cashOut', 'setStrategyPolicy']);
  assert.deepEqual(off.batches.flat().length, off.calls.length);
  assert.deepEqual(off.batches.at(-1)!.map(swapFn).at(-1), 'setStrategyPolicy');
  // 100 USDT in the account, all of it held for a running job: nothing to top up with. No close that would revert is
  // handed out: the owner repays what the box holds (280 of 300) and takes that share back, and withdraws consent; the
  // scheduler closes the rest. No approval is asked for (nothing here uses the swapper).
  w2.state.vaultReward = 100n * E18;
  const partial = await api2.close(W.account, { symbols: ['QQQB'] });
  if (partial.status !== 'ready') throw new Error('close not ready');
  assert.deepEqual(partial.calls.map(swapFn), ['executeReduce', 'setStrategyPolicy']);
  assert.deepEqual((argsOf(partial.calls[0]!) as readonly unknown[]).slice(3, 5), [280n * E18 - 1n, 2n * E18 * (280n * E18 - 1n) / (300n * E18) * 9_800n / 10_000n]);
  // The same 100 is the portfolio's own cash: the top-up may spend it, and `confirm` books what the receipt says.
  ownCash = 100n * E18;
  const paid = await api2.close(W.account, { symbols: ['QQQB'] });
  assert.deepEqual(paid.status === 'ready' && paid.calls.map(c => c.data.startsWith('0x095ea7b3') ? `approve:${c.to}` : swapFn(c)), [`approve:${USDT}`, `approve:${USDC}`, 'topUp', 'executeReduce', 'cashOut', 'setStrategyPolicy']);
  const receipt = { hash: ('0x' + 'ab'.repeat(32)) as Hex, blockNumber: 77n, logs: [
    { address: SWAPPER, logIndex: 4, data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [21n * E18, 20n * E18, 20n * E18]), topics: encodeEventTopics({ abi: V2_SWAPPER_ABI, eventName: 'ToppedUp', args: { account: W.account, token: USDC } }) },
    { address: SWAPPER, logIndex: 9, data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [E18, 9n * E18 / 10n]), topics: encodeEventTopics({ abi: V2_SWAPPER_ABI, eventName: 'CashedOut', args: { account: W.account, token: USDC } }) },
  ] as unknown as Log[] };
  const confirmed = await api2.confirm(9, W.account, W.owner, receipt);
  assert.deepEqual([confirmed.kinds, booked.map(e => [e.kind, e.usdtRaw, e.logIndex])], [['top_up', 'cash_out'], [['top_up', 21n * E18, 4], ['cash_out', 9n * E18 / 10n, 9]]]);
  ownCash = 0n;
  // A covered route: no top-up, no USDT approval; the surplus is sold (so only the USDC approval is asked for).
  w2.state.vaultReward = 0n; w2.state.holdings.set(w2.ids.listaUsdc, { assets: 310n * E18, since: 1 });
  const covered = await api2.close(W.account, { symbols: ['QQQB'] });
  if (covered.status !== 'ready') throw new Error('close not ready');
  assert.deepEqual(covered.calls.map(c => c.data.startsWith('0x095ea7b3') ? `approve:${c.to}` : swapFn(c)), [`approve:${USDC}`, 'executeReduce', 'cashOut', 'setStrategyPolicy']);
});

test('a USDT-route repayment (maxCashIn) may take the portfolio\'s own cash and unclaimed USDT, never what other buckets claim: scheduler round, before a sale, owner close; what it took is booked', async () => {
  // Venus NVDAB/USDT, 441 owed, 440 in Aave: the executor would take the missing 1 from the account's own USDT. The account
  // holds 7 USDT; 5 of it is claimed by other buckets of the ledger (money waiting to be bought) -> only 2 may be offered.
  const setup = () => { const w = world(), reader = createV2Reader(w.readerDeps); openVenus(w, { debt: 441n * E18, vault: 440n * E18 }); w.setBalance(USDT, W.account, 7n * E18); return { w, reader }; };
  const cashIn = (c: Call) => argsOf(c)[5];
  const round = async (o: { reserved?: bigint | Error; own?: bigint; disabled?: boolean; noLedger?: boolean; receipt?: Log[] }) => {
    const { w, reader } = setup(), sent: Call[][] = [], lines: string[] = [], led = ledger(), needs: bigint[] = [];
    if (o.disabled !== false) w.state.policy.enabled = false; // the strategy was turned off: the engine closes
    const { swaps: _swaps, ...plain } = led.l;
    await v2AutoRound({ v2: W.v2, reader, account: W.account, portfolioId: 9, now: NOW, dryRun: false, ledger: o.noLedger ? plain : led.l, log: l => lines.push(l), onCashNeed: n => needs.push(n),
      send: async calls => { sent.push(calls); return { ...tx(sent.length), logs: o.receipt ?? [] }; },
      ...(o.reserved === undefined ? {} : { cashClaims: async () => { if (o.reserved instanceof Error) throw o.reserved; return { claimedRaw: (o.reserved as bigint) + (o.own ?? 0n), ownRaw: o.own ?? 0n }; } }) });
    return { sent, lines, needs, booked: led.swaps };
  };
  assert.equal(cashIn((await round({ reserved: 5n * E18 })).sent[0]![0]!), 2n * E18);
  // The portfolio's own cash may be taken too (5 own + 2 unclaimed), and what the executor took is booked against it:
  // the receipt's USDT transfer account -> executor (fork: the `Reduced.fromCash` of the call).
  const topic = (a: string) => ('0x' + '00'.repeat(12) + a.slice(2).toLowerCase()) as Hex;
  const took = [{ address: USDT, logIndex: 4, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', topic(W.account), topic(W.v2.executor)], data: ('0x' + (E18 + 7n).toString(16).padStart(64, '0')) as Hex },
    { address: USDT, logIndex: 6, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', topic(W.v2.executor), topic(W.v2.moolah)], data: ('0x' + (441n * E18).toString(16).padStart(64, '0')) as Hex }] as unknown as Log[];
  const own = await round({ reserved: 0n, own: 5n * E18, receipt: took });
  assert.equal(cashIn(own.sent[0]![0]!), 7n * E18);
  assert.deepEqual(own.booked.map(e => [e.kind, e.usdtRaw, e.logIndex]), [['repay_cash', E18 + 7n, 4]]);
  // Without a ledger to book it in, the own cash is not offered.
  assert.equal(cashIn((await round({ reserved: 0n, own: 5n * E18, noLedger: true })).sent[0]![0]!), 2n * E18);
  // Everything is claimed by other buckets: nothing is offered. The close would only revert, so the box repays what it holds
  // (440 of 441) and the round says how much USDT the rest waits for.
  const none = await round({ reserved: 9n * E18 });
  assert.deepEqual([cashIn(none.sent[0]![0]!), argsOf(none.sent[0]![0]!)[3], none.needs], [0n, 440n * E18 - 1n, [441n * E18 + 441n * E18 / 5_000n + 1n - 440n * E18]]);
  const blind = await round({ reserved: new Error('db down') });
  assert.equal(cashIn(blind.sent[0]![0]!), 0n);
  assert.ok(blind.lines.some(l => /cash ledger is unreadable/.test(l)));
  // A caller without the ledger (tests, older wiring) behaves as before: the whole balance.
  assert.equal(cashIn((await round({})).sent[0]![0]!), 7n * E18);
  // Before a sale (session key): the same cut; the box (440) + 2 covers 441 -> a full close with at most 2 from the account.
  const { reader } = setup(), sold: Call[][] = [], led = ledger();
  await v2UnwindForSale({ v2: W.v2, reader, account: W.account, portfolioId: 9, now: NOW, dryRun: false, ledger: led.l, log: () => {}, steps: [{ tokenIn: W.NVDA, amountIn: 10n * E18 }],
    send: async calls => { sold.push(calls); return tx(sold.length); }, cashClaims: async () => ({ claimedRaw: 5n * E18, ownRaw: 0n }) });
  assert.equal(cashIn(sold[0]![0]!), 2n * E18);
  // Owner close: the same.
  const owner = setup(), api = createStrategyEarnV2Api({ v2: W.v2, reader: owner.reader, now: () => NOW, cashClaims: async () => ({ claimedRaw: 5n * E18, ownRaw: 0n }), bookSwaps: async () => {} });
  const off = await api.close(W.account, { symbols: ['NVDAB'] });
  if (off.status !== 'ready') throw new Error('close not ready');
  assert.equal(cashIn(off.calls[0]!), 2n * E18);
  const plain = createStrategyEarnV2Api({ v2: W.v2, reader: setup().reader, now: () => NOW });
  const before = await plain.close(W.account, { symbols: ['NVDAB'] });
  assert.equal(before.status === 'ready' && cashIn(before.calls[0]!), 7n * E18);
});

test('reads never use the paid RPC: the public node list is the default, replaceable for a fork', () => {
  assert.deepEqual([v2PublicRpcs(97, {}).length >= 2, v2PublicRpcs(97, {}).every(u => /publicnode|bnbchain/.test(u))], [true, true]);
  assert.deepEqual(v2PublicRpcs(97, { STRATEGY_EARN_V2_RPC_URLS: 'http://127.0.0.1:8597, http://127.0.0.1:8598' }), ['http://127.0.0.1:8597', 'http://127.0.0.1:8598']);
  assert.throws(() => v2PublicRpcs(1337, {}), /no public RPC/);
});

test('before a sale with nothing left to repay from and no USDT: the step answers "sell what is free" with the stuck collateral and the USDT it needs; a dry run still reports', async () => {
  const run = async (o: { vault: bigint; usdt: bigint; dryRun?: boolean; exit?: boolean }) => {
    const w = world(WS), reader = createV2Reader(w.readerDeps), sent: Call[][] = [], led = ledger();
    shortUsdc(w, { vault: o.vault, usdt: o.usdt });
    const note = await v2UnwindForSale({ v2: WS, reader, account: W.account, portfolioId: 9, now: NOW, dryRun: o.dryRun ?? false, ledger: led.l, log: () => {}, steps: [{ tokenIn: W.QQQ, amountIn: 2n * E18 }], ...(o.exit ? { exit: true } : {}),
      send: async calls => { sent.push(calls); return tx(sent.length); } });
    return { note, sent };
  };
  // The box was emptied by an earlier round (1 wei of 300 owed) and the account has no USDT: nothing is sent.
  const stuck = await run({ vault: 1n, usdt: 0n, exit: true });
  assert.ok(stuck.note !== null && typeof stuck.note === 'object');
  const wait = stuck.note as { note: string; stuck: Address[]; needUsdtRaw: bigint };
  assert.deepEqual([stuck.sent.length, wait.stuck, wait.needUsdtRaw > 300n * E18 && wait.needUsdtRaw < 310n * E18], [0, [W.QQQ.toLowerCase()], true]);
  assert.match(wait.note, /^\[STRATEGY_EARN_UNWINDING\] QQQB cannot be freed yet/);
  // The same for a sale that is not an exit (the scheduler then raises the USDT first).
  assert.equal(typeof (await run({ vault: 1n, usdt: 0n })).note, 'object');
  // A dry run changes nothing and keeps the plain note.
  assert.equal(typeof (await run({ vault: 1n, usdt: 0n, dryRun: true })).note, 'string');
  // With the USDT (the sale's proceeds, now the portfolio's own cash) the same position closes in one UserOp.
  const paid = await run({ vault: 1n, usdt: 400n * E18, exit: true });
  assert.deepEqual([paid.sent.map(c => c.map(swapFn)), typeof paid.note], [[['topUp', 'executeReduce', 'cashOut']], 'string']);
});

test('My mix weight change on a deployment with a cash swapper: the re-consent also carries the swapper approvals the account lacks; the app is told the swapper with the registry and the executor', async () => {
  const { strategyV2Addresses } = await import('../src/strategy-earn-v2.js');
  const w = world(WS), reader = createV2Reader(w.readerDeps);
  const api = createStrategyEarnV2Api({ v2: WS, reader, now: () => NOW });
  openVenus(w);
  w.state.delegated = { venus: true, lista: true };
  const input = { assets: [{ address: W.NVDA, weightBps: 5000 }, { address: W.QQQ, weightBps: 5000 }], totalValueUsd: 2_000n * E18 };
  const spender = (c: Call) => c.data.startsWith('0x095ea7b3') ? ('0x' + c.data.slice(34, 74)) as Address : null;
  // The account consented before the swapper existed: USDT (top-up) and USDC (cash-out) are approved to it, after the usual calls.
  const calls = await api.reconsent(W.account, W.owner, input);
  assert.deepEqual(calls.map(c => [c.to, spender(c)]), [[WS.registry, null], [W.QQQ, WS.executor], [W.NVDA, WS.executor], [USDT, SWAPPER], [USDC, SWAPPER]]);
  // Already approved: nothing extra (the same calls as on a deployment without a swapper).
  w.setAllowance(USDT, W.account, SWAPPER, maxUint256); w.setAllowance(USDC, W.account, SWAPPER, maxUint256);
  assert.deepEqual((await api.reconsent(W.account, W.owner, input)).map(c => [c.to, spender(c)]), [[WS.registry, null], [W.QQQ, WS.executor], [W.NVDA, WS.executor]]);
  // What the app is told (signing payload of a weight change, and every v2 position status): one shape, the deployment's own addresses.
  assert.deepEqual(strategyV2Addresses(WS), { registry: WS.registry, executor: WS.executor, cashSwapper: SWAPPER });
  assert.deepEqual(strategyV2Addresses(W.v2), { registry: W.v2.registry, executor: W.v2.executor });
  assert.equal(strategyV2Addresses(null), null);
  assert.deepEqual((await api.portfolio(9, W.account)).strategyV2, { registry: WS.registry, executor: WS.executor, cashSwapper: SWAPPER });
  // The chain-97 deployment declares the swapper the app pins.
  const { strategyEarnV2 } = await import('../src/strategy-earn-v2.js');
  assert.equal(strategyV2Addresses(strategyEarnV2(97, {}))!.cashSwapper, '0x99811a1115B36F8310deaDAda818cAE685360798'.toLowerCase());
});

test('owner turn-off of a short USDC route is one UserOp: the close that cannot be estimated without its top-up stays with it (and with the cash-out and the consent)', async () => {
  const { AFTER_TOP_UP_GAS } = await import('../src/strategy-earn-v2-api.js');
  const estimates: string[] = [];
  // As on chain: the close reverts when estimated alone (the box is short until the top-up lands) -> no estimate.
  const api = (w: ReturnType<typeof world>, estimate: (name: string) => bigint | null) => createStrategyEarnV2Api({ v2: WS, reader: createV2Reader(w.readerDeps), now: () => NOW,
    estimateGas: async (_account, call) => { const name = fn(call); estimates.push(name); return estimate(name); } });
  const shape = (r: { batches: Call[][] }) => r.batches.map(b => b.map(c => c.data.startsWith('0x095ea7b3') ? 'approve' : swapFn(c)));
  const w = world(WS);
  shortUsdc(w);
  const off = await api(w, name => name === 'executeReduce' ? null : 400_000n).close(W.account, { symbols: ['QQQB'] });
  if (off.status !== 'ready') throw new Error('close not ready');
  assert.deepEqual(shape(off), [['topUp', 'executeReduce', 'cashOut', 'setStrategyPolicy']]);
  assert.ok(AFTER_TOP_UP_GAS <= 3_000_000n);
  // An account that still has to approve the swapper: the two approvals and the top-up fill the first UserOp, the close and the rest follow.
  const w2 = world(WS);
  shortUsdc(w2, { approved: false });
  const first = await api(w2, name => name === 'executeReduce' ? null : 400_000n).close(W.account, { symbols: ['QQQB'] });
  if (first.status !== 'ready') throw new Error('close not ready');
  assert.deepEqual(shape(first), [['approve', 'approve', 'topUp'], ['executeReduce', 'cashOut', 'setStrategyPolicy']]);
  // A call of unknown gas that has no top-up in front of it still goes alone, as before (a covered close whose estimate failed for another reason).
  const w3 = world(WS);
  shortUsdc(w3, { vault: 310n * E18 });
  const alone = await api(w3, () => null).close(W.account, { symbols: ['QQQB'] });
  if (alone.status !== 'ready') throw new Error('close not ready');
  assert.deepEqual(shape(alone), [['executeReduce'], ['cashOut', 'setStrategyPolicy']]);
});

// ---- After "sell all" (src/strategy-earn-after-sell-all.ts; testnet portfolio 35, 2026-11-26) ----
test('after "sell all" (routing v2 scheduler): a later buy without Earn extra is not opened by the consent left on chain; a consent asked for again and landed is; an open position is never held back', async () => {
  const w = world(), reader = createV2Reader(w.readerDeps);
  const sent: Call[][] = [], lines: string[] = [], led = ledger();
  const round = (since?: ConsentSinceSellAll) => v2AutoRound({ v2: W.v2, reader, account: W.account, portfolioId: 9, now: NOW, dryRun: false, send: async (calls: Call[]) => { sent.push(calls); return tx(sent.length); },
    ledger: led.l, log: (l: string) => lines.push(l), held: [W.NVDA], ...(since === undefined ? {} : { consentSince: async () => since }) });
  // Everything was sold with the session key: the policy is still enabled (10,000) and the new buy's 10 NVDAB sit free.
  consenting(w);
  assert.deepEqual([await round([]), sent.length], [null, 0]);
  assert.match(lines.at(-1) ?? '', /全部賣出後 owner 沒有再選加息/);
  // Earn extra ticked at the new buy, the UserOp never landed: the chain still holds the ceiling the request was to replace.
  assert.deepEqual([await round([{ [V2_CONSENT_KEY]: String(10_000n * E18) }]), sent.length], [null, 0]);
  // Ticked and landed (the new ceiling is never the old one): opened as on a first buy.
  w.state.policy = { ...w.state.policy, maxDebt: 10_000n * E18 + 1n };
  assert.match(await round([{ [V2_CONSENT_KEY]: String(10_000n * E18) }]) ?? '', /NVDAB open\(best_route\)/);
  assert.deepEqual([sent.length, sent[0]!.map(fn)], [1, ['executeOpen']]);
  // An account that never finished a "sell all", and a caller without the reader: unchanged.
  sent.length = 0;
  assert.match(await round(null) ?? '', /NVDAB open\(best_route\)/);
  assert.match(await round() ?? '', /NVDAB open\(best_route\)/);
  assert.equal(sent.length, 2);
  // A position is open (not sold out, or turned on by hand): the round manages it exactly as without the rule — in
  // particular it is not closed as "strategy turned off".
  const open = world(), sentOpen: Call[][] = [], linesOpen: string[] = [];
  openVenus(open);
  const args = (o: object) => ({ v2: W.v2, reader: createV2Reader(open.readerDeps), account: W.account, portfolioId: 9, now: NOW, dryRun: false, send: async (calls: Call[]) => { sentOpen.push(calls); return tx(sentOpen.length); },
    ledger: led.l, log: (l: string) => linesOpen.push(l), held: [W.NVDA], ...o });
  const plain = await v2AutoRound(args({})), plainSent = sentOpen.map(b => b.map(fn));
  sentOpen.length = 0;
  assert.equal(await v2AutoRound(args({ consentSince: async () => [] })), plain);
  assert.deepEqual(sentOpen.map(b => b.map(fn)), plainSent);
  assert.equal(linesOpen.some(l => /沒有再選加息|strategy turned off/.test(l)), false);
});

test('after "sell all" (routing v2 API): autoOpen reads off until Earn extra is chosen again; /auto writes the request with the ceiling it replaces and never repeats it', async () => {
  const w = world(), reader = createV2Reader(w.readerDeps);
  const notes: [Address, ConsentBefore][] = [];
  const api = (since: ConsentSinceSellAll) => createStrategyEarnV2Api({ v2: W.v2, reader, now: () => NOW, estimateGas: async () => 700_000n,
    consentSince: async () => since, noteConsent: async (account, before) => { notes.push([account, before]); } });
  consenting(w);
  const autoOpen = async (since: ConsentSinceSellAll) => (await api(since).portfolio(9, W.account)).autoOpen;
  assert.deepEqual([await autoOpen(null), await autoOpen([]), await autoOpen([{ [V2_CONSENT_KEY]: String(10_000n * E18) }]), await autoOpen([{ [V2_CONSENT_KEY]: '0' }])], [true, false, false, true]);
  const weights = [{ asset: W.NVDA, weightBps: 10_000 }];
  const ceiling = async (since: ConsentSinceSellAll) => { const r = await api(since).auto(W.account, W.owner, { budgetRaw: 1_000n * E18, weights, keyReady: true });
    if (r.status !== 'ready') throw new Error('auto not ready');
    return (decodeFunctionData({ abi: V2_REGISTRY_ABI, data: r.calls.find(c => c.to === W.v2.registry)!.data }).args as readonly [bigint, Address, boolean])[0]; };
  // Never sold: the ceiling already on chain is kept (it covers the plan) and nothing is written.
  assert.deepEqual([await ceiling(null), notes.length], [10_000n * E18, 0]);
  // Sold: one wei above the ceiling it replaces, and the request says which one that was.
  assert.equal(await ceiling([]), 10_000n * E18 + 1n);
  assert.deepEqual(notes, [[W.account, { [V2_CONSENT_KEY]: String(10_000n * E18) }]]);
  // Sold and the consent had been withdrawn on chain since: nothing to tell it from.
  w.state.policy = { ...w.state.policy, maxDebt: 0n, enabled: false };
  assert.ok(await ceiling([]) > 0n);
  assert.deepEqual(notes[1], [W.account, { [V2_CONSENT_KEY]: '0' }]);
});

// ---------------------------------------------------------------------------
// 2026-11-26: the audience only decides who may START on v2; an account that has anything there is always looked after
// ---------------------------------------------------------------------------
/** The scheduler's quiet round for one account (src/scheduler.ts `open`), with the v1 step counted. */
function quiet(w: ReturnType<typeof world>, v2 = W.v2, readerDeps: Parameters<typeof createV2Reader>[0] = w.readerDeps) {
  const reader = createV2Reader(readerDeps), sent: Call[][] = [], lines: string[] = [], led = ledger();
  const state = { v1: 0, v1Note: null as string | null };
  const step = { v2, reader, account: W.account, portfolioId: 9, now: NOW, dryRun: false, ledger: led.l, log: (l: string) => lines.push(l), held: [W.NVDA], send: async (calls: Call[]) => { sent.push(calls); return tx(sent.length); } };
  const round = (mayOpen: boolean) => v2QuietRound({ v2, reader, account: W.account, mayOpen, log: l => lines.push(l), v1: async () => { state.v1++; return state.v1Note; },
    v2Round: (touched, may) => v2AutoRound({ ...step, touched, mayOpen: may }) });
  return { reader, sent, lines, led, state, step, round };
}

test('2026-11-26 leftover loan token: consent withdrawn, no route, no vault — the quiet round still runs the v1 step AND sells the USDC / USD1 / U a close left behind; under 0.01 it is not worth a UserOp of its own', async () => {
  const w = world(WS), q = quiet(w, WS);
  // Turned off earlier: nothing on v2 any more except the recipient the turn-off kept, and 3 USDC the close left in the account.
  w.state.policy = { maxDebt: 0n, rewardRecipient: W.owner, strategyId: 57n, enabled: false };
  w.setBalance(USDC, W.account, 3n * E18); w.setAllowance(USDC, W.account, SWAPPER, maxUint256);
  // Until this fix the scheduler sent such an account to the v1 step alone ("nothing on v2") and the USDC stayed where it was.
  assert.match((await q.round(true))!, /USDC 已換回 USDT tx=0x0+1$/);
  assert.deepEqual([q.state.v1, q.sent.map(c => c.map(swapFn)), swapArgs(q.sent[0]![0]!).slice(0, 3)], [1, [['cashOut']], [USDC, maxUint256, 3n * E18 * 997n / 1_000n]]);
  // The v1 step's own note is kept next to it.
  q.state.v1Note = '[STRATEGY_EARN] v1 note';
  assert.match((await q.round(true))!, /^\[STRATEGY_EARN\] v1 note；\[STRATEGY_ROUTING\] 關閉後留在帳戶的 USDC 已換回 USDT/);
  q.state.v1Note = null;
  // The same for an owner who may no longer start on v2 (outside the audience, or new opens paused).
  q.sent.length = 0;
  assert.match((await q.round(false))!, /USDC 已換回 USDT/);
  assert.equal(q.sent.length, 1);
  // A leftover under V2_CASH_OUT_ALONE_MIN_RAW (0.01) is not sold on its own; at 0.01 it is.
  q.sent.length = 0; w.setBalance(USDC, W.account, V2_CASH_OUT_ALONE_MIN_RAW - 1n);
  assert.equal(await q.round(true), null);
  assert.equal(q.sent.length, 0);
  w.setBalance(USDC, W.account, V2_CASH_OUT_ALONE_MIN_RAW);
  assert.match((await q.round(true))!, /USDC 已換回 USDT/);
  // A failed leftover read never fails the round: the v1 step's answer stands and the next round looks again.
  const broken = quiet(w, WS, { ...w.readerDeps, v2: WS });
  const real = broken.reader.leftovers; broken.reader.leftovers = async () => { throw new Error('public node down'); };
  assert.equal(await broken.round(true), null);
  assert.ok(broken.lines.some(l => /leftover loan token not looked at this round/.test(l)));
  broken.reader.leftovers = real;
  // An account that never used v2: the v1 step alone, one request; on a deployment without a swapper nothing is looked for either.
  w.state.policy.rewardRecipient = '0x0000000000000000000000000000000000000000';
  const v1Before = q.state.v1, before = w.state.requests; q.sent.length = 0;
  assert.equal(await q.round(true), null);
  assert.deepEqual([q.state.v1 - v1Before, q.sent.length, w.state.requests - before], [1, 0, 1]);
});

test('an owner who may not start on v2 and whose account has nothing there costs one request every ten minutes, not one per round; anything on v2 is read every time', async () => {
  const w = world();
  let now = WORLD_START;
  const reader = createV2Reader({ ...w.readerDeps, now: () => now });
  const requests = async (work: () => Promise<unknown>) => { const before = w.state.requests; await work(); return w.state.requests - before; };
  assert.equal(V2_UNTOUCHED_TTL_MS, 10 * 60_000);
  assert.deepEqual([await requests(() => reader.touchedOutside(W.account)), await requests(() => reader.touchedOutside(W.account)), v2HasState(await reader.touchedOutside(W.account))], [1, 0, false]);
  // An owner in the audience is always read fresh (the account may have started on v2 a moment ago).
  assert.equal(await requests(() => reader.touched(W.account)), 1);
  now += V2_UNTOUCHED_TTL_MS + 1;
  assert.equal(await requests(() => reader.touchedOutside(W.account)), 1);
  // Something appears on v2 (the owner acted outside this backend, or the two services disagreed about the audience for
  // a while): seen at the next read, and from then on read every time.
  consenting(w, 0n);
  assert.equal(v2HasState(await reader.touchedOutside(W.account)), false); // still remembered as nothing...
  now += V2_UNTOUCHED_TTL_MS + 1;
  assert.deepEqual([v2HasState(await reader.touchedOutside(W.account)), await requests(() => reader.touchedOutside(W.account)), await requests(() => reader.touchedOutside(W.account))], [true, 1, 1]);
  // ...unless the keeper round's bulk read (every round) has seen it first: that refreshes the memory both ways.
  const w2 = world(), r2 = createV2Reader({ ...w2.readerDeps, now: () => WORLD_START });
  assert.deepEqual((await r2.touchedMany([W.account, W.owner])).map(t => t && v2HasState(t)), [false, false]);
  const before = w2.state.requests;
  await r2.touchedOutside(W.account); await r2.touchedOutside(W.owner);
  assert.equal(w2.state.requests - before, 0); // the bulk read answered for both
  consenting(w2, 0n);
  assert.equal(v2HasState(await r2.touchedOutside(W.account)), false);
  assert.deepEqual((await r2.touchedMany([W.account])).map(t => t && v2HasState(t)), [true]);
  assert.equal(v2HasState(await r2.touchedOutside(W.account)), true);
});

test('an account on v2 whose owner may no longer start there is still looked after in full — repaid, closed, unwound before a sale — and adds no risk: no top-up, no move; what has to be left is closed', async () => {
  const w = world(), q = quiet(w);
  const old = 1_795_000_000 - 30 * 86_400;
  openVenus(w, { since: old });
  // A fill since the position was opened: 5 more NVDAB free in the account. In the audience the round tops the position up.
  w.setBalance(W.NVDA, W.account, 5n * E18);
  assert.match((await q.round(true))!, /NVDAB open\(top_up\)/);
  assert.deepEqual(q.sent.map(c => c.map(fn)), [['executeOpen']]);
  // Outside the audience (or new opens paused): the position is read and held, nothing is borrowed on top; the v1 step is not run for it.
  q.sent.length = 0; q.state.v1 = 0;
  assert.equal(await q.round(false), null);
  assert.deepEqual([q.sent.length, q.state.v1], [0, 0]);
  assert.ok(q.lines.some(l => /NVDAB hold: nothing new starts on routing v2 for this account/.test(l)));
  // Its vault stopped paying (negative carry). In the audience: moved to the better vault. Outside: closed — never moved.
  w.setBalance(W.NVDA, W.account, 0n);
  w.state.holdings.clear(); w.state.holdings.set(w.ids.venusUsdt, { assets: 442n * E18, since: old });
  assert.match((await q.round(true))!, /NVDAB migrate\(negative_carry\)/);
  assert.deepEqual(q.sent.map(c => c.map(fn)), [['executeSwitchVault']]);
  q.sent.length = 0;
  assert.match((await q.round(false))!, /^\[STRATEGY_ROUTING\] 已執行：NVDAB close\(negative_carry\) tx=/);
  assert.deepEqual([q.sent.map(c => c.map(fn)), argsOf(q.sent[0]![0]!).slice(1, 5)], [[['executeReduce']], [w.ids.nvdaVenusUsdt, w.ids.venusUsdt, maxUint256, maxUint256]]);
  // The owner turns the strategy off (consent withdrawn): closed, exactly as in the audience.
  w.state.holdings.clear(); w.state.holdings.set(w.ids.aaveUsdt, { assets: 442n * E18, since: old });
  w.state.policy.enabled = false; q.sent.length = 0;
  assert.match((await q.round(false))!, /NVDAB close\(disabled\)/);
  assert.deepEqual(q.sent.map(c => c.map(fn)), [['executeReduce']]);
  // Before a sale: repay and take the shares back, whoever the owner is (the scheduler passes what it read and `mayOpen`).
  w.state.policy.enabled = true; q.sent.length = 0;
  const touched = await q.reader.touchedOutside(W.account);
  assert.equal(v2HasState(touched), true);
  assert.match(String(await v2UnwindForSale({ ...q.step, touched, mayOpen: false, steps: [{ tokenIn: W.NVDA, amountIn: 5n * E18 }] })), /^\[STRATEGY_EARN_UNWINDING\] 賣出前已還款取回/);
  assert.deepEqual(q.sent.map(c => c.map(fn)), [['executeReduce']]);
  // A clean account of such an owner: the v1 step only, and after the first look not even a request.
  const clean = world(), c = quiet(clean);
  clean.setBalance(W.NVDA, W.account, 10n * E18);
  assert.equal(await c.round(false), null);
  const before = clean.state.requests;
  assert.equal(await c.round(false), null);
  assert.deepEqual([c.state.v1, c.sent.length, clean.state.requests - before], [2, 0, 0]);
  // The public nodes do not answer: for such an owner the v1 step still runs (it never depended on them); for an owner in
  // the audience the round fails as it always did — his account may have just started on v2.
  const down = quiet(clean, W.v2, { ...clean.readerDeps, multicall: async () => { throw new Error('public node down'); } });
  assert.equal(await down.round(false), null);
  assert.deepEqual([down.state.v1, down.sent.length, down.lines.some(l => /routing v2 could not be read this round .*only the v1 step runs/.test(l))], [1, 0, true]);
  await assert.rejects(down.round(true), /public node down/);
  assert.equal(down.state.v1, 1);
  // Consent alone (given while the owner was in the audience, nothing opened yet): nothing is opened for it either.
  consenting(clean);
  const fresh = quiet(clean);
  assert.equal(await fresh.round(false), null);
  assert.deepEqual([fresh.sent.length, fresh.state.v1], [0, 0]);
  assert.match((await fresh.round(true))!, /NVDAB open\(best_route\)/);
});

test('keeper round: every account of the chain is asked in one bulk read (not one request each), and a position is watched whoever its owner is; accounts with nothing on v2 are not read further', async () => {
  const w = world(), chunks: (number | undefined)[] = [], lines: string[] = [], led = ledger(), sent: string[] = [];
  const reader = createV2Reader({ ...w.readerDeps, multicall: (reads, opts) => { if (reads.length > 100) chunks.push(opts?.chunk); return w.multicall(reads, opts); } });
  const stranger = '0x00000000000000000000000000000000000000d1' as Address; // an owner on nobody's canary list: the keeper never asks who owns what
  const others = Array.from({ length: 60 }, (_, i) => ('0x' + (0x5000 + i).toString(16).padStart(40, '0')) as Address);
  const mine = { account: W.account, portfolioId: 9, owner: stranger };
  const run = (accounts = [...others.map((account, i) => ({ account, portfolioId: 100 + i, owner: stranger })), mine]) => runV2KeeperRound({ dryRun: false, log: l => lines.push(l) }, { v2: W.v2, reader, ledger: led.l, accounts: async () => accounts,
    send: async (to, data) => { sent.push(to === W.v2.executor ? decodeFunctionData({ abi: V2_EXECUTOR_ABI, data }).functionName : 'claimReward'); return tx(sent.length); } });
  // Nobody has anything on v2: 61 accounts are one bulk read of 183 calls, cut 120 to a request (2 requests instead of
  // 61), and neither the market nor any account is read further.
  const before = { requests: w.state.requests, calls: w.state.calls };
  assert.deepEqual(await run(), { accounts: 61, managed: 0, checked: 0, deleveraged: 0, collected: 0, stranded: 0, failed: 0, writer: true });
  assert.deepEqual([w.state.requests - before.requests, w.state.calls - before.calls, chunks], [1, 183, [120]]);
  // The multicall itself: 183 reads at 120 per request are 2 eth_calls.
  let ethCalls = 0;
  const counting = v2Multicall({ call: async ({ data }: { data?: Hex }) => { ethCalls++;
    const n = (decodeFunctionData({ abi: parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'function aggregate3(Call3[] calls)']), data: data! }).args[0] as readonly unknown[]).length;
    return { data: encodeAbiParameters([{ type: 'tuple[]', components: [{ type: 'bool' }, { type: 'bytes' }] }], [Array.from({ length: n }, () => [false, '0x'] as const)]) }; } } as never);
  const read = { target: W.v2.registry, abi: V2_REGISTRY_ABI, functionName: 'accountRoutes', args: [W.account] };
  assert.deepEqual([(await counting(Array.from({ length: 183 }, () => read), { chunk: 120 })).length, ethCalls], [183, 2]);
  ethCalls = 0;
  assert.deepEqual([(await counting(Array.from({ length: 183 }, () => read))).length, ethCalls], [183, 5]); // 40 per request by default
  // An account with a position at its health line: deleveraged, although its owner is in no audience (the fixture's chain
  // answers the same for every account, so this round has the one account).
  openVenus(w);
  w.state.positions.get(w.ids.nvdaVenusUsdt)!.shouldDeleverage = true;
  const r = await run([mine]);
  assert.deepEqual([r.accounts, r.managed, r.checked, r.deleveraged, sent], [1, 1, 1, 1, ['executeDeleverage']]);
  // An account the bulk read cannot answer for is asked by itself (never taken for empty); when that fails too it is counted as failed.
  const partial = createV2Reader({ ...w.readerDeps, multicall: async (reads, opts) => { const out = await w.multicall(reads, opts); return opts?.chunk === 120 ? out.map((x, i) => i === 1 ? null : x) : out; } });
  const again = (reader2: typeof partial) => runV2KeeperRound({ dryRun: true, log: l => lines.push(l) }, { v2: W.v2, reader: reader2, ledger: led.l, accounts: async () => [mine], send: null });
  assert.deepEqual([(await again(partial)).managed, (await again(partial)).failed], [1, 0]);
  const blind = createV2Reader({ ...w.readerDeps, multicall: async (reads, opts) => { const out = await w.multicall(reads, opts); return reads.length === 3 ? out.map((x, i) => i === 1 ? null : x) : out; } });
  assert.deepEqual([(await again(blind)).managed, (await again(blind)).failed], [0, 1]);
});

const WORLD_START = NOW.getTime();

test('public nodes: one that does not answer costs a single short timeout, the next requests go straight to one that answers, and it is asked again after the cool-down; a revert is the answer, not a reason to ask elsewhere', async () => {
  const hits = { quiet: 0, good: 0, reverting: 0 };
  const answer = (name: 'good' | 'reverting') => createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; }); req.on('end', () => { hits[name]++; const id = (JSON.parse(body) as { id: number }).id; res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(name === 'good' ? { jsonrpc: '2.0', id, result: '0x61' } : { jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted' } })); });
  });
  const quietNode = createServer(req => { hits.quiet++; req.resume(); /* accepts the request and never answers */ }), good = answer('good'), reverting = answer('reverting');
  const urlOf = async (s: ReturnType<typeof createServer>) => { await new Promise<void>(r => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${(s.address() as AddressInfo).port}`; };
  const [quietUrl, goodUrl, revertingUrl] = [await urlOf(quietNode), await urlOf(good), await urlOf(reverting)];
  try {
    let now = 1_000_000;
    const ask = (t: ReturnType<typeof v2RpcTransport>) => t({ retryCount: 0 }).request({ method: 'eth_chainId' });
    const timed = async (work: () => Promise<unknown>) => { const at = performance.now(); const value = await work(); return { value, ms: performance.now() - at }; };
    const t = v2RpcTransport([quietUrl, goodUrl], { timeoutMs: 250, now: () => now });
    // The first request pays the quiet node's timeout once (250 ms here; 3.5 s in production, 12 s before) and is answered by the second node.
    const first = await timed(() => ask(t));
    assert.deepEqual([first.value, hits.quiet, hits.good], ['0x61', 1, 1]);
    assert.ok(first.ms >= 200 && first.ms < 2_000, `first request took ${first.ms} ms`);
    // The requests that follow do not wait for the quiet node at all.
    const second = await timed(() => ask(t));
    assert.deepEqual([second.value, hits.quiet, hits.good], ['0x61', 1, 2]);
    assert.ok(second.ms < 200, `second request took ${second.ms} ms`);
    now += V2_RPC_COOLDOWN_MS - 1; await ask(t);
    assert.deepEqual([hits.quiet, hits.good], [1, 3]);
    // After the cool-down the list order is back: the first node is asked again (and, still quiet, costs one timeout again).
    now += 2; await ask(t);
    assert.deepEqual([hits.quiet, hits.good], [2, 4]);
    // A node that answers "the call reverted" has answered: the error is the caller's, the next node is not asked, the node is not set aside.
    const r = v2RpcTransport([revertingUrl, goodUrl], { timeoutMs: 250, now: () => now });
    await assert.rejects(ask(r), /execution reverted/);
    await assert.rejects(ask(r), /execution reverted/);
    assert.deepEqual([hits.reverting, hits.good], [2, 4]);
    // Every node quiet: the request fails after one timeout each (the caller skips the round), it does not hang.
    const none = await timed(() => ask(v2RpcTransport([quietUrl, quietUrl], { timeoutMs: 100, now: () => now })).then(() => 'answered', () => 'failed'));
    assert.equal(none.value, 'failed');
    assert.ok(none.ms < 2_000, `two quiet nodes took ${none.ms} ms`);
    // Production numbers: 3.5 s per node (the paymaster's v1 / v2 check has 10 s), a minute of cool-down. Public nodes only.
    assert.deepEqual([V2_RPC_TIMEOUT_MS, V2_RPC_COOLDOWN_MS], [3_500, 60_000]);
    assert.throws(() => v2RpcTransport([]));
  } finally { for (const s of [quietNode, good, reverting]) { s.closeAllConnections(); s.close(); } }
});

test('minimum size (2026-11-26): a minimum buy opens, an amount under the floor is `too_small` (not temporarily unavailable), a venue minimum is read from the lens, and the public minimums follow', async () => {
  const w = world(), reader = createV2Reader(w.readerDeps);
  const api = createStrategyEarnV2Api({ v2: W.v2, reader, now: () => NOW });
  const weights = [{ asset: W.NVDA, weightBps: 5000 }, { asset: W.QQQ, weightBps: 5000 }];
  // Moolah's minimum loan (15 on the NVDAB Lista route) reaches the engine as a target debt: 15 ÷ 0.98. Venus has none.
  assert.deepEqual((await reader.market()).snapshot.options.NVDAB!.map(o => o.minBorrowUsd), [undefined, undefined, 15.306124]);
  // 50 USDT over two assets: NVDAB 25 × 30% = 7.50 (Venus), QQQB 25 × 35% = 8.75. Both open — the old 10 USD floor refused both.
  const buy = await api.auto(W.account, W.owner, { budgetRaw: 50n * E18, weights, keyReady: true });
  assert.deepEqual([buy.status, buy.assets.map(a => [a.asset, a.status, 'maxDebtRaw' in a ? a.maxDebtRaw : null]).sort()], ['ready', [['NVDAB', 'ready', (825n * E18 / 100n).toString()], ['QQQB', 'ready', (9625n * E18 / 1000n).toString()]]]);
  // 5 USDT: 0.75 and 0.875 — under 1 USD each. The answer says why.
  const tiny = await api.auto(W.account, W.owner, { budgetRaw: 5n * E18, weights, keyReady: true });
  assert.deepEqual({ ...tiny, assets: [...tiny.assets].sort((x, y) => x.asset.localeCompare(y.asset)) }, { status: 'unavailable', reason: 'too_small', message: 'Amount too small.', assets: [
    { asset: 'NVDAB', status: 'unavailable', reason: 'too_small', message: 'Amount too small.' }, { asset: 'QQQB', status: 'unavailable', reason: 'too_small', message: 'Amount too small.' }] });
  // 6 USDT: QQQB 3 × 35% = 1.05 opens, NVDAB 3 × 30% = 0.90 does not: the consent covers what opens.
  const part = await api.auto(W.account, W.owner, { budgetRaw: 6n * E18, weights, keyReady: true });
  assert.deepEqual([part.status, part.assets.map(a => [a.asset, a.status, 'reason' in a ? a.reason : null]).sort()], ['ready', [['NVDAB', 'unavailable', 'too_small'], ['QQQB', 'ready', null]]]);
  // The owner's own switch on a holding under the floor: the same answer (2 USD of NVDAB = 0.60).
  w.setBalance(W.NVDA, W.account, E18 / 75n);
  const open = await api.open(W.account, W.owner, { symbol: 'NVDAB', collateralRaw: E18 / 75n, weights, keyReady: true });
  assert.deepEqual(open, { status: 'unavailable', asset: 'NVDAB', reason: 'too_small', message: 'Amount too small.' });
  // What the public markets list carries: 1 USD ÷ ratio (NVDAB has Venus, which has no minimum).
  const round = (m: Record<string, number>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Math.round(v * 1e4) / 1e4]));
  assert.deepEqual(round(await api.minimums()), { QQQB: 2.8571, NVDAB: 3.3333 });

  // With only the Lista route left for NVDAB, Moolah's minimum is the limit: 25 USD (7.50) is too small, 60 USD (18.00) opens, and the minimum says 51.02.
  for (const [, r] of w.state.routes) if (r.venue === 1) r.retired = true;
  const w2reader = createV2Reader(w.readerDeps), api2 = createStrategyEarnV2Api({ v2: W.v2, reader: w2reader, now: () => NOW });
  w.setBalance(W.NVDA, W.account, 0n);
  const only = [{ asset: W.NVDA, weightBps: 10_000 }];
  const small = await api2.auto(W.account, W.owner, { budgetRaw: 25n * E18, weights: only, keyReady: true });
  assert.deepEqual([small.status, 'reason' in small ? small.reason : null, small.assets.map(a => [a.asset, a.status])], ['unavailable', 'too_small', [['NVDAB', 'unavailable']]]);
  const enough = await api2.auto(W.account, W.owner, { budgetRaw: 60n * E18, weights: only, keyReady: true });
  assert.deepEqual([enough.status, enough.assets.map(a => [a.asset, a.status])], ['ready', [['NVDAB', 'ready']]]);
  assert.deepEqual(round(await api2.minimums()), { QQQB: 2.8571, NVDAB: 51.0204 });
});
