import { createKernelAccountClient } from '@zerodev/sdk';
import { decodeErrorResult, decodeEventLog, encodeFunctionData, erc20Abi, http, isAddressEqual, parseAbi, zeroAddress } from 'viem';
import type { Address, Hex, PublicClient, Log, TransactionReceipt } from 'viem';
import { createBundlerClient, entryPoint07Abi, getUserOperationHash } from 'viem/account-abstraction';
import type { UserOperation, UserOperationReceipt, GetUserOperationReturnType } from 'viem/account-abstraction';
import { AppError } from './errors.js';
import { YIELD_EXECUTOR_ABI, YIELD_REGISTRY_ABI } from './yield-abi.js';
import { TESTNET_97 } from './testnet-profile.js';
import { assertNotStrategyVault } from './strategy-earn-guard.js';
import { assertUserOpCapacity, MAX_USER_OP_GAS, userOpGasOverhead } from './execution-batch.js';
import { canonicalKernelCalls, estimationPaymaster, schedulerPaymaster, gasExecutionKey, settleGasBudget, paymasterExecutionError } from './paymaster.js';
import type { PaymasterDeps } from './paymaster.js';
import { yieldAuthorization } from './permissions.js';
import { installedKeyScope, sessionKernelAccount } from './scheduler.js';
import { yieldSessionAvailable } from './yield-session.js';
import type { SessionKeyRef } from './scheduler.js';
import { signPreparedOperation } from './user-operation.js';

/**
 * The key reference the yield / DCA sender signs with: the policy must be rebuilt exactly as installed — the #204 Strategy
 * Earn calls (market list included), the routing v2 scope and the permission flag, all read off the key's own snapshot
 * (the same reading as the rebalance sender, `installedKeyScope`).
 */
export function yieldSessionKey(sessionKey: SessionKeyRef, policies: unknown, account: Address): SessionKeyRef {
  return { ...sessionKey, yieldAccount: account, ...installedKeyScope(policies, account, 97) };
}

export type YieldAction = Readonly<{ kind: 'supply' | 'withdraw'; marketId: Hex; amount: bigint }>;
export type YieldPlan = YieldAction & Readonly<{
  chainId: 97; account: Address; executor: Address; yieldRegistry: Address; asset: Address; receipt: Address;
  minimum: bigint; deadline: bigint; quoteBlock: bigint; quoteBlockHash: Hex;
  assetBalance: bigint; receiptBalance: bigint; data: Hex;
  /** Aave scaled units; raw aToken Transfer amounts cannot prove rounded balance changes. */
  scaledReceiptBalance?: bigint;
}>;
const fail = (code: string, message: string, status = 503) => new AppError(status, code, message);
const AAVE_ACCOUNTING_ABI = parseAbi(['function scaledBalanceOf(address) view returns(uint256)',
  'function getReserveNormalizedIncome(address) view returns(uint256)']);
const RAY = 10n ** 27n;

/** Both quote and execution preview use one canonical block and include protocol accrual via eth_call.
 * C3 #110: sign floor(quote * 9995 / 10000), leaving 5 bps of the executor's 10 bps tolerance
 * for cross-block accrual. A rounded-zero minimum never reaches signing or submission.
 * Non-view quote functions are simulated, never broadcast.
 */
