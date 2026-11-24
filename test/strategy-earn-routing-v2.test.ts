import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, stringToHex, maxUint256, toFunctionSelector, zeroAddress } from 'viem';
import type { Abi, AbiEvent, AbiFunction, Address, Hex, Log } from 'viem';
import { formatAbiItem } from 'viem/utils';
import { describePolicies, sessionCallPermissions } from '../src/permissions.js';
import type { Decision, PricedRoute, RouteKey } from '../src/strategy-earn-routing.js';
import { boxRewardSignature, maxDebtFor, planExecution, routeIdOf, routeIds, strategyEarnV2, V2_EVENTS_ABI, V2_EXECUTOR_ABI, V2_INTERFACE_VERSION, V2_REGISTRY_ABI, V2_SESSION_SELECTORS,
  routeMessage, runV2Account, v2Authorized, v2RouteEvents, v2Calls, v2ConsentCalls, v2ExitCalls, v2PreSellCalls, v2RateReport, v2SessionPermissions, vaultIdOf } from '../src/strategy-earn-v2.js';
import type { Call, PositionState, StrategyEarnV2, V2Holding } from '../src/strategy-earn-v2.js';
import { v2ExitBatches, v2PreSellBatches } from '../src/strategy-earn-v2.js';
import type { RouteOption, RoutingSnapshot, RoutingVault } from '../src/strategy-earn-mainnet.js';

const A = (n: number) => ('0x' + n.toString(16).padStart(40, '0')) as Address;
const account = A(0x55), owner = A(0x66), QQQ = A(0x71), NVDA = A(0x72), LISTA = A(0x91), XVS = A(0x92);
const V2: StrategyEarnV2 = { chainId: 56, executor: A(0xe2), registry: A(0xe3), venusComptroller: A(0xe4), moolah: A(0xe5), loanTokens: { USDT: A(0xa1), USDC: A(0xa2) }, rewardTokens: [LISTA, XVS] };
const MANIFEST = JSON.stringify({ chainId: 56, executor: V2.executor, registry: V2.registry, venusComptroller: V2.venusComptroller, moolah: V2.moolah, loanTokens: V2.loanTokens, rewardTokens: V2.rewardTokens });
const LISTA_MARKET = ('0x' + '1a'.repeat(32)) as Hex, LISTA_MARKET_2 = ('0x' + '2b'.repeat(32)) as Hex;
const listaUsdc: RouteKey = { venue: 'lista', marketId: LISTA_MARKET, loan: 'USDC', vault: { venue: 'lista', address: A(0xb1) } };
const listaUsdt: RouteKey = { venue: 'lista', marketId: LISTA_MARKET_2, loan: 'USDT', vault: { venue: 'venus', address: A(0xb2) } };
const venusUsdt: RouteKey = { venue: 'venus', marketId: A(0xb2), loan: 'USDT', vault: { venue: 'aave', address: A(0xb3) } };
const priced = (r: RouteKey): PricedRoute => ({ ...r, ratioBps: 3000, factorBps: 7500, borrowApyBps: 200, borrowIncentiveBps: 54, vaultApyBps: 500, vaultName: 'v', carryBps: 354, collateralIncentiveBps: 25, extraBps: 131, liquidityUsd: 1e6 });
const decision = (symbol: string, action: Decision['action'], reason: Decision['reason'], from: RouteKey | null, to: RouteKey | null, targetDebtUsd: number): Decision =>
  ({ symbol, action, reason, urgent: false, from, to: to && priced(to), targetDebtUsd, rationale: `${symbol} ${action}` });
const E = 10n ** 18n, DEADLINE = 1_800_000_600n;
const decode = (data: Hex) => decodeFunctionData({ abi: V2_EXECUTOR_ABI, data });
const state = (symbol: string, collateral: Address, o: Partial<PositionState> = {}): PositionState => ({ symbol, collateral, freeCollateralRaw: 0n, ...o });
const plan = (decisions: Decision[], positions: PositionState[], o: { ceiling?: bigint; principal?: bigint } = {}) =>
  planExecution({ v2: V2, account, decisions, positions, deadline: DEADLINE, policyMaxDebtUsdRaw: o.ceiling ?? 1_000_000n * E, principalUsdRaw: o.principal ?? 0n });

