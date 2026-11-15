import { config as loadDotenv } from 'dotenv';
import { profileAddress } from './testnet-profile.js';
import { isIP } from 'node:net';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export type PaymasterConfig = {
  signerPrivateKey: Hex;
  address: Address;
  executor: Address;
  registry: Address;
  mockUsdt: Address | null;
  rpcUrl: string;
  chainId: number;
  verificationGasLimit: bigint;
  postOpGasLimit: bigint;
  accountDailyCount: bigint;
  accountDailyGas: bigint;
  accountDailyWei: bigint;
  siteDailyGas: bigint;
  siteDailyWei: bigint;
  minDepositWei: bigint;
  timeoutMs: number;
};

/** Optional feature. Zero budgets block sponsorship; they never disable a safeguard. */
export function loadPaymasterConfig(env: NodeJS.ProcessEnv = process.env): PaymasterConfig | null {
  const raw = env.PAYMASTER_SIGNER_PRIVATE_KEY?.trim();
  if (!raw) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new ConfigurationError('PAYMASTER_SIGNER_PRIVATE_KEY must be a 32-byte hex key');
  const signerPrivateKey = raw as Hex;
  try { privateKeyToAccount(signerPrivateKey); }
  catch { throw new ConfigurationError('PAYMASTER_SIGNER_PRIVATE_KEY must be a valid secp256k1 key'); }
  const requiredAddress = (name: string): Address => {
    const address = configuredAddress(env, name);
    if (address === null || /^0x0{40}$/.test(address)) throw new ConfigurationError(name + ' must be a nonzero address');
    return address;
  };
  const rpcUrl = env.RPC_URL?.trim();
  if (!rpcUrl) throw new ConfigurationError('RPC_URL is required for paymaster sponsorship');
  const chainId = parseInteger(env, 'CHAIN_ID', DEFAULT_CHAIN_ID, { min: 1, max: Number.MAX_SAFE_INTEGER });
  // This signer is initially authorized for testnet and local anvil only. Mainnet needs separate approval.
  if (![97, 1337, 31337].includes(chainId)) throw new ConfigurationError('PAYMASTER signing requires CHAIN_ID 97, 1337 or 31337');
  const verificationGasLimit = parseBigInt(env, 'PAYMASTER_VERIFICATION_GAS_LIMIT', 100_000n);
  const postOpGasLimit = parseBigInt(env, 'PAYMASTER_POST_OP_GAS_LIMIT', 0n);
  if (verificationGasLimit < 1n || verificationGasLimit >= (1n << 128n) || postOpGasLimit >= (1n << 128n)) {
    throw new ConfigurationError('PAYMASTER_VERIFICATION_GAS_LIMIT / PAYMASTER_POST_OP_GAS_LIMIT exceed uint128 bounds');
  }
  return {
    signerPrivateKey, address: requiredAddress('PAYMASTER_ADDRESS'), executor: requiredAddress('EXECUTOR_ADDRESS'),
    registry: requiredAddress('REGISTRY_ADDRESS'), mockUsdt: configuredAddress(env, 'PAYMASTER_MOCK_USDT_ADDRESS'), rpcUrl, chainId,
    verificationGasLimit, postOpGasLimit,
    accountDailyCount: parseBigInt(env, 'PAYMASTER_ACCOUNT_DAILY_COUNT', 20n),
    accountDailyGas: parseBigInt(env, 'PAYMASTER_ACCOUNT_DAILY_GAS', 20_000_000n),
    accountDailyWei: parseBigInt(env, 'PAYMASTER_ACCOUNT_DAILY_WEI', 10n ** 16n),
    siteDailyGas: parseBigInt(env, 'PAYMASTER_SITE_DAILY_GAS', 200_000_000n),
    siteDailyWei: parseBigInt(env, 'PAYMASTER_SITE_DAILY_WEI', 10n ** 17n),
    minDepositWei: parseBigInt(env, 'PAYMASTER_MIN_DEPOSIT_WEI', 10n ** 16n),
    timeoutMs: parseInteger(env, 'PAYMASTER_TIMEOUT_MS', 5_000, { min: 1, max: 30_000 }),
  };
}

/** 僅含變數名與格式診斷，不含 env 原值；可安全寫入 server log。 */
export class ConfigurationError extends Error {}

