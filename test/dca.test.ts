import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData, encodeFunctionData, encodeAbiParameters, encodeEventTopics, maxUint256, parseAbi } from 'viem';
import type { Address, Hex } from 'viem';
import { AppError } from '../src/errors.js';
import { validateSponsoredCalls } from '../src/paymaster.js';
import { createDca, dcaEarned, duePeriods, periodAt, planJson, restorePlan, runDcaRound, trancheTarget } from '../src/dca.js';
import type { DcaChain, DcaDeps, PlanRow } from '../src/dca.js';
import { DCA_VAULT_ABI, dcaDepositCalls, dcaReceiptApproval, dcaReturnCalls, dcaVaultCall, dcaVaults } from '../src/dca-calls.js';
import type { CashEarnChain, PositionReading, VaultReading } from '../src/cash-earn.js';
import type { OwnedPortfolio } from '../src/portfolios.js';
import type { YieldPlan } from '../src/yield-execution.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
import { config, kernelCall, operation, SENDER, TEST_SIGNER } from './fixtures/paymaster.js';
import { holdsOnlyCash, RESUME_AFTER_SELL_ALL_SQL } from '../src/sell-all-resume.js';
import { FINISH_SELL_ALL_SQL, NEW_MONEY_ENDS_SELL_ALL_SQL } from '../src/sell-all-intent.js';
import type { PortfolioPlan } from '../src/snapshot.js';

const E18 = 10n ** 18n;
const vaults = dcaVaults();
const lista = vaults.find(v => v.id === 'lista_usdt'), aave = vaults.find(v => v.id === 'aave_v3_usdt'), venus = vaults.find(v => v.id === 'venus_usdt');
assert.ok(lista && aave && venus);
const account = SENDER.toLowerCase() as Address;
const owner = '0x00000000000000000000000000000000000000a1' as Address;
const executor = T.contracts.executor as Address;
const norm = (args: readonly unknown[] | undefined) => (args ?? []).map(a => typeof a === 'string' ? a.toLowerCase() : a);
const isError = (status: number, code: string) => (e: unknown) => e instanceof AppError && e.status === status && e.code === code;

test('DCA calendar: daily/weekly/biweekly add days, monthly clamps to month end; due periods catch up; last tranche takes all', () => {
  const start = new Date('2026-01-31T13:30:00Z');
  assert.equal(periodAt(start, 'daily', 2).toISOString(), '2026-02-02T13:30:00.000Z');
  assert.equal(periodAt(start, 'weekly', 1).toISOString(), '2026-02-07T13:30:00.000Z');
  assert.equal(periodAt(start, 'biweekly', 1).toISOString(), '2026-02-14T13:30:00.000Z');
  assert.deepEqual([1, 2, 12, 13].map(i => periodAt(start, 'monthly', i).toISOString()),
    ['2026-02-28T13:30:00.000Z', '2026-03-31T13:30:00.000Z', '2027-01-31T13:30:00.000Z', '2027-02-28T13:30:00.000Z']);
  assert.throws(() => periodAt(start, 'daily', -1));
  const plan = { startAt: start, frequency: 'daily' as const, periods: 5, periodsDone: 0 };
  assert.equal(duePeriods(plan, new Date('2026-01-31T13:29:59Z')), 0);
  assert.equal(duePeriods(plan, start), 1, 'first period is due at the start');
  // A weekend closed market: three periods due at once, capped by the plan.
  assert.equal(duePeriods({ ...plan, periodsDone: 1 }, new Date('2026-02-03T14:00:00Z')), 3);
  assert.equal(duePeriods({ ...plan, periodsDone: 1 }, new Date('2027-01-01T00:00:00Z')), 4);
  const t = { trancheRaw: 100n * E18, periods: 5, periodsDone: 1 };
  assert.equal(trancheTarget(t, 2), 100n * E18); assert.equal(trancheTarget(t, 4), 300n * E18); assert.equal(trancheTarget(t, 5), 'all');
  assert.throws(() => trancheTarget(t, 1)); assert.throws(() => trancheTarget(t, 6));
  assert.equal(dcaEarned(1000n, 300n, 0n, 710n), 10n);
  assert.equal(dcaEarned(1000n, 300n, 0n, 600n), null, 'negative = incomplete ledger, never shown');
  assert.equal(dcaEarned(null, 0n, 0n, 5n), null); assert.equal(dcaEarned(1000n, 0n, 0n, null), null);
});

test('DCA vaults: Venus, Lista and Aave; calldata for deposit, executor approval and return (Venus forwards from the account)', () => {
  assert.deepEqual(vaults.map(v => v.id), ['venus_usdt', 'lista_usdt', 'aave_v3_usdt']);
  for (const v of vaults) assert.ok(T.yieldMarkets.some(m => m.marketId === v.marketId && m.receipt.toLowerCase() === v.receipt));
  const [approve, deposit] = dcaDepositCalls(lista, account, 500n * E18, 0n);
  assert.ok(approve && deposit);
  assert.deepEqual(norm(decodeFunctionData({ abi: DCA_VAULT_ABI, data: approve.data }).args), [lista.spender, 500n * E18]);
  assert.deepEqual(norm(decodeFunctionData({ abi: DCA_VAULT_ABI, data: deposit.data }).args), [500n * E18, account]);
  assert.equal(dcaDepositCalls(aave, account, 5n, 5n).length, 1, 'no approve with enough allowance');
  assert.deepEqual(norm(decodeFunctionData({ abi: DCA_VAULT_ABI, data: dcaDepositCalls(aave, account, 5n, 5n)[0]?.data ?? '0x' }).args), [aave.asset, 5n, account, 0]);
  const venusMint = decodeFunctionData({ abi: DCA_VAULT_ABI, data: dcaDepositCalls(venus, account, 5n, 5n)[0]?.data ?? '0x' });
  assert.deepEqual([venusMint.functionName, venusMint.args], ['mint', [5n]]);
  const approval = dcaReceiptApproval(aave, executor);
  assert.equal(approval.to, aave.receipt); assert.deepEqual(norm(decodeFunctionData({ abi: DCA_VAULT_ABI, data: approval.data }).args), [executor.toLowerCase(), maxUint256]);
  assert.deepEqual(norm(decodeFunctionData({ abi: DCA_VAULT_ABI, data: dcaReturnCalls(lista, account, owner, 7n, 8n)[0]?.data ?? '0x' }).args), [7n, owner, account]);
  assert.deepEqual(norm(decodeFunctionData({ abi: DCA_VAULT_ABI, data: dcaReturnCalls(aave, account, owner, 7n, 8n)[0]?.data ?? '0x' }).args), [aave.asset, maxUint256, owner]);
  const [redeem, forward] = dcaReturnCalls(venus, account, owner, 7n, 8n);
  assert.ok(redeem && forward);
  assert.equal(redeem.to, venus.spender); assert.deepEqual(norm(decodeFunctionData({ abi: DCA_VAULT_ABI, data: redeem.data }).args), [7n]);
  assert.equal(forward.to, venus.asset); assert.deepEqual(norm(decodeFunctionData({ abi: DCA_VAULT_ABI, data: forward.data }).args), [owner, 8n]);
});

