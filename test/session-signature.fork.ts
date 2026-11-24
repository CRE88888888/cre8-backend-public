/**
 * Real Kernel v3.3 on an anvil fork of chain 97 (no bundler, no DB): a session key must not be able to make the account's
 * ERC-1271 `isValidSignature` pass; the owner must. Run:
 *   anvil --fork-url https://data-seed-prebsc-1-s1.bnbchain.org:8545 --port 8571
 *   ANVIL_RPC_URL=http://127.0.0.1:8571 bun test test/session-signature.fork.ts --timeout=120000
 * The control (the permission flag used before 2026-11-24) proves the test can see the hole: there the session key passes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicClient, createTestClient, createWalletClient, hashMessage, http, parseEther, toFunctionSelector } from 'viem';
import { getUserOperationHash, toPackedUserOperation } from 'viem/account-abstraction';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';
import { createKernelAccount } from '@zerodev/sdk';
import { KERNEL_V3_3 } from '@zerodev/sdk/constants';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { toPermissionValidator } from '@zerodev/permissions';
import { toECDSASigner } from '@zerodev/permissions/signers';
import { toCallPolicy, toGasPolicy, toTimestampPolicy, CallPolicyVersion } from '@zerodev/permissions/policies';
import { getAddress } from 'viem';
import { SESSION_GAS_ALLOWED_WEI, SESSION_PERMISSION_FLAG, SESSION_PERMISSION_FLAG_LEGACY, sessionCallPermissions } from '../src/permissions.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';

const rpc = process.env.ANVIL_RPC_URL;
const ERC1271 = [{ type: 'function', name: 'isValidSignature', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'bytes' }], outputs: [{ type: 'bytes4' }] }] as const;
const VALIDATE = [{ type: 'function', name: 'validateUserOp', stateMutability: 'payable', inputs: [{ type: 'tuple', components: [{ name: 'sender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'initCode', type: 'bytes' },
  { name: 'callData', type: 'bytes' }, { name: 'accountGasLimits', type: 'bytes32' }, { name: 'preVerificationGas', type: 'uint256' }, { name: 'gasFees', type: 'bytes32' }, { name: 'paymasterAndData', type: 'bytes' }, { name: 'signature', type: 'bytes' }] },
  { type: 'bytes32' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }] }] as const;
const entryPoint = { address: T.contracts.entryPoint as Hex, version: '0.7' as const };

test('real Kernel: the session key cannot pass ERC-1271 with the new permission flag (it could with the old one); the owner still can', { skip: !rpc }, async () => {
  const transport = http(rpc!, { timeout: 120_000 });
  const client = createPublicClient({ chain: bscTestnet, transport });
  const anvil = createTestClient({ chain: bscTestnet, mode: 'anvil', transport });
  const funder = privateKeyToAccount(generatePrivateKey());
  await anvil.setBalance({ address: funder.address, value: parseEther('1') });
  const wallet = createWalletClient({ account: funder, chain: bscTestnet, transport });
  const message = '2026-11-24T12:00:00.000Z\nThank you for your support of listaDAO.', hash = hashMessage(message);
  const valid = async (account: Hex, signature: Hex) => {
    try { return await client.readContract({ address: account, abi: ERC1271, functionName: 'isValidSignature', args: [hash, signature] }) === '0x1626ba7e'; } catch { return false; }
  };
  for (const [name, flag, sessionCanSign] of [['old flag (control)', SESSION_PERMISSION_FLAG_LEGACY, true], ['new flag', SESSION_PERMISSION_FLAG, false]] as const) {
    const owner = privateKeyToAccount(generatePrivateKey()), sessionKey = privateKeyToAccount(generatePrivateKey());
    const sudo = await signerToEcdsaValidator(client, { signer: owner, entryPoint, kernelVersion: KERNEL_V3_3 });
    // The same three policies and contracts the backend installs on chain 97 (plain scope).
    const permission = await toPermissionValidator(client, { entryPoint, kernelVersion: KERNEL_V3_3, flag,
      signer: await toECDSASigner({ signer: sessionKey, signerContractAddress: getAddress(T.contracts.ecdsaSigner) }),
      policies: [toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, policyAddress: T.contracts.callPolicy as Hex, permissions: sessionCallPermissions(T.contracts.executor as Hex) }),
        toGasPolicy({ policyAddress: T.contracts.gasPolicy as Hex, allowed: SESSION_GAS_ALLOWED_WEI, enforcePaymaster: true, allowedPaymaster: T.contracts.paymaster as Hex }),
        toTimestampPolicy({ policyAddress: T.contracts.timestampPolicy as Hex, validAfter: 0, validUntil: 1_900_000_000 })] });
    const { toInitConfig } = await import('@zerodev/permissions');
    const initConfig = await toInitConfig(permission);
    const asOwner = await createKernelAccount(client, { plugins: { sudo }, entryPoint, kernelVersion: KERNEL_V3_3, initConfig });
    const { factory, factoryData } = await asOwner.getFactoryArgs();
    assert.ok(factory && factoryData);
    const deploy = await wallet.sendTransaction({ to: factory, data: factoryData });
    await client.waitForTransactionReceipt({ hash: deploy });
    assert.ok(((await client.getCode({ address: asOwner.address })) ?? '0x').length > 2, `${name}: account deployed with the session permission installed`);
    const asSession = await createKernelAccount(client, { address: asOwner.address, plugins: { sudo, regular: permission }, entryPoint, kernelVersion: KERNEL_V3_3 });
    assert.equal(await valid(asOwner.address, await asOwner.signMessage({ message })), true, `${name}: owner signature is valid`);
    assert.equal(await valid(asOwner.address, await asSession.signMessage({ message })), sessionCanSign, `${name}: session-key signature`);
    // The flag must not cost the key its real job: the same permission still validates a UserOp (EntryPoint -> validateUserOp).
    const callData = await asSession.encodeCalls([{ to: T.contracts.executor as Hex, value: 0n, data: (toFunctionSelector('executeRebalance(address,(address,address,uint256,uint256,address,bytes)[],uint256)') + '00'.repeat(32)) as Hex }]);
    const op = { sender: asOwner.address, nonce: await asSession.getNonce(), callData, callGasLimit: 500_000n, verificationGasLimit: 1_000_000n, preVerificationGas: 100_000n,
      maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, paymaster: T.contracts.paymaster as Hex, paymasterVerificationGasLimit: 100_000n, paymasterPostOpGasLimit: 50_000n, paymasterData: '0x' as Hex, signature: '0x' as Hex };
    const signature = await asSession.signUserOperation(op);
    const packed = toPackedUserOperation({ ...op, signature });
    const userOpHash = getUserOperationHash({ chainId: bscTestnet.id, entryPointAddress: entryPoint.address, entryPointVersion: '0.7', userOperation: { ...op, signature } });
    const validation = await client.readContract({ address: asOwner.address, abi: VALIDATE, functionName: 'validateUserOp', args: [packed, userOpHash, 0n], account: entryPoint.address });
    assert.equal(validation & ((1n << 160n) - 1n), 0n, `${name}: session-key UserOp passes validation (no signature failure)`);
  }
});
