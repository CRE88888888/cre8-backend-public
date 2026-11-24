import { encodeFunctionData, maxUint256, parseAbi } from 'viem';
import type { Address, Hex, Log } from 'viem';
import type { Costs } from './strategy-earn-routing.js';
import { V2_DEFAULT_COSTS } from './strategy-earn-v2-api.js';
import type { V2AccountRead, V2Market, V2Reader } from './strategy-earn-v2-chain.js';
import { boxRewardSignature, runV2Account, strandedSmallPosition, v2Batches, v2Calls, v2KeeperCall, v2PreSellPlan, v2RouteEvents } from './strategy-earn-v2.js';
import type { Call, PreSellPosition, RouteEvent, Step, StrategyEarnV2 } from './strategy-earn-v2.js';
import { loanTokenNeeds, planLoanTokenSwaps } from './strategy-earn-v2-swap.js';
import { rewardEvents } from './strategy-rewards.js';
import type { RewardEvent, RewardSignature } from './strategy-rewards.js';

/**
 * Routing v2 in the scheduler (cre8-contracts docs/borrow-routing-v2, draft5). Three entry points, all for one account:
 * - `v2AutoRound`: after a quiet round (a buy has filled, nothing to trade) — the routing engine decides and the session
 *   key executes: open, top up, move (the settled rules in strategy-earn-routing ROUTING), repay, close. This is also
 *   the periodic re-evaluation: it runs every time the portfolio's round comes up.
 * - `v2UnwindForSale`: before a sale — repay the routes of the assets being sold and take the shares back.
 * - `runV2KeeperRound`: every scheduler round, with the keeper key — `executeDeleverage` at the health line (the contract's
 *   only anyone-callable trigger) and reward tokens from the strategy box into the account (`collectRewards`).
 * Every read goes through the public-node reader; every session-key UserOp carries at most three executor calls.
 */
export type V2Tx = { hash: Hex; blockNumber: bigint; logs: readonly Log[] };
export type V2Send = (calls: Call[]) => Promise<V2Tx>;
export type V2Ledger = { routes(chainId: number, events: readonly RouteEvent[]): Promise<void>; rewards(chainId: number, events: readonly RewardEvent[]): Promise<void> };
export type V2StepArgs = { v2: StrategyEarnV2; reader: V2Reader; account: Address; portfolioId: number; now: Date; dryRun: boolean;
  /** null: the newest session key does not carry the routing v2 scope (the owner has not renewed) — the step only reports. */
  send: V2Send | null; ledger: V2Ledger; log: (line: string) => void; costs?: Costs;
  /** Collateral tokens the planner saw in the account (lowercase), read besides what is already posted. */
  held?: readonly string[];
  /** Is yield strategy v1 still in use on this account (a position, debt or consent)? One account uses v1 or v2, never both:
   * while this answers true the round adds nothing on v2 (it only reports). */
  v1Active?: () => Promise<boolean> };

