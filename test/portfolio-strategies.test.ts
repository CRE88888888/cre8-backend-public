import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, afterEach, test } from 'node:test';
import type { Address, Hex } from 'viem';
import { closePool, getPool, migrate, query, withTransaction } from '../src/db.js';
import { createPortfolioStrategyService } from '../src/portfolio-strategies.js';
import type { PortfolioStrategyDeps } from '../src/portfolio-strategies.js';
import { createStrategy, getStrategy, publishVersion, requireTypedVersion, validateAllocation, previewContribution } from '../src/strategies.js';
import { assertVersionOnchain, readAccountCash } from '../src/chain.js';
import { enrollPortfolio, requireOwnedPortfolio, strategyMinimumDeposit } from '../src/portfolios.js';
import { readFaucetFundingEvidence } from '../src/faucet.js';
import { canonicalConfigHash, usdtRaw } from '../src/strategy-execution.js';
import type { AssetExecution, AssetSetting } from '../src/strategy-execution.js';
import { AppError } from '../src/errors.js';
import { TESTNET_97 } from '../src/testnet-profile.js';
import { strategyRpc, TEST_AMOUNT, OTHER_HASH } from './fixtures/strategy-rpc.js';
import { claimDuePortfolios } from '../src/scheduler.js';
import { previewContributionAsync } from '../src/contribution-preview.js';

const address = (): Address => `0x${randomBytes(20).toString('hex')}`;
const txHash = (): Hex => `0x${randomBytes(32).toString('hex')}`;
const denied = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
const fixtureClaimIds: string[] = [];
const activeAt = new Date('2026-11-15T00:00:00Z');
const allocation = validateAllocation({ assets: [{ address: TESTNET_97.assets.AAPLB.token, weightBps:5000 },{address:TESTNET_97.contracts.usdt,weightBps:5000}] },97);

function assetConfig(kind:'hold'|'stack',basket=allocation,chainId=97):AssetExecution {
  const numeraire=chainId===97?TESTNET_97.contracts.usdt:'0x55d398326f99059ff775485246999027b3197955';
  return {kind:'per_asset',numeraire,rebalance:'none',assets:basket.assets.map<AssetSetting>(({address,weightBps})=>address===numeraire
    ? {asset:address,weightBps,yield:null} : {asset:address,weightBps,yield:null,execution:kind==='hold'?{kind:'hold'}:
      {kind:'stack',every:'daily',weekday:null,timeUtc:'14:00',slices:12}}).sort((a,b)=>a.asset.localeCompare(b.asset))};
}
async function fixture(kind: 'hold' | 'stack' = 'stack', cashWeight=5000, amount=TEST_AMOUNT, configured?:AssetExecution) {
  await migrate();
  const allocation=validateAllocation({assets:configured?configured.assets.map(a=>({address:a.asset,weightBps:a.weightBps})):[{address:TESTNET_97.assets.AAPLB.token,weightBps:10000-cashWeight},{address:TESTNET_97.contracts.usdt,weightBps:cashWeight}]},97);
  const owner=address(); const account=address();
  const strategy=(await query<{id:string}>("insert into strategies(provider,name) values($1,'be82-isolated') returning id",[owner])).rows[0];
  assert.ok(strategy);
  const strategyId=Number(strategy.id);
  const onchainId=strategyId+90_000_000;
  await query('update strategies set onchain_id=$2 where id=$1',[strategyId,onchainId]);
  const execution=configured??assetConfig(kind,allocation);
  const configHash=canonicalConfigHash({chainId:97,execution,allocation,schedule:{kind:'funding'},activeAt});
  await query(`insert into strategy_versions(strategy_id,version,allocation,schedule,active_at,execution_schema_version,execution,execution_chain_id,config_hash)
    values($1,1,$2::jsonb,'{"kind":"funding"}',$3,2,$4::jsonb,97,$5)`,[strategyId,JSON.stringify(allocation),activeAt,JSON.stringify(execution),configHash]);
  const p=(await query<{id:string}>("insert into portfolios(user_id,strategy_id,version,schedule_state) values($1,$2,1,'paused') returning id",[owner,strategyId])).rows[0];
  assert.ok(p);const id=Number(p.id);
  await query("insert into smart_accounts(portfolio_id,chain_id,address,owner,account_type) values($1,97,$2,$3,'KERNEL')",[id,account,owner]);
  const hash=txHash();
  const claim=(await query<{id:string}>("insert into faucet_claims(chain_id,owner,account,amount_wei,tx_hash,state,created_at) values(97,$1,$2,$3,$4,'unknown','2000-01-01T00:00:00Z') returning id",[owner,account,amount.toString(),hash])).rows[0];
  assert.ok(claim); fixtureClaimIds.push(claim.id);
  const rpc=strategyRpc(allocation,configHash,activeAt,hash);
  rpc.state.to=account;rpc.state.strategyId=BigInt(onchainId);rpc.state.amount=amount;rpc.state.cashRaw=amount;
  const deps: Partial<PortfolioStrategyDeps>={chainId:()=>97,feeReserve:async()=>27n*10n**16n,
    owned:(portfolioId,wallet)=>requireOwnedPortfolio(portfolioId,wallet,{chainId:97}),
    version:(sid,v,chainSid,acct,options)=>requireTypedVersion(sid,v,chainSid,acct,{...options,chainId:97,
      assertOnchain:(onchainId,index,expected,account,readOptions)=>assertVersionOnchain(onchainId,index,expected,account,{...readOptions,client:rpc.client,registry:TESTNET_97.contracts.registry})}),
    evidence:(c)=>readFaucetFundingEvidence(c,rpc.client),cash:(chainId,account)=>readAccountCash(chainId,account,rpc.client)};
  const service=createPortfolioStrategyService(deps);
  let nextDay=2;
  async function secondClaim(nextAmount=amount) {
    const hash=txHash();
    const createdAt=`2000-01-${String(nextDay++).padStart(2,'0')}T00:00:00Z`;
    const row=(await query<{id:string}>("insert into faucet_claims(chain_id,owner,account,amount_wei,tx_hash,state,created_at) values(97,$1,$2,$3,$4,'unknown',$5) returning id",[owner,account,nextAmount.toString(),hash,createdAt])).rows[0];
    assert.ok(row);fixtureClaimIds.push(row.id);
    rpc.state.txHash=hash;rpc.state.amount=nextAmount;rpc.state.cashRaw+=nextAmount;
    return {source:{kind:'faucet_claim',claimId:row.id}};
  }
  return {owner,account,strategyId,onchainId,id,hash,claimId:claim.id,rpc,deps,service,execution,allocation,secondClaim,source:{source:{kind:'faucet_claim',claimId:claim.id}}};
}
async function bucket(id:number,key:'stack_prefund_raw'|'unallocated_hold_raw'){
  const row=(await query<{amount:string}>(`select ${key}::text as amount from strategy_cash_balances where chain_id=97 and portfolio_id=$1`,[id])).rows[0];
  return row?.amount??'0';
}
async function onTestnet<T>(fn:()=>Promise<T>):Promise<T>{
  const previous=process.env.CHAIN_ID;process.env.CHAIN_ID='97';
  try{return await fn();}finally{if(previous===undefined)delete process.env.CHAIN_ID;else process.env.CHAIN_ID=previous;}
}
const future=()=>new Date(Date.now()+86400_000).toISOString();

