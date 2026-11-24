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

// ---- turning off / selling with several Venus positions (one shared debt) --------------------------------------------

import { venusReleaseCalls } from '../src/strategy-earn.js';
import type { VenusPosition } from '../src/strategy-earn.js';

/**
 * A model of AtpBorrowExecutor on Venus (cre8-contracts src/atp/borrow/AtpBorrowExecutor.sol): ONE debt for the account,
 * a vault per market, the account's own USDT, collateral per market. Every revert condition the executor has for these
 * calls throws here. Interest accrues between the read and execution (debt +0.05%, vaults +0.01%).
 */
type Sim = { debt: bigint; cash: bigint; vault: Record<string, bigint>; posted: Record<string, bigint>; price: Record<string, bigint>; target: bigint };
function execute(sim: Sim, calls: { to: string; data: Hex }[]) {
  const value = (id: string, amount: bigint) => amount * sim.price[id]! / E18; // 18 decimals, price in USD 1e18 per token
  const collateral = () => Object.keys(sim.posted).reduce((s, id) => s + value(id, sim.posted[id]!), 0n);
  for (const c of calls) {
    assert.equal(c.to, S.executor);
    const d = decode(c.data); const [, id, a, b] = d.args as [Address, string, bigint, unknown];
    if (d.functionName === 'executeRepay') {
      const fromVault = b as boolean;
      if (a === 0n) throw new Error('ZeroAmount');
      if (sim.debt === 0n) { if (!fromVault || !sim.vault[id]) throw new Error('NothingToRepay'); sim.cash += sim.vault[id]!; sim.vault[id] = 0n; continue; }
      const pay = a < sim.debt ? a : sim.debt; let fromCash = pay;
      if (fromVault) {
        const worth = sim.vault[id] ?? 0n;
        if (pay < worth) { sim.vault[id] = worth - pay; fromCash = 0n; }
        else if (worth !== 0n) { fromCash = pay - worth; sim.vault[id] = 0n; }
      }
      if (fromCash > sim.cash) throw new Error('ERC20InsufficientBalance (cash)');
      sim.cash -= fromCash; sim.debt -= pay;
      if (sim.debt === 0n && (sim.vault[id] ?? 0n) > 0n) { sim.cash += sim.vault[id]!; sim.vault[id] = 0n; }
    } else if (d.functionName === 'executeWithdrawCollateral') {
      if (a === 0n) throw new Error('ZeroAmount');
      const take = a === maxUint256 ? sim.posted[id]! : a;
      if (take === 0n || take > sim.posted[id]!) throw new Error('ZeroAmount / over');
      sim.posted[id] = sim.posted[id]! - take;
      if (sim.debt > 0n && sim.debt * E18 > collateral() * sim.target) throw new Error('LtvTooHigh');
    } else throw new Error('unexpected ' + d.functionName);
  }
  return { ltv: collateral() === 0n ? (sim.debt === 0n ? 0n : maxUint256) : sim.debt * E18 / collateral() };
}
const venus3 = [nvda, tsla, m('SPCXB')];
function scenario(n: number, debt: bigint, vaults: bigint[], posted: bigint[], cash: bigint) {
  const ids = venus3.slice(0, n).map(x => x.marketId);
  const collateralValue = posted.slice(0, n).reduce((s, p) => s + p, 0n); // price 1 USD per token
  const positions: VenusPosition[] = venus3.slice(0, n).map((market, i) => ({ market, posted: posted[i]!, price: 10n ** 8n,
    st: base({ debt, vaultAssets: vaults[i]!, health: { collateralValue, liquidationValue: 0n, debtValue: debt, healthFactor: 0n } }) }));
  const sim = (): Sim => ({ debt: debt * 10_005n / 10_000n, cash, target: 30n * E16,
    vault: Object.fromEntries(ids.map((id, i) => [id, vaults[i]! * 10_001n / 10_000n])), posted: Object.fromEntries(ids.map((id, i) => [id, posted[i]!])),
    price: Object.fromEntries(ids.map(id => [id, E18])) });
  return { ids, positions, sim };
}
const plan = (positions: VenusPosition[], release: Hex[], cash: bigint) => venusReleaseCalls({ account, positions, release, cash, usdtPriceE8: 10n ** 8n, deadline: 2_000_000_000n });

test('Venus close, 2 markets: the 2026-11-23 case — repays from both vaults, never asks one market for the whole debt, never reverts', () => {
  // 9.17 USDT shared debt, 4.6 + 4.6 in the vaults, no cash. The old close (repay max from NVDAB) needed 9.17 from NVDAB's 4.6 + cash 0.
  const { ids, positions, sim } = scenario(2, 917n * E16, [460n * E16, 460n * E16], [20n * E18, 15n * E18], 0n);
  const r = plan(positions, ids as Hex[], 0n);
  const s = sim(); execute(s, r.calls);
  // Vaults (9.20 + interest) slightly exceed the debt: everything settled, every share back, the vault rest in the account.
  assert.equal(r.full, true); assert.equal(s.debt, 0n); assert.ok(Object.values(s.posted).every(p => p === 0n)); assert.ok(Object.values(s.vault).every(v => v === 0n));
  // Vaults short (negative carry) and cash short: repays what it can, takes back only what the rest allows, stays under target.
  const thin = scenario(2, 10n * E18, [3n * E18, 3n * E18], [20n * E18, 15n * E18], 1n * E18);
  const t = plan(thin.positions, thin.ids as Hex[], 1n * E18);
  const ts = thin.sim(); const after = execute(ts, t.calls);
  assert.equal(t.full, false); assert.ok(after.ltv <= 30n * E16, String(after.ltv)); assert.ok(Object.values(ts.posted).some(p => p > 0n));
});