const shortError = (error: unknown) => String((error as Error)?.message ?? error).split('\n')[0]!.slice(0, 160);
const deadlineOf = (now: Date) => BigInt(Math.floor(now.getTime() / 1000) + 30 * 60);
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
  const touched = await reader.touched(account);
  if (!touched.enabled && touched.routes.length === 0) return null;
  // Hard rule (cre8-contracts borrow-routing-v2 §12, review round 3): the contract's ForeignDebt check does not stop every
  // path, so v2 never opens, tops up or moves anything while v1 still holds something on the account.
  if (args.v1Active && await args.v1Active()) return '[STRATEGY_ROUTING] 這個帳戶還有 v1 加息部位或同意，v2 不動作（一個帳戶只用其中一種）';
  const [m, read] = await Promise.all([reader.market(), reader.account(account, (args.held ?? []) as Address[])]);
  const sent: Hex[] = [];
  const result = await runV2Account({ v2, portfolioId: args.portfolioId, account, snapshot: m.snapshot, state: read.state, costs: args.costs ?? V2_DEFAULT_COSTS, now: args.now.getTime(), deadline: deadlineOf(args.now),
    limits: m.limits, dryRun: args.dryRun || args.send === null, log: args.log,
    send: async calls => { const tx = await args.send!(calls); sent.push(tx.hash); return tx; },
    // executeDeleverage is the keeper round's (runV2KeeperRound): no keeper here, the step is logged as left for it.
    record: async (step: Step, tx) => recordRoutes(args, m, tx as V2Tx, step.reason) });
  // Loan tokens other than the cash token that need a swap (dust after a close, or a gap that blocks one): planned and
  // logged; nothing trades them on a chain where they are not tradable (src/strategy-earn-v2-swap.ts).
  const numeraire = v2.loanTokens.USDT;
  if (numeraire) for (const u of (await planLoanTokenSwaps(loanTokenNeeds(read, numeraire), null)).unavailable)
    args.log(`[strategy-routing] portfolio ${args.portfolioId}: ${u.need.kind === 'gap' ? 'needs' : 'holds'} ${u.need.amountRaw} ${u.need.symbol} (${u.need.why}) — ${u.reason}`);
  const acted = (result.plan?.steps ?? []).filter(s => s.calls.length > 0 && s.via === 'session');
  if (acted.length === 0) return null;
  const what = acted.map(s => `${s.symbol} ${s.action}(${s.reason})`).join('、');
  if (args.dryRun || args.send === null) return `[STRATEGY_ROUTING] 可執行：${what}（${args.dryRun ? 'dry-run' : '沒有路由 v2 的 session 權限，等 owner 續期'}，未送出）`;
  if (result.failed > 0) throw new Error(`[STRATEGY_ROUTING] ${what}：${result.sent} 筆完成、${result.failed} 筆未完成${sent.length > 0 ? ` tx=${sent.join(',')}` : ''}`);
  return `[STRATEGY_ROUTING] 已執行：${what} tx=${sent.join(',')}${result.consentShort ? '；同意的上限不夠，等 owner 重新同意' : ''}`;
}

/**
 * Before a sale: posted shares count as holdings, so the plan may sell more than the account holds free. For each such
 * asset repay its route and take the shares back (v2PreSellPlan); the trade waits for the next round. `exit` (the sale is a
 * full exit: sell all / delete / take profit): reward tokens in the box and the account go to the owner's wallet with the
 * same session key (`executeSweepRewards`, spec §9). Returns a block reason, or null when the sale can go ahead.
 */