const chain97 = { CHAIN_ID: '97', RPC_URL: 'http://127.0.0.1:8558', PAYMASTER_SIGNER_PRIVATE_KEY: TEST_SIGNER };
const sponsor = (to: string, data: Hex, ownerAddress: Address | null = owner) =>
  validateSponsoredCalls(operation({ callData: kernelCall(data, to as Hex) }), config(chain97), ownerAddress === null ? {} : { owner: ownerAddress });
const refused = (to: string, data: Hex, ownerAddress: Address | null = owner) =>
  assert.throws(() => sponsor(to, data, ownerAddress), isError(403, 'PAYMASTER_CALL_FORBIDDEN'), data.slice(0, 10));
const enc = (fn: string, args: readonly unknown[]) => encodeFunctionData({ abi: DCA_VAULT_ABI, functionName: fn as never, args: args as never });

test('DCA paymaster: deposits only for the sender, returns only to the owner, USDT approvals only to DCA vault spenders', () => {
  for (const v of vaults) {
    for (const c of [...dcaDepositCalls(v, account, 100n * E18, 0n), dcaReceiptApproval(v, executor), ...dcaReturnCalls(v, account, owner, 9n, 9n)]) {
      assert.doesNotThrow(() => sponsor(c.to, c.data), `${v.id} ${c.data.slice(0, 10)}`);
    }
  }
  const stranger = '0x00000000000000000000000000000000000000b2';
  refused(lista.spender, enc('deposit', [1n, stranger]));
  refused(lista.spender, enc('deposit', [0n, account]));
  refused(lista.spender, enc('redeem', [1n, stranger, account]));
  refused(lista.spender, enc('redeem', [1n, owner, stranger]), owner);
  refused(lista.spender, enc('redeem', [1n, owner, account]), null);
  refused(aave.spender, enc('supply', [aave.asset, 1n, stranger, 0]));
  refused(aave.spender, enc('supply', [T.contracts.executor, 1n, account, 0]));
  refused(aave.spender, enc('withdraw', [aave.asset, maxUint256, stranger]));
  refused(T.contracts.usdt, enc('approve', [stranger, 1n]));
  refused(aave.receipt, enc('approve', [stranger, 1n]), owner);
  refused(venus.spender, enc('mint', [0n]));
  refused(venus.spender, enc('redeem', [0n]));
  refused(T.contracts.usdt, enc('transfer', [stranger, 1n]), owner);
  assert.equal(dcaVaultCall({ target: lista.spender as Address, callData: enc('approve', [executor, 1n]) }, account, owner), false, 'share approval falls through to receipt rules');
});

test('DCA plan JSON keeps bigint fields exact', () => {
  const plan = { kind: 'withdraw', marketId: lista.marketId, amount: 2n ** 200n, minimum: 1n, deadline: 99n, chainId: 97 } as unknown as YieldPlan;
  const back = restorePlan(JSON.parse(planJson(plan)));
  assert.equal(back.amount, 2n ** 200n); assert.equal(back.deadline, 99n); assert.equal(back.chainId, 97);
});

// ---------------------------------------------------------------- service with in-memory DB/chain fakes
type Row = Record<string, unknown>;
const reading = (patch: Partial<VaultReading> = {}): VaultReading => ({ aprBps: 300, incentiveAprBps: null, totalRaw: 1_000_000n * E18,
  liquidityRaw: 900_000n * E18, supplyPaused: false, redeemPaused: false, capRemainingRaw: null, ...patch });
const TRANSFER = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const transferLog = (from: string, to: string, value: bigint, logIndex = 3) => ({ address: T.contracts.usdt.toLowerCase() as Address,
  topics: encodeEventTopics({ abi: TRANSFER, eventName: 'Transfer', args: { from: from as Address, to: to as Address } }) as Hex[],
  data: encodeAbiParameters([{ type: 'uint256' }], [value]), logIndex });

