import { sponsoredRewardTokens } from './strategy-rewards.js';
import { strategyEarnV2, v2SponsoredCall } from './strategy-earn-v2.js';
import type { StrategyEarnV2 } from './strategy-earn-v2.js';
import { verifyEnrollmentSponsorship } from './enrollment-sponsorship.js';
import { verifyMixOwnerCalls } from './mix-chain.js';
import { MIX_COLUMNS, pendingMixSql, withMixLock, checkMixLock, mixBusy } from './mix-store.js';
import type { MixRow, MixIntent } from './mix-store.js';
import {
  concatHex, createPublicClient, decodeAbiParameters, decodeFunctionData, encodeAbiParameters,
  encodeFunctionData, http, isAddressEqual, keccak256, pad, parseAbi, parseAbiItem, slice, toHex, toFunctionSelector, zeroAddress,
} from 'viem';
import { KernelV3_3AccountAbi } from '@zerodev/sdk';
import { PolicyFlags } from '@zerodev/permissions';
import { CallPolicyVersion, toCallPolicy, toGasPolicy, toPolicyId, toTimestampPolicy } from '@zerodev/permissions/policies';
import { toEmptyECDSASigner, toSignerId } from '@zerodev/permissions/signers';
import type { Address, Hex, PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { GetPaymasterDataParameters, PaymasterActions } from 'viem/account-abstraction';
import { entryPoint07Abi } from 'viem/account-abstraction';
import { EXECUTOR_ABI, REGISTRY_ABI, REGISTRY_VERSION_ABI } from './chain.js';
import { KERNEL_V3_3_ADDRESSES } from './addresses.js';
import { loadPaymasterConfig, loadTradingConfig } from './config.js';
import type { PaymasterConfig, TradingConfig } from './config.js';
import type { PoolClient } from 'pg';
import { query, withTransaction } from './db.js';
import { AppError } from './errors.js';
import { TESTNET_97, testnetAssets } from './testnet-profile.js';
import { SESSION_GAS_ALLOWED_WEI, sessionCallPermissions } from './permissions.js';
import { YIELD_REGISTRY_ABI } from './yield-abi.js';
import { BORROW_CALL_ABI, isStrategyMarketId, isStrategyVault, STRATEGY_EARN_97 } from './strategy-earn-guard.js';
import { MAX_USER_OP_GAS } from './execution-batch.js';
import { applyExpiredExitProofs, expiredExitProofs, rememberExitFacts, unusedExitUsage } from './paymaster-exit-reconciliation.js';
import type { ExpiredExitProof } from './paymaster-exit-reconciliation.js';
export { reconcileExpiredExitAuthorizations } from './paymaster-exit-reconciliation.js';
import { fresh } from './yield-domain.js';
import { dcaVaultCall, dcaVaults, isDcaSpender } from './dca-calls.js';
import { writeYieldState } from './yield-runtime-state.js';
import { reservedCash } from './withdrawable-cash.js';
import { NODE_LAG_BUDGET_MS } from './node-lag.js';
import { rpcTransport } from './rpc-transport.js';
import { resumePausedJobsForAccount } from './strategy-job-recovery.js';

export type PackedSponsorOperation = {
  sender: Address; nonce: bigint; initCode: Hex; callData: Hex; accountGasLimits: Hex;
  preVerificationGas: bigint; gasFees: Hex; paymasterAndData: Hex; signature: Hex;
};
export type Reservation = {
  hash: Hex; op: PackedSponsorOperation; config: PaymasterConfig; validUntil: number;
  verificationGas: bigint; callGas: bigint; maxFee: bigint; gasLimit: bigint; maxCostWei: bigint;
  budget: GasBudgetRequest;
  now?: () => number;
  /** Internal canonical EntryPoint consumption evidence; never accepted from request JSON. */
  consumedAuthorizations?: readonly ConsumedAuthorization[];
  expiredAuthorizations?: readonly ExpiredExitProof[];
  /** HTTP ordinary sponsorship only; never an automatic scheduler/journal retry. */
  ordinaryGasRetry?: boolean;
  /** HTTP setup only; proof is revalidated under the account lock before settlement. */
  setupGasRetry?: boolean;
  setupRetryProof?: SetupRetryProof | null;
};
export type ConsumedAuthorization = { userOpHash:Hex; executionKey:string; success:boolean };
export type GasPurpose = 'ordinary' | 'setup' | 'exit';
export type GasBudgetRequest = {
  executionKey: string; chainId: number; account: Address; purpose: GasPurpose;
  /** nativePrice / 10^priceDecimals is USD per BNB; omitted decimals means E8. */
  gasLimit: bigint; maxFeePerGas: bigint; nativePrice: bigint; priceDecimals?: number; priceSource: string;
};
export type BudgetContext = Pick<GasBudgetRequest, 'purpose' | 'nativePrice' | 'priceDecimals' | 'priceSource'>;
/** The DB's pinned reservation day controls backoff, including transactions spanning midnight. */
export class GasBudgetExceededError extends AppError {
  readonly resetAt: string;
  constructor(day: string) {
    super(429, 'GAS_BUDGET_EXCEEDED', 'ordinary gas budget exceeded');
    this.resetAt = new Date(new Date(`${day}T00:00:00.000Z`).getTime() + 86400000).toISOString();
  }
}
export class PaymasterRetryTooSoonError extends AppError {
  readonly retryAt: string;
  constructor(validUntil: number) {
    super(409, 'PAYMASTER_RETRY_TOO_SOON', 'setup authorization is still pending; retry after its expiry');
    this.retryAt = new Date((validUntil + 1) * 1000).toISOString();
  }
}
type Query = (sql: string, params?: readonly unknown[]) => Promise<{ rows: unknown[] }>;
export type PaymasterDeps = {
  /** Reward tokens an owner may send to their wallet. Default: sponsoredRewardTokens(chainId) (mainnet, behind STRATEGY_REWARDS_ENABLED). */
  rewardTokens?: readonly Address[];
  /** Routing v2 deployment whose calls may be sponsored. Default: strategyEarnV2(chainId) (null until v2 is deployed and configured). */
  strategyV2?: StrategyEarnV2 | null;
  mixSetup?: typeof verifyMixOwnerCalls;
  mixLock?: typeof withMixLock;
  config?: PaymasterConfig | null;
  enrollmentSetup?: typeof verifyEnrollmentSponsorship;
  now?: () => number;
  query?: Query;
  checkChain?: (op: PackedSponsorOperation, config: PaymasterConfig) => Promise<void>;
  reserve?: (request: Reservation) => Promise<number | void>;
  readBudgetContext?: (op: PackedSponsorOperation, config: PaymasterConfig) => Promise<BudgetContext>;
  verifyYieldWithdraw?: (op: PackedSponsorOperation, config: PaymasterConfig, now: number, query: Query) => Promise<readonly ConsumedAuthorization[]>;
  /** Internal scheduler evidence, bound to the exact canonical Kernel calldata. Never request input. */
  exitCallData?: Hex;
  /** Public chain-97 ordinary requests may reserve up to three distinct gas estimates per nonce. */
  retryOrdinaryGas?: boolean;
  /** Public chain-97 setup retries require expired, unused authorization evidence. */
  retrySetup?: boolean;
  /** Extra time for a first join's lagging-node wait (default NODE_LAG_BUDGET_MS). */
  enrollmentLagMs?: number;
  /** Tests: the account's USDT balance (withdraw-to-wallet free cash check). */
  readCash?: (account: Address, config: PaymasterConfig) => Promise<bigint>;
  /** Tests: owner-withdrawal reset of paused strategy jobs. */
  resumePausedJobsForAccount?: (chainId: number, account: string) => Promise<number>;
};
export const KERNEL_EXECUTE_ABI = parseAbi(['function execute(bytes32 execMode,bytes executionCalldata) payable']);
const TOKEN_ABI = parseAbi(['function approve(address spender,uint256 amount)', 'function transfer(address recipient,uint256 amount)']);
const BYTES_ARRAY_ABI = [{ type: 'bytes[]' }] as const;
const META_FACTORY_ABI = parseAbi(['function deployWithFactory(address factory,bytes createData,bytes32 salt) returns(address)']);
const BATCH_ABI = [{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'callData', type: 'bytes' }] }] as const;
const EXECUTE_USER_OP_SELECTOR = toFunctionSelector('executeUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32)');
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const PM_ABI = parseAbi(['function verifyingSigner() view returns(address)', 'function entryPoint() view returns(address)']);
const ENTRY_POINT_ABI = parseAbi(['function balanceOf(address account) view returns(uint256)']);
const MAX_UINT256 = (1n << 256n) - 1n;
const MASK_128 = (1n << 128n) - 1n;

/** Our own checks throw plain Errors with a fixed label; library errors are reduced to their class name (no data). */
const checkName = (error: unknown) => error instanceof Error ? (error.name === 'Error' ? error.message.slice(0, 120) : error.name) : 'invalid';
/** `reason` is an internal check label (never request bytes, signatures or keys): logged, not returned. */
function rejected(code: string, status = 400, reason?: string): AppError {
  return new AppError(status, code, 'paymaster sponsorship rejected: ' + code, reason === undefined ? undefined : { cause: new Error(reason) });
}
/**
 * Largest canonical Kernel batch we sponsor. A buy that turns Strategy Earn on carries the buy calls, a two-call
 * session-key renewal and `consentCalls` (two delegates, ceiling + approval per market, two approvals), so the
 * bound follows the market list instead of a fixed 32 that a many-asset fund exceeds.
 */
export const MAX_SPONSORED_CALLS = 16 + 2 + 4 + 2 * STRATEGY_EARN_97.markets.length;
function hex(value: unknown, bytes?: number): Hex {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value) || (bytes !== undefined && value.length !== 2 + bytes * 2)) {
    throw rejected('PAYMASTER_INVALID_OPERATION');
  }
  return value.toLowerCase() as Hex;
}
function uint(value: unknown): bigint {
  if (typeof value !== 'bigint' && (typeof value !== 'string' || !/^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(value))) throw rejected('PAYMASTER_INVALID_OPERATION');
  const result = BigInt(value);
  if (result < 0n || result > MAX_UINT256) throw rejected('PAYMASTER_INVALID_OPERATION');
  return result;
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw rejected('PAYMASTER_INVALID_OPERATION');
  return value as Record<string, unknown>;
}
export function parsePackedSponsorOperation(value: unknown): PackedSponsorOperation {
  const op = object(value);
  const keys = ['sender', 'nonce', 'initCode', 'callData', 'accountGasLimits', 'preVerificationGas', 'gasFees', 'paymasterAndData', 'signature'];
  if (Object.keys(op).some((key) => !keys.includes(key))) throw rejected('PAYMASTER_INVALID_OPERATION');
  return { sender: hex(op.sender, 20), nonce: uint(op.nonce), initCode: hex(op.initCode), callData: hex(op.callData),
    accountGasLimits: hex(op.accountGasLimits, 32), preVerificationGas: uint(op.preVerificationGas), gasFees: hex(op.gasFees, 32),
    paymasterAndData: hex(op.paymasterAndData ?? '0x'), signature: hex(op.signature ?? '0x') };
}

/** Only canonical Kernel CALL / BATCH DEFAULT modes. Nested renewal delegation is checked separately. */
function sponsoredCalls(op: Pick<PackedSponsorOperation, 'callData'>) {
  try {
    const data = op.callData.startsWith(EXECUTE_USER_OP_SELECTOR) ? slice(op.callData, 4) : op.callData;
    const decoded = decodeFunctionData({ abi: KERNEL_EXECUTE_ABI, data });
    if (encodeFunctionData({ abi: KERNEL_EXECUTE_ABI, functionName: decoded.functionName, args: decoded.args }).toLowerCase() !== data.toLowerCase()) throw new Error('noncanonical');
    const [mode, payload] = decoded.args;
    const single = toHex(0n, { size: 32 });
    const batch = toHex(1n << 248n, { size: 32 });
    const calls = mode === single ? [{ target: slice(payload, 0, 20), value: BigInt(slice(payload, 20, 52)), callData: slice(payload, 52) }]
      : mode === batch ? decodeAbiParameters(BATCH_ABI, payload)[0] : [];
    if (calls.length === 0 || calls.length > MAX_SPONSORED_CALLS) throw new Error(calls.length === 0 ? 'empty/invalid mode' : `too many calls: ${calls.length}`);
    if (mode === batch && encodeAbiParameters(BATCH_ABI, [calls]).toLowerCase() !== payload.toLowerCase()) throw new Error('noncanonical batch');
    return calls;
  } catch (error) { throw rejected('PAYMASTER_CALL_FORBIDDEN', 403, `kernel batch: ${checkName(error)}`); }
}

/** Shared canonical decoder for persisted execution reconciliation. */
export function canonicalKernelCalls(callData: Hex) { return sponsoredCalls({ callData }); }

