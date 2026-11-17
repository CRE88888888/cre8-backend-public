import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGasFaucetChain, createGasFaucetService } from '../src/gas-faucet.js';
import { createServer as createHttpServer } from 'node:http';
import { keccak256, parseTransaction, recoverTransactionAddress } from 'viem';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { GasFaucetDeps } from '../src/gas-faucet.js';
import { loadConfig, loadGasFaucetConfig, loadRateLimitConfig } from '../src/config.js';
import { AppError, UnauthorizedError } from '../src/errors.js';
import { RequestRateLimiter } from '../src/ratelimit.js';
import { createServer } from '../src/server.js';

const owner = '0x1000000000000000000000000000000000000149';
const other = '0x2000000000000000000000000000000000000149';
const hash = `0x${'49'.repeat(32)}` as const;
const enabled = { CHAIN_ID: '97', GAS_FAUCET_ENABLED: '1' };
const config = loadGasFaucetConfig(enabled);
assert.ok(config);
const c = config;
const denied = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;

function harness(extra: GasFaucetDeps = {}, initialBalance = 0n) {
  const events: string[] = [];
  let balance = initialBalance;
  let clock = Date.parse('2026-11-17T23:59:59.999Z');
  const service = createGasFaucetService({ config: c, now: () => clock,
    lock: async (chainId, action) => { assert.equal(chainId, 97); events.push('lock'); return action(() => {}); },
    chain: () => ({
      chainId: async () => 97,
      balance: async address => { assert.ok(address === owner || address === other); events.push('balance'); return balance; },
      prepare: async (address, amountWei) => {
        assert.ok(address === owner || address === other);
        events.push('prepare');
        return { hash, broadcast: async () => { events.push('broadcast'); balance += amountWei; },
          receipt: async () => { events.push('receipt'); return { status: 'success', transactionHash: hash }; } };
      },
    }), ...extra,
  });
  return { service, events, balance: (value: bigint) => { balance = value; }, tomorrow: () => { clock++; } };
}

test('#149 gas faucet defaults off, chain 97 only, exact wei overrides and configuration bounds', () => {
  for (const env of [{}, { CHAIN_ID: '97' }, { ...enabled, GAS_FAUCET_ENABLED: 'true' }, { ...enabled, CHAIN_ID: '56' }, { ...enabled, CHAIN_ID: '1337' }]) {
    assert.equal(loadGasFaucetConfig(env), null);
  }
  assert.equal(c.thresholdWei, 200_000_000_000_000n);
  assert.equal(c.targetWei, 500_000_000_000_000n);
  assert.equal(c.siteDailyWei, 50_000_000_000_000_000n);
  assert.equal(loadGasFaucetConfig({ ...enabled, GAS_FAUCET_SITE_DAILY_WEI: '0' })?.siteDailyWei, 0n);
  assert.equal(loadGasFaucetConfig({ ...enabled, GAS_FAUCET_THRESHOLD_WEI: '0' })?.thresholdWei, 0n);
  const maximum = (1n << 256n) - 1n;
  assert.equal(loadGasFaucetConfig({ ...enabled, GAS_FAUCET_TARGET_WEI: String(maximum) })?.targetWei, maximum);
  for (const name of ['GAS_FAUCET_THRESHOLD_WEI', 'GAS_FAUCET_TARGET_WEI', 'GAS_FAUCET_SITE_DAILY_WEI']) {
    for (const value of ['-1', '0.1', 'NaN', '0x10', String(1n << 256n)]) {
      assert.throws(() => loadGasFaucetConfig({ ...enabled, [name]: value }));
    }
  }
  for (const target of ['0', String(c.thresholdWei), String(c.thresholdWei - 1n)]) {
    assert.throws(() => loadGasFaucetConfig({ ...enabled, GAS_FAUCET_TARGET_WEI: target }));
  }
  assert.throws(() => loadConfig({ ...enabled, DATABASE_URL: 'unused', GAS_FAUCET_TARGET_WEI: '0' }));
});

test('#149 zero and threshold-1 top up to target, equal/above threshold do nothing and do not consume quota', async () => {
  for (const balance of [0n, c.thresholdWei - 1n, c.thresholdWei, c.thresholdWei + 1n, c.targetWei]) {
    const h = harness({}, balance);
    assert.deepEqual(await h.service.claim({}, owner), balance < c.thresholdWei
      ? { txHash: hash, amountWei: String(c.targetWei - balance) } : { txHash: null, amountWei: '0' });
    assert.deepEqual(h.events, balance < c.thresholdWei
      ? ['lock', 'balance', 'prepare', 'broadcast', 'receipt', 'balance'] : ['lock', 'balance']);
    h.balance(0n);
    if (balance < c.thresholdWei) await assert.rejects(h.service.claim({}, owner), denied('GAS_FAUCET_QUOTA'));
    else assert.equal((await h.service.claim({}, owner)).txHash, hash);
  }
});

