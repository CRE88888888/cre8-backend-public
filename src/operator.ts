/**
 * 操作員的兩支端點實作：`GET /portfolios/:id/status` 與 `POST /portfolios/:id/rebalance`。
 *
 * 兩件事放同一個檔案，因為它們是同一段流程的兩半（先看見狀態 → 再決定要不要動錢），而且都只服務
 * 操作員：一支**很貴**（`planPortfolio` 會掃日誌、讀多個池、定價），一支**會動鏈上的錢**。
 * `server.ts` 只負責路由、認證與 HTTP 形狀。
 */

import { createPublicClient, http } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { bsc } from 'viem/chains';

import { getConfig, getSessionKeyConfig } from './config.js';
import { query as dbQuery, withTransaction } from './db.js';
import { AppError } from './errors.js';
import { requireOwnedPortfolio } from './portfolios.js';
import { countSwapExecuted, runSchedulerOnce } from './scheduler.js';
import type { ExecutionOutcome, PortfolioRunResult, WithTransactionFn } from './scheduler.js';
import { planPortfolio } from './snapshot.js';
import type { PortfolioPlan, QueryFn } from './snapshot.js';

// ---------------------------------------------------------------------------
// GET /portfolios/:id/status
// ---------------------------------------------------------------------------

/**
 * 狀態快取的有效期（毫秒）。
 *
 * 為什麼需要它：`planPortfolio` 是這支 API 最貴的一條路徑（掃 `Transfer` 日誌 + 每個資產讀池子的
 * `slot0`/`observe` + 對金額做 `balanceOf`），實測要幾秒。使用者連點兩下「看狀態」就是兩份完整讀鏈，
 * 而且**第二個請求一定在第一位還沒算完時進來**——所以快取連「算到一半的 promise」都留著，
 * 兩個請求共用同一次讀鏈，而不是各自讀一遍。
 */
export const STATUS_CACHE_TTL_MS = 10_000;

/**
 * 快取最多留幾個 portfolio 的狀態。
 *
 * 沒有上限的 in-memory Map 在長時間跑的服務裡就是一條洩漏：這裡只需要「同一個使用者連點」的保護，
 * 不需要記住整個 fleet。滿了就丟最舊的一筆（Map 的插入順序即 LRU 的近似）。
 */
export const STATUS_CACHE_MAX_ENTRIES = 100;

/** 一個有價持倉。`usdValueE8` 與漂移報告裡的同一個資產**逐位相同**（見 `statusOf`）。 */
export type StatusHolding = {
  asset: string;
  symbol: string;
  amountWei: string;
  decimals: number;
  usdValueE8: string;
  priceSource: string;
};

/** 沒有可用價格的資產：它會讓漂移拒算（`blocked`），所以必須看得到。 */
export type StatusUnpriced = {
  asset: string;
  symbol: string;
  amountWei: string;
  decimals: number;
  reason: string;
};

export type StatusTarget = { asset: string; symbol: string; weightBps: number };

export type StatusDriftAsset = {
  asset: string;
  symbol: string;
  targetBps: number;
  currentBps: number;
  deltaBps: number;
  usdValueE8: string;
};

export type StatusDrift = {
  grossDriftBps: number;
  maxAbsDeltaBps: number;
  needsRebalance: boolean;
  thresholdBps: number;
  assets: StatusDriftAsset[];
};

export type PortfolioStatus = {
  portfolioId: number;
  /** 這次觀測釘住的塊高（十進位字串：`bigint` 不進 JSON 數字）。 */
  block: string;
  account: string;
  holdings: StatusHolding[];
  unpriced: StatusUnpriced[];
  /** 投組總值（USD，1e8 定點）。沒有漂移報告時為 null（blocked 的那幾種）。 */
  totalUsdE8: string | null;
  targets: StatusTarget[];
  drift: StatusDrift | null;
  blocked: { code: string; detail: string }[];
  /**
   * 這份狀態是否**完整**：有漂移報告且 `blocked` 為空。
   *
   * false 不代表請求失敗（請求本身成功了，只是被觀測的投組現在算不出完整狀態）——真正的失敗
   * （RPC 掛、fork 過期、DB 掛）走 503，不會用一個看起來正常的空狀態冒充。
   */
  complete: boolean;
  /**
   * DB 記的 session key 與**實際會用**的那一把（唯讀顯示用）。
   *
   * 只顯示 DB 那一把會騙人：實測 portfolio 5 的 DB key 在鏈上沒安裝，排程器會退回舊的那把。
   */
  sessionKey: StatusSessionKey;
};

