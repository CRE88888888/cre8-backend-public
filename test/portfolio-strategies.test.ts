import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, afterEach, test } from 'node:test';
import type { Address, Hex } from 'viem';
import { closePool, getPool, migrate, query, withTransaction } from '../src/db.js';
import { createPortfolioStrategyService } from '../src/portfolio-strategies.js';
import type { PortfolioStrategyDeps } from '../src/portfolio-strategies.js';
import { createStrategy, getStrategy, publishVersion, requireTypedVersion, validateAllocation } from '../src/strategies.js';
import { assertVersionOnchain, readAccountCash } from '../src/chain.js';
import { enrollPortfolio, requireOwnedPortfolio, strategyMinimumDeposit } from '../src/portfolios.js';
import { readFaucetFundingEvidence } from '../src/faucet.js';
import { canonicalConfigHash, usdtRaw } from '../src/strategy-execution.js';
import { AppError } from '../src/errors.js';
import { TESTNET_97 } from '../src/testnet-profile.js';
import { strategyRpc, TEST_AMOUNT, OTHER_HASH } from './fixtures/strategy-rpc.js';
import { claimDuePortfolios } from '../src/scheduler.js';

const address = (): Address => `0x${randomBytes(20).toString('hex')}`;
const txHash = (): Hex => `0x${randomBytes(32).toString('hex')}`;
const denied = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
const fixtureClaimIds: string[] = [];
const activeAt = new Date('2026-11-15T00:00:00Z');
const allocation = validateAllocation({ assets: [{ address: TESTNET_97.assets.AAPLB.token, weightBps:5000 },{address:TESTNET_97.contracts.usdt,weightBps:5000}] },97);

async function fixture(kind: 'hold' | 'stack' = 'stack') {
  await migrate();
  const owner=address(); const account=address();
  const strategy=(await query<{id:string}>("insert into strategies(provider,name) values($1,'be82-isolated') returning id",[owner])).rows[0];
  assert.ok(strategy);
  const strategyId=Number(strategy.id);
  const onchainId=strategyId+90_000_000;
  await query('update strategies set onchain_id=$2 where id=$1',[strategyId,onchainId]);
  const configHash=canonicalConfigHash({chainId:97,execution:{kind},allocation,schedule:{kind:'funding'},activeAt});
  await query(`insert into strategy_versions(strategy_id,version,allocation,schedule,active_at,execution_schema_version,execution,execution_chain_id,config_hash)
    values($1,1,$2::jsonb,'{"kind":"funding"}',$3,1,$4::jsonb,97,$5)`,[strategyId,JSON.stringify(allocation),activeAt,JSON.stringify({kind}),configHash]);
  const p=(await query<{id:string}>("insert into portfolios(user_id,strategy_id,version,schedule_state) values($1,$2,1,'paused') returning id",[owner,strategyId])).rows[0];
  assert.ok(p);const id=Number(p.id);
  await query("insert into smart_accounts(portfolio_id,chain_id,address,owner,account_type) values($1,97,$2,$3,'KERNEL')",[id,account,owner]);
  const hash=txHash();
  const claim=(await query<{id:string}>("insert into faucet_claims(chain_id,owner,account,amount_wei,tx_hash,state,created_at) values(97,$1,$2,$3,$4,'unknown','2000-01-01T00:00:00Z') returning id",[owner,account,TEST_AMOUNT.toString(),hash])).rows[0];
  assert.ok(claim); fixtureClaimIds.push(claim.id);
  const rpc=strategyRpc(allocation,configHash,activeAt,hash);
  rpc.state.to=account;rpc.state.strategyId=BigInt(onchainId);
  const deps: Partial<PortfolioStrategyDeps>={chainId:()=>97,
    owned:(portfolioId,wallet)=>requireOwnedPortfolio(portfolioId,wallet,{chainId:97}),
    version:(sid,v,chainSid,acct,options)=>requireTypedVersion(sid,v,chainSid,acct,{...options,chainId:97,
      assertOnchain:(onchainId,index,expected,account,readOptions)=>assertVersionOnchain(onchainId,index,expected,account,{...readOptions,client:rpc.client,registry:TESTNET_97.contracts.registry})}),
    evidence:(c)=>readFaucetFundingEvidence(c,rpc.client),cash:(chainId,account)=>readAccountCash(chainId,account,rpc.client)};
  const service=createPortfolioStrategyService(deps);
  return {owner,account,strategyId,onchainId,id,hash,claimId:claim.id,rpc,deps,service,source:{source:{kind:'faucet_claim',claimId:claim.id}}};
}
async function bucket(id:number,key:'stack_prefund_raw'|'unallocated_hold_raw'){
  const row=(await query<{amount:string}>(`select ${key}::text as amount from strategy_cash_balances where chain_id=97 and portfolio_id=$1`,[id])).rows[0];
  return row?.amount??'0';
}
const future=()=>new Date(Date.now()+86400_000).toISOString();

