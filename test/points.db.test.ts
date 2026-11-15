import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { closePool, query, withTransaction } from '../src/db.js';
import { AppError } from '../src/errors.js';
import { bindInvite, createPointsService, freezePoints, inviteCode, inviteStats, pointsBalance, pointsHistory, pointsLeaderboard,
  recordPointsOperation, rewardInvite, settlePointsEvent } from '../src/points.js';
import { OWNER, ACCOUNT, address, catalog, config, enrolled, hash, jsonObject, OCCURRED, operation, reader, receipt, registered, swapped, transfer } from './fixtures/points.js';
import { createServer } from '../src/server.js';
const c = config();
const errorCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code && !error.message.includes('secret');
const limited = errorCode('POINTS_DAILY_LIMIT');
const unavailable = errorCode('POINTS_STORAGE_UNAVAILABLE');

async function clean() {
  const foreign = await query("select owner from points_owners where owner not like '0x670067%' limit 1");
  assert.equal(foreign.rows.length, 0, 'points tests require isolated disposable tables');
  await query('truncate points_invite_rewards,points_events,points_invites,points_invite_codes,points_owners restart identity');
  await query("delete from enrollment_intents where user_id like '0x670067%'");
  await query("delete from portfolios where user_id like '0x670067%'");
  await query("delete from strategies where provider like '0x670067%'");
  await query("delete from priceable_assets where address=$1 and symbol='POINTSTEST'", [address(204)]);
}
beforeEach(clean);
after(async () => { await clean(); await closePool(); });
async function clock() { const row = (await query<{ at: Date }>("select date_trunc('milliseconds',clock_timestamp()) as at")).rows[0]; assert.ok(row); return row.at; }
async function fresh(id = 1) {
  await query('select pg_sleep(0.002)');
  return { ...operation(id), occurredAt: await clock() };
}
async function binding(invitee = OWNER, inviter = address(2)) {
  const code = await inviteCode(inviter, c);
  await bindInvite(code, invitee, c);
}

test('#67 Postgres daily count/points 0, exact cap and +1; zero score still consumes a count', async () => {
  for (const rule of [{ points: 10n, dailyCount: 0n, dailyPoints: 100n }, { points: 10n, dailyCount: 1n, dailyPoints: 9n },
    { points: 10n, dailyCount: 1n, dailyPoints: 10n }, { points: 10n, dailyCount: 1n, dailyPoints: 11n },
    { points: 0n, dailyCount: 1n, dailyPoints: 0n }]) {
    await clean(); const conf = { ...config(), rules: { ...config().rules, deposit: rule } };
    if (rule.dailyCount === 0n || rule.dailyPoints < rule.points) await assert.rejects(recordPointsOperation(operation(), conf), limited);
    else {
      const row = await recordPointsOperation(operation(), conf);
      assert.equal(row.points, rule.points.toString());
      await assert.rejects(recordPointsOperation(operation(2), conf), limited);
    }
  }
});

test('#67 real concurrent retries are one immutable award; counts/sums are shared across owner accounts and chains', async () => {
  const conf = config(); conf.rules.deposit.dailyCount = 1n;
  const retries = await Promise.all(Array.from({ length: 12 }, () => recordPointsOperation(operation(), conf)));
  assert.equal(new Set(retries.map((r) => r.id)).size, 1);
  await clean();
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => recordPointsOperation({ ...operation(i + 1), chainId: i % 2 === 0 ? 1337 : 97 }, conf)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected' && limited(r.reason)).length, 11);
  const row = (await query<{ n: string; sum: string }>('select count(*)::text as n,sum(points)::text as sum from points_events')).rows[0];
  assert.deepEqual(row, { n: '1', sum: '10' });
  await recordPointsOperation({ ...operation(20), owner: address(3) }, conf);
});

