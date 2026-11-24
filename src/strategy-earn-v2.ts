import { decodeEventLog, decodeFunctionData, encodeAbiParameters, stringToHex, encodeFunctionData, isAddressEqual, keccak256, maxUint256, pad, parseAbi, toFunctionSelector, zeroAddress } from 'viem';
import type { Address, Hex, Log } from 'viem';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ParamCondition } from '@zerodev/permissions/policies';
import { planAccount } from './strategy-earn-routing.js';
import type { Costs, Decision, Holding, Liquidity, PricedRoute, RouteKey } from './strategy-earn-routing.js';
import type { RoutingSnapshot, Stable, Venue } from './strategy-earn-mainnet.js';

/**
 * Strategy Earn routing v2 (cre8-contracts docs/borrow-routing-v2, interface v2.0-draft5): the execution side of the
 * routing engine. Deployed on chain 97 (2026-11-25); not on chain 56. Where it is comes from deployment configuration
 * (`strategyEarnV2`: deploy/strategy-earn-v2.json or STRATEGY_EARN_V2_DEPLOYMENT), never from an address in code. Who gets
 * it is decided per owner by `strategyEarnV2For` (a canary list today): everyone else keeps the v1 chain-97 flow. Apart
 * from reading that manifest nothing here does I/O; it builds and checks calls. Chain reads are in
 * strategy-earn-v2-chain.ts (AtpBorrowLensV2, public nodes).
 *
 * v2 in one paragraph: one executor moves the money; routes (venue × collateral × loan token × Lista market) and vaults
 * are allowlisted in the registry and picked per call (`routeId`, `vaultId`); vault receipts sit in a per-account
 * strategy box; consent is one account-level `setStrategyPolicy(maxDebt, rewardRecipient, enabled)`; no call takes a
 * receiver; every `execute*` except `executeDeleverage` needs `msg.sender == account`.
 */
export const V2_INTERFACE_VERSION = 'v2.0-draft5';
export type StrategyEarnV2 = {
  chainId: number; executor: Address; registry: Address;
  /** AtpBorrowLensV2 (`executor.lens()`): every venue read. */
  lens: Address;
  venusComptroller: Address; moolah: Address;
  /** Loan tokens on the registry allowlist (same-token routes only). */
  loanTokens: Partial<Record<Stable, Address>>;
  /** Reward tokens on the registry allowlist (LISTA, XVS). */
  rewardTokens: readonly Address[];
  /** The vault adapters (they pay a withdrawal straight to the account; My mix flow accounting treats them as internal). */
  adapters: readonly Address[];
  /** Owners whose accounts use v2 while STRATEGY_EARN_V2_AUDIENCE is unset (a canary list). */
  canaryOwners: readonly Address[];
};
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
function parseDeployment(d: Record<string, unknown>, what: string): StrategyEarnV2 {
  const a = (v: unknown, name: string): Address => { if (typeof v !== 'string' || !ADDRESS.test(v) || isAddressEqual(v as Address, zeroAddress)) throw new Error(`${what}.${name} must be an address`); return v.toLowerCase() as Address; };
  const list = (v: unknown, name: string) => (Array.isArray(v) ? v : []).map((t, i) => a(t, `${name}[${i}]`));
  const chainId = Number(d.chainId);
  if (!Number.isSafeInteger(chainId) || chainId < 1) throw new Error(`${what}.chainId must be a chain id`);
  const loanTokens: Partial<Record<Stable, Address>> = {};
  for (const [symbol, token] of Object.entries((d.loanTokens ?? {}) as Record<string, unknown>)) {
    if (!['USDT', 'USDC', 'USD1', 'U'].includes(symbol)) throw new Error(`${what}.loanTokens: unknown token ${symbol}`);
    loanTokens[symbol as Stable] = a(token, 'loanTokens.' + symbol);
  }
  if (Object.keys(loanTokens).length === 0) throw new Error(`${what}.loanTokens is empty`);
  return { chainId, executor: a(d.executor, 'executor'), registry: a(d.registry, 'registry'), lens: a(d.lens, 'lens'), venusComptroller: a(d.venusComptroller, 'venusComptroller'), moolah: a(d.moolah, 'moolah'),
    loanTokens, rewardTokens: list(d.rewardTokens, 'rewardTokens'), adapters: list(d.adapters, 'adapters'), canaryOwners: list(d.canaryOwners, 'canaryOwners') };
}
const parsed = new Map<string, StrategyEarnV2[]>();
/** deploy/strategy-earn-v2.json (or STRATEGY_EARN_V2_MANIFEST): the v2 deployments this build knows, read and checked once. */
function manifestDeployments(env: NodeJS.ProcessEnv): StrategyEarnV2[] {
  const path = env.STRATEGY_EARN_V2_MANIFEST?.trim() || fileURLToPath(new URL('../deploy/strategy-earn-v2.json', import.meta.url));
  let list = parsed.get(path);
  if (!list) {
    let text: string;
    // No manifest in this build = no v2 anywhere (everyone stays on v1). Only a manifest that is there and wrong throws.
    try { text = readFileSync(path, 'utf8'); } catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw new Error('routing v2 manifest cannot be read'); parsed.set(path, []); return []; }
    let file: { deployments?: unknown };
    try { file = JSON.parse(text) as { deployments?: unknown }; } catch { throw new Error('routing v2 manifest is not JSON'); }
    if (!Array.isArray(file.deployments)) throw new Error('routing v2 manifest has no deployments');
    list = file.deployments.map((d, i) => parseDeployment(d as Record<string, unknown>, `strategy-earn-v2.json deployments[${i}]`));
    parsed.set(path, list);
  }
  return list;
}
/**
 * The v2 deployment for this chain, or null (no v2 contracts on this chain). Every v2 address comes from deployment
 * configuration, none from code: STRATEGY_EARN_V2_DEPLOYMENT (one JSON object, wins when set) or the manifest file
 * deploy/strategy-earn-v2.json, both `{ chainId, executor, registry, lens, venusComptroller, moolah, adapters: [...],
 * loanTokens: { USDT: … }, rewardTokens: [...], canaryOwners: [...] }`. The session-key scope, the paymaster rules and the
 * readers all take the executor / registry / lens from the object returned here, so a redeploy is a manifest change.
 * Routes and vaults are not configured at all: the registry enumerates them. A malformed manifest throws: a half-read
 * deployment must never be used to build calls. This says where v2 IS, not who may use it: see `strategyEarnV2For`.
 */
