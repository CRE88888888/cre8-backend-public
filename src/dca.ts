import { createPublicClient, decodeEventLog, erc20Abi, http, isAddressEqual, parseAbi } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { bscTestnet } from 'viem/chains';
import { createCashEarnChain, flowsFromLogs, markBest, vaultView } from './cash-earn.js';
import type { Call, CashEarnChain, VaultReading, VaultView } from './cash-earn.js';
import { DCA_VAULT_ABI, dcaDepositCalls, dcaReceiptApproval, dcaReturnCalls, dcaVaults } from './dca-calls.js';
import type { DcaVault } from './dca-calls.js';
import { getConfig } from './config.js';
import { query as dbQuery, withTransaction } from './db.js';
import { AppError, ValidationError } from './errors.js';
import type { FaucetFundingEvidence } from './faucet.js';
import { withMixPortfolioLock } from './mix-store.js';
import { yieldAuthorization } from './permissions.js';
import { requireOwnedPortfolio } from './portfolios.js';
import type { OwnedPortfolio } from './portfolios.js';
import { resolveBundlerUrl } from './renewal.js';
import type { SessionKeyRef } from './scheduler.js';
import { MIN_ASSET_BATCH_RAW, minimumDcaTranche } from './strategy-execution.js';
import type { AssetExecution } from './strategy-execution.js';
import { TESTNET_97 } from './testnet-profile.js';
import { assetsMarketOpen } from './trading-calendar.js';
import type { SavedYieldOperation, YieldEvidence, YieldOperationJournal, YieldPlan, YieldReceiptResult, YieldSubmitArgs } from './yield-execution.js';
import { yieldSessionAvailable } from './yield-session.js';
import { rpcTransport } from './rpc-transport.js';
import { accountHoldsOnlyCash, pausedBySellAll, RESUME_AFTER_SELL_ALL_SQL } from './sell-all-resume.js';
import { NEW_MONEY_ENDS_SELL_ALL_SQL, SELL_ALL_OF_PORTFOLIO_SQL } from './sell-all-intent.js';

/**
 * DCA (定投, docs/dca.zh-TW.md, db 0064). The user moves the whole total into the portfolio's own smart account,
 * the account deposits it into one whitelisted USDT vault (owner-signed calls from here), and each period the
 * scheduler's session key redeems one tranche through AtpExecutor.executeWithdraw. That exact tranche becomes an
 * ordinary funding lot, so the existing buy path spends only it; the rest keeps earning. Separate ledger: never
 * summed with wallet cash, Cash Earn, Strategy Earn or per-asset portfolio yield.
 */
export const DCA_FREQUENCIES = ['daily', 'weekly', 'biweekly', 'monthly'] as const;
export type DcaFrequency = typeof DCA_FREQUENCIES[number];
export const DCA_MIN_PERIODS = 2;
export const DCA_MAX_PERIODS = 365;
const DAY_MS = 86_400_000;
const UINT256_MAX = (1n << 256n) - 1n;
const TEMPORARILY = 'Temporarily unavailable.';
/** An unknown redemption whose deadline passed this long ago, with the shares untouched, never executed. */
const EXPIRED_AFTER_SECONDS = 600n;

/** UTC calendar. Monthly keeps the start's day, clamped to the month's end (1/31 -> 2/28 -> 3/31). */
export function periodAt(start: Date, frequency: DcaFrequency, index: number): Date {
  if (!Number.isInteger(index) || index < 0) throw new RangeError('invalid period index');
  if (frequency !== 'monthly') return new Date(start.getTime() + index * DAY_MS * (frequency === 'daily' ? 1 : frequency === 'weekly' ? 7 : 14));
  const y = start.getUTCFullYear(), m = start.getUTCMonth() + index, last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(start.getUTCDate(), last), start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), start.getUTCMilliseconds()));
}
/** Periods whose time has come and are not bought yet. A period due while the market is closed is caught up at the next open. */
export function duePeriods(plan: { startAt: Date; frequency: DcaFrequency; periods: number; periodsDone: number }, now: Date): number {
  let n = plan.periodsDone;
  while (n < plan.periods && periodAt(plan.startAt, plan.frequency, n) <= now) n++;
  return n - plan.periodsDone;
}
/** USDT to redeem for periods (done, through]; the final period takes everything left (interest included). */
export function trancheTarget(plan: { trancheRaw: bigint; periods: number; periodsDone: number }, through: number): bigint | 'all' {
  if (through <= plan.periodsDone || through > plan.periods) throw new RangeError('invalid tranche range');
  return through === plan.periods ? 'all' : plan.trancheRaw * BigInt(through - plan.periodsDone);
}
/** Earned = what is left + what was invested or returned - what was deposited. Negative = incomplete ledger -> null. */
export function dcaEarned(deposited: bigint | null, invested: bigint, returned: bigint, remaining: bigint | null): bigint | null {
  if (deposited === null || remaining === null) return null;
  const earned = remaining + invested + returned - deposited;
  return earned < 0n ? null : earned;
}

type Query = typeof dbQuery;
export type PlanRow = { id: string; chain_id: string; portfolio_id: string; account: string; owner: string; vault_id: string; market_id: string;
  total_raw: string; periods: number; frequency: DcaFrequency; tranche_raw: string; start_at: Date; state: string; periods_done: number;
  deposited_raw: string | null; deposit_tx_hash: string | null; deposited_at: Date | null; invested_raw: string; returned_raw: string;
  close_reason: string | null; closed_at: Date | null; created_at: Date };
type ActionRow = { id: string; plan_id: string; through_period: number; shares_raw: string; state: string; plan: unknown; nonce: string;
  call_data: Hex; user_op_hash: Hex; assets_raw: string | null; tx_hash: Hex | null; lot_id: string | null; created_at: Date };
const PLAN_COLUMNS = `id::text,chain_id::text,portfolio_id::text,account,owner,vault_id,market_id,total_raw::text,periods,frequency,tranche_raw::text,
  start_at,state,periods_done,deposited_raw::text,deposit_tx_hash,deposited_at,invested_raw::text,returned_raw::text,close_reason,closed_at,created_at`;
