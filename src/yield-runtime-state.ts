import { query } from './db.js';

export type YieldStateQuery = (sql: string, params?: readonly unknown[]) => Promise<{ rows: unknown[] }>;
type Kind = 'fact' | 'release' | 'cursor';
const unavailable = () => new Error('yield state unavailable');

function kindFor(name: string): Kind {
  if (name.length > 200 || !/^(auth|fact|release|cursor)-[a-z0-9-]+$/.test(name)) throw unavailable();
  if (name.startsWith('cursor-')) return 'cursor';
  return name.startsWith('release-') ? 'release' : 'fact';
}

/** API, scheduler and manual reconciliation share PostgreSQL; missing evidence never unlocks. */
export async function readYieldState(name: string, db: YieldStateQuery = query): Promise<unknown | null> {
  const kind = kindFor(name);
  try {
    const row = (await db('select kind,value from yield_runtime_state where name=$1', [name])).rows[0];
    if (row === undefined) return null;
    if (!row || typeof row !== 'object' || !('kind' in row) || row.kind !== kind ||
        !('value' in row) || row.value === null || row.value === undefined) throw unavailable();
    return row.value;
  } catch { throw unavailable(); }
}

/** Pass the caller's transaction to commit facts/evidence atomically with its ledger changes.
 * Cursor callers hold their DB advisory lock until the upsert commits, before attempting accounts.
 */
export async function writeYieldState(name: string, value: unknown, db: YieldStateQuery = query): Promise<void> {
  const kind = kindFor(name);
  try {
    if (value === null) throw unavailable();
    const encoded = JSON.stringify(value, (_key, item: unknown) => {
      if (item === undefined || typeof item === 'number' && !Number.isFinite(item)) throw unavailable();
      return item;
    });
    if (encoded === undefined) throw unavailable();
    if (kind === 'cursor') {
      const result = await db(`insert into yield_runtime_state(name,kind,value) values($1,$2,$3::jsonb)
        on conflict(name) do update set value=excluded.value,
          updated_at=greatest(yield_runtime_state.updated_at,clock_timestamp())
        where yield_runtime_state.kind='cursor' returning name`, [name, kind, encoded]);
      if (result.rows.length !== 1) throw unavailable();
      return;
    }
    await db(`insert into yield_runtime_state(name,kind,value) values($1,$2,$3::jsonb)
      on conflict(name) do nothing`, [name, kind, encoded]);
    // A separate statement sees the winner of a concurrent insert under READ COMMITTED.
    // jsonb equality ignores object key order; immutable facts/releases never use UPDATE.
    const row = (await db('select kind=$2 and value=$3::jsonb as matches from yield_runtime_state where name=$1',
      [name, kind, encoded])).rows[0];
    if (!row || typeof row !== 'object' || !('matches' in row) || row.matches !== true) throw unavailable();
  } catch { throw unavailable(); }
}
