import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { bytesToHex, concatHex, keccak256, toHex } from 'viem';
import { closePool, query, withTransaction } from '../src/db.js';
import { createPaymasterService, gasExecutionKey, reserveSponsorship, reserveGasBudget } from '../src/paymaster.js';
import type { PaymasterDeps, Reservation } from '../src/paymaster.js';
import { loadPaymasterConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { config as sponsorConfig, operation, OWNER, REGISTRY, kernelCall } from './fixtures/paymaster.js';
import { encodeFunctionData, parseAbi } from 'viem';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
import { YIELD_EXECUTOR_ABI } from '../src/yield-abi.js';
import { EXECUTOR_ABI } from '../src/chain.js';

after(closePool);

function retryFixture(overrides: PaymasterDeps = {}) {
  const sender = bytesToHex(randomBytes(20));
  const c = sponsorConfig({ PAYMASTER_SIGNER_PRIVATE_KEY: key, CHAIN_ID: '97', RPC_URL: 'http://127.0.0.1:8797' });
  const buy = (amount: bigint) => kernelCall(encodeFunctionData({ abi: EXECUTOR_ABI, functionName: 'executeRebalance',
    args: [sender, [{ tokenIn: T.contracts.usdt, tokenOut: T.assets.WBNB.token, amountIn: amount, amountOutMin: 1n,
      venue: T.contracts.executor, data: '0x' }], BigInt(Math.floor(Date.now() / 1000) + 300)] }), c.executor);
  const op = operation({ sender, callData: buy(1n) });
  const deps: PaymasterDeps = { config: c, retryOrdinaryGas: true,
    query: async () => ({ rows: [{ owner: OWNER, user_id: OWNER }] }), checkChain: async () => {},
    readBudgetContext: async () => ({ purpose: 'ordinary', nativePrice: 60000000000n, priceSource: 'fixture:retry-oracle' }), ...overrides };
  const make = (extra: PaymasterDeps = {}) => createPaymasterService({ ...deps, ...extra });
  const rows = () => query('select * from gas_budget_reservations where chain_id=97 and account=$1 order by execution_key', [sender]);
  return { sender, c, op, make, rows, buy };
}

test('#147 ordinary retry after bundler rejection accepts re-estimated gas and retains both immutable charges', async () => {
  const f = retryFixture();
  try {
    // No broadcast or receipt: the first authorization remains unresolved.
    const first = await f.make().sponsor({ userOperation: f.op }, OWNER);
    const saved = (await f.rows()).rows[0]; assert.ok(saved);
    const changed = { ...f.op, accountGasLimits: concatHex([toHex(100001n, { size: 16 }), toHex(200002n, { size: 16 })]),
      preVerificationGas: 50003n, gasFees: concatHex([toHex(2n, { size: 16 }), toHex(3n, { size: 16 })]) };
    const second = await f.make().sponsor({ userOperation: changed }, OWNER);
    assert.notEqual(second.userOpHash, first.userOpHash);
    assert.deepEqual(await f.make({ readBudgetContext: undefined }).sponsor({ userOperation: changed }, OWNER), second,
      'restart reuses the original attempt price/source without a fresh RPC');
    assert.deepEqual((await f.rows()).rows.find(row => row.execution_key === saved.execution_key), saved);
    const totals = (await query<{ n: string; gas: string; wei: string }>(`select count(*)::text as n,sum(gas_limit)::text as gas,
      sum(max_cost_wei)::text as wei from gas_budget_reservations where chain_id=97 and account=$1`, [f.sender])).rows[0];
    assert.deepEqual(totals, { n: '2', gas: '900006', wei: '2250018' });
    assert.equal((await query('select user_op_hash from paymaster_sponsorships where sender=$1', [f.sender])).rows.length, 2);
  } finally { await query('delete from paymaster_sponsorships where sender=$1', [f.sender]); }
});

test('#147 legacy nonce reservation remains charged and permits two new gas estimates, then refuses a fourth attempt', async () => {
  const f = retryFixture();
  try {
    const legacy = await f.make({ retryOrdinaryGas: false }).sponsor({ userOperation: f.op }, OWNER);
    const old = (await f.rows()).rows[0]; assert.ok(old);
    assert.deepEqual(await f.make().sponsor({ userOperation: f.op }, OWNER), legacy);
    assert.equal((await f.rows()).rows.length, 1, 'an identical legacy retry must not add a charge');
    for (const delta of [1n, 2n]) await f.make().sponsor({ userOperation: { ...f.op, preVerificationGas: f.op.preVerificationGas + delta } }, OWNER);
    await assert.rejects(f.make().sponsor({ userOperation: { ...f.op, preVerificationGas: f.op.preVerificationGas + 3n } }, OWNER),
      e => e instanceof AppError && e.code === 'PAYMASTER_GAS_RETRY_LIMIT');
    assert.equal((await f.rows()).rows.length, 3);
    assert.deepEqual((await f.rows()).rows.find(row => row.execution_key === old.execution_key), old);
  } finally { await query('delete from paymaster_sponsorships where sender=$1', [f.sender]); }
});

test('#147 concurrent estimates share a durable three-attempt nonce limit across calldata, states and service restarts', async () => {
  const f = retryFixture();
  try {
    const estimates = Array.from({ length: 10 }, (_, i) => ({ ...f.op, preVerificationGas: f.op.preVerificationGas + BigInt(i),
      callData: f.buy(BigInt(i + 1)) }));
    const outcomes = await Promise.allSettled(estimates.map(op => f.make().sponsor({ userOperation: op }, OWNER)));
    assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 3);
    assert.equal(outcomes.filter(r => r.status === 'rejected' && r.reason instanceof AppError && r.reason.code === 'PAYMASTER_GAS_RETRY_LIMIT').length, 7);
    const index = outcomes.findIndex(r => r.status === 'fulfilled'), accepted = outcomes[index]; assert.ok(accepted?.status === 'fulfilled');
    assert.deepEqual(await f.make().sponsor({ userOperation: estimates[index] }, OWNER), accepted.value, 'exact retry still works at the cap');
    await query("update gas_budget_reservations set state='failed',updated_at=clock_timestamp() where account=$1", [f.sender]);
    await query("update paymaster_sponsorships set state='failed',created_at=created_at-interval '1 day',updated_at=clock_timestamp() where sender=$1", [f.sender]);
    await assert.rejects(f.make().sponsor({ userOperation: { ...f.op, preVerificationGas: 60000n } }, OWNER),
      e => e instanceof AppError && e.code === 'PAYMASTER_GAS_RETRY_LIMIT');
    assert.equal((await f.rows()).rows.length, 3);
  } finally { await query('delete from paymaster_sponsorships where sender=$1', [f.sender]); }
});

