/**
 * Real BSC mainnet (chain 56) rates for the yield strategy display (GET /strategy-earn/markets `mainnetRates`).
 * Testnet positions keep accruing at the simulated chain-97 rates; this only feeds what the app shows.
 *
 * Each asset may borrow any of USDT, USDC, USD1 or U and deposits the same token (no swap). Per asset and token:
 *   carry = best realistic supply APY for that token − the asset's net borrow rate for that token (rate − incentive, may be < 0)
 * and the route with the highest carry wins, preferring borrow markets with ≥ $50k available (else `limited`).
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
export const LISTA_MAIN_USDT_MARKET = '0x975f4cf3db16812d995f60e19bec91a96108d47429237acc8d208bc0519c5b19';
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
/** Chain-97 symbol -> Lista mainnet collateral name, where they differ. */
const LISTA_COLLATERAL: Record<string, string> = { WBNB: 'BNB' };

export type Venue = 'venus' | 'lista' | 'aave';
export type SupplyVault = { token: Stable; venue: Venue; name: string; address: string; apyBps: number; baseBps: number; incentiveBps: number; tvlUsd: number | null };
export type Route = { protocol: 'venus' | 'lista'; loan: Stable; marketId: string | null; borrowApyBps: number; incentiveBps: number; netBorrowBps: number;
  liquidityUsd: number | null; lltvBps: number | null; limited: boolean; vault: SupplyVault; carryBps: number;
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
  const borrow: Partial<Record<Stable, { borrowApyBps: number; incentiveBps: number; address: string }>> = {};
  const supply: Partial<Record<Stable, SupplyVault>> = {};
  const incentives: Record<string, number> = {};
  for (const m of list) {
    const sym = m.underlyingSymbol;
    if (typeof sym === 'string' && /B$/.test(sym)) incentives[sym] = pctBps(num(m.supplyXvsApy ?? 0));
    if (!isStable(sym) || num(m.borrowApy ?? 0) <= 0) continue;
    const address = String(m.address).toLowerCase();
    borrow[sym] = { borrowApyBps: pctBps(num(m.borrowApy)), incentiveBps: pctBps(num(m.borrowXvsApy ?? 0)), address };
    const base = pctBps(num(m.supplyApy)), inc = pctBps(num(m.supplyXvsApy ?? 0));
    supply[sym] = { token: sym, venue: 'venus', name: 'Venus ' + m.symbol, address, apyBps: base + inc, baseBps: base, incentiveBps: inc, tvlUsd: null };
  }
  if (!borrow.USDT) throw new Error('vUSDT missing');
  return { borrow, supply, incentives };
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

export async function readLista(f: Fetcher) {
  const [bstock, general, vaultList] = await Promise.all([listaMarkets(f, 5), listaMarkets(f, 0), json(f, LISTA_VAULTS_API)]);
  if (!general.some(m => String(m.id).toLowerCase() === LISTA_MAIN_USDT_MARKET)) throw new Error('Lista main USDT market missing');
  const supply: Partial<Record<Stable, SupplyVault>> = {};
  for (const v of (vaultList?.data?.list ?? []) as any[]) {
    const token = STABLES.find(s => TOKENS_56[s] === String(v.asset).toLowerCase());
    if (!token) continue;
    const base = bps(num(v.apy)), inc = bps(num(v.emissionApy ?? 0)), tvl = num(v.depositsUsd);
    if (tvl < LISTA_VAULT_MIN_USD || /exclusive/i.test(String(v.name)) || inc > 3 * base) continue;
    const cand: SupplyVault = { token, venue: 'lista', name: String(v.name), address: String(v.address).toLowerCase(), apyBps: base + inc, baseBps: base, incentiveBps: inc, tvlUsd: Math.round(tvl) };
    if (!supply[token] || cand.apyBps > supply[token]!.apyBps) supply[token] = cand;
  }
  return { markets: [...bstock, ...general], supply };
}

export async function readAave(f: Fetcher, rpc = PUBLIC_RPC_56) {
  const supply: Partial<Record<Stable, SupplyVault>> = {};
  for (const token of ['USDT', 'USDC'] as const) {
    const data = '0x35ea6a75' + TOKENS_56[token].slice(2).padStart(64, '0'); // getReserveData(address)
    const r = await json(f, rpc, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: AAVE_POOL_56, data }, 'latest'] }) });
    const hex: string = r?.result;
    if (typeof hex !== 'string' || hex.length < 2 + 64 * 3) throw new Error('Aave reserve unreadable');
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

