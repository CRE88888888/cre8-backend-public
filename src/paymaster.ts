import {
  concatHex, createPublicClient, decodeAbiParameters, decodeFunctionData, encodeAbiParameters,
  encodeFunctionData, http, isAddressEqual, keccak256, pad, parseAbi, slice, toHex, toFunctionSelector, zeroAddress,
} from 'viem';
import { KernelV3_3AccountAbi } from '@zerodev/sdk';
import { PolicyFlags } from '@zerodev/permissions';
import { CallPolicyVersion, toCallPolicy, toGasPolicy, toPolicyId, toTimestampPolicy } from '@zerodev/permissions/policies';
import { toEmptyECDSASigner, toSignerId } from '@zerodev/permissions/signers';
import type { Address, Hex, PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { GetPaymasterDataParameters, PaymasterActions } from 'viem/account-abstraction';
import { EXECUTOR_ABI, EXECUTOR_SELECTOR, REGISTRY_ABI } from './chain.js';
import { KERNEL_V3_3_ADDRESSES } from './addresses.js';
import { loadPaymasterConfig, loadTradingConfig } from './config.js';
import type { PaymasterConfig, TradingConfig } from './config.js';
import type { PoolClient } from 'pg';
import { query, withTransaction } from './db.js';
import { AppError } from './errors.js';
import { TESTNET_97, testnetAssets } from './testnet-profile.js';
import { SESSION_GAS_ALLOWED_WEI } from './permissions.js';

export type PackedSponsorOperation = {
  sender: Address; nonce: bigint; initCode: Hex; callData: Hex; accountGasLimits: Hex;
  preVerificationGas: bigint; gasFees: Hex; paymasterAndData: Hex; signature: Hex;
};
export type Reservation = {
  hash: Hex; op: PackedSponsorOperation; config: PaymasterConfig; validUntil: number;
  verificationGas: bigint; callGas: bigint; maxFee: bigint; gasLimit: bigint; maxCostWei: bigint;
  budget: GasBudgetRequest;
};
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
type Query = (sql: string, params?: readonly unknown[]) => Promise<{ rows: unknown[] }>;
export type PaymasterDeps = {
  config?: PaymasterConfig | null;
  now?: () => number;
  query?: Query;
  checkChain?: (op: PackedSponsorOperation, config: PaymasterConfig) => Promise<void>;
  reserve?: (request: Reservation) => Promise<void>;
  readBudgetContext?: (op: PackedSponsorOperation, config: PaymasterConfig) => Promise<BudgetContext>;
  /** Internal scheduler evidence, bound to the exact canonical Kernel calldata. Never request input. */
  exitCallData?: Hex;
};
export const KERNEL_EXECUTE_ABI = parseAbi(['function execute(bytes32 execMode,bytes executionCalldata) payable']);
const CLAIM_ABI = parseAbi(['function claim(uint256 amount)']);
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

function rejected(code: string, status = 400): AppError {
  return new AppError(status, code, 'paymaster sponsorship rejected: ' + code);
}
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
function sponsoredCalls(op: PackedSponsorOperation) {
  try {
    const data = op.callData.startsWith(EXECUTE_USER_OP_SELECTOR) ? slice(op.callData, 4) : op.callData;
    const decoded = decodeFunctionData({ abi: KERNEL_EXECUTE_ABI, data });
    if (encodeFunctionData({ abi: KERNEL_EXECUTE_ABI, functionName: decoded.functionName, args: decoded.args }).toLowerCase() !== data.toLowerCase()) throw new Error('noncanonical');
    const [mode, payload] = decoded.args;
    const single = toHex(0n, { size: 32 });
    const batch = toHex(1n << 248n, { size: 32 });
    const calls = mode === single ? [{ target: slice(payload, 0, 20), value: BigInt(slice(payload, 20, 52)), callData: slice(payload, 52) }]
      : mode === batch ? decodeAbiParameters(BATCH_ABI, payload)[0] : [];
    if (calls.length === 0 || calls.length > 32) throw new Error('empty/invalid mode');
    if (mode === batch && encodeAbiParameters(BATCH_ABI, [calls]).toLowerCase() !== payload.toLowerCase()) throw new Error('noncanonical batch');
    return calls;
  } catch { throw rejected('PAYMASTER_CALL_FORBIDDEN', 403); }
}

/** Match the SDK's complete two-call toInitConfig, never a general-purpose self-call or delegatecall. */
function validateRenewal(install: Hex, grant: Hex, c: PaymasterConfig): void {
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
    toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, policyAddress: p.callPolicy, permissions: [{ target: c.executor, selector: EXECUTOR_SELECTOR }] }),
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

