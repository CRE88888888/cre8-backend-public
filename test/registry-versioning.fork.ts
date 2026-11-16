/** Explicit local-only acceptance: compile #54 in /tmp, then run on anvil chain 1337.
 * No gate/skip: missing artifacts or a non-local/non-anvil endpoint fail the run.
 * Tokens, fixed-price oracle/router and the owner account are test fixtures;
 * registry and executor are the unmodified #54 production artifacts.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { createPublicClient, createTestClient, createWalletClient, decodeEventLog, defineChain, encodeAbiParameters, encodeFunctionData, encodePacked, http, isHex, parseAbi, zeroHash } from 'viem';
import type { Abi, Address, Hex } from 'viem';
import { REGISTRY_ABI, REGISTRY_VERSION_ABI, EXECUTOR_ABI, enrollOnchain, publishVersionOnchain, readOwnerEnrollment } from '../src/chain.js';
import { kernelAddressesForChain } from '../src/addresses.js';
import { closePool, query } from '../src/db.js';
import { prepareEnrollmentApproval, registryConfigHash, readBuyVersionWindow, readVersionState } from '../src/registry-versioning.js';
import { planPortfolio } from '../src/snapshot.js';
import { MULTICALL3_ADDRESS } from '../src/positions.js';

const rpc = process.env.ANVIL_RPC_URL ?? 'http://127.0.0.1:8597';
const url = new URL(rpc);
assert.ok(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port === '8597' && !url.username && !url.password);
const root = process.env.P11_ARTIFACTS_DIR ?? '/tmp/cre8-be124';
const chain = defineChain({ id: 1337, name: 'P11 local acceptance', nativeCurrency: { name: 'test ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const client = createPublicClient({ chain, pollingInterval: 10, cacheTime: 0, transport: http(rpc, { retryCount: 0 }) });
const local = createTestClient({ chain, mode: 'anvil', transport: http(rpc) });
const owner: Address = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const wallet = createWalletClient({ chain, account: owner, transport: http(rpc) });
const tokenAbi = parseAbi(['constructor()', 'function mint(address,uint256)', 'function approve(address,uint256) returns(bool)', 'function balanceOf(address) view returns(uint256)']);
const accountAbi = parseAbi(['constructor(address owner_)', 'function sudo(address target,bytes data)']);
const U = 10n ** 18n;
after(closePool);

function object(value: unknown): Record<string, unknown> { assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value)); return Object.fromEntries(Object.entries(value)); }
const artifactSources: Record<string, string> = { BurnableToken: 'AtpExecutorBuyLimit.t', PricedOracle: 'AtpExecutorBuyLimit.t', PricedRouter: 'AtpExecutorBuyLimit.t', MockPermit2: 'AtpExecutor.t' };
function artifact(name: string, artifactRoot = root) { return object(JSON.parse(readFileSync(`${artifactRoot}/out/${artifactSources[name] ?? name}.sol/${name}.json`, 'utf8'))); }
function code(value: unknown): Hex { assert.ok(typeof value === 'string' && isHex(value) && /^0x[0-9a-f]+$/i.test(value)); return value; }
async function landed(hash: Hex) { const receipt = await client.waitForTransactionReceipt({ hash, timeout: 30_000 }); assert.equal(receipt.status, 'success'); return receipt; }
let linkedYieldView: Address | null = null;
async function deploy(name: string, abi: Abi, args: readonly unknown[] = [], artifactRoot = root) {
  const compiled = artifact(name, artifactRoot);
  const original = object(compiled.bytecode).object; assert.ok(typeof original === 'string');
  let raw = original;
  for (const [source, names] of Object.entries(object(object(compiled.bytecode).linkReferences ?? {}))) {
    for (const [libraryName, references] of Object.entries(object(names))) {
      assert.equal(source, 'src/atp/yield/YieldView.sol'); assert.equal(libraryName, 'YieldView');
      assert.ok(linkedYieldView); assert.ok(Array.isArray(references));
      for (const reference of references) {
        const slot = object(reference); assert.equal(slot.length, 20); assert.ok(typeof slot.start === 'number' && Number.isSafeInteger(slot.start) && slot.start >= 0);
        const start = 2 + slot.start * 2;
        raw = raw.slice(0, start) + linkedYieldView.slice(2) + raw.slice(start + 40);
      }
    }
  }
  const bytecode = code(raw);
  const receipt = await landed(await wallet.deployContract({ abi, bytecode, args }));
  assert.ok(receipt.contractAddress); return receipt.contractAddress;
}

test('#124 real #54 registry/executor: owner consent, buy, notice boundary, latest targets, historical sell and cancellation', async () => {
  assert.equal(await client.getChainId(), 1337);
  assert.ok(await local.getAutomine());
  // Repeated local deployments each start their registry ids at one. Detach only our prior fixtures.
  await query("delete from portfolios p using strategies s where p.strategy_id=s.id and s.provider=$1 and s.name='p11-local'", [owner]);
  await query("update strategies set onchain_id=null where provider=$1 and name='p11-local'", [owner]);
  await local.setCode({ address: MULTICALL3_ADDRESS, bytecode: code(object(artifact('P11Multicall', '/tmp/cre8-be124-account').deployedBytecode).object) });
  // Libraries remain linked exactly as the compiler declares, including a previously linked artifact.
  const executorArtifact = artifact('AtpExecutor');
  const libraries = object(object(object(executorArtifact.metadata).settings).libraries);
  const library = libraries['src/atp/yield/YieldView.sol:YieldView'];
  if (library === undefined) linkedYieldView = await deploy('YieldView', []);
  else {
    assert.ok(typeof library === 'string' && /^0x[0-9a-fA-F]{40}$/.test(library));
    await local.setCode({ address: library as Address, bytecode: code(object(artifact('YieldView').deployedBytecode).object) });
  }
  const cash = await deploy('BurnableToken', tokenAbi), old = await deploy('BurnableToken', tokenAbi), next = await deploy('BurnableToken', tokenAbi);
  const oracleAbi = parseAbi(['constructor(address)', 'function setPrice(address,uint256)']);
  const oracle = await deploy('PricedOracle', oracleAbi, [cash]);
  const router = await deploy('PricedRouter', parseAbi(['constructor()']));
  const permit = await deploy('MockPermit2', parseAbi(['constructor()']));
  const registry = await deploy('AtpRegistry', parseAbi(['constructor()']));
  assert.equal(await client.readContract({ address: registry, abi: REGISTRY_VERSION_ABI, functionName: 'MAX_STRATEGY_ASSETS' }), 128n);
  const executor = await deploy('AtpExecutor', parseAbi(['constructor(address,address,address,address,address,address,uint16,uint256)']), [registry, router, oracle, permit, owner, cash, 10000, 0n]);
  const account = await deploy('P11Account', accountAbi, [owner], '/tmp/cre8-be124-account');
  const registryAdmin = parseAbi(['function setOperator(address)', 'function setNumeraire(address)', 'function setDefaultFeeBps(uint16)']);
  await landed(await wallet.writeContract({ address: registry, abi: registryAdmin, functionName: 'setOperator', args: [owner] }));
  await landed(await wallet.writeContract({ address: registry, abi: registryAdmin, functionName: 'setNumeraire', args: [cash] }));
  await landed(await wallet.writeContract({ address: registry, abi: registryAdmin, functionName: 'setDefaultFeeBps', args: [0] }));
  for (const token of [old, next]) await landed(await wallet.writeContract({ address: oracle, abi: oracleAbi, functionName: 'setPrice', args: [token, U] }));
  const registration = await landed(await wallet.writeContract({ address: registry, abi: REGISTRY_ABI, functionName: 'registerStrategy', args: ['P11 acceptance', '', true] }));
  const event = registration.logs.map(log => { try { return decodeEventLog({ abi: REGISTRY_ABI, eventName: 'StrategyRegistered', ...log }); } catch { return null; } }).find(value => value !== null);
  assert.ok(event); const id = Number(event.args.id);
  const settings = { scheduleHash: zeroHash, settingsHash: zeroHash, performanceFeeBps: 1000 };
  const chainConfig = { chainId: 1337, rpcUrl: rpc, registryAddress: registry, account: wallet.account, wallet, publicClient: client, kernel: kernelAddressesForChain(1337) };
  const lock = async <T,>(_id: number, run: (held: () => void) => Promise<T>) => run(() => {});
  const publishedAt = (await client.getBlock()).timestamp;
  const at = new Date(Number(publishedAt + 86460n) * 1000);
  const publish = (assets: Address[], weightsBps: number[], index: number, activeAt: Date, fee = 1000) => {
    const versionSettings = { ...settings, performanceFeeBps: fee };
    return publishVersionOnchain(id, { assets, weightsBps, schedule: { kind: 'interval', intervalSeconds: 60 }, activeAt,
      versionSettings, configHash: registryConfigHash(assets, weightsBps, versionSettings), expectedVersion: index }, { chain: chainConfig, lock });
  };
  assert.equal(await publish([cash, old], [5000, 5000], 1, at), 1);
  console.log('[P11] first version scheduled');
  await assert.rejects(publish([cash, next], [5000, 5000], 2, at), 'only one pending version is allowed');
  await assert.rejects(prepareEnrollmentApproval(client, registry, account, id));
  await local.setNextBlockTimestamp({ timestamp: BigInt(at.getTime() / 1000) }); await local.mine({ blocks: 1 });
  await assert.rejects(enrollOnchain(account, id, chainConfig), /sudo/);
  const consent = await prepareEnrollmentApproval(client, registry, account, id);
  await landed(await wallet.writeContract({ address: registry, abi: REGISTRY_ABI, functionName: 'approveEnrollment', args: [BigInt(id), 1] }));
  await assert.rejects(enrollOnchain(account, id, chainConfig), /sudo/);
  // An EOA can approve itself, but that must never count as the smart account's consent.
  assert.equal(await client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'enrollmentApproval', args: [account] }), zeroHash);
  await landed(await wallet.writeContract({ address: account, abi: accountAbi, functionName: 'sudo', args: [registry, consent.call.data] }));
  assert.equal(await enrollOnchain(account, id, chainConfig), 1);
  console.log('[P11] owner consent consumed by operator enrollment');
  const directAccount = await deploy('P11Account', accountAbi, [owner], '/tmp/cre8-be124-account');
  await assert.rejects(readOwnerEnrollment(directAccount, id, chainConfig));
  const direct = await prepareEnrollmentApproval(client, registry, directAccount, id, true);
  await landed(await wallet.writeContract({ address: directAccount, abi: accountAbi, functionName: 'sudo', args: [registry, direct.call.data] }));
  assert.equal(await readOwnerEnrollment(directAccount, id, chainConfig), 1);
  console.log('[P11] owner direct sudo enrollment confirmed without operator enrollment');
  assert.equal(await client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'enrollmentApproval', args: [account] }), zeroHash);
  for (const token of [cash, old, next]) await landed(await wallet.writeContract({ address: account, abi: accountAbi, functionName: 'sudo', args: [token, encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [executor, 2n ** 256n - 1n] })] }));
  await landed(await wallet.writeContract({ address: cash, abi: tokenAbi, functionName: 'mint', args: [account, 1000n * U] }));
  const swapData = (tokenIn: Address, tokenOut: Address, amount: bigint, deadline: bigint) => {
    const inputs = [encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }], [executor, amount, amount, encodePacked(['address', 'uint24', 'address'], [tokenIn, 500, tokenOut]), true])];
    const data = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], ['0x00', inputs]);
    return encodeFunctionData({ abi: EXECUTOR_ABI, functionName: 'executeRebalance', args: [account,
      [{ tokenIn, tokenOut, amountIn: amount, amountOutMin: amount, venue: router, data }], deadline] });
  };
  const swap = async (tokenIn: Address, tokenOut: Address, amount: bigint) => landed(await wallet.writeContract({
    address: account, abi: accountAbi, functionName: 'sudo', args: [executor, swapData(tokenIn, tokenOut, amount, (await client.getBlock()).timestamp + 1800n)] }));
  await swap(cash, old, 100n * U);
  console.log('[P11] initial purchase landed');
  assert.equal(await client.readContract({ address: old, abi: tokenAbi, functionName: 'balanceOf', args: [account] }), 100n * U);
  await local.setNextBlockTimestamp({ timestamp: publishedAt + 604900n }); await local.mine({ blocks: 1 });
  const secondAt = new Date(Number((await client.getBlock()).timestamp + 86460n) * 1000);
  assert.equal(await publish([cash, next], [5000, 5000], 2, secondAt), 2);
  const buyWindow = await readBuyVersionWindow(client, registry, BigInt(id));
  assert.equal(buyWindow.activeVersion, 1); assert.equal(buyWindow.pendingActiveAt, BigInt(secondAt.getTime()/1000));
  assert.ok(buyWindow.pendingActiveAt);
  const cappedBuy = { account, to: executor, data: swapData(cash, old, U, buyWindow.pendingActiveAt - 60n) };
  await client.call(cappedBuy);
  console.log('[P11] replacement version scheduled');
  const sid = (await query<{ id: string }>("insert into strategies(provider,name,onchain_id) values($1,'p11-local',$2) returning id", [owner, id])).rows[0]; assert.ok(sid);
  for (const [version, token, active] of [[1, old, at], [2, next, secondAt]] as const) await query('insert into strategy_versions(strategy_id,version,allocation,schedule,active_at) values($1,$2,$3,$4,$5)', [sid.id, version, JSON.stringify({ assets: [{ address: cash, weightBps: 5000 }, { address: token, weightBps: 5000 }] }), JSON.stringify({ kind: 'interval', intervalSeconds: 60 }), active]);
  const p = (await query<{ id: string }>('insert into portfolios(user_id,strategy_id,version) values($1,$2,1) returning id', [owner, sid.id])).rows[0]; assert.ok(p);
  await query("insert into smart_accounts(portfolio_id,chain_id,address,owner,account_type) values($1,1337,$2,$3,'KERNEL')", [p.id, account.toLowerCase(), owner]);
  const priceRows = [cash, old, next].map((address, index) => ({ address: address.toLowerCase(), symbol: ['USDT', 'OLD', 'NEW'][index], usdt_pool: address, is_numeraire: index === 0 }));
  const plan = () => planPortfolio(Number(p.id), { chainId: 1337, publicClient: client, registryAddress: registry,
    query: (text, params) => text.includes('from priceable_assets') ? Promise.resolve({ rows: priceRows }) : query(text, params),
    priceToken: async () => ({ priceE8: 100000000n, decimals: 18 }) });
  await local.setNextBlockTimestamp({ timestamp: BigInt(secondAt.getTime() / 1000) - 1n }); await local.mine({ blocks: 1 });
  assert.equal((await plan()).pinnedVersion.version, 1);
  await assert.rejects(client.call(cappedBuy), 'the bounded executor payload must expire before activation even if inclusion is delayed');
  assert.equal((await readVersionState(client, registry, id, 2)).canCancel, false);
  await local.setNextBlockTimestamp({ timestamp: BigInt(secondAt.getTime() / 1000) }); await local.mine({ blocks: 1 });
  const effective = await plan(); assert.equal(effective.pinnedVersion.version, 2);
  assert.deepEqual(await readBuyVersionWindow(client, registry, BigInt(id)), {
    activeVersion: 2, timestamp: BigInt(secondAt.getTime()/1000), pendingActiveAt: null,
  });
  assert.equal(effective.targets.find(t => t.asset === old.toLowerCase())?.weightBps, 0);
  assert.equal(effective.snapshot.holdings.find(h => h.asset === old.toLowerCase())?.amountWei, 100n * U);
  assert.equal((await readVersionState(client, registry, id, 2)).canCancel, false);
  await assert.rejects(swap(cash, old, U));
  await swap(old, cash, 100n * U);
  console.log('[P11] historical asset sold after the activation boundary');
  assert.equal(await client.readContract({ address: old, abi: tokenAbi, functionName: 'balanceOf', args: [account] }), 0n);
  assert.equal((await client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'enrollments', args: [account] }))[1], 1);
  await local.setNextBlockTimestamp({ timestamp: publishedAt + 2n * 604900n }); await local.mine({ blocks: 1 });
  const decreaseAt = (await client.getBlock()).timestamp + 1n;
  await local.setNextBlockTimestamp({ timestamp: decreaseAt });
  assert.equal(await publish([cash, next], [5000, 5000], 3, new Date(Number(decreaseAt) * 1000), 500), 3, 'fee-only decrease may activate immediately');
  console.log('[P11] fee-only decrease published');
  assert.equal(await client.readContract({ address: registry, abi: REGISTRY_VERSION_ABI, functionName: 'activeVersion', args: [BigInt(id)] }), 3);
  await local.setNextBlockTimestamp({ timestamp: publishedAt + 3n * 604900n }); await local.mine({ blocks: 1 });
  const fourthAt = new Date(Number((await client.getBlock()).timestamp + 86460n) * 1000);
  assert.equal(await publish([cash, old], [5000, 5000], 4, fourthAt), 4);
  await landed(await wallet.writeContract({ address: registry, abi: REGISTRY_ABI, functionName: 'cancelVersion', args: [BigInt(id)] }));
  assert.equal((await readVersionState(client, registry, id, 4)).status, 'cancelled');
  await assert.rejects(publish([cash, old], [5000, 5000], 5, fourthAt), 'cancellation never resets the seven-day publication interval');
  await local.setNextBlockTimestamp({ timestamp: publishedAt + 4n * 604900n }); await local.mine({ blocks: 1 });
  const additional: Address[] = [];
  const tokenRuntime = code(object(artifact('BurnableToken').deployedBytecode).object);
  for (let index = 0; index < 126; index++) {
    const address = `0x${(0x100000 + index).toString(16).padStart(40, '0')}` as Address;
    await local.setCode({ address, bytecode: tokenRuntime }); additional.push(address);
  }
  const admitted = [cash, ...additional.slice(0, 125)];
  const fifthAt = new Date(Number((await client.getBlock()).timestamp + 86460n) * 1000);
  assert.equal(await publish(admitted, [9875, ...additional.slice(0, 125).map(() => 1)], 5, fifthAt), 5);
  await local.setNextBlockTimestamp({ timestamp: BigInt(fifthAt.getTime() / 1000) }); await local.mine({ blocks: 1 });
  assert.equal((await client.readContract({ address: registry, abi: REGISTRY_VERSION_ABI, functionName: 'historicalAssets', args: [BigInt(id)] })).length, 128);
  await local.setNextBlockTimestamp({ timestamp: publishedAt + 5n * 604900n }); await local.mine({ blocks: 1 });
  const overflow = additional[125]; assert.ok(overflow);
  await assert.rejects(publish([cash, overflow], [5000, 5000], 6, new Date(Number((await client.getBlock()).timestamp + 86460n) * 1000)), /StrategyAssetLimitExceeded/);
  assert.equal(await client.readContract({ address: registry, abi: REGISTRY_VERSION_ABI, functionName: 'versionCount', args: [BigInt(id)] }), 5n);
  console.log(JSON.stringify({ p11: 'enroll → buy → publish → 24h boundary → historical sale → cancellation → 128/129 union bound', versions: 5, historicalAssets: effective.historicalAssetCount, oldBalance: '0' }));
});
