import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeCallDataEpV07 } from '@zerodev/sdk';
import { encodeAbiParameters, erc20Abi, zeroAddress, keccak256, toBytes, pad } from 'viem';
import type { Address, Hex } from 'viem';
import { getUserOperationHash } from 'viem/account-abstraction';
import type { GetUserOperationReturnType, UserOperationReceipt } from 'viem/account-abstraction';
import { verifyYieldReceipt, yieldReceiptEvidence } from '../src/yield-execution.js';
import type { YieldPlan } from '../src/yield-execution.js';
import { YIELD_EXECUTOR_ABI } from '../src/yield-abi.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
import { encodeErrorResult, encodeFunctionData } from 'viem';

function fixture(kind: 'supply' | 'withdraw', partial = false) {
  const account: Address = '0x1000000000000000000000000000000000000005';
  const hash: Hex = `0x${'12'.repeat(32)}`;
  const market = T.yieldMarkets[0];
  const assets = 100n * 10n ** 18n, shares = 100n * 10n ** 8n;
  const supply = kind === 'supply';
  const remaining = supply ? shares : partial ? 1n : 0n;
  const plan: YieldPlan = { kind, marketId: market.marketId, amount: supply ? assets : shares, minimum: supply ? shares : assets,
    chainId: 97, account, executor: T.contracts.executor, yieldRegistry: T.contracts.yieldRegistry, asset: market.asset,
    receipt: market.receipt, deadline: 1000n, quoteBlock: 1n, quoteBlockHash: hash, data: '0x', assetBalance: assets,
    receiptBalance: supply ? 0n : shares + remaining };
  const base = { blockHash: hash, blockNumber: 2n, transactionHash: hash, transactionIndex: 0, removed: false };
  const transfer = (address: Address, from: Address, to: Address, value: bigint, logIndex: number): UserOperationReceipt['logs'][number] => ({ ...base,
    address, logIndex, topics: [keccak256(toBytes('Transfer(address,address,uint256)')), pad(from), pad(to)],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]) });
  const event: UserOperationReceipt['logs'][number] = { ...base, address: plan.executor, logIndex: 2,
    topics: [keccak256(toBytes(`${supply ? 'SupplyExecuted' : 'WithdrawExecuted'}(address,bytes32,uint256,uint256,uint256)`)), pad(account), plan.marketId],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], supply ? [assets, shares, remaining] : [shares, assets, remaining]) };
  const receipt: UserOperationReceipt = { actualGasCost: 123n, actualGasUsed: 123n, entryPoint: T.contracts.entryPoint,
    nonce: 1n, sender: account, success: true, userOpHash: hash,
    logs: [transfer(plan.asset, supply ? account : plan.executor, supply ? plan.executor : account, assets, 0),
      transfer(plan.receipt, supply ? zeroAddress : account, supply ? account : zeroAddress, shares, 1), event],
    receipt: { ...base, contractAddress: null, cumulativeGasUsed: 123n, effectiveGasPrice: 1n, from: account,
      gasUsed: 123n, logs: [], logsBloom: '0x', status: 'success', to: T.contracts.entryPoint, type: 'eip1559' } };
  return { plan, receipt };
}

test('#85 supply 18 underlying / 8 receipt units reconcile exactly; partial withdrawal retains remaining receipts', () => {
  for (const [kind, partial] of [['supply', false], ['withdraw', false], ['withdraw', true]] as const) {
    const f = fixture(kind, partial);
    const evidence = yieldReceiptEvidence(f.plan, f.receipt);
    assert.equal(evidence.assets, 100n * 10n ** 18n); assert.equal(evidence.shares, 100n * 10n ** 8n);
    assert.equal(evidence.remainingReceipts, kind === 'supply' ? evidence.shares : partial ? 1n : 0n);
  }
});

test('#85 real executor allowance Approval logs are not counted as account token transfers', () => {
  const f = fixture('supply');
  const first = f.receipt.logs[0]; assert.ok(first);
  f.receipt.logs.push({ ...first, logIndex: 3,
    topics: [keccak256(toBytes('Approval(address,address,uint256)')), pad(f.plan.executor), pad(f.plan.asset)] });
  assert.equal(yieldReceiptEvidence(f.plan, f.receipt).assets, f.plan.amount);
});

