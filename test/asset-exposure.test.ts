import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicClient, custom, decodeFunctionData, encodeAbiParameters, parseAbi, toHex } from 'viem';
import type { Address } from 'viem';
import { allocateExposure, readAssetExposure, readAssetExposureStatus, setAssetExposureCap } from '../src/asset-exposure.js';
import { AppError, UnauthorizedError } from '../src/errors.js';
import { readPositions } from '../src/positions.js';
import type { AssetExecution } from '../src/strategy-execution.js';
import { record } from '../src/strategy-execution.js';
import { TESTNET_97 } from '../src/testnet-profile.js';
import { createServer } from '../src/server.js';
import type { ServerDeps } from '../src/server.js';
import { getStrategyWithVersionState } from '../src/strategies.js';
import { MemoryRateLimitStore, RequestRateLimiter } from '../src/ratelimit.js';
import { loadRateLimitConfig } from '../src/config.js';

const U = 10n ** 18n;
const a = TESTNET_97.assets.AAPLB.token, b = TESTNET_97.assets.MSFTB.token, c = TESTNET_97.assets.NVDAB.token, cash = TESTNET_97.contracts.usdt;
const mainA = '0x1000000000000000000000000000000000000160';
const owner: Address = '0x2000000000000000000000000000000000000160';
const other: Address = '0x3000000000000000000000000000000000000160';
const denied = (code: string) => (e: unknown) => e instanceof AppError && e.code === code && !e.message.includes('SECRET');
const config = (weights = [5000, 3000, 2000, 0]): AssetExecution => ({ kind: 'per_asset', numeraire: cash, rebalance: 'none', assets: [a,b,c,cash].map((asset,i) => ({
  asset, weightBps: weights[i] ?? 0, yield: null, ...(asset === cash ? {} : { execution: { kind: 'hold' as const } }),
})) });
const state = (address: string, exposure: bigint, cap: bigint | null) => ({ address, currentExposureUsdtWei: exposure.toString(), exposureCapUsdtWei: cap?.toString() ?? null, buyPaused: cap !== null && exposure >= cap });

function fixture(chainId = 97, cap: string | null = (4000n*U).toString()) {
  const accounts = [{ id: '1', address: owner }, { id: '2', address: other }];
  const catalog = [{ address: mainA, symbol: 'AAPLB', usdt_pool: mainA, is_numeraire: false, cap },
    { address: cash, symbol: 'USDT', usdt_pool: null, is_numeraire: true, cap: null }];
  const amounts = new Map<string,bigint>([[owner, 1000n*U], [other, 1000n*U]]);
  const calls: string[] = [];
  let price = 200_000_000n;
  let failed = '';
  const client = createPublicClient({ transport: custom({ request: async ({method,params}) => {
    calls.push(method);
    if (method === failed) throw new Error('SECRET_RPC');
    if (method === 'eth_chainId') return toHex(chainId);
    if (method === 'eth_blockNumber') return '0x82';
    if (!Array.isArray(params) || params[1] !== '0x82') throw new Error('unpinned RPC');
    if (method === 'eth_getBalance') return '0x0';
    if (method === 'eth_call') {
      const call: unknown = params[0];
      assert.ok(typeof call === 'object' && call !== null && 'data' in call && typeof call.data === 'string' && call.data.startsWith('0x'));
      const decoded = decodeFunctionData({ abi: parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])']), data: `0x${call.data.slice(2)}` });
      const results = decoded.args[0].map((entry, i) => {
        if (i % 2) return { success: true, returnData: encodeAbiParameters([{type:'uint8'}],[18]) };
        const balance = decodeFunctionData({ abi: parseAbi(['function balanceOf(address) view returns (uint256)']), data: entry.callData });
        const amount = entry.target.toLowerCase() === a || entry.target.toLowerCase() === mainA ? amounts.get(balance.args[0].toLowerCase()) ?? 0n : 0n;
        return { success: true, returnData: encodeAbiParameters([{type:'uint256'}],[amount]) };
      });
      return encodeAbiParameters([{ type:'tuple[]', components:[{name:'success',type:'bool'},{name:'returnData',type:'bytes'}] }],[results]);
    }
    throw new Error('unexpected method');
  } },{retryCount:0}) });
  const query = async (sql: string, params?: readonly unknown[]) => {
    if (sql.includes('from priceable_assets')) return {rows: catalog};
    assert.match(sql, /p.strategy_id=\$1 and a.chain_id=\$2/);
    assert.ok(!/schedule_state|session_keys/.test(sql), 'paused and older-version accounts still count');
    assert.deepEqual(params, [160, chainId]);
    return { rows: accounts };
  };
  const positions: typeof readPositions = (rpc, args) => readPositions(rpc, { ...args, priceToken: async (_rpc, priceArgs) => {
    assert.equal(priceArgs.blockNumber,130n);
    if (failed === 'price') throw new Error('SECRET_PRICE');
    return {priceE8:price,decimals:18};
  } });
  return { accounts,catalog,amounts,calls,client,query,positions, fail: (value:string) => {failed=value;}, price: (value:bigint) => {price=value;} };
}

