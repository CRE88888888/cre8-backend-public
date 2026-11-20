import { query } from '../db.js';
import { configuredChainId } from '../testnet-profile.js';
import type { Allocation } from '../strategies.js';
import type { InfoQuery } from '../info/catalogue.js';
import { calculateModel, emptyModel, lastClosedDay } from './calculation.js';
import type { ClosePoint, ModelResult, ModelWeight } from './calculation.js';
import { MODEL_ASSETS, modelSymbol, closeSeries, checkedSeries } from './catalogue.js';

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

/** One DB history read per HTTP request; no live source requests, no stale version cache. */
export function createModelReader(deps: { query?: InfoQuery; now?: () => Date; chainId?: number } = {}) {
  return async (strategies: readonly ModelStrategy[]): Promise<Map<number, ModelResult>> => {
    const results = new Map(strategies.map(strategy => [strategy.id, emptyModel()]));
    try {
      const now = (deps.now ?? (() => new Date()))(), asOf = lastClosedDay(now);
      const weights = new Map(strategies.map(strategy => [strategy.id, currentWeights(strategy, deps.chainId ?? configuredChainId(), now)]));
      const symbols = [...new Set([...weights.values()].flatMap(value => value?.map(w => w.symbol) ?? []))];
      if (!symbols.length) return results;
      for (const [id, allocation] of weights) if (allocation) results.set(id, { ...emptyModel(), modelComponents: allocation.map(w => ({ symbol: w.symbol, includedFrom: null })) });
      // Reading the catalogue together preserves a common, retained origin even for an all-new fund.
      const series = MODEL_ASSETS.flatMap(asset => asset.source.kind === 'yahoo' && asset.source.fallback
        ? [closeSeries(asset), closeSeries(asset, true)] : [closeSeries(asset)]);
      const rows = (await (deps.query ?? query)(`select series,source,observed_on::text as date,value::text as value
        from market_snapshots where series=any($1::text[]) and observed_on<=$2::date
        order by series,observed_on`, [[...series, ...series.map(checkedSeries)], asOf])).rows;
      const stored = new Map<string, ClosePoint[]>(), checked = new Set<string>();
      for (const row of rows) {
        if (typeof row.series !== 'string' || typeof row.date !== 'string' || typeof row.value !== 'string') throw new Error('invalid_close');
        const expectedSource = row.series.includes('@yahoo') ? 'yahoo' : 'binance';
        if (row.source !== expectedSource) throw new Error('invalid_close_source');
        if (row.series.endsWith(':checked')) {
          if (row.date === asOf && row.value === '1') checked.add(row.series);
          continue;
        }
        const points = stored.get(row.series) ?? [];
        points.push({ date: row.date, value: row.value }); stored.set(row.series, points);
      }
      const history = new Map<string, ClosePoint[]>();
      const available = new Set<string>();
      for (const asset of MODEL_ASSETS) {
        let key = closeSeries(asset);
        if (!checked.has(checkedSeries(key)) && asset.source.kind === 'yahoo' && asset.source.fallback && checked.has(checkedSeries(closeSeries(asset, true)))) key = closeSeries(asset, true);
        history.set(asset.symbol, stored.get(key) ?? []);
        if (checked.has(checkedSeries(key))) available.add(asset.symbol);
      }
      for (const [id, allocation] of weights) {
        if (allocation) {
          try {
            const model = calculateModel(allocation, history, asOf);
            const modelComponents = model.modelComponents.length ? model.modelComponents : allocation.map(w => ({ symbol: w.symbol, includedFrom: null }));
            results.set(id, allocation.every(w => available.has(w.symbol)) ? { ...model, modelComponents }
              : { modelReturns: null, modelNav: [], modelComponents });
          }
          catch { /* Preserve known constituent identities when their data is unavailable. */ }
        }
      }
    } catch { /* Model storage failure leaves the existing strategy API available. */ }
    return results;
  };
}
