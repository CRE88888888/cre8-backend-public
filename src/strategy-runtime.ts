import { readCashWithdrawals } from './cash-reconciliation.js';
import type { CashWithdrawal } from './cash-reconciliation.js';
import { mixCashWithdrawals } from './mix-flows.js';
import { executionBatchSize, executionInputGroups } from './execution-batch.js';
import { formatUnits } from 'viem';
import type { Address, PublicClient } from 'viem';
import { EXECUTOR_ABI } from './chain.js';
import { requireTypedVersion } from './strategies.js';
import type { StrategyVersion } from './strategies.js';
import { MIN_ASSET_BATCH_RAW, numeraireFor } from './strategy-execution.js';
import { basketBatch, batchCountFor, maxBasketBatches, sumInputs, windowBasketBatch, windowCapacityFits, maxWindowBatches, windowBatchCountFor, principalWithinFee, reduceInputs, USDT_UNIT } from './new-money-plan.js';
import type { InputVector } from './new-money-plan.js';
import { cancelJob, fundingLots, lockCash, prepareStrategyJob, readJob, unresolvedSql } from './strategy-jobs.js';
import type { FundingLot, JobContext, StrategyJob } from './strategy-jobs.js';
import { minimumFeeReserve, quoteNewMoney, readBuyBudget, readMaxLegUsdE8, newMoneyDepthCap, nominalSellQuote, readFeeDue } from './rebalance-plan.js';
import type { PlannedStep, RebalancePlan } from './rebalance-plan.js';
import type { DuePortfolio, SchedulerQueryFn, WithTransactionFn } from './scheduler.js';
import type { PortfolioPlan } from './snapshot.js';
import { assetsMarketOpen } from './trading-calendar.js';
import { yieldRebalanceDue } from './yield-rebalance.js';

