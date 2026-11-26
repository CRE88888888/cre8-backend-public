import type { Address, Hex, Log } from 'viem';
import type { SchedulerQueryFn, WithTransactionFn } from './scheduler.js';
import { V2_SWAPPER_ABI, v2CashEvents } from './strategy-earn-v2.js';
import type { StrategyEarnV2, SwapEvent } from './strategy-earn-v2.js';

/**
 * The cash ledger's rule for the routing v2 cash swapper (`AtpBorrowCashSwapper`, docs/strategy-earn-routing-v2):
 * a top-up spends the portfolio's own USDT and a cash-out brings USDT back, so both are booked against the portfolio's
 * own cash, `strategy_cash_balances.allocated_cash_raw` — the same bucket its sales are booked into.
 *
 * - `ToppedUp(usdtIn)`  -> `allocated_cash_raw -= usdtIn`, never below 0: the planner only offers the swapper the own cash
 *   plus USDT no bucket claims (src/withdrawable-cash.ts `strategySpendableCash`), so what the bucket cannot cover came
 *   from unclaimed USDT, which the ledger never counted.
 * - `CashedOut(usdtOut)` -> `allocated_cash_raw += usdtOut`.
 * - A route that borrows USDT has no swap, but the same two movements: the account's own USDT the executor takes for a
 *   repayment (`repay_cash`, booked like a top-up) and USDT the strategy pays back to the account (`vault_cash`, booked like
 *   a cash-out); see `v2UsdtFlows`.
 *
 * Exactly once per event: the marker and the ledger change commit together. The marker is a `strategy_route_events` row
 * (db 0069, unique on chain + tx + log index, append-only) of kind `release` — bookkeeping rows no activity list shows —
 * with `reason` = `top_up` / `cash_out` (`vault_id` = the swapper's address, left-padded: no vault has that id) or
 * `repay_cash` / `vault_cash` (`vault_id` = the executor's address), `loan` = the token's symbol, `amount_raw` = the USDT
 * and `collateral_raw` = the loan token moved. A receipt that is
 * read again (the owner's `confirm` twice, a scheduler retry, the recovery scan below) finds the marker and changes nothing.
 * Only the same portfolio's row is touched; wallet cash, Cash Earn and other portfolios are other accounts and other tables.
 */
export const cashSwapVaultId = (swapper: Address): Hex => ('0x' + '00'.repeat(12) + swapper.slice(2).toLowerCase()) as Hex;

export type CashSwapContext = { chainId: number; portfolioId: number; account: Address };
export type CashSwapBooking = { applied: number; skipped: number };

const SYMBOL = /^[A-Za-z0-9]{1,16}$/;
/**
 * Book this account's swapper events of a verified receipt. `events` must come from `v2SwapEvents` (the swapper's own
 * logs for this account). Returns how many were booked now and how many were already there.
 */
export async function settleCashSwaps(run: WithTransactionFn, v2: StrategyEarnV2, c: CashSwapContext, events: readonly SwapEvent[]): Promise<CashSwapBooking> {
  // Events from before the ledger rule existed spent (and returned) USDT no bucket ever claimed: they are not booked.
  const from = v2.swapLedgerFromBlock ?? 0n;
  const mine = events.filter(e => e.account.toLowerCase() === c.account.toLowerCase() && e.blockNumber >= from);
  if (mine.length === 0) return { applied: 0, skipped: 0 };
  const swapper = v2.swapper ?? v2.executor;
  const symbolOf = (token: Address) => { const s = Object.entries(v2.loanTokens).find(([, a]) => a.toLowerCase() === token.toLowerCase())?.[0]; return s !== undefined && SYMBOL.test(s) ? s : null; };
  return run(async ({ query }) => {
    // The portfolio's cash row, locked like every other writer of it (strategy-jobs lockCash) but never created here: a
    // portfolio without one has no cash ledger at all (nothing claims its USDT), so there is nothing to book against.
    await query("set local lock_timeout='5s'");
    const row = await query('select portfolio_id from strategy_cash_balances where chain_id=$1 and portfolio_id=$2 for update', [c.chainId, c.portfolioId]);
    const out: CashSwapBooking = { applied: 0, skipped: 0 };
    if (row.rows.length === 0) return out;
    for (const e of mine) {
      if (e.usdtRaw < 0n || e.tokenRaw < 0n || !Number.isSafeInteger(e.logIndex) || e.logIndex < 0) throw new Error('invalid cash swap event');
      const marked = await query(`insert into strategy_route_events(chain_id,portfolio_id,account,asset,kind,reason,route_id,vault_id,from_route_id,from_vault_id,venue,loan,vault_venue,
          amount_raw,collateral_raw,tx_hash,log_index,block_number) values($1,$2,$3,null,'release',$4,null,$5,null,null,null,$6,null,$7,$8,$9,$10,$11)
        on conflict (chain_id,tx_hash,log_index) do nothing returning id`,
        [c.chainId, c.portfolioId, c.account.toLowerCase(), e.kind, cashSwapVaultId(e.kind === 'top_up' || e.kind === 'cash_out' ? swapper : v2.executor), symbolOf(e.token), e.usdtRaw.toString(), e.tokenRaw.toString(), e.txHash.toLowerCase(), e.logIndex, e.blockNumber.toString()]);
      if (marked.rows.length === 0) { out.skipped++; continue; }
      await bookCashSwap(query, c, e);
      out.applied++;
    }
    return out;
  });
}
async function bookCashSwap(query: SchedulerQueryFn, c: CashSwapContext, e: SwapEvent): Promise<void> {
  const sql = e.kind === 'top_up' || e.kind === 'repay_cash'
    ? 'update strategy_cash_balances set allocated_cash_raw=greatest(allocated_cash_raw-$3::numeric,0),updated_at=clock_timestamp() where chain_id=$1 and portfolio_id=$2 returning portfolio_id'
    : 'update strategy_cash_balances set allocated_cash_raw=allocated_cash_raw+$3::numeric,updated_at=clock_timestamp() where chain_id=$1 and portfolio_id=$2 returning portfolio_id';
  const done = await query(sql, [c.chainId, c.portfolioId, e.usdtRaw.toString()]);
  if (done.rows.length !== 1) throw new Error('missing cash ledger row');
}

