import { ContractFunctionRevertedError, HttpRequestError, RpcRequestError, SocketClosedError, TimeoutError } from 'viem';
import type { Address } from 'viem';
import { boundedTarget, canSwap, targetAt } from './scenario.js';
import type { Scenario } from './scenario.js';
import { TESTNET_ASSETS } from './assets.js';

export type Market = { symbol: string; token: Address; pool: Address; oracle: Address; decimals: number; fee: number; feed?: Address; secondary?: Address; maxFeedAge: number };
export type Head = { number: bigint; timestamp: bigint };
// null means the primary oracle explicitly reverted TwapUnavailable, never an RPC/read failure.
// feedAnswerE8 is the oldest-relevant asset feed answer (null without a feed); omitted means unknown, so drift is not inferred.
export type Observation = { market: Market; spotE18: bigint; twapE18: bigint | null; lastObservation: bigint; feedUpdatedAt: bigint | null; feedAnswerE8?: bigint | null };
export type KeeperIO = {
  head(): Promise<Head>;
  inspect(head: Head): Promise<Observation[]>;
  balance(token: Address): Promise<bigint>;
  mint(token: Address, amount: bigint): Promise<void>;
  swap(observation: Observation, targetE18: bigint, budgetUsdtE18: bigint): Promise<void>;
  push(feed: Address, answerE8: bigint): Promise<void>;
};
export type KeeperSettings = { start: bigint; minimumUsdtE18: bigint; inventoryUsdtE18: bigint; swapBudgetUsdtE18: bigint; stallSeconds: number; rpcFailureTimeoutSeconds?: number; maintenanceSeconds?: number };

/** The USDT/USD cash feed is validated with a one-hour age; every asset feed set includes it. */
export const CASH_FEED_MAX_AGE = 3600;
/** Half of the 200 bps secondary deviation gate: republish before the router could reject a quote. */
export const FEED_DRIFT_BPS = 100n;
export const DEFAULT_MAINTENANCE_SECONDS = 1800;
export const MIN_MAINTENANCE_SECONDS = 600;
/** Oracles reject observations older than 3600 seconds; leave room for one delayed round and RPC backoff. */
export const MAX_MAINTENANCE_SECONDS = 3000;

export function maintenanceSeconds(value: number | undefined): number {
  const seconds = value ?? DEFAULT_MAINTENANCE_SECONDS;
  if (!Number.isInteger(seconds) || seconds < MIN_MAINTENANCE_SECONDS || seconds > MAX_MAINTENANCE_SECONDS) throw new Error('PRICE_KEEPER_MAINTENANCE_SECONDS must be an integer between 600 and 3000');
  return seconds;
}

/**
 * Feeds are pushed as one set (cash + every asset feed). A set is due once its oldest member reaches half of
 * the shorter of its own max age and the cash feed's, or once a TWAP drifts FEED_DRIFT_BPS from the
 * published answer (never more than once per scenario step).
 */
export function feedDue(observation: Observation, headTimestamp: bigint, stepSeconds: number): boolean {
  const { feedUpdatedAt, feedAnswerE8, twapE18, market } = observation;
  if (feedUpdatedAt === null) return false;
  const age = headTimestamp - feedUpdatedAt;
  const refresh = BigInt(Math.max(stepSeconds, Math.floor(Math.min(market.maxFeedAge, CASH_FEED_MAX_AGE) / 2)));
  if (age >= refresh) return true;
  if (age < BigInt(stepSeconds) || twapE18 === null || feedAnswerE8 === undefined || feedAnswerE8 === null || feedAnswerE8 <= 0n) return false;
  const published = twapE18 / 10n ** 10n;
  const gap = published > feedAnswerE8 ? published - feedAnswerE8 : feedAnswerE8 - published;
  return gap * 10_000n >= FEED_DRIFT_BPS * feedAnswerE8;
}

