import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, getAddress } from 'viem';
import type { Address, Hex } from 'viem';
import {
  apyBpsFromApr, CASH_EARN_ABI, cashVaults, createCashEarn, depositCalls, earnedTodayEstimate, earnings, flowsFromLogs, markBest,
  utilizationBps, vaultView, venusRate, withdrawCall,
} from '../src/cash-earn.js';
import type { CashEarnChain, PositionReading, VaultReading } from '../src/cash-earn.js';
import { createServer } from '../src/server.js';
import { loadRateLimitConfig } from '../src/config.js';
import { MemoryRateLimitStore, RequestRateLimiter } from '../src/ratelimit.js';
import { UnauthorizedError } from '../src/errors.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';

const WAD = 10n ** 18n;
const vaults = cashVaults();
const vault = (id: string) => { const v = vaults.find(x => x.id === id); assert.ok(v, id); return v; };
const owner = '0x00000000000000000000000000000000000000a1' as Address;
const reading = (patch: Partial<VaultReading> = {}): VaultReading => ({ aprBps: 450, incentiveAprBps: null, totalRaw: 1_000_000n * WAD,
  liquidityRaw: 600_000n * WAD, supplyPaused: false, redeemPaused: false, capRemainingRaw: null, ...patch });

test('#193 whitelist is exactly the three chain-97 USDT markets with the right custody/spender per protocol', () => {
  assert.deepEqual(vaults.map(v => v.id), ['venus_usdt', 'lista_usdt', 'aave_v3_usdt']);
  for (const v of vaults) assert.equal(v.asset, T.contracts.usdt.toLowerCase());
  const venus = vault('venus_usdt'), aave = vault('aave_v3_usdt'), lista = vault('lista_usdt');
  assert.equal(venus.custody, venus.spender); assert.equal(lista.custody, lista.spender);
  assert.equal(aave.custody, aave.receipt); assert.notEqual(aave.spender, aave.receipt);
  assert.deepEqual(cashVaults(null), []);
});

test('#193 APY, utilization (rounded up) and Venus accrual math', () => {
  assert.equal(apyBpsFromApr(0), 0); assert.equal(apyBpsFromApr(500), 513); assert.equal(apyBpsFromApr(450), 460); assert.equal(apyBpsFromApr(10_000), 17183);
  for (const bad of [-1, 10_001, 1.5]) assert.throws(() => apyBpsFromApr(bad));
  assert.equal(utilizationBps(0n, 0n), 0); assert.equal(utilizationBps(100n, 100n), 0); assert.equal(utilizationBps(100n, 200n), 0);
  assert.equal(utilizationBps(10_000n, 1_000n), 9000); assert.equal(utilizationBps(10_000n, 999n), 9001); assert.equal(utilizationBps(3n, 2n), 3334);
  assert.throws(() => utilizationBps(-1n, 0n));
  assert.equal(venusRate(WAD, 500, 365n * 86_400n), WAD * 105n / 100n);
  assert.equal(venusRate(WAD, 500, 0n), WAD); assert.equal(venusRate(WAD, 500, -5n), WAD);
});

