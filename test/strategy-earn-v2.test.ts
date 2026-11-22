import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicClient, custom, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, maxUint256, pad, parseAbi, toFunctionSelector } from 'viem';
import type { AbiEvent, Address, Hex, Log } from 'viem';
import { bscTestnet } from 'viem/chains';
import { ParamCondition } from '@zerodev/permissions/policies';
import { AppError } from '../src/errors.js';
import { validateSponsoredCalls } from '../src/paymaster.js';
import { borrowAuthorized, borrowSessionPermissions, buildSessionPermissions, describePolicies, sessionCallPermissions } from '../src/permissions.js';
import { readPositions } from '../src/positions.js';
import { runSchedulerOnce } from '../src/scheduler.js';
import type { SchedulerDeps, SchedulerQueryFn } from '../src/scheduler.js';
import type { RebalancePlan } from '../src/rebalance-plan.js';
import {
  consentCalls, createStrategyEarn, runStrategyEarnRound, STRATEGY_EARN_97 as S, STRATEGY_EARN_ABI, STRATEGY_EARN_EVENTS_ABI, strategyEarnAutoOpen,
  strategyEarnEvents, strategyEarnMessage, strategyEarnUnwindForSale, strategyMarkets,
} from '../src/strategy-earn.js';
import type { StatusReading, StrategyEarnChain, StrategyEarnEvent, StrategyEarnTx, StrategyKeeperWriter } from '../src/strategy-earn.js';
import { BORROW_SESSION_SELECTORS } from '../src/strategy-earn-guard.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
import { mixRuntimeFixture } from './fixtures/mix.js';
import { config, kernelCall, operation, SENDER, TEST_SIGNER } from './fixtures/paymaster.js';

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

