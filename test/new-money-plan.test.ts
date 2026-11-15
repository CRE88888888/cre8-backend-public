import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allocationInputs,basketBatch,basketFits,basketMinimum,currentSlot,moneyBudget,subtractInputs,sumInputs,USDT_UNIT as U } from '../src/new-money-plan.js';
import { UINT256_MAX } from '../src/strategy-execution.js';
import {batchCountFor} from '../src/new-money-plan.js';
import type { Allocation } from '../src/strategies.js';
const cash='0x0000000000000000000000000000000000000001',a='0x0000000000000000000000000000000000000002',b='0x0000000000000000000000000000000000000003';
const allocation=(cashWeight=0,small=5000):Allocation=>({assets:[{address:cash,weightBps:cashWeight},{address:a,weightBps:10000-cashWeight-small},{address:b,weightBps:small}]});
const caps=new Map([[a,null],[b,null]]),R=27n*U/100n;
test('#83 V2 whole basket minimum includes 5/50 equality and 1 raw below',()=>{
  for(const [amount,weights,ok] of [[50n*U,allocation(),true],[50n*U-1n,allocation(),false],[100n*U,allocation(5000,2500),true],
    [100n*U-1n,allocation(5000,2500),false],[500n*U,allocation(0,100),true],[500n*U-1n,allocation(0,100),false]] as const){
    assert.equal(basketMinimum(allocationInputs(amount,weights,cash).inputs),ok);
  }
  assert.equal(basketMinimum({[a]:(5n*U).toString(),[b]:(45n*U).toString()}),true);
  assert.equal(basketMinimum({[a]:(5n*U-1n).toString(),[b]:(45n*U+1n).toString()}),false);
  for(const amount of [0n,-1n,UINT256_MAX+1n])assert.throws(()=>allocationInputs(amount,allocation(),cash));
});
test('#83 C3 hold total pays kR; stack preserves explicit A plus separate reserve',()=>{
  const hold=moneyBudget(100n*U,'hold',allocation(),cash,R,caps,UINT256_MAX);
  assert.ok(hold);assert.equal(hold.amount,100n*U-R);assert.equal(hold.fee,R);assert.equal(sumInputs(hold.inputs)+hold.cash+hold.fee,100n*U);
  assert.equal(moneyBudget(50n*U,'hold',allocation(),cash,R,caps,UINT256_MAX),null);
  const stack=moneyBudget(50n*U,'stack',allocation(),cash,R,caps,UINT256_MAX);
  assert.ok(stack);assert.equal(stack.amount,50n*U);assert.equal(stack.fee,R);
  const split=moneyBudget(200n*U,'hold',allocation(),cash,R,new Map([[a,50n*U],[b,50n*U]]),UINT256_MAX);
  assert.ok(split);assert.equal(split.batchCount,2n);assert.equal(split.amount,200n*U-2n*R);
  assert.equal(moneyBudget(100n*U,'stack',allocation(),cash,R,new Map([[a,0n],[b,null]]),UINT256_MAX),null);
  assert.equal(moneyBudget(100n*U,'stack',allocation(),cash,R,caps,0n),null);
  assert.equal(moneyBudget(100n*U,'stack',allocation(),cash,R,caps,50n*U)?.batchCount,2n);
  assert.throws(()=>moneyBudget(100n*U,'stack',allocation(),cash,R,new Map(),UINT256_MAX));
});
test('#83 V3 100% cash does not divide by zero or create empty buys; configured cash is allocated once',()=>{
  const only:Allocation={assets:[{address:cash,weightBps:10000}]};
  assert.deepEqual(moneyBudget(U,'hold',only,cash,R,new Map(),0n),{amount:U,fee:0n,cash:U,inputs:{},batchCount:0n});
  assert.equal(moneyBudget(U,'stack',only,cash,R,new Map(),0n),null);
  const vector=allocationInputs(200n*U,allocation(5000,2500),cash);
  assert.equal(vector.cash,100n*U);
  const first=basketBatch(vector.inputs,2n),remaining=subtractInputs(vector.inputs,first);
  assert.equal(sumInputs(remaining),50n*U);assert.equal(basketFits(remaining,1n,caps,50n*U),true);
  assert.equal(sumInputs(subtractInputs(remaining,remaining)),0n);
  assert.throws(()=>subtractInputs(remaining,{[a]:(26n*U).toString()}));
  assert.equal(basketFits(vector.inputs,3n,caps,UINT256_MAX),false,'cannot split below complete basket minimum');
});
test('#83 raw conservation across 1..16 components and split remainders',()=>{
  for(let size=1;size<=15;size++){
    const assets=Array.from({length:size},(_,i)=>({address:`0x${(i+2).toString(16).padStart(40,'0')}`,weightBps:Math.floor(10000/size)+(i===0?10000%size:0)}));
    const vector=allocationInputs(1001n*U+11n,{assets},cash);
    let remaining=vector.inputs,spent=0n;
    for(let left=7;left>=1;left--){const batch=basketBatch(remaining,BigInt(left));spent+=sumInputs(batch);remaining=subtractInputs(remaining,batch);}
    assert.equal(spent+vector.cash,1001n*U+11n);assert.equal(sumInputs(remaining),0n);
  }
});
test('#83 V4 UTC anchored periods: before/exact/next boundary, long downtime, exclusive end and DST',()=>{
  const startAt=new Date('2027-03-13T09:00:00-05:00'),clock={startAt,endAt:null,periodSeconds:86400,nextIndex:0n};
  assert.equal(currentSlot(clock,new Date(startAt.getTime()-1)),null);
  assert.equal(currentSlot(clock,startAt)?.index,0n);
  const next=currentSlot(clock,new Date(startAt.getTime()+86400000));
  assert.equal(next?.index,1n);assert.equal(next?.at.toISOString(),'2027-03-14T14:00:00.000Z');assert.equal(next?.missedThrough,0n);
  const late=currentSlot(clock,new Date(startAt.getTime()+86400000*5000));assert.equal(late?.index,5000n);assert.equal(late?.missedThrough,4999n);
  const endAt=new Date(startAt.getTime()+86400000);
  assert.equal(currentSlot({...clock,endAt,nextIndex:1n},endAt),null);
  assert.equal(currentSlot({...clock,endAt},endAt)?.index,0n);
  assert.throws(()=>currentSlot({...clock,periodSeconds:60},startAt));
});

