import { decodeFunctionData, maxUint256 } from 'viem';
import type { Address, Hex, Log } from 'viem';
import { planAccount } from './strategy-earn-routing.js';
import type { Costs, Decision, Holding } from './strategy-earn-routing.js';
import { marketIdOf } from './strategy-earn-v2-chain.js';
import type { V2AccountRead, V2Market, V2Reader } from './strategy-earn-v2-chain.js';
import { BORROW_BUFFER_BPS, V2_CASH_OUT_ALONE_MIN_RAW, V2_CASH_OUT_MIN_RAW, V2_SWAPPER_ABI, V2_SWAPPER_SELECTORS, maxDebtFor, planExecution, strategyV2Addresses, swapEventLine, v2ConsentCalls, v2ExitBatches, v2ExitPlan, v2MissingSwapperApprovals, v2ReconsentCalls, v2RescueCall, v2CashEvents, v2RouteEvents } from './strategy-earn-v2.js';
import type { Call, ExitInput, ExitRoute, RouteEvent, StrategyEarnV2, SwapEvent, SwapQuote } from './strategy-earn-v2.js';
import { rewardEvents } from './strategy-rewards.js';
import type { RewardEvent } from './strategy-rewards.js';

/**
 * Routing v2 behind the same strategy-earn endpoints the app already calls (src/strategy-earn.ts decides per account
 * whether v1 or v2 answers). Same response shapes as v1 — `{ status, calls, batches, authorization }` — so the app sends
 * whatever calls it is given, plus the fields v2 adds (`route` per position with `source: 'onchain'`, `version: 2`).
 * Owner-signed flows only; the scheduler's session-key steps are in src/strategy-earn-v2-scheduler.ts.
 */
const TEMPORARILY = 'Temporarily unavailable.';
const E18 = 10n ** 18n;
/** Raw token units as a number of whole tokens (USD for a loan token), exact to 6 decimals. */
const usd = (raw: bigint, decimals = 18) => Number(raw / 10n ** BigInt(Math.max(0, decimals - 6))) / 10 ** Math.min(6, decimals);
/** Stand-in gas for a repayment whose own estimate fails because it needs the top-up placed right before it (see `gasOf`):
 * half of what one UserOp may add up to (V2_USER_OP_ESTIMATE_GAS), above every close measured on chain 97 (0.7–1.3M). */
export const AFTER_TOP_UP_GAS = 3_000_000n;
/** Testnet gas is ~0.1 gwei; the engine only needs the order of magnitude for its "30 days ≥ 3× cost" rule. */
export const V2_DEFAULT_COSTS: Costs = { gasUsdPerTx: 0.05 };

export type V2ApiDeps = { v2: StrategyEarnV2; reader: V2Reader; now: () => Date;
  /** Estimated gas of one executor call from the account (public node); null = unknown (the call then gets its own UserOp). */
  estimateGas?: (account: Address, call: Call) => Promise<bigint | null>;
  costs?: Costs;
  recordRoutes?: (chainId: number, events: readonly RouteEvent[]) => Promise<void>;
  recordRewards?: (chainId: number, events: readonly RewardEvent[]) => Promise<void>;
  rewardSymbol?: (token: Address) => string | undefined;
  /** What the cash ledger says about the account's USDT (src/withdrawable-cash.ts): every bucket's claim, and the portfolio's
   * own cash among them. An owner-signed top-up may spend the own cash and unclaimed USDT (it is booked by `bookSwaps` at
   * `confirm`, and by the scheduler's recovery scan if that call never comes); nothing else. Absent: nothing is claimed. */
  cashClaims?: (account: Address) => Promise<{ claimedRaw: bigint; ownRaw: bigint }>;
  /** Cash ledger booking of a receipt's `ToppedUp` / `CashedOut` (src/strategy-cash-swaps.ts). Absent: only unclaimed USDT is offered to a top-up. */
  bookSwaps?: (portfolioId: number, account: Address, events: readonly SwapEvent[]) => Promise<unknown>;
  /** One structured line per cash swapper event; default: stdout. */
  log?: (line: string) => void };

