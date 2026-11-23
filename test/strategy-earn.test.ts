import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData, encodeFunctionData, maxUint256, parseAbi } from 'viem';
import type { Address, Hex } from 'viem';
import { loadRateLimitConfig } from '../src/config.js';
import { AppError, ForbiddenError } from '../src/errors.js';
import { validateSponsoredCalls } from '../src/paymaster.js';
import { EXECUTOR_ABI } from '../src/chain.js';
import { MemoryRateLimitStore, RequestRateLimiter } from '../src/ratelimit.js';
import { createServer } from '../src/server.js';
import {
  assertNotStrategyVault, borrowPlan, closeCalls, createStrategyEarn, extraApy, isStrategyVault, openCalls, runStrategyEarnRound, strategyEarnDrillAccounts,
  STRATEGY_EARN_97 as S, STRATEGY_EARN_ABI, strategyMarkets, usdValue,
} from '../src/strategy-earn.js';
import type { StatusReading, StrategyEarnChain, StrategyKeeperWriter } from '../src/strategy-earn.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
import { yieldProfile } from '../src/yield-domain.js';
import { YIELD_REGISTRY_ABI } from '../src/yield-abi.js';
import { config, kernelCall, operation, SENDER, TEST_SIGNER } from './fixtures/paymaster.js';
import { UnauthorizedError } from '../src/errors.js';

const E18 = 10n ** 18n;
const E16 = 10n ** 16n; // 1% as an 18-decimal rate
const account = SENDER.toLowerCase() as Address;
const markets = strategyMarkets();
const nvda = markets[0], qqq = markets[3];
assert.ok(nvda && qqq);
const isError = (status: number, code: string) => (e: unknown) => e instanceof AppError && e.status === status && e.code === code;
const status = (patch: Partial<StatusReading> = {}): StatusReading => ({ gate: 0, shouldDeleverage: false, shouldUnwind: false,
  borrowRate: 250n * E16 / 100n, collateralRate: 0n, vaultRate: 450n * E16 / 100n, collateralIncentiveRate: 50n * E16 / 100n, borrowIncentiveRate: 0n,
  vaultIncentiveRate: 50n * E16 / 100n, borrowUtilizationBps: 0n, vaultUtilizationBps: 0n, ltv: 0n, targetLtv: 30n * E16, deleverageLtv: 40n * E16,
  liquidationLtv: 60n * E16, debt: 0n, vaultAssets: 0n, health: { collateralValue: 0n, liquidationValue: 0n, debtValue: 0n, healthFactor: maxUint256 }, ...patch });

test('#199 guard: strategy vault (address or market id) is refused; yield profile drops it even if a manifest lists it', () => {
  assert.throws(() => assertNotStrategyVault({ marketId: S.earnVaultMarketId.toUpperCase().replace('0X', '0x') }), isError(403, 'STRATEGY_VAULT_FORBIDDEN'));
  assert.throws(() => assertNotStrategyVault({ address: '0x2E915B874A5A544736F5AFD97F3FA1DD45D417A9' }), isError(403, 'STRATEGY_VAULT_FORBIDDEN'));
  assert.doesNotThrow(() => assertNotStrategyVault({ marketId: T.yieldMarkets[0]?.marketId, address: T.yieldMarkets[0]?.receipt }));
  assert.equal(isStrategyVault({}), false);
  const current = yieldProfile();
  assert.ok(current); assert.equal(current.markets.some(m => isStrategyVault({ marketId: m.marketId }) || isStrategyVault({ address: m.receipt })), false);
  const base = T.yieldMarkets[0]; assert.ok(base);
  for (const strategy of [{ ...base, marketId: S.earnVaultMarketId }, { ...base, marketId: '0x' + '77'.repeat(32), receipt: S.earnVault, target: S.earnVault }]) {
    const synced = yieldProfile({ ...T, yieldMarkets: [...T.yieldMarkets, strategy] });
    assert.ok(synced);
    assert.equal(synced.markets.length, T.yieldMarkets.length, 'strategy vault filtered out');
  }
  assert.throws(() => yieldProfile({ ...T, yieldMarkets: [{ ...base, marketId: S.earnVaultMarketId }] }));
});

