import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {after,test} from 'node:test';
import type {Address,Hex} from 'viem';
import {query,withTransaction,withPortfolioLock,migrate,closePool,getPool,MIGRATIONS_DIR} from '../src/db.js';
import {canonicalConfigHash,UINT256_MAX,validateAssetConfig} from '../src/strategy-execution.js';
import type {AssetMode} from '../src/strategy-execution.js';
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
const address=():Address=>`0x${randomBytes(20).toString('hex')}`;
const hash=():Hex=>`0x${randomBytes(32).toString('hex')}`;
const cash=TESTNET_97.contracts.usdt,a=TESTNET_97.assets.WBNB.token,b=TESTNET_97.assets.ETH.token;
const R=27n*U/100n,start=new Date('2026-11-15T13:00:00Z');
const run:WithTransactionFn=fn=>withTransaction(client=>fn({query:(s,p)=>client.query(s,p===undefined?[]:[...p])}));
async function fixture(kind:'hold'|'stack'='hold',cashWeight=0,slices=4,rebalance:'none'|'monthly'|'drift'='none',otherMode?:AssetMode,weights?:readonly number[],assetCount=2){
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
    values($1,1,$2,'{"kind":"funding"}',$3,2,$4,97,$5)`,[sid,JSON.stringify(allocation),activeAt,JSON.stringify(execution),configHash]);
  const pid=(await query<{id:string}>("insert into portfolios(user_id,strategy_id,version,schedule_state) values($1,$2,1,'active') returning id",[owner,sid])).rows[0]?.id;assert.ok(pid);
  const id=Number(pid);
  await query("insert into smart_accounts(portfolio_id,chain_id,address,owner,account_type) values($1,97,$2,$3,'KERNEL')",[pid,account,owner]);
  await query('insert into strategy_cash_balances(chain_id,portfolio_id,account) values(97,$1,$2)',[id,account]);
  await query(`insert into session_keys(portfolio_id,key_ref,permissions,status,expires_at)
    values($1,$2,$3,'active','2030-01-01')`,[id,`m/44'/60'/0'/0/${id}`,JSON.stringify({permissionId:'0x12345678',sessionKeyAddress:owner,timestamp:{validUntil:1893456000}})]);
  const context:JobContext={chainId:97,portfolioId:id,strategyId,version:1,kind:'asset',execution,account,allocation,cash,now:new Date(start),reserve:R,
    caps:new Map(allocation.assets.filter(x=>x.address!==cash).map(x=>[x.address,null])),buyLimit:UINT256_MAX,observedCash:1000000n*U,enabled:true,marketOpen:true};
  async function fund(amount:bigint,confirmedAt=new Date(start.getTime()-60000),effectiveOverride?:Record<string,number>){
    const certificate=effectiveOverride?{minimum:50n*U,effectiveSlices:effectiveOverride}:planContribution(amount,execution,confirmedAt,R);assert.ok(certificate,'fixture contribution must meet the actual calendar minimum');
    return withTransaction(async client=>{
      const lot=(await client.query<{id:string}>(`insert into strategy_funding_lots(chain_id,portfolio_id,strategy_id,version,kind,tx_hash,log_index,block_number,block_hash,amount_raw,minimum_contribution_raw,effective_slices,created_at,updated_at)
        values(97,$1,$2,1,'asset',$3,0,10,$4,$5,$6,$7,$8,$8) returning id`,[id,sid,hash(),hash(),amount.toString(),certificate.minimum.toString(),JSON.stringify(certificate.effectiveSlices),confirmedAt])).rows[0];assert.ok(lot);
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
async function complete(f:Fixture,j:StrategyJob,input=j.remaining_input,feePaid=0n){
  const userOpHash=hash(),txHash=hash();
  const op=await withTransaction(async client=>{
    const index=Number((await client.query<{n:number}>('select coalesce(max(batch_index)+1,0) as n from strategy_job_batches where job_id=$1',[j.id])).rows[0]?.n);
    await client.query("update strategy_jobs set state='running',asset_started_at=coalesce(asset_started_at,slot_at),updated_at=clock_timestamp() where id=$1",[j.id]);
    await client.query('insert into strategy_job_batches(job_id,batch_index,input_raw) values($1,$2,$3)',[j.id,index,JSON.stringify(input)]);
    const row=(await client.query<{id:string}>(`insert into operations(portfolio_id,type,state,idempotency_key,payload_hash,deadline,user_op_nonce,strategy_job_id,strategy_batch_index)
      values($1,'rebalance','pending',$2,$3,'2030-01-01',0,$4,$5) returning id`,[f.id,hash(),hash(),j.id,index])).rows[0];assert.ok(row);
    await client.query("update operations set state='submitted',user_op_hash=$2,tx_hash=$3 where id=$1",[row.id,userOpHash,txHash]);return row.id;
  });
  await settleStrategyBatch(run,f.context,op,{received:Object.fromEntries(Object.keys(input).map(a=>[a,'100'])),fees:{},feePaid,blockNumber:11n,blockHash:hash()});
}
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
  pinnedVersion:{version:1,onchainStrategyId:f.strategyId+99000000,paused:false},allocationCheck:{consistent:true,chain:[],mismatches:[]},thresholdBps:100};}
function scheduler(f:Fixture,extra:SchedulerDeps={}){
  const sends:ExecuteArgs[]=[],userHash=hash(),txHash=hash();
  let status:ExecutionOutcome['status']='success';
  const deps:SchedulerDeps={query,withTransaction:singlePortfolioClaim(f.id),chainId:97,executor:TESTNET_97.contracts.executor,
    readGlobalPaused:async()=>false,withPortfolioLock,dexGate:async()=>null,log:()=>{},writeSnapshot:async()=>({headerInserted:true,inserted:0,updated:0}),
    planPortfolio:async()=>plan(f),planRebalance:async()=>{throw new Error('hold/stack must never enter drift planner');},
    readPermissionConfig:async()=>({signer:f.owner,policyCount:3}),deriveSessionKeyAddress:async()=>f.owner,readAllowance:async()=>UINT256_MAX,readBalance:async()=>UINT256_MAX,
    readRebalanceNonce:async()=>0n,checkTradingMinimums:async()=>null,hasBoughtBefore:async()=>true,refreshFloors:async i=>({ok:true,steps:[...i.steps],refreshes:[],note:'fresh'}),
    newMoney:{version:(sid,v,onchainId,account,options)=>requireTypedVersion(sid,v,onchainId,account,{...options,verifyChain:false}),
      policy:async()=>({reserve:R,caps:new Map(f.context.caps),buyLimit:UINT256_MAX,cash:10000n*U}),verifyLots:async()=>{},marketOpen:()=>true,
      quote:async(_due,_plan,inputs,deadline)=>({kind:'ready',steps:Object.entries(inputs).map(([token,raw])=>({tokenIn:cash,tokenOut:token as Address,amountIn:BigInt(raw),amountOutMin:90n,oracleFloor:80n,venue:TESTNET_97.contracts.universalRouter,data:'0x'})),deadline,rationale:'test exact new money'})},
    executeRebalance:async args=>{sends.push(args);args.onSending();await args.onSubmitted({userOpHash:userHash});return {status,userOpHash:userHash,txHash:status==='unknown'?null:txHash,gasUsed:'100',error:status==='success'?null:'receipt timeout'};},
    reconcileRebalance:async input=>({kind:'found',outcome:{status:'success',userOpHash:userHash,txHash,gasUsed:'100',error:null,
      batchEvidence:{received:Object.fromEntries(Object.keys(input.expectedInputs??{}).map(a=>[a,'100'])),fees:{},feePaid:0n,blockNumber:21n,blockHash:hash()}}}),...extra};
  async function once(now=start,dryRun=false){await query('update portfolios set next_run_at=null where id=$1',[f.id]);return runSchedulerOnce({dryRun,now,skipAlerts:true},deps);}
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
  const afterFirst=sumInputs(first.remaining_input);assert.ok(afterFirst>0n);assert.ok(afterFirst<100n*U);
  assert.equal((await s.once(new Date(start.getTime()+60000))).results[0]?.outcome,'executed');assert.equal(await job(f),null);
  const spent=s.sends.flatMap(s=>s.steps).reduce((sum,s)=>sum+s.amountIn,0n);assert.equal(spent,200n*U-2n*R);
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


for(const direction of ['buy','sell'] as const)test(`#83 all-hold ${direction} rebalancing settles authoritative USDT deltas with its operation`,async()=>{
  const f=await fixture('hold',5000,4,'drift');await f.fund(200n*U);const initial=(await f.reserve())?.job;assert.ok(initial);await complete(f,initial);
  const before=await balances(f);assert.ok(before);
  const delta=direction==='buy'?-20n*U-R:30n*U;
  const s=scheduler(f,{planPortfolio:async()=>{const p=plan(f);assert.ok(p.report);return {...p,report:{...p.report,maxAbsDeltaBps:501,needsRebalance:true}};},
    planRebalance:async()=>({kind:'ready',steps:[{tokenIn:direction==='buy'?cash:a,tokenOut:direction==='buy'?a:cash,amountIn:20n*U,amountOutMin:90n,oracleFloor:80n,venue:TESTNET_97.contracts.universalRouter,data:'0x'}],deadline:BigInt(start.getTime()/1000)+1800n,rationale:'shared target weight planner'}),
    reconcileRebalance:async input=>{assert.equal(input.trackCash,cash);return {kind:'found',outcome:{status:'success',userOpHash:input.userOpHash,txHash:input.txHash??hash(),gasUsed:'100',error:null,cashDeltaRaw:delta.toString()}};}});
  assert.equal((await s.once()).results[0]?.outcome,'executed');assert.equal(s.sends.length,1);
  assert.equal((await balances(f))?.allocated_cash_raw,(BigInt(before.allocated_cash_raw)+delta).toString());
  assert.equal((await query<{state:string}>('select state from operations where portfolio_id=$1 and strategy_job_id is null',[f.id])).rows[0]?.state,'confirmed');
  assert.equal((await query('select id from strategy_jobs where portfolio_id=$1',[f.id])).rows.length,1,'price rebalance must use the shared target_weight pipeline, without manufacturing a funding job');
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
  assert.equal(BigInt(initial.amount_raw)+BigInt(initial.fee_reserve_raw),250n*U);assert.equal(initial.fee_reserve_raw,(2n*R).toString());
  const half=Object.fromEntries(Object.entries(initial.remaining_input).map(([asset,raw])=>[asset,(BigInt(raw)/2n).toString()]));
  await complete(f,initial,half,R);
  const partial=await job(f);assert.ok(partial);assert.equal(partial.state,'running');assert.equal(partial.remaining_fee_raw,R.toString());
  const confirmed=(await query<{state:string;input_raw:Record<string,string>}>('select state,input_raw from strategy_job_batches where job_id=$1',[initial.id])).rows;assert.equal(confirmed.length,1);assert.equal(confirmed[0]?.state,'confirmed');
  await query("update portfolios set schedule_state='paused' where id=$1",[f.id]);
  await f.reserve({...f.context,enabled:false,now:new Date(start.getTime()+60000)});
  const cancelled=(await query<{state:string;remaining_input:Record<string,string>;remaining_fee_raw:string}>('select state,remaining_input,remaining_fee_raw::text from strategy_jobs where id=$1',[initial.id])).rows[0];assert.ok(cancelled);
  assert.equal(cancelled.state,'cancelled');assert.deepEqual(cancelled.remaining_input,partial.remaining_input);assert.equal(cancelled.remaining_fee_raw,partial.remaining_fee_raw);
  const saved=await balances(f);assert.ok(saved);assert.equal(saved.reserved_input_raw,'0');assert.equal(saved.reserved_fee_raw,'0');assert.equal(saved.allocated_cash_raw,(400n*U).toString());
  assert.equal(saved.unallocated_hold_raw,(100n*U).toString());assert.equal(saved.stack_prefund_raw,(175n*U).toString());
  assert.equal(BigInt(saved.unallocated_hold_raw)+BigInt(saved.stack_prefund_raw)+BigInt(saved.allocated_cash_raw)+sumInputs(half)+R,800n*U);
  assert.deepEqual((await query<{state:string;input_raw:Record<string,string>}>('select state,input_raw from strategy_job_batches where job_id=$1',[initial.id])).rows,confirmed,'pausing cannot reverse the confirmed child batch');
  assert.equal(await job(f),null);
});

test('#83 dust-aware shortened 99/1 funding buys the executable asset and preserves tiny final dust',async()=>{
  const f=await fixture('stack',0,12,'none',undefined,[9900,100]);const lot=await f.fund(100n*U);
  const result=(await f.reserve())?.job;assert.ok(result,'shortening must avoid leaving the large asset in two 49.5-budget slices');
  assert.deepEqual(Object.keys(result.original_input),[a]);assert.equal(result.original_input[a],(99n*U-R).toString());assert.equal(result.fee_reserve_raw,R.toString());
  const dust=(await query<{state:string;budget_raw:string;job_id:string|null}>('select state,budget_raw::text,job_id from strategy_asset_slices where lot_id=$1 and asset=$2',[lot,b])).rows[0];assert.ok(dust);assert.equal(dust.state,'deferred_min_asset');assert.equal(dust.budget_raw,U.toString());assert.equal(dust.job_id,null);
  await complete(f,result,result.remaining_input,R);
  assert.equal((await balances(f))?.stack_prefund_raw,U.toString(),'unspent final dust remains classified and withdrawable');assert.equal((await balances(f))?.reserved_input_raw,'0');
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
  const f=await fixture('hold',0,4,'none',undefined,undefined,92);
  await f.fund(10000n*U);
  let held=new Set<Address>();
  const s=scheduler(f);
  s.deps.planPortfolio=async()=>{
    const current=plan(f);
    for(const asset of held)current.snapshot.holdings.push({asset,amountWei:U,decimals:18,usdPriceE8:100000000n,priceSource:TWAP_PRICE_SOURCE});
    return current;
  };
  s.setStatus('unknown');
  assert.equal((await s.once()).results[0]?.outcome,'blocked');
  const original=await job(f);assert.ok(original);assert.equal(Object.keys(original.original_input).length,92);
  const attempts=(await query('select payload_hash,user_op_nonce from operations where portfolio_id=$1',[f.id])).rows;
  assert.equal((await s.once()).results[0]?.outcome,'executed');assert.equal(s.sends.length,1,'unknown original must reconcile without sending a different subset');
  assert.deepEqual((await query('select payload_hash,user_op_nonce from operations where portfolio_id=$1',[f.id])).rows,attempts);
  s.setStatus('success');
  for(let round=0;round<20&&await job(f);round++){
    held=new Set(s.sends.flatMap(send=>send.steps.map(step=>step.tokenOut)));
    assert.equal((await s.once(new Date(start.getTime()+(round+1)*60000))).results[0]?.outcome,'executed');
  }
  assert.equal(await job(f),null);
  assert.ok(s.sends.length>1&&s.sends.every(send=>send.steps.length<=16));
  assert.ok((s.sends.at(-1)?.steps.length??16)<16);
  const spent:Record<string,bigint>={};
  for(const send of s.sends)for(const step of send.steps)spent[step.tokenOut.toLowerCase()]=(spent[step.tokenOut.toLowerCase()]??0n)+step.amountIn;
  assert.deepEqual(Object.fromEntries(Object.entries(spent).map(([a,n])=>[a,n.toString()])),original.original_input);
  const saved=await balances(f);assert.equal(saved?.reserved_input_raw,'0');assert.equal(saved?.reserved_fee_raw,'0');
  assert.equal((await query("select batch_index from strategy_job_batches where job_id=$1 and state='confirmed'",[original.id])).rows.length,s.sends.length);
 });

test('#92 unequal 17-asset job shares its whale across children and settles the exact frozen vector',async()=>{
  const f=await fixture('hold',0,4,'none',undefined,[...Array.from({length:16},()=>20),9680],17);
  await f.fund(1000n*U);
  const s=scheduler(f);assert.equal((await s.once()).results[0]?.outcome,'executed');
  const original=await job(f);assert.ok(original);assert.equal(BigInt(original.fee_reserve_raw),2n*R);
  assert.equal((await s.once(new Date(start.getTime()+60000))).results[0]?.outcome,'executed');
  assert.equal(await job(f),null);assert.equal(s.sends.length,2);
  const spent:Record<string,bigint>={};
  for(const send of s.sends){
    assert.ok(send.steps.length<=16);
    assert.ok(send.steps.reduce((n,step)=>n+step.amountIn,R)>=50n*U);
    for(const step of send.steps){assert.ok(step.amountIn>=U);spent[step.tokenOut]=(spent[step.tokenOut]??0n)+step.amountIn;}
  }
  assert.deepEqual(Object.fromEntries(Object.entries(spent).map(([a,n])=>[a,n.toString()])),original.original_input);
  assert.equal((await balances(f))?.reserved_input_raw,'0');assert.equal((await balances(f))?.reserved_fee_raw,'0');
});

test('#92 two large positions distribute across 18-asset DB batches at exact 1/50 thresholds',async()=>{
  const f=await fixture('hold',0,4,'none',undefined,[...Array.from({length:16},()=>200),3400,3400],18);
  await f.fund(100n*U);const s=scheduler(f);
  assert.equal((await s.once()).results[0]?.outcome,'executed');
  const original=await job(f);assert.ok(original);assert.equal(BigInt(original.fee_reserve_raw),2n*R);
  assert.equal((await s.once(new Date(start.getTime()+60000))).results[0]?.outcome,'executed');assert.equal(await job(f),null);
  const spent:Record<string,bigint>={};assert.equal(s.sends.length,2);
  for(const send of s.sends){assert.equal(send.steps.length,9);assert.equal(send.steps.reduce((sum,step)=>sum+step.amountIn,R),50n*U);
    for(const step of send.steps){assert.ok(step.amountIn>=U);spent[step.tokenOut]=(spent[step.tokenOut]??0n)+step.amountIn;}}
  assert.deepEqual(Object.fromEntries(Object.entries(spent).map(([a,n])=>[a,n.toString()])),original.original_input);
});
