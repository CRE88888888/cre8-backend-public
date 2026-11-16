import type { PoolClient } from 'pg';
import { encodeAbiParameters, keccak256, toFunctionSelector } from 'viem';
import type { Address, Hex } from 'viem';
import { withTransaction, query } from './db.js';
import { canonicalKernelCalls, gasExecutionKey, reserveSponsorship } from './paymaster.js';
import type { Reservation } from './paymaster.js';
import { address, hash, isSource, object, raw, restoreSourceHistory, unavailable } from './yield-domain.js';
import type { YieldRead, YieldSources, YieldPosition, YieldRisk, SourceHistoryEvent } from './yield-domain.js';
import { stackLiquidityReserve } from './yield-prefund.js';
import { writeYieldState } from './yield-runtime-state.js';
import type { YieldStateQuery } from './yield-runtime-state.js';
import type { SavedYieldOperation, YieldEvidence, YieldOperationJournal, YieldPlan, YieldPrepare, YieldReceiptResult } from './yield-port.js';

export type YieldAccount = { portfolioId: number; chainId: number; account: Address };
export type YieldStoreDeps = { transaction: typeof withTransaction; query: typeof query };
export const storeDefaults: YieldStoreDeps = { transaction: withTransaction, query };
export async function yieldLocks(client: PoolClient, p: YieldAccount): Promise<void> {
  await client.query('set transaction isolation level read committed');
  await client.query("set local lock_timeout='3s'");
  await client.query(`insert into strategy_cash_balances(chain_id,portfolio_id,account) values($1,$2,$3)
    on conflict(chain_id,portfolio_id) do nothing`, [p.chainId, p.portfolioId, p.account]);
  await client.query('select portfolio_id from strategy_cash_balances where chain_id=$1 and portfolio_id=$2 for update', [p.chainId, p.portfolioId]);
  // Lock the complete registered universe: retirement, version changes and shared groups survive.
  await client.query('select market_id from yield_markets where chain_id=$1 order by market_id for update', [p.chainId]);
  await client.query('select risk_key from yield_risk_buckets where chain_id=$1 order by risk_key for update', [p.chainId]);
  await client.query('select market_id from yield_positions where chain_id=$1 and portfolio_id=$2 order by market_id for update', [p.chainId, p.portfolioId]);
  await client.query('select execution_key from yield_actions where chain_id=$1 and portfolio_id=$2 order by execution_key for update', [p.chainId, p.portfolioId]);
}
export async function writeYieldRisk(client: PoolClient, chainId: number, r: YieldRisk): Promise<void> {
  await client.query(`insert into yield_risk_snapshots(chain_id,risk_key,block_number,block_hash,observed_at,source,configuration_hash,state,reason,
    supply_raw,liquidity_raw,exposure_raw,external_reserved_raw,supply_headroom_raw,utilization_bps)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
  [chainId, r.key, r.block.toString(), r.blockHash, r.at, r.source, r.configuration, r.state, r.reason,
    r.supply?.toString() ?? null, r.liquidity?.toString() ?? null, r.exposure?.toString() ?? null, r.externalReserved?.toString() ?? null, r.headroom?.toString() ?? null, r.utilizationBps]);
}
export async function writeYieldPosition(client: PoolClient, p: YieldAccount, s: YieldPosition): Promise<void> {
  await client.query(`insert into yield_positions(chain_id,portfolio_id,account,market_id) values($1,$2,$3,$4) on conflict do nothing`, [p.chainId, p.portfolioId, p.account, s.market.marketId]);
  const result = await client.query<{ id: string }>(`insert into yield_position_snapshots(chain_id,portfolio_id,market_id,block_number,block_hash,observed_at,source,
    receipt_raw,observed_units_raw,tracked_units_raw,claim_assets_raw,max_withdraw_raw,max_redeem_raw,value_usdt_raw,rate_raw,rate_scale,valuation_state,reason)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning id`,
  [p.chainId, p.portfolioId, s.market.marketId, s.block.toString(), s.blockHash, s.at, s.source, s.receipt?.toString() ?? null,
    s.observedUnits?.toString() ?? null, s.trackedUnits?.toString() ?? null, s.claim?.toString() ?? null, s.maxWithdraw?.toString() ?? null,
    s.maxRedeem?.toString() ?? null, s.value?.toString() ?? null, s.rate?.toString() ?? null, s.scale?.toString() ?? null, s.state, s.reason]);
  const id = result.rows[0]?.id; if (!id) throw unavailable();
  await client.query(`update yield_positions set latest_snapshot_id=$4,
    receipt_raw=case when $5::numeric is null then receipt_raw else $5::numeric end,
    tracked_units_raw=case when $6::numeric is null then tracked_units_raw else $6::numeric end,updated_at=clock_timestamp()
    where chain_id=$1 and portfolio_id=$2 and market_id=$3`, [p.chainId, p.portfolioId, s.market.marketId, id,
    s.state === 'known' ? s.receipt?.toString() : null, s.state === 'known' ? s.trackedUnits?.toString() : null]);
}
/** Call under the shared account lock. An unauthenticated identity never creates an admitted market. */
export async function persistYieldRead(p: YieldAccount, read: YieldRead, deps = storeDefaults): Promise<void> {
  await deps.transaction(async client => {
    await yieldLocks(client, p);
    await writeYieldCatalog(client,read);
    for (const s of read.positions) {
      if((await client.query('select market_id from yield_markets where chain_id=$1 and market_id=$2',[p.chainId,s.market.marketId])).rows.length) await writeYieldPosition(client,p,s);
    }
    for (const r of [...read.risks].sort((a,b)=>a.key.localeCompare(b.key))) {
      if ((await client.query('select risk_key from yield_risk_buckets where chain_id=$1 and risk_key=$2',[p.chainId,r.key])).rows.length) await writeYieldRisk(client,p.chainId,r);
    }
  });
}
async function writeYieldCatalog(client:PoolClient,read:YieldRead){
    for (const s of [...read.positions].sort((a,b) => a.market.marketId.localeCompare(b.market.marketId))) {
      const m = s.market, group = read.risks.find(r => r.asset === m.asset && r.protocol === m.protocol && r.underlyingMarketId === null);
      const exists = (await client.query('select market_id from yield_markets where chain_id=$1 and market_id=$2', [read.profile.chainId, m.marketId])).rows.length > 0;
      if (!exists && (!group || s.state !== 'known' || s.aprBps === null)) continue;
      if (!exists && group) {
        await client.query(`insert into strategy_asset_yield_markets(chain_id,asset,market_id,enabled) values($1,$2,$3,false) on conflict do nothing`, [read.profile.chainId,m.asset,m.id]);
        await client.query(`insert into yield_markets(chain_id,market_id,platform_market_id,protocol,underlying,receipt,target,risk_source,underlying_decimals,receipt_decimals,is_simulated,simulated_apr_bps,state)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [read.profile.chainId,m.marketId,m.id,m.protocol,m.asset,m.receipt,m.target,group.riskSource,s.underlyingDecimals,s.receiptDecimals,m.simulated,
          s.aprBps === null ? null : Number(s.aprBps),s.retired?'retired':s.supplyOpen ? 'active':'paused']);
      }
      if (group) for (const r of read.risks.filter(r => r.asset === m.asset && r.protocol === m.protocol && r.riskSource === group.riskSource)) {
        await client.query(`insert into yield_risk_buckets(chain_id,risk_key,protocol,underlying,risk_source,underlying_market_id) values($1,$2,$3,$4,$5,$6) on conflict do nothing`, [read.profile.chainId,r.key,r.protocol,r.asset,r.riskSource,r.underlyingMarketId]);
        await client.query(`insert into yield_market_risks(chain_id,market_id,risk_key,protocol,underlying,enabled) values($1,$2,$3,$4,$5,$6) on conflict(chain_id,market_id,risk_key) do update set enabled=yield_market_risks.enabled or excluded.enabled,updated_at=clock_timestamp()`, [read.profile.chainId,m.marketId,r.key,m.protocol,m.asset,group.state==='known']);
      }
      if(group?.state==='known'){
        const keys=read.risks.filter(r=>r.asset===m.asset&&r.protocol===m.protocol&&r.riskSource===group.riskSource).map(r=>r.key);
        await client.query('update yield_market_risks set enabled=false,updated_at=clock_timestamp() where chain_id=$1 and market_id=$2 and enabled and not(risk_key=any($3::text[]))',[read.profile.chainId,m.marketId,keys]);
      }
      // Never revive a retired DB market from a temporary RPC observation.
      await client.query(`update yield_markets set state=case when state='retired' then state else $3 end,simulated_apr_bps=coalesce($4,simulated_apr_bps),updated_at=clock_timestamp() where chain_id=$1 and market_id=$2`, [read.profile.chainId,m.marketId,s.retired?'retired':s.supplyOpen?'active':'paused',s.aprBps===null?null:Number(s.aprBps)]);
      await client.query(`update strategy_asset_yield_markets set enabled=$4,updated_at=clock_timestamp() where chain_id=$1 and asset=$2 and market_id=$3`, [read.profile.chainId,m.asset,m.id,s.supplyOpen && s.state==='known']);
    }
}
export async function syncYieldCatalog(read:YieldRead,deps=storeDefaults):Promise<void>{
  await deps.transaction(async client=>{
    await client.query("set local lock_timeout='3s'");
    await client.query('select market_id from yield_markets where chain_id=$1 order by market_id for update',[read.profile.chainId]);
    await client.query('select risk_key from yield_risk_buckets where chain_id=$1 order by risk_key for update',[read.profile.chainId]);
    await writeYieldCatalog(client,read);
  });
}
function publicPlan(p: YieldPlan) {
  return { executor:p.executor,yieldRegistry:p.yieldRegistry,asset:p.asset,receipt:p.receipt,amount:p.amount.toString(),minimum:p.minimum.toString(),
    deadline:p.deadline.toString(),data:p.data,marketId:p.marketId,kind:p.kind,...(p.scaledReceiptBalance===undefined?{}:{scaledReceiptBalance:p.scaledReceiptBalance.toString()}) };
}
export type SnapshotRow = { execution_key: string; chain_id: string; account: string; plan_json: unknown; kernel_call_data: Hex;
  quote_block_number: string; quote_block_hash: Hex; asset_balance_raw: string; receipt_balance_raw: string; user_op_hash: Hex | null; nonce: string | null };