const chain97 = { CHAIN_ID: '97', RPC_URL: 'http://127.0.0.1:8558', PAYMASTER_SIGNER_PRIVATE_KEY: TEST_SIGNER };
const sponsored = (target: string, data: Hex) => validateSponsoredCalls(operation({ callData: kernelCall(data, target as Hex) }), config(chain97));
const forbidden = (target: string, data: Hex) => assert.throws(() => sponsored(target, data), isError(403, 'PAYMASTER_CALL_FORBIDDEN'), `${target} ${data.slice(0, 10)}`);
const enc = (fn: string, args: readonly unknown[]) => encodeFunctionData({ abi: STRATEGY_EARN_ABI, functionName: fn as never, args: args as never });

test('#199 paymaster: AtpExecutor can never move or be approved the strategy vault; borrow executor calls are bound to the sender', () => {
  // The key safety rule: no approval of strategy vault shares to AtpExecutor, and no AtpExecutor yield call on that market.
  forbidden(S.earnVault, enc('approve', [T.contracts.executor, maxUint256]));
  forbidden(S.earnVault, enc('approve', [SENDER, 1n]));
  for (const fn of ['executeSupply', 'executeWithdraw'] as const) {
    forbidden(T.contracts.executor, encodeFunctionData({ abi: EXECUTOR_ABI, functionName: fn, args: [SENDER, S.earnVaultMarketId, 1n, 1n, 2_000_000_000n] } as never));
  }
  forbidden(T.contracts.yieldRegistry, encodeFunctionData({ abi: YIELD_REGISTRY_ABI, functionName: 'setYieldPolicy', args: [S.earnVaultMarketId, 1n, true] } as never));
  // Allowed: every call of an open/close plan, one by one.
  const plan = [...openCalls(nvda, account, 5n * E18, 100n * E18, 120n * E18, 2_000_000_000n), ...openCalls(qqq, account, 1n, 0n, 1n, 2_000_000_000n),
    ...closeCalls(nvda, account, 2_000_000_000n)];
  for (const c of plan) sponsored(c.to, c.data);
  sponsored(S.executor, enc('executeDeleverage', [account, nvda.marketId]));
  sponsored(S.registry, enc('setBorrowPolicy', [nvda.marketId, 0n, false]));
  // Rejected: another account, unknown market, zero amounts, consent with zero ceiling, wrong delegate, foreign spender.
  forbidden(S.executor, enc('executeBorrow', ['0x' + '99'.repeat(20), nvda.marketId, 1n, 2_000_000_000n]));
  forbidden(S.executor, enc('executeBorrow', [account, '0x' + '11'.repeat(32), 1n, 2_000_000_000n]));
  forbidden(S.executor, enc('executeSupplyCollateral', [account, nvda.marketId, 0n, 2_000_000_000n]));
  forbidden(S.executor, encodeFunctionData({ abi: parseAbi(['function executeBorrowFor(address,bytes32,uint256)']), functionName: 'executeBorrowFor', args: [account, nvda.marketId, 1n] }));
  forbidden(S.registry, enc('setBorrowPolicy', [nvda.marketId, 0n, true]));
  forbidden(S.registry, enc('setBorrowPolicy', [S.earnVaultMarketId, 1n, true]));
  forbidden(S.venusComptroller, enc('updateDelegate', [SENDER, true]));
  forbidden(S.listaMoolah, enc('setAuthorization', [SENDER, true]));
  forbidden(S.venusComptroller, enc('setAuthorization', [S.executor, true]));
  forbidden(nvda.collateral, enc('approve', [SENDER, 1n]));
  // A non-strategy asset may still be approved to AtpExecutor (existing flow) but not to AtpBorrowExecutor.
  // TQQQB: leveraged, never a strategy market (cre8-contracts#67 lists AAPLB and the other launch-fund holdings).
  const other = T.assets.TQQQB?.token; assert.ok(other);
  sponsored(other, enc('approve', [T.contracts.executor, maxUint256]));
  forbidden(other, enc('approve', [S.executor, maxUint256]));
});

