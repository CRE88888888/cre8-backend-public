import { query } from '../db.js';
import { configuredChainId } from '../testnet-profile.js';
import type { Allocation } from '../strategies.js';
import type { InfoQuery } from '../info/catalogue.js';
import { calculateModel, emptyModel, lastClosedDay } from './calculation.js';
import type { ClosePoint, ModelResult, ModelWeight } from './calculation.js';
import { modelSymbol } from './catalogue.js';

export type ModelStrategy = { id: number; onchainId: number | null; versions: {
  version: number; allocation: Allocation; activeAt: string | null; status?: string;
}[] };
/**
 * List authority (C3, #174): DB versions only, effective by active_at, so GET /strategies makes no chain reads.
 * Trade-off: a version cancelled directly on chain stays in the list model until the DB reflects it; detail keeps chain state.
 */
export function dbModelStrategy(strategy: { id: number; versions: ModelStrategy['versions'] }): ModelStrategy {
  return { id: strategy.id, onchainId: null, versions: strategy.versions };
}
export function currentWeights(strategy: ModelStrategy, chainId: number, now: Date): ModelWeight[] | null {
  const current = strategy.versions.filter(v => strategy.onchainId === null
    ? v.activeAt !== null && Date.parse(v.activeAt) <= now.getTime() : v.status === 'active')
    .sort((a, b) => b.version - a.version)[0];
  if (!current) return null;
  const weights: ModelWeight[] = [];
  for (const asset of current.allocation.assets) {
    if (asset.weightBps === 0) continue;
    const symbol = modelSymbol(asset.address, chainId);
    if (!symbol) return null;
    weights.push({ symbol, weightBps: asset.weightBps });
  }
  return weights;
}

/** One DB history read per HTTP request; no live Binance requests, no stale version cache. */
export function createModelReader(deps: { query?: InfoQuery; now?: () => Date; chainId?: number } = {}) {
  return async (strategies: readonly ModelStrategy[]): Promise<Map<number, ModelResult>> => {
    const results = new Map(strategies.map(strategy => [strategy.id, emptyModel()]));
    try {
      const now = (deps.now ?? (() => new Date()))(), asOf = lastClosedDay(now);
      const weights = new Map(strategies.map(strategy => [strategy.id, currentWeights(strategy, deps.chainId ?? configuredChainId(), now)]));
      const symbols = [...new Set([...weights.values()].flatMap(value => value?.map(w => w.symbol) ?? []))];
      if (!symbols.length) return results;
      const rows = (await (deps.query ?? query)(`select series,observed_on::text as date,value::text as value
        from market_snapshots where series=any($1::text[]) and source='binance' and observed_on<=$2::date
        order by series,observed_on`, [symbols.map(symbol => `close:${symbol}`), asOf])).rows;
      const history = new Map<string, ClosePoint[]>();
      for (const row of rows) {
        if (typeof row.series !== 'string' || typeof row.date !== 'string' || typeof row.value !== 'string') throw new Error('invalid_close');
        const symbol = row.series.slice('close:'.length);
        const points = history.get(symbol) ?? [];
        points.push({ date: row.date, value: row.value }); history.set(symbol, points);
      }
      for (const [id, allocation] of weights) {
        if (allocation) {
          try { results.set(id, calculateModel(allocation, history, asOf)); }
          catch { results.set(id, emptyModel()); }
        }
      }
    } catch { /* Model storage failure leaves the existing strategy API available. */ }
    return results;
  };
}
