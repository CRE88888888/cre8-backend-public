import { encodeFunctionData, isAddressEqual, maxUint256, parseAbi, zeroAddress } from 'viem';
import type { Address, Hex, Log } from 'viem';
import type { Costs } from './strategy-earn-routing.js';
import { V2_DEFAULT_COSTS } from './strategy-earn-v2-api.js';
import { v2Active, v2HasState } from './strategy-earn-v2-chain.js';
import type { V2AccountRead, V2Market, V2Reader, V2Touched } from './strategy-earn-v2-chain.js';
import { V2_CASH_OUT_ALONE_MIN_RAW, boxRewardSignature, runV2Account, strandedSmallPosition, swapEventLine, swapperErrorOf, v2Batches, v2CashEvents, v2Calls, v2KeeperCall, v2PreSellPlan, v2RouteEvents } from './strategy-earn-v2.js';
import type { Call, PreSellPosition, RouteEvent, Step, StrategyEarnV2, SwapEvent } from './strategy-earn-v2.js';
import { leftoverCashOuts } from './strategy-earn-v2-swap.js';
import type { Leftover } from './strategy-earn-v2-swap.js';
import { rewardEvents } from './strategy-rewards.js';
import type { RewardEvent, RewardSignature } from './strategy-rewards.js';
import { V2_CONSENT_KEY, consentIsStale } from './strategy-earn-after-sell-all.js';
import type { ConsentSinceSellAll } from './strategy-earn-after-sell-all.js';

/**
 * Routing v2 in the scheduler (cre8-contracts docs/borrow-routing-v2, draft5). Three entry points, all for one account:
 * - `v2AutoRound`: after a quiet round (a buy has filled, nothing to trade) — the routing engine decides and the session
 *   key executes: open, top up, move (the settled rules in strategy-earn-routing ROUTING), repay, close. This is also
 *   the periodic re-evaluation: it runs every time the portfolio's round comes up.
 * - `v2UnwindForSale`: before a sale — repay the routes of the assets being sold and take the shares back.
 * - `runV2KeeperRound`: every scheduler round, with the keeper key — `executeDeleverage` at the health line (the contract's
 *   only anyone-callable trigger) and reward tokens from the strategy box into the account (`collectRewards`).
 * Every read goes through the public-node reader; every session-key UserOp carries at most three executor calls.
 *
 * Cash swapper (spec §17, src/strategy-earn-v2-swap.ts): a repayment in USDC / USD1 / U the box cannot cover is topped up
 * from the account's USDT in the same UserOp (`topUp`), and loan token left in the account once nothing is owed in it is
 * sold for USDT (`cashOut`) — with the close, or by the next round. `PegExceeded` is an operations alert; `WindowExceeded`
 * waits for the token's 24-hour window instead of being resent every round.
 */
export type V2Tx = { hash: Hex; blockNumber: bigint; logs: readonly Log[] };
export type V2Send = (calls: Call[]) => Promise<V2Tx>;
export type V2Ledger = { routes(chainId: number, events: readonly RouteEvent[]): Promise<void>; rewards(chainId: number, events: readonly RewardEvent[]): Promise<void>;
  /** Cash ledger: a top-up is taken from the portfolio's own cash, a cash-out is added to it, once per event
   * (src/strategy-cash-swaps.ts). Absent: the events are only logged (and then no top-up may spend the own cash). */
  swaps?(portfolioId: number, account: Address, events: readonly SwapEvent[]): Promise<unknown> };
/** The sale has to go ahead without some posted shares: they cannot be freed this round (see v2PreSellPlan `stuck`). */
export type V2UnwindWait = { note: string;
  /** Collateral tokens (lowercase) whose posted part stays posted for now. */
  stuck: Address[];
  /** USDT their top-ups are still short of (raw). 0: they wait for something else (the 24-hour window, the pool's peg). */
  needUsdtRaw: bigint };
export type V2StepArgs = { v2: StrategyEarnV2; reader: V2Reader; account: Address; portfolioId: number; now: Date; dryRun: boolean;
  /** null: the newest session key does not carry the routing v2 scope (the owner has not renewed) — the step only reports. */
  send: V2Send | null; ledger: V2Ledger; log: (line: string) => void; costs?: Costs;
  /** Collateral tokens the planner saw in the account (lowercase), read besides what is already posted. */
  held?: readonly string[];
  /** Is yield strategy v1 still in use on this account (a position, debt or consent)? One account uses v1 or v2, never both:
   * while this answers true the round adds nothing on v2 (it only reports). */
  v1Active?: () => Promise<boolean>;
  /**
   * What the cash ledger says about the account's USDT (src/withdrawable-cash.ts): `claimedRaw` — every bucket that claims
   * some of it (funding waiting to be bought, the portfolio's own cash, running jobs, reservations); `ownRaw` — the
   * portfolio's own cash among them (`allocated_cash_raw`). A top-up may spend the own cash and what no bucket claims: it
   * is booked against the own cash when it lands (`ledger.swaps`). A repayment on a route that borrows USDT (`maxCashIn`)
   * has no such booking and only gets what no bucket claims. Absent: nothing is claimed. A read that throws: no USDT is
   * spent this round.
   */
  cashClaims?: () => Promise<{ claimedRaw: bigint; ownRaw: bigint }>;
  /** The ledger claims more USDT than the account holds: look for swapper events of this account that were never booked
   * (an owner UserOp whose `confirm` never came, a crash between the receipt and the booking) and book them. Returns how many. */
  recoverSwaps?: () => Promise<number>;
  /** The round could not finish a repayment for lack of USDT: this much more of it is needed in the account (raw). */
  onCashNeed?: (usdtRaw: bigint) => void;
  /** A top-up or a cash-out was refused with PegExceeded (the alert: src/alerts.ts noteStrategyPegExceeded). */
  onPegExceeded?: (detail: string) => void;
  /** The owner's consent requests since the account's last finished "sell all" (src/strategy-earn-after-sell-all.ts). Absent: every consent counts. */
  consentSince?: () => Promise<ConsentSinceSellAll>;
  /** What the caller already read of this account (`reader.touched`), so the step does not ask again. */
  touched?: V2Touched;
  /** false: this owner may not start anything new on v2 (outside the audience, or new opens paused — `v2MayOpen`). The
   * account is still looked after in full — read, repaid, topped up for a repayment, closed, unwound before a sale, its
   * leftovers sold — but nothing is opened, borrowed on top or moved (strategy-earn-v2 `withoutNewRisk`). Default true. */
  mayOpen?: boolean };

