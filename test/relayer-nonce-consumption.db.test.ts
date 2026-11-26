import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { parseTransaction } from 'viem';
import { closePool, query, withTransaction } from '../src/db.js';
import { mixDbSandbox } from './fixtures/mix-db.js';
import { foreignRpc, pendingFunding, pendingRegistration } from './fixtures/relayer-consumption.js';
import { relayerSigner } from './fixtures/relayer.js';
import { reconcileRelayerTransactions } from '../src/relayer-reconciliation.js';
import { registerMixCreation, reconcileMixRegistration } from '../src/mix-registration.js';
import { withRelayerLock, relayerNonce } from '../src/relayer-lock.js';
import { detectAlerts, recordAlerts, resolveAlerts } from '../src/alerts.js';
import { findDailyFaucetClaim } from '../src/faucet.js';
import { findWelcomeGrant, reserveWelcomeGrant } from '../src/welcome-grants.js';
after(closePool);

for (const kind of ['welcome', 'faucet', 'registration'] as const) for (const confirmations of [0n, 14n, 15n])
test(`${kind} persists external consumption only after ${confirmations} successor blocks`, async () => {
  await mixDbSandbox(async lane => lane(async () => {
    const f = kind === 'registration' ? await pendingRegistration() : await pendingFunding(kind);
    const rpc = await foreignRpc(0); rpc.foreignState.head = 2n + confirmations;
    const result = await reconcileRelayerTransactions({ client: rpc.client, operator: relayerSigner.address, replay: true });
    const ready = confirmations >= 15n;
    assert.equal((await query('select * from relayer_outbox_nonce_consumptions')).rows.length, ready ? 1 : 0);
    assert.equal(result.replayed, ready ? 0 : 1);
    assert.deepEqual(rpc.state.broadcasts, ready ? [] : [f.signed.raw]);
    const table = kind === 'registration' ? 'mix_creation_requests' : kind === 'welcome' ? 'welcome_grants' : 'faucet_claims';
    const id = 'source' in f ? f.source.id : f.id;
    assert.equal((await query(`select state from ${table} where id=$1`, [id])).rows[0]?.state,
      ready ? kind === 'registration' ? 'prepared' : 'failed' : 'submitted');
    if (kind === 'registration') assert.equal((await query('select registration_attempt from mix_creation_requests where id=$1', [id])).rows[0]?.registration_attempt, ready ? 2 : 1);
    if (!ready) {
      await assert.rejects(withRelayerLock(97, () => assert.fail('unconfirmed evidence retains nonce authority')), { code: 'RELAYER_BUSY' });
      assert.equal((await query('select * from scheduler_alerts')).rows.length, 0);
    }
  }));
});

for (const kind of ['welcome', 'faucet', 'registration'] as const) test(`${kind} rechecks confirmations immediately before consumption persistence`, async () => {
  await mixDbSandbox(async lane => lane(async () => {
    if (kind === 'registration') await pendingRegistration(); else await pendingFunding(kind);
    const rpc = await foreignRpc(0);
    // Discovery observes a deep-enough head; persistence observes a retreat.
    rpc.foreignState.headSequence = [17n, 17n, 17n, 16n];
    const result = await reconcileRelayerTransactions({ client: rpc.client, operator: relayerSigner.address, replay: true });
    assert.equal(result.failed, 0); assert.ok(result.unresolved > 0);
    assert.equal((await query('select * from relayer_outbox_nonce_consumptions')).rows.length, 0);
    assert.equal((await query('select * from scheduler_alerts')).rows.length, 0);
    assert.equal(rpc.state.broadcasts.length, 0);
    await assert.rejects(withRelayerLock(97, () => assert.fail('retreated head retains nonce authority')), { code: 'RELAYER_BUSY' });
  }));
});

