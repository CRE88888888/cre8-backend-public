import assert from 'node:assert/strict';
import { test } from 'node:test';
import { concatHex, encodeAbiParameters, encodeFunctionData, parseAbi, toHex } from 'viem';
import type { Address, Hex } from 'viem';
import type { EnrollmentPreparation } from '../src/portfolios.js';
import { verifyEnrollmentSponsorship } from '../src/enrollment-sponsorship.js';
import { createPaymasterService, KERNEL_EXECUTE_ABI } from '../src/paymaster.js';
import { REGISTRY_ABI } from '../src/registry-abi.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
import { AppError } from '../src/errors.js';
import { config, kernelCall, operation, OWNER, SENDER, NOW } from './fixtures/paymaster.js';
const c = { ...config(), chainId: 97, registry: T.contracts.registry, executor: T.contracts.executor };
const data = encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'enroll', args: [SENDER, 1n, 1] });
const factory = T.contracts.kernelMetaFactory, factoryData: Hex = '0x1234';
const prepared: EnrollmentPreparation = { account: SENDER, expectedVersion: 1, configHash: toHex(0, { size: 32 }), activeAt: new Date(0).toISOString(), performanceFeeBps: 500,
  terms: '', termsHash: toHex(0, { size: 32 }), accountDeployed: true, signingMode: 'sudo' as const, call: { to: c.registry, data, value: '0' } };
const op = () => operation({ callData: kernelCall(data, c.registry) });
const denied = (error: unknown) => error instanceof AppError && error.code === 'PAYMASTER_SENDER_FORBIDDEN';

test('#124 setup sponsorship binds the persisted owner intent, exact derived account/factory and effective version', async () => {
  for (const initCode of ['0x'] as const) {
    let reads = 0;
    await verifyEnrollmentSponsorship({ ...op(), initCode }, c, OWNER, {
      query: async (_sql, params) => { assert.deepEqual(params, [OWNER, '1']); reads++; return { rows: [{ strategy_id: '7' }] }; },
      prepare: async (id, owner) => { assert.equal(id, 7); assert.equal(owner, OWNER); return prepared; },
    });
    assert.equal(reads, 1);
  }
  const maximum = encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'enroll', args: [SENDER, 1n, 65535] });
  await verifyEnrollmentSponsorship({ ...op(), callData: kernelCall(maximum, c.registry) }, c, OWNER, {
    query: async () => ({ rows: [{ strategy_id: '7' }] }),
    prepare: async () => ({ ...prepared, expectedVersion: 65535, call: { ...prepared.call, data: maximum } }),
  });
  let earlyReads = 0;
  const early = { query: async () => { earlyReads++; return { rows: [] }; }, prepare: async () => { throw new Error('must not prepare'); } };
  for (const bad of [
    kernelCall(encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'enroll', args: [SENDER, 1n, 0] }), c.registry),
    kernelCall(encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'enroll', args: [SENDER, 0n, 1] }), c.registry),
    kernelCall(encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'enroll', args: [T.roles.owner, 1n, 1] }), c.registry),
    kernelCall(data, c.registry, 1n), kernelCall(concatHex([data, '0x00']), c.registry),
  ]) await assert.rejects(verifyEnrollmentSponsorship({ ...op(), callData: bad }, c, OWNER, early), denied);
  assert.equal(earlyReads, 0);
  for (const scenario of ['no-intent', 'duplicate', 'invalid-id', 'account', 'version', 'factory', 'missing-factory', 'undeployed', 'calldata', 'registry', 'native', 'chain', 'wallet']) {
    await assert.rejects(verifyEnrollmentSponsorship({ ...op(), initCode: scenario === 'factory' ? concatHex([factory, '0xabcd']) : scenario === 'missing-factory' ? concatHex([factory, factoryData]) : '0x' },
      { ...c, chainId: scenario === 'chain' ? 56 : 97 }, scenario === 'wallet' ? 'invalid' : OWNER, {
        query: async () => ({ rows: scenario === 'no-intent' ? [] : scenario === 'duplicate' ? [{ strategy_id: '7' }, { strategy_id: '7' }] : [{ strategy_id: scenario === 'invalid-id' ? '9007199254740993' : '7' }] }),
        prepare: async () => ({ ...prepared, account: scenario === 'account' ? T.roles.owner : SENDER,
          expectedVersion: scenario === 'version' ? 2 : 1, accountDeployed: scenario === 'undeployed' ? undefined : true,
          call: { ...prepared.call, to: scenario === 'registry' ? T.roles.owner : c.registry, value: scenario === 'native' ? '1' : '0', data: scenario === 'calldata' ? '0x' : data } }),
      }), denied);
  }
});

