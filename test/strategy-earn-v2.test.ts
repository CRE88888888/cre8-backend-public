import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createPublicClient, custom, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, maxUint256, pad, parseAbi, toFunctionSelector } from 'viem';
import type { AbiEvent, Address, Hex, Log } from 'viem';
import { bscTestnet } from 'viem/chains';
import { ParamCondition } from '@zerodev/permissions/policies';
import { AppError } from '../src/errors.js';
import { validateSponsoredCalls } from '../src/paymaster.js';
import { borrowAuthorized, borrowKeyMarkets, borrowSessionPermissions, buildSessionPermissions, describePolicies, sessionCallPermissions } from '../src/permissions.js';
import { readPositions } from '../src/positions.js';
import { runSchedulerOnce } from '../src/scheduler.js';
import type { SchedulerDeps, SchedulerQueryFn } from '../src/scheduler.js';
import type { RebalancePlan } from '../src/rebalance-plan.js';
import {
  consentCalls, createStrategyEarn, runStrategyEarnRound, STRATEGY_EARN_97 as S, STRATEGY_EARN_ABI, STRATEGY_EARN_EVENTS_ABI, strategyEarnAutoOpen,
  strategyEarnEvents, strategyEarnMessage, strategyEarnUnwindForSale, strategyMarkets,
} from '../src/strategy-earn.js';
import type { StatusReading, StrategyEarnChain, StrategyEarnEvent, StrategyEarnTx, StrategyKeeperWriter } from '../src/strategy-earn.js';
import { BORROW_SESSION_SELECTORS, STRATEGY_EARN_LEGACY_MARKET_IDS } from '../src/strategy-earn-guard.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
import { mixRuntimeFixture } from './fixtures/mix.js';
import { config, kernelCall, operation, SENDER, TEST_SIGNER } from './fixtures/paymaster.js';
import { resetStrategyEarnOpenBackoff } from '../src/scheduler.js';
// A failed auto-open backs off for minutes (process-wide, real clock): each case starts with a clean slate.
beforeEach(resetStrategyEarnOpenBackoff);

const E18 = 10n ** 18n, E16 = 10n ** 16n;
const account = SENDER.toLowerCase() as Address;
const markets = strategyMarkets();
const [nvda, tsla, , qqq] = markets;
assert.ok(nvda && tsla && qqq);
const usdt = T.contracts.usdt.toLowerCase() as Address;
const status = (patch: Partial<StatusReading> = {}): StatusReading => ({ gate: 0, shouldDeleverage: false, shouldUnwind: false,
  borrowRate: 250n * E16 / 100n, collateralRate: 0n, vaultRate: 450n * E16 / 100n, collateralIncentiveRate: 50n * E16 / 100n, borrowIncentiveRate: 0n,
  vaultIncentiveRate: 50n * E16 / 100n, borrowUtilizationBps: 0n, vaultUtilizationBps: 0n, ltv: 0n, targetLtv: 30n * E16, deleverageLtv: 40n * E16,
  liquidationLtv: 60n * E16, debt: 0n, vaultAssets: 0n, health: { collateralValue: 0n, liquidationValue: 0n, debtValue: 0n, healthFactor: maxUint256 }, ...patch });

type Fake = { statuses?: Record<string, StatusReading>; ids?: Hex[]; balances?: Record<string, bigint>; collateral?: Record<string, bigint>;
  prices?: Record<string, bigint>; policies?: Record<string, { maxDebt: bigint; enabled: boolean }>; weights?: { asset: Address; weightBps: number }[];
  rewards?: { vault: bigint; collateral: bigint } };
function chainOf(f: Fake): StrategyEarnChain {
  return {
    head: async () => ({ number: 9n, timestamp: 1_795_400_000n }),
    status: async id => f.statuses?.[id] ?? status(),
    accountMarkets: async () => f.ids ?? [],
    collateral: async id => f.collateral?.[id] ?? 0n,
    balance: async token => f.balances?.[token.toLowerCase()] ?? 0n,
    price: async asset => f.prices?.[asset.toLowerCase()] ?? 10n ** 8n,
    rewards: async () => f.rewards ?? { vault: 0n, collateral: 0n },
    policy: async (_a, id) => f.policies?.[id] ?? { maxDebt: 0n, enabled: false },
    weights: async () => f.weights ?? [],
  };
}
const decode = (data: Hex) => decodeFunctionData({ abi: STRATEGY_EARN_ABI, data });
const now = new Date('2026-11-23T15:00:00Z'), deadline = BigInt(Math.floor(now.getTime() / 1000) + 1800);

// ---- session permissions --------------------------------------------------------------------------------------

test('#204 session policy: borrow calls only on AtpBorrowExecutor, account pinned, every strategy market; never AtpExecutor or approvals', () => {
  const perms = borrowSessionPermissions(account);
  assert.equal(perms.length, 4);
  assert.deepEqual(perms.map(p => p.selector), BORROW_SESSION_SELECTORS);
  assert.deepEqual(BORROW_SESSION_SELECTORS, ['executeSupplyCollateral', 'executeBorrow', 'executeRepay', 'executeWithdrawCollateral']
    .map(name => toFunctionSelector(STRATEGY_EARN_ABI.find(i => i.type === 'function' && i.name === name) as never)));
  for (const p of perms) {
    assert.equal(p.target, S.executor);
    assert.deepEqual(p.rules[0], { condition: ParamCondition.EQUAL, offset: 0, params: [pad(account)] });
    assert.deepEqual(p.rules[1], { condition: ParamCondition.ONE_OF, offset: 32, params: markets.map(m => m.marketId) });
  }
  const all = sessionCallPermissions(T.contracts.executor, account, account);
  // deleverage is anyone-callable and is not granted; nothing touches the strategy vault or approvals.
  assert.equal(all.some(p => p.target.toLowerCase() === S.earnVault || p.selector === toFunctionSelector('approve(address,uint256)')), false);
  assert.equal(all.filter(p => p.target.toLowerCase() === T.contracts.executor.toLowerCase()).length, 3, 'rebalance + yield supply/withdraw only');
  // Pre-#204 shape (yield only) is unchanged, so already-renewed keys rebuild the same permissionId.
  assert.deepEqual(sessionCallPermissions(T.contracts.executor, account), all.slice(0, 3));
});

test('#204 borrowAuthorized: exact snapshot only; other account, missing rule, extra market or AtpExecutor target are refused', () => {
  const snap = describePolicies({ executorAddress: T.contracts.executor, validUntil: 2_000_000_000, chainId: 97, yieldAccount: account, borrowAccount: account });
  assert.equal(borrowAuthorized(snap, account), true);
  assert.equal(borrowAuthorized(snap, '0x' + '12'.repeat(20) as Address), false);
  assert.equal(borrowAuthorized(describePolicies({ executorAddress: T.contracts.executor, validUntil: 2_000_000_000, chainId: 97, yieldAccount: account }), account), false);
  for (const tamper of [
    (p: Record<string, unknown>) => { p.target = T.contracts.executor; },
    (p: Record<string, unknown>) => { (p.rules as unknown[]).pop(); },
    (p: Record<string, unknown>) => { ((p.rules as { params: Hex[] }[])[1]!.params).push(pad('0x01')); },
    (p: Record<string, unknown>) => { p.valueLimit = '1'; },
  ]) {
    const copy = JSON.parse(JSON.stringify(snap)) as { call: { permissions: Record<string, unknown>[] } };
    tamper(copy.call.permissions[copy.call.permissions.length - 1]!);
    assert.equal(borrowAuthorized(copy, account), false);
  }
  for (const bad of [null, 1, {}, { call: {} }, { call: { permissions: 'x' } }]) assert.equal(borrowAuthorized(bad, account), false);
});

test('#204 buildSessionPermissions: borrow upgrade needs chain 97 and the same account as yield', async () => {
  const client = (chain: typeof bscTestnet) => createPublicClient({ chain, transport: custom({ request: async () => { throw new Error('no rpc'); } }) });
  const key = '0x' + '34'.repeat(20) as Address;
  const ok = await buildSessionPermissions({ publicClient: client(bscTestnet) as never, sessionKeyAddress: key, executorAddress: T.contracts.executor,
    validUntil: 2_000_000_000, yieldAccount: account, borrowAccount: account });
  assert.equal(borrowAuthorized(ok.policySnapshot, account), true);
  const yieldOnly = await buildSessionPermissions({ publicClient: client(bscTestnet) as never, sessionKeyAddress: key, executorAddress: T.contracts.executor,
    validUntil: 2_000_000_000, yieldAccount: account });
  assert.notEqual(ok.permissionId, yieldOnly.permissionId);
  for (const extra of [{ borrowAccount: account }, { yieldAccount: account, borrowAccount: '0x' + '56'.repeat(20) as Address }]) {
    await assert.rejects(buildSessionPermissions({ publicClient: client(bscTestnet) as never, sessionKeyAddress: key, executorAddress: T.contracts.executor,
      validUntil: 2_000_000_000, ...extra }), /策略加息升權/);
  }
});

// ---- owner consent at buy ---------------------------------------------------------------------------------------

test('#204 consent calls: delegates once per protocol, ceiling + approvals per market, all to AtpBorrowExecutor; paymaster sponsors them', () => {
  assert.deepEqual(consentCalls([]), []);
  const calls = consentCalls([{ market: nvda, maxDebtRaw: 100n }, { market: qqq, maxDebtRaw: 200n }]);
  assert.deepEqual(calls.map(c => [c.to, decode(c.data).functionName]), [
    [S.venusComptroller, 'updateDelegate'], [S.listaMoolah, 'setAuthorization'],
    [S.registry, 'setBorrowPolicy'], [nvda.collateral, 'approve'], [S.registry, 'setBorrowPolicy'], [qqq.collateral, 'approve'],
    [T.contracts.usdt, 'approve'], [S.earnVault, 'approve']]);
  for (const c of calls) {
    const d = decode(c.data);
    if (d.functionName === 'approve' || d.functionName === 'updateDelegate' || d.functionName === 'setAuthorization') assert.equal(String(d.args[0]).toLowerCase(), S.executor);
    assert.equal(c.data.toLowerCase().includes(T.contracts.executor.slice(2).toLowerCase()), false, 'never AtpExecutor');
  }
  assert.deepEqual(calls.filter(c => decode(c.data).functionName === 'setBorrowPolicy').map(c => decode(c.data).args), [[nvda.marketId, 100n, true], [qqq.marketId, 200n, true]]);
  const env = { CHAIN_ID: '97', RPC_URL: 'http://127.0.0.1:8558', PAYMASTER_SIGNER_PRIVATE_KEY: TEST_SIGNER };
  for (const c of calls) assert.doesNotThrow(() => validateSponsoredCalls(operation({ callData: kernelCall(c.data, c.to) }), config(env)), decode(c.data).functionName);
  // Only Venus markets -> no Lista grant.
  assert.equal(consentCalls([{ market: tsla, maxDebtRaw: 1n }]).some(c => c.to === S.listaMoolah), false);
});

const owned = (patch: Record<string, unknown> = {}) => (async () => ({ id: 3, userId: account, strategyId: 1, version: 1, scheduleState: 'active', createdAt: '2026-11-23T00:00:00Z',
  chainId: 97, accountAddress: account, ownerAddress: account, existingKeyRefs: [], ...patch })) as never;
const keyRows = (permissions: unknown) => (async () => ({ rows: permissions === null ? [] : [{ permissions }] })) as never;
const borrowSnap = describePolicies({ executorAddress: T.contracts.executor, validUntil: 2_000_000_000, chainId: 97, yieldAccount: account, borrowAccount: account });

