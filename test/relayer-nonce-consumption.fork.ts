import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, test } from 'node:test';
import { createPublicClient, createTestClient, createWalletClient, encodeFunctionData, erc20Abi, http, keccak256, parseAbi } from 'viem';
import type { Address } from 'viem';
import { bscTestnet } from 'viem/chains';
import { closePool, query, withTransaction } from '../src/db.js';
import { mixDbSandbox } from './fixtures/mix-db.js';
import { pendingFunding } from './fixtures/relayer-consumption.js';
import { relayerSigner } from './fixtures/relayer.js';
import { FAUCET_ABI, readFaucetFundingEvidence, reserveFaucetClaim, settleFaucetClaim } from '../src/faucet.js';
import { reconcileRelayerTransactions } from '../src/relayer-reconciliation.js';
import { withRelayerLock, relayerNonce } from '../src/relayer-lock.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';

// Explicit acceptance only: never included by bun test's *.test.ts discovery.
const rpc = 'http://127.0.0.1:8582';
const transport = http(rpc, { timeout: 30000, retryCount: 0 });
const client = createPublicClient({ chain: bscTestnet, transport, cacheTime: 0 });
const local = createTestClient({ chain: bscTestnet, mode: 'anvil', transport });
const wallet = createWalletClient({ chain: bscTestnet, account: relayerSigner, transport });
after(closePool);

