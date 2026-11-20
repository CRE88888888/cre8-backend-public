import { encodeFunctionData, erc20Abi, isAddress, maxUint256 } from 'viem';
import type { Address, Hex } from 'viem';
import { REGISTRY_ABI } from './registry-abi.js';
import { ValidationError } from './errors.js';

export type MixOwnerCall = { to: Address; value: '0'; data: Hex };

/** Owner sudo only. Match the existing asset setup's executor/maxUint256 approval.
 * Callers read allowances at one canonical block and persist these exact calls as
 * the sponsorship intent. Existing assets never receive a redundant approval.
 */
export function mixOwnerCalls(input: {
  account: Address; registry: Address; executor: Address; onchainId: bigint;
  previousAssets: readonly Address[]; assets: readonly Address[];
  allowances: ReadonlyMap<string, bigint>;
}): MixOwnerCall[] {
  if (![input.account, input.registry, input.executor, ...input.assets, ...input.previousAssets].every(address => isAddress(address, { strict: false })) ||
      input.onchainId <= 0n || input.onchainId > maxUint256 || input.assets.length === 0 || input.assets.length > 128 ||
      new Set(input.assets.map(asset => asset.toLowerCase())).size !== input.assets.length) {
    throw new ValidationError('INVALID_MIX_APPROVAL', '組合授權資料不完整，請重新確認組合。');
  }
  const previous = new Set(input.previousAssets.map(asset => asset.toLowerCase()));
  const calls: MixOwnerCall[] = [];
  for (const asset of input.assets) {
    if (previous.has(asset.toLowerCase())) continue;
    const allowance = input.allowances.get(asset.toLowerCase());
    if (allowance === undefined || allowance < 0n || allowance > maxUint256) {
      throw new ValidationError('MIX_ALLOWANCE_UNAVAILABLE', '無法確認新增資產的授權，請稍後重試。');
    }
    if (allowance === 0n) calls.push({ to: asset, value: '0', data: encodeFunctionData({ abi: erc20Abi,
      functionName: 'approve', args: [input.executor, maxUint256] }) });
  }
  calls.push({ to: input.registry, value: '0', data: encodeFunctionData({ abi: REGISTRY_ABI,
    functionName: 'enroll', args: [input.account, input.onchainId, 1] }) });
  return calls;
}
