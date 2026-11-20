import { ConfigurationError } from '../config.js';
import { createInfoGet, json, list, object, text } from '../info/source.js';
import { runInfoCollectors, withInfoJobLock } from '../info/job.js';
import type { InfoCollectorResult } from '../info/job.js';
import type { InfoBatch, InfoGet } from '../info/types.js';
import { InfoSourceError } from '../info/types.js';
import { MODEL_ASSETS } from './catalogue.js';
import { DAY_MS, lastClosedDay, price } from './calculation.js';

export function klineUrl(pair: string, start: number, end: number): string {
  if (!/^[A-Z0-9]{2,24}USDT$/.test(pair)) throw new InfoSourceError('invalid_pair');
  return `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d&timeZone=0&startTime=${start}&endTime=${end}&limit=1000`;
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
  let start = 0;
  // Full backfill on each daily round repairs old gaps/corrections and preserves true ALL history.
  for (let page = 0; page < 100; page++) {
    const url = klineUrl(asset.pair, start, end);
    const points = parseKlines(await get(url), start, end);
    markets.push(...points.map(point => ({ series: `close:${asset.symbol}` as const, observedOn: point.date,
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
const getBinance = () => createInfoGet(fetch, 15_000, 60_000, Date.now, ['api.binance.com']);
export function createCloseJob(deps: { env?: NodeJS.ProcessEnv; now?: () => Date; get?: () => InfoGet;
  assets?: readonly { symbol: string; pair: string }[]; save?: (batch: InfoBatch) => Promise<{ events: number; markets: number }>;
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
        nextRun = now.getTime() + DAY_MS;
        // Unfiltered exchangeInfo is ~18 MB (over MAX_SOURCE_BYTES); the all-symbol price list is ~160 KB and
        // also lists pairs in BREAK status (SNDKBUSDT on 2026-11-20); klines alone decide which closes exist.
        const pairs = new Set(list(json(await (deps.get ?? getBinance)()('https://api.binance.com/api/v3/ticker/price')))
          .map(value => text(object(value).symbol)));
        results = await runInfoCollectors((deps.assets ?? MODEL_ASSETS).map(asset => ({ name: `close:${asset.symbol}`, collect: async () => {
          if (!pairs.has(asset.pair)) throw new InfoSourceError('pair_not_found');
          return collectCloses(asset, (deps.get ?? getBinance)(), now);
        } })), deps.save, deps.log);
      });
      return results;
    } finally { busy = false; }
  };
}
