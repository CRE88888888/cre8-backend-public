import { randomUUID } from 'node:crypto';
import { signedMixRegistration } from './fixtures/mix-registration.js';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createPublicClient, custom, encodeAbiParameters, encodeEventTopics, erc20Abi, encodeFunctionData, toHex, zeroHash } from 'viem';
import { closePool, getPool } from '../src/db.js';
import { createMixService } from '../src/mixes.js';
import type { MixServiceDeps } from '../src/mixes.js';
import { createMixPreview } from '../src/mix-preview.js';
import { mixOwnerCalls } from '../src/mix-approval.js';
import { validateAssetConfig } from '../src/strategy-execution.js';
import { emptyModel } from '../src/model-returns/calculation.js';
import { REGISTRY_ABI } from '../src/registry-abi.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
import { mixRuntimeFixture, mixClock } from './fixtures/mix.js';
import { createServer } from '../src/server.js';
import { UnauthorizedError } from '../src/errors.js';
import { RequestRateLimiter, MemoryRateLimitStore } from '../src/ratelimit.js';
import { loadRateLimitConfig } from '../src/config.js';
import { syncMixAccountFlows, syncMixEnrollmentFlows } from '../src/mix-flows.js';
import { loadMixRuntime, decideMixTick, prepareMixTick, recordMixSwitchResidual, mixSwitchExitsPending } from '../src/mix-runtime.js';
import { recordMixExitFailure, MIX_EXIT_MAX_RETRIES } from '../src/mix-runtime.js';
import { claimDuePortfolios } from '../src/scheduler.js';
import { RateLimitError } from '../src/ratelimit.js';
import { recordMixExecution } from '../src/mix-store.js';
import { mixBusy } from '../src/mix-store.js';
import { detectAlerts, resolveAlerts } from '../src/alerts.js';
import { WAD } from './fixtures/mix.js';
import { createFaucetService } from '../src/faucet.js';
import { loadFaucetConfig } from '../src/config.js';
import { listPortfolios, requireOwnedPortfolio } from '../src/portfolios.js';
import { consentCalls, strategyMarkets } from '../src/strategy-earn.js';
const owner = T.roles.keeper;
after(closePool);

async function fixture(work: (service: ReturnType<typeof createMixService>, db: import('pg').PoolClient, deps: MixServiceDeps) => Promise<void>) {
  const db = await getPool().connect();
  await db.query('begin');
  let block = 1n;
  const query: MixServiceDeps['query'] = (sql, params) => db.query(sql, params ? [...params] : []);
  const deps: MixServiceDeps = { query, transaction: fn => fn(db), lock: async (_id, fn) => fn(), chainId: () => 97, now: () => new Date(),
    creationLock: async (_id, work) => work(), maxAssets: async () => 128, syncFlows: async () => {}, anchor: async () => ({ hash: zeroHash, at: mixClock }),
    context: async () => ({ nonce: 0n, fromBlock: 1n }), findEnrollment: async () => ({ kind: 'absent' }),
    register: async (wallet, name, allocation, requestId) => {
      if (requestId) {
        const saved = (await db.query<{ strategy_id: string | null }>('select strategy_id from mix_creation_requests where id=$1', [requestId])).rows[0];
        if (saved?.strategy_id) return Number(saved.strategy_id);
      }
      const r = (await db.query<{ id: string }>(`insert into strategies(provider,name,is_public,is_personal_mix) values($1,$2,false,true) returning id`, [wallet, name])).rows[0];
      assert.ok(r);
      await db.query('update strategies set onchain_id=$1 where id=$1', [r.id]);
      const execution = validateAssetConfig(undefined, allocation, 97);
      await db.query(`insert into strategy_versions(strategy_id,version,allocation,schedule,active_at,execution_schema_version,execution,execution_chain_id,config_hash)
        values($1,1,$2,'{"kind":"funding"}','2026-01-01Z',2,$3,97,$4)`, [r.id, JSON.stringify(allocation), JSON.stringify(execution), zeroHash]);
      if (requestId) {
        const signed = await signedMixRegistration({ nonce: Number(r.id) });
        await db.query('insert into mix_registration_outbox(request_id,chain_id,tx_hash,signed_raw_tx) values($1,97,$2,$3)', [requestId, signed.hash, signed.raw]);
        await db.query("update mix_creation_requests set state='registered',registration_tx_hash=$2,onchain_strategy_id=$3,registration_block_number=1,registration_block_hash=$2,strategy_id=$3 where id=$1", [requestId, signed.hash, r.id]);
      }
      return Number(r.id);
    },
    prepareAccount: async id => ({ account: toHex(BigInt(id), { size: 20 }), accountDeployed: true, expectedVersion: 1,
      configHash: zeroHash, activeAt: '2026-01-01T00:00:00Z', performanceFeeBps: 500, terms: 'fixture', termsHash: zeroHash, signingMode: 'sudo',
      call: { to: T.contracts.registry, value: '0', data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'enroll', args: [toHex(BigInt(id), { size: 20 }), BigInt(id), 1] }) } }),
    calls: async (m, id, previous) => {
      const s = (await db.query<{ allocation: { assets: { address: `0x${string}`; weightBps: number }[] } }>('select allocation from strategy_versions where strategy_id=$1', [id])).rows[0];
      assert.ok(s);
      return mixOwnerCalls({ account: m.account, registry: T.contracts.registry, executor: T.contracts.executor, onchainId: BigInt(id),
        previousAssets: previous, assets: s.allocation.assets.map(a => a.address), allowances: new Map(s.allocation.assets.map(a => [a.address, 0n])) });
    },
    enroll: async (sid, wallet, options) => {
      const p = (await db.query<{ id: string }>("insert into portfolios(user_id,strategy_id,version,schedule_state) values($1,$2,1,'active') returning id", [wallet, sid])).rows[0]; assert.ok(p);
      const account = toHex(BigInt(sid), { size: 20 });
      await db.query("insert into smart_accounts(portfolio_id,chain_id,address,owner,account_type) values($1,97,$2,$3,'KERNEL')", [p.id, account, wallet]);
      await db.query("insert into session_keys(portfolio_id,key_ref,permissions,expires_at) values($1,$2,'{}','2030-01-01Z')", [p.id, `mix-service-${p.id}`]);
      await options?.afterWrite?.(db, Number(p.id));
      return { id: Number(p.id), userId: wallet, strategyId: sid, strategyName: 'fixture', version: 1, scheduleState: 'active',
        createdAt: mixClock.toISOString(), gas: null, minDepositUsdtWei: '50000000000000000000',
        smartAccounts: [{ chainId: 97, address: account, owner: wallet, accountType: 'KERNEL' }] };
    },
    proof: async (_m, _intent, hash) => ({ txHash: hash, userOpHash: hash, logIndex: 0, blockNumber: block++, blockHash: hash,
      at: new Date('2026-01-02Z'), cashRaw: '0', nonce: 0n }),
    plan: async () => mixRuntimeFixture().plan, strategyConsent: async () => [], strategyV2: () => null,
    preview: createMixPreview({ chainId: 97, model: async () => emptyModel(), gasPrice: async () => 1n }) };
  try { await work(createMixService(deps), db, deps); }
  finally { await db.query('rollback'); db.release(); }
}

test('mix service creates private hold settings; initial confirmation, sharing, Import, switch and restart preserve stable identity', async () => {
  await fixture(async (service, db, deps) => {
    const first = await service.create({ assets: [{ assetId: T.assets.NVDAB.token, weightBps: 10000 }],
      rebalance: { frequency: 'weekly', startDate: '2026-10-01' }, exit: { takeProfitBps: 3000, stopLossBps: 2000 } }, owner, randomUUID());
    assert.equal(first.name, 'NVDAB'); assert.equal(first.signingMode, 'sudo');
    assert.equal((await service.get(first.mixId, owner)).status, 'awaiting_enrollment');
    await assert.rejects(service.get(first.mixId, T.roles.operator), /找不到/);
    const publicResult = await service.shared(first.shareCode);
    for (const forbidden of ['account','owner','portfolioId','currentValueRaw','netInputRaw','shareCode']) assert.equal(forbidden in publicResult, false);
    const copied = await service.create({ importCode: first.shareCode }, owner, randomUUID());
    const imported = await service.get(copied.mixId, owner);
    assert.equal(imported.rebalance.startDate, deps.now().toISOString().slice(0, 10));
    assert.equal(imported.rebalance.frequency, 'weekly');
    assert.deepEqual(imported.exit, { takeProfitBps: 3000, stopLossBps: 2000 });
    assert.notEqual(first.account, copied.account); assert.equal((await service.shared(first.shareCode)).copies, 1);
    await service.patch(copied.mixId, owner, { name: 'Copy only', rebalance: { frequency: 'quarterly', startDate: '2026-11-21' } }).catch(() => assert.fail('metadata patch should not be blocked by initial pending enrollment'));
    const proof = toHex(1n, { size: 32 });
    const joined = await service.confirm(first.mixId, owner, { txHash: proof });
    assert.equal(joined.account, first.account);
    assert.ok(joined.portfolioId);
    const current = await service.get(first.mixId, owner);
    assert.equal(current.status, 'active');
    const changed = await service.patch(first.mixId, owner, { assets: [{ assetId: T.assets.TSLAB.token, weightBps: 10000 }] });
    assert.ok('calls' in changed);
    await service.confirm(first.mixId, owner, { txHash: toHex(2n, { size: 32 }) });
    const after = await service.get(first.mixId, owner);
    assert.equal(after.account, first.account); assert.notEqual(after.portfolioId, joined.portfolioId);
    assert.deepEqual(after.assets, [{ assetId: T.assets.TSLAB.token, weightBps: 10000 }]);
    assert.equal(after.selling.length, 1);
    assert.deepEqual((await service.shared(first.shareCode)).assets, after.assets);
    const faucet = createFaucetService({ config: loadFaucetConfig({ CHAIN_ID: '97' }),
      query: (sql, params) => db.query(sql, params ? [...params] : []),
      find: async () => ({ claimId: '1', state: 'confirmed', amountWei: WAD.toString(), txHash: proof, replayed: true }) });
    assert.equal((await faucet.claim({ account: first.account }, owner)).replayed, true);
    await assert.rejects(requireOwnedPortfolio(joined.portfolioId, owner, { query: (sql, params) => db.query(sql, params ? [...params] : []), chainId: 97 }), /沒有|no smart account/);
    const portfolios = await listPortfolios(owner, { query: (sql, params) => db.query(sql, params ? [...params] : []),
      getAccountGasBalance: async () => 0n, getGasPriceWei: async () => 1n, minSessionGasWei: 0n });
    assert.equal(portfolios.filter(p => p.smartAccounts.some(a => a.address === first.account)).length, 1);
    assert.equal((await service.list(owner)).mixes.length, 2);
    await db.query("update mixes set status='exited',triggered_at=clock_timestamp(),triggered_return_bps=3000 where id=$1", [first.mixId]);
    assert.equal((await service.restart(first.mixId, owner)).status, 'active');
    assert.equal((await db.query('select * from yield_consents where portfolio_id in (select portfolio_id from mix_portfolio_history where mix_id=any($1::bigint[]))', [[first.mixId, copied.mixId]])).rows.length, 0);
    await db.query('set constraints all immediate');
  });
});

