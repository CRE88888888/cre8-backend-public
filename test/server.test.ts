import assert from 'node:assert/strict';
import { AuthStore } from '../src/auth.js';
import { loadRateLimitConfig, loadRelayerGasConfig } from '../src/config.js';
import { MemoryRateLimitStore, RateLimitError, RequestRateLimiter } from '../src/ratelimit.js';
import type { RateLimitStore, WalletAction } from '../src/ratelimit.js';
import type { ServerDeps } from '../src/server.js';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

import { execFile } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { createPublicClient, custom, decodeFunctionData, encodeAbiParameters, http, isHex, toHex, zeroAddress } from 'viem';
import { createPlatformStatusReader, EXECUTOR_BUY_ABI, EXECUTOR_PAUSE_ABI, PLATFORM_STATUS_CACHE_TTL_MS, PLATFORM_STATUS_RPC_TIMEOUT_MS } from '../src/chain.js';
import type { PlatformStatusConfig } from '../src/chain.js';
import { closePool, query as dbQuery } from '../src/db.js';
import { createServer, resolveOperatorWallets } from '../src/server.js';
import { assertNoSecretSlices, runScript } from './fixtures/secret-output.js';

test('#59 nonce flood stops at the IP allowance', async () => {
  const server = createServer({ rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), undefined, () => 1_000) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    for (let i = 0; i < 120; i++) {
      const response = await fetch(`http://127.0.0.1:${port}/auth/nonce`, { method: 'POST' });
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    }
    const response = await fetch(`http://127.0.0.1:${port}/auth/nonce`, { method: 'POST' });
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get('retry-after')) > 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test('#56 API validates malformed session config before migration or listening', async () => {
  const seed = '0123456789abcdef'.repeat(4);
  for (const raw of [seed, `0x${seed.slice(1)}`, `0x${seed}0`, `"0x${seed}"`]) {
    const result = await runScript('src/index.ts', { SESSION_KEY_MASTER_SEED: raw, MIGRATIONS_ENABLED: '1' });
    assert.equal(result.code, 1);
    assert.match(result.output, /startup failed/);
    assert.match(result.output, /SESSION_KEY_MASTER_SEED/);
    assert.doesNotMatch(result.output, /migrations|listening|ENOENT|ECONNREFUSED/);
    assertNoSecretSlices(result.output, seed);
  }
});

test('#56 API starts with missing/blank seed and accepts a valid 32-byte seed', async () => {
  for (const seed of [undefined, '', '   ', `0x${'01'.repeat(32)}`]) {
    const result = await runScript('src/index.ts', { SESSION_KEY_MASTER_SEED: seed }, `
      const originalLog = console.log;
      console.log = (...args) => {
        originalLog(...args);
        if (args.some(arg => String(arg).includes('cre8-atp-backend listening'))) {
          process.kill(process.pid, 'SIGTERM');
        }
      };
    `);
    assert.equal(result.code, 0);
    assert.match(result.output, /cre8-atp-backend listening/);
    assert.match(result.output, /shutting down/);
  }
});

test('#56 API rejects an invalid executor before migration without echoing its value', async () => {
  const secret = 'misplaced-secret-key-value';
  const result = await runScript('src/index.ts', { EXECUTOR_ADDRESS: secret, MIGRATIONS_ENABLED: '1' });
  assert.equal(result.code, 1);
  assert.match(result.output, /EXECUTOR_ADDRESS/);
  assert.doesNotMatch(result.output, /migrations|listening|ENOENT|ECONNREFUSED/);
  assertNoSecretSlices(result.output, secret);
});

test('POST /platform/status returns 405 with Allow: GET before reading any dependencies', async () => {
  const server = createServer({ platformStatus: async () => { throw new Error('must not read'); } });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/platform/status`, { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('OPERATOR_WALLETS：未設定或空值一律拒絕；多個地址去空白並統一大小寫', () => {
  const operator = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65';
  const other = '0x976EA74026E726554dB657fA54763abd0C3a0aa9';
  assert.deepEqual(resolveOperatorWallets({}), []);
  assert.deepEqual(resolveOperatorWallets({ OPERATOR_WALLETS: '  ' }), []);
  assert.deepEqual(resolveOperatorWallets({ OPERATOR_WALLETS: ` ${operator}, ${other} ` }),
    [operator.toLowerCase(), other.toLowerCase()]);
});

test('OPERATOR_WALLETS：萬用字元、零地址、錯誤地址或空項目拒絕整份設定', () => {
  const operator = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65';
  for (const raw of ['*', '0x1234', '0x' + '0'.repeat(40), `${operator},*`, `${operator},`, `,${operator}`]) {
    assert.throws(() => resolveOperatorWallets({ OPERATOR_WALLETS: raw }), (error: unknown) => {
      assert.equal((error as { status: number }).status, 503);
      assert.equal((error as { code: string }).code, 'INVALID_OPERATOR_WALLETS');
      return true;
    });
  }
});

/**
 * `GET /health` 的告警欄位。
 *
 * 這一組**故意走真的 HTTP**（`createServer()` + 真的 Postgres），不是只測那個純函式：
 * `/health` 的價值在「一台機器 curl 得到的 JSON」，而 `status`／HTTP 碼／`alerts` 三者的關係
 * （degraded 但 **200**、`alerts: null` 不影響 status）只有在完整的請求路徑上才驗得出來。
 *
 * 為什麼 degraded 一定要是 200：把 503 用在「有 critical 告警」上，會讓負載平衡器把一個**能正常
 * 服務**的實例下線 —— 「該看一下」變成「服務中斷」。503 留給 Postgres 掛掉。
 *
 * 需要真 DB（`DATABASE_URL`）與 0013；不可用時明確 skip。
 */

type HealthBody = {
  status: 'ok' | 'degraded';
  db: 'ok' | 'down';
  chainId: number;
  alerts: { critical: number; warn: number; open: number } | null;
};

const dbSkip = await (async (): Promise<string | null> => {
  try {
    await dbQuery('select 1 from scheduler_alerts limit 0');
    return null;
  } catch (cause) {
    return `Postgres 或 0013 不可用（${cause instanceof Error ? cause.message : String(cause)}）`;
  }
})();
if (dbSkip !== null) console.warn(`[server] /health 的測試 skip：${dbSkip}`);
const dbGate = dbSkip === null ? {} : { skip: dbSkip };

/** 起一個真的伺服器（port 0 = 讓 OS 挑），回傳打 `/health` 的函式與收工用的 close。 */
async function startServer(): Promise<{ health: () => Promise<{ status: number; body: HealthBody }>; close: () => Promise<void> }> {
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;

  return {
    health: async () => {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      return { status: response.status, body: (await response.json()) as HealthBody };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

after(async () => {
  await closePool().catch(() => {
    // DB 不可用時整組本來就 skip 了。
  });
});

test('GET /health：200，alerts 是計數物件，status 與「有沒有 critical」一致', dbGate, async () => {
  const { health, close } = await startServer();
  try {
    const { status, body } = await health();
    console.log(`[server] /health（一般情況）HTTP ${status} ${JSON.stringify(body)}`);

    assert.equal(status, 200, 'Postgres 活著就是 200');
    assert.equal(body.db, 'ok');
    assert.ok(body.alerts !== null, '警示表正常時 alerts 是計數物件（不是 null）');
    const alerts = body.alerts as { critical: number; warn: number; open: number };
    assert.equal(alerts.open, alerts.critical + alerts.warn);
    assert.equal(
      body.status,
      alerts.critical > 0 ? 'degraded' : 'ok',
      'critical 未解決 → degraded；否則 ok（HTTP 碼不受影響）',
    );
  } finally {
    await close();
  }
});

test('GET /health：有 critical 未解決 → status degraded，HTTP 仍是 200，alerts 計數含它', dbGate, async () => {
  // 只造一列 portfolio 無關的 critical（外鍵不需要 portfolio；收工時用它自己的 id 刪掉）。
  await dbQuery("delete from scheduler_alerts where kind = 'gas_low' and portfolio_id is null and resolved_at is null").catch(() => undefined);
  const seeded = await dbQuery<{ id: string }>(
    `insert into scheduler_alerts (kind, severity, portfolio_id, detail)
     values ('gas_low', 'critical', null, '測試用：portfolio 無關的 gas 告警')
     returning id`,
  );
  const seededId = Number(seeded.rows[0]?.id);

  const { health, close } = await startServer();
  try {
    const { status, body } = await health();
    console.log(`[server] /health（塞一筆 critical）HTTP ${status} ${JSON.stringify(body)}`);

    assert.equal(status, 200, '⚠ 服務還活著：degraded 不等於 503（503 只給 Postgres 掛掉）');
    assert.equal(body.status, 'degraded');
    assert.equal(body.db, 'ok');
    assert.ok((body.alerts?.critical ?? 0) >= 1);
    assert.ok((body.alerts?.open ?? 0) >= 1);
  } finally {
    await close();
    if (Number.isInteger(seededId)) {
      await dbQuery('delete from scheduler_alerts where id = $1', [seededId]).catch(() => undefined);
    }
  }
});

/**
 * `alerts: null`（警示表壞掉）在這裡沒有對應的 HTTP 測試：那需要一張真的壞掉的表，而共用 DB 上
 * 做不到也不該做。它的定義（讀失敗 → `alerts: null`、status 不受影響）由 `alerts.test.ts` 的
 * `healthStatusFor('ok', null)` 釘住 —— 那個函式是 `health()` 裡唯一決定 status 的地方。
 */

const PLATFORM_CONFIG: PlatformStatusConfig = {
  chainId: 1337,
  executor: '0x0000000000000000000000000000000000000044',
  registry: '0x0000000000000000000000000000000000000045',
  rpcUrl: 'http://127.0.0.1:8596',
};

/** Real viem encoding/decoding, with a local transport that accepts only the three read methods. */
function platformRpc() {
  const state = {
    chainId: 1337, block: 123n, globalPaused: false, maxBuyBps: 10_000,
    fail: '', missing: '', pauseData: '', buyData: '',
    wait: Promise.resolve(),
  };
  const calls: { method: string; params: unknown }[] = [];
  const request = async ({ method, params }: { method: string; params?: unknown }): Promise<string> => {
    calls.push({ method, params });
    await state.wait;
    if (state.fail === method) throw new Error('private RPC URL / token / internal error must stay private');
    if (method === 'eth_chainId') return toHex(state.chainId);
    if (method === 'eth_blockNumber') return toHex(state.block);
    assert.equal(method, 'eth_call', 'the public endpoint must never send transactions');
    assert.ok(Array.isArray(params));
    const call: unknown = params[0];
    assert.ok(call !== null && typeof call === 'object' && 'data' in call && typeof call.data === 'string');
    assert.ok('to' in call);
    assert.equal(call.to, PLATFORM_CONFIG.executor);
    assert.equal(params[1], toHex(state.block), 'both contract reads must use the advertised block');
    assert.ok(isHex(call.data));
    const { functionName } = decodeFunctionData({ abi: [...EXECUTOR_PAUSE_ABI, ...EXECUTOR_BUY_ABI], data: call.data });
    if (state.fail === functionName) throw new Error('private RPC URL / token / internal error must stay private');
    if (state.missing === functionName) return '0x';
    if (functionName === 'globalPaused') return state.pauseData || encodeAbiParameters([{ type: 'bool' }], [state.globalPaused]);
    assert.equal(functionName, 'maxBuyBps');
    return state.buyData || encodeAbiParameters([{ type: 'uint16' }], [state.maxBuyBps]);
  };
  const client = createPublicClient({ transport: custom({ request }, { retryCount: 0 }) });
  return { state, calls, request, client };
}

async function withPlatformServer(
  reader: ReturnType<typeof createPlatformStatusReader>,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const server = createServer({ platformStatus: reader });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== 'string');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

for (const [globalPaused, maxBuyBps, block] of [
  [false, 10_000, 123n], [true, 10_000, 124n], [false, 0, 0n],
  [false, 20_000, 125n], [false, 65_535, 9_007_199_254_740_993n],
] as const) {
  test(`public platform status: paused=${globalPaused}, maxBuyBps=${maxBuyBps}, block=${block}`, async () => {
    const rpc = platformRpc();
    Object.assign(rpc.state, { globalPaused, maxBuyBps, block });
    const now = Date.parse('2026-11-13T06:00:00.000Z');
    const reader = createPlatformStatusReader({ config: () => PLATFORM_CONFIG, publicClient: rpc.client, now: () => now });
    await withPlatformServer(reader, async (base) => {
      const response = await fetch(`${base}/platform/status`, { headers: { origin: 'http://localhost:5173' } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5173');
      const body: unknown = await response.json();
      assert.deepEqual(body, {
        chainId: PLATFORM_CONFIG.chainId, executor: PLATFORM_CONFIG.executor, registry: PLATFORM_CONFIG.registry,
        globalPaused, maxBuyBps, checkedAt: new Date(now).toISOString(), block: block.toString(),
      });
      // An irrelevant/expired token must not turn a public request into a DB/auth lookup.
      const again = await fetch(`${base}/platform/status`, { headers: { authorization: 'Bearer invalid' } });
      assert.equal(again.status, 200);
      assert.deepEqual(await again.json(), body);
      assert.equal(rpc.calls.length, 4, 'the second visitor must hit the shared cache');
    });
  });
}

for (const fail of ['eth_chainId', 'eth_blockNumber', 'globalPaused', 'maxBuyBps']) {
  test(`platform status returns sanitized 503/null when ${fail} fails`, async () => {
    const rpc = platformRpc();
    rpc.state.fail = fail;
    const reader = createPlatformStatusReader({ config: () => PLATFORM_CONFIG, publicClient: rpc.client });
    await withPlatformServer(reader, async (base) => {
      const response = await fetch(`${base}/platform/status`);
      assert.equal(response.status, 503);
      const body: unknown = await response.json();
      assert.ok(body !== null && typeof body === 'object');
      assert.deepEqual(Object.keys(body).sort(), ['block', 'chainId', 'checkedAt', 'executor', 'globalPaused', 'maxBuyBps', 'registry']);
      assert.ok('globalPaused' in body && 'maxBuyBps' in body && 'block' in body);
      assert.equal(body.globalPaused, null);
      assert.equal(body.maxBuyBps, null);
      assert.equal(body.block, null);
      assert.doesNotMatch(JSON.stringify(body), /private|token|internal|http|RPC/);
    });
  });
}

for (const missing of ['globalPaused', 'maxBuyBps']) {
  test(`missing ${missing} contract return data is unknown, never false/zero`, async () => {
    const rpc = platformRpc();
    rpc.state.missing = missing;
    const status = await createPlatformStatusReader({ config: () => PLATFORM_CONFIG, publicClient: rpc.client })();
    assert.equal(status.globalPaused, null);
    assert.equal(status.maxBuyBps, null);
    assert.equal(status.block, null);
  });
}

test('wrong RPC network and malformed ABI values never produce an available snapshot', async () => {
  for (const invalid of ['chain', 'bps', 'bool']) {
    const rpc = platformRpc();
    if (invalid === 'chain') rpc.state.chainId = 56;
    else if (invalid === 'bps') rpc.state.buyData = toHex(65_536n, { size: 32 });
    else rpc.state.pauseData = toHex(2n, { size: 32 });
    const status = await createPlatformStatusReader({ config: () => PLATFORM_CONFIG, publicClient: rpc.client })();
    assert.equal(status.globalPaused, null);
    assert.equal(status.maxBuyBps, null);
    assert.equal(status.block, null);
    if (invalid === 'chain') assert.equal(rpc.calls.filter((call) => call.method === 'eth_call').length, 0);
  }
});

for (const overrides of [
  { executor: null }, { registry: null }, { rpcUrl: null }, { executor: zeroAddress }, { registry: zeroAddress },
]) {
  test(`missing/nonusable platform configuration ${JSON.stringify(overrides)} makes no RPC calls`, async () => {
    const rpc = platformRpc();
    const status = await createPlatformStatusReader({ config: () => ({ ...PLATFORM_CONFIG, ...overrides }), publicClient: rpc.client })();
    assert.equal(status.globalPaused, null);
    assert.equal(status.maxBuyBps, null);
    assert.equal(status.block, null);
    assert.equal(rpc.calls.length, 0);
  });
}

test('platform cache expires exactly at its TTL; a failed refresh cannot serve stale false', async () => {
  assert.ok(PLATFORM_STATUS_CACHE_TTL_MS > 0 && PLATFORM_STATUS_CACHE_TTL_MS <= 15_000);
  const rpc = platformRpc();
  let now = 100_000;
  const reader = createPlatformStatusReader({ config: () => PLATFORM_CONFIG, publicClient: rpc.client, now: () => now });
  const first = await reader();
  rpc.state.globalPaused = true;
  now += PLATFORM_STATUS_CACHE_TTL_MS - 1;
  assert.deepEqual(await reader(), first);
  assert.equal(rpc.calls.length, 4);
  now += 1;
  const paused = await reader();
  assert.equal(paused.globalPaused, true);
  assert.notEqual(paused.checkedAt, first.checkedAt);
  assert.equal(rpc.calls.length, 8);
  rpc.state.globalPaused = false;
  now += PLATFORM_STATUS_CACHE_TTL_MS;
  assert.equal((await reader()).globalPaused, false);
  rpc.state.fail = 'maxBuyBps';
  now += PLATFORM_STATUS_CACHE_TTL_MS;
  const unavailable = await reader();
  assert.equal(unavailable.globalPaused, null);
  const failedCalls = rpc.calls.length;
  rpc.state.fail = '';
  now += PLATFORM_STATUS_CACHE_TTL_MS - 1;
  assert.deepEqual(await reader(), unavailable, 'cache failures to limit RPC traffic during outages');
  assert.equal(rpc.calls.length, failedCalls);
  now += 1;
  assert.equal((await reader()).globalPaused, false, 'retry after the failure TTL');
  assert.equal(rpc.calls.length, failedCalls + 4);
});

test('concurrent platform visitors share one in-flight read; slow reads do not extend freshness', async () => {
  const rpc = platformRpc();
  let release = () => {};
  rpc.state.wait = new Promise<void>((resolve) => { release = resolve; });
  let now = 100_000;
  const reader = createPlatformStatusReader({ config: () => PLATFORM_CONFIG, publicClient: rpc.client, now: () => now });
  const first = reader();
  now += PLATFORM_STATUS_CACHE_TTL_MS;
  const second = reader();
  assert.equal(first, second);
  release();
  assert.deepEqual(await first, await second);
  assert.equal(rpc.calls.length, 4);
  rpc.state.globalPaused = true;
  assert.equal((await reader()).globalPaused, true, 'expired observation is refreshed immediately after completion');
  assert.equal(rpc.calls.length, 8);
  now -= 1;
  await reader();
  assert.equal(rpc.calls.length, 12, 'a clock rollback must not lengthen cache freshness');
});

test('platform RPC HTTP timeout yields unknown state and does not retry', async () => {
  assert.ok(PLATFORM_STATUS_RPC_TIMEOUT_MS > 0 && PLATFORM_STATUS_RPC_TIMEOUT_MS <= 5_000);
  let calls = 0;
  const server = createHttpServer(() => { calls += 1; });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== 'string');
    const client = createPublicClient({ transport: http(`http://127.0.0.1:${address.port}`, { timeout: 25, retryCount: 0 }) });
    const status = await createPlatformStatusReader({ config: () => PLATFORM_CONFIG, publicClient: client })();
    assert.equal(status.globalPaused, null);
    assert.equal(status.block, null);
    assert.equal(calls, 2, 'chain id and block requests each time out once');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('default public reader handles a down DB, unused signing configuration, missing settings and RPC errors safely', async () => {
  const rpc = platformRpc();
  const server = createHttpServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const payload: unknown = JSON.parse(raw);
    assert.ok(payload !== null && typeof payload === 'object' && 'method' in payload && typeof payload.method === 'string');
    assert.ok('id' in payload);
    res.setHeader('content-type', 'application/json');
    try {
      const result = await rpc.request({ method: payload.method, params: 'params' in payload ? payload.params : undefined });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }));
    } catch {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, error: { code: -32000, message: 'private RPC URL / token / internal error must stay private' } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== 'string');
    for (const scenario of [
      { env: {}, available: true, reads: 4, fail: '' },
      { env: { EXECUTOR_ADDRESS: '' }, available: false, reads: 0, fail: '' },
      { env: { EXECUTOR_ADDRESS: 'invalid-address' }, available: false, reads: 0, fail: '' },
      { env: { REGISTRY_ADDRESS: '' }, available: false, reads: 0, fail: '' },
      { env: { REGISTRY_ADDRESS: 'invalid-address' }, available: false, reads: 0, fail: '' },
      { env: { RPC_URL: '' }, available: false, reads: 0, fail: '' },
      { env: {}, available: false, reads: 4, fail: 'eth_call' },
    ]) {
      rpc.state.fail = scenario.fail;
      const before = rpc.calls.length;
      const script = `
      import assert from 'node:assert/strict';
      import { createServer } from ${JSON.stringify(new URL('../src/server.ts', import.meta.url).href)};
      const server = createServer();
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const base = 'http://127.0.0.1:' + server.address().port;
        const first = await fetch(base + '/platform/status');
        const body = await first.json();
        assert.equal(first.status, ${scenario.available ? 200 : 503});
        assert.equal(body.chainId, 1337);
        assert.equal(body.globalPaused, ${scenario.available ? 'false' : 'null'});
        assert.equal(body.maxBuyBps, ${scenario.available ? '10000' : 'null'});
        assert.equal(body.block, ${scenario.available ? "'123'" : 'null'});
        assert.doesNotMatch(JSON.stringify(body), /private|token|internal|http|RPC|invalid-address/);
        const second = await fetch(base + '/platform/status');
        assert.deepEqual(await second.json(), body);
      } finally { await new Promise(resolve => server.close(resolve)); }
    `;
      const result = await promisify(execFile)(process.execPath, ['--eval', script], {
        cwd: process.cwd(), timeout: 10_000,
        env: {
          ...process.env, DATABASE_URL: 'postgres://ci:ci@127.0.0.1:1/unused', CHAIN_ID: String(PLATFORM_CONFIG.chainId),
          RPC_URL: `http://127.0.0.1:${address.port}`, EXECUTOR_ADDRESS: PLATFORM_CONFIG.executor ?? '',
          REGISTRY_ADDRESS: PLATFORM_CONFIG.registry ?? '', OPERATOR_PRIVATE_KEY: '', SESSION_KEY_MASTER_SEED: 'unused-invalid-seed',
          ...scenario.env,
        },
      });
      assert.equal(rpc.calls.length - before, scenario.reads, 'default server dependencies must cache successes and failures');
      assert.doesNotMatch(result.stdout + result.stderr, /private RPC|must stay private|unused-invalid-seed|invalid-address/);
      assert.ok(!(result.stdout + result.stderr).includes(`http://127.0.0.1:${address.port}`), 'RPC URL must never reach logs');
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

// #59: all of these route tests use real SIWE recovery with an isolated session repository.
async function withBudgetServer(run: (base: string) => Promise<void>, overrides: Partial<ServerDeps> = {}) {
  const rows = new Map<string, { wallet: string; expiresAt: Date }>();
  const auth = new AuthStore({ auth: { authDomain: 'localhost', authUri: 'http://localhost', chainId: 1337 }, sessions: {
    save: async (hash, wallet, expiresAt) => { rows.set(hash, { wallet, expiresAt }); },
    find: async (hash) => rows.get(hash) ?? null,
    remove: async (hash) => { rows.delete(hash); },
    prune: async () => {},
  } });
  const server = createServer({
    auth: { issueNonce: () => auth.issueNonce(), login: (message, signature) => auth.login(message, signature),
      authenticate: (header) => auth.authenticate(header), logout: (header) => auth.logout(header) },
    ...overrides,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await run(`http://127.0.0.1:${address.port}`);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

async function budgetToken(base: string, account = privateKeyToAccount(generatePrivateKey())) {
  const challenge: unknown = await (await fetch(`${base}/auth/nonce`, { method: 'POST' })).json();
  assert.ok(typeof challenge === 'object' && challenge !== null);
  const field = (name: string): string => {
    const value: unknown = Reflect.get(challenge, name);
    assert.equal(typeof value, 'string');
    return String(value);
  };
  const message = createSiweMessage({ address: account.address, domain: field('domain'), uri: field('uri'),
    statement: field('statement'), nonce: field('nonce'), version: '1', chainId: 1337, issuedAt: new Date(field('issuedAt')) });
  const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, signature: await account.signMessage({ message }) }) });
  assert.equal(response.status, 200);
  const result: unknown = await response.json();
  assert.ok(typeof result === 'object' && result !== null);
  const token: unknown = Reflect.get(result, 'token');
  assert.equal(typeof token, 'string');
  return String(token);
}

test('#59 memory budget is atomic at zero, limit, limit+1, UTC boundary and capacity', async () => {
  const store = new MemoryRateLimitStore(2);
  const policy = { limit: 2, windowMs: 60_000 };
  assert.deepEqual(await store.consume('zero', { ...policy, limit: 0 }, 0), { allowed: false, retryAfterSeconds: 60 });
  const decisions = await Promise.all(Array.from({ length: 8 }, () => store.consume('a', policy, 0)));
  assert.equal(decisions.filter((decision) => decision.allowed).length, 2);
  assert.deepEqual(await store.consume('a', policy, 59_999), { allowed: false, retryAfterSeconds: 1 });
  assert.equal((await store.consume('b', policy, 59_999)).allowed, true);
  await assert.rejects(store.consume('c', policy, 59_999), { status: 503, code: 'RATE_LIMIT_CAPACITY' });
  assert.equal((await store.consume('a', policy, 59_999)).allowed, false, 'capacity pressure never resets active buckets');
  assert.equal((await store.consume('c', policy, 60_000)).allowed, true, 'expired keys are reclaimed exactly at reset');
  assert.equal((await store.consume('a', policy, 60_000)).allowed, true);
  for (const limit of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(store.consume('x', { ...policy, limit }, 0), RangeError);
  }
  for (const windowMs of [0, -1, 0.5]) await assert.rejects(store.consume('x', { ...policy, windowMs }, 0), RangeError);
  for (const now of [-1, 0.5, Number.NaN]) await assert.rejects(store.consume('x', policy, now), RangeError);
  for (const size of [0, -1, 0.5]) assert.throws(() => new MemoryRateLimitStore(size), RangeError);
});

test('#59 wallet, operation and IP budgets are independent; casing and new tokens cannot reset wallets', async () => {
  let now = 0;
  const config = loadRateLimitConfig({ RATE_LIMIT_STRATEGIES_PER_DAY: '1', RATE_LIMIT_AUTH_PER_MINUTE: '1' });
  const limiter = new RequestRateLimiter(config, undefined, () => now);
  await limiter.wallet('strategies', '0xAB');
  await assert.rejects(limiter.wallet('strategies', '0xab'), RateLimitError);
  await limiter.wallet('strategies', '0xcd');
  await limiter.wallet('versions', '0xab');
  await limiter.auth('192.0.2.1');
  await assert.rejects(limiter.auth('192.0.2.1'), RateLimitError);
  await limiter.auth('192.0.2.2');
  now = 86_399_999;
  await assert.rejects(limiter.wallet('strategies', '0xab'), (error: unknown) => error instanceof RateLimitError && error.retryAfterSeconds === 1);
  now++;
  await limiter.wallet('strategies', '0xab');
});

test('#59 proxy trust walks right-to-left, isolates users and rejects forged or malformed forwarding', () => {
  const direct = new RequestRateLimiter(loadRateLimitConfig({}));
  assert.equal(direct.clientIp('::ffff:127.0.0.1', '192.0.2.2'), '127.0.0.1');
  assert.equal(direct.clientIp('::FFFF:127.0.0.1', undefined), '127.0.0.1');
  assert.equal(direct.clientIp('::ffff:7f00:1', undefined), '127.0.0.1');
  const mapped = new RequestRateLimiter({ ...loadRateLimitConfig({}), trustedProxyIps: ['::ffff:7f00:1'] });
  assert.equal(mapped.clientIp('::ffff:127.0.0.1', '192.0.2.1'), '192.0.2.1');
  const limiter = new RequestRateLimiter({ ...loadRateLimitConfig({}), trustedProxyIps: ['127.0.0.1', '::1'] });
  assert.equal(limiter.clientIp('127.0.0.1', '198.51.100.1, 192.0.2.1'), '192.0.2.1');
  assert.equal(limiter.clientIp('127.0.0.1', '198.51.100.1, 192.0.2.2'), '192.0.2.2');
  assert.equal(limiter.clientIp('::1', '192.0.2.1, 127.0.0.1'), '192.0.2.1');
  assert.equal(limiter.clientIp('127.0.0.1', ['192.0.2.1']), '127.0.0.1');
  for (const header of ['', 'bad-ip', '192.0.2.1,', Array(21).fill('127.0.0.1').join(',')]) {
    assert.equal(limiter.clientIp('127.0.0.1', header), '127.0.0.1');
  }
  assert.equal(limiter.clientIp(undefined, '192.0.2.1'), 'unknown');
  assert.equal(limiter.clientIp('2001:0db8::1', undefined), '[2001:db8::1]');
  assert.throws(() => new RequestRateLimiter({ ...loadRateLimitConfig({}), trustedProxyIps: ['private-token'] }), /RATE_LIMIT_TRUSTED_PROXY_IPS/);
});

test('#59 config validates budgets, nonce capacity and relayer wei without echoing raw values', () => {
  const names = ['RATE_LIMIT_AUTH_PER_MINUTE', 'RATE_LIMIT_STRATEGIES_PER_DAY', 'RATE_LIMIT_VERSIONS_PER_DAY',
    'RATE_LIMIT_PORTFOLIOS_PER_DAY', 'RATE_LIMIT_PLAN_PER_MINUTE', 'RATE_LIMIT_REDEEM_PER_MINUTE',
    'RATE_LIMIT_CLOSE_PER_MINUTE', 'RATE_LIMIT_ASSETS_PER_MINUTE'];
  for (const name of names) {
    assert.ok(Object.values(loadRateLimitConfig({ [name]: '0' })).includes(0));
    for (const raw of ['secret-invalid-value', '-1', '0.5', '1000001', 'Infinity']) {
      assert.throws(() => loadRateLimitConfig({ [name]: raw }), (error: unknown) => {
        assert.ok(error instanceof Error && error.message.includes(name) && !error.message.includes(raw));
        return true;
      });
    }
  }
  for (const raw of ['0', '-1', '1.5', '1000001']) assert.throws(() => loadRateLimitConfig({ AUTH_MAX_NONCES: raw }));
  assert.equal(loadRateLimitConfig({ AUTH_MAX_NONCES: '1' }).maxNonces, 1);
  assert.equal(loadRelayerGasConfig({ MIN_RELAYER_GAS_WEI: '9007199254740993' }).minRelayerGasWei, 9007199254740993n);
  assert.equal(loadRelayerGasConfig({ MIN_RELAYER_GAS_WEI: '0' }).minRelayerGasWei, 0n);
  for (const raw of ['-1', '0x10', '1.5', 'secret-invalid-value']) assert.throws(() => loadRelayerGasConfig({ MIN_RELAYER_GAS_WEI: raw }));
});

const budgetActions: { action: WalletAction; path: string; method: string; body?: unknown }[] = [
  { action: 'strategies', path: '/strategies', method: 'POST', body: { name: 'fund' } },
  { action: 'versions', path: '/strategies/1/versions', method: 'POST', body: {} },
  { action: 'portfolios', path: '/portfolios', method: 'POST', body: { strategyId: 1 } },
  { action: 'plan', path: '/portfolios/1/plan', method: 'GET' },
  { action: 'redeem', path: '/portfolios/1/redeem', method: 'POST', body: { usd: 1 } },
  { action: 'close', path: '/portfolios/1/close', method: 'POST' },
  { action: 'assets', path: '/assets', method: 'GET' },
];
for (const entry of budgetActions) {
  test('#59 HTTP ' + entry.action + ': authenticated wallet limit, other wallet, parallel calls and reset', async () => {
    let now = 1_000;
    let calls = 0;
    const touch = async () => { calls++; return {}; };
    const limiter = new RequestRateLimiter({ ...loadRateLimitConfig({}), strategiesPerDay: 2, versionsPerDay: 2,
      portfoliosPerDay: 2, planPerMinute: 2, redeemPerMinute: 2, closePerMinute: 2, assetsPerMinute: 2 }, undefined, () => now);
    await withBudgetServer(async (base) => {
      const account = privateKeyToAccount(generatePrivateKey());
      const firstToken = await budgetToken(base, account);
      const secondToken = await budgetToken(base, account);
      const otherToken = await budgetToken(base);
      const request = (token?: string) => fetch(base + entry.path, { method: entry.method,
        headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json', origin: 'http://localhost:5173' },
        ...(entry.body === undefined ? {} : { body: JSON.stringify(entry.body) }) });
      assert.equal((await request()).status, 401);
      const responses = await Promise.all(Array.from({ length: 5 }, (_, i) => request(i % 2 ? firstToken : secondToken)));
      assert.equal(responses.filter((r) => r.status < 300).length, 2);
      for (const r of responses.filter((r) => r.status === 429)) {
        assert.ok(Number(r.headers.get('retry-after')) >= 1);
        assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:5173');
      }
      assert.equal(calls, 2, '429 never reaches relayer/planner/DB dependency');
      assert.ok((await request(otherToken)).status < 300);
      now = 86_400_000;
      assert.ok((await request(firstToken)).status < 300);
      assert.equal(calls, 4);
    }, { rateLimiter: limiter,
      createStrategy: async (_body, provider) => { calls++; return { id: 1, provider, name: 'fund', description: '', isPublic: false, swapFeeBps: 0, onchainId: null, createdAt: new Date().toISOString() }; },
      publishVersion: async () => { calls++; return { strategyId: 1, version: 1, allocation: { assets: [] }, schedule: { kind: 'interval', intervalSeconds: 60 }, changeLog: null, activeAt: null, createdAt: new Date().toISOString() }; },
      enrollPortfolio: async (_id, userId) => { calls++; return { id: 1, userId, strategyId: 1, strategyName: 'fund', version: 1, scheduleState: 'active', createdAt: new Date().toISOString(), smartAccounts: [], gas: null }; },
      planPreview: async (portfolioId) => { calls++; return { portfolioId, outcome: 'noop', reason: 'aligned', steps: [], rationale: null }; },
      operatorRedeem: touch, operatorClose: touch, listAssets: async () => { calls++; return []; },
    });
  });
}

test('#59 HTTP: auth IP limits apply to login/nonce/logout; preflight is free and fake XFF cannot bypass', async () => {
  const limiter = new RequestRateLimiter({ ...loadRateLimitConfig({}), authPerMinute: 2 }, undefined, () => 1_000);
  await withBudgetServer(async (base) => {
    const options = await fetch(base + '/auth/nonce', { method: 'OPTIONS' });
    assert.equal(options.status, 204);
    assert.equal((await fetch(base + '/auth/login', { method: 'POST', body: '{}' })).status, 400);
    assert.equal((await fetch(base + '/auth/nonce', { method: 'POST' })).status, 200);
    const result = await fetch(base + '/auth/logout', { method: 'POST', headers: { 'x-forwarded-for': '192.0.2.3' } });
    assert.equal(result.status, 429);
    assert.equal(result.headers.get('retry-after'), '59');
  }, { rateLimiter: limiter });
});

test('#59 HTTP: trusted proxy users get separate auth budgets and logout revokes only its token', async () => {
  const limiter = new RequestRateLimiter({ ...loadRateLimitConfig({}), authPerMinute: 1, trustedProxyIps: ['127.0.0.1'] }, undefined, () => 1_000);
  await withBudgetServer(async (base) => {
    for (const ip of ['192.0.2.1', '192.0.2.2']) {
      assert.equal((await fetch(base + '/auth/nonce', { method: 'POST', headers: { 'x-forwarded-for': ip } })).status, 200);
      assert.equal((await fetch(base + '/auth/nonce', { method: 'POST', headers: { 'x-forwarded-for': ip } })).status, 429);
    }
  }, { rateLimiter: limiter });
  await withBudgetServer(async (base) => {
    const first = await budgetToken(base);
    const second = await budgetToken(base);
    const headers = { authorization: 'Bearer ' + first };
    assert.equal((await fetch(base + '/assets', { headers })).status, 200);
    for (let i = 0; i < 2; i++) assert.equal((await fetch(base + '/auth/logout', { method: 'POST', headers })).status, 204);
    assert.equal((await fetch(base + '/assets', { headers })).status, 401);
    assert.equal((await fetch(base + '/assets', { headers: { authorization: 'Bearer ' + second } })).status, 200);
    assert.equal((await fetch(base + '/auth/logout', { method: 'POST' })).status, 401);
    assert.equal((await fetch(base + '/auth/logout', { method: 'POST', headers: { authorization: 'Bearer unknown' } })).status, 204);
    assert.equal((await fetch(base + '/auth/logout')).status, 405);
  }, { listAssets: async () => [] });
});

test('#59 HTTP: failed dependencies consume attempts and unavailable budget storage fails closed', async () => {
  let calls = 0;
  await withBudgetServer(async (base) => {
    const token = await budgetToken(base);
    const request = () => fetch(base + '/portfolios/1/plan', { headers: { authorization: 'Bearer ' + token } });
    assert.equal((await request()).status, 503);
    assert.equal((await request()).status, 429);
    assert.equal(calls, 1);
  }, { rateLimiter: new RequestRateLimiter({ ...loadRateLimitConfig({}), planPerMinute: 1 }, undefined, () => 1_000),
    planPreview: async () => { calls++; throw Object.assign(new Error('database unavailable'), { code: 'ECONNREFUSED' }); } });
  const store: RateLimitStore = { consume: async () => { throw new Error('sensitive database connection'); } };
  await withBudgetServer(async (base) => {
    const response = await fetch(base + '/auth/nonce', { method: 'POST' });
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.match(text, /RATE_LIMIT_UNAVAILABLE/);
    assert.doesNotMatch(text, /sensitive/);
  }, { rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), store) });
});

