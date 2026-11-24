import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AAVE_POOL_56, chooseRoute, createMainnetRates, mainnetQuote, TOKENS_56 } from '../src/strategy-earn-mainnet.js';
const BTCB_USDT = '0x975f4cf3db16812d995f60e19bec91a96108d47429237acc8d208bc0519c5b19';
import type { SupplyVault } from '../src/strategy-earn-mainnet.js';
import { createStrategyEarn } from '../src/strategy-earn.js';

// Shapes copied from the live APIs (2026-11-24): Venus core pool, Lista Moolah markets (zone 5 bStock / zone 0) and vaults, Aave getReserveData.
const ray = (fraction: number) => BigInt(Math.round(fraction * 1e9)) * 10n ** 18n;
const venusMarket = (symbol: string, underlying: string, borrowApy: string, supplyApy: string) =>
  ({ address: '0x' + symbol.padEnd(40, '0').slice(0, 40), symbol, underlyingSymbol: underlying, borrowApy, borrowXvsApy: '0', supplyApy, supplyXvsApy: '0',
    liquidityCents: '974632737', isBorrowable: true, pausedActionsBitmap: 0 });
const lm = (id: string, collateral: string, loan: string, rate: string, emission: string, liquidityUsd: string, termType = 0) =>
  ({ id, collateral, loan, rate, borrowEmissionApy: emission, liquidityUsd, lltv: '0.75', termType });
function fakeFetch(opts: { venusFails?: boolean; calls?: string[]; qqqUsd1?: string; qqqUsdcLiquidity?: string } = {}) {
  return async (url: string, init?: RequestInit) => {
    opts.calls?.push(url);
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes('api.venus.io')) {
      if (opts.venusFails) return new Response('down', { status: 503 });
      return ok({ result: [venusMarket('vUSDT', 'USDT', '5.15', '3.52'), venusMarket('vUSDC', 'USDC', '4.71', '2.96'), venusMarket('vUSD1', 'USD1', '4.86', '1.70'),
        venusMarket('vU', 'U', '4.44', '2.76'), { ...venusMarket('vNVDAB', 'NVDAB', '0', '0'), supplyXvsApy: '0.25', collateralFactorMantissa: '600000000000000000', canBeCollateral: true }] });
    }
    if (url.includes('borrow/markets')) {
      const zone5 = [lm('q1', 'QQQB', 'USD1', opts.qqqUsd1 ?? '0.0182', '0.0276', '501000'), lm('q2', 'QQQB', 'USDC', '0.0117', '0.0054', opts.qqqUsdcLiquidity ?? '24000'), lm('q3', 'QQQB', 'USDT', '0.0002', '0', '0')];
      const zone0 = [lm(BTCB_USDT, 'BTCB', 'USDT', '0.0294', '0', '471000')];
      const list = url.includes('zone=5') ? zone5 : zone0;
      return ok({ data: { total: list.length, list } });
    }
    if (url.includes('vault/list')) return ok({ data: { list: [
      { address: '0xAa', name: 'Gauntlet USDT Vault', asset: TOKENS_56.USDT, apy: '0.0321', emissionApy: '0', depositsUsd: '1639611' },
      { address: '0xBb', name: 'Saturn USDT', asset: TOKENS_56.USDT, apy: '0.0022', emissionApy: '0.1215', depositsUsd: '1442780' }, // campaign-driven: left out
      { address: '0xCc', name: 'Lista USDC Vault', asset: TOKENS_56.USDC, apy: '0.0141', emissionApy: '0.0354', depositsUsd: '3988352' },
      { address: '0xDd', name: 'Solv-Exclusive USD1 Vault', asset: TOKENS_56.USD1, apy: '0.1563', emissionApy: '0', depositsUsd: '17270' }] } });
    assert.ok(url.includes('publicnode'), 'Aave read goes to the public node, never RPC_URL');
    const body = JSON.parse(String(init?.body)); assert.equal(body.params[0].to, AAVE_POOL_56);
    const data: string = body.params[0].data;
    const rate = data.endsWith(TOKENS_56.USDC.slice(2)) ? 0.0326 : data.endsWith(TOKENS_56.USDT.slice(2)) ? 0.0227 : 0; // USD1 / U not on Aave
    return ok({ result: '0x' + [0n, 0n, ray(rate), 0n, 0n].map(w => w.toString(16).padStart(64, '0')).join('') });
  };
}
const markets = [{ symbol: 'QQQB', protocol: 'lista' as const }, { symbol: 'NVDAB', protocol: 'venus' as const }, { symbol: 'AAPLB', protocol: 'lista' as const }];