export type NewMoneyPolicy = { reserve: bigint; caps: Map<string,bigint|null>; buyLimit: bigint; cash: bigint };
export type NewMoneyDeps = {
  version: typeof requireTypedVersion;
  policy: (due:DuePortfolio,plan:PortfolioPlan,assets:readonly string[])=>Promise<NewMoneyPolicy>;
  withdrawals: (due:DuePortfolio,plan:PortfolioPlan)=>Promise<CashWithdrawal[]>;
  rebalanceReserve: (plan:PortfolioPlan)=>Promise<bigint>;
  yieldHoldings: (plan:PortfolioPlan)=>Promise<PortfolioPlan>;
  withdrawYield: (due:DuePortfolio,plan:PortfolioPlan,reserve:bigint,steps:readonly PlannedStep[])=>Promise<string|null>;
  verifyLots: (lots:readonly FundingLot[])=>Promise<void>;
  quote: (due:DuePortfolio,plan:PortfolioPlan,inputs:InputVector,deadline:bigint)=>Promise<RebalancePlan>;
  /** Fee-window chains: the top-up the executor would charge this account for a buy of a given size (see readFeeDue). */
  feeDue: (due:DuePortfolio,plan:PortfolioPlan)=>Promise<(notional:bigint)=>Promise<bigint>>;
  marketOpen: (version:StrategyVersion,now:Date)=>boolean;
};
export function defaultNewMoneyDeps(client:()=>PublicClient,executor:()=>Address,registry:()=>Address,query:SchedulerQueryFn,chainId:number):NewMoneyDeps {
  return {
    version:requireTypedVersion,
    // My mix: the same verified flows the mix tick reconciles (any outflow, e.g. a DCA vault deposit). The owner-transfer scan
    // below cannot re-prove those, so mixing the two sources saved withdrawals one side rejects as [CASH_REORGED] (portfolio 13).
    withdrawals:(due,plan)=>due.personalMix?mixCashWithdrawals(due.portfolioId,query,plan.snapshot.block):
      readCashWithdrawals(client(),query,{chainId,portfolioId:due.portfolioId,account:due.account,cash:numeraireFor(chainId) as Address,blockNumber:plan.snapshot.block}),
    rebalanceReserve:plan=>minimumFeeReserve(client(),executor(),BigInt(plan.pinnedVersion.onchainStrategyId),plan.snapshot.block,plan.account,chainId===97),
    yieldHoldings:async(plan)=>{
      const holdings=plan.snapshot.holdings.map(h=>({...h}));
      for(const p of plan.snapshot.yieldPositions??[]){
        if(p.state!=='known'||p.claim===null)throw new Error('[YIELD_UNAVAILABLE] 生息債權未知');
        if(p.claim===0n)continue;
        const existing=holdings.find(h=>h.asset.toLowerCase()===p.market.asset);
        if(existing){existing.amountWei+=p.claim;continue;}
        const oracle=await client().readContract({address:executor(),abi:EXECUTOR_ABI,functionName:'oracle',blockNumber:plan.snapshot.block});
        // Price absent direct holdings at the same block through the existing oracle ABI.
        const usdPriceE8=p.market.asset===numeraireFor(chainId)?100000000n:await nominalSellQuote(client(),oracle,p.market.asset,
          numeraireFor(chainId) as Address,10n**BigInt(p.underlyingDecimals),plan.snapshot.block)/10n**10n;
        if(usdPriceE8<=0n)throw new Error('[YIELD_UNAVAILABLE] 生息標的價格未知');
        holdings.push({asset:p.market.asset,amountWei:p.claim,decimals:p.underlyingDecimals,usdPriceE8,priceSource:'pancakeswap-v3'});
      }
      return {...plan,snapshot:{...plan.snapshot,holdings}};
    },
    withdrawYield:async(due,plan,reserve,steps)=>{
      const {createYieldService}=await import('./yield-service.js');
      return createYieldService().tick({chainId,portfolioId:due.portfolioId,account:due.account},false,{plan,reserve,steps});
    },
    policy:async(due,plan,assets)=>{
      const publicClient=client(),blockNumber=plan.snapshot.block;
      const oracle=await publicClient.readContract({address:executor(),abi:EXECUTOR_ABI,functionName:'oracle',blockNumber});
      const buy=await readBuyBudget({publicClient,executor:executor(),oracle,account:due.account,blockNumber,targets:plan.targets});
      if('kind' in buy && buy.reason.includes('UNAVAILABLE'))throw new Error('[BUY_ALLOWANCE_UNAVAILABLE] 買入額度無法確認');
      const limits=await readMaxLegUsdE8(assets,query,chainId);
      const holding=plan.snapshot.holdings.find(h=>h.asset.toLowerCase()===numeraireFor(chainId));
      const reserve=await minimumFeeReserve(publicClient,executor(),BigInt(plan.pinnedVersion.onchainStrategyId),blockNumber,due.account,chainId===97);
      // Executor buyAllowance is already in numeraire raw units (18 decimals).
      const buyLimit='kind' in buy?0n:buy.remaining;
      const fee=Number(await publicClient.readContract({address:registry(),abi:[{type:'function',name:'effectiveFeeBps',stateMutability:'view',inputs:[{type:'uint256'}],outputs:[{type:'uint16'}]}],functionName:'effectiveFeeBps',args:[BigInt(plan.pinnedVersion.onchainStrategyId)],blockNumber}));
      const caps=new Map<string,bigint|null>();
      for(const asset of assets){
        const limit=limits.get(asset.toLowerCase());
        if(limit===undefined)throw new Error('asset capacity missing');
        const upper=limit===null?buyLimit:limit*10n**10n;
        caps.set(asset.toLowerCase(),await newMoneyDepthCap(publicClient,oracle,numeraireFor(chainId) as Address,asset as Address,upper,blockNumber,fee));
      }
      return {reserve,caps,buyLimit,
        cash:holding?.amountWei??0n};
    },
    verifyLots:async(lots)=>{
      // One header per distinct block, read concurrently (was one sequential getBlock per lot every round).
      const blocks=[...new Set(lots.map(lot=>lot.block_number))];
      const publicClient=client();
      const hashes=new Map(await Promise.all(blocks.map(async n=>[n,(await publicClient.getBlock({blockNumber:BigInt(n)})).hash?.toLowerCase()] as const)));
      for(const lot of lots)if(hashes.get(lot.block_number)!==lot.block_hash)throw new Error('[FUNDING_REORGED] 投入區塊需對帳');
    },
    quote:async(due,plan,inputs,deadline)=>{
      const publicClient=client();
      const block=await publicClient.getBlock({blockNumber:plan.snapshot.block});
      if(block.timestamp+1800n>deadline)deadline=block.timestamp+1800n;
      const oracle=await publicClient.readContract({address:executor(),abi:EXECUTOR_ABI,functionName:'oracle',blockNumber:plan.snapshot.block});
      return quoteNewMoney({publicClient,executor:executor(),registry:registry(),oracle,strategyId:BigInt(plan.pinnedVersion.onchainStrategyId),
        blockNumber:plan.snapshot.block,cash:numeraireFor(chainId) as Address,inputs,deadline});
    },
    feeDue:(due,plan)=>readFeeDue(client(),executor(),due.account,BigInt(plan.pinnedVersion.onchainStrategyId),plan.snapshot.block),
    marketOpen:(version,now)=>{
      // Typed automation is opened on 97 only. Stock identity comes from the admitted manifest, never client display symbols.
      if(chainId!==97)return false;
      return assetsMarketOpen(chainId,version.allocation.assets.filter(a=>a.weightBps>0).map(a=>a.address),now);
    },
  };
}
/** A local control error; its fixed message is safe to expose without RPC/DB details. */
export class PinnedVersionChangedError extends Error {
  constructor() { super('[PINNED_VERSION_CHANGED] 生效版本已變更；保留原本金與期次，等待轉版重排，不買入'); }
}

