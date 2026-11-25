import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { toFunctionSelector, createPublicClient, custom, decodeFunctionData, encodeFunctionData, erc20Abi, maxUint256 } from 'viem';
import type { Address, Hex } from 'viem';
import { bscTestnet } from 'viem/chains';
import { encodeCallDataEpV07 } from '@zerodev/sdk';
import { AppError } from '../src/errors.js';
import { createPaymasterService } from '../src/paymaster.js';
import { EXECUTOR_ABI } from '../src/chain.js';
import { buildSessionPermissions } from '../src/permissions.js';
import { closeCalls, consentCalls, openCalls, STRATEGY_EARN_97 as S, STRATEGY_EARN_ABI, strategyEarnUnwindForSale, strategyMarkets } from '../src/strategy-earn.js';
import type { StrategyEarnChain } from '../src/strategy-earn.js';
import { dcaDepositCalls, dcaReceiptApproval, dcaReturnCalls, dcaVaults } from '../src/dca-calls.js';
import { YIELD_EXECUTOR_ABI } from '../src/yield-abi.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
import { config, NOW, operation, OWNER, SENDER, TEST_SIGNER } from './fixtures/paymaster.js';
import { maxDebtFor, strategyEarnV2, v2Calls, v2ConsentCalls, v2ConsentOffCall, v2ExitBatches, v2ExitCalls, v2PreSellPlan, v2ReconsentCalls, v2RescueCall, v2SwapperApprovalCalls, V2_EXECUTOR_ABI, V2_REGISTRY_ABI, V2_SWAPPER_ABI } from '../src/strategy-earn-v2.js';
const SWAPPER_OWNER_ABI = [{ type: 'function', name: 'setPool', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'setLimits', inputs: [{ type: 'uint16' }, { type: 'uint16' }], outputs: [], stateMutability: 'nonpayable' }] as const;
import type { PreSellPosition, StrategyEarnV2 } from '../src/strategy-earn-v2.js';

/**
 * Every user flow that ends in a sponsored UserOp, built with the same builders/calldata the frontend sends, run
 * through the whole public /paymaster/sponsor validation for a normal fund account AND a My mix account.
 *
 * 2026-11-23 portfolio 10 (mix 5): DCA open on a My mix sent renewal + USDT.approve(DCA vault) + deposit +
 * receipt.approve(executor). The mix branch treated every approve as an owner mix change (403 without a pending
 * change), accepted only the plain renewal scope, forbade the DCA period redemption, and took the mix lock (409
 * MIX_BUSY while the scheduler / a mix refresh held it).
 *
 * Not UserOps (nothing to sponsor): cash earn deposit/withdraw (owner EOA sends the vault calls), claim test USDT
 * (POST /faucet/usdt mints server-side), funding a mix (EOA USDT transfer).
 */
const c = config({ CHAIN_ID: '97', RPC_URL: 'http://127.0.0.1:8558', PAYMASTER_SIGNER_PRIVATE_KEY: TEST_SIGNER });
const account = SENDER.toLowerCase() as Address;
const owner = OWNER as Address;
const executor = T.contracts.executor as Address;
const usdt = T.contracts.usdt as Address;
const asset = T.assets.NVDAB.token as Address;
const stranger = '0x3000000000000000000000000000000000000003' as Address;
const vaults = dcaVaults();
const markets = strategyMarkets();
const offline = createPublicClient({ chain: bscTestnet, transport: custom({ request: async () => { throw new Error('no rpc in this test'); } }) });
type Call = { to: Address; data: Hex; value: bigint };
const asCall = (x: { to: string; data: string }): Call => ({ to: x.to as Address, data: x.data as Hex, value: 0n });
const approve = (token: Address, spender: Address, amount = maxUint256): Call =>
  ({ to: token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }) });
const transfer = (token: Address, to: Address, amount: bigint): Call =>
  ({ to: token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }) });
const rebalance = (tokenIn: Address, tokenOut: Address): Call => ({ to: executor, value: 0n, data: encodeFunctionData({ abi: EXECUTOR_ABI,
  functionName: 'executeRebalance', args: [account, [{ tokenIn, tokenOut, amountIn: 10n ** 18n, amountOutMin: 1n, venue: T.assets.WBNB.pool as Address, data: '0x' }], BigInt(NOW + 300)] }) });
const yieldCall = (kind: 'executeSupply' | 'executeWithdraw', marketId: Hex): Call => ({ to: executor, value: 0n,
  data: encodeFunctionData({ abi: YIELD_EXECUTOR_ABI, functionName: kind, args: [account, marketId, 10n ** 18n, 1n, BigInt(NOW + 300)] }) });
/** GET /portfolios/:id/renewal-params on chain 97: yield + Strategy Earn for this account (src/renewal.ts). */
async function renewal(): Promise<Call[]> {
  const session = await buildSessionPermissions({ publicClient: offline as never, sessionKeyAddress: '0x2000000000000000000000000000000000000002',
    executorAddress: executor, validUntil: NOW + 30 * 86400, yieldAccount: account, borrowAccount: account });
  return session.initConfig.map((data) => ({ to: account, data: data as Hex, value: 0n }));
}

type Kind = 'fund' | 'mix';
function harness(kind: Kind, opts: { pendingChange?: boolean; reservedRaw?: bigint; observedRaw?: bigint; exiting?: 'triggered' | 'exited' | 'deleting'; rewardTokens?: Address[]; v2?: StrategyEarnV2 | null;
  /** Which generation of the yield strategy the account already uses (the paymaster's exclusivity check). */
  inUse?: 'v1' | 'v2' | 'unreadable';
  /** Leave the v2 deployment to production wiring (strategyEarnV2 + v2MayOpen: manifest, audience, newOpensPaused) instead of injecting it. */
  wired?: boolean } = {}) {
  const seen = { locks: 0, reservations: 0, setups: 0, exits: 0 }, asked: string[] = [];
  const service = createPaymasterService({ config: c, now: () => NOW, ...(opts.rewardTokens ? { rewardTokens: opts.rewardTokens } : {}), ...(opts.wired ? {} : { strategyV2: opts.v2 ?? null }),
    strategyGenerationActive: async (generation) => { asked.push(generation); if (opts.inUse === 'unreadable') throw new Error('rpc down'); return opts.inUse === generation; },
    mixLock: async (_id, work) => { seen.locks++; return work(); },
    query: async (sql) => ({ rows: sql.includes('select s.owner') ? [{ owner, user_id: owner, mix_id: kind === 'mix' ? '5' : null }]
      : sql.includes('from mixes m where') ? [{ id: '5', owner, account, triggered_at: opts.exiting === 'triggered' ? new Date(NOW * 1000) : null,
        status: opts.exiting === 'exited' ? 'exited' : 'active', delete_requested_at: opts.exiting === 'deleting' ? new Date(NOW * 1000) : null }]
      : sql.includes('mix_switch_intents') ? opts.pendingChange ? [{ id: '1', strategy_id: '12', owner_calls: [], nonce: '0', user_op_hash: null }] : []
      : sql.includes('select ms.exit_assets') ? [{ exit_assets: [] }]
      : sql.includes('from strategy_cash_balances b') && opts.reservedRaw !== undefined
        ? [{ reserved_input_raw: opts.reservedRaw.toString(), reserved_fee_raw: '0', withdrawal_raw: '0', yield_raw: '0' }] : [] }),
    readCash: async () => opts.observedRaw ?? 0n,
    mixSetup: async () => { seen.setups++; },
    checkChain: async () => {},
    readBudgetContext: async () => ({ purpose: 'ordinary', nativePrice: 60000000000n, priceSource: 'fixture:oracle' }),
    verifyYieldWithdraw: async () => { seen.exits++; return []; },
    reserve: async () => { seen.reservations++; } });
  // `nonce`: Kernel packs the validator into it — 0 is the owner's root validator; ROOT / SESSION below are the two real shapes.
  const sponsor = async (calls: Call[], nonce = 0n) => service.sponsor({ userOperation: operation({ sender: account, nonce, callData: await encodeCallDataEpV07(calls) }) }, owner);
  return { seen, asked, sponsor };
}
const code = (expected: string, status: number) => (e: unknown) => e instanceof AppError && e.code === expected && e.status === status;

