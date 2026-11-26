import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Address, Hex } from 'viem';
import { closePool, getPool, migrate } from '../src/db.js';
import { REWARDS, REWARD_MESSAGE, rewardsStore } from '../src/strategy-rewards.js';

after(closePool);
const account = '0x00000000000000000000000000000000000000f5' as Address, owner = '0x00000000000000000000000000000000000000f6' as Address, box = '0x00000000000000000000000000000000000000f7' as Address;

test('db 0068 real SQL: newest signature wins, pending upserts, ledger idempotent and append-only, view = claims − sweeps plus pending', async () => {
  await migrate();
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const strategy = (await client.query<{ id: string }>(`insert into strategies(provider,name) values($1,'rewards db test') returning id`, [owner])).rows[0]!.id;
    await client.query(`insert into strategy_versions(strategy_id,version,allocation,schedule) values($1,1,'{}','{}')`, [strategy]);
    const portfolio = Number((await client.query<{ id: string }>(`insert into portfolios(user_id,strategy_id,version) values($1,$2,1) returning id`, [owner, strategy])).rows[0]!.id);
    await client.query(`insert into smart_accounts(portfolio_id,chain_id,address,owner,account_type) values($1,56,$2,$3,'KERNEL')`, [portfolio, account, owner]);
    const store = rewardsStore((sql, params) => client.query(sql, params)), now = new Date('2026-11-24T12:00:00.000Z'), lista = REWARDS.LISTA as Address;
    const sig = (at: Date) => ({ message: REWARD_MESSAGE(at.toISOString()), signature: ('0x' + 'ab'.repeat(65)) as Hex, signedAt: at });

    assert.deepEqual(await store.view(56, portfolio, now), { tokens: [], signature: { needed: true, signedAt: null } });
    await store.saveSignature(56, portfolio, account, sig(now));
    await store.saveSignature(56, portfolio, account, sig(new Date(now.getTime() - 86_400_000))); // an older one never replaces a newer one
    const signed = (await store.signed(56, now)).filter(s => s.account === account);
    assert.deepEqual(signed.map(s => [s.portfolioId, s.owner, s.sig.signedAt.toISOString(), s.sig.message]), [[portfolio, owner, now.toISOString(), REWARD_MESSAGE(now.toISOString())]]);
    assert.equal((await store.signed(56, new Date(now.getTime() + 7 * 86_400_000))).some(s => s.account === account), false); // expired for Lista
    assert.equal((await store.view(56, portfolio, new Date(now.getTime() + 5 * 86_400_000))).signature.needed, false);
    assert.equal((await store.view(56, portfolio, new Date(now.getTime() + 6 * 86_400_000))).signature.needed, true); // asked a day early

    await store.savePending(56, portfolio, account, { holder: account, source: 'lista', token: lista, symbol: 'LISTA', totalRaw: 500n }, 100n);
    await store.savePending(56, portfolio, account, { holder: box, source: 'lista', token: lista, symbol: 'LISTA', totalRaw: 30n }, 0n);
    await store.savePending(56, portfolio, account, { holder: account, source: 'lista', token: lista, symbol: 'LISTA', totalRaw: 600n }, 100n); // next root
    const ev = (kind: 'claim' | 'sweep', amountRaw: bigint, logIndex: number, hash: string) => ({ portfolioId: portfolio, account, holder: account, kind, source: kind === 'claim' ? 'lista' as const : null,
      token: lista, symbol: 'LISTA', amountRaw, recipient: kind === 'sweep' ? owner : null, txHash: ('0x' + hash.repeat(32)) as Hex, logIndex, blockNumber: 5n });
    await store.record(56, [ev('claim', 100n, 0, 'f1'), ev('claim', 100n, 0, 'f1'), ev('sweep', 40n, 1, 'f2')]); // the repeat is skipped
    assert.deepEqual((await store.view(56, portfolio, now)).tokens, [{ token: lista, symbol: 'LISTA', balanceRaw: '60', pendingRaw: '530' }]);
    for (const [sql, pattern] of [[`update strategy_reward_events set amount_raw = 1 where portfolio_id=$1`, /append-only/], [`delete from strategy_reward_events where portfolio_id=$1`, /append-only/]] as const) {
      await client.query('savepoint s'); await assert.rejects(client.query(sql, [portfolio]), pattern); await client.query('rollback to savepoint s');
    }
    // A claim needs a source, a sweep a recipient; the account must be this portfolio's.
    for (const bad of [{ ...ev('claim', 1n, 9, 'f3'), source: null }, { ...ev('sweep', 1n, 9, 'f4'), recipient: null }, { ...ev('claim', 1n, 9, 'f5'), portfolioId: portfolio + 1_000_000 }]) {
      await client.query('savepoint s'); await assert.rejects(store.record(56, [bad])); await client.query('rollback to savepoint s');
    }
  } finally {
    await client.query('rollback');
    client.release();
  }
});