test('#67 retries preserve score/day/delay through config changes, timezone and process restart; mismatched facts conflict', async () => {
  const conf = config(); conf.delaySeconds = 86400;
  const op = operation();
  const event = await recordPointsOperation(op, conf, (fn) => withTransaction(async (client) => { await client.query("set local time zone 'Pacific/Kiritimati'"); return fn(client); }));
  assert.equal(event.utc_day, '2026-01-01');
  assert.equal(event.available_at.getTime(), OCCURRED.getTime() + 86400000);
  conf.rules.deposit.points = 99n; conf.rules.deposit.dailyCount = 0n; conf.delaySeconds = 0;
  assert.deepEqual(await recordPointsOperation(op, conf), event);
  const source = `import { recordPointsOperation } from './src/points.ts'; import { operation,config } from './test/fixtures/points.ts'; import { closePool } from './src/db.ts';
    try { const c=config(); c.rules.deposit.points=999n; const r=await recordPointsOperation(operation(),c); console.log(r.id+':'+r.points); } finally { await closePool(); }`;
  assert.equal(execFileSync(process.execPath, ['--eval', source], { encoding: 'utf8', env: process.env, timeout: 10000 }).trim(), event.id + ':10');
  for (const change of [{ owner: address(2) }, { kind: 'withdraw' as const }, { occurredAt: new Date(OCCURRED.getTime() + 1) }]) {
    await assert.rejects(recordPointsOperation({ ...op, ...change }, c), errorCode('POINTS_SOURCE_CONFLICT'));
  }
  await recordPointsOperation({ ...operation(2), occurredAt: new Date(OCCURRED.getTime() + 86400000) }, c);
});

test('#67 pending reserves quota, delay cannot be bypassed, exact elapsed delay credits once with DB-assigned time', async () => {
  const conf = config(); conf.delaySeconds = 86400; conf.rules.deposit.dailyCount = 1n;
  const op = await fresh(); const event = await recordPointsOperation(op, conf);
  await settlePointsEvent(event.id, conf);
  assert.deepEqual(await pointsBalance(OWNER), { owner: OWNER, totalPoints: '0', pendingPoints: '10', frozen: false });
  await assert.rejects(recordPointsOperation({ ...op, txHash: hash(2) }, conf), limited);
  await assert.rejects(query("update points_events set state='credited',updated_at=clock_timestamp() where id=$1", [event.id]), /not available/);
  await clean();
  const at = await clock(); const elapsed = { ...operation(), occurredAt: new Date(at.getTime() - 1000) };
  const boundary = await recordPointsOperation(elapsed, { ...conf, delaySeconds: 1 });
  assert.equal(boundary.available_at.getTime(), at.getTime());
  await Promise.all([settlePointsEvent(boundary.id, conf), settlePointsEvent(boundary.id, conf)]);
  assert.equal((await pointsBalance(OWNER)).totalPoints, '10');
  const credited = (await query<{ credited_at: Date; available_at: Date }>('select credited_at,available_at from points_events')).rows[0];
  assert.ok(credited && credited.credited_at >= credited.available_at);
});

test('#67 balance reads one consistent snapshot while credits consume pending reservations', async () => {
  const events = await Promise.all(Array.from({ length: 10 }, (_, i) => recordPointsOperation(operation(i + 1), c)));
  const balances = await Promise.all(events.flatMap((event) => [pointsBalance(OWNER), settlePointsEvent(event.id, c).then(() => pointsBalance(OWNER))]));
  for (const balance of balances) assert.equal(BigInt(balance.totalPoints) + BigInt(balance.pendingPoints), 100n);
  assert.equal((await pointsBalance(OWNER)).totalPoints, '100');
});

test('#67 void is terminal, releases only the original quota, reverses totals and keeps source keys', async () => {
  const conf = config(); conf.rules.deposit.dailyCount = 1n;
  const event = await recordPointsOperation(operation(), conf);
  await settlePointsEvent(event.id, conf); assert.equal((await pointsBalance(OWNER)).totalPoints, '10');
  await settlePointsEvent(event.id, conf, true); await settlePointsEvent(event.id, conf, true);
  assert.equal((await pointsBalance(OWNER)).totalPoints, '0');
  assert.equal((await recordPointsOperation(operation(), conf)).state, 'void');
  await settlePointsEvent(event.id, conf); assert.equal((await pointsBalance(OWNER)).totalPoints, '0');
  await recordPointsOperation(operation(2), conf);
  await assert.rejects(query('delete from points_events where id=$1', [event.id]), /retained/);
});

