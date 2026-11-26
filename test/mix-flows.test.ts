import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicClient, custom, encodeAbiParameters, encodeEventTopics, erc20Abi, toHex, parseAbi } from 'viem';
import { MIX_FLOW_LOG_CHUNK, MIX_FLOW_LOG_CONCURRENCY, mixFlowDirection, readMixFlows, verifyMixBlock } from '../src/mix-flows.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
const m = { id: '1', owner: T.roles.keeper, account: T.roles.operator };
const hash = toHex(178n, { size: 32 }), blockHash = toHex(16n, { size: 32 });
test('mix snapshot checks its canonical block after reading prices and principal, including RPC failure and missing header', async () => {
  await verifyMixBlock(blockHash, async () => blockHash);
  for (const value of [null, hash]) await assert.rejects(verifyMixBlock(blockHash, async () => value), /目前無法確認/);
  await assert.rejects(verifyMixBlock(null, async () => blockHash), /目前無法確認/);
  await assert.rejects(verifyMixBlock(blockHash, async () => { throw new Error('private RPC credential'); }), e => e instanceof Error && !e.message.includes('credential'));
});
test('mix principal classifies external USDT once; executor proceeds/refunds and self transfers are not new deposits', () => {
  assert.equal(mixFlowDirection(m.owner, m.account, m), 'deposit');
  assert.equal(mixFlowDirection(m.account, m.owner, m), 'withdrawal');
  assert.equal(mixFlowDirection(T.contracts.executor, m.account, m), null);
  assert.equal(mixFlowDirection(m.account, T.contracts.executor, m), null);
  assert.equal(mixFlowDirection(m.account, m.account, m), null);
  assert.equal(mixFlowDirection(m.account, T.roles.feeRecipient, m), 'withdrawal', 'self-funded third-party transfer is external');
});

test('in-kind transfer of 30% NVDA is oracle-valued principal withdrawal and does not trigger a loss', async () => {
  const { mixPerformance } = await import('../src/mix-domain.js');
  const asset = T.assets.NVDAB.token;
  const log = { address: asset, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: m.account, to: m.owner } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [30n * 10n ** 18n]), blockNumber: '0x10', blockHash, transactionHash: hash,
    transactionIndex: '0x0', logIndex: '0x0', removed: false };
  const client = createPublicClient({ transport: custom({ request: async ({ method }) => {
    if (method === 'eth_chainId') return '0x61';
    if (method === 'eth_getLogs') return [log];
    if (method === 'eth_getBlockByNumber') return { number: '0x10', hash: blockHash, timestamp: '0x64', transactions: [] };
    if (method === 'eth_getTransactionReceipt') return { transactionHash: hash, transactionIndex: '0x0', blockNumber: '0x10', blockHash,
      status: '0x1', from: m.owner, to: asset, gasUsed: '0x1', cumulativeGasUsed: '0x1', effectiveGasPrice: '0x1', type: '0x2',
      contractAddress: null, logs: [log], logsBloom: '0x' + '0'.repeat(512) };
    throw new Error('unexpected RPC method');
  } }, { retryCount: 0 }) });
  const options = { assets: [asset], price: async () => ({ decimals: 18, priceUsdE8: 100000000n, source: 'fixture:oracle', at: new Date(100000) }) };
  const flows = await readMixFlows(client, m, 16n, 16n, options);
  assert.equal(flows.length, 1); assert.equal(flows[0]?.kind, 'withdrawal'); assert.equal(flows[0]?.amountRaw, (30n * 10n ** 18n).toString());
  const perf = mixPerformance(70n * 10n ** 18n, 100n * 10n ** 18n, BigInt(flows[0]?.amountRaw ?? '0'), { takeProfitBps: null, stopLossBps: 2000 });
  assert.equal(perf.trigger, null); assert.equal(perf.returnBps, '0');
  await assert.rejects(readMixFlows(client, m, 16n, 16n, { ...options, price: async () => { throw new Error('private oracle timeout'); } }),
    e => e instanceof Error && !e.message.includes('private'));
  await assert.rejects(readMixFlows(client, m, 16n, 16n, { ...options, price: async () => ({ ...await options.price(), priceUsdE8: 0n }) }));
});

