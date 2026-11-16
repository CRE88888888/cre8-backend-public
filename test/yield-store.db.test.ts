import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { encodeFunctionData, parseAbi } from 'viem';
import type { Hex } from 'viem';
import type { QueryResultRow } from 'pg';
import { closePool, migrate, query, withTransaction, withPortfolioLock } from '../src/db.js';
import { persistYieldRead, syncYieldCatalog, createYieldJournal, restoreYieldOperation } from '../src/yield-store.js';
import type { JournalContext, SnapshotRow, SettlementRead } from '../src/yield-store.js';
import { WAD, RAY, UINT256_MAX } from '../src/yield-domain.js';
import { AppError } from '../src/errors.js';
import type { YieldRead } from '../src/yield-domain.js';
import type { YieldPlan, YieldPrepare, YieldEvidence } from '../src/yield-port.js';
import { gasExecutionKey } from '../src/paymaster.js';
import type { Reservation } from '../src/paymaster.js';
import { yieldFixture, address, hash } from './fixtures/yield.js';
import { config, kernelCall, operation } from './fixtures/paymaster.js';

const paymasters:string[]=[];
after(async()=>{if(paymasters.length)await query('delete from paymaster_sponsorships where chain_id=97 and paymaster=any($1::text[])',[paymasters]);await closePool();});
async function fixture(read?:YieldRead,rebalance:'none'|'monthly'|'drift'='none',f=yieldFixture(['venus'])){
  await migrate();const r=read??f.read;
  await syncYieldCatalog(r);const market=r.profile.markets[0];assert.ok(market);
  const owner=address(),account=f.account;
  const strategy=(await query<{id:string}>("insert into strategies(provider,name) values($1,'be84-yield') returning id::text",[owner])).rows[0];assert.ok(strategy);
  await query('update strategies set onchain_id=$2 where id=$1',[strategy.id,BigInt(strategy.id)+84000000n]);
  const execution={kind:'per_asset',numeraire:market.asset,rebalance,assets:[{asset:market.asset,weightBps:10000,yield:{market:market.id}}]};
  await query(`insert into strategy_versions(strategy_id,version,allocation,schedule,active_at,execution_schema_version,execution,execution_chain_id,config_hash)
    values($1,1,$2,'{"kind":"funding"}',now()-interval '1 day',2,$3,97,$4)`,[strategy.id,JSON.stringify({assets:[{address:market.asset,weightBps:10000}]}),JSON.stringify(execution),hash()]);
  const p=(await query<{id:string}>("insert into portfolios(user_id,strategy_id,version,schedule_state) values($1,$2,1,'active') returning id::text",[owner,strategy.id])).rows[0];assert.ok(p);
  await query("insert into smart_accounts(portfolio_id,chain_id,address,owner,account_type) values($1,97,$2,$3,'KERNEL')",[p.id,account,owner]);
  const context={portfolioId:Number(p.id),chainId:97,account};
  await persistYieldRead(context,r);
  await query('update strategy_cash_balances set allocated_cash_raw=$2 where portfolio_id=$1',[p.id,(1000n*WAD).toString()]);
  const consent=(await query<{id:string}>(`insert into yield_consents(chain_id,portfolio_id,account,market_id,strategy_id,version,authorized_by,policy_version,daily_assets_raw,opted_in_at)
    values(97,$1,$2,$3,$4,1,$5,$6,$7,clock_timestamp()) returning id::text`,[p.id,account,market.marketId,strategy.id,owner,hash(),UINT256_MAX.toString()])).rows[0];assert.ok(consent);
  const now=BigInt(Math.floor(Date.now()/1000));
  const plan:YieldPlan={kind:'supply',marketId:market.marketId,amount:50n*WAD,minimum:50n*WAD,deadline:now+300n,quoteBlock:100n,quoteBlockHash:r.observation.blockHash,
    chainId:97,account,executor:r.profile.executor,yieldRegistry:r.profile.registry,asset:market.asset,receipt:market.receipt,assetBalance:1000n*WAD,receiptBalance:0n,data:'0x'};
  let proof:SettlementRead={read:r,logIndex:0,blockNumber:101n,blockHash:hash(),occurredAt:new Date()};
  function prepared(nextPlan=plan,nonce=0n){
    const data=encodeFunctionData({abi:parseAbi(['function executeSupply(address,bytes32,uint256,uint256,uint256)','function executeWithdraw(address,bytes32,uint256,uint256,uint256)']),functionName:nextPlan.kind==='supply'?'executeSupply':'executeWithdraw',args:[account,nextPlan.marketId,nextPlan.amount,nextPlan.minimum,nextPlan.deadline]});
    const actual={...nextPlan,data},op=operation({sender:account,nonce,callData:kernelCall(data,nextPlan.executor)}),key=gasExecutionKey(97,op),userOpHash=hash();
    const c={...config(),chainId:97,executor:nextPlan.executor,registry:nextPlan.yieldRegistry,address:address()};
    paymasters.push(c.address);
    const reservation:Reservation={hash:userOpHash,op,config:c,validUntil:Number(now+300n),verificationGas:100000n,callGas:200000n,maxFee:2n,gasLimit:400000n,maxCostWei:800000n,
      budget:{executionKey:key,chainId:97,account,purpose:nextPlan.kind==='supply'?'ordinary':'exit',gasLimit:400000n,maxFeePerGas:2n,nativePrice:60000000000n,priceSource:'test:yield'}};
    return{input:{plan:actual,nonce,callData:op.callData,executionKey:key,userOpHash} satisfies YieldPrepare,reservation};
  }
  let current=prepared();
  const ctx:JournalContext={...context,cashAsset:market.asset,consentId:consent.id,exitRequestId:null,sources:{allocated_cash_raw:(50n*WAD).toString()},reserve:()=>current.reservation,validate:async()=>{},settlement:async()=>proof};
  const journal=createYieldJournal(ctx);
  return{...f,owner,strategyId:strategy.id,context,plan,ctx,journal,get current(){return current;},set current(v){current=v;},prepared,setProof:(v:SettlementRead)=>{proof=v;},read:r,market};
}
const balance=async(id:number)=>(await query<{n:string}>('select allocated_cash_raw::text as n from strategy_cash_balances where portfolio_id=$1',[id])).rows[0]?.n;
const locked=<T>(id:number,fn:()=>Promise<T>)=>withPortfolioLock(id,fn);

test('#112 twenty durable unknowns cannot consume exit/risk or new-supply slots across repeated rounds',async()=>{
  const unknowns:Awaited<ReturnType<typeof fixture>>[]=[];
  for(let n=0;n<20;n++){
    const f=await fixture();await locked(f.context.portfolioId,()=>f.journal.prepare(f.current.input));
    await locked(f.context.portfolioId,()=>f.journal.unknown(f.current.input.executionKey));unknowns.push(f);
  }
  const exit=await fixture(),risk=await fixture(),supply=await fixture();
  await query('insert into yield_exit_requests(request_key,chain_id,portfolio_id,account,requested_by) values($1,97,$2,$3,$4)',[hash(),exit.context.portfolioId,exit.account,exit.owner]);
  const position=risk.read.positions[0];assert.ok(position);Object.assign(position,{receipt:1n,observedUnits:1n,trackedUnits:1n,claim:1n,value:1n});await persistYieldRead(risk.context,risk.read);
  const all=[...unknowns,exit,risk,supply].map(f=>f.context.portfolioId),selected:number[]=[];
  async function scoped<T extends QueryResultRow=QueryResultRow>(sql:string,params:readonly unknown[]=[]){
    return query<T>(sql.replace('from smart_accounts sa','from (select * from smart_accounts where portfolio_id=any($2::bigint[])) sa'),[...params,all]);
  }
  const {runYieldRound}=await import('../src/yield-service.js');const previous=process.env.CHAIN_ID;process.env.CHAIN_ID='97';
  try{
    for(let n=0;n<3;n++){
      selected.length=0;
      await runYieldRound({dryRun:false,limit:20},{query:scoped,profile:()=>exit.profile,lock:async id=>{selected.push(id);return null;}});
      assert.ok(selected.includes(exit.context.portfolioId));assert.ok(selected.includes(risk.context.portfolioId));assert.ok(selected.includes(supply.context.portfolioId));
      assert.equal(selected.filter(id=>unknowns.some(f=>f.context.portfolioId===id)).length,20);
    }
    assert.equal((await query("select execution_key from yield_actions where portfolio_id=any($1::bigint[]) and state='unknown'",[unknowns.map(f=>f.context.portfolioId)])).rows.length,20);
  }finally{if(previous===undefined)delete process.env.CHAIN_ID;else process.env.CHAIN_ID=previous;}
});

