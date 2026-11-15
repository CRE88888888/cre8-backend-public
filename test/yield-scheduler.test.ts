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
