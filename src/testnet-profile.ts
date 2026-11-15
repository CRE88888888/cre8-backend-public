import type { Address } from 'viem';
import { TESTNET_97 } from './testnet-profile-data.js';
export { TESTNET_97 } from './testnet-profile-data.js';

export function configuredChainId(): number {
  const id = Number(process.env.CHAIN_ID?.trim() || '56');
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid CHAIN_ID');
  return id;
}

export function testnetAssets() {
  return [
    { address: TESTNET_97.contracts.usdt, symbol: 'USDT', decimals: 18, is_numeraire: true, usdt_pool: null, max_leg_usdt: null },
    ...Object.entries(TESTNET_97.assets).map(([symbol, asset]) => ({ address: asset.token, symbol, decimals: asset.decimals,
      is_numeraire: false, usdt_pool: asset.pool, max_leg_usdt: asset.maxLegUsdt })),
  ];
}

/** Reject explicit foreign addresses; empty settings resolve to the pinned deployment. */
export function profileAddress(chainId: number, name: string, raw: Address | null): Address | null {
  if (chainId !== 97) return raw;
  const addresses: Record<string, Address> = {
    REGISTRY_ADDRESS: TESTNET_97.contracts.registry, EXECUTOR_ADDRESS: TESTNET_97.contracts.executor,
    PAYMASTER_ADDRESS: TESTNET_97.contracts.paymaster, PAYMASTER_MOCK_USDT_ADDRESS: TESTNET_97.contracts.usdt,
  };
  const expected = addresses[name];
  if (expected === undefined) throw new Error('Unknown profile address setting');
  if (raw !== null && raw.toLowerCase() !== expected) throw new Error(name + ' must match chain 97 profile');
  return expected;
}
