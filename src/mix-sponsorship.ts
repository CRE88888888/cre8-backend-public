import { decodeFunctionData, encodeFunctionData, erc20Abi, maxUint256 } from 'viem';
import type { Address, Hex } from 'viem';
import { REGISTRY_ABI } from './registry-abi.js';
import { TESTNET_97 as T } from './testnet-profile.js';
import type { MixOwnerCall } from './mix-approval.js';
import { AppError } from './errors.js';
import { BORROW_CALL_ABI, STRATEGY_EARN_97 } from './strategy-earn-guard.js';
import { v2SponsoredCall } from './strategy-earn-v2.js';
import type { StrategyEarnV2 } from './strategy-earn-v2.js';

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
  /** Routing v2 for this mix's owner (null / absent = not in the v2 audience) and that owner: the tail may then be the v2 re-consent. */
  v2?: StrategyEarnV2 | null; owner?: Address;
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
  const tail = calls.slice(at + 1), v2 = input.v2 ?? null;
  // One account is on v1 or on v2, never both: a tail that touches the v2 registry is judged by the v2 rules alone.
  if (v2 && input.owner && tail.some(call => call.target.toLowerCase() === v2.registry.toLowerCase())) assertMixV2Reconsent(tail, v2, { account: input.account, owner: input.owner, selectedAssets: input.selectedAssets });
  else assertMixStrategyConsent(tail, input.selectedAssets);
}

/**
 * The re-consent tail after a mix enroll for an account on routing v2 (src/strategy-earn-v2.ts v2ReconsentCalls): at most
 * one delegation per lending venue to the v2 executor, exactly one `setStrategyPolicy(ceiling > 0, the mix's owner, true)`,
 * and approvals of selected assets to the v2 executor. Each call at most once, canonical encoding (v2SponsoredCall).
 */
export function assertMixV2Reconsent(tail: readonly { target: Address; value: bigint; callData: Hex }[], v2: StrategyEarnV2,
  ctx: { account: Address; owner: Address; selectedAssets: readonly string[] }): void {
  const selected = ctx.selectedAssets.map(a => a.toLowerCase() as Address);
  const seen = new Set<string>();
  let policies = 0;
  const APPROVE = '0x095ea7b3', swapper = v2.swapper?.toLowerCase();
  const loanTokens = Object.values(v2.loanTokens).map(t => t!.toLowerCase());
  for (const call of tail) {
    const target = call.target.toLowerCase();
    // An approval is keyed by token and spender: a loan token may be approved once to the executor and once to the cash swapper.
    const key = call.callData.toLowerCase().startsWith(APPROVE) ? `${target}:${call.callData.slice(34, 74).toLowerCase()}` : target;
    if (call.value !== 0n || seen.has(key)) throw denied();
    seen.add(key);
    let kind;
    try { kind = v2SponsoredCall(v2, call, { sender: ctx.account, owner: ctx.owner, assets: selected, rootSigned: true }); } catch { throw denied(); }
    // Cash swapper (spec §17): the one thing in this tail that is not 'risk' — an approval of USDT or another loan token
    // to the swapper, and to nobody else (v2SponsoredCall checked the token, the amount encoding and the spender).
    if (kind === 'settle' && swapper !== undefined && key === `${target}:${swapper.slice(2)}` && loanTokens.includes(target)) continue;
    if (kind !== 'risk') throw denied(); // a delegation granted, consent given, an approval to the v2 executor — nothing else
    if (target === v2.registry.toLowerCase()) {
      // The recipient is the mix's owner: v2SponsoredCall would also let the account itself or nobody through.
      let recipient: string;
      try { recipient = (decodeFunctionData({ abi: V2_POLICY_ABI, data: call.callData }).args[1]).toLowerCase(); } catch { throw denied(); }
      if (recipient !== ctx.owner.toLowerCase()) throw denied();
      policies++;
    } else if (target !== v2.venusComptroller.toLowerCase() && target !== v2.moolah.toLowerCase() && !selected.includes(target as Address)) throw denied();
  }
  if (policies !== 1) throw denied();
}
const V2_POLICY_ABI = [{ type: 'function', name: 'setStrategyPolicy', stateMutability: 'nonpayable', outputs: [],
  inputs: [{ name: 'maxDebt', type: 'uint256' }, { name: 'rewardRecipient', type: 'address' }, { name: 'enabled', type: 'bool' }] }] as const;

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