test('#118 preview and persisted contribution share effective slices, receipt time, minimum and conservative fee bound',async()=>{
  const at=new Date('2026-11-16T13:59:00Z'),cash=TESTNET_97.contracts.usdt,asset=TESTNET_97.assets.AAPLB.token;
  for(const [amount,slices,cashWeight] of [[100n,12,0],[3650n,365,0],[50n,12,5000],[1000n,12,9900],[10_000_000n,365,0]] as const){
    const basket=validateAllocation({assets:[{address:asset,weightBps:10000-cashWeight},{address:cash,weightBps:cashWeight}]},97);
    const execution=assetConfig('stack',basket);
    for(const a of execution.assets)if(a.execution?.kind==='stack')a.execution.slices=slices;
    const raw=usdtRaw(amount.toString()),f=await fixture('stack',cashWeight,raw,execution);
    f.rpc.state.now=BigInt(+at/1000);
    const preview=previewContribution({chainId:97,execution,amountRaw:raw.toString()},at);
    assert.deepEqual(await previewContributionAsync({chainId:97,execution,amountRaw:raw.toString()},at),preview);
    const lot=await f.service.funding(f.id,f.owner,f.source);
    assert.deepEqual(lot.effectiveSlices,preview.effectiveSlices);assert.equal(lot.confirmedAt,at.toISOString());
    const stored=(await query<{effective_slices:Record<string,number>;minimum:string}>('select effective_slices,minimum_contribution_raw::text as minimum from strategy_funding_lots where id=$1',[lot.id])).rows[0];assert.ok(stored);
    assert.deepEqual(stored.effective_slices,preview.effectiveSlices);assert.equal(stored.minimum,preview.minimumRaw);
    assert.equal(await strategyMinimumDeposit(f.strategyId),preview.minimumRaw);
    assert.equal(preview.slots[0]?.at,'2026-11-16T14:00:00.000Z');
  }
});
test('#118 contribution fee bound fails closed on RPC errors or unsupported reserve without saving a lot',async()=>{
  for(const reserve of [-1n,usdtRaw('0.30')+1n,null]){
    const f=await fixture('hold');
    const service=createPortfolioStrategyService({...f.deps,feeReserve:async()=>{if(reserve===null)throw new Error('private upstream URL');return reserve;}});
    await assert.rejects(service.funding(f.id,f.owner,f.source),(error:unknown)=>error instanceof AppError&&error.status===503&&!error.message.includes('private'));
    assert.equal((await query('select id from strategy_funding_lots where portfolio_id=$1',[f.id])).rows.length,0);
    assert.equal(await bucket(f.id,'unallocated_hold_raw'),'0');
  }
});

test('#123 preview ceiling does not cap real contribution admission',async()=>{
  const f=await fixture('stack',0,usdtRaw('10000001'));
  const lot=await f.service.funding(f.id,f.owner,f.source);
  assert.deepEqual(lot.effectiveSlices,{[TESTNET_97.assets.AAPLB.token]:12});
});

