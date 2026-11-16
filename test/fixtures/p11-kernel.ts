/** Shared P11 setup for opt-in chain-97 fixtures: real owner sudo through the selected local alto. */
import assert from 'node:assert/strict';
import { createKernelAccount, createKernelAccountClient } from '@zerodev/sdk';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { KERNEL_V3_3 } from '@zerodev/sdk/constants';
import { createTestClient, createWalletClient, encodeFunctionData, http, parseAbi } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { toPackedUserOperation } from 'viem/account-abstraction';
import type { PaymasterActions } from 'viem/account-abstraction';
import type { HDAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';
import { REGISTRY_ABI, REGISTRY_VERSION_ABI } from '../../src/registry-abi.js';
import { estimationPaymaster, schedulerPaymaster, createPaymasterService } from '../../src/paymaster.js';
import { signPreparedOperation } from '../../src/user-operation.js';
import { TESTNET_97 as T } from '../../src/testnet-profile.js';

export async function ownerEnroll(client: PublicClient, owner: HDAccount, account: Address, id: bigint, rpc: string, bundler: string) {
  for (const endpoint of [rpc, bundler]) {
    const url = new URL(endpoint);
    assert.ok(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && !url.username && !url.password);
  }
  assert.equal(await client.getChainId(), 97);
  const local = createTestClient({ mode: 'anvil', chain: bscTestnet, transport: http(rpc) });
  const entryPoint = { address: T.contracts.entryPoint, version: '0.7' } as const;
  const sudo = await signerToEcdsaValidator(client, { signer: owner, entryPoint, kernelVersion: KERNEL_V3_3, validatorAddress: T.contracts.ecdsaValidatorV31 });
  const kernel = await createKernelAccount(client, { address: account, plugins: { sudo }, entryPoint, kernelVersion: KERNEL_V3_3 });
  await refreshP11Markets(client, rpc, [T.assets.WBNB.token]);
  const time = Number((await client.getBlock()).timestamp);
  const paymaster = ownerSetupPaymaster(account, owner.address, () => time);
  const ownerClient = createKernelAccountClient({ account: kernel, client, paymaster, chain: bscTestnet, bundlerTransport: http(bundler, { timeout: 120000, retryCount: 0 }),
    userOperation: { estimateFeesPerGas: async () => { const price = await client.getGasPrice(); return { maxFeePerGas: price, maxPriorityFeePerGas: price }; } } });
  const version = await client.readContract({ address: T.contracts.registry, abi: REGISTRY_VERSION_ABI, functionName: 'activeVersion', args: [id] });
  assert.ok(version > 0, 'wait for the real notice period before enrolling');
  assert.equal(await client.getBalance({ address: account }), 0n, 'owner enrollment uses the real paymaster with zero Kernel BNB');
  const calls = [{ to: T.contracts.registry, data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'enroll', args: [account, id, version] }) }];
  const accountCode = await client.getCode({ address: account });
  assert.ok(accountCode && accountCode !== '0x', 'owner setup requires prior operator deployment');
  const nonce = await kernel.getNonce();
  const estimate = await ownerClient.estimateUserOperationGas({ calls, nonce, paymaster: estimationPaymaster(paymaster) });
  const prepared = await ownerClient.prepareUserOperation({ calls, nonce, callGasLimit: estimate.callGasLimit * 3n / 2n,
    verificationGasLimit: estimate.verificationGasLimit, preVerificationGas: estimate.preVerificationGas });
  assert.equal(prepared.factory, undefined); assert.equal(prepared.factoryData, undefined);
  const hash = await ownerClient.sendUserOperation(await signPreparedOperation(prepared, op => kernel.signUserOperation(op)));
  const receipt = await ownerClient.waitForUserOperationReceipt({ hash, timeout: 120000 });
  assert.equal(receipt.success, true);
  assert.equal(await client.getBalance({ address: account }), 0n);
  const enrollment = await client.readContract({ address: T.contracts.registry, abi: REGISTRY_ABI, functionName: 'enrollments', args: [account] });
  assert.deepEqual(enrollment, [id, version, false]);
  return receipt;
}

