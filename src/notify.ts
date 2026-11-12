import { loadTelegramConfig } from './config.js';

export type TelegramFetch = (url: string, init: RequestInit) => Promise<Response>;

let disabledLogged = false;

/** Telegram 是輔助通知：最多等 5 秒、不重試，任何失敗都不能拋回 scheduler。 */
export async function sendTelegram(
  text: string,
  args: {
    env?: NodeJS.ProcessEnv;
    fetch?: TelegramFetch;
    log?: (line: string) => void;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const log = args.log ?? console.warn;
  const env = args.env ?? process.env;
  try {
    const { botToken, chatId, apiBase } = loadTelegramConfig(env);
    if (botToken === null || chatId === null) {
      if (!disabledLogged) {
        disabledLogged = true;
        log('[Telegram] 未設定 TELEGRAM_BOT_TOKEN／TELEGRAM_CHAT_ID，略過通知（每個行程只提示一次）');
      }
      return;
    }

    const response = await (args.fetch ?? fetch)(`${apiBase}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: redact(text, env).slice(0, 4096) }),
      signal: AbortSignal.timeout(args.timeoutMs ?? 5_000),
      redirect: 'error',
    });
    if (!response.ok) {
      log(`[Telegram] 推送失敗（HTTP ${response.status}）；警示已保留在 DB，不重送`);
      return;
    }
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('ok' in body) || body.ok !== true) {
      log('[Telegram] 推送失敗（API 未回覆 ok: true）；警示已保留在 DB，不重送');
    }
  } catch {
    // fetch 的 error.message 與 Telegram description 可能含帶 token 的 URL，絕不記錄原文。
    log('[Telegram] 推送失敗或逾時；警示已保留在 DB，不重送');
  }
}

/** detail 可能來自上游 last_error；已知 secrets 與常見憑證形狀不送到外部。 */
function redact(text: string, env: NodeJS.ProcessEnv): string {
  let safe = text;
  for (const name of [
    'TELEGRAM_BOT_TOKEN', 'DATABASE_URL', 'OPERATOR_PRIVATE_KEY', 'SESSION_KEY_MASTER_SEED',
    'RPC_URL', 'ANVIL_RPC_URL', 'BUNDLER_URL',
  ]) {
    const value = env[name]?.trim();
    if (value) safe = safe.split(value).join('[redacted]');
  }
  return safe
    .replace(/(?:https?|postgres(?:ql)?):\/\/[^\s)]+/gi, '[redacted URL]')
    .replace(/\b0x[0-9a-f]{64}\b/gi, '[redacted]')
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, '[redacted]');
}
