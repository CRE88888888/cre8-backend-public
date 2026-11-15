import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { closePool, getPool, query, withTransaction } from '../src/db.js';
import { WELCOME_AMOUNT_WEI } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { createPortfolioStrategyService } from '../src/portfolio-strategies.js';
import { createWelcomeService, findWelcomeGrant, reserveWelcomeGrant, settleWelcomeGrant } from '../src/welcome-grants.js';
import { withRelayerLock } from '../src/relayer-lock.js';
import { reserveFaucetClaim, settleFaucetClaim } from '../src/faucet.js';
import { address, hash, welcomeConfig, welcomeFixture } from './fixtures/welcome.js';

const denied = (code: string) => (e: unknown) => e instanceof AppError && e.code === code && !e.message.includes('SECRET');
const fixtures: Awaited<ReturnType<typeof welcomeFixture>>[] = [];
async function fixture(owner = address(), kind: 'hold' | 'stack' = 'hold') {
  const f = await welcomeFixture(owner, kind); fixtures.push(f); return f;
}
async function used() {
  const row = (await query<{ amount: string }>("select coalesce(sum(amount_wei),0)::text as amount from welcome_grants where utc_day=(now() at time zone 'UTC')::date and state<>'failed'")).rows[0];
  assert.ok(row); return BigInt(row.amount);
}
async function cash(id: number) {
  return (await query<{ hold: string; stack: string; allocated: string }>(`select unallocated_hold_raw::text as hold,stack_prefund_raw::text as stack,allocated_cash_raw::text as allocated from strategy_cash_balances where portfolio_id=$1`, [id])).rows[0];
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    const g = await findWelcomeGrant(97, f.owner);
    // Controlled broadcasters never touch a real chain. Preserve permanent audit rows.
    if (g && !['confirmed', 'failed'].includes(g.state)) await settleWelcomeGrant(g, 'failed', g.txHash);
  }
});
after(closePool);

test('#91 DB first buy credits 10000 once with explicit origin and BE-2 hold/stack/cash budgets; restart and second fund cannot mint', async () => {
  for (const kind of ['hold', 'stack'] as const) {
    const f = await fixture(address(), kind);
    const first = await f.service.buyFunding(f.id, f.owner, {});
    assert.equal(first.state, 'ready'); assert.equal(first.lot?.amountRaw, WELCOME_AMOUNT_WEI.toString());
    assert.equal(first.lot?.source.kind, 'welcome_grant'); assert.equal(f.sends(), 1);
    const replay = await createPortfolioStrategyService(f.deps).buyFunding(f.id, f.owner, {});
    assert.equal(replay.lot?.id, first.lot?.id); assert.equal(replay.lot?.replayed, true); assert.equal(f.sends(), 1);
    assert.deepEqual(await cash(f.id), { hold: kind === 'hold' ? (WELCOME_AMOUNT_WEI / 2n).toString() : '0', stack: kind === 'stack' ? (WELCOME_AMOUNT_WEI / 2n).toString() : '0', allocated: (WELCOME_AMOUNT_WEI / 2n).toString() });
    const rows = (await query<{ source_kind: string; welcome_grant_id: string }>('select source_kind,welcome_grant_id::text from strategy_funding_lots where portfolio_id=$1', [f.id])).rows;
    assert.deepEqual(rows, [{ source_kind: 'welcome_grant', welcome_grant_id: first.lot?.source.kind === 'welcome_grant' ? first.lot.source.grantId : '' }]);
    const other = await fixture(f.owner);
    await assert.rejects(other.service.buyFunding(other.id, other.owner, {}), denied('DAILY_FAUCET_REQUIRED'));
    assert.equal(other.sends(), 0);
  }
});

