import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { after, test } from 'node:test';
import pg from 'pg';
import { bytesToHex, concatHex, encodeAbiParameters, encodeFunctionData, keccak256, toHex } from 'viem';
import type { Address } from 'viem';
import { closePool, query, withTransaction } from '../src/db.js';
import { AppError } from '../src/errors.js';
import { createPaymasterService, gasExecutionKey, reserveGasBudget, reserveSponsorship, settleGasBudget } from '../src/paymaster.js';
import type { Reservation } from '../src/paymaster.js';
import { applyExpiredExitProofs, expiredExitProofs, rememberExitFacts, unusedExitUsage } from '../src/paymaster-exit-reconciliation.js';
import type { ExitFacts } from '../src/paymaster-exit-reconciliation.js';
import { config, kernelCall, operation, OWNER, TEST_SIGNER } from './fixtures/paymaster.js';
import { writeYieldState } from '../src/yield-runtime-state.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
import { YIELD_EXECUTOR_ABI } from '../src/yield-abi.js';

after(closePool);
const account = () => bytesToHex(randomBytes(20));
const denied = (code: string) => (error: unknown) => error instanceof AppError && error.status === 429 && error.code === code;
function exit(sender: Address, gas = 15n): Reservation {
  const validUntil = Math.floor(Date.now() / 1000) + 600;
  const c = { ...config({ CHAIN_ID: '97', PAYMASTER_SIGNER_PRIVATE_KEY: TEST_SIGNER, RPC_URL: 'http://127.0.0.1:8599' }),
    verificationGasLimit: 3n, postOpGasLimit: 4n, accountDailyCount: 0n, accountDailyGas: 0n, accountDailyWei: 0n };
  const op = operation({ sender, nonce: 0n,
    callData: kernelCall(encodeFunctionData({ abi: YIELD_EXECUTOR_ABI, functionName: 'executeWithdraw',
      args: [sender, T.yieldMarkets[0].marketId, 1n, 1n, BigInt(validUntil)] }), c.executor),
    accountGasLimits: concatHex([toHex(1n, { size: 16 }), toHex(gas - 13n, { size: 16 })]), preVerificationGas: 5n });
  return { hash: keccak256(toHex(randomUUID())), op, config: c, validUntil, verificationGas: 1n, callGas: gas - 13n,
    maxFee: 2n, gasLimit: gas, maxCostWei: gas * 2n,
    budget: { chainId: 97, account: sender, executionKey: gasExecutionKey(97, op), purpose: 'exit',
      gasLimit: gas, maxFeePerGas: 2n, nativePrice: 1n, priceSource: 'test:114' } };
}
const facts = (r: Reservation): ExitFacts => ({ chainId: 97, account: r.op.sender, userOpHash: r.hash,
  executionKey: r.budget.executionKey, nonce: r.op.nonce.toString(), validUntil: r.validUntil, purpose: 'exit' });
async function apply(r: Reservation) {
  const now = Math.floor(Date.now() / 1000);
  return withTransaction(async db => {
    await db.query("select pg_advisory_xact_lock(hashtextextended('paymaster_account:97:'||$1::text,0))", [r.op.sender]);
    return applyExpiredExitProofs(db, 97, r.op.sender, [{ facts: facts(r), blockNumber: '100',
      blockHash: keccak256(toHex('finalized')), blockTimestamp: r.validUntil + 1, checkedAt: now, operator: 'test114', reference: 'issue114' }]);
  });
}
/** Seed an already expired legacy authorization; no new signature is issued by this fixture. */
async function legacy(r: Reservation, previousDay = false) {
  // Explicit UTC charge day, independent of a lookback interval around midnight.
  const sinceMidnight = Date.now() % 86400000;
  if (sinceMidnight < 2000) await new Promise<void>(resolve => setTimeout(resolve, 2000 - sinceMidnight));
  r.validUntil = Math.floor(Date.now() / 1000) - 1;
  const chargeDay = new Date(Date.now() - (previousDay ? 86400000 : 0)).toISOString().slice(0, 10);
  await withTransaction(async db => {
    await reserveGasBudget(r.budget, fn => fn(db));
    await rememberExitFacts(facts(r), (sql, params) => db.query(sql, params ? [...params] : []));
    await db.query(`insert into paymaster_sponsorships(user_op_hash,chain_id,paymaster,sender,verification_gas_limit,call_gas_limit,
      pre_verification_gas,paymaster_verification_gas_limit,paymaster_post_op_gas_limit,max_fee_per_gas,valid_until,created_at)
      values($1,97,$2,$3,$4,$5,5,3,4,2,to_timestamp($6),$7::date::timestamp at time zone 'UTC')`,
    [r.hash, r.config.address, r.op.sender, r.verificationGas.toString(), r.callGas.toString(), r.validUntil,
      chargeDay]);
  });
}
async function clean(accounts: Address[]) {
  await query('delete from paymaster_sponsorships where chain_id=97 and sender=any($1::text[])', [accounts]);
}