/** What each eligible asset would be worth (USD) for the plan: what the account holds plus `extraUsd` (new money by weight). */
function holdingsFor(read: V2AccountRead, extraUsd: (token: Address) => number, enabled: boolean): Holding[] {
  return read.state.holdings.map(h => ({ symbol: h.symbol, collateralUsd: h.collateralUsd + extraUsd(h.collateral), enabled, position: h.position }));
}
const targetOf = (decisions: readonly Decision[]) => decisions.filter(d => d.action !== 'close').reduce((s, d) => s + d.targetDebtUsd, 0);

export function createStrategyEarnV2Api(deps: V2ApiDeps) {
  const { v2, reader } = deps;
  const costs = deps.costs ?? V2_DEFAULT_COSTS;
  const deadline = () => BigInt(Math.floor(deps.now().getTime() / 1000) + 30 * 60);
  const tokenOf = (m: V2Market, symbol: string) => m.routes.find(r => r.symbol === symbol)?.collateral;
  /** Collateral tokens of these symbols that have a route. */
  const eligibleTokens = (m: V2Market, tokens: readonly string[]) => [...new Set(m.routes.filter(r => tokens.some(t => t.toLowerCase() === r.collateral)).map(r => r.collateral))];
  /**
   * The consent an owner signs: one ceiling for everything planned (+10%), the lending venues the routes may use that the
   * account has not delegated to the executor yet (`granted`: reader.delegations), approvals. A venue already delegated
   * is never sent again: Venus (`Delegation status unchanged`) and Moolah (`already set`) revert on a delegation that
   * changes nothing, which would take the whole UserOp with it — a second consent, or any `open` after the first one.
   */
  const consent = (m: V2Market, owner: Address, collaterals: readonly Address[], plannedDebtUsd: number, read: V2AccountRead, granted: { venus: boolean; lista: boolean }) => {
    const planned = maxDebtFor(plannedDebtUsd), current = read.consent ? read.policy.maxDebt : 0n;
    // Never lower a ceiling that still covers open principal.
    const floor = read.state.principalUsdRaw * 11_000n / 10_000n;
    const maxDebtUsdRaw = [planned, current, floor].reduce((a, b) => (a > b ? a : b));
    const venues = [...new Set(m.routes.filter(r => collaterals.includes(r.collateral)).map(r => r.venue))].filter(venue => !granted[venue]);
    // Cash swapper (spec §17): USDT (top-up) and the other loan tokens (cash-out) are approved to it once, with the consent.
    // Only what is missing, so an account that consented before the swapper existed signs them the next time it consents.
    const swapperApprovals = v2MissingSwapperApprovals(v2, token => read.swapperAllowances[token] ?? 0n);
    return { maxDebtUsdRaw, calls: v2ConsentCalls(v2, { maxDebtUsdRaw, rewardRecipient: owner, venues, collaterals, loanTokens: Object.values(v2.loanTokens) as Address[], rewardTokens: v2.rewardTokens, swapperApprovals }) };
  };
  const gasOf = async (account: Address, calls: readonly Call[]) => {
    const gas = new Map<string, bigint | null>();
    await Promise.all(calls.map(async c => { gas.set(c.to + c.data, c.to === v2.executor && deps.estimateGas ? await deps.estimateGas(account, c) : c.to === v2.executor ? null : 0n); }));
    // A repayment that only works after its top-up cannot be estimated on its own (it reverts with VaultShortfall), and a
    // call of unknown gas gets a UserOp to itself: the owner's turn-off then went out as three UserOps — top-up, close,
    // cash-out (testnet 2026-11-25, portfolio 32). Such a call gets a stand-in figure instead, so it shares the UserOp with
    // the top-up in front of it and the cash-out behind it; the bundler still estimates the real gas of that UserOp.
    calls.forEach((c, i) => {
      const before = calls[i - 1];
      if (i > 0 && c.to === v2.executor && gas.get(c.to + c.data) === null && v2.swapper && before!.to === v2.swapper && before!.data.startsWith(V2_SWAPPER_SELECTORS[0]!)) gas.set(c.to + c.data, AFTER_TOP_UP_GAS);
    });
    return (c: Call) => gas.get(c.to + c.data) ?? null;
  };

  return {
    /** Has this account anything on v2 (consent, a position, money in the box)? */
    async active(account: Address): Promise<boolean> { const t = await reader.touched(account); return t.enabled || t.routes.length > 0 || t.vaults.length > 0; },

    /** Positions of this portfolio account. Net value of the strategy money = vault holdings + idle in the box − debt. */
    async portfolio(id: number, account: Address) {
      const [m, read] = await Promise.all([reader.market(), reader.account(account)]);
      const positions = read.routes.filter(r => r.collateralRaw > 0n || r.routeDebtRaw > 0n).map(r => {
        const t = read.tokens[r.route.loanSymbol]!;
        // The box's money for a loan token is pooled: split it over that token's routes by their debt.
        const tokenRoutes = read.routes.filter(x => x.route.loan === r.route.loan), tokenDebt = tokenRoutes.reduce((s, x) => s + x.routeDebtRaw, 0n);
        const pooled = read.vaults.filter(v => v.vault.token === r.route.loan).reduce((s, v) => s + v.assetsRaw, 0n) + t.idleRaw;
        const share = tokenDebt === 0n ? (tokenRoutes[0] === r ? pooled : 0n) : pooled * r.routeDebtRaw / tokenDebt;
        const vault = r.vault ? m.vaults.find(v => v.vaultId === r.vault!.vaultId) : undefined, market = m.routes.find(x => x.routeId === r.route.routeId);
        const carryBps = (vault ? vault.supplyBps + vault.incentiveBps : 0) - ((market?.borrowBps ?? 0) - (market?.borrowIncentiveBps ?? 0));
        const ratioBps = r.collateralValueUsd === 0n ? 0 : Number(r.routeDebtRaw * 10_000n * E18 / (r.collateralValueUsd === 0n ? 1n : r.collateralValueUsd) / E18);
        const since = Math.max(r.openedAt, read.vaults.find(v => v.vault.vaultId === r.vault?.vaultId)?.since ?? 0);
        return { asset: r.route.symbol, marketId: r.route.routeId, status: 'on' as const,
          collateralRaw: r.collateralRaw.toString(), collateralValueUsd: r.collateralValueUsd.toString(), debtRaw: r.routeDebtRaw.toString(), vaultAssetsRaw: share.toString(),
          netValueUsd: (r.collateralValueUsd + share - r.routeDebtRaw).toString(), earnNetUsd: (share - r.routeDebtRaw).toString(), pendingRewardsRaw: '0',
          ltvBps: r.ltvBps, targetLtvBps: r.targetLtvBps, deleverageLtvBps: r.deleverageLtvBps, liquidationLtvBps: r.liquidationLtvBps,
          extraApyBps: Math.trunc(carryBps * ratioBps / 10_000) + (market?.collateralBps ?? 0), shouldDeleverage: r.shouldDeleverage, shouldUnwind: false,
          newBorrowing: market?.open ? 'open' as const : 'unavailable' as const, reason: market?.open ? null : 'closed',
          route: { source: 'onchain' as const, venue: r.route.venue, loan: r.route.loanSymbol, marketId: marketIdOf(r.route), borrowBps: market?.borrowBps ?? null, borrowIncentiveBps: market?.borrowIncentiveBps ?? null,
            vault: r.vault ? { venue: r.vault.venue, name: `${r.vault.venue === 'lista' ? 'Lista' : r.vault.venue === 'venus' ? 'Venus' : 'Aave v3'} ${r.vault.tokenSymbol}`, token: r.vault.tokenSymbol, address: r.vault.target,
              apyBps: vault ? vault.supplyBps + vault.incentiveBps : null } : null,
            ratioBps, since: since > 0 ? new Date(since * 1000).toISOString() : null } };
      });
      return { portfolioId: id, account, status: 'ok' as const, reason: null, message: null, updatedAt: deps.now().toISOString(), version: 2 as const,
        // The contracts this account's v2 position lives on, the same object the signing payload of a My mix weight change
        // carries (`strategyV2Addresses`): the app has no v2 address of its own (position details, pre-signature checks).
        strategyV2: strategyV2Addresses(v2)!,
        earnNetUsd: read.earnNetUsd.toString(), autoOpen: positions.length === 0 && read.consent, positions,
        rewards: read.rewards.map(r => ({ token: r.token, boxRaw: r.boxRaw.toString(), accountRaw: r.accountRaw.toString() })) };
    },

    /**
     * Buy confirmation with "Earn extra" on: the owner's one consent, appended to the buy UserOp. `weights`: the
     * enrollment's assets; `budgetUsd` the money about to be invested. After the fill the scheduler posts and borrows with
     * the session key on whatever route is best then.
     */
    async auto(account: Address, owner: Address, input: { budgetRaw: bigint; weights: readonly { asset: Address; weightBps: number }[]; keyReady: boolean }) {
      const m = await reader.market();
      const tokens = eligibleTokens(m, input.weights.filter(w => w.weightBps > 0).map(w => w.asset));
      if (tokens.length === 0) return { status: 'unavailable' as const, reason: 'no_eligible_asset', message: TEMPORARILY, assets: [] };
      const read = await reader.account(account, tokens);
      const weight = (t: Address) => input.weights.find(w => w.asset.toLowerCase() === t)?.weightBps ?? 0;
      const plan = planAccount({ snapshot: m.snapshot, holdings: holdingsFor(read, t => usd(input.budgetRaw) * weight(t) / 10_000, true).filter(h => tokens.includes(tokenOf(m, h.symbol)!)), costs, now: deps.now().getTime() });
      const assets = plan.decisions.map(d => d.to && d.action !== 'close' && d.targetDebtUsd > 0
        ? { asset: d.symbol, status: 'ready' as const, maxDebtRaw: maxDebtFor(d.targetDebtUsd).toString(), extraApyBps: d.to.extraBps }
        : { asset: d.symbol, status: 'unavailable' as const, reason: d.reason, message: TEMPORARILY });
      if (!assets.some(a => a.status === 'ready')) return { status: 'unavailable' as const, reason: 'data_unavailable', message: TEMPORARILY, assets };
      const c = consent(m, owner, tokens, targetOf(plan.decisions), read, await reader.delegations(account));
      return { status: 'ready' as const, version: 2 as const, authorization: input.keyReady ? 'ready' as const : 'renewal_required' as const, assets, calls: c.calls, batches: [c.calls] };
    },

    /** One owner UserOp: consent (ceiling for everything the portfolio may borrow) + post this asset and borrow into the vault on today's best route. */
    async open(account: Address, owner: Address, input: { symbol: string; collateralRaw: bigint; weights: readonly { asset: Address; weightBps: number }[]; keyReady: boolean }) {
      const m = await reader.market();
      const token = tokenOf(m, input.symbol);
      const unavailable = (reason: string) => ({ status: 'unavailable' as const, asset: input.symbol, reason, message: TEMPORARILY });
      if (!token) return unavailable('no_route');
      const tokens = [...new Set([token, ...eligibleTokens(m, input.weights.filter(w => w.weightBps > 0).map(w => w.asset))])];
      const read = await reader.account(account, tokens);
      const mine = read.state.holdings.find(h => h.collateral === token);
      if (!mine || input.collateralRaw > mine.freeCollateralRaw) return { status: 'insufficient' as const, asset: input.symbol };
      const plan = planAccount({ snapshot: m.snapshot, holdings: holdingsFor(read, () => 0, true), costs, now: deps.now().getTime() });
      const d = plan.decisions.find(x => x.symbol === input.symbol);
      if (!d || d.action !== 'open' || !d.to) return unavailable(d?.reason ?? 'no_route');
      const c = consent(m, owner, tokens, targetOf(plan.decisions), read, await reader.delegations(account));
      // Only this asset is opened here (the app sends one asset per UserOp); with exactly the amount asked for.
      const exec = planExecution({ v2, account, decisions: [d], positions: read.state.holdings.map(h => h.collateral === token ? { ...h, freeCollateralRaw: input.collateralRaw } : h), deadline: deadline(),
        policyMaxDebtUsdRaw: c.maxDebtUsdRaw, principalUsdRaw: read.state.principalUsdRaw, limits: m.limits });
      const step = exec.steps[0];
      if (!step || step.calls.length === 0) return unavailable(step?.skipped === 'below the Lista minimum loan' ? 'too_small' : 'data_unavailable');
      const calls = [...c.calls, ...step.calls];
      return { status: 'ready' as const, version: 2 as const, asset: input.symbol, collateralRaw: input.collateralRaw.toString(), borrowRaw: (maxDebtFor(d.targetDebtUsd) * 10_000n / 11_000n * BORROW_BUFFER_BPS / 10_000n).toString(), maxDebtRaw: c.maxDebtUsdRaw.toString(),
        extraApyBps: d.to.extraBps, authorization: input.keyReady ? 'ready' as const : 'renewal_required' as const, calls, batches: [calls] };
    },

    /**
     * Turn off (owner-signed). `symbols`: the assets to close; when that is every open position the consent is withdrawn in
     * the last UserOp (so the scheduler does not open them again) and the box's leftovers are released. `exit` (sell all /
     * withdraw / delete): reward tokens in the box and the account also go to the owner's wallet; a plain turn-off keeps
     * them in the portfolio account.
     */
    async close(account: Address, input: { symbols: readonly string[]; exit?: boolean }) {
      const read = await reader.account(account);
      // Account USDT the cash ledger claims is never the strategy's to spend: not for a top-up, and not as the `maxCashIn`
      // of a repayment on a route that borrows USDT (src/withdrawable-cash.ts claimedCash).
      const usdtToken = v2.loanTokens.USDT?.toLowerCase(), usdtCash = Object.values(read.tokens).find(t => t.token.toLowerCase() === usdtToken);
      const claims = deps.cashClaims && (Object.values(read.tokens).some(t => t.swap) || (usdtCash?.cashRaw ?? 0n) > 0n) ? await deps.cashClaims(account) : { claimedRaw: 0n, ownRaw: 0n };
      // A top-up, and the `maxCashIn` of a repayment on a USDT route, may spend the portfolio's own cash and unclaimed USDT:
      // what is spent is booked against the own cash when the UserOp is confirmed. Every other bucket stays untouched.
      const others = deps.bookSwaps ? claims.claimedRaw - (claims.ownRaw < claims.claimedRaw ? claims.ownRaw : claims.claimedRaw) : claims.claimedRaw;
      for (const t of Object.values(read.tokens)) if (t.swap) t.swap.usdtRaw = t.swap.usdtRaw > others ? t.swap.usdtRaw - others : 0n;
      if (usdtCash) usdtCash.cashRaw = usdtCash.cashRaw > others ? usdtCash.cashRaw - others : 0n;
      const open = read.routes.filter(r => r.collateralRaw > 0n || r.routeDebtRaw > 0n);
      const chosen = open.filter(r => input.symbols.includes(r.route.symbol));
      const all = open.every(r => chosen.includes(r));
      // The owner signs this exit, so approvals the cash swapper still lacks are signed in it: plan as if they were there.
      const approved = (q: SwapQuote | undefined) => q ? { swap: { ...q, usdtAllowanceRaw: maxUint256, tokenAllowanceRaw: maxUint256 } } : {};
      const routes: ExitRoute[] = chosen.map(r => { const t = read.tokens[r.route.loanSymbol]!; return { routeId: r.route.routeId, vaultId: (r.vault?.vaultId ?? ('0x' + '00'.repeat(32))) as Hex, routeDebtRaw: r.routeDebtRaw, cashRaw: t.cashRaw,
        loan: r.route.loanSymbol, vaultAssetsRaw: read.vaults.find(v => v.vault.vaultId === r.vault?.vaultId)?.assetsRaw ?? 0n, idleRaw: t.idleRaw, ...approved(t.swap),
        postedRaw: r.collateralRaw, minDebtRaw: r.limits.minDebtRaw,
        // No route of this token stays open after this exit (which of the chosen ones is the last is the exit plan's to say).
        lastOfToken: !open.some(x => x.route.loan === r.route.loan && !chosen.includes(x)) }; });
      // What stays in the box once every route of a token is closed: vaults other than the one each close names.
      const named = new Set(routes.map(r => r.vaultId));
      const leftoverVaults = all ? read.vaults.filter(v => v.assetsRaw > 0n && (!named.has(v.vault.vaultId) || !chosen.some(r => r.route.loan === v.vault.token))).map(v => v.vault.vaultId) : [];
      const rewards = input.exit && all ? read.rewards.filter(r => r.boxRaw > 0n || r.accountRaw > 0n && r.allowanceRaw >= r.accountRaw)
        .map(r => ({ token: r.token, accountAmountRaw: r.accountRaw > 0n && r.allowanceRaw >= r.accountRaw ? maxUint256 : 0n })) : [];
      // Loan token other than USDT already in the account with nothing owed in it and no route of it being closed now: sold too.
      // When this exit has nothing else to send, the cash-out would be a UserOp of its own: only above V2_CASH_OUT_ALONE_MIN_RAW.
      const cashOutMin = routes.length > 0 || leftoverVaults.length > 0 || rewards.length > 0 || (all && read.policy.enabled) ? V2_CASH_OUT_MIN_RAW : V2_CASH_OUT_ALONE_MIN_RAW;
      const cashOuts = Object.entries(read.tokens).filter(([symbol, t]) => t.swap !== undefined && t.debtRaw === 0n && t.cashRaw >= cashOutMin && !chosen.some(r => r.route.loanSymbol === symbol))
        .map(([, t]) => ({ token: t.token, amountRaw: t.cashRaw }));
      const planned: ExitInput = { routes, leftoverVaults, rewards, cashOuts, deadline: deadline(), withdrawConsent: all && read.policy.enabled, rewardRecipient: read.policy.rewardRecipient, now: deps.now().getTime() };
      // A route in USDC / USD1 / U whose box is short, and no way to top it up now (the portfolio has no USDT it may spend,
      // or the token's 24-hour window is used up): its close would only revert, so it is not handed out. The owner's UserOp
      // repays what the box holds and takes that share of the collateral back (v2ExitPlan); consent is still withdrawn, and
      // the scheduler closes the rest with the session key (it raises the missing USDT from the portfolio's own holdings).
      // A vault of a token that stays owed is not released: its money is that route's repayment.
      const owed = new Set(v2ExitPlan(v2, account, planned).open.map(routeId => chosen.find(r => r.route.routeId === routeId)?.route.loan));
      const base: ExitInput = owed.size === 0 ? planned : { ...planned, leftoverVaults: read.vaults.filter(v => leftoverVaults.includes(v.vault.vaultId) && !owed.has(v.vault.token)).map(v => v.vault.vaultId) };
      const first = v2ExitPlan(v2, account, base);
      // Approvals to the swapper this exit uses and the account lacks: USDT for a top-up, the token itself for a cash-out.
      const usdt = v2.loanTokens.USDT?.toLowerCase() as Address | undefined, uses = new Set<Address>();
      for (const c of first.calls) {
        if (!v2.swapper || c.to !== v2.swapper) continue;
        const d = decodeFunctionData({ abi: V2_SWAPPER_ABI, data: c.data });
        if (d.functionName === 'topUp' && usdt) uses.add(usdt); else if (d.functionName === 'cashOut') uses.add(d.args[0].toLowerCase() as Address);
      }
      const args: ExitInput = { ...base, swapperApprovals: [...uses].filter(t => (read.swapperAllowances[t] ?? 0n) < 2n ** 128n) };
      const calls = v2ExitPlan(v2, account, args).calls;
      if (calls.length === 0) return { status: 'ready' as const, version: 2 as const, asset: input.symbols[0] ?? null, assets: [], calls: [], batches: [] };
      const batches = v2ExitBatches(v2, account, args, await gasOf(account, calls));
      return { status: 'ready' as const, version: 2 as const, asset: chosen[0]?.route.symbol ?? null, assets: chosen.map(r => r.route.symbol), calls, batches };
    },

    /**
     * My mix weight change: the re-enrollment voids the consent, so the same owner UserOp re-consents right after `enroll`
     * (spec §4). Returns [] when the strategy is not on for this account. `totalValueUsd` (1e18) is the mix's value; the
     * ceiling assumes every eligible asset of the NEW weights reaches its target weight.
     */
    async reconsent(account: Address, owner: Address, input: { assets: readonly { address: string; weightBps: number }[]; totalValueUsd: bigint }): Promise<Call[]> {
      const t = await reader.touched(account);
      if (!t.enabled && t.routes.length === 0) return [];
      const m = await reader.market();
      const tokens = eligibleTokens(m, input.assets.filter(a => a.weightBps > 0).map(a => a.address));
      const read = await reader.account(account, tokens);
      if (!read.policy.enabled) return [];
      const weight = (token: Address) => input.assets.find(a => a.address.toLowerCase() === token)?.weightBps ?? 0;
      // Value each asset at its target weight (what the rebalance after the change moves it to), not at what is held now.
      const holdings: Holding[] = tokens.map(token => { const h = read.state.holdings.find(x => x.collateral === token)!;
        return { symbol: h.symbol, collateralUsd: usd(input.totalValueUsd) * weight(token) / 10_000, enabled: true, position: h.position }; });
      const plan = planAccount({ snapshot: m.snapshot, holdings, costs, now: deps.now().getTime() });
      const planned = maxDebtFor(targetOf(plan.decisions)), floor = read.state.principalUsdRaw * 11_000n / 10_000n;
      const maxDebtUsdRaw = [planned, read.policy.maxDebt, floor].reduce((a, b) => (a > b ? a : b));
      // An asset the new weights add may route only through the other lending venue: delegate that venue too, when the
      // account has not yet (the first consent covered only the venues of the assets it had then).
      const needed = [...new Set(m.routes.filter(r => tokens.includes(r.collateral)).map(r => r.venue))];
      const granted = needed.length === 0 ? { venus: true, lista: true } : await reader.delegations(account);
      // Approvals to the cash swapper the account still lacks (it consented before the swapper existed): signed here too, so
      // its repayments can be topped up and its leftover loan token sold without waiting for another consent.
      return v2ReconsentCalls(v2, { maxDebtUsdRaw, rewardRecipient: owner, newCollaterals: tokens, venues: needed.filter(venue => !granted[venue]),
        swapperApprovals: v2MissingSwapperApprovals(v2, token => read.swapperAllowances[token] ?? 0n) });
    },

    /** Owner only (spec §4): the box's receipts of a broken vault back to the account. Only sponsored in a root-signed UserOp. */
    async rescue(account: Address, vaultId: Hex) {
      const read = await reader.account(account);
      const held = read.vaults.find(v => v.vault.vaultId === vaultId.toLowerCase());
      if (!held) return { status: 'unavailable' as const, reason: 'not_held', message: TEMPORARILY };
      // The contract refuses while the vault's token is still owed: close first.
      if (read.routes.some(r => r.route.loan === held.vault.token && r.debtRaw > 0n)) return { status: 'unavailable' as const, reason: 'debt_outstanding', message: TEMPORARILY };
      const calls = [v2RescueCall(v2, account, held.vault.vaultId, deadline())];
      return { status: 'ready' as const, version: 2 as const, ownerOnly: true as const, calls, batches: [calls] };
    },

    /** An owner UserOp is mined: write its v2 events (routes and reward movements) from the verified receipt. */
    async confirm(id: number, account: Address, owner: Address, tx: { hash: Hex; blockNumber: bigint; logs: readonly Log[] }) {
      const m = await reader.market();
      const routes = v2RouteEvents(v2, tx, { portfolioId: id, account, lookup: m.lookup });
      if (routes.length > 0 && deps.recordRoutes) await deps.recordRoutes(v2.chainId, routes);
      const box = (await reader.account(account)).box;
      const rewards = rewardEvents(tx, { portfolioId: id, account, holders: [account, box], owner, tokens: v2.rewardTokens.map(address => ({ symbol: deps.rewardSymbol?.(address) ?? 'LISTA', address })) });
      if (rewards.length > 0 && deps.recordRewards) await deps.recordRewards(v2.chainId, rewards);
      // Top-ups and cash-outs have no table yet: one structured log line each.
      // Top-ups and cash-outs: one structured log line each, and the cash ledger (the portfolio's own cash pays a top-up and
      // receives a cash-out; exactly once per event, so a second `confirm` of the same receipt changes nothing).
      const swaps = v2CashEvents(v2, tx, account, box);
      for (const e of swaps) (deps.log ?? console.log)(swapEventLine(v2.chainId, id, e));
      if (swaps.length > 0 && deps.bookSwaps) await deps.bookSwaps(id, account, swaps);
      return { routes: routes.length, rewards: rewards.length, kinds: [...routes.map(e => e.kind as string), ...rewards.map(e => `reward_${e.kind}`), ...swaps.map(e => e.kind as string)] };
    },
  };
}
export type StrategyEarnV2Api = ReturnType<typeof createStrategyEarnV2Api>;
