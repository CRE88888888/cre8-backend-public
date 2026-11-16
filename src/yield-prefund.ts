import { keccak256, toHex } from 'viem';
import { fresh, object, raw, unavailable, UINT256_MAX } from './yield-domain.js';
import type { YieldStateQuery } from './yield-runtime-state.js';
import type { YieldPosition } from './yield-domain.js';

/** Each persisted per-asset budget already includes its share of the execution fee.
 * Mirror asset-jobs' base/final remainder and unreserved carry, without advancing slots.
 * Legacy instructions have no supported fee schedule and keep all prefunding liquid.
 */
export async function stackLiquidityReserve(db: YieldStateQuery, chainId: number, portfolioId: number, now: Date): Promise<bigint | null> {
  if (!Number.isFinite(+now)) return null;
  if ((await db(`select revision from stack_instructions where chain_id=$1 and portfolio_id=$2 and state='active'
    union all select id from strategy_funding_lots where chain_id=$1 and portfolio_id=$2 and state='reorged'`, [chainId, portfolioId])).rows.length) return null;
  const rows = (await db(`select a.budget_raw::text,a.effective_slices,a.first_slot_at,e.value->'execution' as mode,
      (select count(*)::int from strategy_asset_slices s where (s.lot_id,s.asset)=(a.lot_id,a.asset)) as next_index,
      coalesce((select case when s.job_id is null then case when s.state='deferred_min_asset' then s.budget_raw else s.carry_in_raw end else 0 end
        from strategy_asset_slices s where (s.lot_id,s.asset)=(a.lot_id,a.asset) order by s.slice_index desc limit 1),0)::text as carry
    from strategy_funding_lots l left join strategy_lot_assets a on a.lot_id=l.id
    left join strategy_versions v on (v.strategy_id,v.version)=(l.strategy_id,l.version)
    left join lateral jsonb_array_elements(case when jsonb_typeof(v.execution->'assets')='array' then v.execution->'assets' else '[]'::jsonb end) e
      on e.value->>'asset'=a.asset
    where l.chain_id=$1 and l.portfolio_id=$2 and l.kind='asset' and l.state='confirmed'
      and (a.state='active' or a.lot_id is null) order by l.id,a.asset`, [chainId, portfolioId])).rows;
  try {
    let total = 0n;
    for (const value of rows) {
      const row = object(value), mode = object(row.mode);
      if (mode.kind === 'hold') continue;
      if (mode.kind !== 'stack' || (mode.every !== 'daily' && mode.every !== 'weekly') ||
          !(row.first_slot_at instanceof Date) || !Number.isFinite(+row.first_slot_at) ||
          typeof row.effective_slices !== 'number' || !Number.isInteger(row.effective_slices) || row.effective_slices < 1 || row.effective_slices > 52 ||
          typeof row.next_index !== 'number' || !Number.isInteger(row.next_index) || row.next_index < 0 || row.next_index > row.effective_slices) return null;
      const period = mode.every === 'daily' ? 86400000 : 604800000;
      // Expired unrecorded windows will be skipped by the normal job planner, never caught up.
      const index = Math.max(row.next_index, Math.floor((+now - +row.first_slot_at) / period), 0);
      if (index >= row.effective_slices) continue;
      const budget = raw(row.budget_raw), count = BigInt(row.effective_slices), base = budget / count;
      if (base === 0n) return null;
      total += (index === row.effective_slices - 1 ? budget - base * (count - 1n) : base) + raw(row.carry);
      if (total > UINT256_MAX) return null;
    }
    return total;
  } catch { return null; }
}

