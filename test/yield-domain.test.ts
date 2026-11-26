import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cashDifference, accountValue, fresh, idleCash, mustExit, raw, restoreSources, restoreScaledSources, restoreSourceHistory, riskHeadroom, supplyDecision, UINT256_MAX, WAD, yieldProfile } from '../src/yield-domain.js';
import type { YieldPosition, YieldRisk } from '../src/yield-domain.js';
import type { Address, Hex } from 'viem';
import { stackLiquidityReserve, prefundBasis, prefundWithdrawal } from '../src/yield-prefund.js';
import type { YieldStateQuery } from '../src/yield-runtime-state.js';
const a: Address = `0x${'12'.repeat(20)}`, h: Hex = `0x${'34'.repeat(32)}`, now = new Date();
const market = { id: 'venus_usdt', marketId: h, protocol: 'venus' as const, asset: a, symbol: 'USDT', receipt: a, target: a, simulated: true };
const p: YieldPosition = { market, block: 1n, blockHash: h, at: now, source: 'rpc', state: 'known', reason: null, receipt: 1n, observedUnits: 1n, trackedUnits: 1n,
  claim: 2n, value: 2n, maxWithdraw: 1n, maxRedeem: 1n, rate: WAD * 2n, scale: WAD, aprBps: 500n, supplyOpen: true, exiting: false, underlyingDecimals: 18, receiptDecimals: 8 };
const r: YieldRisk = { block: 1n, blockHash: h, at: now, source: 'rpc', key: 'k', protocol: 'venus', asset: a, riskSource: a, underlyingMarketId: null,
  configuration: h, state: 'known', reason: null, supply: 10000n, liquidity: 1000n, exposure: 20n, externalReserved: 10n, headroom: 200n, utilizationBps: 8000 };
