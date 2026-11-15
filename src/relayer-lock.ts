import { getPool } from './db.js';
import { AppError } from './errors.js';

/** Chain 97 faucet and enrollment share an EOA. Serialize nonce acquisition through broadcast
 * across API processes; reject busy work before reserving quota. Never wait holding pool clients.
 * This is a session lock, not a transaction: quota transactions contain no RPC.
 */
export async function withRelayerLock<T>(chainId: number, action: (assertHeld: () => void) => Promise<T>): Promise<T> {
  if (chainId !== 97) return action(() => {});
  const unavailable = () => new AppError(503, 'RELAYER_BUSY', 'testnet relayer unavailable; retry later');
  const client = await getPool().connect().catch(() => { throw unavailable(); });
  let acquired = false;
  let reusable = false;
  let healthy = true;
  const disconnected = () => { reusable = false; healthy = false; };
  const assertHeld = () => { if (!healthy) throw unavailable(); };
  client.on('error', disconnected);
  try {
    acquired = (await client.query<{ locked: boolean }>("select pg_try_advisory_lock(hashtextextended('backend:relayer:97',0)) as locked")
      .catch(() => { throw unavailable(); })).rows[0]?.locked === true;
    reusable = true;
    if (!acquired) throw unavailable();
    assertHeld();
    // A timed-out eth_sendRawTransaction may still be accepted later. Never acquire
    // another nonce until the durable hash is reconciled, even on a later UTC day.
    const unresolved = await client.query(`select id from faucet_claims where chain_id=97 and state in ('submitted','unknown') and tx_hash is not null
      union all select id from welcome_grants where chain_id=97 and state in ('submitted','unknown') and tx_hash is not null limit 1`)
      .catch(() => { throw unavailable(); });
    if (unresolved.rows.length > 0) throw unavailable();
    assertHeld();
    return await action(assertHeld);
  } finally {
    if (acquired) {
      try { reusable = (await client.query<{ unlocked: boolean }>("select pg_advisory_unlock(hashtextextended('backend:relayer:97',0)) as unlocked")).rows[0]?.unlocked === true; }
      catch { reusable = false; }
    }
    client.release(!reusable);
    client.removeListener('error', disconnected);
  }
}