test('canonical fee top-up is excluded exactly once while an identical external transfer remains principal', async () => {
  const abi = parseAbi(['event MinFeeCharged(address indexed account,uint256 notional,uint256 due,uint256 charged)']);
  const token = (index: number) => ({ address: T.contracts.usdt, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: m.account, to: T.roles.feeRecipient } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [100n]), blockNumber: '0x10', blockHash, transactionHash: hash,
    transactionIndex: '0x0', logIndex: toHex(index), removed: false });
  const charge = { ...token(2), address: T.contracts.executor, topics: encodeEventTopics({ abi, eventName: 'MinFeeCharged', args: { account: m.account } }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [100000n, 100n, 100n]) };
  const logs = [token(0), token(1), charge];
  const client = createPublicClient({ transport: custom({ request: async ({ method }) => {
    if (method === 'eth_chainId') return '0x61';
    if (method === 'eth_getLogs') return logs.slice(0, 2);
    if (method === 'eth_getBlockByNumber') return { number: '0x10', hash: blockHash, timestamp: '0x64', transactions: [] };
    if (method === 'eth_call') return encodeAbiParameters([{ type: 'address' }], [T.roles.feeRecipient]);
    if (method === 'eth_getTransactionReceipt') return { transactionHash: hash, transactionIndex: '0x0', blockNumber: '0x10', blockHash,
      status: '0x1', from: m.owner, to: T.contracts.executor, gasUsed: '0x1', cumulativeGasUsed: '0x1', effectiveGasPrice: '0x1', type: '0x2',
      contractAddress: null, logs, logsBloom: '0x' + '0'.repeat(512) };
    throw new Error('unexpected method');
  } }, { retryCount: 0 }) });
  const flows = await readMixFlows(client, m, 16n, 16n);
  assert.equal(flows.length, 1); assert.equal(flows[0]?.logIndex, 0); assert.equal(flows[0]?.kind, 'withdrawal');
});
test('mix flow reader rejects missing, failed, reorged and timed-out RPC proof; duplicate range observations never multiply principal', async () => {
  const state = { fail: false, removed: false, amount: 100n, canonical: blockHash, success: true, chain: 97 };
  const log = () => ({ address: T.contracts.usdt, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: m.owner, to: m.account } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [state.amount]), blockNumber: '0x10', blockHash, transactionHash: hash,
    transactionIndex: '0x0', logIndex: '0x0', removed: state.removed });
  const client = createPublicClient({ transport: custom({ request: async ({ method }) => {
    if (state.fail) throw new Error('SECRET_RPC_CREDENTIAL');
    if (method === 'eth_chainId') return toHex(state.chain);
    if (method === 'eth_getLogs') return [log()];
    if (method === 'eth_getBlockByNumber') return { number: '0x10', hash: state.canonical, timestamp: '0x64', transactions: [] };
    if (method === 'eth_getTransactionReceipt') return { transactionHash: hash, transactionIndex: '0x0', blockNumber: '0x10', blockHash,
      status: state.success ? '0x1' : '0x0', from: m.owner, to: T.contracts.usdt, gasUsed: '0x1', cumulativeGasUsed: '0x1',
      effectiveGasPrice: '0x1', type: '0x2', contractAddress: null, logs: [log()], logsBloom: '0x' + '0'.repeat(512) };
    throw new Error('unexpected RPC method');
  } }, { retryCount: 0 }) });
  const flows = await readMixFlows(client, m, 16n, 16n);
  assert.equal(flows.length, 1); assert.equal(flows[0]?.amountRaw, '100');
  state.amount = 0n; assert.equal((await readMixFlows(client, m, 16n, 16n)).length, 0); state.amount = 100n;
  state.removed = true; await assert.rejects(readMixFlows(client, m, 16n, 16n)); state.removed = false;
  state.success = false; await assert.rejects(readMixFlows(client, m, 16n, 16n)); state.success = true;
  state.canonical = toHex(17n, { size: 32 }); await assert.rejects(readMixFlows(client, m, 16n, 16n)); state.canonical = blockHash;
  state.chain = 56; await assert.rejects(readMixFlows(client, m, 16n, 16n)); state.chain = 97;
  state.fail = true;
  await assert.rejects(readMixFlows(client, m, 16n, 16n), e => e instanceof Error && !e.message.includes('SECRET_RPC_CREDENTIAL'));
});

