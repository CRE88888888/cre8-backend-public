import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeErrorResult, getAddress, toFunctionSelector, zeroAddress } from 'viem';
import type { Abi, Address, PublicClient, WalletClient } from 'viem';
import { KERNEL_V3_3_ADDRESSES } from '../src/addresses.js';
import { enrollOnchain } from '../src/chain.js';
import type { ChainConfig } from '../src/chain.js';

// Address-only stubs: these tests never load a private key, connect to a DB or make an RPC call.
const SIGNER = getAddress('0x15d34aaf54267db7d7c367839aaf71a00a2c6a65');
const OWNER = getAddress('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
const REGISTRY: Address = '0x0000000000000000000000000000000000000001';
const SMART_ACCOUNT: Address = '0x0000000000000000000000000000000000000002';
const TX_HASH = `0x${'ab'.repeat(32)}`;

function fakeChain(operator: Address, signer = SIGNER) {
  const reads: Array<Record<string, unknown>> = [];
  const writes: Array<Record<string, unknown>> = [];
  const receipts: Array<{ hash: string }> = [];
  const order: string[] = [];
  const state = { operator };
  const chain = {
    chainId: 56,
    rpcUrl: 'http://127.0.0.1:8546',
    registryAddress: REGISTRY,
    account: { address: signer },
    kernel: KERNEL_V3_3_ADDRESSES,
    publicClient: {
      readContract: async (args: Record<string, unknown>) => {
        reads.push(args);
        order.push('read');
        return state.operator;
      },
      waitForTransactionReceipt: async (args: { hash: string }) => {
        receipts.push(args);
        order.push('receipt');
      },
    } as unknown as PublicClient,
    wallet: {
      writeContract: async (args: Record<string, unknown>) => {
        writes.push(args);
        order.push('write');
        return TX_HASH;
      },
    } as unknown as WalletClient,
  } as ChainConfig;
  return { chain, state, reads, writes, receipts, order };
}

test('enrollOnchain reads the operator before enrolling the smart account and awaiting its receipt', async () => {
  const { chain, reads, writes, receipts, order } = fakeChain(SIGNER);

  await enrollOnchain(SMART_ACCOUNT, 7, chain);

  assert.deepEqual(order, ['read', 'write', 'receipt']);
  assert.equal(reads[0]?.address, REGISTRY);
  assert.equal(reads[0]?.functionName, 'operator');
  assert.equal(writes[0]?.address, REGISTRY);
  assert.equal(writes[0]?.account, chain.account);
  assert.equal(writes[0]?.functionName, 'enroll');
  assert.deepEqual(writes[0]?.args, [SMART_ACCOUNT, 7n]);
  assert.deepEqual(receipts, [{ hash: TX_HASH }]);

  // A role change between the read and execution can still revert; viem must recognize its error.
  const abi = writes[0]?.abi as Abi;
  const decoded = decodeErrorResult({ abi, data: toFunctionSelector('Unauthorized()') });
  assert.equal(decoded.errorName, 'Unauthorized');
  assert.equal(decoded.args, undefined);
});

test('enrollOnchain compares addresses without requiring the same letter case', async () => {
  const { chain, writes } = fakeChain(SIGNER.toLowerCase() as Address);

  await enrollOnchain(SMART_ACCOUNT, 7, chain);

  assert.equal(writes.length, 1);
});

for (const [name, registryOperator, signer] of [
  ['signer is not the operator', OWNER, SIGNER],
  ['signer is the owner, not the operator', SIGNER, OWNER],
  ['operator is unset or revoked', zeroAddress, SIGNER],
] as const) {
  test(`enrollOnchain rejects before sending a transaction when ${name}`, async () => {
    const { chain, writes, receipts, order } = fakeChain(registryOperator, signer);

    await assert.rejects(() => enrollOnchain(SMART_ACCOUNT, 7, chain), (error: Error) => {
      assert.match(error.message, /enroll operator mismatch/);
      assert.ok(error.message.includes(signer), 'the error must identify the signer');
      assert.ok(error.message.includes(registryOperator), 'the error must identify the on-chain operator');
      assert.match(error.message, /需由 owner 呼叫 setOperator/);
      return true;
    });
    assert.deepEqual(order, ['read']);
    assert.equal(writes.length, 0);
    assert.equal(receipts.length, 0);
  });
}

test('enrollOnchain re-reads the operator when a cached chain is used after revocation', async () => {
  const { chain, state, reads, writes } = fakeChain(SIGNER);
  await enrollOnchain(SMART_ACCOUNT, 7, chain);
  state.operator = zeroAddress;

  await assert.rejects(() => enrollOnchain(SMART_ACCOUNT, 7, chain), /需由 owner 呼叫 setOperator/);

  assert.equal(reads.length, 2);
  assert.equal(writes.length, 1, 'revocation must block the second transaction');
});

test('enrollOnchain does not submit a transaction when the operator read fails', async () => {
  const { chain, writes, receipts } = fakeChain(SIGNER);
  const failure = new Error('operator read unavailable');
  chain.publicClient = {
    ...chain.publicClient,
    readContract: async () => { throw failure; },
  } as PublicClient;

  await assert.rejects(() => enrollOnchain(SMART_ACCOUNT, 7, chain), (error) => error === failure);

  assert.equal(writes.length, 0);
  assert.equal(receipts.length, 0);
});