/** Flow name -> exact calls, per account type. Mix flows only include what the UI can send for a mix. */
async function flows(kind: Kind): Promise<[string, Call[], { lock: boolean }][]> {
  const r = await renewal(), deadline = BigInt(NOW + 600);
  const shared: [string, Call[], { lock: boolean }][] = [];
  for (const v of vaults) {
    const open = [...dcaDepositCalls(v, account, 300n * 10n ** 18n, 0n), dcaReceiptApproval(v, executor)].map(asCall);
    // Fund DCA appends missing asset approvals (wallet-entry dcaStartRaw); a mix does not.
    shared.push([`DCA open ${v.id} (renewal required)`, [...r, ...open, ...(kind === 'fund' ? [approve(asset, executor)] : [])], { lock: false }]);
    shared.push([`DCA open ${v.id} (key ready, allowance set)`, dcaDepositCalls(v, account, 300n * 10n ** 18n, maxUint256).map(asCall), { lock: false }]);
    shared.push([`DCA withdraw ${v.id}`, dcaReturnCalls(v, account, owner, 9n * 10n ** 18n, 9n * 10n ** 18n).map(asCall), { lock: false }]);
    shared.push([`DCA period redemption ${v.id} (scheduler session key)`, [yieldCall('executeWithdraw', v.marketId)], { lock: false }]);
  }
  shared.push(['sell (scheduler session key)', [rebalance(asset, usdt)], { lock: true }]);
  shared.push(['withdraw USDT to wallet / delete-mix cash', [transfer(usdt, owner, 10n ** 18n)], { lock: false }]);
  shared.push(['standalone permission renewal', r, { lock: true }]);
  if (kind === 'mix') {
    shared.push(['mix buy (scheduler session key)', [rebalance(usdt, asset)], { lock: true }]);
    shared.push(...strategyFlows(r, deadline));
    return shared;
  }
  shared.push(['fund buy: approvals', [approve(usdt, executor), approve(asset, executor)], { lock: false }]);
  shared.push(['fund buy + Strategy Earn auto (renewal + consent)', [approve(asset, executor), ...r,
    ...consentCalls(markets.slice(0, 3).map((market) => ({ market, maxDebtRaw: 10n ** 21n }))).map(asCall)], { lock: false }]);
  shared.push(['Strategy Earn open after buy', openCalls(markets[0]!, account, 10n ** 18n, 10n ** 17n, 10n ** 18n, deadline).map(asCall), { lock: false }]);
  shared.push(['Strategy Earn off', closeCalls(markets[0]!, account, deadline).map(asCall), { lock: false }]);
  shared.push(['fund sell', [rebalance(asset, usdt)], { lock: false }]);
  // The scheduler's session-key steps on a fund account: the same shapes as a My mix (last two of strategyFlows).
  shared.push(...strategyFlows(r, deadline).slice(-2).map(([name, calls, expect]): [string, Call[], { lock: boolean }] => [name.replace(/^mix/, 'fund'), calls, expect]));
  return shared;
}

/**
 * Yield strategy (策略加息) UserOps a My mix sends, the same shapes as a fund (wallet-entry strategyAutoOn / strategyOpen /
 * strategyClose, and the scheduler's session-key steps). Not an enrollment change: no mix lock.
 */
function strategyFlows(r: Call[], deadline: bigint): [string, Call[], { lock: boolean }][] {
  const consent = consentCalls(markets.slice(0, 3).map((market) => ({ market, maxDebtRaw: 10n ** 21n }))).map(asCall);
  const lista = markets.find(m => m.protocol === 'lista')!;
  const executor = (fn: 'executeSupplyCollateral' | 'executeBorrow' | 'executeRepay' | 'executeWithdrawCollateral', args: readonly unknown[]): Call =>
    ({ to: S.executor as Address, value: 0n, data: encodeFunctionData({ abi: STRATEGY_EARN_ABI, functionName: fn, args: args as never }) });
  return [
    ['mix buy with yield strategy: consent after funding (renewal + consent)', [...r, ...consent], { lock: false }],
    ['mix buy with yield strategy: consent (key ready)', consent, { lock: false }],
    ['mix yield strategy on after the fill (Venus)', openCalls(markets[0]!, account, 10n ** 18n, 10n ** 17n, 10n ** 18n, deadline).map(asCall), { lock: false }],
    ['mix yield strategy on after the fill (Lista)', openCalls(lista, account, 10n ** 18n, 0n, 10n ** 18n, deadline).map(asCall), { lock: false }],
    ['mix yield strategy off', closeCalls(markets[0]!, account, deadline).map(asCall), { lock: false }],
    ['mix yield strategy off, two assets', [...closeCalls(markets[0]!, account, deadline), ...closeCalls(lista, account, deadline)].map(asCall), { lock: false }],
    ['mix auto-open after the fill (scheduler session key)', [executor('executeSupplyCollateral', [account, markets[0]!.marketId, 10n ** 18n, deadline]),
      executor('executeBorrow', [account, markets[0]!.marketId, 10n ** 17n, deadline])], { lock: false }],
    ['mix repay and take shares back before a sale (scheduler session key)', [executor('executeRepay', [account, markets[0]!.marketId, maxUint256, true, deadline]),
      executor('executeWithdrawCollateral', [account, markets[0]!.marketId, maxUint256, deadline])], { lock: false }],
  ];
}

for (const kind of ['fund', 'mix'] as const) {
  test(`${kind} account: every user flow's UserOp is sponsored`, async () => {
    for (const [name, calls, expect] of await flows(kind)) {
      const h = harness(kind);
      await assert.doesNotReject(h.sponsor(calls), `${kind}: ${name}`);
      assert.equal(h.seen.reservations, 1, `${kind}: ${name}`);
      if (kind === 'mix') assert.equal(h.seen.locks, expect.lock ? 1 : 0, `${kind}: ${name} mix lock`);
    }
  });
}

/**
 * 2026-11-25 portfolio 12 / 15 (fund account, every share posted for the yield strategy): "sell all" has to go
 * settle (repay + take the shares back) -> sell -> withdraw USDT in one press, exactly like a My mix. The UserOps are the
 * ones the scheduler really sends (strategyEarnUnwindForSale's batches), then the sale, then the owner's withdrawal.
 */
test('sell all with the yield strategy on (fund and My mix): settle -> sell -> withdraw, every UserOp sponsored', async () => {
  const E = 10n ** 18n, now = new Date(NOW * 1000);
  const venus = markets.find(m => m.protocol === 'venus')!, lista = markets.find(m => m.protocol === 'lista' && m.decimals === 18)!;
  const reading = (debt: bigint) => ({ gate: 0, shouldDeleverage: false, shouldUnwind: false, borrowRate: 0n, collateralRate: 0n, vaultRate: 0n, collateralIncentiveRate: 0n,
    borrowIncentiveRate: 0n, vaultIncentiveRate: 0n, borrowUtilizationBps: 0n, vaultUtilizationBps: 0n, ltv: 2n * 10n ** 17n, targetLtv: 3n * 10n ** 17n, deleverageLtv: 5n * 10n ** 17n,
    liquidationLtv: 75n * 10n ** 16n, debt, vaultAssets: debt + debt / 100n, health: { collateralValue: 1000n * E, liquidationValue: 750n * E, debtValue: debt, healthFactor: 5n * E } });
  for (const kind of ['fund', 'mix'] as const) {
    // Everything is posted: the account holds none of the two assets, only a little USDT.
    const posted = new Map([[venus.marketId as string, 10n * E], [lista.marketId as string, 10n * E]]);
    const chain: StrategyEarnChain = {
      head: async () => ({ number: 1n, timestamp: BigInt(NOW) }),
      status: async () => reading(200n * E),
      accountMarkets: async () => [...posted.keys()] as Hex[],
      collateral: async id => posted.get(id) ?? 0n,
      balance: async token => token.toLowerCase() === usdt.toLowerCase() ? E : 0n,
      price: async () => 100n * 10n ** 8n,
      rewards: async () => ({ vault: 0n, collateral: 0n }),
      policy: async () => ({ maxDebt: 1_000_000n * E, enabled: true }),
      weights: async () => [],
    };
    const ops: Call[][] = [];
    const sponsored = async (calls: Call[], nonce: bigint, name: string) => {
      const h = harness(kind);
      await assert.doesNotReject(h.sponsor(calls, nonce), `${kind}: ${name}`);
      assert.equal(h.seen.reservations, 1, `${kind}: ${name}`);
      ops.push(calls);
    };
    // 1. The sale wants the posted shares: the scheduler repays from the vault and takes them back (session key).
    const reason = await strategyEarnUnwindForSale({ chain, account, portfolioId: 15, now, dryRun: false, log: () => {},
      ledger: { record: async () => {} },
      steps: [{ tokenIn: venus.collateral, amountIn: 10n * E }, { tokenIn: lista.collateral, amountIn: 10n * E }],
      send: async calls => { await sponsored(calls.map(asCall), SESSION, 'repay and take the shares back'); return { hash: `0x${'0'.repeat(63)}1`, blockNumber: 1n, logs: [] }; } });
    assert.match(reason ?? '', /^\[STRATEGY_EARN_UNWINDING\] 賣出前已還款取回：/);
    const fns = ops.flat().map(c => decodeFunctionData({ abi: STRATEGY_EARN_ABI, data: c.data }).functionName);
    assert.deepEqual([...new Set(fns)].sort(), ['executeRepay', 'executeWithdrawCollateral']);
    assert.equal(fns.filter(f => f === 'executeWithdrawCollateral').length, 2, 'both posted assets come back');
    // 2. The sale itself (session key), 3. the owner's USDT withdrawal (root).
    await sponsored([rebalance(venus.collateral, usdt), rebalance(lista.collateral, usdt)], SESSION, 'sell');
    await sponsored([transfer(usdt, owner, 1_999n * E)], ROOT, 'withdraw USDT to the wallet');
  }
});