test('#114 zero broadcasts and repeated finalized expiry cannot exhaust another account site allowance', async () => {
  const sender = account(), other = account();
  let timestamp = 0;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += String(part);
    const rpc: { id: number; method: string } = JSON.parse(body);
    const result = rpc.method === 'eth_chainId' ? '0x61' : rpc.method === 'eth_call'
      ? encodeAbiParameters([{ type: 'uint256' }], [0n])
      : { number: '0x64', hash: keccak256(toHex('finalized')), timestamp: toHex(timestamp) };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = server.address(); assert.ok(endpoint && typeof endpoint !== 'string');
  let accepted = 0;
  try {
    for (let index = 0; index < 15; index++) {
      const r = exit(sender, 13_050_000n);
      // Exercise the old short-expiry attack directly at the durable reservation boundary.
      r.validUntil = Math.floor(Date.now() / 1000) + 1;
      try { await reserveSponsorship(r); accepted++; }
      catch (error) {
        assert.ok(error instanceof AppError && ['PAYMASTER_EXIT_UNUSED_BUDGET_EXCEEDED', 'PAYMASTER_EXIT_RETRY_LIMIT', 'PAYMASTER_QUOTA_EXCEEDED'].includes(error.code));
        break;
      }
      timestamp = r.validUntil + 1;
      await new Promise<void>(resolve => setTimeout(resolve, Math.max(1, timestamp * 1000 - Date.now() + 10)));
      const proofs = await expiredExitProofs({ chainId: 97, rpcUrl: `http://127.0.0.1:${endpoint.port}`, timeoutMs: 1000 }, sender);
      assert.equal(proofs.length, 1);
      assert.equal(await withTransaction(async db => {
        await db.query("select pg_advisory_xact_lock(hashtextextended('paymaster_account:97:'||$1::text,0))", [sender]);
        return applyExpiredExitProofs(db, 97, sender, proofs);
      }), 1);
    }
    const usage = (await query<{ gas: string }>('select coalesce(sum(gas_limit),0)::text as gas from paymaster_sponsorships where sender=$1', [sender])).rows[0];
    // The second account must still receive an authorization before inspecting totals.
    await reserveSponsorship(exit(other, 13_050_000n));
    assert.ok(usage && BigInt(usage.gas) <= 20_000_000n, `unused exits occupied ${usage?.gas} of 200M site gas`);
    assert.equal(accepted, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await clean([sender, other]); }
});

test('#114 three released unused authorizations persist across instances and rotations; consumed exits do not increment the count', async () => {
  const sender = account(), other = account();
  try {
    for (let index = 0; index < 3; index++) {
      const r = exit(sender); r.op.nonce = BigInt(100 + index);
      r.budget.executionKey = gasExecutionKey(97, r.op);
      await legacy(r); assert.equal(await apply(r), 1); assert.equal(await apply(r), 0);
      if (index < 2) {
        const next = exit(sender);
        await reserveSponsorship(next);
        await reserveSponsorship({ ...next, config: { ...next.config } });
        const consumed = exit(sender); consumed.op.nonce = BigInt(index + 1); consumed.budget.executionKey = gasExecutionKey(97, consumed.op);
        await reserveSponsorship({ ...consumed, consumedAuthorizations: [{ userOpHash: next.hash, executionKey: next.budget.executionKey, success: index === 0 }] });
        await query("update gas_budget_reservations set state='confirmed',updated_at=clock_timestamp() where execution_key=$1", [consumed.budget.executionKey]);
        await query("update paymaster_sponsorships set state='confirmed',updated_at=clock_timestamp() where user_op_hash=$1", [consumed.hash]);
      }
    }
    const next = exit(sender); next.config.address = account();
    await assert.rejects(reserveSponsorship(next), denied('PAYMASTER_EXIT_RETRY_LIMIT'));
    const source = `import {unusedExitUsage} from ${JSON.stringify(new URL('../src/paymaster-exit-reconciliation.ts', import.meta.url).href)};
      import {query,closePool} from ${JSON.stringify(new URL('../src/db.ts', import.meta.url).href)};
      try { const usage=await unusedExitUsage(query,97,process.env.PAYMASTER_TEST_ACCOUNT,new Date().toISOString().slice(0,10));
        console.log(usage.count.toString()); } finally { await closePool(); }`;
    const count = execFileSync(process.execPath, ['--no-env-file', '--eval', source], {
      encoding: 'utf8', timeout: 10000, env: { ...process.env, PAYMASTER_TEST_ACCOUNT: sender } });
    assert.equal(count.trim().split('\n').at(-1), '3', 'a fresh process reads the same durable retry count');
    assert.equal((await query('select user_op_hash from paymaster_sponsorships where user_op_hash=$1', [next.hash])).rows.length, 0);
    await reserveSponsorship(exit(other));
  } finally { await clean([sender, other]); }
});

test('#114 unused gas and wei caps include the next signature, accept equality, floor 10%, and preserve site charges', async () => {
  for (const budget of ['siteDailyGas', 'siteDailyWei'] as const) {
    for (const delta of [-1n, 0n, 1n]) {
      const sender = account();
      try {
        const old = exit(sender);
        await legacy(old); assert.equal(await apply(old), 1);
        const r = exit(sender);
        r.config[budget] = (budget === 'siteDailyGas' ? 30n : 60n) * 10n + delta;
        if (delta < 0n) {
          await assert.rejects(reserveSponsorship(r), denied('PAYMASTER_EXIT_UNUSED_BUDGET_EXCEEDED'));
          assert.equal((await query('select execution_key from gas_budget_reservations where execution_key=$1', [r.budget.executionKey])).rows.length, 1, 'old immutable gas ledger stays present');
          assert.equal((await query('select user_op_hash from paymaster_sponsorships where user_op_hash=$1', [r.hash])).rows.length, 0);
        } else {
          await reserveSponsorship(r); await reserveSponsorship(r);
          const usage = (await query<{ gas: string; wei: string }>('select sum(gas_limit)::text as gas,sum(max_cost_wei)::text as wei from paymaster_sponsorships where sender=$1', [sender])).rows[0];
          assert.deepEqual(usage, { gas: '30', wei: '60' });
        }
      } finally { await clean([sender]); }
    }
  }
});

test('#114 zero site caps still reject; confirmed and failed consumed exits exceed three without using the unused allowance', async () => {
  const sender = account();
  try {
    for (const budget of ['siteDailyGas', 'siteDailyWei'] as const) {
      const r = exit(sender); r.config[budget] = 0n;
      await assert.rejects(reserveSponsorship(r), denied('PAYMASTER_QUOTA_EXCEEDED'));
    }
    let prior: Reservation | undefined;
    for (let index = 0; index < 6; index++) {
      const r = exit(sender); r.op.nonce = BigInt(index); r.budget.executionKey = gasExecutionKey(97, r.op);
      // A tight 10% cap holds one signature, while genuine nonce consumption frees its exposure.
      r.config.siteDailyGas = 150n;
      await reserveSponsorship({ ...r, consumedAuthorizations: prior ? [{ userOpHash: prior.hash, executionKey: prior.budget.executionKey, success: index % 2 === 0 }] : [] });
      prior = r;
    }
    assert.equal((await query('select user_op_hash from paymaster_sponsorships where sender=$1', [sender])).rows.length, 6);
  } finally { await clean([sender]); }
});

test('#114 UTC release day resets count while unused cost stays on the original sponsorship day', async () => {
  const sender = account(), now = new Date();
  const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
  try {
    for (let index = 0; index < 3; index++) {
      const r = exit(sender); r.op.nonce = BigInt(index); r.budget.executionKey = gasExecutionKey(97, r.op);
      await legacy(r, true);
      await writeYieldState(`release-${r.hash.slice(2)}`, { reason: 'expired_finalized_nonce_unchanged', utcDay: yesterday,
        evidence: [{ facts: facts(r), checkedAt: Math.floor(now.getTime() / 1000) - 86400 }] });
      await query("update paymaster_sponsorships set state='expired',updated_at=clock_timestamp() where user_op_hash=$1", [r.hash]);
      await query("update gas_budget_reservations set state='failed',updated_at=clock_timestamp() where execution_key=$1", [r.budget.executionKey]);
    }
    const next = exit(sender); next.config.siteDailyGas = 150n; next.config.siteDailyWei = 300n;
    await reserveSponsorship(next);
    await reserveSponsorship(next);
    assert.equal((await query('select user_op_hash from paymaster_sponsorships where sender=$1', [sender])).rows.length, 4);
  } finally { await clean([sender]); }
});

test('#114 live retry reuses its signature after time advances and other legacy releases reach three', async () => {
  const sender = account();
  let clock = Math.floor(Date.now() / 1000);
  const r = exit(sender);
  const service = () => createPaymasterService({ config: r.config, now: () => clock,
    query: async () => ({ rows: [{ owner: OWNER, user_id: OWNER }] }), checkChain: async () => {}, verifyYieldWithdraw: async () => [],
    readBudgetContext: async () => ({ purpose: 'exit', nativePrice: 1n, priceSource: 'test:114' }) });
  try {
    const signed = await service().sponsor({ userOperation: r.op }, OWNER);
    for (let index = 0; index < 3; index++) {
      const old = exit(sender); old.op.nonce = BigInt(100 + index); old.budget.executionKey = gasExecutionKey(97, old.op);
      await legacy(old); assert.equal(await apply(old), 1);
    }
    clock += 599;
    assert.deepEqual(await service().sponsor({ userOperation: r.op }, OWNER), signed);
    assert.equal((await query('select user_op_hash from paymaster_sponsorships where sender=$1', [sender])).rows.length, 4);
  } finally { await clean([sender]); }
});

test('#114 concurrent renewal and release cannot exceed count or cost caps; release rollback leaves no usage evidence', async () => {
  const sender = account();
  try {
    const old = exit(sender); await legacy(old);
    await assert.rejects(withTransaction(async db => {
      await db.query("select pg_advisory_xact_lock(hashtextextended('paymaster_account:97:'||$1::text,0))", [sender]);
      const now = Math.floor(Date.now() / 1000);
      assert.equal(await applyExpiredExitProofs(db, 97, sender, [{ facts: facts(old), blockNumber: '100', blockHash: keccak256(toHex('finalized')),
        blockTimestamp: old.validUntil + 1, checkedAt: now, operator: 'test114', reference: 'rollback' }]), 1);
      throw new Error('injected rollback');
    }), /injected rollback/);
    const day = new Date().toISOString().slice(0, 10);
    assert.deepEqual(await unusedExitUsage(query, 97, sender, day), { count: 0n, gas: 15n, wei: 30n }, 'rollback retains the original outstanding exposure');
    assert.deepEqual((await Promise.all([apply(old), apply(old)])).sort(), [0, 1]);
    const attempts = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => {
      const r = exit(sender); r.op.nonce = BigInt(index + 1); r.budget.executionKey = gasExecutionKey(97, r.op);
      r.config.siteDailyGas = 300n;
      return reserveSponsorship(r);
    }));
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter(result => result.status === 'rejected' && denied('PAYMASTER_EXIT_AUTHORIZATION_PENDING')(result.reason)).length, 9);
    assert.deepEqual(await unusedExitUsage(query, 97, sender, day), { count: 1n, gas: 30n, wei: 60n });
    assert.equal((await query('select user_op_hash from paymaster_sponsorships where sender=$1', [sender])).rows.length, 2);
  } finally { await clean([sender]); }
});

