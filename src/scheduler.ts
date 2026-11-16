import { assetsMarketOpen } from './trading-calendar.js';
import { runYieldRound } from './yield-service.js';
import { assertUserOpCapacity, boundedCallGasLimit, executionBatchSize, MAX_USER_OP_STEPS, userOpGasOverhead } from './execution-batch.js';
import { EXECUTOR_ABI, EXECUTOR_SELECTOR, PLAN_HASH_ABI } from './chain.js';
/**
 * 排程器迴圈（S3）：讓前幾刀做好的零件自己動起來。
 *
 * 這個檔案只做「誰現在該跑 → 該不該動 → 要不要送」的**決策與認領**，把三個既有零件串起來：
 *   `planPortfolio`（snapshot.ts）     持倉 + 定價 + 漂移 + blocked
 *   `planRebalance`（rebalance-plan.ts）漂移 → SwapStep[]（永不回空 steps）
 *   既有的 session key 簽名機制          execute-rebalance.ts 走過的那條路（實測成功換幣）
 *
 * ## 四條會決定「會不會重複動錢」的規則
 *
 * ① **認領與推進在同一個 transaction 裡**（`claimDuePortfolios`）。
 *    `SELECT … FOR UPDATE SKIP LOCKED` 選出到期的列，並在**離開 transaction 之前**把
 *    `next_run_at` 寫成 `now + intervalSeconds`。若等執行完才推進，一次 crash／逾時／`kill -9`
 *    就讓同一個 portfolio 在下一輪仍然「到期」→ 被重複認領 → 重複送一筆再平衡。
 *    漏跑一次只是延後（下一輪會補），重複跑是不可逆的。所以推進放在**執行之前**。
 *    ⚠ 只有 **live** 才推進：dry-run 用 `claimDuePortfolios(…, { advance: false })`，見下一段。
 *
 * ①-bis **dry-run 只讀不寫：連 `next_run_at` 都不推進。**
 *    用 dry-run 當監控是很自然的用法，但推進一次就把真正的再平衡往後推一整個 interval
 *    （本專案 86400 秒 = 一次 dry-run 就等於「今天不做」）。所以 `advance` 只給 live。
 *    代價是：連續跑兩次 dry-run 會看到**同樣的** portfolio。那是正確且可預期的 ——
 *    **觀察不該改變被觀察的系統**。live 的語意完全不變：認領與推進仍然是同一個 transaction
 *    （上面那條規則才是防重複執行的關鍵，不能因為這個修改而鬆動）。
 *
 * ② **`dryRun` 預設 true，而且 true 時執行路徑一次都不會被呼叫。**
 *    `runSchedulerOnce({})` 就是 dry run：算得出參數、印得出來，但不會有任何交易。
 *    要送交易只有一條路：明確傳 `dryRun: false`（CLI 上是 `--live`）。有測試釘住呼叫次數 = 0。
 *
 * ③ **live 的前置檢查缺一不可**（§4）：帳戶型別是 `KERNEL`、session key 在鏈上已安裝、
 *    **seed 派生得出 DB 記的那把 key**、allowance 足夠、餘額足夠。任一不滿足就 blocked 並跳過
 *    —— 不送一筆注定 revert 的交易。第一項**不看 DB 的 `session_keys.status`**：DB 說 active
 *    不代表鏈上裝好了（docs/pitfalls §8.11），而 `permissionConfig(pid).signer` 是 validator
 *    合約位址、不是 EOA（§8.10）。
 *
 * ## 為什麼「設定錯誤」必須擋在 `blocked`，不能記成 `failed`
 *
 * `failed` 的意思是「試過了但失敗」（`operations` 有一列、`attempts` +1）。而 seed 打錯、換了
 * KMS、複製貼上少一個字元，真相是「**根本沒試**」。把它記成 failed 會有兩個後果：連續 `--loop`
 * 每輪燒一次 attempt；而且監控上「失敗」與「設定錯誤」再也分不出來。所以派生對帳（純本機運算，
 * 不碰鏈）與帳戶型別檢查都放在**寫 `operations` 之前**，不符就 blocked 並帶明確的 code。
 *
 * 帳戶型別同理，而且**dry-run 也走這一條**：一個 `account_type != 'KERNEL'` 的帳戶（例如 EOA
 * ——帳戶就是 owner 本人）永遠不可能用 session key 簽 UserOp，讓它在監控輸出裡顯示 `ready`
 * 會讓「看 ready 的數量判斷健康度」得到錯的結論。
 *
 * ③-bis **③的整組前置檢查在 dry-run 也跑**（`ready` 的定義是「如果現在 `--live`，這一個會成功
 *    嗎？」）。只把帳戶型別搬過來而把 a／a2／b／c 留在 live-only，就只是把「永遠不可能成功卻顯示
 *    `ready`」從 EOA 換成另一類（KERNEL 但 active `session_keys` = 0、或 allowance 早就被用掉）。
 *    代價只有兩種讀取：每把候選 key 一次 `permissionConfig`（裝好即停）、每個 step 各一次
 *    allowance／balance —— 與 `planPortfolio` 已經在做的持倉事件掃描與定價是同一個數量級，
 *    而且只有真的走到 `ready`（有漂移、規劃得出 steps）的 portfolio 才付。dry-run 仍然
 *    **不寫 `operations`、不推進 `next_run_at`、不送交易**（①-bis 與②不變）。
 *
 * ④ **`operations` 是防重複的第二道鎖**：`idempotency_key = rebalance:{portfolioId}:{planHash}`，
 *    `planHash` 涵蓋 `tokenIn/tokenOut/amountIn/amountOutMin/venue/data/deadline`。`confirmed` 永不再送、
 *    portfolio 只要有 `pending`/`submitted` 就先對帳、不送新 plan；舊版帶 hash 的 `failed` 亦同。
 *    明確未送出的 `failed`／已確認 `reverted` 才允許同一個 key 重試（attempts +1）。
 *    `expired` 只由雙 null 與原 deadline／nonce 證據安全釋放，不算在途、不能重試舊 key。
 *
 * ⑤ **地板的規劃值不是送出值：簽名前一定重問一次**（`deps.refreshFloors`）。
 *    `planRebalance` 的 `minimum` 是 `plan.snapshot.block` 那一塊問到的，而 `AtpExecutor._checkStep`
 *    在**執行**那一塊會自己再問一次 oracle 並 `require(step.amountOutMin >= minGross)`
 *    —— 而 `PancakeV3TwapOracle` 的 `minimum` 含近 5 分鐘均值，會追著池價跑。所以凍結的規劃值在
 *    plan → sign 之間（幾十秒、好幾塊）就可能低於當下的地板 → `BelowFloor` 或 router 的
 *    `Too little received`。重問用**新鮮值**覆寫（不是 `max`，見 `refreshFloors` 的檔頭），
 *    而且呼叫點在 `planHashFor` **之前**：`planHash` 就是 `operations.payload_hash`，
 *    它必須描述真的會上鏈的那組參數。問不到地板 → 這一輪不送（`blocked`，不寫 operations）。
 *
 * ## 為什麼 dry-run 不寫 `operations`
 *
 * §5 說「每次進入執行流程就寫一列」，而 dry-run 確實進了執行流程。但 dry-run 寫一列 `pending`
 * 會讓**真正的執行永遠被自己的預演擋住**：idempotency_key 是 `rebalance:{pid}:{planHash}`，
 * 同一個 plan 的 key 必然相同，於是 live 那一次會讀到 pending → 視為在途 → 跳過。
 * 一個預演把真交易鎖死，比「少一列稽核紀錄」嚴重得多。所以 dry-run 只把
 * `planHash`／`idempotencyKey` 印在結果裡（看得見它將會用哪個 key），一列都不寫。
 */

import { HDKey } from '@scure/bip32';
import { estimationPaymaster, paymasterExecutionError, schedulerPaymaster, gasExecutionKey, reserveGasBudget, readNativeBudgetPrice, existingBudgetContext, settleGasBudget, GasBudgetExceededError } from './paymaster.js';
import { detectPaymasterLowGas } from './alerts.js';
import type { PaymasterGasChecks } from './alerts.js';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { toECDSASigner } from '@zerodev/permissions/signers';
import { addressToEmptyAccount, createKernelAccount, createKernelAccountClient } from '@zerodev/sdk';
import { KERNEL_V3_3 } from '@zerodev/sdk/constants';
import type { GetKernelVersion } from '@zerodev/sdk/types';
import {
  createPublicClient,
  decodeFunctionData,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  hexToBytes,
  getAddress,
  http,
  isAddressEqual,
  keccak256,
  parseAbi,
  slice,
  toBytes,
} from 'viem';
import type { PriceSourceObservation, PriceSourceFailure } from './chain.js';
import type { Address, Hex, PublicClient } from 'viem';
import { hdKeyToAccount } from 'viem/accounts';
import { createBundlerClient, entryPoint07Abi, formatUserOperation, formatUserOperationReceipt, getUserOperationHash } from 'viem/account-abstraction';
import type { GetUserOperationReturnType, UserOperationReceipt } from 'viem/account-abstraction';
import { activeChain } from './chain-object.js';
import { testnetAssets, TESTNET_97 } from './testnet-profile.js';
import { signPreparedOperation } from './user-operation.js';
import { KERNEL_V3_3_ADDRESSES, kernelAddressesForChain } from './addresses.js';
import { detectAlerts, detectRelayerLowGas, formatAlert, recordAlerts, resolveAlerts, PRICE_SOURCE_FAILURE_ROUNDS, priceSourceAlertAssets } from './alerts.js';
import type { AlertFinding, AlertKind, PriceSourceTracker, RelayerGasChecks } from './alerts.js';
import { a10ErrorMessage, EXECUTOR_BUY_ABI, readGlobalPaused, decodePriceSourceError, describePriceSourceError, PriceSourceError, inspectPriceSources, oracleUnavailableTag } from './chain.js';
import { getConfig, getSessionKeyConfig, requireSessionKeyConfig } from './config.js';
import { errorMessage, query as dbQuery, withTransaction, withPortfolioLock } from './db.js';
import { AppError } from './errors.js';
import { buildSessionPermissions, yieldAuthorization } from './permissions.js';
import { DEFAULT_DEADLINE_SECONDS as PLAN_DEFAULT_DEADLINE_SECONDS, planRebalance, readMaxLegUsdE8, refreshFloors, minimumDepositUsdtWei, checkTradeMinimums, checkBuyFeeReserve } from './rebalance-plan.js';
import { writeSnapshot as writeSnapshotImpl } from './snapshot.js';
import type { PlanPartial, PlannedStep, RebalancePlan, RefreshFloorsResult } from './rebalance-plan.js';
import { DEFAULT_THRESHOLD_BPS, planPortfolio } from './snapshot.js';
import type { PortfolioPlan } from './snapshot.js';
import { MIN_INTERVAL_SECONDS } from './strategies.js';
import { defaultNewMoneyDeps, prepareNewMoney } from './strategy-runtime.js';
import type { NewMoneyDeps } from './strategy-runtime.js';
import { lockCash, readJob, settleStrategyBatch, recordInflightSlots } from './strategy-jobs.js';
import type { BatchEvidence, JobContext, StrategyJob } from './strategy-jobs.js';
import { sumInputs } from './new-money-plan.js';
import type { InputVector } from './new-money-plan.js';
import { withDexLock, assertDexLock, createDexGate } from './dex-queue.js';

// ---------------------------------------------------------------------------
// 常數
// ---------------------------------------------------------------------------

/** 一輪最多認領幾個 portfolio。刻意不大：一輪的長度要短於最短的 interval（60 秒）。 */
export const DEFAULT_ROUND_LIMIT = 20;

/**
 * 非 interval 排程（`cron`、缺排程、形狀不對）的後推秒數。
 *
 * 這些 portfolio **仍然會被認領**（要留下 blocked 的紀錄，不能靜默跳過），但認領一定要推進
 * `next_run_at`：留著 NULL 的話它們每一輪都排在最前面（`nulls first`），會把 limit 吃光、
 * 讓真正能跑的 portfolio 永遠輪不到。後推一小時 = 「一小時後再提醒一次」，不是「假裝支援 cron」。
 */
export const UNSUPPORTED_SCHEDULE_BACKOFF_SECONDS = 3_600;

/**
 * deadline = `max(塊時間, 牆鐘)` + 這個秒數。
 *
 * **這裡刻意不再自己寫一個數字。** 先前排程器有一個獨立的 300 秒，而它是以
 * `planRebalance({ deadlineSeconds })` **顯式**傳進去的 —— 顯式參數優先於規劃器的預設，所以
 * 修好規劃器也修不到排程器。稀疏挖礦那筆 `DeadlineExpired`（塊時間落後牆鐘 14 分鐘，
 * `塊時間 + 300` 在簽的時候就已經過期）走的就是這條路：修規劃器的預設值時如果漏掉這裡，
 * 排程器仍然會用 300 秒繼續 revert。
 *
 * 現在只有一個來源：`rebalance-plan.ts` 的 `DEFAULT_DEADLINE_SECONDS`（1800 秒）。
 */
export const DEFAULT_DEADLINE_SECONDS = PLAN_DEFAULT_DEADLINE_SECONDS;

/** CallPolicy 白名單裡唯一的 selector（= session key 唯一被允許呼叫的函式）。 */
export const EXECUTE_REBALANCE_SELECTOR = EXECUTOR_SELECTOR;

/** EntryPoint v0.7：`toPermissionValidator` 只接受 0.7，其他版本會直接 throw。 */
const ENTRY_POINT = { address: KERNEL_V3_3_ADDRESSES.entryPointV07, version: '0.7' } as const;

/** 交易送出後等 receipt 的上限（毫秒）。超過仍在途，下一輪先對帳，不能重送。 */
const USER_OP_RECEIPT_TIMEOUT_MS = 180_000;

const RELEASE_MARGIN_SECONDS = 300n;
const MAX_USER_OP_NONCE = (1n << 256n) - 1n;

/** 三層 policy 都裝好的證據：`policyData` 的長度（call + gas + timestamp）。 */
const EXPECTED_POLICY_COUNT = 3;

/**
 * `permissionConfig(bytes4)` 的回傳：Kernel v3.3 的 `ValidationManager.PermissionConfig`。
 *
 * 自己寫一份（而不是從 `@zerodev/sdk` 拿 `KernelV3_3AccountAbi`）是為了讓「讀一欄」不必把整個
 * SDK 拉進這條路徑。欄位形狀照 SDK 的 ABI 逐字抄，`bytes22[]` 不是筆誤——PolicyData 是 packed 的。
 */
