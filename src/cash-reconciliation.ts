import { decodeEventLog, erc20Abi, keccak256, toHex } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import type { SchedulerQueryFn } from './scheduler.js';
import { isLogRangeRefusal } from './rpc-transport.js';

export type CashWithdrawal = { txHash:Hex; logIndex:number; blockNumber:bigint; blockHash:Hex; amount:bigint };
const identity=(chainId:number,e:CashWithdrawal)=>`cash-withdrawal:${chainId}:${e.txHash}:${e.logIndex}`;
const commitment=(e:CashWithdrawal)=>keccak256(toHex(JSON.stringify([e.txHash,e.logIndex,e.blockNumber.toString(),e.blockHash,e.amount.toString()])));

/**
 * 每段 eth_getLogs 的區塊數（含頭尾）。先用 10,000（publicnode 收到 50,000）；節點說範圍太大時，那一段改成每
 * `WITHDRAWAL_LOG_NARROW` 塊重讀。5,000＝會回日誌的 chain-97 節點裡最小的範圍上限（bsc-prebsc-dataseed：
 * `exceed maximum block range 5000`）。
 * - 只用 10,000：publicnode 限流、請求改走下一個節點時每一段都被拒，整個組合那一輪
 *   [CASH_RECONCILIATION_UNAVAILABLE]（2026-11-25 portfolio 4）。
 * - 只用 5,000：請求數加倍，重啟後第一次整段掃描從 3.6–4.8 秒變成 9.4–9.8 秒（2026-11-26 portfolio 1、4）。
 */
export const WITHDRAWAL_LOG_CHUNK=10_000n;
export const WITHDRAWAL_LOG_NARROW=5_000n;
/** 同時在飛的 getLogs 段數。 */
export const WITHDRAWAL_LOG_CONCURRENCY=6;
/**
 * 已掃過、離 head 夠遠（不會再重組）的區段只掃一次：排程器是長駐進程，下一輪只從上次的穩定高度往後掃。
 * 為什麼要：原本每輪都從第一筆入金一路分段掃到 head（10k 塊一段、逐段等），入金幾天的組合就是幾十次循序
 * getLogs，每個組合 30–57 秒，連休市都照掃。穩定區段裡的提領照樣每輪重驗 receipt 與區塊雜湊；驗不過就丟掉
 * 快取、下輪整段重掃。進程重啟後第一次照舊整段掃（並行分段）。
 */
export const WITHDRAWAL_REORG_MARGIN=64n;
type ScannedWithdrawals={stableTo:bigint;logs:WithdrawalLog[]};
type WithdrawalLog=Awaited<ReturnType<PublicClient['getLogs']>>[number];
const scanned=new Map<string,ScannedWithdrawals>();
const SCANNED_MAX_ENTRIES=1000;
/** Test hook: forget every cached range. */
export function resetWithdrawalScanCache():void{scanned.clear();}