export async function quoteYieldAction(client: PublicClient, account: Address, action: YieldAction, ttlSeconds = 300): Promise<YieldPlan> {
  if (!['supply', 'withdraw'].includes(action.kind) || action.amount <= 0n || action.amount >= 1n << 256n ||
      !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 300) throw fail('YIELD_INVALID_ACTION', '生息金額或 deadline 無效', 400);
  const market = TESTNET_97.yieldMarkets.find(m => m.marketId === action.marketId.toLowerCase());
  if (!market || isAddressEqual(account, zeroAddress)) throw fail('YIELD_INVALID_ACTION', '未知的生息市場或帳戶', 400);
  try {
    if (await client.getChainId() !== 97) throw new Error('chain mismatch');
    const block = await client.getBlock({ blockTag: 'latest' });
    if (block.number === null || block.hash === null) throw new Error('missing quote block');
    const executor = TESTNET_97.contracts.executor, yieldRegistry = TESTNET_97.contracts.yieldRegistry;
    const linked = await client.readContract({ address: executor, abi: YIELD_EXECUTOR_ABI, functionName: 'yieldRegistry', blockNumber: block.number });
    if (!isAddressEqual(linked, yieldRegistry)) throw new Error('registry mismatch');
    const registered = await client.readContract({ address: yieldRegistry, abi: YIELD_REGISTRY_ABI, functionName: 'market', args: [action.marketId], blockNumber: block.number });
    if (!isAddressEqual(registered.asset, market.asset) || !isAddressEqual(registered.receipt, market.receipt) ||
        !isAddressEqual(registered.target, market.target) || registered.chainId !== 97n ||
        registered.kind !== ({ Venus: 1, Lista: 2, Aave: 3 } as const)[market.protocol]) throw new Error('market mismatch');
    const quote = action.kind === 'supply'
      ? (await client.simulateContract({ address: yieldRegistry, abi: YIELD_REGISTRY_ABI, functionName: 'quoteSupply',
        args: [action.marketId, account, action.amount], account, blockNumber: block.number })).result
      : (await client.simulateContract({ address: yieldRegistry, abi: YIELD_REGISTRY_ABI, functionName: 'quoteWithdraw',
        args: [action.marketId, action.amount], account, blockNumber: block.number })).result;
    const minimum = quote * 9995n / 10000n;
    if (minimum <= 0n) throw new Error('zero minimum');
    const [assetBalance, receiptBalance] = await Promise.all([market.asset, market.receipt].map(address => client.readContract({
      address, abi: erc20Abi, functionName: 'balanceOf', args: [account], blockNumber: block.number })));
    if (assetBalance === undefined || receiptBalance === undefined ||
        (action.kind === 'supply' ? assetBalance : receiptBalance) < action.amount) throw new Error('balance missing / insufficient');
    const deadline = block.timestamp + BigInt(ttlSeconds);
    const scaledReceiptBalance = market.protocol === 'Aave' ? await client.readContract({ address: market.receipt,
      abi: AAVE_ACCOUNTING_ABI, functionName: 'scaledBalanceOf', args: [account], blockNumber: block.number }) : undefined;
    assertNotStrategyVault({ marketId: action.marketId }); assertNotStrategyVault({ address: market.receipt });
    const data = encodeFunctionData({ abi: YIELD_EXECUTOR_ABI, functionName: action.kind === 'supply' ? 'executeSupply' : 'executeWithdraw',
      args: [account, action.marketId, action.amount, minimum, deadline] });
    await client.call({ account, to: executor, data, blockNumber: block.number, gas: MAX_USER_OP_GAS });
    if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error('quote reorg');
    return { ...action, chainId: 97, account, executor, yieldRegistry, asset: market.asset, receipt: market.receipt,
      minimum, deadline, quoteBlock: block.number, quoteBlockHash: block.hash, assetBalance, receiptBalance, data,
      ...(scaledReceiptBalance === undefined ? {} : { scaledReceiptBalance }) };
  } catch { throw fail('YIELD_QUOTE_UNAVAILABLE', '生息同狀態報價或預演失敗，未送交易'); }
}

/** 200% execution headroom, shared 14M total capacity. Never trim yield's measured execution margin. */
export function yieldCallGasLimit(estimated: bigint, overhead: bigint): bigint {
  if (estimated <= 0n || overhead < 0n) throw fail('YIELD_GAS_INVALID', '生息 gas 估算無效');
  const gas = estimated * 2n;
  assertUserOpCapacity(1, gas + overhead);
  return gas;
}

/** Strict ABI error only; messages/RPC strings are never a reason to retry. */
export function isYieldMinimumError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const raw: unknown = Reflect.get(current, 'data');
    if (typeof raw === 'string' && /^0x[0-9a-fA-F]+$/.test(raw)) {
      try { if (decodeErrorResult({ abi: YIELD_EXECUTOR_ABI, data: raw as Hex }).errorName === 'YieldMinimum') return true; } catch { /* unknown ABI */ }
    }
    current = Reflect.get(current, 'cause');
  }
  return false;
}

