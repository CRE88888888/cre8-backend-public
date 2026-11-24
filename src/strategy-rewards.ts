import { createPublicClient, createWalletClient, decodeEventLog, encodeFunctionData, erc20Abi, parseAbi } from 'viem';
import type { Address, Hex, Log } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';
import { query as dbQuery } from './db.js';
import { ValidationError } from './errors.js';
import { rpcTransport } from './rpc-transport.js';
import { PUBLIC_RPC_56 } from './strategy-earn-mainnet.js';

/**
 * Yield strategy reward tokens (LISTA, XVS), db 0068. BSC mainnet only, behind STRATEGY_REWARDS_ENABLED (default off):
 * chain 97 has no merkle distributor, so on testnet this module is only exercised by tests.
 *
 * Lista: LendingRewardsDistributor publishes weekly merkle roots. `claim(account, totalAmount, proof)` (one LISTA
 * distributor) and `batchClaim(accounts, tokens, totalAmounts, proofs)` (the multi-token one) are callable by anyone and
 * pay the account, so the operator sends them: no session key, no UserOp, no paymaster rule. Amounts are cumulative;
 * claimable = totalAmount − claimed(account).
 * Proofs come from api.lista.org and need a signature BY THE HOLDER over REWARD_MESSAGE(datetime), valid 7 days
 * (contracts: type=safe, checked by ERC-1271).
 *
 * Signature (decision): the OWNER signs once per 7 days in the app, silently, with the embedded wallet, when a
 * portfolio page is opened (GET shows `signature.needed`). We did not give the session key ERC-1271 signing: a key
 * that can produce valid account signatures can sign anything that accepts ERC-1271 (Permit2, order books), which is
 * far more than "read my reward proof". Nothing is lost when the owner stays away: the merkle amount is cumulative
 * and is claimed the next time a fresh signature exists.
 *
 * Venus: `Comptroller.claimVenus(holder)` is callable by anyone and pays XVS to the holder.
 *
 * Holders: the portfolio account (borrow incentives) and, on routing v2, its strategy box (vault incentives; the box
 * validates the account's signature by ERC-1271). Tokens stay in the portfolio account, are shown per portfolio, and
 * leave only to the owner's wallet on sell-all / withdraw / delete, as they are (no swap: an automatic LISTA/XVS sale
 * would need its own slippage rules and price source, and the amounts are small).
 */
export const REWARDS = {
  CHAIN_ID: 56,
  LISTA_DISTRIBUTOR: '0x665410ee5ea96aa729589491badc11e0fe163d29',
  LISTA_MULTI_DISTRIBUTOR: '0x2993e9ea76f5839a20673e1b3cf6666ab5b3ae76',
  VENUS_COMPTROLLER: '0xfd36e2c2a6789db23113685031d7f16329158384',
  LISTA: '0xfceb31a79f71ac9cbdcf853519c1b12d379edc46',
  XVS: '0xcf6bb5389c92bdda8a3747ddb454cb7a64626c63',
  PROOF_API: 'https://api.lista.org/api/moolah/emission/userProof',
  MULTI_PROOF_API: 'https://api.lista.org/api/moolah/emission/userMultiProof',
  /** Lista accepts a signature for 7 days. */
  SIGNATURE_TTL_MS: 7 * 86_400_000,
  /** The app is asked for a new one a day early. */
  SIGNATURE_REFRESH_MS: 6 * 86_400_000,
  /** A submitted signature must carry a datetime this close to now. */
  SIGNATURE_SKEW_MS: 10 * 60_000,
  /** The job runs once per this interval: roots are weekly, but a daily look shows a new signature's pending amounts the next
   * day instead of the next week. A claim is only sent when something worth MIN_CLAIM_RAW is open, so at most once per root. */
  ROUND_MS: 86_400_000,
  /** Claims under this (raw, 18 decimals) wait for the next round: not worth the gas. */
  MIN_CLAIM_RAW: 10n ** 17n,
} as const;
export const REWARD_MESSAGE = (isoDatetime: string) => `${isoDatetime}\nThank you for your support of listaDAO.`;
export const REWARD_TOKENS: readonly { symbol: string; address: Address }[] = [{ symbol: 'LISTA', address: REWARDS.LISTA }, { symbol: 'XVS', address: REWARDS.XVS }];
export const strategyRewardsEnabled = (chainId: number, env: NodeJS.ProcessEnv = process.env) => chainId === REWARDS.CHAIN_ID && env.STRATEGY_REWARDS_ENABLED === '1';
/** Reward tokens the paymaster lets an owner send from the portfolio account to their own wallet. */
export const sponsoredRewardTokens = (chainId: number, env: NodeJS.ProcessEnv = process.env): Address[] => strategyRewardsEnabled(chainId, env) ? REWARD_TOKENS.map(t => t.address) : [];

