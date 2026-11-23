import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readYieldAccount, YIELD_READ_CONCURRENCY } from '../src/yield-reader.js';
import { yieldFixture, address } from './fixtures/yield.js';
import { keccak256,toFunctionSelector } from 'viem';
import { RAY, WAD, mustExit } from '../src/yield-domain.js';

test('#124 NAV includes same-block historical assets added after enrollment, once each, and fails closed on missing history',async()=>{
  const f=yieldFixture(['venus']),added=address();let fail=false,seen=0;
  const batch:typeof f.batch=async(client,block,calls)=>{
    assert.equal(block,100n);
    const values=await f.batch(client,block,calls.filter(c=>c.name!=='historicalAssets'));
    let i=0;
    return calls.map(c=>{
      if(c.name==='historicalAssets')return fail?null:[f.asset,added,added];
      const value=values[i++];
      if(c.name==='balanceOf'&&c.target===added){seen++;return 7n*WAD;}
      if(c.name==='previewSwap'&&c.args?.[0]===added)return [7n*WAD,6n*WAD];
      if(c.name==='previewAccountValue')return f.state.nav+f.state.claim+7n*WAD;
      return value;
    });
  };
  const r=await readYieldAccount(f.client,f.profile,f.account,{batch,now:()=>f.at});
  assert.equal(r.accountValue,f.state.nav+f.state.claim+7n*WAD);
  assert.equal(seen,1);assert.equal(r.positions[0]?.state,'known');
  fail=true;assert.equal((await readYieldAccount(f.client,f.profile,f.account,{batch,now:()=>f.at})).accountValue,null);
});

test('#124 historical NAV accepts zero holdings and the 128-asset limit; missing balance/quote/history or a one-wei NAV mismatch stays unknown',async()=>{
  const f=yieldFixture(['venus']),added=address(),history=Array.from({length:127},address);
  let mode='zero';
  const batch:typeof f.batch=async(client,block,calls)=>{
    assert.equal(block,100n);
    if(mode==='rpc'&&calls.some(c=>c.name==='historicalAssets'))throw new Error('SECRET_HISTORY_RPC');
    const values=await f.batch(client,block,calls);
    return calls.map((c,i)=>{
      if(c.name==='historicalAssets')return mode==='empty'?[]:mode==='maximum'?[f.asset,...history]:mode==='overflow'?[f.asset,added,...history]:mode==='malformed'?[null]:[f.asset,added];
      if(c.name==='balanceOf'&&c.target!==f.asset&&!f.profile.markets.some(m=>m.receipt===c.target))return mode==='missing-balance'?null:mode==='zero'||mode==='maximum'?0n:WAD;
      if(c.name==='previewSwap'&&c.args?.[0]===added)return mode==='missing-quote'?null:[WAD,WAD];
      if(c.name==='previewAccountValue'&&!['zero','maximum','empty'].includes(mode))return f.state.nav+f.state.claim+WAD+(mode==='mismatch'?1n:0n);
      return values[i];
    });
  };
  for(mode of ['zero','maximum','empty'])assert.equal((await readYieldAccount(f.client,f.profile,f.account,{batch,now:()=>f.at})).accountValue,f.state.nav+f.state.claim,mode);
  for(mode of ['overflow','malformed','missing-balance','missing-quote','rpc','mismatch']){
    const read=await readYieldAccount(f.client,f.profile,f.account,{batch,now:()=>f.at});
    assert.equal(read.accountValue,null,mode);assert.equal(read.positions[0]?.state,'known',mode);
  }
});

