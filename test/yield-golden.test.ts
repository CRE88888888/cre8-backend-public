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