test('#171 monthly_drift combines UTC calendar changes with a strict 500 bps threshold, including missing anchors', async () => {
  const { yieldRebalanceDue } = await import('../src/yield-rebalance.js');
  const at = new Date('2026-12-01T00:00:00Z');
  const sameMonth = new Date('2026-12-01T00:00:00Z');
  const priorMonth = new Date('2026-11-30T23:59:59.999Z');
  for (const delta of [0, 499, 500, 501, 10000, null]) {
    const driftDue = delta === null || delta > 500;
    for (const last of [sameMonth, null]) assert.equal(yieldRebalanceDue('monthly_drift', last, delta, at), driftDue);
    assert.equal(yieldRebalanceDue('monthly_drift', priorMonth, delta, at), true);
  }
  assert.equal(yieldRebalanceDue('monthly_drift', new Date('2025-12-01T00:00:00Z'), 0, at), true, 'same month in a different year');
  assert.equal(yieldRebalanceDue('monthly_drift', new Date('2026-12-31T23:59:59.999Z'), 0, new Date('2027-01-01T00:00:00Z')), true);
  assert.equal(yieldRebalanceDue('monthly_drift', new Date('2026-11-30T23:00:00Z'), 500, new Date('2026-12-01T07:59:59+08:00')), false, 'local month alone does not trigger');
});
test('#171 none/monthly/drift retain their calendar, first-run and unknown-drift behavior', async () => {
  const { yieldRebalanceDue } = await import('../src/yield-rebalance.js');
  const at = new Date('2026-12-01T00:00:00Z');
  const prior = new Date('2026-11-30T23:59:59Z');
  for (const last of [null, prior, at]) for (const delta of [0, 500, 501, 10000, null]) {
    assert.equal(yieldRebalanceDue('none', last, delta, at), false);
    assert.equal(yieldRebalanceDue('monthly', last, delta, at), last !== null && last !== at);
    assert.equal(yieldRebalanceDue('drift', last, delta, at), delta === null || delta > 500);
  }
  for (const mode of [undefined, null, '', 'annual', 'monthly+drift']) assert.equal(yieldRebalanceDue(mode, prior, 10000, at), false);
});
test('yield freshness includes 60s; future, missing and stale data fail closed', () => {
  assert.equal(fresh(new Date(+now - 60000), now), true);
  for (const at of [new Date(+now - 60001), new Date(+now + 1), new Date('invalid')]) assert.equal(fresh(at, now), false);
  for (const value of ['-1', '0.1', '01', 'NaN', UINT256_MAX + 1n, 0]) assert.throws(() => raw(value));
  assert.equal(raw(UINT256_MAX.toString()), UINT256_MAX);
});
test('yield capacity equality, over one raw, missing and 80/90 thresholds', () => {
  const used = new Map([['k', 30n]]);
  assert.equal(riskHeadroom([r], used, now), 40n);
  for (const patch of [{ utilizationBps: 8001 }, { state: 'unknown' as const }, { supply: 0n }, { liquidity: null }]) assert.equal(riskHeadroom([{ ...r, ...patch }], used, now), 0n);
  assert.equal(riskHeadroom([r], new Map(), now), 0n);
  assert.equal(mustExit(p, [{ ...r, utilizationBps: 8999 }], false, now), false);
  assert.equal(mustExit(p, [{ ...r, utilizationBps: 9000 }], false, now), true);
  assert.equal(mustExit(p, [{ ...r, utilizationBps: 0 }], true, now), true);
  assert.equal(mustExit({ ...p, state: 'unknown' }, [r], false, now), true);
});
test('yield supply requires owner consent plus selected asset; exact 50 USDT and all money gates', () => {
  const input = { idle: 50n * WAD, capacity: 50n * WAD, assetAmount: 100n * WAD, assetValue: 100n * WAD, consent: true, selected: true, cooldown: true, exiting: false, enabled: true };
  assert.equal(supplyDecision(input), 50n * WAD);
  for (const patch of [{ idle: 50n * WAD - 1n }, { idle: 0n }, { capacity: 0n }, { consent: false }, { selected: false }, { cooldown: false }, { exiting: true }, { enabled: false }]) assert.equal(supplyDecision({ ...input, ...patch }), 0n);
  assert.equal(idleCash({ allocated: 5n, earnings: 2n, observed: 100n, classified: 100n }), 7n);
  assert.equal(idleCash({ allocated: 5n, earnings: 2n, observed: 101n, classified: 100n }), 0n);
});
test('yield NAV includes illiquid claims once and keeps unknown as null', () => {
  assert.equal(accountValue(3n, [p], now), 5n);
  assert.equal(accountValue(3n, [{ ...p, maxWithdraw: 0n }], now), 5n);
  assert.equal(accountValue(3n, [{ ...p, value: null }], now), null);
  assert.equal(accountValue(null, [], now), null);
});
test('#116 idle cash lends only prefund above the next installment, retaining unknown reserve', () => {
  const cash = { allocated: 5n, earnings: 2n, prefund: 100n, reserve: 30n, observed: 107n, classified: 107n };
  assert.equal(idleCash(cash), 77n);
  assert.equal(idleCash({ ...cash, reserve: null }), 7n);
  for (const reserve of [100n, 101n, UINT256_MAX]) assert.equal(idleCash({ ...cash, reserve }), 7n);
  assert.equal(idleCash({ ...cash, reserve: 0n }), 107n);
  assert.equal(idleCash({ ...cash, prefund: 0n }), 7n);
  assert.equal(idleCash({ ...cash, observed: 108n }), 0n);
});
test('#116 reserve sums each active next budget including fee, final remainder and unreserved dust', async () => {
  const at = new Date('2026-11-17T00:00:00Z');
  const source = { budget_raw: '101', effective_slices: 3, first_slot_at: at, mode: { kind: 'stack', every: 'daily' }, next_index: 0, carry: '0' };
  let rows: unknown[] = [source], legacy: unknown[] = [];
  const db: YieldStateQuery = async sql => ({ rows: sql.includes('stack_instructions') ? legacy : rows });
  assert.equal(await stackLiquidityReserve(db, 97, 1, new Date(+at - 1)), 33n);
  assert.equal(await stackLiquidityReserve(db, 97, 1, at), 33n);
  rows = [{ ...source, next_index: 2, carry: '7' }, { ...source, mode: { kind: 'stack', every: 'weekly' } }, { mode: { kind: 'hold' } }];
  assert.equal(await stackLiquidityReserve(db, 97, 1, at), 75n);
  rows = [source];
  assert.equal(await stackLiquidityReserve(db, 97, 1, new Date(+at + 2 * 86400000)), 35n);
  assert.equal(await stackLiquidityReserve(db, 97, 1, new Date(+at + 3 * 86400000)), 0n);
  rows = [{ ...source, budget_raw: UINT256_MAX.toString(), effective_slices: 1 }];
  assert.equal(await stackLiquidityReserve(db, 97, 1, at), UINT256_MAX);
  rows.push({ ...source, effective_slices: 1 });
  assert.equal(await stackLiquidityReserve(db, 97, 1, at), null);
  for (const patch of [{ mode: null }, { first_slot_at: null }, { effective_slices: 0 }, { effective_slices: 366 }, { next_index: 4 }, { budget_raw: '0' }, { carry: '-1' }]) {
    rows = [{ ...source, ...patch }]; assert.equal(await stackLiquidityReserve(db, 97, 1, at), null);
  }
  rows = []; assert.equal(await stackLiquidityReserve(db, 97, 1, at), 0n);
  legacy = [{}]; assert.equal(await stackLiquidityReserve(db, 97, 1, at), null);
  await assert.rejects(stackLiquidityReserve(async () => { throw new Error('DB timeout'); }, 97, 1, at), /DB timeout/);
});
test('#118 daily 365 liquidity reserve covers first/middle/final raw remainder and rejects invalid calendars',async()=>{
  const at=new Date('2026-11-17T00:00:00Z'),day=86400000;
  const source={budget_raw:'36501',effective_slices:365,first_slot_at:at,mode:{kind:'stack',every:'daily'},next_index:0,carry:'7'};
  let rows:unknown[]=[source];
  const db:YieldStateQuery=async sql=>({rows:sql.includes('stack_instructions')?[]:rows});
  for(const index of [0,182,363,364,365]){
    assert.equal(await stackLiquidityReserve(db,97,1,new Date(+at+index*day)),index===365?0n:index===364?108n:107n);
  }
  for(const patch of [{effective_slices:366},{mode:{kind:'stack',every:'weekly'}},{next_index:366}]){
    rows=[{...source,...patch}];assert.equal(await stackLiquidityReserve(db,97,1,at),null);
  }
});
test('#116 outstanding prefund basis follows FIFO/scaled units, consumes realized losses and never borrows another source', () => {
  const first = { kind: 'supply' as const, assets: 10n, before: 0n, after: 5n, prefund: 0n };
  const second = { kind: 'supply' as const, assets: 20n, before: 5n, after: 15n, prefund: 20n };
  const loss = { kind: 'withdraw' as const, assets: 0n, before: 15n, after: 10n, prefund: 0n };
  assert.deepEqual(prefundBasis([first, second, loss], false), { principal: 20n, units: 10n });
  assert.deepEqual(prefundBasis([first, second, loss], true), { principal: 14n, units: 10n });
  for (const scaled of [false, true]) {
    assert.deepEqual(prefundBasis([], scaled), { principal: 0n, units: 0n });
    assert.deepEqual(prefundBasis([first, second, loss, { ...loss, before: 10n, after: 0n }], scaled), { principal: 0n, units: 0n });
    assert.throws(() => prefundBasis([{ ...first, prefund: 11n }], scaled));
    assert.throws(() => prefundBasis([first, { ...loss, before: 6n }], scaled));
    assert.throws(() => prefundBasis([first, { ...loss, before: 5n, after: 5n }], scaled));
  }
});
test('#116 shortfall redemption respects receipt rounding, liquidity, units, pause and freshness without a supply cooldown', () => {
  const position = { ...p, receipt: 100n, observedUnits: 100n, trackedUnits: 100n, maxWithdraw: 200n, maxRedeem: 100n };
  assert.equal(prefundWithdrawal(position, 20n, 100n, now), 10n);
  assert.equal(prefundWithdrawal(position, 21n, 100n, now), 11n);
  assert.equal(prefundWithdrawal(position, 0n, 100n, now), 0n);
  assert.equal(prefundWithdrawal({ ...position, maxWithdraw: 9n }, 21n, 100n, now), 4n);
  assert.equal(prefundWithdrawal({ ...position, maxRedeem: 3n }, 21n, 100n, now), 3n);
  assert.equal(prefundWithdrawal({ ...position, market: { ...market, protocol: 'aave_v3' } }, 21n, 100n, now), 21n);
  for (const patch of [{ withdrawPaused: true }, { maxWithdraw: null }, { maxRedeem: 0n }, { rate: 0n }, { scale: null }, { observedUnits: 99n }, { state: 'unknown' as const }, { at: new Date(+now - 60001) }]) {
    assert.equal(prefundWithdrawal({ ...position, ...patch }, 20n, 100n, now), 0n);
  }
});
test('yield redemption preserves cash origin, handles partial lots and accrues only actual returned interest', () => {
  const supplies = [{ assets: 10n, shares: 3n, sources: { allocated_cash_raw: '10' } }];
  assert.deepEqual(restoreSources(supplies, [{ shares: 1n, assets: 4n }]), { allocated_cash_raw: '3', yield_raw: '1' });
  assert.deepEqual(restoreSources(supplies, [{ shares: 1n, assets: 4n }, { shares: 2n, assets: 8n }]), { allocated_cash_raw: '10', yield_raw: '2' });
  assert.throws(() => restoreSources(supplies, [{ shares: 4n, assets: 20n }]));
  assert.deepEqual(restoreSources(supplies, [{ shares: 3n, assets: 9n }]), {allocated_cash_raw:'9',yield_raw:'0'},'canonical realized loss never invents cash or negative interest');
  assert.deepEqual(restoreSources([{assets:3n,shares:3n,sources:{allocated_cash_raw:'2',yield_raw:'1'}}],[{shares:3n,assets:2n}]),{allocated_cash_raw:'1',yield_raw:'1'});
});
test('#106 Aave actual raw-share growth restores principal by scaled proportion and clears the final remainder',()=>{
  const principal=100n*WAD,units=99999567448598564709n,left=49999783866992728648n;
  const rawMinted=99999999999999999999n,rawPartial=50n*WAD,rawFinal=50000000428082192684n;
  const sources={allocated_cash_raw:principal.toString()},original=structuredClone(sources);
  assert.throws(()=>restoreSources([{assets:principal,shares:rawMinted,sources}],[{shares:rawPartial,assets:rawPartial},{shares:rawFinal,assets:rawFinal}]));
  const supplied={kind:'supply' as const,assets:principal,unitsBefore:0n,unitsAfter:units,sources};
  const partial={kind:'withdraw' as const,assets:rawPartial,unitsBefore:units,unitsAfter:left};
  const restored=principal*(units-left)/units;
  assert.deepEqual(restoreScaledSources([supplied,partial]),{allocated_cash_raw:restored.toString(),yield_raw:(rawPartial-restored).toString()});
  assert.deepEqual(restoreScaledSources([supplied,partial,{kind:'withdraw',assets:rawFinal,unitsBefore:left,unitsAfter:0n}]),{allocated_cash_raw:principal.toString(),yield_raw:(rawPartial+rawFinal-principal).toString()});
  assert.deepEqual(supplied.sources,original,'replay never mutates persisted source evidence');
});
test('#106 scaled allocation handles interleaved supplies, 1-unit dust, realized loss and zero proceeds without inventing principal',()=>{
  assert.deepEqual(restoreScaledSources([]),{});
  const first={kind:'supply' as const,assets:3n,unitsBefore:0n,unitsAfter:3n,sources:{allocated_cash_raw:'2',stack_prefund_raw:'1'}};
  const partial={kind:'withdraw' as const,assets:1n,unitsBefore:3n,unitsAfter:2n};
  assert.deepEqual(restoreScaledSources([first,partial]),{yield_raw:'1'},'sub-raw basis remains until later scaled redemption');
  const more={kind:'supply' as const,assets:2n,unitsBefore:2n,unitsAfter:4n,sources:{yield_raw:'2'}};
  assert.deepEqual(restoreScaledSources([first,partial,more,{kind:'withdraw',assets:5n,unitsBefore:4n,unitsAfter:0n}]),{allocated_cash_raw:'2',stack_prefund_raw:'1',yield_raw:'3'});
  assert.deepEqual(restoreScaledSources([first,{kind:'withdraw',assets:2n,unitsBefore:3n,unitsAfter:0n}]),{allocated_cash_raw:'1',stack_prefund_raw:'1',yield_raw:'0'});
  assert.deepEqual(restoreScaledSources([first,{kind:'withdraw',assets:0n,unitsBefore:3n,unitsAfter:0n}]),{allocated_cash_raw:'0',stack_prefund_raw:'0',yield_raw:'0'});
  assert.deepEqual(restoreScaledSources([{...first,assets:UINT256_MAX,unitsAfter:UINT256_MAX,sources:{allocated_cash_raw:UINT256_MAX.toString()}},{kind:'withdraw',assets:UINT256_MAX,unitsBefore:UINT256_MAX,unitsAfter:0n}]),{allocated_cash_raw:UINT256_MAX.toString(),yield_raw:'0'});
});
test('#106 scaled accounting rejects missing/discontinuous/zero/negative/overflow evidence and mismatched source principal',()=>{
  const first={kind:'supply' as const,assets:10n,unitsBefore:0n,unitsAfter:5n,sources:{allocated_cash_raw:'10'}};
  for(const patch of [{unitsBefore:1n},{unitsAfter:0n},{unitsAfter:-1n},{unitsAfter:UINT256_MAX+1n},{assets:0n},{assets:11n}])assert.throws(()=>restoreScaledSources([{...first,...patch}]));
  for(const patch of [{unitsBefore:0n},{unitsBefore:6n},{unitsAfter:5n},{unitsAfter:6n},{unitsAfter:-1n},{assets:-1n}])assert.throws(()=>restoreScaledSources([first,{kind:'withdraw',assets:1n,unitsBefore:5n,unitsAfter:0n,...patch}]));
  assert.throws(()=>restoreScaledSources([{kind:'withdraw',assets:1n,unitsBefore:0n,unitsAfter:0n}]));
  assert.throws(()=>restoreScaledSources([first,{...first,unitsBefore:5n,unitsAfter:6n,sources:{allocated_cash_raw:'9'}}]));
  const unknownSource={...first,sources:{...first.sources,invalid:'1'}};
  assert.throws(()=>restoreScaledSources([unknownSource]));
  assert.throws(()=>restoreScaledSources([{...first,sources:{allocated_cash_raw:'-1'}}]));
});
test('yield profile remains absent until BE-4 generated manifest, rejects invented simulation flags', () => {
  assert.equal(yieldProfile({ chainId: 97, contracts: {} }), null);
  assert.throws(() => yieldProfile({ chainId: 56, contracts: {} }));
  const entry = { protocol: 'Venus', symbol: 'USDT', marketId: h, asset: a, receipt: a, target: a, rateType: 'fixed_simulated_APR' };
  assert.equal(yieldProfile({ chainId: 97, contracts: { executor: a, yieldRegistry: a }, yieldMarkets: [entry] })?.markets[0]?.id, 'venus_usdt');
  assert.throws(() => yieldProfile({ chainId: 97, contracts: { executor: a, yieldRegistry: a }, yieldMarkets: [{ ...entry, rateType: undefined }] }));
});