export const REWARDS_ABI = parseAbi([
  'function claim(address account, uint256 totalAmount, bytes32[] proof)',
  'function claimed(address account) view returns (uint256)',
  'function batchClaim(address[] accounts, address[] tokens, uint256[] totalAmounts, bytes32[][] proofs)',
  'function claimed(address account, address token) view returns (uint256)',
  'function claimVenus(address holder)',
  'function venusAccrued(address holder) view returns (uint256)',
]);

export type RewardSource = 'lista' | 'lista_multi' | 'venus';
export type RewardSignature = { message: string; signature: Hex; signedAt: Date };
export type Claimable = { source: RewardSource; holder: Address; token: Address; symbol: string; totalRaw: bigint; proof: Hex[] };
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
const addr = (v: unknown): Address => { if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error('bad address'); return v.toLowerCase() as Address; };
const uint = (v: unknown): bigint => { if (typeof v !== 'string' || !/^\d{1,78}$/.test(v)) throw new Error('bad amount'); return BigInt(v); };
const proofOf = (v: unknown): Hex[] => { if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(x))) throw new Error('bad proof'); return v as Hex[]; };

/** What the app posts: the datetime it signed and the account's ERC-1271 signature over REWARD_MESSAGE(datetime). */
export function parseRewardSignature(input: unknown, now: Date): RewardSignature {
  const o = (input ?? {}) as Record<string, unknown>;
  if (typeof o.signedAt !== 'string' || typeof o.signature !== 'string') throw new ValidationError('INVALID_REWARD_SIGNATURE', 'signedAt and signature are required');
  const signedAt = new Date(o.signedAt);
  // Lista reads the datetime back out of the message, so it must be the exact ISO string that was signed.
  if (Number.isNaN(signedAt.getTime()) || signedAt.toISOString() !== o.signedAt) throw new ValidationError('INVALID_REWARD_SIGNATURE', 'signedAt must be an ISO datetime');
  if (Math.abs(now.getTime() - signedAt.getTime()) > REWARDS.SIGNATURE_SKEW_MS) throw new ValidationError('REWARD_SIGNATURE_NOT_CURRENT', 'signedAt is not current');
  if (!/^0x([0-9a-fA-F]{2}){65,2048}$/.test(o.signature)) throw new ValidationError('INVALID_REWARD_SIGNATURE', 'signature must be hex');
  return { message: REWARD_MESSAGE(o.signedAt), signature: o.signature.toLowerCase() as Hex, signedAt };
}
export const signatureUsable = (signedAt: Date, now: Date) => now.getTime() - signedAt.getTime() < REWARDS.SIGNATURE_TTL_MS;