test('#149 owner budget normalizes case, is separate from other request budgets and resets exactly at UTC midnight', async () => {
  let now = Date.parse('2026-11-17T23:59:59.999Z');
  const limiter = new RequestRateLimiter(loadRateLimitConfig({}), undefined, () => now);
  await limiter.gasFaucet(owner);
  await assert.rejects(limiter.gasFaucet(owner.toUpperCase()), denied('GAS_FAUCET_QUOTA'));
  await limiter.wallet('plan', owner);
  await limiter.gasFaucet(other);
  now++;
  await limiter.gasFaucet(owner);
  const h = harness();
  await h.service.claim({}, owner); h.balance(0n);
  await assert.rejects(h.service.claim({}, owner), denied('GAS_FAUCET_QUOTA'));
  h.tomorrow();
  assert.equal((await h.service.claim({}, owner)).txHash, hash);
});

test('#149 site cap zero, amount-1, exact amount and amount+1; next UTC day has a fresh site budget', async () => {
  for (const cap of [0n, c.targetWei - 1n, c.targetWei, c.targetWei + 1n]) {
    const h = harness({ config: { ...c, siteDailyWei: cap } });
    if (cap < c.targetWei) {
      await assert.rejects(h.service.claim({}, owner), denied('GAS_FAUCET_QUOTA'));
      assert.ok(!h.events.includes('broadcast'));
    } else {
      await h.service.claim({}, owner); h.balance(0n);
      await assert.rejects(h.service.claim({}, other), denied('GAS_FAUCET_QUOTA'));
      h.tomorrow();
      assert.equal((await h.service.claim({}, other)).txHash, hash);
    }
  }
});

