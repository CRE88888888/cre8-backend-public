import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createPublicClient,custom,decodeFunctionData,encodeAbiParameters,encodeEventTopics,encodeFunctionResult,isHex,parseAbi} from 'viem';
import type {Address,Hex} from 'viem';
import type {UserOperationReceipt} from 'viem/account-abstraction';
import {bscTestnet} from 'viem/chains';
import {checkBuyFeeReserve,readFeeDue,FEE_WINDOW_ROLL_MARGIN_SECONDS} from '../src/rebalance-plan.js';
import {principalWithinFee,reduceInputs,sumInputs,USDT_UNIT as U} from '../src/new-money-plan.js';
import {fitChildToFee} from '../src/strategy-runtime.js';
import {strategyReceiptEvidence} from '../src/scheduler.js';
import {TESTNET_97 as P} from '../src/testnet-profile.js';

// The executor's rule (AtpExecutor._minFeeTopUp): T(c) = max(0, min(minBatchFee, c x 1%) - c x feeBps), per account and hour.
const MIN=3n*U/10n;
const topUp=(notional:bigint,feeBps=10n)=>{const minimum=notional/100n<MIN?notional/100n:MIN,proportional=notional*feeBps/10000n;return minimum>proportional?minimum-proportional:0n;};
const usdt=(text:string)=>{const [whole,fraction='']=text.split('.');return BigInt(whole??'0')*U+BigInt((fraction+'0'.repeat(18)).slice(0,18));};
const fresh=async(n:bigint)=>topUp(n);

test('portfolio 17: 18.7331 USDT left with 0.1207 fee buys 18.6856 and pays 0.1682, all of it inside the 18.8538 the job holds',async()=>{
  const principal=usdt('18.7331'),feeLeft=usdt('0.1207'),budget=principal+feeLeft;
  // What refused the child every round: the top-up is 0.1686 and the job had 0.1207 left for it.
  assert.equal(await fresh(principal),usdt('0.1685979'));assert.ok(await fresh(principal)>feeLeft);
  const reads:bigint[]=[];
  const fit=await principalWithinFee(principal,budget,async n=>{reads.push(n);return fresh(n);});
  assert.ok(fit);assert.ok(reads.length<=5,'bounded chain reads');
  assert.equal(fit.fee,await fresh(fit.principal),'the fee is the executor figure at the size actually sent');
  assert.ok(fit.principal+fit.fee<=budget,'never more than the job holds');
  assert.equal((fit.principal+U/20000n)/(U/10000n),186856n,'buys 18.6856');
  assert.equal((fit.fee+U/20000n)/(U/10000n),1682n,'pays 0.1682');
  // Within 0.00001 USDT of the largest size that fits: nothing meaningful is left unused.
  const more=fit.principal+U/100000n;assert.ok(more+await fresh(more)>budget);
  assert.ok(budget-fit.principal-fit.fee<U/100000n);
});

test('a child whose fee is already covered is sent unchanged with one read',async()=>{
  let reads=0;
  const fit=await principalWithinFee(100n*U,100n*U+27n*U/100n,async n=>{reads++;return fresh(n);});
  assert.deepEqual(fit,{principal:100n*U,fee:2n*U/10n});assert.equal(reads,1);
});

test('sizes past the 1% cap, where a smaller buy owes a larger top-up, still land inside the budget',async()=>{
  // 100 USDT child, 0.07 fee left (the first window used 0.2 of the 0.27): T(100) = 0.2.
  for(const [p,f] of [[100n*U,7n*U/100n],[31n*U,0n],[30n*U,1n],[29n*U+U/2n,0n],[200n*U,0n],[299n*U,0n],[10n*U,U/100n]] as const){
    const fit=await principalWithinFee(p,p+f,fresh);assert.ok(fit,`${p} ${f}`);
    assert.ok(fit.principal<p&&fit.principal+fit.fee<=p+f);
    assert.equal(fit.fee,await fresh(fit.principal));
    assert.ok(p+f-fit.principal-fit.fee<U/1000n,'the unused part stays under 0.001 USDT');
  }
});

test('no size fits when the fee owed exceeds everything the child holds; failures of the read are not swallowed',async()=>{
  assert.equal(await principalWithinFee(U,U,async()=>2n*U),null);
  await assert.rejects(principalWithinFee(U,U,async()=>{throw new Error('[MIN_FEE_UNAVAILABLE]');}),/MIN_FEE_UNAVAILABLE/);
  await assert.rejects(principalWithinFee(0n,0n,fresh),RangeError);
  await assert.rejects(principalWithinFee(2n*U,U,fresh),RangeError);
});