export type YieldEvidence = Readonly<{ assets: bigint; shares: bigint; remainingReceipts: bigint; txHash: Hex; userOpHash: Hex; gasUsed: bigint }>;
function tokenDelta(logs: readonly Log[], token: Address, account: Address): bigint {
  let delta = 0n;
  for (const log of logs) {
    if (!isAddressEqual(log.address, token)) continue;
    if (log.removed) throw new Error('removed token log');
    let event;
    try { event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics, strict: true }); }
    catch { continue; }
    if (event.eventName !== 'Transfer') continue;
    if (isAddressEqual(event.args.from, account)) delta -= event.args.value;
    if (isAddressEqual(event.args.to, account)) delta += event.args.value;
  }
  return delta;
}

/** tx + EntryPoint + exact business event and token deltas; scoped to this UserOp's logs. */
export function yieldReceiptEvidence(plan: YieldPlan, receipt: UserOperationReceipt,
  aave?: { index: bigint; scaledAfter: bigint; rawBalanceAfter: bigint }): YieldEvidence {
  if (receipt.receipt.status !== 'success' || receipt.success !== true || !isAddressEqual(receipt.sender, plan.account)) throw fail('YIELD_EXECUTION_REVERTED', '生息 UserOp 未成功');
  const events = [];
  for (const log of receipt.logs) {
    if (!isAddressEqual(log.address, plan.executor)) continue;
    if (log.removed) throw fail('YIELD_RECEIPT_INCOMPLETE', '生息事件已被移除');
    try {
      const event = decodeEventLog({ abi: YIELD_EXECUTOR_ABI, data: log.data, topics: log.topics, strict: true });
      if (event.eventName === 'SupplyExecuted' || event.eventName === 'WithdrawExecuted') events.push(event);
    } catch { /* other executor event */ }
  }
  const event = events[0];
  if (events.length !== 1 || !event || event.eventName !== (plan.kind === 'supply' ? 'SupplyExecuted' : 'WithdrawExecuted') ||
      !isAddressEqual(event.args.account, plan.account) || event.args.marketId.toLowerCase() !== plan.marketId.toLowerCase()) throw fail('YIELD_RECEIPT_INCOMPLETE', '缺少唯一且相符的生息業務事件');
  const { assets, shares, remainingReceipts } = event.args;
  const supply = plan.kind === 'supply';
  const market = TESTNET_97.yieldMarkets.find(m => m.marketId === plan.marketId.toLowerCase());
  let expectedRemaining = plan.receiptBalance + (supply ? shares : -shares);
  let expectedReceiptTransfer = supply ? shares : -shares;
  if (market?.protocol === 'Aave') {
    if (!aave || aave.index <= 0n || plan.scaledReceiptBalance === undefined || plan.scaledReceiptBalance < 0n) throw fail('YIELD_RECEIPT_INCOMPLETE', '缺少 Aave scaled units／ray index 證據');
    const before = plan.scaledReceiptBalance;
    const changedUnits = supply ? assets * RAY / aave.index : (shares * RAY + aave.index - 1n) / aave.index;
    const after = supply ? before + changedUnits : before - changedUnits;
    expectedRemaining = after * aave.index / RAY;
    if (changedUnits <= 0n || after < 0n || aave.scaledAfter !== after || aave.rawBalanceAfter !== expectedRemaining ||
        supply && shares !== expectedRemaining - before * aave.index / RAY) throw fail('YIELD_RECEIPT_INCOMPLETE', 'Aave 收據與精確 scaled units 差額不符');
    // MockAToken Transfer emits the nominal action amount; balances use TokenMath floor/ceil.
    expectedReceiptTransfer = supply ? assets : -shares;
  } else if (aave !== undefined || plan.scaledReceiptBalance !== undefined) throw fail('YIELD_RECEIPT_INCOMPLETE', '市場與 scaled units 型別不符');
  if ((supply ? assets : shares) !== plan.amount || (supply ? shares : assets) < plan.minimum ||
      remainingReceipts !== expectedRemaining ||
      tokenDelta(receipt.logs, plan.asset, plan.account) !== (supply ? -assets : assets) ||
      tokenDelta(receipt.logs, plan.receipt, plan.account) !== expectedReceiptTransfer) throw fail('YIELD_RECEIPT_INCOMPLETE', '生息事件與資產／收據差額不符，保留在途');
  return { assets, shares, remainingReceipts, txHash: receipt.receipt.transactionHash, userOpHash: receipt.userOpHash, gasUsed: receipt.actualGasUsed };
}

