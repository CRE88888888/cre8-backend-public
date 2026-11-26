import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export const DRAFT_BACKOFF_MS = 60_000;
export const DRAFT_MAX_BACKOFF_MS = 3_600_000;
type Retry = { attempts: number; nextAt: number };

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT';
}

/** Only opaque event identities, attempt counts and timestamps live here. Never prompts or keys. */
export function createDraftState(directory: string) {
  const root = path.join(directory, 'drafts');
  const retryFile = (identity: string) => path.join(root, 'retry', createHash('sha256').update(identity).digest('hex'));
  async function read(file: string): Promise<Retry> {
    let raw: string;
    try { raw = await readFile(file, 'utf8'); } catch (error) {
      if (missing(error)) return { attempts: 0, nextAt: 0 };
      throw new Error('draft state unavailable');
    }
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) throw new Error('draft state unavailable');
    const attempts: unknown = Reflect.get(value, 'attempts'), nextAt: unknown = Reflect.get(value, 'nextAt');
    if (typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 0 ||
        typeof nextAt !== 'number' || !Number.isSafeInteger(nextAt) || nextAt < 0) throw new Error('draft state unavailable');
    return { attempts, nextAt };
  }
  async function write(file: string, value: Retry): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, file);
    } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
  }
  return {
    async ready(identity: string, now: number): Promise<boolean> { return now >= (await read(retryFile(identity))).nextAt; },
    async begin(identity: string, now: number): Promise<number> {
      const attempts = Math.min((await read(retryFile(identity))).attempts + 1, 32);
      const nextAt = now + Math.min(DRAFT_BACKOFF_MS * 2 ** (attempts - 1), DRAFT_MAX_BACKOFF_MS);
      await write(retryFile(identity), { attempts, nextAt });
      return nextAt;
    },
    async clear(identity: string): Promise<void> {
      await unlink(retryFile(identity)).catch(error => { if (!missing(error)) throw error; });
    },
    async cooldownUntil(): Promise<number> { return (await read(path.join(root, 'cooldown'))).nextAt; },
    async cooldown(until: number): Promise<void> {
      await write(path.join(root, 'cooldown'), { attempts: 0, nextAt: Math.max(until, (await read(path.join(root, 'cooldown'))).nextAt) });
    },
    /** Failed and interrupted calls count. Exclusive files enforce a shared UTC-day hard cap. */
    async reserve(limit: number, now: Date): Promise<boolean> {
      const folder = path.join(root, 'calls', now.toISOString().slice(0, 10));
      await mkdir(folder, { recursive: true });
      for (let slot = 1; slot <= limit; slot++) {
        try {
          const handle = await open(path.join(folder, String(slot)), 'wx', 0o600);
          try { await handle.sync(); } finally { await handle.close(); }
          return true;
        } catch (error) {
          if (!(typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'EEXIST')) throw error;
        }
      }
      return false;
    },
  };
}
