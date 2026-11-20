import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData, erc20Abi, getAddress, maxUint256, zeroAddress } from 'viem';
import { mixOwnerCalls } from '../src/mix-approval.js';
import { REGISTRY_ABI } from '../src/registry-abi.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';

const old = T.assets.NVDAB.token, added = T.assets.TSLAB.token;
const args = { account: T.roles.keeper, registry: T.contracts.registry, executor: T.contracts.executor, onchainId: 40n,
  previousAssets: [T.contracts.usdt, old], assets: [T.contracts.usdt, added, old], allowances: new Map([[added, 0n]]) };

test('mix owner atomically approves only a newly selected unapproved asset then enrolls', () => {
  const calls = mixOwnerCalls(args);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.to, added);
  assert.equal(calls[0]?.value, '0');
  const approval = calls[0], enrollment = calls[1];
  assert.ok(approval && enrollment);
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: approval.data }).args, [getAddress(args.executor), maxUint256]);
  assert.deepEqual(decodeFunctionData({ abi: REGISTRY_ABI, data: enrollment.data }).args, [getAddress(args.account), 40n, 1]);
});
test('mix ratio-only switch contains exactly enroll and needs no allowance reads', () => {
  const calls = mixOwnerCalls({ ...args, assets: args.previousAssets, allowances: new Map() });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.to, args.registry);
});
test('mix initial setup approves selected assets including USDT, never unrelated assets', () => {
  const calls = mixOwnerCalls({ ...args, previousAssets: [], assets: [old, T.contracts.usdt],
    allowances: new Map([[old, 0n], [T.contracts.usdt, 0n], [added, 0n]]) });
  assert.deepEqual(calls.map(call => call.to), [old, T.contracts.usdt, args.registry]);
});
test('mix matches existing positive-allowance setup, including 1 and maxUint256', () => {
  for (const allowance of [1n, maxUint256]) assert.equal(mixOwnerCalls({ ...args, allowances: new Map([[added, allowance]]) }).length, 1);
});
test('mix fails closed for missing/negative/overflow allowance, duplicate or invalid assets and invalid id', () => {
  for (const allowances of [new Map<string, bigint>(), new Map([[added, -1n]]), new Map([[added, maxUint256 + 1n]])]) {
    assert.throws(() => mixOwnerCalls({ ...args, allowances }), /無法確認新增資產/);
  }
  for (const onchainId of [0n, -1n, maxUint256 + 1n]) assert.throws(() => mixOwnerCalls({ ...args, onchainId }), /組合授權資料/);
  for (const assets of [[], [added, added], [zeroAddress, added, added]]) assert.throws(() => mixOwnerCalls({ ...args, assets }), /組合授權資料/);
});