export function restoreYieldOperation(row: SnapshotRow): SavedYieldOperation {
  const v=object(row.plan_json);
  if(row.chain_id!=='97'||!row.user_op_hash||row.nonce===null||(v.kind!=='supply'&&v.kind!=='withdraw')||typeof v.data!=='string'||!/^0x(?:[0-9a-fA-F]{2})+$/.test(v.data))throw unavailable();
  const plan:YieldPlan={chainId:97,account:address(row.account),executor:address(v.executor),yieldRegistry:address(v.yieldRegistry),asset:address(v.asset),receipt:address(v.receipt),
    amount:raw(v.amount),minimum:raw(v.minimum),deadline:raw(v.deadline),data:`0x${v.data.slice(2)}`,kind:v.kind,marketId:hash(v.marketId),quoteBlock:raw(row.quote_block_number),quoteBlockHash:hash(row.quote_block_hash),
    assetBalance:raw(row.asset_balance_raw),receiptBalance:raw(row.receipt_balance_raw),...(v.scaledReceiptBalance===undefined?{}:{scaledReceiptBalance:raw(v.scaledReceiptBalance)})};
  const selector=toFunctionSelector(plan.kind==='supply'?'executeSupply(address,bytes32,uint256,uint256,uint256)':'executeWithdraw(address,bytes32,uint256,uint256,uint256)');
  const encoded=encodeAbiParameters([{type:'address'},{type:'bytes32'},{type:'uint256'},{type:'uint256'},{type:'uint256'}],[plan.account,plan.marketId,plan.amount,plan.minimum,plan.deadline]);
  if(plan.data.toLowerCase()!==selector+encoded.slice(2))throw unavailable();
  const call=canonicalKernelCalls(row.kernel_call_data);
  if(call.length!==1||call[0]?.target.toLowerCase()!==plan.executor||call[0]?.value!==0n||call[0]?.callData.toLowerCase()!==plan.data.toLowerCase()||plan.amount===0n||plan.minimum===0n)throw unavailable();
  return {plan,callData:row.kernel_call_data,nonce:raw(row.nonce),userOpHash:hash(row.user_op_hash)};
}
export type SettlementRead = { read: YieldRead; logIndex: number; blockNumber: bigint; blockHash: Hex; occurredAt: Date };
export type JournalContext = YieldAccount & { cashAsset: Address; consentId: string | null; exitRequestId: string | null; sources: YieldSources;
  prefundWithdrawal?: { requiredRaw: string; liquidRaw: string; targetRaw: string };
  reserve: () => Reservation | null; validate: (input:YieldPrepare)=>Promise<void>; settlement:(plan:YieldPlan,evidence:YieldEvidence)=>Promise<SettlementRead> };
