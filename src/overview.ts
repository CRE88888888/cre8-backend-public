/**
 * `GET /me/overview`（backend#216）：「我的」頁一次要的數字——每個持倉的總值與策略加息淨值、錢包 USDT、現金生息。
 *
 * 為什麼要快照：每個 `/portfolios/:id/status` 都要現場讀鏈（2–27 秒），頁面一列一列等，讀不到就整列 Couldn't load。
 * 這裡把每一項的**最後一次成功值**留在 api 進程裡：請求直接回快照（只查一次 DB 的持倉清單），過期的項目在背景刷新
 * （全進程限併發，不會同時對 RPC 開十幾個規劃器）。最近被看過的錢包每分鐘在背景再刷一次，下一次打開就是新的。
 *
 * 語意：
 *   - 有值 → `state: 'ok'` 帶 `updatedAt`（那個值是什麼時候讀到的）；刷新失敗時照樣回上一次的值，另帶 `lastError`。
 *   - 第一次、還沒讀到 → 最多等 `firstWaitMs`，還沒好就 `state: 'pending'`；前端過幾秒再問一次。
 *   - 讀過但從沒成功 → `state: 'unavailable'` 帶錯誤代碼（不回 503：一檔壞掉不該讓整頁失敗）。
 *
 * 不寫 DB、不加 migration：進程重啟後第一次請求會重讀（前端有自己的本機快取，畫面不會空白）。
 */
import { AppError, errorChain } from './errors.js';

export type OverviewItemState = 'ok' | 'pending' | 'unavailable';
export type OverviewError = { code: string; message: string };

type Entry<T> = {
  value?: T;
  updatedAt?: Date;
  error?: OverviewError;
  errorAt?: Date;
  refreshing: Promise<void> | null;
  load: () => Promise<T>;
  touchedAt: number;
};

export type OverviewItem<T> = { state: OverviewItemState; updatedAt: string | null; refreshing: boolean; error: OverviewError | null; value: T | null };

export type OverviewPortfolio = {
  id: number;
  strategyId: number;
  strategyName: string | null;
  account: string | null;
  state: OverviewItemState;
  updatedAt: string | null;
  refreshing: boolean;
  error: OverviewError | null;
  /** 投組總值（USD 1e8，十進位字串）；null = 還沒有值。 */
  totalUsdE8: string | null;
  /** true = 帳戶估值讀不到，這個數字是持倉逐項加總（不含生息部位）。 */
  estimated: boolean;
  /** 策略加息淨值（vault − 借款，1e18，可為負）；null = 沒有開／讀不到。 */
  earnNetUsd: string | null;
  /** `GET /portfolios/:id/strategy-earn` 的最後一份（基金頁的加息開關用）；自建組合是 null。 */
  strategyEarn: unknown;
};

export type Overview = {
  updatedAt: string;
  portfolios: OverviewPortfolio[];
  cash: OverviewItem<{ usdtWei: string }>;
  earn: OverviewItem<unknown>;
};

export type OverviewDeps = {
  listPortfolios: (wallet: string) => Promise<{ id: number; strategyId: number; strategyName: string | null; smartAccounts: { address: string }[] }[]>;
  status: (portfolioId: number, wallet: string) => Promise<{ totalUsdE8: string | null; holdings: { usdValueE8: string }[]; unpriced: unknown[] }>;
  strategyEarn: (portfolioId: number, wallet: string) => Promise<unknown>;
  cashEarn: (wallet: string) => Promise<unknown>;
  walletUsdt: (wallet: string) => Promise<bigint>;
  now?: () => number;
  /** 值多久算新鮮（過了就背景刷新）。 */
  freshMs?: number;
  /** 沒有值時，請求最多等多久。 */
  firstWaitMs?: number;
  /** 同時刷新幾項（全進程）。 */
  concurrency?: number;
  /**
   * 單項刷新最多占用名額多久。逾時 → 這一項記成 `TIMEOUT` 錯誤、名額立刻還回去。
   * 狀態讀取自己有 30 秒上限並會中止 RPC；這一層是給其他讀取（策略加息、現金生息、錢包 USDT）的保險，
   * 讓任何一個卡住的讀取都不會永遠占著共用的 3 個名額。
   */
  loadTimeoutMs?: number;
  /** 背景刷新：多久看一次、看過多久內的錢包要刷。0 = 不開計時器（測試）。 */
  warmEveryMs?: number;
  warmWindowMs?: number;
  log?: (line: string) => void;
};

const toError = (error: unknown): OverviewError => error instanceof AppError
  ? { code: error.code, message: error.message.slice(0, 300) }
  : { code: 'UNAVAILABLE', message: (error instanceof Error ? error.message : String(error)).slice(0, 300) };

