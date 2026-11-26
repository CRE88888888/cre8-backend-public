import { TESTNET_97 } from '../../src/testnet-profile.js';
import type { AssetExecution } from '../../src/strategy-execution.js';

/** All supported risky assets, separate UTC minutes and the longest daily calendar. */
export function largestContributionExecution(): AssetExecution {
  const assets = Object.values(TESTNET_97.assets);
  const weight = Math.floor(10000 / assets.length);
  return {
    kind: 'per_asset', numeraire: TESTNET_97.contracts.usdt, rebalance: 'none',
    assets: [
      ...assets.map((asset, i) => ({
        asset: asset.token, weightBps: weight + (i === 0 ? 10000 % assets.length : 0), yield: null,
        execution: { kind: 'stack' as const, every: 'daily' as const, weekday: null,
          timeUtc: `${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`, slices: 365 },
      })),
      { asset: TESTNET_97.contracts.usdt, weightBps: 0, yield: null },
    ],
  };
}
