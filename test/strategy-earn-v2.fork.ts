/** Routing v2 fork acceptance (opt-in, not in CI): FORK_RPC_URL=http://127.0.0.1:<port> bun test ./test/strategy-earn-v2.fork.ts --timeout=600000
 * Needs a local anvil fork of chain 97 taken after the draft6 v2 deployment and its cash swapper (block 144712650). Impersonation only; never touches a public chain.
 * Account: cre8-contracts RoutingDemoAccount of the draft6 set (enrolled in AtpRegistry, holds NVDAB, nothing on v1, every demo position closed). Every call is sent from
 * the account itself: exactly the calldata the owner's UserOp / the scheduler's session-key UserOp carries. Reads go through
 * the same reader the services use (AtpBorrowLensV2 + Multicall3), pointed at the fork.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { concatHex, createPublicClient, createTestClient, createWalletClient, decodeFunctionData, encodeFunctionData, http, maxUint256, pad, parseAbi, parseEther, toFunctionSelector } from 'viem';
import type { Address, Hex, Log } from 'viem';
import { bscTestnet } from 'viem/chains';
import { createStrategyEarnV2Api } from '../src/strategy-earn-v2-api.js';
import { createV2Reader, v2Multicall } from '../src/strategy-earn-v2-chain.js';
import { fromTestnetMocks, reportCalldata, reportDue, runRateReport } from '../src/strategy-earn-v2-rates.js';
import { runV2KeeperRound, v2AutoRound, v2QuietRound, v2UnwindForSale } from '../src/strategy-earn-v2-scheduler.js';
import type { V2Ledger, V2Tx } from '../src/strategy-earn-v2-scheduler.js';
import { strategyEarnV2, v2Calls, v2ConsentOffCall, v2RescueCall, v2SessionPermissions, v2SwapEvents, V2_CASH_OUT_ALONE_MIN_RAW, V2_CASH_OUT_MIN_RAW, V2_EXECUTOR_ABI, V2_REGISTRY_ABI, V2_SWAPPER_ABI, V2_SWAPPER_SELECTORS } from '../src/strategy-earn-v2.js';
import type { Call, RouteEvent } from '../src/strategy-earn-v2.js';
import { readStrategyEarnV2Collateral } from '../src/snapshot.js';
import type { RewardEvent } from '../src/strategy-rewards.js';
import { holdForShortfall, v2ShortfallUsdt } from '../src/sell-all-hold.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';

const rpc = process.env.FORK_RPC_URL;
const A = '0xd641d5aa6c479288e9c02f4862303c1070ed3fb1' as Address; // RoutingDemoAccount (draft6 set)
const OWNER = '0x09bbb9a06a0c49ad24bddb18808944041783054e' as Address; // AtpRegistry owner (lines, rates) and the demo account's reward recipient
const OPERATOR = '0xd8ce3295e05ca138e0d0d7214c4fd630c43f9d7f' as Address; // registry.rateReporter
const KEEPER = '0x4a07cdac26afdc89eb47d653a95b8abf6b1f4b0a' as Address;
const NVDAB = T.assets.NVDAB.token as Address;
const skip = rpc ? false : 'FORK_RPC_URL not set';
const FUND_ACCOUNT = '0x3a761e26ed26d417c7d59e259473f1b0ddcd04e5' as Address; // fund 40's account of the canary owner (testnet portfolio 12): enrolled in a public fund
const MIX_ACCOUNT = '0xc1f64db181e29912dcf8ffd1d70f6e1821ef97c1' as Address; // My mix 16's account of the same owner (testnet portfolio 30): enrolled in its own private strategy
const CANARY = '0xd3ab39b62e221bf9e8ba19fe19b2638767d3d6d9' as Address;
/** V2_FORK_TRACE=1 prints each step as it starts (a fork that has to fetch state can be slow; this shows where). */
const mark = (label: string) => { if (process.env.V2_FORK_TRACE === '1') console.error(`[v2 fork] ${new Date().toISOString().slice(11, 19)} ${label}`); };

/**
 * The receipt of a transaction on the fork. Anvil mines only when a transaction arrives, so viem's block watcher can wait
 * forever for a "next block" when its first receipt read raced the miner; a plain poll cannot.
 */
async function mined(client: { getTransactionReceipt(args: { hash: Hex }): Promise<{ status: string; logs: Log[]; blockNumber: bigint }> }, hash: Hex) {
  for (let i = 0; i < 1200; i++) {
    try { return await client.getTransactionReceipt({ hash }); } catch { await new Promise(r => setTimeout(r, 50)); }
  }
  throw new Error('no receipt for ' + hash);
}
function setup() {
  const v2 = strategyEarnV2(97, {})!;
  const transport = http(rpc, { timeout: 120_000 });
  const client = createPublicClient({ chain: bscTestnet, transport, pollingInterval: 100 });
  const local = createTestClient({ chain: bscTestnet, mode: 'anvil', transport });
  // The reader stamps a market read with its clock; here that is the fork's block time (the test moves time forward).
  let clock = Date.now();
  const reader = createV2Reader({ v2, multicall: v2Multicall(client), marketTtlMs: 0, bookTtlMs: 600_000, now: () => clock });
  const from = async (who: Address) => { await local.impersonateAccount({ address: who }); await local.setBalance({ address: who, value: parseEther('1') }); return createWalletClient({ chain: bscTestnet, account: who, transport }); };
  // One "UserOp" = the calls in order from the sender; logs re-indexed as if in one transaction.
  const sender = (who: Address) => async (calls: Call[]): Promise<V2Tx> => {
    const wallet = await from(who);
    const logs: Log[] = []; let last: Hex = '0x', block = 0n;
    for (const c of calls) {
      mark(`  send ${who.slice(0, 8)} -> ${c.to.slice(0, 10)} ${c.data.slice(0, 10)}`);
      const hash = await wallet.sendTransaction({ to: c.to, data: c.data, gas: 12_000_000n });
      const r = await mined(client, hash);
      if (r.status !== 'success') throw new Error(`reverted ${c.to} ${c.data.slice(0, 10)}`);
      for (const l of r.logs) logs.push({ ...l, logIndex: logs.length });
      last = hash; block = r.blockNumber;
    }
    return { hash: last, blockNumber: block, logs };
  };
  const routes: RouteEvent[] = [], rewards: RewardEvent[] = [];
  const ledger: V2Ledger = { routes: async (_c, e) => { routes.push(...e); }, rewards: async (_c, e) => { rewards.push(...e); } };
  const now = async () => { clock = Number((await client.getBlock()).timestamp) * 1000; return new Date(clock); };
  return { v2, client, local, reader, from, sender, ledger, routes, rewards, now, clock: () => new Date(clock) };
}
const names = (calls: readonly Call[], v2: { executor: Address; swapper?: Address | null }) => calls.map(c => c.to === v2.executor ? decodeFunctionData({ abi: V2_EXECUTOR_ABI, data: c.data }).functionName
  : c.to === v2.swapper ? decodeFunctionData({ abi: V2_SWAPPER_ABI, data: c.data }).functionName : c.data.startsWith('0x095ea7b3') ? 'approve' : c.to);
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)', 'function mint(address to, uint256 amount)']);

/**
 * The cash raise as the scheduler sends it: `planCashRaise` with the real redeem planner (oracle floor, routed step) and
 * the sale executed by the real AtpExecutor from the account — no played sale. A plain turn-off on a mix account that
 * holds no USDT at all: the owner repays what the box holds, the round reports the USDT it is short of, the portfolio sells
 * about 1 USDT of its free shares, and the next round tops up, closes and sells the leftover.
 * No months of time travel here: the price feeds must stay fresh for the sale (the fork's clock is held near its fork block),
 * which is also why this test comes first in the file — the ones below move the fork's clock by months.
 */