test('#204 POST auto: eligible assets from the enrolled version; ceiling = (new money share + held) x target, +10%; renewal flag', async () => {
  const f: Fake = { weights: [{ asset: nvda.collateral, weightBps: 6000 }, { asset: qqq.collateral, weightBps: 2000 }, { asset: T.assets.TQQQB.token.toLowerCase() as Address, weightBps: 2000 }],
    statuses: { [qqq.marketId]: status({ gate: 4 }) }, balances: { [nvda.collateral]: 2n * E18 }, prices: { [nvda.collateral]: 100n * 10n ** 8n } };
  const earn = createStrategyEarn({ v2: null, chainId: 97, chain: () => chainOf(f), owned: owned(), query: keyRows(borrowSnap) });
  const r = await earn.auto(3, account, { budgetRaw: String(1000n * E18) });
  assert.equal(r.status, 'ready'); assert.ok('calls' in r && r.calls && 'authorization' in r);
  assert.equal(r.authorization, 'ready');
  // NVDAB: 600 USD new + 200 USD held = 800 x 30% x 98% = 235.2 -> x 110% = 258.72 USDT ceiling. QQQB gate closed -> no consent.
  assert.deepEqual(r.assets, [{ asset: 'NVDAB', status: 'ready', maxDebtRaw: String(25872n * E16), extraApyBps: 125 },
    { asset: 'QQQB', status: 'unavailable', reason: 'negative_carry', message: 'Temporarily unavailable.' }]);
  assert.deepEqual(r.calls.map(c => decode(c.data).functionName), ['updateDelegate', 'setBorrowPolicy', 'approve', 'approve', 'approve']);
  // Older key without the #204 calls -> the frontend must also sign the renewal.
  for (const rows of [keyRows(describePolicies({ executorAddress: T.contracts.executor, validUntil: 2_000_000_000, chainId: 97, yieldAccount: account })), keyRows(null)]) {
    const again = await createStrategyEarn({ v2: null, chainId: 97, chain: () => chainOf(f), owned: owned(), query: rows }).auto(3, account, { budgetRaw: '5' });
    assert.ok('authorization' in again); assert.equal(again.authorization, 'renewal_required');
  }
  // No strategy-earn asset in the portfolio, or every market closed.
  assert.deepEqual(await createStrategyEarn({ v2: null, chainId: 97, chain: () => chainOf({ weights: [] }), owned: owned(), query: keyRows(null) }).auto(3, account, { budgetRaw: '1' }),
    { status: 'unavailable', reason: 'no_eligible_asset', message: 'Temporarily unavailable.', assets: [] });
  const closed = await createStrategyEarn({ v2: null, chainId: 97, chain: () => chainOf({ ...f, statuses: { [nvda.marketId]: status({ gate: 1 }), [qqq.marketId]: status({ gate: 2 }) } }), owned: owned(), query: keyRows(null) })
    .auto(3, account, { budgetRaw: '1' });
  assert.equal(closed.status, 'unavailable');
  // Nothing to borrow against (no new money and nothing held) is not a consent.
  const empty = await createStrategyEarn({ v2: null, chainId: 97, chain: () => chainOf({ ...f, balances: {} }), owned: owned(), query: keyRows(null) }).auto(3, account, { budgetRaw: '0' });
  assert.equal(empty.status, 'unavailable');
  for (const bad of [{ budgetRaw: '-1' }, { budgetRaw: '1.5' }, { budgetRaw: 1 }, {}, { budgetRaw: '1', x: 1 }]) {
    await assert.rejects(earn.auto(3, account, bad), (e: unknown) => e instanceof AppError && e.status === 400);
  }
  // My mix: same consent on the mix's own account (one account per mix); refused while the mix is exiting or deleting.
  const mixQuery = (busy: boolean) => (async (sql: string) => sql.includes('from mixes') ? { rows: [{ busy }] } : { rows: [] }) as never;
  const mix = await createStrategyEarn({ v2: null, chainId: 97, chain: () => chainOf(f), owned: owned({ personalMix: true }), query: mixQuery(false) }).auto(3, account, { budgetRaw: String(1000n * E18) });
  assert.ok('calls' in mix && mix.calls); assert.deepEqual(mix.calls, r.calls);
  await assert.rejects(createStrategyEarn({ v2: null, chainId: 97, chain: () => chainOf(f), owned: owned({ personalMix: true }), query: mixQuery(true) }).auto(3, account, { budgetRaw: '1' }),
    (e: unknown) => e instanceof AppError && e.code === 'MIX_EXITING');
});

// ---- ledger events ----------------------------------------------------------------------------------------------

const eventItem = (name: string, inputs: number) => STRATEGY_EARN_EVENTS_ABI.find(i => i.type === 'event' && i.name === name && i.inputs.length === inputs) as AbiEvent;
let logIndex = 0;
function log(address: string, name: string, inputs: number, args: Record<string, unknown>, removed = false): Log {
  const item = eventItem(name, inputs);
  const indexed = item.inputs.filter(i => i.indexed), plain = item.inputs.filter(i => !i.indexed);
  return { address: address as Address, topics: encodeEventTopics({ abi: [item], eventName: name, args: Object.fromEntries(indexed.map(i => [i.name, args[i.name ?? '']])) } as never) as never,
    data: encodeAbiParameters(plain, plain.map(i => args[i.name ?? ''])), logIndex: logIndex++, removed, blockHash: null, blockNumber: 5n, transactionHash: null, transactionIndex: 0 } as Log;
}
const tx = (logs: Log[]): StrategyEarnTx => ({ hash: ('0x' + 'AB'.repeat(32)) as Hex, blockNumber: 5n, logs });
const ex = S.executor;

test('#204 ledger events: open / deleverage vs unwind / close / repay / three reward sources; spoofed and other-account logs ignored', () => {
  logIndex = 0;
  const events = strategyEarnEvents(tx([
    log(ex, 'CollateralSupplied', 4, { account, marketId: nvda.marketId, amount: 5n * E18, collateral: 5n * E18 }),
    log(ex, 'Borrowed', 5, { account, marketId: nvda.marketId, amount: 240n * E18, vaultShares: 1n, ltv: 3n * E16 }),
    log(ex, 'CollateralSupplied', 4, { account, marketId: tsla.marketId, amount: E18, collateral: E18 }),
    log(ex, 'Deleveraged', 5, { account, marketId: qqq.marketId, repaid: 67n * E18, ltvBefore: 4174n * 10n ** 14n, ltvAfter: 30n * E16 }),
    log(ex, 'Repaid', 5, { account, marketId: qqq.marketId, amount: 67n * E18, vaultSharesUsed: 1n, debt: 1n }),
    log('0x' + '99'.repeat(20), 'Borrowed', 5, { account, marketId: nvda.marketId, amount: 999n, vaultShares: 1n, ltv: 1n }),
    log(ex, 'Borrowed', 5, { account: '0x' + '77'.repeat(20), marketId: nvda.marketId, amount: 999n, vaultShares: 1n, ltv: 1n }),
    log(S.earnVault, 'RewardClaimed', 2, { account, amount: 12n * E16 }),
    log(nvda.collateralVToken ?? '', 'RewardClaimed', 2, { account, amount: 3n * E16 }),
    log(S.listaMoolah, 'RewardClaimed', 3, { id: qqq.listaId, account, amount: 4n * E16 }),
    log(S.listaMoolah, 'RewardClaimed', 3, { id: qqq.listaId, account, amount: 0n }),
  ]), 3, account, id => id === qqq.marketId ? 40n * E16 : undefined);
  const brief = (e: StrategyEarnEvent) => [e.kind, e.asset, e.amountRaw, e.collateralRaw, e.ltvBeforeBps, e.ltvAfterBps, e.logIndex];
  assert.deepEqual(events.map(brief), [
    ['open', 'NVDAB', 240n * E18, 5n * E18, null, null, 1], ['open', 'TSLAB', 0n, E18, null, null, 2],
    ['deleverage', 'QQQB', 67n * E18, 0n, 4174, 3000, 3],
    ['claim', null, 12n * E16, 0n, null, null, 7], ['claim', 'NVDAB', 3n * E16, 0n, null, null, 8], ['claim', 'QQQB', 4n * E16, 0n, null, null, 9]]);
  assert.ok(events.every(e => e.portfolioId === 3 && e.txHash === '0x' + 'ab'.repeat(32) && e.blockNumber === 5n));
  assert.equal(events[3]?.marketId, S.earnVaultMarketId);
  logIndex = 0;
  // Below the deleverage line = unwind (negative carry / vault utilization). Close = withdraw with the repaid sum; repay alone.
  const second = strategyEarnEvents(tx([
    log(ex, 'Deleveraged', 5, { account, marketId: nvda.marketId, repaid: 9n * E18, ltvBefore: 20n * E16, ltvAfter: 0n }),
    log(ex, 'Repaid', 5, { account, marketId: tsla.marketId, amount: 100n * E18, vaultSharesUsed: 1n, debt: 0n }),
    log(ex, 'Repaid', 5, { account, marketId: tsla.marketId, amount: 0n, vaultSharesUsed: 1n, debt: 0n }),
    log(ex, 'CollateralWithdrawn', 5, { account, marketId: tsla.marketId, amount: 2n * E18, collateral: 0n, ltv: 0n }),
    log(ex, 'Repaid', 5, { account, marketId: qqq.marketId, amount: 5n * E18, vaultSharesUsed: 0n, debt: 1n }),
  ]), 3, account, () => 40n * E16);
  assert.deepEqual(second.map(brief), [['unwind', 'NVDAB', 9n * E18, 0n, 2000, 0, 0], ['close', 'TSLAB', 100n * E18, 2n * E18, null, null, 3], ['repay', 'QQQB', 5n * E18, 0n, null, null, 4]]);
  assert.throws(() => strategyEarnEvents(tx([log(ex, 'Borrowed', 5, { account, marketId: nvda.marketId, amount: 1n, vaultShares: 1n, ltv: 1n }, true)]), 3, account), /removed/);
});

test('#204 activity sentences: one plain sentence per kind, no collateral / LTV / borrow wording', () => {
  const base = { asset: 'NVDAB', amountRaw: 6750n * E16, collateralRaw: 5n * E18, ltvBeforeBps: 4174, ltvAfterBps: 3000 };
  const lines = (['open', 'deleverage', 'unwind', 'repay', 'close', 'claim'] as const).map(kind => strategyEarnMessage({ ...base, kind }));
  assert.deepEqual(lines, [
    'Earn extra turned on for NVDAB: 5 NVDAB put to work, 67.50 USDT now earning.',
    'NVDAB fell, so we automatically used 67.50 USDT from Earn to stay safe (safety level 41.7% → 30.0%).',
    'Earn extra on NVDAB was no longer worth it, so we automatically settled 67.50 USDT.',
    'We settled 67.50 USDT of Earn extra on NVDAB.',
    'Earn extra turned off for NVDAB: settled 67.50 USDT and 5 NVDAB back in your portfolio.',
    'Received 67.50 USDT in Earn rewards on NVDAB.']);
  for (const line of lines) assert.doesNotMatch(line, /collateral|LTV|borrow|liquidat|health/i);
  assert.equal(strategyEarnMessage({ ...base, kind: 'claim', asset: null, amountRaw: 1n * E16 }), 'Received 0.01 USDT in Earn rewards.');
  assert.equal(strategyEarnMessage({ ...base, kind: 'open', amountRaw: 0n, collateralRaw: 1500n * 10n ** 15n }), 'Earn extra turned on for NVDAB: 1.5 NVDAB put to work.');
});

