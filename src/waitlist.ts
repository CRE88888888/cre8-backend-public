import { importSPKI, jwtVerify } from 'jose';
import { getPrivyConfig } from './config.js';
import type { PrivyConfig } from './config.js';
import { query, withTransaction } from './db.js';
import { AppError, UnauthorizedError, ValidationError } from './errors.js';
import { MAX_PRIVY_TOKEN_LENGTH } from './privy.js';
import type { OpenSignup } from './waitlist-gate.js';

export type WaitlistStatus = 'waiting' | 'approved' | 'revoked';
export type WaitlistEntry = {
  id: string;
  privyUserId: string;
  /** null for rows created by a Google/email invite redemption (db 0061). */
  xUserId: string | null;
  xHandle: string | null;
  loginMethod: 'twitter' | 'google' | 'email';
  loginLabel: string | null;
  status: WaitlistStatus;
  joinedAt: string;
  approvedAt: string | null;
  approvedBy: string | null;
  /** Bonus task points (db 0062, 0..35): more points are released first, then earlier joins. */
  points: number;
};
type Identity = { privyUserId: string; xUserId: string; xHandle: string };
type Cursor = { points: number; joinedAt: string; id: string };
export type WaitlistPageQuery = { status: WaitlistStatus | null; cursor: Cursor | null; limit: number };
export interface WaitlistRepository {
  join(identity: Identity): Promise<WaitlistEntry>;
  find(privyUserId: string): Promise<WaitlistEntry | null>;
  list(input: WaitlistPageQuery): Promise<WaitlistEntry[]>;
  transition(id: string, status: 'approved' | 'revoked', operator: string): Promise<WaitlistEntry>;
}

// Keep microseconds for the keyset cursor: converting joined_at through JS Date loses ties.
const COLUMNS = `id::text as "id", privy_user_id as "privyUserId", x_user_id as "xUserId",
  x_handle as "xHandle", login_method as "loginMethod", login_label as "loginLabel", status,
  to_char(joined_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "joinedAt",
  to_char(approved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "approvedAt",
  approved_by as "approvedBy",
  (select coalesce(sum(t.points),0)::int from waitlist_tasks t where t.waitlist_id=waitlist.id) as "points"`;
const conflict = () => new AppError(409, 'X_ALREADY_JOINED', 'X identity is already joined or differs from the original registration');
const notJoined = () => new AppError(404, 'NOT_JOINED', 'waitlist entry not found');
const unavailable = () => new AppError(503, 'WAITLIST_UNAVAILABLE', 'waitlist is unavailable; try again later');

export class PostgresWaitlistRepository implements WaitlistRepository {
  async join(identity: Identity): Promise<WaitlistEntry> {
    const values = [identity.privyUserId, identity.xUserId, identity.xHandle];
    // Both unique identities can race. Ignore either INSERT conflict, then read/update in a
    // fresh READ COMMITTED snapshot after the winner commits (no identity reassignment).
    const inserted = await query<WaitlistEntry>(`insert into waitlist (privy_user_id, x_user_id, x_handle)
      values ($1, $2, $3) on conflict do nothing returning ${COLUMNS}`, values);
    const first = inserted.rows[0];
    if (first) return first;
    const updated = await query<WaitlistEntry>(`update waitlist set x_handle=$3, updated_at=clock_timestamp()
      where privy_user_id=$1 and x_user_id=$2 returning ${COLUMNS}`, values);
    const row = updated.rows[0];
    if (!row) throw conflict();
    return row;
  }

  async find(privyUserId: string): Promise<WaitlistEntry | null> {
    return (await query<WaitlistEntry>(`select ${COLUMNS} from waitlist where privy_user_id=$1`, [privyUserId])).rows[0] ?? null;
  }

  async list(input: WaitlistPageQuery): Promise<WaitlistEntry[]> {
    // Release order (backend#198): more task points first, then earlier joins; id breaks ties.
    return (await query<WaitlistEntry>(`select ${COLUMNS} from waitlist
      cross join lateral (select coalesce(sum(t.points),0)::int as p from waitlist_tasks t where t.waitlist_id=waitlist.id) s
      where ($1::text is null or status=$1)
        and ($2::timestamptz is null or (-s.p,joined_at,id)>(-$5::int,$2::timestamptz,$3::bigint))
      order by s.p desc,waitlist.joined_at,waitlist.id limit $4`,
    [input.status, input.cursor?.joinedAt ?? null, input.cursor?.id ?? null, input.limit + 1, input.cursor?.points ?? 0])).rows;
  }

