import assert from 'node:assert/strict';
import { ContractFunctionRevertedError, createPublicClient, custom, decodeFunctionData, encodeErrorResult, encodeFunctionResult, getAddress, isHex, parseAbi, zeroAddress } from 'viem';
import type { Address } from 'viem';
import { PRICE_SOURCE_ABI } from '../../src/chain.js';

export const ASSET = getAddress('0x0000000000000000000000000000000000000011');
export const CASH = getAddress('0x0000000000000000000000000000000000000012');
export const SOURCE = getAddress('0x0000000000000000000000000000000000000013');
export const ASSET_FEED = getAddress('0x0000000000000000000000000000000000000014');
export const CASH_FEED = getAddress('0x0000000000000000000000000000000000000015');
export const ORACLE = getAddress('0x0000000000000000000000000000000000000016');

const HARDENING_ABI = parseAbi(['error TwapUnavailable()', 'function numeraireMaxAge() view returns(uint32)', 'function symbol() view returns(string)']);
export function twapRevert() {
  return new ContractFunctionRevertedError({ abi: HARDENING_ABI, functionName: 'previewSwap',
    data: encodeErrorResult({ abi: HARDENING_ABI, errorName: 'TwapUnavailable' }) });
}

export function secondaryRevert(code: 'StaleFeed' | 'InvalidAnswer' | 'SourcesDisagree', value = 100n) {
  const data = code === 'SourcesDisagree'
    ? encodeErrorResult({ abi: PRICE_SOURCE_ABI, errorName: code, args: [ASSET, value, 10000n] })
    : code === 'StaleFeed' ? encodeErrorResult({ abi: PRICE_SOURCE_ABI, errorName: code, args: [ASSET_FEED, value] })
    : encodeErrorResult({ abi: PRICE_SOURCE_ABI, errorName: code, args: [ASSET_FEED, value] });
  return new ContractFunctionRevertedError({ abi: PRICE_SOURCE_ABI, functionName: 'previewSwap', data });
}

export function secondaryFixture() {
  const state: { timestamp: bigint; source: Address; maxAge: number; numeraireMaxAge: number; symbol: string; decimals: number; quoted: bigint; minimum: bigint; assetAt: bigint; cashAt: bigint;
    assetAnswer: bigint; cashAnswer: bigint; fail: string; quoteError: Error | null; calls: { name: string; block: unknown }[] } = {
    timestamp: 1000n, source: SOURCE, maxAge: 60, numeraireMaxAge: 60, symbol: 'TEST', decimals: 18, quoted: 10000n, minimum: 9900n, assetAt: 940n, cashAt: 940n,
    assetAnswer: 100000000n, cashAnswer: 100000000n, fail: '', quoteError: null, calls: [],
  };
  const client = createPublicClient({ transport: custom({ request: async ({ method, params }) => {
    if (state.fail === method) throw new Error('RPC timeout private-token');
    if (method === 'eth_getBlockByNumber') return { number: '0x2a', timestamp: `0x${state.timestamp.toString(16)}`, transactions: [] };
    assert.equal(method, 'eth_call'); assert.ok(Array.isArray(params));
    const call: unknown = params[0]; assert.ok(typeof call === 'object' && call !== null);
    const data: unknown = Reflect.get(call, 'data'); assert.ok(typeof data === 'string' && isHex(data));
    const decoded = decodeFunctionData({ abi: [...PRICE_SOURCE_ABI, ...HARDENING_ABI], data });
    state.calls.push({ name: decoded.functionName, block: params[1] });
    if (state.fail === decoded.functionName) throw new Error('RPC timeout private-token');
    switch (decoded.functionName) {
      case 'secondaryOf': return encodeFunctionResult({ abi: PRICE_SOURCE_ABI, functionName: 'secondaryOf', result: [decoded.args[0].toLowerCase() === ASSET.toLowerCase() ? state.source : zeroAddress, 100] });
      case 'numeraire': return encodeFunctionResult({ abi: PRICE_SOURCE_ABI, functionName: 'numeraire', result: CASH });
      case 'assetFeed': case 'numeraireFeed': return encodeFunctionResult({ abi: PRICE_SOURCE_ABI, functionName: decoded.functionName, result: decoded.functionName === 'assetFeed' ? ASSET_FEED : CASH_FEED });
      case 'maxAge': return encodeFunctionResult({ abi: PRICE_SOURCE_ABI, functionName: 'maxAge', result: state.maxAge });
      case 'numeraireMaxAge': return encodeFunctionResult({ abi: HARDENING_ABI, functionName: 'numeraireMaxAge', result: state.numeraireMaxAge });
      case 'symbol': return encodeFunctionResult({ abi: HARDENING_ABI, functionName: 'symbol', result: state.symbol });
      case 'decimals': return encodeFunctionResult({ abi: PRICE_SOURCE_ABI, functionName: 'decimals', result: state.decimals });
      case 'latestRoundData': {
        const isAsset = String(Reflect.get(call, 'to')).toLowerCase() === ASSET_FEED.toLowerCase();
        return encodeFunctionResult({ abi: PRICE_SOURCE_ABI, functionName: 'latestRoundData', result: [1n, isAsset ? state.assetAnswer : state.cashAnswer, 0n, isAsset ? state.assetAt : state.cashAt, 1n] });
      }
      case 'previewSwap':
        if (state.quoteError !== null) throw new Error('RPC private-token', { cause: state.quoteError });
        return encodeFunctionResult({ abi: PRICE_SOURCE_ABI, functionName: 'previewSwap', result: [state.quoted, state.minimum] });
    }
  } }, { retryCount: 0 }) });
  return { state, client };
}
