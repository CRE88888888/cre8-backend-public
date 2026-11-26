import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPublicClient } from 'viem';
import { ADDRESSLESS_LOGS_SKIP_MS, HEAD_CACHE_MS, isNodeGap, isProviderFailure, LANDED_FLOOR_MS, LANDED_WAIT_MS, landedFloor, noteLandedBlock, PUBLIC_RPCS_97, publicRpcs, resetRpcTransport, rpcTransport, RPC_BREAKER_MS, secondaryRpc } from '../src/rpc-transport.js';

/** Two local JSON-RPC nodes: `limit` answers like the 2026-11-23 provider ("Request exceeds defined limit"). */
type Mode = 'ok' | 'limit' | 'revert' | 'http429' | 'http403' | 'http502' | 'html' | 'hang' | 'gap' | 'needsAddress';
async function node(behaviour: () => Mode, head: bigint) {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += String(chunk); });
    req.on('end', () => {
      const body = JSON.parse(raw) as { id: number; method: string; params?: { address?: unknown }[] };
      calls.push(body.method);
      const mode = behaviour();
      const send = (status: number, payload: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
      if (mode === 'hang') return; // Never answers: the client's timeout ends the request.
      if (mode === 'http429') { res.writeHead(429); res.end('Too Many Requests'); return; }
      if (mode === 'http403') { res.writeHead(403, { 'content-type': 'text/html' }); res.end('<html>Forbidden</html>'); return; }
      if (mode === 'http502') { res.writeHead(502); res.end('Bad Gateway'); return; }
      if (mode === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>maintenance</html>'); return; }
      if (mode === 'gap') return send(200, { jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'missing trie node 3009b80a (path ) state 0x12 is not available' } });
      // publicnode's answer to an eth_getLogs that names no contract (probed 2026-11-26).
      if (mode === 'needsAddress' && body.method === 'eth_getLogs' && body.params?.[0]?.address === undefined) return send(200, { jsonrpc: '2.0', id: body.id,
        error: { code: -32701, message: 'Please specify an address in your request or, to remove restrictions, order a dedicated full node here: https://www.allnodes.com/bnb/host' } });
      if (mode === 'limit') return send(200, { jsonrpc: '2.0', id: body.id, error: { code: -32005, message: 'Request exceeds defined limit.' } });
      if (mode === 'revert' && body.method === 'eth_call') return send(200, { jsonrpc: '2.0', id: body.id, error: { code: 3, message: 'execution reverted', data: '0x' } });
      const result = body.method === 'eth_chainId' ? '0x61' : body.method === 'eth_blockNumber' ? `0x${head.toString(16)}` : body.method === 'eth_getBalance' ? '0x5' : body.method === 'eth_getLogs' ? [] : '0x';
      send(200, { jsonrpc: '2.0', id: body.id, result });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, calls, stop: () => { server.closeAllConnections(); server.close(); } };
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

test('2026-11-25: a public node answering 403 to eth_getLogs hands scheduler reads to the next public node, never to the paid RPC', async () => {
  resetRpcTransport();
  let first: Mode = 'http403', t = 1_000_000;
  const paid = await node(() => 'ok', 100n), a = await node(() => first, 100n), b = await node(() => 'ok', 100n), lines: string[] = [];
  try {
    const client = createPublicClient({ transport: rpcTransport('scheduler', paid.url, {}, { secondary: [a.url, b.url], preferPublic: true, schedulerRole: true, now: () => t, log: (l) => lines.push(l) }) });
    const logs = () => client.getLogs({ address: '0x00000000000000000000000000000000000000a1', fromBlock: 1n, toBlock: 2n });
    const count = (n: { calls: string[] }) => n.calls.filter(m => m === 'eth_getLogs').length;
    assert.deepEqual(await logs(), []);
    assert.equal(count(a), 1, 'the refusing node is asked once, not retried'); assert.equal(count(b), 1); assert.equal(paid.calls.length, 0);
    assert.equal(lines.length, 1); assert.match(lines[0]!, /"msg":"rpc_failover","from":"public","to":"public2","source":"scheduler","method":"eth_getLogs"/);
    assert.doesNotMatch(lines[0]!, /127\.0\.0\.1/);
    // For a minute the refusing node is at the back: healthy nodes answer without asking it.
    t += RPC_BREAKER_MS - 1; await logs(); await client.getBalance({ address: '0x00000000000000000000000000000000000000a1' });
    assert.equal(count(a), 1); assert.equal(count(b), 2); assert.equal(lines.length, 1);
    // Then it is back in its normal place; still refusing, it is skipped again, and once healthy it serves again.
    t += 1; await logs(); assert.equal(count(a), 2); assert.equal(count(b), 3);
    first = 'ok'; t += RPC_BREAKER_MS; await logs(); assert.equal(count(a), 3); assert.equal(count(b), 3);
    assert.equal(paid.calls.length, 0);
  } finally { paid.stop(); a.stop(); b.stop(); }
});

test('403, 429, 502, a non-JSON body, a timeout and a quota answer each move on to the next node; all nodes failing fails the request', async () => {
  for (const mode of ['http403', 'http429', 'http502', 'html', 'hang', 'limit'] as const) {
    resetRpcTransport();
    let second: Mode = 'ok';
    const paid = await node(() => 'ok', 100n), a = await node(() => mode, 100n), b = await node(() => second, 100n), lines: string[] = [];
    try {
      const options = { secondary: [a.url, b.url], preferPublic: true, log: (l: string) => lines.push(l) };
      const scheduler = createPublicClient({ transport: rpcTransport('scheduler', paid.url, { timeout: 150 }, { ...options, schedulerRole: true }) });
      const account = '0x00000000000000000000000000000000000000a1';
      assert.equal(await scheduler.getBalance({ address: account }), 5n, mode);
      assert.equal(b.calls.filter(m => m === 'eth_getBalance').length, 1, mode); assert.equal(isProviderFailure(Object.assign(new Error('x'), { name: 'HttpRequestError' })), true);
      // Every public node is down: the scheduler's bulk read fails without the paid RPC, and says so once.
      second = 'http403';
      await assert.rejects(scheduler.getBalance({ address: account }), (error: unknown) => isProviderFailure(error), mode);
      assert.equal(paid.calls.length, 0, mode); assert.equal(lines.filter((l) => /"msg":"rpc_failover_skipped","from":"public2","nodes":2,"source":"scheduler"/.test(l)).length, 1, mode);
      // The same outage in the API (and for the scheduler's transaction methods) ends on RPC_URL.
      const api = createPublicClient({ transport: rpcTransport('dca', paid.url, { timeout: 150 }, { ...options, schedulerRole: false }) });
      assert.equal(await api.getBalance({ address: account }), 5n, mode); assert.equal(paid.calls.filter(m => m === 'eth_getBalance').length, 1, mode);
      // Nothing is remembered as "broken for good": as soon as a public node answers again, the next request succeeds.
      second = 'ok';
      assert.equal(await scheduler.getBalance({ address: account }), 5n, mode); assert.equal(paid.calls.filter(m => m === 'eth_getBalance').length, 1, mode);
      assert.doesNotMatch(lines.join('\n'), /127\.0\.0\.1/, mode);
    } finally { paid.stop(); a.stop(); b.stop(); }
  }
});

test('RPC_URL first (API transaction paths): a 403 from RPC_URL goes to the public nodes in order', async () => {
  resetRpcTransport();
  const primary = await node(() => 'http403', 100n), a = await node(() => 'http502', 100n), b = await node(() => 'ok', 100n), lines: string[] = [];
  try {
    const client = createPublicClient({ transport: rpcTransport('paymaster', primary.url, {}, { secondary: [a.url, b.url], preferPublic: false, log: (l) => lines.push(l) }) });
    assert.equal(await client.getBalance({ address: '0x00000000000000000000000000000000000000a1' }), 5n);
    assert.deepEqual([primary, a, b].map((n) => n.calls.filter(m => m === 'eth_getBalance').length), [1, 1, 1]);
    assert.deepEqual(lines.map((l) => { const j = JSON.parse(l) as { from: string; to: string }; return `${j.from}>${j.to}`; }), ['primary>public', 'public>public2']);
    assert.equal(await client.getBalance({ address: '0x00000000000000000000000000000000000000a1' }), 5n);
    assert.deepEqual([primary, a, b].map((n) => n.calls.filter(m => m === 'eth_getBalance').length), [1, 1, 2], 'both failed nodes wait at the back');
  } finally { primary.stop(); a.stop(); b.stop(); }
});

test('2026-11-26: a public node that only takes eth_getLogs with a contract address hands the holdings scan (no address) to the next node and keeps its place', async () => {
  resetRpcTransport();
  let t = 1_000_000, bMode: Mode = 'ok';
  const paid = await node(() => 'ok', 100n), a = await node(() => 'needsAddress', 100n), b = await node(() => bMode, 100n), lines: string[] = [];
  try {
    const client = createPublicClient({ transport: rpcTransport('scheduler', paid.url, {}, { secondary: [a.url, b.url], preferPublic: true, schedulerRole: true, now: () => t, log: (l) => lines.push(l) }) });
    const count = (n: { calls: string[] }) => n.calls.filter(m => m === 'eth_getLogs').length;
    // The holdings scan's own request: Transfer to the account from any contract.
    const scan = () => client.request({ method: 'eth_getLogs', params: [{ topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', null,
      '0x00000000000000000000000000000000000000000000000000000000000000a1'], fromBlock: '0x1', toBlock: '0x2' }] });
    assert.deepEqual(await scan(), []); assert.deepEqual(await scan(), []); assert.deepEqual(await scan(), []);
    assert.equal(count(a), 1, 'refused once, then not asked for this kind of request'); assert.equal(count(b), 3);
    // With a contract address the first node answers itself, as before: it keeps its place for everything else.
    assert.deepEqual(await client.getLogs({ address: '0x00000000000000000000000000000000000000a1', fromBlock: 1n, toBlock: 2n }), []);
    assert.equal(await client.getBalance({ address: '0x00000000000000000000000000000000000000a1' }), 5n);
    assert.equal(count(a), 2); assert.equal(count(b), 3); assert.equal(b.calls.filter(m => m === 'eth_getBalance').length, 0);
    // When no other node can answer either, the caller gets the refusing node's own words (and the scan fails that range).
    bMode = 'gap';
    await assert.rejects(scan(), /specify an address/);
    bMode = 'ok';
    // Ten minutes later it is asked again (the restriction may be gone); still refusing, it is skipped again.
    t += ADDRESSLESS_LOGS_SKIP_MS - 1; await scan(); assert.equal(count(a), 2);
    t += 1; await scan(); assert.equal(count(a), 3); await scan(); assert.equal(count(a), 3);
    assert.equal(lines.length, 0, 'not a node failure: no failover line'); assert.equal(paid.calls.length, 0, 'a scheduler bulk read never goes to the paid RPC');
  } finally { paid.stop(); a.stop(); b.stop(); }
  assert.equal(isNodeGap(new Error('RPC Request failed.', { cause: new Error('Please specify an address in your request or, to remove restrictions, order a dedicated full node here: <url>') })), true);
  assert.equal(isProviderFailure(Object.assign(new Error('Please specify an address in your request or, to remove restrictions, order a dedicated full node here: <url>'), { code: -32701 })), false);
});

test('a node without the requested state passes the read on but keeps its place; a revert is never passed on', async () => {
  resetRpcTransport();
  let first: Mode = 'gap';
  const paid = await node(() => 'ok', 100n), a = await node(() => first, 100n), b = await node(() => 'ok', 100n), lines: string[] = [];
  try {
    const client = createPublicClient({ transport: rpcTransport('scheduler', paid.url, {}, { secondary: [a.url, b.url], preferPublic: true, schedulerRole: true, log: (l) => lines.push(l) }) });
    const account = '0x00000000000000000000000000000000000000a1';
    assert.equal(await client.getBalance({ address: account, blockNumber: 5n }), 5n);
    assert.equal(await client.getBalance({ address: account, blockNumber: 5n }), 5n);
    assert.equal(a.calls.filter(m => m === 'eth_getBalance').length, 2, 'not demoted: it is healthy for other reads');
    assert.equal(b.calls.filter(m => m === 'eth_getBalance').length, 2); assert.equal(lines.length, 0); assert.equal(paid.calls.length, 0);
    first = 'revert';
    await assert.rejects(client.call({ to: account, data: '0x12345678' }));
    assert.equal(b.calls.filter(m => m === 'eth_call').length, 0);
  } finally { paid.stop(); a.stop(); b.stop(); }
  assert.equal(isNodeGap(new Error('wrapper', { cause: new Error('header not found') })), true);
  assert.equal(isNodeGap(new Error('exceed maximum block range 5000')), true);
  assert.equal(isNodeGap(new Error('execution reverted')), false);
  for (const status of [400, 401, 403, 404, 408, 429, 500, 503]) assert.equal(isProviderFailure(Object.assign(new Error('HTTP request failed.'), { status })), true, String(status));
  assert.equal(isProviderFailure(Object.assign(new Error('execution reverted'), { status: 500 })), false);
  // The node list: none for local forks or other chains, never the URL itself; all keyless https hosts.
  assert.deepEqual(publicRpcs('http://127.0.0.1:8545', 97), []); assert.deepEqual(publicRpcs('https://rpc.example.invalid/key', 56), []);
  assert.deepEqual(publicRpcs('https://rpc.example.invalid/key', 97), [...PUBLIC_RPCS_97]);
  assert.deepEqual(publicRpcs(`${PUBLIC_RPCS_97[1]}/`, 97), PUBLIC_RPCS_97.filter((_, index) => index !== 1));
  assert.equal(PUBLIC_RPCS_97.length, 4); assert.equal(new Set(PUBLIC_RPCS_97).size, 4);
  for (const url of PUBLIC_RPCS_97) { const parsed = new URL(url); assert.equal(parsed.protocol, 'https:'); assert.equal(parsed.pathname, '/'); assert.equal(parsed.search, ''); assert.equal(parsed.username, ''); }
});

/**
 * A node with a head that moves and state that depends on the block asked for: the balance is 5 before block `landedAt`
 * and 9 from it on (a transaction of ours landed there). `serves`: the head of the server that answers state reads — a
 * load-balanced provider whose other server is still behind says "header not found" for a block it has not seen.
 */
async function chainNode(state: { head: bigint; serves?: bigint }, landedAt: bigint) {
  const calls: { method: string; tag: unknown }[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += String(chunk); });
    req.on('end', () => {
      const body = JSON.parse(raw) as { id: number; method: string; params?: unknown[] };
      const at = body.method === 'eth_getBlockByNumber' ? 0 : 1, tag = body.params?.[at];
      calls.push({ method: body.method, tag });
      const send = (payload: object) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...payload })); };
      if (body.method === 'eth_blockNumber') return send({ result: `0x${state.head.toString(16)}` });
      const serving = state.serves ?? state.head;
      const block = tag === 'latest' || tag === undefined ? serving : BigInt(tag as string);
      // A block the answering server has not seen: null for a block read (as geth answers), an error for state.
      if (block > serving) return send(body.method === 'eth_getBlockByNumber' ? { result: null } : { error: { code: -32000, message: 'header not found' } });
      if (body.method === 'eth_getBalance') return send({ result: block >= landedAt ? '0x9' : '0x5' });
      if (body.method === 'eth_getBlockByNumber') return send({ result: { number: `0x${block.toString(16)}`, hash: `0x${'ab'.repeat(32)}`, timestamp: '0x1', transactions: [] } });
      send({ result: '0x' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, stop: () => { server.closeAllConnections(); server.close(); } };
}

