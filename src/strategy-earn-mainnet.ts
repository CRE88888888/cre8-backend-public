/**
 * Real BSC mainnet (chain 56) rates for the yield strategy display (GET /strategy-earn/markets `mainnetRates`).
 * Testnet positions keep accruing at the simulated chain-97 rates; this only feeds what the app shows.
 *
 * Each asset may borrow any of USDT, USDC, USD1 or U on any venue that lists it as collateral (Venus core pool and/or Lista
 * Moolah; the chain-97 venue assignment is NOT used here) and deposits the same token (no swap). For every venue × token:
 *   carry = best realistic supply APY for that token − net borrow rate (rate − incentive, may be < 0)
 *   ratio = target LTV = min(tier cap, F / 2), F = that market's collateral factor (Venus) or LLTV (Lista); tier caps are the
 *           contract's (cre8-contracts docs/borrow-97 §2): index & large cap 35%, stock 30%, crypto-linked 20%
 *   extra = carry × ratio + collateral incentive (Venus XVS supply)
 * The route with the highest extra wins among markets with ≥ $1k available; under $50k is flagged `limited`. Nothing per asset
 * is configured: every refresh re-discovers Venus listings and all Lista markets (zone 5 + 0, every page), drops paused or
 * empty ones, and re-chooses. No usable market -> no route (the asset borrows nothing). Spec: docs/strategy-earn-mainnet-routing.zh-TW.md.
 *
 * Sources (read-only, keyless; never the paid RPC_URL):
 * - Venus: api.venus.io core pool — vUSDT / vUSDC / vUSD1 / vU borrow APY + XVS borrow incentive, supply APY + XVS supply
 *   incentive, and the bStock collateral markets' XVS supply incentive (NVDAB, TSLAB, SPCXB).
 * - Lista: api.lista.org Moolah borrow markets, zone 5 (bStock: plain Moolah markets whose collateralToken is the raw bStock
 *   token, no smart-pool LP) + zone 0 (everything else); at most 50 rows per page. Supply: Moolah vaults.
 * - Aave v3: Pool.getReserveData(token).currentLiquidityRate over the public BSC node (two eth_calls per refresh).
 * Supply incentives: counted at face value (Venus XVS, Lista emission). A Lista vault counts as realistic with ≥ $1M deposits,
 * not "Exclusive", and emission ≤ 3× its base APY (campaign-driven vaults such as Saturn USDT, ~98% emission, are left out).
 * Cached MAINNET_RATES_MS; a failed source keeps its last good value.
 */
export const MAINNET_RATES_MS = 10 * 60_000;
export const PUBLIC_RPC_56 = 'https://bsc-rpc.publicnode.com';
export const VENUS_API = 'https://api.venus.io/markets/core-pool?chainId=56&limit=100';
export const LISTA_MARKETS_API = 'https://api.lista.org/api/moolah/borrow/markets?pageSize=50';
export const LISTA_VAULTS_API = 'https://api.lista.org/api/moolah/vault/list?page=1&pageSize=100';
export const AAVE_POOL_56 = '0x6807dc923806fe8fd134338eabca509979a7e0cb';
export const STABLES = ['USDT', 'USDC', 'USD1', 'U'] as const;
export type Stable = typeof STABLES[number];
export const TOKENS_56: Record<Stable, string> = { USDT: '0x55d398326f99059ff775485246999027b3197955', USDC: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
  USD1: '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d', U: '0xce24439f2d9c6a2289f741120fe202248b666666' };