const shortError = (error: unknown) => String((error as Error)?.message ?? error).split('\n')[0]!.slice(0, 160);
type SwapWatch = { peg: boolean; window: boolean; other: boolean };
/**
 * A session send that also (a) writes one log line per `ToppedUp` / `CashedOut` that landed (the record until the ledger
 * has a table for them) and (b) names a cash swapper failure: `PegExceeded` -> a structured error line (alert) and a
 * tagged error; `WindowExceeded` -> the reason, once. Everything else passes through untouched.
 */
function watchSwaps(args: Pick<V2StepArgs, 'v2' | 'portfolioId' | 'account' | 'log' | 'ledger' | 'reader' | 'onPegExceeded'>, send: V2Send, seen: SwapWatch): V2Send {
  return async calls => {
    const swaps = args.v2.swapper ? calls.some(c => isAddressEqual(c.to, args.v2.swapper!)) : false;
    try {
      const tx = await send(calls);
      await bookSwaps(args, tx);
      return tx;
    } catch (error) {
      const name = swaps ? swapperErrorOf(error) : null;
      if (name === 'PegExceeded') {
        seen.peg = true;
        args.log(JSON.stringify({ level: 'error', msg: 'strategy_peg_exceeded', chainId: args.v2.chainId, portfolioId: args.portfolioId, account: args.account, detail: shortError(error) }));
        args.onPegExceeded?.(shortError(error));
        throw new Error(`[STRATEGY_PEG_EXCEEDED] 借款幣與 USDT 的池子偏離 1:1 超過合約上限，補差額／換回現金被擋下（需要人處理，重送沒有用）：${shortError(error)}`);
      }
      if (name === 'WindowExceeded') {
        if (!seen.window) args.log(`[strategy-routing] portfolio ${args.portfolioId}: 補差額被擋：這個借款幣 24 小時內的額度用完了（WindowExceeded），等視窗重開再送，不每輪重送`);
        seen.window = true;
        throw new Error(`[STRATEGY_TOPUP_WINDOW] 24 小時補差額額度用完：${shortError(error)}`);
      }
      seen.other = true;
      throw error;
    }
  };
}
/**
 * What a landed UserOp did to the account's USDT through the strategy: `ToppedUp` / `CashedOut` (cash swapper), and on a
 * route that borrows USDT the cash the executor took for a repayment and what the strategy paid back (`v2UsdtFlows`). One
 * log line each, and the cash ledger (what was spent leaves the portfolio's own cash, what came back joins it). A ledger
 * failure never undoes or repeats the chain action: it is logged as an error with the tx hash, and `recoverSwaps` books
 * the event later (the marker makes a second booking impossible).
 */
async function bookSwaps(args: Pick<V2StepArgs, 'v2' | 'portfolioId' | 'account' | 'log' | 'ledger' | 'reader'>, tx: V2Tx): Promise<void> {
  try {
    const usdt = args.v2.loanTokens.USDT?.toLowerCase(), me = args.account.toLowerCase().slice(2);
    // The strategy box is only read when the receipt moved USDT of this account at all.
    const moved = usdt !== undefined && tx.logs.some(l => l.address.toLowerCase() === usdt && l.topics.length === 3 && (l.topics[1]!.toLowerCase().endsWith(me) || l.topics[2]!.toLowerCase().endsWith(me)));
    const box = moved ? (await args.reader.box(args.account)).box : null;
    const events = v2CashEvents(args.v2, tx, args.account, box);
    for (const e of events) args.log(swapEventLine(args.v2.chainId, args.portfolioId, e));
    if (events.length === 0 || !args.ledger.swaps) return;
    await args.ledger.swaps(args.portfolioId, args.account, events);
  } catch (error) { args.log(JSON.stringify({ level: 'error', msg: 'strategy_cash_swap_unbooked', chainId: args.v2.chainId, portfolioId: args.portfolioId, account: args.account, txHash: tx.hash, detail: shortError(error) })); }
}
/**
 * Loan token other than USDT left in the account with nothing owed in it (a vault's surplus, the unused part of a top-up
 * buffer): sold for USDT with the session key, one UserOp. Returns the note for the round, or null when there is nothing
 * to sell (or it could not be sent: logged, the next round tries again — it never blocks anything).
 */
