/**
 * Real BSC mainnet (chain 56) rates for the yield strategy display (GET /strategy-earn/markets `mainnetRates`).
 * Testnet positions keep accruing at the simulated chain-97 rates; this only feeds what the app shows.
 *
 * Sources (read-only, keyless; never the paid RPC_URL):
 * - Venus: public API api.venus.io, core pool vUSDT (borrow APY + XVS borrow incentive, supply APY + XVS supply incentive)
 *   and the bStock collateral markets' XVS supply incentive (NVDAB, TSLAB, SPCXB are listed in the Venus core pool).
 * - Lista: public API api.lista.org, Moolah borrow markets. bStock collateral markets are zone 5 (the app's "bStock" category;
 *   plain Moolah markets with the raw bStock token as collateralToken, no smart-pool LP); everything else is zone 0. Per asset
 *   (pickListaMarket): its USD-stable loan markets (USDT, USDC, USD1, U, lisUSD; open-term), net rate = rate − borrow emission
 *   (can be negative); the lowest net rate among those with ≥ $50k available, else the lowest among those with ≥ $1k
 *   (`limited`), else Lista's main USDT market (LISTA_MAIN_USDT_MARKET, `limited`). Supply: the USDT Moolah vault with the
 *   largest deposits (apy + emission apy). The API serves at most 50 rows per page.
 * - Aave v3: Pool.getReserveData(USDT).currentLiquidityRate over the public BSC node (one eth_call per refresh).
 * The vault the borrowed USDT would go to on mainnet = the venue with the highest USDT supply APY (same rule as Cash Earn's
 * best rate). Cached MAINNET_RATES_MS; a failed source keeps its last good value.
 */
export const MAINNET_RATES_MS = 10 * 60_000;
export const PUBLIC_RPC_56 = 'https://bsc-rpc.publicnode.com';
export const VENUS_API = 'https://api.venus.io/markets/core-pool?chainId=56&limit=100';
export const LISTA_MARKETS_API = 'https://api.lista.org/api/moolah/borrow/markets?pageSize=50';
export const LISTA_STABLES: ReadonlySet<string> = new Set(['USDT', 'USDC', 'USD1', 'U', 'lisUSD']);
/** Available liquidity under this is shown as capacity-limited. */
export const LISTA_LIMITED_USD = 50_000;
/** Chain-97 symbol -> Lista mainnet collateral name, where they differ. */
const LISTA_COLLATERAL: Record<string, string> = { WBNB: 'BNB' };
export const LISTA_VAULTS_API = 'https://api.lista.org/api/moolah/vault/list?page=1&pageSize=100';
export const LISTA_MAIN_USDT_MARKET = '0x975f4cf3db16812d995f60e19bec91a96108d47429237acc8d208bc0519c5b19';
export const AAVE_POOL_56 = '0x6807dc923806fe8fd134338eabca509979a7e0cb';
export const USDT_56 = '0x55d398326f99059ff775485246999027b3197955';
export const VUSDT_56 = '0xfd5840cd36d94d7229439859c0112a4185bc0255';

export type Venue = 'venus' | 'lista' | 'aave';
export type MainnetRates = {
  chainId: 56; updatedAt: string;
  /** Highest USDT supply APY: where the borrowed USDT would go on mainnet. */
  vault: { venue: Venue; supplyApyBps: number };
  supply: Partial<Record<Venue, { supplyApyBps: number; source: string }>>;
  borrow: Partial<Record<'venus' | 'lista', { borrowApyBps: number; incentiveBps: number; source: string }>>;
  /** Lista market chosen per collateral symbol (chain-97 symbol, e.g. NVDAB, WBNB). */
  lista?: Record<string, ListaPick>;
  /** Venus XVS supply incentive per collateral symbol (bps), e.g. NVDAB. */
  collateralIncentiveBps: Record<string, number>;
};

export type ListaPick = { marketId: string; collateral: string; loan: string; borrowApyBps: number; incentiveBps: number; netBorrowBps: number;
  liquidityUsd: number; lltvBps: number; limited: boolean; zone: number };
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const bps = (fraction: number) => Math.round(fraction * 10_000);
const pctBps = (percent: number) => Math.round(percent * 100);
const num = (v: unknown) => { const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN; if (!Number.isFinite(n)) throw new Error('bad number'); return n; };

