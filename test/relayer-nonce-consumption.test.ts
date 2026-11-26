import assert from 'node:assert/strict';
import { test } from 'node:test';
import { zeroHash } from 'viem';
import { findOutboxConsumption, verifyOutboxConsumption } from '../src/relayer-nonce-consumption.js';
import { foreignRpc } from './fixtures/relayer-consumption.js';
import { relayerSigner } from './fixtures/relayer.js';

const original = { tx_hash: zeroHash, signer: relayerSigner.address, nonce: '0' };
for (const confirmations of [0n, 14n, 15n, 16n]) test(`outbox evidence requires 15 successor blocks: ${confirmations} confirmations`, async () => {
  const rpc = await foreignRpc(0);
  rpc.foreignState.head = 2n + confirmations;
  const proof = await findOutboxConsumption(rpc.client, original);
  if (confirmations < 15n) assert.equal(proof, null);
  else {
    assert.ok(proof);
    assert.equal(proof.block_number, '2');
    await verifyOutboxConsumption(rpc.client, original, proof);
  }
});

test('a saved proof cannot authorize persistence or a replacement after the head retreats below 15 confirmations', async () => {
  const rpc = await foreignRpc(0);
  const proof = await findOutboxConsumption(rpc.client, original); assert.ok(proof);
  rpc.foreignState.head = 16n;
  await assert.rejects(verifyOutboxConsumption(rpc.client, original, proof));
});

test('a retreat during final verification cannot authorize consumption', async () => {
  const rpc = await foreignRpc(0);
  const proof = await findOutboxConsumption(rpc.client, original); assert.ok(proof);
  rpc.foreignState.headSequence = [17n, 16n];
  await assert.rejects(verifyOutboxConsumption(rpc.client, original, proof));
});

for (const failure of ['missingHead', 'headError', 'timeout', 'reorg'] as const) test(`outbox finality ${failure} retains original authority`, async () => {
  const rpc = await foreignRpc(0);
  const proof = await findOutboxConsumption(rpc.client, original); assert.ok(proof);
  if (failure === 'timeout') rpc.foreignState.delayMs = 30;
  else rpc.foreignState[failure] = true;
  await assert.rejects(verifyOutboxConsumption(rpc.client, original, proof, failure === 'timeout' ? 1 : 5000));
});
