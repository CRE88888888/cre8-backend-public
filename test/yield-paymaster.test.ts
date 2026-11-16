import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { encodeCallDataEpV07 } from '@zerodev/sdk';
import { concatHex, decodeFunctionData, encodeAbiParameters, encodeFunctionData, erc20Abi, getAddress, pad, parseAbi, toEventSelector, toFunctionSelector, toHex, zeroAddress } from 'viem';
import { entryPoint07Abi } from 'viem/account-abstraction';
import { createPaymasterService, gasExecutionKey, pureYieldWithdraw, validateSponsoredCalls } from '../src/paymaster.js';
import type { Reservation } from '../src/paymaster.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
import { YIELD_EXECUTOR_ABI, YIELD_REGISTRY_ABI } from '../src/yield-abi.js';
import { unusedExitUsage } from '../src/paymaster-exit-reconciliation.js';
import { config, operation, SENDER, OWNER, TEST_SIGNER, NOW } from './fixtures/paymaster.js';

const c = config({ CHAIN_ID: '97', RPC_URL: 'http://127.0.0.1:8592', PAYMASTER_SIGNER_PRIVATE_KEY: TEST_SIGNER });
const market = T.yieldMarkets[0];
const data = (kind: 'executeSupply' | 'executeWithdraw') => encodeFunctionData({ abi: YIELD_EXECUTOR_ABI, functionName: kind,
  args: [SENDER, market.marketId, 1n, 1n, BigInt(NOW + 300)] });
const call = (kind: 'executeSupply' | 'executeWithdraw') => ({ to: T.contracts.executor, data: data(kind), value: 0n });

test('#114 new exit authorizations require ten minutes; ordinary validity and live retries retain their bounds', async () => {
  const saved: Reservation[] = [];
  const service = createPaymasterService({ config: c, now: () => NOW,
    query: async () => ({ rows: [{ owner: OWNER, user_id: OWNER }] }), checkChain: async () => {}, verifyYieldWithdraw: async () => [],
    readBudgetContext: async () => ({ purpose: 'ordinary', nativePrice: 1n, priceSource: 'test:114' }),
    reserve: async r => { saved.push(r); return r.validUntil; } });
  const op = operation({ callData: await encodeCallDataEpV07([call('executeWithdraw')]) });
  for (const seconds of [0, 1, 300, 599]) {
    await assert.rejects(service.sponsor({ userOperation: op, validUntil: NOW + seconds }, OWNER), /PAYMASTER_EXPIRED/);
  }
  assert.equal(saved.length, 0);
  assert.equal((await service.sponsor({ userOperation: op, validUntil: NOW + 600 }, OWNER)).validUntil, NOW + 600);
  assert.equal((await service.sponsor({ userOperation: op }, OWNER)).validUntil, NOW + 600);
  await assert.rejects(service.sponsor({ userOperation: op, validUntil: NOW + 601 }, OWNER), /PAYMASTER_EXPIRED/);
  const ordinary = operation({ callData: await encodeCallDataEpV07([call('executeSupply')]) });
  assert.equal((await service.sponsor({ userOperation: ordinary }, OWNER)).validUntil, NOW + 300);
  await assert.rejects(service.sponsor({ userOperation: ordinary, validUntil: NOW + 301 }, OWNER), /PAYMASTER_EXPIRED/);
});

test('#114 unused-exit storage rejects absent and malformed totals, preserving exact bigint precision', async () => {
  for (const row of [undefined, null, {}, { count: '0', gas: '0' }, { count: 0, gas: '0', wei: '0' },
    { count: '0', gas: '-1', wei: '0' }, { count: '0', gas: '0', wei: 'NaN' }]) {
    await assert.rejects(unusedExitUsage(async () => ({ rows: row === undefined ? [] : [row] }), 97, SENDER, '2026-11-16'), /exit reconciliation evidence unavailable/);
  }
  assert.deepEqual(await unusedExitUsage(async () => ({ rows: [{ count: '0', gas: '0', wei: '0' }] }), 97, SENDER, '2026-11-16'), { count: 0n, gas: 0n, wei: 0n });
  assert.deepEqual(await unusedExitUsage(async () => ({ rows: [{ count: '3', gas: '9007199254740993', wei: '90071992547409930' }] }), 97, SENDER, '2026-11-16'),
    { count: 3n, gas: 9007199254740993n, wei: 90071992547409930n });
});

