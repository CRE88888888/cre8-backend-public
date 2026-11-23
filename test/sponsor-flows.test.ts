import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicClient, custom, encodeFunctionData, erc20Abi, maxUint256 } from 'viem';
import type { Address, Hex } from 'viem';
import { bscTestnet } from 'viem/chains';
import { encodeCallDataEpV07 } from '@zerodev/sdk';
import { AppError } from '../src/errors.js';
import { createPaymasterService } from '../src/paymaster.js';
import { EXECUTOR_ABI } from '../src/chain.js';
import { buildSessionPermissions } from '../src/permissions.js';
import { closeCalls, consentCalls, openCalls, strategyMarkets } from '../src/strategy-earn.js';
import { dcaDepositCalls, dcaReceiptApproval, dcaReturnCalls, dcaVaults } from '../src/dca-calls.js';
import { YIELD_EXECUTOR_ABI } from '../src/yield-abi.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
import { config, NOW, operation, OWNER, SENDER, TEST_SIGNER } from './fixtures/paymaster.js';

/**
 * Every user flow that ends in a sponsored UserOp, built with the same builders/calldata the frontend sends, run
 * through the whole public /paymaster/sponsor validation for a normal fund account AND a My mix account.
 *
 * 2026-11-23 portfolio 10 (mix 5): DCA open on a My mix sent renewal + USDT.approve(DCA vault) + deposit +
 * receipt.approve(executor). The mix branch treated every approve as an owner mix change (403 without a pending
 * change), accepted only the plain renewal scope, forbade the DCA period redemption, and took the mix lock (409
 * MIX_BUSY while the scheduler / a mix refresh held it).
 *
 * Not UserOps (nothing to sponsor): cash earn deposit/withdraw (owner EOA sends the vault calls), claim test USDT
 * (POST /faucet/usdt mints server-side), funding a mix (EOA USDT transfer).
 */
const c = config({ CHAIN_ID: '97', RPC_URL: 'http://127.0.0.1:8558', PAYMASTER_SIGNER_PRIVATE_KEY: TEST_SIGNER });
const account = SENDER.toLowerCase() as Address;
const owner = OWNER as Address;
const executor = T.contracts.executor as Address;
const usdt = T.contracts.usdt as Address;
const asset = T.assets.NVDAB.token as Address;
const stranger = '0x3000000000000000000000000000000000000003' as Address;
const vaults = dcaVaults();
const markets = strategyMarkets();
const offline = createPublicClient({ chain: bscTestnet, transport: custom({ request: async () => { throw new Error('no rpc in this test'); } }) });
type Call = { to: Address; data: Hex; value: bigint };
const asCall = (x: { to: string; data: string }): Call => ({ to: x.to as Address, data: x.data as Hex, value: 0n });
const approve = (token: Address, spender: Address, amount = maxUint256): Call =>
  ({ to: token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }) });
const transfer = (token: Address, to: Address, amount: bigint): Call =>
  ({ to: token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }) });
const rebalance = (tokenIn: Address, tokenOut: Address): Call => ({ to: executor, value: 0n, data: encodeFunctionData({ abi: EXECUTOR_ABI,
  functionName: 'executeRebalance', args: [account, [{ tokenIn, tokenOut, amountIn: 10n ** 18n, amountOutMin: 1n, venue: T.assets.WBNB.pool as Address, data: '0x' }], BigInt(NOW + 300)] }) });
const yieldCall = (kind: 'executeSupply' | 'executeWithdraw', marketId: Hex): Call => ({ to: executor, value: 0n,
  data: encodeFunctionData({ abi: YIELD_EXECUTOR_ABI, functionName: kind, args: [account, marketId, 10n ** 18n, 1n, BigInt(NOW + 300)] }) });
/** GET /portfolios/:id/renewal-params on chain 97: yield + Strategy Earn for this account (src/renewal.ts). */
async function renewal(): Promise<Call[]> {
  const session = await buildSessionPermissions({ publicClient: offline as never, sessionKeyAddress: '0x2000000000000000000000000000000000000002',
    executorAddress: executor, validUntil: NOW + 30 * 86400, yieldAccount: account, borrowAccount: account });
  return session.initConfig.map((data) => ({ to: account, data: data as Hex, value: 0n }));
}

