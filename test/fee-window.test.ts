import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createPublicClient,custom,decodeFunctionData,encodeFunctionResult,isHex,parseAbi} from 'viem';
import {bscTestnet,bsc} from 'viem/chains';
import {checkBuyFeeReserve,minimumFeeReserve} from '../src/rebalance-plan.js';
import type {PlannedStep} from '../src/rebalance-plan.js';
import {windowBasketBatch,subtractInputs,sumInputs,USDT_UNIT as U} from '../src/new-money-plan.js';
import {TESTNET_97 as P} from '../src/testnet-profile.js';

function fixture(mainnet=false){
  const abi=parseAbi(['function minBatchFee() view returns(uint256)','function minFeeTopUp(uint256,uint256) view returns(uint256)',
    'function minFeeDue(address,uint256) view returns(uint256)','function minFeeWindowOf(address) view returns(uint64,uint192,uint256)',
    'function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)',
    'function effectiveFeeBps(uint256) view returns(uint16)']);
  const state={now:10000n,start:0n,notional:0n,paid:0n,cash:100n*U,allowance:100n*U,fee:10,minimum:3n*U/10n,fail:'',reads:[] as string[]};
  const topUp=(notional:bigint)=>{const minimum=notional/100n<state.minimum?notional/100n:state.minimum,proportional=notional*BigInt(state.fee)/10000n;return minimum>proportional?minimum-proportional:0n;};
  const client=createPublicClient({chain:mainnet?bsc:bscTestnet,transport:custom({request:async({method,params})=>{
    if(state.fail===method)throw new Error('private-upstream-credential');
    if(method==='eth_getBlockByNumber')return {number:'0x14',timestamp:'0x'+state.now.toString(16),transactions:[]};
    assert.equal(method,'eth_call');assert.ok(Array.isArray(params));const raw:unknown=params[0];assert.ok(typeof raw==='object'&&raw!==null);
    const data:unknown=Reflect.get(raw,'data');assert.ok(typeof data==='string'&&isHex(data));
    const call=decodeFunctionData({abi,data});assert.equal(params[1],'0x14');state.reads.push(call.functionName);
    if(state.fail===call.functionName)throw new Error('private-upstream-credential');
    const result=(value:bigint|number|readonly [bigint,bigint,bigint])=>encodeFunctionResult({abi,functionName:call.functionName,result:value});
    switch(call.functionName){
      case 'minBatchFee':return result(state.minimum);
      case 'minFeeTopUp':return result(topUp(call.args[1]));
      case 'minFeeWindowOf':return result([state.start,state.notional,state.paid]);
      case 'minFeeDue':{
        assert.equal(call.args[0].toLowerCase(),P.roles.operator.toLowerCase());
        const active=state.start!==0n&&state.now<state.start+3600n;
        const owed=topUp(call.args[1]+(active?state.notional:0n)),paid=active?state.paid:0n;
        return result(call.args[1]===0n||paid>=owed?0n:owed-paid);
      }
      case 'balanceOf':return result(state.cash);
      case 'allowance':return result(state.allowance);
      case 'effectiveFeeBps':return result(state.fee);
    }
  }},{retryCount:0})});
  const step:PlannedStep={tokenIn:P.contracts.usdt,tokenOut:P.assets.WBNB.token,amountIn:100n*U,amountOutMin:U,oracleFloor:U,venue:P.contracts.universalRouter,data:'0x'};
  const args={client,executor:P.contracts.executor,account:P.roles.operator,strategyId:1n,registry:P.contracts.registry,steps:[step],numeraire:P.contracts.usdt,blockNumber:20n,maximumReserve:0n};
  return {state,client,args};
}
test('#100 fee window reserve honors dust debt, paid windows, exact expiry and zero minimum',async()=>{
  const {state,client}=fixture();
  const reserve=()=>minimumFeeReserve(client,P.contracts.executor,1n,20n,P.roles.operator);
  assert.equal(await reserve(),27n*U/100n);
  state.start=state.now;state.notional=U;state.paid=9n*U/1000n;
  assert.equal(await reserve(),261n*U/1000n,'dust first batch cannot exhaust the minimum');
  state.notional=100n*U;state.paid=2n*U/10n;
  assert.equal(await reserve(),0n,'window second purchase owes no further minimum');
  state.now=state.start+3599n;assert.equal(await reserve(),0n);
  state.now++;assert.equal(await reserve(),27n*U/100n,'exactly one hour starts a fresh window');
  state.minimum=0n;assert.equal(await reserve(),0n);
  state.minimum=5n*U;state.fee=0;assert.equal(await reserve(),5n*U,'zero proportional fee at the contract minimum ceiling');
  state.fee=300;assert.equal(await reserve(),0n,'fees above the 1% cap never need a top-up');
  for(const failure of ['eth_getBlockByNumber','minBatchFee','minFeeWindowOf','minFeeDue']){state.fail=failure;await assert.rejects(reserve(),e=>e instanceof Error&&e.message.includes('MIN_FEE_UNAVAILABLE')&&!e.message.includes('credential'));}
});
test('#100 pre-send exact due checks balance/allowance/budget; paid window passes, expiry and RPC failure block',async()=>{
  const {state,args}=fixture();
  state.start=state.now;state.notional=100n*U;state.paid=2n*U/10n;
  await checkBuyFeeReserve(args);
  state.now+=3600n;await assert.rejects(checkBuyFeeReserve(args),/MIN_FEE_RESERVE/);
  const due=2n*U/10n;
  state.cash+=due;state.allowance+=due;
  await checkBuyFeeReserve({...args,maximumReserve:due});
  state.cash--;await assert.rejects(checkBuyFeeReserve({...args,maximumReserve:due}),/MIN_FEE_RESERVE/);state.cash++;
  state.allowance--;await assert.rejects(checkBuyFeeReserve({...args,maximumReserve:due}),/MIN_FEE_RESERVE/);state.allowance++;
  for(const failure of ['minFeeDue','balanceOf','allowance','effectiveFeeBps']){state.fail=failure;await assert.rejects(checkBuyFeeReserve({...args,maximumReserve:due}),e=>e instanceof Error&&e.message.includes('MIN_FEE_RESERVE')&&!e.message.includes('credential'));}
});
test('#100 chain 56 retains legacy reserve and never calls window selectors',async()=>{
  const {state,client,args}=fixture(true);
  assert.equal(await minimumFeeReserve(client,P.contracts.executor,1n,20n,P.roles.operator),27n*U/100n);
  state.cash+=27n*U/100n;state.allowance=state.cash;
  await checkBuyFeeReserve({...args,maximumReserve:27n*U/100n});
  assert.ok(!state.reads.includes('minFeeDue')&&!state.reads.includes('minFeeWindowOf'));
});
test('#100 first 100-USDT child includes reserve and leaves a full 50-USDT second child',()=>{
  const reserve=27n*U/100n,inputs={a:(100n*U-reserve).toString()};
  const first=windowBasketBatch(inputs,2n,reserve),remaining=subtractInputs(inputs,first);
  assert.equal(sumInputs(first)+reserve,50n*U);assert.equal(sumInputs(remaining),50n*U);
  assert.deepEqual(windowBasketBatch(remaining,1n,0n),remaining);
  for(const r of [0n,1n,reserve])for(const count of [1n,2n,7n]){
    const vector={a:(999n*U+1n).toString(),b:(101n*U+3n).toString()};
    const batch=windowBasketBatch(vector,count,r);assert.equal(sumInputs(batch)+sumInputs(subtractInputs(vector,batch)),sumInputs(vector));
  }
  assert.throws(()=>windowBasketBatch(inputs,0n,reserve));assert.throws(()=>windowBasketBatch(inputs,2n,-1n));
});
test('#100 window partition never spends beyond a final one-raw-unit asset',()=>{
  const vector={a:'100',b:'100',c:'1'};
  const child=windowBasketBatch(vector,2n,1n,101n);
  assert.doesNotThrow(()=>subtractInputs(vector,child));assert.equal(sumInputs(child),100n);
});