async function cashOutLeftovers(args: V2StepArgs, send: V2Send | null, leftovers: readonly Leftover[]): Promise<string | null> {
  // This follow-up is a UserOp of its own: only for a balance worth one (V2_CASH_OUT_ALONE_MIN_RAW).
  const plan = leftoverCashOuts(args.v2, leftovers, deadlineOf(args.now), V2_CASH_OUT_ALONE_MIN_RAW);
  for (const n of plan.unapproved) args.log(`[strategy-routing] portfolio ${args.portfolioId}: holds ${n.cashRaw} ${n.symbol} it cannot sell for USDT yet — the owner has not approved it to the cash swapper (the next consent adds it)`);
  if (plan.calls.length === 0) return null;
  const what = plan.sold.map(x => x.symbol).join('、');
  if (args.dryRun || send === null) { args.log(`[strategy-routing] portfolio ${args.portfolioId}: would sell leftover ${what} for USDT (${args.dryRun ? 'dry run' : 'no routing v2 session scope yet'})`); return null; }
  try { const tx = await send(plan.calls); return `[STRATEGY_ROUTING] 關閉後留在帳戶的 ${what} 已換回 USDT tx=${tx.hash}`; }
  catch (error) { args.log(`[strategy-routing] portfolio ${args.portfolioId}: leftover ${what} not sold this round, the next one retries: ${shortError(error)}`); return null; }
}
const deadlineOf = (now: Date) => BigInt(Math.floor(now.getTime() / 1000) + 30 * 60);
/**
 * Which of the account's USDT the strategy may spend, by the cash ledger: the portfolio's own cash (`allocated_cash_raw`)
 * and what no bucket claims — for a top-up (cash swapper; taken off every quote of this read: they share the one USDT
 * balance) and for a repayment on a route that borrows USDT (`maxCashIn` lets the executor take the account's own USDT when
 * the box is short). What is spent is booked against the own cash when it lands (`bookSwaps`), so the ledger follows the
 * chain balance down; without a ledger to book it in (`ledger.swaps`) only unclaimed USDT is offered.
 * Funding waiting to be bought, a running job's money and the withdrawal / yield reservations are never offered: taking
 * them leaves the ledger above the chain balance and stops the portfolio's jobs ([CASH_DEFICIT]).
 * A ledger already above the chain balance: unbooked strategy cash movements are looked for first (`recoverSwaps`).
 */
async function spendableUsdtOnly(args: Pick<V2StepArgs, 'v2' | 'cashClaims' | 'recoverSwaps' | 'ledger' | 'log' | 'portfolioId'>, read: V2AccountRead): Promise<void> {
  if (!args.cashClaims) return;
  const usdtToken = args.v2.loanTokens.USDT?.toLowerCase();
  const usdt = Object.entries(read.tokens).find(([, t]) => t.token.toLowerCase() === usdtToken);
  const quotes = Object.values(read.tokens).flatMap(t => t.swap ? [t.swap] : []);
  if (quotes.length === 0 && (!usdt || usdt[1].cashRaw === 0n)) return;
  let claims: { claimedRaw: bigint; ownRaw: bigint } | null;
  try {
    claims = await args.cashClaims();
    const held = quotes[0]?.usdtRaw ?? usdt?.[1].cashRaw ?? 0n;
    if (claims.claimedRaw > held && args.recoverSwaps) {
      const booked = await args.recoverSwaps();
      if (booked > 0) { args.log(`[strategy-routing] portfolio ${args.portfolioId}: booked ${booked} cash swapper event(s) the cash ledger had missed`); claims = await args.cashClaims(); }
    }
  } catch { claims = null; args.log(`[strategy-routing] portfolio ${args.portfolioId}: the cash ledger is unreadable, no account USDT is used for top-ups or USDT repayments this round`); }
  const free = (raw: bigint, kept: bigint | null) => kept === null ? 0n : raw > kept ? raw - kept : 0n;
  const others = claims === null ? null : args.ledger.swaps ? claims.claimedRaw - (claims.ownRaw < claims.claimedRaw ? claims.ownRaw : claims.claimedRaw) : claims.claimedRaw;
  for (const q of quotes) q.usdtRaw = free(q.usdtRaw, others);
  if (usdt) {
    usdt[1].cashRaw = free(usdt[1].cashRaw, others);
    for (const h of read.state.holdings) if (h.loan === usdt[0] && h.cashRaw !== undefined) h.cashRaw = usdt[1].cashRaw;
  }
}
/** The account's own loan tokens other than USDT, from a full account read (the same shape `reader.leftovers` answers). */
const leftoversOf = (read: V2AccountRead): Leftover[] => Object.entries(read.tokens).filter(([, t]) => t.swap !== undefined)
  .map(([symbol, t]) => ({ symbol, token: t.token, cashRaw: t.cashRaw, debtRaw: t.debtRaw, allowanceRaw: t.swap!.tokenAllowanceRaw }));
async function recordRoutes(args: Pick<V2StepArgs, 'v2' | 'ledger' | 'portfolioId' | 'account' | 'log'>, m: V2Market, tx: V2Tx, reason?: string | null) {
  // A ledger failure never undoes or repeats the chain action: it is logged and the tx hash stays in the log line.
  try { await args.ledger.routes(args.v2.chainId, v2RouteEvents(args.v2, tx, { portfolioId: args.portfolioId, account: args.account, lookup: m.lookup, ...(reason === undefined ? {} : { reason }) })); }
  catch { args.log(`[strategy-routing] portfolio ${args.portfolioId} 帳本寫入失敗（鏈上已完成）tx=${tx.hash}`); }
}

/**
 * Decide and execute for one account (see the header). Returns a one-line note, or null when the account has nothing on
 * v2 or nothing happened. Throws when a step failed, so the caller's back-off applies.
 */