test('local chain 97 fork: an external transaction consumes a saved faucet nonce and the next faucet really funds its recipient', { timeout: 120000 }, async () => {
  assert.equal(await client.getChainId(), 97);
  assert.match(await client.request({ method: 'web3_clientVersion' }), /anvil/i);
  assert.equal(await local.getAutomine(), true);
  const fork = await client.getBlock(), snapshot = await local.snapshot();
  try {
    await local.setBalance({ address: relayerSigner.address, value: 100n * 10n ** 18n });
    const abi = parseAbi(['function owner() view returns(address)', 'function setFaucet(address,bool)', 'function isFaucet(address) view returns(bool)']);
    const owner = await client.readContract({ address: T.contracts.usdt, abi, functionName: 'owner' });
    await local.impersonateAccount({ address: owner });
    try {
      await local.setBalance({ address: owner, value: 10n ** 20n });
      const admin = createWalletClient({ chain: bscTestnet, account: owner, transport });
      const appointed = await admin.writeContract({ address: T.contracts.usdt, abi, functionName: 'setFaucet', args: [relayerSigner.address, true] });
      await local.mine({ blocks: 1 });
      assert.equal((await client.getTransactionReceipt({ hash: appointed })).status, 'success');
    } finally { await local.stopImpersonatingAccount({ address: owner }); }
    assert.equal(await client.readContract({ address: T.contracts.usdt, abi, functionName: 'isFaucet', args: [relayerSigner.address] }), true);
    await mixDbSandbox(async lane => lane(async () => {
      const nonce = await client.getTransactionCount({ address: relayerSigner.address });
      const original = await pendingFunding('faucet', nonce);
      await assert.rejects(withRelayerLock(97, async () => assert.fail('unresolved original')), { code: 'RELAYER_BUSY' });
      // Only the public anvil key signs; the saved faucet bytes are never sent.
      const beforeConsumption = await local.snapshot();
      const foreign = await wallet.sendTransaction({ to: relayerSigner.address, value: 1n, nonce });
      const foreignReceipt = await client.waitForTransactionReceipt({ hash: foreign, timeout: 5000, pollingInterval: 20, confirmations: 1 });
      assert.equal(foreignReceipt.status, 'success');
      assert.equal((await client.getBlock()).number, foreignReceipt.blockNumber);
      for (const confirmations of [0, 14]) {
        if (confirmations) await local.mine({ blocks: confirmations });
        const pending = await reconcileRelayerTransactions({ client, operator: relayerSigner.address, replay: true, timeoutMs: 30000 });
        assert.equal(pending.failed, 0); assert.ok(pending.unresolved > 0);
        assert.equal((await query('select * from relayer_outbox_nonce_consumptions')).rows.length, 0);
        assert.equal((await query('select state from faucet_claims where id=$1', [original.source.id])).rows[0]?.state, 'submitted');
      }
      await local.mine({ blocks: 1 });
      assert.equal((await client.getBlock()).number, foreignReceipt.blockNumber + 15n);
      const block = await client.getBlock({ blockNumber: foreignReceipt.blockNumber });
      const waitMs = Math.max(0, Number(block.timestamp) * 1000 - Date.now() + 1);
      assert.ok(waitMs <= 10000, 'local fork clock exceeds the evidence observation budget');
      if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
      const reconciled = await reconcileRelayerTransactions({ client, operator: relayerSigner.address, replay: true, timeoutMs: 30000 });
      assert.equal(reconciled.failed, 1); assert.equal(reconciled.replayed, 0); assert.equal(reconciled.unresolved, 0);
      assert.equal((await query('select state from faucet_claims where id=$1', [original.source.id])).rows[0]?.state, 'failed');
      assert.equal((await query('select foreign_tx_hash from relayer_outbox_nonce_consumptions where tx_hash=$1', [original.signed.hash])).rows[0]?.foreign_tx_hash, foreign);
      assert.equal((await query('select signed_raw_tx from relayer_transaction_outbox where tx_hash=$1', [original.signed.hash])).rows[0]?.signed_raw_tx, original.signed.raw);
      const recipient: Address = `0x${randomBytes(20).toString('hex')}`;
      const amountWei = 10n ** 18n;
      const before = await client.readContract({ address: T.contracts.usdt, abi: erc20Abi, functionName: 'balanceOf', args: [recipient] });
      const landed = await withRelayerLock(97, async held => {
        const selected = await relayerNonce(client, relayerSigner.address); assert.equal(selected.nonce, nonce + 1);
        const claim = await reserveFaucetClaim({ config: { chainId: 97, amountWei, siteDailyWei: 10n ** 30n, timeoutMs: 5000 }, owner: relayerSigner.address, account: recipient });
        const request = await wallet.prepareTransactionRequest({ to: T.contracts.usdt, value: 0n, gas: 200000n,
          data: encodeFunctionData({ abi: FAUCET_ABI, functionName: 'claimFor', args: [recipient, amountWei] }), ...selected });
        const raw = await wallet.signTransaction(request), hash = keccak256(raw);
        held(); await settleFaucetClaim(claim, 'reserved', 'submitted', hash, withTransaction, { raw, operator: relayerSigner.address });
        held(); assert.equal(await client.sendRawTransaction({ serializedTransaction: raw }), hash);
        await local.mine({ blocks: 1 });
        await readFaucetFundingEvidence({ ...claim, txHash: hash }, client, relayerSigner.address);
        await settleFaucetClaim(claim, 'submitted', 'confirmed', hash);
        return hash;
      });
      assert.equal(await client.readContract({ address: T.contracts.usdt, abi: erc20Abi, functionName: 'balanceOf', args: [recipient] }), before + amountWei);
      assert.equal((await reconcileRelayerTransactions({ client, operator: relayerSigner.address, replay: true, timeoutMs: 30000 })).failed, 0);
      // Replace the proven branch after recovery. Retain failed original and
      // proof, quarantine, and never mint or create a claim automatically.
      await local.revert({ id: beforeConsumption });
      await local.mine({ blocks: 16 });
      assert.notEqual((await client.getBlock({ blockNumber: foreignReceipt.blockNumber })).hash, foreignReceipt.blockHash);
      const reorg = await reconcileRelayerTransactions({ client, operator: relayerSigner.address, replay: true, timeoutMs: 30000 });
      assert.ok(reorg.unresolved > 0); assert.equal(reorg.failed, 0); assert.equal(reorg.confirmed, 0);
      assert.equal((await query('select * from relayer_outbox_nonce_quarantines')).rows.length, 1);
      assert.equal((await query('select state from faucet_claims where id=$1', [original.source.id])).rows[0]?.state, 'failed');
      assert.equal((await query('select * from faucet_claims')).rows.length, 2);
      assert.equal(await client.readContract({ address: T.contracts.usdt, abi: erc20Abi, functionName: 'balanceOf', args: [recipient] }), before);
      console.log('FAUCET_EXTERNAL_NONCE_RECOVERY', JSON.stringify({ forkBlock: fork.number?.toString(), originalNonce: nonce,
        nextNonce: nonce + 1, confirmations: 15, reorgQuarantined: true, foreignHash: foreign, nextFaucetHash: landed, amountWei: amountWei.toString() }));
    }));
  } finally { await local.revert({ id: snapshot }); }
});
