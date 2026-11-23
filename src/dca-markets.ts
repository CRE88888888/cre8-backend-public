import type { Address, Hex } from 'viem';

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
/**
 * DCA (定投, db 0064) vault markets of this smart account that may still hold the plan's shares
 * (every plan that is not closed; a completed Aave plan can keep interest dust). Those shares are a
 * separate ledger, so portfolio valuation and the per-asset yield read leave these markets out.
 * A failed read returns []: the shares then show up as an untracked receipt and the valuation is
 * reported unknown (trading stops), never silently counted as portfolio cash.
 */
export async function readDcaMarkets(query: Query, chainId: number, account: Address): Promise<Hex[]> {
  if (chainId !== 97) return [];
  try {
    const rows = (await query(`select distinct market_id from dca_plans where chain_id=$1 and account=$2 and state<>'closed'`,
      [chainId, account.toLowerCase()])).rows;
    return rows.flatMap(row => {
      const id = row && typeof row === 'object' ? (row as { market_id?: unknown }).market_id : undefined;
      return typeof id === 'string' && /^0x[0-9a-f]{64}$/.test(id) ? [id as Hex] : [];
    });
  } catch { return []; }
}