const OPEN = "('awaiting_deposit','active','paused')";
const INFLIGHT = "('prepared','sending','submitted','unknown')";

export type DcaChain = {
  earn: CashEarnChain;
  /** ERC4626 shares for an exact USDT amount (rounded up); Aave receipts are 1:1 with USDT. */
  sharesFor(vault: DcaVault, assetsRaw: bigint, block: bigint, timestamp: bigint): Promise<bigint>;
  /** Canonical tx facts for a confirmed redemption: the USDT Transfer into the account and its block time. */
  tranche(txHash: Hex, account: Address, assetsRaw: bigint): Promise<FaucetFundingEvidence>;
};
export function createDcaChain(client: PublicClient): DcaChain {
  const earn = createCashEarnChain(client);
  return {
    earn,
    async sharesFor(vault, assetsRaw, block, timestamp) {
      if (vault.protocol === 'aave_v3') return assetsRaw;
      if (vault.protocol === 'venus') return earn.sharesFor(vault, assetsRaw, block, timestamp);
      return client.readContract({ address: vault.receipt, abi: DCA_VAULT_ABI, functionName: 'previewWithdraw', args: [assetsRaw], blockNumber: block });
    },
    async tranche(txHash, account, assetsRaw) {
      const receipt = await client.getTransactionReceipt({ hash: txHash });
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      if (receipt.status !== 'success' || block.hash !== receipt.blockHash) throw new Error('tranche receipt not canonical');
      const logs = receipt.logs.filter(log => {
        if (log.removed || !isAddressEqual(log.address, TESTNET_97.contracts.usdt) || log.logIndex === null) return false;
        try { const e = decodeEventLog({ abi: erc20Abi, eventName: 'Transfer', data: log.data, topics: log.topics }); return isAddressEqual(e.args.to, account) && e.args.value === assetsRaw; }
        catch { return false; }
      });
      const log = logs.at(-1);
      if (logs.length !== 1 || !log || log.logIndex === null) throw new Error('tranche transfer not unique');
      return { txHash, logIndex: log.logIndex, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, amountRaw: assetsRaw.toString(),
        confirmedAt: new Date(Number(block.timestamp) * 1000) };
    },
  };
}

export type DcaDeps = {
  chainId: number; vaults: DcaVault[]; executor: Address; query: Query; transaction: typeof withTransaction;
  owned: typeof requireOwnedPortfolio; chain: () => DcaChain; now: () => Date;
  lock: <T>(portfolioId: number, work: () => Promise<T>) => Promise<T | null>;
  submit: (args: YieldSubmitArgs) => Promise<YieldEvidence>;
  reconcile: (saved: SavedYieldOperation) => Promise<YieldReceiptResult>;
  credit: (portfolioId: number, owner: string, evidence: FaucetFundingEvidence) => Promise<{ id: string }>;
  publicClient: () => PublicClient;
  /** Newest active session key that carries the executor yield permissions for this account (owner renewal). */
  sessionKey: (portfolioId: number, account: Address, now: Date) => Promise<{ sessionKey: SessionKeyRef; policies: unknown } | null>;
  /** The account holds nothing but cash right now (src/sell-all-resume.ts). Read only for a paused portfolio. */
  holdsOnlyCash: (portfolioId: number) => Promise<boolean>;
};

let cachedClient: PublicClient | undefined;
function liveClient(): PublicClient {
  if (cachedClient) return cachedClient;
  const rpc = getConfig().rpcUrl;
  if (!rpc) throw new AppError(503, 'DCA_UNAVAILABLE', TEMPORARILY);
  cachedClient = createPublicClient({ chain: bscTestnet, transport: rpcTransport('dca', rpc, { retryCount: 1, timeout: 8_000 }) }) as PublicClient;
  return cachedClient;
}
function defaults(): DcaDeps {
  return {
    chainId: Number(process.env.CHAIN_ID?.trim() || '56'), vaults: dcaVaults(), executor: TESTNET_97.contracts.executor as Address,
    query: dbQuery, transaction: withTransaction, owned: requireOwnedPortfolio, chain: () => createDcaChain(liveClient()), now: () => new Date(),
    lock: withMixPortfolioLock, publicClient: liveClient, holdsOnlyCash: accountHoldsOnlyCash,
    sessionKey: (portfolioId, account, now) => usableSessionKey(dbQuery, liveClient(), TESTNET_97.contracts.executor as Address, portfolioId, account, now),
    submit: async args => (await import('./yield-execution.js')).submitYieldAction(args),
    reconcile: async saved => (await import('./yield-execution.js')).reconcileYieldOperation(liveClient(), resolveBundlerUrl(), saved),
    credit: async (id, owner, evidence) => {
      const { createPortfolioStrategyService } = await import('./portfolio-strategies.js');
      return createPortfolioStrategyService().creditDcaTranche(id, owner, evidence);
    },
  };
}

