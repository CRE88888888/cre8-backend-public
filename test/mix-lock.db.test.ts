import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { withMixLock, assertMixLock, checkMixLock } from '../src/mix-store.js';
import { closePool, query, getPool } from '../src/db.js';
after(closePool);
function barrier() {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
test('stable mix exclusion covers RPC waits, independent workers, different portfolio segments, and releases on failure', async () => {
  const entered = barrier(), remote = barrier();
  let attempted = 0;
  const first = withMixLock('178000000001', async () => { entered.release(); await remote.promise; assertMixLock(); attempted++; });
  try {
    await entered.promise;
    await assert.rejects(withMixLock('178000000001', async () => { attempted++; }), /組合正在處理/);
    await withMixLock('178000000002', async () => { attempted++; });
    assert.equal(attempted, 1);
  } finally { remote.release(); await first; }
  assert.equal(attempted, 2);
  await assert.rejects(withMixLock('178000000001', async () => { throw new Error('RPC timeout'); }), /RPC timeout/);
  await withMixLock('178000000001', async () => { attempted++; });
  assert.equal(attempted, 3);
});
test('lost stable lock prevents sending after an RPC wait and discards the dead connection', async () => {
  assert.ok(['cre8_x1_178', 'cre8_x1_180'].includes((await query<{ name: string }>('select current_database() as name')).rows[0]?.name ?? ''));
  const entered = barrier(), remote = barrier();
  let pid: number | undefined, sent = 0;
  const first = withMixLock('178000000003', async () => {
    pid = (await query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid;
    entered.release(); await remote.promise;
    await checkMixLock(); sent++;
  });
  const rejected = assert.rejects(first, /目前無法確認/);
  try {
    await entered.promise; assert.ok(pid);
    const result = await getPool().query<{ stopped: boolean }>(`select pg_terminate_backend(pid) as stopped from pg_stat_activity
      where pid=$1 and datname=current_database() and application_name='cre8-atp-backend'`, [pid]);
    assert.equal(result.rows[0]?.stopped, true);
    // A round trip on another connection gives the server's disconnect notification
    // a chance to arrive before the simulated RPC completes.
    await getPool().query('select 1');
  } finally { remote.release(); }
  await rejected;
  assert.equal(sent, 0);
  await withMixLock('178000000003', async () => { assertMixLock(); });
});
