import { executionBatchSize, executionInputGroups } from './execution-batch.js';
import type { Allocation } from './strategies.js';
import { minimumAssetContribution, numeraireFor, UINT256_MAX } from './strategy-execution.js';
import type { AssetExecution, AssetMode } from './strategy-execution.js';
import { USDT_UNIT as U, sumInputs, basketBatch, windowBasketBatch, windowCapacityFits, subtractInputs } from './new-money-plan.js';
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
 * At most assets.length*52 count reductions; no search proportional to uint256 amounts.
 */
export function planContribution(total:bigint,config:AssetExecution,confirmedAt:Date,reserve:bigint,feeWindow=false):ContributionPlan|null {
  if(total<=0n||total>UINT256_MAX||reserve<0n)throw new RangeError('invalid contribution');
  const assets=config.assets.filter(a=>a.asset!==config.numeraire);
  const counts=Object.fromEntries(assets.map(a=>[a.asset,a.execution?.kind==='stack'?a.execution.slices:1]));
  const minimum=minimumAssetContribution(config);
  const stepLimit=executionBatchSize(assets.length);
  if(stepLimit===0)return null;
  if(total<minimum)return null;
  for(;;){
    const slots=new Map<number,{budget:bigint;assets:string[];inputs:InputVector;finalAssets:Set<string>}>();
    for(const a of assets){
      if(!a.execution)throw new Error('missing execution');
      const n=counts[a.asset];if(n===undefined)throw new Error('missing count');
      const amount=total*BigInt(a.weightBps)/10000n,base=amount/BigInt(n);
      const first=a.execution.kind==='stack'?nextAssetSlot(confirmedAt,a.execution).getTime():Math.floor(confirmedAt.getTime()/60000)*60000+60000;
      for(let index=0;index<n;index++){
        const time=first+index*assetPeriod(a.execution),budget=index===n-1?amount-base*BigInt(n-1):base;
        const slot=slots.get(time)??{budget:0n,assets:[],inputs:{},finalAssets:new Set<string>()};if(index===n-1)slot.finalAssets.add(a.asset);slot.budget+=budget;slot.assets.push(a.asset);slot.inputs[a.asset]=budget.toString();slots.set(time,slot);
      }
    }
    const failing=[...slots.values()].filter(s=>{
      if(s.budget<=reserve)return true;
      // Nonfinal dust stays in its source; a final remainder joins the full batch.
      const inputs=Object.fromEntries(Object.entries(s.inputs).filter(([asset,raw])=>{
        const n=BigInt(raw);return s.finalAssets.has(asset)||n-reserve*n/s.budget>=U;
      }));
      return assetBatchBudget(inputs,reserve,new Map(Object.keys(inputs).map(a=>[a,null])),UINT256_MAX,stepLimit,s.finalAssets,feeWindow)===null;
    });
    if(failing.length===0)return {minimum,effectiveSlices:counts};
    const reducible=assets.filter(a=>failing.some(s=>s.assets.includes(a.asset))&&(counts[a.asset]??1)>1);
    if(reducible.length===0)return null;
    // Reduce the largest count first; equal calendars stay aligned where possible.
    const largest=Math.max(...reducible.map(a=>counts[a.asset]??1));
    for(const a of reducible)if(counts[a.asset]===largest)counts[a.asset]=largest-1;
  }
}
/** Original source budgets include fee. Reserve once per window (legacy: per child), then freeze
 * the complete input vector; execution only subtracts confirmed child inputs.
 */
export function assetBatchBudget(budgets:InputVector,reserve:bigint,caps:ReadonlyMap<string,bigint|null>,buyLimit:bigint,stepLimit=16,finalAssets:ReadonlySet<string>=new Set(),feeWindow=false):{inputs:InputVector;fee:bigint;count:bigint}|null{
  const total=sumInputs(budgets),entries=Object.entries(budgets);
  // Validate the step limit even on empty or otherwise unexecutable inputs.
  executionInputGroups({},stepLimit,reserve);
  if(total<50n*U||buyLimit<=0n||!entries.length)return null;
  const minimumGroups=Math.ceil(entries.length/stepLimit);
  const maximumGroups=stepLimit===1?minimumGroups:Math.ceil((entries.length-1)/(stepLimit-1));
  for(let groups=minimumGroups;groups<=Math.max(minimumGroups,maximumGroups);groups++){
    const groupCount=BigInt(groups);
    let maximum=total/(50n*U*groupCount);
    for(const [asset,raw] of entries){const n=BigInt(raw)/(finalAssets.has(asset)?1n:U);if(n<maximum)maximum=n;}
    if(maximum<1n)continue;
    const at=(count:bigint)=>{
      const fee=feeWindow?reserve:reserve*count*groupCount;if(fee>=total)return null;
      let left=fee;const inputs:InputVector={};
      for(const [i,[asset,raw]] of entries.entries()){
        const part=i===entries.length-1?left:fee*BigInt(raw)/total;left-=part;
        inputs[asset]=(BigInt(raw)-part).toString();
      }
      return {inputs,fee,count};
    };
    const capacity=(count:bigint)=>{const b=at(count);if(!b)return false;
      if(feeWindow)return windowCapacityFits(b.inputs,count,reserve,caps,buyLimit,50n*U*groupCount);
      const largest=basketBatch(b.inputs,count);
      return sumInputs(largest)<=buyLimit&&Object.entries(largest).every(([a,v])=>{if(!caps.has(a))throw new Error('missing capacity');const cap=caps.get(a);return cap===null||(cap!==undefined&&BigInt(v)<=cap);});};
    if(!capacity(maximum))continue;
    let low=1n,high=maximum;while(low<high){const mid=(low+high)/2n;if(capacity(mid))high=mid;else low=mid+1n;}
    const result=at(low);if(!result)continue;
    if(feeWindow){
      const first=windowBasketBatch(result.inputs,low,reserve,50n*U*groupCount);
      const firstGroups=executionInputGroups(first,stepLimit,reserve,finalAssets,true);
      const later=low===1n?null:Object.fromEntries(Object.entries(subtractInputs(result.inputs,first)).map(([a,v])=>[a,(BigInt(v)/(low-1n)).toString()]));
      const laterGroups=later===null?[]:executionInputGroups(later,stepLimit,0n,finalAssets,true);
      if(firstGroups&&firstGroups.length<=groups&&laterGroups&&laterGroups.length<=groups)return result;
      continue;
    }
    const smallest=Object.fromEntries(Object.entries(result.inputs).map(([a,v])=>[a,(BigInt(v)/low).toString()]));
    const children=executionInputGroups(smallest,stepLimit,reserve,finalAssets);
    if(children&&children.length<=groups)return result;
  }
  return null;
}
