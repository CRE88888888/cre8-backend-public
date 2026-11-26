import { PANCAKE_UR, EXECUTOR_ABI } from '../src/chain.js';
import { quoteKyberSwap, aggregatorWins } from '../src/aggregator.js';
import { quoteBoundMinimum } from '../src/swap-slippage.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createPublicClient, custom, decodeAbiParameters, decodeFunctionData, encodeFunctionResult, encodePacked, getAddress, http, isHex, parseAbi, zeroAddress } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { bsc, bscTestnet } from 'viem/chains';
import { computeDrift } from '../src/drift.js';
import type { DriftReport, Holding, TargetWeight } from '../src/drift.js';
import {
  DEFAULT_DEADLINE_SECONDS,
  MAX_DEADLINE_SECONDS,
  V3_SWAP_EXACT_IN,
  amountInFor,
  minGrossFor,
  moveValueE8,
  planRebalance,
  capAssetLeg,
  buildStep,
  buildRoutedStep,
  refreshFloors,
  readMaxLegUsdE8,
  minimumDepositUsdtWei, tradeMinimumReason, assetTradeMinimumReason, checkBuyFeeReserve, checkTradeMinimums,
  amountOutMinWithBuffer,} from '../src/rebalance-plan.js';
import { quoteNewMoney, newMoneyDepthCap } from '../src/rebalance-plan.js';
import type { PlanRebalanceArgs, PlannedStep, RebalancePlan } from '../src/rebalance-plan.js';
import { DEFAULT_MAX_IMPACT_BPS, resolveMaxImpactBps, safeBuyCap, BUY_CAP_VOLATILE_MARGIN_BPS } from '../src/rebalance-plan.js';
import { capAmountInForImpact, estimateImpact } from '../src/impact.js';
import type { PoolImpactState } from '../src/impact.js';
import { twapPriceInUsdt } from '../src/pricing.js';
import { validateAllocation } from '../src/strategies.js';
import { chooseBestPath, POOL_ABSENT_TTL_MS, setKnownPools } from '../src/routing.js';
import { loadTradingConfig } from '../src/config.js';
import { readNativeBudgetPrice } from '../src/paymaster.js';

/**
 * 規劃器的測試。三種結果（noop / blocked / ready）各自的**理由**與**數字**都要釘死：
 * 這支程式的輸出直接變成鏈上參數，錯一個欄位就是一次 revert 或（更糟）一次多賣。
 *
 * 不碰鏈的部分用 stub client（`readContract` 依 `functionName` 分派，與 positions/holdings-scan 的
 * stub 同一個模式），所以整組可以在沒有 anvil 的機器上跑完。最後一組是**真 fork 的交叉驗證**：
 * 用真的 `previewSwap` / `effectiveFeeBps` / `pool.fee()` 驗 minGross 與 path，環境不可用時明確 skip。
 */

const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' as Address;
const USDT = '0x55d398326f99059ff775485246999027b3197955' as Address;
/** 6 位小數的穩定幣（BSC 上的 USDT 其實是 18 位；這裡刻意用 6 位證明 decimals 真的進到算式裡）。 */
const TOKEN6 = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d' as Address;
/** 第三個代幣，用來製造「不是 oracle pair」的情境。 */
const TOKEN3 = '0x02fca66c1d1afb4e2a7884261eb00f63598a7436' as Address;

const ORACLE = '0x3D79c9BE8c087097Cbb1A8Be0D2714cf8BA95B84' as Address;
const EXECUTOR = '0x60691760815C69d32c1f68146FA11669F62A4b38' as Address;
const REGISTRY = '0x27739a1AD35a924F5545C7d04C2B0537069CA76C' as Address;
const WBNB_USDT_POOL = '0x36696169C63e42cd08ce11f5deeBbCeBae652050' as Address;

// hub 堆疊（AtpMultiPoolOracle + executorMultiPool）。TOKEN3 就是鏈上的 NVDAB。
const ROUTER = '0x132cDfCe34d385f783dAB7F011B2E66E78A2f87f' as Address;
const EXECUTOR_MULTI = '0x9C41696ea7FaA5470eAfb77415D063beEef83f4a' as Address;
const ORACLE_WBNB_USDT = '0x535111F60a9cB7C3b95A17fB8d1dd2D17275DBFE' as Address;
const ORACLE_NVDAB_USDT = '0x12Ce4542B25fe53a3c606dd7783513357b6D838d' as Address;
const NVDAB_USDT_POOL = '0x8FB4243b553aC29BA088aCf00B9B7dA24bD6690C' as Address;
/** 測試專用：第 4 個資產的 per-pair oracle／池（stub 的地址，不宣稱鏈上有這兩個合約）。 */
const ORACLE_TOKEN6_USDT = '0x00000000000000000000000000000000000fEED1' as Address;
const TOKEN6_USDT_POOL = '0x00000000000000000000000000000000000fEED2' as Address;

/** 1e8 定點：$1000。 */
const PRICE_1000_USD = 100_000_000_000n;
/** 1e8 定點：$1。 */
const PRICE_1_USD = 100_000_000n;

/** 解 `inputs[0]` 用的 ABI：刻意自己寫一份，不從被測檔案 import（否則編錯會一起錯）。 */
const V3_INPUT_ABI = [
  { name: 'recipient', type: 'address' },
  { name: 'amountIn', type: 'uint256' },
  { name: 'amountOutMin', type: 'uint256' },
  { name: 'path', type: 'bytes' },
  { name: 'payerIsUser', type: 'bool' },
] as const;

type ChainCall = { functionName: string; address: string; args?: readonly unknown[]; blockNumber?: bigint };

/** hub 模式：`asset → per-pair oracle + 它的池`（`AtpMultiPoolOracle.oracleOf` 的內容）。 */
type StubPair = { oracle: Address; pool: Address; fee: number };
/** hub 模式：一筆報價。key 是 `${tokenIn}:${tokenOut}`（方向有意義），缺席 = 沒有池。 */
type StubQuote = { minimum: bigint; quoted?: bigint };

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

type StubChain = {
  ammQuotes?: boolean;
  routeQuotes?: boolean;
  minBatchFee?: bigint;
  buyAllowance?: unknown;
  /** Executor `maxBuyBps` and the account's numeraire `balanceOf`; unset = the read reverts (no cash credit). */
  maxBuyBps?: number;
  accountCash?: bigint;
  executorNumeraire?: unknown;
  calls: ChainCall[];
  block: { number: bigint; timestamp: bigint };
  /** 被呼叫的 `getBlock` 次數（deadline 一定要讀塊時間，除非注入）。 */
  blockReads: number;
  oracle: {
    errors?: Record<string, Error>;
    pool: Address;
    token0: Address;
    token1: Address;
    quoted: bigint;
    minimum: bigint;
    revert: string | Error | null;
    /**
     * 設了就是 `AtpMultiPoolOracle` 的形狀：`pool()`/`token0()`/`token1()` 一律 revert（真的 router
     * 沒有那三個函式），報價與 pool fee 走 `pairs` + `quotes`。
     */
    numeraire?: Address;
    pairs?: Record<string, StubPair>;
    quotes?: Record<string, StubQuote>;
  };
  registry: { feeBps: number };
  pool: { fee: number };
  /**
   * 池子的衝擊估算狀態（`slot0`/`liquidity`/`token0`）。**`undefined` = 讀不到**：
   * 走「估不出衝擊 → 放行原量」那一條路，既有測試因此完全不必改。
   */
  poolState?: { sqrtPriceX96: bigint; liquidity: bigint; token0?: Address };
  /**
   * 設了就是「按量計價」的 oracle：`quoted = amountIn × rateE18 / 1e18`、
   * `minimum = ceil(quoted × (10000 − slippageBps) / 10000)`。
   * 衝擊估算要用 `quoted / amountIn` 反推 TWAP 價，固定報價的 stub 會讓那個比值失真。
   */
  rate?: { rateE18: bigint; slippageBps: number };
};

function stubClient(chain: StubChain): PublicClient {
  /** 按量計價（`chain.rate`）。沒設就回 null，走固定報價的既有路徑。 */
  const quoteByRate = (amountIn: bigint): [bigint, bigint] | null => {
    if (chain.rate === undefined) return null;
    const quoted = (amountIn * chain.rate.rateE18) / 10n ** 18n;
    const minimum = (quoted * BigInt(10_000 - chain.rate.slippageBps) + 9_999n) / 10_000n;
    return [quoted, minimum];
  };
  /** 這個地址是不是我們認識的池子（用來決定 `token0`/`slot0`/`liquidity` 打在誰身上）。 */
  const isPoolAddress = (target: string): boolean =>
    target === chain.oracle.pool.toLowerCase() ||
    Object.values(chain.oracle.pairs ?? {}).some((pair) => pair.pool.toLowerCase() === target);

  const client = {
    call: createPublicClient({ transport: custom({ request: async ({ params }) => {
      assert.ok(Array.isArray(params)); const raw: unknown = params[0];
      assert.ok(typeof raw === 'object' && raw !== null);
      const data: unknown = Reflect.get(raw, 'data'); assert.ok(typeof data === 'string' && isHex(data));
      const abi = parseAbi(['function quoteExactInput(bytes,uint256) returns(uint256,uint160[])']);
      const decoded = decodeFunctionData({ abi, data });
      const [path, input] = decoded.args;
      const key = `${path.slice(0, 42).toLowerCase()}:0x${path.slice(-40).toLowerCase()}`;
      const quote = chain.oracle.quotes?.[key];
      const floor = quoteByRate(input)?.[1] ?? quote?.minimum ?? chain.oracle.minimum;
      // These legacy cases isolate oracle/fee/budget arithmetic. Supply an executable spot
      // quote 30 bps above the fee-adjusted floor; #58 cases below use independent spot prices.
      const gross = (floor * 10000n + BigInt(9999 - chain.registry.feeBps)) / BigInt(10000 - chain.registry.feeBps);
      // Arithmetic fixtures model a deep execution route near the oracle price.
      // The old floor-only mock could imply 1.7% loss even on a 5-bps pool,
      // which is correctly rejected by #92's independent fee + impact budget.
      const oracleQuote=quoteByRate(input)?.[0]??quote?.quoted??quote?.minimum??chain.oracle.quoted;
      const routeFee=chain.oracle.pairs?.[key.split(':').find(a=>a!==USDT)??'']?.fee??chain.pool.fee;
      const spot=oracleQuote*BigInt(1_000_000-routeFee)/1_000_000n;
      const buffered=gross+(gross*30n+9999n)/10000n;
      const fee=Number(BigInt(`0x${path.slice(42,48)}`));
      const net=input*BigInt(1000000-fee)/1000000n;
      const depth=chain.poolState?.liquidity??0n;
      const output=chain.ammQuotes?net*depth/(depth+net):(spot>buffered?spot:buffered);
      return encodeFunctionResult({ abi, functionName: 'quoteExactInput', result: [output, []] });
    } }, { retryCount: 0 }) }).call,
    getBlock: async (args: { blockNumber?: bigint }) => {
      chain.blockReads += 1;
      return { number: chain.block.number, timestamp: chain.block.timestamp, hash: '0x', transactions: [] };
    },
    readContract: async (args: {
      address: Address;
      functionName: string;
      args?: readonly unknown[];
      blockNumber?: bigint;
    }): Promise<unknown> => {
      chain.calls.push({
        functionName: args.functionName,
        address: args.address.toLowerCase(),
        args: args.args,
        blockNumber: args.blockNumber,
      });
      const target = args.address.toLowerCase();
      if (args.functionName === 'venues') return [1, PANCAKE_UR];
      if (target === EXECUTOR.toLowerCase() || target === EXECUTOR_MULTI.toLowerCase()) {
        if (args.functionName === 'minBatchFee') return chain.minBatchFee ?? 0n;
        if (args.functionName === 'minFeeTopUp') {
          const notional = args.args?.[1];
          assert.equal(typeof notional, 'bigint');
          const volume = typeof notional === 'bigint' ? notional : 0n;
          const min = chain.minBatchFee ?? 0n;
          const minimum = volume / 100n < min ? volume / 100n : min;
          const proportional = volume * BigInt(chain.registry.feeBps) / 10000n;
          return minimum > proportional ? minimum - proportional : 0n;
        }
        if (args.functionName === 'numeraire') {
          if (chain.executorNumeraire instanceof Error) throw chain.executorNumeraire;
          return chain.executorNumeraire === undefined ? chain.oracle.token0 : chain.executorNumeraire;
        }
        if (args.functionName === 'maxBuyBps' && chain.maxBuyBps !== undefined) return chain.maxBuyBps;
        if (args.functionName === 'buyAllowance') {
          if (chain.buyAllowance instanceof Error) throw chain.buyAllowance;
          return chain.buyAllowance === undefined ? [2n ** 192n - 1n, 0n, 0n] : chain.buyAllowance;
        }
      }
      const hub = chain.oracle.numeraire !== undefined;
      const pairs = chain.oracle.pairs ?? {};

      if (hub && (target === ROUTER.toLowerCase() || target === ORACLE.toLowerCase())) {
        switch (args.functionName) {
          case 'numeraire':
            return chain.oracle.numeraire;
          case 'oracleOf': {
            const asset = String(args.args?.[0] ?? '').toLowerCase();
            return pairs[asset]?.oracle ?? ZERO_ADDRESS;
          }
          case 'previewSwap': {
            const amountIn = args.args?.[2] as bigint;
            const byRate = quoteByRate(amountIn);
            if (byRate !== null) return byRate;
            const key = `${String(args.args?.[0]).toLowerCase()}:${String(args.args?.[1]).toLowerCase()}`;
            const failure = chain.oracle.errors?.[key];
            if (failure !== undefined) throw failure;
            const quote = chain.oracle.quotes?.[key];
            if (quote === undefined) throw new Error('execution reverted: UnsupportedRoute()');
            return [quote.quoted ?? quote.minimum, quote.minimum];
          }
          default:
            // 真的 AtpMultiPoolOracle 沒有 pool()/token0()/token1()：這幾個呼叫會 revert。
            throw new Error('execution reverted');
        }
      }
      if (hub) {
        const pair = Object.values(pairs).find((entry) => entry.oracle.toLowerCase() === target);
        if (pair !== undefined) {
          switch (args.functionName) {
            case 'pool':
              return pair.pool;
            default:
              throw new Error(`stub 沒有 ${args.functionName}`);
          }
        }
      }
      switch (args.functionName) {
        case 'quoteExactInput': {
          if(chain.routeQuotes!==true)throw new Error('route quote not configured');
          const amount=args.args?.[1];if(typeof amount!=='bigint')throw new Error('invalid route amount');
          const path=args.args?.[0];assert.equal(typeof path,'string');
          const fee=Number(BigInt(`0x${String(path).slice(42,48)}`)),net=amount*BigInt(1000000-fee)/1000000n,depth=chain.poolState?.liquidity??0n;
          return [chain.ammQuotes?net*depth/(depth+net):amount*99n/100n,[]];
        }
        case 'pool':
          return chain.oracle.pool;
        case 'token0':
          // 池子的 token0（衝擊估算用）優先看 poolState；oracle 的 token0 一律還是 oracle.token0。
          return isPoolAddress(target) && chain.poolState?.token0 !== undefined
            ? chain.poolState.token0
            : chain.oracle.token0;
        case 'token1':
          return chain.oracle.token1;
        case 'slot0': {
          if (chain.poolState === undefined) throw new Error(`stub 沒有 ${args.functionName}`);
          return [chain.poolState.sqrtPriceX96, 0, 0, 10, 10, 0, true];
        }
        case 'liquidity': {
          if (chain.poolState === undefined) throw new Error(`stub 沒有 ${args.functionName}`);
          return chain.poolState.liquidity;
        }
        case 'previewSwap': {
          if (chain.oracle.revert instanceof Error) throw chain.oracle.revert;
          if (chain.oracle.revert !== null) throw new Error(`execution reverted: ${chain.oracle.revert}()`);
          const byRate = quoteByRate(args.args?.[2] as bigint);
          return byRate ?? [chain.oracle.quoted, chain.oracle.minimum];
        }
        case 'fee': {
          // hub 模式的池子按地址認（每個 pair 一個池、fee 不同）；legacy 模式固定一個。
          const hubPool = Object.values(pairs).find((entry) => entry.pool.toLowerCase() === target);
          return hubPool?.fee ?? chain.pool.fee;
        }
        case 'effectiveFeeBps':
          return chain.registry.feeBps;
        case 'decimals': return 18;
        case 'balanceOf':
          if (chain.accountCash === undefined) throw new Error(`stub 沒有 ${args.functionName}`);
          return chain.accountCash;
        default:
          throw new Error(`stub 沒有 ${args.functionName}`);
      }
    },
  };
  return client as unknown as PublicClient;
}

function baseChain(overrides: Partial<StubChain> = {}): StubChain {
  return {
    calls: [],
    block: { number: 132_141_042n, timestamp: 1_700_000_000n },
    blockReads: 0,
    oracle: {
      pool: WBNB_USDT_POOL,
      token0: USDT,
      token1: WBNB,
      quoted: 700_000_000_000_000_000_000n,
      minimum: 688_023_143_350_803_187_441n,
      revert: null,
    },
    registry: { feeBps: 0 },
    pool: { fee: 500 },
    ...overrides,
  };
}

/**
 * 按量計價的比率（`rateE18` = 每 1e18 個 tokenIn 最小單位換到多少 tokenOut 最小單位）。
 *
 * 為什麼需要：`baseChain()` 的固定 floor（688e18）與量脫鉤 —— 賣 0.1 WBNB 也回 688 USDT。
 * 「執行後預估漂移」用那個比率算出來是垃圾，不改善守衛於是會把正常的計畫判成 noop。
 * 按 $1000/WBNB、$1/TICKER 換算：
 *   1e18 WBNB wei = 1 WBNB = $1000 = 1000 USDT = 1e21 USDT wei          → 1e21
 *   1e18 WBNB wei = 1 WBNB = $1000 = 1000 TOKEN6 = 1e9 TOKEN6 單位     → 1e9
 *   1e18 TOKEN6 單位 = 1e12 TOKEN6 = $1e12 = 1e9 WBNB = 1e27 WBNB wei  → 1e27
 */
const RATE_WBNB_USDT = { rateE18: 10n ** 21n, slippageBps: 100 } as const;
const RATE_WBNB_TO_TOKEN6 = { rateE18: 10n ** 9n, slippageBps: 100 } as const;
const RATE_TOKEN6_TO_WBNB = { rateE18: 10n ** 27n, slippageBps: 100 } as const;

/**
 * hub 模式的 stub：`AtpMultiPoolOracle` 的形狀（`numeraire` 有、`pool/token0/token1` 沒有），
 * 每個資產一個 per-pair oracle 與池，報價按 `${tokenIn}:${tokenOut}` 給。
 */
function hubChain(
  options: { quotes?: Record<string, StubQuote>; pairs?: Record<string, StubPair>; feeBps?: number } = {},
): StubChain {
  const chain = baseChain();
  chain.oracle = {
    ...chain.oracle,
    numeraire: USDT,
    pairs: options.pairs ?? {
      [WBNB.toLowerCase()]: { oracle: ORACLE_WBNB_USDT, pool: WBNB_USDT_POOL, fee: 500 },
      [TOKEN3.toLowerCase()]: { oracle: ORACLE_NVDAB_USDT, pool: NVDAB_USDT_POOL, fee: 2_500 },
      [TOKEN6.toLowerCase()]: { oracle: ORACLE_TOKEN6_USDT, pool: TOKEN6_USDT_POOL, fee: 100 },
    },
    quotes: options.quotes ?? {},
  };
  chain.registry = { feeBps: options.feeBps ?? 0 };
  return chain;
}

/** hub 模式的完整輸入（oracle = router、executor = executorMultiPool）。 */
function hubArgs(
  chain: StubChain,
  overrides: Partial<PlanRebalanceArgs> & {
    holdings: readonly Holding[];
    targets: readonly TargetWeight[];
    thresholdBps: number;
  },
): PlanRebalanceArgs {
  return argsOf(chain, { oracle: ROUTER, executor: EXECUTOR_MULTI, ...overrides });
}

/** 3 資產手算案例的輸入：目標 40/30/30、實際 60/20/20、總值 $1000。 */
function threeAssetCase(): { holdings: Holding[]; targets: TargetWeight[] } {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD), // 0.6 顆 @ $1000 = $600（60%）
    holding(TOKEN3, 200_000_000_000_000_000_000n, 18, PRICE_1_USD), // NVDAB 200 顆 @ $1 = $200（20%）
    holding(USDT, 200_000_000_000_000_000_000n, 18, PRICE_1_USD), // 200 USDT（20%）
  ];
  const targets: TargetWeight[] = [
    { asset: WBNB, weightBps: 4_000 },
    { asset: TOKEN3, weightBps: 3_000 },
    { asset: USDT, weightBps: 3_000 },
  ];
  return { holdings, targets };
}

/** holding 的簡寫：decimals 與價格一起給，避免測試裡的物件散成一團。 */
function holding(asset: Address, amountWei: bigint, decimals: number, priceE8: bigint): Holding {
  return { asset, amountWei, decimals, usdPriceE8: priceE8 };
}

function targetsOf(a: Address, b: Address, weightA = 5_000): TargetWeight[] {
  return [
    { asset: a, weightBps: weightA },
    { asset: b, weightBps: 10_000 - weightA },
  ];
}

/** 規劃器的完整輸入；每一列測試只覆寫它關心的那幾個欄位。 */
function argsOf(
  chain: StubChain,
  overrides: Partial<PlanRebalanceArgs> & { holdings: readonly Holding[]; targets: readonly TargetWeight[]; thresholdBps: number },
): PlanRebalanceArgs {
  // 四個必填欄位先解出來再展開剩下的：`drift` 沒給就用 computeDrift 當場算（通常是這樣）。
  const { holdings, targets, thresholdBps, drift: driftOverride, ...rest } = overrides;
  return {
    // These fixtures isolate routing/impact arithmetic; #75 cases below exercise default trading minimums.
    tradingConfig: loadTradingConfig({ MIN_STEP_USD_E8: '0', MIN_BATCH_USD_E8: '0' }),
    publicClient: stubClient(chain),
    maxLegUsdE8: new Map(targets.map((target) => [target.asset.toLowerCase(), null])),
    account: '0x2b082fadf8f3d620eaa242a9e36817af8640d042' as Address,
    executor: EXECUTOR,
    oracle: ORACLE,
    registry: REGISTRY,
    strategyId: 1n,
    holdings,
    targets,
    drift: driftOverride ?? computeDrift(holdings, targets, thresholdBps),
    thresholdBps,
    blockNumber: chain.block.number,
    ...rest,
  };
}

test('#75 default batch minimum accepts exactly 50 and accumulates below 50', async () => {
  for (const usd of [98n, 100n, 102n]) {
    const chain = baseChain({ rate: RATE_WBNB_USDT });
    const args = argsOf(chain, { holdings: [holding(WBNB, usd * 10n ** 15n, 18, PRICE_1000_USD), holding(USDT, 0n, 18, PRICE_1_USD)],
      targets: targetsOf(WBNB, USDT), thresholdBps: 100, maxImpactBps: null, tradingConfig: loadTradingConfig({}) });
    const plan = await planRebalance(args);
    assert.equal(plan.kind, usd < 100n ? 'blocked' : 'ready');
    if (plan.kind === 'blocked') assert.match(plan.reason, /BELOW_MIN_BATCH/);
  }
});

test('#75 dropped sub-5 sale cannot fund a subsequent buy', async () => {
  const chain = hubChain();
  chain.rate = { rateE18: 10n ** 18n, slippageBps: 100 };
  const plan = expectReady(await planRebalance(hubArgs(chain, {
    holdings: [holding(WBNB, 10n * 10n ** 18n, 18, PRICE_1_USD), holding(USDT, 90n * 10n ** 18n, 18, PRICE_1_USD)],
    targets: [{ asset: WBNB, weightBps: 600 }, { asset: TOKEN3, weightBps: 9400 }, { asset: USDT, weightBps: 0 }],
    thresholdBps: 100, maxImpactBps: null, tradingConfig: loadTradingConfig({MIN_STEP_USD_E8:'500000000'}),
  })));
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]?.tokenIn.toLowerCase(), USDT);
  assert.equal(plan.steps[0]?.amountIn, 90n * 10n ** 18n);
  assert.match(plan.rationale, /BELOW_MIN_STEP/);
});

test('#75 buys reserve contract minimum-fee top-up before building the actual payload', async () => {
  const chain = hubChain({ feeBps: 10 });
  chain.rate = { rateE18: 10n ** 18n, slippageBps: 100 };
  chain.minBatchFee = 3n * 10n ** 17n;
  const plan = expectReady(await planRebalance(hubArgs(chain, {
    holdings: [holding(USDT, 100n * 10n ** 18n, 18, PRICE_1_USD)], targets: targetsOf(WBNB, USDT, 10000),
    thresholdBps: 100, maxImpactBps: null, tradingConfig: loadTradingConfig({}),
  })));
  assert.equal(plan.steps[0]?.amountIn, 9973n * 10n ** 16n);
  const topup = chain.calls.find((call) => call.functionName === 'minFeeTopUp');
  assert.deepEqual(topup?.args, [1n, 30n * 10n ** 18n]);
  assert.equal(topup?.blockNumber, chain.block.number);
  const step = plan.steps[0];
  assert.ok(step);
  const [, inputs] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], step.data);
  const payload = inputs[0]; assert.ok(payload);
  assert.equal(decodeAbiParameters(V3_INPUT_ABI, payload)[1], step.amountIn);
});

/** 手寫一份 DriftReport：只有「持倉算出來的漂移到不了那個數字」的邊界案例才用它。 */
function craftedDrift(args: {
  totalUsdE8: bigint;
  rows: { asset: Address; targetBps: number; currentBps: number; usdValueE8: bigint }[];
  thresholdBps?: number;
}): DriftReport {
  const assets = args.rows.map((row) => ({
    asset: row.asset,
    targetBps: row.targetBps,
    currentBps: row.currentBps,
    deltaBps: row.currentBps - row.targetBps,
    usdValueE8: row.usdValueE8,
  }));
  const sumAbs = assets.reduce((sum, row) => sum + Math.abs(row.deltaBps), 0);
  return {
    totalUsdE8: args.totalUsdE8,
    assets,
    maxAbsDeltaBps: assets.reduce((max, row) => Math.max(max, Math.abs(row.deltaBps)), 0),
    grossDriftBps: Math.round(sumAbs / 2),
    needsRebalance: true,
    thresholdBps: args.thresholdBps ?? 100,
  };
}

/** ready 的窄化：不是 ready 就直接讓測試紅在「為什麼不是 ready」上。 */
function expectReady(plan: RebalancePlan): Extract<RebalancePlan, { kind: 'ready' }> {
  if (plan.kind !== 'ready') {
    throw new assert.AssertionError({ message: `預期 ready，得到 ${plan.kind}：${plan.reason}` });
  }
  return plan;
}

/** 解出 V3 payload 的五個欄位，測試裡每一處都靠它驗「合約會收到什麼」。 */
function decodeStepInput(step: PlannedStep): {
  recipient: Address;
  amountIn: bigint;
  amountOutMin: bigint;
  path: Hex;
  payerIsUser: boolean;
} {
  const input = pancakePayload(step).inputs[0];
  assert.ok(input !== undefined, 'inputs[0] 必須存在');
  const decoded = decodeAbiParameters(V3_INPUT_ABI, input);
  return {
    recipient: decoded[0],
    amountIn: decoded[1],
    amountOutMin: decoded[2],
    path: decoded[3],
    payerIsUser: decoded[4],
  };
}

