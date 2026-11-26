import type { Address, Hex } from 'viem';
import { SELL_ALL_KIND } from './sell-all-intent.js';
import type { StatusReading, StrategyEarnChain } from './strategy-earn.js';
import type { V2AccountRead, V2Reader } from './strategy-earn-v2-chain.js';
import { V2_TOPUP_BUFFER_BPS, topUpMaxUsdtIn } from './strategy-earn-v2.js';
import type { StrategyEarnV2 } from './strategy-earn-v2.js';

/**
 * USDT a "sell all" still needs in the account (2026-11-25, testnet portfolio 37).
 *
 * With Earn extra on, "sell all" is several rounds: repay what the strategy box can and take that share back, sell it,
 * then pay the rest of the debt out of what the sale brought in and take the last shares back. The app withdrew the sale's
 * USDT after the second round; the third had nothing to pay with and about 2% of the position stayed posted with a sliver
 * of debt ([STRATEGY_EARN_UNWINDING] ... needs N more USDT in the account).
 *
 * So while a "sell all" is open (`sell_all_requested` pending, src/sell-all-intent.ts) and the account still owes more
 * than its strategy box holds, part of the account's USDT is not withdrawable: the owner's withdraw sheet
 * (`/portfolios/:id/execution` cash.withdrawableRaw) and the paymaster (checkFreeCash) take it off the same way. Nothing
 * is held when no "sell all" is open, when nothing is owed, or when the box covers the debt as read — and the hold is
 * gone the moment the debt is repaid or the request ends.
 *
 * How much: what the repayment planner would have to pay in from the account's USDT right now, doubled, and at least
 * 1 USDT — the rule the scheduler's own cash raise uses for the same shortfall (src/scheduler.ts `cashRaiseUsdE8`: twice
 * the need covers interest until the round comes up and a pool a little off 1:1; under 1 USDT nothing can be sold to
 * raise it again). The 24-hour top-up window (`AtpBorrowCashSwapper` WindowExceeded) can keep the repayment waiting for
 * hours: the hold stays for as long as the shortfall does.
 */
export const SELL_ALL_HOLD_MIN_RAW = 10n ** 18n;

/** The hold for a shortfall of `needUsdtRaw` (USDT raw, 18 decimals): 0 without one, otherwise twice it, at least 1 USDT. */
export function holdForShortfall(needUsdtRaw: bigint): bigint {
  if (needUsdtRaw <= 0n) return 0n;
  const twice = needUsdtRaw * 2n;
  return twice > SELL_ALL_HOLD_MIN_RAW ? twice : SELL_ALL_HOLD_MIN_RAW;
}

/** Interest of the next minutes on a repayment (0.02%), as the planner counts it (src/strategy-earn-v2.ts `driftOf`). */
const drift = (repayRaw: bigint) => repayRaw / 5_000n + 1n;

/**
 * Routing v2: USDT the account has to pay in to clear its debts as read. Per loan token: the whole debt in it, less the
 * box (vaults + idle) and — for a token other than USDT — the account's own balance of it. What is short is bought with
 * USDT through the cash swapper (the planner's own amount: gap + interest + buffer, at `maxUsdtIn`); a USDT debt is paid
 * from the account's USDT directly (`maxCashIn`).
 */
export function v2ShortfallUsdt(v2: Pick<StrategyEarnV2, 'loanTokens'>, read: Pick<V2AccountRead, 'tokens' | 'vaults'>): bigint {
  const usdt = v2.loanTokens.USDT?.toLowerCase();
  let need = 0n;
  for (const t of Object.values(read.tokens)) {
    if (t.debtRaw <= 0n) continue;
    const isUsdt = t.token.toLowerCase() === usdt;
    const box = read.vaults.filter(v => v.vault.token.toLowerCase() === t.token.toLowerCase()).reduce((sum, v) => sum + v.assetsRaw, 0n) + t.idleRaw;
    const gap = t.debtRaw - box - (isUsdt ? 0n : t.cashRaw);
    if (gap <= 0n) continue;
    const short = gap + drift(t.debtRaw);
    if (isUsdt) { need += short; continue; }
    const buffer = short * V2_TOPUP_BUFFER_BPS / 10_000n, floor = t.debtRaw / 2_500n;
    need += topUpMaxUsdtIn(short + (buffer > floor ? buffer : floor) + 1n);
  }
  return need;
}

