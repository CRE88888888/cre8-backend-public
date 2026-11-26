import type { Address, Hex, PublicClient } from 'viem';

/**
 * 持有掃描：找出「帳戶有、但不在策略資產裡」的代幣——也就是**策略外持倉**。
 *
 * 為什麼需要這支檔案（語意在 2026-11 被修正，看清楚它現在回答什麼）
 *   讀取與定價的宇宙是策略的 `version.assets`，不是站上的 `priceable_assets` 全表：執行器只允許換
 *   `version.assets` 裡的代幣（`AtpExecutor.sol:180-182`），所以策略外的代幣**賣不掉**，不可能參與
 *   再平衡，也就不在漂移的分母裡。**它不會擋下漂移**（舊語意會，那是錯的：把「無法執行的東西」當成
 *   「必須處理的東西」，於是一顆空投就讓一個完全在目標上的投組停止再平衡）。
 *
 *   那為什麼還要掃？因為 **持有但未觀察 ≠ 不需要知道**：
 *     * 帳戶收到一顆沒人預期的代幣，是運維應該看得見的事實（可能是釣魚空投、可能是使用者自己買的）；
 *     * 它也可能是「這顆應該被加進策略」的訊號——但那是人做的決定，不是索引器替他猜。
 *   所以本檔把答案寫成**觀測訊號**（`unknown_token_count`、`universeComplete`），而不是 blocker。
 *
 * 這支檔案回答兩個不同的問題，混在一起就會回到那個 bug：
 *   ① 「策略資產都有價嗎？」                    → snapshot.ts 的 `complete`（0008，既有）
 *   ② 「我們確定看到了帳戶收過的每一筆轉入嗎？」→ 本檔的 `universeComplete`（0009）
 *   兩者都不受策略外持倉影響；`complete` 只回答「策略資產是否都有價」。
 *
 * 四個刻意的決定
 *
 * 1. **只看轉入，靠 `eth_getLogs` 的 topics，不靠掃 address。** 一次 `getLogs` 只帶
 *    `topics[0] = Transfer sig`、`topics[2] = 帳戶（32-byte 左補零）`，不帶 `address`：我們要的正
 *    是「這條鏈上所有代幣合約裡，有哪些 address 曾經轉東西給這個帳戶」，把 address 先框住就等於
 *    假設了答案。轉出（topics[1] = 帳戶）不看：那些代幣是「曾經持有」，不是「現在持有」。真實
 *    持倉一律由 `balanceOf` 決定，日誌只用來產生候選。
 *
 * 2. **分塊掃描，游標只越過「確實完整掃過」的連續區段。** 一次 `getLogs` 掃整個歷史是做不到的：公共 BSC RPC 對
 *    `eth_getLogs` 的區塊跨度有上限，而 anvil fork 對舊塊的請求會走上游 archive → 403
 *    （docs/pitfalls §2.1）。所以游標式增量掃描是唯一可行的形狀。不變的規則：**游標後面不可以有洞**——
 *    一個洞會讓某筆轉入永遠不被看到。所以失敗的那一段與它之後的任何一段都不算掃過。
 *
 *    原本的寫法更保守：「這一輪掃不完或中途失敗，`last_scanned_block` 一格都不動，包括失敗前已經成功的那幾段
 *    ——不推進只是下次多掃一次」。這句話在缺口很小時成立，缺口大時不成立（2026-11-25 測試網 portfolio 7：游標
 *    落後幾天，每輪從同一個起點重掃、被公開節點限流、又整輪作廢，缺口只會更大，每輪 30 秒握著共用市場通道）。
 *    「失敗前已成功的連續區段」裡沒有洞：那些日誌確實讀到了，裡面的候選也已經先落地（`saveCandidates` 在寫游標
 *    之前），所以游標越過它不會漏看任何東西。現在的規則：
 *      * 一輪分成幾批（`PROGRESS_BATCH_CHUNKS` 段一批）。每一批：掃轉入 → 候選落地 → `beforeAdvance`（自建組合
 *        的入出金同步，範圍就是這一批）→ 寫游標。三步任何一步失敗，游標停在上一批的終點，這一批下一輪重來。
 *      * 一批中途失敗時，游標只前進到失敗那一段之前（連續成功的部分），失敗那一段與之後的都不算。
 *      * 一輪有時間與段數上限（`SCAN_ROUND_BUDGET_MS`／`SCAN_ROUND_MAX_CHUNKS`）：到了就停，剩下的下一輪從
 *        游標接著掃。沒掃到 head 的那一輪 `universeComplete = false`，原因寫明還剩哪一段。
 *
 * 3. **游標覆蓋不到部署塊時，`universeComplete` 是 false 但不算 blocked。** 「還不知道」與
 *    「知道有問題」是兩件事：前者要在表頭標明「宇宙完整性未確認」，後者才擋漂移。把前者也擋掉，
 *    索引器在本機 fork 上就永遠沒有輸出（部署塊在 403 的區間裡，取不到），那等於用一個新的假
 *    答案換掉舊的假答案。
 *
 * 4. **候選要落地（0010），每一輪重讀全部列。** 只對「這一輪日誌看到的候選」讀 `balanceOf` 是
 *    一次性的偵測，而日誌視窗會前進：第 N 輪看到 CAKE、第 N+1 輪視窗裡沒有新日誌 → 候選集變空 →
 *    `unknown_token_count = 0`，於是那顆空投在下游憑空消失（它現在不擋漂移，但「帳戶收到過什麼」
 *    這個事實不該跟著記憶一起消失）。所以發現過的候選寫進 `portfolio_holding_candidates`，之後
 *    **每一輪**都對整張表重讀 `balanceOf`。而且這一步刻意與日誌掃描**解耦**：這一輪 `getLogs`
 *    失敗時，已經存下來的候選照樣要被重讀，否則「掃描失敗 → 忘記已知的持倉」是同一個 bug 的
 *    另一個版本。餘額歸零的候選不刪（它可能再度有餘額，屆時未必有日誌），只是不算入
 *    `unknownHoldings`。
 *
 * 部署塊怎麼取得（選了二分搜尋，不是 DB 的 created_at）
 *   `eth_getCode(account, block)` 在部署塊之前是 `0x`、之後不是，這個單調性讓二分搜尋可用，
 *   而且它讀的是**鏈上狀態**——權威。`smart_accounts.created_at` 是鏈下時間戳，要換成塊號得先
 *   有「時間 → 塊號」的索引，那在 anvil fork 上恰好是最讀不到的東西（403），而且時鐘與出塊時間
 *   的偏差會讓答案默默錯掉幾十個塊。所以：二分搜尋，取不到就明說取不到（`block: null` + reason），
 *   `universeComplete = false`——不猜。
 */