/** packed path 中間那 3 bytes 的 fee（0x + 40 hex 地址之後）。 */
function pathFee(path: Hex): number {
  return Number.parseInt(path.slice(42, 48), 16);
}

// ---------------------------------------------------------------- R1：不需要動 → noop（不是空 steps）

test('R1 未達門檻 → noop，而且不回空的 steps、不讀鏈', async () => {
  // 50/50 的目標、實際也剛好 50/50：gross drift 0 bps < 門檻 100。
  const holdings = [
    holding(WBNB, 500_000_000_000_000_000n, 18, PRICE_1000_USD), // $500
    holding(USDT, 500_000_000_000_000_000_000n, 18, PRICE_1_USD), // $500
  ];
  const chain = baseChain();
  const plan = await planRebalance(
    argsOf(chain, { holdings, targets: targetsOf(WBNB, USDT), thresholdBps: 100 }),
  );

  assert.equal(plan.kind, 'noop');
  if (plan.kind !== 'noop') throw new Error('unreachable');
  assert.match(plan.reason, /No rebalance needed/);
  // 關鍵：noop 沒有 steps 這個欄位。空陣列會是「成功但什麼都沒做」（pitfalls §8.1）。
  assert.equal('steps' in plan, false);
  // noop 是純決策：連一次鏈上讀取都不該發生。
  assert.equal(chain.calls.length, 0);
  assert.equal(chain.blockReads, 0);
});

test('R1 空倉（total = 0）→ noop，不是 blocked 也不是空 steps', async () => {
  // portfolio 5 現在就是這個形狀：gross drift 5000 bps（drift.ts 對 total = 0 的定義），但沒有部位可搬。
  const chain = baseChain();
  const plan = await planRebalance(
    argsOf(chain, { holdings: [], targets: targetsOf(WBNB, USDT), thresholdBps: 100 }),
  );

  assert.equal(plan.kind, 'noop');
  if (plan.kind !== 'noop') throw new Error('unreachable');
  assert.match(plan.reason, /value is 0/);
  assert.equal('steps' in plan, false);
  assert.equal(chain.calls.length, 0);
});

test('R1 門檻與 drift 不一致 → 拋錯（拿另一份門檻算的 drift 規劃是錯的）', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const chain = baseChain();
  const targets = targetsOf(WBNB, USDT);
  await assert.rejects(
    planRebalance(
      argsOf(chain, {
        holdings,
        targets,
        drift: computeDrift(holdings, targets, 100),
        thresholdBps: 200,
      }),
    ),
    /thresholdBps\(200\) 與 drift\.thresholdBps\(100\) 不一致/,
  );
});

// ---------------------------------------------------------------- R2：只支援 2 資產 / 單一 pair

test('R2 目標 3 個資產 → blocked，理由寫明 D-23', async () => {
  const holdings = [
    holding(WBNB, 400_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 300_000_000_000_000_000_000n, 18, PRICE_1_USD),
    holding(TOKEN3, 300_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const targets: TargetWeight[] = [
    { asset: WBNB, weightBps: 3_400 },
    { asset: USDT, weightBps: 3_300 },
    { asset: TOKEN3, weightBps: 3_300 },
  ];
  const chain = baseChain();
  const plan = await planRebalance(argsOf(chain, { holdings, targets, thresholdBps: 100 }));

  assert.equal(plan.kind, 'blocked');
  if (plan.kind !== 'blocked') throw new Error('unreachable');
  assert.match(plan.reason, /3 assets/);
  assert.match(plan.reason, /pins a single pool/);
  assert.match(plan.reason, /per-call oracle \(D-23\)/);
  assert.equal('steps' in plan, false);
});

test('R2 oracle 的 pool 不是這兩個代幣 → blocked（不靠 revert，靠 token0/token1）', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(TOKEN3, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  // oracle 綁的是 USDT/WBNB，兩個目標卻是 WBNB/TOKEN3。
  const chain = baseChain();
  const plan = await planRebalance(
    argsOf(chain, { holdings, targets: targetsOf(WBNB, TOKEN3), thresholdBps: 100 }),
  );

  assert.equal(plan.kind, 'blocked');
  if (plan.kind !== 'blocked') throw new Error('unreachable');
  assert.match(plan.reason, /not .* \/ /);
  assert.match(plan.reason, /per-call oracle \(D-23\)/);
  // pair 不對時不該去打 previewSwap：先擋掉，省一次註定失敗的呼叫。
  assert.equal(chain.calls.some((call) => call.functionName === 'previewSwap'), false);
});

test('R2 oracle 回 UnsupportedPair → blocked（試探路徑）', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const chain = baseChain();
  chain.oracle.revert = 'UnsupportedPair';
  const plan = await planRebalance(
    argsOf(chain, { holdings, targets: targetsOf(WBNB, USDT), thresholdBps: 100 }),
  );

  assert.equal(plan.kind, 'blocked');
  if (plan.kind !== 'blocked') throw new Error('unreachable');
  assert.match(plan.reason, /UnsupportedPair/);
  assert.match(plan.reason, /D-23/);
});

test('R2 oracle 報不出價（TwapUnavailable）→ blocked，理由與 pair 不符分開', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const chain = baseChain();
  chain.oracle.revert = 'TwapUnavailable';
  const plan = await planRebalance(
    argsOf(chain, { holdings, targets: targetsOf(WBNB, USDT), thresholdBps: 100 }),
  );

  assert.equal(plan.kind, 'blocked');
  if (plan.kind !== 'blocked') throw new Error('unreachable');
  assert.match(plan.reason, /cannot quote/);
  assert.match(plan.reason, /NoFloor/);
});

// ---------------------------------------------------------------- R3：賣哪一個、賣多少（手算案例）

test('R3 手算案例：total $1000、目標 50/50、實際 60/40、18 位小數的賣方 → 賣 0.1 WBNB', async () => {
  // 手算（全部是整數）：
  //   WBNB：0.6e18 wei × $1000 → 6e17 × 1e11 / 1e18 = 6e10 = $600
  //   TOKEN6：400e6 wei × $1   → 4e8  × 1e8  / 1e6  = 4e10 = $400
  //   total = 1e11（$1000）；currentBps = 6000 / 4000；target = 5000 / 5000
  //   deltaBps(WBNB) = +1000 → 要搬 1000 × 1e11 / 10000 = 1e10（$100）
  //   amountIn = 1e10 × 10^18 / 1e11 = 1e17 wei = 0.1 WBNB（正好 $100）
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(TOKEN6, 400_000_000n, 6, PRICE_1_USD),
  ];
  const targets = targetsOf(WBNB, TOKEN6);
  const drift = computeDrift(holdings, targets, 100);
  assert.equal(drift.totalUsdE8, 100_000_000_000n);
  assert.equal(drift.grossDriftBps, 1_000);
  assert.equal(drift.needsRebalance, true);

  const chain = baseChain({ oracle: { ...baseChain().oracle, token0: TOKEN6, token1: WBNB }, rate: RATE_WBNB_TO_TOKEN6 });
  const plan = expectReady(
    await planRebalance(argsOf(chain, { holdings, targets, drift, thresholdBps: 100 })),
  );

  assert.equal(plan.steps.length, 1);
  const step = plan.steps[0];
  assert.ok(step !== undefined);
  assert.equal(step.tokenIn, getAddress(WBNB));
  assert.equal(step.tokenOut, getAddress(TOKEN6));
  assert.equal(step.amountIn, 100_000_000_000_000_000n); // 0.1 WBNB，手算值
  // 賣出的量不可能超過持倉（0.6 WBNB）。
  assert.ok(step.amountIn <= 600_000_000_000_000_000n);
  const decoded = decodeStepInput(step);
  assert.equal(decoded.amountIn, 100_000_000_000_000_000n);
  assert.equal(decoded.recipient, getAddress(EXECUTOR));
  assert.equal(decoded.payerIsUser, true);
});

test('R3 手算案例：6 位小數的賣方 → 賣 100 個最小單位 × 1e6', async () => {
  // 反過來：WBNB $400（0.4 顆）、TOKEN6 $600（600e6 wei）→ deltaBps(TOKEN6) = +1000
  //   要搬 1e10（$100）→ amountIn = 1e10 × 10^6 / 1e8 = 1e8 wei = 100 顆 TOKEN6
  const holdings = [
    holding(WBNB, 400_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(TOKEN6, 600_000_000n, 6, PRICE_1_USD),
  ];
  const targets = targetsOf(WBNB, TOKEN6);
  const chain = baseChain({ oracle: { ...baseChain().oracle, token0: TOKEN6, token1: WBNB }, rate: RATE_TOKEN6_TO_WBNB });
  const plan = expectReady(await planRebalance(argsOf(chain, { holdings, targets, thresholdBps: 100 })));

  const step = plan.steps[0];
  assert.ok(step !== undefined);
  assert.equal(step.tokenIn, getAddress(TOKEN6));
  assert.equal(step.tokenOut, getAddress(WBNB));
  assert.equal(step.amountIn, 100_000_000n); // 100 顆（6 位小數）
  assert.ok(step.amountIn <= 600_000_000n);
  // rationale 要看得出「賣幾顆」而不只是 wei。
  assert.match(plan.rationale, /賣 100\.000000 顆/);
});

test('R3 賣出量超過持倉 → 夾到持倉，並在 rationale 說明', async () => {
  // 刻意不一致的 drift（total 記成 $2000，而帳戶只有 1 顆 $1000 的 WBNB）：夾取是唯一防線，
  // 因為「多賣」在合約層完全合法（合約只驗 amountOutMin 下限）。
  const holdings = [holding(WBNB, 1_000_000_000_000_000_000n, 18, PRICE_1000_USD)];
  const targets = targetsOf(WBNB, TOKEN6);
  const drift = craftedDrift({
    totalUsdE8: 200_000_000_000n, // $2000
    rows: [
      { asset: WBNB, targetBps: 5_000, currentBps: 15_000, usdValueE8: 200_000_000_000n },
      { asset: TOKEN6, targetBps: 5_000, currentBps: -5_000, usdValueE8: 0n },
    ],
  });
  const chain = baseChain({ oracle: { ...baseChain().oracle, token0: TOKEN6, token1: WBNB } });
  const plan = expectReady(
    await planRebalance(argsOf(chain, { holdings, targets, drift, thresholdBps: 100 })),
  );

  const step = plan.steps[0];
  assert.ok(step !== undefined);
  // 漂移算出來是 2 顆（2 × $1000），持倉只有 1 顆 → 夾到 1e18。
  assert.equal(step.amountIn, 1_000_000_000_000_000_000n);
  assert.match(plan.rationale, /夾到實際持倉/);
  assert.match(plan.rationale, /依漂移算出 2000000000000000000/);
});

test('R3 amountIn 算出來是 0 → noop（合約對 amountIn == 0 會 revert ZeroAmount）', async () => {
  // 0 位小數的代幣、價格 $1、要搬 $0.1：0.1 個最小單位 → 向下截斷成 0。
  const holdings = [holding(TOKEN6, 1_000_000n, 0, PRICE_1_USD)];
  const targets = targetsOf(TOKEN6, WBNB);
  const drift = craftedDrift({
    totalUsdE8: 100_000_000_000n, // $1000
    rows: [
      { asset: TOKEN6, targetBps: 5_000, currentBps: 5_001, usdValueE8: 1_000n },
      { asset: WBNB, targetBps: 5_000, currentBps: 4_999, usdValueE8: 0n },
    ],
  });
  const chain = baseChain();
  const plan = await planRebalance(
    argsOf(chain, { holdings, targets, drift, thresholdBps: 100 }),
  );

  assert.equal(plan.kind, 'noop');
  if (plan.kind !== 'noop') throw new Error('unreachable');
  assert.match(plan.reason, /sell amount is 0/);
  assert.match(plan.reason, /ZeroAmount/);
  assert.equal('steps' in plan, false);
  // 一次鏈上讀取都不該發生：算不出量就不必問 oracle。
  assert.equal(chain.calls.length, 0);
});

test('R3 取整方向：amountInFor / moveValueE8 一律向下截斷，且回推不超過原值', () => {
  // $1（1e8）× 10^18 / ($3 = 3e8) = 3.333…e17 wei → 向下截斷
  assert.equal(amountInFor(PRICE_1_USD, 3n * PRICE_1_USD, 18), 333_333_333_333_333_333n);
  assert.equal(
    amountInFor(PRICE_1_USD, 3n * PRICE_1_USD, 18),
    10n ** 26n / (3n * PRICE_1_USD),
  );
  // 乘回價格換成 E8 必須 ≤ 原本的價值：這就是「不會多賣」的算術根據。
  assert.ok(
    (333_333_333_333_333_333n * 3n * PRICE_1_USD) / 10n ** 18n <= PRICE_1_USD,
  );
  // |deltaBps| × total / 10000 也是向下：3 × 1e4 / 1e4 = 3；1 × 1 / 1e4 = 0。
  assert.equal(moveValueE8(3, 10_000n), 3n);
  assert.equal(moveValueE8(1, 9_999n), 0n);
});

// ---------------------------------------------------------------- R4：minGross 逐字對齊合約

test('R4 minGross 進位案例：floor 12345 / fee 25 → 12376（手算）', () => {
  // 12345 × 10000 = 123450000；denom = 10000 - 25 = 9975
  // 9975 × 12375 = 123440625（差 9375）→ 進位 → 12376
  // AtpExecutor._minGross 用的是 Math.mulDiv(..., Rounding.Ceil)，所以必須是 12376，不是 12375。
  assert.equal(minGrossFor(12_345n, 25), 12_376n);
  assert.equal(12_376n * 9_975n >= 123_450_000n, true);
  assert.equal(12_375n * 9_975n < 123_450_000n, true);
});

test('R4 minGross 整除時不進位：floor 10000 / fee 5000 → 20000', () => {
  assert.equal(minGrossFor(10_000n, 5_000), 20_000n);
  // fee 0 是恆等：minGross = floor。
  assert.equal(minGrossFor(688_023_143_350_803_187_441n, 0), 688_023_143_350_803_187_441n);
  // 最小的進位：floor 1 / fee 1 → ceil(10000/9999) = 2。
  assert.equal(minGrossFor(1n, 1), 2n);
});

test('R4 minGross 永遠 ≥ oracleFloor，且等於 floor + ceil(floor×fee/(10000-fee))（獨立算式）', () => {
  // 獨立推導：ceil(x·10000/(10000-f)) 在 x 是整數時等於 x + ceil(x·f/(10000-f))。
  // 這條式子不經過「先乘 10000 再除」的同一條路徑，所以兩邊相符才是真的相符。
  const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
  const cases: [bigint, number][] = [
    [1n, 1],
    [1_000_000n, 25],
    [688_023_143_350_803_187_441n, 25],
    [688_023_143_350_803_187_441n, 100],
    [123_456_789_000_000_000_000n, 300],
    [10n ** 30n, 999],
    [7n, 9_999],
  ];
  for (const [floor, feeBps] of cases) {
    const minGross = minGrossFor(floor, feeBps);
    const denominator = BigInt(10_000 - feeBps);
    assert.ok(minGross >= floor, `fee ${feeBps}: minGross ${minGross} < floor ${floor}`);
    assert.equal(minGross, floor + ceilDiv(floor * BigInt(feeBps), denominator));
  }
});

test('R4 feeBps 從 registry.effectiveFeeBps(鏈上 strategyId) 讀，原樣傳進去', async () => {
  // 這一條測的是 feeBps 的**管線**（fee 從 registry 讀、`oracleFloor` 取自 `minimum` 不是 `quoted`、
  // `amountOutMin = minGross(floor, fee)`），不是金額運算 —— 所以刻意**不**用按量計價的 stub：
  // 它要釘住的就是 stub 回的固定 floor 原值。持倉放大 10 倍是為了讓那個固定 floor（$688）對
  // 「賣 $1000 的 WBNB」是合理的成交，否則不改善守衛（正確地）會把這一輪判成 noop。
  const holdings = [
    holding(WBNB, 6_000_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 4_000_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const chain = baseChain({ registry: { feeBps: 25 } });
  const plan = expectReady(
    await planRebalance(
      argsOf(chain, { holdings, targets: targetsOf(WBNB, USDT), thresholdBps: 100, strategyId: 7n }),
    ),
  );

  const feeCall = chain.calls.find((call) => call.functionName === 'effectiveFeeBps');
  assert.ok(feeCall !== undefined);
  assert.equal(feeCall.address, REGISTRY.toLowerCase());
  assert.deepEqual(feeCall.args, [7n]); // DB 的 id 與鏈上 id 是兩個東西，這裡必須是呼叫端給的那個
  const step = plan.steps[0];
  assert.ok(step !== undefined);
  // floor 688023143350803187441 + ceil(floor×25/9975) = minGross；amountOutMin 必須等於它。
  assert.equal(step.oracleFloor, 688_023_143_350_803_187_441n);
  // stub 的 quoted 是 7e20：取到 quoted 這條就會紅。合約要的是 minimum。
  assert.notEqual(step.oracleFloor, 700_000_000_000_000_000_000n);
  // #92: the independent 5 + 80 bps cost floor is tighter than this oracle floor.
  assert.equal(step.amountOutMin, 696_485_263_157_894_736_843n);
  assert.equal(step.costBudgetBps,85);
  assert.equal(decodeStepInput(step).amountOutMin, step.amountOutMin);
});

test('R4 feeBps >= 10000 → 拋錯（合約會 revert FeeTooHigh，這裡先擋）', () => {
  assert.throws(() => minGrossFor(1n, 10_000), /feeBps must be an integer in 0\.\.9999/);
  assert.throws(() => minGrossFor(-1n, 0), /oracleFloor must not be negative/);
});

// ---------------------------------------------------------------- R5：deadline = max(塊時間, 牆鐘) + deadlineSeconds

/** 牆鐘（unix 秒）。deadline 的基準要跟它比，所以測試自己讀一次（牆鐘會走 → 比區間，不比等號）。 */
function wallClockSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1_000));
}

test('R5 塊時間超前牆鐘 → 用塊時間（max 的「鏈贏」那一邊）', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const chain = baseChain({ rate: RATE_WBNB_USDT });
  // fork 的頭塊停在上游那一刻、或本地鏈被時間旅行過：塊時間在牆鐘之後一小時。
  chain.block.timestamp = wallClockSeconds() + 3_600n;
  const plan = expectReady(
    await planRebalance(argsOf(chain, { holdings, targets: targetsOf(WBNB, USDT), thresholdBps: 100 })),
  );

  assert.equal(plan.deadline, chain.block.timestamp + BigInt(DEFAULT_DEADLINE_SECONDS));
  assert.ok(plan.deadline > chain.block.timestamp, 'deadline 必須晚於塊時間，不然鏈上就是已過期');
  assert.match(plan.rationale, /取塊時間/);
  assert.equal(chain.blockReads, 1);
});

test('R5 塊時間落後牆鐘 14 分鐘（稀疏挖礦）→ deadline 仍然在未來，不是已過期', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const chain = baseChain({ rate: RATE_WBNB_USDT });
  // 實測那筆：塊 132179976 的時間戳 09:54:57，而那筆 op 落地時新塊是 10:09:04 —— 塊時間比牆鐘舊
  // 14 分鐘。只用塊時間的話 deadline 就是「14 分鐘前 + deadlineSeconds」，簽下去就過期。
  const before = wallClockSeconds();
  chain.block.timestamp = before - 840n;
  const plan = expectReady(
    await planRebalance(argsOf(chain, { holdings, targets: targetsOf(WBNB, USDT), thresholdBps: 100 })),
  );
  const after = wallClockSeconds();

  assert.ok(plan.deadline > after, `deadline ${plan.deadline} 必須晚於牆鐘 ${after}：不然一送就 DeadlineExpired`);
  // 基準是牆鐘（牆鐘會走，所以是 before..after 的區間），不是那個已經過期的塊時間。
  const base = plan.deadline - BigInt(DEFAULT_DEADLINE_SECONDS);
  assert.ok(
    base >= before && base <= after,
    `deadline 基準 ${base} 必須是牆鐘（${before}..${after}），不是塊時間 ${chain.block.timestamp}`,
  );
  assert.notEqual(
    plan.deadline,
    chain.block.timestamp + BigInt(DEFAULT_DEADLINE_SECONDS),
    '不能是「塊時間 + 預設」：那正是那筆 DeadlineExpired 的算式',
  );
  assert.match(plan.rationale, /取牆鐘/);
  console.log(
    `[R5] 塊時間 ${chain.block.timestamp}（落後牆鐘 840s）、牆鐘 ${before}、` +
      `deadline ${plan.deadline}（基準 ${base}，相對塊時間 +${plan.deadline - chain.block.timestamp}s）`,
  );
});

test('R5 塊時間落後超過 deadline 長度 → 只有 max 救得回來（換什麼預設值都不夠）', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const chain = baseChain({ rate: RATE_WBNB_USDT });
  // 按需挖礦閒置兩小時：塊時間落在牆鐘之前 7200s，比 1800s 的預設還久。
  const before = wallClockSeconds();
  chain.block.timestamp = before - 7_200n;
  const plan = expectReady(
    await planRebalance(argsOf(chain, { holdings, targets: targetsOf(WBNB, USDT), thresholdBps: 100 })),
  );

  assert.ok(
    plan.deadline > before,
    `deadline ${plan.deadline} 必須在未來；舊算式會是 ${chain.block.timestamp + BigInt(DEFAULT_DEADLINE_SECONDS)}（已過期）`,
  );
});

test('R5 DEFAULT_DEADLINE_SECONDS = 1800（30 分鐘），仍遠低於 Permit2 的 30 天上限', () => {
  assert.equal(DEFAULT_DEADLINE_SECONDS, 1_800);
  assert.equal(MAX_DEADLINE_SECONDS, 2_592_000);
  assert.ok(DEFAULT_DEADLINE_SECONDS < MAX_DEADLINE_SECONDS);
});

test('R5 換一個塊時間，deadline 跟著換（可注入時鐘）；deadlineSeconds 可調', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const chain = baseChain({ rate: RATE_WBNB_USDT });
  // 塊時間放在牆鐘之後，牆鐘才不會把注入值蓋掉 —— 這一條驗的是「塊時間那一邊會傳進算式」。
  chain.block.timestamp = wallClockSeconds() + 7_200n;
  const args = argsOf(chain, {
    holdings,
    targets: targetsOf(WBNB, USDT),
    thresholdBps: 100,
    deadlineSeconds: 600,
  });

  const injectedTs = chain.block.timestamp + 1_000n;
  const injected = expectReady(await planRebalance(args, { blockTimestampSeconds: injectedTs }));
  assert.equal(injected.deadline, injectedTs + 600n);
  // 注入就完全不讀 getBlock。
  assert.equal(chain.blockReads, 0);

  const fromChain = expectReady(await planRebalance(args));
  assert.equal(fromChain.deadline, chain.block.timestamp + 600n);
  assert.notEqual(injected.deadline, fromChain.deadline);
});

test('R5 deadlineSeconds 邊界：0 或超過 30 天（Permit2）→ 拋錯；30 天整可以', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const chain = baseChain({ rate: RATE_WBNB_USDT });
  // 塊時間超前 → 基準就是塊時間，等式才驗得準（牆鐘贏的話 deadline 只會是「現在 + 30 天」）。
  chain.block.timestamp = wallClockSeconds() + 3_600n;
  const base = { holdings, targets: targetsOf(WBNB, USDT), thresholdBps: 100 };

  await assert.rejects(
    planRebalance(argsOf(chain, { ...base, deadlineSeconds: 0 })),
    /deadlineSeconds must be an integer in 1\.\.2592000/,
  );
  await assert.rejects(
    planRebalance(argsOf(chain, { ...base, deadlineSeconds: MAX_DEADLINE_SECONDS + 1 })),
    /deadlineSeconds must be an integer in 1\.\.2592000/,
  );
  const plan = expectReady(
    await planRebalance(argsOf(chain, { ...base, deadlineSeconds: MAX_DEADLINE_SECONDS })),
  );
  assert.equal(plan.deadline, chain.block.timestamp + BigInt(MAX_DEADLINE_SECONDS));
});

test('R5 getBlock 回傳另一塊 → 拋錯（時間與餘額不能來自不同時間點）', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const chain = baseChain();
  chain.block.number = 132_141_043n; // getBlock 回的是這一塊……
  await assert.rejects(
    planRebalance(
      argsOf(chain, {
        holdings,
        targets: targetsOf(WBNB, USDT),
        thresholdBps: 100,
        blockNumber: 132_141_042n, // ……但規劃釘的是這一塊
      }),
    ),
    /回傳了第 132141043 塊/,
  );
});

// ---------------------------------------------------------------- R6：commands / inputs / path

test('R6 commands 是單一 byte 0x00、inputs 只有一筆、recipient 是 executor', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const chain = baseChain({ rate: RATE_WBNB_USDT });
  const plan = expectReady(
    await planRebalance(argsOf(chain, { holdings, targets: targetsOf(WBNB, USDT), thresholdBps: 100 })),
  );

  const step = plan.steps[0];
  assert.ok(step !== undefined);
  assert.equal(pancakePayload(step).commands, V3_SWAP_EXACT_IN);
  assert.equal(pancakePayload(step).commands, '0x00');
  // packed bytes：0x + 2 個 hex 字元 = 一個 byte。帶 flag bit（例如 0x80）會被 CommandNotAllowed。
  assert.equal(pancakePayload(step).commands.length, 4);
  assert.equal(pancakePayload(step).inputs.length, 1);
  const decoded = decodeStepInput(step);
  // _checkRecipient 讀第 0 個 head word 的低 20 bytes，必須等於 executor。
  assert.equal(decoded.recipient, getAddress(EXECUTOR));
  assert.equal(decoded.amountIn, step.amountIn);
  assert.equal(decoded.amountOutMin, step.amountOutMin);
  assert.equal(decoded.payerIsUser, true);
});

test('R6 path 的 fee 來自池子（IPancakeV3Pool.fee()），不是寫死 500', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  for (const fee of [500, 2_500, 100]) {
    const chain = baseChain({ pool: { fee }, rate: RATE_WBNB_USDT });
    const plan = expectReady(
      await planRebalance(argsOf(chain, { holdings, targets: targetsOf(WBNB, USDT), thresholdBps: 100 })),
    );
    const step = plan.steps[0];
    assert.ok(step !== undefined);
    const decoded = decodeStepInput(step);
    // abi.encodePacked(tokenIn, uint24 fee, tokenOut)
    assert.equal(
      decoded.path,
      encodePacked(['address', 'uint24', 'address'], [getAddress(WBNB), fee, getAddress(USDT)]),
    );
    assert.equal(pathFee(decoded.path), fee);
    // 池子地址是從 oracle.pool() 讀的，fee() 是對那個池子問的。
    const poolCall = chain.calls.find((call) => call.functionName === 'fee');
    assert.ok(poolCall !== undefined);
    assert.equal(poolCall.address, WBNB_USDT_POOL.toLowerCase());
  }
});

test('R6 所有鏈上讀取都釘在同一個 blockNumber 上', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const chain = baseChain({ rate: RATE_WBNB_USDT });
  const plan = expectReady(
    await planRebalance(argsOf(chain, { holdings, targets: targetsOf(WBNB, USDT), thresholdBps: 100 })),
  );

  assert.ok(plan.steps.length > 0);
  assert.ok(chain.calls.length >= 5);
  for (const call of chain.calls) {
    assert.equal(call.blockNumber, chain.block.number, `${call.functionName} 沒有釘塊`);
  }
});

