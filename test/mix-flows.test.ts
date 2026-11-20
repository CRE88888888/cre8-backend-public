import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicClient, custom, encodeAbiParameters, encodeEventTopics, erc20Abi, toHex, parseAbi } from 'viem';
import { mixFlowDirection, readMixFlows, verifyMixBlock } from '../src/mix-flows.js';
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