export async function prepareNewMoney(args:{due:DuePortfolio;plan:PortfolioPlan;query:SchedulerQueryFn;run:WithTransactionFn;
  chainId:number;now:Date;dryRun:boolean;deps:NewMoneyDeps}):Promise<{job:StrategyJob|null;context:JobContext;rebalance:RebalancePlan;useTargetWeights?:boolean;batchBudget?:InputVector}>{
  const {due,plan,query,run,chainId,now,deps}=args;
  if(due.version===undefined||plan.pinnedVersion.version!==due.version)throw new PinnedVersionChangedError();
  const version=await deps.version(due.strategyId,due.version,plan.pinnedVersion.onchainStrategyId,due.account,{chainId,blockNumber:plan.snapshot.block});
  if(version.execution.kind!=='hold'&&version.execution.kind!=='stack'&&version.execution.kind!=='per_asset')throw new Error('typed mode missing');
  const cash=numeraireFor(chainId) as Address;
  let assets=version.allocation.assets.filter(a=>a.weightBps>0&&a.address!==cash).map(a=>a.address);
  if(version.execution.kind==='per_asset'){
    const active=await readJob(query,{chainId,portfolioId:due.portfolioId});
    if(active)assets=Object.keys(active.remaining_input).filter(a=>BigInt(active.remaining_input[a]??'0')>0n);
    else {
      const eligible=await query(`select distinct a.asset from strategy_lot_assets a join strategy_funding_lots l on l.id=a.lot_id
        join strategy_versions v on (v.strategy_id,v.version)=(l.strategy_id,l.version),jsonb_array_elements(v.execution->'assets') e
        where l.chain_id=$1 and l.portfolio_id=$2 and l.strategy_id=$3 and l.version=$4 and l.state='confirmed' and l.kind='asset'
        and a.state='active' and e.value->>'asset'=a.asset and e.value ? 'execution'
        and (select count(*) from strategy_asset_slices s where s.lot_id=a.lot_id and s.asset=a.asset)<a.effective_slices
        and (a.first_slot_at is null or (a.first_slot_at+(select count(*) from strategy_asset_slices s where s.lot_id=a.lot_id and s.asset=a.asset)*case when e.value->'execution'->>'every'='daily' then interval '1 day' else interval '7 days' end<=$5 and $5<a.first_slot_at+a.effective_slices*case when e.value->'execution'->>'every'='daily' then interval '1 day' else interval '7 days' end))`,[chainId,due.portfolioId,due.strategyId,due.version,now]);
      assets=eligible.rows.map(row=>{if(typeof row!=='object'||row===null||!('asset' in row)||typeof row.asset!=='string')throw new Error('missing due asset');return row.asset;});
    }
  }
  const policy=assets.length===0?{reserve:0n,caps:new Map<string,bigint|null>(),buyLimit:0n,
    cash:plan.snapshot.holdings.find(h=>h.asset.toLowerCase()===cash)?.amountWei??0n}:await deps.policy(due,plan,assets);
  const batchStepLimit=executionBatchSize(plan.historicalAssetCount ?? version.allocation.assets.filter(a=>a.address!==cash).length);
  if(batchStepLimit===0)throw new Error('[USER_OP_CAPACITY] 無可行買入批次');
  const context:JobContext={...(due.personalMix ? { personalMix: true } : {}),batchStepLimit,chainId,portfolioId:due.portfolioId,strategyId:due.strategyId,version:due.version,kind:version.execution.kind==='per_asset'?'asset':version.execution.kind,
    ...(version.execution.kind==='per_asset'?{execution:version.execution,marketOpenFor:(selected:readonly string[])=>deps.marketOpen({...version,allocation:{assets:version.allocation.assets.filter(a=>selected.includes(a.address))}},now)}:{}),
    account:due.account,allocation:version.allocation,cash,now,reserve:policy.reserve,caps:policy.caps,buyLimit:policy.buyLimit,
    observedCash:policy.cash,enabled:due.scheduleState!=='paused',marketOpen:deps.marketOpen(version,now)};
  const lots=await fundingLots(query,context);
  // Existing sources also remain canonical after partial completion/restart.
  const prior=(await query(`select l.* from strategy_funding_lots l join strategy_job_lot_inputs i on i.lot_id=l.id
    join strategy_jobs j on j.id=i.job_id where j.chain_id=$1 and j.portfolio_id=$2 and j.state in ('reserved','running','unknown','paused')
    union select l.* from strategy_funding_lots l join strategy_asset_slices s on s.lot_id=l.id join strategy_jobs j on j.id=s.job_id where j.chain_id=$1 and j.portfolio_id=$2 and j.state in ('reserved','running','unknown','paused')`,[chainId,due.portfolioId])).rows as FundingLot[];
  await deps.verifyLots([...lots,...prior]);
  if(args.dryRun)return {job:null,context,rebalance:{kind:'blocked',reason:'[DRY_RUN_NEW_MONEY] 只讀檢查完成；未預留投入或期次，沒有送交易'}};
  context.withdrawals=await deps.withdrawals(due,plan);
  const prepared=await prepareStrategyJob(run,context,lots),job=prepared.job;
  if(!job&&version.execution.kind==='per_asset'&&version.execution.rebalance!=='none'&&context.enabled&&context.marketOpen){
    const balance=(await query('select unallocated_hold_raw::text,stack_prefund_raw::text,reserved_input_raw::text,reserved_fee_raw::text from strategy_cash_balances where chain_id=$1 and portfolio_id=$2',[chainId,due.portfolioId])).rows[0] as Record<string,string>|undefined;
    let waiting=balance&&Object.values(balance).some(n=>BigInt(n)>0n);
    const last=(await query("select coalesce(last_rebalance_at,(select min(created_at) from strategy_funding_lots where portfolio_id=$1 and state='confirmed')) as last_rebalance_at from portfolios where id=$1",[due.portfolioId])).rows[0] as {last_rebalance_at:Date|null}|undefined;
    const dueRebalance=yieldRebalanceDue(version.execution.rebalance,last?.last_rebalance_at??null,plan.report?.maxAbsDeltaBps??null,now);
    // Cash left behind by sources that have ended is not new money waiting to be bought: it joins this rebalance.
    if(waiting&&dueRebalance&&await freeEndedSourceCash(run,context))waiting=false;
    if(!waiting&&dueRebalance){
      context.reserve=await deps.rebalanceReserve(plan);
      return {job:null,context,useTargetWeights:true,rebalance:{kind:'noop',reason:'全hold基金設定再平衡'}};
    }
  }
  if(!job||job.state==='completed'||job.state==='paused'||!context.enabled||!(context.marketOpenFor?.(Object.keys(job.remaining_input))??context.marketOpen)||job.next_check_at>now){
    return {job,context,rebalance:{kind:'noop',reason:prepared.reason}};
  }
  if(job.kind==='asset')context.finalAssets=new Set((await query(`select distinct s.asset from strategy_asset_slices s join strategy_lot_assets a on (a.lot_id,a.asset)=(s.lot_id,s.asset) where s.job_id=$1 and s.slice_index=a.effective_slices-1`,[job.id])).rows.map(row=>{if(typeof row!=='object'||row===null||!('asset' in row)||typeof row.asset!=='string')throw new Error('invalid final source');return row.asset;}));
  // The same original vector survives new quotes, different prices and process restarts.
  const deadline=BigInt(Math.floor(now.getTime()/1000))+1800n;
  const feeBatches=policy.reserve===0n?sumInputs(job.remaining_input)/(50n*10n**18n):BigInt(job.remaining_fee_raw)/policy.reserve;
  const newMode=job.kind==='asset';
  const feeWindow=chainId===97;
  // Leftover fees are a funding ceiling, never additional principal or a credit
  // on every technical child. A new window still passes the fresh sender check.
  const reserve=feeWindow&&BigInt(job.remaining_fee_raw)<policy.reserve?BigInt(job.remaining_fee_raw):policy.reserve;
  context.reserve=reserve;
  const remaining=Object.fromEntries(Object.entries(job.remaining_input).filter(([,n])=>BigInt(n)>0n));
  const feeLeft=BigInt(job.remaining_fee_raw);
  // What is left, fee included, is under one minimum batch: no later round can change that (the fee only shrinks), so
  // waiting would hold the cash forever. Release it instead.
  if(newMode&&feeWindow&&sumInputs(remaining)+feeLeft<MIN_ASSET_BATCH_RAW)
    return releaseJob(run,context,job,'[BELOW_MIN_BATCH] 剩餘本金含費用不足10 USDT，已取消並退回可用現金');
  // Include held assets removed from the active version: snapshot targets contain
  // the full effective history. Match the scheduler so it never truncates this child.
  const held=plan.snapshot.holdings.filter(h=>h.amountWei>0n&&h.asset.toLowerCase()!==cash&&plan.targets.some(a=>a.asset.toLowerCase()===h.asset.toLowerCase())).length;
  const stepLimit=executionBatchSize(held);
  if(stepLimit===0)return {job,context,rebalance:{kind:'blocked',reason:'[USER_OP_CAPACITY] 估值已超過單筆容量'}};
  // The same rule for a remainder that needs several transactions (more assets than one UserOp carries): each of them
  // has to reach the minimum by itself. Counting the whole fee that is left, the remainder still cannot be split that
  // way, and only a send changes these numbers, so this used to report [BASKET_WAITING] every round for good.
  if(newMode&&feeWindow&&maximumRemainingBatches(remaining,feeLeft,feeLeft,stepLimit,context.finalAssets,true)<1n)
    return releaseJob(run,context,job,`[BELOW_MIN_BATCH] 剩餘本金 ${formatUnits(sumInputs(remaining),18)} USDT（${Object.keys(remaining).length} 個資產）湊不成每筆10 USDT的完整批次，已取消並退回可用現金`);
  const maximum=newMode?maximumRemainingBatches(remaining,BigInt(job.remaining_fee_raw),reserve,stepLimit,context.finalAssets,feeWindow):feeWindow?maxWindowBatches(remaining,reserve):maxBasketBatches(job.remaining_input,feeBatches);
  let count=newMode?newRemainingCount(remaining,policy.caps,policy.buyLimit,BigInt(job.remaining_fee_raw),reserve,stepLimit,context.finalAssets,feeWindow):feeWindow?windowBatchCountFor(remaining,reserve,policy.caps,policy.buyLimit):batchCountFor(job.remaining_input,policy.caps,policy.buyLimit,feeBatches);
  if(count===null)return {job,context,rebalance:{kind:'blocked',reason:'[BASKET_WAITING] 原向量無可行完整批次或費用預留'}};
  const minimumRound=newMode?MIN_ASSET_BATCH_RAW*BigInt(executionInputGroups(remaining,stepLimit,reserve,context.finalAssets,feeWindow)?.length??1):50n*10n**18n;
  for (;;) {
    const vector=feeWindow?windowBasketBatch(newMode?remaining:job.remaining_input,count,reserve,minimumRound):basketBatch(newMode?remaining:job.remaining_input,count);
    const inputs=newMode?executionInputGroups(vector,stepLimit,reserve,context.finalAssets,feeWindow)?.[0]??{}:vector;
    if(newMode&&sumInputs(inputs)+reserve<MIN_ASSET_BATCH_RAW)return {job,context,rebalance:{kind:'blocked',reason:'[BASKET_WAITING] 子批不足10 USDT'}};
    // The job's fee budget was sized for one fee window. A job that runs into later windows pays a top-up in each, so
    // a child can owe more than the fee that is left: the difference comes out of that child's own principal.
    let child=inputs,batchBudget:InputVector|undefined;
    context.reserve=reserve;
    if(feeWindow&&sumInputs(inputs)>0n){
      const fitted=await fitChildToFee(inputs,feeLeft,await deps.feeDue(due,plan),newMode?context.finalAssets:undefined);
      if(fitted===null){
        if(newMode)return releaseJob(run,context,job,'[FEE_OVER_BUDGET] 本批扣除最低費後低於每資產 1 USDT，已取消並退回可用現金');
        return {job,context,rebalance:{kind:'blocked',reason:'[MIN_FEE_RESERVE] 本批本金不足以支付最低費'}};
      }
      if(fitted.fromPrincipal>0n){child=fitted.inputs;batchBudget=inputs;context.reserve=feeLeft+fitted.fromPrincipal;}
    }
    const rebalance=await deps.quote(due,plan,child,deadline);
    if(rebalance.kind==='ready')return {job,context,...(batchBudget?{batchBudget}:{}),rebalance:{...rebalance,rationale:`${rebalance.rationale}；新錢分批：剩餘 ${sumInputs(newMode?remaining:job.remaining_input)} 分 ${count} 批、本批 ${sumInputs(child)}${batchBudget?`（另由本金支付最低費 ${sumInputs(inputs)-sumInputs(child)}）`:''}，買入額度 ${policy.buyLimit}`}};
    if(rebalance.kind!=='blocked'||!rebalance.reason.includes('[BASKET_DEPTH]')||count===maximum)return {job,context,rebalance};
    count=count*2n>maximum?maximum:count*2n;
  }
}

