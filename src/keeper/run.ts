import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createKeeperChain, parseManifest, signingAccount, amountSetting } from './chain.js';
import { PriceKeeper } from './engine.js';
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
  return { rpc, manifestPath, scenarioPath, account: signingAccount(env.PRICE_KEEPER_PRIVATE_KEY), settings: { start, minimumUsdtE18, inventoryUsdtE18, swapBudgetUsdtE18, stallSeconds: 90 } };
}

/** Configuration and upstream errors are never printed: they may contain key material or credentialed URLs. */
export async function runPriceKeeper(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const log = (line: string) => console.log(line);
  // The shared sender serves DB-backed alerts too; this standalone keeper retains only process logs.
  const alert = (line: string) => sendTelegram(line, {
    env, log: (message) => log(message.replace('警示已保留在 DB', 'keeper 已停止，警示請見行程 log')),
  });
  let keeper: PriceKeeper;
  let stepSeconds: number;
  try {
    if (args.some((arg) => arg !== '--once') || args.length > 1) throw new Error('usage: price-keeper [--once]');
    const config = loadKeeperSettings(env);
    if (config === null) { log('[price-keeper] disabled (PRICE_KEEPER_ENABLED=0)'); return; }
    const scenario = parseScenario(JSON.parse(await readFile(config.scenarioPath, 'utf8')));
    const manifest = parseManifest(JSON.parse(await readFile(config.manifestPath, 'utf8')));
    const chain = createKeeperChain(config.rpc, config.account, manifest, log);
    await chain.verify();
    keeper = new PriceKeeper(chain.io, scenario, manifest.usdt, manifest.cashFeed, config.settings, log, alert);
    stepSeconds = scenario.stepSeconds;
  } catch {
    const message = '[price-keeper][critical] chain 97 行情 keeper 啟動失敗；請檢查設定、劇本、manifest 與鏈上權限';
    log(message);
    await alert(message);
    throw new Error('price keeper startup failed');
  }
  let stopping = false;
  const abort = new AbortController();
  const stop = () => { stopping = true; abort.abort(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    do {
      await keeper.round();
      if (args.includes('--once') || stopping) break;
      await delay(Math.min(stepSeconds, 15) * 1000, undefined, { signal: abort.signal }).catch(() => {
        if (!stopping) throw new Error('keeper wait failed');
      });
    } while (!stopping);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
