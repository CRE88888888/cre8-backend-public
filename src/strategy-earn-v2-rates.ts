import { createPublicClient, createWalletClient, encodeFunctionData, keccak256, parseAbi } from 'viem';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc, bscTestnet } from 'viem/chains';
import { getConfig } from './config.js';
import { relayerNonce, withRelayerLock } from './relayer-lock.js';
import { rpcTransport } from './rpc-transport.js';
import type { RoutingSnapshot } from './strategy-earn-mainnet.js';
import { defaultV2Reader, marketIdOf } from './strategy-earn-v2-chain.js';
import type { V2Book, V2Multicall, V2Reader } from './strategy-earn-v2-chain.js';
import { V2_REGISTRY_ABI, strategyEarnV2 } from './strategy-earn-v2.js';
import type { StrategyEarnV2 } from './strategy-earn-v2.js';

/**
 * `registry.reportRates` (cre8-contracts docs/borrow-routing-v2 §6): the numbers the chain cannot read — borrow and
 * collateral incentives per route, and the base rate + incentive of ERC4626 (Lista) vaults. A report lives 48 hours; after
 * that incentives read as 0 and a Lista vault's rate as unknown (no new borrowing into it).
 *
 * Who sends it: `registry.rateReporter()`, which on chain 97 is the OPERATOR (0xd8CE…9d7F). That key exists only in the
 * API service (OPERATOR_PRIVATE_KEY: faucet, welcome grants, account deployment), so this job runs there, under the same
 * relayer lock and nonce rule as those. The scheduler has no such key and gets none. When the configured operator is not
 * the registry's reporter the job logs it once and sends nothing.
 *
 * When: checked every hour. A report is sent when any stored report is older than 12 hours (or missing), or when any value
 * moved by 0.25% or more. The stored time and values are read from the registry (`reports(id)`), so a restart neither
 * repeats a fresh report nor lets one expire.
 *
 * What: chain 97 has simulated venues whose incentive and vault rates are public getters on the mocks; they are read
 * through the public node and posted as they are. Mainnet reads the same numbers the display uses (api.venus.io,
 * api.lista.org; `fromMainnetRates`).
 */
export const RATE_REPORT = { CHECK_MS: 60 * 60_000, MAX_AGE_MS: 12 * 60 * 60_000, MIN_CHANGE_BPS: 25, MAX_BPS: 5_000, GAS_CAP: 3_000_000n } as const;
export type RouteRate = { routeId: Hex; borrowIncentiveBps: number; collateralIncentiveBps: number };
export type VaultRate = { vaultId: Hex; baseBps: number; incentiveBps: number };
export type Rates = { routes: RouteRate[]; vaults: VaultRate[] };
export type Stored = { time: number; aBps: number; bBps: number };

const REPORTS_ABI = parseAbi(['function reports(bytes32 id) view returns (uint64 time, uint96 a, uint96 b)']);
const MOCK_ABI = parseAbi(['function borrowIncentiveAprBps(bytes32 id) view returns (uint16)', 'function collateralIncentiveAprBps(bytes32 id) view returns (uint16)',
  'function borrowIncentiveAprBps() view returns (uint16)', 'function supplyIncentiveAprBps() view returns (uint16)', 'function aprBps() view returns (uint16)', 'function incentiveAprBps() view returns (uint16)']);
const E14 = 10n ** 14n;
const clamp = (bps: number) => Math.max(0, Math.min(Math.round(bps), RATE_REPORT.MAX_BPS));

