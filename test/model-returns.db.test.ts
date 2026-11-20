import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { closePool, getPool, migrate, query } from '../src/db.js';
import { saveInfoBatch } from '../src/info/store.js';
import { MODEL_ASSETS } from '../src/model-returns/catalogue.js';
import { createModelReader } from '../src/model-returns/service.js';
import { DAY_MS, lastClosedDay } from '../src/model-returns/calculation.js';
import { createServer } from '../src/server.js';
import { MemoryRateLimitStore, RequestRateLimiter } from '../src/ratelimit.js';
import { loadRateLimitConfig } from '../src/config.js';
import type { InfoBatch } from '../src/info/types.js';

after(closePool);
const asset = MODEL_ASSETS.find(a => a.symbol === 'AAPLB'); assert.ok(asset);
const now = new Date(), asOf = lastClosedDay(now);
const batch: InfoBatch = { events: [], markets: Array.from({ length: 8 }, (_, i) => ({ series: 'close:AAPLB',
  observedOn: new Date(Date.parse(asOf) + (i - 7) * DAY_MS).toISOString().slice(0, 10), value: i === 7 ? '120.12345678' : '100.00000000',
  source: 'binance', sourceUrl: 'https://api.binance.com/api/v3/klines?symbol=AAPLBUSDT&interval=1d' })) };

test('#173 actual market_snapshots SQL upserts idempotently, preserves decimals and rolls back failed batches', async () => {
  await migrate();
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const save = (value: InfoBatch) => saveInfoBatch(value, action => action(client));
    assert.equal((await save(batch)).markets, 8);
    assert.deepEqual(await save(batch), { events: 0, markets: 0 });
    const result = (await client.query<{ value: string }>('select value::text from market_snapshots where series=$1 and observed_on=$2', ['close:AAPLB', asOf])).rows[0];
    assert.equal(result?.value, '120.12345678');
    const last = batch.markets.at(-1); assert.ok(last);
    assert.equal((await save({ events: [], markets: [{ ...last, value: '121.00000000' }] })).markets, 1);
    const read = createModelReader({ now: () => now, chainId: 56, query: (sql, params) => client.query(sql, [...(params ?? [])]) });
    const strategy = { id: 173, onchainId: null, versions: [{ version: 1, activeAt: '2020-01-01T00:00:00Z', allocation: { assets: [{ address: asset.address, weightBps: 10000 }] } }] };
    assert.equal((await read([strategy])).get(173)?.modelReturns?.d7, '21.00000000');
    await client.query('rollback');
    await client.query("set statement_timeout='5ms'");
    const timedOut = createModelReader({ now: () => now, chainId: 56, query: async () => client.query('select pg_sleep(1)') });
    assert.equal((await timedOut([strategy])).get(173)?.modelReturns, null);
  } finally { await client.query('rollback'); await client.query('reset statement_timeout'); client.release(); }
  const marker: `close:${string}` = `close:rollback-${randomUUID()}`;
  const first = batch.markets[0]; assert.ok(first);
  await assert.rejects(saveInfoBatch({ events: [], markets: [{ ...first, series: marker }, { ...first, value: 'invalid' }] }));
  assert.equal((await query('select 1 from market_snapshots where series=$1', [marker])).rows.length, 0);
});

