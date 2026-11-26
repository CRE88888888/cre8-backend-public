import { PANCAKE_UR } from '../../src/chain.js';
import assert from 'node:assert/strict';
import { createPublicClient, custom, decodeFunctionData, encodeFunctionResult, getAddress, isHex, parseAbi } from 'viem';
import { computeDrift } from '../../src/drift.js';
import type { RebalanceDeps } from '../../src/operator.js';
import type { PortfolioPlan } from '../../src/snapshot.js';
import { TWAP_PRICE_SOURCE, NUMERAIRE_PRICE_SOURCE } from '../../src/positions.js';

export const DOGE = getAddress('0xba2ae424d960c26247dd6c32edc70b295c744c43');
export const CASH = getAddress('0x55d398326f99059ff775485246999027b3197955');
const EXECUTOR = getAddress('0x0000000000000000000000000000000000000040');
const ORACLE = getAddress('0x0000000000000000000000000000000000000041');
const REGISTRY = getAddress('0x0000000000000000000000000000000000000042');
const ABI = parseAbi([
  'function oracle() view returns(address)', 'function oracleOf(address) view returns(address)',
  'function pool() view returns(address)', 'function fee() view returns(uint24)',
  'function effectiveFeeBps(uint256) view returns(uint16)',
  'function previewSwap(address,address,uint256) view returns(uint256,uint256)',
  'function decimals() view returns(uint8)', 'function venues(address) view returns(uint8,address)',
  'function symbol() view returns(string)',
  'function getPool(address,address,uint24) view returns(address)', 'function quoteExactInput(bytes,uint256) returns(uint256,uint160[])',
]);

/** Real viem ABI encoding/decoding over an in-memory RPC; no PublicClient type assertions. */
export function sellFixture() {
  const state: { limit: string | null; fail: string; noFloor: boolean; price: bigint; quoteOffset: bigint;
    quoteErrors: Map<string, Error>;
    extraLimits: { address: string; max_leg_usdt: string | null }[];
    reads: { functionName: string; block: unknown }[]; writes: { sql: string; params: readonly unknown[] }[] } = {
    limit: '150', fail: '', noFloor: false, price: 1n, quoteOffset: 0n,
    quoteErrors: new Map(), extraLimits: [], reads: [], writes: [] };
  const publicClient = createPublicClient({ transport: custom({ request: async ({ method, params }) => {
    if (method === 'eth_getBlockByNumber') {
      if (state.fail === 'getBlock') throw new Error('RPC timeout secret-token');
      return { number: '0x7e', timestamp: '0x6b49d200', hash: `0x${'1'.repeat(64)}`, transactions: [] };
    }
    assert.equal(method, 'eth_call');
    assert.ok(Array.isArray(params));
    const call: unknown = params[0];
    assert.ok(typeof call === 'object' && call !== null);
    const data: unknown = Reflect.get(call, 'data');
    assert.ok(typeof data === 'string' && isHex(data));
    const decoded = decodeFunctionData({ abi: ABI, data });
    state.reads.push({ functionName: decoded.functionName, block: params[1] });
    if (state.fail === decoded.functionName) throw new Error('RPC timeout secret-token');
    switch (decoded.functionName) {
      case 'oracle': case 'oracleOf': case 'pool': return encodeFunctionResult({ abi: ABI, functionName: decoded.functionName, result: ORACLE });
      case 'venues': return encodeFunctionResult({ abi: ABI, functionName: 'venues', result: [1, PANCAKE_UR] });
      case 'getPool': return encodeFunctionResult({ abi: ABI, functionName: 'getPool', result: '0x0000000000000000000000000000000000000000' });
      case 'quoteExactInput': {
        const selling = decoded.args[0].slice(0, 42).toLowerCase() === DOGE.toLowerCase();
        const factor = selling ? 10n ** 10n : 1n;
        const output = decoded.args[1] * factor * state.price + state.quoteOffset;
        return encodeFunctionResult({ abi: ABI, functionName: 'quoteExactInput', result: [output, []] });
      }
      case 'fee': return encodeFunctionResult({ abi: ABI, functionName: 'fee', result: 10000 });
      case 'effectiveFeeBps': return encodeFunctionResult({ abi: ABI, functionName: 'effectiveFeeBps', result: 0 });
      case 'decimals': return encodeFunctionResult({ abi: ABI, functionName: 'decimals', result: 18 });
      case 'symbol': return encodeFunctionResult({ abi: ABI, functionName: 'symbol', result: 'DOGE' });
      case 'previewSwap': {
        const error = state.quoteErrors.get(decoded.args[0].toLowerCase());
        if (error !== undefined) throw error;
        const factor = decoded.args[0].toLowerCase() === DOGE.toLowerCase() ? 10n ** 10n : 1n;
        const quoted = decoded.args[2] * factor * state.price + state.quoteOffset;
        return encodeFunctionResult({ abi: ABI, functionName: 'previewSwap', result: [quoted, state.noFloor ? 0n : quoted * 99n / 100n] });
      }
    }
  } }) });
  const deps: RebalanceDeps = { publicClient, executor: EXECUTOR, registry: REGISTRY,
    requireOwnedPortfolio: async () => { throw new Error('test must supply an ownership fixture'); },
    query: async (sql, params = []) => {
      if (state.fail === 'DB') throw new Error('DB timeout secret-token');
      if (sql.includes('where is_numeraire')) return { rows: [{ address: CASH }] };
      if (sql.includes('max_leg_usdt')) return { rows: [{ address: DOGE, max_leg_usdt: state.limit }, ...state.extraLimits] };
      state.writes.push({ sql, params });
      return { rows: [] };
    },
  };
  const plan = (base: PortfolioPlan, dogeUsd = 200n, cashUsd = 1800n): PortfolioPlan => {
    const holdings: PortfolioPlan['snapshot']['holdings'] = [
      { asset: DOGE, amountWei: dogeUsd * 10n ** 8n, decimals: 8, usdPriceE8: 100000000n, priceSource: TWAP_PRICE_SOURCE },
      { asset: CASH, amountWei: cashUsd * 10n ** 18n, decimals: 18, usdPriceE8: 100000000n, priceSource: NUMERAIRE_PRICE_SOURCE },
    ];
    const targets = [{ asset: DOGE, weightBps: 1000, symbol: 'DOGE' }, { asset: CASH, weightBps: 9000, symbol: 'USDT' }];
    return { ...base, snapshot: { ...base.snapshot, block: 126n, holdings }, targets, report: computeDrift(holdings, targets, 100) };
  };
  return { state, deps, plan };
}