export const KERNEL_PERMISSION_ABI = [
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

const ERC20_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// ---------------------------------------------------------------------------
// 送出去的 gas 預算，與收到 receipt 之後的三層判定（docs/pitfalls §8.16）
// ---------------------------------------------------------------------------

/**
 * `callGasLimit` 的下限：600,000。
 *
 * 實測（fork，portfolio 305 的 3 資產 → 2 筆 swap）：alto 的 `eth_estimateUserOperationGas` 只給
 * 367,885，而 `executeRebalance` 走完 UniversalRouter 的 V3 swap 實際要 450–500k。gas 不夠時
 * EntryPoint **不會**讓整筆交易 revert —— 它 emit `UserOperationEvent(success = false)` 就繼續，
 * 所以 `tx.status` 還是 1、gas 照扣、幣一個都沒換（§8.16）。
 *
 * `callGasLimit` 是**上限**：沒用完的部分不會變成手續費（帳戶付的是實際用量），偏高只是把
 * EntryPoint 要求的 prefund 墊高一點。所以「估不準就給保守值」在這裡是安全的，低估才是不安全的。
 */
export const REBALANCE_CALL_GAS_FLOOR = 600_000n;

/** 估算值的放大倍率（3/2 = 1.5×）：alto 對整條 DeFi 路徑低估 20~35%，留 50% 餘裕。 */
const CALL_GAS_HEADROOM_NUMERATOR = 3n;
const CALL_GAS_HEADROOM_DENOMINATOR = 2n;

/**
 * 真正簽進 userOp 的 `callGasLimit` = `max(alto 估計 × 1.5, 600_000) + 145_000 × 估值資產數`。
 * 只有含買入的批次加估值預算；資產數取交換前已持有的非 numeraire 策略資產。
 *
 * 為什麼不直接寫死 600,000：steps 的數量隨資產數成長（3 資產 = 2 筆 swap ≈ 450–500k，資產再多就會
 * 超過 600k）。固定值會變成一個**靜默的能力上限** —— 有一天它不夠了，就又回到「花錢買 success=false」。
 * `max` 讓它跟著估算一起長大，下限則蓋住 alto 系統性低估的那一段。
 *
 * 兩個都失準的情況（估得太低、且真實需求又剛好超過這裡算出來的值）由送出前的 `eth_call` 兜住：
 * 模擬用的 gas **正是這裡算出來的值**，所以「簽名前的 gas 不夠」會在那裡變成明確的失敗，而不是
 * 一筆花了錢卻什麼都沒換的交易。
 */
export function rebalanceCallGasLimit(estimatedCallGasLimit: bigint, valuationAssetCount = 0): bigint {
  if (estimatedCallGasLimit < 0n || !Number.isSafeInteger(valuationAssetCount) || valuationAssetCount < 0) throw new RangeError('invalid valuation gas input');
  const scaled = (estimatedCallGasLimit * CALL_GAS_HEADROOM_NUMERATOR) / CALL_GAS_HEADROOM_DENOMINATOR;
  // C1 measured about 128k per held non-numeraire asset; reserve the upper 145k.
  return (scaled > REBALANCE_CALL_GAS_FLOOR ? scaled : REBALANCE_CALL_GAS_FLOOR) + BigInt(valuationAssetCount) * 145_000n;
}

/** `AtpExecutor.SwapExecuted(address,address,address,uint256,uint256,uint256,uint256,uint256)` 的 topic0。 */
const SWAP_EXECUTED_TOPIC = keccak256(
  toBytes('SwapExecuted(address,address,address,uint256,uint256,uint256,uint256,uint256)'),
);

/**
 * 算一份 receipt 裡**這個 executor** 發出的 `SwapExecuted` 筆數。
 *
 * 只認 emitter 是 executor 的 log：別的合約（例如 router 自己）的主題相同也不算「幣換了」。
 * 空 `steps` 的 `executeRebalance` 是「正常返回、什麼都不做、不 emit 任何 SwapExecuted」（§8.1），
 * 所以這一層（第 3 層）是唯一能證明「真的換了東西」的證據。
 */
export function countSwapExecuted(
  logs: readonly { address: Address; topics: readonly Hex[] }[],
  executor: Address,
): number {
  const emitter = executor.toLowerCase();
  return logs.filter(
    (log) => log.topics[0]?.toLowerCase() === SWAP_EXECUTED_TOPIC && log.address.toLowerCase() === emitter,
  ).length;
}

/** 三層判定需要的證據。全部來自同一份 receipt，所以不會有「三層看到不同世界」的問題。 */
export type RebalanceEvidence = {
  /** 第 1 層：交易本身。（`receipt.status`） */
  txStatus: 'success' | 'reverted';
  /** 第 2 層：`UserOperationEvent.success`。`null` = receipt 裡找不到那個事件。 */
  userOpSuccess: boolean | null;
  /** 第 3 層：這一筆 receipt 裡 executor 發出的 `SwapExecuted` 筆數。 */
  swapExecuted: number;
  /** 這一輪規劃了幾個 step（＝應該有幾筆 SwapExecuted）。 */
  expectedSwaps: number;
  txHash: Hex | null;
  userOpHash: Hex | null;
  gasUsed: string | null;
  revertReason?: string;
};

/**
 * 收到 receipt 之後判定這次送出的結果。**三層缺一不可**（§8.16）：
 *
 *   ① `receipt.status == success`
 *   ② `UserOperationEvent.success == true`
 *   ③ `SwapExecuted` 筆數 == steps 筆數
 *
 * 只驗第 1 層就是 §8.1 的假成功（空 steps 也會 status = 1）；只驗 1+2 仍然可能是「op 成功但什麼都沒換」。
 * 任何一層不成立 → `reverted`（**上鏈了、gas 花了、但沒有成功**），絕不是 `success` ——
 * 因為 `success` 會被 `operations` 記成 `confirmed`，而 `confirmed` 的意思是「這組參數永不再送」。
 */
export function judgeRebalanceOutcome(evidence: RebalanceEvidence): ExecutionOutcome {
  const base = { userOpHash: evidence.userOpHash, txHash: evidence.txHash, gasUsed: evidence.gasUsed };
  const failures: string[] = [];
  if (evidence.txStatus !== 'success') failures.push('tx status 不是 success');
  if (evidence.userOpSuccess !== true) {
    failures.push(
      evidence.userOpSuccess === null
        ? 'receipt 裡找不到 UserOperationEvent（無法證明 op 成功）'
        : 'UserOperationEvent.success = false（EntryPoint 吞掉了執行失敗）',
    );
  }
  if (evidence.swapExecuted !== evidence.expectedSwaps) {
    failures.push(`SwapExecuted ${evidence.swapExecuted}/${evidence.expectedSwaps} 筆（沒有全部換成）`);
  }
  if (failures.length === 0) return { status: 'success', ...base, error: null };

  // 可診斷的 last_error：說清楚「上鏈了、錢花了、哪一層沒過」。下一輪照這個訊息決定要不要重試。
  const secondary = decodePriceSourceError({ data: evidence.revertReason });
  if (secondary !== null) failures.push(secondary.detail);
  const spent = evidence.gasUsed === null ? '' : `，gas ${evidence.gasUsed} 已經花掉`;
  return { status: 'reverted', ...base, error: `上鏈但 op 沒有成功（${failures.join('；')}）${spent}` };
}

/** `AtpRegistry.effectiveFeeBps(strategyId)`：`minGross` 的放大倍率（＝平台抽成的 bps）。 */
const REGISTRY_ABI = [
  {
    type: 'function',
    name: 'effectiveFeeBps',
    stateMutability: 'view',
    inputs: [{ name: 'strategyId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint16' }],
  },
] as const;

// ---------------------------------------------------------------------------
// 型別
// ---------------------------------------------------------------------------

/** DB 的最小介面：只要求 `{ rows }`，`db.query` 與測試 stub 都直接接得上（與 snapshot.ts 同形）。 */
export type SchedulerQueryFn = (text: string, params?: readonly unknown[]) => Promise<{ rows: unknown[] }>;

/** 交易 runner：`db.withTransaction` 的形狀，測試用記憶體 stub 取代。 */
export type WithTransactionFn = <T>(fn: (client: { query: SchedulerQueryFn }) => Promise<T>) => Promise<T>;

/**
 * 一個被認領的 portfolio。
 *
 * `intervalSeconds` 在非 interval 排程（cron／缺排程）時是**後推用的退避秒數**，不是排程週期：
 * 那種 portfolio 一定會帶著 `unsupportedReason` 回來，不可能被執行。
 */
export type DuePortfolio = {
  executionKind?: 'hold' | 'stack' | 'per_asset';
  version?: number;
  scheduleState?: string;
  portfolioId: number;
  strategyId: number;
  account: Address;
  intervalSeconds: number;
  /**
   * `smart_accounts.account_type`：只有 `KERNEL` 能用 session key 簽 UserOp。
   * 認不出來的值（欄位缺失／空字串）一律當成非 KERNEL → blocked，不是「大概是吧」。
   */
  accountType: string;
  /** 非 null = 這一輪不可能執行（cron 不支援／排程缺失或形狀不對），只會被記成 blocked。 */
  unsupportedReason: string | null;
  /**
   * 認領時算出的下一次執行時間。
   *
   * `advance: true`（live）→ 這個值**已經在認領的 transaction 內寫進 DB**。
   * `advance: false`（dry-run）→ **沒有寫入**，它只是「如果推進會寫成什麼」。
   */
  nextRunAt: Date;
};

/** `strategy_versions.schedule` 的解析結果。cron 是**明確不支援**，不是靜默跳過。 */
export type ParsedSchedule =
  | { kind: 'interval'; intervalSeconds: number }
  | { kind: 'unsupported'; reason: string };

/** 一輪裡每個 portfolio 的結果。`ready-dry-run` = 算好了但沒送（dry-run）。 */
export type PortfolioOutcome = 'noop' | 'blocked' | 'ready-dry-run' | 'executed' | 'failed';

/**
 * 「部分執行」之後要提早再跑：`next_run_at` 用 **`min(intervalSeconds, 這個值)`** 而不是完整間隔。
 *
 * 為什麼需要它：池子不夠深時一筆大額再平衡會被價格衝擊上限切成一小塊（見
 * `rebalance-plan.ts` 的 `maxImpactBps`），剩下的要靠**下一輪** —— 因為地板來自 TWAP，
 * 同一批裡再切細只會讓後面的幾份更糟。等 TWAP 吸收掉這一輪的衝擊，下一輪的地板才會跟著移動。
 *
 * ## 為什麼是 1800 秒：等於 TWAP 視窗，不是半個
 *
 * `PancakeV3TwapOracle.twapWindow` 是 30 分鐘起跳（合約限制 30–90 分鐘）。影響估算是
 * 「手續費 + **現貨相對 TWAP 的既有偏差** + 本筆衝擊」三塊一起算，所以**基準偏差會吃掉那 50 bps 的
 * 預算**：買入把池價推離 TWAP，而 TWAP 還沒追上 → 下一輪能做的增量就越來越小。
 *
 * 實測（原本 900 秒、即半個 TWAP 視窗）：09:35 那輪 NVDAB 買 18,680 USDT，09:53 那輪只買到約
 * 2,557 USDT（1/7）—— 每輪都在 TWAP 還沒追上時又推一次，收斂被自己的基準偏差拖住。
 *
 *   * 好處：每輪間隔 ≥ TWAP 視窗，基準偏差有時間衰減，每輪可做的量變大。
 *   * 代價：**失敗／部分執行的跟進變慢**（30 分鐘而不是 15 分鐘）→ 完整收斂的 wall-clock 時間
 *     不一定變短；一次「只做了一點」的輪次要等更久才會再試。
 *   * 為什麼不是更長：> TWAP 視窗之後就沒有新的衰減可得，只是把跟進拖得更慢。1800 是合約允許的
 *     TWAP 視窗下限 —— 剛好「一輪 = 一個視窗」，也剛好是能選的最短的那個合法值。
 *
 * 為什麼 `min(intervalSeconds, …)`：排程週期本來就比 30 分鐘短的策略不該被**延後**。
 */
export const PARTIAL_FOLLOW_UP_SECONDS = 1800;


/** 準備要執行的參數摘要：dry-run 與 live 都會有，差別只在有沒有 `execution`。 */
export type PlannedSummary = {
  steps: {
    tokenIn: Address;
    tokenOut: Address;
    amountIn: string;
    amountOutMin: string;
    venue: string;
  }[];
  deadline: string;
  /** 涵蓋 完整 steps（含 venue/data）+ deadline 的 hash（hex）。 */
  planHash: Hex;
  /** `rebalance:{portfolioId}:{planHash}`：live 時 operations 的防重複鍵（dry-run 只印不寫）。 */
  idempotencyKey: string;
  rationale: string;
};

export type PortfolioRunResult = {
  rebalanceComplete?:boolean;
  portfolioId: number;
  strategyId: number;
  account: Address;
  outcome: PortfolioOutcome;
  /** 一句話說明為什麼是這個結果（繁中，直接進 CLI 摘要）。 */
  reason: string;
  nextRunAt: Date;
  plan: PlannedSummary | null;
  /** 真的送出時的結果。dry-run 一律 null。 */
  execution: ExecutionOutcome | null;
  /**
   * 這一輪只做了一部分：依這份計畫執行後**預估漂移仍高於門檻**（還有事要做）。非 null 且真的執行
   * 成功時，`nextRunAt` 會被拉近到 `min(intervalSeconds, PARTIAL_FOLLOW_UP_SECONDS)`。
   *
   * 判準是結果不是過程：`shrunk` 只是證據，**可以是空的**（缺口是被跳過而不是被縮小）。
   */
  partial: PlanPartial | null;
};

/** DB 的 session key（只存派生路徑，私鑰不落 DB）＋ 鏈上要用的三個欄位。 */
export type SessionKeyRef = {
  /** Present only on owner-installed yield upgrades; original account initConfig remains unchanged. */
  yieldAccount?: Address;
  keyRef: `m/44'/60'/${string}`;
  permissionId: Hex;
  sessionKeyAddress: Address;
  /** Unix 秒（重建 permissionId 要用同一個 validUntil，否則 id 會變）。 */
  validUntil: number;
  owner: Address;
};

export type SessionKeyResolution = { ok: true; key: SessionKeyRef } | { ok: false; reason: string };

/** 鏈上 `permissionConfig(pid)` 的兩個關鍵欄位。 */
export type PermissionInstallation = { signer: Address; policyCount: number };

export type Erc20Args = { token: Address; owner: Address; spender?: Address };

export type ExecuteArgs = {
  feeBudget?: bigint;
  gasPurpose?: 'ordinary' | 'exit';
  strategyId?: bigint;
  portfolioId: number;
  account: Address;
  sessionKey: SessionKeyRef;
  /** AtpExecutor：`executeRebalance` 的 target，也是 allowance 的 spender。 */
  executor: Address;
  steps: readonly PlannedStep[];
  /** Held assets of the pinned version, before any swaps (valuation precedes selling). */
  valuationAssets: readonly Address[];
  deadline: bigint;
  /** pending 已保存的實際 EntryPoint nonce；估 gas 與送出均不得重新取值。 */
  nonce: bigint;
  /** 發出 send RPC 前通知：連線中斷且沒收到 hash 也不能推定沒有送出。 */
  onSending: () => void;
  /** 送出（拿到 userOpHash）後立刻回呼，讓排程器把 operations 標成 submitted。 */
  onSubmitted: (ids: { userOpHash?: Hex; txHash?: Hex }) => Promise<void>;
};

/**
 * 一次送出的結果。四種狀態刻意分開：
 *   success   上鏈且成功 —— **三層都成立**（`receipt.status` + `UserOperationEvent.success` +
 *             `SwapExecuted` 筆數 == steps 筆數，見 `judgeRebalanceOutcome`）。只有這個狀態會被
 *             `operations` 記成 `confirmed`。
 *   reverted  上鏈了但沒有成功（有 tx_hash，花掉 gas，什麼都沒換）。包含「`tx.status == 1` 但
 *             EntryPoint 吞掉執行失敗」那個版本（§8.16）：`error` 會帶上哪一層沒過。
 *   unknown   已開始送出但結果未知（含 receipt 逾時、落庫失敗），必須先對帳，不可重送。
 *   error     送出前失敗（簽章錯、送出前的 `eth_call` 模擬失敗）：
 *             **沒有證據說它上鏈了**，所以要記成 failed 而不是 reverted —— 後者會讓人以為鏈上那一筆失敗了。
 */
export type ExecutionOutcome = {
  cashDeltaRaw?:string;
  batchEvidence?: BatchEvidence;
  errorCode?: string;
  budgetResetAt?: string;
  priceSourceFailure?: PriceSourceFailure;
  status: 'success' | 'reverted' | 'error' | 'unknown';
  userOpHash: Hex | null;
  txHash: Hex | null;
  gasUsed: string | null;
  /** `reverted` 的診斷、`error`／`unknown` 的原因；`success` 時為 null。 */
  error: string | null;
};

/** 決策所需的輸入：portfolio 與它的 drift 計畫（`planPortfolio` 的產物）。 */
export type RebalancePlanningInput = { portfolioId: number; account: Address; plan: PortfolioPlan; inclusiveFeeReserveRaw?:bigint };

/** 送出前重問地板的輸入。`executor` 是 chain 上 `oracle()` 的讀取點，`strategyId` 是 `effectiveFeeBps` 的 key。 */
export type FloorRefreshInput = {
  account: Address;
  deadline: bigint;
  steps: readonly PlannedStep[];
  /** **鏈上** strategy id（`enrollment.strategyId`），不是 DB 的 `strategies.id`。 */
  strategyId: bigint;
  executor: Address;
};

export type SchedulerDeps = {
  yieldRound?: typeof runYieldRound;
  clock?:()=>Date;
  withDexLock?: typeof withDexLock;
  dexGate?: (chainId:number,portfolioId:number)=>Promise<string|null>;
  newMoney?: Partial<NewMoneyDeps>;
  checkTradingMinimums?: (steps: readonly PlannedStep[], purpose: 'ordinary' | 'exit', blockNumber: bigint, assetBudgetRaw?:bigint, finalAssets?:ReadonlySet<string>, rebalanceReserveRaw?:bigint) => Promise<string | null>;
  hasBoughtBefore?: (account: Address, executor: Address, blockNumber: bigint) => Promise<boolean>;
  /** Must hold exclusion from the first snapshot through settlement. null means busy. */
  withPortfolioLock?: typeof withPortfolioLock;
  priceSourceChecks?: () => Promise<PriceSourceObservation[]>;
  priceSourceTracker?: PriceSourceTracker;
  /** Checked once before each round. An unavailable RPC blocks every claimed portfolio. */
  readGlobalPaused?: () => Promise<boolean>;
  /**
   * 即使漂移低於門檻也照樣呼叫 `planRebalance`。
   *
   * 為什麼需要：`needsRebalance === false` 是「不需要再平衡」的判準，但**不是**「這個投組沒有事要做」。
   * `POST /portfolios/:id/redeem` 要按比例把部位賣成 numeraire —— 賣完權重不變、漂移不會變大，
   * 所以在對齊的投組上它會被門檻短路掉，變成永遠 noop（實測：drift 2 bps 時 redeem 回 noop）。
   */
  forcePlan?: boolean;
  /** 認領用的 DB 介面（測試換成記憶體 stub）。 */
  withTransaction?: WithTransactionFn;
  query?: SchedulerQueryFn;
  /** 讀鏈用的 chain id（smart account 的 chain_id 篩選）。 */
  chainId?: number;
  /**
   * AtpExecutor 位址（allowance 的 spender、`executeRebalance` 的 target）。省略 = 讀 `EXECUTOR_ADDRESS`。
   * dry-run 也需要它（前置檢查 b 的 spender，見檔頭 ③-bis），而預設的 planRebalance 本來就在讀。
   */
  executor?: Address;
  /**
   * 稽核快照的 writer。預設是 `snapshot.ts` 的 `writeSnapshot`；測試注入 stub 就不必真的寫 DB。
   * 失敗不會讓這一輪失敗（快照是觀測，不是這一輪的目的）。
   */
  writeSnapshot?: typeof writeSnapshotImpl;

  planPortfolio?: (portfolioId: number) => Promise<PortfolioPlan>;
  planRebalance?: (input: RebalancePlanningInput) => Promise<RebalancePlan>;
  /** live 前置檢查 a：鏈上的 permissionConfig（不看 DB 的 status）。 */
  readPermissionConfig?: (args: { account: Address; permissionId: Hex }) => Promise<PermissionInstallation>;
  /**
   * live 前置檢查 a2：`master seed + key_ref` 派生出的 EOA（**純本機運算，不碰鏈**）。
   * 省略 = 讀 `SESSION_KEY_MASTER_SEED` 自己派生。它與 DB 的 `sessionKeyAddress` 不符 → blocked。
   */
  deriveSessionKeyAddress?: (keyRef: SessionKeyRef['keyRef']) => Promise<Address>;
  /** live 前置檢查 b。 */
  readAllowance?: (args: Erc20Args) => Promise<bigint>;
  /** live 前置檢查 c。 */
  readBalance?: (args: Erc20Args) => Promise<bigint>;
  /** 真正送出的路徑。dry-run 時**一次都不會被呼叫**（測試釘住）。 */
  executeRebalance?: (args: ExecuteArgs) => Promise<ExecutionOutcome>;
  /** 送出前取得所選 Kernel permission 的實際 nonce，pending 落庫後固定使用。 */
  readRebalanceNonce?: (args: Pick<ExecuteArgs, 'account' | 'sessionKey' | 'executor'>) => Promise<bigint>;
  readLatestBlockTimestamp?: () => Promise<bigint>;
  readEntryPointNonce?: (args: { account: Address; key: bigint }) => Promise<bigint>;
  /** 只讀對帳；只有兩個 bundler 查詢明確回 null 才是 not_found。 */
  reconcileRebalance?: (input: ReconcileInput) => Promise<ReconcileResult>;
  /**
   * **送出前重問地板**。省略 = `rebalance-plan.ts` 的 `refreshFloors`（讀 `executor.oracle()` 與
   * `registry.effectiveFeeBps(strategyId)`，再對每個 step 重問 `previewSwap`）。
   *
   * ⚠ 呼叫點在 `planHashFor` **之前**：`planHash` 涵蓋 `amountOutMin`，而 `operations.payload_hash`
   * 與 `idempotency_key` 都是那個 hash。放在 `beginOperation` 之後（送出路徑裡）就等於讓 DB 記下
   * 一組從未上鏈的參數，而 `idempotency_key` 也會指到錯的那一組。
   *
   * 回 `{ ok: false }` 時呼叫端**不送**（fail closed）：問不到地板就不能假裝知道現在的下限。
   */
  refreshFloors?: (input: FloorRefreshInput) => Promise<RefreshFloorsResult>;
  log?: (line: string) => void;
};

export type RunSchedulerArgs = {
  /** HTTP single-portfolio calls omit global monitoring; background rounds retain it by default. */
  skipAlerts?: boolean;
  /** **預設 true**（省略即 dry run）。要送交易必須明確給 false。 */
  dryRun?: boolean;
  limit?: number;
  now?: Date;
  thresholdBps?: number;
};

export type SchedulerRound = {
  claimed: number;
  dryRun: boolean;
  results: PortfolioRunResult[];
};

// ---------------------------------------------------------------------------
// 純函式：排程解析 / planHash
// ---------------------------------------------------------------------------

/**
 * `strategy_versions.schedule` → 週期或「不支援」。
 *
 * `cron` 一定要回 `unsupported` 並帶上原因：目前只支援 interval，而**假裝支援** cron 會在
 * 「每一輪都不動作」與「每一輪都動作」之間選一個錯的答案，而且看不出來。靜默跳過同樣糟：
 * 一個 cron 的策略會永遠不被排程，卻沒有任何紀錄。
 */
export function parseSchedule(raw: unknown): ParsedSchedule {
  if (raw === null || raw === undefined) {
    return { kind: 'unsupported', reason: 'strategy_versions 沒有這個版本（DB 沒有鏡像到 portfolio 釘住的版本），排程週期無從取得' };
  }
  if (typeof raw !== 'object') {
    return { kind: 'unsupported', reason: `schedule 不是物件（收到 ${JSON.stringify(raw)}），排程週期無從取得` };
  }
  const schedule = raw as { kind?: unknown; intervalSeconds?: unknown; cron?: unknown };
  if (schedule.kind === 'interval') {
    const intervalSeconds = schedule.intervalSeconds;
    if (typeof intervalSeconds !== 'number' || !Number.isInteger(intervalSeconds) || intervalSeconds < MIN_INTERVAL_SECONDS) {
      return {
        kind: 'unsupported',
        reason: `schedule.intervalSeconds 必須是 >= ${MIN_INTERVAL_SECONDS} 的整數（收到 ${JSON.stringify(intervalSeconds)}）`,
      };
    }
    return { kind: 'interval', intervalSeconds };
  }
  if (schedule.kind === 'cron') {
    return {
      kind: 'unsupported',
      reason: `cron 排程尚未支援（收到 ${JSON.stringify(schedule.cron)}）：目前只實作 {kind:'interval'}，` +
        `不猜 cron 的觸發時間，也不靜默跳過`,
    };
  }
  return { kind: 'unsupported', reason: `schedule.kind 不認得：${JSON.stringify(schedule.kind)}` };
}

/**
 * `planHash`：涵蓋 `tokenIn/tokenOut/amountIn/amountOutMin/venue/data/deadline`。
 *
 * 它同時是 operations 的 `payload_hash` 與 `idempotency_key` 的一部分，所以「同樣的參數」必須
 * 得到同一個 hash（keccak256 對 abi.encode 的結果，欄位順序由 `PLAN_HASH_ABI` 固定）。
 */
export function planHashFor(steps: readonly PlannedStep[], deadline: bigint): Hex {
  return keccak256(
    encodeAbiParameters(PLAN_HASH_ABI, [
      steps.map((step) => ({
        tokenIn: step.tokenIn,
        tokenOut: step.tokenOut,
        amountIn: step.amountIn,
        amountOutMin: step.amountOutMin,
        venue: step.venue, data: step.data,
      })),
      deadline,
    ]),
  );
}

/** operations 的防重複鍵：同一個 portfolio 的同一組參數只會有一列。 */
export function idempotencyKeyFor(portfolioId: number, planHash: Hex): string {
  return `rebalance:${portfolioId}:${planHash}`;
}

// ---------------------------------------------------------------------------
// 認領
// ---------------------------------------------------------------------------

/**
 * 到期判定 + 認領。
 *
 * 條件：`schedule_state = 'active'` 且（`next_run_at is null` 或 `next_run_at <= now`）。
 * `idle`／`paused` 一律不會被選到；`next_run_at` 為 NULL 的 active = 立刻到期（新 portfolio 不被漏掉）。
 *
 * `FOR UPDATE OF p SKIP LOCKED`：兩個排程器行程同時跑也不會認領到同一列——後到的那個直接跳過
 * 被鎖住的列，而不是等它。鎖在 transaction 結束時釋放，而 `next_run_at` 已經在**commit 之前**
 * 推進，所以「認領」與「已經排到下一輪」是同一個原子事件。
 */
export const SCHEDULER_ACTIVE_PREDICATE = `where (p.schedule_state = 'active' or (sv.execution_schema_version in (1,2) and p.schedule_state = 'paused'
     and exists(select 1 from strategy_jobs j where j.portfolio_id=p.id and j.state in ('reserved','running','unknown','paused'))))`;
const SQL_CLAIM_DUE = `
  select p.id as portfolio_id,
         p.strategy_id,
         sa.address,
         sa.account_type,
         sv.schedule, sv.execution, sv.execution_schema_version, p.version, p.schedule_state
    from portfolios p
    join smart_accounts sa
      on sa.portfolio_id = p.id
     and sa.chain_id = $2
    left join strategy_versions sv
      on sv.strategy_id = p.strategy_id
     and sv.version = p.version
   ${SCHEDULER_ACTIVE_PREDICATE}
     and (p.next_run_at is null or p.next_run_at <= $1)
   order by p.next_run_at asc nulls first, p.id asc
   limit $3
     for update of p skip locked
`;

/** 認領列的下一次執行時間：單一 statement 寫回，避免 N 次往返（仍在同一個 transaction 內）。 */
const SQL_ADVANCE_CLAIMED = `
  update portfolios p
     set next_run_at = claimed.next_run_at
    from (select * from unnest($1::bigint[], $2::timestamptz[]) as t(id, next_run_at)) as claimed
   where p.id = claimed.id
`;

function assertLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(`limit 必須是正整數（收到 ${JSON.stringify(limit)}）`);
  }
  return limit;
}

function toInteger(value: unknown, what: string): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) throw new Error(`${what} 不是整數（收到 ${JSON.stringify(value)}）`);
  return parsed;
}

