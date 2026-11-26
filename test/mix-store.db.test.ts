import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import type { PoolClient } from 'pg';
import { encodeFunctionData, zeroHash } from 'viem';
import { getPool, closePool } from '../src/db.js';
import { REGISTRY_ABI } from '../src/registry-abi.js';
import { mixChainAllocation } from '../src/mix-domain.js';
import { validateAssetConfig } from '../src/strategy-execution.js';
import { confirmMixSegment, MIX_COLUMNS, currentMixHistory, pendingMixIntent, excludeMixExitBudgets, quiesceMix } from '../src/mix-store.js';
import type { MixRow, MixIntent } from '../src/mix-store.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
const owner = '0x1111111111111111111111111111111111110178', account = '0x2222222222222222222222222222222222220178';
const firstHash = `0x${'a1'.repeat(32)}` as const, nextHash = `0x${'b2'.repeat(32)}` as const;
const WAD = 10n ** 18n, old = T.assets.NVDAB.token, next = T.assets.TSLAB.token;
after(closePool);
async function fixture(cash: bigint, work: (db: PoolClient, m: MixRow, intent: MixIntent, oldId: number) => Promise<void>) {
  const db = await getPool().connect();
  try {
    await db.query('begin');
    const ids: string[] = [];
    for (const assets of [mixChainAllocation([{ assetId: old, weightBps: 10000 }], [], 128),
      mixChainAllocation([{ assetId: next, weightBps: 10000 }], [{ assetId: old, balanceRaw: 100n * WAD }], 128)]) {
      const sid = (await db.query<{ id: string }>(`insert into strategies(provider,name,is_public,is_personal_mix) values($1,'mix store test',false,true) returning id`, [owner])).rows[0]?.id;
      assert.ok(sid); ids.push(sid);
      const allocation = { assets: assets.assets }, execution = validateAssetConfig(undefined, allocation, 97);
      await db.query(`insert into strategy_versions(strategy_id,version,allocation,schedule,active_at,execution_schema_version,execution,execution_chain_id,config_hash)
        values($1,1,$2,'{"kind":"funding"}','2026-01-01Z',2,$3,97,$4)`, [sid, JSON.stringify(allocation), JSON.stringify(execution), zeroHash]);
    }
    const mid = (await db.query<{ id: string }>(`insert into mixes(owner,name,chain_id,account,initial_strategy_id,account_salt)
      values($1,'test',97,$2,$3,$4) returning id`, [owner, account, ids[0], zeroHash])).rows[0]?.id; assert.ok(mid);
    for (const [index, sid] of ids.entries()) await db.query(`insert into mix_strategy_settings(strategy_id,mix_id,user_allocation,exit_assets) values($1,$2,$3,$4)`,
      [sid, mid, JSON.stringify({ [index === 0 ? old : next]: 10000 }), JSON.stringify(index === 0 ? [] : [old])]);
    const pid = (await db.query<{ id: string }>(`insert into portfolios(user_id,strategy_id,version,schedule_state) values($1,$2,1,'active') returning id`, [owner, ids[0]])).rows[0]?.id; assert.ok(pid);
    await db.query(`insert into smart_accounts(portfolio_id,chain_id,address,owner,account_type) values($1,97,$2,$3,'KERNEL')`, [pid, account, owner]);
    await db.query('insert into strategy_cash_balances(chain_id,portfolio_id,account,unallocated_hold_raw) values(97,$1,$2,$3)', [pid, account, cash.toString()]);
    const hid = (await db.query<{ id: string }>(`insert into mix_portfolio_history(mix_id,chain_id,portfolio_id,strategy_id,version,started_at,
      enroll_tx_hash,enroll_log_index,enroll_block_number,enroll_block_hash) values($1,97,$2,$3,1,'2026-01-01Z',$4,0,1,$4) returning id`, [mid, pid, ids[0], firstHash])).rows[0]?.id; assert.ok(hid);
    await db.query(`insert into session_keys(portfolio_id,key_ref,permissions,expires_at) values($1,$2,'{}','2030-01-01Z')`, [pid, 'mix178-test-' + pid]);
    const calls = [{ to: T.contracts.registry, value: '0', data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'enroll', args: [account, 2n, 1] }) }];
    await db.query(`insert into mix_switch_intents(request_key,mix_id,from_history_id,strategy_id,owner_calls,enroll_from_block,nonce) values($1,$2,$3,$4,$5,1,0)`,
      ['mix178-test-' + pid, mid, hid, ids[1], JSON.stringify(calls)]);
    const m = (await db.query<MixRow>(`select ${MIX_COLUMNS} from mixes m where m.id=$1`, [mid])).rows[0]; assert.ok(m);
    const intent = await pendingMixIntent(mid, { query: (sql, params) => db.query(sql, params ? [...params] : []) }); assert.ok(intent);
    await work(db, m, intent, Number(pid));
  } finally { await db.query('rollback'); db.release(); }
}
for (const cash of [0n, 1n, 9999n, 10000n, 10n * WAD - 1n, 10n * WAD, 10n * WAD + 1n, 1000n * WAD]) test(`mix handover commits exact current cash ${cash}, retains account/key, and never adds principal`, async () => {
  await fixture(cash, async (db, m, intent, oldId) => {
    const transaction: typeof import('../src/db.js').withTransaction = fn => fn(db);
    const newId = await confirmMixSegment(m, intent, { txHash: nextHash, logIndex: 0, blockNumber: 2n, blockHash: nextHash,
      at: new Date('2026-01-02Z'), userOpHash: nextHash, cashRaw: cash.toString(), nonce: 0n }, { transaction });
    assert.notEqual(newId, oldId);
    await db.query('set constraints all immediate');
    const current = await currentMixHistory(m.id, { query: (sql, params) => db.query(sql, params ? [...params] : []) });
    assert.equal(Number(current?.portfolio_id), newId);
    const mappings = (await db.query<{ portfolio_id: string; retired_at: Date | null; address: string }>('select * from smart_accounts where portfolio_id=any($1::bigint[]) order by portfolio_id', [[oldId, newId]])).rows;
    assert.equal(mappings.length, 2); assert.ok(mappings[0]?.retired_at); assert.equal(mappings[1]?.retired_at, null);
    assert.deepEqual(mappings.map(a => a.address), [account, account]);
    assert.equal((await db.query<{ portfolio_id: string }>('select portfolio_id from session_keys where key_ref=$1', ['mix178-test-' + oldId])).rows[0]?.portfolio_id, String(newId));
    const balances = (await db.query<{ portfolio_id: string; total: string }>('select portfolio_id,(unallocated_hold_raw+allocated_cash_raw)::text as total from strategy_cash_balances where portfolio_id=any($1::bigint[]) order by portfolio_id', [[oldId, newId]])).rows;
    assert.deepEqual(balances.map(b => b.total), ['0', cash.toString()]);
    assert.equal((await db.query<{ count: string }>('select count(*)::text from strategy_funding_lots where mix_history_id=$1', [current?.id])).rows[0]?.count, cash < 10n * WAD ? '0' : '1');
    const residual = (await db.query<{ residual_cash_raw: string }>('select residual_cash_raw::text from mix_portfolio_history where id=$1', [current?.id])).rows[0];
    assert.equal(residual?.residual_cash_raw, cash > 0n && cash < 10n * WAD ? cash.toString() : '0');
    if (cash >= 10n * WAD) assert.equal((await db.query<{ count: string }>('select count(*)::text from strategy_lot_assets a join strategy_funding_lots l on l.id=a.lot_id where l.mix_history_id=$1 and a.asset=$2', [current?.id, old])).rows[0]?.count, '0');
    assert.equal((await db.query<{ count: string }>('select count(*)::text from mix_cash_flows where mix_id=$1', [m.id])).rows[0]?.count, '0');
    const replay = await confirmMixSegment(m, intent, { txHash: nextHash, logIndex: 0, blockNumber: 2n, blockHash: nextHash,
      at: new Date('2026-01-02Z'), userOpHash: nextHash, cashRaw: cash.toString(), nonce: 0n }, { transaction });
    assert.equal(replay, newId);
  });
});
test('pending mix intent rejects new rebalance work; source lots cannot land on a retired mapping', async () => {
  await fixture(0n, async (db, m, intent, oldId) => {
    await db.query('savepoint blocked');
    await assert.rejects(db.query(`insert into operations(portfolio_id,type,state,idempotency_key,payload_hash) values($1,'rebalance','pending',$2,$3)`, [oldId, 'mix178-op-' + oldId, zeroHash]), /MIX_SWITCH_PENDING/);
    await db.query('rollback to savepoint blocked');
    await confirmMixSegment(m, intent, { txHash: nextHash, logIndex: 0, blockNumber: 2n, blockHash: nextHash,
      at: new Date('2026-01-02Z'), userOpHash: nextHash, cashRaw: '0', nonce: 0n }, { transaction: fn => fn(db) });
    await db.query('savepoint retired');
    await assert.rejects(db.query(`insert into strategy_funding_lots(chain_id,portfolio_id,strategy_id,version,kind,tx_hash,log_index,block_number,block_hash,amount_raw,minimum_contribution_raw)
      values(97,$1,$2,1,'asset',$3,1,3,$3,100,1)`, [oldId, m.initial_strategy_id, nextHash]), /MIX_RETIRED/);
    await db.query('rollback to savepoint retired');
  });
});
