import { day } from '../info/source.js';

export const DAY_MS = 86_400_000;
export const MAX_NAV_POINTS = 731; // Two calendar years can include a leap day; inclusive endpoints.
const SCALE = 10n ** 36n;
export type ClosePoint = { date: string; value: string };
export type ModelWeight = { symbol: string; weightBps: number };
export type ModelReturns = { asOf: string; d7: string | null; d30: string | null; d90: string | null; y1: string | null; all: string | null;
  annualized: string | null };
/** Minimum modelNav head-to-tail span for `annualized`; pending a user decision (30 or 90). Change only here. */
export const MODEL_ANNUALIZED_MIN_DAYS = 30;
export type ModelResult = { modelReturns: ModelReturns | null; modelNav: ClosePoint[] };
export const emptyModel = (): ModelResult => ({ modelReturns: null, modelNav: [] });

/** Bounded exact decimal input. Zero/negative prices are missing data, never a flat return. */
export function price(raw: unknown): bigint {
  if (typeof raw !== 'string' || raw.length > 100 || !/^\d+(?:\.\d{1,36})?$/.test(raw)) throw new Error('invalid_close');
  const [whole = '', fraction = ''] = raw.split('.');
  const value = BigInt(whole) * SCALE + BigInt(fraction.padEnd(36, '0'));
  if (value <= 0n) throw new Error('invalid_close');
  return value;
}
function rounded(numerator: bigint, denominator: bigint): bigint {
  const sign = numerator < 0n ? -1n : 1n;
  return sign * ((sign * numerator + denominator / 2n) / denominator);
}
function format(raw: bigint, decimals: number): string {
  const units = rounded(raw, 10n ** BigInt(36 - decimals));
  const absolute = (units < 0n ? -units : units).toString().padStart(decimals + 1, '0');
  return `${units < 0n ? '-' : ''}${absolute.slice(0, -decimals)}.${absolute.slice(-decimals)}`;
}
/**
 * Same inputs and formula as the App: first and last modelNav points (the 12-decimal strings the API returns),
 * compounded over the actual calendar-day span: ((last/first)^(365/days) - 1) * 100. A span under MODEL_ANNUALIZED_MIN_DAYS is null.
 * Floating point is unavoidable for the fractional power; a result toFixed cannot print plainly is null.
 */
export function annualizedReturn(nav: readonly ClosePoint[]): string | null {
  const first = nav[0], last = nav.at(-1);
  if (!first || !last) return null;
  const days = (Date.parse(last.date) - Date.parse(first.date)) / DAY_MS;
  const start = Number(first.value), end = Number(last.value);
  if (!(days >= MODEL_ANNUALIZED_MIN_DAYS) || !(start > 0) || !(end > 0)) return null;
  const percent = ((end / start) ** (365 / days) - 1) * 100;
  if (!Number.isFinite(percent) || Math.abs(percent) >= 1e21) return null;
  const fixed = percent.toFixed(8);
  return /^-0\.0+$/.test(fixed) ? fixed.slice(1) : fixed;
}
export function lastClosedDay(now = new Date()): string {
  return new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS - DAY_MS).toISOString().slice(0, 10);
}

/** Independent windows: an old gap invalidates ALL, but never invalidates a complete recent 7D. */
export function calculateModel(weights: readonly ModelWeight[], history: ReadonlyMap<string, readonly ClosePoint[]>, asOf: string): ModelResult {
  day(asOf);
  if (!weights.length || weights.some(w => !Number.isInteger(w.weightBps) || w.weightBps <= 0 || w.weightBps > 10_000) ||
      weights.reduce((sum, w) => sum + w.weightBps, 0) !== 10_000 || new Set(weights.map(w => w.symbol)).size !== weights.length) return emptyModel();
  const series: { weight: bigint; points: Map<string, bigint>; first: string }[] = [];
  for (const weight of weights) {
    const points = new Map<string, bigint>();
    for (const point of history.get(weight.symbol) ?? []) {
      if (point.date > asOf) continue;
      try {
        day(point.date);
        if (points.has(point.date)) return emptyModel();
        points.set(point.date, price(point.value));
      } catch { return emptyModel(); }
    }
    const first = [...points.keys()].sort()[0];
    if (!first || !points.has(asOf)) return emptyModel();
    series.push({ weight: BigInt(weight.weightBps), points, first });
  }
  const first = series.reduce((latest, s) => s.first > latest ? s.first : latest, '1970-01-01');
  if (first >= asOf) return emptyModel();
  const end = Date.parse(asOf);
  const nav = (start: string): { date: string; value: bigint }[] | null => {
    if (start < first) return null;
    let previous: bigint[] | null = null, value = SCALE;
    const result: { date: string; value: bigint }[] = [];
    for (let at = Date.parse(start); at <= end; at += DAY_MS) {
      const date = new Date(at).toISOString().slice(0, 10);
      const prices = series.map(s => s.points.get(date));
      if (prices.some(p => p === undefined)) return null;
      const current: bigint[] = [];
      let factor = 0n;
      for (const [index, s] of series.entries()) {
        const close = prices[index], before = previous?.[index];
        if (close === undefined) return null;
        current.push(close);
        if (before !== undefined) factor += rounded(close * s.weight * SCALE, before);
      }
      if (previous) value = rounded(value * factor, 10_000n * SCALE);
      if (value <= 0n) return null;
      result.push({ date, value }); previous = current;
    }
    return result;
  };
  const returns = (points: ReturnType<typeof nav>): string | null => {
    const last = points?.at(-1);
    return last ? format((last.value - SCALE) * 100n, 8) : null;
  };
  const all = nav(first);
  const period = (days: number) => returns(nav(new Date(end - days * DAY_MS).toISOString().slice(0, 10)));
  const cutoff = new Date(asOf);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 2);
  // Feb 29 normalizes to Mar 1 in a non-leap start year, keeping the range within two years.
  const modelNav = (all ?? []).filter(p => p.date >= cutoff.toISOString().slice(0, 10)).slice(-MAX_NAV_POINTS)
    .map(p => ({ date: p.date, value: format(p.value, 12) }));
  return { modelReturns: { asOf, d7: period(7), d30: period(30), d90: period(90), y1: period(365), all: returns(all),
    annualized: annualizedReturn(modelNav) }, modelNav };
}