test('welcome external consumption alerts operations, preserves lifetime identity and stays open until manually resolved', async () => {
  await mixDbSandbox(async lane => lane(async () => {
    const f = await pendingFunding('welcome'), rpc = await foreignRpc(0);
    const grant = await findWelcomeGrant(97, f.source.owner); assert.ok(grant);
    const options = { client: rpc.client, operator: relayerSigner.address, replay: true };
    assert.equal((await reconcileRelayerTransactions(options)).failed, 1);
    const alerts = (await query("select * from scheduler_alerts where kind='portfolio_stuck' and resolved_at is null")).rows;
    assert.equal(alerts.length, 1);
    const alert = alerts[0]; assert.ok(alert);
    assert.equal(alert.severity, 'critical');
    assert.equal(Number(alert.portfolio_id), grant.portfolioId);
    for (const field of ['WELCOME_NONCE_CONSUMED', f.source.id, f.source.owner, f.source.account, f.source.amountWei.toString(), f.signed.hash, '手動補發']) assert.ok(alert.detail.includes(field));
    assert.ok(!alert.detail.includes(f.signed.raw));
    // The alert may commit after a scheduler's detection snapshot. A normal
    // resolve must never acknowledge this manual-repair finding by omission.
    await resolveAlerts(query, []);
    assert.equal((await query('select * from scheduler_alerts where id=$1 and resolved_at is null', [alert.id])).rows.length, 1);
    const findings = await detectAlerts(query, { env: { CHAIN_ID: '97' }, readNativeBalance: async () => 0n, readGasPrice: async () => 1n });
    assert.ok(findings.some(finding => finding.kind === 'portfolio_stuck' && finding.portfolioId === grant.portfolioId && finding.detail.includes('WELCOME_NONCE_CONSUMED')));
    await recordAlerts(query, findings); await resolveAlerts(query, findings);
    assert.equal((await query("select * from scheduler_alerts where id=$1 and resolved_at is null", [alert.id])).rows.length, 1);
    assert.equal((await reconcileRelayerTransactions(options)).failed, 0);
    assert.equal((await query("select * from scheduler_alerts where detail like '%WELCOME_NONCE_CONSUMED%'")).rows.length, 1);
    const retry = await reserveWelcomeGrant(grant, { chainId: 97, siteDailyWei: 0n, timeoutMs: 5000 });
    assert.equal(retry.created, false); assert.equal(retry.grant.state, 'failed'); assert.equal(retry.grant.id, f.source.id);
    await query('update scheduler_alerts set resolved_at=clock_timestamp() where id=$1', [alert.id]);
    const after = await detectAlerts(query, { env: { CHAIN_ID: '97' }, readNativeBalance: async () => 0n, readGasPrice: async () => 1n });
    assert.ok(!after.some(finding => finding.detail.includes('WELCOME_NONCE_CONSUMED')));
    assert.equal(rpc.state.broadcasts.length, 0);
  }));
});

for (const failure of ['db', 'timeout'] as const) test(`welcome alert ${failure} cannot block nonce recovery and retries from durable source`, async () => {
  await mixDbSandbox(async lane => lane(async () => {
    const f = await pendingFunding('welcome'), rpc = await foreignRpc(0);
    await query(`create function fail_welcome_alert() returns trigger language plpgsql as $$ begin raise exception 'private alert storage' using errcode='${failure === 'timeout' ? '57014' : 'P0001'}'; end $$`);
    await query('create trigger fail_welcome_alert before insert on scheduler_alerts for each row execute function fail_welcome_alert()');
    const options = { client: rpc.client, operator: relayerSigner.address, replay: true };
    const logs: string[] = [], warn = console.warn;
    console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    try { assert.equal((await reconcileRelayerTransactions(options)).failed, 1); }
    finally { console.warn = warn; }
    assert.equal(logs.length, 1); assert.doesNotMatch(logs.join(' '), /private|postgres:|credential|signed_raw_tx/);
    assert.equal((await findWelcomeGrant(97, f.source.owner))?.state, 'failed');
    assert.equal((await query('select * from relayer_outbox_nonce_consumptions')).rows.length, 1);
    assert.equal((await query('select * from scheduler_alerts')).rows.length, 0);
    await withRelayerLock(97, async held => held());
    await query('drop trigger fail_welcome_alert on scheduler_alerts');
    assert.equal((await reconcileRelayerTransactions(options)).failed, 0);
    const findings = await detectAlerts(query, { env: { CHAIN_ID: '97' }, readNativeBalance: async () => 0n, readGasPrice: async () => 1n });
    assert.ok(findings.some(finding => finding.detail.includes('WELCOME_NONCE_CONSUMED')));
    await recordAlerts(query, findings);
    assert.equal((await query("select * from scheduler_alerts where detail like '%WELCOME_NONCE_CONSUMED%'")).rows.length, 1);
    assert.equal(rpc.state.broadcasts.length, 0);
  }));
});

