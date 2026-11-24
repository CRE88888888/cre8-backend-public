/** Routing v2 fork acceptance (opt-in, not in CI): FORK_RPC_URL=http://127.0.0.1:<port> bun test ./test/strategy-earn-v2.fork.ts --timeout=600000
 * Needs a local anvil fork of chain 97 taken after the v2 deployment (block 144628034). Impersonation only; never touches a public chain.
 * Account: cre8-contracts RoutingDemoAccount (enrolled in AtpRegistry, holds NVDAB, nothing on v1). Every call is sent from
 * the account itself: exactly the calldata the owner's UserOp / the scheduler's session-key UserOp carries. Reads go through
 * the same reader the services use (AtpBorrowLensV2 + Multicall3), pointed at the fork.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { concatHex, createPublicClient, createTestClient, createWalletClient, decodeFunctionData, encodeFunctionData, http, maxUint256, pad, parseAbi, parseEther, toFunctionSelector } from 'viem';
import type { Address, Hex, Log } from 'viem';
import { bscTestnet } from 'viem/chains';
import { createStrategyEarnV2Api } from '../src/strategy-earn-v2-api.js';
import { createV2Reader, v2Multicall } from '../src/strategy-earn-v2-chain.js';
import { fromTestnetMocks, reportCalldata, reportDue, runRateReport } from '../src/strategy-earn-v2-rates.js';
import { runV2KeeperRound, v2AutoRound, v2UnwindForSale } from '../src/strategy-earn-v2-scheduler.js';
import type { V2Ledger, V2Tx } from '../src/strategy-earn-v2-scheduler.js';
import { loanTokenNeeds } from '../src/strategy-earn-v2-swap.js';
import { strategyEarnV2, v2Calls, v2RescueCall, v2SessionPermissions, V2_EXECUTOR_ABI, V2_REGISTRY_ABI } from '../src/strategy-earn-v2.js';
import type { Call, RouteEvent } from '../src/strategy-earn-v2.js';
import { readStrategyEarnV2Collateral } from '../src/snapshot.js';
import type { RewardEvent } from '../src/strategy-rewards.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';

const rpc = process.env.FORK_RPC_URL;
const A = '0x65c3251f4854a53cc01c2386a44ec372f292c37c' as Address; // RoutingDemoAccount
const OWNER = '0x09bbb9a06a0c49ad24bddb18808944041783054e' as Address; // AtpRegistry owner (lines, rates) and the demo account's reward recipient
const OPERATOR = '0xd8ce3295e05ca138e0d0d7214c4fd630c43f9d7f' as Address; // registry.rateReporter
const KEEPER = '0x4a07cdac26afdc89eb47d653a95b8abf6b1f4b0a' as Address;
const NVDAB = T.assets.NVDAB.token as Address;
const skip = rpc ? false : 'FORK_RPC_URL not set';
/** V2_FORK_TRACE=1 prints each step as it starts (a fork that has to fetch state can be slow; this shows where). */
const mark = (label: string) => { if (process.env.V2_FORK_TRACE === '1') console.error(`[v2 fork] ${new Date().toISOString().slice(11, 19)} ${label}`); };

/**
 * The receipt of a transaction on the fork. Anvil mines only when a transaction arrives, so viem's block watcher can wait
 * forever for a "next block" when its first receipt read raced the miner; a plain poll cannot.
 */
