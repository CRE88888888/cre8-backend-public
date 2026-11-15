import assert from 'node:assert/strict';
import { test } from 'node:test';
import { concatHex, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, recoverMessageAddress, toHex, zeroAddress } from 'viem';
import type { Hex } from 'viem';
import { loadPaymasterConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { createPaymasterService, KERNEL_EXECUTE_ABI, verifyingPaymasterHash, validateSponsoredCalls } from '../src/paymaster.js';
import type { PackedSponsorOperation, Reservation } from '../src/paymaster.js';
import { EXECUTOR_ABI } from '../src/chain.js';
import golden from './fixtures/paymaster-golden.json' with { type: 'json' };
import { assertNoSecretSlices } from './fixtures/secret-output.js';

import { TEST_SIGNER, PM, EXECUTOR, REGISTRY, USDT, SENDER, OWNER, ENV, NOW, CLAIM_ABI, claim, kernelCall, operation, config } from './fixtures/paymaster.js';

function errorCode(code: string) { return (error: unknown) => error instanceof AppError && error.code === code; }

test('#66 config disabled without signer; decimal quotas, zero and malformed config fail closed without echo', () => {
  assert.equal(loadPaymasterConfig({ PAYMASTER_ADDRESS: 'secret' }), null);
  assert.equal(config({ ...ENV, PAYMASTER_ACCOUNT_DAILY_COUNT: '0' }).accountDailyCount, 0n);
  assert.equal(config({ ...ENV, PAYMASTER_ACCOUNT_DAILY_WEI: '9007199254740993' }).accountDailyWei, 9007199254740993n);
  for (const name of ['PAYMASTER_SIGNER_PRIVATE_KEY', 'PAYMASTER_ADDRESS', 'PAYMASTER_ACCOUNT_DAILY_GAS', 'PAYMASTER_SITE_DAILY_WEI']) {
    assert.throws(() => loadPaymasterConfig({ ...ENV, [name]: 'secret-value' }), (error: unknown) => error instanceof Error && error.message.includes(name) && !error.message.includes('secret-value'));
  }
});

test('#66 whitelist decodes every Kernel batch item, rejects value, delegatecall, mode extensions, unknown/truncated/trailing calls', () => {
  const c = config();
  validateSponsoredCalls(operation(), c);
  const tuple: { target: Hex; value: bigint; callData: Hex }[] = [{ target: USDT, value: 0n, callData: claim }, { target: USDT, value: 0n, callData: claim }];
  const batchAbi = [{ type: 'tuple[]', components: [{ type: 'address', name: 'target' }, { type: 'uint256', name: 'value' }, { type: 'bytes', name: 'callData' }] }] as const;
  const batch = (items: typeof tuple) => encodeFunctionData({ abi: KERNEL_EXECUTE_ABI, functionName: 'execute', args: [toHex(1n << 248n, { size: 32 }), encodeAbiParameters(batchAbi, [items])] });
  validateSponsoredCalls(operation({ callData: batch(tuple) }), c);
  for (const callData of [kernelCall(claim, zeroAddress), kernelCall(claim, USDT, 1n), kernelCall(claim, USDT, 0n, toHex(255n << 248n, { size: 32 })),
    kernelCall(claim, USDT, 0n, toHex(1n, { size: 32 })), kernelCall('0xdeadbeef'), kernelCall(claim.slice(0, 10) as Hex),
    kernelCall(concatHex([claim, '0x00'])), concatHex([kernelCall(), '0x00']), batch([]), batch([...tuple, { target: zeroAddress, value: 0n, callData: claim }])]) {
    assert.throws(() => validateSponsoredCalls(operation({ callData }), c), errorCode('PAYMASTER_CALL_FORBIDDEN'));
  }
});

test('#66 executor account and registry enrollment account must equal sender; faucet only claim, not mint/claimFor', () => {
  const rebalance = (account: Hex) => encodeFunctionData({ abi: EXECUTOR_ABI, functionName: 'executeRebalance', args: [account, [{ tokenIn: USDT, tokenOut: REGISTRY, amountIn: 1n, amountOutMin: 1n, venue: REGISTRY, data: '0x' }], 2_000_000_000n] });
  validateSponsoredCalls(operation({ callData: kernelCall(rebalance(SENDER), EXECUTOR) }), config());
  const enrollAbi = parseAbi(['function enroll(address account,uint256 id)']);
  validateSponsoredCalls(operation({ callData: kernelCall(encodeFunctionData({ abi: enrollAbi, functionName: 'enroll', args: [SENDER, 1n] }), REGISTRY) }), config());
  for (const callData of [kernelCall(rebalance(REGISTRY), EXECUTOR), kernelCall(encodeFunctionData({ abi: enrollAbi, functionName: 'enroll', args: [REGISTRY, 1n] }), REGISTRY),
    kernelCall(encodeFunctionData({ abi: parseAbi(['function mint(address to,uint256 amount)']), functionName: 'mint', args: [SENDER, 1n] })),
    kernelCall(encodeFunctionData({ abi: CLAIM_ABI, functionName: 'claim', args: [0n] }))]) {
    assert.throws(() => validateSponsoredCalls(operation({ callData }), config()), errorCode('PAYMASTER_CALL_FORBIDDEN'));
  }
});

test('#66 service binds DB chain and owner, reserves before handing out signature; expiry includes exact boundary', async () => {
  let reserved = false;
  const reservations: Reservation[] = [];
  const service = createPaymasterService({ readBudgetContext: async () => ({ purpose: 'ordinary', nativePrice: 60000000000n, priceSource: 'fixture:oracle' }), config: config(), now: () => NOW,
    query: async (_sql, params) => { assert.deepEqual(params, [1337, SENDER]); return { rows: [{ owner: OWNER, user_id: OWNER }] }; },
    checkChain: async () => {}, reserve: async (request) => { reservations.push(request); reserved = true; } });
  const result = await service.sponsor({ userOperation: operation(), validUntil: NOW + 300 }, OWNER);
  assert.ok(reserved);
  assert.equal(reservations[0]?.gasLimit, 450_000n);
  assert.equal(reservations[0]?.maxCostWei, 900_000n);
  assert.equal(result.validUntil, NOW + 300);
  assert.equal(result.paymasterAndData.length, 2 + 181 * 2);
  const hash = verifyingPaymasterHash(operation({ paymasterAndData: result.paymasterAndData }), config(), NOW + 300, 0);
  assert.equal((await recoverMessageAddress({ message: { raw: hash }, signature: result.paymasterAndData.slice(-130).replace(/^/, '0x') as Hex })).toLowerCase(), OWNER);
  await assert.rejects(service.sponsor({ userOperation: operation(), validUntil: NOW }, OWNER), errorCode('PAYMASTER_EXPIRED'));
  await assert.rejects(service.sponsor({ userOperation: operation(), validUntil: NOW + 301 }, OWNER), errorCode('PAYMASTER_EXPIRED'));
  await assert.rejects(service.sponsor({ userOperation: operation() }, REGISTRY), errorCode('PAYMASTER_SENDER_FORBIDDEN'));
});

test('#66 disabled, unknown sender, DB/RPC failures and RPC timeout never reserve or return sensitive errors', async () => {
  await assert.rejects(createPaymasterService({ readBudgetContext: async () => ({ purpose: 'ordinary', nativePrice: 60000000000n, priceSource: 'fixture:oracle' }), config: null }).sponsor({}, OWNER), errorCode('PAYMASTER_DISABLED'));
  let reserved = 0;
  for (const phase of ['unknown', 'db', 'db-timeout', 'rpc', 'timeout', 'budget', 'budget-timeout', 'reserve']) {
    const service = createPaymasterService({ readBudgetContext: async () => {
      if (phase === 'budget') throw new Error('secret-oracle');
      if (phase === 'budget-timeout') return new Promise<never>(() => {});
      return { purpose: 'ordinary', nativePrice: 60000000000n, priceSource: 'fixture:oracle' };
    }, config: { ...config(), timeoutMs: 5 }, now: () => NOW,
      query: phase === 'db-timeout' ? () => new Promise<{ rows: unknown[] }>(() => {}) : async () => {
        if (phase === 'db') throw new Error('secret-connection');
        return { rows: phase === 'unknown' ? [] : [{ owner: OWNER, user_id: OWNER }] };
      },
      checkChain: phase === 'timeout' ? () => new Promise<void>(() => {}) : async () => { if (phase === 'rpc') throw new Error('secret-rpc'); },
      reserve: async () => { reserved++; throw new Error('secret-reservation'); } });
    await assert.rejects(service.sponsor({ userOperation: operation() }, OWNER), (error: unknown) => error instanceof AppError && !error.message.includes('secret-'));
  }
  assert.equal(reserved, 1);
});

test('#66 all signed request fields affect hash, signature itself does not; official v0.7 preimage layout', () => {
  const c = config();
  const header = concatHex([PM, toHex(c.verificationGasLimit, { size: 16 }), toHex(c.postOpGasLimit, { size: 16 })]);
  const op = operation({ paymasterAndData: header });
  const hash = verifyingPaymasterHash(op, c, NOW + 300, 0);
  const independent = keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint48' }, { type: 'uint48' }],
    [op.sender, op.nonce, keccak256(op.initCode), keccak256(op.callData), op.accountGasLimits, (c.verificationGasLimit << 128n) | c.postOpGasLimit, op.preVerificationGas, op.gasFees, 1337n, PM, NOW + 300, 0]));
  assert.equal(hash, independent);
  assert.equal(hash, golden.hash);
  for (const change of [{ sender: REGISTRY }, { nonce: 1n }, { initCode: '0x01' }, { callData: '0x01' }, { accountGasLimits: toHex(1n, { size: 32 }) }, { preVerificationGas: 1n }, { gasFees: toHex(1n, { size: 32 }) }, { paymasterAndData: concatHex([PM, toHex(1n, { size: 32 })]) }] satisfies Partial<PackedSponsorOperation>[]) {
    assert.notEqual(verifyingPaymasterHash({ ...op, ...change }, c, NOW + 300, 0), hash);
  }
  assert.equal(verifyingPaymasterHash({ ...op, signature: '0x1234' }, c, NOW + 300, 0), hash);
});

