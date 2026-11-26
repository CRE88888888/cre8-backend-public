import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak256, zeroHash } from 'viem';
import type { Hex } from 'viem';
import { validatePublication, validatePublicationTransaction } from '../src/mix-publication.js';
import { publicationFixture } from './fixtures/mix-publication.js';
import { relayerSigner } from './fixtures/relayer.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';

test('publication validates its full public settings, hash and calldata rather than just a matching version number', () => {
  const original = publicationFixture(); validatePublication(original);
  for (const mutate of [
    (j: typeof original) => { j.chain_id = '56'; },
    (j: typeof original) => { j.registry = T.contracts.executor; },
    (j: typeof original) => { j.config_hash = zeroHash; },
    (j: typeof original) => { j.calldata = '0x'; },
    (j: typeof original) => { j.allocation.p11.settingsHash = zeroHash; },
    (j: typeof original) => { j.execution.rebalance = 'monthly'; },
    (j: typeof original) => { j.onchain_strategy_id = '0'; },
    (j: typeof original) => { j.onchain_strategy_id = (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString(); },
  ]) { const changed = structuredClone(original); mutate(changed); assert.throws(() => validatePublication(changed), /目前無法確認/); }
});
test('publication raw authority binds hash, chain, signer, nonce, registry, zero value, gas and exact first-version calldata', async () => {
  const job = publicationFixture();
  const sign = (overrides: { chainId?: number; nonce?: number; to?: `0x${string}`; value?: bigint; data?: Hex; gas?: bigint } = {}) => relayerSigner.signTransaction({
    type: 'eip1559', chainId: 97, nonce: 0, gas: 1000000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n,
    to: job.registry, value: 0n, data: job.calldata, ...overrides });
  const raw = await sign();
  const proof = { tx_hash: keccak256(raw), signed_raw_tx: raw, signer: relayerSigner.address, nonce: '0' };
  await validatePublicationTransaction(job, proof);
  for (const changed of [{ ...proof, tx_hash: zeroHash }, { ...proof, signer: T.roles.operator }, { ...proof, nonce: '1' }]) {
    await assert.rejects(validatePublicationTransaction(job, changed), /目前無法確認/);
  }
  for (const input of [{ chainId: 56 }, { nonce: 1 }, { to: T.contracts.usdt }, { value: 1n }, { data: '0x' as const }, { gas: 0n }]) {
    const changed = await sign(input);
    await assert.rejects(validatePublicationTransaction(job, { ...proof, signed_raw_tx: changed, tx_hash: keccak256(changed) }), /目前無法確認/);
  }
});