test('yield Venus reads current APR and non-18 receipt units after same-call accrual',async()=>{
  const f=yieldFixture(['venus']);f.state.rate=2n*WAD;f.state.claim=20n*10n**8n;
  const r=await readYieldAccount(f.client,f.profile,f.account,{batch:f.batch,now:()=>f.at});
  assert.equal(r.positions[0]?.claim,f.state.claim);assert.equal(r.positions[0]?.value,f.state.claim);
  assert.equal(r.positions[0]?.aprBps,577n);assert.equal(r.positions[0]?.receiptDecimals,8);
  assert.equal(r.risks[0]?.exposure,20n);assert.equal(r.risks[0]?.utilizationBps,8000);
  assert.ok(f.state.reads.indexOf('refreshHealth')<f.state.reads.indexOf('balanceOf'));
});
test('#112 a supply-only rate jump closes admission without inventing exit risk; loss, U=90% and failed risk reads still exit',async()=>{
  for(const protocol of ['venus','lista','aave_v3'] as const){
    const f=yieldFixture([protocol]);
    f.state.rate=protocol==='aave_v3'?2n*RAY:2n*WAD;
    f.state.receipt=protocol==='aave_v3'?f.state.units*2n:f.state.units;
    const batch:typeof f.batch=async(...args)=>{
      const values=await f.batch(...args);
      return values.map((v,n)=>args[2][n]?.name==='refreshHealth'?null:v);
    };
    const jump=await readYieldAccount(f.client,f.profile,f.account,{batch,now:()=>f.at});
    const position=jump.positions[0];assert.ok(position);
    assert.equal(position.supplyOpen,false);
    assert.equal(jump.risks[0]?.state,'known');
    assert.equal(mustExit(position,jump.risks,false,f.at),false);
    f.state.utilization=9000n;
    const high=await readYieldAccount(f.client,f.profile,f.account,{batch,now:()=>f.at});
    assert.ok(high.positions[0]);assert.equal(mustExit(high.positions[0],high.risks,false,f.at),true);
    f.state.utilization=8999n;f.state.rate=protocol==='aave_v3'?RAY/2n:WAD/2n;
    f.state.receipt=protocol==='aave_v3'?f.state.units/2n:f.state.units;
    const loss=await readYieldAccount(f.client,f.profile,f.account,{batch,now:()=>f.at});
    assert.ok(loss.positions[0]);assert.equal(mustExit(loss.positions[0],loss.risks,false,f.at),true);
    f.state.fail='health';
    const failed=await readYieldAccount(f.client,f.profile,f.account,{batch,now:()=>f.at});
    assert.equal(failed.risks[0]?.state,'unknown');
  }
});

test('yield Aave preserves full ray index and rejects nominal/scaled mismatch',async()=>{
  const f=yieldFixture(['aave_v3']);f.state.rate=RAY+123456789n;f.state.units=10n**30n;f.state.tracked=f.state.units;
  f.state.receipt=f.state.units*f.state.rate/RAY;f.state.claim=f.state.receipt;
  const r=await readYieldAccount(f.client,f.profile,f.account,{batch:f.batch,now:()=>f.at});
  assert.equal(r.positions[0]?.rate,f.state.rate);assert.equal(r.positions[0]?.scale,RAY);assert.equal(r.positions[0]?.observedUnits,f.state.units);
  f.state.receipt++;const bad=await readYieldAccount(f.client,f.profile,f.account,{batch:f.batch,now:()=>f.at});
  assert.equal(bad.positions[0]?.state,'unknown');assert.equal(bad.positions[0]?.value,null);
});
test('yield Lista de-duplicates supply/withdraw queues; shared group liquidity is a minimum, never a sum',async()=>{
  const f=yieldFixture(['lista','lista']);
  const r=await readYieldAccount(f.client,f.profile,f.account,{batch:f.batch,now:()=>f.at});
  assert.equal(r.risks.length,2);assert.equal(r.risks[0]?.liquidity,100_000n*WAD);assert.equal(r.risks[1]?.liquidity,r.risks[0]?.liquidity);
});
test('yield unavailable/paused/zero rates do not masquerade as zero claim or zero utilization',async()=>{
  const f=yieldFixture(['venus']);f.state.fail='receiptAssets';
  const r=await readYieldAccount(f.client,f.profile,f.account,{batch:f.batch,now:()=>f.at});
  assert.equal(r.positions[0]?.value,null);assert.equal(r.risks[0]?.utilizationBps,null);
  f.state.fail='';f.state.rate=0n;
  assert.equal((await readYieldAccount(f.client,f.profile,f.account,{batch:f.batch,now:()=>f.at})).positions[0]?.state,'unknown');
});
test('yield rejects stale/future/wrong-chain RPC; timeout errors contain no upstream credential',async()=>{
  const f=yieldFixture(['venus']);
  for(const now of [new Date(+f.at+60001),new Date(+f.at-1)])await assert.rejects(readYieldAccount(f.client,f.profile,f.account,{batch:f.batch,now:()=>now}));
  f.state.chainId=56;await assert.rejects(readYieldAccount(f.client,f.profile,f.account,{batch:f.batch,now:()=>f.at}));f.state.chainId=97;
  await assert.rejects(readYieldAccount(f.client,f.profile,f.account,{batch:()=>new Promise(()=>{}),timeoutMs:5,now:()=>f.at}),e=>e instanceof Error&&!e.message.includes('SECRET'));
});