export type StatusDeps = {
  planPortfolio?: (portfolioId: number) => Promise<PortfolioPlan>;
  requireOwnedPortfolio?: typeof requireOwnedPortfolio;
  query?: QueryFn;
  /** 讀 `permissionConfig` 用；省略 = 由 `RPC_URL` 自己建一個。 */
  publicClient?: PublicClient;
  /** 毫秒時鐘；測試注入假時鐘就能驗 TTL。 */
  now?: () => number;
  log?: (line: string) => void;
};

export type PortfolioStatusReader = (portfolioId: number, wallet: string) => Promise<PortfolioStatus>;

const SQL_SYMBOLS = 'select address, symbol from priceable_assets where enabled';

/** `0xAbC…` → `0xabc…`：DB 與鏈上的地址大小寫不一致，比對一律用小寫。 */
function assetKey(asset: string): string {
  return asset.toLowerCase();
}

/** 一行、有限長度、保留原文的錯誤訊息（多行 stack 進 JSON body 沒有幫助，反而蓋掉真正的原因）。 */
function oneLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0]!.slice(0, 500);
}

/**
 * `priceable_assets` 的地址 → ticker。
 *
 * 這是狀態回應裡唯一的「顯示用」資料，但仍然從 DB 讀而不是從 `planPortfolio` 的內部：`planPortfolio`
 * 不吐 ticker，而猜（截斷地址）在有多個相似資產時會讓人看錯。查詢失敗就讓它變成 503——
 * 一份沒有 ticker 的狀態表比沒有狀態更難讀。
 */
async function loadSymbols(deps: StatusDeps): Promise<Map<string, string>> {
  const query = deps.query ?? dbQuery;
  const result = await query(SQL_SYMBOLS);
  const symbols = new Map<string, string>();
  for (const row of result.rows) {
    const typed = row as { address?: unknown; symbol?: unknown };
    if (typeof typed.address !== 'string' || typeof typed.symbol !== 'string') continue;
    symbols.set(assetKey(typed.address), typed.symbol);
  }
  return symbols;
}

/** `planPortfolio` 的持倉 → `usdValueE8`。與 `drift.ts` 的公式逐位相同（乘法後截斷，不是四捨五入）。 */
function usdValueE8Of(holding: { amountWei: bigint; usdPriceE8: bigint; decimals: number }): bigint {
  return (holding.amountWei * holding.usdPriceE8) / 10n ** BigInt(holding.decimals);
}

// ---------------------------------------------------------------------------
// session key：DB 記的那把 vs 鏈上真的會用的那把
// ---------------------------------------------------------------------------

/**
 * `permissionConfig(bytes4)` 的回傳（Kernel v3.3 `ValidationManager.PermissionConfig`）。
 *
 * ⚠ 這是 `scheduler.ts` 私有 `KERNEL_PERMISSION_ABI` 的**第二份**：那個常數沒有 export，而
 * `scheduler.ts` 不在這次改動範圍內（見 boundary），所以只能照抄。形狀（單一 tuple 輸出、
 * `policyData` 是 packed 的 `bytes22[]`）與上游逐字相同 —— 改一邊就要改另一邊。
 */
const PERMISSION_CONFIG_ABI = [
  {
    type: 'function',
    name: 'permissionConfig',
    stateMutability: 'view',
    inputs: [{ name: 'pId', type: 'bytes4' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'permissionFlag', type: 'bytes2' },
          { name: 'signer', type: 'address' },
          { name: 'policyData', type: 'bytes22[]' },
        ],
      },
    ],
  },
] as const;

/** 一組「裝好了」的 permission 有三層 policy（與 `scheduler.ts` 的 `EXPECTED_POLICY_COUNT` 相同）。 */
const EXPECTED_STATUS_POLICY_COUNT = 3;

