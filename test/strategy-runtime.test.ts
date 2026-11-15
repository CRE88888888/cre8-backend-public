import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicClient, custom, decodeFunctionData, encodeFunctionResult, isHex, parseAbi } from 'viem';
import type { Address } from 'viem';
import { TWAP_PRICE_SOURCE } from '../src/positions.js';
import { bscTestnet } from 'viem/chains';
import { defaultNewMoneyDeps } from '../src/strategy-runtime.js';
import { TESTNET_97 as P } from '../src/testnet-profile.js';
import type { PortfolioPlan } from '../src/snapshot.js';
import type { DuePortfolio, SchedulerQueryFn } from '../src/scheduler.js';

test('#92 policy preserves buyAllowance raw units and converts only USD-E8 leg limits; failures cannot authorize buys', async () => {
  const U=10n**18n,cash=P.contracts.usdt,asset=P.assets.WBNB.token,account=P.roles.operator;
  const abi=parseAbi(['function oracle() view returns(address)','function buyAllowance(address) view returns(uint256,uint256,uint64)',
    'function minBatchFee() view returns(uint256)','function minFeeTopUp(uint256,uint256) view returns(uint256)','function effectiveFeeBps(uint256) view returns(uint16)',
    'function oracleOf(address) view returns(address)','function pool() view returns(address)','function fee() view returns(uint24)',
    'function previewSwap(address,address,uint256) view returns(uint256,uint256)','function token0() view returns(address)',
    'function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint32,bool)','function liquidity() view returns(uint128)']);
  const uppers:bigint[]=[];
  const state={cap:1100n*U,bought:0n,limit:'5000',failure:'',uppers};
  const client=createPublicClient({chain:bscTestnet,transport:custom({request:async({method,params})=>{
    assert.equal(method,'eth_call');assert.ok(Array.isArray(params));const raw:unknown=params[0];
    assert.ok(typeof raw==='object'&&raw!==null);const data:unknown=Reflect.get(raw,'data');assert.ok(typeof data==='string'&&isHex(data));
    const call=decodeFunctionData({abi,data});assert.equal(params[1],'0x14');
    if(state.failure===call.functionName)throw new Error('private upstream credential');
    const result=(value:bigint|number|Address|readonly [bigint,bigint]|readonly [bigint,bigint,bigint]|readonly [bigint,number,number,number,number,number,boolean])=>encodeFunctionResult({abi,functionName:call.functionName,result:value});
    switch(call.functionName){
      case 'oracle':return result(P.contracts.router);
      case 'buyAllowance':return result([state.cap,state.bought,0n]);
      case 'minBatchFee':return result(3n*U/10n);
      case 'minFeeTopUp':return result(27n*U/100n);
      case 'effectiveFeeBps':return result(10);
      case 'oracleOf':return result(P.assets.WBNB.oracle);
      case 'pool':return result(P.assets.WBNB.pool);
      case 'fee':return result(500);
      case 'token0':return result(cash);
      case 'slot0':return result([1n<<96n,0,0,10,10,0,true]);
      case 'liquidity':return result(10n**30n);
      case 'previewSwap':state.uppers.push(call.args[2]);return result([call.args[2],call.args[2]*99n/100n]);
    }
  }},{retryCount:0})});
  const due:DuePortfolio={portfolioId:1,strategyId:1,version:1,account,accountType:'KERNEL',intervalSeconds:60,unsupportedReason:null,nextRunAt:new Date(0)};
  const plan:PortfolioPlan={portfolioId:1,strategyId:1,account,chainId:97,
    snapshot:{portfolioId:1,block:20n,nativeBalanceWei:0n,holdings:[{asset:cash,amountWei:1100n*U,decimals:18,usdPriceE8:100000000n,priceSource:TWAP_PRICE_SOURCE}],unpriced:[]},
    scan:{portfolioId:1,block:20n,cursor:{portfolioId:1,startBlock:1n,lastScannedBlock:20n},scannedRange:null,candidateCount:0,unknownHoldings:[],zeroBalanceCount:0,unreadableCandidates:[],deployment:{block:1n,reason:'resolved',detail:'test'},universeComplete:true,incompleteReasons:[]},
    targets:[{asset,weightBps:10000,symbol:'WBNB'}],report:null,blocked:[],pinnedVersion:{version:1,onchainStrategyId:1,paused:false},allocationCheck:{consistent:true,chain:[],mismatches:[]},thresholdBps:100};
  const query:SchedulerQueryFn=async()=>{if(state.failure==='DB')throw new Error('private database credential');return {rows:state.failure==='missing'?[]:[{address:asset,max_leg_usdt:state.limit}]};};
  const deps=defaultNewMoneyDeps(()=>client,()=>P.contracts.executor,()=>P.contracts.registry,query,56);
  assert.equal((await deps.policy(due,plan,[asset])).buyLimit,1078n*U);
  assert.equal(state.uppers[0],5000n*U,'only max_leg_usdt converts through USD-E8');
  state.bought=78n*U;assert.equal((await deps.policy(due,plan,[asset])).buyLimit,1000n*U);
  // A NULL DB limit uses the exact raw buy allowance as the depth-search bound.
  const unlimited=defaultNewMoneyDeps(()=>client,()=>P.contracts.executor,()=>P.contracts.registry,async()=>({rows:[{address:asset,max_leg_usdt:null}]}),56);
  state.uppers=[];await unlimited.policy(due,plan,[asset]);assert.equal(state.uppers[0],1000n*U);
  state.limit='5000';state.bought=1078n*U;assert.equal((await deps.policy(due,plan,[asset])).buyLimit,0n);
  state.bought=0n;state.cap=0n;assert.equal((await deps.policy(due,plan,[asset])).buyLimit,0n);
  state.cap=1100n*U;
  for(const failure of ['buyAllowance','DB','missing','previewSwap','slot0']){
    state.failure=failure;
    await assert.rejects(deps.policy(due,plan,[asset]),(error:unknown)=>error instanceof Error&&!error.message.includes('credential'));
  }
});