export const POINTS_TASKS = ['enroll', 'deposit', 'rebalance', 'create_fund', 'withdraw', 'invite_reward'] as const;
export type PointsKind = typeof POINTS_TASKS[number];
export type PointsRule = { points: bigint; dailyCount: bigint; dailyPoints: bigint };
export type PointsConfig = {
  chainId: number; rpcUrl: string; registry: Address; executor: Address; token: Address;
  fromBlock: bigint; confirmations: bigint; delaySeconds: number; timeoutMs: number;
  rules: Record<PointsKind, PointsRule>;
};

/** Test campaign only. The starting block must cover ALL campaign history, including retries. */
export function loadPointsConfig(env: NodeJS.ProcessEnv = process.env): PointsConfig | null {
  if (!env.POINTS_ENABLED?.trim() || env.POINTS_ENABLED.trim() === '0') return null;
  if (env.POINTS_ENABLED.trim() !== '1') throw new ConfigurationError('POINTS_ENABLED must be 0 or 1');
  const chainId = parseInteger(env, 'CHAIN_ID', DEFAULT_CHAIN_ID, { min: 1, max: Number.MAX_SAFE_INTEGER });
  if (![97, 1337, 31337].includes(chainId)) throw new ConfigurationError('POINTS_ENABLED requires chain 97, 1337 or 31337');
  const address = (name: string): Address => {
    const value = configuredAddress(env, name);
    if (!value || /^0x0{40}$/.test(value)) throw new ConfigurationError(name + ' must be a nonzero address');
    return value;
  };
  if (!env.RPC_URL?.trim()) throw new ConfigurationError('RPC_URL is required for points');
  try {
    if (!['http:', 'https:'].includes(new URL(env.RPC_URL.trim()).protocol)) throw new Error();
  } catch { throw new ConfigurationError('RPC_URL must be an HTTP(S) URL for points'); }
  if (!env.POINTS_FROM_BLOCK?.trim()) throw new ConfigurationError('POINTS_FROM_BLOCK is required and must cover the campaign history');
  const rule = (kind: PointsKind): PointsRule => {
    const prefix = 'POINTS_' + kind.toUpperCase();
    return { points: parseBigInt(env, prefix, 10n), dailyCount: parseBigInt(env, prefix + '_DAILY_COUNT', 10n),
      dailyPoints: parseBigInt(env, prefix + '_DAILY_POINTS', 100n) };
  };
  const confirmations = parseBigInt(env, 'POINTS_CONFIRMATIONS', 12n);
  if (confirmations === 0n) throw new ConfigurationError('POINTS_CONFIRMATIONS must be positive');
  return { chainId, rpcUrl: env.RPC_URL.trim(), registry: address('REGISTRY_ADDRESS'), executor: address('EXECUTOR_ADDRESS'),
    token: address('PAYMASTER_MOCK_USDT_ADDRESS'), fromBlock: parseBigInt(env, 'POINTS_FROM_BLOCK', 0n), confirmations,
    delaySeconds: parseInteger(env, 'POINTS_DELAY_SECONDS', 86_400, { min: 0, max: 31_536_000 }),
    timeoutMs: parseInteger(env, 'POINTS_TIMEOUT_MS', 5_000, { min: 1, max: 30_000 }),
    rules: { enroll: rule('enroll'), deposit: rule('deposit'), rebalance: rule('rebalance'), create_fund: rule('create_fund'),
      withdraw: rule('withdraw'), invite_reward: rule('invite_reward') } };
}

/** USD uses exact E8 integers; null disables only the USD cap. Zero caps block positive usage. Exit has no account cap. */
export type TradingConfig = {
  minStepUsdE8: bigint; minBatchUsdE8: bigint; minDepositUsdE8: bigint;
  dailyGas: bigint; dailyUsdE8: bigint | null; timeoutMs: number;
};
/** Reservations pass their actual chain id, independently of the process's default chain. */
export function loadTradingConfig(env: NodeJS.ProcessEnv = process.env,
  chainId = parseInteger(env, 'CHAIN_ID', DEFAULT_CHAIN_ID, { min: 1, max: Number.MAX_SAFE_INTEGER })): TradingConfig {
  return {
    minStepUsdE8: parseBigInt(env, 'MIN_STEP_USD_E8', 500_000_000n),
    minBatchUsdE8: parseBigInt(env, 'MIN_BATCH_USD_E8', 5_000_000_000n),
    minDepositUsdE8: parseBigInt(env, 'MIN_DEPOSIT_USD_E8', 5_000_000_000n),
    dailyGas: parseBigInt(env, 'ACCOUNT_DAILY_GAS', 10_000_000n),
    // tBNB has no USD value. An explicit env cap (including zero) re-enables the USD check on 97.
    dailyUsdE8: chainId === 97 && !env.ACCOUNT_DAILY_GAS_USD_E8?.trim()
      ? null : parseBigInt(env, 'ACCOUNT_DAILY_GAS_USD_E8', 30_000_000n),
    timeoutMs: parseInteger(env, 'GAS_BUDGET_TIMEOUT_MS', 5_000, { min: 1, max: 30_000 }),
  };
}