test('R3 amountIn 超過 uint160 上限 → blocked（合約會 revert AmountTooLarge）', async () => {
  // 合成的持倉：2^161 個最小單位（> uint160 上限）。真實代幣不會這樣，但「不可能」不該靠印象。
  const holdings = [holding(WBNB, 2n ** 161n, 18, PRICE_1000_USD)];
  const targets = targetsOf(WBNB, USDT);
  const drift = craftedDrift({
    totalUsdE8: 10n ** 46n,
    rows: [
      { asset: WBNB, targetBps: 5_000, currentBps: 15_000, usdValueE8: 10n ** 46n },
      { asset: USDT, targetBps: 5_000, currentBps: -5_000, usdValueE8: 0n },
    ],
  });
  const chain = baseChain();
  const plan = await planRebalance(
    argsOf(chain, { holdings, targets, drift, thresholdBps: 100 }),
  );

  assert.equal(plan.kind, 'blocked');
  if (plan.kind !== 'blocked') throw new Error('unreachable');
  assert.match(plan.reason, /uint160/);
  assert.match(plan.reason, /AmountTooLarge/);
  // 擋在鏈上讀取之前：這種輸入不值得再問 oracle。
  assert.equal(chain.calls.length, 0);
});

// ---------------------------------------------------------------- 大數字不溢位

test('大數字：金額走 bigint，超過 Number.MAX_SAFE_INTEGER 也不失真', async () => {
  // 天文數字投組：total $1e22、超配 1000 bps → 要搬 $1e21 → 1e21×1e18/1e11 = 1e28 wei。
  const holdings = [holding(WBNB, 10n ** 38n, 18, PRICE_1000_USD)];
  const targets = targetsOf(WBNB, USDT);
  const drift = craftedDrift({
    totalUsdE8: 10n ** 30n,
    rows: [
      { asset: WBNB, targetBps: 5_500, currentBps: 6_500, usdValueE8: 10n ** 30n },
      { asset: USDT, targetBps: 4_500, currentBps: 3_500, usdValueE8: 0n },
    ],
  });
  const chain = baseChain({ rate: RATE_WBNB_USDT });
  const plan = expectReady(
    await planRebalance(argsOf(chain, { holdings, targets, drift, thresholdBps: 100 })),
  );

  const step = plan.steps[0];
  assert.ok(step !== undefined);
  assert.equal(step.amountIn, 10n ** 29n * 10n ** 18n / 10n ** 11n);
  assert.equal(step.amountIn, 10n ** 36n);
  assert.ok(step.amountIn > BigInt(Number.MAX_SAFE_INTEGER));
  // The quote-bound minimum is 99.95% (pool fee) × 99.5% (route tolerance).
  assert.equal(step.amountOutMin, 9_945_025n*10n**32n);
});

test('大數字：minGross 在 1e30 這個量級仍然精確（用 bigint 比較，不經 Number）', () => {
  const floor = 10n ** 30n;
  const minGross = minGrossFor(floor, 25);
  assert.equal(minGross, 10n ** 30n + (10n ** 30n * 25n + 9_974n) / 9_975n);
  assert.ok(minGross > BigInt(Number.MAX_SAFE_INTEGER));
  assert.ok(minGross >= floor);
});

// ---------------------------------------------------------------- 「永不回空 steps」的整體掃描

test('永不回空 steps：noop / blocked 都沒有 steps 欄位，ready 一定 >= 1 步', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const targets = targetsOf(WBNB, USDT);

  const plans: RebalancePlan[] = [
    // noop：未達門檻
    await planRebalance(
      argsOf(baseChain(), {
        holdings: [
          holding(WBNB, 500_000_000_000_000_000n, 18, PRICE_1000_USD),
          holding(USDT, 500_000_000_000_000_000_000n, 18, PRICE_1_USD),
        ],
        targets,
        thresholdBps: 100,
      }),
    ),
    // noop：空倉
    await planRebalance(argsOf(baseChain(), { holdings: [], targets, thresholdBps: 100 })),
    // blocked：3 個資產
    await planRebalance(
      argsOf(baseChain(), {
        holdings,
        targets: [
          { asset: WBNB, weightBps: 3_400 },
          { asset: USDT, weightBps: 3_300 },
          { asset: TOKEN3, weightBps: 3_300 },
        ],
        thresholdBps: 100,
      }),
    ),
    // blocked：pair 不對
    await planRebalance(argsOf(baseChain(), { holdings, targets: targetsOf(WBNB, TOKEN3), thresholdBps: 100 })),
    // ready
    await planRebalance(argsOf(baseChain({ rate: RATE_WBNB_USDT }), { holdings, targets, thresholdBps: 100 })),
  ];

  assert.deepEqual(
    plans.map((plan) => plan.kind),
    ['noop', 'noop', 'blocked', 'blocked', 'ready'],
  );
  for (const plan of plans) {
    if (plan.kind === 'ready') {
      assert.ok(plan.steps.length >= 1, 'ready 必須至少一步');
    } else {
      assert.equal('steps' in plan, false, `${plan.kind} 不該帶 steps`);
    }
  }
});

// ---------------------------------------------------------------- hub 模式：N 資產、USDT 為中央

test('#24 自動補入 0 權重 USDT：純存款視為超配，規劃買入兩個目標資產', async () => {
  const allocation = validateAllocation({ assets: [
    { address: WBNB, weightBps: 5000 },
    { address: TOKEN3, weightBps: 5000 },
  ] });
  const targets = allocation.assets.map(({ address, weightBps }) => ({ asset: address as Address, weightBps }));
  const holdings = [holding(USDT, 200n * 10n ** 18n, 18, PRICE_1_USD)];
  const drift = computeDrift(holdings, targets, 100);
  assert.equal(drift.assets.find((row) => row.asset.toLowerCase() === USDT)?.deltaBps, 10_000);
  const chain = hubChain({ quotes: {
    [`${USDT}:${WBNB}`]: { minimum: 99n * 10n ** 15n },
    [`${USDT}:${TOKEN3}`]: { minimum: 99n * 10n ** 18n },
  } });
  const plan = expectReady(await planRebalance(hubArgs(chain, { holdings, targets, thresholdBps: 100 })));
  assert.equal(plan.steps.length, 2);
  assert.deepEqual(plan.steps.map((step) => step.tokenOut), [getAddress(WBNB), getAddress(TOKEN3)]);
  for (const step of plan.steps) {
    assert.equal(step.tokenIn, getAddress(USDT));
    assert.equal(step.amountIn, 100n * 10n ** 18n);
  }
});

test('H1 3 資產手算：40/30/30 vs 實際 60/20/20 → 賣 0.2 WBNB、買 100 USDT 的 NVDAB', async () => {
  // 手算（全部整數，1e8 定點 USD）：
  //   WBNB 0.6e18 @ $1000 → 6e17×1e11/1e18 = 6e10（$600）；NVDAB 200e18 @ $1 → 2e10；USDT 200e18 → 2e10
  //   total 1e11（$1000）；currentBps 6000/2000/2000、targetBps 4000/3000/3000 → Δ +2000/−1000/−1000
  //   WBNB：targetUsd = ceil(4000×1e11/1e4) = 4e10 → deltaUsd +2e10 → amountIn = 2e10×1e18/1e11 = 2e17
  //   NVDAB：targetUsd = 3e10 → deltaUsd −1e10 → 付 1e10×1e18/1e8 = 1e20 USDT（100 顆）
  //   順序：賣（WBNB）在前、買（NVDAB）在後；USDT 是 hub，自己不產生 step。
  const { holdings, targets } = threeAssetCase();
  const drift = computeDrift(holdings, targets, 100);
  assert.equal(drift.totalUsdE8, 100_000_000_000n);
  assert.deepEqual(
    drift.assets.map((row) => row.deltaBps),
    [2_000, -1_000, -1_000],
  );

  const chain = hubChain({
    feeBps: 25,
    quotes: {
      [`${WBNB}:${USDT}`]: { minimum: 137_000_000_000_000_000_000n }, // 賣 0.2 WBNB 的地板 = 137 USDT
      [`${USDT}:${TOKEN3}`]: { minimum: 99_000_000_000_000_000_000n }, // 付 100 USDT 的地板 = 99 NVDAB
    },
  });
  // 塊時間超前牆鐘 → 基準是塊時間，deadline 的等式才驗得準（hub 與 pinned 共用同一條 max 規則）。
  chain.block.timestamp = wallClockSeconds() + 3_600n;
  const plan = expectReady(
    await planRebalance(hubArgs(chain, { holdings, targets, thresholdBps: 100 })),
  );

  assert.equal(plan.steps.length, 2);
  const [sell, buy] = plan.steps;
  assert.ok(sell !== undefined && buy !== undefined);

  // step 0：賣 WBNB 換 USDT
  assert.equal(sell.tokenIn, getAddress(WBNB));
  assert.equal(sell.tokenOut, getAddress(USDT));
  assert.equal(sell.amountIn, 200_000_000_000_000_000n); // 0.2 WBNB，手算值
  assert.equal(sell.oracleFloor, 137_000_000_000_000_000_000n);
  assert.equal(sell.amountOutMin, amountOutMinWithBuffer(minGrossFor(137_000_000_000_000_000_000n, 25)));
  // 獨立算式：minGross = floor + ceil(floor×fee/(10000−fee))
  assert.equal(sell.amountOutMin, amountOutMinWithBuffer(137_000_000_000_000_000_000n + (137_000_000_000_000_000_000n * 25n + 9_974n) / 9_975n));
  assert.equal(decodeStepInput(sell).amountOutMin, sell.amountOutMin);
  assert.equal(pathFee(decodeStepInput(sell).path), 500); // WBNB/USDT 池的 fee

  // step 1：買 NVDAB，付 USDT
  assert.equal(buy.tokenIn, getAddress(USDT));
  assert.equal(buy.tokenOut, getAddress(TOKEN3));
  assert.equal(buy.amountIn, 100_000_000_000_000_000_000n); // 100 USDT（18 位小數）
  assert.equal(buy.oracleFloor, 99_000_000_000_000_000_000n);
  assert.equal(buy.amountOutMin, amountOutMinWithBuffer(minGrossFor(99_000_000_000_000_000_000n, 25)));
  assert.equal(pathFee(decodeStepInput(buy).path), 2_500); // NVDAB/USDT 池的 fee（逐池讀，不是寫死）

  // 每一步的 recipient 都是 executorMultiPool，payerIsUser = true（幣從 executor 付出去）。
  for (const step of plan.steps) {
    const decoded = decodeStepInput(step);
    assert.equal(decoded.recipient, getAddress(EXECUTOR_MULTI));
    assert.equal(decoded.payerIsUser, true);
    assert.equal(decoded.amountIn, step.amountIn);
    assert.equal(pancakePayload(step).commands, V3_SWAP_EXACT_IN);
  }
  assert.equal(plan.deadline, chain.block.timestamp + BigInt(DEFAULT_DEADLINE_SECONDS));

  // USDT 預算：賣出保證淨額 = floor − floor×fee/10000，逐筆加總。
  const sellNet = 137_000_000_000_000_000_000n - (137_000_000_000_000_000_000n * 25n) / 10_000n;
  assert.match(plan.rationale, /hub 模式/);
  assert.match(plan.rationale, new RegExp(`賣出保證淨額 ${sellNet}`));
  assert.match(plan.rationale, /實際付出 100000000000000000000/);
  assert.match(plan.rationale, /沒有任何步驟被跳過/);
  // 只問了兩筆報價：賣 WBNB、買 NVDAB（USDT 是 hub，不對自己報價）。
  assert.equal(chain.calls.filter((call) => call.functionName === 'previewSwap').length, 2);
});

test('H2 先賣後買：所有賣的 index 都小於所有買的 index（4 資產 2 賣 1 買）', async () => {
  // 手算：WBNB 0.4@$1000=$400（4000）、TOKEN6 350 顆@$1=$350（3500）、NVDAB 100（1000）、USDT 150（1500）
  //   total $1000；targetBps 3000/3000/2000/2000 → Δ +1000/+500/−1000/−500
  //   賣 WBNB：deltaUsd = 4e10 − 3e10 = 1e10 → 1e17 wei；賣 TOKEN6：3.5e10 − 3e10 = 5e9 → 5e7（50 顆，6 位）
  //   買 NVDAB：1e10 − 2e10 = −1e10 → 付 1e20 USDT
  const holdings = [
    holding(WBNB, 400_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(TOKEN6, 350_000_000n, 6, PRICE_1_USD),
    holding(TOKEN3, 100_000_000_000_000_000_000n, 18, PRICE_1_USD),
    holding(USDT, 150_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const targets: TargetWeight[] = [
    { asset: WBNB, weightBps: 3_000 },
    { asset: TOKEN6, weightBps: 3_000 },
    { asset: TOKEN3, weightBps: 2_000 },
    { asset: USDT, weightBps: 2_000 },
  ];
  const drift = computeDrift(holdings, targets, 100);
  assert.deepEqual(
    drift.assets.map((row) => row.deltaBps),
    [1_000, 500, -1_000, -500],
  );

  const chain = hubChain({
    quotes: {
      [`${WBNB}:${USDT}`]: { minimum: 69_000_000_000_000_000_000n },
      [`${TOKEN6}:${USDT}`]: { minimum: 49_000_000_000_000_000_000n },
      [`${USDT}:${TOKEN3}`]: { minimum: 99_000_000_000_000_000_000n },
    },
  });
  const plan = expectReady(
    await planRebalance(hubArgs(chain, { holdings, targets, thresholdBps: 100 })),
  );

  assert.equal(plan.steps.length, 3);
  const sellIndexes = plan.steps
    .map((step, index) => (step.tokenIn.toLowerCase() === USDT.toLowerCase() ? -1 : index))
    .filter((index) => index >= 0);
  const buyIndexes = plan.steps
    .map((step, index) => (step.tokenIn.toLowerCase() === USDT.toLowerCase() ? index : -1))
    .filter((index) => index >= 0);
  // 賣必須全部排在買之前：executor 逐 step 從帳戶拉 tokenIn，買的 USDT 只來自前面的賣。
  assert.deepEqual(sellIndexes, [0, 1]);
  assert.deepEqual(buyIndexes, [2]);
  assert.ok(Math.max(...sellIndexes) < Math.min(...buyIndexes));
  assert.equal(plan.steps[0]?.amountIn, 100_000_000_000_000_000n); // 0.1 WBNB
  assert.equal(plan.steps[1]?.amountIn, 50_000_000n); // 50 顆 TOKEN6（6 位小數）
  assert.equal(plan.steps[2]?.amountIn, 100_000_000_000_000_000_000n); // 100 USDT
});

test('H3 targets 不含 numeraire → blocked（執行器只換 version.assets 裡的代幣）', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(TOKEN3, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  // 兩個目標資產都沒有 USDT：賣 WBNB 換來的 USDT 沒有落點，買 NVDAB 也付不出 USDT。
  const targets = targetsOf(WBNB, TOKEN3);
  const chain = hubChain({
    quotes: { [`${WBNB}:${USDT}`]: { minimum: 69_000_000_000_000_000_000n } },
  });
  const plan = await planRebalance(hubArgs(chain, { holdings, targets, thresholdBps: 100 }));

  assert.equal(plan.kind, 'blocked');
  if (plan.kind !== 'blocked') throw new Error('unreachable');
  assert.match(plan.reason, /numeraire/);
  assert.match(plan.reason, /version\.assets/);
  assert.match(plan.reason, /AssetNotAllowed/);
  assert.equal('steps' in plan, false);
  // 連報價都不該問：hub 不在策略資產裡是結構問題，不是市場問題。
  assert.equal(chain.calls.some((call) => call.functionName === 'previewSwap'), false);
});

test('H4 某個資產沒有註冊 oracle → 跳過那一步並記在 rationale，其他 step 照走', async () => {
  const { holdings, targets } = threeAssetCase();
  // 只註冊 WBNB：NVDAB 的 `oracleOf` 回零地址（真的 router 會 revert OracleNotSet）。
  const chain = hubChain({
    pairs: { [WBNB.toLowerCase()]: { oracle: ORACLE_WBNB_USDT, pool: WBNB_USDT_POOL, fee: 500 } },
    quotes: { [`${WBNB}:${USDT}`]: { minimum: 137_000_000_000_000_000_000n } },
  });
  const plan = expectReady(
    await planRebalance(hubArgs(chain, { holdings, targets, thresholdBps: 100 })),
  );

  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]?.tokenIn, getAddress(WBNB));
  assert.match(plan.rationale, /被跳過 1 筆/);
  assert.match(plan.rationale, /OracleNotSet/);
  assert.match(plan.rationale, /跳過/);
  // 跳過的那一步不會貢獻 USDT 預算：沒有買的 step，因為 NVDAB 根本報不出價。
  assert.equal(plan.steps.some((step) => step.tokenIn.toLowerCase() === USDT.toLowerCase()), false);
});

test('H5 全部步驟都被跳過 → noop（永不回空的 steps）', async () => {
  const { holdings, targets } = threeAssetCase();
  const chain = hubChain({ pairs: {}, quotes: {} });
  const plan = await planRebalance(hubArgs(chain, { holdings, targets, thresholdBps: 100 }));

  assert.equal(plan.kind, 'noop');
  if (plan.kind !== 'noop') throw new Error('unreachable');
  assert.match(plan.reason, /produced no executable step/);
  assert.match(plan.reason, /OracleNotSet/);
  assert.equal('steps' in plan, false);
});

test('H6 買的 USDT 預算 ≤ 現有持倉 + 前面賣出的保證淨額（不夠就夾到）', async () => {
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD), // $600
    holding(TOKEN3, 200_000_000_000_000_000_000n, 18, PRICE_1_USD), // $200
    holding(USDT, 0n, 18, PRICE_1_USD), // 手上 0 USDT：買的錢只能來自賣
  ];
  const targets: TargetWeight[] = [
    { asset: WBNB, weightBps: 1_000 },
    { asset: TOKEN3, weightBps: 5_000 },
    { asset: USDT, weightBps: 4_000 },
  ];
  const drift = craftedDrift({
    totalUsdE8: 100_000_000_000n,
    rows: [
      { asset: WBNB, targetBps: 1_000, currentBps: 6_000, usdValueE8: 60_000_000_000n },
      { asset: TOKEN3, targetBps: 5_000, currentBps: 2_000, usdValueE8: 20_000_000_000n },
      { asset: USDT, targetBps: 4_000, currentBps: 2_000, usdValueE8: 20_000_000_000n },
    ],
  });
  const chain = hubChain({
    quotes: {
      [`${WBNB}:${USDT}`]: { minimum: 137_000_000_000_000_000_000n },
      [`${USDT}:${TOKEN3}`]: { minimum: 135_000_000_000_000_000_000n },
    },
  });
  const plan = expectReady(
    await planRebalance(hubArgs(chain, { holdings, targets, drift, thresholdBps: 100 })),
  );

  // 賣 WBNB：deltaUsd = 6e10 − ceil(1000×1e11/1e4) = 5e10 → 5e10×1e18/1e11 = 5e17 wei = 0.5 顆
  assert.equal(plan.steps[0]?.tokenIn, getAddress(WBNB));
  assert.equal(plan.steps[0]?.amountIn, 500_000_000_000_000_000n);
  // 買 NVDAB：想付 3e10 → 3e20 USDT，但預算只有 0（持倉）+ 1.37e20（賣出的 floor）→ 夾到 1.37e20
  const buy = plan.steps[1];
  assert.ok(buy !== undefined);
  assert.equal(buy.tokenIn, getAddress(USDT));
  assert.equal(buy.amountIn, 137_000_000_000_000_000_000n);
  assert.ok(buy.amountIn <= (plan.steps[0]?.oracleFloor ?? 0n)); // 預算上界就是賣出的保證量（fee 0）
  assert.match(plan.rationale, /USDT 預算/);
  assert.match(plan.rationale, /夾取：依漂移算出 300000000000000000000/);
});

test('H7 hub 模式：賣的量超過持倉 → 夾到持倉，並在 rationale 說明', async () => {
  // 刻意不一致的 drift（total $2000，帳戶只有 1 顆 $1000 的 WBNB）：夾取是唯一防線，
  // 因為「多賣」在合約層完全合法（合約只驗 amountOutMin 下限）。
  const holdings = [
    holding(WBNB, 1_000_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(TOKEN3, 0n, 18, PRICE_1_USD),
    holding(USDT, 0n, 18, PRICE_1_USD),
  ];
  const targets: TargetWeight[] = [
    { asset: WBNB, weightBps: 1_000 },
    { asset: TOKEN3, weightBps: 5_000 },
    { asset: USDT, weightBps: 4_000 },
  ];
  const drift = craftedDrift({
    totalUsdE8: 200_000_000_000n, // $2000
    rows: [
      { asset: WBNB, targetBps: 1_000, currentBps: 15_000, usdValueE8: 200_000_000_000n },
      { asset: TOKEN3, targetBps: 5_000, currentBps: -5_000, usdValueE8: 0n },
      { asset: USDT, targetBps: 4_000, currentBps: -10_000, usdValueE8: 0n },
    ],
  });
  const chain = hubChain({
    quotes: {
      [`${WBNB}:${USDT}`]: { minimum: 688_000_000_000_000_000_000n },
      [`${USDT}:${TOKEN3}`]: { minimum: 1_000_000_000_000_000_000n },
    },
  });
  const plan = expectReady(
    await planRebalance(hubArgs(chain, { holdings, targets, drift, thresholdBps: 100 })),
  );

  // deltaUsd = 2e11 − ceil(1000×2e11/1e4) = 1.8e11 → 1.8e18 wei，持倉只有 1e18 → 夾到 1e18。
  assert.equal(plan.steps[0]?.amountIn, 1_000_000_000_000_000_000n);
  assert.match(plan.rationale, /夾取：依漂移算出 1800000000000000000/);
});

test('H8 2 資產（WBNB/USDT 60-40）在 hub 模式與 pinned 模式算出同一個 amountIn', async () => {
  // 既有 2 資產行為不變：同一個投組、同一個塊，兩種 oracle 形狀都要得到 0.1 WBNB。
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD),
  ];
  const targets = targetsOf(WBNB, USDT);

  const pinned = expectReady(
    await planRebalance(argsOf(baseChain({ rate: RATE_WBNB_USDT }), { holdings, targets, thresholdBps: 100 })),
  );
  const hub = expectReady(
    await planRebalance(
      hubArgs(hubChain({ quotes: { [`${WBNB}:${USDT}`]: { minimum: 69_000_000_000_000_000_000n } } }), {
        holdings,
        targets,
        thresholdBps: 100,
      }),
    ),
  );

  assert.equal(pinned.steps.length, 1);
  assert.equal(hub.steps.length, 1); // USDT 是 hub：只有 WBNB 那一邊產生 step
  assert.equal(hub.steps[0]?.tokenIn, pinned.steps[0]?.tokenIn);
  assert.equal(hub.steps[0]?.tokenOut, pinned.steps[0]?.tokenOut);
  assert.equal(hub.steps[0]?.amountIn, pinned.steps[0]?.amountIn);
  assert.equal(hub.steps[0]?.amountIn, 100_000_000_000_000_000n);
});

test('H9 hub 模式：判不出 oracle 形狀 → blocked（不猜、不送）', async () => {
  const { holdings, targets } = threeAssetCase();
  const chain = baseChain();
  // 一個「pool() 會 revert、也沒有 numeraire()」的 oracle：兩個形狀都不像。
  chain.oracle = { ...chain.oracle };
  const broken = {
    ...chain,
    calls: [] as ChainCall[],
    blockReads: 0,
  };
  const client = {
    getBlock: async () => ({ number: broken.block.number, timestamp: broken.block.timestamp, hash: '0x', transactions: [] }),
    readContract: async (args: { functionName: string }) => {
      broken.calls.push({ functionName: args.functionName, address: '0x0' });
      throw new Error('execution reverted');
    },
  };
  const plan = await planRebalance({
    ...hubArgs(chain, { holdings, targets, thresholdBps: 100 }),
    publicClient: client as unknown as PublicClient,
  });

  assert.equal(plan.kind, 'blocked');
  if (plan.kind !== 'blocked') throw new Error('unreachable');
  assert.match(plan.reason, /cannot tell which pairs/);
  assert.equal('steps' in plan, false);
});

// ---------------------------------------------------------------- 價格衝擊上限（拆單）

/** Q64.96：√P = 1 的那個定點值。 */
const SQRT_PRICE_ONE = 2n ** 96n;
/**
 * 池子（token0 = USDT、token1 = WBNB）在 **1 WBNB = 1000 USDT** 時的 `sqrtPriceX96`。
 * raw 價格是 token1/token0 = 1e-3（兩個都是 18 位小數），所以 `√P × 2^96 = 2^96 / √1000`。
 * 整數截斷的相對誤差 ~1e-10 ⇒ 0 bps，估價容得下。
 *
 * 為什麼需要它：DB 價格（`usdPriceE8`）與池子報價必須是同一個價，否則「執行後預估漂移」量到的是
 * 「價格表 vs 池子」的差，不是這次再平衡的效果。
 */
const SQRT_PRICE_WBNB_1000 = (SQRT_PRICE_ONE * 10n ** 9n) / 31_622_776_601n;

/** 一個「價格 = 1、流動性 = liquidity、沒有 fee」的池子狀態。兩邊都是 18 位小數，所以 raw 比值就是價格。 */
function unitPool(liquidity: bigint, tokenInIsToken0 = true): PoolImpactState {
  return { sqrtPriceX96: SQRT_PRICE_ONE, liquidity, tokenInIsToken0, feeUnits: 0 };
}

test('impact 手算：L=1e18、√P=1、賣 1e15 → 到手 999000999000999、impact 9 bps、priceMove 約 2 倍', () => {
  const state = unitPool(10n ** 18n);
  const amountIn = 10n ** 15n;
  const estimate = estimateImpact(state, amountIn, amountIn); // TWAP 價 = 現貨價 = 1 → quoted = amountIn

  // 手算：S₁ = S·L·Q/(L·Q + x·S) = Q/1.001；out = L(S−S₁)/Q = 1e18·(1 − 1/1.001) = 999000999000999.000…
  assert.equal(estimate.estimatedOut, 999_000_999_000_999n);
  // impact = (1e15 − 999000999000999) / 1e15 = 9.99e-4 → 9 bps（向下截斷，偏保守那一側）
  assert.equal(estimate.impactBps, 9);
  // 現貨＝TWAP 且 fee = 0 → baseline 是 0（與量無關的那一項不存在）
  assert.equal(estimate.baselineBps, 0);
  // 價格空間那條公式 ≈ 到手量空間的 2 倍：到手價是幾何平均 √(P₀P₁)，價格移動的一半。
  assert.equal(estimate.priceMoveBps, 19);
});

test('impact 手算：token1 進的方向對稱（同一組數字），priceMove 仍約 2×', () => {
  const estimate = estimateImpact(unitPool(10n ** 18n, false), 10n ** 15n, 10n ** 15n);
  assert.equal(estimate.estimatedOut, 999_000_999_000_999n);
  assert.equal(estimate.impactBps, 9);
  assert.equal(estimate.priceMoveBps, 20);
});