test('#82 DB typed publish round-trip/default/retry is immutable; internal legacy rows retain schema 0 and null hash',async()=>onTestnet(async()=>{
  await migrate();
  const owner=address();
  const strategy=await createStrategy({name:'be82-typed-roundtrip'},owner);
  const basket={assets:[{address:TESTNET_97.contracts.usdt,weightBps:10000}]};
  const input={execution:assetConfig('hold',basket,97),allocation:basket};
  const versions=await Promise.all(Array.from({length:3},()=>publishVersion(strategy.id,input,owner)));
  assert.equal(new Set(versions.map(v=>v.version)).size,1);
  const first=versions[0];assert.ok(first);
  assert.deepEqual(first.execution,input.execution);assert.equal(first.executionSchemaVersion,2);assert.equal(first.executionChainId,97);
  assert.deepEqual(first.schedule,{kind:'funding'});assert.ok(first.configHash);
  assert.deepEqual((await getStrategy(strategy.id)).versions,[first]);
  await assert.rejects(query("update strategy_versions set schedule='{}' where strategy_id=$1",[strategy.id]),(error:unknown)=>typeof error==='object'&&error!==null&&Reflect.get(error,'code')==='23514');
  await assert.rejects(publishVersion(strategy.id,input,address()),denied('FORBIDDEN'));
  await assert.rejects(publishVersion(strategy.id,{...input,chainId:56},owner),denied('CHAIN_MISMATCH'));
  await assert.rejects(publishVersion(strategy.id,{...input,execution:{kind:'stack'}},owner),denied('INVALID_EXECUTION'));
  await assert.rejects(publishVersion(strategy.id,{...input,allocation:{...input.allocation,play:'dips'}},owner),denied('INVALID_ALLOCATION'));
  await assert.rejects(publishVersion(strategy.id,{...input,activeAt:'2026-11-15T00:00:00.001Z'},owner),denied('INVALID_ACTIVE_AT'));
  const legacy=await createStrategy({name:'be82-legacy'},owner);
  const old=await publishVersion(legacy.id,{allocation:input.allocation,schedule:{kind:'cron',cron:'0 0 * * *'}},owner);
  assert.deepEqual(old.execution,{kind:'target_weight'});assert.equal(old.executionSchemaVersion,0);assert.equal(old.configHash,null);assert.equal(old.executionChainId,null);
  assert.deepEqual(old.schedule,{kind:'cron',cron:'0 0 * * *'});
  await query('update strategies set onchain_id=$2 where id=$1',[strategy.id,strategy.id+90_000_000]);
  await assert.rejects(publishVersion(strategy.id,input,owner),denied('VERSION_UNAVAILABLE'));
  assert.equal((await getStrategy(strategy.id)).versions.length,1,'a failed mirror does not create a new DB version on retry');
}));

test('#82 DB exact faucet source credits each hold/stack account once across restart and competing workers',async()=>{
  for(const kind of ['hold','stack'] as const){
    const f=await fixture(kind);
    const empty=await f.service.read(f.id,f.owner);
    assert.equal(empty.balances,null);assert.deepEqual(empty.lots,[]);
    const calls=await Promise.allSettled([f.service.funding(f.id,f.owner,f.source),createPortfolioStrategyService(f.deps).funding(f.id,f.owner,f.source)]);
    assert.equal(calls.filter(r=>r.status==='fulfilled').length,1);
    for(const result of calls)if(result.status==='rejected')assert.ok(result.reason instanceof AppError&&result.reason.code==='PORTFOLIO_BUSY');
    const replay=await createPortfolioStrategyService(f.deps).funding(f.id,f.owner,f.source);
    assert.equal(replay.replayed,true);assert.equal(replay.amountRaw,TEST_AMOUNT.toString());assert.equal(replay.version,1);
    assert.equal(await bucket(f.id,kind==='hold'?'unallocated_hold_raw':'stack_prefund_raw'),(TEST_AMOUNT/2n).toString());
    assert.equal((await query<{amount:string}>('select allocated_cash_raw::text as amount from strategy_cash_balances where portfolio_id=$1',[f.id])).rows[0]?.amount,(TEST_AMOUNT/2n).toString());
    const rows=await query('select id from strategy_funding_lots where portfolio_id=$1',[f.id]);assert.equal(rows.rows.length,1);
    await assert.rejects(f.service.funding(f.id,address(),f.source),denied('FORBIDDEN'));
    assert.equal(await strategyMinimumDeposit(f.strategyId),usdtRaw('50').toString());
  }
});

test('#82 DB unknown receipt or foreign claim cannot create lot/cash; one confirmed proof is sufficient to reconcile an unknown faucet attempt',async()=>{
  const f=await fixture();
  f.rpc.state.logs=false;
  await assert.rejects(f.service.funding(f.id,f.owner,f.source),denied('FUNDING_NOT_CONFIRMED'));
  assert.equal((await query('select * from strategy_cash_balances where portfolio_id=$1',[f.id])).rows.length,0);
  f.rpc.state.logs=true;f.rpc.state.fail='eth_getTransactionReceipt';
  await assert.rejects(f.service.funding(f.id,f.owner,f.source),denied('FUNDING_RPC_UNAVAILABLE'));
  f.rpc.state.fail='';
  await assert.rejects(f.service.funding(f.id,f.owner,{source:{kind:'faucet_claim',claimId:'9223372036854775807'}}),denied('FORBIDDEN'));
  assert.equal((await f.service.funding(f.id,f.owner,f.source)).amountRaw,TEST_AMOUNT.toString());
});

