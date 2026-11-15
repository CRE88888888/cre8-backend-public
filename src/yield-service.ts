import { decodeEventLog, erc20Abi, parseAbi, zeroAddress } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { getChain } from './chain.js';
import { configuredChainId } from './testnet-profile.js';
import { query, withPortfolioLock, withTransaction } from './db.js';
import { requireOwnedPortfolio } from './portfolios.js';
import { AppError, ValidationError } from './errors.js';
import { object, address, hash, raw, fresh, mustExit, riskHeadroom, idleCash, supplyDecision, yieldProfile, unavailable } from './yield-domain.js';
import type { YieldProfile, YieldSources } from './yield-domain.js';
import { readYieldAccount } from './yield-reader.js';
import { createYieldJournal, persistYieldRead, restoreYieldOperation, syncYieldCatalog, yieldLocks } from './yield-store.js';
import type { JournalContext, SnapshotRow, YieldAccount, YieldStoreDeps } from './yield-store.js';
import { yieldExecutionPort } from './yield-port.js';
import type { YieldExecutionPort, YieldPrepare } from './yield-port.js';
import type { Reservation, PaymasterDeps } from './paymaster.js';
import type { SessionKeyRef } from './scheduler.js';
import { resolveBundlerUrl } from './renewal.js';
import { planPortfolio } from './snapshot.js';
import type { PortfolioPlan } from './snapshot.js';
import type { PlannedStep } from './rebalance-plan.js';
import { rebalanceWithdrawals, yieldRebalanceDue } from './yield-rebalance.js';

const POLICY = parseAbi([
  'event YieldPolicySet(address indexed account,bytes32 indexed marketId,uint256 dailyAssets,uint256 strategyId,uint16 version,bool enabled)',
  'event YieldExitRequested(address indexed account,bytes32 indexed marketId)',
  'function policies(address,bytes32) view returns(uint256 dailyAssets,uint256 strategyId,uint16 version,bool enabled)',
  'function exiting(address,bytes32) view returns(bool)',
  'function lastSupply(address,address) view returns(uint256)',
  'function enrollments(address) view returns(uint256 strategyId,uint16 version,bool paused)',
  'function registry() view returns(address)',
  'function numeraire() view returns(address)',
  'function oracle() view returns(address)',
  'function previewSwap(address,address,uint256) view returns(uint256,uint256)',
  'event SupplyExecuted(address indexed account,bytes32 indexed marketId,uint256 assets,uint256 shares,uint256 remainingReceipts)',
  'event WithdrawExecuted(address indexed account,bytes32 indexed marketId,uint256 shares,uint256 assets,uint256 remainingReceipts)',
]);
export type YieldServiceDeps = YieldStoreDeps & { lock:typeof withPortfolioLock; owned:typeof requireOwnedPortfolio;
  profile:()=>YieldProfile|null; client:()=>PublicClient; read:typeof readYieldAccount; plan:typeof planPortfolio; now:()=>Date; port:()=>Promise<YieldExecutionPort>; canSend:()=>boolean };
const defaults:YieldServiceDeps={query,transaction:withTransaction,lock:withPortfolioLock,owned:requireOwnedPortfolio,profile:()=>configuredChainId()===97?yieldProfile():null,client:()=>getChain().publicClient,
  read:readYieldAccount,plan:planPortfolio,now:()=>new Date(),port:yieldExecutionPort,canSend:()=>process.env.ENABLE_YIELD_EXECUTION==='1'};
