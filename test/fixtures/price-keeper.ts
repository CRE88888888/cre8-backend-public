import assert from 'node:assert/strict';
import { custom, decodeFunctionData, encodeFunctionResult, getAddress, isHex, zeroAddress } from 'viem';
import { TESTNET_ASSETS } from '../../src/keeper/assets.js';
import { createKeeperChain, KEEPER_ABI, parseManifest, signingAccount, sqrtPriceFor } from '../../src/keeper/chain.js';

export const keeperAddress = (n: number) => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
export function manifestInput() {
  return {
    chainId: 97, roles: { keeper: signingAccount(`0x${'0'.repeat(63)}1`).address },
    contracts: { usdt: keeperAddress(1), router: keeperAddress(2), 'feed.USDT/USD': keeperAddress(3) },
    assets: Object.fromEntries(TESTNET_ASSETS.map((spec, index) => [spec.symbol, {
      token: keeperAddress(index + 10), pool: keeperAddress(index + 100), oracle: keeperAddress(index + 200),
      ...(spec.hasFeed ? { feed: keeperAddress(index + 300), secondary: keeperAddress(index + 400) } : {}),
    }])),
  };
}

export function keeperChainFixture() {
  const manifest = parseManifest(manifestInput());
  const state = { chainId: 97, fail: '', bad: '', calls: [] as { method: string; name: string; block: unknown }[], sends: 0 };
  const transport = custom({ request: async ({ method, params }) => {
    if (method === state.fail) throw new Error('secret RPC URL and key');
    if (method === 'eth_chainId') return `0x${state.chainId.toString(16)}`;
    if (method === 'eth_getBlockByNumber') return { number: '0x64', timestamp: '0x424', transactions: [] };
    if (method === 'eth_getCode') return state.bad === 'missing code' ? '0x' : '0x6000';
    if (method === 'eth_sendRawTransaction' || method === 'eth_sendTransaction') { state.sends++; assert.fail('unexpected write'); }
    assert.equal(method, 'eth_call'); assert.ok(Array.isArray(params));
    const call: unknown = params[0]; assert.ok(typeof call === 'object' && call !== null);
    const data: unknown = Reflect.get(call, 'data'); assert.ok(typeof data === 'string' && isHex(data));
    const to = String(Reflect.get(call, 'to')).toLowerCase();
    const { functionName: name, args } = decodeFunctionData({ abi: KEEPER_ABI, data });
    state.calls.push({ method, name, block: params[1] });
    if (state.fail === name) throw new Error('secret RPC URL and key');
    const index = manifest.markets.findIndex((m) => [m.token, m.pool, m.oracle, m.feed, m.secondary].some((a) => a?.toLowerCase() === to));
    const market = manifest.markets[Math.max(0, index)]; const spec = TESTNET_ASSETS[Math.max(0, index)]; assert.ok(market && spec);
    const result = (value: Parameters<typeof encodeFunctionResult<typeof KEEPER_ABI, typeof name>>[0]['result']) => encodeFunctionResult({ abi: KEEPER_ABI, functionName: name, result: value });
    switch (name) {
      case 'factory': return result(state.bad === name ? zeroAddress : getAddress('0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865'));
      case 'numeraire': return result(state.bad === name ? zeroAddress : manifest.usdt);
      case 'symbol': return result(state.bad === name ? 'wrong' : market.symbol);
      case 'decimals': return result(state.bad === name ? 19 : to === manifest.usdt.toLowerCase() ? 18 :
        to === manifest.cashFeed.toLowerCase() || to === market.feed?.toLowerCase() ? 8 : market.decimals);
      case 'isMinter': return result(state.bad !== name);
      case 'keeper': return result(state.bad === name ? zeroAddress : manifest.keeper);
      case 'getPool': case 'oracleOf': case 'secondaryOf': {
        const matched = manifest.markets.find((m) => m.token.toLowerCase() === String(args?.[0]).toLowerCase()); assert.ok(matched);
        return result(name === 'getPool' ? state.bad === name ? zeroAddress : matched.pool :
          name === 'oracleOf' ? state.bad === name ? zeroAddress : matched.oracle :
            [matched.secondary ?? zeroAddress, state.bad === name ? 201 : matched.secondary ? 200 : 0]);
      }
      case 'pool': return result(state.bad === name ? zeroAddress : market.pool);
      case 'twapWindow': return result(state.bad === name ? 1799 : 1800);
      case 'RECENT_WINDOW': return result(state.bad === name ? 299 : 300);
      case 'assetFeed': assert.ok(market.feed); return result(state.bad === name ? zeroAddress : market.feed);
      case 'numeraireFeed': return result(state.bad === name ? zeroAddress : manifest.cashFeed);
      case 'maxAge': return result(state.bad === name ? 0 : market.maxFeedAge);
      case 'slot0': return result([sqrtPriceFor(BigInt(spec.priceE18) * (state.bad === 'pool moved' ? 2n : 1n), market.decimals, true), 1, 0, state.bad === 'cardinality' ? 1 : 600, state.bad === 'capacity' ? 599 : 600, 0, state.bad !== 'locked']);
      case 'token0': return result(market.token);
      case 'observations': return result([1000, 1n, 1n, state.bad !== 'observation']);
      case 'latestRoundData': return result([1n, state.bad === 'negative feed' ? -1n : state.bad === 'cash price' ? 99_000_000n : 100_000_000n,
        1000n, state.bad === 'stale feed' ? 1n : state.bad === 'future feed' ? 1061n : 1000n, 1n]);
      case 'previewSwap': return result([BigInt(spec.priceE18), BigInt(spec.priceE18) * 99n / 100n]);
      case 'balanceOf': return result(0n);
      case 'quoteExactInputSingle': return result([1n, 1n, 0, 1n]);
      default: assert.fail(`unexpected contract read ${name}`);
    }
  } }, { retryCount: 0 });
  const chain = createKeeperChain('http://127.0.0.1:1', signingAccount(`0x${'0'.repeat(63)}1`), manifest, () => {}, transport);
  return { state, chain, manifest };
}