test('#199 extra APY: (vault + vault incentive - borrow + borrow incentive) x ratio + collateral + incentives, can be negative', () => {
  const s = status();
  assert.deepEqual(extraApy(s, s.targetLtv), { totalBps: 125, breakdown: { vaultBps: 450, vaultIncentiveBps: 50, borrowBps: 250, borrowIncentiveBps: 0,
    ratioBps: 3000, carryBps: 75, collateralBps: 0, collateralIncentiveBps: 50 } });
  assert.equal(extraApy(s, 0n).totalBps, 50); // no borrowing yet: only the collateral incentive
  assert.equal(extraApy(status({ borrowRate: 9n * E16, collateralIncentiveRate: 0n }), 50n * E16).totalBps, -200); // (5 - 9) x 50%
  assert.equal(extraApy(status({ borrowIncentiveRate: 50n * E16 / 100n, collateralRate: 10n * E16 / 100n }), 35n * E16).totalBps, 165);
});

test('#199 borrow plan: 2% under target LTV, existing debt counted, never negative, consent ceiling +10%', () => {
  // 1,000 USD collateral at 30% target -> 300 x 98% = 294 USDT at a 1.00 USDT price.
  const plan = borrowPlan({ existingCollateralValue: 0n, addedCollateralValue: 1000n * E18, existingDebtValue: 0n, targetLtv: 30n * E16, usdtPriceE8: 10n ** 8n, currentDebtRaw: 0n });
  assert.deepEqual(plan, { borrowRaw: 294n * E18, maxDebtRaw: 3234n * E17() });
  const topUp = borrowPlan({ existingCollateralValue: 1000n * E18, addedCollateralValue: 1000n * E18, existingDebtValue: 294n * E18, targetLtv: 30n * E16, usdtPriceE8: 10n ** 8n, currentDebtRaw: 294n * E18 });
  assert.equal(topUp.borrowRaw, 294n * E18);
  assert.equal(borrowPlan({ existingCollateralValue: 1000n * E18, addedCollateralValue: 0n, existingDebtValue: 500n * E18, targetLtv: 30n * E16, usdtPriceE8: 10n ** 8n, currentDebtRaw: 500n * E18 }).borrowRaw, 0n);
  assert.equal(borrowPlan({ existingCollateralValue: 0n, addedCollateralValue: 1000n * E18, existingDebtValue: 0n, targetLtv: 30n * E16, usdtPriceE8: 2n * 10n ** 8n, currentDebtRaw: 0n }).borrowRaw, 147n * E18);
  assert.throws(() => borrowPlan({ existingCollateralValue: 0n, addedCollateralValue: 1n, existingDebtValue: 0n, targetLtv: 1n, usdtPriceE8: 0n, currentDebtRaw: 0n }));
  assert.equal(usdValue(5n * E18, 16241300000n), 81206500000000000000n * 10n);
  function E17() { return 10n ** 17n; }
});