test('routing v2 fork, cash raise through the real AtpExecutor: a turn-off with no USDT at all ends clean after one small sale of free shares', { skip }, async () => {
  const { planCashRaise, cashRaiseUsdE8 } = await import('../src/scheduler.js');
  const { buildRedeemPlan } = await import('../src/operator.js');
  const { EXECUTOR_ABI } = await import('../src/chain.js');
  const s = setup(), { v2, reader, client } = s;
  const X = MIX_ACCOUNT, send = s.sender(X), lines: string[] = [];
  const USDT = v2.loanTokens.USDT!, USD1 = v2.loanTokens.USD1!, C = (T.assets.BTCB.token as string).toLowerCase() as Address, POOL = T.assets.BTCB.pool as Address, ATP = T.contracts.executor as Address;
  const bal = (token: Address, who: Address = X) => client.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [who] });
  const move = async (token: Address, from: Address, to: Address, amount: bigint) => { if (amount === 0n) return; const w = await s.from(from); const r = await mined(client, await w.writeContract({ address: token, abi: ERC20, functionName: 'transfer', args: [to, amount], gas: 300_000n })); assert.equal(r.status, 'success'); };
  const SINK = '0x000000000000000000000000000000000000dEaD' as Address;
  // Hold the fork's clock just after its fork block (anvil would otherwise stamp new blocks with the wall clock, hours later).
  const forked = await client.getBlock();
  await s.local.setNextBlockTimestamp({ timestamp: forked.timestamp + 12n }); await s.local.mine({ blocks: 1 });
  const multicall = v2Multicall(client), operator = s.sender(OPERATOR), chainNow = (await s.now()).getTime();
  await runRateReport({ v2, reader, multicall, now: () => chainNow, rates: book => fromTestnetMocks(v2, book, multicall), signer: { address: OPERATOR, send: async (to, data) => (await operator([{ to, data, value: '0' }])).hash } });
  reader.invalidate();
  const m = await reader.market();
  const before = await reader.account(X);
  assert.ok(before.enrollment !== null && before.routes.length === 0);
  const cash = { own: 0n };
  const booked: string[] = [];
  const ledger: V2Ledger = { ...s.ledger, swaps: async (_p, _a, events) => { for (const e of events) { booked.push(e.kind); const out = e.kind === 'top_up' || e.kind === 'repay_cash'; cash.own = out ? (cash.own > e.usdtRaw ? cash.own - e.usdtRaw : 0n) : cash.own + e.usdtRaw; } } };
  const cashClaims = async () => ({ claimedRaw: cash.own, ownRaw: cash.own });
  const needs: bigint[] = [], sent: string[][] = [];
  const tracked = async (calls: Call[]) => { sent.push(names(calls, v2) as string[]); return send(calls); };
  const step = async () => ({ v2, reader, account: X, portfolioId: 1, now: await s.now(), dryRun: false, send: tracked, ledger, log: (l: string) => lines.push(l), held: [C], cashClaims, onCashNeed: (n: bigint) => { needs.push(n); } });
  const api = createStrategyEarnV2Api({ v2, reader, now: s.clock, cashClaims, bookSwaps: (id, account, events) => ledger.swaps!(id, account, events), log: () => {} });

  mark('raise: fund, consent, open on Lista/USD1, move the money to the 0% vault, ten minutes');
  for (const token of [USDT, USD1, v2.loanTokens.USDC!, v2.loanTokens.U!, C]) await move(token, X, SINK, await bal(token));
  await move(C, POOL, X, await bal(C, POOL) / 2_000n);
  let read = await reader.account(X, [C]);
  let held = read.state.holdings.find(h => h.collateral === C)!;
  if (held.collateralUsd > 600 || held.collateralUsd < 300) {
    const want = held.freeCollateralRaw * 400n / BigInt(Math.max(1, Math.round(held.collateralUsd)));
    if (want < held.freeCollateralRaw) await move(C, X, SINK, held.freeCollateralRaw - want); else await move(C, POOL, X, want - held.freeCollateralRaw);
    read = await reader.account(X, [C]); held = read.state.holdings.find(h => h.collateral === C)!;
  }
  const total = held.freeCollateralRaw;
  const auto = await api.auto(X, CANARY, { budgetRaw: 0n, weights: [{ asset: C, weightBps: 10_000 }], keyReady: true });
  if (auto.status !== 'ready') throw new Error('consent unavailable');
  await send(auto.calls!);
  const route = m.routes.find(r => r.symbol === 'BTCB' && r.venue === 'lista' && r.loanSymbol === 'USD1')!;
  const zeroVault = m.vaults.find(v => v.venue === 'venus' && v.tokenSymbol === 'USD1')!;
  const goodVault = m.vaults.filter(v => v.tokenSymbol === 'USD1' && v.eligible && v.vaultId !== zeroVault.vaultId)[0]!;
  const soon = async () => BigInt(Math.floor((await s.now()).getTime() / 1000) + 600);
  await send([v2Calls.open(v2, X, route.routeId, goodVault.vaultId, total, BigInt(Math.round(held.collateralUsd * route.targetLtvBps / 10_000 * 0.9 * 1e6)) * 10n ** 12n, await soon())]);
  await send([v2Calls.switchVault(v2, X, goodVault.vaultId, zeroVault.vaultId, maxUint256, await soon())]);
  await s.local.increaseTime({ seconds: 600 }); await s.local.mine({ blocks: 1 });
  await s.now();
  read = await reader.account(X, [C]);
  const debt0 = read.tokens.USD1!.debtRaw;
  assert.ok(debt0 > read.vaults.reduce((sum, v) => sum + v.assetsRaw, 0n) && await bal(USDT) === 0n, 'a small gap, and no USDT at all in the account');

  mark('raise: the owner turns the strategy off');
  const off = await api.close(X, { symbols: ['BTCB'] });
  if (off.status !== 'ready') throw new Error('close not ready');
  assert.deepEqual(names(off.calls, v2), ['executeReduce', v2.registry]);
  for (const batch of off.batches) await send(batch);
  assert.equal(await v2AutoRound(await step()), null);
  assert.deepEqual([sent.length, needs.length], [0, 1]);
  const need = needs[0]!;

  mark('raise: planCashRaise with the real redeem planner, executed by the real AtpExecutor');
  read = await reader.account(X, [C]);
  const posted = read.routes[0]!.collateralRaw, free = await bal(C);
  assert.ok(posted > 0n && free > total * 97n / 100n);
  const oracle = await client.readContract({ address: ATP, abi: EXECUTOR_ABI, functionName: 'oracle' });
  const [unit] = await client.readContract({ address: oracle, abi: parseAbi(['function previewSwap(address,address,uint256) view returns(uint256,uint256)']), functionName: 'previewSwap', args: [C, USDT, 10n ** 18n] });
  const block = await client.getBlockNumber(), at = await s.now();
  // The scheduler's own view of the portfolio: holdings include the posted shares, which the plan must not offer.
  const holdings = [{ asset: C, amountWei: free + posted, decimals: 18, usdPriceE8: unit / 10n ** 10n, priceSource: 'oracle' as const }, { asset: USDT, amountWei: 0n, decimals: 18, usdPriceE8: 100_000_000n, priceSource: 'numeraire' as const }];
  const totalUsdE8 = (free + posted) * (unit / 10n ** 10n) / 10n ** 18n;
  const input = { portfolioId: 1, account: X, plan: { portfolioId: 1, strategyId: 1, account: X, chainId: 97, snapshot: { portfolioId: 1, block, nativeBalanceWei: 0n, holdings, unpriced: [], strategyEarnCollateral: [{ asset: C, marketId: route.routeId, amount: posted }] },
    targets: [{ asset: C, weightBps: 10_000 }, { asset: USDT, weightBps: 0 }], report: { totalUsdE8 }, thresholdBps: 100, blocked: [], pinnedVersion: { version: 1, onchainStrategyId: Number(before.enrollment!.strategyId), paused: false } } } as never;
  const plan = await planCashRaise(input, need, { chainId: 97, now: at, sell: async (i, usd) => (await buildRedeemPlan(i, { sellUsdE8: usd }, { publicClient: client as never, executor: ATP, registry: T.contracts.registry as Address, now: () => at })).plan });
  assert.equal(plan.kind, 'ready', JSON.stringify(plan, (_k, v) => typeof v === 'bigint' ? v.toString() : v));
  if (plan.kind !== 'ready') return;
  assert.deepEqual([plan.steps.length, plan.steps[0]!.tokenIn.toLowerCase(), plan.steps[0]!.tokenOut.toLowerCase(), plan.purpose], [1, C, USDT.toLowerCase(), undefined]);
  assert.ok(plan.steps[0]!.amountIn < free / 100n, 'a small part of the free shares');
  const wallet = await s.from(X);
  const sale = await mined(client, await wallet.writeContract({ address: ATP, abi: EXECUTOR_ABI, functionName: 'executeRebalance', args: [X, plan.steps.map(st => ({ tokenIn: st.tokenIn, tokenOut: st.tokenOut, amountIn: st.amountIn, amountOutMin: st.amountOutMin, venue: st.venue, data: st.data })), plan.deadline], gas: 3_000_000n }));
  assert.equal(sale.status, 'success', 'the small sale goes through the executor (floor, fee, venue allowlist)');
  const proceeds = await bal(USDT);
  cash.own += proceeds; // settleAllocatedCash: the receipt's cash delta becomes the portfolio's own cash
  assert.deepEqual([await bal(C), proceeds >= need, proceeds > 9n * 10n ** 17n && proceeds < 11n * 10n ** 17n], [free - plan.steps[0]!.amountIn, true, true], `sold ${plan.steps[0]!.amountIn} for ${proceeds} USDT (asked ${cashRaiseUsdE8(need)} e8, need ${need})`);

  mark('raise: the next round tops up, closes and sells the leftover');
  assert.match(await v2AutoRound(await step()) ?? '', /已執行：BTCB close\(disabled\)/);
  // Ten minutes of interest is a debt of a few 1e-5 USD1: the top-up's buffer leaves less than 0.000001 USD1 behind, which is
  // not worth a swap (it can come back as 0 USDT, spec §17) — so no cash-out here; anything of 0.000001 or more would be sold.
  assert.deepEqual([sent.flat().slice(0, 2), sent.flat().slice(2).every(n => n === 'cashOut'), booked[0]], [['topUp', 'executeReduce'], true, 'top_up']);
  read = await reader.account(X, [C]);
  assert.deepEqual([read.routes.filter(x => x.collateralRaw > 0n || x.routeDebtRaw > 0n).length, read.tokens.USD1!.debtRaw, read.tokens.USD1!.idleRaw, read.vaults.reduce((sum, v) => sum + v.assetsRaw, 0n), read.policy.enabled], [0, 0n, 0n, 0n, false]);
  const dust = await bal(USD1);
  assert.ok(dust < V2_CASH_OUT_MIN_RAW, `USD1 left in the account: ${dust} raw (under 0.000001)`);
  assert.deepEqual([await bal(C), await bal(USDT)], [total - plan.steps[0]!.amountIn, cash.own], 'every share but the sold ones is back, ledger == chain');
  console.log(JSON.stringify({ cashRaise: { needUsdt: need.toString(), askedUsdE8: cashRaiseUsdE8(need).toString(), soldRaw: plan.steps[0]!.amountIn.toString(), proceedsUsdt: proceeds.toString(), debt: debt0.toString(), ownCashAfter: cash.own.toString(), usd1DustRaw: dust.toString(), sent } }));
});

