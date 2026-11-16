/** Explicit acceptance: bun --no-env-file test ./test/yield-106.fork.ts --timeout=1200000.
 * Requires the reviewed manifest deployed on chain 97 anvil 8599, alto 3099, DB cre8_be110.
 * No automatic discovery, external signing service, key files or public-chain writes.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { createKernelAccount, createKernelAccountClient } from '@zerodev/sdk';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { KERNEL_V3_3 } from '@zerodev/sdk/constants';
import { createPublicClient, createTestClient, createWalletClient, encodeFunctionData, erc20Abi, http, maxUint256, parseAbi } from 'viem';
import type { Address, Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';
import { closePool, migrate, query, withPortfolioLock } from '../src/db.js';
import { REGISTRY_ABI } from '../src/chain.js';
import { AppError } from '../src/errors.js';
import { computeSalt, getKernelAccountParams } from '../src/kernel.js';
import { buildSessionPermissions, deriveSessionKeyFor, sudoValidator } from '../src/permissions.js';
import { buildRenewalKey } from '../src/renewal.js';
import { estimationPaymaster, readNativeBudgetPrice, schedulerPaymaster, settleGasBudget } from '../src/paymaster.js';
import { signPreparedOperation } from '../src/user-operation.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
import { checkTestnetProfile } from '../src/testnet-preflight.js';
import { YIELD_EXECUTOR_ABI, YIELD_REGISTRY_ABI } from '../src/yield-abi.js';
import { createYieldService, runYieldRound } from '../src/yield-service.js';
import { readYieldAccount } from '../src/yield-reader.js';
import { yieldProfile, WAD } from '../src/yield-domain.js';
import { gasExecutionKey, canonicalKernelCalls } from '../src/paymaster.js';
import type { SnapshotRow } from '../src/yield-store.js';
import { restoreYieldOperation } from '../src/yield-store.js';
import { reconcileYieldOperation, submitYieldAction } from '../src/yield-execution.js';
import type { SavedYieldOperation } from '../src/yield-execution.js';
import { localAcceptanceEnv } from './fixtures/local-acceptance.js';

const lane = localAcceptanceEnv(process.env, true);
const rpcUrl = 'http://127.0.0.1:8599', bundlerUrl = 'http://127.0.0.1:3099';
assert.ok(lane.rpcUrl === rpcUrl && lane.bundler?.url === bundlerUrl && lane.backendPort === 8699 && lane.databaseName === 'cre8_be110', 'select only the BE110 local lane');
assert.equal(process.env.ENABLE_YIELD_EXECUTION, '1');
const client = createPublicClient({ chain: bscTestnet, transport: http(rpcUrl, { retryCount: 0, timeout: 120000 }), pollingInterval: 100, cacheTime: 0 });
const local = createTestClient({ chain: bscTestnet, mode: 'anvil', transport: http(rpcUrl, { retryCount: 0, timeout: 120000 }) });
const mnemonic = 'test test test test test test test test test test test junk';
const owner = mnemonicToAccount(mnemonic, { addressIndex: 2 }), sponsor = mnemonicToAccount(mnemonic, { addressIndex: 6 });
const material = { masterSeed: `0x${'11'.repeat(32)}` as Hex };
process.env.SESSION_KEY_MASTER_SEED = material.masterSeed;
const sponsorKey = sponsor.getHdKey().privateKey; assert.ok(sponsorKey);
process.env.PAYMASTER_SIGNER_PRIVATE_KEY = `0x${Buffer.from(sponsorKey).toString('hex')}`;
const C = T.contracts, entryPoint = { address: C.entryPoint, version: '0.7' } as const;
const operator = createWalletClient({ chain: bscTestnet, account: T.roles.operator, transport: http(rpcUrl, { retryCount: 0, timeout: 120000 }) });
const ownerWallet = createWalletClient({ chain: bscTestnet, account: owner, transport: http(rpcUrl, { retryCount: 0, timeout: 120000 }) });
const extra = parseAbi(['function nextStrategyId() view returns(uint256)', 'function setLiquidity(uint256)', 'function getDeposit() view returns(uint256)', 'function scaledBalanceOf(address) view returns(uint256)']);
const feeds = parseAbi(['function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)', 'function push(int256)']);
// Use the real local RPC client without requiring the deployment operator's private key.
const chainDeps = { client: () => client, port: async () => ({ reconcileYieldOperation,
  submitYieldAction: (args: Parameters<typeof submitYieldAction>[0]) => submitYieldAction({ ...args, maxQuoteAttempts: 1,
    journal: { ...args.journal, prepare: async input => {
      const id = await args.journal.prepare(input);
      // Advance real time and a local block AFTER the immutable quote is persisted.
      // Production quoting, signing, sponsorship, submission and settlement stay intact.
      await pause(2100); await refreshClock();
      return id;
    } },
  }),
}) };
const service = createYieldService(chainDeps);
let passes = 0;
function check(value: unknown, label: string): asserts value { assert.ok(value, label); passes++; console.log('PASS ' + label); }
async function refreshClock() {
  const wall = BigInt(Math.floor(Date.now() / 1000)), block = await client.getBlock();
  assert.ok(block.timestamp <= wall, 'local fork must never put DB evidence in the future');
  if (block.timestamp < wall) { await local.setNextBlockTimestamp({ timestamp: wall }); await local.mine({ blocks: 1 }); }
}
async function landed(hash: Hex) { await local.mine({ blocks: 1 }); const r = await client.waitForTransactionReceipt({ hash }); assert.equal(r.status, 'success'); return r; }
async function refreshGasPriceFeeds() {
  const keeper = createWalletClient({ chain: bscTestnet, account: T.roles.keeper, transport: http(rpcUrl, { retryCount: 0, timeout: 120000 }) });
  for (const address of [C['feed.USDT/USD'], T.assets.WBNB.feed]) {
    const round = await client.readContract({ address, abi: feeds, functionName: 'latestRoundData' });
    await landed(await keeper.writeContract({ address, abi: feeds, functionName: 'push', args: [round[1]] }));
  }
}
async function pokeGasPricePool() {
  // Same chain-97 SwapRouter and 1,000-USDT keeper poke as C1's PokePoolsTestnet.
  const router = '0x1b81D678ffb9C0263b24A97847620C99d213eB14';
  const abi = parseAbi(['function factory() view returns(address)',
    'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns(uint256)',
    'function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint32,bool)']);
  assert.equal((await client.readContract({ address: router, abi, functionName: 'factory' })).toLowerCase(), C.v3Factory);
  const keeper = createWalletClient({ chain: bscTestnet, account: T.roles.keeper, transport: http(rpcUrl, { retryCount: 0, timeout: 120000 }) });
  const stock = await client.readContract({ address: C.usdt, abi: erc20Abi, functionName: 'balanceOf', args: [T.roles.keeper] });
  assert.ok(stock >= 1000n * WAD, 'seed keeper mock-USDT inventory before acceptance');
  const before = await client.readContract({ address: T.assets.WBNB.pool, abi, functionName: 'slot0' });
  await landed(await keeper.writeContract({ address: C.usdt, abi: erc20Abi, functionName: 'approve', args: [router, 1000n * WAD] }));
  await landed(await keeper.writeContract({ address: router, abi, functionName: 'exactInputSingle', args: [{
    tokenIn: C.usdt, tokenOut: T.assets.WBNB.token, fee: T.assets.WBNB.poolFee, recipient: T.roles.keeper,
    deadline: (await client.getBlock()).timestamp + 300n, amountIn: 1000n * WAD, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n,
  }] }));
  const after = await client.readContract({ address: T.assets.WBNB.pool, abi, functionName: 'slot0' });
  check(before[1] !== after[1], 'real keeper swap refreshes the WBNB gas-price pool observation');
}
after(closePool);

test('#110 cross-block durable scheduler + real sponsored Kernel lifecycle for Venus, Lista and Aave, with 60/day boundary', { timeout: 1200000 }, async () => {
  const info: unknown = await (await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_nodeInfo', params: [] }) })).json();
  check(info && typeof info === 'object' && 'result' in info && info.result && await client.getChainId() === 97, 'local anvil chain 97 proof');
  check((await checkTestnetProfile(client)).every(c => c.level === 'ok'), 'all manifest runtime hashes and selectors match before local signer substitution');
  check((await client.readContract({ address: C.yieldRegistry, abi: YIELD_REGISTRY_ABI, functionName: 'reader' })).toLowerCase() === C.yieldView, 'registry links the pinned YieldView');
  check(await client.readContract({ address: C.executor, abi: YIELD_EXECUTOR_ABI, functionName: 'YIELD_QUOTE_TOLERANCE_BPS' }) === 10n, 'executor has the reviewed 10 bps cross-block tolerance');
  await migrate();
  check((await query('select portfolio_id from smart_accounts')).rows.length === 0, 'fresh isolated acceptance database');
  const profile = yieldProfile(); assert.ok(profile);
  const originalCode = await client.getCode({ address: C.paymaster }); assert.ok(originalCode);
  const originalSigner = T.roles.paymasterSigner.slice(2).padStart(64, '0');
  check(originalCode.toLowerCase().includes(originalSigner), 'reviewed paymaster embeds the expected signer');
  // Replace ONLY the immutable signer in this local fork, retaining real verification and payment.
  // The deployed testnet signer has no public key material; no real key file is opened.
  await local.setCode({ address: C.paymaster, bytecode: originalCode.toLowerCase().replaceAll(originalSigner, sponsor.address.slice(2).toLowerCase().padStart(64, '0')) as Hex });
  await local.impersonateAccount({ address: T.roles.operator });
  await local.impersonateAccount({ address: T.roles.owner });
  await local.impersonateAccount({ address: T.roles.keeper });
  await local.setBlockTimestampInterval({ interval: 0 });
  const depositBefore = await client.readContract({ address: C.paymaster, abi: extra, functionName: 'getDeposit' });
  const gas: { protocol: string; phase: string; gasUsed: string; txHash: Hex }[] = [];
  async function verifyOriginalQuote(saved: SavedYieldOperation, txHash: Hex) {
    const p = saved.plan;
    const quoted = p.kind === 'supply'
      ? (await client.simulateContract({ address: C.yieldRegistry, abi: YIELD_REGISTRY_ABI, functionName: 'quoteSupply', args: [p.marketId, p.account, p.amount], account: p.account, blockNumber: p.quoteBlock })).result
      : (await client.simulateContract({ address: C.yieldRegistry, abi: YIELD_REGISTRY_ABI, functionName: 'quoteWithdraw', args: [p.marketId, p.amount], account: p.account, blockNumber: p.quoteBlock })).result;
    check(p.minimum === quoted * 9995n / 10000n && p.minimum > 0n, `${p.kind} persisted signed minimum floors the original quote with 5 bps tolerance`);
    const receipt = await client.getTransactionReceipt({ hash: txHash });
    const before = await client.getBlock({ blockNumber: p.quoteBlock }), after = await client.getBlock({ blockNumber: receipt.blockNumber });
    check(before.hash === p.quoteBlockHash && receipt.blockNumber >= p.quoteBlock + 2n && after.timestamp > before.timestamp, `${p.kind} original quote succeeds across two blocks and real elapsed time without retry`);
    console.log('YIELD_110_CROSS_BLOCK ' + JSON.stringify({ kind: p.kind, market: p.marketId, quote: quoted.toString(), minimum: p.minimum.toString(), quoteBlock: p.quoteBlock.toString(), executionBlock: receipt.blockNumber.toString(), elapsedSeconds: (after.timestamp - before.timestamp).toString() }));
  }
  try {
    // The launcher deploys on an older fork block. Catch up once: TWAP warms without
    // future-dated SQL evidence or any replacement of PostgreSQL's clock.
    await refreshClock();
    await refreshGasPriceFeeds();
    await pokeGasPricePool();
    check((await readNativeBudgetPrice(client, C.executor, 97)).nativePrice > 0n, 'production gas budget oracle has a fresh real quote');
    const catalog = await service.markets(97);
    check(catalog.markets.length === 30 && catalog.markets.every(m => m.aprBps !== null && BigInt(m.aprBps) > 0n) && catalog.markets.filter(m => m.symbol === 'USDT').every(m => m.supplyOpen), 'production market reader admits the configured yield catalog with all 30 APRs nonzero');
    for (const protocol of ['Venus', 'Lista', 'Aave'] as const) {
      const market = T.yieldMarkets.find(m => m.protocol === protocol && m.symbol === 'USDT'); assert.ok(market);
      const strategyId = 1n + await client.readContract({ address: C.registry, abi: extra, functionName: 'nextStrategyId' });
      await landed(await ownerWallet.writeContract({ address: C.registry, abi: REGISTRY_ABI, functionName: 'registerStrategy', args: [`BE110 ${protocol}`, 'local Kernel yield acceptance', false] }));
      await landed(await ownerWallet.writeContract({ address: C.registry, abi: REGISTRY_ABI, functionName: 'publishVersion', args: [strategyId, [C.usdt], [10000], `0x${'00'.repeat(32)}`, 0n] }));
      const initial = deriveSessionKeyFor(owner.address, strategyId, material);
      const validUntil = Number((await client.getBlock()).timestamp) + 86400;
      const baseline = await buildSessionPermissions({ publicClient: client, sessionKeyAddress: initial.address, executorAddress: C.executor, validUntil });
      const params = await getKernelAccountParams(client, owner.address, computeSalt(owner.address, strategyId), {
        plugins: { sudo: await sudoValidator(client, owner.address), regular: baseline.permissionValidator }, initConfig: baseline.initConfig,
      });
      await landed(await operator.sendTransaction({ to: params.factory, data: params.factoryData, gas: 4_000_000n }));
      await landed(await operator.writeContract({ address: C.registry, abi: REGISTRY_ABI, functionName: 'enroll', args: [params.address, strategyId] }));
      const amount = 100n * WAD;
      await landed(await operator.writeContract({ address: C.usdt, abi: parseAbi(['function claimFor(address,uint256)']), functionName: 'claimFor', args: [params.address, amount] }));
      const sid = (await query<{ id: string }>('insert into strategies(provider,name,onchain_id) values($1,$2,$3) returning id::text', [owner.address.toLowerCase(), `be110-${protocol}`, strategyId.toString()])).rows[0]?.id; assert.ok(sid);
      const selected = profile.markets.find(m => m.marketId === market.marketId); assert.ok(selected);
      const execution = { kind: 'per_asset', numeraire: C.usdt, rebalance: 'none', assets: [{ asset: C.usdt, weightBps: 10000, yield: { market: selected.id } }] };
      await query(`insert into strategy_versions(strategy_id,version,allocation,schedule,active_at,execution_schema_version,execution,execution_chain_id,config_hash)
        values($1,1,$2,'{"kind":"funding"}',now()-interval '1 day',2,$3,97,$4)`, [sid, JSON.stringify({ assets: [{ address: C.usdt, weightBps: 10000 }] }), JSON.stringify(execution), `0x${'01'.repeat(32)}`]);
      const pid = (await query<{ id: string }>("insert into portfolios(user_id,strategy_id,version,schedule_state) values($1,$2,1,'active') returning id::text", [owner.address.toLowerCase(), sid])).rows[0]?.id; assert.ok(pid);
      const id = Number(pid), account = params.address.toLowerCase() as Address;
      await query("insert into smart_accounts(portfolio_id,chain_id,address,owner,account_type) values($1,97,$2,$3,'KERNEL')", [id, account, owner.address.toLowerCase()]);
      const sudo = await signerToEcdsaValidator(client, { signer: owner, entryPoint, kernelVersion: KERNEL_V3_3, validatorAddress: C.ecdsaValidatorV31 });
      const kernel = await createKernelAccount(client, { address: params.address, plugins: { sudo }, entryPoint, kernelVersion: KERNEL_V3_3 });
      const paymaster = schedulerPaymaster(account); assert.ok(paymaster);
      const ownerClient = createKernelAccountClient({ account: kernel, chain: bscTestnet, client, paymaster,
        bundlerTransport: http(bundlerUrl, { retryCount: 0, timeout: 120000 }),
        userOperation: { estimateFeesPerGas: async () => { const price = await client.getGasPrice(); return { maxFeePerGas: price, maxPriorityFeePerGas: price }; } } });
      async function ownerCalls(phase: string, calls: { to: Address; data: Hex; value: bigint }[], savedNonce?: bigint) {
        await refreshClock();
        const nonce = savedNonce ?? await kernel.getNonce();
        const estimate = await ownerClient.estimateUserOperationGas({ calls, nonce, paymaster: estimationPaymaster(paymaster) });
        const prepared = await ownerClient.prepareUserOperation({ calls, nonce, callGasLimit: estimate.callGasLimit * 2n, verificationGasLimit: estimate.verificationGasLimit, preVerificationGas: estimate.preVerificationGas });
        const hash = await ownerClient.sendUserOperation(await signPreparedOperation(prepared, op => kernel.signUserOperation(op)));
        const receipt = await ownerClient.waitForUserOperationReceipt({ hash, timeout: 120000 });
        check(receipt.success && receipt.receipt.status === 'success', `${protocol} ${phase} real owner UserOp`);
        await settleGasBudget(gasExecutionKey(97, { sender: account, nonce, initCode: '0x', callData: prepared.callData }), 'confirmed');
        gas.push({ protocol, phase, gasUsed: receipt.actualGasUsed.toString(), txHash: receipt.receipt.transactionHash });
        return receipt.receipt.transactionHash;
      }
      const renewed = await buildRenewalKey({ publicClient: client, owner: owner.address, strategyId: Number(strategyId), accountAddress: params.address,
        existingKeyRefs: [initial.keyRef], material, executorAddress: C.executor, validUntil });
      await ownerCalls('A10 upgrade', renewed.initConfig.map(data => ({ to: params.address, data, value: 0n })));
      check(kernel.address === params.address && baseline.permissionId !== renewed.permissionId, `${protocol} owner upgrade preserves Kernel and changes permission`);
      await query("insert into session_keys(portfolio_id,key_ref,permissions,expires_at,status) values($1,$2,$3,$4,'active')", [id, renewed.keyRef, JSON.stringify(renewed.policySnapshot), renewed.expiresAt]);
      await refreshClock();
      const beforeConsent = await runYieldRound({ dryRun: false, limit: 10 }, chainDeps);
      check(beforeConsent.blocked === 0 && (await query('select execution_key from yield_actions where portfolio_id=$1', [id])).rows.length === 0, `${protocol} scheduler sends nothing without consent`);
      const proof = await ownerCalls('consent max', [
        { to: C.usdt, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [C.executor, maxUint256] }), value: 0n },
        { to: market.receipt, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [C.executor, maxUint256] }), value: 0n },
        { to: C.yieldRegistry, data: encodeFunctionData({ abi: YIELD_REGISTRY_ABI, functionName: 'setYieldPolicy', args: [market.marketId, maxUint256, true] }), value: 0n },
      ]);
      await service.consent(id, owner.address, { markets: [market.marketId], txHash: proof });
      check((await query('select id from yield_consents where portfolio_id=$1 and opted_out_at is null', [id])).rows.length === 1, `${protocol} canonical consent persists`);
      await query('update strategy_cash_balances set allocated_cash_raw=$2 where portfolio_id=$1', [id, amount.toString()]);
      async function tick(phase: string) {
        await refreshClock();
        const result = await withPortfolioLock(id, () => service.tick({ portfolioId: id, chainId: 97, account }, false));
        console.log(JSON.stringify({ protocol, phase, result }));
        return result;
      }
      await refreshClock();
      const supply = await runYieldRound({ dryRun: false, limit: 10 }, chainDeps);
      check(supply.blocked === 0 && (await query("select execution_key from yield_actions where portfolio_id=$1 and kind='supply' and state='confirmed'", [id])).rows.length === 1, `${protocol} production scheduler supply confirmed in DB`);
      const supplyRow = (await query<SnapshotRow>('select * from yield_execution_snapshots where account=$1', [account])).rows[0]; assert.ok(supplyRow);
      const saved = restoreYieldOperation(supplyRow);
      check(saved.plan.minimum > 0n && saved.plan.amount === amount && canonicalKernelCalls(saved.callData).length === 1, `${protocol} original journal payload/nonce/minimum restored`);
      const reconciled = await reconcileYieldOperation(client, bundlerUrl, saved);
      check(reconciled.status === 'confirmed', `${protocol} independent restart receipt reconciliation`);
      await verifyOriginalQuote(saved, reconciled.evidence.txHash);
      gas.push({ protocol, phase: 'supply', gasUsed: reconciled.evidence.gasUsed.toString(), txHash: reconciled.evidence.txHash });
      // Even one real elapsed second produces nonzero raw interest in these markets.
      // Keep the production APR and every SQL freshness check intact.
      await pause(1100); await refreshClock();
      await refreshGasPriceFeeds();
      const accrued = await readYieldAccount(client, profile, account);
      const position = accrued.positions.find(p => p.market.marketId === market.marketId); assert.ok(position);
      check(position.state === 'known' && position.claim !== null && position.claim > amount && position.value === position.claim, `${protocol} interest accrues into claim and NAV`);
      const marketOwner = createWalletClient({ chain: bscTestnet, account: T.roles.owner, transport: http(rpcUrl, { retryCount: 0, timeout: 120000 }) });
      await landed(await marketOwner.writeContract({ address: market.target, abi: extra, functionName: 'setLiquidity', args: [50n * WAD] }));
      check(await tick('partial liquidity exit') === '生息領出已確認', `${protocol} risk withdrawal through session/bundler/journal`);
      const partial = await client.readContract({ address: market.receipt, abi: erc20Abi, functionName: 'balanceOf', args: [account] });
      check(partial > 0n && partial < (position.receipt ?? 0n), `${protocol} partial exit retains receipts`);
      const exit = await ownerCalls('stop yield', [{ to: C.yieldRegistry, data: encodeFunctionData({ abi: YIELD_REGISTRY_ABI, functionName: 'requestExit', args: [market.marketId] }), value: 0n }]);
      await service.exit(id, owner.address, { markets: [market.marketId], txHash: exit });
      await landed(await marketOwner.writeContract({ address: market.target, abi: extra, functionName: 'setLiquidity', args: [1_000_000n * WAD] }));
      check(await tick('full exit') === '生息領出已確認', `${protocol} stop and withdraw remainder`);
      let withdrawals = 2, completed = false;
      // Aave's raw aToken balance keeps growing after the immutable amount is signed.
      // Let the production durable exit consume each accrued remainder; require strict
      // scaled-unit progress and eventual zero instead of assuming a fixed action count.
      for (let attempt = 0; attempt < 8; attempt++) {
        const before = (await readYieldAccount(client, profile, account)).positions.find(p => p.market.marketId === market.marketId);
        assert.ok(before?.state === 'known' && before.observedUnits !== null);
        await pause(1100);
        const result = await tick(`complete ${attempt + 1}`);
        if (result === '生息已全部領回') { completed = true; break; }
        assert.equal(result, '生息領出已確認');
        const after = (await readYieldAccount(client, profile, account)).positions.find(p => p.market.marketId === market.marketId);
        check(protocol === 'Aave' && after?.state === 'known' && after.observedUnits !== null &&
          after.observedUnits < before.observedUnits, `${protocol} accrued remainder ${attempt + 1} strictly reduces scaled units`);
        withdrawals++;
      }
      check(completed, `${protocol} durable exit completed only after fresh zero read`);
      const final = await readYieldAccount(client, profile, account);
      const zero = final.positions.find(p => p.market.marketId === market.marketId); assert.ok(zero);
      check(zero.receipt === 0n && zero.observedUnits === 0n && zero.trackedUnits === 0n && !zero.exiting, `${protocol} receipt, scaled/account units and exit flag zero`);
      check((await query("select id from yield_exit_requests where portfolio_id=$1 and state<>'completed'", [id])).rows.length === 0, `${protocol} no pending DB exit`);
      const rows = await query<{ plan_json: unknown; user_op_hash: Hex; nonce: string; execution_key: string }>('select plan_json,user_op_hash,nonce,execution_key from yield_execution_snapshots where account=$1 order by quote_block_number,nonce', [account]);
      check(rows.rows.length === 1 + withdrawals && !JSON.stringify(rows.rows).includes('signature'), `${protocol} every supply/withdraw has an immutable public execution snapshot`);
      const exits = await query<{ user_op_hash: Hex }>("select s.user_op_hash from yield_execution_snapshots s join yield_actions a using(execution_key) where a.portfolio_id=$1 and a.kind='withdraw' order by s.quote_block_number", [id]);
      assert.equal(exits.rows.length, withdrawals);
      const supplyBlock = (await client.getTransactionReceipt({ hash: reconciled.evidence.txHash })).blockNumber;
      let units = protocol === 'Aave' ? await client.readContract({ address: market.receipt, abi: extra,
        functionName: 'scaledBalanceOf', args: [account], blockNumber: supplyBlock }) : 0n;
      let remainingBasis = amount, realizedLoss = 0n, withdrawnAssets = 0n;
      for (const [index, row] of exits.rows.entries()) {
        const snapshot = (await query<SnapshotRow>('select * from yield_execution_snapshots where user_op_hash=$1', [row.user_op_hash])).rows[0]; assert.ok(snapshot);
        const original = restoreYieldOperation(snapshot);
        const verified = await reconcileYieldOperation(client, bundlerUrl, original); assert.equal(verified.status, 'confirmed');
        await verifyOriginalQuote(original, verified.evidence.txHash);
        withdrawnAssets += verified.evidence.assets;
        if (protocol === 'Aave') {
          assert.equal(original.plan.scaledReceiptBalance, units);
          const blockNumber = (await client.getTransactionReceipt({ hash: verified.evidence.txHash })).blockNumber;
          const after = await client.readContract({ address: market.receipt, abi: extra, functionName: 'scaledBalanceOf', args: [account], blockNumber });
          assert.ok(units > 0n && after < units);
          // Independent single-deposit cost basis from canonical RPC units and actual assets.
          // BE106 realizes loss per redemption; later interest never replenishes lost principal.
          const consumedBasis = after === 0n ? remainingBasis : remainingBasis * (units - after) / units;
          if (consumedBasis > verified.evidence.assets) realizedLoss += consumedBasis - verified.evidence.assets;
          remainingBasis -= consumedBasis; units = after;
        }
        gas.push({ protocol, phase: index === 0 ? 'partial' : index === 1 ? 'full' : `accrued remainder ${index - 1}`, gasUsed: verified.evidence.gasUsed.toString(), txHash: verified.evidence.txHash });
      }
      if (protocol === 'Aave') { assert.equal(units, 0n); assert.equal(remainingBasis, 0n); }
      const cash = (await query<{ allocated: string; earnings: string }>('select allocated_cash_raw::text as allocated,yield_raw::text as earnings from strategy_cash_balances where portfolio_id=$1', [id])).rows[0]; assert.ok(cash);
      const balance = await client.readContract({ address: C.usdt, abi: erc20Abi, functionName: 'balanceOf', args: [account] });
      const returnedPrincipal = amount - realizedLoss, interest = withdrawnAssets - returnedPrincipal;
      check(BigInt(cash.allocated) === returnedPrincipal && BigInt(cash.earnings) === interest && interest > 0n &&
        returnedPrincipal + interest === balance, `${protocol} exact canonical principal/loss/interest match DB and cash without loss top-up`);
      console.log('YIELD_110_SETTLEMENT ' + JSON.stringify({ protocol, principal: returnedPrincipal.toString(), loss: realizedLoss.toString(), interest: interest.toString(), balance: balance.toString() }));
      check(await client.getBalance({ address: account }) === 0n, `${protocol} Kernel holds zero native gas funds`);
      if (protocol === 'Aave') {
        const count = async () => Number((await query<{ n: string }>('select count(*)::text as n from paymaster_sponsorships where chain_id=97 and sender=$1', [account])).rows[0]?.n);
        const initialCount = await count(); check(initialCount > 0 && initialCount < 60, 'yield and owner operations share the durable sponsorship count');
        for (let n = initialCount; n < 60; n++) await ownerCalls(`daily count ${n + 1}`, [{ to: C.usdt, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [C.executor, maxUint256] }), value: 0n }]);
        check(await count() === 60, '60th real sponsored UserOp accepted');
        const nonce = await kernel.getNonce();
        // SDK getNonce() consumes a new nonce KEY on every call. Compare the exact attempted
        // key directly at EntryPoint, and send that saved nonce through the rejected attempt.
        const chainNonce = () => client.readContract({ address: C.entryPoint, abi: parseAbi(['function getNonce(address,uint192) view returns(uint256)']), functionName: 'getNonce', args: [account, nonce >> 64n] });
        const budgets = async () => (await query('select execution_key from gas_budget_reservations where chain_id=97 and account=$1', [account])).rows.length;
        const budgetsBefore = await budgets();
        assert.equal(await chainNonce(), nonce);
        await assert.rejects(ownerCalls('daily count 61', [{ to: C.usdt, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [C.executor, maxUint256] }), value: 0n }], nonce), e => e instanceof AppError && e.code === 'PAYMASTER_QUOTA_EXCEEDED');
        check(await count() === 60 && await budgets() === budgetsBefore && await chainNonce() === nonce, '61st denied without a durable charge, gas reservation or on-chain nonce change');
      }
    }
    check(await client.readContract({ address: C.paymaster, abi: extra, functionName: 'getDeposit' }) < depositBefore, 'paymaster EntryPoint deposit paid actual gas');
    check((await query("select execution_key from yield_actions where state in ('reserved','submitted','unknown')")).rows.length === 0, 'no unresolved yield operations after all three lifecycles');
    console.log('YIELD_110_GAS ' + JSON.stringify(gas));
    console.log(`YIELD_110_ACCEPTANCE: ${passes} pass / 0 skip / 0 fail`);
  } finally {
    await local.setCode({ address: C.paymaster, bytecode: originalCode });
    await local.stopImpersonatingAccount({ address: T.roles.operator });
    await local.stopImpersonatingAccount({ address: T.roles.owner });
    await local.stopImpersonatingAccount({ address: T.roles.keeper });
  }
});
