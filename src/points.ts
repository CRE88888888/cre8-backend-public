import { randomBytes } from 'node:crypto';
import { createPublicClient, decodeEventLog, http, parseAbi } from 'viem';
import type { Address, Hex, Log, PublicClient, TransactionReceipt } from 'viem';
import type { PoolClient } from 'pg';
import { loadPointsConfig, POINTS_TASKS } from './config.js';
import type { PointsConfig, PointsKind, PointsRule } from './config.js';
import { getPool, query, withTransaction } from './db.js';
import { AppError } from './errors.js';
import { kernelAddressesForChain } from './addresses.js';
import { testnetAssets } from './testnet-profile.js';
import { rpcTransport } from './rpc-transport.js';

type Task = Exclude<PointsKind, 'invite_reward'>;
export type PointsOperation = { owner: string; chainId: number; kind: Task; txHash: Hex; logIndex: number; occurredAt: Date };
type State = 'pending' | 'credited' | 'void';
type EventRow = { id: string; owner: string; chain_id: string; kind: Task; tx_hash: Hex; log_index: number;
  occurred_at: Date; available_at: Date; points: string; state: State; utc_day: string };
type RewardRow = { invitee: string; owner: string; qualifying_event_id: string; occurred_at: Date;
  available_at: Date; points: string; state: State; utc_day: string };
type Bucket = { owner: string; kind: PointsKind; day: string };
const EVENT_COLUMNS = "id::text,owner,chain_id::text,kind,tx_hash,log_index,occurred_at,available_at,points::text,state,to_char(utc_day,'YYYY-MM-DD') as utc_day";
const REWARD_COLUMNS = "invitee,owner,qualifying_event_id::text,occurred_at,available_at,points::text,state,to_char(utc_day,'YYYY-MM-DD') as utc_day";
const storage = () => new AppError(503, 'POINTS_STORAGE_UNAVAILABLE', 'points storage unavailable; retry with the same source');
const rpc = () => new AppError(503, 'POINTS_CHAIN_UNAVAILABLE', 'confirmed points history unavailable');
const invalid = (message: string) => new AppError(400, 'POINTS_INVALID_REQUEST', message);
const conflict = () => new AppError(409, 'POINTS_SOURCE_CONFLICT', 'source identity does not match the stored operation');
const cap = () => new AppError(429, 'POINTS_DAILY_LIMIT', 'task daily limit reached');
const day = (date: Date) => date.toISOString().slice(0, 10);
function ownerOf(input: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(input) || /^0x0{40}$/i.test(input)) throw invalid('invalid owner');
  return input.toLowerCase();
}
function object(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw invalid('expected a JSON object');
  return input as Record<string, unknown>;
}
function exactKeys(input: Record<string, unknown>, names: readonly string[]): void {
  if (Object.keys(input).some((name) => !names.includes(name))) throw invalid('unexpected request field');
}
function countLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return 50;
  if (typeof raw !== 'string' || !/^[1-9]\d{0,2}$/.test(raw) || Number(raw) > 100) throw invalid('limit must be in 1..100');
  return Number(raw);
}
async function transaction<T>(c: Pick<PointsConfig, 'timeoutMs'>, fn: (client: PoolClient) => Promise<T>, run = withTransaction): Promise<T> {
  try {
    return await run(async (client) => {
      await client.query('set transaction isolation level read committed');
      await client.query("select set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)", [String(c.timeoutMs)]);
      return fn(client);
    });
  } catch (error) { throw error instanceof AppError ? error : storage(); }
}
async function read<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (error) { throw error instanceof AppError ? error : storage(); }
}

/** 0029: separate bucket lock statements, sorted before ALL owner row locks. No RPC in transactions. */
async function lock(client: PoolClient, buckets: Bucket[], owners = buckets.map((b) => b.owner)): Promise<void> {
  const ordered = [...new Map(buckets.map((b) => [[b.owner, b.kind, b.day].join(':'), b])).entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [, b] of ordered) {
    await client.query("select pg_advisory_xact_lock(hashtextextended('points_events:'||$1::text||':'||$2::text||':'||to_char($3::date,'YYYY-MM-DD'),0))", [b.owner, b.kind, b.day]);
  }
  for (const owner of [...new Set(owners)].sort()) {
    await client.query('insert into points_owners(owner) values($1) on conflict do nothing', [owner]);
    await client.query('select owner from points_owners where owner=$1 for update', [owner]);
  }
}
async function quota(client: PoolClient, bucket: Bucket, rule: PointsRule): Promise<void> {
  const rewards = bucket.kind === 'invite_reward';
  const result = await client.query<{ n: string; points: string }>(`select count(*)::text as n,coalesce(sum(points),0)::text as points
    from ${rewards ? 'points_invite_rewards' : 'points_events'}
    where owner=$1 and utc_day=$2::date ${rewards ? '' : 'and kind=$3'} and state in ('pending','credited')`,
  rewards ? [bucket.owner, bucket.day] : [bucket.owner, bucket.day, bucket.kind]);
  const used = result.rows[0];
  if (!used) throw storage();
  if (BigInt(used.n) + 1n > rule.dailyCount || BigInt(used.points) + rule.points > rule.dailyPoints) throw cap();
}
function matches(row: EventRow, op: PointsOperation): boolean {
  return row.owner === op.owner && row.chain_id === String(op.chainId) && row.kind === op.kind && row.tx_hash === op.txHash &&
    row.log_index === op.logIndex && row.occurred_at.getTime() === op.occurredAt.getTime();
}