test('#160 exposure uses symbol across chains, adds all accounts at one block, pauses at equality and one wei over', async () => {
  for (const chainId of [56,97]) {
    const f=fixture(chainId);
    const token=chainId===97?a:mainA;
    const read=()=>readAssetExposure(160,chainId,[token],f);
    assert.deepEqual(await read(),[state(token,4000n*U,4000n*U)]);
    f.amounts.set(owner,1000n*U+1n);
    assert.deepEqual(await read(),[state(token,4000n*U+2n,4000n*U)]);
    f.amounts.set(owner,1000n*U-1n);
    assert.deepEqual(await read(),[state(token,4000n*U-2n,4000n*U)]);
  }
});

test('#160 zero holdings and empty funds are zero; missing DB symbol is uncapped; no cap admission does not call RPC', async () => {
  const f=fixture();f.amounts.clear();
  const result=await readAssetExposure(160,97,[a,b,cash],f);
  assert.deepEqual(result,[state(a,0n,4000n*U),state(b,0n,null),state(cash,0n,null)]);
  f.accounts.length=0;f.fail('eth_chainId');
  assert.deepEqual(await readAssetExposure(160,97,[a],f),[state(a,0n,4000n*U)]);
  const noCap=fixture(97,null);noCap.fail('eth_chainId');
  assert.deepEqual(await readAssetExposure(160,97,[a,b],{...noCap,cappedOnly:true}),[a,b].map(address=>({address,buyPaused:false,exposureCapUsdtWei:null,currentExposureUsdtWei:null})));
  assert.equal(noCap.calls.length,0);
});

test('#160 NAV price E8 and token decimals convert to exact USDT wei; price appreciation pauses only new admission',async()=>{
  const f=fixture();f.accounts.splice(1);
  const exposure=await readAssetExposure(160,97,[a],{...f,positions:async()=>({portfolioId:1,block:130n,nativeBalanceWei:0n,
    holdings:[{asset:a,amountWei:1234567n,decimals:6,usdPriceE8:250_000_000n,priceSource:'pancakeswap-v3'}],unpriced:[]})});
  assert.equal(exposure[0]?.currentExposureUsdtWei,'3086417500000000000');
  f.amounts.set(owner,1000n*U);f.price(399_999_999n);assert.equal((await readAssetExposure(160,97,[a],f))[0]?.buyPaused,false);
  f.price(400_000_001n);assert.equal((await readAssetExposure(160,97,[a],f))[0]?.buyPaused,true);
  assert.ok(f.calls.every(method=>['eth_chainId','eth_blockNumber','eth_getBalance','eth_call'].includes(method)),'exposure reads cannot submit sells');
});