test('#67 freezes serialize with credit, hide owners immediately, retain balances and restore them on unfreeze', async () => {
  const event = await recordPointsOperation(operation(), c);
  await assert.rejects(freezePoints({ owner: OWNER, frozen: true, reason: ' ' }, address(9), c), errorCode('POINTS_INVALID_REQUEST'));
  await freezePoints({ owner: OWNER, frozen: true, reason: 'review' }, address(9), c);
  await settlePointsEvent(event.id, c); assert.equal((await pointsBalance(OWNER)).totalPoints, '0');
  assert.deepEqual((await pointsLeaderboard({})).items, []);
  await freezePoints({ owner: OWNER, frozen: false }, address(9), c);
  await settlePointsEvent(event.id, c);
  await Promise.all([freezePoints({ owner: OWNER, frozen: true, reason: 'review' }, address(9), c), settlePointsEvent(event.id, c)]);
  assert.equal((await pointsBalance(OWNER)).totalPoints, '10'); assert.deepEqual((await pointsLeaderboard({})).items, []);
  await freezePoints({ owner: OWNER, frozen: false }, address(9), c);
  assert.deepEqual((await pointsLeaderboard({})).items, [{ owner: OWNER, total_points: '10' }]);
});

test('#67 real leaderboard keyset sorts numerically, handles ties, zero and very large scores with no lost page rows', async () => {
  for (const [index, score] of [0n, 9n, 100n, 20n, 20n, 9007199254740993n].entries()) {
    const conf = config(); conf.rules.deposit = { points: score, dailyCount: 1n, dailyPoints: score };
    const event = await recordPointsOperation(operation(index + 1, address(index + 1)), conf); await settlePointsEvent(event.id, conf);
  }
  const full = (await pointsLeaderboard({ limit: '100' })).items;
  assert.deepEqual(full.map((r) => r.total_points), ['9007199254740993', '100', '20', '20', '9', '0']);
  const seen: typeof full = []; let cursor: { score: string; owner: string } | null = null;
  do { const page = await pointsLeaderboard({ limit: '2', ...cursor }); seen.push(...page.items); cursor = page.next; } while (cursor);
  assert.deepEqual(seen, full);
  for (const params of [{ limit: '0' }, { limit: '101' }, { score: '1' }, { score: '1.5', owner: OWNER }, { score: '0', owner: 'x' }]) await assert.rejects(pointsLeaderboard(params), errorCode('POINTS_INVALID_REQUEST'));
});

test('#67 invite code uniqueness, case sensitivity, collision retry, one binding, self-invite and graph cycles', async () => {
  const original = await inviteCode(OWNER, c);
  assert.equal((await inviteCode(OWNER, c)).code, original.code);
  let generated = 0;
  const second = await inviteCode(address(2), c, () => ++generated === 1 ? original.code : 'abcdefghABCDEFGH');
  assert.equal(generated, 2);
  await assert.rejects(bindInvite(original, OWNER, c), errorCode('INVITE_CYCLE'));
  await bindInvite(original, address(2), c);
  await assert.rejects(bindInvite(second, OWNER, c), errorCode('INVITE_CYCLE'));
  await assert.rejects(bindInvite(original, address(2), c), errorCode('INVITE_INELIGIBLE'));
  await assert.rejects(bindInvite({ code: 'ABCDEFGHabcdefgh' }, address(3), c), errorCode('POINTS_INVALID_REQUEST'));
  await assert.rejects(inviteCode(address(4), c, () => original.code), unavailable);
  const attempts = await Promise.allSettled([bindInvite(original, address(3), c), bindInvite(second, address(3), c)]);
  assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((r) => r.status === 'rejected' && errorCode('INVITE_INELIGIBLE')(r.reason)).length, 1);
  const stats = await inviteStats(OWNER, c);
  // Either transaction may win: compare each inviter against the committed relation.
  assert.equal(stats.invited, attempts[0]?.status === 'fulfilled' ? '2' : '1');
  const otherStats = await inviteStats(address(2), c);
  assert.equal(otherStats.invited, attempts[1]?.status === 'fulfilled' ? '1' : '0');
  assert.equal(BigInt(stats.invited) + BigInt(otherStats.invited), 2n);
  assert.equal(stats.qualified, '0');
});

