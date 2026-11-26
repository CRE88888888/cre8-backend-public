import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData, erc20Abi, maxUint256 } from 'viem';
import type { Address, PublicClient } from 'viem';
import { describePolicies, installedExecutorOf, keyNeedsExecutorRenewal } from '../src/permissions.js';
import { profileAddress, TESTNET_97, TESTNET_97_SUPERSEDED } from '../src/testnet-profile.js';
import { chainExecutorApprovals } from '../src/renewal.js';
import { loadSessionKeyConfig } from '../src/config.js';

// cre8-contracts#76: the executor with the sale credit on the buy limit is a new address. Keys installed before point
// at the old one; they are recognised, never sent to, and the owner's renewal also approves the new executor.
const OLD = TESTNET_97_SUPERSEDED.executors[0]!;
const NEW = TESTNET_97.contracts.executor as Address;
const ACCOUNT = '0x00000000000000000000000000000000000000aa' as Address;

test('#76 the profile executor is the new one; the superseded one is listed and differs', () => {
  assert.notEqual(NEW.toLowerCase(), OLD.toLowerCase());
  assert.equal(TESTNET_97.contracts.executor, NEW.toLowerCase());
});

test('#76 a key snapshot reports the executor it was installed for, and whether it needs a renewal', () => {
  const old = describePolicies({ executorAddress: OLD, chainId: 97, yieldAccount: ACCOUNT, borrowAccount: ACCOUNT });
  const fresh = describePolicies({ executorAddress: NEW, chainId: 97, yieldAccount: ACCOUNT, borrowAccount: ACCOUNT });
  assert.equal(installedExecutorOf(old), OLD.toLowerCase());
  assert.equal(installedExecutorOf(fresh), NEW.toLowerCase());
  assert.equal(keyNeedsExecutorRenewal(old, NEW), true);
  assert.equal(keyNeedsExecutorRenewal(fresh, NEW), false);
  // Unreadable snapshots are never reported as "needs renewal" (nothing to compare): the scheduler's own checks decide.
  for (const bad of [null, {}, { call: {} }, { call: { permissions: 'x' } }]) {
    assert.equal(installedExecutorOf(bad), null);
    assert.equal(keyNeedsExecutorRenewal(bad, NEW), false);
  }
});

test('#76 EXECUTOR_ADDRESS still set to the superseded executor resolves to the current one; other foreign values still fail', () => {
  assert.equal(profileAddress(97, 'EXECUTOR_ADDRESS', OLD), NEW.toLowerCase());
  assert.equal(profileAddress(97, 'EXECUTOR_ADDRESS', null), NEW.toLowerCase());
  assert.throws(() => profileAddress(97, 'EXECUTOR_ADDRESS', '0x000000000000000000000000000000000000dEaD'));
  assert.throws(() => profileAddress(97, 'REGISTRY_ADDRESS', OLD));
  assert.equal(loadSessionKeyConfig({ CHAIN_ID: '97', EXECUTOR_ADDRESS: OLD }).executorAddress?.toLowerCase(), NEW.toLowerCase());
});

test('#76 renewal approvals: USDT, the strategy assets, held tokens and what the old executor had, without an allowance to the new one, nothing else', async () => {
  const usdt = TESTNET_97.contracts.usdt.toLowerCase() as Address;
  const symbols = Object.keys(TESTNET_97.assets);
  const versionAsset = TESTNET_97.assets[symbols[0] as keyof typeof TESTNET_97.assets].token.toLowerCase() as Address;
  const approvedAsset = TESTNET_97.assets[symbols[1] as keyof typeof TESTNET_97.assets].token.toLowerCase() as Address;
  const heldAsset = TESTNET_97.assets[symbols[2] as keyof typeof TESTNET_97.assets].token.toLowerCase() as Address;
  const heldReceipt = TESTNET_97.yieldMarkets[0]!.receipt.toLowerCase() as Address;
  const stray = '0x000000000000000000000000000000000000beef' as Address;
  const oldApproved = TESTNET_97.assets[symbols[3] as keyof typeof TESTNET_97.assets].token.toLowerCase() as Address;
  const multicall = async ({ contracts }: { contracts: { address: Address; functionName: string; args: readonly Address[] }[] }) =>
    contracts.map((c) => {
      const token = c.address.toLowerCase();
      if (c.functionName === 'balanceOf') return token === heldAsset || token === heldReceipt ? 5n : 0n;
      // What the account had approved to the superseded executor comes back too.
      if (c.args[1] === OLD) return token === oldApproved || token === approvedAsset ? maxUint256 : 0n;
      assert.equal(c.args[1], NEW);
      return token === approvedAsset ? maxUint256 : 0n;
    });
  const db = { query: (async () => ({ rows: [{ allocation: { assets: [{ address: versionAsset }, { address: approvedAsset }, { address: stray }] } }] })) as never };
  const approvals = await chainExecutorApprovals({ chainId: 97, account: ACCOUNT, executor: NEW, strategyId: 7, publicClient: { multicall } as unknown as PublicClient }, db);
  assert.deepEqual(approvals.map((a) => a.to), [usdt, versionAsset, heldAsset, heldReceipt, oldApproved]);
  for (const a of approvals) {
    const call = decodeFunctionData({ abi: erc20Abi, data: a.data });
    assert.equal(call.functionName, 'approve');
    assert.deepEqual([call.args[0].toLowerCase(), call.args[1]], [NEW.toLowerCase(), maxUint256]);
    assert.equal(a.value, '0');
  }
  assert.deepEqual(await chainExecutorApprovals({ chainId: 56, account: ACCOUNT, executor: NEW, strategyId: 7, publicClient: {} as PublicClient }, db), []);
});

test('#76 My mix: a renewal plus approvals to the current executor is a migration only for a legacy key, only profile tokens, max amount', async () => {
  const { mixExecutorMigration } = await import('../src/paymaster.js');
  const { encodeFunctionData: enc } = await import('viem');
  const c = { chainId: 97, executor: NEW } as never;
  const sender = ACCOUNT;
  const pair = [{ target: sender, value: 0n, callData: '0x01' as const }, { target: sender, value: 0n, callData: '0x02' as const }];
  const approve = (token: string, spender: Address = NEW, amount = maxUint256) =>
    ({ target: token as Address, value: 0n, callData: enc({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }) });
  const usdt = TESTNET_97.contracts.usdt;
  const legacy = describePolicies({ executorAddress: OLD, chainId: 97 }), current = describePolicies({ executorAddress: NEW, chainId: 97 });
  const db = (permissions: unknown) => (async () => ({ rows: [{ permissions }] }));
  assert.equal(await mixExecutorMigration(sender, [...pair, approve(usdt)], c, db(legacy)), true);
  assert.equal(await mixExecutorMigration(sender, [...pair, approve(usdt)], c, db(current)), false, 'a current key needs no migration');
  assert.equal(await mixExecutorMigration(sender, [...pair, approve(usdt, OLD)], c, db(legacy)), false, 'only the current executor');
  assert.equal(await mixExecutorMigration(sender, [...pair, approve(usdt, NEW, 5n)], c, db(legacy)), false, 'only the max amount');
  assert.equal(await mixExecutorMigration(sender, [...pair, approve('0x000000000000000000000000000000000000beef')], c, db(legacy)), false, 'only profile tokens');
  assert.equal(await mixExecutorMigration(sender, [approve(usdt)], c, db(legacy)), false, 'the renewal pair must lead');
  assert.equal(await mixExecutorMigration(sender, [...pair, approve(usdt)], { chainId: 56, executor: NEW } as never, db(legacy)), false);
});