/**
 * Settings the auth layer needs to build and check an EIP-4361 (SIWE) challenge. Kept separate
 * from the rest of the config so `src/auth.ts` can resolve it without `DATABASE_URL`: auth is the
 * one subsystem whose tests must run with no database at all.
 */
export type AuthConfig = {
  /** EIP-4361 `domain`: the RFC 3986 authority the wallet is asked to sign for. Default `localhost`. */
  authDomain: string;
  /** EIP-4361 `uri`: the resource the sign-in is for. Defaults to `http://<AUTH_DOMAIN>`. */
  authUri: string;
  /** EIP-155 chain id the signed message must be bound to. Default 56 (BNB Chain mainnet). */
  chainId: number;
};

export type PrivyConfig = { appId: string; verificationKey: string };

/** Optional offline identity-token verification. Incomplete settings disable only Privy login. */
export function loadPrivyConfig(env: NodeJS.ProcessEnv = process.env): PrivyConfig | null {
  const appId = env.PRIVY_APP_ID?.trim();
  const verificationKey = env.PRIVY_VERIFICATION_KEY?.trim();
  return appId && verificationKey ? { appId, verificationKey: verificationKey.replace(/\\n/g, '\n') } : null;
}

export function getPrivyConfig(): PrivyConfig | null {
  loadDotenv({ override: false });
  return loadPrivyConfig();
}

/**
 * Session key（Kernel permission validator）需要的兩個設定。
 *
 * 與 `AuthConfig` 分開、**不進 `Config`** 的理由有二：`src/permissions.ts` 不該為了算一個派生地址
 * 去要 `DATABASE_URL`；而且這兩個值在「沒有開啟 session key 功能」的行程裡完全用不到，設成必填會讓
 * 啟動與既有測試一起掛掉。啟動只驗證已填值的格式；取用走 `requireSessionKeyConfig()`，
 * 真的需要時才要求兩個值必填，訊息帶著缺哪一個。
 */
export type SessionKeyConfig = {
  /** Session key CallPolicy 的 target（rebalance executor）；null = 未設定。 */
  executorAddress: Address | null;
  /** HD 派生的 master seed（32-byte hex）；null = 未設定。私鑰不落 DB，DB 只存派生路徑。 */
  sessionKeyMasterSeed: Hex | null;
};

/**
 * 「這個 smart account 還能不能發 UserOp」的門檻，只有一個值：帳戶至少要有的 BNB 餘額（wei）。
 *
 * 為什麼不進 `Config`：`loadConfig` 的回傳形狀被 `test/strategies.test.ts` 用 `deepEqual` 釘死，
 * 而且沒有開啟 session key 的行程完全不看這個值。取用請走 `getGasConfig()`（同 `AuthConfig` /
 * `SessionKeyConfig` 的模式）。
 *
 * 為什麼是 bigint：預設 0.01 BNB = 10^16 wei 已經超過 `Number.MAX_SAFE_INTEGER`（≈9.007×10^15），
 * 用 `Number`/`parseInt` 解析會安靜地失真，所以整條路徑都是 bigint。
 */
export type GasConfig = {
  /** 帳戶餘額門檻（wei）。與 session key GasPolicy 的 1 BNB 上限是同一個量級，存更多也用不到。 */
  minSessionGasWei: bigint;
};

export type TelegramConfig = {
  botToken: string | null;
  chatId: string | null;
  apiBase: string;
};

