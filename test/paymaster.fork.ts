import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { createPublicClient, createTestClient, createWalletClient, defineChain, encodeAbiParameters, http, parseAbi, slice, toHex } from 'viem';
import type { Abi, Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { entryPoint07Abi } from 'viem/account-abstraction';
import { closePool, query } from '../src/db.js';
import { createPaymasterService, gasExecutionKey, settleGasBudget, verifyingPaymasterHash } from '../src/paymaster.js';
import { KERNEL_V3_3_ADDRESSES as K } from '../src/addresses.js';
import { TEST_SIGNER, OWNER, PM, USDT, SENDER, REGISTRY, kernelCall, operation, config } from './fixtures/paymaster.js';
import golden from './fixtures/paymaster-golden.json' with { type: 'json' };

after(closePool);
const rpcUrl = process.env.ANVIL_RPC_URL;
assert.ok(rpcUrl, 'set ANVIL_RPC_URL to the assigned local anvil');
const rpcLocation = new URL(rpcUrl);
assert.ok(['localhost', '127.0.0.1'].includes(rpcLocation.hostname));
const chain = defineChain({ id: 1337, name: 'paymaster local anvil', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 0 }) });
const local = createTestClient({ chain, mode: 'anvil', transport: http(rpcUrl) });
const signer = privateKeyToAccount(TEST_SIGNER);
const wallet = createWalletClient({ account: signer, chain, transport: http(rpcUrl) });
const pmAbi = parseAbi([
  'function getHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp,uint48 validUntil,uint48 validAfter) view returns(bytes32)',
  'function validatePaymasterUserOp((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp,bytes32 userOpHash,uint256 maxCost) returns(bytes,uint256)',
]);
async function deploy(name: string, abi: Abi, args: readonly unknown[] = [], source = name): Promise<Address> {
  const artifact: unknown = JSON.parse(await readFile(new URL(`../.bun-cache/paymaster-aa/out/${source}.sol/${name}.json`, import.meta.url), 'utf8'));
  assert.ok(typeof artifact === 'object' && artifact !== null && 'bytecode' in artifact && typeof artifact.bytecode === 'object' && artifact.bytecode !== null && 'object' in artifact.bytecode);
  const bytecode = artifact.bytecode.object;
  assert.ok(typeof bytecode === 'string' && /^0x[0-9a-fA-F]+$/.test(bytecode));
  const hash = await wallet.deployContract({ abi, bytecode: bytecode as Hex, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success');
  assert.ok(receipt.contractAddress);
  return receipt.contractAddress;
}
async function copyCode(from: Address, to: Address) {
  const code = await publicClient.getCode({ address: from });
  assert.ok(code && code !== '0x');
  await local.setCode({ address: to, bytecode: code });
}

test('#66 actual v0.7 EntryPoint + VerifyingPaymaster accept golden and handleOps; modified gas/expiry rejected, sender spends no gas', async () => {
  assert.equal(await publicClient.getChainId(), 1337);
  const snapshot = await local.snapshot();
  let strategyId: string | undefined;
  const hashes: Hex[] = [];
  const budgetKeys: string[] = [];
  try {
    const ep = await deploy('EntryPoint', []);
    await copyCode(ep, K.entryPointV07);
    const constructor = [{ type: 'constructor', inputs: [{ name: 'ep', type: 'address' }, { name: 'signer', type: 'address' }], stateMutability: 'nonpayable' }] as const;
    const pm = await deploy('VerifyingPaymaster', constructor, [K.entryPointV07, signer.address]);
    await copyCode(pm, PM);
    const account = await deploy('PaymasterAccount', constructor, [K.entryPointV07, signer.address]);
    await copyCode(account, SENDER);
    // Only the harness uses this storage stand-in. Production code never writes account storage.
    await local.setStorageAt({ address: SENDER, index: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', value: encodeAbiParameters([{ type: 'address' }], [K.kernelImplV33]) });
    await copyCode(await deploy('PaymasterClaimTarget', [], [], 'PaymasterAccount'), REGISTRY);
    const depositTx = await wallet.writeContract({ address: K.entryPointV07, abi: entryPoint07Abi, functionName: 'depositTo', args: [PM], value: 10n ** 16n });
    await publicClient.waitForTransactionReceipt({ hash: depositTx });
    strategyId = (await query<{ id: string }>("insert into strategies(provider,name) values($1,'paymaster-66-local') returning id", [OWNER])).rows[0]?.id;
    assert.ok(strategyId);
    await query("insert into strategy_versions(strategy_id,version,allocation,schedule) values($1,1,$2::jsonb,'{}'::jsonb)", [strategyId, JSON.stringify({ assets: [{ address: USDT, weightBps: 10000 }] })]);
    const portfolio = (await query<{ id: string }>("insert into portfolios(user_id,strategy_id,version,schedule_state) values($1,$2,1,'idle') returning id", [OWNER, strategyId])).rows[0]?.id;
    assert.ok(portfolio);
    await query("insert into smart_accounts(portfolio_id,chain_id,address,owner,account_type) values($1,1337,$2,$3,'KERNEL')", [portfolio, SENDER, OWNER]);
    const now = Math.floor(Date.now() / 1000);
    const validUntil = now + 300;
    const service = createPaymasterService({ config: { ...config(), rpcUrl }, now: () => now,
      readBudgetContext: async op => ({ purpose: op.nonce === 0n ? 'setup' : 'ordinary', nativePrice: 60000000000n, priceSource: 'fixture:oracle' }) });
    const sponsored = await service.sponsor({ userOperation: operation(), validUntil }, OWNER);
    hashes.push(sponsored.userOpHash);
    budgetKeys.push(gasExecutionKey(1337, operation()));
    const op = { ...operation(), paymasterAndData: sponsored.paymasterAndData };
    const onchainHash = await publicClient.readContract({ address: PM, abi: pmAbi, functionName: 'getHash', args: [op, sponsored.validUntil, 0] });
    assert.equal(onchainHash, verifyingPaymasterHash(op, config(), validUntil, 0));
    // Hash-vector timestamps stay fixed; the issued DB reservation uses the real current clock.
    const goldenHash = await publicClient.readContract({ address: PM, abi: pmAbi, functionName: 'getHash', args: [{ ...op, callData: kernelCall() }, golden.validUntil, golden.validAfter] });
    assert.equal(goldenHash, golden.hash);
    assert.equal(await signer.signMessage({ message: { raw: goldenHash } }), golden.signature);
    const actualHash = await publicClient.readContract({ address: K.entryPointV07, abi: entryPoint07Abi, functionName: 'getUserOpHash', args: [op] });
    assert.equal(actualHash, sponsored.userOpHash);
    const badHeader = { ...op, paymasterAndData: `${slice(op.paymasterAndData, 0, 20)}${toHex(100_001n, { size: 16 }).slice(2)}${slice(op.paymasterAndData, 36).slice(2)}` as Hex };
    const invalid = await publicClient.simulateContract({ account: K.entryPointV07, address: PM, abi: pmAbi, functionName: 'validatePaymasterUserOp', args: [badHeader, actualHash, 1n] });
    assert.equal(invalid.result[1] & ((1n << 160n) - 1n), 1n);
    const before = await publicClient.getBalance({ address: SENDER });
    const balanceBefore = await publicClient.readContract({ address: K.entryPointV07, abi: entryPoint07Abi, functionName: 'balanceOf', args: [PM] });
    op.signature = await signer.signMessage({ message: { raw: actualHash } });
    const tx = await wallet.writeContract({ address: K.entryPointV07, abi: entryPoint07Abi, functionName: 'handleOps', args: [[op], signer.address], gas: 2_000_000n });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
    assert.equal(receipt.status, 'success');
    assert.equal(await publicClient.readContract({ address: REGISTRY, abi: parseAbi(['function claimed(address) view returns(uint256)']), functionName: 'claimed', args: [SENDER] }), 1n);
    assert.equal(await publicClient.getBalance({ address: SENDER }), before);
    assert.ok(await publicClient.readContract({ address: K.entryPointV07, abi: entryPoint07Abi, functionName: 'balanceOf', args: [PM] }) < balanceBefore);
    const expired = await service.sponsor({ userOperation: operation({ nonce: 1n }), validUntil }, OWNER);
    hashes.push(expired.userOpHash);
    budgetKeys.push(gasExecutionKey(1337, operation({ nonce: 1n })));
    const expiredOp = { ...operation({ nonce: 1n }), paymasterAndData: expired.paymasterAndData,
      signature: await signer.signMessage({ message: { raw: expired.userOpHash } }) };
    await local.setNextBlockTimestamp({ timestamp: BigInt(validUntil + 1) });
    await local.mine({ blocks: 1 });
    await assert.rejects(publicClient.simulateContract({ address: K.entryPointV07, abi: entryPoint07Abi, functionName: 'handleOps', args: [[expiredOp], signer.address] }), /AA32|paymaster expired/);
  } finally {
    await query('delete from paymaster_sponsorships where user_op_hash = any($1::text[])', [hashes]);
    if (strategyId) {
      await query('delete from portfolios where strategy_id=$1', [strategyId]);
      await query('delete from strategies where id=$1', [strategyId]);
    }
    await local.revert({ id: snapshot });
    // The snapshot removed the harness executions; retain their audit costs without occupying the setup slot.
    for (const executionKey of budgetKeys) await settleGasBudget(executionKey, 'failed');
  }
});
