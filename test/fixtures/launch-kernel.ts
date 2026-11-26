/** Local #168 owner-sudo fixture: real Kernel signature and EntryPoint, no bundler/paymaster. */
import assert from 'node:assert/strict';
import { createKernelAccount } from '@zerodev/sdk';
import { KERNEL_V3_3 } from '@zerodev/sdk/constants';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { createTestClient, createWalletClient, decodeEventLog, http } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import type { HDAccount } from 'viem/accounts';
import { entryPoint07Abi, toPackedUserOperation } from 'viem/account-abstraction';
import { bscTestnet } from 'viem/chains';
import { TESTNET_97 as T } from '../../src/testnet-profile.js';
import { MAX_USER_OP_GAS } from '../../src/execution-batch.js';

export async function launchKernel(client: PublicClient, rpc: string, owner: HDAccount, index: bigint) {
  assert.equal(rpc, 'http://127.0.0.1:8568');
  assert.equal(await client.getChainId(), 97);
  const local = createTestClient({ chain: bscTestnet, mode: 'anvil', transport: http(rpc) });
  assert.equal(await local.getAutomine(), true);
  const wallet = createWalletClient({ chain: bscTestnet, account: owner, transport: http(rpc) });
  const landed = async (hash: Hex) => {
    await local.mine({ blocks: 1 });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 30000 });
    assert.equal(receipt.status, 'success'); return receipt;
  };
  const entryPoint = { address: T.contracts.entryPoint, version: '0.7' } as const;
  const sudo = await signerToEcdsaValidator(client, { signer: owner, entryPoint, kernelVersion: KERNEL_V3_3, validatorAddress: T.contracts.ecdsaValidatorV31 });
  const account = await createKernelAccount(client, { plugins: { sudo }, entryPoint, kernelVersion: KERNEL_V3_3, index,
    factoryAddress: T.contracts.kernelFactoryV33, metaFactoryAddress: T.contracts.kernelMetaFactory, accountImplementationAddress: T.contracts.kernelImplV33 });
  const factory = await account.getFactoryArgs(); assert.ok(factory.factory && factory.factoryData);
  const existing = await client.getCode({ address: account.address });
  if (!existing || existing === '0x') await landed(await wallet.sendTransaction({ to: factory.factory, data: factory.factoryData }));
  const deployed = await client.getCode({ address: account.address });
  assert.ok(deployed && deployed !== '0x');
  // Native gas is local test money. No paymaster authorization or real deployment key is needed.
  await landed(await wallet.writeContract({ address: entryPoint.address, abi: entryPoint07Abi, functionName: 'depositTo', args: [account.address], value: 10n ** 18n }));
  return { address: account.address, send: async (calls: readonly { to: Address; data: Hex; value?: bigint }[]) => {
    const callData = await account.encodeCalls(calls);
    const callGas = await client.estimateGas({ account: entryPoint.address, to: account.address, data: callData });
    const gasPrice = await client.getGasPrice(); assert.ok(gasPrice > 0n);
    // Same validation/pre-verification fixture ceilings as the existing #71 opt-in test;
    // call gas and the outer handleOps transaction are estimated from the actual RPC.
    const operation = { sender: account.address, nonce: await account.getNonce(), callData,
      callGasLimit: callGas * 3n / 2n, verificationGasLimit: 1_500_000n, preVerificationGas: 100_000n,
      maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice, signature: '0x' as const };
    assert.ok(operation.callGasLimit + operation.verificationGasLimit + operation.preVerificationGas < MAX_USER_OP_GAS);
    const packed = toPackedUserOperation({ ...operation, signature: await account.signUserOperation(operation) });
    const args = [[packed], owner.address] as const;
    const gas = await client.estimateContractGas({ account: owner, address: entryPoint.address, abi: entryPoint07Abi, functionName: 'handleOps', args });
    const receipt = await landed(await wallet.writeContract({ address: entryPoint.address, abi: entryPoint07Abi, functionName: 'handleOps', args, gas: gas * 3n / 2n }));
    const events = receipt.logs.flatMap(log => {
      try {
        const event = decodeEventLog({ abi: entryPoint07Abi, ...log });
        return event.eventName === 'UserOperationEvent' ? [event.args] : [];
      } catch { return []; }
    });
    assert.equal(events.length, 1); assert.equal(events[0]?.sender.toLowerCase(), account.address.toLowerCase());
    assert.equal(events[0]?.success, true, 'a successful outer receipt alone does not prove the UserOp executed');
    return receipt;
  } };
}
