import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { createTestnetWebsite, gatewayClientIp } from '../scripts/testnet-web.js';
import { websiteProxyIps } from '../scripts/testnet-api.js';
import { prepareDeploy } from '../scripts/prepare-deploy.js';
import { runPointsSync } from '../scripts/points-sync.js';
import workerConfig from '../deploy/testnet-97-worker.json' with { type: 'json' };
import apiConfig from '../railway.json' with { type: 'json' };

test('#136 enabled workers have no HTTP healthcheck; API retains its readiness check', () => {
  assert.deepEqual(workerConfig.build, apiConfig.build);
  assert.equal(workerConfig.deploy.restartPolicyType, 'ON_FAILURE');
  assert.equal(workerConfig.deploy.restartPolicyMaxRetries, 10);
  assert.equal(Object.hasOwn(workerConfig.deploy, 'healthcheckPath'), false);
  assert.equal(apiConfig.deploy.healthcheckPath, '/health');
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return 'http://127.0.0.1:' + address.port;
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
async function temporary() { await mkdir('.bun-cache', { recursive: true }); return mkdtemp(resolve('.bun-cache/deploy-test-')); }

test('#79 points worker calls production sync once, bounds interval and closes DB on RPC/DB failure', async () => {
  for (const interval of [undefined, '60', '86400']) {
    let calls = 0; let closed = false;
    await runPointsSync(['--once'], { CHAIN_ID: '97', POINTS_SYNC_INTERVAL: interval }, async () => { calls++; return { throughBlock: '1', operations: 0, capped: 0 }; }, async () => { closed = true; });
    assert.equal(calls, 1); assert.ok(closed);
  }
  for (const interval of ['0', '59', '86401', 'invalid']) await assert.rejects(runPointsSync(['--once'], { CHAIN_ID: '97', POINTS_SYNC_INTERVAL: interval }), /invalid points interval/);
  await assert.rejects(runPointsSync(['--once'], { CHAIN_ID: '56' }), /requires chain 97/);
  await assert.rejects(runPointsSync(['--live'], { CHAIN_ID: '97' }), /usage/);
  for (const failure of ['DB unavailable', 'RPC timeout', 'missing receipt']) {
    let closed = false;
    await assert.rejects(runPointsSync(['--once'], { CHAIN_ID: '97' }, async () => { throw new Error(failure); }, async () => { closed = true; }), new RegExp(failure));
    assert.ok(closed);
  }
});

test('#79 website serves SPA and assets; preserves API auth, paths, query, bodies, errors and status', async () => {
  const root = await temporary(); let seen = false;
  const api = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += String(chunk);
    assert.equal(req.url, '/auth/privy?test=1'); assert.equal(req.headers.authorization, 'Bearer test-only');
    assert.equal(req.headers['x-forwarded-for'], '198.51.100.8');
    assert.equal(body, '{"identityToken":"test-only"}'); seen = true;
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' }); res.end('{"code":"RATE_LIMITED"}');
  });
  let website: Server | undefined;
  try {
    await writeFile(join(root, 'index.html'), '<title>testnet</title>'); await writeFile(join(root, 'asset.js'), 'testnet');
    await symlink('/etc/hosts', join(root, 'outside.txt'));
    const upstream = new URL(await listen(api)); website = await createTestnetWebsite(root, upstream);
    const base = await listen(website);
    assert.equal(await (await fetch(base + '/funds/a')).text(), '<title>testnet</title>');
    assert.equal((await fetch(base + '/asset.js', { method: 'HEAD' })).headers.get('content-length'), '7');
    assert.equal((await fetch(base + '/health')).status, 200);
    for (const path of ['/missing.js', '/.env', '/%2eenv', '/_worker.js', '/outside.txt', '/..%2f..%2fetc/passwd', '/%00', '/%ZZ']) assert.equal((await fetch(base + path)).status, 404, path);
    assert.equal((await fetch(base + '/', { method: 'POST' })).status, 405);
    const result = await fetch(base + '/api/auth/privy?test=1', { method: 'POST', headers: { authorization: 'Bearer test-only', 'x-forwarded-for': '192.0.2.1, 198.51.100.5', 'x-real-ip': '198.51.100.8' }, body: '{"identityToken":"test-only"}' });
    assert.equal(result.status, 429); assert.equal(result.headers.get('retry-after'), '60');
    assert.equal(result.headers.get('cache-control'), 'no-store'); assert.equal(await result.text(), '{"code":"RATE_LIMITED"}'); assert.ok(seen);
  } finally { if (website) await close(website); await close(api); await rm(root, { recursive: true, force: true }); }
});