test('#193 vault status: 90%/95% utilization edges, pauses, cap, missing data, best rate and incentive breakdown', () => {
  const v = vault('venus_usdt'), at = new Date('2026-11-23T00:00:00Z');
  const at9000 = vaultView(v, reading({ totalRaw: 10_000n, liquidityRaw: 1_000n }), at);
  assert.equal(at9000.status, 'open'); assert.equal(at9000.depositOpen, true);
  const over90 = vaultView(v, reading({ totalRaw: 10_000n, liquidityRaw: 999n }));
  assert.deepEqual([over90.status, over90.reason, over90.depositOpen, over90.message], ['deposits_paused', 'high_utilization', false, 'Temporarily unavailable.']);
  assert.equal(vaultView(v, reading({ totalRaw: 10_000n, liquidityRaw: 500n })).status, 'deposits_paused');
  const over95 = vaultView(v, reading({ totalRaw: 10_000n, liquidityRaw: 499n }));
  assert.deepEqual([over95.status, over95.depositOpen], ['withdraw_recommended', false]); assert.match(over95.message ?? '', /recommend withdrawing/);
  assert.equal(vaultView(v, reading({ supplyPaused: true })).reason, 'deposits_paused');
  assert.deepEqual([vaultView(v, reading({ redeemPaused: true })).status, vaultView(v, reading({ redeemPaused: true })).reason], ['unavailable', 'withdrawals_paused']);
  assert.equal(vaultView(v, reading({ capRemainingRaw: WAD - 1n })).reason, 'cap_reached');
  assert.equal(vaultView(v, reading({ capRemainingRaw: WAD })).status, 'open');
  const missing = vaultView(v, null);
  assert.deepEqual([missing.status, missing.apyBps, missing.depositOpen, missing.breakdown], ['unavailable', null, false, []]);
  // Incentive APR is added on top of the compounded base APY and itemized with its source and time.
  const boosted = vaultView(v, reading({ aprBps: 300, incentiveAprBps: 150 }), at);
  assert.deepEqual([boosted.baseApyBps, boosted.incentiveAprBps, boosted.apyBps], [305, 150, 455]);
  assert.deepEqual(boosted.breakdown.map(p => [p.kind, p.bps, p.updatedAt]), [['base', 305, at.toISOString()], ['incentive', 150, at.toISOString()]]);
  assert.equal(at9000.breakdown.length, 1);
  const best = markBest([vaultView(vault('venus_usdt'), reading({ aprBps: 500 })), vaultView(vault('lista_usdt'), reading({ aprBps: 300, incentiveAprBps: 300 })),
    vaultView(vault('aave_v3_usdt'), reading({ aprBps: 900, supplyPaused: true }))]);
  assert.deepEqual(best.map(b => b.bestRate), [false, true, false]); // closed vaults never get the badge
  assert.deepEqual(markBest([vaultView(v, null)]).map(b => b.bestRate), [false]);
});

test('#193 calldata: approve only when needed, then the protocol deposit; withdraw by shares/assets/max', () => {
  for (const v of vaults) {
    const withApprove = depositCalls(v, owner, 5n * WAD, 0n);
    assert.equal(withApprove.length, 2); assert.equal(withApprove[0]?.to, v.asset);
    const approve = decodeFunctionData({ abi: CASH_EARN_ABI, data: withApprove[0]?.data ?? '0x' });
    assert.deepEqual([approve.functionName, approve.args], ['approve', [getAddress(v.spender), 5n * WAD]]);
    const enough = depositCalls(v, owner, 5n * WAD, 5n * WAD);
    assert.equal(enough.length, 1); assert.equal(enough[0]?.to, v.spender); assert.equal(enough[0]?.value, '0');
    assert.equal(withApprove[0]?.gas, '100000'); assert.equal(enough[0]?.gas, '400000');
    assert.equal(withdrawCall(v, owner, { all: true, sharesRaw: 1n }).gas, '400000');
    const deposit = decodeFunctionData({ abi: CASH_EARN_ABI, data: enough[0]?.data ?? '0x' });
    assert.deepEqual([deposit.functionName, deposit.args], v.protocol === 'venus' ? ['mint', [5n * WAD]]
      : v.protocol === 'lista' ? ['deposit', [5n * WAD, getAddress(owner)]] : ['supply', [getAddress(v.asset), 5n * WAD, getAddress(owner), 0]]);
  }
  const decode = (c: { data: Hex }) => { const d = decodeFunctionData({ abi: CASH_EARN_ABI, data: c.data }); return [d.functionName, d.args]; };
  assert.deepEqual(decode(withdrawCall(vault('venus_usdt'), owner, { all: true, sharesRaw: 77n })), ['redeem', [77n]]);
  assert.deepEqual(decode(withdrawCall(vault('venus_usdt'), owner, { all: false, assetsRaw: 5n, sharesRaw: 3n })), ['redeem', [3n]]);
  assert.throws(() => withdrawCall(vault('venus_usdt'), owner, { all: false, assetsRaw: 5n }));
  assert.deepEqual(decode(withdrawCall(vault('lista_usdt'), owner, { all: true, sharesRaw: 9n })), ['redeem', [9n, getAddress(owner), getAddress(owner)]]);
  assert.deepEqual(decode(withdrawCall(vault('lista_usdt'), owner, { all: false, assetsRaw: 4n })), ['withdraw', [4n, getAddress(owner), getAddress(owner)]]);
  const aave = vault('aave_v3_usdt');
  assert.deepEqual(decode(withdrawCall(aave, owner, { all: true, sharesRaw: 1n })), ['withdraw', [getAddress(aave.asset), (1n << 256n) - 1n, getAddress(owner)]]);
  assert.deepEqual(decode(withdrawCall(aave, owner, { all: false, assetsRaw: 4n })), ['withdraw', [getAddress(aave.asset), 4n, getAddress(owner)]]);
});

