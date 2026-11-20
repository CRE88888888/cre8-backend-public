import { encodeFunctionData, erc20Abi, maxUint256 } from 'viem';
import type { Address, Hex } from 'viem';
import { REGISTRY_ABI } from './registry-abi.js';
import { TESTNET_97 as T } from './testnet-profile.js';
import type { MixOwnerCall } from './mix-approval.js';
import { AppError } from './errors.js';

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
 */
export function assertMixOwnerCalls(input: {
  account: Address; onchainId: bigint; previousAssets: readonly string[]; selectedAssets: readonly string[];
  stored: readonly MixOwnerCall[]; calls: readonly { target: Address; value: bigint; callData: Hex }[]; nonce: bigint;
}): void {
  assertMixSudoNonce(input.nonce);
  const { calls, stored } = input;
  if (calls.length === 0 || calls.length > 12 || calls.length !== stored.length || input.onchainId <= 0n) throw denied();
  const previous = new Set(input.previousAssets.map(a => a.toLowerCase()));
  const added = new Set([...input.selectedAssets, T.contracts.usdt].map(a => a.toLowerCase()).filter(a => !previous.has(a)));
  const seen = new Set<string>();
  for (const [i, call] of calls.entries()) {
    const saved = stored[i];
    if (!saved || saved.value !== '0' || call.value !== 0n || saved.to.toLowerCase() !== call.target.toLowerCase() ||
        saved.data.toLowerCase() !== call.callData.toLowerCase()) throw denied();
    const enrollment = i === calls.length - 1;
    const target = call.target.toLowerCase();
    const expected = enrollment ? encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'enroll', args: [input.account, input.onchainId, 1] })
      : encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [T.contracts.executor, maxUint256] });
    if (call.callData.toLowerCase() !== expected.toLowerCase() || (enrollment ? target !== T.contracts.registry : !added.has(target) || seen.has(target))) throw denied();
    seen.add(target);
  }
}