/** Both Lista distributors' proofs for one holder. A holder with nothing earned gets an empty list. */
export async function fetchListaProofs(f: Fetcher, holder: Address, sig: RewardSignature): Promise<Claimable[]> {
  const get = async (base: string) => {
    const url = `${base}?${new URLSearchParams({ address: holder, signature: sig.signature, message: sig.message, type: 'safe' })}`;
    const res = await f(url, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('Lista proof API HTTP ' + res.status);
    const body = await res.json() as { code?: string; msg?: string; data?: unknown };
    if (String(body.code) !== '000000' && body.data === undefined) throw new Error('Lista proof API: ' + String(body.msg ?? body.code).slice(0, 80));
    return body.data;
  };
  const [one, multi] = await Promise.all([get(REWARDS.PROOF_API), get(REWARDS.MULTI_PROOF_API)]);
  const out: Claimable[] = [];
  const single = one as { amountWei?: unknown; proof?: unknown } | null;
  if (single && single.amountWei !== undefined && uint(single.amountWei) > 0n)
    out.push({ source: 'lista', holder, token: REWARDS.LISTA, symbol: 'LISTA', totalRaw: uint(single.amountWei), proof: proofOf(single.proof) });
  for (const m of (Array.isArray(multi) ? multi : []) as { token?: unknown; tokenSymbol?: unknown; amountWei?: unknown; proof?: unknown }[]) {
    if (uint(m.amountWei) === 0n) continue;
    const symbol = typeof m.tokenSymbol === 'string' && /^[A-Za-z0-9]{1,16}$/.test(m.tokenSymbol) ? m.tokenSymbol : 'TOKEN';
    out.push({ source: 'lista_multi', holder, token: addr(m.token), symbol, totalRaw: uint(m.amountWei), proof: proofOf(m.proof) });
  }
  return out;
}

export type RewardTx = { hash: Hex; blockNumber: bigint; logs: readonly Log[] };
export type RewardsChain = {
  /** Cumulative amount the distributor already paid this holder. */
  claimed(source: RewardSource, holder: Address, token: Address): Promise<bigint>;
  /** XVS accrued and not yet paid. */
  venusAccrued(holder: Address): Promise<bigint>;
};
export type RewardsWriter = { send(to: Address, data: Hex): Promise<RewardTx> };

export type TxCall = { to: Address; data: Hex };
/** Anyone-callable claim transactions: one per single-token Lista claim, one batch for every multi-token claim, one per Venus holder. */
export function claimCalls(claims: readonly Claimable[], venusHolders: readonly Address[] = []): TxCall[] {
  const calls: TxCall[] = claims.filter(c => c.source === 'lista').map(c => ({ to: REWARDS.LISTA_DISTRIBUTOR as Address,
    data: encodeFunctionData({ abi: REWARDS_ABI, functionName: 'claim', args: [c.holder, c.totalRaw, c.proof] }) }));
  const multi = claims.filter(c => c.source === 'lista_multi');
  if (multi.length > 0) calls.push({ to: REWARDS.LISTA_MULTI_DISTRIBUTOR as Address, data: encodeFunctionData({ abi: REWARDS_ABI, functionName: 'batchClaim',
    args: [multi.map(c => c.holder), multi.map(c => c.token), multi.map(c => c.totalRaw), multi.map(c => c.proof)] }) });
  for (const holder of venusHolders) calls.push({ to: REWARDS.VENUS_COMPTROLLER as Address, data: encodeFunctionData({ abi: REWARDS_ABI, functionName: 'claimVenus', args: [holder] }) });
  return calls;
}
/** Owner-signed calls that send the account's reward tokens to the owner's wallet as they are (sell-all / withdraw / delete). */
export function rewardExitCalls(balances: readonly { token: Address; balanceRaw: bigint }[], owner: Address): { to: Address; data: Hex; value: '0' }[] {
  return balances.filter(b => b.balanceRaw > 0n).map(b => ({ to: b.token, value: '0' as const, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [owner, b.balanceRaw] }) }));
}