test('portfolio 10: DCA on a fresh My mix (renewal + approve + deposit + receipt approval) is sponsored without the mix lock', async () => {
  for (const v of vaults) {
    const h = harness('mix');
    const calls = [...await renewal(), ...[...dcaDepositCalls(v, account, 300n * 10n ** 18n, 0n), dcaReceiptApproval(v, executor)].map(asCall)];
    await h.sponsor(calls);
    assert.deepEqual(h.seen, { locks: 0, reservations: 1, setups: 0, exits: 0 }, v.id);
  }
});

test('My mix: mix creation / weight edit still require the pending change and its exact setup check', async () => {
  const calls = [approve(asset, executor), { to: T.contracts.registry as Address, value: 0n,
    data: encodeFunctionData({ abi: [{ type: 'function', name: 'enroll', inputs: [{ type: 'address' }, { type: 'uint256' }, { type: 'uint16' }], outputs: [], stateMutability: 'nonpayable' }],
      functionName: 'enroll', args: [account, 12n, 1] }) }];
  await assert.rejects(harness('mix').sponsor(calls), code('PAYMASTER_CALL_FORBIDDEN', 403));
  const h = harness('mix', { pendingChange: true });
  await h.sponsor(calls);
  assert.equal(h.seen.setups, 1);
  assert.equal(h.seen.locks, 1);
});