/** 鏈上「沒安裝」＝ `signer` 是零地址。 */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * 這個 portfolio 的 session key，**由新到舊**（`key_ref` 最後一段 index 遞減）。
 *
 * 排序與 `scheduler.ts` 的 `SQL_ACTIVE_SESSION_KEYS` 一致：`usable` 必須等於排程器真的會挑的那一把，
 * 否則這個欄位只是另一種騙人的顯示。這裡不 join `smart_accounts`：`session_keys` 沒有 chain_id，
 * 排程器那個 join 只是為了拿 `owner` 做派生比對，顯示用不到。
 */
const SQL_SESSION_KEYS_NEWEST_FIRST = `
  select k.key_ref, k.permissions, k.status, k.expires_at
    from session_keys k
   where k.portfolio_id = $1
   order by (split_part(k.key_ref, '/', 6))::bigint desc
`;

/** 一支 session key 在 DB 裡記的樣子（不含「鏈上裝了沒」）。 */
export type StatusSessionKeyRef = { permissionId: string; keyRef: string };

/**
 * 「DB 記的 key」與「實際會用的 key」，加上 configured 那把的鏈上安裝狀態。
 *
 * 為什麼要兩個欄位：實測 portfolio 5 的 `sessionKey.permissionId = 0x7db20115`，而鏈上
 * `permissionConfig(0x7db20115).signer = 0x000…000`（沒有安裝），排程器會自動退回舊的
 * `0xf67556bf`。只顯示 DB 那一把，等於**顯示一把不會被使用的 key**。
 *
 * `error` 非 null 代表這次**讀不到**（DB 或鏈）：那時 `usable: null` 不可以被讀成
 * 「沒有任何可用的 key」，所以它一定要跟著 `error` 一起判讀。
 */
export type StatusSessionKey = {
  configured: (StatusSessionKeyRef & { installed: boolean }) | null;
  usable: StatusSessionKeyRef | null;
  error: string | null;
};

type SessionKeyRow = {
  key_ref?: unknown;
  permissions?: unknown;
  status?: unknown;
  expires_at?: unknown;
};

export type SessionKeyStatusDeps = {
  query?: QueryFn;
  publicClient?: PublicClient;
};

/** DB 一列 → `{permissionId, keyRef}`；形狀不對回 null（缺欄位不編一個看起來合理的值）。 */
function toStatusKeyRef(row: SessionKeyRow): StatusSessionKeyRef | null {
  const permissions = row.permissions as { permissionId?: unknown } | null | undefined;
  const permissionId = permissions?.permissionId;
  if (typeof permissionId !== 'string' || !/^0x[0-9a-fA-F]{8}$/.test(permissionId)) return null;
  if (typeof row.key_ref !== 'string' || row.key_ref === '') return null;
  return { permissionId, keyRef: row.key_ref };
}

function expiryMs(row: SessionKeyRow): number {
  const raw = row.expires_at;
  const time = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
  return Number.isFinite(time) ? time : 0;
}

/** 這把 key 在鏈上裝好了沒（`signer != 0` 且 policy 層數對）。讀不到就拋，由呼叫端記成 `error`。 */
async function readSessionKeyInstalled(
  client: PublicClient,
  account: Address,
  permissionId: Hex,
): Promise<boolean> {
  const config = await client.readContract({
    address: account,
    abi: PERMISSION_CONFIG_ABI,
    functionName: 'permissionConfig',
    args: [permissionId],
  });
  if (config.signer === ZERO_ADDRESS) return false;
  return config.policyData.length === EXPECTED_STATUS_POLICY_COUNT;
}

/**
 * 「DB 記的 key（configured）＋實際會用的 key（usable）＋安裝狀態」。
 *
 * `configured` 取自與 `GET /portfolios` 相同的那一列（`portfolios.ts` 的
 * `order by (status = 'active') desc, expires_at desc`）：兩邊不一致的話，列表和狀態面板會各說各話。
 * `usable` 走與排程器相同的「由新到舊逐把問鏈上，第一把裝好的才用」。
 *
 * ⚠ 這整段是**唯讀的顯示資訊，不參與任何放行判斷**：真正決定會不會動錢的是排程器自己的前置檢查。
 * 內部的 `resolveSessionKey` 沒有 export、而 `scheduler.ts` 不在這次改動範圍內，所以在這裡只為了
 * 「顯示」重做一次同樣的挑選。它永遠不拋：讀不到就回 `error`，讓面板能講「讀不到」而不是「沒有」。
 */