test('impact baseline 與量無關：現貨比 TWAP 低 199 bps 時，量從 1e15 到 1e18 都是 199 bps', () => {
  const liquidity = 10n ** 18n;
  const state: PoolImpactState = {
    sqrtPriceX96: (SQRT_PRICE_ONE * 99n) / 100n, // P = 0.9801 → 比 TWAP 低 199 bps
    liquidity,
    tokenInIsToken0: true,
    feeUnits: 0,
  };
  assert.equal(estimateImpact(state, 10n ** 15n, 10n ** 15n).baselineBps, 199);
  assert.equal(estimateImpact(state, 10n ** 18n, 10n ** 18n).baselineBps, 199);

  // 方向很重要：賣 token1 換 token0 時到手量 ∝ 1/P，所以同一個「現貨比 TWAP 低」對它是**有利**的
  // （baseline 0），而「現貨比 TWAP 高 2.01%」才是不利的那一側（197 bps）。
  const favored: PoolImpactState = { ...state, tokenInIsToken0: false };
  assert.equal(estimateImpact(favored, 10n ** 15n, 10n ** 15n).baselineBps, 0);
  const penalized: PoolImpactState = { ...favored, sqrtPriceX96: (SQRT_PRICE_ONE * 101n) / 100n };
  assert.equal(estimateImpact(penalized, 10n ** 15n, 10n ** 15n).baselineBps, 197);
});

test('capAmountInForImpact：超標 → 縮到剛好 ≤ 預算；再加 1 個最小單位就超標（是最大可行量）', () => {
  const state = unitPool(10n ** 18n);
  const ideal = 10n ** 18n;
  const cap = capAmountInForImpact({ state, idealAmountIn: ideal, idealQuoted: ideal, maxImpactBps: 50 });

  assert.equal(cap.shrunk, true);
  assert.equal(cap.noSizeFits, false);
  assert.ok(cap.idealEstimate.impactBps > 50, `理想量的衝擊要超過預算（實際 ${cap.idealEstimate.impactBps}）`);
  assert.ok(cap.estimate.impactBps <= 50, `縮小之後的衝擊必須 ≤ 預算（實際 ${cap.estimate.impactBps}）`);
  assert.ok(
    estimateImpact(state, cap.amountIn + 1n, cap.amountIn + 1n).impactBps > 50,
    '再多 1 個最小單位就要超標 —— 證明這是最大可行量，不是隨便取一個小一點的數',
  );
  // 手算：impact = a/(a+L) = 50 bps → a = 5L/995 ≈ 5.025e15（截斷到 50 bps 會多放寬 ~2%）。
  assert.ok(cap.amountIn > 5n * 10n ** 15n, `要接近手算的 5.025e15（實際 ${cap.amountIn}）`);
  assert.ok(cap.amountIn < 52n * 10n ** 14n, `不該超過手算值太多（實際 ${cap.amountIn}）`);
});

test('capAmountInForImpact：未超預算時一個位都不動（回歸的核心）', () => {
  const state = unitPool(10n ** 30n); // 深池子：1e17 的衝擊接近 0
  const ideal = 10n ** 17n;
  const cap = capAmountInForImpact({ state, idealAmountIn: ideal, idealQuoted: ideal, maxImpactBps: 50 });
  assert.equal(cap.shrunk, false);
  assert.equal(cap.amountIn, ideal);
  assert.equal(cap.estimate.impactBps, cap.idealEstimate.impactBps);
});

test('capAmountInForImpact：dust 量不會被整數截斷誤判成 10000 bps（真鏈上踩到的 bug）', () => {
  // fee 25 bps、現貨 == TWAP → baseline 只有手續費，任何小的量都應該在 50 bps 預算內。
  // 修正前：`estimatedOut` 在 1 個最小單位上被截斷成 0 → 比率算成 10000 bps → 誤判 noSizeFits，
  // 整條 leg 被丟掉（真鏈上就是這樣把一筆 $166k 的買單整個跳過的）。
  const state: PoolImpactState = {
    sqrtPriceX96: SQRT_PRICE_ONE,
    liquidity: 10n ** 18n,
    tokenInIsToken0: false,
    feeUnits: 2_500,
  };
  const ideal = 10n ** 23n;
  const cap = capAmountInForImpact({ state, idealAmountIn: ideal, idealQuoted: ideal, maxImpactBps: 50 });
  assert.equal(cap.idealEstimate.baselineBps, 25, 'baseline 就是池子 fee');
  assert.equal(cap.noSizeFits, false, '25 bps 的 baseline 一定有可行的量');
  assert.ok(cap.amountIn > 0n);
  assert.ok(cap.estimate.impactBps <= 50);
  // 手算：impact(a) = 1 − (1−fee)/(1 + a/L) → 50 bps ⇔ 1 + a/L = 0.9975/0.995 ⇔ a ≈ 2.51e15
  assert.ok(cap.amountIn > 2n * 10n ** 15n && cap.amountIn < 3n * 10n ** 15n, `實際 ${cap.amountIn}`);
});

test('capAmountInForImpact：連 1 個最小單位都超預算 → noSizeFits（是 baseline 的問題，不是量的問題）', () => {
  const state: PoolImpactState = {
    sqrtPriceX96: (SQRT_PRICE_ONE * 99n) / 100n,
    liquidity: 10n ** 18n,
    tokenInIsToken0: true,
    feeUnits: 0,
  };
  const cap = capAmountInForImpact({ state, idealAmountIn: 10n ** 17n, idealQuoted: 10n ** 17n, maxImpactBps: 50 });
  assert.equal(cap.noSizeFits, true);
  assert.equal(cap.amountIn, 0n);
  assert.equal(cap.idealEstimate.baselineBps, 199);
});

/** 2 資產的 pinned 情境 + 一個可以指定流動性／現貨價的池子（預設按量計價、滑價 1%）。 */
function impactChain(options: {
  liquidity: bigint;
  sqrtPriceX96?: bigint;
  feeUnits?: number;
  slippageBps?: number;
  /**
   * 「1 個 tokenIn 的 wei 換幾個 tokenOut 的 wei」。預設 1:1，與 `SQRT_PRICE_ONE` 的現貨價一致；
   * 要讓「執行後的預估漂移」有意義就得跟 DB 價格一致（估價用的是 holdings 的 usdPriceE8）。
   */
  rateE18?: bigint;
}): StubChain {
  const chain = baseChain({ pool: { fee: options.feeUnits ?? 0 } });
  chain.poolState = {
    sqrtPriceX96: options.sqrtPriceX96 ?? SQRT_PRICE_ONE,
    liquidity: options.liquidity,
    token0: USDT,
  };
  chain.rate = { rateE18: options.rateE18 ?? 10n ** 18n, slippageBps: options.slippageBps ?? 100 };
  return chain;
}

/** pinned 情境的持倉：WBNB 超配，賣方是 WBNB（pool 的 token1）。 */
function pinnedHoldings(): Holding[] {
  return [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD), // $600
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD), // $400
  ];
}

test('pinned：理想量超過預算 → step 被縮小、impact ≤ 預算、partial 有記錄、rationale 標「部分執行」', async () => {
  const chain = impactChain({ liquidity: 10n ** 18n });
  const plan = expectReady(
    await planRebalance(argsOf(chain, {
      maxImpactBps: 50, holdings: pinnedHoldings(), targets: targetsOf(WBNB, USDT), thresholdBps: 100 })),
  );
  const step = plan.steps[0];
  assert.ok(step !== undefined);
  const ideal = 100_000_000_000_000_000n; // 0.1 顆 WBNB（$600 超配 5000 bps 的一半）
  assert.ok(step.amountIn < ideal, `要被縮小（實際 ${step.amountIn}）`);
  assert.ok(step.amountIn > 0n);

  // partial 是**結構化**訊號，排程器靠它決定提早再跑。
  assert.ok(plan.partial !== undefined, 'ready 要帶 partial');
  // 判準是**執行後的預估漂移**（不是「有沒有被縮」）：只賣了一小塊，當然還在門檻之上。
  assert.ok(
    (plan.partial?.remainingDriftBps ?? 0) >= 100,
    `執行後預估漂移 ${plan.partial?.remainingDriftBps} 必須仍 ≥ 門檻 100`,
  );
  const shrunk = plan.partial?.shrunk[0];
  assert.ok(shrunk !== undefined);
  assert.equal(shrunk.index, 0);
  assert.equal(shrunk.idealAmountIn, ideal);
  assert.equal(shrunk.amountIn, step.amountIn);
  assert.ok(shrunk.idealImpactBps > DEFAULT_MAX_IMPACT_BPS);
  assert.ok(shrunk.impactBps <= DEFAULT_MAX_IMPACT_BPS, `縮小後 impact ${shrunk.impactBps} 必須 ≤ 預算`);

  // 地板是**縮小後的量**重問回來的（同一批裡換一個量就是另一個地板）。
  assert.equal(step.oracleFloor, (step.amountIn * 9_900n + 9_999n) / 10_000n);
  assert.equal(step.amountOutMin, quoteBoundMinimum(amountOutMinWithBuffer((step.amountIn*9950n+9999n)/10000n),step.amountIn));
  assert.equal(step.costBudgetBps,50);
  // 兩次報價：理想量一次、縮小後再一次。
  assert.equal(chain.calls.filter((call) => call.functionName === 'previewSwap').length, 2);

  assert.match(plan.rationale, /⚠ partial execution/);
  assert.match(plan.rationale, /rest goes to the next round/);
  // 這一條測的是「預算怎麼作用」，所以預算要**明確給**，不要依賴預設值（預設改了不該讓它變義意）。
  assert.match(plan.rationale, /exceeds the 50 bps budget/);
});

test('pinned：沒超過預算 → 鏈上 calldata 相同，保留成本預算供送出前刷新', async () => {
  // 報價與 DB 價格一致（1 WBNB = $1000）：執行後的預估漂移才有意義（賣對了就收斂）。
  const deep = () =>
    impactChain({ liquidity: 10n ** 30n, sqrtPriceX96: SQRT_PRICE_WBNB_1000, rateE18: 1_000n * 10n ** 18n });
  const on = expectReady(
    await planRebalance(argsOf(deep(), { holdings: pinnedHoldings(), targets: targetsOf(WBNB, USDT), thresholdBps: 100 })),
  );
  const off = expectReady(
    await planRebalance(
      argsOf(deep(), { holdings: pinnedHoldings(), targets: targetsOf(WBNB, USDT), thresholdBps: 100 , maxImpactBps: null }),
    ),
  );
  assert.deepEqual(on.steps, off.steps.map(step=>({...step,costBudgetBps:80})), 'chain fields remain identical; enabled policy retains its budget');
  assert.equal(on.deadline, off.deadline);
  // 判準是結果：賣對了就收斂，所以沒有 partial（不是「沒被縮小」，那是舊定義）。
  assert.equal(on.partial, undefined, '執行後收斂就不該帶 partial');
  assert.match(on.rationale, /converged/);
  assert.doesNotMatch(on.rationale, /partial execution/);
  // 而且真的沒有縮：量就是理想量。
  assert.equal(on.steps[0]?.amountIn, 100_000_000_000_000_000n);
});

test('pinned：maxImpactBps: null → 池子狀態一次都不讀（完全回到舊行為）', async () => {
  const chain = impactChain({ liquidity: 10n ** 18n, rateE18: 1_000n * 10n ** 18n });
  const plan = expectReady(
    await planRebalance(
      argsOf(chain, { holdings: pinnedHoldings(), targets: targetsOf(WBNB, USDT), thresholdBps: 100, maxImpactBps: null }),
    ),
  );
  const poolReads = chain.calls.filter(
    (call) => call.functionName === 'slot0' || call.functionName === 'liquidity',
  );
  assert.deepEqual(poolReads, []);
  assert.equal(plan.partial, undefined, '執行後收斂就不該帶 partial');
  assert.equal(plan.steps[0]?.amountIn, 100_000_000_000_000_000n);
});

test('pinned：縮小後只剩 dust（< 理想量的 1 bp）→ 跳過那一步，全部跳過 → noop', async () => {
  // 賣 100 顆 WBNB（$100）進 L=1e18 的池子：最大可行量 ≈ 0.005 顆，只有理想量的 0.005% < 1 bp。
  const holdings = [
    holding(WBNB, 200_000_000_000_000_000_000n, 18, PRICE_1_USD), // 200 顆 @ $1 = $200
    holding(USDT, 0n, 18, PRICE_1_USD),
  ];
  const chain = impactChain({ liquidity: 10n ** 18n });
  const plan = await planRebalance(argsOf(chain, { holdings, targets: targetsOf(WBNB, USDT), thresholdBps: 100 }));

  assert.equal(plan.kind, 'noop', `全部縮到 dust 要回 noop（實際 ${plan.kind}）`);
  if (plan.kind !== 'noop') throw new Error('unreachable');
  assert.match(plan.reason, /dust/);
  assert.match(plan.reason, /Not sending empty steps/);
  assert.equal('steps' in plan, false, '絕不回空 steps');
});

test('pinned：baseline（fee + 現貨 vs TWAP）本身就超預算 → noop 並說明「切多小都沒用」，不是 blocked', async () => {
  // 賣的是 WBNB（pool 的 token1）→ 到手量 ∝ 1/P，所以「現貨比 TWAP 貴 2.01%」才是不利的那一側。
  const chain = impactChain({ liquidity: 10n ** 18n, sqrtPriceX96: (SQRT_PRICE_ONE * 101n) / 100n });
  const plan = await planRebalance(
    argsOf(chain, { holdings: pinnedHoldings(), targets: targetsOf(WBNB, USDT), thresholdBps: 100 }),
  );
  assert.equal(plan.kind, 'noop');
  if (plan.kind !== 'noop') throw new Error('unreachable');
  assert.match(plan.reason, /not a size problem/);
  assert.match(plan.reason, /no size fixes that/);
  assert.match(plan.reason, /197 bps/); // 現貨 P = 1.0201 → 邊際到手 98.02% → baseline 197 bps
});

test('pinned：池子狀態讀不到（slot0/liquidity 沒有）→ 放行原量並在 rationale 記錄，不是擋下來', async () => {
  const chain = baseChain(); // 沒有 poolState：stub 對 slot0/liquidity 一律拋
  // 與 DB 價格一致（1 WBNB = $1000），否則「執行後預估漂移」只是報價與價格表不一致的假象。
  chain.rate = { rateE18: 1_000n * 10n ** 18n, slippageBps: 100 };
  const plan = expectReady(
    await planRebalance(argsOf(chain, { holdings: pinnedHoldings(), targets: targetsOf(WBNB, USDT), thresholdBps: 100 })),
  );
  assert.equal(plan.steps[0]?.amountIn, 100_000_000_000_000_000n, '估不出來時送原量（軟性護欄，不是安全不變量）');
  assert.equal(plan.partial, undefined, '原量賣完就收斂（上限沒套用不影響判準）');
  assert.match(plan.rationale, /估不出衝擊/);
  assert.match(plan.rationale, /上限未套用/);
});

test('maxImpactBps 的解析：省略 = 80、null = 關掉、非法值 → RangeError', () => {
  assert.equal(resolveMaxImpactBps(undefined), DEFAULT_MAX_IMPACT_BPS);
  // 80 嚴格小於 per-pair oracle 的 maxSlippageBps（100）：合約的 BelowFloor 永遠比我們寬鬆。
  assert.equal(DEFAULT_MAX_IMPACT_BPS, 80);
  assert.equal(resolveMaxImpactBps(null), null);
  assert.equal(resolveMaxImpactBps(25), 25);
  for (const bad of [0, -1, 10_000, 1.5, Number.NaN]) {
    assert.throws(() => resolveMaxImpactBps(bad), RangeError, `${bad} 不是合法上限`);
  }
});

test('hub：賣的 leg 被縮小 → 買的 USDT 預算跟著縮（不能拿理想賣出量的錢去買）', async () => {
  // WBNB $600 / NVDAB $200 / USDT $0，目標 40/30/30 → 賣 $280 的 WBNB、買 $40 的 NVDAB。
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD),
    holding(TOKEN3, 200_000_000_000_000_000_000n, 18, PRICE_1_USD),
    holding(USDT, 0n, 18, PRICE_1_USD),
  ];
  const targets: TargetWeight[] = [
    { asset: WBNB, weightBps: 4_000 },
    { asset: TOKEN3, weightBps: 3_000 },
    { asset: USDT, weightBps: 3_000 },
  ];
  const chain = hubChain();
  chain.poolState = { sqrtPriceX96: SQRT_PRICE_ONE, liquidity: 10n ** 18n, token0: USDT };
  chain.rate = { rateE18: 10n ** 18n, slippageBps: 100 };

  const plan = expectReady(await planRebalance(hubArgs(chain, { holdings, targets, thresholdBps: 100 })));
  const sellStep = plan.steps[0];
  const buyStep = plan.steps[1];
  assert.ok(sellStep !== undefined && buyStep !== undefined);

  assert.ok(sellStep.amountIn < 280_000_000_000_000_000n, '賣的量要被縮小');
  assert.ok(plan.partial !== undefined, 'hub 模式也要帶 partial');
  assert.equal(plan.partial?.shrunk[0]?.index, 0);
  // USDT 持倉是 0 → 能拿來買的只有這一輪**真的賣到**的保證淨額（fee 0 = floor 本身）。
  assert.ok(
    buyStep.amountIn <= sellStep.oracleFloor,
    `買的 USDT 不能超過這一輪賣到的保證淨額：買 ${buyStep.amountIn} > 賣 ${sellStep.oracleFloor}`,
  );
  assert.match(plan.rationale, /partial execution/);
});

// ---------------------------------------------------- partial 的判準是「結果」，不是「過程」

/** hub 的報價 key：`${tokenIn}:${tokenOut}`（方向有意義）。 */
function quoteKey(tokenIn: Address, tokenOut: Address): string {
  return `${tokenIn.toLowerCase()}:${tokenOut.toLowerCase()}`;
}

test('收斂：完整一輪把兩個缺口都補掉 → 執行後預估漂移降到門檻下 → **不是** partial', async () => {
  // WBNB $600 / NVDAB $200 / USDT $200，目標 40/30/30 → 賣 $200 WBNB、買 $100 NVDAB，兩個缺口都做。
  // 報價與 DB 價格一致：賣 0.2 WBNB 到手 198 USDT、買 99 NVDAB。
  // → WBNB 40.12% / NVDAB 29.99% / USDT 29.89%：gross drift ≈ 12 bps，遠低於門檻 100。
  const { holdings, targets } = threeAssetCase();
  const chain = hubChain({
    quotes: {
      [quoteKey(WBNB, USDT)]: { quoted: 200n * 10n ** 18n, minimum: 198n * 10n ** 18n },
      [quoteKey(USDT, TOKEN3)]: { quoted: 100n * 10n ** 18n, minimum: 99n * 10n ** 18n },
    },
  });

  const plan = expectReady(
    await planRebalance(hubArgs(chain, { holdings, targets, thresholdBps: 100 })),
  );
  assert.equal(plan.steps.length, 2, '賣 + 買各一個 step');
  assert.equal(plan.partial, undefined, '執行後就收斂 → 不該帶 partial（排程器用完整間隔）');
  assert.match(plan.rationale, /Estimated drift after this round \d+ bps/);
  assert.match(plan.rationale, /converged/);
  assert.doesNotMatch(plan.rationale, /still above the threshold/);
});

test('縮小但收斂：step 真的被衝擊上限縮小，執行後仍收斂 → **不是** partial（舊定義會誤判）', async () => {
  // 舊定義是「有 step 被縮小 ⇒ partial」。這裡 100 顆的賣單被縮到 ~75 顆（真的縮了），但縮完之後
  // 60/40 → 52.5/47.5，gross drift 約 254 bps，已經在門檻 600 之下 ⇒ 沒有事了，不該叫下一輪。
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000_000n, 18, PRICE_1_USD), // 600 顆 @ $1 = $600（60%）
    holding(USDT, 400_000_000_000_000_000_000n, 18, PRICE_1_USD), // $400（40%）
  ];
  const chain = impactChain({ liquidity: 15n * 10n ** 21n }); // 現貨 1:1 與 rate 一致

  const plan = expectReady(
    await planRebalance(
      argsOf(chain, {
      maxImpactBps: 50, holdings, targets: targetsOf(WBNB, USDT), thresholdBps: 600 }),
    ),
  );
  const step = plan.steps[0];
  assert.ok(step !== undefined);
  assert.ok(step.amountIn < 100n * 10n ** 18n, `要被縮小（實際 ${step.amountIn} < 理想 1e20）`);
  assert.ok(step.amountIn > 0n);
  assert.equal(plan.partial, undefined, '縮小不是判準：執行後收斂就沒有 partial');
  assert.match(plan.rationale, /⚠ partial execution/, '縮小的證據仍然留在理由裡');
  assert.match(plan.rationale, /converged/);
});

test('主要缺口被跳過（不是被縮小）→ partial 存在，且 remainingDriftBps 說得出還差多少', async () => {
  // 這一輪真正該做的是「買 $200 的 NVDAB」，但 router 沒為它註冊 oracle → 整筆被跳過；
  // 只剩賣 0.3 WBNB 換 297 USDT，而 USDT 本來就低配 → 漂移 3000 → 約 1994，還差得遠。
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD), // $600（60%）
    holding(TOKEN3, 200_000_000_000_000_000_000n, 18, PRICE_1_USD), // $200（20%）
    holding(USDT, 200_000_000_000_000_000_000n, 18, PRICE_1_USD), // $200（20%）
  ];
  const targets: TargetWeight[] = [
    { asset: WBNB, weightBps: 3_000 },
    { asset: TOKEN3, weightBps: 4_000 },
    { asset: USDT, weightBps: 3_000 },
  ];
  const chain = hubChain({
    // 只註冊 WBNB：NVDAB 的買入那一步會被跳過（不是被縮小）。
    pairs: { [WBNB.toLowerCase()]: { oracle: ORACLE_WBNB_USDT, pool: WBNB_USDT_POOL, fee: 500 } },
    quotes: { [quoteKey(WBNB, USDT)]: { quoted: 297n * 10n ** 18n, minimum: 297n * 10n ** 18n } },
  });

  const plan = expectReady(
    await planRebalance(hubArgs(chain, { holdings, targets, thresholdBps: 100 })),
  );
  assert.equal(plan.steps.length, 1, '只有賣 WBNB 這一步');
  assert.ok(plan.partial !== undefined, '缺口還在 → 必須是 partial（這一條就是那個一小時退避的 bug）');
  assert.equal(plan.partial?.shrunk.length, 0, '沒有 step 被縮小，缺口是被**跳過**');
  const remaining = plan.partial?.remainingDriftBps ?? 0;
  assert.ok(remaining > 100, `執行後預估漂移 ${remaining} 必須仍高於門檻 100`);
  assert.ok(remaining > 1_500, `賣掉 297 USDT 之後還差得遠（實際 ${remaining}）`);
  assert.match(plan.rationale, /still above the threshold/);
  assert.match(plan.rationale, /skipped rather than shrunk/);
  assert.match(plan.rationale, /被跳過 1 筆/);
});

// 回歸（實測踩到）：投組只持有 numeraire，這一輪要**買進兩個沒持有的資產**。
//
// 買到的量沒有價格可以估 → 執行後的漂移算不出來。錯的做法是拿「執行前的漂移」當預測值講出來：
// 使用者看到「still 6600 bps after this round」，而實際那一輪把 6600 收斂到 6。
test('買進沒持有的資產 → partial.remainingDriftBps 是 null（算不出來），不是執行前的數字', async () => {
  const holdings = [holding(USDT, 5_000_000_000_000_000_000_000n, 18, PRICE_1_USD)];
  const targets: TargetWeight[] = [
    { asset: USDT, weightBps: 3_400 },
    { asset: WBNB, weightBps: 3_300 },
    { asset: TOKEN3, weightBps: 3_300 },
  ];
  // hub 模式（numeraire = USDT），報價要給：兩個買入腿都要有 minimum 才走得下去。
  const chain = hubChain({
    quotes: {
      // 買入腿的方向是 USDT → 資產，key 用 (tokenIn:tokenOut)。
      [`${USDT}:${WBNB}`]: { minimum: 1_600_000_000_000_000_000n },
      [`${USDT}:${TOKEN3}`]: { minimum: 3_000_000_000_000_000_000_000n },
    },
  });
  const plan = expectReady(await planRebalance(hubArgs(chain, { holdings, targets, thresholdBps: 100 })));
  assert.equal(plan.steps.length, 2);
  assert.notEqual(plan.partial, undefined, '要帶 partial（還有事沒做完）');
  assert.equal(
    plan.partial?.remainingDriftBps,
    null,
    '算不出來就是 null —— 拿執行前的漂移冒充預測值是錯的（實際上是 6600 → 6 bps 收斂的一輪）',
  );
});

test('計畫不改善漂移（賣超配的錢去補另一個也超配的資產）→ noop，不送出去付 gas', async () => {
  // WBNB +500 / NVDAB -1000 / USDT +500。這一輪只賣 $50 的 WBNB 換 USDT（買 NVDAB 那一步被跳過）：
  // WBNB 的偏差減少、USDT 的偏差等量增加 ⇒ Σ|delta| 完全不動，gross drift 1000 → 1000。
  // 送出去只是付 gas，所以不送。等於（不是小於）也算不改善。
  const holdings = [
    holding(WBNB, 600_000_000_000_000_000n, 18, PRICE_1000_USD), // $600（60%）
    holding(TOKEN3, 300_000_000_000_000_000_000n, 18, PRICE_1_USD), // $300（30%）
    holding(USDT, 100_000_000_000_000_000_000n, 18, PRICE_1_USD), // $100（10%）
  ];
  const targets: TargetWeight[] = [
    { asset: WBNB, weightBps: 5_500 },
    { asset: TOKEN3, weightBps: 4_000 },
    { asset: USDT, weightBps: 500 },
  ];
  const chain = hubChain({
    pairs: { [WBNB.toLowerCase()]: { oracle: ORACLE_WBNB_USDT, pool: WBNB_USDT_POOL, fee: 500 } },
    // 賣 0.05 WBNB（$50）到手 50 USDT：平價、沒有滑價 → 漂移只是平移。
    quotes: { [quoteKey(WBNB, USDT)]: { quoted: 50n * 10n ** 18n, minimum: 50n * 10n ** 18n } },
  });

  const plan = await planRebalance(hubArgs(chain, { holdings, targets, thresholdBps: 100 }));
  assert.equal(plan.kind, 'noop', `不改善就不送（實際 ${plan.kind}）`);
  if (plan.kind !== 'noop') throw new Error('unreachable');
  assert.match(plan.reason, /would leave estimated drift at 1000 bps/);
  assert.match(plan.reason, /not below the current 1000 bps/);
  assert.match(plan.reason, /only cost gas/);
  assert.equal('steps' in plan, false, '絕不回空 steps');
});

// ---------------------------------------------------------------- 真 fork 交叉驗證（環境不在就 skip）

const RPC_URL = process.env.ANVIL_RPC_URL ?? 'http://127.0.0.1:8545';
const publicClient = createPublicClient({
  chain: bsc,
  transport: http(RPC_URL, { timeout: 20_000, retryCount: 1 }),
});

const ORACLE_ABI = [
  {
    type: 'function',
    name: 'previewSwap',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
    ],
    outputs: [
      { name: 'quoted', type: 'uint256' },
      { name: 'minimum', type: 'uint256' },
    ],
  },
] as const;

const REGISTRY_ABI = [
  {
    type: 'function',
    name: 'effectiveFeeBps',
    stateMutability: 'view',
    inputs: [{ name: 'strategyId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint16' }],
  },
] as const;

/**
 * fork 能不能用：oracle 在 head 有沒有 code。讀不到（403 archive / 沒開 anvil）與「沒有 code」在這裡
 * 是同一個結論：這台機器上跑不了交叉驗證，明確 skip 並說出原因，不讓 suite 變紅也不靜默 pass。
 */
async function probeFork(): Promise<string | null> {
  try {
    const head = await publicClient.getBlockNumber();
    const code = await publicClient.getCode({ address: ORACLE, blockNumber: head });
    if (code === undefined || code.length <= 2) {
      return `oracle ${ORACLE} 在 head(${head}) 沒有 code（fresh fork 或 state 沒載入）`;
    }
    return null;
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
    return `RPC ${RPC_URL} 讀不到：${reason}`;
  }
}