/** Trusted internal writer. HTTP accepts no owner, score, timestamps or claimed event kinds. */
export async function recordPointsOperation(op: PointsOperation, c: PointsConfig, run = withTransaction): Promise<EventRow> {
  const owner = ownerOf(op.owner);
  if (owner !== op.owner || !/^0x[0-9a-f]{64}$/.test(op.txHash) || !Number.isSafeInteger(op.logIndex) || op.logIndex < 0 ||
    !Number.isSafeInteger(op.chainId) || op.chainId <= 0 || !POINTS_TASKS.includes(op.kind) || !Number.isFinite(op.occurredAt.getTime())) throw invalid('invalid verified operation');
  const bucket = { owner, kind: op.kind, day: day(op.occurredAt) };
  return transaction(c, async (client) => {
    await lock(client, [bucket]);
    const existing = await client.query<EventRow>(`select ${EVENT_COLUMNS} from points_events where chain_id=$1 and tx_hash=$2 and log_index=$3`, [op.chainId, op.txHash, op.logIndex]);
    const prior = existing.rows[0];
    if (prior) { if (!matches(prior, op)) throw conflict(); return prior; }
    await quota(client, bucket, c.rules[op.kind]);
    const available = new Date(op.occurredAt.getTime() + c.delaySeconds * 1000);
    const inserted = await client.query<EventRow>(`insert into points_events(owner,chain_id,kind,tx_hash,log_index,points,occurred_at,available_at)
      values($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing returning ${EVENT_COLUMNS}`,
    [owner, op.chainId, op.kind, op.txHash, op.logIndex, c.rules[op.kind].points.toString(), op.occurredAt, available]);
    if (inserted.rows[0]) return inserted.rows[0];
    const raced = await client.query<EventRow>(`select ${EVENT_COLUMNS} from points_events where chain_id=$1 and tx_hash=$2 and log_index=$3`, [op.chainId, op.txHash, op.logIndex]);
    const row = raced.rows[0];
    if (!row || !matches(row, op)) throw conflict();
    return row;
  }, run);
}

export async function inviteCode(wallet: string, c: PointsConfig, generate = () => randomBytes(18).toString('base64url')) {
  const owner = ownerOf(wallet);
  return transaction(c, async (client) => {
    await lock(client, [], [owner]);
    for (let attempt = 0; attempt < 5; attempt++) {
      const existing = await client.query<{ code: string }>('select code from points_invite_codes where owner=$1', [owner]);
      if (existing.rows[0]) return existing.rows[0];
      const code = generate();
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(code)) throw storage();
      const created = await client.query<{ code: string }>('insert into points_invite_codes(code,owner) values($1,$2) on conflict do nothing returning code', [code, owner]);
      if (created.rows[0]) return created.rows[0];
    }
    throw storage();
  });
}

export async function bindInvite(input: unknown, wallet: string, c: PointsConfig) {
  const body = object(input); exactKeys(body, ['code']);
  const code = body.code;
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(code)) throw invalid('invalid invite code');
  const invitee = ownerOf(wallet);
  return transaction(c, async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtextextended('points_invites',0))");
    const ancestors = await client.query<{ owner: string; cycle: boolean }>(`with recursive ancestors(owner,path,cycle) as (
      select owner,array[owner],false from points_invite_codes where code=$1
      union all select i.inviter,a.path||i.inviter,i.inviter=any(a.path) from ancestors a join points_invites i on i.invitee=a.owner where not a.cycle
    ) select owner,cycle from ancestors`, [code]);
    const inviter = ancestors.rows[0]?.owner;
    if (!inviter) throw invalid('invite code not found');
    if (ancestors.rows.some((a) => a.owner === invitee || a.cycle)) throw new AppError(409, 'INVITE_CYCLE', 'self invites and invitation cycles are forbidden');
    // C3 #67: no portfolio or valid enroll record. An intent can outlive a failed attempt.
    // SHARE serializes this eligibility check with unmodified portfolio INSERT writers.
    await client.query('lock table portfolios in share mode');
    await lock(client, [], [invitee, inviter]);
    const used = await client.query<{ ineligible: boolean }>(`select exists(select 1 from portfolios where lower(user_id)=$1)
      or exists(select 1 from points_events where owner=$1 and kind='enroll' and state<>'void')
      or exists(select 1 from points_invites where invitee=$1) as ineligible`, [invitee]);
    if (used.rows[0]?.ineligible !== false) throw new AppError(409, 'INVITE_INELIGIBLE', 'owner already enrolled or bound to an inviter');
    const result = await client.query<{ inviter: string; bound_at: Date }>(`insert into points_invites(invitee,inviter,code)
      values($1,$2,$3) returning inviter,bound_at`, [invitee, inviter, code]);
    if (!result.rows[0]) throw storage();
    return result.rows[0];
  });
}