test('#160 RPC, DB, price, wrong chain, incomplete evidence and timeout fail closed without leaking upstream details', async () => {
  for (const failure of ['eth_chainId','eth_blockNumber','eth_call','price']) {
    const f=fixture();f.fail(failure);
    await assert.rejects(readAssetExposure(160,97,[a],f),denied('EXPOSURE_UNAVAILABLE'));
  }
  const f=fixture();
  await assert.rejects(readAssetExposure(160,56,[mainA],f),denied('EXPOSURE_UNAVAILABLE'));
  await assert.rejects(readAssetExposure(160,97,[a],{query:async()=>{throw new Error('SECRET_DB');}}),denied('EXPOSURE_UNAVAILABLE'));
  const invalidCap=fixture();const entry=invalidCap.catalog[0];assert.ok(entry);entry.cap='0';
  await assert.rejects(readAssetExposure(160,97,[a],invalidCap),denied('EXPOSURE_UNAVAILABLE'));
  const duplicate=fixture();const duplicateAccount=duplicate.accounts[1];assert.ok(duplicateAccount);duplicateAccount.address=owner;
  await assert.rejects(readAssetExposure(160,97,[a],duplicate),denied('EXPOSURE_UNAVAILABLE'));
  await assert.rejects(readAssetExposure(160,97,[a],{...f,positions:async()=>({portfolioId:1,block:131n,nativeBalanceWei:0n,holdings:[],unpriced:[]})}),denied('EXPOSURE_UNAVAILABLE'));
  await assert.rejects(readAssetExposure(160,97,[a],{...f,positions:async()=>({portfolioId:1,block:130n,nativeBalanceWei:0n,holdings:[],unpriced:[{asset:a,symbol:'AAPLB',amountWei:1n,decimals:18,reason:'pricing_failed'}]})}),denied('EXPOSURE_UNAVAILABLE'));
  const noPool=fixture(56);const unpriced=noPool.catalog[0];assert.ok(unpriced);unpriced.usdt_pool=null;
  await assert.rejects(readAssetExposure(160,56,[mainA],noPool),denied('EXPOSURE_UNAVAILABLE'));
  await assert.rejects(readAssetExposure(160,97,[a],{...fixture(),positions:async()=>new Promise(()=>{}),timeoutMs:5}),denied('EXPOSURE_UNAVAILABLE'));
  const badPrice=fixture();badPrice.price(0n);
  await assert.rejects(readAssetExposure(160,97,[a],badPrice),denied('EXPOSURE_UNAVAILABLE'));
  const partial=fixture();let observed=0;
  await assert.rejects(readAssetExposure(160,97,[a],{...partial,positions:async(client,args)=>{
    if(++observed===2)throw new Error('SECRET_SECOND_ACCOUNT');return partial.positions(client,args);
  }}),denied('EXPOSURE_UNAVAILABLE'));
  assert.equal(observed,2);
});

test('#160 proportional redistribution handles two exclusions, exact bps dust and preserves execution, yield and signed config', () => {
  const original=config([4999,2500,2500,1]);const before=structuredClone(original);
  const result=allocateExposure(original,[state(a,4000n*U,4000n*U),state(b,0n,null),state(c,0n,null),state(cash,0n,null)]);
  assert.equal(result.allocationReason,'exposure_cap');assert.deepEqual(result.cappedAssets,[a]);
  assert.equal(Object.values(result.effectiveAllocation??{}).reduce((s,n)=>s+n,0),10000);
  assert.ok(Object.values(result.effectiveAllocation??{}).every(n=>n>0));
  assert.equal(result.effectiveAllocation?.[cash],2);
  assert.equal(result.effectiveAllocation?.[b],4999);assert.equal(result.effectiveAllocation?.[c],4999);
  assert.deepEqual(original,before);
  const two=allocateExposure(config(),[state(a,1n,1n),state(b,2n,1n),state(c,0n,null),state(cash,0n,null)]);
  assert.deepEqual(two.effectiveAllocation,{[c]:10000});assert.equal(two.execution.assets.find(e=>e.asset===cash)?.weightBps,0);
  assert.throws(()=>allocateExposure(config(),[a,b,c].map(x=>state(x,1n,1n))),denied('FUND_FULL'));
  assert.equal(allocateExposure(original,[a,b,c].map(x=>state(x,0n,null))).execution,original);
  assert.throws(()=>allocateExposure(original,[]),denied('EXPOSURE_UNAVAILABLE'));
});

