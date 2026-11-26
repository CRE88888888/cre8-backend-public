import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, test } from 'node:test';
import type { Address, Hex } from 'viem';
import { detectPortfolioStuck, resetRoundOutcomes } from '../src/alerts.js';
import { planContribution } from '../src/asset-plan.js';
import { closePool, migrate, query, withPortfolioLock, withTransaction } from '../src/db.js';
import { USDT_UNIT as U } from '../src/new-money-plan.js';
import type { WithTransactionFn } from '../src/scheduler.js';
import { canonicalConfigHash, UINT256_MAX, validateAssetConfig } from '../src/strategy-execution.js';
import { fundingLots, prepareStrategyJob } from '../src/strategy-jobs.js';
import type { JobContext } from '../src/strategy-jobs.js';
import type { Allocation } from '../src/strategies.js';
import { TESTNET_97 } from '../src/testnet-profile.js';

/**
 * Real Postgres (db repo migrations): the "stuck above the drift threshold" alert leaves out scheduled (定投) principal whose
 * periods are not due yet. Testnet portfolio 4: 8 weekly periods, the first one bought, 7/8 of the money waiting as cash ->
 * the snapshot says 8755 bps and the alert stayed a warn until the last period was bought.
 */
after(closePool);
const DB = process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('127.0.0.1:1/');
const address = (): Address => `0x${randomBytes(20).toString('hex')}`;
const hash = (): Hex => `0x${randomBytes(32).toString('hex')}`;
const cash = TESTNET_97.contracts.usdt, a = TESTNET_97.assets.WBNB.token, b = TESTNET_97.assets.ETH.token;
const R = 27n * U / 100n, HOUR = 3_600_000, DAY = 24 * HOUR;
const run: WithTransactionFn = fn => withTransaction(client => fn({ query: (s, p) => client.query(s, p === undefined ? [] : [...p]) }));

/** A fund portfolio whose two assets are each bought in 8 weekly periods; `confirmedAt` = when the money arrived. */
async function weeklyPortfolio(confirmedAt: Date) {
  const owner = address(), account = address();
  const sid = (await query<{ id: string }>("insert into strategies(provider,name) values($1,'alert-pending-stack') returning id", [owner])).rows[0]!.id;
  await query('update strategies set onchain_id=$2 where id=$1', [sid, Number(sid) + 98000000]);
  const allocation: Allocation = { assets: [{ address: cash, weightBps: 0 }, { address: a, weightBps: 5000 }, { address: b, weightBps: 5000 }] };
  const activeAt = new Date(confirmedAt.getTime() - DAY);
  const execution = validateAssetConfig({ kind: 'per_asset', numeraire: cash, rebalance: 'none', assets: allocation.assets.map(x => ({ asset: x.address, weightBps: x.weightBps, yield: null,
    ...(x.address === cash ? {} : { execution: { kind: 'stack', every: 'weekly', weekday: new Date(confirmedAt.getTime() + HOUR).getUTCDay(), timeUtc: new Date(confirmedAt.getTime() + HOUR).toISOString().slice(11, 16), slices: 8 } }) })) }, allocation, 97);
  const configHash = canonicalConfigHash({ chainId: 97, allocation, execution, schedule: { kind: 'funding' }, activeAt });
  await query(`insert into strategy_versions(strategy_id,version,allocation,schedule,active_at,execution_schema_version,execution,execution_chain_id,config_hash)
    values($1,1,$2,'{"kind":"funding"}',$3,2,$4,97,$5)`, [sid, JSON.stringify(allocation), activeAt, JSON.stringify(execution), configHash]);
  const id = Number((await query<{ id: string }>("insert into portfolios(user_id,strategy_id,version,schedule_state) values($1,$2,1,'active') returning id", [owner, sid])).rows[0]!.id);
  await query("insert into smart_accounts(portfolio_id,chain_id,address,owner,account_type) values($1,97,$2,$3,'KERNEL')", [id, account, owner]);
  await query('insert into strategy_cash_balances(chain_id,portfolio_id,account) values(97,$1,$2)', [id, account]);
  const amount = 800n * U;
  const certificate = planContribution(amount, execution, confirmedAt, R); assert.ok(certificate);
  const lot = await withTransaction(async client => {
    const row = (await client.query<{ id: string }>(`insert into strategy_funding_lots(chain_id,portfolio_id,strategy_id,version,kind,tx_hash,log_index,block_number,block_hash,amount_raw,minimum_contribution_raw,effective_slices,created_at,updated_at,effective_allocation,allocation_reason,capped_assets)
      values(97,$1,$2,1,'asset',$3,0,10,$4,$5,$6,$7,$8,$8,null,'version','[]') returning id`, [id, sid, hash(), hash(), amount.toString(), certificate.minimum.toString(), JSON.stringify(certificate.effectiveSlices), confirmedAt])).rows[0]!;
    await client.query('update strategy_cash_balances set stack_prefund_raw=stack_prefund_raw+$2::numeric where portfolio_id=$1', [id, amount.toString()]);
    return row.id;
  });
  const sources = (await query<{ first_slot_at: Date; effective_slices: number; budget_raw: string }>('select first_slot_at,effective_slices,budget_raw::text from strategy_lot_assets where lot_id=$1 and asset<>$2 order by asset', [lot, cash])).rows;
  assert.deepEqual(sources.map(s => [s.effective_slices, s.budget_raw]), [[8, (400n * U).toString()], [8, (400n * U).toString()]]);
  const firstSlot = sources[0]!.first_slot_at;
  const context = (now: Date): JobContext => ({ chainId: 97, portfolioId: id, strategyId: Number(sid), version: 1, kind: 'asset', execution, account, allocation, cash, now, reserve: R,
    caps: new Map([[a, null], [b, null]]), buyLimit: UINT256_MAX, observedCash: 1000000n * U, enabled: true, marketOpen: true });
  /** The scheduler picks up whatever period is due at `now` (records its slices and reserves the money), as in production. */
  const buyDue = async (now: Date) => { const c = context(now); const lots = await fundingLots(query, c); return withPortfolioLock(id, () => prepareStrategyJob(run, c, lots)); };
  /** The snapshot the round wrote after a buy: cash waiting next to the bought holdings. */
  const snapshot = (driftBps: number, hoursAgo: number, block: number) => query(`insert into portfolio_snapshots(portfolio_id,block,native_balance_wei,total_usd_e8,gross_drift_bps,max_abs_delta_bps,threshold_bps,needs_rebalance,complete,unpriced_count,created_at)
    values($1,$5,0,$2,$3,$3,100,true,true,0,now()-make_interval(hours=>$4::int))`, [id, (800n * 10n ** 8n).toString(), driftBps, hoursAgo, block]);
  return { id, firstSlot, buyDue, snapshot };
}

