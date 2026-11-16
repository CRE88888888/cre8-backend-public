import { importSPKI, jwtVerify } from 'jose';
import { issueSession } from './auth.js';
import type { SessionCredentials } from './auth.js';
import { getPrivyConfig } from './config.js';
import type { PrivyConfig } from './config.js';
import { query } from './db.js';
import { requireWaitlistAccess } from './waitlist-access.js';
import type { WaitlistAccess } from './waitlist-access.js';
import { AppError, UnauthorizedError, ValidationError } from './errors.js';

/** Identity tokens contain linked accounts; plain access tokens cannot establish a new owner. */
export const MAX_PRIVY_TOKEN_LENGTH = 65_536;

export type PrivyUserRepository = {
  find(userId: string): Promise<string | null>;
  /** Insert only. Concurrent registrations must return the winning persisted owner. */
  create(userId: string, owner: string): Promise<string>;
};

export class PostgresPrivyUserRepository implements PrivyUserRepository {
  async find(userId: string): Promise<string | null> {
    const result = await query<{ owner_address: string }>(
      'select owner_address from privy_users where privy_user_id = $1', [userId],
    );
    return result.rows[0]?.owner_address ?? null;
  }

  async create(userId: string, owner: string): Promise<string> {
    const result = await query<{ owner_address: string }>(
      `insert into privy_users (privy_user_id, owner_address) values ($1, $2)
       on conflict (privy_user_id) do nothing returning owner_address`, [userId, owner],
    );
    // A separate statement gets a fresh READ COMMITTED snapshot after a competing insert commits.
    const saved = result.rows[0]?.owner_address ?? await this.find(userId);
    if (saved === null) throw new Error('Privy owner mapping unavailable');
    return saved;
  }
}

type PrivyLoginOptions = {
  config?: () => PrivyConfig | null;
  users?: PrivyUserRepository;
  issueSession?: typeof issueSession;
  access?: WaitlistAccess;
  now?: () => number;
};

function invalidToken(): UnauthorizedError {
  // Never forward JWT parser, key, token, or DB errors to logs or clients.
  return new UnauthorizedError('invalid or expired Privy identity token');
}

function unavailable(): AppError {
  return new AppError(503, 'PRIVY_UNAVAILABLE', 'Privy login is unavailable');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Offline ES256 verification, immutable owner registration, then the usual CRE8 session. */
export function createPrivyLogin(options: PrivyLoginOptions = {}): (body: unknown) => Promise<SessionCredentials> {
  const users = options.users ?? new PostgresPrivyUserRepository();
  const mint = options.issueSession ?? issueSession;
  const access = options.access ?? requireWaitlistAccess;
  const now = options.now ?? Date.now;
  return async (body) => {
    const config = (options.config ?? getPrivyConfig)();
    if (config === null) throw unavailable();
    if (!isRecord(body) || typeof body.identityToken !== 'string' || body.identityToken.trim() === '' ||
        body.identityToken.length > MAX_PRIVY_TOKEN_LENGTH) {
      throw new ValidationError('INVALID_AUTH', 'identityToken must be a non-empty string of at most 65536 characters');
    }

    let key: Awaited<ReturnType<typeof importSPKI>>;
    try {
      key = await importSPKI(config.verificationKey, 'ES256');
    } catch {
      throw unavailable();
    }

    let userId: string;
    let accounts: unknown[];
    try {
      const seconds = Math.floor(now() / 1000);
      const { payload } = await jwtVerify(body.identityToken, key, {
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
      userId = payload.sub;
      accounts = linked;
    } catch {
      throw invalidToken();
    }

    let owner: string | null;
    try { owner = await users.find(userId); } catch { throw unavailable(); }
    // Establish the candidate from signed claims without persisting an unapproved registration.
    // Existing owner mappings remain immutable, including after linked wallets change.
    if (owner !== null && (!/^0x[0-9a-f]{40}$/.test(owner) || /^0x0{40}$/.test(owner))) throw unavailable();
    const wallets = new Set<string>();
    if (owner === null) {
      for (const account of accounts) {
        if (isRecord(account) && account.type === 'wallet' && account.chain_type === 'ethereum' &&
            typeof account.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(account.address) &&
            !/^0x0{40}$/.test(account.address)) wallets.add(account.address.toLowerCase());
      }
    }
    const [candidate] = wallets;
    await access(owner ?? (wallets.size === 1 ? candidate ?? '' : ''), userId);
    if (owner === null) {
      if (wallets.size !== 1 || candidate === undefined) {
        throw new AppError(409, wallets.size === 0 ? 'PRIVY_NO_WALLET' : 'PRIVY_OWNER_AMBIGUOUS',
          'Complete your first CRE8 login with exactly one valid nonzero EVM wallet before linking additional wallets');
      }
      try { owner = await users.create(userId, candidate); } catch { throw unavailable(); }
    }
    // A concurrent registration may have won; validate its persisted owner before minting.
    if (!/^0x[0-9a-f]{40}$/.test(owner) || /^0x0{40}$/.test(owner)) throw unavailable();
    try { return await mint(owner, userId); }
    catch (error) {
      if (error instanceof AppError && ['WAITLIST_PENDING', 'WAITLIST_UNAVAILABLE', 'INVALID_OPERATOR_WALLETS'].includes(error.code)) throw error;
      throw unavailable();
    }
  };
}

export const loginWithPrivy = createPrivyLogin();
