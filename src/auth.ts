import { randomBytes } from 'node:crypto';
import { recoverMessageAddress } from 'viem';
import {
  InvalidNonceError,
  InvalidSignatureError,
  NonceExpiredError,
  UnauthorizedError,
  ValidationError,
} from './errors.js';

/** How long a nonce challenge stays redeemable: long enough for a wallet popup, short enough to bound replay. */
export const NONCE_TTL_MS = 5 * 60 * 1_000;
/** How long a session token stays valid. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
/** First line of the signed message. The exact text is part of the auth contract: change it and every client breaks. */
export const LOGIN_MESSAGE_INTRO = 'Sign in to CRE8 ATP';

/** 32 random bytes as hex (64 chars), for both nonces and session tokens. */
function randomToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * The EIP-191 personal_sign message for a nonce challenge. The wallet displays this verbatim:
 *
 *   Sign in to CRE8 ATP
 *
 *   Nonce: <nonce>
 *
 * `recoverMessageAddress({ message })` re-applies the EIP-191 prefix, so the client must sign this
 * exact UTF-8 string with personal_sign and nothing else.
 */
export function buildLoginMessage(nonce: string): string {
  return `${LOGIN_MESSAGE_INTRO}\n\nNonce: ${nonce}`;
}

export type NonceChallenge = {
  /** 32-byte random hex nonce; single use. */
  nonce: string;
  /** ISO-8601 instant after which the nonce is rejected with NONCE_EXPIRED. */
  expiresAt: string;
};

export type SessionCredentials = {
  /** Bearer token for the Authorization header. */
  token: string;
  expiresAt: string;
};

export type LoginCredentials = {
  /** Wallet address as the client knows it; compared case-insensitively. */
  wallet: string;
  nonce: string;
  /** 65-byte EIP-191 personal_sign signature (0x + 130 hex chars). */
  signature: string;
};

export type AuthStoreOptions = {
  /** Injectable clock (ms since epoch). Tests use it to expire nonces and sessions without waiting. */
  now?: () => number;
};

type NonceEntry = { expiresAt: number };
type SessionEntry = { wallet: string; expiresAt: number };

/**
 * In-memory nonce and session store.
 *
 * v1 deliberately keeps this in the process: one API instance, no shared state. TODO: a
 * multi-instance deployment must move both maps to Redis (or another shared store) before it
 * scales out, because a nonce issued by instance A cannot be redeemed on instance B and a session
 * minted by A is unknown to B.
 */
export class AuthStore {
  readonly #now: () => number;
  readonly #nonces = new Map<string, NonceEntry>();
  readonly #sessions = new Map<string, SessionEntry>();

  constructor(options: AuthStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
  }

  /** Mint a fresh single-use nonce valid for NONCE_TTL_MS. */
  issueNonce(): NonceChallenge {
    this.#pruneExpired();
    const nonce = randomToken();
    const expiresAt = this.#now() + NONCE_TTL_MS;
    this.#nonces.set(nonce, { expiresAt });
    return { nonce, expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * Redeem a nonce for a session token:
   *   1. the nonce must exist (INVALID_NONCE) and be unexpired (NONCE_EXPIRED),
   *   2. the signature must recover to the claimed wallet (INVALID_SIGNATURE),
   *   3. the nonce is then deleted, so it can never mint a second session.
   * Sessions live SESSION_TTL_MS; the returned wallet is lowercased and is the only trusted
   * identity for provider-scoped writes.
   */
  async login(wallet: string, nonce: string, signature: string): Promise<SessionCredentials> {
    const owner = wallet.trim().toLowerCase();

    const challenge = this.#nonces.get(nonce);
    if (challenge === undefined) {
      throw new InvalidNonceError(
        'nonce is unknown or was already used; request a new one from POST /auth/nonce',
      );
    }
    if (challenge.expiresAt <= this.#now()) {
      this.#nonces.delete(nonce);
      throw new NonceExpiredError('nonce has expired; request a new one from POST /auth/nonce');
    }

    let recovered: string;
    try {
      recovered = await recoverMessageAddress({
        message: buildLoginMessage(nonce),
        signature: signature as `0x${string}`,
      });
    } catch {
      // Malformed hex, wrong length, bad v — all the same answer to the caller.
      throw new InvalidSignatureError('signature could not be verified for this wallet');
    }

    if (recovered.toLowerCase() !== owner) {
      throw new InvalidSignatureError('signature does not match the wallet');
    }

    this.#nonces.delete(nonce);

    const token = randomToken();
    const expiresAt = this.#now() + SESSION_TTL_MS;
    this.#sessions.set(token, { wallet: owner, expiresAt });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * Resolve `Authorization: Bearer <token>` to the session wallet (lowercase).
   * Every failure — missing header, wrong scheme, unknown or expired token — is 401 UNAUTHORIZED.
   */
  authenticate(authHeader: string | null | undefined): string {
    const token = parseBearerToken(authHeader);

    const session = this.#sessions.get(token);
    if (session === undefined) throw unauthorized('missing or invalid session token');
    if (session.expiresAt <= this.#now()) {
      this.#sessions.delete(token);
      throw unauthorized('session token has expired');
    }

    return session.wallet;
  }

  /** Drop expired entries so an idle process does not grow forever. Called on the write paths. */
  #pruneExpired(): void {
    const now = this.#now();
    for (const [nonce, entry] of this.#nonces) {
      if (entry.expiresAt <= now) this.#nonces.delete(nonce);
    }
    for (const [token, entry] of this.#sessions) {
      if (entry.expiresAt <= now) this.#sessions.delete(token);
    }
  }
}

/** Validate the POST /auth/login body before any crypto runs, so shape errors are 400 and not 401. */
export function parseLoginBody(body: unknown): LoginCredentials {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('INVALID_AUTH', 'request body must be a JSON object');
  }

  const record = body as Record<string, unknown>;
  return {
    wallet: requireField(record.wallet, 'wallet'),
    nonce: requireField(record.nonce, 'nonce'),
    signature: requireField(record.signature, 'signature'),
  };
}

function requireField(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError('INVALID_AUTH', `${field} is required and must be a non-empty string`);
  }
  return value.trim();
}

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

function parseBearerToken(authHeader: string | null | undefined): string {
  const match = typeof authHeader === 'string' ? BEARER_PATTERN.exec(authHeader.trim()) : null;
  const token = match?.[1];
  if (token === undefined) throw unauthorized('missing or malformed Authorization header');
  return token;
}

function unauthorized(message: string): UnauthorizedError {
  return new UnauthorizedError(message);
}

/**
 * Process-wide store used by the HTTP layer. Tests that need to expire nonces or sessions build
 * their own `new AuthStore({ now })`; route tests go through this singleton.
 */
const defaultStore = new AuthStore();

export function issueNonce(): NonceChallenge {
  return defaultStore.issueNonce();
}

export function login(wallet: string, nonce: string, signature: string): Promise<SessionCredentials> {
  return defaultStore.login(wallet, nonce, signature);
}

export function authenticate(authHeader: string | null | undefined): string {
  return defaultStore.authenticate(authHeader);
}