/** Match the SDK's complete two-call toInitConfig, never a general-purpose self-call or delegatecall. */
type RenewalScope = 'plain' | 'yield' | 'yield+borrow';
function validateRenewal(install: Hex, grant: Hex, c: PaymasterConfig, account: Address, scope: RenewalScope = 'plain', v2: StrategyEarnV2 | null = null): void {
  const decoded = decodeFunctionData({ abi: KernelV3_3AccountAbi, data: install });
  if (decoded.functionName !== 'installValidations') throw new Error('invalid install');
  const enableData = decoded.args[2][0];
  if (enableData === undefined) throw new Error('missing policies');
  const [parts] = decodeAbiParameters(BYTES_ARRAY_ABI, enableData);
  if (parts.length !== 4) throw new Error('invalid policies');
  const timestampData = parts[2];
  const signerData = parts[3];
  if (timestampData === undefined || signerData === undefined) throw new Error('missing policy data');
  const [validAfter, validUntil] = decodeAbiParameters([{ type: 'uint48' }, { type: 'uint48' }], slice(timestampData, 22));
  const signerAddress = slice(signerData, 22);
  if (validAfter !== 0 || validUntil === 0 || signerAddress.length !== 42 || isAddressEqual(signerAddress, zeroAddress)) throw new Error('invalid session');
  const p = TESTNET_97.contracts; // Canonical SDK policy/signer contracts, also pinned in the chain 97 profile.
  const policies = [
    // 'yield+borrow' is what GET /renewal-params installs on chain 97 since backend#204 (src/renewal.ts): yield and
    // Strategy Earn calls, argument 0 pinned to this account, current market list.
    toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, policyAddress: p.callPolicy, permissions: sessionCallPermissions(c.executor,
      scope === 'plain' ? undefined : account, scope === 'yield+borrow' ? account : undefined, undefined, v2 === null ? undefined : { executor: v2.executor, account }) }),
    toGasPolicy({ policyAddress: p.gasPolicy, allowed: SESSION_GAS_ALLOWED_WEI, enforcePaymaster: true, allowedPaymaster: c.address }),
    toTimestampPolicy({ policyAddress: p.timestampPolicy, validAfter, validUntil }),
  ];
  const signer = toEmptyECDSASigner(signerAddress, p.ecdsaSigner);
  const flag = PolicyFlags.FOR_ALL_VALIDATION;
  const expectedEnableData = encodeAbiParameters(BYTES_ARRAY_ABI, [[
    ...policies.map((policy) => concatHex([policy.getPolicyInfoInBytes(), policy.getPolicyData()])),
    concatHex([flag, signer.signerContractAddress, signer.getSignerData()]),
  ]]);
  const permissionId = slice(keccak256(encodeAbiParameters(BYTES_ARRAY_ABI, [[toPolicyId(policies), flag, toSignerId(signer)]])), 0, 4);
  const validationId = pad(concatHex(['0x02', permissionId]), { size: 21, dir: 'right' });
  const expectedInstall = encodeFunctionData({ abi: KernelV3_3AccountAbi, functionName: 'installValidations',
    args: [[validationId], [{ nonce: 1, hook: zeroAddress }], [expectedEnableData], ['0x']] });
  const grantData = encodeFunctionData({ abi: KernelV3_3AccountAbi, functionName: 'grantAccess',
    args: [validationId, toFunctionSelector(KERNEL_EXECUTE_ABI[0]), true] });
  const expectedGrant = encodeFunctionData({ abi: KERNEL_EXECUTE_ABI, functionName: 'execute',
    args: [toHex(255n << 248n, { size: 32 }), concatHex([KERNEL_V3_3_ADDRESSES.kernelImplV33, grantData])] });
  if (install.toLowerCase() !== expectedInstall.toLowerCase() || grant.toLowerCase() !== expectedGrant.toLowerCase()) throw new Error('noncanonical renewal');
}

/** Every session scope GET /renewal-params can install on this chain (chain 97: plain, yield, yield+borrow). */
function validateAnyRenewal(install: Hex, grant: Hex, c: PaymasterConfig, account: Address, v2: StrategyEarnV2 | null = null): void {
  const scopes: RenewalScope[] = c.chainId === 97 ? ['plain', 'yield', 'yield+borrow'] : ['plain'];
  // With a v2 deployment configured, /renewal-params installs today's scope plus the routing v2 calls (src/renewal.ts).
  // Keys without it stay valid, so both forms are accepted.
  const forms: [RenewalScope, StrategyEarnV2 | null][] = [...scopes.map((s): [RenewalScope, null] => [s, null]),
    ...(v2 === null ? [] : [[c.chainId === 97 ? 'yield+borrow' : 'plain', v2] as [RenewalScope, StrategyEarnV2]])];
  if (!forms.some(([scope, withV2]) => { try { validateRenewal(install, grant, c, account, scope, withV2); return true; } catch { return false; } })) {
    throw new Error('renewal matches no allowed session scope');
  }
}

/**
 * DCA (定投, db 0064) on a My mix account. These calls only move the account's own USDT into / out of a DCA vault
 * (or a period's redemption back into the account), never change the mix's enrollment, so they are not an owner
 * mix change. The exact rules (recipients, amounts, canonical encoding) stay in validateSponsoredCalls/dcaVaultCall.
 */
export type MixDcaCall = 'vault' | 'approval' | 'redeem' | null;
export function mixDcaCall(call: { target: Address; callData: Hex }, sender: Address, owner: Address | undefined, c: PaymasterConfig): MixDcaCall {
  if (c.chainId !== 97) return null;
  const vaults = dcaVaults();
  try { if (dcaVaultCall(call, sender, owner, vaults)) return 'vault'; } catch { return null; }
  if (call.callData.startsWith(toFunctionSelector('approve(address,uint256)'))) {
    try {
      const inner = decodeFunctionData({ abi: TOKEN_ABI, data: call.callData });
      if (inner.functionName !== 'approve') return null;
      const spender = inner.args[0];
      // USDT to a DCA vault spender (the deposit), or a DCA receipt to AtpExecutor (period redemptions).
      if (isDcaSpender(call.target, spender, vaults) ||
          vaults.some(v => isAddressEqual(v.receipt, call.target) && isAddressEqual(spender, c.executor))) return 'approval';
    } catch { return null; }
    return null;
  }
  if (isAddressEqual(call.target, c.executor) && call.callData.startsWith(toFunctionSelector('executeWithdraw(address,bytes32,uint256,uint256,uint256)'))) {
    try {
      const inner = decodeFunctionData({ abi: EXECUTOR_ABI, data: call.callData });
      if (inner.functionName === 'executeWithdraw' && isAddressEqual(inner.args[0], sender) && vaults.some(v => v.marketId === inner.args[1])) return 'redeem';
    } catch { return null; }
  }
  return null;
}

/**
 * Yield strategy (策略加息) on a My mix account: the same AtpBorrowExecutor calls a fund account sends — consent
 * (lending delegates, debt ceilings, approvals to AtpBorrowExecutor), open, close, and the scheduler's session-key
 * steps. They never change the mix's enrollment, so they are not an owner mix change; their exact rules (account,
 * market, spender, canonical encoding) stay in validateSponsoredCalls. 'risk' = adds collateral, borrowing or consent;
 * 'settle' = repays, takes shares back or withdraws consent.
 */
export type MixStrategyCall = 'risk' | 'settle' | null;
export function mixStrategyCall(call: { target: Address; callData: Hex }, c: PaymasterConfig, v2?: { v2: StrategyEarnV2; sender: Address; owner?: Address }): MixStrategyCall {
  if (c.chainId !== 97) return null;
  // Routing v2: same two classes. A v2 call that breaks a rule is not classified here; validateSponsoredCalls rejects it.
  if (v2) { try { const kind = v2SponsoredCall(v2.v2, call, { sender: v2.sender, owner: v2.owner, assets: testnetAssets().map(a => a.address) }); if (kind !== null) return kind; } catch { return null; } }
  const S = STRATEGY_EARN_97;
  try {
    if (isAddressEqual(call.target, S.executor)) {
      const name = decodeFunctionData({ abi: BORROW_CALL_ABI, data: call.callData }).functionName;
      return name === 'executeSupplyCollateral' || name === 'executeBorrow' ? 'risk'
        : name === 'executeRepay' || name === 'executeWithdrawCollateral' || name === 'executeDeleverage' ? 'settle' : null;
    }
    if (isAddressEqual(call.target, S.registry)) {
      const inner = decodeFunctionData({ abi: BORROW_CALL_ABI, data: call.callData });
      return inner.functionName === 'setBorrowPolicy' ? (inner.args[2] ? 'risk' : 'settle') : null;
    }
    if (isAddressEqual(call.target, S.venusComptroller) || isAddressEqual(call.target, S.listaMoolah)) {
      const name = decodeFunctionData({ abi: BORROW_CALL_ABI, data: call.callData }).functionName;
      return name === 'updateDelegate' || name === 'setAuthorization' ? 'risk' : null;
    }
    if (call.callData.startsWith(toFunctionSelector('approve(address,uint256)'))) {
      const inner = decodeFunctionData({ abi: TOKEN_ABI, data: call.callData });
      return inner.functionName === 'approve' && isAddressEqual(inner.args[0], S.executor) ? 'risk' : null;
    }
  } catch { return null; }
  return null;
}

type CallContext = { owner?: Address; assets?: readonly Address[]; v2?: StrategyEarnV2 | null;
  /** Yield strategy reward tokens (LISTA, XVS): the owner may send them from the account to their own wallet, nothing else. */
  rewardTokens?: readonly Address[] };
const collateralOf = (symbol: string): Address => {
  const asset = (TESTNET_97.assets as Record<string, { token: string } | undefined>)[symbol];
  if (!asset) throw new Error('strategy collateral missing');
  return asset.token as Address;
};
export function validateSponsoredCalls(op: PackedSponsorOperation, c: PaymasterConfig, context: CallContext = {}): void {
  const calls = sponsoredCalls(op);
  let at = -1;
  try {
    const assets = c.chainId === 97 ? testnetAssets().map((asset) => asset.address) : context.assets ?? [];
    for (let index = 0; index < calls.length; index++) {
      at = index;
      const call = calls[index];
      if (call === undefined) throw new Error('missing call');
      if (call.value !== 0n) throw new Error('native transfer');
      if (isAddressEqual(call.target, op.sender)) {
        const next = calls[++index];
        if (next === undefined || next.value !== 0n || !isAddressEqual(next.target, op.sender)) throw new Error('incomplete renewal');
        validateAnyRenewal(call.callData, next.callData, c, op.sender, context.v2 ?? null);
      } else if (context.v2 && v2SponsoredCall(context.v2, call, { sender: op.sender, owner: context.owner, assets }) !== null) {
        // Routing v2 (src/strategy-earn-v2.ts): a valid call to the v2 executor / registry / lending delegation, or an approval
        // to the v2 executor. An invalid one throws above and is rejected here like any other.
      } else if (isAddressEqual(call.target, c.executor)) {
        const inner = decodeFunctionData({ abi: EXECUTOR_ABI, data: call.callData });
        if (inner.functionName === 'executeSupply' || inner.functionName === 'executeWithdraw') {
          // backend#199: AtpExecutor must never move the strategy earn vault (it would become account cash).
          if (isStrategyVault({ marketId: inner.args[1] })) throw new Error('strategy vault via AtpExecutor');
          if (c.chainId !== 97 || !isAddressEqual(inner.args[0], op.sender) || inner.args[2] === 0n || inner.args[3] === 0n || inner.args[4] === 0n ||
              !TESTNET_97.yieldMarkets.some(m => m.marketId === inner.args[1]) ||
              encodeFunctionData({ abi: EXECUTOR_ABI, functionName: inner.functionName, args: inner.args }).toLowerCase() !== call.callData.toLowerCase()) throw new Error('invalid yield call');
        } else if (inner.functionName !== 'executeRebalance' || !isAddressEqual(inner.args[0], op.sender) || inner.args[1].length === 0 ||
            encodeFunctionData({ abi: EXECUTOR_ABI, functionName: inner.functionName, args: inner.args }).toLowerCase() !== call.callData.toLowerCase()) throw new Error('invalid rebalance');
      } else if (c.chainId === 97 && isAddressEqual(call.target, TESTNET_97.contracts.yieldRegistry)) {
        const inner = decodeFunctionData({ abi: YIELD_REGISTRY_ABI, data: call.callData });
        if (inner.functionName !== 'setYieldPolicy' && inner.functionName !== 'requestExit') throw new Error('invalid yield owner action');
        if (isStrategyVault({ marketId: inner.args[0] })) throw new Error('strategy vault yield policy');
        if (!TESTNET_97.yieldMarkets.some(m => m.marketId === inner.args[0]) ||
            inner.functionName === 'setYieldPolicy' && inner.args[2] && inner.args[1] === 0n ||
            encodeFunctionData({ abi: YIELD_REGISTRY_ABI, functionName: inner.functionName, args: inner.args }).toLowerCase() !== call.callData.toLowerCase()) throw new Error('invalid yield owner calldata');
      } else if (c.chainId === 97 && isAddressEqual(call.target, STRATEGY_EARN_97.executor)) {
        // Strategy earn (backend#199): every movement is for this account and one of its fixed markets.
        const inner = decodeFunctionData({ abi: BORROW_CALL_ABI, data: call.callData });
        if (!['executeSupplyCollateral', 'executeBorrow', 'executeRepay', 'executeWithdrawCollateral', 'executeDeleverage'].includes(inner.functionName)) throw new Error('invalid borrow call');
        const args = inner.args as readonly unknown[];
        if (typeof args[0] !== 'string' || !isAddressEqual(args[0] as Address, op.sender) || typeof args[1] !== 'string' || !isStrategyMarketId(args[1]) ||
            (args.length > 2 && args[2] === 0n) ||
            encodeFunctionData({ abi: BORROW_CALL_ABI, functionName: inner.functionName, args: inner.args } as never).toLowerCase() !== call.callData.toLowerCase()) throw new Error('invalid borrow call');
      } else if (c.chainId === 97 && isAddressEqual(call.target, STRATEGY_EARN_97.registry)) {
        const inner = decodeFunctionData({ abi: BORROW_CALL_ABI, data: call.callData });
        if (inner.functionName !== 'setBorrowPolicy' || !isStrategyMarketId(inner.args[0]) || (inner.args[2] && inner.args[1] === 0n) ||
            encodeFunctionData({ abi: BORROW_CALL_ABI, functionName: inner.functionName, args: inner.args }).toLowerCase() !== call.callData.toLowerCase()) throw new Error('invalid borrow policy');
      } else if (c.chainId === 97 && (isAddressEqual(call.target, STRATEGY_EARN_97.venusComptroller) || isAddressEqual(call.target, STRATEGY_EARN_97.listaMoolah))) {
        const inner = decodeFunctionData({ abi: BORROW_CALL_ABI, data: call.callData });
        const expected = isAddressEqual(call.target, STRATEGY_EARN_97.venusComptroller) ? 'updateDelegate' : 'setAuthorization';
        if (inner.functionName !== expected || !isAddressEqual(inner.args[0] as Address, STRATEGY_EARN_97.executor) ||
            encodeFunctionData({ abi: BORROW_CALL_ABI, functionName: inner.functionName, args: inner.args } as never).toLowerCase() !== call.callData.toLowerCase()) throw new Error('invalid lending delegate');
      } else if (c.chainId === 97 && isStrategyVault({ address: call.target })) {
        // Strategy vault shares may be approved to AtpBorrowExecutor only — never AtpExecutor (docs/borrow-97 §7).
        const inner = decodeFunctionData({ abi: BORROW_CALL_ABI, data: call.callData });
        if (inner.functionName !== 'approve' || !isAddressEqual(inner.args[0] as Address, STRATEGY_EARN_97.executor) ||
            encodeFunctionData({ abi: BORROW_CALL_ABI, functionName: 'approve', args: inner.args as readonly [Address, bigint] }).toLowerCase() !== call.callData.toLowerCase()) throw new Error('invalid strategy vault approval');
      } else if (c.chainId === 97 && dcaVaultCall(call, op.sender, context.owner)) {
        // DCA (定投, db 0064): the account deposits its own USDT for itself, or returns its whole position to its owner.
      } else if (isAddressEqual(call.target, c.registry)) {
        const inner = decodeFunctionData({ abi: REGISTRY_ABI, data: call.callData });
        if (inner.functionName !== 'enroll' || !isAddressEqual(inner.args[0], op.sender) || inner.args[1] === 0n || inner.args[2] === 0 ||
            encodeFunctionData({ abi: REGISTRY_ABI, functionName: inner.functionName, args: inner.args }).toLowerCase() !== call.callData.toLowerCase()) throw new Error('invalid enrollment');
      } else if ((assets.some((asset) => isAddressEqual(call.target, asset)) ||
          c.chainId === 97 && TESTNET_97.yieldMarkets.some(m => isAddressEqual(call.target, m.receipt)) && call.callData.startsWith(toFunctionSelector('approve(address,uint256)'))) &&
          TOKEN_ABI.some((fn) => call.callData.toLowerCase().startsWith(toFunctionSelector(fn)))) {
        const inner = decodeFunctionData({ abi: TOKEN_ABI, data: call.callData });
        if (encodeFunctionData({ abi: TOKEN_ABI, functionName: inner.functionName, args: inner.args }).toLowerCase() !== call.callData.toLowerCase()) throw new Error('noncanonical token call');
        if (inner.functionName === 'approve') {
          const borrowSpender = c.chainId === 97 && isAddressEqual(inner.args[0], STRATEGY_EARN_97.executor) &&
            (isAddressEqual(call.target, TESTNET_97.contracts.usdt) || STRATEGY_EARN_97.markets.some(m => isAddressEqual(call.target, collateralOf(m.symbol))));
          const dcaSpender = c.chainId === 97 && isDcaSpender(call.target, inner.args[0]);
          if (!isAddressEqual(inner.args[0], c.executor) && !borrowSpender && !dcaSpender) throw new Error('invalid spender');
          if (isStrategyVault({ address: call.target }) && !borrowSpender) throw new Error('strategy vault approval');
        } else if (context.owner === undefined || !isAddressEqual(inner.args[0], context.owner) || inner.args[1] === 0n) throw new Error('invalid withdrawal');
      } else if ((context.rewardTokens ?? []).some((token) => isAddressEqual(call.target, token))) {
        // Reward tokens leave the account only as a plain transfer to its owner (sell-all / withdraw / delete). No approvals.
        const inner = decodeFunctionData({ abi: TOKEN_ABI, data: call.callData });
        if (inner.functionName !== 'transfer' || context.owner === undefined || !isAddressEqual(inner.args[0], context.owner) || inner.args[1] === 0n ||
            encodeFunctionData({ abi: TOKEN_ABI, functionName: 'transfer', args: inner.args }).toLowerCase() !== call.callData.toLowerCase()) throw new Error('invalid reward payout');
      } else throw new Error('unknown target');
    }
  } catch (error) {
    const call = calls[at];
    // Public contract address + 4-byte selector + check name only: enough to find the rule, no request bytes.
    throw rejected('PAYMASTER_CALL_FORBIDDEN', 403, `call ${at}/${calls.length} to ${call?.target ?? '?'} ${call?.callData.slice(0, 10) ?? ''}: ${
      checkName(error)}`);
  }
}

