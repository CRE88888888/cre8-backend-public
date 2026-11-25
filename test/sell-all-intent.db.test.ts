import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, test } from 'node:test';
import type { Address } from 'viem';
import { detectSellAllOverdue, resetRoundOutcomes } from '../src/alerts.js';
import { closePool, getPool, migrate, query } from '../src/db.js';
import { claimDuePortfolios } from '../src/scheduler.js';
import { singlePortfolioClaim } from '../src/operator.js';
import { CANCEL_SELL_ALL_SQL, NEW_MONEY_ENDS_SELL_ALL_SQL, SELL_ALL_KIND, SELL_ALL_OF_PORTFOLIO_SQL, requestSellAll, sellAllRetryAt, settleSellAll } from '../src/sell-all-intent.js';
import { canonicalConfigHash, validateAssetConfig } from '../src/strategy-execution.js';
import type { Allocation } from '../src/strategies.js';
import { TESTNET_97 } from '../src/testnet-profile.js';

/**
 * Real Postgres (db repo migrations): the "sell all" request row (src/sell-all-intent.ts) against the real
 * `user_notifications` table — its foreign keys, its owner check and its write-once trigger — and the scheduler's claim.
 */
after(closePool);
const DB = process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('127.0.0.1:1/');
const address = (): Address => `0x${randomBytes(20).toString('hex')}`;
const cash = TESTNET_97.contracts.usdt, a = TESTNET_97.assets.WBNB.token, b = TESTNET_97.assets.ETH.token;
const run = (sql: string, params?: readonly unknown[]) => query(sql, params === undefined ? [] : [...params]);

/** A fund portfolio on chain 97 (per-asset execution) with its account; `ledger: false` leaves out the cash ledger row. */
async function portfolio(o: { state?: string; ledger?: boolean } = {}) {
  const owner = address(), account = address();
  const sid = (await query<{ id: string }>("insert into strategies(provider,name) values($1,'sell-all-intent') returning id", [owner])).rows[0]!.id;
  await query('update strategies set onchain_id=$2 where id=$1', [sid, Number(sid) + 97000000]);
  const allocation: Allocation = { assets: [{ address: cash, weightBps: 0 }, { address: a, weightBps: 5000 }, { address: b, weightBps: 5000 }] };
  const activeAt = new Date(Math.floor((Date.now() - 3 * 86_400_000) / 60_000) * 60_000);
  const execution = validateAssetConfig({ kind: 'per_asset', numeraire: cash, rebalance: 'none', assets: allocation.assets.map(x => ({ asset: x.address, weightBps: x.weightBps, yield: null,
    ...(x.address === cash ? {} : { execution: { kind: 'stack', every: 'weekly', weekday: 1, timeUtc: '03:00', slices: 2 } }) })) }, allocation, 97);
  const configHash = canonicalConfigHash({ chainId: 97, allocation, execution, schedule: { kind: 'funding' }, activeAt });
  await query(`insert into strategy_versions(strategy_id,version,allocation,schedule,active_at,execution_schema_version,execution,execution_chain_id,config_hash)
    values($1,1,$2,'{"kind":"funding"}',$3,2,$4,97,$5)`, [sid, JSON.stringify(allocation), activeAt, JSON.stringify(execution), configHash]);
  const id = Number((await query<{ id: string }>('insert into portfolios(user_id,strategy_id,version,schedule_state) values($1,$2,1,$3) returning id', [owner, sid, o.state ?? 'active'])).rows[0]!.id);
  await query("insert into smart_accounts(portfolio_id,chain_id,address,owner,account_type) values($1,97,$2,$3,'KERNEL')", [id, account, owner]);
  if (o.ledger !== false) await query('insert into strategy_cash_balances(chain_id,portfolio_id,account) values(97,$1,$2)', [id, account]);
  made.push(id);
  return id;
}
/**
 * The database is shared with the other suites, whose alert rounds read every open request and every portfolio's latest
 * operations: each test leaves no open request and no failed operation behind.
 */