test('#147 expired signatures cannot bypass the nonce attempt limit by keeping the gas estimate unchanged', async () => {
  let clock = Math.floor(Date.now() / 1000);
  const f = retryFixture({ now: () => clock });
  try {
    let prior: string | undefined;
    for (let i = 0; i < 3; i++) {
      const result = await f.make().sponsor({ userOperation: f.op }, OWNER);
      assert.notEqual(result.userOpHash, prior);
      assert.deepEqual(await f.make().sponsor({ userOperation: f.op }, OWNER), result);
      prior = result.userOpHash;
      clock = result.validUntil;
    }
    await assert.rejects(f.make().sponsor({ userOperation: f.op }, OWNER), e => e instanceof AppError && e.code === 'PAYMASTER_GAS_RETRY_LIMIT');
    assert.equal((await f.rows()).rows.length, 1, 'unchanged gas retains its immutable charge');
    assert.equal((await query('select user_op_hash from paymaster_sponsorships where sender=$1', [f.sender])).rows.length, 3);
  } finally { await query('delete from paymaster_sponsorships where sender=$1', [f.sender]); }
});

test('#147 retry charges obey exact shared gas cap, zero and unchanged paymaster quota; rejection is atomic', async () => {
  const before = process.env.ACCOUNT_DAILY_GAS;
  const f = retryFixture(), limited = retryFixture(), zero = retryFixture();
  try {
    process.env.ACCOUNT_DAILY_GAS = '900001';
    await f.make().sponsor({ userOperation: f.op }, OWNER);
    await f.make().sponsor({ userOperation: { ...f.op, preVerificationGas: 50001n } }, OWNER);
    await assert.rejects(f.make().sponsor({ userOperation: { ...f.op, preVerificationGas: 50002n } }, OWNER),
      e => e instanceof AppError && e.code === 'GAS_BUDGET_EXCEEDED');
    assert.equal((await f.rows()).rows.length, 2);
    const service = limited.make({ config: { ...limited.c, accountDailyCount: 1n } });
    await service.sponsor({ userOperation: limited.op }, OWNER);
    await assert.rejects(service.sponsor({ userOperation: { ...limited.op, preVerificationGas: 50001n } }, OWNER), denied);
    assert.equal((await limited.rows()).rows.length, 1);
    process.env.ACCOUNT_DAILY_GAS = '0';
    await assert.rejects(zero.make().sponsor({ userOperation: zero.op }, OWNER), e => e instanceof AppError && e.code === 'GAS_BUDGET_EXCEEDED');
    assert.equal((await zero.rows()).rows.length, 0);
  } finally {
    if (before === undefined) delete process.env.ACCOUNT_DAILY_GAS; else process.env.ACCOUNT_DAILY_GAS = before;
    await query('delete from paymaster_sponsorships where sender=any($1::text[])', [[f.sender, limited.sender, zero.sender]]);
  }
});