const LOCAL_REASONS = new Set([
  'invalid block time', 'block progress unavailable', 'old block', 'incomplete market observations',
  'invalid market observation', 'invalid feed observation', 'invalid observation time', 'invalid replay time or asset',
  'invalid price', 'integer out of range', 'feed precision unavailable', 'TWAP unavailable after swaps',
  'recovery price precision unavailable', 'inventory precision unavailable', 'invalid inventory',
  'prefunded USDT inventory below minimum', 'mint balance mismatch', 'chain 97 only',
  'transaction not confirmed', 'invalid sqrt price inputs', 'sqrt price out of range', 'invalid pool price',
  'feed unavailable', 'unexpected mock USDT/USD', 'pool observation capacity unavailable', 'missing observation',
  'USDT inventory must be prefunded', 'pool changed since inspection', 'swap budget cannot reach target',
  'swap inventory too low', 'swap result mismatch', 'invalid gas price',
  'mint balance verification unavailable', 'swap result verification unavailable',
  'RPC failure timeout exceeded', 'PRICE_KEEPER_MAINTENANCE_SECONDS must be an integer between 600 and 3000',
  'PRICE_KEEPER_ENABLED requires 0 or 1', 'PRICE_KEEPER_RPC_URL is required', 'invalid keeper RPC configuration',
  'PRICE_KEEPER_MANIFEST and PRICE_KEEPER_SCENARIO are required', 'invalid replay start', 'invalid inventory thresholds',
  'invalid keeper signing configuration', 'usage: price-keeper [--once]',
  'PRICE_KEEPER_RPC_FAILURE_TIMEOUT_SECONDS must be an integer between 1 and 86400',
  'invalid scenario JSON', 'invalid manifest JSON', 'expected object', 'expected positive decimal amount',
  'amount out of range', 'unexpected or missing fields', 'invalid timeline', 'invalid mode',
  'inactive segment must have zero movement', 'timeline too long', 'unsupported scenario version',
  'baseline differs from TestnetAssets', 'unknown override asset', 'invalid manifest address',
  'manifest must be chain 97', `manifest requires ${TESTNET_ASSETS.length} markets`, 'unexpected secondary', 'duplicate manifest contracts',
  'keeper role mismatch', 'missing keeper contract', 'periphery factory mismatch', 'numeraire mismatch',
  'market configuration mismatch', 'secondary mismatch', 'feed configuration mismatch', 'feed keeper mismatch',
]);

const CONNECTION_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH',
  'ENETUNREACH', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET']);
const FILE_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR']);

/** Inspect types/codes only; unknown, configuration and contract errors fail closed. */
export function isTransientRpcError(error: unknown): boolean {
  let transient = false;
  for (let depth = 0; error instanceof Error && depth < 16; depth++, error = error.cause) {
    if (LOCAL_REASONS.has(error.message) || error instanceof ContractFunctionRevertedError) return false;
    if (error instanceof TimeoutError || error instanceof SocketClosedError) transient = true;
    if (error instanceof HttpRequestError || error instanceof RpcRequestError) {
      const status = error.status;
      if (status !== undefined && status !== 408 && status !== 429 && (status < 500 || status > 599)) return false;
      if (error instanceof HttpRequestError) transient = true;
      else {
        // -32000 is also used for reverts/invalid input. Only known node/limit text qualifies.
        if (error.data !== undefined && error.data !== null && error.data !== '0x') return false;
        if (/revert|permission|unauthori[sz]ed|forbidden|invalid|insufficient funds/i.test(error.details)) return false;
        if ([-32603, -32002, -32005].includes(error.code) ||
          (error.code === -32000 && /rate limit|too many requests|temporarily unavailable|server (?:error|busy)|node (?:is )?(?:unavailable|busy)|timeout|timed out/i.test(error.details))) transient = true;
        else return false;
      }
    }
    if ('code' in error && typeof error.code === 'string' && CONNECTION_CODES.has(error.code)) transient = true;
  }
  return transient;
}