function asAddress(value: unknown, what: string): Address {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${what} 不是 0x + 40 hex 的地址（收到 ${JSON.stringify(value)}）`);
  }
  return value.toLowerCase() as Address;
}

/**
 * `smart_accounts.account_type` 的形狀檢查。
 *
 * 認不出來時回 `(missing)` 而不是拋錯：欄位缺失的意思是「不知道它是不是 KERNEL」，而下游把它
 * 當成**非 KERNEL** → blocked。寧可擋下一個型別不明的帳戶，也不要對它送一筆注定失敗的 op，
 * 更不要讓一整輪因為一列壞資料而停擺。
 */
function asAccountType(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : '(missing)';
}

/** `claimDuePortfolios` 的選項。 */
export type ClaimOptions = {
  withTransaction?: WithTransactionFn;
  chainId?: number;
  /**
   * 認領時要不要把 `next_run_at` 推進到 `now + intervalSeconds`（**預設 true**）。
   *
   * `false` = 只讀不寫，只有 dry-run 用。live 一定要 `true`：推進與認領在同一個 transaction 內
   * 才是「不會重複執行」的全部證據（見檔頭 ①）。
   */
  advance?: boolean;
};

/**
 * 認領到期的 portfolio，並在**同一個 transaction 內**把 `next_run_at` 推進。
 *
 * 回傳的每一列都帶著「下一次執行時間」（`nextRunAt`），所以「這一輪跑完之後它什麼時候再跑」
 * 不必再查一次 DB，而且推進與認領是同一個 commit。
 *
 * ## 為什麼 dry-run 不推進（`advance: false`）
 *
 * 推進 = 把這個 portfolio 的下一次到期時間往後推一整個 interval。live 這樣做是為了防重複執行
 * （認領即推進，見檔頭 ①），但 dry-run 是在**觀察**：用 dry-run 當監控時，推進一次就等於
 * 「今天不做」（本專案 86400 秒）。所以 dry-run 連那一條 `UPDATE` 都不發，`next_run_at` 一位都不動。
 *
 * 權衡（刻意接受）：dry-run 不推進，所以連續跑兩次 dry-run 會看到**同樣的** portfolio。那是
 * 正確且可預期的 —— 觀察不該改變被觀察的系統；「這一輪該跑誰」這個問題的答案本來就不該被
 * 「我剛看過」改變。live 的語意則完全不變：認領與推進仍然一起 commit。
 */
export async function claimDuePortfolios(
  limit: number,
  now: Date = new Date(),
  deps: ClaimOptions = {},
): Promise<DuePortfolio[]> {
  assertLimit(limit);
  const run = deps.withTransaction ?? defaultWithTransaction;
  const chainId = deps.chainId ?? getConfig().chainId;
  const advance = deps.advance ?? true;

  return run(async (client) => {
    const claimed: DuePortfolio[] = [];
    const rows = (await client.query(SQL_CLAIM_DUE, [now, chainId, limit])).rows;

    for (const row of rows) {
      const typed = row as {
        portfolio_id?: unknown;
        strategy_id?: unknown;
        address?: unknown;
        account_type?: unknown;
        schedule?: unknown;
        execution?: {kind?:unknown}; execution_schema_version?:unknown; version?:unknown; schedule_state?:unknown;
      };
      const portfolioId = toInteger(typed.portfolio_id, 'portfolios.id');
      const strategyId = toInteger(typed.strategy_id, 'portfolios.strategy_id');
      const account = asAddress(typed.address, 'smart_accounts.address');
      const accountType = asAccountType(typed.account_type);
      const executionKind = typed.execution_schema_version === 2 && typed.execution?.kind==='per_asset' ? 'per_asset' : typed.execution_schema_version === 1 && (typed.execution?.kind === 'hold'||typed.execution?.kind === 'stack') ? typed.execution.kind : undefined;
      const schedule = executionKind ? { kind: 'interval' as const, intervalSeconds: 60 } : parseSchedule(typed.schedule);
      const intervalSeconds =
        schedule.kind === 'interval' ? schedule.intervalSeconds : UNSUPPORTED_SCHEDULE_BACKOFF_SECONDS;

      claimed.push({
        ...(executionKind === undefined ? {} : { executionKind, version: toInteger(typed.version,'portfolios.version'), scheduleState: String(typed.schedule_state) }),
        portfolioId,
        strategyId,
        account,
        accountType,
        intervalSeconds,
        unsupportedReason: typed.execution_schema_version===1&&typed.execution?.kind==='stack'?'legacy stack is reconciliation-only':schedule.kind === 'unsupported' ? schedule.reason : null,
        // 與 SQL_ADVANCE_CLAIMED 寫下去的值逐位相同：回傳值不是另外算的，是同一份資料。
        // advance = false（dry-run）時這個值**不會**被寫入：DB 的 next_run_at 一位都不動。
        nextRunAt: new Date(now.getTime() + intervalSeconds * 1_000),
      });
    }

    if (advance && claimed.length > 0) {
      // ⚠ 這一行發生在 transaction **結束之前**：認領與推進一起 commit，中途 crash 就兩者都沒發生。
      // advance = false（dry-run）時整條 UPDATE 都不發：dry-run 只讀不寫，連「碰一下」都不做。
      await client.query(SQL_ADVANCE_CLAIMED, [
        claimed.map((due) => due.portfolioId),
        claimed.map((due) => due.nextRunAt.toISOString()),
      ]);
    }

    return claimed;
  });
}

// ---------------------------------------------------------------------------
// 每輪結果的落地（last_checked_at / last_rebalance_at）
// ---------------------------------------------------------------------------

const SQL_MARK_CHECKED = `
  update portfolios
     set last_checked_at = $2,
         last_rebalance_at = case when $3 then $2 else last_rebalance_at end
   where id = $1
`;

// ---------------------------------------------------------------------------
// operations 的生命週期（§5）
// ---------------------------------------------------------------------------

const SQL_INSERT_OPERATION = `
  insert into operations (portfolio_id, type, state, idempotency_key, payload_hash, attempts, updated_at, deadline, user_op_nonce)
  values ($1, 'rebalance', 'pending', $2, $3, 1, now(), $4, $5)
  on conflict (idempotency_key) do nothing
  returning attempts
`;

const SQL_GET_OPERATION = 'select state, attempts from operations where idempotency_key = $1';

// 不依賴 planHash（deadline／價格變了仍擋）。也保護舊版將已送出操作誤寫成 failed 的列。
const SQL_UNRESOLVED_OPERATIONS = `
  select idempotency_key, payload_hash, state, user_op_hash, tx_hash, deadline, user_op_nonce, strategy_job_id, strategy_batch_index, to_jsonb(operations)->>'yield_execution_key' as yield_execution_key
    from operations
   where portfolio_id = $1
     and (state in ('pending', 'submitted')
          or (state = 'failed' and (user_op_hash is not null or tx_hash is not null)))
   order by id
`;

type UnresolvedOperation = {
  yield_execution_key?:string|null;
  strategy_job_id?: string | null; strategy_batch_index?: number | null;
  idempotency_key: string;
  payload_hash: Hex;
  state: string;
  user_op_hash: Hex | null;
  tx_hash: Hex | null;
  deadline: Date | null;
  user_op_nonce: string | null;
};

export type ReconcileResult =
  | { kind: 'found'; outcome: ExecutionOutcome }
  | { kind: 'not_found' }
  | { kind: 'incomplete'; reason: string };

export type ReconcileInput = {
  trackCash?:Address;
  expectedInputs?: InputVector;
  cash?: Address;
  account: Address;
  executor: Address;
  chainId: number;
  userOpHash: Hex;
  txHash: Hex | null;
  payloadHash: Hex;
};

async function unresolvedOperations(query: SchedulerQueryFn, portfolioId: number): Promise<UnresolvedOperation[]> {
  return (await query(SQL_UNRESOLVED_OPERATIONS, [portfolioId])).rows as UnresolvedOperation[];
}

/**
 * 重試的 compare-and-swap：只有 `failed`/`reverted` 會被改成 `pending` 並把 attempts +1。
 * 兩個行程同時想重試同一個 key，只有一個會拿到 row（另一個的 where 已經不成立）。
 */
const SQL_RETRY_OPERATION = `
  update operations
     set state = 'pending',
         deadline = $2,
         user_op_nonce = $3,
         attempts = attempts + 1,
         last_error = null,
         tx_hash = null,
         user_op_hash = null,
         updated_at = now()
   where idempotency_key = $1
     and state in ('failed', 'reverted')
  returning attempts
`;

const SQL_MARK_SUBMITTED = `
  update operations
     set state = 'submitted',
         user_op_hash = coalesce($2, user_op_hash),
         tx_hash = coalesce($3, tx_hash),
         updated_at = now()
   where idempotency_key = $1
     and state in ('pending', 'submitted')
`;

const SQL_SETTLE_OPERATION = `
  update operations
     set state = $2,
         tx_hash = coalesce($3, tx_hash),
         user_op_hash = coalesce($4, user_op_hash),
         last_error = $5,
         updated_at = now()
   where idempotency_key = $1
     and state <> 'expired'
  returning idempotency_key
`;

/**
 * 送出前的閘門：可以送（含 attempts）或不可以送（附原因與該記成哪一種結果）。
 *
 * 「不可以送」有兩種，混在一起會讓 CLI 摘要說謊：
 *   * `confirmed`（這一組參數早就成功了）→ **noop**：真的不需要動。
 *   * `pending`/`submitted`（結果未知）或狀態被別人改掉 → **blocked**：需要人看一眼，
 *     不是「不需要動」。
 */
type OperationGate =
  | { proceed: true; attempts: number; operationKey?: string }
  | { proceed: false; outcome: 'noop' | 'blocked'; reason: string };

/**
 * 決定這個 idempotency_key 現在能不能送。
 *
 *   * insert 成功 → 新的一列（attempts = 1），可以送。
 *   * `confirmed` → 同一個 plan 已經上鏈成功，**永不再送**。
 *   * `pending`/`submitted` → 在途或結果未知，**不重送**：結果未知時重送的代價是重複動錢。
 *   * `failed`/`reverted` → 上一次沒有成交，允許重試（CAS +1 attempts）。
 *   * `expired` → 舊 plan 已安全釋放，必須使用新計畫的 key，不能重試。
 */
async function beginOperation(
  query: SchedulerQueryFn,
  args: { portfolioId: number; idempotencyKey: string; payloadHash: Hex; deadline: string; nonce: bigint },
): Promise<OperationGate> {
  const unresolved = await unresolvedOperations(query, args.portfolioId);
  if (unresolved.length > 0) {
    return { proceed: false, outcome: 'blocked', reason: `portfolio 還在 ${unresolved[0]!.state}，先對帳，不重送` };
  }
  const inserted = await query(SQL_INSERT_OPERATION, [args.portfolioId, args.idempotencyKey, args.payloadHash, args.deadline, args.nonce.toString()]);
  if (inserted.rows.length > 0) {
    return { proceed: true, attempts: toInteger((inserted.rows[0] as { attempts?: unknown }).attempts, 'operations.attempts') };
  }

  const existing = (await query(SQL_GET_OPERATION, [args.idempotencyKey])).rows[0] as
    | { state?: unknown; attempts?: unknown }
    | undefined;
  if (existing === undefined) {
    return {
      proceed: false,
      outcome: 'blocked',
      reason: `operations(${args.idempotencyKey}) 插入被略過、又查不到那一列：拒絕在狀態不明的情況下送交易`,
    };
  }
  const state = String(existing.state);
  if (state === 'confirmed') {
    return {
      proceed: false,
      outcome: 'noop',
      reason: `這組參數已經 confirmed 過（idempotency_key ${args.idempotencyKey}），不重複執行`,
    };
  }
  if (state === 'pending' || state === 'submitted') {
    return {
      proceed: false,
      outcome: 'blocked',
      reason: `這組參數的 operations 還在 ${state}（結果未知，重送等於重複動錢），這一輪不送；需要人確認那一筆的結果`,
    };
  }

  if (state === 'expired') {
    return { proceed: false, outcome: 'blocked', reason: '這組參數已安全釋放為 expired，須重新規劃新的 idempotency_key，不能重試舊 key' };
  }

  const retried = (await query(SQL_RETRY_OPERATION, [args.idempotencyKey, args.deadline, args.nonce.toString()])).rows[0] as { attempts?: unknown } | undefined;
  if (retried === undefined) {
    return {
      proceed: false,
      outcome: 'blocked',
      reason: `operations 的狀態在這一段時間內被改掉了（${state} → 不是 failed/reverted），這一輪不送`,
    };
  }
  return { proceed: true, attempts: toInteger(retried.attempts, 'operations.attempts') };
}

// ---------------------------------------------------------------------------
// live 前置檢查（§4）
// ---------------------------------------------------------------------------

/** 一項前置檢查的失敗。`code` 進結果，`detail` 給人看。 */
type PrecheckFailure = {
  code:
    | 'SESSION_KEY_NOT_INSTALLED'
    | 'SESSION_KEY_DERIVATION_MISMATCH'
    | 'SESSION_KEY_DERIVATION_FAILED'
    | 'ALLOWANCE_TOO_LOW'
    | 'INSUFFICIENT_BALANCE';
  detail: string;
};

const SQL_ACTIVE_SESSION_KEYS = `
  select k.key_ref, k.permissions, sa.owner
    from session_keys k
    join smart_accounts sa
      on sa.portfolio_id = k.portfolio_id
     and sa.chain_id = $2
   where k.portfolio_id = $1
     and k.status = 'active'
     and k.expires_at > now()
   order by (split_part(k.key_ref, '/', 6))::bigint desc
`;

/**
 * 前置檢查 a：挑一把**鏈上真的裝好了**的 session key。
 *
 * ⚠ `permissionConfig` 要讀的是 **smart account**（`planPortfolio` 的 `account`），不是 `owner`
 * ——owner 是控制帳戶的 EOA，它身上沒有這個函式。`owner` 只有在簽章時（sudo 的空帳號）才用得到。
 *
 * 一定要讀鏈：DB 的 `status='active'` 不代表鏈上裝好了（docs/pitfalls §8.11），而且本專案實測過
 * 「最新那把沒安裝、舊的那把可用」（§8.11 的 ⚠）。所以由新到舊逐把驗 `permissionConfig(pid).signer`，
 * 第一個通過的才用；全部不通過就 blocked。
 *
 * ⚠ `signer` 是 **validator 合約位址**，不是 session key 的 EOA（§8.10）：這裡只證明「這組 policy
 * 已安裝」，不證明「綁的是這把 key」。後者只有真的送一筆 op 才會知道——而那正是接下來的事。
 */
async function resolveSessionKey(
  args: { portfolioId: number; account: Address; chainId: number },
  deps: { query: SchedulerQueryFn; readPermissionConfig: NonNullable<SchedulerDeps['readPermissionConfig']> },
): Promise<SessionKeyResolution> {
  const rows = (await deps.query(SQL_ACTIVE_SESSION_KEYS, [args.portfolioId, args.chainId])).rows;
  if (rows.length === 0) {
    return { ok: false, reason: 'DB 沒有未過期的 active session key（沒有列，不是「沒安裝」）' };
  }

  const tried: string[] = [];
  const typedRows = rows as { key_ref?: unknown; permissions?: unknown; owner?: unknown }[];
  for (const row of typedRows) {
    const keyRef = typeof row.key_ref === 'string' ? row.key_ref : '';
    if (!/^m\/44'\/60'\/0'\/0\/\d+$/.test(keyRef)) {
      tried.push(`${keyRef || '(空 key_ref)'}：派生路徑格式不對`);
      continue;
    }
    const permissions = row.permissions as
      | { permissionId?: unknown; sessionKeyAddress?: unknown; timestamp?: { validUntil?: unknown } }
      | null
      | undefined;
    const permissionId = permissions?.permissionId;
    const sessionKeyAddress = permissions?.sessionKeyAddress;
    const validUntilRaw = permissions?.timestamp?.validUntil;
    if (typeof permissionId !== 'string' || !/^0x[0-9a-fA-F]{8}$/.test(permissionId)) {
      tried.push(`${keyRef}：permissions.permissionId 不是 4 bytes hex`);
      continue;
    }
    if (typeof sessionKeyAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(sessionKeyAddress)) {
      tried.push(`${keyRef}：permissions.sessionKeyAddress 不是地址`);
      continue;
    }
    const validUntil = Number(validUntilRaw);
    if (!Number.isInteger(validUntil)) {
      tried.push(`${keyRef}：permissions.timestamp.validUntil 不是整數`);
      continue;
    }

    const owner = asAddress(row.owner, 'smart_accounts.owner');
    const installed = await deps.readPermissionConfig({
      account: args.account,
      permissionId: permissionId as Hex,
    });
    const zeroSigner = installed.signer === '0x0000000000000000000000000000000000000000';
    if (zeroSigner || installed.policyCount !== EXPECTED_POLICY_COUNT) {
      tried.push(`${keyRef}(${permissionId})：signer=${installed.signer} policies=${installed.policyCount}（要 ${EXPECTED_POLICY_COUNT}）`);
      continue;
    }

    return {
      ok: true,
      key: {
        keyRef: keyRef as `m/44'/60'/${string}`,
        permissionId: permissionId as Hex,
        sessionKeyAddress: sessionKeyAddress.toLowerCase() as Address,
        validUntil,
        owner,
        ...(args.chainId === 97 && yieldAuthorization(row.permissions, args.account, TESTNET_97.contracts.executor).status === 'ready' ? { yieldAccount: args.account } : {}),
      },
    };
  }

  return {
    ok: false,
    reason: `DB 有 ${rows.length} 把 active session key，但鏈上沒有一把安裝完整：${tried.join('；')}`,
  };
}

/**
 * 前置檢查 a2：DB 記的 `sessionKeyAddress` 必須等於 `master seed + key_ref` 派生出的 EOA。
 *
 * 為什麼要搬到這裡（而不是留給送出時的三方對帳）：送出時的對帳發生在 `beginOperation` **之後**，
 * 所以一個打錯的 seed 會被記成 `operations(state=failed, attempts=1)` —— 語意是「試過了但失敗」，
 * 而真相是「**根本沒試**」。連續 `--loop` 就會每輪燒一次 attempt，而且監控上再也分不出「設定錯誤」
 * 與「這一筆失敗」。派生是純本機運算，所以在 blocked 階段驗得到，一列 `operations` 都不必寫。
 *
 * ⚠ 只對**已經選定的那把**驗（呼叫端在 `resolveSessionKey` 成功之後才呼叫）。對每一把都派生會把
 * 真正可用的那把也擋掉：由新到舊逐把驗的是「這一組 policy 在鏈上裝好了沒」，而 seed 只會派生得出
 * 其中一把，其他把本來就不會相符。
 */
async function checkSessionKeyDerivation(
  key: SessionKeyRef,
  derive: NonNullable<SchedulerDeps['deriveSessionKeyAddress']>,
): Promise<PrecheckFailure | null> {
  let derived: Address;
  try {
    derived = await derive(key.keyRef);
  } catch (error) {
    return {
      code: 'SESSION_KEY_DERIVATION_FAILED',
      detail:
        `用 SESSION_KEY_MASTER_SEED 派生 ${key.keyRef} 失敗（seed 沒設／不是 0x + 64 hex）：${oneLine(error)}` +
        `——這是設定問題，不是「這一輪試過了」`,
    };
  }
  if (!isAddressEqual(derived, key.sessionKeyAddress)) {
    return {
      code: 'SESSION_KEY_DERIVATION_MISMATCH',
      detail:
        `seed + ${key.keyRef} 派生得 ${derived}，DB 記的 session key 是 ${key.sessionKeyAddress}` +
        `（seed 打錯／換了 KMS／複製貼上少一個字元）：簽章一定不過，這一輪不送`,
    };
  }
  return null;
}

export type SessionKeyDerivationReport = {
  /** 所有候選帳戶都讀取完成；false 時不能據此新增或解除 seed 警示。 */
  complete: boolean;
  checked: number;
  mismatchedPortfolioIds: number[];
  /** 派生失敗或單戶資料／讀鏈失敗；preflight 一律判 fail。 */
  failedPortfolioIds: number[];
  unavailable: number;
};

type SessionKeyCheckDeps = Pick<SchedulerDeps, 'query' | 'readPermissionConfig' | 'deriveSessionKeyAddress'>;

/**
 * 所有本鏈 active Kernel 帳戶都查，包含還沒到排程時間的帳戶。
 * 與執行前共用 resolveSessionKey：只比對最新且鏈上已安裝的那把，避免續期後殘留的舊 key 誤報。
 * 單戶讀取失敗計入 failed 並繼續，標示 complete=false；候選清單讀取失敗仍拋錯。
 * 呼叫端不能把「這輪沒查成」當作問題已解除，也不能用不完整報告新增 seed 警示。
 */
export async function inspectSessionKeyDerivation(
  chainId: number,
  deps: SessionKeyCheckDeps = {},
): Promise<SessionKeyDerivationReport> {
  const resolved = resolveDeps({ thresholdBps: DEFAULT_THRESHOLD_BPS }, { ...deps, chainId });
  const { rows } = await resolved.query(`
    select sa.portfolio_id, sa.address
      from smart_accounts sa
      join portfolios p on p.id = sa.portfolio_id
     where sa.chain_id = $1
       and sa.account_type = 'KERNEL'
       and p.schedule_state = 'active'
       and exists (
         select 1 from session_keys k
          where k.portfolio_id = p.id and k.status = 'active' and k.expires_at > now()
       )
     order by sa.portfolio_id
  `, [chainId]);
  const report: SessionKeyDerivationReport = {
    complete: true, checked: 0, mismatchedPortfolioIds: [], failedPortfolioIds: [], unavailable: 0,
  };
  for (const row of rows) {
    const fields = row as { portfolio_id: unknown; address: unknown };
    const portfolioId = Number(fields.portfolio_id);
    if (!Number.isSafeInteger(portfolioId) || portfolioId <= 0) throw new Error('portfolio_id 不是有效整數');
    try {
      const account = asAddress(fields.address, 'smart_accounts.address');
      const resolution = await resolveSessionKey({ portfolioId, account, chainId }, resolved);
      if (!resolution.ok) {
        report.unavailable += 1;
        continue;
      }
      report.checked += 1;
      const failure = await checkSessionKeyDerivation(resolution.key, resolved.deriveSessionKeyAddress);
      if (failure?.code === 'SESSION_KEY_DERIVATION_MISMATCH') report.mismatchedPortfolioIds.push(portfolioId);
      if (failure?.code === 'SESSION_KEY_DERIVATION_FAILED') report.failedPortfolioIds.push(portfolioId);
    } catch {
      report.complete = false;
      report.failedPortfolioIds.push(portfolioId);
    }
  }
  return report;
}

/** 僅含計數與 portfolio id；不把 seed、私鑰或派生例外帶入 preflight／Telegram。 */
export function sessionKeyDerivationDetail(report: SessionKeyDerivationReport): string {
  const ids = [...report.mismatchedPortfolioIds, ...report.failedPortfolioIds];
  return `檢查 ${report.checked} 把 session key：${report.mismatchedPortfolioIds.length} 把不符、` +
    `${report.failedPortfolioIds.length} 個帳戶派生或讀取失敗、${report.unavailable} 個帳戶無已安裝的可用 key` +
    (ids.length === 0 ? '' : `（portfolio ${ids.slice(0, 10).join(', ')}${ids.length > 10 ? ', …' : ''}）`);
}

/**
 * 前置檢查 a + a2 + b + c：對**每一個 step** 檢查 allowance 與餘額（amountIn 是原幣單位）。
 *
 * ⚠ 呼叫端有**兩個**（live 與 dry-run），而且順序在 `beginOperation` 之前就固定了（檔頭 ③-bis）：
 * dry-run 的 `ready` 只有在這四條全過之後才會出現。要搬動這個呼叫，先讀檔頭 ③-bis。
 */
async function runPrechecks(
  args: {
    portfolioId: number;
    account: Address;
    executor: Address;
    steps: readonly PlannedStep[];
    chainId: number;
  },
  deps: {
    query: SchedulerQueryFn;
    readPermissionConfig: NonNullable<SchedulerDeps['readPermissionConfig']>;
    deriveSessionKeyAddress: NonNullable<SchedulerDeps['deriveSessionKeyAddress']>;
    readAllowance: NonNullable<SchedulerDeps['readAllowance']>;
    readBalance: NonNullable<SchedulerDeps['readBalance']>;
  },
): Promise<{ failures: PrecheckFailure[]; sessionKey: SessionKeyRef | null }> {
  const resolution = await resolveSessionKey(
    { portfolioId: args.portfolioId, account: args.account, chainId: args.chainId },
    { query: deps.query, readPermissionConfig: deps.readPermissionConfig },
  );
  if (!resolution.ok) {
    return { failures: [{ code: 'SESSION_KEY_NOT_INSTALLED', detail: resolution.reason }], sessionKey: null };
  }

  // 前置檢查 a2：seed 派生不出 DB 記的那把 → blocked（**不是** failed），operations 一列都不寫。
  const derivationFailure = await checkSessionKeyDerivation(resolution.key, deps.deriveSessionKeyAddress);
  if (derivationFailure !== null) return { failures: [derivationFailure], sessionKey: null };

  const failures: PrecheckFailure[] = [];
  for (const [index, step] of args.steps.entries()) {
    const allowance = await deps.readAllowance({ token: step.tokenIn, owner: args.account, spender: args.executor });
    if (allowance < step.amountIn) {
      failures.push({
        code: 'ALLOWANCE_TOO_LOW',
        detail:
          `step#${index} allowance(${args.account} → executor ${args.executor}, token ${step.tokenIn}) = ${allowance} ` +
          `< amountIn ${step.amountIn}：執行器的 safeTransferFrom 一定 revert`,
      });
    }
    const balance = await deps.readBalance({ token: step.tokenIn, owner: args.account });
    if (balance < step.amountIn) {
      failures.push({
        code: 'INSUFFICIENT_BALANCE',
        detail: `step#${index} balanceOf(${step.tokenIn}, ${args.account}) = ${balance} < amountIn ${step.amountIn}`,
      });
    }
  }
  return { failures, sessionKey: resolution.key };
}

