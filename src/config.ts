import { config as loadDotenv } from 'dotenv';

export type Config = {
  /** Postgres connection string. Required. */
  databaseUrl: string;
  /** HTTP port, 1-65535. Default 8080. */
  port: number;
  /** EIP-155 chain id. Default 56 (BNB Chain mainnet). */
  chainId: number;
  /** Optional JSON-RPC endpoint; null when unset. */
  rpcUrl: string | null;
};

export const DEFAULT_PORT = 8080;
export const DEFAULT_CHAIN_ID = 56;

let cachedConfig: Config | null = null;

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
  const chainId = parseInteger(env, 'CHAIN_ID', DEFAULT_CHAIN_ID, { min: 1 });
  const rpcUrl = env.RPC_URL?.trim() ? env.RPC_URL.trim() : null;

  return { databaseUrl, port, chainId, rpcUrl };
}

/** Process-wide config: loads .env once (without overriding real env vars) and caches the result. */
export function getConfig(): Config {
  if (cachedConfig) return cachedConfig;
  loadDotenv({ override: false });
  cachedConfig = loadConfig(process.env);
  return cachedConfig;
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