test('#204 GET activity: newest first from the ledger, owner only', async () => {
  const sqls: string[] = [];
  const query = (async (sql: string, params: unknown[]) => { sqls.push(sql); assert.deepEqual(params, [3, account]); return { rows: [
    { kind: 'deleverage', asset: 'NVDAB', amount_raw: String(6750n * E16), collateral_raw: '0', ltv_before_bps: 4174, ltv_after_bps: 3000, tx_hash: '0x' + '01'.repeat(32), block_number: '9', created_at: new Date('2026-11-23T01:00:00Z') },
  ] }; }) as never;
  const r = await createStrategyEarn({ v2: null, chainId: 97, chain: () => chainOf({}), owned: owned(), query }).activity(3, account);
  assert.deepEqual(r.activity, [{ kind: 'deleverage', asset: 'NVDAB', amountRaw: String(6750n * E16), collateralRaw: '0', ltvBeforeBps: 4174, ltvAfterBps: 3000,
    txHash: '0x' + '01'.repeat(32), blockNumber: '9', createdAt: '2026-11-23T01:00:00.000Z',
    message: 'NVDAB fell, so we automatically used 67.50 USDT from Earn to stay safe (safety level 41.7% → 30.0%).' }]);
  assert.match(sqls[0] ?? '', /from strategy_earn_events where chain_id = 97 and \(portfolio_id = \$1 or portfolio_id in \(select h\.portfolio_id from mix_portfolio_history h/);
  assert.match(sqls[0] ?? '', /m\.account = \$2\)\) order by block_number desc, log_index desc limit 50/);
  await assert.rejects(createStrategyEarn({ v2: null, chainId: 97, chain: () => chainOf({}), owned: (async () => { throw new AppError(403, 'FORBIDDEN', 'no'); }) as never, query }).activity(3, account),
    (e: unknown) => e instanceof AppError && e.status === 403);
});

// ---- scheduler steps --------------------------------------------------------------------------------------------

const stepArgs = (f: Fake, send: ((calls: { to: Address; data: Hex }[]) => Promise<StrategyEarnTx>) | null, dryRun = false) => {
  const recorded: StrategyEarnEvent[][] = [];
  return { recorded, args: { chain: chainOf(f), account, portfolioId: 3, now, dryRun, send, ledger: { record: async (_c: number, e: readonly StrategyEarnEvent[]) => { recorded.push([...e]); } }, log: () => {} } };
};

test('#204 auto-open: only consented markets with an open gate and a non-dust holding; borrow capped by target and the owner ceiling', async () => {
  const f: Fake = {
    policies: { [nvda.marketId]: { maxDebt: 100n * E18, enabled: true }, [tsla.marketId]: { maxDebt: 1000n * E18, enabled: true },
      [qqq.marketId]: { maxDebt: 1000n * E18, enabled: true }, [markets[4]!.marketId]: { maxDebt: 1000n * E18, enabled: false } },
    balances: { [nvda.collateral]: 10n * E18, [tsla.collateral]: 2n * E18, [qqq.collateral]: 5n * E18, [markets[4]!.collateral]: 5n * E18, [markets[2]!.collateral]: 5n * E18 },
    prices: { [nvda.collateral]: 100n * 10n ** 8n, [tsla.collateral]: 1n * 10n ** 8n, [qqq.collateral]: 100n * 10n ** 8n },
    statuses: { [qqq.marketId]: status({ gate: 2 }) },
  };
  let sent: { to: Address; data: Hex }[] = [];
  const { args, recorded } = stepArgs(f, async calls => { sent = calls; logIndex = 0; return tx([log(ex, 'CollateralSupplied', 4, { account, marketId: nvda.marketId, amount: 10n * E18, collateral: 10n * E18 }),
    log(ex, 'Borrowed', 5, { account, marketId: nvda.marketId, amount: 99n * E18, vaultShares: 1n, ltv: 1n })]); });
  const note = await strategyEarnAutoOpen(args);
  // NVDAB: 1,000 USD x 30% x 98% = 294 USDT planned, capped at 99% of the 100 USDT ceiling. TSLAB 2 USD would borrow 0.60 (under the 1 USD floor); QQQB gate closed; MSTRB not consented; SPCXB no policy.
  assert.deepEqual(sent.map(c => [c.to, decode(c.data).functionName, decode(c.data).args]), [
    [S.executor, 'executeSupplyCollateral', [account, nvda.marketId, 10n * E18, deadline]], [S.executor, 'executeBorrow', [account, nvda.marketId, 99n * E18, deadline]]]);
  assert.match(note ?? '', /^\[STRATEGY_EARN_OPEN\] 已自動開啟：NVDAB 10／借 99\.00 USDT 存 vault tx=0x/);
  assert.deepEqual(recorded.flat().map(e => [e.kind, e.amountRaw]), [['open', 99n * E18]]);
  // Ceiling already used up: post the shares, no borrow.
  sent = [];
  const used = stepArgs({ ...f, statuses: { ...f.statuses, [nvda.marketId]: status({ debt: 100n * E18 }) } }, async calls => { sent = calls; return tx([]); });
  await strategyEarnAutoOpen(used.args);
  assert.deepEqual(sent.filter(c => c.to === S.executor && decode(c.data).args[1] === nvda.marketId).map(c => decode(c.data).functionName), ['executeSupplyCollateral']);
  // Dry-run and no #204 session key only report; nothing consented -> null.
  let called = false;
  const dry = await strategyEarnAutoOpen(stepArgs(f, async () => { called = true; return tx([]); }, true).args);
  assert.match(dry ?? '', /dry-run，未送出/); assert.equal(called, false);
  assert.match(await strategyEarnAutoOpen(stepArgs(f, null).args) ?? '', /等 owner 續期/);
  assert.equal(await strategyEarnAutoOpen(stepArgs({ ...f, policies: {} }, async () => { throw new Error('unexpected'); }).args), null);
  // A failed UserOp propagates (the scheduler logs it and retries next round); the ledger is not written.
  const failing = stepArgs(f, async () => { throw new Error('AA23 reverted'); });
  await assert.rejects(strategyEarnAutoOpen(failing.args), /AA23/); assert.equal(failing.recorded.length, 0);
});

test('#204 unwind before a sale (Lista, its own debt): repay first then take shares back; vault short pays what it can and keeps the target ratio', async () => {
  const sell = (token: string, amount: bigint) => [{ tokenIn: token, amountIn: amount }];
  const base: Fake = { ids: [qqq.marketId], collateral: { [qqq.marketId]: 10n * E18 }, balances: { [qqq.collateral]: 1n * E18 },
    prices: { [qqq.collateral]: 100n * 10n ** 8n } };
  const run = async (f: Fake, steps: { tokenIn: string; amountIn: bigint }[], dryRun = false) => {
    let sent: { to: Address; data: Hex }[] = [];
    const s = stepArgs(f, async calls => { sent = calls; return tx([]); }, dryRun);
    const reason = await strategyEarnUnwindForSale({ ...s.args, steps });
    return { reason, calls: sent.map(c => [decode(c.data).functionName, decode(c.data).args]) };
  };
  // Sale fits the free balance, or does not touch a posted asset: nothing to do.
  assert.equal((await run(base, sell(qqq.collateral, E18))).reason, null);
  assert.equal((await run(base, sell(T.assets.WBNB.token, 5n * E18))).reason, null);
  assert.equal((await run({ ...base, collateral: {} }, sell(qqq.collateral, 5n * E18))).reason, null);
  // No debt: just take the shares back.
  const noDebt = await run(base, sell(qqq.collateral, 5n * E18));
  assert.deepEqual(noDebt.calls, [['executeWithdrawCollateral', [account, qqq.marketId, maxUint256, deadline]]]);
  assert.match(noDebt.reason ?? '', /^\[STRATEGY_EARN_UNWINDING\] 賣出前已還款取回：QQQB 取回 tx=.*下一輪再賣$/);
  // Vault (+ cash) covers the debt: repay everything from the vault first, then take all shares back.
  const covered = { ...base, statuses: { [qqq.marketId]: status({ debt: 300n * E18, vaultAssets: 301n * E18 }) } };
  assert.deepEqual((await run(covered, sell(qqq.collateral, 5n * E18))).calls, [['executeRepay', [account, qqq.marketId, maxUint256, true, deadline]],
    ['executeWithdrawCollateral', [account, qqq.marketId, maxUint256, deadline]]]);
  // Vault short: 300 owed, 200 in the vault + 0 cash -> repay 200 - 1 raw; keep (100 + 1 raw) / 30% x 102% ≈ 340 USD posted -> take back ~6.6 of 10.
  const short = { ...base, statuses: { [qqq.marketId]: status({ debt: 300n * E18, vaultAssets: 200n * E18, health: { collateralValue: 1000n * E18, liquidationValue: 0n, debtValue: 300n * E18, healthFactor: 0n } }) } };
  const partial = await run(short, sell(qqq.collateral, 9n * E18));
  assert.equal(partial.calls.length, 2);
  assert.deepEqual(partial.calls[0], ['executeRepay', [account, qqq.marketId, 200n * E18 - 1n, true, deadline]]);
  const take = (partial.calls[1]?.[1] as readonly unknown[])[2] as bigint;
  assert.ok(take > 6599n * 10n ** 15n && take < 6601n * 10n ** 15n, String(take));
  assert.match(partial.reason ?? '', /vault 不足/);
  // Dry-run reports and sends nothing.
  const dry = await run(covered, sell(qqq.collateral, 5n * E18), true);
  assert.deepEqual(dry.calls, []); assert.match(dry.reason ?? '', /dry-run，未送出/);
  // Every call targets AtpBorrowExecutor and nothing ever approves or calls AtpExecutor.
  let all: { to: Address; data: Hex }[] = [];
  await strategyEarnUnwindForSale({ ...stepArgs(short, async calls => { all = calls; return tx([]); }).args, steps: sell(qqq.collateral, 9n * E18) });
  assert.ok(all.length > 0 && all.every(c => c.to === S.executor));
});

test('2026-11-26 (v1): before an owner\'s partial sale only the shares it is short of are repaid for and taken back; the position stays open and the sale goes on in the same round', async () => {
  // 10 QQQB posted, none free, 300 USDT owed against 1,000 USD of collateral, 301 in the vault. The sale takes 4 shares.
  const f: Fake = { ids: [qqq.marketId], collateral: { [qqq.marketId]: 10n * E18 }, balances: {}, prices: { [qqq.collateral]: 100n * 10n ** 8n, [T.contracts.usdt]: 10n ** 8n },
    statuses: { [qqq.marketId]: status({ debt: 300n * E18, vaultAssets: 301n * E18, health: { collateralValue: 1000n * E18, liquidationValue: 0n, debtValue: 300n * E18, healthFactor: 0n } }) } };
  const steps = [{ tokenIn: qqq.collateral, amountIn: 4n * E18 }];
  const run = async (fake: Fake, o: { partial?: boolean; exit?: boolean } = { partial: true }) => {
    let sent: { to: Address; data: Hex }[] = [];
    const answer = await strategyEarnUnwindForSale({ ...stepArgs(fake, async calls => { sent = calls; return { ...tx([]), blockNumber: 144_893_940n }; }).args, steps, ...o });
    return { answer, calls: sent.map(c => [decode(c.data).functionName, decode(c.data).args]) };
  };
  const deadline = BigInt(Math.floor(now.getTime() / 1000) + 30 * 60);
  // 40% of the shares -> 40% of the debt, 2% more (122.45 of 300), and exactly the 4 shares: debt ÷ posted never rises.
  const pay = (300n * E18 * 4n * E18 * 10_000n + 10n * E18 * 9_800n - 1n) / (10n * E18 * 9_800n);
  const part = await run(f);
  assert.deepEqual(part.calls, [['executeRepay', [account, qqq.marketId, pay, true, deadline]], ['executeWithdrawCollateral', [account, qqq.marketId, 4n * E18, deadline]]]);
  assert.ok((300n * E18 - pay) * 10n <= 300n * E18 * 6n);
  assert.ok(part.answer !== null && typeof part.answer === 'object' && 'freed' in part.answer, String(part.answer));
  assert.equal(part.answer.block, 144_893_940n);
  assert.match(part.answer.freed, /^\[STRATEGY_EARN_UNWINDING\] 賣出前已還款取回：QQQB 先還 122\.44 USDT、取回 4，部位續開 tx=0x(AB){32}$/);
  // As before for everyone else: without `partial` (and for a full exit) the position is closed and the sale waits a round.
  for (const o of [{}, { partial: true, exit: true }]) {
    const whole = await run(f, o);
    assert.deepEqual(whole.calls.map(c => [c[0], (c[1] as readonly unknown[])[2]]), [['executeRepay', maxUint256], ['executeWithdrawCollateral', maxUint256]]);
    assert.match(String(whole.answer), /先還清再取回 tx=.*；下一輪再賣$/);
  }
  // A whole close that a partial sale needs (it takes every posted share) also lets the sale go on at once.
  const all = await strategyEarnUnwindForSale({ ...stepArgs(f, async () => ({ ...tx([]), blockNumber: 7n })).args, steps: [{ tokenIn: qqq.collateral, amountIn: 10n * E18 }], partial: true });
  assert.deepEqual(all !== null && typeof all === 'object' && 'freed' in all ? all.block : null, 7n);
  // What would be left owes less than our own floor (1 USD): close instead of leaving dust debt.
  const tiny = { ...f, statuses: { [qqq.marketId]: status({ debt: 15n * E16 * 10n, vaultAssets: 2n * E18, health: { collateralValue: 1000n * E18, liquidationValue: 0n, debtValue: 15n * E16 * 10n, healthFactor: 0n } }) } };
  assert.deepEqual((await run(tiny)).calls.map(c => (c[1] as readonly unknown[])[2]), [maxUint256, maxUint256]);
  // The vault cannot pay even that share: the old "vault 不足" plan, fewer shares than the sale needs — it waits a round.
  const short = { ...f, statuses: { [qqq.marketId]: status({ debt: 300n * E18, vaultAssets: 50n * E18, health: { collateralValue: 1000n * E18, liquidationValue: 0n, debtValue: 300n * E18, healthFactor: 0n } }) } };
  const waits = await run(short);
  assert.equal(typeof waits.answer, 'string');
  assert.match(String(waits.answer), /vault 不足.*；下一輪再賣$/);
  // The venue (or the bundler's simulation) refuses the partial repayment and nothing landed: the same call falls back to
  // the whole close, as every sale did before; that sale waits for the next round.
  const batches: unknown[][] = [];
  const refused = await strategyEarnUnwindForSale({ ...stepArgs(f, async calls => { batches.push(calls.map(c => (decode(c.data).args as readonly unknown[])[2]));
    if (batches.length === 1) throw new Error('UserOperation reverted during simulation'); return tx([]); }).args, steps, partial: true });
  assert.deepEqual([batches.length, batches[1], typeof refused], [2, [maxUint256, maxUint256], 'string']);
  assert.match(String(refused), /先還清再取回 tx=.*；下一輪再賣$/);
});