export async function freezePoints(input: unknown, operator: string, c: PointsConfig) {
  const body = object(input); exactKeys(body, ['owner', 'frozen', 'reason']);
  if (typeof body.owner !== 'string' || typeof body.frozen !== 'boolean') throw invalid('expected owner and frozen boolean');
  const owner = ownerOf(body.owner); const by = ownerOf(operator);
  if (body.frozen && (typeof body.reason !== 'string' || body.reason.trim().length === 0 || body.reason.length > 500)) throw invalid('freeze reason must contain 1..500 characters');
  return transaction(c, async (client) => {
    await lock(client, [], [owner]);
    const result = await client.query(`update points_owners set frozen_at=case when $2 then clock_timestamp() else null end,
      freeze_reason=case when $2 then $3 else null end,frozen_by=case when $2 then $4 else null end,updated_at=clock_timestamp()
      where owner=$1 returning owner,total_points::text,frozen_at,freeze_reason,frozen_by`, [owner, body.frozen, body.frozen ? String(body.reason).trim() : null, by]);
    if (!result.rows[0]) throw storage(); return result.rows[0];
  });
}

/** Credit or proven invalidation. Missing receipts/errors NEVER enter the void branch. */
export async function settlePointsEvent(id: string, c: PointsConfig, provenInvalid = false, run = withTransaction): Promise<void> {
  await transaction(c, async (client) => {
    const source = (await client.query<EventRow>(`select ${EVENT_COLUMNS} from points_events where id=$1`, [id])).rows[0];
    if (!source) throw storage();
    // Binding is immutable. Lock its reward bucket even before a reward is inserted by another sync.
    const binding = (await client.query<{ inviter: string }>('select inviter from points_invites where invitee=$1', [source.owner])).rows[0];
    const buckets: Bucket[] = [{ owner: source.owner, kind: source.kind, day: source.utc_day }];
    if (binding) buckets.push({ owner: binding.inviter, kind: 'invite_reward', day: source.utc_day });
    await lock(client, buckets);
    const current = (await client.query<EventRow>(`select ${EVENT_COLUMNS} from points_events where id=$1`, [id])).rows[0];
    if (!current || current.state === 'void') return;
    if (provenInvalid) {
      await client.query("update points_invite_rewards set state='void',void_reason='qualifying source invalid',updated_at=clock_timestamp() where qualifying_event_id=$1 and state<>'void'", [id]);
      await client.query("update points_events set state='void',void_reason='canonical receipt disproves operation',updated_at=clock_timestamp() where id=$1 and state<>'void'", [id]);
    } else {
      await client.query(`update points_events set state='credited',updated_at=clock_timestamp() where id=$1 and state='pending'
        and available_at<=clock_timestamp() and exists(select 1 from points_owners where owner=$2 and frozen_at is null)`, [id, source.owner]);
    }
  }, run);
}

/** Called only after a COMPLETE, chronological campaign scan, never for a client-submitted event. */
export async function rewardInvite(invitee: string, c: PointsConfig, canonicalFirst?: PointsOperation): Promise<void> {
  const binding = await read(async () => (await query<{ inviter: string; bound_at: string }>('select inviter,bound_at::text from points_invites where invitee=$1', [invitee])).rows[0]);
  if (!binding) return;
  // Preserve DB microseconds at bound_at. Complete scans supply the actual first chain source,
  // so a capped/disabled earlier operation cannot be silently replaced by a later award.
  const firstSql = `select ${EVENT_COLUMNS} from points_events where owner=$1 and state<>'void' and occurred_at>=$2::timestamptz
    and ($3::text is null or (tx_hash=$3 and log_index=$4 and chain_id=$5)) order by occurred_at,id limit 1`;
  const firstParams = [invitee, binding.bound_at, canonicalFirst?.txHash ?? null, canonicalFirst?.logIndex ?? null, canonicalFirst?.chainId ?? null];
  const first = await read(async () => (await query<EventRow>(firstSql, firstParams)).rows[0]);
  if (!first) {
    if (canonicalFirst) {
      await transaction(c, async (client) => {
        const prior = (await client.query<RewardRow>(`select ${REWARD_COLUMNS} from points_invite_rewards where invitee=$1`, [invitee])).rows[0];
        if (!prior) return;
        await lock(client, [{ owner: prior.owner, kind: 'invite_reward', day: prior.utc_day }], [prior.owner, invitee]);
        await client.query("update points_invite_rewards set state='void',void_reason='first qualifying operation has no eligible award',updated_at=clock_timestamp() where invitee=$1 and state<>'void'", [invitee]);
      });
    }
    return;
  }
  await transaction(c, async (client) => {
    const bucket: Bucket = { owner: binding.inviter, kind: 'invite_reward', day: first.utc_day };
    const prior = (await client.query<RewardRow>(`select ${REWARD_COLUMNS} from points_invite_rewards where invitee=$1`, [invitee])).rows[0];
    const buckets: Bucket[] = [bucket, { owner: first.owner, kind: first.kind, day: first.utc_day }];
    if (prior) buckets.push({ owner: prior.owner, kind: 'invite_reward', day: prior.utc_day });
    await lock(client, buckets, [binding.inviter, invitee]);
    const actual = (await client.query<EventRow>(firstSql, firstParams)).rows[0];
    if (!actual || actual.id !== first.id) return;
    let reward = (await client.query<RewardRow>(`select ${REWARD_COLUMNS} from points_invite_rewards where invitee=$1`, [invitee])).rows[0];
    // Source changes on backfill must never leave a later operation's reward credited.
    if (reward && reward.qualifying_event_id !== first.id) {
      if (!prior || prior.qualifying_event_id !== reward.qualifying_event_id) throw storage();
      await client.query("update points_invite_rewards set state='void',void_reason='earlier qualifying operation found',updated_at=clock_timestamp() where invitee=$1 and state<>'void'", [invitee]);
      return;
    }
    const frozen = await client.query("select owner from points_owners where owner=any($1::text[]) and frozen_at is not null", [[binding.inviter, invitee]]);
    if (frozen.rows.length > 0) return;
    if (!reward) {
      await quota(client, bucket, c.rules.invite_reward);
      const available = new Date(Math.max(first.available_at.getTime(), first.occurred_at.getTime() + c.delaySeconds * 1000));
      reward = (await client.query<RewardRow>(`insert into points_invite_rewards(invitee,owner,qualifying_event_id,points,occurred_at,available_at)
        values($1,$2,$3,$4,$5,$6) returning ${REWARD_COLUMNS}`, [invitee, binding.inviter, first.id, c.rules.invite_reward.points.toString(), first.occurred_at, available])).rows[0];
    }
    if (!reward) throw storage();
    // Source must already be credited; freezing either participant holds the pending reward.
    await client.query(`update points_invite_rewards set state='credited',updated_at=clock_timestamp() where invitee=$1 and state='pending'
      and available_at<=clock_timestamp() and exists(select 1 from points_events where id=qualifying_event_id and state='credited')`, [invitee]);
  });
}