function harness(opts: { balance?: bigint; classified?: bigint; shares?: bigint; value?: bigint; keyReady?: boolean; now?: Date; allocation?: string[] } = {}) {
  const plans: Row[] = [], actions: Row[] = [], log: string[] = [], submitted: unknown[] = [], credited: unknown[] = [], cash: unknown[][] = [];
  let now = opts.now ?? new Date('2026-11-23T15:00:00Z'); // US market open (10:00 New York)
  const state = { shares: opts.shares ?? 0n, value: opts.value ?? 0n, receipts: new Map<string, Row>() };
  const portfolio: OwnedPortfolio = { id: 7, userId: 'u', strategyId: 3, version: 1, scheduleState: 'active', createdAt: '', chainId: 97,
    accountAddress: account, ownerAddress: owner, existingKeyRefs: [] };
  const query = (async (sql: string, params: unknown[] = []) => {
    const s = sql.replace(/\s+/g, ' ');
    if (s.startsWith('select execution,allocation from strategy_versions')) return { rows: [{ execution: null, allocation: { assets: (opts.allocation ?? ['0x' + '11'.repeat(20)]).map(a => ({ address: a, weightBps: 10000 })) } }] };
    if (s.startsWith('select allocation from strategy_versions')) return { rows: [{ allocation: { assets: (opts.allocation ?? ['0x' + '11'.repeat(20)]).map(a => ({ address: a })) } }] };
    if (s.includes('from session_keys')) return { rows: opts.keyReady ? [{ permissions: { call: { permissions: ['0x63f865c0', '0x5728db07'].map(selector => ({ target: executor, selector, callType: '0x00', valueLimit: '0',
      rules: [{ condition: 0, offset: 0, params: ['0x' + account.slice(2).padStart(64, '0')] }] })) } } }] : [] };
    if (s.includes('from strategy_cash_balances')) return { rows: [{ n: (opts.classified ?? 0n).toString() }] };
    if (s.startsWith('update dca_plans set state=\'closed\',close_reason=\'replaced\'') && s.includes('account=$1')) {
      for (const p of plans) if (p.account === params[0] && p.state === 'awaiting_deposit') Object.assign(p, { state: 'closed', close_reason: 'replaced', closed_at: now });
      return { rows: [] };
    }
    if (s.startsWith('insert into dca_plans')) {
      const [portfolioId, acct, own, vaultId, marketId, total, periods, frequency, tranche, startAt] = params;
      const row = { id: String(plans.length + 1), chain_id: '97', portfolio_id: String(portfolioId), account: acct, owner: own, vault_id: vaultId, market_id: marketId,
        total_raw: total, periods, frequency, tranche_raw: tranche, start_at: startAt, state: 'awaiting_deposit', periods_done: 0, deposited_raw: null,
        deposit_tx_hash: null, deposited_at: null, invested_raw: '0', returned_raw: '0', close_reason: null, closed_at: null, created_at: now };
      plans.push(row); return { rows: [{ id: row.id }] };
    }
    if (s.includes('from dca_plans') && s.includes("state in ('awaiting_deposit','active','paused') order by id desc")) return { rows: plans.filter(p => ['awaiting_deposit', 'active', 'paused'].includes(String(p.state))).slice(-1) };
    if (s.includes('from dca_plans') && s.includes('close_tx_hash=$2')) return { rows: plans.filter(p => p.deposit_tx_hash === params[1] || p.close_tx_hash === params[1]).slice(-1) };
    if (s.includes('from dca_plans') && s.includes('order by (state in')) return { rows: [...plans].reverse().slice(0, 1) };
    if (s.includes('from dca_plans p where p.chain_id=97')) return { rows: plans.filter(p => p.state === 'active' || actions.some(a => a.plan_id === p.id && (['prepared', 'sending', 'submitted', 'unknown'].includes(String(a.state)) || a.state === 'confirmed' && a.lot_id == null))).map(p => ({ ...p, current_portfolio: '7' })) };
    if (s.startsWith("update dca_plans set state='active',deposited_raw")) { const p = plans.find(x => x.id === params[0]); if (p) Object.assign(p, { state: 'active', deposited_raw: params[1], deposit_tx_hash: params[2], deposited_at: now }); return { rows: [] }; }
    if (s.startsWith("update dca_plans set state='closed',close_reason='withdrawn'")) { const p = plans.find(x => x.id === params[0] && ['active', 'paused'].includes(String(x.state))); if (p) Object.assign(p, { state: 'closed', close_reason: 'withdrawn', close_tx_hash: params[1], closed_at: now, returned_raw: (BigInt(String(p.returned_raw)) + BigInt(String(params[2]))).toString() }); return { rows: p ? [{ id: p.id }] : [] }; }
    if (s.startsWith('insert into strategy_cash_balances') || s.startsWith('select portfolio_id from strategy_cash_balances')) return { rows: [] };
    if (s.startsWith('update strategy_cash_balances set allocated_cash_raw')) { cash.push([params[0], params[1]]); return { rows: [] }; }
    if (s.startsWith("update dca_plans set state='closed',close_reason='empty'")) { const p = plans.find(x => x.id === params[0]); if (p) Object.assign(p, { state: 'closed', close_reason: 'empty', closed_at: now }); return { rows: [] }; }
    if (s.startsWith("update dca_plans set state='paused'")) { const p = plans.find(x => x.id === params[0] && x.state === 'active'); if (p) p.state = 'paused'; return { rows: [] }; }
    if (s.startsWith('update dca_plans set state=$2')) { const p = plans.find(x => x.id === params[0]); if (p) p.state = params[1]; return { rows: [] }; }
    if (s.startsWith('update dca_plans set periods_done=$2')) {
      const p = plans.find(x => x.id === params[0]); assert.ok(p);
      Object.assign(p, { periods_done: params[1], invested_raw: (BigInt(String(p.invested_raw)) + BigInt(String(params[2]))).toString(),
        state: params[1] === p.periods && ['active', 'paused'].includes(String(p.state)) ? 'completed' : p.state });
      return { rows: [] };
    }
    if (s.includes('from dca_actions where plan_id=$1 and state in')) return { rows: actions.filter(a => a.plan_id === params[0] && ['prepared', 'sending', 'submitted', 'unknown'].includes(String(a.state))) };
    if (s.includes("from dca_actions where plan_id=$1 and state='confirmed' and lot_id is null")) return { rows: actions.filter(a => a.plan_id === params[0] && a.state === 'confirmed' && a.lot_id == null) };
    if (s.startsWith('insert into dca_actions')) {
      const row = { id: String(actions.length + 1), plan_id: params[0], through_period: params[4], shares_raw: params[5], state: 'prepared', execution_key: params[6], user_op_hash: params[7], nonce: params[8], call_data: params[9], plan: JSON.parse(String(params[10])), lot_id: null };
      actions.push(row); return { rows: [{ id: row.id }] };
    }
    if (s.startsWith("update dca_actions set state='confirmed'")) {
      const a = actions.find(x => x.id === params[0]); assert.ok(a); Object.assign(a, { state: 'confirmed', assets_raw: params[1], tx_hash: params[2] });
      return { rows: [{ plan_id: a.plan_id, through_period: a.through_period }] };
    }
    if (s.startsWith('update dca_actions set state=')) { const a = actions.find(x => x.id === params[0]); if (a) a.state = /state='(\w+)'/.exec(s)?.[1]; return { rows: [] }; }
    if (s.startsWith('update dca_actions set lot_id')) { const a = actions.find(x => x.id === params[0]); if (a) a.lot_id = params[1]; return { rows: [] }; }
    if (s.startsWith('select schedule_state,strategy_id')) return { rows: [{ schedule_state: 'active', strategy_id: '3', version: 1 }] };
    if (s.includes('from operations')) return { rows: [] };
    if (s.startsWith('select owner from smart_accounts')) return { rows: [{ owner }] };
    if (s.startsWith('update portfolios set next_run_at') || s.startsWith('set local')) return { rows: [] };
    // No "sell all" request is open in this harness (src/sell-all-intent.ts): ending one changes nothing.
    if (s === NEW_MONEY_ENDS_SELL_ALL_SQL.replace(/\s+/g, ' ') || s === FINISH_SELL_ALL_SQL.replace(/\s+/g, ' ')) return { rows: [] };
    throw new Error(`unexpected sql: ${s}`);
  }) as unknown as DcaDeps['query'];
  const earn: CashEarnChain = {
    head: async () => ({ number: 100n, timestamp: BigInt(Math.floor(now.getTime() / 1000)) }),
    vault: async (v) => reading(v.protocol === 'venus' ? { aprBps: 500 } : {}),
    position: async (): Promise<PositionReading> => ({ sharesRaw: state.shares, valueRaw: state.value, maxWithdrawRaw: state.value }),
    sharesFor: async () => { throw new Error('venus only'); },
    balance: async (token) => token.toLowerCase() === T.contracts.usdt.toLowerCase() ? opts.balance ?? 0n : state.shares,
    allowance: async () => 0n,
    receipt: async hash => (state.receipts.get(hash) as never) ?? null,
    blockHash: async () => '0x' + 'bb'.repeat(32) as Hex,
  };
  const chain: DcaChain = { earn, sharesFor: async (_v, assets) => assets * 9n / 10n,
    tranche: async (tx, _a, assets) => ({ txHash: tx, logIndex: 4, blockNumber: 101n, blockHash: '0x' + 'cc'.repeat(32) as Hex, amountRaw: assets.toString(), confirmedAt: now }) };
  const deps: Partial<DcaDeps> = {
    chainId: 97, vaults, executor, query, now: () => now, chain: () => chain,
    transaction: (async (fn: (db: { query: typeof query }) => Promise<unknown>) => fn({ query })) as unknown as DcaDeps['transaction'],
    owned: (async (id: number, wallet: string) => { assert.equal(id, 7); if (wallet.toLowerCase() !== owner) throw new AppError(403, 'FORBIDDEN', 'x'); return portfolio; }) as DcaDeps['owned'],
    lock: async (_id, work) => work(), publicClient: () => ({}) as never,
    submit: async args => {
      submitted.push(args.action);
      const id = await args.journal.prepare({ plan: { ...args.action, deadline: 1n, receiptBalance: state.shares } as unknown as YieldPlan, nonce: 5n, callData: '0xab', executionKey: '0x' + '01'.repeat(32), userOpHash: '0x' + '02'.repeat(32) as Hex });
      await args.journal.sending(id); await args.journal.submitted(id, '0x' + '02'.repeat(32) as Hex);
      const evidence = { assets: 100n * E18, shares: args.action.amount, remainingReceipts: 0n, txHash: '0x' + '03'.repeat(32) as Hex, userOpHash: '0x' + '02'.repeat(32) as Hex, gasUsed: 1n };
      await args.journal.confirmed(id, evidence);
      return evidence;
    },
    reconcile: async () => { throw new Error('no receipt'); },
    credit: async (id, own, evidence) => { credited.push({ id, own, evidence }); return { id: String(credited.length + 40) }; },
  };
  return { deps, plans, actions, log, submitted, credited, state, cash, setNow: (d: Date) => { now = d; } };
}

