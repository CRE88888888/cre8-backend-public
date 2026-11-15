import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, test } from 'node:test';
import { encodeCallDataEpV07 } from '@zerodev/sdk';
import { bytesToHex, encodeFunctionData } from 'viem';
import { closePool, query } from '../src/db.js';
import { createPaymasterService } from '../src/paymaster.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
import { YIELD_EXECUTOR_ABI } from '../src/yield-abi.js';
import { config, operation, OWNER, TEST_SIGNER, NOW } from './fixtures/paymaster.js';
after(closePool);

test('#85 supply uses the existing 60/day account cap; exhausted ordinary quotas still permit a pure withdraw, site caps remain', async () => {
  const sender = bytesToHex(randomBytes(20));
  const c = config({ CHAIN_ID: '97', RPC_URL: 'http://127.0.0.1:8592', PAYMASTER_SIGNER_PRIVATE_KEY: TEST_SIGNER });
  const service = createPaymasterService({ config: c, now: () => NOW,
    query: async () => ({ rows: [{ owner: OWNER, user_id: OWNER }] }), checkChain: async () => {},
    readBudgetContext: async () => ({ purpose: 'ordinary', nativePrice: 1n, priceSource: 'test:yield-85' }) });
  const op = async (nonce: bigint, kind: 'executeSupply' | 'executeWithdraw' = 'executeSupply') => operation({ sender, nonce,
    callData: await encodeCallDataEpV07([{ to: c.executor, value: 0n, data: encodeFunctionData({ abi: YIELD_EXECUTOR_ABI,
      functionName: kind, args: [sender, T.yieldMarkets[0].marketId, 1n, 1n, BigInt(NOW + 300)] }) }]) });
  try {
    assert.equal(c.accountDailyCount, 60n);
    for (let i = 0n; i < 60n; i++) await service.sponsor({ userOperation: await op(i) }, OWNER);
    await assert.rejects(service.sponsor({ userOperation: await op(60n) }, OWNER), /PAYMASTER_QUOTA_EXCEEDED/);
    await service.sponsor({ userOperation: await op(60n, 'executeWithdraw') }, OWNER);
    const usage = await query<{ n: string; exits: string }>("select count(*)::text as n,count(*) filter(where purpose='exit')::text as exits from gas_budget_reservations where chain_id=97 and account=$1", [sender]);
    assert.equal(usage.rows[0]?.n, '61'); assert.equal(usage.rows[0]?.exits, '1');
    const capped = createPaymasterService({ config: { ...c, siteDailyGas: 0n }, now: () => NOW,
      query: async () => ({ rows: [{ owner: OWNER, user_id: OWNER }] }), checkChain: async () => {},
      readBudgetContext: async () => ({ purpose: 'ordinary', nativePrice: 1n, priceSource: 'test:yield-85' }) });
    await assert.rejects(capped.sponsor({ userOperation: await op(61n, 'executeWithdraw') }, OWNER), /PAYMASTER_QUOTA_EXCEEDED/);
  } finally {
    await query('delete from paymaster_sponsorships where sender=$1 and chain_id=97', [sender]);
  }
});
