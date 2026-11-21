import { AsyncLocalStorage } from 'node:async_hooks';
import { withConnection } from './db.js';
import { AppError } from './errors.js';
import type { Address, PublicClient } from 'viem';
import { recordAlerts } from './alerts.js';

export const PUBLICATION_NONCE_GUARD_MS = 10 * 60_000;
export const PUBLICATION_ALERT_RETRY_MS = 60_000;
let publicationAlertFailedAt: number | null = null;

async function recordExpiredPublicationAlerts(client: import('pg').PoolClient, now: Date): Promise<void> {
  const at = now.getTime();
  if (publicationAlertFailedAt !== null && at >= publicationAlertFailedAt && at - publicationAlertFailedAt < PUBLICATION_ALERT_RETRY_MS) return;
  try {
    const expired = await client.query<{ strategy_id: string }>(`select j.strategy_id from mix_publication_jobs j
      where j.chain_id=97 and j.state<>'confirmed' and j.alerted_at is null and exists
        (select 1 from mix_publication_outbox o where o.strategy_id=j.strategy_id and o.created_at<=$1::timestamptz-interval '${PUBLICATION_NONCE_GUARD_MS} milliseconds')`, [now]);
    if (expired.rows.length) {
      await recordAlerts((sql, params) => client.query(sql, params ? [...params] : []), [{ kind: 'portfolio_stuck', severity: 'critical', portfolioId: null,
        detail: '私人組合發布 nonce 等待已達十分鐘；停止以該原簽阻擋共用 relayer，請營運對帳及補洞。原簽與證據保留。' }], now);
      await client.query('update mix_publication_jobs set alerted_at=coalesce(alerted_at,$2) where strategy_id=any($1::bigint[])', [expired.rows.map(row => row.strategy_id), now]);
    }
    publicationAlertFailedAt = null;
  } catch {
    publicationAlertFailedAt = at;
    console.warn('[relayer] publication nonce 告警儲存失敗，保留待重試；不影響 nonce admission。');
  }
}

const relayerScope = new AsyncLocalStorage<{ floors: Map<string, bigint>; assertHeld: () => void }>();

/** All EOA entry points must honor durable publication nonces, including original
 * transactions not yet visible in the node mempool. Resolved history is never reused. */
