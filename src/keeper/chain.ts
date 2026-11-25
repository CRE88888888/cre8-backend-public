import { BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, decodeErrorResult, getAddress, http, isAddress, isHex, parseAbi, size, zeroAddress } from 'viem';
import type { Account, Address, EIP1193RequestFn, Hex, Transport } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';
import { TESTNET_ASSETS } from './assets.js';
import type { Head, KeeperIO, Market, Observation } from './engine.js';
import { classifyKeeperError, isNetworkError, isRevert, safeReason, UNSETTLED } from './engine.js';
import { publicRpcs } from '../rpc-transport.js';
import { positiveAmount, record } from './scenario.js';

// Official chain-97 periphery: https://developer.pancakeswap.finance/contracts/v3/addresses
export const SWAP_ROUTER = getAddress('0x1b81D678ffb9C0263b24A97847620C99d213eB14');
export const QUOTER = getAddress('0xbC203d7f83677c7ed3F7acEc959963E7F4ECC5C2');
const FACTORY = getAddress('0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865');

export const KEEPER_ABI = parseAbi([
  'error TwapUnavailable()',
  'error StaleFeed(address feed,uint256 updatedAt)',
  'function factory() view returns (address)',
  'function getPool(address,address,uint24) view returns (address)',
  'function token0() view returns (address)',
  'function pool() view returns (address)',
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint32,bool)',
  'function observations(uint256) view returns (uint32,int56,uint160,bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function isMinter(address) view returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function mint(address,uint256)',
  'function keeper() view returns (address)',
  'function push(int256)',
  'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)',
  'function numeraire() view returns (address)',
  'function oracleOf(address) view returns (address)',
  'function secondaryOf(address) view returns (address,uint16)',
  'function twapWindow() view returns (uint32)',
  'function RECENT_WINDOW() view returns (uint32)',
  'function assetFeed() view returns (address)',
  'function numeraireFeed() view returns (address)',
  'function maxAge() view returns (uint32)',
  'function previewSwap(address,address,uint256) view returns (uint256,uint256)',
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
]);

export type Manifest = { keeper: Address; usdt: Address; cashFeed: Address; router: Address; markets: Market[] };

function address(value: unknown): Address {
  if (typeof value !== 'string' || !isAddress(value) || value === zeroAddress) throw new Error('invalid manifest address');
  return getAddress(value);
}

export function parseManifest(input: unknown): Manifest {
  const manifest = record(input);
  if (manifest.chainId !== 97) throw new Error('manifest must be chain 97');
  const contracts = record(manifest.contracts);
  const assets = record(manifest.assets);
  if (Object.keys(assets).length !== TESTNET_ASSETS.length) throw new Error(`manifest requires ${TESTNET_ASSETS.length} markets`);
  const markets = TESTNET_ASSETS.map((spec): Market => {
    const asset = record(assets[spec.symbol]);
    if (!spec.hasFeed && (asset.feed !== undefined || asset.secondary !== undefined)) throw new Error('unexpected secondary');
    return {
      symbol: spec.symbol, decimals: spec.decimals, fee: spec.fee, maxFeedAge: spec.maxFeedAge,
      token: address(asset.token), pool: address(asset.pool), oracle: address(asset.oracle),
      ...(spec.hasFeed ? { feed: address(asset.feed), secondary: address(asset.secondary) } : {}),
    };
  });
  const result = { keeper: address(record(manifest.roles).keeper), usdt: address(contracts.usdt), cashFeed: address(contracts['feed.USDT/USD']), router: address(contracts.router), markets };
  const tokens = [result.usdt, ...markets.map((market) => market.token)];
  if (new Set(tokens).size !== markets.length + 1 || new Set(markets.map((market) => market.pool)).size !== markets.length ||
    new Set([result.cashFeed, ...markets.flatMap((market) => market.feed ? [market.feed] : [])]).size !== 1 + TESTNET_ASSETS.filter((spec) => spec.hasFeed).length) throw new Error('duplicate manifest contracts');
  return result;
}

export function signingAccount(value: unknown): Account {
  if (typeof value !== 'string' || !isHex(value, { strict: true }) || size(value) !== 32) throw new Error('invalid keeper signing configuration');
  try { return privateKeyToAccount(value); } catch { throw new Error('invalid keeper signing configuration'); }
}