export const USDT_56 = TOKENS_56.USDT;
export const VUSDT_56 = '0xfd5840cd36d94d7229439859c0112a4185bc0255';
/** Available liquidity under this is shown as capacity-limited. */
export const LISTA_LIMITED_USD = 50_000;
export const LISTA_VAULT_MIN_USD = 1_000_000;
/** Markets with less available than this are not usable at all. */
export const MIN_LIQUIDITY_USD = 1_000;
/** Venus pausedActionsBitmap bits (ComptrollerInterface Action enum). */
const VENUS_MINT = 1 << 0, VENUS_BORROW = 1 << 2, VENUS_ENTER_MARKET = 1 << 7;
/** Strategy tier per asset (cre8-contracts deployments/testnet-97.json `borrow.markets[].tier`) and the contract's tier caps. */
export const TIER_CAP_BPS = { INDEX_LARGE_CAP: 3500, STOCK: 3000, CRYPTO_LINKED: 2000 } as const;
export const ASSET_TIER: Record<string, keyof typeof TIER_CAP_BPS> = {
  QQQB: 'INDEX_LARGE_CAP', SPYB: 'INDEX_LARGE_CAP', EWYB: 'INDEX_LARGE_CAP', XAUt: 'INDEX_LARGE_CAP', AAPLB: 'INDEX_LARGE_CAP', MSFTB: 'INDEX_LARGE_CAP',
  GOOGLB: 'INDEX_LARGE_CAP', AMZNB: 'INDEX_LARGE_CAP', METAB: 'INDEX_LARGE_CAP', TSMB: 'INDEX_LARGE_CAP', AVGOB: 'INDEX_LARGE_CAP',
  MSTRB: 'CRYPTO_LINKED', BTCB: 'CRYPTO_LINKED', WBNB: 'CRYPTO_LINKED', COINB: 'CRYPTO_LINKED', BMNRB: 'CRYPTO_LINKED', BNCB: 'CRYPTO_LINKED' };
/** Target ratio for a market with collateral factor / LLTV `factorBps`: min(tier cap, F / 2). Unlisted assets are STOCK. */
export const targetRatioBps = (symbol: string, factorBps: number) => Math.min(TIER_CAP_BPS[ASSET_TIER[symbol] ?? 'STOCK'], Math.floor(factorBps / 2));
/** Chain-97 symbol -> Lista mainnet collateral name, where they differ. */
const LISTA_COLLATERAL: Record<string, string> = { WBNB: 'BNB' };

export type Venue = 'venus' | 'lista' | 'aave';
export type SupplyVault = { token: Stable; venue: Venue; name: string; address: string; apyBps: number; baseBps: number; incentiveBps: number; tvlUsd: number | null };
export type Route = { protocol: 'venus' | 'lista'; venue: 'venus' | 'lista'; ratioBps: number; factorBps: number; extraBps: number; loan: Stable; marketId: string | null; borrowApyBps: number; incentiveBps: number; netBorrowBps: number;
  liquidityUsd: number | null; lltvBps: number | null; limited: boolean; vault: SupplyVault; carryBps: number;
  /** Venus XVS supply incentive on the collateral (bps of collateral value); 0 on Lista. Already inside extraBps. */
  collateralIncentiveBps: number;
  /** USD of new collateral the venue can still take under its supply cap (Venus); null / absent = no limit known. */
  collateralRoomUsd?: number | null;
  /** The smallest target debt (USD) the venue lets a position open with (Moolah `minLoan`, read from the chain the money is on); absent = none. */
  minBorrowUsd?: number;
  /** Best borrow X → swap → deposit Y route, when it beats this one (unscaled carry gain, bps). Display only; we default to same token. */
  cross: { loan: Stable; deposit: Stable; gainBps: number } | null };
export type MainnetRates = {
  chainId: 56; updatedAt: string;
  /** Best realistic supply vault per stable. */
  vaults: Partial<Record<Stable, SupplyVault>>;
  /** Chosen route per chain-97 strategy symbol (e.g. NVDAB, WBNB). */
  routes: Record<string, Route>;
  /** Highest supply APY across all stables (kept for older app builds). */
  vault: { venue: Venue; supplyApyBps: number };
  /** Venus XVS supply incentive per collateral symbol (bps), e.g. NVDAB. */
  collateralIncentiveBps: Record<string, number>;
};

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const bps = (fraction: number) => Math.round(fraction * 10_000);
const pctBps = (percent: number) => Math.round(percent * 100);
const num = (v: unknown) => { const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN; if (!Number.isFinite(n)) throw new Error('bad number'); return n; };
const isStable = (s: unknown): s is Stable => typeof s === 'string' && (STABLES as readonly string[]).includes(s);

