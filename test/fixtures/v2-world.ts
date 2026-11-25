import type { Address, Hex } from 'viem';
import { routeIdOf, vaultIdOf } from '../../src/strategy-earn-v2.js';
import type { StrategyEarnV2 } from '../../src/strategy-earn-v2.js';
import type { V2Multicall } from '../../src/strategy-earn-v2-chain.js';

/**
 * An in-memory routing v2 deployment for unit tests: answers exactly the reads the reader makes (registry, lens, tokens,
 * venues) from plain data the test edits. Not a simulation of the contracts: positions are whatever the test writes.
 */
const A = (n: number) => ('0x' + n.toString(16).padStart(40, '0')) as Address;
export const E18 = 10n ** 18n;
/** The clock of the fake chain's reader (tests pass the same instant to the code under test). */
export const WORLD_NOW = new Date('2026-11-25T03:00:00Z');
export const W = {
  v2: { chainId: 97, executor: A(0xe2), registry: A(0xe3), lens: A(0xe6), venusComptroller: A(0xe4), moolah: A(0xe5), loanTokens: { USDT: A(0xa1), USDC: A(0xa2) }, rewardTokens: [A(0x91)],
    adapters: [A(0xe7)], canaryOwners: [A(0x66)] } satisfies StrategyEarnV2 as StrategyEarnV2,
  oracle: A(0xf0), atpRegistry: A(0xf1), account: A(0x55), owner: A(0x66), box: A(0x56),
  QQQ: A(0x71), NVDA: A(0x72), vNVDA: A(0x82), vUSDT: A(0xb2), vUSDC: A(0xb4), listaUsdcVault: A(0xb1), aavePool: A(0xb3), aUSDT: A(0xb5),
  listaQqqUsdc: ('0x' + '1a'.repeat(32)) as Hex, listaNvdaUsdt: ('0x' + '2b'.repeat(32)) as Hex,
};
/** The same deployment with a cash swapper (AtpBorrowCashSwapper, spec §17) and its USDC pool: `world(WS)`. */
export const SWAPPER = A(0xe8), USDC_POOL = A(0xe9);
export const WS: StrategyEarnV2 = { ...W.v2, swapper: SWAPPER, swapperPools: [USDC_POOL] };
export type RouteRow = { venue: 1 | 2; collateral: Address; loan: Address; listaId: Hex; collateralVToken: Address; loanVToken: Address; enabled: boolean; retired: boolean;
  status: { open: boolean; borrowBps: number; collateralBps?: number; borrowIncentiveBps?: number; collateralIncentiveBps?: number; liquidity: bigint; capLeft: bigint; targetBps: number; deleverageBps: number; liquidationBps: number };
  minLoan?: bigint; minDebt?: bigint };
export type VaultRow = { kind: 1 | 2 | 3; token: Address; target: Address; receipt: Address; enabled: boolean; retired: boolean;
  status: { open: boolean; rateKnown: boolean; utilizationKnown: boolean; shouldExit: boolean; supplyBps: number; incentiveBps: number; utilizationBps: number }; maxDeposit?: bigint; cash?: bigint };
export type Position = { collateral: bigint; collateralValue: bigint; debt: bigint; routeDebt: bigint; principal: bigint; openedAt: number; shouldDeleverage?: boolean; ltvBps?: number };
const ZERO32 = ('0x' + '00'.repeat(32)) as Hex;
const rate = (bps: number) => BigInt(bps) * 10n ** 14n;

