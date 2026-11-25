import { createPublicClient, createWalletClient, decodeEventLog, decodeFunctionData, encodeFunctionData, http, maxUint256, parseAbi } from 'viem';
import type { Address, Hex, Log, PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';
import { getConfig } from './config.js';
import { query as dbQuery, withTransaction } from './db.js';
import { AppError, ValidationError } from './errors.js';
import { requireOwnedPortfolio } from './portfolios.js';
import { TESTNET_97 } from './testnet-profile.js';
import { STRATEGY_EARN_97 } from './strategy-earn-guard.js';
import { borrowAuthorized, SESSION_PERMISSION_FLAG, sessionPermissionFlagOf } from './permissions.js';
import { rpcBatch, rpcTransport } from './rpc-transport.js';
import { createMainnetRates, mainnetQuote } from './strategy-earn-mainnet.js';
import type { MainnetRates } from './strategy-earn-mainnet.js';
import { parseRewardSignature, rewardsStore, strategyRewardsEnabled } from './strategy-rewards.js';
import type { RewardsStore, RewardsView } from './strategy-rewards.js';
import { routeLedger, routeMessage, strategyEarnV2For, v2Authorized } from './strategy-earn-v2.js';
import type { RouteEventKind, StrategyEarnV2 } from './strategy-earn-v2.js';
import { createStrategyEarnV2Api } from './strategy-earn-v2-api.js';
import type { StrategyEarnV2Api } from './strategy-earn-v2-api.js';
import { defaultV2Reader, v2EstimateGas } from './strategy-earn-v2-chain.js';
import { claimedCash } from './withdrawable-cash.js';
import { settleCashSwaps } from './strategy-cash-swaps.js';
export { STRATEGY_EARN_97, assertNotStrategyVault, isStrategyVault } from './strategy-earn-guard.js';

/**
 * Strategy Earn (backend#199, docs/EARN_UX B/D, cre8-contracts#64/#65): a portfolio's own smart account posts one
 * holding as collateral in its fixed market, borrows USDT straight into the strategy vault, and repays/withdraws.
 * Chain 97 only. Separate from wallet cash and Cash Earn (#193): nothing here moves money to the account's cash or
 * the owner's wallet, and no response sums these with other balances.
 *
 * Safety (cre8-contracts docs/borrow-97 §7): the strategy vault is registered in AtpYieldRegistry, and the old
 * AtpExecutor.executeWithdraw would redeem its shares into account cash if the account had approved them to
 * AtpExecutor. The backend never approves strategy vault shares to AtpExecutor and never builds an AtpExecutor
 * yield call for the strategy vault market (see `assertNotStrategyVault`, yield-domain and paymaster guards).
 */
export type StrategyMarket = { symbol: string; marketId: Hex; protocol: 'venus' | 'lista'; collateral: Address; decimals: number; collateralVToken: Address | null; listaId: Hex | null };
export function strategyMarkets(): StrategyMarket[] {
  return STRATEGY_EARN_97.markets.map(m => {
    const asset = (TESTNET_97.assets as Record<string, { token: string; decimals: number } | undefined>)[m.symbol];
    if (!asset) throw new Error('strategy earn asset missing from profile: ' + m.symbol);
    // XAUt has 6 decimals on chain 97: every value below is computed in the collateral's own decimals.
    return { symbol: m.symbol, marketId: m.marketId, protocol: m.protocol, collateral: asset.token.toLowerCase() as Address, decimals: asset.decimals,
      collateralVToken: m.collateralVToken, listaId: m.listaId };
  });
}

const HEALTH = 'uint256 collateralValue; uint256 liquidationValue; uint256 debtValue; uint256 healthFactor;';
export const STRATEGY_EARN_ABI = parseAbi([
  `struct Health { ${HEALTH} }`,
  'struct Status { uint8 gate; bool shouldDeleverage; bool shouldUnwind; uint256 borrowRate; uint256 collateralRate; uint256 vaultRate; uint256 collateralIncentiveRate; uint256 borrowIncentiveRate; uint256 vaultIncentiveRate; uint256 borrowUtilizationBps; uint256 vaultUtilizationBps; uint256 ltv; uint256 targetLtv; uint256 deleverageLtv; uint256 liquidationLtv; uint256 debt; uint256 vaultAssets; Health health; }',
  'function status(bytes32 id, address account) returns (Status)',
  'function accountMarkets(address account) view returns (bytes32[])',
  'function collateral(bytes32 id, address account) view returns (uint256)',
  'function setBorrowPolicy(bytes32 id, uint256 maxDebt, bool enabled)',
  'function executeSupplyCollateral(address account, bytes32 marketId, uint256 amount, uint256 deadline)',
  'function executeBorrow(address account, bytes32 marketId, uint256 amount, uint256 deadline)',
  'function executeRepay(address account, bytes32 marketId, uint256 amount, bool fromVault, uint256 deadline)',
  'function executeDeleverage(address account, bytes32 marketId)',
  'function executeWithdrawCollateral(address account, bytes32 marketId, uint256 amount, uint256 deadline)',
  'function updateDelegate(address delegate, bool allowBorrows)',
  'function setAuthorization(address authorized, bool newIsAuthorized)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function peek(address asset) view returns (uint256)',
  'function rewardOf(address account) view returns (uint256)',
  'function claimReward(address account) returns (uint256)',
  'function rewardOf(bytes32 id, address account) view returns (uint256)',
  'function claimReward(bytes32 id, address account) returns (uint256)',
  'function policies(address account, bytes32 id) view returns (uint256 maxDebt, uint256 strategyId, uint16 version, bool enabled)',
  'function enrollments(address account) view returns (uint256 strategyId, uint16 version, bool paused)',
  'struct Version { address[] assets; uint16[] weightsBps; bytes32 scheduleHash; uint64 activeAt; bytes32 settingsHash; uint16 performanceFeeBps; bytes32 configHash; }',
  'function version(uint256 strategyId, uint16 v) view returns (Version)',
]);
/** AtpBorrowExecutor events (cre8-contracts#64) and the mock markets' RewardClaimed, read from verified receipts for the ledger. */
export const STRATEGY_EARN_EVENTS_ABI = parseAbi([
  'event CollateralSupplied(address indexed account, bytes32 indexed marketId, uint256 amount, uint256 collateral)',
  'event Borrowed(address indexed account, bytes32 indexed marketId, uint256 amount, uint256 vaultShares, uint256 ltv)',
  'event Repaid(address indexed account, bytes32 indexed marketId, uint256 amount, uint256 vaultSharesUsed, uint256 debt)',
  'event Deleveraged(address indexed account, bytes32 indexed marketId, uint256 repaid, uint256 ltvBefore, uint256 ltvAfter)',
  'event CollateralWithdrawn(address indexed account, bytes32 indexed marketId, uint256 amount, uint256 collateral, uint256 ltv)',
  'event RewardClaimed(address indexed account, uint256 amount)',
  'event RewardClaimed(bytes32 indexed id, address indexed account, uint256 amount)',
]);
export const GATE_REASONS = ['open', 'closed', 'borrow_utilization', 'vault_utilization', 'negative_carry', 'vault_unreadable'] as const;
export type StatusReading = { gate: number; shouldDeleverage: boolean; shouldUnwind: boolean; borrowRate: bigint; collateralRate: bigint; vaultRate: bigint;
  collateralIncentiveRate: bigint; borrowIncentiveRate: bigint; vaultIncentiveRate: bigint; borrowUtilizationBps: bigint; vaultUtilizationBps: bigint;
  ltv: bigint; targetLtv: bigint; deleverageLtv: bigint; liquidationLtv: bigint; debt: bigint; vaultAssets: bigint;
  health: { collateralValue: bigint; liquidationValue: bigint; debtValue: bigint; healthFactor: bigint } };

const E18 = 10n ** 18n;
const toBps = (rate: bigint) => Number(rate / 10n ** 14n);
/**
 * EARN_UX B.3 / BorrowTypes.Status: (vault + vault incentive - borrow + borrow incentive) x ratio + collateral + collateral incentive.
 * Rates and ratio are 1e18; result in bps (rounded toward zero). The carry part can be negative.
 */
export function extraApy(s: Pick<StatusReading, 'borrowRate' | 'collateralRate' | 'vaultRate' | 'collateralIncentiveRate' | 'borrowIncentiveRate' | 'vaultIncentiveRate'>, ratio: bigint) {
  const carry = s.vaultRate + s.vaultIncentiveRate - s.borrowRate + s.borrowIncentiveRate;
  const carryPart = carry * ratio / E18;
  const total = carryPart + s.collateralRate + s.collateralIncentiveRate;
  return { totalBps: toBps(total), breakdown: {
    vaultBps: toBps(s.vaultRate), vaultIncentiveBps: toBps(s.vaultIncentiveRate), borrowBps: toBps(s.borrowRate), borrowIncentiveBps: toBps(s.borrowIncentiveRate),
    ratioBps: toBps(ratio), carryBps: toBps(carryPart), collateralBps: toBps(s.collateralRate), collateralIncentiveBps: toBps(s.collateralIncentiveRate) } };
}

export type StrategyEarnChain = {
  head(): Promise<{ number: bigint; timestamp: bigint }>;
  status(marketId: Hex, account: Address, block: bigint): Promise<StatusReading>;
  accountMarkets(account: Address, block: bigint): Promise<Hex[]>;
  collateral(marketId: Hex, account: Address, block: bigint): Promise<bigint>;
  balance(token: Address, account: Address, block: bigint): Promise<bigint>;
  /** Lending-oracle USD price, 8 decimals per whole token. */
  price(asset: Address, block: bigint): Promise<bigint>;
  /** Pending incentives owed to this account (claim pays only to it), USDT raw: strategy vault, and the market's own
   * (Venus collateral vToken, or Lista Moolah per market id). */
  rewards(market: StrategyMarket, account: Address, block: bigint): Promise<{ vault: bigint; collateral: bigint }>;
  /** Owner consent for this market (AtpBorrowRegistry.policies): enabled with a debt ceiling, pinned to the enrollment
   * (strategy id + version) it was given under. */
  policy(account: Address, marketId: Hex, block: bigint): Promise<{ maxDebt: bigint; enabled: boolean; strategyId?: bigint; version?: number }>;
  /** AtpRegistry.enrollments(account). A My mix weight change re-enrolls the same account into a new private strategy, which
   * voids consent given before it (AtpBorrowRegistry._consent: ConsentRequired). Absent in old test fakes = consent is current. */
  enrollment?(account: Address, block: bigint): Promise<{ strategyId: bigint; version: number }>;
  /** A mined transaction's receipt (null = not mined yet / unknown to this node). */
  receipt?(hash: Hex): Promise<(StrategyEarnTx & { success: boolean }) | null>;
  /** The portfolio's enrolled version on AtpRegistry: assets and weights (lowercase). */
  weights(account: Address, block: bigint): Promise<{ asset: Address; weightBps: number }[]>;
};

export function createStrategyEarnChain(client: PublicClient): StrategyEarnChain {
  const S = STRATEGY_EARN_97;
  const read = (address: Address, functionName: string, args: readonly unknown[], blockNumber: bigint) =>
    client.readContract({ address, abi: STRATEGY_EARN_ABI, functionName: functionName as never, args: args as never, blockNumber }) as Promise<unknown>;
  return {
    async head() { const b = await client.getBlock(); return { number: b.number, timestamp: b.timestamp }; },
    // `status` is nonpayable (it syncs accrual first); eth_call only, never sent.
    async status(marketId, account, blockNumber) {
      const r = await client.simulateContract({ address: S.registry, abi: STRATEGY_EARN_ABI, functionName: 'status', args: [marketId, account], blockNumber });
      return r.result as StatusReading;
    },
    accountMarkets: async (account, block) => [...(await read(S.registry, 'accountMarkets', [account], block) as readonly Hex[])].map(id => id.toLowerCase() as Hex),
    collateral: async (marketId, account, block) => read(S.registry, 'collateral', [marketId, account], block) as Promise<bigint>,
    balance: async (token, account, block) => read(token, 'balanceOf', [account], block) as Promise<bigint>,
    price: async (asset, block) => read(S.lendingOracle, 'peek', [asset], block) as Promise<bigint>,
    async rewards(market, account, block) {
      const vault = await read(S.earnVault, 'rewardOf', [account], block) as bigint;
      // Venus collateral incentives accrue on the collateral vToken; Lista (Moolah) per market id (backend#204).
      const collateral = market.collateralVToken ? await read(market.collateralVToken, 'rewardOf', [account], block) as bigint
        : market.listaId ? await read(S.listaMoolah, 'rewardOf', [market.listaId, account], block) as bigint : 0n;
      return { vault, collateral };
    },
    async weights(account, block) {
      const [strategyId, version] = await read(TESTNET_97.contracts.registry as Address, 'enrollments', [account], block) as readonly [bigint, number, boolean];
      if (strategyId === 0n || version === 0) return [];
      const v = await read(TESTNET_97.contracts.registry as Address, 'version', [strategyId, version], block) as { assets: readonly Address[]; weightsBps: readonly number[] };
      return v.assets.map((asset, i) => ({ asset: asset.toLowerCase() as Address, weightBps: Number(v.weightsBps[i] ?? 0) }));
    },
    async policy(account, marketId, block) {
      const [maxDebt, strategyId, version, enabled] = await read(S.registry, 'policies', [account, marketId], block) as readonly [bigint, bigint, number, boolean];
      return { maxDebt, enabled, strategyId, version: Number(version) };
    },
    async receipt(hash) {
      try {
        const r = await client.getTransactionReceipt({ hash });
        return { hash: r.transactionHash, blockNumber: r.blockNumber, logs: r.logs, success: r.status === 'success' };
      } catch (error) { if ((error as { name?: string }).name === 'TransactionReceiptNotFoundError') return null; throw error; }
    },
    async enrollment(account, block) {
      const [strategyId, version] = await read(TESTNET_97.contracts.registry as Address, 'enrollments', [account], block) as readonly [bigint, number, boolean];
      return { strategyId, version: Number(version) };
    },
  };
}

export type Call = { to: Address; data: Hex; value: '0' };
const call = (to: string, functionName: string, args: readonly unknown[]): Call =>
  ({ to: to as Address, value: '0', data: encodeFunctionData({ abi: STRATEGY_EARN_ABI, functionName: functionName as never, args: args as never }) });

/** Owner-signed calls (one UserOp from the portfolio account) to post collateral and borrow straight into the vault. */
export function openCalls(market: StrategyMarket, account: Address, collateralRaw: bigint, borrowRaw: bigint, maxDebtRaw: bigint, deadline: bigint): Call[] {
  const S = STRATEGY_EARN_97;
  return [
    market.protocol === 'venus' ? call(S.venusComptroller, 'updateDelegate', [S.executor, true]) : call(S.listaMoolah, 'setAuthorization', [S.executor, true]),
    call(S.registry, 'setBorrowPolicy', [market.marketId, maxDebtRaw, true]),
    call(market.collateral, 'approve', [S.executor, collateralRaw]),
    // Repay and withdraw need these two approvals, always to AtpBorrowExecutor only (never AtpExecutor).
    call(TESTNET_97.contracts.usdt, 'approve', [S.executor, maxUint256]),
    call(S.earnVault, 'approve', [S.executor, maxUint256]),
    call(S.executor, 'executeSupplyCollateral', [account, market.marketId, collateralRaw, deadline]),
    ...(borrowRaw > 0n ? [call(S.executor, 'executeBorrow', [account, market.marketId, borrowRaw, deadline])] : []),
  ];
}
/**
 * Close = repay everything (vault first, then the account's own USDT), then take all collateral back. Order matters.
 * Then withdraw the consent for this market: an enabled policy is what the scheduler's auto-open reads after every
 * quiet round, so without it a turned-off strategy would be posted again with the next fill.
 */
export function closeCalls(market: StrategyMarket, account: Address, deadline: bigint): Call[] {
  const S = STRATEGY_EARN_97;
  return [
    call(S.executor, 'executeRepay', [account, market.marketId, maxUint256, true, deadline]),
    call(S.executor, 'executeWithdrawCollateral', [account, market.marketId, maxUint256, deadline]),
    call(S.registry, 'setBorrowPolicy', [market.marketId, 0n, false]),
  ];
}

/**
 * Owner consent at buy time (backend#204): grant AtpBorrowExecutor on each protocol once, one debt ceiling per market,
 * and approvals — collateral, USDT and strategy vault shares — to AtpBorrowExecutor only (never AtpExecutor).
 */
export function consentCalls(items: readonly { market: StrategyMarket; maxDebtRaw: bigint }[]): Call[] {
  const S = STRATEGY_EARN_97;
  if (items.length === 0) return [];
  return [
    ...(items.some(i => i.market.protocol === 'venus') ? [call(S.venusComptroller, 'updateDelegate', [S.executor, true])] : []),
    ...(items.some(i => i.market.protocol === 'lista') ? [call(S.listaMoolah, 'setAuthorization', [S.executor, true])] : []),
    ...items.flatMap(i => [call(S.registry, 'setBorrowPolicy', [i.market.marketId, i.maxDebtRaw, true]), call(i.market.collateral, 'approve', [S.executor, maxUint256])]),
    call(TESTNET_97.contracts.usdt, 'approve', [S.executor, maxUint256]),
    call(S.earnVault, 'approve', [S.executor, maxUint256]),
  ];
}

/** USD value (1e18) of `amount` raw collateral (in `decimals`, default 18) at an 8-decimal oracle price. */
export const usdValue = (amountRaw: bigint, priceE8: bigint, decimals = 18) => amountRaw * priceE8 * 10n ** 10n / 10n ** BigInt(decimals);
/** Keep 2% under the target so interest accrued before inclusion cannot push LTV over it. */
export const BORROW_BUFFER_BPS = 9800n;
/** Debt ceiling the owner consents to: 10% above the planned total debt, for accrued interest. */
export const MAX_DEBT_BUFFER_BPS = 11000n;
export function borrowPlan(input: { existingCollateralValue: bigint; addedCollateralValue: bigint; existingDebtValue: bigint; targetLtv: bigint; usdtPriceE8: bigint; currentDebtRaw: bigint }) {
  const capacity = (input.existingCollateralValue + input.addedCollateralValue) * input.targetLtv / E18 * BORROW_BUFFER_BPS / 10_000n;
  const valueToBorrow = capacity > input.existingDebtValue ? capacity - input.existingDebtValue : 0n;
  if (input.usdtPriceE8 <= 0n) throw new Error('no usdt price');
  // USD (1e18) -> USDT raw (18 decimals) at the lending oracle's 8-decimal USDT price.
  const borrowRaw = valueToBorrow * 10n ** 8n / input.usdtPriceE8;
  const maxDebtRaw = (input.currentDebtRaw + borrowRaw) * MAX_DEBT_BUFFER_BPS / 10_000n;
  return { borrowRaw, maxDebtRaw };
}

/**
 * Usable consent: enabled with a ceiling and given under the account's current enrollment. One enrollment read per call,
 * only when some policy is enabled. Funds never re-enroll, so for them this is just "enabled with a ceiling".
 */
export async function consentedMarkets(chain: StrategyEarnChain, account: Address, block: bigint, markets: readonly StrategyMarket[]): Promise<Map<Hex, bigint>> {
  const policies = await Promise.all(markets.map(async m => ({ m, p: await chain.policy(account, m.marketId, block) })));
  const enabled = policies.filter(x => x.p.enabled && x.p.maxDebt > 0n);
  if (enabled.length === 0) return new Map();
  const e = chain.enrollment ? await chain.enrollment(account, block) : null;
  return new Map(enabled.filter(x => e === null || x.p.strategyId === undefined || (x.p.strategyId === e.strategyId && x.p.version === e.version))
    .map(x => [x.m.marketId, x.p.maxDebt]));
}

/**
 * The consent an owner signs for a set of target weights (`valueUsd`: what each eligible asset will be worth, USD 1e18):
 * one debt ceiling per market at the target ratio +10%, skipping markets whose gate is not open (EARN_UX D) or that
 * would borrow nothing. Leveraged products are never in STRATEGY_EARN_97.markets.
 */
async function consentQuotes(chain: StrategyEarnChain, account: Address, head: { number: bigint }, eligible: readonly StrategyMarket[],
  usdtPrice: bigint, valueUsd: (m: StrategyMarket, price: bigint, held: bigint) => bigint) {
  type Read = { market: StrategyMarket; status: 'read'; st: StatusReading; added: bigint };
  const reads = await Promise.all(eligible.map(async m => {
    try {
      const [st, held, price] = await Promise.all([chain.status(m.marketId, account, head.number), chain.balance(m.collateral, account, head.number), chain.price(m.collateral, head.number)]);
      if (st.gate !== 0) return { market: m, status: 'unavailable' as const, reason: GATE_REASONS[st.gate] ?? 'closed' };
      return { market: m, status: 'read' as const, st, added: valueUsd(m, price, held) };
    } catch { return { market: m, status: 'unavailable' as const, reason: 'data_unavailable' }; }
  }));
  // Venus: one comptroller, one USDT loan per account. Every Venus market's `debt` / `health` is the account's whole
  // Venus position, and AtpBorrowExecutor checks each market's ceiling against that whole debt (DebtAboveConsent). So
  // the Venus markets are planned together — all their new collateral at the strictest target — and each one gets the
  // same ceiling: the account's total planned Venus debt +10%. Lista is per market.
  const venus = reads.filter((r): r is Read => r.status === 'read' && r.market.protocol === 'venus');
  const first = venus[0];
  const venusPlan = first === undefined ? null : borrowPlan({ existingCollateralValue: first.st.health.collateralValue,
    addedCollateralValue: venus.reduce((sum, r) => sum + r.added, 0n), existingDebtValue: first.st.health.debtValue,
    targetLtv: venus.reduce((min, r) => r.st.targetLtv < min ? r.st.targetLtv : min, first.st.targetLtv), usdtPriceE8: usdtPrice, currentDebtRaw: first.st.debt });
  return reads.map(r => {
    if (r.status !== 'read') return r;
    const plan = r.market.protocol === 'venus' && venusPlan !== null ? venusPlan : borrowPlan({ existingCollateralValue: r.st.health.collateralValue,
      addedCollateralValue: r.added, existingDebtValue: r.st.health.debtValue, targetLtv: r.st.targetLtv, usdtPriceE8: usdtPrice, currentDebtRaw: r.st.debt });
    if (plan.maxDebtRaw === 0n) return { market: r.market, status: 'unavailable' as const, reason: 'nothing_to_borrow' };
    return { market: r.market, status: 'ready' as const, maxDebtRaw: plan.maxDebtRaw, extraApyBps: extraApy(r.st, r.st.targetLtv).totalBps };
  });
}

/**
 * My mix weight change (src/mixes.ts): the change re-enrolls the account, which voids the yield strategy consent given
 * under the old enrollment. When the strategy is on for this account (a posted position, or consent waiting for a fill),
 * the same owner signature re-consents for every eligible asset in the NEW weights — newly added assets included. Assets
 * the change removes get no consent; the scheduler repays and takes their shares back before selling them
 * (strategyEarnUnwindForSale), as for a fund. Returns [] when the strategy is off or nothing is eligible.
 * `totalValueUsd` (1e18) is the mix's value; each asset's ceiling assumes it reaches its target weight.
 */
export async function mixStrategyConsentCalls(input: { account: Address; previousAssets: readonly string[]; assets: readonly { address: string; weightBps: number }[];
  totalValueUsd: bigint }, chain: StrategyEarnChain = defaultStrategyEarnChain()): Promise<Call[]> {
  const account = input.account.toLowerCase() as Address;
  const markets = strategyMarkets();
  const head = await chain.head();
  const ids = await chain.accountMarkets(account, head.number);
  const posted = await Promise.all(markets.filter(m => ids.includes(m.marketId)).map(async m => (await chain.collateral(m.marketId, account, head.number)) > 0n));
  const previous = markets.filter(m => input.previousAssets.some(a => a.toLowerCase() === m.collateral));
  const on = posted.some(Boolean) || (await consentedMarkets(chain, account, head.number, previous)).size > 0;
  if (!on) return [];
  const weight = (m: StrategyMarket) => input.assets.find(a => a.address.toLowerCase() === m.collateral)?.weightBps ?? 0;
  const eligible = markets.filter(m => weight(m) > 0);
  if (eligible.length === 0) return [];
  const usdtPrice = await chain.price(TESTNET_97.contracts.usdt as Address, head.number);
  const quoted = await consentQuotes(chain, account, head, eligible, usdtPrice, m => input.totalValueUsd * BigInt(weight(m)) / 10_000n);
  return consentCalls(quoted.flatMap(q => q.status === 'ready' ? [{ market: q.market, maxDebtRaw: q.maxDebtRaw }] : []));
}

/**
 * Venus positions all report the account's ONE Venus debt. Shown per asset and summed, it would count that debt once
 * per Venus asset (2026-11-23 Mag7: 9.17 USDT on NVDAB and again on TSLAB). Split it across the Venus positions by
 * their strategy vault assets (what each borrowed, plus interest; collateral value when no vault is left), so the
 * per-asset numbers add up to the real debt. Lista positions are per market and stay as read.
 */
export function splitVenusDebt<P extends { marketId: string; debtRaw?: string; vaultAssetsRaw?: string; collateralValueUsd?: string; netValueUsd?: string; earnNetUsd?: string }>(
  positions: P[], markets: readonly StrategyMarket[]): void {
  const venus = positions.filter(p => p.debtRaw !== undefined && markets.find(m => m.marketId === p.marketId)?.protocol === 'venus');
  if (venus.length < 2) return;
  const total = venus.reduce((max, p) => BigInt(p.debtRaw ?? '0') > max ? BigInt(p.debtRaw ?? '0') : max, 0n);
  const byVault = venus.reduce((sum, p) => sum + BigInt(p.vaultAssetsRaw ?? '0'), 0n);
  const weight = (p: P) => byVault > 0n ? BigInt(p.vaultAssetsRaw ?? '0') : BigInt(p.collateralValueUsd ?? '0');
  const weights = venus.reduce((sum, p) => sum + weight(p), 0n);
  let left = total;
  venus.forEach((p, i) => {
    const share = i === venus.length - 1 ? left : weights === 0n ? total / BigInt(venus.length) : total * weight(p) / weights;
    left -= share;
    const vault = BigInt(p.vaultAssetsRaw ?? '0'), collateral = BigInt(p.collateralValueUsd ?? '0');
    p.debtRaw = share.toString(); p.earnNetUsd = (vault - share).toString(); p.netValueUsd = (collateral + vault - share).toString();
  });
}

const TEMPORARILY = 'Temporarily unavailable.';
/** Server-side cache for the public GET /strategy-earn/markets (31 status reads): one chain read per minute at most. */
export const MARKETS_CACHE_MS = 60_000;
export type StrategyEarnDeps = { chainId: number; chain: () => StrategyEarnChain; owned: typeof requireOwnedPortfolio; now: () => Date; rewards?: RewardsStore; rewardsEnabled?: boolean; ledger?: StrategyEarnLedger;
  /** Routing v2 for this owner; default `strategyEarnV2For(chainId, owner)` (the canary list). Tests pass a fixed deployment or null. */
  v2?: StrategyEarnV2 | null | ((owner: string) => StrategyEarnV2 | null);
  /** The v2 side of these endpoints (src/strategy-earn-v2-api.ts); default reads the chain through the public-node reader. */
  v2Api?: (v2: StrategyEarnV2) => StrategyEarnV2Api;
  /** 0 = no cache (tests). Default MARKETS_CACHE_MS. */
  marketsCacheMs?: number;
  /** Real BSC mainnet rates for display (src/strategy-earn-mainnet.ts); null = none. */
  mainnetRates?: { get(): Promise<MainnetRates | null>; peek?(): MainnetRates | null };
  query: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };

let cachedChain: StrategyEarnChain | undefined;
export function defaultStrategyEarnChain(): StrategyEarnChain {
  if (cachedChain) return cachedChain;
  const rpc = getConfig().rpcUrl;
  if (!rpc) throw new Error('rpc unavailable');
  cachedChain = createStrategyEarnChain(createPublicClient({ chain: bscTestnet, ...rpcBatch(rpc), transport: rpcTransport('strategy-earn', rpc, { retryCount: 1, timeout: 8_000 }) }) as PublicClient);
  return cachedChain;
}

/**
 * Does v1 (AtpBorrowExecutor) hold anything for this account: shares posted, debt, or a consent waiting for a fill?
 * One account uses v1 or routing v2, never both (cre8-contracts borrow-routing-v2 §12; the contract's ForeignDebt check does
 * not cover every path), so every place that would add v2 risk asks this first.
 */
export async function strategyEarnV1Active(chain: StrategyEarnChain, account: Address, block: bigint): Promise<boolean> {
  const all = strategyMarkets();
  const ids = await chain.accountMarkets(account, block);
  const entered = all.filter(m => ids.includes(m.marketId));
  if ((await Promise.all(entered.map(async m => (await chain.collateral(m.marketId, account, block)) > 0n || (await chain.status(m.marketId, account, block)).debt > 0n))).some(Boolean)) return true;
  return (await consentedMarkets(chain, account, block, all)).size > 0;
}
/**
 * The paymaster's and the scheduler's question before sponsoring / sending anything that adds risk on one generation: is
 * the OTHER generation still in use on this account? Reads the chain; a failed read throws (never answered by a guess).
 */
export async function strategyGenerationActive(generation: 'v1' | 'v2', account: Address, v2: StrategyEarnV2): Promise<boolean> {
  if (generation === 'v2') return defaultStrategyEarnV2Api(v2).active(account);
  const chain = defaultStrategyEarnChain();
  return strategyEarnV1Active(chain, account, (await chain.head()).number);
}

const defaultV2Apis = new Map<string, StrategyEarnV2Api>();
/** The v2 side of the strategy-earn endpoints for a deployment: public-node reader, ledgers in this service's database. */
export function defaultStrategyEarnV2Api(v2: StrategyEarnV2): StrategyEarnV2Api {
  const key = `${v2.chainId}:${v2.executor}`;
  let api = defaultV2Apis.get(key);
  if (!api) {
    const ledger = routeLedger((sql, params) => dbQuery(sql, params));
    api = createStrategyEarnV2Api({ v2, reader: defaultV2Reader(v2), now: () => new Date(), estimateGas: (account, call) => v2EstimateGas(v2, account, call),
      recordRoutes: (chainId, events) => ledger.record(chainId, events), recordRewards: (chainId, events) => rewardsStore().record(chainId, events),
      // An owner-signed top-up spends the portfolio's own cash and USDT no bucket of the cash ledger claims; `confirm` books it
      // (src/strategy-cash-swaps.ts), and the scheduler's recovery scan does if that call never comes.
      cashClaims: async account => { const rows = (await dbQuery(`select b.unallocated_hold_raw::text,b.stack_prefund_raw::text,b.allocated_cash_raw::text,b.reserved_input_raw::text,b.reserved_fee_raw::text,b.withdrawal_raw::text,b.yield_raw::text
        from strategy_cash_balances b join smart_accounts s on (s.chain_id,s.portfolio_id)=(b.chain_id,b.portfolio_id) where s.chain_id=$1 and s.address=$2 and s.retired_at is null`, [v2.chainId, account.toLowerCase()])).rows as Record<string, unknown>[];
        return { claimedRaw: rows.reduce((sum, row) => sum + claimedCash(row), 0n), ownRaw: rows.reduce((sum, row) => sum + BigInt(String(row.allocated_cash_raw)), 0n) }; },
      bookSwaps: (portfolioId, account, events) => settleCashSwaps(fn => withTransaction(client => fn({ query: (text, params) => client.query(text, params ? [...params] : []) })), v2, { chainId: v2.chainId, portfolioId, account }, events) });
    defaultV2Apis.set(key, api);
  }
  return api;
}
/**
 * My mix weight change, either generation (one account uses v1 or v2, never both): an account that has anything on
 * routing v2 re-consents there (`setStrategyPolicy` right after the enroll, in the same owner UserOp); every other account
 * gets the v1 calls exactly as before. Only an owner in the v2 audience can reach the v2 branch.
 */
export async function mixStrategyConsent(input: Parameters<typeof mixStrategyConsentCalls>[0] & { owner?: string }, deps: { chain?: StrategyEarnChain; v2?: (owner: string) => StrategyEarnV2 | null;
  v2Api?: (v2: StrategyEarnV2) => StrategyEarnV2Api } = {}): Promise<Call[]> {
  const v2 = input.owner ? (deps.v2 ?? ((owner: string) => strategyEarnV2For(97, owner)))(input.owner) : null;
  if (v2) {
    const api = (deps.v2Api ?? defaultStrategyEarnV2Api)(v2), account = input.account.toLowerCase() as Address;
    if (await api.active(account)) return api.reconsent(account, input.owner!.toLowerCase() as Address, { assets: input.assets, totalValueUsd: input.totalValueUsd });
  }
  return mixStrategyConsentCalls(input, deps.chain ?? defaultStrategyEarnChain());
}

let cachedMainnetRates: ReturnType<typeof createMainnetRates> | undefined;
const defaultMainnetRates = () => cachedMainnetRates ??= createMainnetRates({ markets: STRATEGY_EARN_97.markets.map(m => ({ symbol: m.symbol, protocol: m.protocol })) });

export function createStrategyEarn(overrides: Partial<StrategyEarnDeps> = {}) {
  const deps: StrategyEarnDeps = {
    chainId: Number(process.env.CHAIN_ID?.trim() || '56'), owned: requireOwnedPortfolio, now: () => new Date(), chain: defaultStrategyEarnChain,
    query: (sql, params) => dbQuery(sql, params) as never,
    ...overrides,
  };
  const markets = strategyMarkets();
  // Reward tokens (LISTA / XVS): mainnet only, behind STRATEGY_REWARDS_ENABLED. Off = the field is absent and nothing is read.
  const rewardsOn = () => deps.rewardsEnabled ?? strategyRewardsEnabled(deps.chainId);
  /** Ownership on this service's chain (the 97-only `owned` below belongs to the v1 position API). */
  const rewardsAccount = async (id: number, wallet: string) => {
    if (!rewardsOn()) throw new AppError(404, 'STRATEGY_REWARDS_NOT_CONFIGURED', '激勵領取尚未開放。');
    const p = await deps.owned(id, wallet);
    if (p.chainId !== deps.chainId || p.ownerAddress.toLowerCase() !== wallet.toLowerCase()) throw new AppError(403, 'FORBIDDEN', '只能操作本人於這條鏈的帳戶');
    return p.accountAddress.toLowerCase() as Address;
  };
  const ready = () => { if (deps.chainId !== 97) throw new AppError(404, 'STRATEGY_EARN_NOT_CONFIGURED', '策略加息目前僅開放測試網。'); };
  // ---- Routing v2 (src/strategy-earn-v2*.ts): one account uses v1 or v2, never both (cre8-contracts borrow-routing-v2 §12).
  // v2 answers only for an owner in the audience (strategyEarnV2For: a canary list today). For such an owner an account is
  // on v2 when it already has anything there; a clean account starts on v2; an account with a v1 position or v1 consent stays
  // on v1 until that is closed. Every other owner never reaches any of this.
  const v2Of = (owner: string): StrategyEarnV2 | null => typeof deps.v2 === 'function' ? deps.v2(owner) : deps.v2 === undefined ? strategyEarnV2For(deps.chainId, owner) : deps.v2;
  const v2ApiOf = (v2: StrategyEarnV2): StrategyEarnV2Api => deps.v2Api ? deps.v2Api(v2) : defaultStrategyEarnV2Api(v2);
  const v1Active = (chain: StrategyEarnChain, account: Address, block: bigint) => strategyEarnV1Active(chain, account, block);
  /**
   * The v2 side for this account, or null (= v1 answers). `forNew`: the request wants to turn the strategy on, so a clean
   * account of an audience owner starts on v2; otherwise only an account that already has something on v2 is v2.
   * A read that fails throws: which generation holds the money is never guessed.
   */
  async function v2Side(account: Address, wallet: string, forNew: boolean): Promise<{ api: StrategyEarnV2Api; v2: StrategyEarnV2 } | null> {
    const v2 = v2Of(wallet);
    if (!v2) return null;
    const api = v2ApiOf(v2);
    if (await api.active(account)) return { api, v2 };
    if (!forNew) return null;
    const chain = deps.chain(), head = await chain.head();
    return await v1Active(chain, account, head.number) ? null : { api, v2 };
  }
  const v2Unavailable = () => ({ status: 'unavailable' as const, reason: 'data_unavailable', message: TEMPORARILY });
  /** Newest active session key carries the whole routing v2 scope for this account (and the not-for-signatures flag). */
  async function v2KeyReady(id: number, account: Address, v2: StrategyEarnV2) {
    const rows = (await deps.query<{ permissions: unknown }>(`select permissions from session_keys where portfolio_id = $1 and status = 'active' and expires_at > now()
      order by (split_part(key_ref, '/', 6))::bigint desc limit 1`, [id])).rows;
    return rows[0] !== undefined && v2Authorized(rows[0].permissions, account, v2.executor, v2.swapper) && sessionPermissionFlagOf(rows[0].permissions) === SESSION_PERMISSION_FLAG;
  }
  const live = async () => { try { const chain = deps.chain(); return { chain, head: await chain.head() }; } catch { return null; } };
  // Where the money sits (public, for "Where your money goes"): the collateral market contract (Venus collateral vToken, or
  // Lista Moolah + market id), the USDT loan market (Venus vUSDT / the same Moolah market) and the strategy vault.
  const contracts = (m: StrategyMarket) => ({ collateralMarket: m.protocol === 'venus' ? m.collateralVToken : STRATEGY_EARN_97.listaMoolah, listaMarketId: m.listaId,
    loanMarket: m.protocol === 'venus' ? STRATEGY_EARN_97.vUSDT : STRATEGY_EARN_97.listaMoolah, vault: STRATEGY_EARN_97.earnVault });
  const quote = (m: StrategyMarket, s: StatusReading | null, at: string | null) => {
    if (!s) return { asset: m.symbol, marketId: m.marketId, protocol: m.protocol, status: 'unavailable' as const, reason: 'data_unavailable', message: TEMPORARILY,
      extraApyBps: null, breakdown: null, targetLtvBps: null, deleverageLtvBps: null, liquidationLtvBps: null, borrowUtilizationBps: null, vaultUtilizationBps: null,
      contracts: contracts(m), updatedAt: at };
    const apy = extraApy(s, s.targetLtv);
    const open = s.gate === 0;
    return { asset: m.symbol, marketId: m.marketId, protocol: m.protocol, status: open ? 'open' as const : 'unavailable' as const,
      reason: open ? null : GATE_REASONS[s.gate] ?? 'closed', message: open ? null : TEMPORARILY,
      extraApyBps: apy.totalBps, breakdown: apy.breakdown, targetLtvBps: toBps(s.targetLtv), deleverageLtvBps: toBps(s.deleverageLtv),
      liquidationLtvBps: toBps(s.liquidationLtv), borrowUtilizationBps: Number(s.borrowUtilizationBps), vaultUtilizationBps: Number(s.vaultUtilizationBps),
      contracts: contracts(m), updatedAt: at };
  };
  type MarketsView = { chainId: 97; updatedAt: string | null; vault: { address: string }; markets: ReturnType<typeof quote>[] };
  async function readMarkets(previous: MarketsView | null): Promise<MarketsView> {
    const l = await live();
    const at = l ? new Date(Number(l.head.timestamp) * 1000).toISOString() : null;
    const items = await Promise.all(markets.map(async m => {
      if (!l) return quote(m, null, at);
      try { return quote(m, await l.chain.status(m.marketId, '0x0000000000000000000000000000000000000000', l.head.number), at); } catch { return quote(m, null, at); }
    }));
    // A market that could not be read this time keeps its last reading (with its own older updatedAt) instead of going blank.
    const merged = items.map(q => q.reason === 'data_unavailable' ? previous?.markets.find(p => p.marketId === q.marketId && p.reason !== 'data_unavailable') ?? q : q);
    return { chainId: 97, updatedAt: at ?? previous?.updatedAt ?? null, vault: { address: STRATEGY_EARN_97.earnVault }, markets: merged };
  }
  let marketsCache: { at: number; value: MarketsView } | null = null;
  let marketsInflight: Promise<MarketsView> | null = null;
  const refreshMarkets = () => marketsInflight ??= readMarkets(marketsCache?.value ?? null).then(value => {
    if (value.updatedAt !== null) marketsCache = { at: deps.now().getTime(), value };
    return value;
  }).finally(() => { marketsInflight = null; });
  async function owned(id: number, wallet: string) {
    ready();
    const p = await deps.owned(id, wallet);
    if (p.chainId !== 97 || p.ownerAddress.toLowerCase() !== wallet.toLowerCase()) throw new AppError(403, 'FORBIDDEN', '只能操作本人於這條鏈的帳戶');
    return p.accountAddress.toLowerCase() as Address;
  }
  /** My mix: the strategy belongs to the mix's own account (one account per mix). A mix that is exiting (take profit /
   * stop loss), exited or being deleted sells everything to USDT, so it takes no new collateral or borrowing. */
  async function mixAccepting(id: number, wallet: string) {
    const p = await deps.owned(id, wallet);
    if (!p.personalMix) return;
    const m = (await deps.query<{ busy: boolean }>(`select (triggered_at is not null or status='exited' or delete_requested_at is not null) as busy
      from mixes where chain_id=97 and account=$1 and deleted_at is null`, [p.accountAddress.toLowerCase()])).rows[0];
    if (!m || m.busy) throw new AppError(409, 'MIX_EXITING', '組合正在退出或刪除，不能開啟加息策略。');
  }
  const findMarket = (asset: unknown) => {
    const m = markets.find(x => typeof asset === 'string' && x.symbol === asset);
    if (!m) throw new ValidationError('INVALID_ASSET', '這個資產沒有開放策略加息。');
    return m;
  };
  /** Newest active session key (the one the scheduler uses) carries the #204 AtpBorrowExecutor permissions for this account. */
  async function borrowKeyReady(id: number, account: Address) {
    const rows = (await deps.query<{ permissions: unknown }>(`select permissions from session_keys where portfolio_id = $1 and status = 'active' and expires_at > now()
      order by (split_part(key_ref, '/', 6))::bigint desc limit 1`, [id])).rows;
    // A key installed before SESSION_PERMISSION_FLAG can still pass the account's ERC-1271: ask for the renewal (same owner
    // UserOp as the consent, no extra screen) so it is replaced the next time the owner turns the yield strategy on.
    return rows[0] !== undefined && borrowAuthorized(rows[0].permissions, account) && sessionPermissionFlagOf(rows[0].permissions) === SESSION_PERMISSION_FLAG;
  }
  function body(input: unknown, keys: readonly string[]) {
    if (typeof input !== 'object' || input === null || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k)) || keys.some(k => !(k in input))) {
      throw new ValidationError('INVALID_STRATEGY_EARN_REQUEST', `請送出 ${keys.join('、')}。`);
    }
    return input as Record<string, unknown>;
  }
  /** One Lista market (its own debt): repay all (vault, then cash), take all shares back. */
  async function closeOne(account: Address, market: StrategyMarket, deadline: bigint): Promise<Call[]> {
      const [repay, withdraw] = closeCalls(market, account, deadline) as [Call, Call, Call];
      // Collateral posted but nothing borrowed (gate was closed at open): executeRepay would revert NothingToRepay and take
      // the whole UserOp with it; with nothing posted executeWithdrawCollateral reverts ZeroAmount. Skip what is not there.
      // Unreadable -> keep both (the chain still refuses anything wrong).
      const l = await live();
      if (l) {
        try {
          const [st, posted] = await Promise.all([l.chain.status(market.marketId, account, l.head.number), l.chain.collateral(market.marketId, account, l.head.number)]);
          return [...(st.debt > 0n || st.vaultAssets > 0n ? [repay] : []), ...(posted > 0n ? [withdraw] : [])];
        } catch { /* fall through */ }
      }
      return [repay, withdraw];
  }
  return {
    /** Pre-buy quote per eligible asset (ratio = target LTV). Leveraged products are never listed. */
    // Public and cached (MARKETS_CACHE_MS): fresh within the window; after it the last reading is served at once and
    // re-read in the background (one read in flight), so visitors never wait on, or multiply, the 31 status reads.
    // `mainnetRates` + per market `mainnet`: what the app displays (real BSC mainnet rates, same formula, ratio = this
    // market's target LTV). Testnet positions keep accruing at the simulated chain-97 rates above.
    async markets() {
      ready();
      const ttl = deps.marketsCacheMs ?? MARKETS_CACHE_MS;
      const view = ttl <= 0 ? await readMarkets(null) : marketsCache
        ? (deps.now().getTime() - marketsCache.at >= ttl && void refreshMarkets().catch(() => undefined), marketsCache.value) : await refreshMarkets();
      const rates = await (deps.mainnetRates ?? defaultMainnetRates()).get().catch(() => null);
      if (!rates) return { ...view, mainnetRates: null };
      return { ...view, mainnetRates: rates, markets: view.markets.map(q => ({ ...q, mainnet: mainnetQuote(rates, q.protocol, q.asset,
        q.targetLtvBps ?? null) })) };
    },
    /** This portfolio's positions; net value = collateral + vault - debt, kept apart from cash and Cash Earn. */
    async portfolio(id: number, wallet: string) {
      const account = await owned(id, wallet);
      try { const side = await v2Side(account, wallet, false); if (side) return await side.api.portfolio(id, account); }
      catch { return { portfolioId: id, account, status: 'unavailable' as const, reason: 'data_unavailable', message: TEMPORARILY, updatedAt: null, positions: [] }; }
      const l = await live();
      if (!l) return { portfolioId: id, account, status: 'unavailable' as const, reason: 'data_unavailable', message: TEMPORARILY, updatedAt: null, positions: [] };
      const { chain, head } = l;
      // Each open position's route (venue, loan token, base borrow rate, incentive, vault, ratio). v1 chain-97 positions sit in
      // one fixed simulated market, so their route is the mainnet route the app already shows for that asset (`simulated`);
      // routing v2 positions report the route they are really on (`onchain`). Cached mainnet rates: no chain read here.
      // `peek`: whatever GET /strategy-earn/markets last cached (the app always loads it first); this request never waits for the mainnet APIs.
      const source = deps.mainnetRates ?? defaultMainnetRates();
      const rates = source.peek ? source.peek() : await source.get().catch(() => null);
      const routeOf = (m: StrategyMarket) => {
        const q = rates ? mainnetQuote(rates, m.protocol, m.symbol, null) : null;
        return q ? { source: 'simulated' as const, venue: q.venue, loan: q.loan, marketId: q.marketId, borrowBps: q.borrowBps, borrowIncentiveBps: q.borrowIncentiveBps,
          vault: q.vault, ratioBps: q.ratioBps, since: null } : null;
      };
      let ids: Hex[];
      try { ids = await chain.accountMarkets(account, head.number); }
      catch { return { portfolioId: id, account, status: 'unavailable' as const, reason: 'data_unavailable', message: TEMPORARILY, updatedAt: null, positions: [] }; }
      const positions = await Promise.all(markets.filter(m => ids.includes(m.marketId)).map(async m => {
        try {
          const [s, posted, price, pending] = await Promise.all([chain.status(m.marketId, account, head.number), chain.collateral(m.marketId, account, head.number),
            chain.price(m.collateral, head.number), chain.rewards(m, account, head.number)]);
          const collateralValue = usdValue(posted, price, m.decimals);
          const ratio = s.ltv;
          return { asset: m.symbol, marketId: m.marketId, status: s.debt > 0n || posted > 0n ? 'on' as const : 'off' as const,
            collateralRaw: posted.toString(), collateralValueUsd: collateralValue.toString(), debtRaw: s.debt.toString(), vaultAssetsRaw: s.vaultAssets.toString(),
            netValueUsd: (collateralValue + s.vaultAssets - s.debt).toString(),
            // backend#204: portfolio snapshots/status already count the posted shares; add only this (may be negative).
            earnNetUsd: (s.vaultAssets - s.debt).toString(), pendingRewardsRaw: (pending.vault + pending.collateral).toString(),
            ltvBps: toBps(s.ltv), targetLtvBps: toBps(s.targetLtv), deleverageLtvBps: toBps(s.deleverageLtv), liquidationLtvBps: toBps(s.liquidationLtv),
            extraApyBps: extraApy(s, ratio).totalBps, shouldDeleverage: s.shouldDeleverage, shouldUnwind: s.shouldUnwind,
            newBorrowing: s.gate === 0 ? 'open' as const : 'unavailable' as const, reason: s.gate === 0 ? null : GATE_REASONS[s.gate] ?? 'closed', route: routeOf(m) };
        } catch {
          return { asset: m.symbol, marketId: m.marketId, status: 'unavailable' as const, message: TEMPORARILY };
        }
      }));
      splitVenusDebt(positions, markets);
      const earnNetUsd = positions.reduce((sum, p) => sum + ('earnNetUsd' in p && p.earnNetUsd !== undefined ? BigInt(p.earnNetUsd) : 0n), 0n);
      // autoOpen: the owner consented (a market's borrow policy is enabled) but nothing is posted yet — the buy has not
      // filled. The scheduler opens it after the fill (strategyEarnAutoOpen); the app shows the switch as on, "starts when your order fills".
      const autoOpen = positions.some(p => p.status === 'on') ? false
        : await consentedMarkets(chain, account, head.number, markets).then(c => c.size > 0, () => false);
      return { portfolioId: id, account, status: 'ok' as const, reason: null, message: null, updatedAt: new Date(Number(head.timestamp) * 1000).toISOString(),
        earnNetUsd: earnNetUsd.toString(), autoOpen, positions };
    },
    /**
     * The owner's signature for Lista's reward proof API (docs/strategy-earn-rewards.zh-TW.md): `{ signedAt, signature }`, the
     * account's ERC-1271 signature over REWARD_MESSAGE(signedAt). Kept 7 days; the weekly job reads proofs with it.
     */
    async rewardSignature(id: number, wallet: string, input: unknown) {
      const account = await rewardsAccount(id, wallet);
      const sig = parseRewardSignature(input, deps.now());
      await (deps.rewards ?? rewardsStore()).saveSignature(deps.chainId, id, account, sig);
      return { status: 'saved' as const, signedAt: sig.signedAt.toISOString() };
    },
    /** Reward tokens of this portfolio from the ledger (no chain read): in the account, earned but not yet claimed, and whether a new signature is due. */
    async rewards(id: number, wallet: string): Promise<RewardsView & { portfolioId: number; account: Address }> {
      // Routing v2 where there is no proof API (chain 97: the simulated vaults pay the box directly): the same ledger view,
      // and no owner signature is ever asked for.
      if (!rewardsOn() && v2Of(wallet)) {
        const account = await owned(id, wallet);
        const view = await (deps.rewards ?? rewardsStore()).view(deps.chainId, id, deps.now());
        return { portfolioId: id, account, ...view, signature: { needed: false, signedAt: null } };
      }
      const account = await rewardsAccount(id, wallet);
      return { portfolioId: id, account, ...await (deps.rewards ?? rewardsStore()).view(deps.chainId, id, deps.now()) };
    },
    /** One owner UserOp: consent + approvals (to AtpBorrowExecutor only) + post collateral + borrow into the vault. */
    async open(id: number, wallet: string, input: unknown) {
      const account = await owned(id, wallet);
      await mixAccepting(id, wallet);
      const b = body(input, ['asset', 'collateralRaw']);
      if (typeof b.collateralRaw !== 'string' || !/^[1-9][0-9]{0,77}$/.test(b.collateralRaw)) throw new ValidationError('INVALID_AMOUNT', 'collateralRaw 須為正整數字串。');
      const collateralRaw = BigInt(b.collateralRaw);
      let side: Awaited<ReturnType<typeof v2Side>>;
      try { side = await v2Side(account, wallet, true); } catch { return { ...v2Unavailable(), asset: String(b.asset) }; }
      if (side) {
        if (typeof b.asset !== 'string' || !/^[A-Za-z0-9]{1,16}$/.test(b.asset)) throw new ValidationError('INVALID_ASSET', '這個資產沒有開放策略加息。');
        try {
          const chain = deps.chain(), head = await chain.head();
          const r = await side.api.open(account, wallet.toLowerCase() as Address, { symbol: b.asset, collateralRaw, weights: await chain.weights(account, head.number), keyReady: await v2KeyReady(id, account, side.v2) });
          if (r.status === 'insufficient') throw new ValidationError('INSUFFICIENT_HOLDING', '投資組合持有的數量不足。');
          return r;
        } catch (error) { if (error instanceof AppError) throw error; return { ...v2Unavailable(), asset: b.asset }; }
      }
      const market = findMarket(b.asset);
      const l = await live();
      const unavailable = (reason: string) => ({ status: 'unavailable' as const, asset: market.symbol, reason, message: TEMPORARILY });
      if (!l) return unavailable('data_unavailable');
      const { chain, head } = l;
      let s: StatusReading, held: bigint, price: bigint, usdtPrice: bigint;
      try {
        [s, held, price, usdtPrice] = await Promise.all([chain.status(market.marketId, account, head.number), chain.balance(market.collateral, account, head.number),
          chain.price(market.collateral, head.number), chain.price(TESTNET_97.contracts.usdt as Address, head.number)]);
      } catch { return unavailable('data_unavailable'); }
      if (s.gate !== 0) return unavailable(GATE_REASONS[s.gate] ?? 'closed');
      if (collateralRaw > held) throw new ValidationError('INSUFFICIENT_HOLDING', '投資組合持有的數量不足。');
      // Venus health is account-wide (every market entered in that comptroller); Lista is per market.
      const plan = borrowPlan({ existingCollateralValue: s.health.collateralValue, addedCollateralValue: usdValue(collateralRaw, price, market.decimals),
        existingDebtValue: s.health.debtValue, targetLtv: s.targetLtv, usdtPriceE8: usdtPrice, currentDebtRaw: s.debt });
      const deadline = BigInt(Math.floor(deps.now().getTime() / 1000) + 30 * 60);
      return { status: 'ready' as const, asset: market.symbol, collateralRaw: collateralRaw.toString(), borrowRaw: plan.borrowRaw.toString(),
        maxDebtRaw: plan.maxDebtRaw.toString(), extraApyBps: extraApy(s, s.targetLtv).totalBps, ...withBatches(openCalls(market, account, collateralRaw, plan.borrowRaw, plan.maxDebtRaw, deadline)) };
    },
    /**
     * Buy confirmation with "Earn extra" on (backend#204, EARN_UX B.1): the owner's one consent, appended to the buy UserOp.
     * Every eligible asset in this portfolio's version gets the delegate grant, a debt ceiling and approvals — all to
     * AtpBorrowExecutor only. After the buy fills, the scheduler posts the shares and borrows with the session key
     * (no second signature). `budgetRaw` is the USDT about to be invested; the ceiling covers that plus what is already
     * held, at the target ratio, +10% for interest. `authorization: 'renewal_required'` = the newest session key cannot
     * make those calls yet: sign the renewal (GET /portfolios/:id/renewal-params) too.
     */
    async auto(id: number, wallet: string, input: unknown) {
      const account = await owned(id, wallet);
      await mixAccepting(id, wallet);
      const b = body(input, ['budgetRaw']);
      if (typeof b.budgetRaw !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(b.budgetRaw)) throw new ValidationError('INVALID_AMOUNT', 'budgetRaw 須為非負整數字串。');
      const budget = BigInt(b.budgetRaw);
      let side: Awaited<ReturnType<typeof v2Side>>;
      try { side = await v2Side(account, wallet, true); } catch { return v2Unavailable(); }
      if (side) {
        try {
          const chain = deps.chain(), head = await chain.head();
          return await side.api.auto(account, wallet.toLowerCase() as Address, { budgetRaw: budget, weights: await chain.weights(account, head.number), keyReady: await v2KeyReady(id, account, side.v2) });
        } catch { return v2Unavailable(); }
      }
      const l = await live();
      if (!l) return { status: 'unavailable' as const, reason: 'data_unavailable', message: TEMPORARILY };
      const { chain, head } = l;
      let weights: { asset: Address; weightBps: number }[];
      let usdtPrice: bigint;
      try { [weights, usdtPrice] = await Promise.all([chain.weights(account, head.number), chain.price(TESTNET_97.contracts.usdt as Address, head.number)]); }
      catch { return { status: 'unavailable' as const, reason: 'data_unavailable', message: TEMPORARILY }; }
      const eligible = markets.filter(m => weights.some(w => w.asset === m.collateral && w.weightBps > 0));
      // USD (1e18): new money's share of this asset + what the portfolio already holds of it.
      const quoted = await consentQuotes(chain, account, head, eligible, usdtPrice, (m, price, held) =>
        budget * BigInt(weights.find(x => x.asset === m.collateral)?.weightBps ?? 0) / 10_000n * usdtPrice / 10n ** 8n + usdValue(held, price, m.decimals));
      const ready = quoted.filter((q): q is Extract<typeof q, { status: 'ready' }> => q.status === 'ready');
      const assets = quoted.map(q => q.status === 'ready' ? { asset: q.market.symbol, status: q.status, maxDebtRaw: q.maxDebtRaw.toString(), extraApyBps: q.extraApyBps }
        : { asset: q.market.symbol, status: q.status, reason: q.reason, message: TEMPORARILY });
      if (ready.length === 0) return { status: 'unavailable' as const, reason: eligible.length === 0 ? 'no_eligible_asset' : 'data_unavailable', message: TEMPORARILY, assets };
      return { status: 'ready' as const, authorization: await borrowKeyReady(id, account) ? 'ready' as const : 'renewal_required' as const,
        assets, ...withBatches(consentCalls(ready.map(q => ({ market: q.market, maxDebtRaw: q.maxDebtRaw })))) };
    },
    /** Activity (EARN_UX B.6): newest first, one plain sentence each, from the verified ledger (db 0063). */
    async activity(id: number, wallet: string) {
      const account = await owned(id, wallet);
      // A My mix weight change moves the same account to a new portfolio id; its earlier strategy events stay with the mix.
      const rows = (await deps.query<{ kind: StrategyEarnKind; asset: string | null; amount_raw: string; collateral_raw: string; ltv_before_bps: number | null;
        ltv_after_bps: number | null; tx_hash: string; block_number: string; created_at: Date | string }>(
        `select kind, asset, amount_raw::text, collateral_raw::text, ltv_before_bps, ltv_after_bps, tx_hash, block_number::text, created_at
           from strategy_earn_events where chain_id = 97 and (portfolio_id = $1 or portfolio_id in (select h.portfolio_id from mix_portfolio_history h
             join mixes m on m.id = h.mix_id where m.chain_id = 97 and m.account = $2)) order by block_number desc, log_index desc limit 50`, [id, account])).rows;
      const v1 = rows.map(r => {
        r = { ...r, asset: markets.find(m => m.symbol.toUpperCase() === r.asset)?.symbol ?? r.asset };
        const e = { kind: r.kind, asset: r.asset, amountRaw: BigInt(r.amount_raw), collateralRaw: BigInt(r.collateral_raw), ltvBeforeBps: r.ltv_before_bps, ltvAfterBps: r.ltv_after_bps };
        return { kind: r.kind as StrategyEarnKind | RouteEventKind, asset: r.asset, amountRaw: r.amount_raw, collateralRaw: r.collateral_raw, ltvBeforeBps: r.ltv_before_bps, ltvAfterBps: r.ltv_after_bps,
          txHash: r.tx_hash, blockNumber: r.block_number, createdAt: new Date(r.created_at).toISOString(), message: strategyEarnMessage(e) };
      });
      // Routing v2 (db 0069): route changes and the other v2 events, only when a v2 deployment is configured for this chain.
      const v2 = v2Of(wallet);
      if (!v2) return { portfolioId: id, activity: v1 };
      const moved = (await deps.query<{ kind: RouteEventKind; asset: string | null; reason: string | null; venue: string | null; loan: string | null; vault_venue: string | null;
        amount_raw: string; collateral_raw: string; tx_hash: string; block_number: string; created_at: Date | string }>(
        `select kind, asset, reason, venue, loan, vault_venue, amount_raw::text, collateral_raw::text, tx_hash, block_number::text, created_at
           from strategy_route_events where chain_id = $3 and kind <> 'release' and (portfolio_id = $1 or portfolio_id in (select h.portfolio_id from mix_portfolio_history h
             join mixes m on m.id = h.mix_id where m.chain_id = $3 and m.account = $2)) order by block_number desc, log_index desc limit 50`, [id, account, deps.chainId])).rows;
      const routed = moved.map(r => { const text = routeMessage({ kind: r.kind, asset: r.asset });
        return { kind: r.kind as StrategyEarnKind | RouteEventKind, asset: r.asset, amountRaw: r.amount_raw, collateralRaw: r.collateral_raw, ltvBeforeBps: null, ltvAfterBps: null,
          txHash: r.tx_hash, blockNumber: r.block_number, createdAt: new Date(r.created_at).toISOString(), message: text?.en ?? '', messageZh: text?.zh ?? '',
          reason: r.reason, venue: r.venue, loan: r.loan, vaultVenue: r.vault_venue }; });
      return { portfolioId: id, activity: [...v1, ...routed].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 50) };
    },
    /**
     * The owner's own UserOp (turn on, turn off, open after a fill) is mined: record its business events from the
     * verified receipt, the same ledger the scheduler and the keeper write (db 0063). Only AtpBorrowExecutor (and the
     * paying market's) events about THIS portfolio's account count (strategyEarnEvents), so any tx hash is safe to
     * submit; a re-sent hash records nothing new (unique chain/tx/log). Not mined yet -> 'pending', ask again.
     */
    async confirm(id: number, wallet: string, input: unknown) {
      const account = await owned(id, wallet);
      const b = body(input, ['txHash']);
      if (typeof b.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(b.txHash)) throw new ValidationError('INVALID_TX_HASH', 'txHash 須為 0x 開頭的 32 位元組。');
      let tx;
      try {
        const chain = deps.chain();
        if (!chain.receipt) return { status: 'unavailable' as const, reason: 'data_unavailable', message: TEMPORARILY };
        tx = await chain.receipt(b.txHash.toLowerCase() as Hex);
      } catch { return { status: 'unavailable' as const, reason: 'data_unavailable', message: TEMPORARILY }; }
      if (tx === null) return { status: 'pending' as const, recorded: 0 };
      if (!tx.success) return { status: 'reverted' as const, recorded: 0 };
      const events = strategyEarnEvents(tx, id, account);
      await (deps.ledger ?? dbStrategyEarnLedger).record(97, events);
      // Routing v2: the same receipt may carry AtpBorrowExecutorV2 events of this account (db 0069) and reward movements (db 0068).
      const v2 = v2Of(wallet);
      if (v2) {
        try {
          const more = await v2ApiOf(v2).confirm(id, account, wallet.toLowerCase() as Address, tx);
          // An owner UserOp changed the v2 position: the scheduler looks at the portfolio in its next round instead of at the
          // end of its idle back-off — what the owner's turn-off could not close (a little USDT missing) is finished then.
          if (more.kinds.length > 0) { try { await deps.query('update portfolios set next_run_at=null where id=$1', [id]); } catch { /* the regular round comes anyway */ } }
          return { status: 'confirmed' as const, recorded: events.length + more.routes + more.rewards, kinds: [...events.map(e => e.kind as string), ...more.kinds] };
        } catch { return { status: 'unavailable' as const, reason: 'data_unavailable', message: TEMPORARILY }; }
      }
      return { status: 'confirmed' as const, recorded: events.length, kinds: events.map(e => e.kind) };
    },
    /**
     * Routing v2, owner only (cre8-contracts borrow-routing-v2 §4): a vault or its adapter is broken — with no debt left in
     * that vault's token, the strategy box's receipts go back to the account as they are. The paymaster sponsors the call
     * only in a UserOp signed by the account's root validator; no session key and no operator key ever sends it.
     */
    async rescue(id: number, wallet: string, input: unknown) {
      const account = await owned(id, wallet);
      const b = body(input, ['vaultId']);
      if (typeof b.vaultId !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(b.vaultId)) throw new ValidationError('INVALID_STRATEGY_EARN_REQUEST', 'vaultId 須為 0x 開頭的 32 位元組。');
      const v2 = v2Of(wallet);
      if (!v2) throw new AppError(404, 'STRATEGY_EARN_NOT_CONFIGURED', '這個帳戶沒有可救援的部位。');
      try { return await v2ApiOf(v2).rescue(account, b.vaultId.toLowerCase() as Hex); } catch { return v2Unavailable(); }
    },
    /** Turn off / before selling: repay first (vault, then the account's own USDT), then withdraw all collateral. */
    /**
     * Turn off. `{ assets: [...] }` (the app sends every asset that is on, in one UserOp) or `{ asset }`. Lista: per market
     * as below. Venus: planned together (venusReleaseCalls) — the account has ONE Venus debt, so the markets share the
     * repayment and nothing is asked of a single market's vault that it cannot pay.
     */
    async close(id: number, wallet: string, input: unknown) {
      const account = await owned(id, wallet);
      // `exit: true` (routing v2 only; sell all / withdraw / delete): reward tokens also go to the owner's wallet.
      const exit = typeof input === 'object' && input !== null && 'exit' in input && (input as { exit?: unknown }).exit === true;
      if (typeof input === 'object' && input !== null && 'exit' in input) { const { exit: _exit, ...rest } = input as Record<string, unknown>; input = rest; }
      let side: Awaited<ReturnType<typeof v2Side>>;
      try { side = await v2Side(account, wallet, false); } catch { return { status: 'unavailable' as const, reason: 'data_unavailable', message: TEMPORARILY }; }
      if (side) {
        const list = typeof input === 'object' && input !== null && 'assets' in input ? body(input, ['assets']).assets : [body(input, ['asset']).asset];
        if (!Array.isArray(list) || list.length === 0 || list.length > 64 || list.some(a => typeof a !== 'string' || !/^[A-Za-z0-9]{1,16}$/.test(a))) throw new ValidationError('INVALID_STRATEGY_EARN_REQUEST', '請送出 asset 或 assets。');
        try { return await side.api.close(account, { symbols: list as string[], exit }); } catch { return { status: 'unavailable' as const, reason: 'data_unavailable', message: TEMPORARILY }; }
      }
      const raw = typeof input === 'object' && input !== null && 'assets' in input ? body(input, ['assets']).assets : [body(input, ['asset']).asset];
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > markets.length) throw new ValidationError('INVALID_STRATEGY_EARN_REQUEST', '請送出 asset 或 assets。');
      const chosen = [...new Set(raw)].map(findMarket);
      const deadline = BigInt(Math.floor(deps.now().getTime() / 1000) + 30 * 60);
      const venus = chosen.filter(m => m.protocol === 'venus');
      const l = venus.length > 0 ? await live() : null;
      if (venus.length > 0 && !l) return { status: 'unavailable' as const, reason: 'data_unavailable', message: TEMPORARILY };
      let venusCalls: Call[] = [];
      if (l && venus.length > 0) {
        try {
          const ids = await l.chain.accountMarkets(account, l.head.number);
          const [positions, cash, usdtPrice] = await Promise.all([readVenusPositions(l.chain, account, l.head.number, [...new Set([...ids, ...venus.map(m => m.marketId)])]),
            l.chain.balance(TESTNET_97.contracts.usdt as Address, account, l.head.number), l.chain.price(TESTNET_97.contracts.usdt as Address, l.head.number)]);
          venusCalls = venusReleaseCalls({ account, positions, release: venus.map(m => m.marketId), cash, usdtPriceE8: usdtPrice, deadline }).calls;
        } catch { return { status: 'unavailable' as const, reason: 'data_unavailable', message: TEMPORARILY }; }
      }
      const off = (m: StrategyMarket) => call(STRATEGY_EARN_97.registry, 'setBorrowPolicy', [m.marketId, 0n, false]);
      const listaGroups: Call[][] = [];
      for (const market of chosen.filter(m => m.protocol !== 'venus')) listaGroups.push([...(await closeOne(account, market, deadline)), off(market)]);
      const consent = chosen.map(off);
      const calls = [...venusCalls, ...listaGroups.flatMap(g => g.slice(0, -1)), ...consent];
      // `batches`: what the wallet sends, one owner UserOp each, so a big portfolio stays under the per-UserOp gas cap.
      // Up to three markets: one UserOp, exactly `calls`. More: Venus first (one shared debt, planned as one sequence and cut
      // in order; its consent is withdrawn in the UserOp that finishes it), then three Lista markets per UserOp, each with
      // its own consent withdrawal. So whatever UserOps landed are fully turned off (the scheduler will not reopen them),
      // and a retry after a failure asks again and closes only what is still on.
      let batches: Call[][] = [calls];
      if (chosen.length > STRATEGY_EARN_MARKETS_PER_USER_OP) {
        // Up to three Venus markets (repay all, then withdraw all) stay one UserOp; more are cut in order.
        batches = venus.length <= STRATEGY_EARN_MARKETS_PER_USER_OP ? (venusCalls.length > 0 ? [[...venusCalls]] : []) : strategyEarnBatches(venusCalls);
        if (venus.length > 0) { if (batches.length === 0) batches.push([]); batches[batches.length - 1]!.push(...venus.map(off)); }
        for (let i = 0; i < listaGroups.length; i += STRATEGY_EARN_MARKETS_PER_USER_OP) batches.push(listaGroups.slice(i, i + STRATEGY_EARN_MARKETS_PER_USER_OP).flat());
      }
      return { status: 'ready' as const, asset: chosen[0]!.symbol, assets: chosen.map(m => m.symbol), calls, batches };
    },
  };
}

