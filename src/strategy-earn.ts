import { createPublicClient, createWalletClient, encodeFunctionData, http, maxUint256, parseAbi } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';
import { getConfig } from './config.js';
import { query as dbQuery } from './db.js';
import { AppError, ValidationError } from './errors.js';
import { requireOwnedPortfolio } from './portfolios.js';
import { TESTNET_97 } from './testnet-profile.js';
import { STRATEGY_EARN_97 } from './strategy-earn-guard.js';
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
export type StrategyMarket = { symbol: string; marketId: Hex; protocol: 'venus' | 'lista'; collateral: Address; collateralVToken: Address | null };
export function strategyMarkets(): StrategyMarket[] {
  return STRATEGY_EARN_97.markets.map(m => {
    const asset = (TESTNET_97.assets as Record<string, { token: string } | undefined>)[m.symbol];
    if (!asset) throw new Error('strategy earn asset missing from profile: ' + m.symbol);
    return { symbol: m.symbol, marketId: m.marketId, protocol: m.protocol, collateral: asset.token.toLowerCase() as Address, collateralVToken: m.collateralVToken };
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
  /** Pending incentives owed to this account (claim pays only to it), USDT raw: strategy vault and Venus collateral vToken. */
  rewards(market: StrategyMarket, account: Address, block: bigint): Promise<{ vault: bigint; collateral: bigint }>;
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
      // Venus collateral incentives accrue on the collateral vToken. Lista (Moolah) incentives are not claimed by this
      // version; their rate is still in the registry status and the APY.
      const collateral = market.collateralVToken ? await read(market.collateralVToken, 'rewardOf', [account], block) as bigint : 0n;
      return { vault, collateral };
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

/** USD value (1e18) of `amount` raw collateral (18 decimals) at an 8-decimal oracle price. */
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
export type StrategyEarnDeps = { chainId: number; chain: () => StrategyEarnChain; owned: typeof requireOwnedPortfolio; now: () => Date };

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
          const collateralValue = usdValue(posted, price);
          const ratio = s.ltv;
          return { asset: m.symbol, marketId: m.marketId, status: s.debt > 0n || posted > 0n ? 'on' as const : 'off' as const,
            collateralRaw: posted.toString(), collateralValueUsd: collateralValue.toString(), debtRaw: s.debt.toString(), vaultAssetsRaw: s.vaultAssets.toString(),
            netValueUsd: (collateralValue + s.vaultAssets - s.debt).toString(), pendingRewardsRaw: (pending.vault + pending.collateral).toString(),
            ltvBps: toBps(s.ltv), targetLtvBps: toBps(s.targetLtv), deleverageLtvBps: toBps(s.deleverageLtv), liquidationLtvBps: toBps(s.liquidationLtv),
            extraApyBps: extraApy(s, ratio).totalBps, shouldDeleverage: s.shouldDeleverage, shouldUnwind: s.shouldUnwind,
            newBorrowing: s.gate === 0 ? 'open' as const : 'unavailable' as const, reason: s.gate === 0 ? null : GATE_REASONS[s.gate] ?? 'closed' };
        } catch {
          return { asset: m.symbol, marketId: m.marketId, status: 'unavailable' as const, message: TEMPORARILY };
        }
      }));
      return { portfolioId: id, account, status: 'ok' as const, reason: null, message: null, updatedAt: new Date(Number(head.timestamp) * 1000).toISOString(), positions };
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
      const plan = borrowPlan({ existingCollateralValue: s.health.collateralValue, addedCollateralValue: usdValue(collateralRaw, price),
        existingDebtValue: s.health.debtValue, targetLtv: s.targetLtv, usdtPriceE8: usdtPrice, currentDebtRaw: s.debt });
      const deadline = BigInt(Math.floor(deps.now().getTime() / 1000) + 30 * 60);
      return { status: 'ready' as const, asset: market.symbol, collateralRaw: collateralRaw.toString(), borrowRaw: plan.borrowRaw.toString(),
        maxDebtRaw: plan.maxDebtRaw.toString(), extraApyBps: extraApy(s, s.targetLtv).totalBps, calls: openCalls(market, account, collateralRaw, plan.borrowRaw, plan.maxDebtRaw, deadline) };
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

