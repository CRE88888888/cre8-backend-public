import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test, after } from 'node:test';
import { encodeFunctionData, zeroHash, toHex } from 'viem';
import type { Hex } from 'viem';
import { getPool, withConnection, query, MIGRATIONS_DIR, closePool } from '../src/db.js';
import { mixChainAllocation } from '../src/mix-domain.js';
import { validateAssetConfig } from '../src/strategy-execution.js';
import { REGISTRY_ABI } from '../src/registry-abi.js';
import { withMixLock, confirmMixSegment, MIX_COLUMNS, pendingMixIntent, currentMixHistory } from '../src/mix-store.js';
import type { MixRow } from '../src/mix-store.js';
import { createPortfolioStrategyService } from '../src/portfolio-strategies.js';
import { recordRenewalResult } from '../src/renewal.js';
import { requireOwnedPortfolio } from '../src/portfolios.js';
import { getStrategy } from '../src/strategies.js';
import { runSchedulerOnce } from '../src/scheduler.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
import { mixClock, WAD } from './fixtures/mix.js';
after(closePool);
const owner = T.roles.keeper, account = T.roles.operator;
const firstHash = `0x${'18'.repeat(32)}` as const, nextHash = `0x${'28'.repeat(32)}` as const;
function barrier() {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function prepareSwitchIntent() {
  const target = (await query<{ strategy_id: string }>(`select strategy_id from mix_strategy_settings where mix_id=1 and strategy_id<>
    (select strategy_id from mix_portfolio_history where mix_id=1 and ended_at is null)`)).rows[0]; assert.ok(target);
  await query(`insert into mix_switch_intents(request_key,mix_id,from_history_id,strategy_id,owner_calls,enroll_from_block,nonce)
    values('concurrency-178',1,1,$1,$2,1,0)`, [target.strategy_id, JSON.stringify([{ to: T.contracts.registry, value: '0',
      data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'enroll', args: [account, BigInt(target.strategy_id), 1] }) }])]);
}
async function sandbox(work: (lane: <R>(fn: () => Promise<R>) => Promise<R>) => Promise<void>, pending = true) {
  assert.ok(['cre8_x1_178', 'cre8_x1_180', 'cre8_x1_182'].includes((await getPool().query<{ name: string }>('select current_database() as name')).rows[0]?.name ?? ''));
  const schema = 'mix178_' + randomBytes(8).toString('hex');
  await getPool().query(`create schema ${schema}`);
  const lane = <R>(fn: () => Promise<R>): Promise<R> => withConnection(async (client, discard) => {
    try { await client.query(`set search_path to ${schema},public`); return await fn(); }
    finally { discard(); }
  }, { reuse: false });
  try {
    await lane(async () => {
      for (const file of (await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith('.sql')).sort()) await query(await readFile(path.join(MIGRATIONS_DIR, file), 'utf8'));
      const ids: string[] = [];
      for (const assetId of [T.assets.NVDAB.token, T.assets.TSLAB.token]) {
        const allocation = { assets: mixChainAllocation([{ assetId, weightBps: 10000 }], [], 128).assets };
        const s = (await query<{ id: string }>("insert into strategies(provider,name,is_public,is_personal_mix) values($1,'concurrency',false,true) returning id", [owner])).rows[0]; assert.ok(s); ids.push(s.id);
        await query('update strategies set onchain_id=id where id=$1', [s.id]);
        await query(`insert into strategy_versions(strategy_id,version,allocation,schedule,active_at,execution_schema_version,execution,execution_chain_id,config_hash)
          values($1,1,$2,'{"kind":"funding"}','2026-01-01Z',2,$3,97,$4)`, [s.id, JSON.stringify(allocation), JSON.stringify(validateAssetConfig(undefined, allocation, 97)), zeroHash]);
      }
      await query("insert into mixes(owner,name,chain_id,account,initial_strategy_id,account_salt) values($1,'concurrency',97,$2,$3,$4)", [owner, account, ids[0], zeroHash]);
      for (const [i, id] of ids.entries()) await query("insert into mix_strategy_settings(strategy_id,mix_id,user_allocation,exit_assets) values($1,1,$2,'[]')", [id, JSON.stringify({ [i === 0 ? T.assets.NVDAB.token : T.assets.TSLAB.token]: 10000 })]);
      await query("insert into portfolios(user_id,strategy_id,version,schedule_state) values($1,$2,1,'active')", [owner, ids[0]]);
      await query("insert into smart_accounts(portfolio_id,chain_id,address,owner,account_type) values(1,97,$1,$2,'KERNEL')", [account, owner]);
      await query('insert into strategy_cash_balances(chain_id,portfolio_id,account) values(97,1,$1)', [account]);
      await query(`insert into mix_portfolio_history(mix_id,chain_id,portfolio_id,strategy_id,version,started_at,enroll_tx_hash,enroll_log_index,enroll_block_number,enroll_block_hash)
        values(1,97,1,$1,1,'2026-01-01Z',$2,0,1,$2)`, [ids[0], firstHash]);
      await query("insert into session_keys(portfolio_id,key_ref,permissions,expires_at) values(1,'concurrency-178','{}','2030-01-01Z')");
      if (pending) await prepareSwitchIntent();
    });
    await work(lane);
  } finally { await getPool().query(`drop schema ${schema} cascade`); }
}
function funding(evidence: () => Promise<void>, source: { txHash: Hex; blockNumber: bigint; logIndex: number; at: Date } = { txHash: firstHash, blockNumber: 1n, logIndex: 1, at: new Date('2026-01-01Z') }) {
  return createPortfolioStrategyService({ chainId: () => 97, owned: (id, wallet) => requireOwnedPortfolio(id, wallet, { chainId: 97 }),
    walletEvidence: async () => { await evidence(); return { txHash: source.txHash, logIndex: source.logIndex, blockNumber: source.blockNumber, blockHash: source.txHash,
      amountRaw: (1000n * WAD).toString(), confirmedAt: source.at }; }, feeReserve: async () => 0n,
    version: async id => { const v = (await getStrategy(id)).versions[0]; assert.ok(v); return v; },
    exposure: async (_sid, _chain, assets) => assets.map(address => ({ address, buyPaused: false,
      exposureCapUsdtWei: null, currentExposureUsdtWei: null })) });
}
async function complete(cashRaw: string) {
  const m = (await query<MixRow>(`select ${MIX_COLUMNS} from mixes m where m.id=1`)).rows[0]; assert.ok(m);
  const intent = await pendingMixIntent('1'); assert.ok(intent);
  return confirmMixSegment(m, intent, { txHash: nextHash, userOpHash: nextHash, logIndex: 0, blockNumber: 2n, blockHash: nextHash,
    at: new Date('2026-01-02Z'), cashRaw, nonce: 0n });
}
test('real backend exclusion: switch first blocks concurrent funding and scheduler RPC, then retires the old portfolio', async () => {
  await sandbox(async lane => {
    const entered = barrier(), remote = barrier(); let evidenceReads = 0, plans = 0;
    const switching = lane(() => withMixLock('1', async () => { entered.release(); await remote.promise; return complete('0'); }));
    await entered.promise;
    try {
      await lane(async () => {
        await assert.rejects(funding(async () => { evidenceReads++; }).funding(1, owner, { source: { kind: 'wallet_transfer', txHash: firstHash } }), /being processed/);
        await assert.rejects(recordRenewalResult(1, owner, { keyRef: "m/44'/60'/0'/0/178", permissionId: '0x17800000', validUntil: 2000000000, policySnapshot: {} },
          { requireOwnedPortfolio: (id, wallet) => requireOwnedPortfolio(id, wallet, { chainId: 97 }) }), /正在處理/);
        const round = await runSchedulerOnce({ dryRun: false, now: mixClock, skipAlerts: true }, { chainId: 97, executor: T.contracts.executor,
          yieldRound: async () => ({ checked: 0, blocked: 0 }), readGlobalPaused: async () => false, log: () => {},
          planPortfolio: async () => { plans++; throw new Error('must not read RPC while switching'); } });
        assert.equal(round.results[0]?.outcome, 'blocked');
      });
    } finally { remote.release(); await switching; }
    const next = await switching; assert.notEqual(next, 1); assert.equal(evidenceReads, 0); assert.equal(plans, 0);
    await lane(async () => { await assert.rejects(requireOwnedPortfolio(1, owner, { chainId: 97 }), /no smart account/); assert.equal(Number((await currentMixHistory('1'))?.portfolio_id), next); });
  });
});
test('real backend exclusion: funding first prevents a switch during RPC; committed new cash is carried exactly once', async () => {
  await sandbox(async lane => {
    const entered = barrier(), remote = barrier();
    const credit = lane(() => funding(async () => { entered.release(); await remote.promise; }).funding(1, owner, { source: { kind: 'wallet_transfer', txHash: firstHash } }));
    await entered.promise;
    try { await lane(() => assert.rejects(withMixLock('1', () => complete('0')), /正在處理/)); }
    finally { remote.release(); await credit; }
    await credit;
    await lane(async () => {
      await prepareSwitchIntent();
      const next = await withMixLock('1', () => complete((1000n * WAD).toString()));
      assert.notEqual(next, 1);
      const lots = (await query<{ amount_raw: string }>("select amount_raw::text from strategy_funding_lots where portfolio_id=$1 and source_kind='mix_handover'", [next])).rows;
      assert.deepEqual(lots.map(l => l.amount_raw), [(1000n * WAD).toString()]);
      assert.equal((await query('select * from mix_cash_flows')).rows.length, 0, 'handover is not another external deposit');
    });
  }, false);
});