export function world(deployment: StrategyEarnV2 = W.v2) {
  const route = (venue: 1 | 2, collateral: Address, loan: Address, listaId: Hex, borrowBps: number, o: Partial<RouteRow> = {}): RouteRow => ({ venue, collateral, loan, listaId, collateralVToken: venue === 1 ? W.vNVDA : A(0), loanVToken: venue === 1 ? (loan === W.v2.loanTokens.USDT ? W.vUSDT : W.vUSDC) : A(0),
    enabled: true, retired: false, status: { open: true, borrowBps, liquidity: 1_000_000n * E18, capLeft: 100_000n * E18, targetBps: 3000, deleverageBps: 4000, liquidationBps: 6000 }, ...o });
  const vault = (kind: 1 | 2 | 3, token: Address, target: Address, receipt: Address, supplyBps: number, o: Partial<VaultRow> = {}): VaultRow => ({ kind, token, target, receipt, enabled: true, retired: false,
    status: { open: true, rateKnown: true, utilizationKnown: kind !== 1, shouldExit: false, supplyBps, incentiveBps: 0, utilizationBps: 1000 }, ...(kind === 1 ? { maxDeposit: 10n ** 30n } : { cash: 500_000n * E18 }), ...o });
  const USDT = W.v2.loanTokens.USDT!, USDC = W.v2.loanTokens.USDC!;
  const routes = new Map<Hex, RouteRow>([
    [routeIdOf('lista', W.QQQ, USDC, W.listaQqqUsdc), route(2, W.QQQ, USDC, W.listaQqqUsdc, 220, { status: { open: true, borrowBps: 220, borrowIncentiveBps: 50, collateralIncentiveBps: 100, liquidity: 250_000n * E18, capLeft: 100_000n * E18, targetBps: 3500, deleverageBps: 5000, liquidationBps: 7500 } })],
    [routeIdOf('venus', W.NVDA, USDT, null), route(1, W.NVDA, USDT, ZERO32, 250)],
    [routeIdOf('venus', W.NVDA, USDC, null), route(1, W.NVDA, USDC, ZERO32, 300)],
    [routeIdOf('lista', W.NVDA, USDT, W.listaNvdaUsdt), route(2, W.NVDA, USDT, W.listaNvdaUsdt, 260, { minLoan: 15n * E18, minDebt: 15_150_000_000_000_000_000n })],
  ]);
  const vaults = new Map<Hex, VaultRow>([
    [vaultIdOf('lista', USDC, W.listaUsdcVault), vault(1, USDC, W.listaUsdcVault, W.listaUsdcVault, 400, { status: { open: true, rateKnown: true, utilizationKnown: false, shouldExit: false, supplyBps: 400, incentiveBps: 50, utilizationBps: 0 } })],
    [vaultIdOf('venus', USDT, W.vUSDT), vault(2, USDT, W.vUSDT, W.vUSDT, 0)],
    [vaultIdOf('aave', USDT, W.aavePool), vault(3, USDT, W.aavePool, W.aUSDT, 420)],
    [vaultIdOf('venus', USDC, W.vUSDC), vault(2, USDC, W.vUSDC, W.vUSDC, 0)],
  ]);
  const state = {
    routes, vaults,
    policy: { maxDebt: 0n, rewardRecipient: A(0), strategyId: 0n, enabled: false }, enrollment: [57n, 1, false] as [bigint, number, boolean], principalUsd: 0n,
    positions: new Map<Hex, Position>(), holdings: new Map<Hex, { assets: bigint; since: number; shouldExit?: boolean }>(),
    idle: new Map<Address, bigint>(), balances: new Map<string, bigint>(), allowances: new Map<string, bigint>(), prices: new Map<Address, bigint>([[W.QQQ, 500n * 10n ** 8n], [W.NVDA, 150n * 10n ** 8n]]),
    venusOwed: new Map<Address, bigint>(), supplyCaps: new Map<Address, { cap: bigint; supply: bigint; rate: bigint }>(), rateReporter: A(0xd8), reports: new Map<Hex, [bigint, bigint, bigint]>(),
    mock: { moolahBorrowIncentive: 50, moolahCollateralIncentive: 100, vTokenBorrowIncentive: 0, vTokenSupplyIncentive: 50, vaultApr: 400, vaultIncentive: 50 },
    vaultReward: 0n, calls: 0, requests: 0,
    /** Has the account delegated borrowing to the v2 executor on each venue (Venus approvedDelegates / Moolah isAuthorized)? */
    delegated: { venus: false, lista: false },
    /** Cash swapper: `unreadable` makes `shortfall` revert (a vault cannot be read); `cap` overrides `topUpCap`; `windowStart` is the open window. */
    swap: { unreadable: false, cap: null as bigint | null, windowStart: 0 },
  };
  const bal = (token: Address, who: Address) => state.balances.get(`${token}:${who}`.toLowerCase()) ?? 0n;
  const routeIds = () => [...routes.keys()], vaultIds = () => [...vaults.keys()];
  const health = { collateralValue: 0n, liquidationValue: 0n, debtValue: 0n, budgetValue: 0n, deleverageValue: 0n, healthFactor: 0n };
  const answer = (target: Address, fn: string, args: readonly unknown[]): unknown => {
    const t = target.toLowerCase(), v2 = W.v2;
    if (t === v2.registry) {
      if (fn === 'routeCount') return BigInt(routes.size);
      if (fn === 'vaultCount') return BigInt(vaults.size);
      if (fn === 'routeIds') return routeIds()[Number(args[0])];
      if (fn === 'vaultIds') return vaultIds()[Number(args[0])];
      if (fn === 'route') { const r = routes.get(args[0] as Hex)!; return { venue: r.venue, collateral: r.collateral, loan: r.loan, listaId: r.listaId, collateralVToken: r.collateralVToken, loanVToken: r.loanVToken, borrowCap: 0n, maxUtilizationBps: 9500, enabled: r.enabled, retired: r.retired }; }
      if (fn === 'vault') { const v = vaults.get(args[0] as Hex)!; return { kind: v.kind, token: v.token, target: v.target, receipt: v.receipt, enabled: v.enabled, retired: v.retired }; }
      if (fn === 'policy') return state.policy;
      if (fn === 'accountPrincipalUsd') return state.principalUsd;
      if (fn === 'accountRoutes') return [...state.positions.keys()];
      if (fn === 'accountVaults') return [...state.holdings.keys()];
      if (fn === 'rateReporter') return state.rateReporter;
      if (fn === 'reports') return state.reports.get(args[0] as Hex) ?? [0n, 0n, 0n];
    }
    if (t === v2.lens) {
      if (fn === 'routeStatus') { const r = routes.get(args[0] as Hex)!, s = r.status, p = args[1] === A(0) ? undefined : state.positions.get(args[0] as Hex);
        return { open: s.open, shouldDeleverage: p?.shouldDeleverage ?? false, borrowRate: rate(s.borrowBps), collateralRate: rate(s.collateralBps ?? 0), borrowIncentiveRate: rate(s.borrowIncentiveBps ?? 0), collateralIncentiveRate: rate(s.collateralIncentiveBps ?? 0),
          borrowUtilizationBps: 5000n, availableLiquidity: s.liquidity, borrowCapLeft: s.capLeft, targetLtv: rate(s.targetBps), deleverageLtv: rate(s.deleverageBps), liquidationLtv: rate(s.liquidationBps), ltv: rate(p?.ltvBps ?? 0),
          collateral: p?.collateral ?? 0n, collateralValue: p?.collateralValue ?? 0n, debt: p?.debt ?? 0n, routeDebt: p?.routeDebt ?? 0n, principal: p?.principal ?? 0n, openedAt: BigInt(p?.openedAt ?? 0), health }; }
      if (fn === 'minLoan') return routes.get(args[0] as Hex)!.minLoan ?? 0n;
      if (fn === 'minDebt') return routes.get(args[0] as Hex)!.minDebt ?? 0n;
      if (fn === 'vaultStatus') { const v = vaults.get(args[0] as Hex)!, s = v.status, h = args[1] === A(0) ? undefined : state.holdings.get(args[0] as Hex);
        return { open: s.open, rateOnChain: v.kind !== 1, rateKnown: s.rateKnown, utilizationKnown: s.utilizationKnown, shouldExit: h?.shouldExit ?? s.shouldExit, supplyRate: rate(s.supplyBps), incentiveRate: rate(s.incentiveBps), utilizationBps: BigInt(s.utilizationBps),
          assets: h?.assets ?? 0n, since: BigInt(h?.since ?? 0) }; }
      if (fn === 'idleOf') return state.idle.get(args[1] as Address) ?? 0n;
      // The account's whole debt in a token: its Venus debt once (every Venus route of the token reports the same number) plus each Lista market.
      if (fn === 'tokenDebt') { const ps = [...state.positions.entries()].map(([id, p]) => ({ r: routes.get(id)!, p })).filter(x => x.r.loan === args[1]);
        return (ps.find(x => x.r.venue === 1)?.p.debt ?? 0n) + ps.filter(x => x.r.venue === 2).reduce((s, x) => s + x.p.debt, 0n); }
    }
    if (deployment.swapper && t === deployment.swapper) {
      const token = (fn === 'poolOf' ? args[0] : args[1]) as Address, usdc = v2.loanTokens.USDC!;
      if (fn === 'poolOf') return token === usdc ? USDC_POOL : A(0);
      const debt = answer(v2.lens, 'tokenDebt', [args[0], token]) as bigint, idle = state.idle.get(token) ?? 0n;
      const inVaults = [...state.holdings.entries()].filter(([id]) => vaults.get(id)!.token === token).reduce((sum, [, h]) => sum + h.assets, 0n);
      const cap = state.swap.cap ?? (debt > idle ? (debt - idle) * 10_100n / 10_000n : 0n);
      if (fn === 'topUpCap') return cap;
      if (fn === 'shortfall') return state.swap.unreadable ? null : [debt > idle + inVaults ? debt - idle - inVaults : 0n, cap];
      if (fn === 'topUpWindowOf') return [BigInt(state.swap.windowStart), 0n, 0n];
      return null;
    }
    if (t === v2.executor && fn === 'boxOf') return W.box;
    if (t === W.atpRegistry && fn === 'enrollments') return state.enrollment;
    if (t === W.oracle && fn === 'peek') return state.prices.get(args[0] as Address) ?? null;
    if (t === v2.venusComptroller && fn === 'supplyCaps') return state.supplyCaps.get(args[0] as Address)?.cap ?? null;
    if (t === v2.venusComptroller && fn === 'approvedDelegates') return args[1] === v2.executor && state.delegated.venus;
    if (t === v2.moolah && fn === 'isAuthorized') return args[1] === v2.executor && state.delegated.lista;
    if (t === v2.moolah) return fn === 'borrowIncentiveAprBps' ? state.mock.moolahBorrowIncentive : fn === 'collateralIncentiveAprBps' ? state.mock.moolahCollateralIncentive : null;
    if (fn === 'totalSupply') return state.supplyCaps.get(target)?.supply ?? null;
    if (fn === 'exchangeRateStored') return state.supplyCaps.get(target)?.rate ?? null;
    if (fn === 'borrowBalanceStored') return state.venusOwed.get(target) ?? 0n;
    if (fn === 'borrowIncentiveAprBps') return state.mock.vTokenBorrowIncentive;
    if (fn === 'supplyIncentiveAprBps') return state.mock.vTokenSupplyIncentive;
    if (fn === 'aprBps') return state.mock.vaultApr;
    if (fn === 'incentiveAprBps') return state.mock.vaultIncentive;
    if (fn === 'getCash') return [...vaults.values()].find(v => v.target === target)?.cash ?? null;
    if (fn === 'maxDeposit') return [...vaults.values()].find(v => v.target === target)?.maxDeposit ?? null;
    if (fn === 'rewardOf') return state.vaultReward;
    if (fn === 'balanceOf') { const aave = [...vaults.values()].find(v => v.kind === 3 && v.token === target && v.receipt === args[0]); return aave ? aave.cash ?? 0n : bal(target, args[0] as Address); }
    if (fn === 'allowance') return state.allowances.get(`${target}:${String(args[0])}:${String(args[1])}`.toLowerCase()) ?? state.allowances.get(`${target}:${String(args[0])}`.toLowerCase()) ?? 0n;
    if (fn === 'decimals') return 18;
    if (fn === 'symbol') return target === W.QQQ ? 'QQQB' : target === W.NVDA ? 'NVDAB' : 'TKN';
    return null;
  };
  const multicall: V2Multicall = async reads => { state.requests++; return reads.map(r => { state.calls++; return answer(r.target, r.functionName, r.args ?? []); }); };
  const ids = { qqqListaUsdc: routeIdOf('lista', W.QQQ, USDC, W.listaQqqUsdc), nvdaVenusUsdt: routeIdOf('venus', W.NVDA, USDT, null), nvdaVenusUsdc: routeIdOf('venus', W.NVDA, USDC, null), nvdaListaUsdt: routeIdOf('lista', W.NVDA, USDT, W.listaNvdaUsdt),
    listaUsdc: vaultIdOf('lista', USDC, W.listaUsdcVault), venusUsdt: vaultIdOf('venus', USDT, W.vUSDT), aaveUsdt: vaultIdOf('aave', USDT, W.aavePool), venusUsdc: vaultIdOf('venus', USDC, W.vUSDC) };
  return { state, multicall, ids, setBalance: (token: Address, who: Address, amount: bigint) => state.balances.set(`${token}:${who}`.toLowerCase(), amount),
    /** What `owner` approved of `token` to `spender` (a plain `token:owner` entry answers for every spender). */
    setAllowance: (token: Address, owner: Address, spender: Address, amount: bigint) => state.allowances.set(`${token}:${owner}:${spender}`.toLowerCase(), amount),
    readerDeps: { v2: deployment, multicall, priceOracle: W.oracle, atpRegistry: W.atpRegistry, marketTtlMs: 0, bookTtlMs: 0, now: () => WORLD_NOW.getTime(),
      asset: (t: Address) => t === W.QQQ ? { symbol: 'QQQB', decimals: 18 } : t === W.NVDA ? { symbol: 'NVDAB', decimals: 18 } : undefined } };
}
