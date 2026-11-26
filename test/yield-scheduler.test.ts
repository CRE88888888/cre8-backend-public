import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runSchedulerOnce } from '../src/scheduler.js';

test('yield round runs before executor/price/buy/DEX gates and inherits dry-run by default',async()=>{
  for(const dryRun of [undefined,false]){
    const order:string[]=[];
    await runSchedulerOnce({...(dryRun===undefined?{}:{dryRun}),skipAlerts:true},{chainId:1337,
      yieldRound:async args=>{order.push('yield');assert.equal(args.dryRun,dryRun??true);return{checked:1,blocked:0};},
      readGlobalPaused:async()=>{order.push('pause');return true;},priceSourceChecks:async()=>[],
      query:async()=>({rows:[]}),withTransaction:async fn=>fn({query:async()=>({rows:[]})}),log:()=>{}});
    assert.deepEqual(order,['yield','pause']);
  }
});

test('#112 scheduler preserves yield checked and blocked totals in its log',async()=>{
  const logs:string[]=[];
  await runSchedulerOnce({skipAlerts:true},{chainId:1337,yieldRound:async()=>({checked:0,blocked:1}),readGlobalPaused:async()=>true,priceSourceChecks:async()=>[],query:async()=>({rows:[]}),withTransaction:async fn=>fn({query:async()=>({rows:[]})}),log:line=>logs.push(line)});
  assert.ok(logs.some(line=>line.includes('"blocked":1')&&line.includes('"checked":0')));
});

test('#112-r2 zero and invalid limits claim no accounts or persistent cursor',async()=>{
  const {runYieldRound}=await import('../src/yield-service.js'),{yieldFixture}=await import('./fixtures/yield.js');
  const f=yieldFixture(['venus']),previous=process.env.CHAIN_ID;process.env.CHAIN_ID='97';
  try{
    for(const limit of [0,-1,0.5,Number.NaN])assert.deepEqual(await runYieldRound({dryRun:false,limit},{profile:()=>f.profile,query:async()=>{throw new Error('unexpected DB');},transaction:async()=>{throw new Error('unexpected state claim');}}),{checked:0,blocked:0});
  }finally{if(previous===undefined)delete process.env.CHAIN_ID;else process.env.CHAIN_ID=previous;}
});