test('#173 real HTTP list/detail use latest effective version and preserve fields on isolated model DB failure', async () => {
  await migrate();
  const owner = `model173-${randomUUID()}`;
  const id = Number((await query<{ id: string }>('insert into strategies(provider,name) values($1,$2) returning id', [owner, 'Model #173'])).rows[0]?.id);
  assert.ok(id > 0);
  try {
    await saveInfoBatch(batch);
    const allocation = JSON.stringify({ assets: [{ address: asset.address, symbol: 'WRONG', weightBps: 10000 }] });
    await query("insert into strategy_versions(strategy_id,version,allocation,schedule,active_at) values($1,1,$2,'{}',now()-interval '1 day')", [id, allocation]);
    const models = createModelReader({ chainId: 56, now: () => now });
    for (const failure of [false, true]) {
      const api = createServer({ modelReturns: failure ? async () => { throw new Error('SECRET_DB'); } : models,
        rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore()) });
      await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
      const address = api.address(); assert.ok(address && typeof address !== 'string');
      const base = `http://127.0.0.1:${address.port}`;
      try {
        for (const path of [`/strategies?provider=${owner}`, `/strategies/${id}`]) {
          const response = await fetch(base + path); assert.equal(response.status, 200);
          const raw: unknown = await response.json(); assert.ok(typeof raw === 'object' && raw !== null);
          const items: unknown = Reflect.get(raw, 'items');
          const item: unknown = Array.isArray(items) ? items[0] : raw;
          assert.ok(typeof item === 'object' && item !== null);
          assert.equal(Reflect.get(item, 'name'), 'Model #173');
          assert.equal(Reflect.get(item, 'modelReturns') === null, failure);
          if (!failure) {
            const returns: unknown = Reflect.get(item, 'modelReturns'); assert.ok(typeof returns === 'object' && returns !== null);
            assert.equal(Reflect.get(returns, 'd7'), '20.12345678');
            assert.equal(Reflect.get(returns, 'annualized'), null); // 7-day history is under MODEL_ANNUALIZED_MIN_DAYS.
          }
          assert.ok(Reflect.has(item, 'minDepositUsdtWei'));
          assert.equal(Reflect.has(item, 'modelNav'), !Array.isArray(items));
          assert.doesNotMatch(JSON.stringify(raw), /SECRET/);
        }
      } finally { await new Promise<void>(resolve => api.close(() => resolve())); }
    }
  } finally {
    await query('delete from strategies where id=$1', [id]);
    await query("delete from market_snapshots where series='close:AAPLB'");
  }
});

test('#173 list computes on-chain strategies from DB active_at only and never calls the chain-reading strategyDetail', async () => {
  await migrate();
  const owner = `model173-list-${randomUUID()}`;
  const onchainId = 1_730_000_000 + Math.floor(Math.random() * 1_000_000);
  const id = Number((await query<{ id: string }>('insert into strategies(provider,name,onchain_id) values($1,$2,$3) returning id',
    [owner, 'Model #173 onchain', onchainId])).rows[0]?.id);
  assert.ok(id > 0);
  try {
    await saveInfoBatch(batch);
    const nvda = MODEL_ASSETS.find(a => a.symbol === 'NVDAB'); assert.ok(nvda);
    // v1 is effective in the DB; v2 only becomes effective tomorrow and must not be used yet.
    await query("insert into strategy_versions(strategy_id,version,allocation,schedule,active_at) values($1,1,$2,'{}',now()-interval '1 day')",
      [id, JSON.stringify({ assets: [{ address: asset.address, weightBps: 10000 }] })]);
    await query("insert into strategy_versions(strategy_id,version,allocation,schedule,active_at) values($1,2,$2,'{}',now()+interval '1 day')",
      [id, JSON.stringify({ assets: [{ address: nvda.address, weightBps: 10000 }] })]);
    let chainReads = 0;
    const api = createServer({ modelReturns: createModelReader({ chainId: 56, now: () => now }),
      strategyDetail: async () => { chainReads++; throw new Error('chain read from list'); },
      rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore()) });
    await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
    const address = api.address(); assert.ok(address && typeof address !== 'string');
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/strategies?provider=${owner}`); assert.equal(response.status, 200);
      const raw: unknown = await response.json(); assert.ok(typeof raw === 'object' && raw !== null);
      const items: unknown = Reflect.get(raw, 'items'); assert.ok(Array.isArray(items) && items.length === 1);
      const returns: unknown = Reflect.get(items[0], 'modelReturns'); assert.ok(typeof returns === 'object' && returns !== null);
      assert.equal(Reflect.get(returns, 'd7'), '20.12345678');
      assert.equal(chainReads, 0);
    } finally { await new Promise<void>(resolve => api.close(() => resolve())); }
  } finally {
    await query('delete from strategies where id=$1', [id]);
    await query("delete from market_snapshots where series='close:AAPLB'");
  }
});
