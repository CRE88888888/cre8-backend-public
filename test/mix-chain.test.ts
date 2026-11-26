import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicClient, custom, encodeAbiParameters, encodeEventTopics, toHex, zeroAddress } from 'viem';
import type { Hex } from 'viem';
import { entryPoint07Abi } from 'viem/account-abstraction';
import { findMixEnrollment } from '../src/mix-chain.js';
import { MIX_SUDO_NONCE_KEY } from '../src/mix-sponsorship.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';

const account = T.roles.keeper, hash = toHex(178n, { size: 32 }), blockHash = toHex(16n, { size: 32 });
const nonce = MIX_SUDO_NONCE_KEY << 64n;
function fixture() {
  const state: { emit: boolean; success: boolean; receiptLog: boolean; receiptSuccess: boolean; timestamp: bigint;
    canonical: Hex; nonce: bigint; fail: boolean; until: Date | null } = {
    emit: false, success: false, receiptLog: true, receiptSuccess: true, timestamp: 100n,
    canonical: blockHash, nonce, fail: false, until: new Date(100000) };
  const log = () => ({ address: T.contracts.entryPoint,
    topics: encodeEventTopics({ abi: entryPoint07Abi, eventName: 'UserOperationEvent', args: { userOpHash: hash, sender: account, paymaster: zeroAddress } }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [nonce, state.success, 1n, 1n]),
    blockNumber: '0x10', blockHash, transactionHash: hash, transactionIndex: '0x0', logIndex: '0x0', removed: false });
  const client = createPublicClient({ transport: custom({ request: async ({ method, params }) => {
    if (state.fail) throw new Error('fixture RPC unavailable');
    if (method === 'eth_chainId') return '0x61';
    if (method === 'eth_getBlockByNumber') return { number: '0x10', hash: state.canonical, timestamp: toHex(state.timestamp), transactions: [] };
    if (method === 'eth_getLogs') {
      const filter: unknown = Array.isArray(params) ? params[0] : undefined;
      return state.emit && typeof filter === 'object' && filter !== null && Reflect.get(filter, 'address') === T.contracts.entryPoint ? [log()] : [];
    }
    if (method === 'eth_call') return encodeAbiParameters([{ type: 'uint256' }], [state.nonce]);
    if (method === 'eth_getTransactionReceipt') return { transactionHash: hash, transactionIndex: '0x0', blockNumber: '0x10', blockHash,
      status: state.receiptSuccess ? '0x1' : '0x0', from: T.roles.operator, to: T.contracts.entryPoint,
      gasUsed: '0x1', cumulativeGasUsed: '0x1', effectiveGasPrice: '0x1', type: '0x2', contractAddress: null,
      logs: state.receiptLog ? [log()] : [], logsBloom: '0x' + '0'.repeat(512) };
    throw new Error('unexpected fixture method');
  } }, { retryCount: 0 }) });
  const intent = { strategy_id: '1', owner_calls: [], user_op_hash: hash, nonce: nonce.toString(), enroll_from_block: '16' };
  const read = () => findMixEnrollment({ account }, intent, { chain: { chainId: 97, registryAddress: T.contracts.registry, publicClient: client },
    onchainId: async () => '1', authorizationUntil: async () => state.until });
  return { state, intent, read };
}
test('submitted intent expiry requires a complete event scan, strictly expired authorization and the original nonce key', async () => {
  const f = fixture();
  assert.equal((await f.read()).kind, 'absent', 'equal to validUntil is still authorized');
  f.state.timestamp++; assert.deepEqual(await f.read(), { kind: 'failed', code: 'AUTHORIZATION_EXPIRED' });
  f.state.until = null; assert.equal((await f.read()).kind, 'absent');
  f.state.until = new Date(100000);
  f.state.nonce = nonce - 1n; await assert.rejects(f.read());
  f.state.nonce = nonce + (1n << 64n); await assert.rejects(f.read());
  f.state.nonce = nonce; f.state.fail = true; await assert.rejects(f.read());
});
test('failed intent requires its exact canonical UserOperationEvent inside a successful receipt', async () => {
  const f = fixture(); f.state.emit = true;
  assert.deepEqual(await f.read(), { kind: 'failed', code: 'USER_OPERATION_REVERTED' });
  f.state.receiptLog = false; await assert.rejects(f.read()); f.state.receiptLog = true;
  f.state.receiptSuccess = false; await assert.rejects(f.read()); f.state.receiptSuccess = true;
  f.state.canonical = toHex(17n, { size: 32 }); await assert.rejects(f.read()); f.state.canonical = blockHash;
  f.state.success = true; await assert.rejects(f.read(), 'success without matching enrollment proof cannot release exclusion');
  f.state.emit = false; f.intent.enroll_from_block = '17'; await assert.rejects(f.read());
});