/** eth-infinitism v0.7.0 7af70c8993a6f42973f520ae0752386a5032abe7, samples/VerifyingPaymaster.sol:getHash.
 * The 32-byte paymaster gas header IS signed; account signature and paymaster signature are excluded.
 * Kept separate so a future contract version cannot silently change the signing algorithm.
 */
export function verifyingPaymasterHash(op: PackedSponsorOperation, c: PaymasterConfig, validUntil: number, validAfter: number): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint48' }, { type: 'uint48' }],
    [op.sender, op.nonce, keccak256(op.initCode), keccak256(op.callData), op.accountGasLimits, BigInt(slice(op.paymasterAndData, 20, 52)), op.preVerificationGas, op.gasFees, BigInt(c.chainId), c.address, validUntil, validAfter]));
}

function header(c: PaymasterConfig): Hex {
  return concatHex([c.address, toHex(c.verificationGasLimit, { size: 16 }), toHex(c.postOpGasLimit, { size: 16 })]);
}
function gasCost(op: PackedSponsorOperation, c: PaymasterConfig) {
  const accountGas = BigInt(op.accountGasLimits);
  const verificationGas = accountGas >> 128n;
  const callGas = accountGas & MASK_128;
  const maxFee = BigInt(op.gasFees) & MASK_128;
  if (BigInt(op.gasFees) >> 128n > maxFee) throw rejected('PAYMASTER_INVALID_OPERATION');
  const gasLimit = verificationGas + callGas + op.preVerificationGas + c.verificationGasLimit + c.postOpGasLimit;
  return { verificationGas, callGas, maxFee, gasLimit, maxCostWei: gasLimit * maxFee };
}

/** Funding-independent execution identity: changing price, paymaster or gas bounds cannot create a new charge. */
export function gasExecutionKey(chainId: number, op: Pick<PackedSponsorOperation, 'sender' | 'nonce' | 'initCode' | 'callData'>): Hex {
  return keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' }],
    [BigInt(chainId), op.sender, op.nonce, keccak256(op.initCode), keccak256(op.callData)]));
}
function sponsorshipNoncePrefix(chainId: number, op: PackedSponsorOperation): string {
  return `sponsor-gas:${chainId}:${op.sender}:${op.nonce}:`;
}
/** Gas estimates are separate immutable charges; signatures, expiry and oracle blocks are not new attempts. */
function sponsorshipGasKey(op: PackedSponsorOperation, c: PaymasterConfig): string {
  const digest = keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }],
    [gasExecutionKey(c.chainId, op), op.accountGasLimits, op.preVerificationGas, op.gasFees, c.verificationGasLimit, c.postOpGasLimit]));
  return sponsorshipNoncePrefix(c.chainId, op) + digest.slice(2);
}
const BUDGET_ORACLE_ABI = parseAbi([
  'function oracle() view returns(address)', 'function numeraire() view returns(address)',
  'function previewSwap(address,address,uint256) view returns(uint256,uint256)',
  'function balanceOf(address) view returns(uint256)',
]);

/** All reads share a fresh block. The price is the planner's WBNB/USDT oracle, never an external API. */
export async function readNativeBudgetPrice(client: PublicClient, executor: Address, chainId: number): Promise<Pick<BudgetContext, 'nativePrice' | 'priceDecimals' | 'priceSource'>> {
  try {
    const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
    const [oracle, numeraire] = await Promise.all([
      client.readContract({ address: executor, abi: BUDGET_ORACLE_ABI, functionName: 'oracle', blockNumber }),
      client.readContract({ address: executor, abi: BUDGET_ORACLE_ABI, functionName: 'numeraire', blockNumber }),
    ]);
    const wbnb = chainId === 97 ? testnetAssets().find((asset) => asset.symbol === 'WBNB')?.address : '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
    if (!wbnb) throw rejected('GAS_BUDGET_PRICE_UNAVAILABLE', 503);
    const [quoted, floor] = await client.readContract({ address: oracle, abi: BUDGET_ORACLE_ABI, functionName: 'previewSwap', args: [wbnb, numeraire, 10n ** 18n], blockNumber });
    const decimals = await client.readContract({ address: numeraire, abi: parseAbi(['function decimals() view returns(uint8)']), functionName: 'decimals', blockNumber });
    if (decimals > 36 || quoted <= 0n || floor <= 0n) throw rejected('GAS_BUDGET_PRICE_UNAVAILABLE', 503);
    return { nativePrice: quoted, priceDecimals: decimals, priceSource: `oracle:${chainId}:${oracle.toLowerCase()}:block:${blockNumber}` };
  } catch { throw rejected('GAS_BUDGET_PRICE_UNAVAILABLE', 503); }
}

/** Retries retain the original price, source and purpose, even across UTC days or restarts. */
export async function existingBudgetContext(executionKey: string): Promise<BudgetContext | null> {
  try {
    const result = await query<{ native_price_usd: string; price_source: string; purpose: GasPurpose }>(
      'select native_price_usd::text,price_source,purpose from gas_budget_reservations where execution_key=$1', [executionKey]);
    const row = result.rows[0];
    if (row === undefined) return null;
    if (!/^\d+(?:\.\d+)?$/.test(row.native_price_usd)) throw rejected('GAS_BUDGET_INVALID', 503);
    const [whole, fractional = ''] = row.native_price_usd.split('.');
    return { nativePrice: BigInt((whole ?? '') + fractional), priceDecimals: fractional.length, priceSource: row.price_source, purpose: row.purpose };
  } catch { throw rejected('GAS_BUDGET_STORAGE_UNAVAILABLE', 503); }
}

function setupOperation(op: PackedSponsorOperation, c: PaymasterConfig): boolean {
  return sponsoredCalls(op).every(call => call.callData.startsWith(toFunctionSelector('approve(address,uint256)')) || isAddressEqual(call.target, c.registry));
}

async function readBudgetContext(op: PackedSponsorOperation, c: PaymasterConfig, attemptKey?: string, retrySetup = false): Promise<BudgetContext> {
  const previous = (attemptKey === undefined ? null : await existingBudgetContext(attemptKey)) ??
    await existingBudgetContext(gasExecutionKey(c.chainId, op));
  if (previous !== null && (!retrySetup || !setupOperation(op, c))) return previous;
  const client = rpc(c);
  const price = previous ?? await readNativeBudgetPrice(client, c.executor, c.chainId);
  const calls = sponsoredCalls(op);
  if (pureYieldWithdraw(op, c)) return { ...price, purpose: 'exit' };
  const setup = setupOperation(op, c);
  // Public requests get an exit exemption only when every strategy token balance is fully sold/transferred.
  // A capped close is authorized through the internal scheduler evidence below instead.
  const tokenCalls = calls.every((call) => call.callData.startsWith(toFunctionSelector('transfer(address,uint256)')));
  const rebalance = calls.length === 1 && calls[0] !== undefined && isAddressEqual(calls[0].target, c.executor)
    ? decodeFunctionData({ abi: EXECUTOR_ABI, data: calls[0].callData }) : null;
  const priorSetup = !setup ? null : retrySetup ? await query<{ execution_key: string; state: string; new_nonce: boolean; nonces: string[] | null }>(`
    select g.execution_key,g.state,coalesce((select bool_and(f.value->>'nonce' ~ '^[0-9]+$' and f.value->>'nonce'<>$3::text
      and f.value @> jsonb_build_object('chainId',$1::bigint,'account',$2::text,'purpose','setup'))
      from yield_runtime_state f where f.kind='fact' and f.name like 'auth-%' and f.value->>'executionKey'=g.execution_key),false) as new_nonce,
      (select array_agg(f.value->>'nonce') from yield_runtime_state f where f.kind='fact' and f.name like 'auth-%'
        and f.value->>'executionKey'=g.execution_key) as nonces
    from gas_budget_reservations g where chain_id=$1 and account=$2 and purpose='setup' and state<>'failed'`, [c.chainId, op.sender, op.nonce.toString()]) :
    await query<{ execution_key: string; state?: string; new_nonce?: boolean }>("select execution_key from gas_budget_reservations where chain_id=$1 and account=$2 and purpose='setup' and state<>'failed'", [c.chainId, op.sender]);
  // Pending setup variants must never silently become ordinary and evade reconciliation.
  // Later approvals after a confirmed setup retain the ordinary policy on a new nonce.
  const pendingSetup = retrySetup && priorSetup?.rows.some(row => row.state !== 'confirmed' || row.new_nonce !== true) === true &&
    !(setup && await setupNoncesConsumed(client, op, priorSetup?.rows ?? []));
  let purpose: GasPurpose = setup && (priorSetup?.rows.length === 0 || pendingSetup) ? 'setup' : 'ordinary';
  if (tokenCalls || rebalance?.functionName === 'executeRebalance') {
    const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
    const numeraire = await client.readContract({ address: c.executor, abi: BUDGET_ORACLE_ABI, functionName: 'numeraire', blockNumber });
    const enrollment = await client.readContract({ address: c.registry, abi: REGISTRY_ABI, functionName: 'enrollments', args: [op.sender], blockNumber });
    // P11 exits must account for every historically effective asset, including new versions.
    const assets = await client.readContract({ address: c.registry, abi: REGISTRY_VERSION_ABI,
      functionName: 'historicalAssets', args: [enrollment[0]], blockNumber });
    const moved = new Map<string, bigint>();
    if (tokenCalls) {
      for (const call of calls) {
        const decoded = decodeFunctionData({ abi: TOKEN_ABI, data: call.callData });
        if (decoded.functionName !== 'transfer') throw rejected('PAYMASTER_CALL_FORBIDDEN', 403);
        moved.set(call.target.toLowerCase(), (moved.get(call.target.toLowerCase()) ?? 0n) + decoded.args[1]);
      }
    } else if (rebalance?.functionName === 'executeRebalance' && rebalance.args[1].every((step) => isAddressEqual(step.tokenOut, numeraire))) {
      for (const step of rebalance.args[1]) moved.set(step.tokenIn.toLowerCase(), (moved.get(step.tokenIn.toLowerCase()) ?? 0n) + step.amountIn);
    }
    if (moved.size > 0 && assets.length > 0) {
      let full = true;
      if (!tokenCalls && [...moved.keys()].some((asset) => !assets.some((allowed) => allowed.toLowerCase() === asset))) full = false;
      const checkedAssets = new Set([...assets, ...(tokenCalls ? calls.map((call) => call.target) : [])]);
      const matches = await Promise.all([...checkedAssets].map(async (asset) => {
        if (!tokenCalls && isAddressEqual(asset, numeraire)) return true;
        const balance = await client.readContract({ address: asset, abi: BUDGET_ORACLE_ABI, functionName: 'balanceOf', args: [op.sender], blockNumber });
        return (moved.get(asset.toLowerCase()) ?? 0n) === balance;
      }));
      if (!matches.every(Boolean)) full = false;
      if (full) purpose = 'exit';
    }
  }
  return { ...price, purpose };
}