/**
 * Yield strategy v1 (the loan is USDT): what the pre-sale repayment needs from the account's USDT to clear a debt — its
 * own bar is vault + cash >= debt x 1.001 (src/strategy-earn.ts strategyEarnUnwindForSale). Lista: per market. Venus: one
 * debt for the whole account (every Venus market reads the same `debt`), against all of its Venus vaults.
 */
export function v1ShortfallUsdt(positions: readonly { protocol: 'venus' | 'lista'; st: Pick<StatusReading, 'debt' | 'vaultAssets'> }[]): bigint {
  const bar = (debt: bigint) => debt + debt / 1_000n;
  let need = 0n;
  for (const p of positions) if (p.protocol === 'lista' && p.st.debt > 0n && p.st.vaultAssets < bar(p.st.debt)) need += bar(p.st.debt) - p.st.vaultAssets;
  const venus = positions.filter(p => p.protocol === 'venus');
  const debt = venus[0]?.st.debt ?? 0n, vaults = venus.reduce((sum, p) => sum + p.st.vaultAssets, 0n);
  if (debt > 0n && vaults < bar(debt)) need += bar(debt) - vaults;
  return need;
}

/** A function, not a constant: this module is loaded inside an import cycle (paymaster <-> mix runtime <-> sell-all-intent). */
const openSql = () => `select 1 from user_notifications n where n.chain_id = $1 and n.portfolio_id = $2 and n.kind = '${SELL_ALL_KIND}' and n.state = 'pending' limit 1`;

export type SellAllHoldInput = { chainId: number; portfolioId: number; account: Address };
export type SellAllHoldDeps = {
  query: (sql: string, params: readonly unknown[]) => Promise<{ rows: unknown[] }>;
  /** Routing v2 on this chain, with its reader; null: not deployed here. Read for every account, whoever its owner is: the
   * audience only decides who may start on v2, an account that has something there is always looked after. */
  v2: () => { v2: StrategyEarnV2; reader: Pick<V2Reader, 'touched' | 'account'> } | null;
  /** Yield strategy v1 on this chain; null: not deployed here. */
  v1: () => { chain: Pick<StrategyEarnChain, 'head' | 'accountMarkets' | 'status'>; markets: readonly { marketId: Hex; protocol: 'venus' | 'lista' }[] } | null;
};

/**
 * The hold for one portfolio account right now (USDT raw). 0 without an open "sell all" (one indexed query, no chain
 * read). Throws when the request is open and the chain cannot be read: the caller must not answer with a guess.
 */
export async function sellAllCashHold(input: SellAllHoldInput, deps: SellAllHoldDeps): Promise<bigint> {
  if ((await deps.query(openSql(), [input.chainId, input.portfolioId])).rows.length === 0) return 0n;
  // Both generations are read at once (one account is on v1 or on v2, never both; the other read finds nothing).
  const second = deps.v2(), first = deps.v1();
  const [onV2, onV1] = await Promise.all([
    (async () => {
      if (second === null) return 0n;
      const touched = await second.reader.touched(input.account);
      return touched.routes.length > 0 ? v2ShortfallUsdt(second.v2, await second.reader.account(input.account)) : 0n;
    })(),
    (async () => {
      if (first === null) return 0n;
      const head = await first.chain.head();
      const ids = await first.chain.accountMarkets(input.account, head.number);
      const entered = first.markets.filter(m => ids.includes(m.marketId));
      return v1ShortfallUsdt(await Promise.all(entered.map(async m => ({ protocol: m.protocol, st: await first.chain.status(m.marketId, input.account, head.number) }))));
    })(),
  ]);
  const need = onV2 + onV1;
  return holdForShortfall(need);
}

/** The production wiring: the public-node v2 reader, the v1 chain reader (chain 97 only), and `run` (default: this service's database). */
export async function defaultSellAllCashHold(input: SellAllHoldInput, run?: SellAllHoldDeps['query']): Promise<bigint> {
  const [{ query }, { strategyEarnV2 }, { defaultV2Reader }, { defaultStrategyEarnChain, strategyMarkets }] = await Promise.all([
    import('./db.js'), import('./strategy-earn-v2.js'), import('./strategy-earn-v2-chain.js'), import('./strategy-earn.js')]);
  return sellAllCashHold(input, {
    query: run ?? ((sql, params) => query(sql, [...params])),
    v2: () => { const v2 = strategyEarnV2(input.chainId); return v2 === null ? null : { v2, reader: defaultV2Reader(v2) }; },
    v1: () => input.chainId === 97 ? { chain: defaultStrategyEarnChain(), markets: strategyMarkets() } : null,
  });
}