test('#79 gateway times out or refuses unavailable upstream without logging upstream credentials', async () => {
  const root = await temporary(); await writeFile(join(root, 'index.html'), 'testnet');
  const api = createServer(() => {}); const upstream = new URL(await listen(api));
  const website = await createTestnetWebsite(root, upstream, 20); const base = await listen(website);
  try {
    assert.deepEqual(await (await fetch(base + '/api/health')).json(), { code: 'API_UNAVAILABLE' });
    await close(api);
    assert.equal((await fetch(base + '/api/health')).status, 502);
    await assert.rejects(createTestnetWebsite(root, new URL('http://secret:secret@localhost')), /invalid API origin/);
    await assert.rejects(createTestnetWebsite(join(root, 'missing'), upstream));
  } finally { await close(website); await rm(root, { recursive: true, force: true }); }
});

test('#79 proxy trust uses exact DNS IPs; missing/malformed DNS fails closed; forged XFF prefix ignored', async () => {
  assert.equal(gatewayClientIp('127.0.0.1', '198.51.100.8'), '198.51.100.8');
  assert.equal(gatewayClientIp('127.0.0.1', '192.0.2.1, 198.51.100.8'), '127.0.0.1');
  for (const header of [undefined, ['192.0.2.1'], '192.0.2.1, invalid', '']) assert.equal(gatewayClientIp('127.0.0.1', header), '127.0.0.1');
  assert.equal(gatewayClientIp(undefined, undefined), 'unknown');
  assert.equal(await websiteProxyIps('website.railway.internal', async () => [{ address: 'fd00::1', family: 6 }]), 'fd00::1');
  for (const host of ['', '*', 'railway.internal', 'evil.example']) await assert.rejects(websiteProxyIps(host), /invalid website proxy host/);
  for (const values of [[], [{ address: 'secret-dns', family: 4 }]]) await assert.rejects(websiteProxyIps('website.railway.internal', async () => values), /^Error: website proxy DNS unavailable$/);
  await assert.rejects(websiteProxyIps('website.railway.internal', async () => { throw new Error('secret-dns'); }), /^Error: website proxy DNS unavailable$/);
});