test('#82 DB rollback and lost commit acknowledgement never report success or double-credit the source',async()=>{
  const f=await fixture('hold');
  const rollback:typeof withTransaction=fn=>withTransaction(async client=>{const result=await fn(client);await client.query('select 1/0');return result;});
  await assert.rejects(createPortfolioStrategyService({...f.deps,transaction:rollback}).funding(f.id,f.owner,f.source),denied('EXECUTION_STORAGE_UNAVAILABLE'));
  assert.equal((await query('select id from strategy_funding_lots where portfolio_id=$1',[f.id])).rows.length,0);
  const unknown:typeof withTransaction=async fn=>{await withTransaction(fn);throw new Error('SECRET_COMMIT_ACK');};
  await assert.rejects(createPortfolioStrategyService({...f.deps,transaction:unknown}).funding(f.id,f.owner,f.source),denied('EXECUTION_STORAGE_UNAVAILABLE'));
  assert.equal((await f.service.funding(f.id,f.owner,f.source)).replayed,true);
  assert.equal(await bucket(f.id,'unallocated_hold_raw'),(TEST_AMOUNT/2n).toString());
});

test('#82 DB reorg and moved log index freeze original lot without releasing funds or resurrecting it',async()=>{
  for(const scenario of ['canonical-block','moved-index']){
    const f=await fixture('hold');await f.service.funding(f.id,f.owner,f.source);
    if(scenario==='canonical-block')f.rpc.state.blockHash=OTHER_HASH;else f.rpc.state.logIndex++;
    await assert.rejects(f.service.funding(f.id,f.owner,f.source),denied('FUNDING_REORGED'));
    const rows=(await query<{state:string}>('select state from strategy_funding_lots where portfolio_id=$1',[f.id])).rows;
    assert.deepEqual(rows,[{state:'reorged'}]);assert.equal(await bucket(f.id,'unallocated_hold_raw'),(TEST_AMOUNT/2n).toString());
    await assert.rejects(f.service.executionState(f.id,f.owner,{enabled:true}),denied('FUNDING_REORGED'));
  }
});

test('#83 DB creator stack calendars and effective slices are isolated per contribution; holder instructions are retired',async()=>{
  const f=await fixture();
  const clock=new Date('2027-03-13T14:00:00Z');
  f.rpc.state.now=BigInt(clock.getTime()/1000);
  const service=createPortfolioStrategyService({...f.deps,now:()=>clock});
  const first=await service.funding(f.id,f.owner,f.source);
  assert.equal(first.kind,'asset');
  const rows=(await query<{asset:string;budget_raw:string;effective_slices:number;first_slot_at:Date|null}>(
    'select asset,budget_raw::text,effective_slices,first_slot_at from strategy_lot_assets where lot_id=$1 order by asset',[first.id])).rows;
  assert.equal(rows.length,2);
  const stock=rows.find(r=>r.asset===TESTNET_97.assets.AAPLB.token);assert.ok(stock);
  assert.equal(stock.budget_raw,(TEST_AMOUNT/2n).toString());assert.equal(stock.effective_slices,12);
  assert.equal(stock.first_slot_at?.toISOString(),'2027-03-14T14:00:00.000Z','one-period UTC anchor stays 14:00 across DST and equality waits until tomorrow');
  assert.equal(rows.find(r=>r.asset===TESTNET_97.contracts.usdt)?.effective_slices,0);
  await assert.rejects(service.instruct(f.id,f.owner,{expectedRevision:'0',enabled:true,startAt:future(),amountUsdt:'101'}),denied('STACK_INSTRUCTIONS_RETIRED'));
  await assert.rejects(service.instructionState(f.id,f.owner,{revision:'1',state:'paused'}),denied('STACK_INSTRUCTIONS_RETIRED'));
  assert.equal((await query('select revision from stack_instructions where portfolio_id=$1',[f.id])).rows.length,0);
  const other=await fixture('stack',5000,TEST_AMOUNT*2n);
  const second=await other.service.funding(other.id,other.owner,other.source);
  assert.notEqual(second.id,first.id);
  const otherStock=(await query<{budget_raw:string;effective_slices:number}>('select budget_raw::text,effective_slices from strategy_lot_assets where lot_id=$1 and asset=$2',[second.id,TESTNET_97.assets.AAPLB.token])).rows[0];
  assert.equal(otherStock?.budget_raw,TEST_AMOUNT.toString());assert.equal(otherStock?.effective_slices,12);
  assert.deepEqual((await getStrategy(f.strategyId)).versions[0]?.execution,f.execution,'shortening changes contribution plan only, never signed creator N');
});

test('#83 DB unknown work rejects holder revisions; fund pause works during RPC outage and preserves original attempt',async()=>{
  const f=await fixture();
  const op=(await query<{id:string}>("insert into operations(portfolio_id,type,state,idempotency_key,user_op_hash) values($1,'withdraw','submitted',$2,$3) returning id",[f.id,txHash(),f.hash])).rows[0];assert.ok(op);
  await assert.rejects(f.service.instruct(f.id,f.owner,{expectedRevision:'0',enabled:true,startAt:future()}),denied('STACK_INSTRUCTIONS_RETIRED'));
  f.rpc.state.fail='*';
  assert.deepEqual(await f.service.executionState(f.id,f.owner,{enabled:false}),{portfolioId:f.id,enabled:false});
  assert.deepEqual((await query('select state,user_op_hash from operations where id=$1',[op.id])).rows,[{state:'submitted',user_op_hash:f.hash}]);
});