/** `Transfer(address,address,uint256)` 的 topic0。ERC-20 與 ERC-721 共用這個簽章。 */
export const TRANSFER_TOPIC: Hex = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * 每塊的區塊數（含頭尾，實際跨度 = chunkSize）。
 *
 * 2000 的理由是三個上限裡最緊的那個：
 *   * 公共 BSC RPC 的 `eth_getLogs` 跨度上限常見是 2k–10k（更小的有 1k），2000 落在多數節點都
 *     能吃下的區間；
 *   * 失敗的那一段要整段重做，所以 chunk 的大小 = 每次失敗要重做的量：太大會讓一支一直 403 的 RPC 每次
 *     都白掃幾萬個塊；
 *   * 上游可讀視窗（docs/pitfalls §2.1：publicnode 約 75–80 分鐘）在 BSC 0.75s 出塊下約 6000 個
 *     塊——2000 留了 3 倍餘裕，讓一個 chunk 的請求時間不會踩到那個邊界。
 * 不是「愈小愈好」：每次 getLogs 都是一次 RTT + 一次上游查詢，10 個塊一塊會把一次索引跑成一萬次請求。
 */
export const DEFAULT_CHUNK_SIZE = 2_000n;

/** 掃描游標。`startBlock - 1n` 代表「一塊都還沒掃」。 */
export type ScanCursor = { portfolioId: number; startBlock: bigint; lastScannedBlock: bigint };

/** 部署塊解析結果。`block: null` 一律代表「取不到」，呼叫端不得把它當成 0 或 head。 */
export type DeploymentBlock = {
  block: bigint | null;
  /** `not_before_cursor`: `block` is a lower bound (the cursor start); the exact block was not needed. */
  reason: 'resolved' | 'no_code_at_head' | 'deployed_before_search_from' | 'rpc_cannot_answer' | 'not_before_cursor';
  detail: string;
};

/** 一輪分塊掃描的結果。`failure` 非 null 時 `coveredTo` 之後的區間**沒有**被看過。 */
export type TransferScan = {
  /** 出現過的代幣合約地址（小寫，去重），含已知宇宙；扣掉已知才是候選。 */
  tokens: Address[];
  /**
   * 每顆代幣**第一次**出現的塊（小寫地址 → 塊）。`tokens` 只答「有哪些」，落地候選時還要答
   * 「什麼時候」：`first_seen_block` 只記第一次，而掃描結束後那個塊就再也回推不出來。
   */
  firstSeenBlock: Map<string, bigint>;
  /** 連續且成功掃過的區間；null = 一塊都沒掃成功。 */
  coveredRange: { fromBlock: bigint; toBlock: bigint } | null;
  /** 失敗的那一塊（沒有失敗時 null）。游標停在它前面，下一輪從這裡重掃。 */
  failedRange: { fromBlock: bigint; toBlock: bigint } | null;
  failure: string | null;
  /** 呼叫端喊停（`shouldStop`）時還沒掃的那一段；不是失敗，只是這一次沒輪到。沒喊停時 null。 */
  remainingRange: { fromBlock: bigint; toBlock: bigint } | null;
  /** ERC-20 形狀的 Transfer 日誌數。 */
  logCount: number;
  /** 4 個 topic 的 Transfer（ERC-721 形狀）：不是本檔能定價的東西，計數但不當候選。 */
  ignoredLogCount: number;
};

/** 有餘額的未知代幣。`decimals: null` = 讀不到 decimals，但仍然確定「持有」。 */
export type UnknownHolding = { asset: Address; amountWei: bigint; decimals: number | null };

export type HoldingScanResult = {
  portfolioId: number;
  /** 掃描用的 head；`balanceOf` 也釘在這個塊上。 */
  block: bigint;
  cursor: ScanCursor;
  /** 這一輪實際掃過的區間；null = 游標已經追上 head，沒有新區塊可掃。 */
  scannedRange: { fromBlock: bigint; toBlock: bigint } | null;
  /** 這一輪實際重讀 `balanceOf` 的候選個數：持久化候選表的全部列 ∪ 這一輪日誌新發現的（扣掉已知宇宙）。 */
  candidateCount: number;
  /**
   * 候選裡真的有餘額的那些 = 策略外持倉。**只是觀測訊號**：它不擋漂移（執行器換不掉它），
   * 但運維要看得到，所以它會進表頭的 `unknown_token_count`。
   */
  unknownHoldings: UnknownHolding[];
  /** 候選裡讀得到、但餘額是 0 的（歷史上進來又出去，不影響現在）。 */
  zeroBalanceCount: number;
  /** 候選裡 balanceOf 讀不到的：不確定有沒有持有，所以不算觀測到的持倉，但宇宙不算完整。 */
  unreadableCandidates: { asset: Address; reason: string }[];
  deployment: DeploymentBlock;
  /** true = 確定看過帳戶收過的每一筆轉入（見檔頭 ③）。 */
  universeComplete: boolean;
  /** `universeComplete === false` 的原因；空的代表完整。 */
  incompleteReasons: string[];
};

/**
 * snapshot.ts 的 `QueryFn` 是同一種形狀（只要求 `{ rows }`）。這裡刻意不 import 它：
 * snapshot.ts 會 import 本檔，兩個模組互相 import 只為了共用一行型別不值得。
 */
export type QueryFn = (text: string, params?: readonly unknown[]) => Promise<{ rows: unknown[] }>;

const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const;

/** The node's own words first (viem keeps them in `details`, after the URL and the request body in `message`). */
function reasonOf(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const details = (cause as { details?: unknown }).details;
  return typeof details === 'string' && details !== '' && !cause.message.startsWith(details) ? `${details}｜${cause.message}` : cause.message;
}

/** `address` → 32-byte 左補零的 topic（小寫）。 */
export function addressTopic(address: Address): Hex {
  const body = address.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(body)) throw new Error(`不是 0x + 40 hex 的地址：${address}`);
  return `0x${body.padStart(64, '0')}` as Hex;
}

