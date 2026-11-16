import { createPublicClient, http, parseAbi } from 'viem';
import type { Address, Hex } from 'viem';
import type { PoolClient } from 'pg';
import type { PaymasterConfig } from './config.js';
import { query, withTransaction } from './db.js';
import { AppError } from './errors.js';
import { TESTNET_97 } from './testnet-profile.js';
import { readYieldState, writeYieldState } from './yield-runtime-state.js';

export type ExitFacts={chainId:number;account:Address;userOpHash:Hex;executionKey:string;nonce:string;validUntil:number;purpose:string};
export type ExpiredExitProof={facts:ExitFacts;blockNumber:string;blockHash:Hex;blockTimestamp:number;checkedAt:number;operator:string;reference:string};
type ReadConfig=Pick<PaymasterConfig,'chainId'|'rpcUrl'|'timeoutMs'>;
type Query=(sql:string,params?:readonly unknown[])=>Promise<{rows:unknown[]}>;
const fail=()=>new AppError(503,'PAYMASTER_EXIT_UNAVAILABLE','exit reconciliation evidence unavailable');
const record=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw fail();return value as Record<string,unknown>;};
const key=(hash:Hex)=>`auth-${hash.slice(2)}`;

/** Immutable release evidence is the counter: no process-local reset, state-transition
 * refund or upgrade backfill. Count on the release day; costs retain the site's charge day.
 * Outstanding exit signatures also reserve their potential unused cost until consumed.
 * The caller holds paymaster_account and the site's pinned UTC-day lock.
 */
export async function unusedExitUsage(db:Query,chainId:number,account:Address,day:string):Promise<{count:bigint;gas:bigint;wei:bigint}>{
  const row=record((await db(`
    with unused as (
      select s.user_op_hash,s.utc_day,s.gas_limit,s.max_cost_wei,
        bool_or(coalesce(r.value->>'utcDay',to_char(r.created_at at time zone 'UTC','YYYY-MM-DD'))=$3) as released_today
      from paymaster_sponsorships s join yield_runtime_state r on r.kind='release'
        and r.value->>'reason'='expired_finalized_nonce_unchanged'
        and r.value @> jsonb_build_object('evidence',jsonb_build_array(jsonb_build_object('facts',
          jsonb_build_object('chainId',s.chain_id,'account',s.sender,'userOpHash',s.user_op_hash,'purpose','exit'))))
      where s.chain_id=$1 and s.sender=$2
      group by s.user_op_hash
    ), exposure as (
      select user_op_hash,gas_limit,max_cost_wei from unused where utc_day=$3::date
      union
      select s.user_op_hash,s.gas_limit,s.max_cost_wei from paymaster_sponsorships s
        join yield_runtime_state a on a.name='auth-'||substr(s.user_op_hash,3) and a.kind='fact'
          and a.value->>'purpose'='exit'
      where s.chain_id=$1 and s.sender=$2 and s.utc_day=$3::date and s.state in ('reserved','submitted')
        and not exists(select 1 from gas_budget_reservations g where g.execution_key=a.value->>'executionKey'
          and g.chain_id=s.chain_id and g.account=s.sender and g.state in ('confirmed','failed'))
    )
    select (select count(*) filter(where released_today)::text from unused) as count,
      coalesce(sum(gas_limit),0)::text as gas,coalesce(sum(max_cost_wei),0)::text as wei from exposure`,[chainId,account,day])).rows[0]);
  const {count,gas,wei}=row;
  if(typeof count!=='string'||!/^\d+$/.test(count)||typeof gas!=='string'||!/^\d+$/.test(gas)||typeof wei!=='string'||!/^\d+$/.test(wei))throw fail();
  return{count:BigInt(count),gas:BigInt(gas),wei:BigInt(wei)};
}