/** Chain 97: what the simulated venues pay, read off the mocks. An item that cannot be read is left out (its last report stands). */
export async function fromTestnetMocks(v2: StrategyEarnV2, book: V2Book, multicall: V2Multicall): Promise<Rates> {
  const routes = book.routes.filter(r => !r.retired), vaults = book.vaults.filter(v => !v.retired && v.venue === 'lista');
  const res = await multicall([
    ...routes.flatMap(r => r.venue === 'lista'
      ? [{ target: v2.moolah, abi: MOCK_ABI, functionName: 'borrowIncentiveAprBps', args: [r.listaId] }, { target: v2.moolah, abi: MOCK_ABI, functionName: 'collateralIncentiveAprBps', args: [r.listaId] }]
      : [{ target: r.loanVToken, abi: MOCK_ABI, functionName: 'borrowIncentiveAprBps', args: [] }, { target: r.collateralVToken, abi: MOCK_ABI, functionName: 'supplyIncentiveAprBps', args: [] }]),
    ...vaults.flatMap(v => [{ target: v.target, abi: MOCK_ABI, functionName: 'aprBps', args: [] }, { target: v.target, abi: MOCK_ABI, functionName: 'incentiveAprBps', args: [] }]),
  ]);
  const out: Rates = { routes: [], vaults: [] };
  routes.forEach((r, i) => { const b = res[i * 2], c = res[i * 2 + 1]; if (typeof b === 'number' && typeof c === 'number') out.routes.push({ routeId: r.routeId, borrowIncentiveBps: clamp(b), collateralIncentiveBps: clamp(c) }); });
  vaults.forEach((v, i) => { const base = res[routes.length * 2 + i * 2], inc = res[routes.length * 2 + i * 2 + 1];
    if (typeof base === 'number' && typeof inc === 'number') out.vaults.push({ vaultId: v.vaultId, baseBps: clamp(base), incentiveBps: clamp(inc) }); });
  return out;
}
/**
 * Mainnet: the routing snapshot built from api.venus.io / api.lista.org (src/strategy-earn-mainnet.ts), matched to the
 * registry's routes by venue, collateral symbol, loan token and (Lista) market id, and to its ERC4626 vaults by address.
 * A route or vault the snapshot does not know is left out.
 */
export function fromMainnetRates(book: V2Book, snapshot: RoutingSnapshot): Rates {
  const out: Rates = { routes: [], vaults: [] };
  for (const r of book.routes.filter(x => !x.retired)) {
    const o = (snapshot.options[r.symbol] ?? []).find(x => x.venue === r.venue && x.loan === r.loanSymbol && (r.venue === 'venus' || String(x.marketId).toLowerCase() === marketIdOf(r)));
    if (o) out.routes.push({ routeId: r.routeId, borrowIncentiveBps: clamp(o.incentiveBps), collateralIncentiveBps: clamp(o.collateralIncentiveBps) });
  }
  for (const v of book.vaults.filter(x => !x.retired && x.venue === 'lista')) {
    const s = snapshot.vaults.find(x => x.venue === 'lista' && x.address.toLowerCase() === v.target);
    if (s) out.vaults.push({ vaultId: v.vaultId, baseBps: clamp(s.baseBps), incentiveBps: clamp(s.incentiveBps) });
  }
  return out;
}

/**
 * Is a report due, and why? Due when anything was never reported, when the oldest stored report is `MAX_AGE_MS` old, or
 * when a value differs from the stored one by `MIN_CHANGE_BPS` or more. Always the whole set in one transaction (40
 * routes + 10 vaults cost about 322k gas), so every report shares one age.
 */