test('DCA create: validates input and minimum per period, needs the money in the account, returns deposit + executor approval calls', async () => {
  const h = harness({ balance: 1_200n * E18, classified: 100n * E18 });
  const dca = createDca(h.deps);
  await assert.rejects(dca.create(7, owner, { totalRaw: '0', periods: 10, frequency: 'weekly' }), isError(400, 'INVALID_AMOUNT'));
  await assert.rejects(dca.create(7, owner, { totalRaw: '1000', periods: 1, frequency: 'weekly' }), isError(400, 'INVALID_PERIODS'));
  await assert.rejects(dca.create(7, owner, { totalRaw: '1000', periods: 10, frequency: 'yearly' }), isError(400, 'INVALID_FREQUENCY'));
  await assert.rejects(dca.create(7, owner, { totalRaw: '1000', periods: 10, frequency: 'weekly', extra: 1 }), isError(400, 'INVALID_DCA_REQUEST'));
  // One complete 10 USDT batch per period (not the 50 USDT one-time minimum).
  await assert.rejects(dca.create(7, owner, { totalRaw: (199n * E18).toString(), periods: 20, frequency: 'weekly' }), isError(400, 'DCA_PERIOD_TOO_SMALL'));
  // startAt: the first purchase date, from "today" in any time zone up to one year ahead.
  await assert.rejects(dca.create(7, owner, { totalRaw: (200n * E18).toString(), periods: 20, frequency: 'weekly', startAt: '2026-11-21T00:00:00Z' }), isError(400, 'INVALID_START'));
  await assert.rejects(dca.create(7, owner, { totalRaw: (200n * E18).toString(), periods: 20, frequency: 'weekly', startAt: '2028-01-01T00:00:00Z' }), isError(400, 'INVALID_START'));
  await assert.rejects(dca.create(7, owner, { totalRaw: (200n * E18).toString(), periods: 20, frequency: 'weekly', startAt: 'tomorrow' }), isError(400, 'INVALID_START'));
  const today = await dca.create(7, owner, { totalRaw: (200n * E18).toString(), periods: 20, frequency: 'weekly', startAt: '2026-11-22T16:00:00Z' });
  assert.equal(today.status === 'ready' && today.startAt, '2026-11-23T15:00:00.000Z', 'Taipei "today" = buy at the next round');
  const later = await dca.create(7, owner, { totalRaw: (200n * E18).toString(), periods: 20, frequency: 'weekly', startAt: '2026-12-01T01:00:00Z' });
  assert.equal(later.status === 'ready' && later.trancheRaw, (10n * E18).toString());
  assert.equal(later.status === 'ready' && later.startAt, '2026-12-01T01:00:00.000Z');
  // 1,200 in the account but 100 already belongs to a funding lot: 1,100 is free.
  await assert.rejects(dca.create(7, owner, { totalRaw: (1_150n * E18).toString(), periods: 10, frequency: 'weekly' }), isError(409, 'DCA_FUNDS_NOT_IN_ACCOUNT'));
  await assert.rejects(dca.create(7, '0x00000000000000000000000000000000000000ff', { totalRaw: '1', periods: 2, frequency: 'daily' }), isError(403, 'FORBIDDEN'));
  const r = await dca.create(7, owner, { totalRaw: (1_000n * E18).toString(), periods: 10, frequency: 'weekly' });
  assert.equal(r.status, 'ready');
  if (r.status !== 'ready') return;
  assert.equal(r.trancheRaw, (100n * E18).toString()); assert.equal(r.authorization, 'renewal_required');
  assert.equal(r.vaultId, 'venus_usdt', 'highest APY among Venus, Lista and Aave');
  assert.deepEqual(r.calls.map(c => c.to), [T.contracts.usdt.toLowerCase(), venus.spender, venus.receipt]);
  assert.equal(h.plans.at(-1)?.state, 'awaiting_deposit');
  // A new request replaces an unconfirmed plan, but not a funded one.
  await dca.create(7, owner, { totalRaw: (1_000n * E18).toString(), periods: 4, frequency: 'monthly', vaultId: 'aave_v3_usdt' });
  assert.deepEqual(h.plans.slice(-2).map(p => [p.state, p.close_reason]), [['closed', 'replaced'], ['awaiting_deposit', null]]);
  await assert.rejects(dca.create(7, owner, { totalRaw: '1', periods: 2, frequency: 'daily', vaultId: 'venus_usdt' }), (e: unknown) => e instanceof AppError);
});

