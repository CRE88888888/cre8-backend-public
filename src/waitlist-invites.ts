import { createHash, randomInt, randomUUID } from 'node:crypto';
import { importSPKI, jwtVerify } from 'jose';
import { getPrivyConfig } from './config.js';
import type { PrivyConfig } from './config.js';
import { query, withTransaction } from './db.js';
import { AppError, UnauthorizedError, ValidationError } from './errors.js';
import { MAX_PRIVY_TOKEN_LENGTH } from './privy.js';
import { MemoryRateLimitStore, RateLimitError } from './ratelimit.js';
import type { RateLimitStore } from './ratelimit.js';

export type LoginMethod = 'twitter' | 'google' | 'email';
/** X fields are set only for an X login; label is the operator-facing display (handle, Google email or email). */
type Identity = { privyUserId: string; method: LoginMethod; xUserId: string | null; xHandle: string | null; label: string };
type Redemption = { status: 'approved'; loginMethod: LoginMethod; xHandle: string | null; joinedAt: string };
export type InviteStatus = 'unused' | 'used' | 'revoked' | 'expired';
export type InviteEntry = {
  id: string; batchId: string; batchNote: string | null; issuedTo: string | null;
  status: InviteStatus; createdBy: string; createdAt: string; expiresAt: string | null;
  usedByWaitlistId: string | null; xHandle: string | null; usedAt: string | null;
  revokedAt: string | null; revokedBy: string | null;
};
type InviteCursor = { createdAt: string; id: string };
export type InvitePageQuery = { status: InviteStatus | null; batch: string | null; cursor: InviteCursor | null; limit: number };
export type InviteIssue = {
  batchId: string; batchNote: string | null; issuedTo: string | null; expiresAt: string | null;
  createdBy: string; codes: { codeHash: string }[];
};
export interface InviteRepository {
  issue(input: InviteIssue): Promise<{ id: string; codeHash: string }[]>;
  redeem(identity: Identity, codeHash: string): Promise<Redemption>;
  list(input: InvitePageQuery): Promise<InviteEntry[]>;
  summary(batch: string | null): Promise<{ issuedTo: string | null; issued: string; used: string }[]>;
  revoke(id: string, operator: string): Promise<void>;
}

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function hashInviteCode(code: string): string { return createHash('sha256').update(code).digest('hex').toUpperCase(); }
const unavailable = () => new AppError(503, 'INVITES_UNAVAILABLE', 'waitlist invites are unavailable; try again later');
const invalidInvite = () => new AppError(404, 'INVITE_INVALID', 'invite code is invalid');
const usedInvite = () => new AppError(409, 'INVITE_USED', 'invite code has already been used');
const expiredInvite = () => new AppError(410, 'INVITE_EXPIRED', 'invite code is expired or revoked');
const alreadyApproved = () => new AppError(409, 'ALREADY_APPROVED', 'waitlist entry is already approved');
const identityConflict = () => new AppError(409, 'X_ALREADY_JOINED', 'X identity is already joined or differs from the original registration');
const invalidTransition = () => new AppError(409, 'INVALID_WAITLIST_TRANSITION', 'only waiting entries can redeem invitations');
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function validId(value: unknown): value is string { return typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n; }
function validTime(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value.slice(0, 23) + 'Z';
}

// Same offline policy as /waitlist/join. Keep the original waitlist module unchanged.
async function verify(token: unknown, config: PrivyConfig | null, now: number): Promise<{ privyUserId: string; accounts: unknown[] }> {
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
        payload.aud !== config.appId || !Number.isSafeInteger(payload.iat) || payload.iat === undefined ||
        payload.iat < 0 || payload.iat > seconds || !Number.isSafeInteger(payload.exp) ||
        payload.exp === undefined || payload.exp <= payload.iat || typeof payload.linked_accounts !== 'string') throw new Error();
    const accounts: unknown = JSON.parse(payload.linked_accounts);
    if (!Array.isArray(accounts) || accounts.some((account: unknown) => !record(account))) throw new Error();
    return { privyUserId: payload.sub, accounts };
  } catch { throw new UnauthorizedError('invalid or expired Privy identity token'); }
}
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{1,63}$/;
const emailOf = (value: unknown): string | null =>
  typeof value === 'string' && value.length <= 254 && EMAIL.test(value) ? value.toLowerCase() : null;
/**
 * Invite redemption accepts any verified Privy login (backend#196): one valid X account first, then Google, then email.
 * Joining the waitlist without a code still requires X (src/waitlist.ts).
 */