test('contracts eafc1a6 has no cross-transaction reservation ABI; only explicit DB R remains',async()=>{
  const f=yieldFixture(['venus']);
  const r=await readYieldAccount(f.client,f.profile,f.account,{batch:f.batch,now:()=>f.at});
  assert.equal(r.positions[0]?.state,'known');assert.equal(r.risks[0]?.externalReserved,0n);
  assert.equal(f.state.reads.includes('totalReserved'),false);
});

test('supply pause/health failure cannot zero a known claim or block independently proven withdrawal liquidity',async()=>{
  const f=yieldFixture(['venus']);f.state.paused=true;
  const read=await readYieldAccount(f.client,f.profile,f.account,{batch:f.batch,now:()=>f.at});
  assert.equal(read.positions[0]?.state,'known');assert.ok((read.positions[0]?.maxRedeem??0n)>0n);assert.equal(read.risks[0]?.state,'unknown');
  f.state.withdrawPaused=true;
  const paused=await readYieldAccount(f.client,f.profile,f.account,{batch:f.batch,now:()=>f.at});
  assert.equal(paused.positions[0]?.claim,f.state.claim);assert.equal(paused.positions[0]?.maxRedeem,0n);assert.equal(paused.positions[0]?.withdrawPaused,true);
});

test('canonical block changes and RPC credential errors never become a priced snapshot or escape to logs',async()=>{
  const f=yieldFixture(['venus']);
  f.state.fail='eth_getBlockByNumber';
  await assert.rejects(readYieldAccount(f.client,f.profile,f.account,{batch:f.batch,now:()=>f.at}),e=>e instanceof Error&&!e.message.includes('SECRET'));
  f.state.fail='';
  await assert.rejects(readYieldAccount(f.client,f.profile,f.account,{now:()=>f.at,batch:async(...args)=>{
    const result=await f.batch(...args);
    if(args[2].some(c=>c.name==='previewAccountValue'))f.state.blockHash=`0x${'ab'.repeat(32)}`;
    return result;
  }}));
});

test('pinned current registry is DB-only even if bytecode contains the retired reservation selector',async()=>{
  const f=yieldFixture(['venus']);
  const noR={...f.profile,registryCodeHash:keccak256(f.state.registryCode)};
  const current=await readYieldAccount(f.client,noR,f.account,{batch:f.batch,now:()=>f.at});assert.equal(current.risks[0]?.externalReserved,0n);
  f.state.registryCode=`0x63${toFunctionSelector('totalReserved(bytes32)').slice(2)}6000`;
  const currentProfile={...f.profile,registryCodeHash:keccak256(f.state.registryCode)};
  const read=await readYieldAccount(f.client,currentProfile,f.account,{batch:f.batch,now:()=>f.at});assert.equal(read.risks[0]?.externalReserved,0n);
  f.state.fail='totalReserved';
  const known=await readYieldAccount(f.client,currentProfile,f.account,{batch:f.batch,now:()=>f.at});assert.equal(known.positions[0]?.state,'known');
  assert.equal(f.state.reads.includes('totalReserved'),false);
  await assert.rejects(readYieldAccount(f.client,noR,f.account,{batch:f.batch,now:()=>f.at}));
});

