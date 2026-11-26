import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { signedFundingTx } from './fixtures/relayer.js';
import { closePool, query, withTransaction } from '../src/db.js';
import { reserveFaucetClaim, settleFaucetClaim } from '../src/faucet.js';
import { loadFaucetConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { withRelayerLock } from '../src/relayer-lock.js';
after(closePool);
const config = loadFaucetConfig({ CHAIN_ID: '97' });
assert.ok(config);
const c = config;
let baseline = 0n;
let ownerNamespace = randomBytes(6).toString('hex');
const owner = (i: number) => `0x690069${ownerNamespace}${i.toString(16).padStart(22, '0')}` as const;
const r = (i = 1) => ({ config: { ...c, siteDailyWei: c.siteDailyWei + baseline }, owner: owner(i), account: owner(i + 100) });
const quota = (error: unknown) => error instanceof AppError && error.code === 'FAUCET_QUOTA_EXCEEDED';
const storage = (error: unknown) => error instanceof AppError && error.code === 'FAUCET_STORAGE_UNAVAILABLE';
async function clean() {
  await query("update faucet_claims set state='failed',updated_at=clock_timestamp() where chain_id=97 and owner like '0x690069%' and state in ('reserved','submitted','unknown')");
  await query("delete from faucet_claims f where chain_id=97 and owner like '0x690069%' and not exists(select 1 from relayer_transaction_outbox o where o.faucet_claim_id=f.id)");
  ownerNamespace = randomBytes(6).toString('hex');
  baseline = BigInt((await query<{ used: string }>("select coalesce(sum(amount_wei),0)::text as used from faucet_claims where chain_id=97 and utc_day=(now() at time zone 'UTC')::date and state<>'failed'")).rows[0]?.used ?? '0');
}

test('#69 Postgres zero, exact site cap and +1; all non-failed states count, failed refunds owner and site', async () => {
  try {
    for (const cap of [0n, c.amountWei - 1n, c.amountWei, c.amountWei + 1n]) {
      await clean(); const input = r(); input.config.siteDailyWei = baseline + cap;
      if (cap < c.amountWei) await assert.rejects(reserveFaucetClaim(input), quota);
      else { await reserveFaucetClaim(input); await assert.rejects(reserveFaucetClaim({ ...input, account: owner(200) }), quota); }
    }
    await clean();
    await assert.rejects(reserveFaucetClaim({ ...r(), config: { ...c, amountWei: 0n } }), quota);
    for (const state of ['reserved', 'submitted', 'confirmed', 'unknown', 'failed'] as const) {
      await clean(); const input = r(); input.config.siteDailyWei = baseline + c.amountWei;
      const claim = await reserveFaucetClaim(input);
      if (state === 'submitted' || state === 'unknown' || state === 'confirmed') {
        const signed = await signedFundingTx('faucet', claim.account, claim.amountWei);
        await settleFaucetClaim(claim, 'reserved', 'submitted', signed.hash, withTransaction, signed);
        if (state !== 'submitted') await settleFaucetClaim(claim, 'submitted', state, signed.hash);
      } else if (state !== 'reserved') await settleFaucetClaim(claim, 'reserved', state, null);
      if (state === 'failed') await reserveFaucetClaim(input);
      else { await assert.rejects(reserveFaucetClaim(input), quota); await assert.rejects(reserveFaucetClaim({ ...input, owner: owner(2) }), quota); }
    }
  } finally { await clean(); }
});

test('#69 concurrent owners/instances share site cap, and same owner across accounts remains once', async () => {
  try {
    for (const sameOwner of [false, true]) {
      await clean();
      const outcomes = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => {
        const input = r(i + 1); input.config.siteDailyWei = baseline + (sameOwner ? c.siteDailyWei : c.amountWei);
        if (sameOwner) input.owner = owner(1);
        return reserveFaucetClaim(input);
      }));
      assert.equal(outcomes.filter((x) => x.status === 'fulfilled').length, 1);
      assert.equal(outcomes.filter((x) => x.status === 'rejected' && quota(x.reason)).length, 11);
    }
  } finally { await clean(); }
});

test('#69 UTC independent of session timezone; settlement locks original day and stale/immutable updates fail', async () => {
  try {
    await clean();
    const claim = await reserveFaucetClaim(r(), (fn) => withTransaction(async (client) => {
      await client.query("set local time zone 'Pacific/Kiritimati'"); return fn(client);
    }));
    assert.equal(claim.day, (await query<{ day: string }>("select to_char(now() at time zone 'UTC','YYYY-MM-DD') as day")).rows[0]?.day);
    await assert.rejects(settleFaucetClaim({ ...claim, amountWei: claim.amountWei + 1n }, 'reserved', 'failed', null), storage);
    await query("update faucet_claims set created_at=created_at-interval '1 day' where id=$1", [claim.id]);
    const old = { ...claim, day: new Date(Date.parse(claim.day) - 86400000).toISOString().slice(0, 10) };
    await settleFaucetClaim(old, 'reserved', 'unknown', null);
    await assert.rejects(settleFaucetClaim(old, 'reserved', 'failed', null), storage);
    await reserveFaucetClaim(r());
    assert.equal((await query<{ n: string }>("select count(*)::text as n from faucet_claims where owner=$1", [owner(1)])).rows[0]?.n, '2');
  } finally { await clean(); }
});

