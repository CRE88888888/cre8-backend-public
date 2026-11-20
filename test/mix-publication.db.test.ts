import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { parseTransaction, zeroHash, keccak256 } from 'viem';
import { query, withTransaction, closePool, getPool } from '../src/db.js';
import { mixDbSandbox } from './fixtures/mix-db.js';
import { publicationFixture } from './fixtures/mix-publication.js';
import { registrationRpc } from './fixtures/mix-registration.js';
import { relayerSigner, signedFundingTx } from './fixtures/relayer.js';
import { registerMixStrategy } from '../src/mix-chain.js';
import { mixChainAllocation, mixSettings } from '../src/mix-domain.js';
import { reconcileMixPublication, publishMixStrategy, PUBLICATION_ALERT_MS } from '../src/mix-publication.js';
import { reconcileRelayerTransactions } from '../src/relayer-reconciliation.js';
import { withRelayerLock, relayerNonce } from '../src/relayer-lock.js';
import { createFaucetService, settleFaucetClaim } from '../src/faucet.js';
import { detectAlerts } from '../src/alerts.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
after(closePool);
const allocation = { assets: mixChainAllocation([{ assetId: T.assets.NVDAB.token, weightBps: 10000 }], [], 128).assets };
async function reserve() {
  const row = (await query<{ id: string }>(`insert into mix_creation_requests(owner,chain_id,request_key,request_hash,settings)
    values($1,97,'publication-test',$2,$3) returning id`, [T.roles.keeper, zeroHash,
      JSON.stringify(mixSettings({ assets: [{ assetId: T.assets.NVDAB.token, weightBps: 10000 }] }))])).rows[0]; assert.ok(row); return row.id;
}
const pubDeps = (f: ReturnType<typeof registrationRpc>) => ({ chain: f.chain, client: f.client, operator: relayerSigner.address, query, transaction: withTransaction });
async function jobId() {
  const row = (await query<{ strategy_id: string }>('select strategy_id from mix_publication_jobs')).rows[0]; assert.ok(row); return row.strategy_id;
}
async function faucet(f: ReturnType<typeof registrationRpc>) {
  let nonce = -1;
  const amount = 1000n * 10n ** 18n;
  const service = createFaucetService({ config: { chainId: 97, amountWei: amount, siteDailyWei: 10n ** 30n, timeoutMs: 5000 },
    query: async () => ({ rows: [{ owner: T.roles.keeper, user_id: T.roles.keeper }] }),
    settle: (claim, from, state, hash, transaction, signed) => settleFaucetClaim(claim, from, state, hash, transaction,
      signed ? { ...signed, operator: relayerSigner.address } : undefined),
    prepare: async claim => {
      const selected = await relayerNonce(f.client, relayerSigner.address); assert.ok(selected.nonce !== undefined); nonce = selected.nonce;
      const signed = await signedFundingTx('faucet', claim.account, claim.amountWei, { nonce });
      return { ...signed, broadcast: async () => {}, receipt: async () => 'confirmed' };
    } });
  const result = await service.claim({ account: T.roles.operator }, T.roles.keeper);
  assert.equal(result.state, 'confirmed'); return nonce;
}

