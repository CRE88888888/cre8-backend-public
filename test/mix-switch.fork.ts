import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { before, test } from 'node:test';
import { createKernelAccount } from '@zerodev/sdk';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { toECDSASigner } from '@zerodev/permissions/signers';
import { KERNEL_V3_3 } from '@zerodev/sdk/constants';
import { concatHex, custom, createPublicClient, createTestClient, createWalletClient, decodeErrorResult, decodeEventLog, encodeFunctionData, encodeAbiParameters, erc20Abi, getAddress, http, isHex, maxUint256, parseAbi, zeroHash } from 'viem';
import type { Address, Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { entryPoint07Abi, toPackedUserOperation } from 'viem/account-abstraction';
import { bscTestnet } from 'viem/chains';
import { mixChainAllocation } from '../src/mix-domain.js';
import { readMixEnrollmentProof, findMixEnrollment } from '../src/mix-chain.js';
import type { MixOwnerCall } from '../src/mix-approval.js';
import { mixOwnerCalls } from '../src/mix-approval.js';
import { computeSalt, getKernelAccountParams } from '../src/kernel.js';
import { buildSessionPermissions } from '../src/permissions.js';
import { REGISTRY_ABI, REGISTRY_VERSION_ABI, EXECUTOR_ABI } from '../src/chain.js';
import { buildStep, minGrossFor } from '../src/rebalance-plan.js';
import { refreshP11Markets } from './fixtures/p11-kernel.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';

// All writes are pinned to this lane's local anvil, with public test accounts.
const rpc = 'http://127.0.0.1:8578';
const transport = http(rpc, { timeout: 30000, retryCount: 0 });
const client = createPublicClient({ chain: bscTestnet, transport, cacheTime: 0, pollingInterval: 20 });
const local = createTestClient({ chain: bscTestnet, mode: 'anvil', transport });
const mnemonic = 'test test test test test test test test test test test junk';
const owner = mnemonicToAccount(mnemonic, { addressIndex: 2 });
const session = mnemonicToAccount(mnemonic, { addressIndex: 3 });
const wallet = createWalletClient({ chain: bscTestnet, account: owner, transport });
const C = T.contracts;
const WAD = 10n ** 18n;
const oldAsset = T.assets.NVDAB.token;
const newAsset = T.assets.TSLAB.token;
const retainedAsset = T.assets.WBNB.token;
const entryPoint = { address: C.entryPoint, version: '0.7' } as const;
const extra = parseAbi([
  'function effectiveFeeBps(uint256) view returns(uint16)',
  'function previewSwap(address,address,uint256) view returns(uint256,uint256)',
  'error ERC20InsufficientAllowance(address spender,uint256 allowance,uint256 needed)']);
const pmAbi = parseAbi(['function verifyingSigner() view returns(address)',
  'function getHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature),uint48,uint48) view returns(bytes32)']);
type Call = { to: Address; data: Hex };
async function landed(hash: Hex) {
  await local.mine({ blocks: 1 });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 30000 });
  assert.equal(receipt.status, 'success'); return receipt;
}
async function fund(token: Address, account: Address, amount: bigint) {
  const holder = T.roles.keeper;
  assert.ok(await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [holder] }) >= amount);
  await local.impersonateAccount({ address: holder });
  await local.setBalance({ address: holder, value: WAD });
  try { await landed(await createWalletClient({ chain: bscTestnet, account: holder, transport }).writeContract({ address: token, abi: erc20Abi, functionName: 'transfer', args: [account, amount] })); }
  finally { await local.stopImpersonatingAccount({ address: holder }); }
}
async function register(label: string, assets: Address[], weights: number[]) {
  const receipt = await landed(await wallet.writeContract({ address: C.registry, abi: REGISTRY_ABI,
    functionName: 'registerStrategy', args: [label, 'local #178 1bp switch acceptance', false] }));
  const events = receipt.logs.flatMap(log => {
    try { const e = decodeEventLog({ abi: REGISTRY_ABI, ...log }); return log.address.toLowerCase() === C.registry && e.eventName === 'StrategyRegistered' ? [e] : []; }
    catch { return []; }
  });
  assert.equal(events.length, 1); const id = events[0]?.args.id; assert.ok(id);
  await landed(await wallet.writeContract({ address: C.registry, abi: REGISTRY_ABI, functionName: 'publishSettingsVersion',
    args: [id, assets, weights, zeroHash, zeroHash, 500, 0n] }));
  assert.equal(await client.readContract({ address: C.registry, abi: REGISTRY_VERSION_ABI, functionName: 'activeVersion', args: [id] }), 1);
  return id;
}
async function setup() {
  assert.equal(await client.getChainId(), 97);
  assert.equal(await local.getAutomine(), true);
  const version: unknown = await client.request({ method: 'web3_clientVersion' });
  assert.ok(typeof version === 'string' && version.toLowerCase().includes('anvil'));
  const fork = await client.getBlock(); console.log('FORK', JSON.stringify({ number: fork.number.toString(), hash: fork.hash, timestamp: fork.timestamp.toString() }));
  await local.setBalance({ address: owner.address, value: 100n * WAD });
  // Pinned VerifyingPaymaster source, compiled in this backend cache, with ONLY public local signer
  // substituted through constructor immutables. Copy into the pinned address so
  // production GasPolicy enforcePaymaster/allowedPaymaster remain unchanged.
  // Registry/executor/oracle/Kernel/policies are neither replaced nor patched.
  const artifact: unknown = JSON.parse(await readFile(new URL('../.bun-cache/issue-178/contracts-cbc671d/out/VerifyingPaymaster.sol/VerifyingPaymaster.json', import.meta.url), 'utf8'));
  assert.ok(artifact && typeof artifact === 'object'); const bytecode: unknown = Reflect.get(artifact, 'bytecode');
  assert.ok(bytecode && typeof bytecode === 'object'); const code: unknown = Reflect.get(bytecode, 'object');
  assert.ok(isHex(code) && /^0x(?:[0-9a-f]{2})+$/i.test(code));
  const deployment = await landed(await wallet.deployContract({ abi: [{ type: 'constructor', inputs: [{ type: 'address' }, { type: 'address' }], stateMutability: 'nonpayable' }], bytecode: code, args: [C.entryPoint, owner.address] }));
  assert.ok(deployment.contractAddress); const localCode = await client.getCode({ address: deployment.contractAddress }); assert.ok(localCode);
  await local.setCode({ address: C.paymaster, bytecode: localCode });
  assert.equal(getAddress(await client.readContract({ address: C.paymaster, abi: pmAbi, functionName: 'verifyingSigner' })), owner.address);
  await landed(await wallet.writeContract({ address: C.entryPoint, abi: entryPoint07Abi, functionName: 'depositTo', args: [C.paymaster], value: 10n * WAD }));
  await refreshP11Markets(client, rpc, [oldAsset, newAsset, retainedAsset]);
  const first = mixChainAllocation([{ assetId: oldAsset, weightBps: 5000 }, { assetId: retainedAsset, weightBps: 5000 }], [], 128);
  const next = mixChainAllocation([{ assetId: newAsset, weightBps: 5000 }, { assetId: retainedAsset, weightBps: 5000 }], [{ assetId: oldAsset, balanceRaw: 100n * WAD }], 128);
  const initial = await register('178 NVDA + WBNB initial', first.assets.map(a => getAddress(a.address)), first.assets.map(a => a.weightBps));
  const replacement = await register('178 TSLA + WBNB + NVDA exit', next.assets.map(a => getAddress(a.address)), next.assets.map(a => a.weightBps));
  const validUntil = Number((await client.getBlock()).timestamp) + 86400;
  const permissions = await buildSessionPermissions({ publicClient: client, sessionKeyAddress: session.address, executorAddress: C.executor, validUntil,
    signer: await toECDSASigner({ signer: session, signerContractAddress: getAddress(C.ecdsaSigner) }) });
  const sudo = await signerToEcdsaValidator(client, { signer: owner, entryPoint, kernelVersion: KERNEL_V3_3, validatorAddress: C.ecdsaValidatorV31 });
  const options = { plugins: { sudo, regular: permissions.permissionValidator }, initConfig: permissions.initConfig };
  const params = await getKernelAccountParams(client, owner.address, computeSalt(owner.address, initial), options);
  await landed(await wallet.sendTransaction({ to: params.factory, data: params.factoryData }));
  const ownerKernel = await createKernelAccount(client, { address: params.address, plugins: { sudo }, entryPoint, kernelVersion: KERNEL_V3_3 });
  const sessionKernel = await createKernelAccount(client, { address: params.address, plugins: options.plugins, entryPoint, kernelVersion: KERNEL_V3_3 });
  assert.equal(permissions.policySnapshot.gas.enforcePaymaster, true);
  assert.equal(permissions.policySnapshot.gas.allowedPaymaster.toLowerCase(), C.paymaster);
  console.log('SESSION', JSON.stringify({ account: params.address, session: session.address, permissionId: permissions.permissionId, validUntil }));
  return { initial, replacement, account: params.address, ownerKernel, sessionKernel };
}
let ctx: Awaited<ReturnType<typeof setup>>;
let switched: { calls: MixOwnerCall[]; hash: Hex };
async function send(calls: Call[], regular = false) {
  const kernel = regular ? ctx.sessionKernel : ctx.ownerKernel;
  assert.equal(kernel.kernelPluginManager.activeValidatorMode, regular ? 'regular' : 'sudo');
  const gasPrice = await client.getGasPrice();
  const operation = { sender: ctx.account, nonce: await kernel.getNonce(), callData: await kernel.encodeCalls(calls),
    callGasLimit: 3000000n, verificationGasLimit: 1500000n, preVerificationGas: 100000n,
    maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice, signature: '0x' as const,
    paymaster: C.paymaster, paymasterVerificationGasLimit: 200000n, paymasterPostOpGasLimit: 0n, paymasterData: '0x' as Hex };
  const until = Number((await client.getBlock()).timestamp) + 300;
  const hash = await client.readContract({ address: C.paymaster, abi: pmAbi, functionName: 'getHash', args: [toPackedUserOperation(operation), until, 0] });
  operation.paymasterData = concatHex([encodeAbiParameters([{ type: 'uint48' }, { type: 'uint48' }], [until, 0]), await owner.signMessage({ message: { raw: hash } })]);
  const packed = toPackedUserOperation({ ...operation, signature: await kernel.signUserOperation(operation) });
  const receipt = await landed(await wallet.writeContract({ address: C.entryPoint, abi: entryPoint07Abi, functionName: 'handleOps', args: [[packed], owner.address], gas: 10000000n }));
  const events = receipt.logs.flatMap(log => {
    try { const e = decodeEventLog({ abi: entryPoint07Abi, ...log }); return log.address.toLowerCase() === C.entryPoint && e.eventName === 'UserOperationEvent' ? [e] : []; }
    catch { return []; }
  });
  assert.equal(events.length, 1); const event = events[0]; assert.ok(event);
  assert.equal(event.args.sender.toLowerCase(), ctx.account.toLowerCase());
  const reasons = receipt.logs.flatMap(log => {
    try { const e = decodeEventLog({ abi: entryPoint07Abi, ...log }); return log.address.toLowerCase() === C.entryPoint && e.eventName === 'UserOperationRevertReason' ? [e.args.revertReason] : []; }
    catch { return []; }
  });
  return { success: event.args.success, hash: receipt.transactionHash, reasons };
}
const approve = (token: Address): Call => ({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [C.executor, maxUint256] }) });
const enroll = (id: bigint): Call => ({ to: C.registry, data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'enroll', args: [ctx.account, id, 1] }) });
async function step(tokenIn: Address, tokenOut: Address, amountIn: bigint) {
  const oracle = await client.readContract({ address: C.executor, abi: EXECUTOR_ABI, functionName: 'oracle' });
  const quote = await client.readContract({ address: oracle, abi: extra, functionName: 'previewSwap', args: [tokenIn, tokenOut, amountIn] });
  const fee = await client.readContract({ address: C.registry, abi: extra, functionName: 'effectiveFeeBps', args: [ctx.replacement] });
  const asset = tokenIn === C.usdt ? tokenOut : tokenIn;
  const profile = Object.values(T.assets).find(a => a.token === asset); assert.ok(profile);
  return buildStep({ chainId: 97, executor: C.executor, tokenIn, tokenOut, amountIn, poolFee: profile.poolFee, oracleFloor: quote[1], minGross: minGrossFor(quote[1], fee) });
}
async function execute(steps: Awaited<ReturnType<typeof step>>[]) {
  const data = encodeFunctionData({ abi: EXECUTOR_ABI, functionName: 'executeRebalance', args: [ctx.account, steps, (await client.getBlock()).timestamp + 600n] });
  return send([{ to: C.executor, data }], true);
}
async function balance(token: Address) { return client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [ctx.account] }); }
before(async () => {
  ctx = await setup();
  // Existing, functioning NVDA portfolio has approvals for its initial assets.
  assert.equal((await send([enroll(ctx.initial), approve(C.usdt), approve(oldAsset), approve(retainedAsset)])).success, true);
  await fund(C.usdt, ctx.account, 1000n * WAD); await fund(oldAsset, ctx.account, WAD); await fund(retainedAsset, ctx.account, WAD);
  assert.equal(await client.readContract({ address: newAsset, abi: erc20Abi, functionName: 'allowance', args: [ctx.account, C.executor] }), 0n);
  // Latest C3 contract: only the new asset's approval plus enroll, signed once.
  const calls = mixOwnerCalls({ account: ctx.account, registry: C.registry, executor: C.executor, onchainId: ctx.replacement, previousAssets: [C.usdt, oldAsset, retainedAsset], assets: [C.usdt, newAsset, oldAsset, retainedAsset], allowances: new Map([[newAsset, 0n]]) });
  assert.equal(calls.length, 2);
  const switchResult = await send(calls.map(({ to, data }) => ({ to, data })));
  assert.equal(switchResult.success, true);
  switched = { calls, hash: switchResult.hash };
  assert.equal(await client.readContract({ address: newAsset, abi: erc20Abi, functionName: 'allowance', args: [ctx.account, C.executor] }), maxUint256);
  assert.deepEqual(await client.readContract({ address: C.registry, abi: REGISTRY_ABI, functionName: 'enrollments', args: [ctx.account] }), [ctx.replacement, 1, false]);
});
test('#178 production confirmation verifies exact persisted calls, sudo nonce and canonical enrollment receipt', async () => {
  const intent = { strategy_id: '1', owner_calls: switched.calls, user_op_hash: null };
  const deps = { chain: { publicClient: client, registryAddress: C.registry, chainId: 97 }, onchainId: async () => ctx.replacement.toString() };
  const proof = await readMixEnrollmentProof({ account: ctx.account.toLowerCase() as Address }, intent, switched.hash, deps);
  assert.equal(proof.txHash, switched.hash);
  assert.equal(proof.cashRaw, (await balance(C.usdt)).toString());
  const pending = { ...intent, nonce: proof.nonce.toString(), enroll_from_block: (proof.blockNumber - 1n).toString() };
  const recovered = await findMixEnrollment({ account: ctx.account.toLowerCase() as Address }, pending, deps);
  assert.equal(recovered.kind, 'confirmed');
  if (recovered.kind === 'confirmed') assert.equal(recovered.proof.txHash, switched.hash, 'server discovers Enrolled without an App txHash');
  await assert.rejects(findMixEnrollment({ account: ctx.account.toLowerCase() as Address }, { ...pending, nonce: (proof.nonce + 1n).toString() }, deps));
  let afterCash = false;
  const moving = createPublicClient({ chain: bscTestnet, transport: custom({ request: async request => {
    const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 178, ...request }) });
    const result: unknown = await response.json();
    assert.ok(result && typeof result === 'object' && 'result' in result);
    if (request.method === 'eth_call' && JSON.stringify(request.params).includes(encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [ctx.account] }).slice(0, 10))) afterCash = true;
    if (afterCash && request.method === 'eth_getBlockByNumber') {
      assert.ok(result.result && typeof result.result === 'object'); return { ...result.result, hash: zeroHash };
    }
    return result.result;
  } }, { retryCount: 0 }), cacheTime: 0 });
  await assert.rejects(readMixEnrollmentProof({ account: ctx.account.toLowerCase() as Address }, intent, switched.hash,
    { ...deps, chain: { ...deps.chain, publicClient: moving } }));
  await assert.rejects(readMixEnrollmentProof({ account: ctx.account.toLowerCase() as Address }, { ...intent, owner_calls: switched.calls.slice(-1) }, switched.hash, deps));
  await assert.rejects(readMixEnrollmentProof({ account: ctx.account.toLowerCase() as Address }, intent, switched.hash, { ...deps, onchainId: async () => ctx.initial.toString() }));
});
test('#178 switched session key can sell the old 1bp exit component', async () => {
  const before = await balance(oldAsset);
  const result = await execute([await step(oldAsset, C.usdt, before * 9998n / 10000n)]);
  console.log('EXIT_SALE', JSON.stringify(result)); assert.equal(result.success, true);
  assert.ok(await balance(oldAsset) < before); assert.ok(await balance(oldAsset) > 0n);
});
test('#178 unchanged session key can rebalance into the newly selected asset', async () => {
  assert.equal(await balance(newAsset), 0n);
  const result = await execute([await step(C.usdt, newAsset, 100n * WAD)]);
  console.log('NEW_BUY', JSON.stringify(result)); assert.equal(result.success, true);
  assert.ok(await balance(newAsset) > 0n);
});
test('#178 required stop-loss can sell every holding including new and exit assets after atomic approval + enroll', async () => {
  const old = await balance(oldAsset), next = await balance(newAsset); assert.ok(old > 0n && next > 0n);
  const result = await execute([await step(oldAsset, C.usdt, old), await step(newAsset, C.usdt, next), await step(retainedAsset, C.usdt, await balance(retainedAsset))]);
  console.log('STOP_LOSS', JSON.stringify(result));
  if (!result.success) {
    assert.equal(await balance(oldAsset), old, 'whole batch rolled back'); assert.equal(await balance(newAsset), next);
    assert.equal(result.reasons.length, 1); const reason = result.reasons[0]; assert.ok(reason);
    console.log('STOP_LOSS_ERROR', JSON.stringify(decodeErrorResult({ abi: extra, data: reason }), (_, v: unknown) => typeof v === 'bigint' ? v.toString() : v));
  }
  assert.equal(result.success, true, 'atomic approval must authorize newly selected assets for liquidation');
  assert.equal(await balance(oldAsset), 0n); assert.equal(await balance(newAsset), 0n); assert.equal(await balance(retainedAsset), 0n);
});
test('#178 ratio-only switch emits no approvals and preserves the account and session key', async () => {
  assert.equal(await balance(oldAsset), 0n);
  const next = mixChainAllocation([{ assetId: newAsset, weightBps: 7000 }, { assetId: retainedAsset, weightBps: 3000 }], [], 128);
  const ratioId = await register('178 ratio only', next.assets.map(a => getAddress(a.address)), next.assets.map(a => a.weightBps));
  const previousAssets = [C.usdt, newAsset, oldAsset, retainedAsset];
  const assets = next.assets.map(asset => getAddress(asset.address));
  const calls = mixOwnerCalls({ account: ctx.account, registry: C.registry, executor: C.executor, onchainId: ratioId, previousAssets, assets, allowances: new Map() });
  assert.equal(calls.length, 1);
  const switchResult = await send(calls.map(({ to, data }) => ({ to, data })));
  assert.equal(switchResult.success, true);
  switched = { calls, hash: switchResult.hash };
  assert.deepEqual(await client.readContract({ address: C.registry, abi: REGISTRY_ABI, functionName: 'enrollments', args: [ctx.account] }), [ratioId, 1, false]);
  ctx.replacement = ratioId;
  const bought = await execute([await step(C.usdt, newAsset, 100n * WAD)]);
  assert.equal(bought.success, true);
  const sold = await execute([await step(newAsset, C.usdt, await balance(newAsset))]);
  assert.equal(sold.success, true);
  assert.equal(await balance(newAsset), 0n);
  console.log('RATIO_ONLY', JSON.stringify({ bought, sold }));
});