function isErc20LogTopics(topics: readonly Hex[]): boolean {
  // ERC-20：3 個 topic（from、to indexed，value 在 data）。ERC-721 的第 4 個 topic 是 tokenId。
  return topics.length === 3;
}

/**
 * 找帳戶的部署塊：`getCode` 由 `0x` 變成有內容的那個塊。
 *
 * `searchFromBlock` 是「這個 RPC 保證讀得到的最早塊」——anvil fork 上就是 fork 塊（更早的一律
 * 403 Archive requests，docs/pitfalls §2.1）。預設 0 = 從創世二分，那條路只在 archive RPC 上成立。
 *
 * 三種「取不到」，都不猜：帳戶在 head 沒有 bytecode（EOA／還沒部署）、`searchFromBlock` 就有
 * bytecode（部署在更早、讀不到的地方）、二分中途有人 403／逾時。任何一種都回 `block: null`。
 * 特別注意**不可以**回一個「大概的低界」：`universeComplete` 的定義是 `startBlock <= 部署塊`，
 * 把部署塊報高會讓一個沒覆蓋到的游標看起來覆蓋到了——那正是這個 bug 的另一個版本。
 */
export async function findDeploymentBlock(
  client: PublicClient,
  args: { account: Address; head: bigint; searchFromBlock?: bigint },
): Promise<DeploymentBlock> {
  const searchFrom = args.searchFromBlock ?? 0n;
  if (searchFrom > args.head) throw new RangeError(`searchFromBlock(${searchFrom}) 大於 head(${args.head})`);

  let probe: bigint = args.head;
  try {
    if (await isEmptyCode(client, args.account, args.head)) {
      return {
        block: null,
        reason: 'no_code_at_head',
        detail: `帳戶在塊 ${args.head} 沒有 bytecode（EOA 或尚未部署），沒有部署塊可以界定掃描起點`,
      };
    }
    if (!(await isEmptyCode(client, args.account, searchFrom))) {
      return {
        block: null,
        reason: 'deployed_before_search_from',
        detail:
          `帳戶在搜尋下界 ${searchFrom} 就已經有 bytecode：部署塊在它之前，這個 RPC 讀不到` +
          `（anvil fork 對更早的塊一律 403 archive，docs/pitfalls §2.1）`,
      };
    }
    // 不變量：code(searchFrom) 為空、code(head) 非空 ⇒ 答案在 (searchFrom, head]。
    let lo = searchFrom;
    let hi = args.head;
    while (lo < hi) {
      const mid = lo + (hi - lo) / 2n;
      probe = mid;
      if (await isEmptyCode(client, args.account, mid)) lo = mid + 1n;
      else hi = mid;
    }
    return { block: lo, reason: 'resolved', detail: `部署塊 ${lo}（getCode 二分搜尋 [${searchFrom}, ${args.head}]）` };
  } catch (cause) {
    return {
      block: null,
      reason: 'rpc_cannot_answer',
      detail: `getCode(${args.account}, ${probe}) 失敗，部署塊取不到（${reasonOf(cause)}）`,
    };
  }
}

/**
 * With a cursor, completeness only asks「部署塊 >= 游標起點？」. Code is monotonic, so that is one getCode at
 * `startBlock - 1` (plus the head check) instead of a ~27-step bisection every scheduler round. Returns null
 * (→ full bisection, exact block and reason) when code exists before the cursor or the RPC cannot answer.
 */
async function deploymentNotBeforeCursor(client: PublicClient, account: Address, head: bigint, startBlock: bigint): Promise<DeploymentBlock | null> {
  if (startBlock <= 0n || startBlock > head) return null;
  try {
    const [atHead, beforeCursor] = await Promise.all([isEmptyCode(client, account, head), isEmptyCode(client, account, startBlock - 1n)]);
    if (atHead || !beforeCursor) return null;
    return { block: startBlock, reason: 'not_before_cursor',
      detail: `帳戶在游標起點前一塊 ${startBlock - 1n} 沒有 bytecode：部署塊 ≥ ${startBlock}，游標涵蓋部署` };
  } catch {
    return null;
  }
}

async function isEmptyCode(client: PublicClient, account: Address, blockNumber: bigint): Promise<boolean> {
  const code = await client.getCode({ address: account, blockNumber });
  return code === undefined || code === '0x' || code === '0x0';
}

/**
 * 一次 `eth_getLogs`：`topics = [Transfer sig, null, 帳戶]`——**不帶 address**（代幣合約未知正是
 * 要被找出來的東西），`topics[1] = null` 代表「誰轉的都算」，只有 `topics[2]`（to）釘死成帳戶，
 * 所以這一步就只看轉入。
 *
 * 為什麼不用 viem 的 `client.getLogs`：
 *   ① 它的型別把 topics 寫成 `[Hex, ...Hex[]]`（`types/log.d.ts`），而 RPC 允許 `null`（「這個位置
 *      不限」）。`[sig, null, to]` 是這個查詢的全部重點，硬塞型別斷言比直接發 RPC 更糟。
 *   ② 它會**解碼**日誌。同一組 topics 也命中 ERC-721 的 Transfer（第 4 個 topic 是 tokenId），
 *      拿 ERC-20 的 ABI 解 NFT 日誌會拋錯——一顆 NFT 轉進來不該讓掃描失敗、游標停住。
 *      這裡只取 `address` 與 topics 個數，判斷在呼叫端。
 *
 * 形狀在執行期驗一次（地址與 topics 必須是字串）：回傳型別是借來的，錯誤要當場炸，不要靜默。
 */
type RawLog = { address: Address; topics: readonly Hex[]; blockNumber: bigint };

async function getIncomingTransferLogs(
  client: PublicClient,
  args: { to: Hex; fromBlock: bigint; toBlock: bigint },
): Promise<RawLog[]> {
  const request = client.request as unknown as (rpcArgs: { method: string; params: unknown[] }) => Promise<unknown>;
  const raw = await request({
    method: 'eth_getLogs',
    params: [
      {
        topics: [TRANSFER_TOPIC, null, args.to],
        fromBlock: `0x${args.fromBlock.toString(16)}`,
        toBlock: `0x${args.toBlock.toString(16)}`,
      },
    ],
  });
  if (!Array.isArray(raw)) throw new Error(`eth_getLogs 沒有回傳陣列（收到 ${typeof raw}）`);
  return raw.map((entry, index) => {
    const log = entry as { address?: unknown; topics?: unknown; blockNumber?: unknown };
    if (typeof log.address !== 'string' || !Array.isArray(log.topics)) {
      throw new Error(`eth_getLogs 第 ${index} 筆不是日誌（address/topics 形狀不對）`);
    }
    return {
      address: log.address.toLowerCase() as Address,
      topics: log.topics as Hex[],
      blockNumber: logBlockNumber(log.blockNumber, index, args.toBlock),
    };
  });
}

