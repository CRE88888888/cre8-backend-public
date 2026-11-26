import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { query, withTransaction, closePool, getPool } from '../src/db.js';
import { registerMixStrategy } from '../src/mix-chain.js';
import { mixChainAllocation } from '../src/mix-domain.js';
import { registerMixCreation, reconcileMixRegistration } from '../src/mix-registration.js';
import { withMixCreationLock } from '../src/mix-creation.js';
import { withRelayerLock } from '../src/relayer-lock.js';
import { reconcileRelayerTransactions } from '../src/relayer-reconciliation.js';
import { mixSettings } from '../src/mix-domain.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
import { registrationRpc } from './fixtures/mix-registration.js';
import { relayerSigner } from './fixtures/relayer.js';
import { mixDbSandbox } from './fixtures/mix-db.js';
import { zeroHash } from 'viem';
after(closePool);
async function reserve() {
  const r = (await query<{ id: string }>(`insert into mix_creation_requests(owner,chain_id,request_key,request_hash,settings)
    values($1,97,'retry',$2,$3) returning id`, [T.roles.keeper, zeroHash,
    JSON.stringify(mixSettings({ assets: [{ assetId: T.assets.NVDAB.token, weightBps: 10000 }] }))])).rows[0];
  assert.ok(r); return r.id;
}
test('registration durably commits original bytes before broadcast and canonical replay keeps the original id without acquiring another nonce', async () => {
  await mixDbSandbox(async lane => lane(async () => {
    const id = await reserve(), f = registrationRpc();
    const first = await registerMixCreation(id, { chain: f.chain });
    assert.equal(first.onchain_strategy_id, f.state.id.toString()); assert.equal(first.state, 'registered');
    const counts = [f.state.nonces, f.state.broadcasts.length];
    const retry = await registerMixCreation(id, { chain: f.chain });
    assert.deepEqual(retry, first); assert.deepEqual([f.state.nonces, f.state.broadcasts.length], counts);
    assert.equal((await query('select request_id from mix_registration_outbox')).rows.length, 1);
  }));
});
test('unknown COMMIT sends nothing; another API cannot take a nonce; reconciler replays only committed original bytes after restart', async () => {
  await mixDbSandbox(async lane => {
    const f = registrationRpc();
    await lane(async () => {
      const id = await reserve();
      await assert.rejects(registerMixCreation(id, { chain: f.chain, transaction: async work => {
        await withTransaction(work); throw new Error('private unknown commit');
      } }), /目前無法確認/);
      assert.equal(f.state.broadcasts.length, 0); assert.equal(f.state.nonces, 1);
      await assert.rejects(withRelayerLock(97, async () => assert.fail('fresh nonce')), { code: 'RELAYER_BUSY' });
      const original = (await query<{ signed_raw_tx: `0x${string}` }>('select signed_raw_tx from mix_registration_outbox where request_id=$1', [id])).rows[0]; assert.ok(original);
      f.state.raw = original.signed_raw_tx; f.state.mode = 'missing';
    });
    await lane(async () => {
      const replay = await reconcileRelayerTransactions({ client: f.client, operator: relayerSigner.address, replay: true });
      assert.equal(replay.replayed, 1); assert.equal(replay.unresolved, 1);
      assert.deepEqual(f.state.broadcasts, [f.state.raw]); assert.equal(f.state.nonces, 1);
      f.state.mode = 'healthy';
      assert.equal((await reconcileRelayerTransactions({ client: f.client, operator: relayerSigner.address, replay: true })).confirmed, 1);
      assert.equal((await query('select onchain_strategy_id::text as id from mix_creation_requests')).rows[0]?.id, f.state.id.toString());
      await withRelayerLock(97, async held => held());
    });
  });
});
for (const mode of ['rollback', 'timeout', 'db-read']) test(`registration ${mode} never broadcasts or leaves a hash-only submission`, async () => {
  await mixDbSandbox(async lane => lane(async () => {
    const id = await reserve(), f = registrationRpc();
    await assert.rejects(registerMixCreation(id, { chain: f.chain,
      ...(mode === 'db-read' ? { query: async () => { throw new Error('private DB failure'); } } : {}),
      transaction: work => withTransaction(async client => {
        await work(client);
        if (mode === 'timeout') { await client.query("set local statement_timeout='1ms'"); await client.query('select pg_sleep(0.1)'); }
        throw new Error('private rollback');
      }) }), /目前無法確認/);
    assert.equal(f.state.broadcasts.length, 0);
    assert.equal((await query('select state from mix_creation_requests where id=$1', [id])).rows[0]?.state, 'prepared');
    assert.equal((await query('select request_id from mix_registration_outbox')).rows.length, 0);
    assert.equal((await registerMixCreation(id, { chain: f.chain })).state, 'registered');
  }));
});
test('ambiguous send, absent receipt, canonical mismatch, RPC failure and timeout preserve original authority and block other relayer ingress', async () => {
  await mixDbSandbox(async lane => lane(async () => {
    const id = await reserve(), f = registrationRpc(); f.state.mode = 'send';
    await assert.rejects(registerMixCreation(id, { chain: f.chain }), /目前無法確認/);
    for (const mode of ['missing','reorg','event','nonce','chain','rpc','revert','timeout']) {
      f.state.mode = mode; f.state.delayMs = mode === 'timeout' ? 30 : 0;
      const result = await reconcileRelayerTransactions({ client: f.client, operator: relayerSigner.address,
        timeoutMs: mode === 'timeout' ? 1 : 5000, replay: false });
      assert.equal(result.unresolved, 1, mode); assert.equal(result.confirmed, 0, mode);
      await assert.rejects(withRelayerLock(97, async () => assert.fail('fresh nonce')), { code: 'RELAYER_BUSY' });
      assert.equal((await query('select state from mix_creation_requests where id=$1', [id])).rows[0]?.state, 'submitted');
      assert.equal(f.state.nonces, 1); assert.equal(f.state.broadcasts.length, 1);
    }
    f.state.mode = 'healthy'; f.state.delayMs = 0;
    const deps = { client: f.client, query, transaction: withTransaction, operator: relayerSigner.address };
    assert.equal(await reconcileMixRegistration(id, deps), 'registered');
    await withRelayerLock(97, async held => held());
  }));
});
test('creation request lock excludes concurrent workers across connections, then resumes the same durable request', async () => {
  await mixDbSandbox(async lane => {
    const id = await lane(reserve);
    let release = () => {}, notify = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { notify = resolve; });
    const first = lane(() => withMixCreationLock(id, async () => { notify(); await held; return id; }));
    await entered;
    try { await lane(() => assert.rejects(withMixCreationLock(id, async () => assert.fail('parallel creation')), { code: 'MIX_CREATE_BUSY' })); }
    finally { release(); await first; }
    assert.equal(await lane(() => withMixCreationLock(id, async () => id)), id);
  });
});


