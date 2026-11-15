import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { bytesToHex, concatHex, keccak256, toHex } from 'viem';
import { closePool, query, withTransaction } from '../src/db.js';
import { reserveSponsorship, reserveGasBudget } from '../src/paymaster.js';
import type { Reservation } from '../src/paymaster.js';
import { loadPaymasterConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';

after(closePool);
const key = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const chainId = 991166;
function request(id: number, sender = '0x1000000000000000000000000000000000000005'): Reservation {
  const config = loadPaymasterConfig({ PAYMASTER_SIGNER_PRIVATE_KEY: key, PAYMASTER_ADDRESS: '0x1000000000000000000000000000000000000001',
    CHAIN_ID: '1337', RPC_URL: 'http://127.0.0.1:8557', EXECUTOR_ADDRESS: '0x1000000000000000000000000000000000000002', REGISTRY_ADDRESS: '0x1000000000000000000000000000000000000003' });
  assert.ok(config);
  assert.match(sender, /^0x[0-9a-f]{40}$/);
  return { hash: keccak256(toHex(id, { size: 32 })), config: { ...config, chainId, verificationGasLimit: 3n, postOpGasLimit: 4n },
    op: { sender: sender as `0x${string}`, nonce: BigInt(id), initCode: '0x', callData: '0x', accountGasLimits: concatHex([toHex(1n, { size: 16 }), toHex(2n, { size: 16 })]),
      preVerificationGas: 5n, gasFees: concatHex([toHex(1n, { size: 16 }), toHex(2n, { size: 16 })]), paymasterAndData: '0x', signature: '0x' },
    verificationGas: 1n, callGas: 2n, maxFee: 2n, gasLimit: 15n, maxCostWei: 30n, validUntil: Math.floor(Date.now() / 1000) + 300,
    budget: { executionKey: `test:paymaster:${id}:${sender}`, chainId, account: sender as `0x${string}`, purpose: 'ordinary',
      gasLimit: 15n, maxFeePerGas: 2n, nativePrice: 60000000000n, priceSource: 'test:planning-oracle' } };
}
const denied = (error: unknown) => error instanceof AppError && error.code === 'PAYMASTER_QUOTA_EXCEEDED';
async function clean() { await query('delete from paymaster_sponsorships where chain_id = $1', [chainId]); }

test('#89 sponsorship uses the request chain budget and shares the 97 gas cap with self-funded operations', async () => {
  const r = request(890001, bytesToHex(randomBytes(20)));
  r.hash = keccak256(concatHex([r.hash, r.op.sender]));
  r.config.chainId = 97;
  r.gasLimit = 10_000_000n;
  r.callGas = r.gasLimit - r.verificationGas - r.op.preVerificationGas - r.config.verificationGasLimit - r.config.postOpGasLimit;
  r.op.accountGasLimits = concatHex([toHex(r.verificationGas, { size: 16 }), toHex(r.callGas, { size: 16 })]);
  r.maxFee = 1_000_000_000n;
  r.op.gasFees = concatHex([toHex(r.maxFee, { size: 16 }), toHex(r.maxFee, { size: 16 })]);
  r.maxCostWei = r.gasLimit * r.maxFee;
  r.budget = { ...r.budget, executionKey: randomUUID(), chainId: 97, gasLimit: r.gasLimit, maxFeePerGas: r.maxFee };
  try {
    await reserveSponsorship(r);
    await reserveGasBudget(r.budget);
    await reserveSponsorship(r);
    const saved = await query<{ usd: string; n: string }>('select max(max_cost_usd)::text as usd,count(*)::text as n from gas_budget_reservations where execution_key=$1', [r.budget.executionKey]);
    assert.deepEqual(saved.rows[0], { usd: '6.00000000', n: '1' });
    await assert.rejects(reserveGasBudget({ ...r.budget, executionKey: randomUUID(), gasLimit: 1n }),
      (error: unknown) => error instanceof AppError && error.code === 'GAS_BUDGET_EXCEEDED');
    const mainnet: Reservation = { ...r, hash: keccak256(concatHex([r.hash, '0x01'])), config: { ...r.config, chainId: 56 },
      budget: { ...r.budget, chainId: 56, executionKey: randomUUID() } };
    await assert.rejects(reserveSponsorship(mainnet), (error: unknown) => error instanceof AppError && error.code === 'GAS_BUDGET_EXCEEDED');
    assert.equal((await query('select execution_key from gas_budget_reservations where execution_key=$1', [mainnet.budget.executionKey])).rows.length, 0);
    assert.equal((await query('select user_op_hash from paymaster_sponsorships where user_op_hash=$1', [mainnet.hash])).rows.length, 0);
    const other = bytesToHex(randomBytes(20));
    const blocked: Reservation = { ...r, hash: keccak256(concatHex([r.hash, other])), op: { ...r.op, sender: other },
      config: { ...r.config, siteDailyGas: 0n }, budget: { ...r.budget, account: other, executionKey: randomUUID() } };
    await assert.rejects(reserveSponsorship(blocked), denied);
    assert.equal((await query('select execution_key from gas_budget_reservations where execution_key=$1', [blocked.budget.executionKey])).rows.length, 0);
    assert.equal((await query('select user_op_hash from paymaster_sponsorships where user_op_hash=$1', [blocked.hash])).rows.length, 0);
  } finally { await query('delete from paymaster_sponsorships where user_op_hash=$1', [r.hash]); }
});

test('#75 exit still sponsors when every ordinary account quota is zero', async () => {
  const r = request(750001);
  r.config = { ...r.config, accountDailyCount: 0n, accountDailyGas: 0n, accountDailyWei: 0n };
  const exit: Reservation = { ...r, budget: { executionKey: 'exit-regression-75', chainId, account: r.op.sender,
    purpose: 'exit', gasLimit: r.gasLimit, maxFeePerGas: r.maxFee,
    nativePrice: 60000000000n, priceSource: 'test:planning-oracle' } };
  try { await reserveSponsorship(exit); }
  finally { await clean(); }
});

test('#75 self-funded and sponsored writers share one immutable charge; site rejection rolls both reservations back', async () => {
  const r = request(750002);
  await reserveGasBudget(r.budget);
  try {
    await reserveSponsorship(r);
    assert.equal((await query<{ n: string }>('select count(*)::text as n from gas_budget_reservations where execution_key=$1', [r.budget.executionKey])).rows[0]?.n, '1');
    const denied = request(750003);
    denied.config.siteDailyGas = 0n;
    await assert.rejects(reserveSponsorship(denied), (error: unknown) => error instanceof AppError && error.code === 'PAYMASTER_QUOTA_EXCEEDED');
    assert.equal((await query('select execution_key from gas_budget_reservations where execution_key=$1', [denied.budget.executionKey])).rows.length, 0);
    assert.equal((await query('select user_op_hash from paymaster_sponsorships where user_op_hash=$1', [denied.hash])).rows.length, 0);
  } finally { await clean(); }
});

test('#66 Postgres exact account count/gas/wei and site gas/wei boundaries, zero blocks; every state counts', async () => {
  try {
    for (const budget of ['accountDailyCount', 'accountDailyGas', 'accountDailyWei', 'siteDailyGas', 'siteDailyWei'] as const) {
      for (const delta of [-1n, 0n, 1n]) {
        await clean();
        const r = request(660001);
        const amount = budget === 'accountDailyCount' ? 1n : budget.endsWith('Gas') ? 15n : 30n;
        r.config = { ...r.config, [budget]: amount + delta };
        if (delta < 0n) await assert.rejects(reserveSponsorship(r), denied);
        else {
          await reserveSponsorship(r);
          // Exact retry must not charge again, including a retry after module/process reconstruction.
          await reserveSponsorship({ ...r, config: { ...r.config } });
          assert.equal((await query<{ n: string }>('select count(*)::text as n from paymaster_sponsorships where chain_id = $1', [chainId])).rows[0]?.n, '1');
        }
      }
      await clean();
      const zero = request(660002);
      zero.config = { ...zero.config, [budget]: 0n };
      await assert.rejects(reserveSponsorship(zero), denied);
    }
    for (const state of ['reserved', 'submitted', 'confirmed', 'expired', 'failed']) {
      await clean();
      const r = request(660003);
      r.config.accountDailyCount = 1n;
      await reserveSponsorship(r);
      await query('update paymaster_sponsorships set state=$2, updated_at=now() where user_op_hash=$1', [r.hash, state]);
      await assert.rejects(reserveSponsorship({ ...r, hash: request(660004).hash }), denied);
    }
  } finally { await clean(); }
});

test('#66 real concurrent API/scheduler writers and paymaster rotation share site quota, without a stale pre-lock snapshot', async () => {
  await clean();
  try {
    const requests = Array.from({ length: 12 }, (_, i) => {
      const r = request(661000 + i, `0x${(0x2000 + i).toString(16).padStart(40, '0')}`);
      r.config = { ...r.config, siteDailyGas: 15n, address: i % 2 ? '0x1000000000000000000000000000000000000010' : r.config.address };
      return r;
    });
    const results = await Promise.allSettled(requests.map((r) => reserveSponsorship(r)));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected' && denied(result.reason)).length, 11);
    const totals = await query<{ n: string; gas: string; wei: string }>('select count(*)::text as n, sum(gas_limit)::text as gas, sum(max_cost_wei)::text as wei from paymaster_sponsorships where chain_id=$1', [chainId]);
    assert.deepEqual(totals.rows[0], { n: '1', gas: '15', wei: '30' });
  } finally { await clean(); }
});

test('#66 a new process cannot reset the durable daily allowance', async () => {
  await clean();
  try {
    const r = request(661500);
    r.config.accountDailyCount = 1n;
    const run = (input: Reservation) => {
      const source = `
        import { reserveSponsorship } from ${JSON.stringify(new URL('../src/paymaster.ts', import.meta.url).href)};
        import { closePool } from ${JSON.stringify(new URL('../src/db.ts', import.meta.url).href)};
        const r = JSON.parse(process.env.PAYMASTER_TEST_RESERVATION);
        for (const k of ['verificationGasLimit','postOpGasLimit','accountDailyCount','accountDailyGas','accountDailyWei','siteDailyGas','siteDailyWei','minDepositWei']) r.config[k] = BigInt(r.config[k]);
        for (const k of ['nonce','preVerificationGas']) r.op[k] = BigInt(r.op[k]);
        for (const k of ['verificationGas','callGas','maxFee','gasLimit','maxCostWei']) r[k] = BigInt(r[k]);
        for (const k of ['gasLimit','maxFeePerGas','nativePrice']) r.budget[k] = BigInt(r.budget[k]);
        try { await reserveSponsorship(r); console.log('reserved'); }
        catch (error) { console.log(error instanceof Error && 'code' in error ? error.code : 'unexpected'); }
        finally { await closePool(); }
      `;
      const output = execFileSync(process.execPath, ['--eval', source], { encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, PAYMASTER_TEST_RESERVATION: JSON.stringify(input, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value) } });
      return output.trim().split('\n').at(-1);
    };
    assert.equal(run(r), 'reserved');
    assert.equal(run({ ...r, hash: request(661501).hash }), 'PAYMASTER_QUOTA_EXCEEDED');
    assert.equal(run(r), 'reserved', 'exact retry reuses the existing charge across processes');
    assert.equal((await query<{ n: string }>('select count(*)::text as n from paymaster_sponsorships where chain_id=$1', [chainId])).rows[0]?.n, '1');
  } finally { await clean(); }
});