function body(value:unknown,profile:YieldProfile):{markets:Hex[];txHash:Hex}{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new ValidationError('INVALID_YIELD_REQUEST','需要 markets 與 txHash');
  const v=object(value);
  if(typeof v.txHash!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(v.txHash))throw new ValidationError('INVALID_YIELD_REQUEST','txHash 必須是 bytes32');
  if(Object.keys(v).sort().join(',')!=='markets,txHash'||!Array.isArray(v.markets)||v.markets.length===0||v.markets.length>profile.markets.length)throw new ValidationError('INVALID_YIELD_REQUEST','需要 markets 與已上鏈的 txHash');
  const markets=v.markets.map((m:unknown)=>{if(typeof m!=='string')throw new ValidationError('INVALID_YIELD_REQUEST','markets 必須是市場 ID 字串');const known=profile.markets.find(k=>k.id===m||k.marketId===m.toLowerCase());if(!known)throw new ValidationError('UNKNOWN_YIELD_MARKET','市場不屬於這條鏈');return known.marketId;});
  if(new Set(markets).size!==markets.length)throw new ValidationError('INVALID_YIELD_REQUEST','市場不能重複');
  return {markets,txHash:hash(v.txHash)};
}
async function permission(policies:unknown,account:Address,executor:Address):Promise<'ok'|'needs_update'>{
  // BE-4 owns the complete selector/rule parser; absence never grants permission.
  const path='./permissions.js',loaded:unknown=await import(path),fn=object(loaded).yieldAuthorization;
  if(typeof fn!=='function')return 'needs_update';
  const result:unknown=fn(policies,account,executor);
  return object(result).status==='ready'?'ok':'needs_update';
}
export function createYieldService(overrides:Partial<YieldServiceDeps>={}){
  const deps={...defaults,...overrides};
  const store={query:deps.query,transaction:deps.transaction};
  async function safe<T>(fn:()=>Promise<T>):Promise<T>{try{return await fn();}catch(e){if(e instanceof AppError)throw e;throw unavailable();}}
  function profile(){const p=deps.profile();if(!p)throw new AppError(404,'YIELD_NOT_CONFIGURED','此鏈尚未開放生息');return p;}
  async function owned(id:number,wallet:string){const p=await deps.owned(id,wallet);if(p.chainId!==97||address(p.ownerAddress)!==address(wallet))throw new AppError(403,'FORBIDDEN','只能操作本人於這條鏈的帳戶');return p;}
  async function locked<T>(id:number,fn:()=>Promise<T>){const result=await deps.lock(id,fn);if(result===null)throw new AppError(409,'PORTFOLIO_BUSY','帳戶處理中，請以原請求重試');return result;}
  async function read(p:YieldAccount,at?:bigint){return deps.read(deps.client(),profile(),p.account,{now:deps.now,...(at===undefined?{}:{block:at})});}
  async function verifyHistory(p:YieldAccount,persist=true){
    const blocks=(await deps.query<{block_number:string;block_hash:Hex;state:string}>('select distinct block_number::text,block_hash,state from yield_events where chain_id=$1 and portfolio_id=$2',[p.chainId,p.portfolioId])).rows;
    if(blocks.some(b=>b.state==='reorged'))throw unavailable();
    for(const b of blocks){
      const canonical=await deps.client().getBlock({blockNumber:raw(b.block_number)});
      if(canonical.hash===b.block_hash)continue;
      if(persist)await deps.transaction(async db=>{await yieldLocks(db,p);await db.query("update yield_events set state='reorged',updated_at=clock_timestamp() where chain_id=$1 and portfolio_id=$2 and block_number=$3 and block_hash=$4 and state='confirmed'",[p.chainId,p.portfolioId,b.block_number,b.block_hash]);});
      throw unavailable();
    }
  }
  const keyRows=async(id:number)=>(await deps.query<{key_ref:string;permissions:unknown}>('select key_ref,permissions from session_keys where portfolio_id=$1 and status=\'active\' order by expires_at desc,key_ref',[id])).rows;
  async function request(id:number,wallet:string,value:unknown,kind:'consent'|'exit'|'revoke'){
    return safe(async()=>{
      const p=await owned(id,wallet),f=profile(),input=body(value,f),client=deps.client();
      return locked(id,async()=>{
        await verifyHistory({chainId:p.chainId,portfolioId:id,account:address(p.accountAddress)});
        if(await client.getChainId()!==97)throw unavailable();
        const receipt=await client.getTransactionReceipt({hash:input.txHash}),block=await client.getBlock({blockNumber:receipt.blockNumber});
        if(receipt.transactionHash.toLowerCase()!==input.txHash||receipt.status!=='success'||receipt.blockHash!==block.hash)throw new AppError(409,'YIELD_PROOF_UNCONFIRMED','鏈上同意／退出證據尚未確認，請用原 txHash 重試');
        const at=new Date(Number(block.timestamp)*1000);if(at>deps.now())throw unavailable();
        const chainRegistry=await client.readContract({address:f.registry,abi:POLICY,functionName:'registry',blockNumber:receipt.blockNumber});
        const current=await client.readContract({address:chainRegistry,abi:POLICY,functionName:'enrollments',args:[address(p.accountAddress)]});
        const sid=(await deps.query<{onchain_id:string|null}>('select onchain_id from strategies where id=$1',[p.strategyId])).rows[0]?.onchain_id;
        if(!sid)throw unavailable();
        const evidence=new Map<Hex,{daily:bigint;enabled:boolean}>();
        for(const market of input.markets){
          const matching=receipt.logs.flatMap(log=>{
            if(log.address.toLowerCase()!==f.registry||log.removed||log.transactionHash?.toLowerCase()!==input.txHash||log.blockHash!==receipt.blockHash||log.blockNumber!==receipt.blockNumber||log.logIndex===null)return [];
            try{const event=decodeEventLog({abi:POLICY,data:log.data,topics:log.topics,strict:true});
              if(event.eventName===(kind==='exit'?'YieldExitRequested':'YieldPolicySet')&&event.args.account.toLowerCase()===p.accountAddress.toLowerCase()&&event.args.marketId.toLowerCase()===market)return [event];
            }catch{/* another registry event */}return [];
          });
          if(matching.length!==1)throw new AppError(409,'YIELD_PROOF_UNCONFIRMED','缺少唯一且相符的市場同意／退出事件');
          const event=matching[0];if(!event)throw unavailable();
          if(kind==='exit'){
            if(!await client.readContract({address:f.registry,abi:POLICY,functionName:'exiting',args:[address(p.accountAddress),market]}))throw unavailable();
            evidence.set(market,{daily:0n,enabled:false});
          }else{
            if(event.eventName!=='YieldPolicySet')throw unavailable();
            const latest=await client.readContract({address:f.registry,abi:POLICY,functionName:'policies',args:[address(p.accountAddress),market]});
            const enabled=kind==='consent';
            if(event.args.enabled!==enabled||latest[3]!==enabled||enabled&&(event.args.dailyAssets===0n||latest[0]!==event.args.dailyAssets||event.args.strategyId!==BigInt(sid)||latest[1]!==BigInt(sid)||event.args.version!==p.version||latest[2]!==p.version||current[0]!==BigInt(sid)||current[1]!==p.version))throw unavailable();
            evidence.set(market,{daily:latest[0],enabled});
          }
        }
        if((await deps.query("select execution_key from yield_actions where chain_id=97 and portfolio_id=$1 and state in ('reserved','submitted','unknown')",[id])).rows.length)throw new AppError(409,'YIELD_RECONCILIATION_REQUIRED','原生息操作對帳中，請用同一筆鏈上證據重試');
        const state=await read({chainId:p.chainId,portfolioId:id,account:address(p.accountAddress)});
        await persistYieldRead({chainId:p.chainId,portfolioId:id,account:address(p.accountAddress)},state,store);
        return deps.transaction(async db=>{
          await yieldLocks(db,{chainId:p.chainId,portfolioId:id,account:address(p.accountAddress)});
          if(kind==='exit'){
            const original=(await db.query<{id:string;state:string}>('select id::text,state from yield_exit_requests where request_key=$1',[`yield-exit:97:${id}:${input.txHash}`])).rows[0];
            if(original)return {portfolioId:id,state:original.state,requestId:original.id,replayed:true};
            const open=(await db.query<{id:string;state:string}>("select id::text,state from yield_exit_requests where chain_id=97 and portfolio_id=$1 and state<>'completed'",[id])).rows[0];
            if(open)return {portfolioId:id,state:open.state,requestId:open.id,replayed:true};
            const r=(await db.query<{id:string}>(`insert into yield_exit_requests(request_key,chain_id,portfolio_id,account,requested_by) values($1,97,$2,$3,$4) returning id::text`,[`yield-exit:97:${id}:${input.txHash}`,id,p.accountAddress.toLowerCase(),wallet.toLowerCase()])).rows[0];
            await db.query(`update yield_positions set exit_state='exiting',exit_reason='owner_requested',next_retry_at=null,updated_at=clock_timestamp() where chain_id=97 and portfolio_id=$1 and exit_state<>'completed'`,[id]);
            return {portfolioId:id,state:'requested',requestId:r?.id,replayed:false};
          }
          if(kind==='consent'&&(await db.query("select id from yield_exit_requests where chain_id=97 and portfolio_id=$1 and state<>'completed'",[id])).rows.length)throw new AppError(409,'YIELD_EXIT_PENDING','須先完成全部領回，再重新同意生息');
          for(const [market,e]of evidence){
            if(kind==='consent'&&(await db.query('select id from yield_consents where chain_id=97 and portfolio_id=$1 and market_id=$2 and policy_version=$3',[id,market,input.txHash])).rows.length)continue;
            const previous=(await db.query<{id:string;policy_version:string}>('select id::text,policy_version from yield_consents where chain_id=97 and portfolio_id=$1 and market_id=$2 and opted_out_at is null',[id,market])).rows[0];
            if(previous?.policy_version===input.txHash)continue;
            if(previous)await db.query('update yield_consents set opted_out_at=clock_timestamp(),updated_at=clock_timestamp() where id=$1',[previous.id]);
            if(kind==='consent'){
              const observed=state.positions.find(s=>s.market.marketId===market);
              if(observed?.state==='known'&&observed.receipt===0n&&observed.trackedUnits===0n&&!observed.exiting)await db.query("update yield_positions set exit_state='none',exit_reason=null,next_retry_at=null,updated_at=clock_timestamp() where chain_id=97 and portfolio_id=$1 and market_id=$2",[id,market]);
              // A replayed old transaction can never undo a later opt-out.
              if((await db.query('select id from yield_consents where chain_id=97 and portfolio_id=$1 and market_id=$2 and policy_version=$3',[id,market,input.txHash])).rows.length)continue;
              await db.query(`insert into yield_consents(chain_id,portfolio_id,account,market_id,strategy_id,version,authorized_by,policy_version,daily_assets_raw,opted_in_at)
                values(97,$1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,p.accountAddress.toLowerCase(),market,p.strategyId,p.version,wallet.toLowerCase(),input.txHash,e.daily.toString(),at]);
            }
          }
          return {portfolioId:id,state:kind==='consent'?'consented':'not_consented'};
        });
      });
    });
  }
  return {
    markets:(chainId:number)=>safe(async()=>{
      const f=profile();if(chainId!==f.chainId)throw new AppError(404,'YIELD_NOT_CONFIGURED','此鏈尚未開放生息');
      const state=await deps.read(deps.client(),f,zeroAddress,{now:deps.now});
      await syncYieldCatalog(state,store);
      return {chainId,registry:f.registry,markets:state.positions.map(p=>({id:p.market.id,marketId:p.market.marketId,protocol:p.market.protocol,asset:p.market.asset,symbol:p.market.symbol,
        receipt:p.market.receipt,aprBps:p.aprBps===null?null:Number(p.aprBps),simulated:p.market.simulated,is_simulated:p.market.simulated,
        supplyOpen:p.supplyOpen&&p.state==='known'&&state.risks.filter(r=>r.asset===p.market.asset&&r.protocol===p.market.protocol).every(r=>r.state==='known'&&r.utilizationBps!==null&&r.utilizationBps<=8000),dataAt:p.at.toISOString()}))};
    }),
    status:(id:number,wallet:string)=>safe(async()=>{
      if(deps.profile()===null)return null;
      const p=await owned(id,wallet),f=profile(),a={chainId:97,portfolioId:id,account:address(p.accountAddress)};
      const rows=await deps.query<{market_id:Hex;exit_state:string;exit_reason:string|null;receipt_raw:string}>(`select market_id,exit_state,exit_reason,receipt_raw::text from yield_positions where chain_id=97 and portfolio_id=$1`,[id]);
      const consents=await deps.query<{market_id:Hex}>('select market_id from yield_consents where chain_id=97 and portfolio_id=$1 and strategy_id=$2 and version=$3 and opted_out_at is null',[id,p.strategyId,p.version]);
      const version=(await deps.query<{execution:unknown}>('select v.execution from portfolios p join strategy_versions v on (v.strategy_id,v.version)=(p.strategy_id,p.version) where p.id=$1',[id])).rows[0];
      const selected=version?object(version.execution).assets:[];
      const choices=Array.isArray(selected)?selected.map((a:unknown)=>{const item=object(a);return item.yield===null?null:object(item.yield).market;}):[];
      const openExit=(await deps.query("select id from yield_exit_requests where chain_id=97 and portfolio_id=$1 and state<>'completed' limit 1",[id])).rows.length>0;
      if(!choices.some(c=>typeof c==='string')&&!consents.rows.length&&!openExit&&!rows.rows.some(p=>raw(p.receipt_raw)>0n||p.exit_state==='exiting'||p.exit_state==='retry'))return null;
      const frozen=(await deps.query("select execution_key from yield_events where chain_id=97 and portfolio_id=$1 and state='reorged' limit 1",[id])).rows.length>0;
      const state=await read(a);
      const keys=await keyRows(id),permissions=await Promise.all(keys.map(k=>permission(k.permissions,a.account,f.executor)));
      return {permission:permissions.includes('ok')?'ok':'needs_update',accountValue:frozen||state.positions.some(s=>s.state==='unknown'||s.value===null)?null:state.accountValue?.toString()??null,assets:state.positions.filter(s=>choices.includes(s.market.id)||s.receipt!==null&&s.receipt>0n||rows.rows.some(p=>p.market_id===s.market.marketId&&raw(p.receipt_raw)>0n)||consents.rows.some(c=>c.market_id===s.market.marketId)).map(s=>{
        const prior=rows.rows.find(r=>r.market_id===s.market.marketId),risk=state.risks.filter(r=>r.protocol===s.market.protocol&&r.asset===s.market.asset);
        const consented=consents.rows.some(c=>c.market_id===s.market.marketId);
        const exiting=(frozen||s.receipt===null||s.receipt>0n||prior?.exit_state==='exiting'||prior?.exit_state==='retry')&&(frozen||mustExit(s,risk,prior?.exit_state==='exiting'||prior?.exit_state==='retry',deps.now()));
        const reason=frozen||s.state==='unknown'?'unknown':s.withdrawPaused?'market_paused':risk.some(r=>r.utilizationBps!==null&&r.utilizationBps>=9000)?'high_utilization':s.claim!==null&&s.maxWithdraw!==null&&s.maxWithdraw<s.claim?'low_liquidity':'unknown';
        return {asset:s.market.asset,symbol:s.market.symbol,market:s.market.id,consented,state:exiting?'exiting':s.receipt===0n&&(s.exiting||prior?.exit_state==='completed')?'stopped':s.receipt===0n?(consented?'cash':'not_consented'):'supplied',
          receiptValue:frozen?null:s.value?.toString()??null,pending:exiting?{value:frozen?null:s.value?.toString()??null,reason}:null,dataAt:s.at.toISOString(),simulated:s.market.simulated,is_simulated:s.market.simulated,valuationState:frozen?'unknown':s.state,
          maxWithdraw:frozen?null:s.maxWithdraw?.toString()??null,claimAssets:frozen?null:s.claim?.toString()??null};})};
    }),
    consent:(id:number,wallet:string,value:unknown)=>request(id,wallet,value,'consent'),
    revoke:(id:number,wallet:string,value:unknown)=>request(id,wallet,value,'revoke'),
    exit:(id:number,wallet:string,value:unknown)=>request(id,wallet,value,'exit'),
    tick:(p:YieldAccount,dryRun:boolean,rebalance?:{plan:PortfolioPlan;reserve:bigint;steps:readonly PlannedStep[]})=>safe(async()=>{
      const f=profile(),client=deps.client();
      await verifyHistory(p,!dryRun);
      const unresolved=(await deps.query<{execution_key:string}>('select execution_key from yield_actions where chain_id=$1 and portfolio_id=$2 and state in (\'reserved\',\'submitted\',\'unknown\')',[p.chainId,p.portfolioId])).rows;
      const cashAsset=address(await client.readContract({address:f.executor,abi:POLICY,functionName:'numeraire'}));
      let reservation:Reservation|null=null;
      const ctx:JournalContext={...p,cashAsset,consentId:null,exitRequestId:null,sources:{},reserve:()=>reservation,
        validate:async(input:YieldPrepare)=>{
          const quoteBlock=await client.getBlock({blockNumber:input.plan.quoteBlock});
          if(quoteBlock.number!==input.plan.quoteBlock||quoteBlock.hash!==input.plan.quoteBlockHash||!fresh(new Date(Number(quoteBlock.timestamp)*1000),deps.now()))throw unavailable();
          if(BigInt(Math.floor(deps.now().getTime()/1000))>input.plan.deadline)throw unavailable();
          if(input.plan.executor!==f.executor||input.plan.yieldRegistry!==f.registry)throw unavailable();
          const current=await read(p);await persistYieldRead(p,current,store);
        },
        settlement:async(plan,evidence)=>{
          const receipt=await client.getTransactionReceipt({hash:evidence.txHash});
          const block=await client.getBlock({blockNumber:receipt.blockNumber});
          if(block.hash!==receipt.blockHash||receipt.status!=='success')throw unavailable();
          const logs=receipt.logs.filter(log=>{if(log.removed||log.address.toLowerCase()!==plan.executor)return false;
            try{const event=decodeEventLog({abi:POLICY,data:log.data,topics:log.topics,strict:true});return event.eventName===(plan.kind==='supply'?'SupplyExecuted':'WithdrawExecuted')&&event.args.account.toLowerCase()===p.account&&event.args.marketId.toLowerCase()===plan.marketId&&event.args.assets===evidence.assets&&event.args.shares===evidence.shares&&event.args.remainingReceipts===evidence.remainingReceipts;}catch{return false;}});
          if(logs.length!==1||logs[0]?.logIndex===null||logs[0]?.logIndex===undefined)throw unavailable();
          const current=await deps.read(client,f,p.account,{block:receipt.blockNumber,now:()=>new Date(Number(block.timestamp)*1000)});
          const latest=await read(p);current.risks=latest.risks;
          return {read:current,logIndex:logs[0].logIndex,blockNumber:receipt.blockNumber,blockHash:receipt.blockHash,occurredAt:new Date(Number(block.timestamp)*1000)};
        }};
      const journal=createYieldJournal(ctx,store);
      if(unresolved.length){
        if(dryRun)return '生息原操作待對帳（dry-run）';
        if(unresolved.length!==1)throw unavailable();const key=unresolved[0]?.execution_key;if(!key)throw unavailable();
        const row=(await deps.query<SnapshotRow>('select * from yield_execution_snapshots where execution_key=$1',[key])).rows[0];
        if(!row){await journal.unknown(key);return '生息原始快照缺漏，保留 unknown，不重送';}
        try{const original=restoreYieldOperation(row),result=await(await deps.port()).reconcileYieldOperation(client,resolveBundlerUrl(),original);
          if(result.status==='confirmed')await journal.confirmed(key,result.evidence);else await journal.reverted(key,result);
          return '已由原始快照對帳；本輪不重送';
        }catch{await journal.unknown(key);return '生息原操作證據不足，保留 unknown，不重送';}
      }
      if((await deps.query(`select id from operations where portfolio_id=$1 and (state in ('pending','submitted') or (state='failed' and (tx_hash is not null or user_op_hash is not null)))`,[p.portfolioId])).rows.length)return '其他帳戶操作待對帳';
      const state=await read(p,rebalance?.plan.snapshot.block).catch(async()=>{
        if(!dryRun&&rebalance===undefined)await deps.transaction(async db=>{await yieldLocks(db,p);await db.query("update yield_positions set exit_state='retry',exit_reason='data_unavailable',next_retry_at=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp() where chain_id=$1 and portfolio_id=$2 and (receipt_raw>0 or tracked_units_raw>0)",[p.chainId,p.portfolioId]);});
        throw unavailable();
      });
      if(dryRun)return '生息讀值完成（dry-run，未寫入／送出）';
      await persistYieldRead(p,state,store);
      if(rebalance!==undefined){
        if(rebalance.plan.portfolioId!==p.portfolioId||rebalance.plan.account.toLowerCase()!==p.account||rebalance.plan.chainId!==p.chainId||
          state.observation.block!==rebalance.plan.snapshot.block||!fresh(state.observation.at,deps.now()))throw unavailable();
        if(rebalance.plan.snapshot.yieldPositions?.some(s=>s.blockHash!==state.observation.blockHash))throw unavailable();
        const needs=rebalanceWithdrawals(rebalance.plan,state.positions,rebalance.steps,cashAsset,rebalance.reserve,deps.now());
        if(!needs.length)return null;
        const next=needs.find(n=>!n.blocked);
        if(!next)return '生息市場暫停或現金不足，保留再平衡，下輪重試';
        const result=await send(next.marketId,'withdraw',next.amount);
        return `${result}；本輪不賣買，重新讀值後續作再平衡`;
      }
      const exits=(await deps.query<{id:string;requested_at:Date}>('select id::text,requested_at from yield_exit_requests where chain_id=$1 and portfolio_id=$2 and state<>\'completed\'',[p.chainId,p.portfolioId])).rows;
      const existing=(await deps.query<{market_id:Hex;exit_state:string}>('select market_id,exit_state from yield_positions where chain_id=$1 and portfolio_id=$2',[p.chainId,p.portfolioId])).rows;
      for(const s of state.positions){
        const r=state.risks.filter(r=>r.asset===s.market.asset&&r.protocol===s.market.protocol),prior=existing.find(e=>e.market_id===s.market.marketId);
        const exit=exits.length>0||mustExit(s,r,prior?.exit_state==='exiting'||prior?.exit_state==='retry',deps.now());
        if(exit&&(s.receipt===null||s.receipt>0n||s.trackedUnits===null||s.trackedUnits>0n)){
          const reason=s.withdrawPaused?'market_paused':r.some(r=>r.utilizationBps!==null&&r.utilizationBps>=9000)?'high_utilization':s.state==='unknown'?'data_unavailable':s.claim!==null&&s.maxWithdraw!==null&&s.maxWithdraw<s.claim?'low_liquidity':'owner_requested';
          await deps.transaction(async db=>{await yieldLocks(db,p);await db.query(`update yield_positions set exit_state='retry',exit_reason=$4,next_retry_at=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp() where chain_id=$1 and portfolio_id=$2 and market_id=$3`,[p.chainId,p.portfolioId,s.market.marketId,reason]);});
          if(s.maxRedeem===null||s.maxRedeem===0n)continue;
          ctx.exitRequestId=exits[0]?.id??null;
          return send(s.market.marketId,'withdraw',s.maxRedeem);
        }
      }
      if(exits.length){
        const requestAt=exits[0]?.requested_at;
        const complete=requestAt!==undefined&&state.positions.length===f.markets.length&&state.positions.every(s=>s.state==='known'&&s.receipt===0n&&s.observedUnits===0n&&s.trackedUnits===0n&&s.at>=requestAt);
        await deps.transaction(async db=>{await yieldLocks(db,p);
          if(complete){await db.query("update yield_positions set exit_state='completed',exit_reason=null,next_retry_at=null,updated_at=clock_timestamp() where chain_id=$1 and portfolio_id=$2",[p.chainId,p.portfolioId]);
            await db.query("update yield_exit_requests set state='completed',completed_at=clock_timestamp(),next_retry_at=null,updated_at=clock_timestamp() where chain_id=$1 and portfolio_id=$2 and state<>'completed'",[p.chainId,p.portfolioId]);}
          else await db.query("update yield_exit_requests set state='retry',reason='pending_withdrawal',next_retry_at=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp() where chain_id=$1 and portfolio_id=$2 and state<>'completed'",[p.chainId,p.portfolioId]);});
        return complete?'生息已全部領回':'生息持續待領回';
      }
      await deps.transaction(async db=>{await yieldLocks(db,p);await db.query("update yield_positions p set exit_state='completed',exit_reason=null,next_retry_at=null,updated_at=clock_timestamp() from yield_position_snapshots s where s.id=p.latest_snapshot_id and p.chain_id=$1 and p.portfolio_id=$2 and p.exit_state in ('exiting','retry') and p.receipt_raw=0 and p.tracked_units_raw=0 and s.valuation_state='known' and s.observed_units_raw=0",[p.chainId,p.portfolioId]);});
      if(state.accountValue===null)return '帳戶估值未知，停止新供給';
      const current=(await deps.query<{strategy_id:string;onchain_id:string|null;version:number;schedule_state:string;execution:unknown}>(`select p.strategy_id::text,(select onchain_id::text from strategies where id=p.strategy_id) as onchain_id,p.version,p.schedule_state,v.execution from portfolios p join strategy_versions v on (v.strategy_id,v.version)=(p.strategy_id,p.version) where p.id=$1`,[p.portfolioId])).rows[0];
      if(!current||!current.onchain_id||current.schedule_state!=='active')return '帳戶停止新供給';
      const execution=object(current.execution);if(execution.kind!=='per_asset'||!Array.isArray(execution.assets))return '此版本未選生息市場';
      // Persisted monthly anchor / fresh drift survive restarts. Do not re-supply redeemed inputs before the swap round.
      if(execution.rebalance==='monthly'||execution.rebalance==='drift'){
        const last=(await deps.query<{last_rebalance_at:Date|null}>("select coalesce(last_rebalance_at,(select min(created_at) from strategy_funding_lots where portfolio_id=$1 and state='confirmed')) as last_rebalance_at from portfolios where id=$1",[p.portfolioId])).rows[0];
        if(!last)throw unavailable();
        const plan=execution.rebalance==='drift'?await deps.plan(p.portfolioId,{publicClient:client}):null;
        if((plan!==null&&(plan.blocked.length>0||plan.report===null))||yieldRebalanceDue(execution.rebalance,last.last_rebalance_at,plan?.report?.maxAbsDeltaBps??null,deps.now()))return '再平衡尚待完成，暫緩新供給';
      }
      for(const selected of execution.assets){
        const setting=object(selected);if(setting.yield===null)continue;const choice=object(setting.yield);
        const s=state.positions.find(s=>s.market.id===choice.market&&s.market.asset===setting.asset);if(!s||s.state!=='known'||!s.supplyOpen)continue;
        const risk=state.risks.filter(r=>r.asset===s.market.asset&&r.protocol===s.market.protocol);
        if(mustExit(s,risk,existing.some(e=>e.market_id===s.market.marketId&&['exiting','retry'].includes(e.exit_state)),deps.now()))continue;
        const consent=(await deps.query<{id:string;daily_assets_raw:string}>(`select id::text,daily_assets_raw::text from yield_consents where chain_id=$1 and portfolio_id=$2 and market_id=$3 and strategy_id=$4 and version=$5 and opted_out_at is null`,[p.chainId,p.portfolioId,s.market.marketId,current.strategy_id,current.version])).rows[0];
        if(!consent)continue;
        const policy=await client.readContract({address:f.registry,abi:POLICY,functionName:'policies',args:[p.account,s.market.marketId]});
        if(!policy[3]||policy[1]!==BigInt(current.onchain_id)||policy[2]!==current.version)continue;
        const reserved=new Map<string,bigint>();
        for(const r of risk){const n=(await deps.query<{n:string}>(`select coalesce(sum(a.amount_raw),0)::text as n from yield_action_risks ar join yield_actions a using(execution_key) where ar.chain_id=$1 and ar.risk_key=$2 and a.state in ('reserved','submitted','unknown')`,[p.chainId,r.key])).rows[0]?.n;if(n===undefined)throw unavailable();reserved.set(r.key,raw(n));}
        const balance=await client.readContract({address:s.market.asset,abi:erc20Abi,functionName:'balanceOf',args:[p.account],blockNumber:state.observation.block});
        let idle=balance;
        if(s.market.asset===cashAsset){
          const b=(await deps.query<Record<string,string>>(`select unallocated_hold_raw::text,stack_prefund_raw::text,allocated_cash_raw::text,reserved_input_raw::text,reserved_fee_raw::text,withdrawal_raw::text,yield_raw::text from strategy_cash_balances where chain_id=$1 and portfolio_id=$2`,[p.chainId,p.portfolioId])).rows[0];
          if(!b)continue;const total=Object.values(b).reduce((n,v)=>n+raw(v),0n);
          idle=idleCash({allocated:raw(b.allocated_cash_raw),earnings:raw(b.yield_raw),observed:balance,classified:total});
          ctx.sources={allocated_cash_raw:raw(b.allocated_cash_raw).toString(),yield_raw:raw(b.yield_raw).toString()};
        }else ctx.sources={asset_holding:balance.toString()};
        const oracle=await client.readContract({address:f.executor,abi:POLICY,functionName:'oracle'});
        const value=s.market.asset===cashAsset?balance:balance===0n?0n:(await client.readContract({address:oracle,abi:POLICY,functionName:'previewSwap',args:[s.market.asset,cashAsset,balance],blockNumber:state.observation.block}))[1];
        const last=await client.readContract({address:f.registry,abi:POLICY,functionName:'lastSupply',args:[p.account,s.market.asset]});
        const riskCap=riskHeadroom(risk,reserved,deps.now());
        const cap=riskCap<policy[0]?riskCap:policy[0];
        const amount=supplyDecision({idle,capacity:cap<raw(consent.daily_assets_raw)?cap:raw(consent.daily_assets_raw),assetAmount:balance,assetValue:value,consent:true,selected:true,cooldown:state.observation.at.getTime()/1000>=Number(last)+86400,exiting:false,enabled:true});
        if(amount===0n)continue;
        ctx.consentId=consent.id;ctx.sources=s.market.asset===cashAsset?cashSources(ctx.sources,amount):{asset_holding:amount.toString()};
        return send(s.market.marketId,'supply',amount);
      }
      return '沒有可安全供給的新閒置資產';
      async function send(marketId:Hex,kind:'supply'|'withdraw',amount:bigint){
        if(!deps.canSend())return '生息讀值與退出要求已保存；執行開關尚未啟用';
        const keys=await keyRows(p.portfolioId);
        for(const key of keys){
          if(await permission(key.permissions,p.account,f.executor)!=='ok')continue;
          const policies=object(key.permissions),timestamp=object(policies.timestamp);
          if(!/^m\/44'\/60'\/[0-9'/]+$/.test(key.key_ref)||typeof timestamp.validUntil!=='number'||!Number.isSafeInteger(timestamp.validUntil))throw unavailable();
          const keyRef:SessionKeyRef['keyRef']=`m/44'/60'/${key.key_ref.slice(10)}`;
          const owner=(await deps.query<{owner:Address}>('select owner from smart_accounts where chain_id=$1 and portfolio_id=$2',[p.chainId,p.portfolioId])).rows[0]?.owner;if(!owner)throw unavailable();
          const sessionKey:SessionKeyRef={keyRef,permissionId:hashPermission(policies.permissionId),sessionKeyAddress:address(policies.sessionKeyAddress),validUntil:timestamp.validUntil,owner};
          const paymaster:PaymasterDeps={reserve:async r=>{reservation=r;return r.validUntil;}};
          await(await deps.port()).submitYieldAction({publicClient:client,bundlerUrl:resolveBundlerUrl(),account:p.account,sessionKey,policies:key.permissions,action:{marketId,kind,amount},journal,paymaster});
          return kind==='withdraw'?'生息領出已確認':'生息供給已確認';
        }
        return '需要 owner 更新生息 session 權限';
      }
    }),
  };
}
function hashPermission(v:unknown):Hex{if(typeof v!=='string'||!/^0x[0-9a-fA-F]{8}$/.test(v))throw unavailable();return `0x${v.slice(2)}`;}
function cashSources(s:YieldSources,amount:bigint):YieldSources{const allocated=raw(s.allocated_cash_raw??'0'),a=amount<allocated?amount:allocated;return{allocated_cash_raw:a.toString(),yield_raw:(amount-a).toString()};}

export async function runYieldRound(options:{dryRun:boolean;limit:number},overrides:Partial<YieldServiceDeps>={}):Promise<{checked:number;blocked:number}>{
  const deps={...defaults,...overrides};
  if(configuredChainId()!==97||deps.profile()===null)return{checked:0,blocked:0};
  const service=createYieldService(deps);
  const accounts=(await deps.query<{portfolio_id:string;account:Address}>(`select sa.portfolio_id::text,sa.address as account from smart_accounts sa
    join portfolios p on p.id=sa.portfolio_id where sa.chain_id=97 and sa.account_type='KERNEL'
    and (exists(select 1 from strategy_versions v,jsonb_array_elements(case when jsonb_typeof(v.execution->'assets')='array' then v.execution->'assets' else '[]'::jsonb end) a where (v.strategy_id,v.version)=(p.strategy_id,p.version) and a.value->'yield'<>'null'::jsonb)
      or exists(select 1 from yield_positions yp where yp.portfolio_id=p.id and (yp.receipt_raw>0 or yp.tracked_units_raw>0 or yp.exit_state in ('exiting','retry')))
      or exists(select 1 from yield_actions ya where ya.portfolio_id=p.id and ya.state in ('reserved','submitted','unknown'))
      or exists(select 1 from yield_exit_requests ye where ye.portfolio_id=p.id and ye.state<>'completed'))
    order by exists(select 1 from yield_actions a where a.portfolio_id=p.id and a.state in ('reserved','submitted','unknown')) desc,
    exists(select 1 from yield_exit_requests e where e.portfolio_id=p.id and e.state<>'completed') desc,
    (select max(s.observed_at) from yield_position_snapshots s where s.portfolio_id=p.id) nulls first,p.id limit $1`,[options.limit])).rows;
  let checked=0,blocked=0;
  for(const row of accounts){
    try{const result=await deps.lock(Number(row.portfolio_id),()=>service.tick({portfolioId:Number(row.portfolio_id),chainId:97,account:row.account},options.dryRun));if(result!==null)checked++;}
    catch{blocked++;}
  }
  return {checked,blocked};
}