export type RateLimitConfig = {
  authPerMinute: number;
  strategiesPerDay: number;
  versionsPerDay: number;
  portfoliosPerDay: number;
  planPerMinute: number;
  redeemPerMinute: number;
  closePerMinute: number;
  assetsPerMinute: number;
  maxNonces: number;
  trustedProxyIps: string[];
};

/** Single-instance attempt budgets. Zero blocks that operation; it never disables protection. */
export function loadRateLimitConfig(env: NodeJS.ProcessEnv = process.env): RateLimitConfig {
  const budget = (name: string, fallback: number) => parseInteger(env, name, fallback, { min: 0, max: 1_000_000 });
  const rawProxies = env.RATE_LIMIT_TRUSTED_PROXY_IPS?.trim() || '';
  const trustedProxyIps = rawProxies === '' ? [] : rawProxies.split(',').map((ip) => ip.trim());
  if (trustedProxyIps.some((ip) => isIP(ip) === 0 || ip.includes('%'))) {
    throw new ConfigurationError('RATE_LIMIT_TRUSTED_PROXY_IPS must contain comma-separated IP addresses');
  }
  return {
    authPerMinute: budget('RATE_LIMIT_AUTH_PER_MINUTE', 120),
    strategiesPerDay: budget('RATE_LIMIT_STRATEGIES_PER_DAY', 10),
    versionsPerDay: budget('RATE_LIMIT_VERSIONS_PER_DAY', 50),
    portfoliosPerDay: budget('RATE_LIMIT_PORTFOLIOS_PER_DAY', 20),
    planPerMinute: budget('RATE_LIMIT_PLAN_PER_MINUTE', 30),
    redeemPerMinute: budget('RATE_LIMIT_REDEEM_PER_MINUTE', 30),
    closePerMinute: budget('RATE_LIMIT_CLOSE_PER_MINUTE', 30),
    assetsPerMinute: budget('RATE_LIMIT_ASSETS_PER_MINUTE', 120),
    maxNonces: parseInteger(env, 'AUTH_MAX_NONCES', 10_000, { min: 1, max: 1_000_000 }),
    trustedProxyIps,
  };
}

export function loadRelayerGasConfig(env: NodeJS.ProcessEnv = process.env): { minRelayerGasWei: bigint } {
  return { minRelayerGasWei: parseBigInt(env, 'MIN_RELAYER_GAS_WEI', 10n ** 16n) };
}

/** 選填但必須成對設定；錯誤訊息只列變數名，不回顯憑證。 */
export function loadTelegramConfig(env: NodeJS.ProcessEnv = process.env): TelegramConfig {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim() || null;
  const chatId = env.TELEGRAM_CHAT_ID?.trim() || null;
  if ((botToken === null) !== (chatId === null)) {
    throw new ConfigurationError('TELEGRAM_BOT_TOKEN 與 TELEGRAM_CHAT_ID 必須一起設定或一起留空');
  }
  const apiBase = env.TELEGRAM_API_BASE?.trim() || 'https://api.telegram.org';
  try {
    const url = new URL(apiBase);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('invalid URL');
    }
    if (env.NODE_ENV === 'production' && url.protocol !== 'https:') {
      throw new Error('HTTPS required');
    }
  } catch {
    throw new ConfigurationError('TELEGRAM_API_BASE 必須是 http/https URL（production 僅允許 https），且不能含帳密、query 或 fragment');
  }
  return { botToken, chatId, apiBase: apiBase.replace(/\/+$/, '') };
}

export type Config = AuthConfig & {
  /** Postgres connection string. Required. */
  databaseUrl: string;
  /** HTTP port, 1-65535. Default 8080. */
  port: number;
  /** Optional JSON-RPC endpoint; null when unset (chain features disabled). */
  rpcUrl: string | null;
  /** Relayer/operator private key that signs on-chain transactions; null = chain disabled. */
  operatorPrivateKey: string | null;
  /** On-chain AtpRegistry address; null = chain disabled. */
  registryAddress: string | null;
};

