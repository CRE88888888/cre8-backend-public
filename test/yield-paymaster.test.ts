import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeCallDataEpV07 } from '@zerodev/sdk';
import { concatHex, encodeFunctionData, erc20Abi, toHex } from 'viem';
import { createPaymasterService, pureYieldWithdraw, validateSponsoredCalls } from '../src/paymaster.js';
import type { Reservation } from '../src/paymaster.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
import { YIELD_EXECUTOR_ABI, YIELD_REGISTRY_ABI } from '../src/yield-abi.js';
import { config, operation, SENDER, OWNER, TEST_SIGNER, NOW } from './fixtures/paymaster.js';

const c = config({ CHAIN_ID: '97', RPC_URL: 'http://127.0.0.1:8592', PAYMASTER_SIGNER_PRIVATE_KEY: TEST_SIGNER });
const market = T.yieldMarkets[0];
const data = (kind: 'executeSupply' | 'executeWithdraw') => encodeFunctionData({ abi: YIELD_EXECUTOR_ABI, functionName: kind,
  args: [SENDER, market.marketId, 1n, 1n, BigInt(NOW + 300)] });
const call = (kind: 'executeSupply' | 'executeWithdraw') => ({ to: T.contracts.executor, data: data(kind), value: 0n });

test('#85 final canonical payload classifies supply ordinary, every pure withdrawal exit, mixed batches ordinary', async () => {
  const saved: Reservation[] = [];
  const service = createPaymasterService({ config: c, now: () => NOW,
    query: async () => ({ rows: [{ owner: OWNER, user_id: OWNER }] }), checkChain: async () => {},
    readBudgetContext: async () => ({ purpose: 'ordinary', nativePrice: 1n, priceSource: 'fixture:oracle' }),
    reserve: async r => { saved.push(r); } });
  for (const [calls, purpose] of [
    [[call('executeSupply')], 'ordinary'], [[call('executeWithdraw')], 'exit'],
    [[call('executeWithdraw'), call('executeWithdraw')], 'exit'], [[call('executeWithdraw'), call('executeSupply')], 'ordinary'],
  ] as const) {
    const op = operation({ callData: await encodeCallDataEpV07(calls) });
    assert.equal(pureYieldWithdraw(op, c), purpose === 'exit');
    await service.sponsor({ userOperation: op }, OWNER);
    assert.equal(saved.at(-1)?.budget.purpose, purpose);
  }
  const supplied = operation({ callData: await encodeCallDataEpV07([call('executeSupply')]) });
  await assert.rejects(service.sponsor({ userOperation: supplied, purpose: 'exit' }, OWNER), /PAYMASTER_INVALID_OPERATION/);
});

test('#85 paymaster refuses final total gas over 14M; includes paymaster overhead and permits exact equality', async () => {
  let count = 0;
  const service = createPaymasterService({ config: c, now: () => NOW,
    query: async () => ({ rows: [{ owner: OWNER, user_id: OWNER }] }), checkChain: async () => {},
    readBudgetContext: async () => ({ purpose: 'ordinary', nativePrice: 1n, priceSource: 'fixture:oracle' }),
    reserve: async () => { count++; } });
  const base = 14_000_000n - 100_000n - 50_000n - c.verificationGasLimit - c.postOpGasLimit;
  for (const extra of [-1n, 0n, 1n]) {
    const op = operation({ callData: await encodeCallDataEpV07([call('executeSupply')]),
      accountGasLimits: concatHex([toHex(100_000n, { size: 16 }), toHex(base + extra, { size: 16 })]) });
    if (extra > 0n) await assert.rejects(service.sponsor({ userOperation: op }, OWNER), /PAYMASTER_USER_OP_CAPACITY/);
    else await service.sponsor({ userOperation: op }, OWNER);
  }
  assert.equal(count, 2);
});

test('#85 owner setup accepts only registered receipt approve to executor and typed policy; arbitrary calls stay forbidden', async () => {
  const approve = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [c.executor, 1n] });
  const consent = encodeFunctionData({ abi: YIELD_REGISTRY_ABI, functionName: 'setYieldPolicy', args: [market.marketId, 1n, true] });
  const setup = await encodeCallDataEpV07([{ to: market.receipt, data: approve, value: 0n }, { to: T.contracts.yieldRegistry, data: consent, value: 0n }]);
  validateSponsoredCalls(operation({ callData: setup }), c);
  const forbidden = [
    { to: market.receipt, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [SENDER, 1n] }), value: 0n },
    { to: market.receipt, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [SENDER, 1n] }), value: 0n },
    { to: T.contracts.yieldRegistry, data: encodeFunctionData({ abi: YIELD_REGISTRY_ABI, functionName: 'setYieldPolicy', args: [market.marketId, 0n, true] }), value: 0n },
    { to: T.contracts.yieldRegistry, data: encodeFunctionData({ abi: YIELD_REGISTRY_ABI, functionName: 'releaseReservation', args: [SENDER, market.marketId, 1n] }), value: 0n },
  ];
  for (const call of forbidden) {
    const callData = await encodeCallDataEpV07([call]);
    assert.throws(() => validateSponsoredCalls(operation({ callData }), c), /PAYMASTER_CALL_FORBIDDEN/);
  }
});