test('#69 unknown reservation commit remains charged across process restart', async () => {
  try {
    await clean();
    await assert.rejects(reserveFaucetClaim(r(), async (fn) => { await withTransaction(fn); throw new Error('unknown commit'); }), storage);
    const source = `import { reserveFaucetClaim } from './src/faucet.ts'; import { closePool } from './src/db.ts';
      try { await reserveFaucetClaim({ config: { chainId:97,amountWei:1000n*10n**18n,siteDailyWei:1000000n*10n**18n,timeoutMs:5000 },owner:'${owner(1)}',account:'${owner(500)}' }); console.log('unexpected'); }
      catch (e) { console.log(e.code); } finally { await closePool(); }`;
    const child = execFileSync(process.execPath, ['--eval', source], { encoding: 'utf8', timeout: 10000, env: process.env });
    assert.equal(child.trim(), 'FAUCET_QUOTA_EXCEEDED');
  } finally { await clean(); }
});

test('#69 lock timeout rolls back without insertion; unknown settlement commit never refunds', async () => {
  const blocker = new pg.Client({ connectionString: process.env.DATABASE_URL }); await blocker.connect();
  try {
    await clean(); await blocker.query('begin');
    await blocker.query("select pg_advisory_xact_lock(hashtextextended('faucet_claims:97:'||to_char(now() at time zone 'UTC','YYYY-MM-DD'),0))");
    await assert.rejects(reserveFaucetClaim({ ...r(), config: { ...c, timeoutMs: 20 } }), storage);
    await blocker.query('rollback');
    const claim = await reserveFaucetClaim(r());
    await assert.rejects(settleFaucetClaim(claim, 'reserved', 'unknown', null, async (fn) => { await withTransaction(fn); throw new Error('unknown commit'); }), storage);
    await assert.rejects(reserveFaucetClaim(r()), quota);
  } finally { await blocker.query('rollback'); await blocker.end(); await clean(); }
});

test('#69 cross-process relayer exclusion rejects busy work before quota reservation and releases after error', async () => {
  let entered = 0;
  await withRelayerLock(97, async () => {
    const source = `import { withRelayerLock } from './src/relayer-lock.ts'; import { closePool } from './src/db.ts';
      try { await withRelayerLock(97,async()=>console.log('unexpected')); } catch(e) { console.log(e.code); } finally { await closePool(); }`;
    const child = execFileSync(process.execPath, ['--eval', source], { encoding: 'utf8', timeout: 10000, env: process.env });
    assert.equal(child.trim(), 'RELAYER_BUSY');
    await assert.rejects(withRelayerLock(97, async () => { entered++; }), (e: unknown) => e instanceof AppError && e.code === 'RELAYER_BUSY');
  });
  await assert.rejects(withRelayerLock(97, async () => { throw new Error('action failed'); }), /action failed/);
  await withRelayerLock(97, async () => { entered++; });
  assert.equal(entered, 1);
});

test('#69 late broadcast after timeout blocks new relayer nonce work across processes until reconciliation', async () => {
  const { createFaucetService } = await import('../src/faucet.js');
  try {
    await clean(); let lateSend = 0; let secondPreparation = 0;
    const input = r();
    const signed = await signedFundingTx('faucet', input.account, c.amountWei);
    const service = createFaucetService({ config: { ...c, timeoutMs: 10 }, query: async () => ({ rows: [{ owner: input.owner, user_id: input.owner }] }),
      settle: (claim, from, to, hash, tx, submission) => settleFaucetClaim(claim, from, to, hash, tx, submission ? { ...submission, operator: signed.operator } : undefined),
      prepare: async () => ({ ...signed, broadcast: async () => { await new Promise((resolve) => setTimeout(resolve, 35)); lateSend++; }, receipt: async () => 'confirmed' }) });
    const result = await service.claim({ account: input.account }, input.owner);
    assert.equal(result.state, 'unknown');
    await assert.rejects(createFaucetService({ config: c, query: async () => ({ rows: [{ owner: owner(2), user_id: owner(2) }] }),
      prepare: async () => { secondPreparation++; throw new Error('must not prepare a second nonce'); } }).claim({ account: owner(102) }, owner(2)),
      (e: unknown) => e instanceof AppError && e.code === 'RELAYER_BUSY');
    const source = `import { withRelayerLock } from './src/relayer-lock.ts'; import { closePool } from './src/db.ts';
      try { await withRelayerLock(97,async()=>console.log('unexpected')); } catch(e) { console.log(e.code); } finally { await closePool(); }`;
    assert.equal(execFileSync(process.execPath, ['--eval', source], { encoding: 'utf8', timeout: 10000, env: process.env }).trim(), 'RELAYER_BUSY');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(lateSend, 1); assert.equal(secondPreparation, 0);
    const row = (await query<{ day: string }>("select to_char(utc_day,'YYYY-MM-DD') as day from faucet_claims where id=$1", [result.claimId])).rows[0]; assert.ok(row);
    // The injected broadcaster definitively completed; simulate verified settlement.
    await settleFaucetClaim({ id: result.claimId, chainId: 97, day: row.day, owner: input.owner, account: input.account, amountWei: c.amountWei }, 'unknown', 'confirmed', result.txHash);
    let resumed = false; await withRelayerLock(97, async () => { resumed = true; }); assert.equal(resumed, true);
  } finally { await clean(); }
});

