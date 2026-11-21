import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { getPool, withConnection, query, MIGRATIONS_DIR } from '../../src/db.js';
/** Real commits and separate lock connections; no rows or authority survive the sandbox. */
export async function mixDbSandbox(work: (lane: <R>(fn: () => Promise<R>) => Promise<R>) => Promise<void>) {
  assert.ok(['cre8_x1_178', 'cre8_x1_180', 'cre8_x1_182'].includes((await getPool().query<{ name: string }>('select current_database() as name')).rows[0]?.name ?? ''));
  const schema = 'mix178_' + randomBytes(8).toString('hex');
  await getPool().query(`create schema ${schema}`);
  const lane = <R>(fn: () => Promise<R>) => withConnection(async (client, discard) => {
    try { await client.query(`set search_path to ${schema},public`); return await fn(); }
    finally { discard(); }
  }, { reuse: false });
  try {
    await lane(async () => {
      for (const file of (await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith('.sql')).sort()) await query(await readFile(path.join(MIGRATIONS_DIR, file), 'utf8'));
    });
    await work(lane);
  } finally { await getPool().query(`drop schema ${schema} cascade`); }
}
