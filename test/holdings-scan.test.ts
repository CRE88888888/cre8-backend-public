import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Address, Hex, PublicClient } from 'viem';
import { closePool, query } from '../src/db.js';
import {
  addressTopic,
  DEFAULT_CHUNK_SIZE,
  findDeploymentBlock,
  formatScanLog,
  formatScanStatus,
  PROGRESS_BATCH_CHUNKS,
  SCAN_CONCURRENCY,
  SCAN_ROUND_BUDGET_MS,
  SCAN_ROUND_MAX_CHUNKS,
  loadCandidates,
  loadCursor,
  saveCandidates,
  saveCursor,
  scanIncomingTransfers,
  scanPortfolioHoldings,
  touchCandidates,
} from '../src/holdings-scan.js';
import type { QueryFn, ScanCursor, ScanStats } from '../src/holdings-scan.js';

/**
 * `src/holdings-scan.ts` 的測試：鏈用 stub、游標用真的 Postgres。
 *
 * 這支檔案要釘住的是 0009 修的那個 bug 的四個面向：
 * 1. **只看轉入。** 帳戶轉出去的東西不是持倉；ERC-721 形狀的 Transfer（4 個 topic）不是 ERC-20。
 * 2. **分塊，而且游標只越過確實完整掃過的連續區段。** 一個洞會讓某筆轉入永遠不被看到（失敗那一段與之後的都不算）；
 *    失敗前連續掃成功的部分算數，一輪有上限、下一輪從游標接續（2b）。
 * 3. **餘額 0 的候選不算持倉。** 歷史上進來又出去的東西不該進「帳戶現在有什麼」的觀測記錄。
 * 4. **universe_complete 只在游標覆蓋到部署塊時為 true。** 那是「掃描有沒有覆蓋帳戶一生」的唯一訊號，
 *    與漂移可不可信無關（策略外持倉只記錄、不阻擋，見 src/holdings-scan.ts 檔頭）。
 *
 * 為什麼鏈用 stub 而不是 anvil：這幾條規則要驗的是「塊範圍怎麼切、游標什麼時候動、哪些日誌算候選」，
 * 用真鏈反而驗不到邊界（要製造 403、ERC-721、跨塊失敗都得靠運氣）。真鏈的驗證在
 * `snapshot.integration.test.ts` 那一類整合測試與 0009 的實測記錄裡。
 */

const TRANSFER_TOPIC: Hex = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ACCOUNT = '0x2b082fadf8f3d620eaa242a9e36817af8640d042' as Address;
const OTHER = '0x1111111111111111111111111111111111111111' as Address;
const CAKE = '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82' as Address;
const NFT = '0x2222222222222222222222222222222222222222' as Address;
const KNOWN = '0x55d398326f99059ff775485246999027b3197955' as Address;

/** 一筆 stub 日誌。topics 由呼叫端給，測試才驗得到「3 個 topic 才算 ERC-20」。 */
type StubLog = { block: bigint; address: Address; topics: Hex[] };

type StubChain = {
  head: bigint;
  /** `${token}:${account}` → balanceOf。缺席 = 0。 */
  balances: Map<string, bigint>;
  /** token → decimals；缺席 = 讀不到（模擬非 ERC-20）。 */
  decimals: Map<string, number>;
  /** address → 第一個有 bytecode 的塊；缺席 = 永遠沒有 code。 */
  codeFrom: Map<string, bigint>;
  /** address → getCode 會拋錯的塊（模擬 403 archive）。 */
  codeFails: Set<string>;
  logs: StubLog[];
  /** 落在這些範圍的 getLogs 會拋錯（模擬 403／逾時）。 */
  failingRanges: { fromBlock: bigint; toBlock: bigint }[];
  /** 實際發出去的 getLogs 範圍，用來驗分塊。 */
  calls: { fromBlock: bigint; toBlock: bigint }[];
  /** 每一次 balanceOf 讀了哪顆代幣——「候選有沒有被重讀」的直接證據。 */
  balanceReads: string[];
};

function stubChain(overrides: Partial<StubChain> = {}): StubChain {
  return {
    head: 10_000n,
    balances: new Map(),
    decimals: new Map(),
    codeFrom: new Map(),
    codeFails: new Set(),
    logs: [],
    failingRanges: [],
    calls: [],
    balanceReads: [],
    ...overrides,
  };
}