test('#193 earnings from the separate ledger, including withdrawn interest; daily estimate bounds', () => {
  assert.equal(earnings(105n, 100n, 0n), 5n);
  assert.equal(earnings(0n, 100n, 106n), 6n); // all withdrawn, interest included
  assert.equal(earnings(100n, 100n, 0n), 0n);
  assert.equal(earnings(99n, 100n, 0n), null); // an unconfirmed deposit/transfer would make it negative: unknown, never < 0
  assert.equal(earnedTodayEstimate(0n, 500, 86_400n), 0n); assert.equal(earnedTodayEstimate(1000n * WAD, 0, 86_400n), 0n);
  assert.equal(earnedTodayEstimate(1000n * WAD, 500, 0n), 0n);
  const day = earnedTodayEstimate(1000n * WAD, 500, 86_400n);
  assert.ok(day > 136n * 10n ** 15n && day < 137n * 10n ** 15n, String(day)); // ~0.1369 USDT/day on 1,000 at 5%
});

const transferLog = (token: Address, from: Address, to: Address, value: bigint, logIndex: number) => ({ address: token, logIndex,
  topics: encodeEventTopics({ abi: CASH_EARN_ABI, eventName: 'Transfer', args: { from, to } }) as Hex[],
  data: encodeAbiParameters([{ type: 'uint256' }], [value]) });

test('#193 flows: only USDT between the owner and a whitelisted custody address count, both directions', () => {
  const venus = vault('venus_usdt'), aave = vault('aave_v3_usdt'), usdt = venus.asset;
  const other = '0x00000000000000000000000000000000000000b2' as Address;
  const logs = [transferLog(usdt, owner, venus.custody, 10n, 1), transferLog(usdt, aave.custody, owner, 7n, 2),
    transferLog(usdt, other, venus.custody, 99n, 3), transferLog(usdt, owner, other, 98n, 4),
    transferLog(venus.receipt, owner, venus.custody, 97n, 5), transferLog(usdt, owner, aave.spender, 96n, 6),
    transferLog(usdt, owner, venus.custody, 0n, 7), { ...transferLog(usdt, owner, venus.custody, 5n, 8), topics: ['0x' + '00'.repeat(32)] as Hex[] }];
  assert.deepEqual(flowsFromLogs(vaults, owner, logs), [{ vaultId: 'venus_usdt', kind: 'deposit', assetsRaw: 10n, logIndex: 1 },
    { vaultId: 'aave_v3_usdt', kind: 'withdraw', assetsRaw: 7n, logIndex: 2 }]);
  assert.deepEqual(flowsFromLogs(vaults, other, [transferLog(usdt, owner, venus.custody, 10n, 1)]), []);
});

