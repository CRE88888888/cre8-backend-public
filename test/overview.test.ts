import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOverview, type OverviewDeps } from '../src/overview.js';
import { AppError } from '../src/errors.js';

const W = '0x00000000000000000000000000000000000000aa';
const list: Awaited<ReturnType<OverviewDeps['listPortfolios']>> = [
  { id: 1, strategyId: 10, strategyName: 'Fund', smartAccounts: [{ address: '0x01' }] },
  { id: 6, strategyId: 60, strategyName: 'CRE8 mix', smartAccounts: [{ address: '0x06' }] },
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function deps(over: Partial<OverviewDeps> = {}) {
  const calls = { status: 0 };
  let clock = 1_000_000;
  const d: OverviewDeps = {
    listPortfolios: async () => list,
    status: async (id) => { calls.status += 1; if (id === 6) throw new AppError(503, 'MIX_UNAVAILABLE', 'later'); return { totalUsdE8: '123400000000', holdings: [], unpriced: [] }; },
    strategyEarn: async (id) => { if (id === 6) throw new AppError(409, 'NOT_A_FUND', 'mix'); return { status: 'on', earnNetUsd: '-5000000000000000000', positions: [] }; },
    cashEarn: async () => ({ status: 'ok', cashEarn: { positions: [] } }),
    walletUsdt: async () => 4800n * 10n ** 18n,
    now: () => clock, warmEveryMs: 0, firstWaitMs: 50, freshMs: 60_000,
    log: () => {},
    ...over,
  };
  return { d, calls, tick: (ms: number) => { clock += ms; } };
}

test('#216 overview: one broken holding does not sink the others; mixes have no strategy earn; cash and earn ride along', async () => {
  const { d } = deps();
  const o = createOverview(d).overview;
  const r = await o(W);
  const fund = r.portfolios.find((p) => p.id === 1)!, mix = r.portfolios.find((p) => p.id === 6)!;
  assert.equal(fund.state, 'ok'); assert.equal(fund.totalUsdE8, '123400000000'); assert.equal(fund.earnNetUsd, '-5000000000000000000');
  assert.equal(mix.state, 'unavailable'); assert.equal(mix.error?.code, 'MIX_UNAVAILABLE'); assert.equal(mix.totalUsdE8, null);
  assert.equal(mix.strategyEarn, null); assert.equal(mix.earnNetUsd, null);
  assert.equal(r.cash.value?.usdtWei, (4800n * 10n ** 18n).toString()); assert.equal(r.earn.state, 'ok');
});

test('#216 overview answers from the snapshot without re-reading the chain while fresh; stale values stay visible while refreshing', async () => {
  let slow = false;
  const { d, calls, tick } = deps({ status: async () => { calls.status += 1; if (slow) await sleep(200); return { totalUsdE8: slow ? '200' : '100', holdings: [], unpriced: [] }; } });
  const o = createOverview({ ...d, listPortfolios: async () => [list[0]!] }).overview;
  await o(W); await o(W);
  assert.equal(calls.status, 1);
  tick(61_000); slow = true;
  const started = Date.now();
  const r = await o(W);
  assert.ok(Date.now() - started < 150, 'stale read must not wait for the chain');
  assert.equal(r.portfolios[0]!.totalUsdE8, '100'); assert.equal(r.portfolios[0]!.refreshing, true);
  await sleep(250);
  assert.equal((await o(W)).portfolios[0]!.totalUsdE8, '200');
});

test('#216 overview: first read waits only briefly then reports pending; a failed refresh keeps the last good value', async () => {
  let fail = false;
  const { d, tick } = deps({ status: async () => { await sleep(120); if (fail) throw new AppError(503, 'STATUS_UNAVAILABLE', 'rpc'); return { totalUsdE8: '100', holdings: [], unpriced: [] }; } });
  const o = createOverview({ ...d, listPortfolios: async () => [list[0]!] }).overview;
  assert.equal((await o(W)).portfolios[0]!.state, 'pending');
  await sleep(150);
  assert.equal((await o(W)).portfolios[0]!.state, 'ok');
  tick(61_000); fail = true;
  await o(W, { force: true }); await sleep(150);
  const r = (await o(W)).portfolios[0]!;
  assert.equal(r.state, 'ok'); assert.equal(r.totalUsdE8, '100'); assert.equal(r.error?.code, 'STATUS_UNAVAILABLE');
});

test('#216 overview: unknown account value falls back to the holdings sum (marked estimated), but never prices unpriced holdings as zero', async () => {
  let unpriced: unknown[] = [];
  const { d } = deps({ status: async () => ({ totalUsdE8: null, holdings: [{ usdValueE8: '150' }, { usdValueE8: '50' }], unpriced }) });
  const r = (await createOverview({ ...d, listPortfolios: async () => [list[0]!] }).overview(W)).portfolios[0]!;
  assert.equal(r.totalUsdE8, '200'); assert.equal(r.estimated, true);
  unpriced = [{ asset: '0x1' }];
  const r2 = (await createOverview({ ...d, listPortfolios: async () => [list[0]!] }).overview(W)).portfolios[0]!;
  assert.equal(r2.state, 'unavailable'); assert.equal(r2.error?.code, 'UNPRICED_HOLDINGS');
});

test('#216 overview: refreshes share a process-wide concurrency limit', async () => {
  let live = 0, peak = 0;
  const many = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, strategyId: 1, strategyName: null, smartAccounts: [] }));
  const { d } = deps({ concurrency: 2, firstWaitMs: 1000, strategyEarn: async () => null,
    status: async () => { live += 1; peak = Math.max(peak, live); await sleep(10); live -= 1; return { totalUsdE8: '1', holdings: [], unpriced: [] }; } });
  const r = await createOverview({ ...d, listPortfolios: async () => many, cashEarn: async () => null, walletUsdt: async () => 0n }).overview(W);
  assert.ok(peak <= 2, `peak ${peak}`);
  assert.ok(r.portfolios.every((p) => p.state === 'ok'));
});

test('a refresh that never finishes times out, shows unavailable with TIMEOUT and frees its slot for the others', async () => {
  const lines: string[] = [];
  const many = [1, 2, 3, 4].map((id) => ({ id, strategyId: id, strategyName: `F${id}`, smartAccounts: [{ address: `0x0${id}` }] }));
  const { d } = deps({
    listPortfolios: async () => many,
    // 1–3 hang forever (like the three stuck portfolios); 4 answers. Concurrency 3 means 4 only runs once a slot frees.
    status: (id) => id === 4 ? Promise.resolve({ totalUsdE8: '100', holdings: [], unpriced: [] }) : new Promise(() => {}),
    strategyEarn: async () => null,
    loadTimeoutMs: 40, firstWaitMs: 10, concurrency: 3, now: () => Date.now(),
    log: (line) => lines.push(line),
  });
  const o = createOverview(d).overview;
  await o(W);
  await sleep(150);
  const r = await o(W);
  for (const id of [1, 2, 3]) {
    const p = r.portfolios.find((x) => x.id === id)!;
    assert.equal(p.state, 'unavailable', `portfolio ${id}`);
    assert.equal(p.error?.code, 'TIMEOUT');
  }
  assert.equal(r.portfolios.find((x) => x.id === 4)?.state, 'ok', 'the fourth item got a slot');
  assert.ok(lines.some((line) => line.includes('"code":"TIMEOUT"') && line.includes('"cause"')));
});