type CallContext = { owner?: Address; assets?: readonly Address[] };
export function validateSponsoredCalls(op: PackedSponsorOperation, c: PaymasterConfig, context: CallContext = {}): void {
  try {
    const calls = sponsoredCalls(op);
    const assets = c.chainId === 97 ? testnetAssets().map((asset) => asset.address) : context.assets ?? [];
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index];
      if (call === undefined) throw new Error('missing call');
      if (call.value !== 0n) throw new Error('native transfer');
      if (isAddressEqual(call.target, op.sender)) {
        const next = calls[++index];
        if (next === undefined || next.value !== 0n || !isAddressEqual(next.target, op.sender)) throw new Error('incomplete renewal');
        validateRenewal(call.callData, next.callData, c);
      } else if (isAddressEqual(call.target, c.executor)) {
        const inner = decodeFunctionData({ abi: EXECUTOR_ABI, data: call.callData });
        if (inner.functionName !== 'executeRebalance' || !isAddressEqual(inner.args[0], op.sender) || inner.args[1].length === 0 ||
            encodeFunctionData({ abi: EXECUTOR_ABI, functionName: inner.functionName, args: inner.args }).toLowerCase() !== call.callData.toLowerCase()) throw new Error('invalid rebalance');
      } else if (isAddressEqual(call.target, c.registry)) {
        const inner = decodeFunctionData({ abi: REGISTRY_ABI, data: call.callData });
        if (inner.functionName !== 'enroll' || !isAddressEqual(inner.args[0], op.sender) || inner.args[1] === 0n ||
            encodeFunctionData({ abi: REGISTRY_ABI, functionName: inner.functionName, args: inner.args }).toLowerCase() !== call.callData.toLowerCase()) throw new Error('invalid enrollment');
      } else if (assets.some((asset) => isAddressEqual(call.target, asset)) &&
          TOKEN_ABI.some((fn) => call.callData.toLowerCase().startsWith(toFunctionSelector(fn)))) {
        const inner = decodeFunctionData({ abi: TOKEN_ABI, data: call.callData });
        if (encodeFunctionData({ abi: TOKEN_ABI, functionName: inner.functionName, args: inner.args }).toLowerCase() !== call.callData.toLowerCase()) throw new Error('noncanonical token call');
        if (inner.functionName === 'approve') {
          if (!isAddressEqual(inner.args[0], c.executor)) throw new Error('invalid spender');
        } else if (context.owner === undefined || !isAddressEqual(inner.args[0], context.owner) || inner.args[1] === 0n) throw new Error('invalid withdrawal');
      } else if (c.mockUsdt !== null && isAddressEqual(call.target, c.mockUsdt)) {
        const inner = decodeFunctionData({ abi: CLAIM_ABI, data: call.callData });
        if (inner.args[0] === 0n || encodeFunctionData({ abi: CLAIM_ABI, functionName: inner.functionName, args: inner.args }).toLowerCase() !== call.callData.toLowerCase()) throw new Error('invalid claim');
      } else throw new Error('unknown target');
    }
  } catch { throw rejected('PAYMASTER_CALL_FORBIDDEN', 403); }
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
export function gasExecutionKey(chainId: number, op: Pick<PackedSponsorOperation, 'sender' | 'nonce' | 'initCode' | 'callData'>): string {
  return keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' }],
    [BigInt(chainId), op.sender, op.nonce, keccak256(op.initCode), keccak256(op.callData)]));
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

