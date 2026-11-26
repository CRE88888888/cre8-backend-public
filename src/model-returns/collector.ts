import { ConfigurationError } from '../config.js';
import { json, list, object, text } from '../info/source.js';
import { runInfoCollectors, withInfoJobLock } from '../info/job.js';
import type { InfoCollectorResult } from '../info/job.js';
import type { InfoBatch, InfoGet } from '../info/types.js';
import { InfoSourceError } from '../info/types.js';
import { MODEL_ASSETS, closeSeries, checkedSeries } from './catalogue.js';
import type { ModelAsset } from './catalogue.js';
import { DAY_MS, lastClosedDay, price } from './calculation.js';
import { backfillStart, createMarketGet, inDollars, parseYahoo, yahooUrl } from './yahoo.js';

export function klineUrl(pair: string, start: number, end: number): string {
  if (!/^[A-Z0-9]{2,24}USDT$/.test(pair)) throw new InfoSourceError('invalid_pair');
  return `https://data-api.binance.vision/api/v3/klines?symbol=${pair}&interval=1d&timeZone=0&startTime=${start}&endTime=${end}&limit=1000`;
}
/** A 1d candle must close inside its own UTC day. Binance halts (live BTCUSDT/BNBUSDT 2018-02-08) end a candle early;
 * its close is still that day's last traded price. Candles past `end` (today, in progress) are rejected. */
export function parseKlines(raw: string, start: number, end: number): { date: string; value: string; open: number }[] {
  const rows = list(json(raw));
  if (rows.length > 1000) throw new InfoSourceError('invalid_klines');
  let previous = start - 1;
  return rows.map(value => {
    const row = list(value), open: unknown = row[0], close: unknown = row[6], amount: unknown = row[4];
    if (row.length !== 12 || typeof open !== 'number' || !Number.isSafeInteger(open) || open < start || open <= previous ||
        open % DAY_MS !== 0 || typeof close !== 'number' || !Number.isSafeInteger(close) || close < open || close > open + DAY_MS - 1 ||
        close > end || typeof amount !== 'string') {
      throw new InfoSourceError('invalid_klines');
    }
    try { price(amount); } catch { throw new InfoSourceError('invalid_close'); }
    previous = open;
    return { date: new Date(open).toISOString().slice(0, 10), value: amount, open };
  });
}
export async function collectCloses(asset: { symbol: string; pair: string }, get: InfoGet, now = new Date()): Promise<InfoBatch> {
  const end = Date.parse(lastClosedDay(now)) + DAY_MS - 1;
  const markets: InfoBatch['markets'] = [];
  let start = Date.parse(backfillStart(now));
  // Refresh two years each day; retained older snapshots preserve the original admission dates.
  for (let page = 0; page < 100; page++) {
    const url = klineUrl(asset.pair, start, end);
    const points = parseKlines(await get(url), start, end);
    markets.push(...points.map(point => ({ series: closeSeries(asset), observedOn: point.date,
      value: point.value, source: 'binance', sourceUrl: url })));
    if (points.length < 1000) return { events: [], markets };
    const last = points.at(-1);
    if (!last) throw new InfoSourceError('invalid_klines');
    start = last.open + DAY_MS;
    if (start > end) return { events: [], markets };
  }
  throw new InfoSourceError('history_limit');
}
export function loadCloseConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.MODEL_RETURNS_ENABLED?.trim() || '0';
  if (flag !== '0' && flag !== '1') throw new ConfigurationError('MODEL_RETURNS_ENABLED must be 0 or 1');
  return flag === '1';
}
// Binance's main REST host returns HTTP 451 from US data centres (Railway US West, verified 2026-11-20);
// data-api.binance.vision is Binance's public market-data-only host and serves the same klines/ticker endpoints.
export function createCloseJob(deps: { env?: NodeJS.ProcessEnv; now?: () => Date; get?: () => InfoGet;
  assets?: readonly ModelAsset[]; save?: (batch: InfoBatch) => Promise<{ events: number; markets: number }>;
  lock?: (action: () => Promise<void>) => Promise<void>; log?: (result: InfoCollectorResult) => void } = {}) {
  let busy = false, nextRun = 0;
  return async (): Promise<InfoCollectorResult[]> => {
    const now = (deps.now ?? (() => new Date()))();
    if (!loadCloseConfig(deps.env) || busy || now.getTime() < nextRun) return [];
    busy = true;
    // A contended/unavailable lock retries next minute; only an admitted round consumes the daily slot.
    nextRun = now.getTime() + 60_000;
    try {
      let results: InfoCollectorResult[] = [];
      await (deps.lock ?? withInfoJobLock)(async () => {
        // The reader only accepts a `:checked` marker for lastClosedDay(now), so the next round must run as soon as
        // the UTC day rolls over, not 24 hours after process start (which left funds without models most of the day).
        nextRun = Date.parse(lastClosedDay(now)) + 2 * DAY_MS;
        const get = (deps.get ?? createMarketGet)();
        let pairs: Promise<Set<string>> | undefined;
        const yahoo = new Map<string, Promise<string>>();
        const yahooGet = (ticker: string) => {
          const url = yahooUrl(ticker);
          let pending = yahoo.get(url);
          if (!pending) { pending = get(url); yahoo.set(url, pending); }
          return pending;
        };
        results = await runInfoCollectors((deps.assets ?? MODEL_ASSETS).map(asset => ({ name: `close:${asset.symbol}`, collect: async () => {
          let series = closeSeries(asset), batch: InfoBatch;
          const source = asset.source;
          if (source?.kind === 'yahoo') {
            const collect = async (ticker: string): Promise<InfoBatch> => {
              let points = parseYahoo(await yahooGet(ticker), ticker, source.currency, lastClosedDay(now));
              if (!points.length) throw new InfoSourceError('missing_history');
              if (source.fx) points = inDollars(points, parseYahoo(await yahooGet(source.fx), source.fx, source.currency, lastClosedDay(now)));
              return { events: [], markets: points.map(p => ({ series, observedOn: p.date, value: p.value, source: 'yahoo', sourceUrl: yahooUrl(ticker) })) };
            };
            try { batch = await collect(source.ticker); }
            catch (error) {
              if (!source.fallback) throw error;
              series = closeSeries(asset, true); batch = await collect(source.fallback);
            }
          } else {
            // The lightweight price list includes halted pairs; klines alone decide which closes exist.
            pairs ??= get('https://data-api.binance.vision/api/v3/ticker/price').then(raw => new Set(list(json(raw)).map(value => text(object(value).symbol))));
            if (!(await pairs).has(asset.pair)) {
              if (source?.kind !== 'binance' || !source.seasoned) throw new InfoSourceError('pair_not_found');
              batch = { events: [], markets: [] }; // An explicitly unlisted constituent is a known absence, not a source failure.
            } else batch = await collectCloses(asset, get, now);
          }
          // A successfully checked closed day is separate evidence from a carried holiday close.
          // Missing evidence on a failed round makes that fund unavailable, rather than inventing flat returns.
          batch.markets.push({ series: checkedSeries(series), observedOn: lastClosedDay(now), value: '1',
            source: source?.kind === 'yahoo' ? 'yahoo' : 'binance', sourceUrl: batch.markets[0]?.sourceUrl ?? klineUrl(asset.pair, Date.parse(backfillStart(now)), now.getTime()) });
          return batch;
        } })), deps.save, deps.log);
      });
      return results;
    } finally { busy = false; }
  };
}