/** A mined transaction the ledger can read: its hash, block and the logs it emitted. */
export type StrategyEarnTx = { hash: Hex; blockNumber: bigint; logs: readonly Log[] };
/** Keeper writer: AtpBorrowExecutor.executeDeleverage and every market's claimReward are anyone-callable and only
 * touch / pay that account's own position. */
export type StrategyKeeperWriter = {
  deleverage(account: Address, marketId: Hex): Promise<StrategyEarnTx>;
  /** Strategy vault or a Venus collateral vToken: `claimReward(account)`. */
  claim(target: Address, account: Address): Promise<StrategyEarnTx>;
  /** Lista Moolah: `claimReward(listaId, account)` (backend#204). */
  claimLista(listaId: Hex, account: Address): Promise<StrategyEarnTx>;
  /** Any anyone-callable transaction with the same key (routing v2: executeDeleverage, collectRewards; the callers restrict
   * what goes here, see v2KeeperCall). Gas = the node's estimate + 50%, at most 12M. */
  send?(to: Address, data: Hex): Promise<StrategyEarnTx>;
};
export function strategyKeeperWriter(env: NodeJS.ProcessEnv = process.env): StrategyKeeperWriter | null {
  const raw = env.STRATEGY_EARN_KEEPER_PRIVATE_KEY?.trim();
  if (!raw) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error('STRATEGY_EARN_KEEPER_PRIVATE_KEY must be a 32-byte hex key');
  const rpc = env.RPC_URL?.trim();
  if (!rpc) throw new Error('RPC_URL is required for the strategy earn keeper');
  const account = privateKeyToAccount(raw as Hex);
  const wallet = createWalletClient({ account, chain: bscTestnet, transport: rpcTransport('strategy-earn', rpc, { retryCount: 1, timeout: 15_000 }) });
  const pub = createPublicClient({ chain: bscTestnet, ...rpcBatch(rpc), transport: rpcTransport('strategy-earn', rpc, { retryCount: 1, timeout: 15_000 }) });
  const send = async (to: Address, data: Hex): Promise<StrategyEarnTx> => {
    const hash = await wallet.sendTransaction({ to, data, gas: 1_500_000n, gasPrice: await pub.getGasPrice() });
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== 'success') throw new Error('reverted ' + hash);
    return { hash, blockNumber: receipt.blockNumber, logs: receipt.logs };
  };
  return {
    deleverage: (account, marketId) => send(STRATEGY_EARN_97.executor, call(STRATEGY_EARN_97.executor, 'executeDeleverage', [account, marketId]).data),
    claim: (target, account) => send(target, encodeFunctionData({ abi: STRATEGY_EARN_ABI, functionName: 'claimReward', args: [account] })),
    claimLista: (listaId, account) => send(STRATEGY_EARN_97.listaMoolah, encodeFunctionData({ abi: STRATEGY_EARN_ABI, functionName: 'claimReward', args: [listaId, account] })),
    async send(to, data) {
      const estimate = await pub.estimateGas({ account: account.address, to, data });
      const gas = estimate * 3n / 2n > 12_000_000n ? 12_000_000n : estimate * 3n / 2n;
      const hash = await wallet.sendTransaction({ to, data, gas, gasPrice: await pub.getGasPrice() });
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
      if (receipt.status !== 'success') throw new Error('reverted ' + hash);
      return { hash, blockNumber: receipt.blockNumber, logs: receipt.logs };
    },
  };
}

