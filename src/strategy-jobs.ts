import type { CashWithdrawal } from './cash-reconciliation.js';
import { prepareAssetJob, completeAssetSchedules, recordAssetInflight } from './asset-jobs.js';
import type { AssetExecution } from './strategy-execution.js';
import type { Address, Hex } from 'viem';
import type { Allocation } from './strategies.js';
import type { WithTransactionFn, SchedulerQueryFn } from './scheduler.js';
import { addInputs, allocationInputs, basketFits, currentSlot, moneyBudget, subtractInputs, sumInputs } from './new-money-plan.js';
import type { InputVector, MoneyBudget } from './new-money-plan.js';

export type StrategyJob = { id: string; chain_id: string; portfolio_id: string; kind: 'hold' | 'stack' | 'asset'; asset_started_at?:Date|null; lot_id: string | null;
  instruction_revision: string | null; amount_raw: string; fee_reserve_raw: string; allocated_cash_raw: string;
  original_input: InputVector; remaining_input: InputVector; remaining_fee_raw: string; state: string;
  failure_count: number; next_check_at: Date; window_end_at: Date | null };
export type FundingLot = { id: string; tx_hash: Hex; block_number: string; block_hash: Hex; amount_raw: string };
type Instruction = { revision: string; amount_raw: string; start_at: Date; end_at: Date | null; period_seconds: number;
  next_slot_index: string; state: string };
export type JobContext = { chainId: number; portfolioId: number; strategyId: number; version: number; kind: 'hold' | 'stack' | 'asset'; asset_started_at?:Date|null;
  withdrawals?:readonly CashWithdrawal[]; finalAssets?:ReadonlySet<string>; batchStepLimit?: number; account: Address; allocation: Allocation; cash: Address; now: Date; reserve: bigint; caps: ReadonlyMap<string,bigint|null>;
  buyLimit: bigint; observedCash: bigint; enabled: boolean; marketOpen: boolean; execution?:AssetExecution; marketOpenFor?:(assets:readonly string[])=>boolean };
export type BatchEvidence = { received: InputVector; fees: InputVector; feePaid: bigint; blockNumber: bigint; blockHash: Hex };
const activeJob = "state in ('reserved','running','unknown','paused')";
export const unresolvedSql = "(state in ('pending','submitted') or (state='failed' and (tx_hash is not null or user_op_hash is not null)))";

export async function fundingLots(query: SchedulerQueryFn, c: Pick<JobContext,'chainId'|'portfolioId'|'strategyId'|'version'>): Promise<FundingLot[]> {
  return (await query(`select l.* from strategy_funding_lots l where l.chain_id=$1 and l.portfolio_id=$2
    and l.strategy_id=$3 and l.version=$4 and l.kind in ('hold','asset') and l.state='confirmed'
    and (l.kind='asset' or not exists(select 1 from strategy_job_lot_inputs i where i.lot_id=l.id)) order by l.id`,
  [c.chainId,c.portfolioId,c.strategyId,c.version])).rows as FundingLot[];
}
export async function lockCash(query: SchedulerQueryFn, c: Pick<JobContext,'chainId'|'portfolioId'>): Promise<void> {
  await query("set local lock_timeout='5s'");
  await query('select portfolio_id from strategy_cash_balances where chain_id=$1 and portfolio_id=$2 for update',[c.chainId,c.portfolioId]);
  await query('select id from portfolios where id=$1 for update',[c.portfolioId]);
}
export async function readJob(query: SchedulerQueryFn, c: Pick<JobContext,'chainId'|'portfolioId'>): Promise<StrategyJob|null> {
  return (await query(`select * from strategy_jobs where chain_id=$1 and portfolio_id=$2 and ${activeJob}`,[c.chainId,c.portfolioId])).rows[0] as StrategyJob ?? null;
}
/** Advance the current revision while an older attempt is unknown, before reconciling it.
 * A late confirmation must not turn a period already crossed in-flight into a new purchase.
 */