export async function resolveStatusSessionKey(
  portfolioId: number,
  account: string | null,
  deps: SessionKeyStatusDeps = {},
): Promise<StatusSessionKey> {
  const query = deps.query ?? dbQuery;

  let rows: SessionKeyRow[];
  try {
    rows = (await query(SQL_SESSION_KEYS_NEWEST_FIRST, [portfolioId])).rows as SessionKeyRow[];
  } catch (error) {
    return { configured: null, usable: null, error: `讀不到 session_keys：${oneLine(error)}` };
  }
  if (rows.length === 0) {
    // 一列都沒有 ＝ DB 從來沒記過（不是「記了但沒安裝」）。
    return { configured: null, usable: null, error: null };
  }

  let client: PublicClient | null = deps.publicClient ?? null;
  const clientFor = (): PublicClient => {
    if (client === null) client = defaultPublicClient();
    return client;
  };

  // configured：active 優先、再比到期日新到舊。`rows` 已按 index 遞減，穩定排序保留它當同分次序。
  const configuredRow = rows
    .slice()
    .sort((a, b) => {
      const activeA = a.status === 'active' ? 1 : 0;
      const activeB = b.status === 'active' ? 1 : 0;
      if (activeA !== activeB) return activeB - activeA;
      return expiryMs(b) - expiryMs(a);
    })[0];

  let error: string | null = null;
  let configured: (StatusSessionKeyRef & { installed: boolean }) | null = null;

  const configuredRef = configuredRow === undefined ? null : toStatusKeyRef(configuredRow);
  if (configuredRef !== null && account === null) {
    // 沒有 smart account 就無從問鏈上：安裝狀態未知，明講而不是給一個 false。
    configured = { ...configuredRef, installed: false };
    error = '這個 portfolio 沒有 smart account，無法確認 session key 在鏈上的安裝狀態';
  } else if (configuredRef !== null) {
    try {
      configured = {
        ...configuredRef,
        installed: await readSessionKeyInstalled(clientFor(), account as Address, configuredRef.permissionId as Hex),
      };
    } catch (err) {
      configured = { ...configuredRef, installed: false };
      error = `讀不到 configured key(${configuredRef.permissionId}) 的鏈上安裝狀態：${oneLine(err)}`;
    }
  }

  let usable: StatusSessionKeyRef | null = null;
  const nowMs = Date.now();
  for (const row of rows) {
    if (row.status !== 'active') continue;
    if (expiryMs(row) <= nowMs) continue;
    const ref = toStatusKeyRef(row);
    if (ref === null) continue;
    if (account === null) break;
    try {
      if (await readSessionKeyInstalled(clientFor(), account as Address, ref.permissionId as Hex)) {
        usable = ref;
        break;
      }
    } catch (err) {
      // 讀不到就停：繼續往下猜會讓 `usable` 變成一個沒有依據的答案。
      error ??= `讀不到 ${ref.keyRef}(${ref.permissionId}) 的鏈上安裝狀態：${oneLine(err)}`;
      break;
    }
  }

  return { configured, usable, error };
}

/**
 * 算一份完整狀態（**沒有**快取；快取在 `createPortfolioStatusReader`）。
 *
 * 讀鏈/讀 DB 失敗一律變成 503 並帶上原因。這裡刻意不 catch 之後回一個 `holdings: []` 的空狀態：
 * 使用者會把「讀不到」讀成「這個投組是空的」，然後看著一個空的投組按下再平衡。
 */