test('sell all with the vault short and no USDT (v1): once nothing can be repaid or taken back the exit sells what is free; any other sale still waits', async () => {
  // After the first round: the vault is empty, the account has no USDT, and what stays posted is just what the rest of the
  // debt needs (0.34 of 10 shares); 9.66 shares are back in the account. Before, the sale waited for USDT only it could bring.
  const sliver: Fake = { ids: [qqq.marketId], collateral: { [qqq.marketId]: 34n * E16 }, balances: { [qqq.collateral]: 966n * E16 }, prices: { [qqq.collateral]: 100n * 10n ** 8n },
    statuses: { [qqq.marketId]: status({ debt: 10n * E18, vaultAssets: 0n, health: { collateralValue: 34n * E18, liquidationValue: 0n, debtValue: 10n * E18, healthFactor: 0n } }) } };
  const steps = [{ tokenIn: qqq.collateral, amountIn: 10n * E18 }];
  const sent: unknown[] = [];
  const send = async (calls: { to: Address; data: Hex }[]) => { sent.push(calls); return tx([]); };
  const exit = await strategyEarnUnwindForSale({ ...stepArgs(sliver, send).args, steps, exit: true });
  assert.ok(exit !== null && typeof exit === 'object', String(exit));
  assert.deepEqual([exit.stuck, exit.needUsdtRaw], [[qqq.collateral], 10n * E18 + 10n * E18 / 1_000n]);
  assert.match(exit.note, /^\[STRATEGY_EARN_UNWINDING\] QQQB vault 不足/);
  // A partial sale (not an exit) and a dry run keep the old answer: a note, the sale waits.
  assert.match(await strategyEarnUnwindForSale({ ...stepArgs(sliver, send).args, steps }) ?? '', /^\[STRATEGY_EARN_UNWINDING\] QQQB vault 不足/);
  assert.equal(typeof await strategyEarnUnwindForSale({ ...stepArgs(sliver, send, true).args, steps, exit: true }), 'string');
  assert.deepEqual(sent, [], 'nothing is sent while nothing can be repaid or taken back');
  // A price tick that frees under 1% of what is posted is not worth a UserOp every round: still "sell what is free".
  const tick = { ...sliver, statuses: { [qqq.marketId]: status({ debt: 10n * E18, vaultAssets: 0n, health: { collateralValue: 3402n * E16, liquidationValue: 0n, debtValue: 10n * E18, healthFactor: 0n } }) } };
  assert.equal(typeof await strategyEarnUnwindForSale({ ...stepArgs(tick, send).args, steps, exit: true }), 'object');
  assert.deepEqual(sent, []);
  // The sale brought USDT in: the next round repays everything and takes the last shares back, as before.
  const paid = { ...sliver, balances: { [qqq.collateral]: 0n, [usdt]: 900n * E18 } };
  assert.match(await strategyEarnUnwindForSale({ ...stepArgs(paid, send).args, steps: [{ tokenIn: qqq.collateral, amountIn: 34n * E16 }], exit: true }) as string, /賣出前已還款取回：QQQB 先還清再取回/);
  assert.equal(sent.length, 1);
  // A market the session key cannot call still holds the sale back (the owner has to renew): never "sell what is free".
  const noKey = await strategyEarnUnwindForSale({ ...stepArgs(sliver, send).args, sendable: [], steps, exit: true });
  assert.match(noKey as string, /需要 owner 續期/);
});

test('sell-all hold: USDT an open "sell all" still needs for its repayment — twice the shortfall, at least 1 USDT; nothing without a request, a debt or a shortfall', async () => {
  const { holdForShortfall, v1ShortfallUsdt, v2ShortfallUsdt, sellAllCashHold, SELL_ALL_HOLD_MIN_RAW } = await import('../src/sell-all-hold.js');
  assert.deepEqual([holdForShortfall(0n), holdForShortfall(-5n), holdForShortfall(1n), holdForShortfall(E18), holdForShortfall(3n * E18)], [0n, 0n, E18, 2n * E18, 6n * E18]);
  assert.equal(SELL_ALL_HOLD_MIN_RAW, E18);
  // Routing v2, the portfolio 37 state: 0.0000004 USD1 owed beyond an empty box, no USD1 in the account.
  const USD1 = '0x00000000000000000000000000000000000000d1' as Address, v2 = { loanTokens: { USDT: usdt, USD1 } };
  const token = (t: Address, debtRaw: bigint, idleRaw = 0n, cashRaw = 0n) => ({ token: t, debtRaw, idleRaw, cashRaw, allowanceRaw: 0n });
  const vault = (t: Address, assetsRaw: bigint) => ({ vault: { token: t } as never, assetsRaw, since: 0, shouldExit: false });
  const sliver = v2ShortfallUsdt(v2, { tokens: { USD1: token(USD1, 407_371_640_080n) }, vaults: [] });
  assert.ok(sliver > 407_371_640_080n && sliver < 2n * 407_371_640_080n + 10n ** 9n, String(sliver));
  assert.equal(holdForShortfall(sliver), E18, 'a sliver of debt holds 1 USDT');
  // The box (vault + idle) or the account's own loan token covers the debt as read: nothing is held.
  assert.equal(v2ShortfallUsdt(v2, { tokens: { USD1: token(USD1, 19n * E18) }, vaults: [vault(USD1, 19n * E18)] }), 0n);
  assert.equal(v2ShortfallUsdt(v2, { tokens: { USD1: token(USD1, 19n * E18, 10n * E18, 9n * E18) }, vaults: [] }), 0n);
  assert.equal(v2ShortfallUsdt(v2, { tokens: { USD1: token(USD1, 0n) }, vaults: [] }), 0n);
  // A real gap: 19 owed, 14 in the box -> 5 short; bought with interest, buffer and the pool's 0.3% -> a little over 5, held twice.
  const five = v2ShortfallUsdt(v2, { tokens: { USD1: token(USD1, 19n * E18) }, vaults: [vault(USD1, 14n * E18)] });
  assert.ok(five > 5n * E18 && five < 51n * E18 / 10n, String(five));
  assert.equal(holdForShortfall(five), five * 2n);
  // A USDT debt is paid from the account's USDT directly: its own USDT is never counted as cover.
  const direct = v2ShortfallUsdt(v2, { tokens: { USDT: token(usdt, 10n * E18, 0n, 500n * E18) }, vaults: [vault(usdt, 4n * E18)] });
  assert.ok(direct > 6n * E18 && direct < 601n * E16, String(direct));
  // v1: its own bar is vault >= debt x 1.001. Lista per market; Venus one debt against all of its vaults.
  const st = (debt: bigint, vaultAssets: bigint) => ({ debt, vaultAssets });
  assert.equal(v1ShortfallUsdt([]), 0n);
  assert.equal(v1ShortfallUsdt([{ protocol: 'lista', st: st(100n * E18, 101n * E18) }]), 0n);
  assert.equal(v1ShortfallUsdt([{ protocol: 'lista', st: st(100n * E18, 100n * E18) }]), E18 / 10n);
  assert.equal(v1ShortfallUsdt([{ protocol: 'lista', st: st(100n * E18, 0n) }, { protocol: 'lista', st: st(0n, 0n) }]), 1001n * E18 / 10n);
  assert.equal(v1ShortfallUsdt([{ protocol: 'venus', st: st(100n * E18, 60n * E18) }, { protocol: 'venus', st: st(100n * E18, 30n * E18) }]), 101n * E18 / 10n);
  // The whole read: no open request -> one query and no chain read at all; an open one -> the shortfall of both generations.
  const reads: string[] = [];
  const deps = (open: boolean, debt = 407_371_640_080n, deployed = true) => ({
    query: async (sql: string, params: readonly unknown[]) => { reads.push(`sql ${params.join(',')}`); assert.match(sql, /sell_all_requested/); assert.match(sql, /state = 'pending'/); return { rows: open ? [{}] : [] }; },
    v2: () => deployed ? { v2: v2 as never, reader: {
      touched: async () => { reads.push('touched'); return { enabled: true, routes: debt > 0n ? ['0x01' as Hex] : [], vaults: [], rewardRecipient: account }; },
      account: async () => { reads.push('account'); return { tokens: { USD1: token(USD1, debt) }, vaults: [] } as never; } } } : null,
    v1: () => ({ chain: { head: async () => ({ number: 1n, timestamp: 1n }), accountMarkets: async () => { reads.push('v1'); return [] as Hex[]; }, status: async () => status() }, markets: [] }) });
  const input = { chainId: 97, portfolioId: 37, account };
  assert.equal(await sellAllCashHold(input, deps(false)), 0n);
  assert.deepEqual(reads, ['sql 97,37'], 'no open sell all: nothing else is read');
  assert.equal(await sellAllCashHold(input, deps(true)), E18);
  assert.equal(await sellAllCashHold(input, deps(true, 0n)), 0n, 'sold and repaid: nothing is held, everything is withdrawable');
  assert.equal(await sellAllCashHold(input, deps(true, 407_371_640_080n, false)), 0n, 'a chain without routing v2 and nothing on v1');
  // Unreadable chain while a request is open: the caller is told (it must not answer with a guess).
  await assert.rejects(sellAllCashHold(input, { ...deps(true), v2: () => ({ v2: v2 as never, reader: { touched: async () => { throw new Error('rpc down'); }, account: async () => { throw new Error('unused'); } } }) }), /rpc down/);
});

// ---- keeper: Lista claim and ledger ------------------------------------------------------------------------------