async function mined(client: { getTransactionReceipt(args: { hash: Hex }): Promise<{ status: string; logs: Log[]; blockNumber: bigint }> }, hash: Hex) {
  for (let i = 0; i < 1200; i++) {
    try { return await client.getTransactionReceipt({ hash }); } catch { await new Promise(r => setTimeout(r, 50)); }
  }
  throw new Error('no receipt for ' + hash);
}
function setup() {
  const v2 = strategyEarnV2(97, {})!;
  const transport = http(rpc, { timeout: 120_000 });
  const client = createPublicClient({ chain: bscTestnet, transport, pollingInterval: 100 });
  const local = createTestClient({ chain: bscTestnet, mode: 'anvil', transport });
  // The reader stamps a market read with its clock; here that is the fork's block time (the test moves time forward).
  let clock = Date.now();
  const reader = createV2Reader({ v2, multicall: v2Multicall(client), marketTtlMs: 0, bookTtlMs: 600_000, now: () => clock });
  const from = async (who: Address) => { await local.impersonateAccount({ address: who }); await local.setBalance({ address: who, value: parseEther('1') }); return createWalletClient({ chain: bscTestnet, account: who, transport }); };
  // One "UserOp" = the calls in order from the sender; logs re-indexed as if in one transaction.
  const sender = (who: Address) => async (calls: Call[]): Promise<V2Tx> => {
    const wallet = await from(who);
    const logs: Log[] = []; let last: Hex = '0x', block = 0n;
    for (const c of calls) {
      mark(`  send ${who.slice(0, 8)} -> ${c.to.slice(0, 10)} ${c.data.slice(0, 10)}`);
      const hash = await wallet.sendTransaction({ to: c.to, data: c.data, gas: 12_000_000n });
      const r = await mined(client, hash);
      if (r.status !== 'success') throw new Error(`reverted ${c.to} ${c.data.slice(0, 10)}`);
      for (const l of r.logs) logs.push({ ...l, logIndex: logs.length });
      last = hash; block = r.blockNumber;
    }
    return { hash: last, blockNumber: block, logs };
  };
  const routes: RouteEvent[] = [], rewards: RewardEvent[] = [];
  const ledger: V2Ledger = { routes: async (_c, e) => { routes.push(...e); }, rewards: async (_c, e) => { rewards.push(...e); } };
  const now = async () => { clock = Number((await client.getBlock()).timestamp) * 1000; return new Date(clock); };
  return { v2, client, local, reader, from, sender, ledger, routes, rewards, now, clock: () => new Date(clock) };
}
const names = (calls: readonly Call[], v2: { executor: Address }) => calls.map(c => c.to === v2.executor ? decodeFunctionData({ abi: V2_EXECUTOR_ABI, data: c.data }).functionName : c.to);