test('DCA confirm/pause/withdraw: deposit must equal the total; the rest goes back to the wallet and closes the plan', async () => {
  const h = harness({ balance: 1_000n * E18 });
  const dca = createDca(h.deps);
  const r = await dca.create(7, owner, { totalRaw: (1_000n * E18).toString(), periods: 10, frequency: 'daily', vaultId: 'lista_usdt' });
  assert.equal(r.status, 'ready');
  const deposit = '0x' + 'd1'.repeat(32), wrong = '0x' + 'd2'.repeat(32), back = '0x' + 'd3'.repeat(32);
  const receipt = (logs: unknown[]) => ({ status: 'success', from: owner, blockNumber: 101n, blockHash: '0x' + 'bb'.repeat(32), logs });
  h.state.receipts.set(wrong, receipt([transferLog(account, lista.custody, 999n * E18)]));
  h.state.receipts.set(deposit, receipt([transferLog(account, lista.custody, 1_000n * E18)]));
  assert.equal((await dca.confirm(7, owner, { txHash: '0x' + 'ee'.repeat(32) })).status, 'pending');
  await assert.rejects(dca.confirm(7, owner, { txHash: wrong }), isError(409, 'DCA_DEPOSIT_MISMATCH'));
  assert.deepEqual(await dca.confirm(7, owner, { txHash: deposit }), { status: 'confirmed', state: 'active' });
  assert.deepEqual(await dca.confirm(7, owner, { txHash: deposit }), { status: 'confirmed', state: 'active' }, 'replay');
  h.state.shares = 990n * E18; h.state.value = 1_001n * E18;
  const view = await dca.get(7, owner);
  assert.equal(view.status, 'active'); assert.equal(view.plan?.earnedRaw, E18.toString()); assert.equal(view.plan?.remainingRaw, (1_001n * E18).toString());
  assert.equal(view.minimumPerPeriodRaw, (10n * E18).toString()); assert.equal(view.offer?.vaultId, 'venus_usdt');
  assert.deepEqual(await dca.setPaused(7, owner, true), { status: 'ok', state: 'paused' });
  assert.deepEqual(await dca.setPaused(7, owner, false), { status: 'ok', state: 'active' });
  const w = await dca.withdraw(7, owner);
  assert.equal(w.status, 'ready'); assert.equal(h.plans[0]?.state, 'paused', 'no more periods while the owner takes the rest back');
  if (w.status !== 'ready') return;
  assert.deepEqual(norm(decodeFunctionData({ abi: DCA_VAULT_ABI, data: w.calls[0]?.data ?? '0x' }).args), [990n * E18, owner, account]);
  h.state.receipts.set(back, receipt([transferLog(lista.custody, owner, 1_001n * E18)]));
  assert.equal((await dca.confirm(7, owner, { txHash: back })).status, 'pending', 'shares still there');
  h.state.shares = 0n;
  assert.deepEqual(await dca.confirm(7, owner, { txHash: back }), { status: 'confirmed', state: 'closed', returnedRaw: (1_001n * E18).toString() });
  assert.equal(h.plans[0]?.returned_raw, (1_001n * E18).toString());
});