// ---------------------------------------------------------------------------
// Ledger (db 0063 strategy_earn_events, backend#204): one row per verified business event
// ---------------------------------------------------------------------------

export type StrategyEarnKind = 'open' | 'deleverage' | 'unwind' | 'repay' | 'close' | 'claim';
export type StrategyEarnEvent = { portfolioId: number; account: Address; marketId: Hex; asset: string | null; kind: StrategyEarnKind;
  amountRaw: bigint; collateralRaw: bigint; ltvBeforeBps: number | null; ltvAfterBps: number | null; txHash: Hex; logIndex: number; blockNumber: bigint };
type Decoded = { name: string; args: Record<string, unknown>; logIndex: number; address: Address };
function decodeEarnLogs(logs: readonly Log[], account: Address): Decoded[] {
  const out: Decoded[] = [];
  for (const log of logs) {
    if (log.removed) throw new Error('removed log in strategy earn receipt');
    let event;
    try { event = decodeEventLog({ abi: STRATEGY_EARN_EVENTS_ABI, data: log.data, topics: log.topics, strict: true }); } catch { continue; }
    const args = event.args as Record<string, unknown>;
    if (typeof args.account !== 'string' || args.account.toLowerCase() !== account.toLowerCase() || log.logIndex === null) continue;
    out.push({ name: event.eventName, args, logIndex: log.logIndex, address: log.address.toLowerCase() as Address });
  }
  return out;
}
const marketBySym = (id: unknown) => strategyMarkets().find(m => typeof id === 'string' && m.marketId === id.toLowerCase());
/**
 * Business events of one mined transaction for this account. Only logs emitted by AtpBorrowExecutor (or, for rewards,
 * the strategy vault / market that pays) count, so a spoofed event from another contract is ignored.
 * `deleverageLine` (1e18) tells a deleverage from an unwind (the executor emits the same event for both).
 */