async function statusOf(portfolioId: number, deps: StatusDeps): Promise<PortfolioStatus> {
  const planFn = deps.planPortfolio ?? ((id: number) => planPortfolio(id));

  let plan: PortfolioPlan;
  try {
    plan = await planFn(portfolioId);
  } catch (error) {
    throw new AppError(
      503,
      'STATUS_UNAVAILABLE',
      `算不出 portfolio ${portfolioId} 的狀態（planPortfolio 失敗，通常是 RPC 不通、anvil fork 過期或 DB 不一致）：${oneLine(error)}`,
      { cause: error },
    );
  }

  let symbols: Map<string, string>;
  try {
    symbols = await loadSymbols(deps);
  } catch (error) {
    throw new AppError(
      503,
      'STATUS_UNAVAILABLE',
      `算得出持倉，但讀不到代幣 ticker（priceable_assets 查詢失敗）：${oneLine(error)}`,
      { cause: error },
    );
  }

  const targetSymbols = new Map(plan.targets.map((target) => [assetKey(target.asset), target.symbol]));
  const symbolFor = (asset: string): string =>
    targetSymbols.get(assetKey(asset)) ?? symbols.get(assetKey(asset)) ?? `${asset.slice(0, 6)}…${asset.slice(-4)}`;

  // 漂移報告的 usdValueE8 是**同一份觀測**算出來的；有報告時直接沿用它，讓「持倉表」與「漂移表」
  // 對同一個資產永遠是同一個數字（兩邊各算一次總有一天會分岔）。
  const byAsset = new Map((plan.report?.assets ?? []).map((row) => [assetKey(row.asset), row]));

  const holdings: StatusHolding[] = plan.snapshot.holdings.map((holding) => ({
    asset: holding.asset,
    symbol: symbolFor(holding.asset),
    amountWei: holding.amountWei.toString(),
    decimals: holding.decimals,
    usdValueE8: (byAsset.get(assetKey(holding.asset))?.usdValueE8 ?? usdValueE8Of(holding)).toString(),
    priceSource: holding.priceSource,
  }));

  const unpriced: StatusUnpriced[] = plan.snapshot.unpriced.map((asset) => ({
    asset: asset.asset,
    symbol: symbolFor(asset.asset),
    amountWei: asset.amountWei.toString(),
    decimals: asset.decimals,
    reason: asset.reason,
  }));

  const targets: StatusTarget[] = plan.targets.map((target) => ({
    asset: target.asset,
    symbol: target.symbol,
    weightBps: target.weightBps,
  }));

  const report = plan.report;
  const drift: StatusDrift | null =
    report === null
      ? null
      : {
          grossDriftBps: report.grossDriftBps,
          maxAbsDeltaBps: report.maxAbsDeltaBps,
          needsRebalance: report.needsRebalance,
          thresholdBps: report.thresholdBps,
          assets: report.assets.map((row) => ({
            asset: row.asset,
            symbol: symbolFor(row.asset),
            targetBps: row.targetBps,
            currentBps: row.currentBps,
            deltaBps: row.deltaBps,
            usdValueE8: row.usdValueE8.toString(),
          })),
        };

  // 唯讀的附加資訊：讀不到也只記進 `sessionKey.error`，不讓一份算得出來的狀態變成 503。
  const sessionKey = await resolveStatusSessionKey(plan.portfolioId, plan.account, deps);

  return {
    portfolioId: plan.portfolioId,
    block: plan.snapshot.block.toString(),
    account: plan.account,
    holdings,
    unpriced,
    totalUsdE8: report === null ? null : report.totalUsdE8.toString(),
    targets,
    drift,
    blocked: plan.blocked.map((block) => ({ code: block.code, detail: block.detail })),
    complete: report !== null && plan.blocked.length === 0,
    sessionKey,
  };
}

/**
 * 建一個帶 TTL 快取的狀態讀取器。`server.ts` 在建 server 時建**一個**，所以快取跨請求存活。
 *
 * 擁有者檢查在快取**之前**：快取以 portfolioId 為 key，先查快取等於讓錢包 B 讀到錢包 A 算好的狀態。
 */