type FakeState = { readings: (VaultReading | null)[]; positions: PositionReading[]; balance: bigint; allowance: bigint; headFails?: boolean; positionFails?: boolean; balanceFails?: boolean; receiptFails?: boolean };
function fakeChain(state: FakeState, receipts: Record<string, Awaited<ReturnType<CashEarnChain['receipt']>>> = {}, hashes: Record<string, Hex> = {}): CashEarnChain {
  return {
    head: async () => { if (state.headFails) throw new Error('rpc secret'); return { number: 100n, timestamp: 1_795_400_000n }; },
    vault: async (v) => { const r = state.readings[vaults.findIndex(x => x.id === v.id)]; if (!r) throw new Error('read failed'); return r; },
    position: async (v) => { if (state.positionFails) throw new Error('rpc secret'); const p = state.positions[vaults.findIndex(x => x.id === v.id)]; assert.ok(p); return p; },
    sharesFor: async (_v, assets) => assets / 2n,
    balance: async () => { if (state.balanceFails) throw new Error('rpc secret'); return state.balance; }, allowance: async () => state.allowance,
    receipt: async (hash) => { if (state.receiptFails) throw new Error('rpc secret'); return receipts[hash] ?? null; },
    blockHash: async (n) => hashes[String(n)] ?? `0x${'cd'.repeat(32)}`,
  };
}
const none: PositionReading = { sharesRaw: 0n, valueRaw: 0n, maxWithdrawRaw: 0n };
type Row = { chain_id: number; owner: string; vault_id: string; kind: string; assets_raw: string; tx_hash: string; log_index: number; created_at: Date };
function memoryLedger() {
  const rows: Row[] = [];
  const query = (async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith('insert')) {
      const [chain, own, vaultId, kind, assets, tx, log] = params as [number, string, string, string, string, string, number];
      if (!rows.some(r => r.chain_id === chain && r.tx_hash === tx && r.log_index === log)) rows.push({ chain_id: chain, owner: own, vault_id: vaultId, kind, assets_raw: assets, tx_hash: tx, log_index: log, created_at: new Date('2026-11-22T20:00:00Z') });
      return { rows: [] };
    }
    const [chain, own] = params as [number, string];
    const mine = rows.filter(r => r.chain_id === chain && r.owner === own);
    const ids = [...new Set(mine.map(r => r.vault_id))];
    return { rows: ids.map(id => { const v = mine.filter(r => r.vault_id === id); return { vault_id: id,
      deposited: String(v.filter(r => r.kind === 'deposit').reduce((s, r) => s + BigInt(r.assets_raw), 0n)),
      withdrawn: String(v.filter(r => r.kind === 'withdraw').reduce((s, r) => s + BigInt(r.assets_raw), 0n)),
      first_at: v.map(r => r.created_at).sort((a, b) => a.getTime() - b.getTime())[0] }; }) };
  }) as never;
  return { rows, query };
}
const now = () => new Date('2026-11-23T06:00:00Z');

