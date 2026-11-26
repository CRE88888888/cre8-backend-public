import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recoverMessageAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getUserOperationHash } from 'viem/account-abstraction';
import type { UserOperation } from 'viem/account-abstraction';
import { signPreparedOperation } from '../src/user-operation.js';

// Public anvil test key, never an operational key.
const signer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const entryPoint = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';

test('#79 prepared estimation signature is replaced by a verifiable signature over final gas and paymaster bytes', async () => {
  for (const nonce of [0n, (1n << 256n) - 1n]) {
    const operation: UserOperation<'0.7'> = { sender: signer.address, nonce, callData: '0x1234', callGasLimit: 600000n,
      verificationGasLimit: 100000n, preVerificationGas: 50000n, maxFeePerGas: 100000000n, maxPriorityFeePerGas: 100000000n,
      paymaster: '0x1111111111111111111111111111111111111111', paymasterData: '0x123456', paymasterVerificationGasLimit: 100000n,
      paymasterPostOpGasLimit: 0n, signature: '0xdeadbeef' };
    const hash = getUserOperationHash({ userOperation: operation, entryPointAddress: entryPoint, entryPointVersion: '0.7', chainId: 97 });
    const signed = await signPreparedOperation(operation, (final) => signer.signMessage({ message: { raw: getUserOperationHash({ userOperation: final, entryPointAddress: entryPoint, entryPointVersion: '0.7', chainId: 97 }) } }));
    assert.equal(await recoverMessageAddress({ message: { raw: hash }, signature: signed.signature }), signer.address);
    assert.deepEqual({ ...signed, signature: operation.signature }, operation);
    assert.equal(operation.signature, '0xdeadbeef');
  }
});

test('#79 signing failure propagates before a prepared operation can be sent', async () => {
  const operation: UserOperation<'0.7'> = { sender: signer.address, nonce: 0n, callData: '0x', callGasLimit: 0n,
    verificationGasLimit: 0n, preVerificationGas: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, signature: '0x' };
  await assert.rejects(signPreparedOperation(operation, async () => { throw new Error('signer unavailable'); }), /signer unavailable/);
  assert.equal(operation.signature, '0x');
});