async function json(f: Fetcher, url: string, init?: RequestInit): Promise<any> {
  const res = await f(url, { ...init, signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json', ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

export async function readVenus(f: Fetcher) {
  const list: any[] = (await json(f, VENUS_API))?.result ?? [];
  const borrow: Partial<Record<Stable, { borrowApyBps: number; incentiveBps: number; address: string; liquidityUsd?: number }>> = {};
  const supply: Partial<Record<Stable, SupplyVault>> = {};
  const incentives: Record<string, number> = {}, collateral: Record<string, { factorBps: number; address: string; roomUsd: number | null }> = {};
  for (const m of list) {
    const sym = m.underlyingSymbol;
    if (typeof sym === 'string') incentives[sym] = pctBps(num(m.supplyXvsApy ?? 0));
    const paused = Number(m.pausedActionsBitmap ?? 0);
    if (typeof sym === 'string' && m.canBeCollateral !== false && num(m.collateralFactorMantissa ?? 0) > 0 && !(paused & (VENUS_MINT | VENUS_ENTER_MARKET)))
      collateral[sym] = { factorBps: Math.round(num(m.collateralFactorMantissa) / 1e14), address: String(m.address).toLowerCase(), roomUsd: venusSupplyRoomUsd(m) };
    if (!isStable(sym)) continue;
    const address = String(m.address).toLowerCase();
    if (m.isBorrowable !== false && !(paused & VENUS_BORROW) && num(m.borrowApy ?? 0) > 0)
      borrow[sym] = { borrowApyBps: pctBps(num(m.borrowApy)), incentiveBps: pctBps(num(m.borrowXvsApy ?? 0)), address, liquidityUsd: Math.round(num(m.liquidityCents ?? 0) / 100) };
    const base = pctBps(num(m.supplyApy ?? 0)), inc = pctBps(num(m.supplyXvsApy ?? 0));
    if (!(paused & VENUS_MINT) && base + inc > 0)
      supply[sym] = { token: sym, venue: 'venus', name: 'Venus ' + m.symbol, address, apyBps: base + inc, baseBps: base, incentiveBps: inc, tvlUsd: Math.round(num(m.totalSupplyUnderlyingCents ?? 0) / 100) || null };
  }
  if (list.length === 0) throw new Error('Venus API empty');
  return { borrow, supply, incentives, collateral };
}

/**
 * USD of collateral a Venus market can still take under its supply cap (cre8-contracts borrow-routing-v2 §11: vNVDAB was at
 * 1,499.2 of 1,500 on 2026-11-24 — a full market reverts on mint, so it is not a route). Supplied = vToken supply × exchange
 * rate. null = the API row does not carry the numbers (treated as no limit known); a cap of 0 means minting is not allowed.
 */
export function venusSupplyRoomUsd(m: { supplyCapsMantissa?: unknown; totalSupplyMantissa?: unknown; exchangeRateMantissa?: unknown; underlyingDecimal?: unknown; tokenPriceCents?: unknown }): number | null {
  try {
    if (m.supplyCapsMantissa === undefined || m.totalSupplyMantissa === undefined || m.exchangeRateMantissa === undefined || m.tokenPriceCents === undefined) return null;
    const cap = BigInt(String(m.supplyCapsMantissa)), supplied = BigInt(String(m.totalSupplyMantissa)) * BigInt(String(m.exchangeRateMantissa)) / 10n ** 18n;
    if (cap >= 2n ** 255n) return null; // unlimited
    const room = cap > supplied ? cap - supplied : 0n;
    return Number(room) / 10 ** Number(m.underlyingDecimal ?? 18) * num(m.tokenPriceCents) / 100;
  } catch { return null; }
}

async function listaMarkets(f: Fetcher, zone: number): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page <= 20; page++) {
    const d = await json(f, `${LISTA_MARKETS_API}&zone=${zone}&page=${page}`);
    const list: any[] = d?.data?.list ?? [];
    out.push(...list);
    if (list.length === 0 || out.length >= num(d?.data?.total ?? 0)) break;
  }
  return out;
}

/**
 * Can this ERC4626 vault take a deposit right now? `maxDeposit(address)` over the public node: a Moolah vault whose supply
 * queue is empty or whose caps are all reached answers 0 and its deposit reverts AllCapsReached (the Gauntlet USDT vault on
 * 2026-11-24). null = could not be read (the vault is then judged on the other rules only).
 */
export async function vaultTakesDeposits(f: Fetcher, vault: string, rpc = PUBLIC_RPC_56): Promise<boolean | null> {
  try {
    const data = '0x402d267d' + '0'.repeat(63) + '1'; // maxDeposit(address(1))
    const r = await json(f, rpc, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: vault, data }, 'latest'] }) });
    const hex: unknown = r?.result;
    if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hex)) return null;
    return BigInt(hex) > 0n;
  } catch { return null; }
}

