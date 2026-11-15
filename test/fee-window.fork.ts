/** Opt-in contract view cross-check; never discovered by bun test.
 * On a clean cre8-contracts main worktree, deploy-97.sh fork to local 8583 first.
 * forge inspect AtpExecutor storageLayout --json > <layout.json>
 * CONTRACT_MANIFEST=<contracts-worktree>/deployments/testnet-97.json \
 * CONTRACT_STORAGE_LAYOUT=<layout.json> bun run test/fee-window.fork.ts
 * Uses anvil storage overrides in a snapshot; restores all overrides on exit.
 * No signing keys, public-chain writes, backend service or DB required.
 */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createPublicClient,createTestClient,encodeAbiParameters,getAddress,http,keccak256,parseAbi,toHex} from 'viem';
import {bscTestnet} from 'viem/chains';
import {minimumFeeReserve,checkBuyFeeReserve} from '../src/rebalance-plan.js';
import {record} from '../src/strategy-execution.js';
const RPC='http://127.0.0.1:8583';
const client=createPublicClient({chain:bscTestnet,transport:http(RPC,{retryCount:0}),cacheTime:0});
const local=createTestClient({chain:bscTestnet,mode:'anvil',transport:http(RPC,{retryCount:0})});
const account='0x00000000000000000000000000000000000be100';
const U=10n**18n;
const abi=parseAbi(['function minFeeDue(address,uint256) view returns(uint256)','function minFeeWindowOf(address) view returns(uint64,uint192,uint256)']);
let passes=0;
function equal(actual:bigint,expected:bigint,label:string){assert.equal(actual,expected,label);passes++;}
async function main(){
  const response=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'anvil_nodeInfo',params:[]})});
  const node:unknown=await response.json();assert.ok(typeof node==='object'&&node!==null&&'result' in node);
  assert.equal(await client.getChainId(),97);
  assert.ok(process.env.CONTRACT_MANIFEST,'explicit deployed main manifest required');
  const manifest:unknown=JSON.parse(await readFile(process.env.CONTRACT_MANIFEST,'utf8'));
  assert.ok(record(manifest)&&manifest.chainId===97&&record(manifest.contracts)&&record(manifest.assets)&&record(manifest.assets.WBNB));
  const address=(raw:unknown)=>{assert.equal(typeof raw,'string');return getAddress(String(raw));};
  const executor=address(manifest.contracts.executor),registry=address(manifest.contracts.registry),cash=address(manifest.contracts.usdt);
  const token=address(manifest.assets.WBNB.token),venue=address(manifest.contracts.universalRouter);
  const code=await client.getCode({address:executor});assert.ok(code&&code!=='0x','deployed executor code required');
  assert.ok(process.env.CONTRACT_STORAGE_LAYOUT,'explicit compiler storage layout required');
  const layout:unknown=JSON.parse(await readFile(process.env.CONTRACT_STORAGE_LAYOUT,'utf8'));
  assert.ok(typeof layout==='object'&&layout!==null&&'storage' in layout&&Array.isArray(layout.storage));
  const entry:unknown=layout.storage.find((item:unknown)=>typeof item==='object'&&item!==null&&'label' in item&&item.label==='minFeeWindowOf');
  assert.ok(typeof entry==='object'&&entry!==null&&'slot' in entry&&typeof entry.slot==='string'&&/^\d+$/.test(entry.slot));
  const slot=BigInt(keccak256(encodeAbiParameters([{type:'address'},{type:'uint256'}],[account,BigInt(entry.slot)])));
  const snapshot=await local.snapshot();
  try{
    const due=(amount:bigint)=>client.readContract({address:executor,abi,functionName:'minFeeDue',args:[account,amount]});
    const reserve=async()=>minimumFeeReserve(client,executor,0n,await client.getBlockNumber({cacheTime:0}),account);
    const window=async(start:bigint,notional:bigint,paid:bigint)=>{
      await local.setStorageAt({address:executor,index:toHex(slot,{size:32}),value:toHex((notional<<64n)|start,{size:32})});
      await local.setStorageAt({address:executor,index:toHex(slot+1n,{size:32}),value:toHex(paid,{size:32})});
      const actual=await client.readContract({address:executor,abi,functionName:'minFeeWindowOf',args:[account]});
      assert.deepEqual(actual,[start,notional,paid]);
    };
    await window(0n,0n,0n);
    equal(await due(0n),0n,'empty batch');equal(await reserve(),27n*U/100n,'fresh peak reserve');
    equal(await due(100n*U),2n*U/10n,'fresh 100');
    equal(await due(30n*U),27n*U/100n,'exact 1% saturation');
    equal(await due(30n*U-1n),(30n*U-1n)/100n-(30n*U-1n)/1000n,'one raw below saturation');
    const start=(await client.getBlock()).timestamp;
    await window(start,U,9n*U/1000n);
    equal(await reserve(),261n*U/1000n,'prior dust preserves debt');equal(await due(29n*U),261n*U/1000n,'cumulative peak after dust');
    await window(start,100n*U,2n*U/10n);
    equal(await reserve(),0n,'paid window reserve');equal(await due(100n*U),0n,'second purchase');
    await local.setNextBlockTimestamp({timestamp:start+3599n});await local.mine({blocks:1});
    equal(await due(100n*U),0n,'one second before expiry');
    await local.setNextBlockTimestamp({timestamp:start+3600n});await local.mine({blocks:1});
    equal(await reserve(),27n*U/100n,'exact expiry reserve');equal(await due(100n*U),2n*U/10n,'exact expiry due');
    await assert.rejects(checkBuyFeeReserve({client,executor,account,strategyId:0n,registry,
      numeraire:cash,blockNumber:await client.getBlockNumber({cacheTime:0}),maximumReserve:0n,
      steps:[{tokenIn:cash,tokenOut:token,amountIn:100n*U,amountOutMin:U,oracleFloor:U,venue,data:'0x'}]}),/MIN_FEE_RESERVE/);passes++;
  }finally{await local.revert({id:snapshot});}
  console.log(`${passes} pass / 0 skip / 0 fail (local contract views; storage overrides restored)`);
}
await main();
