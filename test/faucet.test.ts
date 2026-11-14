import type { Address, Hex, TransactionReceipt } from 'viem';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFaucetService } from '../src/faucet.js';
import type { FaucetClaim, FaucetDeps, PreparedClaim } from '../src/faucet.js';
import { loadFaucetConfig } from '../src/config.js';
import { AppError, UnauthorizedError } from '../src/errors.js';
import { createServer } from '../src/server.js';
import { RequestRateLimiter } from '../src/ratelimit.js';
import { loadRateLimitConfig } from '../src/config.js';
import type { AddressInfo } from 'node:net';

const owner = '0x1000000000000000000000000000000000000069';
const account = '0x2000000000000000000000000000000000000069';
const hash = `0x${'69'.repeat(32)}` as const;
const config = loadFaucetConfig({ CHAIN_ID: '97' });
assert.ok(config);
const c = config;
const denied = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;

function harness(extra: FaucetDeps = {}) {
  const events: string[] = [];
  let sends = 0;
  const claim: FaucetClaim = { id: '69', chainId: 97, day: '2026-11-14', owner, account, amountWei: c.amountWei };
  const prepared: PreparedClaim = { hash, broadcast: async () => { sends++; events.push('broadcast'); }, receipt: async () => 'confirmed' };
  const deps: FaucetDeps = { lock: async (_chainId, action) => action(() => {}), config: c, query: async () => ({ rows: [{ owner, user_id: owner }] }),
    reserve: async () => { events.push('committed'); return claim; },
    settle: async (_claim, from, to) => { events.push(from + '->' + to); },
    prepare: async () => prepared, ...extra };
  return { service: createFaucetService(deps), events, sends: () => sends, prepared, claim };
}

test('#69 faucet config defaults, exact contract cap, zero pause, uint256 and malformed amounts', () => {
  assert.equal(c.amountWei, 1_000n * 10n ** 18n);
  assert.equal(c.siteDailyWei, 1_000_000n * 10n ** 18n);
  assert.equal(loadFaucetConfig({ CHAIN_ID: '56' }), null);
  for (const amount of ['0', String(10_000n * 10n ** 18n)]) assert.equal(loadFaucetConfig({ CHAIN_ID: '97', FAUCET_USDT_AMOUNT_WEI: amount })?.amountWei, BigInt(amount));
  for (const amount of ['-1', '0.1', 'NaN', String(10_000n * 10n ** 18n + 1n)]) {
    assert.throws(() => loadFaucetConfig({ CHAIN_ID: '97', FAUCET_USDT_AMOUNT_WEI: amount }));
  }
  assert.throws(() => loadFaucetConfig({ CHAIN_ID: '97', FAUCET_USDT_SITE_DAILY_WEI: String(1n << 256n) }));
  assert.deepEqual(loadFaucetConfig({ CHAIN_ID: '97', FAUCET_DAILY_COUNT: '2' }), c, 'daily count has no env override');
});

test('#69 faucet commits reservation and signed hash before the only broadcast', async () => {
  const h = harness();
  assert.deepEqual(await h.service.claim({ account }, owner), { claimId: '69', state: 'confirmed', amountWei: c.amountWei.toString(), txHash: hash });
  assert.deepEqual(h.events, ['committed', 'reserved->submitted', 'broadcast', 'submitted->confirmed']);
  assert.equal(h.sends(), 1);
});

test('#69 chain 56 is disabled; malformed request, foreign owner and missing DB rows cannot reserve or send', async () => {
  await assert.rejects(createFaucetService({ config: null }).claim({ account }, owner), denied('FAUCET_DISABLED'));
  for (const input of [null, [], {}, { account: '0x' }, { account: '0x' + '0'.repeat(40) }, { account, amount: '2000' }]) {
    const h = harness();
    await assert.rejects(h.service.claim(input, owner), denied('FAUCET_INVALID_REQUEST'));
    assert.deepEqual(h.events, []);
  }
  for (const rows of [[], [{ owner: account, user_id: owner }], [{ owner, user_id: account }], [{}]]) {
    const h = harness({ query: async () => ({ rows }) });
    await assert.rejects(h.service.claim({ account }, owner), denied('FAUCET_ACCOUNT_FORBIDDEN'));
    assert.deepEqual(h.events, []);
  }
});

