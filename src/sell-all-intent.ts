import { MIX_EXIT_MAX_RETRIES, MIX_EXIT_RETRY_COUNT_CAP, MIX_MIN_TRADE_RAW, mixBelowExecutorMinimum, mixExitCooldownMs } from './mix-runtime.js';
import type { RebalancePlan } from './rebalance-plan.js';
import { holdsOnlyCash } from './sell-all-resume.js';
import { valuationHoldings } from './snapshot.js';
import type { PortfolioPlan } from './snapshot.js';
import { numeraireFor } from './strategy-execution.js';

/**
 * "Sell all" stays with the backend until it is done (2026-11-25, testnet portfolio 33).
 *
 * `/portfolios/:id/close` sells one batch per call, and with Strategy Earn on its first call only repays and takes the
 * shares back ("下一輪再賣"). The request to sell everything lived in that HTTP call alone: when the client went away
 * (a 30 second proxy timeout on a 28.5 second round), the scheduler's next round saw consent still on and idle shares
 * and opened the strategy again. Nothing was sold and the strategy was back on.
 *
 * The request is now a row. `/close` writes it before its first round and the scheduler reads it when it claims:
 *   - a portfolio with an open request is run as "sell all" (the same plan and pipeline as `/close`), never as a
 *     rebalance, a new-money buy, a DCA buy or a Strategy Earn open. It is claimed while paused too, because `/close`
 *     pauses after its first executed batch;
 *   - while the caller keeps calling `/close` the scheduler waits (SELL_ALL_CALLER_SECONDS after the last call), then
 *     goes on by itself every round;
 *   - the request is over when a round finds the account holding nothing but cash (or only a residue the executor
 *     cannot sell): the portfolio is left paused, exactly as after a `/close` that sold everything, and the owner
 *     withdraws the USDT;
 *   - the owner's new money or buy (`/rebalance`, a funding lot, a DCA deposit, `execution-state`) ends it and the
 *     portfolio is managed again.
 *
 * Where the row lives: `user_notifications` (db 0038), kind `sell_all_requested`, one row per request, written once and
 * never edited — the table's own rule. Its one-way state is the request's life: `pending` = still selling,
 * `delivered` = sold, `failed` = the owner put money back in before it finished. No reader shows this kind (My mix reads
 * `mix_%` only) and nothing else moves a notification's state. A portfolio without a cash ledger row (a legacy drift
 * portfolio) cannot hold the row: `/close` then works as before, one call at a time.
 *
 * My mix: an exiting, exited or deleting mix already sells everything through its own persisted exit (`mixes`), so no
 * request is written for it.
 */
export const SELL_ALL_KIND = 'sell_all_requested';

const OPEN = `n.kind = '${SELL_ALL_KIND}' and n.state = 'pending'`;
/** The My mix states that sell everything on their own (same rows as `RESUME_AFTER_SELL_ALL_SQL` leaves alone). */
const MIX_OWN_EXIT = (portfolio: string) => `exists(select 1 from mix_portfolio_history h join mixes m on m.id = h.mix_id where h.portfolio_id = ${portfolio}
    and (h.ended_at is not null or m.status <> 'active' or m.triggered_at is not null
      or m.delete_requested_at is not null or m.deleted_at is not null))`;

/** Scheduler claim (`p` = portfolios, `$2` = chain id): this portfolio has an open "sell all". */
export const SELL_ALL_OPEN_SQL = `exists(select 1 from user_notifications n where n.chain_id = $2 and n.portfolio_id = p.id and ${OPEN})`;

/** The same for a query that has no chain id at hand (`p` = portfolios; portfolio ids are unique across chains). */
export const SELL_ALL_OF_PORTFOLIO_SQL = `exists(select 1 from user_notifications n where n.portfolio_id = p.id and ${OPEN})`;

/**
 * `$1` chain id, `$2` portfolio id. Inserts nothing when a request is already open, the mix exits on its own, or there is
 * no cash ledger row. The key is the portfolio and the request's number, so two calls at the same moment write one row.
 */