test('#83 DB both hold and creator-stack can pause immediately during RPC outage without changing version mode',async()=>{
  for(const kind of ['hold','stack'] as const){
    const f=await fixture(kind);f.rpc.state.fail='*';
    assert.deepEqual(await f.service.executionState(f.id,f.owner,{enabled:false}),{portfolioId:f.id,enabled:false});
    await assert.rejects(f.service.executionState(f.id,f.owner,{enabled:true}),denied('VERSION_CHAIN_UNAVAILABLE'));
    await assert.rejects(f.service.instruct(f.id,f.owner,{expectedRevision:'0',enabled:true,startAt:future()}),denied('STACK_INSTRUCTIONS_RETIRED'));
    assert.deepEqual((await getStrategy(f.strategyId)).versions[0]?.execution,f.execution);
    f.rpc.state.fail='';
    assert.deepEqual(await f.service.executionState(f.id,f.owner,{enabled:true}),{portfolioId:f.id,enabled:true});
  }
});

test('#82 DB cash row lock timeout rolls back the whole source reservation',{timeout:15000},async()=>{
  const f=await fixture('hold');await f.service.funding(f.id,f.owner,f.source);
  const blocker=await getPool().connect();
  try{
    await blocker.query('begin');await blocker.query('select * from strategy_cash_balances where portfolio_id=$1 for update',[f.id]);
    await assert.rejects(f.service.funding(f.id,f.owner,f.source),denied('EXECUTION_STORAGE_UNAVAILABLE'));
  }finally{await blocker.query('rollback');blocker.release();}
  assert.equal(await bucket(f.id,'unallocated_hold_raw'),(TEST_AMOUNT/2n).toString());
});

test('#83 DB scheduler recognizes typed funding schedules without converting them to legacy drift intervals',async()=>{
  const f=await fixture('hold');
  await withTransaction(async client=>{
    await client.query("update portfolios set schedule_state='active',next_run_at=null where id=$1",[f.id]);
    const due=await claimDuePortfolios(100000,new Date(),{chainId:97,advance:false,withTransaction:async run=>run(client)});
    const claimed=due.find(row=>row.portfolioId===f.id);assert.ok(claimed);assert.equal(claimed.unsupportedReason,null);
    assert.equal(claimed.executionKind,'per_asset');assert.equal(claimed.version,1);assert.equal(claimed.intervalSeconds,60);
    await client.query("update portfolios set schedule_state='paused' where id=$1",[f.id]);
  });
});

afterEach(async () => {
  // These RPC fixtures never broadcast. Do not leave unknown test hashes blocking the shared signer.
  const ids = fixtureClaimIds.splice(0);
  if (ids.length) await query("update faucet_claims set state='failed',updated_at=clock_timestamp() where id=any($1::bigint[]) and state in ('submitted','unknown')", [ids]);
});
after(async()=>{await closePool();});

test('#82 DB funding binds to receipt-time enrollment and activeAt, never a later pinned version', async () => {
  for (const scenario of ['version', 'before-active']) {
    const f = await fixture();
    f.rpc.state.latestBlockNumber = 131n;
    if (scenario === 'version') {
      await query(`insert into strategy_versions(strategy_id,version,allocation,schedule,active_at,execution_schema_version,execution,execution_chain_id,config_hash)
        select strategy_id,2,allocation,schedule,active_at,execution_schema_version,execution,execution_chain_id,config_hash from strategy_versions where strategy_id=$1 and version=1`, [f.strategyId]);
      await query('update portfolios set version=2 where id=$1', [f.id]);
      f.rpc.state.pinned = 2; f.rpc.state.version = 2; f.rpc.state.historicalPinned = 1;
    } else f.rpc.state.historicalNow--;
    await assert.rejects(f.service.funding(f.id, f.owner, f.source), denied(scenario === 'version' ? 'CHAIN_VERSION_MISMATCH' : 'VERSION_NOT_ACTIVE'));
    assert.equal((await query('select id from strategy_funding_lots where portfolio_id=$1', [f.id])).rows.length, 0);
    assert.equal((await query<{state:string}>('select state from faucet_claims where id=$1', [f.claimId])).rows[0]?.state, 'confirmed', 'known faucet outcome must not block relayer on an ineligible lot');
  }
});

test('#82 DB paused typed enrollment returns the original account and stays paused', async () => {
  const f = await fixture('hold');
  const portfolio = await enrollPortfolio(f.strategyId, f.owner, { chainId: 97,
    getAccountGasBalance: async () => 0n, getGasPriceWei: async () => 1n, minSessionGasWei: 1n });
  assert.equal(portfolio.id, f.id); assert.equal(portfolio.scheduleState, 'paused');
  assert.equal(portfolio.smartAccounts[0]?.address, f.account);
  assert.equal((await query('select id from portfolios where strategy_id=$1 and user_id=$2', [f.strategyId, f.owner])).rows.length, 1);
});