/** Same key selection as the per-asset yield path (yield-service send). */
async function usableSessionKey(query: Query, client: PublicClient, executor: Address, portfolioId: number, account: Address, now: Date) {
  const keys = (await query<{ key_ref: string; permissions: unknown }>(`select key_ref,permissions from session_keys where portfolio_id=$1 and status='active'
    and expires_at>$2::timestamptz order by expires_at desc,key_ref`, [portfolioId, now])).rows;
  const owner = (await query<{ owner: Address }>('select owner from smart_accounts where chain_id=97 and portfolio_id=$1', [portfolioId])).rows[0]?.owner;
  if (!owner) return null;
  for (const key of keys) {
    if (!await yieldSessionAvailable(client, key.permissions, account, executor, now)) continue;
    const policies = key.permissions as { permissionId?: unknown; sessionKeyAddress?: unknown; timestamp?: { validUntil?: unknown } };
    const validUntil = policies.timestamp?.validUntil;
    if (!/^m\/44'\/60'\/[0-9'/]+$/.test(key.key_ref) || typeof validUntil !== 'number' || !Number.isSafeInteger(validUntil) ||
      typeof policies.permissionId !== 'string' || !/^0x[0-9a-fA-F]{8}$/.test(policies.permissionId) ||
      typeof policies.sessionKeyAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(policies.sessionKeyAddress)) continue;
    const sessionKey: SessionKeyRef = { keyRef: `m/44'/60'/${key.key_ref.slice(10)}`, permissionId: policies.permissionId as Hex,
      sessionKeyAddress: policies.sessionKeyAddress as Address, validUntil, owner };
    return { sessionKey, policies: key.permissions };
  }
  return null;
}

const TRANSFER = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
/** Sum of `token` Transfers from `from` to `to` in one receipt. */
export function usdtTransfers(logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[], token: Address, from: Address, to: Address): bigint {
  let total = 0n;
  for (const log of logs) {
    if (!isAddressEqual(log.address, token)) continue;
    try {
      const e = decodeEventLog({ abi: TRANSFER, eventName: 'Transfer', topics: log.topics as [Hex, ...Hex[]], data: log.data });
      if (isAddressEqual(e.args.from, from) && isAddressEqual(e.args.to, to)) total += e.args.value;
    } catch { /* not a Transfer */ }
  }
  return total;
}

const big = (v: string | null) => v === null ? null : BigInt(v);
const lower = (a: string) => a.toLowerCase() as Address;
const usdt = (raw: bigint) => `${(raw / 10n ** 18n).toLocaleString('en-US')}.${((raw % 10n ** 18n) / 10n ** 16n).toString().padStart(2, '0')}`;
function body(input: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || Object.keys(input).some(k => !required.includes(k) && !optional.includes(k)) ||
    required.some(k => !(k in input))) throw new ValidationError('INVALID_DCA_REQUEST', `請送出 ${required.join('、') || '{}'}。`);
  return input as Record<string, unknown>;
}
function txHash(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new ValidationError('INVALID_TX_HASH', 'txHash 格式不正確。');
  return value.toLowerCase() as Hex;
}
/** bigint-safe JSON for the immutable signed plan. */
export function planJson(plan: YieldPlan): string { return JSON.stringify(plan, (_k, v: unknown) => typeof v === 'bigint' ? { $big: v.toString() } : v); }
export function restorePlan(value: unknown): YieldPlan {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return JSON.parse(text, (_k, v: unknown) => v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { $big?: unknown }).$big === 'string'
    ? BigInt((v as { $big: string }).$big) : v) as YieldPlan;
}