/** Upstream message/shortMessage/details may contain keys, RPC credentials or request bodies. */
export function safeReason(error: unknown): string {
  const reasons = new Set<string>();
  for (let depth = 0; error instanceof Error && depth < 8; depth++, error = error.cause) {
    if (LOCAL_REASONS.has(error.message)) reasons.add(error.message);
    if (error instanceof TimeoutError) reasons.add('TimeoutError');
    if (error instanceof SocketClosedError) reasons.add('SocketClosedError');
    if ('code' in error && typeof error.code === 'string' && (CONNECTION_CODES.has(error.code) || FILE_CODES.has(error.code))) reasons.add(error.code);
    if (error instanceof HttpRequestError) reasons.add(`HttpRequestError${Number.isInteger(error.status) ? ` status=${error.status}` : ''}`);
    if (error instanceof RpcRequestError) reasons.add(`RpcRequestError${Number.isInteger(error.code) ? ` code=${error.code}` : ''}`);
    if (error instanceof ContractFunctionRevertedError) {
      const name = error.data?.errorName;
      reasons.add(name && ['TwapUnavailable', 'StaleFeed', 'InvalidPoolPrice'].includes(name) ? name : 'ContractFunctionRevertedError');
      if (error.signature && /^0x[0-9a-f]{8}$/i.test(error.signature)) reasons.add(`selector=${error.signature}`);
    }
  }
  return [...reasons].join('; ') || 'upstream error (details redacted)';
}

/** One outage window spans partial rounds and skipped blocks; only full success resets it. */
export class RpcRetry {
  private failedSince: number | undefined;
  private failures = 0;
  private retryAt = 0;

  constructor(private readonly timeoutSeconds = 1800, private readonly now: () => number = Date.now) {
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86_400) throw new Error('PRICE_KEEPER_RPC_FAILURE_TIMEOUT_SECONDS must be an integer between 1 and 86400');
  }

  get pending(): boolean { return this.failedSince !== undefined; }
  get delayMs(): number { return Math.max(0, this.retryAt - this.now()); }
  check(): void {
    if (this.failedSince !== undefined && this.now() - this.failedSince > this.timeoutSeconds * 1000) throw new Error('RPC failure timeout exceeded');
  }
  beginFailure(): void {
    this.failedSince ??= this.now();
    this.check();
  }
  fail(): number {
    this.beginFailure();
    this.failures = Math.min(this.failures + 1, 6);
    const delayMs = Math.min(2000 * 2 ** (this.failures - 1), 60_000);
    this.retryAt = this.now() + delayMs;
    return delayMs;
  }
  reset(): void { this.failedSince = undefined; this.failures = 0; this.retryAt = 0; }
}

/** No DB or scheduler state. Unknown writes still halt; fresh reads may recover on a later round. */
export class PriceKeeper {
  private stopped = false;
  private running = false;
  private previous: Head | undefined;
  private nonProgressRounds = 0;
  private lastRoundTimestamp: bigint | undefined;
  private readonly retry: RpcRetry;
  private readonly maintenance: bigint;

