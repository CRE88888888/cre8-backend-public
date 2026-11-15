import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, loadSessionKeyConfig } from '../src/config.js';
import { kernelAddressesForChain } from '../src/addresses.js';
import { listPriceableAssets } from '../src/assets.js';
import { readMaxLegUsdE8 } from '../src/rebalance-plan.js';
import { TESTNET_97, testnetAssets } from '../src/testnet-profile.js';
import launchCaps from './fixtures/testnet-launch-caps.json' with { type: 'json' };
import { TESTNET_ASSETS } from '../src/keeper/assets.js';
import hashes from '../src/testnet-codehashes.js';
import { testnetProfileTargets } from '../src/testnet-preflight.js';
import manifest from '../deploy/testnet-97.json' with { type: 'json' };

test('#79 profile matches every address in contracts yield manifest, retaining admission caps', () => {
  assert.equal(TESTNET_97.sourceCommit, manifest.gitCommit);
  assert.equal(TESTNET_97.gitCommit, manifest.gitCommit);
  assert.deepEqual(TESTNET_97.roles, Object.fromEntries(Object.entries(manifest.roles).map(([k, v]) => [k, v.toLowerCase()])));
  for (const [name, address] of Object.entries(manifest.contracts)) {
    assert.equal(Reflect.get(TESTNET_97.contracts, name), address.toLowerCase(), name);
  }
  assert.equal(Object.keys(TESTNET_97.assets).length, Object.keys(manifest.assets).length);
  for (const [symbol, asset] of Object.entries(manifest.assets)) {
    const pinned: unknown = Reflect.get(TESTNET_97.assets, symbol);
    assert.ok(typeof pinned === 'object' && pinned !== null);
    for (const [field, address] of Object.entries(asset)) assert.equal(Reflect.get(pinned, field), address.toLowerCase(), symbol + '.' + field);
    assert.ok(Number.isInteger(Reflect.get(pinned, 'decimals')));
    assert.match(String(Reflect.get(pinned, 'maxLegUsdt')), /^[1-9][0-9]*$/);
  }
});

test('#69 chain 97 resolves its manifest without mainnet env overrides', async () => {
  const env = { DATABASE_URL: 'unused', CHAIN_ID: '97' };
  assert.equal(loadConfig(env).registryAddress, TESTNET_97.contracts.registry);
  assert.equal(loadSessionKeyConfig(env).executorAddress, TESTNET_97.contracts.executor);
  assert.equal(kernelAddressesForChain(97).entryPointV07, TESTNET_97.contracts.entryPoint);
  for (const name of ['REGISTRY_ADDRESS', 'EXECUTOR_ADDRESS', 'PAYMASTER_ADDRESS', 'PAYMASTER_MOCK_USDT_ADDRESS']) {
    assert.throws(() => loadConfig({ ...env, [name]: '0x55d398326f99059ff775485246999027b3197955' }), /97/);
  }
});

test('#69 93 profile assets and max-leg never query the mainnet seed; unknown assets fail closed', async () => {
  const noDb = async () => { throw new Error('mainnet seed must not be read'); };
  const assets = await listPriceableAssets(noDb, undefined, 97);
  assert.equal(assets.length, 93);
  assert.equal(assets.filter((asset) => asset.isNumeraire).length, 1);
  assert.equal(assets.find((asset) => asset.isNumeraire)?.address, TESTNET_97.contracts.usdt);
  assert.equal(testnetAssets().find((asset) => asset.symbol === 'DOGE')?.decimals, 8);
  const limits = await readMaxLegUsdE8(assets.map((asset) => asset.address), noDb, 97);
  assert.equal(limits.size, 93);
  await assert.rejects(readMaxLegUsdE8(['0x55d398326f99059ff775485246999027b3197955'], noDb, 97), /MAX_LEG_UNAVAILABLE/);
});