test('#106 absent reservation hint never invokes retired ABI; zero exposure still has protocol headroom',async()=>{
  const f=yieldFixture(['venus']);
  const profile={chainId:f.profile.chainId,registry:f.registry,executor:f.executor,markets:f.profile.markets};
  const r=await readYieldAccount(f.client,profile,f.account,{now:()=>f.at,batch:async(...args)=>{
    const values=await f.batch(...args);
    return values.map((v,n)=>args[2][n]?.name==='totalUnits'?0n:v);
  }});
  assert.equal(r.positions[0]?.state,'known');assert.equal(r.risks[0]?.exposure,0n);
  assert.equal(r.risks[0]?.externalReserved,0n);assert.equal(r.risks[0]?.headroom,(1n<<256n)-1n);
  assert.equal(f.state.reads.includes('totalReserved'),false);
});

test('#106 pinned runtime missing, mismatched or RPC unavailable rejects before market reads',async()=>{
  const f=yieldFixture(['venus']),profile={...f.profile,registryCodeHash:keccak256(f.state.registryCode)};
  for(const code of ['0x','0x6001'] as const){
    f.state.registryCode=code;
    await assert.rejects(readYieldAccount(f.client,profile,f.account,{batch:f.batch,now:()=>f.at}));
    assert.equal(f.state.reads.length,0);
  }
  f.state.registryCode='0x6000';f.state.fail='eth_getCode';
  await assert.rejects(readYieldAccount(f.client,profile,f.account,{batch:f.batch,now:()=>f.at}),e=>e instanceof Error&&!e.message.includes('SECRET'));
  assert.equal(f.state.reads.length,0);
});

test('#106 Venus full-receipt quote avoids inverse-rounding dust, while exact liquidity, zero and pause remain conservative',async()=>{
  const f=yieldFixture(['venus']);f.state.rate=2n*WAD+1n;
  let cash=6n;
  const batch:typeof f.batch=async(...args)=>{
    const values=await f.batch(...args);
    return values.map((value,n)=>{
      const call=args[2][n];
      if(value===null)return value;
      if(call?.name==='getCash')return cash;
      if(call?.name==='quoteWithdraw')return BigInt(call.args?.[1]??0n)*f.state.rate/WAD;
      return value;
    });
  };
  for(const receipts of [3n,1n,0n]){
    f.state.receipt=receipts;f.state.units=receipts;f.state.tracked=receipts;f.state.claim=receipts*f.state.rate/WAD;cash=f.state.claim;
    const full=await readYieldAccount(f.client,f.profile,f.account,{batch,now:()=>f.at});
    assert.equal(full.positions[0]?.maxRedeem,receipts,'cash exactly covers the full protocol quote');
    if(receipts===0n)continue;
    cash--;
    const partial=await readYieldAccount(f.client,f.profile,f.account,{batch,now:()=>f.at});
    assert.equal(partial.positions[0]?.maxRedeem,cash*WAD/f.state.rate);
  }
  f.state.receipt=3n;f.state.units=3n;f.state.tracked=3n;f.state.claim=6n;cash=0n;
  assert.equal((await readYieldAccount(f.client,f.profile,f.account,{batch,now:()=>f.at})).positions[0]?.maxRedeem,0n);
  cash=6n;f.state.withdrawPaused=true;
  assert.equal((await readYieldAccount(f.client,f.profile,f.account,{batch,now:()=>f.at})).positions[0]?.maxRedeem,0n);
  f.state.withdrawPaused=false;f.state.fail='quoteWithdraw';
  assert.equal((await readYieldAccount(f.client,f.profile,f.account,{batch,now:()=>f.at})).positions[0]?.state,'unknown');
});

