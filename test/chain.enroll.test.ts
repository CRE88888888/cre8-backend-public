import { enrollmentApprovalHash } from '../src/registry-versioning.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeErrorResult, encodeErrorResult, getAddress, toFunctionSelector, zeroAddress } from 'viem';
import type { Abi, Account, Address, PublicClient, WalletClient } from 'viem';
import { KERNEL_V3_3_ADDRESSES } from '../src/addresses.js';
import { a10ErrorMessage, EXECUTOR_BUY_ABI, enrollOnchain, EXECUTOR_PAUSE_ABI, pauseSources, REGISTRY_ABI } from '../src/chain.js';
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
  const state = {
    operator, enrolled: false, strategyId: 0n, version: 0, paused: false,
    approved: true, configHash: `0x${'11'.repeat(32)}` as `0x${string}`, activeVersion: 1, receiptStatus: 'success',
  };
  const chain = {
    chainId: 56,
    rpcUrl: 'http://127.0.0.1:8546',
    registryAddress: REGISTRY,
    account: { address: signer, type: 'json-rpc' } satisfies Account,
    kernel: KERNEL_V3_3_ADDRESSES,
    publicClient: {
      getBlockNumber: async () => 100n,
      readContract: async (args: Record<string, unknown>) => {
        reads.push(args);
        order.push(String(args.functionName));
        switch (args.functionName) {
          case 'operator': return state.operator;
          case 'activeVersion': return state.activeVersion;
          case 'version': return { configHash: state.configHash };
          case 'enrollmentApproval': return state.approved ? enrollmentApprovalHash(7n, state.activeVersion, state.configHash) : `0x${'00'.repeat(32)}`;
          case 'isEnrolled': return state.enrolled;
          case 'enrollments': return [state.strategyId, state.version, state.paused];
          default: throw new Error('unexpected contract read');
        }
      },
      waitForTransactionReceipt: async (args: { hash: string }) => {
        receipts.push(args);
        order.push('receipt');
        return { status: state.receiptStatus, blockNumber: 101n };
      },
    } as unknown as PublicClient,
    wallet: {
      writeContract: async (args: Record<string, unknown>) => {
        writes.push(args);
        order.push('write');
        state.enrolled = true;
        state.strategyId = 7n;
        state.version = state.activeVersion;
        return TX_HASH;
      },
    } as unknown as WalletClient,
  } as ChainConfig;
  return { chain, state, reads, writes, receipts, order };
}

test('enrollOnchain reads the operator before enrolling the smart account and awaiting its receipt', async () => {
  const { chain, reads, writes, receipts, order } = fakeChain(SIGNER);

  assert.equal(await enrollOnchain(SMART_ACCOUNT, 7, chain), 1);

  assert.deepEqual(order, ['isEnrolled', 'enrollments', 'operator', 'activeVersion', 'version', 'enrollmentApproval', 'write', 'receipt', 'isEnrolled', 'enrollments']);
  assert.equal(reads[0]?.address, REGISTRY);
  assert.equal(reads[2]?.functionName, 'operator');
  assert.equal(reads[0]?.blockNumber, 100n);
  assert.equal(reads[1]?.blockNumber, 100n);
  assert.equal(writes[0]?.address, REGISTRY);
  assert.equal(writes[0]?.account, chain.account);
  assert.equal(writes[0]?.functionName, 'enroll');
  assert.deepEqual(writes[0]?.args, [SMART_ACCOUNT, 7n, 1]);
  assert.deepEqual(receipts, [{ hash: TX_HASH, timeout: 30_000 }]);

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

test('#124 missing/revoked owner consent and no effective version never submit enrollment', async () => {
  for (const activeVersion of [0, 1, 65535]) {
    const { chain, state, writes } = fakeChain(SIGNER);
    state.activeVersion = activeVersion; state.approved = false;
    await assert.rejects(enrollOnchain(SMART_ACCOUNT, 7, chain), (error: unknown) => error instanceof Error &&
      error.message.includes(activeVersion === 0 ? 'no effective version' : 'sudo'));
    assert.equal(writes.length, 0);
  }
});

for (const failedFunction of ['activeVersion', 'version', 'enrollmentApproval']) {
  test(`#124 RPC failure during ${failedFunction} cannot authorize enrollment`, async () => {
    const { chain, writes } = fakeChain(SIGNER);
    const read = chain.publicClient.readContract;
    chain.publicClient.readContract = async args => {
      if (args.functionName === failedFunction) throw new Error('sensitive upstream credential');
      return read(args);
    };
    await assert.rejects(enrollOnchain(SMART_ACCOUNT, 7, chain), (error: unknown) => error instanceof Error && !error.message.includes('sensitive'));
    assert.equal(writes.length, 0);
  });
}

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
    assert.deepEqual(order, ['isEnrolled', 'enrollments', 'operator']);
    assert.equal(writes.length, 0);
    assert.equal(receipts.length, 0);
  });
}