test('#69 chain 97 session GasPolicy pins our paymaster; chain 56 keeps its existing policy', async () => {
  const { describePolicies } = await import('../src/permissions.js');
  const gas97 = describePolicies({ executorAddress: TESTNET_97.contracts.executor, validUntil: 1_800_000_000, chainId: 97 }).gas;
  assert.equal(gas97.enforcePaymaster, true);
  assert.equal(gas97.allowedPaymaster.toLowerCase(), TESTNET_97.contracts.paymaster);
  assert.equal(describePolicies({ executorAddress: TESTNET_97.contracts.executor, validUntil: 1_800_000_000, chainId: 56 }).gas.enforcePaymaster, false);
});

test('#69 allocation inserts mock USDT, accepts zero cash weight, rejects foreign assets and accepts more than 16 assets', async () => {
  const { validateAllocation } = await import('../src/strategies.js');
  const asset = { address: TESTNET_97.assets.WBNB.token, weightBps: 10000 };
  assert.equal(validateAllocation({ assets: [asset] }, 97).assets.at(-1)?.address, TESTNET_97.contracts.usdt);
  assert.equal(validateAllocation({ assets: [asset, { address: TESTNET_97.contracts.usdt, weightBps: 0 }] }, 97).assets.length, 2);
  assert.throws(() => validateAllocation({ assets: [{ address: '0x55d398326f99059ff775485246999027b3197955', weightBps: 10000 }] }, 97), /chain 97/);
  const fifteen = Object.values(TESTNET_97.assets).slice(0, 15).map((a, i) => ({ address: a.token, weightBps: i === 0 ? 1250 : 625 }));
  assert.equal(validateAllocation({ assets: fifteen }, 97).assets.length, 16);
  assert.equal(validateAllocation({ assets: Object.values(TESTNET_97.assets).slice(0, 16).map((a) => ({ address: a.token, weightBps: 625 })) }, 97).assets.length, 17);
});

test('#69 profile preflight verifies every codehash and selector; wrong chain, empty code/hash, RPC and block errors fail closed', async () => {
  const { createPublicClient, custom, keccak256, toFunctionSelector } = await import('viem');
  const { checkTestnetProfile, testnetProfileTargets } = await import('../src/testnet-preflight.js');
  const signatures = ['enroll(address,uint256)', 'operator()', 'owner()', 'executeRebalance(address,(address,address,uint256,uint256,address,bytes)[],uint256)',
    'executeSupply(address,bytes32,uint256,uint256,uint256)', 'executeWithdraw(address,bytes32,uint256,uint256,uint256)', 'yieldRegistry()', 'quoteSupply(bytes32,address,uint256)', 'quoteWithdraw(bytes32,uint256)', 'market(bytes32)', 'setYieldPolicy(bytes32,uint256,bool)', 'numeraire()', 'oracle()', 'venues(address)', 'oracleOf(address)', 'previewSwap(address,address,uint256)', 'claimFor(address,uint256)', 'claimable(address)', 'isFaucet(address)', 'welcomeFor(address)', 'decimals()', 'getDeposit()', 'verifyingSigner()'];
  const code = `0x${signatures.map((s) => '63' + toFunctionSelector(s).slice(2)).join('')}` as const;
  const hashes = Object.fromEntries(testnetProfileTargets().map((t) => [t.name, keccak256(code)]));
  for (const mode of ['ok', 'chain', 'chain-rpc', 'block', 'code-rpc', 'empty', 'wrong-hash', 'missing-hash', 'selector']) {
    const client = createPublicClient({ transport: custom({ request: async ({ method }) => {
      if (method === 'eth_chainId') { if (mode === 'chain-rpc') throw new Error('secret-rpc'); return mode === 'chain' ? '0x38' : '0x61'; }
      if (method === 'eth_blockNumber') { if (mode === 'block') throw new Error('secret-rpc'); return '0x69'; }
      if (method === 'eth_getCode') {
        if (mode === 'code-rpc') throw new Error('secret-rpc');
        return mode === 'empty' ? '0x' : mode === 'selector' ? '0x6000' : code;
      }
      throw new Error('unexpected RPC');
    } }, { retryCount: 0 }) });
    const expected = mode === 'missing-hash' ? {} : Object.fromEntries(Object.entries(hashes).map(([name, hash]) => [name, mode === 'wrong-hash' ? '0x' + '00'.repeat(32) : mode === 'selector' ? keccak256('0x6000') : hash]));
    const checks = await checkTestnetProfile(client, expected);
    assert.equal(checks.some((c) => c.level === 'fail'), mode !== 'ok', mode);
    assert.doesNotMatch(JSON.stringify(checks), /secret-rpc/);
    if (mode === 'ok') assert.equal(checks.length, 380);
  }
});