export const DEFAULT_PORT = 8080;
export const DEFAULT_CHAIN_ID = 56;
export const DEFAULT_AUTH_DOMAIN = 'localhost';
/**
 * 每個 Kernel 帳戶建議持有的最低 gas（0.0005 BNB）。
 *
 * BSC 的 gas 是 0.05 gwei，一筆 sudo UserOp（約 500k gas）成本約 0.000025 BNB ——
 * 0.0005 已經夠跑 ~20 筆。這個值一路從 0.01 → 0.002 → 0.0005：
 * 前面的門檻對「存個 1.5 USDT 測試」來說高到荒謬 —— 使用者得先花 0.0021 BNB 補 gas
 * 才能入金，實測就卡在這裡（錢包 0.00188 BNB，夠 75 筆卻被 0.002 門檻擋住）。
 * 20 筆的餘裕對「再平衡失敗後還剩幾輪可重試」綽綽有餘，又不逼使用者鎖大額。
 */
export const DEFAULT_MIN_SESSION_GAS_WEI = 5n * 10n ** 14n;

let cachedConfig: Config | null = null;
let cachedAuthConfig: AuthConfig | null = null;
let cachedSessionKeyConfig: SessionKeyConfig | null = null;
let cachedGasConfig: GasConfig | null = null;

/**
 * Pure parser: reads the given env object, applies defaults, throws on bad values.
 * Tests use this directly; the process uses getConfig() so dotenv and the cache are applied once.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new ConfigurationError('DATABASE_URL is required (see backend/.env.example)');
  }

  const port = parseInteger(env, 'PORT', DEFAULT_PORT, { min: 1, max: 65_535 });
  const rpcUrl = env.RPC_URL?.trim() ? env.RPC_URL.trim() : null;
  const operatorPrivateKey = env.OPERATOR_PRIVATE_KEY?.trim() ? env.OPERATOR_PRIVATE_KEY.trim() : null;
  const registryAddress = configuredAddress(env, 'REGISTRY_ADDRESS');
  if (parseInteger(env, 'CHAIN_ID', DEFAULT_CHAIN_ID, { min: 1 }) === 97) {
    configuredAddress(env, 'EXECUTOR_ADDRESS');
    configuredAddress(env, 'PAYMASTER_ADDRESS');
    configuredAddress(env, 'PAYMASTER_MOCK_USDT_ADDRESS');
  }
  loadFaucetConfig(env);
  loadWelcomeConfig(env);
  // API 與 scheduler 的啟動都走這裡；不要等第一則警示才發現只填了一半。
  loadTelegramConfig(env);
  loadRateLimitConfig(env);
  loadRelayerGasConfig(env);
  loadPaymasterConfig(env);
  loadTradingConfig(env);
  loadPointsConfig(env);

  return {
    databaseUrl,
    port,
    ...loadAuthConfig(env),
    rpcUrl,
    operatorPrivateKey,
    registryAddress,
  };
}

/**
 * Pure parser for the SIWE settings alone. Deliberately independent of `DATABASE_URL`, so the auth
 * layer works — and its tests run — with no database configured.
 */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const chainId = parseInteger(env, 'CHAIN_ID', DEFAULT_CHAIN_ID, { min: 1 });
  const authDomain = parseAuthDomain(env);
  const authUri = parseAuthUri(env, authDomain);
  return { authDomain, authUri, chainId };
}

/** Process-wide config: loads .env once (without overriding real env vars) and caches the result. */
export function getConfig(): Config {
  if (cachedConfig) return cachedConfig;
  loadDotenv({ override: false });
  cachedConfig = loadConfig(process.env);
  return cachedConfig;
}

/** Cached auth-only config. Same lazy pattern as getConfig(), minus the DATABASE_URL requirement. */
export function getAuthConfig(): AuthConfig {
  if (cachedAuthConfig) return cachedAuthConfig;
  loadDotenv({ override: false });
  cachedAuthConfig = loadAuthConfig(process.env);
  return cachedAuthConfig;
}

/**
 * Pure parser for the session-key settings alone. Independent of `DATABASE_URL`, like `loadAuthConfig`,
 * so `src/permissions.ts` and its unit tests work with no database configured.
 */
export function loadSessionKeyConfig(env: NodeJS.ProcessEnv = process.env): SessionKeyConfig {
  return {
    executorAddress: configuredAddress(env, 'EXECUTOR_ADDRESS'),
    sessionKeyMasterSeed: parseOptionalSeed(env, 'SESSION_KEY_MASTER_SEED'),
  };
}

/** Cached session-key config. Same lazy pattern as getConfig(), minus the DATABASE_URL requirement. */
export function getSessionKeyConfig(): SessionKeyConfig {
  if (cachedSessionKeyConfig) return cachedSessionKeyConfig;
  loadDotenv({ override: false });
  cachedSessionKeyConfig = loadSessionKeyConfig(process.env);
  return cachedSessionKeyConfig;
}