test('#59 operator plan/close budgets cannot bypass the wallet limits, while unauthorized callers remain forbidden', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  let calls = 0;
  await withBudgetServer(async (base) => {
    const token = await budgetToken(base, account);
    const other = await budgetToken(base);
    for (const [path, method] of [['/operator/portfolios/1/plan', 'GET'], ['/operator/portfolios/1/close', 'POST']]) {
      const request = (value: string) => fetch(base + path, { method, headers: { authorization: 'Bearer ' + value } });
      assert.equal((await request(other)).status, 403);
      assert.equal((await request(token)).status, 200);
      const denied = await request(token);
      assert.equal(denied.status, 429);
      assert.equal(denied.headers.get('access-control-expose-headers'), 'Retry-After');
    }
    assert.equal(calls, 2);
  }, { operatorWallets: [account.address], operatorRebalanceEnabled: () => true,
    rateLimiter: new RequestRateLimiter({ ...loadRateLimitConfig({}), planPerMinute: 1, closePerMinute: 1 }, undefined, () => 1_000),
    operatorPlanPreview: async (portfolioId) => { calls++; return { portfolioId, outcome: 'noop', reason: 'aligned', steps: [], rationale: null }; },
    operatorForceClose: async () => { calls++; return {}; },
  });
});

test('#59 invalid trusted proxy configuration is rejected before serving requests', () => {
  for (const raw of ['*', '127.0.0.1,', 'fe80::1%en0', 'sensitive-invalid-value']) {
    assert.throws(() => loadRateLimitConfig({ RATE_LIMIT_TRUSTED_PROXY_IPS: raw }), (error: unknown) => {
      assert.ok(error instanceof Error && error.message.includes('RATE_LIMIT_TRUSTED_PROXY_IPS') && !error.message.includes(raw));
      return true;
    });
  }
});
