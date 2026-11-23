import { decodeFunctionData, encodeFunctionData, erc20Abi, maxUint256 } from 'viem';
import type { Address, Hex } from 'viem';
import { REGISTRY_ABI } from './registry-abi.js';
import { TESTNET_97 as T } from './testnet-profile.js';
import type { MixOwnerCall } from './mix-approval.js';
import { AppError } from './errors.js';
import { BORROW_CALL_ABI, STRATEGY_EARN_97 } from './strategy-earn-guard.js';

const denied = () => new AppError(403, 'MIX_CALL_FORBIDDEN', '這筆授權與待確認的組合變更不符，請重新讀取組合設定。');
export const MIX_SUDO_NONCE_KEY = BigInt(T.contracts.ecdsaValidatorV31) << 16n;
export function assertMixSudoNonce(nonce: bigint): void {
  // viem's nonce manager varies the low 16-bit custom key across operations.
  // The upper mode/type/validator bytes remain fixed; the full key's current
  // sequence is checked against EntryPoint by the RPC verifier.
  if (nonce < 0n || nonce >> 80n !== MIX_SUDO_NONCE_KEY >> 16n) throw denied();
}

/** Validate both the saved intent and its canonical call projection. A malformed
 * saved intent must never turn into authority to sponsor a broader approval.
 * Shape: [approve(AtpExecutor) for each newly added asset]..., enroll, then — only when the mix's yield strategy is on —
 * the yield strategy consent for the new enrollment (src/strategy-earn.ts consentCalls, re-pinned by the enroll before it).
 */
export function assertMixOwnerCalls(input: {
  account: Address; onchainId: bigint; previousAssets: readonly string[]; selectedAssets: readonly string[];
  stored: readonly MixOwnerCall[]; calls: readonly { target: Address; value: bigint; callData: Hex }[]; nonce: bigint;
}): void {
  assertMixSudoNonce(input.nonce);
  const { calls, stored } = input;
  if (calls.length === 0 || calls.length > MAX_MIX_OWNER_CALLS || calls.length !== stored.length || input.onchainId <= 0n) throw denied();
  const previous = new Set(input.previousAssets.map(a => a.toLowerCase()));
  const added = new Set([...input.selectedAssets, T.contracts.usdt].map(a => a.toLowerCase()).filter(a => !previous.has(a)));
  const seen = new Set<string>();
  const enroll = encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'enroll', args: [input.account, input.onchainId, 1] }).toLowerCase();
  const at = calls.findIndex(call => call.target.toLowerCase() === T.contracts.registry && call.callData.toLowerCase() === enroll);
  if (at < 0) throw denied();
  for (const [i, call] of calls.entries()) {
    const saved = stored[i];
    if (!saved || saved.value !== '0' || call.value !== 0n || saved.to.toLowerCase() !== call.target.toLowerCase() ||
        saved.data.toLowerCase() !== call.callData.toLowerCase()) throw denied();
    if (i >= at) continue;
    const target = call.target.toLowerCase();
    const expected = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [T.contracts.executor, maxUint256] });
    if (call.callData.toLowerCase() !== expected.toLowerCase() || !added.has(target) || seen.has(target)) throw denied();
    seen.add(target);
  }
  assertMixStrategyConsent(calls.slice(at + 1), input.selectedAssets);
}

/** 12 approval+enroll calls, plus a full consent: two lending delegates, ceiling + approval per selected asset, two approvals. */
export const MAX_MIX_OWNER_CALLS = 12 + 2 + 2 * 10 + 2;

/**
 * The consent tail after a mix enroll: exactly `consentCalls` for selected assets that have a yield strategy market —
 * delegate grants to AtpBorrowExecutor, enabled ceilings, and approvals to AtpBorrowExecutor only (never AtpExecutor,
 * docs/borrow-97 §7). Each call at most once; ceilings need their collateral approval and vice versa.
 */
export function assertMixStrategyConsent(tail: readonly { target: Address; value: bigint; callData: Hex }[], selectedAssets: readonly string[]): void {
  if (tail.length === 0) return;
  const S = STRATEGY_EARN_97;
  const selected = new Set(selectedAssets.map(a => a.toLowerCase()));
  // Collateral token per market from the chain 97 profile (same as src/strategy-earn.ts strategyMarkets, no import cycle).
  const markets = S.markets.map(m => ({ ...m, collateral: ((T.assets as Record<string, { token: string } | undefined>)[m.symbol]?.token ?? '').toLowerCase() }))
    .filter(m => m.collateral !== '' && selected.has(m.collateral));
  const seen = new Set<string>();
  const once = (key: string) => { if (seen.has(key)) throw denied(); seen.add(key); };
  const ceilings = new Set<string>(), approvals = new Set<string>();
  const exact = (call: { callData: Hex }, data: Hex) => { if (call.callData.toLowerCase() !== data.toLowerCase()) throw denied(); };
  for (const call of tail) {
    if (call.value !== 0n) throw denied();
    const target = call.target.toLowerCase();
    let decoded;
    try { decoded = decodeFunctionData({ abi: BORROW_CALL_ABI, data: call.callData }); } catch { throw denied(); }
    if (target === S.venusComptroller && decoded.functionName === 'updateDelegate') {
      exact(call, encodeFunctionData({ abi: BORROW_CALL_ABI, functionName: 'updateDelegate', args: [S.executor, true] })); once('venus');
      if (!markets.some(m => m.protocol === 'venus')) throw denied();
    } else if (target === S.listaMoolah && decoded.functionName === 'setAuthorization') {
      exact(call, encodeFunctionData({ abi: BORROW_CALL_ABI, functionName: 'setAuthorization', args: [S.executor, true] })); once('lista');
      if (!markets.some(m => m.protocol === 'lista')) throw denied();
    } else if (target === S.registry && decoded.functionName === 'setBorrowPolicy') {
      const [id, maxDebt, enabled] = decoded.args as readonly [Hex, bigint, boolean];
      const m = markets.find(x => x.marketId === id.toLowerCase());
      if (!m || !enabled || maxDebt <= 0n) throw denied();
      exact(call, encodeFunctionData({ abi: BORROW_CALL_ABI, functionName: 'setBorrowPolicy', args: [m.marketId, maxDebt, true] }));
      once('policy:' + m.marketId); ceilings.add(m.collateral);
    } else if (decoded.functionName === 'approve') {
      exact(call, encodeFunctionData({ abi: BORROW_CALL_ABI, functionName: 'approve', args: [S.executor, maxUint256] }));
      if (target !== T.contracts.usdt && target !== S.earnVault && !markets.some(m => m.collateral === target)) throw denied();
      once('approve:' + target);
      if (target !== T.contracts.usdt && target !== S.earnVault) approvals.add(target);
    } else throw denied();
  }
  if (ceilings.size === 0 || [...ceilings].some(a => !approvals.has(a)) || [...approvals].some(a => !ceilings.has(a)) ||
      !seen.has('approve:' + T.contracts.usdt) || !seen.has('approve:' + S.earnVault)) throw denied();
  for (const m of markets.filter(x => ceilings.has(x.collateral))) if (!seen.has(m.protocol)) throw denied();
}