const skipReason = await probeFork();
const onChain = skipReason === null ? {} : { skip: skipReason };
if (skipReason !== null) console.warn(`[rebalance-plan] 交叉驗證 skip：${skipReason}`);

test('交叉驗證：真 fork 上跑一次規劃器，minGross ≥ previewSwap 的 minimum、path fee 來自真池子', onChain, async () => {
  const blockNumber = await publicClient.getBlockNumber();
  const block = await publicClient.getBlock({ blockNumber });

  // 真價格：WBNB 走 TWAP，USDT 是 numeraire（1e8 定義）。
  const wbnbPrice = await twapPriceInUsdt(publicClient, {
    token: WBNB,
    usdtPool: WBNB_USDT_POOL,
    expectedQuoteToken: USDT,
    blockNumber,
  });
  assert.equal(wbnbPrice.decimals, 18);

  // 造一個「WBNB 超配 1000 bps」的持倉（$600 / $400），實際帳戶是空倉 —— 這裡只讀鏈，不動狀態。
  const holdings: Holding[] = [
    { asset: WBNB, amountWei: 600_000_000_000_000_000n, decimals: 18, usdPriceE8: wbnbPrice.priceE8 },
    { asset: USDT, amountWei: 400_000_000_000_000_000_000n, decimals: 18, usdPriceE8: PRICE_1_USD },
  ];
  const targets = targetsOf(WBNB, USDT);
  const wallBefore = wallClockSeconds();
  const plan = await planRebalance({
    publicClient,
    account: '0x2b082fadf8f3d620eaa242a9e36817af8640d042' as Address,
    executor: EXECUTOR,
    oracle: ORACLE,
    registry: REGISTRY,
    strategyId: 1n, // 鏈上 id（DB 的 strategies.id 11 對應到鏈上 1）
    holdings,
    targets,
    drift: computeDrift(holdings, targets, 100),
    thresholdBps: 100,
    blockNumber,
  });
  const wallAfter = wallClockSeconds();

  const ready = expectReady(plan);
  const step = ready.steps[0];
  assert.ok(step !== undefined);

  // 1. oracleFloor 必須逐位等於同一個塊上直接呼叫 previewSwap 的第二個回傳值（minimum，不是 quoted）。
  const [quoted, minimum] = await publicClient.readContract({
    address: ORACLE,
    abi: ORACLE_ABI,
    functionName: 'previewSwap',
    args: [step.tokenIn, step.tokenOut, step.amountIn],
    blockNumber,
  });
  assert.equal(step.oracleFloor, minimum);
  // 「取的是 minimum 不是 quoted」由單元測試（stub 的 quoted ≠ minimum）釘死；這裡 quoted 只當對照印出來。
  assert.ok(quoted > 0n && minimum > 0n);

  // 2. minGross 逐字對齊合約公式，且 ≥ oracleFloor。
  const feeBps = Number(
    await publicClient.readContract({
      address: REGISTRY,
      abi: REGISTRY_ABI,
      functionName: 'effectiveFeeBps',
      args: [1n],
      blockNumber,
    }),
  );
  assert.equal(step.amountOutMin, amountOutMinWithBuffer(minGrossFor(minimum, feeBps)));
  assert.ok(step.amountOutMin >= step.oracleFloor);
  if (feeBps === 0) assert.equal(step.amountOutMin, amountOutMinWithBuffer(step.oracleFloor));

  // 3. path 的 fee 來自真池子（WBNB/USDT V3 fee 500），deadline 來自 max(塊時間, 牆鐘)。
  const decoded = decodeStepInput(step);
  assert.equal(pathFee(decoded.path), 500);
  assert.equal(decoded.recipient, getAddress(EXECUTOR));
  const deadlineBaseOnChain = ready.deadline - BigInt(DEFAULT_DEADLINE_SECONDS);
  if (block.timestamp > wallAfter) {
    assert.equal(deadlineBaseOnChain, block.timestamp, '塊時間超前 → 基準就是塊時間');
  } else {
    assert.ok(
      deadlineBaseOnChain >= wallBefore && deadlineBaseOnChain <= wallAfter,
      `塊時間 ${block.timestamp} 落後牆鐘 → 基準必須是牆鐘（${wallBefore}..${wallAfter}），不是 ${deadlineBaseOnChain}`,
    );
  }
  assert.ok(ready.deadline > block.timestamp, 'deadline 必須晚於塊時間（不然鏈上就是已過期）');
  console.log(
    `[交叉驗證] 塊時間 ${block.timestamp}、牆鐘 ${wallBefore}、deadline ${ready.deadline}` +
      `（相對塊時間 +${ready.deadline - block.timestamp}s，設定 ${DEFAULT_DEADLINE_SECONDS}s）`,
  );
  assert.equal(pancakePayload(step).commands, '0x00');
  assert.equal(pancakePayload(step).inputs.length, 1);
});

// A10: allowance is a budget for the entire batch, in numeraire units.
function allowanceCase(chain: StubChain): PlanRebalanceArgs {
  return hubArgs(chain, {
    holdings: [holding(USDT, 1000n * 10n ** 18n, 18, PRICE_1_USD)],
    targets: [{ asset: USDT, weightBps: 0 }, { asset: WBNB, weightBps: 5000 }, { asset: TOKEN3, weightBps: 5000 }],
    thresholdBps: 100,
  });
}

for (const [cap, bought, expected] of ([[100n, 0n, 98n], [100n, 97n, 1n], [101n, 0n, 98n], [1000n, 0n, 980n]] satisfies [bigint, bigint, bigint][])) {
  test(`A10 batch budget cap=${cap}, bought=${bought}: floors total-cap margin before subtracting buys`, async () => {
    const chain = hubChain();
    chain.rate = { rateE18: 10n ** 18n, slippageBps: 100 };
    chain.buyAllowance = [cap, bought, 1800000000n];
    const plan = expectReady(await planRebalance(allowanceCase(chain)));
    assert.equal(plan.steps.reduce((sum, step) => sum + step.amountIn, 0n), expected);
    for (const step of plan.steps) {
      const payload = decodeStepInput(step);
      assert.equal(payload.amountIn, step.amountIn);
      assert.equal(payload.amountOutMin, step.amountOutMin);
      assert.equal(step.oracleFloor, (step.amountIn * 9900n + 9999n) / 10000n);
    }
    const reads = chain.calls.filter((call) => call.functionName === 'buyAllowance');
    assert.equal(reads.length, 1);
    assert.equal(reads[0]?.blockNumber, chain.block.number);
    assert.equal(reads[0]?.args?.[0], allowanceCase(chain).account);
    assert.match(plan.rationale, /買入額度/);
  });
}

test('A10 safe buy cap keeps the cash-backed part whole and cuts only the volatile part by 2%', () => {
  assert.equal(BUY_CAP_VOLATILE_MARGIN_BPS, 200n);
  assert.equal(safeBuyCap(1000n, 0n), 980n, 'no cash: unchanged 98% of the whole cap');
  assert.equal(safeBuyCap(1000n, 1000n), 1000n, 'all cash: no haircut');
  assert.equal(safeBuyCap(1000n, 600n), 600n + 392n);
  assert.equal(safeBuyCap(1000n, 5000n), 1000n, 'cash credit never exceeds the cap');
  assert.equal(safeBuyCap(0n, 100n), 0n);
  assert.throws(() => safeBuyCap(-1n, 0n));
});

// Regression (portfolio 20, 2026-11-24): a cash-only account buying ~99.9% of its value. The flat 98% cap
// left ~2% short every round, so the batch planner split it 100 / 50 / 25 / 12.5. It must fit in one round.
test('A10 first buy of ~99.9% of a cash-only account fits the allowance in one round', async () => {
  const unit = 10n ** 18n;
  const chain = hubChain();
  chain.rate = { rateE18: unit, slippageBps: 100 };
  chain.maxBuyBps = 10000;
  chain.accountCash = 1000n * unit;
  chain.buyAllowance = [1000n * unit, 0n, 0n];
  const args = allowanceCase(chain);
  args.holdings = [holding(USDT, 1000n * unit, 18, PRICE_1_USD)];
  args.targets = [{ asset: USDT, weightBps: 10 }, { asset: WBNB, weightBps: 4995 }, { asset: TOKEN3, weightBps: 4995 }];
  args.drift = computeDrift(args.holdings, args.targets, 100);
  const plan = expectReady(await planRebalance(args));
  const total = plan.steps.reduce((sum, step) => sum + step.amountIn, 0n);
  assert.equal(total, 999n * unit, 'the whole ~99.9% basket, not a half');
  // Protections unchanged: allowance still read at the planning block, executor cap never exceeded.
  assert.ok(total <= 1000n * unit);
  assert.ok(chain.calls.some((call) => call.functionName === 'buyAllowance' && call.blockNumber === chain.block.number));
  assert.ok(chain.calls.some((call) => call.functionName === 'balanceOf' && call.blockNumber === chain.block.number));
});

test('A10 volatile account value keeps the 2% margin; failed cash reads fall back to the old 98%', async () => {
  const unit = 10n ** 18n;
  for (const [cash, expected] of ([[0n, 980n], [undefined, 980n], [500n, 990n]] satisfies [bigint | undefined, bigint][])) {
    const chain = hubChain();
    chain.rate = { rateE18: unit, slippageBps: 100 };
    chain.maxBuyBps = 10000;
    if (cash !== undefined) chain.accountCash = cash * unit;
    chain.buyAllowance = [1000n * unit, 0n, 0n];
    const args = allowanceCase(chain);
    args.holdings = [holding(USDT, 2000n * unit, 18, PRICE_1_USD)];
    args.drift = computeDrift(args.holdings, args.targets, 100);
    const plan = expectReady(await planRebalance(args));
    assert.equal(plan.steps.reduce((sum, step) => sum + step.amountIn, 0n), expected * unit, `cash ${String(cash)}`);
  }
});

for (const [cap, bought, end] of ([[0n, 0n, 0n], [100n, 98n, 1800000000n], [100n, 100n, 1800000000n], [100n, 101n, 1800000000n], [1n, 0n, 0n]] satisfies [bigint, bigint, bigint][])) {
  test(`A10 exhausted or rounded-to-zero budget ${cap}/${bought}/${end} blocks without a quote`, async () => {
    const chain = hubChain();
    chain.buyAllowance = [cap, bought, end];
    const plan = await planRebalance(allowanceCase(chain));
    assert.equal(plan.kind, 'blocked');
    assert.ok(plan.kind === 'blocked');
    assert.equal(plan.buyWindowEndsAt, end);
    assert.match(plan.reason, /買入額度/);
    assert.ok(!chain.calls.some((call) => call.functionName === 'previewSwap'));
  });
}

for (const failure of [new Error('RPC timeout sensitive-token'), new Error('RPC failed sensitive-token')]) {
  test(`A10 allowance RPC failure blocks without exposing credentials: ${failure.message.split(' ')[1]}`, async () => {
    const chain = hubChain();
    chain.buyAllowance = failure;
    const plan = await planRebalance(allowanceCase(chain));
    assert.equal(plan.kind, 'blocked');
    assert.ok(!JSON.stringify(plan).includes('sensitive-token'));
    assert.ok(!chain.calls.some((call) => call.functionName === 'previewSwap'));
  });
}

test('A10 sales-only plans do not read buyAllowance even when its RPC fails', async () => {
  const chain = hubChain();
  chain.buyAllowance = new Error('unavailable');
  chain.rate = RATE_WBNB_USDT;
  const plan = expectReady(await planRebalance(hubArgs(chain, {
    holdings: [holding(WBNB, 10n ** 18n, 18, PRICE_1000_USD)],
    targets: targetsOf(WBNB, USDT, 0), thresholdBps: 100,
  })));
  assert.ok(plan.steps.every((step) => step.tokenOut.toLowerCase() === USDT.toLowerCase()));
  assert.ok(!chain.calls.some((call) => call.functionName === 'buyAllowance'));
});

for (const invalid of [null, [], [100n, 0n], [100n, 0n, -1n], [-1n, 0n, 0n], [100n, -1n, 0n], [100n, 0n, 2n ** 64n], ['100', 0n, 0n]]) {
  test(`A10 malformed allowance fails closed: ${String(invalid)}`, async () => {
    const chain = hubChain();
    chain.buyAllowance = invalid;
    const plan = await planRebalance(allowanceCase(chain));
    assert.equal(plan.kind, 'blocked');
    assert.ok(plan.kind === 'blocked');
    assert.match(plan.reason, /BUY_ALLOWANCE_UNAVAILABLE/);
  });
}

test('A10 pinned buys also clamp before quoting and rebuild router amount/floor', async () => {
  const chain = baseChain({ buyAllowance: [100n, 48n, 1800000000n], rate: { rateE18: 10n ** 18n, slippageBps: 100 } });
  const plan = expectReady(await planRebalance(argsOf(chain, {
    holdings: [holding(USDT, 1000n * 10n ** 18n, 18, PRICE_1_USD)],
    targets: targetsOf(USDT, WBNB, 0), thresholdBps: 100,
  })));
  assert.equal(plan.steps[0]?.amountIn, 50n);
  const first = plan.steps[0];
  assert.ok(first);
  assert.equal(decodeStepInput(first).amountIn, 50n);
  assert.ok(chain.calls.filter((call) => call.functionName === 'previewSwap').every((call) => call.args?.[2] === 50n));
});

test('A10 rejects a non-numeraire route before quoting or reading allowance', async () => {
  const chain = baseChain({ executorNumeraire: TOKEN3, rate: RATE_WBNB_USDT });
  const plan = await planRebalance(argsOf(chain, {
    holdings: [holding(WBNB, 10n ** 18n, 18, PRICE_1000_USD)], targets: targetsOf(WBNB, USDT), thresholdBps: 100,
  }));
  assert.equal(plan.kind, 'blocked');
  assert.ok(plan.kind === 'blocked');
  assert.match(plan.reason, /NotNumeraireRoute/);
  assert.ok(!chain.calls.some((call) => call.functionName === 'buyAllowance' || call.functionName === 'previewSwap'));
});

for (const value of [null, ZERO_ADDRESS, new Error('RPC timeout sensitive-token')]) {
  test(`A10 missing executor numeraire blocks without leaking RPC data: ${value instanceof Error ? 'timeout' : String(value)}`, async () => {
    const chain = hubChain();
    chain.executorNumeraire = value;
    const plan = await planRebalance(allowanceCase(chain));
    assert.equal(plan.kind, 'blocked');
    assert.ok(!JSON.stringify(plan).includes('sensitive-token'));
    assert.ok(!chain.calls.some((call) => call.functionName === 'buyAllowance'));
  });
}

test('A10 allowance exactly equal to requested batch keeps all original amounts', async () => {
  const chain = hubChain();
  chain.rate = { rateE18: 10n ** 18n, slippageBps: 100 };
  const args = allowanceCase(chain);
  // Use a representable whole-unit portfolio to independently fix the requested amount.
  chain.buyAllowance = [1000n * 10n ** 18n, 480n * 10n ** 18n, 1800000000n];
  args.holdings = [holding(USDT, 500n * 10n ** 18n, 18, PRICE_1_USD)];
  args.drift = computeDrift(args.holdings, args.targets, 100);
  const plan = expectReady(await planRebalance(args));
  assert.equal(plan.steps.length, 2);
  assert.deepEqual(plan.steps.map((step) => step.amountIn), [250n * 10n ** 18n, 250n * 10n ** 18n]);
});

for (const allowance of [[0n, 0n, 0n], new Error('RPC timeout sensitive-token')]) {
  test(`A10 pinned buy rejects exhausted or unavailable allowance: ${allowance instanceof Error ? 'timeout' : 'zero'}`, async () => {
    const chain = baseChain({ buyAllowance: allowance, rate: { rateE18: 10n ** 18n, slippageBps: 100 } });
    const plan = await planRebalance(argsOf(chain, {
      holdings: [holding(USDT, 1000n * 10n ** 18n, 18, PRICE_1_USD)], targets: targetsOf(USDT, WBNB, 0), thresholdBps: 100,
    }));
    assert.equal(plan.kind, 'blocked');
    assert.ok(plan.kind === 'blocked');
    assert.ok(!plan.reason.includes('sensitive-token'));
    assert.ok(!chain.calls.some((call) => call.functionName === 'previewSwap'));
  });
}

test('A10 oracle and executor numeraire mismatch blocks before budgeting', async () => {
  const chain = hubChain();
  chain.executorNumeraire = WBNB;
  const plan = await planRebalance(allowanceCase(chain));
  assert.ok(plan.kind === 'blocked');
  assert.match(plan.reason, /NotNumeraireRoute/);
  assert.ok(!chain.calls.some((call) => call.functionName === 'buyAllowance'));
});

for (const mode of ['hub', 'pinned'] as const) {
  for (const limit of [null, 150n, 200n, 0n]) {
    test(`#40 ${mode}: buy limit ${limit} applies before quotes and calldata`, async () => {
      const chain = mode === 'hub' ? hubChain() : baseChain();
      chain.rate = { rateE18: 10n ** 18n, slippageBps: 100 };
      const args = argsOf(chain, {
        ...(mode === 'hub' ? { oracle: ROUTER, executor: EXECUTOR_MULTI } : {}),
        holdings: [holding(USDT, 2000n * 10n ** 18n, 18, PRICE_1_USD)],
        targets: targetsOf(USDT, WBNB, 9000), thresholdBps: 100,
      });
      const plan = await planRebalance({ ...args, maxLegUsdE8: new Map([[WBNB, limit === null ? null : limit * PRICE_1_USD]]) });
      if (limit === 0n) {
        assert.ok(plan.kind === 'blocked');
        assert.match(plan.reason, /MAX_LEG/);
        assert.ok(!chain.calls.some((call) => call.functionName === 'previewSwap'));
      } else {
        const ready = expectReady(plan);
        const expected = (limit === null ? 200n : limit) * 10n ** 18n;
        assert.equal(ready.steps.length, 1);
        const step = ready.steps[0]; assert.ok(step);
        assert.equal(step.amountIn, expected);
        assert.equal(decodeStepInput(step).amountIn, expected);
        assert.ok(chain.calls.filter((call) => call.functionName === 'previewSwap').every((call) => call.args?.[2] === expected));
        if (limit === 150n) assert.equal(ready.partial?.maxLegBatched, true);
      }
    });
  }
}

test('#40 buy allowance and asset limit use the stricter budget', async () => {
  for (const available of [100n, 180n]) {
    const chain = hubChain();
    chain.rate = { rateE18: 10n ** 18n, slippageBps: 100 };
    chain.buyAllowance = [1000n * 10n ** 18n, (980n - available) * 10n ** 18n, 0n];
    const args = allowanceCase(chain);
    const ready = expectReady(await planRebalance({ ...args, maxLegUsdE8: new Map([[WBNB, 150n * PRICE_1_USD], [TOKEN3, null]]) }));
    assert.equal(ready.steps[0]?.amountIn, (available < 150n ? available : 150n) * 10n ** 18n);
    assert.ok(ready.steps.reduce((sum, step) => sum + step.amountIn, 0n) <= available * 10n ** 18n);
    assert.equal(ready.partial?.maxLegBatched, true, 'a tighter buy budget must not hide the known capped remainder');
  }
});

test('#40 pinned buy budget stricter than asset cap still records the known next batch', async () => {
  const chain = baseChain({ rate: { rateE18: 10n ** 18n, slippageBps: 100 }, buyAllowance: [1000n * 10n ** 18n, 880n * 10n ** 18n, 0n] });
  const args = argsOf(chain, { holdings: [holding(USDT, 2000n * 10n ** 18n, 18, PRICE_1_USD)], targets: targetsOf(USDT, WBNB, 9000), thresholdBps: 100 });
  const result = expectReady(await planRebalance({ ...args, maxLegUsdE8: new Map([[WBNB, 150n * PRICE_1_USD]]) }));
  assert.equal(result.steps[0]?.amountIn, 100n * 10n ** 18n);
  assert.equal(result.partial?.maxLegBatched, true);
});

test('#40 DB numeric limits retain precision, NULL, zero and round down beyond E8', async () => {
  const limits = await readMaxLegUsdE8([WBNB, USDT, TOKEN3, TOKEN6], async () => ({ rows: [
    { address: WBNB, max_leg_usdt: '9007199254740993.123456789' },
    { address: USDT, max_leg_usdt: null }, { address: TOKEN3, max_leg_usdt: '0' }, { address: TOKEN6, max_leg_usdt: '0.000000009' },
  ] }));
  assert.equal(limits.get(WBNB), 900719925474099312345678n);
  assert.equal(limits.get(USDT), null);
  assert.equal(limits.get(TOKEN3), 0n);
  assert.equal(limits.get(TOKEN6), 0n);
});

for (const value of [undefined, '-1', 'NaN', 'Infinity', 150, '1e2', '']) {
  test(`#40 DB invalid numeric ${value} fails closed`, async () => {
    await assert.rejects(readMaxLegUsdE8([WBNB], async () => ({ rows: [{ address: WBNB, max_leg_usdt: value }] })), /MAX_LEG_UNAVAILABLE/);
  });
}
test('#40 missing asset and DB timeout never become an unlimited leg or leak errors', async () => {
  await assert.rejects(readMaxLegUsdE8([WBNB], async () => ({ rows: [] })), /MAX_LEG_UNAVAILABLE/);
  await assert.rejects(readMaxLegUsdE8([WBNB], async () => { throw new Error('DB timeout secret-token'); }), (error: unknown) => error instanceof Error && !error.message.includes('secret-token'));
});

for (const mode of ['hub', 'pinned'] as const) {
  test(`#40 ${mode}: sales use oracle nominal, not holding price or discounted floor`, async () => {
    const chain = mode === 'hub' ? hubChain() : baseChain();
    chain.rate = { rateE18: 2n * 10n ** 18n, slippageBps: 100 };
    const args = argsOf(chain, {
      ...(mode === 'hub' ? { oracle: ROUTER, executor: EXECUTOR_MULTI } : {}),
      holdings: [holding(WBNB, 200n * 10n ** 18n, 18, PRICE_1_USD), holding(USDT, 0n, 18, PRICE_1_USD)],
      targets: targetsOf(WBNB, USDT, 0), thresholdBps: 100,
    });
    const plan = expectReady(await planRebalance({ ...args, maxLegUsdE8: new Map([[WBNB, 150n * PRICE_1_USD]]) }));
    assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0]?.amountIn, 75n * 10n ** 18n);
    assert.equal(plan.partial?.maxLegBatched, true);
    assert.ok(chain.calls.filter((call) => call.functionName === 'previewSwap').every((call) => call.blockNumber === chain.block.number));
  });
}

test('#40 sell quote failure/timeout fails closed without copying RPC data', async () => {
  const chain = baseChain();
  chain.oracle.revert = 'RPC timeout secret-token';
  const result = await capAssetLeg({ publicClient: stubClient(chain), oracle: ORACLE, numeraire: USDT, tokenIn: WBNB, tokenOut: USDT,
    amountIn: 1000n, limitUsdE8: PRICE_1_USD, decimals: 18, blockNumber: chain.block.number });
  assert.ok('blocked' in result);
  assert.ok(!JSON.stringify(result).includes('secret-token'));
});

test('#40 numeraire decimals 6 and dust limit never overstate the raw cap', async () => {
  const chain = baseChain();
  const base = { publicClient: stubClient(chain), oracle: ORACLE, numeraire: USDT, tokenIn: USDT, tokenOut: WBNB, amountIn: 200000000n, decimals: 6, blockNumber: chain.block.number };
  assert.deepEqual(await capAssetLeg({ ...base, limitUsdE8: 15012345678n }), { amountIn: 150123456n, batched: true });
  assert.ok('blocked' in await capAssetLeg({ ...base, limitUsdE8: 1n }));
});

test('#40 direct planner callers load DB limits by default, and DB failure blocks before a quote', async () => {
  const chain = hubChain(); chain.rate = { rateE18: 10n ** 18n, slippageBps: 100 };
  const { maxLegUsdE8: _limits, ...args } = allowanceCase(chain);
  let reads = 0;
  const result = expectReady(await planRebalance(args, { query: async () => {
    reads += 1;
    return { rows: [{ address: USDT, max_leg_usdt: null }, { address: WBNB, max_leg_usdt: '150' }, { address: TOKEN3, max_leg_usdt: null }] };
  } }));
  assert.equal(reads, 1);
  assert.equal(result.steps[0]?.amountIn, 150n * 10n ** 18n);
  chain.calls.length = 0;
  const blocked = await planRebalance(args, { query: async () => { throw new Error('DB timeout secret-token'); } });
  assert.ok(blocked.kind === 'blocked');
  assert.ok(!blocked.reason.includes('secret-token'));
  assert.ok(!chain.calls.some((call) => call.functionName === 'previewSwap'));
});

function pancakePayload(step: PlannedStep): { commands: Hex; inputs: readonly Hex[] } {
  assert.equal(step.venue, PANCAKE_UR);
  const [commands, inputs] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], step.data);
  return { commands, inputs };
}

// #47: opaque aggregator payloads must be rebuilt against the fresh floor, never reused.
test('#47 aggregator refresh with no executable Pancake quote blocks without leaking upstream details', async () => {
  const chain = baseChain();
  const planned = { ...buildStep({ executor: EXECUTOR, tokenIn: WBNB, tokenOut: USDT,
    amountIn: 1n, oracleFloor: chain.oracle.minimum, minGross: chain.oracle.minimum, poolFee: 500 }),
    venue: REGISTRY, data: '0x12345678' as const };
  const result = await refreshFloors({ publicClient: stubClient(chain), oracle: ORACLE, steps: [planned],
    feeBps: 0, executor: EXECUTOR, deadline: 2000000000n,
    quoteAggregator: async () => { throw new Error('upstream secret-token'); } });
  assert.equal(result.ok, false);
  assert.ok(!JSON.stringify(result).includes('secret-token'));
});

function kyberFixture() {
  const state = { chainId: 56, kind: 2, spender: REGISTRY, rpcFailure: false,
    requests: [] as { url: string; init: RequestInit }[], reads: [] as unknown[] };
  const summary = { tokenIn: WBNB, tokenOut: USDT, amountIn: '100', amountOut: '120' };
  const route = { code: 0, data: { routerAddress: REGISTRY, routeSummary: summary } };
  const built = { code: 0, data: { routerAddress: REGISTRY, to: REGISTRY, amountIn: '100', amountOut: '120',
    transactionValue: '0', data: '0x12345678' } };
  const client = createPublicClient({ transport: custom({ request: async ({ method, params }) => {
    if (state.rpcFailure) throw new Error('RPC secret-token');
    if (method === 'eth_chainId') return `0x${state.chainId.toString(16)}`;
    assert.equal(method, 'eth_call');
    assert.ok(Array.isArray(params));
    state.reads.push(params[1]);
    return encodeFunctionResult({ abi: EXECUTOR_ABI, functionName: 'venues', result: [state.kind, state.spender] });
  } }, { retryCount: 0 }) });
  const request = { publicClient: client, executor: EXECUTOR, tokenIn: WBNB, tokenOut: USDT,
    amountIn: 100n, minimum: 110n, deadline: 2000000000n, blockNumber: 42n };
  const fetcher = async (url: string, init: RequestInit) => {
    state.requests.push({ url, init });
    return Response.json(url.includes('/route/build') ? built : route);
  };
  return { state, summary, route, built, request, fetcher };
}

