import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { custom, http } from 'viem';
import { createKeeperChain, parseManifest, signingAccount } from '../src/keeper/chain.js';
import { keeperChainFixture, manifestInput } from './fixtures/price-keeper.js';
import { runScript, assertNoSecretSlices } from './fixtures/secret-output.js';

test('keeper manifest: rejects wrong chain, missing/zero/duplicate contracts and unwanted feeds', () => {
  assert.equal(parseManifest(manifestInput()).markets.length, 92);
  const wrongChain = manifestInput(); wrongChain.chainId = 56; assert.throws(() => parseManifest(wrongChain));
  const missing = manifestInput(); delete missing.assets.ETH; assert.throws(() => parseManifest(missing));
  const duplicate = manifestInput(); const eth = duplicate.assets.ETH; const btc = duplicate.assets.BTCB; assert.ok(eth && btc);
  eth.token = btc.token; assert.throws(() => parseManifest(duplicate));
  const duplicatePool = manifestInput(); const first = duplicatePool.assets.AAPLB; const last = duplicatePool.assets.ATOM;
  assert.ok(first && last); last.pool = first.pool; assert.throws(() => parseManifest(duplicatePool));
  const duplicateFeed = manifestInput(); const secondary = duplicateFeed.assets.ETH; assert.ok(secondary);
  secondary.feed = duplicateFeed.contracts['feed.USDT/USD']; assert.throws(() => parseManifest(duplicateFeed));
  const zero = manifestInput(); zero.contracts.router = '0x0000000000000000000000000000000000000000'; assert.throws(() => parseManifest(zero));
  const extra = manifestInput(); const stock = extra.assets.AAPLB; assert.ok(stock); stock.feed = extra.contracts['feed.USDT/USD'];
  assert.throws(() => parseManifest(extra));
});

test('keeper chain verifies all pools, minters, keeper permissions and oracle/feed wiring before writes', async () => {
  const { chain, state } = keeperChainFixture(); await chain.verify(); assert.equal(state.sends, 0);
  assert.equal(state.calls.filter((c) => c.name === 'isMinter').length, 92);
  assert.equal(state.calls.filter((c) => c.name === 'keeper').length, 12);
  for (const bad of ['missing code', 'factory', 'numeraire', 'symbol', 'decimals', 'isMinter', 'keeper', 'getPool',
    'oracleOf', 'pool', 'twapWindow', 'RECENT_WINDOW', 'secondaryOf', 'assetFeed', 'numeraireFeed', 'maxAge']) {
    const f = keeperChainFixture(); f.state.bad = bad; await assert.rejects(f.chain.verify()); assert.equal(f.state.sends, 0);
  }
});

test('keeper wrong chain is rejected before reads and before every possible write', async () => {
  for (const chainId of [1, 56, 1337]) {
    const { state, chain, manifest } = keeperChainFixture(); state.chainId = chainId;
    const market = manifest.markets[0]; assert.ok(market);
    await assert.rejects(chain.verify(), /97/); await assert.rejects(chain.io.head(), /97/);
    await assert.rejects(chain.io.mint(market.token, 1n), /97/); await assert.rejects(chain.io.push(manifest.cashFeed, 1n), /97/);
    assert.equal(state.sends, 0); assert.equal(state.calls.length, 0);
  }
});

test('#97 keeper chain refuses every USDT mint without a write, including zero and uint256 maximum', async () => {
  const { state, chain, manifest } = keeperChainFixture();
  for (const amount of [0n, 1n, (1n << 256n) - 1n]) await assert.rejects(chain.io.mint(manifest.usdt, amount), /prefunded/);
  assert.equal(state.sends, 0);
});

test('keeper inspects 92 markets and both oracle directions at one pinned block', async () => {
  const { state, chain } = keeperChainFixture(); const observations = await chain.io.inspect({ number: 100n, timestamp: 1060n });
  assert.equal(observations.length, 92); assert.equal(observations.filter((o) => o.feedUpdatedAt !== null).length, 11);
  assert.equal(state.calls.filter((c) => c.name === 'previewSwap').length, 92 * 3);
  assert.ok(state.calls.every((c) => c.block === '0x64')); assert.equal(state.sends, 0);
});

test('keeper pool/feed faults and RPC failures prevent an observation set; swap budget failure sends nothing', async () => {
  for (const bad of ['cardinality', 'capacity', 'locked', 'observation', 'negative feed', 'future feed', 'cash price']) {
    const { state, chain } = keeperChainFixture(); state.bad = bad;
    await assert.rejects(chain.io.inspect({ number: 100n, timestamp: 1060n })); assert.equal(state.sends, 0);
  }
  const stale = keeperChainFixture(); stale.state.bad = 'stale feed';
  await assert.rejects(stale.chain.io.inspect({ number: 100n, timestamp: 3602n }));
  for (const fail of ['eth_getBlockByNumber', 'latestRoundData', 'observations', 'slot0', 'previewSwap']) {
    const { state, chain } = keeperChainFixture(); state.fail = fail;
    await assert.rejects(fail === 'eth_getBlockByNumber' ? chain.io.head() : chain.io.inspect({ number: 100n, timestamp: 1060n }));
    assert.equal(state.sends, 0);
  }
  const f = keeperChainFixture(); const observations = await f.chain.io.inspect({ number: 100n, timestamp: 1060n }); const first = observations[0]; assert.ok(first);
  await assert.rejects(f.chain.io.swap(first, first.spotE18 * 10_001n / 10_000n, 1n), /cannot reach target/); assert.equal(f.state.sends, 0);
});