test('first-version publication recovery reuses canonical registration and version 1 after an ambiguous receipt', async () => {
  await mixDbSandbox(async lane => lane(async () => {
    const id = await reserve(), f = registrationRpc();
    const allocation = { assets: mixChainAllocation([{ assetId: T.assets.NVDAB.token, weightBps: 10000 }], [], 128).assets };
    f.state.publicationFail = true;
    await assert.rejects(registerMixStrategy(T.roles.keeper, 'local user name', allocation, id, { chain: f.chain }));
    assert.equal(f.state.broadcasts.length, 2); assert.equal(f.state.publicationCount, 1n);
    await withRelayerLock(97, async held => held());
    assert.equal((await query('select strategy_id from mix_publication_outbox')).rows.length, 1);
    f.state.publicationFail = false;
    const sid = await registerMixStrategy(T.roles.keeper, 'local user name', allocation, id, { chain: f.chain });
    assert.equal(f.state.broadcasts.length, 2); assert.equal(f.state.nonces, 2);
    assert.equal((await query('select strategy_id from mix_creation_requests where id=$1', [id])).rows[0]?.strategy_id, String(sid));
    assert.equal((await query('select version from strategy_versions where strategy_id=$1', [sid])).rows.length, 1);
    f.state.publicationCount = 2n;
    await assert.rejects(registerMixStrategy(T.roles.keeper, 'local user name', allocation, id, { chain: f.chain }), /目前無法確認/);
    assert.equal(f.state.broadcasts.length, 2);
  }));
});


