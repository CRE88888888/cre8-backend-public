import { http } from 'viem';
import type { EIP1193RequestFn, HttpTransportConfig, Transport } from 'viem';

/**
 * Chain-97 RPC: RPC_URL plus a short list of keyless public nodes, tried one after another.
 *
 * History: 2026-11-23 the RPC_URL provider answered "Request exceeds defined limit" and every chain read of the API
 * failed; 2026-11-25 17:35–17:44 UTC the one public node answered HTTP 403 and three scheduler rounds failed whole
 * (403 was not counted as a node failure, and scheduler bulk reads had no second node to go to).
 *
 * - Every request walks its candidate nodes in order. A node failure (any HTTP error status such as 403/429/5xx, a
 *   body that is not JSON, a timeout, a connection error, a quota / rate-limit answer) moves on to the next node and
 *   puts the failed one at the back of the order for 60 s. After that it is tried in its normal place again.
 * - A node that simply does not have the data (pruned state, a block it has not seen yet) also passes the request
 *   on, but keeps its place: it is healthy for everything else.
 * - Every other error (a revert, bad params) is the request's fault and is thrown at once. Callers keep their own
 *   bounded re-reads (src/node-lag.ts).
 * - A request fails only when every candidate failed. Nothing is remembered beyond the 60 s, so the next round
 *   starts from the healthy nodes again.
 * - One `rpc_failover` line per node per minute at most, one `rpc_all_failed` / `rpc_failover_skipped` line per
 *   minute when every candidate failed, and an `rpc_usage` line every 10 minutes with calls per source/method, so
 *   the provider's quota can be traced to its callers.
 *
 * Local forks (127.0.0.1 / localhost) and other chains never get public nodes: tests and mainnet keep plain http().
 */
export const PUBLIC_RPC_97 = 'https://bsc-testnet-rpc.publicnode.com';
/**
 * Keyless chain-97 nodes in order of preference. Probed 2026-11-25:
 * - publicnode: logs and older state (what the services ran on alone until now);
 * - bsc-prebsc-dataseed.bnbchain.org: eth_getLogs up to 5,000 blocks, state of the latest blocks only;
 * - data-seed-prebsc-{1,2}-s1.bnbchain.org: no eth_getLogs ("limit exceeded"), state of the latest blocks only.
 * The last three are run by BNB Chain. None of them needs a key, so no URL here is a secret.
 */
export const PUBLIC_RPCS_97: readonly string[] = [PUBLIC_RPC_97, 'https://bsc-prebsc-dataseed.bnbchain.org',
  'https://data-seed-prebsc-1-s1.bnbchain.org:8545', 'https://data-seed-prebsc-2-s1.bnbchain.org:8545'];
export const RPC_BREAKER_MS = 60_000;
/**
 * In the scheduler, bulk reads (≈670 calls/min on 2026-11-23) never fall back to the paid RPC: when the public node
 * rate-limits, the read fails and that portfolio's round is skipped (retried next round). Only transaction submission and
 * its receipt/nonce/fee reads may use the paid RPC there.
 */
export const SCHEDULER_PAID_METHODS: ReadonlySet<string> = new Set(['eth_sendRawTransaction', 'eth_getTransactionReceipt',
  'eth_getTransactionCount', 'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_chainId']);
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

/**
 * Call-volume cuts shared by every client on the same URL (new clients are created per request in many routes):
 * eth_chainId never changes, and eth_blockNumber is reused for 250 ms (under one 0.45 s chain-97 block), so the head-wait
 * helpers still see every new block.
 */
const chainIds = new Map<string, Promise<unknown>>();
const heads = new Map<string, { at: number; value: Promise<unknown> }>();
export const HEAD_CACHE_MS = 250;
/** Node URL -> until when it stays at the back of the order. Shared by every client: a node is down for all of them. */
const demotedUntil = new Map<string, number>();
const lastFailoverLog = new Map<string, number>();
const usage = new Map<string, number>();
let usageSince = Date.now();
let usageTimer: ReturnType<typeof setInterval> | undefined;

/**
 * The node, not the request, is the problem: any HTTP error status (403, 429, 5xx…), a body that is not JSON, a timeout,
 * a connection failure, or a quota / rate-limit / access answer.
 */
export function isProviderFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const chain: unknown[] = [];
  for (let e: unknown = error; e && chain.length < 8; e = (e as { cause?: unknown }).cause) chain.push(e);
  // A revert or a rejected request is the request's fault: never fail over (viem fallback's shouldThrow).
  if (chain.some((e) => { const x = e as { code?: number; message?: string }; return x.code === 3 || x.code === 4001 || x.code === -32003 || /execution reverted/i.test(x.message ?? ''); })) return false;
  return chain.some((e) => {
    const x = e as { name?: string; status?: number; code?: number; message?: string; details?: string; shortMessage?: string };
    const text = `${x.message ?? ''} ${x.details ?? ''} ${x.shortMessage ?? ''}`;
    // viem raises HttpRequestError for every non-2xx answer, for a 2xx body that is not JSON and for a failed fetch.
    return x.name === 'HttpRequestError' || (typeof x.status === 'number' && x.status >= 400) || x.code === -32005 || x.code === 429 ||
      x.name === 'TimeoutError' || x.name === 'LimitExceededRpcError' ||
      /exceeds defined limit|limit exceeded|rate.?limit|too many requests|quota|capacity|forbidden|unauthori[sz]ed|access denied|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|network error/i.test(text);
  });
}