test('routing v2 fork: consent -> open on the best route -> hold -> vault left on a 0% vault is switched back -> rewards box -> account -> rate report -> deleverage at the health line -> repay before a sale -> full exit', { skip }, async () => {
  const s = setup(), { v2, reader, client } = s;
  assert.equal(await client.getChainId(), 97);
  const send = s.sender(A);
  const api = createStrategyEarnV2Api({ v2, reader, now: s.clock, recordRoutes: s.ledger.routes, recordRewards: s.ledger.rewards });
  const step = async (o: object = {}) => ({ v2, reader, account: A, portfolioId: 1, now: await s.now(), dryRun: false, send, ledger: s.ledger, log: (l: string) => lines.push(l), held: [NVDAB], ...o });
  const lines: string[] = [];

  // Market: 66 routes and 10 vaults discovered from the registry; nothing hard-coded.
  const m = await reader.market();
  assert.deepEqual([m.routes.length, m.vaults.length], [66, 10]);
  assert.ok((m.snapshot.options.NVDAB ?? []).length === 8, 'NVDAB: 4 Venus + 4 Lista routes');
  // Start clean: nothing on v2 for this account (the deployment drill closed everything).
  let read = await reader.account(A, [NVDAB]);
  assert.deepEqual([read.routes.length, read.vaults.length], [0, 0]);
  const held = read.state.holdings.find(h => h.collateral === NVDAB)!;
  assert.ok(held.freeCollateralRaw > 0n && held.collateralUsd > 100, 'demo account holds NVDAB');

  mark('consent');
  // 1. Owner consent (buy confirmation with Earn extra on): policy + both venues + approvals to the v2 executor only.
  const auto = await api.auto(A, OWNER, { budgetRaw: 0n, weights: [{ asset: NVDAB, weightBps: 10_000 }], keyReady: true });
  assert.equal(auto.status, 'ready');
  if (auto.status !== 'ready') return;
  await send(auto.calls);
  mark('consent sent');
  read = await reader.account(A, [NVDAB]);
  assert.deepEqual([read.consent, read.policy.rewardRecipient], [true, OWNER]);
  assert.equal((await api.portfolio(1, A)).autoOpen, true);

  mark('auto-open');
  // 2. Scheduler round after the fill: the engine picks today's best route and the session key opens it (one executeOpen).
  const opened = await v2AutoRound(await step());
  assert.match(opened ?? '', /已執行：NVDAB open\(best_route\)/);
  read = await reader.account(A, [NVDAB]);
  assert.equal(read.routes.length, 1);
  const pos = read.routes[0]!;
  // Lista NVDAB/USD1 pays the most on chain 97 (borrow 1.8% − 0.5%, vault 3.6% + 1.0%, collateral +1.0%).
  assert.deepEqual([pos.route.venue, pos.route.loanSymbol, pos.vault?.venue], ['lista', 'USD1', 'lista']);
  assert.ok(pos.collateralRaw === held.freeCollateralRaw && pos.routeDebtRaw > 0n && pos.ltvBps > 2800 && pos.ltvBps <= pos.targetLtvBps, `ltv ${pos.ltvBps}`);
  assert.deepEqual(s.routes.map(e => [e.kind, e.asset, e.venue, e.loan, e.vaultVenue, e.reason]), [['open', 'NVDAB', 'lista', 'USD1', 'lista', 'best_route']]);
  // The posted shares are still the portfolio's holding (snapshot), and the API shows the route it is really on.
  assert.deepEqual((await readStrategyEarnV2Collateral(client as never, A, await client.getBlockNumber())).map(c => [c.asset, c.amount]), [[NVDAB, pos.collateralRaw]]);
  const view = await api.portfolio(1, A);
  assert.deepEqual([view.positions.length, view.positions[0]!.asset, view.positions[0]!.route.source, view.positions[0]!.route.loan, view.autoOpen], [1, 'NVDAB', 'onchain', 'USD1', false]);
  mark('hold');
  // 3. Next round: nothing to do (2% under the target is not worth a top-up; no better route).
  assert.equal(await v2AutoRound(await step()), null);

  mark('vault switch');
  // 4. The money ends up in a vault that pays nothing (Venus vUSD1 at 0%: an owner switch, as in the deployment drill).
  //    Carry is now negative -> the next round moves the vault back at once, no 7-day wait (settled rule: negative carry is immediate).
  const venusVault = m.vaults.find(v => v.venue === 'venus' && v.tokenSymbol === 'USD1')!;
  await send([v2Calls.switchVault(v2, A, pos.vault!.vaultId, venusVault.vaultId, maxUint256, BigInt(Math.floor((await s.now()).getTime() / 1000) + 600))]);
  assert.equal((await reader.account(A, [NVDAB])).routes[0]!.vault!.vaultId, venusVault.vaultId);
  const moved = await v2AutoRound(await step());
  assert.match(moved ?? '', /NVDAB migrate\(negative_carry\)/);
  read = await reader.account(A, [NVDAB]);
  assert.equal(read.routes[0]!.vault!.venue, 'lista');
  assert.equal(s.routes.at(-1)!.kind, 'switch_vault');

  mark('rewards');
  // 5. Rewards: the simulated earn vault pays LISTA to the strategy box; the keeper moves it into the account (collectRewards).
  await s.local.increaseTime({ seconds: 30 * 86_400 }); await s.local.mine({ blocks: 1 });
  const keeper = s.sender(KEEPER);
  const k1 = await runV2KeeperRound({ dryRun: false, log: l => lines.push(l) }, { v2, reader, ledger: s.ledger, send: async (to, data) => keeper([{ to, data, value: '0' }]),
    accounts: async () => [{ account: A, portfolioId: 1, owner: OWNER }] });
  assert.ok(k1.collected === 1 && k1.failed === 0, JSON.stringify(k1) + lines.slice(-3).join('|'));
  read = await reader.account(A, [NVDAB]);
  assert.ok(read.rewards[0]!.accountRaw > 0n && read.rewards[0]!.boxRaw === 0n, 'LISTA is in the account, not the box');
  assert.ok(s.rewards.some(e => e.kind === 'claim' && e.holder === read.box));

  mark('rate report');
  // 6. Rate report (operator = registry.rateReporter): due once the stored report is 12 hours old; values read off the mocks.
  const multicall = v2Multicall(client);
  const operator = s.sender(OPERATOR);
  const report = () => runRateReport({ v2, reader, multicall, now: () => Number(0), rates: book => fromTestnetMocks(v2, book, multicall),
    signer: { address: OPERATOR, send: async (to, data) => (await operator([{ to, data, value: '0' }])).hash } });
  const chainNow = (await s.now()).getTime();
  const r1 = await runRateReport({ v2, reader, multicall, now: () => chainNow, rates: book => fromTestnetMocks(v2, book, multicall), signer: { address: OPERATOR, send: async (to, data) => (await operator([{ to, data, value: '0' }])).hash } });
  assert.deepEqual([r1.status, r1.status === 'sent' ? [r1.routes, r1.vaults] : null], ['sent', [66, 4]]);
  const r2 = await runRateReport({ v2, reader, multicall, now: () => chainNow + 60_000, rates: book => fromTestnetMocks(v2, book, multicall), signer: { address: OPERATOR, send: async () => { throw new Error('must not send'); } } });
  assert.deepEqual(r2, { status: 'skipped', reason: 'fresh' });
  const wrong = await runRateReport({ v2, reader, multicall, rates: book => fromTestnetMocks(v2, book, multicall), signer: { address: KEEPER, send: async () => { throw new Error('must not send'); } } });
  assert.match(wrong.status === 'skipped' ? wrong.reason : '', /rateReporter is/);
  void report; void reportCalldata; void reportDue;

  mark('deleverage');
  // 7. Health line: the owner tightens this route's lines (as in the deployment drill; the shared oracle is not touched).
  //    The venue says shouldDeleverage -> the keeper sends executeDeleverage, anyone-callable, from the box's vault.
  const registryOwner = await s.from(OWNER);
  const lineAbi = parseAbi(['function setLtvConfig(bytes32 routeId, uint256 target, uint256 deleverage)']);
  await mined(client, await registryOwner.writeContract({ address: v2.registry, abi: lineAbi, functionName: 'setLtvConfig', args: [pos.route.routeId, 10n ** 17n, 2n * 10n ** 17n] }));
  const before = (await reader.account(A, [NVDAB])).routes[0]!;
  assert.equal(before.shouldDeleverage, true);
  const k2 = await runV2KeeperRound({ dryRun: false, log: l => lines.push(l) }, { v2, reader, ledger: s.ledger, send: async (to, data) => keeper([{ to, data, value: '0' }]),
    accounts: async () => [{ account: A, portfolioId: 1, owner: OWNER }] });
  assert.equal(k2.deleveraged, 1, lines.slice(-3).join('|'));
  const after = (await reader.account(A, [NVDAB])).routes[0]!;
  assert.ok(after.routeDebtRaw < before.routeDebtRaw && !after.shouldDeleverage && after.ltvBps <= 1010, `ltv ${after.ltvBps}`);
  assert.deepEqual([s.routes.at(-1)!.kind, s.routes.at(-1)!.reason], ['deleverage', 'safety_line']);
  await mined(client, await registryOwner.writeContract({ address: v2.registry, abi: lineAbi, functionName: 'setLtvConfig', args: [pos.route.routeId, 0n, 0n] }));

  mark('pre-sell');
  // 8. Before a sale of the posted shares: repay first, take them back (session key); the sale waits a round.
  const selling = await v2UnwindForSale({ ...await step(), steps: [{ tokenIn: NVDAB, amountIn: held.freeCollateralRaw }] });
  assert.match(String(selling ?? ''), /\[STRATEGY_EARN_UNWINDING\] 賣出前已還款取回：NVDAB/);
  read = await reader.account(A, [NVDAB]);
  assert.equal(read.routes.filter(r => r.collateralRaw > 0n || r.routeDebtRaw > 0n).length, 0);
  assert.equal(read.state.holdings.find(h => h.collateral === NVDAB)!.freeCollateralRaw, held.freeCollateralRaw, 'every share is back in the account');
  assert.equal(s.routes.at(-1)!.kind, 'close');
  // The surplus interest came back in the loan token (USD1) and was sold for USDT in the same UserOp (cash swapper): the
  // account is left with no USD1 worth selling.
  assert.ok(read.tokens.USD1!.cashRaw < V2_CASH_OUT_MIN_RAW, `USD1 left in the account: ${read.tokens.USD1!.cashRaw}`);
  assert.ok(lines.some(l => /"msg":"strategy_cash_swap".*"kind":"cash_out"/.test(l)), 'the cash-out is in the log');

  mark('exit');
  // 9. Consent is still on: the next quiet round opens again. Then the owner turns everything off as a full exit:
  //    close + rewards to the owner's wallet + consent withdrawn, in the UserOps the API cuts.
  assert.match(await v2AutoRound(await step()) ?? '', /NVDAB open\(best_route\)/);
  const ownerLista = async () => client.readContract({ address: v2.rewardTokens[0]!, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [OWNER] });
  const listaBefore = await ownerLista();
  await s.now();
  const off = await api.close(A, { symbols: ['NVDAB'], exit: true });
  assert.equal(off.status, 'ready');
  if (off.status !== 'ready') throw new Error('close not ready');
  // Reopened seconds ago: the vault holds the debt and no certain surplus yet -> the plain close (a leftover, if any, is the next round's).
  assert.deepEqual(names(off.calls, v2).filter(n => n !== 'topUp' && n !== 'cashOut'), ['executeReduce', 'executeSweepRewards', v2.registry]);
  for (const batch of off.batches) { const tx = await send(batch); await api.confirm(1, A, OWNER, tx); }
  read = await reader.account(A, [NVDAB]);
  assert.deepEqual([read.routes.filter(r => r.collateralRaw > 0n).length, read.consent, read.rewards[0]!.accountRaw, read.rewards[0]!.boxRaw], [0, false, 0n, 0n]);
  assert.ok(await ownerLista() > listaBefore, 'reward tokens reached the owner\'s wallet');
  assert.ok(s.rewards.some(e => e.kind === 'sweep' && e.recipient === OWNER));
  assert.equal(await api.active(A), false);
  assert.equal(await v2AutoRound(await step()), null, 'consent withdrawn: the scheduler leaves the account alone');
  console.log(JSON.stringify({ routes: s.routes.map(e => `${e.kind}:${e.reason ?? 'owner'}`), rewards: s.rewards.map(e => `${e.kind}:${e.amountRaw}`), lines: lines.length }));
});

/**
 * 2026-11-26: the audience only decides who may START on v2. An account that opened while its owner was in it is, once the
 * owner is outside it (or new opens are paused), still read, watched by the keeper and closed by the session key — it only
 * adds nothing. And loan token left in an account whose strategy is off (no route, no vault) is sold by the quiet round.
 */
test('routing v2 fork, owner outside the audience: an existing position is held (no top-up), watched by the keeper, closed when consent is withdrawn; leftover USD1 after that is sold for USDT, a 0.005 leftover is not', { skip }, async () => {
  const s = setup(), { v2, reader, client } = s;
  const send = s.sender(A), lines: string[] = [], sent: Call[][] = [];
  const tracked = async (calls: Call[]) => { sent.push(calls); return send(calls); };
  const api = createStrategyEarnV2Api({ v2, reader, now: s.clock, recordRoutes: s.ledger.routes, recordRewards: s.ledger.rewards });
  const step = async () => ({ v2, reader, account: A, portfolioId: 1, now: await s.now(), dryRun: false, send: tracked, ledger: s.ledger, log: (l: string) => lines.push(l), held: [NVDAB] });
  let v1 = 0;
  const round = async (mayOpen: boolean) => v2QuietRound({ v2, reader, account: A, mayOpen, log: l => lines.push(l), v1: async () => { v1++; return null; },
    v2Round: async (touched, may) => v2AutoRound({ ...await step(), touched, mayOpen: may }) });
  const balance = (token: Address) => client.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [A] });

  // In the audience: consent, then the quiet round opens on the best route.
  const auto = await api.auto(A, OWNER, { budgetRaw: 0n, weights: [{ asset: NVDAB, weightBps: 10_000 }], keyReady: true });
  if (auto.status !== 'ready') throw new Error('consent not ready');
  await send(auto.calls);
  assert.match(await round(true) ?? '', /已執行：NVDAB open\(best_route\)/);
  let read = await reader.account(A, [NVDAB]);
  const pos = read.routes[0]!;
  assert.ok(read.routes.length === 1 && pos.routeDebtRaw > 0n);

  mark('outside the audience: hold');
  // The owner is no longer in the audience. The position is read and left as it is: nothing sent, the v1 step is not run for it.
  sent.length = 0; v1 = 0;
  assert.equal(await round(false), null);
  assert.deepEqual([sent.length, v1], [0, 0]);
  // The keeper never asks who owns an account: the position is found by the bulk read and checked against its health line.
  const kept = await runV2KeeperRound({ dryRun: true, log: l => lines.push(l) }, { v2, reader, send: null, ledger: s.ledger,
    accounts: async () => [{ account: A, portfolioId: 1, owner: '0x00000000000000000000000000000000000000d1' as Address }, { account: KEEPER, portfolioId: 2, owner: KEEPER }] });
  assert.deepEqual([kept.accounts, kept.managed, kept.checked, kept.failed], [2, 1, 1, 0]);

  mark('consent withdrawn: the session key closes');
  // The owner withdraws consent without closing (the recipient stays on the policy): the next quiet round closes the position
  // with the session key — `executeReduce` and the cash swapper only, nothing the paymaster calls 'risk'.
  await send([v2ConsentOffCall(v2, OWNER)]);
  const closed = await round(false);
  assert.match(closed ?? '', /已執行：NVDAB close\(disabled\)/);
  assert.ok(sent.flat().every(c => ['executeReduce', 'topUp', 'cashOut', 'executeRelease'].includes(names([c], v2)[0] as string)), names(sent.flat(), v2).join(','));
  read = await reader.account(A, [NVDAB]);
  assert.deepEqual([read.routes.filter(r => r.collateralRaw > 0n || r.routeDebtRaw > 0n).length, read.consent], [0, false]);
  assert.deepEqual(await readStrategyEarnV2Collateral(client as never, A, await client.getBlockNumber()), []);

  mark('leftover loan token');
  // Strategy off, no route: whatever a later round still has to release is released first; then the account is "nothing on
  // v2 now" — exactly the state the scheduler used to send to the v1 step alone.
  for (let i = 0; i < 3; i++) await round(false);
  const touched = await reader.touched(A);
  assert.deepEqual([touched.enabled, touched.routes.length, touched.vaults.length, touched.rewardRecipient], [false, 0, 0, OWNER]);
  const usd1 = v2.loanTokens.USD1!, usdt = v2.loanTokens.USDT!;
  const minter = await s.from(OWNER);
  const have = await balance(usd1);
  // 0.005 USD1 on top of the dust that is there: under 0.01, not worth a UserOp of its own.
  await mined(client, await minter.writeContract({ address: usd1, abi: ERC20, functionName: 'mint', args: [A, V2_CASH_OUT_ALONE_MIN_RAW / 2n - have], gas: 500_000n }));
  sent.length = 0; v1 = 0;
  assert.equal(await round(false), null);
  assert.deepEqual([sent.length, v1], [0, 1]);
  // 3 USD1: sold for USDT by the same quiet round, next to the v1 step.
  await mined(client, await minter.writeContract({ address: usd1, abi: ERC20, functionName: 'mint', args: [A, 3n * 10n ** 18n], gas: 500_000n }));
  const usdtBefore = await balance(usdt);
  assert.match(await round(false) ?? '', /USD1 已換回 USDT tx=0x/);
  assert.deepEqual([names(sent.flat(), v2), v1], [['cashOut'], 2]);
  assert.ok(await balance(usd1) < V2_CASH_OUT_MIN_RAW && await balance(usdt) - usdtBefore > 2_990_000_000_000_000_000n, 'USD1 became USDT');
  console.log(JSON.stringify({ closed, usd1Left: String(await balance(usd1)), usdtGained: String(await balance(usdt) - usdtBefore) }));
});

