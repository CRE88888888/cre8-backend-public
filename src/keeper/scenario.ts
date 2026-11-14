import { TESTNET_ASSETS } from './assets.js';

export type Mode = 'rise' | 'fall' | 'sideways' | 'closed' | 'paused';
export type Segment = { steps: number; mode: Mode; stepBps: number };
export type Scenario = {
  version: 1;
  stepSeconds: number;
  maxStepBps: number;
  assets: Record<string, bigint>;
  timeline: Segment[];
  overrides: Record<string, Segment[]>;
};

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected object');
  return Object.fromEntries(Object.entries(value));
}

export function integer(value: unknown, low: number, high: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < low || value > high) throw new Error('integer out of range');
  return value;
}

export function positiveAmount(value: unknown): bigint {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,76}$/.test(value)) throw new Error('expected positive decimal amount');
  const amount = BigInt(value);
  if (amount >= 1n << 255n) throw new Error('amount out of range');
  return amount;
}

function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) throw new Error('unexpected or missing fields');
}

function segments(value: unknown, maximum: number): Segment[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new Error('invalid timeline');
  const result = value.map((item: unknown): Segment => {
    const s = record(item);
    keys(s, ['steps', 'mode', 'stepBps']);
    const mode = s.mode;
    if (mode !== 'rise' && mode !== 'fall' && mode !== 'sideways' && mode !== 'closed' && mode !== 'paused') throw new Error('invalid mode');
    const stepBps = integer(s.stepBps, 0, maximum);
    if ((mode === 'closed' || mode === 'paused') && stepBps !== 0) throw new Error('inactive segment must have zero movement');
    return { mode, stepBps, steps: integer(s.steps, 1, 10_080) };
  });
  if (result.reduce((sum, s) => sum + s.steps, 0) > 10_080) throw new Error('timeline too long');
  return result;
}

/** No coercion, extra fields, omitted assets or substituted starting prices. Prices are raw, without uiMultiplier. */
export function parseScenario(input: unknown): Scenario {
  const value = record(input);
  keys(value, ['version', 'stepSeconds', 'maxStepBps', 'assets', 'timeline', 'overrides']);
  if (value.version !== 1) throw new Error('unsupported scenario version');
  const stepSeconds = integer(value.stepSeconds, 60, 300);
  // At most 150 bps / 30 minutes, with headroom below the 200 bps secondary guard.
  const maxStepBps = integer(value.maxStepBps, 1, 5);
  const rawAssets = record(value.assets);
  keys(rawAssets, TESTNET_ASSETS.map((asset) => asset.symbol));
  const assets: Record<string, bigint> = {};
  for (const spec of TESTNET_ASSETS) {
    const price = positiveAmount(rawAssets[spec.symbol]);
    if (price !== BigInt(spec.priceE18)) throw new Error('baseline differs from TestnetAssets');
    assets[spec.symbol] = price;
  }
  const timeline = segments(value.timeline, maxStepBps);
  const overrides: Record<string, Segment[]> = {};
  for (const [symbol, items] of Object.entries(record(value.overrides))) {
    if (!Object.hasOwn(assets, symbol)) throw new Error('unknown override asset');
    overrides[symbol] = segments(items, maxStepBps);
  }
  return { version: 1, stepSeconds, maxStepBps, assets, timeline, overrides };
}

/** Chain time and an explicit start make restart/replay deterministic; a delayed round never catches up with a jump. */
export function targetAt(scenario: Scenario, symbol: string, start: bigint, timestamp: bigint): { price: bigint; mode: Mode } {
  const initial = scenario.assets[symbol];
  if (!Object.hasOwn(scenario.assets, symbol) || initial === undefined || start < 1n || timestamp < start) throw new Error('invalid replay time or asset');
  let price: bigint = initial;
  let remaining = (timestamp - start) / BigInt(scenario.stepSeconds);
  const timeline = scenario.overrides[symbol] ?? scenario.timeline;
  let mode: Mode = 'closed';
  for (const segment of timeline) {
    mode = segment.mode;
    const count = Number(remaining < BigInt(segment.steps) ? remaining : BigInt(segment.steps));
    const base = price;
    for (let i = 0; i < count; i += 1) {
      if (mode === 'rise') price = price * BigInt(10_000 + segment.stepBps) / 10_000n;
      if (mode === 'fall') price = price * BigInt(10_000 - segment.stepBps) / 10_000n;
      if (mode === 'sideways') price = i % 2 === 0 ? base * BigInt(10_000 + segment.stepBps) / 10_000n : base;
    }
    // A segment owns its last numbered step; otherwise the final rise/fall is lost on entering a hold.
    if (remaining <= BigInt(segment.steps)) return { price, mode };
    remaining -= BigInt(segment.steps);
  }
  return { price, mode: 'closed' };
}

export function boundedTarget(current: bigint, desired: bigint, maxStepBps: number): bigint {
  if (current <= 0n || desired <= 0n) throw new Error('invalid price');
  integer(maxStepBps, 1, 5);
  const change = current * BigInt(maxStepBps) / 10_000n;
  return desired > current ? min(desired, current + change) : max(desired, current - change);
}

export function canSwap(timestamp: bigint, lastObservation: bigint, stepSeconds: number): boolean {
  integer(stepSeconds, 60, 300);
  if (lastObservation < 1n || timestamp < lastObservation) throw new Error('invalid observation time');
  return timestamp - lastObservation >= BigInt(stepSeconds);
}

export function min(a: bigint, b: bigint): bigint { return a < b ? a : b; }
export function max(a: bigint, b: bigint): bigint { return a > b ? a : b; }
