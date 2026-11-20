import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { ContractFunctionRevertedError, custom, decodeFunctionData, encodeErrorResult, encodeFunctionResult, HttpRequestError, http, isHex, parseAbi, RpcRequestError, TimeoutError } from 'viem';
import { createKeeperChain, KEEPER_ABI, parseManifest, signingAccount, spotPrice, sqrtPriceFor } from '../src/keeper/chain.js';
import { TESTNET_ASSETS } from '../src/keeper/assets.js';
import { keeperChainFixture, manifestInput } from './fixtures/price-keeper.js';
import { runScript, assertNoSecretSlices } from './fixtures/secret-output.js';
import { isTransientRpcError, PriceKeeper, safeReason } from '../src/keeper/engine.js';
import { parseScenario } from '../src/keeper/scenario.js';

test('keeper manifest: rejects wrong chain, missing/zero/duplicate contracts and unwanted feeds', () => {
  assert.equal(parseManifest(manifestInput()).markets.length, 105);
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
  assert.equal(state.calls.filter((c) => c.name === 'isMinter').length, 105);
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

test('keeper inspects 105 markets and both oracle directions at one pinned block', async () => {
  const { state, chain } = keeperChainFixture(); const observations = await chain.io.inspect({ number: 100n, timestamp: 1060n });
  assert.equal(observations.length, 105); assert.equal(observations.filter((o) => o.feedUpdatedAt !== null).length, 11);
  assert.equal(state.calls.filter((c) => c.name === 'previewSwap').length, 105 * 3);
  assert.ok(state.calls.every((c) => c.block === '0x64')); assert.equal(state.sends, 0);
});

test('keeper pool/feed faults and RPC failures prevent an observation set; swap budget failure sends nothing', async () => {
  for (const bad of ['cardinality', 'capacity', 'locked', 'observation', 'negative feed', 'future feed', 'cash price']) {
    const { state, chain } = keeperChainFixture(); state.bad = bad;
    await assert.rejects(chain.io.inspect({ number: 100n, timestamp: 1060n })); assert.equal(state.sends, 0);
  }
  const stale = keeperChainFixture(); stale.state.bad = 'stale feed';
  assert.equal((await stale.chain.io.inspect({ number: 100n, timestamp: 3602n })).length, 105);
  for (const fail of ['eth_getBlockByNumber', 'latestRoundData', 'observations', 'slot0', 'previewSwap']) {
    const { state, chain } = keeperChainFixture(); state.fail = fail;
    await assert.rejects(fail === 'eth_getBlockByNumber' ? chain.io.head() : chain.io.inspect({ number: 100n, timestamp: 1060n }));
    assert.equal(state.sends, 0);
  }
  const f = keeperChainFixture(); const observations = await f.chain.io.inspect({ number: 100n, timestamp: 1060n }); const first = observations[0]; assert.ok(first);
  await assert.rejects(f.chain.io.swap(first, first.spotE18 * 10_001n / 10_000n, 1n), /cannot reach target/); assert.equal(f.state.sends, 0);
});

const recoveryErrors = parseAbi(['error TwapUnavailable()', 'error InvalidPoolPrice()', 'error StaleFeed(address feed,uint256 updatedAt)']);
const primaryRevert = (name: 'TwapUnavailable' | 'InvalidPoolPrice') => new ContractFunctionRevertedError({
  abi: recoveryErrors, functionName: 'previewSwap', data: encodeErrorResult({ abi: recoveryErrors, errorName: name }),
});

test('#139 adapter distinguishes exact primary TwapUnavailable from other reverts and RPC errors', async () => {
  const f = keeperChainFixture(); f.state.primaryError = new RpcRequestError({ body: {}, url: 'http://127.0.0.1:1', error: {
    code: 3, message: 'execution reverted private-token', data: encodeErrorResult({ abi: recoveryErrors, errorName: 'TwapUnavailable' }),
  } });
  const observations = await f.chain.io.inspect({ number: 100n, timestamp: 1060n });
  assert.equal(observations.length, 105); assert.ok(observations.every((o) => o.twapE18 === null && o.spotE18 > 0n));
  assert.equal(f.state.calls.filter((c) => c.name === 'previewSwap').length, 105); assert.equal(f.state.sends, 0);
  for (const error of [primaryRevert('InvalidPoolPrice'), new Error('TwapUnavailable private-token'),
    new ContractFunctionRevertedError({ abi: parseAbi(['error TwapUnavailable(uint256)']), functionName: 'previewSwap',
      data: encodeErrorResult({ abi: parseAbi(['error TwapUnavailable(uint256)']), errorName: 'TwapUnavailable', args: [1n] }) }),
    new Error('RPC timeout private-token'), new ContractFunctionRevertedError({ abi: recoveryErrors, functionName: 'previewSwap', data: '0x' })]) {
    const f = keeperChainFixture(); f.state.primaryError = error;
    await assert.rejects(f.chain.io.inspect({ number: 100n, timestamp: 1060n })); assert.equal(f.state.sends, 0);
  }
  const router = keeperChainFixture(); router.state.routerError = primaryRevert('TwapUnavailable');
  await assert.rejects(router.chain.io.inspect({ number: 100n, timestamp: 1060n }));
  for (const bad of ['zero sqrt', 'low sqrt', 'high sqrt', 'locked', 'observation', 'negative feed', 'future feed']) {
    const f = keeperChainFixture(); f.state.bad = bad; f.state.primaryError = primaryRevert('TwapUnavailable');
    await assert.rejects(f.chain.io.inspect({ number: 100n, timestamp: 1060n })); assert.equal(f.state.sends, 0);
  }
});

test('#139 real inspection recovers all missing TWAPs and expired feeds across two engine rounds without signing', async () => {
  const f = keeperChainFixture(); f.state.primaryError = primaryRevert('TwapUnavailable');
  f.state.assetAt = 1n; f.state.cashAt = 1n; f.state.bad = 'router stale asset';
  const scenario = parseScenario(JSON.parse(await readFile(new URL('../scripts/price-scenarios/gentle-rise.json', import.meta.url), 'utf8')));
  let head = { number: 100n, timestamp: 200_000n };
  const swaps: bigint[] = []; const pushes: bigint[] = []; const logs: string[] = [];
  const budget = 10_000n * 10n ** 18n;
  const keeper = new PriceKeeper({ ...f.chain.io, head: async () => head,
    balance: async () => 10n ** 40n, mint: async () => { assert.fail('inventory is already sufficient'); },
    swap: async (o, target, limit) => {
      assert.equal(target, o.spotE18 * 10_001n / 10_000n); assert.equal(limit, budget);
      swaps.push(target); f.state.observedAt = Number(head.timestamp);
    },
    push: async (_feed, answer) => { pushes.push(answer); },
  }, scenario, f.manifest.usdt, f.manifest.cashFeed, { start: 1000n, minimumUsdtE18: budget,
    inventoryUsdtE18: 10n * budget, swapBudgetUsdtE18: budget, stallSeconds: 90 },
  (line) => logs.push(line), async () => { assert.fail('recovery must not alert'); }, () => Number(head.timestamp) * 1000);
  await keeper.round(); assert.equal(swaps.length, 105); assert.equal(pushes.length, 0);
  f.state.primaryError = null;
  head = { number: 101n, timestamp: head.timestamp + 60n };
  // Feeds can refresh with fresh TWAPs while pool swaps are gated by the on-chain timestamp.
  scenario.timeline = [{ steps: 1, mode: 'closed', stepBps: 0 }];
  await keeper.round(); assert.equal(swaps.length, 105); assert.equal(pushes.length, 12); assert.equal(f.state.sends, 0);
  assert.doesNotMatch(logs.join('\n'), /private-token|critical/);
});

test('#139 adapter tolerates only StaleFeed proven by the pinned, valid expired feed round', async () => {
  for (const source of ['cash', 'asset'] as const) {
    const f = keeperChainFixture();
    if (source === 'cash') { f.state.cashAt = 1n; f.state.assetAt = 200_000n; }
    else { f.state.assetAt = 1n; f.state.cashAt = 200_000n; f.state.bad = 'router stale asset'; }
    // Cash is shared by every secondary; use a fresh read to identify each market's feed.
    if (source === 'cash') f.state.routerError = new ContractFunctionRevertedError({ abi: recoveryErrors, functionName: 'previewSwap',
      data: encodeErrorResult({ abi: recoveryErrors, errorName: 'StaleFeed', args: [f.manifest.cashFeed, 1n] }) });
    const observations = await f.chain.io.inspect({ number: 100n, timestamp: 200_000n });
    assert.equal(observations.length, 105); assert.ok(observations.filter((o) => o.market.feed).every((o) => o.feedUpdatedAt === 1n));
    assert.equal(f.state.sends, 0);
  }
  for (const updatedAt of [1n, 1000n]) {
    const f = keeperChainFixture(); f.state.routerError = new ContractFunctionRevertedError({ abi: recoveryErrors, functionName: 'previewSwap',
      data: encodeErrorResult({ abi: recoveryErrors, errorName: 'StaleFeed', args: [f.manifest.cashFeed, updatedAt] }) });
    await assert.rejects(f.chain.io.inspect({ number: 100n, timestamp: 1060n }));
  }
  const unknown = keeperChainFixture(); unknown.state.cashAt = 1n;
  unknown.state.routerError = primaryRevert('InvalidPoolPrice');
  await assert.rejects(unknown.chain.io.inspect({ number: 100n, timestamp: 200_000n }));
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
  for (const fault of ['', 'broadcast', 'reverted', 'replaced', 'reorg', 'receipt RPC', 'broadcast HTTP', 'receipt timeout']) {
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
          if (fault === 'broadcast HTTP') throw new HttpRequestError({ url: 'https://private-token.invalid/key', status: 503 });
          return hash;
        case 'eth_getTransactionByHash':
          if (fault === 'receipt RPC') throw new Error('secret credential in receipt RPC');
          if (fault === 'receipt timeout') throw new TimeoutError({ body: {}, url: 'https://private-token.invalid/key' });
          assert.fail('unexpected replacement lookup');
        case 'eth_getTransactionReceipt':
          if (fault === 'receipt RPC') throw new Error('secret credential in receipt RPC');
          if (fault === 'receipt timeout') throw new TimeoutError({ body: {}, url: 'https://private-token.invalid/key' });
          return { transactionHash: fault === 'replaced' ? blockHash : hash, transactionIndex: '0x0', blockHash, blockNumber: '0x64',
            from: manifest.keeper, to: manifest.usdt, contractAddress: null, cumulativeGasUsed: '0x1', gasUsed: '0x1',
            effectiveGasPrice: '0x1', logs: [], logsBloom: `0x${'00'.repeat(256)}`, status: fault === 'reverted' ? '0x0' : '0x1', type: '0x0' };
        default: assert.fail(`unexpected write RPC ${method}`);
      }
    } }, { retryCount: 0 });
    const chain = createKeeperChain('http://127.0.0.1:1', { address: manifest.keeper, type: 'json-rpc' }, manifest, (line) => logs.push(line), transport);
    if (fault === 'receipt RPC') await assert.rejects(chain.io.mint(market.token, 1n), /secret credential in receipt RPC/);
    else if (fault) await assert.rejects(chain.io.mint(market.token, 1n), (error: unknown) => {
      assert.equal(isTransientRpcError(error), false);
      assert.doesNotMatch(safeReason(error), /secret|credential|private-token|https:/);
      if (fault === 'broadcast HTTP' || fault === 'receipt timeout') assert.match(safeReason(error), /transaction not confirmed/, fault);
      return true;
    });
    else await chain.io.mint(market.token, 1n);
    assert.equal(sends, 1);
    assert.equal(logs.filter((line) => line.includes('confirmed')).length, fault ? 0 : 1);
    assert.doesNotMatch(logs.join('\n'), /secret|credential/);
  }
});