test('routing v2 fork: an urgent move to another borrow market is one executeMigrate; executeRescue hands the box\'s receipts back only once the token is no longer owed', { skip }, async () => {
  const s = setup(), { v2, reader } = s;
  const send = s.sender(A);
  const api = createStrategyEarnV2Api({ v2, reader, now: s.clock });
  const lines: string[] = [];
  const step = async () => ({ v2, reader, account: A, portfolioId: 1, now: await s.now(), dryRun: false, send, ledger: s.ledger, log: (l: string) => lines.push(l), held: [NVDAB] });
  const deadline = async () => BigInt(Math.floor((await s.now()).getTime() / 1000) + 600);
  const m = await reader.market();
  const auto = await api.auto(A, OWNER, { budgetRaw: 0n, weights: [{ asset: NVDAB, weightBps: 10_000 }], keyReady: true });
  if (auto.status !== 'ready') throw new Error('consent unavailable');
  await send(auto.calls);
  // The owner opens on a route that is NOT the best one (Venus NVDAB/USDT into Aave), then its vault goes to 0% (vUSDT).
  const route = m.routes.find(r => r.symbol === 'NVDAB' && r.venue === 'venus' && r.loanSymbol === 'USDT')!;
  const aave = m.vaults.find(v => v.venue === 'aave' && v.tokenSymbol === 'USDT')!, vUsdt = m.vaults.find(v => v.venue === 'venus' && v.tokenSymbol === 'USDT')!;
  const read0 = await reader.account(A, [NVDAB]);
  const free = read0.state.holdings.find(h => h.collateral === NVDAB)!;
  const borrow = BigInt(Math.floor(free.collateralUsd * 0.25)) * 10n ** 18n;
  await send([v2Calls.open(v2, A, route.routeId, aave.vaultId, free.freeCollateralRaw, borrow, await deadline())]);
  await send([v2Calls.switchVault(v2, A, aave.vaultId, vUsdt.vaultId, maxUint256, await deadline())]);
  // Negative carry on Venus/USDT -> the best route overall is on Lista in another loan token: one atomic executeMigrate
  // (the old USDT debt is repaid from the USDT vault plus the account's own USDT, the new token is borrowed into its vault).
  const moved = await v2AutoRound(await step());
  assert.match(moved ?? '', /NVDAB migrate\(negative_carry\)/, lines.join('|'));
  let read = await reader.account(A, [NVDAB]);
  const open = read.routes.filter(r => r.collateralRaw > 0n);
  assert.deepEqual(open.map(r => [r.route.venue, r.route.loanSymbol]), [['lista', 'USD1']]);
  assert.deepEqual(s.routes.filter(e => e.kind === 'migrate').map(e => [e.venue, e.loan, e.reason]), [['lista', 'USD1', 'negative_carry']]);

  // Rescue (owner only): refused while USD1 is owed, works once the route is repaid; the receipts land in the account.
  const vault = open[0]!.vault!;
  assert.deepEqual(await api.rescue(A, vault.vaultId), { status: 'unavailable', reason: 'debt_outstanding', message: 'Temporarily unavailable.' });
  await assert.rejects(send([v2RescueCall(v2, A, vault.vaultId, await deadline())]));
  // Repay the debt from the account's own USD1 only (the vault holding stays in the box), then rescue.
  const usd1 = v2.loanTokens.USD1!, tokenAbi = parseAbi(['function mint(address to, uint256 amount)', 'function balanceOf(address) view returns (uint256)']);
  const minter = await s.from(OWNER);
  await mined(s.client, await minter.writeContract({ address: usd1, abi: tokenAbi, functionName: 'mint', args: [A, open[0]!.routeDebtRaw * 2n], gas: 500_000n }));
  read = await reader.account(A, [NVDAB]);
  assert.ok(read.tokens.USD1!.cashRaw > open[0]!.routeDebtRaw, 'the fork owner could mint test USD1');
  await send([v2Calls.reduce(v2, A, open[0]!.route.routeId, ('0x' + '00'.repeat(32)) as Hex, maxUint256, maxUint256, read.tokens.USD1!.cashRaw, await deadline())]);
  read = await reader.account(A, [NVDAB]);
  const boxHolding = read.vaults.find(v => v.vault.vaultId === vault.vaultId);
  assert.ok(boxHolding && boxHolding.assetsRaw > 0n, 'the vault holding is still in the box');
  await s.now();
  const rescue = await api.rescue(A, vault.vaultId);
  assert.equal(rescue.status, 'ready');
  if (rescue.status === 'ready') await send(rescue.calls);
  assert.ok(await s.client.readContract({ address: vault.receipt, abi: tokenAbi, functionName: 'balanceOf', args: [A] }) > 0n, 'the vault shares are the account\'s now');
  assert.equal((await reader.account(A, [NVDAB])).vaults.length, 0);
});

test('routing v2 fork: the deployed CallPolicy (0.0.4) enforces the v2 session scope — six functions, account pinned, v2 executor only, never executeRescue', { skip }, async () => {
  const { toCallPolicy, CallPolicyVersion } = await import('@zerodev/permissions/policies');
  const { encodeCallDataEpV07 } = await import('@zerodev/sdk');
  const { sessionCallPermissions } = await import('../src/permissions.js');
  const s = setup(), { v2, client } = s;
  const wallet = '0x' + '5b'.repeat(20) as Address; // any wallet: CallPolicy state is per (id, msg.sender)
  const w = await s.from(wallet);
  // The whole scope a canary account's renewal installs: plain + yield + v1 borrow + routing v2.
  const policy = toCallPolicy({ policyAddress: T.contracts.callPolicy as Address, policyVersion: CallPolicyVersion.V0_0_4,
    permissions: sessionCallPermissions(T.contracts.executor as Address, wallet, wallet, undefined, { executor: v2.executor, account: wallet, swapper: v2.swapper! }) });
  const id = pad(`0x${Date.now().toString(16).slice(-8).padStart(8, '0')}`, { size: 32, dir: 'right' });
  const abi = parseAbi(['function onInstall(bytes data) payable',
    'struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }',
    'function checkUserOpPolicy(bytes32 id, PackedUserOperation userOp) payable returns (uint256)']);
  const r = await mined(client, await w.writeContract({ address: T.contracts.callPolicy as Address, abi, functionName: 'onInstall', args: [concatHex([id, policy.getPolicyData()])], gas: 6_000_000n }));
  assert.equal(r.status, 'success');
  const check = async (calls: { to: Address; data: Hex }[]) => {
    const callData = await encodeCallDataEpV07(calls.map(c => ({ to: c.to, data: c.data, value: 0n })));
    try {
      const { result } = await client.simulateContract({ account: wallet, address: T.contracts.callPolicy as Address, abi, functionName: 'checkUserOpPolicy',
        args: [id, { sender: wallet, nonce: 0n, initCode: '0x', callData, accountGasLimits: pad('0x', { size: 32 }), preVerificationGas: 0n, gasFees: pad('0x', { size: 32 }), paymasterAndData: '0x', signature: '0x' }] });
      return result === 0n ? 'ok' : 'denied';
    } catch { return 'denied'; }
  };
  const R = ('0x' + 'a1'.repeat(32)) as Hex, V = ('0x' + 'b1'.repeat(32)) as Hex, D = 2_000_000_000n, other = '0x' + '66'.repeat(20) as Address;
  const lista = v2.rewardTokens[0]!;
  const six = (who: Address): [string, Call][] => [['executeOpen', v2Calls.open(v2, who, R, V, 1n, 1n, D)], ['executeReduce', v2Calls.reduce(v2, who, R, V, 1n, 1n, 0n, D)],
    ['executeMigrate', v2Calls.migrate(v2, who, { routeId: R, vaultId: V }, { routeId: V, vaultId: R }, 1n, 0n, D)], ['executeSwitchVault', v2Calls.switchVault(v2, who, V, R, 1n, D)],
    ['executeRelease', v2Calls.release(v2, who, V, D)], ['executeSweepRewards', v2Calls.sweepRewards(v2, who, lista, 0n, D)]];
  assert.deepEqual(v2SessionPermissions(v2.executor, wallet).map(p => p.selector), six(wallet).map(([, c]) => c.data.slice(0, 10)));
  for (const [name, call] of six(wallet)) assert.equal(await check([call]), 'ok', name);
  // Three markets in one UserOp (the scheduler's batch size), and a mixed exit batch.
  assert.equal(await check([v2Calls.open(v2, wallet, R, V, 1n, 1n, D), v2Calls.open(v2, wallet, V, V, 1n, 1n, D), v2Calls.open(v2, wallet, R, R, 1n, 1n, D)]), 'ok');
  assert.equal(await check([v2Calls.close(v2, wallet, R, V, 0n, D), v2Calls.release(v2, wallet, V, D), v2Calls.sweepRewards(v2, wallet, lista, maxUint256, D)]), 'ok');
  // Another account in argument 0: every one of the six is refused.
  for (const [name, call] of six(other)) assert.equal(await check([call]), 'denied', name + ' for another account');
  // Owner-only and anyone-callable entry points, the registry, the venues, approvals, and the same selectors on another contract.
  assert.equal(await check([v2RescueCall(v2, wallet, V, D)]), 'denied', 'executeRescue');
  assert.equal(await check([v2Calls.open(v2, wallet, R, V, 1n, 1n, D), v2RescueCall(v2, wallet, V, D)]), 'denied', 'executeRescue after an allowed call');
  assert.equal(await check([v2Calls.deleverage(v2, wallet, R, V)]), 'denied', 'executeDeleverage');
  assert.equal(await check([v2Calls.collectRewards(v2, wallet, lista)]), 'denied', 'collectRewards');
  assert.equal(await check([{ to: v2.registry, data: encodeFunctionData({ abi: V2_REGISTRY_ABI, functionName: 'setStrategyPolicy', args: [1n, wallet, true] }) }]), 'denied', 'setStrategyPolicy');
  assert.equal(await check([{ to: v2.venusComptroller, data: encodeFunctionData({ abi: parseAbi(['function updateDelegate(address,bool)']), functionName: 'updateDelegate', args: [v2.executor, true] }) }]), 'denied');
  assert.equal(await check([{ to: v2.moolah, data: encodeFunctionData({ abi: parseAbi(['function setAuthorization(address,bool)']), functionName: 'setAuthorization', args: [v2.executor, true] }) }]), 'denied');
  assert.equal(await check([{ to: lista, data: encodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), functionName: 'approve', args: [v2.executor, maxUint256] }) }]), 'denied', 'approve');
  assert.equal(await check([{ ...v2Calls.open(v2, wallet, R, V, 1n, 1n, D), to: T.contracts.executor as Address }]), 'denied', 'v2 selector on AtpExecutor');
  assert.equal(await check([{ ...v2Calls.open(v2, wallet, R, V, 1n, 1n, D), to: v2.registry }]), 'denied', 'v2 selector on the registry');
  assert.ok(!v2SessionPermissions(v2.executor, wallet).some(p => p.selector === toFunctionSelector('executeRescue(address,bytes32,uint256)')));
  // Cash swapper (spec §17): exactly topUp and cashOut on the swapper; its owner functions, any other selector, the same
  // selectors on another contract, and approvals to it are refused.
  const usdc = v2.loanTokens.USDC!, swapper = v2.swapper!;
  assert.deepEqual(v2SessionPermissions(v2.executor, wallet, swapper).slice(6).map(p => [p.target, p.selector]), V2_SWAPPER_SELECTORS.map(sel => [swapper, sel]));
  assert.equal(await check([v2Calls.topUp(v2, usdc, 1n, D)]), 'ok', 'topUp');
  assert.equal(await check([v2Calls.cashOut(v2, usdc, maxUint256, 0n, D)]), 'ok', 'cashOut');
  assert.equal(await check([v2Calls.topUp(v2, usdc, 1n, D), v2Calls.close(v2, wallet, R, V, 0n, D), v2Calls.cashOut(v2, usdc, maxUint256, 0n, D)]), 'ok', 'top-up + close + cash-out in one UserOp');
  assert.equal(await check([v2Calls.topUp(v2, usdc, 1n, D), v2Calls.migrate(v2, wallet, { routeId: R, vaultId: V }, { routeId: V, vaultId: R }, 1n, 0n, D)]), 'ok', 'top-up + migrate');
  const owned = parseAbi(['function setPool(address token, address pool)', 'function setLimits(uint16 maxPegBps, uint16 bufferBps)', 'function shortfall(address account, address token)']);
  assert.equal(await check([{ to: swapper, data: encodeFunctionData({ abi: owned, functionName: 'setPool', args: [usdc, other] }) }]), 'denied', 'setPool');
  assert.equal(await check([{ to: swapper, data: encodeFunctionData({ abi: owned, functionName: 'setLimits', args: [100, 500] }) }]), 'denied', 'setLimits');
  assert.equal(await check([{ to: swapper, data: encodeFunctionData({ abi: owned, functionName: 'shortfall', args: [wallet, usdc] }) }]), 'denied', 'shortfall as a transaction');
  assert.equal(await check([v2Calls.topUp(v2, usdc, 1n, D), { to: swapper, data: encodeFunctionData({ abi: owned, functionName: 'setPool', args: [usdc, other] }) }]), 'denied', 'setPool after an allowed call');
  assert.equal(await check([{ ...v2Calls.topUp(v2, usdc, 1n, D), to: v2.registry }]), 'denied', 'topUp selector on the registry');
  assert.equal(await check([{ ...v2Calls.cashOut(v2, usdc, 1n, 0n, D), to: T.contracts.executor as Address }]), 'denied', 'cashOut selector on AtpExecutor');
  assert.equal(await check([{ to: v2.loanTokens.USDT!, data: encodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), functionName: 'approve', args: [swapper, maxUint256] }) }]), 'denied', 'approve to the swapper');
  // A key installed before the swapper (executor scope only) cannot reach it at all.
  const oldPolicy = toCallPolicy({ policyAddress: T.contracts.callPolicy as Address, policyVersion: CallPolicyVersion.V0_0_4,
    permissions: sessionCallPermissions(T.contracts.executor as Address, wallet, wallet, undefined, { executor: v2.executor, account: wallet }) });
  const oldId = pad(`0x${(Date.now() + 1).toString(16).slice(-8).padStart(8, '0')}`, { size: 32, dir: 'right' });
  assert.equal((await mined(client, await w.writeContract({ address: T.contracts.callPolicy as Address, abi, functionName: 'onInstall', args: [concatHex([oldId, oldPolicy.getPolicyData()])], gas: 6_000_000n }))).status, 'success');
  const checkOld = async (call: { to: Address; data: Hex }) => {
    const callData = await encodeCallDataEpV07([{ to: call.to, data: call.data, value: 0n }]);
    try { const { result } = await client.simulateContract({ account: wallet, address: T.contracts.callPolicy as Address, abi, functionName: 'checkUserOpPolicy',
      args: [oldId, { sender: wallet, nonce: 0n, initCode: '0x', callData, accountGasLimits: pad('0x', { size: 32 }), preVerificationGas: 0n, gasFees: pad('0x', { size: 32 }), paymasterAndData: '0x', signature: '0x' }] }); return result === 0n ? 'ok' : 'denied'; } catch { return 'denied'; }
  };
  assert.deepEqual([await checkOld(v2Calls.topUp(v2, usdc, 1n, D)), await checkOld(v2Calls.open(v2, wallet, R, V, 1n, 1n, D))], ['denied', 'ok']);
});