for (const kind of ['welcome', 'faucet'] as const) for (const nonce of [0, Number.MAX_SAFE_INTEGER - 1]) test(`${kind} external canonical nonce ${nonce} fails only its original request and unblocks the shared relayer`, async () => {
  await mixDbSandbox(async lane => lane(async () => {
    const f = await pendingFunding(kind, nonce), rpc = await foreignRpc(nonce);
    await assert.rejects(withRelayerLock(97, async () => assert.fail('unresolved original')), { code: 'RELAYER_BUSY' });
    const table = kind === 'welcome' ? 'welcome_grants' : 'faucet_claims';
    const before = (await query(`select owner,account,amount_wei::text,utc_day,tx_hash from ${table} where id=$1`, [f.source.id])).rows[0];
    const result = await reconcileRelayerTransactions({ client: rpc.client, operator: relayerSigner.address, replay: true });
    assert.equal(result.failed, 1); assert.equal(result.replayed, 0); assert.equal(result.unresolved, 0);
    assert.equal((await query(`select state from ${table} where id=$1`, [f.source.id])).rows[0]?.state, 'failed');
    assert.deepEqual((await query(`select owner,account,amount_wei::text,utc_day,tx_hash from ${table} where id=$1`, [f.source.id])).rows[0], before);
    assert.equal((await query('select foreign_tx_hash from relayer_outbox_nonce_consumptions where tx_hash=$1', [f.signed.hash])).rows[0]?.foreign_tx_hash, rpc.foreignHash);
    assert.equal((await query('select signed_raw_tx from relayer_transaction_outbox where tx_hash=$1', [f.signed.hash])).rows[0]?.signed_raw_tx, f.signed.raw);
    assert.equal((await reconcileRelayerTransactions({ client: rpc.client, operator: relayerSigner.address, replay: true })).failed, 0);
    await withRelayerLock(97, async held => held());
    assert.equal(rpc.state.broadcasts.length, 0);
    const retry = kind === 'welcome' ? await findWelcomeGrant(97, f.source.owner) : await findDailyFaucetClaim(97, f.source.owner, f.source.account);
    assert.equal(retry?.state, 'failed');
  }));
});

test('registration external nonce evidence commits before a fresh attempt and preserves its frozen request and original bytes', async () => {
  await mixDbSandbox(async lane => lane(async () => {
    const f = await pendingRegistration(), rpc = await foreignRpc(0);
    const before = (await query('select owner,request_key,request_hash,settings from mix_creation_requests where id=$1', [f.id])).rows[0];
    const deps = { client: rpc.client, operator: relayerSigner.address, query, transaction: withTransaction };
    assert.equal(await reconcileMixRegistration(f.id, deps, true), 'consumed');
    assert.deepEqual((await query('select state,registration_attempt,registration_tx_hash from mix_creation_requests where id=$1', [f.id])).rows[0],
      { state: 'prepared', registration_attempt: 2, registration_tx_hash: null });
    assert.equal(rpc.state.broadcasts.length, 0);
    await withRelayerLock(97, async held => held());
    rpc.state.mode = 'healthy';
    assert.equal((await registerMixCreation(f.id, { chain: rpc.chain })).state, 'registered');
    const rows = (await query<{ signed_raw_tx: `0x${string}`; tx_hash: string }>('select signed_raw_tx,tx_hash from mix_registration_outbox where request_id=$1 order by attempt', [f.id])).rows;
    assert.equal(rows.length, 2); assert.deepEqual(rows[0], { signed_raw_tx: f.signed.raw, tx_hash: f.signed.hash });
    assert.equal(parseTransaction(rows[1]?.signed_raw_tx ?? '0x').nonce, 1);
    assert.deepEqual((await query('select owner,request_key,request_hash,settings from mix_creation_requests where id=$1', [f.id])).rows[0], before);
    await registerMixCreation(f.id, { chain: rpc.chain }); assert.equal(rpc.state.broadcasts.length, 1);
  }));
});

