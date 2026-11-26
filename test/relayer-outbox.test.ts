import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak256, zeroAddress } from 'viem';
import { validateRelayerTransaction } from '../src/relayer-outbox.js';
import { signedFundingTx } from './fixtures/relayer.js';
import { WELCOME_AMOUNT_WEI } from '../src/config.js';
import { TEST_ACCOUNT } from './fixtures/strategy-rpc.js';

test('#97 signed outbox validates hash, signature, chain, exact calldata, zero value and amount before storage/replay', async () => {
  for (const kind of ['welcome', 'faucet'] as const) {
    const amountWei = kind === 'welcome' ? WELCOME_AMOUNT_WEI : 1000n * 10n ** 18n;
    const source = { kind, id: '1', chainId: 97, account: TEST_ACCOUNT, amountWei };
    const signed = await signedFundingTx(kind, source.account, amountWei);
    await validateRelayerTransaction(source, signed.hash, signed.raw, signed.operator);
    await assert.rejects(validateRelayerTransaction(source, signed.hash, signed.raw), 'test signer must fail the production profile');
    for (const change of [{ chainId: 56 }, { id: '0' }, { account: zeroAddress }, { amountWei: 0n }, { amountWei: amountWei + 1n }]) {
      await assert.rejects(validateRelayerTransaction({ ...source, ...change }, signed.hash, signed.raw, signed.operator));
    }
    for (const overrides of [{ chainId: 56 }, { to: zeroAddress }, { value: 1n }, { data: '0x' as const }, { gas: 0n }]) {
      const invalid = await signedFundingTx(kind, source.account, amountWei, overrides);
      await assert.rejects(validateRelayerTransaction(source, invalid.hash, invalid.raw, invalid.operator));
    }
    for (const raw of ['0x', '0x00', signed.raw.slice(0, -2)] as const) {
      // Keep the hash consistent: malformed decoding/signature must also fail.
      if (raw.startsWith('0x')) await assert.rejects(validateRelayerTransaction(source, keccak256(`0x${raw.slice(2)}`), `0x${raw.slice(2)}`, signed.operator));
    }
    await assert.rejects(validateRelayerTransaction(source, `0x${'00'.repeat(32)}`, signed.raw, signed.operator));
    const legacy = await signedFundingTx(kind, source.account, amountWei, { type: 'legacy', gasPrice: 1n });
    await validateRelayerTransaction(source, legacy.hash, legacy.raw, legacy.operator);
    const zeroNonce = await signedFundingTx(kind, source.account, amountWei, { nonce: 0 });
    await validateRelayerTransaction(source, zeroNonce.hash, zeroNonce.raw, zeroNonce.operator);
  }
});