test('#204 keeper: Lista incentives claimed per market id; deleverage and claims written to the portfolio ledger; drill accounts are not', async () => {
  const drill = '0x5683cf2f1e038e8c4444bf853a31dbf4c841bf54' as Address;
  const f: Fake = { ids: [qqq.marketId], statuses: { [qqq.marketId]: status({ shouldDeleverage: true, ltv: 50n * E16, deleverageLtv: 46n * E16, debt: 1n }) },
    rewards: { vault: 0n, collateral: 2n * E16 } };
  const sent: string[] = [];
  const writer: StrategyKeeperWriter = {
    deleverage: async (a, id) => { sent.push(`deleverage:${a}`); logIndex = 0; return tx([log(ex, 'Deleveraged', 5, { account: a, marketId: id, repaid: 7n * E18, ltvBefore: 50n * E16, ltvAfter: 35n * E16 })]); },
    claim: async () => { throw new Error('vault/vToken claim not expected for Lista'); },
    claimLista: async (id, a) => { sent.push(`lista:${id}:${a}`); logIndex = 5; return tx([log(S.listaMoolah, 'RewardClaimed', 3, { id, account: a, amount: 2n * E16 })]); },
  };
  const recorded: StrategyEarnEvent[] = [];
  const r = await runStrategyEarnRound({ dryRun: false, log: () => {} }, { chainId: 97, chain: chainOf(f), writer, env: { STRATEGY_EARN_DRILL_ACCOUNTS: drill },
    accounts: async () => [{ account, portfolioId: 3 }], ledger: { record: async (_c, e) => { recorded.push(...e); } } });
  assert.deepEqual([r?.deleveraged, r?.claimed, r?.failed], [2, 2, 0]);
  assert.deepEqual(sent, [`deleverage:${account}`, `lista:${qqq.listaId}:${account}`, `deleverage:${drill}`, `lista:${qqq.listaId}:${drill}`]);
  assert.deepEqual(recorded.map(e => [e.portfolioId, e.account, e.kind, e.asset, e.amountRaw]), [[3, account, 'deleverage', 'QQQB', 7n * E18], [3, account, 'claim', 'QQQB', 2n * E16]]);
  // A ledger outage never fails or repeats the chain action.
  const logs: string[] = [];
  const again = await runStrategyEarnRound({ dryRun: false, log: l => logs.push(l) }, { chainId: 97, chain: chainOf(f), writer,
    accounts: async () => [{ account, portfolioId: 3 }], ledger: { record: async () => { throw new Error('db down'); } } });
  assert.deepEqual([again?.deleveraged, again?.failed], [1, 0]);
  assert.ok(logs.some(l => l.includes('帳本寫入失敗（鏈上已完成）')));
});

// ---- holdings: posted shares count, never as free balance -------------------------------------------------------

test('#204 readPositions extraBalances: posted shares are added to that asset; unknown asset or negative amount throws', async () => {
  const usdtToken = { address: T.contracts.usdt as Address, symbol: 'USDT', usdtPool: null, isNumeraire: true };
  const results = (balance: bigint) => encodeAbiParameters([{ type: 'tuple[]', components: [{ type: 'bool', name: 'success' }, { type: 'bytes', name: 'returnData' }] }],
    [[{ success: true, returnData: encodeAbiParameters([{ type: 'uint256' }], [balance]) }, { success: true, returnData: encodeAbiParameters([{ type: 'uint8' }], [18]) }]]);
  const client = createPublicClient({ chain: bscTestnet, transport: custom({ request: async ({ method }: { method: string }) => {
    if (method === 'eth_getBalance') return '0x0';
    if (method === 'eth_call') return results(5n * E18);
    throw new Error('unexpected ' + method);
  } }) });
  const snap = await readPositions(client as never, { portfolioId: 1, account, tokens: [usdtToken], block: 1n, extraBalances: new Map([[usdt, 2n * E18]]) });
  assert.equal(snap.holdings[0]?.amountWei, 7n * E18);
  await assert.rejects(readPositions(client as never, { portfolioId: 1, account, tokens: [usdtToken], block: 1n, extraBalances: new Map([[nvda.collateral, 1n]]) }), /不在策略資產內/);
  await assert.rejects(readPositions(client as never, { portfolioId: 1, account, tokens: [usdtToken], block: 1n, extraBalances: new Map([[usdt, -1n]]) }), /為負數/);
});

// ---- scheduler wiring -------------------------------------------------------------------------------------------

function legacyScheduler(plan: ReturnType<typeof mixRuntimeFixture>['plan'], steps: { tokenIn: Address; amountIn: bigint }[] | null) {
  const calls: string[] = [];
  const query: SchedulerQueryFn = async sql => {
    if (sql.includes("to_regclass('mixes')")) return { rows: [{ ready: true }] };
    if (sql.includes('for update of p skip locked')) return { rows: [{ personal_mix: false, portfolio_id: '1', strategy_id: '1', address: plan.account,
      account_type: 'KERNEL', schedule: { kind: 'interval', intervalSeconds: 3600 }, version: 1, schedule_state: 'active' }] };
    return { rows: [] };
  };
  const deps: SchedulerDeps = { query, chainId: 97, executor: T.contracts.executor, withTransaction: work => work({ query }),
    withPortfolioLock: async (_id, work) => work(), withDexLock: async (_c, work) => work(), dexGate: async () => null, readGlobalPaused: async () => false,
    log: () => {}, yieldRound: async () => ({ checked: 0, blocked: 0 }), strategyEarnRound: async () => null, planPortfolio: async () => plan,
    planRebalance: async (): Promise<RebalancePlan> => steps === null ? { kind: 'noop', reason: 'nothing' } : { kind: 'ready', deadline: 2_000_000_000n, rationale: 'fixture',
      steps: steps.map(s => ({ ...s, tokenOut: T.contracts.usdt as Address, amountOutMin: 1n, oracleFloor: 1n, venue: T.contracts.executor as Address, data: '0x' as Hex })) },
    checkTradingMinimums: async () => { calls.push('minimums'); return '[FIXTURE_STOP] stop before quoting'; },
    executeRebalance: async () => { throw new Error('unexpected send'); },
    strategyEarn: { open: async (_d, dry) => { calls.push(`open:${dry}`); return 'opened'; }, unwind: async (_d, s, dry) => { calls.push(`unwind:${dry}:${s.length}`); return '[STRATEGY_EARN_UNWINDING] fixture'; } } };
  return { deps, calls };
}

test('#204 scheduler: noop runs auto-open; a sale with posted shares unwinds and blocks before quoting; no posted shares skips it', async () => {
  const at = new Date('2026-11-23T15:30:00Z'); // US market hours
  const { plan } = mixRuntimeFixture();
  const balanced = { ...plan, report: { ...plan.report!, needsRebalance: false } };
  const a = legacyScheduler(balanced, null);
  const noop = await runSchedulerOnce({ dryRun: false, now: at, skipAlerts: true }, a.deps);
  assert.equal(noop.results[0]?.outcome, 'noop'); assert.deepEqual(a.calls, ['open:false']);
  const drifted = { ...plan, report: { ...plan.report!, needsRebalance: true }, snapshot: { ...plan.snapshot, strategyEarnCollateral: [{ asset: T.assets.NVDAB.token.toLowerCase() as Address, marketId: nvda.marketId, amount: E18 }] } };
  const b = legacyScheduler(drifted, [{ tokenIn: T.assets.NVDAB.token as Address, amountIn: E18 }]);
  const blocked = await runSchedulerOnce({ dryRun: true, now: at, skipAlerts: true }, b.deps);
  assert.equal(blocked.results[0]?.outcome, 'blocked'); assert.equal(blocked.results[0]?.reason, '[STRATEGY_EARN_UNWINDING] fixture');
  assert.deepEqual(b.calls, ['unwind:true:1']);
  // The step error never becomes a send: blocked with a retry note.
  b.deps.strategyEarn = { open: async () => null, unwind: async () => { throw new Error('bundler down'); } };
  const failed = await runSchedulerOnce({ dryRun: false, now: at, skipAlerts: true }, b.deps);
  assert.match(failed.results[0]?.reason ?? '', /^\[STRATEGY_EARN_UNWIND_FAILED\]/);
  // Nothing posted: the unwind step is not consulted and the round goes on to the normal checks.
  const c = legacyScheduler({ ...drifted, snapshot: plan.snapshot }, [{ tokenIn: T.assets.NVDAB.token as Address, amountIn: E18 }]);
  const normal = await runSchedulerOnce({ dryRun: true, now: at, skipAlerts: true }, c.deps);
  assert.equal(normal.results[0]?.reason, '[FIXTURE_STOP] stop before quoting'); assert.deepEqual(c.calls, ['minimums']);
  // Personal mixes never reach Strategy Earn steps (default steps return null for them; injected ones are not called on mix paths).
  void parseAbi; void encodeFunctionData;
});

test('2026-11-25 portfolio 33: an open "sell all" keeps the scheduler from auto-opening again — the round only sells, as a full exit', async () => {
  const at = new Date('2026-11-23T15:30:00Z'); // US market hours
  const { plan } = mixRuntimeFixture();
  // After the `/close` round repaid and took the shares back: consent still on, the shares idle in the account, weights on target.
  const idle = { ...plan, report: { ...plan.report!, needsRebalance: false } };
  const sale: RebalancePlan = { kind: 'ready', purpose: 'exit', deadline: 2_000_000_000n, rationale: 'sell all',
    steps: [{ tokenIn: T.assets.NVDAB.token as Address, tokenOut: T.contracts.usdt as Address, amountIn: E18, amountOutMin: 1n, oracleFloor: 1n, venue: T.contracts.executor as Address, data: '0x' as Hex }] };
  const scheduler = (request: boolean, planSellAll: () => Promise<RebalancePlan>) => {
    const f = legacyScheduler(idle, null), calls: string[] = [], writes: string[] = [];
    const query: SchedulerQueryFn = async (sql, params) => {
      const result = await f.deps.query!(sql, params);
      if (sql.includes('for update of p skip locked')) return { rows: result.rows.map(row => ({ ...(row as object), sell_all: request })) };
      if (sql.includes('sell_all_requested') || sql.includes('schedule_state')) writes.push(sql.replace(/\s+/g, ' '));
      return result;
    };
    const deps: SchedulerDeps = { ...f.deps, query, withTransaction: work => work({ query }), planSellAll,
      strategyEarn: { open: async () => { calls.push('open'); return 'opened'; }, unwind: async (_d, steps, _dry, exit) => { calls.push(`unwind:${steps.length}:exit=${exit}`); return null; } } };
    return { deps, calls, writes, fixture: f.calls };
  };
  // What happened on 2026-11-25: no request anywhere, so the next quiet round opened the strategy again.
  const before = scheduler(false, async () => { throw new Error('not a sell-all round'); });
  assert.equal((await runSchedulerOnce({ dryRun: false, now: at, skipAlerts: true }, before.deps)).results[0]?.outcome, 'noop');
  assert.deepEqual(before.calls, ['open']);
  // With the request open the same account is not opened: the round plans the sale, unwinds as a full exit and goes on to the sale's own checks.
  const selling = scheduler(true, async () => sale);
  const round = await runSchedulerOnce({ dryRun: false, now: at, skipAlerts: true }, selling.deps);
  assert.equal(round.results[0]?.reason, '[FIXTURE_STOP] stop before quoting');
  assert.deepEqual(selling.calls, ['unwind:1:exit=true']); assert.deepEqual(selling.fixture, ['minimums']);
  // A round that cannot sell (market closed, oracle down) does not open either, and the request stays as it is.
  const closed = scheduler(true, async () => ({ kind: 'blocked', reason: '[MARKET_CLOSED] 股票休市，等待交易時段' }));
  const waiting = await runSchedulerOnce({ dryRun: false, now: at, skipAlerts: true }, closed.deps);
  assert.equal(waiting.results[0]?.outcome, 'blocked'); assert.match(waiting.results[0]?.reason ?? '', /MARKET_CLOSED/);
  assert.deepEqual(closed.calls, []);
  assert.ok(!closed.writes.some(sql => /set state = '(delivered|failed)'|set schedule_state/.test(sql)), closed.writes.join('\n'));
  // Nothing left but cash: the request is closed and the portfolio is left paused, without opening.
  const done = scheduler(true, async () => ({ kind: 'noop', reason: 'nothing to sell' }));
  const last = await runSchedulerOnce({ dryRun: false, now: at, skipAlerts: true }, done.deps);
  assert.match(last.results[0]?.reason ?? '', /SELL_ALL_DONE/); assert.deepEqual(done.calls, []);
  assert.ok(done.writes.some(sql => sql.includes("set schedule_state = 'paused'")) && done.writes.some(sql => sql.includes("set state = 'delivered'")), done.writes.join('\n'));
});