test('#66 expiry while committing keeps the charge but never hands out authorization; errors/logs contain no secrets or UserOp bytes', async () => {
  let clock = NOW;
  let charged = false;
  const logs: string[] = [];
  const original = console.warn;
  console.warn = (...values: unknown[]) => { logs.push(values.map(String).join(' ')); };
  try {
    const service = createPaymasterService({ readBudgetContext: async () => ({ purpose: 'ordinary', nativePrice: 60000000000n, priceSource: 'fixture:oracle' }), config: config(), now: () => clock,
      query: async () => ({ rows: [{ owner: OWNER, user_id: OWNER }] }), checkChain: async () => {},
      reserve: async () => { charged = true; clock += 300; } });
    await assert.rejects(service.sponsor({ userOperation: operation(), validUntil: NOW + 300 }, OWNER), errorCode('PAYMASTER_EXPIRED'));
    assert.equal(charged, true);
    const failing = createPaymasterService({ readBudgetContext: async () => ({ purpose: 'ordinary', nativePrice: 60000000000n, priceSource: 'fixture:oracle' }), config: config(), now: () => NOW,
      query: async () => { throw new Error('private RPC token ' + TEST_SIGNER + operation().callData); } });
    await assert.rejects(failing.sponsor({ userOperation: operation() }, OWNER), errorCode('PAYMASTER_DEPENDENCY_UNAVAILABLE'));
    const output = logs.join('\n');
    assertNoSecretSlices(output, TEST_SIGNER);
    assertNoSecretSlices(output, operation().callData);
    assertNoSecretSlices(output, golden.signature);
    assert.doesNotMatch(output, /private RPC token|DATABASE_URL|userOperation|nonce|callData/);
  } finally { console.warn = original; }
});

test('#69 estimation paymaster signature is recoverable for every hash, so v0.7 reports SIG_VALIDATION_FAILED instead of reverting', async () => {
  const { schedulerPaymaster } = await import('../src/paymaster.js');
  const { slice } = await import('viem');
  const hooks = schedulerPaymaster(SENDER, { readBudgetContext: async () => ({ purpose: 'ordinary', nativePrice: 60000000000n, priceSource: 'fixture:oracle' }), config: config() });
  assert.ok(hooks?.getPaymasterStubData);
  const stub = await hooks.getPaymasterStubData({ chainId: 1337, entryPointAddress: '0x0000000071727De22E5E9d8BAf0edAc6f37da032', sender: SENDER, nonce: 0n, callData: '0x' });
  assert.ok(stub?.paymasterData);
  for (const value of [0n, 1n, (1n << 256n) - 1n]) {
    const recovered = await recoverMessageAddress({ message: { raw: toHex(value, { size: 32 }) }, signature: slice(stub.paymasterData, 64) });
    assert.match(recovered, /^0x[0-9a-fA-F]{40}$/);
    if (value !== 0n) assert.notEqual(recovered.toLowerCase(), OWNER);
  }
});