test('#69 DB error/timeout, quota rejection and unknown reservation/hash commit never broadcast', async () => {
  for (const extra of [
    { query: async () => { throw new Error('SECRET_DB_URL'); } },
    { query: async () => new Promise<never>(() => {}), config: { ...c, timeoutMs: 10 } },
    { reserve: async () => { throw new AppError(429, 'FAUCET_QUOTA_EXCEEDED', 'quota'); } },
    { reserve: async () => { throw new AppError(503, 'FAUCET_STORAGE_UNAVAILABLE', 'unknown commit'); } },
    { settle: async () => { throw new AppError(503, 'FAUCET_STORAGE_UNAVAILABLE', 'unknown signed-hash commit'); } },
  ]) {
    const h = harness(extra);
    await assert.rejects(h.service.claim({ account }, owner), (error: unknown) => error instanceof AppError && !error.message.includes('SECRET'));
    assert.equal(h.sends(), 0);
  }
});

test('#69 pre-broadcast failure or timeout releases quota; late preparation never sends', async () => {
  for (const mode of ['error', 'timeout']) {
    const h = harness({ config: { ...c, timeoutMs: 10 }, prepare: async () => {
      if (mode === 'error') throw new Error('SECRET_RPC_URL');
      await new Promise((resolve) => setTimeout(resolve, 25));
      return h.prepared;
    } });
    await assert.rejects(h.service.claim({ account }, owner), denied('FAUCET_PREPARE_UNAVAILABLE'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(h.events, ['committed', 'reserved->failed']);
    assert.equal(h.sends(), 0);
  }
});

test('#69 broadcast ambiguity, receipt failure/timeout/missing event preserve quota; only reverted receipt refunds', async () => {
  for (const stage of ['broadcast', 'receipt', 'receipt-timeout', 'unknown', 'failed']) {
    const h = harness({ config: { ...c, timeoutMs: 10 }, prepare: async () => ({ hash,
      broadcast: async () => { if (stage === 'broadcast') throw new Error('SECRET_RPC_URL'); },
      receipt: async () => {
        if (stage === 'receipt') throw new Error('SECRET_RPC_URL');
        if (stage === 'receipt-timeout') return new Promise<never>(() => {});
        return stage === 'failed' ? 'failed' : 'unknown';
      },
    }) });
    const result = await h.service.claim({ account }, owner);
    assert.equal(result.state, stage === 'failed' ? 'failed' : 'unknown');
    assert.equal(h.events.at(-1), 'submitted->' + result.state);
  }
});

test('#69 faucet HTTP login, method, rate budget, body and unknown 202', async () => {
  let loggedIn = false;
  let calls = 0;
  const server = createServer({
    auth: { authenticate: async () => { if (!loggedIn) throw new UnauthorizedError(); return owner; },
      issueNonce: () => { throw new Error('unexpected'); }, login: async () => { throw new Error('unexpected'); }, logout: async () => {} },
    rateLimiter: new RequestRateLimiter(loadRateLimitConfig({ RATE_LIMIT_PLAN_PER_MINUTE: '2' })),
    claimFaucetUsdt: async (input, wallet) => {
      assert.equal(wallet, owner); assert.deepEqual(input, { account }); calls++;
      return { claimId: '69', state: 'unknown', amountWei: c.amountWei.toString(), txHash: hash };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/faucet/usdt';
  try {
    assert.equal((await fetch(url)).status, 405);
    assert.equal((await fetch(url, { method: 'POST', body: 'invalid' })).status, 401);
    loggedIn = true;
    assert.equal((await fetch(url, { method: 'POST', body: 'invalid' })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify({ account }) })).status, 202);
    const limited = await fetch(url, { method: 'POST', body: JSON.stringify({ account }) });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal(calls, 1);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('#69 relayer busy rejects before reservation; recipient errors refund only the unsent reservation', async () => {
  const busy = harness({ lock: async () => { throw new AppError(503, 'RELAYER_BUSY', 'busy'); } });
  await assert.rejects(busy.service.claim({ account }, owner), denied('RELAYER_BUSY'));
  assert.deepEqual(busy.events, []);
  for (const code of ['FAUCET_RECIPIENT_LIMIT', 'FAUCET_OPERATOR_UNAVAILABLE', 'FAUCET_CHAIN_MISMATCH']) {
    const h = harness({ prepare: async () => { throw new AppError(503, code, 'unavailable'); } });
    await assert.rejects(h.service.claim({ account }, owner), denied(code));
    assert.deepEqual(h.events, ['committed', 'reserved->failed']);
  }
});

test('#69 real RPC decoder: chain/minter/recipient limit at 0, cap-1 and exact cap; missing or unavailable RPC fails', async () => {
  const { checkFaucetRecipient } = await import('../src/faucet.js');
  const { createPublicClient, custom, encodeAbiParameters, toFunctionSelector } = await import('viem');
  const { TESTNET_97 } = await import('../src/testnet-profile.js');
  for (const mode of ['ok', 'zero', 'below', 'chain', 'minter', 'missing', 'rpc', 'chain-rpc']) {
    const client = createPublicClient({ transport: custom({ request: async ({ method, params }) => {
      if (mode === 'rpc' || mode === 'chain-rpc' && method === 'eth_chainId') throw new Error('secret-rpc');
      if (method === 'eth_chainId') return mode === 'chain' ? '0x38' : '0x61';
      assert.equal(method, 'eth_call');
      const payload: unknown = params;
      assert.ok(Array.isArray(payload));
      const call: unknown = payload[0]; assert.ok(typeof call === 'object' && call !== null);
      if (mode === 'missing') return '0x';
      return Reflect.get(call, 'data').startsWith(toFunctionSelector('isMinter(address)'))
        ? encodeAbiParameters([{ type: 'bool' }], [mode !== 'minter'])
        : encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [mode === 'zero' ? 0n : mode === 'below' ? c.amountWei - 1n : c.amountWei, 0n]);
    } }, { retryCount: 0 }) });
    const action = checkFaucetRecipient(client, TESTNET_97.roles.operator, { account, amountWei: c.amountWei });
    if (mode === 'ok') await action;
    else await assert.rejects(action);
  }
});

test('#69 receipt needs the exact token, recipient, amount and operator; revert refunds, missing/malformed event stays unknown', async () => {
  const { faucetReceiptState, FAUCET_ABI } = await import('../src/faucet.js');
  const { encodeAbiParameters, toEventSelector } = await import('viem');
  const { TESTNET_97 } = await import('../src/testnet-profile.js');
  const { claim } = harness();
  const topics = (to: Address, by: Address): [Hex, Hex, Hex] => [toEventSelector('Claimed(address,uint256,address)'), encodeAbiParameters([{ type: 'address' }], [to]), encodeAbiParameters([{ type: 'address' }], [by])];
  const log: TransactionReceipt['logs'][number] = { address: TESTNET_97.contracts.usdt, data: encodeAbiParameters([{ type: 'uint256' }], [claim.amountWei]),
    topics: topics(account, TESTNET_97.roles.operator),
    blockHash: hash, blockNumber: 1n, logIndex: 0, transactionHash: hash, transactionIndex: 0, removed: false };
  assert.equal(faucetReceiptState({ status: 'success', logs: [log] }, claim, TESTNET_97.roles.operator), 'confirmed');
  assert.equal(faucetReceiptState({ status: 'reverted', logs: [] }, claim, TESTNET_97.roles.operator), 'failed');
  assert.equal(faucetReceiptState({ status: 'success', logs: [] }, claim, TESTNET_97.roles.operator), 'unknown');
  const changedLogs: TransactionReceipt['logs'] = [{ ...log, address: owner }, { ...log, data: '0x' as const }, { ...log, data: encodeAbiParameters([{ type: 'uint256' }], [claim.amountWei + 1n]) },
    { ...log, topics: topics(owner, TESTNET_97.roles.operator) },
    { ...log, topics: topics(account, owner) }];
  for (const changed of changedLogs) {
    assert.equal(faucetReceiptState({ status: 'success', logs: [changed] }, claim, TESTNET_97.roles.operator), 'unknown');
  }
});