export async function v2AutoRound(args: V2StepArgs): Promise<string | null> {
  const { v2, reader, account } = args;
  const touched = args.touched ?? await reader.touched(account);
  const seen: SwapWatch = { peg: false, window: false, other: false };
  const send = args.send === null ? null : watchSwaps(args, args.send, seen);
  if (!touched.enabled && touched.routes.length === 0) {
    // The strategy was turned off earlier (the reward recipient outlives that): loan token a close left in the account is
    // still sold for USDT. An account that never used v2 is not read at all.
    if (!v2.swapper || isAddressEqual(touched.rewardRecipient, zeroAddress)) return null;
    return cashOutLeftovers(args, send, await reader.leftovers(account));
  }
  // Hard rule (cre8-contracts borrow-routing-v2 §12, review round 3): the contract's ForeignDebt check does not stop every
  // path, so v2 never opens, tops up or moves anything while v1 still holds something on the account.
  if (args.v1Active && await args.v1Active()) return '[STRATEGY_ROUTING] 這個帳戶還有 v1 加息部位或同意，v2 不動作（一個帳戶只用其中一種）';
  const [m, read] = await Promise.all([reader.market(), reader.account(account, (args.held ?? []) as Address[])]);
  await spendableUsdtOnly(args, read);
  // Everything was sold and the owner has not chosen Earn extra again: the consent left on chain opens nothing (the
  // round goes on as for an account without consent). An account with a position is never held back.
  if (read.state.enabled && args.consentSince && !read.routes.some(r => r.collateralRaw > 0n || r.routeDebtRaw > 0n)
    && consentIsStale(await args.consentSince(), { [V2_CONSENT_KEY]: read.policy.maxDebt })) {
    read.state.enabled = false;
    args.log(`[strategy-routing] portfolio ${args.portfolioId}: 全部賣出後 owner 沒有再選加息，鏈上留著的舊同意不算，這一輪不開`);
  }
  const sent: Hex[] = [];
  const result = await runV2Account({ v2, portfolioId: args.portfolioId, account, snapshot: m.snapshot, state: read.state, costs: args.costs ?? V2_DEFAULT_COSTS, now: args.now.getTime(), deadline: deadlineOf(args.now),
    limits: m.limits, dryRun: args.dryRun || send === null, log: args.log, ...(args.mayOpen === false ? { noNewRisk: true } : {}),
    send: async calls => { const tx = await send!(calls); sent.push(tx.hash); return tx; },
    // executeDeleverage is the keeper round's (runV2KeeperRound): no keeper here, the step is logged as left for it.
    record: async (step: Step, tx) => recordRoutes(args, m, tx as V2Tx, step.reason) });
  // Loan token other than USDT left in the account with nothing owed in it any more (what a close of an earlier round, or
  // an owner-signed one, left behind): sold for USDT. After this round sent something the account is read again.
  let cashed: string | null = null;
  if (v2.swapper && !args.dryRun) {
    try { cashed = await cashOutLeftovers(args, send, result.sent > 0 ? await reader.leftovers(account) : leftoversOf(read)); }
    catch (error) { args.log(`[strategy-routing] portfolio ${args.portfolioId}: leftover loan token not read this round: ${shortError(error)}`); }
  }
  // A repayment that waits for USDT (or could only be made in part): the scheduler raises it by selling a little of what
  // the portfolio holds, and the next round finishes the repayment.
  const need = (result.plan?.steps ?? []).reduce((sum, s) => sum + (s.needUsdtRaw ?? 0n), 0n);
  if (need > 0n && !args.dryRun && send !== null) args.onCashNeed?.(need);
  const acted = (result.plan?.steps ?? []).filter(s => s.calls.length > 0 && s.via === 'session');
  if (acted.length === 0) return cashed;
  const what = acted.map(s => `${s.symbol} ${s.action}(${s.reason})`).join('、');
  if (args.dryRun || send === null) return `[STRATEGY_ROUTING] 可執行：${what}（${args.dryRun ? 'dry-run' : '沒有路由 v2 的 session 權限，等 owner 續期'}，未送出）`;
  if (result.failed > 0) {
    const done = `${what}：${result.sent} 筆完成、${result.failed} 筆未完成${sent.length > 0 ? ` tx=${sent.join(',')}` : ''}`;
    // Only the 24-hour top-up window stood in the way: not a failure to back off from — the plan waits for the window itself.
    if (seen.window && !seen.peg && !seen.other) return `[STRATEGY_TOPUP_WINDOW] ${done}；補差額的 24 小時額度用完，等視窗重開`;
    throw new Error(`${seen.peg ? '[STRATEGY_PEG_EXCEEDED] ' : ''}[STRATEGY_ROUTING] ${done}`);
  }
  return `[STRATEGY_ROUTING] 已執行：${what} tx=${sent.join(',')}${result.consentShort ? '；同意的上限不夠，等 owner 重新同意' : ''}${cashed ? `；${cashed}` : ''}`;
}

/**
 * The quiet round of one account on a chain with a v2 deployment: which generation acts. One account is on v1 or on v2,
 * never both (the API and the paymaster refuse the second consent).
 * - Anything on v2 now (consent, a route, money in the box) -> the v2 round only, WHOEVER the owner is: the audience only
 *   decides who may start on v2 (`mayOpen`), never who is looked after. Without `mayOpen` the round adds no risk.
 * - Nothing on v2 now -> the v1 step, exactly as for everyone else. An account that used v2 before (the reward recipient
 *   outlives a turn-off) also has the loan token a close left behind sold for USDT: the v2 round does only that for it.
 *   (Until 2026-11-26 such an account went to the v1 step alone and its USDC / USD1 / U stayed where it was.)
 * - An owner who may not start on v2 and whose account is known to have nothing there costs no read (`touchedOutside`);
 *   when that read fails, only the v1 step runs this round (an owner in the audience still fails the round, as before:
 *   his account may have just started on v2).
 */
