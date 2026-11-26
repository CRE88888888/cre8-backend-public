import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import type { Server } from 'node:http';
import { encodeAbiParameters, zeroAddress } from 'viem';
import { getConfig, getSessionKeyConfig, loadRateLimitConfig } from '../../src/config.js';
import { MemoryRateLimitStore, RequestRateLimiter } from '../../src/ratelimit.js';
import { createServer } from '../../src/server.js';
import { TESTNET_97, testnetAssets } from '../../src/testnet-profile.js';

const counts = [0, 0];
const routers = [TESTNET_97.contracts.router, zeroAddress];
const rpcs = routers.map((router, index) => createHttpServer(async (req, res) => {
  let text = '';
  for await (const chunk of req) text += String(chunk);
  const body: unknown = JSON.parse(text);
  assert.ok(typeof body === 'object' && body !== null && 'id' in body && 'method' in body);
  assert.equal(body.method, 'eth_call', 'asset listing must only read contracts');
  counts[index] = (counts[index] ?? 0) + 1;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: encodeAbiParameters([{ type: 'address' }], [router]) }));
}));

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

const api = createServer({
  auth: { authenticate: async () => TESTNET_97.roles.keeper, issueNonce: () => { throw new Error('unused'); },
    login: async () => { throw new Error('unused'); }, logout: async () => {} },
  rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore()),
});

try {
  const urls = await Promise.all(rpcs.map(listen));
  assert.ok(urls[0] && urls[1]);
  getConfig().rpcUrl = urls[0];
  const base = await listen(api);
  const list = async (tradable: (isNumeraire: boolean) => boolean | null = () => true) => {
    const response = await fetch(base + '/assets');
    assert.equal(response.status, 200);
    const body: unknown = await response.json();
    assert.deepEqual(body, { assets: testnetAssets().map(asset => ({
      address: asset.address, symbol: asset.symbol, decimals: asset.decimals,
      isNumeraire: asset.is_numeraire, tradable: tradable(asset.is_numeraire),
    })) });
  };
  await Promise.all([list(), list(), list()]);
  const callsPerRefresh = testnetAssets().length;
  assert.equal(counts[0], callsPerRefresh);
  await list();
  assert.equal(counts[0], callsPerRefresh, 'the default HTTP path must retain its cache across requests');
  getSessionKeyConfig().executorAddress = TESTNET_97.contracts.router;
  await list();
  assert.equal(counts[0], callsPerRefresh * 2, 'another executor must not reuse the old probe');
  getConfig().rpcUrl = urls[1];
  await list(isNumeraire => isNumeraire);
  assert.equal(counts[1], callsPerRefresh, 'another RPC must not reuse the old probe');
  getConfig().chainId++;
  await list(isNumeraire => isNumeraire);
  assert.equal(counts[1], callsPerRefresh * 2, 'another chain must not reuse the old probe');
  getConfig().rpcUrl = null;
  await list(() => null);
  getConfig().rpcUrl = urls[0];
  getSessionKeyConfig().executorAddress = null;
  await list(() => null);
  console.log('assets HTTP cache verified');
} finally {
  await Promise.all([api, ...rpcs].map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
}