/**
 * 日誌所在的塊。RPC 給的是 hex 字串；取不到就退回這一塊查詢的上界——`first_seen_block` 是給人看的
 * 時間軸，不是游標，退回一個「不會晚於實際發生」的塊比為了一筆怪日誌擋下整輪掃描好。
 */
function logBlockNumber(value: unknown, index: number, fallback: bigint): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
    console.warn(`[holdings-scan] eth_getLogs 第 ${index} 筆沒有可讀的 blockNumber（收到 ${JSON.stringify(value)}），用 ${fallback}`);
    return fallback;
  }
  return BigInt(value);
}

/**
 * 分塊掃「轉入」日誌，回傳出現過的代幣地址。
 *
 * 只看轉入：`topics[2]`（to）＝帳戶，不帶 `address`（代幣合約未知正是要被找出來的東西）。任何一塊
 * 失敗就停在那一塊，回報失敗範圍，**不假裝後面的塊掃過了**；前面成功的部分照樣回傳（裡面若有
 * 有餘額的策略外代幣，那是要被記錄下來的觀測，不是要被擋下的問題）。
 *
 * `concurrency`：同時在飛的段數（預設 1）。同一組裡排在失敗那一段後面的段就算成功也丟掉——`coveredRange`
 * 永遠是從 `fromBlock` 起連續成功的部分。`shouldStop`：每一組開始前問一次（第一組不問，所以每次呼叫至少
 * 前進一組）；回 true 就停，剩下的寫在 `remainingRange`。
 */
export async function scanIncomingTransfers(
  client: PublicClient,
  args: { account: Address; fromBlock: bigint; toBlock: bigint; chunkSize?: bigint; concurrency?: number; shouldStop?: () => boolean },
): Promise<TransferScan> {
  const chunkSize = args.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (chunkSize <= 0n) throw new RangeError(`chunkSize 必須是正數（收到 ${chunkSize}）`);
  if (args.fromBlock > args.toBlock) throw new RangeError(`fromBlock(${args.fromBlock}) 大於 toBlock(${args.toBlock})`);
  const concurrency = args.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError(`concurrency 必須是正整數（收到 ${concurrency}）`);

  const to = addressTopic(args.account);
  const tokens = new Set<string>();
  const firstSeenBlock = new Map<string, bigint>();
  let logCount = 0;
  let ignoredLogCount = 0;
  let coveredTo: bigint | null = null;
  const result = (rest: Pick<TransferScan, 'failedRange' | 'failure' | 'remainingRange'>): TransferScan => ({
    tokens: [...tokens] as Address[],
    firstSeenBlock,
    coveredRange: coveredTo === null ? null : { fromBlock: args.fromBlock, toBlock: coveredTo },
    ...rest,
    logCount,
    ignoredLogCount,
  });

  for (let start = args.fromBlock; start <= args.toBlock; ) {
    if (coveredTo !== null && args.shouldStop?.() === true) {
      return result({ failedRange: null, failure: null, remainingRange: { fromBlock: start, toBlock: args.toBlock } });
    }
    const group: { start: bigint; end: bigint }[] = [];
    for (let from = start; from <= args.toBlock && group.length < concurrency; from += chunkSize) {
      group.push({ start: from, end: from + chunkSize - 1n > args.toBlock ? args.toBlock : from + chunkSize - 1n });
    }
    const settled = await Promise.allSettled(group.map((chunk) => getIncomingTransferLogs(client, { to, fromBlock: chunk.start, toBlock: chunk.end })));
    for (const [index, chunk] of group.entries()) {
      const outcome = settled[index]!;
      if (outcome.status === 'rejected') {
        return result({ failedRange: { fromBlock: chunk.start, toBlock: chunk.end },
          failure: `getLogs [${chunk.start}, ${chunk.end}] 失敗：${reasonOf(outcome.reason)}`, remainingRange: null });
      }
      for (const log of outcome.value) {
        if (!isErc20LogTopics(log.topics)) {
          ignoredLogCount += 1;
          continue;
        }
        logCount += 1;
        tokens.add(log.address.toLowerCase());
        if (!firstSeenBlock.has(log.address.toLowerCase())) firstSeenBlock.set(log.address.toLowerCase(), log.blockNumber);
      }
      coveredTo = chunk.end;
    }
    start = group[group.length - 1]!.end + 1n;
  }
  return result({ failedRange: null, failure: null, remainingRange: null });
}

/** 候選扣掉已知宇宙 → 逐顆讀 `balanceOf(account)`，回傳真的有餘額的。 */
export async function readUnknownHoldings(
  client: PublicClient,
  args: { account: Address; block: bigint; tokens: readonly Address[]; knownTokens: readonly string[] },
): Promise<{
  unknownHoldings: UnknownHolding[];
  zeroBalanceCount: number;
  unreadableCandidates: { asset: Address; reason: string }[];
  /**
   * **成功讀到**的每一個候選（含餘額 0 的）。落回候選表用：讀不到的不在裡面——把「不知道」寫成 0
   * 就是下一個「看起來合理的假答案」。
   */
  balances: { asset: Address; amountWei: bigint }[];
}> {
  const known = new Set(args.knownTokens.map((token) => token.toLowerCase()));
  const unknownHoldings: UnknownHolding[] = [];
  const unreadableCandidates: { asset: Address; reason: string }[] = [];
  const balances: { asset: Address; amountWei: bigint }[] = [];
  let zeroBalanceCount = 0;

  const candidates = args.tokens.filter((token) => !known.has(token.toLowerCase()));
  const read = await Promise.all(
    candidates.map(async (asset) => {
      try {
        const amountWei = await client.readContract({
          address: asset,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [args.account],
          blockNumber: args.block,
        });
        return { asset, amountWei, error: null };
      } catch (cause) {
        return { asset, amountWei: 0n, error: `balanceOf 讀不到（${reasonOf(cause)}）` };
      }
    }),
  );

  for (const candidate of read) {
    if (candidate.error !== null) {
      unreadableCandidates.push({ asset: candidate.asset, reason: candidate.error });
      continue;
    }
    balances.push({ asset: candidate.asset, amountWei: candidate.amountWei });
    // 餘額 0 = 歷史上進來又出去，對現在的投組沒有貢獻，忽略它（不要因為「曾經」擋下漂移）。
    if (candidate.amountWei === 0n) {
      zeroBalanceCount += 1;
      continue;
    }
    let decimals: number | null = null;
    try {
      decimals = await client.readContract({
        address: candidate.asset,
        abi: ERC20_ABI,
        functionName: 'decimals',
        blockNumber: args.block,
      });
    } catch {
      // 讀不到 decimals 不影響「持有」這件事；金額照留，只是顯示不出顆數。
      decimals = null;
    }
    unknownHoldings.push({ asset: candidate.asset, amountWei: candidate.amountWei, decimals });
  }
  return { unknownHoldings, zeroBalanceCount, unreadableCandidates, balances };
}