export function reportDue(rates: Rates, stored: (id: Hex) => Stored | undefined, nowMs: number): { due: boolean; reason: string } {
  const items = [...rates.routes.map(r => ({ id: r.routeId, a: r.borrowIncentiveBps, b: r.collateralIncentiveBps })), ...rates.vaults.map(v => ({ id: v.vaultId, a: v.baseBps, b: v.incentiveBps }))];
  if (items.length === 0) return { due: false, reason: 'nothing to report' };
  let oldest = Infinity;
  for (const x of items) {
    const s = stored(x.id);
    if (!s || s.time === 0) return { due: true, reason: 'never reported' };
    if (Math.abs(s.aBps - x.a) >= RATE_REPORT.MIN_CHANGE_BPS || Math.abs(s.bBps - x.b) >= RATE_REPORT.MIN_CHANGE_BPS) return { due: true, reason: 'a rate moved by 0.25% or more' };
    oldest = Math.min(oldest, s.time);
  }
  return nowMs - oldest * 1000 >= RATE_REPORT.MAX_AGE_MS ? { due: true, reason: 'older than 12 hours' } : { due: false, reason: 'fresh' };
}
export const reportCalldata = (rates: Rates): Hex => encodeFunctionData({ abi: V2_REGISTRY_ABI, functionName: 'reportRates', args: [
  rates.routes.map(r => ({ routeId: r.routeId, borrowIncentive: BigInt(r.borrowIncentiveBps) * E14, collateralIncentive: BigInt(r.collateralIncentiveBps) * E14 })),
  rates.vaults.map(v => ({ vaultId: v.vaultId, baseRate: BigInt(v.baseBps) * E14, incentive: BigInt(v.incentiveBps) * E14 }))] });

export type RateReportDeps = { v2: StrategyEarnV2; reader: Pick<V2Reader, 'book'>; multicall: V2Multicall; now?: () => number; log?: (line: string) => void;
  /** What to report now. */
  rates: (book: V2Book) => Promise<Rates>;
  /** The reporter key's address and a way to send the registry call with it; null = no key in this service. */
  signer: { address: Address; send(to: Address, data: Hex): Promise<Hex> } | null };
export type RateReportResult = { status: 'sent'; txHash: Hex; routes: number; vaults: number; reason: string } | { status: 'skipped'; reason: string };

/** One check (see the header). Never throws for a read failure: it reports why nothing was sent. */
export async function runRateReport(deps: RateReportDeps): Promise<RateReportResult> {
  const { v2 } = deps, now = (deps.now ?? Date.now)();
  if (deps.signer === null) return { status: 'skipped', reason: 'no operator key in this service' };
  const [reporter] = await deps.multicall([{ target: v2.registry, abi: V2_REGISTRY_ABI, functionName: 'rateReporter', args: [] }]);
  if (typeof reporter !== 'string') return { status: 'skipped', reason: 'rateReporter unreadable' };
  if (reporter.toLowerCase() !== deps.signer.address.toLowerCase()) return { status: 'skipped', reason: `the registry's rateReporter is ${reporter}, not this service's operator` };
  const book = await deps.reader.book();
  const rates = await deps.rates(book);
  const ids = [...rates.routes.map(r => r.routeId), ...rates.vaults.map(v => v.vaultId)];
  const read = await deps.multicall(ids.map(id => ({ target: v2.registry, abi: REPORTS_ABI, functionName: 'reports', args: [id] })));
  const stored = new Map<Hex, Stored>();
  ids.forEach((id, i) => { const x = read[i] as readonly [bigint, bigint, bigint] | null; if (x) stored.set(id, { time: Number(x[0]), aBps: Number(x[1] / E14), bBps: Number(x[2] / E14) }); });
  const due = reportDue(rates, id => stored.get(id), now);
  if (!due.due) return { status: 'skipped', reason: due.reason };
  const txHash = await deps.signer.send(v2.registry, reportCalldata(rates));
  return { status: 'sent', txHash, routes: rates.routes.length, vaults: rates.vaults.length, reason: due.reason };
}