export async function v2QuietRound(input: { v2: StrategyEarnV2; reader: Pick<V2Reader, 'touched' | 'touchedOutside'>; account: Address; mayOpen: boolean; log: (line: string) => void;
  v1: () => Promise<string | null>; v2Round: (touched: V2Touched, mayOpen: boolean) => Promise<string | null> }): Promise<string | null> {
  let touched: V2Touched;
  if (input.mayOpen) touched = await input.reader.touched(input.account);
  else {
    // An owner who may not start on v2: when the public nodes do not answer, the v1 step still runs — it never depended on
    // them, and for an account that is on v2 it is a no-op (no v1 consent: one account never uses both). What the account
    // has on v2 is looked at again next round; the keeper round and the pre-sale step read for themselves.
    try { touched = await input.reader.touchedOutside(input.account); }
    catch (error) { input.log(`[strategy-routing] ${input.account}: routing v2 could not be read this round (${shortError(error)}); only the v1 step runs`); return input.v1(); }
  }
  if (v2Active(touched)) return input.v2Round(touched, input.mayOpen);
  const first = await input.v1();
  if (!input.v2.swapper || !v2HasState(touched)) return first;
  let second: string | null = null;
  // Never a reason to fail the round: the next one looks again.
  try { second = await input.v2Round(touched, input.mayOpen); } catch (error) { input.log(`[strategy-routing] ${input.account}: leftover loan token not looked at this round: ${shortError(error)}`); }
  return first !== null && second !== null ? `${first}；${second}` : first ?? second;
}

/**
 * Before a sale: posted shares count as holdings, so the plan may sell more than the account holds free. For each such
 * asset repay its route and take the shares back (v2PreSellPlan); the trade waits for the next round. `exit` (the sale is a
 * full exit: sell all / delete / take profit): reward tokens in the box and the account go to the owner's wallet with the
 * same session key (`executeSweepRewards`, spec §9). Returns a block reason, or null when the sale can go ahead.
 */
