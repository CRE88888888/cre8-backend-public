import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { startWorkerHealth, workerHealthPort } from '../src/worker-health.js';

test('#136 readiness serves only GET /health and closes without waiting for clients', async () => {
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, '::', done));
  const address = reservation.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done) => reservation.close(() => done()));
  const stop = await startWorkerHealth({ CHAIN_ID: '97', SERVICE_ENABLED: '1', PORT: String(address.port) });
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const health = await fetch(base + '/health');
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await health.json(), { status: 'ok' });
    for (const [path, method] of [['/health?x=1', 'GET'], ['/health', 'POST'], ['/api/strategies', 'GET']]) {
      assert.equal((await fetch(base + path, { method })).status, 404);
    }
  } finally { await stop(); }
  await assert.rejects(fetch(base + '/health'));
});

test('#136 readiness stays disabled outside enabled chain 97 workers', async () => {
  for (const env of [{}, { CHAIN_ID: '56', SERVICE_ENABLED: '1', PORT: 'bad-secret' },
    { CHAIN_ID: '97', SERVICE_ENABLED: '0', PORT: 'bad-secret' }]) {
    await (await startWorkerHealth(env))();
  }
});

test('#136 readiness rejects invalid port bounds and bind failures without echoing input', async () => {
  assert.equal(workerHealthPort(), 8080);
  for (const port of ['1', '65535']) assert.equal(workerHealthPort(port), Number(port));
  for (const port of ['0', '-1', '65536', '1.5', 'bad-secret', '']) {
    await assert.rejects(startWorkerHealth({ CHAIN_ID: '97', SERVICE_ENABLED: '1', PORT: port }), /^Error: worker readiness port invalid$/);
  }
  const held = createServer();
  await new Promise<void>((done) => held.listen(0, '::', done));
  try {
    const address = held.address(); assert.ok(address && typeof address !== 'string');
    await assert.rejects(startWorkerHealth({ CHAIN_ID: '97', SERVICE_ENABLED: '1', PORT: String(address.port) }), /^Error: worker readiness unavailable$/);
  } finally { await new Promise<void>((done) => held.close(() => done())); }
});

test('#136 keeper startup failure closes readiness; --once does not bind an HTTP port', async () => {
  const held = createServer();
  await new Promise<void>((done) => held.listen(0, '::', done));
  const address = held.address(); assert.ok(address && typeof address !== 'string');
  const env = { PATH: process.env.PATH, CHAIN_ID: '97', SERVICE_ENABLED: '1', PORT: String(address.port), PRICE_KEEPER_ENABLED: '0' };
  try {
    const once = spawnSync(process.execPath, ['--no-env-file', 'scripts/price-keeper.ts', '--once'], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(once.status, 0, once.stderr);
    const busy = spawnSync(process.execPath, ['--no-env-file', 'scripts/price-keeper.ts'], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(busy.status, 1);
    assert.match(busy.stderr, /stopped; check worker readiness/);
  } finally { await new Promise<void>((done) => held.close(() => done())); }
  const failed = spawnSync(process.execPath, ['--no-env-file', 'scripts/price-keeper.ts'], {
    env: { ...env, PRICE_KEEPER_ENABLED: '1' }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(failed.status, 1, 'missing RPC exits rather than leaving readiness running');
  assert.match(failed.stdout, /keeper 啟動失敗/);
  await assert.rejects(fetch(`http://127.0.0.1:${address.port}/health`));
});
