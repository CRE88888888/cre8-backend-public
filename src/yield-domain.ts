import type { Address, Hex } from 'viem';
import { AppError } from './errors.js';
import profileHashes from './testnet-codehashes.js';
import { TESTNET_97 } from './testnet-profile.js';

export const UINT256_MAX = (1n << 256n) - 1n;
export const RAY = 10n ** 27n;
export const WAD = 10n ** 18n;
export type YieldProtocol = 'venus' | 'lista' | 'aave_v3';
export type YieldMarket = Readonly<{ id: string; marketId: Hex; protocol: YieldProtocol; asset: Address; symbol: string;
  receipt: Address; target: Address; simulated: boolean }>;
export type YieldProfile = Readonly<{ chainId: 97; registry: Address; executor: Address; registryCodeHash?: Hex; reservationMode?: 'db_only'; markets: readonly YieldMarket[] }>;
export const unavailable = () => new AppError(503, 'YIELD_UNAVAILABLE', '生息資料或持久化證據不完整，保留部位與在途');
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
}
export function address(value: unknown): Address {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/.test(value)) throw unavailable();
  return `0x${value.slice(2).toLowerCase()}`;
}
export function hash(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw unavailable();
  return `0x${value.slice(2).toLowerCase()}`;
}
export function raw(value: unknown): bigint {
  if (typeof value === 'bigint' && value >= 0n && value <= UINT256_MAX) return value;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) > UINT256_MAX) throw unavailable();
  return BigInt(value);
}
/** BE-4 owns the generated profile. No address/initial APR fallback or mainnet admission. */
export function yieldProfile(value: unknown = TESTNET_97): YieldProfile | null {
  const p = object(value), contracts = object(p.contracts);
  if (p.chainId !== 97) throw unavailable();
  if (p.yieldMarkets === undefined && contracts.yieldRegistry === undefined) return null;
  if (!Array.isArray(p.yieldMarkets) || !p.yieldMarkets.length || p.yieldMarkets.length > 64) throw unavailable();
  const markets = p.yieldMarkets.map((item: unknown): YieldMarket => {
    const m = object(item);
    const protocol = m.protocol === 'Venus' ? 'venus' : m.protocol === 'Lista' ? 'lista' : m.protocol === 'Aave' ? 'aave_v3' : null;
    if (!protocol || m.rateType !== 'fixed_simulated_APR' || typeof m.symbol !== 'string' || !/^[A-Za-z0-9_]{1,24}$/.test(m.symbol)) throw unavailable();
    // Stable public slug for 0032; chain identity remains the distinct bytes32 marketId.
    return { id: `${protocol}_${m.symbol.toLowerCase()}`, marketId: hash(m.marketId), protocol, asset: address(m.asset),
      symbol: m.symbol, receipt: address(m.receipt), target: address(m.target), simulated: true };
  });
  if (new Set(markets.map(m => m.marketId)).size !== markets.length || new Set(markets.map(m => m.receipt)).size !== markets.length) throw unavailable();
  return { chainId: 97, registry: address(contracts.yieldRegistry), executor: address(contracts.executor), registryCodeHash:hash(profileHashes.yieldRegistry), markets };
}
export type Observation = { block: bigint; blockHash: Hex; at: Date; source: string };
export type YieldRisk = Observation & { key: string; protocol: YieldProtocol; asset: Address; riskSource: Address; underlyingMarketId: Hex | null;
  configuration: Hex; state: 'known' | 'unknown'; reason: string | null; supply: bigint | null; liquidity: bigint | null;
  exposure: bigint | null; externalReserved: bigint | null; headroom: bigint | null; utilizationBps: number | null };
export type YieldPosition = Observation & { market: YieldMarket; state: 'known' | 'unknown'; reason: string | null;
  receipt: bigint | null; observedUnits: bigint | null; trackedUnits: bigint | null; claim: bigint | null; value: bigint | null;
  maxWithdraw: bigint | null; maxRedeem: bigint | null; rate: bigint | null; scale: bigint | null;
  aprBps: bigint | null; retired?: boolean; withdrawPaused?: boolean; supplyOpen: boolean; exiting: boolean; underlyingDecimals: number; receiptDecimals: number };
