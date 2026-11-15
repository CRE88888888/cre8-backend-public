import type { Allocation } from './strategies.js';
import { UINT256_MAX } from './strategy-execution.js';

export type InputVector = Record<string, string>;
export const USDT_UNIT = 10n ** 18n;
export function sumInputs(vector: InputVector): bigint {
  return Object.values(vector).reduce((sum, value) => sum + BigInt(value), 0n);
}
export function allocationInputs(amount: bigint, allocation: Allocation, cash: string): { inputs: InputVector; cash: bigint } {
  if (amount <= 0n || amount > UINT256_MAX) throw new RangeError('invalid allocation amount');
  const inputs: InputVector = {};
  for (const asset of allocation.assets) {
    if (asset.weightBps > 0 && asset.address.toLowerCase() !== cash.toLowerCase()) {
      inputs[asset.address.toLowerCase()] = (amount * BigInt(asset.weightBps) / 10000n).toString();
    }
  }
  return { inputs, cash: amount - sumInputs(inputs) };
}
export function addInputs(a: InputVector, b: InputVector): InputVector {
  const result = { ...a };
  for (const [asset, value] of Object.entries(b)) result[asset] = (BigInt(result[asset] ?? '0') + BigInt(value)).toString();
  return result;
}
export function subtractInputs(a: InputVector, b: InputVector): InputVector {
  const result = { ...a };
  for (const [asset, value] of Object.entries(b)) {
    if (result[asset] === undefined || BigInt(value) > BigInt(result[asset])) throw new Error('input exceeds original budget');
    result[asset] = (BigInt(result[asset]) - BigInt(value)).toString();
  }
  return result;
}
/** Split every component by the same divisor, assigning raw remainders to the first batches. */
export function basketBatch(vector: InputVector, count: bigint): InputVector {
  if (count <= 0n) throw new RangeError('invalid batch count');
  return Object.fromEntries(Object.entries(vector).filter(([, value]) => BigInt(value) > 0n)
    .map(([asset, value]) => [asset, ((BigInt(value) + count - 1n) / count).toString()]));
}
export function basketMinimum(vector: InputVector): boolean {
  const values = Object.values(vector).map(BigInt);
  return values.length > 0 && values.every(value => value >= 5n * USDT_UNIT) && sumInputs(vector) >= 50n * USDT_UNIT;
}
/** Both the smallest and largest child must fit; no component may be dropped. */
export function basketFits(vector: InputVector, count: bigint, caps: ReadonlyMap<string, bigint | null>, buyLimit: bigint): boolean {
  const smallest = Object.fromEntries(Object.entries(vector).map(([asset, value]) => [asset, (BigInt(value) / count).toString()]));
  const largest = basketBatch(vector, count);
  return basketMinimum(smallest) && sumInputs(largest) <= buyLimit && Object.entries(largest).every(([asset, value]) => {
    if (!caps.has(asset)) throw new Error('missing asset capacity');
    const cap = caps.get(asset);
    return cap === null || (cap !== undefined && BigInt(value) <= cap);
  });
}
export function maxBasketBatches(vector:InputVector,feeBatches:bigint):bigint{
  let maximum=sumInputs(vector)/(50n*USDT_UNIT);
  if(feeBatches<maximum)maximum=feeBatches;
  for(const raw of Object.values(vector)){const bound=BigInt(raw)/(5n*USDT_UNIT);if(bound<maximum)maximum=bound;}
  return maximum;
}
/** Bounded logarithmic search over a fixed remaining vector; a zero cap never scans k. */
export function batchCountFor(vector:InputVector,caps:ReadonlyMap<string,bigint|null>,buyLimit:bigint,feeBatches:bigint):bigint|null{
  const maximum=maxBasketBatches(vector,feeBatches);
  if(maximum<1n||buyLimit<=0n)return null;
  for(const asset of Object.keys(vector)){
    if(!caps.has(asset))throw new Error('missing asset capacity');
    const cap=caps.get(asset);if(cap===undefined||(cap!==null&&cap<=0n))return null;
  }
  const capacity=(k:bigint)=>{const v=basketBatch(vector,k);return sumInputs(v)<=buyLimit&&Object.entries(v).every(([a,n])=>{
    const cap=caps.get(a);return cap===null||(cap!==undefined&&BigInt(n)<=cap);
  });};
  if(!capacity(maximum))return null;
  let low=1n,high=maximum;
  while(low<high){const mid=(low+high)/2n;if(capacity(mid))high=mid;else low=mid+1n;}
  return basketFits(vector,low,caps,buyLimit)?low:null;
}
export type MoneyBudget = { amount: bigint; fee: bigint; cash: bigint; inputs: InputVector; batchCount: bigint };
/** k is bounded by the complete-basket minimum, never by an arbitrary retry count. */
export function moneyBudget(total: bigint, kind: 'hold' | 'stack', allocation: Allocation, cash: string,
  reserve: bigint, caps: ReadonlyMap<string, bigint | null>, buyLimit: bigint): MoneyBudget | null {
  if (total <= 0n || total > UINT256_MAX || reserve < 0n || buyLimit < 0n) throw new RangeError('invalid budget');
  const risky = allocation.assets.filter(a => a.weightBps > 0 && a.address.toLowerCase() !== cash.toLowerCase());
  if (risky.length === 0) return kind === 'hold' ? { amount: total, fee: 0n, cash: total, inputs: {}, batchCount: 0n } : null;
  const perBatchReserve = kind === 'hold' ? reserve : 0n;
  const riskWeight = risky.reduce((sum, a) => sum + BigInt(a.weightBps), 0n);
  let maximum = total * riskWeight / (500_000n * USDT_UNIT + perBatchReserve * riskWeight);
  for (const asset of risky) {
    const weight = BigInt(asset.weightBps);
    const bound = total * weight / (50_000n * USDT_UNIT + perBatchReserve * weight);
    if (bound < maximum) maximum = bound;
    const cap = caps.get(asset.address.toLowerCase());
    if (!caps.has(asset.address.toLowerCase())) throw new Error('missing asset capacity');
    if (cap === undefined || (cap !== null && cap <= 0n)) return null;
  }
  if (maximum < 1n || buyLimit === 0n) return null;
  const vectorAt = (count: bigint) => allocationInputs(total - perBatchReserve * count, allocation, cash);
  const capacityFits = (count: bigint) => {
    const largest = basketBatch(vectorAt(count).inputs, count);
    return sumInputs(largest) <= buyLimit && Object.entries(largest).every(([asset, amount]) => {
      const cap = caps.get(asset);
      return cap === null || (cap !== undefined && BigInt(amount) <= cap);
    });
  };
  // Capacity is monotone as k grows, including hold's k-dependent fee deduction.
  // Find the first fitting k; checking a bound computed at k=1 can skip an exact solution.
  if (!capacityFits(maximum)) return null;
  let low = 1n, high = maximum;
  while (low < high) {
    const mid = (low + high) / 2n;
    if (capacityFits(mid)) high = mid;
    else low = mid + 1n;
  }
  const vector = vectorAt(low);
  if (!basketFits(vector.inputs, low, caps, buyLimit)) return null;
  return { amount: total - perBatchReserve * low, fee: reserve * low, cash: vector.cash, inputs: vector.inputs, batchCount: low };
}

export type SlotClock = { startAt: Date; endAt: Date | null; periodSeconds: number; nextIndex: bigint };
export function currentSlot(clock: SlotClock, now: Date): { index: bigint; at: Date; end: Date; missedThrough: bigint | null } | null {
  const start = clock.startAt.getTime(), time = now.getTime(), period = clock.periodSeconds * 1000;
  if (!Number.isSafeInteger(time) || !Number.isSafeInteger(start) || ![86400,604800].includes(clock.periodSeconds)) throw new RangeError('invalid slot clock');
  if (time < start) return null;
  const last = clock.endAt === null ? time : Math.min(time, clock.endAt.getTime() - 1);
  const index = BigInt(Math.floor((last - start) / period));
  if (index < clock.nextIndex) return null;
  const at = new Date(start + Number(index) * period);
  return { index, at, end: new Date(Math.min(at.getTime() + period, clock.endAt?.getTime() ?? Infinity)),
    missedThrough: index > clock.nextIndex ? index - 1n : null };
}