/** Public setup sponsorships have no receipt reconciler, so a landed setup stays 'reserved'.
 * Only a recorded nonce the EntryPoint has already passed proves that setup can never execute
 * again; then a later owner-signed approvals+enroll (e.g. a My mix change) on a NEW nonce is ordinary.
 * Missing/legacy facts or the same nonce never qualify. Never guess a nonce.
 */
async function setupNoncesConsumed(client: PublicClient, op: PackedSponsorOperation,
  rows: readonly { state?: string; new_nonce?: boolean; nonces?: string[] | null }[]): Promise<boolean> {
  if (!rows.length || rows.some(row => row.new_nonce !== true || !Array.isArray(row.nonces) || !row.nonces.length ||
      row.nonces.some(n => typeof n !== 'string' || !/^\d+$/.test(n) || BigInt(n) > MAX_UINT256 || BigInt(n) === op.nonce))) return false;
  const nonces = rows.filter(row => row.state !== 'confirmed').flatMap(row => (row.nonces ?? []).map(BigInt));
  try {
    if (await client.getChainId() !== 97) throw setupUnavailable();
    const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
    const onchain = await Promise.all(nonces.map(nonce => client.readContract({ address: TESTNET_97.contracts.entryPoint, abi: EXIT_READ,
      functionName: 'getNonce', args: [op.sender, nonce >> 64n], blockNumber })));
    return onchain.every((current, index) => current > (nonces[index] ?? MAX_UINT256));
  } catch { throw setupUnavailable(); }
}

/** Canonical final payload is the authority; partial withdrawals are also pure exits. */
export function pureYieldWithdraw(op: PackedSponsorOperation, c: PaymasterConfig): boolean {
  if (c.chainId !== 97) return false;
  try {
    validateSponsoredCalls(op, c);
    return sponsoredCalls(op).every(call => isAddressEqual(call.target, c.executor) &&
      decodeFunctionData({ abi: EXECUTOR_ABI, data: call.callData }).functionName === 'executeWithdraw');
  } catch { return false; }
}

const EXIT_READ = parseAbi(['function balanceOf(address) view returns(uint256)',
  'function accountUnits(address,bytes32) view returns(uint256)', 'function getNonce(address,uint192) view returns(uint256)']);
const USER_OP_EVENT = parseAbiItem('event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)');
/** Public sponsorship has no trusted scheduler plan. Prove holdings and simulate the entire
 * exact Kernel batch, so duplicate markets cannot borrow the same balance twice.
 */
async function verifyYieldWithdraw(op:PackedSponsorOperation,c:PaymasterConfig,now:number,db:Query):Promise<readonly ConsumedAuthorization[]>{
  try{
    const client=rpc(c),block=await client.getBlock({blockTag:'latest'});
    if(c.chainId!==97||await client.getChainId()!==97||op.initCode!=='0x'||block.number===null||block.hash===null||
      !fresh(new Date(Number(block.timestamp)*1000),new Date(now*1000)))throw rejected('PAYMASTER_EXIT_INVALID',403);
    const nonce=await client.readContract({address:TESTNET_97.contracts.entryPoint,abi:EXIT_READ,functionName:'getNonce',args:[op.sender,op.nonce>>64n],blockNumber:block.number});
    if(nonce!==op.nonce)throw rejected('PAYMASTER_EXIT_INVALID',403);
    const amounts=new Map<Hex,bigint>();
    for(const call of sponsoredCalls(op)){
      const decoded=decodeFunctionData({abi:EXECUTOR_ABI,data:call.callData});
      if(!isAddressEqual(call.target,c.executor)||decoded.functionName!=='executeWithdraw')throw rejected('PAYMASTER_EXIT_INVALID',403);
      amounts.set(decoded.args[1],(amounts.get(decoded.args[1])??0n)+decoded.args[2]);
    }
    for(const [id,amount]of amounts){
      const market=TESTNET_97.yieldMarkets.find(m=>m.marketId===id);if(!market)throw rejected('PAYMASTER_EXIT_INVALID',403);
      const [balance,units]=await Promise.all([
        client.readContract({address:market.receipt,abi:EXIT_READ,functionName:'balanceOf',args:[op.sender],blockNumber:block.number}),
        client.readContract({address:TESTNET_97.contracts.yieldRegistry,abi:EXIT_READ,functionName:'accountUnits',args:[op.sender,id],blockNumber:block.number}),
      ]);
      // DCA (db 0064): the vault shares were deposited by the account itself (untracked by the registry);
      // a session-key redemption of an open plan's own market is still a pure exit back to account cash.
      if(amount===0n||amount>balance||units===0n&&!(await db(`select 1 from dca_plans where chain_id=$1 and account=$2 and market_id=$3
        and state in ('active','paused') limit 1`,[c.chainId,op.sender.toLowerCase(),id.toLowerCase()])).rows.length)throw rejected('PAYMASTER_EXIT_INVALID',403);
    }
    let data=op.callData;
    let stateOverride:Parameters<typeof client.call>[0]['stateOverride'];
    if(op.callData.startsWith(EXECUTE_USER_OP_SELECTOR)){
      // EntryPoint v0.7 _executeUserOp ABI-encodes the full op, not the SDK prefix.
      const userOpHash=packedOperationHash(op,c.chainId),nonceBytes=toHex(op.nonce,{size:32});
      const abi=parseAbi(['function rootValidator() view returns(bytes21)','function validationConfig(bytes21) view returns(uint32 nonce,address hook)']);
      const id=slice(nonceBytes,1,2)==='0x00'
        ?await client.readContract({address:op.sender,abi,functionName:'rootValidator',blockNumber:block.number})
        :slice(nonceBytes,1,2)==='0x02'?pad(slice(nonceBytes,1,6),{size:21,dir:'right'}):slice(nonceBytes,1,22);
      const [,hook]=await client.readContract({address:op.sender,abi,functionName:'validationConfig',args:[id],blockNumber:block.number});
      // Kernel 0.3.3 validateUserOp writes executionHook[userOpHash] (ordinary slot 0).
      // Reproduce only that write in this eth_call; run the real installed hook as well.
      stateOverride=[{address:op.sender,stateDiff:[{slot:keccak256(encodeAbiParameters([{type:'bytes32'},{type:'uint256'}],[userOpHash,0n])),value:pad(hook)}]}];
      data=encodeFunctionData({abi:KernelV3_3AccountAbi,functionName:'executeUserOp',args:[op,userOpHash]});
    }
    await client.call({account:TESTNET_97.contracts.entryPoint,to:op.sender,data,gas:gasCost(op,c).callGas,blockNumber:block.number,...(stateOverride?{stateOverride}:{})});
    const candidates=await db(`select s.user_op_hash from paymaster_sponsorships s where s.chain_id=$1 and s.sender=$2 and s.state not in ('confirmed','failed','expired')
      and exists(select 1 from gas_budget_reservations g where g.chain_id=s.chain_id and g.account=s.sender and g.purpose='exit' and g.state in ('reserved','submitted','unknown'))`,[c.chainId,op.sender]);
    const hashes=candidates.rows.map(row=>hex(object(row).user_op_hash,32));
    const consumed:ConsumedAuthorization[]=[];
    if(hashes.length){
      const logs=await client.getLogs({address:TESTNET_97.contracts.entryPoint,event:USER_OP_EVENT,args:{sender:op.sender,userOpHash:hashes},strict:true,
        fromBlock:block.number>1024n?block.number-1024n:0n,toBlock:block.number});
      for(const log of logs){
        if(log.removed||log.blockNumber===null||log.blockHash===null)continue;
        if((await client.getBlock({blockNumber:log.blockNumber})).hash!==log.blockHash)throw rejected('PAYMASTER_EXIT_UNAVAILABLE',503);
        const [tx,receipt]=await Promise.all([client.getTransaction({hash:log.transactionHash}),client.getTransactionReceipt({hash:log.transactionHash})]);
        if(tx.hash!==log.transactionHash||tx.blockHash!==log.blockHash||tx.blockNumber!==log.blockNumber||!tx.to||!isAddressEqual(tx.to,TESTNET_97.contracts.entryPoint)||
          receipt.status!=='success'||receipt.transactionHash!==tx.hash||receipt.blockHash!==log.blockHash||receipt.blockNumber!==log.blockNumber||
          !receipt.logs.some(candidate=>!candidate.removed&&candidate.transactionHash===log.transactionHash&&candidate.blockHash===log.blockHash&&candidate.blockNumber===log.blockNumber&&
            candidate.logIndex===log.logIndex&&isAddressEqual(candidate.address,log.address)&&candidate.data===log.data&&
            candidate.topics.length===log.topics.length&&candidate.topics.every((topic,index)=>topic===log.topics[index])))throw rejected('PAYMASTER_EXIT_UNAVAILABLE',503);
        const decoded=decodeFunctionData({abi:entryPoint07Abi,data:tx.input});
        const packed=decoded.functionName==='handleOps'?decoded.args[0]:decoded.functionName==='handleAggregatedOps'?decoded.args[0].flatMap(group=>group.userOps):[];
        const originals=packed.filter(original=>packedOperationHash(original,c.chainId)===log.args.userOpHash);
        const original=originals[0];
        if(originals.length!==1||!original||!isAddressEqual(original.sender,op.sender)||original.nonce!==log.args.nonce)throw rejected('PAYMASTER_EXIT_UNAVAILABLE',503);
        consumed.push({userOpHash:log.args.userOpHash,executionKey:gasExecutionKey(c.chainId,original),success:log.args.success});
      }
    }
    if((await client.getBlock({blockNumber:block.number})).hash!==block.hash)throw rejected('PAYMASTER_EXIT_UNAVAILABLE',503);
    return consumed;
  }catch(error){
    if(error instanceof AppError&&error.code==='PAYMASTER_EXIT_INVALID')throw error;
    throw rejected('PAYMASTER_EXIT_UNAVAILABLE',503);
  }
}

function decimalE8(value: bigint): string {
  return `${value / 100000000n}.${(value % 100000000n).toString().padStart(8, '0')}`;
}
function priceDecimal(r: GasBudgetRequest): string {
  const decimals = r.priceDecimals ?? 8;
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) throw rejected('GAS_BUDGET_INVALID', 503);
  const scale = 10n ** BigInt(decimals);
  return decimals === 0 ? r.nativePrice.toString() : `${r.nativePrice / scale}.${(r.nativePrice % scale).toString().padStart(decimals, '0')}`;
}
type BudgetClient = Pick<PoolClient, 'query'>;
type SetupSnapshot = {
  executionKey: string; state: string; day: string;
  authorizations: { hash: Hex; nonce: string; validUntil: number; state: string }[];
};
type SetupRetryProof = { snapshot: SetupSnapshot; blockNumber: string; blockHash: Hex; blockTimestamp: number; checkedAt: number };
const setupUnavailable = () => rejected('PAYMASTER_SETUP_RETRY_UNAVAILABLE', 503);
function setupRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw setupUnavailable();
  return value as Record<string, unknown>;
}

