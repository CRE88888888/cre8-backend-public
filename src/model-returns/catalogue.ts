import assets from './assets.json' with { type: 'json' };
import { testnetAssets } from '../testnet-profile.js';
export type ModelSource = { kind: 'binance'; pair: string; seasoned: boolean } |
  { kind: 'yahoo'; ticker: string; currency: 'USD' | 'KRW'; fx?: string; fallback?: string };
export type ModelAsset = { symbol: string; address?: string; pair: string; source?: ModelSource };
// Validate the JSON at startup rather than asserting its inferred string fields into the discriminated union.
export const MODEL_ASSETS = assets.map(asset => {
  const source = asset.source;
  if (source.kind === 'binance' && 'pair' in source && typeof source.pair === 'string' && 'seasoned' in source && typeof source.seasoned === 'boolean') {
    return { ...asset, source: { kind: 'binance', pair: source.pair, seasoned: source.seasoned } } satisfies ModelAsset;
  }
  if (source.kind === 'yahoo' && 'ticker' in source && typeof source.ticker === 'string' && 'currency' in source &&
      (source.currency === 'USD' || source.currency === 'KRW')) {
    return { ...asset, source: { kind: 'yahoo', ticker: source.ticker, currency: source.currency,
      ...('fx' in source && typeof source.fx === 'string' ? { fx: source.fx } : {}),
      ...('fallback' in source && typeof source.fallback === 'string' ? { fallback: source.fallback } : {}) } } satisfies ModelAsset;
  }
  throw new Error('invalid_model_source');
});

export function closeSeries(asset: ModelAsset, fallback = false): `close:${string}` {
  const source = asset.source;
  return source?.kind === 'yahoo' ? `close:${fallback ? source.fallback : source.ticker}@yahoo${source.fx ? ':USD' : ''}`
    : `close:${source?.pair ?? asset.pair}@binance`;
}
export const checkedSeries = (series: `close:${string}`): `close:${string}` => `${series}:checked`;

/** Addresses are authoritative: optional allocation display symbols cannot impersonate a covered asset. */
export function modelSymbol(address: string, chainId: number): string | null {
  if (chainId === 97) {
    const symbol = testnetAssets().find(asset => asset.address.toLowerCase() === address.toLowerCase())?.symbol.toUpperCase();
    return MODEL_ASSETS.find(asset => asset.symbol === symbol)?.symbol ?? null;
  }
  // #189 testnet-only constituents carry no mainnet address and never match outside chain 97.
  return MODEL_ASSETS.find(asset => asset.address !== undefined && asset.address.toLowerCase() === address.toLowerCase())?.symbol ?? null;
}