export async function relayerNonce(client: PublicClient, signer: Address, chainId = 97): Promise<{ nonce?: number }> {
  const scope = relayerScope.getStore();
  if (chainId !== 97 || !scope) return {};
  const floor = scope.floors.get(signer.toLowerCase());
  if (floor === undefined) return {};
  scope.assertHeld();
  const deadlineAt = Date.now() + 5000;
  const read = async (blockTag: 'pending' | 'latest') => {
    const ms = deadlineAt - Date.now();
    if (ms < 1) throw new Error('nonce unavailable');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([client.getTransactionCount({ address: signer, blockTag }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('nonce unavailable')), ms); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    let pending: number;
    try { pending = await read('pending'); } catch { pending = await read('pending'); }
    const latest = await read('latest');
    if (!Number.isSafeInteger(latest) || latest < 0 || !Number.isSafeInteger(pending) || pending < 0) throw new Error('invalid relayer nonce');
    pending = Math.max(pending, latest);
    if (!Number.isSafeInteger(pending) || pending < 0) throw new Error('invalid relayer nonce');
    if (BigInt(pending) <= floor) {
      // Queued transactions above a gap are absent from some pending-nonce replies.
      // Fill the original publication gap before admitting a fresh transaction.
      const replayed = await (await import('./mix-publication.js')).replayPublicationNonceGap(client, signer, BigInt(pending), scope.assertHeld, deadlineAt);
      pending = await read('pending');
      if (!Number.isSafeInteger(pending) || pending < 0) throw new Error('invalid relayer nonce');
      // Some nodes omit queued originals from pending. A contiguous range of
      // validated, acknowledged originals supplies our own floor under this lock.
      if (BigInt(pending) <= floor) {
        if (replayed === null || replayed < floor || floor >= BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('relayer nonce gap remains occupied');
        pending = Number(floor + 1n);
      }
    }
    scope.assertHeld();
    return { nonce: pending };
  } catch { throw new AppError(503, 'RELAYER_BUSY', 'relayer nonce unavailable; retry later'); }
}

/** Chain 97 faucet and enrollment share an EOA. Serialize nonce acquisition through broadcast
 * across API processes; reject busy work before reserving quota. Never wait holding pool clients.
 * This is a session lock, not a transaction: quota transactions contain no RPC.
 */
export async function withRelayerLock<T>(chainId: number, action: (assertHeld: () => void) => Promise<T>, options: { reconcile?: boolean; now?: Date } = {}): Promise<T> {
  if (chainId !== 97) return action(() => {});
  const unavailable = () => new AppError(503, 'RELAYER_BUSY', 'testnet relayer unavailable; retry later');
  if (relayerScope.getStore()) throw unavailable();
  let entered = false;
  return withConnection(async (client, discard) => {
    let acquired = false;
    let healthy = true;
    const disconnected = () => { discard(); healthy = false; };
    const assertHeld = () => { if (!healthy) throw unavailable(); };
    client.on('error', disconnected);
    try {
      acquired = (await client.query<{ locked: boolean }>("select pg_try_advisory_lock(hashtextextended('backend:relayer:97',0)) as locked")
        .catch(() => { discard(); throw unavailable(); })).rows[0]?.locked === true;
      if (!acquired) throw unavailable();
      assertHeld();
      // A timed-out eth_sendRawTransaction may still be accepted later. Never acquire
      // another nonce for these legacy sources until their durable hash is reconciled.
      // Publications instead reserve explicit nonces below, independently of job status.
      const unresolved = await client.query(`select id from faucet_claims where chain_id=97 and state in ('submitted','unknown') and tx_hash is not null
          and not exists(select 1 from relayer_outbox_nonce_consumptions c where c.tx_hash=faucet_claims.tx_hash)
        union all select id from welcome_grants where chain_id=97 and state in ('submitted','unknown') and tx_hash is not null
          and not exists(select 1 from relayer_outbox_nonce_consumptions c where c.tx_hash=welcome_grants.tx_hash)
        union all select id from mix_creation_requests where chain_id=97 and registration_tx_hash is not null
          and state='submitted' and not exists(select 1 from relayer_outbox_nonce_consumptions c where c.tx_hash=registration_tx_hash) limit 1`)
        .catch(() => { throw unavailable(); });
      if (unresolved.rows.length > 0 && !options.reconcile) throw unavailable();
      assertHeld();
      const now = options.now ?? new Date();
      await recordExpiredPublicationAlerts(client, now);
      const publications = await client.query<{ signer: string; nonce: string }>(`select signer,max(nonce)::text as nonce from (
        select o.signer,o.nonce
        from mix_publication_outbox o left join mix_publication_nonce_consumptions c using(strategy_id,attempt)
        where o.chain_id=97 and c.strategy_id is null and o.created_at>$1::timestamptz-interval '${PUBLICATION_NONCE_GUARD_MS} milliseconds'
        union all select n.signer,n.nonce from relayer_outbox_nonce_consumptions c
          join relayer_outbox_nonce_identities n using(tx_hash) where n.chain_id=97
        ) occupied group by signer`, [now]).catch(() => { throw unavailable(); });
      const floors = new Map<string, bigint>();
      for (const row of publications.rows) {
        if (!/^0x[0-9a-f]{40}$/.test(row.signer) || !/^(0|[1-9][0-9]*)$/.test(row.nonce)) throw unavailable();
        floors.set(row.signer, BigInt(row.nonce));
      }
      entered = true;
      return await relayerScope.run({ floors, assertHeld }, () => action(assertHeld));
    } finally {
      if (acquired) {
        try { if ((await client.query<{ unlocked: boolean }>("select pg_advisory_unlock(hashtextextended('backend:relayer:97',0)) as unlocked")).rows[0]?.unlocked !== true) discard(); }
        catch { discard(); }
      }
      client.removeListener('error', disconnected);
    }
  }).catch(error => { throw (entered || error instanceof AppError) ? error : unavailable(); });
}