test('#47 Kyber pins sender/recipient and deadline, verifies whitelist at observed block and builds zero-value calldata', async () => {
  const f = kyberFixture();
  assert.deepEqual(await quoteKyberSwap(f.request, { fetch: f.fetcher }), { venue: getAddress(REGISTRY), data: '0x12345678', amountOut: 120n });
  assert.deepEqual(f.state.reads, ['0x2a']);
  assert.equal(f.state.requests.length, 2);
  const built = f.state.requests[1]; assert.ok(built && typeof built.init.body === 'string');
  const body: unknown = JSON.parse(built.init.body);
  assert.ok(typeof body === 'object' && body !== null);
  assert.equal(Reflect.get(body, 'sender'), EXECUTOR);
  assert.equal(Reflect.get(body, 'recipient'), EXECUTOR);
  assert.equal(Reflect.get(body, 'deadline'), Number(f.request.deadline));
  assert.ok(Number(Reflect.get(body, 'slippageTolerance')) <= 833);
});

for (const scenario of ['unlisted', 'pancake-kind', 'bad-spender', 'wrong-chain', 'RPC', 'wrong-token-in', 'wrong-token-out',
  'wrong-input', 'route-below-floor', 'build-below-floor', 'build-target', 'explicit-to', 'value', 'malformed-data', 'empty-data',
  'missing-value', 'overflow', 'API-code'] as const) {
  test(`#47 Kyber rejects ${scenario} and returns no upstream text`, async () => {
    const f = kyberFixture();
    switch (scenario) {
      case 'unlisted': f.state.kind = 0; break;
      case 'pancake-kind': f.state.kind = 1; break;
      case 'bad-spender': f.state.spender = zeroAddress; break;
      case 'wrong-chain': f.state.chainId = 1337; break;
      case 'RPC': f.state.rpcFailure = true; break;
      case 'wrong-token-in': f.summary.tokenIn = TOKEN3; break;
      case 'wrong-token-out': f.summary.tokenOut = TOKEN3; break;
      case 'wrong-input': f.built.data.amountIn = '99'; break;
      case 'route-below-floor': f.summary.amountOut = '109'; break;
      case 'build-below-floor': f.built.data.amountOut = '109'; break;
      case 'build-target': f.built.data.routerAddress = TOKEN3; break;
      case 'explicit-to': f.built.data.to = TOKEN3; break;
      case 'value': f.built.data.transactionValue = '1'; break;
      case 'malformed-data': f.built.data.data = '0x1234567'; break;
      case 'empty-data': f.built.data.data = '0x'; break;
      case 'missing-value': f.built.data.transactionValue = ''; break;
      case 'overflow': f.summary.amountOut = (2n ** 256n).toString(); break;
      case 'API-code': f.built.code = 4002; break;
    }
    assert.equal(await quoteKyberSwap(f.request, { fetch: f.fetcher }), null);
  });
}

test('#47 Kyber boundaries: zero/uint256 overflow rejected, exact floor accepted, Permit2 uint160 enforced', async () => {
  const f = kyberFixture();
  for (const amountIn of [0n, -1n, 2n ** 256n]) assert.equal(await quoteKyberSwap({ ...f.request, amountIn }, { fetch: f.fetcher }), null);
  f.summary.amountOut = f.built.data.amountOut = '110';
  assert.ok(await quoteKyberSwap(f.request, { fetch: f.fetcher }));
  f.state.kind = 3;
  const max = 2n ** 160n - 1n;
  f.summary.amountIn = f.built.data.amountIn = max.toString();
  assert.ok(await quoteKyberSwap({ ...f.request, amountIn: max }, { fetch: f.fetcher }));
  f.summary.amountIn = f.built.data.amountIn = (max + 1n).toString();
  assert.equal(await quoteKyberSwap({ ...f.request, amountIn: max + 1n }, { fetch: f.fetcher }), null);
});

test('#47 API HTTP/JSON failures and a non-cooperative timeout all fall back', async () => {
  const f = kyberFixture();
  for (const fetcher of [async () => new Response('upstream secret-token', { status: 503 }),
    async () => new Response('not json'), async () => { throw new Error('upstream secret-token'); }]) {
    assert.equal(await quoteKyberSwap(f.request, { fetch: fetcher }), null);
  }
  const started = performance.now();
  assert.equal(await quoteKyberSwap(f.request, { fetch: async () => new Promise<Response>(() => {}), timeoutMs: 10 }), null);
  assert.ok(performance.now() - started < 1000);
});

test('#47 route comparison uses integer net receipts, keeps ties on Pancake, requires floor', () => {
  const quote = { venue: REGISTRY, data: '0x12345678' as const, amountOut: 120n };
  assert.equal(aggregatorWins(quote, 119n, 110n, 100), true);
  assert.equal(aggregatorWins(quote, 121n, 110n, 100), false);
  assert.equal(aggregatorWins(quote, 120n, 110n, 100), false);
  assert.equal(aggregatorWins(quote, null, 120n, 0), true);
  assert.equal(aggregatorWins(quote, null, 121n, 0), false);
  assert.equal(aggregatorWins(quote, null, 0n, 0), false);
  for (const fee of [-1, 10000, NaN, 0.5]) assert.equal(aggregatorWins(quote, null, 110n, fee), false);
  // 10000 and 9999 both leave exactly 1 after a 9999bps fee: gross advantage is not a net advantage.
  assert.equal(aggregatorWins({ ...quote, amountOut: 10000n }, 9999n, 1n, 9999), false);
});

test('#47 shared routing selects aggregator, falls back on failure, and blocks an unreadable Pancake whitelist', async () => {
  const chain = baseChain();
  chain.oracle.minimum = 100n;
  chain.oracle.quoted = 100n;
  const client = stubClient(chain);
  const params = { publicClient: client, executor: EXECUTOR, tokenIn: WBNB, tokenOut: USDT, amountIn: 1n,
    oracleFloor: 100n, minGross: 100n, poolFee: 500, deadline: 2000000000n, feeBps: 0, blockNumber: 42n };
  const best = await buildRoutedStep(params, { quoteAggregator: async () => ({ venue: REGISTRY, data: '0x12345678', amountOut: 110n }) });
  assert.equal(best?.venue, REGISTRY);
  for (const quoteAggregator of [async () => null, async () => { throw new Error('API unavailable'); }]) {
    const fallback = await buildRoutedStep(params, { quoteAggregator });
    assert.equal(fallback?.venue, PANCAKE_UR);
  }
  const f = kyberFixture(); f.state.rpcFailure = true;
  assert.equal(await buildRoutedStep({ ...params, publicClient: f.request.publicClient }, { quoteAggregator: async () => null }), null);
});

test('#47 refresh replaces opaque data using the fresh buffered floor; failed fallback and missing context block', async () => {
  const chain = baseChain();
  const planned = { ...buildStep({ executor: EXECUTOR, tokenIn: WBNB, tokenOut: USDT, amountIn: 1n,
    oracleFloor: chain.oracle.minimum, minGross: chain.oracle.minimum, poolFee: 500 }), venue: REGISTRY, data: '0x12345678' as const };
  const params = { publicClient: stubClient(chain), oracle: ORACLE, steps: [planned], feeBps: 100,
    executor: EXECUTOR, deadline: 2000000000n };
  const refreshed = await refreshFloors({ ...params, quoteAggregator: async (request) => {
    assert.equal(request.blockNumber, undefined);
    assert.equal(request.minimum, amountOutMinWithBuffer(minGrossFor(chain.oracle.minimum, 100)));
    return { venue: REGISTRY, data: '0x87654321', amountOut: request.minimum };
  } });
  assert.ok(refreshed.ok);
  assert.equal(refreshed.steps[0]?.data, '0x87654321');
  for (const candidate of [null, { venue: TOKEN3, data: '0x87654321' as const, amountOut: 2n ** 255n },
    { venue: REGISTRY, data: '0x87654321' as const, amountOut: 0n }]) {
    assert.equal((await refreshFloors({ ...params, quoteAggregator: async () => candidate })).ok, false);
  }
  assert.equal((await refreshFloors({ ...params, executor: undefined })).ok, false);
});

test('#47 a stalled Pancake RPC cannot hold a valid aggregator route indefinitely', { timeout: 10000 }, async () => {
  const client = createPublicClient({ transport: custom({ request: async ({ method, params }) => {
    assert.equal(method, 'eth_call'); assert.ok(Array.isArray(params));
    const call: unknown = params[0]; assert.ok(typeof call === 'object' && call !== null);
    const data: unknown = Reflect.get(call, 'data'); assert.ok(typeof data === 'string');
    if (data.startsWith('0xb15ff644')) return encodeFunctionResult({ abi: EXECUTOR_ABI, functionName: 'venues', result: [1, PANCAKE_UR] });
    return new Promise<string>(() => {});
  } }, { retryCount: 0 }) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([buildRoutedStep({ publicClient: client, executor: EXECUTOR,
      tokenIn: WBNB, tokenOut: USDT, amountIn: 1n, oracleFloor: 100n, minGross: 100n, poolFee: 500,
      deadline: 2000000000n, feeBps: 0, blockNumber: 42n },
      { quoteAggregator: async () => ({ venue: REGISTRY, data: '0x12345678', amountOut: 120n }) }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Pancake quote did not terminate')), 7000); })]);
    assert.equal(result?.venue, REGISTRY);
  } finally { clearTimeout(timer); }
});

test('#47 Pancake comparison caps eth_call gas so a cold thin pool cannot consume the RPC indefinitely', async () => {
  const observedGas: unknown[] = [];
  const quoteAbi = parseAbi(['function getPool(address,address,uint24) view returns(address)',
    'function quoteExactInput(bytes,uint256) returns(uint256,uint160[])']);
  const client = createPublicClient({ transport: custom({ request: async ({ params }) => {
    assert.ok(Array.isArray(params)); const call: unknown = params[0];
    assert.ok(typeof call === 'object' && call !== null);
    const data: unknown = Reflect.get(call, 'data'); assert.ok(typeof data === 'string' && isHex(data));
    if (data.startsWith('0xb15ff644')) return encodeFunctionResult({ abi: EXECUTOR_ABI, functionName: 'venues', result: [1, PANCAKE_UR] });
    observedGas.push(Reflect.get(call, 'gas'));
    const callData = decodeFunctionData({ abi: quoteAbi, data });
    if (callData.functionName === 'getPool') return encodeFunctionResult({ abi: quoteAbi, functionName: 'getPool',
      result: callData.args[2] === 500 && callData.args[0].toLowerCase() !== callData.args[1].toLowerCase() ? WBNB_USDT_POOL : zeroAddress });
    return encodeFunctionResult({ abi: quoteAbi, functionName: 'quoteExactInput', result: [130n, []] });
  } }, { retryCount: 0 }) });
  const step = await buildRoutedStep({ publicClient: client, executor: EXECUTOR, tokenIn: WBNB, tokenOut: USDT, amountIn: 1n,
    oracleFloor: 100n, minGross: 100n, poolFee: 500, deadline: 2000000000n, feeBps: 0, blockNumber: 42n },
    { quoteAggregator: async () => ({ venue: REGISTRY, data: '0x12345678', amountOut: 120n }) });
  assert.equal(step?.venue, PANCAKE_UR, 'the valid Pancake quote beats the aggregator 130 to 120');
  assert.ok(observedGas.length > 0);
  assert.ok(observedGas.every((gas) => gas === '0x7a120'), 'each comparison eth_call must have a 500000 gas budget');
});


import { secondaryRevert, twapRevert } from './fixtures/secondary-price.js';

test('#76 unavailable hub buy or sell blocks the entire batch and a later healthy round replans', async () => {
  for (const broken of [WBNB, TOKEN3]) {
    const { holdings, targets } = threeAssetCase();
    const chain = hubChain({ quotes: {
      [`${WBNB}:${USDT}`]: { minimum: 198n * 10n ** 18n },
      [`${USDT}:${TOKEN3}`]: { minimum: 99n * 10n ** 18n },
    } });
    const key = broken === WBNB ? `${WBNB}:${USDT}` : `${USDT}:${TOKEN3}`;
    chain.oracle.errors = { [key]: twapRevert() };
    const args = hubArgs(chain, { holdings, targets, thresholdBps: 100 });
    const blocked = await planRebalance(args);
    assert.equal(blocked.kind, 'blocked');
    assert.match(blocked.reason, /\[ORACLE_UNAVAILABLE:/);
    delete chain.oracle.errors[key];
    assert.equal(expectReady(await planRebalance(args)).steps.length, 2);
  }
});

test('#76 a TWAP failure while valuing buy allowance cannot preserve independent sells', async () => {
  const { holdings, targets } = threeAssetCase();
  const chain = hubChain({ quotes: { [`${WBNB}:${USDT}`]: { minimum: 198n * 10n ** 18n } } });
  chain.buyAllowance = twapRevert();
  const plan = await planRebalance(hubArgs(chain, { holdings, targets, thresholdBps: 100 }));
  assert.equal(plan.kind, 'blocked'); assert.match(plan.reason, /ORACLE_UNAVAILABLE/);
});

test('#76 TWAP nominal-value failure under a max-leg cap blocks both hub and pinned plans', async () => {
  for (const hub of [true, false]) {
    const chain = hubChain();
    chain.oracle.errors = { [`${WBNB}:${USDT}`]: twapRevert() };
    const input = { holdings: [holding(WBNB, 10n ** 18n, 18, PRICE_1000_USD)], targets: targetsOf(WBNB, USDT, 0), thresholdBps: 100,
      maxLegUsdE8: new Map([[WBNB, 150n * PRICE_1_USD]]) };
    if (!hub) {
      const pinned = baseChain();
      pinned.oracle.revert = twapRevert();
      const plan = await planRebalance(argsOf(pinned, input));
      assert.equal(plan.kind, 'blocked'); assert.match(plan.reason, /ORACLE_UNAVAILABLE/);
    } else {
      const plan = await planRebalance(hubArgs(chain, input));
      assert.equal(plan.kind, 'blocked'); assert.match(plan.reason, /ORACLE_UNAVAILABLE/);
    }
  }
});
for (const code of ['StaleFeed', 'InvalidAnswer', 'SourcesDisagree'] as const) {
  test(`#52 hub skips only ${code} asset and preserves a healthy buy`, async () => {
    const holdings = [holding(USDT, 200n * 10n ** 18n, 18, PRICE_1_USD)];
    const targets = [{ asset: WBNB, weightBps: 5000 }, { asset: TOKEN3, weightBps: 5000 }, { asset: USDT, weightBps: 0 }];
    const chain = hubChain({ quotes: { [`${USDT}:${TOKEN3}`]: { minimum: 99n * 10n ** 18n } } });
    chain.oracle.errors = { [`${USDT}:${WBNB}`]: secondaryRevert(code, code === 'InvalidAnswer' ? 0n : 100n) };
    const plan = expectReady(await planRebalance(hubArgs(chain, { holdings, targets, thresholdBps: 100 })));
    assert.equal(plan.steps.length, 1); assert.equal(plan.steps[0]?.tokenOut, getAddress(TOKEN3));
    assert.match(plan.rationale, new RegExp(code)); assert.doesNotMatch(plan.rationale, /private-token/);
    chain.oracle.errors[`${USDT}:${TOKEN3}`] = secondaryRevert(code, code === 'InvalidAnswer' ? -1n : 100n);
    const allBlocked = await planRebalance(hubArgs(chain, { holdings, targets, thresholdBps: 100 }));
    assert.equal(allBlocked.kind, 'blocked');
    assert.match(allBlocked.reason, new RegExp(code));
  });
}


test('#52 a faulty held feed in buyAllowance preserves independent healthy sells', async () => {
  const { holdings, targets } = threeAssetCase();
  const chain = hubChain({ quotes: { [`${WBNB}:${USDT}`]: { minimum: 198n * 10n ** 18n } } });
  chain.buyAllowance = secondaryRevert('StaleFeed');
  const plan = expectReady(await planRebalance(hubArgs(chain, { holdings, targets, thresholdBps: 100 })));
  assert.equal(plan.steps.length, 1); assert.equal(plan.steps[0]?.tokenIn, getAddress(WBNB));
  assert.match(plan.rationale, /StaleFeed/);
});

// #54: keep these RPCs real ABI round trips; fallback calldata must describe exactly the fresh quote.
function refreshFallbackFixture() {
  const abi = parseAbi([
    'function previewSwap(address,address,uint256) view returns(uint256,uint256)',
    'function venues(address) view returns(uint8,address)',
    'function getPool(address,address,uint24) view returns(address)',
    'function quoteExactInput(bytes,uint256) returns(uint256,uint160[])',
    'function numeraire() view returns(address)', 'function decimals() view returns(uint8)',
    'function balanceOf(address) view returns(uint256)', 'function buyAllowance(address) view returns(uint256,uint256,uint64)',
  ]);
  const state: { floor: bigint; nominal: bigint; pancakeOut: bigint; cash: bigint; allowed: boolean; cap: bigint; bought: bigint;
    impactTimeout?:boolean; impactQuotes?:boolean; limit: string | null; failure: string; calls: string[]; logs: string[] } = {
    floor: 100n, nominal: 105n, pancakeOut: 110n, cash: 2n ** 255n, allowed: true, cap: 1000n, bought: 0n,
    limit: '0.00000001', failure: '', calls: [], logs: [] };
  const client = createPublicClient({ transport: custom({ request: async ({ method, params }) => {
    if (method === 'eth_blockNumber') return '0x2a';
    assert.equal(method, 'eth_call'); assert.ok(Array.isArray(params));
    const raw: unknown = params[0]; assert.ok(typeof raw === 'object' && raw !== null);
    const data: unknown = Reflect.get(raw, 'data'); assert.ok(typeof data === 'string' && isHex(data));
    const call = decodeFunctionData({ abi, data }); state.calls.push(call.functionName);
    if (state.failure === call.functionName) throw new Error('RPC private-token');
    if (call.functionName === 'previewSwap') return encodeFunctionResult({ abi, functionName: call.functionName, result: [state.nominal, state.floor] });
    if (call.functionName === 'venues') return encodeFunctionResult({ abi, functionName: call.functionName, result: [state.allowed ? 1 : 0, PANCAKE_UR] });
    if (call.functionName === 'getPool') return encodeFunctionResult({ abi, functionName: call.functionName, result: call.args[2] === 500 ? WBNB_USDT_POOL : zeroAddress });
    if(call.functionName==='quoteExactInput' && state.impactTimeout && call.args[1]<100n)return new Promise<never>(()=>{});
    if (call.functionName === 'quoteExactInput') return encodeFunctionResult({ abi, functionName: call.functionName, result: [state.impactQuotes && call.args[1]<100n ? state.pancakeOut*call.args[1]/100n : state.pancakeOut, []] });
    if (call.functionName === 'balanceOf') return encodeFunctionResult({ abi, functionName: call.functionName, result: state.cash });
    if (call.functionName === 'numeraire') return encodeFunctionResult({ abi, functionName: call.functionName, result: USDT });
    if (call.functionName === 'decimals') return encodeFunctionResult({ abi, functionName: call.functionName, result: 18 });
    return encodeFunctionResult({ abi, functionName: 'buyAllowance', result: [state.cap, state.bought, 0n] });
  } }, { retryCount: 0 }) });
  const planned: PlannedStep = { tokenIn: USDT, tokenOut: WBNB, amountIn: 100n, oracleFloor: 100n,
    amountOutMin: 101n, venue: REGISTRY, data: '0x12345678' };
  const params = { publicClient: client, oracle: ORACLE, executor: EXECUTOR, account: TOKEN3,
    deadline: 2000000000n, feeBps: 0, steps: [planned], blockNumber: 42n,
    query: async () => {
      if (state.failure === 'DB') throw new Error('DB private-token');
      return { rows: state.failure === 'missing-limit' ? [] : [WBNB, TOKEN3].map((address) => ({ address, max_leg_usdt: state.limit })) };
    }, log: (line: string) => state.logs.push(line),
  };
  return { state, planned, params };
}

function minOutFixture() {
  const f = refreshFallbackFixture();
  f.state.floor = f.planned.oracleFloor = 9000n;
  f.state.pancakeOut = 10000n;
  f.planned.amountOutMin = 9950n;
  const route = { publicClient: f.params.publicClient, executor: EXECUTOR, tokenIn: USDT, tokenOut: WBNB,
    amountIn: 100n, oracleFloor: f.state.floor, minGross: f.state.floor, poolFee: 500,
    deadline: f.params.deadline, feeBps: 0, blockNumber: 42n };
  return { ...f, route };
}

test('#58 inflated aggregator quote is bounded by Pancake minus 50 bps', async () => {
  const f = minOutFixture();
  const step = await buildRoutedStep(f.route, { quoteAggregator: async () => ({
    venue: REGISTRY, data: '0x12345678', amountOut: f.state.pancakeOut * 105n / 100n }) });
  assert.equal(step?.venue, REGISTRY);
  assert.equal(step.amountOutMin, 9950n);
});

test('#58 Pancake minOut is encoded from its quoter, including the exact floor boundary', async () => {
  const f = minOutFixture();
  for (const output of [10000n, 9055n, 9010n, 9009n]) {
    f.state.pancakeOut = output;
    const step = await buildRoutedStep(f.route, { quoteAggregator: async () => null });
    assert.ok(step);
    const expected = output === 10000n ? 9950n : amountOutMinWithBuffer(f.state.floor);
    assert.equal(step.amountOutMin, expected);
    assert.equal(decodeStepInput(step).amountOutMin, expected);
  }
});

test('#58 no Pancake quote uses the aggregator quote and rejects an absent or zero quote', async () => {
  const f = minOutFixture(); f.state.failure = 'quoteExactInput';
  const step = await buildRoutedStep(f.route, { quoteAggregator: async () => ({ venue: REGISTRY,
    data: '0x12345678', amountOut: 10500n }) });
  assert.equal(step?.amountOutMin, 10447n);
  for (const quote of [null, { venue: REGISTRY, data: '0x12345678' as const, amountOut: 0n }]) {
    assert.equal(await buildRoutedStep(f.route, { quoteAggregator: async () => quote }), null);
  }
});

test('#58 below-floor Pancake and a failed aggregator cannot produce a step', async () => {
  const f = minOutFixture();
  for (const output of [0n, 9008n]) {
    f.state.pancakeOut = output;
    assert.equal(await buildRoutedStep(f.route, { quoteAggregator: async () => null }), null);
  }
});

test('#58 quote discount floors integer units, keeps the floor and handles uint256 output', () => {
  assert.equal(quoteBoundMinimum(1n, 101n), 100n);
  assert.equal(quoteBoundMinimum(101n, 101n), 101n);
  assert.equal(quoteBoundMinimum(100n, 0n), 100n);
  const max = (1n << 256n) - 1n;
  assert.equal(quoteBoundMinimum(1n, max), max * 9950n / 10000n);
  assert.equal(quoteBoundMinimum(9000n, 10500n, 8000n), 9000n);
});

test('#58 below-floor aggregator falls back to a quote-bound Pancake step', async () => {
  const f = minOutFixture();
  const step = await buildRoutedStep(f.route, { quoteAggregator: async () => ({ venue: REGISTRY,
    data: '0x12345678', amountOut: f.state.floor - 1n }) });
  assert.equal(step?.venue, PANCAKE_UR);
  assert.equal(step.amountOutMin, 9950n);
});

test('#58 refresh keeps both aggregator and Pancake execution minima bound to fresh quotes', async () => {
  const f = minOutFixture();
  const aggregator = await refreshFloors({ ...f.params, quoteAggregator: async () => ({ venue: REGISTRY,
    data: '0x87654321', amountOut: 10500n }) });
  assert.ok(aggregator.ok);
  assert.equal(aggregator.steps[0]?.amountOutMin, 9950n);
  assert.equal(aggregator.refreshes[0]?.freshAmountOutMin, 9950n);
  assert.match(aggregator.note, /amountOutMin 9950 → 9950/);
  const pancake = await buildRoutedStep(f.route, { quoteAggregator: async () => null }); assert.ok(pancake);
  const refreshed = await refreshFloors({ ...f.params, steps: [pancake] });
  assert.ok(refreshed.ok);
  assert.equal(refreshed.steps[0]?.amountOutMin, 9950n);
  const refreshedStep = refreshed.steps[0]; assert.ok(refreshedStep);
  assert.equal(decodeStepInput(refreshedStep).amountOutMin, 9950n);
  f.state.pancakeOut = 9990n;
  const moved = await refreshFloors({ ...f.params, steps: [pancake] });
  assert.ok(moved.ok);
  assert.equal(moved.steps[0]?.amountOutMin, 9940n, 'use a fresh quote when spot moves, not the old bound');
  for (const output of [0n, 9008n]) {
    f.state.pancakeOut = output;
    assert.equal((await refreshFloors({ ...f.params, steps: [pancake] })).ok, false);
  }
  f.state.failure = 'quoteExactInput';
  const failed = await refreshFloors({ ...f.params, steps: [pancake] });
  assert.equal(failed.ok, false);
  assert.doesNotMatch(JSON.stringify(failed), /private-token/);
});

test('#58 refresh fallback to Pancake retains the quote-bound minOut', async () => {
  const f = minOutFixture();
  const result = await refreshFloors({ ...f.params, quoteAggregator: async () => null });
  assert.ok(result.ok);
  const step = result.steps[0]; assert.ok(step);
  assert.equal(step.venue, PANCAKE_UR);
  assert.equal(step.amountOutMin, 9950n);
  assert.equal(decodeStepInput(step).amountOutMin, 9950n);
});

test('#58 Kyber builds with the same Pancake-capped minimum and ignores an inflated build amountOut', async () => {
  const f = kyberFixture();
  f.summary.amountOut = '10500'; f.built.data.amountOut = '999999';
  const quoted = await quoteKyberSwap({ ...f.request, minimum: 9000n, pancakeOut: 10000n }, { fetch: f.fetcher });
  assert.equal(quoted?.amountOut, 10500n);
  const build = f.state.requests[1]; assert.ok(build && typeof build.init.body === 'string');
  const body: unknown = JSON.parse(build.init.body);
  assert.ok(typeof body === 'object' && body !== null);
  const slippage: unknown = Reflect.get(body, 'slippageTolerance'); assert.equal(slippage, 523);
  assert.ok(10500n * (10000n - BigInt(Number(slippage))) / 10000n >= 9950n);
});

for (const value of ['0', '9', '201', '-1', '50.5', 'NaN', 'Infinity', '', 'private-token']) {
  test(`#58 invalid tolerance fails at module startup (${value === 'private-token' ? 'redacted' : value})`, () => {
    const result = spawnSync(process.execPath, ['-e', "import './src/rebalance-plan.ts'"], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, SWAP_SLIPPAGE_BPS: value },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SWAP_SLIPPAGE_BPS/);
    assert.doesNotMatch(result.stderr, /private-token/);
  });
}

for (const bps of [10, 200]) {
  test(`#58 tolerance boundary ${bps} bps is accepted and used`, () => {
    const result = spawnSync(process.execPath, ['-e', "import { quoteBoundMinimum } from './src/swap-slippage.ts'; console.log(quoteBoundMinimum(1n,10000n).toString())"], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, SWAP_SLIPPAGE_BPS: String(bps) },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), String(10000 - bps));
  });
}

for (const failure of ['api-failed', 'below-floor', 'venue-changed'] as const) {
  test(`#54 ${failure} rebuilds only the failed leg on Pancake at the fresh buffered floor`, async () => {
    const f = refreshFallbackFixture();
    const healthy = { ...f.planned, tokenOut: TOKEN3, data: '0x87654321' as const };
    const result = await refreshFloors({ ...f.params, steps: [f.planned, healthy], quoteAggregator: async (request) => {
      if (request.tokenOut === TOKEN3) return { venue: REGISTRY, data: healthy.data, amountOut: request.minimum };
      if (failure === 'api-failed') return null;
      return { venue: failure === 'venue-changed' ? TOKEN3 : REGISTRY, data: '0xaabbccdd', amountOut: failure === 'below-floor' ? request.minimum - 1n : request.minimum };
    } });
    assert.ok(result.ok);
    const fallback = result.steps[0]; assert.ok(fallback);
    assert.equal(fallback.venue, PANCAKE_UR);
    const input = decodeStepInput(fallback);
    assert.equal(input.recipient, getAddress(EXECUTOR)); assert.equal(input.amountIn, f.planned.amountIn);
    assert.equal(input.amountOutMin, 109n);
    assert.equal(fallback.amountOutMin, input.amountOutMin);
    assert.equal(fallback.oracleFloor, f.state.floor);
    assert.equal(result.steps[1]?.venue, REGISTRY); assert.equal(result.steps[1]?.data, healthy.data);
    assert.ok(f.state.logs.some((line) => line.includes(failure)));
    assert.doesNotMatch(JSON.stringify(result, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value) + f.state.logs.join(), /private-token/);
  });
}

for (const failure of ['quoteExactInput', 'venues', 'numeraire', 'decimals', 'buyAllowance', 'balanceOf', 'DB', 'missing-limit']) {
  test(`#54 fallback fails closed on ${failure} without exposing errors`, async () => {
    const f = refreshFallbackFixture(); f.state.failure = failure;
    const result = await refreshFloors({ ...f.params, quoteAggregator: async () => null });
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value) + f.state.logs.join(), /private-token/);
  });
}

