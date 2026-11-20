import { AsyncLocalStorage } from 'node:async_hooks';
import { withConnection } from './db.js';
import { AppError } from './errors.js';
import type { Address, PublicClient } from 'viem';

const relayerScope = new AsyncLocalStorage<{ floors: Map<string, bigint>; assertHeld: () => void }>();

/** All EOA entry points must honor durable publication nonces, including original
 * transactions not yet visible in the node mempool. Resolved history is never reused. */
export async function relayerNonce(client: PublicClient, signer: Address, chainId = 97): Promise<{ nonce?: number }> {
  const scope = relayerScope.getStore();
  if (chainId !== 97 || !scope) return {};
  const floor = scope.floors.get(signer.toLowerCase());
  if (floor === undefined) return {};
  scope.assertHeld();
  const read = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([client.getTransactionCount({ address: signer, blockTag: 'pending' }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('nonce unavailable')), 5000); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    let pending = await read();
    if (!Number.isSafeInteger(pending) || pending < 0) throw new Error('invalid relayer nonce');
    if (BigInt(pending) <= floor) {
      // Queued transactions above a gap are absent from some pending-nonce replies.
      // Fill the original publication gap before admitting a fresh transaction.
      try { await (await import('./mix-publication.js')).replayPublicationNonceGap(client, signer, BigInt(pending), scope.assertHeld); }
      catch { /* Recheck even if an identical original was already known to the node. */ }
      pending = await read();
      if (!Number.isSafeInteger(pending) || pending < 0 || BigInt(pending) <= floor) throw new Error('relayer nonce gap remains occupied');
    }
    scope.assertHeld();
    return { nonce: pending };
  } catch { throw new AppError(503, 'RELAYER_BUSY', 'relayer nonce unavailable; retry later'); }
}

/** Chain 97 faucet and enrollment share an EOA. Serialize nonce acquisition through broadcast
 * across API processes; reject busy work before reserving quota. Never wait holding pool clients.
 * This is a session lock, not a transaction: quota transactions contain no RPC.
 */
export async function withRelayerLock<T>(chainId: number, action: (assertHeld: () => void) => Promise<T>, options: { reconcile?: boolean } = {}): Promise<T> {
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
        union all select id from welcome_grants where chain_id=97 and state in ('submitted','unknown') and tx_hash is not null
        union all select id from mix_creation_requests where chain_id=97 and registration_tx_hash is not null
          and state='submitted' limit 1`)
        .catch(() => { throw unavailable(); });
      if (unresolved.rows.length > 0 && !options.reconcile) throw unavailable();
      assertHeld();
      const publications = await client.query<{ signer: string; nonce: string }>(`select signer,max(nonce)::text as nonce
        from mix_publication_outbox where chain_id=97 group by signer`).catch(() => { throw unavailable(); });
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