export function createDca(overrides: Partial<DcaDeps> = {}) {
  const deps: DcaDeps = { ...defaults(), ...overrides };
  const ready = () => { if (deps.chainId !== 97 || deps.vaults.length === 0) throw new AppError(503, 'DCA_CHAIN_UNAVAILABLE', '定投目前僅開放測試網。'); };
  async function owned(id: number, wallet: string) {
    ready();
    const p = await deps.owned(id, wallet);
    if (p.chainId !== 97 || lower(p.ownerAddress) !== lower(wallet)) throw new AppError(403, 'FORBIDDEN', '只能操作本人於這條鏈的帳戶');
    return p;
  }
  async function openPlan(account: string): Promise<PlanRow | null> {
    return (await deps.query<PlanRow>(`select ${PLAN_COLUMNS} from dca_plans where chain_id=97 and account=$1 and state in ${OPEN} order by id desc limit 1`, [lower(account)])).rows[0] ?? null;
  }
  async function latestPlan(account: string): Promise<PlanRow | null> {
    return (await deps.query<PlanRow>(`select ${PLAN_COLUMNS} from dca_plans where chain_id=97 and account=$1
      order by (state in ${OPEN}) desc, id desc limit 1`, [lower(account)])).rows[0] ?? null;
  }
  const vaultOf = (id: string) => { const v = deps.vaults.find(x => x.id === id); if (!v) throw new AppError(503, 'DCA_UNAVAILABLE', TEMPORARILY); return v; };
  async function live() {
    const chain = deps.chain(), head = await chain.earn.head();
    const readings = await Promise.all(deps.vaults.map(async v => { try { return await chain.earn.vault(v, head.number, head.timestamp); } catch { return null; } }));
    const views = markBest(deps.vaults.map((v, i) => vaultView(v, readings[i] ?? null, new Date(Number(head.timestamp) * 1000))));
    return { chain, head, readings, views };
  }
  /** Smallest per-period amount: one complete 10 USDT fee-inclusive batch (no 50 USDT one-time minimum). */
  async function minimumPerPeriod(p: OwnedPortfolio): Promise<bigint> {
    const row = (await deps.query<{ execution: unknown; allocation: unknown }>('select execution,allocation from strategy_versions where strategy_id=$1 and version=$2',
      [p.strategyId, p.version])).rows[0];
    const execution = row?.execution as AssetExecution | null | undefined;
    if (execution && execution.kind === 'per_asset' && Array.isArray(execution.assets)) return minimumDcaTranche(execution);
    return MIN_ASSET_BATCH_RAW;
  }
  async function keyReady(portfolioId: number, account: string): Promise<boolean> {
    const rows = (await deps.query<{ permissions: unknown }>(`select permissions from session_keys where portfolio_id=$1 and status='active' and expires_at>now()
      order by (split_part(key_ref,'/',6))::bigint desc limit 1`, [portfolioId])).rows;
    return rows[0] !== undefined && yieldAuthorization(rows[0].permissions, lower(account), deps.executor).status === 'ready';
  }
  async function marketOpen(p: Pick<OwnedPortfolio, 'strategyId' | 'version'>): Promise<boolean> {
    const row = (await deps.query<{ allocation: unknown }>('select allocation from strategy_versions where strategy_id=$1 and version=$2', [p.strategyId, p.version])).rows[0];
    const assets = row && typeof row.allocation === 'object' && row.allocation !== null && Array.isArray((row.allocation as { assets?: unknown }).assets)
      ? ((row.allocation as { assets: { address?: unknown }[] }).assets).flatMap(a => typeof a.address === 'string' ? [a.address] : []) : [];
    return assetsMarketOpen(97, assets, deps.now());
  }
  async function view(p: OwnedPortfolio, plan: PlanRow, l: Awaited<ReturnType<typeof live>> | null) {
    const vault = vaultOf(plan.vault_id), i = deps.vaults.indexOf(vault), reading = l?.readings[i] ?? null, v = l?.views[i] ?? null;
    let remaining: bigint | null = null, maxWithdraw: bigint | null = null;
    if (l && reading && plan.state !== 'closed') {
      try { const pos = await l.chain.earn.position(vault, lower(plan.account), l.head.number, l.head.timestamp, reading); remaining = pos.valueRaw; maxWithdraw = pos.maxWithdrawRaw; }
      catch { remaining = null; }
    } else if (plan.state === 'closed') { remaining = 0n; maxWithdraw = 0n; }
    const done = plan.periods_done, next = plan.state === 'active' && done < plan.periods ? periodAt(plan.start_at, plan.frequency, done) : null;
    const inflight = (await deps.query<{ id: string }>(`select id::text from dca_actions where plan_id=$1 and state in ${INFLIGHT} limit 1`, [plan.id])).rows.length > 0;
    return { id: plan.id, state: plan.state, vaultId: vault.id, vaultName: vault.name, apyBps: v?.apyBps ?? null, frequency: plan.frequency,
      periods: plan.periods, periodsDone: done, totalRaw: plan.total_raw, trancheRaw: plan.tranche_raw, startAt: plan.start_at.toISOString(),
      nextRunAt: next?.toISOString() ?? null, waitingForMarket: next !== null && next <= deps.now() && !await marketOpen(p),
      buying: inflight, depositedRaw: plan.deposited_raw, investedRaw: plan.invested_raw, returnedRaw: plan.returned_raw,
      remainingRaw: remaining?.toString() ?? null, maxWithdrawRaw: maxWithdraw?.toString() ?? null,
      earnedRaw: dcaEarned(big(plan.deposited_raw), BigInt(plan.invested_raw), BigInt(plan.returned_raw), remaining)?.toString() ?? null,
      authorization: await keyReady(p.id, plan.account) ? 'ready' as const : 'renewal_required' as const,
      createdAt: plan.created_at.toISOString(), closedAt: plan.closed_at?.toISOString() ?? null, closeReason: plan.close_reason };
  }
  const offer = (views: VaultView[] | null) => {
    const best = views?.find(v => v.bestRate) ?? null;
    return best ? { vaultId: best.id, name: best.name, apyBps: best.apyBps } : null;
  };

  return {
    async get(id: number, wallet: string) {
      const p = await owned(id, wallet);
      let l: Awaited<ReturnType<typeof live>> | null = null;
      try { l = await live(); } catch { l = null; }
      const plan = await latestPlan(p.accountAddress);
      return { portfolioId: id, account: lower(p.accountAddress), status: plan?.state ?? 'none', minimumPerPeriodRaw: (await minimumPerPeriod(p)).toString(),
        frequencies: DCA_FREQUENCIES, minPeriods: DCA_MIN_PERIODS, maxPeriods: DCA_MAX_PERIODS, offer: offer(l?.views ?? null),
        plan: plan ? await view(p, plan, l) : null, updatedAt: l ? new Date(Number(l.head.timestamp) * 1000).toISOString() : null };
    },
    /** Returns the owner-signed calls (one UserOp from the portfolio account) that put the whole total into the vault. */
    async create(id: number, wallet: string, input: unknown) {
      const p = await owned(id, wallet);
      const b = body(input, ['totalRaw', 'periods', 'frequency'], ['startAt', 'vaultId']);
      if (typeof b.totalRaw !== 'string' || !/^[1-9][0-9]{0,77}$/.test(b.totalRaw) || BigInt(b.totalRaw) > UINT256_MAX) throw new ValidationError('INVALID_AMOUNT', 'totalRaw 須為正整數字串。');
      const total = BigInt(b.totalRaw);
      if (typeof b.periods !== 'number' || !Number.isInteger(b.periods) || b.periods < DCA_MIN_PERIODS || b.periods > DCA_MAX_PERIODS) {
        throw new ValidationError('INVALID_PERIODS', `periods 須為 ${DCA_MIN_PERIODS}–${DCA_MAX_PERIODS} 的整數。`);
      }
      const periods = b.periods;
      if (typeof b.frequency !== 'string' || !(DCA_FREQUENCIES as readonly string[]).includes(b.frequency)) throw new ValidationError('INVALID_FREQUENCY', 'frequency 須為 daily、weekly、biweekly 或 monthly。');
      const frequency = b.frequency as DcaFrequency, now = deps.now();
      // startAt = first purchase date picked by the user. "Today" in any time zone (up to 24 h ago) means the
      // next scheduler round (next market open for stocks); later periods keep its time of day.
      let startAt = now;
      if (b.startAt !== undefined && b.startAt !== null) {
        const t = typeof b.startAt === 'string' ? new Date(b.startAt) : new Date(NaN);
        if (!Number.isFinite(t.getTime()) || t.getTime() < now.getTime() - DAY_MS || t.getTime() > now.getTime() + 366 * DAY_MS) {
          throw new ValidationError('INVALID_START', 'startAt 須為今天起一年內的日期（ISO 時間）。');
        }
        startAt = t < now ? now : t;
      }
      const tranche = total / BigInt(periods), minimum = await minimumPerPeriod(p);
      if (tranche < minimum) throw new ValidationError('DCA_PERIOD_TOO_SMALL', `每期至少 ${usdt(minimum)} USDT（總額 ÷ 期數）。`);
      const existing = await openPlan(p.accountAddress);
      if (existing && existing.state !== 'awaiting_deposit') throw new AppError(409, 'DCA_ALREADY_ACTIVE', '這個帳戶已有進行中的定投。');
      let l;
      try { l = await live(); } catch { return { status: 'unavailable' as const, reason: 'data_unavailable', message: TEMPORARILY }; }
      const chosen = b.vaultId === undefined ? l.views.find(v => v.bestRate) : l.views.find(v => v.id === b.vaultId);
      if (b.vaultId !== undefined && !chosen) throw new ValidationError('INVALID_VAULT', '請選擇一個 vault。');
      if (!chosen || !chosen.depositOpen) return { status: 'unavailable' as const, reason: chosen?.reason ?? 'no_open_vault', message: chosen?.message ?? TEMPORARILY };
      const vault = vaultOf(chosen.id), reading = l.readings[deps.vaults.indexOf(vault)] as VaultReading;
      if (reading.capRemainingRaw !== null && total > reading.capRemainingRaw) return { status: 'unavailable' as const, reason: 'cap_reached', message: TEMPORARILY };
      const account = lower(p.accountAddress);
      let balance: bigint, allowance: bigint, receiptAllowance: bigint;
      try {
        [balance, allowance, receiptAllowance] = await Promise.all([l.chain.earn.balance(vault.asset, account, l.head.number),
          l.chain.earn.allowance(vault.asset, account, vault.spender, l.head.number), l.chain.earn.allowance(vault.receipt, account, deps.executor, l.head.number)]);
      } catch { return { status: 'unavailable' as const, reason: 'data_unavailable', message: TEMPORARILY }; }
      // Only cash nobody else has claimed: funding lots, job reserves and other buckets stay untouched.
      const classified = BigInt((await deps.query<{ n: string }>(`select coalesce((select unallocated_hold_raw+stack_prefund_raw+allocated_cash_raw+reserved_input_raw+
        reserved_fee_raw+withdrawal_raw+yield_raw from strategy_cash_balances where chain_id=97 and portfolio_id=$1),0)::text as n`, [id])).rows[0]?.n ?? '0');
      const free = balance > classified ? balance - classified : 0n;
      if (free < total) throw new AppError(409, 'DCA_FUNDS_NOT_IN_ACCOUNT', `請先把 ${usdt(total)} USDT 轉進這個組合的帳戶（目前可用 ${usdt(free)}）。`);
      const calls: Call[] = [...dcaDepositCalls(vault, account, total, allowance), ...(receiptAllowance < UINT256_MAX / 2n ? [dcaReceiptApproval(vault, deps.executor)] : [])];
      const planId = await deps.transaction(async db => {
        await db.query("set local lock_timeout='5s'");
        await db.query(`update dca_plans set state='closed',close_reason='replaced',closed_at=clock_timestamp(),updated_at=clock_timestamp()
          where chain_id=97 and account=$1 and state='awaiting_deposit'`, [account]);
        const row = (await db.query<{ id: string }>(`insert into dca_plans(chain_id,portfolio_id,account,owner,vault_id,market_id,total_raw,periods,frequency,tranche_raw,start_at,state)
          values(97,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'awaiting_deposit') returning id::text`,
          [id, account, lower(p.ownerAddress), vault.id, vault.marketId, total.toString(), periods, frequency, tranche.toString(), startAt])).rows[0];
        if (!row) throw new AppError(503, 'DCA_UNAVAILABLE', TEMPORARILY);
        return row.id;
      });
      return { status: 'ready' as const, planId, authorization: await keyReady(id, account) ? 'ready' as const : 'renewal_required' as const,
        vaultId: vault.id, vaultName: vault.name, apyBps: chosen.apyBps, totalRaw: total.toString(), periods, frequency, trancheRaw: tranche.toString(),
        startAt: startAt.toISOString(), calls };
    },
    /** Deposit confirmation (plan becomes active) or the confirmation of a "take the rest back" (plan closes). Idempotent. */
    async confirm(id: number, wallet: string, input: unknown) {
      const p = await owned(id, wallet);
      const hash = txHash(body(input, ['txHash']).txHash);
      const plan = await openPlan(p.accountAddress);
      if (!plan) {
        const done = (await deps.query<PlanRow>(`select ${PLAN_COLUMNS} from dca_plans where chain_id=97 and account=$1 and (deposit_tx_hash=$2 or close_tx_hash=$2) order by id desc limit 1`,
          [lower(p.accountAddress), hash])).rows[0];
        if (done) return { status: 'confirmed' as const, state: done.state };
        throw new AppError(404, 'DCA_NOT_FOUND', '這個組合沒有進行中的定投。');
      }
      if (plan.deposit_tx_hash === hash) return { status: 'confirmed' as const, state: plan.state };
      const vault = vaultOf(plan.vault_id), chain = deps.chain();
      let receipt: Awaited<ReturnType<CashEarnChain['receipt']>>;
      try {
        receipt = await chain.earn.receipt(hash);
        if (!receipt || (await chain.earn.blockHash(receipt.blockNumber)).toLowerCase() !== receipt.blockHash.toLowerCase()) return { status: 'pending' as const, state: plan.state };
      } catch { return { status: 'pending' as const, state: plan.state }; }
      if (receipt.status !== 'success') throw new AppError(409, 'TX_FAILED', '這筆交易沒有成功，金額沒有移動。');
      if (plan.state === 'awaiting_deposit') {
        const deposited = flowsFromLogs([vault], lower(plan.account), receipt.logs).filter(f => f.kind === 'deposit').reduce((n, f) => n + f.assetsRaw, 0n);
        if (deposited === 0n) throw new AppError(409, 'NO_DCA_DEPOSIT', '這筆交易沒有把 USDT 存進定投的 vault。');
        if (deposited !== BigInt(plan.total_raw)) throw new AppError(409, 'DCA_DEPOSIT_MISMATCH', '存入金額與定投總額不同。');
        await deps.query(`update dca_plans set state='active',deposited_raw=$2,deposit_tx_hash=$3,deposited_at=clock_timestamp(),updated_at=clock_timestamp()
          where id=$1 and state='awaiting_deposit'`, [plan.id, deposited.toString(), hash]);
        // "Sell all" paused this portfolio and a paused portfolio's DCA waits in the vault ([DCA_PORTFOLIO_PAUSED]): the
        // owner's deposit resumes it (src/sell-all-resume.ts), so the periods are bought like on a first buy.
        if (await pausedBySellAll(p, deps.holdsOnlyCash)) await deps.query(RESUME_AFTER_SELL_ALL_SQL, [id]);
        // The same deposit while a "sell all" is still unfinished ends that request (src/sell-all-intent.ts).
        await deps.query(NEW_MONEY_ENDS_SELL_ALL_SQL, [id]);
        return { status: 'confirmed' as const, state: 'active' };
      }
      const account = lower(plan.account), owner = lower(plan.owner);
      // Lista/Aave pay the owner straight from the vault; Venus redeems to the account, which forwards it.
      const direct = flowsFromLogs([vault], owner, receipt.logs).filter(f => f.kind === 'withdraw').reduce((n, f) => n + f.assetsRaw, 0n);
      const redeemed = flowsFromLogs([vault], account, receipt.logs).filter(f => f.kind === 'withdraw').reduce((n, f) => n + f.assetsRaw, 0n);
      const forwarded = usdtTransfers(receipt.logs, vault.asset, account, owner);
      const returned = direct + forwarded;
      if (returned === 0n) throw new AppError(409, 'NO_DCA_RETURN', '這筆交易沒有把定投餘額領回錢包。');
      const head = await chain.earn.head();
      const shares = await chain.earn.balance(vault.receipt, account, head.number);
      if (shares > 0n) return { status: 'pending' as const, state: plan.state };
      // Venus interest accrued between quote and inclusion stays in the account: classify that exact dust as this
      // portfolio's allocated cash so no unclassified USDT is left behind (My mix cash must match exactly).
      const dust = redeemed > forwarded ? redeemed - forwarded : 0n;
      await deps.transaction(async db => {
        await db.query("set local lock_timeout='5s'");
        const closed = (await db.query<{ id: string }>(`update dca_plans set state='closed',close_reason='withdrawn',close_tx_hash=$2,returned_raw=returned_raw+$3,
          closed_at=clock_timestamp(),updated_at=clock_timestamp() where id=$1 and state in ('active','paused') returning id::text`, [plan.id, hash, returned.toString()])).rows[0];
        if (!closed || dust === 0n) return;
        await db.query(`insert into strategy_cash_balances(chain_id,portfolio_id,account) values(97,$1,$2) on conflict(chain_id,portfolio_id) do nothing`, [id, account]);
        await db.query('select portfolio_id from strategy_cash_balances where chain_id=97 and portfolio_id=$1 for update', [id]);
        await db.query(`update strategy_cash_balances set allocated_cash_raw=allocated_cash_raw+$2::numeric,updated_at=clock_timestamp() where chain_id=97 and portfolio_id=$1`, [id, dust.toString()]);
      });
      return { status: 'confirmed' as const, state: 'closed', returnedRaw: returned.toString() };
    },
    async setPaused(id: number, wallet: string, paused: boolean) {
      const p = await owned(id, wallet);
      const plan = await openPlan(p.accountAddress);
      if (!plan || plan.state === 'awaiting_deposit') throw new AppError(404, 'DCA_NOT_FOUND', '這個組合沒有進行中的定投。');
      await deps.query(`update dca_plans set state=$2,updated_at=clock_timestamp() where id=$1 and state in ('active','paused')`, [plan.id, paused ? 'paused' : 'active']);
      return { status: 'ok' as const, state: paused ? 'paused' : 'active' };
    },
    /** The not-yet-invested remainder, interest included, straight back to the owner wallet. Stops further periods. */
    async withdraw(id: number, wallet: string) {
      const p = await owned(id, wallet);
      const plan = await openPlan(p.accountAddress);
      if (!plan) throw new AppError(404, 'DCA_NOT_FOUND', '這個組合沒有進行中的定投。');
      if (plan.state === 'awaiting_deposit') {
        await deps.query(`update dca_plans set state='closed',close_reason='replaced',closed_at=clock_timestamp(),updated_at=clock_timestamp() where id=$1 and state='awaiting_deposit'`, [plan.id]);
        return { status: 'closed' as const, calls: [] };
      }
      if ((await deps.query(`select id from dca_actions where plan_id=$1 and state in ${INFLIGHT} limit 1`, [plan.id])).rows.length) {
        throw new AppError(409, 'DCA_BUSY', '這一期正在買入，請稍後再試。');
      }
      const vault = vaultOf(plan.vault_id), account = lower(plan.account);
      let l;
      try { l = await live(); } catch { return { status: 'unavailable' as const, reason: 'data_unavailable', message: TEMPORARILY }; }
      const reading = l.readings[deps.vaults.indexOf(vault)];
      if (!reading) return { status: 'unavailable' as const, reason: 'data_unavailable', message: TEMPORARILY };
      const pos = await l.chain.earn.position(vault, account, l.head.number, l.head.timestamp, reading);
      if (pos.sharesRaw === 0n) {
        await deps.query(`update dca_plans set state='closed',close_reason='empty',closed_at=clock_timestamp(),updated_at=clock_timestamp() where id=$1 and state in ('active','paused')`, [plan.id]);
        return { status: 'closed' as const, calls: [] };
      }
      await deps.query(`update dca_plans set state='paused',updated_at=clock_timestamp() where id=$1 and state='active'`, [plan.id]);
      if (pos.maxWithdrawRaw < pos.valueRaw) return { status: 'limited' as const, maxWithdrawRaw: pos.maxWithdrawRaw.toString(),
        message: `You can withdraw up to ${usdt(pos.maxWithdrawRaw)} USDT right now.` };
      return { status: 'ready' as const, amountRaw: pos.valueRaw.toString(), calls: dcaReturnCalls(vault, account, lower(plan.owner), pos.sharesRaw, pos.valueRaw) };
    },
  };
}

