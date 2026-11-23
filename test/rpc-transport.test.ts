import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPublicClient } from 'viem';
import { isProviderFailure, resetRpcTransport, rpcTransport, RPC_BREAKER_MS, secondaryRpc } from '../src/rpc-transport.js';

/** Two local JSON-RPC nodes: `limit` answers like the 2026-11-23 provider ("Request exceeds defined limit"). */
async function node(behaviour: () => 'ok' | 'limit' | 'revert' | 'http429', head: bigint) {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += String(chunk); });
    req.on('end', () => {
      const body = JSON.parse(raw) as { id: number; method: string };
      calls.push(body.method);
      const mode = behaviour();
      const send = (status: number, payload: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
      if (mode === 'http429') { res.writeHead(429); res.end('Too Many Requests'); return; }
      if (mode === 'limit') return send(200, { jsonrpc: '2.0', id: body.id, error: { code: -32005, message: 'Request exceeds defined limit.' } });
      if (mode === 'revert' && body.method === 'eth_call') return send(200, { jsonrpc: '2.0', id: body.id, error: { code: 3, message: 'execution reverted', data: '0x' } });
      const result = body.method === 'eth_chainId' ? '0x61' : body.method === 'eth_blockNumber' ? `0x${head.toString(16)}` : body.method === 'eth_getBalance' ? '0x5' : '0x';
      send(200, { jsonrpc: '2.0', id: body.id, result });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, calls, stop: () => server.close() };
}

test('quota error on the primary fails over to the public node, opens the breaker for a minute, logs once', async () => {
  resetRpcTransport();
  let primaryMode: 'ok' | 'limit' | 'http429' = 'limit', t = 1_000_000;
  const p = await node(() => primaryMode, 100n), s = await node(() => 'ok', 99n), lines: string[] = [];
  try {
    const client = createPublicClient({ transport: rpcTransport('test', p.url, { retryCount: 0 }, { secondary: s.url, now: () => t, log: (l) => lines.push(l), preferPublic: false }) });
    const account = '0x00000000000000000000000000000000000000a1';
    assert.equal(await client.getBalance({ address: account }), 5n);
    assert.equal(await client.getBalance({ address: account }), 5n);
    assert.deepEqual(p.calls.filter(m => m === 'eth_getBalance').length, 1, 'breaker open: the limited primary is not asked again');
    assert.equal(s.calls.filter(m => m === 'eth_getBalance').length, 2);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /"msg":"rpc_failover".*"reason":"[^"]*exceeds defined limit/);
    assert.doesNotMatch(lines[0]!, /127\.0\.0\.1/, 'never logs the URL (it carries the provider key)');
    // Breaker closes after a minute; a healthy primary is used again.
    primaryMode = 'ok'; t += RPC_BREAKER_MS;
    assert.equal(await client.getBalance({ address: account }), 5n);
    assert.equal(p.calls.filter(m => m === 'eth_getBalance').length, 2);
    assert.equal(s.calls.filter(m => m === 'eth_getBalance').length, 2);
    // HTTP 429 also fails over.
    primaryMode = 'http429';
    assert.equal(await client.getBalance({ address: account }), 5n);
    assert.equal(s.calls.filter(m => m === 'eth_getBalance').length, 3);
  } finally { p.stop(); s.stop(); }
});

test('a revert is the request\'s fault: no failover; eth_chainId is cached; local and mainnet URLs get no secondary', async () => {
  resetRpcTransport();
  const p = await node(() => 'revert', 100n), s = await node(() => 'ok', 100n);
  try {
    const client = createPublicClient({ transport: rpcTransport('test', p.url, { retryCount: 0 }, { secondary: s.url, preferPublic: false }) });
    await assert.rejects(client.call({ to: '0x00000000000000000000000000000000000000a1', data: '0x12345678' }));
    assert.equal(s.calls.length, 0);
    await client.getChainId(); await client.getChainId();
    await createPublicClient({ transport: rpcTransport('test', p.url, {}, { secondary: s.url, preferPublic: false }) }).getChainId();
    assert.equal(p.calls.filter(m => m === 'eth_chainId').length, 1);
  } finally { p.stop(); s.stop(); }
  assert.equal(secondaryRpc('https://bsc-testnet.nodereal.io/v1/x', 97), 'https://bsc-testnet-rpc.publicnode.com');
  assert.equal(secondaryRpc('http://127.0.0.1:8545', 97), null);
  assert.equal(secondaryRpc('https://bsc-mainnet.nodereal.io/v1/x', 56), null);
  assert.equal(isProviderFailure(Object.assign(new Error('execution reverted'), { code: 3 })), false);
  assert.equal(isProviderFailure(Object.assign(new Error('x'), { code: -32005 })), true);
  const { PAID_FIRST_SOURCES } = await import('../src/rpc-transport.js');
  assert.ok(PAID_FIRST_SOURCES.has('paymaster') && PAID_FIRST_SOURCES.has('faucet') && !PAID_FIRST_SOURCES.has('strategy-earn') && !PAID_FIRST_SOURCES.has('operator'));
});

test('the scheduler reads from the public node first and uses the paid RPC only when the public node fails', async () => {
  resetRpcTransport();
  let publicMode: 'ok' | 'limit' = 'ok';
  const paid = await node(() => 'ok', 100n), pub = await node(() => publicMode, 100n);
  try {
    const lines: string[] = [];
    const client = createPublicClient({ transport: rpcTransport('scheduler', paid.url, { retryCount: 0 }, { secondary: pub.url, preferPublic: true, schedulerRole: true, log: (l) => lines.push(l) }) });
    const account = '0x00000000000000000000000000000000000000a1';
    await client.getBalance({ address: account });
    assert.equal(paid.calls.length, 0);
    // Public node rate-limits: a scheduler bulk read fails (round skipped) and never touches the paid RPC.
    publicMode = 'limit';
    await assert.rejects(client.getBalance({ address: account }));
    assert.equal(paid.calls.length, 0);
    assert.match(lines[0] ?? '', /rpc_failover_skipped/);
    // Transaction methods may still use the paid RPC.
    await client.request({ method: 'eth_getTransactionReceipt', params: [`0x${'11'.repeat(32)}` as `0x${string}`] }).catch(() => undefined);
    assert.equal(paid.calls.filter(m => m === 'eth_getTransactionReceipt').length, 1);
    // Outside the scheduler (API display reads), the paid fallback stays.
    const api = createPublicClient({ transport: rpcTransport('dca', paid.url, { retryCount: 0 }, { secondary: pub.url, preferPublic: true, schedulerRole: false, log: () => {} }) });
    await api.getBalance({ address: account });
    assert.equal(paid.calls.filter(m => m === 'eth_getBalance').length, 1);
  } finally { paid.stop(); pub.stop(); }
});