test('enrollOnchain re-reads the operator when a cached chain is used after revocation', async () => {
  const { chain, state, reads, writes } = fakeChain(SIGNER);
  await enrollOnchain(SMART_ACCOUNT, 7, chain);
  state.operator = zeroAddress;
  state.enrolled = false;
  state.strategyId = 0n;
  state.version = 0;

  await assert.rejects(() => enrollOnchain(SMART_ACCOUNT, 7, chain), /需由 owner 呼叫 setOperator/);

  assert.equal(reads.filter((read) => read.functionName === 'operator').length, 2);
  assert.equal(writes.length, 1, 'revocation must block the second transaction');
});

for (const version of [1, 65535]) {
  test(`same-strategy retry preserves pinned v${version} and every pause without a transaction`, async () => {
    const { chain, state, writes, receipts } = fakeChain(zeroAddress);
    Object.assign(state, { enrolled: true, strategyId: 7n, version, paused: true, activeVersion: 2 });
    assert.equal(await enrollOnchain(SMART_ACCOUNT, 7, chain), version);
    assert.equal(state.paused, true);
    assert.equal(writes.length, 0);
    assert.equal(receipts.length, 0);
  });
}

test('different strategy is rejected before sending or clearing its pause', async () => {
  const { chain, state, writes } = fakeChain(SIGNER);
  Object.assign(state, { enrolled: true, strategyId: 8n, version: 1, paused: true });
  await assert.rejects(() => enrollOnchain(SMART_ACCOUNT, 7, chain), /AlreadyEnrolled.*策略.*使用者/);
  assert.equal(writes.length, 0);
  assert.equal(state.paused, true);
});

for (const enrolled of [true, false]) {
  test(`inconsistent enrollment data (isEnrolled=${enrolled}) fails closed`, async () => {
    const { chain, state, writes } = fakeChain(SIGNER);
    Object.assign(state, { enrolled, strategyId: enrolled ? 7n : 9n, version: enrolled ? 0 : 1 });
    await assert.rejects(() => enrollOnchain(SMART_ACCOUNT, 7, chain), /enrollment.*不一致/);
    assert.equal(writes.length, 0);
  });
}

test('a reverted enrollment receipt never reports success', async () => {
  const { chain, state } = fakeChain(SIGNER);
  state.receiptStatus = 'reverted';
  await assert.rejects(() => enrollOnchain(SMART_ACCOUNT, 7, chain), /enroll.*reverted/);
});

for (const version of [-1, 0, 65536, Number.NaN]) {
  test(`invalid pinned version ${version} never causes another enroll transaction`, async () => {
    const { chain, state, writes } = fakeChain(SIGNER);
    Object.assign(state, { enrolled: true, strategyId: 7n, version });
    await assert.rejects(() => enrollOnchain(SMART_ACCOUNT, 7, chain), /enrollment.*不一致/);
    assert.equal(writes.length, 0);
  });
}

for (const failedFunction of ['isEnrolled', 'enrollments']) {
  test(`RPC timeout in ${failedFunction} fails closed before a write`, async () => {
    const { chain, writes } = fakeChain(SIGNER);
    const read = chain.publicClient.readContract;
    chain.publicClient.readContract = async (args) => {
      if (args.functionName === failedFunction) throw new Error('RPC timeout');
      return read(args);
    };
    await assert.rejects(() => enrollOnchain(SMART_ACCOUNT, 7, chain), /enroll 無法完成確認.*RPC/);
    assert.equal(writes.length, 0);
  });
}

