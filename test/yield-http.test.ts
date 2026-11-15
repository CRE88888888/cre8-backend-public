import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer } from '../src/server.js';
import { createYieldService } from '../src/yield-service.js';
import { yieldFixture } from './fixtures/yield.js';
import { MemoryRateLimitStore, RequestRateLimiter } from '../src/ratelimit.js';
import { loadRateLimitConfig } from '../src/config.js';

test('yield HTTP exposes public markets and protects consent/revoke/full-exit with owner auth and exact method routing',async()=>{
  const f=yieldFixture(['venus']),seen:string[]=[];
  const service={...createYieldService({profile:()=>null}),markets:async(chainId:number)=>{seen.push(`markets:${chainId}`);return {chainId:f.profile.chainId,registry:f.registry,markets:[]};},
    consent:async(id:number,wallet:string,_input:unknown)=>{seen.push(`consent:${id}:${wallet}`);return{portfolioId:id,state:'consented'};},
    revoke:async(id:number,wallet:string,_input:unknown)=>{seen.push(`revoke:${id}:${wallet}`);return{portfolioId:id,state:'not_consented'};},
    exit:async(id:number,wallet:string,_input:unknown)=>{seen.push(`exit:${id}:${wallet}`);return{portfolioId:id,state:'requested'};}};
  let authenticated=0;
  const server=createServer({yieldService:service,auth:{authenticate:async(header)=>{authenticated++;if(header!=='Bearer owner')throw new Error('missing');return f.account;},issueNonce:()=>{throw new Error('unexpected');},login:async()=>{throw new Error('unexpected');},logout:async()=>{}},
    rateLimiter:new RequestRateLimiter(loadRateLimitConfig({}),new MemoryRateLimitStore())});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const root=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try{
    assert.equal((await fetch(`${root}/yield/markets?chainId=97`)).status,200);assert.equal(authenticated,0);
    assert.equal((await fetch(`${root}/yield/markets`,{method:'POST'})).status,405);
    for(const action of ['consent','exit','revoke'])assert.equal((await fetch(`${root}/portfolios/1/yield/${action}`,{method:'POST',headers:{authorization:'Bearer owner','content-type':'application/json'},body:JSON.stringify({markets:[],txHash:'0x'})})).status,200);
    assert.equal(authenticated,3);assert.deepEqual(seen.map(v=>v.split(':')[0]),['markets','consent','exit','revoke']);
    assert.equal((await fetch(`${root}/portfolios/1/yield/consent`)).status,405);
  }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});

test('yield missing profile is a closed 404 dependency, absent execution data remains null',async()=>{
  const service=createYieldService({profile:()=>null});
  await assert.rejects(service.markets(97),e=>typeof e==='object'&&e!==null&&Reflect.get(e,'status')===404);
  assert.equal(await service.status(1,'invalid'),null);
});