test('#82 DB unclassified transfers and cash deficits remain separate from product lots', async () => {
  const f = await fixture('hold');
  const before = await f.service.read(f.id, f.owner);
  assert.equal(before.cash.unclassifiedRaw, TEST_AMOUNT.toString()); assert.deepEqual(before.lots, []);
  await f.service.funding(f.id, f.owner, f.source);
  f.rpc.state.cashRaw += usdtRaw('50');
  const donated = await f.service.read(f.id, f.owner);
  assert.equal(donated.cash.unclassifiedRaw, usdtRaw('50').toString()); assert.equal(donated.lots.length, 1);
  assert.deepEqual(donated.lots[0]?.source, { kind: 'faucet_claim', claimId: f.claimId });
  f.rpc.state.cashRaw = TEST_AMOUNT - 1n;
  const deficit = await f.service.read(f.id, f.owner);
  assert.equal(deficit.cash.unclassifiedRaw, null); assert.equal(deficit.cash.deficitRaw, '1');
  f.rpc.state.fail = 'eth_call';
  await assert.rejects(f.service.read(f.id, f.owner), denied('VERSION_CHAIN_UNAVAILABLE'));
});

test('#82 DB verified unknown faucet source settles its original UTC day; failed settlement retries without double-credit', async () => {
  const f = await fixture('hold');
  await query("update faucet_claims set created_at=clock_timestamp()-interval '1 day' where id=$1", [f.claimId]);
  const service = createPortfolioStrategyService({ ...f.deps, settleClaim: async () => { throw new AppError(503, 'FAUCET_STORAGE_UNAVAILABLE', 'lost acknowledgement'); } });
  await assert.rejects(service.funding(f.id, f.owner, f.source), denied('FAUCET_STORAGE_UNAVAILABLE'));
  assert.equal(await bucket(f.id, 'unallocated_hold_raw'), '0');
  assert.equal((await f.service.funding(f.id, f.owner, f.source)).replayed, false);
  const claim = (await query<{ state: string; original_day: boolean }>("select state,utc_day=(current_timestamp at time zone 'UTC')::date-1 as original_day from faucet_claims where id=$1", [f.claimId])).rows[0];
  assert.deepEqual(claim, { state: 'confirmed', original_day: true });
  assert.equal((await query("select id from faucet_claims where id=$1 and state in ('submitted','unknown') and tx_hash is not null", [f.claimId])).rows.length, 0, 'this source no longer blocks the shared relayer');
  assert.equal(await bucket(f.id, 'unallocated_hold_raw'), (TEST_AMOUNT/2n).toString());
});

test('#82 DB typed publish admits the relayer before storing a version and safely retries a busy signer', async () => onTestnet(async()=>{
  const owner = address(); const strategy = await createStrategy({ name: 'be82-publish-admission' }, owner);
  await query('update strategies set onchain_id=$2 where id=$1', [strategy.id, strategy.id + 90_000_000]);
  const basket={assets:[{address:TESTNET_97.contracts.usdt,weightBps:10000}]};
  const input={execution:assetConfig('hold',basket,97),allocation:basket};
  let busy = true; let sends = 0;
  const deps = { isChainConfigured: () => true, validateChain: () => {},
    relayerLock: async <T,>(_chainId: number, run: (assertHeld: () => void) => Promise<T>) => { if (busy) throw new AppError(503, 'RELAYER_BUSY', 'busy'); return run(() => {}); },
    publishOnchain: async (_id: number, version: Parameters<typeof import('../src/chain.js').publishVersionOnchain>[1]) => {
      assert.ok(version.configHash); assert.equal(version.expectedVersion, 1);
      assert.equal((await query('select version from strategy_versions where strategy_id=$1', [strategy.id])).rows.length, 1, 'commit precedes any chain publication');
      if (version.allowPublish) sends++;
      return 1;
    } };
  await assert.rejects(publishVersion(strategy.id, input, owner, deps), denied('RELAYER_BUSY'));
  assert.equal((await getStrategy(strategy.id)).versions.length, 0);
  busy = false;
  const published = await publishVersion(strategy.id, input, owner, deps);
  assert.equal(published.version, 1);
  assert.equal((await publishVersion(strategy.id, input, owner, deps)).configHash, published.configHash);
  assert.equal(sends, 1);
}));