test('cash-flow log ranges: at most 5,000 blocks each, every block read once, a few ranges in flight; the flows are the same, one by one, as reading range by range; any failed range fails the read', async () => {
  assert.equal(MIX_FLOW_LOG_CHUNK, 5_000n); assert.equal(MIX_FLOW_LOG_CONCURRENCY, 3);
  // Deposits and withdrawals spread over 23,000 blocks, two of them on range borders (5,000 | 5,001) and two in one block.
  const moves = [[1n, 'in', 5n], [4_999n, 'out', 2n], [5_000n, 'in', 7n], [5_001n, 'in', 11n], [12_345n, 'out', 3n], [12_345n, 'in', 13n], [20_000n, 'in', 17n], [23_000n, 'out', 1n]] as const;
  const logOf = ([block, way, amount]: (typeof moves)[number], index: number) => ({ address: T.contracts.usdt,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: way === 'in' ? { from: m.owner, to: m.account } : { from: m.account, to: m.owner } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [amount]), blockNumber: toHex(block), blockHash: toHex(block + 1_000_000n, { size: 32 }),
    transactionHash: toHex(BigInt(index) + 500n, { size: 32 }), transactionIndex: '0x0', logIndex: toHex(index), removed: false });
  const all = moves.map(logOf);
  const state = { ranges: [] as [bigint, bigint][], inFlight: 0, most: 0, failAt: null as bigint | null };
  const client = createPublicClient({ transport: custom({ request: async ({ method, params }) => {
    if (method === 'eth_chainId') return '0x61';
    if (method === 'eth_getLogs') {
      const filter = (params as { fromBlock: string; toBlock: string; topics: (string | null)[] }[])[0]!;
      const from = BigInt(filter.fromBlock), to = BigInt(filter.toBlock);
      state.ranges.push([from, to]); state.inFlight += 1; state.most = Math.max(state.most, state.inFlight);
      try { await new Promise(resolve => setTimeout(resolve, 2)); } finally { state.inFlight -= 1; }
      if (state.failAt !== null && from <= state.failAt && state.failAt <= to) throw new Error('fixture: exceed maximum block range 5000');
      const account = `0x${m.account.slice(2).toLowerCase().padStart(64, '0')}`;
      return all.filter(log => BigInt(log.blockNumber) >= from && BigInt(log.blockNumber) <= to &&
        (filter.topics[1] === null || filter.topics[1] === undefined ? log.topics[2] === account : log.topics[1] === account));
    }
    if (method === 'eth_getBlockByNumber') { const n = BigInt(String((params as unknown[])[0])); return { number: toHex(n), hash: toHex(n + 1_000_000n, { size: 32 }), timestamp: toHex(n), transactions: [] }; }
    if (method === 'eth_getTransactionReceipt') {
      const log = all.find(entry => entry.transactionHash === (params as string[])[0])!;
      return { transactionHash: log.transactionHash, transactionIndex: '0x0', blockNumber: log.blockNumber, blockHash: log.blockHash, status: '0x1', from: m.owner, to: T.contracts.usdt,
        gasUsed: '0x1', cumulativeGasUsed: '0x1', effectiveGasPrice: '0x1', type: '0x2', contractAddress: null, logs: [log], logsBloom: '0x' + '0'.repeat(512) };
    }
    throw new Error(`unexpected RPC method ${method}`);
  } }, { retryCount: 0 }) });
  const key = (flows: Awaited<ReturnType<typeof readMixFlows>>) => flows.map(f => [f.kind, f.blockNumber, f.logIndex, f.txHash, f.blockHash, f.amountRaw, f.quantityRaw, f.asset, f.at.getTime()].join(':')).sort();

  const whole = await readMixFlows(client, m, 1n, 23_000n);
  assert.equal(whole.length, 8);
  // Each range is asked twice (transfers in, transfers out); none is wider than the cap; together they cover every block once.
  const asked = [...new Set(state.ranges.map(([from, to]) => `${from}-${to}`))];
  assert.deepEqual(asked.sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0])), ['1-5000', '5001-10000', '10001-15000', '15001-20000', '20001-23000']);
  assert.equal(state.ranges.length, 10);
  assert.ok(state.ranges.every(([from, to]) => to - from + 1n <= MIX_FLOW_LOG_CHUNK));
  assert.ok(state.most > 2 && state.most <= 2 * MIX_FLOW_LOG_CONCURRENCY, `requests in flight at once: ${state.most}`);
  // The same flows as reading the span in pieces, whatever the pieces (the batches of a catching-up scan), one by one.
  for (const cuts of [[23_000n], [4_999n, 5_000n, 5_001n, 23_000n], [2_000n, 12_344n, 12_345n, 19_999n, 23_000n], [7n, 6_007n, 23_000n]]) {
    const pieces: Awaited<ReturnType<typeof readMixFlows>> = [];
    let from = 1n;
    for (const to of cuts) { pieces.push(...await readMixFlows(client, m, from, to)); from = to + 1n; }
    assert.deepEqual(key(pieces), key(whole), `pieces ending at ${cuts.join(', ')}`);
  }
  // One range that cannot be read fails the whole read: nothing is returned for the ranges that did answer.
  state.failAt = 16_000n;
  await assert.rejects(readMixFlows(client, m, 1n, 23_000n), /目前無法確認/);
  state.failAt = null;
  assert.deepEqual(key(await readMixFlows(client, m, 1n, 23_000n)), key(whole));
});

