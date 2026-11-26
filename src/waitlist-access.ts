import { query } from './db.js';
import { AppError } from './errors.js';

/** The same whitelist is used for session access and /operator/* authorization. */
export function resolveOperatorWallets(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const raw = env.OPERATOR_WALLETS?.trim() ?? '';
  if (raw === '') return [];
  const wallets = raw.split(',').map((wallet) => wallet.trim().toLowerCase());
  if (wallets.some((wallet) => !/^0x[0-9a-f]{40}$/.test(wallet) || /^0x0{40}$/.test(wallet))) {
    throw new AppError(503, 'INVALID_OPERATOR_WALLETS', 'OPERATOR_WALLETS must be comma-separated nonzero EVM addresses');
  }
  return wallets;
}

export type WaitlistAccess = (wallet: string, privyUserId?: string) => Promise<void>;
export type WaitlistAccessLookup = (privyUserId: string) => Promise<boolean>;

/** Query the waitlist unique key for this session's verified identity, never other wallet bindings. */
export const postgresWaitlistAccess: WaitlistAccessLookup = async (privyUserId) => {
  const result = await query<{ status: string }>(
    'select status from waitlist where privy_user_id = $1', [privyUserId]);
  return result.rows[0]?.status === 'approved';
};

function pending(): AppError {
  return new AppError(403, 'WAITLIST_PENDING', 'waitlist approval is required; sign in with X');
}

export function createWaitlistAccess(options: {
  lookup?: WaitlistAccessLookup;
  operatorWallets?: () => readonly string[];
} = {}): WaitlistAccess {
  const lookup = options.lookup ?? postgresWaitlistAccess;
  return async (owner, privyUserId) => {
    const wallet = owner.toLowerCase();
    const operators = (options.operatorWallets ?? resolveOperatorWallets)();
    if (operators.some(allowed => allowed.toLowerCase() === wallet)) return;
    // NULL/absent identity is a legacy or SIWE session, allowed only for current operators.
    if (privyUserId === undefined || privyUserId.trim() === '' || privyUserId.length > 256) throw pending();
    let approved: boolean;
    try { approved = await lookup(privyUserId); }
    catch { throw new AppError(503, 'WAITLIST_UNAVAILABLE', 'waitlist is unavailable; try again later'); }
    if (!approved) throw pending();
  };
}

export const requireWaitlistAccess = createWaitlistAccess();