export function strategyEarnV2(chainId: number, env: NodeJS.ProcessEnv = process.env): StrategyEarnV2 | null {
  const raw = env.STRATEGY_EARN_V2_DEPLOYMENT?.trim();
  if (!raw) return manifestDeployments(env).find(d => d.chainId === chainId) ?? null;
  let list = parsed.get(raw);
  if (!list) {
    let d: Record<string, unknown>;
    try { d = JSON.parse(raw) as Record<string, unknown>; } catch { throw new Error('STRATEGY_EARN_V2_DEPLOYMENT must be JSON'); }
    list = [parseDeployment(d, 'STRATEGY_EARN_V2_DEPLOYMENT')];
    parsed.set(raw, list);
  }
  return list[0]!.chainId === chainId ? list[0]! : null;
}
/**
 * Is routing v2 open to this owner's accounts? STRATEGY_EARN_V2_AUDIENCE: unset = the deployment's `canaryOwners`
 * (2026-11-25: the live e2e harness's throwaway test wallet, chain 97); `all` = every owner; `off` = nobody; otherwise a
 * comma-separated list of owner addresses (malformed entries throw). Everyone outside the audience stays on v1: no v2
 * session scope is installed for them, the paymaster sponsors no v2 call of theirs, the API and the scheduler build none.
 * Opening v2 to everyone is a product decision (set the variable to `all`); nothing in the code changes.
 */
export function v2Audience(chainId: number, owner: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof owner !== 'string' || !ADDRESS.test(owner)) return false;
  const raw = env.STRATEGY_EARN_V2_AUDIENCE?.trim();
  if (!raw) return (strategyEarnV2(chainId, env)?.canaryOwners ?? []).some(o => o === owner.toLowerCase());
  if (raw === 'all') return true;
  if (raw === 'off') return false;
  const list = raw.split(',').map(x => x.trim()).filter(Boolean);
  if (list.some(x => !ADDRESS.test(x))) throw new Error('STRATEGY_EARN_V2_AUDIENCE must be all, off or comma-separated 0x addresses');
  return list.some(x => x.toLowerCase() === owner.toLowerCase());
}
/** The deployment this owner's accounts may use, or null (= this owner stays on v1 / has no yield strategy v2). */
export const strategyEarnV2For = (chainId: number, owner: string | null | undefined, env: NodeJS.ProcessEnv = process.env): StrategyEarnV2 | null => {
  const v2 = strategyEarnV2(chainId, env);
  return v2 !== null && v2Audience(chainId, owner, env) ? v2 : null;
};
/**
 * Contracts that hand a portfolio its own tokens back for routing v2: the executor (collateral, surplus) and the vault
 * adapters. A transfer between the account and one of these stays inside the portfolio (src/mix-flows.ts). The account's
 * strategy box does the same but has a per-account address (`executor.boxOf(account)`).
 */