const made: number[] = [];
const tidy = <T>(body: () => Promise<T>) => async () => {
  try { await body(); }
  finally {
    await query(`update user_notifications set state='failed',updated_at=clock_timestamp() where kind=$1 and state='pending' and portfolio_id=any($2::bigint[])`, [SELL_ALL_KIND, made]);
    await query('delete from operations where portfolio_id=any($1::bigint[])', [made]);
  }
};
const requests = async (id: number) => (await query<{ state: string; dedup_key: string }>(
  'select state,dedup_key from user_notifications where portfolio_id=$1 and kind=$2 order by id', [id, SELL_ALL_KIND])).rows.map(r => `${r.dedup_key.replace(`${id}:`, '#')} ${r.state}`);
const state = async (id: number) => (await query<{ schedule_state: string; next_run_at: Date | null }>('select schedule_state,next_run_at from portfolios where id=$1', [id])).rows[0]!;
/** What the scheduler would claim `seconds` from now (a `/close` call keeps it away for 90 seconds). */
const claimed = async (id: number, seconds = 120) => (await claimDuePortfolios(100_000, new Date(Date.now() + seconds * 1000), { chainId: 97, advance: false })).find(due => due.portfolioId === id);
const operation = (id: number, state: string) => query(`insert into operations(portfolio_id,type,state,idempotency_key,payload_hash,attempts,updated_at) values($1,'rebalance',$2,$3,'0x00',1,clock_timestamp())`,
  [id, state, `sell-all-test:${id}:${randomBytes(6).toString('hex')}`]);

test('sell all request (real Postgres): written once per request, read by the claim while active and while paused, closed when the sale is over', { skip: !DB }, tidy(async () => {
  await migrate();
  const id = await portfolio();
  assert.equal((await claimed(id))?.sellAll, undefined, 'no request: an ordinary portfolio');
  // `/close` twice (and twice at the same moment): one open request.
  assert.equal(await requestSellAll(run, 97, id), true);
  assert.deepEqual(await Promise.all([requestSellAll(run, 97, id), requestSellAll(run, 97, id)]), [true, true]);
  assert.deepEqual(await requests(id), ['#1 pending']);
  // The caller is still here: not claimed for 90 seconds after its call, then claimed as "sell all".
  assert.equal(await claimed(id, 60), undefined);
  assert.equal((await claimed(id))?.sellAll, true);
  // A batch was sold: paused like after `/close`, still claimed because the request is open.
  await settleSellAll(run, id, { outcome: 'executed', over: false, tracked: true });
  assert.equal((await state(id)).schedule_state, 'paused');
  const due = await claimed(id);
  assert.deepEqual([due?.sellAll, due?.executionKind], [true, 'per_asset']);
  // A round that sold nothing and found something left changes nothing.
  await settleSellAll(run, id, { outcome: 'blocked', over: false, tracked: true });
  assert.deepEqual(await requests(id), ['#1 pending']);
  // Nothing but cash is left: closed, paused, and no longer claimed.
  await settleSellAll(run, id, { outcome: 'noop', over: true, tracked: true });
  assert.deepEqual(await requests(id), ['#1 delivered']);
  assert.equal((await state(id)).schedule_state, 'paused');
  assert.equal(await claimed(id), undefined);
  // The row is written once: its life only moves forward (the table's own trigger).
  await assert.rejects(query(`update user_notifications set state='pending' where portfolio_id=$1 and kind=$2`, [id, SELL_ALL_KIND]), /invalid notification transition/);
  // A later "sell all" on the same portfolio is a new request.
  assert.equal(await requestSellAll(run, 97, id), true);
  assert.deepEqual(await requests(id), ['#1 delivered', '#2 pending']);
}));