test('#114 all exit purposes reserve outstanding exposure, so non-yield exits cannot bypass 10% with concurrent signatures', async () => {
  const sender = account();
  try {
    const attempts = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => {
      const r = exit(sender);
      // Canonical non-yield Kernel operation; purpose is trusted internal context.
      r.op.callData = operation({ sender }).callData;
      r.op.nonce = BigInt(index); r.budget.executionKey = gasExecutionKey(97, r.op); r.config.siteDailyGas = 300n;
      return reserveSponsorship(r);
    }));
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 2);
    assert.equal(attempts.filter(result => result.status === 'rejected' && denied('PAYMASTER_EXIT_UNUSED_BUDGET_EXCEEDED')(result.reason)).length, 8);
    assert.deepEqual(await unusedExitUsage(query, 97, sender, new Date().toISOString().slice(0, 10)), { count: 0n, gas: 30n, wei: 60n });
  } finally { await clean([sender]); }
});

test('#114 confirmed or reverted non-yield exits with a consumed nonce free exposure even while sponsorship state awaits reconciliation', async () => {
  for (const state of ['confirmed', 'failed'] as const) {
    const sender = account();
    try {
      const old = exit(sender); old.op.callData = operation({ sender }).callData;
      old.budget.executionKey = gasExecutionKey(97, old.op); old.config.siteDailyGas = 150n;
      await reserveSponsorship(old);
      await settleGasBudget(old.budget.executionKey, state);
      assert.equal((await query<{ state: string }>('select state from paymaster_sponsorships where user_op_hash=$1', [old.hash])).rows[0]?.state, 'reserved');
      const next = exit(sender); next.op.callData = old.op.callData; next.op.nonce = 1n;
      next.budget.executionKey = gasExecutionKey(97, next.op); next.config.siteDailyGas = 150n;
      await reserveSponsorship(next);
      assert.deepEqual(await unusedExitUsage(query, 97, sender, new Date().toISOString().slice(0, 10)), { count: 0n, gas: 15n, wei: 30n });
    } finally { await clean([sender]); }
  }
});