export function strategyEarnEvents(tx: StrategyEarnTx, portfolioId: number, account: Address, deleverageLine?: (marketId: Hex) => bigint | undefined): StrategyEarnEvent[] {
  const S = STRATEGY_EARN_97;
  const decoded = decodeEarnLogs(tx.logs, account);
  const fromExecutor = decoded.filter(e => e.address === S.executor);
  const base = { portfolioId, account: account.toLowerCase() as Address, txHash: tx.hash.toLowerCase() as Hex, blockNumber: tx.blockNumber };
  const events: StrategyEarnEvent[] = [];
  const repaidIn = (marketId: string) => fromExecutor.filter(e => e.name === 'Repaid' && String(e.args.marketId).toLowerCase() === marketId)
    .reduce((sum, e) => sum + (e.args.amount as bigint), 0n);
  for (const e of fromExecutor) {
    const m = marketBySym(e.args.marketId);
    if (!m) continue;
    const at = { ...base, marketId: m.marketId, asset: m.symbol, logIndex: e.logIndex };
    if (e.name === 'Borrowed') {
      const posted = fromExecutor.find(x => x.name === 'CollateralSupplied' && String(x.args.marketId).toLowerCase() === m.marketId);
      events.push({ ...at, kind: 'open', amountRaw: e.args.amount as bigint, collateralRaw: (posted?.args.amount as bigint | undefined) ?? 0n, ltvBeforeBps: null, ltvAfterBps: null });
    } else if (e.name === 'CollateralSupplied' && !fromExecutor.some(x => x.name === 'Borrowed' && String(x.args.marketId).toLowerCase() === m.marketId)) {
      events.push({ ...at, kind: 'open', amountRaw: 0n, collateralRaw: e.args.amount as bigint, ltvBeforeBps: null, ltvAfterBps: null });
    } else if (e.name === 'Deleveraged') {
      const before = e.args.ltvBefore as bigint, line = deleverageLine?.(m.marketId);
      events.push({ ...at, kind: line !== undefined && before < line ? 'unwind' : 'deleverage', amountRaw: e.args.repaid as bigint, collateralRaw: 0n,
        ltvBeforeBps: toBps(before), ltvAfterBps: toBps(e.args.ltvAfter as bigint) });
    } else if (e.name === 'CollateralWithdrawn') {
      events.push({ ...at, kind: 'close', amountRaw: repaidIn(m.marketId), collateralRaw: e.args.amount as bigint, ltvBeforeBps: null, ltvAfterBps: null });
    } else if (e.name === 'Repaid' && !fromExecutor.some(x => (x.name === 'CollateralWithdrawn' || x.name === 'Deleveraged') && String(x.args.marketId).toLowerCase() === m.marketId) &&
        e === fromExecutor.find(x => x.name === 'Repaid' && String(x.args.marketId).toLowerCase() === m.marketId)) {
      events.push({ ...at, kind: 'repay', amountRaw: repaidIn(m.marketId), collateralRaw: 0n, ltvBeforeBps: null, ltvAfterBps: null });
    }
  }
  for (const e of decoded.filter(x => x.name === 'RewardClaimed')) {
    const amount = e.args.amount as bigint;
    if (amount === 0n) continue;
    if (e.address === S.earnVault) events.push({ ...base, marketId: S.earnVaultMarketId, asset: null, kind: 'claim', amountRaw: amount, collateralRaw: 0n, ltvBeforeBps: null, ltvAfterBps: null, logIndex: e.logIndex });
    const m = strategyMarkets().find(x => (x.collateralVToken !== null && x.collateralVToken === e.address) ||
      (x.listaId !== null && e.address === S.listaMoolah && String(e.args.id).toLowerCase() === x.listaId));
    if (m) events.push({ ...base, marketId: m.marketId, asset: m.symbol, kind: 'claim', amountRaw: amount, collateralRaw: 0n, ltvBeforeBps: null, ltvAfterBps: null, logIndex: e.logIndex });
  }
  return events.sort((a, b) => a.logIndex - b.logIndex);
}

