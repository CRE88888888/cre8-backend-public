import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findPublicationNonceConsumption, verifyPublicationNonceConsumption } from '../src/mix-publication-nonce.js';
import type { NonceOriginal } from '../src/mix-publication-nonce.js';
import { registrationRpc } from './fixtures/mix-registration.js';
import { foreignNonceRpc } from './fixtures/mix-publication-nonce.js';
import { relayerSigner } from './fixtures/relayer.js';
import { toHex, zeroHash } from 'viem';
async function fixture(nonce = 3) {
  const raw = await relayerSigner.signTransaction({ chainId: 97, type: 'eip1559', nonce, gas: 21000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, to: relayerSigner.address, value: 1n });
  const f = foreignNonceRpc(registrationRpc(), raw);
  const read = <R>(work: Promise<R>) => work;
  const original: NonceOriginal = { signer: relayerSigner.address, nonce: nonce.toString(), tx_hash: zeroHash, checked_block_number: '1' };
  const observed = { number: 3n, hash: toHex(3n, { size: 32 }), at: new Date(102000) };
  const anchor = async (number: bigint) => { const b = await f.client.getBlock({ blockNumber: number }); assert.ok(b.hash && b.number !== null); return { number: b.number, hash: b.hash, at: new Date(Number(b.timestamp) * 1000) }; };
  return { f, original, observed, read, anchor, find: () => findPublicationNonceConsumption(f.client, original, observed, read, anchor) };
}
test('external nonce discovery requires a full canonical same-signer transaction and accepts both successful and reverted consumption', async () => {
  for (const reverted of [false, true]) {
    const x = await fixture(); x.f.foreignState.reverted = reverted;
    const proof = await x.find(); assert.ok(proof); assert.equal(proof.foreign_tx_hash, x.f.foreignHash); assert.equal(proof.block_number, '2');
    await verifyPublicationNonceConsumption(x.f.client, x.original, proof, x.read, x.anchor);
    x.f.foreignState.reorg = true;
    await assert.rejects(verifyPublicationNonceConsumption(x.f.client, x.original, proof, x.read, x.anchor));
  }
});
test('pending-only progress, the original hash, incomplete/ambiguous transaction and receipt data never authorize a replacement', async () => {
  const pending = await fixture(); pending.f.foreignState.pendingOnly = true; assert.equal(await pending.find(), null);
  const original = await fixture(); original.original.tx_hash = original.f.foreignHash; assert.equal(await original.find(), null);
  for (const mode of ['missingTransaction', 'missingReceipt', 'wrongReceipt', 'duplicate'] as const) {
    const x = await fixture(); x.f.foreignState[mode] = true; await assert.rejects(x.find());
  }
  const rpc = await fixture(); rpc.f.state.mode = 'rpc'; await assert.rejects(rpc.find());
  const chain = await fixture(); chain.f.state.mode = 'chain'; await assert.rejects(chain.find());
});

test('zero nonce is valid, out-of-range RPC counts and a timed out lookup cannot prove consumption', async () => {
  const zero = await fixture(0); assert.equal((await zero.find())?.foreign_tx_hash, zero.f.foreignHash);
  const large = await fixture(Number.MAX_SAFE_INTEGER); await assert.rejects(large.find());
  const slow = await fixture(); slow.f.foreignState.delayMs = 50;
  const read = async <R>(work: Promise<R>): Promise<R> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('fixture timeout')), 5); })]); }
    finally { clearTimeout(timer); }
  };
  await assert.rejects(findPublicationNonceConsumption(slow.f.client, slow.original, slow.observed, read, slow.anchor), /fixture timeout/);
});
