import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Address, PublicClient } from 'viem';
import { reconcileCashWithdrawals } from '../src/cash-reconciliation.js';
import { mixCashWithdrawals } from '../src/mix-flows.js';
import type { DuePortfolio, SchedulerQueryFn } from '../src/scheduler.js';
import type { PortfolioPlan } from '../src/snapshot.js';
import { defaultNewMoneyDeps } from '../src/strategy-runtime.js';

// Portfolio 13 (2026-11-23): the My mix tick recorded a DCA deposit (account -> Venus vault) from mix_cash_flows as a
// cash withdrawal; the strategy path then compared saved withdrawals with its owner-transfer scan and hit [CASH_REORGED].
const dcaDeposit = { tx_hash: `0x07d0${'b9'.repeat(30)}`, log_index: '3', block_number: '200', block_hash: `0x${'ab'.repeat(32)}`, amount_raw: '100000000000000000000' };

function fakeDb() {
  const ops: { idempotency_key: string; payload_hash: string }[] = [];
  const balances = { unclassified_raw: '0', allocated_cash_raw: '0', unallocated_hold_raw: '0', stack_prefund_raw: '0',
    reserved_input_raw: '0', reserved_fee_raw: '0', withdrawal_raw: '0', yield_raw: '0' };
  const query: SchedulerQueryFn = async (sql, params) => {
    if (sql.includes('from mix_cash_flows')) return { rows: [dcaDeposit] };
    if (sql.includes('from operations')) return { rows: ops };
    if (sql.startsWith('select * from strategy_cash_balances')) return { rows: [balances] };
    if (sql.startsWith('update strategy_cash_balances')) return { rows: [] };
    if (sql.startsWith('insert into operations')) { ops.push({ idempotency_key: String(params?.[1]), payload_hash: String(params?.[2]) }); return { rows: [] }; }
    throw new Error(`unexpected sql: ${sql.slice(0, 60)}`);
  };
  return { ops, query };
}

test('a My mix strategy round reconciles the same withdrawals the mix tick saved (no [CASH_REORGED] after a DCA deposit)', async () => {
  const db = fakeDb();
  const mixEvents = await mixCashWithdrawals(13, db.query, 300n);
  await reconcileCashWithdrawals(db.query, { chainId: 97, portfolioId: 13, observedCash: 0n }, mixEvents);
  assert.equal(db.ops.length, 1);

  // The owner-transfer scan finds no account -> owner transfer in that tx: with it, the saved op looks reorged.
  await assert.rejects(reconcileCashWithdrawals(db.query, { chainId: 97, portfolioId: 13, observedCash: 0n }, []), /CASH_REORGED/);

  const noRpc = (): PublicClient => { throw new Error('a My mix withdrawal read must not scan the chain'); };
  const deps = defaultNewMoneyDeps(noRpc, () => '0x0000000000000000000000000000000000000001', () => '0x0000000000000000000000000000000000000002', db.query, 97);
  const due = { personalMix: true, portfolioId: 13, strategyId: 1, account: '0x0000000000000000000000000000000000000003' as Address } as DuePortfolio;
  const strategyEvents = await deps.withdrawals(due, { snapshot: { block: 300n } } as PortfolioPlan);
  assert.deepEqual(strategyEvents, mixEvents);
  await reconcileCashWithdrawals(db.query, { chainId: 97, portfolioId: 13, observedCash: 0n }, strategyEvents);
  assert.equal(db.ops.length, 1);
});
