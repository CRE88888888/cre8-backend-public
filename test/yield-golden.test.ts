import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData } from 'viem';
import { yieldGoldenVector } from '../scripts/gen-yield-golden.js';
import golden from './fixtures/yield-golden.json' with { type: 'json' };
import { YIELD_EXECUTOR_ABI, YIELD_REGISTRY_ABI, YIELD_VIEW_ABI } from '../src/yield-abi.js';

test('#85 APP-3 shared owner-upgrade policies, permissionId, initConfig and self supply/withdraw encoding vectors', async () => {
  const actual = await yieldGoldenVector();
  assert.deepEqual(actual, golden);
  assert.deepEqual([...new Set(actual.calls.map(c => c.protocol))], ['Venus', 'Lista', 'Aave']);
  for (const call of actual.calls) {
    const decoded = decodeFunctionData({ abi: YIELD_EXECUTOR_ABI, data: call.data });
    assert.equal(decoded.functionName, call.functionName);
    assert.ok(decoded.functionName === 'executeSupply' || decoded.functionName === 'executeWithdraw');
    assert.deepEqual(decoded.args, [actual.account, call.marketId, BigInt(call.amountRaw), BigInt(call.minimumRaw), BigInt(call.deadline)]);
  }
});

test('#110 YieldView ABI is read-only; registry keeps accrued/accounted wrappers and exposes reader', () => {
  const registry = new Set<string>(YIELD_REGISTRY_ABI.flatMap(item => item.type === 'function' ? [item.name] : []));
  for (const name of ['reader', 'quoteSupply', 'quoteWithdraw', 'receiptAssets', 'refreshHealth']) assert.ok(registry.has(name), name);
  const view = YIELD_VIEW_ABI.filter(item => item.type === 'function');
  assert.ok(view.length > 0);
  assert.ok(view.every(item => ['view', 'pure'].includes(item.stateMutability)));
  assert.ok(view.some(item => item.name === 'quoteSupply'));
  assert.ok(view.some(item => item.name === 'quoteWithdraw'));
  assert.ok(YIELD_EXECUTOR_ABI.some(item => item.type === 'function' && item.name === 'YIELD_QUOTE_TOLERANCE_BPS'));
});

test('#106 registry ABI contains reviewed reconciliation and identity/rate controls, without legacy chain reservations', () => {
  const names = new Set<string>(YIELD_REGISTRY_ABI.flatMap(item => item.type === 'function' ? [item.name] : []));
  for (const name of ['reconcile', 'acknowledgeIdentity', 'marketIdentity', 'widenMaxRate', 'rateCheckpoint']) assert.ok(names.has(name), name);
  for (const name of ['reserveSupply', 'totalReserved']) assert.equal(names.has(name), false, name);
});

test('session permission cannot be used for ERC-1271: new installs carry NOT_FOR_VALIDATE_SIG; keys installed before rebuild to their old id', async () => {
  const { createPublicClient, custom } = await import('viem');
  const { bscTestnet } = await import('viem/chains');
  const { mnemonicToAccount } = await import('viem/accounts');
  const { PolicyFlags } = await import('@zerodev/permissions');
  const { buildSessionPermissions, SESSION_PERMISSION_FLAG, SESSION_PERMISSION_FLAG_LEGACY, sessionPermissionFlagOf } = await import('../src/permissions.js');
  const { TESTNET_97: T } = await import('../src/testnet-profile.js');
  assert.deepEqual([SESSION_PERMISSION_FLAG, SESSION_PERMISSION_FLAG_LEGACY], [PolicyFlags.NOT_FOR_VALIDATE_SIG, PolicyFlags.FOR_ALL_VALIDATION]);
  const client = createPublicClient({ chain: bscTestnet, transport: custom({ request: async () => { throw new Error('no RPC'); } }) });
  const args = { publicClient: client, sessionKeyAddress: mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 3 }).address,
    executorAddress: T.contracts.executor as `0x${string}`, yieldAccount: '0x1000000000000000000000000000000000000005' as const, validUntil: 1_900_000_000 };
  const fresh = await buildSessionPermissions(args);
  assert.equal(fresh.permissionId, golden.permissionId);
  assert.equal(fresh.policySnapshot.permissionFlag, '0x0002');
  // The same key as installed before 2026-11-24 (this vector's id in the previous golden file): rebuilt byte for byte, against
  // the executor it was installed for (superseded by cre8-contracts#76).
  const { TESTNET_97_SUPERSEDED } = await import('../src/testnet-profile.js');
  const legacy = await buildSessionPermissions({ ...args, executorAddress: TESTNET_97_SUPERSEDED.executors[0]!, permissionFlag: SESSION_PERMISSION_FLAG_LEGACY });
  assert.equal(legacy.permissionId, '0xe2ff633f');
  assert.notEqual(legacy.permissionId, fresh.permissionId);
  assert.notDeepEqual(legacy.initConfig, fresh.initConfig);
  // What the scheduler reads from a stored snapshot: old rows have no field -> legacy; anything unknown -> legacy; new rows -> new.
  const { permissionFlag: _drop, ...oldRow } = legacy.policySnapshot;
  assert.deepEqual([sessionPermissionFlagOf(oldRow), sessionPermissionFlagOf(null), sessionPermissionFlagOf({ permissionFlag: '0x0001' }), sessionPermissionFlagOf(fresh.policySnapshot)],
    ['0x0000', '0x0000', '0x0000', '0x0002']);
  await assert.rejects(buildSessionPermissions({ ...args, permissionFlag: '0x0001' }));
});
