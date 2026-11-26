import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, loadTelegramConfig } from '../src/config.js';
import { recordAlerts, resolveAlerts } from '../src/alerts.js';
import type { AlertFinding, QueryFn } from '../src/alerts.js';
import { sendTelegram } from '../src/notify.js';
import type { TelegramFetch } from '../src/notify.js';
import { runSchedulerOnce } from '../src/scheduler.js';
import type { SchedulerQueryFn } from '../src/scheduler.js';

const NOW = new Date('2026-11-13T01:00:00.000Z');
const env = { TELEGRAM_BOT_TOKEN: 'local-test-only', TELEGRAM_CHAT_ID: 'test-chat', TELEGRAM_API_BASE: 'http://127.0.0.1:8082' };
const finding: AlertFinding = { kind: 'portfolio_repeatedly_failing', severity: 'critical', portfolioId: 305, detail: '3 failed operations' };
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: finding.kind, severity: finding.severity, portfolio_id: '305', detail: finding.detail,
    first_seen_at: new Date('2026-11-12T01:00:00.000Z'), last_seen_at: NOW, resolved_at: NOW,
    inserted: true, previous_severity: null, ...overrides,
  };
}

test('Telegram 設定：兩個留空停用、只填一個在啟動時報錯且不洩露值', () => {
  assert.equal(loadTelegramConfig({}).botToken, null);
  assert.equal(loadTelegramConfig({ TELEGRAM_BOT_TOKEN: ' ', TELEGRAM_CHAT_ID: '' }).chatId, null);
  for (const partial of [{ TELEGRAM_BOT_TOKEN: 'secret-test' }, { TELEGRAM_CHAT_ID: 'secret-chat' }]) {
    assert.throws(() => loadConfig({ DATABASE_URL: 'postgres://test', ...partial }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /必須一起設定/);
      assert.doesNotMatch(error.message, /secret-test|secret-chat/);
      return true;
    });
  }
  assert.equal(loadTelegramConfig({ ...env, TELEGRAM_API_BASE: 'http://127.0.0.1:8082///' }).apiBase, env.TELEGRAM_API_BASE);
  for (const base of ['invalid-secret', 'file:///tmp/test', 'https://user:secret@example.com', 'https://example.com?token=secret']) {
    assert.throws(() => loadTelegramConfig({ ...env, TELEGRAM_API_BASE: base }), /TELEGRAM_API_BASE 必須是/);
  }
});

test('#56 production Telegram requires HTTPS; local development still accepts HTTP', () => {
  assert.throws(() => loadTelegramConfig({ ...env, NODE_ENV: 'production' }), /TELEGRAM_API_BASE.*https/);
  assert.equal(loadTelegramConfig({ ...env, NODE_ENV: 'test' }).apiBase, env.TELEGRAM_API_BASE);
  assert.equal(loadTelegramConfig({ ...env, NODE_ENV: 'development' }).apiBase, env.TELEGRAM_API_BASE);
  assert.equal(loadTelegramConfig({ NODE_ENV: 'production' }).apiBase, 'https://api.telegram.org');
  assert.equal(loadTelegramConfig({ ...env, NODE_ENV: 'production', TELEGRAM_API_BASE: 'https://api.telegram.org///' }).apiBase, 'https://api.telegram.org');
});

test('未設定：不呼叫 fetch，每個行程只 log 一次', async () => {
  const lines: string[] = [];
  const args = { env: {}, fetch: async () => { throw new Error('不應打網路'); }, log: (line: string) => lines.push(line) };
  await sendTelegram('first', args);
  await sendTelegram('second', args);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /未設定/);
});

test('Telegram token 的冒號保留在官方 sendMessage 路徑', async () => {
  let requested = '';
  await sendTelegram('test', {
    env: { ...env, TELEGRAM_BOT_TOKEN: 'test:local-only' },
    fetch: async (url) => {
      requested = url;
      return Response.json({ ok: true });
    },
  });
  assert.equal(requested, `${env.TELEGRAM_API_BASE}/bottest:local-only/sendMessage`);
});

test('新 critical／warn 升級各推一次；同一未解除 critical、warn 都不推', async () => {
  const bodies: { chat_id: string; text: string }[] = [];
  const fakeFetch: TelegramFetch = async (url, init) => {
    assert.equal(url, `${env.TELEGRAM_API_BASE}/botlocal-test-only/sendMessage`);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    bodies.push(JSON.parse(String(init.body)));
    return Response.json({ ok: true });
  };
  let returned = row();
  const query: QueryFn = async () => ({ rows: [returned] });
  const options = { dryRun: true, chainId: 1337, send: (text: string) => sendTelegram(text, { env, fetch: fakeFetch }) };
  await recordAlerts(query, [finding], NOW, options);
  returned = row({ inserted: false, previous_severity: 'critical' });
  await recordAlerts(query, [finding], NOW, options);
  returned = row({ inserted: false, previous_severity: 'warn' });
  await recordAlerts(query, [finding], NOW, options);
  returned = row({ severity: 'warn' });
  await recordAlerts(query, [{ ...finding, severity: 'warn' }], NOW, options);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0]?.chat_id, 'test-chat');
  const message = bodies[0]?.text ?? '';
  for (const field of ['[dry-run][critical]', finding.kind, 'portfolio id: 305', 'detail: 3 failed operations', 'CHAIN_ID: 1337', 'first_seen: 2026-11-12T01:00:00.000Z', `last_seen: ${NOW.toISOString()}`]) {
    assert.ok(message.includes(field), `缺少 ${field}`);
  }
});

