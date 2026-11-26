import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { query } from './db.js';
import { hashInviteCode, redeemIdentity } from './waitlist-invites.js';

export type WaitlistGate = {
  /** false: a verified Privy login with BOTH an X and a Google account is approved without a code. */
  inviteRequired: boolean;
  /** sha256 (uppercase hex, as hashInviteCode) of the view-only pass, or null when it is off. It grants no API access. */
  accessCodeHash: string | null;
};

/**
 * deploy/waitlist-gate.json, read once per process. Fail closed: a missing or malformed file means invites required
 * and no access code. `inviteRequired` opens only on an explicit `false`; the access code is on whenever a valid
 * `accessCodeHash` is present unless `accessCodeEnabled` is exactly `false`.
 */
export function parseWaitlistGate(text: string | null): WaitlistGate {
  const closed: WaitlistGate = { inviteRequired: true, accessCodeHash: null };
  if (text === null) return closed;
  let file: unknown;
  try { file = JSON.parse(text); } catch { return closed; }
  if (typeof file !== 'object' || file === null || Array.isArray(file)) return closed;
  const f = file as { inviteRequired?: unknown; accessCodeHash?: unknown; accessCodeEnabled?: unknown };
  const hash = typeof f.accessCodeHash === 'string' && /^[0-9A-F]{64}$/.test(f.accessCodeHash) && f.accessCodeEnabled !== false
    ? f.accessCodeHash : null;
  return { inviteRequired: f.inviteRequired !== false, accessCodeHash: hash };
}

let cached: WaitlistGate | undefined;
export function waitlistGate(): WaitlistGate {
  if (cached === undefined) {
    let text: string | null = null;
    try { text = readFileSync(fileURLToPath(new URL('../deploy/waitlist-gate.json', import.meta.url)), 'utf8'); } catch { /* no file: closed */ }
    cached = parseWaitlistGate(text);
  }
  return cached;
}

type Identity = ReturnType<typeof redeemIdentity>;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Open sign-up needs one valid X account AND one valid Google account on the same verified Privy user
 * (X recorded as the identity, as an X invite redemption would). Anything less returns null.
 */
export function openSignupIdentity(privyUserId: string, accounts: unknown[]): Identity | null {
  const hasGoogle = accounts.some(a => record(a) && a.type === 'google_oauth' && typeof a.subject === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(a.subject));
  if (!hasGoogle) return null;
  try {
    const identity = redeemIdentity(privyUserId, accounts);
    return identity.method === 'twitter' ? identity : null;
  } catch { return null; }
}

const insertWaiting = `insert into waitlist(privy_user_id,x_user_id,x_handle,login_method,login_label) values($1,$2,$3,$4,$5) on conflict do nothing`;
const insertValues = (identity: Identity) =>
  [identity.privyUserId, identity.xUserId, identity.xHandle, identity.method, identity.method === 'twitter' ? null : identity.label];

export const OPEN_SIGNUP_APPROVER = 'open-signup';
/** Insert (always 'waiting', per the 0046 trigger) then approve only a waiting row; a revoked entry stays revoked. */
export async function postgresOpenApprove(identity: Identity): Promise<void> {
  await query(insertWaiting, insertValues(identity));
  await query(`update waitlist set status='approved',approved_at=clock_timestamp(),approved_by=$2,revoked_at=null
    where privy_user_id=$1 and status='waiting'`, [identity.privyUserId, OPEN_SIGNUP_APPROVER]);
}

export type OpenSignup = (privyUserId: string, accounts: unknown[]) => Promise<void>;
/**
 * While the gate says `inviteRequired: false`, approve a verified X+Google identity in `waitlist` before the usual
 * access check. Approvals are ordinary rows: re-enabling invites does not lock these users out again.
 * Failures are swallowed; the normal access check then decides (pending or unavailable).
 */
export function createOpenSignup(options: { inviteRequired?: () => boolean; approve?: (identity: Identity) => Promise<void> } = {}): OpenSignup {
  const required = options.inviteRequired ?? (() => waitlistGate().inviteRequired);
  const approve = options.approve ?? postgresOpenApprove;
  return async (privyUserId, accounts) => {
    if (required()) return;
    const identity = openSignupIdentity(privyUserId, accounts);
    if (identity === null) return;
    try { await approve(identity); } catch { /* fall through to the normal access check */ }
  };
}
export const waitlistOpenSignup = createOpenSignup();

/**
 * The view-only pass (BBWCRE8): the app lets someone who enters it look around without signing in. It grants nothing
 * on the API: no waitlist approval, no session. Trading still needs a sign-in that the waitlist admits.
 */
export function viewPassMatches(code: unknown, hash: string | null = waitlistGate().accessCodeHash): boolean {
  return hash !== null && typeof code === 'string' && code.length <= 64 && hashInviteCode(code.trim().toUpperCase()) === hash;
}
