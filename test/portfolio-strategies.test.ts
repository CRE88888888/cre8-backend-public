import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, afterEach, test } from 'node:test';
import type { Address, Hex } from 'viem';
import { createPublicClient, custom } from 'viem';
import { closePool, getPool, migrate, query, withConnection, withTransaction } from '../src/db.js';
import { createPortfolioStrategyService, readWalletFundingEvidence } from '../src/portfolio-strategies.js';
import { setAssetExposureCap, readAssetExposure } from '../src/asset-exposure.js';
import type { PortfolioStrategyDeps } from '../src/portfolio-strategies.js';
import { RESUME_AFTER_SELL_ALL_SQL } from '../src/sell-all-resume.js';
import { createStrategy, getStrategy, publishVersion, requireTypedVersion, validateAllocation, previewContribution } from '../src/strategies.js';
import { assertVersionOnchain, readAccountCash } from '../src/chain.js';
import { enrollPortfolio, requireOwnedPortfolio, strategyMinimumDeposit } from '../src/portfolios.js';
import { readFaucetFundingEvidence } from '../src/faucet.js';
import { canonicalConfigHash, UINT256_MAX, usdtRaw, validateAssetConfig } from '../src/strategy-execution.js';
import type { AssetExecution, AssetSetting } from '../src/strategy-execution.js';
import { AppError } from '../src/errors.js';
import { TESTNET_97 } from '../src/testnet-profile.js';
import { strategyRpc, TEST_AMOUNT, OTHER_HASH, BLOCK_HASH } from './fixtures/strategy-rpc.js';
import { claimDuePortfolios } from '../src/scheduler.js';
import { previewContributionAsync } from '../src/contribution-preview.js';
import { fundingLots, prepareStrategyJob } from '../src/strategy-jobs.js';
import type { JobContext } from '../src/strategy-jobs.js';
import type { WithTransactionFn } from '../src/scheduler.js';
import launchLineup from './fixtures/launch-lineup.json' with { type: 'json' };
import { launchFunds } from '../scripts/testnet-launch-funds.js';

const address = (): Address => `0x${randomBytes(20).toString('hex')}`;
const txHash = (): Hex => `0x${randomBytes(32).toString('hex')}`;
const denied = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
const fixtureClaimIds: string[] = [];
const activeAt = new Date('2026-11-15T00:00:00Z');
const allocation = validateAllocation({ assets: [{ address: TESTNET_97.assets.AAPLB.token, weightBps:5000 },{address:TESTNET_97.contracts.usdt,weightBps:5000}] },97);

function assetConfig(kind:'hold'|'stack',basket=allocation,chainId=97):AssetExecution {
  const numeraire=chainId===97?TESTNET_97.contracts.usdt:'0x55d398326f99059ff775485246999027b3197955';
  return {kind:'per_asset',numeraire,rebalance:'none',assets:basket.assets.map<AssetSetting>(({address,weightBps})=>address===numeraire
    ? {asset:address,weightBps,yield:null} : {asset:address,weightBps,yield:null,execution:kind==='hold'?{kind:'hold'}:
      {kind:'stack',every:'daily',weekday:null,timeUtc:'14:00',slices:12}}).sort((a,b)=>a.asset.localeCompare(b.asset))};
}
async function fixture(kind: 'hold' | 'stack' = 'stack', cashWeight=5000, amount=TEST_AMOUNT, configured?:AssetExecution) {
  await migrate();
  const allocation=validateAllocation({assets:configured?configured.assets.map(a=>({address:a.asset,weightBps:a.weightBps})):[{address:TESTNET_97.assets.AAPLB.token,weightBps:10000-cashWeight},{address:TESTNET_97.contracts.usdt,weightBps:cashWeight}]},97);
  const owner=address(); const account=address();
  const strategy=(await query<{id:string}>("insert into strategies(provider,name) values($1,'be82-isolated') returning id",[owner])).rows[0];
  assert.ok(strategy);
  const strategyId=Number(strategy.id);
  const onchainId=strategyId+90_000_000;
  await query('update strategies set onchain_id=$2 where id=$1',[strategyId,onchainId]);
  const execution=configured??assetConfig(kind,allocation);
  const configHash=canonicalConfigHash({chainId:97,execution,allocation,schedule:{kind:'funding'},activeAt});
  await query(`insert into strategy_versions(strategy_id,version,allocation,schedule,active_at,execution_schema_version,execution,execution_chain_id,config_hash)
    values($1,1,$2::jsonb,'{"kind":"funding"}',$3,2,$4::jsonb,97,$5)`,[strategyId,JSON.stringify(allocation),activeAt,JSON.stringify(execution),configHash]);
  const p=(await query<{id:string}>("insert into portfolios(user_id,strategy_id,version,schedule_state) values($1,$2,1,'paused') returning id",[owner,strategyId])).rows[0];
  assert.ok(p);const id=Number(p.id);
  await query("insert into smart_accounts(portfolio_id,chain_id,address,owner,account_type) values($1,97,$2,$3,'KERNEL')",[id,account,owner]);
  const hash=txHash();
  const claim=(await query<{id:string}>("insert into faucet_claims(chain_id,owner,account,amount_wei,tx_hash,state,created_at) values(97,$1,$2,$3,$4,'unknown','2000-01-01T00:00:00Z') returning id",[owner,account,amount.toString(),hash])).rows[0];
  assert.ok(claim); fixtureClaimIds.push(claim.id);
  const rpc=strategyRpc(allocation,configHash,activeAt,hash);
  rpc.state.to=account;rpc.state.strategyId=BigInt(onchainId);rpc.state.amount=amount;rpc.state.cashRaw=amount;
  const deps: Partial<PortfolioStrategyDeps>={chainId:()=>97,feeReserve:async()=>27n*10n**16n,holdsOnlyCash:async()=>false,
    owned:(portfolioId,wallet)=>requireOwnedPortfolio(portfolioId,wallet,{chainId:97}),
    version:(sid,v,chainSid,acct,options)=>requireTypedVersion(sid,v,chainSid,acct,{...options,chainId:97,
      assertOnchain:(onchainId,index,expected,account,readOptions)=>assertVersionOnchain(onchainId,index,expected,account,{...readOptions,client:rpc.client,registry:TESTNET_97.contracts.registry})}),
    evidence:(c)=>readFaucetFundingEvidence(c,rpc.client),walletEvidence:c=>readWalletFundingEvidence(c,rpc.client),cash:(chainId,account)=>readAccountCash(chainId,account,rpc.client)};
  const service=createPortfolioStrategyService(deps);
  let nextDay=2;
  async function secondClaim(nextAmount=amount) {
    const hash=txHash();
    const createdAt=`2000-01-${String(nextDay++).padStart(2,'0')}T00:00:00Z`;
    const row=(await query<{id:string}>("insert into faucet_claims(chain_id,owner,account,amount_wei,tx_hash,state,created_at) values(97,$1,$2,$3,$4,'unknown',$5) returning id",[owner,account,nextAmount.toString(),hash,createdAt])).rows[0];
    assert.ok(row);fixtureClaimIds.push(row.id);
    rpc.state.txHash=hash;rpc.state.amount=nextAmount;rpc.state.cashRaw+=nextAmount;
    return {source:{kind:'faucet_claim',claimId:row.id}};
  }
  return {owner,account,strategyId,onchainId,id,hash,claimId:claim.id,rpc,deps,service,execution,allocation,secondClaim,source:{source:{kind:'faucet_claim',claimId:claim.id}}};
}
async function bucket(id:number,key:'stack_prefund_raw'|'unallocated_hold_raw'){
  const row=(await query<{amount:string}>(`select ${key}::text as amount from strategy_cash_balances where chain_id=97 and portfolio_id=$1`,[id])).rows[0];
  return row?.amount??'0';
}
async function onTestnet<T>(fn:()=>Promise<T>):Promise<T>{
  const previous=process.env.CHAIN_ID;process.env.CHAIN_ID='97';
  try{return await fn();}finally{if(previous===undefined)delete process.env.CHAIN_ID;else process.env.CHAIN_ID=previous;}
}

test('#168 DB $50 contributions persist and reserve every launch hold component, including every 5% satellite', async () => {
  const run: WithTransactionFn = fn => withTransaction(client => fn({ query: (sql, params) => client.query(sql, params === undefined ? [] : [...params]) }));
  let componentCount = 0;
  for (const fund of launchFunds(launchLineup)) {
    const basket = validateAllocation(fund.input.allocation, 97);
    const execution = validateAssetConfig(fund.input.execution, basket, 97);
    const f = await fixture('hold', 0, 50n * 10n ** 18n, execution);
    const lot = await f.service.funding(f.id, f.owner, f.source);
    const sources = await assetSources(lot.id);
    for (const a of basket.assets.filter(a => a.weightBps > 0)) {
      const source = sources.find(s => s.asset === a.address); assert.ok(source);
      assert.equal(source.budget_raw, (50n * 10n ** 18n * BigInt(a.weightBps) / 10000n).toString());
      assert.equal(source.effective_slices, 1);
      if (a.weightBps === 500) assert.equal(source.budget_raw, usdtRaw('2.5').toString());
    }
    const c: JobContext = { chainId: 97, portfolioId: f.id, strategyId: f.strategyId, version: 1, kind: 'asset', execution,
      account: f.account, allocation: basket, cash: TESTNET_97.contracts.usdt, now: new Date('2026-11-15T14:00:00Z'),
      reserve: 27n * 10n ** 16n, caps: new Map(basket.assets.filter(a => a.weightBps > 0).map(a => [a.address, null])),
      buyLimit: UINT256_MAX, observedCash: 50n * 10n ** 18n, enabled: true, marketOpen: true };
    const { job } = await prepareStrategyJob(run, c, await fundingLots(query, c));
    assert.ok(job);
    const expected = basket.assets.filter(a => a.weightBps > 0).map(a => a.address).sort();
    assert.deepEqual(Object.keys(job.remaining_input).sort(), expected);
    assert.ok(Object.values(job.remaining_input).every(raw => BigInt(raw) > 0n));
    assert.equal((await query("select 1 from strategy_asset_slices where lot_id=$1 and state='deferred_min_asset'", [lot.id])).rows.length, 0);
    componentCount += expected.length;
    assert.deepEqual(f.rpc.state.broadcasts, []);
  }
  assert.equal(componentCount, 80);
});
const future=()=>new Date(Date.now()+86400_000).toISOString();

test('#160 all noncash components full rejects even with a positive cash weight, without creating a lot', async () => {
  const f = await fixture('hold');
  const service = createPortfolioStrategyService({ ...f.deps, exposure: async () => [
    { address: TESTNET_97.assets.AAPLB.token, buyPaused: true, exposureCapUsdtWei: '4000', currentExposureUsdtWei: '4000' },
    { address: TESTNET_97.contracts.usdt, buyPaused: false, exposureCapUsdtWei: null, currentExposureUsdtWei: '0' },
  ] });
  await assert.rejects(service.funding(f.id, f.owner, f.source), denied('FUND_FULL'));
  assert.equal((await query('select id from strategy_funding_lots where portfolio_id=$1', [f.id])).rows.length, 0);
});