test('#106 reviewed Lista optimistic redeem can clear dust only when its full quote fits maxWithdraw',async()=>{
  const f=yieldFixture(['lista']);f.state.rate=2n*WAD+1n;
  let cash=2n,conservativeRedeem=0n;
  const batch:typeof f.batch=async(...args)=>{
    const values=await f.batch(...args);
    return values.map((value,n)=>{
      const call=args[2][n];if(value===null)return value;
      if(call?.name==='maxWithdraw')return cash;
      if(call?.name==='maxRedeem')return conservativeRedeem;
      if(call?.name==='quoteWithdraw')return BigInt(call.args?.[1]??0n)*f.state.rate/WAD;
      return value;
    });
  };
  for(const receipts of [1n,3n,0n]){
    f.state.receipt=receipts;f.state.units=receipts;f.state.tracked=receipts;f.state.claim=receipts*f.state.rate/WAD;
    cash=f.state.claim;conservativeRedeem=receipts===0n?0n:receipts-1n;
    assert.equal((await readYieldAccount(f.client,f.profile,f.account,{batch,now:()=>f.at})).positions[0]?.maxRedeem,receipts);
    if(receipts===0n)continue;
    cash--;
    assert.equal((await readYieldAccount(f.client,f.profile,f.account,{batch,now:()=>f.at})).positions[0]?.maxRedeem,conservativeRedeem);
  }
  f.state.receipt=1n;f.state.units=1n;f.state.tracked=1n;f.state.claim=2n;cash=2n;conservativeRedeem=0n;
  f.state.withdrawPaused=true;
  assert.equal((await readYieldAccount(f.client,f.profile,f.account,{batch,now:()=>f.at})).positions[0]?.maxRedeem,0n);
  f.state.withdrawPaused=false;
  for(const failed of ['maxWithdraw','maxRedeem','quoteWithdraw']){
    f.state.fail=failed;
    assert.equal((await readYieldAccount(f.client,f.profile,f.account,{batch,now:()=>f.at})).positions[0]?.state,'unknown');
  }
});

test('#216 registry may also list the strategy earn vault (filtered from the profile); any other extra or missing market fails closed',async()=>{
  const { STRATEGY_EARN_97 } = await import('../src/strategy-earn-guard.js');
  const f=yieldFixture(['venus','lista']);
  let extra:string|null=STRATEGY_EARN_97.earnVaultMarketId,drop=false;
  const batch:typeof f.batch=async(client,block,calls)=>{
    const ids=[...f.profile.markets.map(m=>m.marketId as string)];
    if(drop)ids.pop();
    if(extra!==null)ids.splice(1,0,extra);
    const values=await f.batch(client,block,calls.filter(c=>c.name!=='marketCount'&&c.name!=='marketIds'));
    let i=0;
    return calls.map(c=>c.name==='marketCount'?BigInt(ids.length):c.name==='marketIds'?ids[Number(c.args?.[0])]:values[i++]);
  };
  const ok=await readYieldAccount(f.client,f.profile,f.account,{batch,now:()=>f.at});
  assert.equal(ok.positions.length,2);assert.notEqual(ok.accountValue,null);
  extra=`0x${'ab'.repeat(32)}`;
  await assert.rejects(readYieldAccount(f.client,f.profile,f.account,{batch,now:()=>f.at}),/生息資料/);
  extra=STRATEGY_EARN_97.earnVaultMarketId;drop=true;
  await assert.rejects(readYieldAccount(f.client,f.profile,f.account,{batch,now:()=>f.at}),/生息資料/);
});

test('status 20–50 s: independent market groups and NAV evidence are read concurrently, at most YIELD_READ_CONCURRENCY at once', async () => {
  const f = yieldFixture(Array.from({ length: 12 }, () => 'venus' as const));
  // One risk source per market -> 12 groups, like the 30 single-market groups on chain 97.
  const sources = new Map(f.profile.markets.map(m => [m.marketId, address()]));
  let inFlight = 0, peak = 0, batches = 0;
  const batch: typeof f.batch = async (client, block, calls) => {
    inFlight++; batches++; peak = Math.max(peak, inFlight);
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      const values = await f.batch(client, block, calls);
      return values.map((v, n) => {
        const c = calls[n];
        return c?.name === 'market' && v && typeof v === 'object' ? { ...v, riskSource: sources.get(c.args?.[0] as `0x${string}`) } : v;
      });
    } finally { inFlight--; }
  };
  const started = Date.now();
  const r = await readYieldAccount(f.client, f.profile, f.account, { batch, now: () => f.at });
  const elapsed = Date.now() - started;
  assert.equal(r.positions.length, 12);
  assert.ok(r.positions.every(p => p.state === 'known'));
  assert.deepEqual(r.positions.map(p => p.market.marketId), f.profile.markets.map(m => m.marketId), 'profile order is kept');
  assert.equal(new Set(r.risks.map(x => x.riskSource)).size, 12);
  assert.ok(peak > 1, `reads must overlap (peak ${peak})`);
  assert.ok(peak <= YIELD_READ_CONCURRENCY, `at most ${YIELD_READ_CONCURRENCY} batches in flight (peak ${peak})`);
  // Sequential reads would take batches * 20 ms.
  assert.ok(elapsed < batches * 20 / 2, `elapsed ${elapsed} ms for ${batches} batches`);
});