export async function pointsBalance(wallet: string) {
  const owner = ownerOf(wallet);
  return read(async () => {
    // Balance and reservations must share one snapshot while settlement moves points between them.
    const row = (await query<{ total_points: string; pending: string; frozen: boolean }>(`select
      coalesce((select total_points from points_owners where owner=$1),0)::text as total_points,
      exists(select 1 from points_owners where owner=$1 and frozen_at is not null) as frozen,
      (select coalesce(sum(points),0)::text from (
        select points from points_events where owner=$1 and state='pending' union all
        select points from points_invite_rewards where owner=$1 and state='pending') ledger) as pending`, [owner])).rows[0];
    if (!row) throw storage();
    return { owner, totalPoints: row.total_points, pendingPoints: row.pending, frozen: row.frozen };
  });
}
export async function pointsHistory(wallet: string, params: Record<string, unknown>) {
  exactKeys(params, ['limit', 'before']); const owner = ownerOf(wallet); const limit = countLimit(params.limit);
  let before: { at: string; key: string } | null = null;
  if (params.before !== undefined) {
    if (typeof params.before !== 'string' || params.before.length > 256) throw invalid('invalid history cursor');
    try {
      const value: unknown = JSON.parse(Buffer.from(params.before, 'base64url').toString());
      const cursor = object(value);
      if (typeof cursor.at !== 'string' || !Number.isFinite(Date.parse(cursor.at)) || typeof cursor.key !== 'string' || !/^[er]:[0-9a-z]+$/.test(cursor.key)) throw invalid('invalid history cursor');
      before = { at: cursor.at, key: cursor.key };
    } catch { throw invalid('invalid history cursor'); }
  }
  return read(async () => {
    const result = await query<{ key: string; kind: string; points: string; state: State; occurred_at: Date; available_at: Date; credited_at: Date | null; void_reason: string | null }>(`with ledger as (
      select 'e:'||id::text as key,kind,points::text,state,occurred_at,available_at,credited_at,void_reason from points_events where owner=$1
      union all select 'r:'||invitee,'invite_reward',points::text,state,occurred_at,available_at,credited_at,void_reason from points_invite_rewards where owner=$1)
      select * from ledger where $2::timestamptz is null or (occurred_at,key)<($2::timestamptz,$3::text)
      order by occurred_at desc,key desc limit $4`, [owner, before?.at ?? null, before?.key ?? null, limit + 1]);
    const items = result.rows.slice(0, limit); const last = items.at(-1);
    return { items, next: result.rows.length > limit && last ? Buffer.from(JSON.stringify({ at: last.occurred_at.toISOString(), key: last.key })).toString('base64url') : null };
  });
}
export async function pointsLeaderboard(params: Record<string, unknown>) {
  exactKeys(params, ['limit', 'score', 'owner']); const limit = countLimit(params.limit);
  if ((params.score === undefined) !== (params.owner === undefined)) throw invalid('score and owner cursor are required together');
  const score = params.score ?? null;
  if (score !== null && (typeof score !== 'string' || !/^\d{1,100}$/.test(score))) throw invalid('invalid score cursor');
  const owner = params.owner === undefined ? null : typeof params.owner === 'string' ? ownerOf(params.owner) : (() => { throw invalid('invalid owner cursor'); })();
  return read(async () => {
    const result = await query<{ owner: string; total_points: string }>(`select owner,total_points::text from points_leaderboard
      where $1::numeric is null or total_points<$1::numeric or (total_points=$1::numeric and owner>$2)
      order by points_leaderboard.total_points desc,owner asc limit $3`, [score, owner, limit + 1]);
    const items = result.rows.slice(0, limit); const last = items.at(-1);
    return { items, next: result.rows.length > limit && last ? { score: last.total_points, owner: last.owner } : null };
  });
}
export async function inviteStats(wallet: string, c: PointsConfig) {
  const owner = ownerOf(wallet); const code = await inviteCode(owner, c);
  return read(async () => {
    const result = await query<{ invited: string; qualified: string; credited: string }>(`select count(*)::text as invited,
      count(r.invitee) filter(where r.state<>'void')::text as qualified,count(r.invitee) filter(where r.state='credited')::text as credited
      from points_invites i left join points_invite_rewards r on r.invitee=i.invitee where i.inviter=$1`, [owner]);
    const binding = (await query<{ inviter: string; bound_at: Date }>('select inviter,bound_at from points_invites where invitee=$1', [owner])).rows[0];
    return { ...code, ...result.rows[0], binding: binding ?? null };
  });
}