test('#193 service: vault list, account keeps wallet cash and Cash Earn apart, limited withdraw message', async () => {
  const state: FakeState = { readings: [reading({ aprBps: 500 }), reading({ aprBps: 300 }), null], positions: [
    { sharesRaw: 50n, valueRaw: 1_010n * WAD, maxWithdrawRaw: 600n * WAD }, none, none], balance: 250n * WAD, allowance: 0n };
  const ledger = memoryLedger();
  ledger.rows.push({ chain_id: 97, owner, vault_id: 'venus_usdt', kind: 'deposit', assets_raw: String(1_000n * WAD), tx_hash: '0x1', log_index: 0, created_at: new Date('2026-11-20T00:00:00Z') });
  const earn = createCashEarn({ chainId: 97, chain: () => fakeChain(state), query: ledger.query, now });
  const list = await earn.vaults();
  assert.deepEqual(list.vaults.map(v => [v.id, v.status, v.bestRate, v.apyBps]), [['venus_usdt', 'open', true, 513], ['lista_usdt', 'open', false, 305], ['aave_v3_usdt', 'unavailable', false, null]]);
  assert.equal(list.block, '100');
  const account = await earn.account(owner.toUpperCase().replace('0X', '0x'));
  assert.deepEqual(account.wallet, { availableRaw: String(250n * WAD) });
  assert.equal(account.cashEarn.earningRaw, String(1_010n * WAD));
  assert.equal(account.cashEarn.earnedTotalRaw, String(10n * WAD));
  assert.equal(account.cashEarn.positions.length, 1);
  const p = account.cashEarn.positions[0]; assert.ok(p);
  assert.equal(p.maxWithdrawRaw, String(600n * WAD)); assert.equal(p.message, 'You can withdraw up to 600.00 USDT right now.');
  // 6 hours since UTC midnight at 5% APR on 1,010.
  assert.equal(p.earnedTodayRaw, String(earnedTodayEstimate(1_010n * WAD, 500, 6n * 3600n)));
  assert.equal(account.cashEarn.earnedTodayRaw, p.earnedTodayRaw);
  // No key in the response sums wallet cash with Cash Earn.
  assert.equal(JSON.stringify(account).includes(String(1_260n * WAD)), false);
  state.headFails = true;
  // RPC outage: a 200 "temporarily unavailable" state per vault, never an error code (docs/EARN_UX D).
  const down = await earn.vaults();
  assert.deepEqual([down.block, down.updatedAt], [null, null]);
  assert.deepEqual(down.vaults.map(v => [v.status, v.reason, v.depositOpen, v.bestRate, v.message]), Array(3).fill(['unavailable', 'data_unavailable', false, false, 'Temporarily unavailable.']));
  assert.equal(JSON.stringify(down).includes('secret'), false);
  await assert.rejects(createCashEarn({ chainId: 56, chain: () => fakeChain(state), query: ledger.query }).vaults(), /僅開放測試網/);
});

test('#193 deposit: validation, wallet balance, 90% gate returns a status (not an error), cap limit, approve skipping', async () => {
  const state: FakeState = { readings: [reading(), reading({ totalRaw: 10_000n * WAD, liquidityRaw: 999n * WAD }), reading({ capRemainingRaw: 3n * WAD })],
    positions: [none, none, none], balance: 100n * WAD, allowance: 0n };
  const earn = createCashEarn({ chainId: 97, chain: () => fakeChain(state), query: memoryLedger().query, now });
  const ok = await earn.deposit(owner, { vaultId: 'venus_usdt', amountRaw: String(100n * WAD) });
  assert.equal(ok.status, 'ready'); assert.ok('calls' in ok); assert.equal(ok.calls.length, 2);
  state.allowance = 100n * WAD;
  const again = await earn.deposit(owner, { vaultId: 'venus_usdt', amountRaw: String(100n * WAD) });
  assert.ok('calls' in again); assert.equal(again.calls?.length, 1);
  await assert.rejects(earn.deposit(owner, { vaultId: 'venus_usdt', amountRaw: String(100n * WAD + 1n) }), /錢包可用 100.00 USDT/);
  await assert.rejects(earn.deposit(owner, { vaultId: 'venus_usdt', amountRaw: String(WAD - 1n) }), /最少存入 1 USDT/);
  assert.equal((await earn.deposit(owner, { vaultId: 'venus_usdt', amountRaw: String(WAD) })).status, 'ready');
  assert.deepEqual(await earn.deposit(owner, { vaultId: 'lista_usdt', amountRaw: String(WAD) }),
    { status: 'unavailable', vaultId: 'lista_usdt', reason: 'high_utilization', message: 'Temporarily unavailable.' });
  const capped = await earn.deposit(owner, { vaultId: 'aave_v3_usdt', amountRaw: String(4n * WAD) });
  assert.deepEqual(capped, { status: 'limited', vaultId: 'aave_v3_usdt', maxDepositRaw: String(3n * WAD), message: 'This vault can take up to 3.00 USDT right now.' });
  for (const bad of [{ vaultId: 'venus_usdt' }, { vaultId: 'nope', amountRaw: '1' }, { vaultId: 'venus_usdt', amountRaw: 'max' },
    { vaultId: 'venus_usdt', amountRaw: '0' }, { vaultId: 'venus_usdt', amountRaw: '1.5' }, { vaultId: 'venus_usdt', amountRaw: 5 },
    { vaultId: 'venus_usdt', amountRaw: '1', extra: true }, null]) await assert.rejects(earn.deposit(owner, bad));
});