export type YieldRead = { profile: YieldProfile; positions: YieldPosition[]; risks: YieldRisk[]; accountValue: bigint | null; observation: Observation };
export function fresh(at: Date, now: Date): boolean {
  const age = now.getTime() - at.getTime();
  return Number.isFinite(age) && age >= 0 && age <= 60_000;
}
const min = (...ns: bigint[]) => ns.reduce((a, b) => a < b ? a : b);
export function riskHeadroom(risks: readonly YieldRisk[], dbReserved: ReadonlyMap<string, bigint>, now: Date): bigint {
  if (!risks.length) return 0n;
  const anchor = risks[0];
  let available = UINT256_MAX;
  for (const r of risks) {
    if (!fresh(r.at, now) || r.state !== 'known' || r.block !== anchor?.block || r.blockHash !== anchor.blockHash ||
      r.supply === null || r.supply === 0n || r.liquidity === null || r.exposure === null || r.externalReserved === null ||
      r.headroom === null || r.utilizationBps === null || r.utilizationBps > 8000 || !dbReserved.has(r.key)) return 0n;
    const reserved = dbReserved.get(r.key);
    if (reserved === undefined || reserved < 0n) throw unavailable();
    const capacity = min(r.supply / 100n, r.liquidity / 10n) - r.exposure - r.externalReserved - reserved;
    available = min(available, capacity, r.headroom - reserved);
  }
  return available > 0n ? available : 0n;
}
export function mustExit(p: YieldPosition, risks: readonly YieldRisk[], sticky: boolean, now: Date): boolean {
  return sticky || p.exiting || p.state === 'unknown' || !fresh(p.at, now) || !risks.length || risks.some(r =>
    r.state === 'unknown' || !fresh(r.at, now) || r.utilizationBps === null || r.utilizationBps >= 9000);
}
export type YieldSources = Partial<Record<'allocated_cash_raw' | 'stack_prefund_raw' | 'yield_raw' | 'asset_holding', string>>;
/** Retain ALL prefunding until a proven per-period liquidity schedule is available. */
export function idleCash(b: { allocated: bigint; earnings: bigint; observed: bigint; classified: bigint }): bigint {
  if (b.observed !== b.classified || Object.values(b).some(n => n < 0n)) return 0n;
  return b.allocated + b.earnings;
}
export function supplyDecision(input: { idle: bigint; capacity: bigint; assetValue: bigint; assetAmount: bigint;
  consent: boolean; selected: boolean; cooldown: boolean; exiting: boolean; enabled: boolean }): bigint {
  if (!input.consent || !input.selected || !input.cooldown || input.exiting || !input.enabled || input.assetAmount <= 0n || input.assetValue <= 0n) return 0n;
  const amount = min(input.idle, input.capacity, input.assetAmount);
  return amount > 0n && amount * input.assetValue / input.assetAmount >= 50n * WAD ? amount : 0n;
}
/** Receipt values already include principal and accrued interest. Never add them to spendable balances. */
export function accountValue(direct: bigint | null, positions: readonly YieldPosition[], now: Date): bigint | null {
  if (direct === null || positions.some(p => p.state !== 'known' || !fresh(p.at, now) || p.value === null)) return null;
  return direct + positions.reduce((n, p) => n + (p.value ?? 0n), 0n);
}
export function restoreSources(supplies: readonly { assets: bigint; shares: bigint; sources: YieldSources }[], withdrawals: readonly { shares: bigint; assets: bigint }[]): YieldSources {
  // FIFO receipts and exact final-lot remainder. Interest stays yield_raw, never new product funding.
  const lots = supplies.map(s => ({ ...s, sources: { ...s.sources }, left: s.shares }));
  const returned: YieldSources = {};
  for (const w of withdrawals) {
    let shares = w.shares, principal = 0n;
    const portions:Partial<Record<keyof YieldSources,bigint>>={};
    for (const lot of lots) {
      if (!shares || !lot.left) continue;
      const take = min(shares, lot.left);
      for (const [key, value] of Object.entries(lot.sources)) {
        if (!isSource(key)) throw unavailable();
        const left = raw(value), part = take === lot.left ? left : left * take / lot.left;
        lot.sources[key] = (left - part).toString();
        portions[key]=(portions[key]??0n)+part; principal += part;
      }
      lot.left -= take; shares -= take;
    }
    if (shares !== 0n) throw unavailable();
    const realizable=principal<w.assets?principal:w.assets;
    const credits=Object.entries(portions).flatMap(([key,part])=>{
      if(!isSource(key)||part===undefined)throw unavailable();
      if(part===0n)return[];
      return[{key,amount:principal===0n?0n:part*realizable/principal,remainder:principal===0n?0n:part*realizable%principal}];
    });
    let remainder=realizable-credits.reduce((n,c)=>n+c.amount,0n);
    credits.sort((a,b)=>a.remainder===b.remainder?a.key.localeCompare(b.key):a.remainder>b.remainder?-1:1);
    for(const c of credits){if(remainder>0n){c.amount++;remainder--;}returned[c.key]=(raw(returned[c.key]??'0')+c.amount).toString();}
    if(remainder!==0n)throw unavailable();
    returned.yield_raw = (raw(returned.yield_raw ?? '0') + (w.assets>principal?w.assets-principal:0n)).toString();
  }
  return returned;
}
export type ScaledSourceEvent = { assets: bigint; unitsBefore: bigint; unitsAfter: bigint } &
  ({ kind: 'supply'; sources: YieldSources } | { kind: 'withdraw' });
