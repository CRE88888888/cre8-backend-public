import { config as loadDotenv } from 'dotenv';

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

let cachedConfig: Config | null = null;
let cachedAuthConfig: AuthConfig | null = null;

/**
 * Pure parser: reads the given env object, applies defaults, throws on bad values.
 * Tests use this directly; the process uses getConfig() so dotenv and the cache are applied once.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required (see backend/.env.example)');
  }

  const port = parseInteger(env, 'PORT', DEFAULT_PORT, { min: 1, max: 65_535 });
  const rpcUrl = env.RPC_URL?.trim() ? env.RPC_URL.trim() : null;
  const operatorPrivateKey = env.OPERATOR_PRIVATE_KEY?.trim() ? env.OPERATOR_PRIVATE_KEY.trim() : null;
  const registryAddress = parseOptionalAddress(env, 'REGISTRY_ADDRESS');

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
    throw new Error(`${name} must be an integer ${range}, got "${raw}"`);
  }
  return value;
}

/**
 * Optional on-chain address (0x + 40 hex), normalised to lowercase. Empty means "not configured".
 * Used for REGISTRY_ADDRESS; the chain layer treats a null value as "chain disabled".
 */
function parseOptionalAddress(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    throw new Error(`${name} must be a 0x-prefixed 20-byte hex address, got "${raw}"`);
  }
  return raw.toLowerCase();
}

/**
 * EIP-4361 `domain` is a bare RFC 3986 authority (host, optional port): no scheme, no path.
 * Nothing else is accepted, because the value is compared verbatim against what the wallet signed.
 */
function parseAuthDomain(env: NodeJS.ProcessEnv): string {
  const raw = env.AUTH_DOMAIN?.trim();
  if (raw === undefined || raw === '') return DEFAULT_AUTH_DOMAIN;
  if (/[/?#@\s]/.test(raw) || raw.includes('://')) {
    throw new Error(`AUTH_DOMAIN must be a bare authority such as app.cre8.xyz (no scheme or path), got "${raw}"`);
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
    throw new Error(`AUTH_URI must be an absolute URI such as https://app.cre8.xyz, got "${value}"`);
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(`AUTH_URI must use http or https, got "${value}"`);
  }
  return value;
}
