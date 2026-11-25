import { assetsMarketOpen } from './trading-calendar.js';
import { MAX_USER_OP_STEPS } from './execution-batch.js';
import { MIN_BATCH_USDT } from './strategy-execution.js';
import { configuredChainId, TESTNET_97, testnetAssets } from './testnet-profile.js';
import { cancelJob, lockCash, readJob, unresolvedSql } from './strategy-jobs.js';
import { OWNER_DEX_WAIT_MS, withDexLock } from './dex-queue.js';
import type { AggregatorQuoter } from './aggregator.js';
/**
 * 操作員的兩支端點實作：`GET /portfolios/:id/status` 與 `POST /portfolios/:id/rebalance`。
 *
 * 兩件事放同一個檔案，因為它們是同一段流程的兩半（先看見狀態 → 再決定要不要動錢），而且都只服務
 * 操作員：一支**很貴**（`planPortfolio` 會掃日誌、讀多個池、定價），一支**會動鏈上的錢**。
 * `server.ts` 只負責路由、認證與 HTTP 形狀。
 */

import { createPublicClient, http } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { activeChain } from './chain-object.js';

import { getConfig, getSessionKeyConfig } from './config.js';
import { query as dbQuery, withTransaction } from './db.js';
import { AppError, errorChain } from './errors.js';
import { requireOwnedPortfolio } from './portfolios.js';
import { describeGasStatus } from './funding.js';
import { listOpenAlerts } from './alerts.js';
import { readSchedulerStatus } from './scheduler-status.js';
import type { SchedulerStatus } from './scheduler-status.js';
import type { GasStatus } from './funding.js';
import { getAccountGasBalance, getGasPriceWei, pauseSources, REGISTRY_ABI, decodePriceSourceError, describePriceSourceError } from './chain.js';
import type { PauseSource } from './chain.js';
import { getGasConfig } from './config.js';
import { countSwapExecuted, PARTIAL_FOLLOW_UP_SECONDS, runSchedulerOnce, SCHEDULER_ACTIVE_PREDICATE, SCHEDULER_LEGACY_ACTIVE_PREDICATE } from './scheduler.js';
import type { ExecutionOutcome, PortfolioRunResult, WithTransactionFn } from './scheduler.js';
import { planPortfolio } from './snapshot.js';
import { RESUME_PAUSED_SQL } from './sell-all-resume.js';
import { buildRoutedStep, capAssetLeg, DEFAULT_DEADLINE_SECONDS, minGrossFor, nominalSellQuote, numeraireDecimals, readMaxLegUsdE8 } from './rebalance-plan.js';
import type { PlannedStep, RebalancePlan } from './rebalance-plan.js';
import type { RebalancePlanningInput } from './scheduler.js';
import type { PortfolioPlan, QueryFn } from './snapshot.js';
import { rpcBatch, rpcTransport } from './rpc-transport.js';

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

/**
 * 一份狀態最多算多久。逾時 → 503 `STATUS_TIMEOUT`，而且這份計算的 RPC 讀取全部中止（之後的請求立刻失敗），
 * 不會在背景繼續打 RPC。overview 的背景刷新共用 3 個名額：沒有上限時，3 份卡住的狀態就讓所有人永遠 pending。
 */
export const STATUS_TIMEOUT_MS = 30_000;
/** 狀態用的 RPC client：單次請求逾時與重試次數（viem 預設 10 秒 × 4 次，還會照 Retry-After 等）。 */
export const STATUS_RPC_TIMEOUT_MS = 8_000;
export const STATUS_RPC_RETRY_COUNT = 1;

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
  /** Buying only: independent of valuation completeness, registry pause flags and exits. */
  buyingPaused: { reason: 'NEW_VERSION_ACTIVE'; joinedVersion: number; activeVersion: number } | null;
  /** Registry pause sources at `block`: Safe=1, operator=2, account=4. null means unreadable. */
  pauseFlags: number | null;
  pauseSources: PauseSource[] | null;
  /**
   * executor 位址 —— app 要靠它組 `approve(spender = executor)`。
   *
   * 為什麼放在 status 而不是另一個端點：approve 是「這個投組能不能動」的一部分，
   * 而 app 已經在讀 status 了；多一支端點只是多一次 round-trip 與一個要同步的欄位。
   *
   * `null` = 這個部署沒有設 `EXECUTOR_ADDRESS`（那就連 session key 都裝不起來）—— app 要顯示
   * 「不知道 spender」而不是自己猜一個位址去 approve。
   */
  executorAddress: string | null;
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
  /**
   * 這個帳戶的 gas 狀態（原生 BNB）。
   *
   * 為什麼放在 status：**gas 是每個帳戶自己付的**（ERC-4337 的 sender 模型），而一個帳戶 = 一個
   * 「owner + 策略」組合。所以「這檔基金還能不能動」= 「它自己還有沒有 BNB」，跟別的投組無關。
   * `null` = 查不到（RPC 掛），不是「餘額 0」—— 使用者要能分辨這兩件事。
   */
  gas: GasStatus | null;
};

export type StatusDeps = {
  readPauseFlags?: (account: Address, blockNumber: bigint) => Promise<number>;
  planPortfolio?: (portfolioId: number) => Promise<PortfolioPlan>;
  requireOwnedPortfolio?: typeof requireOwnedPortfolio;
  query?: QueryFn;
  /** 讀 `permissionConfig` 用；省略 = 由 `RPC_URL` 自己建一個。 */
  publicClient?: PublicClient;
  /** 毫秒時鐘；測試注入假時鐘就能驗 TTL。 */
  now?: () => number;
  /** executor 位址（app 組 approve 用）；省略 = `EXECUTOR_ADDRESS`。 */
  executor?: Address;
  /** 讀帳戶的原生幣餘額；省略 = `getAccountGasBalance`。 */
  accountGasBalance?: (address: Address) => Promise<bigint>;
  /** 讀 gas price；省略 = `getGasPriceWei`。 */
  gasPrice?: () => Promise<bigint>;
  /** `gas.ready` 的門檻；省略 = `MIN_SESSION_GAS_WEI`。 */
  minGasWei?: bigint;
  log?: (line: string) => void;
  /** 單份狀態計算的上限（毫秒）；省略 = `STATUS_TIMEOUT_MS`。 */
  timeoutMs?: number;
};

export type PortfolioStatusReader = (portfolioId: number, wallet: string) => Promise<PortfolioStatus>;

const SQL_SYMBOLS = 'select address, symbol from priceable_assets where enabled';

/** `0xAbC…` → `0xabc…`：DB 與鏈上的地址大小寫不一致，比對一律用小寫。 */
function assetKey(asset: string): string {
  return asset.toLowerCase();
}