test('mainnet rates: best realistic vault per stable (incentives at face value, campaign / exclusive / small vaults left out)', async () => {
  const r = await createMainnetRates({ fetch: fakeFetch() as never, markets }).get();
  assert.ok(r);
  assert.deepEqual(Object.fromEntries(Object.entries(r.vaults).map(([k, v]) => [k, [v.venue, v.apyBps]])),
    { USDT: ['venus', 352], USDC: ['lista', 495], USD1: ['venus', 170], U: ['venus', 276] });
  assert.equal(r.collateralIncentiveBps.NVDAB, 25);
});

test('route per asset: every venue × stable, ratio = min(tier cap, F/2) per market, highest extra wins; no usable market -> no route', async () => {
  const r = await createMainnetRates({ fetch: fakeFetch() as never, markets }).get();
  assert.ok(r);
  // QQQB (index, cap 35%, LLTV 75% -> 35%): USD1 (1.70 + 0.94) x 35% = 0.92 vs USDC (4.95 - 0.63) x 35% = 1.51 ($24k, limited) -> USDC
  const q = r.routes.QQQB;
  assert.deepEqual(q && [q.venue, q.loan, q.ratioBps, q.limited, q.extraBps], ['lista', 'USDC', 3500, true, 151]);
  // NVDAB: listed on Venus (CF 60% -> 30%); only Venus USDC has positive carry (4.95 - 4.71) x 30% + 0.25 XVS supply incentive
  const n = r.routes.NVDAB;
  assert.deepEqual(n && [n.venue, n.loan, n.ratioBps, n.extraBps], ['venus', 'USDC', 3000, 7 + 25]);
  assert.equal(r.routes.AAPLB, undefined); // no usable AAPLB market anywhere: no route, nothing hard-coded to fall back to
  const quote = mainnetQuote(r, 'venus', 'QQQB', 1234); // chain-97 venue and ratio are ignored
  assert.deepEqual(quote && [quote.venue, quote.ratioBps, quote.carryBps, quote.extraApyBps, quote.loan], ['lista', 3500, 151, 151, 'USDC']);
});

test('Lista beats Venus when its market is cheaper (NVDAB on mainnet: Lista USDC with LISTA incentive)', () => {
  const usdc: SupplyVault = { token: 'USDC', venue: 'lista', name: 'Lista USDC Vault', address: '0x1', apyBps: 498, baseBps: 144, incentiveBps: 354, tvlUsd: 4e6 };
  const route = chooseRoute({ symbol: 'NVDAB', vaults: { USDC: usdc },
    venusBorrow: { USDC: { borrowApyBps: 471, incentiveBps: 0, address: '0xv' } }, venusCollateral: { NVDAB: { factorBps: 6000, address: '0xc' } },
    listaMarkets: [{ id: '0xl', collateral: 'NVDAB', loan: 'USDC', rate: '0.0039', borrowEmissionApy: '0.0224', liquidityUsd: '14000', lltv: '0.75' }] });
  assert.deepEqual(route && [route.venue, route.loan, route.ratioBps, route.carryBps, route.extraBps, route.limited], ['lista', 'USDC', 3000, 498 + 185, 204, true]);
});

