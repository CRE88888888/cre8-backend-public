import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from '../src/server.js';
import { UnauthorizedError } from '../src/errors.js';
import { createPaymasterService } from '../src/paymaster.js';
import { loadRateLimitConfig } from '../src/config.js';
import { RequestRateLimiter } from '../src/ratelimit.js';
import { OWNER, operation, NOW, PM } from './fixtures/paymaster.js';

test('#66 sponsorship requires login before parsing or signing', async () => {
  const server = createServer({ auth: {
    authenticate: async () => { throw new UnauthorizedError(); },
    issueNonce: () => { throw new Error('unexpected nonce'); },
    login: async () => { throw new Error('unexpected login'); },
    logout: async () => { throw new Error('unexpected logout'); },
  } });
  await new Promise<void>((resolve) => server.listen(8094, '127.0.0.1', resolve));
  try {
    const response = await fetch('http://127.0.0.1:8094/paymaster/sponsor', { method: 'POST', body: 'invalid json' });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: { code: 'UNAUTHORIZED', message: 'authentication required' } });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('#66 authenticated sponsor response, method, disabled 503 and #59 shared request limit', async () => {
  let signed = 0;
  let disabled = false;
  const server = createServer({
    rateLimiter: new RequestRateLimiter(loadRateLimitConfig({ RATE_LIMIT_PLAN_PER_MINUTE: '2' })),
    auth: { authenticate: async () => OWNER,
      issueNonce: () => { throw new Error('unexpected nonce'); }, login: async () => { throw new Error('unexpected login'); }, logout: async () => {} },
    sponsorUserOperation: async (input, wallet) => {
      assert.equal(wallet, OWNER);
      assert.ok(typeof input === 'object' && input !== null && 'validUntil' in input && input.validUntil === NOW + 300);
      if (disabled) return createPaymasterService({ config: null }).sponsor(input, wallet);
      signed++;
      return { paymasterAndData: '0x1234', paymaster: PM, paymasterData: '0x1234', paymasterVerificationGasLimit: 100_000n,
        paymasterPostOpGasLimit: 0n, validUntil: NOW + 300, validAfter: 0, userOpHash: '0x1234' };
    },
  });
  await new Promise<void>((resolve) => server.listen(8094, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:8094/paymaster/sponsor';
  const body = JSON.stringify({ userOperation: operation(), validUntil: NOW + 300 }, (_key, value: unknown) => typeof value === 'bigint' ? '0x' + value.toString(16) : value);
  try {
    const method = await fetch(url);
    assert.equal(method.status, 405);
    assert.equal(method.headers.get('allow'), 'POST');
    const success = await fetch(url, { method: 'POST', body });
    assert.equal(success.status, 200);
    const json: unknown = await success.json();
    assert.ok(typeof json === 'object' && json !== null && 'paymasterVerificationGasLimit' in json);
    assert.equal(json.paymasterVerificationGasLimit, '0x186a0');
    disabled = true;
    assert.equal((await fetch(url, { method: 'POST', body })).status, 503);
    const limited = await fetch(url, { method: 'POST', body });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal(signed, 1);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