  constructor(
    private readonly io: KeeperIO,
    private readonly scenario: Scenario,
    private readonly usdt: Address,
    private readonly cashFeed: Address,
    private readonly settings: KeeperSettings,
    private readonly log: (line: string) => void,
    private readonly alert: (line: string) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {
    this.retry = new RpcRetry(settings.rpcFailureTimeoutSeconds, now);
    this.maintenance = BigInt(maintenanceSeconds(settings.maintenanceSeconds));
  }

  get retryDelayMs(): number { return this.retry.delayMs; }

  async round(): Promise<void> {
    if (this.stopped || this.running) throw new Error('price keeper is stopped or already running');
    this.running = true;
    let stage = 'head';
    try {
      this.retry.check();
      if (this.retry.delayMs > 0) return;
      const head = await this.io.head();
      const wallMs = this.now();
      const wallSeconds = BigInt(Math.floor(wallMs / 1000));
      if (head.number < 0n || head.timestamp < 1n || head.timestamp - wallSeconds > BigInt(this.settings.stallSeconds)) throw new Error('invalid block time');
      const previous = this.previous;
      if (previous && (head.number <= previous.number || head.timestamp < previous.timestamp)) {
        this.nonProgressRounds++;
        this.log(`[price-keeper] skip block=${head.number} timestamp=${head.timestamp} previousBlock=${previous.number} previousTimestamp=${previous.timestamp} nonProgress=${this.nonProgressRounds}/5`);
        if (this.nonProgressRounds >= 5) throw new Error('block progress unavailable');
        return;
      }
      if (wallSeconds - head.timestamp > BigInt(this.settings.stallSeconds)) throw new Error('old block');
      this.previous = { ...head };
      this.nonProgressRounds = 0;
      if (!this.retry.pending && this.lastRoundTimestamp !== undefined && head.timestamp - this.lastRoundTimestamp < BigInt(this.scenario.stepSeconds)) return;
      // Read/validate every feed and oracle before the first mint or swap of a round.
      stage = 'inspect';
      const observations = await this.io.inspect(head);
      this.validateObservations(observations, head);
      this.lastRoundTimestamp = head.timestamp;
      stage = 'inventory USDT';
      await this.inventory(this.usdt, 'USDT', 18, 10n ** 18n);
      const recovery = observations.filter((o) => o.twapE18 === null);
      let marketFailure: { stage: string; error: unknown } | undefined;
      const skipMarket = (error: unknown) => {
        if (!isTransientRpcError(error)) throw error;
        this.retry.beginFailure();
        marketFailure ??= { stage, error };
        this.log(`[price-keeper][warning] skip ${stage}: ${safeReason(error)}`);
      };
      if (recovery.length > 0) {
        // Recover only the affected pools. Never publish spot or run script trades in this round.
        for (const observation of recovery) {
          try {
            this.retry.check();
            if (!canSwap(head.timestamp, observation.lastObservation, this.scenario.stepSeconds)) continue;
            const target = observation.spotE18 * 10_001n / 10_000n;
            if (target <= observation.spotE18) throw new Error('recovery price precision unavailable');
            stage = `inventory ${observation.market.symbol}`;
            await this.inventory(observation.market.token, observation.market.symbol, observation.market.decimals, observation.spotE18);
            await this.inventory(this.usdt, 'USDT', 18, 10n ** 18n);
            stage = `recover swap ${observation.market.symbol}`;
            this.retry.check();
            await this.io.swap(observation, target, this.settings.swapBudgetUsdtE18);
            this.log(`[price-keeper] recover ${observation.market.symbol} TwapUnavailable targetE18=${target}`);
          } catch (error) { skipMarket(error); }
        }
        if (marketFailure) { stage = marketFailure.stage; throw marketFailure.error; }
        this.retry.reset();
        this.log('[price-keeper] recovery round complete; revalidate TWAP next round');
        return;
      }
      let feedsDue = false;
      for (const observation of observations) {
        try {
          this.retry.check();
          const { market, spotE18, lastObservation } = observation;
          const target = targetAt(this.scenario, market.symbol, this.settings.start, head.timestamp);
          stage = `inventory ${market.symbol}`;
          await this.inventory(market.token, market.symbol, market.decimals, spotE18);
          if (feedDue(observation, head.timestamp, this.scenario.stepSeconds)) feedsDue = true;
          if (!canSwap(head.timestamp, lastObservation, this.scenario.stepSeconds)) continue;
          let bounded = boundedTarget(spotE18, target.price, this.scenario.maxStepBps);
          const gap = bounded > spotE18 ? bounded - spotE18 : spotE18 - bounded;
          const held = target.mode === 'closed' || target.mode === 'paused';
          // Frozen script targets (also exhausted/flat timelines) still need observations.
          // Infer direction from spot vs the frozen anchor so restarts cannot reset it.
          if (held || gap * 1_000_000n <= spotE18) {
            if (head.timestamp - lastObservation < this.maintenance) continue;
            const maintenance = target.price * (spotE18 >= target.price ? 9999n : 10001n) / 10_000n;
            bounded = boundedTarget(spotE18, maintenance, this.scenario.maxStepBps);
          }
          // All markets share cash inventory. Check between trades, including a near-empty late round.
          if (bounded > spotE18) await this.inventory(this.usdt, 'USDT', 18, 10n ** 18n);
          stage = `swap ${market.symbol}`;
          this.retry.check();
          await this.io.swap(observation, bounded, this.settings.swapBudgetUsdtE18);
          this.log(`[price-keeper] swap ${market.symbol} targetE18=${bounded}`);
        } catch (error) { skipMarket(error); }
      }
      if (feedsDue) {
        // Fresh primary TWAPs after the swaps, not future script targets. Both share the same chain clock.
        stage = 'refresh head';
        const latest = await this.io.head();
        stage = 'refresh inspect';
        const refreshed = await this.io.inspect(latest);
        this.validateObservations(refreshed, latest);
        if (refreshed.some((o) => o.twapE18 === null)) throw new Error('TWAP unavailable after swaps');
        stage = 'push USDT/USD';
        this.retry.check();
        await this.io.push(this.cashFeed, 100_000_000n);
        this.log('[price-keeper] push USDT/USD');
        for (const observation of refreshed) {
          if (!observation.market.feed) continue;
          stage = `push ${observation.market.symbol}/USD`;
          // Checked for the entire set before the first push; retain the type/precision guard here.
          if (observation.twapE18 === null) throw new Error('TWAP unavailable after swaps');
          const answer = observation.twapE18 / 10n ** 10n;
          if (answer <= 0n) throw new Error('feed precision unavailable');
          this.retry.check();
          await this.io.push(observation.market.feed, answer);
          this.log(`[price-keeper] push ${observation.market.symbol}/USD answerE8=${answer}`);
        }
      }
      if (marketFailure) { stage = marketFailure.stage; throw marketFailure.error; }
      this.retry.reset();
      this.log(`[price-keeper] round block=${head.number} timestamp=${head.timestamp}`);
    } catch (error) {
      if (isTransientRpcError(error)) {
        try {
          const delayMs = this.retry.fail();
          this.log(`[price-keeper][warning] ${stage}: ${safeReason(error)}; retryMs=${delayMs}`);
          return;
        } catch (timeout) { error = timeout; }
      }
      this.stopped = true;
      const message = `[price-keeper][critical] chain 97 行情 keeper 已停止：${stage}: ${safeReason(error)}；請檢查後手動重啟`;
      this.log(message);
      try { await this.alert(message); } catch { this.log('[price-keeper] Telegram 通知失敗'); }
      throw new Error('price keeper halted');
    } finally {
      this.running = false;
    }
  }

  private validateObservations(observations: Observation[], head: Head): void {
    if (observations.length !== Object.keys(this.scenario.assets).length ||
      new Set(observations.map((o) => o.market.symbol)).size !== observations.length) throw new Error('incomplete market observations');
    for (const observation of observations) {
      if (!Object.hasOwn(this.scenario.assets, observation.market.symbol) || observation.spotE18 <= 0n ||
        (observation.twapE18 !== null && observation.twapE18 <= 0n)) throw new Error('invalid market observation');
      if (observation.market.feed && (observation.feedUpdatedAt === null || observation.feedUpdatedAt <= 0n ||
        observation.feedUpdatedAt > head.timestamp)) throw new Error('invalid feed observation');
      targetAt(this.scenario, observation.market.symbol, this.settings.start, head.timestamp);
      canSwap(head.timestamp, observation.lastObservation, this.scenario.stepSeconds);
    }
  }

  private async inventory(token: Address, symbol: string, decimals: number, price: bigint): Promise<void> {
    const unit = 10n ** BigInt(decimals);
    const minimum = this.settings.minimumUsdtE18 * unit / price;
    const target = this.settings.inventoryUsdtE18 * unit / price;
    if (minimum <= 0n || target <= minimum) throw new Error('inventory precision unavailable');
    const balance = await this.io.balance(token);
    if (balance < 0n) throw new Error('invalid inventory');
    if (balance < minimum) {
      if (token.toLowerCase() === this.usdt.toLowerCase()) throw new Error('prefunded USDT inventory below minimum');
      const amount = target - balance;
      this.retry.check();
      await this.io.mint(token, amount);
      try {
        if (await this.io.balance(token) !== target) throw new Error('mint balance mismatch');
      } catch (error) {
        // Do not abandon exact-result validation after a confirmed mint.
        if (isTransientRpcError(error)) throw new Error('mint balance verification unavailable', { cause: error });
        throw error;
      }
      this.log(`[price-keeper] mint ${symbol} amountRaw=${amount} balanceRaw=${target}`);
    }
  }
}
