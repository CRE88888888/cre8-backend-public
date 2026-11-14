import { getAddress, isAddress, isHex, zeroAddress } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { EXECUTOR_ABI } from './chain.js';
import { quoteBoundMinimum } from './swap-slippage.js';

const API = 'https://aggregator-api.kyberswap.com/bsc/api/v1';
export const AGGREGATOR_TIMEOUT_MS = 5_000;
const UINT256_MAX = (1n << 256n) - 1n;
export type AggregatorQuote = { venue: Address; data: Hex; amountOut: bigint };
export type AggregatorFailure = 'api-failed' | 'below-floor' | 'venue-changed';
export type AggregatorRequest = {
  publicClient: PublicClient;
  executor: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minimum: bigint;
  /** Independent Pancake quote for this exact input and observed block; null when unavailable. */
  pancakeOut?: bigint | null;
  deadline: bigint;
  blockNumber?: bigint;
  /** Local diagnostics only; never receives upstream text or response data. */
  onFailure?: (reason: AggregatorFailure) => void;
};
export type AggregatorQuoter = (request: AggregatorRequest) => Promise<AggregatorQuote | null>;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid response');
  return Object.fromEntries(Object.entries(value));
}
function amount(value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d{1,78}$/.test(value)) throw new Error('invalid amount');
  const parsed = BigInt(value);
  if (parsed > UINT256_MAX) throw new Error('amount overflow');
  return parsed;
}
function address(value: unknown): Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) throw new Error('invalid address');
  return getAddress(value.toLowerCase());
}
function same(left: Address, right: Address): boolean { return left.toLowerCase() === right.toLowerCase(); }

/** API data is untrusted. No upstream response/error text is logged or returned. */
export async function quoteKyberSwap(request: AggregatorRequest, deps: {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
} = {}): Promise<AggregatorQuote | null> {
  const { publicClient, executor, tokenIn, tokenOut, amountIn, minimum, deadline } = request;
  let failure: AggregatorFailure = 'api-failed';
  const rejected = (reason: AggregatorFailure): null => { failure = reason; return null; };
  if (amountIn <= 0n || amountIn > UINT256_MAX || minimum <= 0n || minimum > UINT256_MAX || same(tokenIn, tokenOut) ||
      deadline <= 0n || deadline > BigInt(Number.MAX_SAFE_INTEGER)) {
    request.onFailure?.(failure); return null;
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Promise.race bounds RPC, response body parsing and non-cooperative fetch implementations too.
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(null); }, deps.timeoutMs ?? AGGREGATOR_TIMEOUT_MS);
  });
  const work = async (): Promise<AggregatorQuote | null> => {
    // This integration is BSC-only. A fork must report chain id 56 as DeployAtpMainnet requires.
    if (await publicClient.getChainId() !== 56) return null;
    const fetcher = deps.fetch ?? fetch;
    const json = async (url: string, init: RequestInit): Promise<Record<string, unknown>> => {
      const response = await fetcher(url, { ...init, signal: controller.signal,
        redirect: 'error', headers: { 'content-type': 'application/json', 'x-client-id': 'cre8-atp' } });
      if (!response.ok) throw new Error('upstream unavailable');
      const body = record(await response.json());
      if (body.code !== 0) throw new Error('upstream rejected');
      return record(body.data);
    };
    const query = new URLSearchParams({ tokenIn, tokenOut, amountIn: amountIn.toString() });
    const route = await json(`${API}/routes?${query}`, { method: 'GET' });
    const summary = record(route.routeSummary);
    if (!same(address(summary.tokenIn), tokenIn) || !same(address(summary.tokenOut), tokenOut) ||
        amount(summary.amountIn) !== amountIn) return null;
    if (amount(summary.amountOut) < minimum) return rejected('below-floor');
    const venue = address(route.routerAddress);
    if ([zeroAddress, tokenIn, tokenOut, executor].some((item) => same(venue, item))) return null;
    const [kind, spender] = await publicClient.readContract({ address: executor, abi: EXECUTOR_ABI,
      functionName: 'venues', args: [venue], ...(request.blockNumber === undefined ? {} : { blockNumber: request.blockNumber }) });
    if ((kind !== 2 && kind !== 3) || [zeroAddress, tokenIn, tokenOut, executor].some((item) => same(spender, item))) return rejected('venue-changed');
    if (kind === 3 && amountIn > (1n << 160n) - 1n) return null;
    const quoted = amount(summary.amountOut);
    const amountOutMin = quoteBoundMinimum(minimum, quoted, request.pancakeOut);
    // Round bps DOWN: floor(quoted * (10000 - slippage) / 10000) stays >= amountOutMin.
    const slippage = (quoted - amountOutMin) * 10_000n / quoted;
    const built = await json(`${API}/route/build`, { method: 'POST', body: JSON.stringify({
      routeSummary: summary, sender: executor, recipient: executor, deadline: Number(deadline),
      slippageTolerance: Number(slippage > 2000n ? 2000n : slippage), source: 'cre8-atp',
    }) });
    // APIv1 routerAddress is the transaction target (tx.to). Reject a differing explicit to too.
    const to = address(built.routerAddress);
    if (!same(to, venue) || (built.to !== undefined && !same(address(built.to), venue))) return rejected('venue-changed');
    // Sanity check only: both summary and built.amountOut are untrusted API claims.
    // Opaque calldata cannot prove minReturn or recipient here. AtpExecutor must enforce
    // the actual tokenOut balance delta >= step.amountOutMin (cre8-contracts#24).
    if (amount(built.amountOut) < amountOutMin) return rejected('below-floor');
    if (amount(built.transactionValue) !== 0n || amount(built.amountIn) !== amountIn ||
        typeof built.data !== 'string' || !isHex(built.data, { strict: true }) ||
        !/^0x(?:[0-9a-fA-F]{2}){4,}$/.test(built.data)) return null;
    // Keep the same quote used to build slippage; the build response cannot inflate route ranking.
    return { venue: to, data: built.data, amountOut: quoted };
  };
  try {
    const quote = await Promise.race([work().catch(() => null), timeout]);
    if (quote === null) request.onFailure?.(failure);
    return quote;
  }
  finally { clearTimeout(timer); controller.abort(); }
}

/** Same output token and platform fee: compare integer net receipts; ties keep Pancake. */
export function aggregatorWins(quote: AggregatorQuote | null, pancakeOut: bigint | null, minimum: bigint, feeBps: number): boolean {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps >= 10_000 || quote === null || minimum <= 0n || quote.amountOut < minimum) return false;
  const net = (gross: bigint) => gross - gross * BigInt(feeBps) / 10_000n;
  return pancakeOut === null || net(quote.amountOut) > net(pancakeOut);
}