test('#112 first quote failure with no receipt/action leaves a traceable safe portfolio error',async()=>{
  const f=await fixture(),{runYieldRound}=await import('../src/yield-service.js');
  const id=(await query<{id:string}>("insert into portfolios(user_id,strategy_id,version,schedule_state) values($1,$2,1,'active') returning id::text",[f.owner,f.strategyId])).rows[0]?.id;assert.ok(id);
  const account=address();await query("insert into smart_accounts(portfolio_id,chain_id,address,owner,account_type) values($1,97,$2,$3,'KERNEL')",[id,account,f.owner]);
  async function scoped<T extends QueryResultRow=QueryResultRow>(sql:string,params:readonly unknown[]=[]){
    return sql.includes('from smart_accounts sa')?query<T>(sql.replace('from smart_accounts sa','from (select * from smart_accounts where portfolio_id=$2) sa'),[...params,id]):query<T>(sql,params);
  }
  const previous=process.env.CHAIN_ID,original=console.warn,logs:string[]=[];process.env.CHAIN_ID='97';console.warn=(message:unknown)=>logs.push(String(message));
  f.state.fail='eth_call';
  try{
    assert.deepEqual(await runYieldRound({dryRun:false,limit:20},{query:scoped,profile:()=>f.profile,client:()=>f.client}),{checked:0,blocked:1});
    assert.deepEqual(logs.map(line=>JSON.parse(line)),[{msg:'yield_account_blocked',portfolioId:Number(id),code:'YIELD_UNAVAILABLE'}]);
    assert.doesNotMatch(logs.join('\n'),/SECRET|http|postgres/);
    assert.equal((await query('select market_id from yield_positions where portfolio_id=$1',[id])).rows.length,0);
  }finally{console.warn=original;if(previous===undefined)delete process.env.CHAIN_ID;else process.env.CHAIN_ID=previous;}
});

test('#112 automatic full exit can recover and settle a new supply atomically; failed prepare retains completed',async()=>{
  const f=await fixture(),p=f.read.positions[0];assert.ok(p);
  const {createYieldService}=await import('../src/yield-service.js');
  const service=createYieldService({profile:()=>f.profile,client:()=>f.client,read:async()=>structuredClone(f.read),canSend:()=>false});
  async function settle(kind:'supply'|'withdraw',nonce:bigint){
    assert.ok(p);
    const next=f.prepared({...f.plan,kind,receiptBalance:kind==='withdraw'?50n*WAD:0n},nonce);
    f.current=next;f.ctx.sources=kind==='supply'?{allocated_cash_raw:(50n*WAD).toString()}:{};
    f.ctx.consentId=kind==='supply'?f.ctx.consentId:null;
    await locked(f.context.portfolioId,()=>f.journal.prepare(next.input));
    await locked(f.context.portfolioId,()=>f.journal.sending(next.input.executionKey));
    const remaining=kind==='supply'?50n*WAD:0n;
    const block=101n+nonce;
    Object.assign(p,{block,receipt:remaining,observedUnits:remaining,trackedUnits:remaining,claim:remaining,value:remaining});
    f.read.risks=f.read.risks.map(r=>({...r,block,exposure:remaining}));
    // The initial confirmed supply is historical, outside the real DB's 24h cooldown.
    f.setProof({read:f.read,logIndex:0,blockNumber:block,blockHash:f.blockHash,occurredAt:nonce===0n?new Date(+f.at-86400001):f.at});
    const evidence={assets:50n*WAD,shares:50n*WAD,remainingReceipts:remaining,txHash:hash(),userOpHash:next.input.userOpHash,gasUsed:1n};
    await locked(f.context.portfolioId,()=>f.journal.confirmed(next.input.executionKey,evidence));
    await locked(f.context.portfolioId,()=>f.journal.confirmed(next.input.executionKey,evidence));
  }
  const consentId=f.ctx.consentId;
  await settle('supply',0n);
  f.read.risks=f.read.risks.map(r=>({...r,utilizationBps:9000}));
  await locked(f.context.portfolioId,()=>service.tick(f.context,false));
  await settle('withdraw',1n);
  await locked(f.context.portfolioId,()=>service.tick(f.context,false));
  const exit=async()=>(await query<{exit_state:string}>('select exit_state from yield_positions where portfolio_id=$1',[f.context.portfolioId])).rows[0]?.exit_state;
  assert.equal(await exit(),'completed');
  f.read.risks=f.read.risks.map(r=>({...r,utilizationBps:0}));f.ctx.consentId=consentId;
  await persistYieldRead(f.context,f.read);
  f.current=f.prepared(f.plan,2n);f.ctx.sources={allocated_cash_raw:(50n*WAD).toString()};
  const broken=createYieldJournal(f.ctx,{transaction:async fn=>withTransaction(async db=>{await fn(db);throw new Error('SECRET_COMMIT_FAILURE');})});
  await assert.rejects(locked(f.context.portfolioId,()=>broken.prepare(f.current.input)));
  assert.equal(await exit(),'completed');assert.equal(await balance(f.context.portfolioId),(1000n*WAD).toString());
  await settle('supply',2n);
  assert.equal(await exit(),'none');assert.equal(await balance(f.context.portfolioId),(950n*WAD).toString());
  assert.equal((await query("select execution_key from yield_actions where portfolio_id=$1 and state='confirmed'",[f.context.portfolioId])).rows.length,3);
});

test('#112 empty and mixed-market exit accepts stopped policy plus fresh zero units; missing, stale, nonzero or enabled proof stays closed',async()=>{
  for(const protocols of [['venus'],['venus','lista']] satisfies import('../src/yield-domain.js').YieldProtocol[][]){
    const f=await fixture(undefined,'none',yieldFixture(protocols));
    const {createYieldService}=await import('../src/yield-service.js');const {requireOwnedPortfolio}=await import('../src/portfolios.js');
    f.state.proofSid=BigInt(f.strategyId)+84000000n;f.state.proofKind='exit';f.state.proofMarket=f.market.marketId;f.sessionState.exiting=false;
    const p=f.read.positions[0];assert.ok(p);
    const other=f.read.positions[1];if(other)Object.assign(other,{receipt:10n,observedUnits:10n,trackedUnits:10n,claim:10n,value:10n});
    const service=createYieldService({profile:()=>f.read.profile,read:async()=>structuredClone(f.read),client:()=>f.client,owned:(id,wallet)=>requireOwnedPortfolio(id,wallet,{chainId:97})});
    const input={markets:[f.market.id],txHash:f.state.proofHash};
    for(const patch of [{receipt:1n},{trackedUnits:1n},{observedUnits:1n},{state:'unknown' as const},{at:new Date(+f.at-60001)}]){
      const before={...p};Object.assign(p,patch);await assert.rejects(service.exit(f.context.portfolioId,f.owner,input));Object.assign(p,before);
    }
    f.sessionState.exitPolicyEnabled=true;await assert.rejects(service.exit(f.context.portfolioId,f.owner,input));f.sessionState.exitPolicyEnabled=false;
    const first=await service.exit(f.context.portfolioId,f.owner,input),replay=await service.exit(f.context.portfolioId,f.owner,input);
    assert.equal(first.state,'requested');assert.equal(replay.requestId,first.requestId);assert.equal(replay.replayed,true);
    assert.equal((await query('select id from yield_consents where portfolio_id=$1 and opted_out_at is null',[f.context.portfolioId])).rows.length,0);
  }
});

async function upgraded(f:Awaited<ReturnType<typeof fixture>>,index:number,expires=new Date(+f.at+86400000)){
  const {buildSessionPermissions}=await import('../src/permissions.js');
  const session=await buildSessionPermissions({publicClient:f.client,sessionKeyAddress:address(),executorAddress:f.read.profile.executor,validUntil:Math.floor(+expires/1000),yieldAccount:f.account});
  await query("insert into session_keys(portfolio_id,key_ref,permissions,status,expires_at) values($1,$2,$3,'active',$4)",[f.context.portfolioId,`m/44'/60'/0'/0/${f.context.portfolioId*1000+index}`,JSON.stringify(session.policySnapshot),expires]);
  return session;
}

test('#112 permission status excludes expired keys and uninstalled upgrades, and selects the older live key',async()=>{
  const f=await fixture(),{createYieldService}=await import('../src/yield-service.js'),{requireOwnedPortfolio}=await import('../src/portfolios.js');
  const service=createYieldService({profile:()=>f.profile,client:()=>f.client,read:async()=>structuredClone(f.read),owned:(id,wallet)=>requireOwnedPortfolio(id,wallet,{chainId:97})});
  await upgraded(f,0,new Date(+f.at-1000));
  assert.equal((await service.status(f.context.portfolioId,f.owner))?.permission,'needs_update');
  const live=await upgraded(f,1);f.sessionState.missing.push(live.permissionId.slice(2));
  assert.equal((await service.status(f.context.portfolioId,f.owner))?.permission,'needs_update');
  f.sessionState.missing=[];
  assert.equal((await service.status(f.context.portfolioId,f.owner))?.permission,'ok');
  f.sessionState.exhausted=[live.permissionId.slice(2)];
  assert.equal((await service.status(f.context.portfolioId,f.owner))?.permission,'needs_update','API shares GasPolicy exhaustion');
});