test('routing v2 fork, cash swapper: a USD1 route whose vault earned less than the loan cost cannot be closed; topUp from the account\'s USDT -> close -> cashOut leaves the account with USDT only; the 24-hour window stops a second lap', { skip }, async () => {
  const s = setup(), { v2, reader, client } = s;
  const send = s.sender(A), lines: string[] = [];
  const api = createStrategyEarnV2Api({ v2, reader, now: s.clock });
  const step = async (o: object = {}) => ({ v2, reader, account: A, portfolioId: 1, now: await s.now(), dryRun: false, send, ledger: s.ledger, log: (l: string) => lines.push(l), held: [NVDAB], ...o });
  const deadline = async () => BigInt(Math.floor((await s.now()).getTime() / 1000) + 600);
  const USDT = v2.loanTokens.USDT!, USD1 = v2.loanTokens.USD1!, swapper = v2.swapper!;
  const bal = (token: Address, who: Address = A) => client.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [who] });
  assert.equal((await client.readContract({ address: swapper, abi: V2_SWAPPER_ABI, functionName: 'executor' })).toLowerCase(), v2.executor);

  // Start with no loan token other than USDT in the account (the deployment drill left some USD1 behind): what this test
  // ends with is then only what the flow itself leaves.
  for (const token of [v2.loanTokens.USDC!, USD1, v2.loanTokens.U!]) {
    const left = await bal(token);
    if (left > 0n) { const w = await s.from(A); await mined(client, await w.writeContract({ address: token, abi: ERC20, functionName: 'transfer', args: [OWNER, left], gas: 200_000n })); }
  }
  mark('swapper: consent');
  // 1. Consent: besides the usual calls, USDT and USDC / USD1 / U are approved to the swapper (the account never did).
  const auto = await api.auto(A, OWNER, { budgetRaw: 0n, weights: [{ asset: NVDAB, weightBps: 10_000 }], keyReady: true });
  if (auto.status !== 'ready') throw new Error('consent unavailable');
  assert.equal(names(auto.calls!, v2).filter(n => n === 'approve').length >= 4, true);
  await send(auto.calls!);
  let read = await reader.account(A, [NVDAB]);
  assert.ok(Object.values(read.swapperAllowances).every(x => x === maxUint256) && Object.keys(read.swapperAllowances).length === 4, JSON.stringify(read.swapperAllowances, (_k, v) => typeof v === 'bigint' ? v.toString() : v));
  // A second consent asks for none of them again.
  const again = await api.auto(A, OWNER, { budgetRaw: 0n, weights: [{ asset: NVDAB, weightBps: 10_000 }], keyReady: true });
  if (again.status !== 'ready') throw new Error('consent unavailable');
  assert.ok(!again.calls!.some(c => c.data.startsWith('0x095ea7b3') && c.data.toLowerCase().includes(swapper.slice(2))), 'no swapper approval is repeated');

  mark('swapper: open, then the vault pays nothing for 60 days');
  // 2. Open on today's best route (Lista NVDAB/USD1, session key), then the money sits in Venus vUSD1 at 0% while the loan costs 1.8%.
  const gas = { open: { estimate: 0n, used: 0n } };
  const m = await reader.market();
  assert.match(await v2AutoRound(await step({ send: async (calls: Call[]) => {
    // Gas: what a plain eth_estimateGas says for this executeOpen against what it uses (the sender doubles the bundler's estimate).
    gas.open.estimate = await client.estimateGas({ account: A, to: calls[0]!.to, data: calls[0]!.data });
    const wallet = await s.from(A), hash = await wallet.sendTransaction({ to: calls[0]!.to, data: calls[0]!.data, gas: gas.open.estimate * 2n });
    const r = await mined(client, hash);
    if (r.status !== 'success') throw new Error('executeOpen ran out of gas at twice the estimate');
    gas.open.used = (r as unknown as { gasUsed: bigint }).gasUsed;
    return { hash, blockNumber: r.blockNumber, logs: r.logs };
  } })) ?? '', /NVDAB open\(best_route\)/);
  read = await reader.account(A, [NVDAB]);
  const pos = read.routes[0]!;
  assert.deepEqual([pos.route.venue, pos.route.loanSymbol], ['lista', 'USD1']);
  const venusVault = m.vaults.find(v => v.venue === 'venus' && v.tokenSymbol === 'USD1')!;
  await send([v2Calls.switchVault(v2, A, pos.vault!.vaultId, venusVault.vaultId, maxUint256, await deadline())]);
  await s.local.increaseTime({ seconds: 60 * 86_400 }); await s.local.mine({ blocks: 1 });
  await s.now();
  read = await reader.account(A, [NVDAB]);
  const q = read.tokens.USD1!.swap!;
  // The swapper's own numbers: a gap (debt above the box), a cap = (debt − idle) × 1.01, no window open (one opened by an
  // earlier test on the same fork is 60 days stale); the route cannot be closed.
  assert.ok(q.gapRaw !== null && q.gapRaw > 0n && q.capRaw > q.gapRaw && q.windowEndsAt * 1000 < s.clock().getTime(), JSON.stringify(q, (_k, v) => typeof v === 'bigint' ? v.toString() : v));
  assert.ok(read.tokens.USD1!.debtRaw > read.vaults.reduce((sum, v) => sum + v.assetsRaw, 0n), 'the vault holds less than the debt');
  await assert.rejects(send([v2Calls.close(v2, A, pos.route.routeId, venusVault.vaultId, 0n, await deadline())]), /reverted/, 'VaultShortfall without a top-up');

  mark('swapper: no USDT -> the sale frees what the box can repay');
  // 3. Before a sale with no USDT in the account: nothing to top up with -> repay what the box holds, take back that share (as before the swapper).
  const usdt0 = await bal(USDT);
  if (usdt0 > 0n) { const w = await s.from(A); await mined(client, await w.writeContract({ address: USDT, abi: ERC20, functionName: 'transfer', args: [OWNER, usdt0], gas: 200_000n })); }
  const dry = await v2UnwindForSale({ ...await step({ dryRun: true }), steps: [{ tokenIn: NVDAB, amountIn: pos.collateralRaw }] });
  assert.match(String(dry ?? ''), /short of USD1/);

  mark('swapper: USDT in the account -> topUp + close + cashOut');
  // 4. With USDT in the account (10 USDT: a little cash, far more than the gap): one "UserOp" tops up, closes and sells the leftover.
  const funder = await s.from(OWNER);
  try { await mined(client, await funder.writeContract({ address: USDT, abi: ERC20, functionName: 'mint', args: [A, 10n * 10n ** 18n], gas: 300_000n })); } catch { /* not mintable by this owner: fall through to a transfer */ }
  if (await bal(USDT) === 0n) { const holder = await s.from(v2.swapperPools![0]!); await mined(client, await holder.writeContract({ address: USDT, abi: ERC20, functionName: 'transfer', args: [A, 10n * 10n ** 18n], gas: 300_000n })); }
  const usdtBefore = await bal(USDT), collateralBefore = await bal(NVDAB);
  assert.equal(usdtBefore, 10n * 10n ** 18n);
  const sentCalls: Call[][] = [];
  const txs: V2Tx[] = [];
  const selling = await v2UnwindForSale({ ...await step({ send: async (calls: Call[]) => { sentCalls.push(calls); const tx = await send(calls); txs.push(tx); return tx; } }), steps: [{ tokenIn: NVDAB, amountIn: pos.collateralRaw }] });
  assert.match(String(selling ?? ''), /賣出前已還款取回：NVDAB top up \d+ USD1 from USDT, repay \d+ USD1, take back, sell the USD1 left/);
  assert.deepEqual(sentCalls.map(c => names(c, v2)), [['topUp', 'executeReduce', 'cashOut']]);
  read = await reader.account(A, [NVDAB]);
  const swaps = txs.flatMap(tx => v2SwapEvents(v2, tx, A));
  assert.deepEqual(swaps.map(e => [e.kind, e.token]), [['top_up', USD1], ['cash_out', USD1]]);
  const [topped, cashed] = swaps as [typeof swaps[number], typeof swaps[number]];
  // Bought what was planned (the gap + buffer), paid within 0.3% of 1:1; sold everything left, got within 0.3% of 1:1.
  assert.ok(topped.tokenRaw > q.gapRaw! && topped.tokenRaw < q.capRaw && topped.usdtRaw <= topped.tokenRaw * 1_003n / 1_000n + 1n, `${topped.tokenRaw} for ${topped.usdtRaw}`);
  assert.ok(cashed.usdtRaw >= cashed.tokenRaw * 997n / 1_000n, `${cashed.tokenRaw} for ${cashed.usdtRaw}`);
  // The route is closed, every share is back, the box is empty, and the account holds USDT only: no USD1, USDC or U.
  assert.deepEqual([read.routes.filter(r => r.collateralRaw > 0n || r.routeDebtRaw > 0n).length, read.tokens.USD1!.debtRaw, read.tokens.USD1!.idleRaw, await bal(NVDAB) - collateralBefore], [0, 0n, 0n, pos.collateralRaw]);
  assert.deepEqual([await bal(USD1), await bal(v2.loanTokens.USDC!), await bal(v2.loanTokens.U!)], [0n, 0n, 0n]);
  const usdtAfter = await bal(USDT);
  // What the round trip cost in USDT is the gap itself plus the swap fees on the buffer: well under 1% of the debt.
  assert.equal(usdtAfter, usdtBefore - topped.usdtRaw + cashed.usdtRaw);
  assert.ok(usdtBefore - usdtAfter < read.state.principalUsdRaw + pos.routeDebtRaw / 50n, `cost ${usdtBefore - usdtAfter}`);
  assert.ok(lines.filter(l => /"msg":"strategy_cash_swap"/.test(l)).length === 2, 'both swaps are in the log');
  assert.deepEqual(s.routes.at(-1)!.kind, 'close');

  mark('swapper: the window');
  // 5. The 24-hour window of USD1 is open now and carries what was bought.
  const [start, bought] = await client.readContract({ address: swapper, abi: V2_SWAPPER_ABI, functionName: 'topUpWindowOf', args: [A, USD1] });
  assert.ok(start > 0n && bought === topped.tokenRaw);
  // A top-up with nothing owed is refused by the contract (NoShortfall / no debt): a leaked key cannot park USDT in the box.
  await assert.rejects(send([v2Calls.topUp(v2, USD1, 10n ** 18n, await deadline())]), /reverted/);
  // Leftover follow-up: nothing is left to sell, so the next round does nothing at all.
  assert.deepEqual((await reader.leftovers(A)).map(l => [l.symbol, l.cashRaw]), [['USDC', 0n], ['USD1', 0n], ['U', 0n]]);
  // Turn the strategy off (owner) so the account ends clean.
  const off = await api.close(A, { symbols: [] });
  if (off.status === 'ready' && off.calls.length > 0) for (const batch of off.batches) await send(batch);
  console.log(JSON.stringify({ gap: q.gapRaw!.toString(), cap: q.capRaw.toString(), toppedUp: topped.tokenRaw.toString(), usdtIn: topped.usdtRaw.toString(), cashedOut: cashed.tokenRaw.toString(), usdtOut: cashed.usdtRaw.toString(),
    openGas: { estimate: gas.open.estimate.toString(), used: gas.open.used.toString() } }));
});

