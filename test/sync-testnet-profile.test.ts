import assert from 'node:assert/strict';
import { test } from 'node:test';
import { profileFromManifest } from '../scripts/sync-testnet-profile.js';
import manifest from '../deploy/testnet-97.json' with { type: 'json' };

test('#85 generator rejects chain/mode/count/identity/duplicate/missing manifest data before writes', () => {
  // Actual current deployment input is checked again in testnet-profile.test.ts.
  for (const change of [{ chainId: 56 }, { mode: 'public' }, { mode: undefined }, { gitCommit: '' },
    { assets: {} }, { yieldMarkets: [] }, { contracts: {} }, { roles: {} }]) {
    assert.throws(() => profileFromManifest({ ...manifest, ...change }));
  }
});

test('#85 identical manifest produces identical full profile; all markets and roles are retained without hand-copied addresses', () => {
  const profile = profileFromManifest(manifest);
  assert.deepEqual(profileFromManifest(structuredClone(manifest)), profile);
  assert.equal(Object.keys(profile.assets).length, 92); assert.equal(profile.yieldMarkets.length, 30);
  assert.equal(profile.contracts.executor, manifest.contracts.executor.toLowerCase());
  assert.equal(profile.contracts.yieldRegistry, manifest.contracts.yieldRegistry.toLowerCase());
  for (const [key, value] of Object.entries(manifest.roles)) assert.equal(profile.roles[key], value.toLowerCase());
  assert.deepEqual(profile.yieldMarkets.map(m => m.marketId), manifest.yieldMarkets.map(m => m.marketId.toLowerCase()));
  for (const change of [
    [...manifest.yieldMarkets.slice(0, -1)],
    [...manifest.yieldMarkets.slice(0, -1), manifest.yieldMarkets[0]],
    manifest.yieldMarkets.map((m, i) => i === 0 ? { ...m, asset: manifest.contracts.registry } : m),
    manifest.yieldMarkets.map((m, i) => i === 0 ? { ...m, rateLabel: 'real yield' } : m),
  ]) assert.throws(() => profileFromManifest({ ...manifest, yieldMarkets: change }));
  assert.throws(() => profileFromManifest({ ...manifest, mode: 'public' }));
  assert.equal(profileFromManifest({ ...manifest, mode: 'public' }, 'public').mode, 'public');
});