test('#82 DB typed publish round-trip/default/retry is immutable; internal legacy rows retain schema 0 and null hash',async()=>{
  await migrate();
  const owner=address();
  const strategy=await createStrategy({name:'be82-typed-roundtrip'},owner);
  const input={execution:{kind:'hold'},allocation:{assets:[{address:'0x55d398326f99059ff775485246999027b3197955',weightBps:10000}]}};
  const versions=await Promise.all(Array.from({length:3},()=>publishVersion(strategy.id,input,owner)));
  assert.equal(new Set(versions.map(v=>v.version)).size,1);
  const first=versions[0];assert.ok(first);
  assert.deepEqual(first.execution,{kind:'hold'});assert.equal(first.executionSchemaVersion,1);assert.equal(first.executionChainId,56);
  assert.deepEqual(first.schedule,{kind:'funding'});assert.ok(first.configHash);
  assert.deepEqual((await getStrategy(strategy.id)).versions,[first]);
  await assert.rejects(query("update strategy_versions set schedule='{}' where strategy_id=$1",[strategy.id]),(error:unknown)=>typeof error==='object'&&error!==null&&Reflect.get(error,'code')==='23514');
  await assert.rejects(publishVersion(strategy.id,input,address()),denied('FORBIDDEN'));
  await assert.rejects(publishVersion(strategy.id,{...input,chainId:97},owner),denied('CHAIN_MISMATCH'));
  await assert.rejects(publishVersion(strategy.id,{...input,execution:{kind:'stack'}},owner),denied('STACK_CASH_ONLY'));
  await assert.rejects(publishVersion(strategy.id,{...input,allocation:{...input.allocation,play:'dips'}},owner),denied('INVALID_ALLOCATION'));
  await assert.rejects(publishVersion(strategy.id,{...input,activeAt:'2026-11-15T00:00:00.001Z'},owner),denied('INVALID_ACTIVE_AT'));
  const legacy=await createStrategy({name:'be82-legacy'},owner);
  const old=await publishVersion(legacy.id,{allocation:input.allocation,schedule:{kind:'cron',cron:'0 0 * * *'}},owner);
  assert.deepEqual(old.execution,{kind:'target_weight'});assert.equal(old.executionSchemaVersion,0);assert.equal(old.configHash,null);assert.equal(old.executionChainId,null);
  assert.deepEqual(old.schedule,{kind:'cron',cron:'0 0 * * *'});
  await query('update strategies set onchain_id=$2 where id=$1',[strategy.id,strategy.id+90_000_000]);
  await assert.rejects(publishVersion(strategy.id,input,owner),denied('VERSION_UNAVAILABLE'));
  assert.equal((await getStrategy(strategy.id)).versions.length,1,'a failed mirror does not create a new DB version on retry');
});

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
    assert.equal(await bucket(f.id,kind==='hold'?'unallocated_hold_raw':'stack_prefund_raw'),TEST_AMOUNT.toString());
    const rows=await query('select id from strategy_funding_lots where portfolio_id=$1',[f.id]);assert.equal(rows.rows.length,1);
    await assert.rejects(f.service.funding(f.id,address(),f.source),denied('FORBIDDEN'));
    assert.equal(await strategyMinimumDeposit(f.strategyId),usdtRaw('100').toString());
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
  assert.equal(await bucket(f.id,'unallocated_hold_raw'),TEST_AMOUNT.toString());
});

