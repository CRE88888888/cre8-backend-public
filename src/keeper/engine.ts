import { ContractFunctionRevertedError, HttpRequestError, InsufficientFundsError, RpcRequestError, SocketClosedError, TimeoutError } from 'viem';
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
  /** False while a keeper transaction is still in the pool (pending nonce ahead of the mined nonce). */
  settled(): Promise<boolean>;
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

/** A write whose broadcast or receipt was lost: it may or may not be on chain. */
export const UNSETTLED = 'transaction outcome unknown';

/** Needs a person: configuration, scenario/manifest, on-chain roles or funds. The keeper stops and reports critical. */
const FATAL_REASONS = new Set([
  'chain 97 only', 'insufficient funds', 'prefunded USDT inventory below minimum', 'USDT inventory must be prefunded',
  'PRICE_KEEPER_MAINTENANCE_SECONDS must be an integer between 600 and 3000',
  'PRICE_KEEPER_ENABLED requires 0 or 1', 'PRICE_KEEPER_RPC_URL is required', 'invalid keeper RPC configuration',
  'PRICE_KEEPER_MANIFEST and PRICE_KEEPER_SCENARIO are required', 'invalid replay start', 'invalid inventory thresholds',
  'invalid keeper signing configuration', 'usage: price-keeper [--once]', 'PRICE_KEEPER_PUBLIC_FALLBACK requires 0 or 1',
  'PRICE_KEEPER_RPC_FAILURE_TIMEOUT_SECONDS must be an integer between 1 and 86400',
  'invalid scenario JSON', 'invalid manifest JSON', 'expected object', 'expected positive decimal amount',
  'amount out of range', 'unexpected or missing fields', 'invalid timeline', 'invalid mode', 'integer out of range',
  'inactive segment must have zero movement', 'timeline too long', 'unsupported scenario version',
  'baseline differs from TestnetAssets', 'unknown override asset', 'invalid manifest address',
  'manifest must be chain 97', `manifest requires ${TESTNET_ASSETS.length} markets`, 'unexpected secondary', 'duplicate manifest contracts',
  'keeper role mismatch', 'missing keeper contract', 'periphery factory mismatch', 'numeraire mismatch',
  'market configuration mismatch', 'secondary mismatch', 'feed configuration mismatch', 'feed keeper mismatch',
]);

/** Chain state, races with other traders and bad node answers: named in logs, retried from a fresh inspection. */
const RETRY_REASONS = new Set([
  'invalid block time', 'block progress unavailable', 'old block', 'incomplete market observations', 'invalid market observation',
  'invalid feed observation', 'invalid replay time or asset', 'inventory precision unavailable',
  'invalid observation time', 'invalid price', 'feed precision unavailable', 'TWAP unavailable after swaps',
  'recovery price precision unavailable', 'invalid inventory', 'mint balance mismatch', 'transaction not confirmed',
  'invalid sqrt price inputs', 'sqrt price out of range', 'invalid pool price', 'feed unavailable', 'unexpected mock USDT/USD',
  'pool observation capacity unavailable', 'missing observation', 'pool changed since inspection',
  'swap budget cannot reach target', 'swap inventory too low', 'swap result mismatch', 'invalid gas price',
  'mint balance verification unavailable', 'swap result verification unavailable', UNSETTLED, 'keeper transaction still pending',
]);

const CONNECTION_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH',
  'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'EPROTO', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET']);
const FILE_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR']);
const NODE_BUSY = /rate limit|too many requests|exceeds? (?:the )?(?:defined )?limit|limit exceeded|quota|capacity|forbidden|unauthori[sz]ed|access denied|api key|temporarily unavailable|server (?:error|busy)|node (?:is )?(?:unavailable|busy)|timeout|timed out/i;
const NO_FUNDS = /insufficient funds|exceeds transaction sender account balance/i;

/**
 * fatal   — needs a person (configuration, scenario/manifest, on-chain roles, funds): stop and report critical.
 * network — the RPC or the network is the problem: any HTTP status (403, 429, 5xx…), a non-JSON body, timeouts,
 *           connection errors and node-side JSON-RPC errors. Retried with backoff; the process never stops for these.
 * retry   — everything else (reverts, races with other traders, inconsistent node answers, unknown errors):
 *           retried the same way, from a fresh head and inspection.
 */