// ---------------------------------------------------------------------------
// 游標（DB）
// ---------------------------------------------------------------------------

/** pg 對 bigint 一律回字串；收不到整數就拋錯，不猜成 0。 */
function toBlock(value: unknown, what: string): bigint {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`${what} 不是 bigint 字串（收到 ${JSON.stringify(value)}）`);
  }
  const text = typeof value === 'number' ? (Number.isSafeInteger(value) ? String(value) : '') : value;
  if (!/^-?\d+$/.test(text)) throw new Error(`${what} 不是整數（收到 ${JSON.stringify(value)}）`);
  return BigInt(text);
}

export const SQL_LOAD_CURSOR =
  'select portfolio_id, start_block::text as start_block, last_scanned_block::text as last_scanned_block from portfolio_scan_cursors where portfolio_id = $1';

export async function loadCursor(query: QueryFn, portfolioId: number): Promise<ScanCursor | null> {
  const row = (await query(SQL_LOAD_CURSOR, [portfolioId])).rows[0] as
    | { portfolio_id?: unknown; start_block?: unknown; last_scanned_block?: unknown }
    | undefined;
  if (row === undefined) return null;
  return {
    portfolioId: Number(row.portfolio_id),
    startBlock: toBlock(row.start_block, 'portfolio_scan_cursors.start_block'),
    lastScannedBlock: toBlock(row.last_scanned_block, 'portfolio_scan_cursors.last_scanned_block'),
  };
}

/**
 * 推進游標。**start_block 永不被覆寫**：一個後來才出現的、更小的 start_block 會憑空宣稱掃過
 * 它其實沒掃過的歷史（`universeComplete` 正是拿 start_block 去比部署塊）。last_scanned_block
 * 只前進，不後退。
 */
export const SQL_SAVE_CURSOR = `
  insert into portfolio_scan_cursors (portfolio_id, start_block, last_scanned_block)
  values ($1, $2, $3)
  on conflict (portfolio_id) do update
    set last_scanned_block = greatest(portfolio_scan_cursors.last_scanned_block, excluded.last_scanned_block),
        updated_at = now()`;

export async function saveCursor(query: QueryFn, cursor: ScanCursor): Promise<void> {
  await query(SQL_SAVE_CURSOR, [cursor.portfolioId, cursor.startBlock.toString(), cursor.lastScannedBlock.toString()]);
}

// ---------------------------------------------------------------------------
// 候選（DB，0010）
//
// 游標記錄「掃到哪」，候選表記錄「看過誰」。兩者是不同的記憶：游標會前進（舊視窗就再也看不到），
// 候選只會長大（看過就永遠繼續看）。0009 只有前者，所以 bug 只是被延後一輪。
// ---------------------------------------------------------------------------

/** 一列候選：一顆「曾經轉入過的宇宙外代幣」。 */
export type HoldingCandidate = { asset: Address; firstSeenBlock: bigint; lastBalanceWei: bigint };

export const SQL_LOAD_CANDIDATES = `
  select asset, first_seen_block::text as first_seen_block, last_balance_wei::text as last_balance_wei
    from portfolio_holding_candidates
   where portfolio_id = $1
   order by asset`;

/** 讀回這個 portfolio 的**全部**候選。每一輪都要呼叫，與日誌掃描成敗無關。 */
export async function loadCandidates(query: QueryFn, portfolioId: number): Promise<HoldingCandidate[]> {
  const rows = (await query(SQL_LOAD_CANDIDATES, [portfolioId])).rows as {
    asset?: unknown;
    first_seen_block?: unknown;
    last_balance_wei?: unknown;
  }[];
  return rows.map((row) => {
    if (typeof row.asset !== 'string') throw new Error(`候選表的 asset 不是字串（收到 ${JSON.stringify(row.asset)}）`);
    return {
      asset: row.asset as Address,
      firstSeenBlock: toBlock(row.first_seen_block, 'portfolio_holding_candidates.first_seen_block'),
      lastBalanceWei: toBlock(row.last_balance_wei, 'portfolio_holding_candidates.last_balance_wei'),
    };
  });
}

/**
 * 記下這一輪日誌看到的宇宙外代幣。`first_seen_block` **只記第一次**（`do nothing`）：重複發現
 * 不該把它改寫成最近一次，否則「它潛伏了多久」就答不出來。
 *
 * 掃描失敗時也照樣寫：失敗前已成功掃過的區段是真實的觀測，裡面的代幣與「這一輪有沒有掃完」
 * 無關。反過來（只在整輪成功時才寫）會讓那些代幣在游標不前進的無限重試裡永遠進不了表。
 */
export const SQL_INSERT_CANDIDATES = `
  insert into portfolio_holding_candidates (portfolio_id, asset, first_seen_block)
  select $1::bigint, discovered.asset, discovered.first_seen_block
    from unnest($2::text[], $3::bigint[]) as discovered(asset, first_seen_block)
  on conflict (portfolio_id, asset) do nothing`;

export async function saveCandidates(
  query: QueryFn,
  args: { portfolioId: number; candidates: readonly { asset: Address; firstSeenBlock: bigint }[] },
): Promise<void> {
  if (args.candidates.length === 0) return;
  await query(SQL_INSERT_CANDIDATES, [
    args.portfolioId,
    args.candidates.map((candidate) => candidate.asset.toLowerCase()),
    args.candidates.map((candidate) => candidate.firstSeenBlock.toString()),
  ]);
}