test('#199 calls: open approves only AtpBorrowExecutor and borrows into the vault; close repays first, then withdraws', () => {
  const open = openCalls(nvda, account, 5n * E18, 100n * E18, 110n * E18, 1_700_000_000n);
  const decoded = open.map(c => ({ to: c.to.toLowerCase(), ...decodeFunctionData({ abi: STRATEGY_EARN_ABI, data: c.data }) }));
  assert.deepEqual(decoded.map(d => [d.to, d.functionName]), [[S.venusComptroller, 'updateDelegate'], [S.registry, 'setBorrowPolicy'], [nvda.collateral, 'approve'],
    [T.contracts.usdt.toLowerCase(), 'approve'], [S.earnVault, 'approve'], [S.executor, 'executeSupplyCollateral'], [S.executor, 'executeBorrow']]);
  for (const d of decoded.filter(x => x.functionName === 'approve')) assert.equal(String(d.args?.[0]).toLowerCase(), S.executor);
  assert.equal(open.some(c => c.data.toLowerCase().includes(T.contracts.executor.slice(2).toLowerCase())), false, 'AtpExecutor never appears');
  assert.deepEqual(decoded[6]?.args, [account, nvda.marketId, 100n * E18, 1_700_000_000n]);
  assert.equal(openCalls(qqq, account, 1n, 0n, 1n, 1n)[0]?.to.toLowerCase(), S.listaMoolah);
  assert.equal(openCalls(nvda, account, 1n, 0n, 1n, 1n).some(c => decodeFunctionData({ abi: STRATEGY_EARN_ABI, data: c.data }).functionName === 'executeBorrow'), false);
  const close = closeCalls(nvda, account, 1_700_000_000n).map(c => decodeFunctionData({ abi: STRATEGY_EARN_ABI, data: c.data }));
  assert.deepEqual(close.map(c => [c.functionName, c.args]), [['executeRepay', [account, nvda.marketId, maxUint256, true, 1_700_000_000n]],
    ['executeWithdrawCollateral', [account, nvda.marketId, maxUint256, 1_700_000_000n]]]);
});

type Fake = { statuses: Record<string, StatusReading | null>; ids: Hex[]; held: bigint; collateral: bigint; prices: Record<string, bigint>;
  rewards: { vault: bigint; collateral: bigint }; headFails?: boolean;
  policies?: Record<string, { maxDebt: bigint; enabled: boolean }>; weights?: { asset: Address; weightBps: number }[]; balances?: Record<string, bigint> };
function fakeChain(f: Fake): StrategyEarnChain {
  return {
    head: async () => { if (f.headFails) throw new Error('rpc secret'); return { number: 7n, timestamp: 1_795_400_000n }; },
    status: async (id) => { const s = f.statuses[id]; if (!s) throw new Error('read failed'); return s; },
    accountMarkets: async () => f.ids,
    collateral: async () => f.collateral,
    balance: async (token) => f.balances?.[token.toLowerCase()] ?? f.held,
    price: async (asset) => f.prices[asset.toLowerCase()] ?? 10n ** 8n,
    rewards: async () => f.rewards,
    policy: async (_a, id) => f.policies?.[id] ?? { maxDebt: 0n, enabled: false },
    weights: async () => f.weights ?? [],
  };
}
const tx0 = { hash: ('0x' + '01'.repeat(32)) as Hex, blockNumber: 1n, logs: [] };
const noLedger = { record: async () => {} };
const ownedPortfolio = (patch: Record<string, unknown> = {}) => async () => ({ id: 3, userId: account, strategyId: 1, version: 1, scheduleState: 'active',
  createdAt: '2026-11-23T00:00:00Z', chainId: 97, accountAddress: account, ownerAddress: account, existingKeyRefs: [], ...patch });

test('#199 service: market quotes with gate reasons; outages are "temporarily unavailable", not error codes', async () => {
  const f: Fake = { statuses: Object.fromEntries(markets.map(m => [m.marketId, status()])), ids: [], held: 0n, collateral: 0n, prices: {}, rewards: { vault: 0n, collateral: 0n } };
  f.statuses[qqq.marketId] = status({ gate: 3 });
  f.statuses[markets[4]?.marketId ?? ''] = null;
  const earn = createStrategyEarn({ chainId: 97, chain: () => fakeChain(f), owned: ownedPortfolio() as never });
  const list = await earn.markets();
  assert.deepEqual(list.markets.map(m => [m.asset, m.status, m.reason, m.extraApyBps]), [['NVDAB', 'open', null, 125], ['TSLAB', 'open', null, 125],
    ['SPCXB', 'open', null, 125], ['QQQB', 'unavailable', 'vault_utilization', 125], ['MSTRB', 'unavailable', 'data_unavailable', null],
    ...markets.slice(5).map(m => [m.symbol, 'open', null, 125])]);
  f.headFails = true;
  const down = await earn.markets();
  assert.equal(down.updatedAt, null); assert.ok(down.markets.every(m => m.status === 'unavailable' && m.message === 'Temporarily unavailable.'));
  assert.equal((await earn.portfolio(3, account)).status, 'unavailable');
  assert.deepEqual(await earn.open(3, account, { asset: 'NVDAB', collateralRaw: '1' }), { status: 'unavailable', asset: 'NVDAB', reason: 'data_unavailable', message: 'Temporarily unavailable.' });
  await assert.rejects(createStrategyEarn({ chainId: 56, chain: () => fakeChain(f) }).markets(), isError(404, 'STRATEGY_EARN_NOT_CONFIGURED'));
});

