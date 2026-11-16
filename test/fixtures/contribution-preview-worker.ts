import { parentPort } from 'node:worker_threads';
import { previewFundingContribution } from '../../src/asset-plan.js';
import type { ContributionPreviewInput } from '../../src/asset-plan.js';
import { record } from '../../src/strategy-execution.js';
import type { PreviewWorkerRequest } from '../../src/contribution-preview.js';

/** Real worker fault/control fixture; successful replies still use the real planner. */
type FixtureInput = { body: ContributionPreviewInput; action?: string; control?: SharedArrayBuffer; uncloneable?: () => void };
parentPort?.once('message', ({ input, confirmedAt }: PreviewWorkerRequest<FixtureInput>) => {
  if (!record(input)) throw new Error('invalid fixture input');
  if (input.action === 'crash') throw new Error('worker failed with SECRET_UPSTREAM_TOKEN');
  if (input.action === 'exit') process.exit(0);
  if (input.action === 'spin') {
    // Deliberately block this thread beyond the production budget. Parent must terminate it.
    const until = performance.now() + 10_000;
    while (performance.now() < until) { /* exercise CPU cancellation */ }
  }
  if (input.control instanceof SharedArrayBuffer) {
    const control = new Int32Array(input.control);
    const active = Atomics.add(control, 0, 1) + 1;
    let maximum = Atomics.load(control, 1);
    while (maximum < active) {
      const prior = Atomics.compareExchange(control, 1, maximum, active);
      if (prior === maximum) break;
      maximum = prior;
    }
    Atomics.add(control, 2, 1);
    Atomics.wait(control, 3, 0, 10_000);
    Atomics.sub(control, 0, 1);
  }
  parentPort?.postMessage({ ok: true, value: previewFundingContribution(input.body, confirmedAt) });
});