/**
 * 把這一輪**成功讀到**的餘額寫回候選列。讀不到的列不在 `balances` 裡，於是保留舊值——
 * `balanceOf` 讀不到 ≠ 餘額 0，把前者寫成後者正是本檔案要消滅的那種「看起來合理的錯」。
 *
 * 餘額 0 **不刪列**：它可能再度有餘額，而屆時未必有日誌被我們看到。刪掉它等於把「我們曾經不知道
 * 過」一起刪掉。只是 0 不算入 `unknownHoldings`。
 */
export const SQL_TOUCH_CANDIDATES = `
  update portfolio_holding_candidates as candidate
     set last_balance_wei = checked.balance_wei::numeric(78,0),
         last_checked_at  = now()
    from unnest($2::text[], $3::text[]) as checked(asset, balance_wei)
   where candidate.portfolio_id = $1
     and candidate.asset = checked.asset`;

export async function touchCandidates(
  query: QueryFn,
  args: { portfolioId: number; balances: readonly { asset: Address; amountWei: bigint }[] },
): Promise<void> {
  if (args.balances.length === 0) return;
  await query(SQL_TOUCH_CANDIDATES, [
    args.portfolioId,
    args.balances.map((balance) => balance.asset.toLowerCase()),
    args.balances.map((balance) => balance.amountWei.toString()),
  ]);
}

// ---------------------------------------------------------------------------
// 一輪掃描
// ---------------------------------------------------------------------------

/**
 * What one round's log scan was asked and how far it got. Diagnostics only (the `holdings_scan` log line of
 * snapshot.ts): nothing here feeds a decision. 2026-11-25: a private basket's plan took 30 s every round and nothing
 * said whether the cursor moved, where the scan stopped or why.
 */
export type ScanStats = {
  /** `last_scanned_block` before this round (`start_block - 1` for a new cursor). */
  cursorBefore: bigint;
  head: bigint;
  chunkSize: bigint;
  /** null = the cursor was already at head: nothing to scan. */
  asked: { fromBlock: bigint; toBlock: bigint } | null;
  /** Last block of the contiguous part that was read; null = not one chunk succeeded. */
  coveredTo: bigint | null;
  failedRange: { fromBlock: bigint; toBlock: bigint } | null;
  /** The failure as it goes to a log: URLs masked (an RPC URL can carry a key), one line, capped. */
  failure: string | null;
  /** Left for the next round by the round budget (no failure); null otherwise. */
  remainingRange: { fromBlock: bigint; toBlock: bigint } | null;
  scanMs: number;
};