test('durable registration resumes a committed pre-broadcast interruption on the local fork without another strategy or version', async () => {
  const { mixDbSandbox } = await import('./fixtures/mix-db.js');
  const { query, withTransaction, closePool } = await import('../src/db.js');
  const { mixSettings } = await import('../src/mix-domain.js');
  const { registerMixStrategy } = await import('../src/mix-chain.js');
  const { withRelayerLock } = await import('../src/relayer-lock.js');
  const { kernelAddressesForChain } = await import('../src/addresses.js');
  try {
    await mixDbSandbox(async lane => lane(async () => {
      const input = mixSettings({ name: 'Local recovery', assets: [{ assetId: oldAsset, weightBps: 10000 }] });
      const row = (await query<{ id: string }>(`insert into mix_creation_requests(owner,chain_id,request_key,request_hash,settings)
        values($1,97,'fork-recovery',$2,$3) returning id`, [owner.address.toLowerCase(), zeroHash, JSON.stringify(input)])).rows[0]; assert.ok(row);
      const allocation = { assets: mixChainAllocation(input.assets, [], 128).assets };
      const chain = { chainId: 97, rpcUrl: rpc, registryAddress: C.registry, account: owner, wallet, publicClient: client, kernel: kernelAddressesForChain(97) };
      await assert.rejects(registerMixStrategy(owner.address.toLowerCase() as Address, input.name, allocation, row.id, { chain,
        transaction: async work => { await withTransaction(work); throw new Error('local interrupted commit response'); } }), /目前無法確認/);
      const saved = (await query<{ registration_tx_hash: Hex; state: string }>('select registration_tx_hash,state from mix_creation_requests where id=$1', [row.id])).rows[0]; assert.ok(saved);
      assert.equal(saved.state, 'submitted');
      await assert.rejects(withRelayerLock(97, async () => assert.fail('fresh nonce')), { code: 'RELAYER_BUSY' });
      // The first retry can replay the saved bytes; no replacement is prepared.
      await assert.rejects(registerMixStrategy(owner.address.toLowerCase() as Address, input.name, allocation, row.id, { chain }), /目前無法確認/);
      await local.mine({ blocks: 1 });
      const id = await registerMixStrategy(owner.address.toLowerCase() as Address, input.name, allocation, row.id, { chain });
      assert.equal(await registerMixStrategy(owner.address.toLowerCase() as Address, input.name, allocation, row.id, { chain }), id);
      const confirmed = (await query<{ registration_tx_hash: Hex; onchain_strategy_id: string }>('select registration_tx_hash,onchain_strategy_id from mix_creation_requests where id=$1', [row.id])).rows[0]; assert.ok(confirmed);
      assert.equal(confirmed.registration_tx_hash, saved.registration_tx_hash);
      const receipt = await client.getTransactionReceipt({ hash: saved.registration_tx_hash }); assert.equal(receipt.status, 'success');
      assert.equal(await client.readContract({ address: C.registry, abi: REGISTRY_VERSION_ABI, functionName: 'versionCount', args: [BigInt(confirmed.onchain_strategy_id)] }), 1n);
      assert.equal((await query('select id from strategies')).rows.length, 1);
      assert.equal((await query('select version from strategy_versions')).rows.length, 1);
      assert.equal((await query('select request_id from mix_registration_outbox')).rows.length, 1);
      console.log('REGISTRATION_RECOVERY', JSON.stringify({ strategyId: confirmed.onchain_strategy_id, version: 1, txHash: saved.registration_tx_hash }));
    }));
  } finally { await closePool(); }
});