test('routing v2 fork: consent -> open on the best route -> hold -> vault left on a 0% vault is switched back -> rewards box -> account -> rate report -> deleverage at the health line -> repay before a sale -> full exit', { skip }, async () => {
  const s = setup(), { v2, reader, client } = s;
  assert.equal(await client.getChainId(), 97);
  const send = s.sender(A);
  const api = createStrategyEarnV2Api({ v2, reader, now: s.clock, recordRoutes: s.ledger.routes, recordRewards: s.ledger.rewards });
  const step = async (o: object = {}) => ({ v2, reader, account: A, portfolioId: 1, now: await s.now(), dryRun: false, send, ledger: s.ledger, log: (l: string) => lines.push(l), held: [NVDAB], ...o });
  const lines: string[] = [];

  // Market: 66 routes and 10 vaults discovered from the registry; nothing hard-coded.
  const m = await reader.market();
  assert.deepEqual([m.routes.length, m.vaults.length], [66, 10]);
  assert.ok((m.snapshot.options.NVDAB ?? []).length === 8, 'NVDAB: 4 Venus + 4 Lista routes');
  // Start clean: nothing on v2 for this account (the deployment drill closed everything).
  let read = await reader.account(A, [NVDAB]);
  assert.deepEqual([read.routes.length, read.vaults.length], [0, 0]);
  const held = read.state.holdings.find(h => h.collateral === NVDAB)!;
  assert.ok(held.freeCollateralRaw > 0n && held.collateralUsd > 100, 'demo account holds NVDAB');

  mark('consent');
  // 1. Owner consent (buy confirmation with Earn extra on): policy + both venues + approvals to the v2 executor only.
  const auto = await api.auto(A, OWNER, { budgetRaw: 0n, weights: [{ asset: NVDAB, weightBps: 10_000 }], keyReady: true });
  assert.equal(auto.status, 'ready');
  if (auto.status !== 'ready') return;
  await send(auto.calls);
  mark('consent sent');
  read = await reader.account(A, [NVDAB]);
  assert.deepEqual([read.consent, read.policy.rewardRecipient], [true, OWNER]);
  assert.equal((await api.portfolio(1, A)).autoOpen, true);

  mark('auto-open');
  // 2. Scheduler round after the fill: the engine picks today's best route and the session key opens it (one executeOpen).
  const opened = await v2AutoRound(await step());
  assert.match(opened ?? '', /已執行：NVDAB open\(best_route\)/);
  read = await reader.account(A, [NVDAB]);
  assert.equal(read.routes.length, 1);
  const pos = read.routes[0]!;
  // Lista NVDAB/USD1 pays the most on chain 97 (borrow 1.8% − 0.5%, vault 3.6% + 1.0%, collateral +1.0%).
  assert.deepEqual([pos.route.venue, pos.route.loanSymbol, pos.vault?.venue], ['lista', 'USD1', 'lista']);
  assert.ok(pos.collateralRaw === held.freeCollateralRaw && pos.routeDebtRaw > 0n && pos.ltvBps > 2800 && pos.ltvBps <= pos.targetLtvBps, `ltv ${pos.ltvBps}`);
  assert.deepEqual(s.routes.map(e => [e.kind, e.asset, e.venue, e.loan, e.vaultVenue, e.reason]), [['open', 'NVDAB', 'lista', 'USD1', 'lista', 'best_route']]);
  // The posted shares are still the portfolio's holding (snapshot), and the API shows the route it is really on.
  assert.deepEqual((await readStrategyEarnV2Collateral(client as never, A, await client.getBlockNumber())).map(c => [c.asset, c.amount]), [[NVDAB, pos.collateralRaw]]);
  const view = await api.portfolio(1, A);
  assert.deepEqual([view.positions.length, view.positions[0]!.asset, view.positions[0]!.route.source, view.positions[0]!.route.loan, view.autoOpen], [1, 'NVDAB', 'onchain', 'USD1', false]);
  mark('hold');
  // 3. Next round: nothing to do (2% under the target is not worth a top-up; no better route).
  assert.equal(await v2AutoRound(await step()), null);

  mark('vault switch');
  // 4. The money ends up in a vault that pays nothing (Venus vUSD1 at 0%: an owner switch, as in the deployment drill).
  //    Carry is now negative -> the next round moves the vault back at once, no 7-day wait (settled rule: negative carry is immediate).
  const venusVault = m.vaults.find(v => v.venue === 'venus' && v.tokenSymbol === 'USD1')!;
  await send([v2Calls.switchVault(v2, A, pos.vault!.vaultId, venusVault.vaultId, maxUint256, BigInt(Math.floor((await s.now()).getTime() / 1000) + 600))]);
  assert.equal((await reader.account(A, [NVDAB])).routes[0]!.vault!.vaultId, venusVault.vaultId);
  const moved = await v2AutoRound(await step());
  assert.match(moved ?? '', /NVDAB migrate\(negative_carry\)/);
  read = await reader.account(A, [NVDAB]);
  assert.equal(read.routes[0]!.vault!.venue, 'lista');
  assert.equal(s.routes.at(-1)!.kind, 'switch_vault');

  mark('rewards');
  // 5. Rewards: the simulated earn vault pays LISTA to the strategy box; the keeper moves it into the account (collectRewards).
  await s.local.increaseTime({ seconds: 30 * 86_400 }); await s.local.mine({ blocks: 1 });
  const keeper = s.sender(KEEPER);
  const k1 = await runV2KeeperRound({ dryRun: false, log: l => lines.push(l) }, { v2, reader, ledger: s.ledger, send: async (to, data) => keeper([{ to, data, value: '0' }]),
    accounts: async () => [{ account: A, portfolioId: 1, owner: OWNER }] });
  assert.ok(k1.collected === 1 && k1.failed === 0, JSON.stringify(k1) + lines.slice(-3).join('|'));
  read = await reader.account(A, [NVDAB]);
  assert.ok(read.rewards[0]!.accountRaw > 0n && read.rewards[0]!.boxRaw === 0n, 'LISTA is in the account, not the box');
  assert.ok(s.rewards.some(e => e.kind === 'claim' && e.holder === read.box));

  mark('rate report');
  // 6. Rate report (operator = registry.rateReporter): due once the stored report is 12 hours old; values read off the mocks.
  const multicall = v2Multicall(client);
  const operator = s.sender(OPERATOR);
  const report = () => runRateReport({ v2, reader, multicall, now: () => Number(0), rates: book => fromTestnetMocks(v2, book, multicall),
    signer: { address: OPERATOR, send: async (to, data) => (await operator([{ to, data, value: '0' }])).hash } });
  const chainNow = (await s.now()).getTime();
  const r1 = await runRateReport({ v2, reader, multicall, now: () => chainNow, rates: book => fromTestnetMocks(v2, book, multicall), signer: { address: OPERATOR, send: async (to, data) => (await operator([{ to, data, value: '0' }])).hash } });
  assert.deepEqual([r1.status, r1.status === 'sent' ? [r1.routes, r1.vaults] : null], ['sent', [66, 4]]);
  const r2 = await runRateReport({ v2, reader, multicall, now: () => chainNow + 60_000, rates: book => fromTestnetMocks(v2, book, multicall), signer: { address: OPERATOR, send: async () => { throw new Error('must not send'); } } });
  assert.deepEqual(r2, { status: 'skipped', reason: 'fresh' });
  const wrong = await runRateReport({ v2, reader, multicall, rates: book => fromTestnetMocks(v2, book, multicall), signer: { address: KEEPER, send: async () => { throw new Error('must not send'); } } });
  assert.match(wrong.status === 'skipped' ? wrong.reason : '', /rateReporter is/);
  void report; void reportCalldata; void reportDue;

  mark('deleverage');
  // 7. Health line: the owner tightens this route's lines (as in the deployment drill; the shared oracle is not touched).
  //    The venue says shouldDeleverage -> the keeper sends executeDeleverage, anyone-callable, from the box's vault.
  const registryOwner = await s.from(OWNER);
  const lineAbi = parseAbi(['function setLtvConfig(bytes32 routeId, uint256 target, uint256 deleverage)']);
  await mined(client, await registryOwner.writeContract({ address: v2.registry, abi: lineAbi, functionName: 'setLtvConfig', args: [pos.route.routeId, 10n ** 17n, 2n * 10n ** 17n] }));
  const before = (await reader.account(A, [NVDAB])).routes[0]!;
  assert.equal(before.shouldDeleverage, true);
  const k2 = await runV2KeeperRound({ dryRun: false, log: l => lines.push(l) }, { v2, reader, ledger: s.ledger, send: async (to, data) => keeper([{ to, data, value: '0' }]),
    accounts: async () => [{ account: A, portfolioId: 1, owner: OWNER }] });
  assert.equal(k2.deleveraged, 1, lines.slice(-3).join('|'));
  const after = (await reader.account(A, [NVDAB])).routes[0]!;
  assert.ok(after.routeDebtRaw < before.routeDebtRaw && !after.shouldDeleverage && after.ltvBps <= 1010, `ltv ${after.ltvBps}`);
  assert.deepEqual([s.routes.at(-1)!.kind, s.routes.at(-1)!.reason], ['deleverage', 'safety_line']);
  await mined(client, await registryOwner.writeContract({ address: v2.registry, abi: lineAbi, functionName: 'setLtvConfig', args: [pos.route.routeId, 0n, 0n] }));

  mark('pre-sell');
  // 8. Before a sale of the posted shares: repay first, take them back (session key); the sale waits a round.
  const selling = await v2UnwindForSale({ ...await step(), steps: [{ tokenIn: NVDAB, amountIn: held.freeCollateralRaw }] });
  assert.match(selling ?? '', /\[STRATEGY_EARN_UNWINDING\] 賣出前已還款取回：NVDAB/);
  read = await reader.account(A, [NVDAB]);
  assert.equal(read.routes.filter(r => r.collateralRaw > 0n || r.routeDebtRaw > 0n).length, 0);
  assert.equal(read.state.holdings.find(h => h.collateral === NVDAB)!.freeCollateralRaw, held.freeCollateralRaw, 'every share is back in the account');
  assert.equal(s.routes.at(-1)!.kind, 'close');
  // The surplus interest came back in the loan token (USD1): not the portfolio's cash token, so it is a swap need.
  const needs = loanTokenNeeds(read, v2.loanTokens.USDT!);
  assert.ok(needs.some(n => n.symbol === 'USD1' && n.kind === 'dust') && needs.every(n => n.kind === 'dust' && n.symbol !== 'USDT'), JSON.stringify(needs.map(n => [n.symbol, n.kind])));

  mark('exit');
  // 9. Consent is still on: the next quiet round opens again. Then the owner turns everything off as a full exit:
  //    close + rewards to the owner's wallet + consent withdrawn, in the UserOps the API cuts.
  assert.match(await v2AutoRound(await step()) ?? '', /NVDAB open\(best_route\)/);
  const ownerLista = async () => client.readContract({ address: v2.rewardTokens[0]!, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [OWNER] });
  const listaBefore = await ownerLista();
  await s.now();
  const off = await api.close(A, { symbols: ['NVDAB'], exit: true });
  assert.equal(off.status, 'ready');
  assert.deepEqual(names(off.calls, v2), ['executeReduce', 'executeSweepRewards', v2.registry]);
  for (const batch of off.batches) { const tx = await send(batch); await api.confirm(1, A, OWNER, tx); }
  read = await reader.account(A, [NVDAB]);
  assert.deepEqual([read.routes.filter(r => r.collateralRaw > 0n).length, read.consent, read.rewards[0]!.accountRaw, read.rewards[0]!.boxRaw], [0, false, 0n, 0n]);
  assert.ok(await ownerLista() > listaBefore, 'reward tokens reached the owner\'s wallet');
  assert.ok(s.rewards.some(e => e.kind === 'sweep' && e.recipient === OWNER));
  assert.equal(await api.active(A), false);
  assert.equal(await v2AutoRound(await step()), null, 'consent withdrawn: the scheduler leaves the account alone');
  console.log(JSON.stringify({ routes: s.routes.map(e => `${e.kind}:${e.reason ?? 'owner'}`), rewards: s.rewards.map(e => `${e.kind}:${e.amountRaw}`), lines: lines.length }));
});