/** The API service's operator as the reporter: same key, relayer lock and nonce rule as the faucet and welcome grants. */
function operatorSigner(v2: StrategyEarnV2): RateReportDeps['signer'] {
  const config = getConfig();
  if (config.chainId !== v2.chainId || !config.rpcUrl || !config.operatorPrivateKey || !/^0x[0-9a-fA-F]{64}$/.test(config.operatorPrivateKey)) return null;
  const operator = privateKeyToAccount(config.operatorPrivateKey as Hex), chain = v2.chainId === 97 ? bscTestnet : bsc;
  const transport = rpcTransport('faucet', config.rpcUrl, { retryCount: 0, timeout: 20_000 });
  const client = createPublicClient({ chain, transport }), wallet = createWalletClient({ account: operator, chain, transport });
  return { address: operator.address, send: (to, data) => withRelayerLock(v2.chainId, async assertHeld => {
    assertHeld();
    const estimate = await client.estimateGas({ account: operator.address, to, data });
    const gas = estimate * 3n / 2n;
    if (gas > RATE_REPORT.GAS_CAP) throw new Error('rate report needs more gas than its cap');
    const nonce = await relayerNonce(client, operator.address, v2.chainId);
    const raw = await wallet.signTransaction({ to, data, gas, gasPrice: await client.getGasPrice(), chainId: v2.chainId, type: 'legacy' as const,
      nonce: nonce.nonce ?? await client.getTransactionCount({ address: operator.address, blockTag: 'pending' }) });
    const hash = keccak256(raw);
    assertHeld();
    await client.sendRawTransaction({ serializedTransaction: raw });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000, confirmations: 1, pollingInterval: 1_000 });
    if (receipt.status !== 'success') throw new Error('rate report reverted ' + hash);
    return hash;
  }) };
}

let timer: ReturnType<typeof setInterval> | undefined;
/**
 * Start the hourly check in the API process. Does nothing when this chain has no v2 deployment, when the service has no
 * operator key, or with STRATEGY_EARN_V2_RATE_REPORTS=0. One line per transaction and one per failure; a skipped check is
 * silent except for a reporter mismatch (logged once).
 */
export function startRateReports(env: NodeJS.ProcessEnv = process.env): boolean {
  const v2 = strategyEarnV2(getConfig().chainId, env);
  if (v2 === null || env.STRATEGY_EARN_V2_RATE_REPORTS === '0' || timer !== undefined) return false;
  const signer = operatorSigner(v2);
  if (signer === null) return false;
  const reader = defaultV2Reader(v2, env);
  let mismatchLogged = false;
  const once = async () => {
    try {
      const { v2Multicall, v2PublicRpcs } = await import('./strategy-earn-v2-chain.js');
      const { http } = await import('viem');
      const multicall = v2Multicall(createPublicClient({ transport: http(v2PublicRpcs(v2.chainId, env)[0], { timeout: 12_000, retryCount: 1 }) }));
      const rates = v2.chainId === 97 ? (book: V2Book) => fromTestnetMocks(v2, book, multicall)
        : async (book: V2Book) => { const { createMainnetRates } = await import('./strategy-earn-mainnet.js');
          const snapshot = await createMainnetRates({ markets: [...new Set(book.routes.map(r => r.symbol))].map(symbol => ({ symbol, protocol: 'lista' as const })) }).routing();
          return snapshot ? fromMainnetRates(book, snapshot) : { routes: [], vaults: [] }; };
      const result = await runRateReport({ v2, reader, multicall, rates, signer });
      if (result.status === 'sent') console.log(JSON.stringify({ level: 'info', msg: 'strategy_rate_report', txHash: result.txHash, routes: result.routes, vaults: result.vaults, reason: result.reason }));
      else if (/rateReporter is/.test(result.reason) && !mismatchLogged) { mismatchLogged = true; console.warn(JSON.stringify({ level: 'warn', msg: 'strategy_rate_report_skipped', reason: result.reason })); }
    } catch (error) {
      console.warn(JSON.stringify({ level: 'warn', msg: 'strategy_rate_report_failed', reason: String((error as Error)?.message ?? error).split('\n')[0]!.replace(/https?:\/\/\S+/g, '<url>').slice(0, 160) }));
    }
  };
  // First check a minute after start (the service is up and answering first), then hourly.
  setTimeout(() => { void once(); }, 60_000).unref();
  timer = setInterval(() => { void once(); }, RATE_REPORT.CHECK_MS);
  timer.unref();
  return true;
}
