import { http } from 'viem';
import type { EIP1193RequestFn, HttpTransportConfig, Transport } from 'viem';

/**
 * Chain-97 RPC with a keyless public fallback (2026-11-23: the RPC_URL provider answered "Request exceeds defined
 * limit" and every chain read of the API failed, including the pre-deploy check).
 *
 * - The primary (RPC_URL) serves every request while it is healthy.
 * - A quota / rate-limit / connection / timeout error trips a 60 s breaker: the request is retried on the public node and
 *   later requests go straight there until the breaker closes, then the primary is tried again.
 * - Every other error (a revert, a lagging node's "header not found", bad params) is thrown as before. Callers keep
 *   their own bounded re-reads (src/node-lag.ts); both nodes can lag, and those helpers wait for the head either way.
 * - One `rpc_failover` line per minute at most, and an `rpc_usage` line every 10 minutes with calls per source/method,
 *   so the provider's quota can be traced to its callers.
 *
 * Local forks (127.0.0.1 / localhost) and other chains never get a secondary: tests and mainnet keep plain http().
 */
export const PUBLIC_RPC_97 = 'https://bsc-testnet-rpc.publicnode.com';
export const RPC_BREAKER_MS = 60_000;
/**
 * API callers that stay on the paid RPC first: sponsorship decisions, operator/faucet transaction submission and the
 * enrollment confirmations right after a user's transaction (latency and freshness matter, call counts are small).
 * Every other caller (display endpoints, positions, DCA/Earn views, snapshots, monitoring) reads from the public node
 * first. Measured 2026-11-23 14:02: in 10 min the API made 277 paid calls, 70 % from display reads.
 */
export const PAID_FIRST_SOURCES: ReadonlySet<string> = new Set(['paymaster', 'paymaster-exit-reconciliation', 'faucet', 'gas-faucet',
  'welcome-grants', 'chain', 'relayer-reconciliation', 'preflight']);
const LOG_EVERY_MS = 60_000;
const USAGE_EVERY_MS = 10 * 60_000;

type Breaker = { openUntil: number; lastLog: number };
/**
 * Call-volume cuts shared by every client on the same URL (new clients are created per request in many routes):
 * eth_chainId never changes, and eth_blockNumber is reused for 250 ms (under one 0.45 s chain-97 block), so the head-wait
 * helpers still see every new block.
 */
const chainIds = new Map<string, Promise<unknown>>();
const heads = new Map<string, { at: number; value: Promise<unknown> }>();
export const HEAD_CACHE_MS = 250;
const breakers = new Map<string, Breaker>();
const usage = new Map<string, number>();
let usageSince = Date.now();
let usageTimer: ReturnType<typeof setInterval> | undefined;

/** Quota, rate limit, HTTP 429/5xx, timeouts and connection failures: the node, not the request, is the problem. */
export function isProviderFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const chain: unknown[] = [];
  for (let e: unknown = error; e && chain.length < 8; e = (e as { cause?: unknown }).cause) chain.push(e);
  // A revert or a rejected request is the request's fault: never fail over (viem fallback's shouldThrow).
  if (chain.some((e) => { const x = e as { code?: number; message?: string }; return x.code === 3 || x.code === 4001 || x.code === -32003 || /execution reverted/i.test(x.message ?? ''); })) return false;
  return chain.some((e) => {
    const x = e as { name?: string; status?: number; code?: number; message?: string; details?: string; shortMessage?: string };
    const text = `${x.message ?? ''} ${x.details ?? ''} ${x.shortMessage ?? ''}`;
    return x.status === 429 || (typeof x.status === 'number' && x.status >= 500) || x.code === -32005 || x.code === 429 ||
      x.name === 'TimeoutError' || x.name === 'LimitExceededRpcError' ||
      /exceeds defined limit|limit exceeded|rate.?limit|too many requests|quota|capacity|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|network error/i.test(text);
  });
}

function reasonOf(error: unknown): string {
  const text = error instanceof Error ? `${(error as { details?: string }).details ?? ''} ${error.message}` : String(error);
  // Never log the URL (it carries the provider key).
  return text.replace(/https?:\/\/\S+/g, '<url>').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function count(source: string, method: string): void {
  const key = `${source} ${method}`;
  usage.set(key, (usage.get(key) ?? 0) + 1);
  if (usageTimer === undefined && process.env.NODE_ENV !== 'test') {
    usageTimer = setInterval(() => {
      if (usage.size === 0) return;
      const total = [...usage.values()].reduce((a, b) => a + b, 0);
      const top = [...usage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, n]) => `${k}=${n}`);
      console.info(JSON.stringify({ msg: 'rpc_usage', minutes: Math.round((Date.now() - usageSince) / 60_000), total, top }));
      usage.clear(); usageSince = Date.now();
    }, USAGE_EVERY_MS);
    usageTimer.unref?.();
  }
}