test('#69 routing never calls aggregators on 97, including refresh; only testnet router/quoter and V3', async () => {
  const { createPublicClient, custom, encodeAbiParameters } = await import('viem');
  const { bscTestnet } = await import('viem/chains');
  const { buildRoutedStep, refreshFloors } = await import('../src/rebalance-plan.js');
  const { pancakeRoutingForChain } = await import('../src/addresses.js');
  let aggregatorCalls = 0;
  const quoteAggregator = async () => { aggregatorCalls++; return null; };
  for (const mode of ['ok', 'zero', 'below', 'rpc', 'whitelist']) {
    const client = createPublicClient({ chain: bscTestnet, transport: custom({ request: async ({ method, params }) => {
      assert.equal(method, 'eth_call');
      const payload: unknown = params; assert.ok(Array.isArray(payload));
      const call: unknown = payload[0]; assert.ok(typeof call === 'object' && call !== null);
      const to: unknown = Reflect.get(call, 'to'); assert.equal(typeof to, 'string');
      if (mode === 'rpc') throw new Error('secret-rpc');
      if (String(to).toLowerCase() === TESTNET_97.contracts.executor) return encodeAbiParameters([{ type: 'uint8' }, { type: 'address' }], [mode === 'whitelist' ? 0 : 1, TESTNET_97.contracts.universalRouter]);
      if (String(to).toLowerCase() === TESTNET_97.contracts.v3Factory) return encodeAbiParameters([{ type: 'address' }], [TESTNET_97.assets.WBNB.pool]);
      if (String(to).toLowerCase() === TESTNET_97.contracts.quoter) return encodeAbiParameters([{ type: 'uint256' }, { type: 'uint160[]' }, { type: 'uint32[]' }, { type: 'uint256' }], [mode === 'zero' ? 0n : mode === 'below' ? 1n : 1000n, [], [], 0n]);
      if (String(to).toLowerCase() === TESTNET_97.contracts.router) return encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [100n, 100n]);
      throw new Error('foreign address');
    } }, { retryCount: 0 }) });
    const params = { publicClient: client, executor: TESTNET_97.contracts.executor, tokenIn: TESTNET_97.contracts.usdt, tokenOut: TESTNET_97.assets.WBNB.token,
      amountIn: 100n, oracleFloor: 100n, minGross: 100n, poolFee: 500, deadline: 2000000000n, feeBps: 0, blockNumber: 1n };
    const step = await buildRoutedStep(params, { quoteAggregator });
    assert.equal(step?.venue, mode === 'ok' ? TESTNET_97.contracts.universalRouter : undefined, mode);
    if (step) {
      const refresh = await refreshFloors({ ...params, oracle: TESTNET_97.contracts.router, steps: [step], quoteAggregator });
      assert.equal(refresh.ok, true);
      assert.equal((await refreshFloors({ ...params, oracle: TESTNET_97.contracts.router, steps: [{ ...step, venue: '0x1111111111111111111111111111111111111111' }], quoteAggregator })).ok, false);
    }
  }
  assert.equal(aggregatorCalls, 0);
  assert.equal(pancakeRoutingForChain(97).v2Factory, null);
});