/**
 * Same-token route with the highest carry; markets with ≥ $50k available first, else the best `limited` one. Venus markets
 * are pooled (no per-collateral cap): never limited. No usable market at all → Lista's main USDT market, limited.
 */
export function chooseRoute(input: { protocol: 'venus' | 'lista'; symbol: string; listaMarkets: readonly ListaMarket[];
  venusBorrow: Partial<Record<Stable, { borrowApyBps: number; incentiveBps: number; address: string }>>; vaults: Partial<Record<Stable, SupplyVault>> }): Route | null {
  const collateral = LISTA_COLLATERAL[input.symbol] ?? input.symbol;
  const options: Omit<Route, 'cross'>[] = [];
  for (const loan of STABLES) {
    const vault = input.vaults[loan];
    if (!vault) continue;
    if (input.protocol === 'venus') {
      const b = input.venusBorrow[loan];
      if (!b) continue;
      const netBorrowBps = b.borrowApyBps - b.incentiveBps;
      options.push({ protocol: 'venus', loan, marketId: b.address, borrowApyBps: b.borrowApyBps, incentiveBps: b.incentiveBps, netBorrowBps, liquidityUsd: null,
        lltvBps: null, limited: false, vault, carryBps: vault.apyBps - netBorrowBps });
    } else {
      const m = listaMarketFor(input.listaMarkets, collateral, loan);
      if (!m) continue;
      const borrowApyBps = bps(num(m.rate)), incentiveBps = bps(num(m.borrowEmissionApy ?? 0)), liquidityUsd = Math.round(num(m.liquidityUsd));
      options.push({ protocol: 'lista', loan, marketId: String(m.id).toLowerCase(), borrowApyBps, incentiveBps, netBorrowBps: borrowApyBps - incentiveBps, liquidityUsd,
        lltvBps: bps(num(m.lltv)), limited: liquidityUsd < LISTA_LIMITED_USD, vault, carryBps: vault.apyBps - (borrowApyBps - incentiveBps) });
    }
  }
  const best = (list: Omit<Route, 'cross'>[]) => [...list].sort((a, b) => b.carryBps - a.carryBps)[0];
  let chosen = best(options.filter(o => !o.limited)) ?? best(options);
  if (!chosen && input.protocol === 'lista') {
    const main = input.listaMarkets.find(m => String(m.id).toLowerCase() === LISTA_MAIN_USDT_MARKET), vault = input.vaults.USDT;
    if (!main || !vault) return null;
    const borrowApyBps = bps(num(main.rate)), incentiveBps = bps(num(main.borrowEmissionApy ?? 0));
    chosen = { protocol: 'lista', loan: 'USDT', marketId: LISTA_MAIN_USDT_MARKET, borrowApyBps, incentiveBps, netBorrowBps: borrowApyBps - incentiveBps,
      liquidityUsd: Math.round(num(main.liquidityUsd)), lltvBps: bps(num(main.lltv)), limited: true, vault, carryBps: vault.apyBps - (borrowApyBps - incentiveBps) };
  }
  if (!chosen) return null;
  // Cross-token: borrow the cheapest eligible token (same liquidity tier as the chosen one), deposit into the best vault overall.
  const tier = options.filter(o => o.limited === chosen!.limited);
  const top = (Object.values(input.vaults) as SupplyVault[]).sort((a, b) => b.apyBps - a.apyBps)[0];
  const cheapest = [...tier].sort((a, b) => a.netBorrowBps - b.netBorrowBps)[0];
  const gain = top && cheapest ? top.apyBps - cheapest.netBorrowBps - chosen.carryBps : 0;
  return { ...chosen, cross: top && cheapest && gain > 0 && (cheapest.loan !== chosen.loan || top.token !== chosen.loan)
    ? { loan: cheapest.loan, deposit: top.token, gainBps: gain } : null };
}