test('DCA scheduler: redeems only the due tranche(s) via the executor, waits for the US market, credits one funding lot each', async () => {
  const stock = T.assets.NVDAB?.token ?? Object.values(T.assets)[0]?.token;
  assert.ok(stock);
  const setup = (now?: Date, planOwner: string = owner) => {
    const h = harness({ allocation: [stock], ...(now ? { now } : {}) });
    h.plans.push({ id: '1', chain_id: '97', portfolio_id: '7', account, owner: planOwner, vault_id: 'lista_usdt', market_id: lista.marketId, total_raw: (1_000n * E18).toString(),
      periods: 10, frequency: 'daily', tranche_raw: (100n * E18).toString(), start_at: new Date('2026-11-21T15:00:00Z'), state: 'active', periods_done: 0,
      deposited_raw: (1_000n * E18).toString(), deposit_tx_hash: '0x' + 'd1'.repeat(32), deposited_at: new Date(), invested_raw: '0', returned_raw: '0',
      close_reason: null, closed_at: null, created_at: new Date() });
    h.state.shares = 1_000n * E18; h.state.value = 1_000n * E18;
    const logs: string[] = [];
    return { h, logs, run: (dryRun = false) => runDcaRound({ dryRun, limit: 10, log: l => logs.push(l) }, h.deps) };
  };
  const withAllowance = (h: ReturnType<typeof harness>) => { const base = (h.deps.chain as () => DcaChain)(); const c = { ...base, earn: { ...base.earn, allowance: async () => maxUint256 } }; h.deps.chain = () => c; };
  // Account never approved its vault shares to the executor.
  let t = setup(); await t.run();
  assert.match(t.logs.join('\n'), /DCA_APPROVAL_REQUIRED/); assert.equal(t.h.submitted.length, 0);
  // Sunday: three periods are due but the stock market is closed, so they wait in the vault.
  t = setup(new Date('2026-11-22T15:00:00Z')); withAllowance(t.h); await t.run();
  assert.match(t.logs.join('\n'), /MARKET_CLOSED/); assert.equal(t.h.submitted.length, 0);
  // Same Sunday, a plan of the chain-97 market-hours bypass wallet (deploy/market-hours-bypass.json): the due periods are redeemed now.
  t = setup(new Date('2026-11-22T15:00:00Z'), '0xD3Ab39B62E221bF9E8bA19fE19b2638767d3D6D9'.toLowerCase()); withAllowance(t.h); await t.run(true);
  assert.doesNotMatch(t.logs.join('\n'), /MARKET_CLOSED/); assert.match(t.logs.join('\n'), /DCA_DUE\] dry-run：第 2\/10 期/);
  // The owner's view says the same: waiting for the market, except for the bypass wallet's plan.
  assert.equal((await createDca(setup(new Date('2026-11-22T15:00:00Z')).h.deps).get(7, owner)).plan?.waitingForMarket, true);
  assert.equal((await createDca(t.h.deps).get(7, owner)).plan?.waitingForMarket, false);
  // Monday open: periods 1-3 are caught up in one redemption of 300 USDT (fake ERC4626: 0.9 shares per USDT).
  t = setup(); withAllowance(t.h);
  await t.run(true);
  assert.match(t.logs.join('\n'), /DCA_DUE\] dry-run：第 3\/10 期/); assert.equal(t.h.submitted.length, 0, 'dry-run never submits');
  t.h.deps.sessionKey = async () => null;
  await t.run();
  assert.match(t.logs.join('\n'), /DCA_AUTHORIZATION_REQUIRED/);
  t.h.deps.sessionKey = async () => ({ sessionKey: { keyRef: "m/44'/60'/0'/0/1", permissionId: '0x01020304', sessionKeyAddress: owner, validUntil: 1, owner }, policies: {} });
  const result = await t.run();
  assert.deepEqual(t.h.submitted, [{ marketId: lista.marketId, kind: 'withdraw', amount: 270n * E18 }]);
  assert.equal(t.h.plans[0]?.periods_done, 3); assert.equal(t.h.plans[0]?.invested_raw, (100n * E18).toString());
  assert.equal(t.h.actions[0]?.state, 'confirmed'); assert.equal(t.h.actions[0]?.lot_id, '41');
  assert.equal(result.credited, 1); assert.equal((t.h.credited[0] as { own: string }).own, owner);
  // Nothing more is due today.
  t.logs.length = 0; await t.run(); assert.equal(t.h.submitted.length, 1);
});

test('DCA scheduler: confirmed redemption advances the plan and becomes exactly one funding lot; the last period takes everything', async () => {
  const h = harness({ balance: 0n });
  h.plans.push({ id: '1', chain_id: '97', portfolio_id: '7', account, owner, vault_id: 'lista_usdt', market_id: lista.marketId, total_raw: (300n * E18).toString(),
    periods: 3, frequency: 'daily', tranche_raw: (100n * E18).toString(), start_at: new Date('2026-11-20T15:00:00Z'), state: 'active', periods_done: 0,
    deposited_raw: (300n * E18).toString(), deposit_tx_hash: '0x' + 'd1'.repeat(32), deposited_at: new Date(), invested_raw: '0', returned_raw: '0',
    close_reason: null, closed_at: null, created_at: new Date() } satisfies PlanRow as unknown as Row);
  // Journal + credit path, driven directly (the key loop needs a live chain).
  h.actions.push({ id: '1', plan_id: '1', through_period: 3, shares_raw: '1', state: 'confirmed', assets_raw: (301n * E18).toString(), tx_hash: '0x' + '03'.repeat(32), lot_id: null });
  Object.assign(h.plans[0] ?? {}, { periods_done: 3, state: 'completed', invested_raw: (301n * E18).toString() });
  const result = await runDcaRound({ dryRun: false, limit: 10, log: () => undefined }, h.deps);
  assert.equal(result.credited, 1);
  assert.equal(h.actions[0]?.lot_id, '41');
  assert.deepEqual((h.credited[0] as { id: number; own: string }).id, 7);
  assert.equal(((h.credited[0] as { evidence: { amountRaw: string } }).evidence).amountRaw, (301n * E18).toString());
  assert.equal((await runDcaRound({ dryRun: false, limit: 10, log: () => undefined }, h.deps)).credited, 0, 'never credited twice');
});

