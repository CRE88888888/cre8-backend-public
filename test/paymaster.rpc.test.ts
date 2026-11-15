import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { concatHex, createPublicClient, custom, defineChain, encodeAbiParameters, encodeFunctionData, parseAbi, toFunctionSelector, toHex } from 'viem';
import { createBundlerClient, entryPoint07Abi, toSmartAccount } from 'viem/account-abstraction';
import type { Hex } from 'viem';
import { AppError } from '../src/errors.js';
import { KERNEL_V3_3_ADDRESSES as K } from '../src/addresses.js';
import { createPaymasterService, estimationPaymaster, paymasterExecutionError, schedulerPaymaster, parsePackedSponsorOperation } from '../src/paymaster.js';
import { config, operation, OWNER, SENDER, REGISTRY, PM, NOW } from './fixtures/paymaster.js';

const factoryAbi = parseAbi(['function deployWithFactory(address factory,bytes createData,bytes32 salt) returns(address)']);
const initCode = concatHex([K.kernelMetaFactory, encodeFunctionData({ abi: factoryAbi, functionName: 'deployWithFactory', args: [K.kernelFactoryV33, '0x1234', toHex(0n, { size: 32 })] })]);

test('#66 RPC guards chain, signer, EntryPoint, deposit, deployed implementation, initCode factory and derived sender', async () => {
  let mode = 'healthy';
  let reserved = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const rpc: { id: number; method: string; params: unknown[] } = JSON.parse(body);
    let result: Hex = '0x';
    if (rpc.method === 'eth_chainId') result = toHex(mode === 'chain' ? 56 : 1337);
    if (rpc.method === 'eth_getCode') result = mode.startsWith('init') ? '0x' : '0x01';
    if (rpc.method === 'eth_getStorageAt') result = encodeAbiParameters([{ type: 'address' }], [mode === 'implementation' ? REGISTRY : K.kernelImplV33]);
    if (rpc.method === 'eth_call') {
      const call = rpc.params[0];
      assert.ok(typeof call === 'object' && call !== null && 'data' in call && typeof call.data === 'string');
      const selector = call.data.slice(0, 10);
      if (selector === toFunctionSelector('verifyingSigner()')) result = encodeAbiParameters([{ type: 'address' }], [mode === 'signer' ? REGISTRY : OWNER as Hex]);
      else if (selector === toFunctionSelector('entryPoint()')) result = encodeAbiParameters([{ type: 'address' }], [mode === 'entrypoint' ? REGISTRY : K.entryPointV07]);
      else if (selector === toFunctionSelector('balanceOf(address)')) result = toHex(mode === 'deposit' ? 899_999n : 900_000n, { size: 32 });
      else if (selector === toFunctionSelector(factoryAbi[0])) result = encodeAbiParameters([{ type: 'address' }], [mode === 'init-sender' ? REGISTRY : SENDER]);
      else assert.fail('unexpected eth_call');
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const service = createPaymasterService({ readBudgetContext: async () => ({ purpose: 'ordinary', nativePrice: 60000000000n, priceSource: 'fixture:oracle' }), config: { ...config(), rpcUrl: `http://127.0.0.1:${address.port}` }, now: () => NOW,
    query: async () => ({ rows: [{ owner: OWNER, user_id: OWNER }] }), reserve: async () => { reserved++; } });
  try {
    await service.sponsor({ userOperation: operation() }, OWNER);
    assert.equal(reserved, 1);
    for (const bad of ['chain', 'signer', 'entrypoint', 'implementation', 'deposit']) {
      mode = bad;
      await assert.rejects(service.sponsor({ userOperation: operation() }, OWNER), (error: unknown) => error instanceof AppError);
    }
    assert.equal(reserved, 1);
    mode = 'init';
    await service.sponsor({ userOperation: operation({ initCode }) }, OWNER);
    assert.equal(reserved, 2);
    for (const code of [concatHex([REGISTRY, initCode.slice(42) as Hex]), concatHex([K.kernelMetaFactory, encodeFunctionData({ abi: factoryAbi, functionName: 'deployWithFactory', args: [REGISTRY, '0x1234', toHex(0n, { size: 32 })] })]), '0x1234'] satisfies Hex[]) {
      await assert.rejects(service.sponsor({ userOperation: operation({ initCode: code }) }, OWNER), (error: unknown) => error instanceof AppError);
    }
    mode = 'init-sender';
    await assert.rejects(service.sponsor({ userOperation: operation({ initCode }) }, OWNER), (error: unknown) => error instanceof AppError && error.code === 'PAYMASTER_FACTORY_SENDER_MISMATCH');
    mode = 'healthy';
    await assert.rejects(service.sponsor({ userOperation: operation({ initCode }) }, OWNER), (error: unknown) => error instanceof AppError && error.code === 'PAYMASTER_ACCOUNT_ALREADY_DEPLOYED');
    assert.equal(reserved, 2);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('#66 strict uint256/bytes parsing refuses missing, negative, overflow, numeric JSON, extensions and foreign paymaster', async () => {
  for (const change of [{ nonce: -1n }, { nonce: 1 }, { nonce: 1n << 256n }, { preVerificationGas: null }, { accountGasLimits: '0x12' }, { initCode: '0x1' }, { sender: PM + '00' }, { unrecognized: true }]) {
    assert.throws(() => parsePackedSponsorOperation({ ...operation(), ...change }), (error: unknown) => error instanceof AppError && error.code === 'PAYMASTER_INVALID_OPERATION');
  }
  let reserved = false;
  const service = createPaymasterService({ readBudgetContext: async () => ({ purpose: 'ordinary', nativePrice: 60000000000n, priceSource: 'fixture:oracle' }), config: config(), now: () => NOW, query: async () => ({ rows: [{ owner: OWNER, user_id: OWNER }] }),
    checkChain: async () => {}, reserve: async () => { reserved = true; } });
  await assert.rejects(service.sponsor({ userOperation: operation({ paymasterAndData: initCode }) }, OWNER), (error: unknown) => error instanceof AppError);
  assert.equal(reserved, false);
});

test('#66 scheduler stub cannot authorize, final hook reserves exact gas through same service; missing fields/domain blocked', async () => {
  let reserved = 0;
  const hooks = schedulerPaymaster(SENDER, { readBudgetContext: async () => ({ purpose: 'ordinary', nativePrice: 60000000000n, priceSource: 'fixture:oracle' }), config: config(), now: () => NOW, checkChain: async () => {},
    query: async () => ({ rows: [{ owner: OWNER, user_id: OWNER }] }), reserve: async (r) => { assert.equal(r.gasLimit, 450_000n); reserved++; } });
  assert.ok(hooks);
  const args = { sender: SENDER, chainId: 1337, entryPointAddress: K.entryPointV07, nonce: 0n, callData: operation().callData } as const;
  const stub = await hooks.getPaymasterStubData(args);
  assert.equal(stub.paymaster, PM);
  assert.equal(reserved, 0);
  await assert.rejects(hooks.getPaymasterData(args), (error: unknown) => error instanceof AppError);
  const complete = { ...args, callGasLimit: 200_000n, verificationGasLimit: 100_000n, preVerificationGas: 50_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };
  await hooks.getPaymasterData(complete);
  assert.equal(reserved, 1);
  for (const change of [{ sender: REGISTRY }, { chainId: 56 }, { entryPointAddress: REGISTRY }] as const) {
    await assert.rejects(hooks.getPaymasterData({ ...complete, ...change }), (error: unknown) => error instanceof AppError);
  }
  assert.equal(reserved, 1);
  assert.equal(schedulerPaymaster(SENDER, { readBudgetContext: async () => ({ purpose: 'ordinary', nativePrice: 60000000000n, priceSource: 'fixture:oracle' }), config: null }), undefined);
});

test('#66 viem estimation must use only a paymaster stub, with no premature quota reservation', async () => {
  const chain = defineChain({ id: 1337, name: 'local fixture', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1:8557'] } } });
  const transport = custom({ request: async ({ method }) => {
    if (method === 'eth_getCode') return '0x01';
    if (method === 'eth_estimateUserOperationGas') return { callGasLimit: '0x30d40', verificationGasLimit: '0x186a0', preVerificationGas: '0xc350', paymasterVerificationGasLimit: '0x186a0', paymasterPostOpGasLimit: '0x0' };
    throw new Error('unexpected fixture RPC: ' + method);
  } });
  const client = createPublicClient({ chain, transport });
  const account = await toSmartAccount({ client, entryPoint: { abi: entryPoint07Abi, address: K.entryPointV07, version: '0.7' },
    getAddress: async () => SENDER, encodeCalls: async () => operation().callData, getFactoryArgs: async () => ({}),
    getNonce: async () => 0n, getStubSignature: async () => '0x', signMessage: async () => '0x', signTypedData: async () => '0x', signUserOperation: async () => '0x' });
  let reservations = 0;
  const hooks = schedulerPaymaster(SENDER, { readBudgetContext: async () => ({ purpose: 'ordinary', nativePrice: 60000000000n, priceSource: 'fixture:oracle' }), config: config(), now: () => NOW,
    query: async () => ({ rows: [{ owner: OWNER, user_id: OWNER }] }), checkChain: async () => {}, reserve: async () => { reservations++; } });
  assert.ok(hooks);
  const bundler = createBundlerClient({ account, chain, transport, paymaster: hooks });
  const gas = await bundler.estimateUserOperationGas({ callData: operation().callData, nonce: 0n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, paymaster: estimationPaymaster(hooks) });
  assert.equal(gas.callGasLimit, 200_000n);
  assert.equal(reservations, 0);
  const prepared = await bundler.prepareUserOperation({ callData: operation().callData, nonce: 0n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
  assert.equal(prepared.paymaster, PM);
  assert.equal(reservations, 1);
  assert.doesNotMatch(paymasterExecutionError(new Error('secret RPC payload UserOperation')).message, /secret RPC|UserOperation/);
});
