import type { Address, Hex, PublicClient } from 'viem';
import { mixUnavailable } from './mix-store.js';

export type NonceOriginal = { signer: Address; nonce: string; tx_hash: Hex; checked_block_number: string };
export type NonceConsumption = { foreign_tx_hash: Hex; block_number: string; block_hash: Hex; block_time: Date };
type Anchor = { number: bigint; hash: Hex; at: Date };
type Read = <R>(work: Promise<R>) => Promise<R>;
type AnchorReader = (number: bigint) => Promise<Anchor>;
const hash = (value: string) => /^0x[0-9a-f]{64}$/.test(value);
async function nonceAt(client: PublicClient, original: NonceOriginal, blockNumber: bigint, read: Read): Promise<bigint> {
  const value = await read(client.getTransactionCount({ address: original.signer, blockNumber }));
  if (!Number.isSafeInteger(value) || value < 0) throw mixUnavailable();
  return BigInt(value);
}

/** A pending nonce, timeout or absent original receipt never proves replacement.
 * Locate the canonical block where this signer's nonce crossed N, then require
 * the full transaction, matching receipt, and stable block/observation anchors. */
export async function findPublicationNonceConsumption(client: PublicClient, original: NonceOriginal,
  observed: Anchor, read: Read, anchor: AnchorReader): Promise<NonceConsumption | null> {
  if (await read(client.getChainId()) !== 97) throw mixUnavailable();
  const nonce = BigInt(original.nonce);
  if (await nonceAt(client, original, observed.number, read) <= nonce) return null;
  let low = BigInt(original.checked_block_number), high = observed.number;
  if (low > high || await nonceAt(client, original, low, read) > nonce) throw mixUnavailable();
  while (high - low > 1n) {
    const middle = (low + high) / 2n;
    if (await nonceAt(client, original, middle, read) > nonce) high = middle; else low = middle;
  }
  const block = await read(client.getBlock({ blockNumber: high, includeTransactions: true }));
  if (block.number !== high || block.hash === null || !hash(block.hash) || block.timestamp < 0n || block.timestamp > 8_640_000_000_000n ||
      block.transactions.some(tx => typeof tx === 'string')) throw mixUnavailable();
  const matches = block.transactions.filter(tx => typeof tx !== 'string' && tx.from.toLowerCase() === original.signer.toLowerCase() && tx.nonce.toString() === original.nonce);
  const tx = matches[0];
  if (matches.length !== 1 || !tx || typeof tx === 'string' || !hash(tx.hash) || tx.blockNumber !== high || tx.blockHash !== block.hash) throw mixUnavailable();
  if (tx.hash === original.tx_hash) return null;
  const proof = { foreign_tx_hash: tx.hash, block_number: high.toString(), block_hash: block.hash, block_time: new Date(Number(block.timestamp) * 1000) };
  await verifyPublicationNonceConsumption(client, original, proof, read, anchor);
  if (await nonceAt(client, original, low, read) > nonce || await nonceAt(client, original, high, read) <= nonce ||
      (await anchor(observed.number)).hash !== observed.hash) throw mixUnavailable();
  return proof;
}

/** Revalidate saved resolution before a fresh signature; reorg never erases audit. */
export async function verifyPublicationNonceConsumption(client: PublicClient, original: NonceOriginal, proof: NonceConsumption,
  read: Read, anchor: AnchorReader): Promise<void> {
  if (await read(client.getChainId()) !== 97 || !hash(proof.foreign_tx_hash) || proof.foreign_tx_hash === original.tx_hash || !hash(proof.block_hash)) throw mixUnavailable();
  const number = BigInt(proof.block_number);
  const [tx, receipt, block] = await Promise.all([
    read(client.getTransaction({ hash: proof.foreign_tx_hash })),
    read(client.getTransactionReceipt({ hash: proof.foreign_tx_hash })), anchor(number),
  ]);
  const inclusion = await read(client.getBlock({ blockNumber: number, includeTransactions: true }));
  const matches = inclusion.transactions.filter(member => typeof member !== 'string' && member.hash === proof.foreign_tx_hash);
  const member = matches[0];
  if (inclusion.number !== number || inclusion.hash !== proof.block_hash || matches.length !== 1 || !member || typeof member === 'string' ||
      member.from.toLowerCase() !== tx.from.toLowerCase() || member.nonce !== tx.nonce || member.transactionIndex !== tx.transactionIndex ||
      member.to?.toLowerCase() !== tx.to?.toLowerCase() || member.input !== tx.input || member.value !== tx.value) throw mixUnavailable();
  if (tx.hash !== proof.foreign_tx_hash || tx.from.toLowerCase() !== original.signer.toLowerCase() || tx.nonce.toString() !== original.nonce ||
      tx.blockNumber !== number || tx.blockHash !== proof.block_hash || tx.transactionIndex === null ||
      receipt.transactionHash !== tx.hash || receipt.from.toLowerCase() !== original.signer.toLowerCase() || receipt.to?.toLowerCase() !== tx.to?.toLowerCase() ||
      receipt.transactionIndex !== tx.transactionIndex || receipt.blockNumber !== number || receipt.blockHash !== proof.block_hash ||
      !['success','reverted'].includes(receipt.status) || block.hash !== proof.block_hash || block.at.getTime() !== proof.block_time.getTime() ||
      (await anchor(number)).hash !== proof.block_hash) throw mixUnavailable();
}
