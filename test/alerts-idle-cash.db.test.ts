import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, test } from 'node:test';
import type { Address } from 'viem';
import { detectPortfolioStuck, resetRoundOutcomes } from '../src/alerts.js';
import { closePool, migrate, query } from '../src/db.js';
import { canonicalConfigHash, validateAssetConfig } from '../src/strategy-execution.js';
import type { Allocation } from '../src/strategies.js';
import { TESTNET_97 } from '../src/testnet-profile.js';

/**
 * Real Postgres (db repo migrations): the "stuck above the drift threshold" alert leaves out idle cash that is under the
 * minimum batch (10 USDT with its fee). The planner cannot buy with it and leaves it as the portfolio's cash on purpose;
 * the snapshot still counts it as drift. Testnet portfolio 7: 8.62 USDT next to 24.74 USD of holdings, 2584 bps, a warn forever.
 */
after(closePool);
const DB = process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('127.0.0.1:1/');
const address = (): Address => `0x${randomBytes(20).toString('hex')}`;
const cash = TESTNET_97.contracts.usdt, a = TESTNET_97.assets.WBNB.token, b = TESTNET_97.assets.ETH.token;
const E8 = 10n ** 8n;

/** A fund portfolio (50/50, cash is the numeraire) whose latest snapshot is `hoursAgo` old: `driftBps`, and `cashUsdt` USDT held (null = no cash row). */
async function portfolio(o: { driftBps: number; totalUsd: string; cashUsdt: string | null; hoursAgo?: number }) {
  const owner = address(), account = address();
  const sid = (await query<{ id: string }>("insert into strategies(provider,name) values($1,'alert-idle-cash') returning id", [owner])).rows[0]!.id;
  await query('update strategies set onchain_id=$2 where id=$1', [sid, Number(sid) + 97000000]);
  const allocation: Allocation = { assets: [{ address: cash, weightBps: 0 }, { address: a, weightBps: 5000 }, { address: b, weightBps: 5000 }] };
  const activeAt = new Date(Math.floor((Date.now() - 3 * 86_400_000) / 60_000) * 60_000);
  const execution = validateAssetConfig({ kind: 'per_asset', numeraire: cash, rebalance: 'none', assets: allocation.assets.map(x => ({ asset: x.address, weightBps: x.weightBps, yield: null,
    ...(x.address === cash ? {} : { execution: { kind: 'stack', every: 'weekly', weekday: 1, timeUtc: '03:00', slices: 2 } }) })) }, allocation, 97);
  const configHash = canonicalConfigHash({ chainId: 97, allocation, execution, schedule: { kind: 'funding' }, activeAt });
  await query(`insert into strategy_versions(strategy_id,version,allocation,schedule,active_at,execution_schema_version,execution,execution_chain_id,config_hash)
    values($1,1,$2,'{"kind":"funding"}',$3,2,$4,97,$5)`, [sid, JSON.stringify(allocation), activeAt, JSON.stringify(execution), configHash]);
  const id = Number((await query<{ id: string }>("insert into portfolios(user_id,strategy_id,version,schedule_state) values($1,$2,1,'active') returning id", [owner, sid])).rows[0]!.id);
  await query("insert into smart_accounts(portfolio_id,chain_id,address,owner,account_type) values($1,97,$2,$3,'KERNEL')", [id, account, owner]);
  const block = 5000, total = BigInt(Math.round(Number(o.totalUsd) * 100)) * E8 / 100n;
  await query(`insert into portfolio_snapshots(portfolio_id,block,native_balance_wei,total_usd_e8,gross_drift_bps,max_abs_delta_bps,threshold_bps,needs_rebalance,complete,unpriced_count,created_at)
    values($1,$4,0,$2,$3,$3,100,true,true,0,now()-make_interval(hours=>$5::int))`, [id, total.toString(), o.driftBps, block, o.hoursAgo ?? 20]);
  if (o.cashUsdt !== null) await query(`insert into positions_snapshots(portfolio_id,asset,amount,usd_value,price_source,priced_at,block) values($1,$2,$3,$3,'numeraire',now(),$4)`, [id, cash, o.cashUsdt, block]);
  await query(`insert into positions_snapshots(portfolio_id,asset,amount,usd_value,price_source,priced_at,block) values($1,$2,1,12.37,'twap',now(),$3)`, [id, a, block]);
  return id;
}
const stuck = async (id: number) => (await detectPortfolioStuck((sql, params) => query(sql, params === undefined ? [] : [...params]), 6, new Date())).filter(f => f.portfolioId === id);

test('drift alert (real Postgres): idle cash under the minimum batch cannot be bought and is not drift; cash that can be bought, and drift between the assets, still are', { skip: !DB }, async () => {
  await migrate();
  resetRoundOutcomes();
  // Testnet portfolio 7: 8.62 USDT idle next to 24.74 USD of holdings = 2584 bps. Before: a warn every round, forever.
  assert.deepEqual(await stuck(await portfolio({ driftBps: 2584, totalUsd: '33.36', cashUsdt: '8.62' })), []);
  // 12 USDT can be bought (≥ 10 with its fee): left unbought past the alert window it is exactly the old alert.
  const buyable = await stuck(await portfolio({ driftBps: 3266, totalUsd: '36.74', cashUsdt: '12' }));
  assert.equal(buyable.length, 1);
  assert.match(String(buyable[0]!.detail), /showed 3266 bps drift \(still above the threshold\)/);
  // Exactly 10 USDT is a batch: not left out.
  assert.equal((await stuck(await portfolio({ driftBps: 2878, totalUsd: '34.74', cashUsdt: '10' }))).length, 1);
  // Un-buyable cash AND the assets are off their weights: only the part that is not the cash is reported.
  // 8.62 of 33.36 is 2583 bps; (4000 − 2583) / (1 − 0.2583) = 1910.
  const both = await stuck(await portfolio({ driftBps: 4000, totalUsd: '33.36', cashUsdt: '8.62' }));
  assert.equal(both.length, 1);
  assert.match(String(both[0]!.detail), /showed 1910 bps drift \(4000 bps observed; 2583 bps of the portfolio is idle cash under the minimum batch, which cannot be bought, and is left out\) \(still above the threshold\)/);
  // No cash row in the snapshot (nothing says how much of the drift is cash): nothing is taken out (the old alert).
  const blind = await stuck(await portfolio({ driftBps: 2584, totalUsd: '33.36', cashUsdt: null }));
  assert.equal(blind.length, 1);
  assert.match(String(blind[0]!.detail), /showed 2584 bps drift \(still above the threshold\)/);
  // No cash at all (fully invested, the assets drifted): untouched.
  assert.equal((await stuck(await portfolio({ driftBps: 500, totalUsd: '100', cashUsdt: '0' }))).length, 1);
});
