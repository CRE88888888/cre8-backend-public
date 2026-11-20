import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assetBatchBudget,assetPeriod,nextAssetSlot,planContribution} from '../src/asset-plan.js';
import {validateAssetConfig,UINT256_MAX,minimumAssetContribution} from '../src/strategy-execution.js';
import type {AssetMode} from '../src/strategy-execution.js';
import {sumInputs,basketBatch,USDT_UNIT as U} from '../src/new-money-plan.js';
import {assetTradeMinimumReason,tradeMinimumReason} from '../src/rebalance-plan.js';
import {loadTradingConfig} from '../src/config.js';
import {TESTNET_97} from '../src/testnet-profile.js';
import {largestContributionExecution} from './fixtures/contribution-preview.js';
const cash=TESTNET_97.contracts.usdt,a=TESTNET_97.assets.WBNB.token,b=TESTNET_97.assets.ETH.token;
const R=27n*U/100n;
const confirmed=new Date('2026-11-15T12:59:00Z');
const daily:Extract<AssetMode,{kind:'stack'}>={kind:'stack',every:'daily',weekday:null,timeUtc:'13:00',slices:12};
test('#123 105 separate daily365 calendars finish within one second at the preview ceiling and uint256 maximum',()=>{
  const execution=largestContributionExecution();
  for(const total of [10_000_000n*U,UINT256_MAX]){
    const started=performance.now();
    const plan=planContribution(total,execution,confirmed,R,true);
    const elapsed=performance.now()-started;
    assert.ok(plan);
    assert.deepEqual(plan.effectiveSlices,Object.fromEntries(execution.assets.filter(a=>a.asset!==cash).map(a=>[a.asset,365])));
    assert.equal(plan.slots.length,105*365);
    assert.ok(elapsed<1000,`planning took ${elapsed.toFixed(0)}ms`);
  }
});
function config(mode:AssetMode=daily,cashWeight=0){
  const allocation={assets:[{address:a,weightBps:10000-cashWeight},{address:cash,weightBps:cashWeight}]};
  return validateAssetConfig({kind:'per_asset',numeraire:cash,assets:[{asset:a,weightBps:10000-cashWeight,execution:mode,yield:null},{asset:cash,weightBps:cashWeight,yield:null}]},allocation,97);
}
test('#118 daily 365 / weekly 52 bounds and contribution cash minimum use the corrected formula',()=>{
  for(const [every,maximum] of [['daily',365],['weekly',52]] as const){
    const mode={...daily,every,weekday:every==='daily'?null:1,slices:maximum};
    assert.doesNotThrow(()=>config(mode));
    assert.throws(()=>config({...mode,slices:maximum+1}));
    for(const slices of [0,1,2.5])assert.throws(()=>config({...mode,slices}));
  }
  for(const [weight,expected] of [[0,50n],[5000,50n],[8000,50n],[8501,67n],[9000,100n],[9900,1000n],[9999,100000n],[10000,50n]] as const){
    const c=weight===10000?validateAssetConfig(undefined,{assets:[{address:cash,weightBps:10000}]},97):config({kind:'hold'},weight);
    assert.equal(minimumAssetContribution(c),expected*U);
    assert.ok(planContribution(expected*U,c,confirmed,R, true));
    assert.equal(planContribution(expected*U-1n,c,confirmed,R,true),null);
  }
});
test('#118 per-asset ten-USDT boundary, 100/12 -> 10, 0.5% final dust and uint256/365 search',()=>{
  for(const feeWindow of [false,true]){
    const caps=new Map([[a,null]]);
    assert.ok(assetBatchBudget({[a]:(10n*U).toString()},R,caps,UINT256_MAX,16,new Set(),feeWindow));
    for(const amount of [0n,999n*U/100n,10n*U-1n])assert.equal(assetBatchBudget({[a]:amount.toString()},R,caps,UINT256_MAX,16,new Set(),feeWindow),null);
    assert.deepEqual(planContribution(100n*U,config(),confirmed,R,feeWindow)?.effectiveSlices,{[a]:10});
    const c=config({...daily,slices:365});
    assert.deepEqual(planContribution(UINT256_MAX,c,confirmed,R,feeWindow)?.effectiveSlices,{[a]:365});
    assert.deepEqual(planContribution(50n*U,c,confirmed,R,feeWindow)?.effectiveSlices,{[a]:5});
    const allocation={assets:[{address:a,weightBps:9950},{address:b,weightBps:50},{address:cash,weightBps:0}]};
    assert.ok(planContribution(50n*U,validateAssetConfig(undefined,allocation,97),confirmed,R,feeWindow));
  }
});
test('#83 G0-4 50/100/120 shorten only the lot counts and include fee in the total threshold',()=>{
  const original=config();
  for(const [amount,n] of [[50n*U,5],[100n*U,10],[120n*U,12]] as const){
    const planned=planContribution(amount,original,confirmed,R);assert.ok(planned);
    assert.deepEqual(planned.effectiveSlices,{[a]:n});assert.equal(planned.minimum,50n*U);
  }
  assert.equal(original.assets.find(x=>x.asset===a)?.execution?.kind,'stack');
  assert.equal(planContribution(50n*U-1n,original,confirmed,R),null);
  assert.equal(planContribution(100n*U-1n,original,confirmed,R)?.effectiveSlices[a],9);
});
test('#83 calendar first slot is strictly after confirmation at daily/weekly equality and fixed UTC across DST',()=>{
  assert.equal(nextAssetSlot(confirmed,daily).toISOString(),'2026-11-15T13:00:00.000Z');
  assert.equal(nextAssetSlot(new Date('2026-11-15T13:00:00Z'),daily).toISOString(),'2026-11-16T13:00:00.000Z');
  const weekly={...daily,every:'weekly' as const,weekday:1};
  assert.equal(nextAssetSlot(new Date('2026-11-16T13:00:00Z'),weekly).toISOString(),'2026-11-23T13:00:00.000Z');
  assert.equal(nextAssetSlot(new Date('2027-03-13T13:00:00Z'),daily).toISOString(),'2027-03-14T13:00:00.000Z');
  assert.equal(assetPeriod(daily),86400000);assert.equal(assetPeriod(weekly),604800000);assert.equal(assetPeriod({kind:'hold'}),86400000);
  assert.throws(()=>nextAssetSlot(new Date('invalid'),daily));
});
test('#118 cash allocation requires 50 total for a 50% risky batch and cash-only makes no slice',()=>{
  const mixed=config(daily,5000);
  assert.equal(planContribution(50n*U-1n,mixed,confirmed,R),null);
  assert.deepEqual(planContribution(50n*U,mixed,confirmed,R)?.effectiveSlices,{[a]:2});
  const only=validateAssetConfig(undefined,{assets:[{address:cash,weightBps:10000}]},97);
  assert.deepEqual(planContribution(50n*U,only,confirmed,R),{minimum:50n*U,effectiveSlices:{},slots:[]});
});
test('#83 actual timestamp merging permits shared 10 budgets and separate clocks require separate budgets',()=>{
  const allocation={assets:[{address:a,weightBps:5000},{address:b,weightBps:5000},{address:cash,weightBps:0}]};
  const make=(second:AssetMode)=>validateAssetConfig({kind:'per_asset',numeraire:cash,assets:[{asset:a,weightBps:5000,execution:daily,yield:null},{asset:b,weightBps:5000,execution:second,yield:null},{asset:cash,weightBps:0,yield:null}]},allocation,97);
  assert.deepEqual(planContribution(100n*U,make(daily),confirmed,R)?.effectiveSlices,{[a]:10,[b]:10});
  const separate=make({...daily,timeUtc:'14:00'});
  assert.deepEqual(planContribution(50n*U,separate,confirmed,R)?.effectiveSlices,{[a]:2,[b]:2});
  assert.deepEqual(planContribution(100n*U,separate,confirmed,R)?.effectiveSlices,{[a]:5,[b]:5});
});
test('#83 bounded count search preserves bigint exactness, rejects zero/overflow and never changes signed N',()=>{
  const original=config({...daily,slices:52});
  assert.deepEqual(planContribution(UINT256_MAX,original,confirmed,R)?.effectiveSlices,{[a]:52});
  for(const amount of [0n,-1n,UINT256_MAX+1n])assert.throws(()=>planContribution(amount,original,confirmed,R));
  assert.throws(()=>planContribution(50n*U,original,confirmed,-1n));
  assert.equal(original.assets.find(x=>x.asset===a)?.execution?.kind,'stack');
});
test('#83 one merged fee reserve and capacity splitting conserve each original asset budget',()=>{
  const budgets={[a]:(50n*U).toString(),[b]:(50n*U).toString()};
  const caps=new Map([[a,25n*U],[b,25n*U]]);
  const planned=assetBatchBudget(budgets,R,caps,50n*U);assert.ok(planned);
  assert.equal(planned.count,2n);assert.equal(planned.fee,2n*R);
  assert.equal(sumInputs(planned.inputs)+planned.fee,100n*U);
  const largest=basketBatch(planned.inputs,planned.count);
  assert.ok(Object.values(largest).every(raw=>BigInt(raw)<=25n*U));
  assert.equal(sumInputs(largest)+planned.fee/planned.count,50n*U);
  assert.equal(assetBatchBudget({[a]:(50n*U).toString()},R,new Map([[a,null]]),UINT256_MAX)?.inputs[a],(50n*U-R).toString());
});
test('#83 1-USDT input equality is permitted and fee-rounded dust cannot bypass the asset minimum',()=>{
  const caps=new Map([[a,null],[b,null]]);
  assert.equal(assetBatchBudget({[a]:U.toString(),[b]:(49n*U).toString()},R,caps,UINT256_MAX),null);
  const rounded=assetBatchBudget({[a]:(101n*U/100n).toString(),[b]:(49n*U).toString()},R,caps,UINT256_MAX);assert.ok(rounded);
  assert.ok(BigInt(rounded.inputs[a]??'0')>=U);
  const noFee=assetBatchBudget({[a]:U.toString(),[b]:(49n*U).toString()},0n,caps,UINT256_MAX);assert.ok(noFee);assert.equal(noFee.inputs[a],U.toString());
});
test('#83 unavailable capacity, buy limits and too-small complete batches produce no authorization',()=>{
  const budgets={[a]:(50n*U).toString()};
  assert.equal(assetBatchBudget(budgets,R,new Map([[a,0n]]),UINT256_MAX),null);
  assert.equal(assetBatchBudget(budgets,R,new Map([[a,null]]),0n),null);
  assert.equal(assetBatchBudget({[a]:(10n*U-1n).toString()},R,new Map([[a,null]]),UINT256_MAX),null);
  assert.equal(assetBatchBudget({},R,new Map(),UINT256_MAX),null);
  assert.throws(()=>assetBatchBudget(budgets,R,new Map(),UINT256_MAX));
});