export async function v2UnwindForSale(args: V2StepArgs & { steps: readonly { tokenIn: string; amountIn: bigint }[]; exit?: boolean;
  /** The sale has nothing free to sell (the caller planned it without the stuck shares and found nothing): a position
   * with nothing to repay takes back the shares its debt does not need, so there is something to sell next round. */
  spare?: boolean }): Promise<string | V2UnwindWait | null> {
  const { v2, reader, account } = args;
  const touched = args.touched ?? await reader.touched(account);
  // A full exit also looks at an account with no route and no vault left: its strategy was simply turned off earlier (the
  // reward recipient outlives that), and reward tokens may still sit in the account or the box.
  const mayHoldRewards = args.exit === true && (touched.vaults.length > 0 || !isAddressEqual(touched.rewardRecipient, zeroAddress));
  if (touched.routes.length === 0 && !mayHoldRewards) return null;
  const m = await reader.market();
  const deadline = deadlineOf(args.now);
  const seen: SwapWatch = { peg: false, window: false, other: false };
  /** What this sale needs from one read of the account. `swapper: false`: plan as if there were no cash swapper (no top-up, no cash-out). */
  const build = async (swapper: boolean) => {
    const read = await reader.account(account);
    await spendableUsdtOnly(args, read);
    const positions: PreSellPosition[] = [];
    // The debt a venue checks a route's budget against: Lista — that market's; Venus — the account's whole Venus debt.
    const venusDebt = [...new Map(read.routes.filter(x => x.route.venue === 'venus').map(x => [x.route.loanSymbol, x.debtRaw])).values()].reduce((sum, d) => sum + d, 0n);
    for (const r of read.routes.filter(x => x.collateralRaw > 0n)) {
      const need = args.steps.filter(s => s.tokenIn.toLowerCase() === r.route.collateral).reduce((sum, s) => sum + s.amountIn, 0n);
      const h = read.state.holdings.find(x => x.collateral === r.route.collateral);
      if (need === 0n || !h || need <= h.freeCollateralRaw) continue;
      const t = read.tokens[r.route.loanSymbol]!;
      positions.push({ symbol: r.route.symbol, collateral: r.route.collateral, freeCollateralRaw: h.freeCollateralRaw, postedRaw: r.collateralRaw, routeDebtRaw: r.routeDebtRaw,
        vaultAssetsRaw: read.vaults.filter(v => v.vault.token === r.route.loan).reduce((s, v) => s + v.assetsRaw, 0n), idleRaw: t.idleRaw, cashRaw: t.cashRaw, minDebtRaw: r.limits.minDebtRaw,
        routeId: r.route.routeId, vaultId: (r.vault?.vaultId ?? ('0x' + '00'.repeat(32))) as Hex, venue: r.route.venue, loan: r.route.loanSymbol, ...(swapper && t.swap ? { swap: t.swap } : {}),
        collateralValueUsd: r.collateralValueUsd, targetLtvBps: r.targetLtvBps, budgetDebtRaw: r.route.venue === 'venus' ? venusDebt : r.debtRaw });
    }
    // A route of the same token that this sale does not close keeps the token's leftover as its repayment fallback.
    for (const p of positions) if (read.routes.some(r => r.route.loanSymbol === p.loan && r.routeDebtRaw > 0n && !positions.some(x => x.routeId === r.route.routeId))) p.lastOfToken = false;
    const plan = v2PreSellPlan(v2, account, positions, deadline, args.now.getTime(), args.spare ? { spare: true } : {});
    // A full exit also sells loan token already sitting in the account with nothing owed in it (left by an earlier close),
    // so the owner takes back USDT only. Tokens this plan closes are sold in the same UserOp as their close (v2PreSellPlan).
    const closing = new Set(positions.map(p => p.loan));
    // A full exit also sends the reward tokens on (the account's own only when the owner approved them at consent). The
    // contract sends to the policy's recipient; without one it only moves box -> account, and a sweep of the account's own
    // tokens alone would revert (nothing moves), so that part is only asked for when there is a recipient.
    const recipient = read.policy.rewardRecipient, toOwner = !isAddressEqual(recipient, zeroAddress) && !isAddressEqual(recipient, account);
    const sweeps = args.exit ? read.rewards.flatMap(r => {
      const fromAccount = toOwner && r.accountRaw > 0n && r.allowanceRaw >= r.accountRaw;
      return r.boxRaw > 0n || fromAccount ? [v2Calls.sweepRewards(v2, account, r.token, fromAccount ? maxUint256 : 0n, deadline)] : [];
    }) : [];
    // With nothing else to send in this UserOp the cash-out would be one of its own: only above V2_CASH_OUT_ALONE_MIN_RAW.
    const cashOuts = args.exit && swapper && v2.swapper ? leftoverCashOuts(v2, leftoversOf(read).filter(l => !closing.has(l.symbol)), deadline,
      plan.calls.length > 0 || sweeps.length > 0 ? undefined : V2_CASH_OUT_ALONE_MIN_RAW).calls : [];
    return { read, plan, cashOuts, sweeps, toOwner, calls: [...plan.calls, ...cashOuts, ...sweeps], blocking: plan.notes.length > 0 };
  };
  /** Nothing of these positions can be repaid this round: the sale is not held back for them (it is what brings the USDT in). */
  const waitOf = (x: Awaited<ReturnType<typeof build>>): V2UnwindWait => ({ note: `[STRATEGY_EARN_UNWINDING] ${x.plan.notes.join('；')}`, stuck: x.plan.stuck, needUsdtRaw: x.plan.needUsdtRaw });
  const onlyWaits = (x: Awaited<ReturnType<typeof build>>) => x.plan.calls.length === 0 && x.plan.stuck.length > 0;
  let b = await build(true);
  if (b.plan.retryAt !== undefined) args.log(`[strategy-routing] portfolio ${args.portfolioId}: 補差額的 24 小時額度用完，${new Date(b.plan.retryAt * 1000).toISOString()} 之後再補；這一輪先還得起的部分`);
  if (b.plan.notes.length === 0 && b.sweeps.length === 0 && b.cashOuts.length === 0) return null;
  if (b.calls.length === 0) return onlyWaits(b) && !args.dryRun ? waitOf(b) : `[STRATEGY_EARN_UNWINDING] ${b.plan.notes.join('；')}`;
  if (args.dryRun || args.send === null) {
    if (!b.blocking) return null;
    return `[STRATEGY_EARN_UNWINDING] 賣出前需先還款取回：${b.plan.notes.join('；')}（${args.dryRun ? 'dry-run' : '沒有路由 v2 的 session 權限，等 owner 續期'}，未送出）`;
  }
  const send = watchSwaps(args, args.send, seen), txs: Hex[] = [];
  const sendAll = async (calls: readonly Call[], read: V2AccountRead) => {
    for (const batch of v2Batches(calls)) {
      let landed: V2Tx[];
      try { landed = [await send(batch)]; }
      catch (error) {
        // A UserOp that does not fit (or reverts as a whole) is retried one call at a time; what landed stays.
        if (batch.length === 1) throw new Error(`${txs.length > 0 ? `已完成 ${txs.length} 筆（tx=${txs.join(',')}），其餘未完成：` : ''}${shortError(error)}`);
        landed = [];
        for (const call of batch) { const tx = await send([call]); landed.push(tx); txs.push(tx.hash); await recordRoutes(args, m, tx, 'sale'); await recordRewards(args, read, tx); }
        continue;
      }
      for (const tx of landed) { txs.push(tx.hash); await recordRoutes(args, m, tx, 'sale'); await recordRewards(args, read, tx); }
    }
  };
  const usesSwapper = (calls: readonly Call[]) => v2.swapper !== undefined && v2.swapper !== null && calls.some(c => isAddressEqual(c.to, v2.swapper!));
  try { await sendAll(b.calls, b.read); }
  catch (error) {
    if (!usesSwapper(b.calls)) {
      // Only reward tokens to send: never a reason to hold the sale back. A failure is logged and the next exit round tries again.
      if (!b.blocking) { args.log(`[strategy-routing] portfolio ${args.portfolioId} 退出：激勵代幣這一輪沒送出（不擋賣出）：${shortError(error)}`); return null; }
      throw error;
    }
    // A top-up or a cash-out did not go through (the pool is off its peg, the token's 24-hour window is used up, a
    // prediction did not hold): a sale is never held back for the swapper. Plan again from a fresh read — part of the
    // first attempt may have landed — as if there were no swapper: repay what the box and the account's own loan token
    // can, take back that share, and leave the leftover loan token to a later round.
    args.log(`[strategy-routing] portfolio ${args.portfolioId}: 補差額／換回現金這一輪做不了（${seen.peg ? 'PegExceeded' : seen.window ? 'WindowExceeded' : shortError(error)}），這次賣出改走不補差額的還款取回`);
    b = await build(false);
    if (b.calls.length === 0) {
      if (b.blocking) return onlyWaits(b) ? waitOf(b) : `[STRATEGY_EARN_UNWINDING] ${b.plan.notes.join('；')}`;
      return txs.length > 0 ? `[STRATEGY_EARN_UNWINDING] 賣出前已還款取回 tx=${txs.join(',')}；下一輪再賣` : null;
    }
    try { await sendAll(b.calls, b.read); }
    catch (inner) {
      if (!b.blocking) { args.log(`[strategy-routing] portfolio ${args.portfolioId} 退出：激勵代幣這一輪沒送出（不擋賣出）：${shortError(inner)}`); return txs.length > 0 ? `[STRATEGY_EARN_UNWINDING] 賣出前已還款取回 tx=${txs.join(',')}；下一輪再賣` : null; }
      throw inner;
    }
  }
  if (!b.blocking) {
    args.log(`[strategy-routing] portfolio ${args.portfolioId} 退出：${b.sweeps.length > 0 ? `激勵代幣已送到 ${b.toOwner ? 'owner 錢包' : '投資組合帳戶'}` : ''}${b.cashOuts.length > 0 ? `${b.sweeps.length > 0 ? '、' : ''}剩餘借款幣已換回 USDT` : ''} tx=${txs.join(',')}`);
    return null;
  }
  // Only reward tokens / leftover loan token went out while every position waits: the sale goes ahead with what is free.
  if (onlyWaits(b)) return waitOf(b);
  return `[STRATEGY_EARN_UNWINDING] 賣出前已還款取回：${b.plan.notes.join('；')} tx=${txs.join(',')}${txs.length > 1 ? `（分 ${txs.length} 筆）` : ''}；下一輪再賣`;
}