test('v2 is off unless a deployment is configured for this chain; a malformed manifest never yields a usable config', () => {
  assert.equal(strategyEarnV2(56, {}), null);
  assert.equal(strategyEarnV2(97, {}), null);
  assert.equal(strategyEarnV2(97, { STRATEGY_EARN_V2_DEPLOYMENT: MANIFEST }), null); // deployment is for another chain
  assert.deepEqual(strategyEarnV2(56, { STRATEGY_EARN_V2_DEPLOYMENT: MANIFEST }), V2);
  for (const bad of ['{', JSON.stringify({ ...JSON.parse(MANIFEST), executor: '0x12' }), JSON.stringify({ ...JSON.parse(MANIFEST), registry: zeroAddress }),
    JSON.stringify({ ...JSON.parse(MANIFEST), loanTokens: {} }), JSON.stringify({ ...JSON.parse(MANIFEST), loanTokens: { DAI: A(1) } })]) {
    assert.throws(() => strategyEarnV2(56, { STRATEGY_EARN_V2_DEPLOYMENT: bad }));
  }
});

test('every function and event this module encodes exists in the contracts interface file, and the session scope is the spec list', () => {
  const spec = JSON.parse(readFileSync(new URL('./fixtures/borrow-routing-v2.signatures.json', import.meta.url), 'utf8')) as
    { interfaceVersion: string; functions: Record<string, string[]>; events: Record<string, string[]> };
  assert.equal(spec.interfaceVersion, V2_INTERFACE_VERSION);
  const sig = (item: Abi[number]) => formatAbiItem(item as AbiFunction).replace(/^(function|event) /, '').replace(/ returns.*$/, '').replace(/\s+\w+(?=[,)])/g, '').replace(/ indexed/g, '').replace(/, /g, ',');
  const plain = (s: string) => s.replace(/\s/g, '');
  for (const item of V2_EXECUTOR_ABI) assert.ok(spec.functions.AtpBorrowExecutorV2!.map(plain).includes(plain(sig(item))), 'executor: ' + sig(item));
  for (const item of V2_REGISTRY_ABI) if (item.type === 'function') assert.ok(spec.functions.AtpBorrowRegistryV2!.map(plain).includes(plain(sig(item))), 'registry: ' + sig(item));
  for (const item of V2_EVENTS_ABI) assert.ok(spec.events.AtpBorrowExecutorV2!.map(plain).includes(plain(sig(item))), 'event: ' + sig(item));
  const names = V2_SESSION_SELECTORS.map(s => V2_EXECUTOR_ABI.find(f => f.type === 'function' && toFunctionSelector(f) === s)!.name);
  assert.deepEqual(names, ['executeOpen', 'executeReduce', 'executeMigrate', 'executeSwitchVault', 'executeRelease', 'executeSweepRewards']); // executeDeleverage is anyone-callable
});

test('ids follow spec §3: route = keccak(venue, collateral, loan, listaId), vault = keccak(kind, token, target)', () => {
  const route = [{ type: 'uint8' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }] as const, vault = [{ type: 'uint8' }, { type: 'address' }, { type: 'address' }] as const;
  assert.equal(routeIdOf('lista', QQQ, V2.loanTokens.USDC!, LISTA_MARKET), keccak256(encodeAbiParameters(route, [2, QQQ, V2.loanTokens.USDC!, LISTA_MARKET])));
  assert.equal(routeIdOf('venus', NVDA, V2.loanTokens.USDT!, ('0x' + 'ff'.repeat(32)) as Hex), keccak256(encodeAbiParameters(route, [1, NVDA, V2.loanTokens.USDT!, ('0x' + '00'.repeat(32)) as Hex]))); // Venus: listaId is zero
  assert.deepEqual([vaultIdOf('lista', A(1), A(2)), vaultIdOf('venus', A(1), A(2)), vaultIdOf('aave', A(1), A(2))], [1, 2, 3].map(kind => keccak256(encodeAbiParameters(vault, [kind, A(1), A(2)]))));
  const ids = routeIds(V2, QQQ, listaUsdc);
  assert.deepEqual(ids, { loanToken: V2.loanTokens.USDC, routeId: routeIdOf('lista', QQQ, V2.loanTokens.USDC!, LISTA_MARKET), vaultId: vaultIdOf('lista', V2.loanTokens.USDC!, A(0xb1)) });
  assert.throws(() => routeIds(V2, QQQ, { ...listaUsdc, loan: 'U' }), /not on the v2 allowlist/); // U is not allowlisted in this deployment
});