test('#162 swap post-write validation must complete: RPC failure, wrong price and zero spend all halt', async () => {
  for (const fault of ['', 'slot', 'balance', 'wrong price', 'zero spend']) {
    const manifest = parseManifest(manifestInput()); const market = manifest.markets[0]; const spec = TESTNET_ASSETS[0]; assert.ok(market && spec);
    const sqrt = sqrtPriceFor(BigInt(spec.priceE18), market.decimals, true);
    const price = spotPrice(sqrt, market.decimals, true); const target = price * 10_001n / 10_000n;
    const limit = sqrtPriceFor(target, market.decimals, true);
    const hash = `0x${'ab'.repeat(32)}`; const blockHash = `0x${'cd'.repeat(32)}`;
    let sends = 0;
    const transport = custom({ request: async ({ method, params }) => {
      if (method === 'eth_chainId') return '0x61';
      if (method === 'eth_getBlockByNumber') return { number: '0x64', timestamp: '0x424', hash: blockHash, transactions: [] };
      if (method === 'eth_sendTransaction') { sends++; return hash; }
      if (method === 'eth_blockNumber') return '0x64';
      if (method === 'eth_getTransactionReceipt') return { transactionHash: hash, transactionIndex: '0x0', blockHash, blockNumber: '0x64',
        from: manifest.keeper, to: market.pool, contractAddress: null, cumulativeGasUsed: '0x1', gasUsed: '0x1',
        effectiveGasPrice: '0x1', logs: [], logsBloom: `0x${'00'.repeat(256)}`, status: '0x1', type: '0x0' };
      assert.equal(method, 'eth_call'); assert.ok(Array.isArray(params));
      const call: unknown = params[0]; assert.ok(typeof call === 'object' && call !== null);
      const data: unknown = Reflect.get(call, 'data'); assert.ok(typeof data === 'string' && isHex(data));
      const { functionName } = decodeFunctionData({ abi: KEEPER_ABI, data });
      const result = (value: Parameters<typeof encodeFunctionResult<typeof KEEPER_ABI, typeof functionName>>[0]['result']) => encodeFunctionResult({ abi: KEEPER_ABI, functionName, result: value });
      if (sends && ((functionName === 'slot0' && fault === 'slot') || (functionName === 'balanceOf' && fault === 'balance'))) throw new HttpRequestError({ url: 'https://private-token.invalid/key', status: 503 });
      switch (functionName) {
        case 'token0': return result(market.token);
        case 'slot0': return result([sends && fault !== 'wrong price' ? limit : sqrt, 1, 0, 600, 600, 0, true]);
        case 'observations': return result([1000, 1n, 1n, true]);
        case 'quoteExactInputSingle': return result([1n, limit, 0, 1n]);
        case 'balanceOf': return result(10n ** 40n - (sends && fault !== 'zero spend' ? 1n : 0n));
        case 'allowance': return result(10n ** 40n);
        default: assert.fail('unexpected swap read');
      }
    } }, { retryCount: 0 });
    const chain = createKeeperChain('http://127.0.0.1:1', { address: manifest.keeper, type: 'json-rpc' }, manifest, () => {}, transport);
    const observation = { market, spotE18: price, twapE18: price, lastObservation: 1000n, feedUpdatedAt: null };
    if (!fault) await chain.io.swap(observation, target, 10_000n * 10n ** 18n);
    else await assert.rejects(chain.io.swap(observation, target, 10_000n * 10n ** 18n), (error: unknown) => {
      assert.equal(isTransientRpcError(error), false, fault);
      assert.match(safeReason(error), fault === 'slot' || fault === 'balance' ? /swap result verification unavailable/ : /swap result mismatch/);
      assert.doesNotMatch(safeReason(error), /private-token|https:/); return true;
    });
    assert.equal(sends, 1, fault);
  }
});