test('keeper refuses pool movement between inspection and execution before approval or swap', async () => {
  const f = keeperChainFixture(); const observations = await f.chain.io.inspect({ number: 100n, timestamp: 1060n }); const first = observations[0]; assert.ok(first);
  f.state.bad = 'pool moved';
  await assert.rejects(f.chain.io.swap(first, first.spotE18 * 10_001n / 10_000n, 10_000n * 10n ** 18n), /pool changed/);
  assert.equal(f.state.sends, 0);
});

test('keeper HTTP RPC timeout is bounded and never retried', async () => {
  let calls = 0;
  const server = createServer(() => { calls++; });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const rpc = `http://127.0.0.1:${address.port}`;
    const chain = createKeeperChain(rpc, signingAccount(`0x${'0'.repeat(63)}1`), parseManifest(manifestInput()), () => {}, http(rpc, { timeout: 25, retryCount: 0 }));
    await assert.rejects(chain.io.head()); assert.equal(calls, 1);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('keeper writes require a successful canonical receipt and never rebroadcast an unknown result', async () => {
  for (const fault of ['', 'broadcast', 'reverted', 'replaced', 'reorg', 'receipt RPC']) {
    const manifest = parseManifest(manifestInput());
    const market = manifest.markets[0]; assert.ok(market);
    const hash = `0x${'ab'.repeat(32)}`;
    const blockHash = `0x${'cd'.repeat(32)}`;
    let sends = 0;
    const logs: string[] = [];
    const transport = custom({ request: async ({ method }) => {
      switch (method) {
        case 'eth_chainId': return '0x61';
        case 'eth_getBlockByNumber': return { number: '0x64', timestamp: '0x424', hash: fault === 'reorg' ? hash : blockHash, transactions: [] };
        case 'eth_blockNumber': return '0x64';
        case 'eth_sendTransaction':
          sends++;
          if (fault === 'broadcast') throw new Error('secret credential in unknown broadcast');
          return hash;
        case 'eth_getTransactionByHash':
          if (fault === 'receipt RPC') throw new Error('secret credential in receipt RPC');
          assert.fail('unexpected replacement lookup');
        case 'eth_getTransactionReceipt':
          if (fault === 'receipt RPC') throw new Error('secret credential in receipt RPC');
          return { transactionHash: fault === 'replaced' ? blockHash : hash, transactionIndex: '0x0', blockHash, blockNumber: '0x64',
            from: manifest.keeper, to: manifest.usdt, contractAddress: null, cumulativeGasUsed: '0x1', gasUsed: '0x1',
            effectiveGasPrice: '0x1', logs: [], logsBloom: `0x${'00'.repeat(256)}`, status: fault === 'reverted' ? '0x0' : '0x1', type: '0x0' };
        default: assert.fail(`unexpected write RPC ${method}`);
      }
    } }, { retryCount: 0 });
    const chain = createKeeperChain('http://127.0.0.1:1', { address: manifest.keeper, type: 'json-rpc' }, manifest, (line) => logs.push(line), transport);
    if (fault === 'receipt RPC') await assert.rejects(chain.io.mint(market.token, 1n), /secret credential in receipt RPC/);
    else if (fault) await assert.rejects(chain.io.mint(market.token, 1n));
    else await chain.io.mint(market.token, 1n);
    assert.equal(sends, 1);
    assert.equal(logs.filter((line) => line.includes('confirmed')).length, fault ? 0 : 1);
    assert.doesNotMatch(logs.join('\n'), /secret|credential/);
  }
});

test('keeper CLI startup failure redacts key/URL/file errors and notifies through the existing Telegram sender', async () => {
  const messages: unknown[] = [];
  let telegramStatus = 200;
  const server = createServer(async (req, res) => {
    let data = ''; for await (const chunk of req) data += String(chunk);
    messages.push(JSON.parse(data)); res.statusCode = telegramStatus; res.setHeader('content-type', 'application/json'); res.end('{"ok":true}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const key = 'misplaced-private-key-secret'; const url = 'https://credential.invalid/private-token';
    const result = await runScript('scripts/price-keeper.ts', { PRICE_KEEPER_ENABLED: '1', PRICE_KEEPER_RPC_URL: url,
      PRICE_KEEPER_PRIVATE_KEY: key, PRICE_KEEPER_MANIFEST: '/missing/private-path', PRICE_KEEPER_SCENARIO: '/missing/scenario',
      PRICE_KEEPER_START_TIMESTAMP: '1000', TELEGRAM_BOT_TOKEN: 'test-only', TELEGRAM_CHAT_ID: 'test-only', TELEGRAM_API_BASE: `http://127.0.0.1:${address.port}` });
    assert.equal(result.code, 1); assert.match(result.output, /啟動失敗/); assert.equal(messages.length, 1);
    for (const secret of [key, url, '/missing/private-path']) assertNoSecretSlices(result.output + JSON.stringify(messages), secret);
    const disabled = await runScript('scripts/price-keeper.ts', { PRICE_KEEPER_ENABLED: '0', PRICE_KEEPER_PRIVATE_KEY: key });
    assert.equal(disabled.code, 0); assert.match(disabled.output, /disabled/); assert.equal(messages.length, 1);
    telegramStatus = 503;
    const failedAlert = await runScript('scripts/price-keeper.ts', { PRICE_KEEPER_ENABLED: '1',
      TELEGRAM_BOT_TOKEN: 'test-only', TELEGRAM_CHAT_ID: 'test-only', TELEGRAM_API_BASE: `http://127.0.0.1:${address.port}` });
    assert.equal(failedAlert.code, 1); assert.equal(messages.length, 2);
    assert.match(failedAlert.output, /HTTP 503/); assert.doesNotMatch(failedAlert.output, /已保留在 DB/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