export function createPortfolioStatusReader(deps: StatusDeps = {}): PortfolioStatusReader {
  const find = deps.requireOwnedPortfolio ?? requireOwnedPortfolio;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((line: string) => console.log(line));
  const cache = new Map<number, { expiresAt: number; value: Promise<PortfolioStatus> }>();

  return async (portfolioId: number, wallet: string): Promise<PortfolioStatus> => {
    await find(portfolioId, wallet);

    const at = now();
    const hit = cache.get(portfolioId);
    if (hit !== undefined && hit.expiresAt > at) return hit.value;

    const entry: { expiresAt: number; value: Promise<PortfolioStatus> } = {
      // 先填「現在 + TTL」只是為了讓同時進來的第二個請求拿到同一個 promise；算完之後會用
      // **算完的時間**重算到期時間（見下面）。TTL 從「開始算」起算的話，一份要 8 秒的狀態在
      // 10 秒 TTL 下幾乎立刻失效，快取就等於不存在。
      expiresAt: at + STATUS_CACHE_TTL_MS,
      value: statusOf(portfolioId, deps),
    };
    cache.set(portfolioId, entry);
    if (cache.size > STATUS_CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }

    void entry.value.then(
      () => {
        if (cache.get(portfolioId) === entry) entry.expiresAt = now() + STATUS_CACHE_TTL_MS;
      },
      (error: unknown) => {
        // 失敗**不進快取**：RPC 掛掉的那 10 秒不該被鎖死，使用者按「重試」就該真的重試一次。
        if (cache.get(portfolioId) === entry) cache.delete(portfolioId);
        log(
          JSON.stringify({
            level: 'warn',
            msg: 'portfolio status failed (not cached)',
            portfolioId,
            error: oneLine(error),
          }),
        );
      },
    );

    return entry.value;
  };
}

// ---------------------------------------------------------------------------
// POST /portfolios/:id/rebalance
// ---------------------------------------------------------------------------

/** 開啟 operator rebalance 的環境變數。 */
export const OPERATOR_REBALANCE_ENV = 'ENABLE_OPERATOR_REBALANCE';

/**
 * 這個部署是否允許「用一支 POST 讓伺服器動錢」。
 *
 * 只認字面值 `true`：`1`、`yes`、`TRUE `（尾端空白）一律當成**關閉**。這是一個會動錢的開關，
 * fail closed 比「猜使用者的意思」重要得多。
 */
export function operatorRebalanceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[OPERATOR_REBALANCE_ENV] === 'true';
}

/**
 * 三層判定之後的結果。`outcome` 的語意與排程器一致（見 `scheduler.ts` 的 `PortfolioOutcome`），
 * 唯一差別是把排程器收在一起的 `failed` 拆成兩種：
 *   reverted  上鏈了、gas 花了、三層沒有全過
 *   failed    根本沒送出去（沒有證據說它上鏈了）
 * 對按按鈕的人來說這兩件事的後果完全不同（一個花錢、一個沒有），所以不能合併。
 */
export type OperatorRebalanceOutcome = 'executed' | 'noop' | 'blocked' | 'reverted' | 'failed';

export type OperatorRebalanceResult = {
  portfolioId: number;
  outcome: OperatorRebalanceOutcome;
  /** 排程器寫的那一句話（含哪一層沒過、為什麼 blocked）。原文照回，不改寫成「失敗」。 */
  reason: string;
  txHash: string | null;
  userOpHash: string | null;
  /** 這筆 receipt 裡 executor 發出的 `SwapExecuted` 筆數。null = 有 tx 但讀不到 receipt。 */
  swapExecuted: number | null;
  /** 這一輪規劃了幾個 step（＝應該有幾筆 `SwapExecuted`）。 */
  expectedSwaps: number;
  gasUsed: string | null;
  /** 真的被規劃出來（且送出）的參數；blocked/noop 時是空的。 */
  steps: { tokenIn: string; tokenOut: string; amountIn: string; amountOutMin: string }[];
};

export type RebalanceDeps = {
  requireOwnedPortfolio?: typeof requireOwnedPortfolio;
  runSchedulerOnce?: typeof runSchedulerOnce;
  /** 排程器認領用的 transaction runner（測試注入記憶體 stub）。 */
  withTransaction?: WithTransactionFn;
  publicClient?: PublicClient;
  /** 讀 `SwapExecuted` 時要認的 emitter；省略 = `EXECUTOR_ADDRESS`。 */
  executor?: Address | null;
  log?: (line: string) => void;
};

/** 排程器的認領查詢裡，三個必須看得到的片段（少一個就代表 SQL 換了形狀 → 直接放棄）。 */
const CLAIM_LOCK_MARKER = 'for update of p skip locked';
const ACTIVE_PREDICATE = "where p.schedule_state = 'active'";
const DUE_PREDICATE = 'and (p.next_run_at is null or p.next_run_at <= $1)';