test('#67 concurrent inverse invitation edges cannot both commit a cycle', async () => {
  const a = await inviteCode(OWNER, c); const b = await inviteCode(address(2), c);
  const results = await Promise.allSettled([bindInvite(a, address(2), c), bindInvite(b, OWNER, c)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected' && errorCode('INVITE_CYCLE')(r.reason)).length, 1);
});

async function strategy() {
  const row = (await query<{ id: string }>("insert into strategies(provider,name,onchain_id) values($1,'points fixture',null) returning id::text", [OWNER])).rows[0]; assert.ok(row);
  await query("insert into strategy_versions(strategy_id,version,allocation,schedule) values($1,1,'{\"assets\":[]}','{}')", [row.id]);
  return row.id;
}
test('#67 C3 binding eligibility rejects any portfolio state or a prior enroll event', async () => {
  const code = await inviteCode(address(2), c); const id = await strategy();
  for (const state of ['idle', 'active', 'paused']) {
    const p = (await query<{ id: string }>('insert into portfolios(user_id,strategy_id,version,schedule_state) values($1,$2,1,$3) returning id::text', [OWNER, id, state])).rows[0]; assert.ok(p);
    await assert.rejects(bindInvite(code, OWNER, c), errorCode('INVITE_INELIGIBLE')); await query('delete from portfolios where id=$1', [p.id]);
  }
  await recordPointsOperation({ ...operation(), kind: 'enroll' }, c);
  await assert.rejects(bindInvite(code, OWNER, c), errorCode('INVITE_INELIGIBLE'));
});

test('#67 a saved intent without a successful enrollment does not permanently disqualify a new owner', async () => {
  const code = await inviteCode(address(2), c); const id = await strategy();
  await query('insert into enrollment_intents(user_id,strategy_id,chain_id,valid_until) values($1,$2,1337,1)', [OWNER, id]);
  assert.equal((await bindInvite(code, OWNER, c)).inviter, address(2));
});

test('#67 bind waits for concurrent enrollment insertion, then reads fresh eligibility instead of a pre-lock snapshot', async () => {
  const id = await strategy(); const code = await inviteCode(address(2), c);
  const blocker = new pg.Client({ connectionString: process.env.DATABASE_URL }); await blocker.connect();
  try {
    await blocker.query('begin');
    await blocker.query('insert into portfolios(user_id,strategy_id,version) values($1,$2,1)', [OWNER, id]);
    const result = assert.rejects(bindInvite(code, OWNER, { ...c, timeoutMs: 1000 }), errorCode('INVITE_INELIGIBLE'));
    await new Promise((resolve) => setTimeout(resolve, 20)); await blocker.query('commit'); await result;
    assert.equal((await query('select * from points_invites')).rows.length, 0);
  } finally { await blocker.query('rollback'); await blocker.end(); }
});

test('#67 bind rechecks an enroll ledger record after waiting for the same owner lock', async () => {
  const code = await inviteCode(address(2), c);
  const blocker = new pg.Client({ connectionString: process.env.DATABASE_URL }); await blocker.connect();
  try {
    await blocker.query('begin');
    await blocker.query('insert into points_owners(owner) values($1)', [OWNER]);
    const pending = assert.rejects(bindInvite(code, OWNER, { ...c, timeoutMs: 1000 }), errorCode('INVITE_INELIGIBLE'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await blocker.query("insert into points_events(owner,chain_id,kind,tx_hash,log_index,points,occurred_at,available_at) values($1,1337,'enroll',$2,0,10,$3,$3)", [OWNER, hash(8), OCCURRED]);
    await blocker.query('commit'); await pending;
  } finally { await blocker.query('rollback'); await blocker.end(); }
});

test('#67 delayed referral qualifies only after a valid post-binding operation, freezes either owner and voids atomically', async () => {
  await recordPointsOperation(operation(), c); await binding();
  await rewardInvite(OWNER, c); assert.equal((await pointsBalance(address(2))).totalPoints, '0');
  const op = await fresh(2); const delay = { ...c, delaySeconds: 86400 };
  const event = await recordPointsOperation(op, delay);
  await rewardInvite(OWNER, delay);
  assert.equal((await pointsBalance(address(2))).pendingPoints, '10');
  const row = (await query<{ available_at: Date }>('select available_at from points_invite_rewards')).rows[0]; assert.ok(row);
  assert.equal(row.available_at.getTime(), event.available_at.getTime());
  await settlePointsEvent(event.id, c, true);
  assert.equal((await pointsBalance(address(2))).pendingPoints, '0');
  assert.equal((await query<{ state: string }>('select state from points_invite_rewards')).rows[0]?.state, 'void');
  await clean(); await binding();
  const credited = await recordPointsOperation(await fresh(3), c);
  await settlePointsEvent(credited.id, c);
  for (const frozen of [OWNER, address(2)]) {
    await freezePoints({ owner: frozen, frozen: true, reason: 'review' }, address(9), c);
    await rewardInvite(OWNER, c); assert.equal((await pointsBalance(address(2))).totalPoints, '0');
    await freezePoints({ owner: frozen, frozen: false }, address(9), c);
  }
  await Promise.all([rewardInvite(OWNER, c), rewardInvite(OWNER, c)]);
  assert.equal((await pointsBalance(address(2))).totalPoints, '10');
  await settlePointsEvent(credited.id, c, true);
  assert.equal((await pointsBalance(address(2))).totalPoints, '0'); assert.equal((await pointsBalance(OWNER)).totalPoints, '0');
  await rewardInvite(OWNER, c);
  assert.equal((await query('select * from points_invite_rewards')).rows.length, 1);
});

test('#67 referral cap count/points boundaries, first source and history pagination include reward ledger', async () => {
  await binding(); const source = await recordPointsOperation(await fresh(), c); await settlePointsEvent(source.id, c);
  for (const dailyCount of [0n, 1n]) {
    const conf = config(); conf.rules.invite_reward.dailyCount = dailyCount;
    if (dailyCount === 0n) await assert.rejects(rewardInvite(OWNER, conf), limited); else await rewardInvite(OWNER, conf);
  }
  const second = await recordPointsOperation({ ...await fresh(2), owner: address(2) }, c); await settlePointsEvent(second.id, c);
  const full = await pointsHistory(address(2), {}); assert.equal(full.items.length, 2);
  const page = await pointsHistory(address(2), { limit: '1' }); assert.ok(page.next);
  const next = await pointsHistory(address(2), { limit: '1', before: page.next });
  assert.deepEqual([...page.items, ...next.items], full.items); assert.equal(next.next, null);
  assert.ok(full.items.some((r) => r.kind === 'invite_reward'));
  assert.equal((await pointsHistory(address(99), {})).items.length, 0);
  await assert.rejects(pointsHistory(OWNER, { before: 'malformed' }), errorCode('POINTS_INVALID_REQUEST'));
});

test('#67 referral points cap accepts equality and pending rewards reserve the inviter daily count', async () => {
  await binding();
  const source = await recordPointsOperation(await fresh(), c);
  const conf = config(); conf.rules.invite_reward = { points: 10n, dailyCount: 1n, dailyPoints: 9n };
  await assert.rejects(rewardInvite(OWNER, conf), limited);
  conf.rules.invite_reward.dailyPoints = 10n;
  await rewardInvite(OWNER, conf);
  assert.equal((await pointsBalance(address(2))).pendingPoints, '10');
  assert.equal((await pointsBalance(address(2))).totalPoints, '0');
  await binding(address(3));
  await recordPointsOperation({ ...await fresh(2), owner: address(3) }, c);
  await assert.rejects(rewardInvite(address(3), conf), limited);
  await settlePointsEvent(source.id, c);
  await rewardInvite(OWNER, conf);
  assert.equal((await pointsBalance(address(2))).totalPoints, '10');
});

test('#67 unavailable Postgres gives sanitized errors for every points storage entry point', () => {
  const script = `import { createPointsService } from './src/points.ts';
    import { config,OWNER } from './test/fixtures/points.ts'; import { closePool } from './src/db.ts';
    const service=createPointsService({ config:config() });
    try {
      const calls=[()=>service.balance(OWNER),()=>service.history(OWNER,{}),()=>service.leaderboard({}),
        ()=>service.invites(OWNER),()=>service.bind({code:'abcdefgh'},OWNER),
        ()=>service.freeze({owner:OWNER,frozen:true,reason:'review'},OWNER),()=>service.sync(),()=>service.metrics()];
      console.log(JSON.stringify(await Promise.all(calls.map(async fn=>{try { await fn(); return 'unexpected'; }
        catch(error) { if(error.message.includes('secret')) return 'leaked'; return error.code; }}))));
    } finally { await closePool(); }`;
  const output = execFileSync(process.execPath, ['--eval', script], { encoding: 'utf8', timeout: 10000,
    env: { ...process.env, DATABASE_URL: 'postgres://secret:secret@127.0.0.1:1/unavailable' } });
  assert.deepEqual(JSON.parse(output.trim()), Array.from({ length: 8 }, () => 'POINTS_STORAGE_UNAVAILABLE'));
});

test('#67 first referral source keeps canonical insertion order for equal occurrence timestamps', async () => {
  await binding(); const op = await fresh();
  const first = await recordPointsOperation({ ...op, txHash: `0x${'ff'.repeat(32)}`, logIndex: 2 }, c);
  await recordPointsOperation({ ...op, txHash: `0x${'01'.repeat(32)}`, logIndex: 3 }, c);
  await settlePointsEvent(first.id, c); await rewardInvite(OWNER, c);
  assert.equal((await query<{ qualifying_event_id: string }>('select qualifying_event_id::text from points_invite_rewards')).rows[0]?.qualifying_event_id, first.id);
});

test('#67 earlier verified but capped source revokes a later referral award without changing the business ledger', async () => {
  await binding(); const op = await fresh();
  const later = await recordPointsOperation(op, c); await settlePointsEvent(later.id, c); await rewardInvite(OWNER, c);
  assert.equal((await pointsBalance(address(2))).totalPoints, '10');
  await freezePoints({ owner: address(2), frozen: true, reason: 'review' }, address(9), c);
  await rewardInvite(OWNER, c, { ...op, txHash: hash(99) });
  assert.equal((await pointsBalance(address(2))).totalPoints, '0');
  assert.equal((await pointsBalance(OWNER)).totalPoints, '10');
});

test('#67 qualification preserves binding microseconds and rejects an operation just before the binding', async () => {
  const code = await inviteCode(address(2), c); await inviteCode(OWNER, c);
  await query("insert into points_invites(invitee,inviter,code,bound_at) values($1,$2,$3,'2026-01-01T00:00:00.000001Z')", [OWNER, address(2), code.code]);
  const event = await recordPointsOperation(operation(), c); await settlePointsEvent(event.id, c);
  await rewardInvite(OWNER, c);
  assert.equal((await query('select * from points_invite_rewards')).rows.length, 0);
});

test('#67 DB errors, lock timeouts and unknown commits are sanitized and reconciled through durable keys', async () => {
  await assert.rejects(recordPointsOperation(operation(), c, async () => { throw new Error('secret'); }), unavailable);
  await assert.rejects(recordPointsOperation(operation(), c, async (fn) => { await withTransaction(fn); throw new Error('secret unknown commit'); }), unavailable);
  const event = await recordPointsOperation(operation(), c); assert.equal(event.id, '1');
  const blocker = new pg.Client({ connectionString: process.env.DATABASE_URL }); await blocker.connect();
  try {
    await blocker.query('begin');
    await blocker.query("select pg_advisory_xact_lock(hashtextextended('points_events:'||$1::text||':deposit:2026-01-01',0))", [OWNER]);
    await assert.rejects(recordPointsOperation(operation(2), { ...c, timeoutMs: 10 }), unavailable);
    await assert.rejects(settlePointsEvent(event.id, { ...c, timeoutMs: 10 }), unavailable);
    await blocker.query('rollback');
    assert.equal((await query('select * from points_events')).rows.length, 1);
    await assert.rejects(settlePointsEvent(event.id, c, false, async (fn) => { await withTransaction(fn); throw new Error('secret unknown commit'); }), unavailable);
    await settlePointsEvent(event.id, c); assert.equal((await pointsBalance(OWNER)).totalPoints, '10');
  } finally { await blocker.query('rollback'); await blocker.end(); }
});

test('#67 integrated sync persists canonical operations across restart, no data/RPC error voids or double credits', async () => {
  const service = createPointsService({ config: c, reader: reader(), catalog: async () => catalog() });
  await service.sync(); await service.sync();
  assert.equal((await pointsBalance(OWNER)).totalPoints, '10');
  assert.equal((await query('select * from points_events')).rows.length, 1);
  for (const overrides of [{ receipt: async () => null }, { owner: async () => { throw new Error('secret'); } }]) {
    await assert.rejects(createPointsService({ config: c, reader: reader(overrides), catalog: async () => catalog() }).sync(), errorCode('POINTS_CHAIN_UNAVAILABLE'));
    assert.equal((await pointsBalance(OWNER)).totalPoints, '10');
  }
  const lost = catalog(); lost.accounts.clear();
  await assert.rejects(createPointsService({ config: c, reader: reader(), catalog: async () => lost }).sync(), errorCode('POINTS_CHAIN_UNAVAILABLE'));
  assert.equal((await pointsBalance(OWNER)).totalPoints, '10');
  await createPointsService({ config: c, reader: reader({ logs: async () => [], receipt: async () => ({ ...receipt([]), status: 'reverted' }) }), catalog: async () => catalog() }).sync();
  assert.equal((await pointsBalance(OWNER)).totalPoints, '0');
  assert.equal((await query<{ state: string }>('select state from points_events')).rows[0]?.state, 'void');
  await service.sync(); assert.equal((await pointsBalance(OWNER)).totalPoints, '0');
});

test('#67 changed or missing catalog facts are unknown evidence and never revoke canonical credits', async () => {
  const logs = [transfer(), { ...registered(), logIndex: 1 }];
  const chain = reader({ logs: async () => logs, receipt: async () => receipt(logs) });
  await createPointsService({ config: c, reader: chain, catalog: async () => catalog() }).sync();
  assert.equal((await pointsBalance(OWNER)).totalPoints, '20');
  for (const change of ['token', 'account owner', 'strategy owner', 'strategy name', 'missing strategy']) {
    const known = catalog();
    if (change === 'token') known.tokens.clear();
    if (change === 'account owner') known.accounts.set(ACCOUNT, { owner: address(9), strategy: '1' });
    if (change === 'strategy owner') known.strategies.set('1', { owner: address(9), name: 'Test fund' });
    if (change === 'strategy name') known.strategies.set('1', { owner: OWNER, name: 'missing original metadata' });
    if (change === 'missing strategy') known.strategies.clear();
    await assert.rejects(createPointsService({ config: c, reader: chain, catalog: async () => known }).sync(), errorCode('POINTS_CHAIN_UNAVAILABLE'));
    assert.equal((await pointsBalance(OWNER)).totalPoints, '20', change);
    assert.equal((await query("select * from points_events where state='void'")).rows.length, 0);
  }
});

test('#67 production catalog joins actual portfolios, accounts and funds; all five confirmed tasks survive sync retries', async () => {
  const id = await strategy();
  const onchain = 670067n;
  await query("update strategies set onchain_id=$2,name='Test fund' where id=$1", [id, onchain]);
  const portfolio = (await query<{ id: string }>('insert into portfolios(user_id,strategy_id,version) values($1,$2,1) returning id::text', [OWNER, id])).rows[0];
  assert.ok(portfolio);
  await query("insert into smart_accounts(portfolio_id,chain_id,address,owner,account_type) values($1,1337,$2,$3,'KERNEL')", [portfolio.id, ACCOUNT, OWNER]);
  await query("insert into priceable_assets(address,symbol,decimals) values($1,'POINTSTEST',18)", [address(204)]);
  const logs = [registered(onchain), enrolled(onchain), swapped(), transfer(), transfer(ACCOUNT, OWNER)]
    .map((log, logIndex) => ({ ...log, logIndex }));
  const service = createPointsService({ config: c, reader: reader({ logs: async () => logs, receipt: async () => receipt(logs) }) });
  await service.sync(); await service.sync();
  assert.equal((await pointsBalance(OWNER)).totalPoints, '50');
  assert.deepEqual((await service.metrics()).kinds, { enroll: 1, deposit: 1, rebalance: 1, create_fund: 1, withdraw: 1 });
  assert.equal((await query('select * from points_events')).rows.length, 5);
});

test('#67 a lost sync lock connection returns a sanitized error and never starts ledger writes', () => {
  const source = `import { createPointsService } from './src/points.ts'; import { query,closePool } from './src/db.ts';
    import { config,catalog,reader,transfer } from './test/fixtures/points.ts';
    const r=reader({ logs: async()=>{
      await query(\`select pg_terminate_backend(a.pid) from pg_stat_activity a where a.datname=current_database() and a.pid<>pg_backend_pid()
        and a.application_name='cre8-atp-backend' and exists(select 1 from pg_locks l where l.pid=a.pid and l.locktype='advisory' and l.granted
        and l.classid=((hashtextextended('points_sync:1337',0)>>32)&4294967295)::oid
        and l.objid=(hashtextextended('points_sync:1337',0)&4294967295)::oid and l.objsubid=1)\`);
      await new Promise(resolve=>setTimeout(resolve,20)); return [transfer()]; }});
    try { await createPointsService({config:config(),reader:r,catalog:async()=>catalog()}).sync(); console.log('unexpected'); }
    catch(error) { console.log(error.code); } finally { await closePool(); }`;
  const output = execFileSync(process.execPath, ['--eval', source], { encoding: 'utf8', env: process.env, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(output.trim(), 'POINTS_STORAGE_UNAVAILABLE');
});

test('#67 sync excludes other instances and always releases its session lock after RPC errors', async () => {
  const blocker = new pg.Client({ connectionString: process.env.DATABASE_URL }); await blocker.connect();
  const service = createPointsService({ config: c, reader: reader(), catalog: async () => catalog() });
  try {
    await blocker.query("select pg_advisory_lock(hashtextextended('points_sync:1337',0))");
    await assert.rejects(service.sync(), errorCode('POINTS_SYNC_BUSY'));
    await blocker.query("select pg_advisory_unlock(hashtextextended('points_sync:1337',0))");
    await assert.rejects(createPointsService({ config: c, reader: reader({ head: async () => { throw new Error('secret'); } }), catalog: async () => catalog() }).sync(), errorCode('POINTS_CHAIN_UNAVAILABLE'));
    await service.sync(); assert.equal((await pointsBalance(OWNER)).totalPoints, '10');
  } finally { await blocker.end(); }
});

test('#67 metrics include successful operations above scoring caps and referrals cannot replace a capped first operation', async () => {
  await binding(); const at = await fresh();
  const secondLog = { ...transfer(OWNER, ACCOUNT, 1n, 1), transactionHash: hash(2) };
  const known = catalog();
  const conf = config(); conf.rules.deposit.dailyCount = 1n;
  const chain = reader({ block: async () => ({ hash: receipt().blockHash, timestamp: BigInt(Math.ceil(at.occurredAt.getTime() / 1000)) }),
    logs: async () => [transfer(), secondLog], receipt: async (txHash) => ({ ...receipt(txHash === hash(1) ? [transfer()] : [secondLog]), transactionHash: txHash }) });
  const service = createPointsService({ config: conf, reader: chain, catalog: async () => known });
  const result = await service.sync(); assert.equal(result.operations, 2); assert.equal(result.capped, 1);
  assert.equal((await service.metrics()).successfulOperations, 2);
  assert.equal((await query('select * from points_events')).rows.length, 1);
  const source = await recordPointsOperation({ ...at, txHash: hash(3), kind: 'withdraw' }, c);
  await settlePointsEvent(source.id, c);
  // A complete scan's first source is authoritative even if the scoring task was disabled/capped.
  await clean(); await binding(); const later = await recordPointsOperation(await fresh(4), c); await settlePointsEvent(later.id, c);
  await rewardInvite(OWNER, c, { ...at, txHash: hash(5) });
  assert.equal((await query('select * from points_invite_rewards')).rows.length, 0);
});

test('#67 real HTTP balance, history, bind, invite stats and metrics use session identity and ignore no claimed owner', async () => {
  const service = createPointsService({ config: c, reader: reader(), catalog: async () => catalog() });
  const code = await inviteCode(address(2), c);
  const server = createServer({ points: service, operatorWallets: [OWNER],
    auth: { authenticate: async () => OWNER, issueNonce: () => { throw new Error('unexpected'); }, login: async () => { throw new Error('unexpected'); }, logout: async () => {} } });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addressInfo = server.address(); assert.ok(addressInfo && typeof addressInfo !== 'string'); const base = 'http://127.0.0.1:' + addressInfo.port;
  try {
    const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', body: JSON.stringify(body) });
    assert.equal((await post('/invites/bind', { ...code, owner: address(3) })).status, 400);
    assert.equal((await post('/invites/bind', code)).status, 200);
    const sync = await post('/operator/points/sync', {}); assert.equal(sync.status, 200);
    assert.equal(jsonObject(await (await fetch(base + '/points/me')).json()).owner, OWNER);
    const items = jsonObject(await (await fetch(base + '/points/history')).json()).items; assert.ok(Array.isArray(items)); assert.equal(items.length, 1);
    assert.equal(jsonObject(jsonObject(await (await fetch(base + '/invites/me')).json()).binding).inviter, address(2));
    assert.equal(jsonObject(await (await fetch(base + '/operator/points/metrics')).json()).successfulOperations, 1);
    assert.equal((await fetch(base + '/points/leaderboard?limit=0')).status, 400);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