test('#147 retry lock timeout, rollback and unknown commit never authorize or erase durable attempts', async () => {
  const f = retryFixture(), blocker = new pg.Client({ connectionString: process.env.DATABASE_URL }); await blocker.connect();
  try {
    await f.make().sponsor({ userOperation: f.op }, OWNER);
    const next = { ...f.op, preVerificationGas: 50001n };
    await blocker.query('begin');
    await blocker.query("select pg_advisory_xact_lock(hashtextextended('paymaster_account:97:'||$1::text,0))", [f.sender]);
    await assert.rejects(f.make({ config: { ...f.c, timeoutMs: 10 } }).sponsor({ userOperation: next }, OWNER),
      e => e instanceof AppError && e.code === 'PAYMASTER_STORAGE_UNAVAILABLE');
    await blocker.query('rollback');
    assert.equal((await f.rows()).rows.length, 1);
    await assert.rejects(f.make({ reserve: r => reserveSponsorship(r, fn => withTransaction(async db => {
      await fn(db); throw new Error('SECRET rollback');
    })) }).sponsor({ userOperation: next }, OWNER), e => e instanceof AppError && e.code === 'PAYMASTER_STORAGE_UNAVAILABLE' && !e.message.includes('SECRET'));
    assert.equal((await f.rows()).rows.length, 1);
    await assert.rejects(f.make({ reserve: r => reserveSponsorship(r, async fn => {
      await withTransaction(fn); throw new Error('SECRET unknown commit');
    }) }).sponsor({ userOperation: next }, OWNER), e => e instanceof AppError && e.code === 'PAYMASTER_STORAGE_UNAVAILABLE' && !e.message.includes('SECRET'));
    assert.equal((await f.rows()).rows.length, 2);
    const recovered = await f.make().sponsor({ userOperation: next }, OWNER);
    assert.deepEqual(await f.make().sponsor({ userOperation: next }, OWNER), recovered);
    assert.equal((await f.rows()).rows.length, 2);
  } finally { await blocker.query('rollback'); await blocker.end(); await query('delete from paymaster_sponsorships where sender=$1', [f.sender]); }
});