export function createYieldJournal(context:JournalContext,overrides:Partial<YieldStoreDeps>={}):YieldOperationJournal {
  const deps={...storeDefaults,...overrides},p=context;
  async function saved(key:string):Promise<SavedYieldOperation>{
    const row=(await deps.query<SnapshotRow>('select * from yield_execution_snapshots where execution_key=$1',[key])).rows[0];
    if(!row||row.account!==p.account||Number(row.chain_id)!==p.chainId)throw unavailable();return restoreYieldOperation(row);
  }
  async function update(key:string,state:'submitted'|'unknown',userOpHash?:Hex){
    await deps.transaction(async client=>{
      await yieldLocks(client,p);
      const action=(await client.query<{state:string}>('select state from yield_actions where execution_key=$1 and portfolio_id=$2',[key,p.portfolioId])).rows[0];
      if(!action)throw unavailable();if(['confirmed','released'].includes(action.state))return;
      const original=(await client.query<{user_op_hash:Hex|null}>('select user_op_hash from operations where yield_execution_key=$1',[key])).rows[0];
      if(!original||userOpHash&&original.user_op_hash!==userOpHash)throw unavailable();
      // unknown never returns to submitted; hashes and original pending payload remain immutable.
      const next=action.state==='unknown'?'unknown':state;
      if(original.user_op_hash)await client.query(`update operations set state='submitted',updated_at=clock_timestamp() where yield_execution_key=$1 and state in ('pending','submitted')`,[key]);
      await client.query('update yield_actions set state=$2,updated_at=clock_timestamp() where execution_key=$1',[key,next]);
      await gasState(client,key,next==='unknown'?'unknown':'submitted');
    });
  }
  return {
    prepare:async(input)=>{
      await context.validate(input);
      const {plan,executionKey:key}=input,r=context.reserve();
      if(!r||r.budget.executionKey!==key||r.budget.purpose!==(plan.kind==='supply'?'ordinary':'exit')||r.hash!==input.userOpHash||r.op.nonce!==input.nonce||r.op.callData!==input.callData||
        plan.account!==p.account||plan.chainId!==p.chainId||gasExecutionKey(plan.chainId,r.op)!==key)throw unavailable();
      // Validate unsigned public evidence BEFORE any database work. No signatures enter JSON.
      restoreYieldOperation({execution_key:key,chain_id:'97',account:p.account,plan_json:publicPlan(plan),kernel_call_data:input.callData,quote_block_number:plan.quoteBlock.toString(),
        quote_block_hash:plan.quoteBlockHash,asset_balance_raw:plan.assetBalance.toString(),receipt_balance_raw:plan.receiptBalance.toString(),user_op_hash:input.userOpHash,nonce:input.nonce.toString()});
      return deps.transaction(async client=>{
        await yieldLocks(client,p);
        const prior=(await client.query<SnapshotRow>('select * from yield_execution_snapshots where execution_key=$1',[key])).rows[0];
        if(prior){const s=restoreYieldOperation(prior);if(JSON.stringify(publicPlan(s.plan))!==JSON.stringify(publicPlan(plan))||s.callData!==input.callData||s.nonce!==input.nonce||s.userOpHash!==input.userOpHash)throw unavailable();throw unavailable();}
        // Existing paymaster API, injected transaction: site/day, account/day, sponsorship and gas share THIS commit.
        if(await reserveSponsorship(r,async fn=>fn(client))!==r.validUntil)throw unavailable();
        await client.query(`insert into yield_actions(execution_key,chain_id,portfolio_id,account,market_id,kind,amount_raw,minimum_output_raw,source_breakdown,consent_id,exit_request_id)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[key,p.chainId,p.portfolioId,p.account,plan.marketId,plan.kind,plan.amount.toString(),plan.minimum.toString(),JSON.stringify(context.sources),context.consentId,context.exitRequestId]);
        if(context.prefundWithdrawal){
          const intent=context.prefundWithdrawal,required=raw(intent.requiredRaw),liquid=raw(intent.liquidRaw),target=raw(intent.targetRaw);
          const basis=(await readPrefundPositions((sql,params)=>client.query(sql,params?[...params]:[]),p.chainId,p.portfolioId)).find(b=>b.marketId===plan.marketId);
          if(plan.kind!=='withdraw'||plan.asset!==context.cashAsset||required<=liquid||target===0n||target>required-liquid||!basis||target>basis.principal)throw unavailable();
          await writeYieldState(prefundIntentKey(key),{purpose:'prefund_shortfall',executionKey:key,chainId:p.chainId,portfolioId:p.portfolioId,marketId:plan.marketId,...intent},
            (sql,params)=>client.query(sql,params?[...params]:[]));
        }
        if(plan.kind==='supply')await reopenCompleted(client,p,plan.marketId);
        if(plan.kind==='supply'&&plan.asset===context.cashAsset){
          const prefund=raw(context.sources.stack_prefund_raw??'0');
          if(prefund>0n){
            const reserve=await stackLiquidityReserve((sql,params)=>client.query(sql,params?[...params]:[]),p.chainId,p.portfolioId,new Date());
            const cash=(await client.query<{stack_prefund_raw:string}>('select stack_prefund_raw::text from strategy_cash_balances where chain_id=$1 and portfolio_id=$2',[p.chainId,p.portfolioId])).rows[0];
            if(reserve===null||!cash||raw(cash.stack_prefund_raw)<reserve+prefund)throw unavailable();
          }
          for(const [source,amount]of Object.entries(context.sources)){
            if(!isSource(source)||source==='asset_holding')throw unavailable();
            const changed=await client.query(`update strategy_cash_balances set ${source}=${source}-$3::numeric,updated_at=clock_timestamp() where chain_id=$1 and portfolio_id=$2 and ${source}>=$3::numeric returning portfolio_id`,[p.chainId,p.portfolioId,amount]);
            if(changed.rows.length!==1)throw unavailable();
          }
        }
        await client.query(`insert into operations(portfolio_id,type,state,idempotency_key,payload_hash,attempts,deadline,user_op_nonce,user_op_hash,yield_execution_key)
          values($1,$2,'pending',$3,$4,1,$5,$6,$7,$3)`,[p.portfolioId,`yield_${plan.kind}`,key,keccak256(plan.data),new Date(Number(plan.deadline)*1000),input.nonce.toString(),input.userOpHash]);
        await client.query(`insert into yield_execution_snapshots(execution_key,chain_id,account,yield_action_id,plan_json,kernel_call_data,quote_block_number,quote_block_hash,asset_balance_raw,receipt_balance_raw,user_op_hash,nonce)
          values($1,$2,$3,$1,$4,$5,$6,$7,$8,$9,$10,$11)`,[key,p.chainId,p.account,JSON.stringify(publicPlan(plan)),input.callData,plan.quoteBlock.toString(),plan.quoteBlockHash,plan.assetBalance.toString(),plan.receiptBalance.toString(),input.userOpHash,input.nonce.toString()]);
        return key;
      });
    },
    sending:async key=>update(key,'unknown'),
    submitted:async(key,h)=>update(key,'submitted',h),
    unknown:async key=>update(key,'unknown'),
    confirmed:async(key,evidence)=>{
      const original=await saved(key);if(original.userOpHash!==evidence.userOpHash)throw unavailable();
      const proof=await context.settlement(original.plan,evidence);
      const position=proof.read.positions.find(s=>s.market.marketId===original.plan.marketId);
      if(!position||position.state!=='known'||position.receipt!==evidence.remainingReceipts||proof.blockHash!==position.blockHash||proof.blockNumber!==position.block)throw unavailable();
      await deps.transaction(async client=>{
        await yieldLocks(client,p);
        const action=(await client.query<{state:string}>('select state from yield_actions where execution_key=$1',[key])).rows[0];
        if(action?.state==='confirmed'){
          const prior=(await client.query<{tx_hash:string;log_index:string;block_hash:string;assets_raw:string;shares_raw:string;remaining_receipts_raw:string}>('select tx_hash,log_index::text,block_hash,assets_raw::text,shares_raw::text,remaining_receipts_raw::text from yield_events where execution_key=$1',[key])).rows[0];
          if(!prior||prior.tx_hash!==evidence.txHash||prior.log_index!==String(proof.logIndex)||prior.block_hash!==proof.blockHash||prior.assets_raw!==evidence.assets.toString()||prior.shares_raw!==evidence.shares.toString()||prior.remaining_receipts_raw!==evidence.remainingReceipts.toString())throw unavailable();
          return;
        }
        if(!action||action.state==='released')throw unavailable();
        await client.query(`insert into yield_events(chain_id,tx_hash,log_index,execution_key,portfolio_id,account,market_id,kind,assets_raw,shares_raw,remaining_receipts_raw,block_number,block_hash,occurred_at)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[p.chainId,evidence.txHash,proof.logIndex,key,p.portfolioId,p.account,original.plan.marketId,original.plan.kind,
          evidence.assets.toString(),evidence.shares.toString(),evidence.remainingReceipts.toString(),proof.blockNumber.toString(),proof.blockHash,proof.occurredAt]);
        if(original.plan.kind==='supply')await reopenCompleted(client,p,original.plan.marketId);
        await writeYieldPosition(client,p,position);
        for(const r of [...proof.read.risks].sort((a,b)=>a.key.localeCompare(b.key)))await writeYieldRisk(client,p.chainId,r);
        if(original.plan.kind==='withdraw')await creditRedemption(client,p,original.plan.marketId);
        await client.query(`update operations set state='confirmed',tx_hash=$2,user_op_hash=$3,updated_at=clock_timestamp() where yield_execution_key=$1`,[key,evidence.txHash,evidence.userOpHash]);
        await client.query(`update yield_actions set state='confirmed',resolution='success_event',resolution_evidence=$2,updated_at=clock_timestamp() where execution_key=$1`,[key,evidence.txHash]);
        await gasState(client,key,'confirmed');
      });
    },
    reverted:async(key,evidence:Extract<YieldReceiptResult,{status:'reverted'}>)=>{
      const original=await saved(key);if(original.userOpHash!==evidence.userOpHash)throw unavailable();
      await deps.transaction(async client=>{
        await yieldLocks(client,p);
        const a=(await client.query<{state:string;source_breakdown:YieldSources;underlying:string}>(`select a.state,a.source_breakdown,m.underlying from yield_actions a join yield_markets m using(chain_id,market_id) where execution_key=$1`,[key])).rows[0];
        if(a?.state==='released')return;if(!a||a.state==='confirmed')throw unavailable();
        if(original.plan.kind==='supply'&&a.underlying===context.cashAsset)for(const [source,amount]of Object.entries(a.source_breakdown)){
          if(!isSource(source)||source==='asset_holding')throw unavailable();
          await client.query(`update strategy_cash_balances set ${source}=${source}+$3::numeric,updated_at=clock_timestamp() where chain_id=$1 and portfolio_id=$2`,[p.chainId,p.portfolioId,amount]);
        }
        await client.query(`update operations set state='reverted',tx_hash=$2,user_op_hash=$3,updated_at=clock_timestamp() where yield_execution_key=$1`,[key,evidence.txHash,evidence.userOpHash]);
        await client.query(`update yield_actions set state='released',resolution='canonical_revert',resolution_evidence=$2,updated_at=clock_timestamp() where execution_key=$1`,[key,evidence.txHash]);
        await gasState(client,key,'failed');
      });
    },
  };
}

