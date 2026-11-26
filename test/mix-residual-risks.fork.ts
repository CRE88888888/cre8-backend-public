import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createPublicClient, createWalletClient, createTestClient, decodeEventLog, http } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';
import { query, withTransaction, closePool } from '../src/db.js';
import { mixDbSandbox } from './fixtures/mix-db.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
import { REGISTRY_ABI, REGISTRY_VERSION_ABI } from '../src/registry-abi.js';
import { mixChainAllocation } from '../src/mix-domain.js';
import { validateAssetConfig } from '../src/strategy-execution.js';
import { publishMixStrategy, reconcileMixPublication } from '../src/mix-publication.js';
import { relayerNonce, withRelayerLock } from '../src/relayer-lock.js';
import { kernelAddressesForChain } from '../src/addresses.js';
const rpc = 'http://127.0.0.1:8580';
const transport = http(rpc, { timeout: 30000, retryCount: 0 });
const client = createPublicClient({ chain: bscTestnet, transport, cacheTime: 0, pollingInterval: 20 });
const local = createTestClient({ chain: bscTestnet, mode: 'anvil', transport });
const operator = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 2 });
const wallet = createWalletClient({ chain: bscTestnet, transport, account: operator });
const chain = { chainId: 97, rpcUrl: rpc, registryAddress: T.contracts.registry, publicClient: client, wallet, account: operator, kernel: kernelAddressesForChain(97) };
const deps = { client, chain, operator: operator.address, query, transaction: withTransaction };
const allocation = { assets: mixChainAllocation([{ assetId: T.assets.NVDAB.token, weightBps: 10000 }], [], 128).assets };
const execution = validateAssetConfig(undefined, allocation, 97);
before(async () => {
  assert.equal(await client.getChainId(), 97);
  const version = await client.request({ method: 'web3_clientVersion' }); assert.match(version, /anvil/i);
  assert.equal(await local.getAutomine(), true);
  await local.setBalance({ address: operator.address, value: 100n * 10n ** 18n });
  const block = await client.getBlock(); console.log('RESIDUAL_FORK', JSON.stringify({ number: block.number.toString(), hash: block.hash }));
});
after(closePool);
async function source() {
  const hash = await wallet.writeContract({ address: T.contracts.registry, abi: REGISTRY_ABI, functionName: 'registerStrategy', args: ['CRE8 mix', 'My mix', false] });
  await local.mine({ blocks: 1 });
  const receipt = await client.getTransactionReceipt({ hash }); assert.equal(receipt.status, 'success');
  const event = receipt.logs.flatMap(log => { try { const e = decodeEventLog({ abi: REGISTRY_ABI, ...log }); return e.eventName === 'StrategyRegistered' ? [e] : []; } catch { return []; } })[0]; assert.ok(event);
  const row = (await query<{ id: string }>(`insert into strategies(provider,name,is_public,is_personal_mix,onchain_id)
    values($1,'local residual recovery',false,true,$2) returning id`, [operator.address.toLowerCase(), event.args.id.toString()])).rows[0]; assert.ok(row);
  return { sid: row.id, id: event.args.id };
}
test('a canonical receipt reorg quarantines the mix but its original fills the gap and ordinary relayer work lands', async () => {
  await mixDbSandbox(async lane => lane(async () => {
    const s = await source(), snapshot = await local.snapshot();
    await publishMixStrategy(s.sid, Number(s.id), undefined, allocation, execution, deps);
    const saved = (await query<{ nonce: string; tx_hash: `0x${string}` }>('select nonce::text,tx_hash from mix_publication_outbox')).rows[0]; assert.ok(saved);
    assert.equal((await query('select status from mix_publication_receipts')).rows[0]?.status, 'success');
    await local.revert({ id: snapshot }); await local.increaseTime({ seconds: 1 }); await local.mine({ blocks: 1 });
    assert.equal(await client.readContract({ address: T.contracts.registry, abi: REGISTRY_VERSION_ABI, functionName: 'versionCount', args: [s.id] }), 0n);
    assert.equal(await reconcileMixPublication(s.sid, deps, false), 'unresolved');
    assert.equal((await query('select state from mix_publication_jobs')).rows[0]?.state, 'quarantined');
    const hash = await withRelayerLock(97, async held => {
      const selected = await relayerNonce(client, operator.address); assert.equal(selected.nonce, Number(saved.nonce) + 1);
      held(); return wallet.sendTransaction({ to: operator.address, value: 1n, ...selected });
    });
    await local.mine({ blocks: 1 });
    const receipt = await client.getTransactionReceipt({ hash }); assert.equal(receipt.status, 'success');
    assert.equal((await client.getTransactionReceipt({ hash: saved.tx_hash })).status, 'success');
    assert.equal((await query('select tx_hash from mix_publication_outbox')).rows[0]?.tx_hash, saved.tx_hash);
    assert.equal((await query('select attempt from mix_publication_outbox')).rows.length, 1);
    assert.equal((await query('select state from mix_publication_jobs')).rows[0]?.state, 'quarantined', 'replaying a nonce never discards its reorg audit');
    console.log('REORG_RELAYER_RECOVERY', JSON.stringify({ strategyId: s.id.toString(), publicationNonce: saved.nonce, nextNonce: Number(saved.nonce) + 1, txHash: hash }));
  }));
});

