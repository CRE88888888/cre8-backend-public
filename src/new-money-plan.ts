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
/**
 * Take `shortfall` out of one child's inputs so the child itself pays a minimum-fee top-up its job can no longer cover
 * (2026-11-24, portfolios 13 and 17: a job that ran over several hourly fee windows paid a top-up in each and had too
 * little fee left for its last child, which was then refused before sending, forever).
 * Proportional to each leg; a leg that would fall under its floor (1 USDT unless it is a final installment) stays at
 * the floor and the other legs carry its share. Null when the legs cannot give that much.
 */
export function reduceInputs(inputs: InputVector, shortfall: bigint, floorOf: (asset: string) => bigint): InputVector | null {
  if (shortfall < 0n) throw new RangeError('invalid shortfall');
  const result: Record<string, bigint> = Object.fromEntries(Object.entries(inputs).filter(([, raw]) => BigInt(raw) > 0n).map(([asset, raw]) => [asset, BigInt(raw)]));
  const floor = (asset: string) => { const f = floorOf(asset), own = BigInt(inputs[asset] ?? '0'); return f < own ? f : own; };
  let left = shortfall;
  let free = Object.keys(result);
  while (left > 0n) {
    free = free.filter(asset => (result[asset] ?? 0n) > floor(asset));
    const total = free.reduce((sum, asset) => sum + (result[asset] ?? 0n), 0n);
    if (free.length === 0 || total === 0n) return null;
    const before = left;
    for (const asset of free) {
      const value = result[asset] ?? 0n, room = value - floor(asset);
      // Round up so the loop always makes progress; never take more than is still missing or than the leg can give.
      let cut = (before * value + total - 1n) / total;
      if (cut > room) cut = room;
      if (cut > left) cut = left;
      result[asset] = value - cut; left -= cut;
    }
  }
  return Object.fromEntries(Object.entries(result).map(([asset, value]) => [asset, value.toString()]));
}
/**
 * The largest principal n <= `principal` with n + due(n) <= `budget`, where `due` is the executor's own top-up figure
 * for a batch of that size. `due` first rises with the size and falls past the 1% cap, so this walks the fixed point
 * n = budget - due(n) and keeps the best size the executor itself confirmed. Null when no size fits.
 */
export async function principalWithinFee(principal: bigint, budget: bigint, due: (notional: bigint) => Promise<bigint>, reads = 4): Promise<{ principal: bigint; fee: bigint } | null> {
  if (principal <= 0n || budget < principal) throw new RangeError('invalid fee budget');
  let fee = await due(principal);
  if (principal + fee <= budget) return { principal, fee };
  let best: { principal: bigint; fee: bigint } | null = null;
  for (let i = 0; i < reads; i++) {
    const candidate = budget - fee;
    if (candidate <= 0n) break;
    const exact = await due(candidate);
    const fits = candidate + exact <= budget;
    if (fits && (best === null || candidate > best.principal)) best = { principal: candidate, fee: exact };
    if (exact === fee) break;
    // A miss means the fee is higher at the smaller size: step past it by the size of the miss to land on the safe side.
    fee = fits ? exact : exact + (exact - fee);
  }
  return best;
}
/** Split every component by the same divisor, assigning raw remainders to the first batches. */
export function basketBatch(vector: InputVector, count: bigint): InputVector {
  if (count <= 0n) throw new RangeError('invalid batch count');
  return Object.fromEntries(Object.entries(vector).filter(([, value]) => BigInt(value) > 0n)
    .map(([asset, value]) => [asset, ((BigInt(value) + count - 1n) / count).toString()]));
}
/** Spend the window reserve in the first child only. Keep the later children at
 * their full principal budget (100 including one reserve can still make 2 x 50).
 * The frozen vector is only partitioned; no fee remainder becomes principal.
 */
