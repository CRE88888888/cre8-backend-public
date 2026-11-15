import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closePool, migrate, query, withTransaction } from '../src/db.js';
import { RequestRateLimiter, RateLimitError, PersistentRateLimitStore, pruneDailyOperationCounts } from '../src/ratelimit.js';
import { loadRateLimitConfig } from '../src/config.js';
import pg from 'pg';

after(closePool);
const owner = () => `0x${randomBytes(20).toString('hex')}`;
test('#97 daily request quota survives service and process reconstruction; independent actions and atomic equality', async () => {
  await migrate();
  const wallet = owner();
  const config = { ...loadRateLimitConfig({}), strategiesPerDay: 2, versionsPerDay: 1, portfoliosPerDay: 0 };
  const limiter = () => new RequestRateLimiter(config);
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => limiter().wallet('strategies', wallet)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason instanceof RateLimitError).length, 10);
  await assert.rejects(limiter().wallet('strategies', wallet.toUpperCase()), RateLimitError);
  await limiter().wallet('versions', wallet);
  await assert.rejects(limiter().wallet('portfolios', wallet), RateLimitError);
  const source = `import {RequestRateLimiter} from './src/ratelimit.ts';import {loadRateLimitConfig} from './src/config.ts';import {closePool} from './src/db.ts';
    try{await new RequestRateLimiter({...loadRateLimitConfig({}),strategiesPerDay:2}).wallet('strategies','${wallet}');console.log('unexpected')}catch(e){console.log(e.code)}finally{await closePool()}`;
  assert.equal(execFileSync(process.execPath, ['--no-env-file', '--eval', source], { encoding: 'utf8', env: process.env }).trim(), 'RATE_LIMITED');
  const rows = (await query<{ action: string; count: string }>('select action,count::text from daily_operation_counts where owner=$1 order by action', [wallet])).rows;
  assert.deepEqual(rows, [{ action: 'create_strategy', count: '2' }, { action: 'publish_version', count: '1' }]);
});

test('#97 UTC daily buckets ignore the API clock and session timezone; cleanup retains active and seven completed days', async () => {
  await migrate(); const wallet = owner();
  await query(`insert into daily_operation_counts(owner,action,utc_day,count) select $1,'join',(now() at time zone 'UTC')::date-1,99
    union all select $1,'join',(now() at time zone 'UTC')::date-7,99
    union all select $1,'join',(now() at time zone 'UTC')::date-8,99`, [wallet]);
  const store = new PersistentRateLimitStore(fn => withTransaction(async client => { await client.query("set local time zone 'Pacific/Kiritimati'"); return fn(client); }));
  const limiter = new RequestRateLimiter({ ...loadRateLimitConfig({}), portfoliosPerDay: 1 }, store, () => 0);
  await limiter.wallet('portfolios', wallet);
  await assert.rejects(limiter.wallet('portfolios', wallet), e => e instanceof RateLimitError && e.retryAfterSeconds > 0 && e.retryAfterSeconds <= 86400);
  await pruneDailyOperationCounts();
  const rows = (await query<{ age: number; count: string }>(`select (now() at time zone 'UTC')::date-utc_day as age,count::text
    from daily_operation_counts where owner=$1 order by age`, [wallet])).rows;
  assert.deepEqual(rows, [{ age: 0, count: '1' }, { age: 1, count: '99' }, { age: 7, count: '99' }]);
});

test('#97 unknown quota COMMIT stays consumed; rollback/DB errors never fall back to memory or leak driver text', async () => {
  const wallet = owner(); const config = { ...loadRateLimitConfig({}), strategiesPerDay: 1 };
  const lost = new PersistentRateLimitStore(async fn => { await withTransaction(fn); throw new Error('SECRET DB credential'); });
  await assert.rejects(new RequestRateLimiter(config, lost).wallet('strategies', wallet), { code: 'RATE_LIMIT_UNAVAILABLE' });
  await assert.rejects(new RequestRateLimiter(config).wallet('strategies', wallet), RateLimitError);
  for (const rollback of [false, true]) {
    const broken = new PersistentRateLimitStore(fn => withTransaction(async client => {
      if (rollback) await fn(client);
      throw new Error('SECRET DB credential');
    }));
    const other = owner();
    await assert.rejects(new RequestRateLimiter(config, broken).wallet('strategies', other), e => e instanceof Error && !e.message.includes('SECRET') && 'code' in e && e.code === 'RATE_LIMIT_UNAVAILABLE');
    await new RequestRateLimiter(config).wallet('strategies', other);
  }
});

test('#97 contended daily count times out without increment; invalid policies and zero cap never create a bucket', async () => {
  const wallet = owner(); const config = { ...loadRateLimitConfig({}), versionsPerDay: 2 };
  const limiter = new RequestRateLimiter(config); await limiter.wallet('versions', wallet);
  const blocker = new pg.Client({ connectionString: process.env.DATABASE_URL }); await blocker.connect();
  try {
    await blocker.query('begin'); await blocker.query('select count from daily_operation_counts where owner=$1 for update', [wallet]);
    await assert.rejects(limiter.wallet('versions', wallet), { code: 'RATE_LIMIT_UNAVAILABLE' });
  } finally { await blocker.query('rollback'); await blocker.end(); }
  assert.equal((await query<{ count: string }>('select count::text from daily_operation_counts where owner=$1', [wallet])).rows[0]?.count, '1');
  await limiter.wallet('versions', wallet); await assert.rejects(limiter.wallet('versions', wallet), RateLimitError);
  const store = new PersistentRateLimitStore(); const key = 'wallet:' + owner() + ':strategies';
  for (const limit of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(store.consume(key, { limit, windowMs: 86400000 }, 0), RangeError);
  assert.equal((await store.consume(key, { limit: 0, windowMs: 86400000 }, 0)).allowed, false);
  assert.equal((await query('select count from daily_operation_counts where owner=$1', [key.split(':')[1]])).rows.length, 0);
});