test('#199 portfolio view: net value = collateral + vault - debt per position, kept separate; open plan and its guards', async () => {
  const f: Fake = { statuses: { [nvda.marketId]: status({ ltv: 25n * E16, debt: 250n * E18, vaultAssets: 251n * E18,
    health: { collateralValue: 1000n * E18, liquidationValue: 600n * E18, debtValue: 250n * E18, healthFactor: 24n * E17() } }),
    [qqq.marketId]: status({ gate: 4 }) }, ids: [nvda.marketId], held: 10n * E18, collateral: 10n * E18,
    prices: { [nvda.collateral]: 100n * 10n ** 8n }, rewards: { vault: 3n * E16, collateral: 1n * E16 } };
  const earn = createStrategyEarn({ chainId: 97, chain: () => fakeChain(f), owned: ownedPortfolio() as never, now: () => new Date('2026-11-23T00:00:00Z') });
  const view = await earn.portfolio(3, account);
  assert.equal(view.status, 'ok');
  const p = view.positions[0]; assert.ok(p && 'netValueUsd' in p);
  assert.deepEqual([p.asset, p.status, p.collateralValueUsd, p.debtRaw, p.vaultAssetsRaw, p.netValueUsd, p.pendingRewardsRaw, p.ltvBps, p.extraApyBps],
    ['NVDAB', 'on', String(1000n * E18), String(250n * E18), String(251n * E18), String(1001n * E18), String(4n * E16), 2500, 112]);
  // Open: 2 NVDAB (200 USD) on top of 1,000 USD at 30% -> 1,200 x 30% x 98% - 250 = 102.8 USDT.
  const ready = await earn.open(3, account, { asset: 'NVDAB', collateralRaw: String(2n * E18) });
  assert.equal(ready.status, 'ready'); assert.ok('borrowRaw' in ready);
  assert.equal(ready.borrowRaw, String(1028n * E17()));
  assert.equal(ready.calls.length, 7);
  assert.deepEqual(await earn.open(3, account, { asset: 'QQQB', collateralRaw: '1' }), { status: 'unavailable', asset: 'QQQB', reason: 'negative_carry', message: 'Temporarily unavailable.' });
  await assert.rejects(earn.open(3, account, { asset: 'NVDAB', collateralRaw: String(10n * E18 + 1n) }), isError(400, 'INSUFFICIENT_HOLDING'));
  for (const bad of [{ asset: 'TQQQB', collateralRaw: '1' }, { asset: 'NVDAB', collateralRaw: '0' }, { asset: 'NVDAB', collateralRaw: '1.5' }, { asset: 'NVDAB' }, { asset: 'NVDAB', collateralRaw: '1', x: 1 }, null]) {
    await assert.rejects(earn.open(3, account, bad), (e: unknown) => e instanceof AppError && e.status === 400);
  }
  assert.equal((await earn.close(3, account, { asset: 'NVDAB' })).calls.length, 2);
  await assert.rejects(createStrategyEarn({ chainId: 97, chain: () => fakeChain(f), owned: ownedPortfolio({ personalMix: true }) as never }).open(3, account, { asset: 'NVDAB', collateralRaw: '1' }), isError(409, 'MIX_NO_STRATEGY_EARN'));
  await assert.rejects(createStrategyEarn({ chainId: 97, chain: () => fakeChain(f), owned: ownedPortfolio({ chainId: 56 }) as never }).close(3, account, { asset: 'NVDAB' }), isError(403, 'FORBIDDEN'));
  await assert.rejects(createStrategyEarn({ chainId: 97, chain: () => fakeChain(f), owned: (async () => { throw new ForbiddenError('not yours'); }) as never }).portfolio(3, account),
    (e: unknown) => e instanceof AppError && e.status === 403);
  function E17() { return 10n ** 17n; }
});