export type RewardEvent = { portfolioId: number; account: Address; holder: Address; kind: 'claim' | 'sweep'; source: RewardSource | null; token: Address; symbol: string;
  amountRaw: bigint; recipient: Address | null; txHash: Hex; logIndex: number; blockNumber: bigint };
const SOURCE_OF: Record<string, RewardSource> = { [REWARDS.LISTA_DISTRIBUTOR]: 'lista', [REWARDS.LISTA_MULTI_DISTRIBUTOR]: 'lista_multi' };
/**
 * Ledger rows from a verified receipt, read off the tokens' own Transfer logs (what actually moved, not what a claim
 * asked for): distributor / Venus -> holder is a claim; portfolio account -> its owner is a sweep. Anything else is ignored.
 */
export function rewardEvents(tx: RewardTx, p: { portfolioId: number; account: Address; holders: readonly Address[]; owner?: Address; tokens: readonly { symbol: string; address: Address }[] }): RewardEvent[] {
  const out: RewardEvent[] = [];
  for (const log of tx.logs) {
    const token = p.tokens.find(t => t.address === log.address.toLowerCase());
    if (!token || log.logIndex == null) continue;
    let from: Address, to: Address, value: bigint;
    try { const d = decodeEventLog({ abi: erc20Abi, eventName: 'Transfer', data: log.data, topics: log.topics }); from = d.args.from.toLowerCase() as Address; to = d.args.to.toLowerCase() as Address; value = d.args.value; }
    catch { continue; }
    if (value === 0n) continue;
    const base = { portfolioId: p.portfolioId, account: p.account, token: token.address, symbol: token.symbol, amountRaw: value, txHash: tx.hash, logIndex: log.logIndex, blockNumber: tx.blockNumber };
    if (p.holders.includes(to) && !p.holders.includes(from) && from !== p.owner)
      out.push({ ...base, holder: to, kind: 'claim', source: SOURCE_OF[from] ?? (token.address === REWARDS.XVS ? 'venus' : 'lista_multi'), recipient: null });
    else if (from === p.account && p.owner !== undefined && to === p.owner) out.push({ ...base, holder: p.account, kind: 'sweep', source: null, recipient: to });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Store (db 0068)
// ---------------------------------------------------------------------------
export function rewardsStore(run: Query = dbQuery as Query) {
  return {
    async saveSignature(chainId: number, portfolioId: number, account: Address, sig: RewardSignature) {
      await run(`insert into strategy_reward_signatures(chain_id,portfolio_id,account,message,signature,signed_at) values($1,$2,$3,$4,$5,$6)
        on conflict (chain_id,account) do update set message=excluded.message, signature=excluded.signature, signed_at=excluded.signed_at, updated_at=clock_timestamp()
        where strategy_reward_signatures.signed_at < excluded.signed_at`, [chainId, portfolioId, account, sig.message, sig.signature, sig.signedAt.toISOString()]);
    },
    /** Accounts with a signature Lista still accepts, with their owner. */
    async signed(chainId: number, now: Date): Promise<{ portfolioId: number; account: Address; owner: Address; sig: RewardSignature }[]> {
      const r = await run(`select s.portfolio_id, s.account, a.owner, s.message, s.signature, s.signed_at from strategy_reward_signatures s
        join smart_accounts a on a.portfolio_id=s.portfolio_id and a.chain_id=s.chain_id and a.address=s.account
        where s.chain_id=$1 and s.signed_at > $2 order by s.portfolio_id`, [chainId, new Date(now.getTime() - REWARDS.SIGNATURE_TTL_MS).toISOString()]);
      return r.rows.map(x => ({ portfolioId: Number(x.portfolio_id), account: x.account, owner: String(x.owner).toLowerCase() as Address,
        sig: { message: x.message, signature: x.signature, signedAt: new Date(x.signed_at) } }));
    },
    async savePending(chainId: number, portfolioId: number, account: Address, c: Pick<Claimable, 'holder' | 'source' | 'token' | 'symbol' | 'totalRaw'>, claimedRaw: bigint) {
      await run(`insert into strategy_reward_pending(chain_id,portfolio_id,account,holder,source,token,symbol,total_raw,claimed_raw) values($1,$2,$3,$4,$5,$6,$7,$8,$9)
        on conflict (chain_id,holder,source,token) do update set total_raw=excluded.total_raw, claimed_raw=excluded.claimed_raw, symbol=excluded.symbol, updated_at=clock_timestamp()`,
        [chainId, portfolioId, account, c.holder, c.source, c.token, c.symbol, c.totalRaw.toString(), claimedRaw.toString()]);
    },
    /** Idempotent: a re-read receipt hits (chain, tx, log) and is skipped. */
    async record(chainId: number, events: readonly RewardEvent[]) {
      for (const e of events) await run(`insert into strategy_reward_events(chain_id,portfolio_id,account,holder,kind,source,token,symbol,amount_raw,recipient,tx_hash,log_index,block_number)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict (chain_id,tx_hash,log_index) do nothing`,
        [chainId, e.portfolioId, e.account, e.holder, e.kind, e.source, e.token, e.symbol, e.amountRaw.toString(), e.recipient, e.txHash, e.logIndex, e.blockNumber.toString()]);
    },
    /**
     * What a portfolio's API shows, from the ledger only (no chain read): per token, what sits in the account
     * (claims − sweeps) and what is earned but not yet claimed; and whether the app should ask the owner to sign again.
     */
    async view(chainId: number, portfolioId: number, now: Date): Promise<RewardsView> {
      const [held, pending, sig] = await Promise.all([
        run(`select token, max(symbol) symbol, sum(case when kind='claim' then amount_raw else -amount_raw end)::text balance from strategy_reward_events
          where chain_id=$1 and portfolio_id=$2 group by token`, [chainId, portfolioId]),
        run(`select token, max(symbol) symbol, sum(greatest(total_raw - claimed_raw, 0))::text pending from strategy_reward_pending where chain_id=$1 and portfolio_id=$2 group by token`, [chainId, portfolioId]),
        run(`select signed_at from strategy_reward_signatures where chain_id=$1 and portfolio_id=$2`, [chainId, portfolioId])]);
      const tokens = new Map<string, { token: Address; symbol: string; balanceRaw: bigint; pendingRaw: bigint }>();
      const at = (token: string, symbol: string) => tokens.get(token) ?? tokens.set(token, { token: token as Address, symbol, balanceRaw: 0n, pendingRaw: 0n }).get(token)!;
      for (const r of held.rows) { const b = BigInt(r.balance); at(r.token, r.symbol).balanceRaw = b > 0n ? b : 0n; }
      for (const r of pending.rows) at(r.token, r.symbol).pendingRaw = BigInt(r.pending);
      const signedAt = sig.rows[0] ? new Date(sig.rows[0].signed_at) : null;
      return { tokens: [...tokens.values()].filter(t => t.balanceRaw > 0n || t.pendingRaw > 0n).map(t => ({ token: t.token, symbol: t.symbol, balanceRaw: t.balanceRaw.toString(), pendingRaw: t.pendingRaw.toString() })),
        signature: { needed: !signedAt || now.getTime() - signedAt.getTime() >= REWARDS.SIGNATURE_REFRESH_MS, signedAt: signedAt?.toISOString() ?? null } };
    },
  };
}
export type RewardsView = { tokens: { token: Address; symbol: string; balanceRaw: string; pendingRaw: string }[]; signature: { needed: boolean; signedAt: string | null } };
export type RewardsStore = ReturnType<typeof rewardsStore>;

// ---------------------------------------------------------------------------
// Chain: reads on the public node only (never the paid RPC_URL); writes by the operator key
// ---------------------------------------------------------------------------
export function defaultRewardsChain(rpc = PUBLIC_RPC_56): RewardsChain {
  const client = createPublicClient({ chain: bsc, transport: rpcTransport('strategy-rewards', rpc, { retryCount: 1, timeout: 15_000 }) });
  return {
    claimed: (source, holder, token) => source === 'lista'
      ? client.readContract({ address: REWARDS.LISTA_DISTRIBUTOR as Address, abi: REWARDS_ABI, functionName: 'claimed', args: [holder] })
      : client.readContract({ address: REWARDS.LISTA_MULTI_DISTRIBUTOR as Address, abi: REWARDS_ABI, functionName: 'claimed', args: [holder, token] }),
    venusAccrued: holder => client.readContract({ address: REWARDS.VENUS_COMPTROLLER as Address, abi: REWARDS_ABI, functionName: 'venusAccrued', args: [holder] }),
  };
}
/** Operator key that pays for the anyone-callable claims. Absent key = the round only refreshes pending amounts. */
export function rewardsWriter(env: NodeJS.ProcessEnv = process.env): RewardsWriter | null {
  const raw = env.STRATEGY_REWARDS_KEEPER_PRIVATE_KEY?.trim();
  if (!raw) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error('STRATEGY_REWARDS_KEEPER_PRIVATE_KEY must be a 32-byte hex key');
  const rpc = env.RPC_URL?.trim();
  if (!rpc) throw new Error('RPC_URL is required for the strategy rewards keeper');
  const transport = rpcTransport('strategy-rewards', rpc, { retryCount: 1, timeout: 15_000 });
  const wallet = createWalletClient({ account: privateKeyToAccount(raw as Hex), chain: bsc, transport }), pub = createPublicClient({ chain: bsc, transport });
  return { async send(to, data) {
    const hash = await wallet.sendTransaction({ to, data });
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== 'success') throw new Error('reverted ' + hash);
    return { hash, blockNumber: receipt.blockNumber, logs: receipt.logs };
  } };
}

// ---------------------------------------------------------------------------
// Weekly round
// ---------------------------------------------------------------------------
export type RewardsRoundResult = { accounts: number; holders: number; pending: number; claimed: number; failed: number; writer: boolean };
export type RewardsRoundDeps = { chainId: number; env?: NodeJS.ProcessEnv; now?: () => Date; fetch?: Fetcher; store?: RewardsStore; chain?: RewardsChain; writer?: RewardsWriter | null;
  /** Other addresses that earn for this account (routing v2: its strategy box), each with the signature Lista must be sent for
   * it: the box only validates the reward message and expects its own signature form (src/strategy-earn-v2.ts boxRewardSignature). */
  extraHolders?: (account: Address, sig: RewardSignature) => Promise<{ holder: Address; sig: RewardSignature }[]>;
  /** Holders with a Venus position (XVS). */
  venusHolders?: (account: Address) => Promise<boolean> };
let lastRoundAt = 0;
export const resetRewardsRoundClock = () => { lastRoundAt = 0; };
/**
 * For every account with a usable signature: fetch its holders' proofs, read what was already paid, store what is
 * pending, and (live, with a writer) claim what is worth claiming and write the ledger from the receipts.
 * Returns null when the feature is off for this chain or the round is not due. One log line per account.
 */
export async function runStrategyRewardsRound(args: { dryRun: boolean; log: (line: string) => void; force?: boolean }, deps: RewardsRoundDeps): Promise<RewardsRoundResult | null> {
  const env = deps.env ?? process.env, now = (deps.now ?? (() => new Date()))();
  if (!strategyRewardsEnabled(deps.chainId, env)) return null;
  if (!args.force && now.getTime() - lastRoundAt < REWARDS.ROUND_MS) return null;
  lastRoundAt = now.getTime();
  const store = deps.store ?? rewardsStore(), chain = deps.chain ?? defaultRewardsChain(), f: Fetcher = deps.fetch ?? ((u, i) => fetch(u, i));
  const writer = deps.writer === undefined ? rewardsWriter(env) : deps.writer;
  const result: RewardsRoundResult = { accounts: 0, holders: 0, pending: 0, claimed: 0, failed: 0, writer: writer !== null };
  for (const a of await store.signed(deps.chainId, now)) {
    result.accounts++;
    try {
      const signedHolders = [{ holder: a.account, sig: a.sig }, ...(deps.extraHolders ? await deps.extraHolders(a.account, a.sig) : [])];
      const holders = signedHolders.map(h => h.holder);
      const due: Claimable[] = [], notes: string[] = [];
      for (const { holder, sig } of signedHolders) {
        result.holders++;
        for (const c of await fetchListaProofs(f, holder, sig)) {
          const claimed = await chain.claimed(c.source, holder, c.token);
          await store.savePending(deps.chainId, a.portfolioId, a.account, c, claimed);
          const open = c.totalRaw > claimed ? c.totalRaw - claimed : 0n;
          if (open > 0n) result.pending++;
          if (open >= REWARDS.MIN_CLAIM_RAW) due.push(c);
          notes.push(`${c.symbol} ${holder === a.account ? 'account' : 'box'} pending ${open}`);
        }
      }
      const venus: Address[] = [];
      if (deps.venusHolders && await deps.venusHolders(a.account)) {
        const accrued = await chain.venusAccrued(a.account);
        await store.savePending(deps.chainId, a.portfolioId, a.account, { holder: a.account, source: 'venus', token: REWARDS.XVS as Address, symbol: 'XVS', totalRaw: accrued }, 0n);
        if (accrued > 0n) result.pending++;
        if (accrued >= REWARDS.MIN_CLAIM_RAW) venus.push(a.account);
        notes.push(`XVS account pending ${accrued}`);
      }
      const calls = claimCalls(due, venus);
      if (args.dryRun || !writer || calls.length === 0) {
        args.log(`[strategy-rewards] portfolio ${a.portfolioId}: ${notes.join(', ') || 'nothing earned'}${calls.length > 0 ? ` — ${calls.length} claim(s) ${args.dryRun ? 'skipped (dry run)' : 'waiting for a keeper key'}` : ''}`);
        continue;
      }
      for (const call of calls) {
        const tx = await writer.send(call.to, call.data);
        const events = rewardEvents(tx, { portfolioId: a.portfolioId, account: a.account, holders, owner: a.owner, tokens: tokensOf(due) });
        await store.record(deps.chainId, events);
        result.claimed += events.length;
        // What the distributor has paid is now the proof's total: nothing pending until the next root.
        for (const c of due.filter(c => events.some(e => e.holder === c.holder && e.token === c.token))) await store.savePending(deps.chainId, a.portfolioId, a.account, c, c.totalRaw);
        for (const e of events.filter(e => e.source === 'venus')) await store.savePending(deps.chainId, a.portfolioId, a.account, { holder: e.holder, source: 'venus', token: e.token, symbol: e.symbol, totalRaw: 0n }, 0n);
        args.log(`[strategy-rewards] portfolio ${a.portfolioId}: claimed ${events.map(e => `${e.amountRaw} ${e.symbol}`).join(', ') || 'nothing'} tx ${tx.hash}`);
      }
    } catch (error) {
      result.failed++;
      args.log(`[strategy-rewards] portfolio ${a.portfolioId}: not finished, next round retries: ${String((error as Error)?.message ?? error).split('\n')[0]!.slice(0, 160)}`);
    }
  }
  return result;
}
/** Known reward tokens plus whatever the multi distributor paid out this round. */
function tokensOf(claims: readonly Claimable[]) {
  const m = new Map(REWARD_TOKENS.map(t => [t.address as string, t]));
  for (const c of claims) if (!m.has(c.token)) m.set(c.token, { symbol: c.symbol, address: c.token });
  return [...m.values()];
}
