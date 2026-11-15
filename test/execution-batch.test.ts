import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertUserOpCapacity, boundedCallGasLimit, estimatedBatchGas, executionBatchSize, executionGroups, executionInputGroups, MAX_USER_OP_GAS, userOpGasOverhead } from '../src/execution-batch.js';
import { loadTradingConfig } from '../src/config.js';

test('#92 batch size is <=16, shrinks with held assets and never authorizes over 14M', () => {
  assert.equal(executionBatchSize(0),16);
  assert.equal(executionBatchSize(92,false),16);
  assert.ok(executionBatchSize(80)<16);
  assert.ok(executionBatchSize(92)<executionBatchSize(80));
  for(let held=0;held<=200;held++){
    const n=executionBatchSize(held);
    if(n>0)assert.ok(estimatedBatchGas(n,held)<=MAX_USER_OP_GAS);
    if(n<16)assert.ok(estimatedBatchGas(n+1,held)>MAX_USER_OP_GAS);
  }
  for(const n of [-1,0.5,NaN,Infinity])assert.throws(()=>executionBatchSize(n));
  assert.doesNotThrow(()=>assertUserOpCapacity(16,MAX_USER_OP_GAS));
  assert.throws(()=>assertUserOpCapacity(16,MAX_USER_OP_GAS+1n));
  for(const n of [0,17,-1,0.5,NaN])assert.throws(()=>assertUserOpCapacity(n,1n));
  assert.throws(()=>assertUserOpCapacity(1,-1n));
});
test('#92 balanced groups preserve order, every entry and no short one-asset tail',()=>{
  for(const count of [0,1,15,16,17,92,129])for(const limit of [1,9,16]){
    const input=Array.from({length:count},(_,i)=>i);
    const groups=executionGroups(input,limit);
    assert.deepEqual(groups.flat(),input);
    assert.ok(groups.every(g=>g.length>0&&g.length<=limit));
    if(groups.length>0)assert.ok(Math.max(...groups.map(g=>g.length))-Math.min(...groups.map(g=>g.length))<=1);
  }
  for(const n of [0,17,-1,0.5,NaN])assert.throws(()=>executionGroups([],n));
});
test('#92 chain-specific default daily budgets preserve overrides, zero and mainnet USD policy',()=>{
  assert.equal(loadTradingConfig({},97).dailyGas,100_000_000n);
  assert.equal(loadTradingConfig({},97).dailyUsdE8,null);
  for(const chain of [56,1337]){
    assert.equal(loadTradingConfig({},chain).dailyGas,10_000_000n);
    assert.equal(loadTradingConfig({},chain).dailyUsdE8,30_000_000n);
  }
  for(const cap of ['0','1','99999999'])assert.equal(loadTradingConfig({ACCOUNT_DAILY_GAS:cap},97).dailyGas,BigInt(cap));
});

test('#92 budget groups conserve every raw input, split whales and reject dust and sub-50 tails',()=>{
  const U=10n**18n,R=27n*U/100n;
  for(const size of [1,16,17,32,93])for(const limit of [1,9,16]){
    const inputs=Object.fromEntries(Array.from({length:size},(_,i)=>[String(i),(100n*U).toString()]));
    const before={...inputs};const children=executionInputGroups(inputs,limit,R);assert.ok(children);
    assert.ok(children.every(c=>Object.keys(c).length<=limit));
    const sums:Record<string,bigint>={};
    for(const c of children){
      assert.ok(Object.values(c).every(raw=>BigInt(raw)>=U));
      assert.ok(Object.values(c).reduce((n,raw)=>n+BigInt(raw),R)>=50n*U);
      for(const [a,raw] of Object.entries(c))sums[a]=(sums[a]??0n)+BigInt(raw);
    }
    assert.deepEqual(Object.fromEntries(Object.entries(sums).map(([a,n])=>[a,n.toString()])),inputs);assert.deepEqual(inputs,before);
  }
  const uneven=Object.fromEntries(Array.from({length:17},(_,i)=>[String(i),((i===16?968n:2n)*U).toString()]));
  const children=executionInputGroups(uneven,16,R);assert.ok(children);assert.equal(children.length,2);
  assert.ok(children.every(c=>'16' in c));
  assert.equal(executionInputGroups({a:(50n*U-R).toString()},16,R)?.length,1);
  assert.equal(executionInputGroups({a:(50n*U-R-1n).toString()},16,R),null);
  assert.equal(executionInputGroups({a:(U-1n).toString(),b:(100n*U).toString()},16,R),null);
  assert.equal(executionInputGroups({},16,R),null);
  assert.throws(()=>executionInputGroups({},0,R));assert.throws(()=>executionInputGroups({},16,-1n));
});