async function recordRewards(args: Pick<V2StepArgs, 'v2' | 'ledger' | 'portfolioId' | 'account' | 'log'>, read: Pick<V2AccountRead, 'box' | 'policy'>, tx: V2Tx, owner?: Address) {
  try {
    const events = rewardEvents(tx, { portfolioId: args.portfolioId, account: args.account, holders: [args.account, read.box], owner: owner ?? read.policy.rewardRecipient,
      tokens: args.v2.rewardTokens.map(address => ({ symbol: 'LISTA', address })) });
    if (events.length > 0) await args.ledger.rewards(args.v2.chainId, events);
  } catch { args.log(`[strategy-routing] portfolio ${args.portfolioId} 激勵帳本寫入失敗（鏈上已完成）tx=${tx.hash}`); }
}

// ---------------------------------------------------------------------------
// Keeper round: anyone-callable transactions only
// ---------------------------------------------------------------------------
/** Sends a plain transaction with the keeper key and waits for its receipt. */
export type V2KeeperSend = (to: Address, data: Hex) => Promise<V2Tx>;
export type V2KeeperResult = { accounts: number; /** Accounts with a position or money in the box on v2 (the ones read in full). */ managed: number; checked: number; deleveraged: number; collected: number; stranded: number; failed: number; writer: boolean };
/** Reward tokens under this (raw, 18 decimals) wait in the box: not worth a transaction. Chain 97's simulated tokens are
 * worth nothing and its positions are small, so the bar is ten times lower there (a test position shows a reward within the hour). */
export const V2_MIN_COLLECT_RAW = 10n ** 16n;
export const v2MinCollectRaw = (chainId: number) => chainId === 97 ? V2_MIN_COLLECT_RAW / 10n : V2_MIN_COLLECT_RAW;
const MOCK_VAULT_ABI = parseAbi(['function claimReward(address account) returns (uint256)', 'function claimReward(bytes32 id, address account) returns (uint256)']);

/**
 * For every account that has a v2 position, whoever its owner is (the audience only decides who may START on v2; a position
 * of an owner no longer in it is watched just the same): send `executeDeleverage` when the venue says the
 * health line is reached (from the vault of that loan token the box holds most in), report small positions nobody else can
 * repay (the session-key round closes them), and move reward tokens from the strategy box into the account. On chain 97
 * the simulated earn vaults pay their incentive on a call anyone may make (`claimReward(box)`); it is triggered here
 * first. On mainnet the tokens reach the box through the merkle claim of the rewards round. Without a keeper key the round
 * only reports. Never sends anything but `executeDeleverage` / `collectRewards` to the executor (v2KeeperCall).
 */