test('#83 new 50 threshold includes fee reserve while legacy target_weight keeps actual swap notional',()=>{
  const input=50n*U-R;
  assert.equal(assetTradeMinimumReason([input],50n*U),null);
  assert.match(assetTradeMinimumReason([input],50n*U-1n)??'',/BELOW_MIN_BATCH/);
  assert.equal(assetTradeMinimumReason([U,49n*U-R],50n*U),null);
  assert.match(assetTradeMinimumReason([U-1n,49n*U-R+1n],50n*U)??'',/BELOW_MIN_STEP/);
  assert.throws(()=>assetTradeMinimumReason([],50n*U),/invalid/);
  assert.throws(()=>assetTradeMinimumReason([-1n],50n*U),/invalid/);
  assert.throws(()=>assetTradeMinimumReason([50n*U],50n*U-1n),/invalid/);
  const policy={...loadTradingConfig(),minStepUsdE8:100000000n,minBatchUsdE8:5000000000n};
  assert.match(tradeMinimumReason([input],'ordinary',policy,18)??'',/BELOW_MIN_BATCH/);
  assert.equal(tradeMinimumReason([50n*U],'ordinary',policy,18),null);
});

test('#83 dust-aware shortening keeps a 99/1 basket executable instead of counting deferred dust in sub-10 batches',()=>{
  const allocation={assets:[{address:a,weightBps:9900},{address:b,weightBps:100},{address:cash,weightBps:0}]};
  const execution=validateAssetConfig({kind:'per_asset',numeraire:cash,assets:allocation.assets.map(asset=>({asset:asset.address,weightBps:asset.weightBps,yield:null,...(asset.address===cash?{}:{execution:daily})}))},allocation,97);
  assert.deepEqual(planContribution(100n*U,execution,confirmed,R)?.effectiveSlices,{[a]:9,[b]:9},'deferred sub-1 inputs cannot count toward the executable 10-budget minimum');
});

