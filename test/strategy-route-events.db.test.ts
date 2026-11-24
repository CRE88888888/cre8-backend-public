import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Address, Hex } from 'viem';
import { closePool, getPool, migrate } from '../src/db.js';
import { routeLedger } from '../src/strategy-earn-v2.js';
import type { RouteEvent } from '../src/strategy-earn-v2.js';

after(closePool);
const account = '0x00000000000000000000000000000000000000d5' as Address;
const id = (b: string) => ('0x' + b.repeat(32)) as Hex;

test('db 0069 real SQL: route ledger is idempotent, append-only, and keeps the shape of each kind', async () => {
  await migrate();
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const strategy = (await client.query<{ id: string }>(`insert into strategies(provider,name) values($1,'route db test') returning id`, [account])).rows[0]!.id;
    await client.query(`insert into strategy_versions(strategy_id,version,allocation,schedule) values($1,1,'{}','{}')`, [strategy]);
    const portfolio = Number((await client.query<{ id: string }>(`insert into portfolios(user_id,strategy_id,version) values($1,$2,1) returning id`, [account, strategy])).rows[0]!.id);
    await client.query(`insert into smart_accounts(portfolio_id,chain_id,address,owner,account_type) values($1,56,$2,$2,'KERNEL')`, [portfolio, account]);
    const ledger = routeLedger((sql, params) => client.query(sql, params));
    const base: RouteEvent = { portfolioId: portfolio, account, asset: 'XAUt', kind: 'open', reason: null, routeId: id('a1'), vaultId: id('b1'), fromRouteId: null, fromVaultId: null,
      venue: 'lista', loan: 'USD1', vaultVenue: 'lista', amountRaw: 3n, collateralRaw: 10n, txHash: id('d1'), logIndex: 0, blockNumber: 5n };
    const events: RouteEvent[] = [base,
      { ...base, kind: 'migrate', reason: 'better_route', routeId: id('a2'), vaultId: id('b2'), fromRouteId: id('a1'), fromVaultId: id('b1'), venue: 'venus', loan: 'USDC', vaultVenue: 'aave', logIndex: 1 },
      { ...base, kind: 'switch_vault', reason: 'better_route', asset: null, routeId: null, vaultId: id('b3'), fromVaultId: id('b2'), venue: null, loan: null, logIndex: 2 },
      { ...base, kind: 'release', asset: null, routeId: null, venue: null, loan: null, collateralRaw: 0n, logIndex: 3 }];
    await ledger.record(56, events); await ledger.record(56, events);
    assert.equal((await client.query<{ n: string }>('select count(*)::text n from strategy_route_events where portfolio_id=$1', [portfolio])).rows[0]?.n, '4');
    // Current route of an asset = its newest open / migrate row.
    const current = (await client.query(`select kind, venue, loan, vault_venue from strategy_route_events where portfolio_id=$1 and asset='XAUt' and kind in ('open','migrate') order by block_number desc, log_index desc limit 1`, [portfolio])).rows[0];
    assert.deepEqual(current, { kind: 'migrate', venue: 'venus', loan: 'USDC', vault_venue: 'aave' });
    for (const bad of [{ ...base, kind: 'migrate' as const, logIndex: 9 }, { ...base, fromRouteId: id('a9'), logIndex: 9 }, { ...base, routeId: null, logIndex: 9 }, { ...base, portfolioId: portfolio + 1_000_000, logIndex: 9 }]) {
      await client.query('savepoint s'); await assert.rejects(ledger.record(56, [bad])); await client.query('rollback to savepoint s');
    }
    await client.query('savepoint s'); await assert.rejects(client.query(`delete from strategy_route_events where portfolio_id=$1`, [portfolio]), /append-only/); await client.query('rollback to savepoint s');
  } finally {
    await client.query('rollback');
    client.release();
  }
});