test('#193 withdraw: any amount, Max, liquidity-limited partial max, over-balance and no-position paths', async () => {
  const state: FakeState = { readings: [reading(), reading(), reading({ redeemPaused: true })], positions: [
    { sharesRaw: 200n, valueRaw: 100n * WAD, maxWithdrawRaw: 100n * WAD }, { sharesRaw: 9n, valueRaw: 50n * WAD, maxWithdrawRaw: 20n * WAD },
    { sharesRaw: 5n, valueRaw: 5n * WAD, maxWithdrawRaw: 0n }], balance: 0n, allowance: 0n };
  const earn = createCashEarn({ chainId: 97, chain: () => fakeChain(state), query: memoryLedger().query, now });
  const all = await earn.withdraw(owner, { vaultId: 'venus_usdt', amountRaw: 'max' });
  assert.ok('calls' in all && 'all' in all); assert.equal(all.all, true); assert.equal(all.amountRaw, String(100n * WAD));
  assert.deepEqual(decodeFunctionData({ abi: CASH_EARN_ABI, data: all.calls[0]?.data ?? '0x' }).args, [200n]);
  const part = await earn.withdraw(owner, { vaultId: 'venus_usdt', amountRaw: String(40n * WAD) });
  assert.ok('calls' in part); assert.deepEqual(decodeFunctionData({ abi: CASH_EARN_ABI, data: part.calls?.[0]?.data ?? '0x' }).args, [200n]); // shares capped at balance
  await assert.rejects(earn.withdraw(owner, { vaultId: 'venus_usdt', amountRaw: String(100n * WAD + 1n) }), /最多可領 100.00 USDT/);
  assert.deepEqual(await earn.withdraw(owner, { vaultId: 'lista_usdt', amountRaw: String(20n * WAD + 1n) }),
    { status: 'limited', vaultId: 'lista_usdt', maxWithdrawRaw: String(20n * WAD), message: 'You can withdraw up to 20.00 USDT right now.' });
  assert.equal((await earn.withdraw(owner, { vaultId: 'lista_usdt', amountRaw: String(20n * WAD) })).status, 'ready');
  const maxPartial = await earn.withdraw(owner, { vaultId: 'lista_usdt', amountRaw: 'max' });
  assert.equal(maxPartial.status, 'limited'); assert.ok('partial' in maxPartial && maxPartial.partial);
  assert.equal(maxPartial.partial.amountRaw, String(20n * WAD));
  assert.deepEqual(decodeFunctionData({ abi: CASH_EARN_ABI, data: maxPartial.partial.calls[0]?.data ?? '0x' }).functionName, 'withdraw');
  assert.deepEqual(await earn.withdraw(owner, { vaultId: 'aave_v3_usdt', amountRaw: 'max' }),
    { status: 'unavailable', vaultId: 'aave_v3_usdt', reason: 'withdrawals_paused', message: 'Temporarily unavailable.' });
  state.positions[0] = none;
  await assert.rejects(earn.withdraw(owner, { vaultId: 'venus_usdt', amountRaw: 'max' }), /沒有可領出的部位/);
});