export async function recordInflightSlots(run:WithTransactionFn,c:Pick<JobContext,'chainId'|'portfolioId'|'now'>):Promise<void>{
  await run(async({query})=>{
    await lockCash(query,c);
    const j=await readJob(query,c);
    if(!j)return;
    if(j.kind==='asset'){
      const row=(await query('select asset_strategy_id,asset_version from strategy_jobs where id=$1',[j.id])).rows[0] as {asset_strategy_id:string;asset_version:number};
      await recordAssetInflight(query,{...c,strategyId:Number(row.asset_strategy_id),version:row.asset_version,kind:'asset',account:'0x0000000000000000000000000000000000000000',allocation:{assets:[]},cash:'0x0000000000000000000000000000000000000000',reserve:0n,caps:new Map(),buyLimit:0n,observedCash:0n,enabled:true,marketOpen:false});return;
    }
    // 0032 freezes legacy instructions and forbids new stack jobs. Reconcile evidence only.
    return;
  });
}
/** Reserve source money, immutable vectors and configured cash together. No chain calls in the transaction. */
export async function prepareStrategyJob(run: WithTransactionFn, c: JobContext, verifiedLots: readonly FundingLot[]): Promise<{ job: StrategyJob|null; reason: string }> {
  if(c.kind==='asset'){if(!c.execution)throw new Error('missing per-asset config');return prepareAssetJob(run,c,c.execution,verifiedLots);}
  return run(async ({query}) => {
    await lockCash(query,c);
    const reorg = await query("select id from strategy_funding_lots where chain_id=$1 and portfolio_id=$2 and state='reorged' limit 1",[c.chainId,c.portfolioId]);
    if (reorg.rows.length) return {job:null,reason:'[FUNDING_REORGED] 投入需先對帳'};
    let existing = await readJob(query,c);
    const instruction = c.kind === 'stack' ? (await query(`select * from stack_instructions where chain_id=$1 and portfolio_id=$2
      and strategy_id=$3 and version=$4 order by revision desc limit 1`,[c.chainId,c.portfolioId,c.strategyId,c.version])).rows[0] as Instruction|undefined : undefined;
    const unresolved = await query(`select id from operations where portfolio_id=$1 and ${unresolvedSql} limit 1`,[c.portfolioId]);
    if (unresolved.rows.length) return {job:existing,reason:'[PREVIOUS_INFLIGHT] 未知操作先對帳'};
    if(existing?.kind==='stack' && existing.window_end_at!==null && existing.window_end_at<=c.now){
      const confirmed=await query("select batch_index from strategy_job_batches where job_id=$1 and state='confirmed' limit 1",[existing.id]);
      if(confirmed.rows.length===0){await cancelJob(query,c,existing);existing=null;}
    }
    if (!c.enabled || (c.kind === 'stack' && instruction?.state !== 'active')) {
      if (existing && c.kind==='stack') await cancelJob(query,c,existing);
      return {job:null,reason:'[STOPPED] 本人已暫停或停止，剩餘預留已釋放'};
    }
    const balance = (await query(`select *, (unallocated_hold_raw+stack_prefund_raw+allocated_cash_raw+reserved_input_raw+
      reserved_fee_raw+withdrawal_raw+yield_raw)::text as classified from strategy_cash_balances where chain_id=$1 and portfolio_id=$2`,[c.chainId,c.portfolioId])).rows[0] as
      {classified:string; unallocated_hold_raw:string;stack_prefund_raw:string}|undefined;
    if (!balance) return {job:null,reason:'[NO_FUNDING] 沒有已確認投入'};
    if (BigInt(balance.classified)>c.observedCash) return {job:null,reason:'[CASH_DEFICIT] 現金分類與鏈上不符，先對帳'};
    if (c.kind==='stack' && instruction) {
      const slot=currentSlot({startAt:instruction.start_at,endAt:instruction.end_at,periodSeconds:instruction.period_seconds,nextIndex:BigInt(instruction.next_slot_index)},c.now);
      if (slot) {
        const ended=slot.end<=c.now;
        const missed=ended?slot.index:slot.missedThrough;
        if (missed!==null) await skipSlots(query,c,instruction,BigInt(instruction.next_slot_index),missed,'skipped_window');
        if (!ended && existing) {
          await skipSlots(query,c,instruction,slot.index,slot.index,'skipped_previous_inflight');
        } else if (!ended && !existing && c.marketOpen) {
          const budget=moneyBudget(BigInt(instruction.amount_raw),'stack',c.allocation,c.cash,c.reserve,c.caps,c.buyLimit);
          // Even if capacity is currently unknown, insufficient *original A + one reserve* is definitive.
          if (BigInt(balance.stack_prefund_raw)<BigInt(instruction.amount_raw)+(budget?.fee??c.reserve)) {
            await skipSlots(query,c,instruction,slot.index,slot.index,'skipped_insufficient_funds');
            return {job:null,reason:'[SKIPPED_INSUFFICIENT_FUNDS] 本期備款不足，補款不追扣'};
          }
          if (!budget) return {job:null,reason:'[BASKET_WAITING] 整籃子門檻或容量不足'};
          const job=await insertJob(query,c,budget,{revision:instruction.revision,index:slot.index,at:slot.at,end:slot.end});
          await query('update stack_instructions set next_slot_index=$4,updated_at=clock_timestamp() where chain_id=$1 and portfolio_id=$2 and revision=$3',
            [c.chainId,c.portfolioId,instruction.revision,(slot.index+1n).toString()]);
          await reserveCash(query,c,'stack_prefund_raw',budget);
          return {job,reason:'本期期次已預留'};
        }
      }
    }
    if (existing) return {job:existing,reason:existing.state==='paused'?'[JOB_PAUSED] 連續失敗，工作已暫停':'繼續原向量'};
    if (c.kind==='stack') return {job:null,reason:c.marketOpen?'[NO_DUE_SLOT] 等待下一個未來期次':'[MARKET_CLOSED] 整個基金等待交易時段'};
    if (!c.marketOpen) return {job:null,reason:'[MARKET_CLOSED] 整個基金等待交易時段'};
    const lots=await fundingLots(query,c);
    if (lots.length===0) return {job:null,reason:'[NO_NEW_MONEY] 沒有未配置投入；價格漂移不觸發交易'};
    if (lots.some(l=>!verifiedLots.some(v=>v.id===l.id&&v.block_hash===l.block_hash&&v.amount_raw===l.amount_raw))) throw new Error('funding changed before reservation');
    const total=lots.reduce((sum,l)=>sum+BigInt(l.amount_raw),0n);
    const budget=moneyBudget(total,'hold',c.allocation,c.cash,c.reserve,c.caps,c.buyLimit);
    if (!budget) return {job:null,reason:'[BASKET_WAITING] 投入不足完整籃子，等待同版本後續投入'};
    const sources: {lot:FundingLot;budget:MoneyBudget}[]=[];
    let feeLeft=budget.fee;
    for (const [index,lot] of lots.entries()) {
      const fee=index===lots.length-1?feeLeft:budget.fee*BigInt(lot.amount_raw)/total;
      feeLeft-=fee;
      const amount=BigInt(lot.amount_raw)-fee;
      if (amount<=0n) return {job:null,reason:'[BASKET_WAITING] 單筆投入不足費用預留'};
      const vector=allocationInputs(amount,c.allocation,c.cash);
      sources.push({lot,budget:{amount,fee,cash:vector.cash,inputs:vector.inputs,batchCount:budget.batchCount}});
    }
    const first=sources[0]; if (!first) throw new Error('missing hold source');
    const actualInputs=sources.reduce((sum,source)=>addInputs(sum,source.budget.inputs),{});
    if(Object.keys(actualInputs).length>0&&!basketFits(actualInputs,budget.batchCount,c.caps,c.buyLimit)){
      return {job:null,reason:'[BASKET_WAITING] 逐筆取整後仍不足完整籃子，等待同版本後續投入'};
    }
    // One cash-only root can cover all lots without a non-root append to a terminal job.
    // Start reserved when attaching sources, then complete after aggregation.
    let job=await insertJob(query,c,first.budget,{lot:first.lot.id},sources.length>1);
    let aggregate=first.budget;
    for (const source of sources.slice(1)) {
      await query(`insert into strategy_job_lot_inputs(job_id,lot_id,amount_raw,fee_reserve_raw,allocated_cash_raw,original_input)
        values($1,$2,$3,$4,$5,$6)`,[job.id,source.lot.id,source.budget.amount.toString(),source.budget.fee.toString(),source.budget.cash.toString(),JSON.stringify(source.budget.inputs)]);
      aggregate={...aggregate,amount:aggregate.amount+source.budget.amount,fee:aggregate.fee+source.budget.fee,cash:aggregate.cash+source.budget.cash,inputs:addInputs(aggregate.inputs,source.budget.inputs)};
    }
    if (sources.length>1) {
      job=(await query(`update strategy_jobs set amount_raw=$2,fee_reserve_raw=$3,allocated_cash_raw=$4,original_input=$5,remaining_input=$5,
        remaining_fee_raw=$3,state=$6,updated_at=clock_timestamp() where id=$1 returning *`,[job.id,aggregate.amount.toString(),aggregate.fee.toString(),aggregate.cash.toString(),JSON.stringify(aggregate.inputs),sumInputs(aggregate.inputs)===0n?'completed':'reserved'])).rows[0] as StrategyJob;
    }
    await reserveCash(query,c,'unallocated_hold_raw',aggregate);
    return {job,reason:sumInputs(job.remaining_input)===0n?'純現金已完成配置，沒有空買單':'新投入已固定向量及費用'};
  });
}
async function insertJob(query: SchedulerQueryFn,c:JobContext,b:MoneyBudget,source:{lot:string}|{revision:string;index:bigint;at:Date;end:Date},forceReserved=false):Promise<StrategyJob>{
  const stack='revision' in source;
  const row=(await query(`insert into strategy_jobs(chain_id,portfolio_id,kind,lot_id,instruction_revision,slot_index,through_slot_index,slot_at,window_end_at,
    amount_raw,fee_reserve_raw,allocated_cash_raw,original_input,remaining_input,remaining_fee_raw,state,next_check_at)
    values($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12,$12,$10,$13,$14) returning *`,
    [c.chainId,c.portfolioId,c.kind,stack?null:source.lot,stack?source.revision:null,stack?source.index.toString():null,stack?source.at:null,stack?source.end:null,
      b.amount.toString(),b.fee.toString(),b.cash.toString(),JSON.stringify(b.inputs),sumInputs(b.inputs)===0n&&!forceReserved?'completed':'reserved',c.now])).rows[0] as StrategyJob|undefined;
  if(!row)throw new Error('job insert did not return identity'); return row;
}
async function reserveCash(query:SchedulerQueryFn,c:JobContext,bucket:'unallocated_hold_raw'|'stack_prefund_raw',b:MoneyBudget){
  await query(`update strategy_cash_balances set ${bucket}=${bucket}-$3::numeric,allocated_cash_raw=allocated_cash_raw+$4::numeric,
    reserved_input_raw=reserved_input_raw+$5::numeric,reserved_fee_raw=reserved_fee_raw+$6::numeric,updated_at=clock_timestamp()
    where chain_id=$1 and portfolio_id=$2`,[c.chainId,c.portfolioId,(b.amount+b.fee).toString(),b.cash.toString(),sumInputs(b.inputs).toString(),b.fee.toString()]);
}
async function skipSlots(query:SchedulerQueryFn,c:Pick<JobContext,'chainId'|'portfolioId'>,i:Instruction,from:bigint,through:bigint,state:string){
  const at=new Date(i.start_at.getTime()+Number(from)*i.period_seconds*1000);
  const end=new Date(Math.min(i.start_at.getTime()+Number(through+1n)*i.period_seconds*1000,i.end_at?.getTime()??Infinity));
  await query(`insert into strategy_jobs(chain_id,portfolio_id,kind,instruction_revision,slot_index,through_slot_index,slot_at,window_end_at,
    amount_raw,fee_reserve_raw,allocated_cash_raw,original_input,remaining_input,remaining_fee_raw,state)
    values($1,$2,'stack',$3,$4,$5,$6,$7,0,0,0,'{}','{}',0,$8)`,[c.chainId,c.portfolioId,i.revision,from.toString(),through.toString(),at,end,state]);
  await query('update stack_instructions set next_slot_index=$4,updated_at=clock_timestamp() where chain_id=$1 and portfolio_id=$2 and revision=$3',
    [c.chainId,c.portfolioId,i.revision,(through+1n).toString()]);
}
export async function cancelJob(query:SchedulerQueryFn,c:Pick<JobContext,'chainId'|'portfolioId'>,j:StrategyJob){
  await query("update strategy_job_batches set state='cancelled',updated_at=clock_timestamp() where job_id=$1 and state='planned'",[j.id]);
  if(j.kind==='asset'){
    const rows=(await query(`select s.asset,s.amount_raw::text,s.fee_reserve_raw::text,e.value->'execution'->>'kind' as mode
      from strategy_asset_slices s join strategy_funding_lots l on l.id=s.lot_id join strategy_versions v on (v.strategy_id,v.version)=(l.strategy_id,l.version),jsonb_array_elements(v.execution->'assets') e
      where s.job_id=$1 and e.value->>'asset'=s.asset order by s.lot_id,s.asset`,[j.id])).rows as {asset:string;amount_raw:string;fee_reserve_raw:string;mode:string}[];
    let hold=0n,stack=0n,feeLeft=BigInt(j.remaining_fee_raw);
    const remaining={...j.remaining_input},original={...j.original_input};
    for(const [index,s] of rows.entries()){
      const input=BigInt(remaining[s.asset]??'0')*BigInt(s.amount_raw)/BigInt(original[s.asset]??'1');
      remaining[s.asset]=(BigInt(remaining[s.asset]??'0')-input).toString();original[s.asset]=(BigInt(original[s.asset]??'0')-BigInt(s.amount_raw)).toString();
      const fee=index===rows.length-1?feeLeft:BigInt(j.remaining_fee_raw)*BigInt(s.fee_reserve_raw)/(BigInt(j.fee_reserve_raw)||1n);feeLeft-=fee;
      if(s.mode==='hold')hold+=input+fee;else stack+=input+fee;
    }
    await query(`update strategy_cash_balances set unallocated_hold_raw=unallocated_hold_raw+$3::numeric,stack_prefund_raw=stack_prefund_raw+$4::numeric,reserved_input_raw=reserved_input_raw-$5::numeric,reserved_fee_raw=reserved_fee_raw-$6::numeric,updated_at=clock_timestamp() where chain_id=$1 and portfolio_id=$2`,[c.chainId,c.portfolioId,hold.toString(),stack.toString(),sumInputs(j.remaining_input).toString(),j.remaining_fee_raw]);
    await query("update strategy_asset_slices set state=$2,updated_at=clock_timestamp() where job_id=$1 and state='reserved'",[j.id,j.asset_started_at==null?'skipped_window':'cancelled']);
    await query("update strategy_jobs set state='cancelled',updated_at=clock_timestamp() where id=$1",[j.id]);
    await completeAssetSchedules(query,c.portfolioId);return;
  }
  const bucket=j.kind==='hold'?'unallocated_hold_raw':'stack_prefund_raw';
  await query(`update strategy_cash_balances set ${bucket}=${bucket}+$3::numeric,reserved_input_raw=reserved_input_raw-$4::numeric,
    reserved_fee_raw=reserved_fee_raw-$5::numeric,updated_at=clock_timestamp() where chain_id=$1 and portfolio_id=$2`,
    [c.chainId,c.portfolioId,(sumInputs(j.remaining_input)+BigInt(j.remaining_fee_raw)).toString(),sumInputs(j.remaining_input).toString(),j.remaining_fee_raw]);
  await query("update strategy_jobs set state='cancelled',updated_at=clock_timestamp() where id=$1",[j.id]);
}
/** Operation + business evidence + remaining vector + cash settle in one commit (0031 deferred constraints). */
export async function settleStrategyBatch(run:WithTransactionFn,c:Pick<JobContext,'chainId'|'portfolioId'>,operationId:string,e:BatchEvidence){
  await run(async({query})=>{
    await lockCash(query,c);
    const op=(await query('select * from operations where id=$1 for update',[operationId])).rows[0] as {strategy_job_id:string;strategy_batch_index:number;state:string}|undefined;
    if(!op)throw new Error('missing attempt');
    const j=(await query('select * from strategy_jobs where id=$1 for update',[op.strategy_job_id])).rows[0] as StrategyJob;
    const b=(await query('select * from strategy_job_batches where job_id=$1 and batch_index=$2 for update',[j.id,op.strategy_batch_index])).rows[0] as {state:string;input_raw:InputVector};
    if(b.state==='confirmed')return;
    if(!['pending','submitted'].includes(op.state)||e.feePaid>BigInt(j.remaining_fee_raw))throw new Error('inconsistent confirmation');
    const remaining=subtractInputs(j.remaining_input,b.input_raw),done=sumInputs(remaining)===0n;
    await query("update operations set state='confirmed',updated_at=clock_timestamp() where id=$1",[operationId]);
    await query(`update strategy_job_batches set state='confirmed',confirmed_operation_id=$3,received_assets=$4,fee_assets=$5,fee_paid_raw=$6,
      block_number=$7,block_hash=$8,updated_at=clock_timestamp() where job_id=$1 and batch_index=$2`,
      [j.id,op.strategy_batch_index,operationId,JSON.stringify(e.received),JSON.stringify(e.fees),e.feePaid.toString(),e.blockNumber.toString(),e.blockHash]);
    const fee=BigInt(j.remaining_fee_raw)-e.feePaid;
    if(done&&j.kind==='asset')await query("update strategy_asset_slices set state='completed',updated_at=clock_timestamp() where job_id=$1 and state='reserved'",[j.id]);
    await query(`update strategy_jobs set remaining_input=$2,remaining_fee_raw=$3,state=$4,failure_count=0,updated_at=clock_timestamp() where id=$1`,
      [j.id,JSON.stringify(remaining),fee.toString(),done?'completed':'running']);
    await query(`update strategy_cash_balances set reserved_input_raw=reserved_input_raw-$3::numeric,reserved_fee_raw=reserved_fee_raw-$4::numeric,
      allocated_cash_raw=allocated_cash_raw+$5::numeric,updated_at=clock_timestamp() where chain_id=$1 and portfolio_id=$2`,
      [c.chainId,c.portfolioId,sumInputs(b.input_raw).toString(),(done?BigInt(j.remaining_fee_raw):e.feePaid).toString(),done?fee.toString():'0']);
    if(done&&j.kind==='asset')await completeAssetSchedules(query,c.portfolioId);
  });
}