function exposureService(f: Awaited<ReturnType<typeof fixture>>, paused: Set<string>) {
  return createPortfolioStrategyService({ ...f.deps, exposure: async () => f.execution.assets.map(a => ({ address:a.asset,
    exposureCapUsdtWei:a.asset===f.execution.numeraire?null:'4000',currentExposureUsdtWei:paused.has(a.asset)?'4000':'0',buyPaused:paused.has(a.asset),
  })) });
}
function capConfig(mode:'hold'|'stack'='hold',weights=[5000,3000,2000,0]): AssetExecution {
  const tokens=[TESTNET_97.assets.AAPLB.token,TESTNET_97.assets.MSFTB.token,TESTNET_97.assets.NVDAB.token,TESTNET_97.contracts.usdt];
  return assetConfig(mode,validateAllocation({assets:tokens.map((address,i)=>({address,weightBps:weights[i]})).filter(a=>a.weightBps!==0||a.address===TESTNET_97.contracts.usdt)},97));
}
const assetSources = async (lotId:string) => (await query<{asset:string;budget_raw:string;effective_slices:number;first_slot_at:Date|null}>(
  'select asset,budget_raw::text,effective_slices,first_slot_at from strategy_lot_assets where lot_id=$1 order by asset',[lotId])).rows;

test('#160 DB new hold/stack lots freeze proportional certificates, preserve calendars, seed only retained sources and balance exact cash dust',async()=>{
  const a=TESTNET_97.assets.AAPLB.token,b=TESTNET_97.assets.MSFTB.token,c=TESTNET_97.assets.NVDAB.token,cash=TESTNET_97.contracts.usdt;
  for(const mode of ['hold','stack'] as const){
    const f=await fixture(mode,0,100n*10n**18n+1n,capConfig(mode));
    const lot=await exposureService(f,new Set([a])).funding(f.id,f.owner,f.source);
    assert.deepEqual(lot.effectiveAllocation,{[b]:6000,[c]:4000});assert.deepEqual(lot.cappedAssets,[a]);assert.equal(lot.allocationReason,'exposure_cap');
    const sources=await assetSources(lot.id);
    assert.ok(!sources.some(s=>s.asset===a));
    assert.equal(sources.find(s=>s.asset===b)?.budget_raw,(60n*10n**18n).toString());
    assert.equal(sources.find(s=>s.asset===c)?.budget_raw,(40n*10n**18n).toString());
    assert.equal(sources.find(s=>s.asset===cash)?.budget_raw,'1');
    assert.equal(await bucket(f.id,mode==='hold'?'unallocated_hold_raw':'stack_prefund_raw'),(100n*10n**18n).toString());
    if(mode==='stack')assert.ok(sources.filter(s=>s.asset!==cash).every(s=>s.first_slot_at?.toISOString()==='2026-11-15T14:00:00.000Z'));
    assert.deepEqual(Object.keys(lot.effectiveSlices??{}).sort(),[b,c].sort());
    const read=await exposureService(f,new Set([a,b,c])).read(f.id,f.owner);
    assert.equal(read.lots[0]?.allocationReason,'exposure_cap');assert.deepEqual(read.lots[0]?.effectiveAllocation,lot.effectiveAllocation);
    const replay=await createPortfolioStrategyService({...f.deps,exposure:async()=>{throw new Error('must not recalculate an existing lot');}}).funding(f.id,f.owner,f.source);
    assert.equal(replay.replayed,true);assert.deepEqual(replay.effectiveAllocation,lot.effectiveAllocation);assert.deepEqual(await assetSources(lot.id),sources);
  }
});

test('#160 DB two capped components give the remaining component all new money; all full leaves the prior source untouched',async()=>{
  const a=TESTNET_97.assets.AAPLB.token,b=TESTNET_97.assets.MSFTB.token,c=TESTNET_97.assets.NVDAB.token;
  const f=await fixture('hold',0,TEST_AMOUNT,capConfig());
  const paused=new Set<string>([a,b]);const service=exposureService(f,paused);
  const lot=await service.funding(f.id,f.owner,f.source);assert.deepEqual(lot.effectiveAllocation,{[c]:10000});
  assert.equal((await assetSources(lot.id)).find(s=>s.asset===c)?.budget_raw,TEST_AMOUNT.toString());
  const before=await bucket(f.id,'unallocated_hold_raw');const source=await f.secondClaim();paused.add(c);
  await assert.rejects(service.funding(f.id,f.owner,source),denied('FUND_FULL'));
  assert.equal(await bucket(f.id,'unallocated_hold_raw'),before);assert.equal((await query('select id from strategy_funding_lots where portfolio_id=$1',[f.id])).rows.length,1);
});

test('#160 DB contribution minimum is never lowered and an increased effective cash weight must still fund a ten-USDT batch',async()=>{
  const a=TESTNET_97.assets.AAPLB.token;
  const f=await fixture('hold',9900,1000n*10n**18n,capConfig('hold',[50,50,0,9900]));
  const service=exposureService(f,new Set([a]));
  await assert.rejects(service.funding(f.id,f.owner,f.source),denied('BELOW_MINIMUM_ALLOCATION'));
  assert.equal((await query('select id from strategy_funding_lots where portfolio_id=$1',[f.id])).rows.length,0);
  const minimum=2000n*10n**18n;
  await assert.rejects(service.funding(f.id,f.owner,await f.secondClaim(minimum-1n)),denied('BELOW_MINIMUM_ALLOCATION'));
  const lot=await service.funding(f.id,f.owner,await f.secondClaim(minimum));
  assert.equal(lot.amountRaw,minimum.toString());
  assert.equal((await query('select minimum_contribution_raw::text as minimum from strategy_funding_lots where id=$1',[lot.id])).rows[0]?.minimum,minimum.toString());
});

test('#160 DB exposure RPC/DB failure, timeout and rollback create no lot or cash; competing requests and lost acknowledgement credit once',async()=>{
  const f=await fixture('hold',0,TEST_AMOUNT,capConfig());
  for(const exposure of [async()=>{throw new Error('SECRET_DB');},async()=>{throw new AppError(503,'EXPOSURE_UNAVAILABLE','fund exposure unavailable');}]){
    await assert.rejects(createPortfolioStrategyService({...f.deps,exposure}).funding(f.id,f.owner,f.source),error=>error instanceof AppError&&error.status===503&&!error.message.includes('SECRET'));
    assert.equal((await query('select id from strategy_funding_lots where portfolio_id=$1',[f.id])).rows.length,0);
  }
  const paused=new Set<string>([TESTNET_97.assets.AAPLB.token]);
  const exposure:PortfolioStrategyDeps['exposure']=async()=>f.execution.assets.map(a=>({address:a.asset,buyPaused:paused.has(a.asset),exposureCapUsdtWei:paused.has(a.asset)?'1':null,currentExposureUsdtWei:'1'}));
  const transactions:typeof withTransaction[]=[
    fn=>withTransaction(async client=>{await fn(client);throw new Error('SECRET_ROLLBACK');}),
    fn=>withTransaction(async client=>{const result=await fn(client);await client.query("set local statement_timeout='20ms'");await client.query('select pg_sleep(1)');return result;}),
  ];
  for(const transaction of transactions){
    await assert.rejects(createPortfolioStrategyService({...f.deps,exposure,transaction}).funding(f.id,f.owner,f.source),denied('EXECUTION_STORAGE_UNAVAILABLE'));
    assert.equal((await query('select id from strategy_funding_lots where portfolio_id=$1',[f.id])).rows.length,0);
    assert.equal(await bucket(f.id,'unallocated_hold_raw'),'0');
  }
  const unknown:typeof withTransaction=async fn=>{await withTransaction(fn);throw new Error('SECRET_ACK');};
  await assert.rejects(createPortfolioStrategyService({...f.deps,exposure,transaction:unknown}).funding(f.id,f.owner,f.source),denied('EXECUTION_STORAGE_UNAVAILABLE'));
  const results=await Promise.allSettled([createPortfolioStrategyService({...f.deps,exposure}).funding(f.id,f.owner,f.source),createPortfolioStrategyService({...f.deps,exposure}).funding(f.id,f.owner,f.source)]);
  assert.ok(results.some(r=>r.status==='fulfilled'&&r.value.replayed));
  for(const r of results)if(r.status==='rejected')assert.ok(r.reason instanceof AppError&&r.reason.code==='PORTFOLIO_BUSY');
  assert.equal((await query('select id from strategy_funding_lots where portfolio_id=$1',[f.id])).rows.length,1);
  assert.equal(await bucket(f.id,'unallocated_hold_raw'),TEST_AMOUNT.toString());
});

test('#160 DB operator cap update/clear is atomic with provenance; unknown symbols and USDT are rejected',async()=>{
  await migrate();
  const rollback=new Error('test rollback');
  await assert.rejects(withTransaction(async client=>{
    const scoped=(sql:string,params?:readonly unknown[])=>client.query(sql,params===undefined?[]:[...params]);
    for(const cap of ['1',null]){
      await setAssetExposureCap('AAPLB',{exposureCapUsdtWei:cap,source:'test snapshot'},scoped);
      const row=(await scoped('select max_fund_exposure_usdt::text as cap,max_fund_exposure_source as source,max_fund_exposure_updated_at as updated from priceable_assets where symbol=$1',['AAPLB'])).rows[0];
      assert.equal(row.cap,cap);assert.equal(row.source,'test snapshot');assert.ok(row.updated instanceof Date);
    }
    await assert.rejects(setAssetExposureCap('USDT',{exposureCapUsdtWei:'1',source:'test'},scoped),denied('INVALID_EXPOSURE_CAP'));
    await assert.rejects(setAssetExposureCap('NOT_A_CATALOG_SYMBOL_160',{exposureCapUsdtWei:null,source:'test'},scoped),denied('NOT_FOUND'));
    throw rollback;
  }),error=>error===rollback);
});

test('#160 DB exposure aggregates only the same strategy and chain, including paused portfolios without session keys',async()=>{
  const f=await fixture('hold');const foreign=await fixture('hold');
  const p=(await query<{id:string}>("insert into portfolios(user_id,strategy_id,version,schedule_state) values($1,$2,1,'paused') returning id",[address(),f.strategyId])).rows[0];assert.ok(p);
  await query("insert into smart_accounts(portfolio_id,chain_id,address,owner,account_type) values($1,97,$2,$3,'KERNEL'),($1,56,$4,$3,'KERNEL')",[p.id,address(),address(),address()]);
  const client=createPublicClient({transport:custom({request:async({method})=>{
    if(method==='eth_chainId')return '0x61';if(method==='eth_blockNumber')return '0x82';throw new Error('unexpected RPC');
  }},{retryCount:0})});
  const rollback=new Error('test rollback');const seen:number[]=[];
  await assert.rejects(withTransaction(async db=>{
    const scoped=(sql:string,params?:readonly unknown[])=>db.query(sql,params===undefined?[]:[...params]);
    await setAssetExposureCap('AAPLB',{exposureCapUsdtWei:(1000n*10n**18n).toString(),source:'test snapshot'},scoped);
    const result=await readAssetExposure(f.strategyId,97,[TESTNET_97.assets.AAPLB.token],{query:scoped,client,positions:async(_client,args)=>{
      assert.equal(args.block,130n);assert.ok(args.portfolioId===f.id||args.portfolioId===Number(p.id));assert.notEqual(args.portfolioId,foreign.id);seen.push(args.portfolioId);
      return {portfolioId:args.portfolioId,block:130n,nativeBalanceWei:0n,holdings:[{asset:TESTNET_97.assets.AAPLB.token,amountWei:500n*10n**18n,decimals:18,usdPriceE8:100_000_000n,priceSource:'pancakeswap-v3'}],unpriced:[]};
    }});
    assert.deepEqual(result,[{address:TESTNET_97.assets.AAPLB.token,buyPaused:true,exposureCapUsdtWei:(1000n*10n**18n).toString(),currentExposureUsdtWei:(1000n*10n**18n).toString()}]);
    assert.deepEqual(seen,[f.id,Number(p.id)]);
    throw rollback;
  }),error=>error===rollback);
});

