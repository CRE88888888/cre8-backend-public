import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readYieldAccount } from '../src/yield-reader.js';
import { yieldFixture } from './fixtures/yield.js';
import { keccak256,toFunctionSelector } from 'viem';
import { RAY, WAD } from '../src/yield-domain.js';

test('yield Venus reads current APR and non-18 receipt units after same-call accrual',async()=>{
  const f=yieldFixture(['venus']);f.state.rate=2n*WAD;f.state.claim=20n*10n**8n;
  const r=await readYieldAccount(f.client,f.profile,f.account,{batch:f.batch,now:()=>f.at});
  assert.equal(r.positions[0]?.claim,f.state.claim);assert.equal(r.positions[0]?.value,f.state.claim);
  assert.equal(r.positions[0]?.aprBps,577n);assert.equal(r.positions[0]?.receiptDecimals,8);
  assert.equal(r.risks[0]?.exposure,20n);assert.equal(r.risks[0]?.utilizationBps,8000);
  assert.ok(f.state.reads.indexOf('refreshHealth')<f.state.reads.indexOf('balanceOf'));
});
test('yield Aave preserves full ray index and rejects nominal/scaled mismatch',async()=>{
  const f=yieldFixture(['aave_v3']);f.state.rate=RAY+123456789n;f.state.units=10n**30n;f.state.tracked=f.state.units;
  f.state.receipt=f.state.units*f.state.rate/RAY;f.state.claim=f.state.receipt;
  const r=await readYieldAccount(f.client,f.profile,f.account,{batch:f.batch,now:()=>f.at});
  assert.equal(r.positions[0]?.rate,f.state.rate);assert.equal(r.positions[0]?.scale,RAY);assert.equal(r.positions[0]?.observedUnits,f.state.units);
  f.state.receipt++;const bad=await readYieldAccount(f.client,f.profile,f.account,{batch:f.batch,now:()=>f.at});
  assert.equal(bad.positions[0]?.state,'unknown');assert.equal(bad.positions[0]?.value,null);
});
test('yield Lista de-duplicates supply/withdraw queues; shared group liquidity is a minimum, never a sum',async()=>{
  const f=yieldFixture(['lista','lista']);
  const r=await readYieldAccount(f.client,f.profile,f.account,{batch:f.batch,now:()=>f.at});
  assert.equal(r.risks.length,2);assert.equal(r.risks[0]?.liquidity,100_000n*WAD);assert.equal(r.risks[1]?.liquidity,r.risks[0]?.liquidity);
});
test('yield unavailable/paused/zero rates do not masquerade as zero claim or zero utilization',async()=>{
  const f=yieldFixture(['venus']);f.state.fail='receiptAssets';
  const r=await readYieldAccount(f.client,f.profile,f.account,{batch:f.batch,now:()=>f.at});
  assert.equal(r.positions[0]?.value,null);assert.equal(r.risks[0]?.utilizationBps,null);
  f.state.fail='';f.state.rate=0n;
  assert.equal((await readYieldAccount(f.client,f.profile,f.account,{batch:f.batch,now:()=>f.at})).positions[0]?.state,'unknown');
});
test('yield rejects stale/future/wrong-chain RPC; timeout errors contain no upstream credential',async()=>{
  const f=yieldFixture(['venus']);
  for(const now of [new Date(+f.at+60001),new Date(+f.at-1)])await assert.rejects(readYieldAccount(f.client,f.profile,f.account,{batch:f.batch,now:()=>now}));
  f.state.chainId=56;await assert.rejects(readYieldAccount(f.client,f.profile,f.account,{batch:f.batch,now:()=>f.at}));f.state.chainId=97;
  await assert.rejects(readYieldAccount(f.client,f.profile,f.account,{batch:()=>new Promise(()=>{}),timeoutMs:5,now:()=>f.at}),e=>e instanceof Error&&!e.message.includes('SECRET'));
});

test('contracts eafc1a6 has no cross-transaction reservation ABI; only explicit DB R remains',async()=>{
  const f=yieldFixture(['venus']);
  const r=await readYieldAccount(f.client,f.profile,f.account,{batch:f.batch,now:()=>f.at});
  assert.equal(r.positions[0]?.state,'known');assert.equal(r.risks[0]?.externalReserved,0n);
  assert.equal(f.state.reads.includes('totalReserved'),false);
});

test('supply pause/health failure cannot zero a known claim or block independently proven withdrawal liquidity',async()=>{
  const f=yieldFixture(['venus']);f.state.paused=true;
  const read=await readYieldAccount(f.client,f.profile,f.account,{batch:f.batch,now:()=>f.at});
  assert.equal(read.positions[0]?.state,'known');assert.ok((read.positions[0]?.maxRedeem??0n)>0n);assert.equal(read.risks[0]?.state,'unknown');
  f.state.withdrawPaused=true;
  const paused=await readYieldAccount(f.client,f.profile,f.account,{batch:f.batch,now:()=>f.at});
  assert.equal(paused.positions[0]?.claim,f.state.claim);assert.equal(paused.positions[0]?.maxRedeem,0n);assert.equal(paused.positions[0]?.withdrawPaused,true);
});

test('canonical block changes and RPC credential errors never become a priced snapshot or escape to logs',async()=>{
  const f=yieldFixture(['venus']);
  f.state.fail='eth_getBlockByNumber';
  await assert.rejects(readYieldAccount(f.client,f.profile,f.account,{batch:f.batch,now:()=>f.at}),e=>e instanceof Error&&!e.message.includes('SECRET'));
  f.state.fail='';
  await assert.rejects(readYieldAccount(f.client,f.profile,f.account,{now:()=>f.at,batch:async(...args)=>{
    const result=await f.batch(...args);
    if(args[2].some(c=>c.name==='previewAccountValue'))f.state.blockHash=`0x${'ab'.repeat(32)}`;
    return result;
  }}));
});

test('pinned registry code proves reservation capabilities; old chain R is never defaulted to zero',async()=>{
  const f=yieldFixture(['venus']);
  const noR={...f.profile,registryCodeHash:keccak256(f.state.registryCode)};
  const current=await readYieldAccount(f.client,noR,f.account,{batch:f.batch,now:()=>f.at});assert.equal(current.risks[0]?.externalReserved,0n);
  f.state.registryCode=`0x63${toFunctionSelector('totalReserved(bytes32)').slice(2)}6000`;
  const old={...f.profile,registryCodeHash:keccak256(f.state.registryCode)};
  const read=await readYieldAccount(f.client,old,f.account,{batch:f.batch,now:()=>f.at});assert.equal(read.risks[0]?.externalReserved,7n);
  f.state.fail='totalReserved';
  const unknown=await readYieldAccount(f.client,old,f.account,{batch:f.batch,now:()=>f.at});assert.equal(unknown.positions[0]?.state,'unknown');
  await assert.rejects(readYieldAccount(f.client,noR,f.account,{batch:f.batch,now:()=>f.at}));
});