test('#162 startup retries verification with bounded backoff, recovers, times out and handles shutdown without signing', { timeout: 10_000 }, async () => {
  const env = { PRICE_KEEPER_ENABLED: '1', PRICE_KEEPER_RPC_URL: 'http://127.0.0.1:8562',
    PRICE_KEEPER_PRIVATE_KEY: `0x${'0'.repeat(63)}1`, PRICE_KEEPER_START_TIMESTAMP: '1000',
    PRICE_KEEPER_SCENARIO: 'scripts/price-scenarios/gentle-rise.json', PRICE_KEEPER_MANIFEST: 'manifest.json' };
  for (const mode of ['recover', 'timeout', 'stop', 'permanent', 'runtime'] as const) {
    const result = await runScript('scripts/price-keeper.ts', { ...env,
      PRICE_KEEPER_RPC_FAILURE_TIMEOUT_SECONDS: mode === 'timeout' ? '1' : '1800' }, `
      const { mock } = await import('bun:test');
      const chainPath = ${JSON.stringify(new URL('../src/keeper/chain.ts', import.meta.url).pathname)};
      const originalChain = await import(chainPath);
      const fs = await import('node:fs/promises');
      const originalReadFile = fs.readFile;
      const { HttpRequestError } = await import('viem');
      const mode = ${JSON.stringify(mode)};
      let attempts = 0; let heads = 0;
      mock.module('node:fs/promises', () => ({ ...fs, readFile: async (path, encoding) =>
        path === 'manifest.json' ? ${JSON.stringify(JSON.stringify(manifestInput()))} : originalReadFile(path, encoding) }));
      mock.module(chainPath, () => ({ ...originalChain, createKeeperChain: () => ({
        io: { head: async () => {
          heads++; console.log('headAttempt=' + heads);
          if (heads === 2) queueMicrotask(() => process.emit('SIGTERM'));
          throw new HttpRequestError({ url: 'https://private-token.invalid/key', status: 503 });
        } }, verify: async () => {
          attempts++; console.log('verifyAttempt=' + attempts);
          if (mode === 'runtime') return;
          if (mode === 'permanent') throw new Error('feed keeper mismatch');
          if (mode === 'stop') queueMicrotask(() => process.emit('SIGTERM'));
          if (mode !== 'recover' || attempts < 2) throw new HttpRequestError({ url: 'https://private-token.invalid/key', status: 503 });
          console.log('verify recovered'); process.emit('SIGTERM');
        }
      }) }));
    `);
    assert.doesNotMatch(result.output, /private-token|https:/);
    if (mode === 'recover') {
      assert.equal(result.code, 0, result.output); assert.match(result.output, /verify recovered/);
      assert.match(result.output, /retryMs=2000/);
      assert.equal([...result.output.matchAll(/verifyAttempt=/g)].length, 2);
      assert.doesNotMatch(result.output, /critical/);
    } else if (mode === 'runtime') {
      assert.equal(result.code, 0, result.output);
      assert.equal([...result.output.matchAll(/headAttempt=/g)].length, 2);
      assert.match(result.output, /retryMs=2000/); assert.doesNotMatch(result.output, /critical/);
    } else if (mode === 'stop') {
      assert.equal(result.code, 0); assert.match(result.output, /verifyAttempt=1/);
      assert.doesNotMatch(result.output, /verifyAttempt=2|critical/);
    } else {
      assert.equal(result.code, 1);
      assert.match(result.output, mode === 'timeout' ? /啟動失敗.*verify.*RPC failure timeout exceeded/ : /啟動失敗.*verify.*feed keeper mismatch/);
      assert.equal([...result.output.matchAll(/verifyAttempt=/g)].length, 1);
    }
  }
});