export const POINTS_ABI = parseAbi([
  'event Enrolled(address indexed account,uint256 id,uint16 version)',
  'event StrategyRegistered(uint256 indexed id,address indexed provider,string name)',
  'event SwapExecuted(address indexed account,address tokenIn,address tokenOut,uint256 amountIn,uint256 gross,uint256 fee,uint256 net,uint256 oracleFloor)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
const OWNER_ABI = parseAbi(['function rootValidator() view returns(bytes21)', 'function ecdsaValidatorStorage(address) view returns(address)']);
export type PointsCatalog = {
  accounts: Map<string, { owner: string; strategy: string }>;
  strategies: Map<string, { owner: string; name: string; personalMix?: boolean }>;
  tokens: Set<string>;
};
export type PointsReader = {
  chainId: () => Promise<number>; head: () => Promise<bigint>;
  block: (number: bigint) => Promise<{ hash: Hex | null; timestamp: bigint }>;
  logs: (from: bigint, to: bigint, addresses: Address[]) => Promise<Log[]>;
  receipt: (hash: Hex) => Promise<TransactionReceipt | null>;
  owner: (account: Address, block: bigint) => Promise<{ root: string; owner: string }>;
};
function chainReader(c: PointsConfig): PointsReader {
  const client: PublicClient = createPublicClient({ transport: rpcTransport('points', c.rpcUrl, { retryCount: 0, timeout: c.timeoutMs }) });
  const validator = kernelAddressesForChain(c.chainId).ecdsaValidatorV31;
  return {
    chainId: () => client.getChainId(), head: () => client.getBlockNumber({ cacheTime: 0 }),
    block: (number) => client.getBlock({ blockNumber: number }),
    logs: (fromBlock, toBlock, address) => client.getLogs({ fromBlock, toBlock, address }),
    receipt: (hash) => client.getTransactionReceipt({ hash }),
    owner: async (account, blockNumber) => {
      const [root, owner] = await Promise.all([
        client.readContract({ address: account, abi: OWNER_ABI, functionName: 'rootValidator', blockNumber }),
        client.readContract({ address: validator, abi: OWNER_ABI, functionName: 'ecdsaValidatorStorage', args: [account], blockNumber }),
      ]);
      return { root, owner };
    },
  };
}
export async function loadPointsCatalog(c: PointsConfig, find = query): Promise<PointsCatalog> {
  return read(async () => {
    const accounts = await find<{ address: string; owner: string; user_id: string; onchain_id: string }>(`select a.address,a.owner,p.user_id,s.onchain_id::text
      from smart_accounts a join portfolios p on p.id=a.portfolio_id join strategies s on s.id=p.strategy_id
      where a.chain_id=$1 and a.account_type='KERNEL' and a.retired_at is null`, [c.chainId]);
    const strategies = await find<{ onchain_id: string; provider: string; name: string; is_personal_mix: boolean }>('select onchain_id::text,provider,name,is_personal_mix from strategies where onchain_id is not null');
    const tokens = c.chainId === 97 ? testnetAssets().map((a) => a.address) : (await find<{ address: string }>('select address from priceable_assets')).rows.map((a) => a.address);
    return { accounts: new Map(accounts.rows.filter((a) => a.owner.toLowerCase() === a.user_id.toLowerCase()).map((a) => [a.address, { owner: ownerOf(a.owner), strategy: a.onchain_id }])),
      strategies: new Map(strategies.rows.map((s) => [s.onchain_id, { owner: ownerOf(s.provider), name: s.name, personalMix: s.is_personal_mix }])), tokens: new Set([...tokens, c.token]) };
  });
}

/** One canonical log per (receipt, owner, task). Multi-leg swaps/sweeps cannot multiply awards. */
type ReceiptEvidence = Pick<TransactionReceipt, 'status' | 'transactionHash' | 'blockHash' | 'blockNumber'> & { logs: Log[] };
export function receiptOperations(receipt: ReceiptEvidence, c: PointsConfig, known: PointsCatalog): Array<{ owner: string; kind: Task; logIndex: number; account: Address | null }> {
  if (receipt.status !== 'success') return [];
  const operations = new Map<string, { owner: string; kind: Task; logIndex: number; account: Address | null }>();
  for (const log of [...receipt.logs].sort((a, b) => (a.logIndex ?? -1) - (b.logIndex ?? -1))) {
    const address = log.address.toLowerCase();
    if (log.logIndex === null || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0 || log.removed || log.transactionHash !== receipt.transactionHash ||
      log.blockHash !== receipt.blockHash || log.blockNumber !== receipt.blockNumber) throw rpc();
    let event;
    try { event = decodeEventLog({ abi: POINTS_ABI, data: log.data, topics: log.topics }); } catch { continue; }
    let kind: Task; let owner: string; let account: Address | null = null;
    if (address === c.registry && event.eventName === 'StrategyRegistered') {
      const strategy = known.strategies.get(String(event.args.id));
      if (!strategy || strategy.personalMix || strategy.name !== event.args.name) continue;
      kind = 'create_fund'; owner = strategy.owner;
    } else if (address === c.registry && event.eventName === 'Enrolled') {
      account = event.args.account.toLowerCase() as Address;
      const enrolled = known.accounts.get(account);
      if (!enrolled || enrolled.strategy !== String(event.args.id) || event.args.version < 1) continue;
      kind = 'enroll'; owner = enrolled.owner;
    } else if (address === c.executor && event.eventName === 'SwapExecuted') {
      account = event.args.account.toLowerCase() as Address;
      const enrolled = known.accounts.get(account);
      if (!enrolled || event.args.amountIn === 0n || event.args.net === 0n || !known.tokens.has(event.args.tokenIn.toLowerCase()) || !known.tokens.has(event.args.tokenOut.toLowerCase())) continue;
      kind = 'rebalance'; owner = enrolled.owner;
    } else if (known.tokens.has(address) && event.eventName === 'Transfer' && event.args.value > 0n) {
      const from = event.args.from.toLowerCase(); const to = event.args.to.toLowerCase();
      const deposit = known.accounts.get(to); const withdraw = known.accounts.get(from);
      if (deposit?.owner === from) { owner = deposit.owner; kind = 'deposit'; account = to as Address; }
      else if (withdraw?.owner === to) { owner = withdraw.owner; kind = 'withdraw'; account = from as Address; }
      else continue; // Includes faucet mint, fee transfers, pool swaps and transfers between smart accounts.
    } else continue;
    const key = owner + ':' + kind;
    if (!operations.has(key)) operations.set(key, { owner, kind, logIndex: log.logIndex, account });
  }
  return [...operations.values()];
}

async function boundedRpc<T>(work: () => Promise<T>, c: PointsConfig): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(rpc()), c.timeoutMs); })]);
  } catch { throw rpc(); } finally { clearTimeout(timer); }
}
async function verifyReceipt(hash: Hex, safeHead: bigint, c: PointsConfig, known: PointsCatalog, reader: PointsReader, stored?: EventRow, expectedBlock?: bigint): Promise<PointsOperation[] | null> {
  const receipt = await boundedRpc(() => reader.receipt(hash), c);
  if (!receipt || receipt.blockNumber > safeHead) return null;
  if (receipt.transactionHash.toLowerCase() !== hash || receipt.blockNumber < 0n || !['success', 'reverted'].includes(receipt.status)) throw rpc();
  if (expectedBlock !== undefined && receipt.blockNumber !== expectedBlock) throw rpc();
  const block = await boundedRpc(() => reader.block(receipt.blockNumber), c);
  if (!block.hash || block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) return null;
  if (stored && receipt.status === 'success') {
    const source = receipt.logs.find((log) => log.logIndex === stored.log_index);
    if (source) {
      try {
        const event = decodeEventLog({ abi: POINTS_ABI, data: source.data, topics: source.topics });
        // Lost catalog data cannot be used as chain evidence to revoke an award.
        if (event.eventName === 'StrategyRegistered') {
          const strategy = known.strategies.get(String(event.args.id));
          if (source.address.toLowerCase() !== c.registry || !strategy || strategy.owner !== stored.owner || strategy.name !== event.args.name) return null;
        }
        if (event.eventName === 'Enrolled' || event.eventName === 'SwapExecuted') {
          const account = known.accounts.get(event.args.account.toLowerCase());
          if (!account || account.owner !== stored.owner) return null;
          if (event.eventName === 'Enrolled' && (source.address.toLowerCase() !== c.registry || account.strategy !== String(event.args.id))) return null;
          if (event.eventName === 'SwapExecuted' && (source.address.toLowerCase() !== c.executor ||
            !known.tokens.has(event.args.tokenIn.toLowerCase()) || !known.tokens.has(event.args.tokenOut.toLowerCase()))) return null;
        }
        if (event.eventName === 'Transfer') {
          const account = known.accounts.get((stored.kind === 'deposit' ? event.args.to : event.args.from).toLowerCase());
          if (!account || account.owner !== stored.owner || !known.tokens.has(source.address.toLowerCase())) return null;
        }
      } catch { return null; }
    }
  }
  const occurredAt = new Date(Number(block.timestamp) * 1000);
  if (!Number.isSafeInteger(Number(block.timestamp)) || !Number.isFinite(occurredAt.getTime())) throw rpc();
  const result: PointsOperation[] = [];
  const verifiedOwners = new Map<string, boolean>();
  for (const op of receiptOperations(receipt, c, known)) {
    if (op.account) {
      let verified = verifiedOwners.get(op.account);
      if (verified === undefined) {
        const actual = await boundedRpc(() => reader.owner(op.account as Address, receipt.blockNumber), c);
        const validator = kernelAddressesForChain(c.chainId).ecdsaValidatorV31.toLowerCase();
        verified = actual.root.toLowerCase() === '0x01' + validator.slice(2) && actual.owner.toLowerCase() === op.owner;
        verifiedOwners.set(op.account, verified);
      }
      if (!verified) continue;
    }
    result.push({ owner: op.owner, chainId: c.chainId, kind: op.kind, txHash: hash, logIndex: op.logIndex, occurredAt });
  }
  return result;
}