/**
 * Pure parser for the gas-threshold settings alone. Independent of `DATABASE_URL`, like the other
 * small loaders, so a process that only reads balances needs no database.
 */
export function loadGasConfig(env: NodeJS.ProcessEnv = process.env): GasConfig {
  return { minSessionGasWei: parseBigInt(env, 'MIN_SESSION_GAS_WEI', DEFAULT_MIN_SESSION_GAS_WEI) };
}

/** Cached gas config. Same lazy pattern as getConfig(), minus the DATABASE_URL requirement. */
export function getGasConfig(): GasConfig {
  if (cachedGasConfig) return cachedGasConfig;
  loadDotenv({ override: false });
  cachedGasConfig = loadGasConfig(process.env);
  return cachedGasConfig;
}

/**
 * 真正要用 session key 時才呼叫的守門員：兩個設定缺任何一個就拋錯，訊息指出缺哪一個與它的用途。
 *
 * 刻意不在 `loadConfig` 做這件事 —— 那會讓「沒用到 session key」的行程（含既有測試）因為一個
 * 空值而啟動失敗。這裡接受 `env` 參數，讓測試不必動 `process.env`。
 */
export function requireSessionKeyConfig(env: NodeJS.ProcessEnv = process.env): {
  executorAddress: Address;
  masterSeed: Hex;
} {
  const { executorAddress, sessionKeyMasterSeed } = loadSessionKeyConfig(env);

  const missing: string[] = [];
  if (executorAddress === null) missing.push('EXECUTOR_ADDRESS');
  if (sessionKeyMasterSeed === null) missing.push('SESSION_KEY_MASTER_SEED');
  if (executorAddress === null || sessionKeyMasterSeed === null) {
    throw new ConfigurationError(
      `Session key 設定不完整：缺少 ${missing.join(' 與 ')}（見 backend/.env.example）。` +
        `EXECUTOR_ADDRESS 是 session key CallPolicy 允許呼叫的 target；` +
        `SESSION_KEY_MASTER_SEED 是派生 session key 的 HD master seed（0x + 64 hex）`,
    );
  }

  return { executorAddress, masterSeed: sessionKeyMasterSeed };
}

function parseInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  bounds: { min: number; max?: number },
): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  const withinBounds =
    Number.isInteger(value) && value >= bounds.min && (bounds.max === undefined || value <= bounds.max);
  if (!withinBounds) {
    const range = bounds.max === undefined ? `>= ${bounds.min}` : `in ${bounds.min}..${bounds.max}`;
    throw new ConfigurationError(`${name} must be an integer ${range}`);
  }
  return value;
}

/**
 * Wei 等級的整數解析：只收純十進位數字。
 *
 * 不能沿用 `parseInteger`：它的 `Number(raw)` 對 10^16 以上會失真。也不直接丟給 `BigInt`，因為
 * `BigInt('0x10')` 會成功（當成 hex）、`BigInt(' 1 ')` 又會吞掉空白，兩者都讓一個打錯的 wei 值
 * 安靜地變成另一個數字。先擋形狀，再交給 BigInt（它自己不會溢位）。
 */
function parseBigInt(env: NodeJS.ProcessEnv, name: string, fallback: bigint): bigint {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new ConfigurationError(`${name} must be a decimal integer amount of wei (digits only)`);
  }
  return BigInt(raw);
}

/**
 * Optional on-chain address (0x + 40 hex), normalised to lowercase. Empty means "not configured".
 * Used for REGISTRY_ADDRESS and EXECUTOR_ADDRESS; callers treat a null value as "not configured".
 */
function parseOptionalAddress(env: NodeJS.ProcessEnv, name: string): Address | null {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new ConfigurationError(`${name} must be a 0x-prefixed 20-byte hex address`);
  }
  // 上面那條 regex 已保證形狀與長度，這裡只是把驗證過的結果收窄成 viem 的 Address。
  return raw.toLowerCase() as Address;
}

/**
 * Optional 32-byte hex seed (0x + 64 hex), lowercased. Empty means "not configured".
 *
 * 形狀在這裡就驗掉：截斷或打錯的 seed 會派生出一組「看起來正常但對不上鏈上帳戶」的地址，
 * 等到那時才發現要查很久，所以在解析階段就帶著變數名炸掉。
 */