test('#114 quota DB lock timeout returns no authorization and rolls back both reservations', async () => {
  const sender = account(), blocker = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await blocker.connect();
  try {
    const old = exit(sender); await legacy(old); assert.equal(await apply(old), 1);
    const next = exit(sender); next.op.nonce = 1n; next.budget.executionKey = gasExecutionKey(97, next.op); next.config.timeoutMs = 25;
    await blocker.query('begin'); await blocker.query('lock table yield_runtime_state in access exclusive mode');
    await assert.rejects(reserveSponsorship(next), error => error instanceof AppError && error.code === 'PAYMASTER_STORAGE_UNAVAILABLE' && !error.message.includes('postgres'));
    assert.equal((await query('select user_op_hash from paymaster_sponsorships where user_op_hash=$1', [next.hash])).rows.length, 0);
    assert.equal((await query('select execution_key from gas_budget_reservations where execution_key=$1', [next.budget.executionKey])).rows.length, 0);
    await blocker.query('rollback');
    await reserveSponsorship(next);
  } finally { await blocker.query('rollback'); await blocker.end(); await clean([sender]); }
});

test('#114 legacy releases without utcDay count today and later status changes never refund unused costs', async () => {
  const sender = account();
  try {
    const old = exit(sender); await legacy(old);
    await writeYieldState(`release-${old.hash.slice(2)}`, { reason: 'expired_finalized_nonce_unchanged', evidence: [{ facts: facts(old) }] });
    await query("update gas_budget_reservations set state='failed',updated_at=clock_timestamp() where execution_key=$1", [old.budget.executionKey]);
    for (const state of ['expired', 'confirmed', 'failed']) {
      await query('update paymaster_sponsorships set state=$2,updated_at=clock_timestamp() where user_op_hash=$1', [old.hash, state]);
      assert.deepEqual(await unusedExitUsage(query, 97, sender, new Date().toISOString().slice(0, 10)), { count: 1n, gas: 15n, wei: 30n });
      const next = exit(sender); next.config.siteDailyGas = 299n;
      await assert.rejects(reserveSponsorship(next), denied('PAYMASTER_EXIT_UNUSED_BUDGET_EXCEEDED'));
    }
  } finally { await clean([sender]); }
});

