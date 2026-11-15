import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicClient, custom } from 'viem';
import { readCashWithdrawals } from '../src/cash-reconciliation.js';
import type { SchedulerQueryFn } from '../src/scheduler.js';
import { TESTNET_97 } from '../src/testnet-profile.js';
import { strategyRpc, TEST_ACCOUNT, TEST_OWNER, TEST_AMOUNT, OTHER_HASH } from './fixtures/strategy-rpc.js';

function fixture() {
  const rpc = strategyRpc({assets:[]}, OTHER_HASH, new Date('2026-11-15T00:00:00Z'));
  Object.assign(rpc.state,{mint:true,transferFrom:TEST_ACCOUNT,to:TEST_OWNER,logIndex:1});
  const state:{fail:string;owner:string}={fail:'',owner:TEST_OWNER};
  const client=createPublicClient({transport:custom({request:async({method,params})=>{
    if(state.fail===method)throw new Error('SECRET_RPC_CREDENTIAL');
    if(method==='eth_getLogs')return (await rpc.client.request({method:'eth_getTransactionReceipt',params:[OTHER_HASH]}))?.logs;
    return rpc.client.transport.request({method,params});
  }},{retryCount:0})});
  const query:SchedulerQueryFn=async sql=>{
    if(state.fail==='DB')throw new Error('SECRET_DB_CREDENTIAL');
    return {rows:sql.includes('smart_accounts')?[{owner:state.owner}]:[{block_number:'130',log_index:'0'}]};
  };
  const args={chainId:97,portfolioId:1,account:TEST_ACCOUNT,cash:TESTNET_97.contracts.usdt,blockNumber:130n};
  return {rpc,state,client,query,args};
}

test('#96 known withdrawal requires exact canonical owner transfer after funding at the observed block',async()=>{
  const f=fixture();const result=await readCashWithdrawals(f.client,f.query,f.args);
  assert.equal(result.length,1);assert.equal(result[0]?.amount,TEST_AMOUNT);
  f.rpc.state.logIndex=0;assert.deepEqual(await readCashWithdrawals(f.client,f.query,f.args),[],'funding-position and older transfers cannot debit the lot');
});

test('#96 withdrawal RPC/DB failure, reorg, missing receipt and wrong identity preserve cash',async()=>{
  for(const scenario of ['eth_getLogs','eth_getTransactionReceipt','eth_getBlockByNumber','DB','owner','chain','reorg','revert','removed','token','receipt','stale'] as const){
    const f=fixture();
    if(scenario==='owner')f.state.owner='';
    else if(scenario==='chain')f.rpc.state.chainId=56;
    else if(scenario==='reorg')f.rpc.state.blockHash=OTHER_HASH;
    else if(scenario==='revert')f.rpc.state.success=false;
    else if(scenario==='removed')f.rpc.state.removed=true;
    else if(scenario==='token')f.rpc.state.token=TESTNET_97.assets.WBNB.token;
    else if(scenario==='receipt')f.rpc.state.missingReceipt=true;
    else if(scenario==='stale')f.args.blockNumber=129n;
    else f.state.fail=scenario;
    await assert.rejects(readCashWithdrawals(f.client,f.query,f.args),(error:unknown)=>error instanceof Error&&error.message.includes('CASH_RECONCILIATION_UNAVAILABLE')&&!error.message.includes('SECRET'),scenario);
  }
});