test('#66 UTC day is independent of DB timezone; yesterday frees current quota, invalid immutable retries cannot replace charges', async () => {
  await clean();
  try {
    const r = request(662001);
    r.config.accountDailyCount = 1n;
    await reserveSponsorship(r, (fn) => withTransaction(async (client) => { await client.query("set local time zone 'Pacific/Kiritimati'"); return fn(client); }));
    const row = await query<{ matches: boolean }>("select utc_day = (transaction_timestamp() at time zone 'UTC')::date as matches from paymaster_sponsorships where user_op_hash=$1", [r.hash]);
    assert.equal(row.rows[0]?.matches, true);
    await assert.rejects(reserveSponsorship({ ...r, maxFee: r.maxFee + 1n }), (error: unknown) => error instanceof AppError && error.code === 'GAS_BUDGET_CONFLICT');
    await query("update paymaster_sponsorships set created_at=created_at-interval '1 day' where user_op_hash=$1", [r.hash]);
    await reserveSponsorship({ ...r, hash: request(662002).hash });
    assert.equal((await query<{ n: string }>('select count(*)::text as n from paymaster_sponsorships where chain_id=$1', [chainId])).rows[0]?.n, '2');
  } finally { await clean(); }
});

test('#66 lock timeout and transaction/commit failure refuse authorization; unknown commit remains charged', async () => {
  await clean();
  const blocker = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await blocker.connect();
  try {
    const r = request(663001);
    r.config.timeoutMs = 10;
    await blocker.query('begin');
    await blocker.query("select pg_advisory_xact_lock(hashtextextended('paymaster_sponsorships:' || $1::bigint::text || ':' || to_char((transaction_timestamp() at time zone 'UTC')::date,'YYYY-MM-DD'),0))", [chainId]);
    await assert.rejects(reserveSponsorship(r), (error: unknown) => error instanceof AppError && error.code === 'PAYMASTER_STORAGE_UNAVAILABLE');
    assert.equal((await query<{ n: string }>('select count(*)::text as n from paymaster_sponsorships where chain_id=$1', [chainId])).rows[0]?.n, '0');
    await blocker.query('rollback');
    await assert.rejects(reserveSponsorship(r, async () => { throw new Error('secret DB failure'); }), (error: unknown) => error instanceof AppError && !error.message.includes('secret'));
    await assert.rejects(reserveSponsorship(r, async (fn) => { await withTransaction(fn); throw new Error('unknown commit'); }), (error: unknown) => error instanceof AppError && error.code === 'PAYMASTER_STORAGE_UNAVAILABLE');
    await reserveSponsorship(r);
    assert.equal((await query<{ n: string }>('select count(*)::text as n from paymaster_sponsorships where chain_id=$1', [chainId])).rows[0]?.n, '1');
  } finally { await blocker.query('rollback'); await blocker.end(); await clean(); }
});