type Kind = 'fund' | 'mix';
function harness(kind: Kind, opts: { pendingChange?: boolean } = {}) {
  const seen = { locks: 0, reservations: 0, setups: 0, exits: 0 };
  const service = createPaymasterService({ config: c, now: () => NOW,
    mixLock: async (_id, work) => { seen.locks++; return work(); },
    query: async (sql) => ({ rows: sql.includes('select s.owner') ? [{ owner, user_id: owner, mix_id: kind === 'mix' ? '5' : null }]
      : sql.includes('from mixes m where') ? [{ id: '5', owner, account, triggered_at: null, status: 'active' }]
      : sql.includes('mix_switch_intents') ? opts.pendingChange ? [{ id: '1', strategy_id: '12', owner_calls: [], nonce: '0', user_op_hash: null }] : []
      : sql.includes('select ms.exit_assets') ? [{ exit_assets: [] }] : [] }),
    mixSetup: async () => { seen.setups++; },
    checkChain: async () => {},
    readBudgetContext: async () => ({ purpose: 'ordinary', nativePrice: 60000000000n, priceSource: 'fixture:oracle' }),
    verifyYieldWithdraw: async () => { seen.exits++; return []; },
    reserve: async () => { seen.reservations++; } });
  const sponsor = async (calls: Call[]) => service.sponsor({ userOperation: operation({ sender: account, callData: await encodeCallDataEpV07(calls) }) }, owner);
  return { seen, sponsor };
}
const code = (expected: string, status: number) => (e: unknown) => e instanceof AppError && e.code === expected && e.status === status;

/** Flow name -> exact calls, per account type. Mix flows only include what the UI can send for a mix. */
async function flows(kind: Kind): Promise<[string, Call[], { lock: boolean }][]> {
  const r = await renewal(), deadline = BigInt(NOW + 600);
  const shared: [string, Call[], { lock: boolean }][] = [];
  for (const v of vaults) {
    const open = [...dcaDepositCalls(v, account, 300n * 10n ** 18n, 0n), dcaReceiptApproval(v, executor)].map(asCall);
    // Fund DCA appends missing asset approvals (wallet-entry dcaStartRaw); a mix does not.
    shared.push([`DCA open ${v.id} (renewal required)`, [...r, ...open, ...(kind === 'fund' ? [approve(asset, executor)] : [])], { lock: false }]);
    shared.push([`DCA open ${v.id} (key ready, allowance set)`, dcaDepositCalls(v, account, 300n * 10n ** 18n, maxUint256).map(asCall), { lock: false }]);
    shared.push([`DCA withdraw ${v.id}`, dcaReturnCalls(v, account, owner, 9n * 10n ** 18n, 9n * 10n ** 18n).map(asCall), { lock: false }]);
    shared.push([`DCA period redemption ${v.id} (scheduler session key)`, [yieldCall('executeWithdraw', v.marketId)], { lock: false }]);
  }
  shared.push(['sell (scheduler session key)', [rebalance(asset, usdt)], { lock: true }]);
  shared.push(['withdraw USDT to wallet / delete-mix cash', [transfer(usdt, owner, 10n ** 18n)], { lock: false }]);
  shared.push(['standalone permission renewal', r, { lock: true }]);
  if (kind === 'mix') {
    shared.push(['mix buy (scheduler session key)', [rebalance(usdt, asset)], { lock: true }]);
    return shared;
  }
  shared.push(['fund buy: approvals', [approve(usdt, executor), approve(asset, executor)], { lock: false }]);
  shared.push(['fund buy + Strategy Earn auto (renewal + consent)', [approve(asset, executor), ...r,
    ...consentCalls(markets.slice(0, 3).map((market) => ({ market, maxDebtRaw: 10n ** 21n }))).map(asCall)], { lock: false }]);
  shared.push(['Strategy Earn open after buy', openCalls(markets[0]!, account, 10n ** 18n, 10n ** 17n, 10n ** 18n, deadline).map(asCall), { lock: false }]);
  shared.push(['Strategy Earn off', closeCalls(markets[0]!, account, deadline).map(asCall), { lock: false }]);
  shared.push(['fund sell', [rebalance(asset, usdt)], { lock: false }]);
  return shared;
}