for (const cut of ['before','after'] as const) test(`publication interruption ${cut} COMMIT sends no transaction and preserves one recoverable first version`, async () => {
  await mixDbSandbox(async lane => {
    const f = registrationRpc(); let id = '';
    await lane(async () => {
      id = await reserve(); let interrupted = false;
      const transaction: typeof withTransaction = async work => {
        let committed = false;
        const value = await withTransaction(async client => {
          const result = await work(client);
          if (!interrupted && (await client.query("select 1 from mix_publication_jobs where state='submitted'")).rows.length) {
            interrupted = true; committed = true;
            if (cut === 'before') throw new Error('fixture process interruption before commit');
          }
          return result;
        });
        if (committed && cut === 'after') throw new Error('fixture unknown committed response');
        return value;
      };
      await assert.rejects(registerMixStrategy(T.roles.keeper, 'private setting', allocation, id, { chain: f.chain, transaction }));
      assert.equal(f.state.broadcasts.length, 1, 'only registration was broadcast');
      const rows = (await query<{ signed_raw_tx: `0x${string}` }>('select signed_raw_tx from mix_publication_outbox')).rows;
      assert.equal(rows.length, cut === 'after' ? 1 : 0);
      if (cut === 'after') {
        await withRelayerLock(97, async () => {
          const selected = await relayerNonce(f.client, relayerSigner.address); assert.ok(selected.nonce !== undefined);
          const original = rows[0]; assert.ok(original);
          assert.ok(selected.nonce > (parseTransaction(original.signed_raw_tx).nonce ?? -1));
        });
      }
    });
    await lane(async () => {
      // Restart uses the persisted job even without another POST/create request.
      const recovered = await reconcileRelayerTransactions({ chain: f.chain, client: f.client, operator: relayerSigner.address, replay: true });
      assert.ok(recovered.confirmed + recovered.replayed > 0);
      if (recovered.replayed) assert.equal((await reconcileRelayerTransactions({ chain: f.chain, client: f.client, operator: relayerSigner.address, replay: true })).confirmed, 1);
      assert.equal((await query('select attempt from mix_publication_outbox')).rows.length, 1);
      assert.equal((await query('select version from strategy_versions')).rows.length, 1);
      assert.equal(f.state.publicationCount, 1n);
      assert.equal((await query('select state from mix_publication_jobs')).rows[0]?.state, 'confirmed');
      assert.equal((await query('select count(*)::text as n from strategies')).rows[0]?.n, '1');
    });
  });
});

test('canonical revert consumes its nonce, persists its receipt and retries a new attempt with identical settings', async () => {
  await mixDbSandbox(async lane => lane(async () => {
    const id = await reserve(), f = registrationRpc(); f.state.publicationReverted = true;
    await assert.rejects(registerMixStrategy(T.roles.keeper, 'test', allocation, id, { chain: f.chain }));
    const sid = await jobId();
    assert.equal(await reconcileMixPublication(sid, pubDeps(f), true), 'reverted');
    assert.equal((await query('select status from mix_publication_receipts')).rows[0]?.status, 'reverted');
    const first = (await query('select nonce::text,tx_hash,signed_raw_tx from mix_publication_outbox')).rows[0]; assert.ok(first);
    f.state.publicationReverted = false;
    assert.equal(await reconcileMixPublication(sid, pubDeps(f), true), 'confirmed');
    const rows = (await query('select nonce::text,tx_hash,signed_raw_tx from mix_publication_outbox order by attempt')).rows;
    assert.equal(rows.length, 2); assert.notEqual(rows[1]?.nonce, first.nonce); assert.deepEqual(rows[0], first);
    assert.equal(f.state.publicationCount, 1n); assert.equal((await query('select version from strategy_versions')).rows.length, 1);
    assert.equal((await query('select status from mix_publication_receipts order by attempt')).rows[1]?.status, 'success');
  }));
});