test('Venus: 2 and 3 markets, closing all or selling one, with and without cash — never reverts, never above target', () => {
  let cases = 0;
  for (const n of [2, 3]) for (const debt of [0n, 5n * E18, 9n * E18, 30n * E18]) for (const vaultScale of [0n, 5_000n, 10_000n, 10_500n])
    for (const cash of [0n, 2n * E18, 50n * E18]) for (const posted of [[100n * E18, 60n * E18, 40n * E18], [10n * E18, 90n * E18, 1n * E18]]) {
      // Vaults split the debt unevenly (what each market borrowed), scaled: 0 = none left, 105% = earned carry.
      const shares = [5n, 3n, 2n].slice(0, n), total = shares.reduce((a, b) => a + b, 0n);
      const vaults = shares.map(x => debt * x / total * vaultScale / 10_000n);
      const collateralValue = posted.slice(0, n).reduce((a, b) => a + b, 0n);
      if (debt * E18 > collateralValue * 30n * E16 * 98n / 100n) continue; // only start from a healthy account
      const { ids, positions, sim } = scenario(n, debt, vaults, posted, cash);
      for (const release of [ids, [ids[0]!], [ids[n - 1]!]]) {
        const r = plan(positions, release as Hex[], cash);
        const s = sim(); let after;
        try { after = execute(s, r.calls); } catch (e) { throw new Error(`n=${n} debt=${debt} vaults=${vaults} cash=${cash} posted=${posted} release=${release.length} full=${r.full}: ${(e as Error).message}`); }
        assert.ok(after.ltv <= 30n * E16, `n=${n} debt=${debt} vaults=${vaults} cash=${cash} release=${release.length}: ltv ${after.ltv}`);
        if (r.full) for (const id of release) assert.equal(s.posted[id], 0n);
        // Markets that stay on keep their shares posted.
        for (const id of ids.filter(x => !release.includes(x))) assert.equal(s.posted[id], positions.find(p => p.market.marketId === id)!.posted);
        cases++;
      }
    }
  assert.ok(cases > 150, String(cases));
});

test('Venus close, 3 markets: closing one keeps the other two on and healthy, using only that market\'s vault when it covers its share', () => {
  const { ids, positions, sim } = scenario(3, 30n * E18, [15n * E18, 9n * E18, 6n * E18], [100n * E18, 60n * E18, 40n * E18], 0n);
  const r = plan(positions, [ids[1]!] as Hex[], 0n);
  const s = sim(); const after = execute(s, r.calls);
  assert.equal(r.full, true);
  assert.equal(s.posted[ids[1]!], 0n); assert.equal(s.posted[ids[0]!], 100n * E18); assert.equal(s.posted[ids[2]!], 40n * E18);
  // TSLAB's own 9 USDT vault paid; NVDAB's and SPCXB's strategies untouched.
  assert.equal(s.vault[ids[0]!], 15n * E18 * 10_001n / 10_000n); assert.equal(s.vault[ids[2]!], 6n * E18 * 10_001n / 10_000n);
  assert.ok(after.ltv <= 30n * E16);
  // The calls only ever target AtpBorrowExecutor, account pinned.
  assert.ok(r.calls.every(c => c.to === S.executor && (decode(c.data).args[0] as string).toLowerCase() === account));
});

test('POST close { assets }: Venus planned together, Lista per market, consent withdrawn for each; { asset } still works', async () => {
  const shared = { debt: 917n * E16, health: { collateralValue: 35n * E18, liquidationValue: 0n, debtValue: 917n * E16, healthFactor: 0n } };
  const f = { ids: [nvda.marketId, tsla.marketId, wbnb.marketId] as Hex[],
    statuses: { [nvda.marketId]: base({ ...shared, vaultAssets: 460n * E16 }), [tsla.marketId]: base({ ...shared, vaultAssets: 460n * E16 }),
      [wbnb.marketId]: base({ debt: 2n * E18, vaultAssets: 2n * E18 }) },
    collateral: { [nvda.marketId]: 20n * E18, [tsla.marketId]: 15n * E18, [wbnb.marketId]: 3n * E18 } };
  const earn = createStrategyEarn({ chainId: 97, chain: () => chain(f), owned, now: () => new Date('2026-11-23T16:00:00Z') });
  const r = await earn.close(3, account, { assets: ['NVDAB', 'TSLAB', 'WBNB'] });
  assert.equal(r.status, 'ready'); assert.ok('calls' in r && r.calls);
  const shape = r.calls.map(c => { const d = decode(c.data); return [d.functionName, d.args[d.functionName === 'setBorrowPolicy' ? 0 : 1]]; });
  assert.deepEqual(shape, [['executeRepay', nvda.marketId], ['executeRepay', tsla.marketId], ['executeRepay', nvda.marketId], ['executeWithdrawCollateral', nvda.marketId],
    ['executeWithdrawCollateral', tsla.marketId], ['executeRepay', wbnb.marketId], ['executeWithdrawCollateral', wbnb.marketId],
    ['setBorrowPolicy', nvda.marketId], ['setBorrowPolicy', tsla.marketId], ['setBorrowPolicy', wbnb.marketId]]);
  // TSLAB (the larger-or-equal vault) goes last with "repay all"; the sliver left in NVDAB's vault is released after.
  assert.equal(decode(r.calls[1]!.data).args[2], maxUint256);
  assert.equal(decode(r.calls[2]!.data).args[2], 1n);
  const one = await earn.close(3, account, { asset: 'WBNB' });
  assert.ok('calls' in one && one.calls); assert.equal(one.calls.length, 3);
  await assert.rejects(earn.close(3, account, { assets: [] }));
  await assert.rejects(earn.close(3, account, { assets: ['TQQQB'] }));
});
