import { createPublicClient, decodeFunctionResult, encodeFunctionData, fallback, http, parseAbi, zeroAddress } from 'viem';
import type { Abi, Address, Hex, PublicClient } from 'viem';
import { TESTNET_97 } from './testnet-profile.js';
import { STRATEGY_EARN_97 } from './strategy-earn-guard.js';
import { STABLES } from './strategy-earn-mainnet.js';
import type { RouteOption, RoutingSnapshot, RoutingVault, Stable, Venue } from './strategy-earn-mainnet.js';
import type { RouteKey } from './strategy-earn-routing.js';
import { V2_EXECUTOR_ABI, V2_LENS_ABI, V2_REGISTRY_ABI } from './strategy-earn-v2.js';
import type { Call, RouteLimits, RouteLookup, StrategyEarnV2, V2AccountState, V2Holding } from './strategy-earn-v2.js';

/**
 * Chain reads for Strategy Earn routing v2 (cre8-contracts docs/borrow-routing-v2 §6, interface draft5).
 *
 * Rules:
 * - Every venue number comes from AtpBorrowLensV2 (`routeStatus`, `vaultStatus`, `minLoan`, `minDebt`, `idleOf`); the
 *   registry is read for the allowlist, consent and accounting only. Nothing about a route or a vault is hard-coded: the
 *   registry enumerates them (`routeCount` / `routeIds` / `route`, same for vaults), so a route the owner adds shows up
 *   without a release.
 * - Keyless public nodes only, with fallback between them. The paid RPC_URL is never used here: a market snapshot is ~80
 *   lens calls and an account another ~20, per round. When no public node answers, the caller skips that round.
 * - Bulk: Multicall3 `aggregate3` through eth_call (the status functions accrue first, which an eth_call may do).
 */
export const V2_PUBLIC_RPCS: Record<number, readonly string[]> = {
  97: ['https://bsc-testnet-rpc.publicnode.com', 'https://bsc-testnet.publicnode.com', 'https://data-seed-prebsc-1-s1.bnbchain.org:8545', 'https://bsc-testnet.bnbchain.org'],
  56: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org'],
};
/** STRATEGY_EARN_V2_RPC_URLS (comma separated) replaces the built-in public list, e.g. for a local fork. */
export function v2PublicRpcs(chainId: number, env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.STRATEGY_EARN_V2_RPC_URLS?.trim();
  const list = raw ? raw.split(',').map(x => x.trim()).filter(Boolean) : [...(V2_PUBLIC_RPCS[chainId] ?? [])];
  if (list.length === 0) throw new Error('no public RPC for routing v2 on chain ' + chainId);
  return list;
}
export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11' as Address;
const MULTICALL_ABI = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
]);
const VENUE_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function maxDeposit(address receiver) view returns (uint256)',
  'function supplyCaps(address vToken) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function exchangeRateStored() view returns (uint256)',
  'function getCash() view returns (uint256)',
  'function borrowBalanceStored(address account) view returns (uint256)',
  'function peek(address asset) view returns (uint256)',
  'function enrollments(address account) view returns (uint256 strategyId, uint16 version, bool paused)',
  'function rewardOf(address account) view returns (uint256)',
  'function rewardOf(bytes32 id, address account) view returns (uint256)',
]);
const E18 = 10n ** 18n;
const lower = (a: string) => a.toLowerCase() as Address;
const bpsOf = (rate: bigint) => Number(rate / 10n ** 14n);

type Read = { target: Address; abi: Abi; functionName: string; args?: readonly unknown[] };
/** A decoded multicall result: the value, or null when that one call failed (missing function on a mock, a revert). */
export type V2Multicall = (reads: readonly Read[]) => Promise<(unknown | null)[]>;
/** Multicall3 over eth_call, `chunk` reads per request. Throws only when the node itself fails. */
export function v2Multicall(client: Pick<PublicClient, 'call'>, chunk = 40): V2Multicall {
  return async reads => {
    const out: (unknown | null)[] = [];
    for (let i = 0; i < reads.length; i += chunk) {
      const part = reads.slice(i, i + chunk);
      const data = encodeFunctionData({ abi: MULTICALL_ABI, functionName: 'aggregate3',
        args: [part.map(r => ({ target: r.target, allowFailure: true, callData: encodeFunctionData({ abi: r.abi, functionName: r.functionName, args: r.args ?? [] } as never) }))] });
      const res = await client.call({ to: MULTICALL3, data });
      if (!res.data) throw new Error('multicall returned nothing');
      const results = decodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'aggregate3', data: res.data }) as readonly { success: boolean; returnData: Hex }[];
      part.forEach((r, k) => {
        const x = results[k];
        if (!x || !x.success || x.returnData === '0x') { out.push(null); return; }
        try { out.push(decodeFunctionResult({ abi: r.abi, functionName: r.functionName, data: x.returnData } as never)); } catch { out.push(null); }
      });
    }
    return out;
  };
}

