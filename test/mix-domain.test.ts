import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MIX_ASSETS, mixAssets, mixChainAllocation, mixDate, mixExit, mixPerformance, mixRebalance, mixSettings, nextMixRebalance } from '../src/mix-domain.js';
import lineup from './fixtures/launch-lineup.json' with { type: 'json' };
import { TESTNET_97 as T } from '../src/testnet-profile.js';

const nvda = T.assets.NVDAB.token, tsla = T.assets.TSLAB.token;
const assets = [{ assetId: nvda, weightBps: 6000 }, { assetId: tsla, weightBps: 4000 }];
const now = new Date('2026-11-21T23:30:00Z');
test('mix defaults are complete and its catalogue contains exactly the admitted forty assets', () => {
  const settings = mixSettings({ assets }, now);
  assert.equal(settings.name, 'NVDAB + TSLAB');
  assert.deepEqual(settings.rebalance, { frequency: 'monthly', startDate: '2026-11-21' });
  assert.deepEqual(settings.exit, { takeProfitBps: null, stopLossBps: null });
  assert.equal(MIX_ASSETS.length, 40);
  assert.deepEqual(MIX_ASSETS.map(asset => asset.symbol).sort(), [...new Set(lineup.funds.flatMap(fund => fund.components.map(asset => asset.asset_id)))].sort());
  assert.deepEqual(mixAssets([{ assetId: nvda.toUpperCase(), weightBps: 10000 }]), [{ assetId: nvda, weightBps: 10000 }]);
});
test('mix validates asset count, distinct identities and exact positive basis-point sum', () => {
  assert.equal(mixAssets([{ assetId: nvda, weightBps: 10000 }]).length, 1);
  const ten = MIX_ASSETS.slice(0, 10).map(asset => ({ assetId: asset.address, weightBps: 1000 }));
  assert.equal(mixAssets(ten).length, 10);
  for (const value of [null, [], [...ten, ten[0]], [{ assetId: nvda, weightBps: 0 }], [{ assetId: nvda, weightBps: 10001 }],
    [{ assetId: nvda, weightBps: 9999 }], [{ assetId: nvda, weightBps: 10000.1 }],
    [{ assetId: nvda, weightBps: 5000 }, { assetId: nvda, weightBps: 5000 }], [{ assetId: T.contracts.usdt, weightBps: 10000 }],
    [{ assetId: T.assets.AVAX.token, weightBps: 10000 }], [{ assetId: 'NVDAB', weightBps: 10000 }], [{ assetId: nvda, weightBps: 10000, yield: true }]]) {
    assert.throws(() => mixAssets(value));
  }
});
test('mix name, attribution and setting boundaries reject malformed or unsupported input', () => {
  assert.equal(mixSettings({ assets, name: '  My tech  ', importCode: 'a'.repeat(22) }, now).name, 'My tech');
  assert.equal(mixSettings({ assets, name: '字'.repeat(100) }, now).name.length, 100);
  for (const name of ['', '  ', 'x'.repeat(101), 123]) assert.throws(() => mixSettings({ assets, name }, now));
  for (const importCode of ['', 'a'.repeat(21), 'a'.repeat(129), 'a/b'.repeat(10)]) assert.throws(() => mixSettings({ assets, importCode }, now));
  for (const value of [null, { assets, yield: true }, { assets, rebalance: { frequency: 'yearly' } }, { assets, exit: { stopLossBps: -2000 } }]) {
    assert.throws(() => mixSettings(value, now));
  }
  assert.throws(() => mixSettings({ assets, owner: T.roles.keeper }, now), /不支援的欄位/);
});
test('mix dates reject normalization, local timestamps, unknown frequency and invalid clocks', () => {
  for (const value of ['2026-02-29', '2026-02-30', '2026-13-01', '0000-01-01', '2026-01-01T00:00:00Z', 0, null]) assert.throws(() => mixDate(value));
  assert.equal(mixDate('2028-02-29').toISOString(), '2028-02-29T00:00:00.000Z');
  assert.throws(() => mixRebalance({}, new Date(NaN)));
  assert.throws(() => mixRebalance({ frequency: 'yearly' }, now));
  assert.throws(() => nextMixRebalance({ frequency: 'monthly', startDate: '2026-01-01' }, new Date(NaN)));
});
test('mix daily and weekly schedules retain due work until an actual successful execution', () => {
  for (const [frequency, expected] of [['daily', '2026-11-22'], ['weekly', '2026-11-28']] as const) {
    const settings = { frequency, startDate: '2026-11-21' };
    assert.equal(nextMixRebalance(settings, null).toISOString().slice(0, 10), settings.startDate);
    assert.equal(nextMixRebalance(settings, now).toISOString().slice(0, 10), expected);
    assert.equal(nextMixRebalance(settings, new Date('2026-11-21T00:00:00Z')).toISOString().slice(0, 10), expected);
    assert.equal(nextMixRebalance(settings, new Date('2026-11-20T23:59:59Z')).toISOString().slice(0, 10), settings.startDate);
  }
});
test('mix monthly and quarterly dates preserve original month-end and leap-day anchors', () => {
  const monthly = { frequency: 'monthly' as const, startDate: '2026-01-31' };
  assert.equal(nextMixRebalance(monthly, new Date('2026-01-31T00:00:00Z')).toISOString().slice(0, 10), '2026-02-28');
  assert.equal(nextMixRebalance(monthly, new Date('2026-02-28T00:00:00Z')).toISOString().slice(0, 10), '2026-03-31');
  assert.equal(nextMixRebalance(monthly, new Date('2026-06-01T00:00:00Z')).toISOString().slice(0, 10), '2026-06-30');
  assert.equal(nextMixRebalance({ frequency: 'quarterly', startDate: '2026-11-30' }, new Date('2026-11-30T00:00:00Z')).toISOString().slice(0, 10), '2027-02-28');
  assert.equal(nextMixRebalance({ frequency: 'quarterly', startDate: '2028-02-29' }, new Date('2028-02-29T00:00:00Z')).toISOString().slice(0, 10), '2028-05-29');
});
test('mix profit/loss uses net external inputs and is neutral to a deposit or withdrawal at cost', () => {
  const disabled = mixExit();
  for (const [value, deposit, withdrawal] of [[100n, 100n, 0n], [200n, 200n, 0n], [80n, 100n, 20n]] as const) {
    assert.equal(mixPerformance(value, deposit, withdrawal, disabled).returnBps, '0');
  }
  assert.equal(mixPerformance(130n, 100n, 0n, disabled).returnBps, '3000');
  const added = mixPerformance(230n, 200n, 0n, mixExit({ takeProfitBps: 3000 }));
  assert.equal(added.profitRaw, 30n, 'additional principal is not profit');
  assert.equal(added.returnBps, '1500', 'C3: recompute the percentage against the new principal');
  assert.equal(added.trigger, null, 'additional principal must not falsely trigger profit taking');
  for (const [deposit, withdrawal] of [[0n, 0n], [100n, 100n], [100n, 120n]] as const) {
    const result = mixPerformance(0n, deposit, withdrawal, mixExit({ takeProfitBps: 1, stopLossBps: 1 }));
    assert.equal(result.returnBps, null); assert.equal(result.trigger, null);
    assert.equal(result.message, '淨投入為零或負數，暫時無法計算報酬率，停利停損暫不觸發。');
  }
});
test('mix exact threshold comparison includes equality, excludes a one-unit shortfall, and supports either side alone', () => {
  const stop = mixExit({ stopLossBps: 2000 }), profit = mixExit({ takeProfitBps: 3000 });
  assert.equal(mixPerformance(800000n, 1000000n, 0n, stop).trigger, 'stop_loss');
  assert.equal(mixPerformance(800001n, 1000000n, 0n, stop).trigger, null);
  assert.equal(mixPerformance(1300000n, 1000000n, 0n, profit).trigger, 'take_profit');
  assert.equal(mixPerformance(1299999n, 1000000n, 0n, profit).trigger, null);
  assert.equal(mixPerformance(0n, 100n, 0n, mixExit({ stopLossBps: 10000 })).trigger, 'stop_loss');
  assert.equal(mixPerformance(300n, 100n, 0n, mixExit({ takeProfitBps: 20000 })).trigger, 'take_profit');
  assert.equal(mixPerformance(0n, 100n, 0n, profit).trigger, null);
  assert.equal(mixPerformance(200n, 100n, 0n, stop).trigger, null);
});
test('mix threshold and money bounds fail closed without rounding or unsafe number conversion', () => {
  for (const stopLossBps of [0, -1, 10001, 0.5, NaN, Infinity, '2000']) assert.throws(() => mixExit({ stopLossBps }));
  for (const takeProfitBps of [0, -1, 2147483648, 0.5, NaN]) assert.throws(() => mixExit({ takeProfitBps }));
  const huge = 10n ** 70n;
  assert.equal(mixPerformance(huge * 130n, huge * 100n, 0n, mixExit({ takeProfitBps: 3000 })).trigger, 'take_profit');
  for (const [value, deposits, withdrawals] of [[-1n, 0n, 0n], [0n, -1n, 0n], [0n, 0n, -1n]] as const) assert.throws(() => mixPerformance(value, deposits, withdrawals, mixExit()));
});
test('mix exit weights take one bp from the largest selection while public settings remain unchanged', () => {
  const removed = T.assets.WBNB.token;
  const original = structuredClone(assets);
  const result = mixChainAllocation(assets, [{ assetId: removed, balanceRaw: 50n }], 128);
  assert.deepEqual(result.assets, [{ address: nvda, weightBps: 5999 }, { address: tsla, weightBps: 4000 }, { address: removed, weightBps: 1 }, { address: T.contracts.usdt, weightBps: 0 }]);
  assert.deepEqual(result.sellOnlyAssets, [removed]);
  assert.deepEqual(assets, original);
  assert.equal(result.assets.reduce((sum, asset) => sum + asset.weightBps, 0), 10000);
});
test('mix retains every positive removed balance even below one raw of oracle value; zero and chain limit remain strict', () => {
  const removed = T.assets.WBNB.token;
  const holdings = [{ assetId: removed, balanceRaw: 5n }, { assetId: removed, balanceRaw: 5n }, { assetId: nvda, balanceRaw: 100n }];
  assert.equal(mixChainAllocation(assets, holdings, 4).assets.length, 4);
  assert.deepEqual(mixChainAllocation(assets, [{ assetId: removed, balanceRaw: 0n }], 128).sellOnlyAssets, []);
  for (const balanceRaw of [1n, 4n]) assert.deepEqual(mixChainAllocation(assets, [{ assetId: removed, balanceRaw }], 128).sellOnlyAssets, [removed]);
  assert.throws(() => mixChainAllocation(assets, holdings, 2));
  assert.throws(() => mixChainAllocation(assets, [{ assetId: removed, balanceRaw: -1n }], 128));
  assert.throws(() => mixChainAllocation(assets, [], 0));
});
test('mix largest-weight ties are deterministic across input order and match the SQL settings guard', () => {
  const equal = [{ assetId: nvda, weightBps: 5000 }, { assetId: tsla, weightBps: 5000 }];
  const removed = [{ assetId: T.assets.WBNB.token, balanceRaw: 10n }];
  const first = mixChainAllocation(equal, removed, 128), second = mixChainAllocation([...equal].reverse(), removed, 128);
  const sorted = (value: typeof first) => value.assets.map(asset => [asset.address, asset.weightBps]).sort();
  assert.deepEqual(sorted(first), sorted(second));
  assert.equal(first.assets.find(asset => asset.address === [nvda, tsla].sort()[0])?.weightBps, 4999);
  assert.throws(() => mixChainAllocation(equal, [{ assetId: T.contracts.usdt, balanceRaw: 10n }], 128));
});