test('a restarted reconciler rebuilds a consumed registration on its next tick without another HTTP request', async () => {
  await mixDbSandbox(async lane => lane(async () => {
    const f = await pendingRegistration(), rpc = await foreignRpc(0);
    const options = { chain: rpc.chain, client: rpc.client, operator: relayerSigner.address, replay: true };
    await reconcileRelayerTransactions(options);
    assert.equal((await query('select state from mix_creation_requests where id=$1', [f.id])).rows[0]?.state, 'prepared');
    assert.equal(rpc.state.broadcasts.length, 0, 'the consumption pass never signs again');
    rpc.state.mode = 'healthy';
    assert.equal((await reconcileRelayerTransactions(options)).confirmed, 1);
    assert.equal((await query('select state from mix_creation_requests where id=$1', [f.id])).rows[0]?.state, 'registered');
    assert.equal((await reconcileRelayerTransactions(options)).confirmed, 0);
    assert.equal(rpc.state.broadcasts.length, 1);
  }));
});

for (const registration of [false, true]) for (const failure of ['pendingOnly', 'missingTransaction', 'missingReceipt', 'wrongReceipt', 'duplicate', 'timeout', 'unsafeNonce', 'db'] as const)
test(`${registration ? 'registration' : 'faucet'} ${failure} cannot authorize external nonce release`, async () => {
  await mixDbSandbox(async lane => lane(async () => {
    const nonce = failure === 'unsafeNonce' ? Number.MAX_SAFE_INTEGER : 0;
    const f = registration ? await pendingRegistration(nonce) : await pendingFunding('faucet', nonce);
    const rpc = await foreignRpc(nonce);
    if (failure === 'timeout') rpc.foreignState.delayMs = 30;
    else if (failure !== 'unsafeNonce' && failure !== 'db') rpc.foreignState[failure] = true;
    if (failure === 'db') {
      await query("create function fail_consumption() returns trigger language plpgsql as $$ begin raise exception 'private DB credential'; end $$");
      await query('create trigger fail_consumption before insert on relayer_outbox_nonce_consumptions for each row execute function fail_consumption()');
    }
    const result = await reconcileRelayerTransactions({ client: rpc.client, operator: relayerSigner.address, replay: false,
      timeoutMs: failure === 'timeout' ? 1 : 5000 });
    assert.equal(result.failed, 0); assert.equal(result.confirmed, 0); assert.ok(result.unresolved > 0);
    assert.equal((await query('select * from relayer_outbox_nonce_consumptions')).rows.length, 0);
    await assert.rejects(withRelayerLock(97, async () => assert.fail('nonce still occupied')), { code: 'RELAYER_BUSY' });
    assert.equal(rpc.state.broadcasts.length, 0);
    const table = 'source' in f ? 'faucet_claims' : 'mix_creation_requests';
    const id = 'source' in f ? f.source.id : f.id;
    assert.equal((await query(`select state from ${table} where id=$1`, [id])).rows[0]?.state, 'submitted');
  }));
});

for (const registration of [false, true]) test(`${registration ? 'registration' : 'funding'} can independently prove foreign consumption when the original-hash RPC errors`, async () => {
  await mixDbSandbox(async lane => lane(async () => {
    if (registration) await pendingRegistration(); else await pendingFunding('faucet');
    const rpc = await foreignRpc(0); rpc.foreignState.originalReceiptError = true;
    const result = await reconcileRelayerTransactions({ client: rpc.client, operator: relayerSigner.address, replay: true });
    assert.equal(result.failed, registration ? 0 : 1);
    assert.equal((await query('select foreign_tx_hash from relayer_outbox_nonce_consumptions')).rows[0]?.foreign_tx_hash, rpc.foreignHash);
    assert.equal(rpc.state.broadcasts.length, 0);
    await withRelayerLock(97, async held => held());
  }));
});