/** Rescan the full configured campaign in bounded RPC ranges. No durable cursor is inferred from awards:
 * quota-rejected operations still belong in metrics, and omitted older operations cannot qualify referrals.
 * Call POST /operator/points/sync periodically; no scheduler/rebalance hooks or chain writes are needed.
 */
export async function scanPoints(c: PointsConfig, known: PointsCatalog, reader: PointsReader) {
  if (await boundedRpc(reader.chainId, c) !== c.chainId) throw rpc();
  const head = await boundedRpc(reader.head, c);
  const to = head - c.confirmations + 1n;
  if (to < c.fromBlock) return { operations: [], to, timestamp: null };
  const anchor = await boundedRpc(() => reader.block(to), c);
  if (!anchor.hash) throw rpc();
  const hashes = new Map<Hex, bigint>();
  const addresses: Address[] = [...new Set([c.registry, c.executor, ...known.tokens])].map((a) => a as Address);
  for (let from = c.fromBlock; from <= to; from += 1000n) {
    const end = from + 999n > to ? to : from + 999n;
    const logs = await boundedRpc(() => reader.logs(from, end, addresses), c);
    for (const log of logs) {
      if (!log.transactionHash || log.blockNumber === null || log.blockNumber < from || log.blockNumber > end || log.removed) throw rpc();
      // RPC returns all token transfers. Skip unrelated pools before fetching expensive receipts.
      if (!log.blockHash) throw rpc();
      const candidate: ReceiptEvidence = { blockHash: log.blockHash, blockNumber: log.blockNumber, transactionHash: log.transactionHash, status: 'success', logs: [log] };
      if (receiptOperations(candidate, c, known).length > 0) hashes.set(log.transactionHash.toLowerCase() as Hex, log.blockNumber);
    }
  }
  const operations: Array<PointsOperation & { block: bigint }> = [];
  for (const [hash, block] of [...hashes.entries()].sort((a, b) => a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0].localeCompare(b[0]))) {
    const verified = await verifyReceipt(hash, to, c, known, reader, undefined, block);
    if (verified === null) throw rpc();
    operations.push(...verified.map((op) => ({ ...op, block })));
  }
  if ((await boundedRpc(() => reader.block(to), c)).hash !== anchor.hash) throw rpc();
  operations.sort((a, b) => a.block < b.block ? -1 : a.block > b.block ? 1 : a.logIndex - b.logIndex);
  return { operations, to, timestamp: new Date(Number(anchor.timestamp) * 1000) };
}

