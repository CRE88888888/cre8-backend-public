import { query } from '../db.js';
import { configuredChainId, testnetAssets } from '../testnet-profile.js';

export type InfoFund = { id: string; name: string; assetSymbols: string[] };
export type InfoQuery = (sql: string, params?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

// Catalogue crypto/numeraire symbols are a separate namespace from SEC stock tickers
// (TRX Gold and Bank of Chile actually use TRX/BCH). Never resolve them through SEC.
const CRYPTO_SYMBOLS = new Set(['USDT', 'USDC', 'DAI', 'BTC', 'BTCB', 'WBTC', 'ETH', 'WETH', 'BNB', 'WBNB',
  'AVAX', 'DOGE', 'SOL', 'TRX', 'XRP', 'LTC', 'LINK', 'ADA', 'SUI', 'TON', 'TONCOIN', 'UNI', 'BCH', 'AAVE', 'DOT', 'FIL',
  'NEAR', 'ZEC', 'SHIB', 'PEPE', 'CAKE', 'ATOM', 'XAUT']);
export function companySymbol(symbol: string): boolean { return !CRYPTO_SYMBOLS.has(symbol.toUpperCase()); }
export function symbolAliases(symbol: string): string[] {
  const upper = symbol.toUpperCase();
  if (upper === 'BTCB' || upper === 'WBTC') return [upper, 'BTC'];
  if (upper === 'WETH') return [upper, 'ETH'];
  if (upper === 'WBNB') return [upper, 'BNB'];
  if (companySymbol(upper) && symbol.endsWith('on')) return [upper.slice(0, -2), upper];
  return companySymbol(upper) && upper.endsWith('B') ? [upper.slice(0, -1), upper] : [upper];
}

/** Current public catalogue only. Allocation addresses are authoritative; symbol is optional metadata. */
export async function readInfoCatalogue(run: InfoQuery = query, chainId = configuredChainId()): Promise<InfoFund[]> {
  const rows = (await run(`select s.id::text, s.name, a->>'address' as address,
      pa.symbol as symbol,a->>'symbol' as allocation_symbol
    from strategies s
    join lateral (select allocation from strategy_versions v where v.strategy_id=s.id
      and v.active_at is not null and v.active_at<=now() order by version desc limit 1) v on true
    cross join lateral jsonb_array_elements(v.allocation->'assets') a
    left join priceable_assets pa on lower(pa.address)=lower(a->>'address')
    where s.is_public and coalesce((a->>'weightBps')::integer,0)>0 order by s.id`)).rows;
  const profile = chainId === 97 ? testnetAssets() : [];
  const funds = new Map<string, InfoFund>();
  for (const row of rows) {
    if (typeof row.id !== 'string' || typeof row.name !== 'string') throw new Error('info catalogue unavailable');
    const fund = funds.get(row.id) ?? { id: row.id, name: row.name, assetSymbols: [] };
    const symbol = profile.find(asset => asset.address.toLowerCase() === String(row.address).toLowerCase())?.symbol
      ?? (typeof row.symbol === 'string' ? row.symbol : typeof row.allocation_symbol === 'string' ? row.allocation_symbol : undefined);
    if (symbol && !fund.assetSymbols.includes(symbol)) fund.assetSymbols.push(symbol);
    funds.set(row.id, fund);
  }
  return [...funds.values()];
}

export function affectedFunds(symbols: readonly string[], funds: readonly InfoFund[], category?: unknown): { id: string; name: string }[] {
  const related = new Set(symbols.map(symbol => symbol.toUpperCase()));
  return funds.filter(fund => fund.assetSymbols.some(symbol => (category !== 'company' || companySymbol(symbol)) &&
    symbolAliases(symbol).some(alias => related.has(alias)))).map(({ id, name }) => ({ id, name }));
}