// ---------------------------------------------------------------------------
// The book: routes and vaults on the registry allowlist
// ---------------------------------------------------------------------------
export type V2Route = { routeId: Hex; venue: 'venus' | 'lista'; collateral: Address; symbol: string; decimals: number; loan: Address; loanSymbol: Stable; listaId: Hex;
  collateralVToken: Address; loanVToken: Address; enabled: boolean; retired: boolean };
export type V2Vault = { vaultId: Hex; venue: Venue; token: Address; tokenSymbol: Stable; target: Address; receipt: Address; enabled: boolean; retired: boolean };
export type V2Book = { routes: V2Route[]; vaults: V2Vault[]; at: number };
const VENUES = [null, 'venus', 'lista'] as const, KINDS = [null, 'lista', 'venus', 'aave'] as const;
/** What the engine calls a market: Venus = the loan vToken, Lista = the Moolah market id (strategy-earn-v2 `routeIds`). */
export const marketIdOf = (r: Pick<V2Route, 'venue' | 'loanVToken' | 'listaId'>): string => r.venue === 'venus' ? r.loanVToken : r.listaId;
export const routeKeyOf = (r: V2Route, v: V2Vault): RouteKey => ({ venue: r.venue, marketId: marketIdOf(r), loan: r.loanSymbol, vault: { venue: v.venue, address: v.target } });

export type V2ReaderDeps = { v2: StrategyEarnV2; multicall: V2Multicall; now?: () => number;
  /** Symbol and decimals of a collateral token; default: the chain-97 profile, else the token's own `symbol()` / `decimals()`. */
  asset?: (token: Address) => { symbol: string; decimals: number } | undefined;
  /** USD price (8 decimals per whole token) of a collateral, from the lending venue's oracle; chain 97: the shared lending oracle. */
  priceOracle?: Address;
  /** AtpRegistry (enrollment the consent is pinned to). */
  atpRegistry?: Address;
  bookTtlMs?: number; marketTtlMs?: number };

const profileAssets = new Map(Object.entries(TESTNET_97.assets as Record<string, { token: string; decimals: number }>).map(([symbol, a]) => [a.token.toLowerCase(), { symbol, decimals: a.decimals }]));

/** One vault's numbers for one account (or the market as a whole when `account` is zero). */
export type V2VaultRead = V2Vault & { open: boolean; rateKnown: boolean; shouldExit: boolean; supplyBps: number; incentiveBps: number; utilizationBps: number | null;
  /** Can take a deposit now: open, rate known, utilization ≤ 90% where readable, and (ERC4626) `maxDeposit` > 0. */
  eligible: boolean; liquidityRaw: bigint | null };
export type V2RouteRead = V2Route & { open: boolean; borrowBps: number; borrowIncentiveBps: number; collateralBps: number; targetLtvBps: number; deleverageLtvBps: number; liquidationLtvBps: number;
  /** Loan raw units that can still be borrowed: venue liquidity under the route's utilization line, and the CRE8 route cap. */
  borrowableRaw: bigint; limits: RouteLimits;
  /** Collateral raw units the venue can still take (Venus supply cap); null = no cap known. */
  collateralRoomRaw: bigint | null };
export type V2Market = { at: number; routes: V2RouteRead[]; vaults: V2VaultRead[]; snapshot: RoutingSnapshot; limits: (routeId: Hex) => RouteLimits | undefined; lookup: RouteLookup };

export type V2AccountRead = { account: Address; box: Address; state: V2AccountState;
  policy: { maxDebt: bigint; rewardRecipient: Address; strategyId: bigint; enabled: boolean };
  enrollment: { strategyId: bigint; paused: boolean } | null;
  /** Consent usable now: enabled, given under the current enrollment, enrollment not paused. */
  consent: boolean;
  routes: { route: V2Route; vault: V2Vault | null; collateralRaw: bigint; collateralValueUsd: bigint; debtRaw: bigint; routeDebtRaw: bigint; principalRaw: bigint; openedAt: number; shouldDeleverage: boolean;
    ltvBps: number; targetLtvBps: number; deleverageLtvBps: number; liquidationLtvBps: number; limits: RouteLimits }[];
  vaults: { vault: V2Vault; assetsRaw: bigint; since: number; shouldExit: boolean }[];
  /** Per loan token: idle in the box (`lens.idleOf`), the account's own balance and its allowance to the executor. */
  tokens: Record<string, { token: Address; idleRaw: bigint; cashRaw: bigint; allowanceRaw: bigint }>;
  rewards: { token: Address; boxRaw: bigint; accountRaw: bigint; allowanceRaw: bigint }[];
  /** Net value of the strategy money: vault holdings + idle − debt, loan tokens at 1 USD (18 decimals). Collateral is counted with the holdings. */
  earnNetUsd: bigint };

