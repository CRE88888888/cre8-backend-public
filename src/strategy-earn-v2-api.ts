import { maxUint256 } from 'viem';
import type { Address, Hex, Log } from 'viem';
import { planAccount } from './strategy-earn-routing.js';
import type { Costs, Decision, Holding } from './strategy-earn-routing.js';
import { marketIdOf } from './strategy-earn-v2-chain.js';
import type { V2AccountRead, V2Market, V2Reader } from './strategy-earn-v2-chain.js';
import { BORROW_BUFFER_BPS, maxDebtFor, planExecution, v2ConsentCalls, v2ExitBatches, v2ExitCalls, v2ReconsentCalls, v2RescueCall, v2RouteEvents } from './strategy-earn-v2.js';
import type { Call, ExitRoute, RouteEvent, StrategyEarnV2 } from './strategy-earn-v2.js';
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
/** Testnet gas is ~0.1 gwei; the engine only needs the order of magnitude for its "30 days ≥ 3× cost" rule. */
export const V2_DEFAULT_COSTS: Costs = { gasUsdPerTx: 0.05 };

export type V2ApiDeps = { v2: StrategyEarnV2; reader: V2Reader; now: () => Date;
  /** Estimated gas of one executor call from the account (public node); null = unknown (the call then gets its own UserOp). */
  estimateGas?: (account: Address, call: Call) => Promise<bigint | null>;
  costs?: Costs;
  recordRoutes?: (chainId: number, events: readonly RouteEvent[]) => Promise<void>;
  recordRewards?: (chainId: number, events: readonly RewardEvent[]) => Promise<void>;
  rewardSymbol?: (token: Address) => string | undefined };

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
    return { maxDebtUsdRaw, calls: v2ConsentCalls(v2, { maxDebtUsdRaw, rewardRecipient: owner, venues, collaterals, loanTokens: Object.values(v2.loanTokens) as Address[], rewardTokens: v2.rewardTokens }) };
  };
  const gasOf = async (account: Address, calls: readonly Call[]) => {
    const gas = new Map<string, bigint | null>();
    await Promise.all(calls.map(async c => { gas.set(c.to + c.data, c.to === v2.executor && deps.estimateGas ? await deps.estimateGas(account, c) : c.to === v2.executor ? null : 0n); }));
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
      const open = read.routes.filter(r => r.collateralRaw > 0n || r.routeDebtRaw > 0n);
      const chosen = open.filter(r => input.symbols.includes(r.route.symbol));
      const all = open.every(r => chosen.includes(r));
      const routes: ExitRoute[] = chosen.map(r => ({ routeId: r.route.routeId, vaultId: (r.vault?.vaultId ?? ('0x' + '00'.repeat(32))) as Hex, routeDebtRaw: r.routeDebtRaw, cashRaw: read.tokens[r.route.loanSymbol]!.cashRaw }));
      // What stays in the box once every route of a token is closed: vaults other than the one each close names.
      const named = new Set(routes.map(r => r.vaultId));
      const leftoverVaults = all ? read.vaults.filter(v => v.assetsRaw > 0n && (!named.has(v.vault.vaultId) || !chosen.some(r => r.route.loan === v.vault.token))).map(v => v.vault.vaultId) : [];
      const rewards = input.exit && all ? read.rewards.filter(r => r.boxRaw > 0n || r.accountRaw > 0n && r.allowanceRaw >= r.accountRaw)
        .map(r => ({ token: r.token, accountAmountRaw: r.accountRaw > 0n && r.allowanceRaw >= r.accountRaw ? maxUint256 : 0n })) : [];
      const args = { routes, leftoverVaults, rewards, deadline: deadline(), withdrawConsent: all && read.policy.enabled, rewardRecipient: read.policy.rewardRecipient };
      const calls = v2ExitCalls(v2, account, args);
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
      return v2ReconsentCalls(v2, { maxDebtUsdRaw, rewardRecipient: owner, newCollaterals: tokens, venues: needed.filter(venue => !granted[venue]) });
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
      return { routes: routes.length, rewards: rewards.length, kinds: [...routes.map(e => e.kind as string), ...rewards.map(e => `reward_${e.kind}`)] };
    },
  };
}
export type StrategyEarnV2Api = ReturnType<typeof createStrategyEarnV2Api>;