export type SavedYieldOperation = { plan: YieldPlan; nonce: bigint; callData: Hex; userOpHash: Hex };
export type YieldReceiptResult = { status: 'confirmed'; evidence: YieldEvidence } |
  { status: 'reverted'; txHash: Hex; userOpHash: Hex; gasUsed: bigint; retryable: boolean };

/** Restart reconciliation uses the saved final attempt, never a freshly generated plan.
 * The chain receipt must independently contain the exact EntryPoint and business logs.
 */
export async function reconcileYieldOperation(client: PublicClient, bundlerUrl: string, saved: SavedYieldOperation,
  received?: UserOperationReceipt): Promise<YieldReceiptResult> {
  try {
    if (await client.getChainId() !== 97) throw fail('YIELD_RECEIPT_INCOMPLETE', '生息對帳鏈別不符');
    const bundler = createBundlerClient({ transport: http(bundlerUrl, { retryCount: 0, timeout: 120000 }) });
    const receipt = received ?? await bundler.getUserOperationReceipt({ hash: saved.userOpHash });
    const original = await bundler.getUserOperation({ hash: saved.userOpHash });
    const [canonical, chainReceipt] = await Promise.all([
      client.getBlock({ blockNumber: receipt.receipt.blockNumber }),
      client.getTransactionReceipt({ hash: receipt.receipt.transactionHash }),
    ]);
    const market = TESTNET_97.yieldMarkets.find(m => m.marketId === saved.plan.marketId.toLowerCase());
    let aave;
    if (receipt.success && market?.protocol === 'Aave') {
      const [index, scaledAfter, rawBalanceAfter] = await Promise.all([
        client.readContract({ address: market.target, abi: AAVE_ACCOUNTING_ABI, functionName: 'getReserveNormalizedIncome', args: [market.asset], blockNumber: chainReceipt.blockNumber }),
        client.readContract({ address: market.receipt, abi: AAVE_ACCOUNTING_ABI, functionName: 'scaledBalanceOf', args: [saved.plan.account], blockNumber: chainReceipt.blockNumber }),
        client.readContract({ address: market.receipt, abi: erc20Abi, functionName: 'balanceOf', args: [saved.plan.account], blockNumber: chainReceipt.blockNumber }),
      ]);
      aave = { index, scaledAfter, rawBalanceAfter };
    }
    return verifyYieldReceipt(saved, { receipt, original, canonicalBlockHash: canonical.hash, chainReceipt, aave });
  } catch (error) { throw error instanceof AppError ? error : fail('YIELD_RECEIPT_UNAVAILABLE', '生息對帳讀取失敗，保留在途'); }
}