for (const kind of ['fund', 'mix'] as const) {
  test(`${kind} account: every user flow's UserOp is sponsored`, async () => {
    for (const [name, calls, expect] of await flows(kind)) {
      const h = harness(kind);
      await assert.doesNotReject(h.sponsor(calls), `${kind}: ${name}`);
      assert.equal(h.seen.reservations, 1, `${kind}: ${name}`);
      if (kind === 'mix') assert.equal(h.seen.locks, expect.lock ? 1 : 0, `${kind}: ${name} mix lock`);
    }
  });
}

test('portfolio 10: DCA on a fresh My mix (renewal + approve + deposit + receipt approval) is sponsored without the mix lock', async () => {
  for (const v of vaults) {
    const h = harness('mix');
    const calls = [...await renewal(), ...[...dcaDepositCalls(v, account, 300n * 10n ** 18n, 0n), dcaReceiptApproval(v, executor)].map(asCall)];
    await h.sponsor(calls);
    assert.deepEqual(h.seen, { locks: 0, reservations: 1, setups: 0, exits: 0 }, v.id);
  }
});

test('My mix: mix creation / weight edit still require the pending change and its exact setup check', async () => {
  const calls = [approve(asset, executor), { to: T.contracts.registry as Address, value: 0n,
    data: encodeFunctionData({ abi: [{ type: 'function', name: 'enroll', inputs: [{ type: 'address' }, { type: 'uint256' }, { type: 'uint16' }], outputs: [], stateMutability: 'nonpayable' }],
      functionName: 'enroll', args: [account, 12n, 1] }) }];
  await assert.rejects(harness('mix').sponsor(calls), code('PAYMASTER_CALL_FORBIDDEN', 403));
  const h = harness('mix', { pendingChange: true });
  await h.sponsor(calls);
  assert.equal(h.seen.setups, 1);
  assert.equal(h.seen.locks, 1);
});

test('My mix: DCA keeps every DCA safety rule, and per-asset yield stays off', async () => {
  const lista = vaults.find(v => v.id === 'lista_usdt')!, venus = vaults.find(v => v.id === 'venus_usdt')!;
  const nonDcaMarket = T.yieldMarkets.find(m => !vaults.some(v => v.marketId === m.marketId))!.marketId as Hex;
  const cases: [string, Call[]][] = [
    ['USDT approved to a stranger', [approve(usdt, stranger, 1n), ...dcaDepositCalls(lista, account, 1n, maxUint256).map(asCall)]],
    ['DCA receipt approved to a stranger', [...dcaDepositCalls(lista, account, 1n, maxUint256).map(asCall), approve(lista.receipt, stranger)]],
    ['deposit for another account', [{ to: lista.spender, value: 0n, data: encodeFunctionData({ abi: [{ type: 'function', name: 'deposit', inputs: [{ type: 'uint256' }, { type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'nonpayable' }], functionName: 'deposit', args: [1n, stranger] }) }]],
    ['return to a stranger', dcaReturnCalls(lista, account, stranger, 1n, 1n).map(asCall)],
    ['Venus return forwarded to a stranger', dcaReturnCalls(venus, account, stranger, 1n, 1n).map(asCall)],
    ['per-asset yield supply on a DCA market', [yieldCall('executeSupply', lista.marketId)]],
    ['per-asset yield withdraw on a non-DCA market', [yieldCall('executeWithdraw', nonDcaMarket)]],
    ['yield registry policy', [{ to: T.contracts.yieldRegistry as Address, value: 0n, data: '0x12345678' }]],
    ['DCA deposit + a non-USDT transfer', [...dcaDepositCalls(lista, account, 1n, maxUint256).map(asCall), transfer(asset, owner, 1n)]],
  ];
  for (const [name, calls] of cases) {
    const h = harness('mix');
    await assert.rejects(h.sponsor(calls), code('PAYMASTER_CALL_FORBIDDEN', 403), name);
    assert.equal(h.seen.reservations, 0, name);
  }
  // During a pending mix change a DCA UserOp waits (409 MIX_BUSY, retryable); a USDT withdrawal to the owner still works.
  const pending = harness('mix', { pendingChange: true });
  await assert.rejects(pending.sponsor(dcaDepositCalls(lista, account, 1n, maxUint256).map(asCall)), code('MIX_BUSY', 409));
  await pending.sponsor([transfer(usdt, owner, 1n)]);
  assert.equal(pending.seen.reservations, 1);
});