// ---------------------------------------------------------------------------
// live 送出（預設實作；本工單不實際執行）
// ---------------------------------------------------------------------------

/**
 * 用 session key 簽一筆 `executeRebalance` 並送 alto。
 *
 * 這一段是 `backend/scripts/execute-rebalance.ts`（已實測成功換幣）的同一條路，搬進 src 是為了
 * 讓排程器的 live 路徑**也被 typecheck 覆蓋**。三個步驟與那支腳本逐項相同：
 *   ① 由 DB 的 `key_ref` 用 master seed 派生金鑰，三方對帳（派生器 / 腳本 / DB）一致才用；
 *   ② 用同一組 `validUntil` 重建權限，permissionId 必須與 DB 相同（不同就是 policy 參數變了）；
 *   ③ 帳戶的 sudo 只給 owner 的**空帳號**（本行程沒有 owner 的私鑰），真正簽章的是 regular
 *      （permission validator）——那正是「keeper 用 session key 執行」的意思。
 *
 * 送出前後各有一道防線，兩道都對應 `docs/pitfalls` §8.16 的實測：
 *   * **送出前**：`callGasLimit` 明確覆寫成 `max(估算 × 1.5, 600,000)`，再用 `eth_call`
 *     以 `gas = 那個值` 模擬一次執行。不通過就不簽名 —— 不花錢買 `success = false`。
 *   * **送出後**：`judgeRebalanceOutcome` 三層判定。`tx.status == 1` 單獨不足以叫成功。
 */
export async function sessionKernelAccount(args: Pick<ExecuteArgs, 'account' | 'sessionKey' | 'executor'>, publicClient = defaultPublicClient()) {
  const { masterSeed } = requireSessionKeyConfig();

  const keyAccount = hdKeyToAccount(HDKey.fromMasterSeed(hexToBytes(masterSeed)), { path: args.sessionKey.keyRef });
  if (!isAddressEqual(keyAccount.address, args.sessionKey.sessionKeyAddress)) {
    throw new Error(
      `派生不一致：seed + ${args.sessionKey.keyRef} 得到 ${keyAccount.address}，` +
        `DB 記的 session key 是 ${args.sessionKey.sessionKeyAddress}`,
    );
  }

  const permissions = await buildSessionPermissions({
    publicClient,
    sessionKeyAddress: keyAccount.address,
    executorAddress: args.executor,
    validUntil: args.sessionKey.validUntil,
    ...(args.sessionKey.yieldAccount === undefined ? {} : { yieldAccount: args.sessionKey.yieldAccount }),
    signer: await toECDSASigner({ signer: keyAccount, ...(publicClient.chain?.id === 97 ? { signerContractAddress: getAddress(TESTNET_97.contracts.ecdsaSigner) } : {}) }),
  });
  if (permissions.permissionId.toLowerCase() !== args.sessionKey.permissionId.toLowerCase()) {
    throw new Error(
      `permissionId 不符：重建 ${permissions.permissionId} != DB ${args.sessionKey.permissionId}` +
        `（validUntil 或 policy 參數變了）`,
    );
  }

  const kernelVersion: GetKernelVersion<'0.7'> = KERNEL_V3_3;
  const account = await createKernelAccount(publicClient, {
    address: args.account,
    plugins: {
      sudo: await signerToEcdsaValidator(publicClient, {
        signer: addressToEmptyAccount(args.sessionKey.owner),
        entryPoint: ENTRY_POINT,
        kernelVersion,
        validatorAddress: kernelAddressesForChain(publicClient.chain?.id ?? await publicClient.getChainId()).ecdsaValidatorV31,
      }),
      regular: permissions.permissionValidator,
    },
    entryPoint: ENTRY_POINT,
    kernelVersion,
    useMetaFactory: true,
  });
  if (!isAddressEqual(account.address, args.account)) {
    throw new Error(`帳戶地址不符：算出 ${account.address} != 已部署 ${args.account}`);
  }

  return account;
}

async function sendRebalanceWithSessionKey(args: ExecuteArgs): Promise<ExecutionOutcome> {
  const publicClient = defaultPublicClient();
  let paymaster: ReturnType<typeof schedulerPaymaster>;
  let budgetKey: string | null = null;
  try {
    const network = activeChain();
    const account = await sessionKernelAccount(args);
    const data = encodeFunctionData({
      abi: EXECUTOR_ABI,
      functionName: 'executeRebalance',
      args: [
        args.account,
        args.steps.map((step) => ({
          tokenIn: step.tokenIn,
          tokenOut: step.tokenOut,
          amountIn: step.amountIn,
          amountOutMin: step.amountOutMin,
          venue: step.venue,
          data: step.data,
        })),
        args.deadline,
      ],
    });
    if (data.slice(0, 10) !== EXECUTE_REBALANCE_SELECTOR) {
      throw new Error(`selector 不符：${data.slice(0, 10)} != ${EXECUTE_REBALANCE_SELECTOR}（CallPolicy 會擋下）`);
    }

    const calls = [{ to: args.executor, data, value: 0n }] as const;
    const callData = await account.encodeCalls(calls);
    paymaster = schedulerPaymaster(args.account, args.gasPurpose === 'exit' ? { exitCallData: callData } : {});
    const client = createKernelAccountClient({
      account,
      paymaster,
      chain: network,
      client: publicClient,
      bundlerTransport: http(bundlerUrl()),
      // alto 不提供 ZeroDev 的 zd_getUserOperationGasPrice，用節點 gas price。
      userOperation: {
        estimateFeesPerGas: async () => {
          const gasPrice = await publicClient.getGasPrice();
          return { maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice };
        },
      },
    });


    // ---- ① gas：`callGasLimit` 明確覆寫，不讓 alto 的估算單獨決定 ---------------------------------
    // alto 對「一筆 op 跑完整條 DeFi 路徑」系統性低估（§8.16 實測 367,885 vs 需要 450–500k），
    // 而 gas 不足的後果不是 revert，是「success = false 但 tx.status = 1」—— 錢扣了、幣沒換。
    const estimate = await client.estimateUserOperationGas({ calls, nonce: args.nonce,
      ...(paymaster === undefined ? {} : { paymaster: estimationPaymaster(paymaster) }) });
    let numeraire: Address;
    try {
      numeraire = await publicClient.readContract({ address: args.executor, abi: EXECUTOR_BUY_ABI, functionName: 'numeraire' });
    } catch { throw new Error('[NUMERAIRE_UNAVAILABLE] 送出前讀不到 executor.numeraire，不送交易'); }
    const hasBuy = args.steps.some((step) => !isAddressEqual(step.tokenOut, numeraire));
    const valuationAssetCount = hasBuy ? new Set(args.valuationAssets.filter((asset) => !isAddressEqual(asset, numeraire)).map((asset) => asset.toLowerCase())).size : 0;
    // On 97 the actual estimate already includes the valuation loop. Adding it a
    // second time makes a fully held 92-asset account impossible to execute.
    const desiredCallGas = rebalanceCallGasLimit(estimate.callGasLimit, network.id === 97 ? 0 : valuationAssetCount);
    const sponsorLimits = network.id === 97 ? await paymaster?.getPaymasterStubData?.({sender:args.account,chainId:network.id,
      entryPointAddress:ENTRY_POINT.address,nonce:args.nonce,callData:await account.encodeCalls(calls)}) : undefined;
    const estimatedOverhead = userOpGasOverhead(estimate,sponsorLimits);
    const callGasLimit = network.id === 97 ? boundedCallGasLimit(desiredCallGas, estimate.callGasLimit, estimatedOverhead) : desiredCallGas;
    assertUserOpCapacity(args.steps.length, callGasLimit + estimatedOverhead);
    if (hasBuy) {
      if (args.strategyId === undefined) throw new Error('[MIN_FEE_RESERVE] 缺少策略，不送買入');
      await checkBuyFeeReserve({ client: publicClient, executor: args.executor, account: args.account,
        strategyId: args.strategyId, registry: registryAddress(), steps: args.steps, numeraire,
        ...(args.feeBudget===undefined?{}:{maximumReserve:args.feeBudget}),
        blockNumber: await publicClient.getBlockNumber({ cacheTime: 0 }) });
    }

    // ---- ② 簽名前用 eth_call 模擬整格執行 ---------------------------------------------------------
    // `executeRebalance` 的第一個檢查是 `msg.sender != account → NotAccount`，所以 `from = 帳戶` 的
    // `eth_call` 走的是**真正的那條路**（帳戶本身就是 UserOp 執行時的呼叫者），不需要 state override，
    // 也不需要先 simulateValidation。gas 給的**正是等一下要簽的 callGasLimit**，所以它能抓到的就是
    // 「這個值不夠」本身，而不是一個寬鬆的「有沒有 revert」。
    //
    // 抓到什麼：執行必定失敗的原因（地板、註冊狀態、allowance、UniversalRouter 的命令/參數）＋ 粗的
    // gas 不足（需求 > callGasLimit）。抓不到什麼：比 63/64 內層保留額更小的邊緣 gas 不足，以及
    // **驗證階段**的問題（session key 的權限、nonce、prefund）—— 那些發生在 EntryPoint 那一層，
    // 這裡的 `eth_call` 沒有經過 EntryPoint，alto 的 simulation 才會擋。兩者是互補的檢查。
    try {
      await publicClient.call({ account: args.account, to: args.executor, data, gas: callGasLimit });
    } catch (error) {
      const secondary = decodePriceSourceError(error);
      if (secondary !== null) throw error;
      throw new Error(
        `送出前的 eth_call 模擬失敗（from ${args.account}、gas ${callGasLimit}）：這一筆不送，` +
          `不花錢買一個 success=false 的 op。原因：${a10ErrorMessage(error) ?? errorMessage(error)}`,
      );
    }

    // 只覆寫 `callGasLimit`：其餘欄位（verificationGasLimit / preVerificationGas）仍由 alto 估算，
    // 它們與「執行路徑有多長」無關。
    const prepared = await client.prepareUserOperation({ calls, callGasLimit, nonce: args.nonce,
      verificationGasLimit: estimate.verificationGasLimit, preVerificationGas: estimate.preVerificationGas,
      ...(paymaster === undefined ? {} : { paymaster }) });
    assertUserOpCapacity(args.steps.length, prepared.callGasLimit + prepared.verificationGasLimit + prepared.preVerificationGas +
      (prepared.paymasterVerificationGasLimit ?? 0n) + (prepared.paymasterPostOpGasLimit ?? 0n));
    budgetKey = gasExecutionKey(network.id, { sender: args.account, nonce: args.nonce, initCode: '0x', callData: prepared.callData });
    if (paymaster === undefined) {
      const op = { sender: args.account, nonce: args.nonce, initCode: '0x' as const, callData: prepared.callData };
      const price = await existingBudgetContext(gasExecutionKey(network.id, op)) ?? await readNativeBudgetPrice(publicClient, args.executor, network.id);
      await reserveGasBudget({ ...price, executionKey: gasExecutionKey(network.id, op), chainId: network.id,
        account: getAddress(args.account).toLowerCase() as Address, purpose: args.gasPurpose ?? 'ordinary',
        gasLimit: prepared.callGasLimit + prepared.verificationGasLimit + prepared.preVerificationGas,
        maxFeePerGas: prepared.maxFeePerGas });
    }
    await assertDexLock();
    args.onSending();
    const signed = await signPreparedOperation(prepared, (operation) => account.signUserOperation(operation));
    const userOpHash = await client.sendUserOperation(signed);
    // alto 有 simulation：被拒的 op **不會**回 userOpHash。所以拿到 hash = 這一筆被接受了。
    await args.onSubmitted({ userOpHash });
    await settleGasBudget(budgetKey, 'submitted');

    const receipt = await client.waitForUserOperationReceipt({ hash: userOpHash, timeout: USER_OP_RECEIPT_TIMEOUT_MS });
    await settleGasBudget(budgetKey, receipt.success ? 'confirmed' : 'failed');

    // ---- ③ 三層判定（§8.16）：只驗 receipt.status 就是把「上鏈但什麼都沒換」記成成功 -----------------
    return judgeRebalanceOutcome({
      txStatus: receipt.receipt.status,
      userOpSuccess: typeof receipt.success === 'boolean' ? receipt.success : null,
      swapExecuted: countSwapExecuted(receipt.logs, args.executor),
      expectedSwaps: args.steps.length,
      txHash: receipt.receipt.transactionHash,
      userOpHash,
      gasUsed: (receipt.actualGasUsed ?? receipt.receipt.gasUsed).toString(),
      ...(receipt.reason === undefined ? {} : { revertReason: receipt.reason }),
    });
  } catch (error) {
    if (budgetKey !== null) await settleGasBudget(budgetKey, 'unknown').catch(() => {});
    const decoded = decodePriceSourceError(error);
    if (decoded === null) throw paymaster === undefined ? error : paymasterExecutionError(error);
    let detailed = decoded;
    try {
      const oracle = await publicClient.readContract({ address: args.executor, abi: EXECUTOR_ABI, functionName: 'oracle' });
      detailed = await describePriceSourceError(error, publicClient, { oracle, assets: args.steps.flatMap((step) => [step.tokenIn, step.tokenOut]) }) ?? decoded;
    } catch { /* Preserve the ABI failure even if diagnostic metadata cannot be read. */ }
    throw new PriceSourceError(detailed);
  }
}

// ---------------------------------------------------------------------------
// 一輪的執行
// ---------------------------------------------------------------------------

let cachedPublicClient: PublicClient | null = null;

function defaultPublicClient(): PublicClient {
  if (cachedPublicClient !== null) return cachedPublicClient;
  const { rpcUrl } = getConfig();
  // config.ts 已經把空字串（`RPC_URL=""`）收成 null：空字串不是「沒設」，`http('')` 會靜默打到別的
  // 節點（docs/pitfalls §8.12）。所以這裡 null 就是真的沒設，直接帶著變數名失敗。
  if (rpcUrl === null) {
    throw new Error('chain 未設定：排程器要讀鏈（RPC_URL 是空的——空字串等於沒設，見 docs/pitfalls §8.12）');
  }
  cachedPublicClient = createPublicClient({ chain: activeChain(), transport: http(rpcUrl) });
  return cachedPublicClient;
}

function executorAddress(): Address {
  const { executorAddress: executor } = getSessionKeyConfig();
  if (executor === null) {
    throw new Error(
      '未設定 EXECUTOR_ADDRESS：它是 AtpExecutor 的地址（planRebalance 的 recipient、allowance 的 spender），' +
        '排程器沒有它就算不出要送什麼',
    );
  }
  return executor;
}

function registryAddress(): Address {
  const { registryAddress: registry } = getConfig();
  if (registry === null) throw new Error('chain 未設定：REGISTRY_ADDRESS 是排程器讀 enrollment 的必要條件');
  return registry as Address;
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function bundlerUrl(): string {
  return firstNonEmpty(process.env.BUNDLER_URL) ?? 'http://127.0.0.1:3001';
}

const defaultWithTransaction: WithTransactionFn = (fn) =>
  withTransaction((client) => fn({ query: (text, params) => client.query(text, params === undefined ? [] : [...params]) }));

function defaultQuery(): SchedulerQueryFn {
  return (text, params) => dbQuery(text, params ?? []);
}

function oneLine(error: unknown): string {
  return (decodePriceSourceError(error)?.detail ?? a10ErrorMessage(error) ?? errorMessage(error)).split('\n')[0]!.slice(0, 400);
}

/** 把 run 的參數與外部注入的 deps 合成一組完整可用的依賴（缺的就補預設實作）。 */
const priceSourceTrackers = new Map<string, PriceSourceTracker>();

/** #76: pool outages default to six consecutive rounds; secondary feed alerts retain their threshold.
 * Counters are per asset and failure family, so RPC gaps/recovery/restarts never invent continuity.
 * Persisted critical alerts stay open until all affected assets have verified recovery.
 */
export function createSchedulerPriceSourceTracker(env: NodeJS.ProcessEnv = process.env): PriceSourceTracker {
  const raw = env.ORACLE_UNAVAILABLE_ROUNDS?.trim() || '6';
  const oracleRounds = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(oracleRounds) || oracleRounds < 1) {
    throw new Error('ORACLE_UNAVAILABLE_ROUNDS 必須是正安全整數');
  }
  const counts = new Map<string, { family: 'twap' | 'secondary'; rounds: number }>();
  return (observations, previous) => {
    const unique = new Map(observations.map((observation) => [observation.asset.toLowerCase(), observation]));
    const threshold = (failure: PriceSourceFailure) => failure.code === 'TwapUnavailable' ? oracleRounds : PRICE_SOURCE_FAILURE_ROUNDS;
    let complete = true;
    for (const [asset, observation] of unique) {
      if (!observation.verified) complete = false;
      if (!observation.verified || observation.failure === null) { counts.delete(asset); continue; }
      const family = observation.failure.code === 'TwapUnavailable' ? 'twap' : 'secondary';
      const old = counts.get(asset);
      counts.set(asset, { family, rounds: Math.min(threshold(observation.failure), (old?.family === family ? old.rounds : 0) + 1) });
    }
    for (const asset of counts.keys()) if (!unique.has(asset)) counts.delete(asset);
    const previousAssets = priceSourceAlertAssets(previous?.detail ?? '');
    if (previous !== null && previousAssets.length === 0) return { finding: previous, complete: false };
    if (previousAssets.some((asset) => !unique.has(asset.toLowerCase()))) complete = false;
    const failures = [...unique.values()].filter((observation) => observation.verified && observation.failure !== null);
    const critical = previous !== null || failures.some((observation) => observation.failure !== null &&
      (counts.get(observation.asset.toLowerCase())?.rounds ?? 0) >= threshold(observation.failure));
    const lines = failures.sort((a, b) => a.asset.toLowerCase().localeCompare(b.asset.toLowerCase())).map((observation) =>
      `asset ${observation.asset.toLowerCase()}: ${observation.failure?.detail}（連續 ${counts.get(observation.asset.toLowerCase())?.rounds ?? 0}/${observation.failure === null ? oracleRounds : threshold(observation.failure)} 輪）`);
    for (const line of previous?.detail.split('\n') ?? []) {
      const [asset] = priceSourceAlertAssets(line);
      if (asset !== undefined && unique.get(asset.toLowerCase())?.verified !== true) lines.push(line);
    }
    return { complete, finding: critical && lines.length > 0 ? {
      kind: 'price_source_unavailable', severity: 'critical', portfolioId: null,
      detail: '價格來源不可用；全部受影響資產確認恢復後才解除：\n' + lines.join('\n'),
    } : null };
  };
}

