import { encodeFunctionData, isAddress, keccak256, parseAbi, parseTransaction, recoverTransactionAddress, serializeTransaction, zeroAddress } from 'viem';
import type { Address, Hex } from 'viem';
import type { PoolClient } from 'pg';
import { TESTNET_97 } from './testnet-profile.js';
import { WELCOME_AMOUNT_WEI } from './config.js';
import { outboxIdentity, saveOutboxIdentity } from './relayer-nonce-consumption.js';

export type RelayerSource = { kind: 'welcome' | 'faucet'; id: string; chainId: number; account: Address; amountWei: bigint };
export type SignedSubmission = { raw: Hex; operator?: Address };
const abi = parseAbi(['function welcomeFor(address)', 'function claimFor(address,uint256)']);

/** No RPC or logging: raw bytes are broadcast authority. Validate before saving AND replaying.
 * The optional operator is for callers using an explicitly supplied signing fixture; production
 * always uses the pinned profile operator, including after a restart.
 */
export async function validateRelayerTransaction(source: RelayerSource, hash: Hex, raw: Hex, operator: Address = TESTNET_97.roles.operator): Promise<void> {
  if (source.chainId !== 97 || !/^[1-9]\d*$/.test(source.id) || !isAddress(source.account, { strict: false }) || source.account.toLowerCase() === zeroAddress ||
      !/^0x([0-9a-f]{2})+$/.test(raw) || !/^0x[0-9a-f]{64}$/.test(hash) || keccak256(raw) !== hash ||
      (source.kind === 'welcome' ? source.amountWei !== WELCOME_AMOUNT_WEI : source.amountWei <= 0n || source.amountWei > 1000n * 10n ** 18n)) throw new Error('invalid original relayer transaction');
  const tx = parseTransaction(raw);
  const data = source.kind === 'welcome'
    ? encodeFunctionData({ abi, functionName: 'welcomeFor', args: [source.account] })
    : encodeFunctionData({ abi, functionName: 'claimFor', args: [source.account, source.amountWei] });
  if ((tx.type !== 'legacy' && tx.type !== 'eip1559') || tx.chainId !== 97 || !Number.isSafeInteger(tx.nonce) || tx.nonce === undefined || tx.nonce < 0 ||
      tx.gas === undefined || tx.gas <= 0n || (tx.value ?? 0n) !== 0n || tx.to?.toLowerCase() !== TESTNET_97.contracts.usdt ||
      tx.data?.toLowerCase() !== data.toLowerCase() || !tx.r || !tx.s) {
    throw new Error('invalid original relayer transaction');
  }
  const serialized = serializeTransaction(tx, { r: tx.r, s: tx.s, v: tx.v ?? BigInt(27 + (tx.yParity ?? 0)) });
  if (keccak256(serialized) !== hash || (await recoverTransactionAddress({ serializedTransaction: serialized })).toLowerCase() !== operator.toLowerCase()) throw new Error('invalid original relayer transaction');
}

/** Called only after locking the original day/source, BEFORE its matching submitted UPDATE. */
export async function saveRelayerTransaction(client: PoolClient, source: RelayerSource, hash: Hex, signed: SignedSubmission): Promise<void> {
  await validateRelayerTransaction(source, hash, signed.raw, signed.operator);
  await client.query(`insert into relayer_transaction_outbox(tx_hash,chain_id,signed_raw_tx,welcome_grant_id,faucet_claim_id)
    values($1,$2,$3,$4,$5)`, [hash, source.chainId, signed.raw, source.kind === 'welcome' ? source.id : null, source.kind === 'faucet' ? source.id : null]);
  await saveOutboxIdentity(client, await outboxIdentity(hash, signed.raw, signed.operator ?? TESTNET_97.roles.operator), { fundingTxHash: hash });
}
