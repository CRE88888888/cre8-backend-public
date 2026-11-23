import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPortfolioStatusReader, statusRpcClient } from '../src/operator.js';
import type { PortfolioPlan } from '../src/snapshot.js';
import { AppError, errorChain } from '../src/errors.js';
import { unavailable } from '../src/yield-domain.js';
import type { requireOwnedPortfolio } from '../src/portfolios.js';

/**
 * /me/overview 的三檔一直 pending（背景刷新 >95 秒沒有錯誤也沒有 log）：狀態計算沒有上限，3 份卡住的
 * 計算占滿 overview 全進程 3 個名額。這裡驗：狀態有上限、逾時變成 503 STATUS_TIMEOUT 並寫 log、
 * 不進快取；被放棄的計算之後的 RPC 請求立刻失敗、不再打到節點。
 */

const owned = async () => ({ version: 1 }) as unknown as Awaited<ReturnType<typeof requireOwnedPortfolio>>;

test('a status computation that never finishes becomes STATUS_TIMEOUT, is logged with its cause and is not cached', async () => {
  const lines: string[] = [];
  let calls = 0;
  const reader = createPortfolioStatusReader({
    planPortfolio: () => { calls += 1; return new Promise<PortfolioPlan>(() => {}); },
    requireOwnedPortfolio: owned,
    timeoutMs: 50,
    log: (line) => lines.push(line),
  });
  const started = Date.now();
  await assert.rejects(reader(9, '0x00000000000000000000000000000000000000aa'), (error: unknown) =>
    error instanceof AppError && error.status === 503 && error.code === 'STATUS_TIMEOUT');
  assert.ok(Date.now() - started < 1_000);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /portfolio status failed/);
  assert.match(lines[0] ?? '', /STATUS_TIMEOUT/);
  await assert.rejects(reader(9, '0x00000000000000000000000000000000000000aa'));
  assert.equal(calls, 2, 'a timed-out status is retried, not served from cache');
});

test('the status RPC client stops reaching the node once its computation is abandoned', async () => {
  let hits = 0;
  const server = createServer(() => { hits += 1; /* never answers */ });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const controller = new AbortController();
    const client = statusRpcClient(url, controller.signal);
    const pending = client.getBlockNumber({ cacheTime: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    controller.abort(new Error('status timeout'));
    await assert.rejects(pending);
    assert.ok(Date.now() - started < 1_000, 'in-flight request is aborted, not left to its 8 s timeout');
    const before = hits;
    await assert.rejects(client.getChainId());
    assert.equal(hits, before, 'no new request reaches the node after the abort');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('yield failures name the failing check and keep the underlying cause in the log chain', () => {
  const rpc = new Error('HTTP request failed.\nURL: https://rpc.example/key-SECRET');
  rpc.name = 'HttpRequestError';
  const error = unavailable('stale-block:100:age-75000ms', rpc);
  assert.equal(error.message, '生息資料或持久化證據不完整，保留部位與在途', 'public message unchanged');
  const line = errorChain(error);
  assert.match(line, /^AppError: 生息資料或持久化證據不完整.* ← \[yield:stale-block:100:age-75000ms\] ← HttpRequestError: HTTP request failed\. \| URL: <url>$/);
  assert.ok(!line.includes('SECRET'));
  assert.equal(errorChain(unavailable()), 'AppError: 生息資料或持久化證據不完整，保留部位與在途');
});