test('routing is recomputed from each rate snapshot: a cheaper market or a market that empties changes the chosen route', async () => {
  let t = 0; const opts: { qqqUsd1?: string; qqqUsdcLiquidity?: string } = {};
  const rates = createMainnetRates({ fetch: fakeFetch(opts) as never, now: () => t, markets });
  const a = await rates.get();
  assert.deepEqual(a?.routes.QQQB && [a.routes.QQQB.loan, a.routes.QQQB.marketId], ['USDC', 'q2']);
  // Next snapshot: Lista cuts the QQQB/USD1 rate to 0 (net −2.76%) and the USDC market is borrowed out.
  opts.qqqUsd1 = '0'; opts.qqqUsdcLiquidity = '500'; t += 11 * 60_000;
  await rates.get(); await new Promise(r => setTimeout(r, 10));
  const b = await rates.get();
  assert.deepEqual(b?.routes.QQQB && [b.routes.QQQB.loan, b.routes.QQQB.marketId, b.routes.QQQB.extraBps], ['USD1', 'q1', Math.trunc((170 + 276) * 3500 / 10_000)]);
});

test('paused or empty markets drop out: Venus borrow paused / no liquidity -> not a candidate', () => {
  const usdc: SupplyVault = { token: 'USDC', venue: 'lista', name: 'v', address: '0x1', apyBps: 498, baseBps: 498, incentiveBps: 0, tvlUsd: 4e6 };
  const base = { symbol: 'NVDAB', vaults: { USDC: usdc }, venusCollateral: { NVDAB: { factorBps: 6000, address: '0xc' } }, listaMarkets: [] };
  assert.equal(chooseRoute({ ...base, venusBorrow: { USDC: { borrowApyBps: 471, incentiveBps: 0, address: '0xv', liquidityUsd: 500 } } }), null);
  assert.equal(chooseRoute({ ...base, venusBorrow: {} }), null); // readVenus leaves out borrow-paused markets
});

test('negative carry stops new borrowing and counts 0', () => {
  const vault: SupplyVault = { token: 'USDT', venue: 'venus', name: 'Venus vUSDT', address: '0x1', apyBps: 352, baseBps: 352, incentiveBps: 0, tvlUsd: null };
  const route = chooseRoute({ symbol: 'NVDAB', listaMarkets: [], venusBorrow: { USDT: { borrowApyBps: 515, incentiveBps: 0, address: '0x2' } },
    venusCollateral: { NVDAB: { factorBps: 6000, address: '0x3' } }, vaults: { USDT: vault } });
  assert.equal(route?.carryBps, -163);
  const q = mainnetQuote({ chainId: 56, updatedAt: '', vaults: { USDT: vault }, routes: { NVDAB: route! }, vault: { venue: 'venus', supplyApyBps: 352 }, collateralIncentiveBps: {} }, 'venus', 'NVDAB', 3000);
  assert.deepEqual(q && [q.open, q.reason, q.extraApyBps], [false, 'negative_carry', 0]);
});

test('mainnet rates are cached; a failed source keeps its last good value', async () => {
  let t = 0; const calls: string[] = [];
  const opts: { venusFails?: boolean; calls: string[] } = { calls };
  const rates = createMainnetRates({ fetch: fakeFetch(opts) as never, now: () => t, markets });
  const first = await rates.get(); const n = calls.length;
  await rates.get(); assert.equal(calls.length, n);
  t += 11 * 60_000; opts.venusFails = true;
  await rates.get(); await new Promise(r => setTimeout(r, 10));
  const after = await rates.get();
  assert.deepEqual(after?.routes.NVDAB, first?.routes.NVDAB);
});