/** Keeper writer: AtpBorrowExecutor.executeDeleverage is anyone-callable and only uses that account's own vault shares. */
export type StrategyKeeperWriter = { deleverage(account: Address, marketId: Hex): Promise<Hex>; claim(target: Address, account: Address): Promise<Hex> };
export function strategyKeeperWriter(env: NodeJS.ProcessEnv = process.env): StrategyKeeperWriter | null {
  const raw = env.STRATEGY_EARN_KEEPER_PRIVATE_KEY?.trim();
  if (!raw) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error('STRATEGY_EARN_KEEPER_PRIVATE_KEY must be a 32-byte hex key');
  const rpc = env.RPC_URL?.trim();
  if (!rpc) throw new Error('RPC_URL is required for the strategy earn keeper');
  const account = privateKeyToAccount(raw as Hex);
  const wallet = createWalletClient({ account, chain: bscTestnet, transport: http(rpc, { retryCount: 1, timeout: 15_000 }) });
  const pub = createPublicClient({ chain: bscTestnet, transport: http(rpc, { retryCount: 1, timeout: 15_000 }) });
  const send = async (to: Address, data: Hex) => {
    const hash = await wallet.sendTransaction({ to, data, gas: 1_500_000n, gasPrice: await pub.getGasPrice() });
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== 'success') throw new Error('reverted ' + hash);
    return hash;
  };
  return {
    deleverage: (account, marketId) => send(STRATEGY_EARN_97.executor, call(STRATEGY_EARN_97.executor, 'executeDeleverage', [account, marketId]).data),
    claim: (target, account) => send(target, call(target, 'claimReward', [account]).data),
  };
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
  chainId?: number; chain?: StrategyEarnChain; writer?: StrategyKeeperWriter | null; accounts?: () => Promise<Address[]>;
} = {}): Promise<StrategyKeeperResult | null> {
  const chainId = overrides.chainId ?? Number(process.env.CHAIN_ID?.trim() || '56');
  if (chainId !== 97) return null;
  const chain = overrides.chain ?? defaultStrategyEarnChain();
  const writer = overrides.writer === undefined ? strategyKeeperWriter() : overrides.writer;
  const accounts = await (overrides.accounts ?? (async () => (await dbQuery<{ address: string }>(
    `select distinct sa.address from smart_accounts sa join portfolios p on p.id=sa.portfolio_id
      where sa.chain_id=97 and sa.retired_at is null order by sa.address`)).rows.map(r => r.address.toLowerCase() as Address)))();
  const result: StrategyKeeperResult = { checked: 0, flagged: 0, deleveraged: 0, claimed: 0, failed: 0, writer: writer !== null };
  const head = await chain.head();
  const markets = strategyMarkets();
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
          else { const hash = await writer.deleverage(account, market.marketId); result.deleveraged++; args.log(`[strategy-earn] ${account} ${market.symbol} 已自動${s.shouldDeleverage ? '減倉' : '收掉'}（${why}）tx=${hash}`); }
        }
        if (!args.dryRun && writer) {
          // Incentives are paid by the market to this same account (no receiver argument): they stay in this portfolio.
          const pending = await chain.rewards(market, account, head.number);
          // The strategy vault reward is per account, not per market: claim it once per account.
          if (!vaultClaimed && pending.vault >= MIN_CLAIM_RAW) { await writer.claim(STRATEGY_EARN_97.earnVault, account); result.claimed++; }
          vaultClaimed = true;
          if (market.collateralVToken && pending.collateral >= MIN_CLAIM_RAW) { await writer.claim(market.collateralVToken, account); result.claimed++; }
        }
      } catch { result.failed++; args.log(`[strategy-earn] ${account} ${market.symbol} 讀值或送出失敗，下輪再試`); }
    }
  }
  return result;
}
