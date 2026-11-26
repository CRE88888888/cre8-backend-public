import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { query } from './db.js';
import { redeemIdentity } from './waitlist-invites.js';

/**
 * The invite-code switch: deploy/waitlist-gate.json `{ "inviteRequired": true|false }`, read once per process.
 * Only an explicit `false` opens sign-up; a missing or malformed file, or any other value, keeps invites required.
 */
export function parseWaitlistGate(text: string | null): { inviteRequired: boolean } {
  if (text === null) return { inviteRequired: true };
  try {
    const file: unknown = JSON.parse(text);
    return { inviteRequired: !(typeof file === 'object' && file !== null && (file as { inviteRequired?: unknown }).inviteRequired === false) };
  } catch { return { inviteRequired: true }; }
}

let cached: boolean | undefined;
export function inviteRequired(): boolean {
  if (cached === undefined) {
    let text: string | null = null;
    try { text = readFileSync(fileURLToPath(new URL('../deploy/waitlist-gate.json', import.meta.url)), 'utf8'); } catch { /* no file: invites required */ }
    cached = parseWaitlistGate(text).inviteRequired;
  }
  return cached;
}

type OpenIdentity = ReturnType<typeof redeemIdentity>;
/** Open sign-up admits a verified X or Google login only (same identity rules as invite redemption); never email-only or SIWE. */
export function openSignupIdentity(privyUserId: string, accounts: unknown[]): OpenIdentity | null {
  try {
    const identity = redeemIdentity(privyUserId, accounts);
    return identity.method === 'twitter' || identity.method === 'google' ? identity : null;
  } catch { return null; }
}

export const OPEN_SIGNUP_APPROVER = 'open-signup';
/** Insert (always 'waiting', per the 0046 trigger) then approve only a waiting row; a revoked entry stays revoked. */
export async function postgresOpenApprove(identity: OpenIdentity): Promise<void> {
  await query(`insert into waitlist(privy_user_id,x_user_id,x_handle,login_method,login_label) values($1,$2,$3,$4,$5) on conflict do nothing`,
    [identity.privyUserId, identity.xUserId, identity.xHandle, identity.method, identity.method === 'twitter' ? null : identity.label]);
  await query(`update waitlist set status='approved',approved_at=clock_timestamp(),approved_by=$2,revoked_at=null
    where privy_user_id=$1 and status='waiting'`, [identity.privyUserId, OPEN_SIGNUP_APPROVER]);
}

export type OpenSignup = (privyUserId: string, accounts: unknown[]) => Promise<void>;
/**
 * While deploy/waitlist-gate.json says `inviteRequired: false`, approve this verified X/Google identity in `waitlist`
 * before the usual access check. Approvals are ordinary rows: re-enabling invites does not lock these users out again.
 * Failures are swallowed; the normal access check then decides (pending or unavailable).
 */
export function createOpenSignup(options: { inviteRequired?: () => boolean; approve?: (identity: OpenIdentity) => Promise<void> } = {}): OpenSignup {
  const required = options.inviteRequired ?? inviteRequired;
  const approve = options.approve ?? postgresOpenApprove;
  return async (privyUserId, accounts) => {
    if (required()) return;
    const identity = openSignupIdentity(privyUserId, accounts);
    if (identity === null) return;
    try { await approve(identity); } catch { /* fall through to the normal access check */ }
  };
}

export const waitlistOpenSignup = createOpenSignup();