/**
 * 把排程器的認領查詢從「所有到期的 portfolio」縮成「只有這一個」。
 *
 * 為什麼要改寫：`runSchedulerOnce` 只認領**到期**的（`schedule_state = 'active'` 且
 * `next_run_at <= now`）。操作員按鈕的語意是「現在就跑」，與排程時鐘無關，所以：
 *   * **拿掉** `next_run_at` 的到期條件 —— 不然按了也可能什麼都不做（該投組明天才到期）。
 *   * **留著** `schedule_state = 'active'` —— 暫停的投組不該被手動觸發。
 *   * 加上 `p.id = $4`（portfolio id 當第四個參數）—— 這是「只動這一個」的唯一保證。
 *
 * 為什麼是改寫 SQL 而不是自己重寫一次決策流程：排程器的 live 路徑（前置檢查 a/a2/b/c → operations
 * 閘門 → 送出 → 三層判定 → 落 DB → 推進 next_run_at）是唯一被驗證過的那一份，重寫一份等於多一份
 * 會分岔的實作。這裡只動 SELECT 的 WHERE；認領與推進仍然在**同一個 transaction** 裡由排程器自己完成。
 *
 * 認不出這段 SQL（上游改了形狀）→ **拋錯中止**。最壞的失敗是「安靜地認領了全部到期的投組」，
 * 那會一次動到所有人的錢，所以寧可整輪什麼都不做。
 */
export function narrowClaimToPortfolio(text: string, portfolioId: number): string {
  if (!text.includes(CLAIM_LOCK_MARKER)) return text;
  if (!text.includes(ACTIVE_PREDICATE) || !text.includes(DUE_PREDICATE)) {
    throw new Error(
      'scheduler 的認領 SQL 換了形狀（找不到 schedule_state / next_run_at 條件）：' +
        'operator rebalance 沒辦法安全地把認領範圍縮成單一 portfolio，這一輪已中止，沒有送出任何交易',
    );
  }
  // `$1`（now）在縮減後已經沒有語意，但**不能讓它變成孤兒參數**：pg 的 extended protocol 要從 SQL
  // 推斷每個 $n 的型別，陣列裡有、SQL 裡沒有的參數會直接 `could not determine data type of parameter $1`。
  // `$1::timestamptz is not null` 恆為真（呼叫端一定傳 Date），效果就是「忽略到期時間」。
  return text.replace(DUE_PREDICATE, 'and ($1::timestamptz is not null) and p.id = $4');
}

const defaultTransaction: WithTransactionFn = (fn) =>
  withTransaction((client) =>
    fn({ query: (text, params) => client.query(text, params === undefined ? [] : [...params]) }),
  );

/**
 * 認領用的 transaction runner：只把**認領查詢**換成「這一個 portfolio」，其餘 SQL（推進
 * `next_run_at`、`last_checked_at`、`operations` 的每一次寫入）原樣放行。
 */
export function singlePortfolioClaim(
  portfolioId: number,
  inner?: WithTransactionFn,
): WithTransactionFn {
  const run = inner ?? defaultTransaction;
  return (fn) =>
    run((client) =>
      fn({
        query: (text, params) => {
          const narrowed = narrowClaimToPortfolio(text, portfolioId);
          return client.query(narrowed, narrowed === text ? params : [...(params ?? []), portfolioId]);
        },
      }),
    );
}

function defaultPublicClient(): PublicClient {
  const { rpcUrl } = getConfig();
  if (!rpcUrl) {
    throw new Error('chain 未設定：RPC_URL 是讀 receipt 的必要條件');
  }
  return createPublicClient({ chain: bsc, transport: http(rpcUrl) });
}

function operatorOutcome(result: PortfolioRunResult): OperatorRebalanceOutcome {
  switch (result.outcome) {
    case 'executed':
      return 'executed';
    case 'noop':
      return 'noop';
    case 'blocked':
      return 'blocked';
    case 'failed':
      return result.execution?.status === 'reverted' ? 'reverted' : 'failed';
    case 'ready-dry-run':
      // 不可能：呼叫端明確傳 `dryRun: false`。真的出現就是有人改了契約，不要把它講成 noop。
      throw new AppError(
        500,
        'UNEXPECTED_DRY_RUN',
        '排程器回了 ready-dry-run，但 operator rebalance 明確要求 live：拒絕回一個看起來像「算過但沒動」的結果',
      );
  }
}

