import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import pg from 'pg';
import { closePool, getPool, migrate, query, withPortfolioLock, withTransaction } from '../src/db.js';
import { withRelayerLock } from '../src/relayer-lock.js';
import { AppError } from '../src/errors.js';

after(closePool);

test('#97 migration table locks time out in five seconds with a safe actionable error', { timeout: 12000 }, async () => {
  await migrate();
  const blocker = await getPool().connect();
  try {
    await blocker.query('begin');
    await blocker.query('lock table schema_migrations in access exclusive mode');
    const child = spawn(process.execPath, ['--no-env-file', '--eval', `
      import {migrate,closePool} from './src/db.ts';
      try {await migrate(); console.log('unexpected success');}
      catch(e) {console.log(e instanceof Error ? e.message : 'unknown');}
      finally {await closePool();}`], { env: { ...process.env, DB_STATEMENT_TIMEOUT_MS: '7000' }, stdio: ['ignore','pipe','pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    await new Promise<void>((resolve, reject) => { child.on('close', () => resolve()); child.on('error', reject); });
    assert.match(output, /migration lock timeout \(5000ms\)/);
    assert.doesNotMatch(output, /postgres:|DATABASE_URL/);
  } finally { await blocker.query('rollback'); blocker.release(); }
  await migrate();
  assert.equal((await query('show lock_timeout')).rows[0]?.lock_timeout, '0');
});

test('#97 ten portfolio holders can attempt the relayer without borrowing a second connection', { timeout: 12000 }, async () => {
  await migrate();
  let entered = 0;
  let ready = () => {};
  const barrier = new Promise<void>(resolve => { ready = resolve; });
  let actions = 0;
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, index) =>
    withPortfolioLock(1_000_000_200 + index, async () => {
      if (++entered === 10) ready();
      await barrier;
      const pid = (await query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid;
      return withRelayerLock(97, async assertHeld => {
        assertHeld();
        await withTransaction(async client => {
          assert.equal((await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid, pid);
        });
        actions++;
      });
    })));
  assert.ok(actions > 0, 'at least one relayer action must run with a saturated pool');
  for (const r of results) if (r.status === 'rejected') assert.ok(r.reason instanceof AppError && r.reason.code === 'RELAYER_BUSY');
  assert.equal(getPool().waitingCount, 0);
  await assert.rejects(withRelayerLock(97, async () => { throw new Error('callback failure'); }), /callback failure/);
  await withRelayerLock(97, async assertHeld => { assertHeld(); });
  await withRelayerLock(56, async assertHeld => { assertHeld(); });
});

test('#57 database timeouts apply to real PostgreSQL sessions', async () => {
  assert.equal(getPool().options.statement_timeout, 15_000);
  assert.equal(getPool().options.idle_in_transaction_session_timeout, 30_000);
  assert.equal((await query('show statement_timeout')).rows[0]?.statement_timeout, '15s');
  assert.equal((await query('show idle_in_transaction_session_timeout')).rows[0]?.idle_in_transaction_session_timeout, '30s');
});

test('#57 lock holds across commits on one session, excludes independent clients, and releases on errors', async () => {
  const observer = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const id = Number.MAX_SAFE_INTEGER;
  const checkUnlocked = async () => {
    const result = await observer.query<{ acquired: boolean }>('select pg_try_advisory_lock($1::bigint) as acquired', [-BigInt(id)]);
    assert.equal(result.rows[0]?.acquired, true);
    await observer.query('select pg_advisory_unlock($1::bigint)', [-BigInt(id)]);
  };
  try {
    for (const failure of ['none', 'callback', 'rollback', 'timeout'] as const) {
      const run = withPortfolioLock(id, async () => {
        const pid = (await query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid;
        await withTransaction(async (client) => {
          assert.equal((await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid, pid);
        });
        const held = await observer.query<{ acquired: boolean }>('select pg_try_advisory_lock($1::bigint) as acquired', [-BigInt(id)]);
        assert.equal(held.rows[0]?.acquired, false, 'COMMIT must not release the planning lock');
        assert.equal(await withPortfolioLock(id, async () => assert.fail('nested work cannot reenter the portfolio lock')), null);
        if (failure === 'callback') throw new Error('callback failed');
        if (failure === 'rollback') await withTransaction(async (client) => { await client.query('select 1 / 0'); });
        if (failure === 'timeout') await withTransaction(async (client) => {
          await client.query("set local statement_timeout = '10ms'");
          await client.query('select pg_sleep(0.1)');
        });
        return 'done';
      });
      if (failure === 'none') assert.equal(await run, 'done');
      else await assert.rejects(run, failure === 'callback' ? /callback failed/ : failure === 'rollback' ? /division by zero/ : /statement timeout/);
      await checkUnlocked();
    }
    await observer.query('select pg_advisory_lock($1::bigint)', [-BigInt(id)]);
    try {
      assert.equal(await withPortfolioLock(id, async () => assert.fail('contended lock cannot plan')), null);
      assert.equal(await withPortfolioLock(id - 1, async () => 'independent'), 'independent');
    } finally {
      await observer.query('select pg_advisory_unlock($1::bigint)', [-BigInt(id)]);
    }
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(withPortfolioLock(invalid, async () => {}), /invalid portfolio id/);
    }
  } finally { await observer.end(); }
});

test('#57 ten concurrent portfolio locks can read and commit without exhausting the ten-client pool', { timeout: 5000 }, async () => {
  let entered = 0;
  let allEntered = () => {};
  const all = new Promise<void>((resolve) => { allEntered = resolve; });
  const runs = Array.from({ length: 10 }, (_, index) => withPortfolioLock(1_000_000_000 + index, async () => {
    await query('select 1');
    await withTransaction(async (client) => { await client.query('select 1'); });
    if (++entered === 10) allEntered();
    await all;
    return index;
  }));
  assert.deepEqual(await Promise.all(runs), Array.from({ length: 10 }, (_, index) => index));
});

test('#57 a lost lock connection is discarded and PostgreSQL releases its session lock', async () => {
  const observer = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const id = 1_000_000_100;
  try {
    await assert.rejects(withPortfolioLock(id, async () => {
      const pid = (await query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid;
      assert.ok(pid);
      await observer.query('select pg_terminate_backend($1)', [pid]);
      await query('select 1');
    }), /terminat|closed|not queryable/i);
    assert.equal(await withPortfolioLock(id, async () => 'recovered'), 'recovered');
  } finally { await observer.end(); }
});

test('#57 timeout env overrides reach PostgreSQL; invalid values fail without echoing input', () => {
  const probe = `import { query, closePool } from './src/db.ts';
    try {
      console.log(JSON.stringify([(await query('show statement_timeout')).rows[0].statement_timeout,
        (await query('show idle_in_transaction_session_timeout')).rows[0].idle_in_transaction_session_timeout]));
    } finally { await closePool(); }`;
  const output = execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8', env: { ...process.env,
    DB_STATEMENT_TIMEOUT_MS: '23', DB_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS: '47',
  } });
  assert.deepEqual(JSON.parse(output.trim().split('\n').at(-1) ?? ''), ['23ms', '47ms']);
  for (const value of ['1', '2147483647']) {
    const bounded = execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8', env: { ...process.env,
      DB_STATEMENT_TIMEOUT_MS: value, DB_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS: value,
    } });
    assert.deepEqual(JSON.parse(bounded.trim().split('\n').at(-1) ?? ''), [`${value}ms`, `${value}ms`]);
  }
  for (const value of ['0', '-1', '1.5', '2147483648', 'private-token']) {
    for (const name of ['DB_STATEMENT_TIMEOUT_MS', 'DB_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS']) {
      const error = execFileSync(process.execPath, ['-e', `import { getPool } from './src/db.ts';
        try { getPool(); } catch (error) { console.log(error instanceof Error ? error.message : 'unknown'); }`], {
        encoding: 'utf8', env: { ...process.env, [name]: value },
      });
      assert.match(error, new RegExp(`${name} must be an integer`));
      assert.doesNotMatch(error, /private-token/);
    }
  }
});