/** One line, URLs masked, capped: safe for a log. */
export function scanFailureForLog(text: string): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`)]+/gi, '<url>').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** One cash-flow sync of a private basket inside a plan: `advance` = before the cursor write, `catchup` = the cursor stayed behind head. */
export type FlowSyncStat = { via: 'advance' | 'catchup'; fromBlock: bigint; toBlock: bigint; ms: number; failure: string | null };
export const SCAN_LOG_SLOW_MS = 2_000;

/**
 * The `holdings_scan` log line of one plan, or null when there is nothing to say (the usual round: at most two chunks,
 * no failure, fast). Block numbers, counts, durations and a masked failure only: no key, no URL.
 * `cursorAfter`: `last_scanned_block` when the scan returned; null when it threw (nothing is known to have moved).
 */
export function formatScanLog(args: { portfolioId: number; personalMix: boolean; stats: ScanStats | null; cursorAfter: bigint | null;
  flowSyncs: readonly FlowSyncStat[]; ms: number }): { level: 'info' | 'warn'; line: string } | null {
  const { stats } = args;
  const failed = stats?.failure != null || args.flowSyncs.some((sync) => sync.failure !== null);
  const gap = stats === null || stats.asked === null ? 0n : stats.asked.toBlock - stats.asked.fromBlock + 1n;
  // Two chunks is an ordinary round (15 minutes of chain 97 is a little over 2,000 blocks): only a larger gap is worth a line.
  // Slow = the log scan plus the flow syncs (`ms` is the whole observation, which also reads balances and prices).
  const spent = (stats?.scanMs ?? 0) + args.flowSyncs.reduce((sum, sync) => sum + sync.ms, 0);
  if (!failed && spent < SCAN_LOG_SLOW_MS && (stats === null || gap <= 2n * stats.chunkSize)) return null;
  const chunks = (blocks: bigint) => (stats === null || blocks <= 0n ? 0 : Number((blocks + stats.chunkSize - 1n) / stats.chunkSize));
  const line = JSON.stringify({
    msg: 'holdings_scan',
    portfolio: args.portfolioId,
    mix: args.personalMix,
    ms: Math.round(args.ms),
    ...(stats === null ? { scan: 'not reported' } : {
      head: stats.head.toString(),
      cursor: stats.cursorBefore.toString(),
      cursorAfter: args.cursorAfter === null ? null : args.cursorAfter.toString(),
      gapBlocks: gap.toString(),
      chunks: chunks(gap),
      chunksOk: stats.asked === null || stats.coveredTo === null ? 0 : chunks(stats.coveredTo - stats.asked.fromBlock + 1n),
      scanMs: stats.scanMs,
      failedRange: stats.failedRange === null ? null : [stats.failedRange.fromBlock.toString(), stats.failedRange.toBlock.toString()],
      failure: stats.failure,
      remaining: stats.remainingRange === null ? null : [stats.remainingRange.fromBlock.toString(), stats.remainingRange.toBlock.toString()],
    }),
    flowSyncs: args.flowSyncs.map((sync) => ({ via: sync.via, from: sync.fromBlock.toString(), to: sync.toBlock.toString(), ms: Math.round(sync.ms), failure: sync.failure })),
  });
  return { level: failed ? 'warn' : 'info', line };
}

/** 幾段一批。一批＝一個「掃轉入 → 候選落地 → `beforeAdvance` → 寫游標」的單位：失敗最多重做一批。25 段＝50,000 塊。 */
export const PROGRESS_BATCH_CHUNKS = 25;
/** 同時在飛的轉入日誌查詢數（跟自建組合現金流同步原本的「兩個查詢一起發」同一個量級，不多打公開節點）。 */
export const SCAN_CONCURRENCY = 2;
/**
 * 一輪掃描的上限：到了就停，剩下的下一輪從游標接著掃（規劃是握著共用市場通道做的，不能為了追進度握 30 秒）。
 * 平常一輪的缺口是一段（15 分鐘 ≈ 2,000 塊），碰不到上限；只有游標落後很多（排程器停了幾天、帳戶久沒被處理）才會。
 * 150 段＝300,000 塊（鏈上約 37 小時）。時間上限在每一組查詢開始前檢查，所以一輪最多超出一組查詢的時間。
 */
export const SCAN_ROUND_BUDGET_MS = 4_000;
export const SCAN_ROUND_MAX_CHUNKS = 150;

export type ScanDeps = {
  /**
   * 游標要越過 `range` 之前先做的事（自建組合：把這一段的入出金同步進帳本）。每一批呼叫一次，範圍就是那一批
   * 連續掃成功的部分；它拋錯時游標停在上一批的終點，錯誤照樣往外拋。
   */
  beforeAdvance?: (range: { fromBlock: bigint; toBlock: bigint }) => Promise<void>;
  /** Called once per round, when the log scan is over (also when `beforeAdvance` or a write threw), before balances are read. */
  onScan?: (stats: ScanStats) => void;
  /** 一輪的上限（測試用；預設 SCAN_ROUND_BUDGET_MS／SCAN_ROUND_MAX_CHUNKS）。`now` 回毫秒。 */
  budget?: { maxMs?: number; maxChunks?: number; now?: () => number };
  client: PublicClient;
  query: QueryFn;
  portfolioId: number;
  account: Address;
  /** 已知宇宙 = 策略的 `version.assets`（小寫地址）。扣掉它才是「策略外」候選。 */
  knownTokens: readonly string[];
  /** 省略時讀 head。所有 `balanceOf` 都釘在這個塊上。 */
  head?: bigint;
  chunkSize?: bigint;
  /** 這個 RPC 保證讀得到的最早塊；anvil fork 上請傳 fork 塊，否則部署塊永遠取不到。 */
  searchFromBlock?: bigint;
};

/**
 * 一輪持有掃描：部署塊 → 游標 → 一批一批（掃轉入 → 候選落地 → `beforeAdvance` → 寫游標）→ 讀餘額 → 決定宇宙完整性。
 *
 * 游標「第一次」的起點挑選：知道部署塊就從部署塊開始（那才有機會讓 `universeComplete` 變 true），
 * 不知道就從 head 開始——本機 fork 沒能力回填歷史，假裝掃過創世以來才是真正的錯。從 head 開始的
 * 游標永遠 `universeComplete = false`（head > 部署塊），這正是它該有的答案。
 */
export async function scanPortfolioHoldings(deps: ScanDeps): Promise<HoldingScanResult> {
  const block = deps.head ?? (await deps.client.getBlockNumber({ cacheTime: 0 }));
  const existing = await loadCursor(deps.query, deps.portfolioId);
  const deployment = (existing === null || (deps.searchFromBlock ?? 0n) >= existing.startBlock ? null : await deploymentNotBeforeCursor(deps.client, deps.account, block, existing.startBlock)) ??
    await findDeploymentBlock(deps.client, {
      account: deps.account,
      head: block,
      searchFromBlock: deps.searchFromBlock,
    });

  const cursor: ScanCursor =
    existing ?? { portfolioId: deps.portfolioId, startBlock: deployment.block ?? block, lastScannedBlock: (deployment.block ?? block) - 1n };

  const known = new Set(deps.knownTokens.map((token) => token.toLowerCase()));
  const chunkSize = deps.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (chunkSize <= 0n) throw new RangeError(`chunkSize 必須是正數（收到 ${chunkSize}）`);
  const now = deps.budget?.now ?? (() => performance.now());
  const maxMs = deps.budget?.maxMs ?? SCAN_ROUND_BUDGET_MS;
  const maxChunks = Math.max(1, deps.budget?.maxChunks ?? SCAN_ROUND_MAX_CHUNKS);

  // 一批一批往前（檔頭 ②）：① 掃轉入 → ② 這一批看到的宇宙外代幣先落地（first_seen_block 只記第一次；掃描失敗也照寫，
  // 見 SQL_INSERT_CANDIDATES 的註解）→ ③ `beforeAdvance` → ④ 寫游標。游標只越過 ①②③ 都做完的連續區段。
  const fromBlock = cursor.lastScannedBlock + 1n;
  const discovered: { asset: Address; firstSeenBlock: bigint }[] = [];
  let advanced = cursor;
  let scanFailure: string | null = null;
  let failedRange: { fromBlock: bigint; toBlock: bigint } | null = null;
  let remainingRange: { fromBlock: bigint; toBlock: bigint } | null = null;
  let chunksDone = 0;
  let scanMs = 0;
  const roundStarted = now();
  const outOfTime = (): boolean => now() - roundStarted >= maxMs;
  try {
    for (let from = fromBlock; from <= block; ) {
      // 第一批一定做（每一輪至少前進一組查詢）；之後每一批開始前看上限。
      if (chunksDone > 0 && (chunksDone >= maxChunks || outOfTime())) {
        remainingRange = { fromBlock: from, toBlock: block };
        break;
      }
      const batchChunks = BigInt(Math.min(PROGRESS_BATCH_CHUNKS, maxChunks - chunksDone));
      const batchTo = from + chunkSize * batchChunks - 1n > block ? block : from + chunkSize * batchChunks - 1n;
      const batchStarted = now();
      const scan = await scanIncomingTransfers(deps.client, {
        account: deps.account,
        fromBlock: from,
        toBlock: batchTo,
        chunkSize,
        concurrency: SCAN_CONCURRENCY,
        shouldStop: outOfTime,
      });
      scanMs += now() - batchStarted;

      const found: { asset: Address; firstSeenBlock: bigint }[] = [];
      for (const token of scan.tokens) {
        const asset = token.toLowerCase() as Address;
        if (known.has(asset)) continue;
        found.push({ asset, firstSeenBlock: scan.firstSeenBlock.get(asset) ?? scan.coveredRange?.toBlock ?? block });
      }
      await saveCandidates(deps.query, { portfolioId: deps.portfolioId, candidates: found });
      for (const candidate of found) if (!discovered.some((seen) => seen.asset === candidate.asset)) discovered.push(candidate);

      if (scan.coveredRange !== null) {
        await deps.beforeAdvance?.(scan.coveredRange);
        advanced = { ...cursor, lastScannedBlock: scan.coveredRange.toBlock };
        await saveCursor(deps.query, advanced);
        chunksDone += Number((scan.coveredRange.toBlock - scan.coveredRange.fromBlock + chunkSize) / chunkSize);
      }
      if (scan.failure !== null) {
        scanFailure = scan.failure;
        failedRange = scan.failedRange;
        break;
      }
      if (scan.remainingRange !== null) {
        remainingRange = { fromBlock: scan.remainingRange.fromBlock, toBlock: block };
        break;
      }
      from = batchTo + 1n;
    }
  } finally {
    deps.onScan?.({
      cursorBefore: cursor.lastScannedBlock,
      head: block,
      chunkSize,
      asked: fromBlock > block ? null : { fromBlock, toBlock: block },
      coveredTo: advanced.lastScannedBlock > cursor.lastScannedBlock ? advanced.lastScannedBlock : null,
      failedRange,
      failure: scanFailure === null ? null : scanFailureForLog(scanFailure),
      remainingRange,
      scanMs: Math.round(scanMs),
    });
  }

  // ② 重讀**候選表的全部列**（∪ 這一輪新發現的），而不只是這一輪日誌看到的。
  //    這一步刻意與日誌掃描解耦：`scan === null`（游標已追上 head、沒有新日誌）或 `scan.failure`
  //    非 null 時，已經存下來的候選仍然要重讀。少了這一點，第 N 輪發現的 CAKE 會在「沒有新日誌」
  //    的下一輪憑空消失——那正是 0010 要消滅的 bug。
  //
  //    讀不到候選表時 fail-closed：這一輪沒有重讀，就不能宣稱宇宙是完整的，所以記下原因並讓
  //    `universeComplete = false`（與「部署塊取不到」同一條規則：取不到就明說取不到，不猜）。
  //    寫入則照樣拋錯——靜默丟掉「看過誰」的記憶，就是這支檔案要修的那個 bug 本身。
  let persisted: HoldingCandidate[] = [];
  let candidateStoreFailure: string | null = null;
  try {
    persisted = await loadCandidates(deps.query, deps.portfolioId);
  } catch (cause) {
    candidateStoreFailure =
      `候選表讀不到（${reasonOf(cause)}）：這一輪無法重讀過去發現的宇宙外代幣，宇宙完整性未確認`;
  }
  const candidateAssets = [
    ...new Set([...persisted.map((candidate) => candidate.asset.toLowerCase()), ...discovered.map((c) => c.asset)]),
  ].filter((asset) => !known.has(asset)) as Address[];

  const held = await readUnknownHoldings(deps.client, {
    account: deps.account,
    block,
    tokens: candidateAssets,
    knownTokens: deps.knownTokens,
  });

  // ③ 成功讀到的餘額寫回候選表（讀不到的不寫：保留舊值比偽造一個 0 誠實）。餘額 0 的列留著。
  await touchCandidates(deps.query, { portfolioId: deps.portfolioId, balances: held.balances });

  const incompleteReasons: string[] = [];
  if (candidateStoreFailure !== null) incompleteReasons.push(candidateStoreFailure);
  if (deployment.block === null) {
    incompleteReasons.push(`部署塊取不到（${deployment.reason}）：${deployment.detail}`);
  } else if (cursor.startBlock > deployment.block) {
    incompleteReasons.push(
      `游標起點 ${cursor.startBlock} 晚於部署塊 ${deployment.block}：` +
        `那之前的轉入沒有被觀察過，宇宙可能缺項（本機 fork 無法回填歷史）`,
    );
  }
  if (scanFailure !== null) incompleteReasons.push(scanFailure);
  if (remainingRange !== null) {
    incompleteReasons.push(
      `這一輪掃到 ${advanced.lastScannedBlock}（每輪上限 ${maxChunks} 段／${maxMs} 毫秒）：[${remainingRange.fromBlock}, ${remainingRange.toBlock}] 下一輪接著掃`,
    );
  }
  if (held.unreadableCandidates.length > 0) {
    incompleteReasons.push(
      `${held.unreadableCandidates.length} 個候選代幣的 balanceOf 讀不到，無法確認餘額：` +
        held.unreadableCandidates.map((candidate) => candidate.asset).join('、'),
    );
  }

  return {
    portfolioId: deps.portfolioId,
    block,
    cursor: advanced,
    scannedRange: advanced.lastScannedBlock > cursor.lastScannedBlock ? { fromBlock, toBlock: advanced.lastScannedBlock } : null,
    candidateCount: candidateAssets.length,
    unknownHoldings: held.unknownHoldings,
    zeroBalanceCount: held.zeroBalanceCount,
    unreadableCandidates: held.unreadableCandidates,
    deployment,
    universeComplete: incompleteReasons.length === 0,
    incompleteReasons,
  };
}

function formatAmount(amountWei: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = amountWei / scale;
  const fraction = ((amountWei % scale) * 1_000_000n) / scale;
  return `${whole}.${fraction.toString().padStart(6, '0')} 顆`;
}

/** CLI 要印的幾行（`index-portfolio.ts` 在表頭摘要附近呼叫）。 */
export function formatScanStatus(result: HoldingScanResult): string[] {
  const lines: string[] = [];
  const range =
    result.scannedRange === null
      ? '已追上 head，沒有新區塊'
      : `掃過 [${result.scannedRange.fromBlock}, ${result.scannedRange.toBlock}]`;
  lines.push(
    `持倉掃描     游標 [${result.cursor.startBlock}, ${result.cursor.lastScannedBlock}]，${range}，` +
      `重讀 ${result.candidateCount} 顆宇宙外候選（含過去發現、已存進 0010 候選表的那些）`,
  );
  lines.push(
    `宇宙完整性   ${result.universeComplete ? '已確認（帳戶擁有的全部代幣都看過）' : '⚠ 未確認（可能漏看某些持倉，漂移不可全信）'}`,
  );
  if (result.unknownHoldings.length > 0) {
    lines.push(
      '⚠ 宇宙外的持倉：' +
        result.unknownHoldings
          .map((holding) => `${holding.asset}${holding.decimals === null ? '' : ` ${formatAmount(holding.amountWei, holding.decimals)}`}`)
          .join('、'),
    );
  }
  if (result.zeroBalanceCount > 0) {
    lines.push(`（另有 ${result.zeroBalanceCount} 顆宇宙外代幣餘額為 0：歷史上進來又出去，不影響現在）`);
  }
  for (const reason of result.incompleteReasons) lines.push(`  ! ${reason}`);
  return lines;
}