/** Metrics use verified chain operations BEFORE daily scoring caps. Retention is exact UTC-day return,
 * with only mature cohorts in the denominator; faucet/failed ops and referral awards never count.
 */
export function pointsMetrics(operations: PointsOperation[], asOf: Date) {
  const owners = new Map<string, Set<number>>();
  const kinds: Record<Task, number> = { enroll: 0, deposit: 0, rebalance: 0, create_fund: 0, withdraw: 0 };
  const unique = new Map(operations.map((op) => [[op.chainId, op.txHash, op.logIndex].join(':'), op]));
  for (const op of unique.values()) {
    kinds[op.kind]++;
    const days = owners.get(op.owner) ?? new Set<number>();
    days.add(Math.floor(op.occurredAt.getTime() / 86_400_000)); owners.set(op.owner, days);
  }
  const today = Math.floor(asOf.getTime() / 86_400_000);
  const retention = (offset: number) => {
    let eligible = 0; let returned = 0;
    for (const days of owners.values()) {
      const first = Math.min(...days);
      if (first + offset <= today) { eligible++; if (days.has(first + offset)) returned++; }
    }
    return { eligible, returned, rate: eligible === 0 ? null : returned / eligible };
  };
  return { asOf: asOf.toISOString(), successfulOperations: unique.size, uniqueOwners: owners.size, kinds, d1: retention(1), d7: retention(7) };
}

