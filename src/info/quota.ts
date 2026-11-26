import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { InfoSourceError } from './types.js';

/** One scheduler/shared filesystem namespace per outbound IP. Atomic slots survive restarts;
 * count attempted GETs including failures. Never silently reset corrupt/unwritable state.
 */
export async function reserveBlsRequest(directory: string, now: Date): Promise<boolean> {
  const date = now.toISOString().slice(0, 10);
  const folder = path.join(directory, 'bls', date);
  try {
    await mkdir(folder, { recursive: true });
    for (let slot = 1; slot <= 25; slot++) {
      try {
        const file = await open(path.join(folder, String(slot)), 'wx', 0o600);
        try { await file.sync(); } finally { await file.close(); }
        return true;
      } catch (error) {
        if (!(typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'EEXIST')) throw error;
      }
    }
    return false;
  } catch { throw new InfoSourceError('bls_quota_unavailable'); }
}