test('routing v2 fork: an urgent move to another borrow market is one executeMigrate; executeRescue hands the box\'s receipts back only once the token is no longer owed', { skip }, async () => {
  const s = setup(), { v2, reader } = s;
  const send = s.sender(A);
  const api = createStrategyEarnV2Api({ v2, reader, now: s.clock });
  const lines: string[] = [];
  const step = async () => ({ v2, reader, account: A, portfolioId: 1, now: await s.now(), dryRun: false, send, ledger: s.ledger, log: (l: string) => lines.push(l), held: [NVDAB] });
  const deadline = async () => BigInt(Math.floor((await s.now()).getTime() / 1000) + 600);
  const m = await reader.market();
  const auto = await api.auto(A, OWNER, { budgetRaw: 0n, weights: [{ asset: NVDAB, weightBps: 10_000 }], keyReady: true });
  if (auto.status !== 'ready') throw new Error('consent unavailable');
  await send(auto.calls);
  // The owner opens on a route that is NOT the best one (Venus NVDAB/USDT into Aave), then its vault goes to 0% (vUSDT).
  const route = m.routes.find(r => r.symbol === 'NVDAB' && r.venue === 'venus' && r.loanSymbol === 'USDT')!;
  const aave = m.vaults.find(v => v.venue === 'aave' && v.tokenSymbol === 'USDT')!, vUsdt = m.vaults.find(v => v.venue === 'venus' && v.tokenSymbol === 'USDT')!;
  const read0 = await reader.account(A, [NVDAB]);
  const free = read0.state.holdings.find(h => h.collateral === NVDAB)!;
  const borrow = BigInt(Math.floor(free.collateralUsd * 0.25)) * 10n ** 18n;
  await send([v2Calls.open(v2, A, route.routeId, aave.vaultId, free.freeCollateralRaw, borrow, await deadline())]);
  await send([v2Calls.switchVault(v2, A, aave.vaultId, vUsdt.vaultId, maxUint256, await deadline())]);
  // Negative carry on Venus/USDT -> the best route overall is on Lista in another loan token: one atomic executeMigrate
  // (the old USDT debt is repaid from the USDT vault plus the account's own USDT, the new token is borrowed into its vault).
  const moved = await v2AutoRound(await step());
  assert.match(moved ?? '', /NVDAB migrate\(negative_carry\)/, lines.join('|'));
  let read = await reader.account(A, [NVDAB]);
  const open = read.routes.filter(r => r.collateralRaw > 0n);
  assert.deepEqual(open.map(r => [r.route.venue, r.route.loanSymbol]), [['lista', 'USD1']]);
  assert.deepEqual(s.routes.filter(e => e.kind === 'migrate').map(e => [e.venue, e.loan, e.reason]), [['lista', 'USD1', 'negative_carry']]);

  // Rescue (owner only): refused while USD1 is owed, works once the route is repaid; the receipts land in the account.
  const vault = open[0]!.vault!;
  assert.deepEqual(await api.rescue(A, vault.vaultId), { status: 'unavailable', reason: 'debt_outstanding', message: 'Temporarily unavailable.' });
  await assert.rejects(send([v2RescueCall(v2, A, vault.vaultId, await deadline())]));
  // Repay the debt from the account's own USD1 only (the vault holding stays in the box), then rescue.
  const usd1 = v2.loanTokens.USD1!, tokenAbi = parseAbi(['function mint(address to, uint256 amount)', 'function balanceOf(address) view returns (uint256)']);
  const minter = await s.from(OWNER);
  await mined(s.client, await minter.writeContract({ address: usd1, abi: tokenAbi, functionName: 'mint', args: [A, open[0]!.routeDebtRaw * 2n], gas: 500_000n }));
  read = await reader.account(A, [NVDAB]);
  assert.ok(read.tokens.USD1!.cashRaw > open[0]!.routeDebtRaw, 'the fork owner could mint test USD1');
  await send([v2Calls.reduce(v2, A, open[0]!.route.routeId, ('0x' + '00'.repeat(32)) as Hex, maxUint256, maxUint256, read.tokens.USD1!.cashRaw, await deadline())]);
  read = await reader.account(A, [NVDAB]);
  const boxHolding = read.vaults.find(v => v.vault.vaultId === vault.vaultId);
  assert.ok(boxHolding && boxHolding.assetsRaw > 0n, 'the vault holding is still in the box');
  await s.now();
  const rescue = await api.rescue(A, vault.vaultId);
  assert.equal(rescue.status, 'ready');
  if (rescue.status === 'ready') await send(rescue.calls);
  assert.ok(await s.client.readContract({ address: vault.receipt, abi: tokenAbi, functionName: 'balanceOf', args: [A] }) > 0n, 'the vault shares are the account\'s now');
  assert.equal((await reader.account(A, [NVDAB])).vaults.length, 0);
});