test('#91 DB concurrent first buys across accounts and processes preserve the lifetime key and broadcast only once', async () => {
  const a = await fixture(), b = await fixture(a.owner);
  const outcomes = await Promise.allSettled([a.service.buyFunding(a.id, a.owner, {}), b.service.buyFunding(b.id, b.owner, {})]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  for (const o of outcomes) if (o.status === 'rejected') assert.ok(o.reason instanceof AppError && ['RELAYER_BUSY', 'DAILY_FAUCET_REQUIRED'].includes(o.reason.code));
  assert.equal(a.sends() + b.sends(), 1);
  const source = `import {findWelcomeGrant,createWelcomeService} from './src/welcome-grants.ts';import {closePool} from './src/db.ts';
    const g=await findWelcomeGrant(97,'${a.owner}');if(!g)throw Error('missing');const replay=await createWelcomeService({config:{chainId:97,siteDailyWei:0n,timeoutMs:5000}}).issue({...g,portfolioId:${b.id}});console.log(replay.id);await closePool();`;
  const original = await findWelcomeGrant(97, a.owner); assert.ok(original);
  assert.equal(execFileSync(process.execPath, ['--no-env-file', '--eval', source], { encoding: 'utf8', env: process.env }).trim(), original.id);
});

test('#91 DB same fund with spent welcome returns daily faucet guidance at zero, preserves lot, and never remints', async () => {
  const f = await fixture(); const first = await f.service.buyFunding(f.id, f.owner, {});
  f.rpc.state.cashRaw = 0n;
  await assert.rejects(f.service.buyFunding(f.id, f.owner, {}), denied('DAILY_FAUCET_REQUIRED'));
  assert.equal(f.sends(), 1);
  assert.equal((await query('select id from strategy_funding_lots where portfolio_id=$1', [f.id])).rows.length, 1);
  f.rpc.state.cashRaw = 1n;
  assert.equal((await f.service.buyFunding(f.id, f.owner, {})).lot?.id, first.lot?.id);
  f.rpc.state.fail = 'eth_call';
  await assert.rejects(f.service.buyFunding(f.id, f.owner, {}));
  assert.equal(f.sends(), 1);
});

test('#91 DB cap zero, one raw below, equality and +1; all unresolved states charge and failed only releases daily quota', async () => {
  for (const delta of [0n, WELCOME_AMOUNT_WEI - 1n, WELCOME_AMOUNT_WEI, WELCOME_AMOUNT_WEI + 1n]) {
    const f = await fixture(); const before = await used();
    const work = reserveWelcomeGrant(f.recipient, { ...welcomeConfig, siteDailyWei: delta === 0n ? 0n : before + delta });
    if (delta < WELCOME_AMOUNT_WEI) await assert.rejects(work, denied('WELCOME_QUOTA_EXCEEDED'));
    else assert.equal((await work).created, true);
  }
  for (const state of ['reserved', 'submitted', 'unknown', 'confirmed', 'failed'] as const) {
    const f = await fixture(), next = await fixture();
    const before = await used(); const { grant } = await reserveWelcomeGrant(f.recipient, welcomeConfig);
    if (state !== 'reserved') {
      if (state === 'confirmed') {
        const txHash = hash(); await settleWelcomeGrant(grant, 'submitted', txHash);
        await settleWelcomeGrant({ ...grant, state: 'submitted', txHash }, 'confirmed', txHash, { txHash, logIndex: 0, blockNumber: 0n, blockHash: hash(), amountRaw: grant.amountWei.toString() });
      } else await settleWelcomeGrant(grant, state, state === 'submitted' || state === 'unknown' ? hash() : null);
    }
    assert.equal((await reserveWelcomeGrant(f.recipient, { ...welcomeConfig, siteDailyWei: 0n })).created, false, 'zero never blocks original lifetime lookup');
    const cap = before + WELCOME_AMOUNT_WEI;
    if (state === 'failed') assert.equal((await reserveWelcomeGrant(next.recipient, { ...welcomeConfig, siteDailyWei: cap })).created, true);
    else await assert.rejects(reserveWelcomeGrant(next.recipient, { ...welcomeConfig, siteDailyWei: cap }), denied('WELCOME_QUOTA_EXCEEDED'));
  }
});

test('#91 DB independent writers share the welcome date cap; same-owner reservation returns its existing record', async () => {
  const a = await fixture(), b = await fixture(), cap = await used() + WELCOME_AMOUNT_WEI;
  const outcomes = await Promise.allSettled([reserveWelcomeGrant(a.recipient, { ...welcomeConfig, siteDailyWei: cap }), reserveWelcomeGrant(b.recipient, { ...welcomeConfig, siteDailyWei: cap })]);
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(o => o.status === 'rejected' && denied('WELCOME_QUOTA_EXCEEDED')(o.reason)).length, 1);
  const same = await fixture();
  const pair = await Promise.all([reserveWelcomeGrant(same.recipient, welcomeConfig), reserveWelcomeGrant(same.recipient, welcomeConfig)]);
  assert.equal(pair.filter(x => x.created).length, 1); assert.equal(pair[0]?.grant.id, pair[1]?.grant.id);
});