test('#193 confirm: owner-sent, successful, canonical txs only; idempotent; pending when not mined or reorged', async () => {
  const venus = vault('venus_usdt'), hash = `0x${'ab'.repeat(32)}` as Hex, blockHash = `0x${'cd'.repeat(32)}` as Hex;
  const logs = [transferLog(venus.asset, owner, venus.custody, 10n * WAD, 3)];
  const receipt = { status: 'success' as const, from: owner, blockNumber: 7n, blockHash, logs };
  const ledger = memoryLedger();
  const state: FakeState = { readings: [], positions: [], balance: 0n, allowance: 0n };
  const make = (r: typeof receipt | null, canonical = blockHash) => createCashEarn({ chainId: 97, query: ledger.query, now,
    chain: () => fakeChain(state, r ? { [hash]: r } : {}, { '7': canonical }) });
  const done = await make(receipt).confirm(owner, { txHash: hash.toUpperCase().replace('0X', '0x') });
  assert.deepEqual(done, { status: 'confirmed', recorded: [{ vaultId: 'venus_usdt', kind: 'deposit', amountRaw: String(10n * WAD) }] });
  await make(receipt).confirm(owner, { txHash: hash });
  assert.equal(ledger.rows.length, 1);
  assert.deepEqual(await make(null).confirm(owner, { txHash: hash }), { status: 'pending', recorded: [] });
  assert.deepEqual(await make(receipt, `0x${'ee'.repeat(32)}`).confirm(owner, { txHash: hash }), { status: 'pending', recorded: [] });
  await assert.rejects(make({ ...receipt, status: 'reverted' as never }).confirm(owner, { txHash: hash }), /沒有成功/);
  await assert.rejects(make({ ...receipt, from: '0x00000000000000000000000000000000000000b2' }).confirm(owner, { txHash: hash }), /自己錢包/);
  await assert.rejects(make({ ...receipt, logs: [] }).confirm(owner, { txHash: hash }), /沒有存入或領出/);
  for (const bad of [{}, { txHash: '0x12' }, { txHash: hash, x: 1 }]) await assert.rejects(make(receipt).confirm(owner, bad));
  assert.equal(ledger.rows.length, 1);
});

test('#193 HTTP: public vault list with short cache, authenticated account/actions, 405/401', async () => {
  const state: FakeState = { readings: [reading(), reading(), reading()], positions: [none, none, none], balance: 5n * WAD, allowance: 0n };
  const server = createServer({
    cashEarn: createCashEarn({ chainId: 97, chain: () => fakeChain(state), query: memoryLedger().query, now }),
    rateLimiter: new RequestRateLimiter(loadRateLimitConfig({}), new MemoryRateLimitStore()),
    auth: { authenticate: async (h) => { if (h !== 'Bearer ok') throw new UnauthorizedError('login required'); return owner; },
      issueNonce: () => { throw new Error('unused'); }, login: async () => { throw new Error('unused'); }, logout: async () => {} },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`, auth = { authorization: 'Bearer ok' };
  try {
    const list = await fetch(`${base}/earn/vaults`);
    assert.equal(list.status, 200); assert.equal(list.headers.get('cache-control'), 'public, max-age=30');
    assert.equal((await fetch(`${base}/earn/vaults`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/me/earn`)).status, 401);
    const account: unknown = await (await fetch(`${base}/me/earn`, { headers: auth })).json();
    assert.ok(account && typeof account === 'object' && 'wallet' in account && 'cashEarn' in account);
    assert.equal((await fetch(`${base}/me/earn`, { method: 'POST', headers: auth })).status, 405);
    assert.equal((await fetch(`${base}/me/earn/deposit`, { headers: auth })).status, 405);
    const dep = await fetch(`${base}/me/earn/deposit`, { method: 'POST', headers: auth, body: JSON.stringify({ vaultId: 'lista_usdt', amountRaw: String(5n * WAD) }) });
    assert.equal(dep.status, 200);
    assert.equal((await fetch(`${base}/me/earn/withdraw`, { method: 'POST', headers: auth, body: JSON.stringify({ vaultId: 'lista_usdt', amountRaw: 'max' }) })).status, 400);
    assert.equal((await fetch(`${base}/me/earn/unknown`, { method: 'POST', headers: auth, body: '{}' })).status, 404);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});


