import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Address, Hex } from 'viem';
import { closePool, getPool, migrate } from '../src/db.js';
import { createStrategyEarn, strategyEarnLedger, strategyMarkets, STRATEGY_EARN_97 as S } from '../src/strategy-earn.js';
import type { StrategyEarnEvent } from '../src/strategy-earn.js';

after(closePool);
const account = '0x00000000000000000000000000000000000000e4' as Address;
const nvda = strategyMarkets()[0]!;

test('#204 real SQL: ledger is idempotent per (tx, log), separate per portfolio, and the activity reads it newest first', async () => {
  await migrate();
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const strategy = (await client.query<{ id: string }>(`insert into strategies(provider,name) values($1,'earn db test') returning id`, [account])).rows[0]!.id;
    await client.query(`insert into strategy_versions(strategy_id,version,allocation,schedule) values($1,1,'{}','{}')`, [strategy]);
    const portfolio = Number((await client.query<{ id: string }>(`insert into portfolios(user_id,strategy_id,version) values($1,$2,1) returning id`, [account, strategy])).rows[0]!.id);
    await client.query(`insert into smart_accounts(portfolio_id,chain_id,address,owner,account_type) values($1,97,$2,$2,'KERNEL')`, [portfolio, account]);
    const base = { portfolioId: portfolio, account, marketId: nvda.marketId, asset: 'NVDAB', collateralRaw: 0n, ltvBeforeBps: null, ltvAfterBps: null, blockNumber: 10n };
    const events: StrategyEarnEvent[] = [
      { ...base, kind: 'open', amountRaw: 240n * 10n ** 18n, collateralRaw: 5n * 10n ** 18n, txHash: `0x${'01'.repeat(32)}` as Hex, logIndex: 2 },
      { ...base, kind: 'deleverage', amountRaw: 675n * 10n ** 17n, ltvBeforeBps: 4174, ltvAfterBps: 3000, txHash: `0x${'02'.repeat(32)}` as Hex, logIndex: 0, blockNumber: 11n },
      { ...base, kind: 'claim', marketId: S.earnVaultMarketId as Hex, asset: null, amountRaw: 10n ** 16n, txHash: `0x${'03'.repeat(32)}` as Hex, logIndex: 1, blockNumber: 12n },
    ];
    const ledger = strategyEarnLedger((sql, params) => client.query(sql, params));
    await ledger.record(97, events);
    await ledger.record(97, events); // re-read receipt: no duplicates
    assert.equal((await client.query<{ n: string }>('select count(*)::text n from strategy_earn_events where portfolio_id=$1', [portfolio])).rows[0]?.n, '3');
    // Wrong portfolio for this account is refused by the database, not silently filed elsewhere.
    await client.query('savepoint s');
    await assert.rejects(ledger.record(97, [{ ...events[0]!, portfolioId: portfolio + 1_000_000, logIndex: 9 }]));
    await client.query('rollback to savepoint s');
    const earn = createStrategyEarn({ chainId: 97, owned: (async () => ({ chainId: 97, ownerAddress: account, accountAddress: account })) as never, query: ((sql: string, params?: unknown[]) => client.query(sql, params)) as never });
    const view = await earn.activity(portfolio, account);
    assert.deepEqual(view.activity.map(a => [a.kind, a.amountRaw, a.message]), [
      ['claim', '10000000000000000', 'Received 0.01 USDT in Earn rewards.'],
      ['deleverage', '67500000000000000000', 'NVDAB fell, so we automatically used 67.50 USDT from Earn to stay safe (safety level 41.7% → 30.0%).'],
      ['open', '240000000000000000000', 'Earn extra turned on for NVDAB: 5 NVDAB put to work, 240.00 USDT now earning.']]);
  } finally {
    await client.query('rollback');
    client.release();
  }
});
