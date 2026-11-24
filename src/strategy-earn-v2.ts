import { decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeFunctionData, isAddressEqual, keccak256, maxUint256, pad, parseAbi, toFunctionSelector, zeroAddress } from 'viem';
import type { Address, Hex, Log } from 'viem';
import { ParamCondition } from '@zerodev/permissions/policies';
import { planAccount } from './strategy-earn-routing.js';
import type { Costs, Decision, Holding, Liquidity, PricedRoute, RouteKey } from './strategy-earn-routing.js';
import type { RoutingSnapshot, Stable, Venue } from './strategy-earn-mainnet.js';

/**
 * Strategy Earn routing v2 (cre8-contracts docs/borrow-routing-v2, interface v2.0-draft1): the execution side of the
 * routing engine. NOT DEPLOYED anywhere yet: `strategyEarnV2()` returns null until a deployment is configured, and every
 * caller keeps the v1 chain-97 flow while it is null. Nothing here does I/O; it builds and checks calls.
 *
 * v2 in one paragraph: one executor moves the money; routes (venue × collateral × loan token × Lista market) and vaults
 * are allowlisted in the registry and picked per call (`routeId`, `vaultId`); vault receipts sit in a per-account
 * strategy box; consent is one account-level `setStrategyPolicy(maxDebt, rewardRecipient, enabled)`; no call takes a
 * receiver; every `execute*` except `executeDeleverage` needs `msg.sender == account`.
 */
export const V2_INTERFACE_VERSION = 'v2.0-draft1';
export type StrategyEarnV2 = {
  chainId: number; executor: Address; registry: Address; venusComptroller: Address; moolah: Address;
  /** Loan tokens on the registry allowlist (same-token routes only). */
  loanTokens: Partial<Record<Stable, Address>>;
  /** Reward tokens on the registry allowlist (LISTA, XVS). */
  rewardTokens: readonly Address[];
};
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/**
 * The v2 deployment for this chain, or null (= v2 off, v1 flow stays). Source: STRATEGY_EARN_V2_DEPLOYMENT, a JSON
 * manifest `{ chainId, executor, registry, venusComptroller, moolah, loanTokens: { USDT: … }, rewardTokens: [...] }`.
 * A malformed manifest throws: a half-read deployment must never be used to build calls.
 */
export function strategyEarnV2(chainId: number, env: NodeJS.ProcessEnv = process.env): StrategyEarnV2 | null {
  const raw = env.STRATEGY_EARN_V2_DEPLOYMENT?.trim();
  if (!raw) return null;
  let d: Record<string, unknown>;
  try { d = JSON.parse(raw) as Record<string, unknown>; } catch { throw new Error('STRATEGY_EARN_V2_DEPLOYMENT must be JSON'); }
  if (Number(d.chainId) !== chainId) return null;
  const a = (v: unknown, name: string): Address => { if (typeof v !== 'string' || !ADDRESS.test(v) || isAddressEqual(v as Address, zeroAddress)) throw new Error(`STRATEGY_EARN_V2_DEPLOYMENT.${name} must be an address`); return v.toLowerCase() as Address; };
  const loanTokens: Partial<Record<Stable, Address>> = {};
  for (const [symbol, token] of Object.entries((d.loanTokens ?? {}) as Record<string, unknown>)) {
    if (!['USDT', 'USDC', 'USD1', 'U'].includes(symbol)) throw new Error('STRATEGY_EARN_V2_DEPLOYMENT.loanTokens: unknown token ' + symbol);
    loanTokens[symbol as Stable] = a(token, 'loanTokens.' + symbol);
  }
  if (Object.keys(loanTokens).length === 0) throw new Error('STRATEGY_EARN_V2_DEPLOYMENT.loanTokens is empty');
  return { chainId, executor: a(d.executor, 'executor'), registry: a(d.registry, 'registry'), venusComptroller: a(d.venusComptroller, 'venusComptroller'), moolah: a(d.moolah, 'moolah'),
    loanTokens, rewardTokens: (Array.isArray(d.rewardTokens) ? d.rewardTokens : []).map((t, i) => a(t, `rewardTokens[${i}]`)) };
}

