/** Explicit LOCAL-ONLY CT-3 adapter acceptance. Uses contracts#49 compiled artifacts read-only.
 * Owner smoke accounts test real supply/accrual/partial exits; Kernel/UserOp sending belongs to BE-4.
 * Run separately from bun test: bun scripts/verify-yield-read.ts
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPublicClient,createWalletClient,http,parseAbi,keccak256,toHex,maxUint256 } from 'viem';
import type { Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';
import { readYieldAccount } from '../src/yield-reader.js';
import { address,hash,object,raw,WAD } from '../src/yield-domain.js';
import type { YieldMarket,YieldProfile } from '../src/yield-domain.js';
import { writeSnapshot,valuationHoldings } from '../src/snapshot.js';
import type { PositionSnapshot } from '../src/positions.js';
import { query,migrate,closePool } from '../src/db.js';
import {persistYieldRead} from '../src/yield-store.js';
import { computeDrift } from '../src/drift.js';
import { TEST_SIGNER } from '../test/fixtures/paymaster.js';
const rpc='http://127.0.0.1:8595';
const client=createPublicClient({chain:bscTestnet,transport:http(rpc,{retryCount:0,timeout:15000})});
const account=privateKeyToAccount(TEST_SIGNER);
const wallet=createWalletClient({account,chain:bscTestnet,transport:http(rpc,{retryCount:0,timeout:15000})});
const artifacts=process.env.YIELD_CONTRACT_ARTIFACTS??'../cre8-contracts-wt-yield/out';
async function deploy(file:string,name:string,constructor:string,args:readonly unknown[]=[]):Promise<Address>{
  const json:unknown=JSON.parse(await readFile(join(artifacts,file,`${name}.json`),'utf8'));
  const bytecode=object(object(json).bytecode).object;if(typeof bytecode!=='string'||!/^0x[0-9a-fA-F]+$/.test(bytecode))throw new Error('artifact bytecode missing');
  const tx=await wallet.deployContract({abi:parseAbi([constructor]),bytecode:`0x${bytecode.slice(2)}`,args});
  const r=await client.waitForTransactionReceipt({hash:tx});assert.equal(r.status,'success');return address(r.contractAddress);
}
function abi(signature:string){return parseAbi([signature]);}
function fn(signature:string){const name=/function\s+(\w+)/.exec(signature)?.[1];if(!name)throw new Error('missing function name');return name;}
async function write(target:Address,signature:string,args:readonly unknown[]=[]){
  const tx=await wallet.writeContract({address:target,abi:abi(signature),functionName:fn(signature),args});
  const receipt=await client.waitForTransactionReceipt({hash:tx});assert.equal(receipt.status,'success');return receipt;
}
async function read(target:Address,signature:string,args:readonly unknown[]=[]):Promise<unknown>{return client.readContract({address:target,abi:abi(signature),functionName:fn(signature),args});}
async function main(){
  assert.equal(await client.getChainId(),97);
  const info:unknown=await client.transport.request({method:'anvil_nodeInfo',params:[]});assert.equal(typeof info,'object','local anvil proof required');
  await client.transport.request({method:'anvil_setBlockTimestampInterval',params:[0]});
  const token=await deploy('TestnetToken.sol','TestnetToken','constructor(string,string,uint8,address)',['BE84 local USDT','USDT',18,account.address]);
  const registry=await deploy('AtpRegistry.sol','AtpRegistry','constructor()');
  const router=await deploy('AtpExecutorBuyLimit.t.sol','PricedRouter','constructor()');
  const oracle=await deploy('AtpExecutorBuyLimit.t.sol','PricedOracle','constructor(address)',[token]);
  const permit=address('0x31c2f6fcff4f8759b3bd5bf0e1084a055615c768');assert.ok(await client.getCode({address:permit}));
  const executor=await deploy('AtpExecutor.sol','AtpExecutor','constructor(address,address,address,address,address,address,uint16,uint256)',[registry,router,oracle,permit,account.address,token,10000,0n]);
  const yields=address(await read(executor,'function yieldRegistry() view returns(address)'));
  const register='function registerStrategy(string,string,bool) returns(uint256)';
  const strategy=raw((await client.simulateContract({account,address:registry,abi:abi(register),functionName:fn(register),args:['BE84 local','adapter acceptance',true]})).result);
  await write(registry,register,['BE84 local','adapter acceptance',true]);
  await write(registry,'function publishVersion(uint256,address[],uint16[],bytes32,uint64)',[strategy,[token],[10000],keccak256(toHex('BE84 local hold')),0n]);
  const markets:YieldMarket[]=[],smokes:Address[]=[];
  const names=['MockVenus','MockLista','MockAavePool'];
  const protocols=['venus','lista','aave_v3'] as const;
  for(const [index,name]of names.entries()){
    const protocol=protocols[index];if(!protocol)throw new Error('missing protocol');
    const target=await deploy(`${name}.sol`,name,'constructor(address,address,uint16)',[token,account.address,index===0?500:300]);
    const receipt=protocol==='aave_v3'?address(await read(target,'function receipt() view returns(address)')):target;
    await write(token,'function setMinter(address,bool)',[protocol==='aave_v3'?receipt:target,true]);
    await write(token,'function mint(address,uint256)',[account.address,1_000_000n*WAD]);
    await write(token,'function approve(address,uint256) returns(bool)',[target,maxUint256]);
    if(protocol==='venus')await write(target,'function mint(uint256) returns(uint256)',[1_000_000n*WAD]);
    else if(protocol==='lista')await write(target,'function deposit(uint256,address) returns(uint256)',[1_000_000n*WAD,account.address]);
    else await write(target,'function supply(address,uint256,address,uint16)',[token,1_000_000n*WAD,account.address,0]);
    const marketId=keccak256(toHex(`BE84 local ${protocol}`));
    const tuple={chainId:97n,kind:index+1,asset:token,receipt,target,riskSource:target,configuration:keccak256(toHex('initial reviewed configuration')),minRate:1n,maxRate:10n**36n,supplyEnabled:true,retired:false};
    await write(yields,'function registerMarket(bytes32,(uint256 chainId,uint8 kind,address asset,address receipt,address target,address riskSource,bytes32 configuration,uint256 minRate,uint256 maxRate,bool supplyEnabled,bool retired))',[marketId,tuple]);
    await write(yields,'function acknowledgeRate(bytes32)',[marketId]);
    const health=(await client.simulateContract({address:yields,abi:abi('function refreshHealth(bytes32) returns((uint256 supply,uint256 liquidity,uint256 utilizationBps,bytes32 configuration))'),functionName:'refreshHealth',args:[marketId]})).result;
    await write(yields,'function acknowledgeConfiguration(bytes32,bytes32)',[marketId,hash(object(health).configuration)]);
    const smoke=await deploy('SmokeYieldTestnet.s.sol','YieldSmokeAccount','constructor(address)',[account.address]);smokes.push(smoke);
    await write(token,'function mint(address,uint256)',[smoke,100n*WAD]);
    await write(smoke,'function prepare(address,uint256,bytes32,uint256)',[executor,strategy,marketId,maxUint256]);
    const tx=await write(smoke,'function supply(address,bytes32,uint256)',[executor,marketId,100n*WAD]);
    console.log(JSON.stringify({phase:'supply',protocol,tx:tx.transactionHash,gas:tx.gasUsed.toString()}));
    markets.push({id:`${protocol}_usdt`,marketId,protocol,asset:token,symbol:'USDT',receipt,target,simulated:true});
  }
  const profile:YieldProfile={chainId:97,registry:yields,executor,reservationMode:'db_only',markets};
  let databaseAssertions=0;
  if(process.env.YIELD_VERIFY_DATABASE==='1'){
    const db=new URL(process.env.DATABASE_URL??'');
    assert.equal(db.pathname,'/cre8_be84');assert.ok(['','localhost','127.0.0.1'].includes(db.hostname),'only isolated local BE84 DB');
    await migrate();
    const s=(await query<{id:string}>("insert into strategies(provider,name) values($1,'be84-local-ct3') returning id::text",[account.address.toLowerCase()])).rows[0];assert.ok(s);
    await query(`insert into strategy_versions(strategy_id,version,allocation,schedule) values($1,1,$2,'{"kind":"interval","intervalSeconds":60}')`,[s.id,JSON.stringify({assets:[{address:token,weightBps:10000}]})]);
    for(const smoke of smokes){
      const existing:{id:string;owner:string;name:string}|undefined=(await query<{id:string;owner:string;name:string}>("select sa.portfolio_id::text as id,sa.owner,s.name from smart_accounts sa join portfolios p on p.id=sa.portfolio_id join strategies s on s.id=p.strategy_id where sa.chain_id=97 and sa.address=$1",[smoke])).rows[0];
      if(existing){assert.equal(existing.owner,account.address.toLowerCase());assert.equal(existing.name,'be84-local-ct3');}
      const p:{id:string}|undefined=existing??(await query<{id:string}>("insert into portfolios(user_id,strategy_id,version,schedule_state) values($1,$2,1,'paused') returning id::text",[account.address.toLowerCase(),s.id])).rows[0];assert.ok(p);
      if(!existing)await query("insert into smart_accounts(portfolio_id,chain_id,address,owner,account_type) values($1,97,$2,$3,'EOA')",[p.id,smoke,account.address.toLowerCase()]);
      const observed=await readYieldAccount(client,profile,smoke);assert.ok(observed.accountValue!==null);
      await persistYieldRead({chainId:97,portfolioId:Number(p.id),account:smoke},observed);
      const snap:PositionSnapshot={portfolioId:Number(p.id),block:observed.observation.block,nativeBalanceWei:0n,holdings:[],unpriced:[],yieldPositions:observed.positions,accountValueRaw:observed.accountValue};
      const report=computeDrift(valuationHoldings(snap),[{asset:token,weightBps:10000}],100);
      await writeSnapshot(snap,report);
      const stored:{n:string}|undefined=(await query<{n:string}>('select total_usd_e8::text as n from portfolio_snapshots where portfolio_id=$1',[p.id])).rows[0];assert.equal(stored?.n,report.totalUsdE8.toString());
      const receipts:{n:string}|undefined=(await query<{n:string}>('select sum(s.value_usdt_raw)::text as n from yield_positions p join yield_position_snapshots s on s.id=p.latest_snapshot_id where p.portfolio_id=$1',[p.id])).rows[0];assert.equal(receipts?.n,observed.positions.reduce((n,p)=>n+(p.value??0n),0n).toString());
      databaseAssertions+=3;
    }
  }
  const beforeClock=await client.getBlock({blockTag:'latest'});
  await client.transport.request({method:'anvil_setBlockTimestampInterval',params:[3600]});
  await client.transport.request({method:'evm_mine',params:[]});
  await client.transport.request({method:'anvil_setBlockTimestampInterval',params:[0]});
  assert.ok((await client.getBlock({blockTag:'latest'})).timestamp>=beforeClock.timestamp+3600n);
  const observe=async(smoke:Address)=>{const block=await client.getBlock({blockTag:'latest'});return readYieldAccount(client,profile,smoke,{now:()=>new Date(Number(block.timestamp)*1000),block:block.number});};
  let assertions=1;
  for(const [index,m]of markets.entries()){
    const smoke=smokes[index];assert.ok(smoke);
    const initial=await observe(smoke);console.log(JSON.stringify({phase:'valuation',protocol:m.protocol,accountValue:initial.accountValue?.toString()??null,states:initial.positions.map(p=>({protocol:p.market.protocol,state:p.state,reason:p.reason,claim:p.claim?.toString()??null,value:p.value?.toString()??null}))}));
    const position=initial.positions.find(p=>p.market.marketId===m.marketId);assert.ok(position);assert.equal(position.state,'known');assert.ok(position.claim!==null&&position.claim>100n*WAD);assert.equal(initial.accountValue,position.value);assertions+=3;
    const snapshot:PositionSnapshot={portfolioId:index+1,block:initial.observation.block,nativeBalanceWei:0n,holdings:[],unpriced:[],yieldPositions:initial.positions,accountValueRaw:initial.accountValue};
    const report=computeDrift(valuationHoldings(snapshot),[{asset:token,weightBps:10000}],100);
    await writeSnapshot(snapshot,report,{query:async(_sql,params=[])=>{assert.equal(params[3],report.totalUsdE8.toString());assertions++;return{rows:[{header_inserted:true,inserted:1,updated:0}]};}});
    await write(m.target,'function setLiquidity(uint256)',[50n*WAD]);
    const risky=await observe(smoke),p=risky.positions.find(p=>p.market.marketId===m.marketId);assert.ok(p&&p.maxRedeem!==null&&p.maxRedeem>0n);assert.ok(risky.risks.some(r=>r.protocol===m.protocol&&r.utilizationBps!==null&&r.utilizationBps>=9000));assertions+=2;
    const partial=await write(smoke,'function withdraw(address,bytes32,uint256)',[executor,m.marketId,p.maxRedeem]);
    const remaining=await observe(smoke),left=remaining.positions.find(p=>p.market.marketId===m.marketId);assert.ok(left&&left.receipt!==null&&left.receipt>0n);assertions++;
    await write(m.target,'function setLiquidity(uint256)',[1_000_000n*WAD]);
    const full=await write(smoke,'function withdrawAll(address,bytes32)',[executor,m.marketId]);
    const done=await observe(smoke),zero=done.positions.find(p=>p.market.marketId===m.marketId);assert.equal(zero?.receipt,0n);assert.equal(zero?.trackedUnits,0n);assertions+=2;
    console.log(JSON.stringify({phase:'partial/full',protocol:m.protocol,partial:partial.transactionHash,partialGas:partial.gasUsed.toString(),full:full.transactionHash,fullGas:full.gasUsed.toString()}));
  }
  console.log(JSON.stringify({markets:markets.length,assertions,databaseAssertions,pass:assertions+databaseAssertions,fail:0,scope:'local owner CT-3 receipts + backend reader/snapshot; Kernel BE-4 integration separate'}));
}
main().catch((error:unknown)=>{console.error(error instanceof Error?error.message.split('\n')[0]:'本機生息讀值驗收失敗');process.exitCode=1;}).finally(closePool);
