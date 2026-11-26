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

/**
 * Core contracts the chain 97 profile has replaced (cre8-contracts#76: the AtpExecutor with the sale credit on the buy limit
 * is a new address with its own AtpYieldRegistry). Session keys installed before point at these: they are recognised as
 * needing an owner renewal (src/permissions.ts installedExecutorOf), never sent to. The old executor stays on chain, unpaused.
 */
/** Block of the profile executor's deployment receipt (cre8-contracts#76, DeployExecutorTestnet): where preflight starts
 * listing its venues. A Railway EXECUTOR_DEPLOYMENT_BLOCK from the superseded executor would predate this one's code. */
export const TESTNET_97_EXECUTOR_DEPLOYMENT_BLOCK = 144934928n;

export const TESTNET_97_SUPERSEDED = {
  executors: ['0xb65ec2ec6f5ab0a345b50caa454cf792c1ef2bb9'] as readonly Address[],
} as const;

/** Reject explicit foreign addresses; empty settings resolve to the pinned deployment. An EXECUTOR_ADDRESS still set to a
 * superseded executor also resolves to the current one: the services must not refuse to start on a value the profile replaced. */
export function profileAddress(chainId: number, name: string, raw: Address | null): Address | null {
  if (chainId !== 97) return raw;
  const addresses: Record<string, Address> = {
    REGISTRY_ADDRESS: TESTNET_97.contracts.registry, EXECUTOR_ADDRESS: TESTNET_97.contracts.executor,
    PAYMASTER_ADDRESS: TESTNET_97.contracts.paymaster, PAYMASTER_MOCK_USDT_ADDRESS: TESTNET_97.contracts.usdt,
  };
  const expected = addresses[name];
  if (expected === undefined) throw new Error('Unknown profile address setting');
  if (name === 'EXECUTOR_ADDRESS' && raw !== null && TESTNET_97_SUPERSEDED.executors.includes(raw.toLowerCase() as Address)) return expected;
  if (raw !== null && raw.toLowerCase() !== expected) throw new Error(name + ' must match chain 97 profile');
  return expected;
}
