import { approvedTestAccess } from './fixtures/waitlist-access.js';
import './waitlist.test.js';
import './waitlist-access.test.js';
import './waitlist-invites.test.js';
import './strategy-execution.test.js';
import './contribution-preview.test.js';
// Keep faucet HTTP coverage in the existing no-DB CI entry point.
import './faucet.test.js';
import './gas-faucet.test.js';
import './points.test.js';
import assert from 'node:assert/strict';
// Keep the split sponsorship security/HTTP tests on this existing no-DB CI entry point.
import './paymaster.test.js';
import './paymaster-route.test.js';
import './paymaster.rpc.test.js';
import { AuthStore } from '../src/auth.js';
import { loadRateLimitConfig, loadRelayerGasConfig } from '../src/config.js';
import { MemoryRateLimitStore, RateLimitError, RequestRateLimiter } from '../src/ratelimit.js';
import type { RateLimitStore, WalletAction } from '../src/ratelimit.js';
import type { ServerDeps } from '../src/server.js';
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
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
import { createServer, resolveOperatorWallets, userOpReceiptBlock } from '../src/server.js';
import { assertNoSecretSlices, runScript } from './fixtures/secret-output.js';
import { loadPrivyConfig } from '../src/config.js';
import { SESSION_TTL_MS, sha256Hex } from '../src/auth.js';
import { AppError } from '../src/errors.js';
import { validateAllocation } from '../src/strategies.js';
import { createPrivyLogin, MAX_PRIVY_TOKEN_LENGTH } from '../src/privy.js';
import { privyFixture, privyMemory } from './fixtures/privy.js';

