/** Local fork capture of forge-deployed runtime, including constructor immutables.
 * bun scripts/sync-testnet-profile.ts <contracts checkout> http://127.0.0.1:8592 fork
 * Never reads signing material. Invalid inputs/code abort before any output is written.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, encodeAbiParameters, http, isAddress, keccak256 } from 'viem';
import type { Address } from 'viem';
import { TESTNET_ASSETS } from '../src/keeper/assets.js';
import caps from '../test/fixtures/testnet-launch-caps.json' with { type: 'json' };
import { TESTNET_97 } from '../src/testnet-profile.js';

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid manifest object');
  return value as Record<string, unknown>;
}
function addresses(value: unknown): Record<string, Address> {
  return Object.fromEntries(Object.entries(record(value)).map(([key, address]) => {
    if (typeof address !== 'string' || !isAddress(address, { strict: false })) throw new Error('invalid manifest address');
    return [key, address.toLowerCase() as Address];
  }));
}
export function profileFromManifest(input: unknown, expectedMode: 'fork' | 'public' = 'fork') {
  const m = record(input);
  if (m.chainId !== 97 || m.mode !== expectedMode || typeof m.gitCommit !== 'string' || !/^[0-9a-f]{40}$/.test(m.gitCommit) ||
      !Number.isSafeInteger(m.verifiedAtBlock) || Number(m.verifiedAtBlock) < 1 || typeof m.generatedAt !== 'string') throw new Error('invalid chain 97 manifest metadata / mode');
  const contracts = addresses(m.contracts), roles = addresses(m.roles);
  for (const key of ['registry', 'router', 'usdt', 'executor', 'yieldRegistry', 'paymaster', 'gasPolicy', 'entryPoint',
    'ownedDeployer', 'feed.USDT/USD', 'v3Factory', 'positionManager', 'universalRouter', 'permit2']) {
    if (!contracts[key]) throw new Error('missing manifest contract: ' + key);
  }
  for (const key of Object.keys(TESTNET_97.roles)) if (!roles[key]) throw new Error('missing manifest role: ' + key);
  const rawAssets = record(m.assets);
  if (Object.keys(rawAssets).length !== 92) throw new Error('manifest requires 92 assets');
  const assets = Object.fromEntries(TESTNET_ASSETS.map(spec => {
    const asset = addresses(rawAssets[spec.symbol]);
    if (!asset.token || !asset.pool || !asset.oracle || spec.hasFeed && (!asset.feed || !asset.secondary)) throw new Error('incomplete manifest asset');
    const cap: unknown = Reflect.get(caps, spec.symbol);
    return [spec.symbol, { ...asset, token: asset.token, pool: asset.pool, oracle: asset.oracle, decimals: spec.decimals, poolFee: spec.fee, maxLegUsdt: typeof cap === 'string' ? cap : '5000' }];
  }));
  const knownAssets = new Set([contracts.usdt, ...Object.values(assets).map(a => a.token)]);
  if (!Array.isArray(m.yieldMarkets) || m.yieldMarkets.length !== 30) throw new Error('manifest requires 30 yield markets');
  const yieldMarkets = m.yieldMarkets.map((value: unknown) => {
    const market = record(value);
    const a = addresses({ target: market.target, receipt: market.receipt, asset: market.asset });
    if (typeof market.marketId !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(market.marketId) ||
      !['Venus', 'Lista', 'Aave'].includes(String(market.protocol)) || !knownAssets.has(a.asset) ||
      typeof market.symbol !== 'string' || (market.symbol === 'USDT' ? contracts.usdt : assets[market.symbol]?.token) !== a.asset ||
      !Number.isSafeInteger(market.aprBps) || Number(market.aprBps) < 1 || Number(market.aprBps) > 10000 || market.rateLabel !== '模擬利率' ||
      market.rateType !== 'fixed_simulated_APR' || market.ownerAdjustable !== true ||
      typeof market.backgroundSupplyAssets !== 'string' || !/^[1-9][0-9]*$/.test(market.backgroundSupplyAssets)) throw new Error('invalid yield market');
    const kind = market.protocol === 'Venus' ? 1 : market.protocol === 'Lista' ? 2 : 3;
    if (!a.asset || keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'uint8' }, { type: 'address' }],
      ['cre8.testnet.yield.v1', kind, a.asset])) !== market.marketId.toLowerCase()) throw new Error('yield marketId does not bind protocol / underlying');
    return { ...market, ...a, target: a.target, receipt: a.receipt, asset: a.asset, marketId: market.marketId.toLowerCase() };
  });
  if (new Set(yieldMarkets.map(m => m.marketId)).size !== 30 || new Set(yieldMarkets.map(m => m.receipt)).size !== 30) throw new Error('duplicate yield market / receipt');
  // Only non-manifest infrastructure comes from the pinned SDK / official testnet Quoter.
  const extras = Object.fromEntries(Object.entries(TESTNET_97.contracts).filter(([name]) =>
    ['quoter', 'kernelMetaFactory', 'kernelFactoryV33', 'kernelImplV33', 'ecdsaValidatorV31', 'callPolicy', 'timestampPolicy', 'ecdsaSigner'].includes(name)));
  return { ...m, chainId: 97, mode: expectedMode, sourceCommit: m.gitCommit, roles, contracts: { ...contracts, ...extras }, assets, yieldMarkets };
}

export async function syncProfile(root: string, rpcUrl: string, mode: 'fork' | 'public') {
  const url = new URL(rpcUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw new Error('capture requires local anvil');
  const manifest: unknown = JSON.parse(readFileSync(resolve(root, 'deployments/testnet-97.json'), 'utf8'));
  const profile = profileFromManifest(manifest, mode);
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 0, timeout: 120000 }) });
  const info = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_nodeInfo', params: [] }) });
  const node: unknown = await info.json();
  if (!record(node).result || await client.getChainId() !== 97) throw new Error('capture requires chain 97 anvil');
  const block = await client.getBlock({ blockTag: 'latest' });
  if (block.number === null || block.hash === null) throw new Error('missing capture block');
  const targets = [
    ...Object.entries(profile.contracts),
    ...Object.entries(profile.assets).flatMap(([symbol, asset]) => Object.entries(asset).flatMap(([field, value]) =>
      typeof value === 'string' && isAddress(value) ? [[`asset.${symbol}.${field}`, value] as const] : [])),
    ...profile.yieldMarkets.flatMap(m => ['target', 'receipt'].map(field => [`yield.${m.marketId}.${field}`, Reflect.get(m, field)] as const)),
  ];
  const hashes: Record<string, string> = {};
  for (const [name, address] of targets) {
    if (typeof address !== 'string' || !isAddress(address)) throw new Error('invalid capture target');
    const code = await client.getCode({ address, blockNumber: block.number });
    if (!code || code === '0x') throw new Error('missing runtime code: ' + name);
    hashes[name] = keccak256(code);
  }
  // Compare forge runtime against captured code, ignoring only compiler-declared immutable slots.
  for (const name of ['AtpExecutor', 'AtpYieldRegistry']) {
    const artifact: unknown = JSON.parse(readFileSync(resolve(root, `out/${name}.sol/${name}.json`), 'utf8'));
    const runtime = record(record(artifact).deployedBytecode);
    if (typeof runtime.object !== 'string') throw new Error('missing forge runtime');
    const addr = name === 'AtpExecutor' ? profile.contracts.executor : profile.contracts.yieldRegistry;
    if (!addr) throw new Error('missing yield address');
    const deployed = await client.getCode({ address: addr, blockNumber: block.number });
    if (!deployed) throw new Error('missing deployed runtime');
    const normalize = (code: string) => {
      const bytes = Buffer.from(code.replace(/^0x/, ''), 'hex');
      for (const refs of Object.values(record(runtime.immutableReferences))) {
        if (!Array.isArray(refs)) throw new Error('invalid immutable references');
        for (const ref of refs) {
          const slot = record(ref);
          if (!Number.isSafeInteger(slot.start) || !Number.isSafeInteger(slot.length)) throw new Error('invalid immutable slot');
          bytes.fill(0, Number(slot.start), Number(slot.start) + Number(slot.length));
        }
      }
      return bytes.toString('hex');
    };
    if (normalize(deployed) !== normalize(runtime.object)) throw new Error('forge runtime differs: ' + name);
  }
  if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error('capture reorg');
  const provenance = { source: 'local anvil runtime from forge DeployTestnet; executor/registry checked against forge deployedBytecode + immutableReferences',
    contractsCommit: profile.sourceCommit, forgeCheckoutCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    blockNumber: block.number.toString(), blockHash: block.hash };
  const abi = (name: string) => JSON.parse(execFileSync('forge', ['inspect', name, 'abi', '--json'], { cwd: root, encoding: 'utf8' })) as unknown[];
  const executorAbi = abi('AtpExecutor').filter(value => {
    const fn = record(value);
    return fn.type === 'error' || ['yieldRegistry', 'executeSupply', 'executeWithdraw', 'previewAccountValue', 'previewBuyAllowance', 'SupplyExecuted', 'WithdrawExecuted'].includes(String(fn.name));
  });
  const registryAbi = abi('AtpYieldRegistry');
  writeFileSync('deploy/testnet-97.json', JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync('deploy/testnet-97-codehashes.json', JSON.stringify({ ...provenance, hashes }, null, 2) + '\n');
  writeFileSync('src/testnet-profile-data.ts', '// Generated by scripts/sync-testnet-profile.ts; do not edit.\nexport const TESTNET_97 = ' + JSON.stringify(profile, null, 2) + ' as const;\n');
  writeFileSync('src/testnet-codehashes.ts', '// Generated from deploy/testnet-97-codehashes.json by scripts/sync-testnet-profile.ts.\nexport default ' + JSON.stringify(hashes, null, 2) + ' as const;\n');
  writeFileSync('src/yield-abi.ts', '// Generated by forge inspect; source contracts ' + profile.sourceCommit + '.\nexport const YIELD_EXECUTOR_ABI = ' + JSON.stringify(executorAbi) + ' as const;\nexport const YIELD_REGISTRY_ABI = ' + JSON.stringify(registryAbi) + ' as const;\n');
  execFileSync('bun', ['scripts/gen-yield-golden.ts']);
  console.log('generated chain 97 profile: 92 assets, 30 yield markets, ' + targets.length + ' runtime pins');
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const [, , root, rpcUrl, mode = 'fork'] = process.argv;
  if (!root || !rpcUrl || !['fork', 'public'].includes(mode)) throw new Error('usage: sync-testnet-profile.ts <contracts root> <local rpc> [fork|public]');
  await syncProfile(resolve(root), rpcUrl, mode === 'public' ? 'public' : 'fork');
}
