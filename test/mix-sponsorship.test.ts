import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeFunctionData, erc20Abi, maxUint256, getAddress } from 'viem';
import { assertMixOwnerCalls, MIX_SUDO_NONCE_KEY } from '../src/mix-sponsorship.js';
import { mixOwnerCalls } from '../src/mix-approval.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
import { encodeCallDataEpV07 } from '@zerodev/sdk';
import { createPaymasterService } from '../src/paymaster.js';
import { EXECUTOR_ABI } from '../src/chain.js';
import { config, operation, NOW, OWNER, TEST_SIGNER } from './fixtures/paymaster.js';

const account = T.roles.keeper, asset = T.assets.NVDAB.token;
const stored = mixOwnerCalls({ account, registry: T.contracts.registry, executor: T.contracts.executor, onchainId: 12n,
  previousAssets: [T.contracts.usdt], assets: [asset, T.contracts.usdt], allowances: new Map([[asset, 0n]]) });
const calls = stored.map(c => ({ target: c.to, value: 0n, callData: c.data }));
const input = { account, onchainId: 12n, previousAssets: [T.contracts.usdt], selectedAssets: [asset], stored, calls,
  nonce: MIX_SUDO_NONCE_KEY << 64n };
test('mix sponsor matches an atomic approval+enroll with owner nonce, including sequence upper bound', () => {
  assertMixOwnerCalls(input);
  assertMixOwnerCalls({ ...input, nonce: input.nonce + (1n << 64n) - 1n });
  for (const custom of [1n, 65535n]) assertMixOwnerCalls({ ...input, nonce: input.nonce + (custom << 64n) });
  assertMixOwnerCalls({ ...input, previousAssets: [asset, T.contracts.usdt], stored: stored.slice(-1), calls: calls.slice(-1) });
});
test('mix sponsor rejects session/enable/wrong-validator nonce keys, nonzero value and missing/extra/reordered calls', () => {
  for (const nonce of [-1n, 0n, input.nonce + (1n << 80n), input.nonce + (1n << 248n)]) {
    assert.throws(() => assertMixOwnerCalls({ ...input, nonce }), /待確認/);
  }
  for (const malformed of [[], calls.slice(1), [...calls, ...calls], [...calls].reverse(), calls.map(c => ({ ...c, value: 1n }))]) {
    assert.throws(() => assertMixOwnerCalls({ ...input, calls: malformed }), /待確認/);
  }
});
test('mix sponsor independently rejects a corrupt saved approval with wrong amount/spender/asset and redundant approval', () => {
  for (const [target, spender, amount] of [[asset, T.roles.keeper, maxUint256], [asset, T.contracts.executor, 1n],
    [T.assets.TSLAB.token, T.contracts.executor, maxUint256]] as const) {
    const bad = [{ to: target, value: '0' as const, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }) }, ...stored.slice(1)];
    assert.throws(() => assertMixOwnerCalls({ ...input, stored: bad, calls: bad.map(c => ({ target: c.to, value: 0n, callData: c.data })) }), /待確認/);
  }
  assert.throws(() => assertMixOwnerCalls({ ...input, previousAssets: [asset, T.contracts.usdt] }), /待確認/);
  assert.throws(() => assertMixOwnerCalls({ ...input, onchainId: 0n }), /待確認/);
});

