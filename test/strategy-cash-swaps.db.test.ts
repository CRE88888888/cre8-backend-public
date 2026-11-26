import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Address, Hex, Log } from 'viem';
import { closePool, getPool, migrate } from '../src/db.js';
import { cashSwapVaultId, readCashSwapEvents, recoverCashSwaps, resetCashSwapRecovery, settleCashSwaps } from '../src/strategy-cash-swaps.js';
import type { StrategyEarnV2, SwapEvent } from '../src/strategy-earn-v2.js';
import { claimedCash, strategySpendableCash } from '../src/withdrawable-cash.js';
import type { WithTransactionFn } from '../src/scheduler.js';

after(closePool);
const A = (n: number) => ('0x' + n.toString(16).padStart(40, '0')) as Address;
const account = A(0xd7), other = A(0xd8), SWAPPER = A(0xe8), USDC = A(0xc1), USDT = A(0xa1);
const hash = (b: string) => ('0x' + b.repeat(32)) as Hex;
const E = 10n ** 18n;
const v2 = { chainId: 56, executor: A(0xe1), registry: A(0xe2), lens: A(0xe3), venusComptroller: A(0xe4), moolah: A(0xe5), loanTokens: { USDT, USDC }, rewardTokens: [], adapters: [], canaryOwners: [], swapper: SWAPPER, swapperPools: [] } as StrategyEarnV2;
const event = (kind: SwapEvent['kind'], usdt: bigint, tx: string, logIndex: number, o: Partial<SwapEvent> = {}): SwapEvent => ({ kind, account, token: USDC, usdtRaw: usdt, tokenRaw: usdt, needRaw: kind === 'top_up' ? usdt : null, txHash: hash(tx), logIndex, blockNumber: 500n, ...o });