test('#91 DB settlement keeps the original UTC day across midnight/timezones; stale identity and unknown update commit are safe', async () => {
  const f = await fixture();
  await query(`insert into welcome_grants(chain_id,owner,portfolio_id,account,amount_wei,created_at,updated_at)
    values(97,$1,$2,$3,$4,'2000-01-01T23:59:59Z','2000-01-01T23:59:59Z')`, [f.owner, f.id, f.account, WELCOME_AMOUNT_WEI.toString()]);
  const g = await findWelcomeGrant(97, f.owner); assert.ok(g); assert.equal(g.day, '2000-01-01');
  const txHash = hash();
  await assert.rejects(settleWelcomeGrant({ ...g, account: address() }, 'submitted', txHash), denied('WELCOME_STORAGE_UNAVAILABLE'));
  const lost: typeof withTransaction = async fn => { await withTransaction(async client => { await client.query("set local time zone 'Pacific/Kiritimati'"); return fn(client); }); throw new Error('SECRET_COMMIT'); };
  await assert.rejects(settleWelcomeGrant(g, 'submitted', txHash, undefined, lost), denied('WELCOME_STORAGE_UNAVAILABLE'));
  const committed = await findWelcomeGrant(97, f.owner); assert.ok(committed);
  assert.equal(committed.state, 'submitted'); assert.equal(committed.day, '2000-01-01'); assert.equal(committed.txHash, txHash);
  await assert.rejects(settleWelcomeGrant(g, 'failed', null), denied('WELCOME_STORAGE_UNAVAILABLE'));
  const replay = await reserveWelcomeGrant(f.recipient, { ...welcomeConfig, siteDailyWei: 0n });
  assert.equal(replay.created, false); assert.equal(replay.grant.id, g.id);
});

test('#91 DB reservation rollback/unknown commit, statement failure and date-lock timeout never authorize a send', async () => {
  const f = await fixture();
  const rollback: typeof withTransaction = fn => withTransaction(async client => { await fn(client); throw new Error('SECRET'); });
  await assert.rejects(reserveWelcomeGrant(f.recipient, welcomeConfig, rollback), denied('WELCOME_STORAGE_UNAVAILABLE'));
  assert.equal(await findWelcomeGrant(97, f.owner), null);
  const blocker = await getPool().connect();
  try {
    await blocker.query('begin'); await blocker.query("select pg_advisory_xact_lock(hashtextextended('welcome_grants:97:'||to_char(now() at time zone 'UTC','YYYY-MM-DD'),0))");
    await assert.rejects(reserveWelcomeGrant(f.recipient, { ...welcomeConfig, timeoutMs: 20 }), denied('WELCOME_STORAGE_UNAVAILABLE'));
  } finally { await blocker.query('rollback'); blocker.release(); }
  const lost: typeof withTransaction = async fn => { await withTransaction(fn); throw new Error('SECRET_COMMIT'); };
  await assert.rejects(reserveWelcomeGrant(f.recipient, welcomeConfig, lost), denied('WELCOME_STORAGE_UNAVAILABLE'));
  assert.ok(await findWelcomeGrant(97, f.owner));
  const result = await f.service.buyFunding(f.id, f.owner, {});
  assert.equal(result.state, 'pending'); assert.equal(f.sends(), 0);
});