/** 一行、有限長度、保留原文的錯誤訊息（多行 stack 進 JSON body 沒有幫助，反而蓋掉真正的原因）。 */
function oneLine(error: unknown): string {
  const message = decodePriceSourceError(error)?.detail ?? (error instanceof Error ? error.message : String(error));
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
  const result = { rows: (deps.publicClient?.chain?.id ?? configuredChainId()) === 97 ? testnetAssets() : (await query(SQL_SYMBOLS)).rows };
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

/**
 * 一支 session key 在 DB 裡記的樣子（不含「鏈上裝了沒」）。
 *
 * `expiresAt` 是**唯一有時效性、使用者能行動的資訊**：key 一過期，這個投組每一輪都會 blocked
 * 而且不會自己好（要靠 owner 簽一筆續期）。原本這份型別只有 permissionId 與 keyRef ——
 * 也就是「使用者看不懂的內部 id」有，而「他該注意的到期日」沒有。
 */
export type StatusSessionKeyRef = {
  permissionId: string;
  keyRef: string;
  /** ISO 時間。`null` = DB 那一列沒有可解析的到期日。 */
  expiresAt: string | null;
  /** DB 的 status（`active` / 其他）。 */
  status: string | null;
};

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
  const ms = expiryMs(row);
  return {
    permissionId,
    keyRef: row.key_ref,
    expiresAt: ms === 0 ? null : new Date(ms).toISOString(),
    status: typeof row.status === 'string' ? row.status : null,
  };
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
async function statusOf(portfolioId: number, deps: StatusDeps, joinedVersion: number): Promise<PortfolioStatus> {
  const controller = new AbortController();
  const timeoutMs = deps.timeoutMs ?? STATUS_TIMEOUT_MS;
  // 這份計算專用的 client：逾時就 abort，被放棄的計算不會繼續占用共用的 RPC 額度。
  const publicClient = deps.publicClient ?? statusClient(controller.signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      computeStatus(portfolioId, publicClient === undefined ? deps : { ...deps, publicClient }, joinedVersion),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error('status timeout'));
          reject(new AppError(503, 'STATUS_TIMEOUT',
            `Status of portfolio ${portfolioId} did not finish within ${timeoutMs} ms; its chain reads were abandoned.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 有 `RPC_URL` 才建（沒有的話讓各讀取照舊走自己的預設、照舊報錯）。 */
function statusClient(signal: AbortSignal): PublicClient | undefined {
  let rpcUrl: string | null | undefined;
  try { rpcUrl = getConfig().rpcUrl; } catch { return undefined; }
  if (!rpcUrl) return undefined;
  return statusRpcClient(rpcUrl, signal);
}

/** Bounded per request (8 s, 1 retry); once `signal` aborts every in-flight and later request fails at once. */
export function statusRpcClient(rpcUrl: string, signal: AbortSignal): PublicClient {
  return createPublicClient({ chain: activeChain(), ...rpcBatch(rpcUrl), transport: rpcTransport('operator', rpcUrl, {
    timeout: STATUS_RPC_TIMEOUT_MS, retryCount: STATUS_RPC_RETRY_COUNT, fetchOptions: { signal } }) });
}

async function computeStatus(portfolioId: number, deps: StatusDeps, joinedVersion: number): Promise<PortfolioStatus> {
  // 狀態只顯示：生息讀不到降級成 YIELD_VALUATION_UNAVAILABLE（#222）；observeOnly 不掃日誌、不同步組合現金流、
  // 不寫 DB、不拿鎖（排程器拿著鎖時狀態不會等它）。會交易的呼叫端照舊 fail closed、照舊推進游標。
  const planFn = deps.planPortfolio ?? ((id: number) => planPortfolio(id, {
    ...(deps.publicClient === undefined ? {} : { publicClient: deps.publicClient }), yieldOptional: true, observeOnly: true }));

  let plan: PortfolioPlan;
  try {
    plan = await planFn(portfolioId);
  } catch (error) {
    throw new AppError(
      503,
      'STATUS_UNAVAILABLE',
      `Cannot compute the status of portfolio ${portfolioId}: the planner failed (usually the RPC is down, the ` +
        `anvil fork has expired, or the database is inconsistent). Underlying error: ${oneLine(error)}`,
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
  let flags: number | null = null;
  let sources: PauseSource[] | null = null;
  try {
    const readFlags = deps.readPauseFlags ?? (async (account: Address, blockNumber: bigint) => {
      const registry = getConfig().registryAddress;
      if (registry === null) throw new Error('REGISTRY_ADDRESS 未設定');
      return (deps.publicClient ?? defaultPublicClient()).readContract({
        address: registry as Address, abi: REGISTRY_ABI, functionName: 'pauseFlags', args: [account], blockNumber,
      });
    });
    const observed = await readFlags(plan.account, plan.snapshot.block);
    sources = pauseSources(observed);
    flags = observed;
  } catch {
    // Do not report zero when a missing ABI, RPC timeout or unknown flag makes the sources unknown.
  }
  const executor = deps.executor ?? getSessionKeyConfig().executorAddress ?? null;
  // gas 讀不到（RPC 掛）不該讓整份狀態變 503：留 null，前端顯示「未知」。
  const gas = await (async () => {
    try {
      const client = deps.publicClient;
      const readBalance = deps.accountGasBalance ?? (client === undefined ? getAccountGasBalance : (address: Address) => client.getBalance({ address }));
      const readPrice = deps.gasPrice ?? (client === undefined ? getGasPriceWei : () => client.getGasPrice());
      const minimumWei = deps.minGasWei ?? getGasConfig().minSessionGasWei;
      const [balanceWei, gasPriceWei] = await Promise.all([readBalance(plan.account), readPrice()]);
      return describeGasStatus({ address: plan.account, balanceWei, minimumWei, gasPriceWei });
    } catch {
      return null;
    }
  })();

  return {
    portfolioId: plan.portfolioId,
    buyingPaused: joinedVersion !== plan.pinnedVersion.version
      ? { reason: 'NEW_VERSION_ACTIVE', joinedVersion, activeVersion: plan.pinnedVersion.version } : null,
    pauseFlags: flags,
    pauseSources: sources,
    executorAddress: executor,
    block: plan.snapshot.block.toString(),
    account: plan.account,
    holdings,
    unpriced,
    totalUsdE8: plan.snapshot.accountValueRaw===undefined?(report===null?null:report.totalUsdE8.toString()):plan.snapshot.accountValueRaw===null?null:(plan.snapshot.accountValueRaw/10000000000n).toString(),
    targets,
    drift,
    blocked: plan.blocked.map((block) => ({ code: block.code, detail: block.detail })),
    complete: report !== null && plan.blocked.length === 0,
    sessionKey,
    gas,
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
    const owned = await find(portfolioId, wallet);

    const at = now();
    const hit = cache.get(portfolioId);
    if (hit !== undefined && hit.expiresAt > at) return hit.value;

    const entry: { expiresAt: number; value: Promise<PortfolioStatus> } = {
      // 先填「現在 + TTL」只是為了讓同時進來的第二個請求拿到同一個 promise；算完之後會用
      // **算完的時間**重算到期時間（見下面）。TTL 從「開始算」起算的話，一份要 8 秒的狀態在
      // 10 秒 TTL 下幾乎立刻失效，快取就等於不存在。
      expiresAt: at + STATUS_CACHE_TTL_MS,
      value: statusOf(portfolioId, deps, owned.version),
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
            code: error instanceof AppError ? error.code : null,
            error: oneLine(error),
            cause: errorChain(error),
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
  /** 規劃器的完整 rationale（含「為什麼某一檔沒被買」）。null = 這一輪沒有規劃。 */
  rationale?: string | null;
  /** 真的被規劃出來（且送出）的參數；blocked/noop 時是空的。 */
  steps: { tokenIn: string; tokenOut: string; amountIn: string; amountOutMin: string; venue: string }[];
};

/** `GET /portfolios/:id/plan` 的回應：這一輪**會做什麼、不會做什麼，以及為什麼**。 */
export type OperatorPlanPreview = {
  portfolioId: number;
  /** dry-run 的結論：`ready` = 現在按下去會送交易；`noop` = 不需要動；`blocked` = 被前置檢查擋下。 */
  outcome: 'ready' | 'noop' | 'blocked';
  /** 排程器寫的那一句話，**原文照回**。這是這支端點存在的全部理由。 */
  reason: string;
  /** 這一輪會送的 step（`ready` 才有）。前端不該自己猜，規劃在後端。 */
  steps: { tokenIn: string; tokenOut: string; amountIn: string; amountOutMin: string; venue: string }[];
  /**
   * 規劃器的完整 rationale（含「為什麼某一檔沒被買」）。
   *
   * 為什麼一定要回：`reason` 只是一句話的結論（例如「Would execute 4 step(s)」），
   * 而「5 檔目標卻只有 4 步」的原因（被跳過的腿、預算、衝擊上限）全在 rationale 裡。
   * 沒有它，營運端只能猜 —— 實測就是這樣花了很久才發現「USDT 預算被算成 0.004」。
   */
  rationale?: string | null;
};

export type RebalanceDeps = {
  now?: () => Date;
  /** Only the owner route opts into restoring a portfolio paused by an exit. */
  resumeIfPaused?: boolean;
  quoteAggregator?: AggregatorQuoter;
  query?: QueryFn;
  requireOwnedPortfolio?: typeof requireOwnedPortfolio;
  runSchedulerOnce?: typeof runSchedulerOnce;
  /** 排程器認領用的 transaction runner（測試注入記憶體 stub）。 */
  withTransaction?: WithTransactionFn;
  publicClient?: PublicClient;
  /** 讀 `SwapExecuted` 時要認的 emitter；省略 = `EXECUTOR_ADDRESS`。 */
  executor?: Address | null;
  registry?: Address;
  log?: (line: string) => void;
  /** Sell all releases a running buy job first (default: on in production, off when tests inject DB stubs). */
  releaseRunningBuy?: ((portfolioId: number) => Promise<void>) | null;
};

/**
 * Sell all (close): a running buy job would keep its reserved cash, so the owner could not withdraw everything,
 * or (before the paymaster free-cash check) took it and left the portfolio stuck in [CASH_DEFICIT] (portfolio 12,
 * 2026-11-23). Cancel it first: cancelJob returns the unspent reservation to the absorbable funding bucket. Skipped
 * when an operation is unresolved or the job's outcome is unknown; the free-cash clamp still protects the cash then.
 */
export async function releaseRunningBuy(portfolioId: number): Promise<void> {
  const chainId = configuredChainId();
  await withTransaction(async (client) => {
    const run = (sql: string, params?: readonly unknown[]) => client.query(sql, params ? [...params] : []);
    const c = { chainId, portfolioId };
    await lockCash(run, c);
    if ((await run(`select id from operations where portfolio_id=$1 and ${unresolvedSql} limit 1`, [portfolioId])).rows.length) return;
    const job = await readJob(run, c);
    if (job && job.state !== 'unknown') await cancelJob(run, c, job);
  });
}

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
 *   * 一般操作留著 `schedule_state = 'active'`；只有 close 允許 DB paused 繼續退出。
 *   * 加上 `p.id = $4`（portfolio id 當第四個參數）—— 這是「只動這一個」的唯一保證。
 *
 * 為什麼是改寫 SQL 而不是自己重寫一次決策流程：排程器的 live 路徑（前置檢查 a/a2/b/c → operations
 * 閘門 → 送出 → 三層判定 → 落 DB → 推進 next_run_at）是唯一被驗證過的那一份，重寫一份等於多一份
 * 會分岔的實作。這裡只動 SELECT 的 WHERE；認領與推進仍然在**同一個 transaction** 裡由排程器自己完成。
 *
 * 認不出這段 SQL（上游改了形狀）→ **拋錯中止**。最壞的失敗是「安靜地認領了全部到期的投組」，
 * 那會一次動到所有人的錢，所以寧可整輪什麼都不做。
 */
export function narrowClaimToPortfolio(text: string, portfolioId: number, allowPaused = false): string {
  if (!text.includes(CLAIM_LOCK_MARKER)) return text;
  if(text.includes(SCHEDULER_ACTIVE_PREDICATE))text=text.replace(SCHEDULER_ACTIVE_PREDICATE,ACTIVE_PREDICATE);
  if(text.includes(SCHEDULER_LEGACY_ACTIVE_PREDICATE))text=text.replace(SCHEDULER_LEGACY_ACTIVE_PREDICATE,ACTIVE_PREDICATE);
  if (!text.includes(ACTIVE_PREDICATE) || !text.includes(DUE_PREDICATE)) {
    throw new Error(
      'scheduler 的認領 SQL 換了形狀（找不到 schedule_state / next_run_at 條件）：' +
        'operator rebalance 沒辦法安全地把認領範圍縮成單一 portfolio，這一輪已中止，沒有送出任何交易',
    );
  }
  // `$1`（now）在縮減後已經沒有語意，但**不能讓它變成孤兒參數**：pg 的 extended protocol 要從 SQL
  // 推斷每個 $n 的型別，陣列裡有、SQL 裡沒有的參數會直接 `could not determine data type of parameter $1`。
  // `$1::timestamptz is not null` 恆為真（呼叫端一定傳 Date），效果就是「忽略到期時間」。
  const narrowed = text.replace(DUE_PREDICATE, 'and ($1::timestamptz is not null) and p.id = $4');
  return allowPaused ? narrowed.replace(ACTIVE_PREDICATE, "where p.schedule_state in ('active', 'paused')") : narrowed;
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
  options: { allowPaused?: boolean; preserveNextRunAt?: boolean } = {},
): WithTransactionFn {
  const run = inner ?? defaultTransaction;
  return (fn) =>
    run((client) =>
      fn({
        query: (text, params) => {
          const narrowed = narrowClaimToPortfolio(text, portfolioId, options.allowPaused);
          const sql = options.preserveNextRunAt ? narrowed.replace('set next_run_at = claimed.next_run_at', 'set next_run_at = greatest(p.next_run_at, claimed.next_run_at)') : narrowed;
          return client.query(sql, narrowed === text ? params : [...(params ?? []), portfolioId]);
        },
      }),
    );
}

function defaultPublicClient(): PublicClient {
  const { rpcUrl } = getConfig();
  if (!rpcUrl) {
    throw new Error('chain 未設定：RPC_URL 是讀 receipt 的必要條件');
  }
  return createPublicClient({ chain: activeChain(), ...rpcBatch(rpcUrl), transport: rpcTransport('operator', rpcUrl) });
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

  const executor = deps.executor ?? getSessionKeyConfig().executorAddress ?? null;
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

  // 使用者主動要求跑一輪 = 「請幫我管理這個投組」→ 若之前因為清倉被暫停，這裡接回來。
  // 排程器只認領 `schedule_state = 'active'`，不接回來的話「入金後再也不會自動再平衡」。
  // 只在使用者端（owner）做：營運端的 Run round 不該改變使用者設定的排程狀態。
  if (deps.resumeIfPaused === true) {
    await (deps.query ?? dbQuery)(RESUME_PAUSED_SQL, [
      portfolioId,
    ]);
  }

  const run = deps.runSchedulerOnce ?? runSchedulerOnce;
  const round = await run(
    // `dryRun: false` 是這支端點存在的理由，所以逐字寫出來（排程器的預設是 dry-run）。
    { dryRun: false, limit: 1, skipAlerts: true },
    {
      withTransaction: singlePortfolioClaim(portfolioId, deps.withTransaction),
      // The owner's own round waits for the shared DEX lane (src/dex-queue.ts) instead of failing at once.
      ...(deps.withTransaction === undefined ? { withDexLock: <T>(chainId: number, fn: () => Promise<T>) => withDexLock(chainId, fn, { waitMs: OWNER_DEX_WAIT_MS }) } : {}),
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
      rationale: null,
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
      venue: step.venue,
    })),
    rationale: result.plan?.rationale ?? null,
  };
}

/**
 * `GET /portfolios/:id/plan` —— 跑一次 **dry-run**，回報這一輪會做什麼、不會做什麼、以及為什麼。
 *
 * 為什麼需要它：使用者按「執行」之前，唯一能看到「這一輪不會動」的地方是**按下之後**的結果卡。
 * 實測的形狀是「漂移 595 bps、但預估漂移不會下降 → 不送」，那不是錯誤，卻要按一次才知道 ——
 * 而按下去本身有成本（一輪規劃要讀鏈、估價、算 impact）。
 *
 * 為什麼**不**被 `ENABLE_OPERATOR_REBALANCE` 擋：它唯讀（dry-run 不寫 operations、不推進
 * `next_run_at`、不送交易），而且生產環境正是「開關關著、排程器自己在跑」——
 * 那時使用者最需要知道的就是「為什麼我的投組停住了」。把唯讀診斷綁在動錢的開關上會讓它失去用途。
 *
 * 走的是**排程器同一條路**（`runSchedulerOnce({ dryRun: true })` 且只認領這一個 portfolio），
 * 不是另寫一份規劃。兩份實作會在第一次改動時分岔，而分岔的後果是「預覽說會動、真的按下去不動」。
 */
export async function previewOperatorRebalance(
  portfolioId: number,
  wallet: string,
  deps: RebalanceDeps = {},
): Promise<OperatorPlanPreview> {
  const find = deps.requireOwnedPortfolio ?? requireOwnedPortfolio;
  await find(portfolioId, wallet);

  const run = deps.runSchedulerOnce ?? runSchedulerOnce;
  const round = await run(
    // `dryRun: true` 逐字寫出來：這支端點**不會**動錢，而排程器的預設也是 dry-run（不靠預設值表達意圖）。
    { dryRun: true, limit: 1, skipAlerts: true },
    {
      withTransaction: singlePortfolioClaim(portfolioId, deps.withTransaction),
      // The owner's own round waits for the shared DEX lane (src/dex-queue.ts) instead of failing at once.
      ...(deps.withTransaction === undefined ? { withDexLock: <T>(chainId: number, fn: () => Promise<T>) => withDexLock(chainId, fn, { waitMs: OWNER_DEX_WAIT_MS }) } : {}),
      ...(deps.log === undefined ? {} : { log: deps.log }),
    },
  );

  const result = round.results[0];
  if (result === undefined || result.portfolioId !== portfolioId) {
    return {
      portfolioId,
      outcome: 'blocked',
      reason:
        `排程器沒有認領 portfolio ${portfolioId}：schedule_state 不是 'active'，或這個 chain 上沒有它的 smart account。`,
      steps: [],
      rationale: null,
    };
  }

  if (result.outcome === 'executed' || result.outcome === 'failed') {
    // dry-run 不可能執行；真的出現就是契約被改動了。不要把它講成 noop —— 那會讓「預覽說沒事、實際送了交易」
    // 變成一個安靜的謊。
    throw new AppError(
      500,
      'PLAN_PREVIEW_CONTRACT',
      `dry-run 回報 ${result.outcome}：排程器的契約被改動了（dry-run 不該執行任何交易）`,
    );
  }

  return {
    portfolioId,
    outcome: result.outcome === 'ready-dry-run' ? 'ready' : result.outcome,
    reason: result.reason,
    steps: (result.plan?.steps ?? []).map((step) => ({
      tokenIn: step.tokenIn,
      tokenOut: step.tokenOut,
      amountIn: step.amountIn,
      amountOutMin: step.amountOutMin,
      venue: step.venue,
    })),
    rationale: result.plan?.rationale ?? null,
  };
}

// ---------------------------------------------------------------------------
// 投組的活動紀錄（原站 portfolio 頁的 Activity 區塊）
// ---------------------------------------------------------------------------

export type PortfolioActivity = {
  id: number;
  state: string;
  txHash: string | null;
  userOpHash: string | null;
  attempts: number;
  createdAt: string;
  /** 那一輪前後的漂移（bps）。`null` = 沒有對應的快照（noop / blocked 不會寫）。 */
  driftBeforeBps: number | null;
  driftAfterBps: number | null;
  /** 前後總值（USD，1e8 定點）。差額就是這一輪的成本。 */
  usdBeforeE8: string | null;
  usdAfterE8: string | null;
};

export type ActivityDeps = {
  requireOwnedPortfolio?: typeof requireOwnedPortfolio;
  query?: typeof dbQuery;
};

type ActivityRow = {
  id: unknown;
  state: unknown;
  tx_hash: unknown;
  user_op_hash: unknown;
  attempts: unknown;
  created_at: unknown;
  drift_before: unknown;
  drift_after: unknown;
  usd_before: unknown;
  usd_after: unknown;
};

/**
 * 這個投組最近的執行紀錄，新到舊。
 *
 * 為什麼把前後快照 join 進來：`operations` 只說「送出去了、成功或失敗」，而那張前後快照表
 * （`phase = before / after`，用 `operation_id` 綁定）才是「這一輪到底做了什麼」。
 * 前端不該為了拼這件事再打三個端點。
 */
export async function listPortfolioActivity(
  portfolioId: number,
  wallet: string,
  deps: ActivityDeps = {},
  limit = 20,
): Promise<PortfolioActivity[]> {
  const owned = deps.requireOwnedPortfolio ?? requireOwnedPortfolio;
  const find = deps.query ?? dbQuery;
  await owned(portfolioId, wallet, undefined);

  const { rows } = await find<ActivityRow>(
    `select o.id, o.state, o.tx_hash, o.user_op_hash, o.attempts, o.created_at,
            b.gross_drift_bps as drift_before, a.gross_drift_bps as drift_after,
            b.total_usd_e8 as usd_before, a.total_usd_e8 as usd_after
       from operations o
       left join portfolio_snapshots b
              on b.portfolio_id = o.portfolio_id and b.operation_id = o.id and b.phase = 'before'
       left join portfolio_snapshots a
              on a.portfolio_id = o.portfolio_id and a.operation_id = o.id and a.phase = 'after'
      where o.portfolio_id = $1
      order by o.id desc
      limit $2`,
    [portfolioId, limit],
  );

  return rows.map((row) => {
    const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
    const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
    return {
      id: Number(row.id),
      state: String(row.state),
      txHash: text(row.tx_hash),
      userOpHash: text(row.user_op_hash),
      attempts: Number(row.attempts),
      createdAt: new Date(row.created_at as string | Date).toISOString(),
      driftBeforeBps: num(row.drift_before),
      driftAfterBps: num(row.drift_after),
      usdBeforeE8: text(row.usd_before),
      usdAfterE8: text(row.usd_after),
    };
  });
}

// ---------------------------------------------------------------------------
// Operator 總覽（rebalance dashboard）
// ---------------------------------------------------------------------------

/**
 * 一排 = 一個投組。刻意**不**逐個呼叫 `portfolioStatus`：那條路徑會掃 Transfer 日誌 + 定價，
 * 實測 2–3 秒／投組，八個投組就是 20 秒以上 —— 儀表板要的是「快速看一眼現在怎麼樣」。
 *
 * 所以這裡讀**已經落地的資料**：最新的 before/after 快照（排程器每輪都寫）、最後一筆 operation、
 * session key 的到期日、next_run_at。只有 gas 是即時讀的（一次 `eth_getBalance`，很便宜）。
 * 代價是「觀測時間」可能是幾分鐘前 —— 所以每一列都帶 `observedAt`，使用者自己看得到新鮮度。
 */
export type OperatorPortfolioRow = {
  id: number;
  strategyId: number;
  strategyName: string | null;
  version: number;
  scheduleState: string;
  account: string | null;
  nextRunAt: string | null;
  lastCheckedAt: string | null;
  /** 最新快照的觀測點。`null` = 從來沒跑過。 */
  observedAt: string | null;
  driftBps: number | null;
  /**
   * 帳戶價值是 0（資金已全部提出，或從來沒入金）。
   *
   * 為什麼要獨立一欄：`drift.ts` 對空倉回 5000 bps 是**公式的結果**（空帳戶「完全不在目標上」），
   * 但把它顯示成「9999 bps / rebalance due」會讓人以為壞了 —— 實際上它只是空。
   * 呼叫端（operator 頁面）應該顯示「Empty」而不是「rebalance due」。
   */
  isEmpty: boolean;
  totalUsdE8: string | null;
  needsRebalance: boolean | null;
  blockedCount: number | null;
  /** 帳戶的原生幣餘額（即時）。`null` = 讀不到。 */
  gasWei: string | null;
  sessionKeyExpiresAt: string | null;
  lastOperation: { id: number; state: string; txHash: string | null; createdAt: string } | null;
};

export type OperatorOverview = {
  generatedAt: string;
  /**
   * 排程器心跳。`null` = 從來沒寫過（沒跑過），不是「死了」。
   *
   * 為什麼不從 `portfolios.last_checked_at` 推算：所有投組都還沒到期時那個時間是舊的，
   * 看起來就像排程器死了 —— 而「死掉」與「沒事做」是兩種完全不同的處置。
   */
  scheduler: SchedulerStatus | null;
  alerts: { critical: number; warn: number; open: number } | null;
  /** 最近一次有投組被檢查的時間 —— 排程器有心跳的最直接證據。 */
  lastCheckedAt: string | null;
  portfolios: OperatorPortfolioRow[];
};

export type OperatorOverviewDeps = {
  query?: QueryFn;
  /** 讀帳戶原生幣餘額；省略 = `getAccountGasBalance`。 */
  accountGasBalance?: (address: Address) => Promise<bigint>;
};

const SQL_OPERATOR_ROWS = `
  select p.id, p.user_id as wallet, p.strategy_id, s.name as strategy_name, p.version, p.schedule_state,
         p.next_run_at, p.last_checked_at,
         sa.address as account,
         snap.created_at as observed_at, snap.gross_drift_bps, snap.total_usd_e8, snap.needs_rebalance,
         (select count(*)::int from portfolio_snapshots b
           where b.portfolio_id = p.id and b.phase = 'before' and b.operation_id = snap.operation_id) as blocked_count,
         key.expires_at as key_expires_at,
         op.id as op_id, op.state as op_state, op.tx_hash as op_tx, op.created_at as op_created_at
    from portfolios p
    left join strategies s on s.id = p.strategy_id
    left join smart_accounts sa on sa.portfolio_id = p.id
    left join lateral (
      select created_at, gross_drift_bps, total_usd_e8, needs_rebalance, operation_id
        from portfolio_snapshots
       where portfolio_id = p.id
       -- 同一輪的 before/after 可能落在同一個 created_at（同一個交易），
       -- 沒有 tiebreaker 時 Postgres 可以回任一張 —— 實測就看到「價值是清倉前的、
       -- 漂移是清倉後」的組合。phase 決勝讓它永遠取 after（＝這一輪之後的真相）。
       order by created_at desc, block desc, (phase = 'after') desc
       limit 1
    ) snap on true
    left join lateral (
      select expires_at from session_keys
       where portfolio_id = p.id and status = 'active'
       order by expires_at desc
       limit 1
    ) key on true
    left join lateral (
      select id, state, tx_hash, created_at from operations
       where portfolio_id = p.id
       order by id desc
       limit 1
    ) op on true
   order by p.id
`;

export async function readOperatorOverview(deps: OperatorOverviewDeps = {}): Promise<OperatorOverview> {
  const find = deps.query ?? dbQuery;
  const readBalance = deps.accountGasBalance ?? getAccountGasBalance;

  const [{ rows }, scheduler, alerts] = await Promise.all([
    find(SQL_OPERATOR_ROWS),
    readSchedulerStatus().catch(() => null),
    listOpenAlerts(find).then((open) => {
      let critical = 0;
      let warn = 0;
      for (const alert of open) {
        if (alert.severity === 'critical') critical += 1;
        else warn += 1;
      }
      return { critical, warn, open: critical + warn };
    }).catch(() => null),
  ]);

  const iso = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    const time = value instanceof Date ? value.getTime() : Date.parse(String(value));
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
  };
  const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

  const portfolios: OperatorPortfolioRow[] = await Promise.all(
    (rows as Record<string, unknown>[]).map(async (row) => {
      const account = typeof row.account === 'string' ? row.account : null;
      // gas 讀不到（RPC 掛、fork 過期）→ null。儀表板不該因為一個 RPC 失敗就整頁掛掉。
      const gasWei =
        account === null
          ? null
          : await readBalance(account as Address)
              .then((wei) => wei.toString())
              .catch(() => null);

      const opId = num(row.op_id);
      return {
        id: Number(row.id),
        wallet: String(row.wallet ?? ''),
        strategyId: Number(row.strategy_id),
        strategyName: typeof row.strategy_name === 'string' ? row.strategy_name : null,
        version: Number(row.version),
        scheduleState: String(row.schedule_state),
        account,
        nextRunAt: iso(row.next_run_at),
        lastCheckedAt: iso(row.last_checked_at),
        observedAt: iso(row.observed_at),
        driftBps: num(row.gross_drift_bps),
        isEmpty: String(row.total_usd_e8 ?? '0') === '0',
        totalUsdE8: row.total_usd_e8 === null || row.total_usd_e8 === undefined ? null : String(row.total_usd_e8),
        // 空倉一律 needsRebalance = false：沒有部位就沒有東西可搬，標成「該再平衡」只會製造噪音
        // （實測：清倉後兩檔都掛著「rebalance due」+ 9999 bps，看起來像壞掉）。
        needsRebalance:
          String(row.total_usd_e8 ?? '0') === '0'
            ? false
            : row.needs_rebalance === null || row.needs_rebalance === undefined
              ? null
              : row.needs_rebalance === true,
        blockedCount: num(row.blocked_count),
        gasWei,
        sessionKeyExpiresAt: iso(row.key_expires_at),
        lastOperation:
          opId === null
            ? null
            : {
                id: opId,
                state: String(row.op_state),
                txHash: typeof row.op_tx === 'string' ? row.op_tx : null,
                createdAt: iso(row.op_created_at) ?? '',
              },
      };
    }),
  );

  const lastCheckedAt = portfolios
    .map((row) => row.lastCheckedAt)
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1) ?? null;

  return { generatedAt: new Date().toISOString(), scheduler, alerts, lastCheckedAt, portfolios };
}

// ---------------------------------------------------------------------------
// Redeem：把部位賣成 numeraire（提領成 USDT 的前半段）
// ---------------------------------------------------------------------------

/** 首批 bigint 保留 usd 比例語意；續作只表示待賣的非現金名義額（E8）。 */
export type RedeemAmount = bigint | { sellUsdE8: bigint };
type SellRequest = RedeemAmount | { close: true };

export type RedeemResult = {
  portfolioId: number;
  outcome: OperatorRebalanceOutcome;
  reason: string;
  txHash: string | null;
  steps: { tokenIn: string; tokenOut: string; amountIn: string; amountOutMin: string; venue: string }[];
  /** 保留既有欄位：首批仍為請求的 usd，close 為投組總值；續作為請求的 sellUsdE8。 */
  redeemedUsdE8: string;
  /** 非現金待賣名義額；尚未規劃、只對帳或送出結果未知時為 null，不能當成可重送量。 */
  remainingUsdE8: string | null;
  batched: boolean;
};

/**
 * The smallest partial sale an owner can ask for (`usd`, E8): the buy minimum (10 USDT), not the 50 USDT a rebalance
 * between assets needs. Below it the request is refused before anything is read or sent. A continuation (`sellUsdE8`)
 * is the remainder of a sale that already passed this, so it is not held to it.
 */
export const MIN_SELL_USD_E8 = MIN_BATCH_USDT * 100_000_000n;
/**
 * The smallest single step of an owner's partial sale (E8): 1 USDT, the same floor a cash raise uses (below it the
 * executor's floor and the fee leave nothing). A remainder smaller than this is never sold on its own.
 */
export const SELL_MIN_STEP_USD_E8 = 100_000_000n;

export async function runOperatorRedeem(portfolioId: number, wallet: string, amount: RedeemAmount, deps: RebalanceDeps = {}): Promise<RedeemResult> {
  const value = typeof amount === 'bigint' ? amount : amount.sellUsdE8;
  if (value <= 0n) throw new AppError(400, 'INVALID_AMOUNT', 'redeem amount must be greater than zero');
  if (typeof amount === 'bigint' && amount < MIN_SELL_USD_E8) throw new AppError(400, 'BELOW_MIN_SELL', `a partial sale must be at least ${MIN_BATCH_USDT} USDT; sell everything to close a smaller position`);
  return runOperatorSell(portfolioId, wallet, amount, deps);
}

async function runOperatorSell(portfolioId: number, wallet: string, request: SellRequest, deps: RebalanceDeps): Promise<RedeemResult> {
  await (deps.requireOwnedPortfolio ?? requireOwnedPortfolio)(portfolioId, wallet);
  const closing = typeof request === 'object' && 'close' in request;
  const release = deps.releaseRunningBuy !== undefined ? deps.releaseRunningBuy
    : deps.withTransaction === undefined && deps.query === undefined ? releaseRunningBuy : null;
  if (closing && release) {
    try { await release(portfolioId); }
    catch (error) { (deps.log ?? console.warn)(`[close] portfolio ${portfolioId}: running buy not released (${errorChain(error)})`); }
  }
  const planning: { result: RedeemPlanningResult | null } = { result: null };
  const round = await (deps.runSchedulerOnce ?? runSchedulerOnce)(
    { dryRun: false, limit: 1, skipAlerts: true },
    {
      withTransaction: singlePortfolioClaim(portfolioId, deps.withTransaction, { allowPaused: closing, preserveNextRunAt: true }),
      ...(deps.withTransaction === undefined ? { withDexLock: <T>(chainId: number, fn: () => Promise<T>) => withDexLock(chainId, fn, { waitMs: OWNER_DEX_WAIT_MS }) } : {}),
      ...(deps.query === undefined ? {} : { query: deps.query }),
      planRebalance: async (input) => {
        const built = await buildRedeemPlan(input, request, deps);
        planning.result = built;
        return built.plan;
      },
      forcePlan: true,
      ...(deps.log === undefined ? {} : { log: deps.log }),
    },
  );
  const candidate = round.results[0];
  const result = candidate?.portfolioId === portfolioId ? candidate : undefined;
  const details = planning.result;
  const requested = typeof request === 'bigint' ? request : 'sellUsdE8' in request ? request.sellUsdE8 : details?.portfolioTotalUsdE8 ?? 0n;
  const outcome = result === undefined || result.portfolioId !== portfolioId ? 'blocked' : operatorOutcome(result);
  const wanted = details?.requestedSellUsdE8 ?? null;
  const remaining = wanted === null || details === null || result?.execution?.status === 'unknown'
    ? null : wanted - (outcome === 'executed' ? details.plannedSellUsdE8 : 0n);
  let reason = result?.reason ?? `排程器沒有認領 portfolio ${portfolioId}（排程狀態或 smart account 不允許）`;
  const nothingToSell = details?.plan.kind === 'noop' && details.plan.reason === 'nothing to sell';
  if (nothingToSell) reason = 'nothing to sell';
  const query = deps.query ?? dbQuery;
  if (outcome === 'executed' || (outcome === 'noop' && nothingToSell && closing)) {
    try {
      if (closing) {
        await query("update portfolios set schedule_state = 'paused' where id = $1", [portfolioId]);
        await query('update scheduler_alerts set resolved_at = now() where portfolio_id = $1 and resolved_at is null', [portfolioId]);
      } else {
        await query("update portfolios set next_run_at = greatest(next_run_at, now() + $2::int * interval '1 second') where id = $1", [portfolioId, PARTIAL_FOLLOW_UP_SECONDS]);
      }
    } catch {
      // A successful transaction must stay visible even if the subsequent scheduling write fails.
      reason += closing ? '；清倉結果已確認，但 DB 暫停／警示更新失敗，請檢查排程狀態' : '；賣出已確認，但 DB 延後排程失敗，請暫停排程後再續作';
    }
  }
  return {
    portfolioId, outcome, reason,
    txHash: result?.execution?.txHash ?? null,
    steps: (result?.plan?.steps ?? []).map((step) => ({ tokenIn: step.tokenIn, tokenOut: step.tokenOut, amountIn: step.amountIn, amountOutMin: step.amountOutMin, venue: step.venue })),
    redeemedUsdE8: requested.toString(), remainingUsdE8: remaining?.toString() ?? null,
    batched: details !== null && details.requestedSellUsdE8 !== null && details.plannedSellUsdE8 < details.requestedSellUsdE8,
  };
}

const ORACLE_ABI = [
  {
    type: 'function',
    name: 'previewSwap',
    stateMutability: 'view',
    inputs: [{ name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'amountIn', type: 'uint256' }],
    outputs: [{ name: 'quoted', type: 'uint256' }, { name: 'minimum', type: 'uint256' }],
  },
  { type: 'function', name: 'oracleOf', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'address' }] },
] as const;

const POOL_FEE_ABI = [
  { type: 'function', name: 'pool', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'fee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint24' }] },
] as const;

/**
 * executor 抽成的 bps（＝`minGross` 的放大倍率）。
 *
 * 從 registry 讀 `effectiveFeeBps`，而不是從 DB 的 `strategies.swap_fee_bps`：後者是我們**送出去**
 * 的值，前者是**鏈上實際生效**的值（中間可能有下限或治理調整）。用錯的那個會讓 `minGross` 偏低，
 * 合約以 `BelowFloor` revert，而錯誤訊息完全看不出是這個原因。
 */
async function readExecutorFeeBps(client: PublicClient, strategyOnchainId: bigint, blockNumber: bigint, provided?: Address): Promise<number> {
  const registry = provided ?? getConfig().registryAddress;
  if (registry === null) throw new Error('沒有設定 REGISTRY_ADDRESS，讀不到 effectiveFeeBps');
  const value = await client.readContract({
    address: registry as Address,
    abi: [{ type: 'function', name: 'effectiveFeeBps', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint16' }] }],
    functionName: 'effectiveFeeBps', args: [strategyOnchainId], blockNumber,
  });
  return Number(value);
}

async function readPoolFee(client: PublicClient, router: Address, asset: Address, blockNumber: bigint): Promise<number> {
  const pairOracle = await client.readContract({ address: router, abi: ORACLE_ABI, functionName: 'oracleOf', args: [asset], blockNumber });
  const pool = await client.readContract({ address: pairOracle, abi: POOL_FEE_ABI, functionName: 'pool', blockNumber });
  return Number(await client.readContract({ address: pool, abi: POOL_FEE_ABI, functionName: 'fee', blockNumber }));
}

async function readNumeraireAddress(query: QueryFn, chainId: number): Promise<Address> {
  if (chainId === 97) return TESTNET_97.contracts.usdt;
  const { rows } = await query('select address from priceable_assets where is_numeraire order by symbol limit 1');
  const row: unknown = rows[0];
  const address: unknown = typeof row === 'object' && row !== null ? Reflect.get(row, 'address') : null;
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('missing numeraire');
  return address as Address;
}

/**
 * How an owner's partial sale of `budget` is taken from the holdings when the plain pro-rata split does not work
 * (a share would be under `minStep`, or would need shares posted for Strategy Earn). All values are oracle nominal in
 * numeraire raw units; `free[i]` is what the account holds itself, `posted[i]` what it posted as collateral.
 *
 *   1. Free balances first, pro rata to their free value. A share under `minStep` is dropped (smallest first) and the
 *      others take it over, so the sale lands in fewer assets instead of failing.
 *   2. Only what the free balances cannot cover comes from posted shares, from as few assets as possible (largest
 *      posted first): each of those positions has to be repaid and taken back before it can be sold.
 *
 * Whatever cannot be placed in a step of at least `minStep` is left out (the caller reports it as not sold).
 */
export function allocateSale(budget: bigint, free: readonly bigint[], posted: readonly bigint[], minStep: bigint): bigint[] {
  const out = free.map(() => 0n);
  if (budget <= 0n) return out;
  let active = free.map((_, index) => index).filter((index) => (free[index] ?? 0n) > 0n);
  while (active.length > 0) {
    const room = active.reduce((sum, index) => sum + (free[index] ?? 0n), 0n);
    const take = budget < room ? budget : room;
    const shares = active.map((index) => take === room ? free[index] ?? 0n : take * (free[index] ?? 0n) / room);
    let smallest = 0;
    for (let i = 1; i < shares.length; i++) if ((shares[i] ?? 0n) < (shares[smallest] ?? 0n)) smallest = i;
    if ((shares[smallest] ?? 0n) >= minStep) { active.forEach((index, i) => { out[index] = shares[i] ?? 0n; }); break; }
    active = active.filter((_, i) => i !== smallest);
  }
  let left = budget - out.reduce((sum, value) => sum + value, 0n);
  if (left < minStep) return out;
  const byPosted = posted.map((value, index) => ({ value, index })).filter((entry) => entry.value > 0n)
    .sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : a.index - b.index));
  for (const { index } of byPosted) {
    if (left <= 0n) break;
    const room = (free[index] ?? 0n) + (posted[index] ?? 0n) - (out[index] ?? 0n);
    const add = left < room ? left : room;
    if ((out[index] ?? 0n) + add < minStep) continue;
    out[index] = (out[index] ?? 0n) + add;
    left -= add;
  }
  return out;
}

export type RedeemPlanningResult = {
  plan: RebalancePlan;
  requestedSellUsdE8: bigint | null;
  plannedSellUsdE8: bigint;
  portfolioTotalUsdE8: bigint | null;
};

/**
 * 首批 usd：各持倉乘 usd / total（既有比例）。續作 sellUsdE8：按當下非現金 oracle
 * 名義額分配，總和不超過請求；不保留首批各資產原始待賣比例。close 每批以全部非現金為目標。
 * 持倉、oracle、fee、pool fee 全部釘在 snapshot.block；不使用折價 minimum 計算賣出名義額。
 */
export async function buildRedeemPlan(input: RebalancePlanningInput, request: SellRequest, deps: RebalanceDeps = {}): Promise<RedeemPlanningResult> {
  let requestedSellUsdE8: bigint | null = typeof request === 'object' && 'sellUsdE8' in request ? request.sellUsdE8 : null;
  const reply = (plan: RebalancePlan, plannedSellUsdE8 = 0n): RedeemPlanningResult => ({
    plan, requestedSellUsdE8, plannedSellUsdE8, portfolioTotalUsdE8: input.plan.report?.totalUsdE8 ?? null,
  });
  try {
    const { snapshot, report, pinnedVersion } = input.plan;
    if(!assetsMarketOpen(input.plan.chainId,snapshot.holdings.filter(h=>h.amountWei>0n).map(h=>h.asset),(deps.now??(()=>new Date()))()))return reply({kind:'blocked',reason:'[MARKET_CLOSED] 股票休市，等待交易時段'});
    const query = deps.query ?? dbQuery;
    const numeraire = await readNumeraireAddress(query, deps.publicClient?.chain?.id ?? configuredChainId());
    const totalE8 = report?.totalUsdE8;
    if (typeof request === 'bigint' && totalE8 !== undefined && request > totalE8) return reply({ kind: 'blocked', reason: '要提領的 usd 超過投組總值' });
    const holdings = snapshot.holdings.filter((holding) => holding.asset.toLowerCase() !== numeraire.toLowerCase() && holding.amountWei > 0n);
    if (holdings.length === 0) {
      if (typeof request === 'object' && 'sellUsdE8' in request) return reply({ kind: 'blocked', reason: '沒有非現金部位可滿足待賣名義額' });
      requestedSellUsdE8 = 0n;
      return reply({ kind: 'noop', reason: 'nothing to sell' });
    }
    if (new Set(holdings.map((holding) => holding.asset.toLowerCase())).size !== holdings.length) return reply({ kind: 'blocked', reason: '重複的持倉資產，不送交易' });
    if (totalE8 === undefined || totalE8 <= 0n) return reply({ kind: 'blocked', reason: '沒有有效投組總值，不能規劃提領' });
    const client = deps.publicClient ?? defaultPublicClient();
    const executor = deps.executor ?? getSessionKeyConfig().executorAddress;
    if (executor === null) return reply({ kind: 'blocked', reason: '沒有設定 EXECUTOR_ADDRESS' });
    const blockNumber = snapshot.block;
    const router = await client.readContract({ address: executor, abi: [{ type: 'function', name: 'oracle', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }], functionName: 'oracle', blockNumber });
    const decimals = await numeraireDecimals(client, numeraire, snapshot.holdings, blockNumber);
    const scale = 10n ** BigInt(decimals);
    const limits = await readMaxLegUsdE8(holdings.map((holding) => holding.asset), query, client.chain?.id);
    const notes: string[] = [];
    const nominal = await Promise.all(holdings.map(async (holding) => {
      try { return await nominalSellQuote(client, router, holding.asset as Address, numeraire, holding.amountWei, blockNumber); }
      catch (error) {
        const failure = decodePriceSourceError(error);
        if (failure === null) throw error;
        notes.push(failure.detail); return 0n;
      }
    }));
    const unavailable = notes.length > 0;
    const availableHoldings = holdings.filter((_, index) => (nominal[index] ?? 0n) > 0n);
    const nonCashRaw = nominal.reduce((sum, value) => sum + value, 0n);
    // Carry E8 at aggregate precision; per-token rounding residue remains in the requested total.
    const allUsdE8 = (nonCashRaw * 100_000_000n + scale - 1n) / scale;
    if (unavailable && typeof request === 'bigint') return reply({ kind: 'blocked', reason: `無法確認首批提領的完整待賣名義額：${notes.join('；')}` });
    const first = typeof request === 'bigint';
    if (first) {
      // Price the exact original token quantities after token rounding; otherwise sub-token
      // dust would become a phantom continuation amount that cannot ever be sold.
      const desired = await Promise.all(availableHoldings.map((holding) => {
        const amount = holding.amountWei * request / totalE8;
        return amount === 0n ? 0n : nominalSellQuote(client, router, holding.asset as Address, numeraire, amount, blockNumber);
      }));
      const desiredRaw = desired.reduce((sum, value) => sum + value, 0n);
      requestedSellUsdE8 = (desiredRaw * 100_000_000n + scale - 1n) / scale;
    } else if ('close' in request) requestedSellUsdE8 = unavailable ? null : allUsdE8;
    const wanted = requestedSellUsdE8 ?? allUsdE8;
    if (wanted === 0n) return reply(unavailable ? { kind: 'blocked', reason: notes.join('；') } : { kind: 'noop', reason: '提領比例換算後待賣代幣量為 0' });
    const budget = wanted < allUsdE8 ? wanted : allUsdE8;
    const feeBps = await readExecutorFeeBps(client, BigInt(pinnedVersion.onchainStrategyId), blockNumber, deps.registry);
    const { timestamp } = await client.getBlock({ blockNumber });
    const wall = BigInt(Math.floor(Date.now() / 1000));
    const deadline = (timestamp > wall ? timestamp : wall) + BigInt(DEFAULT_DEADLINE_SECONDS);
    const steps: PlannedStep[] = [];
    let soldRaw = 0n;
    const closing = typeof request === 'object' && 'close' in request;
    // What each holding sells this batch. A close sells everything; a partial sale is pro rata, as before.
    let amounts = availableHoldings.map((holding) => {
      const amount = closing ? holding.amountWei : first ? holding.amountWei * request / totalE8 : holding.amountWei * budget * scale / (nonCashRaw * 100_000_000n);
      return amount > holding.amountWei ? holding.amountWei : amount;
    });
    if (!closing) {
      // A pro-rata share under one step (many assets, a small weight) used to fail the whole sale ([BELOW_MIN_STEP]), and a
      // share larger than the free balance repays and takes back Strategy Earn collateral first. Then the same amount is
      // taken from fewer assets and from free balances first (allocateSale); weights drift a little, the sale goes through.
      const postedOf = new Map<string, bigint>();
      for (const entry of snapshot.strategyEarnCollateral ?? []) postedOf.set(entry.asset.toLowerCase(), (postedOf.get(entry.asset.toLowerCase()) ?? 0n) + entry.amount);
      const values = availableHoldings.map((holding) => nominal[holdings.indexOf(holding)] ?? 0n);
      const freeAmounts = availableHoldings.map((holding) => { const kept = postedOf.get(holding.asset.toLowerCase()) ?? 0n; return holding.amountWei > kept ? holding.amountWei - kept : 0n; });
      const minStepRaw = SELL_MIN_STEP_USD_E8 * scale / 100_000_000n;
      const budgetRaw = budget * scale / 100_000_000n;
      const fits = availableHoldings.every((holding, index) => {
        const share = first ? (values[index] ?? 0n) * request / totalE8 : budgetRaw * (values[index] ?? 0n) / nonCashRaw;
        return (amounts[index] ?? 0n) > 0n && (amounts[index] ?? 0n) <= (freeAmounts[index] ?? 0n) && share >= minStepRaw;
      });
      if (!fits) {
        const freeValues = availableHoldings.map((holding, index) => (values[index] ?? 0n) * (freeAmounts[index] ?? 0n) / holding.amountWei);
        const allocated = allocateSale(budgetRaw, freeValues, values.map((value, index) => value - (freeValues[index] ?? 0n)), minStepRaw);
        // A hair under the allocation: token rounding must never push the batch's oracle nominal above the request.
        amounts = availableHoldings.map((holding, index) => {
          const value = allocated[index] ?? 0n;
          const amount = value === 0n ? 0n : holding.amountWei * (value - value / 1_000_000n) / (values[index] ?? 1n);
          return amount > holding.amountWei ? holding.amountWei : amount;
        });
        if (amounts.every((amount) => amount === 0n)) return reply({ kind: 'noop', reason: `[BELOW_MIN_STEP] 待賣量換算後為 0：待賣 ${wanted} E8 湊不成一步至少 ${SELL_MIN_STEP_USD_E8} E8 的賣單，不送交易` });
      }
    }
    for (const [index, holding] of availableHoldings.entries()) {
      if (steps.length === MAX_USER_OP_STEPS) break;
      let amountIn = amounts[index] ?? 0n;
      if (amountIn === 0n) continue;
      const limit = limits.get(holding.asset.toLowerCase());
      if (limit === undefined) return reply({ kind: 'blocked', reason: '[MAX_LEG_UNAVAILABLE] 缺少單筆限額' });
      const capped = await capAssetLeg({ publicClient: client, oracle: router, numeraire, tokenIn: holding.asset as Address, tokenOut: numeraire, amountIn, limitUsdE8: limit, decimals, blockNumber });
      if ('blocked' in capped) { notes.push(`${holding.asset}: ${capped.blocked}`); continue; }
      amountIn = capped.amountIn;
      const quoted = await client.readContract({ address: router, abi: ORACLE_ABI, functionName: 'previewSwap', args: [holding.asset as Address, numeraire, amountIn], blockNumber }).catch(async (error: unknown) => {
        const failure = await describePriceSourceError(error, client, { oracle: router, asset: holding.asset as Address, blockNumber });
        if (failure === null) throw error;
        notes.push(failure.detail); return null;
      });
      if (quoted === null) continue;
      const [quotedOut, floor] = quoted;
      if (quotedOut <= 0n || floor <= 0n) { notes.push(`${holding.asset}: oracle 沒有有效地板`); continue; }
      // Independent final check: integer rounding or a malformed oracle must never exceed the total request.
      const nextRaw = soldRaw + quotedOut;
      if (nextRaw * 100_000_000n > wanted * scale) { notes.push(`${holding.asset}: oracle 名義額超過剩餘待賣量`); continue; }
      if (limit !== null && quotedOut * 100_000_000n > limit * scale) { notes.push(`${holding.asset}: oracle 名義額超過單筆上限`); continue; }
      const poolFee = await readPoolFee(client, router, holding.asset as Address, blockNumber);
      const step = await buildRoutedStep({ publicClient: client, executor, tokenIn: holding.asset as Address, tokenOut: numeraire, amountIn, oracleFloor: floor, oracleQuoted: quotedOut, minGross: minGrossFor(floor, feeBps), poolFee, feeBps, deadline, blockNumber }, deps);
      if (step === null) { notes.push(`${holding.asset}: 沒有符合地板的白名單路徑`); continue; }
      steps.push(step);
      soldRaw = nextRaw;
    }
    if (steps.length === 0) return reply({ kind: 'blocked', reason: `沒有可執行的賣出步驟：${notes.join('；') || '待賣量換算後為 0'}` });
    // Subtract the ceiling of aggregate nominal sold, so repeated E8 continuation never oversells by truncation.
    const soldE8 = (soldRaw * 100_000_000n + scale - 1n) / scale;
    // What a partial sale leaves under one step is never sold on its own: the request is complete, nothing to continue.
    const plannedE8 = !closing && wanted > soldE8 && wanted - soldE8 < SELL_MIN_STEP_USD_E8 ? wanted : soldE8;
    const fullExit = closing || holdings.every((holding) =>
      steps.filter((step) => step.tokenIn.toLowerCase() === holding.asset.toLowerCase()).reduce((sum, step) => sum + step.amountIn, 0n) === holding.amountWei);
    return reply({ kind: 'ready', steps, deadline,
      ...(fullExit ? { purpose: 'exit' } : { ownerSale: true }),
      rationale: `賣出 ${steps.length} 檔，非現金待賣 ${wanted} E8，本批名義額 ${soldE8} E8；剩餘由 API 呼叫者以 sellUsdE8 續作（依當下非現金價值重新分配）${notes.length === 0 ? '' : `；blocked：${notes.join('；')}`}` }, plannedE8);
  } catch (error) {
    return reply({ kind: 'blocked', reason: decodePriceSourceError(error)?.detail ?? '[REDEEM_PLAN_UNAVAILABLE] 持倉、限額、oracle 或 DB 資料不可用，不送交易' });
  }
}

/** DB paused 僅放寬本次單投組認領；全域／鏈上 pause 與 #38 對帳仍由 scheduler 檢查。 */
export async function runOperatorClose(portfolioId: number, wallet: string, deps: RebalanceDeps = {}): Promise<RedeemResult> {
  return runOperatorSell(portfolioId, wallet, { close: true }, deps);
}

/**
 * 營運端的全域活動流：**誰**（owner 錢包）在**哪個策略**上被再平衡了。
 *
 * 為什麼需要：`operations` 只有 `portfolio_id`，要回答「這輪排程器動了誰」得自己 join
 * portfolios → strategies。`/operator` 的表格是「現況」（誰現在 drift 多少），
 * 這裡是「歷史」（誰在什麼時候被處理、成功還是失敗）。
 *
 * 刻意**不**做 owner 驗證：營運端要能看全部。這也是為什麼它放在 `/operator` 底下
 * 而不是 `/portfolios/:id/activity`。
 */
export type OperatorActivityRow = {
  id: number;
  portfolioId: number;
  /** owner 錢包。 */
  wallet: string;
  strategyId: number;
  strategyName: string | null;
  /** `rebalance` / `approve` / … */
  type: string;
  state: string;
  txHash: string | null;
  attempts: number;
  error: string | null;
  createdAt: string;
  /** 這一輪前後的漂移（bps）。`null` = noop/blocked 不寫快照。 */
  driftBeforeBps: number | null;
  driftAfterBps: number | null;
  usdBeforeE8: string | null;
  usdAfterE8: string | null;
};

type OperatorActivityDbRow = {
  id: unknown;
  portfolio_id: unknown;
  wallet: unknown;
  strategy_id: unknown;
  strategy_name: unknown;
  type: unknown;
  state: unknown;
  tx_hash: unknown;
  attempts: unknown;
  last_error: unknown;
  created_at: unknown;
  drift_before: unknown;
  drift_after: unknown;
  usd_before: unknown;
  usd_after: unknown;
};

/**
 * 最近 N 筆操作（跨所有投組）。
 *
 * `limit` 有上限：這是給人看的列表，不是匯出工具 —— 一次拉一萬筆只會讓瀏覽器卡住。
 */
export async function readOperatorActivity(
  limit = 50,
  deps: OperatorOverviewDeps = {},
): Promise<OperatorActivityRow[]> {
  const find = deps.query ?? dbQuery;
  const capped = Math.min(Math.max(1, Math.trunc(limit)), 200);

  // `QueryFn` 沒有泛型（回傳 `rows: unknown[]`），所以這裡自己轉型。
  const { rows } = await find(
    `select o.id, o.portfolio_id, p.user_id as wallet, p.strategy_id,
            st.name as strategy_name,
            o.type, o.state, o.tx_hash, o.attempts, o.last_error, o.created_at,
            b.gross_drift_bps as drift_before, a.gross_drift_bps as drift_after,
            b.total_usd_e8 as usd_before, a.total_usd_e8 as usd_after
       from operations o
       join portfolios p on p.id = o.portfolio_id
       left join strategies st on st.id = p.strategy_id
       left join portfolio_snapshots b
              on b.portfolio_id = o.portfolio_id and b.operation_id = o.id and b.phase = 'before'
       left join portfolio_snapshots a
              on a.portfolio_id = o.portfolio_id and a.operation_id = o.id and a.phase = 'after'
      order by o.id desc
      limit $1`,
    [capped],
  );
  const data = rows as OperatorActivityDbRow[];

  const num = (value: unknown): number | null => {
    if (value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const str = (value: unknown): string | null =>
    value === null || value === undefined ? null : String(value);
  const iso = (value: unknown): string => {
    if (value === null || value === undefined) return new Date(0).toISOString();
    return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
  };

  return data.map((row) => ({
    id: Number(row.id),
    portfolioId: Number(row.portfolio_id),
    wallet: String(row.wallet ?? ''),
    strategyId: Number(row.strategy_id),
    strategyName: str(row.strategy_name),
    type: String(row.type),
    state: String(row.state),
    txHash: str(row.tx_hash),
    attempts: Number(row.attempts ?? 0),
    error: str(row.last_error),
    createdAt: iso(row.created_at),
    driftBeforeBps: num(row.drift_before),
    driftAfterBps: num(row.drift_after),
    usdBeforeE8: str(row.usd_before),
    usdAfterE8: str(row.usd_after),
  }));
}