test('GET /strategy-earn/markets carries mainnetRates and a mainnet quote per routed asset, even with the chain-97 reads down', async () => {
  const rates = createMainnetRates({ fetch: fakeFetch() as never, markets });
  const earn = createStrategyEarn({ chainId: 97, chain: () => { throw new Error('down'); }, mainnetRates: rates, marketsCacheMs: 0 });
  const view = await earn.markets();
  assert.equal(view.mainnetRates?.vaults.USDC?.venue, 'lista');
  const byAsset = Object.fromEntries(view.markets.map(m => [m.asset, 'mainnet' in m ? m.mainnet : undefined]));
  assert.equal(byAsset.QQQB?.ratioBps, 3500); assert.equal(byAsset.NVDAB?.venue, 'venus'); assert.equal(byAsset.TSLAB, null); // TSLAB not in this fake's list
});

test('routing snapshot for the engine: every option per asset, every stable vault (filtered ones marked), per-source read times', async () => {
  let t = 1000; const opts: { venusFails?: boolean } = {};
  const rates = createMainnetRates({ fetch: fakeFetch(opts) as never, now: () => t, markets });
  const a = await rates.routing();
  assert.ok(a);
  assert.deepEqual(a.options.QQQB?.map(o => [o.venue, o.loan, o.marketId]), [['lista', 'USDC', 'q2'], ['lista', 'USD1', 'q1']]); // q3 has no liquidity
  assert.deepEqual(a.options.AAPLB, []);
  assert.deepEqual(a.options.NVDAB?.map(o => [o.venue, o.loan, o.collateralIncentiveBps]), [['venus', 'USDT', 25], ['venus', 'USDC', 25], ['venus', 'USD1', 25], ['venus', 'U', 25]]);
  assert.deepEqual(a.vaults.filter(v => v.venue === 'lista').map(v => [v.name, v.eligible]),
    [['Gauntlet USDT Vault', true], ['Saturn USDT', false], ['Lista USDC Vault', true], ['Solv-Exclusive USD1 Vault', false]]);
  assert.deepEqual(a.sourceAt, { venus: 1000, lista: 1000, aave: 1000 });
  // Venus goes down: its last values stay, but its read time does not advance, so the engine can refuse to act on it.
  t += 11 * 60_000; opts.venusFails = true;
  await rates.get(); await new Promise(r => setTimeout(r, 10));
  const b = await rates.routing();
  assert.deepEqual(b?.sourceAt, { venus: 1000, lista: t, aave: t });
});

