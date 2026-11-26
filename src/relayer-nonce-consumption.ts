import { keccak256, parseTransaction, recoverTransactionAddress, serializeTransaction } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import type { PoolClient } from 'pg';
import { query, withTransaction } from './db.js';
import { findPublicationNonceConsumption, verifyPublicationNonceConsumption } from './mix-publication-nonce.js';
import type { NonceConsumption } from './mix-publication-nonce.js';
import { recordAlerts } from './alerts.js';

export type OutboxIdentity = { tx_hash: Hex; signer: Address; nonce: string };
export type OutboxSource = { registrationRequestId: string; registrationAttempt: number } | { fundingTxHash: Hex };
export type FundingNonceConsumption = { raw: Hex; operator: Address; proof: NonceConsumption };
type Anchor = { number: bigint; hash: Hex; at: Date };
type Read = <R>(work: Promise<R>) => Promise<R>;
export type NonceHistoryDeps = { client: PublicClient; operator: Address; query: typeof query; transaction: typeof withTransaction; timeoutMs?: number };
const unavailable = () => new Error('outbox nonce evidence unavailable; original authority retained');
// Count only blocks AFTER inclusion: head B has zero confirmations for block B.
const CONSUMPTION_CONFIRMATIONS = 15n;

/** Calldata/source validation belongs to the existing writer; independently bind
 * its already-validated original bytes to the immutable SQL nonce identity. */
export async function outboxIdentity(hash: Hex, raw: Hex, operator: Address): Promise<OutboxIdentity> {
  const tx = parseTransaction(raw);
  if (keccak256(raw) !== hash || (tx.type !== 'legacy' && tx.type !== 'eip1559') || tx.chainId !== 97 || tx.nonce === undefined ||
      !Number.isSafeInteger(tx.nonce) || tx.nonce < 0 || !tx.r || !tx.s) throw unavailable();
  const serialized = serializeTransaction(tx, { r: tx.r, s: tx.s, v: tx.v ?? BigInt(27 + (tx.yParity ?? 0)) });
  if (keccak256(serialized) !== hash || (await recoverTransactionAddress({ serializedTransaction: serialized })).toLowerCase() !== operator.toLowerCase()) throw unavailable();
  return { tx_hash: hash, signer: operator.toLowerCase() as Address, nonce: tx.nonce.toString() };
}
export async function saveOutboxIdentity(db: Pick<PoolClient, 'query'>, original: OutboxIdentity, source: OutboxSource): Promise<void> {
  const registration = 'registrationRequestId' in source ? source : null;
  const funding = 'fundingTxHash' in source ? source.fundingTxHash : null;
  await db.query(`insert into relayer_outbox_nonce_identities(tx_hash,chain_id,signer,nonce,registration_request_id,registration_attempt,funding_tx_hash)
    values($1,97,$2,$3,$4,$5,$6) on conflict(tx_hash) do nothing`,
    [original.tx_hash, original.signer, original.nonce, registration?.registrationRequestId ?? null, registration?.registrationAttempt ?? null, funding]);
  const saved = (await db.query<{ signer: string; nonce: string; chain_id: string; registration_request_id: string | null; registration_attempt: number | null; funding_tx_hash: string | null }>(
    'select signer,nonce::text,chain_id,registration_request_id,registration_attempt,funding_tx_hash from relayer_outbox_nonce_identities where tx_hash=$1', [original.tx_hash])).rows[0];
  if (!saved || saved.signer !== original.signer || saved.nonce !== original.nonce || saved.chain_id !== '97' ||
      saved.registration_request_id !== (registration?.registrationRequestId ?? null) || saved.registration_attempt !== (registration?.registrationAttempt ?? null) || saved.funding_tx_hash !== funding) throw unavailable();
}
export async function saveOutboxConsumption(db: Pick<PoolClient, 'query'>, original: OutboxIdentity, proof: NonceConsumption): Promise<void> {
  const previous = (await db.query<NonceConsumption>('select foreign_tx_hash,block_number::text,block_hash,block_time from relayer_outbox_nonce_consumptions where tx_hash=$1', [original.tx_hash])).rows[0];
  if (previous) {
    if (previous.foreign_tx_hash !== proof.foreign_tx_hash || previous.block_number !== proof.block_number || previous.block_hash !== proof.block_hash ||
        previous.block_time.getTime() !== proof.block_time.getTime()) throw unavailable();
    return;
  }
  await db.query(`insert into relayer_outbox_nonce_consumptions(tx_hash,chain_id,signer,nonce,foreign_tx_hash,block_number,block_hash,block_time)
    values($1,97,$2,$3,$4,$5,$6,$7)`, [original.tx_hash, original.signer, original.nonce, proof.foreign_tx_hash, proof.block_number, proof.block_hash, proof.block_time]);
}
function reader(timeoutMs = 5000): Read {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw unavailable();
  const deadline = Date.now() + timeoutMs;
  return async <R>(work: Promise<R>): Promise<R> => {
    const ms = deadline - Date.now();
    if (ms < 1) throw unavailable();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(unavailable()), ms); })]); }
    finally { clearTimeout(timer); }
  };
}
async function anchor(client: PublicClient, read: Read, number?: bigint): Promise<Anchor> {
  const block = await read(client.getBlock(number === undefined ? { blockTag: 'latest' } : { blockNumber: number }));
  if (block.number === null || block.number < 0n || number !== undefined && block.number !== number || block.hash === null || !/^0x[0-9a-f]{64}$/.test(block.hash) ||
      block.timestamp < 0n || block.timestamp > 8_640_000_000_000n) throw unavailable();
  return { number: block.number, hash: block.hash, at: new Date(Number(block.timestamp) * 1000) };
}
/** Legacy outboxes have no pre-sign block. Exponentially bracket the nonce
 * crossing from the latest canonical block, avoiding a speculative genesis scan.
 * The complete lookup shares one deadline; missing history never releases it. */