/**
 * This node cannot answer this request (pruned state, a block it has not seen yet, a log range over its own cap, a log
 * query it only takes with a contract address); another node may.
 * `specify an address`: publicnode answers an `eth_getLogs` that names no contract with code -32701 "Please specify an
 * address in your request …". The holdings scan asks exactly that (every token that ever paid the account in), so in
 * the scheduler, where publicnode comes first, it failed on its first range for every portfolio and no scan cursor
 * moved (2026-11-26 01:22 UTC, `holdings_scan` lines of portfolios 48 and 49: chunksOk=0 after 88–95 ms).
 * bsc-prebsc-dataseed takes the same query.
 */
export function isNodeGap(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
    const x = e as { message?: string; details?: string };
    if (/missing trie node|historical state|state (?:is )?not available|header not found|unknown block|block not found|block range|response size exceeded|specify an address/i.test(`${x.details ?? ''} ${x.message ?? ''}`)) return true;
  }
  return false;
}

/**
 * Node URL -> until when it is not asked for an `eth_getLogs` that names no contract (it said it only takes those with
 * an address), and what it said. The holdings scan sends one such request per 2,000 blocks: without this every one of
 * them paid a refused round trip to that node first (and counted against its rate limit). Asked again after ten
 * minutes, so a lifted restriction is noticed. The node stays first for everything else.
 */
export const ADDRESSLESS_LOGS_SKIP_MS = 10 * 60_000;
const addresslessLogsRefused = new Map<string, { until: number; error: unknown }>();
function isAddresslessLogs(req: { method: string; params?: unknown }): boolean {
  if (req.method !== 'eth_getLogs' || !Array.isArray(req.params)) return false;
  const filter: unknown = req.params[0];
  return typeof filter === 'object' && filter !== null && (filter as { address?: unknown }).address == null;
}
function wantsAddress(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
    const x = e as { message?: string; details?: string };
    if (/specify an address/i.test(`${x.details ?? ''} ${x.message ?? ''}`)) return true;
  }
  return false;
}

/** A node refused this `eth_getLogs` for its width (its own block-range or answer-size cap): a narrower range may pass. */
export function isLogRangeRefusal(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
    const x = e as { message?: string; details?: string };
    if (/block range|response size exceeded/i.test(`${x.details ?? ''} ${x.message ?? ''}`)) return true;
  }
  return false;
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

/** The keyless public nodes behind `url`: none for local forks and other chains, and never `url` itself. */
export function publicRpcs(url: string | null | undefined, chainId = Number(process.env.CHAIN_ID ?? '')): string[] {
  if (chainId !== 97 || !url) return [];
  try {
    const host = new URL(url).hostname;
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host.endsWith('.internal')) return [];
  } catch { return []; }
  return PUBLIC_RPCS_97.filter((node) => node !== url.replace(/\/+$/, ''));
}