test('market-hours bypass: with the stock session closed the scheduler still rebalances and sells for the listed test wallet, and for nobody else', async () => {
  const sunday = new Date('2026-11-22T16:00:00Z'), canary = '0xd3ab39b62e221bf9e8ba19fe19b2638767d3d6d9', other = '0x00000000000000000000000000000000000000a1';
  const NVDA = T.assets.NVDAB.token as Address;
  // `smart_accounts.owner` is looked up once per account per process, so every case has its own account.
  let n = 0;
  const scheduler = (owner: string | null, sellAll: boolean) => {
    const base = mixRuntimeFixture().plan, account = ('0x' + (0xb0 + n++).toString(16).repeat(20)) as Address;
    const plan = { ...base, account, report: { ...base.report!, needsRebalance: true } };
    const f = legacyScheduler(plan, [{ tokenIn: NVDA, amountIn: E18 }]), owners: (string | null | undefined)[] = [];
    const query: SchedulerQueryFn = async (sql, params) => {
      if (sql.includes('select owner from smart_accounts')) { assert.deepEqual(params, [97, account.toLowerCase()]); return { rows: owner === null ? [] : [{ owner }] }; }
      const result = await f.deps.query!(sql, params);
      return sql.includes('for update of p skip locked') ? { rows: result.rows.map(row => ({ ...(row as object), sell_all: sellAll })) } : result;
    };
    const planRebalance = f.deps.planRebalance!;
    const deps: SchedulerDeps = { ...f.deps, query, withTransaction: work => work({ query }),
      planRebalance: async input => { owners.push(input.owner); return planRebalance(input); },
      planSellAll: async input => { owners.push(input.owner); return { ...await planRebalance(input), purpose: 'exit' } as RebalancePlan; },
      strategyEarn: { open: async () => null, unwind: async () => null } };
    return { deps, calls: f.calls, owners };
  };
  for (const sellAll of [false, true]) {
    for (const owner of [other, null]) {
      const s = scheduler(owner, sellAll), round = await runSchedulerOnce({ dryRun: false, now: sunday, skipAlerts: true }, s.deps);
      assert.equal(round.results[0]?.outcome, 'blocked'); assert.equal(round.results[0]?.reason, '[MARKET_CLOSED] 股票休市，等待交易時段');
      assert.deepEqual(s.calls, []); assert.deepEqual(s.owners, [owner]);
    }
    // The listed wallet: the same stock sale passes the session check and goes on to the ordinary checks.
    const s = scheduler(canary, sellAll), round = await runSchedulerOnce({ dryRun: false, now: sunday, skipAlerts: true }, s.deps);
    assert.equal(round.results[0]?.reason, '[FIXTURE_STOP] stop before quoting'); assert.deepEqual(s.calls, ['minimums']); assert.deepEqual(s.owners, [canary]);
  }
  // Chain 56 has no stock calendar and no bypass: the owner is not even looked up there.
  const mainnet = scheduler(canary, false);
  const query = mainnet.deps.query!;
  mainnet.deps.chainId = 56;
  mainnet.deps.query = async (sql, params) => { assert.ok(!sql.includes('select owner from smart_accounts'), 'no owner lookup on chain 56'); return query(sql, params); };
  mainnet.deps.withTransaction = work => work({ query: mainnet.deps.query! });
  await runSchedulerOnce({ dryRun: false, now: sunday, skipAlerts: true }, mainnet.deps);
  assert.deepEqual(mainnet.owners, [null]);
});

// ---- cre8-contracts#67: every launch-fund holding has a market --------------------------------------------------

const bySymbol = (symbol: string) => { const m = markets.find(x => x.symbol === symbol); assert.ok(m, symbol); return m; };
const LEGACY = ['0xfa06dd03eff35e3337a8b5b93a8a7943155b4f20e4d19bb0583db20bdd9f5415', '0x00f2152bbbefde7b3e65c4b7de0af83a87875c02b6c84ef96410ac14edd850fe',
  '0x4632539a0ba6e5e9843b401d97b66b8b34d23fdab2005feacefd5452055c410e', '0xd8def95e75d2489c340ac4d9769646707cf55d17d7aa7f8644c89b64b41844e7',
  '0x208d888e7c3d5ef4d9ccc51083daffe7ddfbce978d339ce258544022cfd9804a'];

test('#67 market table: 31 markets (registry max 32), #65 rows first and unchanged, new rows Lista, no leveraged / DOGE / satellites', () => {
  assert.equal(markets.length, 31);
  assert.deepEqual(STRATEGY_EARN_LEGACY_MARKET_IDS, LEGACY);
  assert.deepEqual(markets.slice(0, 5).map(m => [m.symbol, m.marketId, m.protocol]), [['NVDAB', LEGACY[0], 'venus'], ['TSLAB', LEGACY[1], 'venus'],
    ['SPCXB', LEGACY[2], 'venus'], ['QQQB', LEGACY[3], 'lista'], ['MSTRB', LEGACY[4], 'lista']]);
  assert.equal(new Set(markets.map(m => m.marketId)).size, 31); assert.equal(new Set(markets.map(m => m.symbol)).size, 31);
  assert.equal(new Set(markets.map(m => m.collateral)).size, 31, 'one market per asset');
  for (const m of markets.slice(5)) {
    assert.equal(m.protocol, 'lista', m.symbol); assert.equal(m.collateralVToken, null, m.symbol); assert.match(m.listaId ?? '', /^0x[0-9a-f]{64}$/, m.symbol);
    assert.match(m.marketId, /^0x[0-9a-f]{64}$/, m.symbol);
  }
  for (const absent of ['TQQQB', 'SOXLB', 'DOGE', 'AMCB', 'DJTB', 'CYPHB', 'PENGB', 'MRVLB', 'RDDTB']) assert.equal(markets.some(m => m.symbol === absent), false, absent);
  for (const sym of ['AAPLB', 'MSFTB', 'GOOGLB', 'AMZNB', 'METAB', 'INTCB', 'AVGOB', 'SPYB', 'BTCB', 'WBNB', 'XAUt', 'SKHYB', 'MUB', 'SNDKB', 'COINB', 'BMNRB', 'BNCB']) bySymbol(sym);
  // Collateral decimals come from the profile: XAUt is 6 on chain 97.
  assert.equal(bySymbol('XAUt').decimals, 6); assert.equal(bySymbol('AAPLB').decimals, 18);
  for (const m of markets) assert.equal(m.decimals, (T.assets as Record<string, { decimals: number }>)[m.symbol]?.decimals, m.symbol);
});

test('#67 session keys: a renewal installs every market; a key renewed before #67 keeps its five, rebuilds exactly and asks for renewal', async () => {
  const current = describePolicies({ executorAddress: T.contracts.executor, validUntil: 2_000_000_000, chainId: 97, yieldAccount: account, borrowAccount: account });
  assert.equal(borrowKeyMarkets(current, account)?.length, 31); assert.equal(borrowAuthorized(current, account), true);
  const legacy = describePolicies({ executorAddress: T.contracts.executor, validUntil: 2_000_000_000, chainId: 97, yieldAccount: account, borrowAccount: account,
    borrowMarkets: STRATEGY_EARN_LEGACY_MARKET_IDS as Hex[] });
  // The pre-#67 shape: ONE_OF over exactly the five #65 ids, in order.
  const borrowPerms = (snap: unknown) => (snap as { call: { permissions: { target: string; rules: { params: string[] }[] }[] } }).call.permissions
    .filter(p => p.target.toLowerCase() === S.executor);
  assert.equal(borrowPerms(legacy).length, 4);
  for (const p of borrowPerms(legacy)) assert.deepEqual(p.rules[1]?.params.map(x => x.toLowerCase()), LEGACY);
  assert.deepEqual(borrowKeyMarkets(legacy, account), LEGACY);
  assert.equal(borrowAuthorized(legacy, account), false, 'a buy that wants the new markets asks for a renewal');
  assert.equal(borrowKeyMarkets(legacy, '0x' + '12'.repeat(20) as Address), null);
  // Any other list (subset, reordered, extra) is neither installable nor recognised.
  for (const bad of [LEGACY.slice(0, 4), [...LEGACY].reverse(), [...LEGACY, markets[5]!.marketId], markets.map(m => m.marketId).slice(1)]) {
    assert.throws(() => borrowSessionPermissions(account, bad as Hex[]), /市場清單/);
  }
  const reordered = JSON.parse(JSON.stringify(legacy)) as { call: { permissions: { target: string; rules: { params: string[] }[] }[] } };
  for (const p of reordered.call.permissions.filter(x => x.target.toLowerCase() === S.executor)) p.rules[1]!.params.reverse();
  assert.equal(borrowKeyMarkets(reordered, account), null);
  // buildSessionPermissions rebuilds the legacy key to a stable id that differs from today's.
  const client = createPublicClient({ chain: bscTestnet, transport: custom({ request: async () => { throw new Error('no rpc'); } }) });
  const key = '0x' + '34'.repeat(20) as Address;
  const build = (borrowMarkets?: Hex[]) => buildSessionPermissions({ publicClient: client as never, sessionKeyAddress: key, executorAddress: T.contracts.executor,
    validUntil: 2_000_000_000, yieldAccount: account, borrowAccount: account, ...(borrowMarkets ? { borrowMarkets } : {}) });
  const [a, b, now31] = await Promise.all([build(LEGACY as Hex[]), build(LEGACY as Hex[]), build()]);
  assert.equal(a.permissionId, b.permissionId); assert.notEqual(a.permissionId, now31.permissionId);
  assert.deepEqual(borrowKeyMarkets(a.policySnapshot, account), LEGACY);
  // POST auto with a pre-#67 key: renewal required.
  const f: Fake = { weights: [{ asset: bySymbol('AAPLB').collateral, weightBps: 10_000 }], prices: { [bySymbol('AAPLB').collateral]: 300n * 10n ** 8n } };
  const r = await createStrategyEarn({ v2: null, chainId: 97, chain: () => chainOf(f), owned: owned(), query: keyRows(legacy) }).auto(3, account, { budgetRaw: String(1000n * E18) });
  assert.ok('authorization' in r); assert.equal(r.authorization, 'renewal_required');
  assert.deepEqual(r.assets.map(x => x.asset), ['AAPLB']);
});