function resolveDeps(args: { thresholdBps: number }, provided: SchedulerDeps) {
  const query = provided.query ?? defaultQuery();
  const chainId = provided.chainId ?? getConfig().chainId;
  const deadlineSeconds = DEFAULT_DEADLINE_SECONDS;

  return {
    query,
    clock:provided.clock??(()=>new Date()),
    withDexLock: provided.withDexLock ?? withDexLock,
    dexGate: provided.dexGate ?? createDexGate(query, {
      transactionBlock: async (hash) => (await defaultPublicClient().getTransactionReceipt({hash})).blockNumber,
      blockNumber: () => defaultPublicClient().getBlockNumber({cacheTime:0}),
    }),
    newMoney: { ...defaultNewMoneyDeps(defaultPublicClient, () => provided.executor ?? executorAddress(), registryAddress, query, chainId), ...provided.newMoney },
    checkTradingMinimums: provided.checkTradingMinimums ?? ((steps: readonly PlannedStep[], purpose: 'ordinary' | 'exit', blockNumber: bigint, assetBudgetRaw?:bigint, finalAssets?:ReadonlySet<string>, rebalanceReserveRaw?:bigint) =>
      checkTradeMinimums(defaultPublicClient(), provided.executor ?? executorAddress(), steps, purpose, blockNumber, assetBudgetRaw, finalAssets, rebalanceReserveRaw)),
    hasBoughtBefore: provided.hasBoughtBefore ?? (async (account: Address, executor: Address, blockNumber: bigint) => {
      const [start] = await defaultPublicClient().readContract({ address: executor,
        abi: parseAbi(['function buyWindowOf(address) view returns(uint64 start,uint192 bought)']), functionName: 'buyWindowOf', args: [account], blockNumber });
      return start > 0n;
    }),
    withPortfolioLock: provided.withPortfolioLock ?? withPortfolioLock,
    chainId,
    priceSourceTracker: provided.priceSourceTracker ?? (() => {
      const key = `${chainId}:${provided.executor?.toLowerCase() ?? process.env.EXECUTOR_ADDRESS?.trim().toLowerCase() ?? 'unconfigured'}:${process.env.ORACLE_UNAVAILABLE_ROUNDS ?? '6'}`;
      let tracker = priceSourceTrackers.get(key);
      if (tracker === undefined) { tracker = createSchedulerPriceSourceTracker(); priceSourceTrackers.set(key, tracker); }
      return tracker;
    })(),
    priceSourceChecks: provided.priceSourceChecks ?? (async () => {
      const rows = chainId === 97 ? testnetAssets() : (await query("select address from priceable_assets where enabled")).rows;
      const assets = rows.map((row) => asAddress(typeof row === 'object' && row !== null ? Reflect.get(row, 'address') : null, 'priceable_assets.address'));
      const previous = await query("select detail from scheduler_alerts where kind = 'price_source_unavailable' and portfolio_id is null and resolved_at is null");
      for (const row of previous.rows) {
        if (typeof row !== 'object' || row === null || typeof Reflect.get(row, 'detail') !== 'string') throw new Error('price source alert data unavailable');
        assets.push(...priceSourceAlertAssets(Reflect.get(row, 'detail')));
      }
      if (assets.length === 0) return [];
      const client = defaultPublicClient();
      const oracle = await client.readContract({ address: provided.executor ?? executorAddress(), abi: EXECUTOR_ABI, functionName: 'oracle' });
      return inspectPriceSources(client, oracle, assets);
    }),
    readGlobalPaused: provided.readGlobalPaused ?? (() => readGlobalPaused(provided.executor ?? executorAddress(), defaultPublicClient())),
    /**
     * null = 還沒解析；`decideAndMaybeExecute` 在**兩條路**上都會 `?? executorAddress()`
     * （dry-run 的前置檢查 b 也要 spender，見檔頭 ③-bis）。
     */
    executor: provided.executor ?? null,
    withTransaction: provided.withTransaction ?? defaultWithTransaction,
    log: provided.log ?? ((line: string) => console.log(line)),
    /** 稽核快照的writer。可注入，所以排程器測試不必真的寫 DB。 */
    writeSnapshot: provided.writeSnapshot ?? writeSnapshotImpl,
    planPortfolio:
      provided.planPortfolio ??
      ((portfolioId: number) =>
        planPortfolio(portfolioId, {
          publicClient: defaultPublicClient(),
          registryAddress: registryAddress(),
          thresholdBps: args.thresholdBps,
        })),
    planRebalance:
      provided.planRebalance ??
      (async ({ account, plan, inclusiveFeeReserveRaw }: RebalancePlanningInput) => {
        const publicClient = defaultPublicClient();
        const executor = executorAddress();
        const oracle = await publicClient.readContract({
          address: executor,
          abi: EXECUTOR_ABI,
          functionName: 'oracle',
        });
        if (plan.report === null) {
          // 呼叫端已經擋掉這一種；留著是為了不讓一個 null report 靜默變成「不需要再平衡」。
          throw new Error('planPortfolio 沒有漂移報告（blocked）：不該進到規劃器');
        }
        return planRebalance({
          ...(inclusiveFeeReserveRaw===undefined?{}:{inclusiveFeeReserveRaw}),
          maxLegUsdE8: await readMaxLegUsdE8(plan.targets.map((target) => target.asset), query, chainId),
          publicClient,
          account,
          executor,
          oracle,
          registry: registryAddress(),
          strategyId: BigInt(plan.pinnedVersion.onchainStrategyId),
          holdings: plan.snapshot.holdings,
          targets: plan.targets,
          drift: plan.report,
          thresholdBps: plan.thresholdBps,
          blockNumber: plan.snapshot.block,
          deadlineSeconds,
        });
      }),
    readPermissionConfig:
      provided.readPermissionConfig ??
      (async ({ account, permissionId }: { account: Address; permissionId: Hex }) => {
        const config = await defaultPublicClient().readContract({
          address: account,
          abi: KERNEL_PERMISSION_ABI,
          functionName: 'permissionConfig',
          args: [permissionId],
        });
        return { signer: config.signer, policyCount: config.policyData.length };
      }),
    /**
     * 前置檢查 a2 的預設實作：本機派生（一次鏈上讀取都沒有）。與 `sendRebalanceWithSessionKey`
     * 用的是同一條 `HDKey.fromMasterSeed → hdKeyToAccount`，所以「這裡通過了、送出時卻不符」不可能
     * 發生在 seed 上。seed 沒設時 `requireSessionKeyConfig()` 會拋錯，由 `runPrechecks` 收成
     * `SESSION_KEY_DERIVATION_FAILED`（blocked），而不是等到送出才變成 failed。
     */
    deriveSessionKeyAddress:
      provided.deriveSessionKeyAddress ??
      (async (keyRef: SessionKeyRef['keyRef']) => {
        const { masterSeed } = requireSessionKeyConfig();
        return hdKeyToAccount(HDKey.fromMasterSeed(hexToBytes(masterSeed)), { path: keyRef }).address;
      }),
    /**
     * 送出前重問地板的預設實作：`executor.oracle()` 給報價來源、`registry.effectiveFeeBps` 給
     * `minGross` 的倍率（與 `AtpExecutor._checkStep` 用的是同一個值），再交給 `refreshFloors`。
     *
     * 任何一步讀不到就回 `{ ok: false }` 而不是拋錯：呼叫端要把這件事記成「這一輪不送」，不是讓整輪炸掉。
     * 注意這裡用的是 `registryAddress()`（不是 enrollment 的 strategyId 以外的東西）：合約在執行時
     * 問的就是這個 registry。
     */
    refreshFloors:
      provided.refreshFloors ??
      (async ({ steps, strategyId, executor, deadline, account }: FloorRefreshInput) => {
        try {
          const publicClient = defaultPublicClient();
          const [oracle, feeBpsRaw] = await Promise.all([
            publicClient.readContract({ address: executor, abi: EXECUTOR_ABI, functionName: 'oracle' }),
            publicClient.readContract({
              address: registryAddress(),
              abi: REGISTRY_ABI,
              functionName: 'effectiveFeeBps',
              args: [strategyId],
            }),
          ]);
          return await refreshFloors({ publicClient, oracle, steps, feeBps: Number(feeBpsRaw), executor, deadline,
            account, query, log: provided.log ?? console.log });
        } catch (error) {
          return {
            ok: false,
            kind: 'quote-failed',
            reason:
              `送出前重問地板的前提讀取失敗（executor.oracle() / registry.effectiveFeeBps(${strategyId})）：` +
              `${oneLine(error)}——沒有新鮮的地板就不送`,
          };
        }
      }),
    readAllowance:
      provided.readAllowance ??
      (async ({ token, owner, spender }: Erc20Args) => {
        if (spender === undefined) throw new Error('readAllowance 需要 spender（executor）');
        return defaultPublicClient().readContract({
          address: token,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [owner, spender],
        });
      }),
    readBalance:
      provided.readBalance ??
      (({ token, owner }: Erc20Args) =>
        defaultPublicClient().readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] })),
    readRebalanceNonce: provided.readRebalanceNonce ?? (async (input: Pick<ExecuteArgs, 'account' | 'sessionKey' | 'executor'>) =>
      (await sessionKernelAccount(input)).getNonce()),
    readLatestBlockTimestamp: provided.readLatestBlockTimestamp ?? (async () => (await defaultPublicClient().getBlock({ blockTag: 'latest' })).timestamp),
    readEntryPointNonce: provided.readEntryPointNonce ?? (async ({ account, key }: { account: Address; key: bigint }) =>
      defaultPublicClient().readContract({ address: ENTRY_POINT.address, abi: entryPoint07Abi,
        functionName: 'getNonce', args: [account, key] })),
    executeRebalance: provided.executeRebalance ?? sendRebalanceWithSessionKey,
    reconcileRebalance: provided.reconcileRebalance ?? (async (input: ReconcileInput) => {
      const bundler = createBundlerClient({ transport: http(bundlerUrl()) });
      return readRebalanceReceipt(input, {
        // viem's convenience actions throw on every falsy value. Only an explicit RPC null
        // means absent; malformed/undefined/error responses must never authorize release.
        getReceipt: async (hash) => {
          const raw = await bundler.request({ method: 'eth_getUserOperationReceipt', params: [hash] });
          if (raw === null) return null;
          if (!raw || typeof raw !== 'object') throw new Error('receipt RPC 資料不完整');
          return formatUserOperationReceipt(raw);
        },
        getOperation: async (hash) => {
          const raw = await bundler.request({ method: 'eth_getUserOperationByHash', params: [hash] });
          if (raw === null) return null;
          if (!raw || typeof raw !== 'object') throw new Error('UserOp RPC 資料不完整');
          return { ...raw, userOperation: formatUserOperation(raw.userOperation),
            blockNumber: raw.blockNumber === null ? null : BigInt(raw.blockNumber) };
        },
        getBlockHash: async (number) => (await defaultPublicClient().getBlock({ blockNumber: number })).hash,
      });
    }),
  };
}

/**
 * 跑一輪排程器。
 *
 * 順序（每個被認領的 portfolio）：
 *   ① 排程不支援（cron／缺排程）→ blocked，不讀鏈。
 *   ①-bis 帳戶型別不是 `KERNEL`（例如 EOA）→ blocked，不讀鏈（**dry-run 也擋**：它永遠不可能成功）。
 *   ② `planPortfolio` → blocked 非空／沒有報告／鏈上 enrollment paused → blocked，不執行。
 *   ③ `needsRebalance === false` → noop。
 *   ④ `planRebalance` → noop / blocked / ready（ready 但 steps 空的視為 blocked：空 steps 在鏈上會
 *      「成功」而什麼都沒換，docs/pitfalls §8.1）。
 *   ⑤ ready：前置檢查（型別／安裝／派生／allowance／餘額，§4）→ `dryRun` 只記錄
 *      （`ready-dry-run`：不寫 operations、不推進 `next_run_at`、不呼叫執行路徑）；
 *      `dryRun: false` → operations 閘門 → 送出。前置檢查**兩條路都跑**（檔頭 ③-bis），
 *      所以 `ready-dry-run` 的語意是「live 時不會被前置檢查擋下」，不是「算得出參數」。
 *   ⑥ 不論結果，更新 `last_checked_at`；只有真的成功才更新 `last_rebalance_at`。
 *
 * `dryRun` 也決定**認領要不要推進 `next_run_at`**：dry-run 只讀不寫（見 `claimDuePortfolios`）。
 */
export async function runSchedulerOnce(
  args: RunSchedulerArgs,
  deps: SchedulerDeps = {},
): Promise<SchedulerRound> {
  // 預設 dry run：省略 dryRun 就是「只算不做」。要送交易只有明確傳 false 這一條路。
  const dryRun = args.dryRun ?? true;
  const now = args.now ?? new Date();
  const limit = assertLimit(args.limit ?? DEFAULT_ROUND_LIMIT);
  const thresholdBps = args.thresholdBps ?? DEFAULT_THRESHOLD_BPS;
  const resolved = resolveDeps({ thresholdBps }, {...deps,clock:deps.clock??(args.now?()=>new Date(now):()=>new Date())});

  // Yield exits/recovery have their own account lock and precede DEX queues, buy throttles and price gates.
  try { const result=await (deps.yieldRound??runYieldRound)({dryRun,limit}); resolved.log('[yield] '+JSON.stringify(result)); } catch { resolved.log('[yield] 生息讀值／對帳未完成，保留原部位與預留'); }

  let executorPaused: boolean | null = null;
  try {
    const paused = await resolved.readGlobalPaused();
    if (typeof paused === 'boolean') executorPaused = paused;
  } catch {
    // Unknown is never permission to trade. Do not log raw RPC errors (URLs may carry tokens).
  }
  const roundBlockReason = executorPaused === false ? null : executorPaused === true
    ? 'ExecutorPaused：Safe 已開啟全域暫停，這一輪全部 blocked，不送交易'
    : '[EXECUTOR_PAUSE_UNAVAILABLE] 讀不到 executor.globalPaused()，這一輪全部 blocked，不送交易';
  if (roundBlockReason !== null) resolved.log(`[scheduler] ${roundBlockReason}`);

  const claimed = await claimDuePortfolios(limit, now, {
    withTransaction: resolved.withTransaction,
    chainId: resolved.chainId,
    // live 一定要推進（認領即推進 = 防重複執行的關鍵）；dry-run 只讀不寫，連 UPDATE 都不發。
    advance: !dryRun,
  });

  const results: PortfolioRunResult[] = [];
  for (const due of claimed) {
    // `forcePlan` 要一路傳到 runOne：它決定「漂移低於門檻時要不要照樣規劃」（redeem 用）。
    const result = await runOne(due, { dryRun, now, thresholdBps, deps: resolved, forcePlan: deps.forcePlan === true, roundBlockReason });
    results.push(result);
    resolved.log(formatResult(result, dryRun));
  }

  // ---- 一輪的尾端：告警（偵測 → 寫入 → 解除 → 一行 stdout）----
  // 只加在這裡：認領、前置檢查、間隔推進的邏輯一個字都沒動。
  // Live clock must include releases committed during this round; preserve an explicitly injected test clock.
  if (args.skipAlerts !== true) await announceAlerts({ query: resolved.query, log: resolved.log, now: args.now ?? new Date(), dryRun, chainId: resolved.chainId, sessionKeyChecks: resolved, executorPaused, priceSourceChecks: resolved.priceSourceChecks, priceSourceTracker: resolved.priceSourceTracker });

  return { claimed: claimed.length, dryRun, results };
}

/**
 * 尾端的告警：`detectAlerts` → `recordAlerts` → `resolveAlerts` → 每個警示印一行。
 *
 * ⚠ 整段包在 try/catch：**告警是輔助，不是主要流程**。偵測失敗（migration 沒跑、SQL 打錯、DB 抖
 * 一下）只印一行 `[ALERT] 偵測失敗：…` 就繼續。這一輪的再平衡**已經執行完了**，讓整輪因為一個觀測
 * 用的查詢而失敗，看起來會像「交易沒成」—— 那比沒有告警更糟。
 *
 * dry-run 也跑：它不送交易、不推進 `next_run_at`、不寫 `operations`，而告警只寫 `scheduler_alerts`
 * 這一張「只關於觀測」的表。反過來說，若 dry-run 不寫，`--once`（預設 dry-run）就永遠看不到問題
 * 累積，而「無人值守」正是靠這個累積被看見。
 */
export async function announceAlerts(args: {
  relayerGasChecks?: RelayerGasChecks;
  paymasterGasChecks?: PaymasterGasChecks;
  priceSourceChecks?: () => Promise<PriceSourceObservation[]>;
  priceSourceTracker?: PriceSourceTracker;
  /** null/omitted = not verified; keep an existing global pause alert open. */
  executorPaused?: boolean | null;
  query: SchedulerQueryFn;
  log: (line: string) => void;
  now: Date;
  dryRun?: boolean;
  chainId?: number;
  sessionKeyChecks?: SessionKeyCheckDeps;
  /** 測試接縫；正式路徑沿用鏈上 gas 讀取。 */
  gasChecks?: {
    readNativeBalance: (address: Address) => Promise<bigint>;
    readGasPrice: () => Promise<bigint>;
  };
  /** 測試接縫；正式路徑沿用 Telegram。 */
  sendNotification?: (text: string) => Promise<void>;
}): Promise<void> {
  try {
    const chainId = args.chainId ?? getConfig().chainId;
    const notifications = { dryRun: args.dryRun ?? true, chainId, log: args.log, send: args.sendNotification };
    const pauseFinding: AlertFinding | null = args.executorPaused === true ? {
      kind: 'executor_paused', severity: 'critical', portfolioId: null,
      detail: 'ExecutorPaused：Safe 已開啟 executor 全域暫停，所有再平衡（含賣出）停止；使用者可用錢包直接提領',
    } : null;
    // Persist this independent check even if another alert detector fails later.
    if (pauseFinding !== null) {
      args.log(formatAlert(pauseFinding));
      try { await recordAlerts(args.query, [pauseFinding], args.now, notifications); }
      catch { args.log('[ALERT] executor_paused 寫入失敗：全域暫停仍阻擋送單'); }
    }
    let priceComplete = false;
    let priceFinding: AlertFinding | null = null;
    if (args.priceSourceChecks !== undefined && args.priceSourceTracker !== undefined) {
      try {
        const { rows } = await args.query("select detail from scheduler_alerts where kind = 'price_source_unavailable' and portfolio_id is null and resolved_at is null");
        const row = rows[0];
        const detail: unknown = typeof row === 'object' && row !== null ? Reflect.get(row, 'detail') : undefined;
        if (row !== undefined && typeof detail !== 'string') throw new Error('invalid price source alert');
        const previous: AlertFinding | null = typeof detail === 'string' ? { kind: 'price_source_unavailable', severity: 'critical', portfolioId: null, detail } : null;
        const observations = await args.priceSourceChecks();
        const tracked = args.priceSourceTracker(observations, previous);
        priceComplete = tracked.complete;
        priceFinding = tracked.finding;
        if (priceFinding !== null && (priceComplete || observations.some((observation) => observation.verified && observation.failure !== null))) await recordAlerts(args.query, [priceFinding], args.now, notifications);
      } catch {
        priceComplete = false;
        args.priceSourceTracker([], null); // An unknown whole round breaks pre-alert consecutive failure counts.
        args.log('[ALERT] 價格來源檢查失敗；本輪保留既有 price_source_unavailable 警示');
      }
    }
    let relayerComplete = false;
    let relayerFinding: AlertFinding | null = null;
    try {
      const relayer = await detectRelayerLowGas(args.relayerGasChecks);
      relayerComplete = relayer.complete;
      relayerFinding = relayer.finding;
    } catch {
      relayerComplete = false;
      args.log('[ALERT] relayer 餘額檢查失敗；本輪保留既有全域 gas_low 警示');
    }
    let paymasterComplete = false;
    let paymasterFinding: AlertFinding | null = null;
    try {
      const paymaster = await detectPaymasterLowGas(args.paymasterGasChecks);
      paymasterComplete = paymaster.complete;
      paymasterFinding = paymaster.finding;
    } catch { args.log('[ALERT] paymaster 存款檢查失敗；本輪保留既有全域 gas_low 警示'); }
    let globalGasFinding: AlertFinding | null = null;
    if (relayerFinding !== null || paymasterFinding !== null) {
      const details = [relayerFinding?.detail, paymasterFinding?.detail].filter((detail): detail is string => detail !== undefined);
      if (!relayerComplete || !paymasterComplete) {
        // Preserve the other source's last confirmed low observation while it is unreadable.
        try {
          const previous = await args.query("select detail from scheduler_alerts where kind = 'gas_low' and portfolio_id is null and resolved_at is null");
          const row = previous.rows[0];
          const oldDetail: unknown = typeof row === 'object' && row !== null ? Reflect.get(row, 'detail') : undefined;
          if (typeof oldDetail === 'string') for (const line of oldDetail.split('\n')) {
            if ((!relayerComplete && line.startsWith('relayer ')) || (!paymasterComplete && line.startsWith('paymaster '))) details.push(line);
          }
        } catch { /* The existing alert remains open; current known-low evidence must still be persisted. */ }
      }
      globalGasFinding = { kind: 'gas_low', severity: 'critical', portfolioId: null, detail: details.join('\n') };
      args.log(formatAlert(globalGasFinding));
      // Persist independently of the portfolio/seed detectors; exactly one upsert per round.
      try { await recordAlerts(args.query, [globalGasFinding], args.now, notifications); }
      catch { args.log('[ALERT] 全域 gas_low 寫入失敗；本輪保留既有警示'); return; }
    }
    const findings = await detectAlerts(args.query, { now: args.now, ...args.gasChecks });
    let seedCheckComplete = false;
    try {
      const report = await inspectSessionKeyDerivation(chainId, { ...args.sessionKeyChecks, query: args.query });
      seedCheckComplete = report.complete;
      if (!seedCheckComplete) {
        args.log(`[ALERT] seed 比對未完成：${sessionKeyDerivationDetail(report)}；本輪不新增或解除 seed 警示`);
      } else if (report.mismatchedPortfolioIds.length > 0 || report.failedPortfolioIds.length > 0) {
        findings.push({
          kind: 'session_key_derivation_mismatch', severity: 'critical', portfolioId: null,
          detail: `${sessionKeyDerivationDetail(report)}；確認 SESSION_KEY_MASTER_SEED，或完成 session key 續期`,
        });
      }
    } catch {
      args.log('[ALERT] seed 比對失敗：無法完成 key 讀取，本輪不新增或解除 seed 警示');
    }
    await recordAlerts(args.query, findings, args.now, notifications);
    const unverified: AlertKind[] = seedCheckComplete ? [] : ['session_key_derivation_mismatch'];
    if (!priceComplete) unverified.push('price_source_unavailable');
    if (priceFinding !== null) findings.push(priceFinding);
    if (args.executorPaused !== true && args.executorPaused !== false) unverified.push('executor_paused');
    const present = [...findings, ...(pauseFinding === null ? [] : [pauseFinding]), ...(globalGasFinding === null ? [] : [globalGasFinding])];
    const resolved = await resolveAlerts(args.query, present, args.now, notifications, unverified, relayerComplete && paymasterComplete ? [] : ['gas_low:-1']);

    if (findings.length === 0 && pauseFinding === null && globalGasFinding === null) {
      args.log(`[ALERT] ${seedCheckComplete ? '沒有警示' : '其他規則未偵測到警示'}${resolved > 0 ? `（已解除 ${resolved} 筆）` : ''}`);
      return;
    }
    for (const finding of findings) args.log(formatAlert(finding));
    if (resolved > 0) args.log(`[ALERT] 已解除 ${resolved} 筆（條件消失）`);
  } catch (error) {
    args.log(`[ALERT] 偵測失敗：${oneLine(error)}`);
  }
}