/**
 * The portfolio has no USDT the cash ledger does not claim (what every real user's account looks like): a route in USD1
 * whose box is a little short must still close cleanly — on a plain turn-off and on a sell-all with the strategy on — for
 * both kinds of account. The scheduler's sale pipeline and Postgres are not part of a fork test: a sale is played by moving
 * the sold shares out and its USDT proceeds in (booked as the portfolio's own cash, as settleAllocatedCash does), and the
 * cash ledger by the two numbers the strategy reads from it. Everything on the v2 side is the real code on the real contracts.
 */
for (const [kind, loan] of [['fund', 'USD1'], ['mix', 'USDT'], ['mix', 'USD1'], ['fund', 'USDT']] as const) {
  test(`routing v2 fork, no USDT outside the cash ledger (${kind} account, ${loan} route): turn-off and sell-all with the strategy on both end with no debt, no posted collateral, no loan token left and a ledger equal to the chain balance`, { skip }, async () => {
    const { cashRaiseUsdE8 } = await import('../src/scheduler.js');
    const s = setup(), { v2, reader, client } = s;
    const X = kind === 'fund' ? FUND_ACCOUNT : MIX_ACCOUNT, send = s.sender(X), lines: string[] = [];
    const USDT = v2.loanTokens.USDT!, USD1 = v2.loanTokens.USD1!, swaps = loan !== 'USDT';
    const bal = (token: Address, who: Address = X) => client.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [who] });
    const move = async (token: Address, from: Address, to: Address, amount: bigint) => { if (amount === 0n) return; const w = await s.from(from); const r = await mined(client, await w.writeContract({ address: token, abi: ERC20, functionName: 'transfer', args: [to, amount], gas: 300_000n })); assert.equal(r.status, 'success'); };
    const SINK = '0x000000000000000000000000000000000000dEaD' as Address;
    // An asset of the account's own enrolled strategy that has a Lista route in this loan token and a pool to take test shares from.
    const before = await reader.account(X);
    assert.ok(before.enrollment !== null && before.routes.length === 0, 'the account is enrolled and holds nothing on v2');
    // Earlier tests on this fork moved its clock by months: the rate reporter's numbers are refreshed first (as the API
    // service does every 12 hours), so the vaults read as they do on the live chain.
    const multicall = v2Multicall(client), operator = s.sender(OPERATOR), chainNow = (await s.now()).getTime();
    await runRateReport({ v2, reader, multicall, now: () => chainNow, rates: book => fromTestnetMocks(v2, book, multicall), signer: { address: OPERATOR, send: async (to, data) => (await operator([{ to, data, value: '0' }])).hash } });
    reader.invalidate();
    const m = await reader.market();
    const assets = await client.readContract({ address: T.contracts.registry as Address, abi: parseAbi(['function historicalAssets(uint256) view returns (address[])']), functionName: 'historicalAssets', args: [before.enrollment!.strategyId] });
    const profile = Object.entries(T.assets as Record<string, { token: string; pool: string }>);
    const picked = profile.find(([symbol, a]) => assets.some(x => x.toLowerCase() === a.token.toLowerCase()) && m.routes.some(r => r.symbol === symbol && r.venue === 'lista' && r.loanSymbol === loan));
    assert.ok(picked, `the strategy has an asset with a Lista ${loan} route`);
    const [SYMBOL, { token: C0, pool: POOL }] = picked!, C = C0.toLowerCase() as Address;
    const route = m.routes.find(r => r.symbol === SYMBOL && r.venue === 'lista' && r.loanSymbol === loan)!;
    // The cash ledger as the strategy sees it: the portfolio's own cash, and money other buckets claim (a fund here has 25
    // USDT waiting for a running buy job — never the strategy's to spend; the mix has no USDT at all).
    const cash = { own: 0n, others: kind === 'fund' ? 25n * 10n ** 18n : 0n };
    const booked: { kind: string; usdtRaw: bigint }[] = [];
    const ledger: V2Ledger = { ...s.ledger, swaps: async (_p, _a, events) => { for (const e of events) { booked.push({ kind: e.kind, usdtRaw: e.usdtRaw }); const out = e.kind === 'top_up' || e.kind === 'repay_cash'; cash.own = out ? (cash.own > e.usdtRaw ? cash.own - e.usdtRaw : 0n) : cash.own + e.usdtRaw; } } };
    const cashClaims = async () => ({ claimedRaw: cash.own + cash.others, ownRaw: cash.own });
    const needs: bigint[] = [];
    const step = async (o: object = {}) => ({ v2, reader, account: X, portfolioId: 1, now: await s.now(), dryRun: false, send, ledger, log: (l: string) => lines.push(l), held: [C], cashClaims, onCashNeed: (n: bigint) => { needs.push(n); }, ...o });
    const api = createStrategyEarnV2Api({ v2, reader, now: s.clock, cashClaims, bookSwaps: (id, account, events) => ledger.swaps!(id, account, events), log: () => {} });
    /** The account's USDT is exactly what the ledger claims: nothing unclaimed, and never a deficit. */
    const ledgerMatchesChain = async (when: string) => assert.equal(await bal(USDT), cash.own + cash.others, `${when}: chain USDT == ledger`);
    const tag = `${kind}/${loan}`;

    mark(`${tag}: fund the account`);
    for (const token of [USDT, USD1, v2.loanTokens.USDC!, v2.loanTokens.U!, C]) await move(token, X, SINK, await bal(token));
    await move(USDT, v2.swapperPools![0]!, X, cash.others);
    await move(C, POOL as Address, X, await bal(C, POOL as Address) / 2_000n);
    let read = await reader.account(X, [C]);
    let held = read.state.holdings.find(h => h.collateral === C)!;
    // About 400 USD of it, whatever the test token is priced at.
    if (held.collateralUsd > 600 || held.collateralUsd < 300) {
      const want = held.freeCollateralRaw * 400n / BigInt(Math.max(1, Math.round(held.collateralUsd)));
      if (want < held.freeCollateralRaw) await move(C, X, SINK, held.freeCollateralRaw - want); else await move(C, POOL as Address, X, want - held.freeCollateralRaw);
      read = await reader.account(X, [C]); held = read.state.holdings.find(h => h.collateral === C)!;
    }
    assert.ok(held.collateralUsd > 300 && held.collateralUsd < 600, `${SYMBOL} worth ${held.collateralUsd}`);
    const total = held.freeCollateralRaw, usdPerUnitE18 = BigInt(Math.round(held.collateralUsd * 1e6)) * 10n ** 30n / total;
    /** A sale through the portfolio's own pipeline, played: the shares leave, the USDT proceeds arrive and are booked as its own cash. */
    const sell = async (amount: bigint) => { const proceeds = amount * usdPerUnitE18 / 10n ** 18n * 997n / 1_000n; await move(C, X, SINK, amount); await move(USDT, v2.swapperPools![0]!, X, proceeds); cash.own += proceeds; return proceeds; };
    await ledgerMatchesChain('start');

    mark(`${tag}: consent, open on Lista/${loan} into a vault that pays nothing, 60 days`);
    const auto = await api.auto(X, CANARY, { budgetRaw: 0n, weights: [{ asset: C, weightBps: 10_000 }], keyReady: true });
    if (auto.status !== 'ready') throw new Error('consent unavailable: ' + JSON.stringify(auto));
    await send(auto.calls!);
    // The session key's own call, on the route under test (which route is best today is the engine's business, not this test's).
    // It borrows into the token's best open vault; then the money is moved to Venus (0% on chain 97), where it earns less
    // than the loan costs (the contract refuses to open straight into a vault that pays less than the loan).
    const zeroVault = m.vaults.find(v => v.venue === 'venus' && v.tokenSymbol === loan)!;
    const goodVault = m.vaults.filter(v => v.tokenSymbol === loan && v.eligible && v.vaultId !== zeroVault.vaultId).sort((x, y) => (y.supplyBps + y.incentiveBps) - (x.supplyBps + x.incentiveBps))[0]!;
    const borrow = BigInt(Math.round(held.collateralUsd * route.targetLtvBps / 10_000 * 0.9 * 1e6)) * 10n ** 12n;
    const soon = async () => BigInt(Math.floor((await s.now()).getTime() / 1000) + 600);
    await send([v2Calls.open(v2, X, route.routeId, goodVault.vaultId, total, borrow, await soon())]);
    await send([v2Calls.switchVault(v2, X, goodVault.vaultId, zeroVault.vaultId, maxUint256, await soon())]);
    read = await reader.account(X, [C]);
    const pos = read.routes[0]!;
    assert.deepEqual([pos.route.venue, pos.route.loanSymbol, pos.collateralRaw, read.vaults.filter(v => v.assetsRaw > 0n).map(v => v.vault.vaultId)], ['lista', loan, total, [zeroVault.vaultId]]);
    await s.local.increaseTime({ seconds: 60 * 86_400 }); await s.local.mine({ blocks: 1 });
    await s.now();
    read = await reader.account(X, [C]);
    const debt0 = read.tokens[loan]!.debtRaw, gap0 = debt0 - read.vaults.reduce((sum, v) => sum + v.assetsRaw, 0n) - read.tokens[loan]!.idleRaw;
    assert.ok(gap0 > 0n && gap0 < debt0 / 50n, `the box holds a little less than the debt: gap ${gap0} of ${debt0}`);
    if (swaps) assert.equal(read.tokens[loan]!.swap!.usdtRaw, cash.others, 'the account holds no USDT but what the ledger reserves');
    assert.equal(await bal(USDT), cash.others);
    const snapshot = await s.local.snapshot();
    const clean = async (what: string, collateralLeft: bigint) => {
      const r = await reader.account(X, [C]);
      assert.deepEqual([r.routes.filter(x => x.collateralRaw > 0n || x.routeDebtRaw > 0n).length, r.tokens[loan]!.debtRaw, r.tokens[loan]!.idleRaw, r.vaults.reduce((sum, v) => sum + v.assetsRaw, 0n)], [0, 0n, 0n, 0n], `${what}: no debt, nothing posted, the box is empty`);
      assert.deepEqual([await bal(USD1), await bal(v2.loanTokens.USDC!), await bal(v2.loanTokens.U!)], [0n, 0n, 0n], `${what}: no loan token other than USDT is left`);
      assert.equal(await bal(C), collateralLeft, `${what}: shares in the account`);
      await ledgerMatchesChain(what);
      return r;
    };
    // What the finishing UserOp carries and what the ledger books from its receipt, per kind of route.
    const closing = swaps ? ['topUp', 'executeReduce', 'cashOut'] : ['executeReduce'];
    const bookedKinds = () => booked.map(b => b.kind);
    const spent = () => booked.filter(b => b.kind === 'top_up' || b.kind === 'repay_cash').reduce((n, b) => n + b.usdtRaw, 0n), back = () => booked.filter(b => b.kind === 'cash_out' || b.kind === 'vault_cash').reduce((n, b) => n + b.usdtRaw, 0n);

    // ---- A. Sell everything with the strategy on ----------------------------------------------------------------
    mark(`${tag}: sell-all, round 1 — the box repays what it holds`);
    const all = [{ tokenIn: C, amountIn: total }];
    const sent: string[][] = [];
    const tracked = async (calls: Call[]) => { sent.push(names(calls, v2) as string[]); return send(calls); };
    const r1 = await v2UnwindForSale({ ...await step({ send: tracked }), steps: all, exit: true });
    assert.match(String(r1), new RegExp(`short of ${loan}: repay \\d+, take back \\d+ of \\d+; the sale pays the rest`));
    assert.deepEqual(sent, [['executeReduce']]);
    read = await reader.account(X, [C]);
    const free1 = await bal(C), left1 = read.routes[0]!;
    assert.ok(free1 > total * 97n / 100n && free1 < total && left1.collateralRaw === total - free1 && left1.routeDebtRaw > 0n && left1.routeDebtRaw < debt0 / 50n, `freed ${free1} of ${total}, debt left ${left1.routeDebtRaw}`);
    await ledgerMatchesChain('after round 1');
    mark(`${tag}: sell-all, round 2 — nothing more can be repaid: the sale goes ahead with the free shares`);
    const r2 = await v2UnwindForSale({ ...await step({ send: tracked }), steps: all, exit: true });
    assert.ok(r2 !== null && typeof r2 === 'object', `round 2 answers "sell what is free": ${JSON.stringify(r2, (_k, v) => typeof v === 'bigint' ? v.toString() : v)}`);
    const wait = r2 as { stuck: Address[]; needUsdtRaw: bigint; note: string };
    assert.deepEqual([wait.stuck, sent.length], [[C], 1]);
    assert.ok(wait.needUsdtRaw > left1.routeDebtRaw - 10n ** 12n && wait.needUsdtRaw < left1.routeDebtRaw * 2n + 10n ** 15n, `needs ${wait.needUsdtRaw} USDT for a debt of ${left1.routeDebtRaw}`);
    const afterRound2 = await s.local.snapshot();
    const proceeds1 = await sell(free1);
    await ledgerMatchesChain('after the first sale');
    // 2026-11-25 portfolio 37: here the app withdrew the sale's USDT. While the "sell all" is open the hold keeps what the
    // repayment still needs (src/sell-all-hold.ts): the app (and the paymaster) only let the rest go — and round 3 still closes.
    mark(`${tag}: sell-all, a withdrawal attempted mid-way — the hold stays, the rest leaves`);
    const hold = holdForShortfall(v2ShortfallUsdt(v2, await reader.account(X, [C])));
    assert.ok(hold >= 10n ** 18n && hold >= wait.needUsdtRaw && hold < proceeds1, `hold ${hold} for a need of ${wait.needUsdtRaw}`);
    const withdrawn = cash.own - hold;
    await move(USDT, X, SINK, withdrawn); cash.own -= withdrawn;
    await ledgerMatchesChain('after the mid-way withdrawal');
    mark(`${tag}: sell-all, round 3 — the sale's USDT pays the rest, the route closes`);
    const r3 = await v2UnwindForSale({ ...await step({ send: tracked }), steps: [{ tokenIn: C, amountIn: total - free1 }], exit: true });
    assert.match(String(r3), swaps ? new RegExp(`${SYMBOL} top up \\d+ ${loan} from USDT, repay \\d+ ${loan}, take back, sell the ${loan} left`) : new RegExp(`${SYMBOL} repay \\d+ USDT, take back`));
    assert.deepEqual(sent.slice(1), [closing]);
    assert.deepEqual(bookedKinds().slice(0, swaps ? 2 : 1), swaps ? ['top_up', 'cash_out'] : ['repay_cash']);
    await clean('after the close', total - free1);
    assert.equal(holdForShortfall(v2ShortfallUsdt(v2, await reader.account(X, [C]))), 0n, 'repaid: nothing is held any more, everything is withdrawable');
    mark(`${tag}: sell-all, round 4 — nothing is posted any more: the rest is sold`);
    assert.equal(await v2UnwindForSale({ ...await step({ send: tracked }), steps: [{ tokenIn: C, amountIn: total - free1 }], exit: true }), null);
    const proceeds2 = await sell(total - free1);
    await clean('sell-all done', 0n);
    // Everything is USDT the owner can take back: both sales' proceeds less what the strategy cost.
    assert.equal(cash.own, proceeds1 + proceeds2 - withdrawn - spent() + back());
    assert.ok(spent() - back() < left1.routeDebtRaw * 102n / 100n + 10n ** 15n, 'the strategy cost about the gap itself');
    assert.equal(await bal(USDT) - cash.own, cash.others, 'the reserved USDT was never spent');
    const sellAll = { reduced: sent[0], closed: sent[1], booked: booked.map(b => `${b.kind}:${b.usdtRaw}`), debtLeftAfterRound1: left1.routeDebtRaw.toString(), needUsdt: wait.needUsdtRaw.toString(), heldUsdt: hold.toString() };

    // ---- A2. The account portfolio 37 was left in: the sale's USDT was withdrawn in full before the last repayment ----
    // Shares still posted, a sliver of debt, no USDT the strategy may spend, nothing free to sell. The way out needs no one:
    // the shares the debt does not need come back without a repayment, their sale brings the USDT, the route closes.
    await s.local.revert({ id: afterRound2 });
    booked.length = 0; sent.length = 0; cash.own = 0n;
    await s.now();
    await move(C, X, SINK, free1); // the free shares were sold and their USDT left for the owner's wallet
    await ledgerMatchesChain('stuck: start');
    mark(`${tag}: stuck account — nothing to repay with, nothing free to sell`);
    const rest = [{ tokenIn: C, amountIn: total - free1 }];
    const stuck = await v2UnwindForSale({ ...await step({ send: tracked }), steps: rest, exit: true });
    assert.ok(stuck !== null && typeof stuck === 'object' && sent.length === 0, `still "sell what is free", nothing sent: ${String(stuck)}`);
    mark(`${tag}: stuck account — the shares the debt does not need come back without a repayment`);
    const spared = await v2UnwindForSale({ ...await step({ send: tracked }), steps: rest, exit: true, spare: true });
    assert.match(String(spared), /^\[STRATEGY_EARN_UNWINDING\] 賣出前已還款取回：.*nothing free to sell: take back \d+ of \d+.*tx=0x[0-9a-f]{64}/);
    assert.deepEqual(sent, [['executeReduce']]);
    read = await reader.account(X, [C]);
    const freeS = await bal(C), leftS = read.routes[0]!;
    assert.ok(freeS > (total - free1) / 2n && leftS.collateralRaw === total - free1 - freeS && leftS.collateralRaw > 0n && leftS.routeDebtRaw >= left1.routeDebtRaw, `freed ${freeS} of ${total - free1}, ${leftS.collateralRaw} stays posted for a debt of ${leftS.routeDebtRaw}`);
    // Asked again, nothing more is spared (what stays posted is what the debt needs): it waits, and sends nothing.
    assert.equal(typeof await v2UnwindForSale({ ...await step({ send: tracked }), steps: rest, exit: true, spare: true }), 'object');
    assert.equal(sent.length, 1);
    mark(`${tag}: stuck account — the freed shares are sold, their USDT pays the rest and the route closes`);
    const proceedsS = await sell(freeS);
    const closedS = await v2UnwindForSale({ ...await step({ send: tracked }), steps: [{ tokenIn: C, amountIn: leftS.collateralRaw }], exit: true });
    assert.match(String(closedS), /賣出前已還款取回/);
    assert.deepEqual(sent.slice(1), [closing]);
    await clean('stuck account: closed', leftS.collateralRaw);
    assert.ok(cash.own > proceedsS * 9n / 10n, `the owner gets the sale back: ${cash.own} of ${proceedsS}`);
    const wayOut = { takenBack: freeS.toString(), keptPosted: leftS.collateralRaw.toString(), debt: leftS.routeDebtRaw.toString(), proceeds: proceedsS.toString(), cashAfterClose: cash.own.toString() };

    // ---- B. A plain turn-off (nothing is being sold) ---------------------------------------------------------------
    await s.local.revert({ id: snapshot });
    cash.own = 0n; booked.length = 0; sent.length = 0; needs.length = 0;
    await s.now();
    await ledgerMatchesChain('turn-off start');
    mark(`${tag}: turn-off — the owner repays what the box holds and withdraws consent`);
    const off = await api.close(X, { symbols: [SYMBOL] });
    if (off.status !== 'ready') throw new Error('close not ready: ' + JSON.stringify(off));
    assert.deepEqual(names(off.calls, v2), ['executeReduce', v2.registry], 'a partial repayment, then consent off; no close that would revert');
    for (const batch of off.batches) await send(batch);
    read = await reader.account(X, [C]);
    const freeB = await bal(C), leftB = read.routes[0]!;
    assert.deepEqual([read.policy.enabled, leftB.collateralRaw], [false, total - freeB]);
    assert.ok(freeB > total * 97n / 100n && leftB.routeDebtRaw > 0n && leftB.routeDebtRaw < debt0 / 50n);
    mark(`${tag}: turn-off — the scheduler round reports the USDT it is short of`);
    assert.equal(await v2AutoRound(await step({ send: tracked })), null);
    assert.deepEqual([sent.length, needs.length], [0, 1]);
    assert.ok(needs[0]! > leftB.routeDebtRaw - 10n ** 12n && needs[0]! < leftB.routeDebtRaw * 2n + 10n ** 15n, `needs ${needs[0]}`);
    // The cash raise: twice the need, at least 1 USDT, from the shares that are free now (the scheduler's own small sale).
    const need = needs[0]!, raise = cashRaiseUsdE8(need) * 10n ** 10n, sold = raise * 10n ** 18n / usdPerUnitE18 + 1n;
    await sell(sold);
    assert.ok(cash.own >= need && cash.own < 2n * 10n ** 18n + 4n * need, `raised ${cash.own}`);
    mark(`${tag}: turn-off — the next round pays the rest and closes`);
    assert.match(await v2AutoRound(await step({ send: tracked })) ?? '', new RegExp(`已執行：${SYMBOL} close\\(disabled\\)`));
    assert.deepEqual(sent, [closing]);
    assert.deepEqual(bookedKinds().slice(0, swaps ? 2 : 1), swaps ? ['top_up', 'cash_out'] : ['repay_cash']);
    read = await clean('turn-off done', total - sold);
    assert.equal(read.policy.enabled, false);
    // A later round finds nothing to do and asks for nothing.
    needs.length = 0;
    assert.equal(await v2AutoRound(await step({ send: tracked })), null);
    assert.deepEqual([sent.length, needs.length], [1, 0]);
    await ledgerMatchesChain('the end');
    console.log(JSON.stringify({ kind, loan, account: X, asset: SYMBOL, debt: debt0.toString(), gap: gap0.toString(), reservedUsdt: cash.others.toString(), sellAll, wayOut,
      turnOff: { debtLeftAfterOwner: leftB.routeDebtRaw.toString(), needUsdt: need.toString(), raised: raise.toString(), booked: booked.map(b => `${b.kind}:${b.usdtRaw}`) } }));
  });
}