/** Durable, deduplicated public facts. Never store RPC/DB exception text or credentials. */
export type PrefundWaitReason = 'schedule_unknown' | 'cash_unreconciled' | 'withdraw_requested' | 'withdraw_failed' | 'market_unavailable' | 'installment_deferred';
export async function recordPrefundWait(db: YieldStateQuery, chainId: number, portfolioId: number,
  required: bigint | null, liquid: bigint, reason: PrefundWaitReason, context: { now: Date; marketId: string | null }): Promise<void> {
  if(!Number.isFinite(+context.now))throw unavailable();
  const rows=(await db(`select l.id::text as lot_id,a.asset,a.first_slot_at,a.effective_slices,
      (select count(*)::int from strategy_asset_slices s where (s.lot_id,s.asset)=(a.lot_id,a.asset)) as next_index,
      e.value->'execution'->>'every' as every
    from strategy_funding_lots l join strategy_lot_assets a on a.lot_id=l.id
    join strategy_versions v on (v.strategy_id,v.version)=(l.strategy_id,l.version),jsonb_array_elements(v.execution->'assets') e
    where l.chain_id=$1 and l.portfolio_id=$2 and l.state='confirmed' and a.state='active'
      and e.value->>'asset'=a.asset and e.value->'execution'->>'kind'='stack' order by l.id,a.asset`,[chainId,portfolioId])).rows;
  const periods=rows.map(value=>{
    const r=object(value),period=r.every==='daily'?86400000:r.every==='weekly'?604800000:null;
    const index=period!==null&&r.first_slot_at instanceof Date&&Number.isFinite(+r.first_slot_at)&&typeof r.next_index==='number'&&Number.isInteger(r.next_index)
      ?Math.max(r.next_index,Math.floor((+context.now-+r.first_slot_at)/period),0):null;
    return{lotId:r.lot_id,asset:r.asset,slotIndex:index};
  });
  const value = { chainId, portfolioId, requiredRaw: required?.toString() ?? null, liquidRaw: raw(liquid).toString(), reason,
    marketId:context.marketId,periods,unknownWindow:periods.length===0||periods.some(p=>p.slotIndex===null)?context.now.toISOString().slice(0,10):null };
  const identity={chainId,portfolioId,reason,marketId:value.marketId,periods,unknownWindow:value.unknownWindow};
  const key=keccak256(toHex(JSON.stringify(identity))).slice(2),name=`fact-prefund-${chainId}-${portfolioId}-${key}`;
  await db(`insert into yield_runtime_state(name,kind,value) values($1,'fact',$2::jsonb) on conflict(name) do nothing`,[name,JSON.stringify(value)]);
  const match=(await db("select kind='fact' and value @> $2::jsonb as matches from yield_runtime_state where name=$1",[name,JSON.stringify(identity)])).rows[0];
  if(object(match).matches!==true)throw unavailable();
}

export type PrefundBasisEvent = { kind: 'supply' | 'withdraw'; assets: bigint; before: bigint; after: bigint; prefund: bigint };
/** Same redemption units as the existing exit path; round only the shortfall up to a receipt. */
export function prefundWithdrawal(p: YieldPosition, gap: bigint, units: bigint, now: Date): bigint {
  if (gap <= 0n) return 0n;
  if (p.state !== 'known' || !fresh(p.at, now) || p.observedUnits !== units || p.trackedUnits !== units ||
      p.receipt === null || p.rate === null || p.rate <= 0n || p.scale === null || p.scale <= 0n ||
      p.maxWithdraw === null || p.maxRedeem === null || p.withdrawPaused) return 0n;
  const scaled = p.market.protocol === 'aave_v3';
  const wanted = scaled ? gap : (gap * p.scale + p.rate - 1n) / p.rate;
  const liquid = scaled ? p.maxWithdraw : p.maxWithdraw * p.scale / p.rate;
  return raw([wanted, liquid, p.maxRedeem, p.receipt].reduce((a, b) => a < b ? a : b));
}
/** Outstanding source basis, including basis lost on redemption. Losses cannot be replenished
 * from other buckets. Fixed shares consume FIFO; rebasing receipts consume scaled proportions.
 */
export function prefundBasis(events: readonly PrefundBasisEvent[], scaled: boolean): { principal: bigint; units: bigint } {
  const lots: { units: bigint; principal: bigint }[] = [];
  let units = 0n;
  for (const e of events) {
    if (raw(e.before) !== units) throw unavailable();
    const after = raw(e.after), assets = raw(e.assets), prefund = raw(e.prefund);
    if (e.kind === 'supply') {
      if (after <= units || prefund > assets) throw unavailable();
      if (scaled) {
        const principal = lots.reduce((n, l) => n + l.principal, 0n) + prefund;
        lots.splice(0, lots.length, { units: after, principal });
      } else lots.push({ units: after - units, principal: prefund });
    } else {
      if (after >= units) throw unavailable();
      let take = units - after;
      for (const lot of lots) {
        if (take === 0n || lot.units === 0n) continue;
        const consumed = take < lot.units ? take : lot.units;
        lot.principal -= consumed === lot.units ? lot.principal : lot.principal * consumed / lot.units;
        lot.units -= consumed; take -= consumed;
      }
      if (take !== 0n) throw unavailable();
    }
    units = after;
  }
  return { principal: raw(lots.reduce((n, l) => n + l.principal, 0n)), units };
}