test('#193 outages become "temporarily unavailable" states: account, deposit, withdraw, confirm; sums never understated', async () => {
  const state: FakeState = { readings: [reading(), reading(), reading()], positions: [
    { sharesRaw: 50n, valueRaw: 100n * WAD, maxWithdrawRaw: 100n * WAD }, { sharesRaw: 9n, valueRaw: 40n * WAD, maxWithdrawRaw: 40n * WAD }, none],
    balance: 10n * WAD, allowance: 0n };
  const ledger = memoryLedger();
  for (const vaultId of ['venus_usdt', 'lista_usdt']) ledger.rows.push({ chain_id: 97, owner, vault_id: vaultId, kind: 'deposit', assets_raw: String(40n * WAD),
    tx_hash: '0x' + vaultId, log_index: 0, created_at: new Date('2026-11-20T00:00:00Z') });
  const earn = createCashEarn({ chainId: 97, chain: () => fakeChain(state), query: ledger.query, now });
  const ok = await earn.account(owner);
  assert.deepEqual([ok.status, ok.cashEarn.earningRaw, ok.cashEarn.earnedTotalRaw], ['ok', String(140n * WAD), String(60n * WAD)]);
  // One vault unreadable (Lista): its row is unavailable and every Cash Earn sum is null, not a smaller number.
  state.readings[1] = null;
  const partial = await earn.account(owner);
  assert.equal(partial.status, 'ok'); assert.equal(partial.wallet.availableRaw, String(10n * WAD));
  assert.deepEqual([partial.cashEarn.earningRaw, partial.cashEarn.earnedTodayRaw, partial.cashEarn.earnedTotalRaw], [null, null, null]);
  assert.deepEqual(partial.cashEarn.positions.map(p => [p.vaultId, p.status, p.valueRaw]), [['venus_usdt', 'open', String(100n * WAD)], ['lista_usdt', 'unavailable', null]]);
  state.readings[1] = reading();
  state.positionFails = true;
  const noPositions = await earn.account(owner);
  assert.deepEqual(noPositions.cashEarn.positions.map(p => p.status), ['unavailable', 'unavailable']);
  assert.equal(noPositions.cashEarn.earningRaw, null);
  const unavailable = { status: 'unavailable', vaultId: 'venus_usdt', reason: 'data_unavailable', message: 'Temporarily unavailable.' };
  assert.deepEqual(await earn.withdraw(owner, { vaultId: 'venus_usdt', amountRaw: 'max' }), unavailable);
  state.positionFails = false; state.balanceFails = true;
  const whole = await earn.account(owner);
  assert.deepEqual([whole.status, whole.reason, whole.wallet.availableRaw, whole.cashEarn.earningRaw, whole.cashEarn.positions], ['unavailable', 'data_unavailable', null, null, []]);
  assert.deepEqual(await earn.deposit(owner, { vaultId: 'venus_usdt', amountRaw: String(WAD) }), unavailable);
  state.balanceFails = false; state.headFails = true;
  assert.equal((await earn.account(owner)).status, 'unavailable');
  assert.deepEqual(await earn.deposit(owner, { vaultId: 'venus_usdt', amountRaw: String(WAD) }), unavailable);
  assert.deepEqual(await earn.withdraw(owner, { vaultId: 'venus_usdt', amountRaw: String(WAD) }), unavailable);
  // Validation still fails before any chain read.
  await assert.rejects(earn.deposit(owner, { vaultId: 'nope', amountRaw: '1' }), /請選擇一個 vault/);
  state.headFails = false; state.receiptFails = true;
  const rows = ledger.rows.length;
  assert.deepEqual(await earn.confirm(owner, { txHash: `0x${'ab'.repeat(32)}` }), { status: 'pending', recorded: [] });
  assert.equal(ledger.rows.length, rows);
});