test('consent: one account-level ceiling in USD for every loan token, delegations only for the venues used, approvals only to the v2 executor', () => {
  const calls = v2ConsentCalls(V2, { maxDebtUsdRaw: maxDebtFor(6500), rewardRecipient: owner, venues: ['lista'], collaterals: [QQQ, NVDA, QQQ], loanTokens: [V2.loanTokens.USDC!] });
  assert.deepEqual(calls.map(c => c.to), [V2.moolah, V2.registry, QQQ, NVDA, V2.loanTokens.USDC]);
  assert.deepEqual(decodeFunctionData({ abi: V2_REGISTRY_ABI, data: calls[1]!.data }).args, [7150n * E, owner, true]); // 6,500 + 10%
  assert.equal(v2ConsentCalls(V2, { maxDebtUsdRaw: 1n, rewardRecipient: owner, venues: ['venus', 'lista'], collaterals: [] })[0]!.to, V2.venusComptroller);
  assert.throws(() => v2ConsentCalls(V2, { maxDebtUsdRaw: 0n, rewardRecipient: owner, venues: [], collaterals: [] }));
});

test('planner: open posts the free collateral and borrows 98% of the target; a top-up borrows only the difference', () => {
  const ids = routeIds(V2, QQQ, listaUsdc);
  let p = plan([decision('QQQB', 'open', 'best_route', null, listaUsdc, 3500)], [state('QQQB', QQQ, { freeCollateralRaw: 20n * E })]);
  assert.deepEqual([p.steps.length, p.steps[0]!.via, p.steps[0]!.calls[0]!.to], [1, 'session', V2.executor]);
  assert.deepEqual(decode(p.steps[0]!.calls[0]!.data), { functionName: 'executeOpen', args: [account, ids.routeId, ids.vaultId, 20n * E, 3430n * E, DEADLINE] });
  assert.deepEqual([p.plannedDebtUsd, p.consentShort], [3500, false]);
  p = plan([decision('QQQB', 'open', 'top_up', listaUsdc, listaUsdc, 6000)], [state('QQQB', QQQ, { freeCollateralRaw: 5n * E, routeDebtRaw: 3000n * E })], { principal: 3000n * E });
  assert.deepEqual((decode(p.steps[0]!.calls[0]!.data).args as readonly unknown[]).slice(3, 5), [5n * E, 2880n * E]); // 6,000 × 98% − 3,000
});

test('planner: the owner ceiling caps new borrowing instead of sending a call that reverts; nothing left -> skipped, re-consent flagged', () => {
  let p = plan([decision('QQQB', 'open', 'best_route', null, listaUsdc, 3500)], [state('QQQB', QQQ, { freeCollateralRaw: 20n * E })], { ceiling: 5000n * E, principal: 4000n * E });
  assert.deepEqual([(decode(p.steps[0]!.calls[0]!.data).args as readonly unknown[])[4], p.consentShort], [1000n * E, true]);
  p = plan([decision('QQQB', 'open', 'top_up', listaUsdc, listaUsdc, 6000)], [state('QQQB', QQQ, { routeDebtRaw: 3000n * E })], { ceiling: 3000n * E, principal: 3000n * E });
  assert.deepEqual([p.steps[0]!.calls.length, p.steps[0]!.skipped, p.consentShort], [0, 'debt ceiling reached', true]);
  // A close in the same plan frees ceiling for an open (exits are planned first).
  p = plan([decision('QQQB', 'open', 'best_route', null, listaUsdc, 3000), decision('NVDAB', 'close', 'negative_carry', venusUsdt, null, 0)],
    [state('QQQB', QQQ, { freeCollateralRaw: E }), state('NVDAB', NVDA, { routeDebtRaw: 2500n * E })], { ceiling: 3000n * E, principal: 2500n * E });
  assert.deepEqual(p.steps.map(s => [s.symbol, s.action, decode(s.calls[0]!.data).functionName]), [['NVDAB', 'close', 'executeReduce'], ['QQQB', 'open', 'executeOpen']]);
  assert.equal((decode(p.steps[1]!.calls[0]!.data).args as readonly unknown[])[4], 2940n * E); // full 98% of 3,000: the close freed the room
});