/** Raw token units as a number of whole tokens (USD for a loan token), exact to 6 decimals. */
const usd = (raw: bigint, decimals = 18) => Number(raw / 10n ** BigInt(Math.max(0, decimals - 6))) / 10 ** Math.min(6, decimals);

export function createV2Reader(deps: V2ReaderDeps) {
  const { v2, multicall } = deps, now = deps.now ?? Date.now;
  const loanSymbol = new Map(Object.entries(v2.loanTokens).map(([s, a]) => [a!.toLowerCase(), s as Stable]));
  const assetOf = deps.asset ?? ((t: Address) => v2.chainId === 97 ? profileAssets.get(t.toLowerCase()) : undefined);
  const oracle = deps.priceOracle ?? (v2.chainId === 97 ? STRATEGY_EARN_97.lendingOracle as Address : undefined);
  const atpRegistry = deps.atpRegistry ?? (v2.chainId === 97 ? TESTNET_97.contracts.registry as Address : undefined);
  const reg = (functionName: string, args: readonly unknown[] = []): Read => ({ target: v2.registry, abi: V2_REGISTRY_ABI, functionName, args });
  const lens = (functionName: string, args: readonly unknown[] = []): Read => ({ target: v2.lens, abi: V2_LENS_ABI, functionName, args });
  const venue = (target: Address, functionName: string, args: readonly unknown[] = []): Read => ({ target, abi: VENUE_ABI, functionName, args });
  const must = <T>(v: unknown | null, what: string): T => { if (v === null || v === undefined) throw new Error('routing v2 read failed: ' + what); return v as T; };

  let book: V2Book | null = null, bookInflight: Promise<V2Book> | null = null;
  async function readBook(): Promise<V2Book> {
    const [routeCount, vaultCount] = await multicall([reg('routeCount'), reg('vaultCount')]);
    const nr = Number(must<bigint>(routeCount, 'routeCount')), nv = Number(must<bigint>(vaultCount, 'vaultCount'));
    const ids = await multicall([...Array.from({ length: nr }, (_, i) => reg('routeIds', [BigInt(i)])), ...Array.from({ length: nv }, (_, i) => reg('vaultIds', [BigInt(i)]))]);
    const routeIds = ids.slice(0, nr).map((x, i) => lower(must<Hex>(x, `routeIds(${i})`)) as Hex), vaultIds = ids.slice(nr).map((x, i) => lower(must<Hex>(x, `vaultIds(${i})`)) as Hex);
    const rows = await multicall([...routeIds.map(id => reg('route', [id])), ...vaultIds.map(id => reg('vault', [id]))]);
    type R = { venue: number; collateral: Address; loan: Address; listaId: Hex; collateralVToken: Address; loanVToken: Address; enabled: boolean; retired: boolean };
    type V = { kind: number; token: Address; target: Address; receipt: Address; enabled: boolean; retired: boolean };
    const rawRoutes = routeIds.map((routeId, i) => ({ routeId, r: must<R>(rows[i], 'route ' + routeId) }));
    // Tokens the profile does not know are asked for their own symbol and decimals.
    const unknown = [...new Set(rawRoutes.map(x => lower(x.r.collateral)).filter(t => !assetOf(t)))];
    const meta = await multicall(unknown.flatMap(t => [venue(t, 'symbol'), venue(t, 'decimals')]));
    const asset = (t: Address) => { const known = assetOf(t); if (known) return known; const k = unknown.indexOf(lower(t)); const symbol = meta[k * 2], decimals = meta[k * 2 + 1];
      return typeof symbol === 'string' && typeof decimals === 'number' ? { symbol, decimals } : undefined; };
    const routes: V2Route[] = [];
    for (const { routeId, r } of rawRoutes) {
      const v = VENUES[r.venue], sym = loanSymbol.get(lower(r.loan)), a = asset(r.collateral);
      // A route in a loan token or collateral this backend does not know is left alone (never guessed).
      if (!v || !sym || !a) continue;
      routes.push({ routeId, venue: v, collateral: lower(r.collateral), symbol: a.symbol, decimals: a.decimals, loan: lower(r.loan), loanSymbol: sym, listaId: lower(r.listaId) as Hex,
        collateralVToken: lower(r.collateralVToken), loanVToken: lower(r.loanVToken), enabled: r.enabled, retired: r.retired });
    }
    const vaults: V2Vault[] = [];
    vaultIds.forEach((vaultId, i) => {
      const x = must<V>(rows[nr + i], 'vault ' + vaultId), kind = KINDS[x.kind], sym = loanSymbol.get(lower(x.token));
      if (!kind || !sym) return;
      vaults.push({ vaultId, venue: kind, token: lower(x.token), tokenSymbol: sym, target: lower(x.target), receipt: lower(x.receipt), enabled: x.enabled, retired: x.retired });
    });
    return { routes, vaults, at: now() };
  }
  /** The allowlist, re-read every `bookTtlMs` (10 minutes): a stale copy is served while one refresh runs. */
  async function getBook(): Promise<V2Book> {
    const ttl = deps.bookTtlMs ?? 10 * 60_000;
    if (book && now() - book.at < ttl) return book;
    bookInflight ??= readBook().then(b => { book = b; return b; }).finally(() => { bookInflight = null; });
    return book ?? bookInflight;
  }

  let market: V2Market | null = null, marketInflight: Promise<V2Market> | null = null;
  async function readMarket(): Promise<V2Market> {
    const b = await getBook();
    const routes = b.routes.filter(r => !r.retired), vaults = b.vaults.filter(v => !v.retired);
    const vTokens = [...new Set(routes.filter(r => r.venue === 'venus').map(r => r.collateralVToken))];
    const res = await multicall([
      ...routes.flatMap(r => [lens('routeStatus', [r.routeId, zeroAddress]), lens('minLoan', [r.routeId]), lens('minDebt', [r.routeId])]),
      ...vaults.flatMap(v => [lens('vaultStatus', [v.vaultId, zeroAddress]),
        // What can be withdrawn now where it is one read: a vToken's cash, the underlying held by an Aave aToken.
        v.venue === 'venus' ? venue(v.target, 'getCash') : v.venue === 'aave' ? venue(v.token, 'balanceOf', [v.receipt]) : venue(v.target, 'maxDeposit', [v2.executor]),
        v.venue === 'lista' ? venue(v.target, 'maxDeposit', [v2.executor]) : venue(v.token, 'decimals')]),
      ...vTokens.flatMap(t => [venue(v2.venusComptroller, 'supplyCaps', [t]), venue(t, 'totalSupply'), venue(t, 'exchangeRateStored')]),
    ]);
    type RS = { open: boolean; borrowRate: bigint; collateralRate: bigint; borrowIncentiveRate: bigint; collateralIncentiveRate: bigint; borrowUtilizationBps: bigint; availableLiquidity: bigint; borrowCapLeft: bigint;
      targetLtv: bigint; deleverageLtv: bigint; liquidationLtv: bigint };
    type VS = { open: boolean; rateKnown: boolean; utilizationKnown: boolean; shouldExit: boolean; supplyRate: bigint; incentiveRate: bigint; utilizationBps: bigint };
    const room = new Map<string, bigint | null>();
    vTokens.forEach((t, i) => {
      const [cap, supply, rate] = res.slice(routes.length * 3 + vaults.length * 3 + i * 3) as (bigint | null)[];
      // Venus: a cap of 0 means minting is not allowed; max uint is unlimited. Unreadable (mock comptroller) = no cap known.
      room.set(t, cap === null || cap === undefined || supply === null || supply === undefined || rate === null || rate === undefined || cap >= 2n ** 255n ? null
        : cap > supply * rate / E18 ? cap - supply * rate / E18 : 0n);
    });
    const vaultReads: V2VaultRead[] = [];
    vaults.forEach((v, i) => {
      const s = res[routes.length * 3 + i * 3] as VS | null, a = res[routes.length * 3 + i * 3 + 1] as bigint | null, d = res[routes.length * 3 + i * 3 + 2];
      if (!s) return; // unreadable this round: not a target, and positions in it are judged stale by the engine
      const takes = v.venue !== 'lista' || (typeof d === 'bigint' ? d > 0n : true);
      const utilization = s.utilizationKnown ? Number(s.utilizationBps) : null;
      vaultReads.push({ ...v, open: s.open, rateKnown: s.rateKnown, shouldExit: s.shouldExit, supplyBps: bpsOf(s.supplyRate), incentiveBps: bpsOf(s.incentiveRate), utilizationBps: utilization,
        eligible: v.enabled && s.open && s.rateKnown && takes && (utilization === null || utilization <= 9_000),
        liquidityRaw: s.shouldExit ? 0n : v.venue === 'lista' ? null : a });
    });
    const routeReads: V2RouteRead[] = [];
    routes.forEach((r, i) => {
      const s = res[i * 3] as RS | null;
      if (!s) return;
      const minLoan = res[i * 3 + 1] as bigint | null, minDebt = res[i * 3 + 2] as bigint | null;
      // Borrowable under the route's utilization line is the venue's to enforce (the registry holds the line); the lens
      // reports the liquidity that is there and what is left under the CRE8 cap. A route closed for new borrowing lends 0.
      const borrowable = r.enabled && s.open ? (s.availableLiquidity < s.borrowCapLeft ? s.availableLiquidity : s.borrowCapLeft) : 0n;
      routeReads.push({ ...r, open: s.open, borrowBps: bpsOf(s.borrowRate), borrowIncentiveBps: bpsOf(s.borrowIncentiveRate), collateralBps: bpsOf(s.collateralRate + s.collateralIncentiveRate),
        targetLtvBps: bpsOf(s.targetLtv), deleverageLtvBps: bpsOf(s.deleverageLtv), liquidationLtvBps: bpsOf(s.liquidationLtv), borrowableRaw: borrowable,
        limits: { minLoanRaw: minLoan ?? 0n, minDebtRaw: minDebt ?? 0n }, collateralRoomRaw: r.venue === 'venus' ? room.get(r.collateralVToken) ?? null : null });
    });
    const at = now();
    // Prices for the supply-cap room (USD): one oracle read per capped collateral.
    const capped = [...new Set(routeReads.filter(r => r.collateralRoomRaw !== null).map(r => r.collateral))];
    const prices = oracle && capped.length > 0 ? await multicall(capped.map(t => venue(oracle, 'peek', [t]))) : [];
    const priceOf = (t: Address) => { const p = prices[capped.indexOf(t)]; return typeof p === 'bigint' ? Number(p) / 1e8 : null; };
    const routingVaults: RoutingVault[] = vaultReads.map(v => ({ token: v.tokenSymbol, venue: v.venue, name: vaultName(v), address: v.target, apyBps: v.supplyBps + v.incentiveBps, baseBps: v.supplyBps,
      incentiveBps: v.incentiveBps, tvlUsd: null, eligible: v.eligible, ...(v.liquidityRaw === null ? {} : { liquidityUsd: usd(v.liquidityRaw) }) }));
    const bestVault = (token: Stable) => routingVaults.filter(v => v.token === token && v.eligible).sort((x, y) => y.apyBps - x.apyBps)[0] ?? routingVaults.find(v => v.token === token);
    const options: Record<string, RouteOption[]> = {};
    for (const r of routeReads) {
      const vault = bestVault(r.loanSymbol);
      if (!vault) continue; // no vault for this token at all: nothing to borrow into
      const netBorrowBps = r.borrowBps - r.borrowIncentiveBps, carryBps = vault.apyBps - netBorrowBps, liquidityUsd = usd(r.borrowableRaw);
      const price = r.collateralRoomRaw === null ? null : priceOf(r.collateral);
      (options[r.symbol] ??= []).push({ protocol: r.venue, venue: r.venue, ratioBps: r.targetLtvBps, factorBps: r.liquidationLtvBps, extraBps: Math.trunc(carryBps * r.targetLtvBps / 10_000) + r.collateralBps,
        loan: r.loanSymbol, marketId: marketIdOf(r), borrowApyBps: r.borrowBps, incentiveBps: r.borrowIncentiveBps, netBorrowBps, liquidityUsd, lltvBps: r.liquidationLtvBps, limited: liquidityUsd < 50_000,
        vault, carryBps, collateralIncentiveBps: r.collateralBps,
        ...(r.collateralRoomRaw === null || price === null ? {} : { collateralRoomUsd: usd(r.collateralRoomRaw, r.decimals) * price }) });
    }
    const byRoute = new Map(routeReads.map(r => [r.routeId, r])), byVault = new Map(b.vaults.map(v => [v.vaultId, v])), allRoutes = new Map(b.routes.map(r => [r.routeId, r]));
    return { at, routes: routeReads, vaults: vaultReads, snapshot: { at, sourceAt: { venus: at, lista: at, aave: at }, options, vaults: routingVaults },
      limits: id => byRoute.get(lower(id) as Hex)?.limits,
      lookup: { route: id => { const r = allRoutes.get(lower(id) as Hex); return r ? { asset: r.symbol, venue: r.venue, loan: r.loanSymbol } : null; },
        vault: id => { const v = byVault.get(lower(id) as Hex); return v ? { venue: v.venue } : null; } } };
  }
  /** Rates, limits and gates of every route and vault, cached `marketTtlMs` (60 s): one read serves a whole scheduler round. */
  async function getMarket(): Promise<V2Market> {
    const ttl = deps.marketTtlMs ?? 60_000;
    if (market && now() - market.at < ttl) return market;
    marketInflight ??= readMarket().then(m => { market = m; return m; }).finally(() => { marketInflight = null; });
    return marketInflight;
  }

  /** Does this account have anything on v2: consent given, a position, or money in the box? One request. */
  async function touched(account: Address): Promise<{ enabled: boolean; routes: Hex[]; vaults: Hex[] }> {
    const [p, routes, vaults] = await multicall([reg('policy', [account]), reg('accountRoutes', [account]), reg('accountVaults', [account])]);
    return { enabled: must<{ enabled: boolean }>(p, 'policy').enabled, routes: must<Hex[]>(routes, 'accountRoutes').map(x => lower(x) as Hex), vaults: must<Hex[]>(vaults, 'accountVaults').map(x => lower(x) as Hex) };
  }

  /**
   * Everything the planner and the API need about one account, at the node's head. `collaterals`: the tokens to look at
   * besides the ones already posted (the portfolio's eligible assets); each is read for its free balance and price.
   */
  async function readAccount(account: Address, collaterals: readonly Address[] = []): Promise<V2AccountRead> {
    const [b, m] = await Promise.all([getBook(), getMarket()]);
    account = lower(account);
    const head = await multicall([reg('policy', [account]), reg('accountPrincipalUsd', [account]), reg('accountRoutes', [account]), reg('accountVaults', [account]),
      { target: v2.executor, abi: V2_EXECUTOR_ABI, functionName: 'boxOf', args: [account] },
      ...(atpRegistry ? [venue(atpRegistry, 'enrollments', [account])] : [])]);
    const policy = must<{ maxDebt: bigint; rewardRecipient: Address; strategyId: bigint; enabled: boolean }>(head[0], 'policy');
    const principalUsd = must<bigint>(head[1], 'accountPrincipalUsd');
    const routeIds = must<Hex[]>(head[2], 'accountRoutes').map(x => lower(x) as Hex), vaultIds = must<Hex[]>(head[3], 'accountVaults').map(x => lower(x) as Hex);
    const box = lower(must<Address>(head[4], 'boxOf'));
    const e = atpRegistry ? head[5] as readonly [bigint, number, boolean] | null : null;
    const enrollment = e ? { strategyId: e[0], paused: e[2] } : null;
    const routes = routeIds.map(id => b.routes.find(r => r.routeId === id)).filter((r): r is V2Route => r !== undefined);
    const vaults = vaultIds.map(id => b.vaults.find(v => v.vaultId === id)).filter((v): v is V2Vault => v !== undefined);
    if (routes.length !== routeIds.length || vaults.length !== vaultIds.length) throw new Error('routing v2: the account holds a route or vault this backend does not know');
    const tokens = Object.entries(v2.loanTokens) as [Stable, Address][];
    const eligible = [...new Set([...collaterals.map(lower), ...routes.map(r => r.collateral)])].filter(t => b.routes.some(r => r.collateral === t && !r.retired));
    const venusLoans = [...new Map(b.routes.filter(r => r.venue === 'venus').map(r => [r.loanSymbol, r.loanVToken])).entries()];
    const res = await multicall([
      ...routes.flatMap(r => [lens('routeStatus', [r.routeId, account]), lens('minLoan', [r.routeId]), lens('minDebt', [r.routeId])]),
      ...vaults.map(v => lens('vaultStatus', [v.vaultId, account])),
      ...tokens.flatMap(([, t]) => [lens('idleOf', [account, t]), venue(t, 'balanceOf', [account]), venue(t, 'allowance', [account, v2.executor])]),
      ...v2.rewardTokens.flatMap(t => [venue(t, 'balanceOf', [box]), venue(t, 'balanceOf', [account]), venue(t, 'allowance', [account, v2.executor])]),
      ...eligible.flatMap(t => [venue(t, 'balanceOf', [account]), ...(oracle ? [venue(oracle, 'peek', [t])] : [])]),
      ...venusLoans.map(([, vToken]) => venue(vToken, 'borrowBalanceStored', [account])),
    ]);
    let at = 0;
    type RS = { shouldDeleverage: boolean; targetLtv: bigint; deleverageLtv: bigint; liquidationLtv: bigint; ltv: bigint; collateral: bigint; collateralValue: bigint; debt: bigint; routeDebt: bigint; principal: bigint; openedAt: bigint };
    const routeReads = routes.map(route => {
      const s = must<RS>(res[at], 'routeStatus ' + route.routeId), minLoan = res[at + 1] as bigint | null, minDebt = res[at + 2] as bigint | null; at += 3;
      return { route, vault: null as V2Vault | null, collateralRaw: s.collateral, collateralValueUsd: s.collateralValue, debtRaw: s.debt, routeDebtRaw: s.routeDebt, principalRaw: s.principal, openedAt: Number(s.openedAt),
        shouldDeleverage: s.shouldDeleverage, ltvBps: bpsOf(s.ltv), targetLtvBps: bpsOf(s.targetLtv), deleverageLtvBps: bpsOf(s.deleverageLtv), liquidationLtvBps: bpsOf(s.liquidationLtv),
        limits: { minLoanRaw: minLoan ?? 0n, minDebtRaw: minDebt ?? 0n } };
    });
    // Contracts review round 3: once a token's Venus principal is repaid and only interest is owed, `lens.routeDebt`
    // answers the WHOLE debt on every Venus route of that token. The account's debt in a token is `lens.debt` (the same
    // number on each of those routes), so the per-route shares are capped to add up to it and nothing is counted twice.
    for (const token of new Set(routeReads.filter(r => r.route.venue === 'venus').map(r => r.route.loan))) {
      const group = routeReads.filter(r => r.route.venue === 'venus' && r.route.loan === token);
      let left = group[0]!.debtRaw;
      for (const r of group) { if (r.routeDebtRaw > left) r.routeDebtRaw = left; left -= r.routeDebtRaw; }
    }
    const vaultReads = vaults.map(vault => { const s = must<{ assets: bigint; since: bigint; shouldExit: boolean }>(res[at++], 'vaultStatus ' + vault.vaultId); return { vault, assetsRaw: s.assets, since: Number(s.since), shouldExit: s.shouldExit }; });
    const tokenReads: V2AccountRead['tokens'] = {};
    for (const [symbol, token] of tokens) { tokenReads[symbol] = { token, idleRaw: must<bigint>(res[at], 'idleOf ' + symbol), cashRaw: must<bigint>(res[at + 1], 'balance ' + symbol), allowanceRaw: (res[at + 2] as bigint | null) ?? 0n }; at += 3; }
    const rewards = v2.rewardTokens.map(token => { const r = { token, boxRaw: (res[at] as bigint | null) ?? 0n, accountRaw: (res[at + 1] as bigint | null) ?? 0n, allowanceRaw: (res[at + 2] as bigint | null) ?? 0n }; at += 3; return r; });
    const free = new Map<string, { freeRaw: bigint; priceE8: bigint | null }>();
    for (const t of eligible) { free.set(t, { freeRaw: must<bigint>(res[at], 'balance ' + t), priceE8: oracle ? res[at + 1] as bigint | null : null }); at += oracle ? 2 : 1; }
    const venusOwed = new Map(venusLoans.map(([symbol], i) => [symbol, (res[at + i] as bigint | null) ?? 0n]));

    // The box's holding per loan token: the vault with the most in it is "the" vault of that token's positions.
    const holdingOf = (token: Address) => vaultReads.filter(v => v.vault.token === token).sort((x, y) => (y.assetsRaw > x.assetsRaw ? 1 : y.assetsRaw < x.assetsRaw ? -1 : 0))[0] ?? null;
    const nominalVault = (token: Address) => holdingOf(token)?.vault ?? b.vaults.filter(v => v.token === token && !v.retired)
      .sort((x, y) => (m.vaults.find(z => z.vaultId === y.vaultId)?.supplyBps ?? 0) - (m.vaults.find(z => z.vaultId === x.vaultId)?.supplyBps ?? 0))[0] ?? null;
    for (const r of routeReads) r.vault = nominalVault(r.route.loan);
    const enabled = policy.enabled && policy.maxDebt > 0n && (enrollment === null || (enrollment.strategyId === policy.strategyId && !enrollment.paused));
    const holdings: V2Holding[] = [];
    for (const token of eligible) {
      const f = free.get(token)!, symbol = b.routes.find(r => r.collateral === token)!.symbol, decimals = b.routes.find(r => r.collateral === token)!.decimals;
      // One position per asset: the route with debt, else the one with collateral posted.
      const own = routeReads.filter(r => r.route.collateral === token && (r.collateralRaw > 0n || r.routeDebtRaw > 0n)).sort((x, y) => (y.routeDebtRaw > x.routeDebtRaw ? 1 : y.routeDebtRaw < x.routeDebtRaw ? -1 : 0))[0];
      const price = f.priceE8 !== null && f.priceE8 > 0n ? Number(f.priceE8) / 1e8 : own && own.collateralRaw > 0n ? usd(own.collateralValueUsd) / usd(own.collateralRaw, decimals) : null;
      if (price === null) { if (f.freeRaw > 0n) throw new Error('routing v2: no price for ' + symbol); continue; }
      const postedRaw = own?.collateralRaw ?? 0n, postedUsd = own ? usd(own.collateralValueUsd) : 0;
      const base = { symbol, collateral: token, freeCollateralRaw: f.freeRaw, collateralUsd: postedUsd + usd(f.freeRaw, decimals) * price };
      if (!own || !own.vault) { holdings.push({ ...base, position: null }); continue; }
      const t = tokenReads[own.route.loanSymbol]!, h = holdingOf(own.route.loan);
      const since = Math.max(own.openedAt, h?.since ?? 0) * 1000;
      holdings.push({ ...base, postedRaw, routeDebtRaw: own.routeDebtRaw, vaultAssetsRaw: h?.assetsRaw ?? 0n, idleRaw: t.idleRaw, cashRaw: t.cashRaw, minDebtRaw: own.limits.minDebtRaw,
        position: { route: routeKeyOf(own.route, own.vault), debtUsd: usd(own.routeDebtRaw), since: since || now(), ltvBps: own.ltvBps, deleverageLtvBps: own.deleverageLtvBps, shouldDeleverage: own.shouldDeleverage, postedUsd } });
    }
    // draft5 ForeignDebt: the account owes the token on Venus and holds no v2 Venus position in it.
    const foreignVenusLoans = venusLoans.map(([symbol]) => symbol).filter(symbol => (venusOwed.get(symbol) ?? 0n) > 0n && !routes.some(r => r.venue === 'venus' && r.loanSymbol === symbol));
    // Venus reports the account's whole debt in a token on every route of that token: count it once, plus the Lista markets.
    const debtTotal = [...new Set(routeReads.map(r => r.route.loan))].reduce((sum, token) => {
      const venus = routeReads.find(r => r.route.loan === token && r.route.venue === 'venus')?.debtRaw ?? 0n;
      return sum + venus + routeReads.filter(r => r.route.loan === token && r.route.venue === 'lista').reduce((s, r) => s + r.debtRaw, 0n);
    }, 0n);
    const boxTotal = vaultReads.reduce((s, v) => s + v.assetsRaw, 0n) + Object.values(tokenReads).reduce((s, t) => s + t.idleRaw, 0n);
    return { account, box, policy: { ...policy, rewardRecipient: lower(policy.rewardRecipient) }, enrollment, consent: enabled, routes: routeReads, vaults: vaultReads, tokens: tokenReads, rewards,
      earnNetUsd: boxTotal - debtTotal,
      state: { enabled, policyMaxDebtUsdRaw: policy.maxDebt, principalUsdRaw: principalUsd, holdings, ...(foreignVenusLoans.length > 0 ? { foreignVenusLoans } : {}) } };
  }

  return { v2, book: getBook, market: getMarket, touched, account: readAccount,
    /** Pending incentive a chain-97 mock earn vault owes the box (`rewardOf`); null where the vault has no such read. */
    async vaultReward(vault: Address, box: Address): Promise<bigint | null> { const [r] = await multicall([venue(vault, 'rewardOf', [box])]); return typeof r === 'bigint' ? r : null; },
    /**
     * Chain 97 only: the incentive a simulated venue owes the account for a posted route (Venus collateral vToken
     * `rewardOf(account)`, Moolah `rewardOf(listaId, account)`), in the venue's payout token. null where there is no such read.
     */
    async venueReward(route: Pick<V2Route, 'venue' | 'collateralVToken' | 'listaId'>, account: Address): Promise<bigint | null> {
      const [r] = await multicall([route.venue === 'venus' ? venue(route.collateralVToken, 'rewardOf', [account]) : venue(v2.moolah, 'rewardOf', [route.listaId, account])]);
      return typeof r === 'bigint' ? r : null;
    },
    /** The account's strategy box and whether anything was ever deposited through it (it is deployed on the first deposit). */
    async box(account: Address): Promise<{ box: Address; deployed: boolean }> {
      const [box, vaults] = await multicall([{ target: v2.executor, abi: V2_EXECUTOR_ABI, functionName: 'boxOf', args: [account] }, reg('accountVaults', [account])]);
      return { box: lower(must<Address>(box, 'boxOf')), deployed: must<Hex[]>(vaults, 'accountVaults').length > 0 };
    },
    /** Drop the cached market (after this process sent a transaction that changes it). */
    invalidate() { market = null; } };
}
export type V2Reader = ReturnType<typeof createV2Reader>;

