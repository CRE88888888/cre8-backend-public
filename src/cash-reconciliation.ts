import { decodeEventLog, erc20Abi, keccak256, toHex } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import type { SchedulerQueryFn } from './scheduler.js';

export type CashWithdrawal = { txHash:Hex; logIndex:number; blockNumber:bigint; blockHash:Hex; amount:bigint };
const identity=(chainId:number,e:CashWithdrawal)=>`cash-withdrawal:${chainId}:${e.txHash}:${e.logIndex}`;
const commitment=(e:CashWithdrawal)=>keccak256(toHex(JSON.stringify([e.txHash,e.logIndex,e.blockNumber.toString(),e.blockHash,e.amount.toString()])));

/** Only canonical account-to-owner transfers count as known withdrawals. Balance loss alone is not proof. */
export async function readCashWithdrawals(client:PublicClient,query:SchedulerQueryFn,args:{chainId:number;portfolioId:number;account:Address;cash:Address;blockNumber:bigint}):Promise<CashWithdrawal[]>{
  try{
    const owner=(await query('select owner from smart_accounts where portfolio_id=$1 and chain_id=$2 and address=$3',[args.portfolioId,args.chainId,args.account])).rows[0] as {owner?:string}|undefined;
    if(!owner?.owner||!/^0x[0-9a-f]{40}$/.test(owner.owner))throw new Error('owner missing');
    const first=(await query("select block_number::text,log_index::text from strategy_funding_lots where portfolio_id=$1 and chain_id=$2 and state='confirmed' order by block_number,log_index limit 1",[args.portfolioId,args.chainId])).rows[0] as {block_number:string;log_index:string}|undefined;
    if(!first)return [];
    if(BigInt(first.block_number)>args.blockNumber||await client.getChainId()!==args.chainId)throw new Error('stale cash observation');
    const logs=await client.getLogs({address:args.cash,event:erc20Abi.find(e=>e.type==='event'&&e.name==='Transfer'),args:{from:args.account,to:owner.owner as Address},fromBlock:BigInt(first.block_number),toBlock:args.blockNumber,strict:true});
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
    return result;
  }catch{throw new Error('[CASH_RECONCILIATION_UNAVAILABLE] 提領證據無法確認，保留來源與預留');}
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