for (const kind of ['welcome', 'faucet', 'registration'] as const) test(`${kind} unknown consumption COMMIT is recovered from durable evidence without releasing twice or replaying`, async () => {
  await mixDbSandbox(async lane => {
    const rpc = await foreignRpc(0);
    let hash = '', id = '';
    await lane(async () => {
      const f = kind === 'registration' ? await pendingRegistration() : await pendingFunding(kind);
      hash = f.signed.hash; id = 'source' in f ? f.source.id : f.id;
      const result = await reconcileRelayerTransactions({ client: rpc.client, operator: relayerSigner.address, replay: true,
        transaction: async work => { await withTransaction(work); throw new Error('private unknown COMMIT'); } });
      assert.ok(result.unresolved > 0); assert.equal(result.failed, 0); assert.equal(rpc.state.broadcasts.length, 0);
    });
    await lane(async () => {
      assert.equal((await query('select * from relayer_outbox_nonce_consumptions where tx_hash=$1', [hash])).rows.length, 1);
      if (kind === 'welcome') {
        assert.equal((await query("select * from scheduler_alerts where detail like '%WELCOME_NONCE_CONSUMED%'")).rows.length, 0, 'a lost COMMIT response can interrupt the immediate alert');
        const findings = await detectAlerts(query, { env: { CHAIN_ID: '97' }, readNativeBalance: async () => 0n, readGasPrice: async () => 1n });
        await recordAlerts(query, findings);
        assert.equal((await query("select * from scheduler_alerts where detail like '%WELCOME_NONCE_CONSUMED%'")).rows.length, 1, 'durable source recovers the interrupted alert');
      }
      const table = kind === 'registration' ? 'mix_creation_requests' : kind === 'welcome' ? 'welcome_grants' : 'faucet_claims';
      assert.equal((await query(`select state from ${table} where id=$1`, [id])).rows[0]?.state, kind === 'registration' ? 'prepared' : 'failed');
      assert.equal((await reconcileRelayerTransactions({ client: rpc.client, operator: relayerSigner.address, replay: true })).failed, 0);
      assert.equal((await query('select * from relayer_outbox_nonce_consumptions where tx_hash=$1', [hash])).rows.length, 1);
      assert.equal(rpc.state.broadcasts.length, 0);
      await withRelayerLock(97, async held => held());
    });
  });
});

for (const kind of ['welcome', 'faucet'] as const) test(`two workers can settle external ${kind} consumption only once`, async () => {
  await mixDbSandbox(async lane => {
    await lane(() => pendingFunding(kind));
    const rpc = await foreignRpc(0);
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => lane(() => reconcileRelayerTransactions({ client: rpc.client, operator: relayerSigner.address, replay: true }))));
    assert.equal(results.reduce((sum, result) => sum + (result.status === 'fulfilled' ? result.value.failed : 0), 0), 1);
    for (const result of results) if (result.status === 'rejected') assert.ok(result.reason instanceof Error && 'code' in result.reason && result.reason.code === 'RELAYER_RECONCILIATION_UNAVAILABLE');
    await lane(async () => {
      assert.equal((await query('select * from relayer_outbox_nonce_consumptions')).rows.length, 1);
      if (kind === 'welcome') assert.equal((await query("select * from scheduler_alerts where detail like '%WELCOME_NONCE_CONSUMED%'")).rows.length, 1);
    });
    assert.equal(rpc.state.broadcasts.length, 0);
  });
});

