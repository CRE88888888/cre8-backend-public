import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import pg from 'pg';
import { closePool } from '../src/db.js';
import { loadGasFaucetConfig } from '../src/config.js';
import { createGasFaucetService } from '../src/gas-faucet.js';

after(closePool);
test('#149 gas faucet uses the real shared relayer lock; DB contention consumes no attempt, then retry succeeds', async () => {
  const config = loadGasFaucetConfig({ CHAIN_ID: '97', GAS_FAUCET_ENABLED: '1' }); assert.ok(config);
  const blocker = new pg.Client({ connectionString: process.env.DATABASE_URL });
  let sent = 0;
  const hash = `0x${'49'.repeat(32)}` as const;
  const service = createGasFaucetService({ config, chain: () => ({ chainId: async () => 97, balance: async () => 0n,
    prepare: async () => ({ hash, broadcast: async () => { sent++; }, receipt: async () => ({ status: 'success', transactionHash: hash }) }),
  }) });
  await blocker.connect();
  try {
    await blocker.query("select pg_advisory_lock(hashtextextended('backend:relayer:97',0))");
    await assert.rejects(service.claim({}, '0x1000000000000000000000000000000000000149'), { code: 'GAS_FAUCET_UNAVAILABLE' });
    assert.equal(sent, 0);
    await blocker.query("select pg_advisory_unlock(hashtextextended('backend:relayer:97',0))");
    assert.deepEqual(await service.claim({}, '0x1000000000000000000000000000000000000149'), { txHash: hash, amountWei: String(config.targetWei) });
    assert.equal(sent, 1);
  } finally { await blocker.end(); }
});