test('#97 bundler errors and strategy RPC failures never expose upstream credentials in HTTP or logs', async () => {
  const logs: string[] = [];
  const bodies: string[] = [];
  const original = console.error;
  console.error = (...values: unknown[]) => { logs.push(values.map(String).join(' ')); };
  const server = createServer({
    auth: { authenticate: async () => '0x1000000000000000000000000000000000000001',
      issueNonce: () => { throw new Error('unexpected'); }, login: async () => { throw new Error('unexpected'); }, logout: async () => {} },
    rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore()),
    bundlerUrl: 'https://SECRETKEY.example/path/SECRETKEY?apiKey=SECRETKEY',
    bundlerFetch: async () => { throw new Error('network failure https://SECRETKEY.example/SECRETKEY'); },
    createStrategy: async () => { throw new Error('RPC stack https://rpc.example/SECRETKEY'); },
    publishVersion: async () => { throw new Error('RPC stack https://rpc.example/SECRETKEY'); },
    operatorWallets: ['0x1000000000000000000000000000000000000001'],
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    for (const [path, body, status] of [['/bundler', { method: 'eth_chainId', id: 1, jsonrpc: '2.0', params: [] }, 502],
      ['/strategies', { name: 'fund' }, 500],
      ['/strategies/1/versions', { allocation: { assets: [{ address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', weightBps: 10000 }] }, schedule: { kind: 'interval', intervalSeconds: 60 } }, 500]] as const) {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: 'POST', body: JSON.stringify(body) });
      assert.equal(response.status, status);
      bodies.push(await response.text());
    }
    assert.match(logs.join('\n'), /unhandled request error/);
    assert.doesNotMatch(logs.join('\n'), /SECRETKEY|https:|RPC stack/);
    assert.doesNotMatch(bodies.join('\n'), /SECRETKEY|https:/);
  } finally { console.error = original; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('#59 nonce flood stops at the IP allowance', async () => {
  const server = createServer({ rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore(), () => 1_000) });
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

// Seven child processes, one after another, each importing the whole server (0.25 s locally, 0.7 s+ on a busy CI
// runner): together they crossed bun's default 5 s test limit now and then and blocked merges (2026-11-24, twice).
// Each child is already bounded at 10 s, so the test's own limit is the sum of those bounds, not the 5 s default.
test('default public reader handles a down DB, unused signing configuration, missing settings and RPC errors safely', { timeout: 90_000 }, async () => {
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
  const rows = new Map<string, { wallet: string; expiresAt: Date; privyUserId: string | null }>();
  const auth = new AuthStore({ access: approvedTestAccess, auth: { authDomain: 'localhost', authUri: 'http://localhost', chainId: 1337 }, sessions: {
    save: async (hash, wallet, expiresAt, privyUserId = null) => { rows.set(hash, { wallet, expiresAt, privyUserId }); },
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
  const limiter = new RequestRateLimiter(config, new MemoryRateLimitStore(), () => now);
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
    'RATE_LIMIT_CLOSE_PER_MINUTE', 'RATE_LIMIT_ASSETS_PER_MINUTE', 'RATE_LIMIT_ENROLLMENT_PER_MINUTE'];
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
  { action: 'versions', path: '/strategies/1/versions', method: 'POST', body: {allocation:{assets:[{address:'0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',weightBps:10000}]},schedule:{kind:'interval',intervalSeconds:3600}} },
  { action: 'portfolios', path: '/portfolios', method: 'POST', body: { strategyId: 1 } },
  { action: 'plan', path: '/portfolios/1/plan', method: 'GET' },
  { action: 'redeem', path: '/portfolios/1/redeem', method: 'POST', body: { usd: 1 } },
  { action: 'close', path: '/portfolios/1/close', method: 'POST' },
  { action: 'assets', path: '/assets', method: 'GET' },
];

const strategyOperatorKey = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 4 }).getHdKey().privateKey;
assert.ok(strategyOperatorKey);
const STRATEGY_OPERATOR = privateKeyToAccount(toHex(strategyOperatorKey));
const strategyWrites = budgetActions.filter(entry => entry.action === 'strategies' || entry.action === 'versions');

async function responseErrorCode(response: Response): Promise<string> {
  const body: unknown = await response.json();
  assert.ok(body && typeof body === 'object' && 'error' in body);
  const error = body.error;
  assert.ok(error && typeof error === 'object' && 'code' in error && typeof error.code === 'string');
  return error.code;
}

function strategyWriteStubs(calls: string[]): Partial<ServerDeps> {
  return {
    createStrategy: async (_body, provider) => {
      calls.push(provider);
      return { id: 1, provider, name: 'fund', description: '', isPublic: true, category: null, catalogKey: null, swapFeeBps: 0,
        onchainId: null, createdAt: new Date().toISOString() };
    },
    publishVersion: async (strategyId, input, provider) => {
      calls.push(provider);
      return { strategyId, version: 1, allocation: validateAllocation(input.allocation),
        schedule: { kind: 'interval', intervalSeconds: 60 }, changeLog: input.changeLog ?? null,
        activeAt: null, createdAt: new Date().toISOString(), executionSchemaVersion: 0,
        execution: { kind: 'target_weight' }, executionChainId: null, configHash: null, idleYield: { enabled: false } };
    },
  };
}

for (const entry of strategyWrites) {
  test('#157 ' + entry.path + ': non-operators are rejected before body validation, rate limits or domain writes', async () => {
    const calls: string[] = [];
    await withBudgetServer(async base => {
      const token = await budgetToken(base);
      // Neither a claimed provider nor malformed JSON can bypass the session-wallet gate.
      for (const body of [JSON.stringify(entry.body), JSON.stringify({ provider: STRATEGY_OPERATOR.address }), 'null', '{']) {
        const response = await fetch(base + entry.path, { method: 'POST', body,
          headers: { authorization: 'Bearer ' + token, origin: 'http://localhost:5173' } });
        assert.equal(response.status, 403);
        assert.deepEqual(await response.json(), { error: { code: 'OPERATOR_ONLY', message: 'only operator wallets may create strategies or publish versions' } });
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5173');
      }
      assert.deepEqual(calls, []);
    }, { ...strategyWriteStubs(calls), operatorWallets: [STRATEGY_OPERATOR.address],
      rateLimiter: new RequestRateLimiter({ ...loadRateLimitConfig({}), strategiesPerDay: 0, versionsPerDay: 0 }, new MemoryRateLimitStore()) });
  });

  test('#157 ' + entry.path + ': authenticates first and reads the current complete operator environment on every request', async () => {
    const previous = process.env.OPERATOR_WALLETS;
    const calls: string[] = [];
    try {
      await withBudgetServer(async base => {
        const token = await budgetToken(base, STRATEGY_OPERATOR);
        const request = (bearer?: string) => fetch(base + entry.path, { method: 'POST', body: JSON.stringify(entry.body),
          headers: bearer === undefined ? {} : { authorization: 'Bearer ' + bearer } });
        process.env.OPERATOR_WALLETS = `${STRATEGY_OPERATOR.address},*`;
        for (const bearer of [undefined, 'unknown-token']) {
          const response = await request(bearer);
          assert.equal(response.status, 401);
          assert.equal(await responseErrorCode(response), 'UNAUTHORIZED');
        }
        for (const value of [undefined, '', '   ', `${STRATEGY_OPERATOR.address},*`, `${STRATEGY_OPERATOR.address},${zeroAddress}`, `${STRATEGY_OPERATOR.address},`]) {
          if (value === undefined) delete process.env.OPERATOR_WALLETS;
          else process.env.OPERATOR_WALLETS = value;
          const response = await request(token);
          const invalid = value !== undefined && value.trim() !== '';
          assert.equal(response.status, invalid ? 503 : 403);
          assert.equal(await responseErrorCode(response), invalid ? 'INVALID_OPERATOR_WALLETS' : 'OPERATOR_ONLY');
          assert.deepEqual(calls, []);
        }
        process.env.OPERATOR_WALLETS = ` ${STRATEGY_OPERATOR.address.toUpperCase()} `;
        const allowed = await request(token);
        assert.equal(allowed.status, 201);
        assert.deepEqual(calls, [STRATEGY_OPERATOR.address.toLowerCase()]);
        process.env.OPERATOR_WALLETS = '';
        assert.equal((await request(token)).status, 403);
        assert.equal(calls.length, 1);
      }, { ...strategyWriteStubs(calls), operatorRebalanceEnabled: () => false,
        rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore()) });
    } finally {
      if (previous === undefined) delete process.env.OPERATOR_WALLETS;
      else process.env.OPERATOR_WALLETS = previous;
    }
  });

  test('#157 ' + entry.path + ': injected allowlists compare case-insensitively and an empty list denies access', async () => {
    const previous = process.env.OPERATOR_WALLETS;
    process.env.OPERATOR_WALLETS = STRATEGY_OPERATOR.address;
    try {
      for (const wallets of [[], [STRATEGY_OPERATOR.address], [STRATEGY_OPERATOR.address.toLowerCase()],
        ['0x1000000000000000000000000000000000000001', STRATEGY_OPERATOR.address.toUpperCase()]]) {
        const calls: string[] = [];
        await withBudgetServer(async base => {
          const token = await budgetToken(base, STRATEGY_OPERATOR);
          const response = await fetch(base + entry.path, { method: 'POST', body: JSON.stringify(entry.body),
            headers: { authorization: 'Bearer ' + token } });
          assert.equal(response.status, wallets.length === 0 ? 403 : 201);
          assert.deepEqual(calls, wallets.length === 0 ? [] : [STRATEGY_OPERATOR.address.toLowerCase()]);
        }, { ...strategyWriteStubs(calls), operatorWallets: wallets, operatorRebalanceEnabled: () => false,
          rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore()) });
      }
    } finally {
      if (previous === undefined) delete process.env.OPERATOR_WALLETS;
      else process.env.OPERATOR_WALLETS = previous;
    }
  });

  test('#157 ' + entry.path + ': authentication and domain storage failures or timeouts fail closed', async () => {
    for (const code of ['ECONNREFUSED', 'ETIMEDOUT']) {
      for (const source of ['auth', 'domain']) {
        const calls: string[] = [];
        const failure = async (): Promise<never> => { throw Object.assign(new Error('sensitive storage failure'), { code }); };
        await withBudgetServer(async base => {
          const response = await fetch(base + entry.path, { method: 'POST', body: JSON.stringify(entry.body),
            headers: { authorization: 'Bearer test-session' } });
          assert.equal(response.status, 503);
          assert.deepEqual(await response.json(), { error: { code: 'DB_UNAVAILABLE', message: 'database unavailable' } });
          assert.deepEqual(calls, []);
        }, { ...strategyWriteStubs(calls), operatorWallets: [STRATEGY_OPERATOR.address],
          ...(source === 'domain' ? { createStrategy: failure, publishVersion: failure } : {}),
          rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore()),
          auth: { authenticate: source === 'auth' ? failure : async () => STRATEGY_OPERATOR.address,
            issueNonce: () => { throw new Error('unexpected nonce'); }, login: failure, logout: failure } });
      }
    }
  });
}

for (const entry of budgetActions) {
  test('#59 HTTP ' + entry.action + ': authenticated wallet limit, other wallet, parallel calls and reset', async () => {
    let now = 1_000;
    let calls = 0;
    const touch = async () => { calls++; return {}; };
    const limiter = new RequestRateLimiter({ ...loadRateLimitConfig({}), strategiesPerDay: 2, versionsPerDay: 2,
      portfoliosPerDay: 2, planPerMinute: 2, redeemPerMinute: 2, closePerMinute: 2, assetsPerMinute: 2 }, new MemoryRateLimitStore(), () => now);
    const account = privateKeyToAccount(generatePrivateKey());
    const otherAccount = privateKeyToAccount(generatePrivateKey());
    await withBudgetServer(async (base) => {
      const firstToken = await budgetToken(base, account);
      const secondToken = await budgetToken(base, account);
      const otherToken = await budgetToken(base, otherAccount);
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
    }, { rateLimiter: limiter, operatorWallets: [account.address, otherAccount.address],
      createStrategy: async (_body, provider) => { calls++; return { id: 1, provider, name: 'fund', description: '', isPublic: false, category: null, catalogKey: null, swapFeeBps: 0, onchainId: null, createdAt: new Date().toISOString() }; },
      publishVersion: async () => { calls++; return { strategyId: 1, version: 1, allocation: { assets: [{ address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', weightBps: 10000 }] }, schedule: { kind: 'interval', intervalSeconds: 60 }, executionSchemaVersion: 0, execution: { kind: 'target_weight' }, executionChainId: null, configHash: null, idleYield: { enabled: false }, changeLog: null, activeAt: null, createdAt: new Date().toISOString() }; },
      enrollPortfolio: async (_id, userId) => { calls++; return { minDepositUsdtWei: '50000000000000000000', id: 1, userId, strategyId: 1, strategyName: 'fund', version: 1, scheduleState: 'active', createdAt: new Date().toISOString(), smartAccounts: [], gas: null }; },
      planPreview: async (portfolioId) => { calls++; return { portfolioId, outcome: 'noop', reason: 'aligned', steps: [], rationale: null }; },
      operatorRedeem: touch, operatorClose: touch, listAssets: async () => { calls++; return []; },
    });
  });
}

test('#59 HTTP: auth IP limits apply to login/nonce/logout; preflight is free and fake XFF cannot bypass', async () => {
  const limiter = new RequestRateLimiter({ ...loadRateLimitConfig({}), authPerMinute: 2 }, new MemoryRateLimitStore(), () => 1_000);
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
  const limiter = new RequestRateLimiter({ ...loadRateLimitConfig({}), authPerMinute: 1, trustedProxyIps: ['127.0.0.1'] }, new MemoryRateLimitStore(), () => 1_000);
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
  }, { rateLimiter: new RequestRateLimiter({ ...loadRateLimitConfig({}), planPerMinute: 1 }, new MemoryRateLimitStore(), () => 1_000),
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
    rateLimiter: new RequestRateLimiter({ ...loadRateLimitConfig({}), planPerMinute: 1, closePerMinute: 1 }, new MemoryRateLimitStore(), () => 1_000),
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

function privyHarness() {
  const fixture = privyFixture();
  const memory = privyMemory();
  let clock = fixture.now;
  const auth = new AuthStore({ access: approvedTestAccess, sessions: memory.sessions, now: () => clock });
  const login = createPrivyLogin({ access: approvedTestAccess, config: () => fixture.config, users: memory.users,
    issueSession: (owner, userId) => auth.issueSession(owner, userId), now: () => clock });
  return { fixture, memory, auth, login, setClock: (value: number) => { clock = value; } };
}

function privyError(status: number, code: string): (error: unknown) => boolean {
  return (error) => error instanceof AppError && error.status === status && error.code === code;
}

test('#63 Privy config is optional, needs both values and preserves escaped public PEM newlines', () => {
  for (const env of [{}, { PRIVY_APP_ID: 'test' }, { PRIVY_VERIFICATION_KEY: 'key' },
    { PRIVY_APP_ID: ' ', PRIVY_VERIFICATION_KEY: 'key' }]) assert.equal(loadPrivyConfig(env), null);
  assert.deepEqual(loadPrivyConfig({ PRIVY_APP_ID: ' test ', PRIVY_VERIFICATION_KEY: ' a\\nb ' }),
    { appId: 'test', verificationKey: 'a\nb' });
});

test('#63 embedded email/Google/Apple and external-wallet registration mint the same hashed 24h sessions', async () => {
  for (const provider of ['email', 'google_oauth', 'apple_oauth', 'external']) {
    const { fixture: f, memory, auth, login } = privyHarness();
    const accounts = provider === 'external'
      ? [{ ...f.wallet, wallet_client_type: 'metamask' }]
      : [{ type: provider }, { ...f.wallet, address: f.owner.toUpperCase().replace('0X', '0x') }];
    const session = await login({ identityToken: await f.sign({ linked_accounts: JSON.stringify(accounts) }), owner: f.other, loginMethod: 'external' });
    assert.match(session.token, /^[0-9a-f]{64}$/);
    assert.equal(Date.parse(session.expiresAt), f.now + SESSION_TTL_MS);
    assert.equal(await auth.authenticate('Bearer ' + session.token), f.owner);
    assert.equal(memory.mappings.get(f.userId), f.owner);
    assert.equal(memory.rows.size, 1);
    assert.ok(memory.rows.has(sha256Hex(session.token)));
    assert.ok(!memory.rows.has(session.token));
    await auth.logout('Bearer ' + session.token);
    await assert.rejects(auth.authenticate('Bearer ' + session.token), privyError(401, 'UNAUTHORIZED'));
  }
});

test('#63 JWT failures are 401 before any mapping or session writes, with sanitized messages', async () => {
  const h = privyHarness();
  const f = h.fixture;
  const seconds = Math.floor(f.now / 1000);
  const claims = [
    { exp: seconds - 1 }, { exp: seconds }, { exp: 0 }, { exp: undefined }, { exp: 'never' },
    { aud: 'wrong-app' }, { aud: undefined }, { aud: [f.config.appId] },
    { iss: 'https://privy.io' }, { iss: undefined }, { sub: '' }, { sub: 'did:privy: ' }, { sub: undefined },
    { iat: seconds + 1 }, { iat: -1 }, { iat: undefined }, { iat: seconds + 0.5 },
    { exp: seconds + 0.5 }, { iat: seconds + 1, exp: seconds + 1 }, { nbf: seconds + 1 },
    { linked_accounts: undefined }, { linked_accounts: [] }, { linked_accounts: '{' },
    { linked_accounts: '{}' }, { linked_accounts: '[null]' }, { linked_accounts: '[1]' },
  ];
  const valid = await f.sign();
  const other = privyFixture();
  const tokens = await Promise.all(claims.map((claim) => f.signRaw(claim)));
  tokens.push(await other.sign({ sub: f.userId }), 'broken', valid.slice(0, -16) + 'AAAAAAAAAAAAAAAA',
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url') + '.' + valid.split('.')[1] + '.');
  // Unsupported algorithms are rejected even when correctly signed with this public key.
  const { SignJWT } = await import('jose');
  tokens.push(await new SignJWT({ sub: f.userId }).setProtectedHeader({ alg: 'HS256' })
    .sign(new TextEncoder().encode(f.config.verificationKey)));
  for (const identityToken of tokens) {
    await assert.rejects(h.login({ identityToken }), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.status, 401);
      assert.equal(error.message, 'invalid or expired Privy identity token');
      return true;
    });
  }
  assert.equal(h.memory.mappings.size, 0);
  assert.equal(h.memory.rows.size, 0);
});

test('#63 token exp/nbf and CRE8 session expiry enforce exact second and 24h boundaries', async () => {
  const h = privyHarness();
  const f = h.fixture;
  const seconds = Math.floor(f.now / 1000);
  const identityToken = await f.sign({ exp: seconds + 1, nbf: seconds });
  h.setClock(seconds * 1000 + 999);
  const session = await h.login({ identityToken });
  h.setClock((seconds + 1) * 1000);
  await assert.rejects(h.login({ identityToken }), privyError(401, 'UNAUTHORIZED'));
  h.setClock(Date.parse(session.expiresAt) - 1);
  assert.equal(await h.auth.authenticate('Bearer ' + session.token), f.owner);
  h.setClock(Date.parse(session.expiresAt));
  await assert.rejects(h.auth.authenticate('Bearer ' + session.token), privyError(401, 'UNAUTHORIZED'));
});

test('#63 request shape and token size are bounded; max-length token still reaches verification', async () => {
  const { fixture: f, memory, login } = privyHarness();
  for (const body of [null, [], 'token', {}, { identityToken: 0 }, { identityToken: '' }, { identityToken: ' ' },
    { accessToken: await f.sign() }, { identityToken: 'x'.repeat(MAX_PRIVY_TOKEN_LENGTH + 1) }]) {
    await assert.rejects(login(body), privyError(400, 'INVALID_AUTH'));
  }
  await assert.rejects(login({ identityToken: 'x'.repeat(MAX_PRIVY_TOKEN_LENGTH) }), privyError(401, 'UNAUTHORIZED'));
  assert.equal(memory.mappings.size, 0);
  assert.equal(memory.rows.size, 0);
});

test('#63 first login rejects zero or multiple valid EVM wallets and never writes; duplicate casing is one wallet', async () => {
  const { fixture: f, memory, login } = privyHarness();
  for (const accounts of [[], [{ type: 'email' }], [{ ...f.wallet, address: '0x' + '0'.repeat(40) }],
    [{ ...f.wallet, address: '0x1234' }], [{ ...f.wallet, address: 123 }], [{ ...f.wallet, address: undefined }],
    [{ ...f.wallet, chain_type: 'solana' }], [{ ...f.wallet, chain_type: undefined }],
    [{ ...f.wallet, type: 'smart_wallet' }], [f.wallet, { ...f.wallet, address: f.other }]]) {
    const code = accounts.length === 2 ? 'PRIVY_OWNER_AMBIGUOUS' : 'PRIVY_NO_WALLET';
    await assert.rejects(login({ identityToken: await f.sign({ linked_accounts: JSON.stringify(accounts) }), owner: f.owner }), privyError(409, code));
    assert.equal(memory.mappings.size, 0);
    assert.equal(memory.rows.size, 0);
  }
  await login({ identityToken: await f.sign({ linked_accounts: JSON.stringify([
    f.wallet, { ...f.wallet, address: f.owner.toUpperCase().replace('0X', '0x') },
    { ...f.wallet, chain_type: 'solana' },
  ]) }) });
  assert.equal(memory.mappings.get(f.userId), f.owner);
});

test('#63 existing owner survives added/removed wallets and social-only login across fresh login handlers', async () => {
  const { fixture: f, memory, auth, login } = privyHarness();
  await login({ identityToken: await f.sign() });
  const fresh = createPrivyLogin({ access: approvedTestAccess, config: () => f.config, users: memory.users,
    issueSession: (owner, userId) => auth.issueSession(owner, userId), now: () => f.now });
  for (const accounts of [[], [{ type: 'google_oauth' }], [{ ...f.wallet, address: f.other }],
    [f.wallet, { ...f.wallet, address: f.other }]]) {
    const session = await fresh({ identityToken: await f.sign({ linked_accounts: JSON.stringify(accounts) }), owner: f.other });
    assert.equal(await auth.authenticate('Bearer ' + session.token), f.owner);
    assert.equal(memory.mappings.get(f.userId), f.owner);
  }
  // A different Privy identity must never reuse this user's mapping.
  await assert.rejects(fresh({ identityToken: await f.sign({ sub: 'did:privy:someone-else', linked_accounts: '[]' }) }),
    privyError(409, 'PRIVY_NO_WALLET'));
});

test('#63 disabled/bad verification key returns 503 without touching persistence; SIWE still works', async () => {
  const f = privyFixture();
  for (const config of [null, { ...f.config, verificationKey: 'misplaced-secret-value' }]) {
    let persistenceCalls = 0;
    const login = createPrivyLogin({ access: approvedTestAccess, config: () => config, users: {
      find: async () => { persistenceCalls++; return null; },
      create: async () => { persistenceCalls++; return f.owner; },
    } });
    await assert.rejects(login({ identityToken: await f.sign() }), privyError(503, 'PRIVY_UNAVAILABLE'));
    assert.equal(persistenceCalls, 0, 'disabled or invalid key must not touch persistence');
  }
  const auth = new AuthStore({ access: approvedTestAccess, sessions: privyMemory().sessions });
  const account = privateKeyToAccount(generatePrivateKey());
  const challenge = auth.issueNonce();
  const message = createSiweMessage({ ...challenge, address: account.address, version: '1', issuedAt: new Date(challenge.issuedAt) });
  const session = await auth.login(message, await account.signMessage({ message }));
  assert.equal(await auth.authenticate('Bearer ' + session.token), account.address.toLowerCase());
});

test('#63 mapping lookup/insert and session DB failure/timeout fail closed without leaking errors', async () => {
  const f = privyFixture();
  const identityToken = await f.sign();
  for (const stage of ['find', 'create', 'session'] as const) {
    for (const code of ['ECONNREFUSED', '57014', 'ETIMEDOUT']) {
      const memory = privyMemory();
      const fail = async (): Promise<never> => { throw Object.assign(new Error('secret-token-database-url'), { code }); };
      const auth = new AuthStore({ access: approvedTestAccess, sessions: { ...memory.sessions, save: stage === 'session' ? fail : memory.sessions.save } });
      const login = createPrivyLogin({ access: approvedTestAccess, config: () => f.config, users: {
        find: stage === 'find' ? fail : memory.users.find,
        create: stage === 'create' ? fail : memory.users.create,
      }, issueSession: (owner, userId) => auth.issueSession(owner, userId), now: () => f.now });
      await assert.rejects(login({ identityToken }), (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.status, 503);
        assert.equal(error.message, 'Privy login is unavailable');
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(memory.rows.size, 0);
      assert.equal(memory.mappings.size, stage === 'session' ? 1 : 0);
      if (stage === 'session') {
        const recovered = new AuthStore({ access: approvedTestAccess, sessions: memory.sessions });
        const retry = createPrivyLogin({ access: approvedTestAccess, config: () => f.config, users: memory.users,
          issueSession: (owner, userId) => recovered.issueSession(owner, userId) });
        const session = await retry({ identityToken: await f.sign({
          linked_accounts: JSON.stringify([{ ...f.wallet, address: f.other }]),
        }) });
        assert.equal(await recovered.authenticate('Bearer ' + session.token), f.owner);
      }
    }
  }
  for (const owner of ['', '0x123', '0x' + '0'.repeat(40)]) {
    let insertCalls = 0;
    let mintCalls = 0;
    const login = createPrivyLogin({ access: approvedTestAccess, config: () => f.config, users: { find: async () => owner,
      create: async () => { insertCalls++; return f.owner; } },
    issueSession: async () => { mintCalls++; throw new Error('invalid owner'); } });
    await assert.rejects(login({ identityToken }), privyError(503, 'PRIVY_UNAVAILABLE'));
    assert.equal(insertCalls, 0, 'must not replace corrupt owner');
    assert.equal(mintCalls, 0, 'must not mint invalid owner session');
  }
});

test('#63 HTTP Privy shares auth IP limits with SIWE, rejects methods and malformed JSON, and hides tokens in logs', async () => {
  const { fixture: f, memory, auth, login } = privyHarness();
  const server = createServer({ privyLogin: login, auth: {
    issueNonce: () => auth.issueNonce(), login: (m, s) => auth.login(m, s),
    authenticate: (header) => auth.authenticate(header), logout: (header) => auth.logout(header),
  }, rateLimiter: new RequestRateLimiter({ ...loadRateLimitConfig({}), authPerMinute: 5 }, new MemoryRateLimitStore(), () => 1000) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/auth/privy`;
  const identityToken = await f.sign();
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => { logs.push(values.map(String).join(' ')); };
  try {
    assert.equal((await fetch(url, { method: 'OPTIONS' })).status, 204);
    const method = await fetch(url);
    assert.equal(method.status, 405);
    assert.equal(method.headers.get('allow'), 'POST');
    assert.equal((await fetch(url, { method: 'POST', body: '{' })).status, 400);
    const response = await fetch(url, { method: 'POST', body: JSON.stringify({ identityToken }) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const session: unknown = await response.json();
    assert.ok(typeof session === 'object' && session !== null && 'token' in session && typeof session.token === 'string');
    assert.equal(await auth.authenticate('Bearer ' + session.token), f.owner);
    assert.equal((await fetch(url.replace('privy', 'nonce'), { method: 'POST' })).status, 200);
    assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify({ identityToken: 'invalid' }) })).status, 401);
    const limited = await fetch(url, { method: 'POST', body: JSON.stringify({ identityToken }), headers: { 'x-forwarded-for': '192.0.2.1' } });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '59');
    assert.equal(memory.rows.size, 1);
    assert.ok(!logs.join('\n').includes(identityToken), 'JWT must not appear in logs');
    assert.ok(!logs.join('\n').includes(session.token), 'session must not appear in logs');
  } finally {
    console.log = originalLog;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('#63 HTTP maps owner conflicts to 409, disabled login and DB failure to 503 without issuing sessions', async () => {
  const h = privyHarness();
  const f = h.fixture;
  const disabled = createPrivyLogin({ access: approvedTestAccess, config: () => null });
  const failing = createPrivyLogin({ access: approvedTestAccess, config: () => f.config, users: {
    find: async () => { throw new Error('secret-db-connection'); }, create: async () => assert.fail('must not insert'),
  } });
  for (const entry of [
    { login: h.login, accounts: [], status: 409, code: 'PRIVY_NO_WALLET' },
    { login: h.login, accounts: [f.wallet, { ...f.wallet, address: f.other }], status: 409, code: 'PRIVY_OWNER_AMBIGUOUS' },
    { login: disabled, accounts: [f.wallet], status: 503, code: 'PRIVY_UNAVAILABLE' },
    { login: failing, accounts: [f.wallet], status: 503, code: 'PRIVY_UNAVAILABLE' },
  ]) {
    await withBudgetServer(async (base) => {
      const response = await fetch(base + '/auth/privy', { method: 'POST', body: JSON.stringify({
        identityToken: await f.sign({ linked_accounts: JSON.stringify(entry.accounts) }),
      }) });
      assert.equal(response.status, entry.status);
      const body: unknown = await response.json();
      assert.ok(typeof body === 'object' && body !== null && 'error' in body);
      assert.ok(typeof body.error === 'object' && body.error !== null && 'code' in body.error);
      assert.equal(body.error.code, entry.code);
      assert.ok(!JSON.stringify(body).includes('secret-db-connection'));
    }, { privyLogin: entry.login });
  }
  assert.equal(h.memory.mappings.size, 0);
  assert.equal(h.memory.rows.size, 0);
});

test('#63 default HTTP dependency loads optional Privy env without affecting SIWE nonce', async () => {
  const f = privyFixture();
  const identityToken = await f.sign({ iss: 'wrong-issuer' });
  for (const settings of [
    { appId: '', key: '', status: 503 },
    { appId: f.config.appId, key: '', status: 503 },
    { appId: '', key: f.config.verificationKey, status: 503 },
    { appId: f.config.appId, key: f.config.verificationKey, status: 401 },
  ]) {
    const result = await runScript('src/privy.ts', {
      PRIVY_APP_ID: settings.appId, PRIVY_VERIFICATION_KEY: settings.key,
    }, `
      const assert = (await import('node:assert/strict')).default;
      const { createServer } = await import('./src/server.ts');
      const server = createServer();
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const base = 'http://127.0.0.1:' + server.address().port;
      try {
        const result = await fetch(base + '/auth/privy', { method: 'POST', body: JSON.stringify({ identityToken: ${JSON.stringify(identityToken)} }) });
        assert.equal(result.status, ${settings.status});
        assert.equal((await fetch(base + '/auth/nonce', { method: 'POST' })).status, 200);
      } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    `);
    assert.equal(result.code, 0, result.output);
    assert.ok(!result.output.includes(identityToken), 'JWT must not reach output');
  }
});
test('#118 contribution preview is public, bounded, rate limited and rejects invalid inputs before computation',async()=>{
  const {record}=await import('../src/strategy-execution.js');
  const {TESTNET_97}=await import('../src/testnet-profile.js');
  const {RequestRateLimiter,MemoryRateLimitStore}=await import('../src/ratelimit.js');
  const {loadRateLimitConfig}=await import('../src/config.js');
  const cash=TESTNET_97.contracts.usdt,asset=TESTNET_97.assets.WBNB.token,U=10n**18n;
  const execution={kind:'per_asset',numeraire:cash,rebalance:'none',assets:[
    {asset,weightBps:10000,execution:{kind:'stack',every:'daily',weekday:null,timeUtc:'13:00',slices:365},yield:null},
    {asset:cash,weightBps:0,yield:null}]};
  const rateLimiter=new RequestRateLimiter({...loadRateLimitConfig({}),authPerMinute:30},new MemoryRateLimitStore());
  const server=createServer({rateLimiter});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const address=server.address();assert.ok(address&&typeof address!=='string');
    const url=`http://127.0.0.1:${address.port}/strategies/preview-contribution`;
    const post=(body:unknown)=>fetch(url,{method:'POST',body:JSON.stringify(body)});
    const body={chainId:97,execution,amountRaw:(100n*U).toString()};
    const aboveLimit=await post({...body,amountRaw:(10_000_000n*U+1n).toString()});
    assert.equal(aboveLimit.status,422);
    const aboveError:unknown=await aboveLimit.json();assert.ok(record(aboveError)&&record(aboveError.error));
    assert.equal(aboveError.error.code,'PREVIEW_AMOUNT_TOO_LARGE');
    const success=await post(body);assert.equal(success.status,200);
    const value:unknown=await success.json();assert.ok(record(value));assert.equal(value.minimumRaw,(50n*U).toString());
    assert.deepEqual(value.effectiveSlices,{[asset]:10});assert.ok(Array.isArray(value.slots));assert.equal(value.slots.length,4);
    assert.ok(value.slots.every((s:unknown)=>record(s)&&typeof s.at==='string'&&Number.isFinite(Date.parse(s.at))&&s.budgetRaw===(10n*U).toString()));
    for(const amount of [0n,50n*U-1n]){
      const response=await post({...body,amountRaw:amount.toString()});assert.equal(response.status,422);
      const error:unknown=await response.json();assert.ok(record(error));assert.ok(record(error.error));assert.equal(error.error.code,'BELOW_MINIMUM_ALLOCATION');
    }
    for(const amountRaw of ['-1','01','1.0','1e20',100,null,((1n<<256n)).toString()])assert.equal((await post({...body,amountRaw})).status,400);
    for(const extra of [{unknown:1},{chainId:'97'},{chainId:56},{execution:{...execution,unexpected:1}},{execution:null}])assert.equal((await post({...body,...extra})).status,400);
    const profileAssets=Object.values(TESTNET_97.assets),weight=Math.floor(10000/profileAssets.length);
    const impossible={...execution,assets:[...profileAssets.map((a,i)=>({asset:a.token,weightBps:weight+(i===0?10000%profileAssets.length:0),execution:{kind:'hold'},yield:null})),{asset:cash,weightBps:0,yield:null}]};
    // 105 assets / 16-step children cannot fit in a 50-USDT complete budget.
    const noPlan=await post({...body,execution:impossible,amountRaw:(50n*U).toString()});assert.equal(noPlan.status,422);
    assert.equal((await fetch(url)).status,405);
    const limited=createServer({rateLimiter:new RequestRateLimiter({...loadRateLimitConfig({}),authPerMinute:0},new MemoryRateLimitStore())});
    await new Promise<void>(resolve=>limited.listen(0,'127.0.0.1',resolve));
    try{
      const addr=limited.address();assert.ok(addr&&typeof addr!=='string');
      const r=await fetch(`http://127.0.0.1:${addr.port}/strategies/preview-contribution`,{method:'POST',body:'invalid'});
      assert.equal(r.status,429);assert.ok(r.headers.get('retry-after'));
    }finally{await new Promise<void>(resolve=>limited.close(()=>resolve()));}
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});


test('#124 pending account deployment returns 202 and a retry hint without setup calldata', async () => {
  const server = createServer({
    auth: { authenticate: async () => '0x1000000000000000000000000000000000000001',
      issueNonce: () => { throw new Error('unexpected'); }, login: async () => { throw new Error('unexpected'); }, logout: async () => {} },
    rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore()),
    preparePortfolioEnrollment: async () => { throw new AppError(202, 'ACCOUNT_DEPLOYMENT_PENDING', 'original account deployment is pending'); },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/portfolios/enrollment-params`, { method: 'POST', body: JSON.stringify({ strategyId: 1 }) });
    assert.equal(response.status, 202); assert.equal(response.headers.get('retry-after'), '3');
    assert.equal(response.headers.get('access-control-expose-headers'), 'Retry-After');
    assert.deepEqual(await response.json(), { accountDeployed: false, retryAfterSeconds: 3, error: { code: 'ACCOUNT_DEPLOYMENT_PENDING', message: 'original account deployment is pending' } });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('GET /me/dca: one request for every portfolio of the owner; display reads have their own budget, apart from writes and sponsorship', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const calls: string[] = [];
  const body = { owner: account.address.toLowerCase(), portfolios: { '7': { portfolioId: 7, status: 'none', plan: null } }, updatedAt: null };
  const dca = {
    list: async (wallet: string) => { calls.push(`list:${wallet.toLowerCase()}`); return body; },
    get: async (id: number) => { calls.push(`get:${id}`); return { portfolioId: id, status: 'none', plan: null }; },
    create: async (id: number) => { calls.push(`create:${id}`); return { status: 'unavailable', reason: 'no_open_vault', message: 'x' }; },
  } as unknown as ServerDeps['dca'];
  const mixes = { list: async () => { calls.push('mixes'); return { mixes: [] }; } } as unknown as ServerDeps['mixes'];
  await withBudgetServer(async (base) => {
    const token = await budgetToken(base, account);
    const call = (path: string, method = 'GET') => fetch(base + path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
    assert.equal((await fetch(base + '/me/dca')).status, 401);
    assert.equal((await call('/me/dca', 'POST')).status, 405);
    const listed = await call('/me/dca');
    assert.equal(listed.status, 200);
    assert.equal(listed.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await listed.json(), body);
    assert.deepEqual(calls, [`list:${account.address.toLowerCase()}`]);
    // Display reads share the read budget (4 here): the list, a single portfolio's DCA, My mixes.
    assert.deepEqual([(await call('/portfolios/7/dca')).status, (await call('/me/mixes')).status, (await call('/me/dca')).status], [200, 200, 200]);
    const refused = await call('/me/dca');
    assert.equal(refused.status, 429);
    assert.equal((await call('/portfolios/7/dca')).status, 429);
    // …and using it up leaves the write budget (plan, 1 here) untouched: starting a DCA still goes through, once.
    assert.equal((await call('/portfolios/7/dca', 'POST')).status, 200);
    assert.equal((await call('/portfolios/7/dca', 'POST')).status, 429);
    assert.deepEqual(calls.slice(1), ['get:7', 'mixes', `list:${account.address.toLowerCase()}`, 'create:7']);
  }, { dca, mixes, rateLimiter: new RequestRateLimiter({ ...loadRateLimitConfig({}), planPerMinute: 1, readPerMinute: 4 }, new MemoryRateLimitStore(), () => 1_000) });
  // The other way round: a used-up write budget does not refuse the reads.
  calls.length = 0;
  await withBudgetServer(async (base) => {
    const token = await budgetToken(base, account);
    const call = (path: string, method = 'GET') => fetch(base + path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
    assert.equal((await call('/portfolios/7/dca', 'POST')).status, 429);
    assert.deepEqual([(await call('/me/dca')).status, (await call('/portfolios/7/dca')).status], [200, 200]);
  }, { dca, mixes, rateLimiter: new RequestRateLimiter({ ...loadRateLimitConfig({}), planPerMinute: 0, readPerMinute: 4 }, new MemoryRateLimitStore(), () => 1_000) });
  assert.deepEqual([loadRateLimitConfig({}).planPerMinute, loadRateLimitConfig({}).readPerMinute, loadRateLimitConfig({ RATE_LIMIT_READ_PER_MINUTE: '45' }).readPerMinute], [30, 120, 45]);
});

test('2026-11-26 bundler relay: the block of an owner UserOp\'s receipt is read from the bundler\'s answer (later reads must not be older); anything else is ignored', () => {
  const receipt = (blockNumber: unknown) => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { userOpHash: '0xabc', success: true, receipt: { transactionHash: '0xdef', blockNumber } } });
  assert.equal(userOpReceiptBlock(receipt('0x8a2e9d6')), '0x8a2e9d6');
  // Not mined yet, an error answer, a body that is not JSON, a block that is not a hex quantity: nothing to note.
  for (const body of [JSON.stringify({ jsonrpc: '2.0', id: 1, result: null }), JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'nope' } }),
    '<html>502</html>', '', receipt(144894100), receipt('144894100'), receipt('0x'), receipt(null), JSON.stringify([1, 2])]) assert.equal(userOpReceiptBlock(body), null, body);
});
