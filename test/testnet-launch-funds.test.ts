import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import lineup from './fixtures/launch-lineup.json' with { type: 'json' };
import { launchFunds, planLaunch, launchSummary, executeLaunch, launchArgs, RegistrationJournal, validateLaunchSigner, LAUNCH_REBALANCE_MODE } from '../scripts/testnet-launch-funds.js';
import type { LaunchDeps } from '../scripts/testnet-launch-funds.js';
import type { StrategyDetail } from '../src/strategies.js';
import { validateAssetConfig, UINT256_MAX } from '../src/strategy-execution.js';
import { validateAllocation } from '../src/strategies.js';
import { planContribution, assetBatchBudget } from '../src/asset-plan.js';
import { assetTradeMinimumReason } from '../src/rebalance-plan.js';
import { TESTNET_97 } from '../src/testnet-profile.js';

const owner = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const funds = launchFunds(lineup);
const options = { execute: false, hideIds: [] };
const U = 10n ** 18n;
function strategy(id: number, key: string | null = null): StrategyDetail {
  return { id, provider: owner, name: '舊基金', description: '', isPublic: true, category: null,
    catalogKey: key, swapFeeBps: 0, onchainId: id, createdAt: new Date(0).toISOString(), versions: [] };
}
function fixture() {
  const state: StrategyDetail[] = [];
  const writes: string[] = [];
  const deps: LaunchDeps = {
    authorize: async () => { writes.push('authorize'); },
    create: async fund => { const s = { ...strategy(state.length + 1, fund.key), isPublic: false }; state.push(s); writes.push('create'); return s; },
    publish: async (id, fund) => { const s = state.find(s => s.id === id); assert.ok(s);
      s.versions = [{ strategyId: id, version: s.versions.length + 1, allocation: validateAllocation(fund.input.allocation, 97),
        schedule: { kind: 'funding' }, executionSchemaVersion: 2, execution: validateAssetConfig(fund.input.execution, validateAllocation(fund.input.allocation, 97), 97),
        executionChainId: 97, configHash: fund.configHash, idleYield: { enabled: false }, activeAt: new Date().toISOString(), changeLog: null, createdAt: new Date().toISOString() }]; writes.push('publish'); },
    verify: async () => { writes.push('verify'); },
    finalize: async (entries, ids) => {
      for (const { id, fund } of entries) { const s = state.find(s => s.id === id); assert.ok(s); s.catalogKey = fund.key; s.category = fund.category; s.isPublic = true; }
      for (const id of ids) { const s = state.find(s => s.id === id); assert.ok(s); s.isPublic = false; }
      writes.push('finalize');
    },
    beforeCreate: async () => {}, afterCreate: async () => {},
  };
  return { state, writes, deps };
}

test('#168 approved 21/80 lineup uses exact weights, profile addresses, hold, categories and registry minimum fee', () => {
  assert.equal(funds.length, 21);
  for (const fund of funds) {
    const source = lineup.funds.find(f => f.id === fund.key); assert.ok(source);
    const allocation = validateAllocation(fund.input.allocation, 97);
    for (const part of source.components) {
      const expected = Object.entries(TESTNET_97.assets).find(([symbol]) => symbol.toLowerCase() === part.asset_id.toLowerCase())?.[1];
      assert.ok(expected);
      const actual = allocation.assets.find(a => a.symbol === part.asset_id);
      assert.equal(actual?.weightBps, part.weight_bps);
      assert.equal(actual?.address, expected.token);
    }
    const execution = validateAssetConfig(fund.input.execution, allocation, 97);
    assert.ok(execution.assets.every(a => a.asset === execution.numeraire || a.execution?.kind === 'hold'));
    assert.equal(execution.rebalance, LAUNCH_REBALANCE_MODE);
    assert.notEqual(execution.rebalance, 'none');
    assert.ok(execution.assets.every(a => a.yield === null));
    assert.deepEqual(fund.input.idleYield, { enabled: false });
    assert.equal(fund.input.performanceFeeBps, 500);
    assert.match(fund.description, /一次買齊/);
    if (fund.category === 'leveraged') assert.match(fund.description, /高風險.*每日重設/);
  }
  for (const mutate of [
    (x: typeof lineup) => { x.funds.pop(); },
    (x: typeof lineup) => { x.funds[1]!.id = x.funds[0]!.id; },
    (x: typeof lineup) => { x.funds[0]!.components[0]!.asset_id = 'NOT-AN-ASSET'; },
    (x: typeof lineup) => { x.funds[0]!.components[0]!.weight_bps = 0; },
    (x: typeof lineup) => { x.funds[0]!.category = 'other'; },
    (x: typeof lineup) => { x.funds[1]!.name = '長'.repeat(121); },
  ]) { const bad = structuredClone(lineup); mutate(bad); assert.throws(() => launchFunds(bad)); }
  for (const bad of [null, {}, [], { schema_version: 2, funds: lineup.funds }]) assert.throws(() => launchFunds(bad));
});