async function walletFixture(kind: 'hold' | 'stack' = 'hold', amount = TEST_AMOUNT, cashWeight = 5000) {
  const f = await fixture(kind, cashWeight, amount === 0n ? TEST_AMOUNT : amount);
  const hash = txHash();
  f.rpc.state.txHash = hash;
  f.rpc.state.mint = true;
  f.rpc.state.transferFrom = f.owner;
  f.rpc.state.amount = amount;
  f.rpc.state.cashRaw = amount;
  return { ...f, hash, source: { source: { kind: 'wallet_transfer', txHash: hash } } };
}

test('#151 owner wallet transfer credits one lot and preserves the funding response contract', async () => {
  const f = await walletFixture();
  const lot = await f.service.funding(f.id, f.owner, f.source);
  assert.deepEqual(lot.source, f.source.source);
  assert.equal(lot.amountRaw, TEST_AMOUNT.toString());
  assert.equal(lot.replayed, false);
  assert.equal(lot.kind, 'asset');
  assert.equal(await bucket(f.id, 'unallocated_hold_raw'), (TEST_AMOUNT / 2n).toString());
  const saved = (await query('select source_kind,faucet_claim_id,welcome_grant_id,log_index::text from strategy_funding_lots where id=$1', [lot.id])).rows;
  assert.deepEqual(saved, [{ source_kind: null, faucet_claim_id: null, welcome_grant_id: null, log_index: '0' }]);
  const read = await f.service.read(f.id, f.owner);
  assert.equal(read.lots[0]?.id, lot.id); assert.equal(read.lots[0]?.source, null, 'untyped history is never relabelled');
  assert.equal(read.cash.unclassifiedRaw, '0');
  assert.equal(read.balances?.allocated_cash_raw, (TEST_AMOUNT / 2n).toString());
  const replay = await createPortfolioStrategyService(f.deps).funding(f.id, f.owner, f.source);
  assert.equal(replay.id, lot.id); assert.equal(replay.replayed, true);
  assert.equal(await bucket(f.id, 'unallocated_hold_raw'), (TEST_AMOUNT / 2n).toString());
});

test('#151 wallet lots feed the ordinary hold/stack scheduler with the original amount and receipt-time slices', async () => {
  const run: WithTransactionFn = fn => withTransaction(client => fn({ query: (sql, params) => client.query(sql, params === undefined ? [] : [...params]) }));
  for (const kind of ['hold', 'stack'] as const) {
    const f = await walletFixture(kind);
    const lot = await f.service.funding(f.id, f.owner, f.source);
    const rows = (await query<{ budget_raw: string; effective_slices: number }>('select budget_raw::text,effective_slices from strategy_lot_assets where lot_id=$1 and asset=$2', [lot.id, TESTNET_97.assets.AAPLB.token])).rows;
    assert.deepEqual(rows, [{ budget_raw: (TEST_AMOUNT / 2n).toString(), effective_slices: kind === 'hold' ? 1 : 12 }]);
    const c: JobContext = { chainId: 97, portfolioId: f.id, strategyId: f.strategyId, version: 1, kind: 'asset', execution: f.execution,
      account: f.account, allocation: f.allocation, cash: TESTNET_97.contracts.usdt, now: new Date('2026-11-15T14:00:00Z'),
      reserve: 27n * 10n ** 16n, caps: new Map([[TESTNET_97.assets.AAPLB.token, null]]), buyLimit: UINT256_MAX,
      observedCash: TEST_AMOUNT, enabled: true, marketOpen: true };
    const lots = await fundingLots(query, c); assert.equal(lots[0]?.id, lot.id);
    const { job } = await prepareStrategyJob(run, c, lots);
    assert.ok(job); assert.equal(job.kind, 'asset'); assert.equal(job.state, 'reserved');
    assert.ok(BigInt(job.remaining_input[TESTNET_97.assets.AAPLB.token] ?? '0') > 0n);
    assert.deepEqual(f.rpc.state.broadcasts, []);
  }
});

test('2026-11-25 portfolio 32: the owner\'s new money after "sell all" resumes the paused portfolio and is bought; a paused portfolio that still holds assets stays paused', async () => {
  const run: WithTransactionFn = fn => withTransaction(client => fn({ query: (sql, params) => client.query(sql, params === undefined ? [] : [...params]) }));
  const state = async (id: number) => (await query<{ schedule_state: string; next_run_at: Date | null }>('select schedule_state,next_run_at from portfolios where id=$1', [id])).rows[0];
  const claimed = async (id: number) => (await withTransaction(client => claimDuePortfolios(100000, new Date(), { chainId: 97, advance: false, withTransaction: async work => work(client) }))).some(row => row.portfolioId === id);
  // "Sell all" paused it (the fixture's portfolio is paused) and the account holds nothing but USDT.
  const f = await walletFixture('hold');
  const asked: number[] = [];
  const sold = createPortfolioStrategyService({ ...f.deps, holdsOnlyCash: async id => { asked.push(id); return true; } });
  assert.equal(await claimed(f.id), false, 'a paused portfolio is not claimed');
  const lot = await sold.funding(f.id, f.owner, f.source);
  assert.equal(lot.replayed, false); assert.deepEqual(asked, [f.id]);
  assert.deepEqual(await state(f.id), { schedule_state: 'active', next_run_at: null });
  assert.equal(await claimed(f.id), true, 'the scheduler claims it at its next round');
  const c: JobContext = { chainId: 97, portfolioId: f.id, strategyId: f.strategyId, version: 1, kind: 'asset', execution: f.execution,
    account: f.account, allocation: f.allocation, cash: TESTNET_97.contracts.usdt, now: new Date('2026-11-15T14:00:00Z'),
    reserve: 27n * 10n ** 16n, caps: new Map([[TESTNET_97.assets.AAPLB.token, null]]), buyLimit: UINT256_MAX,
    observedCash: TEST_AMOUNT, enabled: true, marketOpen: true };
  const { job } = await prepareStrategyJob(run, c, await fundingLots(query, c));
  assert.ok(job); assert.equal(job.state, 'reserved'); assert.ok(BigInt(job.remaining_input[TESTNET_97.assets.AAPLB.token] ?? '0') > 0n);
  // The same source sent again is not new money: a portfolio paused since then stays paused.
  await query("update portfolios set schedule_state='paused' where id=$1", [f.id]);
  assert.equal((await sold.funding(f.id, f.owner, f.source)).replayed, true);
  assert.equal((await state(f.id))?.schedule_state, 'paused');
  // A DCA tranche is not the owner putting money in: the account is not even read.
  asked.length = 0;
  const tranche = await sold.creditDcaTranche(f.id, f.owner, { txHash: txHash(), logIndex: 7, blockNumber: 130n, blockHash: BLOCK_HASH, amountRaw: (100n * 10n ** 18n).toString(), confirmedAt: activeAt });
  assert.equal(tranche.replayed, false); assert.deepEqual(asked, []);
  assert.equal((await state(f.id))?.schedule_state, 'paused');

  // Paused by the owner (`execution-state`) with assets in the account: the money is recorded, the pause stays.
  const g = await walletFixture('hold');
  const holding = createPortfolioStrategyService({ ...g.deps, holdsOnlyCash: async () => false });
  assert.deepEqual(await holding.executionState(g.id, g.owner, { enabled: false }), { portfolioId: g.id, enabled: false });
  assert.equal((await holding.funding(g.id, g.owner, g.source)).replayed, false);
  assert.equal((await state(g.id))?.schedule_state, 'paused'); assert.equal(await claimed(g.id), false);

  // The account cannot be read: the money is still recorded and nothing else changes.
  const u = await walletFixture('hold');
  const unreadable = createPortfolioStrategyService({ ...u.deps, holdsOnlyCash: async () => { throw new Error('rpc down'); } });
  const warn = console.warn; const lines: unknown[] = []; console.warn = (line: unknown) => { lines.push(line); };
  try { assert.equal((await unreadable.funding(u.id, u.owner, u.source)).replayed, false); } finally { console.warn = warn; }
  assert.equal((await state(u.id))?.schedule_state, 'paused'); assert.equal(lines.length, 1);

  // An active portfolio is never read for this.
  const a = await walletFixture('hold');
  await query("update portfolios set schedule_state='active' where id=$1", [a.id]);
  const active = createPortfolioStrategyService({ ...a.deps, holdsOnlyCash: async () => { throw new Error('must not be asked'); } });
  assert.equal((await active.funding(a.id, a.owner, a.source)).replayed, false);
  assert.equal((await state(a.id))?.schedule_state, 'active');
  await query("update portfolios set schedule_state='paused' where id=any($1::bigint[])", [[f.id, a.id]]);
});

test('2026-11-25 the resume after "sell all" leaves My mix portfolios that were paused on purpose alone', async () => {
  // Temp tables shadow the real ones for this connection only: the statement is exercised as written.
  const client = await getPool().connect();
  try {
    await client.query('create temp table portfolios (id bigint primary key, schedule_state text)');
    await client.query('create temp table mixes (id bigint primary key, status text, triggered_at timestamptz, delete_requested_at timestamptz, deleted_at timestamptz)');
    await client.query('create temp table mix_portfolio_history (mix_id bigint, portfolio_id bigint, ended_at timestamptz)');
    const mix = async (portfolio: number, state: string, patch: string, ended = false) => {
      await client.query('insert into portfolios values($1,$2)', [portfolio, state]);
      await client.query(`insert into mixes(id,status) values($1,'active')`, [portfolio]);
      if (patch) await client.query(`update mixes set ${patch} where id=$1`, [portfolio]);
      await client.query('insert into mix_portfolio_history values($1,$1,$2)', [portfolio, ended ? new Date() : null]);
    };
    await client.query("insert into portfolios values(1,'paused'),(2,'active'),(3,'idle')"); // fund accounts: no mix rows
    await mix(10, 'paused', '');                              // My mix after "sell all"
    await mix(11, 'paused', "status='exited'");               // take profit / stop loss / delete finished
    await mix(12, 'paused', 'triggered_at=now()');            // exit in progress (retry guard)
    await mix(13, 'paused', 'delete_requested_at=now()');     // deleting
    await mix(14, 'paused', 'deleted_at=now()');              // deleted
    await mix(15, 'paused', '', true);                        // the old portfolio of a re-enrolled mix
    for (const id of [1, 2, 3, 10, 11, 12, 13, 14, 15]) await client.query(RESUME_AFTER_SELL_ALL_SQL, [id]);
    const rows = (await client.query<{ n: number; schedule_state: string }>('select id::int as n,schedule_state from portfolios order by id')).rows;
    assert.deepEqual(rows.map(r => [r.n, r.schedule_state]), [[1, 'active'], [2, 'active'], [3, 'idle'], [10, 'active'],
      [11, 'paused'], [12, 'paused'], [13, 'paused'], [14, 'paused'], [15, 'paused']]);
  } finally {
    await client.query('discard temp').catch(() => {});
    client.release();
  }
});