test('#124 unconfirmed setup admits only one enroll and optional USDT executor approval in either order', async () => {
  const approve = encodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), functionName: 'approve', args: [c.executor, 1n] });
  const calls: { target: Address; value: bigint; callData: Hex }[] = [{ target: c.registry, value: 0n, callData: data }, { target: T.contracts.usdt, value: 0n, callData: approve }];
  const batch = (entries: typeof calls) => encodeFunctionData({ abi: KERNEL_EXECUTE_ABI, functionName: 'execute', args: [toHex(1n << 248n, { size: 32 }),
    encodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'callData', type: 'bytes' }] }], [entries])] });
  const deps = { query: async () => ({ rows: [{ strategy_id: '7' }] }), prepare: async () => prepared };
  await verifyEnrollmentSponsorship({ ...op(), callData: batch(calls) }, c, OWNER, deps);
  const first = calls[0], second = calls[1]; assert.ok(first && second);
  await verifyEnrollmentSponsorship({ ...op(), callData: batch([second, first]) }, c, OWNER, deps);
  for (const entries of [[first, first], [...calls, second], [second], [first, { ...second, value: 1n }], [first, { ...second, target: T.roles.owner }],
    [first, { ...second, callData: encodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), functionName: 'approve', args: [T.roles.owner, 1n] }) }]]) {
    await assert.rejects(verifyEnrollmentSponsorship({ ...op(), callData: batch(entries) }, c, OWNER, deps));
  }
});

test('#124 sponsorship still reserves normally after intent verification, and never falls back for a foreign stored owner', async () => {
  let verified = 0, reserved = 0, queried = 0;
  const service = (rows: { owner: string; user_id: string }[]) => createPaymasterService({ config: c, now: () => NOW,
    query: async () => { queried++; return { rows }; }, enrollmentSetup: async () => { verified++; }, checkChain: async () => {},
    readBudgetContext: async () => ({ purpose: 'ordinary', nativePrice: 1n, priceSource: 'test:oracle' }),
    reserve: async () => { reserved++; },
  });
  await service([]).sponsor({ userOperation: op() }, OWNER);
  assert.equal(verified, 1); assert.equal(reserved, 1);
  await assert.rejects(service([{ owner: T.roles.owner, user_id: T.roles.owner }]).sponsor({ userOperation: op() }, OWNER), denied);
  assert.equal(verified, 1); assert.equal(reserved, 1);
  const reads = queried;
  for (const rows of [[], [{ owner: OWNER, user_id: OWNER }]]) {
    await assert.rejects(service(rows).sponsor({ userOperation: { ...op(), initCode: concatHex([factory, factoryData]) } }, OWNER),
      (error: unknown) => error instanceof AppError && error.code === 'PAYMASTER_ACCOUNT_UNDEPLOYED');
  }
  assert.equal(queried, reads); assert.equal(verified, 1); assert.equal(reserved, 1);
  const failure = createPaymasterService({ config: c, now: () => NOW, query: async () => ({ rows: [] }),
    enrollmentSetup: async () => { throw new Error('SECRET_RPC_OR_DB'); }, reserve: async () => { reserved++; } });
  await assert.rejects(failure.sponsor({ userOperation: op() }, OWNER), (error: unknown) => error instanceof AppError && !error.message.includes('SECRET'));
  assert.equal(reserved, 1);
});


