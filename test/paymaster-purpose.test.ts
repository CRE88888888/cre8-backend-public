import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult, getAddress, isHex, parseAbi } from 'viem';
import { closePool } from '../src/db.js';
import { createPaymasterService } from '../src/paymaster.js';
import type { Reservation } from '../src/paymaster.js';
import { EXECUTOR_ABI } from '../src/chain.js';
import { config, kernelCall, operation, OWNER, EXECUTOR, USDT, SENDER, NOW } from './fixtures/paymaster.js';

after(closePool);
const ASSET = '0x1000000000000000000000000000000000000006';
const ABI = parseAbi(['function oracle() view returns(address)', 'function numeraire() view returns(address)',
  'function decimals() view returns(uint8)', 'function previewSwap(address,address,uint256) view returns(uint256,uint256)',
  'function enrollments(address) view returns(uint256,uint16,bool)',
  'function version(uint256,uint16) view returns((address[] assets,uint16[] weightsBps,bytes32 scheduleHash,uint64 activeAt))',
  'function balanceOf(address) view returns(uint256)']);

test('#75 public sponsorship derives setup/full exit/ordinary from canonical calls and complete balances; RPC failure never authorizes', async () => {
  let cash = 100n;
  let asset = 0n;
  let fail = false;
  const reservations: Reservation[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += String(chunk);
    const rpc: { id: number; method: string; params: unknown[] } = JSON.parse(body);
    let result = '0x';
    if (rpc.method === 'eth_blockNumber') result = '0x7b';
    else {
      assert.equal(rpc.method, 'eth_call');
      const call = rpc.params[0]; assert.ok(typeof call === 'object' && call !== null);
      const data: unknown = Reflect.get(call, 'data'); const to: unknown = Reflect.get(call, 'to');
      assert.ok(typeof data === 'string' && isHex(data));
      const decoded = decodeFunctionData({ abi: ABI, data });
      switch (decoded.functionName) {
        case 'oracle': case 'numeraire': result = encodeFunctionResult({ abi: ABI, functionName: decoded.functionName, result: USDT }); break;
        case 'decimals': result = encodeFunctionResult({ abi: ABI, functionName: 'decimals', result: 18 }); break;
        case 'previewSwap': result = encodeFunctionResult({ abi: ABI, functionName: 'previewSwap', result: [600n * 10n ** 18n, 590n * 10n ** 18n] }); break;
        case 'balanceOf': result = encodeFunctionResult({ abi: ABI, functionName: 'balanceOf', result: to === USDT ? cash : asset }); break;
        case 'enrollments': result = encodeFunctionResult({ abi: ABI, functionName: 'enrollments', result: [1n, 1, false] }); break;
        case 'version': result = encodeFunctionResult({ abi: ABI, functionName: 'version', result: { assets: [USDT, ASSET], weightsBps: [5000, 5000], scheduleHash: `0x${'0'.repeat(64)}`, activeAt: 1n } }); break;
      }
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(fail ? { jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'private RPC token' } } : { jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const service = createPaymasterService({ config: { ...config(), rpcUrl: `http://127.0.0.1:${address.port}` }, now: () => NOW,
    query: async (sql) => ({ rows: sql.includes('select address') ? [{ address: USDT }, { address: ASSET }] : [{ owner: OWNER, user_id: OWNER }] }),
    checkChain: async () => {}, reserve: async (r) => { reservations.push(r); } });
  const tokenAbi = parseAbi(['function transfer(address,uint256)', 'function approve(address,uint256)']);
  const transfer = (amount: bigint) => kernelCall(encodeFunctionData({ abi: tokenAbi, functionName: 'transfer', args: [getAddress(OWNER), amount] }), USDT);
  const sale = (amount: bigint) => kernelCall(encodeFunctionData({ abi: EXECUTOR_ABI, functionName: 'executeRebalance',
    args: [SENDER, [{ tokenIn: ASSET, tokenOut: USDT, amountIn: amount, amountOutMin: 1n, venue: ASSET, data: '0x' }], 1800000300n] }), EXECUTOR);
  try {
    for (const [data, held, expected] of [[transfer(cash), 0n, 'exit'], [transfer(cash - 1n), 0n, 'ordinary'], [transfer(cash), 10n, 'ordinary'], [sale(10n), 10n, 'exit'], [sale(9n), 10n, 'ordinary']] as const) {
      asset = held;
      await service.sponsor({ userOperation: operation({ callData: data }) }, OWNER);
      assert.equal(reservations.at(-1)?.budget.purpose, expected);
    }
    await service.sponsor({ userOperation: operation({ callData: kernelCall(encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [EXECUTOR, 100n] }), USDT) }) }, OWNER);
    assert.equal(reservations.at(-1)?.budget.purpose, 'setup');
    await assert.rejects(service.sponsor({ userOperation: operation({ callData: transfer(cash) }), purpose: 'exit' }, OWNER), /PAYMASTER_INVALID_OPERATION/);
    const before = reservations.length; fail = true;
    await assert.rejects(service.sponsor({ userOperation: operation({ callData: transfer(cash) }) }, OWNER), (error: unknown) => error instanceof Error && !error.message.includes('private RPC token'));
    assert.equal(reservations.length, before);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