/** The first public node behind `url`, or null when it has none (local fork, other chain). */
export function secondaryRpc(url: string | null | undefined, chainId = Number(process.env.CHAIN_ID ?? '')): string | null {
  if (url && url.replace(/\/+$/, '') === PUBLIC_RPC_97) return null;
  return publicRpcs(url, chainId)[0] ?? null;
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

type RpcNode = { name: string; key: string; request: EIP1193RequestFn };

/** Healthy nodes in their configured order, then the ones that failed in the last minute (longest ago first). */
function inOrder(nodes: readonly RpcNode[], now: number): RpcNode[] {
  const until = (node: RpcNode) => demotedUntil.get(node.key) ?? 0;
  return [...nodes.filter((node) => until(node) <= now), ...nodes.filter((node) => until(node) > now).sort((a, b) => until(a) - until(b))];
}

/**
 * Drop-in for `http(rpcUrl, options)` on chain reads/writes. `source` names the caller in `rpc_usage`.
 * `deps.secondary` replaces the public node list (one URL, a list, or null for none); tests use it.
 */
export function rpcTransport(source: string, url: string | null | undefined, options: HttpTransportConfig = {},
  deps: { now?: () => number; log?: (line: string) => void; secondary?: string | readonly string[] | null; preferPublic?: boolean; schedulerRole?: boolean } = {}): Transport {
  const publicUrls = deps.secondary === undefined ? publicRpcs(url) : deps.secondary === null ? [] : typeof deps.secondary === 'string' ? [deps.secondary] : [...deps.secondary];
  const now = deps.now ?? Date.now, log = deps.log ?? ((line: string) => console.warn(line));
  if (publicUrls.length === 0) {
    const plain = http(url ?? undefined, options);
    return (args) => {
      const t = plain(args);
      return { ...t, request: (async (req, opts) => { count(source, req.method); return t.request(req, opts); }) as EIP1193RequestFn };
    };
  }
  // Going to the next node is the retry: a node is asked once per request, so a dead one costs one attempt, not four.
  // Caches only on the real chain-97 nodes (never on local test nodes, which change chain/head between tests).
  const node = (nodeUrl: string) => withCache(nodeUrl, http(nodeUrl, { ...options, retryCount: 0 }), now);
  const primary = node(url ?? ''), publics = publicUrls.map(node);
  // The scheduler's reads are bulk and latency-tolerant (drift, scans, monitoring): they go to the keyless public nodes
  // first and use the paid RPC_URL only when every public node fails. The API keeps RPC_URL first.
  const preferPublic = deps.preferPublic ?? (process.env.SERVICE_ROLE === 'scheduler' || !PAID_FIRST_SOURCES.has(source));
  const schedulerRole = deps.schedulerRole ?? process.env.SERVICE_ROLE === 'scheduler';
  // Paid RPC after the public nodes: always for the API; in the scheduler only for transaction methods.
  const paidFallback = (method: string) => !preferPublic || !schedulerRole || SCHEDULER_PAID_METHODS.has(method);
  return (args) => {
    const base = primary(args);
    const p: RpcNode = { name: 'primary', key: url ?? '', request: base.request };
    const s: RpcNode[] = publics.map((transport, index) => ({ name: index === 0 ? 'public' : `public${index + 1}`, key: publicUrls[index] ?? '', request: transport(args).request }));
    const request = (async (req, opts) => {
      // Scheduler bulk read: public nodes only. When all of them fail, this round's work for the portfolio is skipped.
      const paid = paidFallback(req.method);
      const candidates = inOrder(!paid ? s : preferPublic ? [...s, p] : [p, ...s], now());
      let failure: unknown, gap: unknown;
      const addressless = isAddresslessLogs(req);
      for (const [index, candidate] of candidates.entries()) {
        if (addressless) {
          const refused = addresslessLogsRefused.get(candidate.key);
          if (refused !== undefined && refused.until > now()) { gap ??= refused.error; continue; }
        }
        count(`${source}:${candidate.name}`, req.method);
        try { return await candidate.request(req, opts); }
        catch (error) {
          const down = isProviderFailure(error);
          if (!down && !isNodeGap(error)) throw error;
          if (!down) {
            if (addressless && wantsAddress(error)) addresslessLogsRefused.set(candidate.key, { until: now() + ADDRESSLESS_LOGS_SKIP_MS, error });
            gap ??= error; continue;
          }
          failure ??= error;
          demotedUntil.set(candidate.key, now() + RPC_BREAKER_MS);
          const next = candidates[index + 1]?.name;
          if (next !== undefined && now() - (lastFailoverLog.get(candidate.key) ?? -Infinity) >= LOG_EVERY_MS) {
            lastFailoverLog.set(candidate.key, now());
            log(JSON.stringify({ msg: 'rpc_failover', from: candidate.name, to: next, source, method: req.method, reason: reasonOf(error) }));
          }
        }
      }
      // Every candidate failed. `rpc_failover_skipped`: a scheduler bulk read that deliberately did not use the paid RPC.
      const kind = paid ? 'rpc_all_failed' : 'rpc_failover_skipped';
      if (failure !== undefined && now() - (lastFailoverLog.get(kind) ?? -Infinity) >= LOG_EVERY_MS) {
        lastFailoverLog.set(kind, now());
        log(JSON.stringify({ msg: kind, from: candidates[0]?.name, nodes: candidates.length, source, method: req.method, reason: reasonOf(failure) }));
      }
      // A node that only lacked the data says more to the caller's own re-read (src/node-lag.ts) than a dead node does.
      throw gap ?? failure;
    }) as EIP1193RequestFn;
    return { ...base, request };
  };
}

/** Test hook. */
export function resetRpcTransport(): void { demotedUntil.clear(); lastFailoverLog.clear(); usage.clear(); chainIds.clear(); heads.clear(); addresslessLogsRefused.clear(); }

/**
 * Multicall batching for the bulk readers (scheduler, snapshot, status, Strategy Earn): concurrent readContract calls
 * become one Multicall3 eth_call. 2026-11-23: the scheduler made ~4,600 eth_call per 10 min (one round per portfolio
 * read every asset one by one) and the keyless public node started rate-limiting it. Only on the real chain-97 RPC
 * (local test nodes keep plain calls).
 */
export function rpcBatch(url: string | null | undefined): { batch?: { multicall: { batchSize: number; wait: number } } } {
  return secondaryRpc(url) === null ? {} : { batch: { multicall: { batchSize: 48_000, wait: 0 } } };
}
