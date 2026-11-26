import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { encodeAbiParameters, encodeEventTopics } from 'viem';
import type { Address, Hex } from 'viem';
import { getPool, closePool, migrate } from '../src/db.js';
import { CASH_EARN_ABI, cashVaults, createCashEarn } from '../src/cash-earn.js';
import type { CashEarnChain } from '../src/cash-earn.js';

after(closePool);
const WAD = 10n ** 18n, owner = '0x00000000000000000000000000000000000000c3' as Address;
const vaults = cashVaults();
const venus = vaults.find(v => v.id === 'venus_usdt'), lista = vaults.find(v => v.id === 'lista_usdt');
const log = (token: Address, from: Address, to: Address, value: bigint, logIndex: number) => ({ address: token, logIndex,
  topics: encodeEventTopics({ abi: CASH_EARN_ABI, eventName: 'Transfer', args: { from, to } }) as Hex[], data: encodeAbiParameters([{ type: 'uint256' }], [value]) });

test('#193 real SQL: idempotent confirmations per (tx, log) and lifetime earnings per vault from the separate ledger', async () => {
  assert.ok(venus && lista);
  await migrate();
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const blockHash = `0x${'cd'.repeat(32)}` as Hex;
    const receipts: Record<string, Awaited<ReturnType<CashEarnChain['receipt']>>> = {
      [`0x${'01'.repeat(32)}`]: { status: 'success', from: owner, blockNumber: 5n, blockHash, logs: [log(venus.asset, owner, venus.custody, 100n * WAD, 0), log(venus.asset, owner, lista.custody, 50n * WAD, 1)] },
      [`0x${'02'.repeat(32)}`]: { status: 'success', from: owner, blockNumber: 6n, blockHash, logs: [log(venus.asset, venus.custody, owner, 30n * WAD, 4)] },
    };
    const chain: CashEarnChain = {
      head: async () => ({ number: 10n, timestamp: 1_795_400_000n }),
      vault: async () => ({ aprBps: 500, incentiveAprBps: 100, totalRaw: 1000n * WAD, liquidityRaw: 1000n * WAD, supplyPaused: false, redeemPaused: false, capRemainingRaw: null }),
      position: async (v) => v.id === 'venus_usdt' ? { sharesRaw: 1n, valueRaw: 72n * WAD, maxWithdrawRaw: 72n * WAD }
        : v.id === 'lista_usdt' ? { sharesRaw: 1n, valueRaw: 49n * WAD, maxWithdrawRaw: 49n * WAD } : { sharesRaw: 0n, valueRaw: 0n, maxWithdrawRaw: 0n },
      sharesFor: async () => 1n, balance: async () => 7n * WAD, allowance: async () => 0n,
      receipt: async (hash) => receipts[hash] ?? null, blockHash: async () => blockHash,
    };
    const earn = createCashEarn({ chainId: 97, chain: () => chain, now: () => new Date('2026-11-23T12:00:00Z'),
      query: ((sql: string, params?: unknown[]) => client.query(sql, params)) as never });
    for (const hash of Object.keys(receipts)) { await earn.confirm(owner, { txHash: hash }); await earn.confirm(owner, { txHash: hash }); }
    const rows = (await client.query<{ n: string }>('select count(*)::text as n from cash_earn_flows where owner=$1', [owner])).rows[0];
    assert.equal(rows?.n, '3');
    const account = await earn.account(owner);
    const byVault = Object.fromEntries(account.cashEarn.positions.map(p => [p.vaultId, p]));
    assert.equal(byVault.venus_usdt?.earnedTotalRaw, String(2n * WAD)); // 72 + 30 - 100
    assert.equal(byVault.lista_usdt?.earnedTotalRaw, null); // 49 < 50 deposited: ledger can't explain it, report unknown, never negative
    assert.equal(account.cashEarn.earnedTotalRaw, null);
    assert.equal(account.cashEarn.earningRaw, String(121n * WAD));
    assert.equal(account.wallet.availableRaw, String(7n * WAD));
    assert.equal(byVault.venus_usdt?.apyBps, 513 + 100);
    // Other chains/owners are invisible.
    assert.deepEqual((await createCashEarn({ chainId: 97, chain: () => chain, query: ((sql: string, params?: unknown[]) => client.query(sql, params)) as never })
      .account('0x00000000000000000000000000000000000000c4')).cashEarn.positions.length, 2);
  } finally { await client.query('rollback'); client.release(); }
});
