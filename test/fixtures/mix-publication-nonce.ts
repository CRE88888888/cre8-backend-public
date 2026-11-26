import { createPublicClient, createWalletClient, custom, keccak256, parseTransaction, toHex, zeroHash, decodeFunctionData, encodeAbiParameters, encodeEventTopics } from 'viem';
import type { Hex } from 'viem';
import { bscTestnet } from 'viem/chains';
import { registrationRpc } from './mix-registration.js';
import { relayerSigner } from './relayer.js';
import { record } from '../../src/strategy-execution.js';
import { REGISTRY_ABI } from '../../src/registry-abi.js';
import { TESTNET_97 as T } from '../../src/testnet-profile.js';

export function foreignNonceRpc(base: ReturnType<typeof registrationRpc>, raw: Hex) {
  const foreign = parseTransaction(raw), hash = keccak256(raw);
  if (foreign.nonce === undefined) throw new Error('fixture nonce missing');
  const nonce = foreign.nonce;
  let scheduleHash: Hex | null = null;
  if (foreign.data && foreign.data !== '0x') {
    const call = decodeFunctionData({ abi: REGISTRY_ABI, data: foreign.data });
    if (call.functionName !== 'publishSettingsVersion') throw new Error('fixture foreign publication required');
    scheduleHash = call.args[3]; base.state.publicationData = foreign.data; base.state.publicationCount = 1n;
  }
  const state = { head: null as bigint | null, headSequence: [] as bigint[], missingHead: false, headError: false,
    delayMs: 0, originalReceiptError: false, pendingOnly: false, nonceGap: false, missingTransaction: false, missingReceipt: false, wrongReceipt: false, reorg: false, duplicate: false, reverted: false };
  const blockHash = (n: bigint) => n === 1n ? zeroHash : toHex(n + (state.reorg ? 100n : 0n), { size: 32 });
  const publicationLogs = () => scheduleHash === null ? [] : [{ address: T.contracts.registry, blockNumber: '0x2', blockHash: blockHash(2n),
    transactionHash: hash, transactionIndex: '0x0', logIndex: '0x0', removed: false,
    topics: encodeEventTopics({ abi: REGISTRY_ABI, eventName: 'VersionPublished', args: { id: base.state.id } }),
    data: encodeAbiParameters([{ type: 'uint16' }, { type: 'bytes32' }], [1, scheduleHash]) }];
  const transaction = { hash, from: relayerSigner.address, to: foreign.to, input: foreign.data ?? '0x', value: toHex(foreign.value ?? 0n),
    nonce: toHex(nonce), type: '0x2', chainId: '0x61', gas: toHex(foreign.gas ?? 21000n), gasPrice: '0x2', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1',
    blockNumber: '0x2', blockHash: blockHash(2n), transactionIndex: '0x0', r: foreign.r, s: foreign.s, v: '0x0', accessList: [] };
  const transport = custom({ request: async request => {
    const { method, params } = request;
    if (state.delayMs) await new Promise(resolve => setTimeout(resolve, state.delayMs));
    const args: readonly unknown[] = Array.isArray(params) ? params : [];
    const published = base.state.publicationCount > 0n;
    const mined = published || base.state.broadcasts.some(raw => (parseTransaction(raw).nonce ?? -1) > nonce);
    if (method === 'eth_getTransactionCount') {
      const tag = args[1], block = tag === 'latest' || tag === 'pending' ? (mined ? 4n : 3n) : BigInt(String(tag));
      if (state.nonceGap) return toHex(nonce);
      if (state.pendingOnly && tag !== 'pending') return toHex(nonce);
      return toHex(nonce + (block < 2n ? 0 : block >= 4n && mined ? 2 : 1));
    }
    if (method === 'eth_getBlockByNumber') {
      if (args[0] === 'latest' && state.headError) throw new Error('private head RPC failure');
      if (args[0] === 'latest' && state.missingHead) return null;
      const number = args[0] === 'latest' ? (state.headSequence.shift() ?? state.head ?? (mined ? 4n : 3n)) : BigInt(String(args[0]));
      const tx = { ...transaction, blockHash: blockHash(2n) };
      return { number: toHex(number), hash: blockHash(number), timestamp: toHex(99n + number), baseFeePerGas: '0x1', gasLimit: '0x1000000', gasUsed: '0x1',
        transactions: number === 2n && args[1] === true && !state.missingTransaction ? state.duplicate ? [tx, tx] : [tx] : [] };
    }
    if (method === 'eth_getTransactionByHash' && args[0] === hash) return state.missingTransaction ? null : { ...transaction, blockHash: blockHash(2n) };
    if (method === 'eth_getTransactionReceipt' && args[0] === hash) return state.missingReceipt ? null : {
      transactionHash: state.wrongReceipt ? zeroHash : hash, from: relayerSigner.address, to: foreign.to, blockNumber: '0x2', blockHash: blockHash(2n),
      transactionIndex: '0x0', type: '0x2', cumulativeGasUsed: '0x1', gasUsed: '0x1', effectiveGasPrice: '0x1', contractAddress: null,
      status: state.reverted ? '0x0' : '0x1', logsBloom: '0x' + '0'.repeat(512), logs: publicationLogs() };
    if (method === 'eth_getLogs' && scheduleHash !== null) return publicationLogs();
    if (method === 'eth_getTransactionReceipt' && args[0] !== hash && state.originalReceiptError && !published) throw new Error('fixture original receipt RPC error');
    const result: unknown = await base.client.transport.request(request);
    if (mined && (method === 'eth_getTransactionReceipt' || method === 'eth_getTransactionByHash') && record(result)) {
      return { ...result, blockNumber: '0x4', blockHash: blockHash(4n), ...(Array.isArray(result.logs) ? {
        logs: result.logs.map((log: unknown) => { if (!record(log)) throw new Error('fixture log missing'); return { ...log, blockNumber: '0x4', blockHash: blockHash(4n) }; }),
      } : {}) };
    }
    if (published && method === 'eth_getLogs' && Array.isArray(result)) return result.map((log: unknown) => {
      if (!record(log)) throw new Error('fixture log missing'); return { ...log, blockNumber: '0x4', blockHash: blockHash(4n) };
    });
    return result;
  } }, { retryCount: 0 });
  const client = createPublicClient({ chain: bscTestnet, transport, cacheTime: 0 });
  return { ...base, client, chain: { ...base.chain, publicClient: client, wallet: createWalletClient({ chain: bscTestnet, transport, account: relayerSigner }) }, foreignState: state, foreignHash: hash };
}