test('2026-11-26 read your own writes: after a transaction of ours lands, head and `latest` reads are only answered by a node that has reached its block', async () => {
  resetRpcTransport();
  const account = '0x00000000000000000000000000000000000000a1';
  // The first node in the order is 3 blocks behind the block our take-back landed in (120); the second has it.
  const behind = { head: 117n }, ahead = { head: 121n }, paidHead = { head: 121n };
  let t = 1_000_000;
  const sleeps: number[] = [];
  const paid = await chainNode(paidHead, 120n), a = await chainNode(behind, 120n), b = await chainNode(ahead, 120n);
  try {
    const client = createPublicClient({ transport: rpcTransport('scheduler', paid.url, {}, { secondary: [a.url, b.url], preferPublic: true, schedulerRole: true, now: () => t,
      sleep: async (ms) => { sleeps.push(ms); t += ms; behind.head += 1n; } }) });
    // Before anything landed: the first node answers, old state and all — nothing changes for ordinary reads.
    assert.equal(await client.getBalance({ address: account }), 5n);
    assert.deepEqual([a.calls.map(c => c.method), b.calls.length], [['eth_getBalance'], 0]);
    assert.equal(landedFloor(t), null);
    // Our transaction landed in block 120.
    noteLandedBlock(120n, t);
    assert.equal(landedFloor(t), 120n);
    a.calls.length = 0;
    // `latest` state: the lagging node is asked for its head and skipped; the next one answers, pinned to its own head.
    assert.equal(await client.getBalance({ address: account }), 9n, 'never the balance from before our transaction');
    assert.deepEqual(a.calls, [{ method: 'eth_blockNumber', tag: undefined }]);
    assert.deepEqual(b.calls, [{ method: 'eth_blockNumber', tag: undefined }, { method: 'eth_getBalance', tag: '0x79' }]);
    // The head itself and the latest block: from a node at or past 120 as well (a plan pinned to them sees the transaction).
    t += HEAD_CACHE_MS;
    assert.equal(await client.getBlockNumber({ cacheTime: 0 }), 121n);
    assert.equal((await client.getBlock()).number, 121n);
    assert.equal(b.calls.filter(c => c.method === 'eth_getBlockByNumber')[0]!.tag, '0x79');
    // A read at an explicit block is the caller's own choice and is left alone (no head lookup, the first node answers).
    a.calls.length = 0; b.calls.length = 0;
    assert.equal(await client.getBalance({ address: account, blockNumber: 110n }), 5n);
    assert.deepEqual([a.calls, b.calls.length], [[{ method: 'eth_getBalance', tag: '0x6e' }], 0]);
    // The lagging node is not demoted: once it has caught up it answers in its normal place again.
    behind.head = 122n; t += HEAD_CACHE_MS; a.calls.length = 0; b.calls.length = 0;
    assert.equal(await client.getBalance({ address: account }), 9n);
    assert.deepEqual([a.calls.map(c => c.method), a.calls[1]!.tag, b.calls.length], [['eth_blockNumber', 'eth_getBalance'], '0x7a', 0]);
    // A minute later nothing is enforced any more.
    t += LANDED_FLOOR_MS; a.calls.length = 0;
    assert.equal(landedFloor(t), null);
    await client.getBalance({ address: account });
    assert.deepEqual(a.calls, [{ method: 'eth_getBalance', tag: 'latest' }]);

    // Every node is behind (the block landed at 130; the nodes are at 122 and 121): the read waits for one to get there.
    noteLandedBlock(130n, t); noteLandedBlock(125n, t);
    assert.equal(landedFloor(t), 130n, 'a lower block noted later never lowers the floor');
    ahead.head = 121n; paidHead.head = 100n; sleeps.length = 0;
    assert.equal(await client.getBalance({ address: account }), 9n);
    assert.equal(behind.head, 130n);
    assert.ok(sleeps.length === 8 && sleeps.every(ms => ms === 250), JSON.stringify(sleeps));
    // No node gets there within the wait: the read fails as a node gap. It never answers with older state.
    noteLandedBlock(10_000n, t);
    await assert.rejects(client.getBalance({ address: account }), (error: unknown) => isNodeGap(error) && /no RPC node has reached block 10000/.test(String((error as { details?: string }).details ?? '') + String(error)));
    assert.ok(sleeps.reduce((sum, ms) => sum + ms, 0) >= LANDED_WAIT_MS);
    // Nonsense is ignored.
    resetRpcTransport();
    for (const bad of [null, undefined, 0n, -5, 'not a number']) noteLandedBlock(bad as never, t);
    assert.equal(landedFloor(t), null);
    noteLandedBlock('0x7b', t);
    assert.equal(landedFloor(t), 123n);
  } finally { paid.stop(); a.stop(); b.stop(); resetRpcTransport(); }
});