  async transition(id: string, status: 'approved' | 'revoked', operator: string): Promise<WaitlistEntry> {
    return withTransaction(async (client) => {
      await client.query("set local lock_timeout='5s'");
      await client.query("set local statement_timeout='5s'");
      const row = (await client.query<WaitlistEntry>(`select ${COLUMNS} from waitlist where id=$1 for update`, [id])).rows[0];
      if (!row) throw notJoined();
      if (row.status === status) return row;
      if (row.status === 'waiting' && status === 'revoked') {
        throw new AppError(409, 'INVALID_WAITLIST_TRANSITION', 'only approved entries can be revoked');
      }
      const result = await client.query<WaitlistEntry>(status === 'approved'
        ? `update waitlist set status='approved', approved_at=clock_timestamp(), approved_by=$2,
            revoked_at=null, updated_at=clock_timestamp() where id=$1 returning ${COLUMNS}`
        : `update waitlist set status='revoked', revoked_at=clock_timestamp(),
            updated_at=clock_timestamp() where id=$1 returning ${COLUMNS}`,
      status === 'approved' ? [id, operator] : [id]);
      const saved = result.rows[0];
      if (!saved) throw unavailable();
      return saved;
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function invalidToken(): UnauthorizedError { return new UnauthorizedError('invalid or expired Privy identity token'); }

/** Match /auth/privy's offline ES256 policy without changing existing login or creating sessions/wallet mappings. */
export async function verifyIdentity(token: unknown, config: PrivyConfig | null, now: number) {
  if (config === null) throw new AppError(503, 'PRIVY_UNAVAILABLE', 'Privy login is unavailable');
  if (typeof token !== 'string' || token.trim() === '' || token.length > MAX_PRIVY_TOKEN_LENGTH) {
    throw new ValidationError('INVALID_AUTH', 'identityToken must be a non-empty string of at most 65536 characters');
  }
  let key: Awaited<ReturnType<typeof importSPKI>>;
  try { key = await importSPKI(config.verificationKey, 'ES256'); }
  catch { throw new AppError(503, 'PRIVY_UNAVAILABLE', 'Privy login is unavailable'); }
  try {
    const seconds = Math.floor(now / 1000);
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['ES256'], issuer: 'privy.io', audience: config.appId,
      requiredClaims: ['sub', 'iat', 'exp', 'linked_accounts'], currentDate: new Date(seconds * 1000),
    });
    if (typeof payload.sub !== 'string' || payload.sub.length > 256 || !/^did:privy:[^\s]+$/.test(payload.sub) ||
        payload.aud !== config.appId || !Number.isSafeInteger(payload.iat) ||
        payload.iat === undefined || payload.iat < 0 || payload.iat > seconds ||
        !Number.isSafeInteger(payload.exp) || payload.exp === undefined || payload.exp <= payload.iat ||
        typeof payload.linked_accounts !== 'string') throw invalidToken();
    const linked: unknown = JSON.parse(payload.linked_accounts);
    if (!Array.isArray(linked) || linked.some((account: unknown) => !isRecord(account))) throw invalidToken();
    const accounts: unknown[] = linked;
    return { privyUserId: payload.sub, accounts };
  } catch { throw invalidToken(); }
}

function xIdentity(privyUserId: string, accounts: unknown[]): Identity {
  const twitter = accounts.filter((a): a is Record<string, unknown> => isRecord(a) && a.type === 'twitter_oauth');
  const account = twitter[0];
  if (twitter.length !== 1 || !account || typeof account.subject !== 'string' ||
      !/^[1-9]\d{0,19}$/.test(account.subject) || typeof account.username !== 'string' ||
      !/^[A-Za-z0-9_]{1,15}$/.test(account.username)) {
    throw new AppError(409, 'X_REQUIRED', 'link exactly one valid X account before joining');
  }
  return { privyUserId, xUserId: account.subject, xHandle: account.username };
}

function publicEntry(row: WaitlistEntry) {
  return { status: row.status === 'approved' ? 'approved' : 'waiting', xHandle: row.xHandle, joinedAt: row.joinedAt };
}
function validId(id: string): boolean {
  return /^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= 9_223_372_036_854_775_807n;
}
function pageQuery(params: URLSearchParams): WaitlistPageQuery {
  const status = params.get('status');
  if (status !== null && status !== 'waiting' && status !== 'approved' && status !== 'revoked') {
    throw new ValidationError('INVALID_QUERY', 'status must be waiting, approved or revoked');
  }
  const rawLimit = params.get('limit') ?? '50';
  if (!/^[1-9]\d{0,2}$/.test(rawLimit) || Number(rawLimit) > 100) {
    throw new ValidationError('INVALID_QUERY', 'limit must be an integer from 1 to 100');
  }
  let cursor: Cursor | null = null;
  const rawCursor = params.get('cursor');
  if (rawCursor !== null) {
    try {
      if (rawCursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(rawCursor)) throw new Error();
      const parsed: unknown = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8'));
      if (!isRecord(parsed) || parsed.status !== status || typeof parsed.id !== 'string' || !validId(parsed.id) ||
          typeof parsed.joinedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parsed.joinedAt) ||
          new Date(parsed.joinedAt).toISOString() !== parsed.joinedAt.slice(0, 23) + 'Z' ||
          typeof parsed.points !== 'number' || !Number.isInteger(parsed.points) || parsed.points < 0 || parsed.points > 35) throw new Error();
      cursor = { points: parsed.points, joinedAt: parsed.joinedAt, id: parsed.id };
    } catch { throw new ValidationError('INVALID_QUERY', 'invalid waitlist cursor or changed status filter'); }
  }
  return { status, limit: Number(rawLimit), cursor };
}

export function createWaitlistService(options: {
  repository?: WaitlistRepository;
  config?: () => PrivyConfig | null;
  now?: () => number;
  /** deploy/waitlist-gate.json open sign-up; defaults to none (server.ts wires the real one). */
  openSignup?: OpenSignup;
} = {}) {
  const repository = options.repository ?? new PostgresWaitlistRepository();
  const openSignup = options.openSignup ?? (async () => {});
  const verify = (token: unknown) => verifyIdentity(token, (options.config ?? getPrivyConfig)(), (options.now ?? Date.now)());
  const storage = async <T>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); }
    catch (error) {
      if (error instanceof AppError && ['X_ALREADY_JOINED', 'NOT_JOINED', 'INVALID_WAITLIST_TRANSITION'].includes(error.code)) throw error;
      throw unavailable();
    }
  };
  return {
    async join(body: unknown) {
      const identity = await verify(isRecord(body) ? body.identityToken : undefined);
      const x = xIdentity(identity.privyUserId, identity.accounts);
      await openSignup(identity.privyUserId, identity.accounts);
      return publicEntry(await storage(() => repository.join(x)));
    },
    async me(authorization: string | undefined) {
      const match = /^Bearer ([^\s]+)$/i.exec(authorization ?? '');
      if (!match) throw new UnauthorizedError();
      const identity = await verify(match[1]);
      await openSignup(identity.privyUserId, identity.accounts);
      const row = await storage(() => repository.find(identity.privyUserId));
      if (!row) throw notJoined();
      return publicEntry(row);
    },
    async list(params: URLSearchParams) {
      const input = pageQuery(params);
      const rows = await storage(() => repository.list(input));
      const items = rows.slice(0, input.limit);
      const last = items.at(-1);
      const nextCursor = rows.length > input.limit && last
        ? Buffer.from(JSON.stringify({ points: last.points, joinedAt: last.joinedAt, id: last.id, status: input.status })).toString('base64url') : null;
      return { items, nextCursor };
    },
    async transition(id: string, status: 'approved' | 'revoked', operator: string) {
      if (!validId(id)) throw new ValidationError('INVALID_ID', 'waitlist id must be a positive bigint');
      return storage(() => repository.transition(id, status, operator.toLowerCase()));
    },
  };
}