test('#83 DB HTTP retains per-asset lot plan and removes personal instruction endpoints', async () => {
  const { createServer } = await import('../src/server.js');
  const f = await fixture();
  const server = createServer({ portfolioStrategies: f.service, auth: { authenticate: async () => f.owner,
    issueNonce: () => { throw new Error('unexpected'); }, login: async () => { throw new Error('unexpected'); }, logout: async () => {} } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/portfolios/${f.id}`;
    const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const funded = await post('/funding-lots', f.source); assert.equal(funded.status, 200);
    const lot: unknown = await funded.json(); assert.ok(lot && typeof lot === 'object');
    assert.deepEqual(Reflect.get(lot, 'source'), f.source.source);
    assert.equal(Reflect.get(lot,'kind'),'asset');
    assert.ok(Reflect.get(lot,'effectiveSlices'));
    const input={expectedRevision:'0',amountUsdt:'100.000000000000000001',enabled:true,startAt:future(),periodSeconds:86400};
    assert.equal((await post('/stack-instructions',input)).status,404);
    assert.equal((await post('/stack-instruction-state',{revision:'1',state:'stopped'})).status,404);
    const read=await fetch(base+'/execution');assert.equal(read.status,200);
    const saved:unknown=await read.json();assert.ok(saved&&typeof saved==='object');
    assert.deepEqual(Reflect.get(saved,'execution'),f.execution);
    const lots:unknown=Reflect.get(saved,'lots');assert.ok(Array.isArray(lots));assert.equal(lots.length,1);
    assert.deepEqual(lots[0]?.effectiveSlices,Reflect.get(lot,'effectiveSlices'));
    assert.ok(Array.isArray(Reflect.get(saved,'lotAssets')));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('#83 DB 50 inclusive contribution shrinks creator N12 to five, 100 to ten, and one raw below minimum rolls back',async()=>{
  for(const [amount,slices] of [[usdtRaw('50'),5],[usdtRaw('100'),10],[usdtRaw('50')-1n,0]] as const){
    const f=await fixture('stack',0,amount);
    if(slices===0){
      await assert.rejects(f.service.funding(f.id,f.owner,f.source),(error:unknown)=>error instanceof AppError&&error.status===400);
      assert.equal((await query('select id from strategy_funding_lots where portfolio_id=$1',[f.id])).rows.length,0);
      assert.equal(await bucket(f.id,'stack_prefund_raw'),'0');
    }else{
      const lot=await f.service.funding(f.id,f.owner,f.source);
      assert.equal(lot.kind,'asset');
      const plan=(await query<{effective_slices:number;budget_raw:string}>('select effective_slices,budget_raw::text from strategy_lot_assets where lot_id=$1 and asset=$2',[lot.id,TESTNET_97.assets.AAPLB.token])).rows[0];
      assert.deepEqual(plan,{effective_slices:slices,budget_raw:amount.toString()});
      assert.equal(await bucket(f.id,'stack_prefund_raw'),amount.toString());
      assert.equal((await f.service.funding(f.id,f.owner,f.source)).id,lot.id);
    }
  }
});

test('#83 DB yield publication requires the exact enabled chain/asset/market and preserves retired signed selections',async()=>onTestnet(async()=>{
  const owner=address();const strategy=await createStrategy({name:'be83-yield-allowlist'},owner);
  const basket={assets:[{address:TESTNET_97.contracts.usdt,weightBps:10000}]};
  const execution=assetConfig('hold',basket,97);
  const market=`fixture_${randomBytes(8).toString('hex')}`;
  const selected={...execution,assets:execution.assets.map(a=>({...a,yield:{market}}))};
  const input={allocation:basket,execution:selected};
  await assert.rejects(publishVersion(strategy.id,input,owner),denied('YIELD_UNAVAILABLE'));
  await query('insert into strategy_asset_yield_markets(chain_id,asset,market_id,enabled) values(97,$1,$2,false)',[basket.assets[0]?.address,market]);
  await assert.rejects(publishVersion(strategy.id,input,owner),denied('YIELD_UNAVAILABLE'));
  await query('update strategy_asset_yield_markets set enabled=true where chain_id=97 and asset=$1 and market_id=$2',[basket.assets[0]?.address,market]);
  await assert.rejects(publishVersion(strategy.id,input,owner),denied('YIELD_UNAVAILABLE'),'0032 alone cannot admit a market');
  const receipt=address();
  await query(`insert into yield_markets(chain_id,market_id,platform_market_id,protocol,underlying,receipt,target,risk_source,underlying_decimals,receipt_decimals,is_simulated,simulated_apr_bps,state) values(97,$1,$2,'venus',$3,$4,$4,$5,18,8,true,500,'active')`,[txHash(),market,basket.assets[0]?.address,receipt,address()]);
  const published=await publishVersion(strategy.id,input,owner);assert.equal(published.executionSchemaVersion,2);assert.deepEqual(published.execution,selected);
  await query('update strategy_asset_yield_markets set enabled=false,updated_at=clock_timestamp() where chain_id=97 and asset=$1 and market_id=$2',[basket.assets[0]?.address,market]);
  assert.deepEqual((await getStrategy(strategy.id)).versions[0]?.execution,selected);
  await assert.rejects(publishVersion(strategy.id,{...input,activeAt:'2026-11-16T00:00:00Z'},owner),denied('YIELD_UNAVAILABLE'));
  assert.equal((await getStrategy(strategy.id)).versions.length,1);
}));

test('#83 DB two 50 contributions retain distinct sources and merge budgets at each creator timestamp',async()=>{
  const cash=TESTNET_97.contracts.usdt,a=TESTNET_97.assets.AAPLB.token,b=TESTNET_97.assets.AMZNB.token;
  const assets:AssetSetting[]=[
    {asset:a,weightBps:5000,execution:{kind:'stack',every:'daily',weekday:null,timeUtc:'09:00',slices:12},yield:null},
    {asset:b,weightBps:5000,execution:{kind:'stack',every:'daily',weekday:null,timeUtc:'10:00',slices:12},yield:null},
    {asset:cash,weightBps:0,yield:null}];
  const execution:AssetExecution={kind:'per_asset',numeraire:cash,rebalance:'none',assets:assets.sort((left,right)=>left.asset.localeCompare(right.asset))};
  const f=await fixture('stack',0,usdtRaw('50'),execution);
  const clock=new Date('2026-11-16T08:00:00Z');
  f.rpc.state.now=BigInt(clock.getTime()/1000);
  const service=createPortfolioStrategyService({...f.deps,now:()=>clock});
  const first=await service.funding(f.id,f.owner,f.source);
  assert.equal(first.fundingStatus,'scheduled','25 at each timestamp can fund two ten-USDT installments');
  assert.deepEqual(first.effectiveSlices,{[a]:2,[b]:2});
  assert.equal((await query('select id from strategy_jobs where portfolio_id=$1',[f.id])).rows.length,0,'funding never broadcasts or reserves a premature subminimum batch');
  const secondSource=await f.secondClaim();
  const second=await service.funding(f.id,f.owner,secondSource);
  assert.notEqual(second.id,first.id);assert.deepEqual(second.effectiveSlices,first.effectiveSlices);
  assert.equal(await bucket(f.id,'stack_prefund_raw'),usdtRaw('100').toString());
  const merged=(await query<{at:string;budget:string;count:number}>(`select to_char(a.first_slot_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as at,
      sum(a.budget_raw)::text as budget,count(*)::int as count from strategy_lot_assets a join strategy_funding_lots l on l.id=a.lot_id
      where l.portfolio_id=$1 and a.effective_slices>0 group by a.first_slot_at order by a.first_slot_at`,[f.id])).rows;
  assert.deepEqual(merged,[{at:'2026-11-16T09:00:00Z',budget:usdtRaw('50').toString(),count:2},{at:'2026-11-16T10:00:00Z',budget:usdtRaw('50').toString(),count:2}]);
  const replay=await service.funding(f.id,f.owner,secondSource);assert.equal(replay.id,second.id);assert.equal(replay.replayed,true);
  assert.equal(await bucket(f.id,'stack_prefund_raw'),usdtRaw('100').toString());
});

test('#83 DB per-asset read suggests the new inclusive minimum without resurrecting legacy five-dollar legs',async()=>{
  const cash=TESTNET_97.contracts.usdt;
  const assets:AssetSetting[]=[
    {asset:TESTNET_97.assets.AAPLB.token,weightBps:9900,execution:{kind:'hold'},yield:null},
    {asset:TESTNET_97.assets.AMZNB.token,weightBps:100,execution:{kind:'hold'},yield:null},
    {asset:cash,weightBps:0,yield:null}];
  const execution:AssetExecution={kind:'per_asset',numeraire:cash,rebalance:'none',assets:assets.sort((a,b)=>a.asset.localeCompare(b.asset))};
  const f=await fixture('hold',0,TEST_AMOUNT,execution);
  assert.equal((await f.service.read(f.id,f.owner)).defaultAmountUsdt,'50');
  assert.equal(await strategyMinimumDeposit(f.strategyId),usdtRaw('50').toString());
});

test('#83 DB pure cash funding completes allocation without fee policy reads or empty execution jobs',async()=>{
  const cash=TESTNET_97.contracts.usdt;
  const execution:AssetExecution={kind:'per_asset',numeraire:cash,rebalance:'none',assets:[{asset:cash,weightBps:10000,yield:null}]};
  const f=await fixture('hold',10000,TEST_AMOUNT,execution);
  const service=createPortfolioStrategyService({...f.deps,feeReserve:async()=>{throw new Error('a pure cash contribution must not query swap fee policy');}});
  const lot=await service.funding(f.id,f.owner,f.source);
  assert.equal(lot.kind,'asset');assert.deepEqual(lot.effectiveSlices,{});
  const read=await service.read(f.id,f.owner);
  assert.equal(read.balances?.allocated_cash_raw,TEST_AMOUNT.toString());
  assert.equal(read.balances?.unallocated_hold_raw,'0');assert.equal(read.balances?.stack_prefund_raw,'0');
  assert.equal(read.jobs.length,0);
  assert.equal((await query('select id from operations where portfolio_id=$1',[f.id])).rows.length,0);
  const plans=(await query<{state:string;effective_slices:number}>('select state,effective_slices from strategy_lot_assets where lot_id=$1',[lot.id])).rows;
  assert.deepEqual(plans,[{state:'completed',effective_slices:0}]);
});


test('#96 canonical receipt time controls the first creator slot despite delayed API processing',async()=>{
  const f=await fixture();f.rpc.state.now=BigInt(new Date('2026-11-15T00:00:00Z').getTime()/1000);
  const late=createPortfolioStrategyService({...f.deps,now:()=>new Date('2026-11-15T14:01:00Z')});
  const lot=await late.funding(f.id,f.owner,f.source);
  assert.equal(lot.confirmedAt,'2026-11-15T00:00:00.000Z');
  const rows=(await query<{first_slot_at:Date}>('select first_slot_at from strategy_lot_assets where lot_id=$1 and asset<>$2',[lot.id,TESTNET_97.contracts.usdt])).rows;
  assert.equal(rows[0]?.first_slot_at.toISOString(),'2026-11-15T14:00:00.000Z');
});

test('#96 99 percent cash admits a valid contribution and waits for same-slot accumulation',async()=>{
  const f=await fixture('hold',9900);
  const lot=await f.service.funding(f.id,f.owner,f.source);
  assert.equal(lot.amountRaw,TEST_AMOUNT.toString());assert.equal(await bucket(f.id,'unallocated_hold_raw'),(TEST_AMOUNT/100n).toString());
});
