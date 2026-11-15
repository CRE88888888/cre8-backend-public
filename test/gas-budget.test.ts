import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { after, test } from 'node:test';
import pg from 'pg';
import { bytesToHex } from 'viem';
import { closePool, query, withTransaction } from '../src/db.js';
import { AppError } from '../src/errors.js';
import { loadTradingConfig } from '../src/config.js';
import { existingBudgetContext, gasExecutionKey, reserveGasBudget, settleGasBudget } from '../src/paymaster.js';
import type { GasBudgetRequest } from '../src/paymaster.js';
import { operation } from './fixtures/paymaster.js';

after(closePool);
const policy = loadTradingConfig({});
const code = (expected: string) => (error: unknown) => error instanceof AppError && error.code === expected;
function reservation(): GasBudgetRequest {
  return { executionKey: randomUUID(), chainId: 750001, account: bytesToHex(randomBytes(20)), purpose: 'ordinary',
    gasLimit: 10_000_000n, maxFeePerGas: 50_000_000n, nativePrice: 60000000000n, priceSource: 'test:planning-oracle' };
}

test('#75 both ordinary caps include equality, zero blocks positive usage; USD rounds up rather than down', async () => {
  for (const delta of [-1n, 0n, 1n]) {
    const r = reservation();
    r.gasLimit += delta;
    if (delta > 0n) await assert.rejects(reserveGasBudget(r), code('GAS_BUDGET_EXCEEDED'));
    else await reserveGasBudget(r);
  }
  const r = reservation();
  await reserveGasBudget(r);
  const stored = await query<{ usd: string }>('select max_cost_usd::text as usd from gas_budget_reservations where execution_key=$1', [r.executionKey]);
  assert.equal(stored.rows[0]?.usd, '0.30000000');
  for (const cap of [{ dailyGas: 0n }, { dailyUsdE8: 0n }]) await assert.rejects(reserveGasBudget(reservation(), withTransaction, { ...policy, ...cap }), code('GAS_BUDGET_EXCEEDED'));
  const dust = { ...reservation(), gasLimit: 1n, maxFeePerGas: 1n, nativePrice: 1n };
  await reserveGasBudget(dust, withTransaction, { ...policy, dailyUsdE8: 1n });
  await assert.rejects(reserveGasBudget({ ...dust, executionKey: randomUUID() }, withTransaction, { ...policy, dailyUsdE8: 1n }), code('GAS_BUDGET_EXCEEDED'));
});

test('#75 failed/unknown costs persist, and exit bypasses exhausted ordinary gas and USD caps', async () => {
  for (const state of ['reserved', 'submitted', 'confirmed', 'failed', 'unknown']) {
    const r = reservation();
    await reserveGasBudget(r);
    await query('update gas_budget_reservations set state=$2,updated_at=now() where execution_key=$1', [r.executionKey, state]);
    await assert.rejects(reserveGasBudget({ ...r, executionKey: randomUUID(), gasLimit: 1n }), code('GAS_BUDGET_EXCEEDED'));
    await reserveGasBudget({ ...r, executionKey: randomUUID(), purpose: 'exit', gasLimit: r.gasLimit * 20n }, withTransaction, { ...policy, dailyGas: 0n, dailyUsdE8: 0n });
  }
});

test('#75 setup is separate, lifetime unique across days; failed setup alone releases its slot', async () => {
  const r = { ...reservation(), purpose: 'setup' } satisfies GasBudgetRequest;
  await reserveGasBudget(r, withTransaction, { ...policy, dailyGas: 0n, dailyUsdE8: 0n });
  await assert.rejects(reserveGasBudget({ ...r, executionKey: randomUUID() }), code('GAS_BUDGET_STORAGE_UNAVAILABLE'));
  await query("update gas_budget_reservations set state='unknown',updated_at=now() where execution_key=$1", [r.executionKey]);
  await assert.rejects(reserveGasBudget({ ...r, executionKey: randomUUID() }), code('GAS_BUDGET_STORAGE_UNAVAILABLE'));
  await query("update gas_budget_reservations set state='failed',updated_at=now() where execution_key=$1", [r.executionKey]);
  await reserveGasBudget({ ...r, executionKey: randomUUID() });
});

test('#75 concurrent ordinary writers reserve once under the shared account/day lock', async () => {
  const r = reservation();
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => reserveGasBudget({ ...r, executionKey: randomUUID() })));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && code('GAS_BUDGET_EXCEEDED')(result.reason)).length, 11);
});