const REQUEST_SQL = `insert into user_notifications (chain_id, portfolio_id, owner, kind, dedup_key)
  select c.chain_id, c.portfolio_id, a.owner, '${SELL_ALL_KIND}',
         c.portfolio_id::text || ':' || (select count(*) + 1 from user_notifications e where e.chain_id = c.chain_id and e.portfolio_id = c.portfolio_id and e.kind = '${SELL_ALL_KIND}')::text
    from strategy_cash_balances c
    join smart_accounts a on (a.portfolio_id, a.chain_id, a.address) = (c.portfolio_id, c.chain_id, c.account)
   where c.chain_id = $1 and c.portfolio_id = $2
     and not exists(select 1 from user_notifications n where n.chain_id = c.chain_id and n.portfolio_id = c.portfolio_id and ${OPEN})
     and not ${MIX_OWN_EXIT('c.portfolio_id')}
  on conflict (chain_id, kind, dedup_key) do nothing`;
const IS_OPEN_SQL = `select 1 from user_notifications n where n.chain_id = $1 and n.portfolio_id = $2 and ${OPEN} limit 1`;
const close = (state: 'delivered' | 'failed') => `update user_notifications n set state = '${state}', updated_at = clock_timestamp()
   where n.portfolio_id = $1 and ${OPEN}`;
/** `$1` portfolio id: the sale is over. */
export const FINISH_SELL_ALL_SQL = close('delivered');
/** `$1` portfolio id: the owner wants the portfolio managed again (bought, paused or resumed by hand). */
export const CANCEL_SELL_ALL_SQL = close('failed');
/**
 * `$1` portfolio id: the owner's new money while a "sell all" is still open ends it, and the portfolio that `/close`
 * paused on the way is managed again. Without an open request nothing changes (`RESUME_AFTER_SELL_ALL_SQL` covers the
 * portfolio whose sale already finished).
 */
export const NEW_MONEY_ENDS_SELL_ALL_SQL = `with ended as (${CANCEL_SELL_ALL_SQL} returning 1)
  update portfolios p set schedule_state = 'active', next_run_at = null
   where p.id = $1 and exists(select 1 from ended) and p.schedule_state = 'paused' and not ${MIX_OWN_EXIT('p.id')}`;
/** `$1` portfolio id: pause only while the request is still open (the owner may have put money back in during the round). */
const PAUSE_IF_OPEN_SQL = `update portfolios p set schedule_state = 'paused' where p.id = $1 and ${SELL_ALL_OF_PORTFOLIO_SQL}`;
const PAUSE_SQL = "update portfolios set schedule_state = 'paused' where id = $1";
/**
 * While the caller is still calling `/close` (the app sells batch after batch) the scheduler stays out of its way: every
 * call moves the portfolio's next scheduler round to this long after it. A scheduler round in between would hold the
 * portfolio lock and the caller's next batch would come back `[PORTFOLIO_LOCK_BUSY]`. Once the caller has been silent
 * for this long the scheduler takes over — also for a portfolio whose own next round was further away.
 */
export const SELL_ALL_CALLER_SECONDS = 90;
const CALLER_IS_HERE_SQL = `update portfolios p set next_run_at = now() + interval '${SELL_ALL_CALLER_SECONDS} seconds' where p.id = $1 and ${SELL_ALL_OF_PORTFOLIO_SQL}`;
const RESOLVE_ALERTS_SQL = 'update scheduler_alerts set resolved_at = now() where portfolio_id = $1 and resolved_at is null';

type Run = (sql: string, params?: readonly unknown[]) => Promise<{ rows: unknown[] }>;

/**
 * `/close`: record the owner's request. True when a request is open afterwards (this one or an earlier one); false when
 * the portfolio cannot hold one (see the file header) — the caller then finishes the sale within its own calls, as before.
 */
export async function requestSellAll(run: Run, chainId: number, portfolioId: number): Promise<boolean> {
  await run(REQUEST_SQL, [chainId, portfolioId]);
  await run(CALLER_IS_HERE_SQL, [portfolioId]);
  return (await run(IS_OPEN_SQL, [chainId, portfolioId])).rows.length > 0;
}

/** `/close`, after its round: the request is still open and the caller may call again (see SELL_ALL_CALLER_SECONDS). */
export async function sellAllCallerIsHere(run: Run, portfolioId: number): Promise<void> {
  await run(CALLER_IS_HERE_SQL, [portfolioId]);
}

/**
 * Whether the sale is over, from what one round saw before it traded: nothing but cash is held (under 0.01 USDT of
 * anything else, the rule a later deposit uses to recognise a sold portfolio), or the planner found nothing to sell, or
 * what is left is under 1 USDT in total and cannot be sold at all (the executor's floor for it is 0 — the residue rule
 * of a My mix exit; the 1 USDT bound keeps a wrong floor reading from ever leaving a real position behind).
 */