async function json(f: Fetcher, url: string, init?: RequestInit): Promise<any> {
  const res = await f(url, { ...init, signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json', ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

export async function readVenus(f: Fetcher) {
  const d = await json(f, VENUS_API);
  const list: any[] = d?.result ?? [];
  const v = list.find(m => String(m.address).toLowerCase() === VUSDT_56);
  if (!v) throw new Error('vUSDT missing');
  const incentives: Record<string, number> = {};
  for (const m of list) if (typeof m.underlyingSymbol === 'string' && /B$/.test(m.underlyingSymbol)) incentives[m.underlyingSymbol] = pctBps(num(m.supplyXvsApy ?? 0));
  return {
    borrow: { borrowApyBps: pctBps(num(v.borrowApy)), incentiveBps: pctBps(num(v.borrowXvsApy ?? 0)), source: 'Venus core pool vUSDT ' + VUSDT_56 },
    supply: { supplyApyBps: pctBps(num(v.supplyApy)) + pctBps(num(v.supplyXvsApy ?? 0)), source: 'Venus core pool vUSDT ' + VUSDT_56 },
    incentives,
  };
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
const toPick = (m: any, limited: boolean): ListaPick => {
  const borrowApyBps = bps(num(m.rate)), incentiveBps = bps(num(m.borrowEmissionApy ?? 0));
  return { marketId: String(m.id).toLowerCase(), collateral: m.collateral, loan: m.loan, borrowApyBps, incentiveBps, netBorrowBps: borrowApyBps - incentiveBps,
    liquidityUsd: Math.round(num(m.liquidityUsd)), lltvBps: bps(num(m.lltv)), limited, zone: Number(m.zone ?? 0) };
};
/** Lowest net borrow rate among the asset's open-term USD-stable markets with ≥ $50k available; else ≥ $1k (limited). */
export function pickListaMarket(all: readonly any[], collateral: string): ListaPick | null {
  const rows = all.filter(m => m.collateral === collateral && LISTA_STABLES.has(m.loan) && Number(m.termType ?? 0) === 0);
  const net = (m: any) => num(m.rate) - num(m.borrowEmissionApy ?? 0);
  const best = (list: any[]) => list.sort((a, b) => net(a) - net(b))[0];
  const liquid = rows.filter(m => num(m.liquidityUsd) >= LISTA_LIMITED_USD), usable = rows.filter(m => num(m.liquidityUsd) >= 1_000);
  if (liquid.length) return toPick(best(liquid), false);
  if (usable.length) return toPick(best(usable), true);
  return null;
}

export async function readLista(f: Fetcher, symbols: readonly string[] = []) {
  const [bstock, general] = await Promise.all([listaMarkets(f, 5), listaMarkets(f, 0)]);
  const main = general.find(m => String(m.id).toLowerCase() === LISTA_MAIN_USDT_MARKET);
  if (!main || main.loan !== 'USDT') throw new Error('Lista main USDT market missing');
  const all = [...bstock, ...general], picks: Record<string, ListaPick> = {};
  for (const s of symbols) picks[s] = pickListaMarket(all, LISTA_COLLATERAL[s] ?? s) ?? { ...toPick(main, true), collateral: LISTA_COLLATERAL[s] ?? s };
  const vaults: any[] = (await json(f, LISTA_VAULTS_API))?.data?.list ?? [];
  const usdt = vaults.filter(v => String(v.asset).toLowerCase() === USDT_56).sort((a, b) => num(b.depositsUsd) - num(a.depositsUsd))[0];
  if (!usdt) throw new Error('Lista USDT vault missing');
  return {
    borrow: { borrowApyBps: bps(num(main.rate)), incentiveBps: bps(num(main.borrowEmissionApy ?? 0)),
      source: 'Lista Moolah ' + main.collateral + '/USDT market ' + LISTA_MAIN_USDT_MARKET },
    supply: { supplyApyBps: bps(num(usdt.apy)) + bps(num(usdt.emissionApy ?? 0)), source: 'Lista ' + usdt.name + ' ' + String(usdt.address).toLowerCase() },
    picks,
  };
}

export async function readAave(f: Fetcher, rpc = PUBLIC_RPC_56) {
  const data = '0x35ea6a75' + USDT_56.slice(2).padStart(64, '0'); // getReserveData(address)
  const r = await json(f, rpc, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: AAVE_POOL_56, data }, 'latest'] }) });
  const hex: string = r?.result;
  if (typeof hex !== 'string' || hex.length < 2 + 64 * 3) throw new Error('Aave reserve unreadable');
  const apr = Number(BigInt('0x' + hex.slice(2 + 64 * 2, 2 + 64 * 3))) / 1e27; // currentLiquidityRate (ray, APR)
  const apy = (1 + apr / 31_536_000) ** 31_536_000 - 1;
  return { supply: { supplyApyBps: bps(apy), source: 'Aave v3 Pool ' + AAVE_POOL_56 + ' USDT reserve' } };
}