export function verifyYieldReceipt(saved: SavedYieldOperation, input: {
  receipt: UserOperationReceipt; original: GetUserOperationReturnType; canonicalBlockHash: Hex | null;
  chainReceipt: TransactionReceipt; aave?: { index: bigint; scaledAfter: bigint; rawBalanceAfter: bigint };
}): YieldReceiptResult {
  const { receipt, original, canonicalBlockHash, chainReceipt, aave } = input;
  const market = TESTNET_97.yieldMarkets.find(m => m.marketId === saved.plan.marketId.toLowerCase());
  const calls = canonicalKernelCalls(saved.callData);
  const call = calls[0];
  const expectedData = encodeFunctionData({ abi: YIELD_EXECUTOR_ABI, functionName: saved.plan.kind === 'supply' ? 'executeSupply' : 'executeWithdraw',
    args: [saved.plan.account, saved.plan.marketId, saved.plan.amount, saved.plan.minimum, saved.plan.deadline] });
  if (saved.plan.chainId !== 97 || !market || !isAddressEqual(saved.plan.asset, market.asset) || !isAddressEqual(saved.plan.receipt, market.receipt) ||
      !isAddressEqual(saved.plan.executor, TESTNET_97.contracts.executor) || calls.length !== 1 || !call || call.value !== 0n ||
      !isAddressEqual(call.target, saved.plan.executor) || call.callData.toLowerCase() !== expectedData.toLowerCase() ||
      saved.plan.data.toLowerCase() !== expectedData.toLowerCase()) throw fail('YIELD_PAYLOAD_MISMATCH', '保存的生息計畫與原始 payload 不符');
  const entryPoint = TESTNET_97.contracts.entryPoint;
  const actualHash = getUserOperationHash({ userOperation: original.userOperation, entryPointAddress: entryPoint, entryPointVersion: '0.7', chainId: 97 });
  if (canonicalBlockHash !== receipt.receipt.blockHash || chainReceipt.blockHash !== canonicalBlockHash ||
      original.blockHash !== canonicalBlockHash || original.blockNumber !== receipt.receipt.blockNumber ||
      original.transactionHash !== chainReceipt.transactionHash || receipt.receipt.transactionHash !== chainReceipt.transactionHash ||
      receipt.receipt.status !== chainReceipt.status || receipt.userOpHash.toLowerCase() !== saved.userOpHash.toLowerCase() ||
      actualHash.toLowerCase() !== saved.userOpHash.toLowerCase() || receipt.nonce !== saved.nonce ||
      original.userOperation.callData.toLowerCase() !== saved.callData.toLowerCase() ||
      original.userOperation.sender.toLowerCase() !== saved.plan.account.toLowerCase() || original.userOperation.nonce !== saved.nonce ||
      !isAddressEqual(receipt.entryPoint, entryPoint) || !isAddressEqual(original.entryPoint, entryPoint)) throw fail('YIELD_RECEIPT_INCOMPLETE', '生息 receipt 身分或 canonical 區塊不符');
  const events = [];
  let retryable = false;
  let previousEnd = -1;
  let scope: typeof chainReceipt.logs | null = null;
  for (const [index, log] of chainReceipt.logs.entries()) {
    if (!isAddressEqual(log.address, entryPoint)) continue;
    if (log.removed) throw fail('YIELD_RECEIPT_INCOMPLETE', 'EntryPoint log 已被移除');
    try {
      const event = decodeEventLog({ abi: entryPoint07Abi, data: log.data, topics: log.topics, strict: true });
      if (event.eventName === 'UserOperationEvent') {
        if (event.args.userOpHash.toLowerCase() === saved.userOpHash.toLowerCase()) {
          events.push(event.args);
          scope = chainReceipt.logs.slice(previousEnd + 1, index);
        }
        previousEnd = index;
      }
      if (event.eventName === 'UserOperationRevertReason' && event.args.userOpHash === saved.userOpHash &&
          isAddressEqual(event.args.sender, saved.plan.account) && event.args.nonce === saved.nonce) retryable = isYieldMinimumError({ data: event.args.revertReason });
    } catch { /* other EntryPoint log */ }
  }
  // ERC-4337 receipt.logs excludes its closing UserOperationEvent. Use the independent
  // transaction receipt to prove that boundary and exclude adjacent UserOps in a bundle.
  if (!scope || scope.length !== receipt.logs.length || receipt.logs.some((log, index) => {
    const onchain = scope?.[index];
    return !onchain || log.removed || onchain.removed || log.data !== onchain.data || log.logIndex !== onchain.logIndex ||
      !isAddressEqual(log.address, onchain.address) || JSON.stringify(log.topics) !== JSON.stringify(onchain.topics);
  })) throw fail('YIELD_RECEIPT_INCOMPLETE', '生息 receipt log 與鏈上 UserOp 範圍不符');
  const event = events[0];
  if (events.length !== 1 || !event || event.userOpHash.toLowerCase() !== saved.userOpHash.toLowerCase() ||
      event.nonce !== saved.nonce || !isAddressEqual(event.sender, saved.plan.account) || event.success !== receipt.success ||
      event.actualGasUsed !== receipt.actualGasUsed || chainReceipt.status !== 'success') throw fail('YIELD_RECEIPT_INCOMPLETE', '無法證明 EntryPoint 執行結果');
  if (!receipt.success) {
    // Reverted inner calls cannot leave business events or any account asset movement.
    if (receipt.logs.some(log => isAddressEqual(log.address, saved.plan.executor)) ||
      tokenDelta(receipt.logs, saved.plan.asset, saved.plan.account) !== 0n || tokenDelta(receipt.logs, saved.plan.receipt, saved.plan.account) !== 0n) throw fail('YIELD_RECEIPT_INCOMPLETE', '失敗的生息 UserOp 仍出現業務異動');
    return { status: 'reverted', txHash: chainReceipt.transactionHash, userOpHash: saved.userOpHash, gasUsed: receipt.actualGasUsed, retryable };
  }
  return { status: 'confirmed', evidence: yieldReceiptEvidence(saved.plan, receipt, aave) };
}

