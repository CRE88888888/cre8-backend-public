import { parentPort } from 'node:worker_threads';
import { AppError } from './errors.js';
import { previewFundingContribution } from './asset-plan.js';
import type { ContributionPreviewInput } from './asset-plan.js';
import type { PreviewWorkerReply, PreviewWorkerRequest } from './contribution-preview.js';

parentPort?.once('message', ({ input, confirmedAt }: PreviewWorkerRequest<ContributionPreviewInput>) => {
  let reply: PreviewWorkerReply;
  try {
    reply = { ok: true, value: previewFundingContribution(input, confirmedAt) };
  } catch (error) {
    reply = { ok: false, error: error instanceof AppError
      ? { status: error.status, code: error.code, message: error.message }
      : { status: 503, code: 'PREVIEW_UNAVAILABLE', message: 'contribution preview unavailable; retry later' } };
  }
  parentPort?.postMessage(reply);
});