for (const failure of ['send','missing','timeout'] as const) test(`publication ${failure} retains original bytes, allows a safe faucet nonce and recovers without a second publication`, async () => {
  await mixDbSandbox(async lane => lane(async () => {
    const id = await reserve(), f = registrationRpc();
    if (failure === 'send') f.state.publicationSendFail = true;
    if (failure === 'missing') f.state.publicationMissing = true;
    if (failure === 'timeout') f.state.publicationFail = true;
    await assert.rejects(registerMixStrategy(T.roles.keeper, 'test', allocation, id, { chain: f.chain }));
    const sid = await jobId();
    const saved = (await query<{ nonce: string; signed_raw_tx: `0x${string}` }>('select nonce::text,signed_raw_tx from mix_publication_outbox')).rows[0]; assert.ok(saved);
    assert.equal((await query('select version from strategy_versions')).rows.length, 0);
    if (failure === 'missing') {
      const broadcasts = f.state.broadcasts.length;
      assert.equal(await reconcileMixPublication(sid, pubDeps(f), true), 'unresolved');
      assert.equal(f.state.broadcasts.length, broadcasts, 'an existing first version with missing receipt cannot authorize replay');
    }
    if (failure === 'timeout') { f.state.publicationFail = false; f.state.publicationDelayMs = 500; }
    const deps = { ...pubDeps(f), timeoutMs: failure === 'timeout' ? 5 : 5000, now: () => new Date(Date.now() + PUBLICATION_ALERT_MS) };
    const started = Date.now();
    await reconcileMixPublication(sid, deps, false);
    if (failure === 'timeout') assert.ok(Date.now() - started < 400, 'receipt timeout returns while the underlying read remains pending');
    assert.ok((await query('select alerted_at from mix_publication_jobs')).rows[0]?.alerted_at instanceof Date);
    const findings = await detectAlerts(query, { env: { CHAIN_ID: '97' }, readGasPrice: async () => 1n, readNativeBalance: async () => 0n });
    assert.ok(findings.some(a => a.kind === 'portfolio_stuck' && a.portfolioId === null));
    assert.ok(await faucet(f) > Number(saved.nonce));
    f.state.publicationSendFail = false; f.state.publicationMissing = false; f.state.publicationFail = false; f.state.publicationDelayMs = 0;
    const result = await reconcileMixPublication(sid, pubDeps(f), true);
    if (result === 'replayed') assert.equal(await reconcileMixPublication(sid, pubDeps(f), true), 'confirmed');
    else assert.equal(result, 'confirmed');
    assert.equal((await query('select attempt from mix_publication_outbox')).rows.length, 1);
    assert.equal(f.state.publicationCount, 1n);
    assert.equal((await query('select version from strategy_versions')).rows.length, 1);
  }));
});

test('conflicting version/config quarantines only its job, preserves nonce authority and maintains an operations alert', async () => {
  await mixDbSandbox(async lane => lane(async () => {
    const id = await reserve(), f = registrationRpc(); f.state.publicationFail = true;
    await assert.rejects(registerMixStrategy(T.roles.keeper, 'test', allocation, id, { chain: f.chain }));
    const sid = await jobId(); f.state.publicationFail = false; f.state.publicationConfigConflict = true;
    assert.equal(await reconcileMixPublication(sid, pubDeps(f), true), 'unresolved');
    assert.equal((await query('select state from mix_publication_jobs')).rows[0]?.state, 'quarantined');
    assert.equal((await query('select version from strategy_versions')).rows.length, 0);
    assert.equal((await query('select attempt from mix_publication_outbox')).rows.length, 1);
    await withRelayerLock(97, async held => held());
    assert.ok(await faucet(f) > 0);
    assert.equal(await reconcileMixPublication(sid, pubDeps(f), true), 'unresolved');
    assert.equal(f.state.broadcasts.length, 2, 'a quarantined job cannot sign another attempt');
    assert.equal((await query('select status from mix_publication_receipts')).rows[0]?.status, 'success', 'late canonical evidence resolves the occupied nonce without unquarantining');
  }));
});

