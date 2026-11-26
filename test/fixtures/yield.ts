import { randomBytes } from 'node:crypto';
import { createPublicClient, custom, encodeAbiParameters, encodeFunctionResult, parseAbi, toFunctionSelector, toEventSelector, toHex, zeroAddress } from 'viem';
import type { Address, Hex } from 'viem';
import type { YieldProfile, YieldRead, YieldPosition, YieldProtocol } from '../../src/yield-domain.js';
import type { YieldReaderDeps } from '../../src/yield-reader.js';
import { WAD, RAY, UINT256_MAX } from '../../src/yield-domain.js';
import type { PortfolioPlan } from '../../src/snapshot.js';
import { valuationHoldings } from '../../src/snapshot.js';
import { computeDrift } from '../../src/drift.js';
export const address=():Address=>`0x${randomBytes(20).toString('hex')}`;
export const hash=():Hex=>`0x${randomBytes(32).toString('hex')}`;
export function yieldFixture(protocols:YieldProtocol[]=['venus','lista','aave_v3']){
  const account=address(),asset=address(),registry=address(),executor=address(),riskSource=address(),blockHash=hash(),oracle=address(),queue=hash();
  const at=new Date(Math.floor(Date.now()/1000)*1000),block=100n;
  const profile:YieldProfile={chainId:97,registry,executor,reservationMode:'db_only',markets:protocols.map((protocol,n)=>{const receipt=address();return{id:`${protocol}_usdt_${receipt.slice(2,8)}`,marketId:hash(),protocol,asset,symbol:'USDT',receipt,target:protocol==='aave_v3'?address():receipt,simulated:true};})};
  const observation={block,blockHash,at,source:'test:yield'};
  const positions:YieldPosition[]=profile.markets.map(m=>({...observation,market:m,state:'known',reason:null,receipt:0n,observedUnits:0n,trackedUnits:0n,claim:0n,value:0n,maxWithdraw:0n,maxRedeem:0n,
    rate:m.protocol==='aave_v3'?RAY:WAD,scale:m.protocol==='aave_v3'?RAY:WAD,aprBps:500n,supplyOpen:true,exiting:false,underlyingDecimals:18,receiptDecimals:m.protocol==='aave_v3'?18:8}));
  const read:YieldRead={profile,observation,positions,accountValue:1000n*WAD,risks:profile.markets.map(m=>({...observation,key:`${m.protocol}:${riskSource}:${asset}`,protocol:m.protocol,asset,riskSource,underlyingMarketId:null,
    configuration:blockHash,state:'known',reason:null,supply:10_000_000n*WAD,liquidity:10_000_000n*WAD,exposure:0n,externalReserved:0n,headroom:1_000_000n*WAD,utilizationBps:0}))};
  const state={fail:'',chainId:97,blockHash,at,receipt:10n*10n**8n,units:10n*10n**8n,tracked:10n*10n**8n,rate:WAD,claim:10n*10n**8n,utilization:8000n,reads:[] as string[],nav:1000n*WAD,cash:1000n*WAD,paused:false,withdrawPaused:false,registryCode:'0x6000' as Hex,proofHash:hash(),proofAccount:account,proofMarket:profile.markets[0]?.marketId??hash(),proofSid:1n,proofVersion:1,proofEnabled:true,proofDaily:UINT256_MAX,proofKind:'policy',proofAssets:0n,proofShares:0n,proofRemaining:0n,proofLogIndex:1,proofRemoved:false,proofDuplicate:false,proofSuccess:true};
  const sessionState={exhausted:[] as string[],gasFailure:false,missing:[] as string[],revoked:[] as string[],cleared:[] as string[],invalidNonce:[] as string[],validNonceFrom:1,missingNumber:false,missingHash:false,reorg:false,exiting:true,exitPolicyEnabled:false};
  const client=createPublicClient({transport:custom({request:async({method,params})=>{
    if(state.fail===method)throw new Error('SECRET_RPC_KEY');
    if(method==='eth_getCode')return state.registryCode;
    if(method==='eth_chainId')return toHex(state.chainId);
    if(method==='eth_getBlockByNumber')return {number:sessionState.missingNumber?null:toHex(block),hash:sessionState.missingHash?null:state.blockHash,timestamp:toHex(BigInt(Math.floor(state.at.getTime()/1000))),gasLimit:'0x1c9c380',gasUsed:'0x0',miner:zeroAddress,size:'0x1',extraData:'0x',parentHash:blockHash,transactions:[],difficulty:'0x0',totalDifficulty:'0x0',nonce:'0x0000000000000000',baseFeePerGas:'0x0',receiptsRoot:blockHash,stateRoot:blockHash,transactionsRoot:blockHash,logsBloom:`0x${'0'.repeat(512)}`,sha3Uncles:blockHash,uncles:[]};
    if(method==='eth_call'){
      const data=Array.isArray(params)&&params[0]&&typeof params[0]==='object'?Reflect.get(params[0],'data'):'';
      if(typeof data!=='string')throw new Error('missing data');
      if(data.startsWith(toFunctionSelector('registry()')))return encodeAbiParameters([{type:'address'}],[registry]);
      if(data.startsWith(toFunctionSelector('numeraire()')))return encodeAbiParameters([{type:'address'}],[asset]);
      if(data.startsWith(toFunctionSelector('oracle()')))return encodeAbiParameters([{type:'address'}],[oracle]);
      if(data.startsWith(toFunctionSelector('previewSwap(address,address,uint256)')))return encodeAbiParameters([{type:'uint256'},{type:'uint256'}],[state.claim,state.claim]);
      if(data.startsWith(toFunctionSelector('enrollments(address)')))return encodeAbiParameters([{type:'uint256'},{type:'uint16'},{type:'bool'}],[state.proofSid,state.proofVersion,false]);
      if(data.startsWith(toFunctionSelector('policies(address,bytes32)')))return encodeAbiParameters([{type:'uint256'},{type:'uint256'},{type:'uint16'},{type:'bool'}],[state.proofDaily,state.proofSid,state.proofVersion,state.proofKind==='exit'?sessionState.exitPolicyEnabled:state.proofEnabled]);
      if(data.startsWith(toFunctionSelector('exiting(address,bytes32)')))return encodeAbiParameters([{type:'bool'}],[sessionState.exiting]);
      if(data.startsWith(toFunctionSelector('permissionConfig(bytes4)'))){
        const abi=parseAbi(['function permissionConfig(bytes4) view returns ((bytes2 permissionFlag,address signer,bytes22[] policyData))']);
        return encodeFunctionResult({abi,functionName:'permissionConfig',result:{permissionFlag:'0x0000',signer:sessionState.missing.includes(data.slice(10,18))?zeroAddress:account,policyData:Array.from({length:3},():Hex=>`0x${'00'.repeat(22)}`)}});
      }
      if(data.startsWith(toFunctionSelector('validationConfig(bytes21)')))return encodeAbiParameters([{type:'uint32'},{type:'address'}],[sessionState.invalidNonce.includes(data.slice(12,20))?0:1,sessionState.cleared.includes(data.slice(12,20))?zeroAddress:'0x0000000000000000000000000000000000000001']);
      if(data.startsWith(toFunctionSelector('validNonceFrom()')))return encodeAbiParameters([{type:'uint32'}],[sessionState.validNonceFrom]);
      if(data.startsWith(toFunctionSelector('isAllowedSelector(bytes21,bytes4)'))){
        if(sessionState.reorg)state.blockHash=hash();
        return encodeAbiParameters([{type:'bool'}],[!sessionState.revoked.includes(data.slice(12,20))]);
      }
      if(data.startsWith(toFunctionSelector('gasPolicyConfig(bytes32,address)'))){
        if(sessionState.gasFailure)throw new Error('SECRET_GAS_RPC');
        return encodeAbiParameters([{type:'uint128'},{type:'bool'},{type:'address'}],[sessionState.exhausted.includes(data.slice(10,18))?0n:1n,true,account]);
      }
      if(data.startsWith(toFunctionSelector('balanceOf(address)')))return encodeAbiParameters([{type:'uint256'}],[state.cash]);
      if(data.startsWith(toFunctionSelector('lastSupply(address,address)')))return encodeAbiParameters([{type:'uint256'}],[0n]);
    }
    if(method==='eth_getTransactionReceipt'){
      const business=state.proofKind==='withdraw'||state.proofKind==='supply';
      const log={address:business?executor:registry,blockHash:state.blockHash,blockNumber:toHex(block),transactionHash:state.proofHash,transactionIndex:'0x0',logIndex:business?toHex(state.proofLogIndex):'0x0',removed:state.proofRemoved,
        topics:[toEventSelector(business?(state.proofKind==='supply'?'SupplyExecuted(address,bytes32,uint256,uint256,uint256)':'WithdrawExecuted(address,bytes32,uint256,uint256,uint256)'):state.proofKind==='exit'?'YieldExitRequested(address,bytes32)':'YieldPolicySet(address,bytes32,uint256,uint256,uint16,bool)'),encodeAbiParameters([{type:'address'}],[state.proofAccount]),state.proofMarket],
        data:business?encodeAbiParameters([{type:'uint256'},{type:'uint256'},{type:'uint256'}],[state.proofAssets,state.proofShares,state.proofRemaining]):state.proofKind==='exit'?'0x':encodeAbiParameters([{type:'uint256'},{type:'uint256'},{type:'uint16'},{type:'bool'}],[state.proofDaily,state.proofSid,state.proofVersion,state.proofEnabled])};
      return{transactionHash:state.proofHash,transactionIndex:'0x0',blockHash:state.blockHash,blockNumber:toHex(block),from:account,to:registry,gasUsed:'0x100',cumulativeGasUsed:'0x100',effectiveGasPrice:'0x1',type:'0x2',status:state.proofSuccess?'0x1':'0x0',contractAddress:null,logsBloom:`0x${'0'.repeat(512)}`,logs:state.proofDuplicate?[log,log]:[log]};
    }
    throw new Error('unexpected RPC');
  }},{retryCount:0})});
  const batch:YieldReaderDeps['batch']=async(_client,_block,calls)=>{
    state.reads.push(...calls.map(c=>c.name));
    return calls.map(c=>{
      if(state.fail===c.name)return null;
      const m=profile.markets.find(m=>m.marketId===c.args?.[0]||m.receipt===c.target||m.target===c.target)??profile.markets[0];if(!m)throw new Error('missing market');
      if(c.name==='getCash'||c.name==='getVirtualUnderlyingBalance')return 100_000n*WAD;if(c.name==='totalReserves')return 0n;
      if(c.name==='actionPaused'||c.name==='paused')return state.withdrawPaused;
      if(c.name==='marketCount')return BigInt(profile.markets.length);if(c.name==='marketIds')return profile.markets[Number(c.args?.[0])]?.marketId;
      if(c.name==='registry'||c.name==='yieldRegistry')return registry;if(c.name==='enrollments')return[1n,1,false];if(c.name==='version')return{assets:[asset]};
      if(c.name==='historicalAssets')return [asset];
      if(c.name==='oracle')return oracle;if(c.name==='numeraire')return asset;
      if(c.name==='market')return{chainId:97n,kind:({venus:1,lista:2,aave_v3:3})[m.protocol],asset,receipt:m.receipt,target:m.target,riskSource,configuration:blockHash,minRate:1n,maxRate:WAD*1000n,supplyEnabled:!state.paused,retired:false};
      if(c.name==='refreshHealth'||c.name==='health')return state.paused?null:{supply:1_000_000n*WAD,liquidity:100_000n*WAD,utilizationBps:state.utilization,configuration:blockHash};
      if(c.name==='rateCheckpoint')return[WAD,BigInt(Math.floor(at.getTime()/1000))];
      if(c.name==='quoteWithdraw')return 1n;if(c.name==='receiptAssets')return state.claim;
      if(c.name==='balanceOf')return c.target===asset?state.nav:state.receipt;if(c.name==='scaledBalanceOf')return state.units;if(c.name==='accountUnits')return state.tracked;
      if(c.name==='decimals')return c.target===asset||m.protocol==='aave_v3'?18:8;
      if(c.name==='totalUnits')return 10n;if(c.name==='totalSupply')return 1_000_000n*WAD;
      if(c.name==='totalAssets')return 1_000_000n*WAD;if(c.name==='exchangeRateStored'||c.name==='convertToAssets')return state.rate;
      if(c.name==='getReserveNormalizedIncome')return state.rate;
      if(c.name==='getReserveData')return (18n<<48n)|(1n<<56n);if(c.name==='supplyCaps')return 0n;
      if(c.name==='aprBps')return 577n;if(c.name==='exiting'||c.name==='supplyPaused')return false;
      if(c.name==='maxDeposit')return 1_000_000n*WAD;if(c.name==='maxWithdraw'||c.name==='maxRedeem')return state.receipt;
      if(c.name==='supplyQueueLength')return 1n;if(c.name==='withdrawQueueLength')return 1n;if(c.name==='supplyQueue'||c.name==='withdrawQueue')return queue;
      if(c.name==='previewAccountValue')return state.nav+state.claim*BigInt(profile.markets.length);
      if(c.name==='previewSwap')return[state.claim,state.claim];
      throw new Error(`unexpected read ${c.name}`);
    });
  };
  return{profile,account,asset,read,state,sessionState,client,batch,at,blockHash,executor,registry,riskSource};
}

export function yieldRebalancePlan(f:ReturnType<typeof yieldFixture>,portfolioId=1,direct=0n):PortfolioPlan{
  const snapshot={portfolioId,block:f.read.observation.block,nativeBalanceWei:0n,holdings:direct===0n?[]:[{asset:f.asset,amountWei:direct,decimals:18,usdPriceE8:100000000n,priceSource:'numeraire' as const}],unpriced:[],yieldPositions:f.read.positions};
  const targets=[{asset:f.asset,weightBps:10000,symbol:'USDT'}];
  return {portfolioId,strategyId:1,chainId:97,account:f.account,snapshot,targets,report:computeDrift(valuationHoldings(snapshot),targets,100),blocked:[],
    scan:{portfolioId,block:snapshot.block,cursor:{portfolioId,startBlock:1n,lastScannedBlock:snapshot.block},scannedRange:null,candidateCount:0,unknownHoldings:[],zeroBalanceCount:0,unreadableCandidates:[],deployment:{block:1n,reason:'resolved',detail:'test'},universeComplete:true,incompleteReasons:[]},
    pinnedVersion:{version:1,onchainStrategyId:1,paused:false},allocationCheck:{consistent:true,chain:[],mismatches:[]},thresholdBps:100};
}