test('mix Import rejects missing/deleted codes; failed RPC cannot confirm a switch or expose private upstream text', async () => {
  await fixture(async (service, db, deps) => {
    await assert.rejects(service.create({ importCode: 'unknown_code_with_22_chars' }, owner, randomUUID()), /找不到/);
    const first = await service.create({ assets: [{ assetId: T.assets.NVDAB.token, weightBps: 10000 }] }, owner, randomUUID());
    await db.query('update mixes set deleted_at=clock_timestamp() where id=$1', [first.mixId]);
    await assert.rejects(service.shared(first.shareCode), /找不到/);
    await assert.rejects(service.create({ importCode: first.shareCode }, owner, randomUUID()), /找不到/);
    await db.query('update mixes set deleted_at=null where id=$1', [first.mixId]);
    await assert.rejects(service.create({ importCode: first.shareCode, rebalance: null }, owner, randomUUID()), { code: 'INVALID_MIX_FREQUENCY' });
    const failing = createMixService({ ...deps, proof: async () => { throw new Error('secret RPC credential'); } });
    await assert.rejects(failing.confirm(first.mixId, owner, { txHash: zeroHash }), e => e instanceof Error && /目前無法確認/.test(e.message) && !e.message.includes('secret'));
    assert.equal((await db.query('select * from mix_portfolio_history where mix_id=$1', [first.mixId])).rows.length, 0);
    assert.equal((await service.get(first.mixId, owner)).pendingChange, true);
  });
});