/** Opaque/missing legacy hashes cannot prove which nonce was authorized. Never guess. */
async function setupSnapshot(c: PaymasterConfig, account: Address, db: Query): Promise<SetupSnapshot | null> {
  const rows = (await db(`select execution_key,state,to_char(utc_day,'YYYY-MM-DD') as day from gas_budget_reservations
    where chain_id=$1 and account=$2 and purpose='setup' and state<>'failed'`, [c.chainId, account])).rows;
  if (!rows.length) return null;
  if (rows.length !== 1) throw setupUnavailable();
  const reservation = setupRecord(rows[0]);
  const { execution_key: executionKey, state, day } = reservation;
  if (typeof executionKey !== 'string' || !executionKey || typeof state !== 'string' ||
      !['reserved', 'submitted', 'unknown', 'confirmed'].includes(state) || typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw setupUnavailable();
  const candidates = (await db(`select s.user_op_hash,s.valid_until,s.state,f.kind,f.value from paymaster_sponsorships s
    left join yield_runtime_state f on f.name='auth-'||substr(s.user_op_hash,3)
    where s.chain_id=$1 and s.sender=$2 and (f.value->>'executionKey'=$3 or
      f.name is null and s.state not in ('confirmed','failed','expired')) order by s.user_op_hash`, [c.chainId, account, executionKey])).rows;
  if (!candidates.length) throw setupUnavailable();
  const authorizations = candidates.map(item => {
    const row = setupRecord(item), facts = setupRecord(row.value);
    const { user_op_hash: hash, valid_until: until, state: authState } = row;
    if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/.test(hash) || row.kind !== 'fact' || facts.chainId !== 97 ||
        facts.account !== account || facts.userOpHash !== hash || facts.executionKey !== executionKey || facts.purpose !== 'setup' ||
        typeof facts.nonce !== 'string' || !/^\d+$/.test(facts.nonce) || BigInt(facts.nonce) > MAX_UINT256 ||
        typeof facts.validUntil !== 'number' || !Number.isSafeInteger(facts.validUntil) || facts.validUntil <= 0 ||
        !(until instanceof Date) || until.getTime() !== facts.validUntil * 1000 || typeof authState !== 'string') throw setupUnavailable();
    return { hash: hash as Hex, nonce: facts.nonce, validUntil: facts.validUntil, state: authState };
  });
  return { executionKey, state, day, authorizations };
}

/** Bounded reads happen BEFORE opening the SQL transaction. Apply compares the complete
 * snapshot again under paymaster_account, so a concurrent authorization invalidates proof.
 * Chain 97 uses a fresh latest block plus canonical hash recheck, as its other readers do.
 */
