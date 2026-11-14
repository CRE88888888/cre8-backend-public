import {
  concatHex, createPublicClient, decodeAbiParameters, decodeFunctionData, encodeAbiParameters,
  encodeFunctionData, http, isAddressEqual, keccak256, parseAbi, slice, toHex, toFunctionSelector,
} from 'viem';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { GetPaymasterDataParameters, PaymasterActions } from 'viem/account-abstraction';
import { EXECUTOR_ABI, REGISTRY_ABI } from './chain.js';
import { KERNEL_V3_3_ADDRESSES } from './addresses.js';
import { loadPaymasterConfig } from './config.js';
import type { PaymasterConfig } from './config.js';
import { query, withTransaction } from './db.js';
import { AppError } from './errors.js';

export type PackedSponsorOperation = {
  sender: Address; nonce: bigint; initCode: Hex; callData: Hex; accountGasLimits: Hex;
  preVerificationGas: bigint; gasFees: Hex; paymasterAndData: Hex; signature: Hex;
};
export type Reservation = {
  hash: Hex; op: PackedSponsorOperation; config: PaymasterConfig; validUntil: number;
  verificationGas: bigint; callGas: bigint; maxFee: bigint; gasLimit: bigint; maxCostWei: bigint;
};
type Query = (sql: string, params?: readonly unknown[]) => Promise<{ rows: unknown[] }>;
export type PaymasterDeps = {
  config?: PaymasterConfig | null;
  now?: () => number;
  query?: Query;
  checkChain?: (op: PackedSponsorOperation, config: PaymasterConfig) => Promise<void>;
  reserve?: (request: Reservation) => Promise<void>;
};
export const KERNEL_EXECUTE_ABI = parseAbi(['function execute(bytes32 execMode,bytes executionCalldata) payable']);
const CLAIM_ABI = parseAbi(['function claim(uint256 amount)']);
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

/** Only canonical Kernel CALL / BATCH DEFAULT modes. No delegatecall, try-exec or hidden mode payload. */
export function validateSponsoredCalls(op: PackedSponsorOperation, c: PaymasterConfig): void {
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
    for (const call of calls) {
      if (call.value !== 0n) throw new Error('native transfer');
      if (isAddressEqual(call.target, c.executor)) {
        const inner = decodeFunctionData({ abi: EXECUTOR_ABI, data: call.callData });
        if (inner.functionName !== 'executeRebalance' || !isAddressEqual(inner.args[0], op.sender) || inner.args[1].length === 0 ||
            encodeFunctionData({ abi: EXECUTOR_ABI, functionName: inner.functionName, args: inner.args }).toLowerCase() !== call.callData.toLowerCase()) throw new Error('invalid rebalance');
      } else if (isAddressEqual(call.target, c.registry)) {
        const inner = decodeFunctionData({ abi: REGISTRY_ABI, data: call.callData });
        if (inner.functionName !== 'enroll' || !isAddressEqual(inner.args[0], op.sender) || inner.args[1] === 0n ||
            encodeFunctionData({ abi: REGISTRY_ABI, functionName: inner.functionName, args: inner.args }).toLowerCase() !== call.callData.toLowerCase()) throw new Error('invalid enrollment');
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
      const budgets = [[BigInt(u.account_count), 1n, c.accountDailyCount], [BigInt(u.account_gas), r.gasLimit, c.accountDailyGas],
        [BigInt(u.account_wei), r.maxCostWei, c.accountDailyWei], [BigInt(u.gas), r.gasLimit, c.siteDailyGas], [BigInt(u.wei), r.maxCostWei, c.siteDailyWei]] as const;
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
      validateSponsoredCalls(op, c);
      const known = await bounded((deps.query ?? query)(`select s.owner, p.user_id from smart_accounts s join portfolios p on p.id = s.portfolio_id
        where s.chain_id = $1 and s.address = $2 and s.account_type = 'KERNEL'`, [c.chainId, op.sender]), c.timeoutMs);
      const owner = known.rows.length === 1 ? object(known.rows[0]) : null;
      if (!owner || typeof owner.owner !== 'string' || typeof owner.user_id !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(wallet) ||
          owner.owner.toLowerCase() !== wallet.toLowerCase() || owner.user_id.toLowerCase() !== wallet.toLowerCase()) throw rejected('PAYMASTER_SENDER_FORBIDDEN', 403);
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
      await (deps.reserve ?? reserveSponsorship)({ hash: userOpHash, op, config: c, validUntil, ...gasCost(op, c) });
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
  return error instanceof AppError && error.code.startsWith('PAYMASTER_')
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
      // Recoverable low-s dummy signature, deliberately invalid for every real sponsorship hash.
      return { paymaster: c.address, paymasterVerificationGasLimit: c.verificationGasLimit, paymasterPostOpGasLimit: c.postOpGasLimit,
        paymasterData: concatHex([encodeAbiParameters([{ type: 'uint48' }, { type: 'uint48' }], [0, 0]), `0x${'11'.repeat(64)}1b`]) };
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