test('#204 session policy: borrow calls only on AtpBorrowExecutor, account pinned, five markets; never AtpExecutor or approvals', () => {
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
  const f: Fake = { weights: [{ asset: nvda.collateral, weightBps: 6000 }, { asset: qqq.collateral, weightBps: 2000 }, { asset: T.assets.WBNB.token.toLowerCase() as Address, weightBps: 2000 }],
    statuses: { [qqq.marketId]: status({ gate: 4 }) }, balances: { [nvda.collateral]: 2n * E18 }, prices: { [nvda.collateral]: 100n * 10n ** 8n } };
  const earn = createStrategyEarn({ chainId: 97, chain: () => chainOf(f), owned: owned(), query: keyRows(borrowSnap) });
  const r = await earn.auto(3, account, { budgetRaw: String(1000n * E18) });
  assert.equal(r.status, 'ready'); assert.ok('calls' in r && r.calls && 'authorization' in r);
  assert.equal(r.authorization, 'ready');
  // NVDAB: 600 USD new + 200 USD held = 800 x 30% x 98% = 235.2 -> x 110% = 258.72 USDT ceiling. QQQB gate closed -> no consent.
  assert.deepEqual(r.assets, [{ asset: 'NVDAB', status: 'ready', maxDebtRaw: String(25872n * E16), extraApyBps: 125 },
    { asset: 'QQQB', status: 'unavailable', reason: 'negative_carry', message: 'Temporarily unavailable.' }]);
  assert.deepEqual(r.calls.map(c => decode(c.data).functionName), ['updateDelegate', 'setBorrowPolicy', 'approve', 'approve', 'approve']);
  // Older key without the #204 calls -> the frontend must also sign the renewal.
  for (const rows of [keyRows(describePolicies({ executorAddress: T.contracts.executor, validUntil: 2_000_000_000, chainId: 97, yieldAccount: account })), keyRows(null)]) {
    const again = await createStrategyEarn({ chainId: 97, chain: () => chainOf(f), owned: owned(), query: rows }).auto(3, account, { budgetRaw: '5' });
    assert.ok('authorization' in again); assert.equal(again.authorization, 'renewal_required');
  }
  // No strategy-earn asset in the portfolio, or every market closed.
  assert.deepEqual(await createStrategyEarn({ chainId: 97, chain: () => chainOf({ weights: [] }), owned: owned(), query: keyRows(null) }).auto(3, account, { budgetRaw: '1' }),
    { status: 'unavailable', reason: 'no_eligible_asset', message: 'Temporarily unavailable.', assets: [] });
  const closed = await createStrategyEarn({ chainId: 97, chain: () => chainOf({ ...f, statuses: { [nvda.marketId]: status({ gate: 1 }), [qqq.marketId]: status({ gate: 2 }) } }), owned: owned(), query: keyRows(null) })
    .auto(3, account, { budgetRaw: '1' });
  assert.equal(closed.status, 'unavailable');
  // Nothing to borrow against (no new money and nothing held) is not a consent.
  const empty = await createStrategyEarn({ chainId: 97, chain: () => chainOf({ ...f, balances: {} }), owned: owned(), query: keyRows(null) }).auto(3, account, { budgetRaw: '0' });
  assert.equal(empty.status, 'unavailable');
  for (const bad of [{ budgetRaw: '-1' }, { budgetRaw: '1.5' }, { budgetRaw: 1 }, {}, { budgetRaw: '1', x: 1 }]) {
    await assert.rejects(earn.auto(3, account, bad), (e: unknown) => e instanceof AppError && e.status === 400);
  }
  await assert.rejects(createStrategyEarn({ chainId: 97, chain: () => chainOf(f), owned: owned({ personalMix: true }) }).auto(3, account, { budgetRaw: '1' }),
    (e: unknown) => e instanceof AppError && e.code === 'MIX_NO_STRATEGY_EARN');
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
  const query = (async (sql: string, params: unknown[]) => { sqls.push(sql); assert.deepEqual(params, [3]); return { rows: [
    { kind: 'deleverage', asset: 'NVDAB', amount_raw: String(6750n * E16), collateral_raw: '0', ltv_before_bps: 4174, ltv_after_bps: 3000, tx_hash: '0x' + '01'.repeat(32), block_number: '9', created_at: new Date('2026-11-23T01:00:00Z') },
  ] }; }) as never;
  const r = await createStrategyEarn({ chainId: 97, chain: () => chainOf({}), owned: owned(), query }).activity(3, account);
  assert.deepEqual(r.activity, [{ kind: 'deleverage', asset: 'NVDAB', amountRaw: String(6750n * E16), collateralRaw: '0', ltvBeforeBps: 4174, ltvAfterBps: 3000,
    txHash: '0x' + '01'.repeat(32), blockNumber: '9', createdAt: '2026-11-23T01:00:00.000Z',
    message: 'NVDAB fell, so we automatically used 67.50 USDT from Earn to stay safe (safety level 41.7% → 30.0%).' }]);
  assert.match(sqls[0] ?? '', /from strategy_earn_events where chain_id = 97 and portfolio_id = \$1 order by block_number desc, log_index desc/);
  await assert.rejects(createStrategyEarn({ chainId: 97, chain: () => chainOf({}), owned: (async () => { throw new AppError(403, 'FORBIDDEN', 'no'); }) as never, query }).activity(3, account),
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
    prices: { [nvda.collateral]: 100n * 10n ** 8n, [tsla.collateral]: 4n * 10n ** 8n, [qqq.collateral]: 100n * 10n ** 8n },
    statuses: { [qqq.marketId]: status({ gate: 2 }) },
  };
  let sent: { to: Address; data: Hex }[] = [];
  const { args, recorded } = stepArgs(f, async calls => { sent = calls; logIndex = 0; return tx([log(ex, 'CollateralSupplied', 4, { account, marketId: nvda.marketId, amount: 10n * E18, collateral: 10n * E18 }),
    log(ex, 'Borrowed', 5, { account, marketId: nvda.marketId, amount: 99n * E18, vaultShares: 1n, ltv: 1n })]); });
  const note = await strategyEarnAutoOpen(args);
  // NVDAB: 1,000 USD x 30% x 98% = 294 USDT planned, capped at 99% of the 100 USDT ceiling. TSLAB 8 USD is dust; QQQB gate closed; MSTRB not consented; SPCXB no policy.
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

test('#204 unwind before a sale: repay first then take shares back; vault short pays what it can and keeps the target ratio', async () => {
  const sell = (token: string, amount: bigint) => [{ tokenIn: token, amountIn: amount }];
  const base: Fake = { ids: [nvda.marketId], collateral: { [nvda.marketId]: 10n * E18 }, balances: { [nvda.collateral]: 1n * E18 },
    prices: { [nvda.collateral]: 100n * 10n ** 8n } };
  const run = async (f: Fake, steps: { tokenIn: string; amountIn: bigint }[], dryRun = false) => {
    let sent: { to: Address; data: Hex }[] = [];
    const s = stepArgs(f, async calls => { sent = calls; return tx([]); }, dryRun);
    const reason = await strategyEarnUnwindForSale({ ...s.args, steps });
    return { reason, calls: sent.map(c => [decode(c.data).functionName, decode(c.data).args]) };
  };
  // Sale fits the free balance, or does not touch a posted asset: nothing to do.
  assert.equal((await run(base, sell(nvda.collateral, E18))).reason, null);
  assert.equal((await run(base, sell(T.assets.WBNB.token, 5n * E18))).reason, null);
  assert.equal((await run({ ...base, collateral: {} }, sell(nvda.collateral, 5n * E18))).reason, null);
  // No debt: just take the shares back.
  const noDebt = await run(base, sell(nvda.collateral, 5n * E18));
  assert.deepEqual(noDebt.calls, [['executeWithdrawCollateral', [account, nvda.marketId, maxUint256, deadline]]]);
  assert.match(noDebt.reason ?? '', /^\[STRATEGY_EARN_UNWINDING\] 賣出前已還款取回：NVDAB 取回 tx=.*下一輪再賣$/);
  // Vault (+ cash) covers the debt: repay everything from the vault first, then take all shares back.
  const covered = { ...base, statuses: { [nvda.marketId]: status({ debt: 300n * E18, vaultAssets: 301n * E18 }) } };
  assert.deepEqual((await run(covered, sell(nvda.collateral, 5n * E18))).calls, [['executeRepay', [account, nvda.marketId, maxUint256, true, deadline]],
    ['executeWithdrawCollateral', [account, nvda.marketId, maxUint256, deadline]]]);
  // Vault short: 300 owed, 200 in the vault + 0 cash -> repay 200 - 1 raw; keep (100 + 1 raw) / 30% x 102% ≈ 340 USD posted -> take back ~6.6 of 10.
  const short = { ...base, statuses: { [nvda.marketId]: status({ debt: 300n * E18, vaultAssets: 200n * E18, health: { collateralValue: 1000n * E18, liquidationValue: 0n, debtValue: 300n * E18, healthFactor: 0n } }) } };
  const partial = await run(short, sell(nvda.collateral, 9n * E18));
  assert.equal(partial.calls.length, 2);
  assert.deepEqual(partial.calls[0], ['executeRepay', [account, nvda.marketId, 200n * E18 - 1n, true, deadline]]);
  const take = (partial.calls[1]?.[1] as readonly unknown[])[2] as bigint;
  assert.ok(take > 6599n * 10n ** 15n && take < 6601n * 10n ** 15n, String(take));
  assert.match(partial.reason ?? '', /vault 不足/);
  // Dry-run reports and sends nothing.
  const dry = await run(covered, sell(nvda.collateral, 5n * E18), true);
  assert.deepEqual(dry.calls, []); assert.match(dry.reason ?? '', /dry-run，未送出/);
  // Every call targets AtpBorrowExecutor and nothing ever approves or calls AtpExecutor.
  let all: { to: Address; data: Hex }[] = [];
  await strategyEarnUnwindForSale({ ...stepArgs(short, async calls => { all = calls; return tx([]); }).args, steps: sell(nvda.collateral, 9n * E18) });
  assert.ok(all.length > 0 && all.every(c => c.to === S.executor));
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