export async function runV2KeeperRound(args: { dryRun: boolean; log: (line: string) => void }, deps: { v2: StrategyEarnV2; reader: V2Reader; send: V2KeeperSend | null; ledger: V2Ledger;
  accounts: () => Promise<{ account: Address; portfolioId: number; owner: Address }[]> }): Promise<V2KeeperResult> {
  const { v2, reader } = deps, minCollect = v2MinCollectRaw(v2.chainId);
  const result: V2KeeperResult = { accounts: 0, managed: 0, checked: 0, deleveraged: 0, collected: 0, stranded: 0, failed: 0, writer: deps.send !== null };
  const accounts = await deps.accounts();
  if (accounts.length === 0) return result;
  // Which accounts have anything on v2: one bulk read (40 accounts per request) instead of one request per account.
  const all = await reader.touchedMany(accounts.map(a => a.account));
  result.accounts = accounts.length;
  const held: typeof accounts = [];
  for (const [i, a] of accounts.entries()) {
    try {
      // An account the bulk read could not answer for is asked by itself; if that fails too it counts as failed, not as empty.
      const touched = all[i] ?? await reader.touched(a.account);
      if (touched.routes.length > 0 || touched.vaults.length > 0) held.push(a);
    } catch (error) { result.failed++; args.log(`[strategy-routing] ${a.account} 讀值或送出失敗，下輪再試：${shortError(error)}`); }
  }
  result.managed = held.length;
  if (held.length === 0) return result;
  const m = await reader.market();
  for (const a of held) {
    try {
      let read = await reader.account(a.account);
      const ctx = { v2, ledger: deps.ledger, portfolioId: a.portfolioId, account: a.account, log: args.log };
      for (const r of read.routes) {
        result.checked++;
        if (r.shouldDeleverage) {
          const why = `LTV ${r.ltvBps} bps，減倉線 ${r.deleverageLtvBps} bps`;
          const vault = read.vaults.filter(v => v.vault.token === r.route.loan).sort((x, y) => (y.assetsRaw > x.assetsRaw ? 1 : -1))[0]?.vault ?? r.vault;
          if (args.dryRun || !deps.send || !vault) { args.log(`[strategy-routing] ${a.account} ${r.route.symbol} 需要減倉（${why}）${deps.send ? '' : '；沒有 keeper 金鑰，未送出'}`); continue; }
          const call = v2KeeperCall(v2, v2Calls.deleverage(v2, a.account, r.route.routeId, vault.vaultId));
          const tx = await deps.send(call.to, call.data);
          result.deleveraged++;
          args.log(`[strategy-routing] ${a.account} ${r.route.symbol} 已自動減倉（${why}）tx=${tx.hash}`);
          await recordRoutes(ctx, m, tx, 'safety_line');
        }
        const pooled = read.vaults.filter(v => v.vault.token === r.route.loan).reduce((s, v) => s + v.assetsRaw, 0n);
        if (strandedSmallPosition({ symbol: r.route.symbol, collateral: r.route.collateral, freeCollateralRaw: 0n, routeDebtRaw: r.routeDebtRaw, vaultAssetsRaw: pooled, idleRaw: read.tokens[r.route.loanSymbol]!.idleRaw, minDebtRaw: r.limits.minDebtRaw })) {
          result.stranded++;
          args.log(`[strategy-routing] ${a.account} ${r.route.symbol} 小額部位（負債 ${r.routeDebtRaw} ≤ 最低 ${r.limits.minDebtRaw}，策略盒只有 ${pooled + read.tokens[r.route.loanSymbol]!.idleRaw}）：第三方還不了，由 session key 補錢全還`);
        }
      }
      if (args.dryRun || !deps.send) continue;
      // Chain 97 only: the simulated earn vaults pay the box when anyone asks.
      let claimed = false;
      if (v2.chainId === 97) {
        for (const v of read.vaults.filter(x => x.vault.venue === 'lista' && x.assetsRaw > 0n)) {
          const pending = await reader.vaultReward(v.vault.target, read.box);
          if (pending === null || pending < minCollect) continue;
          const tx = await deps.send(v.vault.target, encodeFunctionData({ abi: MOCK_VAULT_ABI, functionName: 'claimReward', args: [read.box] }));
          await recordRewards(ctx, read, tx, a.owner); claimed = true;
          args.log(`[strategy-routing] ${a.account} 模擬 vault 激勵已發到策略盒 tx=${tx.hash}`);
        }
      }
      // Chain 97 only: the simulated venues' own incentives (Venus collateral, Lista market) are paid to the account when
      // anyone asks, the way the v1 keeper claims them. They are what the rate reports state for these routes.
      if (v2.chainId === 97) {
        for (const r of read.routes.filter(x => x.collateralRaw > 0n)) {
          const pending = await reader.venueReward(r.route, a.account);
          if (pending === null || pending < minCollect) continue;
          const tx = r.route.venue === 'venus' ? await deps.send(r.route.collateralVToken, encodeFunctionData({ abi: MOCK_VAULT_ABI, functionName: 'claimReward', args: [a.account] }))
            : await deps.send(v2.moolah, encodeFunctionData({ abi: MOCK_VAULT_ABI, functionName: 'claimReward', args: [r.route.listaId, a.account] }));
          args.log(`[strategy-routing] ${a.account} ${r.route.symbol} 模擬場所激勵已發到帳戶（${pending}）tx=${tx.hash}`);
        }
      }
      if (claimed) read = await reader.account(a.account);
      for (const r of read.rewards.filter(x => x.boxRaw >= minCollect)) {
        const call = v2KeeperCall(v2, v2Calls.collectRewards(v2, a.account, r.token));
        const tx = await deps.send(call.to, call.data);
        result.collected++;
        args.log(`[strategy-routing] ${a.account} 激勵代幣已從策略盒收進帳戶（${r.boxRaw}）tx=${tx.hash}`);
        await recordRewards(ctx, read, tx, a.owner);
      }
    } catch (error) { result.failed++; args.log(`[strategy-routing] ${a.account} 讀值或送出失敗，下輪再試：${shortError(error)}`); }
  }
  return result;
}

/**
 * Rewards round (src/strategy-rewards.ts `extraHolders`): the account's strategy box earns the vault incentives, so its
 * Lista proofs are read too. The box answers ERC-1271 only for the reward message and only in its own form — verified on
 * BSC mainnet (2026-11-24): Lista calls `isValidSignature(bytes32,bytes)` with the EIP-191 hash and accepts
 * `abi.encode(bytes message, bytes accountSignature)`. What is claimed to the box is moved into the account by the keeper
 * round (`collectRewards`). An account without a box yet (nothing ever deposited) has no extra holder.
 */
export const v2RewardHolders = (boxOf: (account: Address) => Promise<{ box: Address; deployed: boolean }>) =>
  async (account: Address, sig: RewardSignature): Promise<{ holder: Address; sig: RewardSignature }[]> => {
    const { box, deployed } = await boxOf(account);
    return deployed ? [{ holder: box, sig: { ...sig, signature: boxRewardSignature(sig.message, sig.signature) } }] : [];
  };