test('#83 hold fee/capacity fixed point finds k=2 at the exact 5/50 boundary',()=>{
  const total=100n*U+54n*U/100n;
  const budget=moneyBudget(total,'hold',allocation(),cash,R,new Map([[a,25n*U],[b,25n*U]]),50n*U);
  assert.ok(budget);assert.equal(budget.batchCount,2n);assert.equal(budget.amount,100n*U);
  assert.equal(sumInputs(basketBatch(budget.inputs,2n)),50n*U);
});
test('#83 huge remaining vectors with zero/exhausted capacity return immediately; search is logarithmic',()=>{
  const vector={[a]:(UINT256_MAX/2n).toString(),[b]:(UINT256_MAX/2n).toString()};
  assert.equal(batchCountFor(vector,caps,0n,UINT256_MAX),null);
  assert.equal(batchCountFor(vector,new Map([[a,0n],[b,null]]),UINT256_MAX,UINT256_MAX),null);
  assert.equal(batchCountFor(vector,new Map([[a,25n*U],[b,25n*U]]),50n*U,UINT256_MAX),null,'raw amounts cannot fit exact 50-sized batches at this cap');
  const count=batchCountFor(vector,new Map([[a,100n*U],[b,100n*U]]),200n*U,UINT256_MAX);
  assert.ok(count);assert.ok(count>1n);
});