/** Cached reader: fresh within MAINNET_RATES_MS; after that the last value is served while one refresh runs. */
export function createMainnetRates(deps: { fetch?: Fetcher; now?: () => number; ttlMs?: number; listaSymbols?: readonly string[] } = {}) {
  const f: Fetcher = deps.fetch ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? Date.now, ttl = deps.ttlMs ?? MAINNET_RATES_MS;
  let last: MainnetRates | null = null, at = 0, inflight: Promise<MainnetRates | null> | null = null;
  async function refresh(): Promise<MainnetRates | null> {
    const [venus, lista, aave] = await Promise.allSettled([readVenus(f), readLista(f, deps.listaSymbols ?? []), readAave(f)]);
    const supply = { ...(last?.supply ?? {}) }, borrow = { ...(last?.borrow ?? {}) };
    let incentives = last?.collateralIncentiveBps ?? {}, picks = last?.lista ?? {};
    if (venus.status === 'fulfilled') { supply.venus = venus.value.supply; borrow.venus = venus.value.borrow; incentives = venus.value.incentives; }
    if (lista.status === 'fulfilled') { supply.lista = lista.value.supply; borrow.lista = lista.value.borrow; picks = lista.value.picks; }
    if (aave.status === 'fulfilled') supply.aave = aave.value.supply;
    const best = (Object.entries(supply) as [Venue, { supplyApyBps: number }][]).sort((a, b) => b[1].supplyApyBps - a[1].supplyApyBps)[0];
    if (!best) return last;
    const fresh = venus.status === 'fulfilled' || lista.status === 'fulfilled' || aave.status === 'fulfilled';
    last = { chainId: 56, updatedAt: fresh ? new Date(now()).toISOString() : last?.updatedAt ?? new Date(now()).toISOString(),
      vault: { venue: best[0], supplyApyBps: best[1].supplyApyBps }, supply, borrow, lista: picks, collateralIncentiveBps: incentives };
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
 * + collateral incentive. Lista uses the asset's own chosen market (net rate may be negative: incentives pay the borrower).
 * New borrowing stops when the borrow cost exceeds the vault rate (negative carry), as on chain. `limited` = under $50k available. */
export function mainnetQuote(r: MainnetRates, protocol: 'venus' | 'lista', symbol: string, ratioBps: number | null) {
  const pick = protocol === 'lista' ? r.lista?.[symbol] ?? null : null;
  const b = pick ? { borrowApyBps: pick.borrowApyBps, incentiveBps: pick.incentiveBps } : r.borrow[protocol];
  if (!b || ratioBps === null) return null;
  const vaultBps = r.vault.supplyApyBps, collateralIncentiveBps = protocol === 'venus' ? r.collateralIncentiveBps[symbol] ?? 0 : 0;
  const carry = vaultBps - b.borrowApyBps + b.incentiveBps, open = carry > 0;
  const carryBps = Math.trunc(carry * ratioBps / 10_000);
  return { open, reason: open ? null : 'negative_carry', borrowBps: b.borrowApyBps, borrowIncentiveBps: b.incentiveBps, vaultBps, vaultIncentiveBps: 0,
    collateralBps: 0, collateralIncentiveBps, ratioBps, carryBps, extraApyBps: open ? carryBps + collateralIncentiveBps : 0,
    limited: pick?.limited ?? false, loan: pick?.loan ?? 'USDT', listaMarketId: pick?.marketId ?? null, liquidityUsd: pick?.liquidityUsd ?? null };
}
