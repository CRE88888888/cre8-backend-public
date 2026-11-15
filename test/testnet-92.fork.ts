/** #87 acceptance: explicit opt-in, fixed local anvil only, never reads key files. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createPublicClient, http, parseAbi } from 'viem';
import { TESTNET_ASSETS } from '../src/keeper/assets.js';
import { createKeeperChain, KEEPER_ABI, parseManifest, signingAccount } from '../src/keeper/chain.js';
import { PriceKeeper } from '../src/keeper/engine.js';
import type { KeeperIO } from '../src/keeper/engine.js';
import { parseScenario, targetAt } from '../src/keeper/scenario.js';

const rpc = 'http://127.0.0.1:8562';
const client = createPublicClient({ transport: http(rpc, { retryCount: 0, timeout: 120000 }), cacheTime: 0 });
async function local(method: string, params: readonly unknown[] = []) {
  const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body: unknown = await response.json(); assert.ok(typeof body === 'object' && body !== null && !('error' in body), method);
  return Reflect.get(body, 'result');
}
const eventAbi = parseAbi(['event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint128 protocolFeesToken0,uint128 protocolFeesToken1)']);

test('#87 all 92 pools trade, then held/paused/exhausted pools maintain observations across restart', { timeout: 600000 }, async () => {
  assert.equal(process.env.PRICE_KEEPER_RPC_URL, rpc);
  await local('anvil_nodeInfo'); assert.equal(await client.getChainId(), 97);
  const manifestPath = process.env.PRICE_KEEPER_MANIFEST; assert.ok(manifestPath);
  const manifest = parseManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
  const chain = createKeeperChain(rpc, signingAccount(process.env.PRICE_KEEPER_PRIVATE_KEY), manifest, () => {});
  await chain.verify(); assert.equal(manifest.markets.length, 92);
  const snapshot = await local('evm_snapshot');
  let swaps = 0; let previews = 0;
  const alerts: string[] = [];
  try {
    await local('anvil_setBalance', [manifest.keeper, '0x8AC7230489E80000']);
    await local('anvil_setBlockTimestampInterval', [0]);
    let clock = (await chain.io.head()).timestamp + 1801n;
    async function advance(timestamp: bigint) {
      clock = timestamp; await local('evm_setNextBlockTimestamp', [Number(clock)]); await local('evm_mine');
    }
    await advance(clock);
    const start = clock;
    const base = { version: 1, stepSeconds: 60, maxStepBps: 1,
      assets: Object.fromEntries(TESTNET_ASSETS.map((s) => [s.symbol, s.priceE18])),
      timeline: [{ steps: 120, mode: 'rise', stepBps: 1 }], overrides: {} };
    const moving = parseScenario(base);
    const settings = { start, minimumUsdtE18: 10_000n * 10n ** 18n, inventoryUsdtE18: 100_000n * 10n ** 18n, swapBudgetUsdtE18: 10_000n * 10n ** 18n, stallSeconds: 90 };
    // EOA writes need room for anvil's suggested tip even with its gas-price floor
    // disabled for the separate UserOp budget scenario. This changes only local fees.
    const eoaFee = () => local('anvil_setNextBlockBaseFeePerGas', ['0x2540be400']);
    const io: KeeperIO = { ...chain.io,
      mint: async (token, amount) => { await eoaFee(); await chain.io.mint(token, amount); },
      swap: async (o, target, budget) => { await eoaFee(); await chain.io.swap(o, target, budget); },
      push: async (feed, answer) => { await eoaFee(); await chain.io.push(feed, answer); },
    };
    const keeper = (scenario = moving) => new PriceKeeper(io, scenario, manifest.usdt, manifest.cashFeed, settings,
      (line) => { if (line.includes('] swap ')) swaps++; }, async (line) => { alerts.push(line); }, () => Number(clock) * 1000);
    const firstBlock = await client.getBlockNumber();
    await advance(start + 60n); await keeper().round(); assert.equal(swaps, 92);
    const frozen = parseScenario({ ...base, timeline: [{ steps: 120, mode: 'closed', stepBps: 0 }], overrides: {
      ETH: [{ steps: 120, mode: 'paused', stepBps: 0 }],
      TONCOIN: [{ steps: 1, mode: 'rise', stepBps: 0 }],
    } });
    const anchors = manifest.markets.map((m) => targetAt(frozen, m.symbol, start, clock).price);
    for (let round = 1; round <= 2; round++) {
      await advance(start + 60n + BigInt(round * 1800 - 1));
      await keeper(frozen).round(); assert.equal(swaps, round * 92, 'no maintenance before 1800 seconds');
      await advance(clock + 1n);
      // A brand-new instance at the exact boundary must use on-chain timestamps/direction.
      await keeper(frozen).round(); assert.equal(swaps, (round + 1) * 92);
      const observations = await chain.io.inspect(await chain.io.head());
      observations.forEach((o, i) => {
        assert.equal(o.lastObservation, clock, o.market.symbol + ' actual observation refreshed');
        assert.equal(targetAt(frozen, o.market.symbol, start, clock).price, anchors[i]);
      });
      for (const market of manifest.markets) {
        for (const [tokenIn, tokenOut, amountIn] of [[market.token, manifest.usdt, 10n ** BigInt(market.decimals)], [manifest.usdt, market.token, 10n ** 18n]] as const) {
          const [quote, floor] = await client.readContract({ address: manifest.router, abi: KEEPER_ABI, functionName: 'previewSwap', args: [tokenIn, tokenOut, amountIn] });
          assert.ok(quote > 0n && floor > 0n); previews++;
        }
      }
    }
    for (const market of manifest.markets) {
      const logs = await client.getContractEvents({ address: market.pool, abi: eventAbi, eventName: 'Swap', fromBlock: firstBlock });
      assert.equal(logs.length, 3, market.symbol);
      assert.ok(logs.every((l) => l.args.amount0 !== 0n && l.args.amount1 !== 0n));
      assert.notEqual(logs[1]?.args.tick, logs[0]?.args.tick);
      assert.notEqual(logs[2]?.args.tick, logs[1]?.args.tick);
    }
    assert.equal(alerts.length, 0);
    console.log(`#87 acceptance: markets=92; swaps=${swaps}; bidirectional previews=${previews}; maintenance rounds=2; source errors=0; alerts=0`);
  } finally {
    await local('anvil_removeBlockTimestampInterval'); assert.equal(await local('evm_revert', [snapshot]), true);
  }
});