test('AlreadyEnrolled racing with the pre-read is decoded without logging RPC secrets', async () => {
  const { chain } = fakeChain(SIGNER);
  chain.wallet.writeContract = async () => {
    throw new Error('sensitive RPC credentials', { cause: {
      data: encodeErrorResult({ abi: REGISTRY_ABI, errorName: 'AlreadyEnrolled', args: [SMART_ACCOUNT] }),
    } });
  };
  await assert.rejects(() => enrollOnchain(SMART_ACCOUNT, 7, chain), (error: Error) => {
    assert.match(error.message, /AlreadyEnrolled.*使用者.*operator/);
    assert.ok(!error.message.includes('sensitive'));
    return true;
  });
});

test('A10 errors decode raw nested RPC data and viem structured data, unknown errors remain unknown', () => {
  const paused = encodeErrorResult({ abi: EXECUTOR_PAUSE_ABI, errorName: 'ExecutorPaused' });
  assert.match(a10ErrorMessage({ cause: { cause: { data: paused } } }) ?? '', /ExecutorPaused.*Safe.*含賣出/);
  assert.match(a10ErrorMessage({ data: { errorName: 'AlreadyEnrolled' } }) ?? '', /AlreadyEnrolled.*使用者/);
  assert.equal(a10ErrorMessage(new Error('sensitive RPC credentials')), null);
  assert.equal(a10ErrorMessage({ data: '0xdeadbeef' }), null);
});

test('pause source bits include every combination and reject missing, unknown or fractional values', () => {
  assert.deepEqual(pauseSources(0), []);
  assert.deepEqual(pauseSources(7), ['safe', 'operator', 'account']);
  for (const invalid of [-1, 8, 255, 1.5, Number.NaN]) {
    assert.throws(() => pauseSources(invalid), /pauseFlags/);
  }
});

test('enrollOnchain does not submit a transaction when the operator read fails', async () => {
  const { chain, writes, receipts } = fakeChain(SIGNER);
  const failure = new Error('operator read unavailable');
  const read = chain.publicClient.readContract;
  chain.publicClient.readContract = async (args) => {
    if (args.functionName === 'operator') throw failure;
    return read(args);
  };

  await assert.rejects(() => enrollOnchain(SMART_ACCOUNT, 7, chain), /enroll 無法完成確認.*RPC/);

  assert.equal(writes.length, 0);
  assert.equal(receipts.length, 0);
});

test('receipt timeout returns a safe error and retry observes the successful enrollment without another write', async () => {
  const { chain, writes } = fakeChain(SIGNER);
  chain.publicClient.waitForTransactionReceipt = async () => { throw new Error('sensitive RPC credentials'); };
  await assert.rejects(() => enrollOnchain(SMART_ACCOUNT, 7, chain), (error: Error) => {
    assert.match(error.message, /enroll 無法完成確認.*交易回執/);
    assert.ok(!error.message.includes('sensitive'));
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(await enrollOnchain(SMART_ACCOUNT, 7, chain), 1);
  assert.equal(writes.length, 1);
});

test('a successful receipt with missing enrollment data never reports success', async () => {
  const { chain, state } = fakeChain(SIGNER);
  const wait = chain.publicClient.waitForTransactionReceipt;
  chain.publicClient.waitForTransactionReceipt = async (args) => {
    const receipt = await wait(args);
    Object.assign(state, { enrolled: false, strategyId: 0n, version: 0 });
    return receipt;
  };
  await assert.rejects(() => enrollOnchain(SMART_ACCOUNT, 7, chain), /enrollment 缺漏/);
});

test('A10 buy errors decode actual ABI selectors and structured errors without RPC secrets', () => {
  const cases = [
    encodeErrorResult({ abi: EXECUTOR_BUY_ABI, errorName: 'BuyLimitExceeded', args: [101n, 100n] }),
    encodeErrorResult({ abi: EXECUTOR_BUY_ABI, errorName: 'NotNumeraireRoute', args: [SMART_ACCOUNT, SIGNER] }),
  ];
  for (const [index, data] of cases.entries()) {
    const message = a10ErrorMessage(new Error('sensitive-token', { cause: { data } }));
    assert.match(message ?? '', index === 0 ? /BuyLimitExceeded.*買入額度/ : /NotNumeraireRoute.*numeraire/);
    assert.ok(!message?.includes('sensitive-token'));
  }
  assert.match(a10ErrorMessage({ data: { errorName: 'BuyLimitExceeded' } }) ?? '', /BuyLimitExceeded/);
});