test('#168 current hold path accepts all 80 components at $50 including 5% satellites; no threshold reduction needed', () => {
  for (const fund of funds) {
    const allocation = validateAllocation(fund.input.allocation, 97);
    const config = validateAssetConfig(fund.input.execution, allocation, 97);
    const planned = planContribution(50n * U, config, new Date('2026-11-20T13:00:00Z'), 3n * U / 10n, true);
    assert.ok(planned); assert.equal(planned.minimum, 50n * U);
    assert.ok(Object.values(planned.effectiveSlices).every(n => n === 1));
    assert.equal(planContribution(50n * U - 1n, config, new Date(), 0n, true), null);
    const budgets = Object.fromEntries(config.assets.filter(a => a.asset !== config.numeraire).map(a => [a.asset, (50n * U * BigInt(a.weightBps) / 10000n).toString()]));
    const final = new Set(Object.keys(budgets));
    const batch = assetBatchBudget(budgets, 3n * U / 10n, new Map([...final].map(a => [a, null])), UINT256_MAX, 16, final, true);
    assert.ok(batch); assert.deepEqual(Object.keys(batch.inputs).sort(), [...final].sort());
    assert.equal(assetTradeMinimumReason(Object.values(batch.inputs).map(BigInt), 50n * U, new Set(Object.keys(batch.inputs).map((_, i) => i)), 10n * U), null);
  }
});

test('#168 final hold inputs at 2.5 USDT and one wei below both retain existing final-remainder semantics', () => {
  const a = TESTNET_97.assets.AAPLB.token, b = TESTNET_97.assets.MSFTB.token;
  for (const satellite of [5n * U / 2n, 5n * U / 2n - 1n]) {
    const batch = assetBatchBudget({ [a]: (50n * U - satellite).toString(), [b]: satellite.toString() }, 0n,
      new Map([[a, null], [b, null]]), UINT256_MAX, 16, new Set([a, b]), true);
    assert.ok(batch); assert.equal(batch.inputs[b], satellite.toString());
  }
  assert.equal(assetBatchBudget({ [a]: (10n * U - 1n).toString() }, 0n, new Map([[a, null]]), UINT256_MAX), null, 'stack ten-USDT minimum unchanged');
});

test('#168 dry-run prints 21 planned funds without authorizing, journaling or writing', async () => {
  const f = fixture(), plan = planLaunch(funds, [], owner, options);
  const output = JSON.parse(JSON.stringify(launchSummary(plan)));
  assert.equal(output.mode, 'dry-run'); assert.equal(output.funds.length, 21); assert.equal(output.funds[0].action, 'create');
  await executeLaunch(plan, options, f.deps); assert.deepEqual(f.writes, []);
  assert.equal(launchArgs([]).execute, false);
  for (const args of [['--execute', '--execute'], ['--private-key', 'secret'], ['--mag7-id', '0'], ['--hide-ids', '1,0'], ['--lineup']]) assert.throws(() => launchArgs(args));
});

test('#171 launch dry-run includes monthly_drift in every reviewed fund and performs no writes', async () => {
  assert.equal(LAUNCH_REBALANCE_MODE, 'monthly_drift');
  const f = fixture(), plan = planLaunch(funds, [], owner, options);
  const summary = launchSummary(plan);
  assert.equal(summary.funds.length, lineup.funds.length);
  for (const fund of summary.funds) {
    const allocation = validateAllocation(fund.input.allocation, 97);
    assert.equal(validateAssetConfig(fund.input.execution, allocation, 97).rebalance, 'monthly_drift');
  }
  assert.equal(JSON.stringify(summary).match(/"rebalance":"monthly_drift"/g)?.length, lineup.funds.length);
  await executeLaunch(plan, options, f.deps);
  assert.deepEqual(f.writes, []);
});