test('mix HTTP authenticates before parsing, routes owner operations and existing enrollment endpoints, and permits public safe sharing', async () => {
  await fixture(async service => {
    const server = createServer({ mixes: service,
      rateLimiter: new RequestRateLimiter(loadRateLimitConfig({ RATE_LIMIT_PLAN_PER_MINUTE: '100' }), new MemoryRateLimitStore()),
      auth: { authenticate: async header => { if (header !== 'Bearer fixture') throw new UnauthorizedError(); return owner; },
        issueNonce: () => { throw new Error('unused'); }, login: async () => { throw new Error('unused'); }, logout: async () => {} } });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const request = (path: string, method = 'GET', body?: unknown, loggedIn = true) => fetch(base + path, { method,
      headers: { ...(loggedIn ? { authorization: 'Bearer fixture' } : {}), 'content-type': 'application/json', 'idempotency-key': randomUUID(), origin: 'http://localhost:5173' },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    try {
      assert.equal((await request('/me/mixes', 'POST', '{broken', false)).status, 401);
      assert.equal((await request('/me/mixes', 'DELETE')).status, 405);
      assert.equal((await request('/me/mixes/0')).status, 400);
      const made = await request('/me/mixes', 'POST', { assets: [{ assetId: T.assets.NVDAB.token, weightBps: 10000 }] });
      assert.equal(made.status, 201);
      const result: unknown = await made.json();
      assert.ok(result && typeof result === 'object' && 'mixId' in result && typeof result.mixId === 'number' && 'shareCode' in result && typeof result.shareCode === 'string');
      const id = result.mixId;
      const update = await request(`/me/mixes/${id}`, 'PATCH', { name: 'My mix' });
      assert.equal(update.status, 200); assert.equal(update.headers.get('access-control-allow-origin'), 'http://localhost:5173');
      const preflight = await request(`/me/mixes/${id}`, 'OPTIONS', undefined, false);
      assert.ok(preflight.headers.get('access-control-allow-methods')?.includes('PATCH'));
      assert.equal((await request('/portfolios', 'POST', { mixId: id })).status, 200);
      assert.equal((await request(`/me/mixes/${id}/enrollment-params`, 'POST')).status, 200);
      assert.equal((await request('/portfolios/enrollment-confirm', 'POST', { mixId: id, txHash: toHex(3n, { size: 32 }) })).status, 200);
      assert.equal((await request(`/me/mixes/${id}/confirm`, 'POST', { txHash: toHex(3n, { size: 32 }) })).status, 200);
      assert.equal((await request(`/me/mixes/${id}/restart`, 'POST')).status, 409);
      const shared = await request(`/mixes/shared/${result.shareCode}`, 'GET', undefined, false);
      assert.equal(shared.status, 200); assert.doesNotMatch(await shared.text(), /"(?:owner|account|currentValueRaw|netInputRaw)":/);
      assert.equal((await request('/me/mixes')).status, 200);
      assert.equal((await request(`/me/mixes/${id}/unknown`)).status, 404);
      assert.equal((await request(`/mixes/shared/${result.shareCode}`, 'POST', {}, false)).status, 405);
      const other = await request('/me/mixes', 'POST', { importCode: result.shareCode }); assert.equal(other.status, 201);
      assert.equal((await request('/me/mixes', 'POST', { importCode: result.shareCode })).status, 201);
      assert.equal((await request('/me/mixes', 'POST', { importCode: result.shareCode })).status, 429);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

test('mix tick atomically latches the oracle stop, emits one permanent notification, completes sale and restarts without new principal', async () => {
  await fixture(async (service, db) => {
    const made = await service.create({ assets: [{ assetId: T.assets.NVDAB.token, weightBps: 5000 }, { assetId: T.assets.WBNB.token, weightBps: 5000 }],
      exit: { takeProfitBps: 3000 } }, owner, randomUUID());
    const joined = await service.confirm(made.mixId, owner, { txHash: toHex(4n, { size: 32 }) }); assert.ok(joined.portfolioId);
    await db.query(`insert into mix_cash_flows(mix_id,chain_id,kind,amount_raw,tx_hash,log_index,block_number,block_hash,observed_at,asset,quantity_raw,asset_decimals,price_usd_e8,price_source,priced_at)
      values($1,97,'deposit',$2,$3,1,1,$3,'2026-01-02Z','${T.contracts.usdt}',$2,18,100000000,'numeraire','2026-01-02Z')`, [made.mixId, (100n * WAD).toString(), toHex(4n, { size: 32 })]);
    const due = { personalMix: true, portfolioId: joined.portfolioId, strategyId: made.strategyId, account: made.account,
      accountType: 'KERNEL', intervalSeconds: 60, unsupportedReason: null, nextRunAt: mixClock };
    const find: import('../src/scheduler.js').SchedulerQueryFn = (sql, params) => db.query(sql, params ? [...params] : []);
    const run: import('../src/scheduler.js').WithTransactionFn = work => work({ query: find });
    const state = await loadMixRuntime(due, find, undefined, async () => ({ hash: zeroHash, at: mixClock })); assert.ok(state);
    const { plan } = mixRuntimeFixture();
    const tick = decideMixTick(state, plan, mixClock); assert.equal(tick.trigger, 'take_profit');
    await prepareMixTick(state, tick, due, mixClock, run);
    const latched = await loadMixRuntime(due, find, undefined, async () => ({ hash: zeroHash, at: mixClock })); assert.ok(latched?.triggered);
    for (const holding of plan.snapshot.holdings) holding.amountWei = 0n;
    const completed = decideMixTick(latched, plan, mixClock); assert.equal(completed.complete, true);
    await prepareMixTick(latched, completed, due, mixClock, run);
    assert.equal((await loadMixRuntime(due, find, undefined, async () => ({ hash: zeroHash, at: mixClock })))?.status, 'exited');
    assert.equal((await db.query("select * from user_notifications where portfolio_id=$1 and kind='mix_exit_triggered'", [joined.portfolioId])).rows.length, 1);
    assert.equal((await db.query('select * from mix_cash_flows where mix_id=$1', [made.mixId])).rows.length, 1);
    assert.equal((await service.restart(made.mixId, owner)).status, 'active');
    const restarted = await loadMixRuntime(due, find, undefined, async () => ({ hash: zeroHash, at: mixClock })); assert.ok(restarted);
    assert.equal(decideMixTick(restarted, mixRuntimeFixture().plan, mixClock).trigger, null, 'restart uses the new 130 baseline');
    const detail = await service.get(made.mixId, owner);
    assert.equal(detail.returnBps, '0'); assert.equal(detail.performanceStartedAt, mixClock.toISOString());
    assert.equal(detail.netInputRaw, (100n * WAD).toString(), 'lifetime net input remains separate');
    assert.equal(detail.performanceInputRaw, (130n * WAD).toString());
    await db.query('set constraints all immediate');
  });
});

test('mix list reads only snapshots and busy detail returns the same timestamp without planning', async () => {
  await fixture(async (service, db, deps) => {
    const made = await service.create({ assets: [{ assetId: T.assets.NVDAB.token, weightBps: 10000 }] }, owner, randomUUID());
    const joined = await service.confirm(made.mixId, owner, { txHash: toHex(50n, { size: 32 }) }); assert.ok(joined.portfolioId);
    const latest = await service.get(made.mixId, owner); assert.ok(latest.currentValueRaw); assert.equal(latest.valuedAt, mixClock.toISOString());
    let locks = 0, reads = 0;
    const busy = createMixService({ ...deps, lock: async () => { locks++; throw mixBusy(); }, plan: async () => { reads++; throw new Error('private RPC'); } });
    const list = await busy.list(owner); assert.equal(locks, 0); assert.equal(reads, 0);
    assert.equal(list.mixes[0]?.currentValueRaw, latest.currentValueRaw); assert.equal(list.mixes[0]?.valuedAt, latest.valuedAt);
    const fallback = await busy.get(made.mixId, owner); assert.equal(locks, 1); assert.equal(reads, 0); assert.equal(fallback.valuedAt, latest.valuedAt);
    await service.patch(made.mixId, owner, { assets: [{ assetId: T.assets.TSLAB.token, weightBps: 10000 }] });
    const offline = createMixService({ ...deps, findEnrollment: async () => { throw new Error('private RPC timeout'); },
      plan: async () => { reads++; throw new Error('must use saved valuation'); } });
    assert.equal((await offline.get(made.mixId, owner)).valuedAt, latest.valuedAt, 'pending reconciliation outage still returns the saved detail');
    assert.equal(reads, 0);
    await db.query('delete from mix_valuation_snapshots where mix_id=$1', [made.mixId]);
    assert.equal((await busy.get(made.mixId, owner)).currentValueRaw, null);
    await recordMixExecution((sql, args) => db.query(sql, args ? [...args] : []), joined.portfolioId, 'calendar-batch-test', 'rebalance');
    assert.ok((await db.query('select last_rebalanced_at from mixes where id=$1', [made.mixId])).rows[0]?.last_rebalanced_at instanceof Date);
  });
});

test('backend reconciles a lost App switch response; unsigned timeout/cancel release only prepared intents', async () => {
  await fixture(async (service, db, deps) => {
    const made = await service.create({ assets: [{ assetId: T.assets.NVDAB.token, weightBps: 10000 }] }, owner, randomUUID());
    const joined = await service.confirm(made.mixId, owner, { txHash: toHex(51n, { size: 32 }) }); assert.ok(joined.portfolioId);
    await service.patch(made.mixId, owner, { assets: [{ assetId: T.assets.TSLAB.token, weightBps: 10000 }] });
    const intent = (await db.query('select * from mix_switch_intents where mix_id=$1 and state=\'prepared\'', [made.mixId])).rows[0]; assert.ok(intent);
    const recovering = createMixService({ ...deps, findEnrollment: async (_m, i) => ({ kind: 'confirmed', proof: {
      txHash: toHex(52n, { size: 32 }), userOpHash: toHex(52n, { size: 32 }), blockHash: toHex(52n, { size: 32 }),
      blockNumber: 2n, logIndex: 0, at: new Date('2026-01-03Z'), cashRaw: '0', nonce: BigInt(i.nonce ?? '0') } }) });
    assert.equal(await recovering.reconcilePortfolio(joined.portfolioId), true);
    const current = await service.get(made.mixId, owner); assert.notEqual(current.portfolioId, joined.portfolioId);
    assert.equal(current.pendingChange, false);
    await service.patch(made.mixId, owner, { assets: [{ assetId: T.assets.WBNB.token, weightBps: 10000 }] });
    assert.ok(current.portfolioId);
    assert.equal(await service.reconcilePortfolio(current.portfolioId, true), true);
    const cancelled = (await db.query('select * from mix_switch_intents where mix_id=$1 and state=\'cancelled\'', [made.mixId])).rows[0]; assert.ok(cancelled);
    await db.query(`insert into mix_switch_intents(request_key,mix_id,from_history_id,strategy_id,owner_calls,nonce,enroll_from_block,created_at)
      values($1,$2,$3,$4,$5,0,2,clock_timestamp()-interval '15 minutes')`,
      [`expired-${made.mixId}`, made.mixId, cancelled.from_history_id, cancelled.strategy_id, JSON.stringify(cancelled.owner_calls)]);
    assert.equal(await service.reconcilePortfolio(current.portfolioId), true);
    assert.equal((await db.query('select state from mix_switch_intents where request_key=$1', [`expired-${made.mixId}`])).rows[0]?.state, 'expired');
    await service.patch(made.mixId, owner, { assets: [{ assetId: T.assets.WBNB.token, weightBps: 10000 }] });
    await db.query("update mix_switch_intents set state='submitted',user_op_hash=$2 where mix_id=$1 and state='prepared'", [made.mixId, toHex(53n, { size: 32 })]);
    assert.equal(await service.reconcilePortfolio(current.portfolioId, true), false, 'submitted outcome cannot be cancelled by time or stop');
    const failed = createMixService({ ...deps, findEnrollment: async () => ({ kind: 'failed', code: 'AUTHORIZATION_EXPIRED' }) });
    assert.equal(await failed.reconcilePortfolio(current.portfolioId), true);
    await db.query('set constraints all immediate');
  });
});

test('restart rejects unavailable valuation; persistent exit backoff and alert throttling use the same exact boundaries', async () => {
  await fixture(async (service, db, deps) => {
    const made = await service.create({ assets: [{ assetId: T.assets.NVDAB.token, weightBps: 10000 }] }, owner, randomUUID());
    const joined = await service.confirm(made.mixId, owner, { txHash: toHex(54n, { size: 32 }) }); assert.ok(joined.portfolioId);
    await db.query("update mixes set status='exited',triggered_at=clock_timestamp(),triggered_return_bps=-2000 where id=$1", [made.mixId]);
    const failed = createMixService({ ...deps, plan: async () => { throw new Error('private timeout'); } });
    await assert.rejects(failed.restart(made.mixId, owner), e => e instanceof Error && !e.message.includes('private'));
    assert.equal((await db.query('select status,performance_baseline_raw from mixes where id=$1', [made.mixId])).rows[0]?.status, 'exited');
    await service.restart(made.mixId, owner);
    await db.query('update mixes set triggered_at=$2,triggered_return_bps=-2000 where id=$1', [made.mixId, mixClock]);
    const due = { personalMix: true, portfolioId: joined.portfolioId, strategyId: made.strategyId, account: made.account,
      accountType: 'KERNEL', intervalSeconds: 60, unsupportedReason: null, nextRunAt: mixClock };
    const find: import('../src/scheduler.js').SchedulerQueryFn = (sql, args) => db.query(sql, args ? [...args] : []);
    for (let i = 0; i < MIX_EXIT_MAX_RETRIES; i++) {
      const state = await loadMixRuntime(due, find, undefined, async () => ({ hash: zeroHash, at: mixClock })); assert.ok(state);
      await recordMixExitFailure(state, due, mixClock, work => work({ query: find }));
    }
    const final = await loadMixRuntime(due, find, undefined, async () => ({ hash: zeroHash, at: mixClock })); assert.equal(final?.retries, MIX_EXIT_MAX_RETRIES);
    assert.equal((await db.query('select schedule_state from portfolios where id=$1', [joined.portfolioId])).rows[0]?.schedule_state, 'paused');
    await db.query("update portfolios set next_run_at='1970-01-01Z' where id=$1", [joined.portfolioId]);
    const claim = (now: Date) => claimDuePortfolios(1, now, { chainId: 97, advance: false, withTransaction: work => work({
      query: (sql, args) => find(sql.replace('and (p.next_run_at', `and p.id=${joined.portfolioId} and (p.next_run_at`), args),
    }) });
    assert.equal((await claim(new Date(mixClock.getTime() + 299999))).some(p => p.portfolioId === joined.portfolioId), false);
    assert.equal((await claim(new Date(mixClock.getTime() + 300000))).some(p => p.portfolioId === joined.portfolioId), true,
      'a paused exit becomes claimable at the exact cooldown boundary');

    assert.equal((await db.query('select * from scheduler_alerts where portfolio_id=$1', [joined.portfolioId])).rows.length, 1);
    const findings = await detectAlerts(find, { env: { CHAIN_ID: '97' }, readGasPrice: async () => 1n, readNativeBalance: async () => 0n });
    await resolveAlerts(find, findings, mixClock);
    assert.equal((await db.query('select * from scheduler_alerts where portfolio_id=$1 and resolved_at is null', [joined.portfolioId])).rows.length, 1,
      'the normal alert round must preserve a paused mix exit requiring attention');
    assert.equal((await db.query("select * from user_notifications where portfolio_id=$1 and kind='mix_exit_stuck'", [joined.portfolioId])).rows.length, 1);
    let at = mixClock.getTime();
    for (const [index, delay] of [300000, 900000, 3600000, 21600000].entries()) {
      at += delay;
      await recordMixExitFailure({ id: String(made.mixId) }, due, new Date(at), work => work({ query: find }));
      const state = await loadMixRuntime(due, find, undefined, async () => ({ hash: zeroHash, at: mixClock })); assert.ok(state);
      assert.equal(state.retries, Math.min(8, 6 + index));
      const nextDelay = [900000, 3600000, 21600000, 21600000][index]; assert.ok(nextDelay);
      assert.equal((await claim(new Date(at + nextDelay - 1))).some(p => p.portfolioId === joined.portfolioId), false);
      assert.equal((await claim(new Date(at + nextDelay))).some(p => p.portfolioId === joined.portfolioId), true);
      assert.equal((await db.query("select * from user_notifications where portfolio_id=$1 and kind='mix_exit_stuck'", [joined.portfolioId])).rows.length, index < 3 ? 1 : 2);
    }
    await recordMixExecution(find, joined.portfolioId, 'recovered-after-backoff', 'rebalance');
    const reset = await loadMixRuntime(due, find, undefined, async () => ({ hash: zeroHash, at: mixClock })); assert.equal(reset?.retries, 0); assert.equal(reset?.lastExitAttempt, null);
  });
});

test('mix cannot plan new buys from missing or unclassified cash accounting', async () => {
  await fixture(async (service, db) => {
    const made = await service.create({ assets: [{ assetId: T.assets.NVDAB.token, weightBps: 10000 }] }, owner, randomUUID());
    const joined = await service.confirm(made.mixId, owner, { txHash: toHex(5n, { size: 32 }) }); assert.ok(joined.portfolioId);
    const due = { personalMix: true, portfolioId: joined.portfolioId, strategyId: made.strategyId, account: made.account,
      accountType: 'KERNEL', intervalSeconds: 60, unsupportedReason: null, nextRunAt: mixClock };
    const find: import('../src/scheduler.js').SchedulerQueryFn = (sql, params) => db.query(sql, params ? [...params] : []);
    const state = await loadMixRuntime(due, find, undefined, async () => ({ hash: zeroHash, at: mixClock })); assert.ok(state);
    const { plan } = mixRuntimeFixture();
    const cash = plan.snapshot.holdings.find(h => h.asset === T.contracts.usdt); assert.ok(cash); cash.amountWei = 100n * WAD;
    const tick = decideMixTick(state, plan, mixClock);
    await assert.rejects(prepareMixTick(state, tick, due, mixClock, work => work({ query: find })), /現金|無法確認/);
    const missingCash: import('../src/scheduler.js').SchedulerQueryFn = (sql, params) => sql.includes('select * from strategy_cash_balances') ? Promise.resolve({ rows: [] }) : find(sql, params);
    await assert.rejects(prepareMixTick(state, tick, due, mixClock, work => work({ query: missingCash })), /現金|無法確認/);
  });
});

test('completed mix exit records every sub-cent residual atomically without reducing principal', async () => {
  await fixture(async (service, db) => {
    const made = await service.create({ assets: [{ assetId: T.assets.NVDAB.token, weightBps: 5000 }, { assetId: T.assets.WBNB.token, weightBps: 5000 }] }, owner, randomUUID());
    const joined = await service.confirm(made.mixId, owner, { txHash: toHex(55n, { size: 32 }) }); assert.ok(joined.portfolioId);
    await db.query('update mixes set triggered_at=$2,triggered_return_bps=-2000 where id=$1', [made.mixId, mixClock]);
    const due = { personalMix: true, portfolioId: joined.portfolioId, strategyId: made.strategyId, account: made.account,
      accountType: 'KERNEL', intervalSeconds: 60, unsupportedReason: null, nextRunAt: mixClock };
    const find: import('../src/scheduler.js').SchedulerQueryFn = (sql, args) => db.query(sql, args ? [...args] : []);
    const state = await loadMixRuntime(due, find, undefined, async () => ({ hash: zeroHash, at: mixClock })); assert.ok(state);
    const { plan } = mixRuntimeFixture();
    for (const h of plan.snapshot.holdings) h.amountWei = h.asset === T.contracts.usdt ? 0n : 4n * 10n ** 15n;
    const tick = decideMixTick(state, plan, mixClock); assert.equal(tick.complete, true);
    await prepareMixTick(state, tick, due, mixClock, work => work({ query: find }), [], { reason: 'below_total_dust', anchor: { hash: zeroHash, at: mixClock } });
    await db.query('set constraints all immediate');
    assert.equal((await loadMixRuntime(due, find, undefined, async () => ({ hash: zeroHash, at: mixClock })))?.status, 'exited');
    const residuals = (await db.query('select value_raw::text,reason from mix_exit_residuals where mix_id=$1', [made.mixId])).rows;
    assert.equal(residuals.length, 2); assert.ok(residuals.every(r => r.reason === 'below_total_dust' && r.value_raw === (4n * 10n ** 15n).toString()));
    assert.equal((await db.query('select * from mix_cash_flows where mix_id=$1', [made.mixId])).rows.length, 0);
  });
});

test('mix performance uses cash flows through the valuation block, even if another reader has scanned a newer block', async () => {
  await fixture(async (service, db) => {
    const made = await service.create({ assets: [{ assetId: T.assets.NVDAB.token, weightBps: 10000 }] }, owner, randomUUID());
    const joined = await service.confirm(made.mixId, owner, { txHash: toHex(6n, { size: 32 }) }); assert.ok(joined.portfolioId);
    for (const [block, amount] of [[2, 100n], [30, 1000n]] as const) await db.query(`insert into mix_cash_flows
      (mix_id,chain_id,kind,amount_raw,tx_hash,log_index,block_number,block_hash,observed_at,asset,quantity_raw,asset_decimals,price_usd_e8,price_source,priced_at)
      values($1,97,'deposit',$2,$3,0,$4,$3,'2026-01-02Z','${T.contracts.usdt}',$2,18,100000000,'numeraire','2026-01-02Z')`, [made.mixId, (amount * WAD).toString(), toHex(BigInt(block), { size: 32 }), block]);
    const detail = await service.get(made.mixId, owner);
    assert.equal(detail.netInputRaw, (100n * WAD).toString());
    assert.equal(detail.returnBps, '3000');
  });
});


test('mix confirmation cannot report success when initial enrollment returns without atomic history', async () => {
  await fixture(async (service, _db, deps) => {
    const made = await service.create({ assets: [{ assetId: T.assets.WBNB.token, weightBps: 10000 }] }, owner, randomUUID());
    const enroll = deps.enroll;
    deps.enroll = async (sid, wallet) => enroll(sid, wallet);
    await assert.rejects(createMixService(deps).confirm(made.mixId, owner, { txHash: toHex(7n, { size: 32 }) }), /目前無法確認/);
  });
});


test('mix principal ledger deduplicates canonical replay, rewinds a reorg and preserves evidence on DB/RPC errors', async () => {
  await fixture(async (service, db) => {
    const made = await service.create({ assets: [{ assetId: T.assets.WBNB.token, weightBps: 10000 }] }, owner, randomUUID());
    const joined = await service.confirm(made.mixId, owner, { txHash: toHex(8n, { size: 32 }) }); assert.ok(joined.portfolioId);
    await db.query('insert into portfolio_scan_cursors(portfolio_id,start_block,last_scanned_block) values($1,1,20)', [joined.portfolioId]);
    const m = { id: String(made.mixId), owner, account: made.account };
    const hash = toHex(16n, { size: 32 }), anchor = toHex(20n, { size: 32 });
    let canonical = toHex(160n, { size: 32 }), emit = true, fail = false;
    const ranges: Array<{ from: string; to: string }> = [];
    const log = () => ({ address: T.contracts.usdt, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: owner, to: made.account } }),
      data: encodeAbiParameters([{ type: 'uint256' }], [100n * WAD]), blockNumber: '0x10', blockHash: canonical, transactionHash: hash,
      transactionIndex: '0x0', logIndex: '0x0', removed: false });
    const client = createPublicClient({ transport: custom({ request: async ({ method, params }) => {
      if (fail) throw new Error('fixture RPC unavailable');
      if (method === 'eth_chainId') return '0x61';
      if (method === 'eth_getLogs') {
        const filter: unknown = Array.isArray(params) ? params[0] : null;
        assert.ok(typeof filter === 'object' && filter !== null);
        const from: unknown = Reflect.get(filter, 'fromBlock'), to: unknown = Reflect.get(filter, 'toBlock');
        assert.ok(typeof from === 'string' && typeof to === 'string'); ranges.push({ from, to });
        return emit && BigInt(from) <= 16n && BigInt(to) >= 16n ? [log()] : [];
      }
      if (method === 'eth_getBlockByNumber') {
        const at = Array.isArray(params) && typeof params[0] === 'string' && params[0] !== 'latest' ? BigInt(params[0]) : 20n;
        return { number: toHex(at), hash: at === 16n ? canonical : toHex(at, { size: 32 }), timestamp: '0x64', transactions: [] };
      }
      if (method === 'eth_getTransactionReceipt') return { transactionHash: hash, transactionIndex: '0x0', blockNumber: '0x10', blockHash: canonical,
        status: '0x1', from: owner, to: T.contracts.usdt, gasUsed: '0x1', cumulativeGasUsed: '0x1', effectiveGasPrice: '0x1', type: '0x2',
        contractAddress: null, logs: [log()], logsBloom: '0x' + '0'.repeat(512) };
      throw new Error('unexpected fixture method');
    } }, { retryCount: 0 }) });
    const deps = { query: (sql: string, params?: readonly unknown[]) => db.query(sql, params ? [...params] : []), transaction: <R>(work: (c: import('pg').PoolClient) => Promise<R>) => work(db) };
    const scan = () => syncMixAccountFlows(client, m, { fromBlock: 16n, toBlock: 20n }, deps, joined.portfolioId ?? undefined);
    await scan(); await scan();
    assert.equal((await db.query('select count(*)::int as n from mix_cash_flows where mix_id=$1', [made.mixId])).rows[0]?.n, 1);
    const count = ranges.length;
    await syncMixEnrollmentFlows(client, m, { blockNumber: 20n, blockHash: anchor }, deps);
    assert.equal(ranges.length, count, 'caught-up confirmation does not rescan the deployment history');
    await syncMixEnrollmentFlows(client, m, { blockNumber: 21n, blockHash: toHex(21n, { size: 32 }) }, deps);
    assert.deepEqual(ranges.slice(count), [{ from: '0x15', to: '0x15' }, { from: '0x15', to: '0x15' }]);
    canonical = toHex(161n, { size: 32 }); emit = false;
    await assert.rejects(scan(), /MIX_FLOW_REORGED/);
    assert.equal((await db.query('select last_scanned_block::text as b from portfolio_scan_cursors where portfolio_id=$1', [joined.portfolioId])).rows[0]?.b, '15');
    emit = true; await scan();
    const counts = (await db.query("select state,count(*)::int as n from mix_cash_flows where mix_id=$1 group by state order by state", [made.mixId])).rows;
    assert.deepEqual(counts, [{ state: 'canonical', n: 1 }, { state: 'reorged', n: 1 }]);
    fail = true; await assert.rejects(scan()); fail = false;
    await assert.rejects(syncMixAccountFlows(client, m, { fromBlock: 16n, toBlock: 20n }, { ...deps, query: async () => { throw new Error('fixture DB unavailable'); } }));
    assert.deepEqual((await db.query("select state,count(*)::int as n from mix_cash_flows where mix_id=$1 group by state order by state", [made.mixId])).rows, counts);
  });
});

test('creation retry after account failure preserves registration, original defaults and resolved Import, even after source deletion', async () => {
  await fixture(async (service, db, deps) => {
    const source = await service.create({ assets: [{ assetId: T.assets.NVDAB.token, weightBps: 10000 }],
      exit: { stopLossBps: 2000 } }, owner, 'source');
    const prepare = deps.prepareAccount;
    const registrations = new Set<number>();
    const register = deps.register;
    const failing = createMixService({ ...deps, now: () => new Date('2026-11-21T23:59:59Z'),
      register: async (...args) => { const id = await register(...args); registrations.add(id); return id; },
      prepareAccount: async () => { throw new Error('private account outage'); } });
    const input = { importCode: source.shareCode };
    await assert.rejects(failing.create(input, owner, 'import-retry'), /目前無法確認/);
    await db.query("update mixes set deleted_at=clock_timestamp(),frequency='daily',stop_loss_bps=null where id=$1", [source.mixId]);
    const retry = createMixService({ ...deps, now: () => new Date('2026-11-22T00:00:00Z'), prepareAccount: prepare,
      register: async (...args) => { const id = await register(...args); registrations.add(id); return id; } });
    const made = await retry.create(input, owner, 'import-retry');
    const same = await retry.create(input, owner, 'import-retry');
    assert.equal(same.mixId, made.mixId); assert.equal(registrations.size, 1);
    const result = (await retry.list(owner)).mixes.find(m => m.id === made.mixId); assert.ok(result);
    assert.equal(result.rebalance.startDate, '2026-11-21'); assert.equal(result.rebalance.frequency, 'monthly');
    assert.deepEqual(result.exit, { takeProfitBps: null, stopLossBps: 2000 });
    assert.equal((await db.query('select imported_from_share_code from mixes where id=$1', [made.mixId])).rows[0]?.imported_from_share_code, source.shareCode);
    await assert.rejects(retry.create({ ...input, name: 'different' }, owner, 'import-retry'), { code: 'MIX_REQUEST_CONFLICT' });
  });
});

test('creation persists mix and initial intent atomically and retries a lost completion response without another registration', async () => {
  await fixture(async (_service, db, deps) => {
    const registrations = new Set<number>();
    const register = deps.register;
    const failing = createMixService({ ...deps, register: async (...args) => { const id = await register(...args); registrations.add(id); return id; },
      calls: async () => { throw new Error('private RPC failure'); } });
    const input = { assets: [{ assetId: T.assets.NVDAB.token, weightBps: 10000 }] };
    await assert.rejects(failing.create(input, owner, 'retry-intent'), /目前無法確認/);
    assert.equal((await db.query('select count(*)::int as n from mixes')).rows[0]?.n, 0);
    const retry = createMixService({ ...deps, register: async (...args) => { const id = await register(...args); registrations.add(id); return id; } });
    const made = await retry.create(input, owner, 'retry-intent');
    const same = await retry.create({ assets: [{ weightBps: 10000, assetId: T.assets.NVDAB.token }] }, owner, 'retry-intent');
    assert.equal(made.mixId, same.mixId); assert.equal(registrations.size, 1);
    assert.equal((await db.query('select count(*)::int as n from mix_switch_intents')).rows[0]?.n, 1);
    for (const key of ['', 'bad key', 'a'.repeat(129), undefined]) await assert.rejects(retry.create(input, owner, key), { code: 'INVALID_MIX_REQUEST_KEY' });
    await db.query('set constraints all immediate');
  });
});

test('lost completion COMMIT response returns the original mix and no new registration; confirmed enrollment is not reopened', async () => {
  await fixture(async (service, db, deps) => {
    const input = { assets: [{ assetId: T.assets.NVDAB.token, weightBps: 10000 }] };
    const failing = createMixService({ ...deps, transaction: async work => { await deps.transaction(work); throw new Error('private unknown completion'); } });
    await assert.rejects(failing.create(input, owner, 'completion'), /目前無法確認/);
    const first = await service.create(input, owner, 'completion');
    const joined = await service.confirm(first.mixId, owner, { txHash: toHex(179n, { size: 32 }) }); assert.ok(joined.portfolioId);
    const second = await service.create(input, owner, 'completion');
    assert.equal(second.mixId, first.mixId); assert.deepEqual(second.calls, []);
    assert.equal((await db.query('select count(*)::int as n from strategies where is_personal_mix')).rows[0]?.n, 1);
    assert.equal((await db.query('select count(*)::int as n from mix_switch_intents')).rows[0]?.n, 1);
    assert.equal((await db.query('select count(*)::int as n from mix_creation_requests')).rows[0]?.n, 1);
  });
});

test('creation HTTP requires Idempotency-Key, permits its CORS preflight and retries the same owner/key without duplicates', async () => {
  await fixture(async service => {
    const server = createServer({ mixes: service,
      rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore()),
      auth: { authenticate: async () => owner, issueNonce: () => { throw new Error('unused'); }, login: async () => { throw new Error('unused'); }, logout: async () => {} } });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/me/mixes`;
    const body = JSON.stringify({ assets: [{ assetId: T.assets.NVDAB.token, weightBps: 10000 }] });
    try {
      const cors = await fetch(url, { method: 'OPTIONS', headers: { origin: 'http://localhost:5173', 'access-control-request-headers': 'idempotency-key' } });
      assert.ok(cors.headers.get('access-control-allow-headers')?.includes('idempotency-key'));
      assert.equal((await fetch(url, { method: 'POST', body })).status, 400);
      const make = () => fetch(url, { method: 'POST', body, headers: { 'idempotency-key': 'same-request' } });
      const first = await make(), second = await make(); assert.equal(first.status, 201); assert.equal(second.status, 201);
      for (let i = 0; i < 35; i++) assert.equal((await make()).status, 201, 'same key retries do not spend IP/global/wallet creation quotas');
      const conflict = await fetch(url, { method: 'POST', body: JSON.stringify({ name: 'changed' }), headers: { 'idempotency-key': 'same-request' } });
      assert.equal(conflict.status, 409);
      assert.equal((await fetch(url, { method: 'POST', body, headers: { 'idempotency-key': 'another-request' } })).status, 201);
      const initial: unknown = await first.json(), retry: unknown = await second.json();
      assert.deepEqual(retry, initial); assert.doesNotMatch(JSON.stringify(retry), /signed_raw_tx|registration_tx_hash|request_hash/);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});


test('handover and later new-money settlement preserve the due rebalance, while successful exit resets consecutive failures', async () => {
  await fixture(async (service, db) => {
    const made = await service.create({ assets: [{ assetId: T.assets.WBNB.token, weightBps: 10000 }] }, owner, randomUUID());
    const joined = await service.confirm(made.mixId, owner, { txHash: toHex(70n, { size: 32 }) }); assert.ok(joined.portfolioId);
    const find: import('../src/scheduler.js').SchedulerQueryFn = (sql, args) => db.query(sql, args ? [...args] : []);
    const due = { portfolioId: joined.portfolioId, strategyId: made.strategyId, account: made.account, accountType: 'KERNEL',
      intervalSeconds: 60, unsupportedReason: null, nextRunAt: mixClock };
    await recordMixExecution(find, joined.portfolioId, 'handover-buy', 'new_money');
    let state = await loadMixRuntime(due, find); assert.ok(state); assert.equal(state.last, null);
    assert.equal(decideMixTick({ ...state, takeProfit: null, stopLoss: null, newMoney: false }, mixRuntimeFixture().plan, mixClock).mode, 'rebalance');
    await recordMixExecution(find, joined.portfolioId, 'target-batch', 'rebalance');
    const completed = (await db.query('select last_rebalanced_at from mixes where id=$1', [made.mixId])).rows[0]?.last_rebalanced_at;
    assert.ok(completed instanceof Date);
    await recordMixExecution(find, joined.portfolioId, 'mid-period-deposit', 'new_money');
    assert.deepEqual((await db.query('select last_rebalanced_at from mixes where id=$1', [made.mixId])).rows[0]?.last_rebalanced_at, completed);
    await db.query("update mixes set triggered_at=$2,triggered_return_bps=-2000,exit_retry_count=5,exit_last_attempt_at=$2,exit_alerted_at=$2 where id=$1", [made.mixId, mixClock]);
    await db.query("update portfolios set schedule_state='paused' where id=$1", [joined.portfolioId]);
    await recordMixExecution(find, joined.portfolioId, 'successful-exit-batch', 'rebalance');
    state = await loadMixRuntime(due, find); assert.ok(state); assert.equal(state.retries, 0); assert.equal(state.triggered, true);
    assert.deepEqual((await db.query('select last_rebalanced_at from mixes where id=$1', [made.mixId])).rows[0]?.last_rebalanced_at, completed);
    assert.equal((await db.query('select exit_alerted_at from mixes where id=$1', [made.mixId])).rows[0]?.exit_alerted_at, null);
    assert.equal((await db.query('select schedule_state from portfolios where id=$1', [joined.portfolioId])).rows[0]?.schedule_state, 'active');
    await assert.rejects(recordMixExecution(async () => { throw new Error('fixture DB unavailable'); }, joined.portfolioId, 'db-failure', 'rebalance'));
  });
});


test('creation retries bypass creation budgets only for persisted matching requests, and rejected budgets cannot leave an exemption', async () => {
  await fixture(async (service, db, deps) => {
    const input = { assets: [{ assetId: T.assets.WBNB.token, weightBps: 10000 }] };
    let consumed = 0;
    const denied = async () => { consumed++; throw new RateLimitError(60); };
    await assert.rejects(service.create(input, owner, 'budget-retry', denied), { status: 429 });
    assert.equal((await db.query('select 1 from mix_creation_requests where request_key=$1', ['budget-retry'])).rows.length, 0);
    const made = await service.create(input, owner, 'budget-retry', async () => { consumed++; });
    assert.equal(consumed, 2);
    assert.equal((await service.create(input, owner, 'budget-retry', denied)).mixId, made.mixId);
    assert.equal(consumed, 2);
    await assert.rejects(service.create({ ...input, name: 'different' }, owner, 'budget-retry', denied), { code: 'MIX_REQUEST_CONFLICT' });
    assert.equal(consumed, 2);
    const unavailable = createMixService({ ...deps, query: async () => { throw new Error('private DB unavailable'); } });
    await assert.rejects(unavailable.create(input, owner, 'budget-db', denied), { code: 'MIX_UNAVAILABLE' });
    assert.equal(consumed, 2);
  });
});

test('a switched mix settles its real handover funding job and still owes an exit-asset rebalance on the next tick', async () => {
  await fixture(async (_service, db, deps) => {
    const proof = deps.proof;
    let carrying = false;
    const service = createMixService({ ...deps, proof: async (...args) => ({ ...await proof(...args), cashRaw: carrying ? (100n * WAD).toString() : '0' }) });
    const made = await service.create({ assets: [{ assetId: T.assets.NVDAB.token, weightBps: 5000 },
      { assetId: T.assets.WBNB.token, weightBps: 5000 }] }, owner, randomUUID());
    await service.confirm(made.mixId, owner, { txHash: toHex(80n, { size: 32 }) });
    await service.patch(made.mixId, owner, { assets: [{ assetId: T.assets.TSLAB.token, weightBps: 5000 }, { assetId: T.assets.WBNB.token, weightBps: 5000 }] });
    carrying = true;
    const switched = await service.confirm(made.mixId, owner, { txHash: toHex(81n, { size: 32 }) }); assert.ok(switched.portfolioId);
    const detail = await service.get(made.mixId, owner);
    const find: import('../src/scheduler.js').SchedulerQueryFn = (sql, args) => db.query(sql, args ? [...args] : []);
    const version = (await db.query<{ allocation: import('../src/strategies.js').Allocation; execution: import('../src/strategy-execution.js').AssetExecution }>(
      'select allocation,execution from strategy_versions where strategy_id=$1 and version=1', [detail.strategyId])).rows[0]; assert.ok(version);
    const context: import('../src/strategy-jobs.js').JobContext = { personalMix: true, chainId: 97, portfolioId: switched.portfolioId,
      strategyId: detail.strategyId, version: 1, kind: 'asset', account: made.account, allocation: version.allocation, execution: version.execution,
      cash: T.contracts.usdt, now: mixClock, reserve: 0n, caps: new Map(version.allocation.assets.map(a => [a.address, null])), buyLimit: 100n * WAD, observedCash: 100n * WAD, enabled: true, marketOpen: true };
    const { fundingLots, prepareStrategyJob, settleStrategyBatch } = await import('../src/strategy-jobs.js');
    const run: import('../src/scheduler.js').WithTransactionFn = work => work({ query: find });
    const prepared = await prepareStrategyJob(run, context, await fundingLots(find, context)); assert.ok(prepared.job);
    const job = prepared.job;
    await db.query("update strategy_jobs set state='running',asset_started_at=slot_at where id=$1", [job.id]);
    await db.query('insert into strategy_job_batches(job_id,batch_index,input_raw) values($1,0,$2)', [job.id, JSON.stringify(job.remaining_input)]);
    const op = (await db.query<{ id: string }>(`insert into operations(portfolio_id,type,state,idempotency_key,payload_hash,deadline,user_op_nonce,strategy_job_id,strategy_batch_index)
      values($1,'rebalance','pending',$2,$3,$4,0,$5,0) returning id`, [switched.portfolioId, randomUUID(), zeroHash, new Date(mixClock.getTime() + 300000), job.id])).rows[0]; assert.ok(op);
    await db.query("update operations set state='submitted',tx_hash=$2,user_op_hash=$2 where id=$1", [op.id, toHex(82n, { size: 32 })]);
    await settleStrategyBatch(run, context, op.id, { received: Object.fromEntries(Object.keys(job.remaining_input).map(asset => [asset, '1'])),
      fees: {}, feePaid: 0n, blockNumber: 3n, blockHash: toHex(83n, { size: 32 }) });
    const due = { portfolioId: switched.portfolioId, strategyId: detail.strategyId, account: made.account,
      accountType: 'KERNEL', intervalSeconds: 60, unsupportedReason: null, nextRunAt: mixClock };
    const state = await loadMixRuntime(due, find); assert.ok(state); assert.equal(state.last, null); assert.equal(state.newMoney, false);
    const { plan } = mixRuntimeFixture();
    plan.targets = version.allocation.assets.map(a => ({ asset: a.address, weightBps: a.weightBps, symbol: a.address }));
    const tick = decideMixTick(state, plan, mixClock);
    assert.equal(tick.mode, 'rebalance'); assert.equal(tick.complete, false);
    assert.equal(tick.plan.targets.find(a => a.asset === T.assets.NVDAB.token)?.weightBps, 0);
    assert.equal(tick.plan.targets.find(a => a.asset === T.assets.TSLAB.token)?.weightBps, 5000);
    await db.query('set constraints all immediate');
  });
});

test('a mix whose started buy is released closes its sources: it leaves new-money mode and its own rebalance gets the returned cash', async () => {
  await fixture(async (_service, db, deps) => {
    const proof = deps.proof;
    let carrying = false;
    // The valuation anchor is "now": 0056 refuses a valuation older than the mix (the shared mixClock is in the past).
    const service = createMixService({ ...deps, anchor: async () => ({ hash: zeroHash, at: new Date() }),
      proof: async (...args) => ({ ...await proof(...args), cashRaw: carrying ? (100n * WAD).toString() : '0' }) });
    const made = await service.create({ assets: [{ assetId: T.assets.NVDAB.token, weightBps: 5000 },
      { assetId: T.assets.WBNB.token, weightBps: 5000 }] }, owner, randomUUID());
    await service.confirm(made.mixId, owner, { txHash: toHex(90n, { size: 32 }) });
    await service.patch(made.mixId, owner, { assets: [{ assetId: T.assets.TSLAB.token, weightBps: 5000 }, { assetId: T.assets.WBNB.token, weightBps: 5000 }] });
    carrying = true;
    const switched = await service.confirm(made.mixId, owner, { txHash: toHex(91n, { size: 32 }) }); assert.ok(switched.portfolioId);
    const detail = await service.get(made.mixId, owner);
    const find: import('../src/scheduler.js').SchedulerQueryFn = (sql, args) => db.query(sql, args ? [...args] : []);
    const version = (await db.query<{ allocation: import('../src/strategies.js').Allocation; execution: import('../src/strategy-execution.js').AssetExecution }>(
      'select allocation,execution from strategy_versions where strategy_id=$1 and version=1', [detail.strategyId])).rows[0]; assert.ok(version);
    const context: import('../src/strategy-jobs.js').JobContext = { personalMix: true, chainId: 97, portfolioId: switched.portfolioId,
      strategyId: detail.strategyId, version: 1, kind: 'asset', account: made.account, allocation: version.allocation, execution: version.execution,
      cash: T.contracts.usdt, now: mixClock, reserve: 0n, caps: new Map(version.allocation.assets.map(a => [a.address, null])), buyLimit: 100n * WAD, observedCash: 100n * WAD, enabled: true, marketOpen: true };
    const { fundingLots, prepareStrategyJob, settleStrategyBatch, readJob, cancelJob } = await import('../src/strategy-jobs.js');
    const { mixAvailableCash } = await import('../src/mix-runtime.js');
    const run: import('../src/scheduler.js').WithTransactionFn = work => work({ query: find });
    const prepared = await prepareStrategyJob(run, context, await fundingLots(find, context)); assert.ok(prepared.job);
    const job = prepared.job;
    // The first transaction buys all but 5 USDT of each leg; the 10 USDT left is then released (#273 / #275 call cancelJob).
    const bought = Object.fromEntries(Object.entries(job.remaining_input).map(([asset, raw]) => [asset, (BigInt(raw) - 5n * WAD).toString()]));
    await db.query("update strategy_jobs set state='running',asset_started_at=slot_at where id=$1", [job.id]);
    await db.query('insert into strategy_job_batches(job_id,batch_index,input_raw) values($1,0,$2)', [job.id, JSON.stringify(bought)]);
    const op = (await db.query<{ id: string }>(`insert into operations(portfolio_id,type,state,idempotency_key,payload_hash,deadline,user_op_nonce,strategy_job_id,strategy_batch_index)
      values($1,'rebalance','pending',$2,$3,$4,0,$5,0) returning id`, [switched.portfolioId, randomUUID(), zeroHash, new Date(mixClock.getTime() + 300000), job.id])).rows[0]; assert.ok(op);
    await db.query("update operations set state='submitted',tx_hash=$2,user_op_hash=$2 where id=$1", [op.id, toHex(92n, { size: 32 })]);
    await settleStrategyBatch(run, context, op.id, { received: Object.fromEntries(Object.keys(bought).map(asset => [asset, '1'])),
      fees: {}, feePaid: 0n, blockNumber: 3n, blockHash: toHex(93n, { size: 32 }) });
    const due = { personalMix: true, portfolioId: switched.portfolioId, strategyId: detail.strategyId, account: made.account,
      accountType: 'KERNEL', intervalSeconds: 60, unsupportedReason: null, nextRunAt: mixClock };
    const buying = await loadMixRuntime(due, find); assert.ok(buying); assert.equal(buying.newMoney, true, 'the job is still buying');
    const running = await readJob(find, context); assert.ok(running); assert.equal(running.state, 'running');
    await cancelJob(find, context, running);
    const sources = (await db.query<{ state: string; slices: string[] }>(`select a.state,array(select s.state from strategy_asset_slices s
      where (s.lot_id,s.asset)=(a.lot_id,a.asset)) as slices from strategy_lot_assets a join strategy_funding_lots l on l.id=a.lot_id
      where l.portfolio_id=$1 and a.effective_slices>0`, [switched.portfolioId])).rows;
    assert.deepEqual(sources, [{ state: 'cancelled', slices: ['cancelled'] }, { state: 'cancelled', slices: ['cancelled'] }]);
    const cashRow = async () => (await db.query<Record<string, string>>(`select unallocated_hold_raw::text,allocated_cash_raw::text,stack_prefund_raw::text,
      reserved_input_raw::text,reserved_fee_raw::text from strategy_cash_balances where chain_id=97 and portfolio_id=$1`, [switched.portfolioId])).rows[0];
    assert.deepEqual(await cashRow(), { unallocated_hold_raw: (10n * WAD).toString(), allocated_cash_raw: '0', stack_prefund_raw: '0', reserved_input_raw: '0', reserved_fee_raw: '0' },
      'the 10 USDT is this portfolio\'s own free cash');
    // Before the fix the sources stayed active: every round was "new money" with nothing to buy, and a target pass in
    // that mode may only spend allocated_cash_raw (mixAvailableCash), which is 0 here.
    const state = await loadMixRuntime(due, find); assert.ok(state); assert.equal(state.newMoney, false, 'no source is pending any more');
    const { plan } = mixRuntimeFixture();
    plan.targets = version.allocation.assets.map(a => ({ asset: a.address, weightBps: a.weightBps, symbol: a.address }));
    plan.snapshot.holdings = [{ asset: T.assets.TSLAB.token, amountWei: 45n * WAD }, { asset: T.assets.WBNB.token, amountWei: 45n * WAD },
      { asset: T.contracts.usdt, amountWei: 10n * WAD }].map(h => ({ ...h, decimals: 18, usdPriceE8: 100000000n, priceSource: 'numeraire' as const }));
    // Between its dates the basket waits; on its date (here: the forced pass after a switch) it rebalances.
    assert.equal(decideMixTick({ ...state, last: mixClock }, plan, new Date(mixClock.getTime() + 60000)).mode, 'wait');
    const tick = decideMixTick(state, plan, mixClock);
    assert.equal(tick.mode, 'rebalance'); assert.equal(tick.complete, false);
    await prepareMixTick(state, tick, due, mixClock, run);
    assert.deepEqual(await cashRow(), { unallocated_hold_raw: '0', allocated_cash_raw: (10n * WAD).toString(), stack_prefund_raw: '0', reserved_input_raw: '0', reserved_fee_raw: '0' });
    assert.equal(await mixAvailableCash(due, tick.plan, find), 10n * WAD, 'the rebalance may spend all of the returned cash');
    await db.query('set constraints all immediate');
  });
});

test('a mix bought while the US market is closed keeps the deposit whole when its stock leg is under 10 USDT, and buys every leg at the open', async () => {
  await fixture(async (_service, db, deps) => {
    const proof = deps.proof;
    let carrying = false;
    const service = createMixService({ ...deps, anchor: async () => ({ hash: zeroHash, at: new Date() }),
      proof: async (...args) => ({ ...await proof(...args), cashRaw: carrying ? (50n * WAD).toString() : '0' }) });
    const made = await service.create({ assets: [{ assetId: T.assets.NVDAB.token, weightBps: 5000 },
      { assetId: T.assets.WBNB.token, weightBps: 5000 }] }, owner, randomUUID());
    await service.confirm(made.mixId, owner, { txHash: toHex(90n, { size: 32 }) });
    // 50 USDT, 16% stock: the stock leg is 8 USDT.
    await service.patch(made.mixId, owner, { assets: [{ assetId: T.assets.TSLAB.token, weightBps: 1600 }, { assetId: T.assets.WBNB.token, weightBps: 8400 }] });
    carrying = true;
    const switched = await service.confirm(made.mixId, owner, { txHash: toHex(91n, { size: 32 }) }); assert.ok(switched.portfolioId);
    const detail = await service.get(made.mixId, owner);
    const find: import('../src/scheduler.js').SchedulerQueryFn = (sql, args) => db.query(sql, args ? [...args] : []);
    const version = (await db.query<{ allocation: import('../src/strategies.js').Allocation; execution: import('../src/strategy-execution.js').AssetExecution }>(
      'select allocation,execution from strategy_versions where strategy_id=$1 and version=1', [detail.strategyId])).rows[0]; assert.ok(version);
    const { assetsMarketOpen } = await import('../src/trading-calendar.js');
    const { fundingLots, prepareStrategyJob } = await import('../src/strategy-jobs.js');
    const { mixAvailableCash } = await import('../src/mix-runtime.js');
    const run: import('../src/scheduler.js').WithTransactionFn = work => work({ query: find });
    // The scheduler's own market test (strategy-runtime prepareNewMoney): the real NYSE calendar on the admitted stock tokens.
    const round = async (now: Date) => {
      const marketOpenFor = (assets: readonly string[]) => assetsMarketOpen(97, assets, now);
      const context: import('../src/strategy-jobs.js').JobContext = { personalMix: true, chainId: 97, portfolioId: switched.portfolioId ?? 0,
        strategyId: detail.strategyId, version: 1, kind: 'asset', account: made.account, allocation: version.allocation, execution: version.execution,
        cash: T.contracts.usdt, now, reserve: 27n * WAD / 100n, caps: new Map(version.allocation.assets.map(a => [a.address, null])), buyLimit: 100n * WAD, observedCash: 50n * WAD,
        enabled: true, marketOpen: marketOpenFor(version.allocation.assets.map(a => a.address)), marketOpenFor };
      return prepareStrategyJob(run, context, await fundingLots(find, context));
    };
    const cashRow = async () => (await db.query<Record<string, string>>(`select unallocated_hold_raw::text,allocated_cash_raw::text,stack_prefund_raw::text,
      reserved_input_raw::text,reserved_fee_raw::text from strategy_cash_balances where chain_id=97 and portfolio_id=$1`, [switched.portfolioId])).rows[0];
    const whole = { unallocated_hold_raw: (50n * WAD).toString(), allocated_cash_raw: '0', stack_prefund_raw: '0', reserved_input_raw: '0', reserved_fee_raw: '0' };
    assert.deepEqual(await cashRow(), whole);
    const due = { personalMix: true, portfolioId: switched.portfolioId, strategyId: detail.strategyId, account: made.account,
      accountType: 'KERNEL', intervalSeconds: 60, unsupportedReason: null, nextRunAt: mixClock };
    // Saturday 2026-11-21, Sunday, and Monday before the bell: closed. Before the rule the first round bought 42 USDT of WBNB.
    for (const at of ['2026-11-21T13:00:00Z', '2026-11-22T20:00:00Z', '2026-11-23T14:29:00Z']) {
      const waiting = await round(new Date(at));
      assert.equal(waiting.job, null); assert.match(waiting.reason, /^\[MARKET_CLOSED\]/);
    }
    assert.deepEqual(await cashRow(), whole, 'the deposit is untouched while it waits');
    assert.equal((await db.query('select 1 from strategy_asset_slices s join strategy_funding_lots l on l.id=s.lot_id where l.portfolio_id=$1', [switched.portfolioId])).rows.length, 0);
    const state = await loadMixRuntime(due, find); assert.ok(state); assert.equal(state.newMoney, true, 'still new money to buy');
    // A target pass that falls in the wait may only spend allocated cash: none of the waiting deposit.
    const { plan } = mixRuntimeFixture();
    plan.snapshot.holdings = [{ asset: T.contracts.usdt, amountWei: 50n * WAD, decimals: 18, usdPriceE8: 100000000n, priceSource: 'numeraire' as const }];
    assert.equal(await mixAvailableCash(due, plan, find), 0n);
    // Monday 2026-11-23 09:30 New York: one job with both legs and the whole 50 USDT.
    const together = (await round(new Date('2026-11-23T14:30:00Z'))).job; assert.ok(together);
    assert.deepEqual(Object.keys(together.remaining_input).sort(), [T.assets.TSLAB.token, T.assets.WBNB.token].sort());
    assert.equal(BigInt(together.amount_raw) + BigInt(together.fee_reserve_raw), 50n * WAD);
    assert.deepEqual(await cashRow(), { unallocated_hold_raw: '0', allocated_cash_raw: '0', stack_prefund_raw: '0',
      reserved_input_raw: together.amount_raw, reserved_fee_raw: together.fee_reserve_raw });
    await db.query('set constraints all immediate');
  });
});

test('a switched mix keeps its forced pass after a crypto batch until its closed stock exits are resolved', async () => {
  await fixture(async (service, db) => {
    const made = await service.create({ assets: [{ assetId: T.assets.NVDAB.token, weightBps: 10000 }] }, owner, randomUUID());
    await service.confirm(made.mixId, owner, { txHash: toHex(80n, { size: 32 }) });
    await service.patch(made.mixId, owner, { assets: [{ assetId: T.assets.TSLAB.token, weightBps: 10000 }] });
    const switched = await service.confirm(made.mixId, owner, { txHash: toHex(81n, { size: 32 }) }); assert.ok(switched.portfolioId);
    const find: import('../src/scheduler.js').SchedulerQueryFn = (sql, args) => db.query(sql, args ? [...args] : []);
    await recordMixExecution(find, switched.portfolioId, 'crypto-sold-stock-closed', 'rebalance');
    assert.equal((await db.query('select last_rebalanced_at from mixes where id=$1', [made.mixId])).rows[0]?.last_rebalanced_at, null);
    await db.query('update mixes set last_rebalanced_at=$2 where id=$1', [made.mixId, mixClock]);
    await recordMixExecution(find, switched.portfolioId, 'ordinary-period-batch', 'rebalance');
    const ordinary = (await db.query('select last_rebalanced_at from mixes where id=$1', [made.mixId])).rows[0]?.last_rebalanced_at;
    assert.ok(ordinary instanceof Date, 'ordinary period still completes on one batch');
  });
});

test('a switch with a closed target stock finishes the period after its crypto exit falls below the step minimum', async () => {
  await fixture(async (service, db) => {
    const made = await service.create({ assets: [{ assetId: T.assets.WBNB.token, weightBps: 10000 }],
      rebalance: { frequency: 'monthly', startDate: '2026-11-01' } }, owner, randomUUID());
    await service.confirm(made.mixId, owner, { txHash: toHex(84n, { size: 32 }) });
    await service.patch(made.mixId, owner, { assets: [{ assetId: T.assets.NVDAB.token, weightBps: 5000 }, { assetId: T.assets.BTCB.token, weightBps: 5000 }] });
    const switched = await service.confirm(made.mixId, owner, { txHash: toHex(85n, { size: 32 }) }); assert.ok(switched.portfolioId);
    const find: import('../src/scheduler.js').SchedulerQueryFn = (sql, args) => db.query(sql, args ? [...args] : []);
    const due = { portfolioId: switched.portfolioId, strategyId: made.strategyId, account: made.account, accountType: 'KERNEL',
      intervalSeconds: 60, unsupportedReason: null, nextRunAt: mixClock };
    const { plan } = mixRuntimeFixture();
    const crypto = plan.snapshot.holdings.find(h => h.asset === T.assets.WBNB.token); assert.ok(crypto); crypto.asset = T.assets.BTCB.token; crypto.amountWei *= 2n;
    const target = plan.targets.find(h => h.asset === T.assets.WBNB.token); assert.ok(target); target.asset = T.assets.BTCB.token;
    const exit = { asset: T.assets.WBNB.token, amountWei: WAD, decimals: 18, usdPriceE8: 100000000n, priceSource: 'numeraire' as const };
    plan.targets.push({ asset: exit.asset, weightBps: 1, symbol: 'WBNB' }); plan.snapshot.holdings.push(exit);
    let state = await loadMixRuntime(due, find); assert.ok(state);
    assert.ok(state.exits.has(exit.asset));
    await recordMixExecution(find, switched.portfolioId, 'exit-at-minimum', 'rebalance', mixSwitchExitsPending(state, plan));
    assert.equal((await loadMixRuntime(due, find))?.last, null, 'exactly the step minimum remains pending');
    exit.amountWei--;
    await recordMixExecution(find, switched.portfolioId, 'exit-sold-next-batch', 'rebalance', mixSwitchExitsPending(state, plan));
    state = await loadMixRuntime(due, find); assert.ok(state); assert.ok(state.last instanceof Date);
    assert.equal(decideMixTick({ ...state, newMoney: false, takeProfit: null, stopLoss: null }, plan, new Date(state.last.getTime() + 60000)).mode, 'wait');
  });
});

test('a below-batch switch residue and completion are atomic, immutable and idempotent after an unknown response', async () => {
  await fixture(async (service, db) => {
    const made = await service.create({ assets: [{ assetId: T.assets.NVDAB.token, weightBps: 10000 }] }, owner, randomUUID());
    await service.confirm(made.mixId, owner, { txHash: toHex(82n, { size: 32 }) });
    await service.patch(made.mixId, owner, { assets: [{ assetId: T.assets.TSLAB.token, weightBps: 10000 }] });
    const switched = await service.confirm(made.mixId, owner, { txHash: toHex(83n, { size: 32 }) }); assert.ok(switched.portfolioId);
    const find: import('../src/scheduler.js').SchedulerQueryFn = (sql, args) => db.query(sql, args ? [...args] : []);
    const due = { portfolioId: switched.portfolioId, strategyId: made.strategyId, account: made.account, accountType: 'KERNEL', intervalSeconds: 60, unsupportedReason: null, nextRunAt: mixClock };
    const state = await loadMixRuntime(due, find); assert.ok(state);
    const { plan } = mixRuntimeFixture(); plan.account = made.account; plan.portfolioId = switched.portfolioId; plan.snapshot.portfolioId = switched.portfolioId;
    for (const h of plan.snapshot.holdings) h.amountWei = h.asset === T.assets.NVDAB.token ? 2n * WAD : 0n;
    const at = new Date('2026-11-23T15:00Z'), anchor = async () => ({ hash: zeroHash, at: mixClock });
    await db.query('savepoint residual_rollback');
    await assert.rejects(recordMixSwitchResidual(state, due, plan, at, async work => {
      try { await work({ query: find }); throw new Error('fixture commit failure'); }
      finally { await db.query('rollback to savepoint residual_rollback'); }
    }, anchor));
    assert.equal((await db.query("select * from user_notifications where portfolio_id=$1 and kind='mix_switch_residual'", [switched.portfolioId])).rows.length, 0);
    assert.equal((await db.query('select last_rebalanced_at from mixes where id=$1', [made.mixId])).rows[0]?.last_rebalanced_at, null);
    assert.equal(await recordMixSwitchResidual(state, due, plan, at, work => work({ query: find }), anchor), true);
    assert.equal(await recordMixSwitchResidual(state, due, plan, at, work => work({ query: find }), anchor), false);
    const audit = (await db.query("select id,payload from user_notifications where portfolio_id=$1 and kind='mix_switch_residual'", [switched.portfolioId])).rows[0]; assert.ok(audit);
    assert.equal(audit.payload.residuals[0]?.quantityRaw, (2n * WAD).toString());
    assert.equal(audit.payload.blockHash, zeroHash); assert.equal(audit.payload.reason, 'below_batch_minimum');
    assert.deepEqual((await db.query('select last_rebalanced_at from mixes where id=$1', [made.mixId])).rows[0]?.last_rebalanced_at, at);
    await db.query('savepoint immutable_residual');
    await assert.rejects(db.query("update user_notifications set payload='{}' where id=$1", [audit.id]));
    await db.query('rollback to savepoint immutable_residual');
  });
});

test('mix delete: empty mixes are deleted at once; held assets latch the exit, then owner withdrawal completes deletion', async () => {
  await fixture(async (_service, db, deps) => {
    let plan = mixRuntimeFixture().plan;
    const service = createMixService({ ...deps, plan: async () => plan });
    const holdings = (rows: [string, bigint][]) => {
      const base = mixRuntimeFixture().plan;
      return { ...base, snapshot: { ...base.snapshot, holdings: rows.map(([asset, amountWei]) => ({ asset: asset as `0x${string}`, amountWei, decimals: 18, usdPriceE8: 100000000n, priceSource: 'numeraire' as const })) } };
    };
    const status = async (id: number) => (await service.list(owner)).mixes.find(m => m.id === id)?.status;
    const unfunded = await service.create({ assets: [{ assetId: T.assets.NVDAB.token, weightBps: 10000 }] }, owner, randomUUID());
    assert.deepEqual(await service.remove(unfunded.mixId, owner), { mixId: unfunded.mixId, status: 'deleted' });
    assert.equal(await status(unfunded.mixId), undefined);
    await assert.rejects(service.remove(unfunded.mixId, owner), /找不到/);
    assert.equal((await db.query("select state from mix_switch_intents where mix_id=$1", [unfunded.mixId])).rows[0]?.state, 'cancelled');

    const held = await service.create({ assets: [{ assetId: T.assets.NVDAB.token, weightBps: 10000 }] }, owner, randomUUID());
    const joined = await service.confirm(held.mixId, owner, { txHash: toHex(91n, { size: 32 }) });
    await assert.rejects(service.remove(held.mixId, T.roles.operator), /找不到/);
    plan = holdings([[T.assets.NVDAB.token, 65n * WAD], [T.contracts.usdt, 3n * WAD]]);
    assert.deepEqual(await service.remove(held.mixId, owner), { mixId: held.mixId, status: 'deleting' });
    const latched = (await db.query('select triggered_at,triggered_return_bps::text,delete_requested_at,deleted_at from mixes where id=$1', [held.mixId])).rows[0];
    assert.ok(latched.triggered_at && latched.delete_requested_at); assert.equal(latched.deleted_at, null);
    assert.equal(await status(held.mixId), 'deleting');
    assert.equal((await db.query("select count(*)::int as n from user_notifications where kind='mix_delete_requested' and dedup_key=$1", [String(held.mixId)])).rows[0].n, 1);
    await assert.rejects(service.patch(held.mixId, owner, { name: 'nope' }), { code: 'MIX_DELETING' });
    await assert.rejects(service.restart(held.mixId, owner), { code: 'MIX_DELETING' });
    // Repeated requests while selling keep the original latch.
    assert.equal((await service.remove(held.mixId, owner)).status, 'deleting');
    await db.query('savepoint restart_guard');
    await assert.rejects(db.query('update mixes set triggered_at=null,triggered_return_bps=null where id=$1', [held.mixId]), /mixes_delete_requires_exit/);
    await db.query('rollback to savepoint restart_guard');
    await db.query("update mixes set status='exited' where id=$1", [held.mixId]);
    assert.equal(await status(held.mixId), 'ready_to_delete');
    plan = holdings([[T.assets.NVDAB.token, WAD / 2n], [T.contracts.usdt, 130n * WAD]]);
    await assert.rejects(service.remove(held.mixId, owner), { code: 'MIX_HAS_CASH' });
    // After the owner withdrawal only the recorded exit residual remains.
    plan = holdings([[T.assets.NVDAB.token, WAD / 2n], [T.contracts.usdt, 0n]]);
    assert.equal((await service.remove(held.mixId, owner)).status, 'deleted');
    assert.equal(await status(held.mixId), undefined);
    assert.equal((await db.query('select schedule_state from portfolios where id=$1', [joined.portfolioId])).rows[0]?.schedule_state, 'paused');

    const unavailable = await service.create({ assets: [{ assetId: T.assets.NVDAB.token, weightBps: 10000 }] }, owner, randomUUID());
    await service.confirm(unavailable.mixId, owner, { txHash: toHex(92n, { size: 32 }) });
    plan = { ...holdings([[T.assets.NVDAB.token, WAD]]), blocked: [{ asset: T.assets.NVDAB.token, reason: 'fixture' }] } as never;
    await assert.rejects(service.remove(unavailable.mixId, owner), { code: 'MIX_UNAVAILABLE' });
    plan = holdings([[T.assets.NVDAB.token, 0n], [T.contracts.usdt, 0n]]);
    assert.equal((await service.remove(unavailable.mixId, owner)).status, 'deleted');
  });
});

test('a delete-requested exit with no USDT left completes the deletion; with USDT it waits for the owner withdrawal', async () => {
  for (const cash of [0n, 5n * WAD]) await fixture(async (service, db) => {
    const made = await service.create({ assets: [{ assetId: T.assets.NVDAB.token, weightBps: 5000 }, { assetId: T.assets.WBNB.token, weightBps: 5000 }] }, owner, randomUUID());
    const joined = await service.confirm(made.mixId, owner, { txHash: toHex(56n, { size: 32 }) }); assert.ok(joined.portfolioId);
    await db.query('update mixes set triggered_at=clock_timestamp(),triggered_return_bps=0,delete_requested_at=clock_timestamp() where id=$1', [made.mixId]);
    await db.query('update strategy_cash_balances set allocated_cash_raw=$2 where portfolio_id=$1', [joined.portfolioId, cash.toString()]);
    const due = { personalMix: true, portfolioId: joined.portfolioId, strategyId: made.strategyId, account: made.account,
      accountType: 'KERNEL', intervalSeconds: 60, unsupportedReason: null, nextRunAt: mixClock };
    const find: import('../src/scheduler.js').SchedulerQueryFn = (sql, args) => db.query(sql, args ? [...args] : []);
    const state = await loadMixRuntime(due, find, undefined, async () => ({ hash: zeroHash, at: mixClock })); assert.ok(state);
    const { plan } = mixRuntimeFixture();
    for (const h of plan.snapshot.holdings) h.amountWei = h.asset === T.contracts.usdt ? cash : 0n;
    const tick = decideMixTick(state, plan, mixClock); assert.equal(tick.mode, 'exit'); assert.equal(tick.complete, true);
    await prepareMixTick(state, tick, due, new Date(Date.now() + 1000), work => work({ query: find }));
    await db.query('set constraints all immediate');
    const row = (await db.query('select status,deleted_at from mixes where id=$1', [made.mixId])).rows[0];
    assert.equal(row.status, 'exited');
    assert.equal(row.deleted_at === null, cash > 0n);
    assert.equal((await service.list(owner)).mixes.some(m => m.id === made.mixId), cash > 0n);
    if (cash > 0n) assert.equal((await service.list(owner)).mixes.find(m => m.id === made.mixId)?.status, 'ready_to_delete');
  });
});

test('mix weight change with the yield strategy on: the owner intent re-consents for the new weights after the enroll; unreadable -> 503 before publishing', async () => {
  await fixture(async (service, db, deps) => {
    const made = await service.create({ assets: [{ assetId: T.assets.NVDAB.token, weightBps: 10000 }],
      rebalance: { frequency: 'monthly', startDate: '2026-11-01' }, exit: { takeProfitBps: null, stopLossBps: null } }, owner, randomUUID());
    await service.confirm(made.mixId, owner, { txHash: toHex(11n, { size: 32 }) });
    const tsla = strategyMarkets().find(m => m.symbol === 'TSLAB'); assert.ok(tsla);
    const consent = consentCalls([{ market: tsla, maxDebtRaw: 10n ** 20n }]);
    const seen: Parameters<MixServiceDeps['strategyConsent']>[0][] = [];
    let registered = 0;
    const on = createMixService({ ...deps, register: async (...a) => { registered++; return deps.register(...a); },
      strategyConsent: async input => { seen.push(input); return consent; } });
    const changed = await on.patch(made.mixId, owner, { assets: [{ assetId: T.assets.TSLAB.token, weightBps: 10000 }] });
    assert.ok('calls' in changed);
    // NVDAB (removed, sold after repaying) gets no consent; the mix is worth 130 USD in the fixture plan.
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]?.assets.map(a => a.address), [T.assets.TSLAB.token, T.contracts.usdt]);
    assert.equal(seen[0]?.totalValueUsd, 130n * WAD);
    assert.ok(seen[0]?.previousAssets.includes(T.assets.NVDAB.token));
    const stored = (await db.query<{ owner_calls: { to: string; data: string }[] }>("select owner_calls from mix_switch_intents where mix_id=$1 and state='prepared'", [made.mixId])).rows[0];
    assert.ok(stored);
    assert.deepEqual(stored.owner_calls.slice(-consent.length), consent, 'consent after the enroll');
    assert.match(stored.owner_calls[stored.owner_calls.length - consent.length - 1]?.data ?? '', /^0x/);
    assert.deepEqual(changed.calls, stored.owner_calls);
    assert.equal(registered, 1);
    // Routing v2 addresses for the app's pre-signing check: only for an owner in the v2 audience (nobody by default).
    assert.equal('strategyV2' in changed, false);
    const v2 = { registry: toHex(0xa1n, { size: 20 }), executor: toHex(0xa2n, { size: 20 }) };
    const audience: string[] = [];
    const prepared = await createMixService({ ...deps, strategyV2: o => { audience.push(o); return v2; } }).prepare(made.mixId, owner);
    assert.deepEqual((prepared as { strategyV2?: unknown }).strategyV2, v2);
    assert.deepEqual(prepared.calls, stored.owner_calls);
    assert.deepEqual(audience, [owner.toLowerCase()]);
    // Unreadable strategy state: nothing is published, the owner retries.
    await db.query("update mix_switch_intents set state='cancelled' where mix_id=$1 and state='prepared'", [made.mixId]);
    const down = createMixService({ ...deps, register: async (...a) => { registered++; return deps.register(...a); },
      strategyConsent: async () => { throw new Error('private RPC'); } });
    await assert.rejects(down.patch(made.mixId, owner, { assets: [{ assetId: T.assets.WBNB.token, weightBps: 10000 }] }), (e: unknown) => e instanceof Error && 'status' in e && e.status === 503);
    assert.equal(registered, 1, 'no strategy published');
  });
});
