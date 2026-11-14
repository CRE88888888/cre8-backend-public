import { getAddress, isAddress, keccak256, toFunctionSelector } from 'viem';
import type { Address, PublicClient } from 'viem';
import { TESTNET_97 } from './testnet-profile.js';
import hashes from './testnet-codehashes.js';
type Check = { name: string; level: 'ok' | 'warn' | 'fail'; detail: string };

/** Every address from the contracts manifest, plus SDK-pinned Kernel/policies and the 97 Quoter. */
export function testnetProfileTargets(): { name: string; address: Address }[] {
  return [
    ...Object.entries(TESTNET_97.contracts).map(([name, address]) => ({ name, address })),
    ...Object.entries(TESTNET_97.assets).flatMap(([symbol, asset]) => Object.entries(asset)
      .flatMap(([field, value]) => typeof value === 'string' && isAddress(value)
        ? [{ name: `asset.${symbol}.${field}`, address: getAddress(value) }] : [])),
  ];
}

const selectors: Record<string, readonly string[]> = {
  registry: ['enroll(address,uint256)', 'operator()', 'owner()'],
  executor: ['executeRebalance(address,(address,address,uint256,uint256,address,bytes)[],uint256)', 'numeraire()', 'oracle()', 'venues(address)'],
  router: ['oracleOf(address)', 'previewSwap(address,address,uint256)'],
  usdt: ['claimFor(address,uint256)', 'claimable(address)', 'isMinter(address)', 'decimals()'],
  paymaster: ['getDeposit()', 'verifyingSigner()'],
};

/** Hashes were captured from a clean git archive of contracts f7e5d52, never the main clone's WIP.
 * Pin every read to one block. Missing code/hash/selector and RPC errors always fail closed.
 */
export async function checkTestnetProfile(client: PublicClient, expected: Readonly<Record<string, string>> = hashes): Promise<Check[]> {
  try {
    if (await client.getChainId() !== 97) return [{ name: 'chain 97 profile', level: 'fail', detail: 'RPC chain id is not 97' }];
    const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
    const targets = testnetProfileTargets();
    const checks: Check[] = [];
    for (let offset = 0; offset < targets.length; offset += 8) {
      checks.push(...await Promise.all(targets.slice(offset, offset + 8).map(async ({ name, address }): Promise<Check> => {
        try {
          const code = await client.getCode({ address, blockNumber });
          if (!code || code === '0x' || !/^0x[0-9a-f]{64}$/.test(expected[name] ?? '') || keccak256(code) !== expected[name]) {
            return { name: `97 ${name}`, level: 'fail', detail: 'missing code or runtime codehash differs from pinned clean deployment' };
          }
          if ((selectors[name] ?? []).some((signature) => !code.toLowerCase().includes(toFunctionSelector(signature).slice(2)))) {
            return { name: `97 ${name}`, level: 'fail', detail: 'required ABI selector absent' };
          }
          return { name: `97 ${name}`, level: 'ok', detail: `${address} codehash / selectors verified` };
        } catch { return { name: `97 ${name}`, level: 'fail', detail: 'RPC code read unavailable' }; }
      })));
    }
    return checks;
  } catch { return [{ name: 'chain 97 profile', level: 'fail', detail: 'RPC chain or block unavailable' }]; }
}
