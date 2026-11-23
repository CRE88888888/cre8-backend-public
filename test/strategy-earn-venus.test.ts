import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData, maxUint256 } from 'viem';
import type { Address, Hex } from 'viem';
import { createStrategyEarn, splitVenusDebt, STRATEGY_EARN_97 as S, STRATEGY_EARN_ABI, strategyEarnAutoOpen, strategyMarkets } from '../src/strategy-earn.js';
import type { StatusReading, StrategyEarnChain } from '../src/strategy-earn.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';

/**
 * Venus is one comptroller and one USDT loan per account: every Venus market's `debt` and `health` are the account's
 * whole Venus position, and AtpBorrowExecutor checks each market's ceiling against that whole debt. 2026-11-23 live
 * pass on Mag7: the shared 9.17 USDT debt showed on both NVDAB and TSLAB, and per-market ceilings ignored it.
 */
const E18 = 10n ** 18n, E16 = 10n ** 16n;
const account = T.roles.keeper.toLowerCase() as Address;
const markets = strategyMarkets();
const m = (s: string) => { const x = markets.find(y => y.symbol === s); assert.ok(x, s); return x; };
const nvda = m('NVDAB'), tsla = m('TSLAB'), wbnb = m('WBNB');
const base = (patch: Partial<StatusReading> = {}): StatusReading => ({ gate: 0, shouldDeleverage: false, shouldUnwind: false,
  borrowRate: 2n * E16, collateralRate: 0n, vaultRate: 5n * E16, collateralIncentiveRate: 0n, borrowIncentiveRate: 0n, vaultIncentiveRate: 0n,
  borrowUtilizationBps: 0n, vaultUtilizationBps: 0n, ltv: 0n, targetLtv: 30n * E16, deleverageLtv: 40n * E16, liquidationLtv: 60n * E16, debt: 0n, vaultAssets: 0n,
  health: { collateralValue: 0n, liquidationValue: 0n, debtValue: 0n, healthFactor: maxUint256 }, ...patch });
function chain(f: { statuses?: Record<string, StatusReading>; balances?: Record<string, bigint>; policies?: Record<string, bigint>; weights?: { asset: Address; weightBps: number }[];
  ids?: Hex[]; collateral?: Record<string, bigint>; prices?: Record<string, bigint> }): StrategyEarnChain {
  return {
    head: async () => ({ number: 9n, timestamp: 1_795_400_000n }),
    status: async id => f.statuses?.[id] ?? base(),
    accountMarkets: async () => f.ids ?? [], collateral: async id => f.collateral?.[id] ?? 0n,
    balance: async token => f.balances?.[token.toLowerCase()] ?? 0n,
    price: async asset => f.prices?.[asset.toLowerCase()] ?? 10n ** 8n,
    rewards: async () => ({ vault: 0n, collateral: 0n }),
    policy: async (_a, id) => f.policies?.[id] !== undefined ? { maxDebt: f.policies[id]!, enabled: true, strategyId: 1n, version: 1 } : { maxDebt: 0n, enabled: false, strategyId: 0n, version: 0 },
    enrollment: async () => ({ strategyId: 1n, version: 1 }),
    weights: async () => f.weights ?? [],
  };
}
const decode = (data: Hex) => decodeFunctionData({ abi: STRATEGY_EARN_ABI, data });
const owned = (async () => ({ id: 3, userId: account, strategyId: 1, version: 1, scheduleState: 'active', createdAt: '2026-11-23T00:00:00Z',
  chainId: 97, accountAddress: account, ownerAddress: account, existingKeyRefs: [] })) as never;