/**
 * 2026-11-26, the minimum buy (50 USDT). The engine used to open nothing that would borrow under 10 USD, so a 50 USDT buy
 * over two assets (25 each, ratio 20–35%: 5.00 and 8.75) was answered "unavailable" although the app offered the strategy.
 * The floor is 1 USD now (the venue's own minimum loan, lens `minLoan`, is 0 on chain 97). Here: about 25 USD of XAUt and
 * 6 USD of BTCB (a loan of about 1.20: just over the floor) — both open, both close before a sale with every share back,
 * both open again, and the owner's turn-off a day later leaves no debt, no box money and no loan token worth selling.
 * An asset under the floor (4 USD of BTCB: a 0.80 loan) is refused as `too_small`, not as temporarily unavailable.
 */
test('routing v2 fork, minimum buy: assets that borrow a few USD open, close before a sale, reopen and are turned off clean; under 1 USD is too_small', { skip }, async () => {
  const s = setup(), { v2, reader, client } = s;
  const X = MIX_ACCOUNT, send = s.sender(X), lines: string[] = [];
  const BTCB = (T.assets.BTCB.token as string).toLowerCase() as Address, XAUT = (T.assets.XAUt.token as string).toLowerCase() as Address;
  const pools: Record<string, Address> = { [BTCB]: T.assets.BTCB.pool as Address, [XAUT]: T.assets.XAUt.pool as Address };
  const SINK = '0x000000000000000000000000000000000000dEaD' as Address;
  const bal = (token: Address, who: Address = X) => client.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [who] });
  const move = async (token: Address, from: Address, to: Address, amount: bigint) => { if (amount === 0n) return; const w = await s.from(from); const r = await mined(client, await w.writeContract({ address: token, abi: ERC20, functionName: 'transfer', args: [to, amount], gas: 300_000n })); assert.equal(r.status, 'success'); };
  /** Leave the account holding `usd` worth of the token (lending oracle price, as the reader values it). */
  const hold = async (token: Address, usd: number) => {
    await move(token, X, SINK, await bal(token));
    await move(token, pools[token]!, X, await bal(token, pools[token]!) / 100_000n);
    const h = (await reader.account(X, [token])).state.holdings.find(x => x.collateral === token)!;
    assert.ok(h.collateralUsd > 0, 'the probe amount has a price');
    const want = h.freeCollateralRaw * BigInt(Math.round(usd * 1e6)) / BigInt(Math.round(h.collateralUsd * 1e6));
    if (want < h.freeCollateralRaw) await move(token, X, SINK, h.freeCollateralRaw - want); else await move(token, pools[token]!, X, want - h.freeCollateralRaw);
    return want;
  };
  const weights = [{ asset: BTCB, weightBps: 5_000 }, { asset: XAUT, weightBps: 5_000 }];
  const api = createStrategyEarnV2Api({ v2, reader, now: s.clock, recordRoutes: s.ledger.routes, log: () => {} });
  const step = async (o: object = {}) => ({ v2, reader, account: X, portfolioId: 1, now: await s.now(), dryRun: false, send, ledger: s.ledger, log: (l: string) => lines.push(l), held: [BTCB, XAUT], ...o });
  const open = async () => (await reader.account(X, [BTCB, XAUT])).routes.filter(r => r.collateralRaw > 0n || r.routeDebtRaw > 0n);
  const usd = (raw: bigint) => Number(raw / 10n ** 12n) / 1e6;

  await s.now();
  assert.equal((await open()).length, 0, 'nothing on v2 at the fork block');
  // Like an account right after a minimum buy: everything invested, no USDT and no other loan token.
  for (const token of [v2.loanTokens.USDT!, v2.loanTokens.USD1!, v2.loanTokens.USDC!, v2.loanTokens.U!]) await move(token, X, SINK, await bal(token));

  mark('min buy: 4 USD of BTCB is under the floor');
  const gold = await hold(XAUT, 25);
  await hold(BTCB, 4);
  const small = await api.auto(X, CANARY, { budgetRaw: 0n, weights, keyReady: true });
  assert.deepEqual([small.status, small.assets.map(a => [a.asset, a.status, 'reason' in a ? a.reason : null]).sort()], ['ready', [['BTCB', 'unavailable', 'too_small'], ['XAUt', 'ready', null]]]);
  assert.equal(small.assets.find(a => a.asset === 'BTCB')!.message, 'Amount too small.');
  const one = await api.open(X, CANARY, { symbol: 'BTCB', collateralRaw: await bal(BTCB), weights, keyReady: true });
  assert.deepEqual([one.status, 'reason' in one ? one.reason : null, 'message' in one ? one.message : null], ['unavailable', 'too_small', 'Amount too small.']);
  // What the public markets list tells the app: the least value of each asset the strategy opens with (1 USD ÷ ratio).
  const mins = await api.minimums();
  assert.deepEqual([mins.BTCB, Math.round(mins.XAUt! * 1e4) / 1e4], [5, 2.8571]);

  mark('min buy: 6 USD of BTCB + 25 USD of XAUt, consent');
  const btc = await hold(BTCB, 6);
  const auto = await api.auto(X, CANARY, { budgetRaw: 0n, weights, keyReady: true });
  assert.deepEqual([auto.status, auto.assets.map(a => [a.asset, a.status]).sort()], ['ready', [['BTCB', 'ready'], ['XAUt', 'ready']]]);
  if (auto.status !== 'ready') return;
  await send(auto.calls);

  mark('min buy: the scheduler opens both');
  assert.match(await v2AutoRound(await step()) ?? '', /已執行：(XAUt open\(best_route\)、BTCB open\(best_route\)|BTCB open\(best_route\)、XAUt open\(best_route\))/);
  let routes = await open();
  const debtOf = (symbol: string) => usd(routes.find(r => r.route.symbol === symbol)?.routeDebtRaw ?? 0n);
  assert.deepEqual(routes.map(r => r.route.symbol).sort(), ['BTCB', 'XAUt']);
  assert.ok(debtOf('BTCB') > 1.1 && debtOf('BTCB') < 1.25, `BTCB debt ${debtOf('BTCB')}`);
  assert.ok(debtOf('XAUt') > 8.3 && debtOf('XAUt') < 8.8, `XAUt debt ${debtOf('XAUt')}`);
  assert.deepEqual([await bal(BTCB), await bal(XAUT)], [0n, 0n], 'every share is posted');
  const view = await api.portfolio(1, X);
  assert.deepEqual([view.positions.map(p => [p.asset, p.status]).sort(), view.autoOpen], [[['BTCB', 'on'], ['XAUt', 'on']], false]);
  assert.equal(await v2AutoRound(await step()), null, 'the next round has nothing to do');

  mark('min buy: a sale of everything takes both back first');
  await s.local.increaseTime({ seconds: 3_600 }); await s.local.mine({ blocks: 1 });
  const selling = await v2UnwindForSale({ ...await step(), steps: [{ tokenIn: BTCB, amountIn: btc }, { tokenIn: XAUT, amountIn: gold }] });
  assert.match(String(selling ?? ''), /\[STRATEGY_EARN_UNWINDING\] 賣出前已還款取回/);
  let read = await reader.account(X, [BTCB, XAUT]);
  assert.equal(read.routes.filter(r => r.collateralRaw > 0n || r.routeDebtRaw > 0n).length, 0, String(selling));
  assert.deepEqual([await bal(BTCB), await bal(XAUT)], [btc, gold], 'every share is back in the account, free to sell');
  for (const [symbol, t] of Object.entries(read.tokens)) if (symbol !== 'USDT') assert.ok(t.cashRaw < V2_CASH_OUT_ALONE_MIN_RAW && t.debtRaw === 0n, `${symbol} left: ${t.cashRaw}`);

  mark('min buy: consent is still on, both open again; a day later the owner turns it off');
  assert.match(await v2AutoRound(await step()) ?? '', /BTCB open\(best_route\)/);
  routes = await open();
  assert.equal(routes.length, 2);
  await s.local.increaseTime({ seconds: 86_400 }); await s.local.mine({ blocks: 1 });
  await s.now();
  const off = await api.close(X, { symbols: ['BTCB', 'XAUt'] });
  assert.equal(off.status, 'ready');
  if (off.status !== 'ready') return;
  assert.equal(names(off.calls, v2).filter(n => n === 'executeReduce').length, 2);
  for (const batch of off.batches) await send(batch);
  read = await reader.account(X, [BTCB, XAUT]);
  assert.deepEqual([read.routes.filter(r => r.collateralRaw > 0n || r.routeDebtRaw > 0n).length, read.policy.enabled, read.vaults.reduce((sum, v) => sum + v.assetsRaw, 0n)], [0, false, 0n]);
  assert.deepEqual([await bal(BTCB), await bal(XAUT)], [btc, gold], 'every share is back');
  for (const [symbol, t] of Object.entries(read.tokens)) if (symbol !== 'USDT') assert.ok(t.cashRaw < V2_CASH_OUT_ALONE_MIN_RAW && t.debtRaw === 0n && t.idleRaw === 0n, `${symbol} left: cash ${t.cashRaw} idle ${t.idleRaw} debt ${t.debtRaw}`);
  assert.equal(await v2AutoRound(await step()), null, 'consent withdrawn: nothing reopens');
  console.log(JSON.stringify({ minBuy: { btcDebt: debtOf('BTCB'), goldDebt: debtOf('XAUt'), usdt: (await bal(v2.loanTokens.USDT!)).toString(), offCalls: names(off.calls, v2), lines: lines.length } }));
});