test('#92 two large positions can each fund a nine-step batch at the exact 50-USDT threshold',()=>{
  const U=10n**18n,R=27n*U/100n;
  const inputs=Object.fromEntries(Array.from({length:18},(_,i)=>[String(i),((i<16?2n:34n)*U*9946n/10000n).toString()]));
  const groups=executionInputGroups(inputs,9,R);assert.ok(groups);assert.equal(groups.length,2);
  for(const group of groups){
    assert.equal(Object.keys(group).length,9);
    assert.equal(Object.values(group).reduce((sum,raw)=>sum+BigInt(raw),R),50n*U);
    assert.ok(Object.values(group).every(raw=>BigInt(raw)>=U));
  }
  assert.deepEqual(Object.fromEntries(groups.flatMap(group=>Object.entries(group)).sort(([a],[b])=>a.localeCompare(b))),Object.fromEntries(Object.entries(inputs).sort(([a],[b])=>a.localeCompare(b))));
});

test('#92 testnet call-gas headroom fits 14M but never goes below the raw estimate, including exact capacity and failures',()=>{
  const overhead=500_000n,available=MAX_USER_OP_GAS-overhead-50_000n;
  assert.equal(boundedCallGasLimit(9_000_000n,6_000_000n,overhead),9_000_000n);
  const estimated=BigInt('0x977566'); // Actual fourth 93-asset batch bundler response.
  assert.equal(boundedCallGasLimit(estimated*3n/2n,estimated,overhead),available);
  assert.equal(boundedCallGasLimit(available,available,overhead),available);
  assert.throws(()=>boundedCallGasLimit(available+1n,available+1n,overhead),/USER_OP_CAPACITY/);
  assert.equal(boundedCallGasLimit(0n,0n,0n),0n);
  for(const [desired,estimated,other] of [[-1n,0n,0n],[1n,-1n,0n],[1n,0n,-1n],[1n,2n,0n]] as const)assert.throws(()=>boundedCallGasLimit(desired,estimated,other));
  assert.throws(()=>boundedCallGasLimit(1n,1n,MAX_USER_OP_GAS),/USER_OP_CAPACITY/);
});

test('#92 capacity includes the sponsor signed limits when simulation reports lower paymaster usage',()=>{
  const estimate={verificationGasLimit:183084n,preVerificationGas:141191n,paymasterVerificationGasLimit:30741n,paymasterPostOpGasLimit:1n};
  const sponsor={paymasterVerificationGasLimit:100000n,paymasterPostOpGasLimit:0n};
  const overhead=userOpGasOverhead(estimate,sponsor);assert.equal(overhead,424276n);
  const rawCall=BigInt('0x90fa02'),bounded=boundedCallGasLimit(rawCall*3n/2n,rawCall,overhead);
  assert.ok(bounded>=rawCall);
  assertUserOpCapacity(15,bounded+estimate.verificationGasLimit+estimate.preVerificationGas+sponsor.paymasterVerificationGasLimit+sponsor.paymasterPostOpGasLimit);
  assert.equal(userOpGasOverhead({verificationGasLimit:0n,preVerificationGas:0n}),0n);
  assert.equal(userOpGasOverhead(estimate),355017n);
  assert.equal(userOpGasOverhead(estimate,{paymasterVerificationGasLimit:1n,paymasterPostOpGasLimit:10n}),355026n);
  for(const field of ['verificationGasLimit','preVerificationGas','paymasterVerificationGasLimit','paymasterPostOpGasLimit']){
    assert.throws(()=>userOpGasOverhead({...estimate,[field]:-1n}));
  }
  assert.throws(()=>userOpGasOverhead(estimate,{paymasterVerificationGasLimit:-1n}));
});
