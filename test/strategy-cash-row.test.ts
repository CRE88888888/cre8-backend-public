import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lockCash } from '../src/strategy-jobs.js';
import type { SchedulerQueryFn } from '../src/scheduler.js';

/**
 * Portfolio 2 failed every scheduler round at prepareStrategyJob (`if(!cash)throw unavailable()`): it had no
 * strategy_cash_balances row, and lockCash only did `select … for update`. Rows were created only by
 * yieldLocks / cashLock / mix-store. This fake keeps the table in memory with the same
 * `on conflict(chain_id,portfolio_id) do nothing` semantics.
 */
type Row = { chain_id: number; portfolio_id: number; account: string; stack_prefund_raw: string };
const ACCOUNT = '0x00000000000000000000000000000000000000Ab';
const SMART = '0x00000000000000000000000000000000000000cd';

function fakeDb(rows: Row[] = []) {
  const sql: string[] = [];
  const query: SchedulerQueryFn = async (text, params = []) => {
    sql.push(text);
    const [chainId, portfolioId] = params as [number, number];
    const has = () => rows.some((r) => r.chain_id === chainId && r.portfolio_id === portfolioId);
    if (/^\s*insert into strategy_cash_balances/.test(text)) {
      const account = text.includes('from smart_accounts') ? SMART : String(params[2]);
      if (!has()) rows.push({ chain_id: chainId, portfolio_id: portfolioId, account, stack_prefund_raw: '0' });
      return { rows: [] };
    }
    if (text.includes('from strategy_cash_balances')) {
      return { rows: rows.filter((r) => r.chain_id === chainId && r.portfolio_id === portfolioId) };
    }
    return { rows: [] };
  };
  return { query, rows, sql };
}

test('portfolio 2: lockCash creates the missing cash row with zero defaults before locking it (job account)', async () => {
  const db = fakeDb();
  await lockCash(db.query, { chainId: 97, portfolioId: 2, account: ACCOUNT });
  assert.deepEqual(db.rows, [{ chain_id: 97, portfolio_id: 2, account: ACCOUNT.toLowerCase(), stack_prefund_raw: '0' }]);
  const insert = db.sql.findIndex((s) => s.includes('insert into strategy_cash_balances'));
  const lock = db.sql.findIndex((s) => s.includes('from strategy_cash_balances') && s.includes('for update'));
  assert.ok(insert >= 0 && insert < lock, 'insert … on conflict do nothing runs before select … for update');
  assert.match(db.sql[insert] ?? '', /on conflict\(chain_id,portfolio_id\) do nothing/);
  // What prepareStrategyJob reads right after locking: the row now exists.
  const cash = (await db.query('select stack_prefund_raw::text from strategy_cash_balances where chain_id=$1 and portfolio_id=$2', [97, 2])).rows[0];
  assert.deepEqual(cash && { stack_prefund_raw: (cash as Row).stack_prefund_raw }, { stack_prefund_raw: '0' });
});

test('lockCash without a job account uses the portfolio\'s live smart account; an existing row is never touched', async () => {
  const db = fakeDb();
  await lockCash(db.query, { chainId: 97, portfolioId: 2 });
  assert.equal(db.rows[0]?.account, SMART);
  assert.match(db.sql.find((s) => s.includes('insert')) ?? '', /from smart_accounts a where a\.chain_id=\$1 and a\.portfolio_id=\$2 and a\.retired_at is null/);

  const existing = fakeDb([{ chain_id: 97, portfolio_id: 2, account: SMART, stack_prefund_raw: '123' }]);
  await lockCash(existing.query, { chainId: 97, portfolioId: 2, account: ACCOUNT });
  assert.deepEqual(existing.rows, [{ chain_id: 97, portfolio_id: 2, account: SMART, stack_prefund_raw: '123' }]);
});

test('a zero placeholder account is never written as the cash row owner', async () => {
  const db = fakeDb();
  await lockCash(db.query, { chainId: 97, portfolioId: 2, account: '0x0000000000000000000000000000000000000000' });
  assert.equal(db.rows[0]?.account, SMART);
});