export const V2_EXECUTOR_ABI = parseAbi([
  'function executeOpen(address account, bytes32 routeId, bytes32 vaultId, uint256 collateralAmount, uint256 borrowAmount, uint256 deadline)',
  'function executeReduce(address account, bytes32 routeId, bytes32 vaultId, uint256 repayAmount, uint256 withdrawAmount, uint256 maxCashIn, uint256 deadline)',
  'function executeDeleverage(address account, bytes32 routeId, bytes32 vaultId, uint256 maxRepay) returns (uint256 repaid)',
  'function executeMigrate(address account, bytes32 fromRouteId, bytes32 fromVaultId, bytes32 toRouteId, bytes32 toVaultId, uint256 borrowAmount, uint256 maxCashIn, uint256 deadline)',
  'function executeSwitchVault(address account, bytes32 fromVaultId, bytes32 toVaultId, uint256 amount, uint256 deadline)',
  'function executeRelease(address account, bytes32 vaultId, uint256 deadline)',
  'function executeSweepRewards(address account, address token, uint256 accountAmount, uint256 deadline)',
  'function boxOf(address account) view returns (address)',
]);
export const V2_REGISTRY_ABI = parseAbi([
  'function setStrategyPolicy(uint256 maxDebt, address rewardRecipient, bool enabled)',
  'struct RouteReport { bytes32 routeId; uint256 borrowIncentive; uint256 collateralIncentive; }',
  'struct VaultReport { bytes32 vaultId; uint256 baseRate; uint256 incentive; }',
  'function reportRates(RouteReport[] routes, VaultReport[] vaults)',
  'function reconcile(address account, bytes32 routeId)',
]);
export const V2_EVENTS_ABI = parseAbi([
  'event Opened(address indexed account, bytes32 indexed routeId, bytes32 indexed vaultId, uint256 collateralIn, uint256 borrowed, uint256 ltv)',
  'event Reduced(address indexed account, bytes32 indexed routeId, bytes32 indexed vaultId, uint256 repaid, uint256 fromVault, uint256 fromCash, uint256 collateralOut, uint256 debtLeft)',
  'event Deleveraged(address indexed account, bytes32 indexed routeId, bytes32 indexed vaultId, uint256 repaid, uint256 debtValueBefore, uint256 debtValueAfter)',
  'event Migrated(address indexed account, bytes32 indexed fromRouteId, bytes32 indexed toRouteId, bytes32 fromVaultId, bytes32 toVaultId, uint256 repaid, uint256 collateralMoved, uint256 borrowed)',
  'event VaultSwitched(address indexed account, bytes32 indexed fromVaultId, bytes32 indexed toVaultId, uint256 assets)',
  'event Released(address indexed account, bytes32 indexed vaultId, uint256 assets)',
  'event RewardsSwept(address indexed account, address indexed token, address indexed recipient, uint256 amount)',
]);
const LENDING_ABI = parseAbi(['function updateDelegate(address delegate, bool allowBorrows)', 'function setAuthorization(address authorized, bool newIsAuthorized)']);
const TOKEN_ABI = parseAbi(['function approve(address spender, uint256 amount)']);

// ---------------------------------------------------------------------------
// Ids (spec §3)
// ---------------------------------------------------------------------------
export const VENUE_ID = { venus: 1, lista: 2 } as const;
export const VAULT_KIND = { lista: 1, venus: 2, aave: 3 } as const;
const ZERO32 = ('0x' + '00'.repeat(32)) as Hex;
/** keccak256(abi.encode(uint8 venue, address collateral, address loan, bytes32 listaId)); listaId = 0 on Venus. */
export const routeIdOf = (venue: 'venus' | 'lista', collateral: Address, loan: Address, listaId: Hex | null): Hex =>
  keccak256(encodeAbiParameters([{ type: 'uint8' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }], [VENUE_ID[venue], collateral, loan, venue === 'venus' ? ZERO32 : listaId ?? ZERO32]));
/** keccak256(abi.encode(uint8 kind, address token, address target)); target = ERC4626 vault / vToken / Aave Pool. */
export const vaultIdOf = (venue: Venue, token: Address, target: Address): Hex =>
  keccak256(encodeAbiParameters([{ type: 'uint8' }, { type: 'address' }, { type: 'address' }], [VAULT_KIND[venue], token, target]));