export type FailureClass = 'fatal' | 'network' | 'retry';

export function classifyKeeperError(error: unknown): FailureClass {
  let network = false;
  let reverted = false;
  for (let depth = 0; error instanceof Error && depth < 16; depth++, error = error.cause) {
    if (FATAL_REASONS.has(error.message) || error instanceof InsufficientFundsError) return 'fatal';
    if (error instanceof ContractFunctionRevertedError) reverted = true;
    if (error instanceof HttpRequestError || error instanceof TimeoutError || error instanceof SocketClosedError) network = true;
    if ('code' in error && typeof error.code === 'string' && CONNECTION_CODES.has(error.code)) network = true;
    if (error instanceof RpcRequestError) {
      if (NO_FUNDS.test(error.details)) return 'fatal';
      // -32000 is also used for reverts and rejected input: only node/provider wording counts as a network fault.
      if ((error.data !== undefined && error.data !== null && error.data !== '0x') || /revert/i.test(error.details)) reverted = true;
      else if ([-32603, -32002, -32005].includes(error.code) || NODE_BUSY.test(error.details)) network = true;
    }
  }
  return reverted ? 'retry' : network ? 'network' : 'retry';
}

export const isNetworkError = (error: unknown): boolean => classifyKeeperError(error) === 'network';

/** The node executed the call and it reverted: nothing was broadcast. */
export function isRevert(error: unknown): boolean {
  for (let depth = 0; error instanceof Error && depth < 16; depth++, error = error.cause) if (error instanceof ContractFunctionRevertedError) return true;
  return false;
}

export function hasReason(error: unknown, reason: string): boolean {
  for (let depth = 0; error instanceof Error && depth < 16; depth++, error = error.cause) if (error.message === reason) return true;
  return false;
}

