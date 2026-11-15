import { object, unavailable } from './yield-domain.js';
import type { YieldOperationJournal } from './yield-execution.js';
export type { YieldAction,YieldPlan,YieldEvidence,SavedYieldOperation,YieldReceiptResult,YieldOperationJournal,YieldSubmitArgs } from './yield-execution.js';

/** BE-4 is the authoritative boundary; no copied execution/session types. */
export type YieldPrepare=Parameters<YieldOperationJournal['prepare']>[0];
export type YieldExecutionPort=Pick<typeof import('./yield-execution.js'),'submitYieldAction'|'reconcileYieldOperation'>;
function isPort(v: unknown): v is YieldExecutionPort {
  const m = object(v);
  return typeof m.submitYieldAction === 'function' && typeof m.reconcileYieldOperation === 'function';
}
/** Lazy loading avoids initializing the scheduler/session cycle while HTTP dependencies are created. */
export async function yieldExecutionPort(): Promise<YieldExecutionPort> {
  try {
    const modulePath = './yield-execution.js';
    const loaded: unknown = await import(modulePath);
    if (isPort(loaded)) return loaded;
  } catch { /* missing/incompatible BE-4 dependency */ }
  throw unavailable();
}