/** 0036/BE-3 adapter contract: implementations must atomically enforce account in-flight exclusion,
 * immutable final payload/nonce, durable unknown state, and retain partial exit intents until zero.
 * No in-memory production fallback. No public route / scheduler activation in BE-4.
 */
export interface YieldOperationJournal {
  prepare(input: { plan: YieldPlan; nonce: bigint; callData: Hex; executionKey: string; userOpHash: Hex }): Promise<string>;
  sending(id: string): Promise<void>;
  submitted(id: string, userOpHash: Hex): Promise<void>;
  confirmed(id: string, evidence: YieldEvidence): Promise<void>;
  reverted(id: string, evidence: Extract<YieldReceiptResult, { status: 'reverted' }>): Promise<void>;
  unknown(id: string): Promise<void>;
}

export type YieldSubmitArgs = {
  publicClient: PublicClient; bundlerUrl: string; account: Address; sessionKey: SessionKeyRef;
  policies: unknown; action: YieldAction; journal: YieldOperationJournal;
  paymaster?: PaymasterDeps; maxQuoteAttempts?: number;
};

/** Explicit caller/journal required until BE-3 + 0036. Withdraw reaches this path without swap planning,
 * buy allowance, strategy pauses or supply throttling; site sponsorship safety limits still apply.
 */
export async function submitYieldAction(args: YieldSubmitArgs): Promise<YieldEvidence> {
  try { return await submitYieldWithSession(args); }
  // The public code and message stay generic; the original error rides along as `cause` for the scheduler's log (errorChain).
  catch (error) { throw error instanceof AppError ? error : new AppError(503, 'YIELD_DEPENDENCY_UNAVAILABLE', '生息依賴讀取或授權重建失敗，未自動重送', { cause: error }); }
}