test('planner: migrate is one atomic call with the two-step path ready; vault-only is executeSwitchVault', () => {
  const from = routeIds(V2, QQQ, listaUsdt), to = routeIds(V2, QQQ, listaUsdc);
  const p = plan([decision('QQQB', 'migrate', 'better_route', listaUsdt, listaUsdc, 3000)], [state('QQQB', QQQ, { routeDebtRaw: 2900n * E, cashRaw: 40n * E })], { principal: 2900n * E });
  const s = p.steps[0]!;
  assert.deepEqual(decode(s.calls[0]!.data), { functionName: 'executeMigrate', args: [account, from.routeId, from.vaultId, to.routeId, to.vaultId, 2940n * E, 40n * E, DEADLINE] });
  // VaultShortfall / gate closed reverts the whole call: close the old route (own cash allowed), then open the new one — two UserOps.
  assert.deepEqual(s.fallback!.map(batch => batch.map(c => decode(c.data).functionName)), [['executeReduce'], ['executeOpen']]);
  assert.deepEqual((decode(s.fallback![0]![0]!.data).args as readonly unknown[]).slice(1), [from.routeId, from.vaultId, maxUint256, maxUint256, 40n * E, DEADLINE]);
  assert.deepEqual((decode(s.fallback![1]![0]!.data).args as readonly unknown[]).slice(1, 5), [to.routeId, to.vaultId, maxUint256, 2940n * E]);
  // Same borrow market, better vault: no debt or collateral moves.
  const better: RouteKey = { ...listaUsdt, vault: { venue: 'lista', address: A(0xb9) } };
  const sw = plan([decision('QQQB', 'migrate', 'better_route', listaUsdt, better, 2900)], [state('QQQB', QQQ, { routeDebtRaw: 2900n * E })]).steps[0]!;
  assert.deepEqual(decode(sw.calls[0]!.data), { functionName: 'executeSwitchVault', args: [account, from.vaultId, vaultIdOf('lista', V2.loanTokens.USDT!, A(0xb9)), maxUint256, DEADLINE] });
  assert.equal(sw.fallback, undefined);
});

test('planner: close repays all and takes all collateral back; the safety line is the anyone-callable deleverage, sent by the keeper', () => {
  const ids = routeIds(V2, NVDA, venusUsdt);
  let p = plan([decision('NVDAB', 'close', 'negative_carry', venusUsdt, null, 0)], [state('NVDAB', NVDA, { routeDebtRaw: 900n * E, cashRaw: 3n * E })]);
  assert.deepEqual(decode(p.steps[0]!.calls[0]!.data), { functionName: 'executeReduce', args: [account, ids.routeId, ids.vaultId, maxUint256, maxUint256, 3n * E, DEADLINE] });
  p = plan([decision('NVDAB', 'reduce', 'safety_line', venusUsdt, venusUsdt, 600)], [state('NVDAB', NVDA, { routeDebtRaw: 900n * E })]);
  assert.deepEqual([p.steps[0]!.via, decode(p.steps[0]!.calls[0]!.data).functionName, (decode(p.steps[0]!.calls[0]!.data).args as readonly unknown[]).slice(0, 3)], ['keeper', 'executeDeleverage', [account, ids.routeId, ids.vaultId]]);
});

test('planner: Lista never leaves a loan under the venue minimum — a partial repayment that would becomes a full one', () => {
  const ids = routeIds(V2, QQQ, listaUsdc);
  const repay = (targetDebtUsd: number, route: RouteKey = listaUsdc) => (decode(plan([decision('QQQB', 'reduce', 'negative_carry', route, route, targetDebtUsd)],
    [state('QQQB', QQQ, { routeDebtRaw: 100n * E })]).steps[0]!.calls[0]!.data).args as readonly unknown[]).slice(1, 5);
  assert.deepEqual(repay(40), [ids.routeId, ids.vaultId, 60n * E, 0n]);
  assert.deepEqual(repay(14)[2], maxUint256); // would leave 14 < 15
  assert.equal(repay(14, venusUsdt)[2], 86n * E); // Venus has no such minimum
  assert.equal(plan([decision('QQQB', 'reduce', 'negative_carry', listaUsdc, listaUsdc, 200)], [state('QQQB', QQQ, { routeDebtRaw: 100n * E })]).steps[0]!.skipped, 'already at or under the target');
});

test('exit and pre-sell: Venus routes close one after another, leftovers are released, rewards swept, consent withdrawn last', () => {
  const a = routeIds(V2, NVDA, venusUsdt), b = routeIds(V2, QQQ, listaUsdc);
  const calls = v2ExitCalls(V2, account, { routes: [a, b], leftoverVaults: [a.vaultId], rewardTokens: [LISTA], deadline: DEADLINE, withdrawConsent: true });
  assert.deepEqual(calls.map(c => c.to === V2.registry ? 'setStrategyPolicy' : decode(c.data).functionName), ['executeReduce', 'executeReduce', 'executeRelease', 'executeSweepRewards', 'setStrategyPolicy']);
  assert.deepEqual(decodeFunctionData({ abi: V2_REGISTRY_ABI, data: calls[4]!.data }).args, [0n, zeroAddress, false]);
  assert.deepEqual(v2PreSellCalls(V2, account, [b], DEADLINE).map(c => decode(c.data)), [{ functionName: 'executeReduce', args: [account, b.routeId, b.vaultId, maxUint256, maxUint256, 0n, DEADLINE] }]);
});