test('#69 chain 56 keeps its existing address-format diagnostics', () => {
  assert.throws(() => loadSessionKeyConfig({ CHAIN_ID: '56', EXECUTOR_ADDRESS: 'invalid' }),
    (error: unknown) => error instanceof Error && error.message === 'EXECUTOR_ADDRESS must be a 0x-prefixed 20-byte hex address');
});


test('#87 all 92 raw specs/caps align, original caps stay fixed and every runtime target is pinned', async () => {
  assert.equal(TESTNET_ASSETS.length, 92);
  assert.equal(Object.keys(launchCaps).length, 38);
  let extensions = 0;
  const noDb = async () => { throw new Error('testnet must not query mainnet caps'); };
  const caps = await readMaxLegUsdE8(TESTNET_ASSETS.map((s) => {
    const asset = TESTNET_97.assets[s.symbol];
    return asset.token;
  }), noDb, 97);
  for (const spec of TESTNET_ASSETS) {
    const asset = TESTNET_97.assets[spec.symbol];
    assert.equal(asset.decimals, spec.decimals); assert.equal(asset.poolFee, spec.fee);
    const approved = Object.entries(launchCaps).find(([symbol]) => symbol === spec.symbol)?.[1];
    if (approved !== undefined) assert.equal(asset.maxLegUsdt, approved);
    else {
      extensions++;
      assert.equal(asset.maxLegUsdt, '5000');
      assert.equal(caps.get(asset.token), 5000n * 100_000_000n);
      assert.ok(!Object.hasOwn(asset, 'secondary') && !spec.hasFeed);
    }
  }
  assert.equal(extensions, 54);
  assert.deepEqual(Object.keys(hashes).sort(), testnetProfileTargets().map((t) => t.name).sort());
  assert.equal(testnetProfileTargets().length, 380);
  assert.equal(TESTNET_97.assets.TONCOIN.decimals, 9);
  assert.ok(Object.hasOwn(TESTNET_97.assets, 'Cake'));
});

test('#92 all 92 admitted assets and automatic USDT validate as one immutable per-asset config', async () => {
  const {validateAllocation}=await import('../src/strategies.js');
  const {validateAssetConfig}=await import('../src/strategy-execution.js');
  const assets=Object.values(TESTNET_97.assets).map((a,i)=>({address:a.token,weightBps:i===0?172:108}));
  const allocation=validateAllocation({assets},97);
  assert.equal(allocation.assets.length,93);
  assert.equal(validateAssetConfig(undefined,allocation,97).assets.length,93);
  const first=assets[0];assert.ok(first);
  const duplicate=structuredClone(assets);duplicate[91]={...first,weightBps:108};
  assert.throws(()=>validateAllocation({assets:duplicate},97),/duplicate/i);
});

