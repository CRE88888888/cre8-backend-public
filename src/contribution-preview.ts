import { Worker } from 'node:worker_threads';
import { AppError } from './errors.js';
import { RateLimitError } from './ratelimit.js';
import type { previewContribution } from './strategies.js';
import { contributionPreviewInput } from './strategies.js';

export const PREVIEW_CONCURRENCY = 2;
export const PREVIEW_QUEUE_LIMIT = 4;
export const PREVIEW_TIMEOUT_MS = 1_000;
type Preview = ReturnType<typeof previewContribution>;
export type PreviewWorkerRequest<T = unknown> = { input: T; confirmedAt: Date };
export type PreviewWorkerReply = { ok: true; value: Preview } | { ok: false; error: { status: number; code: string; message: string } };
type Task = PreviewWorkerRequest & { resolve: (value: Preview) => void; reject: (error: AppError) => void };

function unavailable(): AppError {
  return new AppError(503, 'PREVIEW_UNAVAILABLE', 'contribution preview unavailable; retry later');
}

/** Shared by every HTTP server in this process. No idle workers or unbounded work. */
export class ContributionPreviewPool {
  #active = 0;
  readonly #queue: Task[] = [];
  constructor(readonly workerUrl = new URL('./contribution-preview-worker.ts', import.meta.url)) {}

  run(input: unknown, confirmedAt = new Date()): Promise<Preview> {
    if (this.#active >= PREVIEW_CONCURRENCY && this.#queue.length >= PREVIEW_QUEUE_LIMIT) {
      return Promise.reject(new RateLimitError(1));
    }
    return new Promise((resolve, reject) => {
      const task = { input, confirmedAt, resolve, reject };
      if (this.#active < PREVIEW_CONCURRENCY) this.#start(task);
      else this.#queue.push(task);
    });
  }

  #start(task: Task): void {
    this.#active++;
    let worker: Worker | undefined;
    let finished = false;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.#active--;
      const next = this.#queue.shift();
      if (next) this.#start(next);
    };
    const finish = (outcome: { value: Preview } | { error: AppError }) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // Reply at the deadline; termination can take longer under CPU pressure.
      if ('error' in outcome) task.reject(outcome.error);
      else task.resolve(outcome.value);
      // Do not free a slot until the CPU work actually stops, even after timeout.
      // If termination rejects, only an observed exit may release the slot.
      if (worker) void worker.terminate().then(release, () => {});
      else release();
    };
    // Budget includes worker startup; queue wait is bounded by two earlier waves.
    const timer = setTimeout(() => finish({ error: new AppError(503, 'PREVIEW_TIMEOUT', 'contribution preview exceeded the one-second budget') }), PREVIEW_TIMEOUT_MS);
    try {
      worker = new Worker(this.workerUrl);
      worker.once('message', (reply: PreviewWorkerReply) => {
        if (reply.ok) finish({ value: reply.value });
        else finish({ error: new AppError(reply.error.status, reply.error.code, reply.error.message) });
      });
      worker.once('error', () => finish({ error: unavailable() }));
      worker.once('messageerror', () => finish({ error: unavailable() }));
      worker.once('exit', () => { finish({ error: unavailable() }); release(); });
      worker.postMessage({ input: task.input, confirmedAt: task.confirmedAt } satisfies PreviewWorkerRequest);
    } catch {
      finish({ error: unavailable() });
    }
  }
}

const previews = new ContributionPreviewPool();
export async function previewContributionAsync(input: unknown, confirmedAt = new Date()): Promise<Preview> {
  // Only bounded schema validation runs here; the expensive calendar stays in the worker.
  return previews.run(contributionPreviewInput(input), confirmedAt);
}
