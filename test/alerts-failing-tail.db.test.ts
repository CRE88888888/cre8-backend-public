import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closePool, getPool, migrate } from '../src/db.js';
import { detectPortfolioFailures } from '../src/alerts.js';

after(closePool);

test('failing-tail alert on real SQL: live portfolios alert; retired accounts and aged-out failures do not', async () => {
  await migrate();
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const q = (text: string, params: readonly unknown[] = []) => client.query(text, [...params]);
    const strategy = (await q(`insert into strategies(provider,name) values('0x00000000000000000000000000000000000000a1','alert tail test') returning id`)).rows[0]!.id;
    await q(`insert into strategy_versions(strategy_id,version,allocation,schedule) values($1,1,'{}','{}')`, [strategy]);
    const portfolio = async (opts: { account?: 'live' | 'retired'; opsAgeHours?: number; checkedAgoHours?: number | null }) => {
      const id = Number((await q(`insert into portfolios(user_id,strategy_id,version,schedule_state,last_checked_at) values('0xtail',$1,1,'active',
        case when $2::float8 is null then null else now() - make_interval(secs => $2::float8 * 3600) end) returning id`, [strategy, opts.checkedAgoHours ?? null])).rows[0]!.id);
      if (opts.account) await q(`insert into smart_accounts(portfolio_id,chain_id,address,owner,account_type,retired_at) values($1,97,$2,$2,'KERNEL',$3)`,
        [id, '0x' + id.toString(16).padStart(40, '0'), opts.account === 'retired' ? new Date() : null]);
      for (let i = 0; i < 3; i++) await q(`insert into operations(portfolio_id,type,state,idempotency_key,last_error,created_at) values($1,'rebalance','failed',$2,'[STRATEGY_EXECUTION_UNAVAILABLE] x',
        now() - make_interval(secs => $3::float8 * 3600))`, [id, `tail-${id}-${i}`, opts.opsAgeHours ?? 0]);
      return id;
    };
    const live = await portfolio({ account: 'live', checkedAgoHours: 0 });                       // failing now
    const noAccount = await portfolio({});                                                         // legacy rows without an account still alert
    const retired = await portfolio({ account: 'retired', checkedAgoHours: 0 });                 // nobody runs it any more
    const aged = await portfolio({ account: 'live', opsAgeHours: 7, checkedAgoHours: 0.1 });     // 7h old, checked cleanly since
    const justUnder = await portfolio({ account: 'live', opsAgeHours: 5, checkedAgoHours: 0.1 }); // only 5h old: still alerts
    const notChecked = await portfolio({ account: 'live', opsAgeHours: 30, checkedAgoHours: 40 }); // old, but never checked since: still alerts
    const neverChecked = await portfolio({ account: 'live', opsAgeHours: 30, checkedAgoHours: null });
    const found = new Set((await detectPortfolioFailures(q, 3)).map(f => f.portfolioId));
    assert.deepEqual([live, noAccount, retired, aged, justUnder, notChecked, neverChecked].map(id => found.has(id)), [true, true, false, false, true, true, true]);
    // A new failure after the clean rounds brings the aged one back.
    await q(`insert into operations(portfolio_id,type,state,idempotency_key,last_error) values($1,'rebalance','failed',$2,'again')`, [aged, `tail-${aged}-new`]);
    assert.equal((await detectPortfolioFailures(q, 3)).some(f => f.portfolioId === aged), true);
    // A wider clean window keeps a 7h-old tail alerting.
    assert.equal((await detectPortfolioFailures(q, 3, 12)).some(f => f.portfolioId === justUnder), true);
  } finally {
    await client.query('rollback');
    client.release();
  }
});