test('#199 keeper: deleverage/unwind only when the registry says so; dry-run and no key only report; vault reward claimed once per account', async () => {
  const flagged = status({ shouldDeleverage: true, ltv: 40n * E16, debt: 1n });
  const f: Fake = { statuses: { [nvda.marketId]: flagged, [markets[1]?.marketId ?? '']: status({ shouldUnwind: true, debt: 1n }), [qqq.marketId]: status({ debt: 1n }) },
    ids: [nvda.marketId, markets[1]?.marketId as Hex, qqq.marketId], held: 0n, collateral: 0n, prices: {}, rewards: { vault: 10n ** 16n, collateral: 10n ** 16n - 1n } };
  const sent: string[] = [];
  const writer: StrategyKeeperWriter = { deleverage: async (a, id) => { sent.push(`deleverage:${a}:${id}`); return tx0; }, claim: async (target, a) => { sent.push(`claim:${target}:${a}`); return tx0; },
    claimLista: async (id, a) => { sent.push(`lista:${id}:${a}`); return tx0; } };
  const logs: string[] = [];
  const live = await runStrategyEarnRound({ dryRun: false, log: l => logs.push(l) }, { chainId: 97, chain: fakeChain(f), writer, accounts: async () => [{ account, portfolioId: 3 }], ledger: noLedger });
  assert.deepEqual(live, { checked: 3, flagged: 2, deleveraged: 2, claimed: 1, failed: 0, writer: true });
  assert.deepEqual(sent, [`deleverage:${account}:${nvda.marketId}`, `claim:${S.earnVault}:${account}`, `deleverage:${account}:${markets[1]?.marketId}`]);
  // Exactly at the claim threshold claims; 1 below does not (collateral above is 1 wei short).
  sent.length = 0;
  const dry = await runStrategyEarnRound({ dryRun: true, log: l => logs.push(l) }, { chainId: 97, chain: fakeChain(f), writer, accounts: async () => [{ account, portfolioId: 3 }], ledger: noLedger });
  assert.deepEqual([dry?.flagged, dry?.deleveraged, dry?.claimed, sent.length], [2, 0, 0, 0]);
  const noKey = await runStrategyEarnRound({ dryRun: false, log: l => logs.push(l) }, { chainId: 97, chain: fakeChain(f), writer: null, accounts: async () => [{ account, portfolioId: 3 }], ledger: noLedger });
  assert.deepEqual([noKey?.deleveraged, noKey?.writer], [0, false]);
  assert.ok(logs.some(l => l.includes('沒有 keeper 金鑰')));
  // Failures are counted per position and never stop the round.
  const broken: StrategyKeeperWriter = { deleverage: async () => { throw new Error('reverted'); }, claim: async () => tx0, claimLista: async () => tx0 };
  const failed = await runStrategyEarnRound({ dryRun: false, log: () => {} }, { chainId: 97, chain: fakeChain(f), writer: broken, accounts: async () => [{ account, portfolioId: 3 }, { account: '0x' + '22'.repeat(20) as Address, portfolioId: 4 }], ledger: noLedger });
  assert.equal(failed?.failed, 4); assert.equal(failed?.checked, 6);
  assert.equal(await runStrategyEarnRound({ dryRun: false, log: () => {} }, { chainId: 56 }), null);
});