export function secondaryRpc(url: string | null | undefined, chainId = Number(process.env.CHAIN_ID ?? '')): string | null {
  if (chainId !== 97 || !url) return null;
  try {
    const host = new URL(url).hostname;
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host.endsWith('.internal')) return null;
    if (url.replace(/\/+$/, '') === PUBLIC_RPC_97) return null;
  } catch { return null; }
  return PUBLIC_RPC_97;
}

function withCache(key: string, transport: Transport, now: () => number): Transport {
  return (args) => {
    const t = transport(args);
    const request = (async (req, opts) => {
      if (req.method === 'eth_chainId') {
        const cached = chainIds.get(key);
        if (cached) return cached;
        const value = t.request(req, opts);
        chainIds.set(key, value); value.catch(() => chainIds.delete(key));
        return value;
      }
      if (req.method === 'eth_blockNumber') {
        const hit = heads.get(key);
        if (hit && now() - hit.at < HEAD_CACHE_MS) return hit.value;
        const value = t.request(req, opts);
        heads.set(key, { at: now(), value }); value.catch(() => heads.delete(key));
        return value;
      }
      return t.request(req, opts);
    }) as EIP1193RequestFn;
    return { ...t, request };
  };
}

/** Drop-in for `http(rpcUrl, options)` on chain reads/writes. `source` names the caller in `rpc_usage`. */
export function rpcTransport(source: string, url: string | null | undefined, options: HttpTransportConfig = {},
  deps: { now?: () => number; log?: (line: string) => void; secondary?: string | null; preferPublic?: boolean } = {}): Transport {
  const fallbackUrl = deps.secondary !== undefined ? deps.secondary : secondaryRpc(url);
  // Caches only on the real chain-97 provider (never on local test nodes, which change chain/head between tests).
  const plain = http(url ?? undefined, options);
  const primary = fallbackUrl === null ? plain : withCache(url ?? '', plain, deps.now ?? Date.now);
  const now = deps.now ?? Date.now, log = deps.log ?? ((line: string) => console.warn(line));
  if (fallbackUrl === null) {
    return (args) => {
      const t = primary(args);
      return { ...t, request: (async (req, opts) => { count(source, req.method); return t.request(req, opts); }) as EIP1193RequestFn };
    };
  }
  const publicNode = withCache(fallbackUrl, http(fallbackUrl, options), now);
  // The scheduler's reads are bulk and latency-tolerant (drift, scans, monitoring): they go to the keyless public node
  // first and use the paid RPC_URL only when the public node fails. The API keeps RPC_URL first.
  const preferPublic = deps.preferPublic ?? (process.env.SERVICE_ROLE === 'scheduler' || !PAID_FIRST_SOURCES.has(source));
  const [first, second] = preferPublic ? [publicNode, primary] : [primary, publicNode];
  const [firstName, secondName] = preferPublic ? ['public', 'primary'] : ['primary', 'public'];
  const key = `${preferPublic ? 'public-first' : 'primary-first'}:${url ?? ''}`;
  return (args) => {
    const p = first(args), s = second(args);
    const breaker = breakers.get(key) ?? { openUntil: 0, lastLog: 0 };
    breakers.set(key, breaker);
    const request = (async (req, opts) => {
      if (now() >= breaker.openUntil) {
        count(`${source}:${firstName}`, req.method);
        try { return await p.request(req, opts); }
        catch (error) {
          if (!isProviderFailure(error)) throw error;
          breaker.openUntil = now() + RPC_BREAKER_MS;
          if (now() - breaker.lastLog >= LOG_EVERY_MS) {
            breaker.lastLog = now();
            log(JSON.stringify({ msg: 'rpc_failover', from: firstName, to: secondName, source, method: req.method, reason: reasonOf(error) }));
          }
        }
      }
      count(`${source}:${secondName}`, req.method);
      return s.request(req, opts);
    }) as EIP1193RequestFn;
    return { ...p, request };
  };
}

/** Test hook. */
export function resetRpcTransport(): void { breakers.clear(); usage.clear(); chainIds.clear(); heads.clear(); }

/**
 * Multicall batching for the bulk readers (scheduler, snapshot, status, Strategy Earn): concurrent readContract calls
 * become one Multicall3 eth_call. 2026-11-23: the scheduler made ~4,600 eth_call per 10 min (one round per portfolio
 * read every asset one by one) and the keyless public node started rate-limiting it. Only on the real chain-97 RPC
 * (local test nodes keep plain calls).
 */
export function rpcBatch(url: string | null | undefined): { batch?: { multicall: { batchSize: number; wait: number } } } {
  return secondaryRpc(url) === null ? {} : { batch: { multicall: { batchSize: 48_000, wait: 0 } } };
}