test('#112 public exit exemption requires fresh nonzero tracked holdings, current nonce and exact Kernel withdrawal simulation',async()=>{
  let mode='zero',reserved=0,simulated=0;
  const blockHash=`0x${'22'.repeat(32)}`;
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=String(chunk);
    const rpc:{id:number;method:string;params:unknown[]}=JSON.parse(body);
    if(mode==='timeout')await new Promise<void>(resolve=>setTimeout(resolve,25));
    let result:unknown='0x',error=false;
    if(rpc.method==='eth_chainId')result='0x61';
    else if(rpc.method==='eth_getBlockByNumber')result={number:'0x64',hash:blockHash,timestamp:toHex(BigInt(mode==='stale'?NOW-61:NOW)),gasLimit:'0x1c9c380',gasUsed:'0x0',miner:zeroAddress,size:'0x1',extraData:'0x',parentHash:blockHash,transactions:[],difficulty:'0x0',totalDifficulty:'0x0',nonce:'0x0000000000000000',receiptsRoot:blockHash,stateRoot:blockHash,transactionsRoot:blockHash,logsBloom:`0x${'00'.repeat(256)}`,sha3Uncles:blockHash,uncles:[]};
    else if(rpc.method==='eth_getLogs')result=[];
    else{
      assert.equal(rpc.method,'eth_call');const request=rpc.params[0];assert.ok(request&&typeof request==='object');
      const bytes=Reflect.get(request,'data'),to=Reflect.get(request,'to');assert.equal(typeof bytes,'string');
      if(to===SENDER&&!String(bytes).startsWith(toFunctionSelector('rootValidator()'))&&!String(bytes).startsWith(toFunctionSelector('validationConfig(bytes21)'))){
        simulated++;assert.equal(Reflect.get(request,'from')?.toLowerCase(),T.contracts.entryPoint);error=mode==='simulation';
        if(mode==='wrapped'){
          try{const decoded=decodeFunctionData({abi:parseAbi(['function executeUserOp((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature),bytes32)']),data:String(bytes) as `0x${string}`});assert.equal(decoded.args[0].sender,SENDER);assert.ok(decoded.args[0].callData.startsWith(toFunctionSelector('executeUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32)')));}catch{error=true;}
        }
      }
      else if(String(bytes).startsWith(toFunctionSelector('rootValidator()')))result=encodeAbiParameters([{type:'bytes21'}],[`0x${'01'.repeat(21)}`]);
      else if(String(bytes).startsWith(toFunctionSelector('validationConfig(bytes21)')))result=encodeAbiParameters([{type:'uint32'},{type:'address'}],[1,'0x0000000000000000000000000000000000000001']);
      else if(String(bytes).startsWith(toFunctionSelector('balanceOf(address)')))result=encodeAbiParameters([{type:'uint256'}],[mode==='zero'?0n:mode==='insufficient'?0n:2n]);
      else if(String(bytes).startsWith(toFunctionSelector('accountUnits(address,bytes32)')))result=encodeAbiParameters([{type:'uint256'}],[mode==='untracked'?0n:2n]);
      else if(String(bytes).startsWith(toFunctionSelector('getNonce(address,uint192)')))result=encodeAbiParameters([{type:'uint256'}],[mode==='nonce'?1n:0n]);
      else assert.fail('unexpected exit proof read');
      if(mode==='rpc')error=true;
    }
    res.setHeader('content-type','application/json');res.end(JSON.stringify(error?{jsonrpc:'2.0',id:rpc.id,error:{code:-32000,message:'SECRET_RPC_TOKEN'}}:{jsonrpc:'2.0',id:rpc.id,result}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const endpoint=server.address();assert.ok(endpoint&&typeof endpoint!=='string');
  const settings={...c,rpcUrl:`http://127.0.0.1:${endpoint.port}`};
  const service=createPaymasterService({config:settings,now:()=>NOW,
    query:async sql=>({rows:sql.includes('smart_accounts')?[{owner:OWNER,user_id:OWNER}]:[]}),checkChain:async()=>{},
    readBudgetContext:async()=>({purpose:'ordinary',nativePrice:1n,priceSource:'test:112'}),reserve:async r=>{assert.equal(r.budget.purpose,'exit');reserved++;}});
  const single=operation({callData:await encodeCallDataEpV07([call('executeWithdraw')])});
  try{
    for(const bad of ['zero','untracked','insufficient','nonce','simulation','stale','rpc']){
      mode=bad;await assert.rejects(service.sponsor({userOperation:single},OWNER),error=>error instanceof Error&&!error.message.includes('SECRET'));
      assert.equal(reserved,0,bad);
    }
    mode='timeout';settings.timeoutMs=5;await assert.rejects(service.sponsor({userOperation:single},OWNER));assert.equal(reserved,0);settings.timeoutMs=c.timeoutMs;
    mode='ok';await service.sponsor({userOperation:single},OWNER);assert.equal(reserved,1);assert.ok(simulated>0);
    const double=operation({callData:await encodeCallDataEpV07([call('executeWithdraw'),call('executeWithdraw')])});
    await service.sponsor({userOperation:double},OWNER);assert.equal(reserved,2,'sum exactly equals the observed holding');
    mode='wrapped';await service.sponsor({userOperation:operation({callData:await encodeCallDataEpV07([call('executeWithdraw')],'call',true)})},OWNER);assert.equal(reserved,3);mode='ok';
    const triple=operation({callData:await encodeCallDataEpV07([call('executeWithdraw'),call('executeWithdraw'),call('executeWithdraw')])});
    await assert.rejects(service.sponsor({userOperation:triple},OWNER));assert.equal(reserved,3);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('#85 final canonical payload classifies supply ordinary, every pure withdrawal exit, mixed batches ordinary', async () => {
  const saved: Reservation[] = [];
  const service = createPaymasterService({ config: c, now: () => NOW,
    query: async () => ({ rows: [{ owner: OWNER, user_id: OWNER }] }), checkChain: async () => {}, verifyYieldWithdraw:async()=>[],
    readBudgetContext: async () => ({ purpose: 'ordinary', nativePrice: 1n, priceSource: 'fixture:oracle' }),
    reserve: async r => { saved.push(r); } });
  for (const [calls, purpose] of [
    [[call('executeSupply')], 'ordinary'], [[call('executeWithdraw')], 'exit'],
    [[call('executeWithdraw'), call('executeWithdraw')], 'exit'], [[call('executeWithdraw'), call('executeSupply')], 'ordinary'],
  ] as const) {
    const op = operation({ callData: await encodeCallDataEpV07(calls) });
    assert.equal(pureYieldWithdraw(op, c), purpose === 'exit');
    await service.sponsor({ userOperation: op }, OWNER);
    assert.equal(saved.at(-1)?.budget.purpose, purpose);
  }
  const supplied = operation({ callData: await encodeCallDataEpV07([call('executeSupply')]) });
  await assert.rejects(service.sponsor({ userOperation: supplied, purpose: 'exit' }, OWNER), /PAYMASTER_INVALID_OPERATION/);
});

test('#85 paymaster refuses final total gas over 14M; includes paymaster overhead and permits exact equality', async () => {
  let count = 0;
  const service = createPaymasterService({ config: c, now: () => NOW,
    query: async () => ({ rows: [{ owner: OWNER, user_id: OWNER }] }), checkChain: async () => {}, verifyYieldWithdraw:async()=>[],
    readBudgetContext: async () => ({ purpose: 'ordinary', nativePrice: 1n, priceSource: 'fixture:oracle' }),
    reserve: async () => { count++; } });
  const base = 14_000_000n - 100_000n - 50_000n - c.verificationGasLimit - c.postOpGasLimit;
  for (const extra of [-1n, 0n, 1n]) {
    const op = operation({ callData: await encodeCallDataEpV07([call('executeSupply')]),
      accountGasLimits: concatHex([toHex(100_000n, { size: 16 }), toHex(base + extra, { size: 16 })]) });
    if (extra > 0n) await assert.rejects(service.sponsor({ userOperation: op }, OWNER), /PAYMASTER_USER_OP_CAPACITY/);
    else await service.sponsor({ userOperation: op }, OWNER);
  }
  assert.equal(count, 2);
});

test('#85 owner setup accepts only registered receipt approve to executor and typed policy; arbitrary calls stay forbidden', async () => {
  const approve = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [c.executor, 1n] });
  const consent = encodeFunctionData({ abi: YIELD_REGISTRY_ABI, functionName: 'setYieldPolicy', args: [market.marketId, 1n, true] });
  const setup = await encodeCallDataEpV07([{ to: market.receipt, data: approve, value: 0n }, { to: T.contracts.yieldRegistry, data: consent, value: 0n }]);
  validateSponsoredCalls(operation({ callData: setup }), c);
  const forbidden = [
    { to: market.receipt, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [SENDER, 1n] }), value: 0n },
    { to: market.receipt, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [SENDER, 1n] }), value: 0n },
    { to: T.contracts.yieldRegistry, data: encodeFunctionData({ abi: YIELD_REGISTRY_ABI, functionName: 'setYieldPolicy', args: [market.marketId, 0n, true] }), value: 0n },
    // Keep the forbidden legacy selector test after it disappears from the generated current ABI.
    { to: T.contracts.yieldRegistry, data: encodeFunctionData({ abi: parseAbi(['function releaseReservation(address,bytes32,uint256)']), functionName: 'releaseReservation', args: [SENDER, market.marketId, 1n] }), value: 0n },
    { to: T.contracts.yieldRegistry, data: encodeFunctionData({ abi: YIELD_REGISTRY_ABI, functionName: 'reconcile', args: [SENDER, market.marketId] }), value: 0n },
    { to: T.contracts.yieldRegistry, data: encodeFunctionData({ abi: YIELD_REGISTRY_ABI, functionName: 'acknowledgeIdentity', args: [market.marketId, market.marketId] }), value: 0n },
  ];
  for (const call of forbidden) {
    const callData = await encodeCallDataEpV07([call]);
    assert.throws(() => validateSponsoredCalls(operation({ callData }), c), /PAYMASTER_CALL_FORBIDDEN/);
  }
});

