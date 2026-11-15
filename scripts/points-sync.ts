/** Calls the same service as POST /operator/points/sync; no HTTP bearer or signing key needed. */
import { setTimeout as delay } from 'node:timers/promises';
import { createPointsService } from '../src/points.js';
import { closePool } from '../src/db.js';
import { pathToFileURL } from 'node:url';

export async function runPointsSync(args: string[], env: NodeJS.ProcessEnv, sync = () => createPointsService().sync(), close = closePool) {
  if (env.CHAIN_ID !== '97') throw new Error('points worker requires chain 97');
  if (args.length > 1 || args.some((arg) => arg !== '--once')) throw new Error('usage: points-sync [--once]');
  const interval = Number(env.POINTS_SYNC_INTERVAL || '300');
  if (!Number.isSafeInteger(interval) || interval < 60 || interval > 86400) throw new Error('invalid points interval');
  let stopping = false;
  const abort = new AbortController();
  const stop = () => { stopping = true; abort.abort(); };
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, stop);
  try {
    do {
      await sync();
      console.log('[points-sync] round completed');
      if (args.includes('--once') || stopping) break;
      await delay(interval * 1000, undefined, { signal: abort.signal }).catch(() => { if (!stopping) throw new Error('wait failed'); });
    } while (!stopping);
  } finally {
    for (const signal of ['SIGTERM', 'SIGINT']) process.removeListener(signal, stop);
    await close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPointsSync(process.argv.slice(2), process.env).catch(() => { console.error('[points-sync] round failed; check points settings, DB and RPC'); process.exitCode = 1; });
}