test('two workers cannot publish the same job and a held job lock never reserves the global relayer', async () => {
  await mixDbSandbox(async lane => {
    const f = registrationRpc(); let sid = '';
    await lane(async () => { const id = await reserve(); f.state.publicationFail = true;
      await assert.rejects(registerMixStrategy(T.roles.keeper, 'test', allocation, id, { chain: f.chain })); sid = await jobId(); });
    f.state.publicationFail = false;
    let notify = () => {}, release = () => {};
    const entered = new Promise<void>(resolve => { notify = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const { withMixCreationLock } = await import('../src/mix-creation.js');
    const first = lane(() => reconcileMixPublication(sid, { ...pubDeps(f), jobLock: (id, work) => withMixCreationLock(id, async () => {
      notify(); await held; return work();
    }) }, true));
    await entered;
    try {
      await lane(() => assert.rejects(reconcileMixPublication(sid, pubDeps(f), true), { code: 'MIX_CREATE_BUSY' }));
      await lane(() => withRelayerLock(97, async assertHeld => assertHeld()));
    } finally { release(); }
    assert.equal(await first, 'confirmed');
    await lane(async () => {
      assert.equal((await query('select attempt from mix_publication_outbox')).rows.length, 1);
      assert.equal((await query('select version from strategy_versions')).rows.length, 1);
      assert.equal(await reconcileMixPublication(sid, pubDeps(f), true), 'confirmed');
      assert.equal(f.state.broadcasts.length, 2);
    });
  });
});

test('publication DB errors expose only a safe error and never authorize a broadcast', async () => {
  const f = registrationRpc();
  await assert.rejects(reconcileMixPublication('1', { ...pubDeps(f), jobLock: async (_id, work) => work(),
    query: async () => { throw new Error('fixture private connection detail'); } }, true),
    error => error instanceof Error && !error.message.includes('private'));
  assert.equal(f.state.broadcasts.length, 0);
});

for (const cut of ['before','after'] as const) test(`real publication connection loss ${cut} COMMIT retains the durable identity and never broadcasts on the lost connection`, async () => {
  await mixDbSandbox(async lane => {
    const f = registrationRpc(); let saved = '';
    await lane(async () => {
      const id = await reserve(); let interrupted = false;
      const transaction: typeof withTransaction = async work => {
        let kill = false, pid = 0;
        const value = await withTransaction(async client => {
          const result = await work(client);
          if (!interrupted && (await client.query("select 1 from mix_publication_jobs where state='submitted'")).rows.length) {
            interrupted = true; kill = true;
            const process = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]; assert.ok(process); pid = process.pid;
            if (cut === 'before') await getPool().query('select pg_terminate_backend($1)', [pid]);
          }
          return result;
        });
        if (kill && cut === 'after') { await getPool().query('select pg_terminate_backend($1)', [pid]); throw new Error('fixture disconnected committed connection'); }
        return value;
      };
      await assert.rejects(registerMixStrategy(T.roles.keeper, 'test', allocation, id, { chain: f.chain, transaction }));
      assert.equal(f.state.broadcasts.length, 1);
    });
    await lane(async () => {
      saved = await jobId();
      assert.equal((await query('select attempt from mix_publication_outbox')).rows.length, cut === 'after' ? 1 : 0);
      const first = await reconcileMixPublication(saved, pubDeps(f), true);
      if (first === 'replayed') assert.equal(await reconcileMixPublication(saved, pubDeps(f), true), 'confirmed');
      else assert.equal(first, 'confirmed');
      assert.equal((await query('select attempt from mix_publication_outbox')).rows.length, 1);
      assert.equal((await query('select version from strategy_versions')).rows.length, 1);
      assert.equal(f.state.publicationCount, 1n);
    });
  });
});


test('PATCH publication without a creation request is independently discovered and completed by the reconciler', async () => {
  await mixDbSandbox(async lane => lane(async () => {
    const f = registrationRpc(), payload = publicationFixture();
    const source = (await query<{ id: string }>(`insert into strategies(provider,name,is_public,is_personal_mix,onchain_id)
      values($1,'patch publication',false,true,$2) returning id`, [T.roles.keeper, f.state.id.toString()])).rows[0]; assert.ok(source);
    f.state.publicationFail = true;
    await assert.rejects(publishMixStrategy(source.id, Number(f.state.id), undefined, allocation, payload.execution, pubDeps(f)));
    assert.equal((await query('select creation_request_id from mix_publication_jobs')).rows[0]?.creation_request_id, null);
    f.state.publicationFail = false;
    assert.equal((await reconcileRelayerTransactions({ chain: f.chain, client: f.client, operator: relayerSigner.address, replay: true })).confirmed, 1);
    assert.equal((await query('select version from strategy_versions')).rows.length, 1);
    assert.equal((await query('select id from mix_creation_requests')).rows.length, 0);
  }));
});

test('matching externally published version one is mirrored once with canonical event proof and no invented local attempt', async () => {
  await mixDbSandbox(async lane => lane(async () => {
    const f = registrationRpc(), payload = publicationFixture();
    const source = (await query<{ id: string }>(`insert into strategies(provider,name,is_public,is_personal_mix,onchain_id)
      values($1,'external publication',false,true,$2) returning id`, [T.roles.keeper, f.state.id.toString()])).rows[0]; assert.ok(source);
    const raw = await relayerSigner.signTransaction({ type: 'eip1559', chainId: 97, nonce: 0, gas: 1000000n,
      maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, to: T.contracts.registry, value: 0n, data: payload.calldata });
    assert.equal(await f.client.sendRawTransaction({ serializedTransaction: raw }), keccak256(raw));
    await publishMixStrategy(source.id, Number(f.state.id), undefined, allocation, payload.execution, pubDeps(f));
    assert.equal(await reconcileMixPublication(source.id, pubDeps(f), true), 'confirmed');
    assert.equal((await query('select attempt from mix_publication_outbox')).rows.length, 0);
    assert.equal((await query('select version from strategy_versions')).rows.length, 1);
    assert.equal((await query('select published_tx_hash from mix_publication_jobs')).rows[0]?.published_tx_hash, keccak256(raw));
  }));
});

test('version count above one is quarantined without signing a replacement or blocking the relayer', async () => {
  await mixDbSandbox(async lane => lane(async () => {
    const id = await reserve(), f = registrationRpc(); f.state.publicationFail = true;
    await assert.rejects(registerMixStrategy(T.roles.keeper, 'test', allocation, id, { chain: f.chain }));
    const sid = await jobId(); f.state.publicationFail = false; f.state.publicationCount = 2n;
    assert.equal(await reconcileMixPublication(sid, pubDeps(f), true), 'unresolved');
    assert.equal((await query('select state,last_error_code from mix_publication_jobs')).rows[0]?.state, 'quarantined');
    assert.equal((await query('select attempt from mix_publication_outbox')).rows.length, 1);
    assert.equal((await query('select version from strategy_versions')).rows.length, 0);
    await withRelayerLock(97, async held => held());
  }));
});

test('publication nonce critical section has a total deadline; a late preparation cannot sign, commit or broadcast after unlock', async () => {
  await mixDbSandbox(async lane => lane(async () => {
    const f = registrationRpc(), payload = publicationFixture();
    const source = (await query<{ id: string }>(`insert into strategies(provider,name,is_public,is_personal_mix,onchain_id)
      values($1,'bounded publication',false,true,$2) returning id`, [T.roles.keeper, f.state.id.toString()])).rows[0]; assert.ok(source);
    f.state.prepareDelayMs = 500;
    const started = Date.now();
    await assert.rejects(publishMixStrategy(source.id, Number(f.state.id), undefined, allocation, payload.execution,
      { ...pubDeps(f), nonceLockMs: 50, timeoutMs: 1000 }));
    assert.ok(Date.now() - started < 400);
    assert.equal(f.state.prepareCalls, 1, 'the timed-out preparation really started');
    assert.equal(f.state.broadcasts.length, 0);
    assert.equal((await query('select attempt from mix_publication_outbox')).rows.length, 0);
    await withRelayerLock(97, async held => held());
    f.state.prepareDelayMs = 0;
    assert.equal(await reconcileMixPublication(source.id, pubDeps(f), true), 'confirmed');
    assert.equal((await query('select attempt from mix_publication_outbox')).rows.length, 1);
    assert.equal(f.state.broadcasts.length, 1);
  }));
});

test('the native gas faucet also signs above a durable unpublished mix nonce', async () => {
  const { createServer } = await import('node:http');
  const { createGasFaucetChain } = await import('../src/gas-faucet.js');
  const { loadGasFaucetConfig } = await import('../src/config.js');
  await mixDbSandbox(async lane => lane(async () => {
    const id = await reserve(), f = registrationRpc(); f.state.publicationSendFail = true;
    await assert.rejects(registerMixStrategy(T.roles.keeper, 'test', allocation, id, { chain: f.chain }));
    const saved = (await query<{ nonce: string }>('select nonce::text from mix_publication_outbox')).rows[0]; assert.ok(saved);
    let nonce = -1, nextNonce = Number(saved.nonce), replayed = false, acknowledge = false;
    const rpc = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString());
      assert.ok(input && typeof input === 'object' && 'method' in input && 'id' in input);
      const params: unknown = 'params' in input ? input.params : []; assert.ok(Array.isArray(params));
      if (input.method === 'eth_fillTransaction') { res.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, error: { code: -32601, message: 'method not found' } })); return; }
      let result: unknown;
      if (input.method === 'eth_chainId') result = '0x61';
      else if (input.method === 'eth_getTransactionCount') result = '0x' + nextNonce.toString(16);
      else if (input.method === 'eth_call') result = '0x' + '0'.repeat(64);
      else if (input.method === 'eth_gasPrice' || input.method === 'eth_maxPriorityFeePerGas') result = '0x1';
      else if (input.method === 'eth_estimateGas') result = '0x5208';
      else if (input.method === 'eth_getBlockByNumber') result = { number: '0x1', hash: zeroHash, timestamp: '0x64', baseFeePerGas: '0x1', gasLimit: '0x1000000', gasUsed: '0x1', transactions: [] };
      else if (input.method === 'eth_sendRawTransaction') {
        const raw: unknown = params[0]; assert.ok(typeof raw === 'string' && /^0x([0-9a-f]{2})+$/.test(raw));
        const signed: `0x${string}` = `0x${raw.slice(2)}`; const tx = parseTransaction(signed); assert.ok(tx.nonce !== undefined);
        if (tx.to?.toLowerCase() === T.contracts.registry) { assert.equal(tx.nonce, Number(saved.nonce)); replayed = true; }
        else nonce = tx.nonce;
        if (acknowledge) nextNonce = tx.nonce + 1; result = keccak256(signed);
      } else assert.fail('unexpected native faucet method');
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
    });
    await new Promise<void>(resolve => rpc.listen(0, '127.0.0.1', resolve));
    const address = rpc.address(); assert.ok(address && typeof address !== 'string');
    try {
      const config = loadGasFaucetConfig({ CHAIN_ID: '97', GAS_FAUCET_ENABLED: '1' }); assert.ok(config);
      const chain = createGasFaucetChain(config, { chainId: 97, rpcUrl: `http://127.0.0.1:${address.port}`,
        operatorPrivateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' });
      await assert.rejects(withRelayerLock(97, async held => { const prepared = await chain.prepare(T.roles.keeper, config.targetWei); held(); await prepared.broadcast(); }), { code: 'RELAYER_BUSY' });
      assert.equal(nonce, -1, 'an unfilled gap cannot authorize a fresh native transaction');
      acknowledge = true;
      await withRelayerLock(97, async held => { const prepared = await chain.prepare(T.roles.keeper, config.targetWei); held(); await prepared.broadcast(); });
      assert.equal(replayed, true); assert.equal(nonce, Number(saved.nonce) + 1);
    } finally { rpc.closeAllConnections(); await new Promise<void>(resolve => rpc.close(() => resolve())); }
  }));
});


test('an RPC block-number mismatch cannot authorize a publication signature or broadcast', async () => {
  await mixDbSandbox(async lane => lane(async () => {
    const f = registrationRpc(), payload = publicationFixture(); f.state.blockNumberMismatch = true;
    const source = (await query<{ id: string }>(`insert into strategies(provider,name,is_public,is_personal_mix,onchain_id)
      values($1,'block mismatch',false,true,$2) returning id`, [T.roles.keeper, f.state.id.toString()])).rows[0]; assert.ok(source);
    await assert.rejects(publishMixStrategy(source.id, Number(f.state.id), undefined, allocation, payload.execution, pubDeps(f)));
    assert.equal(f.state.broadcasts.length, 0);
    assert.equal((await query('select attempt from mix_publication_outbox')).rows.length, 0);
  }));
});
