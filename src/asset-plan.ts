import type { Allocation } from './strategies.js';
import { minimumAssetContribution, numeraireFor, UINT256_MAX } from './strategy-execution.js';
import type { AssetExecution, AssetMode } from './strategy-execution.js';
import { USDT_UNIT as U, sumInputs, basketBatch } from './new-money-plan.js';
import type { InputVector } from './new-money-plan.js';

export function minimumAssetContributionFromAllocation(allocation: Allocation, chainId: number): bigint {
  return minimumAssetContribution({ kind:'per_asset', numeraire:numeraireFor(chainId), rebalance:'none', assets:allocation.assets.map(a=>({asset:a.address,weightBps:a.weightBps,yield:null})) });
}
export function nextAssetSlot(at: Date, mode: Extract<AssetMode,{kind:'stack'}>): Date {
  if (!Number.isFinite(at.getTime())) throw new RangeError('invalid confirmation time');
  const [hour,minute] = mode.timeUtc.split(':').map(Number);
  const candidate = new Date(at); candidate.setUTCHours(hour ?? 0,minute ?? 0,0,0);
  if(mode.every==='weekly')candidate.setUTCDate(candidate.getUTCDate()+((mode.weekday??0)-candidate.getUTCDay()+7)%7);
  if(candidate<=at)candidate.setUTCDate(candidate.getUTCDate()+(mode.every==='daily'?1:7));
  return candidate;
}
export function assetPeriod(mode: AssetMode): number { return mode.kind==='stack' ? (mode.every==='daily'?86400000:604800000) : 86400000; }
export type ContributionPlan = { minimum:bigint; effectiveSlices:Record<string,number> };
/** Evaluate actual merged timestamps, preserving signed N while shortening only this lot.
 * At most 16*52 count reductions; no search proportional to uint256 amounts.
 */
export function planContribution(total:bigint,config:AssetExecution,confirmedAt:Date,reserve:bigint):ContributionPlan|null {
  if(total<=0n||total>UINT256_MAX||reserve<0n)throw new RangeError('invalid contribution');
  const assets=config.assets.filter(a=>a.asset!==config.numeraire);
  const counts=Object.fromEntries(assets.map(a=>[a.asset,a.execution?.kind==='stack'?a.execution.slices:1]));
  const minimum=minimumAssetContribution(config);
  if(total<minimum)return null;
  for(;;){
    const slots=new Map<number,{budget:bigint;assets:string[];inputs:InputVector}>();
    for(const a of assets){
      if(!a.execution)throw new Error('missing execution');
      const n=counts[a.asset];if(n===undefined)throw new Error('missing count');
      const amount=total*BigInt(a.weightBps)/10000n,base=amount/BigInt(n);
      const first=a.execution.kind==='stack'?nextAssetSlot(confirmedAt,a.execution).getTime():Math.floor(confirmedAt.getTime()/60000)*60000+60000;
      for(let index=0;index<n;index++){
        const time=first+index*assetPeriod(a.execution),budget=index===n-1?amount-base*BigInt(n-1):base;
        const slot=slots.get(time)??{budget:0n,assets:[],inputs:{}};slot.budget+=budget;slot.assets.push(a.asset);slot.inputs[a.asset]=budget.toString();slots.set(time,slot);
      }
    }
    const failing=[...slots.values()].filter(s=>{
      if(s.budget<=reserve)return true;
      // Dust stays outside the batch. It cannot be counted toward the 50 budget.
      const usable=Object.values(s.inputs).map(BigInt).filter(n=>n-reserve*n/s.budget>=U).reduce((sum,n)=>sum+n,0n);
      return usable<50n*U;
    });
    if(failing.length===0)return {minimum,effectiveSlices:counts};
    const reducible=assets.filter(a=>failing.some(s=>s.assets.includes(a.asset))&&(counts[a.asset]??1)>1);
    if(reducible.length===0)return null;
    // Reduce the largest count first; equal calendars stay aligned where possible.
    const largest=Math.max(...reducible.map(a=>counts[a.asset]??1));
    for(const a of reducible)if(counts[a.asset]===largest)counts[a.asset]=largest-1;
  }
}
/** Original source budgets include fee. One k*R per merged batch, apportioned once. */
export function assetBatchBudget(budgets:InputVector,reserve:bigint,caps:ReadonlyMap<string,bigint|null>,buyLimit:bigint):{inputs:InputVector;fee:bigint;count:bigint}|null{
  const total=sumInputs(budgets);
  if(total<50n*U||reserve<0n||buyLimit<=0n)return null;
  let max=total/(50n*U);
  for(const raw of Object.values(budgets)){const n=BigInt(raw)/U;if(n<max)max=n;}
  if(max<1n)return null;
  const at=(k:bigint)=>{
    const fee=reserve*k;if(fee>=total)return null;
    let left=fee;const entries=Object.entries(budgets);
    const inputs:InputVector={};
    for(const [i,[asset,raw]] of entries.entries()){
      const part=i===entries.length-1?left:fee*BigInt(raw)/total;left-=part;
      inputs[asset]=(BigInt(raw)-part).toString();
    }
    return {inputs,fee,count:k};
  };
  const capacity=(k:bigint)=>{const b=at(k);if(!b)return false;const largest=basketBatch(b.inputs,k);
    return sumInputs(largest)<=buyLimit&&Object.entries(largest).every(([a,v])=>{if(!caps.has(a))throw new Error('missing capacity');const cap=caps.get(a);return cap===null||(cap!==undefined&&BigInt(v)<=cap);});};
  if(!capacity(max))return null;
  let low=1n,high=max;while(low<high){const mid=(low+high)/2n;if(capacity(mid))high=mid;else low=mid+1n;}
  const result=at(low);if(!result||Object.values(result.inputs).some(v=>BigInt(v)/low<U))return null;
  return result;
}