test('#112 consumption binds canonical receipt/event and exact handleOps or aggregated packed payload before settling its gas key',async()=>{
  let mode='initial';
  const saved:Reservation[]=[];
  const hash=`0x${'22'.repeat(32)}` as const,txHash=`0x${'44'.repeat(32)}` as const;
  const prior=operation({callData:await encodeCallDataEpV07([call('executeWithdraw')])});
  let accepted:{userOpHash:`0x${string}`;paymasterAndData:`0x${string}`}|undefined;
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=String(chunk);
    const rpc:{id:number;method:string;params:unknown[]}=JSON.parse(body);
    const packed={...prior,paymasterAndData:accepted?.paymasterAndData??'0x'};
    const input=mode==='aggregated'
      ?encodeFunctionData({abi:entryPoint07Abi,functionName:'handleAggregatedOps',args:[[{userOps:[packed],aggregator:zeroAddress,signature:'0x'}],getAddress(OWNER)]})
      :encodeFunctionData({abi:entryPoint07Abi,functionName:'handleOps',args:[[packed],getAddress(OWNER)]});
    const event={address:T.contracts.entryPoint,blockHash:hash,blockNumber:'0x64',transactionHash:txHash,transactionIndex:'0x0',logIndex:'0x0',removed:false,
      topics:[toEventSelector('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)'),mode==='hash'?txHash:accepted?.userOpHash??hash,pad(SENDER),pad(c.address)],
      data:encodeAbiParameters([{type:'uint256'},{type:'bool'},{type:'uint256'},{type:'uint256'}],[mode==='nonce'?1n:0n,mode!=='inner-reverted',1n,1n])};
    let result:unknown='0x';
    if(rpc.method==='eth_chainId')result='0x61';
    else if(rpc.method==='eth_getBlockByNumber')result={number:'0x64',hash:mode==='reorg'&&rpc.params[0]!=='latest'?txHash:hash,timestamp:toHex(BigInt(NOW)),gasLimit:'0x1c9c380',gasUsed:'0x0',miner:zeroAddress,size:'0x1',extraData:'0x',parentHash:hash,transactions:[],difficulty:'0x0',totalDifficulty:'0x0',nonce:'0x0000000000000000',receiptsRoot:hash,stateRoot:hash,transactionsRoot:hash,logsBloom:`0x${'00'.repeat(256)}`,sha3Uncles:hash,uncles:[]};
    else if(rpc.method==='eth_getLogs')result=[event];
    else if(rpc.method==='eth_getTransactionByHash')result={hash:txHash,blockHash:hash,blockNumber:mode==='tx-block'?'0x63':'0x64',transactionIndex:'0x0',from:OWNER,to:mode==='tx-target'?SENDER:T.contracts.entryPoint,input,nonce:'0x0',gas:'0x1000000',gasPrice:'0x2',maxFeePerGas:'0x2',maxPriorityFeePerGas:'0x1',type:'0x2',chainId:'0x61',value:'0x0',accessList:[],v:'0x1',r:pad('0x01'),s:pad('0x01'),yParity:'0x1'};
    else if(rpc.method==='eth_getTransactionReceipt')result={transactionHash:txHash,transactionIndex:'0x0',blockHash:mode==='receipt-block'?txHash:hash,blockNumber:'0x64',from:OWNER,to:T.contracts.entryPoint,gasUsed:'0x1',cumulativeGasUsed:'0x1',effectiveGasPrice:'0x2',type:'0x2',status:mode==='receipt-failed'?'0x0':'0x1',contractAddress:null,logsBloom:`0x${'00'.repeat(256)}`,logs:mode==='missing-event'?[]:[event]};
    else{
      assert.equal(rpc.method,'eth_call');const request=rpc.params[0];assert.ok(request&&typeof request==='object');
      const bytes=Reflect.get(request,'data'),target=Reflect.get(request,'to');assert.equal(rpc.params[1],'0x64');
      if(target===SENDER)result='0x';
      else if(String(bytes).startsWith(toFunctionSelector('getNonce(address,uint192)')))result=encodeAbiParameters([{type:'uint256'}],[mode==='initial'?0n:1n]);
      else result=encodeAbiParameters([{type:'uint256'}],[2n]);
    }
    res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const endpoint=server.address();assert.ok(endpoint&&typeof endpoint!=='string');
  const service=createPaymasterService({config:{...c,rpcUrl:`http://127.0.0.1:${endpoint.port}`},now:()=>NOW,
    query:async sql=>({rows:sql.includes('smart_accounts')?[{owner:OWNER,user_id:OWNER}]:sql.includes('user_op_hash')&&accepted?[{user_op_hash:accepted.userOpHash}]:[]}),
    checkChain:async()=>{},readBudgetContext:async()=>({purpose:'ordinary',nativePrice:1n,priceSource:'test:112'}),reserve:async r=>{saved.push(r);}});
  try{
    accepted=await service.sponsor({userOperation:prior},OWNER);
    const next={...prior,nonce:1n};
    for(const invalid of ['hash','nonce','tx-block','tx-target','receipt-block','receipt-failed','missing-event','reorg']){
      mode=invalid;
      if(invalid==='hash'){
        // viem discards logs whose indexed hash does not match the requested filter.
        // No consumption proof reaches the reserve boundary, whose DB guard retains it.
        await service.sponsor({userOperation:next},OWNER);assert.deepEqual(saved.at(-1)?.consumedAuthorizations,[]);saved.pop();
      }else await assert.rejects(service.sponsor({userOperation:next},OWNER));
      assert.equal(saved.length,1,invalid);
    }
    for(const valid of ['handleOps','aggregated','inner-reverted']){
      mode=valid;await service.sponsor({userOperation:next},OWNER);
      assert.deepEqual(saved.at(-1)?.consumedAuthorizations,[{userOpHash:accepted.userOpHash,executionKey:gasExecutionKey(97,prior),success:valid!=='inner-reverted'}]);
    }
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});


test('#113 runtime DB failures, malformed rows and invalid values fail closed without leaking upstream text',async()=>{
  const {readYieldState,writeYieldState}=await import('../src/yield-runtime-state.js');
  const broken=async()=>{throw new Error('SECRET database connection failed');};
  await assert.rejects(readYieldState('auth-test',broken),/^Error: yield state unavailable$/);
  await assert.rejects(writeYieldState('auth-test',{nonce:'0'},broken),/^Error: yield state unavailable$/);
  for(const row of [{kind:'cursor',value:{nonce:'0'}},{kind:'fact'},{kind:'fact',value:null}]){
    await assert.rejects(readYieldState('auth-test',async()=>({rows:[row]})),/^Error: yield state unavailable$/);
  }
  const unexpected=async()=>{assert.fail('invalid input must not reach DB');};
  for(const key of ['../escape','unknown-key','cursor','auth-','auth-'+ 'x'.repeat(196)]){
    await assert.rejects(readYieldState(key,unexpected));
    await assert.rejects(writeYieldState(key,{},unexpected));
  }
  for(const value of [undefined,NaN,Infinity,1n])await assert.rejects(writeYieldState('fact-test',value,unexpected));
});
