import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData } from 'viem';
import { yieldGoldenVector } from '../scripts/gen-yield-golden.js';
import golden from './fixtures/yield-golden.json' with { type: 'json' };
import { YIELD_EXECUTOR_ABI } from '../src/yield-abi.js';

test('#85 APP-3 shared owner-upgrade policies, permissionId, initConfig and self supply/withdraw encoding vectors', async () => {
  const actual = await yieldGoldenVector();
  assert.deepEqual(actual, golden);
  for (const call of actual.calls) {
    const decoded = decodeFunctionData({ abi: YIELD_EXECUTOR_ABI, data: call.data });
    assert.equal(decoded.functionName, call.functionName);
    assert.ok(decoded.functionName === 'executeSupply' || decoded.functionName === 'executeWithdraw');
    assert.deepEqual(decoded.args, [actual.account, call.marketId, BigInt(call.amountRaw), BigInt(call.minimumRaw), BigInt(call.deadline)]);
  }
});