for (const kind of ['welcome', 'faucet', 'registration'] as const) test(`${kind} proof reorg preserves audit, quarantines the source and maintains its alert without replay`, async () => {
  await mixDbSandbox(async lane => lane(async () => {
    const f = kind === 'registration' ? await pendingRegistration() : await pendingFunding(kind);
    const rpc = await foreignRpc(0);
    await reconcileRelayerTransactions({ client: rpc.client, operator: relayerSigner.address, replay: true });
    const proof = (await query('select * from relayer_outbox_nonce_consumptions')).rows[0]; assert.ok(proof);
    rpc.foreignState.reorg = true;
    if ('source' in f) assert.ok((await reconcileRelayerTransactions({ client: rpc.client, operator: relayerSigner.address, replay: true })).unresolved > 0);
    else await assert.rejects(registerMixCreation(f.id, { chain: rpc.chain }), { code: 'MIX_UNAVAILABLE' });
    assert.deepEqual((await query('select * from relayer_outbox_nonce_consumptions')).rows[0], proof);
    assert.equal((await query('select * from relayer_outbox_nonce_quarantines')).rows.length, 1);
    const findings = await detectAlerts(query, { env: { CHAIN_ID: '97' }, readNativeBalance: async () => 0n, readGasPrice: async () => 1n });
    assert.ok(findings.some(finding => finding.kind === 'portfolio_stuck' && finding.portfolioId === null));
    await resolveAlerts(query, findings);
    assert.equal((await query("select * from scheduler_alerts where kind='portfolio_stuck' and portfolio_id is null and resolved_at is null")).rows.length, 1);
    assert.deepEqual(await withRelayerLock(97, () => relayerNonce(rpc.client, relayerSigner.address)), { nonce: 1 }, 'quarantine is not a global business flag');
    rpc.foreignState.nonceGap = true;
    await assert.rejects(withRelayerLock(97, () => relayerNonce(rpc.client, relayerSigner.address)), { code: 'RELAYER_BUSY' }, 'an actual nonce gap stays protected');
    assert.equal(rpc.state.broadcasts.length, 0);
    if (kind === 'welcome' && 'source' in f) {
      const grant = await findWelcomeGrant(97, f.source.owner); assert.ok(grant);
      assert.equal(grant.state, 'failed');
      const retry = await reserveWelcomeGrant(grant, { chainId: 97, siteDailyWei: 10n ** 30n, timeoutMs: 5000 });
      assert.equal(retry.created, false); assert.equal(retry.grant.txHash, f.signed.hash);
      assert.equal((await query('select * from welcome_grants')).rows.length, 1);
    }
  }));
});

test('a quarantined registration retains its submitted replacement but can save late foreign consumption without reviving or blocking the relayer', async () => {
  await mixDbSandbox(async lane => lane(async () => {
    const f = await pendingRegistration(), rpc = await foreignRpc(0);
    await reconcileRelayerTransactions({ client: rpc.client, operator: relayerSigner.address, replay: true });
    await assert.rejects(registerMixCreation(f.id, { chain: rpc.chain, transaction: async work => {
      await withTransaction(work); throw new Error('private replacement COMMIT response lost');
    } }), { code: 'MIX_UNAVAILABLE' });
    rpc.foreignState.reorg = true;
    await reconcileRelayerTransactions({ client: rpc.client, operator: relayerSigner.address, replay: true });
    assert.equal((await query('select * from relayer_outbox_nonce_quarantines')).rows.length, 1);
    await assert.rejects(withRelayerLock(97, async () => assert.fail('unresolved replacement')), { code: 'RELAYER_BUSY' });
    const late = await foreignRpc(1);
    await reconcileRelayerTransactions({ client: late.client, operator: relayerSigner.address, replay: true });
    assert.equal((await query('select * from relayer_outbox_nonce_consumptions')).rows.length, 2);
    assert.deepEqual((await query('select state,registration_attempt from mix_creation_requests where id=$1', [f.id])).rows[0], { state: 'submitted', registration_attempt: 2 });
    await withRelayerLock(97, async held => held());
    await assert.rejects(registerMixCreation(f.id, { chain: late.chain }), { code: 'MIX_UNAVAILABLE' });
    assert.equal((await query('select * from mix_registration_outbox where request_id=$1', [f.id])).rows.length, 2);
    assert.equal(rpc.state.broadcasts.length + late.state.broadcasts.length, 0);
  }));
});