test('unsettled supply cash differences remain unknown before/after mining and never become new funding',()=>{
  for(const delta of [-1n,0n,1n])assert.deepEqual(cashDifference(delta,true),{unclassifiedRaw:null,deficitRaw:null,reconciliationPending:true});
  assert.deepEqual(cashDifference(0n,false),{unclassifiedRaw:'0',deficitRaw:'0',reconciliationPending:false});
  assert.deepEqual(cashDifference(-1n,false),{unclassifiedRaw:null,deficitRaw:'1',reconciliationPending:false});
  assert.deepEqual(cashDifference(1n,false),{unclassifiedRaw:'1',deficitRaw:'0',reconciliationPending:false});
});

test('#104 capped sell deficits redeem only needed nominal receipts, including zero/equality/uint256 and protocol rounding',async()=>{
  const {rebalanceWithdrawals}=await import('../src/yield-rebalance.js');
  const {yieldFixture,yieldRebalancePlan,address}=await import('./fixtures/yield.js');
  for(const protocol of ['venus','lista','aave_v3'] as const){
    const f=yieldFixture([protocol]),p=f.read.positions[0];assert.ok(p);
    Object.assign(p,{receipt:100n,observedUnits:100n,trackedUnits:100n,claim:200n,value:200n,rate:2n*WAD,scale:WAD,maxWithdraw:200n,maxRedeem:100n});
    const cash=address(),plan=yieldRebalancePlan(f,1,10n);
    const step={tokenIn:f.asset,tokenOut:cash,amountIn:30n,amountOutMin:1n,oracleFloor:1n,venue:address(),data:'0x' as const};
    assert.deepEqual(rebalanceWithdrawals(plan,f.read.positions,[step],cash,0n,f.at),[{marketId:p.market.marketId,amount:protocol==='aave_v3'?20n:10n,blocked:false}]);
    assert.deepEqual(rebalanceWithdrawals(plan,f.read.positions,[{...step,amountIn:10n}],cash,0n,f.at),[]);
    assert.deepEqual(rebalanceWithdrawals(plan,f.read.positions,[],cash,0n,f.at),[]);
    assert.equal(rebalanceWithdrawals(plan,f.read.positions,[{...step,amountIn:31n}],cash,0n,f.at)[0]?.amount,protocol==='aave_v3'?21n:11n);
    assert.equal(rebalanceWithdrawals(plan,f.read.positions,[{...step,amountIn:UINT256_MAX}],cash,0n,f.at)[0]?.amount,100n,'insufficient position redeems all its receipts');
  }
});