test('#162 startup file, JSON and scenario reasons are specific without leaking file paths or contents', async () => {
  const env = { PRICE_KEEPER_ENABLED: '1', PRICE_KEEPER_RPC_URL: 'http://127.0.0.1:8562',
    PRICE_KEEPER_PRIVATE_KEY: `0x${'0'.repeat(63)}1`, PRICE_KEEPER_START_TIMESTAMP: '1000',
    PRICE_KEEPER_SCENARIO: '/missing/private-token', PRICE_KEEPER_MANIFEST: '/missing/private-manifest' };
  const missing = await runScript('scripts/price-keeper.ts', env);
  assert.equal(missing.code, 1); assert.match(missing.output, /啟動失敗.*scenario.*ENOENT/);
  assertNoSecretSlices(missing.output, env.PRICE_KEEPER_SCENARIO);
  for (const [value, reason] of [['{private-token', 'invalid scenario JSON'], ['{}', 'unexpected or missing fields']] as const) {
    const result = await runScript('scripts/price-keeper.ts', env, `
      const { mock } = await import('bun:test');
      const fs = await import('node:fs/promises');
      mock.module('node:fs/promises', () => ({ ...fs, readFile: async () => ${JSON.stringify(value)} }));
    `);
    assert.equal(result.code, 1); assert.ok(result.output.includes('scenario: ' + reason));
    assert.doesNotMatch(result.output, /private-token|private-manifest|\/missing/);
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
    assert.equal(result.code, 1); assert.match(result.output, /啟動失敗.*configuration.*invalid keeper signing configuration/); assert.equal(messages.length, 1);
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