async function submitYieldWithSession(args: YieldSubmitArgs): Promise<YieldEvidence> {
  const authorization = yieldAuthorization(args.policies, args.account, TESTNET_97.contracts.executor);
  if (authorization.status !== 'ready') throw fail(authorization.code, authorization.message, 409);
  const attempts = args.maxQuoteAttempts ?? 3;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 3) throw fail('YIELD_INVALID_ACTION', '報價重試上限必須是 1 到 3', 400);
  const publicClient = args.publicClient;
  if (!await yieldSessionAvailable(publicClient, args.policies, args.account, TESTNET_97.contracts.executor, () => new Date()))
    throw fail('SESSION_AUTHORIZATION_REQUIRED', '需要更新授權：生息 permission 未安裝或已過期', 409);
  const account = await sessionKernelAccount({ account: args.account, executor: TESTNET_97.contracts.executor,
    sessionKey: yieldSessionKey(args.sessionKey, args.policies, args.account) }, publicClient);
  const paymaster = schedulerPaymaster(args.account, args.paymaster);
  if (!paymaster) throw fail('PAYMASTER_DISABLED', 'chain 97 生息需要指定 paymaster');
  const client = createKernelAccountClient({ account, client: publicClient, chain: publicClient.chain,
    paymaster, bundlerTransport: http(args.bundlerUrl, { retryCount: 0, timeout: 120000 }),
    userOperation: { estimateFeesPerGas: async () => {
      const gasPrice = await publicClient.getGasPrice(); return { maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice };
    } } });
  for (let i = 0; i < attempts; i++) {
    const plan = await quoteYieldAction(publicClient, args.account, args.action);
    let prepared: UserOperation<'0.7'>;
    try {
      const calls = [{ to: plan.executor, data: plan.data, value: 0n }] as const;
      const nonce = await account.getNonce();
      const estimate = await client.estimateUserOperationGas({ calls, nonce, paymaster: estimationPaymaster(paymaster) });
      const stub = await paymaster.getPaymasterStubData?.({ chainId: 97, entryPointAddress: TESTNET_97.contracts.entryPoint, sender: args.account, nonce, callData: await account.encodeCalls(calls) });
      const callGasLimit = yieldCallGasLimit(estimate.callGasLimit, userOpGasOverhead(estimate, stub));
      await publicClient.call({ account: args.account, to: plan.executor, data: plan.data, gas: callGasLimit });
      prepared = await client.prepareUserOperation({ calls, nonce, callGasLimit,
        verificationGasLimit: estimate.verificationGasLimit, preVerificationGas: estimate.preVerificationGas });
      assertUserOpCapacity(1, prepared.callGasLimit + userOpGasOverhead(prepared));
    } catch (error) {
      if (!isYieldMinimumError(error)) throw paymasterExecutionError(error);
      if (i + 1 === attempts) throw fail('YIELD_QUOTE_RETRY_EXHAUSTED', '生息報價已變動，重新報價重試達到 3 次上限，未放寬 min');
      continue;
    }
    if (prepared.sender.toLowerCase() !== args.account.toLowerCase() || prepared.callData.toLowerCase() !==
        (await account.encodeCalls([{ to: plan.executor, data: plan.data, value: 0n }])).toLowerCase()) throw fail('YIELD_PAYLOAD_MISMATCH', '最終生息 payload 不符');
    const now = (await publicClient.getBlock({ blockTag: 'latest' })).timestamp;
    if (now > plan.deadline) throw fail('YIELD_QUOTE_EXPIRED', '生息 deadline 已過，未送交易');
    const budgetKey = gasExecutionKey(97, { sender: args.account, nonce: prepared.nonce, initCode: '0x', callData: prepared.callData });
    const signed = await signPreparedOperation(prepared, op => account.signUserOperation(op));
    const expectedHash = getUserOperationHash({ userOperation: signed, entryPointAddress: TESTNET_97.contracts.entryPoint, entryPointVersion: '0.7', chainId: 97 });
    let id: string;
    try { id = await args.journal.prepare({ plan, nonce: signed.nonce, callData: signed.callData, executionKey: budgetKey, userOpHash: expectedHash }); }
    catch { throw fail('YIELD_RECONCILIATION_REQUIRED', '生息意圖保存未確認，保留在途，不重送'); }
    let result: YieldReceiptResult;
    try {
      await args.journal.sending(id);
      const hash = await client.sendUserOperation(signed);
      if (hash.toLowerCase() !== expectedHash.toLowerCase()) throw new Error('bundler hash mismatch');
      await args.journal.submitted(id, hash);
      await settleGasBudget(budgetKey, 'submitted');
      const receipt = await client.waitForUserOperationReceipt({ hash, timeout: 120000 });
      result = await reconcileYieldOperation(publicClient, args.bundlerUrl, { plan, nonce: signed.nonce, callData: signed.callData, userOpHash: expectedHash }, receipt);
      if (result.status === 'confirmed') {
        await args.journal.confirmed(id, result.evidence);
        await settleGasBudget(budgetKey, 'confirmed');
        return result.evidence;
      }
      await args.journal.reverted(id, result);
      await settleGasBudget(budgetKey, 'failed');
    } catch {
      // An unknown journal commit, RPC send/receipt timeout or incomplete evidence never unlocks retry.
      await args.journal.unknown(id);
      await settleGasBudget(budgetKey, 'unknown');
      throw fail('YIELD_RECONCILIATION_REQUIRED', '生息送出結果或對帳未確認，保留在途，不重送');
    }
    if (!result.retryable) throw fail('YIELD_EXECUTION_REVERTED', '生息執行已確認失敗，未自動重送');
  }
  throw fail('YIELD_QUOTE_RETRY_EXHAUSTED', '生息重新報價重試達到上限，未放寬 min');
}