/** Journal of one session-key redemption (db 0064 dca_actions); one in-flight action per plan. */
function journal(deps: DcaDeps, plan: PlanRow, portfolioId: number, through: number, shares: bigint): YieldOperationJournal {
  return {
    async prepare(input) {
      const row = (await deps.query<{ id: string }>(`insert into dca_actions(plan_id,chain_id,portfolio_id,account,market_id,through_period,shares_raw,state,execution_key,user_op_hash,nonce,call_data,plan)
        values($1,97,$2,$3,$4,$5,$6,'prepared',$7,$8,$9,$10,$11::jsonb) returning id::text`,
        [plan.id, portfolioId, plan.account, plan.market_id, through, shares.toString(), input.executionKey.toLowerCase(), input.userOpHash.toLowerCase(),
          input.nonce.toString(), input.callData.toLowerCase(), planJson(input.plan)])).rows[0];
      if (!row) throw new Error('dca action not saved');
      return row.id;
    },
    async sending(id) { await deps.query("update dca_actions set state='sending',updated_at=clock_timestamp() where id=$1 and state='prepared'", [id]); },
    async submitted(id) { await deps.query("update dca_actions set state='submitted',updated_at=clock_timestamp() where id=$1 and state in ('prepared','sending')", [id]); },
    confirmed: (id, evidence) => confirmAction(deps, id, evidence),
    async reverted(id, r) { await deps.query(`update dca_actions set state='reverted',tx_hash=$2,updated_at=clock_timestamp() where id=$1 and state in ${INFLIGHT}`, [id, r.txHash.toLowerCase()]); },
    async unknown(id) { await deps.query(`update dca_actions set state='unknown',updated_at=clock_timestamp() where id=$1 and state in ${INFLIGHT}`, [id]); },
  };
}
async function confirmAction(deps: DcaDeps, id: string, evidence: YieldEvidence): Promise<void> {
  await deps.transaction(async db => {
    const a = (await db.query<{ plan_id: string; through_period: number }>(`update dca_actions set state='confirmed',assets_raw=$2,tx_hash=$3,updated_at=clock_timestamp()
      where id=$1 and state in ${INFLIGHT} returning plan_id::text,through_period`, [id, evidence.assets.toString(), evidence.txHash.toLowerCase()])).rows[0];
    if (!a) return;
    await db.query(`update dca_plans set periods_done=$2,invested_raw=invested_raw+$3,state=case when $2=periods and state in ('active','paused') then 'completed' else state end,
      updated_at=clock_timestamp() where id=$1`, [a.plan_id, a.through_period, evidence.assets.toString()]);
  });
}