/** Only canonical account-to-owner transfers count as known withdrawals. Balance loss alone is not proof. */
export async function readCashWithdrawals(client:PublicClient,query:SchedulerQueryFn,args:{chainId:number;portfolioId:number;account:Address;cash:Address;blockNumber:bigint}):Promise<CashWithdrawal[]>{
  try{
    const owner=(await query('select owner from smart_accounts where portfolio_id=$1 and chain_id=$2 and address=$3',[args.portfolioId,args.chainId,args.account])).rows[0] as {owner?:string}|undefined;
    if(!owner?.owner||!/^0x[0-9a-f]{40}$/.test(owner.owner))throw new Error('owner missing');
    const first=(await query("select block_number::text,log_index::text from strategy_funding_lots where portfolio_id=$1 and chain_id=$2 and state='confirmed' order by block_number,log_index limit 1",[args.portfolioId,args.chainId])).rows[0] as {block_number:string;log_index:string}|undefined;
    if(!first)return [];
    if(BigInt(first.block_number)>args.blockNumber||await client.getChainId()!==args.chainId)throw new Error('stale cash observation');
    // 分段查：公共 BSC RPC 的 eth_getLogs 有跨度上限（publicnode 實測 50,000 塊，其他 2k–10k），
    // 入金幾小時後整段一次查就永遠失敗，整個組合每輪都被擋（tst 2026-11-21）。
    const key=[args.chainId,args.portfolioId,args.account.toLowerCase(),owner.owner,args.cash.toLowerCase(),first.block_number,first.log_index].join(':');
    const cached=scanned.get(key);
    const from=cached===undefined?BigInt(first.block_number):cached.stableTo+1n;
    const ranges:[bigint,bigint][]=[];
    for(let start=from;start<=args.blockNumber;start+=WITHDRAWAL_LOG_CHUNK)
      ranges.push([start,start+WITHDRAWAL_LOG_CHUNK-1n<args.blockNumber?start+WITHDRAWAL_LOG_CHUNK-1n:args.blockNumber]);
    const chunks:WithdrawalLog[][]=new Array(ranges.length);
    let next=0;
    await Promise.all(Array.from({length:Math.min(WITHDRAWAL_LOG_CONCURRENCY,ranges.length)},async()=>{
      for(let i=next++;i<ranges.length;i=next++){
        const [start,end]=ranges[i]!;
        const read=(fromBlock:bigint,toBlock:bigint)=>client.getLogs({address:args.cash,event:erc20Abi.find(e=>e.type==='event'&&e.name==='Transfer'),args:{from:args.account,to:owner.owner as Address},fromBlock,toBlock,strict:true});
        try{chunks[i]=await read(start,end);}
        catch(error){
          // 範圍被節點拒絕：同一段改成窄的幾段照順序重讀（涵蓋的區塊完全相同）；其他錯誤、或已經夠窄，照舊整次失敗。
          if(end-start<WITHDRAWAL_LOG_NARROW||!isLogRangeRefusal(error))throw error;
          const parts:WithdrawalLog[]=[];
          for(let from=start;from<=end;from+=WITHDRAWAL_LOG_NARROW)parts.push(...await read(from,from+WITHDRAWAL_LOG_NARROW-1n<end?from+WITHDRAWAL_LOG_NARROW-1n:end));
          chunks[i]=parts;
        }
      }
    }));
    const logs=[...(cached?.logs.filter(log=>log.blockNumber!==null&&log.blockNumber<=args.blockNumber)??[]),...chunks.flat()];
    // The verification below runs for cached logs too; a failure drops the cache entry (catch) and rescans next round.
    scanned.delete(key);
    const result:CashWithdrawal[]=[];
    for(const log of logs){
      if(log.blockNumber===null||log.logIndex===null||log.transactionHash===null||log.blockHash===null||log.removed)throw new Error('incomplete cash evidence');
      if(log.blockNumber===BigInt(first.block_number)&&BigInt(log.logIndex)<=BigInt(first.log_index))continue;
      const event=decodeEventLog({abi:erc20Abi,eventName:'Transfer',data:log.data,topics:log.topics});
      if(event.args.from.toLowerCase()!==args.account.toLowerCase()||event.args.to.toLowerCase()!==owner.owner||event.args.value<=0n)throw new Error('wrong withdrawal');
      const [receipt,block]=await Promise.all([client.getTransactionReceipt({hash:log.transactionHash}),client.getBlock({blockNumber:log.blockNumber})]);
      if(receipt.status!=='success'||receipt.blockNumber!==log.blockNumber||receipt.blockHash!==log.blockHash||block.hash!==log.blockHash||block.number!==log.blockNumber||
        !receipt.logs.some(e=>!e.removed&&e.logIndex===log.logIndex&&e.address.toLowerCase()===args.cash.toLowerCase()&&e.data===log.data&&e.topics.join()===log.topics.join()))throw new Error('noncanonical withdrawal');
      result.push({txHash:log.transactionHash,logIndex:log.logIndex,blockNumber:log.blockNumber,blockHash:log.blockHash,amount:event.args.value});
    }
    const stableTo=args.blockNumber-WITHDRAWAL_REORG_MARGIN;
    if(stableTo>=(cached?.stableTo??BigInt(first.block_number)-1n)){
      if(scanned.size>=SCANNED_MAX_ENTRIES){const oldest=scanned.keys().next();if(!oldest.done)scanned.delete(oldest.value);}
      scanned.set(key,{stableTo,logs:logs.filter(log=>log.blockNumber!==null&&log.blockNumber<=stableTo)});
    }else if(cached!==undefined)scanned.set(key,cached);
    return result;
  }catch(cause){throw new Error('[CASH_RECONCILIATION_UNAVAILABLE] 提領證據無法確認，保留來源與預留',{cause});}
}

