import { createHash } from 'node:crypto';
import { withConnection } from './db.js';
import { AppError, ValidationError } from './errors.js';
import type { MixSettings } from './mix-domain.js';
import { mixUnavailable } from './mix-store.js';

export type MixCreation = {
  id: string; owner: `0x${string}`; chain_id: string; request_hash: `0x${string}`;
  settings: MixSettings & { importedFromMixId?: string }; state: 'prepared' | 'submitted' | 'registered' | 'completed';
  registration_tx_hash: `0x${string}` | null; onchain_strategy_id: string | null;
  registration_block_number: string | null; registration_block_hash: `0x${string}` | null;
  strategy_id: string | null; mix_id: string | null;
};
// Deliberately excludes outbox authority; safe request data never includes raw transactions.
export const MIX_CREATION_COLUMNS = `id,owner,chain_id,request_hash,settings,state,registration_tx_hash,
  onchain_strategy_id,registration_block_number,registration_block_hash,strategy_id,mix_id`;
export function mixRequestKey(key: unknown): string {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key)) {
    throw new ValidationError('INVALID_MIX_REQUEST_KEY', '請提供有效的 Idempotency-Key，重試時使用同一個代碼。');
  }
  return key;
}
/** Object order is irrelevant; array order, explicit null and omitted fields remain distinct. */
export function mixRequestHash(input: unknown): `0x${string}` {
  const canonical = (value: unknown): string => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
      return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(Reflect.get(value, key))).join(',') + '}';
    }
    throw new ValidationError('INVALID_MIX', '組合設定必須是有效的 JSON。');
  };
  return `0x${createHash('sha256').update(canonical(input)).digest('hex')}`;
}

export async function withMixCreationLock<T>(id: string, work: () => Promise<T>): Promise<T> {
  return withConnection(async (client, discard) => {
    let held = false, lost = false;
    const disconnected = () => { lost = true; discard(); };
    client.on('error', disconnected);
    try {
      held = (await client.query<{ held: boolean }>("select pg_try_advisory_lock(hashtextextended('backend:mix-create:' || $1,0)) as held", [id])).rows[0]?.held === true;
      if (!held) throw new AppError(409, 'MIX_CREATE_BUSY', '同一個組合正在建立，請稍後使用相同代碼重試。');
      const result = await work();
      if (lost) throw mixUnavailable();
      return result;
    } finally {
      if (held) {
        try { if (!(await client.query<{ ok: boolean }>("select pg_advisory_unlock(hashtextextended('backend:mix-create:' || $1,0)) as ok", [id])).rows[0]?.ok) discard(); }
        catch { discard(); }
      }
      client.removeListener('error', disconnected);
    }
  });
}