test('routing v2 fork: the deployed CallPolicy (0.0.4) enforces the v2 session scope — six functions, account pinned, v2 executor only, never executeRescue', { skip }, async () => {
  const { toCallPolicy, CallPolicyVersion } = await import('@zerodev/permissions/policies');
  const { encodeCallDataEpV07 } = await import('@zerodev/sdk');
  const { sessionCallPermissions } = await import('../src/permissions.js');
  const s = setup(), { v2, client } = s;
  const wallet = '0x' + '5b'.repeat(20) as Address; // any wallet: CallPolicy state is per (id, msg.sender)
  const w = await s.from(wallet);
  // The whole scope a canary account's renewal installs: plain + yield + v1 borrow + routing v2.
  const policy = toCallPolicy({ policyAddress: T.contracts.callPolicy as Address, policyVersion: CallPolicyVersion.V0_0_4,
    permissions: sessionCallPermissions(T.contracts.executor as Address, wallet, wallet, undefined, { executor: v2.executor, account: wallet }) });
  const id = pad(`0x${Date.now().toString(16).slice(-8).padStart(8, '0')}`, { size: 32, dir: 'right' });
  const abi = parseAbi(['function onInstall(bytes data) payable',
    'struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }',
    'function checkUserOpPolicy(bytes32 id, PackedUserOperation userOp) payable returns (uint256)']);
  const r = await mined(client, await w.writeContract({ address: T.contracts.callPolicy as Address, abi, functionName: 'onInstall', args: [concatHex([id, policy.getPolicyData()])], gas: 6_000_000n }));
  assert.equal(r.status, 'success');
  const check = async (calls: { to: Address; data: Hex }[]) => {
    const callData = await encodeCallDataEpV07(calls.map(c => ({ to: c.to, data: c.data, value: 0n })));
    try {
      const { result } = await client.simulateContract({ account: wallet, address: T.contracts.callPolicy as Address, abi, functionName: 'checkUserOpPolicy',
        args: [id, { sender: wallet, nonce: 0n, initCode: '0x', callData, accountGasLimits: pad('0x', { size: 32 }), preVerificationGas: 0n, gasFees: pad('0x', { size: 32 }), paymasterAndData: '0x', signature: '0x' }] });
      return result === 0n ? 'ok' : 'denied';
    } catch { return 'denied'; }
  };
  const R = ('0x' + 'a1'.repeat(32)) as Hex, V = ('0x' + 'b1'.repeat(32)) as Hex, D = 2_000_000_000n, other = '0x' + '66'.repeat(20) as Address;
  const lista = v2.rewardTokens[0]!;
  const six = (who: Address): [string, Call][] => [['executeOpen', v2Calls.open(v2, who, R, V, 1n, 1n, D)], ['executeReduce', v2Calls.reduce(v2, who, R, V, 1n, 1n, 0n, D)],
    ['executeMigrate', v2Calls.migrate(v2, who, { routeId: R, vaultId: V }, { routeId: V, vaultId: R }, 1n, 0n, D)], ['executeSwitchVault', v2Calls.switchVault(v2, who, V, R, 1n, D)],
    ['executeRelease', v2Calls.release(v2, who, V, D)], ['executeSweepRewards', v2Calls.sweepRewards(v2, who, lista, 0n, D)]];
  assert.deepEqual(v2SessionPermissions(v2.executor, wallet).map(p => p.selector), six(wallet).map(([, c]) => c.data.slice(0, 10)));
  for (const [name, call] of six(wallet)) assert.equal(await check([call]), 'ok', name);
  // Three markets in one UserOp (the scheduler's batch size), and a mixed exit batch.
  assert.equal(await check([v2Calls.open(v2, wallet, R, V, 1n, 1n, D), v2Calls.open(v2, wallet, V, V, 1n, 1n, D), v2Calls.open(v2, wallet, R, R, 1n, 1n, D)]), 'ok');
  assert.equal(await check([v2Calls.close(v2, wallet, R, V, 0n, D), v2Calls.release(v2, wallet, V, D), v2Calls.sweepRewards(v2, wallet, lista, maxUint256, D)]), 'ok');
  // Another account in argument 0: every one of the six is refused.
  for (const [name, call] of six(other)) assert.equal(await check([call]), 'denied', name + ' for another account');
  // Owner-only and anyone-callable entry points, the registry, the venues, approvals, and the same selectors on another contract.
  assert.equal(await check([v2RescueCall(v2, wallet, V, D)]), 'denied', 'executeRescue');
  assert.equal(await check([v2Calls.open(v2, wallet, R, V, 1n, 1n, D), v2RescueCall(v2, wallet, V, D)]), 'denied', 'executeRescue after an allowed call');
  assert.equal(await check([v2Calls.deleverage(v2, wallet, R, V)]), 'denied', 'executeDeleverage');
  assert.equal(await check([v2Calls.collectRewards(v2, wallet, lista)]), 'denied', 'collectRewards');
  assert.equal(await check([{ to: v2.registry, data: encodeFunctionData({ abi: V2_REGISTRY_ABI, functionName: 'setStrategyPolicy', args: [1n, wallet, true] }) }]), 'denied', 'setStrategyPolicy');
  assert.equal(await check([{ to: v2.venusComptroller, data: encodeFunctionData({ abi: parseAbi(['function updateDelegate(address,bool)']), functionName: 'updateDelegate', args: [v2.executor, true] }) }]), 'denied');
  assert.equal(await check([{ to: v2.moolah, data: encodeFunctionData({ abi: parseAbi(['function setAuthorization(address,bool)']), functionName: 'setAuthorization', args: [v2.executor, true] }) }]), 'denied');
  assert.equal(await check([{ to: lista, data: encodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), functionName: 'approve', args: [v2.executor, maxUint256] }) }]), 'denied', 'approve');
  assert.equal(await check([{ ...v2Calls.open(v2, wallet, R, V, 1n, 1n, D), to: T.contracts.executor as Address }]), 'denied', 'v2 selector on AtpExecutor');
  assert.equal(await check([{ ...v2Calls.open(v2, wallet, R, V, 1n, 1n, D), to: v2.registry }]), 'denied', 'v2 selector on the registry');
  assert.ok(!v2SessionPermissions(v2.executor, wallet).some(p => p.selector === toFunctionSelector('executeRescue(address,bytes32,uint256)')));
});