/** 把 stub 包成 viem 的 PublicClient：只實作 holdings-scan 真的會用的四個方法。 */
function stubClient(chain: StubChain): PublicClient {
  const client = {
    async getBlockNumber() {
      return chain.head;
    },
    async getCode(args: { address: Address; blockNumber?: bigint }) {
      const key = `${args.address.toLowerCase()}:${args.blockNumber ?? chain.head}`;
      if (chain.codeFails.has(key)) throw new Error(`模擬 403 Archive requests（getCode @ ${args.blockNumber}）`);
      const from = chain.codeFrom.get(args.address.toLowerCase());
      if (from === undefined) return undefined;
      const at = args.blockNumber ?? chain.head;
      return at >= from ? ('0x60006000' as Hex) : undefined;
    },
    async readContract(args: { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) {
      const token = args.address.toLowerCase();
      const account = String(args.args?.[0] ?? '').toLowerCase();
      if (args.functionName === 'balanceOf') {
        chain.balanceReads.push(token);
        const value = chain.balances.get(`${token}:${account}`);
        if (value === undefined) throw new Error(`模擬 balanceOf revert（${token}）`);
        return value;
      }
      const decimals = chain.decimals.get(token);
      if (decimals === undefined) throw new Error(`模擬 decimals revert（${token}，不是 ERC-20）`);
      return decimals;
    },
    async request(args: { method: string; params?: unknown[] }) {
      assert.equal(args.method, 'eth_getLogs', 'stub 只預期 eth_getLogs；其他方法要明說');
      const filter = (args.params?.[0] ?? {}) as { topics?: unknown[]; fromBlock: string; toBlock: string };
      const fromBlock = BigInt(filter.fromBlock);
      const toBlock = BigInt(filter.toBlock);
      chain.calls.push({ fromBlock, toBlock });
      // topics 的形狀就是「只看轉入」的證據：第 0 個釘死 Transfer sig，第 2 個釘死帳戶，第 1 個是 null。
      assert.deepEqual(filter.topics?.[0], TRANSFER_TOPIC);
      assert.equal(filter.topics?.[1], null, 'topics[1]（from）必須是 null：誰轉的都要看');
      assert.equal(filter.topics?.[2], addressTopic(ACCOUNT), 'topics[2]（to）必須是帳戶：只看轉入');
      for (const range of chain.failingRanges) {
        if (fromBlock <= range.toBlock && toBlock >= range.fromBlock) {
          throw new Error(`模擬 403 Archive requests（getLogs [${fromBlock}, ${toBlock}]）`);
        }
      }
      return chain.logs
        .filter((log) => log.block >= fromBlock && log.block <= toBlock)
        .map((log) => ({ address: log.address, topics: log.topics, blockNumber: `0x${log.block.toString(16)}` }));
    },
  };
  return client as unknown as PublicClient;
}

function transferLog(block: bigint, token: Address, to: Address): StubLog {
  return { block, address: token, topics: [TRANSFER_TOPIC, addressTopic(OTHER), addressTopic(to)] };
}

// ---------------------------------------------------------------------------
// 1. 只看轉入
// ---------------------------------------------------------------------------

test('scanIncomingTransfers：topics[2] 釘死帳戶、topics[1] 是 null，ERC-721 形狀的轉入不算候選', async () => {
  const erc721 = transferLog(102n, NFT, ACCOUNT); // 同一組 topics 也會命中 ERC-721：第 4 個 topic 是 tokenId
  erc721.topics = [...erc721.topics, `0x${'00'.repeat(31)}01` as Hex];
  const chain = stubChain({ logs: [transferLog(101n, CAKE, ACCOUNT), erc721] });

  // 只看轉入不是程式碼自己再篩一次，而是**查詢條件**就是這樣：stub 在收到 getLogs 時驗這三格。
  const result = await scanIncomingTransfers(stubClient(chain), { account: ACCOUNT, fromBlock: 100n, toBlock: 110n });

  assert.equal(result.failure, null);
  assert.deepEqual(result.tokens, [CAKE], `只該收到 ${CAKE}`);
  assert.equal(result.logCount, 1);
  assert.equal(result.ignoredLogCount, 1, '4 個 topic 的轉入要被計數但排除（拿 ERC-20 ABI 解它會拋錯）');
});

// ---------------------------------------------------------------------------
// 2. 分塊 + 失敗的那一段不算
// ---------------------------------------------------------------------------

test('scanIncomingTransfers：區間按 chunkSize 切塊，每塊都發一次 getLogs', async () => {
  const chain = stubChain();
  const result = await scanIncomingTransfers(stubClient(chain), { account: ACCOUNT, fromBlock: 100n, toBlock: 5_100n, chunkSize: 2_000n });
  assert.equal(result.failure, null);
  assert.deepEqual(chain.calls, [
    { fromBlock: 100n, toBlock: 2_099n },
    { fromBlock: 2_100n, toBlock: 4_099n },
    { fromBlock: 4_100n, toBlock: 5_100n },
  ]);
  assert.deepEqual(result.coveredRange, { fromBlock: 100n, toBlock: 5_100n });
});

test('scanIncomingTransfers：中途 403 → 停在那一塊，回報失敗範圍，不假裝後面的塊掃過', async () => {
  const chain = stubChain({
    logs: [transferLog(150n, CAKE, ACCOUNT), transferLog(4_500n, NFT, ACCOUNT)],
    failingRanges: [{ fromBlock: 2_100n, toBlock: 4_099n }],
  });
  const result = await scanIncomingTransfers(stubClient(chain), { account: ACCOUNT, fromBlock: 100n, toBlock: 5_100n, chunkSize: 2_000n });
  assert.notEqual(result.failure, null);
  assert.match(String(result.failure), /2100/);
  assert.deepEqual(result.failedRange, { fromBlock: 2_100n, toBlock: 4_099n });
  assert.deepEqual(result.coveredRange, { fromBlock: 100n, toBlock: 2_099n }, '只有第一塊算數');
  assert.deepEqual(result.tokens, [CAKE], '失敗前看到的候選照樣回傳（它可能是真的持倉）');
  assert.equal(chain.calls.length, 2, '失敗就停，不要繼續往後掃');
});

test('scanIncomingTransfers：幾段一起發時，排在失敗那一段後面的段就算回來了也不算；喊停時回報還沒掃的那一段', async () => {
  const chain = stubChain({
    logs: [transferLog(150n, CAKE, ACCOUNT), transferLog(4_500n, KNOWN, ACCOUNT)],
    failingRanges: [{ fromBlock: 2_100n, toBlock: 4_099n }],
  });
  const failed = await scanIncomingTransfers(stubClient(chain), { account: ACCOUNT, fromBlock: 100n, toBlock: 9_000n, chunkSize: 2_000n, concurrency: 3 });
  assert.deepEqual(failed.coveredRange, { fromBlock: 100n, toBlock: 2_099n });
  assert.deepEqual(failed.failedRange, { fromBlock: 2_100n, toBlock: 4_099n });
  assert.deepEqual(failed.tokens, [CAKE], '洞後面那一段（4100–6099）看到的東西不算掃過：下一輪從洞重掃時才算');
  assert.equal(failed.remainingRange, null);
  assert.equal(chain.calls.length, 3, '同一組的三段發出去了，下一組沒有');

  // 喊停：第一組一定做；之後每一組開始前問一次。
  chain.failingRanges = []; chain.calls = [];
  let asked = 0;
  const stopped = await scanIncomingTransfers(stubClient(chain), { account: ACCOUNT, fromBlock: 100n, toBlock: 9_000n, chunkSize: 2_000n, concurrency: 2, shouldStop: () => ++asked >= 2 });
  assert.equal(stopped.failure, null);
  assert.deepEqual(stopped.coveredRange, { fromBlock: 100n, toBlock: 8_099n });
  assert.deepEqual(stopped.remainingRange, { fromBlock: 8_100n, toBlock: 9_000n });
  assert.deepEqual(chain.calls.map((call) => call.fromBlock), [100n, 2_100n, 4_100n, 6_100n]);
  const first = await scanIncomingTransfers(stubClient(chain), { account: ACCOUNT, fromBlock: 100n, toBlock: 9_000n, chunkSize: 2_000n, concurrency: 2, shouldStop: () => true });
  assert.deepEqual(first.coveredRange, { fromBlock: 100n, toBlock: 4_099n }, '一開始就喊停：仍然做第一組');
});

// ---------------------------------------------------------------------------
// 3. 部署塊
// ---------------------------------------------------------------------------

test('findDeploymentBlock：getCode 由無到有的那一個塊（二分搜尋）', async () => {
  const chain = stubChain({ head: 10_000n, codeFrom: new Map([[ACCOUNT.toLowerCase(), 7_777n]]) });
  const result = await findDeploymentBlock(stubClient(chain), { account: ACCOUNT, head: 10_000n });
  assert.equal(result.reason, 'resolved');
  assert.equal(result.block, 7_777n);
});

test('findDeploymentBlock：三種取不到都不猜（no_code_at_head / deployed_before_search_from / rpc_cannot_answer）', async () => {
  const noCode = await findDeploymentBlock(stubClient(stubChain({ head: 10_000n })), { account: ACCOUNT, head: 10_000n });
  assert.deepEqual([noCode.block, noCode.reason], [null, 'no_code_at_head']);

  // 在搜尋下界就已經有 code：部署塊在更早、讀不到的地方
  const tooEarly = await findDeploymentBlock(
    stubClient(stubChain({ head: 10_000n, codeFrom: new Map([[ACCOUNT.toLowerCase(), 100n]]) })),
    { account: ACCOUNT, head: 10_000n, searchFromBlock: 1_000n },
  );
  assert.deepEqual([tooEarly.block, tooEarly.reason], [null, 'deployed_before_search_from']);

  // 二分中途 403：回 null，不回一個「大概的低界」（把部署塊報高會偽造宇宙完整性）
  const fails = stubChain({ head: 10_000n, codeFrom: new Map([[ACCOUNT.toLowerCase(), 7_777n]]) });
  const firstProbe = ((10_000n + 0n) / 2n).toString();
  fails.codeFails.add(`${ACCOUNT.toLowerCase()}:${firstProbe}`);
  const broken = await findDeploymentBlock(stubClient(fails), { account: ACCOUNT, head: 10_000n });
  assert.deepEqual([broken.block, broken.reason], [null, 'rpc_cannot_answer']);
});

// ---------------------------------------------------------------------------
// 4. 一輪掃描（不碰 DB：query 用 fake）
// ---------------------------------------------------------------------------

/**
 * 游標表與候選表（0010）的最小 fake。
 *
 * 兩張表都要有記憶體版本，因為這裡要驗的正是「跨輪次的記憶」：`writes` 只收游標寫入（失敗時必須
 * 一次都沒有），`candidateWrites` 收候選寫入（`insert` / `update` 分開記）。
 */
type FakeCandidate = { firstSeenBlock: bigint; lastBalanceWei: bigint };

function fakeQuery(
  rows: { start_block: string; last_scanned_block: string }[] = [],
  seed: Map<string, FakeCandidate> = new Map(),
): {
  query: QueryFn;
  writes: unknown[][];
  candidateWrites: { kind: 'insert' | 'update'; assets: string[]; values: bigint[] }[];
  candidates: Map<string, FakeCandidate>;
} {
  const writes: unknown[][] = [];
  const candidateWrites: { kind: 'insert' | 'update'; assets: string[]; values: bigint[] }[] = [];
  const candidates = seed;
  const state = [...rows];
  const q: QueryFn = async (text, params = []) => {
    if (text.includes('insert into portfolio_holding_candidates')) {
      const assets = (params[1] as string[]).map((asset) => asset.toLowerCase());
      const blocks = (params[2] as string[]).map((block) => BigInt(block));
      candidateWrites.push({ kind: 'insert', assets, values: blocks });
      assets.forEach((asset, index) => {
        // on conflict do nothing：first_seen_block 只記第一次
        if (!candidates.has(asset)) candidates.set(asset, { firstSeenBlock: blocks[index]!, lastBalanceWei: 0n });
      });
      return { rows: [] };
    }
    if (text.includes('update portfolio_holding_candidates')) {
      const assets = (params[1] as string[]).map((asset) => asset.toLowerCase());
      const balances = (params[2] as string[]).map((balance) => BigInt(balance));
      candidateWrites.push({ kind: 'update', assets, values: balances });
      assets.forEach((asset, index) => {
        const row = candidates.get(asset);
        if (row !== undefined) row.lastBalanceWei = balances[index]!;
      });
      return { rows: [] };
    }
    if (text.includes('from portfolio_holding_candidates')) {
      return {
        rows: [...candidates.entries()]
          .sort(([left], [right]) => (left < right ? -1 : 1))
          .map(([asset, row]) => ({
            asset,
            // pg 對 bigint / numeric 一律回字串，stub 照抄那個形狀。
            first_seen_block: row.firstSeenBlock.toString(),
            last_balance_wei: row.lastBalanceWei.toString(),
          })),
      };
    }
    if (text.includes('from portfolio_scan_cursors')) {
      return { rows: state.length === 0 ? [] : [{ portfolio_id: 5, ...state[0] }] };
    }
    if (text.includes('insert into portfolio_scan_cursors')) {
      writes.push([...params]);
      if (state.length === 0) state.push({ start_block: String(params[1]), last_scanned_block: String(params[2]) });
      else state[0] = { start_block: state[0]!.start_block, last_scanned_block: String(params[2]) };
      return { rows: [] };
    }
    throw new Error(`fakeQuery 沒預期這條 SQL：${text.slice(0, 60)}`);
  };
  return { query: q, writes, candidateWrites, candidates };
}

test('scanPortfolioHoldings：策略外代幣有餘額 → 進 unknownHoldings（只記錄，不產生任何 blocker）', async () => {
  const chain = stubChain({
    head: 10_000n,
    codeFrom: new Map([[ACCOUNT.toLowerCase(), 100n]]),
    logs: [transferLog(9_500n, CAKE, ACCOUNT)],
    balances: new Map([[`${CAKE}:${ACCOUNT.toLowerCase()}`, 10n ** 18n]]),
    decimals: new Map([[CAKE, 18]]),
  });
  const { query: q, writes } = fakeQuery([{ start_block: '100', last_scanned_block: '9400' }]);
  const result = await scanPortfolioHoldings({ client: stubClient(chain), query: q, portfolioId: 5, account: ACCOUNT, knownTokens: [KNOWN], head: 10_000n });

  assert.deepEqual(result.unknownHoldings, [{ asset: CAKE, amountWei: 10n ** 18n, decimals: 18 }]);
  assert.deepEqual(result.scannedRange, { fromBlock: 9_401n, toBlock: 10_000n });
  assert.equal(result.universeComplete, true, '游標 100 <= 部署塊 100，而且這一輪掃完沒失敗');
  // 策略外持倉只是觀測：它出現在給人看的摘要裡（表頭 unknown_token_count 的值就是它的個數），
  // 而不是變成 blocker。執行器換不掉它（AtpExecutor.sol:180-182），擋漂移只會讓投組停止再平衡。
  assert.match(formatScanStatus(result).join('\n'), /宇宙外的持倉：0x0e09fabb/);
  assert.equal(result.unknownHoldings.length, 1, '表頭 unknown_token_count 的來源');
  assert.equal(writes.length, 1, '掃描成功才寫游標');
  assert.equal(writes[0]?.[2], '10000', '游標推進到 head');
});

test('scanPortfolioHoldings：餘額 0 的候選不算持倉（歷史進來又出去），不進 unknown_token_count', async () => {
  const chain = stubChain({
    head: 10_000n,
    codeFrom: new Map([[ACCOUNT.toLowerCase(), 100n]]),
    logs: [transferLog(9_500n, CAKE, ACCOUNT)],
    balances: new Map([[`${CAKE}:${ACCOUNT.toLowerCase()}`, 0n]]),
  });
  const { query: q } = fakeQuery([{ start_block: '100', last_scanned_block: '9400' }]);
  const result = await scanPortfolioHoldings({ client: stubClient(chain), query: q, portfolioId: 5, account: ACCOUNT, knownTokens: [KNOWN], head: 10_000n });
  assert.deepEqual(result.unknownHoldings, []);
  assert.equal(result.zeroBalanceCount, 1);
  assert.doesNotMatch(formatScanStatus(result).join('\n'), /宇宙外的持倉/);
});

test('scanPortfolioHoldings：候選在已知宇宙裡 → 不進 unknownHoldings', async () => {
  const chain = stubChain({
    head: 10_000n,
    codeFrom: new Map([[ACCOUNT.toLowerCase(), 100n]]),
    logs: [transferLog(9_500n, KNOWN, ACCOUNT)],
    balances: new Map([[`${KNOWN}:${ACCOUNT.toLowerCase()}`, 5n]]),
  });
  const { query: q } = fakeQuery([{ start_block: '100', last_scanned_block: '9400' }]);
  const result = await scanPortfolioHoldings({ client: stubClient(chain), query: q, portfolioId: 5, account: ACCOUNT, knownTokens: [KNOWN], head: 10_000n });
  assert.deepEqual(result.unknownHoldings, []);
  assert.equal(result.candidateCount, 0);
});

test('scanPortfolioHoldings：游標起點晚於部署塊 → universeComplete false，但不算「知道有問題」', async () => {
  const chain = stubChain({ head: 10_000n, codeFrom: new Map([[ACCOUNT.toLowerCase(), 100n]]) });
  const { query: q } = fakeQuery([{ start_block: '101', last_scanned_block: '10000' }]);
  const result = await scanPortfolioHoldings({ client: stubClient(chain), query: q, portfolioId: 5, account: ACCOUNT, knownTokens: [], head: 10_000n });
  assert.equal(result.deployment.block, 100n);
  assert.equal(result.universeComplete, false);
  assert.match(result.incompleteReasons.join(' '), /晚於部署塊/);
  assert.deepEqual(result.unknownHoldings, [], '完整性未確認 ≠ 觀察到策略外持倉');
});

test('scanPortfolioHoldings：已有游標時只問 2 次 getCode（head 與游標起點前一塊），不再每輪二分搜尋；結論不變', async () => {
  const chain = stubChain({ head: 10_000n, codeFrom: new Map([[ACCOUNT.toLowerCase(), 100n]]) });
  let getCode = 0;
  const client = stubClient(chain);
  const counted = Object.assign(Object.create(client), { getCode: async (args: { address: Address; blockNumber?: bigint }) => { getCode += 1; return client.getCode(args); } }) as PublicClient;
  const { query: q } = fakeQuery([{ start_block: '100', last_scanned_block: '10000' }]);
  const result = await scanPortfolioHoldings({ client: counted, query: q, portfolioId: 5, account: ACCOUNT, knownTokens: [], head: 10_000n });
  assert.equal(getCode, 2);
  assert.equal(result.deployment.reason, 'not_before_cursor');
  assert.equal(result.universeComplete, true);
  // 游標起點晚於部署塊（code 在起點前就存在）→ 退回完整二分搜尋，報出確切的部署塊。
  getCode = 0;
  const late = fakeQuery([{ start_block: '101', last_scanned_block: '10000' }]);
  const lateResult = await scanPortfolioHoldings({ client: counted, query: late.query, portfolioId: 5, account: ACCOUNT, knownTokens: [], head: 10_000n });
  assert.ok(getCode > 2);
  assert.equal(lateResult.deployment.block, 100n);
  assert.equal(lateResult.universeComplete, false);
});

test('scanPortfolioHoldings：部署塊取不到 → universeComplete false', async () => {
  const chain = stubChain({ head: 10_000n });
  const { query: q } = fakeQuery([{ start_block: '100', last_scanned_block: '10000' }]);
  const result = await scanPortfolioHoldings({ client: stubClient(chain), query: q, portfolioId: 5, account: ACCOUNT, knownTokens: [], head: 10_000n });
  assert.equal(result.deployment.block, null);
  assert.equal(result.universeComplete, false);
  assert.equal(result.scannedRange, null, '游標已在 head，沒有新區塊可掃');
});

test('scanPortfolioHoldings：這一輪第一段 getLogs 就失敗 → universeComplete false 且游標一格都不動', async () => {
  const chain = stubChain({ head: 10_000n, codeFrom: new Map([[ACCOUNT.toLowerCase(), 100n]]), failingRanges: [{ fromBlock: 9_401n, toBlock: 9_500n }] });
  const { query: q, writes } = fakeQuery([{ start_block: '100', last_scanned_block: '9400' }]);
  const result = await scanPortfolioHoldings({ client: stubClient(chain), query: q, portfolioId: 5, account: ACCOUNT, knownTokens: [], head: 10_000n });
  assert.equal(result.universeComplete, false);
  assert.equal(writes.length, 0, '第一段就失敗：沒有任何連續掃成功的區段，游標不寫');
  assert.equal(result.cursor.lastScannedBlock, 9_400n);
  assert.match(formatScanStatus(result).join('\n'), /宇宙完整性\s+⚠ 未確認/);
});

test('holdings_scan log：掃描回報游標、缺口、掃到哪、為什麼停；平常的一輪不出聲；失敗原因遮掉網址', async () => {
  // 游標落後 5,000 塊（3 段），第 2 段失敗。
  const chain = stubChain({ head: 10_000n, codeFrom: new Map([[ACCOUNT.toLowerCase(), 100n]]), failingRanges: [{ fromBlock: 7_500n, toBlock: 7_600n }] });
  const { query: q } = fakeQuery([{ start_block: '100', last_scanned_block: '5000' }]);
  let stats: ScanStats | null = null;
  const result = await scanPortfolioHoldings({ client: stubClient(chain), query: q, portfolioId: 7, account: ACCOUNT, knownTokens: [], head: 10_000n,
    onScan: (reported) => { stats = reported; } });
  assert.ok(stats !== null);
  const reported = stats as ScanStats;
  assert.deepEqual({ ...reported, scanMs: 0 }, { cursorBefore: 5_000n, head: 10_000n, chunkSize: 2_000n, asked: { fromBlock: 5_001n, toBlock: 10_000n },
    coveredTo: 7_000n, failedRange: { fromBlock: 7_001n, toBlock: 9_000n }, failure: 'getLogs [7001, 9000] 失敗：模擬 403 Archive requests（getLogs [7001, 9000]）',
    remainingRange: null, scanMs: 0 });
  assert.equal(result.cursor.lastScannedBlock, 7_000n, '失敗那一段之前連續掃成功的部分算數');
  const entry = formatScanLog({ portfolioId: 7, personalMix: true, stats: reported, cursorAfter: result.cursor.lastScannedBlock, ms: 30_565,
    flowSyncs: [{ via: 'catchup', fromBlock: 5_001n, toBlock: 10_000n, ms: 12_000.4, failure: null }] });
  assert.equal(entry?.level, 'warn');
  assert.deepEqual(JSON.parse(entry?.line ?? ''), { msg: 'holdings_scan', portfolio: 7, mix: true, ms: 30_565, head: '10000', cursor: '5000', cursorAfter: '7000',
    gapBlocks: '5000', chunks: 3, chunksOk: 1, scanMs: reported.scanMs, failedRange: ['7001', '9000'], failure: reported.failure, remaining: null,
    flowSyncs: [{ via: 'catchup', from: '5001', to: '10000', ms: 12_000, failure: null }] });

  // 平常的一輪（兩段以內、沒失敗、不慢）不寫 log；慢、缺口超過兩段、或現金流同步失敗才寫。
  const quiet: ScanStats = { cursorBefore: 9_000n, head: 10_000n, chunkSize: 2_000n, asked: { fromBlock: 9_001n, toBlock: 10_000n }, coveredTo: 10_000n, failedRange: null, failure: null, remainingRange: null, scanMs: 40 };
  assert.equal(formatScanLog({ portfolioId: 7, personalMix: true, stats: quiet, cursorAfter: 10_000n, flowSyncs: [], ms: 300 }), null);
  assert.equal(formatScanLog({ portfolioId: 7, personalMix: false, stats: { ...quiet, asked: null, coveredTo: null }, cursorAfter: 10_000n, flowSyncs: [], ms: 300 }), null);
  assert.equal(formatScanLog({ portfolioId: 7, personalMix: true, stats: quiet, cursorAfter: 10_000n, flowSyncs: [], ms: 9_000 }), null, '整段觀測慢（讀餘額、報價）不是掃描慢');
  assert.equal(formatScanLog({ portfolioId: 7, personalMix: true, stats: { ...quiet, scanMs: 1_200 }, cursorAfter: 10_000n, ms: 2_100,
    flowSyncs: [{ via: 'advance', fromBlock: 9_001n, toBlock: 10_000n, ms: 800, failure: null }] })?.level, 'info', '掃描＋入出金同步合計 2 秒以上');
  assert.equal(formatScanLog({ portfolioId: 7, personalMix: true, stats: { ...quiet, cursorBefore: 6_000n, asked: { fromBlock: 6_001n, toBlock: 10_000n } }, cursorAfter: 10_000n, flowSyncs: [], ms: 300 }), null, '兩段以內是平常的一輪（15 分鐘約 2,000 多塊）');
  assert.equal(formatScanLog({ portfolioId: 7, personalMix: true, stats: { ...quiet, cursorBefore: 5_999n, asked: { fromBlock: 6_000n, toBlock: 10_000n } }, cursorAfter: 10_000n, flowSyncs: [], ms: 300 })?.level, 'info');
  const syncFailed = formatScanLog({ portfolioId: 7, personalMix: true, stats: null, cursorAfter: null, ms: 300,
    flowSyncs: [{ via: 'advance', fromBlock: 9_001n, toBlock: 10_000n, ms: 250, failure: 'HttpRequestError: HTTP request failed. | URL: <url>' }] });
  assert.equal(syncFailed?.level, 'warn');
  assert.equal((JSON.parse(syncFailed?.line ?? '') as { scan: string }).scan, 'not reported');

  // RPC 的錯誤訊息會帶網址（可能含 key）：進 log 前遮掉、壓成一行、截短。
  const leaking = stubClient(stubChain({ head: 10_000n, codeFrom: new Map([[ACCOUNT.toLowerCase(), 100n]]) }));
  (leaking as unknown as { request: unknown }).request = async () => { throw new Error(`HTTP request failed.\nURL: https://rpc.invalid/v1/secret-key-value\n${'x'.repeat(900)}`); };
  let leaked: ScanStats | null = null;
  await scanPortfolioHoldings({ client: leaking, query: fakeQuery([{ start_block: '100', last_scanned_block: '9400' }]).query, portfolioId: 7, account: ACCOUNT, knownTokens: [],
    head: 10_000n, onScan: (reported) => { leaked = reported; } });
  const failure = (leaked as ScanStats | null)?.failure ?? '';
  assert.match(failure, /^getLogs \[9401, 10000\] 失敗：HTTP request failed\. URL: <url> x+$/);
  assert.ok(!failure.includes('secret-key-value') && failure.length <= 300);
});

// ---------------------------------------------------------------------------
// 2b. 游標只越過確實完整掃過的連續區段：部分進度保留、每輪有上限、下一輪接續、結果與一次掃完相同
// ---------------------------------------------------------------------------

/** 一輪掃描 + 它對外做的事（游標寫入、`beforeAdvance` 的範圍、發出去的 getLogs 範圍），chunk 用 10 塊讓測試小。 */
async function round(chain: StubChain, db: ReturnType<typeof fakeQuery>, options: { budget?: { maxMs?: number; maxChunks?: number; now?: () => number };
  beforeAdvance?: (range: { fromBlock: bigint; toBlock: bigint }) => Promise<void>; known?: Address[] } = {}) {
  const advanced: { fromBlock: bigint; toBlock: bigint }[] = [];
  const events: string[] = [];
  const q: QueryFn = async (text, params) => {
    if (text.includes('insert into portfolio_scan_cursors')) events.push(`cursor:${String(params?.[2])}`);
    if (text.includes('insert into portfolio_holding_candidates')) events.push('candidates');
    return db.query(text, params);
  };
  const before = chain.calls.length;
  let stats: ScanStats | null = null;
  const run = scanPortfolioHoldings({ client: stubClient(chain), query: q, portfolioId: 5, account: ACCOUNT, knownTokens: options.known ?? [KNOWN], head: chain.head, chunkSize: 10n,
    ...(options.budget === undefined ? {} : { budget: options.budget }), onScan: (reported) => { stats = reported; },
    beforeAdvance: async (range) => { events.push(`advance:${range.fromBlock}-${range.toBlock}`); await options.beforeAdvance?.(range); advanced.push(range); } });
  let result: Awaited<typeof run> | null = null, error: unknown = null;
  try { result = await run; } catch (cause) { error = cause; }
  return { result, error, advanced, events, calls: chain.calls.slice(before), stats: stats as ScanStats | null };
}
const cursorOf = (db: ReturnType<typeof fakeQuery>): string | undefined => db.writes.length === 0 ? undefined : String(db.writes[db.writes.length - 1]?.[2]);
/** 每一塊恰好被哪幾次 getLogs 查到（塊 → 次數）：驗「沒有洞、沒有重掃」。 */
function coverage(calls: { fromBlock: bigint; toBlock: bigint }[], from: bigint, to: bigint): { missing: bigint[]; twice: bigint[] } {
  const missing: bigint[] = [], twice: bigint[] = [];
  for (let block = from; block <= to; block++) {
    const hits = calls.filter((call) => call.fromBlock <= block && block <= call.toBlock).length;
    if (hits === 0) missing.push(block); else if (hits > 1) twice.push(block);
  }
  return { missing, twice };
}
const TOKENS = ['0x00000000000000000000000000000000000000a1', '0x00000000000000000000000000000000000000a2', '0x00000000000000000000000000000000000000a3',
  '0x00000000000000000000000000000000000000a4', '0x00000000000000000000000000000000000000a5'] as Address[];
/** 1,000 塊的缺口（100 段），五顆宇宙外代幣散在裡面；a1 進來兩次（first_seen 只記第一次）。 */
const busyChain = (overrides: Partial<StubChain> = {}): StubChain => stubChain({ head: 2_000n, codeFrom: new Map([[ACCOUNT.toLowerCase(), 100n]]),
  logs: [transferLog(1_003n, TOKENS[0]!, ACCOUNT), transferLog(1_250n, TOKENS[1]!, ACCOUNT), transferLog(1_251n, KNOWN, ACCOUNT), transferLog(1_499n, TOKENS[2]!, ACCOUNT),
    transferLog(1_500n, TOKENS[3]!, ACCOUNT), transferLog(1_777n, TOKENS[0]!, ACCOUNT), transferLog(2_000n, TOKENS[4]!, ACCOUNT),
    { block: 1_600n, address: NFT, topics: [TRANSFER_TOPIC, addressTopic(OTHER), addressTopic(ACCOUNT), addressTopic(OTHER)] }], // ERC-721 形狀：不是候選
  balances: new Map(TOKENS.map((token) => [`${token}:${ACCOUNT.toLowerCase()}`, 1n])), decimals: new Map(TOKENS.map((token) => [token, 18])), ...overrides });
const candidatesOf = (db: ReturnType<typeof fakeQuery>) => [...db.candidates.entries()].map(([asset, row]) => `${asset}@${row.firstSeenBlock}`).sort();
const START = [{ start_block: '100', last_scanned_block: '1000' }];

test('上限的預設值：一批 25 段、一輪最多 150 段／4 秒、兩個查詢一起發', () => {
  assert.deepEqual([PROGRESS_BATCH_CHUNKS, SCAN_ROUND_MAX_CHUNKS, SCAN_ROUND_BUDGET_MS, SCAN_CONCURRENCY], [25, 150, 4_000, 2]);
});

test('部分進度保留：中途失敗時游標前進到失敗那一段之前（先落地候選、先做 beforeAdvance），失敗那段與之後的不算；下一輪從那裡接續、不重掃', async () => {
  // 第 31 段 [1301, 1310] 失敗。第 1 批（25 段，[1001, 1250]）完整；第 2 批掃到 [1251, 1300] 為止。
  const chain = busyChain({ failingRanges: [{ fromBlock: 1_305n, toBlock: 1_305n }] });
  const db = fakeQuery([...START]);
  const first = await round(chain, db);
  assert.equal(first.error, null);
  assert.deepEqual(first.advanced, [{ fromBlock: 1_001n, toBlock: 1_250n }, { fromBlock: 1_251n, toBlock: 1_300n }]);
  assert.equal(cursorOf(db), '1300');
  assert.equal(first.result?.cursor.lastScannedBlock, 1_300n);
  assert.deepEqual(first.result?.scannedRange, { fromBlock: 1_001n, toBlock: 1_300n });
  assert.equal(first.result?.universeComplete, false);
  assert.match(first.result?.incompleteReasons.join('；') ?? '', /getLogs \[1301, 1310\] 失敗/);
  assert.deepEqual(first.stats?.failedRange, { fromBlock: 1_301n, toBlock: 1_310n });
  // 每一批的順序：候選落地 → beforeAdvance → 寫游標。游標永遠最後。
  assert.deepEqual(first.events, ['candidates', 'advance:1001-1250', 'cursor:1250', 'advance:1251-1300', 'cursor:1300']);
  assert.deepEqual(candidatesOf(db), [`${TOKENS[0]}@1003`, `${TOKENS[1]}@1250`], '失敗前看到的候選已經在表裡');
  // 失敗那一段之後、同一組一起發出去的那一段 [1311, 1320] 就算回來了也不算掃過。
  assert.ok(first.calls.every((call) => call.toBlock <= 1_320n), '失敗就停，不繼續往後掃');
  assert.deepEqual(coverage(first.calls, 1_001n, 1_300n), { missing: [], twice: [] });

  // 第二輪（節點恢復）：從 1301 接續到 head；兩輪合起來每一塊恰好算數一次，[1001, 1300] 沒有被重掃。
  chain.failingRanges = [];
  const second = await round(chain, db);
  assert.equal(second.calls[0]?.fromBlock, 1_301n);
  assert.ok(second.calls.every((call) => call.fromBlock >= 1_301n), '已經掃過的不重掃');
  assert.deepEqual(coverage(second.calls, 1_301n, 2_000n), { missing: [], twice: [] });
  assert.deepEqual([...first.advanced, ...second.advanced].map((range) => [range.fromBlock, range.toBlock]),
    [[1_001n, 1_250n], [1_251n, 1_300n], [1_301n, 1_550n], [1_551n, 1_800n], [1_801n, 2_000n]]);
  assert.equal(cursorOf(db), '2000');
  assert.equal(second.result?.universeComplete, true);
});

test('一輪有段數上限：到了就停、剩下的下一輪接著掃；每一輪都前進、沒有一塊被掃兩次或漏掉', async () => {
  const chain = busyChain();
  const db = fakeQuery([...START]);
  const cursors: (string | undefined)[] = [];
  const all: { fromBlock: bigint; toBlock: bigint }[] = [];
  for (let n = 0; n < 4; n++) {
    const done = await round(chain, db, { budget: { maxChunks: 30 } });
    assert.equal(done.error, null);
    all.push(...done.calls); cursors.push(cursorOf(db));
    assert.ok(done.calls.length <= 30, `一輪最多 30 段（第 ${n + 1} 輪 ${done.calls.length} 段）`);
    if (n < 3) {
      assert.equal(done.result?.universeComplete, false, '還沒掃到 head 的那一輪不可以說宇宙完整');
      assert.match(done.result?.incompleteReasons.join('；') ?? '', /下一輪接著掃/);
      assert.deepEqual(done.stats?.remainingRange, { fromBlock: BigInt(cursors[n]!) + 1n, toBlock: 2_000n });
      assert.equal(done.stats?.failure, null);
    } else assert.equal(done.result?.universeComplete, true);
  }
  assert.deepEqual(cursors, ['1300', '1600', '1900', '2000']);
  assert.deepEqual(coverage(all, 1_001n, 2_000n), { missing: [], twice: [] });
  // 已追上 head 之後的一輪：一段都不掃。
  const idle = await round(chain, db, { budget: { maxChunks: 30 } });
  assert.deepEqual(idle.calls, []); assert.equal(idle.result?.scannedRange, null);
});

test('一輪有時間上限：時間到就停在已掃完的地方（至少前進一組查詢），下一輪接續', async () => {
  const chain = busyChain();
  const db = fakeQuery([...START]);
  // 假時鐘：每問一次時間就過 100 毫秒；上限 1,000 毫秒。
  let clock = 0;
  const first = await round(chain, db, { budget: { maxMs: 1_000, now: () => (clock += 100) } });
  assert.equal(first.error, null);
  const reached = BigInt(cursorOf(db) ?? '0');
  assert.ok(reached > 1_000n && reached < 2_000n, `時間到時停在中間（${reached}）`);
  assert.equal(first.result?.cursor.lastScannedBlock, reached);
  assert.deepEqual(first.stats?.remainingRange, { fromBlock: reached + 1n, toBlock: 2_000n });
  assert.deepEqual(coverage(first.calls, 1_001n, reached), { missing: [], twice: [] });
  assert.ok(first.calls.every((call) => call.toBlock <= reached), '時間到之後不再發查詢');
  // 時間一開始就用完：仍然前進一組（兩段），不會一輪都不動。
  const starved = await round(chain, db, { budget: { maxMs: 0 } });
  assert.equal(starved.calls.length, SCAN_CONCURRENCY);
  assert.equal(cursorOf(db), (reached + 20n).toString());
  // 不設上限地跑完剩下的。
  const rest = await round(chain, db);
  assert.equal(cursorOf(db), '2000'); assert.equal(rest.result?.universeComplete, true);
  assert.deepEqual(coverage([...first.calls, ...starved.calls, ...rest.calls], 1_001n, 2_000n), { missing: [], twice: [] });
});

test('beforeAdvance（入出金同步）失敗：游標停在上一批的終點、錯誤往外拋；下一輪從那裡重做那一批，前一批不重來', async () => {
  const chain = busyChain();
  const db = fakeQuery([...START]);
  let fail = true;
  const failing = async (range: { fromBlock: bigint; toBlock: bigint }) => { if (fail && range.fromBlock === 1_251n) throw new Error('fixture: flow sync unavailable'); };
  const first = await round(chain, db, { beforeAdvance: failing });
  assert.match(String(first.error), /flow sync unavailable/);
  assert.deepEqual(first.advanced, [{ fromBlock: 1_001n, toBlock: 1_250n }]);
  assert.equal(cursorOf(db), '1250', '游標絕不越過入出金還沒同步的區段');
  assert.equal(first.stats?.coveredTo, 1_250n, '拋錯的那一輪也回報掃到哪');
  assert.deepEqual(candidatesOf(db), [`${TOKENS[0]}@1003`, `${TOKENS[1]}@1250`, `${TOKENS[2]}@1499`, `${TOKENS[3]}@1500`], '第二批看到的候選已落地（多記無害，少記才有害）');
  fail = false;
  const second = await round(chain, db, { beforeAdvance: failing });
  assert.equal(second.error, null);
  assert.equal(second.calls[0]?.fromBlock, 1_251n);
  assert.deepEqual(second.advanced.map((range) => [range.fromBlock, range.toBlock]), [[1_251n, 1_500n], [1_501n, 1_750n], [1_751n, 2_000n]]);
  assert.equal(cursorOf(db), '2000');
});

test('完整性：分很多輪、中間失敗過、有上限地掃完，跟一次掃完的結果逐筆相同（候選、第一次出現的塊、餘額、beforeAdvance 涵蓋的區間）', async () => {
  const oneShot = { chain: busyChain(), db: fakeQuery([...START]) };
  const whole = await round(oneShot.chain, oneShot.db, { budget: { maxChunks: 10_000, maxMs: 3_600_000 } });
  assert.equal(whole.error, null); assert.equal(cursorOf(oneShot.db), '2000');
  assert.deepEqual(candidatesOf(oneShot.db), [`${TOKENS[0]}@1003`, `${TOKENS[1]}@1250`, `${TOKENS[2]}@1499`, `${TOKENS[3]}@1500`, `${TOKENS[4]}@2000`]);

  // 同一條鏈：每輪上限 7 段，而且第 3、6、9 輪各有一段失敗（每次不同位置），直到掃完。
  const chain = busyChain(), db = fakeQuery([...START]);
  const advanced: { fromBlock: bigint; toBlock: bigint }[] = [];
  let last: Awaited<ReturnType<typeof round>> | null = null;
  for (let n = 1; n <= 60 && cursorOf(db) !== '2000'; n++) {
    const at = BigInt(cursorOf(db) ?? '1000');
    chain.failingRanges = n % 3 === 0 ? [{ fromBlock: at + 25n, toBlock: at + 25n }] : [];
    const before = cursorOf(db);
    last = await round(chain, db, { budget: { maxChunks: 7 } });
    assert.equal(last.error, null);
    advanced.push(...last.advanced);
    assert.notEqual(cursorOf(db), before, `第 ${n} 輪有前進`);
  }
  assert.equal(cursorOf(db), '2000');
  assert.deepEqual(candidatesOf(db), candidatesOf(oneShot.db), '候選與 first_seen_block 逐筆相同');
  assert.deepEqual(last?.result?.unknownHoldings, whole.result?.unknownHoldings);
  assert.equal(last?.result?.universeComplete, true);
  // beforeAdvance 的區間首尾相接、剛好蓋滿 [1001, 2000]：沒有一塊的入出金沒同步，也沒有一塊同步兩次。
  let next = 1_001n;
  for (const range of advanced) { assert.equal(range.fromBlock, next); assert.ok(range.toBlock >= range.fromBlock); next = range.toBlock + 1n; }
  assert.equal(next, 2_001n);
});

test('scanPortfolioHoldings：新游標從部署塊開始（知道部署塊才有機會讓 universeComplete 為 true）', async () => {
  const chain = stubChain({ head: 10_000n, codeFrom: new Map([[ACCOUNT.toLowerCase(), 9_900n]]) });
  const { query: q, writes } = fakeQuery([]);
  const result = await scanPortfolioHoldings({ client: stubClient(chain), query: q, portfolioId: 5, account: ACCOUNT, knownTokens: [], head: 10_000n });
  assert.deepEqual(result.cursor, { portfolioId: 5, startBlock: 9_900n, lastScannedBlock: 10_000n });
  assert.equal(result.universeComplete, true);
  assert.deepEqual(chain.calls, [{ fromBlock: 9_900n, toBlock: 10_000n }], '只掃部署塊之後');
  assert.deepEqual(writes[0]?.slice(1), ['9900', '10000']);
});

test('DEFAULT_CHUNK_SIZE：小的失敗重做量，但不是荒謬的小', () => {
  assert.equal(DEFAULT_CHUNK_SIZE, 2_000n);
});

// ---------------------------------------------------------------------------
// 4b. 候選表（0010）：看過就永遠繼續看
//
// 這一段釘住 0009 留下來的那個缺口：偵測原本只對「這一輪日誌看到的候選」讀 balanceOf，
// 游標一推進，第 N 輪發現的策略外持倉就在第 N+1 輪憑空消失（表頭 unknown_token_count 變回 0）。
// ---------------------------------------------------------------------------

test('第 N 輪發現的候選，第 N+1 輪即使沒有新日誌仍被重讀（0010 的核心）', async () => {
  const chain = stubChain({
    head: 10_000n,
    codeFrom: new Map([[ACCOUNT.toLowerCase(), 100n]]),
    logs: [transferLog(9_500n, CAKE, ACCOUNT)],
    balances: new Map([[`${CAKE}:${ACCOUNT.toLowerCase()}`, 10n ** 18n]]),
    decimals: new Map([[CAKE, 18]]),
  });
  const fake = fakeQuery([{ start_block: '100', last_scanned_block: '9400' }]);
  const deps = { client: stubClient(chain), query: fake.query, portfolioId: 5, account: ACCOUNT, knownTokens: [KNOWN] };

  // 第 N 輪：CAKE 在 9500 轉入 → 游標掃到它 → 記錄為策略外持倉。
  const round1 = await scanPortfolioHoldings({ ...deps, head: 10_000n });
  assert.deepEqual(round1.unknownHoldings.map((holding) => holding.asset), [CAKE]);
  assert.equal(round1.cursor.lastScannedBlock, 10_000n, '第一輪成功，游標推進到 head');
  assert.equal(fake.candidates.has(CAKE), true, '發現的候選要落地');

  // 第 N+1 輪：視窗 [10001, 10000] 是空的——這一輪**沒有新日誌**。0009 的實作在這裡會回
  // unknown_token_count = 0，於是那顆空投在觀測記錄裡憑空消失。
  const logCallsBefore = chain.calls.length;
  const balanceReadsBefore = chain.balanceReads.length;
  const round2 = await scanPortfolioHoldings({ ...deps, head: 10_000n });
  assert.deepEqual(round2.scannedRange, null, '這一輪沒有新區塊可掃');
  assert.equal(chain.calls.length, logCallsBefore, '真的沒有發 getLogs');
  assert.deepEqual(
    chain.balanceReads.slice(balanceReadsBefore),
    [CAKE],
    '候選表的全部列仍被重讀 balanceOf（不是靠這一輪的日誌）',
  );

  assert.equal(round2.candidateCount, 1, '候選個數來自候選表，不是這一輪日誌');
  assert.deepEqual(round2.unknownHoldings.map((holding) => holding.asset), [CAKE], '第 N+1 輪仍然看到它');
  assert.match(
    formatScanStatus(round2).join('\n'),
    /宇宙外的持倉：0x0e09fabb/,
    '觀測記錄必須持續到餘額真的歸零，不能因為「這輪沒新日誌」而消失',
  );
  assert.equal(fake.candidates.get(CAKE)?.lastBalanceWei, 10n ** 18n, '每輪重讀的餘額要寫回候選表');

  console.log(
    `[0010 核心] 第 N 輪 unknownHoldings=${JSON.stringify(round1.unknownHoldings.map((h) => h.asset))}；` +
      `第 N+1 輪 scannedRange=${JSON.stringify(round2.scannedRange)} ` +
      `candidateCount=${round2.candidateCount} unknownHoldings=${JSON.stringify(round2.unknownHoldings.map((h) => h.asset))} ` +
      `universeComplete=${round2.universeComplete}`,
  );
});

test('候選餘額歸零 → 列留著（可能再度有餘額），但不算 unknownHoldings', async () => {
  const chain = stubChain({
    head: 10_000n,
    codeFrom: new Map([[ACCOUNT.toLowerCase(), 100n]]),
    logs: [transferLog(9_500n, CAKE, ACCOUNT)],
    balances: new Map([[`${CAKE}:${ACCOUNT.toLowerCase()}`, 10n ** 18n]]),
    decimals: new Map([[CAKE, 18]]),
  });
  const fake = fakeQuery([{ start_block: '100', last_scanned_block: '9400' }]);
  const deps = { client: stubClient(chain), query: fake.query, portfolioId: 5, account: ACCOUNT, knownTokens: [KNOWN] };
  const round1 = await scanPortfolioHoldings({ ...deps, head: 10_000n });
  assert.equal(round1.unknownHoldings.length, 1);

  // 賣掉了：餘額歸零。
  chain.balances.set(`${CAKE}:${ACCOUNT.toLowerCase()}`, 0n);
  const round2 = await scanPortfolioHoldings({ ...deps, head: 10_000n });
  assert.deepEqual(round2.unknownHoldings, [], '餘額 0 不算持倉：不該進 unknown_token_count');
  assert.doesNotMatch(formatScanStatus(round2).join('\n'), /宇宙外的持倉/);
  assert.equal(round2.zeroBalanceCount, 1);
  assert.equal(fake.candidates.has(CAKE), true, '餘額歸零的候選**不可以刪**（它可能再度有餘額，屆時未必有日誌）');
  assert.equal(fake.candidates.get(CAKE)?.lastBalanceWei, 0n, '餘額 0 要如實寫回');
  assert.equal(fake.candidates.get(CAKE)?.firstSeenBlock, 9_500n, 'first_seen_block 只記第一次，不被重讀改寫');

  console.log(
    `[0010 歸零] candidates=${JSON.stringify([...fake.candidates.keys()])} ` +
      `last_balance_wei=${fake.candidates.get(CAKE)?.lastBalanceWei} first_seen_block=${fake.candidates.get(CAKE)?.firstSeenBlock} ` +
      `unknownHoldings=${round2.unknownHoldings.length}`,
  );
});

test('日誌掃描失敗 → universeComplete=false、游標不動，但候選仍被重讀（重讀與掃描解耦）', async () => {
  const chain = stubChain({
    head: 9_500n,
    codeFrom: new Map([[ACCOUNT.toLowerCase(), 100n]]),
    logs: [transferLog(9_500n, CAKE, ACCOUNT)],
    balances: new Map([[`${CAKE}:${ACCOUNT.toLowerCase()}`, 10n ** 18n]]),
    decimals: new Map([[CAKE, 18]]),
  });
  const fake = fakeQuery([{ start_block: '100', last_scanned_block: '9400' }]);
  const deps = { client: stubClient(chain), query: fake.query, portfolioId: 5, account: ACCOUNT, knownTokens: [KNOWN] };
  await scanPortfolioHoldings({ ...deps, head: 9_500n });
  assert.equal(fake.candidates.has(CAKE), true);

  // 下一輪：head 前進，但 getLogs 一律 403（publicnode 對無 address 的多塊查詢就是這樣拒的）。
  chain.head = 10_000n;
  chain.failingRanges = [{ fromBlock: 9_501n, toBlock: 10_000n }];
  const logCallsBefore = chain.calls.length;
  const balanceReadsBefore = chain.balanceReads.length;
  const round2 = await scanPortfolioHoldings({ ...deps, head: 10_000n });

  assert.equal(round2.scannedRange, null, '第一塊就失敗：一塊都沒掃成功');
  assert.match(round2.incompleteReasons.join('；'), /getLogs/, '掃描失敗要被誠實記下來');
  assert.equal(round2.universeComplete, false, '掃描失敗 → 宇宙完整性未確認');
  assert.equal(round2.cursor.lastScannedBlock, 9_500n, '游標一格都不動');
  assert.equal(fake.writes.length, 1, '只有第一輪寫過游標');

  assert.equal(chain.calls.length, logCallsBefore + 1, '這一輪只發了一次會失敗的 getLogs');
  assert.deepEqual(chain.balanceReads.slice(balanceReadsBefore), [CAKE], '掃描失敗，但已存下來的候選仍被重讀');
  assert.deepEqual(
    round2.unknownHoldings.map((holding) => holding.asset),
    [CAKE],
    '掃描失敗不是忘記已知策略外持倉的理由——觀測記錄必須持續',
  );

  console.log(
    `[0010 解耦] 掃描失敗：universeComplete=${round2.universeComplete} cursor=${round2.cursor.lastScannedBlock} ` +
      `重讀=${JSON.stringify(chain.balanceReads.slice(balanceReadsBefore))} ` +
      `unknownHoldings=${JSON.stringify(round2.unknownHoldings.map((h) => h.asset))} 原因=${round2.incompleteReasons[0]?.slice(0, 30)}…`,
  );
});

// ---------------------------------------------------------------------------
// 5. 游標（真的 Postgres）
// ---------------------------------------------------------------------------

async function dbReason(): Promise<string | null> {
  try {
    await query('select 1 from portfolio_scan_cursors limit 0');
    await query('select 1 from portfolio_holding_candidates limit 0');
    return null;
  } catch (cause) {
    return `Postgres 或 0009/0010 不可用（${cause instanceof Error ? cause.message : String(cause)}）`;
  }
}

const dbSkip = await dbReason();
const hasDb = dbSkip === null;
if (dbSkip !== null) console.warn(`[holdings-scan] 游標測試 skip：${dbSkip}`);
const gate = dbSkip === null ? {} : { skip: dbSkip };
/**
 * 測試用的 portfolio id。
 *
 * 原本寫死 `5` —— 那只有在「dev 資料庫剛好有 portfolio 5」時才會過（這兩個表都有 FK）。
 * 在乾淨的資料庫上會直接撞 FK，測試看起來像壞掉，其實是它一直在借別人的資料。
 * 所以改成當場造一列（策略 + portfolio），並在 `after` 清掉。
 */
async function seedTestPortfolio(): Promise<number> {
  const strategy =
    (await query<{ id: string }>('select id from strategies order by id limit 1')).rows[0] ??
    (
      await query<{ id: string }>(
        `insert into strategies (provider, name) values ($1, $2) returning id`,
        ['0xholdings-scan-test', 'holdings-scan fixture'],
      )
    ).rows[0];
  if (strategy === undefined) throw new Error('造不出測試用的 strategy');
  const row = (
    await query<{ id: string }>(
      `insert into portfolios (user_id, strategy_id, version, schedule_state)
       values ('0xholdings-scan-test', $1, 1, 'idle') returning id`,
      [strategy.id],
    )
  ).rows[0];
  if (row === undefined) throw new Error('造不出測試用的 portfolio');
  return Number(row.id);
}

const TEST_PORTFOLIO = hasDb ? await seedTestPortfolio() : 0;

after(async () => {
  await closePool().catch(() => {
    // DB 不在時 closePool 失敗不該蓋掉測試結果
  });
});

test('游標：沒有列時回 null、存檔後可讀回、start_block 不被後來的存檔覆寫、last 只前進', gate, async () => {
  await query('delete from portfolio_scan_cursors where portfolio_id = $1', [TEST_PORTFOLIO]);
  try {
    assert.equal(await loadCursor(query, TEST_PORTFOLIO), null);

    const fresh: ScanCursor = { portfolioId: TEST_PORTFOLIO, startBlock: 1_000n, lastScannedBlock: 999n };
    await saveCursor(query, fresh);
    assert.deepEqual(await loadCursor(query, TEST_PORTFOLIO), fresh);

    await saveCursor(query, { ...fresh, lastScannedBlock: 2_000n });
    assert.deepEqual(await loadCursor(query, TEST_PORTFOLIO), { ...fresh, lastScannedBlock: 2_000n });

    // 一個更小的 start_block 會憑空宣稱掃過沒掃過的歷史 → 不能被寫進去
    await saveCursor(query, { portfolioId: TEST_PORTFOLIO, startBlock: 10n, lastScannedBlock: 2_000n });
    assert.deepEqual(await loadCursor(query, TEST_PORTFOLIO), { ...fresh, lastScannedBlock: 2_000n });

    // last_scanned_block 只前進（比資料庫裡小的值不會把它拉回去）
    await saveCursor(query, { ...fresh, lastScannedBlock: 1_500n });
    assert.equal((await loadCursor(query, TEST_PORTFOLIO))?.lastScannedBlock, 2_000n);
  } finally {
    await query('delete from portfolio_scan_cursors where portfolio_id = $1', [TEST_PORTFOLIO]);
  }
});

test('候選表（真的 Postgres）：insert 只記第一次、重讀寫回餘額、餘額 0 的列不刪', gate, async () => {
  const MAX_UINT256 = 2n ** 256n - 1n;
  await query('delete from portfolio_holding_candidates where portfolio_id = $1', [TEST_PORTFOLIO]);
  try {
    await saveCandidates(query, { portfolioId: TEST_PORTFOLIO, candidates: [{ asset: CAKE, firstSeenBlock: 9_500n }] });
    assert.deepEqual(await loadCandidates(query, TEST_PORTFOLIO), [
      { asset: CAKE, firstSeenBlock: 9_500n, lastBalanceWei: 0n },
    ]);

    // first_seen_block 只記第一次：重複發現不改寫
    await saveCandidates(query, { portfolioId: TEST_PORTFOLIO, candidates: [{ asset: CAKE, firstSeenBlock: 9_999n }] });
    assert.equal((await loadCandidates(query, TEST_PORTFOLIO))[0]?.firstSeenBlock, 9_500n);

    // 重讀成功 → 餘額寫回（uint256 的完整範圍，numeric(78,0) 放得下）
    await touchCandidates(query, { portfolioId: TEST_PORTFOLIO, balances: [{ asset: CAKE, amountWei: MAX_UINT256 }] });
    assert.equal((await loadCandidates(query, TEST_PORTFOLIO))[0]?.lastBalanceWei, MAX_UINT256);

    // 餘額歸零 → 列**留著**、餘額如實寫回 0（它可能再度有餘額，屆時未必有日誌）
    await touchCandidates(query, { portfolioId: TEST_PORTFOLIO, balances: [{ asset: CAKE, amountWei: 0n }] });
    const after = await loadCandidates(query, TEST_PORTFOLIO);
    assert.equal(after.length, 1, '餘額 0 的候選不可以被刪除');
    assert.equal(after[0]?.lastBalanceWei, 0n);

    // 讀不到 balanceOf 的候選不會被 touch：舊值（這裡是 0）不被偽造成新值
    await touchCandidates(query, { portfolioId: TEST_PORTFOLIO, balances: [] });
    assert.equal((await loadCandidates(query, TEST_PORTFOLIO))[0]?.lastBalanceWei, 0n);
  } finally {
    await query('delete from portfolio_holding_candidates where portfolio_id = $1', [TEST_PORTFOLIO]);
  }
});