test('session scope: six executor functions pinned to the account, appended after every v1 permission; older keys rebuild unchanged', () => {
  const executor = A(0xe1);
  const before = sessionCallPermissions(executor, account, account);
  const withV2 = sessionCallPermissions(executor, account, account, undefined, { executor: V2.executor, account });
  assert.deepEqual(withV2.slice(0, before.length), before);
  assert.deepEqual(withV2.slice(before.length), v2SessionPermissions(V2.executor, account));
  assert.ok(v2SessionPermissions(V2.executor, account).every(p => p.target === V2.executor && p.rules.length === 1 && p.rules[0]!.offset === 0));
  assert.deepEqual(sessionCallPermissions(executor, account, account, undefined, undefined), before);
  const snapshot = describePolicies({ executorAddress: executor, chainId: 97, validUntil: 1_900_000_000, yieldAccount: account, borrowAccount: account, routingV2: { executor: V2.executor, account } });
  assert.equal(v2Authorized(snapshot, account, V2.executor), true);
  assert.equal(v2Authorized(snapshot, A(0x77), V2.executor), false); // another account
  assert.equal(v2Authorized(snapshot, account, A(0xee)), false); // another executor
  assert.equal(v2Authorized(describePolicies({ executorAddress: executor, chainId: 97, validUntil: 1_900_000_000, yieldAccount: account, borrowAccount: account }), account, V2.executor), false);
  assert.equal(v2Authorized(null, account, V2.executor), false);
});

test('rate report: incentives per route and Lista vault rates only, deduplicated, clamped to the contract cap', () => {
  const call = v2RateReport(V2, [{ collateral: QQQ, route: priced(listaUsdc) }, { collateral: QQQ, route: priced(listaUsdc) }, { collateral: NVDA, route: { ...priced(venusUsdt), borrowIncentiveBps: 9000 } },
    { collateral: QQQ, route: priced({ ...listaUsdc, loan: 'U' }) }], [{ token: 'USDC', venue: 'lista', address: A(0xb1), baseBps: 141, incentiveBps: 354 }, { token: 'USDT', venue: 'venus', address: A(0xb2), baseBps: 352, incentiveBps: 0 }])!;
  assert.equal(call.to, V2.registry);
  const [routes, vaults] = decodeFunctionData({ abi: V2_REGISTRY_ABI, data: call.data }).args as readonly [readonly { routeId: Hex; borrowIncentive: bigint; collateralIncentive: bigint }[], readonly { vaultId: Hex; baseRate: bigint; incentive: bigint }[]];
  assert.deepEqual(routes.map(r => [r.routeId, r.borrowIncentive, r.collateralIncentive]), [[routeIds(V2, QQQ, listaUsdc).routeId, 54n * E / 10_000n, 25n * E / 10_000n], [routeIds(V2, NVDA, venusUsdt).routeId, E / 2n, 25n * E / 10_000n]]);
  assert.deepEqual(vaults.map(v => [v.vaultId, v.baseRate, v.incentive]), [[vaultIdOf('lista', V2.loanTokens.USDC!, A(0xb1)), 141n * E / 10_000n, 354n * E / 10_000n]]); // Venus supply rate is read on chain
  assert.equal(v2RateReport(V2, [], []), null);
});

test('strategy box reward signature = abi.encode(bytes message, bytes accountSig) (spec §9); collectRewards is the anyone-callable box -> account move', () => {
  const sig = boxRewardSignature('2026-11-24T12:00:00.000Z\nThank you for your support of listaDAO.', '0xabcd');
  assert.equal(sig, encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], [stringToHex('2026-11-24T12:00:00.000Z\nThank you for your support of listaDAO.'), '0xabcd']));
  assert.deepEqual(decode(v2Calls.collectRewards(V2, account, LISTA).data), { functionName: 'collectRewards', args: [account, LISTA] });
  assert.deepEqual(v2Calls.deleverage(V2, account, ('0x' + '01'.repeat(32)) as Hex, ('0x' + '02'.repeat(32)) as Hex).to, V2.executor);
});

// ---- scheduler step ----
const NOW_MS = 100 * 86_400_000;
const vaultRow = (token: 'USDT' | 'USDC', venue: 'venus' | 'lista' | 'aave', address: Address, apyBps: number): RoutingVault => ({ token, venue, name: `${venue} ${token}`, address, apyBps, baseBps: apyBps, incentiveBps: 0, tvlUsd: 5e6, eligible: true });
const option = (venue: 'venus' | 'lista', loan: 'USDT' | 'USDC', marketId: string, borrowApyBps: number): RouteOption => ({ protocol: venue, venue, loan, marketId, ratioBps: 3000, factorBps: 7500, lltvBps: 7500, borrowApyBps,
  incentiveBps: 0, netBorrowBps: borrowApyBps, liquidityUsd: 1e6, limited: false, vault: vaultRow(loan, 'venus', A(1), 0), carryBps: 0, extraBps: 0, collateralIncentiveBps: 0 });
