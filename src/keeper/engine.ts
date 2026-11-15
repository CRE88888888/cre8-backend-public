import type { Address } from 'viem';
import { boundedTarget, canSwap, targetAt } from './scenario.js';
import type { Scenario } from './scenario.js';

export type Market = { symbol: string; token: Address; pool: Address; oracle: Address; decimals: number; fee: number; feed?: Address; secondary?: Address; maxFeedAge: number };
export type Head = { number: bigint; timestamp: bigint };
export type Observation = { market: Market; spotE18: bigint; twapE18: bigint; lastObservation: bigint; feedUpdatedAt: bigint | null };
export type KeeperIO = {
  head(): Promise<Head>;
  inspect(head: Head): Promise<Observation[]>;
  balance(token: Address): Promise<bigint>;
  mint(token: Address, amount: bigint): Promise<void>;
  swap(observation: Observation, targetE18: bigint, budgetUsdtE18: bigint): Promise<void>;
  push(feed: Address, answerE8: bigint): Promise<void>;
};
export type KeeperSettings = { start: bigint; minimumUsdtE18: bigint; inventoryUsdtE18: bigint; swapBudgetUsdtE18: bigint; stallSeconds: number };

/** No DB or scheduler state. A failed/unknown write halts this instance; it is never automatically retried. */
export class PriceKeeper {
  private stopped = false;
  private running = false;
  private previous: { head: Head; wallMs: number } | undefined;
  private lastRoundTimestamp: bigint | undefined;

  constructor(
    private readonly io: KeeperIO,
    private readonly scenario: Scenario,
    private readonly usdt: Address,
    private readonly cashFeed: Address,
    private readonly settings: KeeperSettings,
    private readonly log: (line: string) => void,
    private readonly alert: (line: string) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  async round(): Promise<void> {
    if (this.stopped || this.running) throw new Error('price keeper is stopped or already running');
    this.running = true;
    try {
      const head = await this.io.head();
      const wallMs = this.now();
      const wallSeconds = BigInt(Math.floor(wallMs / 1000));
      if (head.number < 0n || head.timestamp < 1n || head.timestamp - wallSeconds > BigInt(this.settings.stallSeconds)) throw new Error('invalid block time');
      const previous = this.previous;
      if (previous && (head.number < previous.head.number || head.timestamp < previous.head.timestamp ||
        (head.number === previous.head.number && wallMs - previous.wallMs >= this.settings.stallSeconds * 1000))) throw new Error('block progress unavailable');
      if (!previous || head.number > previous.head.number) this.previous = { head, wallMs };
      if (wallSeconds - head.timestamp > BigInt(this.settings.stallSeconds)) throw new Error('old block');
      if (this.lastRoundTimestamp !== undefined && head.timestamp - this.lastRoundTimestamp < BigInt(this.scenario.stepSeconds)) return;
      // Read/validate every feed and oracle before the first mint or swap of a round.
      const observations = await this.io.inspect(head);
      this.validateObservations(observations, head);
      this.lastRoundTimestamp = head.timestamp;
      await this.inventory(this.usdt, 'USDT', 18, 10n ** 18n);
      let feedsDue = false;
      for (const observation of observations) {
        const { market, spotE18, lastObservation, feedUpdatedAt } = observation;
        const target = targetAt(this.scenario, market.symbol, this.settings.start, head.timestamp);
        await this.inventory(market.token, market.symbol, market.decimals, spotE18);
        if (feedUpdatedAt !== null && head.timestamp - feedUpdatedAt >= BigInt(this.scenario.stepSeconds)) feedsDue = true;
        if (!canSwap(head.timestamp, lastObservation, this.scenario.stepSeconds)) continue;
        let bounded = boundedTarget(spotE18, target.price, this.scenario.maxStepBps);
        const gap = bounded > spotE18 ? bounded - spotE18 : spotE18 - bounded;
        const held = target.mode === 'closed' || target.mode === 'paused';
        // Frozen script targets (also exhausted/flat timelines) still need observations.
        // Infer direction from spot vs the frozen anchor so restarts cannot reset it.
        if (held || gap * 1_000_000n <= spotE18) {
          if (head.timestamp - lastObservation < 1800n) continue;
          const maintenance = target.price * (spotE18 >= target.price ? 9999n : 10001n) / 10_000n;
          bounded = boundedTarget(spotE18, maintenance, this.scenario.maxStepBps);
        }
        // All markets share cash inventory. Check between trades, including a near-empty late round.
        if (bounded > spotE18) await this.inventory(this.usdt, 'USDT', 18, 10n ** 18n);
        await this.io.swap(observation, bounded, this.settings.swapBudgetUsdtE18);
        this.log(`[price-keeper] swap ${market.symbol} targetE18=${bounded}`);
      }
      if (feedsDue) {
        // Fresh primary TWAPs after the swaps, not future script targets. Both share the same chain clock.
        const latest = await this.io.head();
        const refreshed = await this.io.inspect(latest);
        this.validateObservations(refreshed, latest);
        await this.io.push(this.cashFeed, 100_000_000n);
        this.log('[price-keeper] push USDT/USD');
        for (const observation of refreshed) {
          if (!observation.market.feed) continue;
          const answer = observation.twapE18 / 10n ** 10n;
          if (answer <= 0n) throw new Error('feed precision unavailable');
          await this.io.push(observation.market.feed, answer);
          this.log(`[price-keeper] push ${observation.market.symbol}/USD answerE8=${answer}`);
        }
      }
      this.log(`[price-keeper] round block=${head.number} timestamp=${head.timestamp}`);
    } catch {
      this.stopped = true;
      const message = '[price-keeper][critical] chain 97 行情 keeper 已停止：RPC、區塊進度、行情來源或交易驗證失敗；請檢查後手動重啟';
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
      if (!Object.hasOwn(this.scenario.assets, observation.market.symbol) || observation.spotE18 <= 0n || observation.twapE18 <= 0n) throw new Error('invalid market observation');
      if (observation.market.feed && (observation.feedUpdatedAt === null || observation.feedUpdatedAt <= 0n ||
        observation.feedUpdatedAt > head.timestamp || head.timestamp - observation.feedUpdatedAt > BigInt(observation.market.maxFeedAge))) throw new Error('invalid feed observation');
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
      if (await this.io.balance(token) !== target) throw new Error('mint balance mismatch');
      this.log(`[price-keeper] mint ${symbol} amountRaw=${amount} balanceRaw=${target}`);
    }
  }
}