test('the missing fee comes out of every leg in proportion; a leg at its floor keeps it and the others carry the rest',()=>{
  const inputs={a:(6n*U).toString(),b:(3n*U).toString(),c:U.toString()};
  const even=reduceInputs(inputs,U,()=>0n);assert.ok(even);
  assert.equal(sumInputs(even),9n*U);assert.deepEqual(even,{a:(54n*U/10n).toString(),b:(27n*U/10n).toString(),c:(9n*U/10n).toString()});
  const floored=reduceInputs(inputs,U,asset=>asset==='c'?U:0n);assert.ok(floored);
  assert.equal(floored.c,U.toString(),'the 1 USDT leg is not pushed under 1 USDT');
  assert.equal(sumInputs(floored),9n*U);assert.ok(BigInt(floored.a??'0')<6n*U&&BigInt(floored.b??'0')<3n*U);
  // Exact to the raw unit, never below a floor, never above the original.
  for(const shortfall of [1n,7n,U/3n,2n*U-1n]){
    const result=reduceInputs({a:'5000000000000000001',b:'1999999999999999999',c:'1000000000000000000',d:'3'},shortfall,asset=>asset==='d'?1n:U);
    assert.ok(result);assert.equal(sumInputs(result),8n*U+3n-shortfall);
    for(const [asset,value] of Object.entries(result))assert.ok(BigInt(value)>=(asset==='d'?1n:U));
  }
  assert.equal(reduceInputs({a:U.toString(),b:U.toString()},1n,()=>U),null,'legs already at 1 USDT cannot give anything');
  assert.equal(reduceInputs(inputs,10n*U+1n,()=>0n),null);
  assert.deepEqual(reduceInputs(inputs,0n,()=>U),inputs);
  assert.throws(()=>reduceInputs(inputs,-1n,()=>0n),RangeError);
});

test('fitChildToFee: Mag7-sized last child keeps all seven legs and reports the principal that pays the fee',async()=>{
  const each=usdt('18.7331')/7n,inputs=Object.fromEntries(['a','b','c','d','e','f','g'].map((asset,i)=>[asset,(each+(i===0?usdt('18.7331')-each*7n:0n)).toString()]));
  assert.equal(sumInputs(inputs),usdt('18.7331'));
  const fitted=await fitChildToFee(inputs,usdt('0.1207'),fresh,new Set());assert.ok(fitted);
  assert.equal(Object.keys(fitted.inputs).length,7);
  assert.equal(sumInputs(inputs)-sumInputs(fitted.inputs),fitted.fromPrincipal);
  assert.equal((fitted.fromPrincipal+U/20000n)/(U/10000n),475n,'0.0475 of principal pays the fee');
  for(const [asset,value] of Object.entries(fitted.inputs))assert.ok(BigInt(value)<BigInt(inputs[asset]??'0')&&BigInt(value)>=U);
  assert.ok(sumInputs(fitted.inputs)+await fresh(sumInputs(fitted.inputs))<=usdt('18.8538'));
  // Covered fee: same object back, nothing taken.
  assert.deepEqual(await fitChildToFee(inputs,27n*U/100n,fresh,new Set()),{inputs,fromPrincipal:0n});
  // Ten non-final 1 USDT legs cannot give the 0.09 top-up; final installments can go under 1 USDT.
  const ones=Object.fromEntries(Array.from({length:10},(_,i)=>[`t${i}`,U.toString()]));
  assert.equal(await fitChildToFee(ones,0n,fresh,new Set()),null);
  const final=await fitChildToFee(ones,0n,fresh,new Set(Object.keys(ones)));assert.ok(final);assert.ok(final.fromPrincipal>0n);
  // Whole-basket (hold / legacy) children keep 5 USDT per leg.
  assert.equal(await fitChildToFee({a:(5n*U).toString(),b:(5n*U).toString()},0n,fresh,undefined),null);
});

