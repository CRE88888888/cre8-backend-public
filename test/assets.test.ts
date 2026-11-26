import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTradableProbeCache, listPriceableAssets, TRADABLE_CACHE_TTL_MS } from '../src/assets.js';
import { testnetAssets } from '../src/testnet-profile.js';
import { runScript } from './fixtures/secret-output.js';

const ORACLE = '0x0000000000000000000000000000000000000001';
const ZERO = '0x0000000000000000000000000000000000000000';
const noDb = async () => { throw new Error('chain 97 must not read the DB'); };

test('#155 default GET /assets wiring shares cache and isolates deployment configuration', async () => {
  const result = await runScript('test/fixtures/assets-http.ts', { CHAIN_ID: '97' });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /assets HTTP cache verified/);
});

test('#155 cold asset reads overlap instead of accumulating 92 RPC round trips', async () => {
  let started = 0;
  const observed: number[] = [];
  const assets = await listPriceableAssets(noDb, {
    router: ORACLE,
    oracleOf: async () => {
      started++;
      await Promise.resolve();
      observed.push(started);
      return ORACLE;
    },
  }, 97);
  const count = testnetAssets().filter(asset => !asset.is_numeraire).length;
  assert.equal(started, count);
  assert.ok(observed.every(value => value === count), 'all reads must start before waiting for their results');
  assert.ok(assets.every(asset => asset.tradable === true));
  assert.deepEqual(assets.map(asset => asset.address), testnetAssets().map(asset => asset.address));
});

test('#155 hits cache through TTL minus one, refreshes exactly at TTL and shares concurrent requests', async () => {
  let now = 0;
  let routers = 0;
  let reads = 0;
  let registered = true;
  const cached = createTradableProbeCache(async () => {
    routers++;
    const result = registered ? ORACLE : ZERO;
    return { router: ORACLE, oracleOf: async () => { reads++; return result; } };
  }, () => now);
  const list = async () => listPriceableAssets(noDb, await cached(), 97);
  const expectedReads = testnetAssets().length - 1;
  const first = await Promise.all(Array.from({ length: 5 }, list));
  assert.equal(routers, 1);
  assert.equal(reads, expectedReads);
  assert.ok(first.every(assets => assets.every(asset => asset.tradable === true)));
  registered = false;
  now = TRADABLE_CACHE_TTL_MS - 1;
  assert.deepEqual(await list(), first[0]);
  assert.equal(routers, 1);
  assert.equal(reads, expectedReads);
  now = TRADABLE_CACHE_TTL_MS;
  const refreshed = await Promise.all(Array.from({ length: 5 }, list));
  assert.equal(routers, 2);
  assert.equal(reads, expectedReads * 2);
  for (const assets of refreshed) {
    assert.ok(assets.every(asset => asset.tradable === asset.isNumeraire));
  }
});

test('#155 a slow router load remains single-flight and TTL starts when it completes', async () => {
  let now = 0;
  let loads = 0;
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const cached = createTradableProbeCache(async () => {
    loads++;
    await gate;
    return { router: ORACLE, oracleOf: async () => ORACLE };
  }, () => now);
  const first = cached();
  await Promise.resolve();
  assert.equal(loads, 1);
  now = TRADABLE_CACHE_TTL_MS;
  const second = cached();
  assert.equal(first, second);
  release();
  const probe = await first;
  now = TRADABLE_CACHE_TTL_MS * 2 - 1;
  assert.equal(await cached(), probe);
  assert.equal(loads, 1);
  now++;
  await cached();
  assert.equal(loads, 2);
});

test('#155 duplicate addresses share a pending read regardless of casing; independent caches stay separate', async () => {
  let reads = 0;
  const load = async () => ({ router: ORACLE, oracleOf: async () => { reads++; return ZERO; } });
  const first = await createTradableProbeCache(load)();
  const second = await createTradableProbeCache(load)();
  assert.ok(first && second);
  const address = '0x00000000000000000000000000000000000000ab';
  assert.deepEqual(await Promise.all([first.oracleOf(address), first.oracleOf(address.toUpperCase())]), [ZERO, ZERO]);
  assert.equal(reads, 1);
  await second.oracleOf(address);
  assert.equal(reads, 2);
});

