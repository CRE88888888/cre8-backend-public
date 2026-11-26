import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeFunctionData, zeroAddress, zeroHash } from 'viem';
import { REGISTRY_ABI } from '../src/registry-abi.js';
import { validateMixRegistration } from '../src/mix-registration.js';
import { mixRequestHash, mixRequestKey } from '../src/mix-creation.js';
import { signedMixRegistration } from './fixtures/mix-registration.js';
import { relayerSigner } from './fixtures/relayer.js';
const identity = { operator: relayerSigner.address };
test('registration outbox binds signed hash, chain, signer, nonce, registry, zero value and exact fixed private metadata', async () => {
  for (const nonce of [0, Number.MAX_SAFE_INTEGER]) {
    const signed = await signedMixRegistration({ nonce });
    await validateMixRegistration(signed.hash, signed.raw, identity, nonce);
    await assert.rejects(validateMixRegistration(signed.hash, signed.raw, identity, nonce === 0 ? 1 : 0));
    await assert.rejects(validateMixRegistration(signed.hash, signed.raw));
    await assert.rejects(validateMixRegistration(zeroHash, signed.raw, identity));
  }
  for (const change of [{ chainId: 56 }, { to: zeroAddress }, { gas: 0n }, { value: 1n }, { data: '0x' as const },
    { data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'registerStrategy', args: ['user name', 'My mix', false] }) },
    { data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'registerStrategy', args: ['CRE8 mix', 'My mix', true] }) }]) {
    const signed = await signedMixRegistration(change);
    await assert.rejects(validateMixRegistration(signed.hash, signed.raw, identity), e => e instanceof Error && !e.message.includes(signed.raw));
  }
  for (const raw of ['0x', '0x00', '0x123'] as const) await assert.rejects(validateMixRegistration(zeroHash, raw, identity));
});
test('creation key boundaries and original JSON commitment preserve omitted/null, values and array order', () => {
  for (const key of ['a', 'a'.repeat(128), '123_ABC-def']) assert.equal(mixRequestKey(key), key);
  for (const key of [null, undefined, '', ' ', 'a'.repeat(129), ['a'], 'a.b']) assert.throws(() => mixRequestKey(key));
  assert.equal(mixRequestHash({ a: { c: 1, b: 2 } }), mixRequestHash({ a: { b: 2, c: 1 } }));
  assert.notEqual(mixRequestHash({}), mixRequestHash({ exit: null }));
  assert.notEqual(mixRequestHash([1, 2]), mixRequestHash([2, 1]));
  for (const value of [undefined, NaN, Infinity, 1n, { a: undefined }]) assert.throws(() => mixRequestHash(value));
});