export async function readLista(f: Fetcher) {
  const [bstock, general, vaultList] = await Promise.all([listaMarkets(f, 5), listaMarkets(f, 0), json(f, LISTA_VAULTS_API)]);
  if (bstock.length + general.length === 0) throw new Error('Lista API empty');
  const supply: Partial<Record<Stable, SupplyVault>> = {}, allVaults: RoutingVault[] = [];
  for (const v of (vaultList?.data?.list ?? []) as any[]) {
    const token = STABLES.find(s => TOKENS_56[s] === String(v.asset).toLowerCase());
    if (!token) continue;
    const base = bps(num(v.apy)), inc = bps(num(v.emissionApy ?? 0)), tvl = num(v.depositsUsd);
    const cand: SupplyVault = { token, venue: 'lista', name: String(v.name), address: String(v.address).toLowerCase(), apyBps: base + inc, baseBps: base, incentiveBps: inc, tvlUsd: Math.round(tvl) };
    // Only vaults that pass the cheap rules are asked on chain (a handful of eth_calls per refresh, public node).
    const eligible = !(tvl < LISTA_VAULT_MIN_USD || /exclusive/i.test(String(v.name)) || inc > 3 * base) && await vaultTakesDeposits(f, cand.address) !== false;
    allVaults.push({ ...cand, eligible });
    if (!eligible) continue;
    if (!supply[token] || cand.apyBps > supply[token]!.apyBps) supply[token] = cand;
  }
  return { markets: [...bstock, ...general], supply, allVaults };
}

export async function readAave(f: Fetcher, rpc = PUBLIC_RPC_56) {
  const supply: Partial<Record<Stable, SupplyVault>> = {};
  for (const token of STABLES) {
    const data = '0x35ea6a75' + TOKENS_56[token].slice(2).padStart(64, '0'); // getReserveData(address)
    const r = await json(f, rpc, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: AAVE_POOL_56, data }, 'latest'] }) });
    const hex: string = r?.result;
    if (typeof hex !== 'string' || hex.length < 2 + 64 * 3) continue; // not listed on Aave (or unreadable): no vault
    const apr = Number(BigInt('0x' + hex.slice(2 + 64 * 2, 2 + 64 * 3))) / 1e27; // currentLiquidityRate (ray, APR)
    const apy = bps((1 + apr / 31_536_000) ** 31_536_000 - 1);
    if (apy > 0) supply[token] = { token, venue: 'aave', name: 'Aave v3 ' + token, address: AAVE_POOL_56, apyBps: apy, baseBps: apy, incentiveBps: 0, tvlUsd: null };
  }
  return { supply };
}