test('pending intent blocks funding admission before confirm; enroll-block transfers cannot be credited twice afterwards', async () => {
  await sandbox(async lane => {
    await lane(async () => {
      await assert.rejects(funding(async () => {}).funding(1, owner, { source: { kind: 'wallet_transfer', txHash: firstHash } }), { code: 'MIX_SWITCH_PENDING' });
      assert.equal((await query('select * from strategy_funding_lots')).rows.length, 0);
      const next = await withMixLock('1', () => complete((1000n * WAD).toString()));
      await assert.rejects(funding(async () => {}).funding(next, owner, { source: { kind: 'wallet_transfer', txHash: firstHash } }), { code: 'MIX_FUNDING_ALREADY_CARRIED' });
      await assert.rejects(funding(async () => {}, { txHash: firstHash, blockNumber: 2n, logIndex: 9, at: new Date('2026-01-02Z') })
        .funding(next, owner, { source: { kind: 'wallet_transfer', txHash: firstHash } }), { code: 'MIX_FUNDING_ALREADY_CARRIED' }, 'later log in the enrollment block is already in end-of-block carry');
      assert.equal((await query('select * from strategy_funding_lots')).rows.length, 1, 'the internal carry remains the only source');
      const hash = toHex(179n, { size: 32 });
      await funding(async () => {}, { txHash: hash, blockNumber: 3n, logIndex: 1, at: new Date('2026-01-03Z') })
        .funding(next, owner, { source: { kind: 'wallet_transfer', txHash: hash } });
      assert.equal((await query('select * from strategy_funding_lots')).rows.length, 2, 'new external money after the cutoff is admitted');
    });
  });
});