test('sell all request (real Postgres): the owner\'s new money or buy ends it and the portfolio is managed again; a pause that came later is not undone', { skip: !DB }, tidy(async () => {
  await migrate();
  // Mid-sale (paused by the first batch): new money ends the request and resumes at once.
  const id = await portfolio();
  await requestSellAll(run, 97, id);
  await settleSellAll(run, id, { outcome: 'executed', over: false, tracked: true });
  await query("update portfolios set next_run_at=now()+interval '1 day' where id=$1", [id]);
  await query(NEW_MONEY_ENDS_SELL_ALL_SQL, [id]);
  assert.deepEqual(await requests(id), ['#1 failed']);
  assert.deepEqual(await state(id), { schedule_state: 'active', next_run_at: null });
  assert.equal((await claimed(id))?.sellAll, undefined, 'an ordinary round again');
  // The sale's last round was still running when the money came in: its bookkeeping no longer pauses the portfolio.
  await settleSellAll(run, id, { outcome: 'executed', over: false, tracked: true });
  assert.equal((await state(id)).schedule_state, 'active');
  // Without an open request the statement changes nothing: a portfolio paused for another reason stays paused.
  const paused = await portfolio({ state: 'paused' });
  await query(NEW_MONEY_ENDS_SELL_ALL_SQL, [paused]);
  assert.equal((await state(paused)).schedule_state, 'paused');
  assert.equal(await claimed(paused), undefined);
  // `/rebalance` and `execution-state` end the request and leave the schedule state to their own statement.
  const bought = await portfolio();
  await requestSellAll(run, 97, bought);
  await query(CANCEL_SELL_ALL_SQL, [bought]);
  assert.deepEqual(await requests(bought), ['#1 failed']);
  assert.equal((await state(bought)).schedule_state, 'active');
  // The DCA round's read (src/dca.ts): an open request counts as paused.
  const selling = async (p: number) => (await query<{ selling: boolean }>(`select ${SELL_ALL_OF_PORTFOLIO_SQL} as selling from portfolios p where p.id=$1`, [p])).rows[0]!.selling;
  assert.deepEqual([await selling(bought), await selling(id)], [false, false]);
  await requestSellAll(run, 97, bought);
  assert.equal(await selling(bought), true);
}));

test('sell all request (real Postgres): the single-portfolio claims of /close, /redeem, /rebalance and /plan run as written and carry the request', { skip: !DB }, tidy(async () => {
  await migrate();
  const id = await portfolio(), other = await portfolio();
  // What the owner's own calls claim: the scheduler's claim narrowed to one portfolio (operator.ts singlePortfolioClaim).
  const own = async (options: { allowPaused?: boolean; preserveNextRunAt?: boolean } = {}, advance = false) =>
    (await claimDuePortfolios(1, new Date(), { chainId: 97, advance, withTransaction: singlePortfolioClaim(id, undefined, options) })).map(due => [due.portfolioId, due.sellAll ?? false]);
  const close = { allowPaused: true, preserveNextRunAt: true };
  assert.deepEqual(await own(close), [[id, false]]);
  await requestSellAll(run, 97, id);
  await requestSellAll(run, 97, other);
  // The request does not hide the portfolio from its owner's calls (the scheduler itself waits 90 seconds), and never brings another portfolio along.
  assert.deepEqual(await own(close), [[id, true]]);
  assert.deepEqual(await own(), [[id, true]], '/redeem and /plan on an active portfolio');
  // A `/close` claim advances next_run_at only forwards (the full interval is later than the caller's 90 seconds).
  const before = (await state(id)).next_run_at!;
  assert.deepEqual(await own(close, true), [[id, true]]);
  assert.ok((await state(id)).next_run_at!.getTime() >= before.getTime());
  // Paused by the first batch: `/close` still claims it; calls that need an active portfolio do not (as before).
  await settleSellAll(run, id, { outcome: 'executed', over: false, tracked: true });
  assert.deepEqual(await own(close), [[id, true]]);
  assert.deepEqual(await own(), []);
  // Done: `/close` again finds a paused portfolio without a request.
  await settleSellAll(run, id, { outcome: 'noop', over: true, tracked: true });
  assert.deepEqual(await own(close), [[id, false]]);
}));