const vaultName = (v: V2Vault) => `${v.venue === 'lista' ? 'Lista' : v.venue === 'venus' ? 'Venus' : 'Aave v3'} ${v.tokenSymbol}${v.venue === 'lista' ? ' Vault' : ''}`;

const readers = new Map<string, V2Reader>();
/** The process-wide reader for a deployment: public nodes only (see the header). */
export function defaultV2Reader(v2: StrategyEarnV2, env: NodeJS.ProcessEnv = process.env): V2Reader {
  const key = `${v2.chainId}:${v2.executor}`;
  let r = readers.get(key);
  if (!r) {
    const urls = v2PublicRpcs(v2.chainId, env);
    const client = createPublicClient({ transport: urls.length === 1 ? http(urls[0], { timeout: 12_000, retryCount: 1 }) : fallback(urls.map(u => http(u, { timeout: 12_000, retryCount: 0 })), { rank: false }) });
    r = createV2Reader({ v2, multicall: v2Multicall(client) });
    readers.set(key, r);
  }
  return r;
}
/** Estimated gas of one executor call sent by the account itself (public node), or null when it cannot be estimated. */
export async function v2EstimateGas(v2: StrategyEarnV2, account: Address, call: Call, env: NodeJS.ProcessEnv = process.env): Promise<bigint | null> {
  try {
    const client = createPublicClient({ transport: http(v2PublicRpcs(v2.chainId, env)[0], { timeout: 8_000, retryCount: 0 }) });
    return await client.estimateGas({ account, to: call.to, data: call.data });
  } catch { return null; }
}
export const V2_STABLES = STABLES;