test('saved cash-flow headers: a finalized block is read once per client, every other block on every call; same hashes as reading one by one', async () => {
  const { savedFlowHeaders } = await import('../src/mix-flows.js');
  const { bscTestnet } = await import('viem/chains');
  const hashOf = (n: bigint, salt = 0n) => toHex(n * 1000n + salt, { size: 32 });
  const node = (bound: boolean) => {
    const state = { finalized: 20n as bigint | null, salt: new Map<bigint, bigint>(), reads: [] as string[], inFlight: 0, most: 0, fail: null as bigint | null };
    const client = createPublicClient({ ...(bound ? { chain: bscTestnet } : {}), transport: custom({ request: async ({ method, params }) => {
      assert.equal(method, 'eth_getBlockByNumber');
      const tag = String((params as unknown[])[0]);
      state.reads.push(tag === 'finalized' ? tag : BigInt(tag).toString());
      state.inFlight += 1; state.most = Math.max(state.most, state.inFlight);
      try { await new Promise(resolve => setTimeout(resolve, 2)); } finally { state.inFlight -= 1; }
      if (tag === 'finalized') { if (state.finalized === null) throw new Error('finalized tag not supported'); return { number: toHex(state.finalized), hash: hashOf(state.finalized), timestamp: '0x64', transactions: [] }; }
      const n = BigInt(tag);
      if (state.fail === n) throw new Error('fixture RPC unavailable');
      return { number: toHex(n), hash: hashOf(n, state.salt.get(n) ?? 0n), timestamp: '0x64', transactions: [] };
    } }, { retryCount: 0 }) });
    return { state, client };
  };
  const blocks = ['10', '20', '30'];
  const expected = (salt: Record<string, bigint> = {}) => new Map(blocks.map(n => [n, hashOf(BigInt(n), salt[n] ?? 0n)]));

  // A client bound to a chain (production): 10 and 20 are finalized, 30 is not.
  let { state, client } = node(true);
  assert.deepEqual(await savedFlowHeaders(client, blocks), expected());
  assert.deepEqual([...state.reads].sort(), ['10', '20', '30', 'finalized']);
  state.reads = [];
  state.salt.set(30n, 7n); // the block above the finalized one was replaced: seen on the next call
  assert.deepEqual(await savedFlowHeaders(client, blocks), expected({ '30': 7n }));
  assert.deepEqual([...state.reads].sort(), ['30', 'finalized'], 'finalized headers are not read again');
  state.finalized = 40n; state.reads = [];
  await savedFlowHeaders(client, blocks);
  state.reads = [];
  assert.deepEqual(await savedFlowHeaders(client, blocks), expected({ '30': 7n }));
  assert.deepEqual(state.reads, [], 'everything is finalized now: no request at all');
  // A header that cannot be read fails the call, as before (a remembered one needs no read).
  state.fail = 50n;
  await assert.rejects(savedFlowHeaders(client, ['10', '50']), /fixture RPC unavailable/);

  // Another client never sees what the first one remembered.
  ({ state, client } = node(true));
  state.salt.set(10n, 3n);
  assert.equal((await savedFlowHeaders(client, ['10'])).get('10'), hashOf(10n, 3n));

  // A node that cannot say what is finalized: nothing is remembered, every block is read on every call.
  ({ state, client } = node(true));
  state.finalized = null;
  await savedFlowHeaders(client, blocks); state.reads = []; state.salt.set(10n, 5n);
  assert.deepEqual(await savedFlowHeaders(client, blocks), expected({ '10': 5n }));
  assert.deepEqual([...state.reads].sort(), ['10', '20', '30', 'finalized']);

  // A client without a chain (a test fixture, which may rewrite any block): never remembered, never asked for `finalized`.
  ({ state, client } = node(false));
  await savedFlowHeaders(client, blocks); state.reads = []; state.salt.set(10n, 9n);
  assert.deepEqual(await savedFlowHeaders(client, blocks), expected({ '10': 9n }));
  assert.deepEqual([...state.reads].sort(), ['10', '20', '30']);

  // Many flows: a few headers at a time (12 plus the `finalized` read), not all at once and not one by one.
  ({ state, client } = node(true));
  const many = Array.from({ length: 40 }, (_, i) => String(100 + i));
  assert.equal((await savedFlowHeaders(client, many)).size, 40);
  assert.ok(state.most > 1 && state.most <= 13, `in flight at once: ${state.most}`);
});