test('#97 identical sponsorship retries across seconds and service instances reuse one durable authorization', async () => {
  let clock = Math.floor(Date.now() / 1000);
  const originalClock = clock;
  const sender = bytesToHex(randomBytes(20));
  const op = operation({ sender, callData: kernelCall(encodeFunctionData({ abi: parseAbi(['function enroll(address,uint256,uint16)']), functionName: 'enroll', args: [sender, 1n, 1] }), REGISTRY) });
  const c = { ...sponsorConfig(), accountDailyCount: 2n };
  const make = () => createPaymasterService({ config: c, now: () => clock,
    query: async () => ({ rows: [{ owner: OWNER, user_id: OWNER }] }), checkChain: async () => {},
    readBudgetContext: async () => ({ purpose: 'ordinary', nativePrice: 60000000000n, priceSource: 'fixture:oracle' }),
  });
  const initial = await Promise.all(Array.from({ length: 10 }, () => {
    clock++;
    return make().sponsor({ userOperation: op }, OWNER);
  }));
  const first = initial[0]; assert.ok(first);
  for (const result of initial) assert.deepEqual(result, first);
  try {
    for (let index = 0; index < 61; index++) {
      clock++;
      assert.deepEqual(await make().sponsor({ userOperation: op }, OWNER), first);
    }
    clock++;
    const concurrent = await Promise.all(Array.from({ length: 10 }, () => make().sponsor({ userOperation: op }, OWNER)));
    for (const result of concurrent) assert.deepEqual(result, first);
    assert.equal((await query<{ n: string }>('select count(*)::text as n from paymaster_sponsorships where sender=$1', [sender])).rows[0]?.n, '1');
    clock = first.validUntil;
    const renewed = await make().sponsor({ userOperation: op }, OWNER);
    assert.notEqual(renewed.userOpHash, first.userOpHash);
    assert.equal(renewed.validUntil, clock + 300);
    assert.ok(first.validUntil - originalClock <= 600);
    assert.equal((await query<{ n: string }>('select count(*)::text as n from paymaster_sponsorships where sender=$1', [sender])).rows[0]?.n, '2');
    assert.equal((await query<{ n: string }>('select count(*)::text as n from gas_budget_reservations where execution_key=$1', [gasExecutionKey(c.chainId, op)])).rows[0]?.n, '1');
    await assert.rejects(make().sponsor({ userOperation: { ...op, preVerificationGas: op.preVerificationGas + 1n } }, OWNER), (e: unknown) => e instanceof AppError && e.code === 'GAS_BUDGET_CONFLICT');
    await assert.rejects(make().sponsor({ userOperation: { ...op, nonce: op.nonce + 1n } }, OWNER), (e: unknown) => e instanceof AppError && e.code === 'PAYMASTER_QUOTA_EXCEEDED');
    await query("update paymaster_sponsorships set created_at=created_at-interval '1 day' where sender=$1", [sender]);
    assert.deepEqual(await make().sponsor({ userOperation: op }, OWNER), renewed, 'UTC day changes must not reset a live authorization');
    assert.equal((await query<{ n: string }>('select count(*)::text as n from paymaster_sponsorships where sender=$1', [sender])).rows[0]?.n, '2');
  } finally {
    await query('delete from paymaster_sponsorships where sender=$1', [sender]);
  }
});
const key = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const chainId = 991166;
function request(id: number, sender = '0x1000000000000000000000000000000000000005'): Reservation {
  const config = loadPaymasterConfig({ PAYMASTER_SIGNER_PRIVATE_KEY: key, PAYMASTER_ADDRESS: '0x1000000000000000000000000000000000000001',
    CHAIN_ID: '1337', RPC_URL: 'http://127.0.0.1:8557', EXECUTOR_ADDRESS: '0x1000000000000000000000000000000000000002', REGISTRY_ADDRESS: '0x1000000000000000000000000000000000000003' });
  assert.ok(config);
  assert.match(sender, /^0x[0-9a-f]{40}$/);
  return { hash: keccak256(concatHex([toHex(id, { size: 32 }),sender as `0x${string}`])), config: { ...config, chainId, verificationGasLimit: 3n, postOpGasLimit: 4n },
    op: { sender: sender as `0x${string}`, nonce: BigInt(id), initCode: '0x', callData: '0x', accountGasLimits: concatHex([toHex(1n, { size: 16 }), toHex(2n, { size: 16 })]),
      preVerificationGas: 5n, gasFees: concatHex([toHex(1n, { size: 16 }), toHex(2n, { size: 16 })]), paymasterAndData: '0x', signature: '0x' },
    verificationGas: 1n, callGas: 2n, maxFee: 2n, gasLimit: 15n, maxCostWei: 30n, validUntil: Math.floor(Date.now() / 1000) + 300,
    budget: { executionKey: `test:paymaster:${id}:${sender}`, chainId, account: sender as `0x${string}`, purpose: 'ordinary',
      gasLimit: 15n, maxFeePerGas: 2n, nativePrice: 60000000000n, priceSource: 'test:planning-oracle' } };
}
const denied = (error: unknown) => error instanceof AppError && error.code === 'PAYMASTER_QUOTA_EXCEEDED';
async function clean() { await query('delete from paymaster_sponsorships where chain_id = $1', [chainId]); }

test('#112 concurrent exit authorizations cannot hoard the site budget; exact retry and consumed exits remain exempt',async()=>{
  const sender=bytesToHex(randomBytes(20)),otherSender=bytesToHex(randomBytes(20));
  function exit(id:number,account=sender){
    const r=request(id,account);r.config={...r.config,chainId:97,executor:T.contracts.executor,registry:T.contracts.registry,accountDailyCount:0n,accountDailyGas:0n};
    r.budget={...r.budget,chainId:97,purpose:'exit'};
    r.op.callData=kernelCall(encodeFunctionData({abi:YIELD_EXECUTOR_ABI,functionName:'executeWithdraw',args:[account,T.yieldMarkets[0].marketId,1n,1n,BigInt(r.validUntil)]}),T.contracts.executor);
    return r;
  }
  const requests=Array.from({length:12},(_,n)=>exit(112000+n));
  try{
    const attempts=await Promise.allSettled(requests.map(r=>reserveSponsorship(r)));
    assert.equal(attempts.filter(a=>a.status==='fulfilled').length,1);
    const winner=requests[attempts.findIndex(a=>a.status==='fulfilled')];assert.ok(winner);
    await reserveSponsorship(winner);
    assert.equal((await query('select user_op_hash from paymaster_sponsorships where sender=$1',[sender])).rows.length,1);
    await query("update paymaster_sponsorships set created_at=created_at-interval '1 day' where user_op_hash=$1",[winner.hash]);
    const expired=exit(112099);expired.validUntil=winner.validUntil+600;
    await assert.rejects(reserveSponsorship({...expired,now:()=>winner.validUntil+301}),error=>error instanceof AppError&&error.code==='PAYMASTER_EXIT_AUTHORIZATION_PENDING');
    await assert.rejects(reserveSponsorship({...winner,hash:expired.hash,validUntil:expired.validUntil,now:()=>winner.validUntil+301}),error=>error instanceof AppError&&error.code==='PAYMASTER_EXIT_AUTHORIZATION_PENDING','even the same executionKey cannot accumulate renewed site charges');
    // A verified EntryPoint event consumes authorization, without refunding any budget.
    const next=exit(112100);
    await reserveSponsorship({...next,consumedAuthorizations:[{userOpHash:winner.hash,executionKey:winner.budget.executionKey,success:true}]});
    assert.equal((await query('select user_op_hash from paymaster_sponsorships where sender=$1',[sender])).rows.length,2);
    assert.equal((await query('select execution_key from gas_budget_reservations where chain_id=97 and account=$1',[sender])).rows.length,2);
    await reserveSponsorship(exit(112101,otherSender));
  }finally{await query('delete from paymaster_sponsorships where chain_id=97 and sender=any($1::text[])',[[sender,otherSender]]);}
});