async function factsFor(hash:Hex,db:Query=query):Promise<ExitFacts|null>{
  const value=await readYieldState(key(hash),db);if(value===null)return null;const v=record(value);
  if(v.chainId!==97||typeof v.account!=='string'||!/^0x[0-9a-f]{40}$/.test(v.account)||v.userOpHash!==hash||typeof v.executionKey!=='string'||!v.executionKey||
    typeof v.nonce!=='string'||!/^\d+$/.test(v.nonce)||BigInt(v.nonce)>=(1n<<256n)||typeof v.validUntil!=='number'||!Number.isSafeInteger(v.validUntil)||v.validUntil<=0||typeof v.purpose!=='string')throw fail();
  return {chainId:97,account:v.account as Address,userOpHash:hash,executionKey:v.executionKey,nonce:v.nonce,validUntil:v.validUntil,purpose:v.purpose};
}
export async function rememberExitFacts(facts:ExitFacts,db:Query=query):Promise<void>{
  if(facts.chainId!==97)return;
  const prior=await factsFor(facts.userOpHash,db);
  if(prior&&JSON.stringify(prior)!==JSON.stringify(facts))throw fail();
  await writeYieldState(key(facts.userOpHash),facts,db);
}
async function pending(chainId:number,account:Address,db:Query){
  const rows=(await db("select user_op_hash,valid_until from paymaster_sponsorships where chain_id=$1 and sender=$2 and state not in ('confirmed','failed','expired')",[chainId,account])).rows;
  const result:{facts:ExitFacts;until:Date}[]=[];
  for(const item of rows){
    const row=record(item);if(typeof row.user_op_hash!=='string'||!/^0x[0-9a-f]{64}$/.test(row.user_op_hash))throw fail();
    const facts=await factsFor(row.user_op_hash as Hex,db);
    // Legacy requests need manual binding of ALL outstanding original hashes. Do not guess
    // which nonce/execution an opaque sponsorship hash belongs to.
    if(!facts)return null;
    const until=row.valid_until;if(!(until instanceof Date)||until.getTime()!==facts.validUntil*1000||facts.chainId!==chainId||facts.account!==account)throw fail();
    result.push({facts,until});
  }
  return result;
}
export async function expiredExitProofs(c:ReadConfig,account:Address,db:Query=query,audit={operator:'automatic',reference:'finalized-entrypoint-nonce'}):Promise<ExpiredExitProof[]>{
  try{
    if(c.chainId!==97)throw fail();
    if(!/^[a-zA-Z0-9_.:#/-]{1,128}$/.test(audit.operator)||!/^[a-zA-Z0-9_.:#/-]{1,256}$/.test(audit.reference))throw fail();
    const locks=(await db("select execution_key from gas_budget_reservations where chain_id=$1 and account=$2 and purpose='exit' and state in ('reserved','submitted','unknown')",[c.chainId,account])).rows;
    if(!locks.length)return[];
    const keys=new Set(locks.map(row=>record(row).execution_key));
    const entries=await pending(c.chainId,account,db),now=Math.floor(Date.now()/1000);
    const exits=entries?.filter(e=>keys.has(e.facts.executionKey)&&e.facts.purpose==='exit'&&e.facts.validUntil<now)??[];if(!exits.length)return[];
    const client=createPublicClient({transport:http(c.rpcUrl,{timeout:c.timeoutMs,retryCount:0})});
    const block=await client.getBlock({blockTag:'finalized'});
    if(await client.getChainId()!==97||block.number===null||block.hash===null||block.timestamp>BigInt(now))throw fail();
    const proofs:ExpiredExitProof[]=[];
    for(const {facts}of exits){
      // v0.7 accepts timestamp == validUntil. Only a FINALIZED strictly later block is proof.
      if(block.timestamp<=BigInt(facts.validUntil))continue;
      const nonce=await client.readContract({address:TESTNET_97.contracts.entryPoint,abi:parseAbi(['function getNonce(address,uint192) view returns(uint256)']),functionName:'getNonce',args:[account,BigInt(facts.nonce)>>64n],blockNumber:block.number});
      if(nonce!==BigInt(facts.nonce))continue;
      proofs.push({facts,blockNumber:block.number.toString(),blockHash:block.hash,blockTimestamp:Number(block.timestamp),checkedAt:now,...audit});
    }
    if((await client.getBlock({blockNumber:block.number})).hash!==block.hash)throw fail();
    return proofs;
  }catch{throw fail();}
}
/** Account advisory lock must be held. Evidence commits atomically with both SQL states;
 * a rolled-back attempt leaves neither evidence nor a released lock. No balances/actions change.
 */
export async function applyExpiredExitProofs(db:Pick<PoolClient,'query'>,chainId:number,account:Address,proofs:readonly ExpiredExitProof[]):Promise<number>{
  if(!proofs.length)return 0;
  const entries=await pending(chainId,account,(sql,params)=>db.query(sql,params?[...params]:[]));if(!entries)return 0;
  let released=0;
  for(const executionKey of new Set(proofs.map(p=>p.facts.executionKey))){
    const active=entries.filter(e=>e.facts.executionKey===executionKey);
    if(!active.length||active.some(e=>!proofs.some(p=>JSON.stringify(p.facts)===JSON.stringify(e.facts)&&p.facts.purpose==='exit'&&p.blockTimestamp>p.facts.validUntil&&p.checkedAt<=Date.now()/1000&&Date.now()/1000-p.checkedAt<60)))continue;
    const reservation=(await db.query<{day:string}>("select to_char(utc_day,'YYYY-MM-DD') as day from gas_budget_reservations where chain_id=$1 and account=$2 and execution_key=$3 and purpose='exit' and state in ('reserved','submitted','unknown')",[chainId,account,executionKey])).rows[0];if(!reservation)continue;
    await db.query("select pg_advisory_xact_lock(hashtextextended('gas_budget_reservations:'||$1::bigint::text||':'||$2::text||':'||$3::text,0))",[chainId,account,reservation.day]);
    const evidence=proofs.filter(p=>active.some(e=>e.facts.userOpHash===p.facts.userOpHash));
    const day=(await db.query<{day:string}>("select to_char(transaction_timestamp() at time zone 'UTC','YYYY-MM-DD') as day")).rows[0]?.day;
    if(!day)throw fail();
    await writeYieldState(`release-${evidence[0]?.facts.userOpHash.slice(2)}`,{reason:'expired_finalized_nonce_unchanged',utcDay:day,evidence},(sql,params)=>db.query(sql,params?[...params]:[]));
    await db.query("update paymaster_sponsorships set state='expired',updated_at=greatest(updated_at,clock_timestamp()) where user_op_hash=any($1::text[]) and state not in ('confirmed','failed','expired')",[active.map(e=>e.facts.userOpHash)]);
    await db.query("update gas_budget_reservations set state='failed',updated_at=greatest(updated_at,clock_timestamp()) where execution_key=$1 and state in ('reserved','submitted','unknown')",[executionKey]);released++;
  }
  return released;
}
export async function reconcileExpiredExitAuthorizations(c:ReadConfig,account:Address,audit:{operator:string;reference:string}):Promise<number>{
  const proofs=await expiredExitProofs(c,account,query,audit);
  return withTransaction(async db=>{
    await db.query("select set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)",[String(c.timeoutMs)]);
    await db.query("select pg_advisory_xact_lock(hashtextextended('paymaster_account:'||$1::bigint::text||':'||$2::text,0))",[c.chainId,account]);
    return applyExpiredExitProofs(db,c.chainId,account,proofs);
  });
}