test('#168 successful rerun skips registrations and version publishing; Mag7 updates in place and old rows hide', async () => {
  const f = fixture();
  f.state.push(strategy(1), strategy(2));
  const selected = { execute: true, mag7Id: 1, hideIds: [2] };
  await executeLaunch(planLaunch(funds, f.state, owner, selected), selected, f.deps);
  assert.equal(f.state.length, 22); assert.equal(f.state[0]?.catalogKey, 'mag7'); assert.equal(f.state[1]?.isPublic, false);
  assert.equal(f.writes.filter(s => s === 'create').length, 20);
  assert.equal(f.writes.filter(s => s === 'publish').length, 21);
  f.writes.length = 0;
  await executeLaunch(planLaunch(funds, f.state, owner, { execute: true, hideIds: [] }), { execute: true, hideIds: [] }, f.deps);
  assert.equal(f.writes.filter(s => s === 'verify').length, 21);
  assert.equal(f.writes.filter(s => s === 'create' || s === 'publish').length, 0);
});

test('#168 foreign ownership, conflicting/missing IDs and unreviewed public inventory fail before writes', () => {
  const old = strategy(1), foreign = { ...strategy(2, 'mag7'), provider: '0x0000000000000000000000000000000000000001' };
  for (const [state, selected] of [
    [[foreign], options], [[old], options], [[old], { ...options, mag7Id: 2 }],
    [[old], { ...options, mag7Id: 1, hideIds: [1] }], [[old], { ...options, hideIds: [1, 1] }],
  ] as const) assert.throws(() => planLaunch(funds, [...state], owner, { ...selected, hideIds: [...selected.hideIds] }));
});

test('#168 authorization, RPC verification, DB and timeout errors stop later mutations and preserve partial catalogue for retry', async () => {
  for (const phase of ['authorize', 'beforeCreate', 'create', 'afterCreate', 'publish', 'finalize'] as const) {
    const f = fixture(); const failure = new Error('upstream https://rpc.invalid/SECRET token seed');
    const deps = { ...f.deps, [phase]: async () => { throw failure; } };
    await assert.rejects(executeLaunch(planLaunch(funds, [], owner, options), { ...options, execute: true }, deps), e => e === failure);
    assert.ok(!f.writes.includes('finalize'));
    if (phase === 'authorize') assert.equal(f.state.length, 0);
    if (phase === 'publish' || phase === 'afterCreate') {
      assert.equal(f.state.length, 1);
      await executeLaunch(planLaunch(funds, f.state, owner, options), { ...options, execute: true }, f.deps);
      assert.equal(f.state.length, 21);
    }
  }
  const f = fixture();
  await executeLaunch(planLaunch(funds, [], owner, options), { ...options, execute: true }, f.deps);
  f.writes.length = 0;
  await assert.rejects(executeLaunch(planLaunch(funds, f.state, owner, options), { ...options, execute: true },
    { ...f.deps, verify: async () => { throw new Error('RPC timeout'); } }), /RPC timeout/);
  assert.deepEqual(f.writes, ['authorize']);
});

test('#168 durable registration intent blocks a duplicate after an unknown result or DB failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cre8-launch-'));
  try {
    const journal = new RegistrationJournal(directory);
    await journal.before('mag7');
    await assert.rejects(journal.before('mag7'), /reconcile/);
    await journal.after('mag7', 123);
    assert.equal(JSON.parse(await readFile(join(directory, 'mag7.json'), 'utf8')).strategyId, 123);
    await assert.rejects(journal.before('mag7'), /reconcile/);
  } finally { await rm(directory, { recursive: true }); }
});

test('#168 actual signer gate rejects nonoperators and mismatched registry/operator selection', () => {
  validateLaunchSigner(owner, owner.toUpperCase(), owner, [owner]);
  const other = '0x0000000000000000000000000000000000000001';
  for (const args of [[other, owner, owner, [owner]], [owner, other, owner, [owner]], [owner, owner, other, [owner]], [owner, owner, owner, []]] as const) {
    assert.throws(() => validateLaunchSigner(args[0], args[1], args[2], args[3]), /authorized operator/);
  }
});
