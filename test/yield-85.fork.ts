/** Explicit acceptance only: chain 97 anvil 8592, alto 3092, DB cre8_be85. No real keys. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { createKernelAccount, createKernelAccountClient } from '@zerodev/sdk';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { KERNEL_V3_3 } from '@zerodev/sdk/constants';
import type { GetKernelVersion } from '@zerodev/sdk/types';
import { createPublicClient, createWalletClient, createTestClient, custom, decodeFunctionData, encodeFunctionData, erc20Abi, http, parseAbi, RpcRequestError } from 'viem';
import type { Hex } from 'viem';
import { bscTestnet } from 'viem/chains';
import { mnemonicToAccount } from 'viem/accounts';
import { closePool, query } from '../src/db.js';
import { REGISTRY_ABI } from '../src/chain.js';
import { computeSalt, getKernelAccountParams } from '../src/kernel.js';
import { buildSessionPermissions, deriveSessionKeyFor, sudoValidator } from '../src/permissions.js';
import { buildRenewalKey } from '../src/renewal.js';
import { estimationPaymaster, reserveGasBudget, schedulerPaymaster, settleGasBudget } from '../src/paymaster.js';
import { sessionKernelAccount } from '../src/scheduler.js';
import { signPreparedOperation } from '../src/user-operation.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
import { quoteYieldAction, reconcileYieldOperation, submitYieldAction } from '../src/yield-execution.js';
import type { SavedYieldOperation, YieldOperationJournal, YieldPlan } from '../src/yield-execution.js';
import { YIELD_EXECUTOR_ABI, YIELD_REGISTRY_ABI } from '../src/yield-abi.js';

const rpcUrl = 'http://127.0.0.1:8592', bundlerUrl = 'http://127.0.0.1:3092';
if (process.env.RPC_URL !== rpcUrl || process.env.BUNDLER_URL !== bundlerUrl || process.env.CHAIN_ID !== '97' ||
    new URL(process.env.DATABASE_URL ?? '').pathname !== '/cre8_be85') throw new Error('select the dedicated BE-85 local lane explicitly');
const client = createPublicClient({ chain: bscTestnet, transport: http(rpcUrl, { retryCount: 0, timeout: 120000 }), pollingInterval: 100 });
const local = createTestClient({ chain: bscTestnet, mode: 'anvil', transport: http(rpcUrl, { retryCount: 0, timeout: 120000 }) });
const mnemonic = 'test test test test test test test test test test test junk';
const owner = mnemonicToAccount(mnemonic, { addressIndex: 2 });
const sponsor = mnemonicToAccount(mnemonic, { addressIndex: 6 });
const material = { masterSeed: `0x${'11'.repeat(32)}` as Hex };
process.env.SESSION_KEY_MASTER_SEED = material.masterSeed;
process.env.PAYMASTER_SIGNER_PRIVATE_KEY = sponsor.getHdKey().privateKey ? `0x${Buffer.from(sponsor.getHdKey().privateKey ?? []).toString('hex')}` : '';
const entryPoint = { address: T.contracts.entryPoint, version: '0.7' } as const;
const registryExtra = parseAbi(['function nextStrategyId() view returns(uint256)', 'function setPaused(address,bool)']);
const operator = createWalletClient({ chain: bscTestnet, account: T.roles.operator, transport: http(rpcUrl, { retryCount: 0, timeout: 120000 }) });
const ownerWallet = createWalletClient({ chain: bscTestnet, account: owner, transport: http(rpcUrl, { retryCount: 0, timeout: 120000 }) });
const C = T.contracts;
after(closePool);

test('#85 Venus, Lista, Aave real sponsored Kernel supply/withdraw; old session refused, owner upgrade preserves address and exit bypasses caps', { timeout: 1200000 }, async () => {
  assert.equal(await client.getChainId(), 97);
  // This RPC is intentionally outside the production client schema and uses fetch, never a cast to any.
  const response: unknown = await (await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_nodeInfo', params: [] }) })).json();
  assert.ok(response && typeof response === 'object' && 'result' in response && response.result);
  await local.impersonateAccount({ address: T.roles.operator });
  const originalCode = await client.getCode({ address: C.paymaster }); assert.ok(originalCode);
  const oldSigner = T.roles.paymasterSigner.slice(2).padStart(64, '0');
  assert.ok(originalCode.toLowerCase().includes(oldSigner));
  await local.setCode({ address: C.paymaster, bytecode: originalCode.toLowerCase().replaceAll(oldSigner, sponsor.address.slice(2).toLowerCase().padStart(64, '0')) as Hex });
  // Keep the acceptance clock fixed while an operation is built, so all strict minima execute at
  // the exact tested timestamp. A separate step below advances it and proves stale quote rejection.
  await local.setBlockTimestampInterval({ interval: 0 });
  const gasResults: { protocol: string; supply: string; withdraw: string }[] = [];
  try {
    for (const protocol of ['Venus', 'Lista', 'Aave']) {
      const market = T.yieldMarkets.find(m => m.protocol === protocol && m.symbol === 'USDT'); assert.ok(market);
      const strategyId = 1n + await client.readContract({ address: C.registry, abi: registryExtra, functionName: 'nextStrategyId' });
      await landed(await ownerWallet.writeContract({ address: C.registry, abi: REGISTRY_ABI, functionName: 'registerStrategy', args: [`BE85 ${protocol}`, 'local yield acceptance', false] }));
      await landed(await ownerWallet.writeContract({ address: C.registry, abi: REGISTRY_ABI, functionName: 'publishVersion',
        args: [strategyId, [C.usdt], [10000], `0x${'00'.repeat(32)}`, 0n] }));
      const initial = deriveSessionKeyFor(owner.address, strategyId, material);
      const validUntil = Number((await client.getBlock()).timestamp) + 86400;
      const baseline = await buildSessionPermissions({ publicClient: client, sessionKeyAddress: initial.address, executorAddress: C.executor, validUntil });
      const params = await getKernelAccountParams(client, owner.address, computeSalt(owner.address, strategyId), {
        plugins: { sudo: await sudoValidator(client, owner.address), regular: baseline.permissionValidator }, initConfig: baseline.initConfig,
      });
      await landed(await operator.sendTransaction({ to: params.factory, data: params.factoryData, gas: 4_000_000n }));
      await landed(await operator.writeContract({ address: C.registry, abi: REGISTRY_ABI, functionName: 'enroll', args: [params.address, strategyId] }));
      await landed(await operator.writeContract({ address: C.usdt, abi: parseAbi(['function claimFor(address,uint256)']), functionName: 'claimFor', args: [params.address, 1000n * 10n ** 18n] }));
      const sid = (await query<{ id: string }>('insert into strategies(provider,name,onchain_id) values($1,$2,$3) returning id', [owner.address.toLowerCase(), `be85-${protocol}`, strategyId.toString()])).rows[0]?.id; assert.ok(sid);
      await query("insert into strategy_versions(strategy_id,version,allocation,schedule,active_at) values($1,1,$2,'{\"kind\":\"interval\",\"seconds\":86400}',now())", [sid, JSON.stringify({ assets: [{ address: C.usdt, weightBps: 10000 }] })]);
      const pid = (await query<{ id: string }>('insert into portfolios(user_id,strategy_id,version) values($1,$2,1) returning id', [owner.address.toLowerCase(), sid])).rows[0]?.id; assert.ok(pid);
      await query("insert into smart_accounts(portfolio_id,chain_id,address,owner,account_type) values($1,97,$2,$3,'KERNEL')", [pid, params.address.toLowerCase(), owner.address.toLowerCase()]);
      const kernelVersion: GetKernelVersion<'0.7'> = KERNEL_V3_3;
      const sudo = await signerToEcdsaValidator(client, { signer: owner, entryPoint, kernelVersion, validatorAddress: C.ecdsaValidatorV31 });
      const ownerAccount = await createKernelAccount(client, { address: params.address, plugins: { sudo }, entryPoint, kernelVersion });
      const paymaster = schedulerPaymaster(params.address, { now: () => Number(currentTime) }); assert.ok(paymaster);
      let currentTime = (await client.getBlock()).timestamp;
      const ownerClient = createKernelAccountClient({ account: ownerAccount, chain: bscTestnet, client, paymaster,
        bundlerTransport: http(bundlerUrl, { retryCount: 0, timeout: 120000 }),
        userOperation: { estimateFeesPerGas: async () => { const gasPrice = await client.getGasPrice(); return { maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice }; } } });
      async function ownerCalls(calls: { to: `0x${string}`; data: Hex; value: bigint }[]) {
        currentTime = (await client.getBlock()).timestamp;
        const nonce = await ownerAccount.getNonce();
        const estimate = await ownerClient.estimateUserOperationGas({ calls, nonce, paymaster: estimationPaymaster(paymaster) });
        const prepared = await ownerClient.prepareUserOperation({ calls, nonce, callGasLimit: estimate.callGasLimit * 2n,
          verificationGasLimit: estimate.verificationGasLimit, preVerificationGas: estimate.preVerificationGas });
        const hash = await ownerClient.sendUserOperation(await signPreparedOperation(prepared, op => ownerAccount.signUserOperation(op)));
        const receipt = await ownerClient.waitForUserOperationReceipt({ hash, timeout: 120000 });
        assert.equal(receipt.success, true); assert.equal(receipt.receipt.status, 'success');
      }
      const amount = 100n * 10n ** 18n;
      await ownerCalls([
        { to: C.usdt, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [C.executor, amount] }), value: 0n },
        { to: market.receipt, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [C.executor, (1n << 256n) - 1n] }), value: 0n },
        { to: C.yieldRegistry, data: encodeFunctionData({ abi: YIELD_REGISTRY_ABI, functionName: 'setYieldPolicy', args: [market.marketId, amount, true] }), value: 0n },
      ]);
      const calls: string[] = [];
      let savedPlan: YieldPlan | null = null;
      const journal: YieldOperationJournal = {
        prepare: async input => { writeFileSync(new URL('../.bun-cache/yield-saved85.json', import.meta.url), JSON.stringify(input, (_key, value: unknown) => typeof value === 'bigint' ? 'bigint:' + value : value)); calls.push('prepare'); savedPlan = input.plan; assert.equal(input.plan.minimum > 0n, true); return String(calls.length); },
        sending: async () => { calls.push('sending'); }, submitted: async () => { calls.push('submitted'); },
        confirmed: async () => { calls.push('confirmed'); }, reverted: async () => { calls.push('reverted'); }, unknown: async () => { calls.push('unknown'); },
      };
      const legacyRef = { keyRef: initial.keyRef as `m/44'/60'/${string}`, sessionKeyAddress: initial.address,
        permissionId: baseline.permissionId, validUntil, owner: owner.address };
      const base = { publicClient: client, bundlerUrl, account: params.address, journal,
        paymaster: { now: () => Number(currentTime) } };
      await assert.rejects(submitYieldAction({ ...base, sessionKey: legacyRef, policies: baseline.policySnapshot,
        action: { kind: 'supply', marketId: market.marketId, amount } }), /需要更新授權/);
      assert.equal(calls.length, 0);
      const legacyAccount = await sessionKernelAccount({ account: params.address, executor: C.executor, sessionKey: legacyRef }, client);
      const legacyClient = createKernelAccountClient({ account: legacyAccount, chain: bscTestnet, client,
        bundlerTransport: http(bundlerUrl, { retryCount: 0, timeout: 120000 }) });
      const blockedPlan = await quoteYieldAction(client, params.address, { kind: 'supply', marketId: market.marketId, amount });
      await assert.rejects(legacyClient.estimateUserOperationGas({ calls: [{ to: C.executor, data: blockedPlan.data, value: 0n }],
        nonce: await legacyAccount.getNonce(), paymaster: estimationPaymaster(paymaster) }),
        (error: unknown) => error instanceof Error && /policy|validation|AA23/i.test(error.message));
      const renewed = await buildRenewalKey({ publicClient: client, owner: owner.address, strategyId: Number(strategyId),
        accountAddress: params.address, existingKeyRefs: [initial.keyRef], material, executorAddress: C.executor, validUntil });
      await ownerCalls(renewed.initConfig.map(data => ({ to: params.address, data, value: 0n })));
      assert.equal(ownerAccount.address, params.address, 'upgrade must preserve the existing account');
      const sessionKey = { keyRef: renewed.keyRef as `m/44'/60'/${string}`, sessionKeyAddress: renewed.sessionKeyAddress,
        permissionId: renewed.permissionId, validUntil, owner: owner.address };
      const supplied = await submitYieldAction({ ...base, sessionKey, policies: renewed.policySnapshot,
        action: { kind: 'supply', marketId: market.marketId, amount } });
      assert.equal(supplied.assets, amount); assert.ok(supplied.shares > 0n);
      assert.deepEqual(calls, ['prepare', 'sending', 'submitted', 'confirmed']);
      assert.ok(savedPlan);
      let held = await client.readContract({ address: market.receipt, abi: erc20Abi, functionName: 'balanceOf', args: [params.address] });
      if (protocol === 'Venus') {
        const minima: bigint[] = [];
        const stale = createPublicClient({ chain: bscTestnet, transport: custom({ request: async ({ method, params }) => {
          const call: unknown = Array.isArray(params) ? params[0] : null;
          if (method === 'eth_call' && Array.isArray(params) && params[1] === 'latest' && call && typeof call === 'object' &&
              String(Reflect.get(call, 'to')).toLowerCase() === C.executor) {
            const data: unknown = Reflect.get(call, 'data');
            if (typeof data === 'string' && data.startsWith('0x63f865c0')) {
              const decoded = decodeFunctionData({ abi: YIELD_EXECUTOR_ABI, data: data as Hex });
              assert.ok(decoded.functionName === 'executeWithdraw'); minima.push(decoded.args[3]);
              await local.setNextBlockTimestamp({ timestamp: (await client.getBlock()).timestamp + 1n }); await local.mine({ blocks: 1 });
            }
          }
          const response: unknown = await (await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
          assert.ok(response && typeof response === 'object');
          if ('error' in response) {
            const error: unknown = response.error; assert.ok(error && typeof error === 'object');
            const code: unknown = Reflect.get(error, 'code'), message: unknown = Reflect.get(error, 'message');
            assert.ok(typeof code === 'number' && typeof message === 'string');
            throw new RpcRequestError({ body: { method, params }, url: rpcUrl,
              error: { code, message, data: Reflect.get(error, 'data') } });
          }
          assert.ok('result' in response); return response.result;
        } }, { retryCount: 0 }) });
        const before = calls.length;
        await assert.rejects(submitYieldAction({ ...base, publicClient: stale, sessionKey, policies: renewed.policySnapshot,
          action: { kind: 'withdraw', marketId: market.marketId, amount: held } }), /未放寬 min/);
        assert.equal(minima.length, 3);
        assert.ok(minima.every((min, index) => index === 0 || min > (minima[index - 1] ?? min)));
        assert.equal(calls.length, before, 'stale pre-broadcast attempts never create or resend an intent');
        currentTime = (await client.getBlock()).timestamp;
      }
      // Demonstrate that advancing accrual invalidates an old minimum without changing it.
      const oldQuote = await quoteYieldAction(client, params.address, { kind: 'withdraw', marketId: market.marketId, amount: held });
      const quoteTime = (await client.getBlock()).timestamp;
      await local.setNextBlockTimestamp({ timestamp: quoteTime + 60n }); await local.mine({ blocks: 1 });
      assert.equal((await client.getBlock()).timestamp, quoteTime + 60n);
      if (protocol === 'Venus' || protocol === 'Lista') {
        await assert.rejects(client.call({ account: params.address, to: C.executor, data: oldQuote.data }));
      } else {
        // Aave public shares are raw aToken: a fixed raw amount has a fixed underlying quote.
        await client.call({ account: params.address, to: C.executor, data: oldQuote.data });
        assert.equal((await quoteYieldAction(client, params.address, { kind: 'withdraw', marketId: market.marketId, amount: held })).minimum, oldQuote.minimum);
      }
      currentTime = (await client.getBlock()).timestamp;
      await landed(await operator.writeContract({ address: C.registry, abi: registryExtra, functionName: 'setPaused', args: [params.address, true] }));
      held = await client.readContract({ address: market.receipt, abi: erc20Abi, functionName: 'balanceOf', args: [params.address] });
      // Exhaust the ordinary shared ledger after supply. Pure exit still reserves gas in that ledger.
      const usage = await query<{ gas: string }>("select coalesce(sum(gas_limit),0)::text as gas from gas_budget_reservations where chain_id=97 and account=$1 and purpose='ordinary'", [params.address.toLowerCase()]);
      await reserveGasBudget({ chainId: 97, account: params.address.toLowerCase() as Hex, executionKey: `be85-exhaust:${params.address}`,
        purpose: 'ordinary', gasLimit: 100_000_000n - BigInt(usage.rows[0]?.gas ?? '0'), maxFeePerGas: 1n, nativePrice: 1n, priceSource: 'test:yield-85' });
      if (protocol === 'Lista') {
        // The transaction succeeds but the final persistence commit is unknown. Keep the original
        // attempt, reconcile it independently, then allow the remaining partial exit to continue.
        let pending: (SavedYieldOperation & { executionKey: string }) | undefined;
        const before = calls.length;
        await assert.rejects(submitYieldAction({ ...base, sessionKey, policies: renewed.policySnapshot,
          action: { kind: 'withdraw', marketId: market.marketId, amount: held / 2n }, journal: { ...journal,
            prepare: async input => { pending = input; return journal.prepare(input); },
            confirmed: async () => { throw new Error('SECRET_DATABASE_COMMIT_UNKNOWN'); },
          } }), (error: unknown) => error instanceof Error && /保留在途/.test(error.message) && !error.message.includes('SECRET'));
        assert.deepEqual(calls.slice(before), ['prepare', 'sending', 'submitted', 'unknown']);
        assert.ok(pending);
        const recovered = await reconcileYieldOperation(client, bundlerUrl, pending);
        assert.ok(recovered.status === 'confirmed'); assert.ok(recovered.evidence.remainingReceipts > 0n);
        await journal.confirmed('recovered', recovered.evidence);
        await settleGasBudget(pending.executionKey, 'confirmed');
        held = await client.readContract({ address: market.receipt, abi: erc20Abi, functionName: 'balanceOf', args: [params.address] });
      }
      const withdrawn = await submitYieldAction({ ...base, sessionKey, policies: renewed.policySnapshot,
        action: { kind: 'withdraw', marketId: market.marketId, amount: held } });
      assert.equal(withdrawn.remainingReceipts, 0n); assert.equal(withdrawn.shares, held);
      assert.equal(await client.readContract({ address: market.receipt, abi: erc20Abi, functionName: 'balanceOf', args: [params.address] }), 0n);
      const purposes = await query<{ purpose: string }>('select purpose from gas_budget_reservations where account=$1 and state=\'confirmed\' order by created_at', [params.address.toLowerCase()]);
      assert.deepEqual(purposes.rows.map(r => r.purpose), protocol === 'Lista' ? ['ordinary', 'exit', 'exit'] : ['ordinary', 'exit']);
      gasResults.push({ protocol, supply: supplied.gasUsed.toString(), withdraw: withdrawn.gasUsed.toString() });
    }
    console.log(JSON.stringify({ be85KernelGas: gasResults }));
  } finally {
    await local.setCode({ address: C.paymaster, bytecode: originalCode });
    assert.equal(await client.getCode({ address: C.paymaster }), originalCode);
    await local.removeBlockTimestampInterval();
    await local.stopImpersonatingAccount({ address: T.roles.operator });
  }
});

async function landed(hash: Hex) {
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120000 });
  assert.equal(receipt.status, 'success');
}