test('a manual canonical transaction consumes the original publication nonce and recovery signs once with a new nonce', async () => {
  await mixDbSandbox(async lane => lane(async () => {
    const s = await source(); let interrupted = false;
    await assert.rejects(publishMixStrategy(s.sid, Number(s.id), undefined, allocation, execution, { ...deps,
      transaction: async work => {
        const value = await withTransaction(work);
        if (!interrupted) { interrupted = true; throw new Error('local COMMIT response interrupted before broadcast'); }
        return value;
      } }));
    const original = (await query<{ nonce: string; signer: `0x${string}`; checked_block_number: string; tx_hash: `0x${string}`; signed_raw_tx: string }>('select nonce::text,signer,checked_block_number::text,tx_hash,signed_raw_tx from mix_publication_outbox')).rows[0]; assert.ok(original);
    const foreign = await wallet.sendTransaction({ to: operator.address, value: 1n, nonce: Number(original.nonce) });
    await local.mine({ blocks: 2 });
    assert.equal((await client.getTransactionReceipt({ hash: foreign })).status, 'success');
    const { findPublicationNonceConsumption } = await import('../src/mix-publication-nonce.js');
    const observed = await client.getBlock(); assert.ok(observed.hash && observed.number !== null);
    const proof = await findPublicationNonceConsumption(client, original, { number: observed.number, hash: observed.hash, at: new Date(Number(observed.timestamp) * 1000) }, work => work, async number => {
      const block = await client.getBlock({ blockNumber: number }); assert.ok(block.hash && block.number !== null); return { number: block.number, hash: block.hash, at: new Date(Number(block.timestamp) * 1000) };
    });
    assert.equal(proof?.foreign_tx_hash, foreign);
    assert.ok(proof);
    // Anvil advances timestamps by one second per mined block. Wait for the
    // DB observation clock rather than inventing a future detected_at.
    const waitMs = Math.max(0, proof.block_time.getTime() - Date.now() + 1);
    assert.ok(waitMs <= 10000, 'local fork clock drift exceeds the acceptance budget');
    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
    assert.equal(await reconcileMixPublication(s.sid, deps, true), 'consumed');
    assert.equal((await query('select foreign_tx_hash from mix_publication_nonce_consumptions')).rows[0]?.foreign_tx_hash, foreign);
    assert.equal(await reconcileMixPublication(s.sid, deps, true), 'confirmed');
    const outbox = (await query<{ nonce: string; tx_hash: string; signed_raw_tx: string }>('select nonce::text,tx_hash,signed_raw_tx from mix_publication_outbox order by attempt')).rows;
    assert.equal(outbox.length, 2); assert.deepEqual(outbox[0], { nonce: original.nonce, tx_hash: original.tx_hash, signed_raw_tx: original.signed_raw_tx });
    assert.equal(outbox[1]?.nonce, (Number(original.nonce) + 1).toString());
    assert.equal((await query('select status from mix_publication_receipts')).rows[0]?.status, 'success');
    assert.equal((await query('select version from strategy_versions')).rows.length, 1);
    assert.equal(await client.readContract({ address: T.contracts.registry, abi: REGISTRY_VERSION_ABI, functionName: 'versionCount', args: [s.id] }), 1n);
    console.log('EXTERNAL_NONCE_RECOVERY', JSON.stringify({ strategyId: s.id.toString(), originalNonce: original.nonce, replacementNonce: outbox[1]?.nonce, foreignHash: foreign }));
  }));
});
