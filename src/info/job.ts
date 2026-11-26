import path from 'node:path';
import { ConfigurationError } from '../config.js';
import { withConnection } from '../db.js';
import { readInfoCatalogue } from './catalogue.js';
import { beaCollector } from './collectors/bea.js';
import { blsCollector } from './collectors/bls.js';
import { fedCollector } from './collectors/fed.js';
import { fredCollector } from './collectors/fred.js';
import { secCollector } from './collectors/sec.js';
import { strategyCollector } from './collectors/strategy.js';
import { treasuryCollector } from './collectors/treasury.js';
import { reserveBlsRequest } from './quota.js';
import { createInfoGet } from './source.js';
import { saveInfoBatch } from './store.js';
import { failureCode } from './types.js';
import { createInfoDraftJob } from './draft-job.js';
import { createCloseJob } from '../model-returns/collector.js';
import type { InfoBatch, InfoCollector } from './types.js';

export function loadInfoConfig(env: NodeJS.ProcessEnv = process.env) {
  const flag = env.INFO_COLLECTORS_ENABLED?.trim() || '0';
  if (!['0', '1'].includes(flag)) throw new ConfigurationError('INFO_COLLECTORS_ENABLED must be 0 or 1');
  if (flag === '0') return null;
  const raw = env.INFO_COLLECTORS_INTERVAL_SECONDS?.trim() || '1800';
  if (!/^\d+$/.test(raw) || Number(raw) < 60 || Number(raw) > 86400) throw new ConfigurationError('INFO_COLLECTORS_INTERVAL_SECONDS must be in 60..86400');
  const userAgent = env.SEC_USER_AGENT?.trim() || null;
  if (userAgent && (userAgent.length > 250 || /[\r\n\x00-\x1f\x7f]/.test(userAgent))) throw new ConfigurationError('SEC_USER_AGENT must be a single header value');
  return { intervalMs: Number(raw) * 1000, userAgent,
    stateDir: path.resolve(env.INFO_COLLECTORS_STATE_DIR?.trim() || '.info-collectors') };
}

export type InfoCollectorResult = { collector: string; events: number; markets: number; savedEvents: number; savedMarkets: number; error: string | null };

/** Serial sources avoid bursts; one source/DB transaction failing never aborts the other sources. */
export async function runInfoCollectors(collectors: readonly InfoCollector[], save: (batch: InfoBatch) => Promise<{ events: number; markets: number }> = saveInfoBatch,
  log: (result: InfoCollectorResult) => void = result => console.log(JSON.stringify({ job: 'info_collectors', ...result }))): Promise<InfoCollectorResult[]> {
  const results: InfoCollectorResult[] = [];
  for (const collector of collectors) {
    const result: InfoCollectorResult = { collector: collector.name, events: 0, markets: 0, savedEvents: 0, savedMarkets: 0, error: null };
    try {
      const batch = await collector.collect();
      result.events = batch.events.length; result.markets = batch.markets.length;
      const saved = await save(batch);
      result.savedEvents = saved.events; result.savedMarkets = saved.markets;
    } catch (error) { result.error = failureCode(error); }
    results.push(result); log(result);
  }
  return results;
}

export async function withInfoJobLock(action: () => Promise<void>): Promise<void> {
  await withConnection(async (client, discard) => {
    let acquired = false;
    const disconnected = () => discard();
    client.on('error', disconnected);
    try {
      acquired = (await client.query<{ locked: boolean }>("select pg_try_advisory_lock(hashtextextended('backend:info_collectors',0)) as locked")).rows[0]?.locked === true;
      if (acquired) await action();
    } finally {
      if (acquired) {
        try { if ((await client.query<{ unlocked: boolean }>("select pg_advisory_unlock(hashtextextended('backend:info_collectors',0)) as unlocked")).rows[0]?.unlocked !== true) discard(); }
        catch { discard(); }
      }
      client.removeListener('error', disconnected);
    }
  }, { reuse: false });
}

export function createInfoJob(deps: { env?: NodeJS.ProcessEnv; now?: () => Date; collectors?: readonly InfoCollector[];
  save?: (batch: InfoBatch) => Promise<{ events: number; markets: number }>;
  lock?: (action: () => Promise<void>) => Promise<void>; log?: (result: InfoCollectorResult) => void } = {}) {
  let nextRun = 0, busy = false;
  const now = deps.now ?? (() => new Date());
  // Preserve the BLS four-hour poll clock between rounds. Each poll gets its own network deadline.
  const bls = blsCollector(async url => {
    if (!blsGet) blsGet = createInfoGet();
    return blsGet(url);
  }, () => {
    const config = loadInfoConfig(deps.env);
    if (!config) return Promise.resolve(false);
    return reserveBlsRequest(config.stateDir, now());
  }, () => now().getTime());
  let blsGet: ReturnType<typeof createInfoGet> | undefined;
  return async (): Promise<InfoCollectorResult[]> => {
    const config = loadInfoConfig(deps.env);
    if (!config || busy || now().getTime() < nextRun) return [];
    busy = true;
    nextRun = now().getTime() + config.intervalMs;
    try {
      blsGet = undefined;
      const collectors = deps.collectors ?? [fedCollector(createInfoGet()), beaCollector(createInfoGet()), bls,
        treasuryCollector(createInfoGet(), now), fredCollector(createInfoGet()),
        secCollector(createInfoGet(), config.userAgent, readInfoCatalogue), strategyCollector(createInfoGet())];
      let results: InfoCollectorResult[] = [];
      await (deps.lock ?? withInfoJobLock)(async () => { results = await runInfoCollectors(collectors, deps.save, deps.log); });
      return results;
    } finally { busy = false; }
  };
}

/** Collection and drafting have independent switches; either failure leaves the other job runnable. */
export function createInfoBackgroundJob(collect: () => Promise<unknown> = createInfoJob(),
  draft: () => Promise<unknown> = createInfoDraftJob({ lock: withInfoJobLock }),
  onError = () => console.error('[info] job unavailable; retry on next due round'),
  closes: () => Promise<unknown> = createCloseJob()) {
  return async (): Promise<boolean> => {
    let successful = true;
    for (const run of [collect, draft, closes]) {
      try { await run(); } catch { successful = false; onError(); }
    }
    return successful;
  };
}

/** Trading ticks never await information IO. Stop drains the single in-flight round before closing DB. */
export function createInfoWorker(run: () => Promise<unknown> = createInfoBackgroundJob(), onError = () => console.error('[info_collectors] job unavailable; retry on next due round')) {
  let pending: Promise<void> | null = null;
  return {
    tick(): void {
      if (pending) return;
      pending = Promise.resolve().then(run).then(() => {}, onError).finally(() => { pending = null; });
    },
    async stop(): Promise<void> { await pending; },
  };
}