test('cash swap ledger, real SQL: a top-up leaves the portfolio\'s own cash and a cash-out joins it, exactly once per event; no other bucket and no other portfolio moves', async () => {
  await migrate();
  const client = await getPool().connect();
  try {
    await client.query('begin');
    // Everything runs inside this test's transaction (savepoints stand in for the commits) and is rolled back at the end.
    const run: WithTransactionFn = async fn => { await client.query('savepoint w'); try { const r = await fn({ query: (text, params) => client.query(text, params ? [...params] : []) }); await client.query('release savepoint w'); return r; } catch (e) { await client.query('rollback to savepoint w'); throw e; } };
    const strategy = (await client.query<{ id: string }>(`insert into strategies(provider,name) values($1,'cash swap db test') returning id`, [account])).rows[0]!.id;
    await client.query(`insert into strategy_versions(strategy_id,version,allocation,schedule) values($1,1,'{}','{}')`, [strategy]);
    const make = async (address: Address) => {
      const portfolio = Number((await client.query<{ id: string }>(`insert into portfolios(user_id,strategy_id,version) values($1,$2,1) returning id`, [address, strategy])).rows[0]!.id);
      await client.query(`insert into smart_accounts(portfolio_id,chain_id,address,owner,account_type) values($1,56,$2,$2,'KERNEL')`, [portfolio, address]);
      return portfolio;
    };
    const mine = await make(account), theirs = await make(other);
    for (const [p, a] of [[mine, account], [theirs, other]] as const) await client.query(`insert into strategy_cash_balances(chain_id,portfolio_id,account,unallocated_hold_raw,allocated_cash_raw,reserved_input_raw,reserved_fee_raw,yield_raw)
      values(56,$1,$2,$3,$4,$5,$6,$7)`, [p, a, (40n * E).toString(), (30n * E).toString(), (20n * E).toString(), (2n * E).toString(), (5n * E).toString()]);
    const row = async (p: number) => (await client.query(`select unallocated_hold_raw::text,stack_prefund_raw::text,allocated_cash_raw::text,reserved_input_raw::text,reserved_fee_raw::text,withdrawal_raw::text,yield_raw::text,unclassified_raw::text
      from strategy_cash_balances where chain_id=56 and portfolio_id=$1`, [p])).rows[0] as Record<string, string>;
    const before = await row(mine), untouched = await row(theirs);
    // What a top-up may spend: the own cash (30) plus what no bucket claims. 100 in the account, 97 claimed -> 3 unclaimed + 30.
    assert.equal(strategySpendableCash(100n * E, before), 33n * E);
    assert.equal(strategySpendableCash(60n * E, before), 0n, 'below the other buckets (67): nothing, even though the own cash reads 30');
    assert.equal(strategySpendableCash(80n * E, before), 13n * E);

    // One UserOp: top-up 12 USDT, cash-out 1.5 USDT back.
    const first = [event('top_up', 12n * E, 'a1', 3), event('cash_out', 15n * E / 10n, 'a1', 8)];
    assert.deepEqual(await settleCashSwaps(run, v2, { chainId: 56, portfolioId: mine, account }, first), { applied: 2, skipped: 0 });
    let now = await row(mine);
    assert.equal(now.allocated_cash_raw, (30n * E - 12n * E + 15n * E / 10n).toString());
    assert.deepEqual({ ...now, allocated_cash_raw: before.allocated_cash_raw }, before, 'only the own cash moved');
    // The same receipt again (confirm twice, a scheduler retry, the recovery scan): nothing changes.
    assert.deepEqual(await settleCashSwaps(run, v2, { chainId: 56, portfolioId: mine, account }, first), { applied: 0, skipped: 2 });
    assert.equal((await row(mine)).allocated_cash_raw, now.allocated_cash_raw);
    // The record: bookkeeping rows of the route ledger (kind release, never shown in the activity list), one per event.
    const marks = (await client.query(`select kind,reason,asset,route_id,vault_id,loan,amount_raw::text,collateral_raw::text,log_index,block_number::text from strategy_route_events where portfolio_id=$1 order by log_index`, [mine])).rows;
    assert.deepEqual(marks, [
      { kind: 'release', reason: 'top_up', asset: null, route_id: null, vault_id: cashSwapVaultId(SWAPPER), loan: 'USDC', amount_raw: (12n * E).toString(), collateral_raw: (12n * E).toString(), log_index: 3, block_number: '500' },
      { kind: 'release', reason: 'cash_out', asset: null, route_id: null, vault_id: cashSwapVaultId(SWAPPER), loan: 'USDC', amount_raw: (15n * E / 10n).toString(), collateral_raw: (15n * E / 10n).toString(), log_index: 8, block_number: '500' }]);
    // A top-up larger than the own cash: the rest came from USDT no bucket claimed — the bucket stops at 0, nothing else pays.
    assert.deepEqual(await settleCashSwaps(run, v2, { chainId: 56, portfolioId: mine, account }, [event('top_up', 25n * E, 'a2', 0)]), { applied: 1, skipped: 0 });
    now = await row(mine);
    assert.deepEqual({ ...now, allocated_cash_raw: before.allocated_cash_raw }, before);
    assert.equal(now.allocated_cash_raw, '0');
    assert.equal(claimedCash(now), 67n * E);
    // Events of another account in the same receipt, and events from before the ledger rule existed, are not booked.
    assert.deepEqual(await settleCashSwaps(run, v2, { chainId: 56, portfolioId: mine, account }, [event('cash_out', 9n * E, 'a3', 0, { account: other })]), { applied: 0, skipped: 0 });
    assert.deepEqual(await settleCashSwaps(run, { ...v2, swapLedgerFromBlock: 501n }, { chainId: 56, portfolioId: mine, account }, [event('cash_out', 9n * E, 'a4', 0)]), { applied: 0, skipped: 0 });
    assert.equal((await row(mine)).allocated_cash_raw, '0');
    // A failure inside the booking leaves neither the marker nor the change behind (they commit together).
    await assert.rejects(settleCashSwaps(run, v2, { chainId: 56, portfolioId: mine, account }, [event('cash_out', 4n * E, 'a5', 0), event('cash_out', 1n, 'a5', -1)]), /invalid cash swap event/);
    assert.equal((await row(mine)).allocated_cash_raw, '0');
    assert.deepEqual(await settleCashSwaps(run, v2, { chainId: 56, portfolioId: mine, account }, [event('cash_out', 4n * E, 'a5', 0)]), { applied: 1, skipped: 0 });
    assert.equal((await row(mine)).allocated_cash_raw, (4n * E).toString());
    // A portfolio without a cash row has no cash ledger (nothing claims its USDT): nothing is booked, no row is created, no marker left.
    const bare = await make(A(0xd9));
    assert.deepEqual(await settleCashSwaps(run, v2, { chainId: 56, portfolioId: bare, account: A(0xd9) }, [event('top_up', 2n * E, 'c1', 0, { account: A(0xd9) })]), { applied: 0, skipped: 0 });
    assert.deepEqual([(await client.query('select 1 from strategy_cash_balances where portfolio_id=$1', [bare])).rows.length, (await client.query('select 1 from strategy_route_events where portfolio_id=$1', [bare])).rows.length], [0, 0]);
    // The other portfolio (same owner or not) never moved.
    assert.deepEqual(await row(theirs), untouched);

    // Recovery scan: a top-up whose booking never happened (the owner's confirm never came) is found in the swapper's logs
    // and booked once; older events and the ones already booked stay as they are. Off without `ledgerFromBlock`.
    const log = (name: 'ToppedUp' | 'CashedOut', usdt: bigint, tx: string, logIndex: number, block: bigint): Log => {
      const { encodeAbiParameters, encodeEventTopics } = require('viem') as typeof import('viem');
      const { V2_SWAPPER_ABI } = require('../src/strategy-earn-v2.js') as typeof import('../src/strategy-earn-v2.js');
      return { address: SWAPPER, blockNumber: block, transactionHash: hash(tx), logIndex, removed: false, blockHash: hash('00'), transactionIndex: 0,
        topics: encodeEventTopics({ abi: V2_SWAPPER_ABI, eventName: name, args: { account, token: USDC } }),
        data: name === 'ToppedUp' ? encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [usdt, usdt, usdt]) : encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [usdt, usdt]) } as unknown as Log;
    };
    const ADAPTER = A(0xad), BOX = A(0xb0), topic = (x: Address) => ('0x' + '00'.repeat(12) + x.slice(2)) as Hex;
    const transfer = (from: Address, to: Address, value: bigint, tx: string, logIndex: number, block: bigint): Log => ({ address: USDT, blockNumber: block, transactionHash: hash(tx), logIndex, removed: false, blockHash: hash('00'), transactionIndex: 0,
      topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', topic(from), topic(to)], data: ('0x' + value.toString(16).padStart(64, '0')) as Hex }) as unknown as Log;
    const live = { ...v2, adapters: [ADAPTER], swapLedgerFromBlock: 100n };
    const chain = [log('CashedOut', 4n * E, 'a5', 0, 500n), log('ToppedUp', 3n * E, 'b1', 2, 620n), log('ToppedUp', 1n * E, 'b0', 1, 90n),
      // A route that borrows USDT: the executor took 2 USDT of the account for a repayment; later the vault's 0.5 USDT surplus
      // and 0.25 idle in the box were paid back to the account. A transfer to somebody else is none of the strategy's.
      transfer(account, live.executor, 2n * E, 'b2', 4, 630n), transfer(ADAPTER, account, E / 2n, 'b3', 6, 640n), transfer(BOX, account, E / 4n, 'b3', 9, 640n), transfer(account, other, 7n * E, 'b4', 0, 650n)];
    const asked: [bigint, bigint][] = [];
    const one = (x: Address | readonly Address[] | undefined) => x === undefined ? null : (Array.isArray(x) ? x : [x]).map(a => topic(a as Address));
    const reader = { getBlockNumber: async () => 700n, getLogs: async (f: import('../src/strategy-cash-swaps.js').CashSwapLogFilter) => {
      if (f.address === SWAPPER) { asked.push([f.fromBlock, f.toBlock]); assert.equal(f.args.account, account); }
      const from = one(f.args.from), to = one(f.args.to);
      return chain.filter(l => l.address === f.address && l.blockNumber! >= f.fromBlock && l.blockNumber! <= f.toBlock && (f.address === SWAPPER || (from === null || from.includes(l.topics[1]!)) && (to === null || to.includes(l.topics[2]!))));
    } };
    resetCashSwapRecovery();
    assert.equal(await recoverCashSwaps({ reader, run, now: () => 1_000_000 }, v2, { chainId: 56, portfolioId: mine, account }), 0, 'no ledgerFromBlock: off');
    // Found and booked once: the top-up (-3), the USDT repayment (-2, the bucket stops at 0), what came back (+0.5 +0.25).
    assert.equal(await recoverCashSwaps({ reader, run, now: () => 1_000_000, box: async () => BOX }, live, { chainId: 56, portfolioId: mine, account }), 4);
    assert.deepEqual(asked, [[100n, 700n]]);
    assert.equal((await row(mine)).allocated_cash_raw, (E / 2n + E / 4n).toString());
    assert.deepEqual((await client.query(`select reason,vault_id,loan,amount_raw::text from strategy_route_events where portfolio_id=$1 and block_number>=630 order by block_number,log_index`, [mine])).rows, [
      { reason: 'repay_cash', vault_id: cashSwapVaultId(live.executor), loan: 'USDT', amount_raw: (2n * E).toString() },
      { reason: 'vault_cash', vault_id: cashSwapVaultId(live.executor), loan: 'USDT', amount_raw: (E / 2n).toString() },
      { reason: 'vault_cash', vault_id: cashSwapVaultId(live.executor), loan: 'USDT', amount_raw: (E / 4n).toString() }]);
    // Not again within ten minutes; afterwards it looks again and finds nothing new.
    assert.equal(await recoverCashSwaps({ reader, run, now: () => 1_000_000 + 60_000, box: async () => BOX }, live, { chainId: 56, portfolioId: mine, account }), 0);
    assert.equal(asked.length, 1);
    assert.equal(await recoverCashSwaps({ reader, run, now: () => 1_000_000 + 11 * 60_000, box: async () => BOX }, live, { chainId: 56, portfolioId: mine, account }), 0);
    assert.equal((await row(mine)).allocated_cash_raw, (E / 2n + E / 4n).toString());
    assert.deepEqual((await readCashSwapEvents(reader, live, account, 600n, 700n)).map(e => [e.kind, e.usdtRaw, e.logIndex, e.blockNumber]), [['top_up', 3n * E, 2, 620n], ['repay_cash', 2n * E, 4, 630n], ['vault_cash', E / 2n, 6, 640n]]);
    // Everything but the own cash is still exactly what it was.
    assert.deepEqual({ ...await row(mine), allocated_cash_raw: before.allocated_cash_raw }, before);
    assert.deepEqual(await row(theirs), untouched);
  } finally {
    await client.query('rollback');
    client.release();
  }
});