/**
 * 2026-11-26, portfolio 50 (a fund account that was sold out and cashed out, then got a DCA plan). The owner's full
 * cash-out to the wallet is an exit: its reservation stays `reserved` (nobody reconciles a public UserOp), and the
 * sponsor's own search for its UserOperationEvent only covers the last 1,024 blocks (under 8 minutes). A DCA period
 * redemption 22 minutes later was refused with PAYMASTER_EXIT_AUTHORIZATION_PENDING, and would have been forever: the
 * nonce had moved, so "expired with its nonce untouched" could never be shown either.
 */
test('2026-11-26 plan 9: a cash-out whose nonce is used up no longer holds the exit slot — a DCA period redemption is sponsored, on a fund account and on a My mix', async () => {
  const { encodeCallDataEpV07 } = await import('@zerodev/sdk');
  const { erc20Abi } = await import('viem');
  const { dcaVaults } = await import('../src/dca-calls.js');
  const vault = dcaVaults().find(v => v.id === 'venus_usdt'); assert.ok(vault);
  // Kernel nonce shapes: the owner's root validator and a session key (permission) validator are separate nonce keys.
  const ROOT = (BigInt('0x845adb2c711129d4f3966735ed98a9f09fc4ce57') << 80n) | 5n, SESSION = (2n << 240n) | (0xdeadbeefn << 208n) | 0n;
  for (const kind of ['fund', 'mix'] as const) {
    const sender = account();
    // The EntryPoint nonce of the cash-out's key at the finalized block; the finalized block is always before the cash-out's expiry.
    const chain = { rootNonce: ROOT, reads: 0 };
    const server = createServer(async (req, res) => {
      let body = ''; for await (const part of req) body += String(part);
      const rpc: { id: number; method: string } = JSON.parse(body);
      if (rpc.method === 'eth_call') chain.reads++;
      const result = rpc.method === 'eth_chainId' ? '0x61' : rpc.method === 'eth_call' ? encodeAbiParameters([{ type: 'uint256' }], [chain.rootNonce])
        : { number: '0x64', hash: keccak256(toHex('finalized')), timestamp: toHex(Math.floor(Date.now() / 1000) - 3) };
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = server.address(); assert.ok(endpoint && typeof endpoint !== 'string');
    const c = { ...config({ CHAIN_ID: '97', PAYMASTER_SIGNER_PRIVATE_KEY: TEST_SIGNER, RPC_URL: `http://127.0.0.1:${endpoint.port}` }), timeoutMs: 2000 };
    const service = createPaymasterService({ config: c, checkChain: async () => {}, verifyYieldWithdraw: async () => [], expiredExitProofs: (cfg, a, db) => expiredExitProofs(cfg, a, db),
      // A cash-out that takes everything is an exit (readBudgetContext, read from the chain in production).
      readBudgetContext: async () => ({ purpose: 'exit', nativePrice: 1n, priceSource: 'test:plan9' }),
      mixLock: async (_id, work) => work(), strategyV2: null,
      // The account lookup of each kind; every other statement (the exit ledger) goes to the real database.
      query: async (sql, params) => sql.includes('select s.owner') ? { rows: [{ owner: OWNER, user_id: OWNER, mix_id: kind === 'mix' ? '5' : null }] }
        : sql.includes('from mixes m where') ? { rows: [{ id: '5', owner: OWNER, account: sender, triggered_at: null, status: 'active', delete_requested_at: null }] }
        : sql.includes('mix_switch_intents') ? { rows: [] } : sql.includes('select ms.exit_assets') ? { rows: [{ exit_assets: [] }] }
        : sql.includes('from strategy_cash_balances b') ? { rows: [] } : query(sql, params ? [...params] : []) });
    const cashOut = operation({ sender, nonce: ROOT, callData: await encodeCallDataEpV07([{ to: T.contracts.usdt, value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [OWNER as Address, 99n * 10n ** 18n] }) }]) });
    const redemption = (deadline: number) => encodeCallDataEpV07([{ to: T.contracts.executor, value: 0n, data: encodeFunctionData({ abi: YIELD_EXECUTOR_ABI, functionName: 'executeWithdraw',
      args: [sender, vault.marketId, 10n ** 9n, 1n, BigInt(deadline)] }) }]);
    const state = async () => (await query<{ purpose: string; state: string }>('select purpose,state from gas_budget_reservations where account=$1 order by created_at,execution_key', [sender])).rows.map(r => `${r.purpose}:${r.state}`);
    try {
      await service.sponsor({ userOperation: cashOut }, OWNER);
      assert.deepEqual(await state(), ['exit:reserved'], `${kind}: the cash-out holds the exit slot`);
      // Not mined yet (its nonce is still the account's next one) and not expired: the slot is rightly held, and the refusal says by what.
      const first = operation({ sender, nonce: SESSION, callData: await redemption(Math.floor(Date.now() / 1000) + 900) });
      const held = await service.sponsor({ userOperation: first }, OWNER).then(() => null, (e: unknown) => e);
      assert.ok(denied('PAYMASTER_EXIT_AUTHORIZATION_PENDING')(held), `${kind}: ${String(held)}`);
      assert.match(((held as AppError).cause as Error).message, /^exit: an earlier exit authorization of this account is still outstanding \(reserved, issued \d+ s ago\)$/);
      assert.ok(chain.reads > 0, 'the finalized nonce was read');
      // Mined: the key's nonce moved past the cash-out's. That authorization can never execute again, expired or not.
      chain.rootNonce = ROOT + 1n;
      const signed = await service.sponsor({ userOperation: first }, OWNER);
      assert.ok(signed.paymasterData.length > 2, `${kind}: the DCA period redemption is sponsored`);
      assert.deepEqual((await state()).sort(), ['exit:failed', 'exit:reserved'], `${kind}: the cash-out's slot is released, the redemption holds it now`);
      const sponsorships = (await query<{ state: string }>('select state from paymaster_sponsorships where sender=$1 order by created_at', [sender])).rows.map(r => r.state);
      assert.deepEqual(sponsorships.sort(), ['expired', 'reserved']);
      const release = (await query<{ value: { reason: string; evidence: { consumedNonce?: string; operator: string }[] } }>(
        `select value from yield_runtime_state where kind='release' and value->'evidence'->0->'facts'->>'account'=$1`, [sender])).rows;
      assert.equal(release.length, 1);
      assert.equal(release[0]?.value.reason, 'finalized_nonce_consumed');
      assert.deepEqual(release[0]?.value.evidence.map(e => [e.consumedNonce, e.operator]), [[(ROOT + 1n).toString(), 'automatic']]);
      // A used-up nonce is not an unused signature: it does not count toward the three unused exits a day.
      assert.equal((await unusedExitUsage(query, 97, sender, new Date().toISOString().slice(0, 10))).count, 0n);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); await clean([sender]); }
  }
});
