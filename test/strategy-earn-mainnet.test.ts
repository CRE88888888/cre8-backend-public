import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AAVE_POOL_56, chooseRoute, createMainnetRates, LISTA_MAIN_USDT_MARKET, mainnetQuote, TOKENS_56 } from '../src/strategy-earn-mainnet.js';
import type { SupplyVault } from '../src/strategy-earn-mainnet.js';
import { createStrategyEarn } from '../src/strategy-earn.js';

// Shapes copied from the live APIs (2026-11-24): Venus core pool, Lista Moolah markets (zone 5 bStock / zone 0) and vaults, Aave getReserveData.
const ray = (fraction: number) => BigInt(Math.round(fraction * 1e9)) * 10n ** 18n;
const venusMarket = (symbol: string, underlying: string, borrowApy: string, supplyApy: string) =>
  ({ address: '0x' + symbol.padEnd(40, '0').slice(0, 40), symbol, underlyingSymbol: underlying, borrowApy, borrowXvsApy: '0', supplyApy, supplyXvsApy: '0' });
const lm = (id: string, collateral: string, loan: string, rate: string, emission: string, liquidityUsd: string, termType = 0) =>
  ({ id, collateral, loan, rate, borrowEmissionApy: emission, liquidityUsd, lltv: '0.75', termType });
function fakeFetch(opts: { venusFails?: boolean; calls?: string[] } = {}) {
  return async (url: string, init?: RequestInit) => {
    opts.calls?.push(url);
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes('api.venus.io')) {
      if (opts.venusFails) return new Response('down', { status: 503 });
      return ok({ result: [venusMarket('vUSDT', 'USDT', '5.15', '3.52'), venusMarket('vUSDC', 'USDC', '4.71', '2.96'), venusMarket('vUSD1', 'USD1', '4.86', '1.70'),
        venusMarket('vU', 'U', '4.44', '2.76'), { ...venusMarket('vNVDAB', 'NVDAB', '0', '0'), supplyXvsApy: '0.25' }] });
    }
    if (url.includes('borrow/markets')) {
      const zone5 = [lm('q1', 'QQQB', 'USD1', '0.0182', '0.0276', '501000'), lm('q2', 'QQQB', 'USDC', '0.0117', '0.0054', '24000'), lm('q3', 'QQQB', 'USDT', '0.0002', '0', '0')];
      const zone0 = [lm(LISTA_MAIN_USDT_MARKET, 'BTCB', 'USDT', '0.0294', '0', '471000')];
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
    const rate = body.params[0].data.endsWith(TOKENS_56.USDC.slice(2)) ? 0.0326 : 0.0227;
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

test('route per asset: same token, highest carry among markets with ≥ $50k, else limited; Venus pooled; fallback main USDT', async () => {
  const r = await createMainnetRates({ fetch: fakeFetch() as never, markets }).get();
  assert.ok(r);
  const q = r.routes.QQQB; // USD1 net −0.94% ($501k): 1.70 + 0.94 = 2.64; USDC 4.95 − 0.63 = 4.32 but only $24k
  assert.deepEqual(q && [q.loan, q.netBorrowBps, q.limited, q.carryBps, q.cross?.deposit], ['USD1', -94, false, 264, 'USDC']);
  const n = r.routes.NVDAB; // Venus: USDC 4.95 − 4.71 = 0.24 is the only positive carry
  assert.deepEqual(n && [n.protocol, n.loan, n.carryBps, n.limited], ['venus', 'USDC', 24, false]);
  const a = r.routes.AAPLB; // no usable AAPLB market: Lista main USDT market, limited
  assert.deepEqual(a && [a.loan, a.marketId, a.limited, a.carryBps], ['USDT', LISTA_MAIN_USDT_MARKET, true, 352 - 294]);
  const quote = mainnetQuote(r, 'lista', 'QQQB', 3500);
  assert.deepEqual(quote && [quote.open, quote.carryBps, quote.extraApyBps, quote.loan, quote.vault.venue], [true, 92, 92, 'USD1', 'venus']);
  assert.equal(mainnetQuote(r, 'venus', 'QQQB', 3500), null); // a route is only used for its own protocol
});

test('negative carry stops new borrowing and counts 0', () => {
  const vault: SupplyVault = { token: 'USDT', venue: 'venus', name: 'Venus vUSDT', address: '0x1', apyBps: 352, baseBps: 352, incentiveBps: 0, tvlUsd: null };
  const route = chooseRoute({ protocol: 'venus', symbol: 'NVDAB', listaMarkets: [], venusBorrow: { USDT: { borrowApyBps: 515, incentiveBps: 0, address: '0x2' } }, vaults: { USDT: vault } });
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

test('GET /strategy-earn/markets carries mainnetRates; no target LTV (chain down) -> no per-market quote', async () => {
  const rates = createMainnetRates({ fetch: fakeFetch() as never, markets });
  const earn = createStrategyEarn({ chainId: 97, chain: () => { throw new Error('down'); }, mainnetRates: rates, marketsCacheMs: 0 });
  const view = await earn.markets();
  assert.equal(view.mainnetRates?.vaults.USDC?.venue, 'lista');
  assert.ok(view.markets.every(m => 'mainnet' in m && m.mainnet === null));
});