export function windowBasketBatch(vector: InputVector, count: bigint, reserve: bigint, minimum=50n*USDT_UNIT): InputVector {
  if(count<=0n||reserve<0n||minimum<0n)throw new RangeError('invalid window batch');
  if(count===1n)return basketBatch(vector,1n);
  const total=sumInputs(vector),ordinary=basketBatch(vector,count),amount=total-minimum*(count-1n);
  if(sumInputs(ordinary)<=amount)return ordinary;
  if(amount<=0n||amount>total)throw new RangeError('insufficient window budget');
  let left=amount;
  let remainingTotal=total;
  const entries=Object.entries(vector).filter(([,raw])=>BigInt(raw)>0n);
  return Object.fromEntries(entries.map(([asset,raw],i)=>{
    const part=i===entries.length-1?left:BigInt(raw)*left/remainingTotal;
    left-=part;remainingTotal-=BigInt(raw);
    return [asset,part.toString()];
  }));
}
/** Both the first and largest later child must respect capacities. */
export function windowCapacityFits(vector:InputVector,count:bigint,reserve:bigint,caps:ReadonlyMap<string,bigint|null>,buyLimit:bigint,minimum=50n*USDT_UNIT):boolean{
  const first=windowBasketBatch(vector,count,reserve,minimum);
  const candidates=count===1n?[first]:[first,basketBatch(subtractInputs(vector,first),count-1n)];
  return candidates.every(batch=>sumInputs(batch)<=buyLimit&&Object.entries(batch).every(([asset,raw])=>{
    if(!caps.has(asset))throw new Error('missing asset capacity');
    const cap=caps.get(asset);return cap===null||(cap!==undefined&&BigInt(raw)<=cap);
  }));
}
export function maxWindowBatches(vector:InputVector,reserve:bigint):bigint{
  let maximum=(sumInputs(vector)+reserve)/(50n*USDT_UNIT);
  for(const raw of Object.values(vector)){const n=BigInt(raw)/(5n*USDT_UNIT);if(n<maximum)maximum=n;}
  return maximum;
}
export function windowBasketFits(vector:InputVector,count:bigint,reserve:bigint,caps:ReadonlyMap<string,bigint|null>,buyLimit:bigint):boolean{
  const first=windowBasketBatch(vector,count,reserve);
  if(sumInputs(first)+reserve<50n*USDT_UNIT||Object.values(first).some(n=>BigInt(n)<5n*USDT_UNIT))return false;
  if(count>1n){
    const smallest=Object.fromEntries(Object.entries(subtractInputs(vector,first)).map(([a,v])=>[a,(BigInt(v)/(count-1n)).toString()]));
    if(!basketMinimum(smallest))return false;
  }
  return windowCapacityFits(vector,count,reserve,caps,buyLimit);
}
export function windowBatchCountFor(vector:InputVector,reserve:bigint,caps:ReadonlyMap<string,bigint|null>,buyLimit:bigint):bigint|null{
  const maximum=maxWindowBatches(vector,reserve);
  if(maximum<1n||buyLimit<=0n||!windowCapacityFits(vector,maximum,reserve,caps,buyLimit))return null;
  let low=1n,high=maximum;
  while(low<high){const mid=(low+high)/2n;if(windowCapacityFits(vector,mid,reserve,caps,buyLimit))high=mid;else low=mid+1n;}
  return windowBasketFits(vector,low,reserve,caps,buyLimit)?low:null;
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
  reserve: bigint, caps: ReadonlyMap<string, bigint | null>, buyLimit: bigint, feeWindow=false): MoneyBudget | null {
  if (total <= 0n || total > UINT256_MAX || reserve < 0n || buyLimit < 0n) throw new RangeError('invalid budget');
  const risky = allocation.assets.filter(a => a.weightBps > 0 && a.address.toLowerCase() !== cash.toLowerCase());
  if (risky.length === 0) return kind === 'hold' ? { amount: total, fee: 0n, cash: total, inputs: {}, batchCount: 0n } : null;
  if(feeWindow){
    const amount=total-(kind==='hold'?reserve:0n);
    if(amount<=0n)return null;
    const vector=allocationInputs(amount,allocation,cash);
    const count=windowBatchCountFor(vector.inputs,reserve,caps,buyLimit);
    return count===null?null:{amount,fee:reserve,cash:vector.cash,inputs:vector.inputs,batchCount:count};
  }
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