/** On-chain ids of an engine route. Venus's engine `marketId` is the loan vToken (not part of the id); Lista's is the Moolah market id. */
export function routeIds(v2: StrategyEarnV2, collateral: Address, r: RouteKey): { routeId: Hex; vaultId: Hex; loanToken: Address } {
  const loanToken = v2.loanTokens[r.loan];
  if (!loanToken) throw new Error('loan token not on the v2 allowlist: ' + r.loan);
  return { loanToken, routeId: routeIdOf(r.venue, collateral, loanToken, r.venue === 'lista' ? r.marketId as Hex : null), vaultId: vaultIdOf(r.vault.venue, loanToken, r.vault.address as Address) };
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------
export type Call = { to: Address; data: Hex; value: '0' };
const exec = (v2: StrategyEarnV2, functionName: string, args: readonly unknown[]): Call =>
  ({ to: v2.executor, value: '0', data: encodeFunctionData({ abi: V2_EXECUTOR_ABI, functionName: functionName as never, args: args as never }) });
export const v2Calls = {
  open: (v2: StrategyEarnV2, account: Address, routeId: Hex, vaultId: Hex, collateralRaw: bigint, borrowRaw: bigint, deadline: bigint) => exec(v2, 'executeOpen', [account, routeId, vaultId, collateralRaw, borrowRaw, deadline]),
  reduce: (v2: StrategyEarnV2, account: Address, routeId: Hex, vaultId: Hex, repayRaw: bigint, withdrawRaw: bigint, maxCashInRaw: bigint, deadline: bigint) =>
    exec(v2, 'executeReduce', [account, routeId, vaultId, repayRaw, withdrawRaw, maxCashInRaw, deadline]),
  /** Repay all of this route's debt and take all its collateral back. */
  close: (v2: StrategyEarnV2, account: Address, routeId: Hex, vaultId: Hex, maxCashInRaw: bigint, deadline: bigint) => exec(v2, 'executeReduce', [account, routeId, vaultId, maxUint256, maxUint256, maxCashInRaw, deadline]),
  migrate: (v2: StrategyEarnV2, account: Address, from: { routeId: Hex; vaultId: Hex }, to: { routeId: Hex; vaultId: Hex }, borrowRaw: bigint, maxCashInRaw: bigint, deadline: bigint) =>
    exec(v2, 'executeMigrate', [account, from.routeId, from.vaultId, to.routeId, to.vaultId, borrowRaw, maxCashInRaw, deadline]),
  switchVault: (v2: StrategyEarnV2, account: Address, fromVaultId: Hex, toVaultId: Hex, amountRaw: bigint, deadline: bigint) => exec(v2, 'executeSwitchVault', [account, fromVaultId, toVaultId, amountRaw, deadline]),
  release: (v2: StrategyEarnV2, account: Address, vaultId: Hex, deadline: bigint) => exec(v2, 'executeRelease', [account, vaultId, deadline]),
  sweepRewards: (v2: StrategyEarnV2, account: Address, token: Address, accountAmountRaw: bigint, deadline: bigint) => exec(v2, 'executeSweepRewards', [account, token, accountAmountRaw, deadline]),
  /** Anyone-callable: sent by the operator, not through the account. */
  deleverage: (v2: StrategyEarnV2, account: Address, routeId: Hex, vaultId: Hex, maxRepayRaw: bigint = maxUint256) => exec(v2, 'executeDeleverage', [account, routeId, vaultId, maxRepayRaw]),
};

/** 10% above the planned principal, for the next top-up; the contract counts principal, not interest. */
export const MAX_DEBT_BUFFER_BPS = 11_000n;
/** Keep 2% under the target so interest accrued before inclusion cannot push the position over it (same as v1). */
export const BORROW_BUFFER_BPS = 9_800n;
/** Moolah refuses to leave a loan under this (mainnet minLoanValue = 15 USD): repay in full instead. */
export const LISTA_MIN_LOAN_USD = 15;
const E18 = 10n ** 18n;
const usdRaw = (usd: number) => BigInt(Math.floor(usd * 1e6)) * 10n ** 12n; // loan tokens are 18 decimals on BSC (spec §8)

/**
 * What the owner signs once (sudo), in one UserOp: account-level consent with a debt ceiling (USD, 18 decimals, every loan
 * token counted at 1 USD — one ceiling for all loan tokens), the lending delegations the planned routes need, and collateral
 * approvals to the v2 executor. Loan tokens are approved too so a repayment can fall back to the account's own cash
 * (`maxCashIn`). Never a vault receipt (they live in the strategy box) and never anything to the old AtpExecutor.
 */
export function v2ConsentCalls(v2: StrategyEarnV2, input: { maxDebtUsdRaw: bigint; rewardRecipient: Address; venues: readonly ('venus' | 'lista')[]; collaterals: readonly Address[]; loanTokens?: readonly Address[] }): Call[] {
  if (input.maxDebtUsdRaw <= 0n) throw new Error('consent needs a debt ceiling');
  const approve = (token: Address): Call => ({ to: token, value: '0', data: encodeFunctionData({ abi: TOKEN_ABI, functionName: 'approve', args: [v2.executor, maxUint256] }) });
  return [
    ...(input.venues.includes('venus') ? [{ to: v2.venusComptroller, value: '0' as const, data: encodeFunctionData({ abi: LENDING_ABI, functionName: 'updateDelegate', args: [v2.executor, true] }) }] : []),
    ...(input.venues.includes('lista') ? [{ to: v2.moolah, value: '0' as const, data: encodeFunctionData({ abi: LENDING_ABI, functionName: 'setAuthorization', args: [v2.executor, true] }) }] : []),
    { to: v2.registry, value: '0', data: encodeFunctionData({ abi: V2_REGISTRY_ABI, functionName: 'setStrategyPolicy', args: [input.maxDebtUsdRaw, input.rewardRecipient, true] }) },
    ...[...new Set(input.collaterals.map(c => c.toLowerCase() as Address))].map(approve),
    ...[...new Set((input.loanTokens ?? []).map(c => c.toLowerCase() as Address))].map(approve),
  ];
}
/** Turn the strategy off for the account: withdraw consent (after the positions are closed in the same UserOp). */
export const v2ConsentOffCall = (v2: StrategyEarnV2): Call =>
  ({ to: v2.registry, value: '0', data: encodeFunctionData({ abi: V2_REGISTRY_ABI, functionName: 'setStrategyPolicy', args: [0n, zeroAddress, false] }) });
/** The ceiling to consent to for a plan: total planned debt over every loan token + 10%. */
export const maxDebtFor = (plannedDebtUsd: number): bigint => usdRaw(plannedDebtUsd) * MAX_DEBT_BUFFER_BPS / 10_000n;

// ---------------------------------------------------------------------------
// Execution planner: engine decisions -> calls
// ---------------------------------------------------------------------------
export type PositionState = {
  symbol: string; collateral: Address;
  /** Collateral in the account, not posted (raw). */
  freeCollateralRaw: bigint;
  /** This route's attributed debt and what the box holds in its vault (loan raw), when a position is open. */
  routeDebtRaw?: bigint; vaultAssetsRaw?: bigint;
  /** The account's own balance of the loan token that may be used to finish a repayment (raw). */
  cashRaw?: bigint;
};
export type Step = {
  symbol: string; action: Decision['action']; reason: Decision['reason'];
  /** 'session': one UserOp through the account (session key or owner). 'keeper': anyone-callable, sent by the operator. */
  via: 'session' | 'keeper';
  calls: Call[];
  /** When `calls` reverts as a whole (VaultShortfall, no room, gate closed): the two-step path, each entry its own UserOp. */
  fallback?: Call[][];
  /** Why nothing was built. */
  skipped?: string;
  rationale: string;
};
export type ExecutionPlan = { steps: Step[];
  /** Total planned debt over all loan tokens (USD): what the account-level ceiling must cover. */
  plannedDebtUsd: number;
  /** The plan needs more ceiling than the owner consented to: opens were capped, the owner should re-consent. */
  consentShort: boolean };

/**
 * Engine decisions for one account -> v2 calls. Order: exits and reductions first (they free ceiling and never add risk),
 * then moves, then opens. `policyMaxDebtUsdRaw`: the owner's ceiling; opens and top-ups are capped to what is left under
 * it rather than sent to revert with DebtAboveConsent.
 */
export function planExecution(input: { v2: StrategyEarnV2; account: Address; decisions: readonly Decision[]; positions: readonly PositionState[];
  deadline: bigint; policyMaxDebtUsdRaw: bigint; principalUsdRaw: bigint }): ExecutionPlan {
  const { v2, account, deadline } = input;
  const state = new Map(input.positions.map(p => [p.symbol, p]));
  const order = { close: 0, reduce: 1, migrate: 2, open: 3, hold: 4 } as const;
  const steps: Step[] = [];
  let principal = input.principalUsdRaw, consentShort = false, plannedDebtUsd = 0;
  const idsOf = (p: PositionState, r: RouteKey) => routeIds(v2, p.collateral, r);
  for (const d of [...input.decisions].sort((a, b) => order[a.action] - order[b.action])) {
    const base = { symbol: d.symbol, action: d.action, reason: d.reason, rationale: d.rationale };
    const p = state.get(d.symbol);
    if (d.action !== 'close') plannedDebtUsd += d.targetDebtUsd;
    if (d.action === 'hold') continue;
    if (!p) { steps.push({ ...base, via: 'session', calls: [], skipped: 'no position state' }); continue; }
    try {
      if (d.action === 'close') {
        const from = idsOf(p, d.from!);
        principal -= p.routeDebtRaw ?? 0n;
        steps.push({ ...base, via: 'session', calls: [v2Calls.close(v2, account, from.routeId, from.vaultId, p.cashRaw ?? 0n, deadline)] });
      } else if (d.action === 'reduce') {
        const from = idsOf(p, d.from!);
        if (d.reason === 'safety_line') { steps.push({ ...base, via: 'keeper', calls: [v2Calls.deleverage(v2, account, from.routeId, from.vaultId)] }); continue; }
        const debt = p.routeDebtRaw ?? 0n, target = usdRaw(d.targetDebtUsd);
        // Lista: a partial repayment may not leave less than the venue's minimum loan — repay everything instead.
        const all = target === 0n || d.from!.venue === 'lista' && d.targetDebtUsd < LISTA_MIN_LOAN_USD;
        const repay = all ? maxUint256 : debt > target ? debt - target : 0n;
        if (repay === 0n) { steps.push({ ...base, via: 'session', calls: [], skipped: 'already at or under the target' }); continue; }
        principal -= all ? debt : repay;
        steps.push({ ...base, via: 'session', calls: [v2Calls.reduce(v2, account, from.routeId, from.vaultId, repay, 0n, p.cashRaw ?? 0n, deadline)] });
      } else if (d.action === 'migrate') {
        const from = idsOf(p, d.from!), to = idsOf(p, d.to!);
        if (from.routeId === to.routeId) {
          steps.push({ ...base, via: 'session', calls: [v2Calls.switchVault(v2, account, from.vaultId, to.vaultId, maxUint256, deadline)] });
          continue;
        }
        const borrow = usdRaw(d.targetDebtUsd) * BORROW_BUFFER_BPS / 10_000n;
        // Atomic first. If the old vault cannot cover the old debt (VaultShortfall) or the new side refuses, the whole
        // call reverts and nothing moved; then close (with the account's own cash if needed) and open as two UserOps.
        steps.push({ ...base, via: 'session', calls: [v2Calls.migrate(v2, account, from, to, borrow, p.cashRaw ?? 0n, deadline)],
          fallback: [[v2Calls.close(v2, account, from.routeId, from.vaultId, p.cashRaw ?? 0n, deadline)], [v2Calls.open(v2, account, to.routeId, to.vaultId, maxUint256, borrow, deadline)]] });
        principal += borrow - (p.routeDebtRaw ?? 0n);
      } else {
        const to = idsOf(p, d.to!);
        const debt = p.routeDebtRaw ?? 0n, want = usdRaw(d.targetDebtUsd) * BORROW_BUFFER_BPS / 10_000n;
        let borrow = want > debt ? want - debt : 0n;
        const room = input.policyMaxDebtUsdRaw > principal ? input.policyMaxDebtUsdRaw - principal : 0n;
        if (borrow > room) { borrow = room; consentShort = true; }
        if (borrow === 0n && p.freeCollateralRaw === 0n) { steps.push({ ...base, via: 'session', calls: [], skipped: consentShort ? 'debt ceiling reached' : 'nothing to post or borrow' }); continue; }
        principal += borrow;
        steps.push({ ...base, via: 'session', calls: [v2Calls.open(v2, account, to.routeId, to.vaultId, p.freeCollateralRaw, borrow, deadline)] });
      }
    } catch (error) { steps.push({ ...base, via: 'session', calls: [], skipped: String((error as Error).message) }); }
  }
  return { steps, plannedDebtUsd, consentShort };
}

/**
 * Turn the strategy off / sell everything / delete (owner-signed, one UserOp): close every route, release every vault
 * the box still holds, send the reward tokens to the owner's wallet as they are, withdraw consent. Venus routes close one
 * after another: each repays its own share of the shared debt, the last one clears it (spec §5).
 */
export function v2ExitCalls(v2: StrategyEarnV2, account: Address, input: { routes: readonly { routeId: Hex; vaultId: Hex; cashRaw?: bigint }[]; leftoverVaults?: readonly Hex[];
  rewardTokens?: readonly Address[]; deadline: bigint; withdrawConsent: boolean }): Call[] {
  return [
    ...input.routes.map(r => v2Calls.close(v2, account, r.routeId, r.vaultId, r.cashRaw ?? 0n, input.deadline)),
    ...(input.leftoverVaults ?? []).map(vaultId => v2Calls.release(v2, account, vaultId, input.deadline)),
    ...(input.rewardTokens ?? []).map(token => v2Calls.sweepRewards(v2, account, token, 0n, input.deadline)),
    ...(input.withdrawConsent ? [v2ConsentOffCall(v2)] : []),
  ];
}

/** Before a sale: for each asset being sold, repay its route and take the shares back (session key). */
export function v2PreSellCalls(v2: StrategyEarnV2, account: Address, routes: readonly { routeId: Hex; vaultId: Hex; cashRaw?: bigint }[], deadline: bigint): Call[] {
  return routes.map(r => v2Calls.close(v2, account, r.routeId, r.vaultId, r.cashRaw ?? 0n, deadline));
}

// ---------------------------------------------------------------------------
// Paymaster rules (both account types go through the same function)
// ---------------------------------------------------------------------------
export type V2CallKind = 'risk' | 'settle';
const SESSION_FUNCTIONS = ['executeOpen', 'executeReduce', 'executeMigrate', 'executeSwitchVault', 'executeRelease', 'executeSweepRewards'] as const;
const RISK: ReadonlySet<string> = new Set(['executeOpen', 'executeMigrate', 'executeSwitchVault']);
const canonical = (abi: readonly unknown[], functionName: string, args: readonly unknown[], data: Hex) =>
  encodeFunctionData({ abi, functionName, args } as never).toLowerCase() === data.toLowerCase();
/** Is this call's target one of the v2 contracts (so the v2 rules decide it, and nothing else may)? */
export const isV2Target = (v2: StrategyEarnV2, target: Address) =>
  [v2.executor, v2.registry, v2.venusComptroller, v2.moolah].some(a => isAddressEqual(a, target));
/**
 * A sponsored call to a v2 contract, or an approval to the v2 executor. Returns what it does ('risk' adds collateral,
 * borrowing, a move or consent; 'settle' repays, releases, sweeps rewards or withdraws consent), null when the call is
 * not a v2 call at all, and throws when it is a v2 call that breaks a rule.
 * - executor: only the six account functions (executeDeleverage is anyone-callable: the operator sends it, unsponsored);
 *   argument 0 is this account; a deadline; canonical encoding. Route and vault ids are free: the registry allowlists them.
 * - registry: only setStrategyPolicy; enabling needs a ceiling; the reward recipient is the owner, the account or zero.
 * - Venus / Moolah: only the delegation to (or away from) the v2 executor.
 * - approve(v2 executor): only for a portfolio asset, an allowlisted loan token or a reward token.
 */
export function v2SponsoredCall(v2: StrategyEarnV2, call: { target: Address; callData: Hex }, ctx: { sender: Address; owner?: Address; assets: readonly Address[] }): V2CallKind | null {
  const is = (a: Address) => isAddressEqual(call.target, a);
  if (is(v2.executor)) {
    const inner = decodeFunctionData({ abi: V2_EXECUTOR_ABI, data: call.callData });
    if (!(SESSION_FUNCTIONS as readonly string[]).includes(inner.functionName)) throw new Error('invalid v2 executor call');
    const args = inner.args as readonly unknown[];
    if (!isAddressEqual(args[0] as Address, ctx.sender)) throw new Error('v2 call for another account');
    if (args[args.length - 1] === 0n) throw new Error('v2 call without a deadline');
    if (inner.functionName === 'executeOpen' && args[3] === 0n && args[4] === 0n) throw new Error('empty v2 open');
    if (inner.functionName === 'executeReduce' && args[3] === 0n && args[4] === 0n) throw new Error('empty v2 reduce');
    if (inner.functionName === 'executeSwitchVault' && (args[3] === 0n || args[1] === args[2])) throw new Error('empty v2 vault switch');
    if (inner.functionName === 'executeMigrate' && args[1] === args[3] && args[2] === args[4]) throw new Error('v2 migrate to the same route');
    if (inner.functionName === 'executeSweepRewards' && !v2.rewardTokens.some(t => isAddressEqual(t, args[1] as Address))) throw new Error('v2 sweep of a non-reward token');
    if (!canonical(V2_EXECUTOR_ABI, inner.functionName, args, call.callData)) throw new Error('noncanonical v2 call');
    return RISK.has(inner.functionName) ? 'risk' : 'settle';
  }
  if (is(v2.registry)) {
    const inner = decodeFunctionData({ abi: V2_REGISTRY_ABI, data: call.callData });
    if (inner.functionName !== 'setStrategyPolicy') throw new Error('invalid v2 registry call');
    const [maxDebt, recipient, enabled] = inner.args;
    if (enabled && maxDebt === 0n) throw new Error('v2 consent without a ceiling');
    if (!isAddressEqual(recipient, zeroAddress) && !isAddressEqual(recipient, ctx.sender) && !(ctx.owner && isAddressEqual(recipient, ctx.owner))) throw new Error('v2 reward recipient is not the owner');
    if (!canonical(V2_REGISTRY_ABI, 'setStrategyPolicy', inner.args, call.callData)) throw new Error('noncanonical v2 consent');
    return enabled ? 'risk' : 'settle';
  }
  if (is(v2.venusComptroller) || is(v2.moolah)) {
    const inner = decodeFunctionData({ abi: LENDING_ABI, data: call.callData });
    if (inner.functionName !== (is(v2.venusComptroller) ? 'updateDelegate' : 'setAuthorization')) throw new Error('invalid v2 lending delegation');
    // A delegation to some other contract is not a v2 call (chain 97 v1 may share the venue): the other rules decide, and reject what they do not know.
    if (!isAddressEqual(inner.args[0], v2.executor)) return null;
    if (!canonical(LENDING_ABI, inner.functionName, inner.args, call.callData)) throw new Error('invalid v2 lending delegation');
    return inner.args[1] ? 'risk' : 'settle';
  }
  if (call.callData.toLowerCase().startsWith(toFunctionSelector(TOKEN_ABI[0]))) {
    const inner = decodeFunctionData({ abi: TOKEN_ABI, data: call.callData });
    if (!isAddressEqual(inner.args[0], v2.executor)) return null; // not ours: the ordinary token rules decide
    const allowed = [...ctx.assets, ...Object.values(v2.loanTokens), ...v2.rewardTokens];
    if (!allowed.some(t => isAddressEqual(t, call.target)) || !canonical(TOKEN_ABI, 'approve', inner.args, call.callData)) throw new Error('invalid approval to the v2 executor');
    return 'risk';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Session-key scope
// ---------------------------------------------------------------------------
export const V2_SESSION_SELECTORS: readonly Hex[] = SESSION_FUNCTIONS.map(name => toFunctionSelector(V2_EXECUTOR_ABI.find(f => f.type === 'function' && f.name === name)!));
/**
 * What a session key may call for routing v2: the six account functions on the v2 executor only, argument 0 pinned to this
 * account. No market list (the registry allowlists routes and vaults, so new markets need no renewal), never
 * setStrategyPolicy, a lending delegation or any approve. Appended after every v1 permission so older keys rebuild unchanged.
 */
export function v2SessionPermissions(executor: Address, account: Address) {
  return V2_SESSION_SELECTORS.map(selector => ({ target: executor, selector, rules: [{ condition: ParamCondition.EQUAL, offset: 0, params: [pad(account)] }] }));
}
/** Does this installed permission snapshot carry the whole v2 scope for this account and executor? */
export function v2Authorized(snapshot: unknown, account: Address, executor: Address): boolean {
  const permissions: unknown = snapshot && typeof snapshot === 'object' ? Reflect.get(Reflect.get(snapshot, 'call') ?? {}, 'permissions') : null;
  if (!Array.isArray(permissions)) return false;
  return V2_SESSION_SELECTORS.every(selector => permissions.some((p: unknown) => {
    if (!p || typeof p !== 'object') return false;
    const rules: unknown = Reflect.get(p, 'rules');
    return String(Reflect.get(p, 'target')).toLowerCase() === executor.toLowerCase() && Reflect.get(p, 'selector') === selector && Reflect.get(p, 'callType') === '0x00' &&
      Reflect.get(p, 'valueLimit') === '0' && Array.isArray(rules) && rules.length === 1 && rules[0]?.condition === ParamCondition.EQUAL && rules[0]?.offset === 0 &&
      Array.isArray(rules[0]?.params) && rules[0].params.length === 1 && String(rules[0].params[0]).toLowerCase() === pad(account).toLowerCase();
  }));
}

// ---------------------------------------------------------------------------
// Rate reports (rateReporter = the operator): what the chain cannot read
// ---------------------------------------------------------------------------
const rate = (bps: number) => BigInt(Math.max(0, Math.round(bps))) * E18 / 10_000n;
const MAX_REPORTED_BPS = 5_000;
/**
 * `registry.reportRates` calldata from engine routes: borrow and collateral incentives per route, and base + incentive
 * for Lista (ERC4626) vaults — Venus and Aave supply rates are read on chain. Reports expire after 48 hours; each value
 * is capped at 50% by the contract, so anything above is clamped here rather than reverting the whole batch.
 */
export function v2RateReport(v2: StrategyEarnV2, routes: readonly { collateral: Address; route: PricedRoute }[], vaults: readonly { token: Stable; venue: Venue; address: Address; baseBps: number; incentiveBps: number }[]): Call | null {
  const clamp = (bps: number) => Math.min(bps, MAX_REPORTED_BPS);
  const seen = new Set<string>(), routeReports: { routeId: Hex; borrowIncentive: bigint; collateralIncentive: bigint }[] = [];
  for (const r of routes) {
    if (!v2.loanTokens[r.route.loan]) continue;
    const { routeId } = routeIds(v2, r.collateral, r.route);
    if (seen.has(routeId)) continue; seen.add(routeId);
    routeReports.push({ routeId, borrowIncentive: rate(clamp(r.route.borrowIncentiveBps)), collateralIncentive: rate(clamp(r.route.collateralIncentiveBps)) });
  }
  const vaultReports = vaults.filter(v => v.venue === 'lista' && v2.loanTokens[v.token]).map(v => ({ vaultId: vaultIdOf('lista', v2.loanTokens[v.token]!, v.address), baseRate: rate(clamp(v.baseBps)), incentive: rate(clamp(v.incentiveBps)) }));
  if (routeReports.length === 0 && vaultReports.length === 0) return null;
  return { to: v2.registry, value: '0', data: encodeFunctionData({ abi: V2_REGISTRY_ABI, functionName: 'reportRates', args: [routeReports, vaultReports] }) };
}

// ---------------------------------------------------------------------------
// Rewards on the strategy box
// ---------------------------------------------------------------------------
/**
 * Vault incentives accrue to the strategy box (it is the depositor), and Lista's proof API needs a signature the box itself
 * validates. Agreed with the contracts side (2026-11-24, not in the interface yet): the box's ERC-1271 accepts ONLY the
 * Lista reward message — the signature carries the plaintext, the box checks its exact suffix and EIP-191 hash, then asks
 * the account. DRAFT encoding `abi.encode(string message, bytes accountSignature)`: confirm against the spec when the
 * contracts agent publishes it; until then this is only used by tests.
 */
export const boxRewardSignature = (message: string, accountSignature: Hex): Hex =>
  encodeAbiParameters([{ type: 'string' }, { type: 'bytes' }], [message, accountSignature]);

// ---------------------------------------------------------------------------
// Scheduler step: one account, one round (auto-open after a fill, top-up, migrate, reduce, close, deleverage)
// ---------------------------------------------------------------------------

/** One eligible asset of the account as read from the chain (bulk read on the public node; never the paid RPC). */
export type V2Holding = PositionState & {
  /** USD value of everything held (posted + free). */
  collateralUsd: number;
  /** The open position's route, debt in USD and when it entered this route (registry `openedAt`, or the last vault switch from the ledger). */
  position: null | { route: RouteKey; debtUsd: number; since: number; ltvBps?: number; deleverageLtvBps?: number };
};
export type V2AccountState = { enabled: boolean; policyMaxDebtUsdRaw: bigint; principalUsdRaw: bigint; holdings: readonly V2Holding[] };
export type V2Tx = { hash: Hex };
export type V2RoundArgs = { v2: StrategyEarnV2; portfolioId: number; account: Address; snapshot: RoutingSnapshot; state: V2AccountState; costs: Costs; now: number; deadline: bigint;
  liquidity?: Liquidity; dryRun: boolean; log: (line: string) => void;
  /** One UserOp through the account with its session key. */
  send: (calls: Call[]) => Promise<V2Tx>;
  /** Anyone-callable transaction from the operator (executeDeleverage). Absent: left for the next keeper round. */
  keeper?: (call: Call) => Promise<V2Tx>;
  /** Called after each confirmed transaction with the step that caused it (ledger, activity). */
  record?: (step: Step, tx: V2Tx) => Promise<void> };
export type V2RoundResult = { decisions: number; sent: number; failed: number; skipped: number; consentShort: boolean };
/**
 * Decide (routing engine) and execute for one account. Every decision is logged as one line with its rationale, whether or
 * not it leads to a transaction. A step that fails is logged and left for the next round; an atomic migrate that reverts
 * falls back to close-then-open, and stops after the close if the open fails (the asset is then simply not borrowing).
 */
export async function runV2Account(a: V2RoundArgs): Promise<V2RoundResult> {
  const holdings: Holding[] = a.state.holdings.map(h => ({ symbol: h.symbol, collateralUsd: h.collateralUsd, enabled: a.state.enabled, position: h.position }));
  const engine = planAccount({ snapshot: a.snapshot, holdings, costs: a.costs, now: a.now, ...(a.liquidity ? { liquidity: a.liquidity } : {}) });
  const execution = planExecution({ v2: a.v2, account: a.account, decisions: engine.decisions, positions: a.state.holdings, deadline: a.deadline,
    policyMaxDebtUsdRaw: a.state.policyMaxDebtUsdRaw, principalUsdRaw: a.state.principalUsdRaw });
  const result: V2RoundResult = { decisions: engine.decisions.length, sent: 0, failed: 0, skipped: 0, consentShort: execution.consentShort };
  const tag = `[strategy-routing] portfolio ${a.portfolioId}:`;
  for (const d of engine.decisions) if (d.action === 'hold') a.log(`${tag} ${d.rationale}`);
  for (const step of execution.steps) {
    if (step.calls.length === 0) { result.skipped++; a.log(`${tag} ${step.rationale} — not sent: ${step.skipped}`); continue; }
    if (a.dryRun) { result.skipped++; a.log(`${tag} ${step.rationale} — dry run`); continue; }
    const one = async (calls: Call[]) => { const tx = step.via === 'keeper' ? await a.keeper!(calls[0]!) : await a.send(calls); await a.record?.(step, tx); return tx; };
    if (step.via === 'keeper' && !a.keeper) { result.skipped++; a.log(`${tag} ${step.rationale} — left for the keeper`); continue; }
    try {
      const tx = await one(step.calls);
      result.sent++; a.log(`${tag} ${step.rationale} — tx ${tx.hash}`);
    } catch (error) {
      const why = String((error as Error)?.message ?? error).split('\n')[0]!.slice(0, 140);
      if (!step.fallback) { result.failed++; a.log(`${tag} ${step.rationale} — failed, next round retries: ${why}`); continue; }
      a.log(`${tag} ${step.rationale} — atomic move reverted (${why}); closing then reopening`);
      try {
        for (const batch of step.fallback) { const tx = await one(batch); result.sent++; a.log(`${tag} ${step.symbol} two-step — tx ${tx.hash}`); }
      } catch (inner) { result.failed++; a.log(`${tag} ${step.symbol} two-step not finished, next round retries: ${String((inner as Error)?.message ?? inner).split('\n')[0]!.slice(0, 140)}`); }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Ledger (db 0069 strategy_route_events) and the activity sentence
// ---------------------------------------------------------------------------
export type RouteEventKind = 'open' | 'reduce' | 'close' | 'deleverage' | 'migrate' | 'switch_vault' | 'release';
export type RouteEvent = { portfolioId: number; account: Address; asset: string | null; kind: RouteEventKind; reason: string | null;
  routeId: Hex | null; vaultId: Hex; fromRouteId: Hex | null; fromVaultId: Hex | null; venue: 'venus' | 'lista' | null; loan: string | null; vaultVenue: Venue | null;
  amountRaw: bigint; collateralRaw: bigint; txHash: Hex; logIndex: number; blockNumber: bigint };
export type RouteLookup = { route(routeId: Hex): { asset: string; venue: 'venus' | 'lista'; loan: string } | null; vault(vaultId: Hex): { venue: Venue } | null };
/** Ledger rows from a verified receipt: only this account's events from the v2 executor. `reason`: the routing engine's reason for a scheduler step. */
export function v2RouteEvents(v2: StrategyEarnV2, tx: { hash: Hex; blockNumber: bigint; logs: readonly Log[] }, ctx: { portfolioId: number; account: Address; lookup: RouteLookup; reason?: string | null }): RouteEvent[] {
  const out: RouteEvent[] = [];
  for (const log of tx.logs) {
    if (log.address.toLowerCase() !== v2.executor || log.logIndex == null) continue;
    let d: { eventName: string; args: Record<string, unknown> };
    try { d = decodeEventLog({ abi: V2_EVENTS_ABI, data: log.data, topics: log.topics }) as never; } catch { continue; }
    const a = d.args;
    if (String(a.account).toLowerCase() !== ctx.account) continue;
    const row = (kind: RouteEventKind, routeId: Hex | null, vaultId: Hex, amountRaw: bigint, collateralRaw = 0n, from: { routeId?: Hex; vaultId?: Hex } = {}): RouteEvent => {
      const r = routeId ? ctx.lookup.route(routeId) : null, v = ctx.lookup.vault(vaultId);
      return { portfolioId: ctx.portfolioId, account: ctx.account, asset: r?.asset ?? null, kind, reason: ctx.reason ?? null, routeId, vaultId, fromRouteId: from.routeId ?? null, fromVaultId: from.vaultId ?? null,
        venue: r?.venue ?? null, loan: r?.loan ?? null, vaultVenue: v?.venue ?? null, amountRaw, collateralRaw, txHash: tx.hash, logIndex: log.logIndex!, blockNumber: tx.blockNumber };
    };
    const h = (k: string) => String(a[k]).toLowerCase() as Hex, n = (k: string) => a[k] as bigint;
    if (d.eventName === 'Opened') out.push(row('open', h('routeId'), h('vaultId'), n('borrowed'), n('collateralIn')));
    // A reduce that leaves no debt and returns collateral is the close the user sees.
    else if (d.eventName === 'Reduced') out.push(row(n('debtLeft') === 0n && n('collateralOut') > 0n ? 'close' : 'reduce', h('routeId'), h('vaultId'), n('repaid'), n('collateralOut')));
    else if (d.eventName === 'Deleveraged') out.push(row('deleverage', h('routeId'), h('vaultId'), n('repaid')));
    else if (d.eventName === 'Migrated') out.push(row('migrate', h('toRouteId'), h('toVaultId'), n('borrowed'), n('collateralMoved'), { routeId: h('fromRouteId'), vaultId: h('fromVaultId') }));
    else if (d.eventName === 'VaultSwitched') out.push(row('switch_vault', null, h('toVaultId'), n('assets'), 0n, { vaultId: h('fromVaultId') }));
    else if (d.eventName === 'Released') out.push(row('release', null, h('vaultId'), n('assets')));
  }
  return out;
}
/** Idempotent: a re-read receipt hits (chain, tx, log) and is skipped. */
export const routeLedger = (run: (sql: string, params: unknown[]) => Promise<unknown>) => ({
  async record(chainId: number, events: readonly RouteEvent[]) {
    for (const e of events) await run(`insert into strategy_route_events(chain_id,portfolio_id,account,asset,kind,reason,route_id,vault_id,from_route_id,from_vault_id,venue,loan,vault_venue,
        amount_raw,collateral_raw,tx_hash,log_index,block_number) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) on conflict (chain_id,tx_hash,log_index) do nothing`,
      [chainId, e.portfolioId, e.account, e.asset, e.kind, e.reason, e.routeId, e.vaultId, e.fromRouteId, e.fromVaultId, e.venue, e.loan, e.vaultVenue,
        e.amountRaw.toString(), e.collateralRaw.toString(), e.txHash, e.logIndex, e.blockNumber.toString()]);
  },
});
/**
 * One short sentence for the activity list, English and Simplified Chinese (the app never shows Traditional). No venue,
 * token, LTV or borrow wording; the fields are returned next to it. `release` is bookkeeping and has no sentence.
 */
export function routeMessage(e: Pick<RouteEvent, 'kind' | 'asset'>): { en: string; zh: string } | null {
  const asset = e.asset ?? '';
  const en = (s: string) => s.replace('  ', ' ').trim(), zh = (s: string) => s.trim();
  switch (e.kind) {
    case 'migrate': case 'switch_vault': return { en: en(`Moved ${asset} to a better rate`), zh: zh(`${asset} 换到更好的利率`) };
    case 'open': return { en: en(`Extra Yield on for ${asset}`), zh: zh(`${asset} 加息已开启`) };
    case 'close': return { en: en(`Extra Yield off for ${asset}`), zh: zh(`${asset} 加息已关闭`) };
    case 'reduce': return { en: en(`Settled part of Extra Yield on ${asset}`), zh: zh(`${asset} 加息已还掉一部分`) };
    case 'deleverage': return { en: en(`${asset} fell, settled part to stay safe`), zh: zh(`${asset} 下跌，已自动还掉一部分`) };
    case 'release': return null;
  }
}