test('#85 Aave nominal Transfer raw differs from exact scaled-balance accounting; no arbitrary rounding tolerance', () => {
  const market = T.yieldMarkets.find(m => m.protocol === 'Aave' && m.symbol === 'USDT'); assert.ok(market);
  for (const kind of ['supply', 'withdraw'] as const) {
    const f = fixture(kind);
    const supply = kind === 'supply';
    const plan: YieldPlan = { ...f.plan, marketId: market.marketId, asset: market.asset, receipt: market.receipt,
      amount: 100n, minimum: supply ? 99n : 100n, receiptBalance: supply ? 0n : 102n, scaledReceiptBalance: supply ? 0n : 34n };
    const asset = f.receipt.logs[0], receipt = f.receipt.logs[1], event = f.receipt.logs[2]; assert.ok(asset && receipt && event);
    asset.address = market.asset; receipt.address = market.receipt;
    asset.data = receipt.data = encodeAbiParameters([{ type: 'uint256' }], [100n]);
    event.topics = [keccak256(toBytes(`${supply ? 'SupplyExecuted' : 'WithdrawExecuted'}(address,bytes32,uint256,uint256,uint256)`)), pad(plan.account), plan.marketId];
    event.data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], supply ? [100n, 99n, 99n] : [100n, 100n, 0n]);
    const accounting = { index: 3n * 10n ** 27n, scaledAfter: supply ? 33n : 0n, rawBalanceAfter: supply ? 99n : 0n };
    assert.equal(yieldReceiptEvidence(plan, f.receipt, accounting).remainingReceipts, accounting.rawBalanceAfter);
    assert.throws(() => yieldReceiptEvidence(plan, f.receipt));
    assert.throws(() => yieldReceiptEvidence(plan, f.receipt, { ...accounting, scaledAfter: accounting.scaledAfter + 1n }));
    assert.throws(() => yieldReceiptEvidence(plan, f.receipt, { ...accounting, rawBalanceAfter: accounting.rawBalanceAfter + 1n }));
  }
});

test('#85 tx success alone, op failure, missing/duplicate/wrong/removed events, bad amounts/min/deltas cannot confirm', () => {
  for (const mutate of [
    (r: UserOperationReceipt) => { r.success = false; },
    (r: UserOperationReceipt) => { r.receipt.status = 'reverted'; },
    (r: UserOperationReceipt) => { r.sender = zeroAddress; },
    (r: UserOperationReceipt) => { r.logs = []; },
    (r: UserOperationReceipt) => { const e = r.logs[2]; assert.ok(e); r.logs.push(e); },
    (r: UserOperationReceipt) => { const e = r.logs[2]; assert.ok(e); e.address = zeroAddress; },
    (r: UserOperationReceipt) => { const e = r.logs[2]; assert.ok(e); e.removed = true; },
    (r: UserOperationReceipt) => { r.logs.splice(0, 1); },
    (r: UserOperationReceipt) => { const t = r.logs[0]; assert.ok(t); t.data = encodeAbiParameters([{ type: 'uint256' }], [1n]); },
  ]) {
    const f = fixture('supply'); mutate(f.receipt);
    assert.throws(() => yieldReceiptEvidence(f.plan, f.receipt));
  }
  const f = fixture('withdraw');
  assert.throws(() => yieldReceiptEvidence({ ...f.plan, amount: f.plan.amount + 1n }, f.receipt));
  assert.throws(() => yieldReceiptEvidence({ ...f.plan, minimum: f.plan.minimum + 1n }, f.receipt));
  assert.throws(() => yieldReceiptEvidence({ ...f.plan, receiptBalance: f.plan.receiptBalance + 1n }, f.receipt));
});

async function canonicalFixture() {
  const f = fixture('supply');
  const data = encodeFunctionData({ abi: YIELD_EXECUTOR_ABI, functionName: 'executeSupply',
    args: [f.plan.account, f.plan.marketId, f.plan.amount, f.plan.minimum, f.plan.deadline] });
  const plan = { ...f.plan, data };
  const callData = await encodeCallDataEpV07([{ to: plan.executor, data, value: 0n }]);
  const original: GetUserOperationReturnType = { blockHash: f.receipt.receipt.blockHash, blockNumber: f.receipt.receipt.blockNumber,
    transactionHash: f.receipt.receipt.transactionHash, entryPoint: T.contracts.entryPoint,
    userOperation: { sender: plan.account, nonce: 1n, callData, callGasLimit: 1_000_000n, verificationGasLimit: 200_000n,
      preVerificationGas: 50_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, signature: '0x' } };
  const hash = getUserOperationHash({ userOperation: original.userOperation, chainId: 97, entryPointAddress: T.contracts.entryPoint, entryPointVersion: '0.7' });
  f.receipt.userOpHash = hash;
  const closing: UserOperationReceipt['logs'][number] = { ...f.receipt.logs[0], address: T.contracts.entryPoint,
    blockHash: f.receipt.receipt.blockHash, blockNumber: f.receipt.receipt.blockNumber,
    transactionHash: f.receipt.receipt.transactionHash, transactionIndex: 0, logIndex: 3, removed: false,
    topics: [keccak256(toBytes('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)')), hash, pad(plan.account), pad(zeroAddress)],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [1n, true, 123n, 123n]) };
  const input = { receipt: f.receipt, original, canonicalBlockHash: f.receipt.receipt.blockHash,
    chainReceipt: { ...f.receipt.receipt, logs: [...f.receipt.logs, closing] } };
  const saved = { plan, nonce: 1n, callData, userOpHash: hash };
  return { input, saved, closing };
}