/** Reconstruct outstanding prefund basis from canonical source evidence, never from NAV or
 * nominal receipt growth. Shared by the withdrawal planner and the installment admission gate.
 */
export async function readPrefundPositions(db:YieldStateQuery,chainId:number,portfolioId:number){
  const markets=(await db(`select distinct market_id from yield_actions where chain_id=$1 and portfolio_id=$2 and kind='supply'
    and (source_breakdown->>'stack_prefund_raw')::numeric>0 order by market_id`,[chainId,portfolioId])).rows;
  const positions=[];
  for(const value of markets){
    const marketId=hash(object(value).market_id),history=await readSourceHistory(db,{chainId,portfolioId},marketId);
    const ledger=restoreSourceHistory(history.events,history.scaled);
    positions.push({marketId,principal:raw(ledger.remaining.stack_prefund_raw??'0'),units:ledger.units});
  }
  return positions;
}
function prefundIntentKey(key:string){return `fact-prefund-withdraw-${hash(key).slice(2)}`;}
/** Intent is an immutable 0042 fact committed with action/operation/gas/snapshot.
 * Legacy withdrawals have no intent and retain their original attribution.
 */
async function readSourceHistory(db:YieldStateQuery,p:Pick<YieldAccount,'chainId'|'portfolioId'>,marketId:Hex){
  const rows=(await db(`select e.kind,e.assets_raw::text,e.shares_raw::text,e.remaining_receipts_raw::text,e.state,e.execution_key,a.source_breakdown,m.protocol,f.value as prefund_intent,s.plan_json->>'scaledReceiptBalance' as units_before,
      (select array_agg(distinct ps.tracked_units_raw::text) from yield_position_snapshots ps
        where (ps.chain_id,ps.portfolio_id,ps.market_id)=(e.chain_id,e.portfolio_id,e.market_id)
          and ps.block_number=e.block_number and ps.block_hash=e.block_hash and ps.valuation_state='known'
          and ps.receipt_raw=e.remaining_receipts_raw and ps.observed_units_raw=ps.tracked_units_raw) as units_after
    from yield_events e join yield_actions a using(execution_key)
    join yield_markets m on (m.chain_id,m.market_id)=(e.chain_id,e.market_id)
    left join yield_execution_snapshots s using(execution_key)
    left join yield_runtime_state f on f.name='fact-prefund-withdraw-'||substr(e.execution_key,3)
    where e.chain_id=$1 and e.portfolio_id=$2 and e.market_id=$3 order by e.block_number,e.log_index`,[p.chainId,p.portfolioId,marketId])).rows;
  const events:SourceHistoryEvent[]=[];
  let scaled=false;
  for(const value of rows){
    const row=object(value);scaled=row.protocol==='aave_v3';
    if(row.state!=='confirmed'||(row.kind!=='supply'&&row.kind!=='withdraw'))throw unavailable();
    const before=scaled?raw(row.units_before):events.at(-1)?.unitsAfter??0n;
    if(scaled&&(!Array.isArray(row.units_after)||row.units_after.length!==1))throw unavailable();
    const after=scaled?raw(Array.isArray(row.units_after)?row.units_after[0]:null):raw(row.remaining_receipts_raw);
    if(!scaled&&after!==(row.kind==='supply'?before+raw(row.shares_raw):before-raw(row.shares_raw)))throw unavailable();
    const common={assets:raw(row.assets_raw),unitsBefore:before,unitsAfter:after};
    if(row.kind==='supply')events.push({...common,kind:'supply',sources:object(row.source_breakdown)});
    else{
      let prefundTarget:bigint|undefined;
      if(row.prefund_intent!==null){
        const intent=object(row.prefund_intent);
        if(intent.purpose!=='prefund_shortfall'||intent.executionKey!==row.execution_key||intent.chainId!==p.chainId||intent.portfolioId!==p.portfolioId||intent.marketId!==marketId||
          raw(intent.requiredRaw)<=raw(intent.liquidRaw)||raw(intent.targetRaw)===0n||raw(intent.targetRaw)>raw(intent.requiredRaw)-raw(intent.liquidRaw))throw unavailable();
        prefundTarget=raw(intent.targetRaw);
      }
      events.push({...common,kind:'withdraw',...(prefundTarget===undefined?{}:{prefundTarget})});
    }
  }
  return{events,scaled};
}
async function reopenCompleted(client:PoolClient,p:YieldAccount,marketId:Hex){
  // Only an admitted new supply / proven supply settlement may reopen an automatic zero exit.
  // Keep this in the action's transaction, so an aborted prepare cannot erase completed.
  await client.query("update yield_positions set exit_state='none',exit_reason=null,next_retry_at=null,updated_at=clock_timestamp() where chain_id=$1 and portfolio_id=$2 and market_id=$3 and exit_state='completed' and receipt_raw=0 and tracked_units_raw=0",[p.chainId,p.portfolioId,marketId]);
}
async function gasState(client:PoolClient,key:string,state:string){
  const g=(await client.query<{chain_id:string;account:string;day:string}>(`select chain_id::text,account,to_char(utc_day,'YYYY-MM-DD') as day from gas_budget_reservations where execution_key=$1`,[key])).rows[0];
  if(!g)throw unavailable();
  await client.query("select pg_advisory_xact_lock(hashtextextended('gas_budget_reservations:'||$1::bigint::text||':'||$2||':'||$3,0))",[g.chain_id,g.account,g.day]);
  await client.query(`update gas_budget_reservations set state=$2,updated_at=greatest(updated_at,clock_timestamp()) where execution_key=$1 and state in ('reserved','submitted','unknown')`,[key,state]);
}
async function creditRedemption(client:PoolClient,p:YieldAccount,marketId:Hex){
  const history=await readSourceHistory((sql,params)=>client.query(sql,params?[...params]:[]),p,marketId);
  const all=restoreSourceHistory(history.events,history.scaled).returned;
  const prior=restoreSourceHistory(history.events.slice(0,-1),history.scaled).returned;
  if(history.events.some(e=>e.kind==='supply'&&e.sources.asset_holding!==undefined))return;
  for(const [source,value]of Object.entries(all)){
    if(!isSource(source)||source==='asset_holding')throw unavailable();
    const delta=raw(value)-raw(prior[source]??'0');if(delta<0n)throw unavailable();
    await client.query(`update strategy_cash_balances set ${source}=${source}+$3::numeric,updated_at=clock_timestamp() where chain_id=$1 and portfolio_id=$2`,[p.chainId,p.portfolioId,delta.toString()]);
  }
}