type RoundDeps = DcaDeps & { log: (line: string) => void; dryRun: boolean };
/** Scheduler step for one plan, under the account's portfolio lock. Returns a one-line reason. */
async function step(d: RoundDeps, plan: PlanRow, portfolioId: number): Promise<string> {
  const vault = d.vaults.find(v => v.id === plan.vault_id);
  if (!vault) return '[DCA_VAULT_UNKNOWN]';
  const pending = (await d.query<ActionRow>(`select id::text,plan_id::text,through_period,shares_raw::text,state,plan,nonce::text,call_data,user_op_hash,assets_raw::text,tx_hash,lot_id::text,created_at
    from dca_actions where plan_id=$1 and state in ${INFLIGHT} limit 1`, [plan.id])).rows[0];
  if (pending) {
    if (d.dryRun) return '[DCA_RECONCILE] dry-run';
    const saved: SavedYieldOperation = { plan: restorePlan(pending.plan), nonce: BigInt(pending.nonce), callData: pending.call_data, userOpHash: pending.user_op_hash };
    const j = journal(d, plan, portfolioId, pending.through_period, BigInt(pending.shares_raw));
    try {
      const result = await d.reconcile(saved);
      if (result.status === 'confirmed') await j.confirmed(pending.id, result.evidence); else await j.reverted(pending.id, result);
      return `[DCA_RECONCILED] ${result.status}`;
    } catch {
      // Past its deadline an executeWithdraw can no longer move money; untouched shares prove it never ran.
      const head = await d.chain().earn.head();
      if (head.timestamp > saved.plan.deadline + EXPIRED_AFTER_SECONDS &&
          await d.chain().earn.balance(vault.receipt, lower(plan.account), head.number) === saved.plan.receiptBalance) {
        await d.query(`update dca_actions set state='reverted',updated_at=clock_timestamp() where id=$1 and state in ${INFLIGHT}`, [pending.id]);
        return '[DCA_EXPIRED] 原贖回已過期且未執行';
      }
      await j.unknown(pending.id);
      return '[DCA_RECONCILIATION_REQUIRED] 原贖回結果未知，保留在途，不重送';
    }
  }
  if (plan.state !== 'active') return '[DCA_NOT_ACTIVE]';
  // An unfinished "sell all" (src/sell-all-intent.ts) counts as paused: no tranche is bought while everything is being sold.
  const portfolio = (await d.query<{ schedule_state: string; strategy_id: string; version: number; selling?: boolean }>(`select schedule_state,strategy_id::text,version,${SELL_ALL_OF_PORTFOLIO_SQL} as selling from portfolios p where p.id=$1`, [portfolioId])).rows[0];
  if (!portfolio || portfolio.schedule_state !== 'active' || portfolio.selling === true) return '[DCA_PORTFOLIO_PAUSED] 組合暫停中，餘額留在 vault';
  if ((await d.query(`select id from operations where portfolio_id=$1 and (state in ('pending','submitted') or (state='failed' and (tx_hash is not null or user_op_hash is not null))) limit 1`, [portfolioId])).rows.length) {
    return '[PREVIOUS_INFLIGHT] 帳戶其他操作待對帳';
  }
  const now = d.now(), periods = { startAt: plan.start_at, frequency: plan.frequency, periods: plan.periods, periodsDone: plan.periods_done, trancheRaw: BigInt(plan.tranche_raw) };
  const due = duePeriods(periods, now);
  if (due === 0) return '[DCA_NOT_DUE]';
  const allocation = (await d.query<{ allocation: unknown }>('select allocation from strategy_versions where strategy_id=$1 and version=$2', [portfolio.strategy_id, portfolio.version])).rows[0]?.allocation;
  const assets = allocation && typeof allocation === 'object' && Array.isArray((allocation as { assets?: unknown }).assets)
    ? (allocation as { assets: { address?: unknown }[] }).assets.flatMap(a => typeof a.address === 'string' ? [a.address] : []) : null;
  if (!assets) return '[DCA_VERSION_UNAVAILABLE]';
  if (!assetsMarketOpen(97, assets, now)) return '[MARKET_CLOSED] 美股休市，本期留在 vault 到開盤';
  const chain = d.chain(), head = await chain.earn.head(), account = lower(plan.account);
  const reading = await chain.earn.vault(vault, head.number, head.timestamp);
  const pos = await chain.earn.position(vault, account, head.number, head.timestamp, reading);
  if (pos.sharesRaw === 0n) {
    await d.query(`update dca_plans set state='closed',close_reason='empty',closed_at=clock_timestamp(),updated_at=clock_timestamp() where id=$1 and state='active'`, [plan.id]);
    return '[DCA_EMPTY] vault 已無餘額，定投結束';
  }
  const through = plan.periods_done + due, target = trancheTarget(periods, through);
  const all = target === 'all' || target >= pos.valueRaw;
  const wanted = all ? pos.valueRaw : target as bigint;
  if (pos.maxWithdrawRaw < wanted) return '[DCA_LIQUIDITY] vault 可領現金不足，下輪再試';
  let shares = all ? pos.sharesRaw : await chain.sharesFor(vault, wanted, head.number, head.timestamp);
  if (shares > pos.sharesRaw) shares = pos.sharesRaw;
  if (shares === 0n) return '[DCA_ZERO_SHARES]';
  if (await chain.earn.allowance(vault.receipt, account, d.executor, head.number) < shares) return '[DCA_APPROVAL_REQUIRED] 帳戶尚未授權 executor 領出';
  if (d.dryRun) return `[DCA_DUE] dry-run：第 ${through}/${plan.periods} 期，贖回 ${shares} shares`;
  const key = await d.sessionKey(portfolioId, account, now);
  if (key) {
    const evidence = await d.submit({ publicClient: d.publicClient(), bundlerUrl: resolveBundlerUrl(), account, sessionKey: key.sessionKey, policies: key.policies,
      action: { marketId: vault.marketId, kind: 'withdraw', amount: shares }, journal: journal(d, plan, portfolioId, through, shares) });
    return `[DCA_REDEEMED] 第 ${through}/${plan.periods} 期 ${evidence.assets} USDT 已回到帳戶`;
  }
  return '[DCA_AUTHORIZATION_REQUIRED] 需要 owner 更新 session 權限（renewal）';
}