function chain(){
  const abi=parseAbi(['function minFeeTopUp(uint256,uint256) view returns(uint256)','function minFeeDue(address,uint256) view returns(uint256)',
    'function minFeeWindowOf(address) view returns(uint64,uint192,uint256)','function balanceOf(address) view returns(uint256)',
    'function allowance(address,address) view returns(uint256)','function effectiveFeeBps(uint256) view returns(uint16)']);
  const state={now:10000n,start:0n,notional:0n,paid:0n,cash:0n,allowance:10n**30n,fail:'',reads:[] as string[]};
  const client=createPublicClient({chain:bscTestnet,transport:custom({request:async({method,params})=>{
    if(state.fail===method)throw new Error('private-upstream-credential');
    if(method==='eth_getBlockByNumber')return {number:'0x14',timestamp:'0x'+state.now.toString(16),transactions:[]};
    assert.equal(method,'eth_call');assert.ok(Array.isArray(params));const raw:unknown=params[0];assert.ok(typeof raw==='object'&&raw!==null);
    const data:unknown=Reflect.get(raw,'data');assert.ok(typeof data==='string'&&isHex(data));
    const call=decodeFunctionData({abi,data});assert.equal(params[1],'0x14');state.reads.push(call.functionName);
    if(state.fail===call.functionName)throw new Error('private-upstream-credential');
    const result=(value:bigint|number|readonly [bigint,bigint,bigint])=>encodeFunctionResult({abi,functionName:call.functionName,result:value});
    switch(call.functionName){
      case 'minFeeTopUp':return result(topUp(call.args[1]));
      case 'minFeeWindowOf':return result([state.start,state.notional,state.paid]);
      case 'minFeeDue':{
        const active=state.start!==0n&&state.now<state.start+3600n;
        const owed=topUp(call.args[1]+(active?state.notional:0n)),paid=active?state.paid:0n;
        return result(call.args[1]===0n||paid>=owed?0n:owed-paid);
      }
      case 'balanceOf':return result(state.cash);
      case 'allowance':return result(state.allowance);
      case 'effectiveFeeBps':return result(10);
    }
  }},{retryCount:0})});
  return {state,client};
}

test('readFeeDue: the executor figure for this account; near the end of its window the fresh-window figure if higher',async()=>{
  const {state,client}=chain();
  const read=()=>readFeeDue(client,P.contracts.executor,P.roles.operator,1n,20n);
  const n=usdt('18.7331');
  assert.equal(await (await read())(n),topUp(n),'no window yet: a fresh one');
  assert.equal(await (await read())(0n),0n);
  // Open window that already paid its minimum: nothing more is due, and with plenty of time left that is the answer.
  state.start=state.now;state.notional=100n*U;state.paid=2n*U/10n;state.reads.length=0;
  const open=await read();assert.equal(await open(n),0n);
  assert.ok(!state.reads.includes('minFeeTopUp'),'an open window needs no second read');
  // Same window with less than the margin left: a batch can land after it closes, so size for the fresh window.
  state.now=state.start+3600n-FEE_WINDOW_ROLL_MARGIN_SECONDS;assert.equal(await (await read())(n),topUp(n));
  state.now=state.start+3600n-FEE_WINDOW_ROLL_MARGIN_SECONDS-1n;assert.equal(await (await read())(n),0n);
  // A window that still owes more than a fresh one (short-paid earlier): the higher figure.
  state.now=state.start+3500n;state.notional=20n*U;state.paid=0n;assert.equal(await (await read())(10n*U),topUp(30n*U));
  state.now=state.start+3600n;assert.equal(await (await read())(n),topUp(n),'expired window');
  for(const failure of ['minFeeWindowOf','eth_getBlockByNumber']){state.fail=failure;await assert.rejects(read(),e=>e instanceof Error&&e.message.includes('MIN_FEE_UNAVAILABLE')&&!e.message.includes('credential'));}
  state.fail='';const due=await read();
  for(const failure of ['minFeeDue','minFeeTopUp']){state.fail=failure;await assert.rejects(due(n),e=>e instanceof Error&&e.message.includes('MIN_FEE_UNAVAILABLE')&&!e.message.includes('credential'));}
});

test('portfolio 17 on-chain numbers: the pre-send check refuses the full child and passes the fitted one',async()=>{
  const {state,client}=chain();
  state.cash=usdt('18.8539');
  const step=(amountIn:bigint)=>({tokenIn:P.contracts.usdt,tokenOut:P.assets.WBNB.token,amountIn,amountOutMin:U,oracleFloor:U,venue:P.contracts.universalRouter,data:'0x' as Hex});
  const args={client,executor:P.contracts.executor,account:P.roles.operator,strategyId:1n,registry:P.contracts.registry,numeraire:P.contracts.usdt,blockNumber:20n};
  const feeLeft=usdt('0.1207'),principal=usdt('18.7331');
  await assert.rejects(checkBuyFeeReserve({...args,steps:[step(principal)],maximumReserve:feeLeft}),/MIN_FEE_RESERVE/);
  const fitted=await fitChildToFee({[P.assets.WBNB.token]:principal.toString()},feeLeft,await readFeeDue(client,P.contracts.executor,P.roles.operator,1n,20n),new Set());
  assert.ok(fitted);
  await checkBuyFeeReserve({...args,steps:[step(sumInputs(fitted.inputs))],maximumReserve:feeLeft+fitted.fromPrincipal});
  // One raw unit less fee budget than the principal given up is refused: the budget is exactly what the child gave.
  assert.ok(feeLeft+fitted.fromPrincipal-topUp(sumInputs(fitted.inputs))<U/100000n);
});

