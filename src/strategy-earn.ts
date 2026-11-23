import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, http, maxUint256, parseAbi } from 'viem';
import type { Address, Hex, Log, PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';
import { getConfig } from './config.js';
import { query as dbQuery } from './db.js';
import { AppError, ValidationError } from './errors.js';
import { requireOwnedPortfolio } from './portfolios.js';
import { TESTNET_97 } from './testnet-profile.js';
import { STRATEGY_EARN_97 } from './strategy-earn-guard.js';
import { borrowAuthorized } from './permissions.js';
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
  /** Owner consent for this market (AtpBorrowRegistry.policies): enabled with a debt ceiling. */
  policy(account: Address, marketId: Hex, block: bigint): Promise<{ maxDebt: bigint; enabled: boolean }>;
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
      const [maxDebt, , , enabled] = await read(S.registry, 'policies', [account, marketId], block) as readonly [bigint, bigint, number, boolean];
      return { maxDebt, enabled };
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
/** Close = repay everything (vault first, then the account's own USDT), then take all collateral back. Order matters. */
export function closeCalls(market: StrategyMarket, account: Address, deadline: bigint): Call[] {
  const S = STRATEGY_EARN_97;
  return [
    call(S.executor, 'executeRepay', [account, market.marketId, maxUint256, true, deadline]),
    call(S.executor, 'executeWithdrawCollateral', [account, market.marketId, maxUint256, deadline]),
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

const TEMPORARILY = 'Temporarily unavailable.';
export type StrategyEarnDeps = { chainId: number; chain: () => StrategyEarnChain; owned: typeof requireOwnedPortfolio; now: () => Date;
  query: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };

let cachedChain: StrategyEarnChain | undefined;
export function defaultStrategyEarnChain(): StrategyEarnChain {
  if (cachedChain) return cachedChain;
  const rpc = getConfig().rpcUrl;
  if (!rpc) throw new Error('rpc unavailable');
  cachedChain = createStrategyEarnChain(createPublicClient({ chain: bscTestnet, transport: http(rpc, { retryCount: 1, timeout: 8_000 }) }) as PublicClient);
  return cachedChain;
}

export function createStrategyEarn(overrides: Partial<StrategyEarnDeps> = {}) {
  const deps: StrategyEarnDeps = {
    chainId: Number(process.env.CHAIN_ID?.trim() || '56'), owned: requireOwnedPortfolio, now: () => new Date(), chain: defaultStrategyEarnChain,
    query: (sql, params) => dbQuery(sql, params) as never,
    ...overrides,
  };
  const markets = strategyMarkets();
  const ready = () => { if (deps.chainId !== 97) throw new AppError(404, 'STRATEGY_EARN_NOT_CONFIGURED', '策略加息目前僅開放測試網。'); };
  const live = async () => { try { const chain = deps.chain(); return { chain, head: await chain.head() }; } catch { return null; } };
  const quote = (m: StrategyMarket, s: StatusReading | null, at: string | null) => {
    if (!s) return { asset: m.symbol, marketId: m.marketId, protocol: m.protocol, status: 'unavailable' as const, reason: 'data_unavailable', message: TEMPORARILY,
      extraApyBps: null, breakdown: null, targetLtvBps: null, deleverageLtvBps: null, updatedAt: at };
    const apy = extraApy(s, s.targetLtv);
    const open = s.gate === 0;
    return { asset: m.symbol, marketId: m.marketId, protocol: m.protocol, status: open ? 'open' as const : 'unavailable' as const,
      reason: open ? null : GATE_REASONS[s.gate] ?? 'closed', message: open ? null : TEMPORARILY,
      extraApyBps: apy.totalBps, breakdown: apy.breakdown, targetLtvBps: toBps(s.targetLtv), deleverageLtvBps: toBps(s.deleverageLtv), updatedAt: at };
  };
  async function owned(id: number, wallet: string) {
    ready();
    const p = await deps.owned(id, wallet);
    if (p.personalMix) throw new AppError(409, 'MIX_NO_STRATEGY_EARN', '私人組合目前不提供策略加息。');
    if (p.chainId !== 97 || p.ownerAddress.toLowerCase() !== wallet.toLowerCase()) throw new AppError(403, 'FORBIDDEN', '只能操作本人於這條鏈的帳戶');
    return p.accountAddress.toLowerCase() as Address;
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
    return rows[0] !== undefined && borrowAuthorized(rows[0].permissions, account);
  }
  function body(input: unknown, keys: readonly string[]) {
    if (typeof input !== 'object' || input === null || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k)) || keys.some(k => !(k in input))) {
      throw new ValidationError('INVALID_STRATEGY_EARN_REQUEST', `請送出 ${keys.join('、')}。`);
    }
    return input as Record<string, unknown>;
  }
  return {
    /** Pre-buy quote per eligible asset (ratio = target LTV). Leveraged products are never listed. */
    async markets() {
      ready();
      const l = await live();
      const at = l ? new Date(Number(l.head.timestamp) * 1000).toISOString() : null;
      const items = await Promise.all(markets.map(async m => {
        if (!l) return quote(m, null, at);
        try { return quote(m, await l.chain.status(m.marketId, '0x0000000000000000000000000000000000000000', l.head.number), at); } catch { return quote(m, null, at); }
      }));
      return { chainId: 97, updatedAt: at, markets: items };
    },
    /** This portfolio's positions; net value = collateral + vault - debt, kept apart from cash and Cash Earn. */
    async portfolio(id: number, wallet: string) {
      const account = await owned(id, wallet);
      const l = await live();
      if (!l) return { portfolioId: id, account, status: 'unavailable' as const, reason: 'data_unavailable', message: TEMPORARILY, updatedAt: null, positions: [] };
      const { chain, head } = l;
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
            newBorrowing: s.gate === 0 ? 'open' as const : 'unavailable' as const, reason: s.gate === 0 ? null : GATE_REASONS[s.gate] ?? 'closed' };
        } catch {
          return { asset: m.symbol, marketId: m.marketId, status: 'unavailable' as const, message: TEMPORARILY };
        }
      }));
      const earnNetUsd = positions.reduce((sum, p) => sum + ('earnNetUsd' in p && p.earnNetUsd !== undefined ? BigInt(p.earnNetUsd) : 0n), 0n);
      return { portfolioId: id, account, status: 'ok' as const, reason: null, message: null, updatedAt: new Date(Number(head.timestamp) * 1000).toISOString(),
        earnNetUsd: earnNetUsd.toString(), positions };
    },
    /** One owner UserOp: consent + approvals (to AtpBorrowExecutor only) + post collateral + borrow into the vault. */
    async open(id: number, wallet: string, input: unknown) {
      const account = await owned(id, wallet);
      const b = body(input, ['asset', 'collateralRaw']);
      const market = findMarket(b.asset);
      if (typeof b.collateralRaw !== 'string' || !/^[1-9][0-9]{0,77}$/.test(b.collateralRaw)) throw new ValidationError('INVALID_AMOUNT', 'collateralRaw 須為正整數字串。');
      const collateralRaw = BigInt(b.collateralRaw);
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
        maxDebtRaw: plan.maxDebtRaw.toString(), extraApyBps: extraApy(s, s.targetLtv).totalBps, calls: openCalls(market, account, collateralRaw, plan.borrowRaw, plan.maxDebtRaw, deadline) };
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
      const b = body(input, ['budgetRaw']);
      if (typeof b.budgetRaw !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(b.budgetRaw)) throw new ValidationError('INVALID_AMOUNT', 'budgetRaw 須為非負整數字串。');
      const budget = BigInt(b.budgetRaw);
      const l = await live();
      if (!l) return { status: 'unavailable' as const, reason: 'data_unavailable', message: TEMPORARILY };
      const { chain, head } = l;
      let weights: { asset: Address; weightBps: number }[];
      let usdtPrice: bigint;
      try { [weights, usdtPrice] = await Promise.all([chain.weights(account, head.number), chain.price(TESTNET_97.contracts.usdt as Address, head.number)]); }
      catch { return { status: 'unavailable' as const, reason: 'data_unavailable', message: TEMPORARILY }; }
      const eligible = markets.filter(m => weights.some(w => w.asset === m.collateral && w.weightBps > 0));
      const quoted = await Promise.all(eligible.map(async m => {
        try {
          const w = weights.find(x => x.asset === m.collateral)?.weightBps ?? 0;
          const [st, held, price] = await Promise.all([chain.status(m.marketId, account, head.number), chain.balance(m.collateral, account, head.number), chain.price(m.collateral, head.number)]);
          if (st.gate !== 0) return { market: m, status: 'unavailable' as const, reason: GATE_REASONS[st.gate] ?? 'closed' };
          // USD (1e18): new money's share of this asset + what the portfolio already holds of it.
          const value = budget * BigInt(w) / 10_000n * usdtPrice / 10n ** 8n + usdValue(held, price, m.decimals);
          const plan = borrowPlan({ existingCollateralValue: st.health.collateralValue, addedCollateralValue: value, existingDebtValue: st.health.debtValue,
            targetLtv: st.targetLtv, usdtPriceE8: usdtPrice, currentDebtRaw: st.debt });
          if (plan.maxDebtRaw === 0n) return { market: m, status: 'unavailable' as const, reason: 'nothing_to_borrow' };
          return { market: m, status: 'ready' as const, maxDebtRaw: plan.maxDebtRaw, extraApyBps: extraApy(st, st.targetLtv).totalBps };
        } catch { return { market: m, status: 'unavailable' as const, reason: 'data_unavailable' }; }
      }));
      const ready = quoted.filter((q): q is Extract<typeof q, { status: 'ready' }> => q.status === 'ready');
      const assets = quoted.map(q => q.status === 'ready' ? { asset: q.market.symbol, status: q.status, maxDebtRaw: q.maxDebtRaw.toString(), extraApyBps: q.extraApyBps }
        : { asset: q.market.symbol, status: q.status, reason: q.reason, message: TEMPORARILY });
      if (ready.length === 0) return { status: 'unavailable' as const, reason: eligible.length === 0 ? 'no_eligible_asset' : 'data_unavailable', message: TEMPORARILY, assets };
      return { status: 'ready' as const, authorization: await borrowKeyReady(id, account) ? 'ready' as const : 'renewal_required' as const,
        assets, calls: consentCalls(ready.map(q => ({ market: q.market, maxDebtRaw: q.maxDebtRaw }))) };
    },
    /** Activity (EARN_UX B.6): newest first, one plain sentence each, from the verified ledger (db 0063). */
    async activity(id: number, wallet: string) {
      await owned(id, wallet);
      const rows = (await deps.query<{ kind: StrategyEarnKind; asset: string | null; amount_raw: string; collateral_raw: string; ltv_before_bps: number | null;
        ltv_after_bps: number | null; tx_hash: string; block_number: string; created_at: Date | string }>(
        `select kind, asset, amount_raw::text, collateral_raw::text, ltv_before_bps, ltv_after_bps, tx_hash, block_number::text, created_at
           from strategy_earn_events where chain_id = 97 and portfolio_id = $1 order by block_number desc, log_index desc limit 50`, [id])).rows;
      return { portfolioId: id, activity: rows.map(r => {
        const e = { kind: r.kind, asset: r.asset, amountRaw: BigInt(r.amount_raw), collateralRaw: BigInt(r.collateral_raw), ltvBeforeBps: r.ltv_before_bps, ltvAfterBps: r.ltv_after_bps };
        return { kind: r.kind, asset: r.asset, amountRaw: r.amount_raw, collateralRaw: r.collateral_raw, ltvBeforeBps: r.ltv_before_bps, ltvAfterBps: r.ltv_after_bps,
          txHash: r.tx_hash, blockNumber: r.block_number, createdAt: new Date(r.created_at).toISOString(), message: strategyEarnMessage(e) };
      }) };
    },
    /** Turn off / before selling: repay first (vault, then the account's own USDT), then withdraw all collateral. */
    async close(id: number, wallet: string, input: unknown) {
      const account = await owned(id, wallet);
      const market = findMarket(body(input, ['asset']).asset);
      const deadline = BigInt(Math.floor(deps.now().getTime() / 1000) + 30 * 60);
      return { status: 'ready' as const, asset: market.symbol, calls: closeCalls(market, account, deadline) };
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
};
export function strategyKeeperWriter(env: NodeJS.ProcessEnv = process.env): StrategyKeeperWriter | null {
  const raw = env.STRATEGY_EARN_KEEPER_PRIVATE_KEY?.trim();
  if (!raw) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error('STRATEGY_EARN_KEEPER_PRIVATE_KEY must be a 32-byte hex key');
  const rpc = env.RPC_URL?.trim();
  if (!rpc) throw new Error('RPC_URL is required for the strategy earn keeper');
  const account = privateKeyToAccount(raw as Hex);
  const wallet = createWalletClient({ account, chain: bscTestnet, transport: http(rpc, { retryCount: 1, timeout: 15_000 }) });
  const pub = createPublicClient({ chain: bscTestnet, transport: http(rpc, { retryCount: 1, timeout: 15_000 }) });
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
        [chainId, e.portfolioId, e.account, e.marketId, e.asset, e.kind, e.amountRaw.toString(), e.collateralRaw.toString(),
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
  /** null: no session key with the #204 permissions (owner has not renewed) — the step only reports. */
  send: StrategyEarnSend | null;
  /** Markets the session key may call (its installed ONE_OF list); absent = every market. A key renewed before
   * cre8-contracts#67 holds only the five #65 markets: calls for the others would fail the whole UserOp. */
  sendable?: readonly Hex[];
  ledger: StrategyEarnLedger; log: (line: string) => void };
const keyCovers = (args: Pick<StrategyEarnStepArgs, 'sendable'>, m: StrategyMarket) => args.sendable === undefined || args.sendable.includes(m.marketId);

/**
 * After a buy has filled (the portfolio is otherwise idle): for every market the owner consented to at buy time
 * (policy enabled), post the shares the portfolio holds and borrow straight into the strategy vault, capped by the
 * target ratio and the owner's debt ceiling. Returns a one-line note, or null when there is nothing to do.
 * Never runs for a gate that is not open (EARN_UX D: utilization / negative carry -> no new borrowing).
 */
export async function strategyEarnAutoOpen(args: StrategyEarnStepArgs): Promise<string | null> {
  const { chain, account } = args;
  const head = await chain.head();
  const usdtPrice = await chain.price(TESTNET_97.contracts.usdt as Address, head.number);
  const calls: Call[] = [];
  const opened: string[] = [];
  const renewal: string[] = [];
  const deadline = BigInt(Math.floor(args.now.getTime() / 1000) + 30 * 60);
  for (const m of strategyMarkets()) {
    const policy = await chain.policy(account, m.marketId, head.number);
    if (!policy.enabled || policy.maxDebt === 0n) continue;
    const held = await chain.balance(m.collateral, account, head.number);
    if (held === 0n) continue;
    if (!keyCovers(args, m)) { renewal.push(m.symbol); continue; }
    const [st, price] = await Promise.all([chain.status(m.marketId, account, head.number), chain.price(m.collateral, head.number)]);
    if (st.gate !== 0) continue;
    const added = usdValue(held, price, m.decimals);
    if (added < MIN_AUTO_OPEN_USD) continue;
    const plan = borrowPlan({ existingCollateralValue: st.health.collateralValue, addedCollateralValue: added, existingDebtValue: st.health.debtValue,
      targetLtv: st.targetLtv, usdtPriceE8: usdtPrice, currentDebtRaw: st.debt });
    // Keep 1% under the owner's ceiling: interest accrues between this read and inclusion.
    const headroom = policy.maxDebt > st.debt ? (policy.maxDebt - st.debt) * 9_900n / 10_000n : 0n;
    const borrow = plan.borrowRaw < headroom ? plan.borrowRaw : headroom;
    calls.push(call(STRATEGY_EARN_97.executor, 'executeSupplyCollateral', [account, m.marketId, held, deadline]));
    if (borrow > 0n) calls.push(call(STRATEGY_EARN_97.executor, 'executeBorrow', [account, m.marketId, borrow, deadline]));
    opened.push(`${m.symbol} ${shares(held)}${borrow > 0n ? `／借 ${usdt2(borrow)} USDT 存 vault` : ''}`);
  }
  const waiting = renewal.length === 0 ? '' : `；${renewal.join('、')} 等 owner 續期策略加息授權`;
  if (calls.length === 0) return renewal.length === 0 ? null : `[STRATEGY_EARN_OPEN] ${renewal.join('、')} 等 owner 續期策略加息授權（session key 不含這些市場），未送出`;
  if (args.dryRun || !args.send) return `[STRATEGY_EARN_OPEN] 可自動開啟：${opened.join('、')}（${args.dryRun ? 'dry-run' : '沒有策略加息 session 權限，等 owner 續期'}，未送出）`;
  const tx = await args.send(calls);
  await recordOrLog(args, tx);
  return `[STRATEGY_EARN_OPEN] 已自動開啟：${opened.join('、')} tx=${tx.hash}${waiting}`;
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
  for (const m of strategyMarkets().filter(x => ids.includes(x.marketId))) {
    const need = args.steps.filter(st => st.tokenIn.toLowerCase() === m.collateral).reduce((sum, st) => sum + st.amountIn, 0n);
    if (need === 0n) continue;
    const [posted, free] = await Promise.all([chain.collateral(m.marketId, account, head.number), chain.balance(m.collateral, account, head.number)]);
    if (posted === 0n || need <= free) continue;
    if (!keyCovers(args, m)) { notes.push(`${m.symbol} 需要 owner 續期策略加息授權才能先還款取回`); continue; }
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
  if (notes.length === 0) return null;
  if (calls.length === 0) return `[STRATEGY_EARN_UNWINDING] ${notes.join('；')}`;
  if (args.dryRun || !args.send) return `[STRATEGY_EARN_UNWINDING] 賣出前需先還款取回：${notes.join('；')}（${args.dryRun ? 'dry-run' : '沒有策略加息 session 權限，等 owner 續期'}，未送出）`;
  const tx = await args.send(calls);
  await recordOrLog(args, tx);
  return `[STRATEGY_EARN_UNWINDING] 賣出前已還款取回：${notes.join('；')} tx=${tx.hash}；下一輪再賣`;
}

async function recordOrLog(args: Pick<StrategyEarnStepArgs, 'ledger' | 'portfolioId' | 'account' | 'log'>, tx: StrategyEarnTx) {
  try { await args.ledger.record(97, strategyEarnEvents(tx, args.portfolioId, args.account)); }
  catch { args.log(`[strategy-earn] portfolio ${args.portfolioId} 帳本寫入失敗（鏈上已完成）tx=${tx.hash}`); }
}