async function readBudgetContext(op: PackedSponsorOperation, c: PaymasterConfig): Promise<BudgetContext> {
  const previous = await existingBudgetContext(gasExecutionKey(c.chainId, op));
  if (previous !== null) return previous;
  const client = rpc(c);
  const price = await readNativeBudgetPrice(client, c.executor, c.chainId);
  const calls = sponsoredCalls(op);
  const setup = calls.every((call) => call.callData.startsWith(toFunctionSelector('approve(address,uint256)')) || isAddressEqual(call.target, c.registry));
  // Public requests get an exit exemption only when every strategy token balance is fully sold/transferred.
  // A capped close is authorized through the internal scheduler evidence below instead.
  const tokenCalls = calls.every((call) => call.callData.startsWith(toFunctionSelector('transfer(address,uint256)')));
  const rebalance = calls.length === 1 && calls[0] !== undefined && isAddressEqual(calls[0].target, c.executor)
    ? decodeFunctionData({ abi: EXECUTOR_ABI, data: calls[0].callData }) : null;
  const priorSetup = setup ? await query("select execution_key from gas_budget_reservations where chain_id=$1 and account=$2 and purpose='setup' and state<>'failed'", [c.chainId, op.sender]) : null;
  let purpose: GasPurpose = setup && priorSetup?.rows.length === 0 ? 'setup' : 'ordinary';
  if (tokenCalls || rebalance?.functionName === 'executeRebalance') {
    const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
    const numeraire = await client.readContract({ address: c.executor, abi: BUDGET_ORACLE_ABI, functionName: 'numeraire', blockNumber });
    const enrollment = await client.readContract({ address: c.registry, abi: REGISTRY_ABI, functionName: 'enrollments', args: [op.sender], blockNumber });
    const version = await client.readContract({ address: c.registry,
      abi: parseAbi(['function version(uint256,uint16) view returns ((address[] assets,uint16[] weightsBps,bytes32 scheduleHash,uint64 activeAt))']),
      functionName: 'version', args: [enrollment[0], enrollment[1]], blockNumber });
    const assets = version.assets;
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
export async function reserveSponsorship(r: Reservation, transaction: typeof withTransaction = withTransaction): Promise<void> {
  const c = r.config;
  try {
    await transaction(async (client) => {
      await client.query('set transaction isolation level read committed');
      await client.query("select set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)", [String(c.timeoutMs)]);
      const pinned = await client.query<{ day: string }>("select to_char(transaction_timestamp() at time zone 'UTC', 'YYYY-MM-DD') as day");
      const day = pinned.rows[0]?.day;
      if (!day) throw new Error('missing UTC day');
      await client.query("select pg_advisory_xact_lock(hashtextextended('paymaster_sponsorships:' || $1::bigint::text || ':' || to_char($2::date, 'YYYY-MM-DD'), 0))", [c.chainId, day]);
      if (r.budget.chainId !== c.chainId || !isAddressEqual(r.budget.account, r.op.sender) || r.budget.gasLimit !== r.gasLimit || r.budget.maxFeePerGas !== r.maxFee) throw rejected('GAS_BUDGET_CONFLICT', 409);
      await reserveBudgetOnClient(r.budget, client, day, loadTradingConfig(process.env, c.chainId));
      const previous = await client.query<{ matches: boolean }>(`select (chain_id = $2 and paymaster = $3 and sender = $4 and
        verification_gas_limit = $5::numeric and call_gas_limit = $6::numeric and pre_verification_gas = $7::numeric and
        paymaster_verification_gas_limit = $8::numeric and paymaster_post_op_gas_limit = $9::numeric and max_fee_per_gas = $10::numeric and
        valid_until = to_timestamp($11::double precision)) as matches from paymaster_sponsorships where user_op_hash = $1`, reservationParams(r));
      if (previous.rows.length > 0) {
        if (previous.rows[0]?.matches !== true) throw rejected('PAYMASTER_RESERVATION_CONFLICT', 409);
        return;
      }
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
      await client.query(`insert into paymaster_sponsorships (user_op_hash,chain_id,paymaster,sender,verification_gas_limit,call_gas_limit,
        pre_verification_gas,paymaster_verification_gas_limit,paymaster_post_op_gas_limit,max_fee_per_gas,valid_until)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,to_timestamp($11::double precision))`, reservationParams(r));
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
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(rejected('PAYMASTER_DEPENDENCY_UNAVAILABLE', 503)), ms); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
function rpc(c: PaymasterConfig) { return createPublicClient({ transport: http(c.rpcUrl, { timeout: c.timeoutMs, retryCount: 0 }) }); }
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

export function createPaymasterService(deps: PaymasterDeps = {}) {
  return { async sponsor(input: unknown, wallet: string) {
    try {
      const c = deps.config === undefined ? loadPaymasterConfig() : deps.config;
      if (c === null) throw rejected('PAYMASTER_DISABLED', 503);
      const request = object(input);
      if (Object.keys(request).some((key) => !['userOperation', 'validUntil'].includes(key))) throw rejected('PAYMASTER_INVALID_OPERATION');
      const op = parsePackedSponsorOperation(request.userOperation);
      const now = (deps.now ?? (() => Math.floor(Date.now() / 1000)))();
      const validUntil = request.validUntil ?? now + 300;
      if (typeof validUntil !== 'number' || !Number.isSafeInteger(validUntil) || validUntil <= now || validUntil > now + 300) throw rejected('PAYMASTER_EXPIRED');
      if (op.paymasterAndData !== '0x') throw rejected('PAYMASTER_INVALID_OPERATION');
      const calls = sponsoredCalls(op);
      const known = await bounded((deps.query ?? query)(`select s.owner, p.user_id from smart_accounts s join portfolios p on p.id = s.portfolio_id
        where s.chain_id = $1 and s.address = $2 and s.account_type = 'KERNEL'`, [c.chainId, op.sender]), c.timeoutMs);
      const owner = known.rows.length === 1 ? object(known.rows[0]) : null;
      if (!owner || typeof owner.owner !== 'string' || typeof owner.user_id !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(wallet) ||
          owner.owner.toLowerCase() !== wallet.toLowerCase() || owner.user_id.toLowerCase() !== wallet.toLowerCase()) throw rejected('PAYMASTER_SENDER_FORBIDDEN', 403);
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
      validateSponsoredCalls(op, c, { owner: hex(owner.owner, 20), assets });
      await bounded((deps.checkChain ?? checkChain)(op, c), c.timeoutMs);
      const signedOp = { ...op, paymasterAndData: header(c) };
      const hash = verifyingPaymasterHash(signedOp, c, validUntil, 0);
      const signature = await privateKeyToAccount(c.signerPrivateKey).signMessage({ message: { raw: hash } });
      const paymasterData = concatHex([encodeAbiParameters([{ type: 'uint48' }, { type: 'uint48' }], [validUntil, 0]), signature]);
      const paymasterAndData = concatHex([header(c), paymasterData]);
      // Actual EntryPoint v0.7 UserOp hash, including the final paymaster authorization, excluding account signature.
      const packedHash = keccak256(encodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' }],
        [op.sender, op.nonce, keccak256(op.initCode), keccak256(op.callData), op.accountGasLimits, op.preVerificationGas, op.gasFees, keccak256(paymasterAndData)]));
      const userOpHash = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }], [packedHash, KERNEL_V3_3_ADDRESSES.entryPointV07, BigInt(c.chainId)]));
      const context = await bounded((deps.readBudgetContext ?? readBudgetContext)(op, c), c.timeoutMs);
      if (deps.exitCallData !== undefined && deps.exitCallData.toLowerCase() === op.callData.toLowerCase()) {
        const executorCall = calls.length === 1 ? calls[0] : undefined;
        const decoded = executorCall !== undefined && isAddressEqual(executorCall.target, c.executor)
          ? decodeFunctionData({ abi: EXECUTOR_ABI, data: executorCall.callData }) : null;
        const numeraire = c.chainId === 97 ? TESTNET_97.contracts.usdt : '0x55d398326f99059ff775485246999027b3197955';
        if (decoded?.functionName !== 'executeRebalance' || !decoded.args[1].every((step) => isAddressEqual(step.tokenOut, numeraire))) throw rejected('GAS_BUDGET_INVALID', 503);
        context.purpose = 'exit';
      }
      const cost = gasCost(op, c);
      await (deps.reserve ?? reserveSponsorship)({ hash: userOpHash, op, config: c, validUntil, ...cost,
        budget: { executionKey: gasExecutionKey(c.chainId, op), chainId: c.chainId, account: op.sender,
          gasLimit: cost.gasLimit, maxFeePerGas: cost.maxFee, ...context } });
      if ((deps.now ?? (() => Math.floor(Date.now() / 1000)))() >= validUntil) throw rejected('PAYMASTER_EXPIRED');
      return { paymasterAndData, paymaster: c.address, paymasterData, paymasterVerificationGasLimit: c.verificationGasLimit,
        paymasterPostOpGasLimit: c.postOpGasLimit, validUntil, validAfter: 0, userOpHash };
    } catch (error) {
      const safe = error instanceof AppError ? error : rejected('PAYMASTER_DEPENDENCY_UNAVAILABLE', 503);
      // Never print request bytes, signatures, keys, RPC/DB exception text or connection strings.
      console.warn(JSON.stringify({ msg: 'paymaster_rejected', code: safe.code }));
      throw safe;
    }
  } };
}
export async function sponsorUserOperation(input: unknown, wallet: string) { return createPaymasterService().sponsor(input, wallet); }