test('2026-11-26 read your own writes on a load-balanced provider: its head says it is there, the server answering the read is not — the next node answers', async () => {
  resetRpcTransport();
  const account = '0x00000000000000000000000000000000000000a1';
  // RPC_URL first (an API source): its head is 121 but state reads are served by a server still at 118.
  const balanced = { head: 121n, serves: 118n }, other = { head: 120n };
  let t = 2_000_000;
  const p = await chainNode(balanced, 120n), s = await chainNode(other, 120n);
  try {
    const client = createPublicClient({ transport: rpcTransport('paymaster', p.url, {}, { secondary: s.url, preferPublic: false, now: () => t, sleep: async (ms) => { t += ms; } }) });
    noteLandedBlock(120n, t);
    assert.equal(await client.getBalance({ address: account }), 9n);
    assert.deepEqual(p.calls, [{ method: 'eth_blockNumber', tag: undefined }, { method: 'eth_getBalance', tag: '0x79' }], 'asked at its own head: the lagging server cannot answer with old state');
    assert.deepEqual(s.calls, [{ method: 'eth_blockNumber', tag: undefined }, { method: 'eth_getBalance', tag: '0x78' }]);
    // The latest block from that provider: its lagging server answers null for the pinned number — the next node answers.
    p.calls.length = 0; s.calls.length = 0;
    assert.equal((await client.getBlock()).number, 120n);
    assert.deepEqual([p.calls.at(-1), s.calls.at(-1)], [{ method: 'eth_getBlockByNumber', tag: '0x79' }, { method: 'eth_getBlockByNumber', tag: '0x78' }]);
    // Unpinned, the same provider would have answered 5 (the state from before our transaction).
    t += LANDED_FLOOR_MS;
    assert.equal(await client.getBalance({ address: account }), 5n);
  } finally { p.stop(); s.stop(); resetRpcTransport(); }
});