export async function findOutboxConsumption(client: PublicClient, original: OutboxIdentity, timeoutMs?: number): Promise<NonceConsumption | null> {
  const read = reader(timeoutMs);
  if (await read(client.getChainId()) !== 97) throw unavailable();
  const head = await anchor(client, read), nonce = BigInt(original.nonce);
  if (head.number < CONSUMPTION_CONFIRMATIONS) return null;
  const observed = await anchor(client, read, head.number - CONSUMPTION_CONFIRMATIONS);
  const nonceAt = async (number: bigint) => {
    const value = await read(client.getTransactionCount({ address: original.signer, blockNumber: number }));
    if (!Number.isSafeInteger(value) || value < 0) throw unavailable();
    return BigInt(value);
  };
  if (await nonceAt(observed.number) <= nonce) return null;
  let distance = 1n, low = observed.number > 0n ? observed.number - 1n : 0n;
  while (await nonceAt(low) > nonce) {
    if (low === 0n) throw unavailable();
    distance *= 2n; low = observed.number > distance ? observed.number - distance : 0n;
  }
  const proof = await findPublicationNonceConsumption(client, { ...original, checked_block_number: low.toString() }, observed,
    read, number => anchor(client, read, number));
  if (proof) await verifyConfirmationHead(client, proof, head, read);
  return proof;
}
/** Recheck immediately before persistence; a pending-nonce increment alone is
 * never evidence. This also protects a replacement signature after reconnect. */
export async function verifyOutboxConsumption(client: PublicClient, original: OutboxIdentity, proof: NonceConsumption, timeoutMs?: number): Promise<void> {
  const read = reader(timeoutMs);
  await verifyConfirmedConsumption(client, original, proof, read);
}
async function verifyConfirmedConsumption(client: PublicClient, original: OutboxIdentity, proof: NonceConsumption, read: Read): Promise<void> {
  const head = await anchor(client, read);
  if (head.number - BigInt(proof.block_number) < CONSUMPTION_CONFIRMATIONS) throw unavailable();
  await verifyPublicationNonceConsumption(client, { ...original, checked_block_number: '0' }, proof, read, number => anchor(client, read, number));
  await verifyConfirmationHead(client, proof, head, read);
}
async function verifyConfirmationHead(client: PublicClient, proof: NonceConsumption, head: Anchor, read: Read): Promise<void> {
  // Recheck the sampled head as well as inclusion. A retreat/reorg during RPC
  // verification cannot authorize persistence or another signature.
  const current = await anchor(client, read);
  if (current.number - BigInt(proof.block_number) < CONSUMPTION_CONFIRMATIONS || (await anchor(client, read, head.number)).hash !== head.hash) throw unavailable();
}
type History = OutboxIdentity & NonceConsumption & { registration_request_id: string | null; quarantined: boolean };
/** A real changed canonical hash quarantines only that source and retains its
 * evidence. RPC/DB errors remain unknown rather than fabricating a reorg. */
export async function checkOutboxNonceHistory(deps: NonceHistoryDeps, registrationId?: string): Promise<boolean> {
  const rows = (await deps.query<History>(`select n.tx_hash,n.signer,n.nonce::text,n.registration_request_id,c.foreign_tx_hash,
    c.block_number::text,c.block_hash,c.block_time,(q.tx_hash is not null) as quarantined
    from relayer_outbox_nonce_identities n join relayer_outbox_nonce_consumptions c using(tx_hash)
    left join relayer_outbox_nonce_quarantines q using(tx_hash)
    where n.chain_id=97 and ($1::bigint is null or n.registration_request_id=$1)
      and ($1::bigint is not null or n.signer=$2) order by n.tx_hash`, [registrationId ?? null, deps.operator.toLowerCase()])).rows;
  let valid = true;
  const read = reader(deps.timeoutMs);
  for (const row of rows) {
    if (row.quarantined) { valid = false; continue; }
    if (row.signer !== deps.operator.toLowerCase()) throw unavailable();
    const block = await anchor(deps.client, read, BigInt(row.block_number));
    if (block.hash !== row.block_hash) {
      await deps.transaction(async db => {
        await db.query("set local statement_timeout='5s'");
        await db.query("set local lock_timeout='3s'");
        await db.query(`insert into relayer_outbox_nonce_quarantines(tx_hash,reason_code,alerted_at)
          values($1,'OUTBOX_NONCE_PROOF_REORG',clock_timestamp()) on conflict(tx_hash) do nothing`, [row.tx_hash]);
        await recordAlerts((sql, params) => db.query(sql, params ? [...params] : []), [{ kind: 'portfolio_stuck', severity: 'critical', portfolioId: null,
          detail: 'relayer 外部 nonce 消耗證據區塊已改變；原簽與證據已保留並隔離來源，請營運對帳。' }]);
      });
      valid = false;
    } else await verifyConfirmedConsumption(deps.client, row, row, read);
  }
  return valid;
}