test('buy-time consent: Venus markets share one ceiling = the account\'s whole planned Venus debt; Lista stays per market', async () => {
  const f = { weights: [{ asset: nvda.collateral, weightBps: 4000 }, { asset: tsla.collateral, weightBps: 4000 }, { asset: wbnb.collateral, weightBps: 2000 }] };
  const r = await createStrategyEarn({ chainId: 97, chain: () => chain(f), owned, query: (async () => ({ rows: [] })) as never }).auto(3, account, { budgetRaw: String(1000n * E18) });
  assert.ok('calls' in r && r.calls);
  const ceilings = Object.fromEntries(r.calls.filter(c => c.to === S.registry).map(c => decode(c.data).args).map(a => [a[0] as string, a[1] as bigint]));
  // NVDAB 400 + TSLAB 400 USD at 30% x 98% = 235.2 USDT of Venus debt -> x 110% = 258.72 on BOTH; WBNB 200 -> 64.68.
  assert.equal(ceilings[nvda.marketId], 25872n * E16);
  assert.equal(ceilings[tsla.marketId], 25872n * E16);
  assert.equal(ceilings[wbnb.marketId], 6468n * E16);
  // Existing Venus debt (shared) is counted once, not per market.
  const withDebt = { ...f, statuses: { [nvda.marketId]: base({ debt: 9n * E18, health: { collateralValue: 100n * E18, liquidationValue: 0n, debtValue: 9n * E18, healthFactor: 0n } }),
    [tsla.marketId]: base({ debt: 9n * E18, health: { collateralValue: 100n * E18, liquidationValue: 0n, debtValue: 9n * E18, healthFactor: 0n } }) } };
  const again = await createStrategyEarn({ chainId: 97, chain: () => chain(withDebt), owned, query: (async () => ({ rows: [] })) as never }).auto(3, account, { budgetRaw: String(1000n * E18) });
  assert.ok('calls' in again && again.calls);
  const c2 = again.calls.filter(c => c.to === S.registry).map(c => decode(c.data).args[1] as bigint);
  // (100 + 800) x 30% x 98% = 264.6 total -> 255.6 new + 9 existing = 264.6 x 110% = 291.06 for each Venus market.
  assert.equal(c2[0], 29106n * E16); assert.equal(c2[1], 29106n * E16);
});

test('auto-open: the second Venus market in one UserOp counts what the first posts and borrows', async () => {
  const send = async (calls: { to: Address; data: Hex }[]) => { sent = calls; return { hash: ('0x' + '03'.repeat(32)) as Hex, blockNumber: 1n, logs: [] }; };
  let sent: { to: Address; data: Hex }[] = [];
  const args = (policies: Record<string, bigint>) => ({ chain: chain({ policies, balances: { [nvda.collateral]: 500n * E18, [tsla.collateral]: 500n * E18 } }),
    account, portfolioId: 3, now: new Date('2026-11-23T15:00:00Z'), dryRun: false, send, ledger: { record: async () => {} }, log: () => {} });
  const borrows = () => sent.filter(c => decode(c.data).functionName === 'executeBorrow').map(c => [decode(c.data).args[1], decode(c.data).args[2]]);
  // Shared ceilings (new consent): 1,000 USD at 30% x 98% = 294 split 147 + 147; never 147 twice against an unseen debt.
  await strategyEarnAutoOpen(args({ [nvda.marketId]: 32340n * E16, [tsla.marketId]: 32340n * E16 }));
  assert.deepEqual(borrows(), [[nvda.marketId, 147n * E18], [tsla.marketId, 147n * E18]]);
  // Per-market ceilings from before this fix (161.7 each): TSLAB's ceiling also has to hold NVDAB's 147, so it borrows only
  // the 1%-buffered rest instead of reverting the whole UserOp with DebtAboveConsent.
  await strategyEarnAutoOpen(args({ [nvda.marketId]: 16170n * E16, [tsla.marketId]: 16170n * E16 }));
  const [first, second] = borrows();
  assert.deepEqual(first, [nvda.marketId, 147n * E18]);
  assert.equal(second?.[1], (16170n * E16 - 147n * E18) * 9900n / 10000n);
});

test('portfolio view: the one Venus debt is split across Venus positions, so the total is counted once', () => {
  const p = (marketId: Hex, vault: bigint) => ({ marketId, debtRaw: String(917n * E16), vaultAssetsRaw: String(vault), collateralValueUsd: String(100n * E18),
    netValueUsd: '0', earnNetUsd: '0' });
  const positions = [p(nvda.marketId, 4n * E18), p(tsla.marketId, 6n * E18), { marketId: wbnb.marketId, debtRaw: String(E18), vaultAssetsRaw: String(2n * E18),
    collateralValueUsd: String(50n * E18), netValueUsd: String(51n * E18), earnNetUsd: String(E18) }];
  splitVenusDebt(positions, markets);
  assert.deepEqual(positions.map(x => x.debtRaw), [String(3668n * E15()), String(5502n * E15()), String(E18)]);
  assert.equal(positions.slice(0, 2).reduce((s, x) => s + BigInt(x.debtRaw), 0n), 917n * E16);
  assert.equal(positions.reduce((s, x) => s + BigInt(x.earnNetUsd), 0n), 12n * E18 - 1017n * E16);
  // A single Venus position is left as read.
  const one = [p(nvda.marketId, 4n * E18)];
  splitVenusDebt(one, markets);
  assert.equal(one[0]?.debtRaw, String(917n * E16));
  function E15() { return 10n ** 15n; }
});