export const v2InternalAddresses = (chainId: number, env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> => {
  const v2 = strategyEarnV2(chainId, env);
  return new Set(v2 === null ? [] : [v2.executor, ...v2.adapters]);
};

export const V2_EXECUTOR_ABI = parseAbi([
  'function executeOpen(address account, bytes32 routeId, bytes32 vaultId, uint256 collateralAmount, uint256 borrowAmount, uint256 deadline)',
  'function executeReduce(address account, bytes32 routeId, bytes32 vaultId, uint256 repayAmount, uint256 withdrawAmount, uint256 maxCashIn, uint256 deadline)',
  'function executeDeleverage(address account, bytes32 routeId, bytes32 vaultId, uint256 maxRepay) returns (uint256 repaid)',
  'function executeMigrate(address account, bytes32 fromRouteId, bytes32 fromVaultId, bytes32 toRouteId, bytes32 toVaultId, uint256 borrowAmount, uint256 maxCashIn, uint256 deadline)',
  'function executeSwitchVault(address account, bytes32 fromVaultId, bytes32 toVaultId, uint256 amount, uint256 deadline)',
  'function executeRelease(address account, bytes32 vaultId, uint256 deadline)',
  'function executeSweepRewards(address account, address token, uint256 accountAmount, uint256 deadline)',
  // Owner only (spec §4, interface `rescueIsOwnerOnlyByPolicy`): never in a session key's scope, never sent by the operator,
  // sponsored only in a root-signed UserOp. Listed here so the paymaster can name it when it refuses.
  'function executeRescue(address account, bytes32 vaultId, uint256 deadline)',
  'function boxOf(address account) view returns (address)',
  'function lens() view returns (address)',
  'function collectRewards(address account, address token) returns (uint256 amount)',
]);
export const V2_REGISTRY_ABI = parseAbi([
  'function setStrategyPolicy(uint256 maxDebt, address rewardRecipient, bool enabled)',
  'struct RouteReport { bytes32 routeId; uint256 borrowIncentive; uint256 collateralIncentive; }',
  'struct VaultReport { bytes32 vaultId; uint256 baseRate; uint256 incentive; }',
  'function reportRates(RouteReport[] routes, VaultReport[] vaults)',
  'function reconcile(address account, bytes32 routeId)',
  'struct Route { uint8 venue; address collateral; address loan; bytes32 listaId; address collateralVToken; address loanVToken; uint256 borrowCap; uint16 maxUtilizationBps; bool enabled; bool retired; }',
  'struct Vault { uint8 kind; address token; address target; address receipt; bool enabled; bool retired; }',
  'struct Policy { uint256 maxDebt; address rewardRecipient; uint256 strategyId; bool enabled; }',
  'function routeCount() view returns (uint256)',
  'function routeIds(uint256 index) view returns (bytes32)',
  'function route(bytes32 routeId) view returns (Route)',
  'function vaultCount() view returns (uint256)',
  'function vaultIds(uint256 index) view returns (bytes32)',
  'function vault(bytes32 vaultId) view returns (Vault)',
  'function policy(address account) view returns (Policy)',
  'function accountPrincipalUsd(address account) view returns (uint256)',
  'function accountRoutes(address account) view returns (bytes32[])',
  'function accountVaults(address account) view returns (bytes32[])',
  'function rateReporter() view returns (address)',
  'function paused() view returns (bool)',
  'function freshReport(bytes32 id) view returns (bool fresh, uint256 a, uint256 b)',
]);
/** AtpBorrowLensV2: every venue read (spec §6). `routeStatus` / `vaultStatus` / `quote` accrue first: eth_call only. */
export const V2_LENS_ABI = parseAbi([
  'struct Health { uint256 collateralValue; uint256 liquidationValue; uint256 debtValue; uint256 budgetValue; uint256 deleverageValue; uint256 healthFactor; }',
  'struct RouteStatus { bool open; bool shouldDeleverage; uint256 borrowRate; uint256 collateralRate; uint256 borrowIncentiveRate; uint256 collateralIncentiveRate; uint256 borrowUtilizationBps; uint256 availableLiquidity; uint256 borrowCapLeft; uint256 targetLtv; uint256 deleverageLtv; uint256 liquidationLtv; uint256 ltv; uint256 collateral; uint256 collateralValue; uint256 debt; uint256 routeDebt; uint256 principal; uint64 openedAt; Health health; }',
  'struct VaultStatus { bool open; bool rateOnChain; bool rateKnown; bool utilizationKnown; bool shouldExit; uint256 supplyRate; uint256 incentiveRate; uint256 utilizationBps; uint256 assets; uint64 since; }',
  'struct Quote { uint8 gate; uint256 targetLtv; uint256 borrowRate; uint256 borrowIncentiveRate; uint256 vaultRate; uint256 vaultIncentiveRate; int256 carry; }',
  'function routeStatus(bytes32 routeId, address account) returns (RouteStatus)',
  'function vaultStatus(bytes32 vaultId, address account) returns (VaultStatus)',
  'function quote(bytes32 routeId, bytes32 vaultId) returns (Quote)',
  'function routeLines(bytes32 routeId) view returns (uint256 target, uint256 deleverage, uint256 f)',
  'function minLoan(bytes32 routeId) view returns (uint256)',
  'function minDebt(bytes32 routeId) view returns (uint256)',
  'function idleOf(address account, address token) view returns (uint256)',
  'function tokenDebt(address account, address token) view returns (uint256)',
  'function routeDebt(bytes32 routeId, address account) view returns (uint256)',
  'function debt(bytes32 routeId, address account) view returns (uint256)',
  'function collateral(bytes32 routeId, address account) view returns (uint256)',
  'function deleverageAmount(bytes32 routeId, address account) view returns (uint256)',
]);
export const V2_EVENTS_ABI = parseAbi([
  'event Opened(address indexed account, bytes32 indexed routeId, bytes32 indexed vaultId, uint256 collateralIn, uint256 borrowed, uint256 debtValue, uint256 budgetValue)',
  'event Reduced(address indexed account, bytes32 indexed routeId, bytes32 indexed vaultId, uint256 repaid, uint256 fromVault, uint256 fromCash, uint256 collateralOut, uint256 debtLeft)',
  'event Deleveraged(address indexed account, bytes32 indexed routeId, bytes32 indexed vaultId, uint256 repaid, uint256 debtValueBefore, uint256 debtValueAfter)',
  'event Migrated(address indexed account, bytes32 indexed fromRouteId, bytes32 indexed toRouteId, bytes32 fromVaultId, bytes32 toVaultId, uint256 repaid, uint256 collateralMoved, uint256 borrowed)',
  'event VaultSwitched(address indexed account, bytes32 indexed fromVaultId, bytes32 indexed toVaultId, uint256 assets)',
  'event Released(address indexed account, bytes32 indexed vaultId, uint256 assets)',
  'event RewardsSwept(address indexed account, address indexed token, address indexed recipient, uint256 amount)',
  'event RewardsCollected(address indexed account, address indexed token, uint256 amount)',
  'event Rescued(address indexed account, bytes32 indexed vaultId, address receipt, uint256 amount)',
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
  /** Anyone-callable (no deadline): strategy box -> account for a reward token. The weekly rewards job sends it after a claim to the box. */
  collectRewards: (v2: StrategyEarnV2, account: Address, token: Address) => exec(v2, 'collectRewards', [account, token]),
  /** Anyone-callable: sent by the operator, not through the account. */
  deleverage: (v2: StrategyEarnV2, account: Address, routeId: Hex, vaultId: Hex, maxRepayRaw: bigint = maxUint256) => exec(v2, 'executeDeleverage', [account, routeId, vaultId, maxRepayRaw]),
};
/**
 * OWNER ONLY, last resort when a vault or its adapter is broken (spec §4/§5): with no debt in the vault's token, the box's
 * receipts go to the account as they are. The contract cannot tell an owner-signed UserOp from a session-key one, so the
 * three off-chain rules are ours: it is not in `V2_SESSION_SELECTORS`, `v2SponsoredCall` sponsors it only in a root-signed
 * UserOp, and `v2KeeperCall` refuses it. Deliberately not part of `v2Calls` (what the scheduler builds from).
 */
export const v2RescueCall = (v2: StrategyEarnV2, account: Address, vaultId: Hex, deadline: bigint): Call => exec(v2, 'executeRescue', [account, vaultId, deadline]);
/** What the operator / keeper key may send to the v2 contracts: the anyone-callable entry points, nothing else (never executeRescue). */
const KEEPER_FUNCTIONS: ReadonlySet<string> = new Set(['executeDeleverage', 'collectRewards']);
export function v2KeeperCall(v2: StrategyEarnV2, call: Call): Call {
  if (!isAddressEqual(call.to, v2.executor)) throw new Error('keeper call is not for the v2 executor');
  let name: string;
  try { name = decodeFunctionData({ abi: V2_EXECUTOR_ABI, data: call.data }).functionName; } catch { throw new Error('keeper call is not a v2 executor function'); }
  if (!KEEPER_FUNCTIONS.has(name)) throw new Error(`the operator never sends ${name}`);
  return call;
}

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
export function v2ConsentCalls(v2: StrategyEarnV2, input: { maxDebtUsdRaw: bigint; rewardRecipient: Address; venues: readonly ('venus' | 'lista')[]; collaterals: readonly Address[]; loanTokens?: readonly Address[];
  /** Reward tokens to approve, so a full exit can send what the account holds on with the box's (`executeSweepRewards`). */
  rewardTokens?: readonly Address[] }): Call[] {
  if (input.maxDebtUsdRaw <= 0n) throw new Error('consent needs a debt ceiling');
  const approve = (token: Address): Call => ({ to: token, value: '0', data: encodeFunctionData({ abi: TOKEN_ABI, functionName: 'approve', args: [v2.executor, maxUint256] }) });
  return [
    ...(input.venues.includes('venus') ? [{ to: v2.venusComptroller, value: '0' as const, data: encodeFunctionData({ abi: LENDING_ABI, functionName: 'updateDelegate', args: [v2.executor, true] }) }] : []),
    ...(input.venues.includes('lista') ? [{ to: v2.moolah, value: '0' as const, data: encodeFunctionData({ abi: LENDING_ABI, functionName: 'setAuthorization', args: [v2.executor, true] }) }] : []),
    { to: v2.registry, value: '0', data: encodeFunctionData({ abi: V2_REGISTRY_ABI, functionName: 'setStrategyPolicy', args: [input.maxDebtUsdRaw, input.rewardRecipient, true] }) },
    ...[...new Set(input.collaterals.map(c => c.toLowerCase() as Address))].map(approve),
    ...[...new Set([...(input.loanTokens ?? []), ...(input.rewardTokens ?? [])].map(c => c.toLowerCase() as Address))].map(approve),
  ];
}
/**
 * My mix weight change (spec §4 "consent is pinned to the strategy id"): the change enrolls the account into a new private
 * strategy, which voids the policy. The same owner UserOp re-consents right after `enroll`: only `setStrategyPolicy` is
 * needed again (delegations and approvals are not tied to the enrollment), plus approvals for collateral the new weights add.
 */
export function v2ReconsentCalls(v2: StrategyEarnV2, input: { maxDebtUsdRaw: bigint; rewardRecipient: Address; newCollaterals?: readonly Address[] }): Call[] {
  if (input.maxDebtUsdRaw <= 0n) throw new Error('consent needs a debt ceiling');
  return [
    { to: v2.registry, value: '0', data: encodeFunctionData({ abi: V2_REGISTRY_ABI, functionName: 'setStrategyPolicy', args: [input.maxDebtUsdRaw, input.rewardRecipient, true] }) },
    ...[...new Set((input.newCollaterals ?? []).map(c => c.toLowerCase() as Address))].map((token): Call => ({ to: token, value: '0', data: encodeFunctionData({ abi: TOKEN_ABI, functionName: 'approve', args: [v2.executor, maxUint256] }) })),
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
  /** Collateral posted on the open route (raw). */
  postedRaw?: bigint;
  /** This route's attributed debt (lens `routeDebt`, loan raw), when a position is open. */
  routeDebtRaw?: bigint;
  /** What the strategy box holds for this route's loan token: its vault holding, and loan token sitting directly in the
   * box (lens `idleOf`: spec §5 — used first by the next repayment, paid out with a release; part of the net value). */
  vaultAssetsRaw?: bigint; idleRaw?: bigint;
  /** The account's own balance of the loan token that may be used to finish a repayment (raw). */
  cashRaw?: bigint;
  /** lens `minDebt(routeId)` of the open route: the least a partial repayment may leave (Moolah minLoan × 1.01; 0 on Venus). */
  minDebtRaw?: bigint;
};
/** Venue minimums of a route (lens `minLoan` / `minDebt`, loan raw). */
export type RouteLimits = { minLoanRaw: bigint; minDebtRaw: bigint };
export type StepReason = Decision['reason'] | 'small_position';
export type Step = {
  symbol: string; action: Decision['action']; reason: StepReason;
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
 * Spec §5 "small positions": a Lista debt at or below `minDebt` can only be repaid in full, and a stranger's
 * `executeDeleverage` (box money only) repays nothing of it when the box holds less than the debt. Such a position is the
 * backend's to settle: close it with the account's own loan token for the gap.
 */
export const strandedSmallPosition = (p: PositionState): boolean =>
  (p.minDebtRaw ?? 0n) > 0n && (p.routeDebtRaw ?? 0n) > 0n && p.routeDebtRaw! <= p.minDebtRaw! && (p.vaultAssetsRaw ?? 0n) + (p.idleRaw ?? 0n) < p.routeDebtRaw!;

/**
 * Engine decisions for one account -> v2 calls. Order: exits and reductions first (they free ceiling and never add risk),
 * then moves, then opens. `policyMaxDebtUsdRaw`: the owner's ceiling; opens and top-ups are capped to what is left under
 * it rather than sent to revert with DebtAboveConsent. `limits`: each route's venue minimums as read from the lens.
 * Only the health line sends an `executeDeleverage` (draft4: it is the contract's one trigger); a vault above its
 * utilization line, negative carry and the like are the account's own moves (session key).
 */
export function planExecution(input: { v2: StrategyEarnV2; account: Address; decisions: readonly Decision[]; positions: readonly PositionState[];
  deadline: bigint; policyMaxDebtUsdRaw: bigint; principalUsdRaw: bigint; limits?: (routeId: Hex) => RouteLimits | undefined }): ExecutionPlan {
  const { v2, account, deadline } = input;
  const state = new Map(input.positions.map(p => [p.symbol, p]));
  const order = { close: 0, reduce: 1, migrate: 2, open: 3, hold: 4 } as const;
  const steps: Step[] = [];
  let principal = input.principalUsdRaw, consentShort = false, plannedDebtUsd = 0;
  const idsOf = (p: PositionState, r: RouteKey) => routeIds(v2, p.collateral, r);
  const minLoanOf = (r: RouteKey, routeId: Hex) => input.limits?.(routeId)?.minLoanRaw ?? (r.venue === 'lista' ? usdRaw(LISTA_MIN_LOAN_USD) : 0n);
  for (const d of [...input.decisions].sort((a, b) => order[a.action] - order[b.action])) {
    const base = { symbol: d.symbol, action: d.action, reason: d.reason as StepReason, rationale: d.rationale };
    const p = state.get(d.symbol);
    if (d.action !== 'close') plannedDebtUsd += d.targetDebtUsd;
    // A debt nobody else can repay (see strandedSmallPosition) is closed now, whatever the engine thought of the route —
    // unless this round already closes it, tops it up above the minimum or moves it whole.
    if (p && d.from && strandedSmallPosition(p) && (d.action === 'hold' || d.action === 'reduce')) {
      const from = idsOf(p, d.from), gap = p.routeDebtRaw! - (p.vaultAssetsRaw ?? 0n) - (p.idleRaw ?? 0n);
      const why = `${d.symbol} close ${d.from.venue}/${d.from.loan}: debt ${p.routeDebtRaw} at or under the venue minimum ${p.minDebtRaw} with only ${(p.vaultAssetsRaw ?? 0n) + (p.idleRaw ?? 0n)} in the box — nobody else can repay it`;
      // 0.1% over the gap for the interest of the next blocks.
      if ((p.cashRaw ?? 0n) < gap + gap / 1_000n + 1n) steps.push({ ...base, action: 'close', reason: 'small_position', via: 'session', calls: [], skipped: `needs ${gap} more ${d.from.loan} in the account`, rationale: why });
      else { principal -= p.routeDebtRaw!; steps.push({ ...base, action: 'close', reason: 'small_position', via: 'session', calls: [v2Calls.close(v2, account, from.routeId, from.vaultId, p.cashRaw ?? 0n, deadline)], rationale: why }); }
      continue;
    }
    if (d.action === 'hold') continue;
    if (!p) { steps.push({ ...base, via: 'session', calls: [], skipped: 'no position state' }); continue; }
    try {
      if (d.action === 'close') {
        const from = idsOf(p, d.from!);
        principal -= p.routeDebtRaw ?? 0n;
        steps.push({ ...base, via: 'session', calls: [closeCall(v2, account, from, p, deadline)] });
      } else if (d.action === 'reduce') {
        const from = idsOf(p, d.from!);
        if (d.reason === 'safety_line') { steps.push({ ...base, via: 'keeper', calls: [v2Calls.deleverage(v2, account, from.routeId, from.vaultId)] }); continue; }
        const debt = p.routeDebtRaw ?? 0n, target = usdRaw(d.targetDebtUsd);
        // A partial repayment may not leave less than the venue's minimum (lens minDebt) — repay everything instead.
        const floor = p.minDebtRaw ?? (d.from!.venue === 'lista' ? usdRaw(LISTA_MIN_LOAN_USD) : 0n);
        const all = target === 0n || target < floor;
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
        // Moolah refuses a loan under its minimum (lens minLoan, about 15 USD on mainnet): do not send an open that would leave less.
        if (borrow > 0n && debt + borrow < minLoanOf(d.to!, to.routeId)) { steps.push({ ...base, via: 'session', calls: [], skipped: 'below the Lista minimum loan' }); continue; }
        if (borrow === 0n && p.freeCollateralRaw === 0n) { steps.push({ ...base, via: 'session', calls: [], skipped: consentShort ? 'debt ceiling reached' : 'nothing to post or borrow' }); continue; }
        principal += borrow;
        // Only posting collateral: no vault is touched (spec §5: vaultId 0).
        steps.push({ ...base, via: 'session', calls: [v2Calls.open(v2, account, to.routeId, borrow === 0n ? ZERO32 : to.vaultId, p.freeCollateralRaw, borrow, deadline)] });
      }
    } catch (error) { steps.push({ ...base, via: 'session', calls: [], skipped: String((error as Error).message) }); }
  }
  return { steps, plannedDebtUsd, consentShort };
}
/** Close one route: repay all of it and take all its collateral back; with no debt left, only the collateral comes back. */
function closeCall(v2: StrategyEarnV2, account: Address, ids: { routeId: Hex; vaultId: Hex }, p: Pick<PositionState, 'routeDebtRaw' | 'cashRaw'>, deadline: bigint): Call {
  return p.routeDebtRaw === 0n ? v2Calls.reduce(v2, account, ids.routeId, ZERO32, 0n, maxUint256, 0n, deadline) : v2Calls.close(v2, account, ids.routeId, ids.vaultId, p.cashRaw ?? 0n, deadline);
}

// ---------------------------------------------------------------------------
// UserOp sizing
// ---------------------------------------------------------------------------
/** A session-key (or owner) UserOp carries at most this many executor calls (one per market). */
export const V2_CALLS_PER_USER_OP = 3;
/**
 * Estimated call gas one UserOp may add up to. The sender doubles the estimate and a UserOp is capped at 14M
 * (MAX_USER_OP_GAS), so the estimates of one UserOp stay under 6M. A transaction that touches a Lista vault walks its whole
 * withdraw queue (mainnet fork: 2.4M–6.7M each), so such calls end up alone; chain-97 mock vaults are light.
 */
export const V2_USER_OP_ESTIMATE_GAS = 6_000_000n;
/**
 * Cut calls into UserOps in order: at most V2_CALLS_PER_USER_OP per UserOp and V2_USER_OP_ESTIMATE_GAS of estimated gas.
 * A call whose gas is unknown (null) goes alone. Every prefix is a state the executor accepts on its own, so stopping
 * between two UserOps leaves nothing half-done.
 */
export function v2Batches<T>(items: readonly T[], gasOf: (item: T) => bigint | null = () => 0n): T[][] {
  const out: T[][] = []; let used = 0n, alone = false;
  for (const item of items) {
    const gas = gasOf(item), last = out[out.length - 1];
    if (!last || alone || gas === null || last.length >= V2_CALLS_PER_USER_OP || used + gas > V2_USER_OP_ESTIMATE_GAS) { out.push([item]); used = gas ?? 0n; alone = gas === null; }
    else { last.push(item); used += gas; }
  }
  return out;
}

/** One open route as the exit planner needs it. */
export type ExitRoute = { routeId: Hex; vaultId: Hex; routeDebtRaw?: bigint; cashRaw?: bigint };
/**
 * Turn the strategy off / sell everything / delete (owner-signed): close every route, release every vault the box still
 * holds, optionally send the reward tokens on (box + what the account holds, to the owner's `rewardRecipient`), withdraw
 * consent. Venus routes close one after another: each repays its own share of the shared debt, the last one clears it
 * (spec §5). Rewards leave only on a full exit (sell all / withdraw / delete): turning the strategy off keeps them in the
 * portfolio account, so `rewards` is empty then.
 */
export function v2ExitCalls(v2: StrategyEarnV2, account: Address, input: { routes: readonly ExitRoute[]; leftoverVaults?: readonly Hex[];
  rewards?: readonly { token: Address; accountAmountRaw: bigint }[]; deadline: bigint; withdrawConsent: boolean }): Call[] {
  return [
    ...input.routes.map(r => closeCall(v2, account, r, r, input.deadline)),
    ...(input.leftoverVaults ?? []).map(vaultId => v2Calls.release(v2, account, vaultId, input.deadline)),
    ...(input.rewards ?? []).map(r => v2Calls.sweepRewards(v2, account, r.token, r.accountAmountRaw, input.deadline)),
    ...(input.withdrawConsent ? [v2ConsentOffCall(v2)] : []),
  ];
}
/**
 * The same exit cut into UserOps (v2Batches). `gasOf`: the estimated gas of each executor call, when the caller read it.
 * Consent is withdrawn in the last UserOp, so whatever landed before a failure is still covered by consent-free exits
 * (reduce / release / sweep never need consent) and a retry closes only what is left.
 */
export function v2ExitBatches(v2: StrategyEarnV2, account: Address, input: Parameters<typeof v2ExitCalls>[2], gasOf?: (call: Call) => bigint | null): Call[][] {
  const batches = v2Batches(v2ExitCalls(v2, account, { ...input, withdrawConsent: false }), gasOf);
  if (input.withdrawConsent) { if (batches.length === 0) batches.push([]); batches[batches.length - 1]!.push(v2ConsentOffCall(v2)); }
  return batches;
}

/** One posted asset the sale needs back. */
export type PreSellPosition = PositionState & { routeId: Hex; vaultId: Hex; venue: 'venus' | 'lista'; loan: string };
/**
 * Before a sale (session key): for each asset being sold whose free balance is short, repay its route and take the shares
 * back. Box money for the loan token (vault + idle) plus the account's own loan token covers the debt -> close. Short ->
 * repay what the box and the cash can, and take back only the same share of the collateral, 2% less (spec §5: collateral
 * may leave when debt ÷ budget does not rise and health does not fall); the sale of that part pays the rest next round.
 * A Lista partial repayment is cut so that `minDebt` stays (the contract would cut it the same way).
 */
export function v2PreSellPlan(v2: StrategyEarnV2, account: Address, positions: readonly PreSellPosition[], deadline: bigint): { calls: Call[]; notes: string[] } {
  const calls: Call[] = [], notes: string[] = [];
  // Routes that share a loan token share the box's money for it: what an earlier close in this plan uses is gone.
  const boxLeft = new Map<string, bigint>(), cashLeft = new Map<string, bigint>();
  for (const p of positions) {
    const debt = p.routeDebtRaw ?? 0n, posted = p.postedRaw ?? 0n;
    if (posted === 0n) continue;
    if (debt === 0n) { calls.push(v2Calls.reduce(v2, account, p.routeId, ZERO32, 0n, maxUint256, 0n, deadline)); notes.push(`${p.symbol} take back`); continue; }
    const box = boxLeft.get(p.loan) ?? (p.vaultAssetsRaw ?? 0n) + (p.idleRaw ?? 0n), cash = cashLeft.get(p.loan) ?? p.cashRaw ?? 0n;
    // 0.1% over the debt for the interest of the next blocks.
    const need = debt + debt / 1_000n + 1n;
    if (box + cash >= need) {
      calls.push(v2Calls.close(v2, account, p.routeId, p.vaultId, cash, deadline));
      boxLeft.set(p.loan, box > need ? box - need : 0n); cashLeft.set(p.loan, box >= need ? cash : cash - (need - box));
      notes.push(`${p.symbol} repay ${debt} ${p.loan}, take back`);
      continue;
    }
    const floor = p.minDebtRaw ?? 0n;
    let pay = box + cash > 1n ? box + cash - 1n : 0n;
    if (debt - pay < floor) pay = debt > floor ? debt - floor : 0n;
    const take = pay === 0n ? 0n : posted * pay / debt * 9_800n / 10_000n;
    if (pay === 0n || take === 0n) { notes.push(`${p.symbol} cannot be freed: the box and the account hold ${box + cash} ${p.loan} against a debt of ${debt}`); continue; }
    calls.push(v2Calls.reduce(v2, account, p.routeId, p.vaultId, pay, take, cash, deadline));
    boxLeft.set(p.loan, 0n); cashLeft.set(p.loan, 0n);
    notes.push(`${p.symbol} short of ${p.loan}: repay ${pay}, take back ${take} of ${posted}; the sale pays the rest`);
  }
  return { calls, notes };
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
 *   `executeRescue` (owner only by policy, interface `rescueIsOwnerOnlyByPolicy`) is sponsored only when the UserOp is
 *   signed by the account's root validator (`ctx.rootSigned`, read off the Kernel nonce), never for a session key.
 * - registry: only setStrategyPolicy; enabling needs a ceiling; the reward recipient is the owner, the account or zero.
 * - Venus / Moolah: only the delegation to (or away from) the v2 executor.
 * - approve(v2 executor): only for a portfolio asset, an allowlisted loan token or a reward token.
 */
export function v2SponsoredCall(v2: StrategyEarnV2, call: { target: Address; callData: Hex }, ctx: { sender: Address; owner?: Address; assets: readonly Address[]; rootSigned?: boolean }): V2CallKind | null {
  const is = (a: Address) => isAddressEqual(call.target, a);
  if (is(v2.executor)) {
    const inner = decodeFunctionData({ abi: V2_EXECUTOR_ABI, data: call.callData });
    const args = inner.args as readonly unknown[];
    if (inner.functionName === 'executeRescue') {
      if (ctx.rootSigned !== true) throw new Error('v2 rescue is owner only');
      if (!isAddressEqual(args[0] as Address, ctx.sender)) throw new Error('v2 call for another account');
      if (args[2] === 0n) throw new Error('v2 call without a deadline');
      if (!canonical(V2_EXECUTOR_ABI, 'executeRescue', args, call.callData)) throw new Error('noncanonical v2 call');
      return 'settle';
    }
    if (!(SESSION_FUNCTIONS as readonly string[]).includes(inner.functionName)) throw new Error('invalid v2 executor call');
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

/**
 * Is this UserOp signed by the account's root validator (the owner)? Kernel v3 packs the validator into the nonce key:
 * [mode 1 byte][type 1 byte][validator id 20 bytes][parallel key 2 bytes] ++ [sequence 8 bytes]. Type 0x00 is the root
 * (sudo) validator — the account then validates with its `rootValidator`, whatever the id bytes say — and a session key
 * signs with type 0x02 (permission). Mode 0x01 (enable) installs a validator on the fly, so only mode 0x00 with type 0x00
 * counts as an owner signature here.
 */
export const isRootSignedNonce = (nonce: bigint): boolean => nonce >= 0n && nonce >> 240n === 0n;

// ---------------------------------------------------------------------------
// Session-key scope
// ---------------------------------------------------------------------------
export const V2_SESSION_SELECTORS: readonly Hex[] = SESSION_FUNCTIONS.map(name => toFunctionSelector(V2_EXECUTOR_ABI.find(f => f.type === 'function' && f.name === name)!));
/**
 * What a session key may call for routing v2: the six account functions on the v2 executor only, argument 0 pinned to this
 * account. No market list (the registry allowlists routes and vaults, so new markets need no renewal), never
 * setStrategyPolicy, a lending delegation, any approve, or `executeRescue` (owner only: it turns the box's receipts into
 * ordinary account holdings). Appended after every v1 permission so older keys rebuild unchanged.
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
 * Lista reward message. Spec draft2 §9: `signature = abi.encode(bytes message, bytes accountSignature)`; the box checks
 * that `message` ends with the registry's `rewardProofSuffix` (at most 64 bytes before it), that `hash` is its EIP-191
 * hash, and that the account itself validates `accountSignature` for that hash. Verified on BSC mainnet (2026-11-24) with a
 * real Kernel v3.3 account and StrategyBox: Lista calls `isValidSignature(bytes32,bytes)` with the EIP-191 hash and accepts
 * this wrapper for both proof endpoints (`type=safe` required).
 */
export const boxRewardSignature = (message: string, accountSignature: Hex): Hex =>
  encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], [stringToHex(message), accountSignature]);

// ---------------------------------------------------------------------------
// Scheduler step: one account, one round (auto-open after a fill, top-up, migrate, reduce, close, deleverage)
// ---------------------------------------------------------------------------

/** One eligible asset of the account as read from the chain (bulk read on the public node; never the paid RPC). */
export type V2Holding = PositionState & {
  /** USD value of everything held (posted + free). */
  collateralUsd: number;
  /** The open position's route, debt in USD and when it entered this route (registry `openedAt`, or the box's `vaultSince` when later). */
  position: null | { route: RouteKey; debtUsd: number; since: number; ltvBps?: number; deleverageLtvBps?: number; shouldDeleverage?: boolean; postedUsd?: number };
};
export type V2AccountState = { enabled: boolean; policyMaxDebtUsdRaw: bigint; principalUsdRaw: bigint; holdings: readonly V2Holding[];
  /** The account still has a v1 (AtpBorrowExecutor) Venus position. v2 treats the account's whole Venus debt and vTokens as its
   * own, so the two must never coexist: while this is true v2 neither opens nor moves anything onto Venus for this account. */
  hasV1Venus?: boolean;
  /**
   * Loan tokens the account owes on Venus without a v2 Venus position in that token (draft5 `ForeignDebt`: the registry
   * refuses to open a Venus route in such a token; a v2 position whose principal is repaid and only interest is left is
   * NOT foreign). The engine is not offered Venus routes in these tokens.
   */
  foreignVenusLoans?: readonly Stable[] };
export type V2Tx = { hash: Hex };
export type V2RoundArgs = { v2: StrategyEarnV2; portfolioId: number; account: Address; snapshot: RoutingSnapshot; state: V2AccountState; costs: Costs; now: number; deadline: bigint;
  liquidity?: Liquidity; dryRun: boolean; log: (line: string) => void;
  /** Each route's venue minimums (lens `minLoan` / `minDebt`). */
  limits?: (routeId: Hex) => RouteLimits | undefined;
  /** One UserOp through the account with its session key. */
  send: (calls: Call[]) => Promise<V2Tx>;
  /** Anyone-callable transaction from the operator (executeDeleverage). Absent: left for the next keeper round. */
  keeper?: (call: Call) => Promise<V2Tx>;
  /** Called after each confirmed transaction with the step that caused it (ledger, activity). */
  record?: (step: Step, tx: V2Tx) => Promise<void> };
export type V2RoundResult = { decisions: number; sent: number; failed: number; skipped: number; consentShort: boolean;
  /** The engine's decisions, for callers that report them. */
  plan?: ExecutionPlan };
const firstLine = (error: unknown) => String((error as Error)?.message ?? error).split('\n')[0]!.slice(0, 140);
/**
 * Decide (routing engine) and execute for one account. Every decision is logged as one line with its rationale, whether or
 * not it leads to a transaction. Plain steps (close, repay, open, vault switch) are sent up to V2_CALLS_PER_USER_OP per
 * UserOp; a UserOp that fails is retried one step at a time. A step that still fails is logged and left for the next round;
 * an atomic migrate that reverts falls back to close-then-open, and stops after the close if the open fails (the asset is
 * then simply not borrowing).
 */
export async function runV2Account(a: V2RoundArgs): Promise<V2RoundResult> {
  const holdings: Holding[] = a.state.holdings.map(h => ({ symbol: h.symbol, collateralUsd: h.collateralUsd, enabled: a.state.enabled, position: h.position }));
  const foreign = a.state.foreignVenusLoans ?? [];
  const snapshot = a.state.hasV1Venus || foreign.length > 0 ? { ...a.snapshot, options: Object.fromEntries(Object.entries(a.snapshot.options).map(([k, v]) =>
    [k, v.filter(o => o.venue !== 'venus' || !a.state.hasV1Venus && !foreign.includes(o.loan))])) } : a.snapshot;
  const engine = planAccount({ snapshot, holdings, costs: a.costs, now: a.now, ...(a.liquidity ? { liquidity: a.liquidity } : {}) });
  const execution = planExecution({ v2: a.v2, account: a.account, decisions: engine.decisions, positions: a.state.holdings, deadline: a.deadline,
    policyMaxDebtUsdRaw: a.state.policyMaxDebtUsdRaw, principalUsdRaw: a.state.principalUsdRaw, ...(a.limits ? { limits: a.limits } : {}) });
  const result: V2RoundResult = { decisions: engine.decisions.length, sent: 0, failed: 0, skipped: 0, consentShort: execution.consentShort, plan: execution };
  const tag = `[strategy-routing] portfolio ${a.portfolioId}:`;
  for (const d of engine.decisions) if (d.action === 'hold' && !execution.steps.some(s => s.symbol === d.symbol)) a.log(`${tag} ${d.rationale}`);
  const sendable: Step[] = [];
  for (const step of execution.steps) {
    if (step.calls.length === 0) { result.skipped++; a.log(`${tag} ${step.rationale} — not sent: ${step.skipped}`); continue; }
    if (a.dryRun) { result.skipped++; a.log(`${tag} ${step.rationale} — dry run`); continue; }
    if (step.via === 'keeper' && !a.keeper) { result.skipped++; a.log(`${tag} ${step.rationale} — left for the keeper`); continue; }
    sendable.push(step);
  }
  const one = async (step: Step, calls: Call[]) => { const tx = step.via === 'keeper' ? await a.keeper!(v2KeeperCall(a.v2, calls[0]!)) : await a.send(calls); await a.record?.(step, tx); return tx; };
  const single = async (step: Step) => {
    try {
      const tx = await one(step, step.calls);
      result.sent++; a.log(`${tag} ${step.rationale} — tx ${tx.hash}`);
    } catch (error) {
      if (!step.fallback) { result.failed++; a.log(`${tag} ${step.rationale} — failed, next round retries: ${firstLine(error)}`); return; }
      a.log(`${tag} ${step.rationale} — atomic move reverted (${firstLine(error)}); closing then reopening`);
      try {
        for (const batch of step.fallback) { const tx = await one(step, batch); result.sent++; a.log(`${tag} ${step.symbol} two-step — tx ${tx.hash}`); }
      } catch (inner) { result.failed++; a.log(`${tag} ${step.symbol} two-step not finished, next round retries: ${firstLine(inner)}`); }
    }
  };
  // Steps keep their order (exits, moves, opens). Consecutive plain session steps share a UserOp; a keeper step or a move
  // with a two-step fallback is always its own transaction.
  const plain = (s: Step) => s.via === 'session' && !s.fallback;
  let i = 0;
  while (i < sendable.length) {
    const step = sendable[i]!;
    if (!plain(step)) { await single(step); i++; continue; }
    const group: Step[] = [];
    while (i < sendable.length && plain(sendable[i]!) && group.length < V2_CALLS_PER_USER_OP) group.push(sendable[i++]!);
    if (group.length === 1) { await single(group[0]!); continue; }
    try {
      const tx = await a.send(group.flatMap(s => s.calls));
      for (const s of group) { await a.record?.(s, tx); result.sent++; a.log(`${tag} ${s.rationale} — tx ${tx.hash}`); }
    } catch (error) {
      a.log(`${tag} ${group.map(s => s.symbol).join(', ')} in one UserOp did not go through (${firstLine(error)}); sending one at a time`);
      for (const s of group) await single(s);
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
