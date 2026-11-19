import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createKeeperChain, parseManifest, signingAccount, amountSetting } from './chain.js';
import { isTransientRpcError, PriceKeeper, RpcRetry, safeReason } from './engine.js';
import { parseScenario, positiveAmount } from './scenario.js';
import { sendTelegram } from '../notify.js';

export function loadKeeperSettings(env: NodeJS.ProcessEnv) {
  if (env.PRICE_KEEPER_ENABLED !== undefined && env.PRICE_KEEPER_ENABLED !== '0' && env.PRICE_KEEPER_ENABLED !== '1') throw new Error('PRICE_KEEPER_ENABLED requires 0 or 1');
  if (env.PRICE_KEEPER_ENABLED !== '1') return null;
  const rpc = env.PRICE_KEEPER_RPC_URL;
  if (!rpc) throw new Error('PRICE_KEEPER_RPC_URL is required');
  try {
    const url = new URL(rpc);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('invalid RPC protocol');
  } catch { throw new Error('invalid keeper RPC configuration'); }
  const manifestPath = env.PRICE_KEEPER_MANIFEST;
  const scenarioPath = env.PRICE_KEEPER_SCENARIO;
  if (!manifestPath || !scenarioPath) throw new Error('PRICE_KEEPER_MANIFEST and PRICE_KEEPER_SCENARIO are required');
  const start = positiveAmount(env.PRICE_KEEPER_START_TIMESTAMP);
  if (start > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('invalid replay start');
  const minimumUsdtE18 = amountSetting(env, 'PRICE_KEEPER_MIN_INVENTORY_E18', 10_000n * 10n ** 18n);
  const inventoryUsdtE18 = amountSetting(env, 'PRICE_KEEPER_INVENTORY_E18', 100_000n * 10n ** 18n);
  const swapBudgetUsdtE18 = amountSetting(env, 'PRICE_KEEPER_SWAP_BUDGET_E18', 10_000n * 10n ** 18n);
  if (minimumUsdtE18 >= inventoryUsdtE18 || swapBudgetUsdtE18 > minimumUsdtE18) throw new Error('invalid inventory thresholds');
  const timeout = env.PRICE_KEEPER_RPC_FAILURE_TIMEOUT_SECONDS ?? '1800';
  const rpcFailureTimeoutSeconds = Number(timeout);
  if (!/^[0-9]+$/.test(timeout) || !Number.isInteger(rpcFailureTimeoutSeconds) || rpcFailureTimeoutSeconds < 1 || rpcFailureTimeoutSeconds > 86_400) throw new Error('PRICE_KEEPER_RPC_FAILURE_TIMEOUT_SECONDS must be an integer between 1 and 86400');
  return { rpc, manifestPath, scenarioPath, account: signingAccount(env.PRICE_KEEPER_PRIVATE_KEY), settings: { start, minimumUsdtE18, inventoryUsdtE18, swapBudgetUsdtE18, stallSeconds: 90, rpcFailureTimeoutSeconds } };
}

async function readJson(path: string, kind: 'scenario' | 'manifest'): Promise<unknown> {
  const text = await readFile(path, 'utf8');
  try { return JSON.parse(text); } catch { throw new Error(`invalid ${kind} JSON`); }
}

/** Only allowlisted reasons reach logs; upstream messages can contain credentials. */
export async function runPriceKeeper(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const log = (line: string) => console.log(line);
  // The shared sender serves DB-backed alerts too; this standalone keeper retains only process logs.
  const alert = (line: string) => sendTelegram(line, {
    env, log: (message) => log(message.replace('警示已保留在 DB', 'keeper 已停止，警示請見行程 log')),
  });
  let stopping = false;
  const abort = new AbortController();
  const stop = () => { stopping = true; abort.abort(); };
  const wait = (ms: number) => delay(ms, undefined, { signal: abort.signal }).catch(() => {
    if (!stopping) throw new Error('keeper wait failed');
  });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    let keeper: PriceKeeper;
    let stepSeconds: number;
    let stage = 'configuration';
    try {
      if (args.some((arg) => arg !== '--once') || args.length > 1) throw new Error('usage: price-keeper [--once]');
      const config = loadKeeperSettings(env);
      if (config === null) { log('[price-keeper] disabled (PRICE_KEEPER_ENABLED=0)'); return; }
      stage = 'scenario';
      const scenario = parseScenario(await readJson(config.scenarioPath, 'scenario'));
      stage = 'manifest';
      const manifest = parseManifest(await readJson(config.manifestPath, 'manifest'));
      stage = 'verify';
      const chain = createKeeperChain(config.rpc, config.account, manifest, log);
      const retry = new RpcRetry(config.settings.rpcFailureTimeoutSeconds);
      while (!stopping) {
        retry.check();
        try { await chain.verify(); break; }
        catch (error) {
          if (!isTransientRpcError(error)) throw error;
          const delayMs = retry.fail();
          log(`[price-keeper][warning] startup ${stage}: ${safeReason(error)}; retryMs=${delayMs}`);
          await wait(delayMs);
        }
      }
      if (stopping) return;
      keeper = new PriceKeeper(chain.io, scenario, manifest.usdt, manifest.cashFeed, config.settings, log, alert);
      stepSeconds = scenario.stepSeconds;
    } catch (error) {
      const message = `[price-keeper][critical] chain 97 行情 keeper 啟動失敗：${stage}: ${safeReason(error)}；請檢查設定、劇本、manifest 與鏈上權限`;
      log(message);
      try { await alert(message); } catch { log('[price-keeper] Telegram 通知失敗'); }
      throw new Error('price keeper startup failed');
    }
    do {
      await keeper.round();
      if (args.includes('--once') || stopping) break;
      await wait(keeper.retryDelayMs || Math.min(stepSeconds, 15) * 1000);
    } while (!stopping);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
