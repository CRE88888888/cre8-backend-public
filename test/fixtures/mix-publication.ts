import { encodeFunctionData } from 'viem';
import { mixChainAllocation } from '../../src/mix-domain.js';
import { typedVersionSettings, registryConfigHash } from '../../src/registry-versioning.js';
import { validateAssetConfig } from '../../src/strategy-execution.js';
import { REGISTRY_ABI } from '../../src/registry-abi.js';
import type { MixPublication } from '../../src/mix-publication.js';
import { TESTNET_97 as T } from '../../src/testnet-profile.js';
export function publicationFixture(): MixPublication {
  const allocation = { assets: mixChainAllocation([{ assetId: T.assets.NVDAB.token, weightBps: 10000 }], [], 128).assets };
  const execution = validateAssetConfig(undefined, allocation, 97), schedule = { kind: 'funding' as const };
  const settings = typedVersionSettings({ chainId: 97, allocation, execution, schedule, activeAt: new Date(0) });
  const assets = allocation.assets.map(a => a.address as `0x${string}`), weights = allocation.assets.map(a => a.weightBps);
  return { strategy_id: '1', chain_id: '97', registry: T.contracts.registry, onchain_strategy_id: '178000001', creation_request_id: null,
    allocation: { ...allocation, p11: settings }, schedule, execution, config_hash: registryConfigHash(assets, weights, settings),
    calldata: encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'publishSettingsVersion', args: [178000001n, assets, weights,
      settings.scheduleHash, settings.settingsHash, settings.performanceFeeBps, 0n] }), state: 'prepared', created_at: new Date(), alerted_at: null,
    published_tx_hash: null, published_block_number: null, published_block_hash: null };
}
