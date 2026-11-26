import { query as dbQuery } from './db.js';

/**
 * Paused strategy jobs (strategy_jobs.state = 'paused' after three failed attempts, scheduler failStrategyAttempt) had
 * no way back: the portfolio's buy stayed frozen forever (2026-11-23 portfolios 13 and 19, paused by the paymaster's
 * daily quota). Two ways back:
 *
 * - Retryable pause: every one of the job's last three attempts failed with nothing on chain (operations.state
 *   'failed', no tx hash) — quota, gas budget, RPC / bundler unavailable. It resumes on its own one hour after it
 *   paused (or on the next UTC day when it paused late in the day: the paymaster quota and the gas budget are per UTC
 *   day), with its failure count reset. If the cause is still there it pauses again after three more tries, so the
 *   retry rate stays bounded.
 * - Real failure (an attempt reverted on chain, or anything was sent): stays paused until the owner acts on that
 *   portfolio (buy, sell, withdraw, edit), which resets it — the owner is looking at it and the inputs changed.
 *
 * No chain reads: plain SQL on the scheduler's DB connection.
 */
type Query = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
export type PausedJob = { jobId: string; portfolioId: string; pausedAt: string; retryable: boolean };

const RETRYABLE = `not exists (select 1 from (select o.state, o.tx_hash from operations o where o.strategy_job_id = j.id order by o.id desc limit 3) last
    where last.state <> 'failed' or last.tx_hash is not null)`;

/** Every paused job, with whether it is retryable (for the scheduler log and operators). */
export async function listPausedJobs(run: Query = dbQuery as never): Promise<PausedJob[]> {
  const rows = (await run(`select j.id::text as job_id, j.portfolio_id::text as portfolio_id, j.updated_at, ${RETRYABLE} as retryable
    from strategy_jobs j where j.state = 'paused' order by j.portfolio_id, j.id`)).rows as { job_id: string; portfolio_id: string; updated_at: Date; retryable: boolean }[];
  return rows.map(r => ({ jobId: r.job_id, portfolioId: r.portfolio_id, pausedAt: new Date(r.updated_at).toISOString(), retryable: r.retryable === true }));
}

/** Scheduler round: resume retryable pauses whose cool-down has passed. Returns what it resumed. */
export async function resumeRetryablePausedJobs(now: Date, run: Query = dbQuery as never): Promise<{ jobId: string; portfolioId: string }[]> {
  const rows = (await run(`update strategy_jobs j set state = 'running', failure_count = 0, next_check_at = $1, updated_at = greatest(clock_timestamp(), j.updated_at)
    where j.state = 'paused' and ${RETRYABLE}
      and $1::timestamptz >= least(j.updated_at + interval '1 hour', date_trunc('day', j.updated_at at time zone 'UTC') at time zone 'UTC' + interval '1 day')
    returning j.id::text as job_id, j.portfolio_id::text as portfolio_id`, [now.toISOString()])).rows as { job_id: string; portfolio_id: string }[];
  return rows.map(r => ({ jobId: r.job_id, portfolioId: r.portfolio_id }));
}

/** The owner acted on this portfolio (buy, sell, withdraw, edit): any paused job runs again from a clean count. */
export async function resumePausedJobsForPortfolio(portfolioId: number, run: Query = dbQuery as never): Promise<number> {
  return (await run(`update strategy_jobs set state = 'running', failure_count = 0, next_check_at = clock_timestamp(), updated_at = clock_timestamp()
    where portfolio_id = $1 and state = 'paused' returning id`, [portfolioId])).rows.length;
}

/** Same, by the portfolio's account (a withdrawal is a sponsored UserOp from the account). */
export async function resumePausedJobsForAccount(chainId: number, account: string, run: Query = dbQuery as never): Promise<number> {
  return (await run(`update strategy_jobs set state = 'running', failure_count = 0, next_check_at = clock_timestamp(), updated_at = clock_timestamp()
    where state = 'paused' and chain_id = $1 and portfolio_id in (select portfolio_id from smart_accounts where chain_id = $1 and address = $2 and retired_at is null)
    returning id`, [chainId, account.toLowerCase()])).rows.length;
}

/** A My mix edit: the mix's current portfolio (and the previous one, which a weight change just closed). */
export async function resumePausedJobsForMix(mixId: number, owner: string, run: Query = dbQuery as never): Promise<number> {
  return (await run(`update strategy_jobs set state = 'running', failure_count = 0, next_check_at = clock_timestamp(), updated_at = clock_timestamp()
    where state = 'paused' and portfolio_id in (select h.portfolio_id from mix_portfolio_history h join mixes m on m.id = h.mix_id
      where m.id = $1 and m.owner = $2 and h.ended_at is null) returning id`, [mixId, owner.toLowerCase()])).rows.length;
}