test('public sponsor holds the mix lock through reservation, dispatches exact setup and blocks pending/exited/exit-asset/yield buys', async () => {
  let pending = true, exited = false, held = false, fail = false, missingSettings = false, reservations = 0, checks = 0;
  let persistedHash: unknown = null;
  const service = createPaymasterService({ config: config({ CHAIN_ID: '97', RPC_URL: 'http://127.0.0.1:1', PAYMASTER_SIGNER_PRIVATE_KEY: TEST_SIGNER }), now: () => NOW,
    mixLock: async (_id, work) => { held = true; try { return await work(); } finally { held = false; } },
    query: async (sql, args) => {
      if (sql.startsWith('update mix_switch_intents')) { assert.equal(held, true); persistedHash = args?.[1]; assert.equal(args?.[2], input.nonce.toString()); return { rows: [{ id: '1' }] }; }
      return { rows: sql.includes('select s.owner') ? [{ owner: OWNER, user_id: OWNER, mix_id: '1' }]
      : sql.includes('from mixes m where') ? [{ id: '1', owner: OWNER, account, triggered_at: null, status: exited ? 'exited' : 'active' }]
      : sql.includes('mix_switch_intents') ? pending ? [{ id: '1', strategy_id: '12', owner_calls: stored, nonce: input.nonce.toString(), user_op_hash: null }] : []
      : sql.includes('select ms.exit_assets') ? missingSettings ? [] : [{ exit_assets: [T.assets.TSLAB.token] }] : [] };
    },
    mixSetup: async (_m, intent, actual, nonce) => {
      checks++; assert.equal(held, true);
      if (fail) throw new Error('private RPC credential');
      assertMixOwnerCalls({ ...input, stored: intent.owner_calls, calls: actual, nonce });
    },
    checkChain: async () => { assert.equal(held, true); },
    readBudgetContext: async () => ({ purpose: 'setup', nativePrice: 60000000000n, priceSource: 'fixture:oracle' }),
    reserve: async () => { assert.equal(held, true); reservations++; } });
  const setup = await encodeCallDataEpV07(stored.map(c => ({ to: c.to, data: c.data, value: 0n })));
  const authorization = await service.sponsor({ userOperation: operation({ sender: account, nonce: input.nonce, callData: setup }) }, OWNER);
  assert.equal(persistedHash, authorization.userOpHash, 'sponsor persists the signed hash/nonce before returning authority');
  assert.equal(reservations, 1); assert.equal(checks, 1); assert.equal(held, false);
  fail = true;
  await assert.rejects(service.sponsor({ userOperation: operation({ sender: account, nonce: input.nonce, callData: setup }) }, OWNER), e => e instanceof Error && !e.message.includes('credential'));
  assert.equal(reservations, 1); fail = false;
  const buy = async (tokenOut: `0x${string}`) => operation({ sender: account, callData: await encodeCallDataEpV07([{ to: T.contracts.executor,
    data: encodeFunctionData({ abi: EXECUTOR_ABI, functionName: 'executeRebalance', args: [account,
      [{ tokenIn: T.contracts.usdt, tokenOut, amountIn: 100n, amountOutMin: 1n, venue: T.assets.WBNB.pool, data: '0x' }], 1800000300n] }) }]) });
  await assert.rejects(service.sponsor({ userOperation: await buy(asset) }, OWNER), /PAYMASTER_CALL_FORBIDDEN/);
  pending = false;
  await assert.rejects(service.sponsor({ userOperation: await buy(T.assets.TSLAB.token) }, OWNER), /PAYMASTER_CALL_FORBIDDEN/);
  missingSettings = true;
  await assert.rejects(service.sponsor({ userOperation: await buy(asset) }, OWNER), /PAYMASTER_DEPENDENCY_UNAVAILABLE/);
  missingSettings = false;
  exited = true;
  await assert.rejects(service.sponsor({ userOperation: await buy(asset) }, OWNER), /PAYMASTER_CALL_FORBIDDEN/);
  assert.equal(reservations, 1);
});

test('mix sponsor permits only USDT withdrawal to its owner even during a pending switch', async () => {
  let pending = true, reservations = 0;
  const service = createPaymasterService({ config: config({ CHAIN_ID: '97', RPC_URL: 'http://127.0.0.1:1', PAYMASTER_SIGNER_PRIVATE_KEY: TEST_SIGNER }), now: () => NOW,
    mixLock: async (_id, work) => work(),
    query: async sql => ({ rows: sql.includes('select s.owner') ? [{ owner: OWNER, user_id: OWNER, mix_id: '1' }]
      : sql.includes('from mixes m where') ? [{ id: '1', owner: OWNER, account, status: 'active', triggered_at: null }]
      : sql.includes('mix_switch_intents') ? pending ? [{ id: '1' }] : []
      : sql.includes('select ms.exit_assets') ? [{ exit_assets: [] }] : [] }),
    checkChain: async () => {}, readBudgetContext: async () => ({ purpose: 'ordinary', nativePrice: 60000000000n, priceSource: 'fixture:oracle' }),
    reserve: async () => { reservations++; } });
  const withdraw = async (token: `0x${string}`, recipient: string, amount = 1n) => ({ userOperation: operation({ sender: account,
    callData: await encodeCallDataEpV07([{ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [getAddress(recipient), amount] }) }]) }) });
  await service.sponsor(await withdraw(T.contracts.usdt, OWNER), OWNER);
  assert.equal(reservations, 1);
  for (const flag of [true, false]) {
    pending = flag;
    for (const [token, recipient, amount] of [[asset, OWNER, 1n], [T.contracts.usdt, T.roles.keeper, 1n], [T.contracts.usdt, OWNER, 0n]] as const) {
      await assert.rejects(service.sponsor(await withdraw(token, recipient, amount), OWNER), { code: 'PAYMASTER_CALL_FORBIDDEN' });
    }
  }
  assert.equal(reservations, 1);
});