test('#82 DB reorg and moved log index freeze original lot without releasing funds or resurrecting it',async()=>{
  for(const scenario of ['canonical-block','moved-index']){
    const f=await fixture('hold');await f.service.funding(f.id,f.owner,f.source);
    if(scenario==='canonical-block')f.rpc.state.blockHash=OTHER_HASH;else f.rpc.state.logIndex++;
    await assert.rejects(f.service.funding(f.id,f.owner,f.source),denied('FUNDING_REORGED'));
    const rows=(await query<{state:string}>('select state from strategy_funding_lots where portfolio_id=$1',[f.id])).rows;
    assert.deepEqual(rows,[{state:'reorged'}]);assert.equal(await bucket(f.id,'unallocated_hold_raw'),TEST_AMOUNT.toString());
    await assert.rejects(f.service.executionState(f.id,f.owner,{enabled:true}),denied('FUNDING_REORGED'));
  }
});

test('#82 DB individual stack amounts, defaults, future/DST anchors, replay and revision CAS are isolated per follower',async()=>{
  const f=await fixture();
  const startAt=future();const input={expectedRevision:'0',enabled:true,startAt};
  const first=await f.service.instruct(f.id,f.owner,input);
  assert.equal(first.revision,'1');assert.equal(first.amountUsdt,'100');assert.equal(first.periodSeconds,604800);assert.equal(first.nextSlotIndex,'0');assert.equal(first.nextSlotAt,startAt);
  assert.deepEqual(await createPortfolioStrategyService(f.deps).instruct(f.id,f.owner,input),first);
  assert.equal((await f.service.read(f.id,f.owner)).instructions.length,1);
  await assert.rejects(f.service.instruct(f.id,address(),input),denied('FORBIDDEN'));
  await assert.rejects(f.service.instruct(f.id,f.owner,{...input,amountUsdt:'101'}),denied('REVISION_CONFLICT'));
  await f.service.instructionState(f.id,f.owner,{revision:'1',state:'paused'});
  await assert.rejects(f.service.instructionState(f.id,f.owner,{revision:'1',state:'active'}),denied('INVALID_INSTRUCTION_STATE'));
  const second=await f.service.instruct(f.id,f.owner,{...input,expectedRevision:'1',amountUsdt:'101',periodSeconds:86400});
  assert.equal(second.revision,'2');assert.equal(second.amountUsdt,'101');
  assert.deepEqual((await f.service.read(f.id,f.owner)).instructions.map(i=>i.state),['active','superseded']);
  await f.service.instructionState(f.id,f.owner,{revision:'2',state:'stopped'});
  await assert.rejects(f.service.instruct(f.id,f.owner,{...input,expectedRevision:'2',startAt:new Date(Date.now()-1000).toISOString()}),denied('START_NOT_FUTURE'));
  // Fixed UTC seconds preserve the revision anchor across the US spring DST transition.
  const clock=new Date('2027-03-12T00:00:00Z');
  const dstService=createPortfolioStrategyService({...f.deps,now:()=>clock});
  const dst=await dstService.instruct(f.id,f.owner,{expectedRevision:'2',enabled:false,startAt:'2027-03-13T09:00:00-05:00',periodSeconds:86400,endAt:'2027-03-16T14:00:00Z'});
  await query('update stack_instructions set next_slot_index=1 where chain_id=97 and portfolio_id=$1 and revision=$2',[f.id,dst.revision]);
  assert.equal((await f.service.read(f.id,f.owner)).instructions[0]?.nextSlotAt,'2027-03-14T14:00:00.000Z');
  const other=await fixture();
  const own=await other.service.instruct(other.id,other.owner,{...input,amountUsdt:'200'});assert.equal(own.amountUsdt,'200');assert.equal(own.revision,'1');
});