test('a timed-out yield read fails fast with YIELD_UNAVAILABLE and stops issuing RPC batches', async () => {
  const f = yieldFixture(['venus', 'lista', 'aave_v3']);
  let after = 0, timedOut = false;
  const batch: typeof f.batch = async (client, block, calls) => {
    if (timedOut) after++;
    await new Promise(resolve => setTimeout(resolve, 30));
    return f.batch(client, block, calls);
  };
  const started = Date.now();
  await assert.rejects(readYieldAccount(f.client, f.profile, f.account, { batch, now: () => f.at, timeoutMs: 40 }),
    (e: unknown) => e instanceof Error && e.message.includes('生息資料或持久化證據不完整'));
  timedOut = true;
  assert.ok(Date.now() - started < 200);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(after, 0, 'no batch reaches the RPC after the timeout');
});

test('a failed yield read names the failing check in its cause chain (stale block / reorg / RPC error)', async () => {
  const { errorChain } = await import('../src/errors.js');
  const f = yieldFixture(['venus']);
  const late = new Date(f.at.getTime() + 75_000);
  const stale = await readYieldAccount(f.client, f.profile, f.account, { batch: f.batch, now: () => late }).catch((e: unknown) => e);
  assert.match(errorChain(stale), /生息資料或持久化證據不完整.* ← \[yield:stale-block:100:age-75000ms @ read@src\/yield-reader\.ts:\d+/);
  const failing: typeof f.batch = async () => { throw Object.assign(new Error('rate limited'), { name: 'HttpRequestError' }); };
  const rpc = await readYieldAccount(f.client, f.profile, f.account, { batch: failing, now: () => f.at }).catch((e: unknown) => e);
  assert.match(errorChain(rpc), /\[yield:read @ readYieldAccount@src\/yield-reader\.ts:\d+[^\]]*\] ← HttpRequestError: rate limited$/);
});

test('DCA (db 0064): an ignored market (the account\'s own DCA vault shares) is neither read nor an unknown extra', async () => {
  const f = yieldFixture(['venus', 'lista']);
  const dca = f.profile.markets[1]?.marketId;
  assert.ok(dca);
  const read = await readYieldAccount(f.client, f.profile, f.account, { batch: f.batch, now: () => f.at, ignore: [dca] });
  assert.deepEqual(read.positions.map(p => p.market.marketId), [f.profile.markets[0]?.marketId]);
  assert.equal(read.profile.markets.length, 1);
  // Ignoring a market never widens what an extra on-chain market may be.
  const batch: typeof f.batch = async (client, block, calls) => {
    const ids = [...f.profile.markets.map(m => m.marketId as string), `0x${'cd'.repeat(32)}`];
    const values = await f.batch(client, block, calls.filter(c => c.name !== 'marketCount' && c.name !== 'marketIds'));
    let i = 0;
    return calls.map(c => c.name === 'marketCount' ? BigInt(ids.length) : c.name === 'marketIds' ? ids[Number(c.args?.[0])] : values[i++]);
  };
  await assert.rejects(readYieldAccount(f.client, f.profile, f.account, { batch, now: () => f.at, ignore: [dca] }), /生息資料/);
});