/**
 * 這筆送出到底換了幾筆。
 *
 * `ExecutionOutcome` 沒有帶 `SwapExecuted` 筆數（它在 `judgeRebalanceOutcome` 裡只用完就丟），所以
 * 有 txHash 時**重讀**一份 receipt 再數一次——只讀，不再送任何東西。數不出來就回 null，
 * 不回 0：0 會被讀成「數過，真的 0 筆」。
 */
async function swapExecutedFor(
  deps: RebalanceDeps,
  execution: ExecutionOutcome | null,
): Promise<number | null> {
  const txHash = execution?.txHash ?? null;
  // 沒有 txHash ＝ 這一輪根本沒有送出（blocked / noop / 送出失敗），換了 0 筆是事實，不是「不知道」。
  if (txHash === null) return 0;

  const executor = deps.executor ?? getSessionKeyConfig().executorAddress;
  if (executor === null) return null;

  try {
    const client = deps.publicClient ?? defaultPublicClient();
    const receipt = await client.getTransactionReceipt({ hash: txHash as Hex });
    return countSwapExecuted(receipt.logs, executor);
  } catch {
    return null;
  }
}

/**
 * 對**單一** portfolio 跑一次 live 再平衡。
 *
 * 一定會先做擁有者檢查（與 `renewal-params` 同一條 `requireOwnedPortfolio`）：這支會動錢，
 * 所以「這是你的投組嗎」不能靠呼叫端自律。
 *
 * `ENABLE_OPERATOR_REBALANCE` 的檢查**不在這裡**，在 `server.ts` 的路由上：它是部署層的開關，
 * 與「這個 portfolio 是誰的」無關，應該在碰 DB 之前就擋掉（見 server.ts 的
 * `operatorRebalanceRoute`）。
 */
export async function runOperatorRebalance(
  portfolioId: number,
  wallet: string,
  deps: RebalanceDeps = {},
): Promise<OperatorRebalanceResult> {
  const find = deps.requireOwnedPortfolio ?? requireOwnedPortfolio;
  await find(portfolioId, wallet);

  const run = deps.runSchedulerOnce ?? runSchedulerOnce;
  const round = await run(
    // `dryRun: false` 是這支端點存在的理由，所以逐字寫出來（排程器的預設是 dry-run）。
    { dryRun: false, limit: 1 },
    {
      withTransaction: singlePortfolioClaim(portfolioId, deps.withTransaction),
      ...(deps.log === undefined ? {} : { log: deps.log }),
    },
  );

  const result = round.results[0];
  if (result === undefined || result.portfolioId !== portfolioId) {
    // 認領查詢回了 0 列：`schedule_state` 不是 active，或這個 chain 上沒有 smart account。
    // 這一輪一個 portfolio 都沒動（不是「跑過了失敗」），所以要說清楚是被什麼擋在門外。
    return {
      portfolioId,
      outcome: 'blocked',
      reason:
        `排程器沒有認領 portfolio ${portfolioId}：schedule_state 不是 'active'，或這個 chain 上沒有它的 smart account。` +
        '這一輪沒有送出任何東西',
      txHash: null,
      userOpHash: null,
      swapExecuted: 0,
      expectedSwaps: 0,
      gasUsed: null,
      steps: [],
    };
  }

  const outcome = operatorOutcome(result);
  const execution = result.execution;
  return {
    portfolioId,
    outcome,
    reason: result.reason,
    txHash: execution?.txHash ?? null,
    userOpHash: execution?.userOpHash ?? null,
    swapExecuted: await swapExecutedFor(deps, execution),
    expectedSwaps: result.plan?.steps.length ?? 0,
    gasUsed: execution?.gasUsed ?? null,
    steps: (result.plan?.steps ?? []).map((step) => ({
      tokenIn: step.tokenIn,
      tokenOut: step.tokenOut,
      amountIn: step.amountIn,
      amountOutMin: step.amountOutMin,
    })),
  };
}
