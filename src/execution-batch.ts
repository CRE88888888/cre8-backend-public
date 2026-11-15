/** #92: transaction capacity, independent of the number of assets in a version.
 * Local chain 97 measurements (contracts docs/testnet-97 §8): ~260k/swap,
 * ~66k/held asset in buy valuation. Allow 50% plus 500k for Kernel validation.
 * This selects candidates only; the sender also checks the actual prepared gas.
 */
export const MAX_USER_OP_STEPS = 16;
export const MAX_USER_OP_GAS = 14_000_000n;
type GasOverhead = { verificationGasLimit: bigint; preVerificationGas: bigint;
  paymasterVerificationGasLimit?: bigint; paymasterPostOpGasLimit?: bigint };
/** Preparation restores the sponsor's signed limits, which can exceed the
 * bundler's simulated paymaster usage. Capacity must include those real limits.
 */
export function userOpGasOverhead(estimate: GasOverhead, sponsor?: Pick<GasOverhead,'paymasterVerificationGasLimit'|'paymasterPostOpGasLimit'>): bigint {
  const verification=estimate.paymasterVerificationGasLimit??0n,post=estimate.paymasterPostOpGasLimit??0n;
  const sponsorVerification=sponsor?.paymasterVerificationGasLimit??0n,sponsorPost=sponsor?.paymasterPostOpGasLimit??0n;
  if([estimate.verificationGasLimit,estimate.preVerificationGas,verification,post,sponsorVerification,sponsorPost].some(gas=>gas<0n))throw new RangeError('invalid UserOp overhead');
  return estimate.verificationGasLimit+estimate.preVerificationGas+
    (verification>sponsorVerification?verification:sponsorVerification)+(post>sponsorPost?post:sponsorPost);
}
/** Keep room for the final paymaster/signature preparation to update overhead.
 * Headroom can shrink on 97; the bundler's raw execution estimate cannot.
 * The final prepared operation is checked independently before broadcasting.
 */
export function boundedCallGasLimit(desired: bigint, estimated: bigint, overhead: bigint): bigint {
  if (desired < 0n || estimated < 0n || overhead < 0n || desired < estimated) throw new RangeError('invalid call gas estimate');
  const available = MAX_USER_OP_GAS - overhead - 50_000n;
  if (available < estimated) throw new Error('[USER_OP_CAPACITY] 原始 gas 估算超過安全容量，不送交易');
  return desired > available ? available : desired;
}
export function estimatedBatchGas(steps: number, heldAssets: number, buys = true): bigint {
  for (const n of [steps, heldAssets]) if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('invalid execution batch size');
  return (450_000n + BigInt(steps) * 260_000n + (buys ? BigInt(heldAssets) * 66_000n : 0n)) * 3n / 2n + 500_000n;
}
export function executionBatchSize(heldAssets: number, buys = true): number {
  let steps = MAX_USER_OP_STEPS;
  while (steps > 0 && estimatedBatchGas(steps, heldAssets, buys) > MAX_USER_OP_GAS) steps--;
  return steps;
}
/** Balance the final short group, so a one-asset tail does not strand a <50 budget. */
export function executionGroups<T>(entries: readonly T[], limit: number): T[][] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_USER_OP_STEPS) throw new RangeError('invalid execution group limit');
  const groups: T[][] = [];
  const count = Math.ceil(entries.length / limit);
  let offset = 0;
  for (let i = 0; i < count; i++) {
    const size = Math.ceil((entries.length - offset) / (count - i));
    groups.push(entries.slice(offset, offset + size)); offset += size;
  }
  return groups;
}
export function assertUserOpCapacity(steps: number, gas: bigint): void {
  if (!Number.isSafeInteger(steps) || steps < 1 || steps > MAX_USER_OP_STEPS || gas < 0n || gas > MAX_USER_OP_GAS) {
    throw new Error('[USER_OP_CAPACITY] 批次步數或 gas 超過安全容量，不送交易');
  }
}

/** Keep small legs together; if a group is below 50, split the largest leg across
 * those groups. Every raw unit stays in the original asset's budget. No new
 * principal is created. Only final installments may include a positive sub-1 remainder.
 */
export function executionInputGroups(inputs: Record<string,string>, limit: number, reserve: bigint, finalAssets: ReadonlySet<string> = new Set(), feeWindow=false): Record<string,string>[] | null {
  const unit = 10n ** 18n;
  const minimum=(index:number)=>50n*unit-(!feeWindow||index===0?reserve:0n);
  if (reserve < 0n) throw new RangeError('invalid fee reserve');
  const entries = Object.entries(inputs).filter(([,raw])=>BigInt(raw)>0n);
  const groups = executionGroups(entries,limit).map(group=>Object.fromEntries(group));
  const sum = (group: Record<string,string>)=>Object.values(group).reduce((n,raw)=>n+BigInt(raw),0n);
  if (!entries.length || entries.some(([asset,raw])=>BigInt(raw)<unit&&!finalAssets.has(asset))) return null;
  if(feeWindow)groups.sort((a,b)=>sum(a)<sum(b)?-1:sum(a)>sum(b)?1:0);
  if (groups.every((group,i)=>sum(group)>=minimum(i))) return groups;
  // Spread multiple large positions before splitting one donor. Grouping only
  // by entry order can strand a valid small tail beside two fully funded groups.
  const byBudget=[...entries].sort((a,b)=>BigInt(a[1])>BigInt(b[1])?-1:BigInt(a[1])<BigInt(b[1])?1:a[0].localeCompare(b[0]));
  const balanced:Record<string,string>[]=groups.map(()=>({}));
  for(const [asset,raw] of byBudget){
    const candidates=balanced.filter(group=>Object.keys(group).length<limit).sort((a,b)=>sum(a)<sum(b)?-1:sum(a)>sum(b)?1:0);
    const child=candidates[0];if(!child)throw new Error('execution group capacity mismatch');
    child[asset]=raw;
  }
  if(feeWindow)balanced.sort((a,b)=>sum(a)<sum(b)?-1:sum(a)>sum(b)?1:0);
  if(balanced.every((group,i)=>sum(group)>=minimum(i)))return balanced;
  if (limit===1) return null;
  const sorted = [...entries].sort((a,b)=>BigInt(a[1])<BigInt(b[1])?-1:BigInt(a[1])>BigInt(b[1])?1:a[0].localeCompare(b[0]));
  const donor = sorted.pop();
  if (!donor) return null;
  const children = executionGroups(sorted,limit-1).map(group=>Object.fromEntries(group));
  if (!children.length) return null;
  let left = BigInt(donor[1]);
  for (const [index,child] of children.entries()) {
    const needed = minimum(index)-sum(child);
    // Reserve a >=1 leg in each child. This also leaves room to distribute the
    // remainder without ever introducing a dust-only transaction.
    const amount = needed>unit?needed:unit;
    child[donor[0]]=amount.toString(); left-=amount;
  }
  if (left<0n) return null;
  const last = children.at(-1);
  if (!last) return null;
  last[donor[0]]=(BigInt(last[donor[0]]??'0')+left).toString();
  return children;
}
