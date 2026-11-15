import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cashDifference, accountValue, fresh, idleCash, mustExit, raw, restoreSources, riskHeadroom, supplyDecision, UINT256_MAX, WAD, yieldProfile } from '../src/yield-domain.js';
import type { YieldPosition, YieldRisk } from '../src/yield-domain.js';
import type { Address, Hex } from 'viem';
const a: Address = `0x${'12'.repeat(20)}`, h: Hex = `0x${'34'.repeat(32)}`, now = new Date();
const market = { id: 'venus_usdt', marketId: h, protocol: 'venus' as const, asset: a, symbol: 'USDT', receipt: a, target: a, simulated: true };
const p: YieldPosition = { market, block: 1n, blockHash: h, at: now, source: 'rpc', state: 'known', reason: null, receipt: 1n, observedUnits: 1n, trackedUnits: 1n,
  claim: 2n, value: 2n, maxWithdraw: 1n, maxRedeem: 1n, rate: WAD * 2n, scale: WAD, aprBps: 500n, supplyOpen: true, exiting: false, underlyingDecimals: 18, receiptDecimals: 8 };
const r: YieldRisk = { block: 1n, blockHash: h, at: now, source: 'rpc', key: 'k', protocol: 'venus', asset: a, riskSource: a, underlyingMarketId: null,
  configuration: h, state: 'known', reason: null, supply: 10000n, liquidity: 1000n, exposure: 20n, externalReserved: 10n, headroom: 200n, utilizationBps: 8000 };
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
test('yield redemption preserves cash origin, handles partial lots and accrues only actual returned interest', () => {
  const supplies = [{ assets: 10n, shares: 3n, sources: { allocated_cash_raw: '10' } }];
  assert.deepEqual(restoreSources(supplies, [{ shares: 1n, assets: 4n }]), { allocated_cash_raw: '3', yield_raw: '1' });
  assert.deepEqual(restoreSources(supplies, [{ shares: 1n, assets: 4n }, { shares: 2n, assets: 8n }]), { allocated_cash_raw: '10', yield_raw: '2' });
  assert.throws(() => restoreSources(supplies, [{ shares: 4n, assets: 20n }]));
  assert.deepEqual(restoreSources(supplies, [{ shares: 3n, assets: 9n }]), {allocated_cash_raw:'9',yield_raw:'0'},'canonical realized loss never invents cash or negative interest');
  assert.deepEqual(restoreSources([{assets:3n,shares:3n,sources:{allocated_cash_raw:'2',yield_raw:'1'}}],[{shares:3n,assets:2n}]),{allocated_cash_raw:'1',yield_raw:'1'});
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