export function redeemIdentity(privyUserId: string, accounts: unknown[]): Identity {
  const of = (type: string) => accounts.filter((a): a is Record<string, unknown> => record(a) && a.type === type);
  const twitter = of('twitter_oauth'), x = twitter[0];
  if (twitter.length === 1 && x && typeof x.subject === 'string' && /^[1-9]\d{0,19}$/.test(x.subject) &&
      typeof x.username === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(x.username)) {
    return { privyUserId, method: 'twitter', xUserId: x.subject, xHandle: x.username, label: '@' + x.username };
  }
  const google = of('google_oauth').find(a => typeof a.subject === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(a.subject));
  if (google) return { privyUserId, method: 'google', xUserId: null, xHandle: null, label: emailOf(google.email) ?? 'Google account' };
  const email = of('email').map(a => emailOf(a.address)).find((a): a is string => a !== null);
  if (email) return { privyUserId, method: 'email', xUserId: null, xHandle: null, label: email };
  throw new AppError(409, 'IDENTITY_REQUIRED', 'sign in with X, Google or email before redeeming an invite');
}
function batchFilter(params: URLSearchParams): string | null {
  const batch = params.get('batch');
  if (batch !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(batch)) {
    throw new ValidationError('INVALID_QUERY', 'batch must be a UUID');
  }
  return batch?.toLowerCase() ?? null;
}
function pageQuery(params: URLSearchParams): InvitePageQuery {
  const rawStatus = params.get('status');
  if (rawStatus !== null && rawStatus !== 'unused' && rawStatus !== 'used' && rawStatus !== 'revoked' && rawStatus !== 'expired') {
    throw new ValidationError('INVALID_QUERY', 'status must be unused, used, revoked or expired');
  }
  const batch = batchFilter(params);
  const rawLimit = params.get('limit') ?? '50';
  if (!/^[1-9]\d{0,2}$/.test(rawLimit) || Number(rawLimit) > 100) throw new ValidationError('INVALID_QUERY', 'limit must be an integer from 1 to 100');
  let cursor: InviteCursor | null = null;
  const raw = params.get('cursor');
  if (raw !== null) {
    try {
      if (raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
      const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
      if (!record(value) || value.status !== rawStatus || value.batch !== batch || !validId(value.id) || !validTime(value.createdAt)) throw new Error();
      cursor = { id: value.id, createdAt: value.createdAt };
    } catch { throw new ValidationError('INVALID_QUERY', 'invalid invite cursor or changed filters'); }
  }
  return { status: rawStatus, batch, cursor, limit: Number(rawLimit) };
}

export function createWaitlistInviteService(options: {
  repository?: InviteRepository; config?: () => PrivyConfig | null; now?: () => number; rateStore?: RateLimitStore;
} = {}) {
  const repository = options.repository ?? new PostgresInviteRepository();
  const now = options.now ?? Date.now;
  const rateStore = options.rateStore ?? new MemoryRateLimitStore();
  const consume = async (key: string, limit: number) => {
    try {
      const result = await rateStore.consume(key, { limit, windowMs: 60_000 }, now());
      if (!result.allowed) throw new RateLimitError(result.retryAfterSeconds);
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      throw new AppError(503, 'RATE_LIMIT_UNAVAILABLE', 'request budget unavailable; try again later');
    }
  };
  const storage = async <T>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); }
    catch (error) {
      if (error instanceof AppError && ['INVITE_INVALID', 'INVITE_USED', 'INVITE_EXPIRED', 'ALREADY_APPROVED', 'X_ALREADY_JOINED', 'INVALID_WAITLIST_TRANSITION'].includes(error.code)) throw error;
      throw unavailable();
    }
  };
  return {
    checkIp: (ip: string) => consume('invite-ip:' + ip, 10),
    async redeem(body: unknown) {
      const identity = await verify(record(body) ? body.identityToken : undefined, (options.config ?? getPrivyConfig)(), now());
      await consume('invite-user:' + hashInviteCode(identity.privyUserId), 5);
      const x = redeemIdentity(identity.privyUserId, identity.accounts);
      if (!record(body) || typeof body.code !== 'string' || body.code.length > 64) throw invalidInvite();
      const code = body.code.trim().toUpperCase();
      if (!/^[A-HJ-KM-NP-Z2-9]{8,10}$/.test(code)) throw invalidInvite();
      return storage(() => repository.redeem(x, hashInviteCode(code)));
    },
    async issue(body: unknown, operator: string) {
      const invalid = () => new ValidationError('INVALID_INVITE_INPUT', 'count must be 1..500; notes at most 256 characters; expiresAt must be a future UTC ISO timestamp');
      if (!record(body) || typeof body.count !== 'number' || !Number.isInteger(body.count) || body.count < 1 || body.count > 500) throw invalid();
      const note = (value: unknown): string | null => {
        if (value === null || value === undefined) return null;
        if (typeof value !== 'string' || value.length > 256 || value.includes('\0')) throw invalid();
        return value.trim() || null;
      };
      const issuedTo = note(body.issuedTo), batchNote = note(body.batchNote);
      let expiresAt: string | null = null;
      if (body.expiresAt !== null && body.expiresAt !== undefined) {
        if (typeof body.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(body.expiresAt) ||
            !Number.isFinite(Date.parse(body.expiresAt)) || Date.parse(body.expiresAt) <= now() ||
            new Date(body.expiresAt).toISOString() !== body.expiresAt.replace(/(?<=:\d{2})Z$/, '.000Z')) throw invalid();
        expiresAt = new Date(body.expiresAt).toISOString();
      }
      const batchId = randomUUID();
      const codes = new Map<string, string>();
      while (codes.size < body.count) {
        const code = Array.from({ length: 10 }, () => ALPHABET.charAt(randomInt(ALPHABET.length))).join('');
        codes.set(hashInviteCode(code), code);
      }
      const rows = await storage(() => repository.issue({ batchId, issuedTo, batchNote, expiresAt, createdBy: operator.toLowerCase(),
        codes: [...codes.keys()].map(codeHash => ({ codeHash })) }));
      // Never accidentally return a persisted hash or any unexpected repository fields.
      if (rows.length !== codes.size || new Set(rows.map(row => row.codeHash)).size !== codes.size) throw unavailable();
      const items = rows.map(row => {
        const code = codes.get(row.codeHash);
        if (!code || !validId(row.id)) throw unavailable();
        return { id: row.id, code };
      });
      return { batchId, issuedTo, batchNote, expiresAt, items };
    },
    async list(params: URLSearchParams) {
      const input = pageQuery(params);
      const rows = await storage(() => repository.list(input));
      const items = rows.slice(0, input.limit).map(row => ({ id: row.id, codeMasked: '**********', batchId: row.batchId,
        batchNote: row.batchNote, issuedTo: row.issuedTo, status: row.status, createdBy: row.createdBy, createdAt: row.createdAt,
        expiresAt: row.expiresAt, usedByWaitlistId: row.usedByWaitlistId, xHandle: row.xHandle, usedAt: row.usedAt,
        revokedAt: row.revokedAt, revokedBy: row.revokedBy }));
      const last = items.at(-1);
      const nextCursor = rows.length > input.limit && last ? Buffer.from(JSON.stringify({ id: last.id, createdAt: last.createdAt,
        status: input.status, batch: input.batch })).toString('base64url') : null;
      return { items, nextCursor };
    },
    async summary(params: URLSearchParams) {
      const batch = batchFilter(params);
      const rows = await storage(() => repository.summary(batch));
      return { items: rows.map(row => ({ issuedTo: row.issuedTo, issued: row.issued, used: row.used })) };
    },
    async revoke(id: string, operator: string) {
      if (!validId(id)) throw new ValidationError('INVALID_ID', 'invite id must be a positive bigint');
      await storage(() => repository.revoke(id, operator.toLowerCase()));
      return { id, status: 'revoked' };
    },
  };
}

