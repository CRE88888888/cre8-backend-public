/** Reproducible read-only acceptance: real Yahoo/Binance public GETs, no DB/chain/keys. */
import { readFile } from 'node:fs/promises';
import { createCloseJob } from '../src/model-returns/collector.js';
import { calculateModel, lastClosedDay } from '../src/model-returns/calculation.js';
import type { ClosePoint, ModelWeight } from '../src/model-returns/calculation.js';
import { MODEL_ASSETS, closeSeries } from '../src/model-returns/catalogue.js';
import { json, list, object } from '../src/info/source.js';
import { InfoSourceError } from '../src/info/types.js';

try {
  const filename = process.argv[2];
  if (!filename) throw new Error('lineup_path_required');
  const lineup = object(json(await readFile(filename, 'utf8')));
  const funds = list(lineup.funds);
  if (funds.length !== 21) throw new Error('expected_21_funds');
  const now = new Date(), asOf = lastClosedDay(now), history = new Map<string, ClosePoint[]>();
  const sources = new Map<string, string>();
  const results = await createCloseJob({ env: { MODEL_RETURNS_ENABLED: '1' }, now: () => now,
    lock: action => action(), log: () => {}, save: async batch => {
      for (const asset of MODEL_ASSETS) {
        const points = batch.markets.filter(m => m.series === closeSeries(asset) ||
          (asset.source.kind === 'yahoo' && asset.source.fallback && m.series === closeSeries(asset, true)));
        if (points.length) {
          history.set(asset.symbol, points.map(m => ({ date: m.observedOn, value: m.value })));
          sources.set(asset.symbol, points[0]?.series ?? '');
        }
      }
      return { events: 0, markets: batch.markets.length };
    } })();
  const report = { queriedAt: now.toISOString(), asOf,
    assets: MODEL_ASSETS.map(asset => ({ symbol: asset.symbol, source: sources.get(asset.symbol) ?? closeSeries(asset), first: history.get(asset.symbol)?.[0]?.date ?? null,
      last: history.get(asset.symbol)?.at(-1)?.date ?? null, closes: history.get(asset.symbol)?.length ?? 0,
      error: results.find(result => result.collector === `close:${asset.symbol}`)?.error ?? null })),
    funds: funds.map(raw => {
      const fund = object(raw);
      const weights: ModelWeight[] = list(fund.components).map(raw => {
        const part = object(raw);
        if (typeof part.asset_id !== 'string' || typeof part.weight_bps !== 'number') throw new Error('invalid_lineup');
        return { symbol: part.asset_id.toUpperCase(), weightBps: part.weight_bps };
      });
      const unavailable = weights.some(w => results.find(r => r.collector === `close:${w.symbol}`)?.error !== null);
      const model = unavailable ? { modelReturns: null, modelComponents: weights.map(w => ({ symbol: w.symbol, includedFrom: null })) }
        : calculateModel(weights, history, asOf);
      return { id: fund.id, ...model.modelReturns, modelComponents: model.modelComponents };
    }) };
  console.log(JSON.stringify(report, null, 2));
  // Explicitly unlisted bStocks are a checked absence; every actual source failure fails acceptance.
  if (results.length !== MODEL_ASSETS.length || results.some(result => result.error !== null)) process.exitCode = 1;
} catch (error) {
  // Source failures carry fixed InfoSourceError codes; upstream bodies are never included.
  const code = error instanceof InfoSourceError ? error.code : error instanceof Error ? error.message : 'unknown';
  console.error(`[model_returns_check] verification failed: ${code}`);
  process.exitCode = 1;
}
