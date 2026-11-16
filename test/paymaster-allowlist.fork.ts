import { localAcceptanceEnv } from './fixtures/local-acceptance.js';
/** Explicit local-only acceptance: real Kernel v3.3 + EntryPoint v0.7 on a chain 97 fork.
 * Source artifacts must come from `git archive origin/main` of cre8-contracts, then forge build.
 * Extract into .bun-cache/issue-71-contracts and build src/testnet/TestnetToken.sol plus
 * src/testnet/aa/samples/VerifyingPaymaster.sol. Select isolated localhost ports and TEST_DATABASE_NAME via localAcceptanceEnv,
 * migrate that disposable DB, set CHAIN_ID=97, then run bun test ./test/paymaster-allowlist.fork.ts --timeout=120000.
 * Uses only the public Anvil test key. No bundler or public-chain writes.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { createKernelAccount, KernelV3_3AccountAbi } from '@zerodev/sdk';
import { KERNEL_V3_3 } from '@zerodev/sdk/constants';
import { concatHex, createPublicClient, createTestClient, createWalletClient, decodeEventLog, encodeAbiParameters, encodeFunctionData,
  erc20Abi, http, keccak256, parseAbi, toHex } from 'viem';
import type { Abi, Address, Hex } from 'viem';
import { bscTestnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { entryPoint07Abi, toPackedUserOperation } from 'viem/account-abstraction';
import { closePool, query } from '../src/db.js';
import { createPaymasterService } from '../src/paymaster.js';
import { buildSessionPermissions } from '../src/permissions.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
import { TEST_SIGNER, config } from './fixtures/paymaster.js';

after(closePool);
const rpcUrl = localAcceptanceEnv(process.env).rpcUrl;
const client = createPublicClient({ chain: bscTestnet, transport: http(rpcUrl, { retryCount: 0 }) });
const local = createTestClient({ chain: bscTestnet, mode: 'anvil', transport: http(rpcUrl) });
const owner = privateKeyToAccount(TEST_SIGNER);
const wallet = createWalletClient({ account: owner, chain: bscTestnet, transport: http(rpcUrl) });
const C = T.contracts;

async function deploy(name: string, source: string, args: readonly unknown[] = []): Promise<Address> {
  const artifact: unknown = JSON.parse(await readFile(`${process.env.CONTRACT_ARTIFACTS_DIR ?? '.bun-cache/issue-71-contracts/out'}/${source}.sol/${name}.json`, 'utf8'));
  assert.ok(typeof artifact === 'object' && artifact !== null && 'abi' in artifact && Array.isArray(artifact.abi) &&
    'bytecode' in artifact && typeof artifact.bytecode === 'object' && artifact.bytecode !== null && 'object' in artifact.bytecode);
  const code = artifact.bytecode.object;
  assert.ok(typeof code === 'string' && /^0x[0-9a-fA-F]+$/.test(code));
  const tx = await wallet.deployContract({ abi: artifact.abi as Abi, bytecode: code as Hex, args });
  const receipt = await client.waitForTransactionReceipt({ hash: tx });
  assert.equal(receipt.status, 'success');
  assert.ok(receipt.contractAddress);
  return receipt.contractAddress;
}
async function copyRuntime(from: Address, to: Address) {
  const code = await client.getCode({ address: from });
  assert.ok(code && code !== '0x');
  await local.setCode({ address: to, bytecode: code });
}

test('#71 local 97 fork: real Kernel approve, transfer and renewal consume paymaster deposit, with zero account BNB', async () => {
  assert.equal(await local.getAutomine(), true, 'must be our local Anvil');
  assert.equal(await client.getChainId(), 97);
  const snapshot = await local.snapshot();
  const hashes: Hex[] = [];
  let strategyId: string | undefined;
  try {
    // GasPolicy is absent on public chain 97. Deploy the exact pinned upstream init code from the clean
    // archive, as DeployTestnet does, using only the local Anvil fixture owner.
    if (((await client.getCode({ address: C.gasPolicy })) ?? '0x') === '0x') {
      const source = await readFile(new URL('../.bun-cache/issue-71-contracts/script/testnet/GasPolicyInitCode.sol', import.meta.url), 'utf8');
      const code = source.match(/INIT_CODE\s*=\s*hex"([0-9a-fA-F]+)"/)?.[1];
      assert.ok(code);
      const initCode: Hex = `0x${code}`;
      assert.equal(keccak256(initCode), '0x45a4db461253bdfb274cbb1360677468034763514ed0377cefca0e78a97ee12c');
      const tx = await wallet.sendTransaction({ to: '0x4e59b44847b379578588920cA78FbF26c0B4956C', data: concatHex([toHex(0n, { size: 32 }), initCode]) });
      assert.equal((await client.waitForTransactionReceipt({ hash: tx })).status, 'success');
      assert.ok(await client.getCode({ address: C.gasPolicy }));
    }
    await copyRuntime(await deploy('VerifyingPaymaster', 'VerifyingPaymaster', [C.entryPoint, owner.address]), C.paymaster);
    const deposit = await wallet.writeContract({ address: C.entryPoint, abi: entryPoint07Abi, functionName: 'depositTo', args: [C.paymaster], value: 10n ** 17n });
    assert.equal((await client.waitForTransactionReceipt({ hash: deposit })).status, 'success');
    const entryPoint = { address: C.entryPoint, version: '0.7' } as const;
    const sudo = await signerToEcdsaValidator(client, { signer: owner, entryPoint, kernelVersion: KERNEL_V3_3, validatorAddress: C.ecdsaValidatorV31 });
    const account = await createKernelAccount(client, { plugins: { sudo }, entryPoint, kernelVersion: KERNEL_V3_3,
      index: 710071n, factoryAddress: C.kernelFactoryV33, metaFactoryAddress: C.kernelMetaFactory, accountImplementationAddress: C.kernelImplV33 });
    const factory = await account.getFactoryArgs();
    assert.ok(factory.factory && factory.factoryData);
    const deployment = await wallet.sendTransaction({ to: factory.factory, data: factory.factoryData });
    assert.equal((await client.waitForTransactionReceipt({ hash: deployment })).status, 'success');

    const token = T.assets.WBNB.token;
    const tokenRuntime = await deploy('TestnetToken', 'TestnetToken', ['Local asset', 'LOCAL', 18, owner.address]);
    // Clean archive TestnetToken storage layout: balances slot 0, owner slot 5, minters slot 6.
    // Appoint the public fixture owner locally, then mint through the real token implementation.
    for (const address of [token, C.usdt]) {
      await copyRuntime(tokenRuntime, address);
      await local.setStorageAt({ address, index: toHex(5n, { size: 32 }), value: encodeAbiParameters([{ type: 'address' }], [owner.address]) });
      await local.setStorageAt({ address, index: keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [owner.address, 6n])), value: toHex(1n, { size: 32 }) });
      const mint = await wallet.writeContract({ address, abi: parseAbi(['function mint(address to,uint256 amount)']), functionName: 'mint', args: [account.address, 100n] });
      assert.equal((await client.waitForTransactionReceipt({ hash: mint })).status, 'success');
    }
    const balance = (address: Address, holder: Address) => client.readContract({ address, abi: erc20Abi, functionName: 'balanceOf', args: [holder] });
    const ownerTokenBefore = await balance(token, owner.address);
    const ownerUsdtBefore = await balance(C.usdt, owner.address);
    const accountTokenBefore = await balance(token, account.address);
    const accountUsdtBefore = await balance(C.usdt, account.address);

    const ownerId = owner.address.toLowerCase();
    strategyId = (await query<{ id: string }>("insert into strategies(provider,name) values($1,'paymaster-71-local') returning id", [ownerId])).rows[0]?.id;
    assert.ok(strategyId);
    await query("insert into strategy_versions(strategy_id,version,allocation,schedule) values($1,1,$2::jsonb,'{}'::jsonb)", [strategyId, JSON.stringify({ assets: [{ address: token, weightBps: 10000 }] })]);
    const portfolio = (await query<{ id: string }>("insert into portfolios(user_id,strategy_id,version,schedule_state) values($1,$2,1,'idle') returning id", [ownerId, strategyId])).rows[0]?.id;
    assert.ok(portfolio);
    await query("insert into smart_accounts(portfolio_id,chain_id,address,owner,account_type) values($1,97,$2,$3,'KERNEL')", [portfolio, account.address.toLowerCase(), ownerId]);
    const sponsor = createPaymasterService({ config: config({ CHAIN_ID: '97', RPC_URL: rpcUrl, PAYMASTER_SIGNER_PRIVATE_KEY: TEST_SIGNER,
      PAYMASTER_ACCOUNT_DAILY_GAS: '30000000', PAYMASTER_ACCOUNT_DAILY_WEI: String(10n ** 17n), PAYMASTER_SITE_DAILY_WEI: String(10n ** 18n) }) });
    async function send(calls: readonly { to: Address; data: Hex; value: bigint }[]) {
      const beforeDeposit = await client.readContract({ address: C.entryPoint, abi: entryPoint07Abi, functionName: 'balanceOf', args: [C.paymaster] });
      const quotedGasPrice = await client.getGasPrice();
      const gasPrice = quotedGasPrice > 0n ? quotedGasPrice : 1n;
      const prepared = { sender: account.address, nonce: await account.getNonce(), callData: await account.encodeCalls(calls),
        verificationGasLimit: 1_500_000n, callGasLimit: 2_000_000n, preVerificationGas: 100_000n,
        maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice, signature: '0x' as const };
      const authorization = await sponsor.sponsor({ userOperation: toPackedUserOperation(prepared) }, ownerId);
      hashes.push(authorization.userOpHash);
      const sponsored = { ...prepared, paymaster: authorization.paymaster, paymasterData: authorization.paymasterData,
        paymasterVerificationGasLimit: authorization.paymasterVerificationGasLimit, paymasterPostOpGasLimit: authorization.paymasterPostOpGasLimit };
      const packed = toPackedUserOperation({ ...sponsored, signature: await account.signUserOperation(sponsored) });
      const tx = await wallet.writeContract({ address: C.entryPoint, abi: entryPoint07Abi, functionName: 'handleOps', args: [[packed], owner.address], gas: 5_000_000n });
      const receipt = await client.waitForTransactionReceipt({ hash: tx });
      assert.equal(receipt.status, 'success');
      const events = receipt.logs.flatMap((log) => {
        try { const decoded = decodeEventLog({ abi: entryPoint07Abi, data: log.data, topics: log.topics });
          return decoded.eventName === 'UserOperationEvent' ? [decoded.args] : []; } catch { return []; }
      });
      assert.equal(events.length, 1);
      assert.equal(events[0]?.success, true);
      assert.equal(events[0]?.userOpHash, authorization.userOpHash);
      assert.equal(events[0]?.paymaster.toLowerCase(), C.paymaster);
      assert.ok((events[0]?.actualGasCost ?? 0n) > 0n);
      assert.equal(await client.getBalance({ address: account.address }), 0n);
      assert.ok(await client.readContract({ address: C.entryPoint, abi: entryPoint07Abi, functionName: 'balanceOf', args: [C.paymaster] }) < beforeDeposit);
    }
    await send([{ to: token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [C.executor, (1n << 256n) - 1n] }) }]);
    assert.equal(await client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [account.address, C.executor] }), (1n << 256n) - 1n);
    await send([{ to: token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [owner.address, 7n] }) }]);
    assert.equal(await balance(token, owner.address), ownerTokenBefore + 7n);
    await send([
      { to: token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [owner.address, 11n] }) },
      { to: C.usdt, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [owner.address, 13n] }) },
    ]);
    assert.equal(await balance(token, owner.address), ownerTokenBefore + 18n);
    assert.equal(await balance(C.usdt, owner.address), ownerUsdtBefore + 13n);
    assert.equal(await balance(token, account.address), accountTokenBefore - 18n);
    assert.equal(await balance(C.usdt, account.address), accountUsdtBefore - 13n);
    const session = await buildSessionPermissions({ publicClient: client, sessionKeyAddress: owner.address, executorAddress: C.executor });
    await send(session.initConfig.map((data) => ({ to: account.address, value: 0n, data })));
    const installed = await client.readContract({ address: account.address,
      abi: KernelV3_3AccountAbi, functionName: 'permissionConfig', args: [session.permissionId] });
    assert.equal(installed.signer.toLowerCase(), C.ecdsaSigner);
    console.log('#71 local 97 fork: approve, single/batch transfer, renewal sponsored; account BNB remained 0');
  } finally {
    await query('delete from paymaster_sponsorships where user_op_hash = any($1::text[])', [hashes]);
    if (strategyId) {
      await query('delete from portfolios where strategy_id=$1', [strategyId]);
      await query('delete from strategies where id=$1', [strategyId]);
    }
    await local.revert({ id: snapshot });
  }
});
