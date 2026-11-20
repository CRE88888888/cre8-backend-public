import { createDraftState } from './draft-state.js';
import { createAnthropicDrafter, createDraftStore, InfoDraftError, loadInfoDraftConfig } from './drafter.js';
import type { DraftEvent } from './drafter.js';

export const DRAFT_POLL_MS = 60_000;
export type DraftResult = { attempted: number; drafted: number; conflicted: number; deferred: number; failed: number; error: string | null };
type JobLock = (action: () => Promise<void>) => Promise<void>;

/** Separate opt-in clock. The caller supplies the shared information-job advisory lock. */
export function createInfoDraftJob(deps: { lock: JobLock; env?: NodeJS.ProcessEnv; now?: () => Date;
  store?: ReturnType<typeof createDraftStore>; state?: ReturnType<typeof createDraftState>;
  draft?: (event: DraftEvent) => Promise<string>; log?: (result: DraftResult) => void }) {
  let busy = false, nextRun = 0;
  const now = deps.now ?? (() => new Date());
  return async (): Promise<DraftResult> => {
    const result: DraftResult = { attempted: 0, drafted: 0, conflicted: 0, deferred: 0, failed: 0, error: null };
    if (busy || now().getTime() < nextRun) return result;
    busy = true;
    try {
      const config = loadInfoDraftConfig(deps.env);
      if (!config || config.dailyLimit === 0) return result;
      nextRun = now().getTime() + DRAFT_POLL_MS;
      const store = deps.store ?? createDraftStore(), state = deps.state ?? createDraftState(config.stateDir);
      const draft = deps.draft ?? createAnthropicDrafter(config);
      await deps.lock(async () => {
        if (now().getTime() < await state.cooldownUntil()) return;
        let afterId = '0';
        while (result.attempted < config.batchSize) {
          const events = await store.collected(afterId, config.batchSize);
          if (events.length === 0) break;
          for (const event of events) {
            afterId = event.id;
            const identity = JSON.stringify([event.id, event.source, event.source_ref]);
            if (!await state.ready(identity, now().getTime())) { result.deferred++; continue; }
            if (!await state.reserve(config.dailyLimit, now())) return;
            // Persist retry time before IO so crashes cannot reset the backoff or daily cap.
            const nextAt = await state.begin(identity, now().getTime());
            result.attempted++;
            try {
              const title = await draft(event);
              if (await store.save(event, title)) result.drafted++;
              else result.conflicted++;
              await state.clear(identity);
            } catch (error) {
              result.failed++;
              result.error = error instanceof InfoDraftError ? error.code : 'draft_dependency_unavailable';
              if (error instanceof InfoDraftError && error.code === 'draft_rate_limited') {
                await state.cooldown(Math.max(nextAt, now().getTime() + error.retryAfterMs));
                return;
              }
            }
            if (result.attempted >= config.batchSize) return;
          }
        }
      });
    } catch { result.error = 'draft_dependency_unavailable'; }
    finally { busy = false; }
    if (result.error || result.attempted) {
      (deps.log ?? (row => console.log(JSON.stringify({ job: 'info_drafts', ...row }))))(result);
    }
    return result;
  };
}
