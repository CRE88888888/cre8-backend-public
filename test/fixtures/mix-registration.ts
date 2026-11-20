import { createPublicClient, createWalletClient, custom, decodeFunctionData, encodeFunctionResult, encodeAbiParameters, encodeEventTopics, keccak256, parseTransaction, toHex, zeroHash } from 'viem';
import type { Hex } from 'viem';
import { bscTestnet } from 'viem/chains';
import { kernelAddressesForChain } from '../../src/addresses.js';
import { MIX_REGISTRATION_DATA } from '../../src/mix-registration.js';
import { REGISTRY_ABI, REGISTRY_VERSION_ABI } from '../../src/registry-abi.js';
import { TESTNET_97 as T } from '../../src/testnet-profile.js';
import { relayerSigner } from './relayer.js';
export async function signedMixRegistration(overrides: { nonce?: number; chainId?: number; to?: `0x${string}`; value?: bigint; data?: Hex; gas?: bigint } = {}) {
  const raw = await relayerSigner.signTransaction({ chainId: 97, type: 'eip1559', nonce: 0, gas: 300000n, maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n, to: T.contracts.registry, value: 0n, data: MIX_REGISTRATION_DATA, ...overrides });
  return { hash: keccak256(raw), raw };
}
function decodePublicationSchedule(data: Hex) {
  const decoded = decodeFunctionData({ abi: REGISTRY_ABI, data });
  if (decoded.functionName !== 'publishSettingsVersion') throw new Error('invalid fixture publication');
  return decoded.args[3];
}
export function registrationRpc() {
  const transactions = new Map<Hex, { raw: Hex; publication: boolean; reverted: boolean }>();
  const state = { publicationAlreadyKnown: false, publicationCountLagReads: 0, pendingNonceFailures: 0, pendingNonce: null as number | null, latestNonce: null as number | null, blockNumberMismatch: false, prepareCalls: 0, prepareDelayMs: 0, publicationDelayMs: 0, publicationMissing: false, publicationSendFail: false, publicationReverted: false, publicationConfigConflict: false, publicationCount: 0n, publicationRaw: '0x' as Hex, publicationFail: false, publicationData: '0x' as Hex, mode: 'healthy', raw: '0x' as Hex, broadcasts: [] as Hex[], nonces: 0, delayMs: 0, id: 178000001n };
  const transport = custom({ request: async ({ method, params }) => {
    if (state.mode === 'rpc') throw new Error('private RPC failure');
    if (method === 'eth_blockNumber') return '0x1';
    if (method === 'eth_chainId') return state.mode === 'chain' ? '0x38' : '0x61';
    if (method === 'eth_getTransactionCount') {
      if (Array.isArray(params) && params[1] === 'pending' && state.pendingNonceFailures > 0) { state.pendingNonceFailures--; throw new Error('fixture pending nonce unavailable'); }
      if (Array.isArray(params) && typeof params[1] === 'string' && params[1].startsWith('0x')) {
        return toHex(Math.max(0, ...[...transactions.values()].map(tx => (parseTransaction(tx.raw).nonce ?? -1) + 1)));
      }
      const override = Array.isArray(params) && params[1] === 'latest' ? state.latestNonce : state.pendingNonce;
      return toHex(override ?? state.nonces++);
    }
    if (method === 'eth_maxPriorityFeePerGas' || method === 'eth_gasPrice') return '0x1';
    if (method === 'eth_estimateGas') { state.prepareCalls++; if (state.prepareDelayMs) await new Promise(resolve => setTimeout(resolve, state.prepareDelayMs)); return '0x493e0'; }
    if (method === 'eth_getBlockByNumber') return { number: state.blockNumberMismatch && Array.isArray(params) && params[0] === '0x1' ? '0x2' : '0x1', hash: state.mode === 'reorg' ? toHex(2n, { size: 32 }) : zeroHash,
      timestamp: '0x64', baseFeePerGas: '0x1', gasLimit: '0x1000000', gasUsed: '0x1', transactions: [] };
    if (method === 'eth_sendRawTransaction') {
      const raw: unknown = Array.isArray(params) ? params[0] : undefined;
      if (typeof raw !== 'string' || !/^0x([0-9a-f]{2})+$/.test(raw)) throw new Error('invalid fixture raw');
      const signed: Hex = `0x${raw.slice(2)}`;
      const tx = parseTransaction(signed);
      const hash = keccak256(signed), publication = !tx.data?.startsWith(MIX_REGISTRATION_DATA.slice(0, 10));
      if (publication && state.publicationSendFail) throw new Error('private publication send failure');
      if (publication && state.publicationAlreadyKnown && transactions.has(hash)) throw new Error('fixture already known');
      if (!transactions.has(hash)) {
        transactions.set(hash, { raw: signed, publication, reverted: publication && state.publicationReverted });
        if (publication && !state.publicationReverted) state.publicationCount++;
      }
      if (!publication) state.raw = signed;
      else { state.publicationRaw = signed; state.publicationData = tx.data ?? '0x'; }
      state.broadcasts.push(signed);
      if (state.mode === 'send') throw new Error('private unknown broadcast');
      return keccak256(signed);
    }
    if (method === 'eth_call') {
      const call: unknown = Array.isArray(params) ? params[0] : null;
      if (!call || typeof call !== 'object' || !('data' in call) || typeof call.data !== 'string') throw new Error('invalid fixture call');
      const data: Hex = `0x${call.data.slice(2)}`;
      const decoded = decodeFunctionData({ abi: REGISTRY_VERSION_ABI, data });
      if (decoded.functionName === 'versionCount') return encodeFunctionResult({ abi: REGISTRY_VERSION_ABI, functionName: 'versionCount', result: state.publicationCountLagReads > 0 ? (state.publicationCountLagReads--, 0n) : state.publicationCount });
      if (decoded.functionName === 'activeVersion') return encodeFunctionResult({ abi: REGISTRY_VERSION_ABI, functionName: 'activeVersion', result: state.publicationCount === 1n ? 1 : 0 });
      if (decoded.functionName === 'version') {
        const publication = decodeFunctionData({ abi: REGISTRY_ABI, data: state.publicationData });
        if (publication.functionName !== 'publishSettingsVersion') throw new Error('no fixture publication');
        const [, assets, weightsBps, scheduleHash, settingsHash, performanceFeeBps] = publication.args;
        const configHash = keccak256(encodeAbiParameters([{ type: 'address[]' }, { type: 'uint16[]' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint16' }],
          [assets, weightsBps, scheduleHash, settingsHash, performanceFeeBps]));
        return encodeFunctionResult({ abi: REGISTRY_VERSION_ABI, functionName: 'version', result: {
          assets, weightsBps, scheduleHash, settingsHash, performanceFeeBps, configHash: state.publicationConfigConflict ? zeroHash : configHash, activeAt: 100n } });
      }
      throw new Error('unexpected fixture contract call');
    }
    if (method === 'eth_getTransactionReceipt') {
      if (state.delayMs) await new Promise(resolve => setTimeout(resolve, state.delayMs));
      if (state.mode === 'missing') return null;
      const requested: unknown = Array.isArray(params) ? params[0] : null;
      const saved = typeof requested === 'string' ? transactions.get(`0x${requested.slice(2)}`) : undefined;
      if (!saved && requested !== keccak256(state.raw)) return null;
      const publication = saved?.publication ?? false;
      if (publication && state.publicationDelayMs) await new Promise(resolve => setTimeout(resolve, state.publicationDelayMs));
      if (publication && state.publicationMissing) return null;
      if (publication && state.publicationFail) throw new Error('private publication receipt failure');
      const hash = keccak256(saved?.raw ?? state.raw);
      return { transactionHash: hash, blockHash: zeroHash, blockNumber: '0x1', transactionIndex: '0x0', from: relayerSigner.address,
        to: T.contracts.registry, cumulativeGasUsed: '0x1', gasUsed: '0x1', effectiveGasPrice: '0x1', type: '0x2', contractAddress: null,
        status: state.mode === 'revert' || transactions.get(hash)?.reverted ? '0x0' : '0x1', logsBloom: '0x' + '0'.repeat(512),
        logs: state.mode === 'event' ? [] : [{ address: T.contracts.registry, blockNumber: '0x1', blockHash: zeroHash, transactionHash: hash,
          transactionIndex: '0x0', logIndex: '0x0', removed: false,
          topics: publication ? encodeEventTopics({ abi: REGISTRY_ABI, eventName: 'VersionPublished', args: { id: state.id } })
            : encodeEventTopics({ abi: REGISTRY_ABI, eventName: 'StrategyRegistered', args: { id: state.id, provider: relayerSigner.address } }),
          data: publication ? encodeAbiParameters([{ type: 'uint16' }, { type: 'bytes32' }], [1, decodePublicationSchedule(state.publicationData)])
            : encodeAbiParameters([{ type: 'string' }], ['CRE8 mix']) }] };
    }
    if (method === 'eth_getTransactionByHash') {
      const requested: unknown = Array.isArray(params) ? params[0] : null;
      const signed = typeof requested === 'string' ? transactions.get(`0x${requested.slice(2)}`)?.raw : undefined;
      const raw = signed ?? state.raw;
      const tx = parseTransaction(raw);
      return { ...tx, nonce: toHex((tx.nonce ?? 0) + (state.mode === 'nonce' ? 1 : 0)), hash: keccak256(raw),
        from: relayerSigner.address, to: T.contracts.registry, input: tx.data, value: '0x0', type: '0x2', chainId: '0x61',
        gas: '0x493e0', gasPrice: '0x2', maxFeePerGas: '0x2', maxPriorityFeePerGas: '0x1', blockNumber: '0x1', blockHash: zeroHash, transactionIndex: '0x0' };
    }
    if (method === 'eth_getLogs') return [...transactions.entries()].filter(([, tx]) => tx.publication && !tx.reverted).map(([hash, tx]) => ({
      address: T.contracts.registry, blockNumber: '0x1', blockHash: zeroHash, transactionHash: hash, transactionIndex: '0x0', logIndex: '0x0', removed: false,
      topics: encodeEventTopics({ abi: REGISTRY_ABI, eventName: 'VersionPublished', args: { id: state.id } }),
      data: encodeAbiParameters([{ type: 'uint16' }, { type: 'bytes32' }], [1, decodePublicationSchedule(parseTransaction(tx.raw).data ?? '0x')]) }));
    throw new Error('unexpected fixture method ' + method);
  } }, { retryCount: 0 });
  const client = createPublicClient({ chain: bscTestnet, transport, cacheTime: 0, pollingInterval: 1 });
  const chain = { chainId: 97, rpcUrl: 'http://127.0.0.1:8580', registryAddress: T.contracts.registry, account: relayerSigner,
    kernel: kernelAddressesForChain(97), wallet: createWalletClient({ chain: bscTestnet, account: relayerSigner, transport }), publicClient: client };
  return { state, client, chain };
}