test('#54 Pancake exact buffered floor passes; zero/below floor and removed venue block', async () => {
  for (const output of [0n, 100n, 101n]) {
    const f = refreshFallbackFixture(); f.state.pancakeOut = output;
    assert.equal((await refreshFloors({ ...f.params, quoteAggregator: async () => null })).ok, output === 101n);
  }
  const f = refreshFallbackFixture(); f.state.allowed = false;
  assert.equal((await refreshFloors({ ...f.params, quoteAggregator: async () => null })).ok, false);
});

test('#54 rebuilt whole plan rechecks total buy allowance with 98% cap and exact boundary', async () => {
  for (const bought of [779n, 780n, 781n, 980n]) {
    const f = refreshFallbackFixture(); f.state.bought = bought;
    const result = await refreshFloors({ ...f.params, steps: [f.planned, { ...f.planned, tokenOut: TOKEN3 }], quoteAggregator: async () => null });
    assert.equal(result.ok, bought <= 780n);
  }
});

test('#54 per-leg cap checks original input for buys and fresh nominal quote for sells', async () => {
  for (const sell of [false, true]) for (const cap of ['0', '0.00000000', '0.00000001', null]) {
    const f = refreshFallbackFixture(); f.state.limit = cap;
    const step = sell ? { ...f.planned, tokenIn: WBNB, tokenOut: USDT } : f.planned;
    const result = await refreshFloors({ ...f.params, steps: [step], quoteAggregator: async () => null });
    assert.equal(result.ok, cap === null || cap === '0.00000001');
  }
});

test('#54 fallback rechecks nominal sell cap at equality and one raw unit over it', async () => {
  for (const nominal of [100n * 10n ** 8n, 100n * 10n ** 8n + 1n]) {
    const f = refreshFallbackFixture(); f.state.nominal = nominal;
    const result = await refreshFloors({ ...f.params, steps: [{ ...f.planned, tokenIn: WBNB, tokenOut: USDT }], quoteAggregator: async () => null });
    assert.equal(result.ok, nominal === 100n * 10n ** 8n);
  }
});

for (const scenario of ['API', 'RPC', 'timeout', 'route-floor', 'build-floor', 'removed', 'target'] as const) {
  test(`#54 real Kyber ${scenario} reports only its diagnostic category`, async () => {
    const f = kyberFixture(); const reasons: string[] = [];
    if (scenario === 'RPC') f.state.rpcFailure = true;
    if (scenario === 'route-floor') f.summary.amountOut = '109';
    if (scenario === 'build-floor') f.built.data.amountOut = '109';
    if (scenario === 'removed') f.state.kind = 0;
    if (scenario === 'target') f.built.data.routerAddress = TOKEN3;
    const result = await quoteKyberSwap({ ...f.request, onFailure: (reason) => reasons.push(reason) }, {
      fetch: scenario === 'timeout' ? async () => new Promise<Response>(() => {}) :
        scenario === 'API' ? async () => new Response('private-token', { status: 503 }) : f.fetcher,
      timeoutMs: 20,
    });
    assert.equal(result, null);
    assert.deepEqual(reasons, [scenario === 'route-floor' || scenario === 'build-floor' ? 'below-floor' :
      scenario === 'removed' || scenario === 'target' ? 'venue-changed' : 'api-failed']);
  });
}

test('#54 real null Kyber diagnostic reaches fallback log for floor and removed venue', async () => {
  for (const removed of [false, true]) {
    const f = refreshFallbackFixture(); const kyber = kyberFixture();
    kyber.request.minimum = 101n;
    if (removed) kyber.state.kind = 0; else kyber.summary.amountOut = '100';
    const result = await refreshFloors({ ...f.params,
      quoteAggregator: (request) => quoteKyberSwap({ ...kyber.request, onFailure: request.onFailure }, { fetch: kyber.fetcher }) });
    assert.ok(result.ok);
    assert.match(f.state.logs.join(), new RegExp(removed ? 'venue-changed' : 'below-floor'));
  }
});

test('#54 fallback preserves the floor collapse guard and blocks missing account', async () => {
  const f = refreshFallbackFixture(); f.state.floor = 99n;
  const collapsed = await refreshFloors({ ...f.params, quoteAggregator: async () => null });
  assert.ok(!collapsed.ok); assert.equal(collapsed.kind, 'floor-collapsed');
  f.state.floor = 100n;
  assert.equal((await refreshFloors({ ...f.params, account: undefined, quoteAggregator: async () => null })).ok, false);
});

test('#54 thrown quote falls back and a non-cooperative Pancake RPC terminates safely', { timeout: 10000 }, async () => {
  const f = refreshFallbackFixture();
  const result = await refreshFloors({ ...f.params, quoteAggregator: async () => { throw new Error('API private-token'); } });
  assert.ok(result.ok); assert.match(f.state.logs.join(), /api-failed/); assert.doesNotMatch(f.state.logs.join(), /private-token/);
  const client: PublicClient = { ...f.params.publicClient, call: async () => new Promise<never>(() => {}) };
  const stalled = await refreshFloors({ ...f.params, publicClient: client, quoteAggregator: async () => null });
  assert.equal(stalled.ok, false);
});

test('#54 fallback checks untouched legs against their own cap and buys at the raw cap boundary', async () => {
  const rawCap = 10n ** 10n;
  for (const amountIn of [rawCap, rawCap + 1n]) {
    const f = refreshFallbackFixture(); f.state.cap = 10n ** 20n;
    const healthy = { ...f.planned, tokenOut: TOKEN3, amountIn };
    const result = await refreshFloors({ ...f.params, steps: [f.planned, healthy], quoteAggregator: async (request) =>
      request.tokenOut === TOKEN3 ? { venue: REGISTRY, data: '0x87654321', amountOut: request.minimum } : null });
    assert.equal(result.ok, amountIn === rawCap);
    if (!result.ok) assert.match(result.reason, /MAX_LEG_EXCEEDED/);
  }
});

test('#54 fallback amountIn rejects zero and uint160 overflow and accepts uint160 max', async () => {
  const max = 2n ** 160n - 1n;
  for (const amountIn of [0n, max, max + 1n]) {
    const f = refreshFallbackFixture(); f.state.limit = null; f.state.cap = 2n ** 255n;
    const result = await refreshFloors({ ...f.params, steps: [{ ...f.planned, amountIn }], quoteAggregator: async () => null });
    assert.equal(result.ok, amountIn === max);
  }
});

test('#54 rebuilt buys must also fit fresh cash plus prior net sell floors', async () => {
  for (const cash of [91n, 92n, 93n]) {
    const f = refreshFallbackFixture(); f.state.cash = cash;
    const result = await refreshFloors({ ...f.params, feeBps: 100,
      steps: [{ ...f.planned, tokenIn: WBNB, tokenOut: USDT }, { ...f.planned, amountIn: 200n }], quoteAggregator: async () => null });
    // Quote-bound gross = floor(110 * 9950/10000) = 109; net after 100bps fee = 108.
    assert.equal(result.ok, cash + 108n >= 200n);
  }
});


const THRESHOLD_CASH = '0x55d398326f99059ff775485246999027b3197955';
const THRESHOLD_ASSET = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';

test('#75 minimum deposit includes the cash weight and rounds up exactly (50 / 80 / skew)', () => {
  const policy = loadTradingConfig({MIN_STEP_USD_E8:'500000000'});
  assert.equal(minimumDepositUsdtWei([{ asset: THRESHOLD_CASH, weightBps: 9000 }, { asset: THRESHOLD_ASSET, weightBps: 1000 }], THRESHOLD_CASH, policy), 50n * 10n ** 18n);
  const equal: TargetWeight[] = Array.from({ length: 15 }, (_, i) => ({ asset: `0x${(i + 1).toString(16).padStart(40, '0')}`, weightBps: 625 }));
  assert.equal(minimumDepositUsdtWei([...equal, { asset: THRESHOLD_CASH, weightBps: 625 }], THRESHOLD_CASH, policy), 80n * 10n ** 18n);
  const skew = minimumDepositUsdtWei([{ asset: THRESHOLD_ASSET, weightBps: 333 }, { asset: THRESHOLD_CASH, weightBps: 9667 }], THRESHOLD_CASH, policy);
  assert.equal(skew, (5n * 10n ** 18n * 10000n + 332n) / 333n);
  assert.throws(() => minimumDepositUsdtWei([{ asset: THRESHOLD_ASSET, weightBps: 0 }], THRESHOLD_CASH, policy));
});

test('#75 ordinary step/batch equality passes; zero and just below wait; exit dust is exempt', () => {
  const policy = loadTradingConfig({});
  for (const [legs, expected] of [
    [[1n, 49n], null], [[4n, 46n], null], [[50n], null], [[0n], 'BELOW_MIN_STEP'], [[49n], 'BELOW_MIN_BATCH'],
  ] as const) {
    const nominal = legs.map((value) => value * 100000000n);
    const reason = tradeMinimumReason(nominal, 'ordinary', policy);
    if (expected === null) assert.equal(reason, null);
    else assert.ok(reason?.includes(expected));
    assert.equal(tradeMinimumReason(nominal, 'exit', policy), null);
  }
  const third = 50n * 10n ** 18n / 3n;
  assert.equal(tradeMinimumReason([third, third, third + 2n], 'ordinary', policy, 18), null, 'sum before rounding: three fractional legs total exactly 50');
  assert.match(tradeMinimumReason([third, third, third + 1n], 'ordinary', policy, 18) ?? '', /BELOW_MIN_BATCH/);
});

test('#75 configurable integer thresholds and budgets preserve zero; invalid settings never echo input', () => {
  const config = loadTradingConfig({ MIN_STEP_USD_E8: '0', MIN_BATCH_USD_E8: '0', MIN_DEPOSIT_USD_E8: '0', ACCOUNT_DAILY_GAS: '0', ACCOUNT_DAILY_GAS_USD_E8: '0' });
  assert.equal(config.dailyGas, 0n);
  assert.equal(config.dailyUsdE8, 0n);
  assert.equal(tradeMinimumReason([0n], 'ordinary', config), null);
  for (const name of ['MIN_STEP_USD_E8', 'MIN_BATCH_USD_E8', 'MIN_DEPOSIT_USD_E8', 'ACCOUNT_DAILY_GAS', 'ACCOUNT_DAILY_GAS_USD_E8']) {
    for (const value of ['-1', '1.5', 'secret-token']) assert.throws(() => loadTradingConfig({ [name]: value }), (error: unknown) => error instanceof Error && error.message.includes(name) && !error.message.includes(value));
  }
});

function oracleFixture() {
  const abi = parseAbi(['function oracle() view returns(address)', 'function numeraire() view returns(address)',
    'function decimals() view returns(uint8)', 'function previewSwap(address,address,uint256) view returns(uint256,uint256)',
    'function minBatchFee() view returns(uint256)', 'function minFeeTopUp(uint256,uint256) view returns(uint256)',
    'function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)',
    'function effectiveFeeBps(uint256) view returns(uint16)']);
  const state = { fail: '', cash: 10027n * 10n ** 16n, allowance: 10027n * 10n ** 16n, calls: 0 };
  const client = createPublicClient({ transport: custom({ request: async ({ method, params }) => {
    if (method === 'eth_blockNumber') return '0x7b';
    assert.equal(method, 'eth_call'); assert.ok(Array.isArray(params));
    const call: unknown = params[0]; assert.ok(typeof call === 'object' && call !== null);
    const data: unknown = Reflect.get(call, 'data'); assert.ok(typeof data === 'string' && isHex(data));
    const decoded = decodeFunctionData({ abi, data });
    state.calls++;
    assert.equal(params[1], '0x7b', 'all price/funding reads must share the observation block');
    if (state.fail === decoded.functionName) throw new Error('private RPC token');
    switch (decoded.functionName) {
      case 'oracle': case 'numeraire': return encodeFunctionResult({ abi, functionName: decoded.functionName, result: getAddress(THRESHOLD_CASH) });
      case 'decimals': return encodeFunctionResult({ abi, functionName: 'decimals', result: 18 });
      case 'minBatchFee': return encodeFunctionResult({ abi, functionName: 'minBatchFee', result: 3n * 10n ** 17n });
      case 'minFeeTopUp': return encodeFunctionResult({ abi, functionName: 'minFeeTopUp', result: 27n * 10n ** 16n });
      case 'effectiveFeeBps': return encodeFunctionResult({ abi, functionName: 'effectiveFeeBps', result: 10 });
      case 'balanceOf': case 'allowance': return encodeFunctionResult({ abi, functionName: decoded.functionName, result: decoded.functionName === 'balanceOf' ? state.cash : state.allowance });
      case 'previewSwap': {
        const quoted = decoded.args[2] * 600n + 123456789n;
        return encodeFunctionResult({ abi, functionName: 'previewSwap', result: [quoted, quoted * 99n / 100n] });
      }
    }
  } }, { retryCount: 0 }) });
  const step: PlannedStep = { tokenIn: getAddress(THRESHOLD_CASH), tokenOut: getAddress(THRESHOLD_ASSET), amountIn: 100n * 10n ** 18n,
    amountOutMin: 1n, oracleFloor: 1n, venue: getAddress(THRESHOLD_CASH), data: '0x' };
  return { state, client, step };
}

test('#75 gas valuation preserves every oracle decimal, records block/source; missing price/RPC fail closed', async () => {
  const f = oracleFixture();
  const price = await readNativeBudgetPrice(f.client, getAddress(THRESHOLD_CASH), 1337);
  assert.equal(price.nativePrice, 600n * 10n ** 18n + 123456789n);
  assert.equal(price.priceDecimals, 18);
  assert.match(price.priceSource, /:block:123$/);
  for (const failure of ['oracle', 'numeraire', 'previewSwap', 'decimals']) {
    f.state.fail = failure;
    await assert.rejects(readNativeBudgetPrice(f.client, getAddress(THRESHOLD_CASH), 1337), (error: unknown) => error instanceof Error && error.message.includes('GAS_BUDGET_PRICE_UNAVAILABLE') && !error.message.includes('private RPC token'));
  }
});

test('#75 final buy funding includes minimum-fee balance AND aggregate allowance; equality passes, one wei below blocks', async () => {
  const f = oracleFixture();
  const args = { client: f.client, executor: getAddress(THRESHOLD_CASH), account: getAddress(THRESHOLD_ASSET), registry: getAddress(THRESHOLD_CASH),
    strategyId: 1n, steps: [f.step], numeraire: getAddress(THRESHOLD_CASH), blockNumber: 123n };
  await checkBuyFeeReserve(args);
  f.state.cash--;
  await assert.rejects(checkBuyFeeReserve(args), /MIN_FEE_RESERVE/);
  f.state.cash++; f.state.allowance--;
  await assert.rejects(checkBuyFeeReserve(args), /MIN_FEE_RESERVE/);
  f.state.allowance++;
  for (const failure of ['minBatchFee', 'minFeeTopUp', 'balanceOf', 'allowance', 'effectiveFeeBps']) {
    f.state.fail = failure;
    await assert.rejects(checkBuyFeeReserve(args), /MIN_FEE_RESERVE/);
  }
  const reads = f.state.calls;
  await checkBuyFeeReserve({ ...args, steps: [{ ...f.step, tokenIn: f.step.tokenOut, tokenOut: f.step.tokenIn }] });
  assert.equal(f.state.calls, reads, 'sales-only exit never waits for minimum-fee funding');
});

test('#75 ordinary oracle minimum validation fails closed; exit dust bypasses the reads', async () => {
  const f = oracleFixture();
  f.state.fail = 'oracle';
  assert.match(await checkTradeMinimums(f.client, getAddress(THRESHOLD_CASH), [f.step], 'ordinary', 123n) ?? '', /TRADE_MINIMUM_UNAVAILABLE/);
  const reads = f.state.calls;
  assert.equal(await checkTradeMinimums(f.client, getAddress(THRESHOLD_CASH), [{ ...f.step, amountIn: 1n }], 'exit', 123n), null);
  assert.equal(f.state.calls, reads);
});

test('#83 new-money quote preserves every exact-input component; missing price/depth blocks the whole basket', async () => {
  const U=10n**18n;
  const chain=hubChain();
  chain.routeQuotes=true;
  chain.rate={rateE18:U,slippageBps:100};
  chain.poolState={sqrtPriceX96:1n<<96n,liquidity:10n**30n,token0:USDT};
  const params={publicClient:stubClient(chain),executor:EXECUTOR_MULTI,oracle:ROUTER,registry:REGISTRY,strategyId:1n,
    blockNumber:chain.block.number,cash:USDT,inputs:{[WBNB.toLowerCase()]:(25n*U).toString(),[TOKEN3.toLowerCase()]:(25n*U).toString()},deadline:1900000000n};
  const plan=await quoteNewMoney(params,{quoteAggregator:async()=>null});
  assert.equal(plan.kind,'ready',plan.kind==='blocked'?plan.reason:'expected non-empty buy basket');
  if(plan.kind==='ready')assert.deepEqual(plan.steps.map(s=>s.amountIn),[25n*U,25n*U]);
  chain.oracle.pairs={ [WBNB.toLowerCase()]:{oracle:ORACLE_WBNB_USDT,pool:WBNB_USDT_POOL,fee:500} };
  const missing=await quoteNewMoney(params,{quoteAggregator:async()=>null});assert.equal(missing.kind,'blocked');
  chain.poolState=undefined;
  assert.equal((await quoteNewMoney({...params,inputs:{[WBNB.toLowerCase()]:(50n*U).toString()}},{quoteAggregator:async()=>null})).kind,'blocked');
  await assert.rejects(newMoneyDepthCap(params.publicClient,ROUTER,USDT,WBNB,50n*U,chain.block.number));
});

test('new-money quote: components are quoted together, and the first component in basket order still decides what the basket reports', async () => {
  const U=10n**18n;
  const amount=(25n*U).toString();
  const quote=async(order:readonly Address[],setup:(chain:StubChain)=>void)=>{
    const chain=hubChain();
    chain.routeQuotes=true;
    chain.poolState={sqrtPriceX96:1n<<96n,liquidity:10n**30n,token0:USDT};
    setup(chain);
    return quoteNewMoney({publicClient:stubClient(chain),executor:EXECUTOR_MULTI,oracle:ROUTER,registry:REGISTRY,strategyId:1n,
      blockNumber:chain.block.number,cash:USDT,inputs:Object.fromEntries(order.map(a=>[a.toLowerCase(),amount])),deadline:1900000000n},{quoteAggregator:async()=>null});
  };
  // TOKEN3 has no pool (blocked: pool data); TOKEN6's oracle cannot quote (blocked: no price). Whichever comes first in the basket is reported.
  const noPoolNoPrice=(chain:StubChain)=>{
    chain.oracle.pairs={[WBNB.toLowerCase()]:{oracle:ORACLE_WBNB_USDT,pool:WBNB_USDT_POOL,fee:500},[TOKEN6.toLowerCase()]:{oracle:ORACLE_TOKEN6_USDT,pool:TOKEN6_USDT_POOL,fee:100}};
    chain.oracle.errors={[`${USDT.toLowerCase()}:${TOKEN6.toLowerCase()}`]:new Error('execution reverted: UnsupportedRoute()')};
  };
  assert.deepEqual(await quote([TOKEN3,TOKEN6],noPoolNoPrice),{kind:'blocked',reason:'[BASKET_QUOTE_UNAVAILABLE] 整籃子等待池子資料'});
  assert.deepEqual(await quote([TOKEN6,TOKEN3],noPoolNoPrice),{kind:'blocked',reason:'[BASKET_QUOTE_UNAVAILABLE] 任一成分缺價，整籃子等待'});
  // WBNB's oracle reports TwapUnavailable (the quote throws); TOKEN3 has no pool (blocked). A throw that comes first aborts
  // the basket with the generic reason; a blocked component that comes first is reported even though a later one throws.
  const throwsAndNoPool=(chain:StubChain)=>{
    chain.oracle.pairs={[WBNB.toLowerCase()]:{oracle:ORACLE_WBNB_USDT,pool:WBNB_USDT_POOL,fee:500}};
    chain.oracle.errors={[`${USDT.toLowerCase()}:${WBNB.toLowerCase()}`]:twapRevert()};
  };
  assert.deepEqual(await quote([WBNB,TOKEN3],throwsAndNoPool),{kind:'blocked',reason:'[BASKET_QUOTE_UNAVAILABLE] RPC／報價資料不可用，整籃子等待'});
  assert.deepEqual(await quote([TOKEN3,WBNB],throwsAndNoPool),{kind:'blocked',reason:'[BASKET_QUOTE_UNAVAILABLE] 整籃子等待池子資料'});
});

test('#83 new-money fee upper bound includes conservative depth capacity and zero cap',async()=>{
  const U=10n**18n,chain=hubChain();chain.rate={rateE18:U,slippageBps:100};
  chain.poolState={sqrtPriceX96:1n<<96n,liquidity:100000n*U,token0:USDT};
  const client=stubClient(chain);
  assert.equal(await newMoneyDepthCap(client,ROUTER,USDT,WBNB,0n,chain.block.number),0n);
  const cap=await newMoneyDepthCap(client,ROUTER,USDT,WBNB,10000n*U,chain.block.number);
  assert.ok(cap>0n);assert.ok(cap<10000n*U);
});

test('#92 a 1% pool gets 80 bps of price impact in addition to its fee; oracle floor still caps capacity',async()=>{
  const U=10n**18n,chain=hubChain({pairs:{[WBNB]:{oracle:ORACLE_WBNB_USDT,pool:WBNB_USDT_POOL,fee:10000}}});
  chain.rate={rateE18:U,slippageBps:300};
  chain.poolState={sqrtPriceX96:1n<<96n,liquidity:100000n*U,token0:USDT};
  const client=stubClient(chain),upper=1000n*U;
  const cap=await newMoneyDepthCap(client,ROUTER,USDT,WBNB,upper,chain.block.number);
  assert.ok(cap>U,'1% fee alone must not reduce the cap below the 1-USDT minimum');
  assert.ok(cap<upper,'large input must still shrink at fee + 80 bps');
  const cost=estimateImpact({...chain.poolState,tokenInIsToken0:true,feeUnits:10000},cap,cap).impactBps;
  assert.ok(cost<=180);
  chain.rate.slippageBps=120;
  const tighter=await newMoneyDepthCap(client,ROUTER,USDT,WBNB,upper,chain.block.number);
  assert.ok(tighter<cap,'maxSlippageBps below fee + 80 must tighten capacity');
  assert.ok(estimateImpact({...chain.poolState,tokenInIsToken0:true,feeUnits:10000},tighter,tighter).impactBps<=120);
  chain.rate.slippageBps=50;
  assert.ok(await newMoneyDepthCap(client,ROUTER,USDT,WBNB,upper,chain.block.number)<U,'fee above oracle tolerance must wait');
});

test('#92 actual buy/sell quotes obey fee + 80, the tighter oracle floor, and exact buffered boundaries',async()=>{
  for(const poolFee of [0,500,2500,10000])for(const sell of [false,true]){
    const f=minOutFixture(),budget=Math.min(80+poolFee/100,85);
    const policyFloor=10000n-BigInt(budget),minimum=amountOutMinWithBuffer(policyFloor);
    const route={...f.route,poolFee,oracleQuoted:10000n,...(sell?{tokenIn:WBNB,tokenOut:USDT}:{})};
    f.state.pancakeOut=minimum;
    const step=await buildRoutedStep(route,{quoteAggregator:async()=>null});
    assert.ok(step);assert.equal(step.amountOutMin,minimum);assert.equal(decodeStepInput(step).amountOutMin,minimum);
    assert.equal(step.oracleFloor,9000n);assert.equal(step.costBudgetBps,budget);
    f.state.pancakeOut--;
    assert.equal(await buildRoutedStep(route,{quoteAggregator:async()=>null}),null,'one raw unit below policy must wait');
    const tighter={...route,oracleFloor:9900n,minGross:9900n};
    const tightMinimum=amountOutMinWithBuffer(budget<100?policyFloor:9900n);
    f.state.pancakeOut=tightMinimum;
    assert.ok(await buildRoutedStep(tighter,{quoteAggregator:async()=>null}));
    f.state.pancakeOut--;
    assert.equal(await buildRoutedStep(tighter,{quoteAggregator:async()=>null}),null);
  }
  const f=minOutFixture();f.state.failure='quoteExactInput';
  const params={...f.route,poolFee:10000,oracleQuoted:10000n};
  const minimum=amountOutMinWithBuffer(9820n);
  for(const output of [minimum-1n,minimum]){
    const step=await buildRoutedStep(params,{quoteAggregator:async()=>({venue:REGISTRY,data:'0x12345678',amountOut:output})});
    assert.equal(step!==null,output===minimum,'opaque aggregator must pass the same actual-quote cost floor');
  }
  for(const invalid of [0n,-1n])await assert.rejects(buildRoutedStep({...params,oracleQuoted:invalid},{quoteAggregator:async()=>null}));
  await assert.rejects(buildRoutedStep({...params,poolFee:-1},{quoteAggregator:async()=>null}));
});

test('#92 fresh quotes and aggregator-to-Pancake fallback retain the cost bound; invalid data and RPC failure block',async()=>{
  const f=minOutFixture();f.state.nominal=10000n;f.state.impactQuotes=true;
  const route={...f.route,poolFee:10000,oracleQuoted:10000n};
  const initial=await buildRoutedStep(route,{quoteAggregator:async()=>null});assert.ok(initial);
  const minimum=amountOutMinWithBuffer(9915n);
  f.state.pancakeOut=minimum;
  const fresh=await refreshFloors({...f.params,steps:[initial]});assert.ok(fresh.ok);
  assert.equal(fresh.steps[0]?.costBudgetBps,85);assert.equal(fresh.steps[0]?.amountOutMin,minimum);
  f.state.pancakeOut--;assert.equal((await refreshFloors({...f.params,steps:[initial]})).ok,false);
  f.state.pancakeOut=minimum;
  const opaque={...initial,venue:REGISTRY,data:'0x12345678' as const};
  const fallback=await refreshFloors({...f.params,steps:[opaque],quoteAggregator:async()=>null});assert.ok(fallback.ok);
  assert.equal(fallback.steps[0]?.costBudgetBps,85);assert.equal(fallback.steps[0]?.amountOutMin,minimum);
  for(const failure of ['previewSwap','quoteExactInput']){
    f.state.failure=failure;assert.equal((await refreshFloors({...f.params,steps:[initial]})).ok,false);
  }
  f.state.failure='';f.state.nominal=0n;assert.equal((await refreshFloors({...f.params,steps:[initial]})).ok,false);
});