export async function v2UnwindForSale(args: V2StepArgs & { steps: readonly { tokenIn: string; amountIn: bigint }[]; exit?: boolean }): Promise<string | null> {
  const { v2, reader, account } = args;
  const touched = await reader.touched(account);
  if (touched.routes.length === 0 && !(args.exit && touched.vaults.length > 0)) return null;
  const [m, read] = await Promise.all([reader.market(), reader.account(account)]);
  const deadline = deadlineOf(args.now);
  const positions: PreSellPosition[] = [];
  for (const r of read.routes.filter(x => x.collateralRaw > 0n)) {
    const need = args.steps.filter(s => s.tokenIn.toLowerCase() === r.route.collateral).reduce((sum, s) => sum + s.amountIn, 0n);
    const h = read.state.holdings.find(x => x.collateral === r.route.collateral);
    if (need === 0n || !h || need <= h.freeCollateralRaw) continue;
    const t = read.tokens[r.route.loanSymbol]!;
    positions.push({ symbol: r.route.symbol, collateral: r.route.collateral, freeCollateralRaw: h.freeCollateralRaw, postedRaw: r.collateralRaw, routeDebtRaw: r.routeDebtRaw,
      vaultAssetsRaw: read.vaults.filter(v => v.vault.token === r.route.loan).reduce((s, v) => s + v.assetsRaw, 0n), idleRaw: t.idleRaw, cashRaw: t.cashRaw, minDebtRaw: r.limits.minDebtRaw,
      routeId: r.route.routeId, vaultId: (r.vault?.vaultId ?? ('0x' + '00'.repeat(32))) as Hex, venue: r.route.venue, loan: r.route.loanSymbol });
  }
  const plan = v2PreSellPlan(v2, account, positions, deadline);
  // A full exit also sends the reward tokens on (the account's own only when the owner approved them at consent).
  const sweeps = args.exit ? read.rewards.filter(r => r.boxRaw > 0n || r.accountRaw > 0n && r.allowanceRaw >= r.accountRaw)
    .map(r => v2Calls.sweepRewards(v2, account, r.token, r.accountRaw > 0n && r.allowanceRaw >= r.accountRaw ? maxUint256 : 0n, deadline)) : [];
  if (plan.notes.length === 0 && sweeps.length === 0) return null;
  const calls = [...plan.calls, ...sweeps];
  const blocking = plan.notes.length > 0;
  if (calls.length === 0) return `[STRATEGY_EARN_UNWINDING] ${plan.notes.join('；')}`;
  if (args.dryRun || args.send === null) {
    if (!blocking) return null;
    return `[STRATEGY_EARN_UNWINDING] 賣出前需先還款取回：${plan.notes.join('；')}（${args.dryRun ? 'dry-run' : '沒有路由 v2 的 session 權限，等 owner 續期'}，未送出）`;
  }
  const txs: Hex[] = [];
  for (const batch of v2Batches(calls)) {
    let landed: V2Tx[];
    try { landed = [await args.send(batch)]; }
    catch (error) {
      // A UserOp that does not fit (or reverts as a whole) is retried one call at a time; what landed stays.
      if (batch.length === 1) throw new Error(`${txs.length > 0 ? `已完成 ${txs.length} 筆（tx=${txs.join(',')}），其餘未完成：` : ''}${shortError(error)}`);
      landed = [];
      for (const call of batch) landed.push(await args.send([call]));
    }
    for (const tx of landed) { txs.push(tx.hash); await recordRoutes(args, m, tx, 'sale'); await recordRewards(args, read, tx); }
  }
  if (!blocking) { args.log(`[strategy-routing] portfolio ${args.portfolioId} 退出：激勵代幣已送到 owner 錢包 tx=${txs.join(',')}`); return null; }
  return `[STRATEGY_EARN_UNWINDING] 賣出前已還款取回：${plan.notes.join('；')} tx=${txs.join(',')}${txs.length > 1 ? `（分 ${txs.length} 筆）` : ''}；下一輪再賣`;
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
export type V2KeeperResult = { accounts: number; checked: number; deleveraged: number; collected: number; stranded: number; failed: number; writer: boolean };
/** Reward tokens under this (raw, 18 decimals) wait in the box: not worth a transaction. Chain 97's simulated tokens are
 * worth nothing and its positions are small, so the bar is ten times lower there (a test position shows a reward within the hour). */
export const V2_MIN_COLLECT_RAW = 10n ** 16n;
export const v2MinCollectRaw = (chainId: number) => chainId === 97 ? V2_MIN_COLLECT_RAW / 10n : V2_MIN_COLLECT_RAW;
const MOCK_VAULT_ABI = parseAbi(['function claimReward(address account) returns (uint256)', 'function claimReward(bytes32 id, address account) returns (uint256)']);

/**
 * For every account of an owner in the v2 audience that has a v2 position: send `executeDeleverage` when the venue says the
 * health line is reached (from the vault of that loan token the box holds most in), report small positions nobody else can
 * repay (the session-key round closes them), and move reward tokens from the strategy box into the account. On chain 97
 * the simulated earn vaults pay their incentive on a call anyone may make (`claimReward(box)`); it is triggered here
 * first. On mainnet the tokens reach the box through the merkle claim of the rewards round. Without a keeper key the round
 * only reports. Never sends anything but `executeDeleverage` / `collectRewards` to the executor (v2KeeperCall).
 */
export async function runV2KeeperRound(args: { dryRun: boolean; log: (line: string) => void }, deps: { v2: StrategyEarnV2; reader: V2Reader; send: V2KeeperSend | null; ledger: V2Ledger;
  accounts: () => Promise<{ account: Address; portfolioId: number; owner: Address }[]> }): Promise<V2KeeperResult> {
  const { v2, reader } = deps, minCollect = v2MinCollectRaw(v2.chainId);
  const result: V2KeeperResult = { accounts: 0, checked: 0, deleveraged: 0, collected: 0, stranded: 0, failed: 0, writer: deps.send !== null };
  const accounts = await deps.accounts();
  if (accounts.length === 0) return result;
  const m = await reader.market();
  for (const a of accounts) {
    result.accounts++;
    try {
      const touched = await reader.touched(a.account);
      if (touched.routes.length === 0 && touched.vaults.length === 0) continue;
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