test('#82 DB unknown work prevents new revisions; pause/stop works during RPC outage and preserves original attempt',async()=>{
  const f=await fixture();const input={expectedRevision:'0',enabled:true,startAt:future()};
  await f.service.instruct(f.id,f.owner,input);
  const op=(await query<{id:string}>("insert into operations(portfolio_id,type,state,idempotency_key,user_op_hash) values($1,'withdraw','submitted',$2,$3) returning id",[f.id,txHash(),f.hash])).rows[0];assert.ok(op);
  await assert.rejects(f.service.instruct(f.id,f.owner,{...input,expectedRevision:'1'}),denied('PREVIOUS_INFLIGHT'));
  f.rpc.state.fail='*';
  const stopped=await f.service.instructionState(f.id,f.owner,{revision:'1',state:'stopped'});assert.equal(stopped.state,'stopped');
  assert.deepEqual((await query('select state,user_op_hash from operations where id=$1',[op.id])).rows,[{state:'submitted',user_op_hash:f.hash}]);
});

test('#82 DB hold pause is immediate during RPC outage and cannot turn a stack version into hold',async()=>{
  const f=await fixture('hold');f.rpc.state.fail='*';
  assert.deepEqual(await f.service.executionState(f.id,f.owner,{enabled:false}),{portfolioId:f.id,enabled:false});
  await assert.rejects(f.service.executionState(f.id,f.owner,{enabled:true}),denied('VERSION_CHAIN_UNAVAILABLE'));
  const stack=await fixture();await assert.rejects(stack.service.executionState(stack.id,stack.owner,{enabled:true}),denied('NOT_HOLD'));
  await assert.rejects(f.service.instruct(f.id,f.owner,{expectedRevision:'0',enabled:true,startAt:future()}),denied('VERSION_CHAIN_UNAVAILABLE'));
});

test('#82 DB cash row lock timeout rolls back the whole source reservation',async()=>{
  const f=await fixture('hold');await f.service.funding(f.id,f.owner,f.source);
  const blocker=await getPool().connect();
  try{
    await blocker.query('begin');await blocker.query('select * from strategy_cash_balances where portfolio_id=$1 for update',[f.id]);
    await assert.rejects(f.service.funding(f.id,f.owner,f.source),denied('EXECUTION_STORAGE_UNAVAILABLE'));
  }finally{await blocker.query('rollback');blocker.release();}
  assert.equal(await bucket(f.id,'unallocated_hold_raw'),TEST_AMOUNT.toString());
});

test('#82 DB old scheduler refuses funding schedules before reading holdings or executing a drift plan',async()=>{
  const f=await fixture('hold');
  await withTransaction(async client=>{
    await client.query("update portfolios set schedule_state='active',next_run_at=null where id=$1",[f.id]);
    const due=await claimDuePortfolios(100000,new Date(),{chainId:97,advance:false,withTransaction:async run=>run(client)});
    const claimed=due.find(row=>row.portfolioId===f.id);assert.ok(claimed);assert.ok(claimed.unsupportedReason);
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
  assert.equal(await bucket(f.id, 'unallocated_hold_raw'), TEST_AMOUNT.toString());
});

test('#82 DB typed publish admits the relayer before storing a version and safely retries a busy signer', async () => {
  const owner = address(); const strategy = await createStrategy({ name: 'be82-publish-admission' }, owner);
  await query('update strategies set onchain_id=$2 where id=$1', [strategy.id, strategy.id + 90_000_000]);
  const input = { execution: { kind: 'hold' }, allocation: { assets: [{ address: '0x55d398326f99059ff775485246999027b3197955', weightBps: 10000 }] } };
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
});

test('#82 DB new personal HTTP endpoints retain amounts, source and revision fields through a full round-trip', async () => {
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
    const input = { expectedRevision: '0', amountUsdt: '100.000000000000000001', enabled: true, startAt: future(), periodSeconds: 86400 };
    const created = await post('/stack-instructions', input); assert.equal(created.status, 200);
    const instruction: unknown = await created.json(); assert.ok(instruction && typeof instruction === 'object');
    assert.equal(Reflect.get(instruction, 'amountRaw'), usdtRaw(input.amountUsdt).toString());
    const read = await fetch(base + '/execution'); assert.equal(read.status, 200);
    const saved: unknown = await read.json(); assert.ok(saved && typeof saved === 'object');
    assert.deepEqual(Reflect.get(saved, 'instructions'), [instruction]);
    assert.equal((await post('/stack-instruction-state', { revision: '1', state: 'stopped' })).status, 200);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
