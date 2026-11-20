import type { Hex } from 'viem';
import { getChain } from './chain.js';
import type { PortfolioPlan } from './snapshot.js';
import type { SchedulerQueryFn } from './scheduler.js';
import { mixUnavailable } from './mix-store.js';

export type MixAnchor = { hash: Hex; at: Date };
export type MixValuation = { value_raw: string; net_input_raw: string; performance_input_raw: string;
  return_bps: string | null; performance_started_at: Date | null; block_number: string; block_hash: Hex; valued_at: Date };
export async function mixAnchor(block: bigint): Promise<MixAnchor> {
  const header = await getChain().publicClient.getBlock({ blockNumber: block });
  if (!header.hash) throw mixUnavailable();
  return { hash: header.hash, at: new Date(Number(header.timestamp) * 1000) };
}
export function mixValue(plan: PortfolioPlan): bigint {
  if (plan.blocked.length || plan.report === null || plan.snapshot.unpriced.some(h => h.amountWei > 0n) ||
      plan.snapshot.holdings.some(h => h.usdPriceE8 <= 0n || h.amountWei < 0n)) throw mixUnavailable();
  return plan.snapshot.holdings.reduce((sum, h) => sum + h.amountWei * h.usdPriceE8 * 10n ** 10n / 10n ** BigInt(h.decimals), 0n);
}
export async function saveMixValuation(find: SchedulerQueryFn, mixId: string, portfolioId: number, plan: PortfolioPlan, anchor: MixAnchor): Promise<void> {
  await find(`insert into mix_valuation_snapshots(mix_id,history_id,value_raw,block_number,block_hash,valued_at)
    select $1,h.id,$3,$4,$5,$6 from mix_portfolio_history h where h.mix_id=$1 and h.portfolio_id=$2 and h.ended_at is null
    on conflict(mix_id) do update set history_id=excluded.history_id,value_raw=excluded.value_raw,
      block_number=excluded.block_number,block_hash=excluded.block_hash,valued_at=excluded.valued_at
    where mix_valuation_snapshots.block_number<=excluded.block_number and mix_valuation_snapshots.valued_at<=excluded.valued_at`,
    [mixId, portfolioId, mixValue(plan).toString(), plan.snapshot.block.toString(), anchor.hash, anchor.at]);
}