test('#67 auto-open / unwind with a pre-#67 key: only its five markets are sent; the others wait for the owner renewal', async () => {
  const aapl = bySymbol('AAPLB');
  const f: Fake = {
    policies: { [nvda.marketId]: { maxDebt: 1000n * E18, enabled: true }, [aapl.marketId]: { maxDebt: 1000n * E18, enabled: true } },
    balances: { [nvda.collateral]: 10n * E18, [aapl.collateral]: 10n * E18 },
    prices: { [nvda.collateral]: 100n * 10n ** 8n, [aapl.collateral]: 300n * 10n ** 8n },
  };
  let sent: { to: Address; data: Hex }[] = [];
  const legacyArgs = (fake: Fake) => ({ ...stepArgs(fake, async calls => { sent = calls; return tx([]); }).args, sendable: LEGACY as Hex[] });
  const note = await strategyEarnAutoOpen(legacyArgs(f));
  assert.deepEqual([...new Set(sent.map(c => decode(c.data).args[1]))], [nvda.marketId]);
  assert.match(note ?? '', /已自動開啟：NVDAB .*；AAPLB 等 owner 續期策略加息授權$/);
  // Only new markets wanted: nothing is sent.
  sent = [];
  const onlyNew = await strategyEarnAutoOpen(legacyArgs({ ...f, policies: { [aapl.marketId]: { maxDebt: 1000n * E18, enabled: true } } }));
  assert.deepEqual(sent, []); assert.match(onlyNew ?? '', /AAPLB 等 owner 續期.*未送出/);
  // A current key (no `sendable`) opens both.
  sent = [];
  await strategyEarnAutoOpen(stepArgs(f, async calls => { sent = calls; return tx([]); }).args);
  assert.deepEqual([...new Set(sent.map(c => decode(c.data).args[1]))], [nvda.marketId, aapl.marketId]);
  // Unwind before selling posted AAPLB with a pre-#67 key: blocked with a reason, nothing sent.
  sent = [];
  const blocked = await strategyEarnUnwindForSale({ ...legacyArgs({ ids: [aapl.marketId], collateral: { [aapl.marketId]: 10n * E18 }, balances: {} }),
    steps: [{ tokenIn: aapl.collateral, amountIn: 5n * E18 }] });
  assert.deepEqual(sent, []); assert.match(blocked ?? '', /^\[STRATEGY_EARN_UNWINDING\] AAPLB 需要 owner 續期/);
});

test('#67 XAUt (6 decimals): values, auto-open plan and the vault-short take-back use the token\'s own decimals', async () => {
  const xaut = bySymbol('XAUt');
  const price = 3866n * 10n ** 8n;
  // 2 XAUt = 2e6 raw -> 7,732 USD; target 35% x 98% = 2,652.076 USDT.
  const f: Fake = { policies: { [xaut.marketId]: { maxDebt: 10_000n * E18, enabled: true } }, balances: { [xaut.collateral]: 2_000_000n },
    prices: { [xaut.collateral]: price }, statuses: { [xaut.marketId]: status({ targetLtv: 35n * E16 }) } };
  let sent: { to: Address; data: Hex }[] = [];
  await strategyEarnAutoOpen(stepArgs(f, async calls => { sent = calls; return tx([]); }).args);
  assert.deepEqual(sent.map(c => [decode(c.data).functionName, decode(c.data).args[2]]), [['executeSupplyCollateral', 2_000_000n], ['executeBorrow', 2652076n * 10n ** 15n]]);
  // Dust boundary: a target debt of 1 USD (2.857 USD of XAUt at 35%). 739 raw = 2.8570 USD -> 0.99994 -> skipped; 740 raw = 2.8608 USD -> 1.0013 -> opened.
  sent = [];
  await strategyEarnAutoOpen(stepArgs({ ...f, balances: { [xaut.collateral]: 739n } }, async calls => { sent = calls; return tx([]); }).args);
  assert.deepEqual(sent, []);
  await strategyEarnAutoOpen(stepArgs({ ...f, balances: { [xaut.collateral]: 740n } }, async calls => { sent = calls; return tx([]); }).args);
  assert.equal(sent.length, 2);
  // POST auto: 50% of 1,000 USDT new money + 1 XAUt held (3,866 USD) = 4,366 x 35% x 98% x 110% = 1,647.2918 USDT ceiling.
  const r = await createStrategyEarn({ v2: null, chainId: 97, chain: () => chainOf({ ...f, balances: { [xaut.collateral]: 1_000_000n }, weights: [{ asset: xaut.collateral, weightBps: 5000 }] }),
    owned: owned(), query: keyRows(null) }).auto(3, account, { budgetRaw: String(1000n * E18) });
  assert.ok('assets' in r);
  assert.deepEqual(r.assets, [{ asset: 'XAUt', status: 'ready', maxDebtRaw: String(16472918n * 10n ** 14n), extraApyBps: 137 }]);
  // Vault short before a sale: 1,000 owed, 600 in the vault, 10 XAUt (38,660 USD) posted -> keep (400 + 1 raw) / 35% x 102% = 1,165.71 USD = 0.301531 XAUt.
  let calls: { to: Address; data: Hex }[] = [];
  const short: Fake = { ids: [xaut.marketId], collateral: { [xaut.marketId]: 10_000_000n }, balances: {}, prices: { [xaut.collateral]: price },
    statuses: { [xaut.marketId]: status({ debt: 1000n * E18, vaultAssets: 600n * E18, targetLtv: 35n * E16,
      health: { collateralValue: 38_660n * E18, liquidationValue: 0n, debtValue: 1000n * E18, healthFactor: 0n } }) } };
  await strategyEarnUnwindForSale({ ...stepArgs(short, async c => { calls = c; return tx([]); }).args, steps: [{ tokenIn: xaut.collateral, amountIn: 9_900_000n }] });
  const take = decode(calls[1]!.data).args[2] as bigint;
  assert.ok(take > 9_698_000n && take < 9_699_000n, String(take));
});

test('POST confirm: the owner\'s own turn-on / turn-off is recorded from its verified receipt; pending, reverted and foreign events record nothing', async () => {
  logIndex = 0;
  const other = '0x' + '77'.repeat(20) as Address;
  const mined = tx([log(ex, 'CollateralSupplied', 4, { account, marketId: nvda.marketId, amount: 2n * E18, collateral: 2n * E18 }),
    log(ex, 'Borrowed', 5, { account, marketId: nvda.marketId, amount: 30n * E18, vaultShares: 1n, ltv: 1n }),
    log(ex, 'Borrowed', 5, { account: other, marketId: nvda.marketId, amount: 99n * E18, vaultShares: 1n, ltv: 1n }),
    log('0x' + '66'.repeat(20), 'Borrowed', 5, { account, marketId: nvda.marketId, amount: 1n, vaultShares: 1n, ltv: 1n })]);
  const recorded: StrategyEarnEvent[] = [];
  let receipt: (StrategyEarnTx & { success: boolean }) | null = null;
  const earn = createStrategyEarn({ v2: null, chainId: 97, owned: owned(), chain: () => ({ ...chainOf({}), receipt: async () => receipt }),
    ledger: { record: async (_c, e) => { recorded.push(...e); } } });
  const hash = '0x' + 'ab'.repeat(32);
  assert.deepEqual(await earn.confirm(3, account, { txHash: hash }), { status: 'pending', recorded: 0 });
  receipt = { ...mined, success: false };
  assert.deepEqual(await earn.confirm(3, account, { txHash: hash }), { status: 'reverted', recorded: 0 });
  receipt = { ...mined, success: true };
  assert.deepEqual(await earn.confirm(3, account, { txHash: hash }), { status: 'confirmed', recorded: 1, kinds: ['open'] });
  assert.deepEqual(recorded.map(e => [e.portfolioId, e.kind, e.asset, e.amountRaw, e.collateralRaw]), [[3, 'open', 'NVDAB', 30n * E18, 2n * E18]]);
  await assert.rejects(earn.confirm(3, account, { txHash: '0x12' }), (e: unknown) => e instanceof AppError && e.status === 400);
  await assert.rejects(earn.confirm(3, account, { hash }), (e: unknown) => e instanceof AppError && e.status === 400);
});

// ---- routing v2: a repayment short of USDT (cash raise) and a full exit with shares that cannot be freed yet ------------

test('routing v2 scheduler: a quiet round whose repayment is short of USDT sells a little of what is free (cash raise), once per 30 minutes; never on a dry run', async () => {
  const { cashRaiseUsdE8, planCashRaise, resetCashRaises, withoutPosted } = await import('../src/scheduler.js');
  resetCashRaises(); resetStrategyEarnOpenBackoff();
  const at = new Date('2026-11-23T15:30:00Z'); // US market hours
  const { plan } = mixRuntimeFixture();
  const balanced = { ...plan, report: { ...plan.report!, needsRebalance: false } };
  const NVDA = T.assets.NVDAB.token as Address, USDT = T.contracts.usdt as Address, need = 215_811_746_640_776_207n;
  const a = legacyScheduler(balanced, null);
  const raised: bigint[] = [];
  a.deps.strategyEarn = { open: async (_d, dry, _held, onCashNeed) => { a.calls.push(`open:${dry}`); onCashNeed?.(need); return null; }, unwind: async () => { a.calls.push('unwind'); return null; } };
  a.deps.planCashRaise = async (_input, n) => { raised.push(n); a.calls.push('raise'); return { kind: 'ready', deadline: 2_000_000_000n, rationale: 'fixture raise',
    steps: [{ tokenIn: NVDA, tokenOut: USDT, amountIn: E18, amountOutMin: 1n, oracleFloor: 1n, venue: T.contracts.executor as Address, data: '0x' as Hex }] }; };
  a.deps.refreshFloors = async () => { a.calls.push('floors'); return { ok: false, kind: 'quote-failed', reason: '[FIXTURE_STOP] before sending' }; };
  // The quiet round asks for the need; the same pipeline then carries the small sale — past the between-assets minimums
  // (not asked: a raise is deliberately small) up to the point where it would be sent.
  const first = await runSchedulerOnce({ dryRun: false, now: at, skipAlerts: true }, a.deps);
  assert.deepEqual([a.calls, raised, first.results[0]?.reason], [['open:false', 'raise', 'floors'], [need], '[FIXTURE_STOP] before sending']);
  // The next rounds inside 30 minutes report the need again but do not sell again.
  a.calls.length = 0;
  const second = await runSchedulerOnce({ dryRun: false, now: new Date(at.getTime() + 10 * 60_000), skipAlerts: true }, a.deps);
  assert.deepEqual([a.calls, second.results[0]?.outcome], [['open:false'], 'noop']);
  a.calls.length = 0;
  await runSchedulerOnce({ dryRun: false, now: new Date(at.getTime() + 31 * 60_000), skipAlerts: true }, a.deps);
  assert.deepEqual(a.calls, ['open:false', 'raise', 'floors']);
  // A dry run never raises.
  resetCashRaises(); a.calls.length = 0;
  await runSchedulerOnce({ dryRun: true, now: at, skipAlerts: true }, a.deps);
  assert.deepEqual(a.calls, ['open:true']);
  // Nothing could be planned (market closed, nothing free): that is not an attempt — the very next round tries again.
  resetCashRaises(); a.calls.length = 0;
  const ready = a.deps.planCashRaise!;
  a.deps.planCashRaise = async () => { a.calls.push('raise'); return { kind: 'blocked', reason: '[STRATEGY_CASH_RAISE] nothing free' }; };
  const none = await runSchedulerOnce({ dryRun: false, now: at, skipAlerts: true }, a.deps);
  assert.deepEqual([a.calls, none.results[0]?.outcome], [['open:false', 'raise'], 'blocked']);
  a.deps.planCashRaise = ready; a.calls.length = 0;
  await runSchedulerOnce({ dryRun: false, now: new Date(at.getTime() + 60_000), skipAlerts: true }, a.deps);
  assert.deepEqual(a.calls, ['open:false', 'raise', 'floors']);

  // How much: twice the need, at least 1 USDT.
  assert.deepEqual([cashRaiseUsdE8(need), cashRaiseUsdE8(3n * E18)], [100_000_000n, 600_000_000n]);
  // What is sold: the asset with the most free (not posted) value whose market is open; posted shares are never offered.
  const posted = { ...plan, snapshot: { ...plan.snapshot, strategyEarnCollateral: [{ asset: NVDA.toLowerCase() as Address, marketId: nvda.marketId, amount: 64n * E18 }] } };
  const sold: { holdings: [string, bigint][]; usd: bigint }[] = [];
  const sell = async (input: { plan: typeof plan }, usd: bigint): Promise<RebalancePlan> => { sold.push({ holdings: input.plan.snapshot.holdings.map(h => [h.asset.toLowerCase(), h.amountWei]), usd }); return { kind: 'ready', deadline: 1n, rationale: 'sold', purpose: 'exit', steps: [] }; };
  const out = await planCashRaise({ portfolioId: 1, account: plan.account, plan: posted }, need, { chainId: 97, now: at, sell });
  // WBNB (65 free) is chosen over NVDAB (1 free of 65); only it and the cash row are shown to the seller; never an "exit".
  assert.deepEqual(sold, [{ holdings: [[USDT.toLowerCase(), 0n], [T.assets.WBNB.token.toLowerCase(), 65n * E18]], usd: 100_000_000n }]);
  assert.ok(out.kind === 'ready' && out.purpose === undefined && /STRATEGY_CASH_RAISE/.test(out.rationale));
  // Everything is posted (or the stock market is closed): nothing to sell this round.
  const all = { ...plan, snapshot: { ...plan.snapshot, strategyEarnCollateral: [NVDA, T.assets.WBNB.token as Address].map(asset => ({ asset: asset.toLowerCase() as Address, marketId: nvda.marketId, amount: 65n * E18 })) } };
  assert.match(((await planCashRaise({ portfolioId: 1, account: plan.account, plan: all }, need, { chainId: 97, now: at, sell })) as { reason: string }).reason, /STRATEGY_CASH_RAISE/);
  const sunday = new Date('2026-11-22T15:30:00Z');
  const stocksOnly = { ...plan, snapshot: { ...plan.snapshot, holdings: plan.snapshot.holdings.filter(h => h.asset !== T.assets.WBNB.token) } };
  assert.equal((await planCashRaise({ portfolioId: 1, account: plan.account, plan: stocksOnly }, need, { chainId: 97, now: sunday, sell })).kind, 'blocked');
  // The chain-97 market-hours bypass wallet (deploy/market-hours-bypass.json) sells its stock on a Sunday too; any other owner does not.
  assert.equal((await planCashRaise({ portfolioId: 1, account: plan.account, plan: stocksOnly, owner: '0x00000000000000000000000000000000000000a1' }, need, { chainId: 97, now: sunday, sell })).kind, 'blocked');
  assert.equal((await planCashRaise({ portfolioId: 1, account: plan.account, plan: stocksOnly, owner: '0xD3Ab39B62E221bF9E8bA19fE19b2638767d3D6D9' }, need, { chainId: 97, now: sunday, sell })).kind, 'ready');

  // withoutPosted: the plan a full exit sells from while some shares stay posted — only those assets, by the snapshot's own numbers.
  const cut = withoutPosted(posted, [NVDA]);
  assert.deepEqual(cut.snapshot.holdings.map(h => h.amountWei), [1n * E18, 65n * E18, 0n]);
  assert.deepEqual([cut.snapshot.strategyEarnCollateral, cut.report!.totalUsdE8, posted.snapshot.holdings[0]!.amountWei], [undefined, 66n * 100_000_000n, 65n * E18]);
  assert.deepEqual(withoutPosted(posted, []).snapshot.holdings.map(h => h.amountWei), [65n * E18, 65n * E18, 0n]);
});