/** Each confirmed redemption becomes exactly one funding lot of the account's current portfolio; the buy runs at its next turn. */
async function creditPending(d: RoundDeps, plan: PlanRow, portfolioId: number): Promise<number> {
  const rows = (await d.query<{ id: string; assets_raw: string; tx_hash: Hex }>(`select id::text,assets_raw::text,tx_hash from dca_actions
    where plan_id=$1 and state='confirmed' and lot_id is null order by id`, [plan.id])).rows;
  let credited = 0;
  for (const a of rows) {
    const evidence = await d.chain().tranche(a.tx_hash, lower(plan.account), BigInt(a.assets_raw));
    const lot = await d.credit(portfolioId, plan.owner, evidence);
    await d.query('update dca_actions set lot_id=$2,updated_at=clock_timestamp() where id=$1 and lot_id is null', [a.id, lot.id]);
    await d.query("update portfolios set next_run_at=least(coalesce(next_run_at,$2::timestamptz),$2::timestamptz) where id=$1 and schedule_state='active'", [portfolioId, d.now()]);
    credited++;
  }
  return credited;
}

export async function runDcaRound(options: { dryRun: boolean; limit: number; log: (line: string) => void }, overrides: Partial<DcaDeps> = {}): Promise<{ checked: number; credited: number; blocked: number }> {
  const d: RoundDeps = { ...defaults(), ...overrides, log: options.log, dryRun: options.dryRun };
  if (d.chainId !== 97 || d.vaults.length === 0) return { checked: 0, credited: 0, blocked: 0 };
  const plans = (await d.query<PlanRow & { current_portfolio: string | null }>(`select ${PLAN_COLUMNS},
      (select a.portfolio_id::text from smart_accounts a where a.chain_id=97 and a.address=p.account and a.retired_at is null order by a.portfolio_id desc limit 1) as current_portfolio
    from dca_plans p where p.chain_id=97 and (p.state='active' or exists(select 1 from dca_actions a where a.plan_id=p.id
      and (a.state in ${INFLIGHT} or (a.state='confirmed' and a.lot_id is null)))) order by p.id limit $1`, [options.limit])).rows;
  let checked = 0, credited = 0, blocked = 0;
  for (const plan of plans) {
    const portfolioId = Number(plan.current_portfolio);
    if (!Number.isSafeInteger(portfolioId) || portfolioId <= 0) { blocked++; continue; }
    try {
      const reason = await d.lock(portfolioId, () => step(d, plan, portfolioId));
      checked++;
      if (reason === null) d.log(`[dca] plan ${plan.id}: 帳戶處理中，下輪再試`);
      else if (reason !== '[DCA_NOT_DUE]' && reason !== '[DCA_NOT_ACTIVE]') d.log(`[dca] plan ${plan.id}: ${reason}`);
      if (!d.dryRun) credited += await creditPending(d, plan, portfolioId);
    } catch (error) {
      blocked++;
      const code = error instanceof AppError ? error.code : 'DCA_UNAVAILABLE';
      d.log(`[dca] plan ${plan.id}: blocked ${code}`);
    }
  }
  return { checked, credited, blocked };
}