async function setupRetryProof(op: PackedSponsorOperation, c: PaymasterConfig, db: Query, now: number): Promise<SetupRetryProof | null> {
  try {
    const snapshot = await setupSnapshot(c, op.sender, db);
    if (!snapshot) return null;
    if (snapshot.authorizations.some(a => BigInt(a.nonce) !== op.nonce)) throw rejected('PAYMASTER_SETUP_NONCE_MISMATCH', 409);
    const client = rpc(c), block = await client.getBlock({ blockTag: 'latest' });
    if (await client.getChainId() !== 97 || block.number === null || block.hash === null ||
        !fresh(new Date(Number(block.timestamp) * 1000), new Date(now * 1000))) throw setupUnavailable();
    const [nonce, code] = await Promise.all([
      client.readContract({ address: TESTNET_97.contracts.entryPoint, abi: EXIT_READ, functionName: 'getNonce', args: [op.sender, op.nonce >> 64n], blockNumber: block.number }),
      client.getCode({ address: op.sender, blockNumber: block.number }),
    ]);
    if (!code || code === '0x' || (await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw setupUnavailable();
    if (nonce > op.nonce) throw rejected('PAYMASTER_SETUP_NONCE_CONSUMED', 409);
    if (nonce !== op.nonce || snapshot.state === 'confirmed' || snapshot.authorizations.some(a => a.state === 'confirmed')) throw setupUnavailable();
    const until = Math.max(...snapshot.authorizations.map(a => a.validUntil));
    // EntryPoint accepts equality. Wall-clock expiry alone never releases the setup slot.
    if (block.timestamp <= BigInt(until)) throw new PaymasterRetryTooSoonError(until);
    return { snapshot, blockNumber: block.number.toString(), blockHash: block.hash, blockTimestamp: Number(block.timestamp), checkedAt: now };
  } catch (error) {
    if (error instanceof AppError && (error.code === 'PAYMASTER_RETRY_TOO_SOON' || error.code === 'PAYMASTER_SETUP_NONCE_CONSUMED' || error.code === 'PAYMASTER_SETUP_NONCE_MISMATCH')) throw error;
    throw setupUnavailable();
  }
}

async function applySetupRetry(r: Reservation, client: BudgetClient): Promise<Reservation> {
  if (r.config.chainId !== 97 || r.budget.purpose !== 'setup' || r.op.initCode !== '0x' || !setupOperation(r.op, r.config)) throw rejected('GAS_BUDGET_CONFLICT', 409);
  const db: Query = (sql, params) => client.query(sql, params ? [...params] : []);
  const current = await setupSnapshot(r.config, r.op.sender, db), proof = r.setupRetryProof;
  if (current) {
    if (!proof || JSON.stringify(current) !== JSON.stringify(proof.snapshot)) {
      throw new PaymasterRetryTooSoonError(Math.max(...current.authorizations.map(a => a.validUntil)));
    }
    const now = (r.now ?? (() => Math.floor(Date.now() / 1000)))();
    if (!fresh(new Date(proof.checkedAt * 1000), new Date(now * 1000)) ||
        !fresh(new Date(proof.blockTimestamp * 1000), new Date(now * 1000)) ||
        proof.blockTimestamp <= Math.max(...current.authorizations.map(a => a.validUntil))) throw setupUnavailable();
    // Same settlement transition and original-day lock as settleGasBudget, on THIS client.
    // The failed slot, audit evidence and both new ledgers must commit or roll back together.
    await client.query("select pg_advisory_xact_lock(hashtextextended('gas_budget_reservations:'||$1::bigint::text||':'||$2::text||':'||$3::text,0))", [97, r.op.sender, current.day]);
    await writeYieldState(`release-setup-${current.authorizations[0]?.hash.slice(2)}`, { reason: 'expired_setup_nonce_unchanged', evidence: proof }, db);
    await client.query("update gas_budget_reservations set state='failed',updated_at=greatest(updated_at,clock_timestamp()) where execution_key=$1 and state in ('reserved','submitted','unknown')", [current.executionKey]);
    await client.query("update paymaster_sponsorships set state='expired',updated_at=greatest(updated_at,clock_timestamp()) where user_op_hash=any($1::text[]) and state not in ('confirmed','failed','expired')", [current.authorizations.map(a => a.hash)]);
  } else if (proof) throw setupUnavailable();
  return { ...r, budget: { ...r.budget, executionKey: `setup-gas:97:${r.op.sender}:${r.hash.slice(2)}` } };
}

async function reserveBudgetOnClient(r: GasBudgetRequest, client: BudgetClient, day: string, policy: TradingConfig): Promise<void> {
  if (!r.executionKey.trim() || !/^0x[0-9a-f]{40}$/.test(r.account) || r.gasLimit < 0n || r.maxFeePerGas < 0n || r.nativePrice <= 0n || !r.priceSource.trim()) throw rejected('GAS_BUDGET_INVALID', 503);
  await client.query("select pg_advisory_xact_lock(hashtextextended('gas_budget_reservations:' || $1::bigint::text || ':' || $2::text || ':' || to_char($3::date,'YYYY-MM-DD'),0))", [r.chainId, r.account, day]);
  const params = [r.executionKey, r.chainId, r.account, r.purpose, r.gasLimit.toString(), r.maxFeePerGas.toString(), priceDecimal(r), r.priceSource];
  const previous = await client.query<{ matches: boolean }>(`select (chain_id=$2 and account=$3 and purpose=$4 and gas_limit=$5::numeric and max_fee_per_gas=$6::numeric
    and native_price_usd=$7::numeric and price_source=$8) as matches from gas_budget_reservations where execution_key=$1`, params);
  if (previous.rows.length > 0) {
    if (previous.rows[0]?.matches !== true) throw rejected('GAS_BUDGET_CONFLICT', 409);
    return;
  }
  if (r.purpose === 'ordinary') {
    const usage = await client.query<{ allowed: boolean }>(`select coalesce(sum(gas_limit),0)+$4::numeric <= $5::numeric and
      ($7::numeric is null or coalesce(sum(max_cost_usd),0)+$6::numeric <= $7::numeric) as allowed from gas_budget_reservations
      where chain_id=$1 and account=$2 and utc_day=$3::date and purpose='ordinary'`,
      [r.chainId, r.account, day, r.gasLimit.toString(), policy.dailyGas.toString(),
        decimalE8((r.gasLimit * r.maxFeePerGas * r.nativePrice * 100000000n + 10n ** BigInt(18 + (r.priceDecimals ?? 8)) - 1n) / 10n ** BigInt(18 + (r.priceDecimals ?? 8))), policy.dailyUsdE8 === null ? null : decimalE8(policy.dailyUsdE8)]);
    const allowed = usage.rows[0]?.allowed;
    if (typeof allowed !== 'boolean') throw rejected('GAS_BUDGET_STORAGE_UNAVAILABLE', 503);
    if (!allowed) throw new GasBudgetExceededError(day);
  }
  await client.query(`insert into gas_budget_reservations(execution_key,chain_id,account,purpose,gas_limit,max_fee_per_gas,native_price_usd,price_source)
    values($1,$2,$3,$4,$5,$6,$7,$8)`, params);
}

export async function reserveGasBudget(r: GasBudgetRequest, transaction: typeof withTransaction = withTransaction, policy = loadTradingConfig(process.env, r.chainId)): Promise<void> {
  try {
    await transaction(async (client) => {
      await client.query('set transaction isolation level read committed');
      await client.query("select set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)", [String(policy.timeoutMs)]);
      const pinned = await client.query<{ day: string }>("select to_char(transaction_timestamp() at time zone 'UTC','YYYY-MM-DD') as day");
      const day = pinned.rows[0]?.day;
      if (!day) throw new Error('missing UTC day');
      await reserveBudgetOnClient(r, client, day, policy);
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw rejected('GAS_BUDGET_STORAGE_UNAVAILABLE', 503);
  }
}

/** Only verified receipts may use confirmed/failed. A timeout remains unknown, with its full charge. */
export async function settleGasBudget(executionKey: string, state: 'submitted' | 'confirmed' | 'failed' | 'unknown'): Promise<void> {
  try {
    await withTransaction(async (client) => {
      await client.query('set transaction isolation level read committed');
      await client.query("select set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)", [String(loadTradingConfig().timeoutMs)]);
      const result = await client.query<{ chain_id: string; account: string; day: string }>(
        "select chain_id::text,account,to_char(utc_day,'YYYY-MM-DD') as day from gas_budget_reservations where execution_key=$1", [executionKey]);
      const row = result.rows[0];
      if (!row) throw new Error('missing reservation');
      await client.query("select pg_advisory_xact_lock(hashtextextended('gas_budget_reservations:' || $1::bigint::text || ':' || $2::text || ':' || to_char($3::date,'YYYY-MM-DD'),0))", [row.chain_id, row.account, row.day]);
      await client.query("update gas_budget_reservations set state=$2,updated_at=greatest(updated_at,clock_timestamp()) where execution_key=$1 and state in ('reserved','submitted','unknown')", [executionKey, state]);
    });
  } catch { throw rejected('GAS_BUDGET_STORAGE_UNAVAILABLE', 503); }
}

/** Every state counts. Separate chain/day lock statement precedes the fresh aggregate snapshot (db 0027). */
export async function reserveSponsorship(r: Reservation, transaction: typeof withTransaction = withTransaction): Promise<number> {
  const c = r.config;
  try {
    return await transaction(async (client) => {
      await client.query('set transaction isolation level read committed');
      await client.query("select set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)", [String(c.timeoutMs)]);
      // Execution lock spans UTC midnight; day locks still govern all site/account writers.
      await client.query("select pg_advisory_xact_lock(hashtextextended('paymaster_execution:' || $1::text,0))", [gasExecutionKey(c.chainId, r.op)]);
      // This lock deliberately has no UTC day or paymaster component: the outstanding
      // authorization invariant must also hold across midnight and signer rotations.
      await client.query("select pg_advisory_xact_lock(hashtextextended('paymaster_account:' || $1::bigint::text || ':' || $2::text,0))",[c.chainId,r.op.sender]);
      const pinned = await client.query<{ day: string }>("select to_char(transaction_timestamp() at time zone 'UTC', 'YYYY-MM-DD') as day");
      const day = pinned.rows[0]?.day;
      if (!day) throw new Error('missing UTC day');
      await client.query("select pg_advisory_xact_lock(hashtextextended('paymaster_sponsorships:' || $1::bigint::text || ':' || to_char($2::date, 'YYYY-MM-DD'), 0))", [c.chainId, day]);
      if (r.budget.chainId !== c.chainId || !isAddressEqual(r.budget.account, r.op.sender) || r.budget.gasLimit !== r.gasLimit || r.budget.maxFeePerGas !== r.maxFee) throw rejected('GAS_BUDGET_CONFLICT', 409);
      if (r.setupGasRetry) r = await applySetupRetry(r, client);
      for(const proof of r.consumedAuthorizations??[]){
        const prior=(await client.query<{day:string}>("select to_char(utc_day,'YYYY-MM-DD') as day from gas_budget_reservations where execution_key=$1 and chain_id=$2 and account=$3",[proof.executionKey,c.chainId,r.op.sender])).rows[0];
        if(prior){
          await client.query("select pg_advisory_xact_lock(hashtextextended('gas_budget_reservations:'||$1::bigint::text||':'||$2::text||':'||$3::text,0))",[c.chainId,r.op.sender,prior.day]);
          await client.query("update gas_budget_reservations set state=$2,updated_at=greatest(updated_at,clock_timestamp()) where execution_key=$1 and state in ('reserved','submitted','unknown')",[proof.executionKey,proof.success?'confirmed':'failed']);
        }
        await client.query("update paymaster_sponsorships set state=$4,updated_at=greatest(updated_at,clock_timestamp()) where chain_id=$1 and sender=$2 and user_op_hash=$3 and state not in ('confirmed','failed')",[c.chainId,r.op.sender,proof.userOpHash,proof.success?'confirmed':'failed']);
      }
      await applyExpiredExitProofs(client,c.chainId,r.op.sender,r.expiredAuthorizations??[]);
      const pendingExit=pureYieldWithdraw(r.op,c)&&(await client.query("select execution_key from gas_budget_reservations where chain_id=$1 and account=$2 and purpose='exit' and state in ('reserved','submitted','unknown') limit 1",[c.chainId,r.op.sender])).rows.length>0;
      // A request that arrived earlier may acquire the execution lock later. Refresh after waiting.
      const now = (r.now ?? (() => Math.floor(Date.now() / 1000)))();
      const candidates = await client.query<{ user_op_hash: Hex; valid_until: Date; state:string }>(`select user_op_hash,valid_until,state
        from paymaster_sponsorships where chain_id=$1 and paymaster=$2 and sender=$3
        and valid_until>to_timestamp($4::double precision) order by valid_until`,
        [c.chainId, c.address.toLowerCase(), r.op.sender.toLowerCase(), now]);
      let reusable: { until: number; hash: Hex } | undefined;
      for (const candidate of r.setupGasRetry ? [] : candidates.rows) {
        const until = candidate.valid_until.getTime() / 1000;
        // Matching the complete EntryPoint hash binds every field, including gas and fees.
        if (Number.isSafeInteger(until) && (await authorization(r.op, c, until)).userOpHash === candidate.user_op_hash) {
          reusable = { until, hash: candidate.user_op_hash };
          break;
        }
      }
      if (r.ordinaryGasRetry) {
        if (c.chainId !== 97 || r.budget.purpose !== 'ordinary' || r.budget.executionKey !== sponsorshipGasKey(r.op, c)) throw rejected('GAS_BUDGET_CONFLICT', 409);
        if (reusable) {
          // Exact live retries issued before this change retain their original charge too.
          const bound = (await client.query<{ execution_key: string }>("select value->>'executionKey' as execution_key from yield_runtime_state where name=$1 and kind='fact'",
            [`auth-${reusable.hash.slice(2)}`])).rows[0];
          if (bound?.execution_key === gasExecutionKey(c.chainId, r.op)) r = { ...r, budget: { ...r.budget, executionKey: bound.execution_key } };
        }
        // The account lock serializes ALL calldata/nonce variants, also across UTC days.
        // Include legacy keys bound by immutable auth facts, plus the original execution
        // key for pre-fact reservations. Failed/unknown attempts still count forever.
        const attempts = await client.query<{ count: string; existing: boolean; authorizations: string }>(`select count(*)::text as count,
          coalesce(bool_or(execution_key=$3),false) as existing,
          (select count(*)::text from yield_runtime_state f where f.kind='fact' and f.name like 'auth-%'
            and f.value @> jsonb_build_object('chainId',$1::bigint,'account',$2::text,'nonce',$6::text)) as authorizations
          from gas_budget_reservations g
          where chain_id=$1 and account=$2 and (starts_with(execution_key,$4) or execution_key=$5 or exists (
            select 1 from yield_runtime_state f where f.kind='fact' and f.name like 'auth-%'
            and f.value @> jsonb_build_object('chainId',$1::bigint,'account',$2::text,'nonce',$6::text,'executionKey',g.execution_key)))`,
          [c.chainId, r.op.sender, r.budget.executionKey, sponsorshipNoncePrefix(c.chainId, r.op), gasExecutionKey(c.chainId, r.op), r.op.nonce.toString()]);
        const usage = attempts.rows[0];
        if (!usage || typeof usage.count !== 'string' || !/^\d+$/.test(usage.count) || typeof usage.existing !== 'boolean' ||
            typeof usage.authorizations !== 'string' || !/^\d+$/.test(usage.authorizations)) throw rejected('PAYMASTER_STORAGE_UNAVAILABLE', 503);
        if ((!usage.existing && BigInt(usage.count) >= 3n) || (!reusable && BigInt(usage.authorizations) >= 3n)) throw rejected('PAYMASTER_GAS_RETRY_LIMIT', 429);
      }
      await reserveBudgetOnClient(r.budget, client, day, loadTradingConfig(process.env, c.chainId));
      if (reusable) return reusable.until;
      const previous = await client.query<{ matches: boolean }>(`select (chain_id = $2 and paymaster = $3 and sender = $4 and
        verification_gas_limit = $5::numeric and call_gas_limit = $6::numeric and pre_verification_gas = $7::numeric and
        paymaster_verification_gas_limit = $8::numeric and paymaster_post_op_gas_limit = $9::numeric and max_fee_per_gas = $10::numeric and
        valid_until = to_timestamp($11::double precision)) as matches from paymaster_sponsorships where user_op_hash = $1`, reservationParams(r));
      if (previous.rows.length > 0) {
        if (previous.rows[0]?.matches !== true) throw rejected('PAYMASTER_RESERVATION_CONFLICT', 409);
        return r.validUntil;
      }
      // At most one unconsumed authorization per yield-exit account. Exact live retries above
      // reuse it. Canonically consumed signatures permit the next real exit immediately;
      // all historical gas/site charges remain, including expired or failed requests.
      if(pendingExit)throw rejected('PAYMASTER_EXIT_AUTHORIZATION_PENDING',429);
      const usage = await client.query<{ count: string; gas: string; wei: string; account_count: string; account_gas: string; account_wei: string }>(`
        select count(*)::text as count, coalesce(sum(gas_limit),0)::text as gas, coalesce(sum(max_cost_wei),0)::text as wei,
          count(*) filter (where sender = $3)::text as account_count,
          coalesce(sum(gas_limit) filter (where sender = $3),0)::text as account_gas,
          coalesce(sum(max_cost_wei) filter (where sender = $3),0)::text as account_wei
          from paymaster_sponsorships where chain_id = $1 and utc_day = $2::date`, [c.chainId, day, r.op.sender]);
      const u = usage.rows[0];
      if (!u) throw new Error('missing usage');
      const accountBudgets: (readonly [bigint, bigint, bigint])[] = r.budget.purpose !== 'ordinary' ? [] :
        [[BigInt(u.account_count), 1n, c.accountDailyCount], [BigInt(u.account_gas), r.gasLimit, c.accountDailyGas],
          ...(c.accountDailyWei === null ? [] : [[BigInt(u.account_wei), r.maxCostWei, c.accountDailyWei] as const])];
      const budgets: (readonly [bigint, bigint, bigint])[] = [...accountBudgets, [BigInt(u.gas), r.gasLimit, c.siteDailyGas], [BigInt(u.wei), r.maxCostWei, c.siteDailyWei]];
      if (budgets.some(([used, amount, cap]) => cap === 0n || used + amount > cap)) throw rejected('PAYMASTER_QUOTA_EXCEEDED', 429);
      if(c.chainId===97&&r.budget.purpose==='exit'){
        const unused=await unusedExitUsage((sql,params)=>client.query(sql,params?[...params]:[]),c.chainId,r.op.sender,day);
        if(unused.count>=3n)throw rejected('PAYMASTER_EXIT_RETRY_LIMIT',429);
        // Reserve room for this authorization to expire unused too. Checking only past
        // releases permits the last signature to overshoot the account's 10% share.
        if(unused.gas+r.gasLimit>c.siteDailyGas/10n||unused.wei+r.maxCostWei>c.siteDailyWei/10n)
          throw rejected('PAYMASTER_EXIT_UNUSED_BUDGET_EXCEEDED',429);
      }
      await rememberExitFacts({chainId:c.chainId,account:r.op.sender,userOpHash:r.hash,executionKey:r.budget.executionKey,nonce:r.op.nonce.toString(),validUntil:r.validUntil,purpose:r.budget.purpose},(sql,params)=>client.query(sql,params?[...params]:[]));
      if(pureYieldWithdraw(r.op,c)){
        const original=(await client.query<{day:string}>("select to_char(utc_day,'YYYY-MM-DD') as day from gas_budget_reservations where execution_key=$1 and state='failed'",[r.budget.executionKey])).rows[0];
        if(original){
          await client.query("select pg_advisory_xact_lock(hashtextextended('gas_budget_reservations:'||$1::bigint::text||':'||$2::text||':'||$3::text,0))",[c.chainId,r.op.sender,original.day]);
          await client.query("update gas_budget_reservations set state='reserved',updated_at=greatest(updated_at,clock_timestamp()) where execution_key=$1 and state='failed'",[r.budget.executionKey]);
        }
      }
      await client.query(`insert into paymaster_sponsorships (user_op_hash,chain_id,paymaster,sender,verification_gas_limit,call_gas_limit,
        pre_verification_gas,paymaster_verification_gas_limit,paymaster_post_op_gas_limit,max_fee_per_gas,valid_until)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,to_timestamp($11::double precision))`, reservationParams(r));
      return r.validUntil;
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw rejected('PAYMASTER_STORAGE_UNAVAILABLE', 503);
  }
}
function reservationParams(r: Reservation): (string | number)[] {
  return [r.hash, r.config.chainId, r.config.address.toLowerCase(), r.op.sender.toLowerCase(), r.verificationGas.toString(), r.callGas.toString(),
    r.op.preVerificationGas.toString(), r.config.verificationGasLimit.toString(), r.config.postOpGasLimit.toString(), r.maxFee.toString(), r.validUntil];
}
async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(rejected('PAYMASTER_DEPENDENCY_UNAVAILABLE', 503, `timeout after ${ms} ms`)), ms); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
function rpc(c: PaymasterConfig) { return createPublicClient({ transport: rpcTransport('paymaster', c.rpcUrl, { timeout: c.timeoutMs, retryCount: 0 }) }); }
export async function readPaymasterDeposit(c: PaymasterConfig): Promise<bigint> {
  const client = rpc(c);
  if (await client.getChainId() !== c.chainId) throw rejected('PAYMASTER_CHAIN_MISMATCH', 503);
  return client.readContract({ address: KERNEL_V3_3_ADDRESSES.entryPointV07, abi: ENTRY_POINT_ABI, functionName: 'balanceOf', args: [c.address] });
}
async function checkChain(op: PackedSponsorOperation, c: PaymasterConfig): Promise<void> {
  const client = rpc(c);
  if (await client.getChainId() !== c.chainId) throw rejected('PAYMASTER_CHAIN_MISMATCH', 503);
  const [signer, entryPoint, code, deposit] = await Promise.all([
    client.readContract({ address: c.address, abi: PM_ABI, functionName: 'verifyingSigner' }),
    client.readContract({ address: c.address, abi: PM_ABI, functionName: 'entryPoint' }),
    client.getCode({ address: op.sender }),
    client.readContract({ address: KERNEL_V3_3_ADDRESSES.entryPointV07, abi: ENTRY_POINT_ABI, functionName: 'balanceOf', args: [c.address] }),
  ]);
  if (!isAddressEqual(signer, privateKeyToAccount(c.signerPrivateKey).address) || !isAddressEqual(entryPoint, KERNEL_V3_3_ADDRESSES.entryPointV07)) throw rejected('PAYMASTER_CONFIGURATION_MISMATCH', 503);
  if (deposit < gasCost(op, c).maxCostWei) throw rejected('PAYMASTER_DEPOSIT_INSUFFICIENT', 503);
  if (op.initCode === '0x') {
    if (!code || code === '0x') throw rejected('PAYMASTER_ACCOUNT_UNDEPLOYED', 403);
    const impl = await client.getStorageAt({ address: op.sender, slot: IMPLEMENTATION_SLOT });
    if (impl === undefined || !isAddressEqual(slice(impl, 12), KERNEL_V3_3_ADDRESSES.kernelImplV33)) throw rejected('PAYMASTER_ACCOUNT_IMPLEMENTATION', 403);
  } else {
    if (code && code !== '0x') throw rejected('PAYMASTER_ACCOUNT_ALREADY_DEPLOYED', 403);
    const factory = slice(op.initCode, 0, 20);
    const factoryData = slice(op.initCode, 20);
    const decoded = decodeFunctionData({ abi: META_FACTORY_ABI, data: factoryData });
    if (!isAddressEqual(factory, KERNEL_V3_3_ADDRESSES.kernelMetaFactory) || !isAddressEqual(decoded.args[0], KERNEL_V3_3_ADDRESSES.kernelFactoryV33) ||
        encodeFunctionData({ abi: META_FACTORY_ABI, functionName: decoded.functionName, args: decoded.args }).toLowerCase() !== factoryData.toLowerCase()) throw rejected('PAYMASTER_FACTORY_FORBIDDEN', 403);
    // Canonical CREATE2 factory binds initData to the address. Changing its owner/hooks changes sender.
    const created = await client.readContract({ address: factory, abi: META_FACTORY_ABI, functionName: 'deployWithFactory', args: decoded.args });
    if (!isAddressEqual(created, op.sender)) throw rejected('PAYMASTER_FACTORY_SENDER_MISMATCH', 403);
  }
}

async function authorization(op: PackedSponsorOperation, c: PaymasterConfig, validUntil: number) {
  const signedOp = { ...op, paymasterAndData: header(c) };
  const hash = verifyingPaymasterHash(signedOp, c, validUntil, 0);
  const signature = await privateKeyToAccount(c.signerPrivateKey).signMessage({ message: { raw: hash } });
  const paymasterData = concatHex([encodeAbiParameters([{ type: 'uint48' }, { type: 'uint48' }], [validUntil, 0]), signature]);
  const paymasterAndData = concatHex([header(c), paymasterData]);
  // Actual EntryPoint v0.7 UserOp hash, including the final paymaster authorization, excluding account signature.
  const userOpHash=packedOperationHash({...op,paymasterAndData},c.chainId);
  return { paymasterAndData, paymaster: c.address, paymasterData, paymasterVerificationGasLimit: c.verificationGasLimit,
    paymasterPostOpGasLimit: c.postOpGasLimit, validUntil, validAfter: 0, userOpHash };
}
export function packedOperationHash(op:PackedSponsorOperation,chainId:number):Hex{
  const packedHash = keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' }],
    [op.sender, op.nonce, keccak256(op.initCode), keccak256(op.callData), op.accountGasLimits, op.preVerificationGas, op.gasFees, keccak256(op.paymasterAndData)]));
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }], [packedHash, KERNEL_V3_3_ADDRESSES.entryPointV07, BigInt(chainId)]));
}