/** Upstream message/shortMessage/details may contain keys, RPC credentials or request bodies. */
export function safeReason(error: unknown): string {
  const reasons = new Set<string>();
  for (let depth = 0; error instanceof Error && depth < 8; depth++, error = error.cause) {
    if (FATAL_REASONS.has(error.message) || RETRY_REASONS.has(error.message)) reasons.add(error.message);
    if (error instanceof TimeoutError) reasons.add('TimeoutError');
    if (error instanceof SocketClosedError) reasons.add('SocketClosedError');
    if (error instanceof InsufficientFundsError || (error instanceof RpcRequestError && NO_FUNDS.test(error.details))) reasons.add('insufficient funds');
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

/** 5 s, 15 s, 60 s, 90 s, then every 120 s for as long as the failure lasts. */
export const RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 90_000, 120_000];

/**
 * One failure window spans partial rounds and skipped blocks; only full success resets it. The window never stops
 * the keeper: once it is longer than `alertSeconds` the caller reports critical once and keeps retrying.
 */
export class RpcRetry {
  private failedSince: number | undefined;
  private failures = 0;
  private retryAt = 0;
  private alerted = false;

  constructor(private readonly alertSeconds = 1800, private readonly now: () => number = Date.now) {
    if (!Number.isInteger(alertSeconds) || alertSeconds < 1 || alertSeconds > 86_400) throw new Error('PRICE_KEEPER_RPC_FAILURE_TIMEOUT_SECONDS must be an integer between 1 and 86400');
  }

  get pending(): boolean { return this.failedSince !== undefined; }
  get delayMs(): number { return Math.max(0, this.retryAt - this.now()); }
  get attempts(): number { return this.failures; }
  get failingSeconds(): number { return this.failedSince === undefined ? 0 : Math.floor((this.now() - this.failedSince) / 1000); }
  get alertSent(): boolean { return this.alerted; }
  beginFailure(): void { this.failedSince ??= this.now(); }
  fail(): number {
    this.beginFailure();
    this.failures++;
    const delayMs = RETRY_DELAYS_MS[Math.min(this.failures, RETRY_DELAYS_MS.length) - 1] ?? 120_000;
    this.retryAt = this.now() + delayMs;
    return delayMs;
  }
  /** True exactly once per failure window, after it has lasted longer than the alert threshold. */
  shouldAlert(): boolean {
    if (this.alerted || this.failedSince === undefined || this.now() - this.failedSince <= this.alertSeconds * 1000) return false;
    this.alerted = true;
    return true;
  }
  reset(): void { this.failedSince = undefined; this.failures = 0; this.retryAt = 0; this.alerted = false; }
}

/** Shared by the startup check and the rounds: what failed, which class, and for how long it has been failing. */
export function retryLine(stage: string, error: unknown, retry: RpcRetry, delayMs: number): string {
  return `[price-keeper][warning] ${stage}: ${safeReason(error)}; class=${classifyKeeperError(error)} failing=${retry.failingSeconds}s attempt=${retry.attempts} retryMs=${delayMs}`;
}

export function stillFailingLine(stage: string, error: unknown, retry: RpcRetry): string {
  return `[price-keeper][critical] chain 97 行情 keeper 已連續失敗 ${Math.floor(retry.failingSeconds / 60)} 分鐘：${stage}: ${safeReason(error)}（class=${classifyKeeperError(error)}）；行程沒有停止，仍每 60–120 秒重試，恢復後自動繼續`;
}

/** How many markets may fail on the network in one round before the round ends and backs off. */
export const NETWORK_SKIPS_PER_ROUND = 3;

/**
 * No DB or scheduler state. Every round starts from a fresh head and inspection, so a failed round is simply
 * retried: only a fatal error (see classifyKeeperError) stops the keeper.
 */
export class PriceKeeper {
  private stopped = false;
  private running = false;
  private previous: Head | undefined;
  private nonProgressRounds = 0;
  private lastRoundTimestamp: bigint | undefined;
  /** A write was lost in transit: no new round until the keeper has no transaction left in the pool. */
  private unsettled = false;
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
      if (this.retry.delayMs > 0) return;
      const head = await this.io.head();
      const wallMs = this.now();
      const wallSeconds = BigInt(Math.floor(wallMs / 1000));
      if (head.number < 0n || head.timestamp < 1n || head.timestamp - wallSeconds > BigInt(this.settings.stallSeconds)) throw new Error('invalid block time');
      const previous = this.previous;
      if (previous && (head.number <= previous.number || head.timestamp < previous.timestamp)) {
        this.nonProgressRounds++;
        this.log(`[price-keeper] skip block=${head.number} timestamp=${head.timestamp} previousBlock=${previous.number} previousTimestamp=${previous.timestamp} nonProgress=${this.nonProgressRounds}/5`);
        if (this.nonProgressRounds >= 5) { this.nonProgressRounds = 0; throw new Error('block progress unavailable'); }
        return;
      }
      if (wallSeconds - head.timestamp > BigInt(this.settings.stallSeconds)) throw new Error('old block');
      this.previous = { ...head };
      this.nonProgressRounds = 0;
      if (!this.retry.pending && this.lastRoundTimestamp !== undefined && head.timestamp - this.lastRoundTimestamp < BigInt(this.scenario.stepSeconds)) return;
      if (this.unsettled) {
        stage = 'pending transactions';
        if (!await this.io.settled()) throw new Error('keeper transaction still pending');
        this.unsettled = false;
      }
      // Read/validate every feed and oracle before the first mint or swap of a round.
      stage = 'inspect';
      const observations = await this.io.inspect(head);
      this.validateObservations(observations, head);
      this.lastRoundTimestamp = head.timestamp;
      stage = 'inventory USDT';
      await this.inventory(this.usdt, 'USDT', 18, 10n ** 18n);
      const recovery = observations.filter((o) => o.twapE18 === null);
      let marketFailure: { stage: string; error: unknown } | undefined;
      let networkSkips = 0;
      // One market's failure must not hold back the others. A lost write or a dead RPC ends the round instead.
      const skipMarket = (error: unknown) => {
        const kind = classifyKeeperError(error);
        if (kind === 'fatal' || hasReason(error, UNSETTLED) || (kind === 'network' && ++networkSkips >= NETWORK_SKIPS_PER_ROUND)) throw error;
        this.retry.beginFailure();
        marketFailure ??= { stage, error };
        this.log(`[price-keeper][warning] skip ${stage}: ${safeReason(error)}; class=${kind}`);
      };
      if (recovery.length > 0) {
        // Recover only the affected pools. Never publish spot or run script trades in this round.
        for (const observation of recovery) {
          try {
            if (!canSwap(head.timestamp, observation.lastObservation, this.scenario.stepSeconds)) continue;
            const target = observation.spotE18 * 10_001n / 10_000n;
            if (target <= observation.spotE18) throw new Error('recovery price precision unavailable');
            stage = `inventory ${observation.market.symbol}`;
            await this.inventory(observation.market.token, observation.market.symbol, observation.market.decimals, observation.spotE18);
            await this.inventory(this.usdt, 'USDT', 18, 10n ** 18n);
            stage = `recover swap ${observation.market.symbol}`;
            await this.io.swap(observation, target, this.settings.swapBudgetUsdtE18);
            this.log(`[price-keeper] recover ${observation.market.symbol} TwapUnavailable targetE18=${target}`);
          } catch (error) { skipMarket(error); }
        }
        if (marketFailure) { stage = marketFailure.stage; throw marketFailure.error; }
        await this.succeeded();
        this.log('[price-keeper] recovery round complete; revalidate TWAP next round');
        return;
      }
      let feedsDue = false;
      for (const observation of observations) {
        try {
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
        await this.io.push(this.cashFeed, 100_000_000n);
        this.log('[price-keeper] push USDT/USD');
        for (const observation of refreshed) {
          if (!observation.market.feed) continue;
          stage = `push ${observation.market.symbol}/USD`;
          // Checked for the entire set before the first push; retain the type/precision guard here.
          if (observation.twapE18 === null) throw new Error('TWAP unavailable after swaps');
          const answer = observation.twapE18 / 10n ** 10n;
          if (answer <= 0n) throw new Error('feed precision unavailable');
          await this.io.push(observation.market.feed, answer);
          this.log(`[price-keeper] push ${observation.market.symbol}/USD answerE8=${answer}`);
        }
      }
      if (marketFailure) { stage = marketFailure.stage; throw marketFailure.error; }
      await this.succeeded();
      this.log(`[price-keeper] round block=${head.number} timestamp=${head.timestamp}`);
    } catch (error) {
      if (classifyKeeperError(error) !== 'fatal') {
        if (hasReason(error, UNSETTLED)) this.unsettled = true;
        this.log(retryLine(stage, error, this.retry, this.retry.fail()));
        if (this.retry.shouldAlert()) await this.notify(stillFailingLine(stage, error, this.retry));
        return;
      }
      this.stopped = true;
      const message = `[price-keeper][critical] chain 97 行情 keeper 已停止：${stage}: ${safeReason(error)}；請檢查後手動重啟`;
      await this.notify(message);
      throw new Error('price keeper halted');
    } finally {
      this.running = false;
    }
  }

  private async notify(message: string): Promise<void> {
    this.log(message);
    try { await this.alert(message); } catch { this.log('[price-keeper] Telegram 通知失敗'); }
  }

  /** A complete round closes the failure window; a window that was reported critical is reported as recovered. */
  private async succeeded(): Promise<void> {
    if (!this.retry.pending) return;
    const line = `[price-keeper] recovered after ${this.retry.failingSeconds}s attempts=${this.retry.attempts}`;
    const alerted = this.retry.alertSent;
    this.retry.reset();
    if (alerted) await this.notify(`${line}；chain 97 行情 keeper 已恢復`);
    else this.log(line);
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
      await this.io.mint(token, amount);
      try {
        if (await this.io.balance(token) !== target) throw new Error('mint balance mismatch');
      } catch (error) {
        // The mint is confirmed; name the lost check. The next round reads the balance again before any top-up.
        if (isNetworkError(error)) throw new Error('mint balance verification unavailable', { cause: error });
        throw error;
      }
      this.log(`[price-keeper] mint ${symbol} amountRaw=${amount} balanceRaw=${target}`);
    }
  }
}
