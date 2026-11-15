import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { encodeFunctionData, parseAbi } from 'viem';
import type { Hex } from 'viem';
import { closePool, migrate, query, withTransaction, withPortfolioLock } from '../src/db.js';
import { persistYieldRead, syncYieldCatalog, createYieldJournal, restoreYieldOperation } from '../src/yield-store.js';
import type { JournalContext, SnapshotRow, SettlementRead } from '../src/yield-store.js';
import { WAD, UINT256_MAX } from '../src/yield-domain.js';
import type { YieldRead } from '../src/yield-domain.js';
import type { YieldPlan, YieldPrepare, YieldEvidence } from '../src/yield-port.js';
import { gasExecutionKey } from '../src/paymaster.js';
import type { Reservation } from '../src/paymaster.js';
import { yieldFixture, address, hash } from './fixtures/yield.js';
import { config, kernelCall, operation } from './fixtures/paymaster.js';

const paymasters:string[]=[];
after(async()=>{if(paymasters.length)await query('delete from paymaster_sponsorships where chain_id=97 and paymaster=any($1::text[])',[paymasters]);await closePool();});
async function fixture(read?:YieldRead,rebalance:'none'|'monthly'|'drift'='none'){
  await migrate();const f=yieldFixture(['venus']),r=read??f.read;
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