test('sell all request (real Postgres): a portfolio without a cash ledger row holds no request and /close works as before (untracked pause)', { skip: !DB }, tidy(async () => {
  await migrate();
  const id = await portfolio({ ledger: false });
  assert.equal(await requestSellAll(run, 97, id), false);
  assert.deepEqual(await requests(id), []);
  await settleSellAll(run, id, { outcome: 'executed', over: false, tracked: false });
  assert.equal((await state(id)).schedule_state, 'paused');
  assert.equal(await claimed(id), undefined, 'paused without a request: not claimed, the client continues as before');
}));

test('sell all request (real Postgres): failed sends since the request space the retries out; a confirmed sale or a quiet round resets nothing it should not', { skip: !DB }, tidy(async () => {
  await migrate();
  const id = await portfolio();
  await operation(id, 'reverted'); // before the request: never counted
  await requestSellAll(run, 97, id);
  const now = () => new Date(Date.now() + 1_000);
  assert.equal(await sellAllRetryAt(run, 97, id, now()), null);
  for (let i = 0; i < 4; i++) await operation(id, i % 2 ? 'failed' : 'reverted');
  assert.equal(await sellAllRetryAt(run, 97, id, now()), null, 'four failed sends: the next round still tries');
  await operation(id, 'reverted');
  const wait = await sellAllRetryAt(run, 97, id, now());
  assert.equal(wait?.failures, 5);
  assert.ok(wait && wait.at.getTime() - Date.now() > 4 * 60_000 && wait.at.getTime() - Date.now() <= 5 * 60_000 + 1_000, 'five minutes after the fifth');
  assert.equal(await sellAllRetryAt(run, 97, id, new Date(Date.now() + 6 * 60_000)), null, 'then it goes again');
  await operation(id, 'failed'); await operation(id, 'failed'); await operation(id, 'failed');
  const long = await sellAllRetryAt(run, 97, id, new Date(Date.now() + 3 * 3_600_000));
  assert.equal(long?.failures, 8); assert.ok(long && long.at.getTime() - Date.now() > 5 * 3_600_000, 'the eighth waits six hours');
  // A sale that confirmed ends the streak.
  await operation(id, 'confirmed');
  assert.equal(await sellAllRetryAt(run, 97, id, now()), null);
  await operation(id, 'reverted');
  assert.equal(await sellAllRetryAt(run, 97, id, now()), null, 'one failure after a success is one');
  // No open request: nothing to guard.
  assert.equal(await sellAllRetryAt(run, 97, await portfolio(), now()), null);
}));

test('sell all request (real Postgres): only requests older than the alert threshold are reported, with their failure streak', { skip: !DB }, tidy(async () => {
  await migrate();
  resetRoundOutcomes();
  const fresh = await portfolio(), old = await portfolio(), failing = await portfolio();
  await requestSellAll(run, 97, fresh);
  const backdated = (id: number) => query(`insert into user_notifications(chain_id,portfolio_id,owner,kind,dedup_key,created_at,updated_at)
    select 97,portfolio_id,owner,$2,portfolio_id::text||':1',now()-interval '7 hours',now()-interval '7 hours' from smart_accounts where portfolio_id=$1`, [id, SELL_ALL_KIND]);
  await backdated(old); await backdated(failing);
  for (let i = 0; i < 6; i++) await operation(failing, 'reverted');
  const mine = (await detectSellAllOverdue(run, 6, new Date())).filter(f => [fresh, old, failing].includes(f.portfolioId ?? 0));
  assert.deepEqual(mine.map(f => [f.portfolioId, f.kind, f.severity]), [[old, 'portfolio_stuck', 'critical'], [failing, 'portfolio_stuck', 'critical']]);
  assert.match(mine[0]!.detail, /^\[SELL_ALL_PENDING\] portfolio \d+ 的全部賣出從 .*（7\.0 小時）還沒賣完；排程器會繼續重試/);
  assert.match(mine[1]!.detail, /連續 6 次送出失敗/);
  // Once closed it is gone.
  await settleSellAll(run, old, { outcome: 'noop', over: true, tracked: true });
  assert.ok(!(await detectSellAllOverdue(run, 6, new Date())).some(f => f.portfolioId === old));
}));