export type PointsDeps = { config?: PointsConfig | null; reader?: PointsReader; catalog?: () => Promise<PointsCatalog> };
export function createPointsService(deps: PointsDeps = {}) {
  const configured = () => {
    const c = deps.config === undefined ? loadPointsConfig() : deps.config;
    if (!c) throw new AppError(503, 'POINTS_DISABLED', 'points campaign is disabled');
    return c;
  };
  return {
    balance: (wallet: string) => { configured(); return pointsBalance(wallet); },
    history: (wallet: string, params: Record<string, unknown>) => { configured(); return pointsHistory(wallet, params); },
    leaderboard: (params: Record<string, unknown>) => { configured(); return pointsLeaderboard(params); },
    invites: (wallet: string) => inviteStats(wallet, configured()),
    bind: (input: unknown, wallet: string) => bindInvite(input, wallet, configured()),
    freeze: (input: unknown, operator: string) => freezePoints(input, operator, configured()),
    tasks: () => { const c = configured(); return { delaySeconds: c.delaySeconds, confirmations: c.confirmations.toString(),
      tasks: POINTS_TASKS.map((kind) => ({ kind, points: c.rules[kind].points.toString(), dailyCount: c.rules[kind].dailyCount.toString(), dailyPoints: c.rules[kind].dailyPoints.toString() })) }; },
    metrics: async () => {
      const c = configured(); const known = await (deps.catalog ?? (() => loadPointsCatalog(c)))();
      const scan = await scanPoints(c, known, deps.reader ?? chainReader(c));
      if (!scan.timestamp) throw rpc();
      return { ...pointsMetrics(scan.operations, scan.timestamp), throughBlock: scan.to.toString() };
    },
    sync: async () => {
      const c = configured();
      // Session-level exclusion may span RPC. The ledger transactions themselves remain short.
      const client = await getPool().connect().catch(() => { throw storage(); });
      let held = false; let reusable = false;
      let connected = true;
      const disconnected = () => { connected = false; };
      const requireLock = () => { if (!connected || !held) throw storage(); };
      client.on('error', disconnected);
      try {
        held = (await client.query<{ held: boolean }>("select pg_try_advisory_lock(hashtextextended('points_sync:'||$1::text,0)) as held", [c.chainId])).rows[0]?.held === true;
        if (!held) throw new AppError(409, 'POINTS_SYNC_BUSY', 'points sync already running');
        const known = await (deps.catalog ?? (() => loadPointsCatalog(c)))(); const reader = deps.reader ?? chainReader(c);
        const scan = await scanPoints(c, known, reader);
        requireLock();
        if (!scan.timestamp) return { throughBlock: scan.to.toString(), operations: 0, capped: 0 };
        const stored = await read(async () => (await query<EventRow>(`select ${EVENT_COLUMNS} from points_events where chain_id=$1 and state<>'void' order by id`, [c.chainId])).rows);
        const valid = new Map(scan.operations.map((op) => [op.txHash + ':' + op.logIndex, op]));
        const reconciled: Array<{ row: EventRow; invalid: boolean }> = [];
        for (const row of stored) {
          const op = valid.get(row.tx_hash + ':' + row.log_index);
          if (op && matches(row, op)) { reconciled.push({ row, invalid: false }); continue; }
          const proof = await verifyReceipt(row.tx_hash, scan.to, c, known, reader, row);
          // Receipt absence, an orphan block or insufficient confirmations is unknown, never void.
          if (proof === null) throw rpc();
          reconciled.push({ row, invalid: !proof.some((p) => matches(row, p)) });
        }
        for (const result of reconciled) { requireLock(); await settlePointsEvent(result.row.id, c, result.invalid); }
        let capped = 0;
        for (const op of scan.operations) {
          requireLock();
          try { const row = await recordPointsOperation(op, c); if (row.state === 'pending') await settlePointsEvent(row.id, c); }
          catch (error) { if (error instanceof AppError && error.code === 'POINTS_DAILY_LIMIT') capped++; else throw error; }
        }
        const invites = await read(async () => (await query<{ invitee: string; bound_ms: string }>("select invitee,ceil(extract(epoch from bound_at)*1000)::text as bound_ms from points_invites order by invitee")).rows);
        for (const { invitee, bound_ms } of invites) {
          requireLock();
          const first = scan.operations.find((op) => op.owner === invitee && op.occurredAt.getTime() >= Number(bound_ms));
          if (!first) continue;
          try { await rewardInvite(invitee, c, first); }
          catch (error) { if (!(error instanceof AppError && error.code === 'POINTS_DAILY_LIMIT')) throw error; }
        }
        requireLock();
        return { throughBlock: scan.to.toString(), operations: scan.operations.length, capped };
      } catch (error) { throw error instanceof AppError ? error : storage(); }
      finally {
        if (held) {
          try { reusable = (await client.query<{ unlocked: boolean }>("select pg_advisory_unlock(hashtextextended('points_sync:'||$1::text,0)) as unlocked", [c.chainId])).rows[0]?.unlocked === true; }
          catch { reusable = false; }
        }
        client.release(!reusable || !connected);
        client.removeListener('error', disconnected);
      }
    },
  };
}
