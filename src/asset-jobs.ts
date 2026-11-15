import { reconcileCashWithdrawals } from './cash-reconciliation.js';
import { record as isRecord } from './strategy-execution.js';
import type { AssetExecution, AssetMode } from './strategy-execution.js';
import type { FundingLot, JobContext, StrategyJob } from './strategy-jobs.js';
import { lockCash, readJob, unresolvedSql, cancelJob } from './strategy-jobs.js';
import { assetBatchBudget, assetPeriod } from './asset-plan.js';
import { addInputs, basketBatch, sumInputs, USDT_UNIT as U, windowCapacityFits } from './new-money-plan.js';
import type { InputVector } from './new-money-plan.js';
import type { SchedulerQueryFn, WithTransactionFn } from './scheduler.js';

type Source = { lot_id:string; asset:string; budget_raw:string; effective_slices:number; first_slot_at:Date|null; created_at:Date; mode:AssetMode; index:number; carry:bigint };
type Due = Source & { slot:Date; end:Date; budget:bigint };
export async function completeAssetSchedules(query:SchedulerQueryFn,portfolioId:number):Promise<void>{
  await query(`update strategy_lot_assets a set state='completed',updated_at=clock_timestamp() from strategy_funding_lots l
    where l.id=a.lot_id and l.portfolio_id=$1 and a.state='active'
    and (select count(*) from strategy_asset_slices s where s.lot_id=a.lot_id and s.asset=a.asset)=a.effective_slices
    and not exists(select 1 from strategy_asset_slices s where s.lot_id=a.lot_id and s.asset=a.asset and s.state in ('reserved','cancelled'))`,[portfolioId]);
}
async function sources(query:SchedulerQueryFn,c:Pick<JobContext,'chainId'|'portfolioId'|'strategyId'|'version'>):Promise<Source[]>{
  const rows=await query(`select a.*,l.created_at as confirmed_at,e.value->'execution' as mode,
    (select count(*)::int from strategy_asset_slices s where s.lot_id=a.lot_id and s.asset=a.asset) as next_index,
    (select case when s.job_id is null then case when s.state='deferred_min_asset' then s.budget_raw else s.carry_in_raw end else 0 end
      from strategy_asset_slices s where s.lot_id=a.lot_id and s.asset=a.asset order by s.slice_index desc limit 1)::text as carry
    from strategy_lot_assets a join strategy_funding_lots l on l.id=a.lot_id
    join strategy_versions v on (v.strategy_id,v.version)=(l.strategy_id,l.version),jsonb_array_elements(v.execution->'assets') e
    where l.chain_id=$1 and l.portfolio_id=$2 and l.strategy_id=$3 and l.version=$4 and l.kind='asset' and l.state='confirmed'
    and a.state='active' and e.value->>'asset'=a.asset and e.value ? 'execution' order by a.lot_id,a.asset for update of a`,
    [c.chainId,c.portfolioId,c.strategyId,c.version]);
  return rows.rows.map(r=>{if(!isRecord(r)||!(r.confirmed_at instanceof Date)||!isRecord(r.mode))throw new Error('invalid persisted source'); return ({lot_id:String(r.lot_id),asset:String(r.asset),budget_raw:String(r.budget_raw),effective_slices:Number(r.effective_slices),first_slot_at:r.first_slot_at as Date|null,
    created_at:r.confirmed_at as Date,mode:r.mode as AssetMode,index:Number(r.next_index),carry:BigInt(String(r.carry??'0'))});});
}
function dueSource(s:Source,now:Date,holdSlot?:Date):Due|null{
  if(s.index>=s.effective_slices)return null;
  const base=BigInt(s.budget_raw)/BigInt(s.effective_slices);
  const budget=(s.index===s.effective_slices-1?BigInt(s.budget_raw)-base*BigInt(s.effective_slices-1):base)+s.carry;
  const slot=s.mode.kind==='stack'?new Date((s.first_slot_at?.getTime()??NaN)+s.index*assetPeriod(s.mode)):
    holdSlot&&holdSlot>=s.created_at?holdSlot:new Date(Math.max(Math.floor(now.getTime()/60000)*60000,s.created_at.getTime()));
  if(!Number.isFinite(slot.getTime()))throw new Error('missing source calendar');
  return slot>now?null:{...s,slot,end:new Date(slot.getTime()+assetPeriod(s.mode)),budget};
}
async function record(query:SchedulerQueryFn,s:Due,state:string,job?:{id:string;amount:bigint;fee:bigint}):Promise<void>{
  await query(`insert into strategy_asset_slices(lot_id,asset,slice_index,slot_at,window_end_at,budget_raw,job_id,amount_raw,fee_reserve_raw,original_input,state)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[s.lot_id,s.asset,s.index,s.slot,s.end,s.budget.toString(),job?.id??null,
    job?.amount.toString()??'0',job?.fee.toString()??'0',JSON.stringify(job?{[s.asset]:job.amount.toString()}:{}),state]);
}
/** Caller holds the cash row lock. Both writes use its transaction; a failed
 * notification must never commit a skipped installment without its event.
 */
async function recordInsufficient(query:SchedulerQueryFn,c:JobContext,due:readonly Due[]):Promise<void>{
  const recipient=(await query(`select a.owner from smart_accounts a join strategy_cash_balances b
    on (a.chain_id,a.portfolio_id,a.address)=(b.chain_id,b.portfolio_id,b.account)
    where b.chain_id=$1 and b.portfolio_id=$2 and b.account=$3`,[c.chainId,c.portfolioId,c.account])).rows[0];
  if(!isRecord(recipient)||typeof recipient.owner!=='string'||!/^0x[0-9a-f]{40}$/.test(recipient.owner))throw new Error('notification recipient unavailable');
  for(const s of due){
    await record(query,s,'skipped_insufficient_funds');
    // Explicit public facts only: never spread context, upstream errors or credentials.
    const payload=JSON.stringify({budgetRaw:s.budget.toString(),slotAt:s.slot.toISOString(),windowEndAt:s.end.toISOString()});
    const params=[c.chainId,c.portfolioId,recipient.owner,s.lot_id,s.asset,s.index,payload];
    const inserted=await query(`insert into user_notifications(chain_id,portfolio_id,owner,kind,dedup_key,lot_id,asset,slice_index,payload)
      values($1,$2,$3,'stack_slot_skipped_insufficient_funds',$4::bigint::text || ':' || $5::text || ':' || $6::int::text,$4,$5,$6,$7::jsonb)
      on conflict (chain_id,kind,dedup_key) do nothing returning id`,params);
    if(inserted.rows.length===0){
      // A separate READ COMMITTED statement sees the winner after a unique-key wait.
      // Preserve its permanent ID, payload and delivered/failed state on retries.
      const original=await query(`select id from user_notifications where chain_id=$1 and portfolio_id=$2 and owner=$3
        and kind='stack_slot_skipped_insufficient_funds' and dedup_key=$4::bigint::text || ':' || $5::text || ':' || $6::int::text
        and lot_id=$4 and asset=$5 and slice_index=$6 and payload=$7::jsonb`,params);
      if(original.rows.length!==1)throw new Error('notification identity mismatch');
    }
  }
}
/** Record bounded (<=52 per asset) missed windows. Never turn skipped base into a later debit. */
async function collect(query:SchedulerQueryFn,c:JobContext,inflight:boolean):Promise<Due[]>{
  const result:Due[]=[];
  for(const source of await sources(query,c)){
    let s=source;
    // Hold has no next period: an older in-flight job must not consume a new contribution.
    if(inflight&&s.mode.kind==='hold')continue;
    for(;;){
      const due=dueSource(s,c.now);if(!due)break;
      const missed=due.end<=c.now;
      if(!missed&&!inflight){result.push(due);break;}
      await record(query,due,missed?'skipped_window':'skipped_previous_inflight');
      // Skips keep only pre-existing unreserved dust.
      s={...s,index:s.index+1};
      if(!missed)break;
    }
  }
  await completeAssetSchedules(query,c.portfolioId);
  return result;
}
export async function recordAssetInflight(query:SchedulerQueryFn,c:JobContext):Promise<void>{await collect(query,c,true);}

export async function prepareAssetJob(run:WithTransactionFn,c:JobContext,config:AssetExecution,verifiedLots:readonly FundingLot[]):Promise<{job:StrategyJob|null;reason:string}>{
 return run(async({query})=>{
  await lockCash(query,c);
  if((await query("select id from strategy_funding_lots where chain_id=$1 and portfolio_id=$2 and state='reorged' limit 1",[c.chainId,c.portfolioId])).rows.length)return {job:null,reason:'[FUNDING_REORGED] 投入需對帳'};
  let existing=await readJob(query,c);
  const unresolved=(await query(`select id from operations where portfolio_id=$1 and ${unresolvedSql} limit 1`,[c.portfolioId])).rows.length>0;
  if(unresolved){await collect(query,c,true);return {job:existing,reason:'[PREVIOUS_INFLIGHT] 原操作需先對帳'};}
  if(existing?.kind==='asset'&&existing.asset_started_at==null&&existing.window_end_at!==null&&existing.window_end_at<=c.now){await cancelJob(query,c,existing);existing=null;}
  if(!c.enabled){if(existing)await cancelJob(query,c,existing);return {job:null,reason:'[STOPPED] 本人已暫停新買入'};}
  await reconcileCashWithdrawals(query,c,c.withdrawals??[]);
  if(existing){await collect(query,c,true);return {job:existing,reason:'繼續原工作，後續期次不補扣'};}
  let due=await collect(query,c,false);
  if(due.length===0)return {job:null,reason:'[NO_DUE_SLOT] 沒有新投入或到期期次'};
  if(due.some(s=>!verifiedLots.some(l=>l.id===s.lot_id)))throw new Error('funding changed before reservation');
  // Hold money may join an already due creator timestamp only if confirmed before it.
  const earliestStack=due.filter(s=>s.mode.kind==='stack').sort((a,b)=>a.slot.getTime()-b.slot.getTime())[0]?.slot;
  if(earliestStack)due=due.map(s=>s.mode.kind==='hold'&&s.created_at<=earliestStack?{...s,slot:earliestStack,end:new Date(earliestStack.getTime()+assetPeriod(s.mode))}:s);
  const slot=due.reduce((a,b)=>a.slot<b.slot?a:b).slot;
  due=due.filter(s=>s.slot.getTime()===slot.getTime());
  if(!(c.marketOpenFor?.(due.map(s=>s.asset))??c.marketOpen))return {job:null,reason:'[MARKET_CLOSED] 同一批等待所有資產交易時段'};
  const balance=(await query(`select unallocated_hold_raw::text,stack_prefund_raw::text,(unallocated_hold_raw+stack_prefund_raw+allocated_cash_raw+reserved_input_raw+reserved_fee_raw+withdrawal_raw+yield_raw)::text as total from strategy_cash_balances where chain_id=$1 and portfolio_id=$2`,[c.chainId,c.portfolioId])).rows[0] as {total:string;unallocated_hold_raw:string;stack_prefund_raw:string}|undefined;
  if(!balance)throw new Error('missing cash row');
  const holdDue=due.filter(s=>s.mode.kind==='hold').reduce((n,s)=>n+s.budget,0n),stackDue=due.filter(s=>s.mode.kind==='stack').reduce((n,s)=>n+s.budget,0n);
  if(BigInt(balance.total)>c.observedCash||holdDue>BigInt(balance.unallocated_hold_raw)||stackDue>BigInt(balance.stack_prefund_raw)){
    await recordInsufficient(query,c,due);
    await completeAssetSchedules(query,c.portfolioId);
    return {job:null,reason:'[SKIPPED_INSUFFICIENT_FUNDS] 本期不足，已略過且不追扣'};
  }
  const finalAssets=new Set(due.filter(s=>s.index===s.effective_slices-1).map(s=>s.asset));
  // Determine dust on the MERGED asset, not each small lot separately.
  let budgets:InputVector={};for(const s of due)budgets=addInputs(budgets,{[s.asset]:s.budget.toString()});
  const dust=new Set(Object.entries(budgets).filter(([asset,v])=>!finalAssets.has(asset)&&BigInt(v)-c.reserve*BigInt(v)/sumInputs(budgets)<U).map(([a])=>a));
  for(const s of due.filter(s=>dust.has(s.asset)))await record(query,s,'deferred_min_asset');
  due=due.filter(s=>!dust.has(s.asset));budgets={};for(const s of due)budgets=addInputs(budgets,{[s.asset]:s.budget.toString()});
  await completeAssetSchedules(query,c.portfolioId);
  if(!due.length)return {job:null,reason:'[DEFERRED_MIN_ASSET] 小於1 USDT，留至該資產下期'};
  const budget=assetBatchBudget(budgets,c.reserve,c.caps,c.buyLimit,c.batchStepLimit,finalAssets,c.chainId===97);
  if(!budget)return {job:null,reason:'[BASKET_WAITING] 完整合單門檻、容量或額度不足'};
  const end=due.reduce((a,b)=>a.end<b.end?a:b).end;
  const prior=await query("select id from strategy_jobs where chain_id=$1 and portfolio_id=$2 and kind='asset' and slot_at=$3",[c.chainId,c.portfolioId,slot]);
  if(prior.rows.length)return {job:null,reason:'[SLOT_RECORDED] 原時點已記錄，不能另建同時點工作'};
  let inputs:InputVector={};let feeLeft=budget.fee,hold=0n,stack=0n;
  const sourceBudgets:{source:Due;amount:bigint;fee:bigint}[]=[];
  const total=sumInputs(budgets);
  for(const [index,s] of due.entries()){
    const fee=index===due.length-1?feeLeft:budget.fee*s.budget/total;feeLeft-=fee;
    const amount=s.budget-fee;if(amount<=0n)throw new Error('source cannot cover fee');
    sourceBudgets.push({source:s,amount,fee});inputs=addInputs(inputs,{[s.asset]:amount.toString()});
    if(s.mode.kind==='hold')hold+=s.budget;else stack+=s.budget;
  }
  const largest=basketBatch(inputs,budget.count);
  const capacity=c.chainId===97?windowCapacityFits(inputs,budget.count,c.reserve,c.caps,c.buyLimit):sumInputs(largest)<=c.buyLimit&&
    Object.entries(largest).every(([a,v])=>{const cap=c.caps.get(a);return cap===null||(cap!==undefined&&BigInt(v)<=cap);});
  if(Object.entries(inputs).some(([asset,v])=>BigInt(v)/budget.count<(finalAssets.has(asset)?1n:U))||sumInputs(largest)>c.buyLimit||
    !capacity){
    return {job:null,reason:'[BASKET_WAITING] 逐來源費用尾差超過容量或低於門檻'};
  }
  const job=(await query(`insert into strategy_jobs(chain_id,portfolio_id,kind,asset_strategy_id,asset_version,slot_at,window_end_at,amount_raw,fee_reserve_raw,allocated_cash_raw,original_input,remaining_input,remaining_fee_raw,state,next_check_at)
    values($1,$2,'asset',$3,$4,$5,$6,$7,$8,0,$9,$9,$8,'reserved',$10) returning *`,
    [c.chainId,c.portfolioId,c.strategyId,c.version,slot,end,sumInputs(inputs).toString(),budget.fee.toString(),JSON.stringify(inputs),c.now])).rows[0] as StrategyJob|undefined;
  if(!job)throw new Error('missing job identity');
  for(const s of sourceBudgets)await record(query,s.source,'reserved',{id:job.id,amount:s.amount,fee:s.fee});
  await query(`update strategy_cash_balances set unallocated_hold_raw=unallocated_hold_raw-$3::numeric,stack_prefund_raw=stack_prefund_raw-$4::numeric,
    reserved_input_raw=reserved_input_raw+$5::numeric,reserved_fee_raw=reserved_fee_raw+$6::numeric,updated_at=clock_timestamp() where chain_id=$1 and portfolio_id=$2`,
    [c.chainId,c.portfolioId,hold.toString(),stack.toString(),sumInputs(inputs).toString(),budget.fee.toString()]);
  return {job,reason:'逐資產期次已合單並原子預留'};
 });
}