type ListaMarket = { id: string; collateral: string; loan: string; rate: string; borrowEmissionApy?: string; liquidityUsd: string; lltv: string; termType?: number };
/** The asset's open-term Lista market for one loan token with the lowest net rate, among those with ≥ $1k available. */
export function listaMarketFor(all: readonly ListaMarket[], collateral: string, loan: Stable) {
  const net = (m: ListaMarket) => num(m.rate) - num(m.borrowEmissionApy ?? 0);
  return all.filter(m => m.collateral === collateral && m.loan === loan && Number(m.termType ?? 0) === 0 && num(m.liquidityUsd) >= 1_000)
    .sort((a, b) => net(a) - net(b))[0] ?? null;
}

type RouteInput = { symbol: string; listaMarkets: readonly ListaMarket[];
  venusBorrow: Partial<Record<Stable, { borrowApyBps: number; incentiveBps: number; address: string; liquidityUsd?: number }>>;
  venusCollateral?: Record<string, { factorBps: number; address: string; roomUsd?: number | null }>; venusIncentives?: Record<string, number>;
  vaults: Partial<Record<Stable, SupplyVault>> };
export type RouteOption = Omit<Route, 'cross'>;
/**
 * Every usable venue × token for this asset (Venus if it is collateral there, Lista for every open-term market on that
 * collateral), each with ≥ MIN_LIQUIDITY_USD available: extra = carry × min(tier cap, F/2) + Venus collateral incentive.
 * Carry may be ≤ 0. The routing engine (strategy-earn-routing.ts) reads the same list. A Venus option carries what is left
 * under the market's supply cap (`collateralRoomUsd`): the engine does not send new collateral that does not fit, and
 * `chooseRoute` (display) leaves a full market out.
 */
export function routeOptions(input: RouteInput): RouteOption[] {
  const collateral = LISTA_COLLATERAL[input.symbol] ?? input.symbol;
  const options: RouteOption[] = [];
  const venusCf = input.venusCollateral?.[input.symbol];
  for (const loan of STABLES) {
    const vault = input.vaults[loan];
    if (!vault) continue;
    const b = input.venusBorrow[loan];
    if (venusCf && b && (b.liquidityUsd === undefined || b.liquidityUsd >= MIN_LIQUIDITY_USD)) {
      const netBorrowBps = b.borrowApyBps - b.incentiveBps, ratioBps = targetRatioBps(input.symbol, venusCf.factorBps), carryBps = vault.apyBps - netBorrowBps;
      const inc = input.venusIncentives?.[input.symbol] ?? 0;
      options.push({ protocol: 'venus', venue: 'venus', ratioBps, factorBps: venusCf.factorBps, extraBps: Math.trunc(carryBps * ratioBps / 10_000) + inc, loan,
        marketId: b.address, borrowApyBps: b.borrowApyBps, incentiveBps: b.incentiveBps, netBorrowBps, liquidityUsd: b.liquidityUsd ?? null, lltvBps: venusCf.factorBps,
        limited: b.liquidityUsd !== undefined && b.liquidityUsd < LISTA_LIMITED_USD, vault, carryBps, collateralIncentiveBps: inc,
        ...(venusCf.roomUsd === undefined ? {} : { collateralRoomUsd: venusCf.roomUsd }) });
    }
    for (const m of input.listaMarkets.filter(x => x.collateral === collateral && x.loan === loan && Number(x.termType ?? 0) === 0 && num(x.liquidityUsd) >= MIN_LIQUIDITY_USD)) {
      const borrowApyBps = bps(num(m.rate)), incentiveBps = bps(num(m.borrowEmissionApy ?? 0)), liquidityUsd = Math.round(num(m.liquidityUsd));
      const lltvBps = bps(num(m.lltv)), ratioBps = targetRatioBps(input.symbol, lltvBps), carryBps = vault.apyBps - (borrowApyBps - incentiveBps);
      options.push({ protocol: 'lista', venue: 'lista', ratioBps, factorBps: lltvBps, extraBps: Math.trunc(carryBps * ratioBps / 10_000), loan, marketId: String(m.id).toLowerCase(),
        borrowApyBps, incentiveBps, netBorrowBps: borrowApyBps - incentiveBps, liquidityUsd, lltvBps, limited: liquidityUsd < LISTA_LIMITED_USD, vault, carryBps, collateralIncentiveBps: 0 });
    }
  }
  return options;
}

