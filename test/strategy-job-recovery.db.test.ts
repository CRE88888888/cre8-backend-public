import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closePool, getPool } from '../src/db.js';
import { listPausedJobs, resumePausedJobsForAccount, resumePausedJobsForMix, resumePausedJobsForPortfolio, resumeRetryablePausedJobs } from '../src/strategy-job-recovery.js';

after(closePool);
const DB = process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('127.0.0.1:1/');

/** Temp tables shadow the real ones for this connection only (pg_temp is searched first): the SQL is exercised as written. */
async function withTables(work: (run: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>) => Promise<void>) {
  const client = await getPool().connect();
  try {
    await client.query(`create temp table strategy_jobs (id bigserial primary key, chain_id bigint, portfolio_id bigint, state text, failure_count int,
      next_check_at timestamptz, updated_at timestamptz)`);
    await client.query(`create temp table operations (id bigserial primary key, strategy_job_id bigint, state text, tx_hash text)`);
    await client.query(`create temp table smart_accounts (portfolio_id bigint, chain_id bigint, address text, retired_at timestamptz)`);
    await client.query(`create temp table mixes (id bigint, owner text)`);
    await client.query(`create temp table mix_portfolio_history (mix_id bigint, portfolio_id bigint, ended_at timestamptz)`);
    await work((sql, params) => client.query(sql, params as unknown[]));
  } finally {
    await client.query('discard temp').catch(() => {});
    client.release();
  }
}

test('paused jobs: nothing-landed pauses resume after the cool-down; a reverted attempt waits for the owner', { skip: !DB }, async () => {
  await withTables(async run => {
    const job = async (portfolio: number, pausedAt: string, ops: [string, string | null][]) => {
      const id = (await run(`insert into strategy_jobs(chain_id,portfolio_id,state,failure_count,next_check_at,updated_at) values(97,$1,'paused',3,$2,$2) returning id`,
        [portfolio, pausedAt])).rows[0] as { id: string };
      for (const [state, tx] of ops) await run('insert into operations(strategy_job_id,state,tx_hash) values($1,$2,$3)', [id.id, state, tx]);
      return id.id;
    };
    const tx = '0x' + '01'.repeat(32);
    // portfolio 19 on 2026-11-23: three quota refusals, nothing on chain, paused 16:26 UTC.
    const quota = await job(19, '2026-11-23T16:26:51Z', [['failed', null], ['failed', null], ['failed', null]]);
    // an attempt that reverted on chain: a real failure.
    const reverted = await job(13, '2026-11-23T10:00:00Z', [['failed', null], ['reverted', tx], ['failed', null]]);
    // an old landed attempt beyond the last three does not count.
    const older = await job(10, '2026-11-23T08:00:00Z', [['reverted', tx], ['failed', null], ['failed', null], ['failed', null]]);
    const list = await listPausedJobs(run);
    assert.deepEqual(list.map(p => [p.portfolioId, p.retryable]), [['10', true], ['13', false], ['19', true]]);
    // Cool-down not over (16:50): nothing resumes.
    assert.deepEqual(await resumeRetryablePausedJobs(new Date('2026-11-23T16:50:00Z'), run), [{ jobId: older, portfolioId: '10' }]);
    // An hour after the pause: the quota one resumes with a clean count; the reverted one stays paused.
    assert.deepEqual(await resumeRetryablePausedJobs(new Date('2026-11-23T17:27:00Z'), run), [{ jobId: quota, portfolioId: '19' }]);
    const rows = (await run('select portfolio_id::int as p, state, failure_count from strategy_jobs order by portfolio_id')).rows;
    assert.deepEqual(rows, [{ p: 10, state: 'running', failure_count: 0 }, { p: 13, state: 'paused', failure_count: 3 }, { p: 19, state: 'running', failure_count: 0 }]);
    // The owner's next action resets the real failure.
    assert.equal(await resumePausedJobsForPortfolio(13, run), 1);
    assert.equal(await resumePausedJobsForPortfolio(13, run), 0);
    assert.deepEqual((await listPausedJobs(run)), []);
    void reverted;
  });
});

test('owner withdrawal (by account) and My mix edit (by mix) reset only that owner\'s paused jobs', { skip: !DB }, async () => {
  await withTables(async run => {
    for (const p of [20, 21]) await run(`insert into strategy_jobs(chain_id,portfolio_id,state,failure_count,next_check_at,updated_at) values(97,$1,'paused',3,now(),now())`, [p]);
    await run(`insert into smart_accounts values(20,97,'0xaa',null),(21,97,'0xbb',null)`);
    await run(`insert into mixes values(9,'0xowner')`);
    await run(`insert into mix_portfolio_history values(9,21,null)`);
    assert.equal(await resumePausedJobsForAccount(97, '0xAA', run), 1);
    assert.equal(await resumePausedJobsForMix(9, '0xsomeone', run), 0);
    assert.equal(await resumePausedJobsForMix(9, '0xOWNER', run), 1);
  });
});
