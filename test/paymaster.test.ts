import assert from 'node:assert/strict';
import { test } from 'node:test';
import { concatHex, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, recoverMessageAddress, toHex, zeroAddress } from 'viem';
import type { Hex } from 'viem';
import { loadPaymasterConfig, loadTradingConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { createPaymasterService, KERNEL_EXECUTE_ABI, verifyingPaymasterHash, validateSponsoredCalls } from '../src/paymaster.js';
import type { PackedSponsorOperation, Reservation } from '../src/paymaster.js';
import { EXECUTOR_ABI } from '../src/chain.js';
import golden from './fixtures/paymaster-golden.json' with { type: 'json' };
import { assertNoSecretSlices } from './fixtures/secret-output.js';

import { TEST_SIGNER, PM, EXECUTOR, REGISTRY, USDT, SENDER, OWNER, ENV, NOW, CLAIM_ABI, claim, kernelCall, operation, config } from './fixtures/paymaster.js';

function errorCode(code: string) { return (error: unknown) => error instanceof AppError && error.code === code; }

test('#89 only chain 97 defaults to a gas-only daily budget; other chain defaults are unchanged', () => {
  for (const chainId of [undefined, '56', '97', '1337', '31337']) {
    const policy = loadTradingConfig({ CHAIN_ID: chainId });
    assert.equal(policy.dailyGas, chainId === '97' ? 100_000_000n : 10_000_000n);
    assert.equal(policy.dailyUsdE8, chainId === '97' ? null : 30_000_000n);
  }
  assert.equal(loadTradingConfig({ CHAIN_ID: '97', ACCOUNT_DAILY_GAS_USD_E8: '  ' }).dailyUsdE8, null);
});

test('#89 daily caps can be overridden on 97 and 56; zero blocks and malformed values never echo input', () => {
  for (const chainId of ['97', '56']) {
    for (const cap of ['0', '1', '9007199254740993']) {
      const policy = loadTradingConfig({ CHAIN_ID: chainId, ACCOUNT_DAILY_GAS: cap, ACCOUNT_DAILY_GAS_USD_E8: cap });
      assert.equal(policy.dailyGas, BigInt(cap));
      assert.equal(policy.dailyUsdE8, BigInt(cap));
    }
    for (const name of ['ACCOUNT_DAILY_GAS', 'ACCOUNT_DAILY_GAS_USD_E8']) {
      for (const value of ['-1', '1.5', 'secret-setting']) {
        assert.throws(() => loadTradingConfig({ CHAIN_ID: chainId, [name]: value }),
          (error: unknown) => error instanceof Error && error.message.includes(name) && !error.message.includes(value));
      }
    }
  }
});

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
  const enroll = encodeFunctionData({ abi: parseAbi(['function enroll(address,uint256,uint16)']), functionName: 'enroll', args: [SENDER, 1n, 1] });
  const tuple: { target: Hex; value: bigint; callData: Hex }[] = [{ target: REGISTRY, value: 0n, callData: enroll }, { target: REGISTRY, value: 0n, callData: enroll }];
  const batchAbi = [{ type: 'tuple[]', components: [{ type: 'address', name: 'target' }, { type: 'uint256', name: 'value' }, { type: 'bytes', name: 'callData' }] }] as const;
  const batch = (items: typeof tuple) => encodeFunctionData({ abi: KERNEL_EXECUTE_ABI, functionName: 'execute', args: [toHex(1n << 248n, { size: 32 }), encodeAbiParameters(batchAbi, [items])] });
  validateSponsoredCalls(operation({ callData: batch(tuple) }), c);
  for (const callData of [kernelCall(claim, zeroAddress), kernelCall(claim, USDT, 1n), kernelCall(claim, USDT, 0n, toHex(255n << 248n, { size: 32 })),
    kernelCall(claim, USDT, 0n, toHex(1n, { size: 32 })), kernelCall('0xdeadbeef'), kernelCall(claim.slice(0, 10) as Hex),
    kernelCall(concatHex([claim, '0x00'])), concatHex([kernelCall(), '0x00']), batch([]), batch([...tuple, { target: zeroAddress, value: 0n, callData: claim }])]) {
    assert.throws(() => validateSponsoredCalls(operation({ callData }), c), errorCode('PAYMASTER_CALL_FORBIDDEN'));
  }
});

