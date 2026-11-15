import type { Address, PublicClient } from 'viem';
import { EXECUTOR_ABI } from './chain.js';
import { requireTypedVersion } from './strategies.js';
import type { StrategyVersion } from './strategies.js';
import { numeraireFor } from './strategy-execution.js';
import { basketBatch, batchCountFor, maxBasketBatches, sumInputs } from './new-money-plan.js';
import type { InputVector } from './new-money-plan.js';
import { fundingLots, prepareStrategyJob, readJob } from './strategy-jobs.js';
import type { FundingLot, JobContext, StrategyJob } from './strategy-jobs.js';
import { minimumFeeReserve, quoteNewMoney, readBuyBudget, readMaxLegUsdE8, newMoneyDepthCap } from './rebalance-plan.js';
import type { RebalancePlan } from './rebalance-plan.js';
import type { DuePortfolio, SchedulerQueryFn, WithTransactionFn } from './scheduler.js';
import type { PortfolioPlan } from './snapshot.js';
import { stockMarketOpen } from './trading-calendar.js';
import { TESTNET_ASSETS } from './keeper/assets.js';
import { testnetAssets } from './testnet-profile.js';

export type NewMoneyPolicy = { reserve: bigint; caps: Map<string,bigint|null>; buyLimit: bigint; cash: bigint };
export type NewMoneyDeps = {
  version: typeof requireTypedVersion;
  policy: (due:DuePortfolio,plan:PortfolioPlan,assets:readonly string[])=>Promise<NewMoneyPolicy>;
  verifyLots: (lots:readonly FundingLot[])=>Promise<void>;
  quote: (due:DuePortfolio,plan:PortfolioPlan,inputs:InputVector,deadline:bigint)=>Promise<RebalancePlan>;
  marketOpen: (version:StrategyVersion,now:Date)=>boolean;
};
export function defaultNewMoneyDeps(client:()=>PublicClient,executor:()=>Address,registry:()=>Address,query:SchedulerQueryFn,chainId:number):NewMoneyDeps {
  return {
    version:requireTypedVersion,
    policy:async(due,plan,assets)=>{
      const publicClient=client(),blockNumber=plan.snapshot.block;
      const oracle=await publicClient.readContract({address:executor(),abi:EXECUTOR_ABI,functionName:'oracle',blockNumber});
      const buy=await readBuyBudget({publicClient,executor:executor(),oracle,account:due.account,blockNumber,targets:plan.targets});
      if('kind' in buy && buy.reason.includes('UNAVAILABLE'))throw new Error('[BUY_ALLOWANCE_UNAVAILABLE] 買入額度無法確認');
      const limits=await readMaxLegUsdE8(assets,query,chainId);
      const holding=plan.snapshot.holdings.find(h=>h.asset.toLowerCase()===numeraireFor(chainId));
      const reserve=await minimumFeeReserve(publicClient,executor(),BigInt(plan.pinnedVersion.onchainStrategyId),blockNumber);
      const buyLimit='kind' in buy?0n:buy.remaining*10n**10n;
      const caps=new Map<string,bigint|null>();
      for(const asset of assets){
        const limit=limits.get(asset.toLowerCase());
        if(limit===undefined)throw new Error('asset capacity missing');
        const upper=limit===null?buyLimit:limit*10n**10n;
        caps.set(asset.toLowerCase(),await newMoneyDepthCap(publicClient,oracle,numeraireFor(chainId) as Address,asset as Address,upper,blockNumber));
      }
      return {reserve,caps,buyLimit,
        cash:holding?.amountWei??0n};
    },
    verifyLots:async(lots)=>{
      for(const lot of lots){
        const block=await client().getBlock({blockNumber:BigInt(lot.block_number)});
        if(block.hash?.toLowerCase()!==lot.block_hash)throw new Error('[FUNDING_REORGED] 投入區塊需對帳');
      }
    },
    quote:async(due,plan,inputs,deadline)=>{
      const publicClient=client();
      const block=await publicClient.getBlock({blockNumber:plan.snapshot.block});
      if(block.timestamp+1800n>deadline)deadline=block.timestamp+1800n;
      const oracle=await publicClient.readContract({address:executor(),abi:EXECUTOR_ABI,functionName:'oracle',blockNumber:plan.snapshot.block});
      return quoteNewMoney({publicClient,executor:executor(),registry:registry(),oracle,strategyId:BigInt(plan.pinnedVersion.onchainStrategyId),
        blockNumber:plan.snapshot.block,cash:numeraireFor(chainId) as Address,inputs,deadline});
    },
    marketOpen:(version,now)=>{
      // Typed automation is opened on 97 only. Stock identity comes from the admitted manifest, never client display symbols.
      if(chainId!==97)return false;
      const stocks:ReadonlySet<string>=new Set(TESTNET_ASSETS.filter(a=>!a.hasFeed && a.symbol!=='XAUt').map(a=>a.symbol));
      const stockAddresses:ReadonlySet<string>=new Set(testnetAssets().filter(a=>stocks.has(a.symbol)).map(a=>a.address));
      return !version.allocation.assets.some(a=>a.weightBps>0&&stockAddresses.has(a.address))||stockMarketOpen(now);
    },
  };
}
export async function prepareNewMoney(args:{due:DuePortfolio;plan:PortfolioPlan;query:SchedulerQueryFn;run:WithTransactionFn;
  chainId:number;now:Date;dryRun:boolean;deps:NewMoneyDeps}):Promise<{job:StrategyJob|null;context:JobContext;rebalance:RebalancePlan;useTargetWeights?:boolean}>{
  const {due,plan,query,run,chainId,now,deps}=args;
  if(due.version===undefined||plan.pinnedVersion.version!==due.version)throw new Error('[PINNED_VERSION_CHANGED] 版本需先對帳');
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
  const context:JobContext={chainId,portfolioId:due.portfolioId,strategyId:due.strategyId,version:due.version,kind:version.execution.kind==='per_asset'?'asset':version.execution.kind,
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
  const prepared=await prepareStrategyJob(run,context,lots),job=prepared.job;
  if(!job&&version.execution.kind==='per_asset'&&version.execution.rebalance!=='none'&&context.enabled&&context.marketOpen){
    const balance=(await query('select unallocated_hold_raw::text,stack_prefund_raw::text,reserved_input_raw::text,reserved_fee_raw::text from strategy_cash_balances where chain_id=$1 and portfolio_id=$2',[chainId,due.portfolioId])).rows[0] as Record<string,string>|undefined;
    const waiting=balance&&Object.values(balance).some(n=>BigInt(n)>0n);
    const last=(await query('select last_rebalance_at from portfolios where id=$1',[due.portfolioId])).rows[0] as {last_rebalance_at:Date|null}|undefined;
    const monthly=version.execution.rebalance==='monthly'&&last?.last_rebalance_at!=null&&
      (last.last_rebalance_at.getUTCFullYear()!==now.getUTCFullYear()||last.last_rebalance_at.getUTCMonth()!==now.getUTCMonth());
    const drift=version.execution.rebalance==='drift'&&(plan.report?.maxAbsDeltaBps??0)>500;
    if(!waiting&&(monthly||drift))return {job:null,context,useTargetWeights:true,rebalance:{kind:'noop',reason:'全hold基金設定再平衡'}};
  }
  if(!job||job.state==='completed'||job.state==='paused'||!context.enabled||!(context.marketOpenFor?.(Object.keys(job.remaining_input))??context.marketOpen)||job.next_check_at>now){
    return {job,context,rebalance:{kind:'noop',reason:prepared.reason}};
  }
  // The same original vector survives new quotes, different prices and process restarts.
  const deadline=BigInt(Math.floor(now.getTime()/1000))+1800n;
  const feeBatches=policy.reserve===0n?sumInputs(job.remaining_input)/(50n*10n**18n):BigInt(job.remaining_fee_raw)/policy.reserve;
  const newMode=job.kind==='asset';
  const maximum=newMode?feeBatches:maxBasketBatches(job.remaining_input,feeBatches);
  let count=newMode?newRemainingCount(job.remaining_input,policy.caps,policy.buyLimit,BigInt(job.remaining_fee_raw),policy.reserve):batchCountFor(job.remaining_input,policy.caps,policy.buyLimit,feeBatches);
  if(count===null)return {job,context,rebalance:{kind:'blocked',reason:'[BASKET_WAITING] 原向量無可行完整批次或費用預留'}};
  for (;;) {
    const inputs=basketBatch(job.remaining_input,count);
    const rebalance=await deps.quote(due,plan,inputs,deadline);
    if(rebalance.kind==='ready')return {job,context,rebalance};
    if(rebalance.kind!=='blocked'||!rebalance.reason.includes('[BASKET_DEPTH]')||count===maximum)return {job,context,rebalance};
    count=count*2n>maximum?maximum:count*2n;
  }
}

/** Resume the frozen vector; fee leftovers never become new principal. */
function newRemainingCount(inputs:InputVector,caps:ReadonlyMap<string,bigint|null>,buyLimit:bigint,fee:bigint,reserve:bigint):bigint|null{
  const total=sumInputs(inputs),U=10n**18n;
  let maximum=(total+fee)/(50n*U);
  if(reserve>0n&&fee/reserve<maximum)maximum=fee/reserve;
  for(const v of Object.values(inputs)){if(BigInt(v)/U<maximum)maximum=BigInt(v)/U;}
  if(maximum<1n||buyLimit<=0n)return null;
  const fits=(k:bigint)=>{const batch=basketBatch(inputs,k);return sumInputs(batch)<=buyLimit&&Object.entries(batch).every(([a,v])=>{if(!caps.has(a))throw new Error('missing capacity');const cap=caps.get(a);return cap===null||(cap!==undefined&&BigInt(v)<=cap);});};
  if(!fits(maximum))return null;
  let low=1n,high=maximum;while(low<high){const mid=(low+high)/2n;if(fits(mid))high=mid;else low=mid+1n;}
  return low;
}
