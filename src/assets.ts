import { query as dbQuery } from './db.js';

/**
 * 可定價資產清單（`priceable_assets`）。
 *
 * 為什麼需要這支：create fund 的資產選單不能寫死在前端。`priceable_assets` 是**站上自己維護**的表
 * （bStock 沒有官方 token list），只有它有「這個代幣能不能定價、decimals 是多少、哪一個是 numeraire」。
 * 前端若複製一份清單，會在有人新增代幣時安靜地過期 —— 而症狀是「選單裡有、送出卻失敗」。
 *
 * 只回 `enabled = true`：停用中的資產仍然在表裡（歷史策略還會引用它），但不該出現在**新的**選單裡。
 */
export type PriceableAsset = {
  address: string;
  symbol: string;
  decimals: number;
  /** true = 計價的基準幣（USDT）。策略的每一條腿都是 `資產 ↔ numeraire`。 */
  isNumeraire: boolean;
};

type QueryFn = (text: string, params?: readonly unknown[]) => Promise<{ rows: unknown[] }>;

const SQL_ASSETS = `
  select address, symbol, decimals, is_numeraire
    from priceable_assets
   where enabled
   order by is_numeraire desc, symbol asc
`;

export async function listPriceableAssets(query: QueryFn = dbQuery): Promise<PriceableAsset[]> {
  const { rows } = await query(SQL_ASSETS);

  return rows.map((row) => {
    const fields = row as Record<string, unknown>;
    const address = fields.address;
    const symbol = fields.symbol;
    const decimals = fields.decimals;
    if (typeof address !== 'string' || typeof symbol !== 'string' || typeof decimals !== 'number') {
      // 這張表是自己維護的；一列壞掉代表有人手動改過 DB。大聲失敗比回一個 `undefined` 的 symbol 好。
      throw new Error(`priceable_assets 有一列形狀不對：${JSON.stringify(row)}`);
    }
    return { address, symbol, decimals, isNumeraire: fields.is_numeraire === true };
  });
}
