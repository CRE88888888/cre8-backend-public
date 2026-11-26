import { day } from '../info/source.js';

export const DAY_MS = 86_400_000;
export const MAX_NAV_POINTS = 731; // Two calendar years can include a leap day; inclusive endpoints.
const SCALE = 10n ** 36n;
export type ClosePoint = { date: string; value: string };
export type ModelWeight = { symbol: string; weightBps: number };
export type ModelReturns = { asOf: string; d7: string | null; d30: string | null; d90: string | null; y1: string | null; all: string | null;
  annualized: string | null };
/** Minimum modelNav head-to-tail span for `annualized`; retained at 30 calendar days by #176. */
export const MODEL_ANNUALIZED_MIN_DAYS = 30;
export type ModelComponent = { symbol: string; includedFrom: string | null };
export type ModelResult = { modelReturns: ModelReturns | null; modelNav: ClosePoint[]; modelComponents: ModelComponent[] };
export const emptyModel = (): ModelResult => ({ modelReturns: null, modelNav: [], modelComponents: [] });

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

/**
 * Origin is the earliest retained backfill date across the catalogue, never the moving display cutoff.
 * Available components share their original target weights proportionally. An admission rebalances at that
 * day's close; only the next day's return includes the newcomer (no pre-admission price jump).
 */
export function calculateModel(weights: readonly ModelWeight[], history: ReadonlyMap<string, readonly ClosePoint[]>, asOf: string): ModelResult {
  day(asOf);
  if (!weights.length || weights.some(w => !Number.isInteger(w.weightBps) || w.weightBps <= 0 || w.weightBps > 10_000) ||
      weights.reduce((sum, w) => sum + w.weightBps, 0) !== 10_000 || new Set(weights.map(w => w.symbol)).size !== weights.length) return emptyModel();
  const origin = [...history.values()].flatMap(points => points.filter(p => p.date <= asOf).map(p => p.date)).sort()[0];
  const series: { symbol: string; weight: bigint; points: Map<string, bigint>; includedFrom: string | null }[] = [];
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
    const needsSeasoning = weight.symbol === 'ANTB' || weight.symbol === 'SPCXB' || (first !== undefined && origin !== undefined && first > origin);
    const eligible = first ? new Date(Date.parse(first) + (needsSeasoning ? 30 : 0) * DAY_MS).toISOString().slice(0, 10) : null;
    series.push({ symbol: weight.symbol, weight: BigInt(weight.weightBps), points, includedFrom: eligible && eligible <= asOf ? eligible : null });
  }
  const modelComponents = series.map(s => ({ symbol: s.symbol, includedFrom: s.includedFrom }));
  const first = series.flatMap(s => s.includedFrom ? [s.includedFrom] : []).sort()[0];
  if (!first) return { ...emptyModel(), modelComponents };
  const end = Date.parse(asOf);
  let value = SCALE;
  const previous = new Map<string, bigint>();
  let active: typeof series = [];
  const all: { date: string; value: bigint }[] = [];
  // Read prices before the first admission as well, so an IPO admitted on a holiday uses its last actual close.
  const start = [...series.flatMap(s => [...s.points.keys()])].sort()[0];
  if (!start) return { ...emptyModel(), modelComponents };
  for (let at = Date.parse(start); at <= end; at += DAY_MS) {
    const date = new Date(at).toISOString().slice(0, 10);
    const current = new Map(previous);
    for (const s of series) {
      const close = s.points.get(date);
      if (close !== undefined) current.set(s.symbol, close);
    }
    if (active.length) {
      let factor = 0n, total = 0n;
      for (const s of active) {
        const close = current.get(s.symbol), before = previous.get(s.symbol);
        if (close === undefined || before === undefined) return { ...emptyModel(), modelComponents };
        factor += rounded(close * s.weight * SCALE, before); total += s.weight;
      }
      value = rounded(value * factor, total * SCALE);
      if (value <= 0n) return { ...emptyModel(), modelComponents };
    }
    active = series.filter(s => s.includedFrom !== null && s.includedFrom <= date);
    if (active.length) all.push({ date, value });
    previous.clear(); for (const [symbol, close] of current) previous.set(symbol, close);
  }
  const returns = (startDate: string): string | null => {
    const head = all.find(point => point.date === startDate), tail = all.at(-1);
    return head && tail ? format(rounded((tail.value - head.value) * SCALE * 100n, head.value), 8) : null;
  };
  const period = (days: number) => returns(new Date(end - days * DAY_MS).toISOString().slice(0, 10));
  const cutoff = new Date(asOf); cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 2);
  const modelNav = all.filter(p => p.date >= cutoff.toISOString().slice(0, 10)).slice(-MAX_NAV_POINTS)
    .map(p => ({ date: p.date, value: format(p.value, 12) }));
  return { modelReturns: { asOf, d7: period(7), d30: period(30), d90: period(90), y1: period(365), all: returns(first),
    annualized: annualizedReturn(modelNav) }, modelNav, modelComponents };
}