test('#69 relayer DB acquire failure is sanitized and lost lock prevents the next broadcast', async () => {
  const source = `import { withRelayerLock } from './src/relayer-lock.ts'; import { closePool } from './src/db.ts';
    try { await withRelayerLock(97,async()=>console.log('unexpected')); } catch(e) { console.log(e.code); } finally { await closePool(); }`;
  assert.equal(execFileSync(process.execPath, ['--eval', source], { encoding: 'utf8', timeout: 10000,
    env: { ...process.env, DATABASE_URL: 'postgres://secret:secret@127.0.0.1:1/unavailable' } }).trim(), 'RELAYER_BUSY');
  const observer = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await observer.connect();
  try {
    await withRelayerLock(97, async (held) => {
      const killed = await observer.query<{ killed: boolean }>(`select pg_terminate_backend(a.pid) as killed from pg_stat_activity a
        where a.datname=current_database() and a.application_name='cre8-atp-backend' and a.pid <> pg_backend_pid()
        and exists(select 1 from pg_locks l where l.pid=a.pid and l.locktype='advisory' and l.granted
          and l.classid=((hashtextextended('backend:relayer:97',0)>>32)&4294967295)::oid
          and l.objid=(hashtextextended('backend:relayer:97',0)&4294967295)::oid and l.objsubid=1)`);
      assert.equal(killed.rows.length, 1); assert.equal(killed.rows[0]?.killed, true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.throws(held, (e: unknown) => e instanceof AppError && e.code === 'RELAYER_BUSY');
    });
    await withRelayerLock(97, async (held) => held());
  } finally { await observer.end(); }
});

test('#97 daily faucet replay survives service reconstruction, keeps original values, rejects another recipient and uses UTC day', async () => {
  const { randomBytes } = await import('node:crypto');
  const { createFaucetService, findDailyFaucetClaim } = await import('../src/faucet.js');
  const controllingOwner = `0x${randomBytes(20).toString('hex')}` as const;
  const recipient = `0x${randomBytes(20).toString('hex')}` as const;
  const ids: string[] = [];
  try {
    const claim = await reserveFaucetClaim({ config: c, owner: controllingOwner, account: recipient }); ids.push(claim.id);
    const service = () => createFaucetService({ config: { ...c, amountWei: 0n, siteDailyWei: 0n },
      query: async () => ({ rows: [{ owner: controllingOwner, user_id: controllingOwner }] }),
      lock: async () => { throw new Error('must not acquire relayer lock'); },
    });
    assert.deepEqual(await service().claim({ account: recipient }, controllingOwner), { claimId: claim.id, state: 'reserved', amountWei: c.amountWei.toString(), txHash: null, replayed: true });
    await query("update faucet_claims set state='confirmed',tx_hash=$2,updated_at=clock_timestamp() where id=$1", [claim.id, `0x${randomBytes(32).toString('hex')}`]);
    const saved = await findDailyFaucetClaim(97, controllingOwner, recipient); assert.ok(saved);
    assert.deepEqual(await service().claim({ account: recipient }, controllingOwner), saved);
    await assert.rejects(service().claim({ account: owner(1999) }, controllingOwner), quota);
    assert.equal(await findDailyFaucetClaim(97, owner(1998), recipient), null);
    await query("update faucet_claims set created_at=created_at-interval '1 day' where id=$1", [claim.id]);
    assert.equal(await findDailyFaucetClaim(97, controllingOwner, recipient), null);
    const next = await reserveFaucetClaim({ config: c, owner: controllingOwner, account: recipient }); ids.push(next.id);
    assert.equal((await service().claim({ account: recipient }, controllingOwner)).claimId, next.id);
  } finally { for (const id of ids) await query('delete from faucet_claims where id=$1', [id]); }
});