test('#160 operator cap validation accepts null/one/max, requires provenance and rejects malformed or overflowing input', async () => {
  for (const cap of [null,'1','9'.repeat(38)]) {
    const result=await setAssetExposureCap('AAPLB',{exposureCapUsdtWei:cap,source:' snapshot '},async (_sql,params)=>{
      assert.deepEqual(params,['AAPLB',cap,'snapshot']);return {rows:[{symbol:'AAPLB',exposureCapUsdtWei:cap}]};
    });assert.deepEqual(result,{symbol:'AAPLB',exposureCapUsdtWei:cap});
  }
  for (const cap of [undefined,0,'0','-1','1.0','01','1e18','9'.repeat(39)]) await assert.rejects(setAssetExposureCap('AAPLB',{exposureCapUsdtWei:cap,source:'x'}),denied('INVALID_EXPOSURE_CAP'));
  for (const source of ['', ' ', 'x'.repeat(501),'x\nsecret',null]) await assert.rejects(setAssetExposureCap('AAPLB',{exposureCapUsdtWei:'1',source}),denied('INVALID_EXPOSURE_CAP'));
  await assert.rejects(setAssetExposureCap('AAPLB',{exposureCapUsdtWei:'1',source:'x',extra:true}),denied('INVALID_EXPOSURE_CAP'));
  await assert.rejects(setAssetExposureCap('../AAPLB',{exposureCapUsdtWei:'1',source:'x'}),denied('INVALID_EXPOSURE_CAP'));
  await assert.rejects(setAssetExposureCap('UNKNOWN',{exposureCapUsdtWei:null,source:'x'},async()=>({rows:[]})),denied('NOT_FOUND'));
  await assert.rejects(setAssetExposureCap('USDT',{exposureCapUsdtWei:'1',source:'x'},async sql=>({rows:sql.startsWith('select')?[{symbol:'USDT'}]:[]})),denied('INVALID_EXPOSURE_CAP'));
  await assert.rejects(setAssetExposureCap('AAPLB',{exposureCapUsdtWei:'1',source:'x'},async()=>{throw new Error('SECRET_DB');}),denied('EXPOSURE_STORAGE_UNAVAILABLE'));
});

const detailFixture: ServerDeps['strategyDetail'] = async id => getStrategyWithVersionState(id, {
  strategy: async () => ({ id, provider: owner, name: 'Exposure detail', description: 'Keep metadata available', isPublic: true, category: null, catalogKey: null,
    swapFeeBps: 0, onchainId: null, createdAt: new Date(0).toISOString(), versions: [1, 2].map(version => ({
      strategyId: id, version, allocation: { assets: [{ address: a, weightBps: 6000 }, { address: b, weightBps: 4000 }, { address: cash, weightBps: 0 }] },
      schedule: { kind: 'funding' }, executionSchemaVersion: 2, execution: config([6000, 4000, 0, 0]), executionChainId: 97,
      configHash: null, idleYield: { enabled: false }, changeLog: null, activeAt: null, createdAt: new Date(0).toISOString(),
    })) }),
});

async function withDetail(exposure: ServerDeps['strategyExposure'], check: (url: string) => Promise<void>) {
  const api = createServer({ strategyDetail: detailFixture, strategyExposure: exposure,
    rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore()) });
  await new Promise<void>(resolve => api.listen(8100, '127.0.0.1', resolve));
  try { await check('http://127.0.0.1:8100/strategies/160'); }
  finally { api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve())); }
}

test('#160 review HTTP detail without caps makes no RPC or account reads, including missing DB symbols', async () => {
  const f = fixture(97, null);
  f.fail('eth_chainId');
  let accountReads = 0;
  await withDetail((id, _chain, assets, options) => {
    assert.equal(options?.cappedOnly, true);
    return readAssetExposureStatus(id, 97, assets, { ...f, ...options,
      query: async (sql, params) => { if (sql.includes('from portfolios')) accountReads++; return f.query(sql, params); },
    });
  }, async url => {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const body: unknown = await response.json();
    assert.ok(record(body) && Array.isArray(body.versions));
    for (const version of body.versions) {
      assert.ok(record(version) && record(version.allocation) && Array.isArray(version.allocation.assets));
      assert.deepEqual(version.allocation.assets, [a, b, cash].map((address, i) => ({ address, weightBps: [6000, 4000, 0][i],
        buyPaused: false, exposureCapUsdtWei: null, currentExposureUsdtWei: null })));
    }
  });
  assert.equal(accountReads, 0);
  assert.deepEqual(f.calls, []);
});