test('#207 keeper drill accounts: merged with DB accounts and de-duplicated; empty/unset adds none; malformed entry throws', async () => {
  const drill = '0x5683Cf2f1e038e8c4444Bf853A31dBF4C841BF54';
  assert.deepEqual(strategyEarnDrillAccounts({}), []);
  assert.deepEqual(strategyEarnDrillAccounts({ STRATEGY_EARN_DRILL_ACCOUNTS: ' ' }), []);
  assert.deepEqual(strategyEarnDrillAccounts({ STRATEGY_EARN_DRILL_ACCOUNTS: ` ${drill}, ${drill.toLowerCase()},,` }), [drill.toLowerCase()]);
  for (const bad of ['0x1234', `${drill},nope`, drill + '00']) {
    assert.throws(() => strategyEarnDrillAccounts({ STRATEGY_EARN_DRILL_ACCOUNTS: bad }), /comma-separated 0x addresses/);
  }
  const f: Fake = { statuses: { [nvda.marketId]: status({ shouldDeleverage: true, ltv: 41n * E16, debt: 1n }) }, ids: [nvda.marketId], held: 0n, collateral: 0n, prices: {},
    rewards: { vault: 0n, collateral: 0n } };
  const sent: string[] = [];
  const writer: StrategyKeeperWriter = { deleverage: async (a) => { sent.push(a); return tx0; }, claim: async () => tx0, claimLista: async () => tx0 };
  const env = { STRATEGY_EARN_DRILL_ACCOUNTS: `${drill},${account}` };
  const r = await runStrategyEarnRound({ dryRun: false, log: () => {} }, { chainId: 97, chain: fakeChain(f), writer, accounts: async () => [{ account, portfolioId: 3 }], ledger: noLedger, env });
  assert.deepEqual([r?.checked, r?.deleveraged], [2, 2]);
  assert.deepEqual(sent, [account, drill.toLowerCase()], 'DB account once, then the drill account');
  // Off chain 97 the variable is never read (no round at all), so a bad value cannot break other chains.
  assert.equal(await runStrategyEarnRound({ dryRun: false, log: () => {} }, { chainId: 56, env: { STRATEGY_EARN_DRILL_ACCOUNTS: 'bad' } }), null);
  await assert.rejects(runStrategyEarnRound({ dryRun: false, log: () => {} }, { chainId: 97, chain: fakeChain(f), writer, accounts: async () => [], ledger: noLedger, env: { STRATEGY_EARN_DRILL_ACCOUNTS: 'bad' } }), /comma-separated/);
});

test('#199 HTTP: public markets with short cache; portfolio routes need login; 405 on wrong methods', async () => {
  const f: Fake = { statuses: Object.fromEntries(markets.map(m => [m.marketId, status()])), ids: [], held: 0n, collateral: 0n, prices: {}, rewards: { vault: 0n, collateral: 0n } };
  const server = createServer({
    strategyEarn: createStrategyEarn({ chainId: 97, chain: () => fakeChain(f), owned: ownedPortfolio() as never }),
    rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore()),
    auth: { authenticate: async (h) => { if (h !== 'Bearer ok') throw new UnauthorizedError('login required'); return account; },
      issueNonce: () => { throw new Error('unused'); }, login: async () => { throw new Error('unused'); }, logout: async () => {} },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`, auth = { authorization: 'Bearer ok' };
  try {
    const list = await fetch(`${base}/strategy-earn/markets`);
    assert.equal(list.status, 200); assert.equal(list.headers.get('cache-control'), 'public, max-age=30');
    assert.equal((await fetch(`${base}/strategy-earn/markets`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/portfolios/3/strategy-earn`)).status, 401);
    assert.equal((await fetch(`${base}/portfolios/3/strategy-earn`, { headers: auth })).status, 200);
    assert.equal((await fetch(`${base}/portfolios/3/strategy-earn/open`, { headers: auth })).status, 405);
    const close = await fetch(`${base}/portfolios/3/strategy-earn/close`, { method: 'POST', headers: auth, body: JSON.stringify({ asset: 'NVDAB' }) });
    assert.equal(close.status, 200);
    assert.equal((await fetch(`${base}/portfolios/3/strategy-earn/open`, { method: 'POST', headers: auth, body: JSON.stringify({ asset: 'TQQQB', collateralRaw: '1' }) })).status, 400);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