for (const moment of ['before', 'after'] as const) test(`registration disconnect ${moment} COMMIT never broadcasts and recovery reads durable authority on a new connection`, async () => {
  await mixDbSandbox(async lane => {
    const f = registrationRpc(); let id = '';
    await lane(async () => {
      id = await reserve();
      await assert.rejects(registerMixCreation(id, { chain: f.chain, transaction: async work => {
        const pid = (await query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid; assert.ok(pid);
        if (moment === 'before') return withTransaction(async client => {
          const result = await work(client);
          await getPool().query('select pg_terminate_backend($1)', [pid]);
          return result;
        });
        await withTransaction(work);
        await getPool().query('select pg_terminate_backend($1)', [pid]);
        throw new Error('private connection lost after commit');
      } }), /目前無法確認/);
      assert.equal(f.state.broadcasts.length, 0);
    });
    await lane(async () => {
      const saved = (await query<{ signed_raw_tx: `0x${string}` }>('select signed_raw_tx from mix_registration_outbox where request_id=$1', [id])).rows[0];
      assert.equal(Boolean(saved), moment === 'after');
      if (saved) {
        f.state.raw = saved.signed_raw_tx; f.state.mode = 'missing';
        await assert.rejects(registerMixCreation(id, { chain: f.chain }), /目前無法確認/);
        assert.deepEqual(f.state.broadcasts, [saved.signed_raw_tx]);
        f.state.mode = 'healthy';
      }
      assert.equal((await registerMixCreation(id, { chain: f.chain })).state, 'registered');
    });
  });
});

test('reconciler reports an unconfirmed first-version publication as unresolved and never replays the already confirmed registration', async () => {
  await mixDbSandbox(async lane => lane(async () => {
    const id = await reserve(), f = registrationRpc();
    await registerMixCreation(id, { chain: f.chain });
    await query("update mix_creation_requests set last_error_code='VERSION_PUBLICATION_PENDING' where id=$1", [id]);
    for (const replay of [false, true]) {
      const result = await reconcileRelayerTransactions({ client: f.client, operator: relayerSigner.address, replay });
      assert.equal(result.unresolved, 1); assert.equal(result.confirmed, 0); assert.equal(result.replayed, 0);
    }
    assert.equal(f.state.broadcasts.length, 1); assert.equal(f.state.nonces, 1);
    await withRelayerLock(97, async held => held());
  }));
});

// 2026-11-23: POST /me/mixes 503 after both transactions succeeded. The api now talks to a load-balanced RPC; right
// after inclusion the next read may land on a node a few blocks behind (receipt / version not visible yet).
test('a node lagging right after inclusion no longer fails the request: registration and first version confirm on the same call', async () => {
  await mixDbSandbox(async lane => lane(async () => {
    const id = await reserve(), f = registrationRpc();
    const allocation = { assets: mixChainAllocation([{ assetId: T.assets.NVDAB.token, weightBps: 10000 }], [], 128).assets };
    // The registration is sent first: its block then misses twice on the "other node"; after the publication,
    // versionCount still reads 0 twice.
    f.lag.afterSend = publication => { if (publication) f.state.publicationCountLagReads = 2; else f.lag.blockReads = 2; };
    const started = Date.now();
    const sid = await registerMixStrategy(T.roles.keeper, 'lagging node', allocation, id, { chain: f.chain });
    assert.ok(Date.now() - started < 10_000);
    assert.equal(f.lag.blockReads, 0); assert.equal(f.state.publicationCountLagReads, 0);
    assert.equal(f.state.broadcasts.length, 2, 'no extra transaction was signed');
    assert.equal((await query('select version from strategy_versions where strategy_id=$1', [sid])).rows.length, 1);
    assert.equal((await query("select state from mix_publication_jobs where strategy_id=$1", [sid])).rows[0]?.state, 'confirmed');
  }));
});