/** Highest extra among `routeOptions`. No usable market → null (no route). */
export function chooseRoute(input: RouteInput): Route | null {
  // A Venus market whose supply cap is (nearly) reached cannot take the collateral: not a route to show.
  const options = routeOptions(input).filter(o => o.collateralRoomUsd === undefined || o.collateralRoomUsd === null || o.collateralRoomUsd >= MIN_LIQUIDITY_USD);
  const chosen = [...options].sort((a, b) => b.extraBps - a.extraBps)[0];
  if (!chosen) return null;
  // Cross-token (display only): the cheapest borrow on the chosen venue, deposited into the best vault overall.
  const top = (Object.values(input.vaults) as SupplyVault[]).sort((a, b) => b.apyBps - a.apyBps)[0];
  const cheapest = options.filter(o => o.venue === chosen.venue).sort((a, b) => a.netBorrowBps - b.netBorrowBps)[0];
  const gain = top && cheapest ? top.apyBps - cheapest.netBorrowBps - chosen.carryBps : 0;
  return { ...chosen, cross: top && cheapest && gain > 0 && (cheapest.loan !== chosen.loan || top.token !== chosen.loan)
    ? { loan: cheapest.loan, deposit: top.token, gainBps: gain } : null };
}

/**
 * What the routing engine reads: every borrow option per asset and every stablecoin supply vault (not only the best one per
 * token, so an open position's own vault can still be priced), with the time each source was last read successfully.
 */
export type RoutingVault = SupplyVault & { /** Passes the "realistic" filter (size, not Exclusive, not campaign-driven): may receive new deposits. */ eligible: boolean;
  /** USD that can be withdrawn right now, when the source reports it. */ liquidityUsd?: number | null };
export type RoutingSnapshot = { at: number; sourceAt: Record<Venue, number | null>; options: Record<string, RouteOption[]>; vaults: RoutingVault[] };