test('#79 packaging uses runtime allowlist and explicit migrations; excludes env variants, logs, symlinks and Worker', async () => {
  const root = await temporary(); const output = join(root, '.deploy');
  try {
    for (const dir of ['src', 'scripts', 'deploy', 'alto', 'migrations', 'dist']) await mkdir(join(root, dir));
    for (const name of ['package.json', 'bun.lock', 'Dockerfile', 'docker-entrypoint.sh', 'railway.json', 'src/main.ts', 'migrations/0001.sql', 'dist/index.html']) await writeFile(join(root, name), name);
    for (const name of ['src/.env.production', 'scripts/.env.local', 'src/debug.log', '.env.secret', 'dist/_worker.js']) await writeFile(join(root, name), 'secret-test-only');
    await symlink('/etc/hosts', join(root, 'src/link'));
    await prepareDeploy(root, join(root, 'migrations'), output, join(root, 'dist'));
    assert.equal(await readFile(join(output, 'migrations/0001.sql'), 'utf8'), 'migrations/0001.sql');
    assert.equal(await readFile(join(output, 'website/index.html'), 'utf8'), 'dist/index.html');
    for (const name of ['src/.env.production', 'scripts/.env.local', 'src/debug.log', '.env.secret', 'src/link', 'website/_worker.js']) await assert.rejects(readFile(join(output, name)), /ENOENT/);
    await writeFile(join(root, 'alto/railway.json'), '{}');
    await writeFile(join(root, 'alto/railway.toml'), '');
    await prepareDeploy(root, join(root, 'migrations'), output, join(root, 'dist'), false);
    for (const name of ['railway.json', 'alto/railway.json', 'alto/railway.toml']) await assert.rejects(readFile(join(output, name)), /ENOENT/);
    assert.equal(await readFile(join(output, 'Dockerfile'), 'utf8'), 'Dockerfile');
    await assert.rejects(prepareDeploy(root, join(root, 'absent'), output), /找不到 migration/);
    await assert.rejects(prepareDeploy(root, join(root, 'migrations'), output, join(root, 'absent')), /website index/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('#79 all staged service roles and alto hold without DB, RPC or keys; invalid switches/ports fail closed', async () => {
  // Real bun/node, no runtime mocks: the child cannot access a signer or upstream.
  for (const script of ['docker-entrypoint.sh', 'alto/entrypoint.sh']) {
    for (const invalid of [{ SERVICE_ENABLED: 'invalid' }, { SERVICE_ENABLED: '0', PORT: '0' }, { SERVICE_ENABLED: '0', PORT: '65536' }]) {
      const child = spawnSync('sh', [script], { env: { PATH: process.env.PATH, ...invalid }, encoding: 'utf8' }); assert.notEqual(child.status, 0);
    }
    for (const role of script.startsWith('alto') ? ['alto'] : ['api', 'scheduler', 'price-keeper', 'points-sync']) {
      const reservation = createServer(); const url = await listen(reservation); const port = new URL(url).port; await close(reservation);
      const child = spawn('sh', [script], { env: { PATH: process.env.PATH, SERVICE_ENABLED: '0', SERVICE_ROLE: role, PORT: port }, stdio: 'pipe' });
      let ready = false;
      try {
        for (let i = 0; i < 100; i++) {
          try { const r = await fetch(url + '/health'); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { status: 'disabled', code: 'TESTNET_NOT_ACTIVATED' }); ready = true; break; } catch { await pause(20); }
        }
        assert.ok(ready, role); assert.equal((await fetch(url + '/auth/nonce', { method: 'POST' })).status, 503);
      } finally { child.kill('SIGTERM'); await new Promise<void>((done) => child.once('exit', () => done())); }
    }
  }
});

test('#97 current deployment checklist keeps campaign features off and records required budgets', async () => {
  const text = await readFile(new URL('../docs/testnet-deploy.zh-TW.md', import.meta.url), 'utf8');
  const current = text.split('## #79 驗收紀錄')[0] ?? '';
  assert.match(current, /POINTS_ENABLED=0/);
  assert.doesNotMatch(current, /啟用 points 與 points-sync/);
  for (const name of ['OPERATOR_ADDRESS', 'OPERATOR_WALLETS', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'PAYMASTER_MIN_DEPOSIT_WEI',
    'ACCOUNT_DAILY_GAS=100000000', 'PAYMASTER_ACCOUNT_DAILY_COUNT=60', 'PAYMASTER_SITE_DAILY_WEI=100000000000000000',
    'FAUCET_USDT_SITE_DAILY_WEI=1000000000000000000000000', 'WELCOME_USDT_SITE_DAILY_WEI=5000000000000000000000000']) assert.ok(current.includes(name), name);
});

test('#97 opt-in acceptance reaches only its environment-selected local anvil and database', async () => {
  const { runScript } = await import('./fixtures/secret-output.js');
  for (const path of ['test/welcome-grants.fork.ts', 'test/testnet-97.e2e.ts']) {
    const result = await runScript(path, { CHAIN_ID: '97', RPC_URL: 'http://127.0.0.1:8577', PORT: '3077',
      DATABASE_URL: 'postgres://localhost/cre8_be97', TEST_DATABASE_NAME: 'cre8_be97', BUNDLER_URL: 'http://127.0.0.1:3177',
      ALTO_CLI_PATH: 'local-fixture', PAYMASTER_SIGNER_PRIVATE_KEY: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', BUNDLER_EXECUTOR_PRIVATE_KEY: 'local-fixture', BUNDLER_UTILITY_PRIVATE_KEY: 'local-fixture',
    }, `globalThis.fetch = async (url, init) => {
      if (String(url) !== 'http://127.0.0.1:8577') throw new Error('wrong endpoint');
      console.log('ANVIL_ENV_CHECKPOINT'); throw new Error('stop before chain actions');
    };`);
    assert.equal(result.code, 1);
    assert.match(result.output, /ANVIL_ENV_CHECKPOINT/, path);
  }
});

test('#97 acceptance env rejects missing/foreign endpoints, mismatched databases, colliding and invalid ports', async () => {
  const { localAcceptanceEnv } = await import('./fixtures/local-acceptance.js');
  const env = { CHAIN_ID: '97', RPC_URL: 'http://127.0.0.1:8577', PORT: '3077', DATABASE_URL: 'postgres://localhost/cre8_be97', TEST_DATABASE_NAME: 'cre8_be97', BUNDLER_URL: 'http://127.0.0.1:3177' };
  assert.equal(localAcceptanceEnv(env, true).backendPort, 3077);
  for (const PORT of ['1024', '65535']) assert.equal(localAcceptanceEnv({ ...env, PORT }).backendPort, Number(PORT));
  for (const bad of [{ CHAIN_ID: '56' }, { RPC_URL: '' }, { RPC_URL: 'https://public.example:8577' }, { RPC_URL: 'http://localhost:8577/secret' },
    { RPC_URL: 'http://user:password@localhost:8577' }, { BUNDLER_URL: 'http://public.example:3177' }, { BUNDLER_URL: env.RPC_URL },
    { DATABASE_URL: 'postgres://public.example/cre8_be97' }, { TEST_DATABASE_NAME: '' }, { TEST_DATABASE_NAME: 'cre8_other' },
    ...['0', '1023', '65536', '3077.1', 'SECRET', '8577'].map(PORT => ({ PORT }))]) {
    assert.throws(() => localAcceptanceEnv({ ...env, ...bad }, true), (e: unknown) => e instanceof Error && !e.message.includes('SECRET') && !e.message.includes('password'));
  }
});