const snapshot = (options: Record<string, RouteOption[]>): RoutingSnapshot => ({ at: NOW_MS, sourceAt: { venus: NOW_MS, lista: NOW_MS, aave: NOW_MS }, options,
  vaults: [vaultRow('USDC', 'lista', A(0xb1), 500), vaultRow('USDT', 'venus', A(0xb2), 400)] });
const holding = (o: Partial<V2Holding> = {}): V2Holding => ({ symbol: 'QQQB', collateral: QQQ, freeCollateralRaw: 10n * E, collateralUsd: 10_000, position: null, ...o });
function round(o: { options: RouteOption[]; holdings: V2Holding[]; dryRun?: boolean; fail?: (calls: Call[]) => boolean; keeper?: boolean; enabled?: boolean; ceiling?: bigint }) {
  const sent: string[][] = [], kept: string[] = [], lines: string[] = [], recorded: string[] = [];
  let n = 0;
  const run = runV2Account({ v2: V2, portfolioId: 7, account, snapshot: snapshot({ QQQB: o.options }), costs: { gasUsdPerTx: 0.05 }, now: NOW_MS, deadline: DEADLINE, dryRun: o.dryRun ?? false, log: l => lines.push(l),
    state: { enabled: o.enabled ?? true, policyMaxDebtUsdRaw: o.ceiling ?? 100_000n * E, principalUsdRaw: 0n, holdings: o.holdings },
    send: async calls => { if (o.fail?.(calls)) throw new Error('VaultShortfall(5, 3)\n  at ...'); sent.push(calls.map(c => decode(c.data).functionName)); return { hash: ('0x' + String(++n).padStart(64, '0')) as Hex }; },
    ...(o.keeper === false ? {} : { keeper: async (c: Call) => { kept.push(decode(c.data).functionName); return { hash: ('0x' + 'ee'.repeat(32)) as Hex }; } }),
    record: async step => { recorded.push(`${step.action}:${step.reason}`); } });
  return run.then(result => ({ result, sent, kept, lines, recorded }));
}

test('scheduler step: auto-open after the fill — one UserOp, one log line with the rationale; dry run sends nothing', async () => {
  const options = [option('lista', 'USDC', LISTA_MARKET, 100), option('lista', 'USDT', LISTA_MARKET_2, 100)];
  const live = await round({ options, holdings: [holding()] });
  assert.deepEqual([live.sent, live.result, live.recorded], [[['executeOpen']], { decisions: 1, sent: 1, failed: 0, skipped: 0, consentShort: false }, ['open:best_route']]);
  assert.match(live.lines[0]!, /^\[strategy-routing\] portfolio 7: QQQB open lista\/USDC→lista: borrow 1\.00% − incentive 0\.00%, vault 5\.00%, ratio 30\.00%, extra 1\.20%, debt \$3000\.00 — tx 0x0+1$/);
  const dry = await round({ options, holdings: [holding()], dryRun: true });
  assert.deepEqual([dry.sent, dry.result.skipped, /— dry run$/.test(dry.lines[0]!)], [[], 1, true]);
});

test('scheduler step: holding is logged too; the strategy turned off closes; the safety line goes to the keeper', async () => {
  const options = [option('lista', 'USDC', LISTA_MARKET, 100)];
  const pos = (o: object = {}) => holding({ freeCollateralRaw: 0n, routeDebtRaw: 2940n * E, position: { route: listaUsdc, debtUsd: 2940, since: NOW_MS - 86_400_000, ...o } });
  const hold = await round({ options, holdings: [pos()] });
  assert.deepEqual([hold.sent, hold.lines], [[], ['[strategy-routing] portfolio 7: QQQB hold lista/USDC→lista: extra 1.20%, no better route']]);
  const off = await round({ options, holdings: [pos()], enabled: false });
  assert.deepEqual([off.sent, off.recorded], [[['executeReduce']], ['close:disabled']]);
  const risky = await round({ options, holdings: [pos({ ltvBps: 5000, deleverageLtvBps: 5000 })] });
  assert.deepEqual([risky.sent, risky.kept, risky.recorded], [[], ['executeDeleverage'], ['reduce:safety_line']]);
  const noKeeper = await round({ options, holdings: [pos({ ltvBps: 5000, deleverageLtvBps: 5000 })], keeper: false });
  assert.deepEqual([noKeeper.sent, noKeeper.kept, noKeeper.result.skipped], [[], [], 1]);
});

