import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assetsMarketOpen,stockMarketOpen,testnetAssetKind,TESTNET_CRYPTO_WITHOUT_FEED} from '../src/trading-calendar.js';
import {TESTNET_97 as T} from '../src/testnet-profile.js';
import {TESTNET_ASSETS} from '../src/keeper/assets.js';
test('#83 NYSE session equality, exclusive close, weekend, holidays, early close and DST',()=>{
  for(const [time,expected] of [
    ['2026-11-16T14:29:59Z',false],['2026-11-16T14:30:00Z',true],['2026-11-16T20:59:59Z',true],['2026-11-16T21:00:00Z',false],
    ['2026-11-15T16:00:00Z',false],['2026-11-26T16:00:00Z',false],['2026-11-27T17:59:59Z',true],['2026-11-27T18:00:00Z',false],
    ['2026-12-24T18:00:00Z',false],['2027-03-12T14:30:00Z',true],['2027-03-15T13:30:00Z',true],['2027-03-15T20:00:00Z',false],
    ['2027-03-26T16:00:00Z',false],['2028-07-03T17:00:00Z',false],['2028-06-19T16:00:00Z',false],['2029-01-02T16:00:00Z',false],
    ['2027-12-31T16:00:00Z',true],['2027-12-24T16:00:00Z',false],
  ] as const)assert.equal(stockMarketOpen(new Date(time)),expected,time);
  assert.throws(()=>stockMarketOpen(new Date('invalid')));
});

test('#189 crypto without a secondary feed trades around the clock; stocks/ETFs keep the NYSE session',()=>{
  const closed=new Date('2026-11-22T16:00:00Z'), open=new Date('2026-11-23T15:00:00Z');
  assert.equal(stockMarketOpen(closed),false); assert.equal(stockMarketOpen(open),true);
  for(const symbol of TESTNET_CRYPTO_WITHOUT_FEED){
    assert.equal(testnetAssetKind(symbol),'crypto',symbol);
    assert.equal(assetsMarketOpen(97,[T.assets[symbol as keyof typeof T.assets].token],closed),true,symbol);
  }
  for(const symbol of ['ETH','BTCB','DOGE','AVAX'])assert.equal(testnetAssetKind(symbol),'crypto',symbol);
  assert.equal(testnetAssetKind('XAUt'),'gold');
  assert.equal(assetsMarketOpen(97,[T.assets.XAUt.token],closed),true);
  for(const symbol of ['NVDAB','GLDon','Von','SHAZB','TQQQB']){
    assert.equal(testnetAssetKind(symbol),'stock',symbol);
    const token=T.assets[symbol as keyof typeof T.assets].token;
    assert.equal(assetsMarketOpen(97,[token],closed),false,symbol);
    assert.equal(assetsMarketOpen(97,[token],open),true,symbol);
    // One stock in a mixed batch still blocks the batch while closed.
    assert.equal(assetsMarketOpen(97,[T.assets.Cake.token,token],closed),false,symbol);
  }
  assert.equal(testnetAssetKind('UNKNOWN'),'stock');
  assert.equal(assetsMarketOpen(56,[T.assets.NVDAB.token],closed),true);
  // Exact partition of the 105 manifest assets: 25 crypto, 1 gold, 79 stocks/ETFs.
  const kinds=TESTNET_ASSETS.map(a=>testnetAssetKind(a.symbol));
  assert.deepEqual([kinds.filter(k=>k==='crypto').length,kinds.filter(k=>k==='gold').length,kinds.filter(k=>k==='stock').length],[25,1,79]);
});