test('drift alert (real Postgres): principal of periods that are not due yet is not drift; a period left unbought past the alert window is', { skip: !DB }, async () => {
  await migrate();
  resetRoundOutcomes();
  // The money arrived 30 hours ago; the first weekly period came one hour later and was bought; the snapshot after it is 20 hours old.
  const confirmedAt = new Date(Math.floor((Date.now() - 30 * HOUR) / 60_000) * 60_000);
  const p = await weeklyPortfolio(confirmedAt);
  assert.ok(p.firstSlot.getTime() > confirmedAt.getTime() && p.firstSlot.getTime() <= confirmedAt.getTime() + 2 * HOUR, `first slot ${p.firstSlot.toISOString()}`);
  const first = await p.buyDue(new Date(p.firstSlot.getTime() + 60_000));
  assert.ok(first?.job, first?.reason);
  await p.snapshot(8755, 20, 1000);
  const mine = async (now: Date) => (await detectPortfolioStuck((sql, params) => query(sql, params === undefined ? [] : [...params]), 6, now)).filter(f => f.portfolioId === p.id);

  // Before: a warn with "8755 bps" every round for seven weeks. 7 of 8 periods (700 of 800 USDT) are simply not due.
  assert.deepEqual(await mine(new Date()), []);
  // The second period comes due: for the alert's own 6 hours that is not "stuck" either (the scheduler buys it within minutes).
  const second = p.firstSlot.getTime() + 7 * DAY;
  assert.deepEqual(await mine(new Date(second + HOUR)), []);
  // Still unbought 7 hours after it came due: its 100 USDT counts again. (8755 − 7500) / (1 − 0.75) = 5020 bps.
  const late = await mine(new Date(second + 7 * HOUR));
  assert.equal(late.length, 1);
  assert.match(String(late[0]!.detail), /showed 5020 bps drift \(8755 bps observed; 7500 bps of the portfolio is scheduled principal not due yet and is left out\)/);
  // Once that period is handled and the round has written its snapshot (6 of 8 still waiting: 7505 bps), the remaining six
  // are again just waiting.
  const picked = await p.buyDue(new Date(second + 7 * HOUR));
  assert.ok(picked?.job, picked?.reason);
  await p.snapshot(7505, 7, 1001);
  assert.deepEqual(await mine(new Date(second + 8 * HOUR)), []);

  // Nothing left that is "not due yet" (every period of this one is long overdue and unbought): the drift is real and the
  // alert reads exactly as it always did.
  const other = await weeklyPortfolio(confirmedAt);
  await other.snapshot(8755, 20, 1000);
  const real = (await detectPortfolioStuck((sql, params) => query(sql, params === undefined ? [] : [...params]), 6, new Date(other.firstSlot.getTime() + 8 * 7 * DAY))).filter(f => f.portfolioId === other.id);
  assert.equal(real.length, 1);
  assert.match(String(real[0]!.detail), /showed 8755 bps drift \(still above the threshold\)/);
});