test('#92 large basket reserves all child fees, preserves raw budgets and checks each child minimum',()=>{
  const entries=Object.values(TESTNET_97.assets).map(a=>[a.token,(100n*U).toString()] as const);
  const budgets=Object.fromEntries(entries),caps=new Map(entries.map(([a])=>[a,null]));
  const result=assetBatchBudget(budgets,R,caps,UINT256_MAX,9);assert.ok(result);
  assert.equal(result.fee,12n*R);
  assert.equal(result.count,1n);
  assert.equal(sumInputs(result.inputs)+result.fee,10500n*U);
  assert.equal(assetBatchBudget(Object.fromEntries(entries.map(([a])=>[a,U.toString()])),R,caps,UINT256_MAX,9),null);
  assert.throws(()=>assetBatchBudget(budgets,R,new Map(),UINT256_MAX,9));
});

test('#92 unequal weights split the large leg to fund every child without changing original budgets',()=>{
  const addresses=Object.values(TESTNET_97.assets).slice(0,17).map(a=>a.token);
  const budgets=Object.fromEntries(addresses.map((a,i)=>[a,((i===16?968n:2n)*U).toString()]));
  const before={...budgets};
  const planned=assetBatchBudget(budgets,R,new Map(addresses.map(a=>[a,null])),UINT256_MAX,16);
  assert.ok(planned,'16 small legs plus one large leg have a feasible two-child execution');
  assert.equal(planned.fee,2n*R);
  assert.equal(sumInputs(planned.inputs)+planned.fee,1000n*U);
  assert.deepEqual(budgets,before);
  const allocation={assets:[...addresses.map((address,i)=>({address,weightBps:i===16?9680:20})),{address:cash,weightBps:0}]};
  const execution=validateAssetConfig(undefined,allocation,97);
  assert.ok(planContribution(1000n*U,execution,confirmed,R),'contribution validation uses the same feasible child budgets');
});