export function createOverview(deps: OverviewDeps) {
  const now = deps.now ?? (() => Date.now());
  const freshMs = deps.freshMs ?? 60_000, firstWaitMs = deps.firstWaitMs ?? 1_500, concurrency = Math.max(1, deps.concurrency ?? 3);
  const warmWindowMs = deps.warmWindowMs ?? 15 * 60_000;
  const loadTimeoutMs = deps.loadTimeoutMs ?? 45_000;
  const bounded = <T>(load: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([load(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AppError(503, 'TIMEOUT', `refresh did not finish within ${Math.round(loadTimeoutMs / 1000)} s`)), loadTimeoutMs);
      (timer as { unref?: () => void }).unref?.();
    })]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
  };
  const log = deps.log ?? ((line: string) => console.log(line));
  const entries = new Map<string, Entry<unknown>>();
  let running = 0;
  const waiting: (() => void)[] = [];
  const slot = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (running >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    running += 1;
    try { return await fn(); } finally { running -= 1; waiting.shift()?.(); }
  };

  function entry<T>(key: string, load: () => Promise<T>): Entry<T> {
    let e = entries.get(key) as Entry<T> | undefined;
    if (e === undefined) { e = { refreshing: null, load, touchedAt: now() }; entries.set(key, e as Entry<unknown>); }
    e.load = load; e.touchedAt = now();
    return e;
  }
  function refresh<T>(key: string, e: Entry<T>): Promise<void> {
    if (e.refreshing) return e.refreshing;
    const started = now();
    e.refreshing = slot(() => bounded(e.load)).then(
      (value) => { e.value = value; e.updatedAt = new Date(now()); e.error = undefined; e.errorAt = undefined; },
      (error: unknown) => {
        e.error = toError(error); e.errorAt = new Date(now());
        log(JSON.stringify({ level: 'warn', msg: 'overview refresh failed', key, ms: now() - started, code: e.error.code, error: e.error.message, cause: errorChain(error) }));
      },
    ).finally(() => { e.refreshing = null; });
    return e.refreshing;
  }
  const stale = (e: Entry<unknown>) => {
    const last = Math.max(e.updatedAt?.getTime() ?? 0, e.errorAt?.getTime() ?? 0);
    return now() - last >= freshMs;
  };
  async function read<T>(key: string, load: () => Promise<T>, force: boolean): Promise<OverviewItem<T>> {
    const e = entry(key, load);
    if (force || stale(e as Entry<unknown>)) {
      const p = refresh(key, e);
      if (e.value === undefined && e.error === undefined) {
        await Promise.race([p, new Promise((resolve) => { const t = setTimeout(resolve, firstWaitMs); (t as { unref?: () => void }).unref?.(); })]);
      }
    }
    return {
      state: e.value !== undefined ? 'ok' : e.error !== undefined && !e.refreshing ? 'unavailable' : 'pending',
      updatedAt: e.updatedAt?.toISOString() ?? null,
      refreshing: e.refreshing !== null,
      error: e.error ?? null,
      value: e.value ?? null,
    };
  }

  type PortfolioValue = { totalUsdE8: string | null; estimated: boolean };
  const portfolioValue = async (id: number, wallet: string): Promise<PortfolioValue> => {
    const st = await deps.status(id, wallet);
    if (st.totalUsdE8 !== null) return { totalUsdE8: st.totalUsdE8, estimated: false };
    // 帳戶估值讀不到（例如生息歷史還在確認）：持倉逐項加總仍然是看得到的數字；有沒價的資產就不算。
    if (st.unpriced.length > 0) throw new AppError(503, 'UNPRICED_HOLDINGS', 'some holdings have no price right now');
    return { totalUsdE8: st.holdings.reduce((sum, h) => sum + BigInt(h.usdValueE8), 0n).toString(), estimated: true };
  };
  // 自建組合沒有策略加息：後端回 409，在這裡記成「沒有」，不是錯誤。
  const strategyEarn = async (id: number, wallet: string): Promise<unknown> => {
    try { return await deps.strategyEarn(id, wallet); }
    catch (error) { if (error instanceof AppError && error.status === 409) return null; throw error; }
  };

  async function overview(wallet: string, options: { force?: boolean } = {}): Promise<Overview> {
    const w = wallet.toLowerCase(), force = options.force === true;
    touched.set(w, now());
    const list = await deps.listPortfolios(w);
    const [portfolios, cash, earn] = await Promise.all([
      Promise.all(list.map(async (p): Promise<OverviewPortfolio> => {
        const [v, se] = await Promise.all([
          read(`pf:${p.id}:${w}`, () => portfolioValue(p.id, w), force),
          read(`se:${p.id}:${w}`, () => strategyEarn(p.id, w), force),
        ]);
        const earnNet = se.value !== null && typeof se.value === 'object' && 'earnNetUsd' in se.value ? (se.value as { earnNetUsd: unknown }).earnNetUsd : null;
        return { id: p.id, strategyId: p.strategyId, strategyName: p.strategyName, account: p.smartAccounts[0]?.address ?? null,
          state: v.state, updatedAt: v.updatedAt, refreshing: v.refreshing || se.refreshing, error: v.error,
          totalUsdE8: v.value?.totalUsdE8 ?? null, estimated: v.value?.estimated ?? false,
          earnNetUsd: earnNet === null || earnNet === undefined ? null : String(earnNet), strategyEarn: se.value };
      })),
      read(`cash:${w}`, async () => ({ usdtWei: (await deps.walletUsdt(w)).toString() }), force),
      read(`earn:${w}`, () => deps.cashEarn(w), force),
    ]);
    return { updatedAt: new Date(now()).toISOString(), portfolios, cash, earn };
  }

  // 背景：最近看過的錢包，過期的項目先刷好（下一次打開就不用等）。
  const touched = new Map<string, number>();
  function warm(): void {
    const t = now();
    for (const [w, at] of touched) if (t - at > warmWindowMs) touched.delete(w);
    for (const [key, e] of entries) {
      const w = key.slice(key.lastIndexOf(':') + 1);
      if (!touched.has(w)) { if (!e.refreshing && t - e.touchedAt > warmWindowMs * 4) entries.delete(key); continue; }
      if (stale(e)) void refresh(key, e);
    }
  }
  let timer: ReturnType<typeof setInterval> | null = null;
  if ((deps.warmEveryMs ?? 30_000) > 0) {
    timer = setInterval(warm, deps.warmEveryMs ?? 30_000);
    (timer as { unref?: () => void }).unref?.();
  }
  return { overview, warm, stop: () => { if (timer) clearInterval(timer); } };
}
