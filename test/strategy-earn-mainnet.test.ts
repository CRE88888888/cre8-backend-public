import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AAVE_POOL_56, createMainnetRates, LISTA_MAIN_USDT_MARKET, mainnetQuote, USDT_56, VUSDT_56 } from '../src/strategy-earn-mainnet.js';
import { createStrategyEarn } from '../src/strategy-earn.js';

// Shapes copied from the live APIs (2026-11-24): Venus core pool, Lista Moolah markets / vaults, Aave getReserveData.
const ray = (fraction: number) => BigInt(Math.round(fraction * 1e9)) * 10n ** 18n;
function fakeFetch(opts: { venusFails?: boolean; calls?: string[] } = {}) {
  return async (url: string, init?: RequestInit) => {
    opts.calls?.push(url);
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes('api.venus.io')) {
      if (opts.venusFails) return new Response('down', { status: 503 });
      return ok({ result: [{ address: VUSDT_56.toUpperCase().replace('0X', '0x'), underlyingSymbol: 'USDT', borrowApy: '5.1546', borrowXvsApy: '0', supplyApy: '3.5337', supplyXvsApy: '0' },
        { address: '0x1', underlyingSymbol: 'NVDAB', supplyXvsApy: '0.25', borrowApy: '0', supplyApy: '0' }] });
    }
    if (url.includes('borrow/markets')) return ok({ data: { list: [{ id: LISTA_MAIN_USDT_MARKET, loan: 'USDT', collateral: 'BTCB', rate: '0.0295', borrowEmissionApy: '0' }] } });
    if (url.includes('vault/list')) return ok({ data: { list: [{ address: '0xAa', name: 'Small USDT', asset: USDT_56, apy: '0.09', emissionApy: '0', depositsUsd: '10' },
      { address: '0xBb', name: 'Gauntlet USDT Vault', asset: USDT_56, apy: '0.0321', emissionApy: '0', depositsUsd: '1639611' }] } });
    assert.ok(url.includes('publicnode'), 'Aave read goes to the public node, never RPC_URL');
    const body = JSON.parse(String(init?.body)); assert.equal(body.params[0].to, AAVE_POOL_56);
    const words = [0n, 0n, ray(0.0227), 0n, 0n].map(w => w.toString(16).padStart(64, '0')).join('');
    return ok({ result: '0x' + words });
  };
}

test('mainnet rates: Venus vUSDT, Lista main USDT market + largest USDT vault, Aave reserve; best supply venue is the vault', async () => {
  const r = await createMainnetRates({ fetch: fakeFetch() as never }).get();
  assert.ok(r);
  assert.deepEqual(r.borrow.venus && [r.borrow.venus.borrowApyBps, r.borrow.venus.incentiveBps], [515, 0]);
  assert.deepEqual(r.borrow.lista && [r.borrow.lista.borrowApyBps, r.borrow.lista.incentiveBps], [295, 0]);
  assert.equal(r.supply.lista?.supplyApyBps, 321); // largest deposits, not the highest APY
  assert.equal(r.supply.aave?.supplyApyBps, 230);
  assert.deepEqual(r.vault, { venue: 'venus', supplyApyBps: 353 });
  assert.equal(r.collateralIncentiveBps.NVDAB, 25);
  // Lista: (3.53 - 2.95) x 30% = 0.174 -> 17 bps; Venus: 5.15 > 3.53 -> negative carry, no new borrowing, 0 extra.
  assert.deepEqual(mainnetQuote(r, 'lista', 'AAPLB', 3000), { open: true, reason: null, borrowBps: 295, borrowIncentiveBps: 0, vaultBps: 353, vaultIncentiveBps: 0,
    collateralBps: 0, collateralIncentiveBps: 0, ratioBps: 3000, carryBps: 17, extraApyBps: 17 });
  const v = mainnetQuote(r, 'venus', 'NVDAB', 3000);
  assert.equal(v?.open, false); assert.equal(v?.reason, 'negative_carry'); assert.equal(v?.extraApyBps, 0);
});

test('mainnet rates are cached; a failed source keeps its last good value', async () => {
  let t = 0; const calls: string[] = [];
  const opts: { venusFails?: boolean; calls: string[] } = { calls };
  const rates = createMainnetRates({ fetch: fakeFetch(opts) as never, now: () => t });
  const first = await rates.get(); const n = calls.length;
  await rates.get(); assert.equal(calls.length, n);
  t += 11 * 60_000; opts.venusFails = true;
  await rates.get(); await new Promise(r => setTimeout(r, 10));
  const after = await rates.get();
  assert.equal(after?.borrow.venus?.borrowApyBps, first?.borrow.venus?.borrowApyBps);
});

test('GET /strategy-earn/markets carries mainnetRates and a mainnet quote per market', async () => {
  const rates = createMainnetRates({ fetch: fakeFetch() as never });
  const earn = createStrategyEarn({ chainId: 97, chain: () => { throw new Error('down'); }, mainnetRates: rates, marketsCacheMs: 0 });
  const view = await earn.markets();
  assert.equal(view.mainnetRates?.vault.venue, 'venus');
  // Chain down: no target LTV, so no per-market mainnet quote rather than a guessed ratio.
  assert.ok(view.markets.every(m => 'mainnet' in m && m.mainnet === null));
});