test('#112 account authorization lock spans UTC day/paymaster identity while another account proceeds',async()=>{
  const sender=bytesToHex(randomBytes(20)),r=request(112201,sender),other=request(112202,bytesToHex(randomBytes(20)));
  const blocker=new pg.Client({connectionString:process.env.DATABASE_URL});await blocker.connect();
  try{
    await blocker.query('begin');
    await blocker.query("select pg_advisory_xact_lock(hashtextextended('paymaster_account:' || $1::bigint::text || ':' || $2::text,0))",[r.config.chainId,sender]);
    r.config.timeoutMs=10;
    await assert.rejects(reserveSponsorship(r),error=>error instanceof AppError&&error.code==='PAYMASTER_STORAGE_UNAVAILABLE');
    assert.equal((await query('select user_op_hash from paymaster_sponsorships where user_op_hash=$1',[r.hash])).rows.length,0);
    await reserveSponsorship(other);
    await blocker.query('rollback');await reserveSponsorship(r);
  }finally{await blocker.query('rollback');await blocker.end();await clean();}
});

test('#89 sponsorship uses the request chain budget and shares the 97 gas cap with self-funded operations', async () => {
  const r = request(890001, bytesToHex(randomBytes(20)));
  r.hash = keccak256(concatHex([r.hash, r.op.sender]));
  const defaults=loadPaymasterConfig({PAYMASTER_SIGNER_PRIVATE_KEY:key,CHAIN_ID:'97',RPC_URL:'http://127.0.0.1:8562'});assert.ok(defaults);
  r.config = {...defaults,verificationGasLimit:r.config.verificationGasLimit,postOpGasLimit:r.config.postOpGasLimit};
  r.gasLimit = 100_000_000n;
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
    assert.deepEqual(saved.rows[0], { usd: '60.00000000', n: '1' });
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
        for (const k of ['verificationGasLimit','postOpGasLimit','accountDailyCount','accountDailyGas','accountDailyWei','siteDailyGas','siteDailyWei','minDepositWei']) if(r.config[k]!==null) r.config[k] = BigInt(r.config[k]);
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

test('#92 chain 97 default count accepts 60, rejects 61, and explicit wei zero still blocks atomically',async()=>{
  const defaults=loadPaymasterConfig({PAYMASTER_SIGNER_PRIVATE_KEY:key,CHAIN_ID:'97',RPC_URL:'http://127.0.0.1:8562'});assert.ok(defaults);
  const sender=bytesToHex(randomBytes(20));
  const hashes:string[]=[];
  try{
    for(let index=0;index<=60;index++){
      const r=request(920000+index,sender);
      r.hash=keccak256(concatHex([r.hash,sender]));
      r.config={...defaults,verificationGasLimit:r.config.verificationGasLimit,postOpGasLimit:r.config.postOpGasLimit};
      r.budget={...r.budget,chainId:97,executionKey:randomUUID()};
      if(index===60){
        await assert.rejects(reserveSponsorship(r),denied);
        assert.equal((await query('select execution_key from gas_budget_reservations where execution_key=$1',[r.budget.executionKey])).rows.length,0);
      }else{await reserveSponsorship(r);hashes.push(r.hash);}
    }
    const r=request(920100,bytesToHex(randomBytes(20)));
    r.config={...defaults,verificationGasLimit:r.config.verificationGasLimit,postOpGasLimit:r.config.postOpGasLimit,accountDailyWei:0n};
    r.budget={...r.budget,chainId:97,executionKey:randomUUID()};
    await assert.rejects(reserveSponsorship(r),denied);
    assert.equal((await query('select execution_key from gas_budget_reservations where execution_key=$1',[r.budget.executionKey])).rows.length,0);
    const site={...r,config:{...r.config,accountDailyWei:null,siteDailyWei:0n}};
    await assert.rejects(reserveSponsorship(site),denied);
  }finally{await query('delete from paymaster_sponsorships where user_op_hash=any($1::text[])',[hashes]);}
});


test('#112-r2 expired unsigned exit unlocks only with finalized unchanged nonce, retains costs and audits proof',async()=>{
  const {createServer}=await import('node:http');
  const {encodeAbiParameters,getAddress}=await import('viem');
  const reconcile=async()=>{
    const api=await import('../src/paymaster.js');
    return api.reconcileExpiredExitAuthorizations(settings,sender,{operator:'test112',reference:'PR113-r2'});
  };
  const sender=bytesToHex(randomBytes(20)),r=request(112301,sender),now=Math.floor(Date.now()/1000),blockHash=keccak256(toHex(randomUUID()));
  r.hash=keccak256(toHex(randomUUID()));r.config={...r.config,chainId:97,executor:T.contracts.executor};r.validUntil=now+2;r.budget={...r.budget,chainId:97,purpose:'exit'};
  r.op.callData=kernelCall(encodeFunctionData({abi:YIELD_EXECUTOR_ABI,functionName:'executeWithdraw',args:[sender,T.yieldMarkets[0].marketId,1n,1n,BigInt(now+300)]}),T.contracts.executor);
  let timestamp=r.validUntil,nonce=r.op.nonce,mode='ok';
  const server=createServer(async(req,res)=>{
    let text='';for await(const part of req)text+=String(part);const rpc=JSON.parse(text);
    const result=rpc.method==='eth_chainId'?'0x61':rpc.method==='eth_call'?encodeAbiParameters([{type:'uint256'}],[nonce]):{number:'0x64',hash:mode==='reorg'&&rpc.params[0]!=='finalized'?keccak256(toHex('reorg')):blockHash,timestamp:toHex(timestamp)};
    res.setHeader('content-type','application/json');res.end(JSON.stringify(mode==='rpc'?{jsonrpc:'2.0',id:rpc.id,error:{code:-32000,message:'SECRET_RPC'}}:{jsonrpc:'2.0',id:rpc.id,result}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const endpoint=server.address();assert.ok(endpoint&&typeof endpoint!=='string');
  const settings={chainId:97,rpcUrl:`http://127.0.0.1:${endpoint.port}`,timeoutMs:1000};
  try{
    // Original immutable gas ledger can be from a different UTC day than the new signature.
    await query(`insert into gas_budget_reservations(execution_key,chain_id,account,purpose,gas_limit,max_fee_per_gas,native_price_usd,price_source,created_at,state)
      values($1,97,$2,'exit',$3,$4,600,$5,clock_timestamp()-interval '1 day','failed')`,[r.budget.executionKey,sender,r.gasLimit.toString(),r.maxFee.toString(),r.budget.priceSource]);
    await reserveSponsorship(r);await new Promise<void>(resolve=>setTimeout(resolve,3100));
    const unchanged=async()=>assert.equal((await query<{state:string}>('select state from gas_budget_reservations where execution_key=$1',[r.budget.executionKey])).rows[0]?.state,'reserved');
    assert.equal(await reconcile(),0,'validUntil equality is still valid on EntryPoint');await unchanged();
    timestamp++;nonce++;assert.equal(await reconcile(),0,'consumed nonce is not proof of an unused signature');await unchanged();nonce--;
    for(const bad of ['rpc','reorg']){mode=bad;await assert.rejects(reconcile());await unchanged();}mode='ok';
    const {readYieldState}=await import('../src/yield-runtime-state.js');
    const {expiredExitProofs,applyExpiredExitProofs}=await import('../src/paymaster-exit-reconciliation.js');
    for(const unavailable of [true,false]){
      await assert.rejects(expiredExitProofs(settings,sender,async(sql,params)=>{
        if(sql.includes('yield_runtime_state')){
          if(unavailable)throw new Error('SECRET_DB');
          return{rows:[{kind:'fact',value:{nonce:'corrupt'}}]};
        }
        return query(sql,params);
      }));await unchanged();
    }
    const proofs=await expiredExitProofs(settings,sender);
    const apply=(items:typeof proofs)=>withTransaction(async db=>{
      await db.query("select pg_advisory_xact_lock(hashtextextended('paymaster_account:97:'||$1::text,0))",[sender]);
      return applyExpiredExitProofs(db,97,sender,items);
    });
    assert.equal(await apply(proofs.map(p=>({...p,checkedAt:p.checkedAt-61}))),0);await unchanged();
    await assert.rejects(withTransaction(async db=>{
      await db.query("select pg_advisory_xact_lock(hashtextextended('paymaster_account:97:'||$1::text,0))",[sender]);
      await db.query("insert into yield_runtime_state(name,kind,value) values($1,'release','{\"reason\":\"conflicting fixture\"}')",[`release-${r.hash.slice(2)}`]);
      return applyExpiredExitProofs(db,97,sender,proofs);
    }),/^Error: yield state unavailable$/);await unchanged();
    await assert.rejects(withTransaction(async db=>{
      await db.query("select pg_advisory_xact_lock(hashtextextended('paymaster_account:97:'||$1::text,0))",[sender]);
      assert.equal(await applyExpiredExitProofs(db,97,sender,proofs),1);throw new Error('injected rollback');
    }));await unchanged();
    assert.equal(await readYieldState(`release-${r.hash.slice(2)}`),null,'rolled-back release must leave no immutable evidence');
    assert.equal(await reconcile(),1);assert.equal(await reconcile(),0,'idempotent release');mode='rpc';assert.equal(await reconcile(),0,'settled history needs no RPC or new proof');mode='ok';
    assert.equal((await query<{state:string}>('select state from gas_budget_reservations where execution_key=$1',[r.budget.executionKey])).rows[0]?.state,'failed');
    assert.equal((await query<{state:string}>('select state from paymaster_sponsorships where user_op_hash=$1',[r.hash])).rows[0]?.state,'expired');
    assert.equal((await query<{n:string}>('select gas_limit::text as n from gas_budget_reservations where execution_key=$1',[r.budget.executionKey])).rows[0]?.n,r.gasLimit.toString());
    const next={...r,hash:keccak256(toHex(randomUUID())),validUntil:now+300};
    const blocker=new pg.Client({connectionString:process.env.DATABASE_URL});await blocker.connect();
    try{
      const day=(await query<{day:string}>("select to_char(utc_day,'YYYY-MM-DD') as day from gas_budget_reservations where execution_key=$1",[r.budget.executionKey])).rows[0]?.day;assert.ok(day);
      await blocker.query('begin');await blocker.query("select pg_advisory_xact_lock(hashtextextended('gas_budget_reservations:'||$1::bigint::text||':'||$2::text||':'||$3::text,0))",[97,sender,day]);
      await assert.rejects(reserveSponsorship({...next,config:{...next.config,timeoutMs:10}}),e=>e instanceof AppError&&e.code==='PAYMASTER_STORAGE_UNAVAILABLE');
      await blocker.query('rollback');await reserveSponsorship(next);
    }finally{await blocker.query('rollback');await blocker.end();}
    assert.equal((await query<{state:string}>('select state from gas_budget_reservations where execution_key=$1',[r.budget.executionKey])).rows[0]?.state,'reserved','same execution key must acquire a fresh lock');
    const changed={...r,hash:keccak256(toHex(randomUUID())),validUntil:now+301};await assert.rejects(reserveSponsorship(changed),e=>e instanceof AppError&&e.code==='PAYMASTER_EXIT_AUTHORIZATION_PENDING');
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await query('delete from paymaster_sponsorships where sender=$1',[sender]);}
});

test('#112-r2 manual command binds a legacy original hash, rejects forged nonce and releases with an audit reference',async()=>{
  const {createServer}=await import('node:http');
  const {encodeAbiParameters,getAddress}=await import('viem');
  const {unlink,writeFile}=await import('node:fs/promises');
  const {promisify}=await import('node:util');const {execFile}=await import('node:child_process');
  const {readYieldState}=await import('../src/yield-runtime-state.js');
  const {bindExitAuthorizationEvidence,reconcileExpiredExitAuthorizations}=await import('../src/paymaster.js');
  const sender=bytesToHex(randomBytes(20)),now=Math.floor(Date.now()/1000),until=now+2,blockHash=keccak256(toHex(randomUUID()));
  const op=operation({sender,callData:kernelCall(encodeFunctionData({abi:YIELD_EXECUTOR_ABI,functionName:'executeWithdraw',args:[sender,T.yieldMarkets[0].marketId,1n,1n,BigInt(now+300)]}),T.contracts.executor)});
  const server=createServer(async(req,res)=>{
    let text='';for await(const part of req)text+=String(part);const rpc=JSON.parse(text);
    const result=rpc.method==='eth_chainId'?'0x61':rpc.method==='eth_call'?encodeAbiParameters([{type:'uint256'}],[op.nonce]):{number:'0x64',hash:blockHash,timestamp:toHex(until+1)};
    res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const endpoint=server.address();assert.ok(endpoint&&typeof endpoint!=='string');
  const c=sponsorConfig({CHAIN_ID:'97',PAYMASTER_SIGNER_PRIVATE_KEY:key,RPC_URL:`http://127.0.0.1:${endpoint.port}`}),file=`.bun-cache/manual-${randomUUID()}.json`;
  try{
    let legacy:Reservation|undefined;
    // Recreate a legacy signature issued ten minutes earlier, now about to expire.
    const service=createPaymasterService({reserve:async r=>{legacy=r;},config:c,now:()=>until-600,query:async()=>({rows:[{owner:OWNER,user_id:OWNER}]}),checkChain:async()=>{},verifyYieldWithdraw:async()=>[],readBudgetContext:async()=>({purpose:'exit',nativePrice:1n,priceSource:'test:112-manual'})});
    const signed=await service.sponsor({userOperation:op,validUntil:until},OWNER),original={...op,sender:getAddress(op.sender),paymasterAndData:signed.paymasterAndData};
    // A pre-0042 sponsorship has its original ledgers but no runtime metadata.
    assert.ok(legacy);await reserveGasBudget(legacy.budget);
    await query(`insert into paymaster_sponsorships(user_op_hash,chain_id,paymaster,sender,verification_gas_limit,call_gas_limit,
      pre_verification_gas,paymaster_verification_gas_limit,paymaster_post_op_gas_limit,max_fee_per_gas,valid_until)
      values($1,97,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10))`,[signed.userOpHash,c.address.toLowerCase(),sender,
      legacy.verificationGas.toString(),legacy.callGas.toString(),op.preVerificationGas.toString(),c.verificationGasLimit.toString(),
      c.postOpGasLimit.toString(),legacy.maxFee.toString(),until]);
    assert.equal(await readYieldState(`auth-${signed.userOpHash.slice(2)}`),null);
    await new Promise<void>(resolve=>setTimeout(resolve,3100));
    assert.equal(await reconcileExpiredExitAuthorizations(c,sender,{operator:'C3',reference:'PR113'}),0,'missing metadata is never proof');
    await assert.rejects(bindExitAuthorizationEvidence({...original,nonce:op.nonce+1n}));
    await writeFile(file,JSON.stringify({account:sender,operator:'C3',reference:'PR113',userOperations:[original]},(_key,value:unknown)=>typeof value==='bigint'?value.toString():value),{mode:0o600});
    const result=await promisify(execFile)(process.execPath,['--no-env-file','scripts/reconcile-yield-exit.ts','--evidence',file],{timeout:10000,env:{...process.env,CHAIN_ID:'97',RPC_URL:c.rpcUrl}});
    assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').at(-1)??'null'),{released:1});
    const proof=JSON.stringify(await readYieldState(`release-${signed.userOpHash.slice(2)}`));
    assert.match(proof,/PR113/);assert.match(proof,/expired_finalized_nonce_unchanged/);assert.doesNotMatch(proof,/signature|paymasterAndData|private|SECRET/);
    assert.equal(await reconcileExpiredExitAuthorizations(c,sender,{operator:'C3',reference:'PR113'}),0);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await unlink(file).catch(()=>{});await query('delete from paymaster_sponsorships where sender=$1',[sender]);}
});


test('#113 DB runtime write failure rolls back sponsorship and gas reservation before returning authorization',async()=>{
  const sender=bytesToHex(randomBytes(20)),r=request(113001,sender);
  r.hash=keccak256(toHex(randomUUID()));r.config={...r.config,chainId:97,timeoutMs:25};r.budget={...r.budget,chainId:97};
  const blocker=new pg.Client({connectionString:process.env.DATABASE_URL});await blocker.connect();
  try{
    await blocker.query('begin');await blocker.query('lock table yield_runtime_state in access exclusive mode');
    await assert.rejects(reserveSponsorship(r),e=>e instanceof AppError&&e.code==='PAYMASTER_STORAGE_UNAVAILABLE');
    assert.equal((await query('select user_op_hash from paymaster_sponsorships where user_op_hash=$1',[r.hash])).rows.length,0);
    assert.equal((await query('select execution_key from gas_budget_reservations where execution_key=$1',[r.budget.executionKey])).rows.length,0);
    await blocker.query('rollback');
    const {readYieldState}=await import('../src/yield-runtime-state.js');
    await assert.rejects(reserveSponsorship(r,fn=>withTransaction(async db=>{
      await fn(db);throw new Error('injected rollback after fact');
    })),e=>e instanceof AppError&&e.code==='PAYMASTER_STORAGE_UNAVAILABLE');
    assert.equal(await readYieldState(`auth-${r.hash.slice(2)}`),null);
    assert.equal((await query('select user_op_hash from paymaster_sponsorships where user_op_hash=$1',[r.hash])).rows.length,0);
    assert.equal((await query('select execution_key from gas_budget_reservations where execution_key=$1',[r.budget.executionKey])).rows.length,0);
    await reserveSponsorship(r);
    assert.ok(await readYieldState(`auth-${r.hash.slice(2)}`));
  }finally{await blocker.query('rollback');await blocker.end();await query('delete from paymaster_sponsorships where sender=$1',[sender]);}
});