test('#97 strict profile also verifies paymaster signing/deposit, minter and nonzero feature budgets', async () => {
  const { createPublicClient, custom, encodeAbiParameters, keccak256, toFunctionSelector } = await import('viem');
  const { privateKeyToAccount } = await import('viem/accounts');
  const { checkTestnetProfile, testnetProfileTargets } = await import('../src/testnet-preflight.js');
  const key = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  const env = { CHAIN_ID: '97', RPC_URL: 'http://127.0.0.1:8577', PAYMASTER_SIGNER_PRIVATE_KEY: key };
  const signatures = ['enroll(address,uint256)', 'operator()', 'owner()', 'executeRebalance(address,(address,address,uint256,uint256,address,bytes)[],uint256)',
    'executeSupply(address,bytes32,uint256,uint256,uint256)', 'executeWithdraw(address,bytes32,uint256,uint256,uint256)', 'yieldRegistry()', 'quoteSupply(bytes32,address,uint256)', 'quoteWithdraw(bytes32,uint256)', 'market(bytes32)', 'setYieldPolicy(bytes32,uint256,bool)', 'numeraire()', 'oracle()', 'venues(address)', 'oracleOf(address)', 'previewSwap(address,address,uint256)', 'claimFor(address,uint256)', 'claimable(address)', 'isFaucet(address)', 'welcomeFor(address)', 'decimals()', 'getDeposit()', 'verifyingSigner()'];
  const code = `0x${signatures.map(s => '63' + toFunctionSelector(s).slice(2)).join('')}` as const;
  const expected = Object.fromEntries(testnetProfileTargets().map(t => [t.name, keccak256(code)]));
  for (const mode of ['ok', 'wrong-numeraire', 'missing-signer', 'wrong-signer', 'wrong-operator', 'deposit-zero', 'deposit-below', 'deposit-equal', 'minter', 'rpc', 'missing-data', 'timeout',
    'PAYMASTER_ACCOUNT_DAILY_COUNT', 'PAYMASTER_ACCOUNT_DAILY_GAS', 'PAYMASTER_ACCOUNT_DAILY_WEI', 'PAYMASTER_SITE_DAILY_GAS', 'PAYMASTER_SITE_DAILY_WEI',
    'ACCOUNT_DAILY_GAS', 'ACCOUNT_DAILY_GAS_USD_E8', 'FAUCET_USDT_AMOUNT_WEI', 'FAUCET_USDT_SITE_DAILY_WEI', 'WELCOME_USDT_SITE_DAILY_WEI']) {
    const client = createPublicClient({ transport: custom({ request: async ({ method, params }) => {
      if (method === 'eth_chainId') return '0x61';
      if (method === 'eth_blockNumber') return '0x69';
      if (method === 'eth_getCode') return code;
      if (method === 'eth_call') {
        if (mode === 'rpc') throw new Error('SECRET_RPC');
        if (mode === 'missing-data') return '0x';
        if (mode === 'timeout') return new Promise<never>(() => {});
        const call = params?.[0]; assert.ok(call && typeof call === 'object' && 'data' in call);
        assert.equal(params?.[1], '0x69');
        const selector = String(call.data).slice(0, 10);
        if (selector === toFunctionSelector('verifyingSigner()')) return encodeAbiParameters([{ type: 'address' }], [mode === 'wrong-signer' ? TESTNET_97.roles.owner : privateKeyToAccount(key).address]);
        if (selector === toFunctionSelector('entryPoint()')) return encodeAbiParameters([{ type: 'address' }], [TESTNET_97.contracts.entryPoint]);
        if (selector === toFunctionSelector('numeraire()')) return encodeAbiParameters([{ type: 'address' }], [mode === 'wrong-numeraire' ? TESTNET_97.roles.owner : TESTNET_97.contracts.usdt]);
        if (selector === toFunctionSelector('getDeposit()')) return encodeAbiParameters([{ type: 'uint256' }], [mode === 'deposit-zero' ? 0n : mode === 'deposit-below' ? 10n ** 16n - 1n : 10n ** 16n]);
        if (selector === toFunctionSelector('isFaucet(address)')) return encodeAbiParameters([{ type: 'bool' }], [mode !== 'minter']);
      }
      throw new Error('unexpected RPC');
    } }, { retryCount: 0 }) });
    const checks = await checkTestnetProfile(client, expected, { strict: true, timeoutMs: 5,
      env: { ...env, ...(mode === 'missing-signer' ? { PAYMASTER_SIGNER_PRIVATE_KEY: '' } : mode === 'wrong-operator' ? { OPERATOR_PRIVATE_KEY: key } : mode.includes('_') ? { [mode]: '0' } : {}) } });
    assert.equal(checks.some(c => c.level === 'fail'), !['ok', 'deposit-equal'].includes(mode), mode);
    assert.doesNotMatch(JSON.stringify(checks), /SECRET_RPC|ac0974be/);
  }
});