const timestamp = (column: string) => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const effectiveStatus = `case when i.status='unused' and i.expires_at<=statement_timestamp() then 'expired' else i.status end`;
const INVITE_COLUMNS = `i.id::text as id, i.batch_id as "batchId", i.batch_note as "batchNote", i.issued_to as "issuedTo",
  ${effectiveStatus} as status, i.created_by as "createdBy", ${timestamp('i.created_at')} as "createdAt",
  ${timestamp('i.expires_at')} as "expiresAt", i.used_by_waitlist_id::text as "usedByWaitlistId", w.x_handle as "xHandle",
  ${timestamp('i.used_at')} as "usedAt", ${timestamp('i.revoked_at')} as "revokedAt", i.revoked_by as "revokedBy"`;

export class PostgresInviteRepository implements InviteRepository {
  async issue(input: InviteIssue): Promise<{ id: string; codeHash: string }[]> {
    return withTransaction(async client => {
      await client.query("set local lock_timeout='5s'");
      await client.query("set local statement_timeout='5s'");
      return (await client.query<{ id: string; codeHash: string }>(`insert into waitlist_invites
        (code,batch_id,batch_note,issued_to,created_by,expires_at)
        select code,$2,$3,$4,$5,$6::timestamptz from unnest($1::text[]) as code returning id::text,code as "codeHash"`,
      [input.codes.map(code => code.codeHash), input.batchId, input.batchNote, input.issuedTo, input.createdBy, input.expiresAt])).rows;
    });
  }