test('#112 risk exit tries older installed sessions; only proven pre-prepare authorization rejection may fallback',async()=>{
  for(const failure of ['uninstalled','revoked','exhausted','exhausted-late','authorization','after-prepare','unknown','rpc'] as const){
    const f=await fixture(),{createYieldService}=await import('../src/yield-service.js');
    const old=await upgraded(f,10),latest=await upgraded(f,11,new Date(+f.at+172800000));
    if(failure==='uninstalled')f.sessionState.missing.push(latest.permissionId.slice(2));
    if(failure==='revoked')f.sessionState.revoked.push(latest.permissionId.slice(2));
    if(failure==='exhausted')f.sessionState.exhausted.push(latest.permissionId.slice(2));
    const p=f.read.positions[0];assert.ok(p);Object.assign(p,{receipt:50n*WAD,observedUnits:50n*WAD,trackedUnits:50n*WAD,claim:50n*WAD,value:50n*WAD,maxRedeem:50n*WAD});
    f.read.risks=f.read.risks.map(r=>({...r,utilizationBps:9000}));
    const tried:Hex[]=[];
    const service=createYieldService({profile:()=>f.profile,client:()=>f.client,read:async()=>structuredClone(f.read),canSend:()=>true,port:async()=>({reconcileYieldOperation:async()=>{throw new Error('unexpected reconcile');},submitYieldAction:async args=>{
      tried.push(args.sessionKey.permissionId);
      if(args.sessionKey.permissionId===latest.permissionId){
        if(failure==='after-prepare'){
          const saved=f.prepared({...f.plan,kind:'withdraw',receiptBalance:50n*WAD});assert.ok(args.paymaster?.reserve);
          await args.paymaster.reserve(saved.reservation);await args.journal.prepare(saved.input);
          throw new AppError(409,'SESSION_AUTHORIZATION_REQUIRED','failure after durable prepare');
        }
        if(failure==='exhausted-late'){f.sessionState.exhausted.push(latest.permissionId.slice(2));throw new AppError(503,'PAYMASTER_SUBMISSION_UNAVAILABLE','prepare estimate failed');}
        if(failure==='authorization')throw new AppError(409,'SESSION_AUTHORIZATION_REQUIRED','pre-send installation missing');
        if(failure==='unknown')throw new AppError(503,'YIELD_RECONCILIATION_REQUIRED','unknown');
        throw new Error('SECRET_RPC_TIMEOUT');
      }
      return{assets:50n*WAD,shares:50n*WAD,remainingReceipts:0n,txHash:hash(),userOpHash:hash(),gasUsed:1n};
    }})});
    if(failure==='unknown'||failure==='rpc'||failure==='after-prepare')await assert.rejects(locked(f.context.portfolioId,()=>service.tick(f.context,false)));
    else assert.equal(await locked(f.context.portfolioId,()=>service.tick(f.context,false)),'生息領出已確認');
    assert.deepEqual(tried,failure==='uninstalled'||failure==='revoked'||failure==='exhausted'?[old.permissionId]:failure==='authorization'||failure==='exhausted-late'?[latest.permissionId,old.permissionId]:[latest.permissionId]);
  }
});

test('#112 Aave rebase followed by a reorg persists an irreversible tombstone and freezes supply and cash',async()=>{
  const f=await fixture(undefined,'none',yieldFixture(['aave_v3'])),i=f.prepared({...f.plan,scaledReceiptBalance:0n});f.current=i;
  await locked(f.context.portfolioId,()=>f.journal.prepare(i.input));
  const p=f.read.positions[0];assert.ok(p);Object.assign(p,{receipt:50n*WAD,observedUnits:50n*WAD,trackedUnits:50n*WAD,claim:50n*WAD,value:50n*WAD});
  f.read.risks=f.read.risks.map(r=>({...r,exposure:50n*WAD}));
  f.setProof({read:f.read,logIndex:0,blockNumber:f.read.observation.block,blockHash:f.blockHash,occurredAt:f.at});
  await locked(f.context.portfolioId,()=>f.journal.confirmed(i.input.executionKey,{assets:50n*WAD,shares:50n*WAD,remainingReceipts:50n*WAD,txHash:hash(),userOpHash:i.input.userOpHash,gasUsed:1n}));
  Object.assign(p,{receipt:51n*WAD,rate:RAY*51n/50n,claim:51n*WAD,value:51n*WAD});await persistYieldRead(f.context,f.read);
  f.state.blockHash=hash();const {createYieldService}=await import('../src/yield-service.js');
  const service=createYieldService({profile:()=>f.read.profile,client:()=>f.client,read:async()=>structuredClone(f.read)});
  for(let n=0;n<2;n++)await assert.rejects(locked(f.context.portfolioId,()=>service.tick(f.context,false)));
  assert.equal((await query<{state:string}>('select state from yield_events where execution_key=$1',[i.input.executionKey])).rows[0]?.state,'reorged');
  await assert.rejects(query("update yield_events set state='confirmed',updated_at=clock_timestamp() where execution_key=$1",[i.input.executionKey]));
  assert.equal(await balance(f.context.portfolioId),(950n*WAD).toString());
});

for(const scenario of ['confirmed','missing','ambiguous'] as const)test(`#106 Aave rebasing settlement: ${scenario}`,async()=>{
  const f=await fixture(yieldFixture(['aave_v3']).read),principal=100n*WAD;
  // Actual BE106 fork evidence: raw withdrawals exceed minted raw shares by 428082192685.
  const supplied=99999999999999999999n,units=99999567448598564709n,left=49999783866992728648n;
  const finalAssets=50000000428082192684n;
  f.ctx.sources={allocated_cash_raw:principal.toString()};
  const supply=f.prepared({...f.plan,amount:principal,minimum:supplied,scaledReceiptBalance:0n});
  f.current=supply;
  async function settle(current:ReturnType<typeof f.prepared>,assets:bigint,shares:bigint,remaining:bigint,after:bigint,index:bigint,block:bigint){
    f.current=current;
    await locked(f.context.portfolioId,()=>f.journal.prepare(current.input));
    await locked(f.context.portfolioId,()=>f.journal.sending(current.input.executionKey));
    const blockHash=hash(),at=new Date();
    const p=f.read.positions[0];assert.ok(p);
    Object.assign(p,{block,blockHash,at,receipt:remaining,observedUnits:after,trackedUnits:after,claim:remaining,value:remaining,maxWithdraw:remaining,maxRedeem:remaining,rate:index,scale:RAY});
    f.read.risks=f.read.risks.map(r=>({...r,block,blockHash,at,exposure:remaining}));
    f.setProof({read:f.read,logIndex:0,blockNumber:block,blockHash,occurredAt:at});
    const evidence={assets,shares,remainingReceipts:remaining,txHash:hash(),userOpHash:current.input.userOpHash,gasUsed:1n};
    const restarted=createYieldJournal({...f.ctx,reserve:()=>null});
    if(after===0n){
      const cashBefore=await balance(f.context.portfolioId);
      const positionBefore=(await query('select receipt_raw,tracked_units_raw from yield_positions where portfolio_id=$1',[f.context.portfolioId])).rows;
      if(scenario==='ambiguous')await query(`insert into yield_position_snapshots(chain_id,portfolio_id,market_id,block_number,block_hash,observed_at,source,
        receipt_raw,observed_units_raw,tracked_units_raw,claim_assets_raw,max_withdraw_raw,max_redeem_raw,value_usdt_raw,rate_raw,rate_scale,valuation_state)
        values(97,$1,$2,$3,$4,clock_timestamp(),'test:conflicting-scaled-proof',0,1,1,0,0,0,0,1,$5,'known')`,
        [f.context.portfolioId,f.market.marketId,block.toString(),blockHash,RAY.toString()]);
      for(const journal of [
        createYieldJournal({...f.ctx,settlement:async()=>{throw new Error('SECRET_RPC_TIMEOUT');}}),
        createYieldJournal(f.ctx,{transaction:async fn=>withTransaction(async client=>{const result=await fn(client);await client.query('select 1/0');return result;})}),
      ]){
        await assert.rejects(locked(f.context.portfolioId,()=>journal.confirmed(current.input.executionKey,evidence)));
        assert.equal(await balance(f.context.portfolioId),cashBefore,'failed settlement never credits principal');
        assert.equal((await query('select execution_key from yield_events where execution_key=$1',[current.input.executionKey])).rows.length,0);
        assert.equal((await query<{state:string}>('select state from yield_actions where execution_key=$1',[current.input.executionKey])).rows[0]?.state,'unknown');
        assert.deepEqual((await query('select receipt_raw,tracked_units_raw from yield_positions where portfolio_id=$1',[f.context.portfolioId])).rows,positionBefore);
      }
      if(scenario!=='confirmed'){
        await assert.rejects(locked(f.context.portfolioId,()=>restarted.confirmed(current.input.executionKey,evidence)));
        assert.equal(await balance(f.context.portfolioId),cashBefore);
        assert.equal((await query('select execution_key from yield_events where execution_key=$1',[current.input.executionKey])).rows.length,0);
        assert.equal((await query<{state:string}>('select state from yield_actions where execution_key=$1',[current.input.executionKey])).rows[0]?.state,'unknown');
        assert.deepEqual((await query('select receipt_raw,tracked_units_raw from yield_positions where portfolio_id=$1',[f.context.portfolioId])).rows,positionBefore);
        return;
      }
    }
    await locked(f.context.portfolioId,()=>restarted.confirmed(current.input.executionKey,evidence));
    await locked(f.context.portfolioId,()=>restarted.confirmed(current.input.executionKey,evidence));
    assert.equal((await query('select execution_key from yield_events where execution_key=$1',[current.input.executionKey])).rows.length,1);
  }
  await settle(supply,principal,supplied,supplied,units,1000004325532724505327245053n,101n);
  f.ctx.sources={};f.ctx.consentId=null;
  const partial=f.prepared({...supply.input.plan,kind:'withdraw',amount:50n*WAD,minimum:50n*WAD,receiptBalance:100000000285388127853n,scaledReceiptBalance:units},1n);
  await settle(partial,50n*WAD,50n*WAD,50000000285388127852n,left,1000004328386618128422920011n,102n);
  const final=f.prepared({...partial.input.plan,amount:finalAssets,minimum:finalAssets,receiptBalance:finalAssets,scaledReceiptBalance:scenario==='missing'?undefined:left},2n);
  await settle(final,finalAssets,finalAssets,0n,0n,1000004331240511761473196018n,103n);
  if(scenario!=='confirmed')return;
  assert.equal(await balance(f.context.portfolioId),(1000n*WAD).toString());
  assert.equal((await query<{n:string}>('select yield_raw::text as n from strategy_cash_balances where portfolio_id=$1',[f.context.portfolioId])).rows[0]?.n,(50n*WAD+finalAssets-principal).toString());
  assert.deepEqual((await query<{receipt:string;units:string}>('select receipt_raw::text as receipt,tracked_units_raw::text as units from yield_positions where portfolio_id=$1',[f.context.portfolioId])).rows[0],{receipt:'0',units:'0'});
});