test('2026-11-25 "sell all" then a new DCA: the deposit resumes the paused portfolio and the periods are bought; a paused portfolio that still holds assets waits', async () => {
  const stock = T.assets.NVDAB?.token ?? Object.values(T.assets)[0]?.token;
  assert.ok(stock);
  const setup = (onlyCash: boolean | 'unreadable') => {
    const h = harness({ balance: 1_000n * E18, allocation: [stock] });
    const base = h.deps.query as unknown as (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    const asked: number[] = [], logs: string[] = [];
    let schedule = 'paused', selling = false, finished = false;
    h.deps.query = (async (sql: string, params: unknown[] = []) => {
      const s = sql.replace(/\s+/g, ' ');
      if (s === RESUME_AFTER_SELL_ALL_SQL.replace(/\s+/g, ' ')) { assert.deepEqual(params, [7]); schedule = 'active'; return { rows: [] }; }
      // An open "sell all" request: the owner's deposit ends it and the portfolio `/close` paused on the way is managed again.
      if (s === NEW_MONEY_ENDS_SELL_ALL_SQL.replace(/\s+/g, ' ')) { assert.deepEqual(params, [7]); if (selling) { selling = false; schedule = 'active'; } return { rows: [] }; }
      // Paused with nothing but cash: an open request is closed as finished (delivered), before the statement above could cancel it.
      if (s === FINISH_SELL_ALL_SQL.replace(/\s+/g, ' ')) { assert.deepEqual(params, [7]); if (selling) { selling = false; finished = true; } return { rows: [] }; }
      if (s.startsWith('select schedule_state,strategy_id')) return { rows: [{ schedule_state: schedule, strategy_id: '3', version: 1, selling }] };
      return base(sql, params);
    }) as unknown as DcaDeps['query'];
    h.deps.owned = (async (): Promise<OwnedPortfolio> => ({ id: 7, userId: 'u', strategyId: 3, version: 1, scheduleState: schedule, createdAt: '', chainId: 97,
      accountAddress: account, ownerAddress: owner, existingKeyRefs: [] })) as DcaDeps['owned'];
    h.deps.holdsOnlyCash = async id => { asked.push(id); if (onlyCash === 'unreadable') throw new Error('rpc down'); return onlyCash; };
    const chain = (h.deps.chain as () => DcaChain)(), allowed = { ...chain, earn: { ...chain.earn, allowance: async () => maxUint256 } };
    h.deps.chain = () => allowed;
    h.deps.sessionKey = async () => ({ sessionKey: { keyRef: "m/44'/60'/0'/0/1", permissionId: '0x01020304', sessionKeyAddress: owner, validUntil: 1, owner }, policies: {} });
    const dca = createDca(h.deps), deposit = '0x' + 'd1'.repeat(32);
    const open = async () => {
      assert.equal((await dca.create(7, owner, { totalRaw: (1_000n * E18).toString(), periods: 10, frequency: 'daily', vaultId: 'lista_usdt' })).status, 'ready');
      h.state.receipts.set(deposit, { status: 'success', from: owner, blockNumber: 101n, blockHash: '0x' + 'bb'.repeat(32), logs: [transferLog(account, lista.custody, 1_000n * E18)] });
      const confirmed = await dca.confirm(7, owner, { txHash: deposit });
      h.state.shares = 1_000n * E18; h.state.value = 1_000n * E18;
      return confirmed;
    };
    return { h, asked, logs, open, schedule: () => schedule, pause: () => { schedule = 'paused'; }, sellAll: (state: string) => { selling = true; schedule = state; }, selling: () => selling, finished: () => finished,
      confirm: () => dca.confirm(7, owner, { txHash: deposit }),
      round: () => runDcaRound({ dryRun: false, limit: 10, log: l => logs.push(l) }, h.deps) };
  };
  // Sold out, then the owner opens a DCA: active from the deposit on, and the first period is redeemed and credited.
  let t = setup(true);
  assert.deepEqual(await t.open(), { status: 'confirmed', state: 'active' });
  assert.deepEqual([t.schedule(), t.asked], ['active', [7]]);
  const bought = await t.round();
  assert.deepEqual(t.h.submitted, [{ marketId: lista.marketId, kind: 'withdraw', amount: 90n * E18 }]);
  assert.equal(bought.credited, 1); assert.equal(t.h.plans[0]?.periods_done, 1);
  // The same deposit confirmed again is not new money: a portfolio paused since then stays paused.
  t.pause(); assert.deepEqual(await t.confirm(), { status: 'confirmed', state: 'active' });
  assert.deepEqual([t.schedule(), t.asked], ['paused', [7]]);
  // Paused with assets in the account (the owner's own pause), or an account that cannot be read: the DCA is recorded and waits in the vault.
  for (const state of [false, 'unreadable'] as const) {
    t = setup(state);
    const warn = console.warn; console.warn = () => {};
    try { assert.deepEqual(await t.open(), { status: 'confirmed', state: 'active' }); } finally { console.warn = warn; }
    assert.deepEqual([t.schedule(), t.asked], ['paused', [7]]);
    await t.round();
    assert.match(t.logs.join('\n'), /DCA_PORTFOLIO_PAUSED/); assert.equal(t.h.submitted.length, 0);
  }
  // A "sell all" the scheduler has not finished (assets still in the account, the portfolio already paused by the first
  // batch): the owner's new DCA ends that request, so the portfolio is managed again and the first period is bought.
  t = setup(false); t.sellAll('paused');
  assert.deepEqual(await t.open(), { status: 'confirmed', state: 'active' });
  assert.deepEqual([t.schedule(), t.selling(), t.finished()], ['active', false, false]);
  assert.equal((await t.round()).credited, 1);
  // The same with nothing but cash left (everything was sold, the scheduler had not come back to close the request yet):
  // the request ends as finished, which is what turns the old Earn extra consent off (src/strategy-earn-after-sell-all.ts).
  t = setup(true); t.sellAll('paused');
  assert.deepEqual(await t.open(), { status: 'confirmed', state: 'active' });
  assert.deepEqual([t.schedule(), t.selling(), t.finished()], ['active', false, true]);
  // While a "sell all" is open (the portfolio still active, before its first batch) no period is bought: it waits in the vault.
  t = setup(true);
  assert.deepEqual(await t.open(), { status: 'confirmed', state: 'active' });
  t.sellAll('active');
  await t.round();
  assert.match(t.logs.join('\n'), /DCA_PORTFOLIO_PAUSED/); assert.equal(t.h.submitted.length, 0);
});

test('2026-11-25 "holds nothing but cash": wallet balances, posted shares and yield positions of other assets below 0.01 USDT in total', () => {
  const stock = (T.assets.NVDAB?.token ?? Object.values(T.assets)[0]?.token ?? '').toLowerCase(), usdt = T.contracts.usdt.toLowerCase();
  const held = (asset: string, amountWei: bigint) => ({ asset, amountWei, decimals: 18, usdPriceE8: 100_000_000n });
  const plan = (snapshot: Record<string, unknown>) => ({ chainId: 97, snapshot: { holdings: [], unpriced: [], ...snapshot } }) as unknown as PortfolioPlan;
  assert.equal(holdsOnlyCash(plan({})), true, 'empty account');
  assert.equal(holdsOnlyCash(plan({ holdings: [held(usdt, 70n * E18)] })), true, 'the sale proceeds and the new money are cash');
  assert.equal(holdsOnlyCash(plan({ holdings: [held(usdt, 70n * E18), held(stock, 9n * 10n ** 15n)] })), true, 'dust left by the sale');
  assert.equal(holdsOnlyCash(plan({ holdings: [held(stock, 10n ** 16n)] })), false, '0.01 USDT of an asset is a holding (posted shares are in holdings too)');
  assert.equal(holdsOnlyCash(plan({ unpriced: [{ asset: stock, amountWei: 0n }] })), true, 'no price and no balance');
  assert.equal(holdsOnlyCash(plan({ unpriced: [{ asset: stock, amountWei: 1n }] })), false, 'held without a price');
  assert.equal(holdsOnlyCash(plan({ yieldPositions: [{ market: { asset: stock }, value: 5n * E18 }] })), false, 'supplied to a yield market');
  assert.equal(holdsOnlyCash(plan({ yieldPositions: [{ market: { asset: stock }, value: null }] })), false, 'yield position of unknown value');
  assert.equal(holdsOnlyCash(plan({ yieldPositions: [{ market: { asset: stock }, value: 0n }, { market: { asset: usdt }, value: 5n * E18 }] })), true, 'cash earning yield is cash');
});

test('DCA Venus: take the rest back = redeem to the account + forward the quoted value; accrued dust becomes allocated cash, not unclassified', async () => {
  const h = harness({ balance: 1_000n * E18 });
  const dca = createDca(h.deps);
  const r = await dca.create(7, owner, { totalRaw: (1_000n * E18).toString(), periods: 4, frequency: 'monthly' });
  assert.equal(r.status === 'ready' && r.vaultId, 'venus_usdt');
  const receipt = (logs: unknown[]) => ({ status: 'success', from: owner, blockNumber: 101n, blockHash: '0x' + 'bb'.repeat(32), logs });
  const deposit = '0x' + 'e1'.repeat(32), back = '0x' + 'e2'.repeat(32);
  h.state.receipts.set(deposit, receipt([transferLog(account, venus.custody, 1_000n * E18)]));
  await dca.confirm(7, owner, { txHash: deposit });
  h.state.shares = 50_000n * E18; h.state.value = 1_001n * E18;
  const w = await dca.withdraw(7, owner);
  assert.equal(w.status, 'ready');
  if (w.status !== 'ready') return;
  assert.deepEqual(w.calls.map(c => [c.to, decodeFunctionData({ abi: DCA_VAULT_ABI, data: c.data }).functionName]), [[venus.spender, 'redeem'], [venus.asset, 'transfer']]);
  const dust = 3_000_000_000_000n;
  h.state.receipts.set(back, receipt([transferLog(venus.custody, account, 1_001n * E18 + dust, 5), transferLog(account, owner, 1_001n * E18, 6)]));
  h.state.shares = 0n;
  assert.deepEqual(await dca.confirm(7, owner, { txHash: back }), { status: 'confirmed', state: 'closed', returnedRaw: (1_001n * E18).toString() });
  assert.deepEqual(h.cash, [[7, dust.toString()]]);
  assert.deepEqual(await dca.confirm(7, owner, { txHash: back }), { status: 'confirmed', state: 'closed' }, 'replay never classifies twice');
  assert.equal(h.cash.length, 1);
});

test('DCA tranche floor: one 10 USDT fee-inclusive batch forms even with 5% satellites; one-time buys keep 50', async () => {
  const { planFundingContribution } = await import('../src/asset-plan.js');
  const { minimumAssetContribution, minimumDcaTranche } = await import('../src/strategy-execution.js');
  const tokens = Object.values(T.assets).map(a => a.token.toLowerCase()).slice(0, 9);
  const weights = [2000, 1500, 1500, 1500, 1000, 1000, 500, 500, 500];
  const config = { kind: 'per_asset' as const, numeraire: T.contracts.usdt.toLowerCase(), rebalance: 'monthly_drift' as const,
    assets: tokens.map((asset, i) => ({ asset, weightBps: weights[i] ?? 0, execution: { kind: 'hold' as const }, yield: null })) };
  assert.equal(minimumDcaTranche(config), 10n * E18); assert.equal(minimumAssetContribution(config), 50n * E18);
  const withCash = { ...config, assets: [...config.assets.slice(1), { asset: T.contracts.usdt.toLowerCase(), weightBps: 2000, yield: null }] };
  assert.equal(minimumDcaTranche(withCash as never), 13n * E18, 'ceil(10 / 0.8)');
  const at = new Date('2026-11-23T15:00:00Z');
  assert.deepEqual(planFundingContribution(10n * E18, config, at, 97, minimumDcaTranche(config))?.slots.map(s => s.budgetRaw), [(10n * E18).toString()]);
  assert.equal(planFundingContribution(10n * E18, config, at, 97), null, 'a one-time 10 USDT buy is still below the 50 minimum');
  assert.equal(planFundingContribution(9n * E18, config, at, 97, 9n * E18), null, 'below one complete batch never plans');
});