type ResolvedDeps = ReturnType<typeof resolveDeps>;

function validNonce(nonce: bigint): boolean {
  return typeof nonce === 'bigint' && nonce >= 0n && nonce <= MAX_USER_OP_NONCE;
}

const SQL_EXPIRE_OPERATION = `
  update operations
     set state = 'expired', last_error = $2, updated_at = now()
   where idempotency_key = $1 and state = $3
     and user_op_hash is not distinct from $4
     and tx_hash is not distinct from $5
     and user_op_nonce = $6 and deadline = $7 and payload_hash = $8
  returning idempotency_key
`;

/** Hash present: both bundler lookups must return null. Hashless pending: require both proofs. */
async function releaseUnresolvedOperation(
  due: DuePortfolio,
  deps: ResolvedDeps,
  op: UnresolvedOperation,
  base: Omit<PortfolioRunResult, 'outcome' | 'reason'>,
): Promise<PortfolioRunResult> {
  const blocked = (reason: string): PortfolioRunResult => ({ ...base, outcome: 'blocked', reason });
  const milliseconds = op.deadline instanceof Date ? op.deadline.getTime() : Number.NaN;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds % 1000 !== 0 ||
      typeof op.user_op_nonce !== 'string' || !/^\d+$/.test(op.user_op_nonce)) {
    return blocked('先對帳：缺少有效的原 deadline／user_op_nonce，保留在途，交人工確認');
  }
  const savedNonce = BigInt(op.user_op_nonce);
  if (!validNonce(savedNonce)) return blocked('先對帳：保存的 user_op_nonce 超出 uint256，保留在途');
  const deadline = BigInt(milliseconds / 1000);
  let timestamp: bigint;
  let nonce: bigint;
  try {
    [timestamp, nonce] = await Promise.all([
      deps.readLatestBlockTimestamp(),
      deps.readEntryPointNonce({ account: due.account, key: savedNonce >> 64n }),
    ]);
    if (!validNonce(timestamp) || !validNonce(nonce) || nonce >> 64n !== savedNonce >> 64n) {
      return blocked('先對帳：鏈上時間／EntryPoint nonce 證據不完整，保留在途');
    }
  } catch {
    return blocked('先對帳：讀取鏈上時間／EntryPoint nonce 失敗，保留在途');
  }
  const reasons: string[] = [];
  const hashless = op.user_op_hash === null;
  if (hashless && (op.state !== 'pending' || timestamp <= deadline + RELEASE_MARGIN_SECONDS || nonce <= savedNonce)) {
    return blocked('先對帳：無 hash 的 pending 必須 deadline 安全邊際已過且同 key nonce 已前進，保留在途');
  }
  if (timestamp > deadline + RELEASE_MARGIN_SECONDS) reasons.push(`deadline 已過（鏈上時間 ${timestamp} > ${deadline} + 300 秒）`);
  if (nonce > savedNonce) reasons.push(`nonce 已前進（${nonce} > ${savedNonce}，key ${savedNonce >> 64n}）`);
  if (reasons.length === 0) return blocked('先對帳：deadline 安全邊際未過且 nonce 未前進，保留在途');
  const reason = `安全釋放：${hashless ? 'pending 未保存 UserOp hash' : 'receipt 與原 UserOp 均查無'}；${reasons.join('；')}；舊操作不可能再成功，標記 expired，下一輪重新規劃`;
  try {
    const released = await deps.withTransaction(async (client) => {
      // Same portfolio lock as beginOperation; no RPC inside this short transaction.
      await client.query('select id from portfolios where id = $1 for update', [due.portfolioId]);
      const unresolved = await unresolvedOperations(client.query, due.portfolioId);
      if (unresolved.length !== 1 || unresolved[0]?.idempotency_key !== op.idempotency_key) return false;
      const result = await client.query(SQL_EXPIRE_OPERATION, [op.idempotency_key, reason, op.state,
        op.user_op_hash, op.tx_hash, op.user_op_nonce, op.deadline?.toISOString(), op.payload_hash]);
      return result.rows.length === 1;
    });
    if (!released) return blocked('先對帳：釋放時未決操作或證據已改變，這一輪不送交易');
  } catch {
    return blocked('先對帳：expired 落庫失敗，這一輪不送交易');
  }
  deps.log(`[scheduler] portfolio ${due.portfolioId} operation ${op.idempotency_key} ${reason}`);
  return { ...base, outcome: 'noop', reason };
}

async function runOne(
  due: DuePortfolio,
  ctx: { dryRun: boolean; now: Date; thresholdBps: number; deps: ResolvedDeps; forcePlan?: boolean; roundBlockReason: string | null },
): Promise<PortfolioRunResult> {
  const base = {
    portfolioId: due.portfolioId,
    strategyId: due.strategyId,
    account: due.account,
    nextRunAt: due.nextRunAt,
    plan: null,
    execution: null,
    partial: null,
  };

  let result: PortfolioRunResult;
  try {
    if (ctx.roundBlockReason !== null) {
      result = { ...base, outcome: 'blocked', reason: ctx.roundBlockReason };
    } else if (ctx.dryRun) {
      result = await decideAndMaybeExecute(due, ctx, base);
    } else {
      result = await ctx.deps.withPortfolioLock(due.portfolioId, async () =>
        await ctx.deps.withDexLock(ctx.deps.chainId, () => decideAndMaybeExecute(due, ctx, base))
          ?? { ...base, outcome: 'blocked' as const, reason: '[DEX_QUEUED] 共用市場正處理另一基金，稍後重報價' })
        ?? { ...base, outcome: 'blocked', reason: '[PORTFOLIO_LOCK_BUSY] 投組已被另一輪鎖定，這一輪不規劃、不送交易' };
    }
  } catch (error) {
    // 一個 portfolio 的例外不該讓整輪停擺（RPC 抖動、某個帳戶的資料不一致）。它會被記成 blocked
    // 並在下一輪重試；next_run_at 已經推進過了，所以不會變成熱迴圈。
    result = { ...base, outcome: 'blocked', reason: due.executionKind === undefined
      ? `處理時拋錯，這一輪不執行：${oneLine(error)}`
      : '[STRATEGY_UNAVAILABLE] 讀鏈／DB／鎖資料不完整，保留原預算與原交易身分，先對帳' };
  }

  // ---- 部分執行 → 把 next_run_at 拉近（只拉近，不延後；只在真的做了一部分之後）----
  // 認領時已經在**同一個 transaction 內**寫入完整間隔（那個語意不動，crash 時留在完整間隔＝
  // 不會變成熱迴圈）。這裡是在結果已知之後把它**提前**，屬於同一條推進路上的第二段。
  //
  // 沒有已知限額餘量時，只有**算得出**執行後漂移才提前。`remainingDriftBps === null` 代表「算不出來」（這一輪買進
  // 帳戶沒持有的資產，到手量沒有價格可估）—— 拿一個算不出來的缺口去排一輪 1800s 後的執行，
  // 等於用猜的調度。實際發生過：6600 → 6 bps 收斂的一輪，卻被排成「還在 6600，30 分鐘後再來」。
  if (!ctx.dryRun && result.outcome === 'executed' && result.partial !== null) {
    if (result.partial.remainingDriftBps === null && result.partial.maxLegBatched !== true) {
      result = {
        ...result,
        reason:
          `${result.reason}；Partial execution: the drift after this round cannot be estimated yet ` +
          '(it buys assets the portfolio did not hold, so the received amount has no price to value it). ' +
          'Kept the full interval; the next round will measure it.',
      };
    } else {
    const followUpSeconds = Math.min(due.intervalSeconds, PARTIAL_FOLLOW_UP_SECONDS);
    const followUpAt = new Date(ctx.now.getTime() + followUpSeconds * 1_000);
    if (followUpAt.getTime() < result.nextRunAt.getTime()) {
      const note =
        (result.partial.maxLegBatched === true ? 'Partial execution: asset max_leg_usdt left a known batch for the next round' : `Partial execution: estimated drift is still ${result.partial.remainingDriftBps} bps after this round`) +
        ` (${result.partial.shrunk.length === 0 ? 'the gap was skipped rather than shrunk' : `${result.partial.shrunk.length} step(s) were shrunk by the impact budget`});` +
        ` next_run_at moved up to ${followUpAt.toISOString()} (${followUpSeconds}s, full interval is ${due.intervalSeconds}s)`;
      try {
        await ctx.deps.query(SQL_ADVANCE_CLAIMED, [[due.portfolioId], [followUpAt.toISOString()]]);
        result = { ...result, nextRunAt: followUpAt, reason: `${result.reason}；${note}` };
      } catch (error) {
        // 寫不進去不代表這一輪白做：留在完整間隔，下一輪照排程跑，只是收斂慢一點。
        result = { ...result, reason: `${result.reason}；${note}（但寫回失敗：${oneLine(error)}）` };
      }
    }
    }
  }

  try {
    await ctx.deps.query(SQL_MARK_CHECKED, [due.portfolioId, ctx.now.toISOString(), due.executionKind===undefined?result.outcome==='executed':result.rebalanceComplete===true]);
  } catch (error) {
    ctx.deps.log(`[scheduler] portfolio ${due.portfolioId} 的 last_checked_at 寫不進去：${due.executionKind===undefined?oneLine(error):'DB unavailable'}`);
  }
  return result;
}