test('#66 executor account and registry enrollment account must equal sender; direct faucet calls forbidden', () => {
  const rebalance = (account: Hex) => encodeFunctionData({ abi: EXECUTOR_ABI, functionName: 'executeRebalance', args: [account, [{ tokenIn: USDT, tokenOut: REGISTRY, amountIn: 1n, amountOutMin: 1n, venue: REGISTRY, data: '0x' }], 2_000_000_000n] });
  validateSponsoredCalls(operation({ callData: kernelCall(rebalance(SENDER), EXECUTOR) }), config());
  const enrollAbi = parseAbi(['function enroll(address account,uint256 id,uint16 expectedVersion)']);
  validateSponsoredCalls(operation({ callData: kernelCall(encodeFunctionData({ abi: enrollAbi, functionName: 'enroll', args: [SENDER, 1n, 1] }), REGISTRY) }), config());
  for (const callData of [kernelCall(encodeFunctionData({ abi: enrollAbi, functionName: 'enroll', args: [SENDER, 1n, 0] }), REGISTRY),
    kernelCall(encodeFunctionData({ abi: enrollAbi, functionName: 'enroll', args: [SENDER, 0n, 1] }), REGISTRY),
    kernelCall(rebalance(REGISTRY), EXECUTOR), kernelCall(encodeFunctionData({ abi: enrollAbi, functionName: 'enroll', args: [REGISTRY, 1n, 1] }), REGISTRY),
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
  const op = operation({ paymasterAndData: header, callData: kernelCall() });
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

test('#92 sponsorship gas default follows chain 97 100M while local defaults and explicit limits remain intact',()=>{
  const local=loadPaymasterConfig(ENV);assert.ok(local);assert.equal(local.accountDailyGas,20_000_000n);
  const testnet=loadPaymasterConfig({...ENV,CHAIN_ID:'97',REGISTRY_ADDRESS:undefined,EXECUTOR_ADDRESS:undefined,PAYMASTER_ADDRESS:undefined,PAYMASTER_MOCK_USDT_ADDRESS:undefined});assert.ok(testnet);
  assert.equal(testnet.accountDailyGas,100_000_000n);
  assert.equal(loadPaymasterConfig({...ENV,CHAIN_ID:'97',REGISTRY_ADDRESS:undefined,EXECUTOR_ADDRESS:undefined,PAYMASTER_ADDRESS:undefined,PAYMASTER_MOCK_USDT_ADDRESS:undefined,PAYMASTER_ACCOUNT_DAILY_GAS:'0'})?.accountDailyGas,0n);
});

test('#92 C3 chain 97 defaults disable only account wei and keep explicit overrides',()=>{
  const base={...ENV,CHAIN_ID:'97',PAYMASTER_ADDRESS:undefined,EXECUTOR_ADDRESS:undefined,REGISTRY_ADDRESS:undefined,PAYMASTER_MOCK_USDT_ADDRESS:undefined};
  assert.equal(config(base).accountDailyWei,null);
  assert.equal(config(base).accountDailyCount,60n);
  assert.equal(config(base).siteDailyWei,10n**17n);
  assert.equal(config(ENV).accountDailyWei,10n**16n);
  assert.equal(config(ENV).accountDailyCount,20n);
  for(const raw of ['0','1','9007199254740993']){
    assert.equal(config({...base,PAYMASTER_ACCOUNT_DAILY_WEI:raw}).accountDailyWei,BigInt(raw));
    assert.equal(config({...base,PAYMASTER_ACCOUNT_DAILY_COUNT:raw}).accountDailyCount,BigInt(raw));
  }
});

test('#147 only public chain-97 ordinary requests use gas-attempt keys; every gas field is bound, including zero', async () => {
  const c = config({ PAYMASTER_SIGNER_PRIVATE_KEY: TEST_SIGNER, CHAIN_ID: '97', RPC_URL: 'http://127.0.0.1:8797' });
  const op = operation({ callData: kernelCall(encodeFunctionData({ abi: parseAbi(['function enroll(address,uint256,uint16)']),
    functionName: 'enroll', args: [SENDER, 1n, 1] }), c.registry) });
  const captured: Reservation[] = [];
  const make = (purpose: 'ordinary' | 'setup' | 'exit', retryOrdinaryGas = true, settings = c) => createPaymasterService({
    config: settings, retryOrdinaryGas, now: () => NOW,
    query: async () => ({ rows: [{ owner: OWNER, user_id: OWNER }] }), checkChain: async () => {},
    readBudgetContext: async () => ({ purpose, nativePrice: 60000000000n, priceSource: 'fixture:oracle' }),
    reserve: async r => { captured.push(r); },
  });
  const keys = new Set<string>();
  for (const change of [{}, { accountGasLimits: concatHex([toHex(100001n, { size: 16 }), toHex(200000n, { size: 16 })]) },
    { accountGasLimits: concatHex([toHex(100000n, { size: 16 }), toHex(200001n, { size: 16 })]) },
    { preVerificationGas: 0n }, { gasFees: toHex(0n, { size: 32 }) },
    { gasFees: concatHex([toHex(0n, { size: 16 }), toHex(2n, { size: 16 })]) },
    { gasFees: concatHex([toHex(1n, { size: 16 }), toHex(3n, { size: 16 })]) }] satisfies Partial<PackedSponsorOperation>[]) {
    await make('ordinary').sponsor({ userOperation: { ...op, ...change } }, OWNER);
    const r = captured.at(-1); assert.ok(r?.ordinaryGasRetry);
    keys.add(r.budget.executionKey);
  }
  assert.equal(keys.size, 7);
  for (const settings of [{ ...c, verificationGasLimit: c.verificationGasLimit + 1n }, { ...c, postOpGasLimit: 1n }]) {
    await make('ordinary', true, settings).sponsor({ userOperation: op }, OWNER);
    const r = captured.at(-1); assert.ok(r);
    assert.ok(!keys.has(r.budget.executionKey)); keys.add(r.budget.executionKey);
  }
  const { gasExecutionKey } = await import('../src/paymaster.js');
  for (const purpose of ['setup', 'exit'] as const) {
    await make(purpose).sponsor({ userOperation: op }, OWNER);
    assert.equal(captured.at(-1)?.ordinaryGasRetry, false);
    assert.equal(captured.at(-1)?.budget.executionKey, gasExecutionKey(97, op));
  }
  await make('ordinary', false).sponsor({ userOperation: op }, OWNER);
  assert.equal(captured.at(-1)?.budget.executionKey, gasExecutionKey(97, op));
  await assert.rejects(make('ordinary').sponsor({ userOperation: op, retryOrdinaryGas: true }, OWNER), errorCode('PAYMASTER_INVALID_OPERATION'));
});