test('routing v2 scheduler: a full exit whose posted shares cannot be freed yet sells what is free now; any other sale raises the missing USDT first', async () => {
  const { resetCashRaises } = await import('../src/scheduler.js');
  resetCashRaises();
  const at = new Date('2026-11-23T15:30:00Z');
  const { plan } = mixRuntimeFixture();
  const NVDA = T.assets.NVDAB.token as Address, USDT = T.contracts.usdt as Address;
  const drifted = { ...plan, report: { ...plan.report!, needsRebalance: true }, snapshot: { ...plan.snapshot, strategyEarnCollateral: [{ asset: NVDA.toLowerCase() as Address, marketId: nvda.marketId, amount: 2n * E18 }] } };
  const wait = { note: '[STRATEGY_EARN_UNWINDING] NVDAB cannot be freed yet', stuck: [NVDA.toLowerCase() as Address], needUsdtRaw: 3n * 10n ** 17n };
  const step = (amountIn: bigint) => ({ tokenIn: NVDA, tokenOut: USDT, amountIn, amountOutMin: 1n, oracleFloor: 1n, venue: T.contracts.executor as Address, data: '0x' as Hex });
  // Full exit: the planner is asked again with the posted shares taken out, and the sale goes on with that plan.
  const b = legacyScheduler(drifted, null);
  const seen: bigint[] = [];
  b.deps.planRebalance = async input => { const held = input.plan.snapshot.holdings.find(h => h.asset === NVDA)!.amountWei; seen.push(held); return { kind: 'ready', deadline: 2_000_000_000n, rationale: 'fixture exit', purpose: 'exit', steps: [step(held)] }; };
  const unwinds: bigint[] = [];
  b.deps.strategyEarn = { open: async () => null, unwind: async (_d, steps, _dry, exit) => { unwinds.push(steps[0]!.amountIn); assert.equal(exit, true); return wait; } };
  b.deps.checkTradingMinimums = async (steps, purpose) => { b.calls.push(`minimums:${purpose}:${steps[0]!.amountIn}`); return '[FIXTURE_STOP] stop before quoting'; };
  const exit = await runSchedulerOnce({ dryRun: false, now: at, skipAlerts: true }, b.deps);
  assert.deepEqual([seen, unwinds, b.calls, exit.results[0]?.reason], [[65n * E18, 63n * E18], [65n * E18], [`minimums:exit:${63n * E18}`], '[FIXTURE_STOP] stop before quoting']);
  // Nothing free to sell: the exit waits with the reason, nothing is sent.
  seen.length = 0; b.calls.length = 0;
  b.deps.planRebalance = async input => { const held = input.plan.snapshot.holdings.find(h => h.asset === NVDA)!.amountWei; seen.push(held); return seen.length === 1 ? { kind: 'ready', deadline: 2_000_000_000n, rationale: 'x', purpose: 'exit', steps: [step(held)] } : { kind: 'noop', reason: 'nothing to sell' }; };
  const stuck = await runSchedulerOnce({ dryRun: false, now: at, skipAlerts: true }, b.deps);
  assert.deepEqual([stuck.results[0]?.outcome, stuck.results[0]?.reason, b.calls], ['blocked', wait.note, []]);
  // An ordinary sale (a rebalance): it is not cut down; the USDT the top-up is short of is raised first, by a small sale.
  const c = legacyScheduler(drifted, [{ tokenIn: NVDA, amountIn: 65n * E18 }]);
  const raises: bigint[] = [];
  // (The hook answers as the real one does: only a sale that needs posted shares has to wait; the raise sells free ones.)
  c.deps.strategyEarn = { open: async () => null, unwind: async (_d, steps) => steps[0]!.amountIn > 63n * E18 ? wait : null };
  c.deps.planCashRaise = async (_i, n) => { raises.push(n); return { kind: 'ready', deadline: 2_000_000_000n, rationale: 'raise', steps: [step(E18)] }; };
  c.deps.refreshFloors = async () => ({ ok: false, kind: 'quote-failed', reason: '[FIXTURE_STOP] before sending' });
  const ordinary = await runSchedulerOnce({ dryRun: false, now: at, skipAlerts: true }, c.deps);
  assert.deepEqual([raises, ordinary.results[0]?.reason], [[3n * 10n ** 17n], '[FIXTURE_STOP] before sending']);
  // ...and when it waits for something that is not USDT (the 24-hour window), the sale just waits.
  resetCashRaises(); raises.length = 0;
  c.deps.strategyEarn = { open: async () => null, unwind: async (_d, steps) => steps[0]!.amountIn > 63n * E18 ? { ...wait, needUsdtRaw: 0n } : null };
  const waiting = await runSchedulerOnce({ dryRun: false, now: at, skipAlerts: true }, c.deps);
  assert.deepEqual([raises, waiting.results[0]?.outcome, waiting.results[0]?.reason], [[], 'blocked', wait.note]);
});

test('minimum size (2026-11-26), v1: the buy quote, the owner\'s switch and the scheduler share one floor (a 1 USD loan) and answer too_small, not temporarily unavailable', async () => {
  const weights = [{ asset: nvda.collateral, weightBps: 5000 }, { asset: tsla.collateral, weightBps: 5000 }];
  const earn = (f: Fake) => createStrategyEarn({ v2: null, chainId: 97, chain: () => chainOf(f), owned: owned(), query: keyRows(borrowSnap) });
  // A minimum buy, 50 USDT over two assets: 25 USD each at 30% = 7.50. Both get consent — and both are what the scheduler
  // opens (until now it skipped any holding under 10 USD, whatever the quote had said).
  const buy = await earn({ weights }).auto(3, account, { budgetRaw: String(50n * E18) });
  assert.ok('assets' in buy);
  assert.deepEqual([buy.status, buy.assets.map(a => [a.asset, a.status])], ['ready', [['NVDAB', 'ready'], ['TSLAB', 'ready']]]);
  // 5 USDT: 2.50 each would borrow 0.75. Nothing opens, and the answer says it is the amount.
  assert.deepEqual(await earn({ weights }).auto(3, account, { budgetRaw: String(5n * E18) }), { status: 'unavailable', reason: 'too_small', message: 'Amount too small.', assets: [
    { asset: 'NVDAB', status: 'unavailable', reason: 'too_small', message: 'Amount too small.' }, { asset: 'TSLAB', status: 'unavailable', reason: 'too_small', message: 'Amount too small.' }] });
  // 6 USDT at 80/20: NVDAB 4.80 (1.44) opens, TSLAB 1.20 (0.36) does not — no consent is asked for it.
  const part = await earn({ weights: [{ asset: nvda.collateral, weightBps: 8000 }, { asset: tsla.collateral, weightBps: 2000 }] }).auto(3, account, { budgetRaw: String(6n * E18) });
  assert.ok('assets' in part && 'calls' in part);
  assert.deepEqual(part.assets.map(a => [a.asset, a.status, 'reason' in a ? a.reason : null]), [['NVDAB', 'ready', null], ['TSLAB', 'unavailable', 'too_small']]);
  assert.equal(part.calls!.filter(c => decode(c.data).functionName === 'setBorrowPolicy').length, 1);
  // The owner's switch on what is held: 3 USD of NVDAB (0.90) is too small, 4 USD (1.20) opens.
  const held: Fake = { balances: { [nvda.collateral]: 4n * E18 } };
  assert.deepEqual(await earn(held).open(3, account, { asset: 'NVDAB', collateralRaw: String(3n * E18) }), { status: 'unavailable', asset: 'NVDAB', reason: 'too_small', message: 'Amount too small.' });
  assert.equal((await earn(held).open(3, account, { asset: 'NVDAB', collateralRaw: String(4n * E18) })).status, 'ready');
  // The scheduler after the fill: 25 USD of NVDAB opens (7.35 borrowed), 3 USD of TSLAB stays as it is.
  let sent: { to: Address; data: Hex }[] = [];
  const f: Fake = { policies: { [nvda.marketId]: { maxDebt: 100n * E18, enabled: true }, [tsla.marketId]: { maxDebt: 100n * E18, enabled: true } }, balances: { [nvda.collateral]: 25n * E18, [tsla.collateral]: 3n * E18 } };
  await strategyEarnAutoOpen(stepArgs(f, async calls => { sent = calls; return tx([]); }).args);
  assert.deepEqual(sent.map(c => [decode(c.data).functionName, decode(c.data).args[1], decode(c.data).args[2]]), [['executeSupplyCollateral', nvda.marketId, 25n * E18], ['executeBorrow', nvda.marketId, 735n * E16]]);
  // The public list: the least value of an asset the strategy opens with, 1 USD ÷ 30% plus 5% headroom, rounded up to a cent.
  const view = await createStrategyEarn({ v2: null, chainId: 97, chain: () => chainOf({}), marketsCacheMs: 0, mainnetRates: { get: async () => null } }).markets();
  assert.deepEqual(view.markets.filter(m => m.asset === 'NVDAB' || m.asset === 'TSLAB').map(m => [m.asset, m.minValueUsd]), [['NVDAB', 3.5], ['TSLAB', 3.5]]);
});