/** Aave raw aTokens rebase. Consume source basis in proportion to proven scaled units instead.
 * Replay in chain order so later deposits never fund earlier exits; zero units consumes all dust.
 */
export function restoreScaledSources(events: readonly ScaledSourceEvent[]): YieldSources {
  const remaining: YieldSources = {}, returned: YieldSources = {};
  let units = 0n;
  for (const e of events) {
    const before = raw(e.unitsBefore), after = raw(e.unitsAfter), assets = raw(e.assets);
    if (before !== units) throw unavailable();
    if (e.kind === 'supply') {
      if (after <= before || assets === 0n) throw unavailable();
      let principal = 0n;
      for (const [key, value] of Object.entries(e.sources)) {
        if (!isSource(key)) throw unavailable();
        const part = raw(value); principal += part;
        remaining[key] = raw(raw(remaining[key] ?? '0') + part).toString();
      }
      if (principal !== assets) throw unavailable();
    } else {
      if (before === 0n || after >= before) throw unavailable();
      const consumed = before - after;
      // Reuse the exact realized-loss/interest allocation, without changing fixed-share markets.
      const basis = Object.values(remaining).reduce((sum, value) => sum + raw(value), 0n);
      const credits = restoreSources([{ assets: basis, shares: before, sources: remaining }], [{ shares: consumed, assets }]);
      for (const [key, value] of Object.entries(remaining)) {
        if (!isSource(key)) throw unavailable();
        const left = raw(value);
        remaining[key] = (left - (after === 0n ? left : left * consumed / before)).toString();
      }
      for (const [key, value] of Object.entries(credits)) {
        if (!isSource(key)) throw unavailable();
        returned[key] = raw(raw(returned[key] ?? '0') + raw(value)).toString();
      }
    }
    units = after;
  }
  return returned;
}
export function isSource(key: string): key is keyof YieldSources {
  return ['allocated_cash_raw', 'stack_prefund_raw', 'yield_raw', 'asset_holding'].includes(key);
}

/** A broadcast may have landed before its DB settlement; never invent funding from that difference. */
export function cashDifference(difference:bigint,reconciliationPending:boolean){
  return {unclassifiedRaw:reconciliationPending?null:difference>=0n?difference.toString():null,
    deficitRaw:reconciliationPending?null:difference<0n?(-difference).toString():'0',reconciliationPending};
}
