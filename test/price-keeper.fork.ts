/** Explicit #70 acceptance. The only signing key comes from env; no public-chain endpoint is accepted. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createPublicClient, http, parseAbi } from 'viem';
import { createKeeperChain, KEEPER_ABI, parseManifest, signingAccount } from '../src/keeper/chain.js';
import { parseScenario } from '../src/keeper/scenario.js';
import { PriceKeeper } from '../src/keeper/engine.js';
import type { KeeperIO } from '../src/keeper/engine.js';

const rpc = 'http://127.0.0.1:8562';
const client = createPublicClient({ transport: http(rpc, { timeout: 10_000, retryCount: 0 }), cacheTime: 0 });
const poolAbi = parseAbi(['event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint128 protocolFeesToken0,uint128 protocolFeesToken1)']);
async function local(method: string, params: readonly unknown[] = []): Promise<unknown> {
  const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body: unknown = await response.json(); assert.ok(typeof body === 'object' && body !== null && !('error' in body), method);
  return Reflect.get(body, 'result');
}

test('#70 local chain 97: two hours, 92 markets every ten minutes, both directions and no source errors', { timeout: 1_800_000 }, async () => {
  assert.equal(process.env.PRICE_KEEPER_RPC_URL, rpc);
  assert.equal(await client.getChainId(), 97); await local('anvil_nodeInfo');
  const manifestPath = process.env.PRICE_KEEPER_MANIFEST; assert.ok(manifestPath);
  const manifest = parseManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
  const account = signingAccount(process.env.PRICE_KEEPER_PRIVATE_KEY);
  assert.equal(account.address, manifest.keeper);
  let lastWrite = '';
  const chain = createKeeperChain(rpc, account, manifest, (line) => { lastWrite = line; }); await chain.verify();
  async function checked<T>(action: string, call: () => Promise<T>): Promise<T> {
    try { return await call(); } catch (error) {
      const types: string[] = [];
      let cause: unknown = error;
      while (cause instanceof Error && types.length < 12) {
        const signature: unknown = Reflect.get(cause, 'signature');
        types.push(cause.name + (typeof signature === 'string' && /^0x[0-9a-f]{8}$/i.test(signature) ? `:${signature}` : ''));
        cause = cause.cause;
      }
      const known = new Set(['pool changed since inspection', 'swap budget cannot reach target', 'swap inventory too low', 'swap result mismatch', 'transaction not confirmed', 'feed unavailable', 'unexpected mock USDT/USD', 'pool observation capacity unavailable']);
      console.log(`#70 failure action=${action} types=${types.join(',')} reason=${error instanceof Error && known.has(error.message) ? error.message : 'upstream'}`);
      console.log(lastWrite);
      console.log(`#70 txpool=${JSON.stringify(await local('txpool_status'))}`);
      throw error;
    }
  }
  const io: KeeperIO = {
    head: () => checked('head', chain.io.head), inspect: (head) => checked('inspect', () => chain.io.inspect(head)),
    balance: (token) => checked('balance', () => chain.io.balance(token)), mint: (token, amount) => checked('mint', () => chain.io.mint(token, amount)),
    swap: (o, target, budget) => checked(`swap-${o.market.symbol}`, () => chain.io.swap(o, target, budget)), push: (feed, answer) => checked('push', () => chain.io.push(feed, answer)),
  };
  const snapshot = await local('evm_snapshot'); assert.equal(typeof snapshot, 'string');
  let previews = 0; let swaps = 0; let pushes = 0; let mints = 0;
  const alerts: string[] = [];
  try {
    // Only native test gas is provisioned by anvil. Tokens use mint; pool prices use real swaps below.
    await local('anvil_setBalance', [account.address, '0x8AC7230489E80000']);
    await local('anvil_setBlockTimestampInterval', [0]);
    // Deployment feeds and pools use the same clock. Warm-up stays inside the 1h feed age.
    const deployedAt = (await chain.io.head()).timestamp;
    await local('evm_setNextBlockTimestamp', [Number(deployedAt + 1801n)]); await local('evm_mine');
    const start = (await chain.io.head()).timestamp;
    assert.equal(start - deployedAt, 1801n);
    const firstBlock = await client.getBlockNumber();
    const scenario = parseScenario(JSON.parse(await readFile(new URL('../scripts/price-scenarios/gentle-rise.json', import.meta.url), 'utf8')));
    const keeper = new PriceKeeper(io, scenario, manifest.usdt, manifest.cashFeed, {
      start, minimumUsdtE18: 10_000n * 10n ** 18n, inventoryUsdtE18: 100_000n * 10n ** 18n,
      swapBudgetUsdtE18: 10_000n * 10n ** 18n, stallSeconds: 90,
    }, (line) => { if (line.includes('] swap ')) swaps++; if (line.includes('] push ')) pushes++; if (line.includes('] mint ')) mints++; },
    async (line) => { alerts.push(line); }, () => Number(clock) * 1000);
    let clock = start;
    await keeper.round();
    for (let step = 1; step <= 120; step++) {
      // Explicit timestamps keep replay deterministic even when mining many writes in a round.
      clock = start + BigInt(step * 60);
      await local('evm_setNextBlockTimestamp', [Number(clock)]); await local('evm_mine');
      await keeper.round();
      if (step % 10 !== 0) continue;
      for (const market of manifest.markets) {
        for (const [tokenIn, tokenOut, amountIn] of [[market.token, manifest.usdt, 10n ** BigInt(market.decimals)], [manifest.usdt, market.token, 10n ** 18n]] as const) {
          const [quote, floor] = await client.readContract({ address: manifest.router, abi: KEEPER_ABI, functionName: 'previewSwap', args: [tokenIn, tokenOut, amountIn] });
          assert.ok(quote > 0n && floor > 0n); previews++;
        }
      }
      console.log(`#70 replay minute=${step} previews=${previews} swaps=${swaps} pushes=${pushes}`);
    }
    assert.equal(previews, 12 * 92 * 2); assert.equal(alerts.length, 0); assert.equal(swaps, 120 * 92);
    assert.ok(mints >= 93); assert.ok(pushes >= 120 * 12);
    // Check the real pool events, including both token orders and all decimal variants.
    for (const market of manifest.markets) {
      const logs = await client.getContractEvents({ address: market.pool, abi: poolAbi, eventName: 'Swap', fromBlock: firstBlock });
      assert.equal(logs.length, 120);
      let prior = 0n;
      for (const log of logs) {
        const block = await client.getBlock({ blockNumber: log.blockNumber });
        if (prior) assert.ok(block.timestamp - prior >= 60n);
        prior = block.timestamp;
      }
    }
    // Exercise sell-side swaps plus holiday and single-asset pause with the same production adapter.
    for (const file of ['gentle-fall', 'market-holiday']) {
      const scenario = parseScenario(JSON.parse(await readFile(new URL(`../scripts/price-scenarios/${file}.json`, import.meta.url), 'utf8')));
      clock += 60n; await local('evm_setNextBlockTimestamp', [Number(clock)]); await local('evm_mine');
      const before = swaps;
      const secondary = new PriceKeeper(chain.io, scenario, manifest.usdt, manifest.cashFeed, {
        start: clock - 31n * 60n, minimumUsdtE18: 10_000n * 10n ** 18n, inventoryUsdtE18: 100_000n * 10n ** 18n,
        swapBudgetUsdtE18: 10_000n * 10n ** 18n, stallSeconds: 90,
      }, (line) => { if (line.includes('] swap ')) swaps++; }, async (line) => { alerts.push(line); }, () => Number(clock) * 1000);
      await secondary.round();
      assert.equal(swaps - before, file === 'gentle-fall' ? 92 : 25);
    }
    assert.equal(alerts.length, 0);
    console.log(`#70 acceptance: previews=${previews}; source errors=0; alerts=0; swaps=${swaps}; pushes=${pushes}; mints=${mints}; duration=7200s`);
  } finally { await local('anvil_removeBlockTimestampInterval'); assert.equal(await local('evm_revert', [snapshot]), true); }
});