test('#92 two large positions reserve exactly two fees at the 100-USDT contribution boundary',()=>{
  const addresses=Object.values(TESTNET_97.assets).slice(0,18).map(a=>a.token);
  const budgets=Object.fromEntries(addresses.map((a,i)=>[a,((i<16?2n:34n)*U).toString()]));
  const planned=assetBatchBudget(budgets,R,new Map(addresses.map(a=>[a,null])),UINT256_MAX,9);assert.ok(planned);
  assert.equal(planned.fee,2n*R);assert.equal(planned.count,1n);assert.equal(sumInputs(planned.inputs)+planned.fee,100n*U);
  for(const [asset,raw] of Object.entries(budgets))assert.equal(BigInt(planned.inputs[asset]??'0'),BigInt(raw)*9946n/10000n);
});

test('#100 window reserves one top-up across 105 assets / eight children and a 100-USDT split',()=>{
  const addresses=Object.values(TESTNET_97.assets).map(a=>a.token);
  const budgets=Object.fromEntries(addresses.map(a=>[a,(100n*U).toString()]));
  const caps=new Map(addresses.map(a=>[a,null]));
  const large=assetBatchBudget(budgets,R,caps,UINT256_MAX,14,new Set(),true);
  assert.ok(large);assert.equal(large.fee,R);assert.equal(sumInputs(large.inputs)+large.fee,10500n*U);
  const upper=assetBatchBudget({[a]:UINT256_MAX.toString()},R,new Map([[a,null]]),UINT256_MAX,16,new Set(),true);
  assert.ok(upper);assert.equal(sumInputs(upper.inputs)+upper.fee,UINT256_MAX);
  const small=assetBatchBudget({[a]:(50n*U).toString(),[b]:(50n*U).toString()},R,new Map([[a,25n*U],[b,25n*U]]),50n*U,16,new Set(),true);
  assert.ok(small);assert.equal(small.count,2n);assert.equal(small.fee,R);assert.equal(sumInputs(small.inputs),100n*U-R);
  assert.equal(assetBatchBudget({[a]:(10n*U-1n).toString()},0n,new Map([[a,null]]),UINT256_MAX,16,new Set(),true),null);
});
