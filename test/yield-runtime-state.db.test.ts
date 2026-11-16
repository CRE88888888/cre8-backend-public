import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { after, test } from 'node:test';
import pg from 'pg';
import { closePool, query, withTransaction } from '../src/db.js';
import { readYieldState, writeYieldState } from '../src/yield-runtime-state.js';

after(closePool);
const name = (kind: string) => `${kind}-${randomUUID()}`;

test('#113 runtime facts and releases are immutable, JSON-equivalent retries survive another process', async () => {
  for (const prefix of ['auth', 'fact', 'release']) {
    const key = name(prefix), value = { nonce: '0', account: 'fixture', evidence: [{ block: '1' }] };
    assert.equal(await readYieldState(key), null);
    await Promise.all(Array.from({ length: 5 }, () => writeYieldState(key, value)));
    await writeYieldState(key, { evidence: [{ block: '1' }], account: 'fixture', nonce: '0' });
    assert.deepEqual(await readYieldState(key), value);
    assert.equal((await query('select name from yield_runtime_state where name=$1', [key])).rows.length, 1);
    const source = `import {readYieldState,writeYieldState} from './src/yield-runtime-state.ts';import {closePool} from './src/db.ts';
      try{const v=JSON.parse(process.env.RUNTIME_VALUE);await writeYieldState(process.env.RUNTIME_NAME,v);console.log(JSON.stringify(await readYieldState(process.env.RUNTIME_NAME)));}finally{await closePool();}`;
    const output = execFileSync(process.execPath, ['--no-env-file', '--eval', source], { encoding: 'utf8', timeout: 10000,
      env: { ...process.env, RUNTIME_NAME: key, RUNTIME_VALUE: JSON.stringify(value) } });
    assert.deepEqual(JSON.parse(output.trim()), value);
    await assert.rejects(writeYieldState(key, { ...value, nonce: '1' }), /^Error: yield state unavailable$/);
    assert.deepEqual(await readYieldState(key), value);
  }
});

test('#113 concurrent conflicting immutable writers keep exactly one original fact', async () => {
  const key = name('auth');
  const results = await Promise.allSettled([writeYieldState(key, { nonce: '0' }), writeYieldState(key, { nonce: '1' })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  const saved=await readYieldState(key);assert.ok(saved&&typeof saved==='object'&&'nonce' in saved);
  assert.ok(saved.nonce==='0'||saved.nonce==='1');
});

test('#113 cursor permits zero, maximum safe ID and wraparound while its timestamp never decreases', async () => {
  const key = name('cursor');
  let updated = new Date(0);
  for (const value of [0, Number.MAX_SAFE_INTEGER, 0, 42, 42]) {
    await writeYieldState(key, value);
    assert.equal(await readYieldState(key), value);
    const row = (await query<{ kind: string; updated_at: Date }>('select kind,updated_at from yield_runtime_state where name=$1', [key])).rows[0];
    assert.ok(row); assert.equal(row.kind, 'cursor'); assert.ok(row.updated_at >= updated); updated = row.updated_at;
  }
  await query("update yield_runtime_state set updated_at=updated_at+interval '1 day' where name=$1",[key]);
  const future=(await query<{updated_at:Date}>('select updated_at from yield_runtime_state where name=$1',[key])).rows[0]?.updated_at;
  assert.ok(future);await writeYieldState(key,0);
  assert.deepEqual((await query<{updated_at:Date}>('select updated_at from yield_runtime_state where name=$1',[key])).rows[0]?.updated_at,future);
});

test('#113 runtime evidence and authorization facts share commit and rollback with the caller', async () => {
  const fact = name('auth'), release = name('release'), cursor = name('cursor');
  await assert.rejects(withTransaction(async db => {
    const sql = (text: string, params?: readonly unknown[]) => db.query(text, params ? [...params] : []);
    await writeYieldState(fact, { nonce: '0' }, sql);
    await writeYieldState(release, { reason: 'fixture' }, sql);
    await writeYieldState(cursor, 0, sql);
    assert.deepEqual(await readYieldState(fact, sql), { nonce: '0' });
    throw new Error('injected rollback');
  }), /injected rollback/);
  assert.equal(await readYieldState(fact), null); assert.equal(await readYieldState(release), null);
  assert.equal(await readYieldState(cursor), null);
});

test('#113 runtime DB read/write timeouts and missing schema reject with safe errors', async () => {
  const blocker = new pg.Client({ connectionString: process.env.DATABASE_URL }); await blocker.connect();
  const key = name('auth');
  const unavailable = async (read: boolean) => assert.rejects(withTransaction(async db => {
    await db.query("set local statement_timeout='25ms'");
    const sql = (text: string, params?: readonly unknown[]) => db.query(text, params ? [...params] : []);
    if (read) await readYieldState(key, sql); else await writeYieldState(key, { nonce: '0' }, sql);
  }), /^Error: yield state unavailable$/);
  try {
    await blocker.query('begin'); await blocker.query('lock table yield_runtime_state in access exclusive mode');
    await unavailable(true); await unavailable(false);
  } finally { await blocker.query('rollback'); await blocker.end(); }
  for (const read of [true, false]) await assert.rejects(withTransaction(async db => {
    await db.query('set local search_path=pg_catalog');
    const sql = (text: string, params?: readonly unknown[]) => db.query(text, params ? [...params] : []);
    if (read) await readYieldState(key, sql); else await writeYieldState(key, { nonce: '0' }, sql);
  }), /^Error: yield state unavailable$/);
  assert.equal(await readYieldState(key), null);
});


test('#113 runtime key length boundary and DB sensitive-field checks retain the original state',async()=>{
  const key='fact-'+randomUUID()+'x'.repeat(159);
  assert.equal(key.length,200);await writeYieldState(key,{nonce:'0'});
  assert.deepEqual(await readYieldState(key),{nonce:'0'});
  await assert.rejects(writeYieldState(key+'x',{nonce:'0'}),/^Error: yield state unavailable$/);
  for(const field of ['signature','paymasterSignature','privateKey','seed']){
    const blocked=name('fact');
    await assert.rejects(writeYieldState(blocked,{[field]:'fixture'}),/^Error: yield state unavailable$/);
    assert.equal(await readYieldState(blocked),null);
  }
});