test('#75 immutable retries preserve original price/day; funding and signature changes keep one execution key', async () => {
  const r = reservation();
  await reserveGasBudget(r);
  await reserveGasBudget({ ...r });
  for (const change of [{ gasLimit: r.gasLimit - 1n }, { maxFeePerGas: r.maxFeePerGas + 1n }, { nativePrice: r.nativePrice + 1n }, { priceSource: 'other' }, { purpose: 'exit' } ] satisfies Partial<GasBudgetRequest>[]) {
    await assert.rejects(reserveGasBudget({ ...r, ...change }), code('GAS_BUDGET_CONFLICT'));
  }
  const saved = await existingBudgetContext(r.executionKey);
  assert.equal(saved?.priceSource, r.priceSource);
  const op = operation();
  const funded = { ...op, signature: '0x1234', paymasterAndData: '0xabcd' };
  assert.equal(gasExecutionKey(1337, op), gasExecutionKey(1337, funded));
  assert.notEqual(gasExecutionKey(1337, op), gasExecutionKey(1337, { ...op, nonce: 1n }));
});

test('#75 DB/lock timeout and unknown commit fail closed, durable reservation survives retry and a new process', async () => {
  const r = reservation();
  await assert.rejects(reserveGasBudget(r, async () => { throw new Error('secret DB token'); }), code('GAS_BUDGET_STORAGE_UNAVAILABLE'));
  await assert.rejects(reserveGasBudget(r, async (fn) => { await withTransaction(fn); throw new Error('unknown commit'); }), code('GAS_BUDGET_STORAGE_UNAVAILABLE'));
  await reserveGasBudget(r);
  const child = `import {reserveGasBudget} from ${JSON.stringify(new URL('../src/paymaster.ts', import.meta.url).href)};
    import {closePool} from ${JSON.stringify(new URL('../src/db.ts', import.meta.url).href)};
    const r=JSON.parse(process.env.GAS_BUDGET_TEST_REQUEST);
    for(const k of ['gasLimit','maxFeePerGas','nativePrice']) r[k]=BigInt(r[k]);
    try { await reserveGasBudget(r); console.log('reserved'); } finally { await closePool(); }`;
  const output = execFileSync(process.execPath, ['--eval', child], { timeout: 10000, encoding: 'utf8', env: { ...process.env,
    GAS_BUDGET_TEST_REQUEST: JSON.stringify(r, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value) } });
  assert.equal(output.trim().split('\n').at(-1), 'reserved');
  const blocker = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await blocker.connect();
  const blocked = reservation();
  try {
    await blocker.query('begin');
    await blocker.query("select pg_advisory_xact_lock(hashtextextended('gas_budget_reservations:' || $1::bigint::text || ':' || $2::text || ':' || to_char((transaction_timestamp() at time zone 'UTC')::date,'YYYY-MM-DD'),0))", [blocked.chainId, blocked.account]);
    await assert.rejects(reserveGasBudget(blocked, withTransaction, { ...policy, timeoutMs: 10 }), code('GAS_BUDGET_STORAGE_UNAVAILABLE'));
  } finally { await blocker.query('rollback'); await blocker.end(); }
});

test('#75 UTC rollover frees only the new day; retries and settlement keep the original reservation day', async () => {
  const r = reservation();
  await query(`insert into gas_budget_reservations(execution_key,chain_id,account,purpose,gas_limit,max_fee_per_gas,native_price_usd,price_source,created_at,updated_at)
    values($1,$2,$3,'ordinary',$4,$5,600,$6,now()-interval '1 day',now()-interval '1 day')`,
    [r.executionKey, r.chainId, r.account, r.gasLimit.toString(), r.maxFeePerGas.toString(), r.priceSource]);
  await reserveGasBudget(r, (fn) => withTransaction(async (client) => { await client.query("set local time zone 'Pacific/Kiritimati'"); return fn(client); }));
  await reserveGasBudget({ ...r, executionKey: randomUUID() });
  await settleGasBudget(r.executionKey, 'confirmed');
  await settleGasBudget(r.executionKey, 'unknown');
  const stored = await query<{ previous_day: boolean; state: string }>("select utc_day=(transaction_timestamp() at time zone 'UTC')::date-1 as previous_day,state from gas_budget_reservations where execution_key=$1", [r.executionKey]);
  assert.deepEqual(stored.rows[0], { previous_day: true, state: 'confirmed' });
});