/**
 * Size one child so that what it buys plus the top-up it owes stays inside its own principal plus the job's remaining
 * fee. Unchanged when the fee left already covers the top-up. Null when the legs cannot give the difference.
 */
export async function fitChildToFee(inputs:InputVector,feeLeft:bigint,due:(notional:bigint)=>Promise<bigint>,finalAssets:ReadonlySet<string>|undefined):Promise<{inputs:InputVector;fromPrincipal:bigint}|null>{
  const principal=sumInputs(inputs);
  const fit=await principalWithinFee(principal,principal+feeLeft,due);
  if(fit===null)return null;
  if(fit.principal===principal)return {inputs,fromPrincipal:0n};
  // Per-asset children keep 1 USDT per leg (a final installment may be smaller); whole-basket children keep 5 USDT.
  const reduced=reduceInputs(inputs,principal-fit.principal,asset=>finalAssets===undefined?5n*USDT_UNIT:finalAssets.has(asset)?1n:USDT_UNIT);
  return reduced===null?null:{inputs:reduced,fromPrincipal:principal-fit.principal};
}
/**
 * A fund's configured rebalance stood still while any one-time cash sat outside allocated_cash_raw. Cash whose sources
 * have all ended (bought, skipped, or released and handed back: #273 / #275 / #276) is tied to no pending buy and
 * never leaves that bucket by itself, so such a fund kept the cash and never rebalanced again. When a rebalance is due
 * and nothing is left to buy, that cash becomes the fund's own free cash and the rebalance buys it back by the target
 * weights, as a private basket's own rebalance does (prepareMixTick). No source budget or period is rewritten and
 * nothing leaves this portfolio. While a source is still pending, new money is bought first, as before.
 */
