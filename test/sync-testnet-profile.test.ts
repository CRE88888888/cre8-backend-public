import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak256 } from 'viem';
import { profileFromManifest, verifyArtifactSources } from '../scripts/sync-testnet-profile.js';
import manifest from '../deploy/testnet-97.json' with { type: 'json' };

test('#110 missing YieldView aborts profile generation before any runtime capture', () => {
  const contracts: Record<string, string> = { ...manifest.contracts };
  delete contracts.yieldView;
  assert.throws(() => profileFromManifest({ ...manifest, contracts }), /missing manifest contract: yieldView/);
});

test('#85 generator rejects chain/mode/count/identity/duplicate/missing manifest data before writes', () => {
  // Actual current deployment input is checked again in testnet-profile.test.ts.
  for (const change of [{ chainId: 56 }, { mode: 'public' }, { mode: undefined }, { gitCommit: '' },
    { assets: {} }, { yieldMarkets: [] }, { contracts: {} }, { roles: {} }]) {
    assert.throws(() => profileFromManifest({ ...manifest, ...change }));
  }
});

test('#106 artifact provenance rejects a rebuild from different or missing source before generation', () => {
  const bytes = Buffer.from('contract Reviewed {}');
  const artifact = { metadata: { sources: { 'src/Reviewed.sol': { keccak256: keccak256(bytes) } } } };
  verifyArtifactSources(artifact, path => { assert.equal(path, 'src/Reviewed.sol'); return bytes; });
  assert.throws(() => verifyArtifactSources(artifact, () => Buffer.from('contract Unreviewed {}')), /source differs/);
  assert.throws(() => verifyArtifactSources(artifact, () => { throw new Error('missing source'); }), /missing source/);
  for (const invalid of [{}, { metadata: { sources: {} } }, { metadata: { sources: { 'src/Reviewed.sol': {} } } }]) {
    assert.throws(() => verifyArtifactSources(invalid, () => bytes));
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


test('#124 optional performanceFeeLedger metadata survives parsing without core integration', () => {
  const input = { ...manifest, performanceFeeLedger: {
    address: manifest.contracts.registry, registry: manifest.contracts.registry, oracle: manifest.contracts.router,
    yieldRegistry: manifest.contracts.yieldRegistry, numeraire: manifest.contracts.usdt, platformRecipient: manifest.roles.owner,
    initialPlatformShareBps: 1000, maxPlatformShareBps: 2000, platformNoticeSeconds: 604800, chainId: manifest.chainId,
    registryVersionDelaySeconds: manifest.versioning.publicationDelaySeconds,
    registryPublicationIntervalSeconds: manifest.versioning.publicationIntervalSeconds,
    maxStrategyAssets: 128, minCreatorFeeBps: 500, maxCreatorFeeBps: 2000,
  } };
  const profile = profileFromManifest(input);
  assert.deepEqual(Reflect.get(profile, 'performanceFeeLedger'), input.performanceFeeLedger);
  assert.equal(Reflect.get(profileFromManifest(manifest), 'performanceFeeLedger'), undefined);
  assert.deepEqual(profile.contracts, profileFromManifest(manifest).contracts);
});