async function decideAndMaybeExecute(
  due: DuePortfolio,
  ctx: { dryRun: boolean; now: Date; thresholdBps: number; deps: ResolvedDeps; forcePlan?: boolean },
  base: Omit<PortfolioRunResult, 'outcome' | 'reason'>,
): Promise<PortfolioRunResult> {

  // 帳戶型別：只有 KERNEL 能被 session key 簽 UserOp。EOA（帳戶就是 owner 本人）身上沒有
  // permission validator、`session_keys` 也不會有它的列，所以它**永遠不可能**成功 —— 這種
  // portfolio 在 dry-run 顯示 `ready` 會讓「看 ready 的數量判斷健康度」得到錯的結論，所以
  // dry-run **也**走這一條（而且擋在 planPortfolio 之前：不浪費一次讀鏈）。
  if (due.accountType !== 'KERNEL') {
    return {
      ...base,
      outcome: 'blocked',
      reason:
        `[ACCOUNT_NOT_KERNEL] smart_accounts.account_type = ${due.accountType}，只有 KERNEL 可以：` +
        `EOA 帳戶本身就是 owner，沒有 session key 的 permission validator，無法用 session key 簽 UserOp`,
    };
  }

  const unresolved = await unresolvedOperations(ctx.deps.query, due.portfolioId);
  if (unresolved.length > 0) {
    // dry-run 只能報在途，不能因預演而改 operations 或假稱 ready。
    const op = unresolved[0]!;
    if(op.yield_execution_key!=null)return {...base,outcome:'blocked',reason:'[YIELD_RECONCILIATION_REQUIRED] 生息由原始快照獨立對帳，不經再平衡路徑重送或釋放'};
    if (op.strategy_job_id != null) return reconcileStrategyOperation(due,ctx,base,op);
    if (ctx.dryRun || unresolved.length > 1) {
      return { ...base, outcome: 'blocked', reason: `portfolio 還在 ${op.state}（${unresolved.length} 筆未決操作），結果未知，先對帳，不重送` };
    }
    if (op.user_op_hash === null) {
      if(due.executionKind==='per_asset')return {...base,outcome:'blocked',reason:'[PREVIOUS_INFLIGHT] 原收據缺hash；不能證明過去未成交，保留現金帳與原操作待對帳'};
      if (op.state === 'pending') {
        const released = await releaseUnresolvedOperation(due, ctx.deps, op, base);
        return released.outcome === 'blocked'
          ? { ...released, reason: `portfolio 還在 pending（結果未知）；${released.reason}` } : released;
      }
      return { ...base, outcome: 'blocked', reason: '先對帳：未決操作缺少 UserOp hash，保留在途，不重送' };
    }
    let reconciliation: ReconcileResult;
    try {
      reconciliation = await ctx.deps.reconcileRebalance({
        account: due.account, executor: ctx.deps.executor ?? executorAddress(), chainId: ctx.deps.chainId,
        userOpHash: op.user_op_hash, txHash: op.tx_hash, payloadHash: op.payload_hash,
        ...(due.executionKind==='per_asset'?{trackCash:(ctx.deps.chainId===97?TESTNET_97.contracts.usdt:'0x55d398326f99059ff775485246999027b3197955') as Address}:{}),
      });
    } catch (error) {
      return { ...base, outcome: 'blocked', reason: decodePriceSourceError(error)?.detail ?? '先對帳：RPC 失敗或證據不符，保留在途，不重送' };
    }
    if (reconciliation.kind === 'not_found') {
      if(due.executionKind==='per_asset')return {...base,outcome:'blocked',reason:'[PREVIOUS_INFLIGHT] 原收據查無；保留現金帳與原操作待對帳'};
      return releaseUnresolvedOperation(due, ctx.deps, op, base);
    }
    if (reconciliation.kind !== 'found' ||
        (reconciliation.outcome.status !== 'success' && reconciliation.outcome.status !== 'reverted')) {
      return { ...base, outcome: 'blocked', reason: '先對帳：receipt 尚未取得或證據不完整，保留在途，不重送' };
    }
    const execution = reconciliation.outcome;
    if(due.executionKind==='per_asset'&&execution.status==='success'){
      await settleAllocatedCash(ctx.deps,due.portfolioId,op.idempotency_key,execution);
      return {...base,outcome:'executed',execution,reason:'原再平衡收據與已配置現金已原子對帳，本輪無重送'};
    }
    const settled = await ctx.deps.query(SQL_SETTLE_OPERATION, [op.idempotency_key,
      execution.status === 'success' ? 'confirmed' : 'reverted', execution.txHash, execution.userOpHash, execution.error]);
    if (settled.rows.length !== 1) {
      return { ...base, outcome: 'blocked', reason: '先對帳：操作已安全釋放或不存在，不覆寫 expired，這一輪不送交易' };
    }
    // 這輪只恢復，不拿舊計畫再送。重新讀鏈記 after；持倉從未用預估成交量更新。
    try {
      const afterPlan = await ctx.deps.planPortfolio(due.portfolioId);
      await recordAuditSnapshot({ deps: ctx.deps, portfolioId: due.portfolioId, phase: 'after', plan: afterPlan,
        idempotencyKey: op.idempotency_key, thresholdBps: ctx.thresholdBps });
    } catch {
      ctx.deps.log(`[scheduler] portfolio ${due.portfolioId} 對帳已落庫，after 快照讀鏈失敗`);
    }
    return { ...base, execution, outcome: execution.status === 'success' ? 'executed' : 'failed',
      reason: `先對帳完成：${execution.status === 'success' ? 'confirmed' : 'reverted'}，這一輪沒有重送交易` };
  }

  if (due.unsupportedReason !== null) {
    return { ...base, outcome: 'blocked', reason: `排程不支援，不執行：${due.unsupportedReason}` };
  }

  if(!ctx.dryRun){const queued=await ctx.deps.dexGate(ctx.deps.chainId,due.portfolioId);if(queued!==null)return {...base,outcome:'blocked',reason:queued};}
  const plan = await ctx.deps.planPortfolio(due.portfolioId);

  // 把「鏈上釘住的版本」同步回 DB。
  //
  // 為什麼需要：`portfolios.version` 是 enrollment 當下寫的，但 owner 可以在鏈上
  // 重新 `registry.enroll` 換版本（我們就手動把 portfolio 1 從 v1 換到 v2 過）。
  // 那時 DB 不會知道，於是 operator 頁顯示 `v1`、鏈上其實是 `v2` —— 實測就發生過。
  //
  // 規劃器讀的是**鏈上**版本（`snapshot.ts` 的 `enrollment[1]`），所以行為一直正確，
  // 錯的只是標籤。這裡把它們對齊，讓「畫面上寫的」與「實際在跑的」一致。
  //
  // 失敗不影響這一輪：版本標籤不是交易的前置條件。
  try {
    if (due.executionKind === undefined) {
    await ctx.deps.query('update portfolios set version = $1 where id = $2 and version <> $1', [
      plan.pinnedVersion.version,
      due.portfolioId,
    ]);
    }
  } catch (error) {
    ctx.deps.log(`[scheduler] portfolio ${due.portfolioId} 的 version 同步失敗：${oneLine(error)}`);
  }

  if (plan.blocked.length > 0) {
    const unavailable = plan.snapshot.unpriced.filter((asset) => asset.amountWei > 0n && asset.reason === 'pricing_failed:TWAP_UNAVAILABLE')
      .map((asset) => oracleUnavailableTag(getAddress(asset.asset), asset.symbol));
    return {
      ...base,
      outcome: 'blocked',
      reason: `${unavailable.length === 0 ? '' : `${unavailable.join(' ')} 整批不送，下一輪重試；`}planPortfolio 擋下（不執行）：${plan.blocked.map((block) => `[${block.code}] ${block.detail}`).join('；')}`,
    };
  }
  if (plan.pinnedVersion.paused) {
    // 鏈上 enrollment 是 paused：executor 會 revert `Paused()`，這一筆一定失敗。
    return { ...base, outcome: 'blocked', reason: '鏈上 enrollment 是 paused：executor 會 revert，這一輪不送' };
  }
  if (plan.report === null) {
    return { ...base, outcome: 'blocked', reason: 'planPortfolio 沒有漂移報告，也沒有 blocked 原因：拒絕在不明狀態下執行' };
  }
  // `forcePlan`：呼叫端要用**同一條送出管線**做別的事（例如 redeem 按比例賣成 numeraire）。
  // 那種動作不會讓漂移變大，所以「不需要再平衡」不代表「什麼都不用做」。
  if (due.executionKind === undefined && !plan.report.needsRebalance && ctx.forcePlan !== true) {
    return {
      ...base,
      outcome: 'noop',
      reason:
        `Drift ${plan.report.grossDriftBps} bps is below the ${plan.report.thresholdBps} bps threshold ` +
        `(largest single delta ${plan.report.maxAbsDeltaBps} bps); nothing to rebalance`,
    };
  }

  const money = due.executionKind === undefined || ctx.forcePlan === true ? null : await prepareNewMoney({due,plan,query:ctx.deps.query,
    run:ctx.deps.withTransaction,chainId:ctx.deps.chainId,now:ctx.now,dryRun:ctx.dryRun,deps:ctx.deps.newMoney});
  const yieldRebalance=money?.useTargetWeights===true&&plan.snapshot.yieldPositions?.some(p=>p.receipt===null||p.receipt>0n)===true;
  // This projection is only for quoting capped inputs. Actual balances remain authoritative for withdrawal and execution.
  const quotePlan=yieldRebalance?await ctx.deps.newMoney.yieldHoldings(plan):plan;
  let rebalance = (money?.useTargetWeights?null:money?.rebalance) ?? await ctx.deps.planRebalance({ portfolioId: due.portfolioId, account: due.account, plan:quotePlan,
    ...(money?.useTargetWeights?{inclusiveFeeReserveRaw:money.context.reserve}:{}) });
  if (rebalance.kind === 'noop') {
    return { ...base, outcome: 'noop', ...(money?.useTargetWeights&&plan.report.maxAbsDeltaBps<=plan.report.thresholdBps?{rebalanceComplete:true}:{}), reason: `Planner returned noop: ${rebalance.reason}` };
  }
  if (rebalance.kind === 'blocked') {
    let nextRunAt = base.nextRunAt;
    let scheduleNote = '';
    const end = rebalance.buyWindowEndsAt;
    if (!ctx.dryRun && end !== undefined && end > BigInt(Math.floor(ctx.now.getTime() / 1000)) && end <= 8_640_000_000_000n) {
      const windowEnd = new Date(Number(end) * 1000);
      try {
        await ctx.deps.query(SQL_ADVANCE_CLAIMED, [[due.portfolioId], [windowEnd.toISOString()]]);
        nextRunAt = windowEnd;
      } catch {
        scheduleNote = '；買入窗口排程寫回失敗，沿用認領時的正常間隔';
      }
    }
    return { ...base, nextRunAt, outcome: 'blocked', reason: `規劃器擋下（不執行）：${rebalance.reason}${scheduleNote}` };
  }
  if (rebalance.steps.length === 0) {
    // planRebalance 的型別結構保證非空；這一條是給「未來有人改了那份保證」的防線。
    // 空 steps 的 executeRebalance 在鏈上**正常返回、什麼都不換**（docs/pitfalls §8.1），所以它必須 blocked。
    return {
      ...base,
      outcome: 'blocked',
      reason:
        'Planner returned ready but the steps are empty: empty steps "succeed" on-chain while swapping nothing, so nothing is sent',
    };
  }

  const batchCash = ctx.deps.chainId === 97 ? TESTNET_97.contracts.usdt : '0x55d398326f99059ff775485246999027b3197955';
  const buys = rebalance.steps.some(step => !isAddressEqual(step.tokenOut,batchCash));
  const heldCount = plan.snapshot.holdings.filter(h=>h.amountWei>0n&&!isAddressEqual(getAddress(h.asset),batchCash)&&plan.targets.some(t=>t.asset.toLowerCase()===h.asset.toLowerCase())).length;
  const limit = executionBatchSize(heldCount,buys);
  if(limit===0)return {...base,outcome:'blocked',reason:'[USER_OP_CAPACITY] 無可行的安全批次'};
  if(rebalance.steps.length>limit)rebalance={...rebalance,steps:rebalance.steps.slice(0,limit),
    partial:{...rebalance.partial,remainingDriftBps:null,shrunk:rebalance.partial?.shrunk??[],maxLegBatched:true},rationale:rebalance.rationale+'；交易容量分批，剩餘依下一輪持倉續作'};
  if(!assetsMarketOpen(ctx.deps.chainId,rebalance.steps.flatMap(step=>[step.tokenIn,step.tokenOut]),ctx.now))return {...base,outcome:'blocked',reason:'[MARKET_CLOSED] 股票休市，等待交易時段'};
  if(yieldRebalance){
    const pending=await ctx.deps.newMoney.withdrawYield(due,plan,money.context.reserve,rebalance.steps);
    if(pending!==null)return {...base,outcome:'blocked',reason:`[YIELD_REBALANCE_PENDING] ${pending}`};
  }
  const gasPurpose = rebalance.purpose ?? 'ordinary';
  const cash = ctx.deps.chainId === 97 ? TESTNET_97.contracts.usdt : '0x55d398326f99059ff775485246999027b3197955';
  const hasBuy = rebalance.steps.some((step) => !isAddressEqual(step.tokenOut, cash));
  if (gasPurpose === 'exit' && hasBuy) return { ...base, outcome: 'blocked', reason: '[INVALID_EXIT] 退出計畫包含買入，不送交易' };
  if (hasBuy && due.executionKind===undefined) {
    try {
      const minimum = minimumDepositUsdtWei(plan.targets, cash);
      if (plan.report.totalUsdE8 * 10n ** 10n < minimum &&
          !await ctx.deps.hasBoughtBefore(due.account, ctx.deps.executor ?? executorAddress(), plan.snapshot.block)) {
        return { ...base, outcome: 'blocked', reason: `[BELOW_MIN_DEPOSIT] 首次買入需累積 ${minimum} USDT 最小單位` };
      }
    } catch { return { ...base, outcome: 'blocked', reason: '[MIN_DEPOSIT_UNAVAILABLE] 無法確認首次買入與最低入金，不送交易' }; }
  }
  let inclusiveBudget:bigint|undefined;
  if(money?.job?.kind==='asset')inclusiveBudget=rebalance.steps.reduce((s,step)=>s+step.amountIn,0n)+money.context.reserve;
  const minimumReason = await ctx.deps.checkTradingMinimums(rebalance.steps, gasPurpose, plan.snapshot.block,inclusiveBudget,money?.context.finalAssets,money?.useTargetWeights?money.context.reserve:undefined);
  if (minimumReason !== null) return { ...base, outcome: 'blocked', reason: minimumReason };

  // ---- ⑤ 送出前重問地板：`rebalance.steps` 的 `amountOutMin` 是**規劃當時**的地板 --------------
  // `planRebalance` 在 `plan.snapshot.block` 那一塊問到 `minimum`，然後我們簽名送出；合約在**執行**
  // 那一塊會自己再問一次（`AtpExecutor._checkStep`），而 oracle 的 `minimum` 含近 5 分鐘均值 ——
  // 它會追著池價跑。所以凍結的規劃值在 plan → sign 的幾十秒裡就可能低於當下的地板 → `BelowFloor`。
  // 這裡用**新鮮值**覆寫（不是 `max(規劃, 新鮮)`：理由見 `refreshFloors` 的檔頭）。
  //
  // 呼叫點放在 `planHashFor` **之前**是刻意的：`planHash`（＝ `operations.payload_hash`，
  // 也是 `idempotency_key` 的一部分）涵蓋 `amountOutMin`，所以它必須描述**真的會上鏈**的那組參數。
  const executor = ctx.deps.executor ?? executorAddress();
  const refresh = await ctx.deps.refreshFloors({
    account: due.account,
    steps: rebalance.steps,
    deadline: rebalance.deadline,
    strategyId: BigInt(plan.pinnedVersion.onchainStrategyId),
    executor,
  });
  if (!refresh.ok) {
    ctx.deps.log(`[scheduler] portfolio ${due.portfolioId} 送出前重問地板失敗（${refresh.kind}）：${refresh.reason}`);
    return {
      ...base,
      // 問不到地板＝不知道現在的下限 → `blocked`（一筆都沒送，不是「試過了失敗」）；
      // 地板崩掉＝市場狀態，不是設定錯 → `noop`（下一輪用新價格重新規劃）。
      outcome: refresh.kind === 'floor-collapsed' ? 'noop' : 'blocked',
      reason: refresh.reason,
    };
  }
  const steps = refresh.steps;
  ctx.deps.log(`[scheduler] portfolio ${due.portfolioId} venues: ${steps.map((step, index) => `${index}:${step.venue}`).join(', ')}`);
  ctx.deps.log(`[scheduler] portfolio ${due.portfolioId} 送出前重問地板：${refresh.note}`);

  const planHash = planHashFor(steps, rebalance.deadline);
  let idempotencyKey = idempotencyKeyFor(due.portfolioId, planHash);
  const summary: PlannedSummary = {
    steps: steps.map((step) => ({
      tokenIn: step.tokenIn,
      tokenOut: step.tokenOut,
      amountIn: step.amountIn.toString(),
      amountOutMin: step.amountOutMin.toString(),
      venue: step.venue,
    })),
    deadline: rebalance.deadline.toString(),
    planHash,
    idempotencyKey,
    rationale: rebalance.rationale,
  };
  const withPlan = { ...base, plan: summary, partial: rebalance.partial ?? null };

  // 前置檢查（§4）一定在 `beginOperation` 之前：擋下來的 portfolio 一列 `operations` 都不該寫
  // （寫了語意就是「試過了但失敗」，而真相是「根本沒試」）。
  //
  // ⚠ 這裡是 dry-run 與 live 的**共同**路段（檔頭 ③-bis）：把 dry-run 的 return 擺在這一段之前，
  // 就是「KERNEL 但 active session_keys = 0」「allowance 早就被用掉」那一整類 portfolio 在監控
  // 輸出裡仍然顯示 `ready` 的原因。`ready` 要回答「現在 `--live` 會成功嗎」，所以兩條路都驗。
  //
  // 位置選在 planRebalance 之後而不是 planPortfolio 之前，是因為 b/c 需要 `steps`；而 a/a2 擺在
  // 這裡讓 noop 不跑執行前檢查；輪尾 seed 告警仍會獨立檢查所有 active 帳戶。
  // （`executor` 在上面「重問地板」那一段就解析好了：地板要靠 `executor.oracle()` 才問得到。）
  const prechecks = await runPrechecks(
    {
      portfolioId: due.portfolioId,
      account: due.account,
      executor,
      steps,
      chainId: ctx.deps.chainId,
    },
    {
      query: ctx.deps.query,
      readPermissionConfig: ctx.deps.readPermissionConfig,
      deriveSessionKeyAddress: ctx.deps.deriveSessionKeyAddress,
      readAllowance: ctx.deps.readAllowance,
      readBalance: ctx.deps.readBalance,
    },
  );
  if (prechecks.failures.length > 0) {
    return {
      ...withPlan,
      outcome: 'blocked',
      reason:
        (ctx.dryRun
          ? 'Pre-checks failed (dry-run blocks it too: `--live` would not send either, so this is not reported as ready)'
          : 'Pre-checks failed (not sending a transaction that is certain to fail)') +
        '：' +
        prechecks.failures.map((failure) => `[${failure.code}] ${due.executionKind===undefined?failure.detail:'前置條件不足，未送交易'}`).join('；'),
    };
  }
  const sessionKey = prechecks.sessionKey;
  if (sessionKey === null) {
    // 不可能：failures 非空就是上面那一條。留著只是為了收窄型別。
    return { ...withPlan, outcome: 'blocked', reason: '前置檢查沒有回傳 session key' };
  }

  if (ctx.dryRun) {
    // dry-run 到此為止：前置檢查都過了（這是 `ready` 的全部意義），但仍然不寫 operations
    // （見檔頭「為什麼 dry-run 不寫 operations」）、不推進 `next_run_at`、不呼叫執行路徑。
    return {
      ...withPlan,
      outcome: 'ready-dry-run',
      reason:
        `Would execute ${steps.length} step(s) (dry-run: nothing is sent; see the plan for the parameters; ` +
        `when live the idempotency_key would be ${idempotencyKey}). Pre-checks a/a2/b/c all pass — ` +
        `session key ${sessionKey.keyRef}(${sessionKey.permissionId}) is installed on-chain, derives from the seed, ` +
        `and allowance plus balance are sufficient`,
    };
  }

  const valuationAssets = plan.snapshot.holdings
    .filter((holding) => holding.amountWei > 0n && plan.targets.some((target) => target.asset.toLowerCase() === holding.asset.toLowerCase()))
    .map((holding) => getAddress(holding.asset));

  // 同一 portfolio 的不同 planHash 也必須互斥；只把閘門放在短 transaction，不在鎖內讀 RPC。
  let nonce: bigint;
  let deadline: string;
  try {
    nonce = await ctx.deps.readRebalanceNonce({ account: due.account, sessionKey, executor });
    if (!validNonce(nonce)) throw new Error('invalid nonce');
    if (rebalance.deadline < 0n || rebalance.deadline > 8_640_000_000_000n) throw new Error('invalid deadline');
    deadline = new Date(Number(rebalance.deadline) * 1000).toISOString();
  } catch {
    return { ...withPlan, outcome: 'blocked', reason: '[USER_OP_EVIDENCE_UNAVAILABLE] 無法取得有效的原 nonce／deadline，不寫 pending、不送交易' };
  }
  let gate: OperationGate;
  try {
    gate = await ctx.deps.withTransaction(async (client) => {
      if (money?.job) return beginStrategyOperation(client.query,{...money.context,now:ctx.deps.clock()},money.job,steps,{idempotencyKey,payloadHash:planHash,deadline,nonce,clock:ctx.deps.clock});
      await client.query('select id from portfolios where id = $1 for update', [due.portfolioId]);
      return beginOperation(client.query, { portfolioId: due.portfolioId, idempotencyKey, payloadHash: planHash, deadline, nonce });
    });
  } catch {
    return { ...withPlan, outcome: 'blocked', reason: 'operations 閘門落庫失敗，無法確認 pending 已保存，不送交易' };
  }
  if (!gate.proceed) {
    return { ...withPlan, outcome: gate.outcome, reason: `operations 閘門擋下：${gate.reason}` };
  }
  if (gate.operationKey !== undefined) { idempotencyKey=gate.operationKey; summary.idempotencyKey=idempotencyKey; }

  // 稽核軌跡：送出前先記一張（用剛剛算好的觀測，不額外讀鏈）。
  await recordAuditSnapshot({
    safeErrors: due.executionKind!==undefined,
    deps: ctx.deps,
    portfolioId: due.portfolioId,
    phase: 'before',
    plan,
    idempotencyKey,
    thresholdBps: ctx.thresholdBps,
  });

  const execution = await executeAndSettle(ctx.deps, {
    gasPurpose,
    strategyId: BigInt(plan.pinnedVersion.onchainStrategyId),
    portfolioId: due.portfolioId,
    account: due.account,
    sessionKey,
    executor,
    steps,
    deadline: rebalance.deadline,
    nonce,
    valuationAssets,
    idempotencyKey,
    trackAllocatedCash:due.executionKind==='per_asset',
    ...(money?.job ? { strategy: { context: money.context, job: money.job } } : {}),
  });
  if (execution.errorCode === 'GAS_BUDGET_EXCEEDED') {
    const nextDay = execution.budgetResetAt === undefined ? new Date(ctx.now) : new Date(execution.budgetResetAt);
    if (execution.budgetResetAt === undefined) nextDay.setUTCHours(24, 0, 0, 0);
    try {
      await ctx.deps.query(SQL_ADVANCE_CLAIMED, [[due.portfolioId], [nextDay.toISOString()]]);
      return { ...withPlan, execution, outcome: 'blocked', nextRunAt: nextDay, reason: '[GAS_BUDGET_EXCEEDED] 普通操作每日 gas／美元預算不足，延至下一個 UTC 日' };
    } catch {
      return { ...withPlan, execution, outcome: 'blocked', reason: '[GAS_BUDGET_EXCEEDED] 普通操作預算不足；隔日排程寫回失敗，本輪不送交易' };
    }
  }

  // 落地後再記一張 —— **重新讀鏈**，不沿用送出前的觀測：這一張的全部意義就是「交易真的改變了什麼」。
  // 只有真的上鏈（success / reverted）才有 after；送出失敗（error）時鏈上沒變，寫一張相同的只是噪音。
  if (execution.status === 'success' || execution.status === 'reverted') {
    try {
      const afterPlan = await ctx.deps.planPortfolio(due.portfolioId);
      await recordAuditSnapshot({
        safeErrors: due.executionKind!==undefined,
        deps: ctx.deps,
        portfolioId: due.portfolioId,
        phase: 'after',
        plan: afterPlan,
        idempotencyKey,
        thresholdBps: ctx.thresholdBps,
      });
    } catch (error) {
      ctx.deps.log(`[scheduler] portfolio ${due.portfolioId} 的 after 快照讀鏈失敗：${due.executionKind===undefined?oneLine(error):'RPC unavailable'}（這一輪照常）`);
    }
  }
  if (execution.status === 'success') {
    return {
      ...withPlan,
      outcome: 'executed',
      ...(money?.useTargetWeights&&rebalance.partial===undefined?{rebalanceComplete:true}:{}),
      reason: `Landed on-chain: tx ${execution.txHash ?? '(unknown)'} (attempt ${gate.attempts})`,
      execution,
    };
  }
  if (execution.status === 'reverted') {
    return {
      ...withPlan,
      outcome: 'failed',
      reason:
        `上鏈但沒有成功：tx ${execution.txHash ?? '(unknown)'}` +
        `（第 ${gate.attempts} 次嘗試，operations 記為 reverted 可重試）｜${execution.error ?? '(沒有診斷訊息)'}`,
      execution,
    };
  }
  if (execution.status === 'unknown') {
    return { ...withPlan, outcome: 'blocked', execution,
      reason: `送出結果未知，保留在途，下一輪先對帳，不重送：${execution.error ?? '(沒有診斷訊息)'}` };
  }
  return {
    ...withPlan,
    outcome: execution.priceSourceFailure === undefined ? 'failed' : 'blocked',
    reason:
      `Send failed (nothing landed): ${execution.error ?? '(no error message)'}` +
      `（第 ${gate.attempts} 次嘗試，operations 記為 failed）`,
    execution,
  };
}


/**
 * 寫一張稽核快照（`before` 或 `after`），並連回這一輪的 `operations` 列。
 *
 * 為什麼在排程器寫而不是在 `writeSnapshot` 自己找 operation：快照不該知道 `idempotency_key` 這種
 * 排程器的概念。這裡用 key 查出 id 再傳進去，兩層的責任就分開了。
 *
 * **失敗不往外拋**：快照是觀測，不是這一輪的目的。寫不進去時留一行 log，這一輪的再平衡照常 ——
 * 反過來（為了一張快照讓一筆已經規劃好的再平衡失敗）才是真正不可接受的。
 */
async function recordAuditSnapshot(args: {
  safeErrors?:boolean;
  deps: ResolvedDeps;
  portfolioId: number;
  phase: 'before' | 'after';
  plan: PortfolioPlan;
  idempotencyKey: string;
  thresholdBps: number;
}): Promise<void> {
  try {
    const { rows } = await args.deps.query(
      'select id::text as id from operations where idempotency_key = $1',
      [args.idempotencyKey],
    );
    const first = rows[0] as { id?: unknown } | undefined;
    const rawId = typeof first?.id === 'string' ? first.id : undefined;
    await args.deps.writeSnapshot(args.plan.snapshot, args.plan.report, {
      query: args.deps.query as never,
      phase: args.phase,
      operationId: rawId === undefined ? null : BigInt(rawId),
      // `PortfolioPlan.pinnedVersion` 是物件（version + 鏈上 id + paused），表頭只要 version。
      pinnedVersion: args.plan.pinnedVersion.version,
      thresholdBps: args.thresholdBps,
    });
    args.deps.log(
      `[scheduler] portfolio ${args.portfolioId} 的 ${args.phase} 快照已寫入（block ${args.plan.snapshot.block.toString()}）`,
    );
  } catch (error) {
    args.deps.log(
      `[scheduler] portfolio ${args.portfolioId} 的 ${args.phase} 快照沒寫成：${args.safeErrors?'storage unavailable':oneLine(error)}（這一輪照常）`,
    );
  }
}

/** 恢復時從原 UserOp 重建 planHash／步數，不把本輪新計畫當成舊交易的證據。 */
export async function readRebalanceReceipt(input: ReconcileInput, reader: {
  getReceipt: (hash: Hex) => Promise<UserOperationReceipt | null>;
  getOperation: (hash: Hex) => Promise<GetUserOperationReturnType | null>;
  getBlockHash: (number: bigint) => Promise<Hex | null>;
}): Promise<ReconcileResult> {
  const receipt = await reader.getReceipt(input.userOpHash);
  const operation = await reader.getOperation(input.userOpHash);
  if (receipt === null && operation === null) return { kind: 'not_found' };
  if (receipt === null || operation === null) return { kind: 'incomplete', reason: 'receipt 或原 UserOp 缺漏' };
  const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
  const hash = getUserOperationHash({ userOperation: operation.userOperation,
    chainId: input.chainId, entryPointAddress: ENTRY_POINT.address, entryPointVersion: '0.7' });
  if (!same(hash, input.userOpHash) || !same(receipt.userOpHash, input.userOpHash) ||
      receipt.nonce !== operation.userOperation.nonce ||
      !same(receipt.sender, input.account) || !same(operation.userOperation.sender, input.account) ||
      !same(receipt.entryPoint, ENTRY_POINT.address) || !same(operation.entryPoint, ENTRY_POINT.address) ||
      operation.blockNumber !== receipt.receipt.blockNumber || operation.blockHash === null ||
      !same(operation.blockHash, receipt.receipt.blockHash) || operation.transactionHash === null ||
      !same(operation.transactionHash, receipt.receipt.transactionHash) ||
      (input.txHash !== null && !same(input.txHash, receipt.receipt.transactionHash))) {
    throw new Error('對帳證據的 UserOp／帳戶／交易／區塊不符，保留在途');
  }
  const canonicalHash = await reader.getBlockHash(receipt.receipt.blockNumber);
  if (canonicalHash === null || !same(canonicalHash, receipt.receipt.blockHash)) {
    throw new Error('對帳 receipt 不在 canonical 區塊，保留在途');
  }
  // 現有 sender 固定是一筆 Kernel SINGLE + DEFAULT call；其他模式無法證明整批原子執行。
  const outer = decodeFunctionData({ abi: parseAbi(['function execute(bytes32 mode, bytes data) payable']),
    data: operation.userOperation.callData });
  const [mode, packed] = outer.args;
  if (BigInt(mode) !== 0n || !same(slice(packed, 0, 20), input.executor) || BigInt(slice(packed, 20, 52)) !== 0n) {
    throw new Error('對帳 UserOp 不是原 executor 的零 value 原子呼叫，保留在途');
  }
  const call = decodeFunctionData({ abi: EXECUTOR_ABI, data: slice(packed, 52) });
  if (call.functionName !== 'executeRebalance') throw new Error('對帳不是 executeRebalance，保留在途');
  const [account, steps, deadline] = call.args;
  if (!same(account, input.account) || steps.length === 0 ||
      !same(keccak256(encodeAbiParameters(PLAN_HASH_ABI, [steps, deadline])), input.payloadHash)) {
    throw new Error('對帳 planHash／帳戶／步數不符，保留在途');
  }
  if (typeof receipt.success !== 'boolean') return { kind: 'incomplete', reason: 'receipt 缺 success' };
  if (receipt.receipt.status !== 'success' && receipt.receipt.status !== 'reverted') {
    return { kind: 'incomplete', reason: 'receipt 缺 transaction status' };
  }
  const swaps = countSwapExecuted(receipt.logs, input.executor);
  if (swaps !== (receipt.success ? steps.length : 0)) {
    return { kind: 'incomplete', reason: 'SwapExecuted 數量與原計畫不符' };
  }
  const outcome = judgeRebalanceOutcome({ txStatus: receipt.receipt.status,
    userOpSuccess: typeof receipt.success === 'boolean' ? receipt.success : null,
    // getUserOperationReceipt.logs 僅限該 UserOp；receipt.logs 可能含同 tx 的其他 UserOp。
    swapExecuted: swaps, expectedSwaps: steps.length,
    txHash: receipt.receipt.transactionHash, userOpHash: input.userOpHash,
    gasUsed: receipt.actualGasUsed.toString(), ...(receipt.reason === undefined ? {} : { revertReason: receipt.reason }) });
  if(input.trackCash!==undefined&&outcome.status==='success')outcome.cashDeltaRaw=receiptCashDelta(receipt,input.account,input.trackCash).toString();
  if(input.expectedInputs!==undefined&&outcome.status==='success') {
    if(input.cash===undefined)throw new Error('missing cash identity');
    outcome.batchEvidence = strategyReceiptEvidence(receipt,steps,input.expectedInputs,input.account,input.executor,input.cash);
  }
  return {kind:'found',outcome};
}

