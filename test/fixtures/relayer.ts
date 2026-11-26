import { randomInt } from 'node:crypto';
import { encodeFunctionData, keccak256, parseAbi } from 'viem';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { TESTNET_97 } from '../../src/testnet-profile.js';

// Public anvil key only. Production's pinned signer is exercised by rejection tests.
export const relayerSigner = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
export async function signedFundingTx(kind: 'welcome' | 'faucet', account: Address, amountWei: bigint, overrides: { chainId?: number; to?: Address; value?: bigint; data?: Hex; gas?: bigint; nonce?: number; type?: 'legacy' | 'eip1559'; gasPrice?: bigint } = {}) {
  const abi = parseAbi(['function welcomeFor(address)', 'function claimFor(address,uint256)']);
  const data = kind === 'welcome' ? encodeFunctionData({ abi, functionName: 'welcomeFor', args: [account] })
    : encodeFunctionData({ abi, functionName: 'claimFor', args: [account, amountWei] });
  const common = { chainId: 97, nonce: randomInt(1, 1_000_000_000), gas: 150_000n, to: TESTNET_97.contracts.usdt, data, value: 0n, ...overrides };
  const raw = await relayerSigner.signTransaction(overrides.type === 'legacy'
    ? { ...common, type: 'legacy', gasPrice: overrides.gasPrice ?? 1n }
    : { ...common, type: 'eip1559', maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, gasPrice: undefined });
  return { hash: keccak256(raw), raw, operator: relayerSigner.address };
}
