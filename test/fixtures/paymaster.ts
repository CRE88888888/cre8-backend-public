import assert from 'node:assert/strict';
import { concatHex, encodeFunctionData, parseAbi, toHex } from 'viem';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadPaymasterConfig } from '../../src/config.js';
import { KERNEL_EXECUTE_ABI } from '../../src/paymaster.js';
import type { PackedSponsorOperation } from '../../src/paymaster.js';

// Public anvil account #0, never a real/testnet service key.
export const TEST_SIGNER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
export const PM = '0x1000000000000000000000000000000000000001';
export const EXECUTOR = '0x1000000000000000000000000000000000000002';
export const REGISTRY = '0x1000000000000000000000000000000000000003';
export const USDT = '0x1000000000000000000000000000000000000004';
export const SENDER = '0x1000000000000000000000000000000000000005';
export const OWNER = privateKeyToAccount(TEST_SIGNER).address.toLowerCase();
export const ENV = { CHAIN_ID: '1337', RPC_URL: 'http://127.0.0.1:8557', PAYMASTER_SIGNER_PRIVATE_KEY: TEST_SIGNER,
  PAYMASTER_ADDRESS: PM, EXECUTOR_ADDRESS: EXECUTOR, REGISTRY_ADDRESS: REGISTRY, PAYMASTER_MOCK_USDT_ADDRESS: USDT };
export const NOW = 1_800_000_000;
export const CLAIM_ABI = parseAbi(['function claim(uint256 amount)']);
export const claim = encodeFunctionData({ abi: CLAIM_ABI, functionName: 'claim', args: [1n] });
export function kernelCall(data: Hex = claim, target: Hex = USDT, value = 0n, mode: Hex = toHex(0n, { size: 32 })): Hex {
  return encodeFunctionData({ abi: KERNEL_EXECUTE_ABI, functionName: 'execute', args: [mode, concatHex([target, toHex(value, { size: 32 }), data])] });
}
export function operation(overrides: Partial<PackedSponsorOperation> = {}): PackedSponsorOperation {
  return { sender: SENDER, nonce: 0n, initCode: '0x', callData: kernelCall(), accountGasLimits: concatHex([toHex(100_000n, { size: 16 }), toHex(200_000n, { size: 16 })]),
    preVerificationGas: 50_000n, gasFees: concatHex([toHex(1n, { size: 16 }), toHex(2n, { size: 16 })]), paymasterAndData: '0x', signature: '0x', ...overrides };
}
export function config(env: NodeJS.ProcessEnv = ENV) {
  const result = loadPaymasterConfig(env);
  assert.ok(result);
  return result;
}