/** The bundler's scoped logs belong to exactly this UserOp (not sibling operations). */
export function receiptCashDelta(receipt:UserOperationReceipt,account:Address,cash:Address):bigint{
  const abi=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);let delta=0n;
  for(const log of receipt.logs){
    if(log.address.toLowerCase()!==cash.toLowerCase()||log.topics[0]!==keccak256(toBytes('Transfer(address,address,uint256)')))continue;
    if(log.removed)throw new Error('removed cash transfer');
    const event=decodeEventLog({abi,data:log.data,topics:log.topics});
    if(event.args.from.toLowerCase()===account.toLowerCase())delta-=event.args.value;
    if(event.args.to.toLowerCase()===account.toLowerCase())delta+=event.args.value;
  }
  return delta;
}
async function settleAllocatedCash(deps:ResolvedDeps,portfolioId:number,key:string,outcome:ExecutionOutcome):Promise<void>{
  if(outcome.cashDeltaRaw===undefined||!/^(-?)(0|[1-9][0-9]*)$/.test(outcome.cashDeltaRaw))throw new Error('missing cash evidence');
  await deps.withTransaction(async({query})=>{
    await lockCash(query,{chainId:deps.chainId,portfolioId});
    const op=(await query('select state from operations where idempotency_key=$1 for update',[key])).rows[0] as {state:string}|undefined;
    if(op?.state==='confirmed')return;
    if(!op||!['pending','submitted'].includes(op.state))throw new Error('cash attempt is not pending');
    const result=await query(SQL_SETTLE_OPERATION,[key,'confirmed',outcome.txHash,outcome.userOpHash,null]);
    if(result.rows.length!==1)throw new Error('operation changed');
    await query(`update strategy_cash_balances set allocated_cash_raw=allocated_cash_raw+$3::numeric,updated_at=clock_timestamp() where chain_id=$1 and portfolio_id=$2`,[deps.chainId,portfolioId,outcome.cashDeltaRaw]);
  });
}

/** Exact business evidence from this UserOp's canonical logs, including actual token transfers. */
export function strategyReceiptEvidence(receipt:UserOperationReceipt,steps:readonly {tokenIn:Address;tokenOut:Address;amountIn:bigint;amountOutMin:bigint}[],
  expected:InputVector,account:Address,executor:Address,cash:Address):BatchEvidence {
  const abi=parseAbi(['event SwapExecuted(address indexed account,address tokenIn,address tokenOut,uint256 amountIn,uint256 gross,uint256 fee,uint256 net,uint256 oracleFloor)',
    'event MinFeeCharged(address indexed account,uint256 notional,uint256 due,uint256 charged)','event Transfer(address indexed from,address indexed to,uint256 value)']);
  const received:InputVector={},fees:InputVector={},inputs:InputVector={},transfers:InputVector={};
  let feePaid=0n,feeEvents=0,cashOut=0n;
  for(const log of receipt.logs){
    if(log.removed)throw new Error('removed receipt event');
    const emitter=log.address.toLowerCase();
    const topic=log.topics[0]?.toLowerCase();
    if(emitter===executor.toLowerCase()&&(topic===SWAP_EXECUTED_TOPIC||topic===keccak256(toBytes('MinFeeCharged(address,uint256,uint256,uint256)')))){
      const event=decodeEventLog({abi,data:log.data,topics:log.topics});
      if(event.eventName==='SwapExecuted'){
        const a=event.args,key=a.tokenOut.toLowerCase(),step=steps.find(s=>s.tokenOut.toLowerCase()===key);
        if(a.account.toLowerCase()!==account.toLowerCase()||a.tokenIn.toLowerCase()!==cash.toLowerCase()||!step||inputs[key]!==undefined||
          expected[key]!==a.amountIn.toString()||step.amountIn!==a.amountIn||a.gross<step.amountOutMin||a.gross-a.fee!==a.net||a.net<=0n)throw new Error('swap evidence mismatch');
        inputs[key]=a.amountIn.toString();received[key]=a.net.toString();fees[key]=a.fee.toString();
      }else if(event.eventName==='MinFeeCharged'){
        const a=event.args;
        if(a.account.toLowerCase()!==account.toLowerCase()||a.notional!==sumInputs(expected)||a.charged>a.due||++feeEvents>1)throw new Error('fee evidence mismatch');
        feePaid=a.charged;
      }
    } else if(topic===keccak256(toBytes('Transfer(address,address,uint256)'))&&(emitter===cash.toLowerCase()||expected[emitter]!==undefined)){
      const event=decodeEventLog({abi,data:log.data,topics:log.topics});
      if(event.eventName==='Transfer'){
        if(emitter===cash.toLowerCase()&&event.args.from.toLowerCase()===account.toLowerCase())cashOut+=event.args.value;
        if(event.args.to.toLowerCase()===account.toLowerCase())transfers[emitter]=(BigInt(transfers[emitter]??'0')+event.args.value).toString();
      }
    }
  }
  if(Object.keys(inputs).length!==Object.keys(expected).length||Object.entries(received).some(([a,v])=>transfers[a]!==v)||
    cashOut!==sumInputs(expected)+feePaid)throw new Error('receipt token differences mismatch');
  return {received,fees,feePaid,blockNumber:receipt.receipt.blockNumber,blockHash:receipt.receipt.blockHash};
}

/** 送出 → 標 submitted → 等 receipt；任何送出後例外都保留在途，不降成可重試的 failed。 */
async function executeAndSettle(
  deps: ResolvedDeps,
  args: {
    strategy?: {context:JobContext;job:StrategyJob};
    trackAllocatedCash?:boolean;
    gasPurpose: 'ordinary' | 'exit';
    strategyId: bigint;
    portfolioId: number;
    account: Address;
    sessionKey: SessionKeyRef;
    executor: Address;
    steps: readonly PlannedStep[];
    valuationAssets: readonly Address[];
    deadline: bigint;
    nonce: bigint;
    idempotencyKey: string;
  },
): Promise<ExecutionOutcome> {
  const typed=args.strategy!==undefined||args.trackAllocatedCash===true;
  const settle = async (state: 'confirmed' | 'reverted' | 'failed', outcome: ExecutionOutcome, error: string | null) => {
    if (args.strategy) {
      await deps.query(SQL_MARK_SUBMITTED,[args.idempotencyKey,outcome.userOpHash,outcome.txHash]);
      if(state==='confirmed'||state==='reverted') {
        if(outcome.userOpHash===null||outcome.txHash===null)throw new Error('missing confirmed hashes');
        const verified=await deps.reconcileRebalance({account:args.account,executor:args.executor,chainId:deps.chainId,userOpHash:outcome.userOpHash,
          txHash:outcome.txHash,payloadHash:planHashFor(args.steps,args.deadline),cash:args.strategy.context.cash,
          expectedInputs:Object.fromEntries(args.steps.map(s=>[s.tokenOut.toLowerCase(),s.amountIn.toString()]))});
        if(verified.kind!=='found')throw new Error('business receipt incomplete');
        if(verified.outcome.status==='success'&&verified.outcome.batchEvidence){
          const op=(await deps.query('select id from operations where idempotency_key=$1',[args.idempotencyKey])).rows[0] as {id:string}|undefined;
          if(!op)throw new Error('attempt missing');
          await settleStrategyBatch(deps.withTransaction,args.strategy.context,op.id,verified.outcome.batchEvidence);
        }else if(verified.outcome.status==='reverted'){
          await failStrategyAttempt(deps,args.strategy.context,args.idempotencyKey,'reverted',verified.outcome);
        }else throw new Error('business receipt incomplete');
        Object.assign(outcome,verified.outcome);
      } else await failStrategyAttempt(deps,args.strategy.context,args.idempotencyKey,state,outcome);
      return;
    }
    if(args.trackAllocatedCash&&state==='confirmed'){
      if(!outcome.userOpHash)throw new Error('missing UserOp');
      const cash=(deps.chainId===97?TESTNET_97.contracts.usdt:'0x55d398326f99059ff775485246999027b3197955') as Address;
      const verified=await deps.reconcileRebalance({account:args.account,executor:args.executor,chainId:deps.chainId,userOpHash:outcome.userOpHash,txHash:outcome.txHash,payloadHash:planHashFor(args.steps,args.deadline),trackCash:cash});
      if(verified.kind!=='found'||verified.outcome.status!=='success')throw new Error('cash receipt incomplete');
      await settleAllocatedCash(deps,args.portfolioId,args.idempotencyKey,verified.outcome);Object.assign(outcome,verified.outcome);return;
    }
    const result = await deps.query(SQL_SETTLE_OPERATION, [args.idempotencyKey, state, outcome.txHash, outcome.userOpHash, error]);
    if (result.rows.length !== 1) throw new Error('操作已安全釋放或不存在，不覆寫 expired');
  };

  let sending = false;
  let submitted: { userOpHash?: Hex; txHash?: Hex } = {};
  let received: ExecutionOutcome | null = null;

  try {
    const outcome = await deps.executeRebalance({
      ...(args.strategy?{feeBudget:BigInt(args.strategy.job.remaining_fee_raw)}:{}),
      gasPurpose: args.gasPurpose,
      strategyId: args.strategyId,
      portfolioId: args.portfolioId,
      account: args.account,
      sessionKey: args.sessionKey,
      executor: args.executor,
      steps: args.steps,
      valuationAssets: args.valuationAssets,
      deadline: args.deadline,
      nonce: args.nonce,
      onSending: () => { sending = true; },
      onSubmitted: async (ids) => {
        sending = true;
        submitted = ids; // 先記憶體保存，DB 寫失敗也不能誤稱未送出。
        await deps.query(SQL_MARK_SUBMITTED, [args.idempotencyKey, ids.userOpHash ?? null, ids.txHash ?? null]);
      },
    });
    if(typed && outcome.error!==null)outcome.error='[STRATEGY_EXECUTION_UNAVAILABLE] 交易尚未完成，保留原身分及預算待對帳';
    received = outcome;
    if (outcome.status === 'unknown' || (outcome.status === 'error' &&
        (sending || outcome.userOpHash !== null || outcome.txHash !== null))) {
      sending = true;
      throw new Error(outcome.error ?? '送出結果未知');
    }
    if (outcome.status === 'error') {
      await settle('failed', outcome, outcome.error);
      return outcome;
    }
    if (outcome.status === 'success') {
      await settle('confirmed', outcome, null);
      return outcome;
    }
    // `reverted` 的訊息用**判定時寫好的那一段**（哪一層沒過、gas 花了多少），不是一句「status = reverted」：
    // 「上鏈但 op 失敗」與「上鏈後真的 revert」在維運上要看到不同的字（§8.16）。
    const diagnosis =
      outcome.error ?? `上鏈但沒有成功（tx ${outcome.txHash ?? '(unknown)'}，沒有帶回診斷訊息）`;
    await settle('reverted', outcome, diagnosis);
    return outcome;
  } catch (error) {
    const failure = decodePriceSourceError(error);
    const message = typed ? '[STRATEGY_EXECUTION_UNAVAILABLE] 無法確認執行結果，保留原身分待對帳' : oneLine(error);
    const unknown = sending || (received !== null && received.status !== 'error');
    const outcome: ExecutionOutcome = { status: unknown ? 'unknown' : 'error',
      ...(error instanceof AppError ? { errorCode: error.code } : {}),
      ...(error instanceof GasBudgetExceededError ? { budgetResetAt: error.resetAt } : {}),
      userOpHash: received?.userOpHash ?? submitted.userOpHash ?? null,
      txHash: received?.txHash ?? submitted.txHash ?? null, gasUsed: received?.gasUsed ?? null, error: message,
      ...(failure === null ? {} : { priceSourceFailure: failure }) };
    try {
      if (unknown) {
        // pending 已在發 RPC 前持久化；有 hash 就盡力補記 submitted，寫不進去仍由 pending 阻擋。
        if (outcome.userOpHash !== null || outcome.txHash !== null) {
          await deps.query(SQL_MARK_SUBMITTED, [args.idempotencyKey, outcome.userOpHash, outcome.txHash]);
        }
      } else {
        await settle('failed', outcome, message);
      }
    } catch (dbError) {
      deps.log(`[scheduler] operations 的 ${unknown ? '在途狀態' : 'failed'} 寫不進去（${typed?'DB unavailable':oneLine(dbError)}）：原始錯誤是 ${message}`);
    }
    return outcome;
  }
}

async function beginStrategyOperation(query:SchedulerQueryFn,c:JobContext,j:StrategyJob,steps:readonly PlannedStep[],
  a:{idempotencyKey:string;payloadHash:Hex;deadline:string;nonce:bigint;clock?:()=>Date}):Promise<OperationGate>{
  await lockCash(query,c);
  if((await unresolvedOperations(query,c.portfolioId)).length)return {proceed:false,outcome:'blocked',reason:'未知操作先對帳'};
  const current=await readJob(query,c);
  if(!current||current.id!==j.id||!['reserved','running'].includes(current.state))return {proceed:false,outcome:'blocked',reason:'原工作已停止或改變'};
  const inputs=Object.fromEntries(steps.map(s=>[s.tokenOut.toLowerCase(),s.amountIn.toString()]));
  if(steps.some(s=>!isAddressEqual(s.tokenIn,c.cash))||Object.keys(inputs).length!==steps.length||
    (current.kind!=='asset'&&Object.keys(current.remaining_input).filter(a=>BigInt(current.remaining_input[a]??'0')>0n).length!==steps.length)||
    steps.length===0||steps.length>MAX_USER_OP_STEPS||
    Object.entries(inputs).some(([a,v])=>BigInt(v)>BigInt(current.remaining_input[a]??'0')))throw new Error('basket identity changed');
  await query("update strategy_job_batches set state='cancelled',updated_at=clock_timestamp() where job_id=$1 and state='planned'",[j.id]);
  const indexRow=(await query('select coalesce(max(batch_index)+1,0) as n from strategy_job_batches where job_id=$1',[j.id])).rows[0] as {n:number}|undefined;
  const index=indexRow?.n??-1;
  if(!Number.isSafeInteger(index)||index<0)throw new Error('invalid batch index');
  if(current.kind==='asset'&&current.asset_started_at==null){
    const startedAt=a.clock?.()??c.now;
    const started=await query("update strategy_jobs set asset_started_at=$2,state='running',updated_at=clock_timestamp() where id=$1 and asset_started_at is null and slot_at<=$2 and window_end_at>$2 returning id",[j.id,startedAt]);
    if(started.rows.length!==1)return {proceed:false,outcome:'blocked',reason:'期次窗口已過，不開始舊期次'};
  }
  await query('insert into strategy_job_batches(job_id,batch_index,input_raw) values($1,$2,$3)',[j.id,index,JSON.stringify(inputs)]);
  const key=`${a.idempotencyKey}:job:${j.id}:batch:${index}`;
  const inserted=await query(`insert into operations(portfolio_id,type,state,idempotency_key,payload_hash,attempts,deadline,user_op_nonce,strategy_job_id,strategy_batch_index)
    values($1,'rebalance','pending',$2,$3,1,$4,$5,$6,$7) returning id`,[c.portfolioId,key,a.payloadHash,a.deadline,a.nonce.toString(),j.id,index]);
  if(inserted.rows.length!==1)throw new Error('attempt identity not saved');
  await query("update strategy_jobs set state='running',updated_at=clock_timestamp() where id=$1",[j.id]);
  return {proceed:true,attempts:1,operationKey:key};
}

async function failStrategyAttempt(deps:ResolvedDeps,c:Pick<JobContext,'chainId'|'portfolioId'>,key:string,state:'failed'|'reverted',outcome:ExecutionOutcome){
  await deps.withTransaction(async({query})=>{
    await lockCash(query,c);
    const op=(await query('select * from operations where idempotency_key=$1 for update',[key])).rows[0] as {strategy_job_id:string;strategy_batch_index:number}|undefined;
    if(!op)throw new Error('attempt missing');
    await query(SQL_SETTLE_OPERATION,[key,state,outcome.txHash,outcome.userOpHash,outcome.error]);
    await query("update strategy_job_batches set state='failed',updated_at=clock_timestamp() where job_id=$1 and batch_index=$2",[op.strategy_job_id,op.strategy_batch_index]);
    const budget=outcome.errorCode==='GAS_BUDGET_EXCEEDED';
    await query(`update strategy_jobs set failure_count=least(3,failure_count+$2),state=case when failure_count+$2>=3 then 'paused' else 'running' end,
      next_check_at=case when $3::timestamptz is not null then $3 else clock_timestamp()+case failure_count when 0 then interval '1 minute'
        when 1 then interval '5 minutes' else interval '30 minutes' end end,updated_at=clock_timestamp() where id=$1`,
      [op.strategy_job_id,budget?0:1,budget?outcome.budgetResetAt??new Date(Date.now()+86400000).toISOString():null]);
  });
}

async function reconcileStrategyOperation(due:DuePortfolio,ctx:{dryRun:boolean;now:Date;deps:ResolvedDeps},base:Omit<PortfolioRunResult,'outcome'|'reason'>,op:UnresolvedOperation):Promise<PortfolioRunResult>{
  const blocked=(reason:string):PortfolioRunResult=>({...base,outcome:'blocked',reason});
  if(ctx.dryRun)return blocked('[PREVIOUS_INFLIGHT] 未知操作保留原身分，先對帳');
  await recordInflightSlots(ctx.deps.withTransaction,{chainId:ctx.deps.chainId,portfolioId:due.portfolioId,now:ctx.now});
  if(!op.user_op_hash)return blocked('[PREVIOUS_INFLIGHT] 原業務收據缺少hash；nonce前進不證明過去未成交，保留預算待對帳');
  const b=(await ctx.deps.query('select input_raw from strategy_job_batches where job_id=$1 and batch_index=$2',[op.strategy_job_id,op.strategy_batch_index])).rows[0] as {input_raw:InputVector}|undefined;
  if(!b)return blocked('原子批缺漏，先對帳');
  const cash=(ctx.deps.chainId===97?TESTNET_97.contracts.usdt:'0x55d398326f99059ff775485246999027b3197955') as Address;
  const result=await ctx.deps.reconcileRebalance({account:due.account,executor:ctx.deps.executor??executorAddress(),chainId:ctx.deps.chainId,
    userOpHash:op.user_op_hash,txHash:op.tx_hash,payloadHash:op.payload_hash,expectedInputs:b.input_raw,cash});
  if(result.kind==='not_found')return blocked('[PREVIOUS_INFLIGHT] 原業務收據查無；不能排除過去成交，保留預算待對帳');
  if(result.kind!=='found')return blocked('receipt／原 UserOp 證據缺漏，保留在途');
  const outcome=result.outcome,c={chainId:ctx.deps.chainId,portfolioId:due.portfolioId};
  if(outcome.status==='success'&&outcome.batchEvidence){
    await ctx.deps.query(SQL_MARK_SUBMITTED,[op.idempotency_key,outcome.userOpHash,outcome.txHash]);
    const row=(await ctx.deps.query('select id from operations where idempotency_key=$1',[op.idempotency_key])).rows[0] as {id:string}|undefined;
    if(!row)throw new Error('attempt missing');
    await settleStrategyBatch(ctx.deps.withTransaction,c,row.id,outcome.batchEvidence);
    return {...base,outcome:'executed',execution:outcome,reason:'已從原 receipt 恢復剩餘向量；本輪沒有重送'};
  }
  if(outcome.status==='reverted'){
    await failStrategyAttempt(ctx.deps,c,op.idempotency_key,'reverted',outcome);
    return {...base,outcome:'failed',execution:outcome,reason:'原操作已確認失敗；保留原預算，下一輪依退避重試'};
  }
  return blocked('業務成交證據缺漏，保留原預算及在途身分');
}

/** 一行摘要（CLI 與 log 都用它）。 */
export function formatResult(result: PortfolioRunResult, dryRun: boolean): string {
  const label: Record<PortfolioOutcome, string> = {
    noop: 'noop',
    blocked: 'blocked',
    'ready-dry-run': 'ready(dry-run)',
    executed: 'executed',
    failed: 'failed',
  };
  const suffix = result.execution?.txHash === undefined || result.execution?.txHash === null ? '' : ` tx=${result.execution.txHash}`;
  // dry-run 不推進 next_run_at（只讀不寫），所以那一行不能長得跟 live 一樣：DB 裡的值沒被改過。
  const nextRun = dryRun
    ? `next_run_at 未推進（dry-run 只讀不寫；若推進會是 ${result.nextRunAt.toISOString()}）`
    : `next_run_at ${result.nextRunAt.toISOString()}`;
  return (
    `[scheduler] portfolio ${result.portfolioId} → ${label[result.outcome]}${suffix}｜${nextRun}` +
    `${dryRun ? '｜dry-run（沒有送出任何交易）' : ''}\n           ${result.reason}`
  );
}