/** viem's explicit estimate action prepares paymaster data before gas fields exist. Never sign there. */
export function estimationPaymaster(hooks: ReturnType<typeof schedulerPaymaster>): Pick<PaymasterActions, 'getPaymasterData'> | undefined {
  return hooks === undefined ? undefined : { getPaymasterData: hooks.getPaymasterStubData };
}

/** viem RPC errors contain the entire UserOp. Sponsored send/estimate boundaries must not log them. */
export function paymasterExecutionError(error: unknown): AppError {
  if (error instanceof GasBudgetExceededError) return error;
  return error instanceof AppError && (error.code.startsWith('PAYMASTER_') || error.code.startsWith('GAS_BUDGET_'))
    ? rejected(error.code, error.status) : rejected('PAYMASTER_SUBMISSION_UNAVAILABLE', 503);
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
        const known = await bounded((deps.query ?? query)('select owner from smart_accounts where chain_id = $1 and address = $2 and account_type = \'KERNEL\'', [c.chainId, expectedSender.toLowerCase()]), c.timeoutMs);
        const owner = known.rows.length === 1 ? object(known.rows[0]).owner : undefined;
        if (typeof owner !== 'string') throw rejected('PAYMASTER_SENDER_FORBIDDEN', 403);
        const result = await createPaymasterService({ ...deps, config: c }).sponsor({ userOperation: op }, owner);
        return { paymaster: result.paymaster, paymasterData: result.paymasterData,
          paymasterVerificationGasLimit: result.paymasterVerificationGasLimit, paymasterPostOpGasLimit: result.paymasterPostOpGasLimit };
      } catch (error) { throw paymasterExecutionError(error); }
    },
  };
}