test('#160 review public exposure reads only capped tokens and distinguishes zero, below, equal and above cap', async () => {
  const f = fixture();
  const cap = 4000n * U;
  for (const amount of [0n, 1000n * U - 1n, 1000n * U, 1000n * U + 1n]) {
    f.amounts.set(owner, amount);
    f.amounts.set(other, amount);
    let observed = 0;
    const result = await readAssetExposureStatus(160, 97, [a, b, cash, a], { ...f, cappedOnly: false,
      positions: async (rpc, args) => {
        observed++;
        assert.deepEqual(args.tokens.map(token => token.address), [a]);
        return f.positions(rpc, args);
      },
    });
    assert.equal(observed, 2);
    assert.deepEqual(result, [state(a, amount * 4n, cap), ...[b, cash].map(address => ({
      address, buyPaused: false, exposureCapUsdtWei: null, currentExposureUsdtWei: null,
    }))]);
  }
  f.accounts.length = 0;
  f.calls.length = 0;
  assert.deepEqual(await readAssetExposureStatus(160, 97, [a], f), [state(a, 0n, cap)]);
  assert.deepEqual(f.calls, []);
});

test('#160 review HTTP detail keeps metadata and caps with unknown pause state on RPC failure', async () => {
  const f = fixture();
  f.fail('eth_call');
  await withDetail((id, _chain, assets, options) => readAssetExposureStatus(id, 97, assets, { ...f, ...options }), async url => {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const body: unknown = await response.json();
    assert.ok(record(body) && Array.isArray(body.versions));
    assert.equal(body.name, 'Exposure detail');
    assert.equal(body.description, 'Keep metadata available');
    assert.equal(body.minDepositUsdtWei, '50000000000000000000');
    assert.equal(body.versions.length, 2);
    for (const version of body.versions) {
      assert.ok(record(version) && record(version.allocation) && Array.isArray(version.allocation.assets));
      assert.equal(version.status, 'unmirrored');
      assert.deepEqual(version.schedule, { kind: 'funding' });
      assert.deepEqual(version.allocation.assets, [
        { address: a, weightBps: 6000, buyPaused: null, exposureCapUsdtWei: (4000n * U).toString(), currentExposureUsdtWei: null },
        ...[b, cash].map((address, i) => ({ address, weightBps: [4000, 0][i], buyPaused: false, exposureCapUsdtWei: null, currentExposureUsdtWei: null })),
      ]);
    }
    assert.ok(!JSON.stringify(body).includes('SECRET'));
  });
});

for (const failure of ['block', 'price', 'accounts DB', 'catalog DB', 'timeout', 'unpriced', 'partial account', 'wrong chain']) {
  test(`#160 review HTTP detail degrades ${failure} to unknown while admission still rejects`, async () => {
    const f = fixture();
    const deps = { ...f, cappedOnly: true, timeoutMs: 5 };
    if (failure === 'block') f.fail('eth_blockNumber');
    if (failure === 'price') f.fail('price');
    if (failure === 'wrong chain') deps.client = fixture(56).client;
    if (failure === 'accounts DB' || failure === 'catalog DB') deps.query = async (sql, params) => {
      if (failure === 'catalog DB' || sql.includes('from portfolios')) throw new Error('SECRET_DB');
      return f.query(sql, params);
    };
    if (failure === 'timeout') deps.positions = async () => new Promise(() => {});
    if (failure === 'unpriced') deps.positions = async (_rpc, args) => ({ portfolioId: args.portfolioId, block: 130n,
      nativeBalanceWei: 0n, holdings: [], unpriced: [{ asset: a, symbol: 'AAPLB', amountWei: 1n, decimals: 18, reason: 'pricing_failed' }] });
    if (failure === 'partial account') deps.positions = (rpc, args) => {
      if (args.portfolioId === 2) throw new Error('SECRET_SECOND_ACCOUNT');
      return f.positions(rpc, args);
    };
    await withDetail((id, _chain, assets) => readAssetExposureStatus(id, 97, assets, deps), async url => {
      const response = await fetch(url);
      assert.equal(response.status, 200);
      const body: unknown = await response.json();
      assert.ok(record(body) && Array.isArray(body.versions));
      assert.equal(body.name, 'Exposure detail');
      for (const version of body.versions) {
        assert.ok(record(version) && record(version.allocation) && Array.isArray(version.allocation.assets));
        assert.deepEqual(version.allocation.assets, [a, b, cash].map((address, i) => ({ address, weightBps: [6000, 4000, 0][i],
          buyPaused: failure === 'catalog DB' || address === a ? null : false,
          exposureCapUsdtWei: failure !== 'catalog DB' && address === a ? (4000n * U).toString() : null,
          currentExposureUsdtWei: null,
        })));
      }
      assert.ok(!JSON.stringify(body).includes('SECRET'));
    });
    await assert.rejects(readAssetExposure(160, 97, [a, b, cash], deps), denied('EXPOSURE_UNAVAILABLE'));
  });
}