export async function sellAllOver(plan: PortfolioPlan, built: RebalancePlan,
  belowMinimum: (plan: PortfolioPlan) => Promise<boolean> = plan => mixBelowExecutorMinimum(plan)): Promise<boolean> {
  if (built.kind === 'noop' && built.reason === 'nothing to sell') return true;
  if (plan.blocked.length > 0 || plan.report === null) return false;
  if (holdsOnlyCash(plan)) return true;
  if (built.kind === 'ready' || plan.chainId !== 97) return false;
  if (plan.snapshot.unpriced.some(a => a.amountWei > 0n) || (plan.snapshot.yieldPositions ?? []).some(p => p.value === null)) return false;
  const cash = numeraireFor(plan.chainId);
  const leftUsdE8 = valuationHoldings(plan.snapshot).filter(h => h.asset.toLowerCase() !== cash).reduce((sum, h) => sum + h.amountWei, 0n);
  if (leftUsdE8 * 10n ** 10n >= MIX_MIN_TRADE_RAW) return false;
  try { return await belowMinimum(plan); } catch { return false; /* an RPC failure never proves a residue */ }
}

/**
 * After a "sell all" round (`/close` or the scheduler's): what `/close` always did — pause the portfolio and resolve its
 * alerts once a batch was sold or nothing is left — and, when nothing is left, close the request.
 * `tracked`: a request row is open for this portfolio; the pause then also needs it to be still open.
 */
export async function settleSellAll(run: Run, portfolioId: number, round: { outcome: string; over: boolean; tracked: boolean }): Promise<void> {
  if (round.outcome !== 'executed' && !round.over) return;
  await run(round.tracked ? PAUSE_IF_OPEN_SQL : PAUSE_SQL, [portfolioId]);
  await run(RESOLVE_ALERTS_SQL, [portfolioId]);
  if (round.over) await run(FINISH_SELL_ALL_SQL, [portfolioId]);
}

/**
 * Failed sales since the request (or since the last confirmed one): the streak the retry guard and the alert read. One
 * sponsored UserOp each, so the scheduler does not send a sixth one a minute later.
 */
const STREAK_SQL = `select n.created_at as since,
    (select count(*)::int from operations o where o.portfolio_id = n.portfolio_id and o.created_at >= n.created_at and o.state in ('failed', 'reverted')
       and o.id > coalesce((select max(c.id) from operations c where c.portfolio_id = n.portfolio_id and c.state = 'confirmed'), 0)) as failures,
    (select max(o.updated_at) from operations o where o.portfolio_id = n.portfolio_id and o.created_at >= n.created_at and o.state in ('failed', 'reverted')) as last_failure_at
  from user_notifications n where n.chain_id = $1 and n.portfolio_id = $2 and ${OPEN} order by n.id limit 1`;

/**
 * The same guard as a My mix exit (MIX_EXIT_MAX_RETRIES failed sends, then 5 minutes, 15 minutes, 1 hour, 6 hours
 * between tries), read from `operations` so a restart keeps it. A round that sends nothing (market closed, no oracle
 * price, shares still posted) is not a failure and is tried again every round. null: go ahead.
 */
export async function sellAllRetryAt(run: Run, chainId: number, portfolioId: number, now: Date): Promise<{ failures: number; at: Date } | null> {
  const row = (await run(STREAK_SQL, [chainId, portfolioId])).rows[0] as { failures?: unknown; last_failure_at?: unknown } | undefined;
  const failures = Number(row?.failures ?? 0);
  if (!Number.isSafeInteger(failures) || failures < MIX_EXIT_MAX_RETRIES || !(row?.last_failure_at instanceof Date)) return null;
  const at = new Date(row.last_failure_at.getTime() + mixExitCooldownMs(Math.min(failures, MIX_EXIT_RETRY_COUNT_CAP)));
  return at.getTime() > now.getTime() ? { failures, at } : null;
}

/** Alerts: every open request older than `$2` hours at `$1`, with its failure streak. */
export const SELL_ALL_OVERDUE_SQL = `select n.portfolio_id, min(n.created_at) as since,
    (select count(*)::int from operations o where o.portfolio_id = n.portfolio_id and o.created_at >= min(n.created_at) and o.state in ('failed', 'reverted')
       and o.id > coalesce((select max(c.id) from operations c where c.portfolio_id = n.portfolio_id and c.state = 'confirmed'), 0)) as failures
  from user_notifications n where ${OPEN}
  group by n.portfolio_id having min(n.created_at) <= $1::timestamptz - make_interval(hours => $2::int)
  order by n.portfolio_id`;