test('#104 market cash shortage/pause is pending; unknown, stale, reorg block and missing units cannot become zero',async()=>{
  const {rebalanceWithdrawals}=await import('../src/yield-rebalance.js');
  const {yieldFixture,yieldRebalancePlan,address}=await import('./fixtures/yield.js');
  const f=yieldFixture(['venus']),p=f.read.positions[0];assert.ok(p);
  Object.assign(p,{receipt:100n,observedUnits:100n,trackedUnits:100n,claim:100n,value:100n,maxWithdraw:20n,maxRedeem:20n});
  const plan=yieldRebalancePlan(f),cash=address(),step={tokenIn:f.asset,tokenOut:cash,amountIn:30n,amountOutMin:1n,oracleFloor:1n,venue:address(),data:'0x' as const};
  assert.equal(rebalanceWithdrawals(plan,f.read.positions,[step],cash,0n,f.at)[0]?.amount,20n);
  for(const patch of [{maxRedeem:0n},{withdrawPaused:true}])assert.equal(rebalanceWithdrawals(plan,[{...p,...patch}],[step],cash,0n,f.at)[0]?.blocked,true);
  for(const patch of [{state:'unknown' as const},{receipt:null},{trackedUnits:null},{rate:0n},{block:99n},{at:new Date(+f.at-60001)}])assert.throws(()=>rebalanceWithdrawals(plan,[{...p,...patch}],[step],cash,0n,f.at));
});