  async redeem(identity: Identity, codeHash: string): Promise<Redemption> {
    try {
      return await withTransaction(async client => {
        await client.query("set local lock_timeout='5s'");
        await client.query("set local statement_timeout='5s'");
        // 0048 requires invite -> waitlist lock order; its trigger owns the atomic approval.
        const invite = (await client.query<{ id: string; status: string }>(
          'select id::text,status from waitlist_invites where code=$1 for update', [codeHash])).rows[0];
        if (!invite) throw invalidInvite();
        await client.query(`insert into waitlist(privy_user_id,x_user_id,x_handle,login_method,login_label) values($1,$2,$3,$4,$5) on conflict do nothing`,
          [identity.privyUserId, identity.xUserId, identity.xHandle, identity.method, identity.method === 'twitter' ? null : identity.label]);
        const entry = (await client.query<{ id: string; xUserId: string | null; status: string }>(
          'select id::text,x_user_id as "xUserId",status from waitlist where privy_user_id=$1 for update', [identity.privyUserId])).rows[0];
        // Only two different X accounts conflict; a row created by Google/email has no X identity to contradict.
        if (!entry || (entry.xUserId !== null && identity.xUserId !== null && entry.xUserId !== identity.xUserId)) throw identityConflict();
        if (entry.status === 'approved') throw alreadyApproved();
        if (entry.status !== 'waiting') throw invalidTransition();
        if (invite.status === 'used') throw usedInvite();
        if (invite.status === 'revoked') throw expiredInvite();
        if (invite.status !== 'unused') throw unavailable();
        const clock = (await client.query<{ expired: boolean }>(
          'select expires_at is not null and expires_at<=clock_timestamp() as expired from waitlist_invites where id=$1', [invite.id])).rows[0];
        if (!clock) throw unavailable();
        if (clock.expired) throw expiredInvite();
        // Do not supply used_at or preapprove: the DB trigger checks expiry again after both locks.
        const used = await client.query(`update waitlist_invites set status='used',used_by_waitlist_id=$2 where id=$1 and status='unused' returning id`, [invite.id, entry.id]);
        if (used.rows.length !== 1) throw unavailable();
        const saved = (await client.query<Redemption>(`update waitlist set x_handle=coalesce($2,x_handle) where id=$1 and status='approved'
          returning status,login_method as "loginMethod",x_handle as "xHandle",${timestamp('joined_at')} as "joinedAt"`, [entry.id, entry.xUserId === null ? null : identity.xHandle])).rows[0];
        if (!saved || saved.status !== 'approved') throw unavailable();
        return saved;
      });
    } catch (error) {
      // Expiry can cross between the explicit DB-clock check and the trigger; preserve the public code.
      if (error instanceof Error && 'code' in error && error.code === '23514' && error.message === 'invitation has expired') throw expiredInvite();
      throw error;
    }
  }

  async list(input: InvitePageQuery): Promise<InviteEntry[]> {
    return (await query<InviteEntry>(`select ${INVITE_COLUMNS} from waitlist_invites i left join waitlist w on w.id=i.used_by_waitlist_id
      where ($1::text is null or (${effectiveStatus})=$1) and ($2::text is null or i.batch_id=$2)
      and ($3::timestamptz is null or (i.created_at,i.id)>($3::timestamptz,$4::bigint))
      order by i.created_at,i.id limit $5`,
    [input.status, input.batch, input.cursor?.createdAt ?? null, input.cursor?.id ?? null, input.limit + 1])).rows;
  }

  async summary(batch: string | null): Promise<{ issuedTo: string | null; issued: string; used: string }[]> {
    return (await query<{ issuedTo: string | null; issued: string; used: string }>(`select issued_to as "issuedTo",
      count(*)::text as issued,count(*) filter(where status='used')::text as used
      from waitlist_invites where ($1::text is null or batch_id=$1) group by issued_to order by issued_to nulls first`, [batch])).rows;
  }

  async revoke(id: string, operator: string): Promise<void> {
    return withTransaction(async client => {
      await client.query("set local lock_timeout='5s'");
      await client.query("set local statement_timeout='5s'");
      const row = (await client.query<{ status: string }>('select status from waitlist_invites where id=$1 for update', [id])).rows[0];
      if (!row) throw invalidInvite();
      if (row.status === 'used') throw usedInvite();
      if (row.status === 'revoked') return;
      if (row.status !== 'unused') throw unavailable();
      const updated = await client.query("update waitlist_invites set status='revoked',revoked_by=$2 where id=$1 returning id", [id, operator]);
      if (updated.rows.length !== 1) throw unavailable();
    });
  }
}