const Q192 = 1n << 192n;
export function sqrtPriceFor(price: bigint, decimals: number, assetIsToken0: boolean): bigint {
  if (price <= 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('invalid sqrt price inputs');
  const unit = 10n ** BigInt(decimals);
  const value = assetIsToken0 ? price * Q192 / unit : unit * Q192 / price;
  if (value === 0n) throw new Error('sqrt price out of range');
  let estimate = 1n << BigInt(Math.ceil(value.toString(2).length / 2));
  for (;;) {
    const next = (estimate + value / estimate) / 2n;
    if (next >= estimate) break;
    estimate = next;
  }
  if (estimate <= 4_295_128_739n || estimate >= 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n) throw new Error('sqrt price out of range');
  return estimate;
}

export function spotPrice(sqrt: bigint, decimals: number, assetIsToken0: boolean): bigint {
  if (sqrt <= 0n) throw new Error('invalid pool price');
  const unit = 10n ** BigInt(decimals);
  return assetIsToken0 ? sqrt * sqrt * unit / Q192 : unit * Q192 / (sqrt * sqrt);
}

export function validateFeed(round: readonly [bigint, bigint, bigint, bigint, bigint], timestamp: bigint, maxAge: number, allowStale = false): void {
  const [id, answer, , updatedAt, answeredIn] = round;
  if (id === 0n || answeredIn < id || answer <= 0n || updatedAt <= 0n || updatedAt > timestamp ||
    (!allowStale && timestamp - updatedAt > BigInt(maxAge))) throw new Error('feed unavailable');
}

function revertData(error: unknown) {
  if (!(error instanceof BaseError)) return undefined;
  const cause = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
  if (!(cause instanceof ContractFunctionRevertedError) || !cause.raw) return undefined;
  try {
    // Decode our exact ABI; an identically named error with different arguments is unrelated.
    return decodeErrorResult({ abi: KEEPER_ABI, data: cause.raw });
  } catch { return undefined; }
}

/** How long requests stay on the public node after the primary RPC failed, before the primary is tried again. */
export const FAILOVER_MS = 60_000;

/**
 * Primary RPC with the keyless public nodes behind it (chain 97 only; local forks get no fallback).
 *
 * A network-class failure of the primary (HTTP 403/429/5xx, timeout, connection error, node-side JSON-RPC error)
 * sends that request to the public nodes and keeps later requests there for FAILOVER_MS; then the primary is tried
 * again. The public nodes are tried in order; one that fails goes to the back of that order. Reverts and rejected
 * requests are never failed over. Re-sending a signed transaction to another node is safe: it is the same
 * transaction (same nonce and hash), so it cannot execute twice.
 * `downSeconds()` is how long the primary has been failing without one success in between.
 */
export function failoverTransport(primary: Transport, fallbacks: readonly Transport[], log: (line: string) => void, now: () => number = Date.now) {
  let openUntil = 0;
  let downSince: number | undefined;
  let lastLog = -Infinity;
  const order = fallbacks.map((_, index) => index);
  const transport: Transport = (args) => {
    const p = primary(args);
    const s = fallbacks.map((fallback) => fallback(args));
    const request = (async (req, opts) => {
      if (now() >= openUntil) {
        try {
          const result = await p.request(req, opts);
          if (downSince !== undefined) log(`[price-keeper] primary RPC recovered after ${Math.floor((now() - downSince) / 1000)}s`);
          downSince = undefined;
          return result;
        } catch (error) {
          if (!isNetworkError(error)) throw error;
          downSince ??= now();
          openUntil = now() + FAILOVER_MS;
          if (now() - lastLog >= FAILOVER_MS) {
            lastLog = now();
            log(`[price-keeper][warning] primary RPC ${req.method}: ${safeReason(error)}; using the public nodes for ${FAILOVER_MS / 1000}s; primaryDown=${Math.floor((now() - downSince) / 1000)}s`);
          }
        }
      }
      let failure: unknown;
      for (const index of [...order]) {
        const node = s[index];
        if (node === undefined) continue;
        try { return await node.request(req, opts); }
        catch (error) {
          if (!isNetworkError(error)) throw error;
          failure ??= error;
          order.splice(order.indexOf(index), 1); order.push(index);
        }
      }
      throw failure;
    }) as EIP1193RequestFn;
    return { ...p, request };
  };
  return { transport, downSeconds: () => downSince === undefined ? 0 : Math.floor((now() - downSince) / 1000) };
}

export function createKeeperChain(rpcUrl: string, account: Account, manifest: Manifest, log: (line: string) => void, transport?: Transport, publicFallback = true) {
  const options = { timeout: 10_000, retryCount: 0 };
  const fallbackUrls = transport === undefined && publicFallback ? publicRpcs(rpcUrl, 97) : [];
  const failover = fallbackUrls.length === 0 ? null : failoverTransport(http(rpcUrl, options), fallbackUrls.map((url) => http(url, options)), log);
  const chainTransport = transport ?? failover?.transport ?? http(rpcUrl, options);
  const client = createPublicClient({ chain: bscTestnet, transport: chainTransport, cacheTime: 0 });
  const wallet = createWalletClient({ chain: bscTestnet, account, transport: chainTransport, cacheTime: 0 });
  const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();

  async function head(): Promise<Head> {
    if (await client.getChainId() !== 97) throw new Error('chain 97 only');
    const block = await client.getBlock();
    return { number: block.number, timestamp: block.timestamp };
  }

  // Legacy pricing at the node's eth_gasPrice (0.1 gwei on chain 97); viem's EIP-1559 tip estimate overpays.
  // A failed price read happens before signing, so it stays a retryable read failure.
  async function landed(submit: (fees: { gasPrice: bigint }) => Promise<Hex>, action: string): Promise<void> {
    await head();
    const gasPrice = await client.getGasPrice();
    if (gasPrice <= 0n) throw new Error('invalid gas price');
    // A lost broadcast or receipt may already have changed the chain. This transaction is never sent again:
    // the keeper waits until nothing of its own is pending (`settled`), then starts over from a fresh inspection.
    let hash: Hex;
    try { hash = await submit({ gasPrice }); }
    catch (error) {
      // Only a revert during gas estimation or a missing gas balance proves that nothing was broadcast.
      if (classifyKeeperError(error) === 'fatal' || isRevert(error)) throw error;
      throw new Error(UNSETTLED, { cause: error });
    }
    log(`[price-keeper] submitted ${action} tx=${hash}`);
    let confirmed: boolean;
    try {
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 30_000, pollingInterval: 250, retryCount: 0 });
      confirmed = receipt.transactionHash.toLowerCase() === hash.toLowerCase() && receipt.status === 'success' &&
        (await client.getBlock({ blockNumber: receipt.blockNumber })).hash === receipt.blockHash;
      if (confirmed) log(`[price-keeper] confirmed ${action} block=${receipt.blockNumber}`);
    } catch (error) {
      if (classifyKeeperError(error) === 'fatal') throw error;
      throw new Error(UNSETTLED, { cause: error });
    }
    if (!confirmed) throw new Error('transaction not confirmed');
  }

  async function settled(): Promise<boolean> {
    const mined = await client.getTransactionCount({ address: account.address, blockTag: 'latest' });
    return await client.getTransactionCount({ address: account.address, blockTag: 'pending' }) <= mined;
  }

  async function verify(): Promise<void> {
    await head();
    if (!same(account.address, manifest.keeper)) throw new Error('keeper role mismatch');
    for (const contract of [SWAP_ROUTER, QUOTER, FACTORY, manifest.router, manifest.usdt, manifest.cashFeed]) {
      if (!await client.getCode({ address: contract })) throw new Error('missing keeper contract');
    }
    for (const contract of [SWAP_ROUTER, QUOTER]) {
      if (!same(await client.readContract({ address: contract, abi: KEEPER_ABI, functionName: 'factory' }), FACTORY)) throw new Error('periphery factory mismatch');
    }
    if (!same(await client.readContract({ address: manifest.router, abi: KEEPER_ABI, functionName: 'numeraire' }), manifest.usdt) ||
      await client.readContract({ address: manifest.usdt, abi: KEEPER_ABI, functionName: 'decimals' }) !== 18) throw new Error('numeraire mismatch');
    for (const market of manifest.markets) {
      if (await client.readContract({ address: market.token, abi: KEEPER_ABI, functionName: 'symbol' }) !== market.symbol ||
        await client.readContract({ address: market.token, abi: KEEPER_ABI, functionName: 'decimals' }) !== market.decimals ||
        !await client.readContract({ address: market.token, abi: KEEPER_ABI, functionName: 'isMinter', args: [account.address] }) ||
        !same(await client.readContract({ address: FACTORY, abi: KEEPER_ABI, functionName: 'getPool', args: [market.token, manifest.usdt, market.fee] }), market.pool) ||
        !same(await client.readContract({ address: manifest.router, abi: KEEPER_ABI, functionName: 'oracleOf', args: [market.token] }), market.oracle) ||
        !same(await client.readContract({ address: market.oracle, abi: KEEPER_ABI, functionName: 'pool' }), market.pool) ||
        await client.readContract({ address: market.oracle, abi: KEEPER_ABI, functionName: 'twapWindow' }) !== 1800 ||
        await client.readContract({ address: market.oracle, abi: KEEPER_ABI, functionName: 'RECENT_WINDOW' }) !== 300) throw new Error('market configuration mismatch');
      const secondary = await client.readContract({ address: manifest.router, abi: KEEPER_ABI, functionName: 'secondaryOf', args: [market.token] });
      if (!same(secondary[0], market.secondary ?? zeroAddress) || (market.secondary && secondary[1] !== 200)) throw new Error('secondary mismatch');
      if (market.secondary && market.feed) {
        const source = market.secondary;
        if (!same(await client.readContract({ address: source, abi: KEEPER_ABI, functionName: 'assetFeed' }), market.feed) ||
          !same(await client.readContract({ address: source, abi: KEEPER_ABI, functionName: 'numeraireFeed' }), manifest.cashFeed) ||
          await client.readContract({ address: source, abi: KEEPER_ABI, functionName: 'maxAge' }) !== market.maxFeedAge) throw new Error('feed configuration mismatch');
      }
    }
    for (const feed of [manifest.cashFeed, ...manifest.markets.flatMap((m) => m.feed ? [m.feed] : [])]) {
      if (!same(await client.readContract({ address: feed, abi: KEEPER_ABI, functionName: 'keeper' }), account.address) ||
        await client.readContract({ address: feed, abi: KEEPER_ABI, functionName: 'decimals' }) !== 8) throw new Error('feed keeper mismatch');
    }
  }

  const io: KeeperIO = {
    head,
    settled,
    async inspect(block) {
      const cash = await client.readContract({ address: manifest.cashFeed, abi: KEEPER_ABI, functionName: 'latestRoundData', blockNumber: block.number });
      // These are keeper-owned feeds: age makes them due for a push, not invalid input.
      validateFeed(cash, block.timestamp, 3600, true);
      if (cash[1] !== 100_000_000n) throw new Error('unexpected mock USDT/USD');
      const result: Observation[] = [];
      for (const market of manifest.markets) {
        const blockNumber = block.number;
        const slot = await client.readContract({ address: market.pool, abi: KEEPER_ABI, functionName: 'slot0', blockNumber });
        if (!slot[6] || slot[3] < 2 || slot[4] < 600) throw new Error('pool observation capacity unavailable');
        // A stale primary reverts before its own spot sanity gate. Keep that gate during recovery too.
        if (slot[0] < 4_295_128_739n || slot[0] >= 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n) throw new Error('invalid pool price');
        const observation = await client.readContract({ address: market.pool, abi: KEEPER_ABI, functionName: 'observations', args: [BigInt(slot[2])], blockNumber });
        if (!observation[3]) throw new Error('missing observation');
        const token0 = await client.readContract({ address: market.pool, abi: KEEPER_ABI, functionName: 'token0', blockNumber });
        const expired = new Map<string, bigint>();
        if (block.timestamp - cash[3] > 3600n) expired.set(manifest.cashFeed.toLowerCase(), cash[3]);
        let feedUpdatedAt: bigint | null = null;
        let feedAnswerE8: bigint | null = null;
        if (market.feed) {
          const feed = await client.readContract({ address: market.feed, abi: KEEPER_ABI, functionName: 'latestRoundData', blockNumber });
          validateFeed(feed, block.timestamp, market.maxFeedAge, true);
          if (block.timestamp - feed[3] > BigInt(market.maxFeedAge)) expired.set(market.feed.toLowerCase(), feed[3]);
          feedUpdatedAt = feed[3] < cash[3] ? feed[3] : cash[3];
          feedAnswerE8 = feed[1];
        }
        let twapE18: bigint | null = null;
        try {
          const primary = await client.readContract({ address: market.oracle, abi: KEEPER_ABI, functionName: 'previewSwap', args: [market.token, manifest.usdt, 10n ** BigInt(market.decimals)], blockNumber });
          twapE18 = primary[0];
        } catch (error) {
          if (revertData(error)?.errorName !== 'TwapUnavailable') throw error;
        }
        if (twapE18 !== null) {
          // A missing primary needs a maintenance swap first; router validation resumes next round.
          for (const [tokenIn, tokenOut, amountIn] of [[market.token, manifest.usdt, 10n ** BigInt(market.decimals)], [manifest.usdt, market.token, 10n ** 18n]] as const) {
            try {
              await client.readContract({ address: manifest.router, abi: KEEPER_ABI, functionName: 'previewSwap', args: [tokenIn, tokenOut, amountIn], blockNumber });
            } catch (error) {
              const data = revertData(error);
              const args = data?.args;
              // Do not swallow any other revert, or StaleFeed for an unverified feed/timestamp.
              if (data?.errorName !== 'StaleFeed' || !args || typeof args[0] !== 'string' ||
                expired.get(args[0].toLowerCase()) !== args[1]) throw error;
            }
          }
        }
        result.push({ market, spotE18: spotPrice(slot[0], market.decimals, same(token0, market.token)), twapE18, lastObservation: BigInt(observation[0]), feedUpdatedAt, feedAnswerE8 });
      }
      return result;
    },
    balance: (token) => client.readContract({ address: token, abi: KEEPER_ABI, functionName: 'balanceOf', args: [account.address] }),
    async mint(token, amount) {
      await head();
      if (same(token, manifest.usdt)) throw new Error('USDT inventory must be prefunded');
      await landed((fees) => wallet.writeContract({ address: token, abi: KEEPER_ABI, functionName: 'mint', args: [account.address, amount], ...fees }), 'mint');
    },
    push: (feed, answer) => landed((fees) => wallet.writeContract({ address: feed, abi: KEEPER_ABI, functionName: 'push', args: [answer], ...fees }), 'feed'),
    async swap(observation, targetE18, budgetUsdtE18) {
      const market = observation.market;
      await head();
      const token0 = await client.readContract({ address: market.pool, abi: KEEPER_ABI, functionName: 'token0' });
      const current = await client.readContract({ address: market.pool, abi: KEEPER_ABI, functionName: 'slot0' });
      const latestObservation = await client.readContract({ address: market.pool, abi: KEEPER_ABI, functionName: 'observations', args: [BigInt(current[2])] });
      if (!current[6] || !latestObservation[3] || BigInt(latestObservation[0]) !== observation.lastObservation ||
        spotPrice(current[0], market.decimals, same(token0, market.token)) !== observation.spotE18) throw new Error('pool changed since inspection');
      const limit = sqrtPriceFor(targetE18, market.decimals, same(token0, market.token));
      const buying = targetE18 > observation.spotE18;
      const tokenIn = buying ? manifest.usdt : market.token;
      const tokenOut = buying ? market.token : manifest.usdt;
      const amountIn = buying ? budgetUsdtE18 : budgetUsdtE18 * 10n ** BigInt(market.decimals) / observation.spotE18;
      const { result: quote } = await client.simulateContract({ address: QUOTER, abi: KEEPER_ABI, functionName: 'quoteExactInputSingle', args: [{ tokenIn, tokenOut, amountIn, fee: market.fee, sqrtPriceLimitX96: limit }] });
      if (quote[1] !== limit || quote[0] <= 0n || amountIn <= 0n) throw new Error('swap budget cannot reach target');
      const before = await io.balance(tokenIn);
      if (before < amountIn) throw new Error('swap inventory too low');
      if (await client.readContract({ address: tokenIn, abi: KEEPER_ABI, functionName: 'allowance', args: [account.address, SWAP_ROUTER] }) < amountIn) {
        await landed((fees) => wallet.writeContract({ address: tokenIn, abi: KEEPER_ABI, functionName: 'approve', args: [SWAP_ROUTER, amountIn], ...fees }), 'approve');
      }
      const block = await head();
      // SwapRouter pays only the input needed to reach sqrtPriceLimitX96, including initialized tick crossings.
      await landed((fees) => wallet.writeContract({ address: SWAP_ROUTER, abi: KEEPER_ABI, functionName: 'exactInputSingle', args: [{ tokenIn, tokenOut, amountIn, fee: market.fee, recipient: account.address, deadline: block.timestamp + 60n, amountOutMinimum: quote[0] * 9999n / 10_000n, sqrtPriceLimitX96: limit }], ...fees }), 'swap');
      try {
        const after = await client.readContract({ address: market.pool, abi: KEEPER_ABI, functionName: 'slot0' });
        const spent = before - await io.balance(tokenIn);
        if (after[0] !== limit || spent <= 0n || spent > amountIn) throw new Error('swap result mismatch');
        log(`[price-keeper] spent ${market.symbol} tokenIn=${tokenIn} amountRaw=${spent}`);
      } catch (error) {
        // The swap is confirmed; name the lost check. The next round re-reads the pool before deciding anything.
        if (isNetworkError(error)) throw new Error('swap result verification unavailable', { cause: error });
        throw error;
      }
    },
  };
  return { io, verify, primaryDownSeconds: () => failover?.downSeconds() ?? 0 };
}

export function amountSetting(env: NodeJS.ProcessEnv, key: string, fallback: bigint): bigint {
  return env[key] === undefined ? fallback : positiveAmount(env[key]);
}