test('BE84 journal commits action/operation/snapshot/cash/sponsorship/gas atomically and restores exact public evidence',async()=>{
  const f=await fixture(),i=f.current.input;
  await locked(f.context.portfolioId,()=>f.journal.prepare(i));
  const row=(await query<SnapshotRow>('select * from yield_execution_snapshots where execution_key=$1',[i.executionKey])).rows[0];assert.ok(row);
  assert.deepEqual(restoreYieldOperation(row),{plan:i.plan,nonce:i.nonce,callData:i.callData,userOpHash:i.userOpHash});
  assert.equal(await balance(f.context.portfolioId),(950n*WAD).toString());
  const audit=(await query<{n:string}>(`select count(*)::text as n from operations where yield_execution_key=$1 and state='pending'`,[i.executionKey])).rows[0];assert.equal(audit?.n,'1');
  assert.equal(JSON.stringify(row.plan_json).includes('signature'),false);
  await assert.rejects(locked(f.context.portfolioId,()=>f.journal.prepare(i)));
  assert.equal(await balance(f.context.portfolioId),(950n*WAD).toString());
  await locked(f.context.portfolioId,()=>f.journal.sending(i.executionKey));
  await locked(f.context.portfolioId,()=>f.journal.submitted(i.executionKey,i.userOpHash));
  assert.equal((await query<{state:string}>('select state from yield_actions where execution_key=$1',[i.executionKey])).rows[0]?.state,'unknown');
  await assert.rejects(query('update yield_execution_snapshots set nonce=1 where execution_key=$1',[i.executionKey]));
});

test('BE84 rollback and lost COMMIT response never return permission to broadcast or double-debit',async()=>{
  for(const lost of [false,true]){
    const f=await fixture(),i=f.current.input;
    const transaction:typeof withTransaction=async fn=>{
      const value=await withTransaction(async client=>{const result=await fn(client);if(!lost)await client.query('select 1/0');return result;});
      throw new Error('SECRET_DB_COMMIT_RESPONSE');
    };
    const journal=createYieldJournal(f.ctx,{transaction});
    await assert.rejects(locked(f.context.portfolioId,()=>journal.prepare(i)));
    const snapshots=(await query('select execution_key from yield_execution_snapshots where execution_key=$1',[i.executionKey])).rows.length;
    assert.equal(snapshots,lost?1:0);assert.equal(await balance(f.context.portfolioId),((lost?950n:1000n)*WAD).toString());
    if(lost){await assert.rejects(locked(f.context.portfolioId,()=>f.journal.prepare(i)));assert.equal(await balance(f.context.portfolioId),(950n*WAD).toString());}
  }
});

test('BE84 R to C, permanent event deduplication, restart recovery and partial withdrawal preserve source',async()=>{
  const f=await fixture(),i=f.current.input;
  await locked(f.context.portfolioId,()=>f.journal.prepare(i));await locked(f.context.portfolioId,()=>f.journal.sending(i.executionKey));
  const post=structuredClone(f.read),blockHash=hash(),at=new Date();
  const pos=post.positions[0];assert.ok(pos);
  Object.assign(pos,{block:101n,blockHash,at,receipt:50n*WAD,observedUnits:50n*WAD,trackedUnits:50n*WAD,claim:50n*WAD,value:50n*WAD,maxWithdraw:25n*WAD,maxRedeem:25n*WAD});
  post.risks=post.risks.map(r=>({...r,block:101n,blockHash,at,exposure:50n*WAD}));
  f.setProof({read:post,logIndex:0,blockNumber:101n,blockHash,occurredAt:at});
  const evidence:YieldEvidence={assets:50n*WAD,shares:50n*WAD,remainingReceipts:50n*WAD,txHash:hash(),userOpHash:i.userOpHash,gasUsed:1000n};
  const restarted=createYieldJournal({...f.ctx,reserve:()=>null});
  await locked(f.context.portfolioId,()=>restarted.confirmed(i.executionKey,evidence));
  await locked(f.context.portfolioId,()=>restarted.confirmed(i.executionKey,evidence));
  assert.equal((await query('select * from yield_events where execution_key=$1',[i.executionKey])).rows.length,1);
  assert.equal((await query<{state:string}>('select state from yield_actions where execution_key=$1',[i.executionKey])).rows[0]?.state,'confirmed');
  const withdrawal=f.prepared({...i.plan,kind:'withdraw',amount:25n*WAD,minimum:25n*WAD,receiptBalance:50n*WAD},1n);
  f.current=withdrawal;f.ctx.sources={};f.ctx.consentId=null;
  await query("update yield_positions set exit_state='exiting',exit_reason='owner_requested',updated_at=clock_timestamp() where portfolio_id=$1",[f.context.portfolioId]);
  await locked(f.context.portfolioId,()=>f.journal.prepare(withdrawal.input));await locked(f.context.portfolioId,()=>f.journal.sending(withdrawal.input.executionKey));
  const nextHash=hash(),nextAt=new Date();Object.assign(pos,{block:102n,blockHash:nextHash,at:nextAt,receipt:25n*WAD,observedUnits:25n*WAD,trackedUnits:25n*WAD,claim:25n*WAD,value:25n*WAD});
  post.risks=post.risks.map(r=>({...r,block:102n,blockHash:nextHash,at:nextAt,exposure:25n*WAD}));
  f.setProof({read:post,logIndex:1,blockNumber:102n,blockHash:nextHash,occurredAt:nextAt});
  await locked(f.context.portfolioId,()=>f.journal.confirmed(withdrawal.input.executionKey,{assets:26n*WAD,shares:25n*WAD,remainingReceipts:25n*WAD,txHash:hash(),userOpHash:withdrawal.input.userOpHash,gasUsed:1000n}));
  assert.equal(await balance(f.context.portfolioId),(975n*WAD).toString());
  assert.equal((await query<{n:string}>('select yield_raw::text as n from strategy_cash_balances where portfolio_id=$1',[f.context.portfolioId])).rows[0]?.n,WAD.toString());
  assert.equal((await query<{exit_state:string}>('select exit_state from yield_positions where portfolio_id=$1',[f.context.portfolioId])).rows[0]?.exit_state,'exiting');
});