export type StrategyEarnLedger = { record(chainId: number, events: readonly StrategyEarnEvent[]): Promise<void> };
/** Idempotent: a re-read receipt hits (chain, tx, log) and is skipped. */
export const strategyEarnLedger = (run: (sql: string, params: unknown[]) => Promise<unknown> = dbQuery): StrategyEarnLedger => ({
  async record(chainId, events) {
    for (const e of events) {
      await run(`insert into strategy_earn_events(chain_id,portfolio_id,account,market_id,asset,kind,amount_raw,collateral_raw,
          ltv_before_bps,ltv_after_bps,tx_hash,log_index,block_number) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        on conflict (chain_id,tx_hash,log_index) do nothing`,
        // db 0063 allows asset ^[A-Z0-9]{1,16}$: 'XAUt' failed the check (2026-11-24, mix portfolio 20) and the rest of
        // that receipt went unrecorded. Store it upper-cased; activity maps it back to the market's symbol.
        [chainId, e.portfolioId, e.account, e.marketId, e.asset?.toUpperCase() ?? null, e.kind, e.amountRaw.toString(), e.collateralRaw.toString(),
          e.ltvBeforeBps, e.ltvAfterBps, e.txHash, e.logIndex, e.blockNumber.toString()]);
    }
  },
});
export const dbStrategyEarnLedger: StrategyEarnLedger = strategyEarnLedger();

