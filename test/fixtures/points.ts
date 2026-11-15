import { encodeAbiParameters, encodeEventTopics, keccak256, toHex } from 'viem';
import type { Address, Hex, Log, TransactionReceipt } from 'viem';
import { KERNEL_V3_3_ADDRESSES } from '../../src/addresses.js';
import type { PointsConfig } from '../../src/config.js';
import { POINTS_ABI } from '../../src/points.js';
import type { PointsCatalog, PointsOperation, PointsReader } from '../../src/points.js';

export const address = (i: number): Address => `0x670067${i.toString(16).padStart(34, '0')}`;
export const hash = (i: number): Hex => keccak256(toHex(i));
export const OWNER = address(1);
export const ACCOUNT = address(101);
export const BLOCK_HASH = hash(999);
export const OCCURRED = new Date('2026-01-01T00:00:00Z');
export function jsonObject(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new Error('expected JSON object');
  return value;
}
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function concreteTopics(input: ReturnType<typeof encodeEventTopics>): [Hex, ...Hex[]] {
  const values: Hex[] = [];
  for (const topic of input) { if (typeof topic !== 'string') throw new Error('fixture topics must be concrete'); values.push(topic); }
  const [signature, ...rest] = values;
  if (!signature) throw new Error('fixture requires an event signature');
  return [signature, ...rest];
}
export function config(): PointsConfig {
  return { chainId: 1337, rpcUrl: 'http://127.0.0.1:8558', registry: address(201), executor: address(202), token: address(203),
    fromBlock: 0n, confirmations: 3n, delaySeconds: 0, timeoutMs: 100,
    rules: { enroll: { points: 10n, dailyCount: 10n, dailyPoints: 100n }, deposit: { points: 10n, dailyCount: 10n, dailyPoints: 100n },
      rebalance: { points: 10n, dailyCount: 10n, dailyPoints: 100n }, create_fund: { points: 10n, dailyCount: 10n, dailyPoints: 100n },
      withdraw: { points: 10n, dailyCount: 10n, dailyPoints: 100n }, invite_reward: { points: 10n, dailyCount: 10n, dailyPoints: 100n } } };
}
export function operation(i = 1, owner = OWNER): PointsOperation {
  return { owner, chainId: 1337, kind: 'deposit', txHash: hash(i), logIndex: 0, occurredAt: OCCURRED };
}
export function catalog(): PointsCatalog {
  return { accounts: new Map([[ACCOUNT, { owner: OWNER, strategy: '1' }], [address(102), { owner: OWNER, strategy: '1' }]]),
    strategies: new Map([['1', { owner: OWNER, name: 'Test fund' }]]), tokens: new Set([config().token, address(204)]) };
}
export function transfer(from = OWNER, to = ACCOUNT, value = 1n, index = 0): Log<bigint, number, false> {
  return { address: config().token, blockHash: BLOCK_HASH, blockNumber: 10n, transactionHash: hash(1), transactionIndex: 0, logIndex: index,
    removed: false, topics: concreteTopics(encodeEventTopics({ abi: POINTS_ABI, eventName: 'Transfer', args: { from, to } })), data: encodeAbiParameters([{ type: 'uint256' }], [value]) };
}
export function enrolled(id = 1n): Log<bigint, number, false> {
  return { ...transfer(), address: config().registry, topics: concreteTopics(encodeEventTopics({ abi: POINTS_ABI, eventName: 'Enrolled', args: { account: ACCOUNT } })),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint16' }], [id, 1]) };
}
export function registered(id = 1n): Log<bigint, number, false> {
  return { ...transfer(), address: config().registry, topics: concreteTopics(encodeEventTopics({ abi: POINTS_ABI, eventName: 'StrategyRegistered', args: { id, provider: address(999) } })),
    data: encodeAbiParameters([{ type: 'string' }], ['Test fund']) };
}
export function swapped(index = 0): Log<bigint, number, false> {
  return { ...transfer(OWNER, ACCOUNT, 1n, index), address: config().executor,
    topics: concreteTopics(encodeEventTopics({ abi: POINTS_ABI, eventName: 'SwapExecuted', args: { account: ACCOUNT } })),
    data: encodeAbiParameters([{ type: 'address' }, { type: 'address' }, ...Array.from({ length: 5 }, () => ({ type: 'uint256' } as const))],
      [config().token, address(204), 10n, 11n, 1n, 10n, 9n]) };
}
export function receipt(logs: Log<bigint, number, false>[] = [transfer()]): TransactionReceipt {
  return { blockHash: BLOCK_HASH, blockNumber: 10n, transactionHash: hash(1), status: 'success', logs, transactionIndex: 0,
    from: OWNER, to: config().token, gasUsed: 100n, cumulativeGasUsed: 100n, effectiveGasPrice: 1n, contractAddress: null, logsBloom: '0x', type: 'legacy' };
}
export function reader(overrides: Partial<PointsReader> = {}): PointsReader {
  return { chainId: async () => 1337, head: async () => 12n, block: async () => ({ hash: BLOCK_HASH, timestamp: BigInt(OCCURRED.getTime() / 1000) }),
    logs: async () => [transfer()], receipt: async () => receipt(), owner: async () => ({ root: '0x01' + KERNEL_V3_3_ADDRESSES.ecdsaValidatorV31.slice(2), owner: OWNER }), ...overrides };
}