test('BE84 two accounts sharing the same market cannot reserve over the common capacity, including exact equality',async()=>{
  const f=await fixture(),g=await fixture(f.read);
  const baseRisk=f.read.risks[0];assert.ok(baseRisk);
  const risk={...baseRisk,exposure:0n,supply:10000n*WAD,liquidity:1000n*WAD};assert.ok(risk.key);
  f.read.risks=[risk];await persistYieldRead(f.context,f.read);
  const results=await Promise.allSettled([locked(f.context.portfolioId,()=>f.journal.prepare(f.current.input)),locked(g.context.portfolioId,()=>g.journal.prepare(g.current.input))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,2,'2 x 50 == 100 is allowed');
  const third=await fixture(f.read);
  await assert.rejects(locked(third.context.portfolioId,()=>third.journal.prepare(third.current.input)));
});

test('BE84 canonical revert restores only original cash source; unknown never releases its capacity',async()=>{
  const f=await fixture(),i=f.current.input;
  await locked(f.context.portfolioId,()=>f.journal.prepare(i));await locked(f.context.portfolioId,()=>f.journal.unknown(i.executionKey));
  assert.equal(await balance(f.context.portfolioId),(950n*WAD).toString());
  const restarted=createYieldJournal({...f.ctx,reserve:()=>null});
  await locked(f.context.portfolioId,()=>restarted.reverted(i.executionKey,{status:'reverted',txHash:hash(),userOpHash:i.userOpHash,gasUsed:1n,retryable:false}));
  assert.equal(await balance(f.context.portfolioId),(1000n*WAD).toString());
  assert.equal((await query<{state:string}>('select state from gas_budget_reservations where execution_key=$1',[i.executionKey])).rows[0]?.state,'failed');
});

test('BE84 API status includes only selected/held markets; missing values stay unknown; receipts cannot be spent as cash',async()=>{
  const f=await fixture();
  const {createYieldService}=await import('../src/yield-service.js');
  const {requireOwnedPortfolio}=await import('../src/portfolios.js');
  const service=createYieldService({profile:()=>f.read.profile,read:async()=>structuredClone(f.read),client:()=>f.client,
    owned:(id,wallet)=>requireOwnedPortfolio(id,wallet,{chainId:97})});
  const status=await service.status(f.context.portfolioId,f.owner);assert.ok(status);
  assert.equal(status.assets.length,1);assert.equal(status.assets[0]?.state,'cash');assert.equal(status.accountValue,(1000n*WAD).toString());
  const p=f.read.positions[0];assert.ok(p);p.receipt=1n;p.claim=WAD;p.value=null;p.state='unknown';
  const unknown=await service.status(f.context.portfolioId,f.owner);assert.equal(unknown?.assets[0]?.receiptValue,null);
  assert.equal(unknown?.assets[0]?.pending?.reason,'unknown');assert.equal(unknown?.assets[0]?.pending?.value,null);
  await assert.rejects(service.status(f.context.portfolioId,address()));
});

test('BE84 owner policy proof binds chain, account, market and enrollment; revoke and full exit are durable/replayable',async()=>{
  const f=await fixture();
  const {createYieldService}=await import('../src/yield-service.js');const {requireOwnedPortfolio}=await import('../src/portfolios.js');
  f.state.proofSid=BigInt(f.strategyId)+84000000n;f.state.proofAccount=f.account;f.state.proofMarket=f.market.marketId;
  const service=createYieldService({profile:()=>f.read.profile,read:async()=>structuredClone(f.read),client:()=>f.client,
    owned:(id,wallet)=>requireOwnedPortfolio(id,wallet,{chainId:97})});
  const input=()=>({markets:[f.market.id],txHash:f.state.proofHash});
  await service.consent(f.context.portfolioId,f.owner,input());await service.consent(f.context.portfolioId,f.owner,input());
  assert.equal((await query('select id from yield_consents where portfolio_id=$1 and policy_version=$2',[f.context.portfolioId,f.state.proofHash])).rows.length,1);
  const activeHash=f.state.proofHash;
  f.state.proofHash=hash();f.state.proofEnabled=false;
  await service.revoke(f.context.portfolioId,f.owner,input());
  assert.equal((await query('select id from yield_consents where portfolio_id=$1 and opted_out_at is null',[f.context.portfolioId])).rows.length,0);
  f.state.proofEnabled=true;f.state.proofHash=activeHash;
  await service.consent(f.context.portfolioId,f.owner,input());
  assert.equal((await query('select id from yield_consents where portfolio_id=$1 and opted_out_at is null',[f.context.portfolioId])).rows.length,0,'replaying opted-out proof cannot restore consent');
  f.state.proofHash=hash();f.state.proofKind='exit';
  const first=await service.exit(f.context.portfolioId,f.owner,input()),second=await service.exit(f.context.portfolioId,f.owner,input());
  assert.equal(first.requestId,second.requestId);assert.equal(second.replayed,true);
  for(const patch of [{proofRemoved:true},{proofDuplicate:true},{proofSuccess:false},{proofAccount:address()}]){
    const old={...f.state};Object.assign(f.state,patch);await assert.rejects(service.exit(f.context.portfolioId,f.owner,input()));Object.assign(f.state,old);
  }
});

test('#105 consented survives receipt boundaries and changes only with current enrollment owner consent',async()=>{
  const f=await fixture();
  const {createYieldService}=await import('../src/yield-service.js');
  const {requireOwnedPortfolio}=await import('../src/portfolios.js');
  const service=createYieldService({profile:()=>f.read.profile,read:async()=>structuredClone(f.read),client:()=>f.client,
    owned:(id,wallet)=>requireOwnedPortfolio(id,wallet,{chainId:97})});
  const p=f.read.positions[0];assert.ok(p);
  const current=async()=>{const status=await service.status(f.context.portfolioId,f.owner);assert.ok(status);const asset=status.assets[0];assert.ok(asset);return asset;};
  assert.equal((await current()).consented,true);
  for(const receipt of [1n,UINT256_MAX]){
    Object.assign(p,{receipt,observedUnits:receipt,trackedUnits:receipt,claim:receipt,value:receipt,maxWithdraw:receipt,maxRedeem:receipt});
    const asset=await current();assert.equal(asset.consented,true);assert.equal(asset.state,'supplied');assert.equal(asset.receiptValue,receipt.toString());
  }
  const receipt=50n*WAD;
  Object.assign(p,{receipt,observedUnits:receipt,trackedUnits:receipt,claim:receipt,value:receipt,maxWithdraw:receipt,maxRedeem:receipt});
  f.state.proofSid=BigInt(f.strategyId)+84000000n;f.state.proofEnabled=false;
  const input=()=>({markets:[f.market.id],txHash:f.state.proofHash});
  await service.revoke(f.context.portfolioId,f.owner,input());
  const revoked=await current();assert.equal(revoked.consented,false);assert.equal(revoked.state,'supplied');assert.equal(revoked.receiptValue,receipt.toString());assert.equal(revoked.pending,null);
  f.state.proofHash=hash();f.state.proofEnabled=true;
  await service.consent(f.context.portfolioId,f.owner,input());
  const consented=await current();assert.equal(consented.consented,true);assert.equal(consented.state,'supplied');
  f.state.proofHash=hash();f.state.proofKind='exit';
  await service.exit(f.context.portfolioId,f.owner,input());
  const exiting=await current();assert.equal(exiting.consented,false);assert.equal(exiting.state,'exiting');assert.equal(exiting.receiptValue,receipt.toString());
  const at=new Date();
  Object.assign(p,{receipt:0n,observedUnits:0n,trackedUnits:0n,claim:0n,value:0n,maxWithdraw:0n,maxRedeem:0n,at});
  f.read.observation.at=at;f.read.risks=f.read.risks.map(r=>({...r,at}));
  await locked(f.context.portfolioId,()=>service.tick(f.context,false));
  const stopped=await current();assert.equal(stopped.consented,false);assert.equal(stopped.state,'stopped');assert.equal(stopped.receiptValue,'0');
  f.state.proofHash=hash();f.state.proofKind='policy';
  await service.consent(f.context.portfolioId,f.owner,input());
  const restarted=await current();assert.equal(restarted.consented,true);assert.equal(restarted.state,'cash');
});

test('#105 consented excludes old enrollment versions and absent consent even with zero receipts',async()=>{
  const f=await fixture();
  const {createYieldService}=await import('../src/yield-service.js');
  const {requireOwnedPortfolio}=await import('../src/portfolios.js');
  const service=createYieldService({profile:()=>f.read.profile,read:async()=>structuredClone(f.read),client:()=>f.client,
    owned:(id,wallet)=>requireOwnedPortfolio(id,wallet,{chainId:97})});
  await query(`insert into strategy_versions(strategy_id,version,allocation,schedule,active_at,execution_schema_version,execution,execution_chain_id,config_hash)
    select strategy_id,2,allocation,schedule,active_at,execution_schema_version,execution,execution_chain_id,config_hash from strategy_versions where strategy_id=$1 and version=1`,[f.strategyId]);
  await query('update portfolios set version=2 where id=$1',[f.context.portfolioId]);
  const status=await service.status(f.context.portfolioId,f.owner);assert.ok(status);
  assert.equal(status.assets[0]?.consented,false);assert.equal(status.assets[0]?.state,'not_consented');assert.equal(status.assets[0]?.receiptValue,'0');
  await query('update portfolios set version=1 where id=$1',[f.context.portfolioId]);
  assert.equal((await service.status(f.context.portfolioId,f.owner))?.assets[0]?.consented,true);
  await query('update yield_consents set opted_out_at=clock_timestamp(),updated_at=clock_timestamp() where portfolio_id=$1',[f.context.portfolioId]);
  assert.equal((await service.status(f.context.portfolioId,f.owner))?.assets[0]?.consented,false);
});

test('#105 valuation gaps preserve consent; DB/RPC failures and timeouts cannot serialize false consent or leak details',async()=>{
  const f=await fixture();
  const {createYieldService}=await import('../src/yield-service.js');
  const {requireOwnedPortfolio}=await import('../src/portfolios.js');
  const deps={profile:()=>f.read.profile,read:async()=>structuredClone(f.read),client:()=>f.client,
    owned:(id:number,wallet:string)=>requireOwnedPortfolio(id,wallet,{chainId:97})};
  const p=f.read.positions[0];assert.ok(p);Object.assign(p,{state:'unknown',receipt:null,claim:null,value:null});
  const unknown=await createYieldService(deps).status(f.context.portfolioId,f.owner);assert.ok(unknown);
  assert.equal(unknown.assets[0]?.consented,true);assert.equal(unknown.assets[0]?.receiptValue,null);assert.equal(unknown.assets[0]?.valuationState,'unknown');
  for(const message of ['SECRET_DB_CONNECTION','SECRET_RPC_ENDPOINT','SECRET_RPC_TIMEOUT']){
    const fail=async()=>{throw new Error(message);};
    const service=createYieldService({...deps,...(message==='SECRET_DB_CONNECTION'?{query:fail}:{read:fail})});
    await assert.rejects(service.status(f.context.portfolioId,f.owner),error=>{
      assert.ok(error instanceof AppError);assert.equal(error.status,503);assert.equal(error.code,'YIELD_UNAVAILABLE');assert.doesNotMatch(error.message,/SECRET/);return true;
    });
  }
});

test('BE84 cross-market workers share Lista capacity; one raw over the combined cap rolls back gas/cash/action together',async()=>{
  const source=yieldFixture(['lista','lista']).read;
  source.risks=source.risks.slice(0,1).map(r=>({...r,supply:10000n*WAD,liquidity:1000n*WAD}));
  const f=await fixture(source),other=structuredClone(source);other.profile={...other.profile,markets:[...other.profile.markets].reverse()};
  const g=await fixture(other);g.current=g.prepared({...g.plan,amount:50n*WAD+1n,minimum:50n*WAD+1n});g.ctx.sources={allocated_cash_raw:(50n*WAD+1n).toString()};
  const results=await Promise.allSettled([locked(f.context.portfolioId,()=>f.journal.prepare(f.current.input)),locked(g.context.portfolioId,()=>g.journal.prepare(g.current.input))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const keys=[f.current.input.executionKey,g.current.input.executionKey];
  assert.equal((await query('select execution_key from gas_budget_reservations where execution_key=any($1::text[])',[keys])).rows.length,1);
  const sum=(await query<{n:string}>('select sum(amount_raw)::text as n from yield_actions where execution_key=any($1::text[])',[keys])).rows[0]?.n;assert.ok(sum);assert.ok(BigInt(sum)<=100n*WAD);
});

test('BE84 risk exit ignores account pause/consent/buy throttles and remains sticky while execution is disabled',async()=>{
  const f=await fixture();const {createYieldService}=await import('../src/yield-service.js');
  const p=f.read.positions[0];assert.ok(p);Object.assign(p,{receipt:50n*WAD,observedUnits:50n*WAD,trackedUnits:50n*WAD,claim:50n*WAD,value:50n*WAD,maxWithdraw:25n*WAD,maxRedeem:25n*WAD});
  f.read.risks=f.read.risks.map(r=>({...r,utilizationBps:9000,exposure:50n*WAD}));
  await query("update portfolios set schedule_state='paused' where id=$1",[f.context.portfolioId]);
  await query('update yield_consents set opted_out_at=clock_timestamp(),updated_at=clock_timestamp() where portfolio_id=$1',[f.context.portfolioId]);
  let sends=0;
  const service=createYieldService({profile:()=>f.read.profile,client:()=>f.client,read:async()=>structuredClone(f.read),canSend:()=>false,port:async()=>{sends++;throw new Error('unexpected sending');}});
  await locked(f.context.portfolioId,()=>service.tick(f.context,false));
  assert.equal(sends,0);
  const position=(await query<{exit_state:string;exit_reason:string}>('select exit_state,exit_reason from yield_positions where portfolio_id=$1',[f.context.portfolioId])).rows[0];
  assert.deepEqual(position,{exit_state:'retry',exit_reason:'high_utilization'});
  f.read.risks=f.read.risks.map(r=>({...r,utilizationBps:0}));
  await locked(f.context.portfolioId,()=>service.tick(f.context,false));
  assert.equal((await query<{exit_state:string}>('select exit_state from yield_positions where portfolio_id=$1',[f.context.portfolioId])).rows[0]?.exit_state,'retry');
});

test('BE84 canonical history reorg leaves a permanent tombstone and freezes the original position/cash',async()=>{
  const f=await fixture(),i=f.current.input;
  await locked(f.context.portfolioId,()=>f.journal.prepare(i));await locked(f.context.portfolioId,()=>f.journal.sending(i.executionKey));
  const post=structuredClone(f.read),blockHash=hash(),at=new Date();
  const pos=post.positions[0];assert.ok(pos);Object.assign(pos,{block:101n,blockHash,at,receipt:50n*WAD,observedUnits:50n*WAD,trackedUnits:50n*WAD,claim:50n*WAD,value:50n*WAD});
  post.risks=post.risks.map(r=>({...r,block:101n,blockHash,at,exposure:50n*WAD}));
  f.setProof({read:post,logIndex:0,blockNumber:101n,blockHash,occurredAt:at});
  const e:YieldEvidence={assets:50n*WAD,shares:50n*WAD,remainingReceipts:50n*WAD,txHash:hash(),userOpHash:i.userOpHash,gasUsed:1n};
  await locked(f.context.portfolioId,()=>f.journal.confirmed(i.executionKey,e));
  await assert.rejects(locked(f.context.portfolioId,()=>f.journal.confirmed(i.executionKey,{...e,assets:e.assets+1n})));
  const {createYieldService}=await import('../src/yield-service.js');
  const service=createYieldService({profile:()=>f.read.profile,client:()=>f.client,read:async()=>structuredClone(f.read)});
  await assert.rejects(locked(f.context.portfolioId,()=>service.tick(f.context,true)));
  assert.equal((await query<{state:string}>('select state from yield_events where execution_key=$1',[i.executionKey])).rows[0]?.state,'confirmed','dry-run cannot write a tombstone');
  await assert.rejects(locked(f.context.portfolioId,()=>service.tick(f.context,false)));
  assert.equal((await query<{state:string}>('select state from yield_events where execution_key=$1',[i.executionKey])).rows[0]?.state,'reorged');
  assert.equal(await balance(f.context.portfolioId),(950n*WAD).toString());
  assert.equal((await query<{n:string}>('select receipt_raw::text as n from yield_positions where portfolio_id=$1',[f.context.portfolioId])).rows[0]?.n,(50n*WAD).toString());
  const {detectYieldAttention}=await import('../src/alerts.js');
  assert.ok((await detectYieldAttention(query)).some(a=>a.portfolioId===f.context.portfolioId));
});

test('BE84 final prepare rejects an orphaned quote before reserving gas or cash',async()=>{
  const f=await fixture();
  const {createYieldService}=await import('../src/yield-service.js');
  const {buildSessionPermissions}=await import('../src/permissions.js');
  f.state.proofSid=BigInt(f.strategyId)+84000000n;
  const session=await buildSessionPermissions({publicClient:f.client,sessionKeyAddress:f.owner,executorAddress:f.read.profile.executor,
    validUntil:Math.floor(Date.now()/1000)+86400,yieldAccount:f.account});
  await query(`insert into session_keys(portfolio_id,key_ref,permissions,status,expires_at) values($1,$2,$3,'active',$4)`,
    [f.context.portfolioId,`m/44'/60'/0'/0/${f.context.portfolioId}`,JSON.stringify(session.policySnapshot),session.expiresAt]);
  f.current=f.prepared({...f.plan,amount:1000n*WAD,minimum:1000n*WAD,quoteBlockHash:hash()});
  let prepares=0;
  const service=createYieldService({profile:()=>f.read.profile,client:()=>f.client,read:async()=>structuredClone(f.read),canSend:()=>true,
    port:async()=>({reconcileYieldOperation:async()=>{throw new Error('unexpected reconciliation');},submitYieldAction:async args=>{
      prepares++;assert.equal(args.action.amount,1000n*WAD);assert.ok(args.paymaster?.reserve);
      await args.paymaster.reserve(f.current.reservation);
      await assert.rejects(args.journal.prepare(f.current.input));
      return {assets:0n,shares:0n,remainingReceipts:0n,txHash:hash(),userOpHash:f.current.input.userOpHash,gasUsed:0n};
    }})});
  await locked(f.context.portfolioId,()=>service.tick(f.context,false));assert.equal(prepares,1);
  assert.equal(await balance(f.context.portfolioId),(1000n*WAD).toString());
  assert.equal((await query('select execution_key from yield_actions where portfolio_id=$1',[f.context.portfolioId])).rows.length,0);
  assert.equal((await query('select execution_key from gas_budget_reservations where execution_key=$1',[f.current.input.executionKey])).rows.length,0);
});

async function rebalanceFixture(){
  const f=await fixture(),i=f.current.input;
  await locked(f.context.portfolioId,()=>f.journal.prepare(i));
  const p=f.read.positions[0];assert.ok(p);
  Object.assign(p,{receipt:50n*WAD,observedUnits:50n*WAD,trackedUnits:50n*WAD,claim:50n*WAD,value:50n*WAD,maxWithdraw:50n*WAD,maxRedeem:50n*WAD});
  f.read.risks=f.read.risks.map(r=>({...r,exposure:50n*WAD}));
  f.setProof({read:f.read,logIndex:0,blockNumber:f.read.observation.block,blockHash:f.blockHash,occurredAt:f.at});
  await locked(f.context.portfolioId,()=>f.journal.confirmed(i.executionKey,{assets:50n*WAD,shares:50n*WAD,remainingReceipts:50n*WAD,txHash:hash(),userOpHash:i.userOpHash,gasUsed:1n}));
  const {buildSessionPermissions}=await import('../src/permissions.js');
  const session=await buildSessionPermissions({publicClient:f.client,sessionKeyAddress:f.owner,executorAddress:f.read.profile.executor,
    validUntil:Math.floor(Date.now()/1000)+86400,yieldAccount:f.account});
  await query(`insert into session_keys(portfolio_id,key_ref,permissions,status,expires_at) values($1,$2,$3,'active',$4)`,
    [f.context.portfolioId,`m/44'/60'/0'/0/${f.context.portfolioId}`,JSON.stringify(session.policySnapshot),session.expiresAt]);
  const {yieldRebalancePlan}=await import('./fixtures/yield.js');
  const request={plan:yieldRebalancePlan(f,f.context.portfolioId),reserve:0n,
    steps:[{tokenIn:f.asset,tokenOut:address(),amountIn:20n*WAD,amountOutMin:1n,oracleFloor:1n,venue:address(),data:'0x' as const}]};
  return {...f,request};
}

test('#104 partial rebalance withdrawal uses exit journal; restart reconciles original snapshot once and keeps remaining yield/consent',async()=>{
  const f=await rebalanceFixture();const {createYieldService}=await import('../src/yield-service.js');
  f.current=f.prepared({...f.plan,kind:'withdraw',amount:20n*WAD,minimum:20n*WAD,receiptBalance:50n*WAD},1n);
  let sends=0,reconciles=0;
  const evidence:YieldEvidence={assets:20n*WAD,shares:20n*WAD,remainingReceipts:30n*WAD,txHash:hash(),userOpHash:f.current.input.userOpHash,gasUsed:1n};
  const overrides={profile:()=>f.read.profile,client:()=>f.client,read:async()=>structuredClone(f.read),canSend:()=>true,
    port:async()=>({submitYieldAction:async(args:Parameters<import('../src/yield-port.js').YieldExecutionPort['submitYieldAction']>[0])=>{
      sends++;assert.deepEqual(args.action,{kind:'withdraw',marketId:f.market.marketId,amount:20n*WAD});
      assert.equal(f.current.reservation.budget.purpose,'exit');assert.ok(args.paymaster?.reserve);
      await args.paymaster.reserve(f.current.reservation);await args.journal.prepare(f.current.input);await args.journal.sending(f.current.input.executionKey);
      throw new Error('SECRET_RPC_TIMEOUT');
    },reconcileYieldOperation:async(_client:unknown,_url:unknown,saved:import('../src/yield-port.js').SavedYieldOperation)=>{
      reconciles++;assert.equal(saved.plan.amount,20n*WAD);assert.equal(saved.userOpHash,f.current.input.userOpHash);
      return {status:'confirmed' as const,evidence};
    }})};
  await assert.rejects(locked(f.context.portfolioId,()=>createYieldService(overrides).tick(f.context,false,f.request)),(e:unknown)=>e instanceof Error&&!e.message.includes('SECRET'));
  assert.equal((await query<{state:string}>('select state from yield_actions where execution_key=$1',[f.current.input.executionKey])).rows[0]?.state,'unknown');
  const p=f.read.positions[0];assert.ok(p);Object.assign(p,{receipt:30n*WAD,observedUnits:30n*WAD,trackedUnits:30n*WAD,claim:30n*WAD,value:30n*WAD});
  Object.assign(f.state,{proofKind:'withdraw',proofHash:evidence.txHash,proofAssets:evidence.assets,proofShares:evidence.shares,proofRemaining:evidence.remainingReceipts});
  await locked(f.context.portfolioId,()=>createYieldService(overrides).tick(f.context,false,f.request));
  const {yieldRebalancePlan}=await import('./fixtures/yield.js');
  f.request.plan=yieldRebalancePlan(f,f.context.portfolioId,20n*WAD);
  assert.equal(await locked(f.context.portfolioId,()=>createYieldService(overrides).tick(f.context,false,f.request)),null);
  assert.equal(sends,1);assert.equal(reconciles,1);
  assert.equal((await query<{state:string}>('select state from yield_actions where execution_key=$1',[f.current.input.executionKey])).rows[0]?.state,'confirmed');
  assert.equal((await query('select * from yield_events where execution_key=$1',[f.current.input.executionKey])).rows.length,1);
  assert.deepEqual((await query<{receipt:string;exit_state:string}>('select receipt_raw::text as receipt,exit_state from yield_positions where portfolio_id=$1',[f.context.portfolioId])).rows[0],{receipt:(30n*WAD).toString(),exit_state:'none'});
  assert.equal((await query('select * from yield_consents where portfolio_id=$1 and opted_out_at is null',[f.context.portfolioId])).rows.length,1);
  assert.equal((await query('select * from yield_exit_requests where portfolio_id=$1',[f.context.portfolioId])).rows.length,0);
});

test('#104 pause/illiquidity/disabled execution and DB/RPC errors defer rebalance without sticky full exit or losing claims',async()=>{
  const f=await rebalanceFixture(),p=f.read.positions[0];assert.ok(p);
  const {createYieldService}=await import('../src/yield-service.js');let sends=0;
  const overrides={profile:()=>f.read.profile,client:()=>f.client,read:async()=>structuredClone(f.read),canSend:()=>false,port:async()=>{sends++;throw new Error('unexpected send');}};
  const before=(await query('select id from yield_position_snapshots where portfolio_id=$1',[f.context.portfolioId])).rows.length;
  await locked(f.context.portfolioId,()=>createYieldService(overrides).tick(f.context,true,f.request));
  assert.equal((await query('select id from yield_position_snapshots where portfolio_id=$1',[f.context.portfolioId])).rows.length,before,'dry-run does not persist or send');
  const orphan=structuredClone(f.request),original=orphan.plan.snapshot.yieldPositions?.[0];assert.ok(original);original.blockHash=hash();
  await assert.rejects(locked(f.context.portfolioId,()=>createYieldService(overrides).tick(f.context,false,orphan)));
  for(const patch of [{maxRedeem:0n,maxWithdraw:0n},{withdrawPaused:true},{withdrawPaused:false,maxRedeem:50n*WAD,maxWithdraw:50n*WAD}]){
    Object.assign(p,patch);assert.ok(await locked(f.context.portfolioId,()=>createYieldService(overrides).tick(f.context,false,f.request)));
  }
  await assert.rejects(locked(f.context.portfolioId,()=>createYieldService({...overrides,read:async()=>{throw new Error('SECRET_RPC_TIMEOUT');}}).tick(f.context,false,f.request)),(e:unknown)=>e instanceof Error&&!e.message.includes('SECRET'));
  await assert.rejects(locked(f.context.portfolioId,()=>createYieldService({...overrides,query:async()=>{throw new Error('SECRET_DB_TIMEOUT');}}).tick(f.context,false,f.request)),(e:unknown)=>e instanceof Error&&!e.message.includes('SECRET'));
  assert.equal(sends,0);
  assert.deepEqual((await query<{receipt:string;exit_state:string}>('select receipt_raw::text as receipt,exit_state from yield_positions where portfolio_id=$1',[f.context.portfolioId])).rows[0],{receipt:(50n*WAD).toString(),exit_state:'none'});
  assert.equal((await query('select * from yield_actions where portfolio_id=$1 and kind=\'withdraw\'',[f.context.portfolioId])).rows.length,0);
});

test('#104 reorg of a confirmed source freezes rebalance and keeps consent and its receipt claim',async()=>{
  const f=await rebalanceFixture();f.state.blockHash=hash();
  const {createYieldService}=await import('../src/yield-service.js');let sends=0;
  const service=createYieldService({profile:()=>f.read.profile,client:()=>f.client,read:async()=>structuredClone(f.read),canSend:()=>true,port:async()=>{sends++;throw new Error('unexpected send');}});
  await assert.rejects(locked(f.context.portfolioId,()=>service.tick(f.context,false,f.request)));
  assert.equal(sends,0);
  assert.equal((await query<{state:string}>('select state from yield_events where portfolio_id=$1',[f.context.portfolioId])).rows[0]?.state,'reorged');
  assert.equal((await query<{receipt:string}>('select receipt_raw::text as receipt from yield_positions where portfolio_id=$1',[f.context.portfolioId])).rows[0]?.receipt,(50n*WAD).toString());
});

test('#104 monthly/drift pending survives a new service and suppresses re-supply until the persisted anchor / fresh drift clears',async()=>{
  const {createYieldService}=await import('../src/yield-service.js');
  const {yieldRebalancePlan}=await import('./fixtures/yield.js');
  for(const mode of ['monthly','drift'] as const){
    const f=await fixture(undefined,mode),plan=yieldRebalancePlan(f,f.context.portfolioId);assert.ok(plan.report);
    const {buildSessionPermissions}=await import('../src/permissions.js');
    const session=await buildSessionPermissions({publicClient:f.client,sessionKeyAddress:f.owner,executorAddress:f.read.profile.executor,
      validUntil:Math.floor(Date.now()/1000)+86400,yieldAccount:f.account});
    await query(`insert into session_keys(portfolio_id,key_ref,permissions,status,expires_at) values($1,$2,$3,'active',$4)`,
      [f.context.portfolioId,`m/44'/60'/0'/0/${f.context.portfolioId}`,JSON.stringify(session.policySnapshot),session.expiresAt]);
    f.state.proofSid=BigInt(f.strategyId)+84000000n;
    const last=new Date(f.at);last.setUTCMonth(last.getUTCMonth()-1);
    await query('update portfolios set last_rebalance_at=$2 where id=$1',[f.context.portfolioId,last]);
    let sends=0;
    const overrides={profile:()=>f.read.profile,client:()=>f.client,read:async()=>structuredClone(f.read),plan:async()=>plan,canSend:()=>true,
      port:async()=>({reconcileYieldOperation:async()=>{throw new Error('unexpected recovery');},submitYieldAction:async(args:Parameters<import('../src/yield-port.js').YieldExecutionPort['submitYieldAction']>[0])=>{
        sends++;assert.equal(args.action.kind,'supply');return {assets:args.action.amount,shares:args.action.amount,remainingReceipts:args.action.amount,txHash:hash(),userOpHash:hash(),gasUsed:1n};
      }})};
    plan.report.maxAbsDeltaBps=501;
    assert.match(await locked(f.context.portfolioId,()=>createYieldService(overrides).tick(f.context,false))??'',/暫緩新供給/);
    assert.equal(sends,0);
    if(mode==='drift'){
      await assert.rejects(locked(f.context.portfolioId,()=>createYieldService({...overrides,plan:async()=>{throw new Error('SECRET_RPC_TIMEOUT');}}).tick(f.context,false)),(e:unknown)=>e instanceof Error&&!e.message.includes('SECRET'));
      assert.equal(sends,0);
    }
    await query('update portfolios set last_rebalance_at=$2 where id=$1',[f.context.portfolioId,f.at]);
    plan.report.maxAbsDeltaBps=500;
    await locked(f.context.portfolioId,()=>createYieldService(overrides).tick(f.context,false));
    assert.equal(sends,1,'remaining consent and normal idle/cooldown/cap rules can supply again');
  }
});


test('#112-r2 durable rotation visits 21 unknowns and gives owner exits and held-risk independent slots even when locks are busy',async()=>{
  const group:Awaited<ReturnType<typeof fixture>>[]=[];
  for(let n=0;n<21;n++){
    const f=await fixture();await locked(f.context.portfolioId,()=>f.journal.prepare(f.current.input));
    await locked(f.context.portfolioId,()=>f.journal.unknown(f.current.input.executionKey));group.push(f);
  }
  const owners:Awaited<ReturnType<typeof fixture>>[]=[];
  for(let n=0;n<20;n++){
    const f=await fixture();await query('insert into yield_exit_requests(request_key,chain_id,portfolio_id,account,requested_by) values($1,97,$2,$3,$4)',[hash(),f.context.portfolioId,f.account,f.owner]);owners.push(f);
  }
  const risk=await fixture(),p=risk.read.positions[0];assert.ok(p);Object.assign(p,{receipt:1n,observedUnits:1n,trackedUnits:1n});await persistYieldRead(risk.context,risk.read);
  const ids=[...group,...owners,risk].map(f=>f.context.portfolioId),seen=new Set<number>();
  async function scoped<T extends QueryResultRow=QueryResultRow>(sql:string,params:readonly unknown[]=[]){return query<T>(sql.replace('from smart_accounts sa','from (select * from smart_accounts where portfolio_id=any($2::bigint[])) sa'),[...params,ids]);}
  const {runYieldRound}=await import('../src/yield-service.js'),previous=process.env.CHAIN_ID;process.env.CHAIN_ID='97';
  try{
    for(let n=0;n<3;n++){
      const round:number[]=[];
      if(n===2){
        const {execFileSync}=await import('node:child_process');
        const code=`import {query,closePool} from './src/db.ts';import {runYieldRound} from './src/yield-service.ts';import {yieldFixture} from './test/fixtures/yield.ts';
          const ids=JSON.parse(process.env.ROTATION_IDS),seen=[];
          const scoped=(sql,params=[])=>query(sql.replace('from smart_accounts sa','from (select * from smart_accounts where portfolio_id=any($2::bigint[])) sa'),[...params,ids]);
          try{await runYieldRound({dryRun:false,limit:20},{query:scoped,profile:()=>yieldFixture(['venus']).profile,lock:async id=>{seen.push(id);return null;}});console.log(JSON.stringify(seen));}finally{await closePool();}`;
        const output=execFileSync(process.execPath,['--no-env-file','--eval',code],{encoding:'utf8',timeout:10000,env:{...process.env,ROTATION_IDS:JSON.stringify(ids)}});
        const result:unknown=JSON.parse(output.trim().split('\n').at(-1)??'null');assert.ok(Array.isArray(result));
        for(const id of result){assert.equal(typeof id,'number');round.push(id);seen.add(id);}
      }else await runYieldRound({dryRun:false,limit:20},{query:scoped,profile:()=>risk.profile,lock:async id=>{seen.add(id);round.push(id);if(n===1)throw new AppError(503,'YIELD_UNAVAILABLE','safe');return null;}});
      assert.ok(round.includes(risk.context.portfolioId),'risk cannot starve behind owner exits');
    }
    assert.equal(seen.size,ids.length,'unknowns rotate despite no new observation or acquired lock');
  }finally{if(previous===undefined)delete process.env.CHAIN_ID;else process.env.CHAIN_ID=previous;}
});

test('#113 cursor DB failure aborts the round before any account attempt and a retry can proceed',async()=>{
  const f=await fixture(),{runYieldRound}=await import('../src/yield-service.js');
  const {default:pg}=await import('pg');
  const blocker=new pg.Client({connectionString:process.env.DATABASE_URL});await blocker.connect();
  const previous=process.env.CHAIN_ID;process.env.CHAIN_ID='97';let attempts=0;
  async function scoped<T extends QueryResultRow=QueryResultRow>(sql:string,params:readonly unknown[]=[]){
    return query<T>(sql.replace('from smart_accounts sa','from (select * from smart_accounts where portfolio_id=$2) sa'),[...params,f.context.portfolioId]);
  }
  const overrides={query:scoped,profile:()=>f.profile,lock:async()=>{attempts++;return null;},transaction:async<T>(fn:Parameters<typeof withTransaction<T>>[0])=>withTransaction(async db=>{
    await db.query("set local statement_timeout='25ms'");return fn(db);
  })};
  try{
    await blocker.query('begin');await blocker.query('lock table yield_runtime_state in access exclusive mode');
    await assert.rejects(runYieldRound({dryRun:false,limit:1},overrides),/^Error: yield state unavailable$/);
    assert.equal(attempts,0);await blocker.query('rollback');
    await runYieldRound({dryRun:false,limit:1},overrides);assert.equal(attempts,1);
  }finally{await blocker.query('rollback');await blocker.end();if(previous===undefined)delete process.env.CHAIN_ID;else process.env.CHAIN_ID=previous;}
});