test('#91 DB unknown hash commit does not broadcast; durable submitted/unknown hash blocks every relayer nonce until reconciliation', async () => {
  const f = await fixture(); let sends = 0;
  const service = createWelcomeService({ config: welcomeConfig, prepare: async () => ({ hash: f.rpc.state.txHash, broadcast: async () => { sends++; }, wait: async () => {} }),
    settle: async (g, state, hash, evidence) => { await settleWelcomeGrant(g, state, hash, evidence); throw new AppError(503, 'WELCOME_STORAGE_UNAVAILABLE', 'unknown commit'); } });
  await assert.rejects(service.issue(f.recipient), denied('WELCOME_STORAGE_UNAVAILABLE')); assert.equal(sends, 0);
  let g = await findWelcomeGrant(97, f.owner); assert.equal(g?.state, 'submitted'); assert.ok(g);
  for (const state of ['submitted', 'unknown'] as const) {
    if (state === 'unknown') { await settleWelcomeGrant(g, 'unknown', g.txHash); g = { ...g, state: 'unknown' }; }
    let entered = false;
    await assert.rejects(withRelayerLock(97, async () => { entered = true; }), denied('RELAYER_BUSY')); assert.equal(entered, false);
    assert.equal((await createWelcomeService({ config: welcomeConfig }).issue(f.recipient)).txHash, g.txHash);
  }
  await settleWelcomeGrant(g, 'failed', g.txHash);
  await withRelayerLock(97, async held => held());
});

test('#91 DB grant confirmation survives lot rollback and unknown cash commit; recovery credits only once', async () => {
  for (const mode of ['rollback', 'unknown-commit']) {
    const f = await fixture();
    const transaction: typeof withTransaction = mode === 'rollback' ? fn => withTransaction(async client => { await fn(client); throw new Error('SECRET'); })
      : async fn => { await withTransaction(fn); throw new Error('SECRET'); };
    // First mint and grant confirmation are real. Inject only the lot/cash transaction.
    await f.deps.welcome?.issue(f.recipient);
    const grant = await findWelcomeGrant(97, f.owner); assert.ok(grant);
    const service = createPortfolioStrategyService({ ...f.deps, transaction });
    await assert.rejects(service.funding(f.id, f.owner, { source: { kind: 'welcome_grant', grantId: grant.id } }), denied('EXECUTION_STORAGE_UNAVAILABLE'));
    assert.equal((await findWelcomeGrant(97, f.owner))?.state, 'confirmed');
    assert.equal((await query('select id from strategy_funding_lots where portfolio_id=$1', [f.id])).rows.length, mode === 'rollback' ? 0 : 1);
    const recovered = await f.service.buyFunding(f.id, f.owner, {});
    assert.equal(recovered.lot?.replayed, mode === 'unknown-commit'); assert.equal(f.sends(), 1);
    assert.deepEqual(await cash(f.id), { hold: (WELCOME_AMOUNT_WEI / 2n).toString(), stack: '0', allocated: (WELCOME_AMOUNT_WEI / 2n).toString() });
  }
});

test('#91 DB missing proof, RPC error, enrollment mismatch and stale settlement never create a welcome lot', async () => {
  for (const scenario of ['missing', 'rpc', 'version', 'before-active', 'settlement']) {
    const f = await fixture(); await f.deps.welcome?.issue(f.recipient);
    if (scenario === 'missing') f.rpc.state.logs = false;
    if (scenario === 'rpc') f.rpc.state.fail = 'eth_getTransactionReceipt';
    if (scenario === 'version') { f.rpc.state.latestBlockNumber = 131n; f.rpc.state.historicalPinned = 2; }
    if (scenario === 'before-active') { f.rpc.state.latestBlockNumber = 131n; f.rpc.state.historicalNow--; }
    const service = scenario === 'settlement' ? createPortfolioStrategyService({ ...f.deps, settleWelcome: async () => { throw new AppError(503, 'WELCOME_STORAGE_UNAVAILABLE', 'SECRET omitted'); } }) : f.service;
    await assert.rejects(service.buyFunding(f.id, f.owner, {}));
    assert.equal((await query('select id from strategy_funding_lots where portfolio_id=$1', [f.id])).rows.length, 0);
    const g = await findWelcomeGrant(97, f.owner);
    if (g && !['confirmed', 'failed'].includes(g.state)) await settleWelcomeGrant(g, 'failed', g.txHash);
  }
});