function receipt(account:Address,swaps:readonly {token:Address;amountIn:bigint;net:bigint}[],charged:bigint,notional:bigint):UserOperationReceipt{
  const abi=parseAbi(['event SwapExecuted(address indexed account,address tokenIn,address tokenOut,uint256 amountIn,uint256 gross,uint256 fee,uint256 net,uint256 oracleFloor)',
    'event MinFeeCharged(address indexed account,uint256 notional,uint256 due,uint256 charged)','event Transfer(address indexed from,address indexed to,uint256 value)']);
  const cash=P.contracts.usdt,executor=P.contracts.executor,pool='0x00000000000000000000000000000000000000aa' as Address;
  const log=(address:Address,topics:readonly Hex[],data:Hex)=>({address,topics:[...topics],data,removed:false});
  const logs=swaps.flatMap(s=>[
    log(cash,encodeEventTopics({abi,eventName:'Transfer',args:{from:account,to:pool}}) as Hex[],encodeAbiParameters([{type:'uint256'}],[s.amountIn])),
    log(s.token,encodeEventTopics({abi,eventName:'Transfer',args:{from:pool,to:account}}) as Hex[],encodeAbiParameters([{type:'uint256'}],[s.net])),
    log(executor,encodeEventTopics({abi,eventName:'SwapExecuted',args:{account}}) as Hex[],encodeAbiParameters(
      [{type:'address'},{type:'address'},{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'uint256'},{type:'uint256'}],[cash,s.token,s.amountIn,s.net+1n,1n,s.net,1n])),
  ]);
  if(charged>0n){
    logs.push(log(cash,encodeEventTopics({abi,eventName:'Transfer',args:{from:account,to:pool}}) as Hex[],encodeAbiParameters([{type:'uint256'}],[charged])));
    logs.push(log(executor,encodeEventTopics({abi,eventName:'MinFeeCharged',args:{account}}) as Hex[],encodeAbiParameters([{type:'uint256'},{type:'uint256'},{type:'uint256'}],[notional,charged,charged])));
  }
  return {logs,receipt:{blockNumber:21n,blockHash:`0x${'11'.repeat(32)}`}} as unknown as UserOperationReceipt;
}

test('receipt evidence: swaps may spend less than the batch principal (the rest paid the fee), never more, and report what they spent',()=>{
  const account=P.roles.operator,a=P.assets.WBNB.token,b=P.assets.ETH.token,cash=P.contracts.usdt,executor=P.contracts.executor;
  const steps=[a,b].map(token=>({tokenIn:cash,tokenOut:token,amountIn:9n*U,amountOutMin:1n}));
  const swaps=[a,b].map(token=>({token,amountIn:9n*U,net:5n}));
  const charged=topUp(18n*U);
  const exact=strategyReceiptEvidence(receipt(account,swaps,charged,18n*U),steps,{[a]:(9n*U).toString(),[b]:(9n*U).toString()},account,executor,cash);
  assert.deepEqual(exact.inputs,{[a]:(9n*U).toString(),[b]:(9n*U).toString()});assert.equal(exact.feePaid,charged);
  // The batch row holds the principal taken from the job (9.05 each); the swaps spent 9 each.
  const budget={[a]:(9n*U+U/20n).toString(),[b]:(9n*U+U/20n).toString()};
  const fitted=strategyReceiptEvidence(receipt(account,swaps,charged,18n*U),steps,budget,account,executor,cash);
  assert.deepEqual(fitted.inputs,exact.inputs);assert.equal(fitted.feePaid,charged);
  assert.throws(()=>strategyReceiptEvidence(receipt(account,swaps,charged,18n*U),steps,{[a]:(9n*U-1n).toString(),[b]:(9n*U).toString()},account,executor,cash),/swap evidence mismatch/);
  assert.throws(()=>strategyReceiptEvidence(receipt(account,swaps,charged,18n*U),steps,{[a]:(9n*U).toString()},account,executor,cash),/swap evidence mismatch/);
  // The fee event must describe the swaps that ran, and the cash that left must be swaps plus fee.
  assert.throws(()=>strategyReceiptEvidence(receipt(account,swaps,charged,18n*U+U/10n),steps,budget,account,executor,cash),/fee evidence mismatch/);
  assert.throws(()=>strategyReceiptEvidence(receipt(account,swaps.slice(0,1),charged,18n*U),steps,budget,account,executor,cash),/mismatch/);
});
