import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMixPreview, nextMixMarketOpen } from '../src/mix-preview.js';
import { MIX_ASSETS } from '../src/mix-domain.js';
import { emptyModel } from '../src/model-returns/calculation.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
import { OPS_GAS_PER_OPERATION } from '../src/funding.js';

const now = () => new Date('2026-11-21T12:00:00Z');
const stock = { assetId: T.assets.NVDAB.token, weightBps: 10000 };
test('mix preview reuses hold minimum for one and ten assets and reveals only public data', async () => {
  const preview = createMixPreview({ chainId: 97, now, gasPrice: async () => 2n, model: async () => emptyModel() });
  for (const assets of [[stock], MIX_ASSETS.slice(0, 10).map(asset => ({ assetId: asset.address, weightBps: 1000 }))]) {
    const result = await preview({ assets });
    assert.equal(result.minimumDepositRaw, (50n * 10n ** 18n).toString());
    assert.equal(result.estimatedRebalanceCost.gasWei, (2n * OPS_GAS_PER_OPERATION).toString());
    assert.equal(result.estimatedRebalanceCost.swapFeeBps, 10);
    assert.equal(result.markets.length, assets.length);
    assert.equal(result.modelReturns, null);
    for (const privateField of ['owner', 'account', 'value', 'netInputRaw']) assert.equal(Object.hasOwn(result, privateField), false);
  }
});
test('mix stock calendar handles weekends, Thanksgiving, early close, DST, exact open and unknown years', () => {
  const stock = T.assets.NVDAB.token;
  const next = (time: string) => nextMixMarketOpen(stock, new Date(time))?.toISOString() ?? null;
  assert.equal(next('2026-11-21T12:00:00Z'), '2026-11-23T14:30:00.000Z');
  assert.equal(next('2026-11-26T12:00:00Z'), '2026-11-27T14:30:00.000Z');
  assert.equal(next('2026-11-27T18:00:00Z'), '2026-11-30T14:30:00.000Z');
  assert.equal(next('2026-11-23T14:30:00Z'), '2026-11-23T14:30:00.000Z');
  assert.equal(next('2027-03-15T13:29:59Z'), '2027-03-15T13:30:00.000Z');
  assert.equal(next('2030-01-01T00:00:00Z'), null);
  assert.throws(() => nextMixMarketOpen(stock, new Date(NaN)));
});
test('mix crypto is open while stocks wait; unknown gas is null, never a free-gas claim', async () => {
  const preview = createMixPreview({ chainId: 97, now, gasPrice: async () => { throw new Error('rpc secret'); }, model: async () => emptyModel() });
  const result = await preview({ assets: [{ assetId: T.assets.WBNB.token, weightBps: 5000 }, { ...stock, weightBps: 5000 }] });
  assert.equal(result.markets[0]?.open, true);
  assert.equal(result.markets[1]?.open, false);
  assert.equal(result.markets[1]?.nextOpenAt, '2026-11-23T14:30:00.000Z');
  assert.equal(result.estimatedRebalanceCost.gasWei, null);
  assert.equal(JSON.stringify(result).includes('rpc secret'), false);
});
test('mix preview propagates price-model availability without inventing a zero return', async () => {
  const history = { ...emptyModel(), modelNav: [{ date: '2024-01-01', value: '1' }, { date: '2026-11-20', value: '1.2' }],
    modelComponents: [{ symbol: 'NVDAB', includedFrom: '2026-11-20' }] };
  const result = await createMixPreview({ chainId: 97, now, gasPrice: async () => 0n, model: async () => history })({ assets: [stock] });
  assert.deepEqual(result.modelNav, history.modelNav.slice(1));
  assert.deepEqual(result.modelComponents, history.modelComponents);
  assert.equal(result.modelReturns, null);
  assert.equal(result.estimatedRebalanceCost.gasWei, null);
});
test('mix preview validates before dependency calls and rejects a foreign chain', async () => {
  let reads = 0;
  const deps = { chainId: 97, now, gasPrice: async () => { reads++; return 1n; }, model: async () => { reads++; return emptyModel(); } };
  const preview = createMixPreview(deps);
  for (const value of [null, {}, { assets: [] }, { assets: [stock], owner: T.roles.keeper }]) await assert.rejects(preview(value));
  assert.equal(reads, 0);
  await assert.rejects(createMixPreview({ ...deps, chainId: 56 })({ assets: [stock] }), /僅開放測試網/);
  assert.equal(reads, 0);
});
test('mix preview sanitizes failed storage, bounds stuck requests, and keeps timed-out slots occupied until work ends', async () => {
  const rejected = createMixPreview({ chainId: 97, now, gasPrice: async () => 1n, model: async () => { throw new Error('db password'); } });
  await assert.rejects(rejected({ assets: [stock] }), error => error instanceof Error && error.message === '目前無法取得試算資料，請稍後重試。');
  let release = () => {};
  const pending = new Promise<ReturnType<typeof emptyModel>>(resolve => { release = () => resolve(emptyModel()); });
  const preview = createMixPreview({ chainId: 97, now, timeoutMs: 10, gasPrice: async () => 1n, model: () => pending });
  await assert.rejects(preview({ assets: [stock] }), /試算逾時/);
  await assert.rejects(preview({ assets: [stock] }), /試算逾時/);
  await assert.rejects(preview({ assets: [stock] }), /試算的人較多/);
  release();
  await pending;
  await new Promise<void>(resolve => setImmediate(resolve));
  const result = await preview({ assets: [stock] });
  assert.equal(result.minimumDepositRaw, (50n * 10n ** 18n).toString());
});
test('mix preview retains concurrency slots when storage fails but its parallel RPC is still outstanding', async () => {
  let finish = () => {};
  const rpc = new Promise<bigint>(resolve => { finish = () => resolve(1n); });
  const preview = createMixPreview({ chainId: 97, now, timeoutMs: 10, gasPrice: () => rpc, model: async () => { throw new Error('storage failure'); } });
  try {
    await assert.rejects(preview({ assets: [stock] }), /試算逾時/);
    await assert.rejects(preview({ assets: [stock] }), /試算逾時/);
    await assert.rejects(preview({ assets: [stock] }), /試算的人較多/);
  } finally { finish(); await rpc; }
});

test('#189 previews a mix of former non-lineup assets: crypto open on a weekend, ETF waits, symbols from the manifest', async () => {
  const preview = createMixPreview({ chainId: 97, now, gasPrice: async () => 2n, model: async () => emptyModel() });
  const result = await preview({ assets: [{ assetId: T.assets.Cake.token, weightBps: 3000 }, { assetId: T.assets.TONCOIN.token, weightBps: 3000 },
    { assetId: T.assets.GLDon.token, weightBps: 4000 }] });
  assert.deepEqual(result.markets.map(market => [market.symbol, market.open, market.nextOpenAt]),
    [['Cake', true, null], ['TONCOIN', true, null], ['GLDon', false, '2026-11-23T14:30:00.000Z']]);
  assert.equal(result.minimumDepositRaw, (50n * 10n ** 18n).toString());
  const crypto = await preview({ assets: [{ assetId: T.assets.SHIB.token, weightBps: 5000 }, { assetId: T.assets.PEPE.token, weightBps: 5000 }] });
  assert.equal(crypto.message, '所有成分目前都在可交易時段。');
  await assert.rejects(preview({ assets: [{ assetId: T.assets.USDC.token, weightBps: 10000 }] }), /這個資產暫時無法加入私人組合/);
});