async function freeEndedSourceCash(run:WithTransactionFn,context:JobContext):Promise<boolean>{
  return run(async({query})=>{
    await lockCash(query,context);
    if(await readJob(query,context))return false;
    if((await query(`select id from operations where portfolio_id=$1 and ${unresolvedSql} limit 1`,[context.portfolioId])).rows.length)return false;
    if((await query(`select 1 from strategy_funding_lots l where l.chain_id=$1 and l.portfolio_id=$2 and (l.state<>'confirmed'
      or exists(select 1 from strategy_lot_assets a where a.lot_id=l.id and a.state='active')
      or exists(select 1 from strategy_replan_assets a join strategy_replans r on r.id=a.replan_id where r.lot_id=l.id and a.state='active')) limit 1`,
      [context.chainId,context.portfolioId])).rows.length)return false;
    // Only the one-time bucket moves; a job's reservation or creator-scheduled prefunding left over means something is unsettled.
    return (await query(`update strategy_cash_balances set allocated_cash_raw=allocated_cash_raw+unallocated_hold_raw,unallocated_hold_raw=0,updated_at=clock_timestamp()
      where chain_id=$1 and portfolio_id=$2 and stack_prefund_raw=0 and reserved_input_raw=0 and reserved_fee_raw=0 returning portfolio_id`,
      [context.chainId,context.portfolioId])).rows.length===1;
  });
}
/** Cancel a job that can never send again and hand its remaining principal and fee back to the portfolio's free cash. */
async function releaseJob(run:WithTransactionFn,context:JobContext,job:StrategyJob,reason:string):Promise<{job:StrategyJob|null;context:JobContext;rebalance:RebalancePlan}>{
  const released=await run(async({query})=>{
    await lockCash(query,context);
    const current=await readJob(query,context);
    // Same job, same budgets, nothing in flight: otherwise leave it for the next round.
    if(!current||current.id!==job.id||!['reserved','running'].includes(current.state)||current.remaining_fee_raw!==job.remaining_fee_raw||
      JSON.stringify(current.remaining_input)!==JSON.stringify(job.remaining_input))return false;
    if((await query(`select id from operations where portfolio_id=$1 and ${unresolvedSql} limit 1`,[context.portfolioId])).rows.length)return false;
    await cancelJob(query,context,current);
    return true;
  });
  return released?{job:null,context,rebalance:{kind:'noop',reason}}:{job,context,rebalance:{kind:'blocked',reason:'[PREVIOUS_INFLIGHT] 原工作狀態已變更，下一輪再判斷'}};
}

