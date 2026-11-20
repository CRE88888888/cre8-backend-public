import { setTimeout as delay } from 'node:timers/promises';
import { createInfoGet, json, list, object } from '../info/source.js';
import { InfoSourceError } from '../info/types.js';
import type { InfoGet } from '../info/types.js';
import { DAY_MS, price } from './calculation.js';
import type { ClosePoint } from './calculation.js';

export function yahooUrl(ticker: string): string {
  if (!/^[A-Z0-9.^=-]{1,24}$/.test(ticker)) throw new InfoSourceError('invalid_ticker');
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=2y&interval=1d`;
}
function numberPrice(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1e21) throw new InfoSourceError('invalid_close');
  const result = value.toFixed(18).replace(/\.?0+$/, '');
  try { price(result); } catch { throw new InfoSourceError('invalid_close'); }
  return result;
}
/** Exchange dates, not UTC timestamps: Korean equities and US shares close in different time zones. */
export function parseYahoo(raw: string, ticker: string, currency: string, asOf: string): ClosePoint[] {
  const chart = object(object(json(raw)).chart);
  if (chart.error !== null && chart.error !== undefined) throw new InfoSourceError('yahoo_unavailable');
  const results = list(chart.result);
  if (results.length !== 1) throw new InfoSourceError('invalid_chart');
  const result = object(results[0]), meta = object(result.meta);
  if (meta.symbol !== ticker || meta.currency !== currency || typeof meta.exchangeTimezoneName !== 'string') throw new InfoSourceError('invalid_chart_identity');
  let dates: Intl.DateTimeFormat;
  try { dates = new Intl.DateTimeFormat('en-CA', { timeZone: meta.exchangeTimezoneName, year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch { throw new InfoSourceError('invalid_chart_timezone'); }
  const timestamps = list(result.timestamp ?? []), indicators = object(result.indicators);
  const quotes = list(indicators.quote), adjusted = indicators.adjclose == null ? [] : list(indicators.adjclose);
  const closes = list(object(quotes[0]).close);
  const rawAdjusted = adjusted.length ? object(adjusted[0]).adjclose : null;
  const adj = rawAdjusted == null ? null : list(rawAdjusted);
  if (timestamps.length > 800 || closes.length !== timestamps.length || (adj && adj.length !== timestamps.length)) throw new InfoSourceError('invalid_chart');
  let previous = -1, previousDate = '';
  const points: ClosePoint[] = [];
  for (const [index, at] of timestamps.entries()) {
    if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= previous || at < 0 || at > 8_640_000_000_000) throw new InfoSourceError('invalid_chart');
    const date = dates.format(new Date(at * 1000));
    if (date <= previousDate) throw new InfoSourceError('invalid_chart');
    previous = at; previousDate = date;
    if (date > asOf) continue;
    // Yahoo includes dated null placeholders (notably FX holidays). They are not zero-price trades.
    if (closes[index] === null && (adj === null || adj[index] === null)) continue;
    // Missing adjclose alone can use close; invalid/non-positive adjusted prices cannot quietly fall back.
    points.push({ date, value: numberPrice(adj?.[index] ?? closes[index]) });
  }
  return points;
}

/** KRW=X is KRW per USD. Never use a later FX observation to value an earlier Korean close. */
export function inDollars(points: readonly ClosePoint[], fx: readonly ClosePoint[]): ClosePoint[] {
  let index = 0, latest: ClosePoint | undefined;
  const scale = 10n ** 36n;
  return points.map(point => {
    for (let next = fx[index]; next && next.date <= point.date; next = fx[index]) { latest = next; index++; }
    if (!latest) throw new InfoSourceError('missing_fx');
    const units = price(point.value) * scale / price(latest.value);
    const digits = units.toString().padStart(37, '0');
    const value = `${digits.slice(0, -36)}.${digits.slice(-36)}`;
    try { price(value); } catch { throw new InfoSourceError('invalid_close'); }
    return { date: point.date, value };
  });
}

/** Normal public GETs only. Serial Yahoo requests are spaced by a second; at most two bounded 429 retries. */
export function createMarketGet(deps: { send?: (url: string, init: RequestInit) => Promise<Response>; clock?: () => number;
  pause?: (ms: number, signal: AbortSignal) => Promise<void>; timeoutMs?: number } = {}): InfoGet {
  const clock = deps.clock ?? Date.now;
  const pause = deps.pause ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
  let lastYahoo: number | null = null;
  return (raw, headers) => createInfoGet(async (url, init) => {
    if (new URL(url).hostname !== 'query1.finance.yahoo.com') return (deps.send ?? fetch)(url, init);
    const signal = init.signal;
    if (!signal) throw new InfoSourceError('timeout');
    for (let attempt = 0; ; attempt++) {
      if (lastYahoo !== null) await pause(Math.max(0, 1000 - (clock() - lastYahoo)), signal);
      lastYahoo = clock();
      const response = await (deps.send ?? fetch)(url, { ...init, headers: { ...init.headers, 'user-agent': 'Mozilla/5.0 (compatible; CRE8 model research)' } });
      if (response.status !== 429 || attempt === 2) return response;
      const rawRetry = response.headers.get('retry-after');
      const wait = rawRetry === null ? 1000 * 2 ** attempt : /^\d+$/.test(rawRetry) ? Number(rawRetry) * 1000 : Date.parse(rawRetry) - clock();
      // Long Retry-After is left to the next daily round, never retried early or bypassed via another host.
      if (!Number.isFinite(wait) || wait > 5000) return response;
      await response.body?.cancel();
      await pause(Math.max(0, wait), signal);
    }
  }, deps.timeoutMs ?? 15_000, 60_000, clock, ['query1.finance.yahoo.com', 'data-api.binance.vision'])(raw, headers);
}

export function backfillStart(now: Date): string {
  const start = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS);
  start.setUTCFullYear(start.getUTCFullYear() - 2);
  return start.toISOString().slice(0, 10);
}
