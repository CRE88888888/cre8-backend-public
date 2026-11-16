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
/** Unknown schedules retain all prefunding; reserved inputs/fees never enter idle cash. */
export function idleCash(b: { allocated: bigint; earnings: bigint; observed: bigint; classified: bigint; prefund?: bigint; reserve?: bigint | null }): bigint {
  if (b.observed !== b.classified || Object.values(b).some(n => typeof n === 'bigint' && n < 0n)) return 0n;
  const prefund = b.prefund ?? 0n;
  return b.allocated + b.earnings + (b.reserve != null && prefund > b.reserve ? prefund - b.reserve : 0n);
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
export type SourceHistoryEvent = { assets: bigint; unitsBefore: bigint; unitsAfter: bigint } &
  ({ kind: 'supply'; sources: YieldSources } | { kind: 'withdraw'; prefundTarget?: bigint });
type SourceLot = { left: bigint; sources: YieldSources };
/** Replay original evidence in chain order. Directed withdrawals exchange source cost
 * with the remaining lots, never receipt units or total cost. The same cost reduction
 * drives cash credits and outstanding prefund, so replay cannot replenish realized loss.
 */
export function restoreSourceHistory(events: readonly SourceHistoryEvent[], scaled: boolean): { returned: YieldSources; remaining: YieldSources; units: bigint } {
  let lots: SourceLot[] = [], units = 0n;
  const returned: YieldSources = {};
  for (const e of events) {
    const before=raw(e.unitsBefore),after=raw(e.unitsAfter),assets=raw(e.assets);
    if(before!==units)throw unavailable();
    if(e.kind==='supply'){
      if(after<=before||assets===0n)throw unavailable();
      let total=0n;
      for(const [key,value]of Object.entries(e.sources)){if(!isSource(key))throw unavailable();total+=raw(value);}
      if(total!==assets)throw unavailable();
      lots.push({left:after-before,sources:{...e.sources}});
      if(scaled)lots=[{left:after,sources:sumSources(lots.map(l=>l.sources))}];
    }else{
      if(before===0n||after>=before)throw unavailable();
      const prefundBefore=lots.reduce((n,l)=>n+raw(l.sources.stack_prefund_raw??'0'),0n);
      const target=e.prefundTarget===undefined?0n:raw(e.prefundTarget);
      let shares=before-after,principal=0n;
      const portions:YieldSources={};
      for(const lot of lots){
        if(shares===0n||lot.left===0n)continue;
        const take=min(shares,lot.left);
        const rounding=Object.entries(lot.sources).map(([key,value])=>{
          if(!isSource(key))throw unavailable();const basis=raw(value);
          return{key,basis,part:take===lot.left?basis:basis*take/lot.left,remainder:basis*take%lot.left};
        });
        // A directed draw must not misclassify the sum-of-floors raw as interest.
        let dust=target===0n?0n:rounding.reduce((n,c)=>n+c.basis,0n)*take/lot.left-rounding.reduce((n,c)=>n+c.part,0n);
        rounding.sort((a,b)=>a.remainder===b.remainder?a.key.localeCompare(b.key):a.remainder>b.remainder?-1:1);
        for(const c of rounding){
          const key=c.key;if(dust>0n){c.part++;dust--;}
          const value=c.basis;
          if(!isSource(key))throw unavailable();
          const left=raw(value),part=c.part;
          lot.sources[key]=(left-part).toString();
          portions[key]=(raw(portions[key]??'0')+part).toString();principal+=part;
        }
        lot.left-=take;shares-=take;
      }
      if(shares!==0n)throw unavailable();
      const preferredCost=min(target,prefundBefore,principal>assets?principal:assets);
      // A directed cash return retires that source's outstanding cost first. When
      // accrued yield makes receipt-proportional cost smaller than the requested
      // principal, retire the extra from its remaining lots (defer that yield until
      // the later exit). Loss still consumes the larger original receipt cost.
      let extra=preferredCost>principal?preferredCost-principal:0n;
      for(const lot of lots){
        const take=min(extra,raw(lot.sources.stack_prefund_raw??'0'));
        lot.sources.stack_prefund_raw=(raw(lot.sources.stack_prefund_raw??'0')-take).toString();
        portions.stack_prefund_raw=(raw(portions.stack_prefund_raw??'0')+take).toString();
        principal+=take;extra-=take;
      }
      if(extra!==0n)throw unavailable();
      // Replace consumed non-prefund cost with outstanding prefund cost. Residual
      // lots inherit the exchanged source, preserving every source's total basis.
      let exchange=preferredCost>raw(portions.stack_prefund_raw??'0')?preferredCost-raw(portions.stack_prefund_raw??'0'):0n;
      for(const lot of lots){
        let available=min(exchange,raw(lot.sources.stack_prefund_raw??'0'));
        for(const [key,value]of Object.entries(portions)){
          if(!isSource(key))throw unavailable();
          if(key==='stack_prefund_raw'||available===0n)continue;
          const take=min(available,raw(value));
          portions[key]=(raw(value)-take).toString();
          lot.sources[key]=(raw(lot.sources[key]??'0')+take).toString();
          lot.sources.stack_prefund_raw=(raw(lot.sources.stack_prefund_raw??'0')-take).toString();
          portions.stack_prefund_raw=(raw(portions.stack_prefund_raw??'0')+take).toString();
          exchange-=take;available-=take;
        }
      }
      if(exchange!==0n)throw unavailable();
      const realizable=min(principal,assets),priority=min(preferredCost,realizable);
      portions.stack_prefund_raw=(raw(portions.stack_prefund_raw??'0')-priority).toString();
      const residualCost=principal-priority,residualAssets=realizable-priority;
      const credits=Object.entries(portions).flatMap(([key,value])=>{
        if(!isSource(key))throw unavailable();const part=raw(value);if(part===0n)return[];
        return[{key,amount:residualCost===0n?0n:part*residualAssets/residualCost,remainder:residualCost===0n?0n:part*residualAssets%residualCost}];
      });
      let remainder=residualAssets-credits.reduce((n,c)=>n+c.amount,0n);
      credits.sort((a,b)=>a.remainder===b.remainder?a.key.localeCompare(b.key):a.remainder>b.remainder?-1:1);
      for(const c of credits){if(remainder>0n){c.amount++;remainder--;}returned[c.key]=(raw(returned[c.key]??'0')+c.amount).toString();}
      if(remainder!==0n)throw unavailable();
      if(priority>0n)returned.stack_prefund_raw=(raw(returned.stack_prefund_raw??'0')+priority).toString();
      returned.yield_raw=(raw(returned.yield_raw??'0')+(assets>principal?assets-principal:0n)).toString();
    }
    units=after;
  }
  return{returned,remaining:sumSources(lots.map(l=>l.sources)),units};
}
function sumSources(sources:readonly YieldSources[]):YieldSources{
  const total:YieldSources={};
  for(const s of sources)for(const [key,value]of Object.entries(s)){
    if(!isSource(key))throw unavailable();total[key]=raw(raw(total[key]??'0')+raw(value)).toString();
  }
  return total;
}
export function restoreSources(supplies: readonly { assets: bigint; shares: bigint; sources: YieldSources }[], withdrawals: readonly { shares: bigint; assets: bigint; prefundTarget?: bigint }[]): YieldSources {
  let units=0n;
  const events:SourceHistoryEvent[]=supplies.map(s=>{const before=units;units+=s.shares;return{kind:'supply',assets:s.assets,sources:s.sources,unitsBefore:before,unitsAfter:units};});
  for(const w of withdrawals){const before=units;units-=w.shares;events.push({kind:'withdraw',assets:w.assets,unitsBefore:before,unitsAfter:units,...(w.prefundTarget===undefined?{}:{prefundTarget:w.prefundTarget})});}
  return restoreSourceHistory(events,false).returned;
}
export type ScaledSourceEvent = SourceHistoryEvent;
/** Aave raw aTokens rebase; only canonical scaled units consume source basis. */
export function restoreScaledSources(events: readonly ScaledSourceEvent[]): YieldSources {
  return restoreSourceHistory(events,true).returned;
}
export function isSource(key: string): key is keyof YieldSources {
  return ['allocated_cash_raw', 'stack_prefund_raw', 'yield_raw', 'asset_holding'].includes(key);
}

/** A broadcast may have landed before its DB settlement; never invent funding from that difference. */
export function cashDifference(difference:bigint,reconciliationPending:boolean){
  return {unclassifiedRaw:reconciliationPending?null:difference>=0n?difference.toString():null,
    deficitRaw:reconciliationPending?null:difference<0n?(-difference).toString():'0',reconciliationPending};
}
