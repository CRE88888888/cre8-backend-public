import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicClient, custom, decodeFunctionData, encodeErrorResult, encodeFunctionResult, getAddress } from 'viem';
import type { Address, Hex } from 'viem';
import { bscTestnet } from 'viem/chains';
import { quoteYieldAction, yieldCallGasLimit, isYieldMinimumError } from '../src/yield-execution.js';
import { YIELD_EXECUTOR_ABI, YIELD_REGISTRY_ABI } from '../src/yield-abi.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
import { erc20Abi } from 'viem';

const account = getAddress('0x1000000000000000000000000000000000000005');
const market = T.yieldMarkets[0];
const blockHash: Hex = `0x${'12'.repeat(32)}`;
const block = { number: '0x7b', hash: blockHash, parentHash: blockHash, timestamp: '0x6553f100',
  gasLimit: '0x1c9c380', gasUsed: '0x0', logsBloom: `0x${'00'.repeat(256)}`, transactions: [], uncles: [],
  difficulty: '0x0', extraData: '0x', miner: account, nonce: '0x0000000000000000', size: '0x1',
  receiptsRoot: blockHash, sha3Uncles: blockHash, stateRoot: blockHash, transactionsRoot: blockHash };

function quoteClient(mode = 'ok') {
  const calls: { address: Address; data: Hex; block: unknown }[] = [];
  const client = createPublicClient({ chain: bscTestnet, transport: custom({ request: async ({ method, params }) => {
    if (mode === 'rpc') throw new Error('SECRET_RPC_TOKEN');
    if (method === 'eth_chainId') return mode === 'chain' ? '0x38' : '0x61';
    if (method === 'eth_getBlockByNumber') {
      if (mode === 'missing-block') return null;
      return { ...block, hash: mode === 'reorg' && calls.length > 0 ? `0x${'34'.repeat(32)}` : blockHash };
    }
    assert.equal(method, 'eth_call');
    assert.ok(Array.isArray(params));
    const request: unknown = params[0]; assert.ok(request && typeof request === 'object');
    const to: unknown = Reflect.get(request, 'to'), data: unknown = Reflect.get(request, 'data');
    assert.ok(typeof to === 'string' && typeof data === 'string' && /^0x[0-9a-f]+$/i.test(data));
    assert.equal(params[1], '0x7b');
    calls.push({ address: getAddress(to), data: data as Hex, block: params[1] });
    if (to.toLowerCase() === T.contracts.executor) {
      const decoded = decodeFunctionData({ abi: YIELD_EXECUTOR_ABI, data: data as Hex });
      if (decoded.functionName === 'yieldRegistry') return encodeFunctionResult({ abi: YIELD_EXECUTOR_ABI, functionName: 'yieldRegistry', result: T.contracts.yieldRegistry });
      assert.ok(decoded.functionName === 'executeSupply' || decoded.functionName === 'executeWithdraw');
      assert.equal(decoded.args[3], 100n, 'full preview min, never discounted');
      assert.equal(decoded.args[4], BigInt(block.timestamp) + 300n);
      if (mode === 'simulation') throw new Error('SECRET_REVERT');
      return '0x';
    }
    if (to.toLowerCase() === T.contracts.yieldRegistry) {
      const decoded = decodeFunctionData({ abi: YIELD_REGISTRY_ABI, data: data as Hex });
      if (decoded.functionName === 'market') return encodeFunctionResult({ abi: YIELD_REGISTRY_ABI, functionName: 'market', result: {
        chainId: 97n, kind: 1, asset: market.asset, target: mode === 'identity' ? account : market.target,
        receipt: market.receipt, riskSource: market.target, configuration: blockHash, minRate: 1n, maxRate: 10n ** 36n, supplyEnabled: true, retired: false,
      } });
      assert.ok(decoded.functionName === 'quoteSupply' || decoded.functionName === 'quoteWithdraw');
      return encodeFunctionResult({ abi: YIELD_REGISTRY_ABI, functionName: decoded.functionName, result: mode === 'zero' ? 0n : 100n });
    }
    return encodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', result: mode === 'insufficient' ? 0n : 1000n });
  } }, { retryCount: 0 }) });
  return { client, calls };
}

test('#85 supply and withdraw use non-view accrued quote at one canonical block with exact minimum and deadline', async () => {
  for (const kind of ['supply', 'withdraw'] as const) {
    const { client, calls } = quoteClient();
    const plan = await quoteYieldAction(client, account, { kind, marketId: market.marketId, amount: 100n });
    assert.equal(plan.minimum, 100n); assert.equal(plan.quoteBlock, 123n); assert.equal(plan.quoteBlockHash, blockHash);
    assert.equal(plan.assetBalance, 1000n); assert.equal(plan.receiptBalance, 1000n);
    assert.equal(calls.length, 6);
    assert.equal(plan.data.slice(0, 10), kind === 'supply' ? '0x5728db07' : '0x63f865c0');
  }
});

test('#85 zero/negative/overflow amounts, invalid TTL and unknown markets reject before RPC', async () => {
  const { client, calls } = quoteClient();
  for (const amount of [0n, -1n, 1n << 256n]) await assert.rejects(quoteYieldAction(client, account, { kind: 'supply', marketId: market.marketId, amount }), /YIELD_INVALID_ACTION|無效/);
  for (const ttl of [0, 301, 1.5]) await assert.rejects(quoteYieldAction(client, account, { kind: 'withdraw', marketId: market.marketId, amount: 1n }, ttl), /無效/);
  await assert.rejects(quoteYieldAction(client, account, { kind: 'supply', marketId: blockHash, amount: 1n }), /未知/);
  assert.equal(calls.length, 0);
});

test('#85 RPC/missing block/identity/zero quote/reorg/insufficient balance/simulation fail closed and redact errors', async () => {
  for (const mode of ['rpc', 'chain', 'missing-block', 'identity', 'zero', 'reorg', 'insufficient', 'simulation']) {
    await assert.rejects(quoteYieldAction(quoteClient(mode).client, account, { kind: 'supply', marketId: market.marketId, amount: 1n }),
      (error: unknown) => error instanceof Error && /未送交易/.test(error.message) && !error.message.includes('SECRET'), mode);
  }
});

test('#85 exactly 200% call estimate shares the 14M capacity check, including equality, zero and one gas over', () => {
  assert.equal(yieldCallGasLimit(1_480_000n, 200_000n), 2_960_000n);
  assert.equal(yieldCallGasLimit(6_900_000n, 200_000n), 13_800_000n);
  for (const [estimate, overhead] of [[6_900_001n, 200_000n], [0n, 0n], [-1n, 0n], [1n, -1n]] as const) assert.throws(() => yieldCallGasLimit(estimate, overhead));
});

test('#85 only ABI-proven YieldMinimum is retryable; raw messages, unknown errors and cause cycles are not', () => {
  const data = encodeErrorResult({ abi: YIELD_EXECUTOR_ABI, errorName: 'YieldMinimum', args: [10n, 11n] });
  assert.equal(isYieldMinimumError({ cause: { data } }), true);
  for (const error of [null, new Error('YieldMinimum'), { data: '0xdeadbeef' }, { data: 'SECRET' }]) assert.equal(isYieldMinimumError(error), false);
  const cyclic: { cause?: unknown } = {}; cyclic.cause = cyclic;
  assert.equal(isYieldMinimumError(cyclic), false);
});