test('#104 sequential sell floors fund buys, retain the fee top-up and do not touch unrelated markets',async()=>{
  const {rebalanceWithdrawals,yieldRebalanceDue}=await import('../src/yield-rebalance.js');
  const {yieldFixture,yieldRebalancePlan,address,hash}=await import('./fixtures/yield.js');
  const f=yieldFixture(['aave_v3']),p=f.read.positions[0];assert.ok(p);
  Object.assign(p,{receipt:100n,observedUnits:100n,trackedUnits:100n,claim:100n,value:100n,maxWithdraw:100n,maxRedeem:100n});
  const other=address(),out=address(),plan=yieldRebalancePlan(f);
  f.read.positions.push({...p,market:{...p.market,asset:out,marketId:hash()}});
  plan.snapshot.holdings.push({asset:other,amountWei:50n,decimals:18,usdPriceE8:100000000n,priceSource:'numeraire'});
  const base={amountOutMin:50n,oracleFloor:50n,venue:address(),data:'0x' as const};
  const sell={...base,tokenIn:other,tokenOut:f.asset,amountIn:50n};
  const buy={...base,tokenIn:f.asset,tokenOut:out,amountIn:60n};
  assert.deepEqual(rebalanceWithdrawals(plan,f.read.positions,[sell,buy],f.asset,3n,f.at),[{marketId:p.market.marketId,amount:13n,blocked:false}]);
  const now=new Date('2026-12-01T00:00:00Z'),last=new Date('2026-11-30T23:59:59Z');
  assert.equal(yieldRebalanceDue('monthly',last,0,now),true);
  assert.equal(yieldRebalanceDue('monthly',now,9000,now),false);
  assert.equal(yieldRebalanceDue('drift',last,500,now),false);
  assert.equal(yieldRebalanceDue('drift',last,501,now),true);
  assert.equal(yieldRebalanceDue('none',last,9000,now),false);
});
test('#117 directed prefund redemption bypasses older allocated basis for fixed and scaled receipts', () => {
  const supplies=[{assets:1000000n,shares:1000000n,sources:{allocated_cash_raw:'1000000'}},
    {assets:300n,shares:300n,sources:{stack_prefund_raw:'300'}}];
  const withdrawal={shares:100n,assets:100n,prefundTarget:100n};
  assert.equal(restoreSources(supplies,[withdrawal]).stack_prefund_raw,'100');
  const events=[{kind:'supply' as const,assets:1000000n,unitsBefore:0n,unitsAfter:1000000n,sources:{allocated_cash_raw:'1000000'}},
    {kind:'supply' as const,assets:300n,unitsBefore:1000000n,unitsAfter:1000300n,sources:{stack_prefund_raw:'300'}},
    {kind:'withdraw' as const,assets:100n,unitsBefore:1000300n,unitsAfter:1000200n,prefundTarget:100n}];
  assert.equal(restoreScaledSources(events).stack_prefund_raw,'100');
});