function parseOptionalSeed(env: NodeJS.ProcessEnv, name: string): Hex | null {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new ConfigurationError(`${name} must be a 0x-prefixed 32-byte hex seed (64 hex chars); length=${raw.length}, has0x=${raw.startsWith('0x')}`);
  }
  return raw.toLowerCase() as Hex;
}

/**
 * EIP-4361 `domain` is a bare RFC 3986 authority (host, optional port): no scheme, no path.
 * Nothing else is accepted, because the value is compared verbatim against what the wallet signed.
 */
function parseAuthDomain(env: NodeJS.ProcessEnv): string {
  const raw = env.AUTH_DOMAIN?.trim();
  if (raw === undefined || raw === '') return DEFAULT_AUTH_DOMAIN;
  if (/[/?#@\s]/.test(raw) || raw.includes('://')) {
    throw new ConfigurationError('AUTH_DOMAIN must be a bare authority such as app.cre8.xyz (no scheme or path)');
  }
  return raw;
}

/**
 * EIP-4361 `uri` must be an absolute URI. Default is the auth domain over http, which is right for
 * the localhost default; a deployed instance should set AUTH_URI (e.g. https://app.cre8.xyz).
 */
function parseAuthUri(env: NodeJS.ProcessEnv, authDomain: string): string {
  const raw = env.AUTH_URI?.trim();
  const value = raw === undefined || raw === '' ? `http://${authDomain}` : raw;

  let protocol: string;
  try {
    protocol = new URL(value).protocol;
  } catch {
    throw new ConfigurationError('AUTH_URI must be an absolute URI such as https://app.cre8.xyz');
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new ConfigurationError('AUTH_URI must use http or https');
  }
  return value;
}

function configuredAddress(env: NodeJS.ProcessEnv, name: string): Address | null {
  const chainId = parseInteger(env, 'CHAIN_ID', DEFAULT_CHAIN_ID, { min: 1, max: Number.MAX_SAFE_INTEGER });
  const address = parseOptionalAddress(env, name);
  if (chainId !== 97) return address;
  try { return profileAddress(chainId, name, address); }
  catch { throw new ConfigurationError(name + ' must match the chain 97 profile / address format'); }
}

export type FaucetConfig = { chainId: 97; amountWei: bigint; siteDailyWei: bigint; timeoutMs: number };

export const WELCOME_AMOUNT_WEI = 10_000n * 10n ** 18n;
export type WelcomeConfig = { chainId: 97; siteDailyWei: bigint; timeoutMs: number };
export function loadWelcomeConfig(env: NodeJS.ProcessEnv = process.env): WelcomeConfig | null {
  if (parseInteger(env, 'CHAIN_ID', DEFAULT_CHAIN_ID, { min: 1 }) !== 97) return null;
  const siteDailyWei = parseBigInt(env, 'WELCOME_USDT_SITE_DAILY_WEI', 5_000_000n * 10n ** 18n);
  if (siteDailyWei >= 1n << 256n) throw new ConfigurationError('WELCOME_USDT_SITE_DAILY_WEI exceeds uint256');
  return { chainId: 97, siteDailyWei, timeoutMs: 5_000 };
}

/** Fixed ONE claim per owner/UTC day. Only token amount and site cap are configurable (18 decimals). */
export function loadFaucetConfig(env: NodeJS.ProcessEnv = process.env): FaucetConfig | null {
  if (parseInteger(env, 'CHAIN_ID', DEFAULT_CHAIN_ID, { min: 1 }) !== 97) return null;
  const amountWei = parseBigInt(env, 'FAUCET_USDT_AMOUNT_WEI', 1_000n * 10n ** 18n);
  const siteDailyWei = parseBigInt(env, 'FAUCET_USDT_SITE_DAILY_WEI', 1_000_000n * 10n ** 18n);
  if (amountWei > 10_000n * 10n ** 18n || siteDailyWei >= 1n << 256n) {
    throw new ConfigurationError('FAUCET_USDT_AMOUNT_WEI exceeds the 10,000 USDT contract cap or FAUCET_USDT_SITE_DAILY_WEI exceeds uint256');
  }
  return { chainId: 97, amountWei, siteDailyWei, timeoutMs: 5_000 };
}