/** Cached reader: fresh within MAINNET_RATES_MS; after that the last value is served while one refresh runs. */
export function createMainnetRates(deps: { fetch?: Fetcher; now?: () => number; ttlMs?: number;
  markets?: readonly { symbol: string; protocol: 'venus' | 'lista' }[] } = {}) {
  const f: Fetcher = deps.fetch ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? Date.now, ttl = deps.ttlMs ?? MAINNET_RATES_MS;
  let last: MainnetRates | null = null, at = 0, inflight: Promise<MainnetRates | null> | null = null;
  let venusLast: Awaited<ReturnType<typeof readVenus>> | null = null, listaLast: Awaited<ReturnType<typeof readLista>> | null = null,
    aaveLast: Awaited<ReturnType<typeof readAave>> | null = null;
  const sourceAt: Record<Venue, number | null> = { venus: null, lista: null, aave: null };
  let routing: RoutingSnapshot | null = null;
  async function refresh(): Promise<MainnetRates | null> {
    const [venus, lista, aave] = await Promise.allSettled([readVenus(f), readLista(f), readAave(f)]);
    const fresh = venus.status === 'fulfilled' || lista.status === 'fulfilled' || aave.status === 'fulfilled';
    if (venus.status === 'fulfilled') { venusLast = venus.value; sourceAt.venus = now(); }
    if (lista.status === 'fulfilled') { listaLast = lista.value; sourceAt.lista = now(); }
    if (aave.status === 'fulfilled') { aaveLast = aave.value; sourceAt.aave = now(); }
    const vaults: Partial<Record<Stable, SupplyVault>> = {};
    for (const src of [venusLast?.supply, listaLast?.supply, aaveLast?.supply]) for (const v of Object.values(src ?? {}) as SupplyVault[]) {
      if (!vaults[v.token] || v.apyBps > vaults[v.token]!.apyBps) vaults[v.token] = v;
    }
    const top = (Object.values(vaults) as SupplyVault[]).sort((a, b) => b.apyBps - a.apyBps)[0];
    if (!top) return last;
    const routes: Record<string, Route> = {}, options: Record<string, RouteOption[]> = {};
    for (const m of deps.markets ?? []) {
      const input = { symbol: m.symbol, listaMarkets: listaLast?.markets ?? [], venusBorrow: venusLast?.borrow ?? {}, venusCollateral: venusLast?.collateral,
        venusIncentives: venusLast?.incentives, vaults };
      const r = chooseRoute(input);
      if (r) routes[m.symbol] = r;
      options[m.symbol] = routeOptions(input);
    }
    routing = { at: now(), sourceAt: { ...sourceAt }, options, vaults: [
      ...(Object.values(venusLast?.supply ?? {}) as SupplyVault[]).map(v => ({ ...v, eligible: true })), ...(listaLast?.allVaults ?? []),
      ...(Object.values(aaveLast?.supply ?? {}) as SupplyVault[]).map(v => ({ ...v, eligible: true }))] };
    last = { chainId: 56, updatedAt: fresh ? new Date(now()).toISOString() : last?.updatedAt ?? new Date(now()).toISOString(), vaults, routes,
      vault: { venue: top.venue, supplyApyBps: top.apyBps }, collateralIncentiveBps: venusLast?.incentives ?? {} };
    if (fresh) at = now();
    return last;
  }
  const kick = () => inflight ??= refresh().catch(() => last).finally(() => { inflight = null; });
  return {
    async get(): Promise<MainnetRates | null> {
      if (last && now() - at < ttl) return last;
      if (last) { void kick(); return last; }
      return kick();
    },
    /** The last value, without waiting for or starting a refresh (null until the first `get()` finished). For per-request paths. */
    peek(): MainnetRates | null { return last; },
    /** The same refresh as `get()`, in the shape the routing engine reads (every option and vault, per-source read times). */
    async routing(): Promise<RoutingSnapshot | null> { await this.get(); return routing; },
  };
}

/** One strategy asset at mainnet rates on its chosen route (venue and ratio from mainnet, not the chain-97 config): extra =
 * carry × ratio + collateral incentive (EARN_UX B.3). New borrowing stops when the borrow cost exceeds the vault rate. */
export function mainnetQuote(r: MainnetRates, _protocol: 'venus' | 'lista', symbol: string, _ratioBps?: number | null) {
  const route = r.routes[symbol];
  if (!route) return null;
  const ratioBps = route.ratioBps, collateralIncentiveBps = route.venue === 'venus' ? r.collateralIncentiveBps[symbol] ?? 0 : 0;
  const open = route.carryBps > 0, carryBps = Math.trunc(route.carryBps * ratioBps / 10_000);
  return { open, reason: open ? null : 'negative_carry', venue: route.venue, borrowBps: route.borrowApyBps, borrowIncentiveBps: route.incentiveBps, vaultBps: route.vault.apyBps,
    vaultIncentiveBps: 0, collateralBps: 0, collateralIncentiveBps, ratioBps, factorBps: route.factorBps, carryBps, extraApyBps: open ? carryBps + collateralIncentiveBps : 0,
    limited: route.limited, loan: route.loan, marketId: route.marketId, liquidityUsd: route.liquidityUsd,
    vault: { venue: route.vault.venue, name: route.vault.name, token: route.vault.token, address: route.vault.address, apyBps: route.vault.apyBps } };
}