async function readAccountCash(account: Address, c: PaymasterConfig): Promise<bigint> {
  return rpc(c).readContract({ address: TESTNET_97.contracts.usdt, abi: ENTRY_POINT_ABI, functionName: 'balanceOf', args: [account] });
}
/**
 * Withdraw to wallet (USDT transfer to the owner) never takes cash a running buy job or the withdrawal/yield
 * reservations hold (src/withdrawable-cash.ts). Taking it left portfolio 12 stuck in [CASH_DEFICIT] on 2026-11-23.
 */
async function checkFreeCash(op: PackedSponsorOperation, calls: ReturnType<typeof sponsoredCalls>, c: PaymasterConfig, owner: Address, deps: PaymasterDeps): Promise<void> {
  if (c.chainId !== 97) return;
  let out = 0n;
  for (const call of calls) {
    if (!isAddressEqual(call.target, TESTNET_97.contracts.usdt) || !call.callData.startsWith(toFunctionSelector('transfer(address,uint256)'))) continue;
    const decoded = decodeFunctionData({ abi: TOKEN_ABI, data: call.callData });
    if (decoded.functionName === 'transfer' && isAddressEqual(decoded.args[0], owner)) out += decoded.args[1];
  }
  if (out === 0n) return;
  // A DCA Venus return redeems into the account in the same UserOp; that forward is bounded by dcaVaultCall instead.
  if (calls.some(call => { try { return dcaVaultCall(call, op.sender, owner); } catch { return false; } })) return;
  const rows = (await (deps.query ?? query)(`select b.reserved_input_raw::text,b.reserved_fee_raw::text,b.withdrawal_raw::text,b.yield_raw::text
    from strategy_cash_balances b join smart_accounts s on (s.chain_id,s.portfolio_id)=(b.chain_id,b.portfolio_id)
    where s.chain_id=$1 and s.address=$2 and s.retired_at is null`, [c.chainId, op.sender])).rows;
  let reserved = 0n;
  try { for (const row of rows) { const r = object(row); if ('reserved_input_raw' in r) reserved += reservedCash(r); } }
  catch { throw rejected('PAYMASTER_DEPENDENCY_UNAVAILABLE', 503, 'free cash: unreadable cash buckets'); }
  if (reserved === 0n) return;
  const observed = await (deps.readCash ?? readAccountCash)(op.sender, c);
  const free = observed > reserved ? observed - reserved : 0n;
  if (out > free) throw rejected('PAYMASTER_WITHDRAW_RESERVED', 409, `free cash: withdraw exceeds free cash by ${out - free}`);
}

export function createPaymasterService(deps: PaymasterDeps = {}) {
  return { async sponsor(input: unknown, wallet: string) {
    try {
      const c = deps.config === undefined ? loadPaymasterConfig() : deps.config;
      if (c === null) throw rejected('PAYMASTER_DISABLED', 503);
      const request = object(input);
      if (Object.keys(request).some((key) => !['userOperation', 'validUntil'].includes(key))) throw rejected('PAYMASTER_INVALID_OPERATION');
      const op = parsePackedSponsorOperation(request.userOperation);
      if (c.chainId === 97 && op.initCode !== '0x') throw rejected('PAYMASTER_ACCOUNT_UNDEPLOYED', 403);
      const now = (deps.now ?? (() => Math.floor(Date.now() / 1000)))();
      const requestedUntil = request.validUntil;
      if (requestedUntil !== undefined && (typeof requestedUntil !== 'number' || !Number.isSafeInteger(requestedUntil) || requestedUntil <= now)) throw rejected('PAYMASTER_EXPIRED');
      if (op.paymasterAndData !== '0x') throw rejected('PAYMASTER_INVALID_OPERATION');
      const calls = sponsoredCalls(op);
      const known = await bounded((deps.query ?? query)(`select s.owner,p.user_id,m.id as mix_id from smart_accounts s join portfolios p on p.id=s.portfolio_id
        left join mixes m on (m.chain_id,m.account)=(s.chain_id,s.address)
        where s.chain_id=$1 and s.address=$2 and s.account_type='KERNEL' and s.retired_at is null
        union all select m.owner,m.owner as user_id,m.id as mix_id from mixes m where m.chain_id=$1 and m.account=$2
          and not exists(select 1 from smart_accounts s where s.chain_id=$1 and s.address=$2 and s.retired_at is null)`, [c.chainId, op.sender]), c.timeoutMs);
      let owner = known.rows.length === 1 ? object(known.rows[0]) : null;
      if (known.rows.length === 0 && c.chainId === 97) {
        // First join: the operator deployed the account seconds ago and the read node may still lag (src/node-lag.ts
        // waits up to NODE_LAG_BUDGET_MS). 2026-11-23 14:33 the plain 5 s bound cut that wait short: 503 on the first try.
        await bounded((deps.enrollmentSetup ?? verifyEnrollmentSponsorship)(op, c, wallet), c.timeoutMs + (deps.enrollmentLagMs ?? NODE_LAG_BUDGET_MS));
        owner = { owner: wallet, user_id: wallet };
      }
      if (!owner || typeof owner.owner !== 'string' || typeof owner.user_id !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(wallet) ||
          owner.owner.toLowerCase() !== wallet.toLowerCase() || owner.user_id.toLowerCase() !== wallet.toLowerCase()) throw rejected('PAYMASTER_SENDER_FORBIDDEN', 403);
      const isMix = owner.mix_id !== null && owner.mix_id !== undefined;
      const mixDca = (call: { target: Address; callData: Hex }) => mixDcaCall(call, op.sender, hex(owner.owner, 20), c);
      const rewardTokens = deps.rewardTokens ?? sponsoredRewardTokens(c.chainId);
      const isRewardToken = (target: Address) => rewardTokens.some(token => isAddressEqual(target, token));
      // USDT and reward tokens (LISTA / XVS) going to the owner's wallet; the recipient is checked in validateSponsoredCalls.
      const onlyOwnerCash = calls.length > 0 && calls.every(call => (isAddressEqual(call.target, TESTNET_97.contracts.usdt) || isRewardToken(call.target)) &&
        call.callData.startsWith(toFunctionSelector('transfer(address,uint256)')));
      // DCA open/return/redemption: every call is a DCA call, a USDT transfer (Venus return, checked to the owner below)
      // or a session renewal pair, with at least one vault deposit/return or redemption.
      const dcaOnly = isMix && calls.some(call => ['vault', 'redeem'].includes(mixDca(call) ?? '')) &&
        calls.every(call => mixDca(call) !== null || isAddressEqual(call.target, op.sender) ||
          isAddressEqual(call.target, TESTNET_97.contracts.usdt) && call.callData.startsWith(toFunctionSelector('transfer(address,uint256)')));
      // Yield strategy only (with an optional session renewal pair, like a fund's turn-on): owner consent/open/close or
      // the scheduler's session-key steps. Not an enrollment change, so no mix lock, like DCA.
      const strategyV2 = deps.strategyV2 === undefined ? strategyEarnV2(c.chainId) : deps.strategyV2;
      const mixStrategy = (call: { target: Address; callData: Hex }) => mixStrategyCall(call, c, strategyV2 ? { v2: strategyV2, sender: op.sender, owner: hex(owner.owner, 20) } : undefined);
      const strategyOnly = isMix && calls.some(call => mixStrategy(call) !== null) &&
        calls.every(call => mixStrategy(call) !== null || isAddressEqual(call.target, op.sender));
      const authorize = async () => {
      let intentToSubmit: MixIntent | null = null;
      if (owner.mix_id !== null && owner.mix_id !== undefined) {
        const m = (await bounded((deps.query ?? query)(`select ${MIX_COLUMNS} from mixes m where m.id=$1 and m.owner=$2 and m.deleted_at is null`,
          [owner.mix_id, wallet.toLowerCase()]), c.timeoutMs)).rows[0] as MixRow | undefined;
        if (!m || c.chainId !== 97) throw rejected('PAYMASTER_SENDER_FORBIDDEN', 403);
        // Per-asset yield stays off for My mix; only a DCA period redemption (session key, DCA vault market) may withdraw.
        if (calls.some(call => isAddressEqual(call.target, TESTNET_97.contracts.yieldRegistry) ||
            call.callData.startsWith(toFunctionSelector('executeSupply(address,bytes32,uint256,uint256,uint256)')) ||
            call.callData.startsWith(toFunctionSelector('executeWithdraw(address,bytes32,uint256,uint256,uint256)')) && mixDca(call) !== 'redeem')) {
          throw rejected('PAYMASTER_CALL_FORBIDDEN', 403, 'my mix: per-asset yield call');
        }
        const ownerChange = calls.some(call => isAddressEqual(call.target, c.registry) ||
          call.callData.startsWith(toFunctionSelector('approve(address,uint256)')) && mixDca(call) !== 'approval' && mixStrategy(call) === null);
        for (const call of calls) {
          if (call.callData.startsWith(toFunctionSelector('transfer(address,uint256)')) && !isAddressEqual(call.target, TESTNET_97.contracts.usdt) && !isRewardToken(call.target)) {
            throw rejected('PAYMASTER_CALL_FORBIDDEN', 403);
          }
        }
        const intent = (await bounded((deps.query ?? query)(`select * from mix_switch_intents where mix_id=$1 and ${pendingMixSql}`, [m.id]), c.timeoutMs)).rows[0] as MixIntent | undefined;
        if (ownerChange) {
          if (!intent || op.initCode !== '0x') throw rejected('PAYMASTER_CALL_FORBIDDEN', 403, intent ? 'my mix: undeployed' : 'my mix: owner change without a pending mix change');
          await bounded((deps.mixSetup ?? verifyMixOwnerCalls)(m, intent, calls, op.nonce), c.timeoutMs);
          intentToSubmit = intent;
        } else {
          // A DCA or yield strategy UserOp waits for a pending mix change to settle (retryable), like the owner's other actions.
          if (intent && (dcaOnly || strategyOnly)) throw mixBusy();
          // An exiting (take profit / stop loss), exited or deleting mix sells everything: no new collateral, borrowing or consent.
          if ((m.triggered_at !== null || m.status === 'exited' || m.delete_requested_at) && calls.some(call => mixStrategy(call) === 'risk')) {
            throw rejected('PAYMASTER_CALL_FORBIDDEN', 403, 'my mix: yield strategy while exiting');
          }
          if (intent && !onlyOwnerCash) throw rejected('PAYMASTER_CALL_FORBIDDEN', 403, 'my mix: pending mix change');
          if (!onlyOwnerCash) {
          const settings = (await bounded((deps.query ?? query)(`select ms.exit_assets from mix_strategy_settings ms
            join mix_portfolio_history h on h.strategy_id=ms.strategy_id where h.mix_id=$1 and h.ended_at is null`, [m.id]), c.timeoutMs)).rows[0];
          if (settings === undefined) throw rejected('PAYMASTER_DEPENDENCY_UNAVAILABLE', 503);
          const exits = object(settings).exit_assets;
          if (!Array.isArray(exits) || !exits.every(a => typeof a === 'string')) throw rejected('PAYMASTER_DEPENDENCY_UNAVAILABLE', 503);
          for (let i = 0; i < calls.length; i++) {
            const call = calls[i];
            if (!call) throw rejected('PAYMASTER_CALL_FORBIDDEN', 403);
            if (isAddressEqual(call.target, op.sender)) {
              const grant = calls[++i];
              if (!grant || !isAddressEqual(grant.target, op.sender) || grant.value !== 0n) throw rejected('PAYMASTER_CALL_FORBIDDEN', 403, 'my mix: incomplete renewal');
              // Same scopes as a fund account: /renewal-params installs yield+borrow on chain 97 (DCA needs the yield calls).
              try { validateAnyRenewal(call.callData, grant.callData, c, op.sender, strategyV2); }
              catch (error) { throw rejected('PAYMASTER_CALL_FORBIDDEN', 403, `my mix: ${checkName(error)}`); }
            } else if (isAddressEqual(call.target, c.executor)) {
              if (mixDca(call) === 'redeem') continue;
              const decoded = decodeFunctionData({ abi: EXECUTOR_ABI, data: call.callData });
              if (decoded.functionName !== 'executeRebalance' || decoded.args[1].some(step => exits.includes(step.tokenOut.toLowerCase()) ||
                  (m.triggered_at !== null || m.status === 'exited') && !isAddressEqual(step.tokenOut, TESTNET_97.contracts.usdt))) throw rejected('PAYMASTER_CALL_FORBIDDEN', 403, 'my mix: rebalance');
            }
          }
          }
        }
      }
      // Chain 97 never falls back to mainnet's DB seed. Local forks use the existing enabled address book.
      let assets: Address[] = [];
      if (c.chainId !== 97 && calls.some((call) => TOKEN_ABI.some((fn) => call.callData.startsWith(toFunctionSelector(fn))))) {
        const result = await bounded((deps.query ?? query)('select address from priceable_assets where enabled', []), c.timeoutMs);
        assets = result.rows.map((row) => {
          const address = object(row).address;
          if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('invalid asset address');
          return hex(address, 20);
        });
      }
      validateSponsoredCalls(op, c, { owner: hex(owner.owner, 20), assets, rewardTokens, v2: strategyV2 });
      await bounded(checkFreeCash(op, calls, c, hex(owner.owner, 20), deps), c.timeoutMs);
      const cost = gasCost(op, c);
      if (cost.gasLimit > MAX_USER_OP_GAS) throw rejected('PAYMASTER_USER_OP_CAPACITY', 400);
      await bounded((deps.checkChain ?? checkChain)(op, c), c.timeoutMs);
      const attemptKey = deps.retryOrdinaryGas && c.chainId === 97 ? sponsorshipGasKey(op, c) : undefined;
      const context = await bounded(deps.readBudgetContext ? deps.readBudgetContext(op, c) : readBudgetContext(op, c, attemptKey, deps.retrySetup && c.chainId === 97), c.timeoutMs);
      const setupGasRetry = deps.retrySetup === true && c.chainId === 97 && context.purpose === 'setup';
      const setupProof = setupGasRetry ? await bounded(setupRetryProof(op, c, deps.query ?? query, now), c.timeoutMs) : undefined;
      let consumedAuthorizations:readonly ConsumedAuthorization[]=[];
      let expiredAuthorizations:readonly ExpiredExitProof[]=[];
      if (pureYieldWithdraw(op, c)) context.purpose = 'exit';
      if (deps.exitCallData !== undefined && deps.exitCallData.toLowerCase() === op.callData.toLowerCase()) {
        const executorCall = calls.length === 1 ? calls[0] : undefined;
        const decoded = executorCall !== undefined && isAddressEqual(executorCall.target, c.executor)
          ? decodeFunctionData({ abi: EXECUTOR_ABI, data: executorCall.callData }) : null;
        const numeraire = c.chainId === 97 ? TESTNET_97.contracts.usdt : '0x55d398326f99059ff775485246999027b3197955';
        if (decoded?.functionName !== 'executeRebalance' || !decoded.args[1].every((step) => isAddressEqual(step.tokenOut, numeraire))) throw rejected('GAS_BUDGET_INVALID', 503);
        context.purpose = 'exit';
      }
      const exit=c.chainId===97&&context.purpose==='exit';
      // Keep authorization lifetimes bounded. New chain-97 exits use exactly ten
      // minutes; live retries below still reuse the original hash without extension.
      const lifetime=exit?600:300;
      let validUntil=requestedUntil??now+lifetime;
      if (intentToSubmit?.user_op_hash) {
        const previous = (await bounded((deps.query ?? query)(`select valid_until from paymaster_sponsorships
          where user_op_hash=$1 and sender=$2 and chain_id=97`, [intentToSubmit.user_op_hash, op.sender]), c.timeoutMs)).rows[0];
        const at = previous === undefined ? undefined : object(previous).valid_until;
        if (!(at instanceof Date) || !Number.isSafeInteger(at.getTime() / 1000)) throw rejected('PAYMASTER_DEPENDENCY_UNAVAILABLE', 503);
        validUntil = at.getTime() / 1000;
        if (requestedUntil !== undefined && requestedUntil !== validUntil) throw rejected('PAYMASTER_CALL_FORBIDDEN', 403);
      }
      if(validUntil>now+lifetime||exit&&validUntil<now+600)throw rejected('PAYMASTER_EXPIRED');
      await checkMixLock();
      let signed=await authorization(op,c,validUntil);
      if (intentToSubmit?.user_op_hash && intentToSubmit.user_op_hash !== signed.userOpHash) throw rejected('PAYMASTER_CALL_FORBIDDEN', 403);
      if (pureYieldWithdraw(op, c)) {
        consumedAuthorizations=await bounded((deps.verifyYieldWithdraw??verifyYieldWithdraw)({...op,paymasterAndData:signed.paymasterAndData},c,now,deps.query??query),c.timeoutMs);
        if(!deps.verifyYieldWithdraw)expiredAuthorizations=await bounded(expiredExitProofs(c,op.sender,deps.query??query),c.timeoutMs);
      }
      const ordinaryGasRetry = attemptKey !== undefined && context.purpose === 'ordinary';
      const reservedUntil = await (deps.reserve ?? reserveSponsorship)({ hash: signed.userOpHash, op, config: c, validUntil, now: deps.now ?? (() => Math.floor(Date.now() / 1000)), ...cost,
        consumedAuthorizations,expiredAuthorizations,ordinaryGasRetry,setupGasRetry,setupRetryProof:setupProof,
        budget: { executionKey: ordinaryGasRetry ? attemptKey : gasExecutionKey(c.chainId, op), chainId: c.chainId, account: op.sender,
          gasLimit: cost.gasLimit, maxFeePerGas: cost.maxFee, ...context } });
      if (reservedUntil !== undefined && reservedUntil !== validUntil) {
        validUntil = reservedUntil;
        signed = await authorization(op, c, validUntil);
      }
      if ((deps.now ?? (() => Math.floor(Date.now() / 1000)))() >= validUntil) throw rejected('PAYMASTER_EXPIRED');
      await checkMixLock();
      if (intentToSubmit) {
        if (intentToSubmit.user_op_hash && intentToSubmit.user_op_hash !== signed.userOpHash ||
            intentToSubmit.nonce === null || BigInt(intentToSubmit.nonce) !== op.nonce) throw rejected('PAYMASTER_CALL_FORBIDDEN', 403);
        const saved = await bounded((deps.query ?? query)(`update mix_switch_intents set state=case when state='prepared' then 'submitted' else state end,
          user_op_hash=$2,nonce=$3,updated_at=clock_timestamp() where id=$1 and state in ('prepared','submitted','unknown')
          and (user_op_hash is null or user_op_hash=$2) and nonce=$3::numeric returning id`,
          [intentToSubmit.id, signed.userOpHash, op.nonce.toString()]), c.timeoutMs);
        if (saved.rows.length !== 1) throw rejected('PAYMASTER_DEPENDENCY_UNAVAILABLE', 503);
      }
      // A withdrawal to the owner is an owner action: a strategy job paused after real failures runs again
      // (src/strategy-job-recovery.ts). Best effort, never fails the sponsorship.
      if (onlyOwnerCash && c.chainId === 97) {
        try { await bounded((deps.resumePausedJobsForAccount ?? resumePausedJobsForAccount)(c.chainId, op.sender), c.timeoutMs); } catch { /* next action or round */ }
      }
      return signed;
      };
      // The mix lock serialises enrollment changes and buys/sells against the mix state. A DCA UserOp or a USDT
      // withdrawal to the owner changes neither (both still refuse during a pending mix change, checked above),
      // so they must not fail with MIX_BUSY while the scheduler or a mix refresh holds the lock.
      return isMix && !dcaOnly && !onlyOwnerCash && !strategyOnly
        ? await (deps.mixLock ?? withMixLock)(String(owner.mix_id), authorize) : await authorize();
    } catch (error) {
      const safe = error instanceof AppError ? error : rejected('PAYMASTER_DEPENDENCY_UNAVAILABLE', 503);
      // Never print request bytes, signatures, keys, RPC/DB exception text or connection strings.
      console.warn(JSON.stringify({ msg: 'paymaster_rejected', code: safe.code, status: safe.status,
        ...(safe.cause instanceof Error ? { reason: safe.cause.message.slice(0, 300) } : {}) }));
      throw safe;
    }
  } };
}
export async function sponsorUserOperation(input: unknown, wallet: string) { return createPaymasterService({ retryOrdinaryGas: true, retrySetup: true }).sponsor(input, wallet); }

