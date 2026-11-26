import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import { closePool, query, withTransaction } from '../src/db.js';
import { AppError } from '../src/errors.js';
import { createWelcomeService, findWelcomeGrant } from '../src/welcome-grants.js';
import { withRelayerLock } from '../src/relayer-lock.js';
import { reconcileRelayerTransactions } from '../src/relayer-reconciliation.js';
import { welcomeFixture } from './fixtures/welcome.js';
import { reserveFaucetClaim, settleFaucetClaim } from '../src/faucet.js';
import type { FaucetClaim } from '../src/faucet.js';
import { signedFundingTx } from './fixtures/relayer.js';
import { parseTransaction } from 'viem';

const fixtures: Awaited<ReturnType<typeof welcomeFixture>>[] = [];
const claims: { claim: FaucetClaim; hash: `0x${string}` }[] = [];
async function fixture() { const f = await welcomeFixture(); fixtures.push(f); return f; }
afterEach(async () => {
  for (const { claim, hash } of claims.splice(0)) {
    const state = (await query<{ state: string }>('select state from faucet_claims where id=$1', [claim.id])).rows[0]?.state;
    if (state === 'submitted' || state === 'unknown') await settleFaucetClaim(claim, state, 'failed', hash);
  }
  for (const f of fixtures.splice(0)) {
    const g = await findWelcomeGrant(97, f.owner);
    if (g && !['confirmed','failed'].includes(g.state)) await f.settle(g, 'failed', g.txHash);
  }
});

test('#97 missing receipt replays only identical saved bytes, repeated workers never prepare a replacement, then settle canonical evidence', async () => {
  for (const kind of ['welcome', 'faucet'] as const) {
    const f = await fixture();
    let id: string;
    let signed = f.signed;
    if (kind === 'welcome') { const g = await f.deps.welcome?.issue(f.recipient); assert.ok(g); id = g.id; }
    else {
      const claim = await reserveFaucetClaim({ config: { chainId: 97, amountWei: 1000n * 10n ** 18n, siteDailyWei: 10n ** 30n, timeoutMs: 5000 }, owner: f.owner, account: f.account });
      signed = await signedFundingTx('faucet', claim.account, claim.amountWei);
      await settleFaucetClaim(claim, 'reserved', 'submitted', signed.hash, withTransaction, signed);
      claims.push({ claim, hash: signed.hash }); id = claim.id;
      f.rpc.state.mint = false; f.rpc.state.txHash = signed.hash; f.rpc.state.amount = claim.amountWei;
      f.rpc.state.txNonce = parseTransaction(signed.raw).nonce ?? 0; f.rpc.state.by = signed.operator;
    }
    f.rpc.state.missingReceipt = true;
    for (let i = 0; i < 2; i++) {
      const result = await reconcileRelayerTransactions({ client: f.rpc.client, operator: signed.operator, replay: true });
      assert.equal(result.replayed, 1); assert.equal(result.unresolved, 1);
      await assert.rejects(withRelayerLock(97, async () => assert.fail('new nonce')), { code: 'RELAYER_BUSY' });
    }
    assert.deepEqual(f.rpc.state.broadcasts, [signed.raw, signed.raw]);
    f.rpc.state.missingReceipt = false;
    assert.equal((await reconcileRelayerTransactions({ client: f.rpc.client, operator: signed.operator, replay: true })).confirmed, 1);
    const table = kind === 'welcome' ? 'welcome_grants' : 'faucet_claims';
    assert.equal((await query<{ state: string }>(`select state from ${table} where id=$1`, [id])).rows[0]?.state, 'confirmed');
    assert.equal(f.rpc.state.broadcasts.length, 2);
  }
});

test('#97 canonical revert releases the original charge; reorg, missing event and wrong transaction do not', async () => {
  for (const mode of ['reorg', 'event', 'wrong-tx', 'revert']) {
    const f = await fixture(); await f.deps.welcome?.issue(f.recipient);
    if (mode === 'reorg') f.rpc.state.blockHash = `0x${'00'.repeat(32)}`;
    if (mode === 'event') f.rpc.state.logs = false;
    if (mode === 'wrong-tx') f.rpc.state.txNonce++;
    if (mode === 'revert') f.rpc.state.success = false;
    const result = await reconcileRelayerTransactions({ client: f.rpc.client, operator: f.signed.operator, replay: true });
    assert.equal(result.failed, mode === 'revert' ? 1 : 0);
    assert.equal(result.unresolved, mode === 'revert' ? 0 : 1);
    assert.equal((await findWelcomeGrant(97, f.owner))?.state, mode === 'revert' ? 'failed' : 'submitted');
    assert.equal(f.rpc.state.broadcasts.length, 0);
    const g = await findWelcomeGrant(97, f.owner);
    if (g && g.state === 'submitted') await f.settle(g, 'failed', g.txHash);
  }
});

