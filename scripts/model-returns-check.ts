/** Reproducible read-only acceptance: real Binance public GETs, no DB/chain/keys. */
import { readFile } from 'node:fs/promises';
import { createCloseJob } from '../src/model-returns/collector.js';
import { calculateModel, lastClosedDay } from '../src/model-returns/calculation.js';
import type { ClosePoint, ModelWeight } from '../src/model-returns/calculation.js';
import { MODEL_ASSETS } from '../src/model-returns/catalogue.js';
import { json, list, object } from '../src/info/source.js';
import { InfoSourceError } from '../src/info/types.js';

try {
  const filename = process.argv[2];
  if (!filename) throw new Error('lineup_path_required');
  const lineup = object(json(await readFile(filename, 'utf8')));
  const funds = list(lineup.funds);
  if (funds.length !== 21) throw new Error('expected_21_funds');
  const now = new Date(), asOf = lastClosedDay(now), history = new Map<string, ClosePoint[]>();
  const results = await createCloseJob({ env: { MODEL_RETURNS_ENABLED: '1' }, now: () => now,
    lock: action => action(), log: () => {}, save: async batch => {
      for (const market of batch.markets) {
        const symbol = market.series.slice('close:'.length), points = history.get(symbol) ?? [];
        points.push({ date: market.observedOn, value: market.value }); history.set(symbol, points);
      }
      return { events: 0, markets: batch.markets.length };
    } })();
  const report = { queriedAt: now.toISOString(), asOf,
    assets: MODEL_ASSETS.map(asset => ({ symbol: asset.symbol, pair: asset.pair, first: history.get(asset.symbol)?.[0]?.date ?? null,
      last: history.get(asset.symbol)?.at(-1)?.date ?? null, closes: history.get(asset.symbol)?.length ?? 0,
      error: results.find(result => result.collector === `close:${asset.symbol}`)?.error ?? null })),
    funds: funds.map(raw => {
      const fund = object(raw);
      const weights: ModelWeight[] = list(fund.components).map(raw => {
        const part = object(raw);
        if (typeof part.asset_id !== 'string' || typeof part.weight_bps !== 'number') throw new Error('invalid_lineup');
        return { symbol: part.asset_id.toUpperCase(), weightBps: part.weight_bps };
      });
      return { id: fund.id, ...calculateModel(weights, history, asOf).modelReturns };
    }) };
  console.log(JSON.stringify(report, null, 2));
  // A pair Binance does not list is an expected null (#173); any other source failure fails the check.
  if (results.length !== MODEL_ASSETS.length || results.some(result => result.error !== null && result.error !== 'pair_not_found')) process.exitCode = 1;
} catch (error) {
  // Source failures carry fixed InfoSourceError codes; upstream bodies are never included.
  const code = error instanceof InfoSourceError ? error.code : error instanceof Error ? error.message : 'unknown';
  console.error(`[model_returns_check] verification failed: ${code}`);
  process.exitCode = 1;
}