/** Advancing the notice period also ages pools/feeds. Use real keeper swaps, never replace oracle state. */
export async function refreshP11Markets(client: PublicClient, rpc: string, selected: readonly Address[] = Object.values(T.assets).map(a => a.token)) {
  const url = new URL(rpc); assert.ok(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port);
  const local = createTestClient({ mode: 'anvil', chain: bscTestnet, transport: http(rpc) });
  assert.equal(await client.getChainId(), 97); await local.getAutomine();
  await local.impersonateAccount({ address: T.roles.keeper });
  await local.setBalance({ address: T.roles.keeper, value: 100n * 10n ** 18n });
  const keeper = createWalletClient({ chain: bscTestnet, account: T.roles.keeper, transport: http(rpc, { timeout: 120000, retryCount: 0 }) });
  const abi = parseAbi(['function approve(address,uint256) returns(bool)', 'function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)',
    'function push(int256)', 'function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint32,bool)',
    'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns(uint256)']);
  const landed = async (hash: Hex) => { await local.mine({ blocks: 1 }); assert.equal((await client.waitForTransactionReceipt({ hash })).status, 'success'); };
  for (const address of [T.contracts['feed.USDT/USD'], ...Object.values(T.assets).flatMap(a => 'feed' in a ? [a.feed] : [])]) {
    const round = await client.readContract({ address, abi, functionName: 'latestRoundData' });
    await landed(await keeper.writeContract({ address, abi, functionName: 'push', args: [round[1]] }));
  }
  const router: Address = '0x1b81D678ffb9C0263b24A97847620C99d213eB14';
  await landed(await keeper.writeContract({ address: T.contracts.usdt, abi, functionName: 'approve', args: [router, (1n << 256n) - 1n] }));
  for (const asset of Object.values(T.assets).filter(a => selected.some(address => address.toLowerCase() === a.token))) {
    const before = await client.readContract({ address: asset.pool, abi, functionName: 'slot0' });
    await landed(await keeper.writeContract({ address: router, abi, functionName: 'exactInputSingle', args: [{ tokenIn: T.contracts.usdt, tokenOut: asset.token,
      fee: asset.poolFee, recipient: T.roles.keeper, deadline: (await client.getBlock()).timestamp + 600n, amountIn: 1000n * 10n ** 18n, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n }] }));
    const after = await client.readContract({ address: asset.pool, abi, functionName: 'slot0' });
    assert.notEqual(after[1], before[1], 'keeper refresh must create a real tick-moving observation');
  }
}

/** Browser-equivalent authenticated sponsor path, including setup before portfolio confirmation. */
export function ownerSetupPaymaster(account: Address, owner: Address, now: () => number): PaymasterActions {
  const stub = schedulerPaymaster(account, { now }); assert.ok(stub);
  return { ...stub, getPaymasterData: async args => {
    assert.ok(args.callGasLimit !== undefined && args.verificationGasLimit !== undefined && args.preVerificationGas !== undefined && args.maxFeePerGas !== undefined && args.maxPriorityFeePerGas !== undefined);
    const packed = toPackedUserOperation({ sender: args.sender, nonce: args.nonce, callData: args.callData,
      callGasLimit: args.callGasLimit, verificationGasLimit: args.verificationGasLimit, preVerificationGas: args.preVerificationGas,
      maxFeePerGas: args.maxFeePerGas, maxPriorityFeePerGas: args.maxPriorityFeePerGas,
      factory: args.factory, factoryData: args.factoryData, signature: '0x' });
    const authorization = await createPaymasterService({ now }).sponsor({ userOperation: packed }, owner);
    return { paymaster: authorization.paymaster, paymasterData: authorization.paymasterData,
      paymasterVerificationGasLimit: authorization.paymasterVerificationGasLimit, paymasterPostOpGasLimit: authorization.paymasterPostOpGasLimit };
  } };
}