test('#96 depth capacity includes platform fee and buffer before freezing the job',async()=>{
  const U=10n**18n,chain=hubChain({pairs:{[WBNB]:{oracle:ORACLE_WBNB_USDT,pool:WBNB_USDT_POOL,fee:10000}}});
  chain.rate={rateE18:U,slippageBps:300};chain.registry.feeBps=10;chain.routeQuotes=true;chain.ammQuotes=true;
  chain.poolState={sqrtPriceX96:1n<<96n,liquidity:100000n*U,token0:USDT};
  const client=stubClient(chain),upper=1000n*U;
  const cap=await newMoneyDepthCap(client,ROUTER,USDT,WBNB,upper,chain.block.number,10);
  assert.ok(cap>50n*U&&cap<upper);
  const params={publicClient:client,executor:EXECUTOR_MULTI,oracle:ROUTER,registry:REGISTRY,strategyId:1n,blockNumber:chain.block.number,cash:USDT,deadline:1900000000n};
  const quote=await quoteNewMoney({...params,inputs:{[WBNB]:cap.toString()}},{quoteAggregator:async()=>null});
  assert.equal(quote.kind,'ready',quote.kind==='blocked'?quote.reason:'expected executable capacity');
  const large=await quoteNewMoney({...params,inputs:{[WBNB]:upper.toString()}},{quoteAggregator:async()=>null});
  assert.equal(large.kind,'blocked');if(large.kind==='blocked')assert.match(large.reason,/BASKET_DEPTH/);
});

test('#96 fresh original path independently rejects over-80 impact despite a loose reference-pool cost budget',async()=>{
  const U=10n**18n,chain=hubChain();chain.rate={rateE18:U,slippageBps:300};chain.routeQuotes=true;chain.ammQuotes=true;
  chain.poolState={sqrtPriceX96:1n<<96n,liquidity:100000n*U,token0:USDT};
  const step={...buildStep({executor:EXECUTOR_MULTI,tokenIn:USDT,tokenOut:WBNB,amountIn:1200n*U,oracleFloor:1164n*U,minGross:1164n*U,poolFee:500}),costBudgetBps:180};
  const result=await refreshFloors({publicClient:stubClient(chain),oracle:ROUTER,steps:[step],feeBps:0,blockNumber:chain.block.number});
  assert.equal(result.ok,false,'the 5-bps actual path has >80 bps impact, even if oracle and original reference fee permit it');
});

test('#96 default ordinary step minimum is 1 USDT and per-asset hold batches count reserved fees',async()=>{
  assert.equal(loadTradingConfig({}).minStepUsdE8,100000000n);
  const U=10n**18n,f=oracleFixture();
  f.step.amountIn=4973n*U/100n;
  assert.equal(await checkTradeMinimums(f.client,getAddress(THRESHOLD_CASH),[f.step],'ordinary',123n,50n*U),null);
});
test('#118 sender minimum accepts schema2 ten including fees, rejects 9.99, and retains legacy/all-hold fifty',async()=>{
  const U=10n**18n,f=oracleFixture(),reserve=27n*U/100n;
  for(const budget of [999n*U/100n,10n*U-1n,10n*U]){
    const step={...f.step,amountIn:budget-reserve};
    const result=await checkTradeMinimums(f.client,getAddress(THRESHOLD_CASH),[step],'ordinary',123n,budget);
    assert.equal(result===null,budget===10n*U);
    assert.match(await checkTradeMinimums(f.client,getAddress(THRESHOLD_CASH),[step],'ordinary',123n)??'',/BELOW_MIN_BATCH/);
    assert.match(await checkTradeMinimums(f.client,getAddress(THRESHOLD_CASH),[step],'ordinary',123n,undefined,undefined,reserve)??'',/BELOW_MIN_BATCH/);
  }
  const tiny={...f.step,amountIn:U/4n},large={...f.step,tokenOut:TOKEN3,amountIn:10n*U-U/4n-reserve};
  assert.match(await checkTradeMinimums(f.client,getAddress(THRESHOLD_CASH),[tiny,large],'ordinary',123n,10n*U)??'',/BELOW_MIN_STEP/);
  assert.equal(await checkTradeMinimums(f.client,getAddress(THRESHOLD_CASH),[tiny,large],'ordinary',123n,10n*U,new Set([tiny.tokenOut.toLowerCase()])),null);
  f.state.fail='numeraire';assert.match(await checkTradeMinimums(f.client,getAddress(THRESHOLD_CASH),[large],'ordinary',123n,10n*U)??'',/TRADE_MINIMUM_UNAVAILABLE/);
});


test('#96 final installment exception permits positive remainder but never a zero input',()=>{
  const U=10n**18n;
  assert.equal(assetTradeMinimumReason([1n,50n*U-1n],50n*U,new Set([0])),null);
  assert.match(assetTradeMinimumReason([0n,50n*U],50n*U,new Set([0]))??'',/BELOW_MIN_STEP/);
});

test('#96 all-hold rebalance uses fresh oracle notional plus fee at 1/50 equality, including sell legs',async()=>{
  const U=10n**18n,f=oracleFixture(),reserve=27n*U/100n;
  for(const delta of [-1n,0n,1n]){
    const steps=[{...f.step,amountIn:4n*U},{...f.step,amountIn:4573n*U/100n+delta}];
    const result=await checkTradeMinimums(f.client,getAddress(THRESHOLD_CASH),steps,'ordinary',123n,undefined,undefined,reserve);
    assert.equal(result===null,delta>=0n);
  }
  const sell={...f.step,tokenIn:f.step.tokenOut,tokenOut:f.step.tokenIn,amountIn:U};
  assert.equal(await checkTradeMinimums(f.client,getAddress(THRESHOLD_CASH),[sell],'ordinary',123n,undefined,undefined,reserve),null);
  f.state.fail='previewSwap';assert.match(await checkTradeMinimums(f.client,getAddress(THRESHOLD_CASH),[sell],'ordinary',123n,undefined,undefined,reserve)??'',/TRADE_MINIMUM_UNAVAILABLE/);
});

test('#96 actual all-hold planning admits 49.73 input plus 0.27 fee while legacy planning still waits',async()=>{
  const chain=hubChain({feeBps:10});chain.rate={rateE18:10n**18n,slippageBps:100};chain.minBatchFee=3n*10n**17n;
  const args=hubArgs(chain,{holdings:[holding(USDT,50n*10n**18n,18,PRICE_1_USD)],targets:targetsOf(WBNB,USDT,10000),thresholdBps:100,maxImpactBps:null,tradingConfig:loadTradingConfig({})});
  assert.equal((await planRebalance(args)).kind,'blocked');
  const result=await planRebalance({...args,inclusiveFeeReserveRaw:27n*10n**16n});
  assert.equal(result.kind,'ready',result.kind==='blocked'?result.reason:'expected fee-inclusive batch');
  if(result.kind==='ready')assert.equal(result.steps[0]?.amountIn,4973n*10n**16n);
});


test('#96 refresh times out if only the marginal impact quote stalls',{timeout:10000},async()=>{
  const f=minOutFixture();f.state.nominal=10000n;f.state.impactQuotes=true;
  const initial=await buildRoutedStep({...f.route,oracleQuoted:10000n},{quoteAggregator:async()=>null});assert.ok(initial);
  f.state.impactTimeout=true;
  const result=await refreshFloors({...f.params,steps:[initial]});
  assert.equal(result.ok,false);if(!result.ok)assert.match(result.reason,/ROUTE_IMPACT/);
});

test('#96 all-hold 1-USDT policy is independent of a legacy 5-USDT override',async()=>{
  const chain=hubChain();chain.rate={rateE18:10n**18n,slippageBps:100};
  const args=hubArgs(chain,{holdings:[holding(WBNB,10n*10n**18n,18,PRICE_1_USD),holding(USDT,90n*10n**18n,18,PRICE_1_USD)],
    targets:[{asset:WBNB,weightBps:600},{asset:TOKEN3,weightBps:9400},{asset:USDT,weightBps:0}],thresholdBps:100,maxImpactBps:null,
    tradingConfig:loadTradingConfig({MIN_STEP_USD_E8:'500000000'}),inclusiveFeeReserveRaw:0n});
  const result=expectReady(await planRebalance(args));assert.equal(result.steps.length,2);assert.ok(result.steps.some(step=>step.amountIn===4n*10n**18n));
});


test('returned cash: a rebalance buys idle USDT back under the buy minimum (10 USDT with its fee); under it the cash stays as cash (noop); trades between assets keep 50', async () => {
  const U = 10n ** 18n, reserve = 27n * 10n ** 16n, cents = (n: bigint) => n * U / 100n;
  const fresh = () => { const chain = hubChain({ feeBps: 10 }); chain.rate = { rateE18: 10n ** 18n, slippageBps: 100 }; chain.minBatchFee = 3n * 10n ** 17n; return chain; };
  const targets = [{ asset: WBNB, weightBps: 5000 }, { asset: TOKEN3, weightBps: 5000 }, { asset: USDT, weightBps: 0 }];
  const run = async (wbnb: bigint, token3: bigint, usdt: bigint, extra: Partial<PlanRebalanceArgs> = { inclusiveFeeReserveRaw: reserve }, weights = targets, thresholdBps = 100) => {
    const chain = fresh();
    const plan = await planRebalance({ ...hubArgs(chain, { holdings: [holding(WBNB, wbnb, 18, PRICE_1_USD), holding(TOKEN3, token3, 18, PRICE_1_USD),
      holding(USDT, usdt, 18, PRICE_1_USD)], targets: weights, thresholdBps, maxImpactBps: null, tradingConfig: loadTradingConfig({}) }), ...extra });
    return { plan, quoted: chain.calls.some(call => call.functionName === 'previewSwap' || call.functionName === 'buyAllowance') };
  };
  const bought = (steps: readonly { tokenIn: string; tokenOut: string; amountIn: bigint }[], token: string) =>
    steps.filter(step => step.tokenIn.toLowerCase() === USDT.toLowerCase() && step.tokenOut.toLowerCase() === token.toLowerCase()).reduce((sum, step) => sum + step.amountIn, 0n);
  const sold = (steps: readonly { tokenIn: string; amountIn: bigint }[]) => steps.filter(step => step.tokenIn.toLowerCase() !== USDT.toLowerCase()).reduce((sum, step) => sum + step.amountIn, 0n);

  // 60 USDT of idle cash next to a balanced 100/100: an ordinary batch (50 or more), both assets bought, the fee out of the same cash.
  const even = expectReady((await run(100n * U, 100n * U, 60n * U)).plan);
  assert.equal(even.steps.length, 2); assert.equal(even.idleCashBuy, undefined);
  assert.deepEqual([bought(even.steps, WBNB), bought(even.steps, TOKEN3)].sort(), [30n * U - reserve, 30n * U].sort(), 'one leg carries the fee');

  // 12 USDT handed back: under 50, but it is a buy from idle cash, so the buy minimum applies: 11.73 bought + 0.27 fee = 12.
  const twelve = expectReady((await run(100n * U, 100n * U, 12n * U)).plan);
  assert.deepEqual(twelve.idleCashBuy, { feeReserveRaw: reserve });
  assert.equal(sold(twelve.steps), 0n);
  assert.deepEqual([bought(twelve.steps, WBNB), bought(twelve.steps, TOKEN3)].sort(), [6n * U - reserve, 6n * U].sort());
  // Exactly 10 USDT is one buy batch; 9.99 is not.
  assert.equal(expectReady((await run(100n * U, 100n * U, 10n * U)).plan).idleCashBuy?.feeReserveRaw, reserve);

  // 8.62 USDT (portfolio 7's leftover) next to 12/12, and 9.99 next to 100/100: under one buy batch. Not blocked: a noop,
  // decided before any quote or allowance read, and the cash simply stays.
  for (const [each, usdt] of [[12n * U, cents(862n)], [100n * U, cents(999n)]] as const) {
    const small = await run(each, each, usdt);
    assert.equal(small.plan.kind, 'noop');
    if (small.plan.kind === 'noop') assert.equal(small.plan.reason, `[BELOW_MIN_BATCH] 可用現金 ${usdt === cents(862n) ? '8.620000' : '9.990000'} USDT 含費不足10 USDT，留作現金`);
    assert.equal(small.quoted, false, 'no quotes for cash that cannot be bought');
  }
  // 9.5 USDT next to 105.5/95 (one asset 0.5 over, too small to sell): decided with quotes, still a noop.
  const dust = await run(cents(10550n), 95n * U, cents(950n));
  assert.equal(dust.plan.kind, 'noop'); if (dust.plan.kind === 'noop') assert.match(dust.plan.reason, /^\[BELOW_MIN_BATCH\] 含費批次不足10 USDT/);

  // 12 USDT next to 110/90: the trade between the assets (sell 4, buy 16) is under 50 and is NOT sent with it.
  // Only the idle cash is bought, into the asset that is short. Nothing is sold.
  const drifted = expectReady((await run(110n * U, 90n * U, 12n * U)).plan);
  assert.equal(sold(drifted.steps), 0n, 'a rebalance between assets under 50 is not triggered by the cash');
  assert.equal(drifted.steps.length, 1); assert.equal(bought(drifted.steps, TOKEN3), 12n * U - reserve);
  assert.deepEqual(drifted.idleCashBuy, { feeReserveRaw: reserve });
  assert.ok(drifted.partial, 'the assets are still apart: this rebalance is not reported as complete');
  // The same drift without idle cash, and with idle cash under one buy batch: the 50 minimum between assets, as before.
  for (const usdt of [0n, cents(862n)]) {
    const between = (await run(110n * U, 90n * U, usdt)).plan;
    assert.equal(between.kind, 'blocked'); if (between.kind === 'blocked') assert.match(between.reason, /\[BELOW_MIN_BATCH\] 含費批次不足50 USDT/);
  }
  // 8.62 USDT when the assets have drifted to 140/60: one ordinary batch of 50 or more that sells WBNB and uses the cash too.
  const wide = expectReady((await run(140n * U, 60n * U, cents(862n))).plan);
  assert.equal(wide.idleCashBuy, undefined); assert.ok(sold(wide.steps) > 0n);
  assert.ok(bought(wide.steps, TOKEN3) > sold(wide.steps), 'more is bought than the sale brings in: the idle cash is used');
  assert.ok(bought(wide.steps, TOKEN3) <= sold(wide.steps) + cents(862n) - reserve);

  // Cash at its own target weight is not idle: a 10 USDT buy out of it (the overweight asset cannot be sold now) keeps the 50 minimum.
  const withCash = [{ asset: WBNB, weightBps: 4500 }, { asset: TOKEN3, weightBps: 4500 }, { asset: USDT, weightBps: 1000 }];
  const atTarget = (await run(100n * U, 80n * U, 20n * U, { inclusiveFeeReserveRaw: reserve, canTradeAsset: asset => asset.toLowerCase() !== WBNB.toLowerCase() }, withCash)).plan;
  assert.equal(atTarget.kind, 'blocked'); if (atTarget.kind === 'blocked') assert.match(atTarget.reason, /\[BELOW_MIN_BATCH\] 含費批次不足50 USDT/);
  // 12 USDT above a 10% cash target (90/90/32 -> target cash 21.2): only the 10.8 above the target is spent.
  const above = expectReady((await run(90n * U, 90n * U, 32n * U, { inclusiveFeeReserveRaw: reserve }, withCash)).plan);
  assert.deepEqual(above.idleCashBuy, { feeReserveRaw: reserve });
  assert.equal(bought(above.steps, WBNB) + bought(above.steps, TOKEN3) + reserve, cents(1080n));

  // A private basket's own rebalance (threshold 0, no fee-inclusive budget) follows the same rule when the scheduler asks for it...
  const basket = expectReady((await run(100n * U, 100n * U, 12n * U, { idleCashBuys: true }, targets, 0)).plan);
  assert.deepEqual(basket.idleCashBuy, { feeReserveRaw: reserve }); assert.equal(sold(basket.steps), 0n);
  assert.equal(bought(basket.steps, WBNB) + bought(basket.steps, TOKEN3), 12n * U - reserve);
  const basketSmall = (await run(12n * U, 12n * U, cents(862n), { idleCashBuys: true }, targets, 0)).plan;
  assert.deepEqual({ kind: basketSmall.kind, retryable: basketSmall.kind === 'noop' ? basketSmall.retryable : undefined }, { kind: 'noop', retryable: false });
  // A basket whose pending sources hold the rest of the cash (cash ceiling 0): nothing is bought, and the pass stays
  // retryable, so it does not use up the basket's rebalance date.
  const ceiling = (await run(12n * U, 12n * U, cents(862n), { idleCashBuys: true, cashBudgetRaw: 0n }, targets, 0)).plan;
  assert.deepEqual({ kind: ceiling.kind, retryable: ceiling.kind === 'ready' ? undefined : ceiling.retryable }, { kind: 'noop', retryable: true });
  // ...and never for a caller that did not ask (legacy funds keep the 50 minimum).
  const legacy = (await run(100n * U, 100n * U, 12n * U, {}, targets, 100)).plan;
  assert.equal(legacy.kind, 'blocked'); if (legacy.kind === 'blocked') assert.match(legacy.reason, /\[BELOW_MIN_BATCH\] 批次不足交易門檻/);
  const legacySmall = (await run(12n * U, 12n * U, cents(862n), {}, targets, 100)).plan;
  assert.equal(legacySmall.kind, 'blocked'); if (legacySmall.kind === 'blocked') assert.match(legacySmall.reason, /\[BELOW_MIN_BATCH\] 批次不足交易門檻/);
});

test('My mix exit sells sub-dollar assets below ordinary minimums; the exemption rejects buy targets', async () => {
  for (const raw of [10n ** 10n, 5n * 10n ** 17n, 15n * 10n ** 18n]) {
    const holdings = [holding(TOKEN3, raw, 18, PRICE_1_USD), holding(USDT, 0n, 18, PRICE_1_USD)];
    const targets = [{ asset: TOKEN3, weightBps: 0 }, { asset: USDT, weightBps: 10000 }];
    const chain = hubChain({ quotes: { [`${TOKEN3}:${USDT}`]: { minimum: raw } } });
    const plan = expectReady(await planRebalance(hubArgs(chain, { holdings, targets, thresholdBps: 0, purpose: 'exit', maxImpactBps: null })));
    assert.equal(plan.purpose, 'exit'); assert.equal(plan.steps.length, 1);
    assert.equal(plan.steps[0]?.tokenOut, getAddress(USDT)); assert.equal(plan.steps[0]?.amountIn, raw);
  }
  const holdings = [holding(USDT, 100n * 10n ** 18n, 18, PRICE_1_USD)];
  const targets = [{ asset: TOKEN3, weightBps: 10000 }, { asset: USDT, weightBps: 0 }];
  const invalid = await planRebalance(hubArgs(hubChain(), { holdings, targets, thresholdBps: 0, purpose: 'exit' }));
  assert.equal(invalid.kind, 'blocked');
});

test('My mix permits crypto legs while a stock is closed and never buys an underweight exit component', async () => {
  const { holdings, targets } = threeAssetCase();
  const chain = hubChain({ quotes: { [`${WBNB}:${USDT}`]: { minimum: 200n * 10n ** 18n },
    [`${USDT}:${TOKEN3}`]: { minimum: 100n * 10n ** 18n } } });
  for (const flags of [{ canTradeAsset: (asset: string) => asset.toLowerCase() !== TOKEN3.toLowerCase() },
    { sellOnlyAssets: new Set([TOKEN3.toLowerCase()]) }]) {
    const result = expectReady(await planRebalance(hubArgs(chain, { holdings, targets, thresholdBps: 0, ...flags })));
    assert.ok(result.steps.every(step => step.tokenIn.toLowerCase() !== TOKEN3.toLowerCase() && step.tokenOut.toLowerCase() !== TOKEN3.toLowerCase()));
    assert.ok(result.steps.some(step => step.tokenIn === getAddress(WBNB)));
  }
});

test('My mix calendar threshold zero compares exact value improvement when rounded drift is zero', async () => {
  const holdings = [holding(TOKEN3, 5_000_050n * 10n ** 18n, 18, PRICE_1_USD), holding(USDT, 4_999_950n * 10n ** 18n, 18, PRICE_1_USD)];
  const targets = [{ asset: TOKEN3, weightBps: 5000 }, { asset: USDT, weightBps: 5000 }];
  const chain = hubChain({ quotes: { [`${TOKEN3}:${USDT}`]: { minimum: 50n * 10n ** 18n } } });
  const args = hubArgs(chain, { holdings, targets, thresholdBps: 0, maxImpactBps: null });
  assert.equal(args.drift.grossDriftBps, 0);
  assert.equal((await planRebalance(args)).kind, 'ready');
  const publicArgs = hubArgs(chain, { holdings, targets, thresholdBps: 100, maxImpactBps: null });
  assert.equal((await planRebalance(publicArgs)).kind, 'noop', 'public fund keeps its 100bps threshold');
});

test('My mix target pass never spends cash held for closed asset sources', async () => {
  const holdings = [holding(USDT, 100n * 10n ** 18n, 18, PRICE_1_USD), holding(TOKEN3, 0n, 18, PRICE_1_USD)];
  const targets = [{ asset: USDT, weightBps: 0 }, { asset: TOKEN3, weightBps: 10000 }];
  const chain = hubChain({ quotes: { [`${USDT}:${TOKEN3}`]: { minimum: 50n * 10n ** 18n } } });
  const args = hubArgs(chain, { holdings, targets, thresholdBps: 0 });
  assert.equal((await planRebalance({ ...args, cashBudgetRaw: 0n })).kind, 'noop');
  const ready = expectReady(await planRebalance({ ...args, cashBudgetRaw: 50n * 10n ** 18n }));
  assert.equal(ready.steps[0]?.amountIn, 50n * 10n ** 18n);
  for (const raw of [-1n, 101n * 10n ** 18n]) assert.equal((await planRebalance({ ...args, cashBudgetRaw: raw })).kind, 'blocked');
});

test('pool existence is asked once per process: a pool that exists is never asked again, a missing one only after its TTL, a failed read is not remembered', async () => {
  const FACTORY = '0x0000000000000000000000000000000000000f01' as Address, QUOTER = '0x0000000000000000000000000000000000000f02' as Address;
  const abi = parseAbi(['function getPool(address,address,uint24) view returns(address)', 'function quoteExactInput(bytes,uint256) returns(uint256,uint160[])']);
  const state = { getPool: 0, quotes: 0, failing: false, pools: new Set(['500']) };
  const client = (chain: typeof bscTestnet | undefined) => createPublicClient({ ...(chain === undefined ? {} : { chain }), transport: custom({ request: async ({ params }) => {
    assert.ok(Array.isArray(params)); const call: unknown = params[0]; assert.ok(typeof call === 'object' && call !== null);
    const data: unknown = Reflect.get(call, 'data'); assert.ok(typeof data === 'string' && isHex(data));
    const decoded = decodeFunctionData({ abi, data });
    if (decoded.functionName === 'quoteExactInput') { state.quotes += 1; return encodeFunctionResult({ abi, functionName: 'quoteExactInput', result: [130n, []] }); }
    state.getPool += 1;
    if (state.failing) throw new Error('RPC unavailable');
    const direct = decoded.args[0].toLowerCase() === WBNB && decoded.args[1].toLowerCase() === USDT;
    return encodeFunctionResult({ abi, functionName: 'getPool', result: direct && state.pools.has(String(decoded.args[2])) ? WBNB_USDT_POOL : zeroAddress });
  } }, { retryCount: 0 }) });
  const route = (chain?: typeof bscTestnet) => chooseBestPath(client(chain), { tokenIn: WBNB, tokenOut: USDT, amountIn: 1n, via: null, factory: FACTORY, pinnedFee: null, quoter: QUOTER, blockNumber: 42n });
  const realNow = Date.now;
  try {
    setKnownPools(true);
    // A client without a real chain (unit tests, local forks) is never remembered: four fee tiers asked every time.
    await route(); await route();
    assert.equal(state.getPool, 8);
    // Chain 97: the first plan asks the four tiers, the second asks nothing and still quotes the same single path.
    state.getPool = 0; state.quotes = 0;
    const first = await route(bscTestnet), second = await route(bscTestnet);
    assert.equal(state.getPool, 4);
    assert.equal(state.quotes, 2, 'every candidate is still quoted on-chain each time');
    assert.deepEqual(second, first); assert.ok(first?.kind === 'v3' && first.amountOut === 130n);
    // A pool created later is found once the "no" has aged out; the pool that exists is not asked again.
    state.pools.add('2500');
    await route(bscTestnet);
    assert.equal(state.getPool, 4);
    Date.now = () => realNow() + POOL_ABSENT_TTL_MS + 1;
    await route(bscTestnet);
    assert.equal(state.getPool, 7, 'the three missing tiers are asked again, the existing one is not');
    assert.equal(state.quotes, 5, 'now two candidates: the old pool and the new one');
    // A failed read says nothing about the pool: nothing is remembered, the next plan asks again.
    setKnownPools(true); state.getPool = 0; state.failing = true;
    assert.equal(await route(bscTestnet), null);
    state.failing = false;
    assert.ok(await route(bscTestnet));
    assert.equal(state.getPool, 8);
  } finally { Date.now = realNow; setKnownPools(false); }
});

test('the floor refresh asks every step at once and still reports the first step that fails', async () => {
  const ORACLE_ADDRESS = '0x0000000000000000000000000000000000000a11' as Address;
  const abi = parseAbi(['function previewSwap(address,address,uint256) view returns(uint256,uint256)']);
  const asked: bigint[] = []; let inFlight = 0, widest = 0;
  const client = createPublicClient({ transport: custom({ request: async ({ params }) => {
    assert.ok(Array.isArray(params)); const call: unknown = params[0]; assert.ok(typeof call === 'object' && call !== null);
    const data: unknown = Reflect.get(call, 'data'); assert.ok(typeof data === 'string' && isHex(data));
    const amount = decodeFunctionData({ abi, data }).args[2]; asked.push(amount);
    inFlight += 1; widest = Math.max(widest, inFlight);
    // The first step answers last: what is reported must follow the step order, not which answer came back first.
    await new Promise((resolve) => setTimeout(resolve, amount === 1n ? 40 : 5));
    inFlight -= 1;
    return encodeFunctionResult({ abi, functionName: 'previewSwap', result: [amount * 100n, 0n] });
  } }, { retryCount: 0 }) });
  const step = (amountIn: bigint): PlannedStep => ({ tokenIn: WBNB, tokenOut: USDT, amountIn, amountOutMin: amountIn * 99n, oracleFloor: amountIn * 99n, venue: USDT, data: '0x' });
  const result = await refreshFloors({ publicClient: client, oracle: ORACLE_ADDRESS, steps: [step(1n), step(2n), step(3n)], feeBps: 0, blockNumber: 42n });
  assert.ok(!result.ok); assert.match(result.reason, /step#0 的 minimum 是 0/);
  assert.deepEqual([...asked].sort(), [1n, 2n, 3n]); assert.equal(widest, 3, 'the three floors were in flight together');
});