test('portfolio view: each open position carries its route (v1 chain-97 = the simulated mainnet route the app shows), from the cache only', async () => {
  const { strategyMarkets } = await import('../src/strategy-earn.js');
  const qqq = strategyMarkets().find(m => m.symbol === 'QQQB')!, aapl = strategyMarkets().find(m => m.symbol === 'AAPLB')!;
  const st = { gate: 0, shouldDeleverage: false, shouldUnwind: false, borrowRate: 0n, collateralRate: 0n, vaultRate: 0n, collateralIncentiveRate: 0n, borrowIncentiveRate: 0n, vaultIncentiveRate: 0n,
    borrowUtilizationBps: 0n, vaultUtilizationBps: 0n, ltv: 3n * 10n ** 17n, targetLtv: 35n * 10n ** 16n, deleverageLtv: 5n * 10n ** 17n, liquidationLtv: 75n * 10n ** 16n, debt: 30n * 10n ** 18n, vaultAssets: 30n * 10n ** 18n,
    health: { collateralValue: 100n * 10n ** 18n, liquidationValue: 75n * 10n ** 18n, debtValue: 30n * 10n ** 18n, healthFactor: 25n * 10n ** 17n } };
  const chain = { head: async () => ({ number: 1n, timestamp: 1_795_400_000n }), status: async () => st, accountMarkets: async () => [qqq.marketId, aapl.marketId], collateral: async () => 10n ** 18n,
    balance: async () => 0n, price: async () => 100n * 10n ** 8n, rewards: async () => ({ vault: 0n, collateral: 0n }), policy: async () => ({ maxDebt: 0n, enabled: false }), weights: async () => [] };
  const account = '0x1000000000000000000000000000000000000005';
  const owned = (async () => ({ chainId: 97, ownerAddress: account, accountAddress: account })) as never;
  const calls: string[] = [];
  const rates = createMainnetRates({ fetch: fakeFetch({ calls }) as never, markets });
  const earn = createStrategyEarn({ chainId: 97, chain: () => chain as never, owned, mainnetRates: rates });
  // Cold cache: the portfolio request does not wait for (or start) the mainnet read; routes are simply absent.
  const cold = await earn.portfolio(3, account);
  assert.equal(calls.length, 0);
  assert.deepEqual(cold.positions.map(p => 'route' in p ? p.route : 'none'), [null, null]);
  await rates.get(); // what GET /strategy-earn/markets does
  const view = await earn.portfolio(3, account);
  const [q, a] = view.positions as { asset: string; ltvBps: number; deleverageLtvBps: number; route: Record<string, unknown> | null }[];
  assert.deepEqual([q!.asset, q!.ltvBps, q!.deleverageLtvBps], ['QQQB', 3000, 5000]);
  assert.deepEqual(q!.route, { source: 'simulated', venue: 'lista', loan: 'USDC', marketId: 'q2', borrowBps: 117, borrowIncentiveBps: 54, ratioBps: 3500, since: null,
    vault: { venue: 'lista', name: 'Lista USDC Vault', token: 'USDC', address: '0xcc', apyBps: 495 } });
  assert.equal(a!.route, null); // AAPLB has no mainnet market in this fake: no route, nothing made up
});

test('activity: route changes come from db 0069 only when a v2 deployment is configured; without one the table is never read', async () => {
  const account = '0x1000000000000000000000000000000000000005';
  const owned = (async () => ({ chainId: 97, ownerAddress: account, accountAddress: account })) as never;
  const sqls: string[] = [];
  const query = (async (sql: string) => { sqls.push(sql);
    if (sql.includes('strategy_route_events')) return { rows: [{ kind: 'migrate', asset: 'QQQB', reason: 'better_route', venue: 'venus', loan: 'USDT', vault_venue: 'aave', amount_raw: '5', collateral_raw: '7',
      tx_hash: '0x' + 'aa'.repeat(32), block_number: '9', created_at: '2026-11-24T10:00:00Z' }] };
    return { rows: [{ kind: 'open', asset: 'QQQB', amount_raw: '0', collateral_raw: '1000000000000000000', ltv_before_bps: null, ltv_after_bps: null, tx_hash: '0x' + 'bb'.repeat(32), block_number: '5', created_at: '2026-11-23T10:00:00Z' }] }; }) as never;
  const off = await createStrategyEarn({ chainId: 97, chain: () => { throw new Error('unused'); }, owned, query, v2: null }).activity(3, account);
  assert.deepEqual([off.activity.map(a => a.kind), sqls.some(s => s.includes('strategy_route_events'))], [['open'], false]);
  const v2 = { chainId: 97, executor: '0x20000000000000000000000000000000000000e2', registry: '0x20000000000000000000000000000000000000e3', venusComptroller: '0x20000000000000000000000000000000000000e4',
    moolah: '0x20000000000000000000000000000000000000e5', loanTokens: { USDT: '0x20000000000000000000000000000000000000a1' }, rewardTokens: [] } as never;
  const on = await createStrategyEarn({ chainId: 97, chain: () => { throw new Error('unused'); }, owned, query, v2 }).activity(3, account);
  assert.deepEqual(on.activity.map(a => [a.kind, a.message, 'messageZh' in a ? a.messageZh : null]), [['migrate', 'Moved QQQB to a better rate', 'QQQB 换到更好的利率'], ['open', 'Earn extra turned on for QQQB: 1 QQQB put to work.', null]]);
});
