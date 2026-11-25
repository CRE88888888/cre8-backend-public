import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {after,test} from 'node:test';
import type {Address,Hex,PublicClient} from 'viem';
import {query,withTransaction,withPortfolioLock,migrate,closePool,getPool,MIGRATIONS_DIR} from '../src/db.js';
import {canonicalConfigHash,UINT256_MAX,validateAssetConfig} from '../src/strategy-execution.js';
import type {AssetMode,AssetExecution} from '../src/strategy-execution.js';
import {planContribution} from '../src/asset-plan.js';
import {prepareStrategyJob,fundingLots,readJob,settleStrategyBatch} from '../src/strategy-jobs.js';
import type {JobContext,StrategyJob} from '../src/strategy-jobs.js';
import {USDT_UNIT as U,sumInputs} from '../src/new-money-plan.js';
import {runSchedulerOnce,planHashFor} from '../src/scheduler.js';
import type {SchedulerDeps,WithTransactionFn,ExecuteArgs,ExecutionOutcome,SchedulerQueryFn} from '../src/scheduler.js';
import {singlePortfolioClaim} from '../src/operator.js';
import {requireTypedVersion} from '../src/strategies.js';
import type {Allocation} from '../src/strategies.js';
import type {PortfolioPlan} from '../src/snapshot.js';
import {TWAP_PRICE_SOURCE} from '../src/positions.js';
import {TESTNET_97} from '../src/testnet-profile.js';
import {withDexLock,assertDexLock,createDexGate} from '../src/dex-queue.js';
import {withdrawableCash} from '../src/withdrawable-cash.js';
import {checkTradeMinimums} from '../src/rebalance-plan.js';
import {runPausedCashRound,resetPausedCashMemory,PAUSED_CASH_RECONCILES_PER_ROUND} from '../src/paused-cash.js';
import type {PausedCashDeps} from '../src/paused-cash.js';
const address=():Address=>`0x${randomBytes(20).toString('hex')}`;
const hash=():Hex=>`0x${randomBytes(32).toString('hex')}`;
const cash=TESTNET_97.contracts.usdt,a=TESTNET_97.assets.WBNB.token,b=TESTNET_97.assets.ETH.token;
const R=27n*U/100n,start=new Date('2026-11-15T13:00:00Z');
const run:WithTransactionFn=fn=>withTransaction(client=>fn({query:(s,p)=>client.query(s,p===undefined?[]:[...p])}));
async function fixture(kind:'hold'|'stack'='hold',cashWeight=0,slices=4,rebalance:AssetExecution['rebalance']='none',otherMode?:AssetMode,weights?:readonly number[],assetCount=2,version=1){
  await migrate();
  const owner=address(),account=address();
  const sid=(await query<{id:string}>("insert into strategies(provider,name) values($1,'be83-isolated') returning id",[owner])).rows[0]?.id;assert.ok(sid);
  const strategyId=Number(sid);
  await query('update strategies set onchain_id=$2 where id=$1',[sid,strategyId+99000000]);
  const allocation:Allocation={assets:cashWeight===10000?[{address:cash,weightBps:10000}]:[
    {address:cash,weightBps:cashWeight},{address:a,weightBps:weights?.[0]??(10000-cashWeight)/2},{address:b,weightBps:weights?.[1]??(10000-cashWeight)/2}]};
  if(assetCount!==2){
    const tokens=Object.values(TESTNET_97.assets).slice(0,assetCount);
    assert.equal(tokens.length,assetCount);
    const base=Math.floor(10000/assetCount);
    allocation.assets=[{address:cash,weightBps:0},...tokens.map((t,i)=>({address:t.token,weightBps:weights?.[i]??base+(i<10000-base*assetCount?1:0)}))];
  }
  const activeAt=new Date('2026-11-14T00:00:00Z');
  const execution=validateAssetConfig({kind:'per_asset',numeraire:cash,rebalance,assets:allocation.assets.map(x=>({asset:x.address,weightBps:x.weightBps,yield:null,...(x.address===cash?{}:{execution:x.address===b&&otherMode?otherMode:kind==='hold'?{kind:'hold'}:{kind:'stack',every:'daily',weekday:null,timeUtc:'13:00',slices}})}))},allocation,97);
  const configHash=canonicalConfigHash({chainId:97,allocation,execution,schedule:{kind:'funding'},activeAt});
  await query(`insert into strategy_versions(strategy_id,version,allocation,schedule,active_at,execution_schema_version,execution,execution_chain_id,config_hash)
    values($1,$6,$2,'{"kind":"funding"}',$3,2,$4,97,$5)`,[sid,JSON.stringify(allocation),activeAt,JSON.stringify(execution),configHash,version]);
  const pid=(await query<{id:string}>("insert into portfolios(user_id,strategy_id,version,schedule_state) values($1,$2,$3,'active') returning id",[owner,sid,version])).rows[0]?.id;assert.ok(pid);
  const id=Number(pid);
  await query("insert into smart_accounts(portfolio_id,chain_id,address,owner,account_type) values($1,97,$2,$3,'KERNEL')",[pid,account,owner]);
  await query('insert into strategy_cash_balances(chain_id,portfolio_id,account) values(97,$1,$2)',[id,account]);
  await query(`insert into session_keys(portfolio_id,key_ref,permissions,status,expires_at)
    values($1,$2,$3,'active','2030-01-01')`,[id,`m/44'/60'/0'/0/${id}`,JSON.stringify({permissionId:'0x12345678',sessionKeyAddress:owner,timestamp:{validUntil:1893456000}})]);
  const context:JobContext={chainId:97,portfolioId:id,strategyId,version,kind:'asset',execution,account,allocation,cash,now:new Date(start),reserve:R,
    caps:new Map(allocation.assets.filter(x=>x.address!==cash).map(x=>[x.address,null])),buyLimit:UINT256_MAX,observedCash:1000000n*U,enabled:true,marketOpen:true};
  async function fund(amount:bigint,confirmedAt=new Date(start.getTime()-60000),effectiveOverride?:Record<string,number>,allocationOverride?:{weights:Record<string,number>;capped:string[]},minimum=50n*U){
    const certificate=effectiveOverride?{minimum,effectiveSlices:effectiveOverride}:planContribution(amount,execution,confirmedAt,R);assert.ok(certificate,'fixture contribution must meet the actual calendar minimum');
    return withTransaction(async client=>{
      const lot=(await client.query<{id:string}>(`insert into strategy_funding_lots(chain_id,portfolio_id,strategy_id,version,kind,tx_hash,log_index,block_number,block_hash,amount_raw,minimum_contribution_raw,effective_slices,created_at,updated_at,effective_allocation,allocation_reason,capped_assets)
        values(97,$1,$2,$9,'asset',$3,0,10,$4,$5,$6,$7,$8,$8,$10,$11,$12) returning id`,[id,sid,hash(),hash(),amount.toString(),certificate.minimum.toString(),JSON.stringify(certificate.effectiveSlices),confirmedAt,version,
          allocationOverride?JSON.stringify(allocationOverride.weights):null,allocationOverride?'exposure_cap':'version',JSON.stringify(allocationOverride?.capped??[])])).rows[0];assert.ok(lot);
      const amounts=(await client.query<{asset:string;budget_raw:string}>('select asset,budget_raw::text from strategy_lot_assets where lot_id=$1',[lot.id])).rows;
      let hold=0n,stack=0n,cashTotal=0n;
      for(const row of amounts)if(row.asset===cash)cashTotal+=BigInt(row.budget_raw);else if(execution.assets.find(asset=>asset.asset===row.asset)?.execution?.kind==='hold')hold+=BigInt(row.budget_raw);else stack+=BigInt(row.budget_raw);
      assert.equal(hold+stack+cashTotal,amount);
      await client.query(`update strategy_cash_balances set unallocated_hold_raw=unallocated_hold_raw+$2::numeric,stack_prefund_raw=stack_prefund_raw+$3::numeric,allocated_cash_raw=allocated_cash_raw+$4::numeric where portfolio_id=$1`,[id,hold.toString(),stack.toString(),cashTotal.toString()]);
      return lot.id;
    });
  }
  async function reserve(c:JobContext=context){const lots=await fundingLots(query,c);return withPortfolioLock(id,()=>prepareStrategyJob(run,c,lots));}
  return {id,owner,account,strategyId,allocation,execution,context,fund,reserve};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function balances(f:Fixture){return (await query<{unallocated_hold_raw:string;stack_prefund_raw:string;allocated_cash_raw:string;reserved_input_raw:string;reserved_fee_raw:string}>(
  'select unallocated_hold_raw::text,stack_prefund_raw::text,allocated_cash_raw::text,reserved_input_raw::text,reserved_fee_raw::text from strategy_cash_balances where portfolio_id=$1',[f.id])).rows[0];}
async function job(f:Fixture){return readJob(query,f.context);}
async function complete(f:Fixture,j:StrategyJob,input=j.remaining_input,feePaid=0n,settlementRun=run){
  const userOpHash=hash(),txHash=hash();
  const op=await withTransaction(async client=>{
    const index=Number((await client.query<{n:number}>('select coalesce(max(batch_index)+1,0) as n from strategy_job_batches where job_id=$1',[j.id])).rows[0]?.n);
    await client.query("update strategy_jobs set state='running',asset_started_at=coalesce(asset_started_at,slot_at),updated_at=clock_timestamp() where id=$1",[j.id]);
    await client.query('insert into strategy_job_batches(job_id,batch_index,input_raw) values($1,$2,$3)',[j.id,index,JSON.stringify(input)]);
    const row=(await client.query<{id:string}>(`insert into operations(portfolio_id,type,state,idempotency_key,payload_hash,deadline,user_op_nonce,strategy_job_id,strategy_batch_index)
      values($1,'rebalance','pending',$2,$3,'2030-01-01',0,$4,$5) returning id`,[f.id,hash(),hash(),j.id,index])).rows[0];assert.ok(row);
    await client.query("update operations set state='submitted',user_op_hash=$2,tx_hash=$3 where id=$1",[row.id,userOpHash,txHash]);return row.id;
  });
  await settleStrategyBatch(settlementRun,f.context,op,{received:Object.fromEntries(Object.keys(input).map(a=>[a,'100'])),fees:{},feePaid,blockNumber:11n,blockHash:hash()});
}
test('#160 DB an exposure cap reached between installments never retargets old sources, while new source weights remain fixed across restart',async()=>{
  const f=await fixture('stack',0,4);
  const old=await f.fund(100n*U);
  const oldSources=(await query('select * from strategy_lot_assets where lot_id=$1 order by asset',[old])).rows;
  const first=(await f.reserve())?.job;assert.ok(first);assert.deepEqual(Object.keys(first.remaining_input).sort(),[a,b].sort());
  await complete(f,first,first.remaining_input,R);
  // At the next admission A is full; 0052 only changes this new lot's sources.
  const fresh=await f.fund(100n*U,new Date(+start+60000),{[b]:4},{weights:{[b]:10000},capped:[a]});
  assert.equal((await query('select asset from strategy_lot_assets where lot_id=$1 and asset=$2',[fresh,a])).rows.length,0);
  for(let day=1;day<4;day++){
    const result=(await f.reserve({...f.context,now:new Date(+start+day*86400000)}))?.job;assert.ok(result);
    assert.ok(BigInt(result.remaining_input[a]??'0')>0n,'old A installment still buys under the soft cap');
    assert.ok(BigInt(result.remaining_input[b]??'0')>BigInt(result.remaining_input[a]??'0'),'new money goes only to B');
    assert.equal((await f.reserve({...f.context,now:new Date(+start+day*86400000)}))?.job?.id,result.id,'restart resumes the same immutable job');
    await complete(f,result,result.remaining_input,R);
  }
  const oldAfter=(await query('select * from strategy_lot_assets where lot_id=$1 order by asset',[old])).rows;
  assert.deepEqual(oldAfter.map(({state,updated_at,...rest})=>rest),oldSources.map(({state,updated_at,...rest})=>rest));
  assert.equal((await query('select effective_allocation from strategy_funding_lots where id=$1',[old])).rows[0]?.effective_allocation,null);
  assert.deepEqual((await query('select effective_allocation from strategy_funding_lots where id=$1',[fresh])).rows[0]?.effective_allocation,{[b]:10000});
});
test('#160 DB redistributed small installments carry below one USDT, merge later, and reconcile the exact effective source budget',async()=>{
  const f=await fixture('stack',0,4,'none',undefined,[5000,4900,100],3);
  const risky=f.allocation.assets.filter(x=>x.address!==cash);const excluded=risky[0],large=risky[1],small=risky[2];assert.ok(excluded&&large&&small);
  const lot=await f.fund(100n*U,new Date(+start-60000),{[large.address]:4,[small.address]:4},
    {weights:{[large.address]:9800,[small.address]:200},capped:[excluded.address]});
  for(let day=0;day<4;day++){
    const result=(await f.reserve({...f.context,now:new Date(+start+day*86400000)}))?.job;assert.ok(result);
    assert.ok(!Object.hasOwn(result.original_input,excluded.address));
    const smallSlice: {state:string;budget_raw:string}|undefined=(await query<{state:string;budget_raw:string}>('select state,budget_raw::text from strategy_asset_slices where lot_id=$1 and asset=$2 and slice_index=$3',[lot,small.address,day])).rows[0];assert.ok(smallSlice);
    assert.equal(smallSlice.state,day<2?'deferred_min_asset':'reserved');
    assert.equal(Object.hasOwn(result.original_input,small.address),day>=2);
    await complete(f,result,result.remaining_input,R);
  }
  const audited=(await query(`select sum(amount_raw+fee_reserve_raw)::text as spent from strategy_asset_slices
    where lot_id=$1 and asset=$2 and state='completed'`,[lot,small.address])).rows[0];
  assert.equal(audited?.spent,(2n*U).toString());
});
test('#100 DB 100-USDT capacity split spends one reserve, resumes at zero reserve and never rebuys released cash',async()=>{
  const f=await fixture();await f.fund(100n*U);const s=scheduler(f);assert.ok(s.deps.newMoney);
  s.deps.newMoney.policy=async()=>({reserve:s.sends.length===0?R:0n,caps:new Map([[a,25n*U],[b,25n*U]]),buyLimit:50n*U,cash:10000n*U});
  const reconcile=s.deps.reconcileRebalance;assert.ok(reconcile);
  s.deps.reconcileRebalance=async input=>{const result=await reconcile(input);if(result.kind==='found'&&result.outcome.batchEvidence)result.outcome.batchEvidence.feePaid=s.sends.length===1?R-1n:0n;return result;};
  assert.equal((await s.once()).results[0]?.outcome,'executed');
  const first=await job(f);assert.ok(first);assert.equal(first.fee_reserve_raw,R.toString());
  assert.equal(sumInputs(first.remaining_input),50n*U-R/2n);assert.equal(first.remaining_fee_raw,'1');
  assert.equal((await s.once(new Date(start.getTime()+60000))).results[0]?.outcome,'executed');
  assert.equal(await job(f),null);const saved=await balances(f);assert.equal(saved?.reserved_fee_raw,'0');assert.equal(saved?.allocated_cash_raw,'1');
  assert.equal((await s.once(new Date(start.getTime()+120000))).results[0]?.outcome,'noop');assert.equal(s.sends.length,2);
});
test('#118 DB scheduler executes 100 over ten daily ten-USDT windows and preserves every source budget',async()=>{
  const f=await fixture('stack',0,12);await f.fund(100n*U);const s=scheduler(f);
  for(let index=0;index<10;index++){
    assert.equal((await s.once(new Date(+start+index*86400000))).results[0]?.outcome,'executed');
    const send=s.sends.at(-1);assert.ok(send);assert.equal(sumInputs(Object.fromEntries(send.steps.map(step=>[step.tokenOut,step.amountIn.toString()])))+R,10n*U);
  }
  assert.equal(s.sends.length,10);assert.equal(await job(f),null);
  assert.equal((await balances(f))?.stack_prefund_raw,'0');assert.equal((await balances(f))?.reserved_input_raw,'0');
  assert.equal((await s.once(new Date(+start+10*86400000))).results[0]?.outcome,'noop');assert.equal(s.sends.length,10);
});
test('#100 DB fee release rolls back atomically and duplicate confirmation releases only once',async()=>{
  const f=await fixture();await f.fund(200n*U);
  const initial=(await f.reserve({...f.context,reserve:2n*R,caps:new Map([[a,50n*U],[b,50n*U]])}))?.job;assert.ok(initial);
  assert.equal(initial.fee_reserve_raw,(2n*R).toString(),'persist the oversized reserve carried by pre-upgrade jobs');
  // The existing settlement contract also covers pre-upgrade over-reservations:
  // remaining_fee_raw is historical reserve minus paid, while active cash is released.
  const before=await balances(f);
  const failed:WithTransactionFn=fn=>run(async client=>fn({query:async(sql,params)=>{
    const result=await client.query(sql,params);
    if(sql.includes('allocated_cash_raw=allocated_cash_raw+$5::numeric'))throw new Error('fee release rollback');
    return result;
  }}));
  await assert.rejects(complete(f,initial,initial.remaining_input,R/2n,failed),/fee release rollback/);
  assert.deepEqual(await balances(f),before);
  const op=(await query<{id:string}>('select id from operations where strategy_job_id=$1',[initial.id])).rows[0];assert.ok(op);
  assert.equal((await query<{state:string}>('select state from operations where id=$1',[op.id])).rows[0]?.state,'submitted');
  const evidence={received:Object.fromEntries(Object.keys(initial.remaining_input).map(a=>[a,'100'])),fees:{},feePaid:R/2n,blockNumber:11n,blockHash:hash()};
  await settleStrategyBatch(run,f.context,op.id,evidence);
  const saved=await balances(f);assert.equal(saved?.allocated_cash_raw,(BigInt(initial.fee_reserve_raw)-R/2n).toString());
  await settleStrategyBatch(run,f.context,op.id,evidence);
  assert.deepEqual(await balances(f),saved);assert.equal((await f.reserve())?.job,null);
});
test('#83 DB V3 hold combines same-time lots once and allocates 50% cash only once',async()=>{
  const f=await fixture('hold',5000);await f.fund(100n*U);await f.fund(120n*U);
  const first=(await f.reserve())?.job;assert.ok(first);assert.equal(BigInt(first.amount_raw)+BigInt(first.fee_reserve_raw),110n*U);
  assert.equal((await query('select distinct lot_id from strategy_asset_slices where job_id=$1',[first.id])).rows.length,2);
  assert.equal((await f.reserve())?.job?.id,first.id);
  await complete(f,first,first.remaining_input,R-2n*U/100n);
  assert.equal(await job(f),null);assert.equal((await f.reserve())?.job,null);
  const saved=await balances(f);assert.equal(saved?.reserved_input_raw,'0');assert.equal(saved?.reserved_fee_raw,'0');
  assert.equal(BigInt(saved?.allocated_cash_raw??'0'),110n*U+2n*U/100n);
  await f.fund(120n*U,new Date(start.getTime()+60000));assert.notEqual((await f.reserve({...f.context,now:new Date(start.getTime()+120000)}))?.job?.id,first.id);
});
test('#83 DB cash-only hold consumes no fee and sends no operation, including multiple contributions',async()=>{
  const f=await fixture('hold',10000);await f.fund(50n*U);await f.fund(70n*U);
  assert.equal((await f.reserve())?.job,null);assert.equal((await balances(f))?.allocated_cash_raw,(120n*U).toString());
  assert.equal((await query('select id from operations where portfolio_id=$1',[f.id])).rows.length,0);
  assert.ok((await query<{state:string}>('select a.state from strategy_lot_assets a join strategy_funding_lots l on l.id=a.lot_id where l.portfolio_id=$1',[f.id])).rows.every(a=>a.state==='completed'));
});
test('#83 DB V4 insufficient current slot is skipped permanently; top-up buys only next period',async()=>{
  const f=await fixture('stack');await f.fund(200n*U);
  assert.equal((await f.reserve({...f.context,observedCash:0n}))?.job,null);
  const states=(await query<{state:string}>('select s.state from strategy_asset_slices s join strategy_funding_lots l on l.id=s.lot_id where l.portfolio_id=$1',[f.id])).rows.map(s=>s.state);
  assert.ok(states.every(s=>s==='skipped_insufficient_funds'));
  const next=(await f.reserve({...f.context,now:new Date(start.getTime()+86400000)}))?.job;assert.ok(next);
  assert.equal(BigInt(next.amount_raw)+BigInt(next.fee_reserve_raw),50n*U);
  const firstIndex=(await query<{slice_index:number}>('select slice_index from strategy_asset_slices where job_id=$1',[next.id])).rows;assert.ok(firstIndex.every(s=>s.slice_index===1));
});
test('#83 DB V4 400 total with 50% cash makes four 50-budget allocations, never recycles cash',async()=>{
  const f=await fixture('stack',5000);await f.fund(400n*U);
  for(let n=0;n<4;n++){const j=(await f.reserve({...f.context,now:new Date(start.getTime()+n*86400000)}))?.job;assert.ok(j);assert.equal(BigInt(j.amount_raw)+BigInt(j.fee_reserve_raw),50n*U);await complete(f,j,j.remaining_input,R);}
  assert.equal((await balances(f))?.allocated_cash_raw,(200n*U).toString());
  assert.equal((await f.reserve({...f.context,now:new Date(start.getTime()+4*86400000)}))?.job,null);
  assert.equal((await balances(f))?.stack_prefund_raw,'0');
});
test('#83 DB long downtime records every finite missed slice; exclusive end creates no extra slot',async()=>{
  const f=await fixture('stack',0,52);await f.fund(2600n*U);
  assert.equal((await f.reserve({...f.context,now:new Date(start.getTime()+5000*86400000)}))?.job,null);
  const rows=(await query<{slice_index:number;state:string}>('select s.slice_index,s.state from strategy_asset_slices s join strategy_funding_lots l on l.id=s.lot_id where l.portfolio_id=$1 order by s.asset,s.slice_index',[f.id])).rows;
  assert.equal(rows.length,104);assert.ok(rows.every(r=>r.state==='skipped_window'));assert.equal(Math.max(...rows.map(r=>r.slice_index)),51);
  assert.equal((await query('select id from operations where portfolio_id=$1',[f.id])).rows.length,0);
});
test('#118 DB daily 365 executes first/middle/final remainder and bounds skipped windows at 365 per asset',async()=>{
  const f=await fixture('stack',0,365),amount=3650n*U+12345n;
  const lot=await f.fund(amount),perAsset=amount/2n,base=perAsset/365n;
  for(const index of [0,182,364]){
    const current=(await f.reserve({...f.context,now:new Date(+start+index*86400000)}))?.job;assert.ok(current);
    assert.equal(sumInputs(current.original_input)+BigInt(current.fee_reserve_raw),2n*(index===364?perAsset-base*364n:base));
    const slices=(await query<{slice_index:number}>('select slice_index from strategy_asset_slices where job_id=$1',[current.id])).rows;
    assert.deepEqual(slices.map(s=>s.slice_index),[index,index]);
    await complete(f,current,current.remaining_input,R);
  }
  assert.equal((await f.reserve({...f.context,now:new Date(+start+5000*86400000)}))?.job,null);
  const slices=(await query<{slice_index:number;state:string}>('select slice_index,state from strategy_asset_slices where lot_id=$1',[lot])).rows;
  assert.equal(slices.length,730);assert.equal(slices.filter(s=>s.state==='skipped_window').length,724);
  assert.equal(Math.max(...slices.map(s=>s.slice_index)),364);
  assert.equal((await query('select id from operations where portfolio_id=$1',[f.id])).rows.length,3);
  const untouched=await fixture('stack',0,365);await untouched.fund(3650n*U);
  await untouched.reserve({...untouched.context,now:new Date(+start+5000*86400000)});
  assert.equal((await query('select s.slice_index from strategy_asset_slices s join strategy_funding_lots l on l.id=s.lot_id where l.portfolio_id=$1',[untouched.id])).rows.length,730);
});
test('#83 DB two workers reserve one business key; lost commit response never reserves twice',async()=>{
  const f=await fixture();await f.fund(200n*U);const lots=await fundingLots(query,f.context);
  const results=await Promise.all([prepareStrategyJob(run,f.context,lots),prepareStrategyJob(run,f.context,lots)]);
  assert.ok(results[0]?.job);assert.equal(results[0]?.job?.id,results[1]?.job?.id);
  const lost:WithTransactionFn=async fn=>{await run(fn);throw new Error('unknown commit response');};
  const next=await fixture();await next.fund(200n*U);const source=await fundingLots(query,next.context);
  await assert.rejects(prepareStrategyJob(lost,next.context,source));
  assert.equal((await prepareStrategyJob(run,next.context,source)).job?.amount_raw,(200n*U-R).toString());
  assert.equal((await balances(next))?.unallocated_hold_raw,'0');
});
test('#83 DB cash shortfall, reorg and DB failure cannot authorize new money',async()=>{
  const f=await fixture();await f.fund(100n*U);
  assert.equal((await f.reserve({...f.context,observedCash:100n*U-1n}))?.job,null);
  const source=await fundingLots(query,f.context);
  await assert.rejects(prepareStrategyJob(async()=>{throw new Error('DB unavailable');},f.context,source));
  await query("update strategy_funding_lots set state='reorged',updated_at=clock_timestamp() where portfolio_id=$1",[f.id]);
  assert.match((await f.reserve())?.reason??'',/REORGED/);assert.equal(await job(f),null);
});
test('#83 DB stopped stack releases unsent reserves; configured cash remains allocated',async()=>{
  const f=await fixture('stack',5000);await f.fund(400n*U);
  const result=(await f.reserve())?.job;assert.ok(result);
  await query("update portfolios set schedule_state='paused' where id=$1",[f.id]);
  assert.equal((await f.reserve({...f.context,enabled:false}))?.job,null);assert.equal((await balances(f))?.allocated_cash_raw,(200n*U).toString());
  assert.equal((await balances(f))?.stack_prefund_raw,(200n*U).toString());
  assert.equal((await balances(f))?.reserved_input_raw,'0');assert.equal((await balances(f))?.reserved_fee_raw,'0');
});
function plan(f:Fixture):PortfolioPlan{return {portfolioId:f.id,strategyId:f.strategyId,account:f.account,chainId:97,
  snapshot:{portfolioId:f.id,block:20n,nativeBalanceWei:U,holdings:[{asset:cash,amountWei:10000n*U,decimals:18,usdPriceE8:100000000n,priceSource:TWAP_PRICE_SOURCE}],unpriced:[]},
  scan:{portfolioId:f.id,block:20n,cursor:{portfolioId:f.id,startBlock:1n,lastScannedBlock:20n},scannedRange:null,candidateCount:0,unknownHoldings:[],zeroBalanceCount:0,unreadableCandidates:[],deployment:{block:1n,reason:'resolved',detail:'test'},universeComplete:true,incompleteReasons:[]},
  report:{totalUsdE8:1000000000000n,assets:[],maxAbsDeltaBps:0,grossDriftBps:0,needsRebalance:false,thresholdBps:100},blocked:[],targets:f.allocation.assets.map(a=>({asset:a.address,weightBps:a.weightBps,symbol:'test'})),
  pinnedVersion:{version:f.context.version,onchainStrategyId:f.strategyId+99000000,paused:false},allocationCheck:{consistent:true,chain:[],mismatches:[]},thresholdBps:100};}
function scheduler(f:Fixture,extra:SchedulerDeps={}){
  const sends:ExecuteArgs[]=[],userHash=hash(),txHash=hash();
  let status:ExecutionOutcome['status']='success',currentTime=start;
  const deps:SchedulerDeps={clock:()=>currentTime,readBuyVersionWindow:async()=>({activeVersion:f.context.version,timestamp:BigInt(Math.floor(currentTime.getTime()/1000)),pendingActiveAt:null}),query,withTransaction:singlePortfolioClaim(f.id),chainId:97,strategyEarnV2:null,executor:TESTNET_97.contracts.executor,
    readGlobalPaused:async()=>false,withPortfolioLock,dexGate:async()=>null,log:()=>{},writeSnapshot:async()=>({headerInserted:true,inserted:0,updated:0}),
    planPortfolio:async()=>plan(f),planRebalance:async()=>{throw new Error('hold/stack must never enter drift planner');},
    readPermissionConfig:async()=>({signer:f.owner,policyCount:3}),deriveSessionKeyAddress:async()=>f.owner,readAllowance:async()=>UINT256_MAX,readBalance:async()=>UINT256_MAX,
    readRebalanceNonce:async()=>0n,checkTradingMinimums:async()=>null,hasBoughtBefore:async()=>true,refreshFloors:async i=>({ok:true,steps:[...i.steps],refreshes:[],note:'fresh'}),
    newMoney:{withdrawals:async()=>[],rebalanceReserve:async()=>R,version:(sid,v,onchainId,account,options)=>requireTypedVersion(sid,v,onchainId,account,{...options,verifyChain:false}),
      policy:async()=>({reserve:R,caps:new Map(f.context.caps),buyLimit:UINT256_MAX,cash:10000n*U}),verifyLots:async()=>{},marketOpen:()=>true,feeDue:async()=>async()=>0n,
      quote:async(_due,_plan,inputs,deadline)=>({kind:'ready',steps:Object.entries(inputs).map(([token,raw])=>({tokenIn:cash,tokenOut:token as Address,amountIn:BigInt(raw),amountOutMin:90n,oracleFloor:80n,venue:TESTNET_97.contracts.universalRouter,data:'0x'})),deadline,rationale:'test exact new money'})},
    executeRebalance:async args=>{await args.beforeSending?.();sends.push(args);args.onSending();await args.onSubmitted({userOpHash:userHash});return {status,userOpHash:userHash,txHash:status==='unknown'?null:txHash,gasUsed:'100',error:status==='success'?null:'receipt timeout'};},
    reconcileRebalance:async input=>({kind:'found',outcome:{status:'success',userOpHash:userHash,txHash,gasUsed:'100',error:null,
      batchEvidence:{received:Object.fromEntries(Object.keys(input.expectedInputs??{}).map(a=>[a,'100'])),fees:{},feePaid:0n,blockNumber:21n,blockHash:hash()}}}),...extra};
  async function once(now=start,dryRun=false){currentTime=now;await query('update portfolios set next_run_at=null where id=$1',[f.id]);return runSchedulerOnce({dryRun,now,skipAlerts:true},deps);}
  return {deps,sends,once,setStatus:(s:ExecutionOutcome['status'])=>{status=s;}};
}
test('#83 scheduler dispatch precedes drift; first plus two additions buy only their lots; dry-run writes nothing',async()=>{
  const f=await fixture();await f.fund(100n*U);const s=scheduler(f);
  await s.once(start,true);assert.equal(await job(f),null);assert.equal(s.sends.length,0);
  assert.equal((await s.once()).results[0]?.outcome,'executed');assert.equal(s.sends.length,1);
  assert.equal((await s.once()).results[0]?.outcome,'noop');
  for(const amount of [120n*U,150n*U]){await f.fund(amount,new Date(start.getTime()+s.sends.length*60000));assert.equal((await s.once(new Date(start.getTime()+(s.sends.length+1)*60000))).results[0]?.outcome,'executed');}
  assert.equal(s.sends.length,3);
  for(const send of s.sends){const total=send.steps.reduce((s,x)=>s+x.amountIn,0n);assert.ok(total<=150n*U);assert.equal(send.gasPurpose,'ordinary');}
});
test('#83 scheduler timeout across period/restart reconciles original batch without a second send',async()=>{
  const f=await fixture('stack');await f.fund(500n*U);const s=scheduler(f);s.setStatus('unknown');
  assert.equal((await s.once()).results[0]?.outcome,'blocked');assert.equal(s.sends.length,1);
  const before=(await query('select * from operations where portfolio_id=$1',[f.id])).rows[0];
  const resumed=scheduler(f,{executeRebalance:async()=>{throw new Error('must reconcile instead of resending');},reconcileRebalance:s.deps.reconcileRebalance});
  assert.equal((await resumed.once(new Date(start.getTime()+86400000))).results[0]?.outcome,'executed');
  const after=(await query('select * from operations where portfolio_id=$1',[f.id])).rows[0];
  assert.equal(after?.payload_hash,before?.payload_hash);assert.equal(after?.user_op_nonce,before?.user_op_nonce);assert.equal(after?.state,'confirmed');
  assert.equal(resumed.sends.length,0);
  const next=await resumed.once(new Date(start.getTime()+86400000+60000));
  assert.equal(next.results[0]?.outcome,'noop','a period crossed while unknown must not buy after late reconciliation');
  const states=(await query<{state:string}>('select s.state from strategy_asset_slices s join strategy_funding_lots l on l.id=s.lot_id where l.portfolio_id=$1 order by s.asset,s.slice_index',[f.id])).rows.map(s=>s.state);
  assert.deepEqual(states,['completed','skipped_previous_inflight','completed','skipped_previous_inflight']);
});
test('#83 scheduler partial batches persist vectors and never exceed A even with refreshed hashes',async()=>{
  const f=await fixture();await f.fund(200n*U);const s=scheduler(f);
  assert.ok(s.deps.newMoney);
  s.deps.newMoney.policy=async()=>({reserve:R,caps:new Map([[a,50n*U],[b,50n*U]]),buyLimit:UINT256_MAX,cash:10000n*U});
  assert.equal((await s.once()).results[0]?.outcome,'executed');const first=await job(f);assert.ok(first);
  const afterFirst=sumInputs(first.remaining_input);assert.ok(afterFirst>0n);assert.ok(afterFirst<=100n*U);
  assert.equal((await s.once(new Date(start.getTime()+60000))).results[0]?.outcome,'executed');assert.equal(await job(f),null);
  const spent=s.sends.flatMap(s=>s.steps).reduce((sum,s)=>sum+s.amountIn,0n);assert.equal(spent,200n*U-R);
  assert.notEqual(planHashFor(s.sends[0]?.steps??[],s.sends[0]?.deadline??0n),planHashFor(s.sends[1]?.steps??[],s.sends[1]?.deadline??0n));
});
test('#83 scheduler DB unknown settlement keeps pending; retry restores once after DB recovery',async()=>{
  const f=await fixture();await f.fund(100n*U);const s=scheduler(f);const base=s.deps.withTransaction;assert.ok(base);
  let commits=0;s.deps.withTransaction=async fn=>base(async client=>{const value=await fn(client);if(++commits===4)throw new Error('settlement rollback');return value;});
  const result=await s.once();assert.equal(result.results[0]?.outcome,'blocked');assert.equal(s.sends.length,1);
  s.deps.withTransaction=base;assert.equal((await s.once()).results[0]?.outcome,'executed');assert.equal(s.sends.length,1);
});
test('#83 two workers / different funds share durable DEX occupancy; lock survives no process-local Map',async()=>{
  const f=await fixture(),g=await fixture();await f.fund(100n*U);await g.fund(100n*U);
  const queueChain=800000+randomBytes(3).readUIntBE(0,3);
  for(const x of [f,g])await query("insert into smart_accounts(portfolio_id,chain_id,address,owner,account_type) values($1,$2,$3,$4,'KERNEL')",[x.id,queueChain,x.account,x.owner]);
  let head=21n;
  const actualGate=createDexGate(query,{transactionBlock:async()=>21n,blockNumber:async()=>head});
  const gate:NonNullable<SchedulerDeps['dexGate']>=async(_chain,pid)=>actualGate(queueChain,pid);
  const one=scheduler(f,{dexGate:gate}),two=scheduler(g,{dexGate:gate});one.setStatus('unknown');two.setStatus('unknown');
  const results=await Promise.all([one.once(),two.once()]);assert.equal(one.sends.length+two.sends.length,1);
  assert.ok(results.some(r=>r.results[0]?.reason.includes('DEX_QUEUED')));
  const pending=(await query("select id from operations where portfolio_id=any($1::bigint[]) and state in ('pending','submitted')",[[f.id,g.id]])).rows;
  assert.equal(pending.length,1);
  const winner=one.sends.length?one:two,loser=one.sends.length?two:one;
  assert.equal((await winner.once()).results[0]?.outcome,'executed','unknown is reconciled before checking the queue');
  assert.match((await loser.once()).results[0]?.reason??'',/下一區塊/);
  head=22n;assert.equal((await loser.once()).results[0]?.outcome,'blocked','sender unknown still occupies its own new attempt');
  assert.equal(one.sends.length+two.sends.length,2);
  const hold=await getPool().connect();try{await hold.query('select pg_advisory_lock(830083,97)');assert.equal(await withDexLock(97,async()=>1),null);}finally{await hold.query('select pg_advisory_unlock(830083,97)');hold.release();}
});
test('#83 a lost DEX lock fails before the signing/broadcast exclusion check',async()=>{
  await assert.rejects(withDexLock(979083,async()=>{
    const own=(await query<{pid:number}>(`select pid from pg_locks where locktype='advisory' and classid=830083 and objid=979083
      and database=(select oid from pg_database where datname=current_database()) and granted`)).rows;
    assert.equal(own.length,1);assert.ok(own[0]);
    await query('select pg_terminate_backend($1)',[own[0].pid]);
    await assertDexLock();
  }),/DEX lock lost/);
});
after(closePool);

test('#83 unbroadcast stack work cannot buy an expired period after restart',async()=>{
  const f=await fixture('stack');await f.fund(500n*U);
  const first=(await f.reserve())?.job;assert.ok(first);
  const next=(await f.reserve({...f.context,now:new Date(start.getTime()+86400000)}))?.job;
  assert.notEqual(next?.id,first.id,'a reserved but never broadcast period must expire instead of catching up');
  const original=(await query<{state:string}>('select state from strategy_jobs where id=$1',[first.id])).rows[0];assert.equal(original?.state,'cancelled');
});

test('#83 hold respects raw fee rounding and the inclusive 50 total budget boundary',async()=>{
  const f=await fixture();await f.fund(50n*U);
  const first=(await f.reserve())?.job;assert.ok(first);assert.equal(BigInt(first.amount_raw)+BigInt(first.fee_reserve_raw),50n*U);
  assert.equal(BigInt(first.amount_raw),50n*U-R);assert.equal(sumInputs(first.remaining_input),50n*U-R);
  assert.equal((await balances(f))?.unallocated_hold_raw,'0');
});
test('#83 a confirmed partial batch resets consecutive failure count',async()=>{
  const f=await fixture();await f.fund(200n*U);
  const c={...f.context,caps:new Map([[a,50n*U],[b,50n*U]])};
  const j=(await f.reserve(c))?.job;assert.ok(j);
  await query('update strategy_jobs set failure_count=2 where id=$1',[j.id]);
  const half=Object.fromEntries(Object.entries(j.remaining_input).map(([a,v])=>[a,(BigInt(v)/2n).toString()]));
  await complete(f,j,half);
  assert.equal((await job(f))?.failure_count,0);
});

test('#83 a sender misclassification cannot release money when original UserOp evidence proves success',async()=>{
  const f=await fixture();await f.fund(100n*U);const s=scheduler(f);s.setStatus('reverted');
  assert.equal((await s.once()).results[0]?.outcome,'executed');
  assert.equal(await job(f),null);assert.equal((await s.once()).results[0]?.outcome,'noop');assert.equal(s.sends.length,1);
});

test('#83 credential-shaped RPC/DB failures remain generic in typed results and logs',async()=>{
  const f=await fixture();await f.fund(100n*U);const logs:string[]=[],marker='fixture-credential-value';
  const s=scheduler(f,{log:line=>logs.push(line)});assert.ok(s.deps.newMoney);
  s.deps.newMoney.policy=async()=>{throw new Error(`https://rpc.invalid/?token=${marker}`);};
  const result=await s.once();assert.equal(result.results[0]?.outcome,'blocked');
  assert.ok(!JSON.stringify(result).includes(marker));assert.ok(!logs.join('\n').includes(marker));
  const send=scheduler(f,{log:line=>logs.push(line),executeRebalance:async()=>{throw new Error(`postgres://user:${marker}@fixture.invalid/db`);}});
  assert.equal((await send.once()).results[0]?.outcome,'failed');
  assert.ok(!logs.join('\n').includes(marker));
  assert.ok(!(await query<{last_error:string}>('select last_error from operations where portfolio_id=$1',[f.id])).rows.some(r=>r.last_error.includes(marker)));
});


test('#83 completed all-hold funds with none never rebalance price drift',async()=>{
  const f=await fixture('hold');await f.fund(100n*U);const initial=(await f.reserve())?.job;assert.ok(initial);await complete(f,initial);
  let calls=0;const p=plan(f);assert.ok(p.report);p.report={...p.report,maxAbsDeltaBps:9000,grossDriftBps:9000,needsRebalance:true};
  const s=scheduler(f,{planPortfolio:async()=>p,planRebalance:async()=>{calls++;return {kind:'noop',reason:'shared target weight planner'};}});
  assert.equal((await s.once()).results[0]?.outcome,'noop');assert.equal(calls,0);assert.equal(s.sends.length,0);
});
test('#83 all-hold drift equality 500 does not trigger; 501 enters the shared target_weight planner',async()=>{
  const f=await fixture('hold',0,4,'drift');await f.fund(100n*U);const initial=(await f.reserve())?.job;assert.ok(initial);await complete(f,initial);
  let delta=500,calls=0;
  const s=scheduler(f,{planPortfolio:async()=>{const p=plan(f);assert.ok(p.report);return {...p,report:{...p.report,maxAbsDeltaBps:delta,grossDriftBps:delta,needsRebalance:true}};},planRebalance:async()=>{calls++;return {kind:'noop',reason:'shared target weight planner'};}});
  assert.equal((await s.once()).results[0]?.outcome,'noop');assert.equal(calls,0);
  delta=501;assert.equal((await s.once()).results[0]?.outcome,'noop');assert.equal(calls,1);assert.equal(s.sends.length,0);
});
test('#83 all-hold monthly rebalancing waits for a new UTC month after the previous execution',async()=>{
  const f=await fixture('hold',0,4,'monthly');await f.fund(100n*U);const initial=(await f.reserve())?.job;assert.ok(initial);await complete(f,initial);
  await query('update portfolios set last_rebalance_at=$2 where id=$1',[f.id,start]);
  let calls=0;const s=scheduler(f,{planRebalance:async()=>{calls++;return {kind:'noop',reason:'shared target weight planner'};}});
  await s.once(new Date('2026-11-30T23:59:59Z'));assert.equal(calls,0);
  await s.once(new Date('2026-12-01T00:00:00Z'));assert.equal(calls,1);assert.equal(s.sends.length,0);
});

test('#171 monthly_drift scheduler uses either trigger and preserves the funding anchor across service restarts', async () => {
  const f = await fixture('hold', 0, 4, 'monthly_drift');
  await f.fund(100n * U, start);
  const initial = (await f.reserve())?.job; assert.ok(initial); await complete(f, initial);
  for (const [at, delta, expected] of [
    ['2026-11-30T23:59:59Z', 0, 0], ['2026-11-30T23:59:59Z', 500, 0],
    ['2026-11-30T23:59:59Z', 501, 1], ['2026-12-01T00:00:00Z', 0, 1],
    ['2026-12-01T00:00:00Z', 500, 1], ['2026-12-01T00:00:00Z', 501, 1],
  ] as const) for (const dryRun of [false, true]) {
    // last_rebalance_at remains null: the confirmed first funding is the monthly anchor.
    let calls = 0;
    const p = plan(f); assert.ok(p.report);
    p.report = { ...p.report, maxAbsDeltaBps: delta, grossDriftBps: delta, needsRebalance: delta > 100 };
    const s = scheduler(f, { planPortfolio: async () => p, planRebalance: async () => { calls++; return { kind: 'blocked', reason: 'quote unavailable' }; } });
    const result = await s.once(new Date(at), dryRun);
    assert.equal(result.results[0]?.outcome, dryRun || expected ? 'blocked' : 'noop');
    assert.equal(calls, dryRun ? 0 : expected, `${at}: ${delta} bps, dryRun=${dryRun}`); assert.equal(s.sends.length, 0);
  }
  assert.equal((await query('select last_rebalance_at from portfolios where id=$1', [f.id])).rows[0]?.last_rebalance_at, null);
});

test('#171 monthly_drift with no funding/previous rebalance uses drift and blocks unavailable RPC/DB/plan data', async () => {
  const f = await fixture('hold', 0, 4, 'monthly_drift');
  for (const delta of [0, 500, 501, 10000]) {
    let calls = 0;
    const p = plan(f); assert.ok(p.report);
    p.report = { ...p.report, maxAbsDeltaBps: delta, grossDriftBps: delta, needsRebalance: delta > 100 };
    const s = scheduler(f, { planPortfolio: async () => p, planRebalance: async () => { calls++; return { kind: 'blocked', reason: 'quote unavailable' }; } });
    await s.once(); assert.equal(calls, delta > 500 ? 1 : 0); assert.equal(s.sends.length, 0);
  }
  for (const failure of ['rpc', 'timeout', 'missing_report', 'blocked', 'anchor_db']) {
    const p = plan(f); assert.ok(p.report); p.report.maxAbsDeltaBps = 501;
    if (failure === 'missing_report') p.report = null;
    if (failure === 'blocked') p.blocked.push({ code: 'UNPRICED_HOLDINGS', detail: 'missing pricing data' });
    let calls = 0; const marker = 'PRIVATE_TEST_UPSTREAM', logs: string[] = [];
    const s = scheduler(f, {
      log: line => logs.push(line),
      planPortfolio: async () => { if (failure === 'rpc') throw new Error(marker); if (failure === 'timeout') throw new DOMException(marker, 'TimeoutError'); return p; },
      query: async (sql, params) => { if (failure === 'anchor_db' && sql.includes('coalesce(last_rebalance_at')) throw new Error(marker); return query(sql, params); },
      planRebalance: async () => { calls++; throw new Error('unavailable data cannot authorize quotes'); },
    });
    const result = await s.once();
    assert.equal(result.results[0]?.outcome, 'blocked');
    assert.equal(calls, 0); assert.equal(s.sends.length, 0); assert.ok(!JSON.stringify(result).includes(marker));
    assert.ok(!logs.join('\n').includes(marker));
  }
  assert.equal((await query('select id from operations where portfolio_id=$1', [f.id])).rows.length, 0);
});

for (const mode of ['monthly', 'monthly_drift'] as const) test(`#104 / #171 ${mode} rebalance withdraws yield before swaps and resumes without revoking consent`,async()=>{
  const f=await fixture('hold',0,4,mode);await f.fund(100n*U);
  const initial=(await f.reserve())?.job;assert.ok(initial);await complete(f,initial);
  await query('update portfolios set last_rebalance_at=$2 where id=$1',[f.id,start]);
  const {yieldFixture}=await import('./fixtures/yield.js');
  const lending=yieldFixture(['venus']).read.positions;
  const position=lending[0];assert.ok(position);position.receipt=100n;position.market={...position.market,asset:a};
  const p=plan(f);p.snapshot.yieldPositions=lending;
  let withdrawals=0,swaps=0,pending=true;
  const s=scheduler(f,{planPortfolio:async()=>p,planRebalance:async()=>{swaps++;return {kind:'ready',steps:[{tokenIn:cash,tokenOut:a,amountIn:50n*U,amountOutMin:90n,oracleFloor:80n,venue:TESTNET_97.contracts.universalRouter,data:'0x'}],deadline:BigInt(at.getTime()/1000)+1800n,rationale:'capped candidate'};}});
  s.deps.newMoney={...s.deps.newMoney,yieldHoldings:async()=>p,withdrawYield:async()=>{withdrawals++;return pending?'[YIELD_REBALANCE_PENDING] 領回待確認':null;}};
  const at=new Date('2026-12-01T00:00:00Z');
  assert.match((await s.once(at)).results[0]?.reason??'',/YIELD_REBALANCE_PENDING/);
  assert.equal(withdrawals,1);assert.equal(swaps,1);assert.equal(s.sends.length,0);
  pending=false;
  await s.once(at);assert.equal(withdrawals,2);assert.equal(swaps,2);assert.equal(s.sends.length,1);
  assert.equal((await query('select id from yield_exit_requests where portfolio_id=$1',[f.id])).rows.length,0);
});

test('#83 source-level fee rounding cannot exceed an admitted asset cap by one raw unit',async()=>{
  const f=await fixture();await f.fund(100n*U+2n);await f.fund(100n*U);
  // Aggregate fees split exactly in half; per-source floors give the first asset one less
  // raw fee, so its exact input is one larger. Recheck the final source vector.
  const cap=100n*U+1n-R/2n;
  const result=await f.reserve({...f.context,caps:new Map([[a,null],[b,cap]])});
  if(result?.job){
    const original=BigInt(result.job.original_input[b]??'0');
    const fundedFee=BigInt(result.job.fee_reserve_raw)/R;
    assert.ok(fundedFee>0n);assert.ok((original+fundedFee-1n)/fundedFee<=cap,'the final vector must fit the cap even after fee rounding across lots');
  }else assert.equal((await balances(f))?.reserved_input_raw,'0');
});

for(const missingHash of [true,false])test(`#83 ${missingHash?'hashless pending':'missing receipt with hash'} keeps its original business reservation after deadline and nonce advance`,async()=>{
  const f=await fixture();await f.fund(100n*U);
  let broadcasts=0;
  const first=scheduler(f,missingHash?{executeRebalance:async args=>{broadcasts++;args.onSending();throw new Error('transport response lost after possible broadcast');}}:{});
  if(!missingHash)first.setStatus('unknown');
  assert.equal((await first.once()).results[0]?.outcome,'blocked');
  const before=(await query<{idempotency_key:string;payload_hash:Hex;user_op_nonce:string;deadline:Date;state:string;user_op_hash:Hex|null;tx_hash:Hex|null}>('select idempotency_key,payload_hash,user_op_nonce::text,deadline,state,user_op_hash,tx_hash from operations where portfolio_id=$1',[f.id])).rows[0];assert.ok(before);
  assert.equal(before.user_op_hash===null,missingHash);
  const original=await job(f);assert.ok(original);const cashBefore=await balances(f);
  const resumed=scheduler(f,{readLatestBlockTimestamp:async()=>BigInt(before.deadline.getTime()/1000)+301n,readEntryPointNonce:async()=>BigInt(before.user_op_nonce)+1n,
    reconcileRebalance:async()=>({kind:'not_found'}),executeRebalance:async()=>{broadcasts++;throw new Error('missing historical evidence must not authorize another send');}});
  for(let index=1;index<=2;index++)assert.equal((await resumed.once(new Date(start.getTime()+index*86400000))).results[0]?.outcome,'blocked');
  const after=(await query('select idempotency_key,payload_hash,user_op_nonce::text,deadline,state,user_op_hash,tx_hash from operations where portfolio_id=$1',[f.id])).rows[0];
  assert.deepEqual(after,before);assert.deepEqual((await job(f))?.remaining_input,original.remaining_input);assert.deepEqual(await balances(f),cashBefore);
  assert.equal(resumed.sends.length,0);assert.equal(broadcasts,missingHash?1:0);assert.equal((await query('select batch_index from strategy_job_batches where job_id=$1',[original.id])).rows.length,1);
});

for(const stage of ['quote','refresh'] as const)test(`#83 ${stage} crossing the source deadline cannot start a stale asset batch`,async()=>{
  const f=await fixture('stack');await f.fund(200n*U);
  let time=new Date(start);
  const s=scheduler(f,{clock:()=>time});
  if(stage==='quote'){
    const original=s.deps.newMoney?.quote;assert.ok(original);assert.ok(s.deps.newMoney);
    s.deps.newMoney.quote=async(...args)=>{const result=await original(...args);time=new Date(start.getTime()+86400000);return result;};
  }else s.deps.refreshFloors=async input=>{time=new Date(start.getTime()+86400000);return {ok:true,steps:[...input.steps],refreshes:[],note:'price refresh crossed source window'};};
  assert.equal((await s.once()).results[0]?.outcome,'blocked');
  assert.equal(s.sends.length,0);assert.equal((await query('select id from operations where portfolio_id=$1',[f.id])).rows.length,0);
  const original=await job(f);assert.ok(original);assert.equal(original.asset_started_at,null);
  assert.equal((await query('select batch_index from strategy_job_batches where job_id=$1',[original.id])).rows.length,0);
  assert.equal(BigInt(original.amount_raw)+BigInt(original.fee_reserve_raw),50n*U);
});


for (const mode of ['drift', 'monthly_drift'] as const) for(const direction of ['buy','sell'] as const)test(`#83 / #171 all-hold ${mode} ${direction} rebalancing settles authoritative USDT deltas with its operation`,async()=>{
  const f=await fixture('hold',5000,4,mode);await f.fund(200n*U);const initial=(await f.reserve())?.job;assert.ok(initial);await complete(f,initial);
  const before=await balances(f);assert.ok(before);
  const delta=direction==='buy'?-20n*U-R:30n*U;
  const s=scheduler(f,{planPortfolio:async()=>{const p=plan(f);assert.ok(p.report);return {...p,report:{...p.report,maxAbsDeltaBps:501,needsRebalance:true}};},
    planRebalance:async()=>({kind:'ready',steps:[{tokenIn:direction==='buy'?cash:a,tokenOut:direction==='buy'?a:cash,amountIn:20n*U,amountOutMin:90n,oracleFloor:80n,venue:TESTNET_97.contracts.universalRouter,data:'0x'}],deadline:BigInt(start.getTime()/1000)+1800n,rationale:'shared target weight planner'}),
    reconcileRebalance:async input=>{assert.equal(input.trackCash,cash);return {kind:'found',outcome:{status:'success',userOpHash:input.userOpHash,txHash:input.txHash??hash(),gasUsed:'100',error:null,cashDeltaRaw:delta.toString()}};}});
  assert.equal((await s.once()).results[0]?.outcome,'executed');assert.equal(s.sends.length,1);
  assert.equal((await balances(f))?.allocated_cash_raw,(BigInt(before.allocated_cash_raw)+delta).toString());
  assert.equal((await query<{state:string}>('select state from operations where portfolio_id=$1 and strategy_job_id is null',[f.id])).rows[0]?.state,'confirmed');
  assert.equal((await query('select id from strategy_jobs where portfolio_id=$1',[f.id])).rows.length,1,'price rebalance must use the shared target_weight pipeline, without manufacturing a funding job');
  const anchor=(await query<{last_rebalance_at:Date|null}>('select last_rebalance_at from portfolios where id=$1',[f.id])).rows[0];
  assert.equal(anchor?.last_rebalance_at?.getTime(),start.getTime());
  const restarted=scheduler(f);
  assert.equal((await restarted.once()).results[0]?.outcome,'noop');assert.equal(restarted.sends.length,0);
  assert.equal((await balances(f))?.allocated_cash_raw,(BigInt(before.allocated_cash_raw)+delta).toString());
});

test('#83 all-hold unknown rebalance restores USDT cash once after an atomic settlement rollback',async()=>{
  const f=await fixture('hold',5000,4,'drift');await f.fund(200n*U);const initial=(await f.reserve())?.job;assert.ok(initial);await complete(f,initial);
  const before=await balances(f);assert.ok(before);const delta=-20n*U-R;
  let cashProof=false;
  const s=scheduler(f,{planPortfolio:async()=>{const p=plan(f);assert.ok(p.report);return {...p,report:{...p.report,maxAbsDeltaBps:501,needsRebalance:true}};},
    planRebalance:async()=>({kind:'ready',steps:[{tokenIn:cash,tokenOut:a,amountIn:20n*U,amountOutMin:90n,oracleFloor:80n,venue:TESTNET_97.contracts.universalRouter,data:'0x'}],deadline:BigInt(start.getTime()/1000)+1800n,rationale:'shared target weight planner'}),
    reconcileRebalance:async input=>{assert.equal(input.trackCash,cash);return {kind:'found',outcome:{status:'success',userOpHash:input.userOpHash,txHash:input.txHash??hash(),gasUsed:'100',error:null,...(cashProof?{cashDeltaRaw:delta.toString()}:{})}};}});
  s.setStatus('unknown');assert.equal((await s.once()).results[0]?.outcome,'blocked');assert.equal(s.sends.length,1);assert.deepEqual(await balances(f),before);
  assert.equal((await s.once()).results[0]?.outcome,'blocked','missing scoped USDT transfer proof cannot settle cash');assert.deepEqual(await balances(f),before);
  cashProof=true;const base=s.deps.withTransaction;assert.ok(base);
  s.deps.withTransaction=fn=>base(async client=>fn({query:async(text,params)=>{const result=await client.query(text,params);if(text.includes('allocated_cash_raw=allocated_cash_raw+$3::numeric'))throw new Error('cash settlement transaction rollback');return result;}}));
  assert.equal((await s.once()).results[0]?.outcome,'blocked');assert.deepEqual(await balances(f),before);
  assert.notEqual((await query<{state:string}>('select state from operations where portfolio_id=$1 and strategy_job_id is null',[f.id])).rows[0]?.state,'confirmed');
  s.deps.withTransaction=base;assert.equal((await s.once()).results[0]?.outcome,'executed');assert.equal(s.sends.length,1);
  assert.equal((await balances(f))?.allocated_cash_raw,(BigInt(before.allocated_cash_raw)+delta).toString());
  const next=scheduler(f);await next.once();assert.equal(next.sends.length,0);assert.equal((await balances(f))?.allocated_cash_raw,(BigInt(before.allocated_cash_raw)+delta).toString());
});

test('#83 two individually small mixed-calendar lots merge each account timestamp once without reweighting',async()=>{
  const f=await fixture('stack',0,4,'none',{kind:'stack',every:'daily',weekday:null,timeUtc:'14:00',slices:4});
  // DB certificate preserves one effective slice for each original 50%-weighted
  // source; two admitted 50-total sources share each 50-budget account timestamp.
  for(let index=0;index<2;index++)await f.fund(50n*U,new Date(start.getTime()-60000),{[a]:1,[b]:1});
  const first=(await f.reserve())?.job;assert.ok(first);assert.deepEqual(Object.keys(first.original_input),[a]);
  assert.equal(BigInt(first.amount_raw)+BigInt(first.fee_reserve_raw),50n*U);assert.equal(first.fee_reserve_raw,R.toString());
  await complete(f,first);
  const second=(await f.reserve({...f.context,now:new Date(start.getTime()+3600000)}))?.job;assert.ok(second);assert.deepEqual(Object.keys(second.original_input),[b]);
  assert.equal(BigInt(second.amount_raw)+BigInt(second.fee_reserve_raw),50n*U);assert.equal(second.fee_reserve_raw,R.toString());
  await complete(f,second);
  assert.equal((await balances(f))?.stack_prefund_raw,'0');assert.equal((await balances(f))?.allocated_cash_raw,(2n*R).toString());
  const original=(await query<{total:string}>('select sum(s.base_budget_raw)::text as total from strategy_asset_slices s join strategy_funding_lots l on l.id=s.lot_id where l.portfolio_id=$1',[f.id])).rows[0];assert.equal(original?.total,(100n*U).toString());
});

test('#83 a new hold contribution waits through an older unknown job and buys after its original receipt settles',async()=>{
  const f=await fixture();await f.fund(100n*U);const s=scheduler(f);s.setStatus('unknown');
  assert.equal((await s.once()).results[0]?.outcome,'blocked');assert.equal(s.sends.length,1);
  const original=(await query<{idempotency_key:string;user_op_hash:Hex;payload_hash:Hex}>('select idempotency_key,user_op_hash,payload_hash from operations where portfolio_id=$1',[f.id])).rows[0];assert.ok(original);
  const added=await f.fund(120n*U,new Date(start.getTime()+60000));
  assert.equal((await s.once(new Date(start.getTime()+120000))).results[0]?.outcome,'executed','restore the old receipt before considering the new funding source');
  assert.equal(s.sends.length,1,'receipt reconciliation must not broadcast a replacement');
  const restored=(await query<{idempotency_key:string;user_op_hash:Hex;payload_hash:Hex;state:string}>('select idempotency_key,user_op_hash,payload_hash,state from operations where portfolio_id=$1',[f.id])).rows[0];assert.ok(restored);
  assert.equal(restored.idempotency_key,original.idempotency_key);assert.equal(restored.user_op_hash,original.user_op_hash);assert.equal(restored.payload_hash,original.payload_hash);assert.equal(restored.state,'confirmed');
  assert.equal((await query('select slice_index from strategy_asset_slices where lot_id=$1',[added])).rows.length,0,'hold has no missed periods: the fresh source must remain unassigned while older work is in flight');
  s.setStatus('success');assert.equal((await s.once(new Date(start.getTime()+180000))).results[0]?.outcome,'executed');assert.equal(s.sends.length,2);
  assert.equal(sumInputs(Object.fromEntries((s.sends[1]?.steps??[]).map(step=>[step.tokenOut,step.amountIn.toString()]))),120n*U-R);
  assert.equal((await query<{state:string}>('select state from strategy_asset_slices where lot_id=$1',[added])).rows.every(row=>row.state==='completed'),true);
  assert.equal((await balances(f))?.unallocated_hold_raw,'0');assert.equal(await job(f),null);
});

test('#83 pausing a partially confirmed mixed job releases only its unspent hold and stack reservations',async()=>{
  const f=await fixture('hold',5000,4,'none',{kind:'stack',every:'daily',weekday:null,timeUtc:'13:00',slices:4});
  await f.fund(800n*U);
  const initial=(await f.reserve({...f.context,caps:new Map([[a,100n*U],[b,25n*U]])}))?.job;assert.ok(initial);
  assert.equal(BigInt(initial.amount_raw)+BigInt(initial.fee_reserve_raw),250n*U);assert.equal(initial.fee_reserve_raw,R.toString());
  const half=Object.fromEntries(Object.entries(initial.remaining_input).map(([asset,raw])=>[asset,(BigInt(raw)/2n).toString()]));
  await complete(f,initial,half,R/2n);
  const partial=await job(f);assert.ok(partial);assert.equal(partial.state,'running');assert.equal(partial.remaining_fee_raw,(R/2n).toString());
  const confirmed=(await query<{state:string;input_raw:Record<string,string>}>('select state,input_raw from strategy_job_batches where job_id=$1',[initial.id])).rows;assert.equal(confirmed.length,1);assert.equal(confirmed[0]?.state,'confirmed');
  await query("update portfolios set schedule_state='paused' where id=$1",[f.id]);
  await f.reserve({...f.context,enabled:false,now:new Date(start.getTime()+60000)});
  const cancelled=(await query<{state:string;remaining_input:Record<string,string>;remaining_fee_raw:string}>('select state,remaining_input,remaining_fee_raw::text from strategy_jobs where id=$1',[initial.id])).rows[0];assert.ok(cancelled);
  assert.equal(cancelled.state,'cancelled');assert.deepEqual(cancelled.remaining_input,partial.remaining_input);assert.equal(cancelled.remaining_fee_raw,partial.remaining_fee_raw);
  const saved=await balances(f);assert.ok(saved);assert.equal(saved.reserved_input_raw,'0');assert.equal(saved.reserved_fee_raw,'0');assert.equal(saved.allocated_cash_raw,(400n*U).toString());
  assert.equal(saved.unallocated_hold_raw,(100n*U).toString());assert.equal(saved.stack_prefund_raw,(175n*U).toString());
  assert.equal(BigInt(saved.unallocated_hold_raw)+BigInt(saved.stack_prefund_raw)+BigInt(saved.allocated_cash_raw)+sumInputs(half)+R/2n,800n*U);
  assert.deepEqual((await query<{state:string;input_raw:Record<string,string>}>('select state,input_raw from strategy_job_batches where job_id=$1',[initial.id])).rows,confirmed,'pausing cannot reverse the confirmed child batch');
  assert.equal(await job(f),null);
});

test('#96 final installment buys all remaining asset dust and never reuses it',async()=>{
  const f=await fixture('hold',0,4,'none',undefined,[9900,100]);
  for(let index=0;index<2;index++){
    const at=new Date(start.getTime()+index*60000);
    await f.fund(100n*U,new Date(at.getTime()-1));
    const j=(await f.reserve({...f.context,now:at}))?.job;assert.ok(j);
    assert.ok(BigInt(j.original_input[b]??'0')>0n&&BigInt(j.original_input[b]??'0')<U,'the only/final installment must include sub-1 input after fees');
    assert.equal(BigInt(j.amount_raw)+BigInt(j.fee_reserve_raw),100n*U);
    assert.equal((await f.reserve({...f.context,now:at}))?.job?.id,j.id);
    await complete(f,j,j.remaining_input,R);
    assert.equal((await balances(f))?.unallocated_hold_raw,'0');
    assert.equal((await f.reserve({...f.context,now:at}))?.job,null);
  }
  assert.equal((await query("select 1 from strategy_asset_slices s join strategy_funding_lots l on l.id=s.lot_id where l.portfolio_id=$1 and s.state='deferred_min_asset'",[f.id])).rows.length,0);
});

test('#96 partial withdrawal preserves affordable current installments and does not repeatedly debit cash',async()=>{
  const f=await fixture('stack');await f.fund(200n*U);
  let observed=190n*U;const withdrawals=[{txHash:hash(),blockNumber:11n,blockHash:hash(),logIndex:0,amount:10n*U}];
  for(let index=0;index<2;index++){
    const at=new Date(start.getTime()+index*86400000);
    const j=(await f.reserve({...f.context,now:at,observedCash:observed,withdrawals}))?.job;assert.ok(j,'190 then 140 can each fund the next 50 budget');
    assert.equal(BigInt(j.amount_raw)+BigInt(j.fee_reserve_raw),50n*U);
    assert.equal((await f.reserve({...f.context,now:at,observedCash:observed,withdrawals}))?.job?.id,j.id);
    await complete(f,j,j.remaining_input,R);observed-=50n*U;
    const saved=await balances(f);assert.ok(saved);assert.equal(Object.values(saved).reduce((n,v)=>n+BigInt(v),0n),observed);
  }
});

test('#96 monthly partial execution resumes after restart and new money never marks monthly complete',async()=>{
  const f=await fixture('hold',0,4,'monthly');await f.fund(100n*U);
  const initial=scheduler(f);assert.equal((await initial.once()).results[0]?.outcome,'executed');
  assert.equal((await query('select last_rebalance_at from portfolios where id=$1',[f.id])).rows[0]?.last_rebalance_at,null);
  await query('update portfolios set last_rebalance_at=$2 where id=$1',[f.id,start]);
  const at=new Date('2026-12-01T00:00:00Z');let planned=0;
  const next=()=>scheduler(f,{reconcileRebalance:async()=>({kind:'found',outcome:{status:'success',userOpHash:hash(),txHash:hash(),gasUsed:'100',error:null,cashDeltaRaw:'0'}}),planRebalance:async()=>{
    planned++;return {kind:'ready',steps:[{tokenIn:cash,tokenOut:a,amountIn:50n*U,amountOutMin:90n,oracleFloor:80n,venue:TESTNET_97.contracts.universalRouter,data:'0x'}],deadline:BigInt(at.getTime()/1000)+1800n+BigInt(planned),rationale:'monthly target',
      ...(planned===1?{partial:{remainingDriftBps:501,shrunk:[],maxLegBatched:true}}:{})};
  },executeRebalance:async args=>{args.onSending();await args.onSubmitted({userOpHash:hash()});return {status:'success',txHash:hash(),userOpHash:hash(),gasUsed:'100',error:null,cashDeltaRaw:'0'};}});
  const firstResult=(await next().once(at)).results[0];assert.equal(firstResult?.outcome,'executed',firstResult?.reason);
  assert.equal((await query<{last_rebalance_at:Date}>('select last_rebalance_at from portfolios where id=$1',[f.id])).rows[0]?.last_rebalance_at.toISOString(),start.toISOString());
  assert.equal((await next().once(new Date(at.getTime()+60000))).results[0]?.outcome,'executed');assert.equal(planned,2);
  assert.equal((await next().once(new Date(at.getTime()+120000))).results[0]?.outcome,'noop');assert.equal(planned,2);
});

test('#118 dust-aware shortened 99/1 funding defers small inputs then buys the final remainder',async()=>{
  const f=await fixture('stack',0,12,'none',undefined,[9900,100]);const lot=await f.fund(100n*U);
  let spent=0n;
  for(let index=0;index<9;index++){
    const result=(await f.reserve({...f.context,now:new Date(+start+index*86400000)}))?.job;assert.ok(result);
    assert.deepEqual(new Set(Object.keys(result.original_input)),new Set(index===8?[a,b]:[a]));
    assert.equal(result.fee_reserve_raw,R.toString());spent+=sumInputs(result.original_input)+R;
    const small=(await query<{state:string;job_id:string|null}>('select state,job_id from strategy_asset_slices where lot_id=$1 and asset=$2 and slice_index=$3',[lot,b,index])).rows[0];assert.ok(small);
    assert.equal(small.state,index===8?'reserved':'deferred_min_asset');assert.equal(small.job_id,index===8?result.id:null);
    await complete(f,result,result.remaining_input,R);
  }
  assert.equal(spent,100n*U);
  assert.equal((await balances(f))?.stack_prefund_raw,'0');assert.equal((await balances(f))?.reserved_input_raw,'0');
});

for(const missingHash of [true,false])test(`#83 typed target_weight ${missingHash?'hashless pending':'not_found receipt'} cannot expire without authoritative cash evidence`,async()=>{
  const f=await fixture('hold',5000,4,'drift');await f.fund(200n*U);const initial=(await f.reserve())?.job;assert.ok(initial);await complete(f,initial);
  const cashBefore=await balances(f);let broadcasts=0;
  const first=scheduler(f,{planPortfolio:async()=>{const p=plan(f);assert.ok(p.report);return {...p,report:{...p.report,maxAbsDeltaBps:501,needsRebalance:true}};},
    planRebalance:async()=>({kind:'ready',steps:[{tokenIn:cash,tokenOut:a,amountIn:20n*U,amountOutMin:90n,oracleFloor:80n,venue:TESTNET_97.contracts.universalRouter,data:'0x'}],deadline:BigInt(start.getTime()/1000)+1800n,rationale:'shared target weight planner'}),
    ...(missingHash?{executeRebalance:async(args:ExecuteArgs)=>{broadcasts++;args.onSending();throw new Error('ordinary rebalance transport response lost');}}:{})});
  if(!missingHash)first.setStatus('unknown');
  assert.equal((await first.once()).results[0]?.outcome,'blocked');
  const before=(await query<{idempotency_key:string;payload_hash:Hex;user_op_nonce:string;deadline:Date;state:string;user_op_hash:Hex|null;tx_hash:Hex|null}>('select idempotency_key,payload_hash,user_op_nonce::text,deadline,state,user_op_hash,tx_hash from operations where portfolio_id=$1 and strategy_job_id is null',[f.id])).rows[0];assert.ok(before);assert.equal(before.user_op_hash===null,missingHash);
  const resumed=scheduler(f,{readLatestBlockTimestamp:async()=>BigInt(before.deadline.getTime()/1000)+301n,readEntryPointNonce:async()=>BigInt(before.user_op_nonce)+1n,
    reconcileRebalance:async()=>({kind:'not_found'}),executeRebalance:async()=>{broadcasts++;throw new Error('unknown cash mutation cannot authorize another rebalance');}});
  for(let index=1;index<=2;index++)assert.equal((await resumed.once(new Date(start.getTime()+index*86400000))).results[0]?.outcome,'blocked');
  const after=(await query('select idempotency_key,payload_hash,user_op_nonce::text,deadline,state,user_op_hash,tx_hash from operations where portfolio_id=$1 and strategy_job_id is null',[f.id])).rows[0];
  assert.deepEqual(after,before);assert.deepEqual(await balances(f),cashBefore);assert.equal(resumed.sends.length,0);assert.equal(broadcasts,missingHash?1:0);
});

test('#83 historical 0031 stack unknown reconciles after 0032 without mutating retired instructions',async()=>{
  const client=await getPool().connect();const schema=`be83_history_${randomBytes(8).toString('hex')}`;
  const owner=address(),account=address(),userOpHash=hash(),txHash=hash(),payload=hash();
  const isolatedQuery:SchedulerQueryFn=(text,params)=>client.query(text,params===undefined?[]:[...params]);
  const isolatedRun:WithTransactionFn=async fn=>{await client.query('begin');try{const result=await fn({query:isolatedQuery});await client.query('commit');return result;}catch(error){await client.query('rollback');throw error;}};
  try{
    await client.query(`create schema ${schema}`);await client.query(`set search_path to ${schema}`);
    const files=(await readdir(MIGRATIONS_DIR)).filter(name=>/^\d{4}_.*\.sql$/.test(name)&&Number(name.slice(0,4))<=31).sort();assert.equal(files.length,31);
    for(const file of files)await client.query(await readFile(join(MIGRATIONS_DIR,file),'utf8'));
    const allocation:Allocation={assets:[{address:a,weightBps:5000},{address:b,weightBps:5000},{address:cash,weightBps:0}]};
    const activeAt=new Date('2026-11-14T00:00:00Z');
    const configHash=canonicalConfigHash({chainId:97,execution:{kind:'stack'},allocation,schedule:{kind:'funding'},activeAt});
    const identity=await isolatedRun(async({query:sql})=>{
      const sid=(await sql("insert into strategies(provider,name,onchain_id) values($1,'historical-stack',99000001) returning id",[owner])).rows[0] as {id:string}|undefined;assert.ok(sid);
      await sql(`insert into strategy_versions(strategy_id,version,allocation,schedule,active_at,execution_schema_version,execution,execution_chain_id,config_hash)
        values($1,1,$2,'{"kind":"funding"}',$3,1,'{"kind":"stack"}',97,$4)`,[sid.id,JSON.stringify(allocation),activeAt,configHash]);
      const pid=(await sql("insert into portfolios(user_id,strategy_id,version,schedule_state) values($1,$2,1,'active') returning id",[owner,sid.id])).rows[0] as {id:string}|undefined;assert.ok(pid);
      await sql("insert into smart_accounts(portfolio_id,chain_id,address,owner,account_type) values($1,97,$2,$3,'KERNEL')",[pid.id,account,owner]);
      await sql('insert into strategy_cash_balances(chain_id,portfolio_id,account,reserved_input_raw,reserved_fee_raw) values(97,$1,$2,$3,$4)',[pid.id,account,(100n*U).toString(),R.toString()]);
      await sql(`insert into stack_instructions(chain_id,portfolio_id,revision,strategy_id,version,authorized_by,amount_raw,period_seconds,start_at,state,next_slot_index,created_at,updated_at)
        values(97,$1,1,$2,1,$3,$4,86400,$5,'active',1,$6,$6)`,[pid.id,sid.id,owner,(100n*U).toString(),start,activeAt]);
      const inputs=JSON.stringify({[a]:(50n*U).toString(),[b]:(50n*U).toString()});
      const job=(await sql(`insert into strategy_jobs(chain_id,portfolio_id,kind,instruction_revision,slot_index,through_slot_index,slot_at,window_end_at,amount_raw,fee_reserve_raw,allocated_cash_raw,original_input,remaining_input,remaining_fee_raw,state)
        values(97,$1,'stack',1,0,0,$2,$3,$4,$5,0,$6,$6,$5,'reserved') returning id`,[pid.id,start,new Date(start.getTime()+86400000),(100n*U).toString(),R.toString(),inputs])).rows[0] as {id:string}|undefined;assert.ok(job);
      await sql('insert into strategy_job_batches(job_id,batch_index,input_raw) values($1,0,$2)',[job.id,inputs]);
      const op=(await sql(`insert into operations(portfolio_id,type,state,idempotency_key,payload_hash,deadline,user_op_nonce,strategy_job_id,strategy_batch_index)
        values($1,'rebalance','pending',$2,$3,$4,0,$5,0) returning id`,[pid.id,hash(),payload,new Date(start.getTime()+1800000),job.id])).rows[0] as {id:string}|undefined;assert.ok(op);
      await sql("update operations set state='submitted',user_op_hash=$2,tx_hash=$3 where id=$1",[op.id,userOpHash,txHash]);
      await sql("update strategy_job_batches set state='unknown' where job_id=$1",[job.id]);await sql("update strategy_jobs set state='unknown' where id=$1",[job.id]);
      return {portfolioId:Number(pid.id),jobId:job.id,operationId:op.id};
    });
    await client.query('begin');try{await client.query(await readFile(join(MIGRATIONS_DIR,'0032_stack_creator_params.sql'),'utf8'));await client.query('commit');}catch(error){await client.query('rollback');throw error;}
    const original=(await client.query('select to_jsonb(i) as instruction from stack_instructions i')).rows;
    let sends=0;
    const deps:SchedulerDeps={query:isolatedQuery,withTransaction:isolatedRun,chainId:97,executor:TESTNET_97.contracts.executor,readGlobalPaused:async()=>false,
      withPortfolioLock:async(_id,fn)=>fn(),withDexLock:async(_chain,fn)=>fn(),dexGate:async()=>null,log:()=>{},
      planPortfolio:async()=>{throw new Error('retired stack must reconcile without replanning');},executeRebalance:async()=>{sends++;throw new Error('retired stack must not send');},
      reconcileRebalance:async input=>{assert.equal(input.userOpHash,userOpHash);assert.equal(input.payloadHash,payload);return {kind:'found',outcome:{status:'success',userOpHash,txHash,gasUsed:'100',error:null,
        batchEvidence:{received:{[a]:'100',[b]:'100'},fees:{},feePaid:R,blockNumber:11n,blockHash:hash()}}};}};
    const result=await runSchedulerOnce({dryRun:false,now:new Date(start.getTime()+86400000),skipAlerts:true},deps);
    assert.equal(result.results[0]?.outcome,'executed');assert.equal(sends,0);
    assert.deepEqual((await client.query('select to_jsonb(i) as instruction from stack_instructions i')).rows,original,'0032 retired instruction calendar and revision remain byte-for-byte unchanged');
    assert.equal((await client.query<{state:string}>('select state from operations where id=$1',[identity.operationId])).rows[0]?.state,'confirmed');
    assert.equal((await client.query<{state:string}>('select state from strategy_jobs where id=$1',[identity.jobId])).rows[0]?.state,'completed');
    assert.deepEqual((await client.query('select reserved_input_raw::text,reserved_fee_raw::text from strategy_cash_balances where portfolio_id=$1',[identity.portfolioId])).rows,[{reserved_input_raw:'0',reserved_fee_raw:'0'}]);
    await client.query('update portfolios set next_run_at=null where id=$1',[identity.portfolioId]);
    const next=await runSchedulerOnce({dryRun:false,now:new Date(start.getTime()+86460000),skipAlerts:true},deps);assert.equal(next.results[0]?.outcome,'blocked');assert.equal(sends,0);
    assert.equal((await client.query('select id from operations')).rows.length,1);
  }finally{
    await client.query('rollback');await client.query('set search_path to public');await client.query(`drop schema if exists ${schema} cascade`);client.release();
  }
});

test('#83 policy reads only assets due in the current mixed-calendar batch',async()=>{
  const f=await fixture('stack',0,4,'none',{kind:'stack',every:'daily',weekday:null,timeUtc:'14:00',slices:4});
  for(let index=0;index<2;index++)await f.fund(50n*U,new Date(start.getTime()-60000),{[a]:1,[b]:1});
  let expected:readonly string[]=[a];const s=scheduler(f);assert.ok(s.deps.newMoney);const original=s.deps.newMoney.policy;assert.ok(original);
  s.deps.newMoney.policy=async(due,p,assets)=>{assert.deepEqual(new Set(assets),new Set(expected),'a future asset oracle/market failure must not block the current batch');return original(due,p,assets);};
  assert.equal((await s.once()).results[0]?.outcome,'executed');assert.equal(s.sends.length,1);assert.deepEqual(s.sends[0]?.steps.map(step=>step.tokenOut),[a]);
  expected=[b];assert.equal((await s.once(new Date(start.getTime()+3600000))).results[0]?.outcome,'executed');assert.equal(s.sends.length,2);assert.deepEqual(s.sends[1]?.steps.map(step=>step.tokenOut),[b]);
});

test('#83 completed weekly installments stay out of policy reads until their next exact slot while fresh hold money buys',async()=>{
  const f=await fixture('hold',0,4,'none',{kind:'stack',every:'weekly',weekday:0,timeUtc:'13:00',slices:4});
  await f.fund(400n*U);
  let expected:readonly string[]=[a,b];const s=scheduler(f);assert.ok(s.deps.newMoney);const original=s.deps.newMoney.policy;assert.ok(original);
  s.deps.newMoney.policy=async(due,p,assets)=>{assert.deepEqual(new Set(assets),new Set(expected),'a completed weekly installment cannot keep the future weekly asset in today\'s hold batch capacity reads');return original(due,p,assets);};
  assert.equal((await s.once()).results[0]?.outcome,'executed');assert.equal(s.sends.length,1);
  const firstWeekly=(await query<{slice_index:number}>('select s.slice_index from strategy_asset_slices s join strategy_funding_lots l on l.id=s.lot_id where l.portfolio_id=$1 and s.asset=$2',[f.id,b])).rows;
  assert.deepEqual(firstWeekly,[{slice_index:0}]);
  await f.fund(100n*U,new Date(start.getTime()+86400000-60000));expected=[a];
  assert.equal((await s.once(new Date(start.getTime()+86400000))).results[0]?.outcome,'executed');assert.equal(s.sends.length,2);
  assert.deepEqual(s.sends[1]?.steps.map(step=>step.tokenOut),[a]);
  const weekly=(await query<{slice_index:number}>('select s.slice_index from strategy_asset_slices s join strategy_funding_lots l on l.id=s.lot_id where l.portfolio_id=$1 and s.asset=$2',[f.id,b])).rows;
  assert.deepEqual(weekly,[{slice_index:0}],'neither the previous lot\'s next weekly installment nor the new lot\'s first weekly installment is due');
});

test('#92 93-asset DB job survives timeout/restart and buys each original input exactly once in <=16-step batches',async()=>{
  const marketAt=new Date('2026-11-16T15:00:00Z');
  const f=await fixture('hold',0,4,'none',undefined,undefined,92);
  await f.fund(10000n*U);
  let held=new Set<Address>();
  const s=scheduler(f);
  s.deps.planPortfolio=async()=>{
    const current=plan(f);
    current.historicalAssetCount=f.allocation.assets.filter(asset=>asset.address!==cash).length;
    for(const asset of held)current.snapshot.holdings.push({asset,amountWei:U,decimals:18,usdPriceE8:100000000n,priceSource:TWAP_PRICE_SOURCE});
    return current;
  };
  s.setStatus('unknown');
  assert.equal((await s.once(marketAt)).results[0]?.outcome,'blocked');
  const original=await job(f);assert.ok(original);assert.equal(Object.keys(original.original_input).length,92);
  assert.equal(original.fee_reserve_raw,R.toString());
  const attempts=(await query('select payload_hash,user_op_nonce from operations where portfolio_id=$1',[f.id])).rows;
  assert.equal((await s.once(marketAt)).results[0]?.outcome,'executed');assert.equal(s.sends.length,1,'unknown original must reconcile without sending a different subset');
  assert.deepEqual((await query('select payload_hash,user_op_nonce from operations where portfolio_id=$1',[f.id])).rows,attempts);
  s.setStatus('success');
  for(let round=0;round<20&&await job(f);round++){
    held=new Set(s.sends.flatMap(send=>send.steps.map(step=>step.tokenOut)));
    assert.equal((await s.once(new Date(marketAt.getTime()+(round+1)*60000))).results[0]?.outcome,'executed');
  }
  assert.equal(await job(f),null);
  assert.equal(s.sends.length,7);assert.ok(s.sends.every(send=>send.steps.length<=16));
  assert.ok((s.sends.at(-1)?.steps.length??16)<16);
  const spent:Record<string,bigint>={};
  for(const send of s.sends)for(const step of send.steps)spent[step.tokenOut.toLowerCase()]=(spent[step.tokenOut.toLowerCase()]??0n)+step.amountIn;
  assert.deepEqual(Object.fromEntries(Object.entries(spent).map(([a,n])=>[a,n.toString()])),original.original_input);
  const saved=await balances(f);assert.equal(saved?.reserved_input_raw,'0');assert.equal(saved?.reserved_fee_raw,'0');
  assert.equal((await query("select batch_index from strategy_job_batches where job_id=$1 and state='confirmed'",[original.id])).rows.length,s.sends.length);
 });

test('#92 unequal 17-asset job groups children and settles the exact frozen vector',async()=>{
  const marketAt=new Date('2026-11-16T15:00:00Z');
  const f=await fixture('hold',0,4,'none',undefined,[...Array.from({length:16},()=>20),9680],17);
  await f.fund(1000n*U);
  const s=scheduler(f);assert.equal((await s.once(marketAt)).results[0]?.outcome,'executed');
  const original=await job(f);assert.ok(original);assert.equal(BigInt(original.fee_reserve_raw),R);
  assert.equal((await s.once(new Date(marketAt.getTime()+60000))).results[0]?.outcome,'executed');
  assert.equal(await job(f),null);assert.equal(s.sends.length,2);
  const spent:Record<string,bigint>={};
  for(const send of s.sends){
    assert.ok(send.steps.length<=16);
    assert.ok(send.steps.reduce((n,step)=>n+step.amountIn,R)>=10n*U);
    for(const step of send.steps){assert.ok(step.amountIn>=U);spent[step.tokenOut]=(spent[step.tokenOut]??0n)+step.amountIn;}
  }
  assert.deepEqual(Object.fromEntries(Object.entries(spent).map(([a,n])=>[a,n.toString()])),original.original_input);
  assert.equal((await balances(f))?.reserved_input_raw,'0');assert.equal((await balances(f))?.reserved_fee_raw,'0');
});

test('#92 two large positions distribute across 18-asset DB batches with 1/10 thresholds',async()=>{
  const marketAt=new Date('2026-11-16T15:00:00Z');
  const f=await fixture('hold',0,4,'none',undefined,[...Array.from({length:16},()=>200),3400,3400],18);
  await f.fund(100n*U);const s=scheduler(f);
  assert.equal((await s.once(marketAt)).results[0]?.outcome,'executed');
  const original=await job(f);assert.ok(original);assert.equal(BigInt(original.fee_reserve_raw),R);
  assert.equal((await s.once(new Date(marketAt.getTime()+60000))).results[0]?.outcome,'executed');assert.equal(await job(f),null);
  const spent:Record<string,bigint>={};assert.equal(s.sends.length,2);
  for(const [index,send] of s.sends.entries()){assert.ok(send.steps.length<=16);assert.ok(send.steps.reduce((sum,step)=>sum+step.amountIn,index===0?R:0n)>=10n*U);
    for(const step of send.steps){assert.ok(step.amountIn>=U);spent[step.tokenOut]=(spent[step.tokenOut]??0n)+step.amountIn;}}
  assert.deepEqual(Object.fromEntries(Object.entries(spent).map(([a,n])=>[a,n.toString()])),original.original_input);
});

test('#96 withdrawal at the current-budget boundary spends only affordable periods, without catch-up',async()=>{
  const f=await fixture('stack');await f.fund(200n*U);
  const withdrawals=[{txHash:hash(),blockNumber:11n,blockHash:hash(),logIndex:0,amount:150n*U}];
  const first=(await f.reserve({...f.context,observedCash:50n*U,withdrawals}))?.job;assert.ok(first);
  assert.equal(BigInt(first.amount_raw)+BigInt(first.fee_reserve_raw),50n*U);
  await complete(f,first,first.remaining_input,R);
  const next=await f.reserve({...f.context,now:new Date(start.getTime()+86400000),observedCash:0n,withdrawals});
  assert.match(next?.reason??'',/SKIPPED_INSUFFICIENT_FUNDS/);
  assert.equal((await balances(f))?.stack_prefund_raw,'0');
  assert.equal((await query("select id from operations where portfolio_id=$1 and idempotency_key like 'cash-withdrawal:%'",[f.id])).rows.length,1);
});

test('#96 withdrawal cannot debit reserved/unknown money; reorg and failed cash write roll back its identity',async()=>{
  const f=await fixture('stack');await f.fund(200n*U);
  const j=(await f.reserve())?.job;assert.ok(j);
  const before=await balances(f);
  const events=[{txHash:hash(),blockNumber:11n,blockHash:hash(),logIndex:0,amount:195n*U}];
  await assert.rejects(f.reserve({...f.context,observedCash:5n*U,withdrawals:events}),/CASH_DEFICIT/);
  assert.deepEqual(await balances(f),before);
  const event=events[0];assert.ok(event);const evidence={...event,amount:10n*U};
  const source=await fundingLots(query,f.context);
  const fail:WithTransactionFn=fn=>run(async client=>fn({query:async(sql,params)=>{
    const result=await client.query(sql,params);
    if(sql.includes('set unclassified_raw='))throw new Error('cash write failed');
    return result;
  }}));
  await assert.rejects(prepareStrategyJob(fail,{...f.context,observedCash:190n*U,withdrawals:[evidence]},source));
  assert.deepEqual(await balances(f),before);
  assert.equal((await query("select id from operations where portfolio_id=$1 and type='withdraw'",[f.id])).rows.length,0);
  assert.equal((await f.reserve({...f.context,observedCash:190n*U,withdrawals:[evidence]}))?.job?.id,j.id);
  const reconciled=await balances(f);
  await assert.rejects(f.reserve({...f.context,observedCash:190n*U,withdrawals:[{...evidence,blockHash:hash()}]}),/CASH_REORGED/);
  assert.deepEqual(await balances(f),reconciled);
  await query("insert into operations(portfolio_id,type,state,idempotency_key) values($1,'rebalance','pending',$2)",[f.id,hash()]);
  await f.reserve({...f.context,observedCash:180n*U,withdrawals:[evidence,{...evidence,txHash:hash()}]});
  assert.deepEqual(await balances(f),reconciled,'unresolved operations protect every original bucket');
});

test('#118 accepted high-cash subscriptions wait for capacity and merge without enlarging their original budgets',async()=>{
  const f=await fixture('hold',9900);
  for(let n=0;n<5;n++){
    await f.fund(1000n*U,new Date(start.getTime()-60000),{[a]:1,[b]:1});
    const prepared=(await f.reserve({...f.context,buyLimit:n<4?0n:UINT256_MAX}))?.job;
    if(n<4)assert.equal(prepared,null);
    else {assert.ok(prepared);assert.equal(BigInt(prepared.amount_raw)+BigInt(prepared.fee_reserve_raw),50n*U);await complete(f,prepared,prepared.remaining_input,R);}
  }
  assert.equal((await balances(f))?.allocated_cash_raw,(4950n*U).toString());
  assert.equal((await balances(f))?.unallocated_hold_raw,'0');
});

test('#96 all-hold monthly unknown partial receipt resumes without marking the month complete',async()=>{
  const f=await fixture('hold',5000,4,'monthly');await f.fund(200n*U);
  const initial=(await f.reserve())?.job;assert.ok(initial);await complete(f,initial);
  const at=new Date('2026-12-01T15:00:00Z');let plans=0;
  const make=(unknown=false)=>scheduler(f,{
    planRebalance:async()=>({kind:'ready',steps:[{tokenIn:cash,tokenOut:a,amountIn:50n*U,amountOutMin:90n,oracleFloor:80n,venue:TESTNET_97.contracts.universalRouter,data:'0x'}],
      deadline:BigInt(at.getTime()/1000)+1800n+BigInt(++plans),rationale:'monthly partial',...(plans===1?{partial:{remainingDriftBps:501,shrunk:[],maxLegBatched:true}}:{})}),
    executeRebalance:async args=>{args.onSending();const userOpHash=hash();await args.onSubmitted({userOpHash});return {status:unknown?'unknown':'success',txHash:unknown?null:hash(),userOpHash,gasUsed:'100',error:unknown?'timeout':null,cashDeltaRaw:'0'};},
    reconcileRebalance:async input=>({kind:'found',outcome:{status:'success',userOpHash:input.userOpHash,txHash:hash(),gasUsed:'100',error:null,cashDeltaRaw:'0'}}),
  });
  assert.equal((await make(true).once(at)).results[0]?.outcome,'blocked');
  const last=async()=>(await query<{last_rebalance_at:Date|null}>('select last_rebalance_at from portfolios where id=$1',[f.id])).rows[0]?.last_rebalance_at;
  assert.equal(await last(),null);
  assert.equal((await make().once(new Date(at.getTime()+60000))).results[0]?.outcome,'executed');assert.equal(plans,1);assert.equal(await last(),null);
  assert.equal((await make().once(new Date(at.getTime()+120000))).results[0]?.outcome,'executed');assert.equal(plans,2);assert.ok(await last());
  assert.equal((await make().once(new Date(at.getTime()+180000))).results[0]?.outcome,'noop');assert.equal(plans,2);
});

async function notifications(f:Fixture){
  return (await query<{id:string;chain_id:string;portfolio_id:string;owner:string;kind:string;dedup_key:string;lot_id:string;asset:string;slice_index:number;payload:{budgetRaw:string;slotAt:string;windowEndAt:string};state:string}>(
    'select * from user_notifications where portfolio_id=$1 order by lot_id,asset,slice_index',[f.id])).rows;
}
test('#96 insufficient notifications retain one pending event per source with an owned recipient and safe payload',async()=>{
  const f=await fixture('stack'),lot=await f.fund(200n*U);
  // Recipient is the smart-account owner, never the portfolio user or provider.
  await query('update portfolios set user_id=$2 where id=$1',[f.id,address()]);
  await query('update strategies set provider=$2 where id=$1',[f.strategyId,address()]);
  for(let retry=0;retry<2;retry++)assert.match((await f.reserve({...f.context,observedCash:0n}))?.reason??'',retry===0?/SKIPPED_INSUFFICIENT_FUNDS/:/NO_DUE_SLOT/);
  const events=await notifications(f);assert.equal(events.length,2);
  for(const event of events){
    assert.equal(event.chain_id,'97');assert.equal(event.portfolio_id,String(f.id));assert.equal(event.owner,f.owner);
    assert.equal(event.kind,'stack_slot_skipped_insufficient_funds');assert.equal(event.state,'pending');
    assert.equal(event.dedup_key,`${lot}:${event.asset}:0`);assert.equal(event.lot_id,lot);assert.equal(event.slice_index,0);
    assert.deepEqual(event.payload,{budgetRaw:(25n*U).toString(),slotAt:start.toISOString(),windowEndAt:new Date(start.getTime()+86400000).toISOString()});
  }
  assert.equal((await query('select id from operations where portfolio_id=$1',[f.id])).rows.length,0);
  assert.equal((await f.reserve({...f.context,now:new Date(start.getTime()+86400000)}))?.job?.amount_raw,(50n*U-R).toString(),'top-up buys only the next installment');
  assert.deepEqual(await notifications(f),events);
});
test('#96 insufficient notifications distinguish every slot through index 51 and never reset terminal events',async()=>{
  const f=await fixture('stack',0,52);await f.fund(2600n*U);
  for(let index=0;index<52;index++){
    const c={...f.context,observedCash:0n,now:new Date(start.getTime()+index*86400000)};
    assert.match((await f.reserve(c))?.reason??'',/SKIPPED_INSUFFICIENT_FUNDS/);
    if(index===0){
      const first=await notifications(f);assert.equal(first.length,2);
      for(const [i,event] of first.entries())await query("update user_notifications set state=$2,updated_at=clock_timestamp() where id=$1 and state='pending'",[event.id,i===0?'delivered':'failed']);
    }
    const saved=await notifications(f);await f.reserve(c);assert.deepEqual(await notifications(f),saved);
  }
  const events=await notifications(f);assert.equal(events.length,104);assert.equal(new Set(events.map(e=>e.dedup_key)).size,104);
  assert.equal(Math.max(...events.map(e=>e.slice_index)),51);assert.equal(Math.min(...events.map(e=>e.slice_index)),0);
  assert.deepEqual(events.filter(e=>e.slice_index===0).map(e=>e.state),['delivered','failed']);
  await f.reserve({...f.context,observedCash:0n,now:new Date(start.getTime()+52*86400000)});assert.deepEqual(await notifications(f),events);
});
test('#96 insufficient notifications serialize two writers and survive an unknown commit without duplication',async()=>{
  const f=await fixture('stack');await f.fund(200n*U);const lots=await fundingLots(query,f.context),c={...f.context,observedCash:0n};
  await Promise.all([prepareStrategyJob(run,c,lots),prepareStrategyJob(run,c,lots)]);
  const saved=await notifications(f);assert.equal(saved.length,2);
  const g=await fixture('stack');await g.fund(200n*U);const source=await fundingLots(query,g.context);
  const lost:WithTransactionFn=async fn=>{await run(fn);throw new Error('unknown commit response');};
  await assert.rejects(withPortfolioLock(g.id,()=>prepareStrategyJob(lost,{...g.context,observedCash:0n},source)),/unknown commit/);
  const committed=await notifications(g);assert.equal(committed.length,2);
  await g.reserve({...g.context,observedCash:0n});assert.deepEqual(await notifications(g),committed);
  assert.deepEqual(await notifications(f),saved);
});
test('#96 insufficient notifications roll back every skipped source on SQL error or statement timeout and retry safely',async()=>{
  for(const failure of ['sql','timeout'] as const){
    const f=await fixture('stack');await f.fund(200n*U);const lots=await fundingLots(query,f.context),before=await balances(f);
    let inserts=0;
    const broken:WithTransactionFn=fn=>run(async client=>fn({query:async(sql,params)=>{
      if(sql.includes('insert into user_notifications')&&++inserts===2){
        if(failure==='timeout'){await client.query("set local statement_timeout='20ms'");await client.query('select pg_sleep(1)');}
        else await client.query('select 1/0');
      }
      return client.query(sql,params);
    }}));
    await assert.rejects(withPortfolioLock(f.id,()=>prepareStrategyJob(broken,{...f.context,observedCash:0n},lots)),failure==='timeout'?/statement timeout/:/division by zero/);
    assert.equal((await notifications(f)).length,0);
    assert.equal((await query('select s.* from strategy_asset_slices s join strategy_funding_lots l on l.id=s.lot_id where l.portfolio_id=$1',[f.id])).rows.length,0);
    assert.deepEqual(await balances(f),before);
    await f.reserve({...f.context,observedCash:0n});assert.equal((await notifications(f)).length,2);
  }
});
test('#96 insufficient notifications require recipient evidence and ignore normal, expired, or disabled work',async()=>{
  const f=await fixture('stack');await f.fund(200n*U);const lots=await fundingLots(query,f.context);
  const missing:WithTransactionFn=fn=>run(client=>fn({query:(sql,params)=>sql.includes('select a.owner')?Promise.resolve({rows:[]}):client.query(sql,params)}));
  await assert.rejects(withPortfolioLock(f.id,()=>prepareStrategyJob(missing,{...f.context,observedCash:0n},lots)),/notification recipient unavailable/);
  assert.equal((await notifications(f)).length,0);
  assert.ok((await f.reserve({...f.context,observedCash:200n*U}))?.job,'exact cash boundary is affordable');
  assert.equal((await notifications(f)).length,0);
  const g=await fixture('stack');await g.fund(200n*U);
  await g.reserve({...g.context,enabled:false,observedCash:0n});assert.equal((await notifications(g)).length,0);
  await g.reserve({...g.context,marketOpen:false,observedCash:0n});assert.equal((await notifications(g)).length,0);
  await g.reserve({...g.context,now:new Date(start.getTime()+4*86400000),observedCash:0n});assert.equal((await notifications(g)).length,0);
  const h=await fixture('stack');await h.fund(200n*U);
  await h.reserve({...h.context,observedCash:200n*U-1n});assert.equal((await notifications(h)).length,2,'one raw short of classified cash records the shortfall');
});
test('#96 insufficient notifications reread conflicts without resetting delivery and reject changed immutable payloads',async()=>{
  for(const mismatch of [false,true]){
    const f=await fixture('stack');await f.fund(200n*U);const lots=await fundingLots(query,f.context);
    const competing:WithTransactionFn=fn=>run(client=>fn({query:async(sql,params)=>{
      if(sql.includes('insert into user_notifications')){
        const competingParams=params===undefined?[]:[...params];
        if(mismatch)competingParams[6]=JSON.stringify({budgetRaw:'0'});
        const inserted=await client.query(sql,competingParams);const event=inserted.rows[0];assert.ok(event&&typeof event==='object'&&'id' in event&&typeof event.id==='string');
        await client.query("update user_notifications set state='delivered',updated_at=clock_timestamp() where id=$1",[event.id]);
      }
      return client.query(sql,params);
    }}));
    const attempt=()=>withPortfolioLock(f.id,()=>prepareStrategyJob(competing,{...f.context,observedCash:0n},lots));
    if(mismatch){await assert.rejects(attempt(),/notification identity mismatch/);assert.equal((await notifications(f)).length,0);}
    else {await attempt();const saved=await notifications(f);assert.equal(saved.length,2);assert.ok(saved.every(e=>e.state==='delivered'));await f.reserve({...f.context,observedCash:0n});assert.deepEqual(await notifications(f),saved);}
  }
});


test('#124 removed historical holdings govern complete child groups without truncating the frozen vector',async()=>{
  const marketAt=new Date('2026-11-16T15:00:00Z');
  const f=await fixture('hold',0,4,'none',undefined,undefined,16);
  await f.fund(1000n*U);
  const active=new Set(f.allocation.assets.map(asset=>asset.address));
  const removed=Object.values(TESTNET_97.assets).map(asset=>asset.token).filter(asset=>!active.has(asset));
  const bought=new Set<Address>();
  const s=scheduler(f);
  s.deps.planPortfolio=async()=>{
    const current=plan(f);
    current.historicalAssetCount=active.size-1+removed.length;
    current.targets.push(...removed.map(asset=>({asset,weightBps:0,symbol:'removed'})));
    for(const asset of [...removed,...bought])current.snapshot.holdings.push({asset,amountWei:U,decimals:18,usdPriceE8:100000000n,priceSource:TWAP_PRICE_SOURCE});
    return current;
  };
  assert.equal((await s.once(marketAt)).results[0]?.outcome,'executed');
  assert.equal(s.sends[0]?.steps.length,8,'the complete safe child is half of this 16-asset basket, never a later 13-step truncation');
  const original=await job(f);assert.ok(original);
  for(const step of s.sends[0]?.steps??[])bought.add(step.tokenOut);
  assert.equal((await s.once(new Date(marketAt.getTime()+60000))).results[0]?.outcome,'executed');
  assert.equal(await job(f),null);
  assert.equal(s.sends.length,2);assert.ok(s.sends.every(send=>send.steps.length===8));
  const spent:Record<string,bigint>={};
  for(const send of s.sends)for(const step of send.steps){
    assert.ok(active.has(step.tokenOut),'removed holdings cannot be bought');
    spent[step.tokenOut.toLowerCase()]=(spent[step.tokenOut.toLowerCase()]??0n)+step.amountIn;
  }
  assert.deepEqual(Object.fromEntries(Object.entries(spent).map(([asset,amount])=>[asset,amount.toString()])),original.original_input);
});


async function versionTransitionEvidence(f: Fixture) {
  const rows = async (sql: string) => (await query(sql, [f.id])).rows;
  return {
    cash: await balances(f),
    lots: await rows('select * from strategy_funding_lots where portfolio_id=$1 order by id'),
    assets: await rows('select a.* from strategy_lot_assets a join strategy_funding_lots l on l.id=a.lot_id where l.portfolio_id=$1 order by a.lot_id,a.asset'),
    slices: await rows('select s.* from strategy_asset_slices s join strategy_funding_lots l on l.id=s.lot_id where l.portfolio_id=$1 order by s.lot_id,s.asset,s.slice_index'),
    jobs: await rows('select * from strategy_jobs where portfolio_id=$1 order by id'),
    operations: await rows('select * from operations where portfolio_id=$1 order by id'),
    portfolio: await rows('select version,schedule_state,last_rebalance_at from portfolios where id=$1'),
  };
}

for (const state of ['unstarted', 'reserved', 'partial', 'completed'] as const) {
  test(`#124 active version change fail-closes ${state} work and preserves all source cash for later rollover`, async () => {
    const f = await fixture(state === 'completed' ? 'hold' : 'stack');
    await f.fund(500n * U);
    if (state !== 'unstarted') {
      const reserved = (await f.reserve())?.job; assert.ok(reserved);
      if (state !== 'reserved') await complete(f, reserved);
    }
    const before = await versionTransitionEvidence(f), logs: string[] = [];
    const s = scheduler(f, { planPortfolio: async () => { const p = plan(f); p.pinnedVersion.version = 2; return p; }, log: line => logs.push(line) });
    assert.ok(s.deps.newMoney);
    s.deps.newMoney.policy = async () => { throw new Error('no capacity read before rollover'); };
    s.deps.newMoney.quote = async () => { throw new Error('no quote before rollover'); };
    for (const dryRun of [true, false, false]) {
      const result = (await s.once(start, dryRun)).results[0];
      assert.equal(result?.outcome, 'blocked');
      assert.match(result.reason, /\[PINNED_VERSION_CHANGED\]/);
      assert.deepEqual(await versionTransitionEvidence(f), before, 'retry must not alter lots, slices, jobs, operations or cash');
    }
    assert.equal(s.sends.length, 0);
    assert.ok(logs.some(line => line.includes('[PINNED_VERSION_CHANGED]')));
  });
}

test('#124 an old in-flight receipt settles once before the changed-version buy guard', async () => {
  const f = await fixture('stack'); await f.fund(500n * U);
  const s = scheduler(f); s.setStatus('unknown');
  assert.equal((await s.once()).results[0]?.outcome, 'blocked'); assert.equal(s.sends.length, 1);
  const original = (await query<{user_op_hash:string;payload_hash:string}>('select user_op_hash,payload_hash from operations where portfolio_id=$1', [f.id])).rows[0]; assert.ok(original);
  s.deps.planPortfolio = async () => { const p = plan(f); p.pinnedVersion.version = 2; return p; };
  assert.equal((await s.once(new Date(start.getTime() + 60000))).results[0]?.outcome, 'executed');
  const after = await versionTransitionEvidence(f);
  const result = (await s.once(new Date(start.getTime() + 120000))).results[0];
  assert.equal(result?.outcome, 'blocked'); assert.match(result.reason, /\[PINNED_VERSION_CHANGED\]/);
  assert.deepEqual(await versionTransitionEvidence(f), after); assert.equal(s.sends.length, 1);
  const settled = (await query<{state:string;user_op_hash:string;payload_hash:string}>('select state,user_op_hash,payload_hash from operations where portfolio_id=$1', [f.id])).rows;
  assert.equal(settled.length, 1); assert.equal(settled[0]?.state, 'confirmed');
  assert.equal(settled[0]?.user_op_hash, original.user_op_hash); assert.equal(settled[0]?.payload_hash, original.payload_hash);
});

test('#124 a fresh contribution accepted on active version 2 uses only its version 2 source', async () => {
  const f = await fixture('hold', 0, 4, 'none', undefined, undefined, 2, 2);
  await f.fund(100n * U);
  const s = scheduler(f);
  assert.equal((await s.once()).results[0]?.outcome, 'executed'); assert.equal(s.sends.length, 1);
  const lots = (await query<{version:number}>('select version from strategy_funding_lots where portfolio_id=$1', [f.id])).rows;
  assert.deepEqual(lots.map(l => l.version), [2]);
  const sent = s.sends[0]; assert.ok(sent);
  assert.equal(sumInputs(Object.fromEntries(sent.steps.map(step => [step.tokenOut, step.amountIn.toString()]))), 100n * U - R);
  assert.equal((await s.once()).results[0]?.outcome, 'noop'); assert.equal(s.sends.length, 1);
});

for (const phase of ['quote', 'refresh', 'sign'] as const) {
  test(`#124 typed version activation during ${phase} preserves principal and installment evidence without broadcast`, async () => {
    const f = await fixture('stack'); await f.fund(500n * U);
    const reserved = (await f.reserve())?.job; assert.ok(reserved);
    const before = await versionTransitionEvidence(f);
    let activeVersion = 1;
    const s = scheduler(f, { readBuyVersionWindow: async () => ({ activeVersion,
      timestamp: BigInt(Math.floor(start.getTime()/1000)), pendingActiveAt: null }),
      planPortfolio: async () => { const p = plan(f); p.pinnedVersion.version = activeVersion; return p; } });
    assert.ok(s.deps.newMoney);
    if (phase === 'quote') {
      const quote = s.deps.newMoney.quote; assert.ok(quote);
      s.deps.newMoney.quote = async (...args) => { const result = await quote(...args); activeVersion = 2; return result; };
    } else if (phase === 'refresh') s.deps.refreshFloors = async input => {
      activeVersion = 2; return { ok: true, steps: [...input.steps], refreshes: [], note: 'crossed activation' };
    };
    else s.deps.executeRebalance = async args => {
      activeVersion = 2; await args.beforeSending?.();
      s.sends.push(args); throw new Error('broadcast must not be reached');
    };
    const result = (await s.once()).results[0];
    assert.equal(result?.outcome, 'blocked'); assert.match(result.reason, /PINNED_VERSION_CHANGED/);
    assert.equal(s.sends.length, 0);
    const after = await versionTransitionEvidence(f);
    for (const key of ['cash', 'lots', 'assets', 'slices', 'portfolio'] as const) assert.deepEqual(after[key], before[key], key);
    const current = await job(f); assert.ok(current);
    assert.deepEqual(current.remaining_input, reserved.remaining_input); assert.equal(current.remaining_fee_raw, reserved.remaining_fee_raw);
    assert.ok(after.operations.every(row => typeof row === 'object' && row !== null && Reflect.get(row, 'state') === 'failed' && Reflect.get(row, 'user_op_hash') === null));
    const stopped = await versionTransitionEvidence(f);
    assert.match((await s.once()).results[0]?.reason ?? '', /PINNED_VERSION_CHANGED/);
    assert.deepEqual(await versionTransitionEvidence(f), stopped, 'retry cannot consume or rewrite old sources');
  });
}


test('My mix reserves only open asset sources and retains closed source budgets; ordinary funds keep their common market guard', async () => {
  const f = await fixture('hold'); await f.fund(100n * U);
  const marketOpenFor = (assets: readonly string[]) => assets.every(asset => asset !== b);
  assert.equal((await f.reserve({ ...f.context, marketOpen: false, marketOpenFor }))?.job, null);
  const mixed = (await f.reserve({ ...f.context, personalMix: true, marketOpen: false, marketOpenFor }))?.job;
  assert.ok(mixed); assert.deepEqual(Object.keys(mixed.remaining_input), [a]);
  const balance = await balances(f); assert.equal(balance?.unallocated_hold_raw, (50n * U).toString());
  const closed = (await query<{ state: string; n: string }>(`select a.state,(select count(*) from strategy_asset_slices s where s.lot_id=a.lot_id and s.asset=a.asset)::text as n
    from strategy_lot_assets a join strategy_funding_lots l on l.id=a.lot_id where l.portfolio_id=$1 and a.asset=$2`, [f.id, b])).rows[0];
  assert.deepEqual(closed, { state: 'active', n: '0' });
});

test('2026-11-23 portfolio 12: one-time money is not skipped while a withdrawal is still unreconciled; it buys once the chain agrees',async()=>{
  const f=await fixture('hold');await f.fund(200n*U);
  // The account shows less than is classified (a withdrawal whose evidence is not in yet): wait, never skip for good.
  for(let retry=0;retry<2;retry++)assert.match((await f.reserve({...f.context,observedCash:150n*U}))?.reason??'',/CASH_RECONCILIATION_PENDING/);
  assert.equal((await query("select id from strategy_asset_slices s join strategy_funding_lots l on l.id=s.lot_id where l.portfolio_id=$1 and s.state like 'skipped%'",[f.id])).rows.length,0);
  const job=(await f.reserve({...f.context,observedCash:200n*U}))?.job;
  assert.ok(job,'buys as soon as the cash matches');
});

test('2026-11-25 a deposit made after a withdrawal took an older, still unbought deposit is bought: the cash that left is counted against the oldest deposits',async()=>{
  // "Sell all" also returned 100 USDT of funding that was still waiting to be bought; then the owner buys again with 50.
  const f=await fixture('hold');const old=await f.fund(100n*U);
  const withdrawals=[{txHash:hash(),blockNumber:12n,blockHash:hash(),logIndex:0,amount:100n*U}];
  const fresh=await f.fund(50n*U,new Date(start.getTime()+3600000));
  const c={...f.context,now:new Date(start.getTime()+7200000),observedCash:50n*U,withdrawals};
  const j=(await f.reserve(c))?.job;assert.ok(j,'the new deposit is not skipped together with the old one');
  assert.equal(BigInt(j.amount_raw)+BigInt(j.fee_reserve_raw),50n*U);
  const states=async(lot:string)=>(await query<{state:string}>('select state from strategy_asset_slices where lot_id=$1 order by asset',[lot])).rows.map(r=>r.state);
  assert.deepEqual([await states(old),await states(fresh)],[['skipped_insufficient_funds','skipped_insufficient_funds'],['reserved','reserved']]);
  const after=await balances(f);assert.ok(after);
  assert.deepEqual([after.unallocated_hold_raw,BigInt(after.reserved_input_raw)+BigInt(after.reserved_fee_raw)],['0',50n*U]);
  assert.equal((await f.reserve(c))?.job?.id,j.id,'a restart resumes the same job');
  // Three deposits, 120 of 210 gone: the two oldest are skipped, the newest (50) buys; what is left over stays free cash.
  const g=await fixture('hold');const lots=[await g.fund(100n*U),await g.fund(60n*U,new Date(start.getTime()+60000)),await g.fund(50n*U,new Date(start.getTime()+120000))];
  const gj=(await g.reserve({...g.context,now:new Date(start.getTime()+7200000),observedCash:90n*U,withdrawals:[{txHash:hash(),blockNumber:12n,blockHash:hash(),logIndex:0,amount:120n*U}]}))?.job;assert.ok(gj);
  assert.equal(BigInt(gj.amount_raw)+BigInt(gj.fee_reserve_raw),50n*U);
  assert.deepEqual(await Promise.all(lots.map(states)),[['skipped_insufficient_funds','skipped_insufficient_funds'],['skipped_insufficient_funds','skipped_insufficient_funds'],['reserved','reserved']]);
  assert.equal((await balances(g))?.unallocated_hold_raw,(40n*U).toString());
  // No deposit fits what is left (one deposit of 100, 30 withdrawn): skipped as before, nothing bought, the 70 stays.
  const h=await fixture('hold');await h.fund(100n*U);
  const none=await h.reserve({...h.context,observedCash:70n*U,withdrawals:[{txHash:hash(),blockNumber:12n,blockHash:hash(),logIndex:0,amount:30n*U}]});
  assert.match(none?.reason??'',/SKIPPED_INSUFFICIENT_FUNDS/);assert.equal(none?.job,null);
  assert.equal((await balances(h))?.unallocated_hold_raw,(70n*U).toString());
  // A withdrawal whose evidence is not in yet still waits (never skips anything).
  const p=await fixture('hold');await p.fund(100n*U);await p.fund(50n*U,new Date(start.getTime()+60000));
  assert.match((await p.reserve({...p.context,observedCash:50n*U}))?.reason??'',/CASH_RECONCILIATION_PENDING/);
  assert.equal((await query("select s.lot_id from strategy_asset_slices s join strategy_funding_lots l on l.id=s.lot_id where l.portfolio_id=$1",[p.id])).rows.length,0);
});

test('2026-11-25 portfolios 28/30/32: the withdrawal after "sell all" is booked while the portfolio stays paused; a later buy and the free-cash check see an empty ledger',async()=>{
  resetPausedCashMemory();
  const f=await fixture('hold');await f.fund(100n*U);
  const j=(await f.reserve())?.job;assert.ok(j);await complete(f,j,j.remaining_input,R);
  // The sale's 99 USDT is the portfolio's own cash.
  await query('update strategy_cash_balances set allocated_cash_raw=$2,updated_at=clock_timestamp() where portfolio_id=$1',[f.id,(99n*U).toString()]);
  const events=[{txHash:hash(),blockNumber:12n,blockHash:hash(),logIndex:0,amount:99n*U}];
  const lines:string[]=[];let held=99n*U,plans=0,busy=false,proof=events;
  const deps:PausedCashDeps={chainId:97,query,withTransaction:run,log:l=>lines.push(l),readCash:async account=>account===f.account?held:UINT256_MAX,
    planPortfolio:async()=>{plans++;const p=plan(f);return {...p,snapshot:{...p.snapshot,holdings:[{asset:cash,amountWei:held,decimals:18,usdPriceE8:100000000n,priceSource:TWAP_PRICE_SOURCE}]}};},
    withdrawals:async(p)=>{assert.deepEqual(p,{portfolioId:f.id,strategyId:f.strategyId,account:f.account,personalMix:false});return proof;},
    lock:(p,work)=>busy?Promise.resolve(null):withPortfolioLock(p.portfolioId,work)};
  const claimed=async()=>BigInt((await query<{n:string}>(`select (unallocated_hold_raw+stack_prefund_raw+allocated_cash_raw+reserved_input_raw+reserved_fee_raw+withdrawal_raw+yield_raw)::text as n from strategy_cash_balances where portfolio_id=$1`,[f.id])).rows[0]?.n??'-1');
  // Not paused: the scheduler's own round reconciles it, this step does not look.
  held=0n;await runPausedCashRound(deps);assert.deepEqual([await claimed(),plans],[99n*U,0]);
  // Paused by the close, USDT still in the account: one balance read, nothing else.
  await query("update portfolios set schedule_state='paused' where id=$1",[f.id]);
  held=99n*U;await runPausedCashRound(deps);assert.deepEqual([await claimed(),plans],[99n*U,0]);
  // The owner took it to the wallet. Busy lock, an unresolved operation: left for the next round.
  held=0n;busy=true;await runPausedCashRound(deps);busy=false;assert.deepEqual([await claimed(),plans],[99n*U,0]);
  const pending=(await query<{id:string}>("insert into operations(portfolio_id,type,state,idempotency_key) values($1,'rebalance','pending',$2) returning id",[f.id,hash()])).rows[0];assert.ok(pending);
  await runPausedCashRound(deps);assert.equal(await claimed(),99n*U);
  await query('delete from operations where id=$1',[pending.id]);
  // No proven transfer to the owner: the ledger is kept, and the heavy read is not repeated until something changes.
  proof=[];resetPausedCashMemory();plans=0;
  await runPausedCashRound(deps);await runPausedCashRound(deps);assert.deepEqual([await claimed(),plans],[99n*U,1]);
  assert.ok(lines.some(l=>l.includes(`portfolio ${f.id} `)&&/仍高於鏈上/.test(l)));
  // With the evidence: booked, exactly once, and the portfolio is still paused.
  proof=events;resetPausedCashMemory();
  assert.ok((await runPausedCashRound(deps)).reconciled>=1);
  assert.equal(await claimed(),0n);
  assert.ok(lines.some(l=>l.includes(`portfolio ${f.id} 領回錢包的 99 USDT 已入帳`)));
  assert.deepEqual((await query<{type:string;state:string;tx_hash:string}>("select type,state,tx_hash from operations where portfolio_id=$1 and idempotency_key like 'cash-withdrawal:%'",[f.id])).rows,[{type:'withdraw',state:'confirmed',tx_hash:events[0]?.txHash}]);
  assert.equal((await query<{schedule_state:string}>('select schedule_state from portfolios where id=$1',[f.id])).rows[0]?.schedule_state,'paused');
  plans=0;await runPausedCashRound(deps);assert.equal(plans,0,'an empty ledger is not read again');
  // The owner buys again (the buy resumes the portfolio): the round of that buy sees the same evidence and reserves the new money.
  await query("update portfolios set schedule_state='active' where id=$1",[f.id]);
  await f.fund(50n*U,new Date(start.getTime()+3600000));
  const again=(await f.reserve({...f.context,now:new Date(start.getTime()+7200000),observedCash:50n*U,withdrawals:events}))?.job;assert.ok(again);
  assert.equal(BigInt(again.amount_raw)+BigInt(again.fee_reserve_raw),50n*U);
  // A backlog is spread over rounds: five full observations per round, the rest next round.
  const many=new Set<string>();
  for(let i=0;i<6;i++){const g=await fixture('hold');many.add(g.account);
    await query("update strategy_cash_balances set allocated_cash_raw=$2,updated_at=clock_timestamp() where portfolio_id=$1",[g.id,U.toString()]);
    await query("update portfolios set schedule_state='paused' where id=$1",[g.id]);}
  resetPausedCashMemory();plans=0;
  const backlog:PausedCashDeps={...deps,readCash:async account=>many.has(account)?0n:UINT256_MAX,withdrawals:async()=>[],
    planPortfolio:async id=>{plans++;const p=plan(f);return {...p,portfolioId:id,snapshot:{...p.snapshot,holdings:[]}};}};
  await runPausedCashRound(backlog);assert.equal(plans,PAUSED_CASH_RECONCILES_PER_ROUND);
  await runPausedCashRound(backlog);assert.equal(plans,6);
});

test('2026-11-25 portfolio 32: booking the withdrawal of a paused My mix also saves the valuation its list shows; a fund has none and a failed save books the withdrawal all the same',async()=>{
  const setup=async()=>{
    const f=await fixture('hold');await f.fund(100n*U);
    const j=(await f.reserve())?.job;assert.ok(j);await complete(f,j,j.remaining_input,R);
    await query('update strategy_cash_balances set allocated_cash_raw=$2,updated_at=clock_timestamp() where portfolio_id=$1',[f.id,(99n*U).toString()]);
    await query("update portfolios set schedule_state='paused' where id=$1",[f.id]);
    return f;
  };
  const claimed=async(id:number)=>BigInt((await query<{n:string}>(`select (unallocated_hold_raw+stack_prefund_raw+allocated_cash_raw+reserved_input_raw+reserved_fee_raw+withdrawal_raw+yield_raw)::text as n from strategy_cash_balances where portfolio_id=$1`,[id])).rows[0]?.n??'-1');
  const fund=await setup(),mix=await setup(),broken=await setup();
  const mixes=new Set([mix.id,broken.id]),accounts=new Set([fund.account,mix.account,broken.account]);
  const saved:[number,bigint][]=[];
  const deps:PausedCashDeps={chainId:97,withTransaction:run,log:()=>{},readCash:async account=>accounts.has(account)?0n:UINT256_MAX,
    // The list query as written; the three portfolios of this test are marked the way a My mix strategy would be.
    query:async(text,params)=>{const r=await query(text,params===undefined?[]:[...params]);
      return {rows:r.rows.map((row:Record<string,unknown>)=>'personal_mix' in row&&mixes.has(Number(row.portfolio_id))?{...row,personal_mix:true}:row)};},
    planPortfolio:async id=>{const p=plan(fund);return {...p,portfolioId:id,snapshot:{...p.snapshot,holdings:[]}};},
    withdrawals:async()=>[{txHash:hash(),blockNumber:12n,blockHash:hash(),logIndex:0,amount:99n*U}],
    lock:(p,work)=>withPortfolioLock(p.portfolioId,work),
    saveMixValue:async(p,observed)=>{assert.equal(p.personalMix,true);if(p.portfolioId===broken.id)throw new Error('valuation unavailable');
      saved.push([p.portfolioId,observed.snapshot.holdings.reduce((sum,h)=>sum+h.amountWei,0n)]);}};
  resetPausedCashMemory();
  for(let i=0;i<3&&(await claimed(fund.id)>0n||await claimed(mix.id)>0n||await claimed(broken.id)>0n);i++)await runPausedCashRound(deps);
  assert.deepEqual([await claimed(fund.id),await claimed(mix.id),await claimed(broken.id)],[0n,0n,0n]);
  assert.deepEqual(saved,[[mix.id,0n]],'the observation after the withdrawal: nothing left in the account');
  // Without the optional hook (tests, other callers) nothing changes.
  const plain=await setup();accounts.add(plain.account);mixes.add(plain.id);resetPausedCashMemory();
  const {saveMixValue:_unused,...rest}=deps;
  for(let i=0;i<3&&await claimed(plain.id)>0n;i++)await runPausedCashRound(rest);
  assert.equal(await claimed(plain.id),0n);assert.equal(saved.length,1);
});

test('2026-11-25 the paused-portfolio reconciliation runs in background live rounds on chain 97 only',async()=>{
  const f=await fixture('hold');const calls:number[]=[],cached:unknown[]=[];
  const s=scheduler(f,{pausedCashRound:async d=>{calls.push(d.chainId);assert.equal(await d.readCash(f.account),UINT256_MAX);
      // My mix valuation: saved under the mix this portfolio currently belongs to; a portfolio without one saves nothing.
      for(const portfolioId of [f.id,f.id+1_000_000])await d.saveMixValue?.({portfolioId,strategyId:f.strategyId,account:f.account,personalMix:true},plan(f));
      return {checked:0,reconciled:0,unresolved:0};},
    cacheMix:async(id,due)=>{cached.push([id,due.portfolioId,due.personalMix]);},
    query:async(text,params)=>/from mix_portfolio_history where portfolio_id=\$1 and ended_at is null/.test(text)?{rows:params?.[0]===f.id?[{id:'77'}]:[]}:query(text,params===undefined?[]:[...params])});
  await s.once();await s.once(start,true);assert.deepEqual(calls,[],'an owner call for one portfolio and a dry run leave it to the background round');
  await runSchedulerOnce({dryRun:false,now:start,limit:1},{...s.deps,priceSourceChecks:async()=>[]});assert.deepEqual(calls,[97]);
  assert.deepEqual(cached,[['77',f.id,true]]);
  await runSchedulerOnce({dryRun:true,now:start,limit:1},{...s.deps,priceSourceChecks:async()=>[]});
  await runSchedulerOnce({dryRun:false,now:start,limit:1},{...s.deps,chainId:56,priceSourceChecks:async()=>[]});assert.deepEqual(calls,[97]);
});

test('2026-11-23: an owner waiting for the shared DEX lane makes the scheduler yield, then gets the lane',async()=>{
  await migrate();
  const hold=await getPool().connect();
  try{
    // The scheduler is mid-portfolio (holds the lane); an owner starts waiting.
    await hold.query('select pg_advisory_lock(830083,97)');
    const owner=withDexLock(97,async()=>'owner',{waitMs:5_000,sleep:ms=>new Promise(r=>setTimeout(r,Math.min(ms,50)))});
    await new Promise(r=>setTimeout(r,100));
    // Scheduler's next portfolio: yields while the owner waits (even though the lane itself would be free).
    await hold.query('select pg_advisory_unlock(830083,97)');
    const scheduler=await withDexLock(97,async()=>'scheduler');
    assert.ok(scheduler===null||scheduler==='scheduler');
    assert.equal(await owner,'owner');
    assert.equal(await withDexLock(97,async()=>'scheduler'),'scheduler','flag released after the owner ran');
  }finally{hold.release();}
});

// ---- 2026-11-24 last-child fee (portfolios 13 and 17) --------------------------------------------------------------
// The executor's hourly fee window, as the contract computes it: T(c) = max(0, min(0.3, c x 1%) - c x 0.1%).
function feeWindowModel(){
  const minimum=3n*U/10n,w={start:0n,notional:0n,paid:0n};
  const T=(c:bigint)=>{const m=c/100n<minimum?c/100n:minimum,p=c/1000n;return m>p?m-p:0n;};
  const active=(at:bigint)=>w.start!==0n&&at<w.start+3600n;
  const due=(n:bigint,at:bigint)=>{const owed=T(n+(active(at)?w.notional:0n)),paid=active(at)?w.paid:0n;return n===0n||paid>=owed?0n:owed-paid;};
  const charge=(n:bigint,at:bigint)=>{if(!active(at)){w.start=at;w.notional=0n;w.paid=0n;}const d=due(n,at);w.notional+=n;w.paid+=d;return d;};
  return {due,charge};
}
/** The scheduler harness with the fee window wired in: the planner reads it, and each landed send is charged by it. */
function feeScheduler(f:Fixture,model=feeWindowModel(),extra:SchedulerDeps={}){
  let at=0n;const fees=new Map<ExecuteArgs,bigint>();
  const s=scheduler(f,extra);assert.ok(s.deps.newMoney);
  s.deps.newMoney.feeDue=async()=>async n=>model.due(n,at);
  const spent=(send:ExecuteArgs)=>Object.fromEntries(send.steps.map(step=>[step.tokenOut.toLowerCase(),step.amountIn.toString()]));
  const reconcile=s.deps.reconcileRebalance;assert.ok(reconcile);
  s.deps.reconcileRebalance=async input=>{
    const result=await reconcile(input),send=s.sends.at(-1);
    if(result.kind==='found'&&result.outcome.batchEvidence&&send){
      if(!fees.has(send))fees.set(send,model.charge(sumInputs(spent(send)),at));
      Object.assign(result.outcome.batchEvidence,{inputs:spent(send),feePaid:fees.get(send)});
    }
    return result;
  };
  return {...s,model,fees,spent,once:(now:Date)=>{at=BigInt(Math.floor(now.getTime()/1000));return s.once(now);}};
}
const usdt=(text:string)=>{const [whole,fraction='']=text.split('.');return BigInt(whole??'0')*U+BigInt((fraction+'0'.repeat(18)).slice(0,18));};
/** Leave a started job with exactly `left` principal (split evenly) and `feeLeft`, as earlier fee windows would. */
async function spendDownTo(f:Fixture,left:bigint,feeLeft:bigint){
  const j=(await f.reserve())?.job;assert.ok(j);
  const assets=Object.keys(j.remaining_input),each=left/BigInt(assets.length);
  const remaining=Object.fromEntries(assets.map((asset,i)=>[asset,(each+(i===0?left-each*BigInt(assets.length):0n)).toString()]));
  const spent=Object.fromEntries(assets.map(asset=>[asset,(BigInt(j.remaining_input[asset]??'0')-BigInt(remaining[asset]??'0')).toString()]));
  await complete(f,j,spent,BigInt(j.remaining_fee_raw)-feeLeft);
  const now=await job(f);assert.ok(now);assert.deepEqual(now.remaining_input,remaining);assert.equal(now.remaining_fee_raw,feeLeft.toString());
  return {job:now,remaining,firstSpent:sumInputs(spent),firstFee:BigInt(j.remaining_fee_raw)-feeLeft};
}
const jobState=async(id:string)=>(await query<{state:string}>('select state from strategy_jobs where id=$1',[id])).rows[0]?.state;
const sliceStates=async(id:string)=>(await query<{state:string}>('select state from strategy_asset_slices where job_id=$1',[id])).rows.map(r=>r.state);

test('last-child fee DB: portfolio 17 numbers (18.7331 left, 0.1207 fee, 7 assets) buy 18.6856, pay 0.1682 and finish; deposit = bought + fees + cash',async()=>{
  const f=await fixture('hold',0,4,'none',undefined,undefined,7);await f.fund(100n*U);
  const before=await spendDownTo(f,usdt('18.7331'),usdt('0.1207'));
  const s=feeScheduler(f),now=new Date('2026-11-16T15:00:00Z'); // US market hours: the seven assets include stock tokens
  // Before the fix this child was refused before sending every round: the top-up is 0.1686 and 0.1207 was left.
  assert.ok(s.model.due(usdt('18.7331'),0n)>usdt('0.1207'));
  const result=await s.once(now);
  assert.equal(result.results[0]?.outcome,'executed',result.results[0]?.reason);assert.equal(s.sends.length,1);
  const send=s.sends[0];assert.ok(send);const bought=sumInputs(s.spent(send)),fee=s.fees.get(send);assert.ok(fee!==undefined);
  assert.equal(send.steps.length,7);
  assert.equal((bought+U/20000n)/(U/10000n),186856n,'buys 18.6856');assert.equal((fee+U/20000n)/(U/10000n),1682n,'pays 0.1682');
  for(const step of send.steps)assert.ok(step.amountIn<BigInt(before.remaining[step.tokenOut.toLowerCase()]??'0'));
  // The sender's fee check gets the fee the job had left plus the principal this child gave up, and that covers the charge.
  assert.equal(send.feeBudget,usdt('0.1207')+usdt('18.7331')-bought);assert.ok(fee<=(send.feeBudget??0n));
  assert.equal(await job(f),null);assert.equal(await jobState(before.job.id),'completed');
  assert.deepEqual([...new Set(await sliceStates(before.job.id))],['completed']);
  const batch=(await query<{input_raw:Record<string,string>;fee_paid_raw:string;state:string}>('select input_raw,fee_paid_raw::text,state from strategy_job_batches where job_id=$1 order by batch_index desc limit 1',[before.job.id])).rows[0];
  assert.deepEqual(batch?.input_raw,before.remaining,'the batch records the principal taken from the job');
  // The principal given up pays first; the job's fee budget pays the rest (all of it but the sizing remainder).
  assert.equal(BigInt(batch?.fee_paid_raw??'0'),fee-(usdt('18.7331')-bought));assert.ok(usdt('0.1207')-BigInt(batch?.fee_paid_raw??'0')<U/100000n);assert.equal(batch?.state,'confirmed');
  const cash=await balances(f);assert.ok(cash);
  assert.equal(cash.reserved_input_raw,'0');assert.equal(cash.reserved_fee_raw,'0');assert.equal(cash.unallocated_hold_raw,'0');
  assert.ok(BigInt(cash.allocated_cash_raw)<U/100000n,'under 0.00001 USDT is left as cash');
  // Deposit = bought + fees + cash kept, to the raw unit.
  assert.equal(before.firstSpent+bought+before.firstFee+fee+BigInt(cash.allocated_cash_raw),100n*U);
  assert.equal((await query('select 1 from operations where portfolio_id=$1 and state<>$2',[f.id,'confirmed'])).rows.length,0,'no failed attempt');
  assert.equal((await s.once(new Date(+now+60000))).results[0]?.outcome,'noop');assert.equal(s.sends.length,1);
  assert.deepEqual(await balances(f),cash);
});

test('last-child fee DB: a job that runs into a second fee window pays that window from the child, finishes, and conserves the deposit',async()=>{
  const f=await fixture();await f.fund(300n*U);const s=feeScheduler(f);assert.ok(s.deps.newMoney);
  s.deps.newMoney.policy=async()=>({reserve:R,caps:new Map([[a,50n*U],[b,50n*U]]),buyLimit:100n*U,cash:10000n*U});
  // Window 1: the first child's top-up (0.2001) fits the 0.27 the job reserved.
  assert.equal((await s.once(start)).results[0]?.outcome,'executed');
  const first=s.sends[0];assert.ok(first);const full=sumInputs(s.spent(first));
  assert.equal(first.feeBudget,R);assert.equal(s.fees.get(first),3n*U/10n-full/1000n);
  const afterFirst=await job(f);assert.ok(afterFirst);const feeLeft=BigInt(afterFirst.remaining_fee_raw);assert.equal(feeLeft,R-(s.fees.get(first)??0n));
  // Window 2, two hours later: the same top-up is due again and only 0.07 is left. The child buys less and pays it.
  const later=new Date(+start+7200000);
  assert.ok(s.model.due(full,BigInt(later.getTime()/1000))>feeLeft);
  assert.equal((await s.once(later)).results[0]?.outcome,'executed');
  const second=s.sends[1];assert.ok(second);const reduced=sumInputs(s.spent(second)),secondFee=s.fees.get(second);assert.ok(secondFee!==undefined);
  assert.ok(reduced<full&&full-reduced<U/5n);assert.equal(second.feeBudget,feeLeft+full-reduced);assert.ok(secondFee<=(second.feeBudget??0n));
  const afterSecond=await job(f);assert.ok(afterSecond);assert.ok(BigInt(afterSecond.remaining_fee_raw)<U/100000n,'the fee budget is used up');assert.equal(afterSecond.failure_count,0);
  assert.equal(sumInputs(afterSecond.remaining_input),sumInputs(afterFirst.remaining_input)-full,'the job gave the child its full principal');
  // Same window, a minute later: the window is paid, so the last child buys everything that is left.
  assert.equal((await s.once(new Date(+later+60000))).results[0]?.outcome,'executed');
  const third=s.sends[2];assert.ok(third);assert.equal(sumInputs(s.spent(third)),sumInputs(afterSecond.remaining_input));assert.equal(s.fees.get(third),0n);
  assert.equal(await job(f),null);assert.equal(await jobState(afterFirst.id),'completed');assert.equal(s.sends.length,3);
  const cash=await balances(f);assert.ok(cash);assert.equal(cash.reserved_input_raw,'0');assert.equal(cash.reserved_fee_raw,'0');
  const bought=s.sends.reduce((sum,send)=>sum+sumInputs(s.spent(send)),0n),fees=[...s.fees.values()].reduce((sum,fee)=>sum+fee,0n);
  assert.equal(bought+fees+BigInt(cash.allocated_cash_raw),300n*U,'deposit = bought + fees + cash kept');
  assert.ok(BigInt(cash.allocated_cash_raw)<U/1000n);
  assert.equal((await query('select 1 from operations where portfolio_id=$1 and state<>$2',[f.id,'confirmed'])).rows.length,0,'no failed attempt in any window');
});

test('last-child fee DB: a fee-paying child whose receipt times out settles later from its own receipt, once',async()=>{
  const f=await fixture('hold',0,4,'none',undefined,undefined,7);await f.fund(100n*U);
  const before=await spendDownTo(f,usdt('18.7331'),usdt('0.1207'));
  const s=feeScheduler(f),now=new Date('2026-11-16T15:00:00Z');s.setStatus('unknown');
  assert.equal((await s.once(now)).results[0]?.outcome,'blocked');assert.equal(s.sends.length,1);
  const send=s.sends[0];assert.ok(send);const bought=sumInputs(s.spent(send));assert.ok(bought<usdt('18.7331'));
  const reserved=await balances(f);assert.equal(reserved?.reserved_input_raw,usdt('18.7331').toString());
  // Restart: only the batch row (the principal taken) and the original UserOp are known.
  const fee=s.model.charge(bought,BigInt(now.getTime()/1000));
  const resumed=scheduler(f,{executeRebalance:async()=>{throw new Error('must reconcile instead of resending');},reconcileRebalance:async input=>{
    assert.deepEqual(input.expectedInputs,before.remaining);const original=await s.deps.reconcileRebalance?.(input);assert.ok(original&&original.kind==='found'&&original.outcome.batchEvidence);
    Object.assign(original.outcome.batchEvidence,{inputs:s.spent(send),feePaid:fee});return original;}});
  assert.equal((await resumed.once(new Date(+now+60000))).results[0]?.outcome,'executed');assert.equal(resumed.sends.length,0);
  assert.equal(await job(f),null);assert.equal(await jobState(before.job.id),'completed');
  const cash=await balances(f);assert.ok(cash);assert.equal(cash.reserved_input_raw,'0');assert.equal(cash.reserved_fee_raw,'0');
  assert.equal(before.firstSpent+bought+before.firstFee+fee+BigInt(cash.allocated_cash_raw),100n*U);
  assert.equal((await resumed.once(new Date(+now+120000))).results[0]?.outcome,'noop');assert.deepEqual(await balances(f),cash);
});

test('last-child fee DB: principal set aside for a fee the window did not charge is kept as cash, never lost or re-bought',async()=>{
  const f=await fixture();await f.fund(100n*U);
  const before=await spendDownTo(f,20n*U,0n);
  const s=feeScheduler(f),now=new Date(+start+60000);
  // Sized against a fresh window (0.18 due on 20), but another batch opened and paid the window before this one landed.
  const reconcile=s.deps.reconcileRebalance;assert.ok(reconcile);
  s.deps.reconcileRebalance=async input=>{const result=await reconcile(input);if(result.kind==='found'&&result.outcome.batchEvidence)result.outcome.batchEvidence.feePaid=U/100n;return result;};
  assert.equal((await s.once(now)).results[0]?.outcome,'executed');
  const send=s.sends[0];assert.ok(send);const bought=sumInputs(s.spent(send));assert.ok(bought<20n*U);
  assert.equal(await job(f),null);assert.equal(await jobState(before.job.id),'completed');
  const cash=await balances(f);assert.ok(cash);assert.equal(cash.reserved_input_raw,'0');assert.equal(cash.reserved_fee_raw,'0');
  assert.equal(BigInt(cash.allocated_cash_raw),20n*U-bought-U/100n);
  assert.equal(before.firstSpent+bought+before.firstFee+U/100n+BigInt(cash.allocated_cash_raw),100n*U);
  // A fee above what the child and the job set aside is still refused: the attempt stays in flight for reconciliation.
  const g=await fixture();await g.fund(100n*U);await spendDownTo(g,20n*U,0n);
  const t=feeScheduler(g),again=t.deps.reconcileRebalance;assert.ok(again);
  t.deps.reconcileRebalance=async input=>{const result=await again(input);if(result.kind==='found'&&result.outcome.batchEvidence)result.outcome.batchEvidence.feePaid=U;return result;};
  assert.notEqual((await t.once(now)).results[0]?.outcome,'executed');
  assert.equal((await balances(g))?.reserved_input_raw,(20n*U).toString());assert.equal((await job(g))?.remaining_fee_raw,'0');
});

test('last-child fee DB: what is left under one minimum batch is cancelled once, its cash released, and never retried',async()=>{
  const f=await fixture();await f.fund(100n*U);
  // 9.90 principal + 0.05 fee = 9.95: under the 10 USDT batch minimum for good (the fee can only shrink).
  const before=await spendDownTo(f,usdt('9.9'),usdt('0.05'));
  const s=feeScheduler(f),now=new Date(+start+60000);
  const result=await s.once(now);
  assert.equal(result.results[0]?.outcome,'noop');assert.match(result.results[0]?.reason??'',/\[BELOW_MIN_BATCH\]/);
  assert.equal(s.sends.length,0);assert.equal(await job(f),null);assert.equal(await jobState(before.job.id),'cancelled');
  assert.deepEqual([...new Set(await sliceStates(before.job.id))],['cancelled']);
  const cash=await balances(f);assert.ok(cash);
  assert.equal(cash.unallocated_hold_raw,usdt('9.95').toString(),'principal and fee are back in the free cash');
  assert.equal(cash.reserved_input_raw,'0');assert.equal(cash.reserved_fee_raw,'0');assert.equal(cash.stack_prefund_raw,'0');
  assert.equal(before.firstSpent+before.firstFee+BigInt(cash.unallocated_hold_raw)+BigInt(cash.allocated_cash_raw),100n*U,'deposit = bought + fees + released');
  const operations=(await query<{state:string}>('select state from operations where portfolio_id=$1',[f.id])).rows.map(r=>r.state);
  assert.deepEqual(operations,['confirmed'],'no attempt was written for the cancelled remainder');
  for(const minutes of [2,3,70]){
    const next=await s.once(new Date(+start+minutes*60000));
    assert.equal(next.results[0]?.outcome,'noop');assert.doesNotMatch(next.results[0]?.reason??'',/BELOW_MIN_BATCH/);
  }
  assert.equal(s.sends.length,0);assert.deepEqual(await balances(f),cash);
  assert.equal((await query('select 1 from operations where portfolio_id=$1',[f.id])).rows.length,1);
  assert.equal((await query("select 1 from strategy_jobs where portfolio_id=$1 and state in ('reserved','running','unknown','paused')",[f.id])).rows.length,0);
  // A new deposit is no longer queued behind the dead job.
  await f.fund(50n*U,new Date(+start+71*60000));
  assert.equal((await s.once(new Date(+start+72*60000))).results[0]?.outcome,'executed');assert.equal(s.sends.length,1);
});

test('last-child fee DB: a child that cannot carry its fee at all is released instead of blocking every round; an unreadable fee changes nothing',async()=>{
  const f=await fixture('stack');await f.fund(500n*U);const s=feeScheduler(f);assert.ok(s.deps.newMoney);
  const untouched=await balances(f);
  s.deps.newMoney.feeDue=async()=>{throw new Error('[MIN_FEE_UNAVAILABLE] 無法確認本批最低費，不買入');};
  assert.equal((await s.once(start)).results[0]?.outcome,'blocked');assert.equal(s.sends.length,0);
  const waiting=await job(f);assert.ok(waiting);assert.equal(waiting.state,'reserved');
  assert.equal((await query('select 1 from operations where portfolio_id=$1',[f.id])).rows.length,0);
  // The executor asks for more than the whole child holds.
  s.deps.newMoney.feeDue=async()=>async()=>1000n*U;
  const result=await s.once(new Date(+start+60000));
  assert.equal(result.results[0]?.outcome,'noop');assert.match(result.results[0]?.reason??'',/\[FEE_OVER_BUDGET\]/);
  assert.equal(s.sends.length,0);assert.equal(await job(f),null);assert.equal(await jobState(waiting.id),'cancelled');
  assert.deepEqual(await balances(f),untouched,'the reserved principal and fee are back where they came from');
  assert.equal((await s.once(new Date(+start+120000))).results[0]?.outcome,'noop');assert.equal(s.sends.length,0);
});

// ---- 2026-11-24 [BASKET_WAITING] that never clears (portfolio 7; remainders that need several transactions) --------
const sourceRows=async(f:Fixture)=>(await query<{asset:string;state:string;slices:string[]}>(`select a.asset,a.state,
  array(select s.state from strategy_asset_slices s where s.lot_id=a.lot_id and s.asset=a.asset order by s.slice_index) as slices
  from strategy_lot_assets a join strategy_funding_lots l on l.id=a.lot_id where l.portfolio_id=$1 and a.asset<>$2 order by a.lot_id,a.asset`,[f.id,cash])).rows;

test('basket waiting DB: portfolio 7 — a stock leg under 10 USDT left pending by a split made before the keep-together rule is closed at the open and its cash left free, once',async()=>{
  // 33.37 USDT, 74.16% crypto (a) and 25.84% stock (b). Before the keep-together rule the crypto leg was bought on the
  // Saturday and the 8.62 USDT stock leg stayed pending by itself; baskets split that way are still out there. Two
  // single-asset lots give exactly that state: a's bought, b's waiting for its market.
  const f=await fixture('hold',0,4,'none',undefined,[7416,2584]);
  const stockBudget=usdt('33.37')*2584n/10000n;assert.ok(stockBudget<10n*U);
  const closed=(assets:readonly string[])=>assets.every(asset=>asset!==b),open=()=>true;
  const mix=(now:Date,marketOpenFor:(assets:readonly string[])=>boolean)=>f.reserve({...f.context,personalMix:true,now,marketOpen:marketOpenFor([a,b]),marketOpenFor});
  await f.fund(usdt('33.37')-stockBudget,new Date(+start-60000),{[a]:1},{weights:{[a]:10000},capped:[b]},10n*U);
  const first=(await mix(start,closed))?.job;assert.ok(first);assert.deepEqual(Object.keys(first.remaining_input),[a]);
  await complete(f,first,first.remaining_input,R);
  await f.fund(stockBudget,new Date(+start+60000),{[b]:1},{weights:{[b]:10000},capped:[a]},U);
  const waiting=await balances(f);assert.equal(waiting?.unallocated_hold_raw,stockBudget.toString());
  // Still closed: the stock leg waits for its market, nothing is recorded.
  for(const minutes of [5,600]){
    const result=await mix(new Date(+start+minutes*60000),closed);
    assert.equal(result?.job,null);assert.match(result?.reason??'',/\[MARKET_CLOSED\]/);
  }
  assert.deepEqual((await sourceRows(f)).find(r=>r.asset===b),{asset:b,state:'active',slices:[]});
  // Monday's open. Before #275 every round from here on answered [BASKET_WAITING] with the same 8.62, for good.
  const monday=new Date(+start+2*86400000+5400000);
  const released=await mix(monday,open);
  assert.equal(released?.job,null);assert.match(released?.reason??'',/\[BELOW_MIN_BATCH\].*8\.62.*可用現金/);
  assert.deepEqual((await sourceRows(f)).find(r=>r.asset===b),{asset:b,state:'completed',slices:['skipped_window']},'the source is closed, so the basket no longer has new money pending');
  const slice=(await query<{budget_raw:string;job_id:string|null;amount_raw:string}>(`select s.budget_raw::text,s.job_id,s.amount_raw::text from strategy_asset_slices s
    join strategy_funding_lots l on l.id=s.lot_id where l.portfolio_id=$1 and s.asset=$2`,[f.id,b])).rows[0];
  assert.deepEqual(slice,{budget_raw:stockBudget.toString(),job_id:null,amount_raw:'0'});
  const free=await balances(f);assert.ok(free);
  assert.equal(free.unallocated_hold_raw,stockBudget.toString(),'the cash did not move: it is simply no longer tied to a pending buy');
  assert.equal(free.reserved_input_raw,'0');assert.equal(free.reserved_fee_raw,'0');assert.equal(free.stack_prefund_raw,'0');
  assert.equal((await query("select 1 from strategy_jobs where portfolio_id=$1 and state<>'completed'",[f.id])).rows.length,0,'no job was created for it');
  // Later rounds find nothing to do and change nothing.
  for(const minutes of [1,30,1500]){
    const again=await mix(new Date(+monday+minutes*60000),open);
    assert.equal(again?.job,null);assert.match(again?.reason??'',/\[NO_DUE_SLOT\]/);
  }
  assert.deepEqual(await balances(f),free);assert.equal((await sourceRows(f)).flatMap(r=>r.slices).length,2);
  // A later deposit buys by itself: both legs, only its own money.
  await f.fund(100n*U,new Date(+monday+1600*60000));
  const next=(await mix(new Date(+monday+1601*60000),open))?.job;assert.ok(next);
  assert.deepEqual(Object.keys(next.remaining_input).sort(),[a,b].sort());assert.equal(BigInt(next.amount_raw)+BigInt(next.fee_reserve_raw),100n*U);
  assert.equal((await balances(f))?.unallocated_hold_raw,stockBudget.toString());
});

test('basket waiting DB: an open part under 10 USDT keeps waiting while other legs are closed, then the whole deposit is bought together',async()=>{
  const f=await fixture('hold',0,4,'none',undefined,[1500,8500]);await f.fund(50n*U);
  const closed=(assets:readonly string[])=>assets.every(asset=>asset!==b),open=()=>true;
  const mix=(now:Date,marketOpenFor:(assets:readonly string[])=>boolean)=>f.reserve({...f.context,personalMix:true,now,marketOpen:marketOpenFor([a,b]),marketOpenFor});
  const before=await balances(f);
  for(const minutes of [0,5,600]){
    const result=await mix(new Date(+start+minutes*60000),closed);
    assert.equal(result?.job,null);assert.match(result?.reason??'',/\[BASKET_WAITING\]/,'7.5 USDT of crypto waits for the stock leg');
  }
  assert.deepEqual((await sourceRows(f)).map(r=>[r.state,r.slices.length]),[['active',0],['active',0]]);assert.deepEqual(await balances(f),before);
  const together=(await mix(new Date(+start+2*86400000),open))?.job;assert.ok(together);
  assert.deepEqual(Object.keys(together.remaining_input).sort(),[a,b].sort());assert.equal(BigInt(together.amount_raw)+BigInt(together.fee_reserve_raw),50n*U);
});

const pendingSources=async(f:Fixture)=>(await query(`select 1 from strategy_lot_assets a join strategy_funding_lots l on l.id=a.lot_id
  where l.portfolio_id=$1 and a.state='active'`,[f.id])).rows.length;
// ---- 2026-11-25 keep-together rule: a closed part that could not form a batch by itself is not split off ------------
// A private basket bought while the US market is closed buys its crypto legs now and leaves the stock legs for the
// open. When the part left for the open is under one batch (10 USDT per transaction), it used to be handed back as cash
// at the open (#275). Now the whole deposit waits and one job buys every leg once all markets are open.
const tokens=(n:number)=>Object.values(TESTNET_97.assets).slice(0,n).map(t=>t.token);
const mixRound=(f:Fixture,closedAssets:readonly string[],extra:Partial<JobContext>={})=>(now:Date,marketClosed:boolean)=>{
  const marketOpenFor=(assets:readonly string[])=>!marketClosed||assets.every(asset=>!closedAssets.includes(asset));
  return f.reserve({...f.context,...extra,personalMix:true,now,marketOpen:!marketClosed,marketOpenFor});
};
const saturday=start,monday=new Date(+start+2*86400000+5400000);

test('keep together DB: portfolio 7 numbers — the stock leg alone is 8.62 USDT, so nothing is bought while it is closed and one job buys the whole 33.37 at the open',async()=>{
  // The minimum of 10 USDT is also what a DCA (定投) tranche is admitted with: a tranche that reaches its buy after the close follows the same rule.
  const f=await fixture('hold',0,4,'none',undefined,[7416,2584]);await f.fund(usdt('33.37'),new Date(+start-60000),{[a]:1,[b]:1},undefined,10n*U);
  assert.ok(usdt('33.37')*2584n/10000n<10n*U);
  const round=mixRound(f,[b]),before=await balances(f);
  assert.equal(before?.unallocated_hold_raw,usdt('33.37').toString());
  // Saturday and Sunday: the same answer every round, and nothing is written. Before the rule the first round bought the crypto leg.
  for(const minutes of [0,5,600,2000]){
    const result=await round(new Date(+saturday+minutes*60000),true);
    assert.equal(result?.job,null);assert.match(result?.reason??'',/^\[MARKET_CLOSED\]/);
  }
  assert.deepEqual((await sourceRows(f)).map(r=>[r.state,r.slices.length]),[['active',0],['active',0]]);
  assert.deepEqual(await balances(f),before);assert.equal((await query('select 1 from strategy_jobs where portfolio_id=$1',[f.id])).rows.length,0);
  assert.equal(await pendingSources(f),2,'both legs are still new money to buy');
  // Monday's open: one job, both legs, the whole deposit.
  const together=(await round(monday,false))?.job;assert.ok(together);
  assert.deepEqual(Object.keys(together.remaining_input).sort(),[a,b].sort());
  assert.equal(BigInt(together.amount_raw)+BigInt(together.fee_reserve_raw),usdt('33.37'));
  await complete(f,together,together.remaining_input,R);
  assert.ok((await sourceRows(f)).every(r=>r.state==='completed'&&r.slices.length===1&&r.slices[0]==='completed'));
  assert.deepEqual(await balances(f),{unallocated_hold_raw:'0',stack_prefund_raw:'0',allocated_cash_raw:'0',reserved_input_raw:'0',reserved_fee_raw:'0'},'nothing is left behind as cash');
  assert.match((await round(new Date(+monday+60000),false))?.reason??'',/\[NO_DUE_SLOT\]/);
});

test('keep together DB: a stock part of 10 USDT or more is still split — crypto now, stocks at the open; a second deposit that lifts the stock part over 10 USDT releases the crypto legs',async()=>{
  // 50 USDT: crypto 37.08, stock 12.92. Unchanged behaviour.
  const f=await fixture('hold',0,4,'none',undefined,[7416,2584]);await f.fund(50n*U);
  const round=mixRound(f,[b]);
  const crypto=(await round(saturday,true))?.job;assert.ok(crypto);assert.deepEqual(Object.keys(crypto.remaining_input),[a]);
  await complete(f,crypto,crypto.remaining_input,R);
  assert.equal((await balances(f))?.unallocated_hold_raw,(50n*U*2584n/10000n).toString());
  assert.match((await round(new Date(+saturday+600*60000),true))?.reason??'',/^\[MARKET_CLOSED\]/);
  const stock=(await round(monday,false))?.job;assert.ok(stock);assert.deepEqual(Object.keys(stock.remaining_input),[b]);
  assert.equal(BigInt(stock.amount_raw)+BigInt(stock.fee_reserve_raw),50n*U*2584n/10000n);
  await complete(f,stock,stock.remaining_input,R);
  assert.ok((await sourceRows(f)).every(r=>r.state==='completed'));assert.equal((await balances(f))?.unallocated_hold_raw,'0');
  // Two deposits of 33.37 on the same weekend: the first waits (8.62 of stock); with the second the stock part is 17.24, a batch by itself.
  const g=await fixture('hold',0,4,'none',undefined,[7416,2584]);await g.fund(usdt('33.37'),new Date(+start-60000),{[a]:1,[b]:1},undefined,10n*U);
  const again=mixRound(g,[b]);
  assert.match((await again(saturday,true))?.reason??'',/^\[MARKET_CLOSED\]/);
  await g.fund(usdt('33.37'),new Date(+saturday+30*60000),{[a]:1,[b]:1},undefined,10n*U);
  const both=(await again(new Date(+saturday+40*60000),true))?.job;assert.ok(both);assert.deepEqual(Object.keys(both.remaining_input),[a]);
  assert.equal(BigInt(both.amount_raw)+BigInt(both.fee_reserve_raw),2n*(usdt('33.37')-usdt('33.37')*2584n/10000n));
  await complete(g,both,both.remaining_input,R);
  const stocks=(await again(monday,false))?.job;assert.ok(stocks);assert.deepEqual(Object.keys(stocks.remaining_input),[b]);
  assert.equal(BigInt(stocks.amount_raw)+BigInt(stocks.fee_reserve_raw),2n*(usdt('33.37')*2584n/10000n));
});

test('keep together DB: whichever side is under 10 USDT — crypto, stock or both — the deposit waits for the open and is then bought whole',async()=>{
  // [crypto weight, stock weight, deposit]: stock part small; crypto part small (unchanged, [BASKET_WAITING]); both small.
  for(const [weights,amount,reason] of [[[8500,1500],50n*U,/^\[MARKET_CLOSED\]/],[[1500,8500],50n*U,/^\[BASKET_WAITING\]/],[[5000,5000],15n*U,/^\[MARKET_CLOSED\]/]] as const){
    const f=await fixture('hold',0,4,'none',undefined,weights);await f.fund(amount,new Date(+start-60000),{[a]:1,[b]:1},undefined,10n*U);
    const round=mixRound(f,[b]),before=await balances(f);
    for(const minutes of [0,5,600]){
      const result=await round(new Date(+saturday+minutes*60000),true);
      assert.equal(result?.job,null);assert.match(result?.reason??'',reason);
    }
    assert.deepEqual((await sourceRows(f)).map(r=>[r.state,r.slices.length]),[['active',0],['active',0]]);assert.deepEqual(await balances(f),before);
    const together=(await round(monday,false))?.job;assert.ok(together);
    assert.deepEqual(Object.keys(together.remaining_input).sort(),[a,b].sort());assert.equal(BigInt(together.amount_raw)+BigInt(together.fee_reserve_raw),amount);
    await complete(f,together,together.remaining_input,R);
    assert.equal((await balances(f))?.unallocated_hold_raw,'0');assert.ok((await sourceRows(f)).every(r=>r.state==='completed'));
  }
});

test('keep together DB: more assets than one transaction carries — the stock part has to fill every transaction it needs, else the deposit stays whole',async()=>{
  // Five assets, two per transaction: the three stocks need two transactions of 10 USDT each.
  const weights=[3200,3200,1200,1200,1200],[c1,c2,s1,s2,s3]=tokens(5);assert.ok(c1&&c2&&s1&&s2&&s3);
  // 50 USDT: stocks 18 in all. Over 10, but not two transactions' worth: keep together.
  const f=await fixture('hold',0,4,'none',undefined,weights,5);await f.fund(50n*U);
  const round=mixRound(f,[s1,s2,s3],{batchStepLimit:2}),before=await balances(f);
  for(const minutes of [0,600]){
    const result=await round(new Date(+saturday+minutes*60000),true);
    assert.equal(result?.job,null);assert.match(result?.reason??'',/^\[MARKET_CLOSED\]/);
  }
  assert.ok((await sourceRows(f)).every(r=>r.state==='active'&&r.slices.length===0));assert.deepEqual(await balances(f),before);
  const together=(await round(monday,false))?.job;assert.ok(together);
  assert.equal(Object.keys(together.remaining_input).length,5);assert.equal(BigInt(together.amount_raw)+BigInt(together.fee_reserve_raw),50n*U);
  // With sixteen per transaction the same 18 USDT of stocks is one transaction: split as before.
  const g=await fixture('hold',0,4,'none',undefined,weights,5);await g.fund(50n*U);
  const wide=(await mixRound(g,[s1,s2,s3])(saturday,true))?.job;assert.ok(wide);assert.deepEqual(Object.keys(wide.remaining_input).sort(),[c1,c2].sort());
  // 100 USDT, two per transaction: stocks 36, enough for two transactions: split as before.
  const h=await fixture('hold',0,4,'none',undefined,weights,5);await h.fund(100n*U);
  const hround=mixRound(h,[s1,s2,s3],{batchStepLimit:2});
  const crypto=(await hround(saturday,true))?.job;assert.ok(crypto);assert.deepEqual(Object.keys(crypto.remaining_input).sort(),[c1,c2].sort());
  await complete(h,crypto,crypto.remaining_input,R);
  const stocks=(await hround(monday,false))?.job;assert.ok(stocks);assert.deepEqual(Object.keys(stocks.remaining_input).sort(),[s1,s2,s3].sort());
  assert.equal(BigInt(stocks.amount_raw)+BigInt(stocks.fee_reserve_raw),36n*U);
});

test('keep together DB: when the open comes and the batch still cannot form, #275 applies — the sources are closed once and the cash stays free in this portfolio',async()=>{
  // Kept whole over the weekend; at the open one asset per transaction is all that fits (many assets held), so 8.62 cannot fill its own.
  const f=await fixture('hold',0,4,'none',undefined,[7416,2584]);await f.fund(usdt('33.37'),new Date(+start-60000),{[a]:1,[b]:1},undefined,10n*U);
  assert.match((await mixRound(f,[b])(saturday,true))?.reason??'',/^\[MARKET_CLOSED\]/);
  const narrow=mixRound(f,[b],{batchStepLimit:1});
  const released=await narrow(monday,false);
  assert.equal(released?.job,null);assert.match(released?.reason??'',/\[BELOW_MIN_BATCH\].*33\.37 USDT.*2 個來源/);
  assert.ok((await sourceRows(f)).every(r=>r.state==='completed'&&r.slices.length===1&&r.slices[0]==='skipped_window'));
  const free=await balances(f);
  assert.deepEqual(free,{unallocated_hold_raw:usdt('33.37').toString(),stack_prefund_raw:'0',allocated_cash_raw:'0',reserved_input_raw:'0',reserved_fee_raw:'0'},'the whole deposit is free cash of this portfolio');
  assert.equal(await pendingSources(f),0,'the basket is back to its own rebalance, which uses this cash');
  for(const minutes of [1,1500])assert.match((await narrow(new Date(+monday+minutes*60000),false))?.reason??'',/\[NO_DUE_SLOT\]/);
  assert.deepEqual(await balances(f),free);
  // Split on the weekend (stocks 15 USDT, a batch then); at the open two transactions are needed and 15 cannot fill both.
  const [c1,s1,s2]=tokens(3);assert.ok(c1&&s1&&s2);
  const g=await fixture('hold',0,4,'none',undefined,[7000,1500,1500],3);await g.fund(50n*U);
  const crypto=(await mixRound(g,[s1,s2])(saturday,true))?.job;assert.ok(crypto);assert.deepEqual(Object.keys(crypto.remaining_input),[c1]);
  await complete(g,crypto,crypto.remaining_input,R);
  const gone=await mixRound(g,[s1,s2],{batchStepLimit:1})(monday,false);
  assert.equal(gone?.job,null);assert.match(gone?.reason??'',/\[BELOW_MIN_BATCH\].*15 USDT.*2 個來源/);
  assert.equal((await balances(g))?.unallocated_hold_raw,(15n*U).toString());assert.equal(await pendingSources(g),0);
});

test('keep together DB: a fund (not a private basket) never splits — the whole deposit waits for every market, whatever the sizes',async()=>{
  for(const weights of [[7416,2584],[5000,5000]] as const){
    const f=await fixture('hold',0,4,'none',undefined,weights);await f.fund(100n*U);
    const marketOpenFor=(assets:readonly string[])=>assets.every(asset=>asset!==b),before=await balances(f);
    const waiting=await f.reserve({...f.context,marketOpen:false,marketOpenFor});
    assert.equal(waiting?.job,null);assert.match(waiting?.reason??'',/^\[MARKET_CLOSED\]/);
    assert.deepEqual(await balances(f),before);assert.ok((await sourceRows(f)).every(r=>r.state==='active'&&r.slices.length===0));
    const whole=(await f.reserve({...f.context,now:monday}))?.job;assert.ok(whole);
    assert.deepEqual(Object.keys(whole.remaining_input).sort(),[a,b].sort());assert.equal(BigInt(whole.amount_raw)+BigInt(whole.fee_reserve_raw),100n*U);
  }
});

test('basket waiting DB: one-time money that needs more transactions than it can fill is closed; depth or allowance limits keep waiting and buy later',async()=>{
  // Seven assets, 50 USDT, one asset per transaction (as when many assets are already held): seven batches of 10 USDT are needed.
  const f=await fixture('hold',0,4,'none',undefined,undefined,7);await f.fund(50n*U);
  const before=await balances(f);
  // Not enough buy allowance, or not enough depth: the same deposit can be bought later, so it waits and nothing is recorded.
  for(const limited of [{...f.context,buyLimit:0n},{...f.context,caps:new Map([...f.context.caps.keys()].map(asset=>[asset,U/2n]))}]){
    const result=await f.reserve(limited);assert.equal(result?.job,null);assert.match(result?.reason??'',/\[BASKET_WAITING\]/);
  }
  assert.ok((await sourceRows(f)).every(r=>r.state==='active'&&r.slices.length===0));assert.deepEqual(await balances(f),before);
  const g=await fixture('hold',0,4,'none',undefined,undefined,7);await g.fund(50n*U);
  const released=await g.reserve({...g.context,batchStepLimit:1});
  assert.equal(released?.job,null);assert.match(released?.reason??'',/\[BELOW_MIN_BATCH\].*50 USDT.*7 個來源/);
  const rows=await sourceRows(g);assert.equal(rows.length,7);
  assert.ok(rows.every(r=>r.state==='completed'&&r.slices.length===1&&r.slices[0]==='skipped_window'));
  const free=await balances(g);assert.equal(free?.unallocated_hold_raw,(50n*U).toString());assert.equal(free?.reserved_input_raw,'0');assert.equal(free?.reserved_fee_raw,'0');
  assert.match((await g.reserve({...g.context,batchStepLimit:1,now:new Date(+start+60000)}))?.reason??'',/\[NO_DUE_SLOT\]/);
  assert.deepEqual(await balances(g),free);
  // The first portfolio, with its limits gone, buys the whole deposit.
  const bought=(await f.reserve({...f.context,now:new Date(+start+120000)}))?.job;assert.ok(bought);
  assert.equal(BigInt(bought.amount_raw)+BigInt(bought.fee_reserve_raw),50n*U);
});

test('basket waiting DB: a creator-scheduled (stack) period that cannot form a batch is left to its own window, never closed early',async()=>{
  // Four daily periods of 50 USDT over seven assets, one asset per transaction: a period would need seven batches of 10 USDT.
  const f=await fixture('stack',0,4,'none',undefined,undefined,7);await f.fund(200n*U);
  const result=await f.reserve({...f.context,batchStepLimit:1});
  assert.equal(result?.job,null);assert.match(result?.reason??'',/\[BASKET_WAITING\]/);
  assert.ok((await sourceRows(f)).every(r=>r.state==='active'&&r.slices.length===0));
});

test('basket waiting DB: a started job whose remainder needs two transactions but cannot fill both is cancelled once and its cash released; one that can fill both keeps buying',async()=>{
  const now=new Date('2026-11-16T15:00:00Z'); // US market hours: the seventeen assets include stock tokens
  const f=await fixture('hold',0,4,'none',undefined,undefined,17);await f.fund(100n*U);
  // 15 USDT over 17 assets with 0.05 fee left: above the 10 USDT single-batch rule, but 17 assets need two transactions.
  const before=await spendDownTo(f,15n*U,usdt('0.05'));
  const s=feeScheduler(f);
  const result=await s.once(now);
  assert.equal(result.results[0]?.outcome,'noop',result.results[0]?.reason);assert.match(result.results[0]?.reason??'',/\[BELOW_MIN_BATCH\].*17 個資產/);
  assert.equal(s.sends.length,0);assert.equal(await job(f),null);assert.equal(await jobState(before.job.id),'cancelled');
  assert.deepEqual([...new Set(await sliceStates(before.job.id))],['cancelled']);
  const cash=await balances(f);assert.ok(cash);
  assert.equal(cash.unallocated_hold_raw,usdt('15.05').toString(),'principal and fee are back in the free cash');
  assert.equal(cash.reserved_input_raw,'0');assert.equal(cash.reserved_fee_raw,'0');
  assert.equal(before.firstSpent+before.firstFee+BigInt(cash.unallocated_hold_raw)+BigInt(cash.allocated_cash_raw),100n*U,'deposit = bought + fees + released');
  assert.deepEqual((await query<{state:string}>('select state from operations where portfolio_id=$1',[f.id])).rows.map(r=>r.state),['confirmed'],'no attempt was written for the cancelled remainder');
  for(const minutes of [1,2,70]){
    const next=await s.once(new Date(+now+minutes*60000));
    assert.equal(next.results[0]?.outcome,'noop');assert.doesNotMatch(next.results[0]?.reason??'',/BELOW_MIN_BATCH|BASKET_WAITING/);
  }
  assert.equal(s.sends.length,0);assert.deepEqual(await balances(f),cash);
  // 25 USDT over the same 17 assets fills two transactions: untouched by the rule, it buys in two sends and completes.
  const g=await fixture('hold',0,4,'none',undefined,undefined,17);await g.fund(100n*U);
  const kept=await spendDownTo(g,25n*U,usdt('0.05'));
  const t=feeScheduler(g);
  assert.equal((await t.once(now)).results[0]?.outcome,'executed');assert.ok((t.sends[0]?.steps.length??99)<=16);
  assert.equal((await t.once(new Date(+now+60000))).results[0]?.outcome,'executed');
  assert.equal(await job(g),null);assert.equal(await jobState(kept.job.id),'completed');
  assert.equal(t.sends.reduce((sum,send)=>sum+send.steps.length,0),17);
});

// ---- 2026-11-25 a started job that is released must close its sources ----------------------------------------------
// cancelJob marks the started job's periods 'cancelled'; completeAssetSchedules only closes sources whose periods were
// all bought or skipped, so those sources stayed 'active' for good. A private basket reads "an active source" as new
// money still to buy and never went back to its own rebalance, which is the only thing that uses the returned cash.

test('cancelled source DB: a started one-time job that is released closes its sources; the returned cash stays in this portfolio as free cash',async()=>{
  // #273: 9.90 principal + 0.05 fee left is under one 10 USDT batch.
  const f=await fixture();await f.fund(100n*U);
  const before=await spendDownTo(f,usdt('9.9'),usdt('0.05'));
  assert.equal(await pendingSources(f),2,'both sources are being bought');
  const s=feeScheduler(f);
  assert.match((await s.once(new Date(+start+60000))).results[0]?.reason??'',/\[BELOW_MIN_BATCH\]/);
  assert.equal(await jobState(before.job.id),'cancelled');
  assert.deepEqual(await sourceRows(f),[a,b].sort().map(asset=>({asset,state:'cancelled',slices:['cancelled']})),'no period is left: the sources are closed');
  assert.equal(await pendingSources(f),0,'nothing is left pending on this portfolio');
  // The money did not leave the portfolio's own ledger: free one-time cash, nothing reserved, nothing lost.
  const cash=await balances(f);assert.ok(cash);
  assert.equal(cash.unallocated_hold_raw,usdt('9.95').toString());assert.equal(cash.reserved_input_raw,'0');assert.equal(cash.reserved_fee_raw,'0');assert.equal(cash.stack_prefund_raw,'0');
  assert.equal(before.firstSpent+before.firstFee+BigInt(cash.unallocated_hold_raw)+BigInt(cash.allocated_cash_raw),100n*U);
  // Later rounds change nothing, and a later deposit still buys only its own money.
  assert.match((await s.once(new Date(+start+120000))).results[0]?.reason??'',/\[NO_DUE_SLOT\]/);
  assert.deepEqual(await balances(f),cash);
  await f.fund(50n*U,new Date(+start+180000));
  assert.equal((await s.once(new Date(+start+240000))).results[0]?.outcome,'executed');
  assert.equal(sumInputs(s.spent(s.sends[0] as ExecuteArgs))+R,50n*U,'the new deposit, not the returned cash');
  assert.equal((await sourceRows(f)).filter(r=>r.state==='cancelled').length,2);

  // #275: a remainder that needs two transactions and cannot fill both.
  const now=new Date('2026-11-16T15:00:00Z');
  const g=await fixture('hold',0,4,'none',undefined,undefined,17);await g.fund(100n*U);
  await spendDownTo(g,15n*U,usdt('0.05'));
  assert.match((await feeScheduler(g).once(now)).results[0]?.reason??'',/\[BELOW_MIN_BATCH\].*17 個資產/);
  const rows=await sourceRows(g);assert.equal(rows.length,17);
  assert.ok(rows.every(r=>r.state==='cancelled'&&r.slices.length===1&&r.slices[0]==='cancelled'),JSON.stringify(rows));
  assert.equal(await pendingSources(g),0);assert.equal((await balances(g))?.unallocated_hold_raw,usdt('15.05').toString());
});

test('cancelled source DB: a creator-scheduled source keeps its later periods after one is released, and closes when none is left',async()=>{
  // Two daily periods of 100 USDT. The first is released part-way: the second must still be bought on its day.
  const f=await fixture('stack',0,2);await f.fund(200n*U);
  await spendDownTo(f,usdt('9.9'),usdt('0.05'));
  const s=feeScheduler(f);
  assert.match((await s.once(new Date(+start+60000))).results[0]?.reason??'',/\[BELOW_MIN_BATCH\]/);
  assert.deepEqual(await sourceRows(f),[a,b].sort().map(asset=>({asset,state:'active',slices:['cancelled']})),'one period is still to come');
  assert.equal((await balances(f))?.stack_prefund_raw,(100n*U+usdt('9.95')).toString(),'scheduled money goes back to the scheduled bucket');
  const day=new Date(+start+86400000);
  // The last period is released part-way too: nothing is left, so the sources close.
  const last=(await f.reserve({...f.context,now:day}))?.job;assert.ok(last);
  const left=Object.fromEntries(Object.keys(last.remaining_input).map(asset=>[asset,usdt('4.95').toString()]));
  await complete(f,last,Object.fromEntries(Object.keys(last.remaining_input).map(asset=>[asset,(BigInt(last.remaining_input[asset]??'0')-usdt('4.95')).toString()])),BigInt(last.remaining_fee_raw)-usdt('0.05'));
  assert.deepEqual((await job(f))?.remaining_input,left);
  assert.match((await s.once(new Date(+day+60000))).results[0]?.reason??'',/\[BELOW_MIN_BATCH\]/);
  assert.deepEqual(await sourceRows(f),[a,b].sort().map(asset=>({asset,state:'cancelled',slices:['cancelled','cancelled']})));
  assert.equal(await pendingSources(f),0);
  const cash=await balances(f);assert.ok(cash);
  assert.equal(cash.stack_prefund_raw,(usdt('9.95')*2n).toString());assert.equal(cash.unallocated_hold_raw,'0');assert.equal(cash.reserved_input_raw,'0');assert.equal(cash.reserved_fee_raw,'0');

  // A released period followed by a fully bought last period also ends the source (it can never be 'completed').
  const g=await fixture('stack',0,2);await g.fund(200n*U);
  await spendDownTo(g,usdt('9.9'),usdt('0.05'));
  const t=feeScheduler(g);
  assert.match((await t.once(new Date(+start+60000))).results[0]?.reason??'',/\[BELOW_MIN_BATCH\]/);
  assert.equal((await t.once(day)).results[0]?.outcome,'executed');
  assert.equal(await job(g),null);
  assert.deepEqual(await sourceRows(g),[a,b].sort().map(asset=>({asset,state:'cancelled',slices:['cancelled','completed']})));
  // Untouched: sources with no cancelled period still finish as 'completed'.
  const h=await fixture();await h.fund(100n*U);
  assert.equal((await feeScheduler(h).once(start)).results[0]?.outcome,'executed');
  assert.deepEqual(await sourceRows(h),[a,b].sort().map(asset=>({asset,state:'completed',slices:['completed']})));
});

// ---- 2026-11-25 a fund's own rebalance uses the cash that ended sources left behind -------------------------------
// #273 / #275 hand a remainder that can never form a batch back to unallocated_hold_raw and end its sources (#276).
// A fund's configured rebalance (drift / monthly / monthly_drift) refused to start while that bucket was not 0, so the
// cash was never bought back and the fund never rebalanced again. Now a due rebalance takes that cash in as the fund's
// own free cash, exactly when no source is left to buy; with new money still pending, new money goes first.
// Buying that idle cash back is a buy: 10 USDT with its fee is enough (the planner marks the batch `idleCashBuy`), while
// a rebalance between assets keeps its 50 USDT minimum. Under 10 USDT the planner answers noop and the cash stays cash.
// The planner itself is pinned on a stub chain in test/rebalance-plan.test.ts ("returned cash: ..."); here its answers
// are fed to the real scheduler, the real send-time minimum check and real Postgres.
type Planned=Awaited<ReturnType<NonNullable<SchedulerDeps['planRebalance']>>>;
const buy=(token:Address,amountIn:bigint)=>({tokenIn:cash,tokenOut:token,amountIn,amountOutMin:90n,oracleFloor:80n,venue:TESTNET_97.contracts.universalRouter,data:'0x' as Hex});
/** A fund whose buy was released with 9.90 + 0.05 USDT handed back (#273), driven by a target-weight planner the test controls. */
async function fundWithReturnedCash(rebalance:AssetExecution['rebalance']){
  const f=await fixture('hold',0,4,rebalance);await f.fund(100n*U);
  const before=await spendDownTo(f,usdt('9.9'),usdt('0.05'));
  const state={delta:0,calls:0,cashDelta:0n,usdt:usdt('9.95'),planned:{kind:'noop',reason:'shared target weight planner'} as Planned,withdrawals:[] as {txHash:Hex;logIndex:number;blockNumber:bigint;blockHash:Hex;amount:bigint}[]};
  const s=feeScheduler(f,feeWindowModel(),{
    planPortfolio:async()=>{const p=plan(f);assert.ok(p.report);
      return {...p,snapshot:{...p.snapshot,holdings:[{asset:cash,amountWei:state.usdt,decimals:18,usdPriceE8:100000000n,priceSource:TWAP_PRICE_SOURCE}]},report:{...p.report,maxAbsDeltaBps:state.delta,grossDriftBps:state.delta,needsRebalance:state.delta>100}};},
    planRebalance:async()=>{state.calls++;return state.planned;}});
  // A target-weight rebalance settles on the USDT the account actually gained or lost.
  const execute=s.deps.executeRebalance,reconcile=s.deps.reconcileRebalance;assert.ok(execute&&reconcile&&s.deps.newMoney);
  s.deps.executeRebalance=async args=>({...await execute(args),cashDeltaRaw:state.cashDelta.toString()});
  s.deps.reconcileRebalance=async input=>{const result=await reconcile(input);if(result.kind==='found')Object.assign(result.outcome,{cashDeltaRaw:state.cashDelta.toString()});return result;};
  s.deps.newMoney.withdrawals=async()=>state.withdrawals;
  const released=await s.once(new Date(+start+60000));
  assert.match(released.results[0]?.reason??'',/\[BELOW_MIN_BATCH\]/);
  const cashRow=await balances(f);assert.equal(cashRow?.unallocated_hold_raw,usdt('9.95').toString());assert.equal(cashRow?.allocated_cash_raw,'0');
  assert.equal(await pendingSources(f),0);assert.equal(state.calls,0);
  return {f,s,state,spent:before.firstSpent+before.firstFee};
}
/** The scheduler's real send-time minimum check over a 1:1 oracle (the fixture's default accepts every batch). */
const realMinimums=():NonNullable<SchedulerDeps['checkTradingMinimums']>=>{
  const reads={readContract:async({functionName,args}:{functionName:string;args?:readonly unknown[]})=>{
    if(functionName==='numeraire')return cash;if(functionName==='oracle')return TESTNET_97.contracts.router;if(functionName==='decimals')return 18;
    if(functionName==='previewSwap'){const amount=args?.[2];assert.equal(typeof amount,'bigint');return [amount,amount];}
    throw new Error(`unexpected read ${functionName}`);}};
  return (steps,purpose,block,assetBudgetRaw,finalAssets,rebalanceReserveRaw)=>checkTradeMinimums(reads as unknown as PublicClient,TESTNET_97.contracts.executor,steps,purpose,block,assetBudgetRaw,finalAssets,rebalanceReserveRaw);
};
/** What the planner answers for idle cash under one buy batch (test/rebalance-plan.test.ts pins the real one). */
const cashStays:Planned={kind:'noop',reason:'[BELOW_MIN_BATCH] 可用現金 9.950000 USDT 含費不足10 USDT，留作現金'};
/** A second deposit whose buy is released with `left` + `feeLeft` handed back, on top of what is already there. */
async function returnMore(r:Awaited<ReturnType<typeof fundWithReturnedCash>>,at:number,left:bigint,feeLeft:bigint){
  // A new job needs its own time slot: the first one is recorded at `start`.
  const now=new Date(+start+at*60000),context={...r.f.context,now};
  const later:Fixture={...r.f,context,reserve:(c=context)=>r.f.reserve(c)};
  await later.fund(100n*U,new Date(+now-60000));
  await spendDownTo(later,left,feeLeft);
  r.state.usdt+=left+feeLeft;
  assert.match((await r.s.once(new Date(+start+(at+1)*60000))).results[0]?.reason??'',/\[BELOW_MIN_BATCH\]/);
  assert.equal(await pendingSources(r.f),0);
}
const lotEvidence=async(f:Fixture)=>({sources:await sourceRows(f),lots:(await query('select id,amount_raw::text,state from strategy_funding_lots where portfolio_id=$1 order by id',[f.id])).rows,
  budgets:(await query(`select a.lot_id,a.asset,a.budget_raw::text from strategy_lot_assets a join strategy_funding_lots l on l.id=a.lot_id where l.portfolio_id=$1 order by 1,2`,[f.id])).rows,
  slices:(await query(`select s.lot_id,s.asset,s.slice_index,s.budget_raw::text,s.amount_raw::text,s.fee_reserve_raw::text,s.state from strategy_asset_slices s join strategy_funding_lots l on l.id=s.lot_id where l.portfolio_id=$1 order by 1,2,3`,[f.id])).rows});

test('returned cash DB: 12 USDT handed back is bought back on the rebalance — one buy batch of 10 USDT with its fee is enough, the 50 between assets does not apply',async()=>{
  const r=await fundWithReturnedCash('drift'),{f,s,state}=r;
  s.deps.checkTradingMinimums=realMinimums();
  // Not due (drift 500): nothing moves, the cash simply stays where it is.
  state.delta=500;
  for(const minutes of [2,3])assert.equal((await s.once(new Date(+start+minutes*60000))).results[0]?.outcome,'noop');
  assert.equal(state.calls,0);assert.equal((await balances(f))?.unallocated_hold_raw,usdt('9.95').toString());
  // A second released buy hands back 2.05 more: 12.00 USDT of this fund's cash, tied to no pending buy.
  await returnMore(r,4,usdt('2'),usdt('0.05'));
  assert.equal((await balances(f))?.unallocated_hold_raw,usdt('12').toString());assert.equal(state.calls,0);
  const evidence=await lotEvidence(f);
  // Due (drift 501). The planner's answer for 12 USDT of idle cash: buys only, 11.73 + the 0.27 fee, marked as an idle-cash buy.
  state.delta=501;state.cashDelta=-usdt('12');
  const steps=[buy(a,usdt('5.865')),buy(b,usdt('5.865'))],deadline=BigInt(start.getTime()/1000)+7200n;
  // The same steps as an ordinary rebalance batch are refused before sending: 12 is under the 50 USDT between assets.
  state.planned={kind:'ready',steps,deadline,rationale:'target weights'};
  const refused=await s.once(new Date(+start+6*60000));
  assert.equal(refused.results[0]?.outcome,'blocked');assert.match(refused.results[0]?.reason??'',/\[BELOW_MIN_BATCH\] 含費批次不足50 USDT/);assert.equal(s.sends.length,0);
  // As the idle-cash buy the planner reports, the buy minimum applies and it is sent.
  state.planned={kind:'ready',steps,deadline,rationale:'target weights',idleCashBuy:{feeReserveRaw:R}};
  const result=await s.once(new Date(+start+7*60000));
  assert.equal(result.results[0]?.outcome,'executed',result.results[0]?.reason);assert.equal(s.sends.length,1);
  assert.deepEqual(s.sends.at(-1)?.steps.map(step=>[step.tokenIn,step.tokenOut,step.amountIn]),[[cash,a,usdt('5.865')],[cash,b,usdt('5.865')]]);
  assert.deepEqual(await balances(f),{unallocated_hold_raw:'0',stack_prefund_raw:'0',allocated_cash_raw:'0',reserved_input_raw:'0',reserved_fee_raw:'0'},'every bucket is settled: 11.73 bought + 0.27 fee = the 12.00 handed back');
  assert.deepEqual(await lotEvidence(f),evidence,'no lot, source budget or period was rewritten');
  assert.ok((await query<{last_rebalance_at:Date|null}>('select last_rebalance_at from portfolios where id=$1',[f.id])).rows[0]?.last_rebalance_at,'the rebalance is recorded as done');
  // Back in balance: quiet rounds, nothing changes.
  state.delta=0;state.usdt=0n;
  assert.equal((await s.once(new Date(+start+8*60000))).results[0]?.outcome,'noop');assert.equal(s.sends.length,1);
});

test('returned cash DB: 9.95 USDT is under one buy batch — it stays as the fund\'s cash and every round is a quiet noop, never blocked; it still joins a later rebalance between assets',async()=>{
  const {f,s,state}=await fundWithReturnedCash('drift');
  s.deps.checkTradingMinimums=realMinimums();
  state.delta=501;state.planned=cashStays;
  for(const [minutes,calls] of [[2,1],[3,2],[70,3]] as const){
    const now=new Date(+start+minutes*60000),result=await s.once(now);
    assert.equal(result.results[0]?.outcome,'noop',result.results[0]?.reason);assert.match(result.results[0]?.reason??'',/\[BELOW_MIN_BATCH\].*留作現金/);
    assert.equal(state.calls,calls,'the rebalance is not stalled: the planner is asked when the fund comes up again');
    // A noop waits out the idle backoff (15 minutes) instead of coming back every round.
    assert.equal(result.results[0]?.nextRunAt.getTime(),now.getTime()+900_000);
  }
  assert.equal(s.sends.length,0);
  assert.deepEqual(await balances(f),{unallocated_hold_raw:'0',stack_prefund_raw:'0',allocated_cash_raw:usdt('9.95').toString(),reserved_input_raw:'0',reserved_fee_raw:'0'},'kept as this fund\'s cash');
  assert.equal(withdrawableCash(usdt('9.95'),(await query<Record<string,string>>(`select unallocated_hold_raw::text,stack_prefund_raw::text,allocated_cash_raw::text,reserved_input_raw::text,reserved_fee_raw::text,
    withdrawal_raw::text,yield_raw::text from strategy_cash_balances where portfolio_id=$1`,[f.id])).rows[0]),usdt('9.95'),'all of it can be taken out');
  // Prices move: the planner now sells A for B and adds the cash. 60 + 69.68 + 0.27 is an ordinary batch; it executes like any other rebalance.
  state.planned={kind:'ready',steps:[{...buy(cash,60n*U),tokenIn:a},buy(b,usdt('69.68'))],deadline:BigInt(start.getTime()/1000)+7200n,rationale:'target weights'};
  state.cashDelta=-usdt('9.95'); // +60 from the sale, -69.68 bought, -0.27 fee
  assert.equal((await s.once(new Date(+start+71*60000))).results[0]?.outcome,'executed');assert.equal(s.sends.length,1);
  assert.equal((await balances(f))?.allocated_cash_raw,'0');
});

test('returned cash DB: idle cash next to assets that are less than 50 USDT apart — only the cash is bought; a sale under 50 is never sent with it',async()=>{
  const r=await fundWithReturnedCash('drift'),{f,s,state}=r;
  s.deps.checkTradingMinimums=realMinimums();
  await returnMore(r,2,usdt('2'),usdt('0.05'));
  state.delta=501;state.cashDelta=-usdt('12');
  const deadline=BigInt(start.getTime()/1000)+7200n;
  // A batch that also swaps 4 USDT of A into B is a rebalance between assets: 4 + 15.69 + 0.27 is under 50, refused before sending.
  state.planned={kind:'ready',steps:[{...buy(cash,4n*U),tokenIn:a},buy(b,usdt('15.69'))],deadline,rationale:'target weights'};
  for(const minutes of [4,5]){
    const swap=await s.once(new Date(+start+minutes*60000));
    assert.equal(swap.results[0]?.outcome,'blocked');assert.match(swap.results[0]?.reason??'',/\[BELOW_MIN_BATCH\] 含費批次不足50 USDT/);
  }
  // Marking it as an idle-cash buy does not let a sale through either: that minimum is for buys paid in cash only.
  state.planned={...state.planned,idleCashBuy:{feeReserveRaw:R}};
  const marked=await s.once(new Date(+start+6*60000));
  assert.equal(marked.results[0]?.outcome,'blocked');assert.match(marked.results[0]?.reason??'',/TRADE_MINIMUM_UNAVAILABLE/);
  assert.equal(s.sends.length,0);assert.equal((await balances(f))?.allocated_cash_raw,usdt('12').toString());
  // What the planner sends instead: the 12 USDT into the asset that is short, nothing sold. The assets are still apart
  // (`partial`), so the rebalance is not recorded as complete and comes back when the drift is worth a batch.
  state.planned={kind:'ready',steps:[buy(b,usdt('11.73'))],deadline,rationale:'target weights',idleCashBuy:{feeReserveRaw:R},partial:{remainingDriftBps:380,shrunk:[]}};
  const before=(await query<{last_rebalance_at:Date|null}>('select last_rebalance_at from portfolios where id=$1',[f.id])).rows[0]?.last_rebalance_at;
  const result=await s.once(new Date(+start+7*60000));
  assert.equal(result.results[0]?.outcome,'executed',result.results[0]?.reason);
  assert.deepEqual(s.sends.at(-1)?.steps.map(step=>[step.tokenIn,step.tokenOut,step.amountIn]),[[cash,b,usdt('11.73')]]);
  assert.deepEqual(await balances(f),{unallocated_hold_raw:'0',stack_prefund_raw:'0',allocated_cash_raw:'0',reserved_input_raw:'0',reserved_fee_raw:'0'});
  assert.deepEqual((await query<{last_rebalance_at:Date|null}>('select last_rebalance_at from portfolios where id=$1',[f.id])).rows[0]?.last_rebalance_at,before,'still due: the assets were not rebalanced');
});

test('returned cash DB: with new money still to buy, new money goes first — the returned cash is not touched until that buy is done',async()=>{
  const {f,s,state}=await fundWithReturnedCash('drift');
  state.delta=501;state.planned=cashStays;
  // A 20 USDT deposit, the size of a DCA (定投) tranche, arrives while the buy allowance is used up: it waits.
  await f.fund(20n*U,new Date(+start+2*60000),{[a]:1,[b]:1},undefined,10n*U);state.usdt+=20n*U;
  assert.ok(s.deps.newMoney);const policy=s.deps.newMoney.policy;assert.ok(policy);
  s.deps.newMoney.policy=async(...args)=>({...await policy(...args),buyLimit:0n});
  for(const minutes of [3,4]){
    const waiting=await s.once(new Date(+start+minutes*60000));
    assert.match(waiting.results[0]?.reason??'',/\[BASKET_WAITING\]/);
  }
  assert.equal(state.calls,0,'no rebalance while a source is pending');
  assert.equal((await balances(f))?.unallocated_hold_raw,usdt('29.95').toString());assert.equal((await balances(f))?.allocated_cash_raw,'0');
  // Allowance is back: the tranche buys exactly its own 20 USDT.
  s.deps.newMoney.policy=policy;
  const bought=await s.once(new Date(+start+5*60000));assert.equal(bought.results[0]?.outcome,'executed',bought.results[0]?.reason);
  const send=s.sends.at(-1);assert.ok(send);const paid=s.fees.get(send)??0n;
  assert.equal(sumInputs(s.spent(send))+paid,20n*U-(BigInt((await balances(f))?.allocated_cash_raw??'0')),'only the tranche was spent');
  assert.equal(await job(f),null);assert.equal(await pendingSources(f),0);
  assert.equal((await balances(f))?.unallocated_hold_raw,usdt('9.95').toString(),'the returned cash was not part of that buy');
  // Now nothing is pending: the due rebalance takes the returned cash in.
  const kept=BigInt((await balances(f))?.allocated_cash_raw??'0');
  assert.equal((await s.once(new Date(+start+6*60000))).results[0]?.outcome,'noop');assert.equal(state.calls,1);
  assert.deepEqual(await balances(f),{unallocated_hold_raw:'0',stack_prefund_raw:'0',allocated_cash_raw:(usdt('9.95')+kept).toString(),reserved_input_raw:'0',reserved_fee_raw:'0'});
});

test('returned cash DB: a monthly fund takes the cash in on its date, not before; cash left by sources closed before any job (#275) counts the same',async()=>{
  // Seven assets, 50 USDT, one asset per transaction: the sources are closed and the 50 USDT stays free (#275).
  const f=await fixture('hold',0,4,'monthly',undefined,undefined,7);await f.fund(50n*U);
  assert.match((await f.reserve({...f.context,batchStepLimit:1}))?.reason??'',/\[BELOW_MIN_BATCH\]/);
  assert.equal((await balances(f))?.unallocated_hold_raw,(50n*U).toString());assert.equal(await pendingSources(f),0);
  let calls=0;
  const s=scheduler(f,{planRebalance:async()=>{calls++;return {kind:'blocked',reason:'quote unavailable'};}});
  assert.equal((await s.once(new Date('2026-11-30T23:59:00Z'))).results[0]?.outcome,'noop');
  assert.equal(calls,0);assert.equal((await balances(f))?.unallocated_hold_raw,(50n*U).toString(),'same month: not due, untouched');
  // Before the fix December never came for this fund.
  assert.equal((await s.once(new Date('2026-12-01T00:00:00Z'))).results[0]?.outcome,'blocked');assert.equal(calls,1);
  assert.deepEqual(await balances(f),{unallocated_hold_raw:'0',stack_prefund_raw:'0',allocated_cash_raw:(50n*U).toString(),reserved_input_raw:'0',reserved_fee_raw:'0'});
  assert.ok((await sourceRows(f)).every(r=>r.state==='completed'&&r.slices.length===1&&r.slices[0]==='skipped_window'));
});

test('returned cash DB: a fund with rebalance none keeps the cash as cash — never bought back, never in the way of a later deposit',async()=>{
  const {f,s,state}=await fundWithReturnedCash('none');
  state.delta=9000;
  for(const minutes of [2,3,70,50000]){
    const result=await s.once(new Date(+start+minutes*60000));assert.equal(result.results[0]?.outcome,'noop');
  }
  assert.equal(state.calls,0);assert.equal(s.sends.length,0);
  assert.deepEqual(await balances(f),{unallocated_hold_raw:usdt('9.95').toString(),stack_prefund_raw:'0',allocated_cash_raw:'0',reserved_input_raw:'0',reserved_fee_raw:'0'});
  await f.fund(50n*U,new Date(+start+50001*60000));state.usdt+=50n*U;
  assert.equal((await s.once(new Date(+start+50002*60000))).results[0]?.outcome,'executed');
  const send=s.sends.at(-1);assert.ok(send);assert.ok(sumInputs(s.spent(send))<=50n*U);
  assert.equal((await balances(f))?.unallocated_hold_raw,usdt('9.95').toString(),'the later deposit bought only its own money');
});

test('returned cash DB: the owner can take the returned cash out at any point — before the rebalance, or after it joined the free cash',async()=>{
  const row=async(f:Fixture)=>(await query<Record<string,string>>(`select unallocated_hold_raw::text,stack_prefund_raw::text,allocated_cash_raw::text,reserved_input_raw::text,reserved_fee_raw::text,
    withdrawal_raw::text,yield_raw::text from strategy_cash_balances where portfolio_id=$1`,[f.id])).rows[0];
  const withdrawal=()=>({txHash:hash(),logIndex:0,blockNumber:15n,blockHash:hash(),amount:usdt('9.95')});
  // Still in the one-time bucket (rebalance not due): all of it is withdrawable; the withdrawal empties the bucket.
  const early=await fundWithReturnedCash('drift');
  assert.equal(withdrawableCash(usdt('9.95'),await row(early.f)),usdt('9.95'));
  early.state.withdrawals=[withdrawal()];early.state.usdt=0n;early.state.delta=501;
  assert.equal((await early.s.once(new Date(+start+2*60000))).results[0]?.outcome,'noop');
  assert.deepEqual(await balances(early.f),{unallocated_hold_raw:'0',stack_prefund_raw:'0',allocated_cash_raw:'0',reserved_input_raw:'0',reserved_fee_raw:'0'});
  // Already taken in by a rebalance that could not buy it: still all withdrawable; the withdrawal empties the free cash.
  const late=await fundWithReturnedCash('drift');
  late.state.delta=501;late.state.planned=cashStays;
  assert.equal((await late.s.once(new Date(+start+2*60000))).results[0]?.outcome,'noop');
  assert.equal((await balances(late.f))?.allocated_cash_raw,usdt('9.95').toString());
  assert.equal(withdrawableCash(usdt('9.95'),await row(late.f)),usdt('9.95'));
  late.state.withdrawals=[withdrawal()];late.state.usdt=0n;
  await late.s.once(new Date(+start+3*60000));
  assert.deepEqual(await balances(late.f),{unallocated_hold_raw:'0',stack_prefund_raw:'0',allocated_cash_raw:'0',reserved_input_raw:'0',reserved_fee_raw:'0'});
  assert.equal((await query("select 1 from operations where portfolio_id=$1 and type='withdraw' and state='confirmed'",[late.f.id])).rows.length,1);
});

test('returned cash DB: a funding lot that needs reconciliation keeps the cash where it is and the rebalance waiting',async()=>{
  const {f,s,state}=await fundWithReturnedCash('drift');
  state.delta=501;
  await query("update strategy_funding_lots set state='reorged' where portfolio_id=$1",[f.id]);
  for(const minutes of [2,3])await s.once(new Date(+start+minutes*60000));
  assert.equal(state.calls,0);assert.equal((await balances(f))?.unallocated_hold_raw,usdt('9.95').toString());assert.equal((await balances(f))?.allocated_cash_raw,'0');
});
