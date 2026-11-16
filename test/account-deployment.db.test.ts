import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closePool, migrate, query } from '../src/db.js';
import { withRelayerLock } from '../src/relayer-lock.js';
import { AppError } from '../src/errors.js';

test('#124 direct deployment uses the existing relayer lock without a deployment schema', async () => {
  await migrate();
  try {
    assert.equal((await query<{ name: string | null }>("select to_regclass('public.account_deployments') as name")).rows[0]?.name, null);
    let entered = 0;
    assert.equal(await withRelayerLock(97, async held => {
      held(); entered++;
      await assert.rejects(withRelayerLock(97, async () => { entered++; }),
        (error: unknown) => error instanceof AppError && error.code === 'RELAYER_BUSY');
      return true;
    }), true);
    assert.equal(entered, 1);
    assert.equal(await withRelayerLock(97, async held => { held(); return true; }), true);
  } finally { await closePool(); }
});