test('#117 directed attribution caps gap and basis, preserves interest and consumes actual loss without makeup',()=>{
  const supplies=[{assets:1000000n,shares:1000000n,sources:{allocated_cash_raw:'1000000'}},{assets:300n,shares:300n,sources:{stack_prefund_raw:'300'}}];
  for(const [assets,target,prefund,allocated,interest]of [[100n,100n,100n,0n,0n],[110n,100n,100n,0n,10n],[80n,100n,80n,0n,0n],[100n,0n,0n,100n,0n],[100n,50n,50n,50n,0n],[400n,400n,300n,100n,0n]]){
    assert.ok(assets!==undefined&&target!==undefined&&prefund!==undefined&&allocated!==undefined&&interest!==undefined);
    const shares=target===400n?400n:100n;
    const credits=restoreSources(supplies,[{shares,assets,prefundTarget:target}]);
    assert.equal(BigInt(credits.stack_prefund_raw??'0'),prefund);assert.equal(BigInt(credits.allocated_cash_raw??'0'),allocated);assert.equal(BigInt(credits.yield_raw??'0'),interest);
  }
  const exits=[{shares:100n,assets:80n,prefundTarget:100n},{shares:1000200n,assets:1000200n}];
  assert.deepEqual(restoreSources(supplies,exits),{allocated_cash_raw:'1000000',stack_prefund_raw:'280',yield_raw:'0'});
  assert.throws(()=>restoreSources(supplies,[{shares:0n,assets:100n,prefundTarget:100n}]));
  assert.throws(()=>restoreSources(supplies,[{shares:100n,assets:100n,prefundTarget:-1n}]));
});