test('scheduler step: migrate is atomic; when it reverts the position is closed and reopened in two UserOps; a failed step waits for the next round', async () => {
  const options = [option('lista', 'USDC', LISTA_MARKET, 100), option('lista', 'USDT', LISTA_MARKET_2, 390)]; // USDT carry 0.10% vs USDC 4.00%
  const pos = holding({ freeCollateralRaw: 0n, routeDebtRaw: 2940n * E, position: { route: listaUsdt, debtUsd: 2940, since: NOW_MS - 30 * 86_400_000 } });
  const atomic = await round({ options, holdings: [pos] });
  assert.deepEqual([atomic.sent, atomic.recorded], [[['executeMigrate']], ['migrate:better_route']]);
  const isMigrate = (calls: Call[]) => decode(calls[0]!.data).functionName === 'executeMigrate';
  const twoStep = await round({ options, holdings: [pos], fail: isMigrate });
  assert.deepEqual([twoStep.sent, twoStep.result.sent, twoStep.result.failed], [[['executeReduce'], ['executeOpen']], 2, 0]);
  assert.match(twoStep.lines[0]!, /atomic move reverted \(VaultShortfall\(5, 3\)\); closing then reopening$/);
  const stuck = await round({ options, holdings: [pos], fail: calls => isMigrate(calls) || decode(calls[0]!.data).functionName === 'executeOpen' });
  assert.deepEqual([stuck.sent, stuck.result.sent, stuck.result.failed], [[['executeReduce']], 1, 1]); // closed, not reopened: simply not borrowing until the next round
  const failed = await round({ options: [option('lista', 'USDC', LISTA_MARKET, 100)], holdings: [holding()], fail: () => true });
  assert.deepEqual([failed.result.sent, failed.result.failed, /failed, next round retries: VaultShortfall/.test(failed.lines[0]!)], [0, 1, true]);
});

test('ledger rows from a receipt: only this account, only the v2 executor; a reduce that clears the debt and returns shares is a close', () => {
  const R = ('0x' + 'a1'.repeat(32)) as Hex, R2 = ('0x' + 'a2'.repeat(32)) as Hex, VA = ('0x' + 'b1'.repeat(32)) as Hex, VB = ('0x' + 'b2'.repeat(32)) as Hex;
  const log = (name: string, indexed: Record<string, unknown>, data: bigint[] | Hex[], logIndex: number, address: Address = V2.executor): Log => {
    const item = V2_EVENTS_ABI.find(e => e.name === name)! as AbiEvent;
    const plain = item.inputs.filter(i => !i.indexed);
    return { address, topics: encodeEventTopics({ abi: [item], eventName: name, args: indexed } as never), data: encodeAbiParameters(plain, data as never), logIndex } as unknown as Log;
  };
  const tx = { hash: ('0x' + 'cc'.repeat(32)) as Hex, blockNumber: 77n, logs: [
    log('Opened', { account, routeId: R, vaultId: VA }, [10n * E, 3n * E, 3n * E, 10n * E], 0),
    log('Reduced', { account, routeId: R, vaultId: VA }, [E, E, 0n, 0n, 2n * E], 1),
    log('Reduced', { account, routeId: R, vaultId: VA }, [2n * E, 2n * E, 0n, 10n * E, 0n], 2),
    log('Migrated', { account, fromRouteId: R, toRouteId: R2 }, [VA, VB, 3n * E, 10n * E, 3n * E] as never, 3),
    log('VaultSwitched', { account, fromVaultId: VA, toVaultId: VB }, [3n * E], 4),
    log('Deleveraged', { account, routeId: R, vaultId: VA }, [E, 5n * E, 4n * E], 5),
    log('Released', { account, vaultId: VA }, [E / 100n], 6),
    log('Opened', { account: A(0x99), routeId: R, vaultId: VA }, [E, E, E, E], 7), // someone else's position
    log('Opened', { account, routeId: R, vaultId: VA }, [E, E, E, E], 8, A(0xdd))] }; // not the v2 executor
  const lookup = { route: (id: Hex) => id === R ? { asset: 'QQQB', venue: 'lista' as const, loan: 'USDT' } : id === R2 ? { asset: 'QQQB', venue: 'venus' as const, loan: 'USDC' } : null,
    vault: (id: Hex) => id === VB ? { venue: 'aave' as const } : { venue: 'lista' as const } };
  const events = v2RouteEvents(V2, tx, { portfolioId: 7, account, lookup, reason: 'better_route' });
  assert.deepEqual(events.map(e => [e.kind, e.asset, e.venue, e.loan, e.vaultVenue, e.amountRaw, e.collateralRaw, e.fromRouteId, e.fromVaultId, e.logIndex]), [
    ['open', 'QQQB', 'lista', 'USDT', 'lista', 3n * E, 10n * E, null, null, 0], ['reduce', 'QQQB', 'lista', 'USDT', 'lista', E, 0n, null, null, 1],
    ['close', 'QQQB', 'lista', 'USDT', 'lista', 2n * E, 10n * E, null, null, 2], ['migrate', 'QQQB', 'venus', 'USDC', 'aave', 3n * E, 10n * E, R, VA, 3],
    ['switch_vault', null, null, null, 'aave', 3n * E, 0n, null, VA, 4], ['deleverage', 'QQQB', 'lista', 'USDT', 'lista', E, 0n, null, null, 5], ['release', null, null, null, 'lista', E / 100n, 0n, null, null, 6]]);
  assert.ok(events.every(e => e.reason === 'better_route' && e.portfolioId === 7));
});