test('#91 DB reorg, moved Transfer and reverted confirmed mint freeze original lot and future work without changing grant or cash', async () => {
  for (const scenario of ['block', 'log', 'revert']) {
    const f = await fixture(); await f.service.buyFunding(f.id, f.owner, {});
    const original = await findWelcomeGrant(97, f.owner);
    if (scenario === 'block') f.rpc.state.blockHash = hash();
    if (scenario === 'log') f.rpc.state.logIndex++;
    if (scenario === 'revert') f.rpc.state.success = false;
    await assert.rejects(f.service.buyFunding(f.id, f.owner, {}), denied('FUNDING_REORGED'));
    assert.deepEqual(await findWelcomeGrant(97, f.owner), original);
    assert.deepEqual((await query('select state from strategy_funding_lots where portfolio_id=$1', [f.id])).rows, [{ state: 'reorged' }]);
    await assert.rejects(f.service.executionState(f.id, f.owner, { enabled: true }), denied('FUNDING_REORGED'));
    assert.equal(f.sends(), 1);
  }
});

test('#91 DB first submitted mint definitively reverted becomes failed without lot; lifetime retry uses daily faucet', async () => {
  const f = await fixture();
  await f.deps.welcome?.issue(f.recipient);
  f.rpc.state.success = false; f.rpc.state.cashRaw = 0n;
  await assert.rejects(f.service.buyFunding(f.id, f.owner, {}), denied('WELCOME_REVERTED'));
  assert.equal((await findWelcomeGrant(97, f.owner))?.state, 'failed');
  assert.equal((await query('select id from strategy_funding_lots where portfolio_id=$1', [f.id])).rows.length, 0);
  await assert.rejects(f.service.buyFunding(f.id, f.owner, {}), denied('DAILY_FAUCET_REQUIRED'));
  assert.equal(f.sends(), 1);
  await withRelayerLock(97, async held => held());
});

test('#91 DB same-day daily 1000 is independent from welcome and each explicit source makes one lot (11000 total)', async () => {
  const f = await fixture(); await f.service.buyFunding(f.id, f.owner, {});
  const amountWei = 1000n * 10n ** 18n;
  const daily = await reserveFaucetClaim({ owner: f.owner, account: f.account, config: { chainId: 97, amountWei, siteDailyWei: 1_000_000n * 10n ** 18n, timeoutMs: 5000 } });
  const txHash = hash(); await settleFaucetClaim(daily, 'reserved', 'submitted', txHash);
  f.rpc.state.mint = false; f.rpc.state.txHash = txHash; f.rpc.state.amount = amountWei; f.rpc.state.cashRaw += amountWei;
  try {
    const source = { source: { kind: 'faucet_claim', claimId: daily.id } };
    assert.equal((await f.service.funding(f.id, f.owner, source)).replayed, false);
    assert.equal((await f.service.funding(f.id, f.owner, source)).replayed, true);
    const rows = (await query<{ total: string; n: string }>('select sum(amount_raw)::text as total,count(*)::text as n from strategy_funding_lots where portfolio_id=$1', [f.id])).rows[0];
    assert.deepEqual(rows, { total: (WELCOME_AMOUNT_WEI + amountWei).toString(), n: '2' });
  } finally {
    // Keep the FK/audit source, but move this isolated daily fixture out of other tests' current-day cap.
    await query("update faucet_claims set created_at='2000-01-01T00:00:00Z' where id=$1", [daily.id]);
  }
});

test('#91 DB buy rejects malformed/foreign/mainnet/RPC-error requests; existing transferred cash never becomes a product lot', async () => {
  const f = await fixture();
  for (const input of [null, [], { amount: '10000' }, { account: f.account }]) await assert.rejects(f.service.buyFunding(f.id, f.owner, input), denied('INVALID_PURCHASE'));
  await assert.rejects(f.service.buyFunding(f.id, address(), {}), denied('FORBIDDEN'));
  await assert.rejects(createPortfolioStrategyService({ ...f.deps, chainId: () => 56 }).buyFunding(f.id, f.owner, {}), denied('FUNDING_SOURCE_DISABLED'));
  f.rpc.state.fail = 'eth_call'; await assert.rejects(f.service.buyFunding(f.id, f.owner, {})); f.rpc.state.fail = '';
  f.rpc.state.cashRaw = 1n;
  assert.equal((await f.service.buyFunding(f.id, f.owner, {})).funding, 'existing_cash');
  assert.equal(await findWelcomeGrant(97, f.owner), null); assert.equal(await cash(f.id), undefined); assert.equal(f.sends(), 0);
});
