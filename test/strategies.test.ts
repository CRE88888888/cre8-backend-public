import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { closePool, migrate, query } from '../src/db.js';
import { NotFoundError, ValidationError } from '../src/errors.js';
import {
  createStrategy,
  getStrategy,
  listStrategies,
  publishVersion,
  validateAllocation,
  validateCreateStrategyInput,
  validateSchedule,
} from '../src/strategies.js';

const ASSET_A = '0x00000000000000000000000000000000000000a1';
const ASSET_B = '0x00000000000000000000000000000000000000b2';

/** DB-backed tests only run when DATABASE_URL is present; otherwise node:test reports them as skipped. */
const skipDb: boolean | string = process.env.DATABASE_URL
  ? false
  : 'DATABASE_URL is not set';

function expectValidationError(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Allocation weights
// ---------------------------------------------------------------------------

test('validateAllocation accepts weights that sum to 10000 and normalises addresses', () => {
  const allocation = validateAllocation({
    assets: [
      { address: `0x${'0'.repeat(36)}ABCD`, symbol: ' AAPLB ', weightBps: 6000 },
      { address: ASSET_B, weightBps: 4000 },
    ],
  });

  assert.equal(allocation.assets.length, 2);
  assert.deepEqual(allocation.assets[0], {
    address: `0x${'0'.repeat(36)}abcd`,
    symbol: 'AAPLB',
    weightBps: 6000,
  });
  assert.equal(allocation.assets[1]?.symbol, undefined);
});

test('validateAllocation rejects weights that do not sum to 10000', () => {
  expectValidationError(
    () =>
      validateAllocation({
        assets: [
          { address: ASSET_A, weightBps: 9999 },
        ],
      }),
    'WEIGHT_SUM',
  );
});

test('validateAllocation rejects an empty asset list', () => {
  expectValidationError(() => validateAllocation({ assets: [] }), 'ALLOCATION_EMPTY');
});

test('validateAllocation rejects weights outside 1..10000 (including zero and fractions)', () => {
  for (const weightBps of [0, 12.5, 10_001, -100]) {
    expectValidationError(
      () => validateAllocation({ assets: [{ address: ASSET_A, weightBps }] }),
      'WEIGHT_OUT_OF_RANGE',
    );
  }
});

test('validateAllocation rejects a duplicate asset regardless of address casing', () => {
  expectValidationError(
    () =>
      validateAllocation({
        assets: [
          { address: `0x${'0'.repeat(36)}ABCD`, weightBps: 5000 },
          { address: `0x${'0'.repeat(36)}abcd`, weightBps: 5000 },
        ],
      }),
    'DUPLICATE_ASSET',
  );
});

test('validateAllocation enforces the 16-asset ceiling', () => {
  const assets = Array.from({ length: 17 }, (_, index) => ({
    address: `0x${index.toString(16).padStart(40, '0')}`,
    weightBps: 1,
  }));
  expectValidationError(() => validateAllocation({ assets }), 'TOO_MANY_ASSETS');
});

test('validateAllocation rejects malformed addresses and non-object payloads', () => {
  expectValidationError(
    () => validateAllocation({ assets: [{ address: '0x123', weightBps: 10_000 }] }),
    'INVALID_ASSET',
  );
  for (const bad of [null, 'allocation', [], { assets: 'nope' }]) {
    expectValidationError(() => validateAllocation(bad), 'INVALID_ALLOCATION');
  }
});

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

test('validateSchedule accepts interval and cron schedules', () => {
  assert.deepEqual(validateSchedule({ kind: 'interval', intervalSeconds: 86_400 }), {
    kind: 'interval',
    intervalSeconds: 86_400,
  });
  assert.deepEqual(validateSchedule({ kind: 'cron', cron: ' 0 0 * * * ' }), {
    kind: 'cron',
    cron: '0 0 * * *',
  });
});

test('validateSchedule rejects unknown kinds, sub-minute intervals and empty cron', () => {
  for (const bad of [
    { kind: 'daily' },
    { kind: 'interval', intervalSeconds: 30 },
    { kind: 'interval', intervalSeconds: 1.5 },
    { kind: 'cron', cron: '   ' },
    null,
  ]) {
    expectValidationError(() => validateSchedule(bad), 'INVALID_SCHEDULE');
  }
});

// ---------------------------------------------------------------------------
// Strategy metadata
// ---------------------------------------------------------------------------

test('validateCreateStrategyInput applies defaults and trims strings', () => {
  const input = validateCreateStrategyInput({ provider: ' 0xprovider ', name: ' Index 500 ' });
  assert.deepEqual(input, {
    provider: '0xprovider',
    name: 'Index 500',
    description: '',
    isPublic: true,
    swapFeeBps: 0,
  });
});

test('validateCreateStrategyInput rejects bad fees, names and booleans', () => {
  const base = { provider: '0xprovider', name: 'Index 500' };
  for (const swapFeeBps of [-1, 301, 1.5]) {
    expectValidationError(
      () => validateCreateStrategyInput({ ...base, swapFeeBps }),
      'INVALID_SWAP_FEE',
    );
  }
  expectValidationError(() => validateCreateStrategyInput({ ...base, name: '   ' }), 'INVALID_STRATEGY');
  expectValidationError(
    () => validateCreateStrategyInput({ ...base, isPublic: 'yes' }),
    'INVALID_STRATEGY',
  );
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test('loadConfig requires DATABASE_URL and defaults to chain 56 / port 8080', () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL is required/);

  const config = loadConfig({ DATABASE_URL: 'postgres://localhost/cre8' });
  assert.equal(config.chainId, 56);
  assert.equal(config.port, 8080);
  assert.equal(config.rpcUrl, null);

  const custom = loadConfig({
    DATABASE_URL: 'postgres://localhost/cre8',
    PORT: '9090',
    CHAIN_ID: '97',
    RPC_URL: ' https://rpc.example ',
  });
  assert.deepEqual(custom, {
    databaseUrl: 'postgres://localhost/cre8',
    port: 9090,
    chainId: 97,
    rpcUrl: 'https://rpc.example',
  });

  assert.throws(() => loadConfig({ DATABASE_URL: 'postgres://localhost/cre8', PORT: 'abc' }), /PORT/);
});

// ---------------------------------------------------------------------------
// DB integration (gated on DATABASE_URL)
// ---------------------------------------------------------------------------

after(async () => {
  await closePool();
});

test('DB: migrate records 0001_init.sql', { skip: skipDb }, async () => {
  await migrate();
  const { rows } = await query<{ filename: string }>(
    "select filename from schema_migrations where filename = '0001_init.sql'",
  );
  assert.equal(rows.length, 1);
});

test('DB: strategy and version round trip', { skip: skipDb }, async () => {
  const name = `it-strategy-${randomUUID()}`;
  const strategy = await createStrategy({
    provider: 'it-provider',
    name,
    description: 'integration test',
    isPublic: false,
    swapFeeBps: 25,
  });

  try {
    assert.equal(strategy.name, name);
    assert.equal(strategy.swapFeeBps, 25);

    const empty = await getStrategy(strategy.id);
    assert.deepEqual(empty.versions, []);

    const first = await publishVersion(strategy.id, {
      allocation: {
        assets: [
          { address: ASSET_A, symbol: 'AAPLB', weightBps: 7000 },
          { address: ASSET_B, weightBps: 3000 },
        ],
      },
      schedule: { kind: 'interval', intervalSeconds: 86_400 },
      changeLog: 'initial weights',
    });
    assert.equal(first.version, 1);
    assert.equal(first.activeAt !== null, true);

    const second = await publishVersion(strategy.id, {
      allocation: { assets: [{ address: ASSET_A, weightBps: 10_000 }] },
      schedule: { kind: 'cron', cron: '0 0 * * *' },
    });
    assert.equal(second.version, 2);

    const detail = await getStrategy(strategy.id);
    assert.equal(detail.versions.length, 2);
    assert.equal(detail.versions[0]?.version, 2);

    const page = await listStrategies({ provider: 'it-provider', isPublic: false, limit: 100 });
    assert.ok(page.items.some((item) => item.id === strategy.id));

    await assert.rejects(
      publishVersion(strategy.id, {
        allocation: { assets: [{ address: ASSET_A, weightBps: 9_999 }] },
        schedule: { kind: 'interval', intervalSeconds: 3_600 },
      }),
      (err: unknown) => err instanceof ValidationError && err.code === 'WEIGHT_SUM',
    );

    await assert.rejects(
      publishVersion(strategy.id + 1_000_000, {
        allocation: { assets: [{ address: ASSET_A, weightBps: 10_000 }] },
        schedule: { kind: 'interval', intervalSeconds: 3_600 },
      }),
      (err: unknown) => err instanceof NotFoundError,
    );
  } finally {
    await query('delete from strategies where id = $1', [strategy.id]);
  }
});