test('#85 independently verifies the closing EntryPoint event excluded from UserOp logs and ignores adjacent operations', async () => {
  const f = await canonicalFixture();
  assert.equal(verifyYieldReceipt(f.saved, f.input).status, 'confirmed');
  const leading: UserOperationReceipt['logs'][number] = { ...f.closing, logIndex: 0, topics: [keccak256(toBytes('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)')), keccak256('0x1234'), pad(zeroAddress), pad(zeroAddress)] };
  for (const log of f.input.chainReceipt.logs) { assert.ok(log.logIndex !== null); log.logIndex++; }
  f.input.chainReceipt.logs.unshift(leading);
  assert.equal(verifyYieldReceipt(f.saved, f.input).status, 'confirmed');
  f.input.receipt.logs.unshift(leading);
  assert.throws(() => verifyYieldReceipt(f.saved, f.input));
});

test('#85 wrong canonical block/payload/nonce/sender/hash/EntryPoint/status, missing or duplicate event cannot release intent', async () => {
  type F = Awaited<ReturnType<typeof canonicalFixture>>;
  for (const mutate of [
    (f: F) => { f.input.canonicalBlockHash = keccak256('0x01'); },
    (f: F) => { f.input.original.transactionHash = keccak256('0x01'); },
    (f: F) => { f.input.original.userOperation.nonce++; },
    (f: F) => { f.input.original.userOperation.sender = zeroAddress; },
    (f: F) => { f.input.receipt.userOpHash = keccak256('0x01'); },
    (f: F) => { f.input.receipt.entryPoint = zeroAddress; },
    (f: F) => { f.input.chainReceipt.status = 'reverted'; },
    (f: F) => { f.input.receipt.success = false; },
    (f: F) => { f.input.receipt.actualGasUsed++; },
    (f: F) => { f.input.chainReceipt.logs.pop(); },
    (f: F) => { f.input.chainReceipt.logs.push(f.closing); },
    (f: F) => { f.closing.removed = true; },
    (f: F) => { f.saved.plan = { ...f.saved.plan, minimum: f.saved.plan.minimum + 1n }; },
    (f: F) => { f.saved.callData = `${f.saved.callData}00`; },
  ]) {
    const f = await canonicalFixture(); mutate(f);
    assert.throws(() => verifyYieldReceipt(f.saved, f.input));
  }
});

test('#85 only independently verified execution revert with ABI YieldMinimum permits a new quote attempt', async () => {
  const f = await canonicalFixture();
  f.input.receipt.success = false;
  f.closing.data = encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [1n, false, 123n, 123n]);
  const revertReason = encodeErrorResult({ abi: YIELD_EXECUTOR_ABI, errorName: 'YieldMinimum', args: [10n, 11n] });
  const reason: UserOperationReceipt['logs'][number] = { ...f.closing, logIndex: 0,
    topics: [keccak256(toBytes('UserOperationRevertReason(bytes32,address,uint256,bytes)')), f.saved.userOpHash, pad(f.saved.plan.account)],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], [1n, revertReason]) };
  f.closing.logIndex = 1;
  f.input.receipt.logs = [reason]; f.input.chainReceipt.logs = [reason, f.closing];
  const reverted = verifyYieldReceipt(f.saved, f.input);
  assert.ok(reverted.status === 'reverted'); assert.equal(reverted.retryable, true);
  reason.data = encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], [1n, '0xdeadbeef']);
  const other = verifyYieldReceipt(f.saved, f.input);
  assert.ok(other.status === 'reverted'); assert.equal(other.retryable, false);
});
