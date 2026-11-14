import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Pool as PgPool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { getConfig } from './config.js';

const { Pool } = pg;

/**
 * `db/migrations` 住在**隔壁的 repo**（`cre8-protocol/db`），所以預設路徑相對這個模組解析：
 * `src/db.ts` 與 `dist/db.js` 都在 `backend/` 底下兩層。`backend/README.md` 說明 db/ 要 checkout 在旁邊。
 *
 * ⚠ 但這在容器裡會失效：Docker 的 build context 只有 `backend/`，`../db/migrations` 不存在。
 * 所以允許 `MIGRATIONS_DIR` 覆寫 —— 兩條路都留著：
 *
 *   * 本機 / CI：省略，走預設的相對路徑
 *   * 容器：把 migration 檔一起放進 image，並設 `MIGRATIONS_DIR=/app/migrations`
 *
 * 另一條路是「migration 當成部署步驟，不由容器執行」（見 `docs/deploy-railway.zh-TW.md`）——
 * 這在只有 backend 建置脈絡時是唯一可行的做法。
 */
export const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR?.trim() !== undefined && process.env.MIGRATIONS_DIR?.trim() !== ''
    ? (process.env.MIGRATIONS_DIR as string)
    : fileURLToPath(new URL('../../db/migrations/', import.meta.url));

/** App-wide advisory lock so two processes never apply migrations at the same time. */
const MIGRATION_LOCK_ID = 8_121_956_001;

let pool: PgPool | null = null;
// All DB work inside a portfolio lock reuses its client, including short transactions.
// Reserving a lock client while borrowing other pool clients can exhaust the pool.
const portfolioClient = new AsyncLocalStorage<PoolClient>();

function timeoutMillis(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error(`${name} must be an integer between 1 and 2147483647 milliseconds`);
  }
  return value;
}

export function getPool(): PgPool {
  if (pool) return pool;

  const { databaseUrl } = getConfig();
  pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'cre8-atp-backend',
    statement_timeout: timeoutMillis('DB_STATEMENT_TIMEOUT_MS', 15_000),
    idle_in_transaction_session_timeout: timeoutMillis('DB_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS', 30_000),
  });
  pool.on('error', (err: Error) => {
    // An idle client died (network blip, server restart). The pool discards it; log and move on.
    console.error(JSON.stringify({ level: 'error', msg: 'idle postgres client error', error: err.message }));
  });
  return pool;
}

/** Thin helper so the rest of the app never touches the pool directly. */
export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<QueryResult<T>> {
  return (portfolioClient.getStore() ?? getPool()).query<T>(text, [...params]);
}

/** Run `fn` inside BEGIN/COMMIT; rolls back on any throw. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const scoped = portfolioClient.getStore();
  const client = scoped ?? await getPool().connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {
      // The connection may already be dead; the original error is the one worth reporting.
    });
    throw err;
  } finally {
    if (scoped === undefined) client.release();
  }
}

/** Nonblocking, cross-process exclusion from planning through settlement. null = already owned. */
export async function withPortfolioLock<T>(portfolioId: number, fn: () => Promise<T>): Promise<T | null> {
  if (!Number.isSafeInteger(portfolioId) || portfolioId <= 0) throw new RangeError('invalid portfolio id');
  // Negative bigint keys keep portfolio locks separate from the positive migration lock.
  const key = (-BigInt(portfolioId)).toString();
  const client = await getPool().connect().catch(() => { throw new Error('portfolio lock connection unavailable'); });
  let acquired = false;
  let reusable = false;
  const disconnected = () => { reusable = false; };
  client.on('error', disconnected);
  try {
    acquired = (await client.query<{ acquired: boolean }>(
      'select pg_try_advisory_lock($1::bigint) as acquired', [key],
    ).catch(() => { throw new Error('portfolio lock acquisition failed'); })).rows[0]?.acquired === true;
    reusable = true;
    if (!acquired) return null;
    return await portfolioClient.run(client, fn);
  } finally {
    if (acquired) {
      try {
        reusable = (await client.query<{ unlocked: boolean }>(
          'select pg_advisory_unlock($1::bigint) as unlocked', [key],
        )).rows[0]?.unlocked === true;
      } catch {
        reusable = false;
      }
    }
    // Acquisition/cleanup errors may leave a session lock behind. Never recycle that session.
    client.release(!reusable);
    client.removeListener('error', disconnected);
  }
}

export type MigrationResult = {
  /** Filenames applied by this call, in order. Empty when everything was already up to date. */
  applied: string[];
};

/**
 * Apply pending migrations in filename order. Each file runs in its own transaction together with
 * its schema_migrations row, so a failed migration leaves no partial schema and no record.
 *
 * The sha256 of every applied file is stored. Editing an applied migration is an error: create a
 * new numbered file instead (see db/README.md).
 */
export async function migrate(): Promise<MigrationResult> {
  const files = await listMigrationFiles();
  const client = await getPool().connect();

  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    try {
      await client.query(`
        create table if not exists schema_migrations (
          filename   text        primary key,
          checksum   text        not null,
          applied_at timestamptz not null default now()
        )
      `);

      const existing = await client.query<{ filename: string; checksum: string }>(
        'select filename, checksum from schema_migrations',
      );
      const applied = new Map(existing.rows.map((row) => [row.filename, row.checksum]));
      const ran: string[] = [];

      for (const file of files) {
        const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
        const checksum = createHash('sha256').update(sql).digest('hex');
        const previous = applied.get(file);

        if (previous !== undefined) {
          if (previous !== checksum) {
            throw new Error(
              `migration ${file} was modified after it was applied ` +
                `(recorded ${previous}, file ${checksum}); add a new migration instead`,
            );
          }
          continue;
        }

        await client.query('begin');
        try {
          await client.query(sql);
          await client.query('insert into schema_migrations (filename, checksum) values ($1, $2)', [
            file,
            checksum,
          ]);
          await client.query('commit');
        } catch (err) {
          await client.query('rollback').catch(() => {});
          throw new Error(`migration ${file} failed: ${errorMessage(err)}`, { cause: err });
        }
        ran.push(file);
      }

      return { applied: ran };
    } finally {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    }
  } finally {
    client.release();
  }
}

/** Close the pool (graceful shutdown, tests, CLI). Safe to call when no pool was ever created. */
export async function closePool(): Promise<void> {
  const current = pool;
  if (!current) return;
  pool = null;
  await current.end();
}

export function isUniqueViolation(err: unknown): boolean {
  return errorCode(err) === '23505';
}

export function isForeignKeyViolation(err: unknown): boolean {
  return errorCode(err) === '23503';
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  const { code } = err as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

async function listMigrationFiles(): Promise<string[]> {
  try {
    const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    throw new Error(`cannot read migrations at ${MIGRATIONS_DIR}: ${errorMessage(err)}`, { cause: err });
  }
}