test('解除只推 critical，保留原 first/last_seen，live 模式不會誤標 dry-run', async () => {
  const messages: string[] = [];
  const query: QueryFn = async () => ({ rows: [row(), row({ severity: 'warn' })] });
  const count = await resolveAlerts(query, [], NOW, { dryRun: false, chainId: 56, send: async (text) => { messages.push(text); } });
  assert.equal(count, 2);
  assert.equal(messages.length, 1);
  assert.match(messages[0] ?? '', /^\[live\]\[critical\] 已解除/);
  assert.match(messages[0] ?? '', /resolved_at: 2026-11-13T01:00:00.000Z/);
  assert.doesNotMatch(messages[0] ?? '', /dry-run/);
});

test('HTTP、API、JSON、網路與 timeout 失敗只 log，不洩漏 token 或上游錯誤內容', async () => {
  const lines: string[] = [];
  const failures: TelegramFetch[] = [
    async () => new Response('local-test-only', { status: 503 }),
    async () => Response.json({ ok: false, description: 'local-test-only' }),
    async () => new Response('local-test-only'),
    async () => { throw new Error('http://localhost/botlocal-test-only/sendMessage'); },
    async (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('local-test-only timeout')), { once: true });
    }),
  ];
  for (const fakeFetch of failures) {
    await sendTelegram('test', { env, fetch: fakeFetch, timeoutMs: 10, log: (line) => lines.push(line) });
  }
  assert.equal(lines.length, failures.length);
  assert.ok(lines.every((line) => line.includes('失敗')));
  assert.doesNotMatch(lines.join('\n'), /local-test-only|http:\/\//);
});

test('detail 的憑證在外送前遮罩，長訊息符合 Telegram 4096 字上限', async () => {
  let sent = '';
  const fakeFetch: TelegramFetch = async (_url, init) => {
    sent = (JSON.parse(String(init.body)) as { text: string }).text;
    return Response.json({ ok: true });
  };
  const secrets = { ...env, DATABASE_URL: 'postgres://local-user:local-pass@localhost/local-db', OPERATOR_PRIVATE_KEY: `0x${'a'.repeat(64)}` };
  await sendTelegram(`${secrets.TELEGRAM_BOT_TOKEN} ${secrets.DATABASE_URL} ${secrets.OPERATOR_PRIVATE_KEY} https://rpc.example/token ${'x'.repeat(5000)}`, { env: secrets, fetch: fakeFetch });
  for (const secret of [secrets.TELEGRAM_BOT_TOKEN, secrets.DATABASE_URL, secrets.OPERATOR_PRIVATE_KEY, 'https://rpc.example/token']) assert.ok(!sent.includes(secret));
  assert.equal(sent.length, 4096);
});

test('注入的 sender 拋錯也不會中斷寫入其他警示或解除', async () => {
  const lines: string[] = [];
  let calls = 0;
  const query: QueryFn = async () => { calls += 1; return { rows: [row()] }; };
  const options = { dryRun: true, chainId: 1337, log: (line: string) => lines.push(line), send: async () => { throw new Error('secret'); } };
  await recordAlerts(query, [finding, finding], NOW, options);
  assert.equal(await resolveAlerts(query, [], NOW, options), 1);
  assert.equal(calls, 3);
  assert.equal(lines.length, 3);
  assert.doesNotMatch(lines.join('\n'), /secret/);
});

test('scheduler 一輪：傳入實際 dry-run/live 與 chainId；fetch 失敗仍回傳正常結果並跑解除', async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  const originalChat = process.env.TELEGRAM_CHAT_ID;
  try {
    process.env.TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_CHAT_ID = env.TELEGRAM_CHAT_ID;
    for (const dryRun of [true, false]) {
      let sent = '';
      let resolved = false;
      const lines: string[] = [];
      globalThis.fetch = (async (_url, init) => {
        sent = (JSON.parse(String(init?.body)) as { text: string }).text;
        throw new Error('local-test-only');
      }) as typeof fetch;
      const query: SchedulerQueryFn = (async (sql: string) => {
        if (sql.includes('row_number() over')) return { rows: [{ portfolio_id: '305', failed_count: 3, last_state: 'failed', last_error: 'test' }] };
        if (sql.includes('insert into scheduler_alerts')) return { rows: [row()] };
        if (sql.includes('update scheduler_alerts')) resolved = true;
        return { rows: [] };
      }) as SchedulerQueryFn;
      const round = await runSchedulerOnce({ dryRun, now: NOW }, {
        query, chainId: 1337, log: (line) => lines.push(line),
        withTransaction: (async (fn: (client: { query: SchedulerQueryFn }) => Promise<unknown>) => fn({ query: async () => ({ rows: [] }) })) as never,
      });
      assert.deepEqual(round, { claimed: 0, dryRun, results: [] });
      assert.ok(resolved);
      assert.ok(sent.startsWith(`[${dryRun ? 'dry-run' : 'live'}][critical]`));
      assert.match(sent, /CHAIN_ID: 1337/);
      assert.ok(lines.some((line) => line.includes('[Telegram] 推送失敗')));
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = originalToken;
    if (originalChat === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = originalChat;
  }
});