test('publication outbox interruption fills its nonce gap before a real faucet and both recover on the local fork', async () => {
  const { mixDbSandbox } = await import('./fixtures/mix-db.js');
  const { query, withTransaction, closePool } = await import('../src/db.js');
  const { publishMixStrategy, reconcileMixPublication } = await import('../src/mix-publication.js');
  const { relayerNonce, withRelayerLock } = await import('../src/relayer-lock.js');
  const { reconcileRelayerTransactions } = await import('../src/relayer-reconciliation.js');
  const { createFaucetService, settleFaucetClaim } = await import('../src/faucet.js');
  const { validateAssetConfig } = await import('../src/strategy-execution.js');
  const { kernelAddressesForChain } = await import('../src/addresses.js');
  const faucetAbi = parseAbi(['function owner() view returns(address)', 'function isFaucet(address) view returns(bool)',
    'function setFaucet(address,bool)', 'function claimFor(address,uint256)']);
  const admin = await client.readContract({ address: C.usdt, abi: faucetAbi, functionName: 'owner' });
  const allowed = await client.readContract({ address: C.usdt, abi: faucetAbi, functionName: 'isFaucet', args: [owner.address] });
  async function permit(value: boolean) {
    await local.impersonateAccount({ address: admin }); await local.setBalance({ address: admin, value: 10n * WAD });
    try { await landed(await createWalletClient({ chain: bscTestnet, account: admin, transport }).writeContract({
      address: C.usdt, abi: faucetAbi, functionName: 'setFaucet', args: [owner.address, value] })); }
    finally { await local.stopImpersonatingAccount({ address: admin }); }
  }
  try {
    if (!allowed) await permit(true);
    await mixDbSandbox(async lane => lane(async () => {
      const registered = await landed(await wallet.writeContract({ address: C.registry, abi: REGISTRY_ABI,
        functionName: 'registerStrategy', args: ['CRE8 mix', 'My mix', false] }));
      const event = registered.logs.flatMap(log => {
        try { const e = decodeEventLog({ abi: REGISTRY_ABI, ...log }); return e.eventName === 'StrategyRegistered' ? [e] : []; }
        catch { return []; }
      })[0]; assert.ok(event);
      const source = (await query<{ id: string }>(`insert into strategies(provider,name,is_public,is_personal_mix,onchain_id)
        values($1,'fork publication',false,true,$2) returning id`, [owner.address.toLowerCase(), event.args.id.toString()])).rows[0]; assert.ok(source);
      const allocation = { assets: mixChainAllocation([{ assetId: oldAsset, weightBps: 10000 }], [], 128).assets };
      const execution = validateAssetConfig(undefined, allocation, 97);
      const chain = { chainId: 97, rpcUrl: rpc, registryAddress: C.registry, account: owner, wallet, publicClient: client, kernel: kernelAddressesForChain(97) };
      const deps = { chain, client, operator: owner.address, query, transaction: withTransaction };
      let interrupted = false;
      await assert.rejects(publishMixStrategy(source.id, Number(event.args.id), undefined, allocation, execution, { ...deps,
        transaction: async work => {
          const value = await withTransaction(work);
          if (!interrupted) { interrupted = true; throw new Error('local publication response lost after COMMIT'); }
          return value;
        } }), /目前無法確認/);
      const saved = (await query<{ nonce: string; tx_hash: Hex }>('select nonce::text,tx_hash from mix_publication_outbox where strategy_id=$1', [source.id])).rows[0]; assert.ok(saved);
      assert.equal(await client.readContract({ address: C.registry, abi: REGISTRY_VERSION_ABI, functionName: 'versionCount', args: [event.args.id] }), 0n);
      const before = await client.readContract({ address: C.usdt, abi: erc20Abi, functionName: 'balanceOf', args: [ctx.account] });
      let faucetHash: Hex | null = null;
      const faucet = createFaucetService({ config: { chainId: 97, amountWei: WAD, siteDailyWei: 10n ** 30n, timeoutMs: 5000 },
        query: async () => ({ rows: [{ owner: owner.address.toLowerCase(), user_id: owner.address.toLowerCase() }] }),
        settle: (claim, from, state, hash, transaction, signed) => settleFaucetClaim(claim, from, state, hash, transaction,
          signed ? { ...signed, operator: owner.address } : undefined),
        prepare: async claim => {
          const selected = await relayerNonce(client, owner.address); assert.equal(selected.nonce, Number(saved.nonce) + 1);
          const request = await wallet.prepareTransactionRequest({ to: C.usdt, value: 0n, gas: 300000n, ...selected,
            data: encodeFunctionData({ abi: faucetAbi, functionName: 'claimFor', args: [claim.account, claim.amountWei] }) });
          const raw = await wallet.signTransaction(request), hash = (await import('viem')).keccak256(raw); faucetHash = hash;
          return { hash, raw, broadcast: async () => { assert.equal(await client.sendRawTransaction({ serializedTransaction: raw }), hash); },
            receipt: async () => 'unknown' };
        } });
      const claimed = await faucet.claim({ account: ctx.account }, owner.address.toLowerCase());
      assert.equal(claimed.state, 'unknown', 'queued faucet retains its quota until the original missing nonce is replayed');
      const recovered = await reconcileMixPublication(source.id, deps, true);
      assert.ok(recovered === 'replayed' || recovered === 'confirmed');
      await local.mine({ blocks: 1 });
      assert.equal(await reconcileMixPublication(source.id, deps, true), 'confirmed');
      assert.ok(faucetHash);
      const minted = await client.getTransactionReceipt({ hash: faucetHash }); assert.equal(minted.status, 'success');
      assert.equal(await client.readContract({ address: C.usdt, abi: erc20Abi, functionName: 'balanceOf', args: [ctx.account] }), before + WAD);
      assert.equal((await reconcileRelayerTransactions({ chain, client, operator: owner.address, replay: true })).confirmed, 1);
      assert.equal((await query('select state from faucet_claims')).rows[0]?.state, 'confirmed');
      assert.equal((await query('select version from strategy_versions')).rows.length, 1);
      assert.equal((await query('select attempt from mix_publication_outbox')).rows.length, 1);
      await withRelayerLock(97, async held => held());
      console.log('PUBLICATION_FAUCET_RECOVERY', JSON.stringify({ strategyId: event.args.id.toString(), publicationNonce: saved.nonce, faucetNonce: Number(saved.nonce) + 1, mintedRaw: WAD.toString() }));
    }));
  } finally { if (!allowed) await permit(false); await closePool(); }
});