test('#160 HTTP detail annotates every version; cap write requires SIWE operator and stays available with rebalance disabled', async () => {
  let writes=0, failed=false;
  const api=createServer({ operatorWallets:[owner],operatorRebalanceEnabled:()=>false,
    auth:{authenticate:async token=>{if(!token)throw new UnauthorizedError();return token==='operator'?owner:other;},issueNonce:()=>{throw new Error('unused');},login:async()=>{throw new Error('unused');},logout:async()=>{}},
    rateLimiter:new RequestRateLimiter(loadRateLimitConfig({}),new MemoryRateLimitStore()),
    strategyDetail:async id=>getStrategyWithVersionState(id,{strategy:async()=>({id,provider:owner,name:'Cap',description:'',isPublic:true, category: null, catalogKey: null,swapFeeBps:0,onchainId:null,createdAt:new Date(0).toISOString(),versions:[1,2].map(version=>({
      strategyId:id,version,allocation:{assets:[{address:a,weightBps:10000}]},schedule:{kind:'funding'},executionSchemaVersion:2,execution:config([10000,0,0,0]),executionChainId:97,configHash:null,idleYield:{enabled:false},changeLog:null,activeAt:null,createdAt:new Date(0).toISOString(),
    }))})}),
    strategyExposure:async()=>[failed ? { ...state(a,4000n*U,4000n*U), buyPaused: null, currentExposureUsdtWei: null } : state(a,4000n*U,4000n*U)],
    setExposureCap:async(symbol,input)=>{writes++;return {symbol,input};},
  });
  await new Promise<void>(resolve=>api.listen(8100,'127.0.0.1',resolve));
  try {
    const base='http://127.0.0.1:8100';
    const detail=await fetch(base+'/strategies/160');assert.equal(detail.status,200);
    const json: unknown=await detail.json();assert.ok(record(json)&&Array.isArray(json.versions));
    for(const version of json.versions){assert.ok(record(version)&&record(version.allocation)&&Array.isArray(version.allocation.assets));assert.deepEqual(version.allocation.assets[0],{address:a,weightBps:10000,buyPaused:true,exposureCapUsdtWei:(4000n*U).toString(),currentExposureUsdtWei:(4000n*U).toString()});}
    failed=true;assert.equal((await fetch(base+'/strategies/160')).status,200);
    for(const [token,status] of [['',401],['other',403],['operator',200]] as const){
      const response=await fetch(base+'/operator/assets/AAPLB/exposure-cap',{method:'POST',headers:{authorization:token,'content-type':'application/json'},body:JSON.stringify({exposureCapUsdtWei:'1',source:'snapshot'})});
      assert.equal(response.status,status);
    }
    assert.equal(writes,1);
    assert.equal((await fetch(base+'/operator/assets/AAPLB/exposure-cap',{headers:{authorization:'operator'}})).status,405);
    const empty=createServer({operatorWallets:[],auth:{authenticate:async()=>owner,issueNonce:()=>{throw new Error('unused');},login:async()=>{throw new Error('unused');},logout:async()=>{}},setExposureCap:async()=>{throw new Error('unauthorized mutation');}});
    await new Promise<void>(resolve=>empty.listen(0,'127.0.0.1',resolve));
    try{const bound=empty.address();assert.ok(bound&&typeof bound!=='string');assert.equal((await fetch(`http://127.0.0.1:${bound.port}/operator/assets/AAPLB/exposure-cap`,{method:'POST'})).status,403);}
    finally{empty.closeAllConnections();await new Promise<void>(resolve=>empty.close(()=>resolve()));}
  }finally{api.closeAllConnections();await new Promise<void>(resolve=>api.close(()=>resolve()));}
});