/**
 * Blocks per `eth_getLogs` and how far back the recovery scan looks (about two days). 5,000 is the smallest range cap
 * among the chain-97 nodes that serve logs (bsc-prebsc-dataseed; publicnode takes 50,000): with 10,000 every range was
 * refused whenever the request failed over from publicnode.
 */
export const CASH_SWAP_LOG_CHUNK = 5_000n;
export const CASH_SWAP_LOOKBACK_BLOCKS = 240_000n;
export type CashSwapLogFilter = { address: Address; events: readonly unknown[]; args: Record<string, Address | readonly Address[]>; fromBlock: bigint; toBlock: bigint };
export type CashSwapLogReader = { getBlockNumber(): Promise<bigint>; getLogs(filter: CashSwapLogFilter): Promise<readonly Log[]> };
const SWAP_EVENTS = V2_SWAPPER_ABI.filter(x => x.type === 'event');
const TRANSFER = [{ type: 'event', name: 'Transfer', inputs: [{ type: 'address', name: 'from', indexed: true }, { type: 'address', name: 'to', indexed: true }, { type: 'uint256', name: 'value', indexed: false }] }] as const;
/**
 * What the cash ledger books for this account in a block range, straight from the logs: the swapper's `ToppedUp` /
 * `CashedOut` (the account is indexed) and the USDT transfers between the account and its strategy (`v2UsdtFlows`).
 * For the recovery below: the scheduler books its own UserOps from their receipts, an owner's are booked by `confirm`.
 * `box`: the account's strategy box (it may pay idle USDT back to the account).
 */
export async function readCashSwapEvents(reader: CashSwapLogReader, v2: StrategyEarnV2, account: Address, fromBlock: bigint, toBlock: bigint, box?: Address | null): Promise<SwapEvent[]> {
  if (fromBlock > toBlock) return [];
  const usdt = v2.loanTokens.USDT, inside = [v2.executor, ...v2.adapters, ...(box ? [box] : [])];
  const out = new Map<string, SwapEvent>();
  for (let start = fromBlock; start <= toBlock; start += CASH_SWAP_LOG_CHUNK) {
    const end = start + CASH_SWAP_LOG_CHUNK - 1n < toBlock ? start + CASH_SWAP_LOG_CHUNK - 1n : toBlock, range = { fromBlock: start, toBlock: end };
    const logs = (await Promise.all([
      v2.swapper ? reader.getLogs({ address: v2.swapper, events: SWAP_EVENTS, args: { account }, ...range }) : [],
      usdt ? reader.getLogs({ address: usdt, events: TRANSFER, args: { from: account, to: v2.executor }, ...range }) : [],
      usdt ? reader.getLogs({ address: usdt, events: TRANSFER, args: { from: inside, to: account }, ...range }) : [],
    ])).flat();
    for (const log of logs) {
      if (log.removed || log.blockNumber === null || log.transactionHash === null || log.logIndex === null) throw new Error('incomplete cash swap evidence');
      for (const e of v2CashEvents(v2, { hash: log.transactionHash, blockNumber: log.blockNumber, logs: [log] }, account, box)) out.set(`${e.txHash}:${e.logIndex}`, e);
    }
  }
  return [...out.values()].sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
}
const lastRecovery = new Map<string, number>();
/** Test hook. */
export const resetCashSwapRecovery = () => lastRecovery.clear();
/**
 * The safety net behind `settleCashSwaps`: when a portfolio's ledger claims more USDT than its account holds, look for
 * swapper events of the account that were never booked — an owner-signed close whose `confirm` never reached the API, a
 * crash between a receipt and its booking — and book them. Idempotent (the marker), bounded to the manifest's
 * `ledgerFromBlock` and the last two days, at most once per portfolio every ten minutes. Without `ledgerFromBlock` it is off.
 */
export async function recoverCashSwaps(deps: { reader: CashSwapLogReader; run: WithTransactionFn; now?: () => number; box?: () => Promise<Address | null> }, v2: StrategyEarnV2, c: CashSwapContext): Promise<number> {
  if (v2.swapLedgerFromBlock === undefined) return 0;
  const key = `${c.chainId}:${c.portfolioId}`, now = (deps.now ?? Date.now)();
  if (now - (lastRecovery.get(key) ?? -Infinity) < 10 * 60_000) return 0;
  lastRecovery.set(key, now);
  const head = await deps.reader.getBlockNumber();
  const floor = head > CASH_SWAP_LOOKBACK_BLOCKS ? head - CASH_SWAP_LOOKBACK_BLOCKS : 0n;
  const events = await readCashSwapEvents(deps.reader, v2, c.account, floor > v2.swapLedgerFromBlock ? floor : v2.swapLedgerFromBlock, head, deps.box ? await deps.box() : null);
  return (await settleCashSwaps(deps.run, v2, c, events)).applied;
}