const usdt2 = (raw: bigint) => { const cents = raw / 10n ** 16n; return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`; };
const shares = (raw: bigint) => { const milli = raw / 10n ** 15n; const whole = milli / 1000n, frac = (milli % 1000n).toString().padStart(3, '0').replace(/0+$/, ''); return frac ? `${whole}.${frac}` : `${whole}`; };
const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;
/** One plain sentence for the activity list (EARN_UX B.6). No collateral / LTV / borrow wording; the numbers are also returned as fields. */
export function strategyEarnMessage(e: Pick<StrategyEarnEvent, 'kind' | 'asset' | 'amountRaw' | 'collateralRaw' | 'ltvBeforeBps' | 'ltvAfterBps'>): string {
  const asset = e.asset ?? 'your portfolio';
  switch (e.kind) {
    case 'open': return `Earn extra turned on for ${asset}: ${shares(e.collateralRaw)} ${asset} put to work${e.amountRaw > 0n ? `, ${usdt2(e.amountRaw)} USDT now earning` : ''}.`;
    case 'deleverage': return `${asset} fell, so we automatically used ${usdt2(e.amountRaw)} USDT from Earn to stay safe (safety level ${pct(e.ltvBeforeBps ?? 0)} → ${pct(e.ltvAfterBps ?? 0)}).`;
    case 'unwind': return `Earn extra on ${asset} was no longer worth it, so we automatically settled ${usdt2(e.amountRaw)} USDT.`;
    case 'repay': return `We settled ${usdt2(e.amountRaw)} USDT of Earn extra on ${asset}.`;
    case 'close': return `Earn extra turned off for ${asset}: settled ${usdt2(e.amountRaw)} USDT and ${shares(e.collateralRaw)} ${asset} back in your portfolio.`;
    case 'claim': return `Received ${usdt2(e.amountRaw)} USDT in Earn rewards${e.asset ? ` on ${e.asset}` : ''}.`;
  }
}

/**
 * Chain 97 drill accounts (backend#207): extra addresses the keeper watches besides DB portfolio accounts, e.g. the
 * contracts repo's BorrowDemoAccount used to rehearse "price drop -> automatic deleverage". Comma separated; any
 * malformed entry throws (a silently skipped address would make a drill look like a keeper failure).
 */
export function strategyEarnDrillAccounts(env: NodeJS.ProcessEnv = process.env): Address[] {
  const raw = env.STRATEGY_EARN_DRILL_ACCOUNTS?.trim();
  if (!raw) return [];
  return [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean).map(s => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(s)) throw new Error('STRATEGY_EARN_DRILL_ACCOUNTS must be comma-separated 0x addresses');
    return s.toLowerCase() as Address;
  }))];
}

/** Claim when at least 0.01 USDT is pending, so gas is not spent on dust. */
export const MIN_CLAIM_RAW = 10n ** 16n;
export type StrategyKeeperResult = { checked: number; flagged: number; deleveraged: number; claimed: number; failed: number; writer: boolean };

/**
 * Scheduler step (chain 97): for every active portfolio account, read each open position; send executeDeleverage
 * when the registry says shouldDeleverage/shouldUnwind, and claim pending incentives to that same account.
 * Without a keeper key it only reports (dry-run behaves the same).
 */
export async function runStrategyEarnRound(args: { dryRun: boolean; log: (line: string) => void }, overrides: {
  chainId?: number; chain?: StrategyEarnChain; writer?: StrategyKeeperWriter | null;
  /** DB portfolio accounts; `portfolioId` lets the keeper write the ledger (drill accounts have none and are not recorded). */
  accounts?: () => Promise<{ account: Address; portfolioId: number }[]>; env?: NodeJS.ProcessEnv; ledger?: StrategyEarnLedger;
} = {}): Promise<StrategyKeeperResult | null> {
  const chainId = overrides.chainId ?? Number(process.env.CHAIN_ID?.trim() || '56');
  if (chainId !== 97) return null;
  const chain = overrides.chain ?? defaultStrategyEarnChain();
  const writer = overrides.writer === undefined ? strategyKeeperWriter() : overrides.writer;
  const ledger = overrides.ledger ?? dbStrategyEarnLedger;
  const portfolioAccounts = await (overrides.accounts ?? (async () => (await dbQuery<{ address: string; portfolio_id: string }>(
    `select sa.address, sa.portfolio_id::text from smart_accounts sa join portfolios p on p.id=sa.portfolio_id
      where sa.chain_id=97 and sa.retired_at is null order by sa.address`)).rows.map(r => ({ account: r.address.toLowerCase() as Address, portfolioId: Number(r.portfolio_id) }))))();
  const portfolioOf = new Map(portfolioAccounts.map(a => [a.account, a.portfolioId]));
  const accounts = [...new Set([...portfolioAccounts.map(a => a.account), ...strategyEarnDrillAccounts(overrides.env ?? process.env)])];
  const result: StrategyKeeperResult = { checked: 0, flagged: 0, deleveraged: 0, claimed: 0, failed: 0, writer: writer !== null };
  const head = await chain.head();
  const markets = strategyMarkets();
  // A ledger failure never undoes or repeats the chain action; it is logged and the tx hash stays in the log line.
  const record = async (account: Address, tx: StrategyEarnTx, line?: (id: Hex) => bigint | undefined) => {
    const portfolioId = portfolioOf.get(account);
    if (portfolioId === undefined) return;
    try { await ledger.record(97, strategyEarnEvents(tx, portfolioId, account, line)); }
    catch { args.log(`[strategy-earn] ${account} 帳本寫入失敗（鏈上已完成）tx=${tx.hash}`); }
  };
  for (const account of accounts) {
    let ids: Hex[];
    try { ids = await chain.accountMarkets(account, head.number); } catch { result.failed++; continue; }
    let vaultClaimed = false;
    for (const market of markets.filter(m => ids.includes(m.marketId))) {
      result.checked++;
      try {
        const s = await chain.status(market.marketId, account, head.number);
        if (s.shouldDeleverage || s.shouldUnwind) {
          result.flagged++;
          const why = s.shouldDeleverage ? `LTV ${toBps(s.ltv)} bps ≥ ${toBps(s.deleverageLtv)} bps` : '利差為負或 vault 使用率 > 95%';
          if (args.dryRun || !writer) args.log(`[strategy-earn] ${account} ${market.symbol} 需要${s.shouldDeleverage ? '減倉' : '收掉'}（${why}）${writer ? '' : '；沒有 keeper 金鑰，未送出'}`);
          else {
            const tx = await writer.deleverage(account, market.marketId); result.deleveraged++;
            args.log(`[strategy-earn] ${account} ${market.symbol} 已自動${s.shouldDeleverage ? '減倉' : '收掉'}（${why}）tx=${tx.hash}`);
            await record(account, tx, id => id === market.marketId ? s.deleverageLtv : undefined);
          }
        }
        if (!args.dryRun && writer) {
          // Incentives are paid by the market to this same account (no receiver argument): they stay in this portfolio.
          const pending = await chain.rewards(market, account, head.number);
          // The strategy vault reward is per account, not per market: claim it once per account.
          if (!vaultClaimed && pending.vault >= MIN_CLAIM_RAW) { await record(account, await writer.claim(STRATEGY_EARN_97.earnVault, account)); result.claimed++; }
          vaultClaimed = true;
          if (pending.collateral >= MIN_CLAIM_RAW) {
            if (market.collateralVToken) { await record(account, await writer.claim(market.collateralVToken, account)); result.claimed++; }
            else if (market.listaId) { await record(account, await writer.claimLista(market.listaId, account)); result.claimed++; }
          }
        }
      } catch { result.failed++; args.log(`[strategy-earn] ${account} ${market.symbol} 讀值或送出失敗，下輪再試`); }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Scheduler steps with the portfolio's session key (backend#204)
// ---------------------------------------------------------------------------

/** Below this (USD, 1e18) an idle holding is not worth a UserOp. */
export const MIN_AUTO_OPEN_USD = 10n * E18;
/** Sends one session-key UserOp from the account (AtpBorrowExecutor calls only) and returns the mined receipt. */
export type StrategyEarnSend = (calls: Call[]) => Promise<StrategyEarnTx>;
export type StrategyEarnStepArgs = { chain: StrategyEarnChain; account: Address; portfolioId: number; now: Date; dryRun: boolean;
  /** Collateral the planner saw in the account (lowercase); when given, only those markets are read (fewer RPC reads
   * per quiet round). Absent = every market. */
  held?: readonly string[];
  /** null: no session key with the #204 permissions (owner has not renewed) — the step only reports. */
  send: StrategyEarnSend | null;
  /** Markets the session key may call (its installed ONE_OF list); absent = every market. A key renewed before
   * cre8-contracts#67 holds only the five #65 markets: calls for the others would fail the whole UserOp. */
  sendable?: readonly Hex[];
  ledger: StrategyEarnLedger; log: (line: string) => void };
/**
 * One session-key UserOp carries at most this many markets. A UserOp is capped at MAX_USER_OP_GAS (14M) and the sender
 * doubles the estimated call gas, so one UserOp for a whole portfolio stopped fitting at about seven markets
 * (portfolio 8, 2026-11-24: PAYMASTER_USER_OP_CAPACITY every round). Three keeps a wide margin.
 */
export const STRATEGY_EARN_MARKETS_PER_USER_OP = 3;
const marketOfCall = (c: Call): string => {
  try { return String((decodeFunctionData({ abi: STRATEGY_EARN_ABI, data: c.data }).args as readonly unknown[])[1]).toLowerCase(); } catch { return c.data; }
};
/**
 * Split executor calls into UserOps in the order given: consecutive calls on the same market stay together (post + borrow,
 * repay + withdraw), at most `marketsPerOp` such groups per UserOp. Every prefix of the original sequence is a state the
 * single UserOp would have passed through (each executor call checks the position on its own), so stopping between two
 * UserOps leaves nothing half-done; the next round re-reads the chain and plans only what is left.
 */
export function strategyEarnBatches(calls: readonly Call[], marketsPerOp = STRATEGY_EARN_MARKETS_PER_USER_OP): Call[][] {
  const groups: Call[][] = []; let last: string | null = null;
  for (const c of calls) { const m = marketOfCall(c); if (last !== null && m === last) groups[groups.length - 1]!.push(c); else groups.push([c]); last = m; }
  const out: Call[][] = [];
  for (let i = 0; i < groups.length; i += Math.max(1, marketsPerOp)) out.push(groups.slice(i, i + Math.max(1, marketsPerOp)).flat());
  return out;
}
/** Consent calls (delegations, ceilings, approvals) are light: this many fit one owner UserOp with a wide margin. */
export const STRATEGY_EARN_CONSENT_CALLS_PER_USER_OP = 40;
/** `calls` plus the same calls cut into owner UserOps (`batches`), in order. One asset's open, or a normal consent, is one batch. */
export const withBatches = (calls: Call[], perOp = STRATEGY_EARN_CONSENT_CALLS_PER_USER_OP) => {
  const batches: Call[][] = [];
  for (let i = 0; i < calls.length; i += perOp) batches.push(calls.slice(i, i + perOp));
  return { calls, batches };
};
const isCapacity = (error: unknown) => /USER_OP_CAPACITY/.test(`${(error as { code?: string })?.code ?? ''} ${(error as Error)?.message ?? ''}`);
/**
 * Send the calls as several sequential UserOps (strategyEarnBatches), each recorded in the ledger as it lands. A batch
 * that still does not fit is retried one market at a time. When a later UserOp fails, the error says how many landed.
 */
async function sendBatched(args: StrategyEarnStepArgs, calls: readonly Call[]): Promise<StrategyEarnTx[]> {
  const txs: StrategyEarnTx[] = [];
  const one = async (batch: Call[]) => { const tx = await args.send!(batch); await recordOrLog(args, tx); txs.push(tx); };
  try {
    for (const batch of strategyEarnBatches(calls)) {
      try { await one(batch); }
      catch (error) {
        const singles = strategyEarnBatches(batch, 1);
        if (!isCapacity(error) || singles.length < 2) throw error;
        for (const single of singles) await one(single);
      }
    }
  } catch (error) {
    if (txs.length === 0) throw error;
    const e = new Error(`已完成 ${txs.length} 筆（tx=${txs.map(t => t.hash).join(',')}），其餘未完成：${String((error as Error)?.message ?? error).split('\n')[0]}`);
    (e as Error & { code?: string }).code = (error as { code?: string })?.code;
    throw e;
  }
  return txs;
}
const txList = (txs: readonly StrategyEarnTx[]) => `tx=${txs.map(t => t.hash).join(',')}${txs.length > 1 ? `（分 ${txs.length} 筆）` : ''}`;
const keyCovers = (args: Pick<StrategyEarnStepArgs, 'sendable'>, m: StrategyMarket) => args.sendable === undefined || args.sendable.includes(m.marketId);

/**
 * After a buy has filled (the portfolio is otherwise idle): for every market the owner consented to at buy time
 * (policy enabled), post the shares the portfolio holds and borrow straight into the strategy vault, capped by the
 * target ratio and the owner's debt ceiling. Returns a one-line note, or null when there is nothing to do.
 * Never runs for a gate that is not open (EARN_UX D: utilization / negative carry -> no new borrowing).
 */
export async function strategyEarnAutoOpen(args: StrategyEarnStepArgs): Promise<string | null> {
  const { chain, account } = args;
  const candidates = strategyMarkets().filter(m => args.held === undefined || args.held.some(a => a.toLowerCase() === m.collateral));
  if (candidates.length === 0) return null;
  const head = await chain.head();
  // Consent given under the current enrollment only: after a My mix weight change, consent from before it is void on chain.
  const consented = await consentedMarkets(chain, account, head.number, candidates);
  if (consented.size === 0) return null;
  const usdtPrice = await chain.price(TESTNET_97.contracts.usdt as Address, head.number);
  const calls: Call[] = [];
  const opened: string[] = [];
  const renewal: string[] = [];
  const deadline = BigInt(Math.floor(args.now.getTime() / 1000) + 30 * 60);
  // Venus debt and health are account-wide (one comptroller, one USDT loan). Every Venus market here was read before
  // this UserOp, so each later one adds what the earlier ones in the same UserOp post and borrow; otherwise the second
  // market re-borrows against the same capacity and its ceiling check sees the first market's debt too.
  const venus = { addedValue: 0n, borrowRaw: 0n, borrowValue: 0n };
  for (const m of candidates) {
    const maxDebt = consented.get(m.marketId);
    if (maxDebt === undefined) continue;
    const policy = { maxDebt };
    const held = await chain.balance(m.collateral, account, head.number);
    if (held === 0n) continue;
    if (!keyCovers(args, m)) { renewal.push(m.symbol); continue; }
    const [st, price] = await Promise.all([chain.status(m.marketId, account, head.number), chain.price(m.collateral, head.number)]);
    if (st.gate !== 0) continue;
    const added = usdValue(held, price, m.decimals);
    if (added < MIN_AUTO_OPEN_USD) continue;
    const shared = m.protocol === 'venus' ? venus : { addedValue: 0n, borrowRaw: 0n, borrowValue: 0n };
    const debt = st.debt + shared.borrowRaw;
    const plan = borrowPlan({ existingCollateralValue: st.health.collateralValue + shared.addedValue, addedCollateralValue: added,
      existingDebtValue: st.health.debtValue + shared.borrowValue, targetLtv: st.targetLtv, usdtPriceE8: usdtPrice, currentDebtRaw: debt });
    // Keep 1% under the owner's ceiling: interest accrues between this read and inclusion.
    const headroom = policy.maxDebt > debt ? (policy.maxDebt - debt) * 9_900n / 10_000n : 0n;
    const borrow = plan.borrowRaw < headroom ? plan.borrowRaw : headroom;
    if (m.protocol === 'venus') { venus.addedValue += added; venus.borrowRaw += borrow; venus.borrowValue += borrow * usdtPrice / 10n ** 8n; }
    calls.push(call(STRATEGY_EARN_97.executor, 'executeSupplyCollateral', [account, m.marketId, held, deadline]));
    if (borrow > 0n) calls.push(call(STRATEGY_EARN_97.executor, 'executeBorrow', [account, m.marketId, borrow, deadline]));
    opened.push(`${m.symbol} ${shares(held)}${borrow > 0n ? `／借 ${usdt2(borrow)} USDT 存 vault` : ''}`);
  }
  const waiting = renewal.length === 0 ? '' : `；${renewal.join('、')} 等 owner 續期策略加息授權`;
  if (calls.length === 0) return renewal.length === 0 ? null : `[STRATEGY_EARN_OPEN] ${renewal.join('、')} 等 owner 續期策略加息授權（session key 不含這些市場），未送出`;
  if (args.dryRun || !args.send) return `[STRATEGY_EARN_OPEN] 可自動開啟：${opened.join('、')}（${args.dryRun ? 'dry-run' : '沒有策略加息 session 權限，等 owner 續期'}，未送出）`;
  const txs = await sendBatched(args, calls);
  return `[STRATEGY_EARN_OPEN] 已自動開啟：${opened.join('、')} ${txList(txs)}${waiting}`;
}

/**
 * Before a sale (EARN_UX B.5): posted shares are counted as holdings, so the plan may sell more than the account holds
 * free. For each such asset, repay first (strategy vault, then the portfolio's own USDT) and take the shares back; the
 * trade waits for the next round. If vault + cash cannot clear the debt, repay what they can and take back only what
 * keeps the position at its target ratio; the sale of that part pays the rest next round.
 * Returns a block reason, or null when every sell step is covered by free balance.
 */
export async function strategyEarnUnwindForSale(args: StrategyEarnStepArgs & { steps: readonly { tokenIn: string; amountIn: bigint }[] }): Promise<string | null> {
  const { chain, account } = args;
  const head = await chain.head();
  const ids = await chain.accountMarkets(account, head.number);
  const calls: Call[] = [];
  const notes: string[] = [];
  const deadline = BigInt(Math.floor(args.now.getTime() / 1000) + 30 * 60);
  const venusRelease: StrategyMarket[] = [];
  for (const m of strategyMarkets().filter(x => ids.includes(x.marketId))) {
    const need = args.steps.filter(st => st.tokenIn.toLowerCase() === m.collateral).reduce((sum, st) => sum + st.amountIn, 0n);
    if (need === 0n) continue;
    const [posted, free] = await Promise.all([chain.collateral(m.marketId, account, head.number), chain.balance(m.collateral, account, head.number)]);
    if (posted === 0n || need <= free) continue;
    if (!keyCovers(args, m)) { notes.push(`${m.symbol} 需要 owner 續期策略加息授權才能先還款取回`); continue; }
    // Venus: one debt for the whole account; planned together below.
    if (m.protocol === 'venus') { venusRelease.push(m); continue; }
    const st = await chain.status(m.marketId, account, head.number);
    if (st.debt === 0n) {
      calls.push(call(STRATEGY_EARN_97.executor, 'executeWithdrawCollateral', [account, m.marketId, maxUint256, deadline]));
      notes.push(`${m.symbol} 取回`);
      continue;
    }
    const cash = await chain.balance(TESTNET_97.contracts.usdt as Address, account, head.number);
    if (st.vaultAssets + cash >= st.debt + st.debt / 1_000n) {
      calls.push(call(STRATEGY_EARN_97.executor, 'executeRepay', [account, m.marketId, maxUint256, true, deadline]),
        call(STRATEGY_EARN_97.executor, 'executeWithdrawCollateral', [account, m.marketId, maxUint256, deadline]));
      notes.push(`${m.symbol} 先還清再取回`);
      continue;
    }
    // Vault + cash short: pay what they can, keep enough shares posted for the rest at the target ratio (2% margin).
    const pay = st.vaultAssets + cash > 1n ? st.vaultAssets + cash - 1n : 0n;
    const [price, usdtPrice] = await Promise.all([chain.price(m.collateral, head.number), chain.price(TESTNET_97.contracts.usdt as Address, head.number)]);
    const remainingValue = (st.debt - pay) * usdtPrice / 10n ** 8n;
    const keepValue = st.targetLtv === 0n ? st.health.collateralValue : remainingValue * E18 / st.targetLtv * 10_200n / 10_000n;
    const freeValue = st.health.collateralValue > keepValue ? st.health.collateralValue - keepValue : 0n;
    const unit = 10n ** BigInt(m.decimals);
    const perUnit = usdValue(unit, price, m.decimals);
    let take = perUnit === 0n ? 0n : freeValue * unit / perUnit;
    if (take > posted) take = posted;
    if (pay > 0n) calls.push(call(STRATEGY_EARN_97.executor, 'executeRepay', [account, m.marketId, pay, true, deadline]));
    if (take > 0n) calls.push(call(STRATEGY_EARN_97.executor, 'executeWithdrawCollateral', [account, m.marketId, take, deadline]));
    notes.push(`${m.symbol} vault 不足：先還 ${usdt2(pay)} USDT、取回 ${shares(take)}，賣出後再還剩下的`);
  }
  if (venusRelease.length > 0) {
    const [read, cash, usdtPrice] = await Promise.all([readVenusPositions(chain, account, head.number, ids),
      chain.balance(TESTNET_97.contracts.usdt as Address, account, head.number), chain.price(TESTNET_97.contracts.usdt as Address, head.number)]);
    // A market the session key cannot call lends no vault (its call would fail the whole UserOp).
    const positions = read.map(p => keyCovers(args, p.market) ? p : { ...p, st: { ...p.st, vaultAssets: 0n } });
    const plan = venusReleaseCalls({ account, positions, release: venusRelease.map(m => m.marketId), cash, usdtPriceE8: usdtPrice, deadline });
    calls.push(...plan.calls);
    const names = venusRelease.map(m => m.symbol).join('、');
    notes.push(plan.full ? `${names} 先還 ${usdt2(plan.repaidRaw)} USDT 再取回（Venus 共用負債）` : `${names} vault＋現金不足：先還 ${usdt2(plan.repaidRaw)} USDT、取回部分，賣出後再還剩下的`);
  }
  if (notes.length === 0) return null;
  if (calls.length === 0) return `[STRATEGY_EARN_UNWINDING] ${notes.join('；')}`;
  if (args.dryRun || !args.send) return `[STRATEGY_EARN_UNWINDING] 賣出前需先還款取回：${notes.join('；')}（${args.dryRun ? 'dry-run' : '沒有策略加息 session 權限，等 owner 續期'}，未送出）`;
  const txs = await sendBatched(args, calls);
  return `[STRATEGY_EARN_UNWINDING] 賣出前已還款取回：${notes.join('；')} ${txList(txs)}；下一輪再賣`;
}

// ---------------------------------------------------------------------------
// Venus: one shared debt per account
// ---------------------------------------------------------------------------

/** One Venus position as read at one block. `st.debt` / `st.health` are the account's whole Venus position. */
export type VenusPosition = { market: StrategyMarket; st: StatusReading; posted: bigint; price: bigint };
/** Interest accrues between the read and inclusion: plan against 0.1% more debt. */
const VENUS_DEBT_BUFFER_BPS = 10_010n;
/** Stay 2% under the strictest target so the executor's LTV check (each market's own target) always passes. */
const VENUS_SAFE_BPS = 9_800n;

/**
 * Take the shares of `release` (Venus market ids) back out of Venus, never reverting and never leaving the account above
 * its target LTV. Venus has ONE debt for the whole account (every market's `debt`/`health` is the same reading), and
 * `executeRepay(market, maxUint, fromVault)` would try to pay all of it from that one market's vault plus the account's
 * cash — the 2026-11-23 bug: with two Venus positions, closing the first reverted when cash was short.
 *
 * Plan (one UserOp, AtpBorrowExecutor calls only):
 * 1. Released markets: each repays from its own strategy vault (99.99% of what it is worth, so the executor always
 *    takes the vault-only path; once the debt is gone the call releases the rest of that vault into the account).
 * 2. Only as much more as the collateral that stays needs: from the account's cash, then from the other Venus
 *    markets' vaults (they keep their own shares and stay on).
 * 3. Withdraw the released shares — all of them when the rest is covered, otherwise only what keeps the account
 *    under the target (the sale of that part pays the rest next round).
 * `full`: every released share comes back.
 */
export function venusReleaseCalls(input: { account: Address; positions: readonly VenusPosition[]; release: readonly Hex[]; cash: bigint;
  usdtPriceE8: bigint; deadline: bigint }): { calls: Call[]; full: boolean; repaidRaw: bigint } {
  const S = STRATEGY_EARN_97;
  const { account, deadline } = input;
  const rel = input.positions.filter(p => input.release.includes(p.market.marketId));
  const others = input.positions.filter(p => !input.release.includes(p.market.marketId));
  const first = input.positions[0];
  if (rel.length === 0 || first === undefined || input.usdtPriceE8 <= 0n) return { calls: [], full: true, repaidRaw: 0n };
  const debt = first.st.debt, collateralValue = first.st.health.collateralValue;
  const target = input.positions.reduce((min, p) => p.st.targetLtv < min ? p.st.targetLtv : min, first.st.targetLtv) * VENUS_SAFE_BPS / 10_000n;
  const calls: Call[] = [];
  const repay = (m: StrategyMarket, amount: bigint, fromVault: boolean) => calls.push(call(S.executor, 'executeRepay', [account, m.marketId, amount, fromVault, deadline]));
  // What a vault-only repay may ask for: just under its worth (it only grows), at least 1 raw (the executor refuses 0).
  // With debt left the executor then takes exactly that from the vault; with none left it releases the whole vault.
  const ask = (worth: bigint) => { const a = worth * 9_999n / 10_000n; return a > 0n ? a : 1n; };
  const buffered = (raw: bigint) => raw * VENUS_DEBT_BUFFER_BPS / 10_000n;
  const byVault = [...rel].filter(p => p.st.vaultAssets > 0n).sort((a, b) => (a.st.vaultAssets < b.st.vaultAssets ? -1 : a.st.vaultAssets > b.st.vaultAssets ? 1 : 0));
  const releasedValue = rel.reduce((sum, p) => sum + usdValue(p.posted, p.price, p.market.decimals), 0n);
  const kept = collateralValue > releasedValue ? collateralValue - releasedValue : 0n;
  const allowedRaw = kept * target / E18 * 10n ** 8n / input.usdtPriceE8;
  // `owed` is a lower bound of the debt at inclusion (interest only adds), so "the executor takes all of `amount`"
  // predictions below are certain; anything that needs the debt to be at most X uses the buffered figure.
  let owed = debt;
  const dust: StrategyMarket[] = [];
  const vaultRepay = (p: VenusPosition) => { const a = ask(p.st.vaultAssets); repay(p.market, a, true); if (owed >= a) dust.push(p.market); owed -= owed < a ? owed : a; };
  let short = 0n;
  const vaultTotal = byVault.reduce((sum, p) => sum + ask(p.st.vaultAssets), 0n);
  if (kept === 0n && debt > 0n && vaultTotal + input.cash >= buffered(debt)) {
    // Closing every Venus share and the vaults + cash cover the debt: the largest vault goes last with "repay all", so
    // whatever interest added is paid from that vault, then the account's cash; it releases its own rest afterwards.
    const anchor = byVault[byVault.length - 1];
    for (const p of byVault.slice(0, -1)) vaultRepay(p);
    if (anchor) repay(anchor.market, maxUint256, true); else repay(rel[0]!.market, maxUint256, false);
    owed = 0n;
    for (const m of dust) repay(m, 1n, true); // debt is 0 now: releases each vault's sliver (it has one)
  } else {
    for (const p of byVault) vaultRepay(p);
    // What the shares that stay posted still need repaid (all of it when nothing stays posted).
    // Interest grows with the whole debt, not with what is left of it: carry the whole debt's buffer.
    const interest = buffered(debt) - debt;
    const left = owed + interest;
    short = kept === 0n ? left : left > allowedRaw ? left - allowedRaw : 0n;
    const fromCash = [input.cash, short, owed].reduce((a, b) => (a < b ? a : b));
    if (fromCash > 0n) { repay(rel[0]!.market, fromCash, false); owed -= fromCash; short -= fromCash; }
    for (const p of [...others].sort((a, b) => (a.st.vaultAssets > b.st.vaultAssets ? -1 : a.st.vaultAssets < b.st.vaultAssets ? 1 : 0))) {
      if (short === 0n || owed === 0n || p.st.vaultAssets === 0n) continue;
      const room = ask(p.st.vaultAssets) - 1n; // strictly below its worth: the vault-only path, its strategy stays on
      const take = [short, room, owed].reduce((a, b) => (a < b ? a : b));
      if (take <= 0n) continue;
      repay(p.market, take, true); owed -= take; short -= take;
    }
    if (owed === 0n) for (const m of dust) repay(m, 1n, true);
  }
  // Withdraw. Short -> only the part the remaining (buffered) debt allows at the target.
  const full = short === 0n;
  let budget = full ? releasedValue : (() => {
    const keep = target === 0n ? collateralValue : (owed + buffered(debt) - debt) * input.usdtPriceE8 / 10n ** 8n * E18 / target + 1n;
    return collateralValue > keep ? collateralValue - keep : 0n;
  })();
  for (const p of rel) {
    if (p.posted === 0n) continue;
    if (full) { calls.push(call(S.executor, 'executeWithdrawCollateral', [account, p.market.marketId, maxUint256, deadline])); continue; }
    const unit = 10n ** BigInt(p.market.decimals), perUnit = usdValue(unit, p.price, p.market.decimals);
    let take = perUnit === 0n ? 0n : budget * unit / perUnit;
    if (take > p.posted) take = p.posted;
    if (take === 0n) continue;
    budget -= usdValue(take, p.price, p.market.decimals);
    calls.push(call(S.executor, 'executeWithdrawCollateral', [account, p.market.marketId, take === p.posted ? maxUint256 : take, deadline]));
  }
  return { calls, full, repaidRaw: debt - owed };
}

/** Reads every Venus position of the account at one block (the planner needs the whole account, not one market). */
async function readVenusPositions(chain: StrategyEarnChain, account: Address, block: bigint, ids: readonly Hex[]): Promise<VenusPosition[]> {
  return Promise.all(strategyMarkets().filter(m => m.protocol === 'venus' && ids.includes(m.marketId)).map(async market => {
    const [st, posted, price] = await Promise.all([chain.status(market.marketId, account, block), chain.collateral(market.marketId, account, block), chain.price(market.collateral, block)]);
    return { market, st, posted, price };
  }));
}

async function recordOrLog(args: Pick<StrategyEarnStepArgs, 'ledger' | 'portfolioId' | 'account' | 'log'>, tx: StrategyEarnTx) {
  try { await args.ledger.record(97, strategyEarnEvents(tx, args.portfolioId, args.account)); }
  catch { args.log(`[strategy-earn] portfolio ${args.portfolioId} 帳本寫入失敗（鏈上已完成）tx=${tx.hash}`); }
}
