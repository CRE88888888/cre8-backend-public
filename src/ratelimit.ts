import { isIP } from 'node:net';
import { AppError } from './errors.js';
import { ConfigurationError, loadRateLimitConfig } from './config.js';
import type { RateLimitConfig } from './config.js';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export type RateLimitPolicy = { limit: number; windowMs: number };
export type RateLimitDecision = { allowed: boolean; retryAfterSeconds: number };
/** consume must atomically check and increment. A shared Postgres implementation can replace this store. */
export interface RateLimitStore {
  consume(key: string, policy: RateLimitPolicy, now: number): Promise<RateLimitDecision>;
}

export class RateLimitError extends AppError {
  constructor(readonly retryAfterSeconds: number) {
    super(429, 'RATE_LIMITED', 'too many requests; retry after the indicated delay');
  }
}

/** Fixed UTC windows, bounded cardinality, no active-bucket eviction (which would reset attackers' budgets). */
export class MemoryRateLimitStore implements RateLimitStore {
  readonly #buckets = new Map<string, { count: number; resetAt: number }>();
  #nextPrune = 0;
  constructor(readonly maxKeys = 50_000) {
    if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) throw new RangeError('maxKeys must be a positive integer');
  }
  async consume(key: string, policy: RateLimitPolicy, now: number): Promise<RateLimitDecision> {
    if (!Number.isSafeInteger(policy.limit) || policy.limit < 0 ||
        !Number.isSafeInteger(policy.windowMs) || policy.windowMs < 1 || !Number.isSafeInteger(now) || now < 0) {
      throw new RangeError('invalid rate limit policy or clock');
    }
    if (now >= this.#nextPrune) {
      for (const [id, bucket] of this.#buckets) if (bucket.resetAt <= now) this.#buckets.delete(id);
      this.#nextPrune = Number.POSITIVE_INFINITY;
      for (const bucket of this.#buckets.values()) this.#nextPrune = Math.min(this.#nextPrune, bucket.resetAt);
    }
    const resetAt = (Math.floor(now / policy.windowMs) + 1) * policy.windowMs;
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - now) / 1000));
    if (policy.limit === 0) return { allowed: false, retryAfterSeconds };
    let bucket = this.#buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= now) {
      if (bucket === undefined && this.#buckets.size >= this.maxKeys) {
        throw new AppError(503, 'RATE_LIMIT_CAPACITY', 'request capacity reached; try again later');
      }
      bucket = { count: 0, resetAt };
      this.#buckets.set(key, bucket);
      this.#nextPrune = Math.min(this.#nextPrune, resetAt);
    }
    if (bucket.count >= policy.limit) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
    bucket.count++;
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

export type WalletAction = 'strategies' | 'versions' | 'portfolios' | 'plan' | 'redeem' | 'close' | 'assets';

export class RequestRateLimiter {
  readonly #trustedProxies: Set<string>;
  constructor(
    readonly config: RateLimitConfig = loadRateLimitConfig(),
    readonly store: RateLimitStore = new MemoryRateLimitStore(),
    readonly now: () => number = Date.now,
  ) {
    this.#trustedProxies = new Set(config.trustedProxyIps.map((ip) => {
      const normalized = normalizeIp(ip);
      if (normalized === null) throw new ConfigurationError('RATE_LIMIT_TRUSTED_PROXY_IPS must contain IP addresses');
      return normalized;
    }));
  }
  /** Walk explicitly trusted proxies from the socket inward; never trust a client-supplied leftmost value. */
  clientIp(peer: string | undefined, forwarded: string | string[] | undefined): string {
    const socket = normalizeIp(peer ?? '') ?? 'unknown';
    if (!this.#trustedProxies.has(socket) || typeof forwarded !== 'string') return socket;
    const hops = forwarded.split(',').map((ip) => normalizeIp(ip.trim()));
    if (hops.length > 20 || hops.some((ip) => ip === null)) return socket;
    let current = socket;
    for (let i = hops.length - 1; i >= 0 && this.#trustedProxies.has(current); i--) {
      const hop = hops[i];
      if (hop !== null && hop !== undefined) current = hop;
    }
    return current;
  }
  async auth(ip: string): Promise<void> {
    await this.#consume('auth:' + ip, this.config.authPerMinute, MINUTE_MS);
  }
  async wallet(action: WalletAction, wallet: string): Promise<void> {
    const limits: Record<WalletAction, RateLimitPolicy> = {
      strategies: { limit: this.config.strategiesPerDay, windowMs: DAY_MS },
      versions: { limit: this.config.versionsPerDay, windowMs: DAY_MS },
      portfolios: { limit: this.config.portfoliosPerDay, windowMs: DAY_MS },
      plan: { limit: this.config.planPerMinute, windowMs: MINUTE_MS },
      redeem: { limit: this.config.redeemPerMinute, windowMs: MINUTE_MS },
      close: { limit: this.config.closePerMinute, windowMs: MINUTE_MS },
      assets: { limit: this.config.assetsPerMinute, windowMs: MINUTE_MS },
    };
    const policy = limits[action];
    await this.#consume('wallet:' + wallet.toLowerCase() + ':' + action, policy.limit, policy.windowMs);
  }
  async #consume(key: string, limit: number, windowMs: number): Promise<void> {
    let result: RateLimitDecision;
    try {
      result = await this.store.consume(key, { limit, windowMs }, this.now());
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(503, 'RATE_LIMIT_UNAVAILABLE', 'request budget unavailable; try again later');
    }
    if (!result.allowed) throw new RateLimitError(result.retryAfterSeconds);
  }
}

function normalizeIp(ip: string): string | null {
  const version = isIP(ip);
  if (version === 4) return ip;
  if (version === 6) {
    try {
      const canonical = new URL('http://[' + ip + ']/').hostname.toLowerCase();
      const mapped = /^\[::ffff:([0-9a-f]+):([0-9a-f]+)\]$/.exec(canonical);
      if (mapped?.[1] !== undefined && mapped[2] !== undefined) {
        const high = Number.parseInt(mapped[1], 16);
        const low = Number.parseInt(mapped[2], 16);
        return [high >> 8, high & 255, low >> 8, low & 255].join('.');
      }
      return canonical;
    }
    catch { return null; }
  }
  return null;
}