test('DB direct funding rejects pending and whole-block carried sources; only the next block can create a new external lot', async () => {
  await sandbox(async lane => lane(async () => {
    const insert = async (portfolioId: number, block: number, index: number) => {
      const h = await currentMixHistory('1'); assert.ok(h);
      return query(`insert into strategy_funding_lots(chain_id,portfolio_id,strategy_id,version,kind,tx_hash,log_index,block_number,
        block_hash,amount_raw,minimum_contribution_raw,effective_slices)
        values(97,$1,$2,1,'asset',$3,$4,$5,$3,$6,$7,$8)`, [portfolioId, h.strategy_id, toHex(BigInt(300 + index), { size: 32 }), index,
          block, (1000n * WAD).toString(), (50n * WAD).toString(), JSON.stringify({ [portfolioId === 1 ? T.assets.NVDAB.token : T.assets.TSLAB.token]: 1 })]);
    };
    await assert.rejects(insert(1, 1, 1), /MIX_SWITCH_PENDING/);
    const next = await withMixLock('1', () => complete((1000n * WAD).toString()));
    for (const [block, index] of [[1, 2], [2, 0], [2, 99]] as const) {
      await assert.rejects(insert(next, block, index), /MIX_FUNDING_ALREADY_CARRIED/);
    }
    assert.equal((await query('select * from strategy_funding_lots')).rows.length, 1);
    await insert(next, 3, 3);
    assert.equal((await query('select * from strategy_funding_lots')).rows.length, 2);
    const cash = (await query<{ actual: string }>('select (allocated_cash_raw+unallocated_hold_raw+stack_prefund_raw)::text as actual from strategy_cash_balances where portfolio_id=$1', [next])).rows[0];
    assert.equal(cash?.actual, (1000n * WAD).toString(), 'rejected writes leave the original carry unchanged');
  }));
});
