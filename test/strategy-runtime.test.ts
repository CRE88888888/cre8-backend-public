import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicClient, custom, decodeFunctionData, encodeFunctionResult, isHex, parseAbi } from 'viem';
import type { Address } from 'viem';
import { TWAP_PRICE_SOURCE } from '../src/positions.js';
import { bscTestnet } from 'viem/chains';
import { defaultNewMoneyDeps, prepareNewMoney } from '../src/strategy-runtime.js';
import type { NewMoneyDeps } from '../src/strategy-runtime.js';
import { TESTNET_97 as P } from '../src/testnet-profile.js';
import type { PortfolioPlan } from '../src/snapshot.js';
import type { DuePortfolio, SchedulerQueryFn } from '../src/scheduler.js';

test('#92 policy preserves buyAllowance raw units and converts only USD-E8 leg limits; failures cannot authorize buys', async () => {
  const U=10n**18n,cash=P.contracts.usdt,asset=P.assets.WBNB.token,account=P.roles.operator;
  const abi=parseAbi(['function oracle() view returns(address)','function buyAllowance(address) view returns(uint256,uint256,uint64)',
    'function minBatchFee() view returns(uint256)','function minFeeTopUp(uint256,uint256) view returns(uint256)','function minFeeDue(address,uint256) view returns(uint256)',
    'function minFeeWindowOf(address) view returns(uint64,uint192,uint256)','function effectiveFeeBps(uint256) view returns(uint16)',
    'function oracleOf(address) view returns(address)','function pool() view returns(address)','function fee() view returns(uint24)',
    'function previewSwap(address,address,uint256) view returns(uint256,uint256)','function token0() view returns(address)',
    'function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint32,bool)','function liquidity() view returns(uint128)']);
  const uppers:bigint[]=[];
  const state={cap:1100n*U,bought:0n,limit:'5000',failure:'',uppers};
  const client=createPublicClient({chain:bscTestnet,transport:custom({request:async({method,params})=>{
    if(method==='eth_getBlockByNumber')return {number:'0x14',timestamp:'0x2710',transactions:[]};
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
      case 'minFeeWindowOf':return result([10000n,100n*U,2n*U/10n]);
      case 'minFeeDue':assert.equal(call.args[0].toLowerCase(),account);return result(0n);
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
  const window=defaultNewMoneyDeps(()=>client,()=>P.contracts.executor,()=>P.contracts.registry,query,97);
  assert.equal((await window.policy(due,plan,[asset])).reserve,0n);
  assert.equal(await window.rebalanceReserve(plan),0n,'all-hold rebalance shares the account window');
  for(const failure of ['buyAllowance','DB','missing','previewSwap','slot0']){
    state.failure=failure;
    await assert.rejects(deps.policy(due,plan,[asset]),(error:unknown)=>error instanceof Error&&!error.message.includes('credential'));
  }
});

test('#104 yield planning projects claim units once, prices missing direct assets and never changes the spendable snapshot',async()=>{
  const U=10n**18n;
  const {yieldFixture,yieldRebalancePlan}=await import('./fixtures/yield.js');
  const f=yieldFixture(['venus']),p=f.read.positions[0];assert.ok(p);
  f.state.claim=4n*U;
  Object.assign(p,{receipt:2n*U,observedUnits:2n*U,trackedUnits:2n*U,claim:4n*U,value:4n*U});
  const plan=yieldRebalancePlan(f,1,3n*U);
  const deps=defaultNewMoneyDeps(()=>f.client,()=>f.executor,()=>f.registry,async()=>({rows:[]}),97);
  const projected=await deps.yieldHoldings(plan);
  assert.equal(projected.snapshot.holdings[0]?.amountWei,7n*U);
  assert.equal(plan.snapshot.holdings[0]?.amountWei,3n*U);
  plan.snapshot.holdings=[];
  const missing=await deps.yieldHoldings(plan);assert.equal(missing.snapshot.holdings[0]?.amountWei,4n*U);
  assert.equal(plan.snapshot.holdings.length,0);
  p.claim=0n;assert.equal((await deps.yieldHoldings(plan)).snapshot.holdings.length,0);
  p.claim=null;await assert.rejects(deps.yieldHoldings(plan));
  p.claim=4n*U;p.state='unknown';await assert.rejects(deps.yieldHoldings(plan));
  p.state='known';f.state.fail='eth_call';await assert.rejects(deps.yieldHoldings(plan));
});

for (const activeVersion of [2, 65535]) for (const dryRun of [false, true]) {
  test(`#124 version ${activeVersion} stops old funding before RPC, DB, reservation or quote (dryRun=${dryRun})`, async () => {
    const { yieldFixture, yieldRebalancePlan } = await import('./fixtures/yield.js');
    const f = yieldFixture(['venus']), plan = yieldRebalancePlan(f);
    plan.pinnedVersion.version = activeVersion;
    const now = new Date('2026-11-16T00:00:00Z');
    const due: DuePortfolio = { portfolioId: 1, strategyId: 1, version: 1, executionKind: 'per_asset', scheduleState: 'active',
      account: f.account, accountType: 'KERNEL', intervalSeconds: 60, unsupportedReason: null, nextRunAt: now };
    let calls = 0;
    const forbidden = () => { calls++; throw new Error('version mismatch must stop before external effects'); };
    const query: SchedulerQueryFn = async () => forbidden();
    const deps: NewMoneyDeps = { version: async () => forbidden(), policy: async () => forbidden(),
      withdrawals: async () => forbidden(), rebalanceReserve: async () => forbidden(), yieldHoldings: async () => forbidden(),
      withdrawYield: async () => forbidden(), verifyLots: async () => forbidden(), quote: async () => forbidden(), feeDue: async () => forbidden(), marketOpen: forbidden };
    for (const version of [1, undefined]) {
      await assert.rejects(prepareNewMoney({ due: { ...due, version }, plan, query, run: async () => forbidden(), chainId: 97, now, dryRun, deps }),
        /\[PINNED_VERSION_CHANGED\]/);
    }
    assert.equal(calls, 0);
  });
}

test('market-hours bypass: new money of the listed test wallet counts stocks as open on chain 97; chain 56 never does', () => {
  const canary = '0xD3Ab39B62E221bF9E8bA19fE19b2638767d3D6D9', other = '0x00000000000000000000000000000000000000a1';
  const closed = new Date('2026-11-26T16:00:00Z'), open = new Date('2026-11-23T15:00:00Z');
  const version = { allocation: { assets: [{ address: P.assets.NVDAB.token, weightBps: 5000 }, { address: P.assets.BTCB.token, weightBps: 5000 }] } } as unknown as Parameters<NewMoneyDeps['marketOpen']>[0];
  const none = () => { throw new Error('unused'); };
  const on = (chainId: number) => defaultNewMoneyDeps(none, none, none, none as unknown as SchedulerQueryFn, chainId).marketOpen;
  assert.equal(on(97)(version, closed), false); assert.equal(on(97)(version, closed, other), false); assert.equal(on(97)(version, closed, null), false);
  assert.equal(on(97)(version, closed, canary), true); assert.equal(on(97)(version, closed, canary.toLowerCase()), true);
  assert.equal(on(97)(version, open), true); assert.equal(on(97)(version, open, other), true);
  // Typed automation stays off outside chain 97, listed owner or not, open session or not.
  for (const at of [closed, open]) for (const owner of [canary, other, undefined]) assert.equal(on(56)(version, at, owner), false);
});

test('market-hours bypass: prepareNewMoney decides the session with the owner it is given', async () => {
  const { yieldFixture, yieldRebalancePlan } = await import('./fixtures/yield.js');
  const f = yieldFixture(['venus']), plan = yieldRebalancePlan(f), closed = new Date('2026-11-26T16:00:00Z');
  const due: DuePortfolio = { portfolioId: 1, strategyId: 1, version: 1, executionKind: 'hold', scheduleState: 'active',
    account: f.account, accountType: 'KERNEL', intervalSeconds: 60, unsupportedReason: null, nextRunAt: closed };
  const none = () => { throw new Error('unused'); };
  const real = defaultNewMoneyDeps(none, none, none, none as unknown as SchedulerQueryFn, 97);
  const version = { execution: { kind: 'hold' }, allocation: { assets: [{ address: P.assets.NVDAB.token, weightBps: 10000 }] } } as unknown as Awaited<ReturnType<NewMoneyDeps['version']>>;
  const deps: NewMoneyDeps = { ...real, version: async () => version, policy: async () => ({ reserve: 0n, caps: new Map(), buyLimit: 0n, cash: 0n }), verifyLots: async () => {} };
  const query: SchedulerQueryFn = async () => ({ rows: [] });
  const marketOpen = async (owner?: string | null) => (await prepareNewMoney({ due, plan, query, run: none, chainId: 97, now: closed, dryRun: true, deps,
    ...(owner === undefined ? {} : { owner }) })).context.marketOpen;
  assert.equal(await marketOpen(), false); assert.equal(await marketOpen(null), false); assert.equal(await marketOpen('0x00000000000000000000000000000000000000a1'), false);
  assert.equal(await marketOpen('0xd3ab39b62e221bf9e8ba19fe19b2638767d3d6d9'), true);
});