test('#97 legacy hash-only rows remain unresolved across UTC days and are never given new bytes', async () => {
  const f = await fixture();
  await query(`insert into faucet_claims(chain_id,owner,account,amount_wei,state,tx_hash,created_at)
    values(97,$1,$2,1000,'unknown',$3,'2000-01-01T23:59:59Z')`, [f.owner, f.account, f.signed.hash]);
  try {
    const result = await reconcileRelayerTransactions({ client: f.rpc.client, operator: f.signed.operator, replay: true });
    assert.equal(result.unresolved, 1); assert.equal(result.replayed, 0);
    assert.equal(f.rpc.state.reads.length, 0); assert.equal(f.rpc.state.broadcasts.length, 0);
    await assert.rejects(withRelayerLock(97, async () => assert.fail('new nonce')), { code: 'RELAYER_BUSY' });
  } finally {
    // Controlled legacy fixture only; production never infers failure from missing raw.
    await query("update faucet_claims set state='failed',updated_at=clock_timestamp() where tx_hash=$1", [f.signed.hash]);
  }
});
after(closePool);

test('#97 unknown submission COMMIT sends nothing; concurrent workers settle original hash after restart without preparing again', async () => {
  const f = await fixture(); let sends = 0;
  const service = createWelcomeService({ config: { chainId: 97, siteDailyWei: 10n ** 30n, timeoutMs: 5000 },
    prepare: async () => ({ ...f.signed, broadcast: async () => { sends++; }, wait: async () => {} }),
    settle: (g, state, hash, evidence, _transaction, signed) => f.settle(g, state, hash, evidence,
      async fn => { await withTransaction(fn); throw new Error('SECRET unknown COMMIT'); }, signed) });
  await assert.rejects(service.issue(f.recipient), (e: unknown) => e instanceof AppError && e.code === 'WELCOME_STORAGE_UNAVAILABLE');
  assert.equal(sends, 0);
  const g = await findWelcomeGrant(97, f.owner); assert.equal(g?.state, 'submitted');
  await assert.rejects(withRelayerLock(97, async () => assert.fail('new nonce')), { code: 'RELAYER_BUSY' });
  const outcomes = await Promise.allSettled(Array.from({ length: 4 }, () => reconcileRelayerTransactions({ client: f.rpc.client, operator: f.signed.operator, replay: true })));
  assert.equal(outcomes.reduce((n,r) => n + (r.status === 'fulfilled' ? r.value.confirmed : 0), 0), 1);
  for (const outcome of outcomes) if (outcome.status === 'rejected') assert.ok(outcome.reason instanceof AppError && outcome.reason.code === 'RELAYER_RECONCILIATION_UNAVAILABLE');
  assert.equal((await findWelcomeGrant(97, f.owner))?.state, 'confirmed');
  await withRelayerLock(97, async held => held());
  assert.equal((await query('select tx_hash from relayer_transaction_outbox where welcome_grant_id=$1', [g?.id])).rows.length, 1);
});

test('#97 RPC error, timeout, missing receipt and signer mismatch retain quota and block new nonce; dry-run never sends', async () => {
  const f = await fixture();
  await f.deps.welcome?.issue(f.recipient);
  for (const mode of ['rpc', 'missing', 'wrong-signer', 'timeout']) {
    f.rpc.state.fail = mode === 'rpc' ? 'eth_getTransactionReceipt' : '';
    f.rpc.state.missingReceipt = mode === 'missing'; f.rpc.state.receiptDelayMs = mode === 'timeout' ? 30 : 0;
    const result = await reconcileRelayerTransactions({ client: f.rpc.client, operator: mode === 'wrong-signer' ? f.owner : f.signed.operator,
      replay: false, timeoutMs: mode === 'timeout' ? 1 : 5000 });
    assert.equal(result.unresolved, 1);
    await assert.rejects(withRelayerLock(97, async () => assert.fail('new nonce')), { code: 'RELAYER_BUSY' });
    assert.equal(f.rpc.state.broadcasts.length, 0);
  }
});
