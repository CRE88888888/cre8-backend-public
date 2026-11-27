import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {assetsMarketOpen,marketHoursBypassed,parseMarketHoursBypass,stockMarketOpen,testnetAssetKind,TESTNET_CRYPTO_WITHOUT_FEED} from '../src/trading-calendar.js';
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

test('market-hours bypass: a listed test wallet trades stocks while the session is closed on chain 97; nobody else, and never on chain 56',()=>{
  const canary='0xD3Ab39B62E221bF9E8bA19fE19b2638767d3D6D9', other='0x00000000000000000000000000000000000000a1';
  const closed=new Date('2026-11-26T16:00:00Z'), open=new Date('2026-11-23T15:00:00Z'), stock=T.assets.NVDAB.token;
  assert.equal(stockMarketOpen(closed),false,'Thanksgiving');
  // The committed list: the e2e harness wallet and the team's app wallet, chain 97.
  const text=readFileSync(new URL('../deploy/market-hours-bypass.json',import.meta.url),'utf8');
  assert.deepEqual(JSON.parse(text).chainId,97);
  assert.deepEqual([...parseMarketHoursBypass(text)],[canary.toLowerCase(),'0xeea7f54deda94d1bcdf448a03c4f6c1f19fed94f']);
  // Listed owner (any letter case): open. Everyone else, and a caller without an owner: the calendar, unchanged.
  for(const owner of [canary,canary.toLowerCase(),canary.toUpperCase().replace('0X','0x')]){
    assert.equal(assetsMarketOpen(97,[stock],closed,owner),true,owner);
    assert.equal(assetsMarketOpen(97,[T.assets.Cake.token,stock],closed,owner),true,owner);
  }
  for(const owner of [other,null,undefined,'','0x','not an address']){
    assert.equal(assetsMarketOpen(97,[stock],closed,owner),false,String(owner));
    assert.equal(assetsMarketOpen(97,[stock],open,owner),true,String(owner));
    assert.equal(marketHoursBypassed(97,owner),false,String(owner));
  }
  assert.equal(assetsMarketOpen(97,[stock],closed),false);
  // Chain 97 only, whatever the list says: a list that names the owner never bypasses on chain 56 (or any other chain) ...
  const listed=new Set([canary.toLowerCase()]);
  assert.equal(marketHoursBypassed(97,canary,listed),true);
  for(const chainId of [56,1,0,970,NaN])assert.equal(marketHoursBypassed(chainId,canary,listed),false,String(chainId));
  assert.equal(marketHoursBypassed(56,canary),false);
  // ... and a file written for another chain (or a broken one) names nobody at all.
  const file=(chainId:unknown,owners:unknown)=>parseMarketHoursBypass(JSON.stringify({chainId,owners}));
  assert.equal(file(97,[canary]).size,1);
  for(const chainId of [56,'97',null,undefined,[97]])assert.equal(file(chainId,[canary]).size,0,String(chainId));
  assert.equal(file(97,[canary,'0x1234']).size,0,'one malformed entry voids the list');
  assert.equal(file(97,canary).size,0); assert.equal(file(97,undefined).size,0);
  for(const text of [null,'','{broken','null','[]','"x"'])assert.equal(parseMarketHoursBypass(text).size,0,String(text));
  assert.equal(marketHoursBypassed(97,canary,file(56,[canary])),false);
});