/** viem's explicit estimate action prepares paymaster data before gas fields exist. Never sign there. */
export function estimationPaymaster(hooks: ReturnType<typeof schedulerPaymaster>): Pick<PaymasterActions, 'getPaymasterData'> | undefined {
  return hooks === undefined ? undefined : { getPaymasterData: hooks.getPaymasterStubData };
}

/** viem RPC errors contain the entire UserOp. Sponsored send/estimate boundaries must not log them. */
export function paymasterExecutionError(error: unknown): AppError {
  if (error instanceof GasBudgetExceededError) return error;
  const out = error instanceof AppError && (error.code.startsWith('PAYMASTER_') || error.code.startsWith('GAS_BUDGET_'))
    ? rejected(error.code, error.status) : rejected('PAYMASTER_SUBMISSION_UNAVAILABLE', 503);
  // The public code stays generic; the original error rides along as `cause` so the scheduler's own log (errorChain,
  // URLs masked) can say what really happened. 2026-11-24 portfolio 13: three sends in a row failed in about a second and
  // nothing anywhere recorded why.
  if (out !== error) (out as Error & { cause?: unknown }).cause = error;
  return out;
}

/** Standard viem hook: only the final, fully estimated op receives an authorization and durable charge. */
export function schedulerPaymaster(expectedSender: Address, deps: PaymasterDeps = {}): Pick<PaymasterActions, 'getPaymasterData' | 'getPaymasterStubData'> | undefined {
  const c = deps.config === undefined ? loadPaymasterConfig() : deps.config;
  if (c === null) return undefined;
  const ensureDomain = (args: GetPaymasterDataParameters) => {
    if (args.chainId !== c.chainId || !isAddressEqual(args.entryPointAddress, KERNEL_V3_3_ADDRESSES.entryPointV07) || !isAddressEqual(args.sender, expectedSender)) throw rejected('PAYMASTER_CHAIN_MISMATCH', 503);
  };
  return {
    getPaymasterStubData: async (args) => {
      ensureDomain(args);
      // A real low-s signature over zero (public anvil test vector), not repeated r/s bytes.
      // Its valid curve point lets v0.7 return SIG_VALIDATION_FAILED during estimation,
      // rather than reverting with ECDSAInvalidSignature before gas can be estimated.
      return { paymaster: c.address, paymasterVerificationGasLimit: c.verificationGasLimit, paymasterPostOpGasLimit: c.postOpGasLimit,
        paymasterData: concatHex([encodeAbiParameters([{ type: 'uint48' }, { type: 'uint48' }], [0, 0]), '0xe82ed51b2b3964a6779171ee6589b1b2f5b5ebb77c1555626205d4619cb8df271a3f5c43f6b0ea3c76d852252d8a19539aa3ca2cb9fb66af3ac4dee7e846b4321c']) };
    },
    getPaymasterData: async (args) => {
      try {
        ensureDomain(args);
        if (args.callGasLimit === undefined || args.verificationGasLimit === undefined || args.preVerificationGas === undefined || args.maxFeePerGas === undefined || args.maxPriorityFeePerGas === undefined) throw rejected('PAYMASTER_INVALID_OPERATION');
        const op = { sender: args.sender, nonce: args.nonce, callData: args.callData,
          initCode: args.factory ? concatHex([args.factory, args.factoryData ?? '0x']) : '0x',
          accountGasLimits: concatHex([toHex(args.verificationGasLimit, { size: 16 }), toHex(args.callGasLimit, { size: 16 })]),
          preVerificationGas: args.preVerificationGas, gasFees: concatHex([toHex(args.maxPriorityFeePerGas, { size: 16 }), toHex(args.maxFeePerGas, { size: 16 })]) };
        const known = await bounded((deps.query ?? query)('select owner from smart_accounts where chain_id = $1 and address = $2 and account_type = \'KERNEL\' and retired_at is null', [c.chainId, expectedSender.toLowerCase()]), c.timeoutMs);
        const owner = known.rows.length === 1 ? object(known.rows[0]).owner : undefined;
        if (typeof owner !== 'string') throw rejected('PAYMASTER_SENDER_FORBIDDEN', 403);
        const result = await createPaymasterService({ ...deps, config: c, retrySetup: false }).sponsor({ userOperation: op }, owner);
        return { paymaster: result.paymaster, paymasterData: result.paymasterData,
          paymasterVerificationGasLimit: result.paymasterVerificationGasLimit, paymasterPostOpGasLimit: result.paymasterPostOpGasLimit };
      } catch (error) { throw paymasterExecutionError(error); }
    },
  };
}

/** Manual binding of a legacy opaque hash requires the ORIGINAL signed packed UserOp.
 * Recompute both identities; never save signatures, supplied paths or unverified nonce claims.
 */
export async function bindExitAuthorizationEvidence(input:unknown):Promise<void>{
  const op=parsePackedSponsorOperation(input),hash=packedOperationHash(op,97),executionKey=gasExecutionKey(97,op);
  const [until,after]=decodeAbiParameters([{type:'uint48'},{type:'uint48'}],slice(op.paymasterAndData,52,116));
  if(after!==0||until===0)throw rejected('PAYMASTER_EXIT_INVALID',403);
  await withTransaction(async db=>{
    await db.query("select pg_advisory_xact_lock(hashtextextended('paymaster_account:97:'||$1::text,0))",[op.sender]);
    const row=(await db.query<{paymaster:Address;valid_until:Date;purpose:string}>(`select s.paymaster,s.valid_until,g.purpose from paymaster_sponsorships s join gas_budget_reservations g on g.chain_id=s.chain_id and g.account=s.sender
      where s.chain_id=97 and s.sender=$1 and s.user_op_hash=$2 and g.execution_key=$3 and s.state not in ('confirmed','failed','expired')`,[op.sender,hash,executionKey])).rows[0];
    if(!row||row.valid_until.getTime()!==until*1000||!isAddressEqual(row.paymaster,slice(op.paymasterAndData,0,20)))throw rejected('PAYMASTER_EXIT_INVALID',403);
    await rememberExitFacts({chainId:97,account:op.sender,userOpHash:hash,executionKey,nonce:op.nonce.toString(),validUntil:until,purpose:row.purpose},(sql,params)=>db.query(sql,params?[...params]:[]));
  });
}
