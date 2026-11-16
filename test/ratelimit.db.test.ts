import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closePool, migrate, query, withTransaction } from '../src/db.js';
import { RequestRateLimiter, RateLimitError, PersistentRateLimitStore, pruneDailyOperationCounts, consumeAccountDeploymentBudget } from '../src/ratelimit.js';
import { loadRateLimitConfig } from '../src/config.js';
import { kernelAddressesForChain } from '../src/addresses.js';
import type { Address } from 'viem';
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

test('#124 deployment quota shares a durable UTC-day cap across owners and atomically preserves both budgets on denial',async()=>{
  await migrate();
  const global=kernelAddressesForChain(97).kernelMetaFactory.toLowerCase(),wallet=owner() as Address;
  await query('delete from daily_operation_counts where owner=$1',[global]);
  try{
    await assert.rejects(consumeAccountDeploymentBudget(wallet,withTransaction,{perOwner:20,perDay:0}),{code:'ACCOUNT_DEPLOYMENT_DAILY_LIMIT'});
    assert.equal((await query('select count from daily_operation_counts where owner in ($1,$2)',[global,wallet])).rows.length,0);
    await consumeAccountDeploymentBudget(wallet,withTransaction,{perOwner:1,perDay:2});
    await assert.rejects(consumeAccountDeploymentBudget(wallet,withTransaction,{perOwner:1,perDay:2}),RateLimitError);
    const others=Array.from({length:10},()=>owner() as Address);
    const results=await Promise.allSettled(others.map(w=>consumeAccountDeploymentBudget(w,withTransaction,{perOwner:20,perDay:2})));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    for(const r of results)if(r.status==='rejected')assert.equal(r.reason.code,'ACCOUNT_DEPLOYMENT_DAILY_LIMIT');
    assert.equal((await query<{count:string}>('select count::text from daily_operation_counts where owner=$1',[global])).rows[0]?.count,'2');
    assert.equal((await query('select owner from daily_operation_counts where owner=any($1::text[])',[others])).rows.length,1);
    const script=`import {consumeAccountDeploymentBudget} from './src/ratelimit.ts';import {withTransaction,closePool} from './src/db.ts';
      try{await consumeAccountDeploymentBudget('${owner()}',withTransaction,{perOwner:20,perDay:2});console.log('unexpected')}catch(e){console.log(e.code)}finally{await closePool()}`;
    assert.equal(execFileSync(process.execPath,['--no-env-file','--eval',script],{encoding:'utf8',env:process.env}).trim(),'ACCOUNT_DEPLOYMENT_DAILY_LIMIT');
    await query('delete from daily_operation_counts where owner=$1',[global]);
    const lost:typeof withTransaction=async fn=>{await withTransaction(fn);throw new Error('SECRET_QUOTA_COMMIT');};
    await assert.rejects(consumeAccountDeploymentBudget(owner() as Address,lost,{perOwner:20,perDay:1}),{code:'ACCOUNT_DEPLOYMENT_BUDGET_UNAVAILABLE'});
    await assert.rejects(consumeAccountDeploymentBudget(owner() as Address,withTransaction,{perOwner:20,perDay:1}),{code:'ACCOUNT_DEPLOYMENT_DAILY_LIMIT'});
    await assert.rejects(consumeAccountDeploymentBudget(owner() as Address,async()=>{throw new Error('SECRET_DB');}),error=>error instanceof Error&&!error.message.includes('SECRET')&&'code'in error&&error.code==='ACCOUNT_DEPLOYMENT_BUDGET_UNAVAILABLE');
  }finally{await query('delete from daily_operation_counts where owner=$1',[global]);}
});