test('#124 setup fallback keeps chain/capacity/budget gates, and a late timeout result never reserves', async () => {
  for (const phase of ['chain', 'capacity', 'budget', 'timeout']) {
    let reserved = 0, budget = 0;
    const service = createPaymasterService({ config: { ...c, timeoutMs: 5 }, now: () => NOW, query: async () => ({ rows: [] }),
      enrollmentSetup: async () => { if (phase === 'timeout') await new Promise(resolve => setTimeout(resolve, 20)); },
      checkChain: async () => { if (phase === 'chain') throw new Error('SECRET_RPC'); },
      readBudgetContext: async () => { budget++; if (phase === 'budget') throw new Error('SECRET_BUDGET_DB'); return { purpose: 'ordinary', nativePrice: 1n, priceSource: 'fixture' }; },
      reserve: async () => { reserved++; },
    });
    const input = phase === 'capacity' ? { ...op(), accountGasLimits: concatHex([toHex(1n, { size: 16 }), toHex(14_000_001n, { size: 16 })]) } : op();
    await assert.rejects(service.sponsor({ userOperation: input }, OWNER), (error: unknown) => error instanceof AppError && !error.message.includes('SECRET'));
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(reserved, 0);
    assert.equal(budget, phase === 'budget' ? 1 : 0);
  }
});

test('buy speed: first-buy setup may also approve address-book assets to the executor, once each, up to 32 calls', async () => {
  const approveAbi = parseAbi(['function approve(address,uint256)']);
  const approve = (target: Address, spender: Address = c.executor) => ({ target, value: 0n, callData: encodeFunctionData({ abi: approveAbi, functionName: 'approve', args: [spender, 2n ** 256n - 1n] }) });
  const batch = (entries: { target: Address; value: bigint; callData: Hex }[]) => encodeFunctionData({ abi: KERNEL_EXECUTE_ABI, functionName: 'execute', args: [toHex(1n << 248n, { size: 32 }),
    encodeAbiParameters([{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'callData', type: 'bytes' }] }], [entries])] });
  const deps = { query: async () => ({ rows: [{ strategy_id: '7' }] }), prepare: async () => prepared };
  const enroll = { target: c.registry, value: 0n, callData: data };
  const assets = Object.values(T.assets).map(asset => asset.token as Address);
  assert.ok(assets.length >= 31);
  await verifyEnrollmentSponsorship({ ...op(), callData: batch([enroll, approve(T.contracts.usdt), ...assets.slice(0, 5).map(a => approve(a))]) }, c, OWNER, deps);
  await verifyEnrollmentSponsorship({ ...op(), callData: batch([enroll, approve(T.contracts.usdt), ...assets.slice(0, 30).map(a => approve(a))]) }, c, OWNER, deps);
  const [a0, a1] = assets; assert.ok(a0 && a1);
  for (const entries of [
    [enroll, approve(T.contracts.usdt), ...assets.slice(0, 31).map(a => approve(a))], // 33 calls
    [enroll, approve(a0), approve(a0)], // same asset twice
    [enroll, approve(a0, T.roles.owner)], // foreign spender
    [enroll, approve(T.roles.owner)], // not in the address book
    [enroll, { ...approve(a1), value: 1n }],
    [enroll, enroll, approve(a0)],
    [approve(a0), approve(a1)], // no enrollment
  ]) await assert.rejects(verifyEnrollmentSponsorship({ ...op(), callData: batch(entries) }, c, OWNER, deps),
    (error: unknown) => error instanceof AppError && (error.code === 'PAYMASTER_SENDER_FORBIDDEN' || error.code === 'PAYMASTER_CALL_FORBIDDEN'));
});