/** Cached reader: fresh within MAINNET_RATES_MS; after that the last value is served while one refresh runs. */
export function createMainnetRates(deps: { fetch?: Fetcher; now?: () => number; ttlMs?: number;
  markets?: readonly { symbol: string; protocol: 'venus' | 'lista' }[] } = {}) {
  const f: Fetcher = deps.fetch ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? Date.now, ttl = deps.ttlMs ?? MAINNET_RATES_MS;
  let last: MainnetRates | null = null, at = 0, inflight: Promise<MainnetRates | null> | null = null;
  let venusLast: Awaited<ReturnType<typeof readVenus>> | null = null, listaLast: Awaited<ReturnType<typeof readLista>> | null = null,
    aaveLast: Awaited<ReturnType<typeof readAave>> | null = null;
  async function refresh(): Promise<MainnetRates | null> {
    const [venus, lista, aave] = await Promise.allSettled([readVenus(f), readLista(f), readAave(f)]);
    const fresh = venus.status === 'fulfilled' || lista.status === 'fulfilled' || aave.status === 'fulfilled';
    if (venus.status === 'fulfilled') venusLast = venus.value;
    if (lista.status === 'fulfilled') listaLast = lista.value;
    if (aave.status === 'fulfilled') aaveLast = aave.value;
    const vaults: Partial<Record<Stable, SupplyVault>> = {};
    for (const src of [venusLast?.supply, listaLast?.supply, aaveLast?.supply]) for (const v of Object.values(src ?? {}) as SupplyVault[]) {
      if (!vaults[v.token] || v.apyBps > vaults[v.token]!.apyBps) vaults[v.token] = v;
    }
    const top = (Object.values(vaults) as SupplyVault[]).sort((a, b) => b.apyBps - a.apyBps)[0];
    if (!top) return last;
    const routes: Record<string, Route> = {};
    for (const m of deps.markets ?? []) {
      const r = chooseRoute({ protocol: m.protocol, symbol: m.symbol, listaMarkets: listaLast?.markets ?? [], venusBorrow: venusLast?.borrow ?? {}, vaults });
      if (r) routes[m.symbol] = r;
    }
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
  };
}

/** One strategy market at mainnet rates, same formula as extraApy (EARN_UX B.3): (vault − borrow + borrow incentive) × ratio
 * + collateral incentive, on the asset's chosen route. New borrowing stops when the borrow cost exceeds the vault rate
 * (negative carry), as on chain. */
export function mainnetQuote(r: MainnetRates, protocol: 'venus' | 'lista', symbol: string, ratioBps: number | null) {
  const route = r.routes[symbol];
  if (!route || route.protocol !== protocol || ratioBps === null) return null;
  const collateralIncentiveBps = protocol === 'venus' ? r.collateralIncentiveBps[symbol] ?? 0 : 0;
  const open = route.carryBps > 0, carryBps = Math.trunc(route.carryBps * ratioBps / 10_000);
  return { open, reason: open ? null : 'negative_carry', borrowBps: route.borrowApyBps, borrowIncentiveBps: route.incentiveBps, vaultBps: route.vault.apyBps,
    vaultIncentiveBps: 0, collateralBps: 0, collateralIncentiveBps, ratioBps, carryBps, extraApyBps: open ? carryBps + collateralIncentiveBps : 0,
    limited: route.limited, loan: route.loan, marketId: route.marketId, liquidityUsd: route.liquidityUsd,
    vault: { venue: route.vault.venue, name: route.vault.name, token: route.vault.token, address: route.vault.address, apyBps: route.vault.apyBps } };
}