test('#117 accrued receipt growth cannot leave a nominal prefund shortfall or realize the same interest twice',()=>{
  const events=[{kind:'supply' as const,assets:1000n,unitsBefore:0n,unitsAfter:1000n,sources:{allocated_cash_raw:'1000'}},
    {kind:'supply' as const,assets:300n,unitsBefore:1000n,unitsAfter:1300n,sources:{stack_prefund_raw:'300'}},
    {kind:'withdraw' as const,assets:100n,unitsBefore:1300n,unitsAfter:1250n,prefundTarget:100n}];
  for(const scaled of [false,true]){
    const ledger=restoreSourceHistory(events,scaled);
    assert.equal(ledger.returned.stack_prefund_raw,'100');assert.equal(ledger.returned.yield_raw,'0');
    assert.equal(ledger.remaining.stack_prefund_raw,'200');assert.equal(ledger.remaining.allocated_cash_raw,'1000');
    const final=restoreSourceHistory([...events,{kind:'withdraw',assets:2500n,unitsBefore:1250n,unitsAfter:0n}],scaled);
    assert.equal(final.returned.stack_prefund_raw,'300');assert.equal(final.returned.allocated_cash_raw,'1000');assert.equal(final.returned.yield_raw,'1300');
  }
});

test('#117 repeated directed draws across a later supply conserve source basis, including total loss and uint256 boundary',()=>{
  const events=[{kind:'supply' as const,assets:1000n,unitsBefore:0n,unitsAfter:1000n,sources:{allocated_cash_raw:'1000'}},
    {kind:'supply' as const,assets:300n,unitsBefore:1000n,unitsAfter:1300n,sources:{stack_prefund_raw:'300'}},
    {kind:'withdraw' as const,assets:100n,unitsBefore:1300n,unitsAfter:1200n,prefundTarget:100n},
    {kind:'supply' as const,assets:100n,unitsBefore:1200n,unitsAfter:1300n,sources:{stack_prefund_raw:'100'}},
    {kind:'withdraw' as const,assets:100n,unitsBefore:1300n,unitsAfter:1200n,prefundTarget:100n}];
  for(const scaled of [false,true]){
    const ledger=restoreSourceHistory(events,scaled);
    assert.equal(ledger.returned.stack_prefund_raw,'200');assert.equal(ledger.remaining.stack_prefund_raw,'200');
    assert.equal(ledger.remaining.allocated_cash_raw,'1000');assert.equal(ledger.returned.yield_raw,'0');
    const final=restoreSourceHistory([...events,{kind:'withdraw',assets:1200n,unitsBefore:1200n,unitsAfter:0n}],scaled);
    assert.equal(final.returned.stack_prefund_raw,'400');assert.equal(final.returned.allocated_cash_raw,'1000');assert.equal(final.returned.yield_raw,'0');
    const supply={kind:'supply' as const,assets:UINT256_MAX,unitsBefore:0n,unitsAfter:UINT256_MAX,sources:{stack_prefund_raw:UINT256_MAX.toString()}};
    for(const assets of [0n,UINT256_MAX]){
      const cleared=restoreSourceHistory([supply,{kind:'withdraw',assets,unitsBefore:UINT256_MAX,unitsAfter:0n,prefundTarget:UINT256_MAX}],scaled);
      assert.equal(BigInt(cleared.returned.stack_prefund_raw??'0'),assets);assert.equal(cleared.remaining.stack_prefund_raw,'0');assert.equal(cleared.returned.yield_raw,'0');
    }
  }
});

test('#117 unknown period evidence uses separate conservative windows for wait facts',async()=>{
  const {recordPrefundWait}=await import('../src/yield-prefund.js');
  const facts=new Map<string,unknown>();
  const db:YieldStateQuery=async(sql,params=[])=>{
    if(sql.startsWith('select l.id::text'))return{rows:[{lot_id:'1',asset:a,first_slot_at:null,next_index:0,every:'daily'}]};
    if(sql.startsWith('insert into yield_runtime_state')){
      const name=params[0],value=params[1];
      if(typeof name!=='string'||typeof value!=='string')throw new Error('invalid public wait fact');
      if(!facts.has(name))facts.set(name,JSON.parse(value));return{rows:[]};
    }
    return{rows:[{matches:true}]};
  };
  for(const at of [now,now,new Date(+now+86400000)])await recordPrefundWait(db,97,1,null,0n,'schedule_unknown',{now:at,marketId:h});
  assert.equal(facts.size,2);
});