/** Called under the portfolio/cash locks, after checking unresolved operations.
 * Source budgets remain immutable spending ceilings. Only free cash buckets absorb
 * proven withdrawals; the remaining bucket and observed cash both cap future slices.
 */
export async function reconcileCashWithdrawals(query:SchedulerQueryFn,c:{chainId:number;portfolioId:number;observedCash:bigint},events:readonly CashWithdrawal[]):Promise<void>{
  const saved=(await query("select idempotency_key,payload_hash from operations where portfolio_id=$1 and type='withdraw' and idempotency_key like 'cash-withdrawal:%'",[c.portfolioId])).rows as {idempotency_key:string;payload_hash:string}[];
  const current=new Map(events.map(e=>[identity(c.chainId,e),commitment(e)]));
  if(current.size!==events.length||saved.some(e=>current.get(e.idempotency_key)!==e.payload_hash))throw new Error('[CASH_REORGED] 已對帳提領證據改變，保留預留');
  const fresh=events.filter(e=>!saved.some(s=>s.idempotency_key===identity(c.chainId,e)));
  if(!fresh.length)return;
  const row=(await query('select * from strategy_cash_balances where chain_id=$1 and portfolio_id=$2',[c.chainId,c.portfolioId])).rows[0] as Record<string,string>|undefined;
  if(!row)throw new Error('missing cash');
  const buckets=['unclassified_raw','allocated_cash_raw','unallocated_hold_raw','stack_prefund_raw','reserved_input_raw','reserved_fee_raw','withdrawal_raw','yield_raw'];
  const total=buckets.reduce((n,key)=>n+BigInt(row[key]??'0'),0n);
  const deficit=total>c.observedCash?total-c.observedCash:0n;
  const proven=fresh.reduce((n,e)=>{if(e.amount<=0n||!Number.isSafeInteger(e.logIndex)||e.logIndex<0)throw new Error('invalid withdrawal');return n+e.amount;},0n);
  let debit=deficit<proven?deficit:proven;
  const values=Object.fromEntries(buckets.slice(0,4).map(key=>[key,BigInt(row[key]??'0')]));
  if(Object.values(values).reduce((n,v)=>n+v,0n)<debit)throw new Error('[CASH_DEFICIT] 提領已碰觸保留款，先對帳');
  for(const key of ['unclassified_raw','allocated_cash_raw']){const value=values[key]??0n,take=value<debit?value:debit;values[key]=value-take;debit-=take;}
  // The two prefunding buckets share a fungible cash loss proportionally; never
  // rewrite a signed lot or debit unknown/fee/withdrawal/yield reservations.
  const hold=values.unallocated_hold_raw??0n,stack=values.stack_prefund_raw??0n;
  const holdDebit=hold+stack===0n?0n:debit*hold/(hold+stack);
  values.unallocated_hold_raw=hold-holdDebit;values.stack_prefund_raw=stack-(debit-holdDebit);
  await query(`update strategy_cash_balances set unclassified_raw=$3,allocated_cash_raw=$4,unallocated_hold_raw=$5,stack_prefund_raw=$6,updated_at=clock_timestamp() where chain_id=$1 and portfolio_id=$2`,[c.chainId,c.portfolioId,...buckets.slice(0,4).map(key=>(values[key]??0n).toString())]);
  for(const e of fresh)await query(`insert into operations(portfolio_id,type,state,idempotency_key,payload_hash,tx_hash) values($1,'withdraw','confirmed',$2,$3,$4)`,[c.portfolioId,identity(c.chainId,e),commitment(e),e.txHash]);
}
