import { isIP } from 'node:net';
import { AppError } from './errors.js';
import { ConfigurationError, loadRateLimitConfig, loadAccountDeploymentConfig } from './config.js';
import type { RateLimitConfig } from './config.js';
import { withTransaction } from './db.js';
import type { PoolClient } from 'pg';
import type { Address } from 'viem';
import { kernelAddressesForChain } from './addresses.js';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export type RateLimitPolicy = { limit: number; windowMs: number };
export type RateLimitDecision = { allowed: boolean; retryAfterSeconds: number };
/** consume must atomically check and increment; daily production budgets are persisted in Postgres. */
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

export type WalletAction = 'strategies' | 'versions' | 'portfolios' | 'plan' | 'redeem' | 'close' | 'assets' | 'enrollment-params' | 'enrollment-confirm';

async function consumeDaily(client: PoolClient, owner: string, action: string, limit: number): Promise<RateLimitDecision> {
  if (!/^0x[0-9a-f]{40}$/.test(owner) || /^0x0{40}$/.test(owner) ||
      !['create_strategy','publish_version','join'].includes(action) || !Number.isSafeInteger(limit) || limit < 0) throw new RangeError('invalid daily request budget');
  const clock = (await client.query<{ retry: number }>(`select greatest(1,ceil(extract(epoch from
    (date_trunc('day',transaction_timestamp() at time zone 'UTC')+interval '1 day'-(transaction_timestamp() at time zone 'UTC')))))::int as retry`)).rows[0];
  if (!clock || !Number.isSafeInteger(clock.retry) || clock.retry < 1) throw new Error('budget clock unavailable');
  const consumed = await client.query(`insert into daily_operation_counts(owner,action,utc_day,count)
    select $1,$2,(transaction_timestamp() at time zone 'UTC')::date,1 where $3::bigint>0
    on conflict(owner,action,utc_day) do update set count=daily_operation_counts.count+1,updated_at=clock_timestamp()
    where daily_operation_counts.count<$3::bigint returning count`, [owner, action, limit]);
  return { allowed: consumed.rows.length === 1, retryAfterSeconds: consumed.rows.length === 1 ? 0 : clock.retry };
}

/** Both counters commit together immediately before a deployment attempt. The pinned
 * MetaFactory contract is the shared namespace in the existing join counter (it
 * cannot be a signing login wallet). No operator/owner rotation resets this budget.
 * Unknown COMMIT denies broadcast; a committed attempt is never refunded/retried.
 */
export async function consumeAccountDeploymentBudget(owner: Address, transaction = withTransaction,
  limits = { perOwner: loadRateLimitConfig().portfoliosPerDay, perDay: loadAccountDeploymentConfig().perDay }): Promise<void> {
  const globalOwner = kernelAddressesForChain(97).kernelMetaFactory.toLowerCase();
  try {
    if (owner.toLowerCase() === globalOwner) throw new Error('deployment owner conflicts with quota namespace');
    await transaction(async client => {
      await client.query("set local statement_timeout='5s'");
      await client.query("set local lock_timeout='5s'");
      // Global row first gives concurrent writers a consistent lock order.
      if (!(await consumeDaily(client, globalOwner, 'join', limits.perDay)).allowed) {
        throw new AppError(503, 'ACCOUNT_DEPLOYMENT_DAILY_LIMIT', 'daily account deployment limit reached; retry next UTC day');
      }
      const personal = await consumeDaily(client, owner.toLowerCase(), 'join', limits.perOwner);
      if (!personal.allowed) throw new RateLimitError(personal.retryAfterSeconds);
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'ACCOUNT_DEPLOYMENT_BUDGET_UNAVAILABLE', 'account deployment budget unavailable; retry later');
  }
}

/** Daily attempted-request budgets use the database UTC clock and one atomic UPSERT.
 * Never retry an ambiguous commit or fall back to process memory.
 */
export class PersistentRateLimitStore implements RateLimitStore {
  readonly #shortWindows = new MemoryRateLimitStore();
  constructor(readonly transaction = withTransaction) {}
  async consume(key: string, policy: RateLimitPolicy, now: number): Promise<RateLimitDecision> {
    const match = /^wallet:(0x[0-9a-f]{40}):(strategies|versions|portfolios)$/.exec(key);
    const owner = match?.[1];
    if (policy.windowMs !== DAY_MS) return this.#shortWindows.consume(key, policy, now);
    if (!match || !owner || /^0x0{40}$/.test(owner) || !Number.isSafeInteger(policy.limit) || policy.limit < 0) throw new RangeError('invalid daily request budget');
    const actions: Record<string, string> = { strategies: 'create_strategy', versions: 'publish_version', portfolios: 'join' };
    const action = actions[match[2] ?? ''];
    if (!action) throw new RangeError('invalid daily request action');
    return this.transaction(async client => {
      await client.query("set local statement_timeout='5s'");
      await client.query("set local lock_timeout='5s'");
      return consumeDaily(client, owner, action, policy.limit);
    });
  }
}

/** Retain seven completed UTC days; active-day counters are never reset. */
export async function pruneDailyOperationCounts(): Promise<void> {
  await withTransaction(async client => {
    await client.query("set local statement_timeout='5s'");
    await client.query("set local lock_timeout='5s'");
    await client.query("delete from daily_operation_counts where utc_day<(transaction_timestamp() at time zone 'UTC')::date-7");
  });
}

export class RequestRateLimiter {
  readonly #trustedProxies: Set<string>;
  readonly #gasFaucet = new MemoryRateLimitStore();
  constructor(
    readonly config: RateLimitConfig = loadRateLimitConfig(),
    readonly store: RateLimitStore = new PersistentRateLimitStore(),
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
  /** C3 #149: testnet-only attempt budget; restarting the process resets it.
   * Kept separate from all persistent production and USDT/paymaster budgets.
   */
  async gasFaucet(wallet: string): Promise<void> {
    const result = await this.#gasFaucet.consume('gas-faucet:' + wallet.toLowerCase(), { limit: 1, windowMs: DAY_MS }, this.now());
    if (!result.allowed) throw new AppError(429, 'GAS_FAUCET_QUOTA', 'gas faucet daily quota reached; retry next UTC day');
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
      'enrollment-params': { limit: this.config.enrollmentPerMinute, windowMs: MINUTE_MS },
      'enrollment-confirm': { limit: this.config.enrollmentPerMinute, windowMs: MINUTE_MS },
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