test('#149 parallel requests cannot overspend the site cap even with asynchronous rate limits', async () => {
  const h = harness({ config: { ...c, siteDailyWei: c.targetWei },
    limiter: { gasFaucet: async () => { await new Promise<void>(resolve => setImmediate(resolve)); } },
  });
  const results = await Promise.allSettled([h.service.claim({}, owner), h.service.claim({}, other)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  for (const result of results) if (result.status === 'rejected') assert.ok(denied('GAS_FAUCET_QUOTA')(result.reason));
  assert.equal(h.events.filter(event => event === 'broadcast').length, 1);
});

test('#149 disabled/invalid input never accesses RPC, relayer or quotas; recipient comes only from session', async () => {
  const disabled = harness({ config: null });
  await assert.rejects(disabled.service.claim({}, owner), denied('GAS_FAUCET_DISABLED'));
  assert.deepEqual(disabled.events, []);
  for (const body of [null, [], '', 0, { owner }, { account: other }, { amountWei: '1' }]) {
    const h = harness();
    await assert.rejects(h.service.claim(body, owner), denied('GAS_FAUCET_INVALID_REQUEST'));
    assert.deepEqual(h.events, []);
  }
  for (const wallet of ['invalid', `0x${'0'.repeat(40)}`]) {
    await assert.rejects(harness().service.claim({}, wallet), denied('GAS_FAUCET_INVALID_REQUEST'));
  }
});

test('#149 RPC wrong-chain, failure, missing balance and timeout; DB/lock failure and lost lock never broadcast', async () => {
  for (const mode of ['chain', 'rpc', 'balance', 'timeout', 'prepare', 'db', 'lost']) {
    let sends = 0;
    const h = harness({ config: { ...c, timeoutMs: 5 },
      lock: async (_chainId, action) => {
        if (mode === 'db') throw new Error('SECRET_DATABASE_URL');
        return action(() => { if (mode === 'lost') throw new Error('SECRET_DB_DISCONNECTED'); });
      },
      chain: () => ({ chainId: async () => mode === 'chain' ? 56 : 97,
        balance: async () => {
          if (mode === 'rpc') throw new Error('SECRET_RPC_URL');
          if (mode === 'timeout') return new Promise<never>(() => {});
          return mode === 'balance' ? -1n : 0n;
        },
        prepare: async () => {
          if (mode === 'prepare') throw new Error('SECRET_OPERATOR_KEY');
          return { hash, broadcast: async () => { sends++; }, receipt: async () => ({ status: 'success', transactionHash: hash }) };
        },
      }),
    });
    await assert.rejects(h.service.claim({}, owner), error => denied('GAS_FAUCET_UNAVAILABLE')(error) && error instanceof Error && !error.message.includes('SECRET'));
    assert.equal(sends, 0, mode);
  }
});

test('#149 preparation completing after timeout cannot broadcast; pre-send failure allows later retry', async () => {
  let attempts = 0, sends = 0;
  const h = harness({ config: { ...c, timeoutMs: 5 }, chain: () => ({ chainId: async () => 97, balance: async () => 0n,
    prepare: async () => {
      if (++attempts === 1) await new Promise(resolve => setTimeout(resolve, 15));
      return { hash, broadcast: async () => { sends++; }, receipt: async () => ({ status: 'success', transactionHash: hash }) };
    },
  }) });
  await assert.rejects(h.service.claim({}, owner), denied('GAS_FAUCET_UNAVAILABLE'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sends, 0);
  assert.equal((await h.service.claim({}, owner)).txHash, hash);
  assert.equal(sends, 1);
});

test('#149 broadcast/receipt failures, reverts, missing receipt and post-balance failure are sanitized and retain quotas', async () => {
  for (const mode of ['broadcast', 'receipt', 'timeout', 'revert', 'hash', 'post-balance']) {
    let reads = 0;
    const h = harness({ config: { ...c, timeoutMs: 5 }, chain: () => ({ chainId: async () => 97,
      balance: async () => { if (++reads === 2 && mode === 'post-balance') throw new Error('SECRET_RPC'); return 0n; },
      prepare: async () => ({ hash, broadcast: async () => { if (mode === 'broadcast') throw new Error('SECRET_RPC'); },
        receipt: async () => {
          if (mode === 'receipt') throw new Error('SECRET_RPC');
          if (mode === 'timeout') return new Promise<never>(() => {});
          return { status: mode === 'revert' ? 'reverted' : 'success', transactionHash: mode === 'hash' ? `0x${'00'.repeat(32)}` : hash };
        },
      }),
    }) });
    await assert.rejects(h.service.claim({}, owner), denied('GAS_FAUCET_UNAVAILABLE'));
    await assert.rejects(h.service.claim({}, owner), denied('GAS_FAUCET_QUOTA'));
  }
});

test('#149 HTTP method/login/body and session recipient, 200/429/503 response contract', async () => {
  let loggedIn = false;
  let body: unknown, wallet: string | undefined;
  let service = harness().service;
  const server = createServer({ auth: { authenticate: async () => { if (!loggedIn) throw new UnauthorizedError(); return owner; },
    issueNonce: () => { throw new Error('unexpected'); }, login: async () => { throw new Error('unexpected'); }, logout: async () => {} },
    claimFaucetGas: async (input, address) => { body = input; wallet = address; return service.claim(input, address); },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/faucet/gas`;
  const post = (value = '{}') => fetch(url, { method: 'POST', body: value });
  try {
    assert.equal((await fetch(url)).status, 405);
    assert.equal((await post('invalid')).status, 401);
    loggedIn = true;
    assert.equal((await post('invalid')).status, 400);
    assert.equal((await post(JSON.stringify({ account: other }))).status, 400);
    const response = await post();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { txHash: hash, amountWei: String(c.targetWei) });
    assert.deepEqual(body, {}); assert.equal(wallet, owner);
    service = harness({}, c.thresholdWei).service;
    assert.deepEqual(await (await post()).json(), { txHash: null, amountWei: '0' });
    const quotaHarness = harness(); service = quotaHarness.service;
    await post(); quotaHarness.balance(0n);
    const quota = await post(); assert.equal(quota.status, 429);
    assert.deepEqual(await quota.json(), { error: { code: 'GAS_FAUCET_QUOTA', message: 'gas faucet daily quota reached; retry next UTC day' } });
    service = harness({ config: null }).service;
    const disabled = await post(); assert.equal(disabled.status, 503);
    assert.deepEqual(await disabled.json(), { error: { code: 'GAS_FAUCET_DISABLED', message: 'gas faucet requires chain 97 and GAS_FAUCET_ENABLED=1' } });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('#149 zero threshold pauses transfers; retry after a successful refill is a no-op; process reconstruction resets memory budgets', async () => {
  const paused = harness({ config: { ...c, thresholdWei: 0n } });
  assert.deepEqual(await paused.service.claim({}, owner), { txHash: null, amountWei: '0' });
  const h = harness();
  await h.service.claim({}, owner);
  assert.deepEqual(await h.service.claim({}, owner), { txHash: null, amountWei: '0' });
  assert.equal((await harness().service.claim({}, owner)).txHash, hash);
});

test('#149 viem signs a chain-97 native transfer with the existing operator, pending nonce and exact value; no contract call', async () => {
  // Public anvil #0 key, used only against this loopback JSON-RPC fixture.
  const key = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  let mode = 'success', sent = 0, balanceReads = 0, receiptReads = 0;
  let transactionHash: Hex = hash;
  const rpc = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString());
    assert.ok(input && typeof input === 'object' && 'id' in input && 'method' in input);
    const params: unknown = 'params' in input ? input.params : [];
    assert.ok(Array.isArray(params));
    let result: unknown;
    switch (input.method) {
      case 'eth_fillTransaction':
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, error: { code: -32601, message: 'method not found' } })); return;
      case 'eth_chainId': result = mode === 'chain' ? '0x38' : '0x61'; break;
      case 'eth_getBalance':
        assert.equal(params[0], owner); balanceReads++;
        result = mode === 'missing-balance' ? '0x' : sent > 0 ? '0x1c6bf52634000' : '0x0'; break;
      case 'eth_getTransactionCount':
        assert.equal(String(params[0]).toLowerCase(), privateKeyToAccount(key).address.toLowerCase());
        assert.equal(params[1], 'pending'); result = '0x7'; break;
      case 'eth_gasPrice': case 'eth_maxPriorityFeePerGas': result = '0x1'; break;
      case 'eth_estimateGas': result = '0x5208'; break;
      case 'eth_getBlockByNumber': result = { hash, number: '0x1', timestamp: '0x1', baseFeePerGas: '0x1', gasLimit: '0x1000000', gasUsed: '0x1', transactions: [] }; break;
      case 'eth_blockNumber': result = '0x1'; break;
      case 'eth_sendRawTransaction': {
        const raw: unknown = params[0]; assert.ok(typeof raw === 'string' && /^0x02[0-9a-f]+$/.test(raw));
        const serialized = `0x02${raw.slice(4)}` as const;
        const tx = parseTransaction(serialized);
        assert.equal(tx.chainId, 97); assert.equal(tx.nonce, 7);
        assert.equal(tx.to?.toLowerCase(), owner); assert.equal(tx.value, c.targetWei);
        assert.ok(tx.data === undefined || tx.data === '0x');
        assert.equal(await recoverTransactionAddress({ serializedTransaction: serialized }), privateKeyToAccount(key).address);
        transactionHash = keccak256(serialized); sent++;
        result = mode === 'broadcast-hash' ? hash : transactionHash; break;
      }
      case 'eth_getTransactionReceipt':
        receiptReads++;
        result = { transactionHash, transactionIndex: '0x0', blockHash: hash, blockNumber: '0x1',
          from: privateKeyToAccount(key).address, to: owner, gasUsed: '0x5208', cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x1', type: '0x2',
          status: mode === 'revert' ? '0x0' : '0x1', contractAddress: null, logsBloom: `0x${'0'.repeat(512)}`, logs: [] }; break;
      default: assert.fail('unexpected RPC ' + String(input.method));
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
  });
  await new Promise<void>(resolve => rpc.listen(0, '127.0.0.1', resolve));
  const address = rpc.address(); assert.ok(address && typeof address !== 'string');
  const settings = { chainId: 97, rpcUrl: `http://127.0.0.1:${address.port}`, operatorPrivateKey: key };
  try {
    for (const next of ['success', 'chain', 'missing-balance', 'revert', 'broadcast-hash']) {
      mode = next; sent = 0; balanceReads = 0; receiptReads = 0;
      const h = harness({ config: { ...c, timeoutMs: 1_000 }, chain: configuration => createGasFaucetChain(configuration, settings) });
      if (mode === 'success') {
        const result = await h.service.claim({}, owner);
        assert.equal(result.txHash, transactionHash); assert.equal(result.amountWei, String(c.targetWei));
        assert.equal(sent, 1); assert.equal(balanceReads, 2); assert.ok(receiptReads >= 1);
      } else {
        await assert.rejects(h.service.claim({}, owner), denied('GAS_FAUCET_UNAVAILABLE'));
        assert.equal(sent, ['revert', 'broadcast-hash'].includes(mode) ? 1 : 0);
      }
    }
    for (const overrides of [{ chainId: 56 }, { rpcUrl: null }, { operatorPrivateKey: null }, { operatorPrivateKey: 'SECRET_INVALID_KEY' }]) {
      assert.throws(() => createGasFaucetChain(c, { ...settings, ...overrides }), denied('GAS_FAUCET_UNAVAILABLE'));
    }
  } finally { rpc.closeAllConnections(); await new Promise<void>(resolve => rpc.close(() => resolve())); }
});
