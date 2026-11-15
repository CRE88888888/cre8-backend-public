import { createPublicClient, custom, keccak256, encodeAbiParameters, toFunctionSelector, toEventSelector, toHex, encodeFunctionData, parseAbi, zeroAddress } from 'viem';
import type { Address, Hex } from 'viem';
import { WELCOME_ABI } from '../../src/welcome-grants.js';
import { TESTNET_97 } from '../../src/testnet-profile.js';
import type { Allocation } from '../../src/strategies.js';

export const BLOCK_HASH: Hex = `0x${'82'.repeat(32)}`;
export const OTHER_HASH: Hex = `0x${'83'.repeat(32)}`;
export const TEST_OWNER: Address = '0x1000000000000000000000000000000000000082';
export const TEST_ACCOUNT: Address = '0x2000000000000000000000000000000000000082';
export const TEST_AMOUNT = 1000n * 10n ** 18n;
export function strategyRpc(allocation: Allocation, configHash: Hex, activeAt: Date, txHash: Hex = OTHER_HASH) {
  const state = { chainId: 97, blockHash: BLOCK_HASH, receiptBlockHash: BLOCK_HASH, logIndex: 0, removed: false,
    success: true, logs: true, duplicateLog: false, malformed: false, by: TESTNET_97.roles.operator as Address,
    to: TEST_ACCOUNT, token: TESTNET_97.contracts.usdt as Address, amount: TEST_AMOUNT, txHash,
    now: BigInt(activeAt.getTime() / 1000), configHash, activeAt: BigInt(activeAt.getTime() / 1000),
    weights: allocation.assets.map((asset) => asset.weightBps), version: 1, pinned: 1, strategyId: 82n,
    historicalPinned: 1, historicalNow: BigInt(activeAt.getTime() / 1000), latestBlockNumber: 130n,
    mint: false, minter: true, transferFrom: zeroAddress as Address, txFrom: TESTNET_97.roles.operator as Address, txTo: TESTNET_97.contracts.usdt as Address, txValue: 0n, wrongInput: false, missingReceipt: false,
    txNonce: 0, receiptDelayMs: 0, broadcasts: [] as Hex[], blockReads: 0, reorgAtBlockRead: 0, cashRaw: TEST_AMOUNT, fail: '', reads: [] as string[] };
  const client = createPublicClient({ transport: custom({ request: async ({ method, params }) => {
    state.reads.push(method);
    if (state.fail === method || state.fail === '*') throw new Error('SECRET_RPC_CREDENTIAL');
    if (method === 'eth_chainId') return toHex(state.chainId);
    const historical = Array.isArray(params) && (method === 'eth_call' ? params[1] : params[0]) === '0x82' && state.latestBlockNumber !== 130n;
    if (method === 'eth_getBlockByNumber') { state.blockReads++; return { number: historical ? '0x82' : toHex(state.latestBlockNumber), hash: state.reorgAtBlockRead > 0 && state.blockReads >= state.reorgAtBlockRead ? OTHER_HASH : state.blockHash, timestamp: toHex(historical ? state.historicalNow : state.now), gasLimit: '0x1c9c380', gasUsed: '0x0',
      miner: TEST_OWNER, size: '0x1', extraData: '0x', parentHash: OTHER_HASH, transactions: [], difficulty: '0x0', totalDifficulty: '0x0',
      nonce: '0x0000000000000000', baseFeePerGas: '0x0', receiptsRoot: OTHER_HASH, stateRoot: OTHER_HASH, transactionsRoot: OTHER_HASH,
      logsBloom: `0x${'0'.repeat(512)}`, sha3Uncles: OTHER_HASH, uncles: [] }; }
    if (method === 'eth_getTransactionByHash') return { hash: state.txHash, from: state.txFrom, to: state.txTo,
      blockHash: state.receiptBlockHash, blockNumber: '0x82', transactionIndex: '0x0', value: toHex(state.txValue),
      input: state.wrongInput ? '0x' : state.mint ? encodeFunctionData({ abi: parseAbi(['function welcomeFor(address to)']), functionName: 'welcomeFor', args: [state.to] }) : encodeFunctionData({ abi: parseAbi(['function claimFor(address,uint256)']), functionName: 'claimFor', args: [state.to, state.amount] }),
      nonce: toHex(state.txNonce), gas: '0x100000', gasPrice: '0x1', type: '0x0', v: '0x1b', r: OTHER_HASH, s: OTHER_HASH };
    if (method === 'eth_sendRawTransaction') {
      const raw = params?.[0]; if (typeof raw !== 'string' || !raw.startsWith('0x')) throw new Error('missing raw');
      const serialized: Hex = `0x${raw.slice(2)}`; state.broadcasts.push(serialized); return keccak256(serialized);
    }
    if (method === 'eth_getTransactionReceipt') {
      if (state.receiptDelayMs > 0) await new Promise(resolve => setTimeout(resolve, state.receiptDelayMs));
      if (state.missingReceipt) return null;
      const log = { address: state.token, blockHash: state.receiptBlockHash, blockNumber: '0x82', transactionHash: state.txHash,
        transactionIndex: '0x0', logIndex: toHex(state.logIndex), removed: state.removed,
        data: state.malformed ? '0x' : encodeAbiParameters([{ type: 'uint256' }], [state.amount]),
        topics: state.mint ? [toEventSelector('Transfer(address,address,uint256)'), encodeAbiParameters([{ type: 'address' }], [state.transferFrom]), encodeAbiParameters([{ type: 'address' }], [state.to])]
          : [toEventSelector('Claimed(address,uint256,address)'), encodeAbiParameters([{ type: 'address' }], [state.to]), encodeAbiParameters([{ type: 'address' }], [state.by])] };
      return { transactionHash: state.txHash, transactionIndex: '0x0', blockHash: state.receiptBlockHash, blockNumber: '0x82',
        from: state.by, to: state.token, gasUsed: '0x100', cumulativeGasUsed: '0x100', effectiveGasPrice: '0x1', type: '0x2',
        status: state.success ? '0x1' : '0x0', contractAddress: null, logsBloom: `0x${'0'.repeat(512)}`,
        logs: state.logs ? state.duplicateLog ? [log, log] : [log] : [] };
    }
    if (method === 'eth_call') {
      if (!Array.isArray(params) || typeof params[0] !== 'object' || params[0] === null) throw new Error('missing call');
      const data: unknown = Reflect.get(params[0], 'data');
      if (typeof data !== 'string') throw new Error('missing calldata');
      if (data.startsWith(toFunctionSelector('isFaucet(address)'))) return encodeAbiParameters([{ type: 'bool' }], [state.minter]);
      if (data.startsWith(toFunctionSelector('balanceOf(address)'))) return encodeAbiParameters([{ type: 'uint256' }], [state.cashRaw]);
      if (data.startsWith(toFunctionSelector('version(uint256,uint16)'))) return encodeAbiParameters([
        { type: 'tuple', components: [{ name: 'assets', type: 'address[]' }, { name: 'weightsBps', type: 'uint16[]' }, { name: 'scheduleHash', type: 'bytes32' }, { name: 'activeAt', type: 'uint64' }] },
      ], [{ assets: allocation.assets.map((asset) => asset.address as Address), weightsBps: state.weights, scheduleHash: state.configHash, activeAt: state.activeAt }]);
      if (data.startsWith(toFunctionSelector('activeVersion(uint256)'))) return encodeAbiParameters([{ type: 'uint16' }], [state.version]);
      if (data.startsWith(toFunctionSelector('isEnrolled(address)'))) return encodeAbiParameters([{ type: 'bool' }], [true]);
      if (data.startsWith(toFunctionSelector('enrollments(address)'))) return encodeAbiParameters([{ type: 'uint256' }, { type: 'uint16' }, { type: 'bool' }], [state.strategyId, historical ? state.historicalPinned : state.pinned, false]);
    }
    throw new Error(`unexpected RPC ${method}`);
  } }, { retryCount: 0 }) });
  return { client, state };
}