/** Resume the frozen vector; fee leftovers never become new principal. */
function newRemainingCount(inputs:InputVector,caps:ReadonlyMap<string,bigint|null>,buyLimit:bigint,fee:bigint,reserve:bigint,stepLimit:number,finalAssets:ReadonlySet<string>=new Set(),feeWindow=false):bigint|null{
  const maximum=maximumRemainingBatches(inputs,fee,reserve,stepLimit,finalAssets,feeWindow);
  if(maximum<1n||buyLimit<=0n)return null;
  const minimumRound=MIN_ASSET_BATCH_RAW*BigInt(executionInputGroups(inputs,stepLimit,reserve,finalAssets,feeWindow)?.length??1);
  const fits=(k:bigint)=>{if(feeWindow)return windowCapacityFits(inputs,k,reserve,caps,buyLimit,minimumRound);const batch=basketBatch(inputs,k);return sumInputs(batch)<=buyLimit&&Object.entries(batch).every(([a,v])=>{if(!caps.has(a))throw new Error('missing capacity');const cap=caps.get(a);return cap===null||(cap!==undefined&&BigInt(v)<=cap);});};
  if(!fits(maximum))return null;
  let low=1n,high=maximum;while(low<high){const mid=(low+high)/2n;if(fits(mid))high=mid;else low=mid+1n;}
  return low;
}

function maximumRemainingBatches(inputs:InputVector,fee:bigint,reserve:bigint,stepLimit:number,finalAssets:ReadonlySet<string>=new Set(),feeWindow=false):bigint{
  const total=sumInputs(inputs),U=10n**18n;
  let maximum=(total+(feeWindow?reserve:fee))/MIN_ASSET_BATCH_RAW;
  const groups=executionInputGroups(inputs,stepLimit,reserve,finalAssets,feeWindow);
  if(!groups)return 0n;
  if(feeWindow)maximum/=BigInt(groups.length);
  const groupReserve=reserve*BigInt(groups.length);
  if(!feeWindow&&groupReserve>0n&&fee/groupReserve<maximum)maximum=fee/groupReserve;
  for(const [asset,value] of Object.entries(inputs)){const n=BigInt(value)/(finalAssets.has(asset)?1n:U);if(n<maximum)maximum=n;}
  return maximum;
}