test('#155 failed/missing router stays unknown for this TTL, then recovers without stale success', async () => {
  for (const mode of ['rejected', 'missing'] as const) {
    let now = 0;
    let loads = 0;
    const cached = createTradableProbeCache(async () => {
      loads++;
      if (loads === 2) {
        if (mode === 'rejected') throw new Error('RPC timed out with private upstream details');
        return undefined;
      }
      return { router: ORACLE, oracleOf: async () => ORACLE };
    }, () => now);
    const list = async () => listPriceableAssets(noDb, await cached(), 97);
    assert.ok((await list()).every(asset => asset.tradable === true));
    now = TRADABLE_CACHE_TTL_MS;
    for (const assets of await Promise.all([list(), list()])) {
      assert.ok(assets.every(asset => asset.tradable === null), mode);
    }
    assert.equal(loads, 2);
    now++;
    assert.ok((await list()).every(asset => asset.tradable === null));
    assert.equal(loads, 2);
    now = TRADABLE_CACHE_TTL_MS * 2;
    assert.ok((await list()).every(asset => asset.tradable === true));
    assert.equal(loads, 3);
  }
});

test('#155 per-asset failure is null, shares pending/rejected reads, and retries after expiry', async () => {
  let now = 0;
  const calls = new Map<string, number>();
  const failed = testnetAssets().find(asset => !asset.is_numeraire);
  assert.ok(failed);
  const unregistered = testnetAssets().find(asset => !asset.is_numeraire && asset.address !== failed.address);
  assert.ok(unregistered);
  const cached = createTradableProbeCache(async () => ({
    router: ORACLE,
    oracleOf: async (address) => {
      calls.set(address, (calls.get(address) ?? 0) + 1);
      if (address === failed.address && now === 0) throw new Error('RPC timeout');
      return address === unregistered.address ? ZERO : ORACLE;
    },
  }), () => now);
  const list = async () => listPriceableAssets(noDb, await cached(), 97);
  for (const assets of await Promise.all([list(), list(), list()])) {
    assert.equal(assets.find(asset => asset.address === failed.address)?.tradable, null);
    assert.equal(assets.find(asset => asset.address === unregistered.address)?.tradable, false);
    assert.equal(assets.find(asset => asset.isNumeraire)?.tradable, true);
    assert.ok(assets.filter(asset => asset.address !== failed.address && asset.address !== unregistered.address).every(asset => asset.tradable === true));
  }
  await list();
  assert.ok([...calls.values()].every(count => count === 1));
  assert.equal(calls.has(testnetAssets()[0]?.address ?? ''), false);
  now = TRADABLE_CACHE_TTL_MS;
  assert.equal((await list()).find(asset => asset.address === failed.address)?.tradable, true);
  assert.ok([...calls.values()].every(count => count === 2));
});

test('#155 caches only chain reads: DB changes, empty/malformed rows and DB errors remain visible', async () => {
  let reads = 0;
  const cached = createTradableProbeCache(async () => ({ router: ORACLE, oracleOf: async () => { reads++; return ORACLE; } }));
  const probe = await cached();
  const row = { address: ORACLE, symbol: 'TOKEN', decimals: 18, is_numeraire: false };
  assert.equal((await listPriceableAssets(async () => ({ rows: [row] }), probe, 56))[0]?.symbol, 'TOKEN');
  assert.equal((await listPriceableAssets(async () => ({ rows: [{ ...row, symbol: 'UPDATED', decimals: 0 }] }), probe, 56))[0]?.symbol, 'UPDATED');
  assert.equal(reads, 1);
  assert.deepEqual(await listPriceableAssets(async () => ({ rows: [] }), probe, 56), []);
  assert.equal(reads, 1);
  await assert.rejects(listPriceableAssets(async () => { throw new Error('DB unavailable'); }, probe, 56), /DB unavailable/);
  await assert.rejects(listPriceableAssets(async () => ({ rows: [{ ...row, decimals: null }] }), probe, 56), /形狀不對/);
  assert.equal((await listPriceableAssets(async () => ({ rows: [row] }), undefined, 56))[0]?.tradable, null);
});