test('activity sentence: short, English and Simplified Chinese, no venue or borrowing words, no Traditional characters', () => {
  assert.deepEqual(routeMessage({ kind: 'migrate', asset: 'QQQB' }), { en: 'Moved QQQB to a better rate', zh: 'QQQB 换到更好的利率' });
  assert.deepEqual(routeMessage({ kind: 'switch_vault', asset: null }), { en: 'Moved to a better rate', zh: '换到更好的利率' });
  assert.equal(routeMessage({ kind: 'release', asset: null }), null);
  for (const kind of ['open', 'reduce', 'close', 'deleverage', 'migrate', 'switch_vault'] as const) {
    const m = routeMessage({ kind, asset: 'NVDAB' })!;
    assert.ok(!/[\u4e00-\u9fff]/.test(m.en) && m.en.length <= 48 && m.zh.length <= 24, kind);
    assert.ok(!/[換開關閉還債並從於個與這種幣場級險質額獲轉賬戶]/.test(m.zh), kind + ': Traditional character');
    assert.ok(!/borrow|loan|collateral|LTV|Venus|Lista|借|抵押|质押/i.test(m.en + m.zh), kind);
  }
});

test('draft3: Lista vault transactions go one per UserOp; an open under the Lista minimum loan is not sent', () => {
  const a = routeIds(V2, NVDA, venusUsdt), b = routeIds(V2, QQQ, listaUsdc);
  const batches = v2ExitBatches(V2, account, { routes: [a, b], leftoverVaults: [a.vaultId], rewardTokens: [LISTA], deadline: DEADLINE, withdrawConsent: true });
  assert.deepEqual(batches.map(batch => batch.map(c => c.to === V2.registry ? 'setStrategyPolicy' : decode(c.data).functionName)),
    [['executeReduce'], ['executeReduce'], ['executeRelease'], ['executeSweepRewards', 'setStrategyPolicy']]);
  assert.deepEqual(v2PreSellBatches(V2, account, [a, b], DEADLINE).map(x => x.length), [1, 1]);
  const small = plan([decision('QQQB', 'open', 'best_route', null, listaUsdc, 14)], [state('QQQB', QQQ, { freeCollateralRaw: E })]);
  assert.deepEqual([small.steps[0]!.calls.length, small.steps[0]!.skipped], [0, 'below the Lista minimum loan']);
  const venusSmall = plan([decision('NVDAB', 'open', 'best_route', null, venusUsdt, 14)], [state('NVDAB', NVDA, { freeCollateralRaw: E })]);
  assert.equal(venusSmall.steps[0]!.calls.length, 1); // Venus has no such minimum
});

test('an account that still has a v1 Venus position gets nothing on Venus from v2 (the two must never coexist)', async () => {
  const options = [option('venus', 'USDT', A(0xb2), 100), option('lista', 'USDC', LISTA_MARKET, 300)]; // Venus is clearly better
  const run = async (hasV1Venus: boolean) => { const sent: Call[][] = [];
    await runV2Account({ v2: V2, portfolioId: 7, account, snapshot: snapshot({ QQQB: options }), costs: { gasUsdPerTx: 0.05 }, now: NOW_MS, deadline: DEADLINE, dryRun: false, log: () => {},
      state: { enabled: true, policyMaxDebtUsdRaw: 100_000n * E, principalUsdRaw: 0n, holdings: [holding()], hasV1Venus }, send: async calls => { sent.push(calls); return { hash: ('0x' + '01'.repeat(32)) as Hex }; } });
    return (decode(sent[0]![0]!.data).args as readonly unknown[])[1]; };
  assert.equal(await run(false), routeIds(V2, QQQ, { venue: 'venus', marketId: A(0xb2), loan: 'USDT', vault: { venue: 'venus', address: A(0xb2) } }).routeId);
  assert.equal(await run(true), routeIds(V2, QQQ, listaUsdc).routeId);
});