test('#151 wallet funding rejects foreign authentication, wrong from/to and RPC failures without lot or cash credit', async () => {
  for (const scenario of ['auth', 'from', 'to', 'rpc', 'missing']) {
    const f = await walletFixture();
    if (scenario === 'from') f.rpc.state.transferFrom = address();
    if (scenario === 'to') f.rpc.state.to = address();
    if (scenario === 'rpc') f.rpc.state.fail = 'eth_getTransactionReceipt';
    if (scenario === 'missing') f.rpc.state.logs = false;
    await assert.rejects(f.service.funding(f.id, scenario === 'auth' ? address() : f.owner, f.source),
      denied(scenario === 'auth' ? 'FORBIDDEN' : scenario === 'rpc' ? 'FUNDING_RPC_UNAVAILABLE' : 'FUNDING_NOT_CONFIRMED'));
    assert.equal((await query('select id from strategy_funding_lots where portfolio_id=$1', [f.id])).rows.length, 0);
    assert.equal((await query('select portfolio_id from strategy_cash_balances where portfolio_id=$1', [f.id])).rows.length, 0);
  }
});

test('#151 zero and one raw below the existing minimum reject; equality and larger transfers preserve exact log amounts', async () => {
  for (const amount of [0n, usdtRaw('50') - 1n, usdtRaw('50'), usdtRaw('10000001')]) {
    const f = await walletFixture('hold', amount, 0);
    if (amount < usdtRaw('50')) {
      await assert.rejects(f.service.funding(f.id, f.owner, f.source), denied(amount === 0n ? 'FUNDING_NOT_CONFIRMED' : 'BELOW_MINIMUM_ALLOCATION'));
      assert.equal((await query('select id from strategy_funding_lots where portfolio_id=$1', [f.id])).rows.length, 0);
      assert.equal(await bucket(f.id, 'unallocated_hold_raw'), '0');
    } else {
      const lot = await f.service.funding(f.id, f.owner, f.source);
      assert.equal(lot.amountRaw, amount.toString()); assert.equal(await bucket(f.id, 'unallocated_hold_raw'), amount.toString());
    }
  }
});

test('#151 competing requests, rollback, DB timeout and lost COMMIT acknowledgement cannot double-credit a wallet transfer', async () => {
  const f = await walletFixture();
  const rollback: typeof withTransaction = fn => withTransaction(async client => { await fn(client); throw new Error('SECRET_DB'); });
  const timeout: typeof withTransaction = fn => withTransaction(async client => {
    const result = await fn(client); await client.query("set local statement_timeout='20ms'"); await client.query('select pg_sleep(1)'); return result;
  });
  for (const transaction of [rollback, timeout]) {
    await assert.rejects(createPortfolioStrategyService({ ...f.deps, transaction }).funding(f.id, f.owner, f.source),
      error => error instanceof AppError && error.code === 'EXECUTION_STORAGE_UNAVAILABLE' && !error.message.includes('SECRET'));
    assert.equal((await query('select id from strategy_funding_lots where portfolio_id=$1', [f.id])).rows.length, 0);
    assert.equal(await bucket(f.id, 'unallocated_hold_raw'), '0');
  }
  const unknown: typeof withTransaction = async fn => { await withTransaction(fn); throw new Error('SECRET_COMMIT_ACK'); };
  await assert.rejects(createPortfolioStrategyService({ ...f.deps, transaction: unknown }).funding(f.id, f.owner, f.source), denied('EXECUTION_STORAGE_UNAVAILABLE'));
  let entered = () => {}, release = () => {};
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  const competing = createPortfolioStrategyService({ ...f.deps, walletEvidence: async input => {
    entered(); await proceed; return readWalletFundingEvidence(input, f.rpc.client);
  } }).funding(f.id, f.owner, f.source);
  await reading;
  try { await assert.rejects(f.service.funding(f.id, f.owner, f.source), denied('PORTFOLIO_BUSY')); }
  finally { release(); await competing; }
  const replay = await f.service.funding(f.id, f.owner, f.source); assert.equal(replay.replayed, true);
  assert.equal((await query('select id from strategy_funding_lots where portfolio_id=$1', [f.id])).rows.length, 1);
  assert.equal(await bucket(f.id, 'unallocated_hold_raw'), (TEST_AMOUNT / 2n).toString());
});

test('#151 wallet reorgs freeze the original event without resurrecting it or freeing credited cash', async () => {
  for (const scenario of ['canonical-block', 'moved-index', 'during-version']) {
    const f = await walletFixture(); await f.service.funding(f.id, f.owner, f.source);
    if (scenario === 'canonical-block') f.rpc.state.blockHash = OTHER_HASH;
    if (scenario === 'moved-index') f.rpc.state.logIndex++;
    if (scenario === 'during-version') f.rpc.state.reorgAtBlockRead = f.rpc.state.blockReads + 5;
    await assert.rejects(f.service.funding(f.id, f.owner, f.source), denied('FUNDING_REORGED'));
    assert.deepEqual((await query('select state from strategy_funding_lots where portfolio_id=$1', [f.id])).rows, [{ state: 'reorged' }]);
    assert.equal(await bucket(f.id, 'unallocated_hold_raw'), (TEST_AMOUNT / 2n).toString());
    await assert.rejects(f.service.executionState(f.id, f.owner, { enabled: true }), denied('FUNDING_REORGED'));
  }
});

test('#151 a DB failure while freezing a reorg never returns success, leaks details or credits again', async () => {
  const f = await walletFixture(); await f.service.funding(f.id, f.owner, f.source);
  f.rpc.state.blockHash = OTHER_HASH;
  const service = createPortfolioStrategyService({ ...f.deps, transaction: async () => { throw new Error('SECRET_DB'); } });
  await assert.rejects(service.funding(f.id, f.owner, f.source), error => error instanceof AppError && error.code === 'EXECUTION_STORAGE_UNAVAILABLE' && !error.message.includes('SECRET'));
  assert.equal(await bucket(f.id, 'unallocated_hold_raw'), (TEST_AMOUNT / 2n).toString());
  await assert.rejects(f.service.funding(f.id, f.owner, f.source), denied('FUNDING_REORGED'));
  assert.deepEqual((await query('select state from strategy_funding_lots where portfolio_id=$1', [f.id])).rows, [{ state: 'reorged' }]);
});

test('#151 wallet transfers bind to receipt-time enrollment and reject a later pinned version or inactive strategy', async () => {
  for (const scenario of ['version', 'before-active']) {
    const f = await walletFixture(); f.rpc.state.latestBlockNumber = 131n;
    if (scenario === 'version') f.rpc.state.historicalPinned = 2; else f.rpc.state.historicalNow--;
    await assert.rejects(f.service.funding(f.id, f.owner, f.source), denied(scenario === 'version' ? 'CHAIN_VERSION_MISMATCH' : 'VERSION_NOT_ACTIVE'));
    assert.equal((await query('select id from strategy_funding_lots where portfolio_id=$1', [f.id])).rows.length, 0);
  }
});

test('#151 different portfolio logs in one transaction retain separate unique event identities', async () => {
  const a = await walletFixture(), b = await walletFixture();
  b.rpc.state.txHash = a.hash;
  const first = await a.service.funding(a.id, a.owner, a.source);
  await assert.rejects(b.service.funding(b.id, b.owner, a.source), denied('FUNDING_EVENT_CONFLICT'));
  assert.equal(await bucket(b.id, 'unallocated_hold_raw'), '0');
  b.rpc.state.logIndex = 1;
  const second = await b.service.funding(b.id, b.owner, a.source);
  assert.notEqual(first.id, second.id); assert.equal(first.logIndex, '0'); assert.equal(second.logIndex, '1');
  assert.equal(await bucket(a.id, 'unallocated_hold_raw'), (TEST_AMOUNT / 2n).toString());
  assert.equal(await bucket(b.id, 'unallocated_hold_raw'), (TEST_AMOUNT / 2n).toString());
});