test('My mix: DCA keeps every DCA safety rule, and per-asset yield stays off', async () => {
  const lista = vaults.find(v => v.id === 'lista_usdt')!, venus = vaults.find(v => v.id === 'venus_usdt')!;
  const nonDcaMarket = T.yieldMarkets.find(m => !vaults.some(v => v.marketId === m.marketId))!.marketId as Hex;
  const cases: [string, Call[]][] = [
    ['USDT approved to a stranger', [approve(usdt, stranger, 1n), ...dcaDepositCalls(lista, account, 1n, maxUint256).map(asCall)]],
    ['DCA receipt approved to a stranger', [...dcaDepositCalls(lista, account, 1n, maxUint256).map(asCall), approve(lista.receipt, stranger)]],
    ['deposit for another account', [{ to: lista.spender, value: 0n, data: encodeFunctionData({ abi: [{ type: 'function', name: 'deposit', inputs: [{ type: 'uint256' }, { type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'nonpayable' }], functionName: 'deposit', args: [1n, stranger] }) }]],
    ['return to a stranger', dcaReturnCalls(lista, account, stranger, 1n, 1n).map(asCall)],
    ['Venus return forwarded to a stranger', dcaReturnCalls(venus, account, stranger, 1n, 1n).map(asCall)],
    ['per-asset yield supply on a DCA market', [yieldCall('executeSupply', lista.marketId)]],
    ['per-asset yield withdraw on a non-DCA market', [yieldCall('executeWithdraw', nonDcaMarket)]],
    ['yield registry policy', [{ to: T.contracts.yieldRegistry as Address, value: 0n, data: '0x12345678' }]],
    ['DCA deposit + a non-USDT transfer', [...dcaDepositCalls(lista, account, 1n, maxUint256).map(asCall), transfer(asset, owner, 1n)]],
  ];
  for (const [name, calls] of cases) {
    const h = harness('mix');
    await assert.rejects(h.sponsor(calls), code('PAYMASTER_CALL_FORBIDDEN', 403), name);
    assert.equal(h.seen.reservations, 0, name);
  }
  // During a pending mix change a DCA UserOp waits (409 MIX_BUSY, retryable); a USDT withdrawal to the owner still works.
  const pending = harness('mix', { pendingChange: true });
  await assert.rejects(pending.sponsor(dcaDepositCalls(lista, account, 1n, maxUint256).map(asCall)), code('MIX_BUSY', 409));
  await pending.sponsor([transfer(usdt, owner, 1n)]);
  assert.equal(pending.seen.reservations, 1);
});

test('portfolio 12: withdraw to wallet never takes cash a running buy reserved (fund and My mix)', async () => {
  const E = 10n ** 18n;
  for (const kind of ['fund', 'mix'] as const) {
    // 2,540 USDT in the account, 2,500 reserved by the running buy: 40 is free.
    const reserved = { reservedRaw: 2_500n * E, observedRaw: 2_540n * E };
    await harness(kind, reserved).sponsor([transfer(usdt, owner, 40n * E)]);
    const h = harness(kind, reserved);
    await assert.rejects(h.sponsor([transfer(usdt, owner, 41n * E)]), code('PAYMASTER_WITHDRAW_RESERVED', 409), kind);
    assert.equal(h.seen.reservations, 0);
    // Everything reserved: nothing is free.
    await assert.rejects(harness(kind, { reservedRaw: 3_000n * E, observedRaw: 2_540n * E }).sponsor([transfer(usdt, owner, 1n)]), code('PAYMASTER_WITHDRAW_RESERVED', 409));
    // Nothing reserved (or no cash row): the whole balance may go.
    await harness(kind, { reservedRaw: 0n, observedRaw: 0n }).sponsor([transfer(usdt, owner, 1_000n * E)]);
    // A Venus DCA return forwards what it just redeemed; reservations elsewhere do not block it.
    const venus = vaults.find(v => v.id === 'venus_usdt')!;
    await harness(kind, { reservedRaw: 3_000n * E, observedRaw: 0n }).sponsor(dcaReturnCalls(venus, account, owner, 9n * E, 9n * E).map(asCall));
  }
});

test('withdrawable cash = account USDT minus what a running buy / withdrawal / yield reserved', async () => {
  const { withdrawableCash, reservedCash } = await import('../src/withdrawable-cash.js');
  const row = { reserved_input_raw: '2499932500000000000000', reserved_fee_raw: '270000000000000000', withdrawal_raw: '0', yield_raw: '0',
    unallocated_hold_raw: '5', allocated_cash_raw: '7', unclassified_raw: '0', stack_prefund_raw: '0' };
  assert.equal(reservedCash(row), 2500202500000000000000n);
  assert.equal(withdrawableCash(1580202500000000000000n, row), 0n, 'portfolio 12: everything left is reserved');
  assert.equal(withdrawableCash(2600202500000000000000n, row), 100n * 10n ** 18n);
  assert.equal(withdrawableCash(10n, null), 10n);
  assert.throws(() => reservedCash({ ...row, yield_raw: '-1' }));
  // What a cash-swapper top-up may spend is stricter: nothing any bucket claims (funding waiting to be bought and the
  // portfolio's own cash too) — only a transfer to the owner is ever reconciled, so spending claimed cash any other way
  // leaves the ledger above the chain balance and stops the portfolio's jobs ([CASH_DEFICIT]).
  const { claimedCash, CLAIMED_CASH_BUCKETS } = await import('../src/withdrawable-cash.js');
  assert.equal(claimedCash(row), 2500202500000000000000n + 12n);
  assert.deepEqual([...CLAIMED_CASH_BUCKETS].sort(), ['allocated_cash_raw', 'reserved_fee_raw', 'reserved_input_raw', 'stack_prefund_raw', 'unallocated_hold_raw', 'withdrawal_raw', 'yield_raw']);
  assert.equal(claimedCash({ ...row, unclassified_raw: '999' }), claimedCash(row), 'unclassified cash is nobody\'s: it is what a top-up may use');
  assert.equal(claimedCash(null), 0n);
  assert.throws(() => claimedCash({ ...row, allocated_cash_raw: 'x' }));
});

test('My mix yield strategy: exiting / exited / deleting mixes can only settle; a pending mix change makes it wait; the rules stay strict', async () => {
  const deadline = BigInt(NOW + 600), r = await renewal();
  const consent = consentCalls([{ market: markets[0]!, maxDebtRaw: 10n ** 21n }]).map(asCall);
  const open = openCalls(markets[0]!, account, 10n ** 18n, 10n ** 17n, 10n ** 18n, deadline).map(asCall);
  const close = closeCalls(markets[0]!, account, deadline).map(asCall);
  for (const exiting of ['triggered', 'exited', 'deleting'] as const) {
    for (const [name, calls] of [['consent', [...r, ...consent]], ['open', open]] as const) {
      const h = harness('mix', { exiting });
      await assert.rejects(h.sponsor([...calls]), code('PAYMASTER_CALL_FORBIDDEN', 403), `${exiting}: ${name}`);
      assert.equal(h.seen.reservations, 0);
    }
    const h = harness('mix', { exiting });
    await h.sponsor(close);
    assert.equal(h.seen.reservations, 1, `${exiting}: off still settles`);
  }
  // A weight change waiting for its signature voids consent on chain: strategy UserOps wait (409 MIX_BUSY, retryable).
  for (const calls of [consent, open, close]) await assert.rejects(harness('mix', { pendingChange: true }).sponsor(calls), code('MIX_BUSY', 409));
  // Same call rules as a fund account.
  const strict: [string, Call[]][] = [
    ['strategy vault shares approved to AtpExecutor', [approve(S.earnVault as Address, executor)]],
    ['leveraged asset approved to AtpBorrowExecutor', [approve(T.assets.TQQQB.token as Address, S.executor as Address)]],
    ['borrow for another account', [{ to: S.executor as Address, value: 0n, data: encodeFunctionData({ abi: STRATEGY_EARN_ABI, functionName: 'executeBorrow', args: [stranger, markets[0]!.marketId, 1n, deadline] }) }]],
    ['consent with a zero ceiling', [{ to: S.registry as Address, value: 0n, data: encodeFunctionData({ abi: STRATEGY_EARN_ABI, functionName: 'setBorrowPolicy', args: [markets[0]!.marketId, 0n, true] }) }]],
    ['lending delegate to a stranger', [{ to: S.venusComptroller as Address, value: 0n, data: encodeFunctionData({ abi: STRATEGY_EARN_ABI, functionName: 'updateDelegate', args: [stranger, true] }) }]],
    ['consent + a token transfer out', [...consent, transfer(asset, owner, 1n)]],
  ];
  for (const [name, calls] of strict) {
    const h = harness('mix');
    await assert.rejects(h.sponsor(calls), code('PAYMASTER_CALL_FORBIDDEN', 403), name);
    assert.equal(h.seen.reservations, 0, name);
  }
});

test('My mix weight change with the yield strategy on: approval + enroll + consent goes through the exact pending-change check under the mix lock', async () => {
  const enroll = { to: T.contracts.registry as Address, value: 0n,
    data: encodeFunctionData({ abi: [{ type: 'function', name: 'enroll', inputs: [{ type: 'address' }, { type: 'uint256' }, { type: 'uint16' }], outputs: [], stateMutability: 'nonpayable' }],
      functionName: 'enroll', args: [account, 12n, 1] }) };
  const calls = [approve(asset, executor), enroll, ...consentCalls([{ market: markets[0]!, maxDebtRaw: 10n ** 21n }]).map(asCall)];
  await assert.rejects(harness('mix').sponsor(calls), code('PAYMASTER_CALL_FORBIDDEN', 403));
  const h = harness('mix', { pendingChange: true });
  await h.sponsor(calls);
  assert.deepEqual([h.seen.setups, h.seen.locks, h.seen.reservations], [1, 1, 1]);
});

test('My mix weight change on routing v2: approval + enroll + v2 re-consent (with the missing venue delegation) goes through the pending-change check under the mix lock', async () => {
  const enroll = { to: T.contracts.registry as Address, value: 0n,
    data: encodeFunctionData({ abi: [{ type: 'function', name: 'enroll', inputs: [{ type: 'address' }, { type: 'uint256' }, { type: 'uint16' }], outputs: [], stateMutability: 'nonpayable' }],
      functionName: 'enroll', args: [account, 12n, 1] }) };
  const calls = [approve(asset, executor), enroll, ...v2ReconsentCalls(V2, { maxDebtUsdRaw: maxDebtFor(800), rewardRecipient: owner, newCollaterals: [asset], venues: ['venus', 'lista'] }).map(asCall)];
  // No pending change: an owner change is refused; outside the v2 audience the v2 calls are unknown targets.
  await assert.rejects(harness('mix', { v2: V2 }).sponsor(calls), code('PAYMASTER_CALL_FORBIDDEN', 403));
  await assert.rejects(harness('mix', { pendingChange: true }).sponsor(calls), code('PAYMASTER_CALL_FORBIDDEN', 403));
  const h = harness('mix', { pendingChange: true, v2: V2 });
  await h.sponsor(calls);
  assert.deepEqual([h.seen.setups, h.seen.locks, h.seen.reservations], [1, 1, 1]);
});

test('reward tokens (LISTA / XVS): only a plain transfer to the owner wallet, on a fund and a My mix; nothing while the feature is off', async () => {
  const LISTA = '0xfceb31a79f71ac9cbdcf853519c1b12d379edc46' as Address, XVS = '0xcf6bb5389c92bdda8a3747ddb454cb7a64626c63' as Address;
  const { rewardExitCalls } = await import('../src/strategy-rewards.js');
  const payout = rewardExitCalls([{ token: LISTA, balanceRaw: 7n * 10n ** 18n }, { token: XVS, balanceRaw: 10n ** 17n }], owner).map(asCall);
  for (const kind of ['fund', 'mix'] as const) {
    const on = (o: Parameters<typeof harness>[1] = {}) => harness(kind, { rewardTokens: [LISTA, XVS], ...o });
    // The exact flows: rewards alone (delete after sell-all), together with the USDT withdrawal, and during a mix's exit / deletion / pending change.
    for (const [name, calls, o] of [['rewards to wallet', payout, {}], ['withdraw USDT + rewards', [transfer(usdt, owner, 10n ** 18n), ...payout], {}],
      ['exited', payout, { exiting: 'exited' }], ['deleting', payout, { exiting: 'deleting' }], ['triggered', payout, { exiting: 'triggered' }],
      ['pending mix change', payout, { pendingChange: true }]] as const) {
      const h = on(o);
      await assert.doesNotReject(h.sponsor([...calls]), `${kind}: ${name}`);
      assert.deepEqual([h.seen.reservations, h.seen.locks], [1, 0], `${kind}: ${name}`);
    }
    // Reserved cash still protects the USDT part of a combined withdrawal.
    await assert.rejects(on({ reservedRaw: 5n * 10n ** 18n, observedRaw: 5n * 10n ** 18n }).sponsor([transfer(usdt, owner, 10n ** 18n), ...payout]), code('PAYMASTER_WITHDRAW_RESERVED', 409), kind);
    const strict: [string, Call[]][] = [
      ['reward token to a stranger', [transfer(LISTA, stranger, 1n)]],
      ['zero amount', [transfer(LISTA, owner, 0n)]],
      ['reward token approved to AtpExecutor', [approve(LISTA, executor)]],
      ['reward token approved to a stranger', [approve(XVS, stranger)]],
      ['unknown selector on the reward token', [{ to: LISTA, value: 0n, data: '0x12345678' }]],
      ['a reward payout mixed with a strategy call', [...payout, ...closeCalls(markets[0]!, account, BigInt(NOW + 600)).map(asCall), transfer(LISTA, stranger, 1n)]],
      // A fund may already send a portfolio asset to its owner; a My mix may not, with or without rewards next to it.
      ...(kind === 'mix' ? [['a portfolio asset sent out next to the rewards', [...payout, transfer(asset, owner, 1n)]] as [string, Call[]]] : []),
    ];
    for (const [name, calls] of strict) {
      const h = on();
      await assert.rejects(h.sponsor(calls), code('PAYMASTER_CALL_FORBIDDEN', 403), `${kind}: ${name}`);
      assert.equal(h.seen.reservations, 0, `${kind}: ${name}`);
    }
    // Feature off (the default on every chain today): the same transfer is not sponsored.
    await assert.rejects(harness(kind).sponsor(payout), code('PAYMASTER_CALL_FORBIDDEN', 403), `${kind}: off`);
  }
});

/**
 * Routing v2 (src/strategy-earn-v2.ts): every UserOp shape the app and the scheduler will send once v2 is deployed, for a
 * fund account and a My mix account, built with the same builders. v2 is injected here; in production it is null until a
 * deployment is configured, and then none of these are sponsored.
 */
const V2: StrategyEarnV2 = { chainId: 97, executor: '0x20000000000000000000000000000000000000e2', registry: '0x20000000000000000000000000000000000000e3', lens: '0x20000000000000000000000000000000000000e6',
  venusComptroller: '0x20000000000000000000000000000000000000e4', moolah: '0x20000000000000000000000000000000000000e5',
  loanTokens: { USDT: usdt.toLowerCase() as Address, USDC: '0x20000000000000000000000000000000000000a2' }, rewardTokens: ['0x2000000000000000000000000000000000000091'],
  adapters: ['0x20000000000000000000000000000000000000e7'], canaryOwners: [], swapper: '0x20000000000000000000000000000000000000e8', swapperPools: ['0x20000000000000000000000000000000000000e9'] };
const USDC2 = V2.loanTokens.USDC!;
/** Kernel v3 nonces: owner (root validator; the SDK writes the ECDSA validator's address in the id) and a session key (permission id). */
const ROOT = (BigInt('0x845adb2c711129d4f3966735ed98a9f09fc4ce57') << 80n) | 3n, SESSION = (2n << 240n) | (0xdeadbeefn << 208n) | 3n;
const R1 = ('0x' + 'a1'.repeat(32)) as Hex, R2 = ('0x' + 'a2'.repeat(32)) as Hex, VA = ('0x' + 'b1'.repeat(32)) as Hex, VB = ('0x' + 'b2'.repeat(32)) as Hex;
async function renewalV2(v2: StrategyEarnV2 = V2): Promise<Call[]> {
  const session = await buildSessionPermissions({ publicClient: offline as never, sessionKeyAddress: '0x2000000000000000000000000000000000000002',
    executorAddress: executor, validUntil: NOW + 30 * 86400, yieldAccount: account, borrowAccount: account, routingV2: { executor: v2.executor, account, ...(v2.swapper ? { swapper: v2.swapper } : {}) } });
  return session.initConfig.map((data) => ({ to: account, data: data as Hex, value: 0n }));
}
function v2Flows(r: Call[], V2x: StrategyEarnV2 = V2): [string, Call[], 'risk' | 'settle'][] {
  const V2 = V2x, USDC2 = V2.loanTokens.USDC!;
  const deadline = BigInt(NOW + 600), E = 10n ** 18n;
  const consent = v2ConsentCalls(V2, { maxDebtUsdRaw: maxDebtFor(5000), rewardRecipient: owner, venues: ['venus', 'lista'], collaterals: [asset], loanTokens: Object.values(V2.loanTokens) as Address[], rewardTokens: V2.rewardTokens }).map(asCall);
  const selling = (o: Partial<PreSellPosition> & { routeId: Hex; vaultId: Hex }): PreSellPosition => ({ symbol: 'NVDAB', collateral: asset, freeCollateralRaw: 0n, postedRaw: 10n * E, routeDebtRaw: 1000n * E, venue: 'lista', loan: 'USDT', ...o });
  return [
    ['buy with yield strategy: renewal (v2 scope) + consent', [...r, ...consent], 'risk'],
    ['consent (key ready)', consent, 'risk'],
    ['consent keeping rewards in the account', v2ConsentCalls(V2, { maxDebtUsdRaw: E, rewardRecipient: account, venues: ['lista'], collaterals: [asset] }).map(asCall), 'risk'],
    ['open after the fill', [asCall(v2Calls.open(V2, account, R1, VA, 10n * E, 3n * E, deadline))], 'risk'],
    ['top up: borrow only', [asCall(v2Calls.open(V2, account, R1, VA, 0n, E, deadline))], 'risk'],
    ['two assets opened in one UserOp', [asCall(v2Calls.open(V2, account, R1, VA, E, E, deadline)), asCall(v2Calls.open(V2, account, R2, VB, E, E, deadline))], 'risk'],
    ['migrate to a better route (atomic)', [asCall(v2Calls.migrate(V2, account, { routeId: R1, vaultId: VA }, { routeId: R2, vaultId: VB }, 3n * E, 0n, deadline))], 'risk'],
    ['migrate: same route id is allowed when only the loan side moves vaults', [asCall(v2Calls.migrate(V2, account, { routeId: R1, vaultId: VA }, { routeId: R2, vaultId: VA }, 3n * E, E, deadline))], 'risk'],
    ['switch vault only', [asCall(v2Calls.switchVault(V2, account, VA, VB, maxUint256, deadline))], 'risk'],
    ['partial repay (negative carry / before a small sale)', [asCall(v2Calls.reduce(V2, account, R1, VA, E, 0n, 0n, deadline))], 'settle'],
    ['repay and take shares back before a sale (scheduler session key)', v2PreSellPlan(V2, account, [selling({ routeId: R1, vaultId: VA, vaultAssetsRaw: 1100n * E }), selling({ routeId: R2, vaultId: VB, loan: 'USDC', vaultAssetsRaw: 900n * E, cashRaw: 200n * E })], deadline).calls.map(asCall), 'settle'],
    ['before a sale, the box is short: repay what it holds, take back part (scheduler session key)', v2PreSellPlan(V2, account, [selling({ routeId: R1, vaultId: VA, vaultAssetsRaw: 400n * E })], deadline).calls.map(asCall), 'settle'],
    ['before a sale, nothing owed: only the shares come back', v2PreSellPlan(V2, account, [selling({ routeId: R1, vaultId: VA, routeDebtRaw: 0n })], deadline).calls.map(asCall), 'settle'],
    ['only post collateral (ceiling reached): no vault named', [asCall(v2Calls.open(V2, account, R1, ('0x' + '00'.repeat(32)) as Hex, E, 0n, deadline))], 'risk'],
    ['three markets in one session-key UserOp', [R1, R2, VA].map(route => asCall(v2Calls.open(V2, account, route, VB, E, E, deadline))), 'risk'],
    ['My mix weight change tail / re-consent after a re-enroll', v2ReconsentCalls(V2, { maxDebtUsdRaw: maxDebtFor(800), rewardRecipient: owner, newCollaterals: [asset] }).map(asCall), 'risk'],
    ['full exit: sweep the box and the account\'s own reward tokens', [asCall(v2Calls.sweepRewards(V2, account, V2.rewardTokens[0]!, maxUint256, deadline))], 'settle'],
    ...v2ExitBatches(V2, account, { routes: [{ routeId: R1, vaultId: VA }, { routeId: R2, vaultId: VB, routeDebtRaw: 0n }, { routeId: VA, vaultId: VB }, { routeId: VB, vaultId: VA }], leftoverVaults: [VA],
      rewards: [{ token: V2.rewardTokens[0]!, accountAmountRaw: maxUint256 }], deadline, withdrawConsent: true }, () => 500_000n)
      .map((batch, i): [string, Call[], 'risk' | 'settle'] => [`turn off, batch ${i + 1} (three executor calls per UserOp, consent withdrawn last)`, batch.map(asCall), 'settle']),
    ['two-step migrate, step 1: close with own cash', [asCall(v2Calls.close(V2, account, R1, VA, 5n * E, deadline))], 'settle'],
    ['release what is left in a vault', [asCall(v2Calls.release(V2, account, VA, deadline))], 'settle'],
    ['sweep rewards', [asCall(v2Calls.sweepRewards(V2, account, V2.rewardTokens[0]!, 0n, deadline))], 'settle'],
    ['yield strategy off / sell all / delete: close all + release + sweep + consent off', v2ExitCalls(V2, account, { routes: [{ routeId: R1, vaultId: VA }, { routeId: R2, vaultId: VB }],
      leftoverVaults: [VA], rewards: V2.rewardTokens.map(token => ({ token, accountAmountRaw: 0n })), deadline, withdrawConsent: true }).map(asCall), 'settle'],
    ['consent off alone', [asCall(v2ConsentOffCall(V2))], 'settle'],
    ['plain turn-off: close + release, consent withdrawn with the owner kept as reward recipient', v2ExitCalls(V2, account, { routes: [{ routeId: R1, vaultId: VA }], leftoverVaults: [VA], deadline, withdrawConsent: true, rewardRecipient: owner }).map(asCall), 'settle'],
    ['My mix weight change tail adding an asset that only routes through the other venue: delegation + re-consent + approval',
      v2ReconsentCalls(V2, { maxDebtUsdRaw: maxDebtFor(800), rewardRecipient: owner, newCollaterals: [asset], venues: ['lista'] }).map(asCall), 'risk'],
    ['full exit after a plain turn-off: only the reward sweep (scheduler session key)', [asCall(v2Calls.sweepRewards(V2, account, V2.rewardTokens[0]!, maxUint256, deadline))], 'settle'],
    // Cash swapper (AtpBorrowCashSwapper, spec §17): top-up before a repayment, cash-out after a close, and the owner's approvals to it.
    ['consent with the approvals to the cash swapper (USDT + the other loan tokens)', v2ConsentCalls(V2, { maxDebtUsdRaw: maxDebtFor(5000), rewardRecipient: owner, venues: ['lista'], collaterals: [asset], loanTokens: Object.values(V2.loanTokens) as Address[],
      rewardTokens: V2.rewardTokens, swapperApprovals: Object.values(V2.loanTokens) as Address[] }).map(asCall), 'risk'],
    ['approvals to the cash swapper alone (an account that consented before the swapper existed)', v2SwapperApprovalCalls(V2, Object.values(V2.loanTokens) as Address[]).map(asCall), 'settle'],
    ['top-up alone', [asCall(v2Calls.topUp(V2, USDC2, E, deadline))], 'settle'],
    ['cash-out alone: everything the account holds', [asCall(v2Calls.cashOut(V2, USDC2, maxUint256, E, deadline))], 'settle'],
    ['top-up + close + cash-out in one UserOp (scheduler session key)', [asCall(v2Calls.topUp(V2, USDC2, E, deadline)), asCall(v2Calls.close(V2, account, R1, VA, 0n, deadline)), asCall(v2Calls.cashOut(V2, USDC2, maxUint256, 1n, deadline))], 'settle'],
    ['top-up + partial repayment', [asCall(v2Calls.topUp(V2, USDC2, E, deadline)), asCall(v2Calls.reduce(V2, account, R1, VA, E, 0n, 0n, deadline))], 'settle'],
    ['top-up + atomic move off a short route', [asCall(v2Calls.topUp(V2, USDC2, E, deadline)), asCall(v2Calls.migrate(V2, account, { routeId: R1, vaultId: VA }, { routeId: R2, vaultId: VB }, 3n * E, 0n, deadline))], 'risk'],
    ['before a sale, a USDC route the box cannot cover: top-up + close + cash-out (v2PreSellPlan)', v2PreSellPlan(V2, account, [selling({ routeId: R2, vaultId: VB, loan: 'USDC', vaultAssetsRaw: 900n * E,
      swap: { token: USDC2, gapRaw: 100n * E, capRaw: 1010n * E, windowEndsAt: 0, usdtRaw: 500n * E, usdtAllowanceRaw: maxUint256, tokenAllowanceRaw: maxUint256 } })], deadline, NOW * 1000).calls.map(asCall), 'settle'],
    ...v2ExitBatches(V2, account, { routes: [{ routeId: R2, vaultId: VB, routeDebtRaw: 1000n * E, cashRaw: 0n, loan: 'USDC', vaultAssetsRaw: 990n * E, idleRaw: 0n, lastOfToken: true,
      swap: { token: USDC2, gapRaw: 10n * E, capRaw: 1010n * E, windowEndsAt: 0, usdtRaw: 500n * E, usdtAllowanceRaw: maxUint256, tokenAllowanceRaw: maxUint256 } }],
      swapperApprovals: [V2.loanTokens.USDT!, USDC2], cashOuts: [], deadline, withdrawConsent: true, rewardRecipient: owner, now: NOW * 1000 }, () => null)
      .map((batch, i): [string, Call[], 'risk' | 'settle'] => [`owner turn-off of a short USDC route, batch ${i + 1} (swapper approvals, top-up, close, cash-out, consent off)`, batch.map(asCall), 'settle']),
  ];
}

for (const kind of ['fund', 'mix'] as const) {
  test(`routing v2, ${kind} account: every v2 UserOp is sponsored when a v2 deployment is configured, none when it is not`, async () => {
    for (const [name, calls] of v2Flows(await renewalV2())) {
      const h = harness(kind, { v2: V2 });
      await assert.doesNotReject(h.sponsor(calls), `${kind}: ${name}`);
      assert.deepEqual([h.seen.reservations, h.seen.locks], [1, 0], `${kind}: ${name} (no mix lock: not an enrollment change)`);
      const off = harness(kind);
      await assert.rejects(off.sponsor(calls), code('PAYMASTER_CALL_FORBIDDEN', 403), `${kind}: ${name} with v2 off`);
      assert.equal(off.seen.reservations, 0);
    }
    // The v1 chain-97 flows are untouched by a configured v2 (same executor-v1 calls, same renewal scope).
    for (const [name, calls] of await flows(kind)) await assert.doesNotReject(harness(kind, { v2: V2 }).sponsor(calls), `${kind} with v2 on: ${name}`);
  });

  test(`routing v2, ${kind} account: the rules stay strict`, async () => {
    const deadline = BigInt(NOW + 600), E = 10n ** 18n;
    const ex = (functionName: string, args: readonly unknown[]): Call => ({ to: V2.executor, value: 0n, data: encodeFunctionData({ abi: V2_EXECUTOR_ABI, functionName: functionName as never, args: args as never }) });
    const policy = (maxDebt: bigint, recipient: Address, enabled: boolean): Call => ({ to: V2.registry, value: 0n, data: encodeFunctionData({ abi: V2_REGISTRY_ABI, functionName: 'setStrategyPolicy', args: [maxDebt, recipient, enabled] }) });
    const sw = (functionName: string, args: readonly unknown[], abi: readonly unknown[] = V2_SWAPPER_ABI): Call => ({ to: V2.swapper!, value: 0n, data: encodeFunctionData({ abi, functionName, args } as never) });
    const lending = (to: Address, fn: 'updateDelegate' | 'setAuthorization', who: Address): Call => ({ to, value: 0n, data: encodeFunctionData({ abi: STRATEGY_EARN_ABI, functionName: fn, args: [who, true] }) });
    const strict: [string, Call[]][] = [
      ['open for another account', [ex('executeOpen', [stranger, R1, VA, E, E, deadline])]],
      ['reduce for another account', [ex('executeReduce', [stranger, R1, VA, E, E, 0n, deadline])]],
      ['migrate for another account', [ex('executeMigrate', [stranger, R1, VA, R2, VB, E, 0n, deadline])]],
      ['sweep for another account', [ex('executeSweepRewards', [stranger, V2.rewardTokens[0]!, 0n, deadline])]],
      ['sweep of a portfolio asset', [ex('executeSweepRewards', [account, asset, E, deadline])]],
      ['sweep of the loan token', [ex('executeSweepRewards', [account, usdt, E, deadline])]],
      ['open with nothing', [ex('executeOpen', [account, R1, VA, 0n, 0n, deadline])]],
      ['reduce with nothing', [ex('executeReduce', [account, R1, VA, 0n, 0n, 0n, deadline])]],
      ['no deadline', [ex('executeOpen', [account, R1, VA, E, E, 0n])]],
      ['migrate to the same route and vault', [ex('executeMigrate', [account, R1, VA, R1, VA, E, 0n, deadline])]],
      ['switch to the same vault', [ex('executeSwitchVault', [account, VA, VA, E, deadline])]],
      ['executeDeleverage through the account (anyone-callable: the keeper sends it, never sponsored)', [ex('executeDeleverage', [account, R1, VA, maxUint256])]],
      ['trailing bytes on a v2 call', [{ ...ex('executeRelease', [account, VA, deadline]), data: (ex('executeRelease', [account, VA, deadline]).data + '00') as Hex }]],
      ['unknown selector on the v2 executor', [{ to: V2.executor, value: 0n, data: '0x12345678' }]],
      ['consent with a zero ceiling', [policy(0n, owner, true)]],
      ['rewards sent to a stranger', [policy(E, stranger, true)]],
      ['consent off naming a stranger', [policy(0n, stranger, false)]],
      ['rate report from an account', [{ to: V2.registry, value: 0n, data: encodeFunctionData({ abi: V2_REGISTRY_ABI, functionName: 'reportRates', args: [[], []] }) }]],
      ['Venus delegate to a stranger', [lending(V2.venusComptroller, 'updateDelegate', stranger)]],
      ['Moolah authorization to a stranger', [lending(V2.moolah, 'setAuthorization', stranger)]],
      ['Moolah call with the Venus function', [lending(V2.moolah, 'updateDelegate', V2.executor)]],
      ['a token outside the portfolio approved to the v2 executor', [approve(stranger, V2.executor)]],
      ['strategy vault shares (v1) approved to the v2 executor', [approve(S.earnVault as Address, V2.executor)]],
      ['a portfolio asset approved to a stranger next to a v2 call', [approve(asset, stranger), ex('executeRelease', [account, VA, deadline])]],
      ['native value on a v2 call', [{ ...ex('executeRelease', [account, VA, deadline]), value: 1n }]],
      ['a v2 close with a token sent to a stranger', [ex('executeRelease', [account, VA, deadline]), transfer(usdt, stranger, 1n)]],
      // Cash swapper: only topUp / cashOut of a loan token other than USDT; approvals to it only on USDT and loan tokens.
      ['swapper: setPool through the account', [sw('setPool', [USDC2, stranger], SWAPPER_OWNER_ABI)]],
      ['swapper: setLimits through the account', [sw('setLimits', [100, 500], SWAPPER_OWNER_ABI)]],
      ['swapper: top-up of USDT', [sw('topUp', [usdt, E, E, deadline])]],
      ['swapper: top-up of a portfolio asset', [sw('topUp', [asset, E, E, deadline])]],
      ['swapper: top-up of "everything"', [sw('topUp', [USDC2, maxUint256, maxUint256, deadline])]],
      ['swapper: top-up of nothing', [sw('topUp', [USDC2, 0n, 0n, deadline])]],
      ['swapper: top-up without a deadline', [sw('topUp', [USDC2, E, E, 0n])]],
      ['swapper: cash-out of a reward token', [sw('cashOut', [V2.rewardTokens[0]!, E, 0n, deadline])]],
      ['swapper: cash-out without a deadline', [sw('cashOut', [USDC2, E, 0n, 0n])]],
      ['swapper: trailing bytes', [{ ...asCall(v2Calls.topUp(V2, USDC2, E, deadline)), data: (v2Calls.topUp(V2, USDC2, E, deadline).data + '00') as Hex }]],
      ['swapper: native value', [{ ...asCall(v2Calls.topUp(V2, USDC2, E, deadline)), value: 1n }]],
      ['swapper: a portfolio asset approved to it', [approve(asset, V2.swapper!)]],
      ['swapper: a reward token approved to it', [approve(V2.rewardTokens[0]!, V2.swapper!)]],
      ['swapper: a top-up next to a token sent to a stranger', [asCall(v2Calls.topUp(V2, USDC2, E, deadline)), transfer(usdt, stranger, 1n)]],
    ];
    for (const [name, calls] of strict) {
      const h = harness(kind, { v2: V2 });
      await assert.rejects(h.sponsor(calls), (e: unknown) => e instanceof AppError && e.status >= 400 && e.status < 500, `${kind}: ${name}`);
      assert.equal(h.seen.reservations, 0, `${kind}: ${name}`);
    }
  });
}

test('routing v2 on a My mix: exiting / exited / deleting mixes only settle; a pending mix change makes it wait', async () => {
  const flowsV2 = v2Flows(await renewalV2());
  for (const exiting of ['triggered', 'exited', 'deleting'] as const) {
    for (const [name, calls, kind] of flowsV2) {
      const h = harness('mix', { v2: V2, exiting });
      if (kind === 'risk') { await assert.rejects(h.sponsor(calls), code('PAYMASTER_CALL_FORBIDDEN', 403), `${exiting}: ${name}`); assert.equal(h.seen.reservations, 0); }
      else { await h.sponsor(calls); assert.equal(h.seen.reservations, 1, `${exiting}: ${name} still settles`); }
    }
  }
  for (const [name, calls] of flowsV2.slice(1)) await assert.rejects(harness('mix', { v2: V2, pendingChange: true }).sponsor(calls), code('MIX_BUSY', 409), name);
});

test('routing v2 on a My mix: a weight change re-enrolls into a new strategy, so the same owner UserOp re-consents (approval + enroll + v2 consent)', async () => {
  const enroll = { to: T.contracts.registry as Address, value: 0n,
    data: encodeFunctionData({ abi: [{ type: 'function', name: 'enroll', inputs: [{ type: 'address' }, { type: 'uint256' }, { type: 'uint16' }], outputs: [], stateMutability: 'nonpayable' }],
      functionName: 'enroll', args: [account, 12n, 1] }) };
  const calls = [approve(asset, executor), enroll, ...v2ConsentCalls(V2, { maxDebtUsdRaw: maxDebtFor(5000), rewardRecipient: owner, venues: ['lista'], collaterals: [asset] }).map(asCall)];
  await assert.rejects(harness('mix', { v2: V2 }).sponsor(calls), code('PAYMASTER_CALL_FORBIDDEN', 403));
  const h = harness('mix', { v2: V2, pendingChange: true });
  await h.sponsor(calls);
  assert.deepEqual([h.seen.setups, h.seen.locks, h.seen.reservations], [1, 1, 1]);
});

for (const kind of ['fund', 'mix'] as const) {
  test(`routing v2, ${kind} account: executeRescue is sponsored only for the owner's own signature, never for a session key (draft5 rescueIsOwnerOnlyByPolicy)`, async () => {
    const deadline = BigInt(NOW + 600), rescue = [asCall(v2RescueCall(V2, account, VA, deadline))];
    const owned = harness(kind, { v2: V2 });
    await owned.sponsor(rescue, ROOT);
    assert.equal(owned.seen.reservations, 1);
    for (const nonce of [SESSION, (1n << 240n) | 3n, (1n << 248n) | 3n]) {
      const h = harness(kind, { v2: V2 });
      await assert.rejects(h.sponsor(rescue, nonce), code('PAYMASTER_CALL_FORBIDDEN', 403), 'not root signed');
      assert.equal(h.seen.reservations, 0);
    }
    // Owner-signed, but for another account / without a deadline / with v2 off: still refused.
    await assert.rejects(harness(kind, { v2: V2 }).sponsor([asCall(v2RescueCall(V2, stranger, VA, deadline))], ROOT), code('PAYMASTER_CALL_FORBIDDEN', 403));
    await assert.rejects(harness(kind, { v2: V2 }).sponsor([asCall(v2RescueCall(V2, account, VA, 0n))], ROOT), code('PAYMASTER_CALL_FORBIDDEN', 403));
    await assert.rejects(harness(kind).sponsor(rescue, ROOT), code('PAYMASTER_CALL_FORBIDDEN', 403));
    // Every ordinary v2 flow is the same whoever signs (the scheduler sends them with the session key).
    for (const [name, calls] of v2Flows(await renewalV2()).slice(3, 8)) await assert.doesNotReject(harness(kind, { v2: V2 }).sponsor(calls, SESSION), `${kind}: ${name} (session key)`);
    // The cash swapper's two functions are the session key's too (the scheduler tops up and cashes out with it).
    for (const [name, calls] of v2Flows(await renewalV2()).filter(f => /top-up|cash-out/.test(f[0]) && !/owner turn-off|approvals/.test(f[0]))) await assert.doesNotReject(harness(kind, { v2: V2 }).sponsor(calls, SESSION), `${kind}: ${name} (session key)`);
  });

  test(`routing v2, ${kind} account: one account uses v1 or v2, never both — adding risk on one generation is refused while the other is in use`, async () => {
    const deadline = BigInt(NOW + 600), E = 10n ** 18n, market = markets[0]!;
    const v2Risk = v2Flows(await renewalV2()).filter(f => f[2] === 'risk'), v2Settle = v2Flows(await renewalV2()).filter(f => f[2] === 'settle');
    const v1Open = openCalls(market, account, E, E, 2n * E, deadline).map(asCall), v1Close = closeCalls(market, account, deadline).map(asCall);
    // v1 still holds something: every v2 UserOp that adds risk (consent, open, move) is refused; exits are always sponsored.
    for (const [name, calls] of v2Risk) {
      const h = harness(kind, { v2: V2, inUse: 'v1' });
      await assert.rejects(h.sponsor(calls), code('PAYMASTER_CALL_FORBIDDEN', 403), `${kind}: ${name}`);
      assert.deepEqual([h.asked, h.seen.reservations], [['v1'], 0], name);
    }
    for (const [name, calls] of v2Settle) { const h = harness(kind, { v2: V2, inUse: 'v1' }); await h.sponsor(calls); assert.deepEqual(h.asked, [], `${kind}: ${name} is never checked`); }
    // v2 holds something: v1 consent / post / borrow is refused for this owner; v1 repay and take-back still go through.
    const blocked = harness(kind, { v2: V2, inUse: 'v2' });
    await assert.rejects(blocked.sponsor(v1Open), code('PAYMASTER_CALL_FORBIDDEN', 403));
    assert.deepEqual(blocked.asked, ['v2']);
    await assert.doesNotReject(harness(kind, { v2: V2, inUse: 'v2' }).sponsor(v1Close));
    // Neither in use: both generations may start (the API decides which one it offers).
    await assert.doesNotReject(harness(kind, { v2: V2 }).sponsor(v1Open));
    await assert.doesNotReject(harness(kind, { v2: V2 }).sponsor(v2Risk[1]![1]));
    // The chain cannot be read: nothing is sponsored on a guess.
    await assert.rejects(harness(kind, { v2: V2, inUse: 'unreadable' }).sponsor(v2Risk[1]![1]), code('PAYMASTER_DEPENDENCY_UNAVAILABLE', 503));
    // An owner outside the v2 audience (v2 null) is never asked: v1 exactly as before, no extra read.
    const plain = harness(kind);
    await plain.sponsor(v1Open);
    assert.deepEqual(plain.asked, []);
  });

  test(`routing v2, ${kind} account: production wiring — the deployment and the audience come from configuration; outside the audience nothing new starts on v2, and everything that settles is still sponsored`, async () => {
    const real = strategyEarnV2(97, {})!;
    const v2f = v2Flows(await renewalV2(real), real);
    const risk = v2f.filter(f => f[2] === 'risk'), settle = v2f.filter(f => f[2] === 'settle');
    assert.ok(risk.length > 0 && settle.length > 0);
    const before = { audience: process.env.STRATEGY_EARN_V2_AUDIENCE, deployment: process.env.STRATEGY_EARN_V2_DEPLOYMENT };
    const file = JSON.parse(readFileSync(new URL('../deploy/strategy-earn-v2.json', import.meta.url), 'utf8')).deployments[0];
    /** Outside the audience / paused: consent, open, move are refused without a chain read; repay, close, top-up, cash-out, consent off, rewards go through. */
    const closedToNew = async (why: string) => {
      for (const [name, calls] of risk) { const h = harness(kind, { wired: true }); await assert.rejects(h.sponsor(calls), code('PAYMASTER_CALL_FORBIDDEN', 403), `${kind}: ${name} ${why}`); assert.deepEqual([h.asked, h.seen.reservations], [[], 0], name); }
      for (const [name, calls] of settle) { const h = harness(kind, { wired: true }); await assert.doesNotReject(h.sponsor(calls), `${kind}: ${name} ${why}`); assert.deepEqual([h.asked, h.seen.reservations], [[], 1], name); }
    };
    try {
      // This owner is not in the shipped deployment's canary list, and the shipped audience is the canary list.
      delete process.env.STRATEGY_EARN_V2_AUDIENCE; delete process.env.STRATEGY_EARN_V2_DEPLOYMENT;
      assert.ok(!real.canaryOwners.includes(owner.toLowerCase() as Address));
      assert.deepEqual([real.audience, real.newOpensPaused], ['canary', false]);
      await closedToNew('outside the audience');
      for (const [name, calls] of await flows(kind)) await assert.doesNotReject(harness(kind, { wired: true }).sponsor(calls), `${kind} outside the audience: ${name}`);
      // v1 risk from an owner outside the audience is checked against v2 too: the account may still be on v2 from when its
      // owner was in the audience (one account never uses both). Nothing on v2 -> sponsored as ever.
      const v1Open = openCalls(markets[0]!, account, 10n ** 18n, 10n ** 18n, 2n * 10n ** 18n, BigInt(NOW + 600)).map(asCall);
      const clean = harness(kind, { wired: true });
      await assert.doesNotReject(clean.sponsor(v1Open));
      assert.deepEqual(clean.asked, ['v2']);
      await assert.rejects(harness(kind, { wired: true, inUse: 'v2' }).sponsor(v1Open), code('PAYMASTER_CALL_FORBIDDEN', 403));
      // In the audience (the variable): the same UserOps against the configured executor / registry are sponsored.
      process.env.STRATEGY_EARN_V2_AUDIENCE = owner;
      for (const [name, calls] of v2f) { const h = harness(kind, { wired: true }); await assert.doesNotReject(h.sponsor(calls), `${kind}: ${name} in the audience`); assert.equal(h.seen.reservations, 1); }
      // A v2 call aimed at any other "executor" is not a v2 call: refused.
      await assert.rejects(harness(kind, { wired: true }).sponsor([asCall(v2Calls.release(V2, account, VA, BigInt(NOW + 600)))]), code('PAYMASTER_CALL_FORBIDDEN', 403));
      // The same from the configuration file alone: `"audience": "all"` opens v2 to every owner, no variable needed.
      delete process.env.STRATEGY_EARN_V2_AUDIENCE;
      process.env.STRATEGY_EARN_V2_DEPLOYMENT = JSON.stringify({ ...file, audience: 'all' });
      for (const [name, calls] of v2f) await assert.doesNotReject(harness(kind, { wired: true }).sponsor(calls), `${kind}: ${name} with audience all in the file`);
      // `newOpensPaused`: nobody starts anything new — not an owner on the canary list, not with the audience at `all`, not
      // with the variable naming this owner — and everything that settles is sponsored all the same.
      process.env.STRATEGY_EARN_V2_DEPLOYMENT = JSON.stringify({ ...file, audience: 'all', canaryOwners: [owner], newOpensPaused: true });
      await closedToNew('while new opens are paused');
      process.env.STRATEGY_EARN_V2_AUDIENCE = owner;
      await closedToNew('while new opens are paused (variable set)');
    } finally {
      if (before.audience === undefined) delete process.env.STRATEGY_EARN_V2_AUDIENCE; else process.env.STRATEGY_EARN_V2_AUDIENCE = before.audience;
      if (before.deployment === undefined) delete process.env.STRATEGY_EARN_V2_DEPLOYMENT; else process.env.STRATEGY_EARN_V2_DEPLOYMENT = before.deployment;
    }
  });
}

test('routing v2 session scope, golden: keys installed before the cash swapper rebuild to the same permissionId; the swapper scope is a new one (so those keys renew)', async () => {
  const id = async (routingV2?: { executor: Address; account: Address; swapper?: Address }) => (await buildSessionPermissions({ publicClient: offline as never, sessionKeyAddress: '0x2000000000000000000000000000000000000002',
    executorAddress: executor, validUntil: 1_900_000_000, yieldAccount: '0x1000000000000000000000000000000000000005', borrowAccount: '0x1000000000000000000000000000000000000005', ...(routingV2 ? { routingV2 } : {}) }));
  const a = '0x1000000000000000000000000000000000000005' as Address;
  const [v1, v2Only, withSwapper] = [await id(), await id({ executor: V2.executor, account: a }), await id({ executor: V2.executor, account: a, swapper: V2.swapper! })];
  // The first two are byte for byte what origin/main (before the swapper) produced: installed keys keep validating.
  assert.deepEqual([v1.permissionId, v2Only.permissionId, withSwapper.permissionId], ['0xb27e1419', '0x015b88d9', '0x9bc6110d']);
  assert.deepEqual([v1.policySnapshot.call.permissions.length, v2Only.policySnapshot.call.permissions.length, withSwapper.policySnapshot.call.permissions.length], [7, 13, 15]);
  assert.deepEqual(withSwapper.policySnapshot.call.permissions.slice(13).map(p => [p.target, p.selector, p.rules.length, p.valueLimit]),
    [toFunctionSelector('topUp(address,uint256,uint256,uint256)'), toFunctionSelector('cashOut(address,uint256,uint256,uint256)')].map(selector => [V2.swapper, selector, 0, '0']));
});

test('renewal: the routing v2 scope is installed for an owner in the audience, and for any account that already has something on v2 whoever its owner is — never dropped from a key the scheduler needs to close a position', async () => {
  const { buildRenewalKey } = await import('../src/renewal.js');
  const { v2InstalledScope } = await import('../src/strategy-earn-v2.js');
  const real = strategyEarnV2(97, {})!, asked: Address[] = [];
  const key = async (who: Address, has: boolean | 'unreadable') => {
    const k = await buildRenewalKey({ accountAddress: account, owner: who, strategyId: 1, existingKeyRefs: [], material: { masterSeed: ('0x' + '11'.repeat(32)) as Hex }, executorAddress: executor, publicClient: offline as never,
      validUntil: NOW + 30 * 86400, hasV2State: async a => { asked.push(a); if (has === 'unreadable') throw new Error('public node down'); return has; } });
    return v2InstalledScope(k.policySnapshot, account);
  };
  const before = { audience: process.env.STRATEGY_EARN_V2_AUDIENCE, deployment: process.env.STRATEGY_EARN_V2_DEPLOYMENT };
  try {
    delete process.env.STRATEGY_EARN_V2_AUDIENCE; delete process.env.STRATEGY_EARN_V2_DEPLOYMENT;
    const scope = { executor: real.executor, account, swapper: real.swapper };
    // Outside the audience, nothing on v2: the key is exactly what it was before v2 existed (one question about the account).
    assert.deepEqual([await key(owner, false), asked], [null, [account]]);
    // Outside the audience, the account is on v2 (or used it): the new key keeps the v2 scope, so the scheduler can still repay and close.
    assert.deepEqual(await key(owner, true), scope);
    // That cannot be read: the renewal fails rather than hand out a key that may be missing the scope.
    await assert.rejects(key(owner, 'unreadable'), /public node down/);
    // In the audience: always, without asking — also while new opens are paused (the pause must not strip the scope from renewals).
    asked.length = 0;
    process.env.STRATEGY_EARN_V2_AUDIENCE = owner;
    assert.deepEqual([await key(owner, false), asked], [scope, []]);
    delete process.env.STRATEGY_EARN_V2_AUDIENCE;
    const file = JSON.parse(readFileSync(new URL('../deploy/strategy-earn-v2.json', import.meta.url), 'utf8')).deployments[0];
    process.env.STRATEGY_EARN_V2_DEPLOYMENT = JSON.stringify({ ...file, canaryOwners: [owner], newOpensPaused: true });
    assert.deepEqual([await key(owner, false), asked], [scope, []]);
  } finally {
    if (before.audience === undefined) delete process.env.STRATEGY_EARN_V2_AUDIENCE; else process.env.STRATEGY_EARN_V2_AUDIENCE = before.audience;
    if (before.deployment === undefined) delete process.env.STRATEGY_EARN_V2_DEPLOYMENT; else process.env.STRATEGY_EARN_V2_DEPLOYMENT = before.deployment;
  }
});
