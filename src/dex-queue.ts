import { getPool } from './db.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import type {PoolClient} from 'pg';
import type {Hex} from 'viem';
import type {SchedulerQueryFn} from './scheduler.js';
const lockClient=new AsyncLocalStorage<PoolClient>();
export function createDexGate(query:SchedulerQueryFn,chain:{transactionBlock:(hash:Hex)=>Promise<bigint>;blockNumber:()=>Promise<bigint>}){
  return async(chainId:number,portfolioId:number):Promise<string|null>=>{
    const rows=await query(`select o.id from operations o join smart_accounts s on s.portfolio_id=o.portfolio_id
      where s.chain_id=$1 and o.portfolio_id<>$2 and (o.state in ('pending','submitted') or
        (o.state='failed' and (o.user_op_hash is not null or o.tx_hash is not null))) limit 1`,[chainId,portfolioId]);
    if(rows.rows.length)return '[DEX_QUEUED] 共用市場仍有未知操作，等待對帳';
    const recent=(await query(`select o.tx_hash from operations o join smart_accounts s on s.portfolio_id=o.portfolio_id
      where s.chain_id=$1 and o.tx_hash is not null and o.state in ('confirmed','reverted') order by o.updated_at desc,o.id desc limit 1`,[chainId])).rows[0] as {tx_hash:Hex}|undefined;
    if(recent){
      const [landed,head]=await Promise.all([Promise.resolve().then(()=>chain.transactionBlock(recent.tx_hash)),Promise.resolve().then(()=>chain.blockNumber())]);
      if(head<=landed)return '[DEX_QUEUED] 已確認，等待下一區塊後重新報價';
    }
    return null;
  };
}
/** A disconnected session has lost its advisory lock. Check again before a signature/send. */
export async function assertDexLock():Promise<void>{
  const client=lockClient.getStore();
  if(client)await client.query('select 1').catch(()=>{throw new Error('DEX lock lost; not signing or broadcasting');});
}

/** One conservative DEX lane per chain, shared by legacy and typed strategies.
 * operations are the durable queue occupancy; the advisory lock only closes the
 * snapshot -> pending-commit race. A dead worker never releases an unknown attempt.
 * This also covers shared multi-hop pools and opaque aggregator routes.
 */
export async function withDexLock<T>(chainId:number,fn:()=>Promise<T>):Promise<T|null>{
  const client=await getPool().connect().catch(()=>{throw new Error('DEX queue connection unavailable');});
  let held=false,healthy=true;
  const failed=()=>{healthy=false;};client.on('error',failed);
  try{
    held=(await client.query<{held:boolean}>('select pg_try_advisory_lock(830083,$1::int) as held',[chainId])
      .catch(()=>{healthy=false;throw new Error('DEX queue lock unavailable');})).rows[0]?.held===true;
    if(!held)return null;
    const result=await lockClient.run(client,fn);
    if(!healthy)throw new Error('DEX lock connection lost; reconcile before retry');
    return result;
  }finally{
    if(held)try{healthy=(await client.query<{held:boolean}>('select pg_advisory_unlock(830083,$1::int) as held',[chainId])).rows[0]?.held===true&&healthy;}catch{healthy=false;}
    client.removeListener('error',failed);client.release(!healthy);
  }
}