test('#151 wallet funding HTTP accepts normalized hashes and returns the existing lot shape on first write and retry', async () => {
  const { createServer } = await import('../src/server.js');
  const f = await walletFixture();
  const server = createServer({ portfolioStrategies: f.service, auth: { authenticate: async () => f.owner,
    issueNonce: () => { throw new Error('unexpected'); }, login: async () => { throw new Error('unexpected'); }, logout: async () => {} } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    let id: unknown;
    for (const replayed of [false, true]) {
      const response = await fetch(`http://127.0.0.1:${address.port}/portfolios/${f.id}/funding-lots`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: { kind: 'wallet_transfer', txHash: `0x${f.hash.slice(2).toUpperCase()}` } }) });
      assert.equal(response.status, 200);
      const lot: unknown = await response.json(); assert.ok(lot && typeof lot === 'object');
      assert.deepEqual(Reflect.get(lot, 'source'), f.source.source); assert.equal(Reflect.get(lot, 'replayed'), replayed);
      assert.equal(Reflect.get(lot, 'amountRaw'), TEST_AMOUNT.toString()); assert.ok(Reflect.get(lot, 'effectiveSlices'));
      if (!replayed) id = Reflect.get(lot, 'id'); else assert.equal(Reflect.get(lot, 'id'), id);
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('#118 preview and persisted contribution share effective slices, receipt time, minimum and conservative fee bound',async()=>{
  const at=new Date('2026-11-16T13:59:00Z'),cash=TESTNET_97.contracts.usdt,asset=TESTNET_97.assets.AAPLB.token;
  for(const [amount,slices,cashWeight] of [[100n,12,0],[3650n,365,0],[50n,12,5000],[1000n,12,9900],[10_000_000n,365,0]] as const){
    const basket=validateAllocation({assets:[{address:asset,weightBps:10000-cashWeight},{address:cash,weightBps:cashWeight}]},97);
    const execution=assetConfig('stack',basket);
    for(const a of execution.assets)if(a.execution?.kind==='stack')a.execution.slices=slices;
    const raw=usdtRaw(amount.toString()),f=await fixture('stack',cashWeight,raw,execution);
    f.rpc.state.now=BigInt(+at/1000);
    const preview=previewContribution({chainId:97,execution,amountRaw:raw.toString()},at);
    assert.deepEqual(await previewContributionAsync({chainId:97,execution,amountRaw:raw.toString()},at),preview);
    const lot=await f.service.funding(f.id,f.owner,f.source);
    assert.deepEqual(lot.effectiveSlices,preview.effectiveSlices);assert.equal(lot.confirmedAt,at.toISOString());
    const stored=(await query<{effective_slices:Record<string,number>;minimum:string}>('select effective_slices,minimum_contribution_raw::text as minimum from strategy_funding_lots where id=$1',[lot.id])).rows[0];assert.ok(stored);
    assert.deepEqual(stored.effective_slices,preview.effectiveSlices);assert.equal(stored.minimum,preview.minimumRaw);
    assert.equal(await strategyMinimumDeposit(f.strategyId),preview.minimumRaw);
    assert.equal(preview.slots[0]?.at,'2026-11-16T14:00:00.000Z');
  }
});
test('#118 contribution fee bound fails closed on RPC errors or unsupported reserve without saving a lot',async()=>{
  for(const reserve of [-1n,usdtRaw('0.30')+1n,null]){
    const f=await fixture('hold');
    const service=createPortfolioStrategyService({...f.deps,feeReserve:async()=>{if(reserve===null)throw new Error('private upstream URL');return reserve;}});
    await assert.rejects(service.funding(f.id,f.owner,f.source),(error:unknown)=>error instanceof AppError&&error.status===503&&!error.message.includes('private'));
    assert.equal((await query('select id from strategy_funding_lots where portfolio_id=$1',[f.id])).rows.length,0);
    assert.equal(await bucket(f.id,'unallocated_hold_raw'),'0');
  }
});

test('#123 preview ceiling does not cap real contribution admission',async()=>{
  const f=await fixture('stack',0,usdtRaw('10000001'));
  const lot=await f.service.funding(f.id,f.owner,f.source);
  assert.deepEqual(lot.effectiveSlices,{[TESTNET_97.assets.AAPLB.token]:12});
});

test('#82 DB typed publish round-trip/default/retry is immutable; internal legacy rows retain schema 0 and null hash',async()=>onTestnet(async()=>{
  await migrate();
  const owner=address();
  const strategy=await createStrategy({name:'be82-typed-roundtrip'},owner);
  const basket={assets:[{address:TESTNET_97.contracts.usdt,weightBps:10000}]};
  const input={execution:assetConfig('hold',basket,97),allocation:basket};
  const versions=await Promise.all(Array.from({length:3},()=>publishVersion(strategy.id,input,owner)));
  assert.equal(new Set(versions.map(v=>v.version)).size,1);
  const first=versions[0];assert.ok(first);
  assert.deepEqual(first.execution,input.execution);assert.equal(first.executionSchemaVersion,2);assert.equal(first.executionChainId,97);
  assert.deepEqual(first.schedule,{kind:'funding'});assert.ok(first.configHash);
  assert.deepEqual((await getStrategy(strategy.id)).versions,[first]);
  await assert.rejects(query("update strategy_versions set schedule='{}' where strategy_id=$1",[strategy.id]),(error:unknown)=>typeof error==='object'&&error!==null&&Reflect.get(error,'code')==='23514');
  await assert.rejects(publishVersion(strategy.id,input,address()),denied('FORBIDDEN'));
  await assert.rejects(publishVersion(strategy.id,{...input,chainId:56},owner),denied('CHAIN_MISMATCH'));
  await assert.rejects(publishVersion(strategy.id,{...input,execution:{kind:'stack'}},owner),denied('INVALID_EXECUTION'));
  await assert.rejects(publishVersion(strategy.id,{...input,allocation:{...input.allocation,play:'dips'}},owner),denied('INVALID_ALLOCATION'));
  await assert.rejects(publishVersion(strategy.id,{...input,activeAt:'2026-11-15T00:00:00.001Z'},owner),denied('INVALID_ACTIVE_AT'));
  const legacy=await createStrategy({name:'be82-legacy'},owner);
  const old=await publishVersion(legacy.id,{allocation:input.allocation,schedule:{kind:'cron',cron:'0 0 * * *'}},owner);
  assert.deepEqual(old.execution,{kind:'target_weight'});assert.equal(old.executionSchemaVersion,0);assert.equal(old.configHash,null);assert.equal(old.executionChainId,null);
  assert.deepEqual(old.schedule,{kind:'cron',cron:'0 0 * * *'});
  await query('update strategies set onchain_id=$2 where id=$1',[strategy.id,strategy.id+90_000_000]);
  await assert.rejects(publishVersion(strategy.id,input,owner),denied('VERSION_UNAVAILABLE'));
  assert.equal((await getStrategy(strategy.id)).versions.length,1,'a failed mirror does not create a new DB version on retry');
}));

test('#82 DB exact faucet source credits each hold/stack account once across restart and competing workers',async()=>{
  for(const kind of ['hold','stack'] as const){
    const f=await fixture(kind);
    const empty=await f.service.read(f.id,f.owner);
    assert.equal(empty.balances,null);assert.deepEqual(empty.lots,[]);
    const calls=await Promise.allSettled([f.service.funding(f.id,f.owner,f.source),createPortfolioStrategyService(f.deps).funding(f.id,f.owner,f.source)]);
    assert.equal(calls.filter(r=>r.status==='fulfilled').length,1);
    for(const result of calls)if(result.status==='rejected')assert.ok(result.reason instanceof AppError&&result.reason.code==='PORTFOLIO_BUSY');
    const replay=await createPortfolioStrategyService(f.deps).funding(f.id,f.owner,f.source);
    assert.equal(replay.replayed,true);assert.equal(replay.amountRaw,TEST_AMOUNT.toString());assert.equal(replay.version,1);
    assert.equal(await bucket(f.id,kind==='hold'?'unallocated_hold_raw':'stack_prefund_raw'),(TEST_AMOUNT/2n).toString());
    assert.equal((await query<{amount:string}>('select allocated_cash_raw::text as amount from strategy_cash_balances where portfolio_id=$1',[f.id])).rows[0]?.amount,(TEST_AMOUNT/2n).toString());
    const rows=await query('select id from strategy_funding_lots where portfolio_id=$1',[f.id]);assert.equal(rows.rows.length,1);
    await assert.rejects(f.service.funding(f.id,address(),f.source),denied('FORBIDDEN'));
    assert.equal(await strategyMinimumDeposit(f.strategyId),usdtRaw('50').toString());
  }
});

test('#82 DB unknown receipt or foreign claim cannot create lot/cash; one confirmed proof is sufficient to reconcile an unknown faucet attempt',async()=>{
  const f=await fixture();
  f.rpc.state.logs=false;
  await assert.rejects(f.service.funding(f.id,f.owner,f.source),denied('FUNDING_NOT_CONFIRMED'));
  assert.equal((await query('select * from strategy_cash_balances where portfolio_id=$1',[f.id])).rows.length,0);
  f.rpc.state.logs=true;f.rpc.state.fail='eth_getTransactionReceipt';
  await assert.rejects(f.service.funding(f.id,f.owner,f.source),denied('FUNDING_RPC_UNAVAILABLE'));
  f.rpc.state.fail='';
  await assert.rejects(f.service.funding(f.id,f.owner,{source:{kind:'faucet_claim',claimId:'9223372036854775807'}}),denied('FORBIDDEN'));
  assert.equal((await f.service.funding(f.id,f.owner,f.source)).amountRaw,TEST_AMOUNT.toString());
});

test('#82 DB rollback and lost commit acknowledgement never report success or double-credit the source',async()=>{
  const f=await fixture('hold');
  const rollback:typeof withTransaction=fn=>withTransaction(async client=>{const result=await fn(client);await client.query('select 1/0');return result;});
  await assert.rejects(createPortfolioStrategyService({...f.deps,transaction:rollback}).funding(f.id,f.owner,f.source),denied('EXECUTION_STORAGE_UNAVAILABLE'));
  assert.equal((await query('select id from strategy_funding_lots where portfolio_id=$1',[f.id])).rows.length,0);
  const unknown:typeof withTransaction=async fn=>{await withTransaction(fn);throw new Error('SECRET_COMMIT_ACK');};
  await assert.rejects(createPortfolioStrategyService({...f.deps,transaction:unknown}).funding(f.id,f.owner,f.source),denied('EXECUTION_STORAGE_UNAVAILABLE'));
  assert.equal((await f.service.funding(f.id,f.owner,f.source)).replayed,true);
  assert.equal(await bucket(f.id,'unallocated_hold_raw'),(TEST_AMOUNT/2n).toString());
});

test('#82 DB reorg and moved log index freeze original lot without releasing funds or resurrecting it',async()=>{
  for(const scenario of ['canonical-block','moved-index']){
    const f=await fixture('hold');await f.service.funding(f.id,f.owner,f.source);
    if(scenario==='canonical-block')f.rpc.state.blockHash=OTHER_HASH;else f.rpc.state.logIndex++;
    await assert.rejects(f.service.funding(f.id,f.owner,f.source),denied('FUNDING_REORGED'));
    const rows=(await query<{state:string}>('select state from strategy_funding_lots where portfolio_id=$1',[f.id])).rows;
    assert.deepEqual(rows,[{state:'reorged'}]);assert.equal(await bucket(f.id,'unallocated_hold_raw'),(TEST_AMOUNT/2n).toString());
    await assert.rejects(f.service.executionState(f.id,f.owner,{enabled:true}),denied('FUNDING_REORGED'));
  }
});

test('#83 DB creator stack calendars and effective slices are isolated per contribution; holder instructions are retired',async()=>{
  const f=await fixture();
  const clock=new Date('2027-03-13T14:00:00Z');
  f.rpc.state.now=BigInt(clock.getTime()/1000);
  const service=createPortfolioStrategyService({...f.deps,now:()=>clock});
  const first=await service.funding(f.id,f.owner,f.source);
  assert.equal(first.kind,'asset');
  const rows=(await query<{asset:string;budget_raw:string;effective_slices:number;first_slot_at:Date|null}>(
    'select asset,budget_raw::text,effective_slices,first_slot_at from strategy_lot_assets where lot_id=$1 order by asset',[first.id])).rows;
  assert.equal(rows.length,2);
  const stock=rows.find(r=>r.asset===TESTNET_97.assets.AAPLB.token);assert.ok(stock);
  assert.equal(stock.budget_raw,(TEST_AMOUNT/2n).toString());assert.equal(stock.effective_slices,12);
  assert.equal(stock.first_slot_at?.toISOString(),'2027-03-14T14:00:00.000Z','one-period UTC anchor stays 14:00 across DST and equality waits until tomorrow');
  assert.equal(rows.find(r=>r.asset===TESTNET_97.contracts.usdt)?.effective_slices,0);
  await assert.rejects(service.instruct(f.id,f.owner,{expectedRevision:'0',enabled:true,startAt:future(),amountUsdt:'101'}),denied('STACK_INSTRUCTIONS_RETIRED'));
  await assert.rejects(service.instructionState(f.id,f.owner,{revision:'1',state:'paused'}),denied('STACK_INSTRUCTIONS_RETIRED'));
  assert.equal((await query('select revision from stack_instructions where portfolio_id=$1',[f.id])).rows.length,0);
  const other=await fixture('stack',5000,TEST_AMOUNT*2n);
  const second=await other.service.funding(other.id,other.owner,other.source);
  assert.notEqual(second.id,first.id);
  const otherStock=(await query<{budget_raw:string;effective_slices:number}>('select budget_raw::text,effective_slices from strategy_lot_assets where lot_id=$1 and asset=$2',[second.id,TESTNET_97.assets.AAPLB.token])).rows[0];
  assert.equal(otherStock?.budget_raw,TEST_AMOUNT.toString());assert.equal(otherStock?.effective_slices,12);
  assert.deepEqual((await getStrategy(f.strategyId)).versions[0]?.execution,f.execution,'shortening changes contribution plan only, never signed creator N');
});

test('#83 DB unknown work rejects holder revisions; fund pause works during RPC outage and preserves original attempt',async()=>{
  const f=await fixture();
  const op=(await query<{id:string}>("insert into operations(portfolio_id,type,state,idempotency_key,user_op_hash) values($1,'withdraw','submitted',$2,$3) returning id",[f.id,txHash(),f.hash])).rows[0];assert.ok(op);
  await assert.rejects(f.service.instruct(f.id,f.owner,{expectedRevision:'0',enabled:true,startAt:future()}),denied('STACK_INSTRUCTIONS_RETIRED'));
  f.rpc.state.fail='*';
  assert.deepEqual(await f.service.executionState(f.id,f.owner,{enabled:false}),{portfolioId:f.id,enabled:false});
  assert.deepEqual((await query('select state,user_op_hash from operations where id=$1',[op.id])).rows,[{state:'submitted',user_op_hash:f.hash}]);
});

test('#83 DB both hold and creator-stack can pause immediately during RPC outage without changing version mode',async()=>{
  for(const kind of ['hold','stack'] as const){
    const f=await fixture(kind);f.rpc.state.fail='*';
    assert.deepEqual(await f.service.executionState(f.id,f.owner,{enabled:false}),{portfolioId:f.id,enabled:false});
    await assert.rejects(f.service.executionState(f.id,f.owner,{enabled:true}),denied('VERSION_CHAIN_UNAVAILABLE'));
    await assert.rejects(f.service.instruct(f.id,f.owner,{expectedRevision:'0',enabled:true,startAt:future()}),denied('STACK_INSTRUCTIONS_RETIRED'));
    assert.deepEqual((await getStrategy(f.strategyId)).versions[0]?.execution,f.execution);
    f.rpc.state.fail='';
    assert.deepEqual(await f.service.executionState(f.id,f.owner,{enabled:true}),{portfolioId:f.id,enabled:true});
  }
});

test('#82 DB cash row lock timeout rolls back the whole source reservation',{timeout:15000},async()=>{
  const f=await fixture('hold');await f.service.funding(f.id,f.owner,f.source);
  const blocker=await getPool().connect();
  try{
    await blocker.query('begin');await blocker.query('select * from strategy_cash_balances where portfolio_id=$1 for update',[f.id]);
    await assert.rejects(f.service.funding(f.id,f.owner,f.source),denied('EXECUTION_STORAGE_UNAVAILABLE'));
  }finally{await blocker.query('rollback');blocker.release();}
  assert.equal(await bucket(f.id,'unallocated_hold_raw'),(TEST_AMOUNT/2n).toString());
});

test('#83 DB scheduler recognizes typed funding schedules without converting them to legacy drift intervals',async()=>{
  const f=await fixture('hold');
  await withTransaction(async client=>{
    await client.query("update portfolios set schedule_state='active',next_run_at=null where id=$1",[f.id]);
    const due=await claimDuePortfolios(100000,new Date(),{chainId:97,advance:false,withTransaction:async run=>run(client)});
    const claimed=due.find(row=>row.portfolioId===f.id);assert.ok(claimed);assert.equal(claimed.unsupportedReason,null);
    assert.equal(claimed.executionKind,'per_asset');assert.equal(claimed.version,1);assert.equal(claimed.intervalSeconds,60);
    await client.query("update portfolios set schedule_state='paused' where id=$1",[f.id]);
  });
});

afterEach(async () => {
  // These RPC fixtures never broadcast. Do not leave unknown test hashes blocking the shared signer.
  const ids = fixtureClaimIds.splice(0);
  if (ids.length) await query("update faucet_claims set state='failed',updated_at=clock_timestamp() where id=any($1::bigint[]) and state in ('submitted','unknown')", [ids]);
});
after(async()=>{await closePool();});

test('#82 DB funding binds to receipt-time enrollment and activeAt, never a later pinned version', async () => {
  for (const scenario of ['version', 'before-active']) {
    const f = await fixture();
    f.rpc.state.latestBlockNumber = 131n;
    if (scenario === 'version') {
      await query(`insert into strategy_versions(strategy_id,version,allocation,schedule,active_at,execution_schema_version,execution,execution_chain_id,config_hash)
        select strategy_id,2,allocation,schedule,active_at,execution_schema_version,execution,execution_chain_id,config_hash from strategy_versions where strategy_id=$1 and version=1`, [f.strategyId]);
      await query('update portfolios set version=2 where id=$1', [f.id]);
      f.rpc.state.pinned = 2; f.rpc.state.version = 2; f.rpc.state.historicalPinned = 1;
    } else f.rpc.state.historicalNow--;
    await assert.rejects(f.service.funding(f.id, f.owner, f.source), denied(scenario === 'version' ? 'CHAIN_VERSION_MISMATCH' : 'VERSION_NOT_ACTIVE'));
    assert.equal((await query('select id from strategy_funding_lots where portfolio_id=$1', [f.id])).rows.length, 0);
    assert.equal((await query<{state:string}>('select state from faucet_claims where id=$1', [f.claimId])).rows[0]?.state, 'confirmed', 'known faucet outcome must not block relayer on an ineligible lot');
  }
});

test('#82 DB paused typed enrollment returns the original account and stays paused', async () => {
  const f = await fixture('hold');
  const portfolio = await enrollPortfolio(f.strategyId, f.owner, { chainId: 97,
    getAccountGasBalance: async () => 0n, getGasPriceWei: async () => 1n, minSessionGasWei: 1n });
  assert.equal(portfolio.id, f.id); assert.equal(portfolio.scheduleState, 'paused');
  assert.equal(portfolio.smartAccounts[0]?.address, f.account);
  assert.equal((await query('select id from portfolios where strategy_id=$1 and user_id=$2', [f.strategyId, f.owner])).rows.length, 1);
});

test('portfolio 37: the withdraw sheet leaves out the USDT an open "sell all" still needs for its repayment, and offers everything again once it is over', async () => {
  const f = await fixture('hold');
  // Default wiring, no "sell all" open: one query, nothing held — the whole balance is withdrawable, as before.
  const free = await f.service.read(f.id, f.owner);
  assert.deepEqual([free.cash.withdrawableRaw, free.cash.reservedRaw], [TEST_AMOUNT.toString(), '0']);
  const E = 10n ** 18n, asked: unknown[] = [];
  const withHold = (hold: () => Promise<bigint>) => createPortfolioStrategyService({ ...f.deps, sellAllHold: async (input) => { asked.push(input); return hold(); } });
  // An open "sell all" that still owes a sliver beyond its strategy box: 1 USDT stays, the rest is offered.
  const held = await withHold(async () => E).read(f.id, f.owner);
  assert.deepEqual([held.cash.withdrawableRaw, held.cash.reservedRaw], [(TEST_AMOUNT - E).toString(), E.toString()]);
  assert.deepEqual(asked, [{ chainId: 97, portfolioId: f.id, account: f.account }]);
  // The hold is more than the account has: nothing is offered (and "reserved" never exceeds the balance).
  const all = await withHold(async () => TEST_AMOUNT + E).read(f.id, f.owner);
  assert.deepEqual([all.cash.withdrawableRaw, all.cash.reservedRaw], ['0', TEST_AMOUNT.toString()]);
  // The chain cannot say whether something is still owed: nothing is offered until it reads again (never a guess).
  const blind = await withHold(async () => { throw new Error('rpc down'); }).read(f.id, f.owner);
  assert.deepEqual([blind.cash.withdrawableRaw, blind.cash.reservedRaw], ['0', TEST_AMOUNT.toString()]);
  // Sold and repaid: the hold is 0 and everything is withdrawable.
  const done = await withHold(async () => 0n).read(f.id, f.owner);
  assert.deepEqual([done.cash.withdrawableRaw, done.cash.reservedRaw], [TEST_AMOUNT.toString(), '0']);
});

test('#82 DB unclassified transfers and cash deficits remain separate from product lots', async () => {
  const f = await fixture('hold');
  const before = await f.service.read(f.id, f.owner);
  assert.equal(before.cash.unclassifiedRaw, TEST_AMOUNT.toString()); assert.deepEqual(before.lots, []);
  await f.service.funding(f.id, f.owner, f.source);
  f.rpc.state.cashRaw += usdtRaw('50');
  const donated = await f.service.read(f.id, f.owner);
  assert.equal(donated.cash.unclassifiedRaw, usdtRaw('50').toString()); assert.equal(donated.lots.length, 1);
  assert.deepEqual(donated.lots[0]?.source, { kind: 'faucet_claim', claimId: f.claimId });
  f.rpc.state.cashRaw = TEST_AMOUNT - 1n;
  const deficit = await f.service.read(f.id, f.owner);
  assert.equal(deficit.cash.unclassifiedRaw, null); assert.equal(deficit.cash.deficitRaw, '1');
  f.rpc.state.fail = 'eth_call';
  await assert.rejects(f.service.read(f.id, f.owner), denied('VERSION_CHAIN_UNAVAILABLE'));
});

test('#82 DB verified unknown faucet source settles its original UTC day; failed settlement retries without double-credit', async () => {
  const f = await fixture('hold');
  await query("update faucet_claims set created_at=clock_timestamp()-interval '1 day' where id=$1", [f.claimId]);
  const service = createPortfolioStrategyService({ ...f.deps, settleClaim: async () => { throw new AppError(503, 'FAUCET_STORAGE_UNAVAILABLE', 'lost acknowledgement'); } });
  await assert.rejects(service.funding(f.id, f.owner, f.source), denied('FAUCET_STORAGE_UNAVAILABLE'));
  assert.equal(await bucket(f.id, 'unallocated_hold_raw'), '0');
  assert.equal((await f.service.funding(f.id, f.owner, f.source)).replayed, false);
  const claim = (await query<{ state: string; original_day: boolean }>("select state,utc_day=(current_timestamp at time zone 'UTC')::date-1 as original_day from faucet_claims where id=$1", [f.claimId])).rows[0];
  assert.deepEqual(claim, { state: 'confirmed', original_day: true });
  assert.equal((await query("select id from faucet_claims where id=$1 and state in ('submitted','unknown') and tx_hash is not null", [f.claimId])).rows.length, 0, 'this source no longer blocks the shared relayer');
  assert.equal(await bucket(f.id, 'unallocated_hold_raw'), (TEST_AMOUNT/2n).toString());
});

test('#82 DB typed publish admits the relayer before storing a version and safely retries a busy signer', async () => onTestnet(async()=>{
  const owner = address(); const strategy = await createStrategy({ name: 'be82-publish-admission' }, owner);
  await query('update strategies set onchain_id=$2 where id=$1', [strategy.id, strategy.id + 90_000_000]);
  const basket={assets:[{address:TESTNET_97.contracts.usdt,weightBps:10000}]};
  const input={execution:assetConfig('hold',basket,97),allocation:basket};
  let busy = true; let sends = 0;
  const deps = { isChainConfigured: () => true, validateChain: () => {}, defaultActiveAt: async () => activeAt, validatePublication: async () => {}, isCancelled: async () => false,
    relayerLock: async <T,>(_chainId: number, run: (assertHeld: () => void) => Promise<T>) => { if (busy) throw new AppError(503, 'RELAYER_BUSY', 'busy'); return run(() => {}); },
    publishOnchain: async (_id: number, version: Parameters<typeof import('../src/chain.js').publishVersionOnchain>[1]) => {
      assert.ok(version.configHash); assert.equal(version.expectedVersion, 1);
      assert.equal((await query('select version from strategy_versions where strategy_id=$1', [strategy.id])).rows.length, 1, 'commit precedes any chain publication');
      if (version.allowPublish) sends++;
      return 1;
    } };
  await assert.rejects(publishVersion(strategy.id, input, owner, deps), denied('RELAYER_BUSY'));
  assert.equal((await getStrategy(strategy.id)).versions.length, 0);
  busy = false;
  const published = await publishVersion(strategy.id, input, owner, deps);
  assert.equal(published.version, 1);
  assert.equal((await publishVersion(strategy.id, input, owner, deps)).configHash, published.configHash);
  assert.equal(sends, 1);
}));

test('#124 deterministic publication rejection/timeout leaves no immutable DB version', async () => onTestnet(async () => {
  const owner = address(); const strategy = await createStrategy({ name: 'be124-rejected-publication' }, owner);
  await query('update strategies set onchain_id=$2 where id=$1', [strategy.id, strategy.id + 90_000_000]);
  const basket = { assets: [{ address: TESTNET_97.contracts.usdt, weightBps: 10000 }] };
  for (const code of ['VERSION_CONTRACT_REJECTED', 'VERSION_PUBLICATION_UNAVAILABLE']) {
    let sends = 0;
    await assert.rejects(publishVersion(strategy.id, { allocation: basket, execution: assetConfig('hold', basket, 97) }, owner, {
      isChainConfigured: () => true, validateChain: () => {}, defaultActiveAt: async () => activeAt,
      validatePublication: async () => { throw new AppError(code === 'VERSION_CONTRACT_REJECTED' ? 409 : 503, code, 'safe rejection'); },
      relayerLock: async (_chainId, run) => run(() => {}), publishOnchain: async () => { sends++; return 1; },
    }), denied(code));
    assert.equal(sends, 0);
    assert.equal((await getStrategy(strategy.id)).versions.length, 0);
  }
}));

test('#124 zero/fractional activation times cannot publish an unresolved contract-default timestamp', async () => onTestnet(async () => {
  const basket = { assets: [{ address: TESTNET_97.contracts.usdt, weightBps: 10000 }] };
  for (const activeAt of [new Date(0), new Date(-1000), new Date(Math.floor(Date.now() / 1000) * 1000 + 1)]) {
    await assert.rejects(publishVersion(1, { allocation: basket, execution: assetConfig('hold', basket, 97), activeAt }, address()), denied('INVALID_ACTIVE_AT'));
  }
}));

test('#124 cancelled publication is append-only and can be published again after contract admission', async () => onTestnet(async () => {
  const owner = address(); const strategy = await createStrategy({ name: 'be124-cancelled-republish' }, owner);
  await query('update strategies set onchain_id=$2 where id=$1', [strategy.id, strategy.id + 90_000_000]);
  const basket = { assets: [{ address: TESTNET_97.contracts.usdt, weightBps: 10000 }] };
  let cancelled = false;
  let nextActiveAt = new Date('2026-11-17T00:01:00Z');
  const deps = { isChainConfigured: () => true, validateChain: () => {}, defaultActiveAt: async () => nextActiveAt, validatePublication: async () => {}, isCancelled: async () => cancelled,
    relayerLock: async <T,>(_chainId: number, run: (held: () => void) => Promise<T>) => run(() => {}),
    publishOnchain: async (_id: number, version: Parameters<typeof import('../src/chain.js').publishVersionOnchain>[1]) => {
      assert.ok(version.expectedVersion); return version.expectedVersion;
    } };
  const input = { allocation: basket, execution: assetConfig('hold', basket, 97), performanceFeeBps: 2000 };
  const first = await publishVersion(strategy.id, input, owner, deps);
  assert.equal(first.versionSettings?.performanceFeeBps, 2000);
  assert.equal(first.activeAt, nextActiveAt.toISOString());
  assert.equal((await publishVersion(strategy.id, input, owner, deps)).version, 1);
  cancelled = true;
  nextActiveAt = new Date(nextActiveAt.getTime() + 7 * 86400_000);
  const republished = await publishVersion(strategy.id, input, owner, deps);
  assert.equal(republished.version, 2);
  assert.equal(republished.activeAt, nextActiveAt.toISOString());
  const stored = await getStrategy(strategy.id);
  assert.equal(stored.versions.length, 2);
  assert.deepEqual(stored.versions[0]?.allocation, basket);
  assert.deepEqual(stored.versions[0]?.schedule, { kind: 'funding' });
}));

test('#143 first typed publication commits the chain-derived time and retries without choosing a new time', async () => onTestnet(async () => {
  await migrate();
  const owner = address();
  const strategy = await createStrategy({ name: 'be143-first-publication' }, owner);
  const onchainId = strategy.id + 90_000_000;
  await query('update strategies set onchain_id=$2 where id=$1', [strategy.id, onchainId]);
  const basket = { assets: [{ address: TESTNET_97.contracts.usdt, weightBps: 10000 }] };
  const input = { allocation: basket, execution: assetConfig('hold', basket, 97) };
  const blockTime = new Date('2026-11-17T00:00:00Z');
  const earliest = new Date(blockTime.getTime() + 60_000);
  let defaults = 0;
  let sends = 0;
  const deps = {
    isChainConfigured: () => true, validateChain: () => {}, isCancelled: async () => false,
    defaultActiveAt: async (id: number) => { assert.equal(id, onchainId); defaults++; return earliest; },
    validatePublication: async () => {},
    relayerLock: async <T,>(_chainId: number, run: (held: () => void) => Promise<T>) => run(() => {}),
    publishOnchain: async (_id: number, version: Parameters<typeof import('../src/chain.js').publishVersionOnchain>[1]) => {
      const stored = (await getStrategy(strategy.id)).versions[0];
      assert.equal(stored?.activeAt, version.activeAt.toISOString(), 'the exact timestamp is committed before broadcasting');
      if (version.allowPublish) sends++;
      return version.expectedVersion ?? 0;
    },
  };
  const first = await publishVersion(strategy.id, input, owner, deps);
  assert.equal(first.activeAt, earliest.toISOString());
  assert.equal(await strategyMinimumDeposit(strategy.id), usdtRaw('50').toString());
  deps.defaultActiveAt = async () => { throw new Error('a retry must not read a new activation time'); };
  assert.deepEqual(await publishVersion(strategy.id, input, owner, deps), first);
  assert.equal(defaults, 1);
  assert.equal(sends, 1);
  assert.equal((await getStrategy(strategy.id)).versions.length, 1);
}));

test('#143 typed and legacy publications preserve explicit times and resolve omitted/null defaults only after ownership', async () => onTestnet(async () => {
  await migrate();
  for (const typed of [false, true]) for (const suppliedAt of [undefined, null, activeAt.toISOString(), activeAt]) {
    const owner = address(); const strategy = await createStrategy({ name: 'be143-publication-input' }, owner);
    const onchainId = strategy.id + 90_000_000;
    await query('update strategies set onchain_id=$2 where id=$1', [strategy.id, onchainId]);
    const basket = { assets: [{ address: TESTNET_97.contracts.usdt, weightBps: 10000 }] };
    const input = { allocation: basket, ...(typed ? { execution: assetConfig('hold', basket, 97) }
      : { schedule: { kind: 'interval', intervalSeconds: 60 } }), activeAt: suppliedAt };
    const earliest = new Date('2026-11-17T00:01:00Z');
    const expectedAt = suppliedAt == null ? earliest : activeAt;
    let defaults = 0; let sends = 0;
    const deps = {
      isChainConfigured: () => true, validateChain: () => {}, isCancelled: async () => false,
      defaultActiveAt: async (id: number) => { assert.equal(id, onchainId); defaults++; return earliest; },
      validatePublication: async () => {},
      relayerLock: async <T,>(_chainId: number, run: (held: () => void) => Promise<T>) => run(() => {}),
      publishOnchain: async (_id: number, version: Parameters<typeof import('../src/chain.js').publishVersionOnchain>[1]) => {
        assert.deepEqual(version.activeAt, expectedAt); sends++; return version.expectedVersion ?? 0;
      },
    };
    await assert.rejects(publishVersion(strategy.id, input, address(), deps), denied('FORBIDDEN'));
    assert.equal(defaults, 0); assert.equal(sends, 0);
    const result = await publishVersion(strategy.id, input, owner, deps);
    assert.equal(result.activeAt, expectedAt.toISOString());
    assert.equal(defaults, suppliedAt == null ? 1 : 0); assert.equal(sends, 1);
    assert.equal((await getStrategy(strategy.id)).versions[0]?.activeAt, result.activeAt);
  }
}));

test('#143 failed activation lookup cannot persist a new typed version or broadcast', async () => onTestnet(async () => {
  await migrate();
  const owner = address(); const strategy = await createStrategy({ name: 'be143-unavailable-time' }, owner);
  await query('update strategies set onchain_id=$2 where id=$1', [strategy.id, strategy.id + 90_000_000]);
  const basket = { assets: [{ address: TESTNET_97.contracts.usdt, weightBps: 10000 }] };
  let sends = 0; let simulations = 0;
  await assert.rejects(publishVersion(strategy.id, { allocation: basket, execution: assetConfig('hold', basket, 97) }, owner, {
    isChainConfigured: () => true, validateChain: () => {},
    defaultActiveAt: async () => { throw new Error('private upstream credential'); },
    validatePublication: async () => { simulations++; },
    relayerLock: async (_chainId, run) => run(() => {}), publishOnchain: async () => { sends++; return 1; },
  }), (error: unknown) => error instanceof AppError && error.code === 'VERSION_UNAVAILABLE' && !error.message.includes('credential'));
  assert.equal((await getStrategy(strategy.id)).versions.length, 0);
  assert.equal(sends, 0); assert.equal(simulations, 0);
}));

test('#143 unknown receipt keeps the first activation time immutable and retry cannot rebroadcast', async () => onTestnet(async () => {
  await migrate();
  const owner = address(); const strategy = await createStrategy({ name: 'be143-unknown-publication' }, owner);
  await query('update strategies set onchain_id=$2 where id=$1', [strategy.id, strategy.id + 90_000_000]);
  const basket = { assets: [{ address: TESTNET_97.contracts.usdt, weightBps: 10000 }] };
  const input = { allocation: basket, execution: assetConfig('hold', basket, 97) };
  const earliest = new Date('2026-11-17T00:01:00Z');
  let sends = 0; let defaults = 0;
  const deps = {
    isChainConfigured: () => true, validateChain: () => {}, isCancelled: async () => false,
    defaultActiveAt: async () => { defaults++; return earliest; }, validatePublication: async () => {},
    relayerLock: async <T,>(_chainId: number, run: (held: () => void) => Promise<T>) => run(() => {}),
    publishOnchain: async (_id: number, version: Parameters<typeof import('../src/chain.js').publishVersionOnchain>[1]) => {
      assert.equal(version.activeAt.toISOString(), earliest.toISOString());
      if (version.allowPublish) { sends++; throw new Error('private receipt timeout'); }
      return version.expectedVersion ?? 0;
    },
  };
  await assert.rejects(publishVersion(strategy.id, input, owner, deps), (error: unknown) =>
    error instanceof AppError && error.code === 'VERSION_UNAVAILABLE' && !error.message.includes('private'));
  assert.equal((await getStrategy(strategy.id)).versions[0]?.activeAt, earliest.toISOString());
  assert.equal((await publishVersion(strategy.id, input, owner, deps)).activeAt, earliest.toISOString());
  assert.equal(defaults, 1); assert.equal(sends, 1);
  assert.equal((await getStrategy(strategy.id)).versions.length, 1);
}));

test('#143 DB timeout before commit cannot broadcast or leave an immutable first version', async () => onTestnet(async () => {
  await migrate();
  const owner = address(); const strategy = await createStrategy({ name: 'be143-db-timeout' }, owner);
  await query('update strategies set onchain_id=$2 where id=$1', [strategy.id, strategy.id + 90_000_000]);
  const basket = { assets: [{ address: TESTNET_97.contracts.usdt, weightBps: 10000 }] };
  const blocker = await getPool().connect();
  let sends = 0;
  try {
    await blocker.query('begin');
    await blocker.query('lock table strategy_versions in access exclusive mode');
    await withConnection(async (client) => {
      const previous = (await client.query<{ statement_timeout: string }>('show statement_timeout')).rows[0]; assert.ok(previous);
      await client.query("set statement_timeout='25ms'");
      try {
        await assert.rejects(publishVersion(strategy.id, { allocation: basket, execution: assetConfig('hold', basket, 97) }, owner, {
          isChainConfigured: () => true, validateChain: () => {}, defaultActiveAt: async () => activeAt,
          validatePublication: async () => {}, relayerLock: async (_chainId, run) => run(() => {}),
          publishOnchain: async () => { sends++; return 1; },
        }), denied('VERSION_UNAVAILABLE'));
      } finally { await client.query("select set_config('statement_timeout',$1,false)", [previous.statement_timeout]); }
    });
  } finally { await blocker.query('rollback'); blocker.release(); }
  assert.equal(sends, 0); assert.equal((await getStrategy(strategy.id)).versions.length, 0);
}));

test('#83 DB HTTP retains per-asset lot plan and removes personal instruction endpoints', async () => {
  const { createServer } = await import('../src/server.js');
  const f = await fixture();
  const server = createServer({ portfolioStrategies: f.service, auth: { authenticate: async () => f.owner,
    issueNonce: () => { throw new Error('unexpected'); }, login: async () => { throw new Error('unexpected'); }, logout: async () => {} } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/portfolios/${f.id}`;
    const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const funded = await post('/funding-lots', f.source); assert.equal(funded.status, 200);
    const lot: unknown = await funded.json(); assert.ok(lot && typeof lot === 'object');
    assert.deepEqual(Reflect.get(lot, 'source'), f.source.source);
    assert.equal(Reflect.get(lot,'kind'),'asset');
    assert.ok(Reflect.get(lot,'effectiveSlices'));
    const input={expectedRevision:'0',amountUsdt:'100.000000000000000001',enabled:true,startAt:future(),periodSeconds:86400};
    assert.equal((await post('/stack-instructions',input)).status,404);
    assert.equal((await post('/stack-instruction-state',{revision:'1',state:'stopped'})).status,404);
    const read=await fetch(base+'/execution');assert.equal(read.status,200);
    const saved:unknown=await read.json();assert.ok(saved&&typeof saved==='object');
    assert.deepEqual(Reflect.get(saved,'execution'),f.execution);
    const lots:unknown=Reflect.get(saved,'lots');assert.ok(Array.isArray(lots));assert.equal(lots.length,1);
    assert.deepEqual(lots[0]?.effectiveSlices,Reflect.get(lot,'effectiveSlices'));
    assert.ok(Array.isArray(Reflect.get(saved,'lotAssets')));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('#83 DB 50 inclusive contribution shrinks creator N12 to five, 100 to ten, and one raw below minimum rolls back',async()=>{
  for(const [amount,slices] of [[usdtRaw('50'),5],[usdtRaw('100'),10],[usdtRaw('50')-1n,0]] as const){
    const f=await fixture('stack',0,amount);
    if(slices===0){
      await assert.rejects(f.service.funding(f.id,f.owner,f.source),(error:unknown)=>error instanceof AppError&&error.status===400);
      assert.equal((await query('select id from strategy_funding_lots where portfolio_id=$1',[f.id])).rows.length,0);
      assert.equal(await bucket(f.id,'stack_prefund_raw'),'0');
    }else{
      const lot=await f.service.funding(f.id,f.owner,f.source);
      assert.equal(lot.kind,'asset');
      const plan=(await query<{effective_slices:number;budget_raw:string}>('select effective_slices,budget_raw::text from strategy_lot_assets where lot_id=$1 and asset=$2',[lot.id,TESTNET_97.assets.AAPLB.token])).rows[0];
      assert.deepEqual(plan,{effective_slices:slices,budget_raw:amount.toString()});
      assert.equal(await bucket(f.id,'stack_prefund_raw'),amount.toString());
      assert.equal((await f.service.funding(f.id,f.owner,f.source)).id,lot.id);
    }
  }
});

test('#83 DB yield publication requires the exact enabled chain/asset/market and preserves retired signed selections',async()=>onTestnet(async()=>{
  const owner=address();const strategy=await createStrategy({name:'be83-yield-allowlist'},owner);
  const basket={assets:[{address:TESTNET_97.contracts.usdt,weightBps:10000}]};
  const execution=assetConfig('hold',basket,97);
  const market=`fixture_${randomBytes(8).toString('hex')}`;
  const selected={...execution,assets:execution.assets.map(a=>({...a,yield:{market}}))};
  const input={allocation:basket,execution:selected};
  await assert.rejects(publishVersion(strategy.id,input,owner),denied('YIELD_UNAVAILABLE'));
  await query('insert into strategy_asset_yield_markets(chain_id,asset,market_id,enabled) values(97,$1,$2,false)',[basket.assets[0]?.address,market]);
  await assert.rejects(publishVersion(strategy.id,input,owner),denied('YIELD_UNAVAILABLE'));
  await query('update strategy_asset_yield_markets set enabled=true where chain_id=97 and asset=$1 and market_id=$2',[basket.assets[0]?.address,market]);
  await assert.rejects(publishVersion(strategy.id,input,owner),denied('YIELD_UNAVAILABLE'),'0032 alone cannot admit a market');
  const receipt=address();
  await query(`insert into yield_markets(chain_id,market_id,platform_market_id,protocol,underlying,receipt,target,risk_source,underlying_decimals,receipt_decimals,is_simulated,simulated_apr_bps,state) values(97,$1,$2,'venus',$3,$4,$4,$5,18,8,true,500,'active')`,[txHash(),market,basket.assets[0]?.address,receipt,address()]);
  const published=await publishVersion(strategy.id,input,owner);assert.equal(published.executionSchemaVersion,2);assert.deepEqual(published.execution,selected);
  await query('update strategy_asset_yield_markets set enabled=false,updated_at=clock_timestamp() where chain_id=97 and asset=$1 and market_id=$2',[basket.assets[0]?.address,market]);
  assert.deepEqual((await getStrategy(strategy.id)).versions[0]?.execution,selected);
  await assert.rejects(publishVersion(strategy.id,{...input,activeAt:'2026-11-16T00:00:00Z'},owner),denied('YIELD_UNAVAILABLE'));
  assert.equal((await getStrategy(strategy.id)).versions.length,1);
}));

test('#83 DB two 50 contributions retain distinct sources and merge budgets at each creator timestamp',async()=>{
  const cash=TESTNET_97.contracts.usdt,a=TESTNET_97.assets.AAPLB.token,b=TESTNET_97.assets.AMZNB.token;
  const assets:AssetSetting[]=[
    {asset:a,weightBps:5000,execution:{kind:'stack',every:'daily',weekday:null,timeUtc:'09:00',slices:12},yield:null},
    {asset:b,weightBps:5000,execution:{kind:'stack',every:'daily',weekday:null,timeUtc:'10:00',slices:12},yield:null},
    {asset:cash,weightBps:0,yield:null}];
  const execution:AssetExecution={kind:'per_asset',numeraire:cash,rebalance:'none',assets:assets.sort((left,right)=>left.asset.localeCompare(right.asset))};
  const f=await fixture('stack',0,usdtRaw('50'),execution);
  const clock=new Date('2026-11-16T08:00:00Z');
  f.rpc.state.now=BigInt(clock.getTime()/1000);
  const service=createPortfolioStrategyService({...f.deps,now:()=>clock});
  const first=await service.funding(f.id,f.owner,f.source);
  assert.equal(first.fundingStatus,'scheduled','25 at each timestamp can fund two ten-USDT installments');
  assert.deepEqual(first.effectiveSlices,{[a]:2,[b]:2});
  assert.equal((await query('select id from strategy_jobs where portfolio_id=$1',[f.id])).rows.length,0,'funding never broadcasts or reserves a premature subminimum batch');
  const secondSource=await f.secondClaim();
  const second=await service.funding(f.id,f.owner,secondSource);
  assert.notEqual(second.id,first.id);assert.deepEqual(second.effectiveSlices,first.effectiveSlices);
  assert.equal(await bucket(f.id,'stack_prefund_raw'),usdtRaw('100').toString());
  const merged=(await query<{at:string;budget:string;count:number}>(`select to_char(a.first_slot_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') as at,
      sum(a.budget_raw)::text as budget,count(*)::int as count from strategy_lot_assets a join strategy_funding_lots l on l.id=a.lot_id
      where l.portfolio_id=$1 and a.effective_slices>0 group by a.first_slot_at order by a.first_slot_at`,[f.id])).rows;
  assert.deepEqual(merged,[{at:'2026-11-16T09:00:00Z',budget:usdtRaw('50').toString(),count:2},{at:'2026-11-16T10:00:00Z',budget:usdtRaw('50').toString(),count:2}]);
  const replay=await service.funding(f.id,f.owner,secondSource);assert.equal(replay.id,second.id);assert.equal(replay.replayed,true);
  assert.equal(await bucket(f.id,'stack_prefund_raw'),usdtRaw('100').toString());
});

test('#83 DB per-asset read suggests the new inclusive minimum without resurrecting legacy five-dollar legs',async()=>{
  const cash=TESTNET_97.contracts.usdt;
  const assets:AssetSetting[]=[
    {asset:TESTNET_97.assets.AAPLB.token,weightBps:9900,execution:{kind:'hold'},yield:null},
    {asset:TESTNET_97.assets.AMZNB.token,weightBps:100,execution:{kind:'hold'},yield:null},
    {asset:cash,weightBps:0,yield:null}];
  const execution:AssetExecution={kind:'per_asset',numeraire:cash,rebalance:'none',assets:assets.sort((a,b)=>a.asset.localeCompare(b.asset))};
  const f=await fixture('hold',0,TEST_AMOUNT,execution);
  assert.equal((await f.service.read(f.id,f.owner)).defaultAmountUsdt,'50');
  assert.equal(await strategyMinimumDeposit(f.strategyId),usdtRaw('50').toString());
});

test('#83 DB pure cash funding completes allocation without fee policy reads or empty execution jobs',async()=>{
  const cash=TESTNET_97.contracts.usdt;
  const execution:AssetExecution={kind:'per_asset',numeraire:cash,rebalance:'none',assets:[{asset:cash,weightBps:10000,yield:null}]};
  const f=await fixture('hold',10000,TEST_AMOUNT,execution);
  const service=createPortfolioStrategyService({...f.deps,feeReserve:async()=>{throw new Error('a pure cash contribution must not query swap fee policy');}});
  const lot=await service.funding(f.id,f.owner,f.source);
  assert.equal(lot.kind,'asset');assert.deepEqual(lot.effectiveSlices,{});
  const read=await service.read(f.id,f.owner);
  assert.equal(read.balances?.allocated_cash_raw,TEST_AMOUNT.toString());
  assert.equal(read.balances?.unallocated_hold_raw,'0');assert.equal(read.balances?.stack_prefund_raw,'0');
  assert.equal(read.jobs.length,0);
  assert.equal((await query('select id from operations where portfolio_id=$1',[f.id])).rows.length,0);
  const plans=(await query<{state:string;effective_slices:number}>('select state,effective_slices from strategy_lot_assets where lot_id=$1',[lot.id])).rows;
  assert.deepEqual(plans,[{state:'completed',effective_slices:0}]);
});


test('#96 canonical receipt time controls the first creator slot despite delayed API processing',async()=>{
  const f=await fixture();f.rpc.state.now=BigInt(new Date('2026-11-15T00:00:00Z').getTime()/1000);
  const late=createPortfolioStrategyService({...f.deps,now:()=>new Date('2026-11-15T14:01:00Z')});
  const lot=await late.funding(f.id,f.owner,f.source);
  assert.equal(lot.confirmedAt,'2026-11-15T00:00:00.000Z');
  const rows=(await query<{first_slot_at:Date}>('select first_slot_at from strategy_lot_assets where lot_id=$1 and asset<>$2',[lot.id,TESTNET_97.contracts.usdt])).rows;
  assert.equal(rows[0]?.first_slot_at.toISOString(),'2026-11-15T14:00:00.000Z');
});

test('#96 99 percent cash admits a valid contribution and waits for same-slot accumulation',async()=>{
  const f=await fixture('hold',9900);
  const lot=await f.service.funding(f.id,f.owner,f.source);
  assert.equal(lot.amountRaw,TEST_AMOUNT.toString());assert.equal(await bucket(f.id,'unallocated_hold_raw'),(TEST_AMOUNT/100n).toString());
});