test('sell all request: a My mix that already exits on its own (exiting, exited, deleting, deleted, re-enrolled) gets no request and is not resumed by new money', { skip: !DB }, async () => {
  // Temp tables shadow the real ones for this connection only: the statements are exercised as written.
  const client = await getPool().connect();
  try {
    await client.query('create temp table portfolios (id bigint primary key, schedule_state text, next_run_at timestamptz)');
    await client.query('create temp table mixes (id bigint primary key, status text, triggered_at timestamptz, delete_requested_at timestamptz, deleted_at timestamptz)');
    await client.query('create temp table mix_portfolio_history (mix_id bigint, portfolio_id bigint, ended_at timestamptz)');
    await client.query('create temp table strategy_cash_balances (chain_id bigint, portfolio_id bigint, account text)');
    await client.query('create temp table smart_accounts (portfolio_id bigint, chain_id bigint, address text, owner text)');
    await client.query(`create temp table user_notifications (id bigserial primary key, chain_id bigint, portfolio_id bigint, owner text, kind text, dedup_key text,
      state text not null default 'pending', updated_at timestamptz default now(), unique (chain_id, kind, dedup_key))`);
    const mix = async (portfolio: number, patch: string, ended = false) => {
      await client.query("insert into portfolios values($1,'active')", [portfolio]);
      await client.query("insert into strategy_cash_balances values(97,$1,'0xaccount')", [portfolio]);
      await client.query("insert into smart_accounts values($1,97,'0xaccount','0xowner')", [portfolio]);
      await client.query(`insert into mixes(id,status) values($1,'active')`, [portfolio]);
      if (patch) await client.query(`update mixes set ${patch} where id=$1`, [portfolio]);
      await client.query('insert into mix_portfolio_history values($1,$1,$2)', [portfolio, ended ? new Date() : null]);
    };
    const on = (sql: string, params?: readonly unknown[]) => client.query(sql, params === undefined ? [] : [...params]);
    await mix(10, '');                             // My mix, running
    await mix(11, "status='exited'");              // take profit / stop loss / delete finished
    await mix(12, 'triggered_at=now()');           // exit in progress
    await mix(13, 'delete_requested_at=now()');    // deleting
    await mix(14, 'deleted_at=now()');             // deleted
    await mix(15, '', true);                       // the old portfolio of a re-enrolled mix
    const asked: [number, boolean][] = [];
    for (const id of [10, 11, 12, 13, 14, 15]) asked.push([id, await requestSellAll(on, 97, id)]);
    assert.deepEqual(asked, [[10, true], [11, false], [12, false], [13, false], [14, false], [15, false]]);
    // A request left open on a mix that started its own exit afterwards: new money ends the request but does not resume it.
    await client.query("update mixes set triggered_at=now() where id=10");
    await client.query("update portfolios set schedule_state='paused' where id=10");
    await client.query(NEW_MONEY_ENDS_SELL_ALL_SQL, [10]);
    assert.deepEqual((await client.query('select state from user_notifications where portfolio_id=10')).rows, [{ state: 'failed' }]);
    assert.deepEqual((await client.query('select schedule_state from portfolios where id=10')).rows, [{ schedule_state: 'paused' }]);
  } finally {
    await client.query('discard temp').catch(() => {});
    client.release();
  }
});
