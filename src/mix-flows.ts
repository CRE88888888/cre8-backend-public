import { decodeEventLog, erc20Abi, parseAbi } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { query, withTransaction } from './db.js';
import { record } from './strategy-execution.js';
import type { SchedulerQueryFn } from './scheduler.js';
import type { CashWithdrawal } from './cash-reconciliation.js';
import { mixUnavailable } from './mix-store.js';
import { TESTNET_97 as T } from './testnet-profile.js';
import { findDeploymentBlock } from './holdings-scan.js';
import { STRATEGY_EARN_INTERNAL } from './strategy-earn-guard.js';
import { strategyEarnV2, v2InternalAddresses, V2_EXECUTOR_ABI } from './strategy-earn-v2.js';
export type MixFlow = { kind: 'deposit' | 'withdrawal'; amountRaw: string; txHash: Hex; logIndex: number;
  blockNumber: bigint; blockHash: Hex; at: Date; asset: Address; quantityRaw: string; quote: MixFlowQuote };
export type MixFlowQuote = { decimals: number; priceUsdE8: bigint; source: string; at: Date };
export type MixFlowOptions = { assets?: readonly Address[];
  price?: (asset: Address, block: bigint) => Promise<MixFlowQuote>;
  savedQuote?: (txHash: Hex, logIndex: number, blockHash: Hex) => MixFlowQuote | undefined };
const flowOracleAbi = parseAbi(['function previewSwap(address,address,uint256) view returns(uint256,uint256)',
  'function feeRecipient() view returns(address)', 'event MinFeeCharged(address indexed account,uint256 notional,uint256 due,uint256 charged)']);
export type MixFlowAccount = { id: string; owner: Address; account: Address };

export async function verifyMixBlock(expected: Hex | null, read: () => Promise<Hex | null>): Promise<void> {
  try { if (expected === null || await read() !== expected) throw mixUnavailable(); }
  catch (error) { throw mixUnavailable(undefined, error); }
}

/** Executor pulls, proceeds and refunds are internal. A self-funded transfer to
 * any other recipient is an external withdrawal, even outside the App.
 */
export function mixFlowDirection(from: string, to: string, m: MixFlowAccount): MixFlow['kind'] | null {
  const sender = from.toLowerCase(), recipient = to.toLowerCase();
  if (sender === recipient) return null;
  // Yield strategy (posting/returning shares, repaying, the strategy vault and incentives) stays inside the mix.
  if (STRATEGY_EARN_INTERNAL.has(sender) || STRATEGY_EARN_INTERNAL.has(recipient)) return null;
  // Routing v2: the same, through AtpBorrowExecutorV2 and its vault adapters (the account's strategy box: see readMixFlows).
  const v2 = v2InternalAddresses(97);
  if (v2.has(sender) || v2.has(recipient)) return null;
  if (recipient === m.account && sender !== T.contracts.executor) return 'deposit';
  if (sender === m.account && recipient !== T.contracts.executor) return 'withdrawal';
  return null;
}
export async function priceMixFlowAsset(client: PublicClient, asset: Address, block: bigint): Promise<MixFlowQuote> {
  if (asset === T.contracts.usdt) return { decimals: 18, priceUsdE8: 100000000n, source: 'numeraire', at: new Date(Number((await client.getBlock({ blockNumber: block })).timestamp) * 1000) };
  const [decimals, header] = await Promise.all([
    client.readContract({ address: asset, abi: erc20Abi, functionName: 'decimals', blockNumber: block }), client.getBlock({ blockNumber: block })]);
  const [quoted] = await client.readContract({ address: T.contracts.router, abi: flowOracleAbi, functionName: 'previewSwap',
    args: [asset, T.contracts.usdt, 10n ** BigInt(decimals)], blockNumber: block });
  if (quoted < 10n ** 10n) throw mixUnavailable();
  return { decimals, priceUsdE8: quoted / 10n ** 10n, source: `oracle:${T.contracts.router}`, at: new Date(Number(header.timestamp) * 1000) };
}
/** The account's routing v2 strategy box (`AtpBorrowExecutorV2.boxOf`, a pure CREATE2 address), lowercase; null without a v2 deployment. A failed read throws: a flow is never booked on a guess. */
async function strategyBoxOf(client: PublicClient, account: Address): Promise<string | null> {
  const v2 = strategyEarnV2(97);
  if (v2 === null) return null;
  return (await client.readContract({ address: v2.executor, abi: V2_EXECUTOR_ABI, functionName: 'boxOf', args: [account] })).toLowerCase();
}
export async function readMixFlows(client: PublicClient, m: MixFlowAccount, fromBlock: bigint, toBlock: bigint, options: MixFlowOptions = {}): Promise<MixFlow[]> {
  try {
  if (fromBlock < 0n || toBlock < fromBlock || await client.getChainId() !== 97) throw mixUnavailable();
  const result = new Map<string, MixFlow>();
  const assets = [...new Set(options.assets ?? [T.contracts.usdt])];
  if (assets.length === 0) throw mixUnavailable();
  const prices = new Map<Address, MixFlowQuote>();
  let box: Promise<string | null> | undefined;
  for (let from = fromBlock; from <= toBlock; from += 2000n) {
    const to = from + 1999n < toBlock ? from + 1999n : toBlock;
    const [incoming, outgoing] = await Promise.all([
      client.getLogs({ address: assets, event: erc20Abi.find(e => e.type === 'event' && e.name === 'Transfer'), args: { to: m.account }, fromBlock: from, toBlock: to, strict: true }),
      client.getLogs({ address: assets, event: erc20Abi.find(e => e.type === 'event' && e.name === 'Transfer'), args: { from: m.account }, fromBlock: from, toBlock: to, strict: true }),
    ]);
    for (const log of [...incoming, ...outgoing]) {
      if (log.removed || log.logIndex === null || log.transactionHash === null || log.blockHash === null || log.blockNumber === null) throw mixUnavailable();
      const event = decodeEventLog({ abi: erc20Abi, eventName: 'Transfer', data: log.data, topics: log.topics });
      const kind = mixFlowDirection(event.args.from, event.args.to, m);
      if (kind === null || event.args.value === 0n) continue;
      // Routing v2: the account's own strategy box pays idle strategy money back to it — for any account that has one,
      // whoever its owner is (the audience only decides who may START on v2; a box keeps paying back after its owner left
      // it). The box is never the owner: an ordinary deposit costs no read. One `boxOf` read per call (a pure CREATE2
      // address), only when some other address sent the account tokens; none without a v2 deployment.
      const sender = event.args.from.toLowerCase();
      if (kind === 'deposit' && sender !== m.owner.toLowerCase()) { box ??= strategyBoxOf(client, m.account); if (sender === await box) continue; }
      const asset = log.address.toLowerCase() as Address;
      if (!assets.includes(asset)) throw mixUnavailable();
      const [receipt, block] = await Promise.all([client.getTransactionReceipt({ hash: log.transactionHash }), client.getBlock({ blockNumber: log.blockNumber })]);
      if (receipt.status !== 'success' || receipt.blockHash !== log.blockHash || block.hash !== log.blockHash ||
        !receipt.logs.some(e => !e.removed && e.logIndex === log.logIndex && e.address.toLowerCase() === asset && e.data === log.data && e.topics.join() === log.topics.join())) throw mixUnavailable();
      // Executor's minimum-fee top-up is a fee, not an owner withdrawal. Match
      // the exact canonical charge and recipient; arbitrary transfers stay external.
      const charge = kind === 'withdrawal' && asset === T.contracts.usdt ? receipt.logs.find(e => {
        if (e.address.toLowerCase() !== T.contracts.executor || e.removed) return false;
        try { const fee = decodeEventLog({ abi: flowOracleAbi, data: e.data, topics: e.topics });
          return e.logIndex !== null && e.logIndex > log.logIndex && fee.eventName === 'MinFeeCharged' && fee.args.account.toLowerCase() === m.account && fee.args.charged === event.args.value;
        } catch { return false; }
      }) : undefined;
      if (charge && charge.logIndex !== null) {
        const recipient = await client.readContract({ address: T.contracts.executor, abi: flowOracleAbi, functionName: 'feeRecipient', blockNumber: log.blockNumber });
        const chargeIndex = charge.logIndex;
        const preceding = receipt.logs.filter(e => e.logIndex !== null && e.logIndex < chargeIndex && e.address.toLowerCase() === asset && !e.removed).flatMap(e => {
          try { const transfer = decodeEventLog({ abi: erc20Abi, eventName: 'Transfer', data: e.data, topics: e.topics });
            return transfer.args.from.toLowerCase() === m.account && transfer.args.to.toLowerCase() === recipient.toLowerCase() && transfer.args.value === event.args.value && e.logIndex !== null ? [e.logIndex] : [];
          } catch { return []; }
        });
        if (event.args.to.toLowerCase() === recipient.toLowerCase() && log.logIndex === Math.max(...preceding)) continue;
      }
      let quote = options.savedQuote?.(log.transactionHash, log.logIndex, log.blockHash) ?? prices.get(asset);
      if (!quote) {
        quote = asset === T.contracts.usdt ? { decimals: 18, priceUsdE8: 100000000n, source: 'numeraire', at: new Date(Number(block.timestamp) * 1000) }
          : await (options.price ?? ((token, at) => priceMixFlowAsset(client, token, at)))(asset, toBlock);
        prices.set(asset, quote);
      }
      if (!Number.isInteger(quote.decimals) || quote.decimals < 0 || quote.decimals > 255 || quote.priceUsdE8 <= 0n ||
          !quote.source.trim() || quote.source.length > 128 || !Number.isFinite(quote.at.getTime())) throw mixUnavailable();
      result.set(`${log.transactionHash}:${log.logIndex}`, { kind, txHash: log.transactionHash,
        asset, quantityRaw: event.args.value.toString(), quote,
        logIndex: log.logIndex, blockNumber: log.blockNumber, blockHash: log.blockHash, at: new Date(Number(block.timestamp) * 1000),
        amountRaw: (event.args.value * quote.priceUsdE8 * 10n ** 10n / 10n ** BigInt(quote.decimals)).toString() });
    }
  }
  return [...result.values()];
  } catch (error) { throw mixUnavailable(undefined, error); }
}
/** Runs BEFORE the holdings cursor advances. A failed read/write never skips a
 * funding interval. Repeat scans and portfolio handovers share the canonical key.
 */
export async function syncMixFlowRange(client: PublicClient, portfolioId: number, range: { fromBlock: bigint; toBlock: bigint },
  deps = { query, transaction: withTransaction }): Promise<void> {
  const m = (await deps.query<MixFlowAccount>(`select m.id,m.owner,m.account from mixes m join smart_accounts a
    on a.chain_id=m.chain_id and a.address=m.account where a.portfolio_id=$1 and a.retired_at is null`, [portfolioId])).rows[0];
  if (!m) return;
  return syncMixAccountFlows(client, m, range, deps, portfolioId);
}
/**
 * Hashes of blocks the node has reported as finalized, by block number: such a block cannot be replaced, so its header
 * is read once per client. 2026-11-25: every plan of a private basket re-read the header of every saved cash flow, one
 * request after the other (portfolios 6, 7, 11 and 13: 27–86 s per plan, with the shared DEX lane held meanwhile).
 * Kept per client object and only for a client bound to a chain (the long-lived production clients): a test's fixture
 * transport, which may rewrite any block, never fills it.
 */
const finalizedHeaders = new WeakMap<PublicClient, Map<string, Hex>>();
const FINALIZED_HEADERS_MAX = 20_000;
const HEADER_READS_AT_ONCE = 12;
/**
 * The canonical hash of every saved flow's block (the reorg check). The same answers as reading them one by one:
 * - a block at or below the node's `finalized` block is read once and remembered (nothing can change it any more);
 * - every other block is read on every call, as before, a few at a time instead of one after the other;
 * - a node that cannot say what is finalized remembers nothing (every block is read); a failed header read fails the
 *   call, as before.
 */
export async function savedFlowHeaders(client: PublicClient, blocks: readonly string[]): Promise<Map<string, Hex | null>> {
  const remembered = client.chain === undefined ? null : finalizedHeaders.get(client) ?? new Map<string, Hex>();
  if (remembered !== null) finalizedHeaders.set(client, remembered);
  const headers = new Map<string, Hex | null>(), missing: string[] = [];
  for (const n of blocks) { const known = remembered?.get(n); if (known === undefined) missing.push(n); else headers.set(n, known); }
  if (missing.length === 0) return headers;
  const finalizedRead: Promise<bigint | null> = remembered === null ? Promise.resolve(null)
    : client.getBlock({ blockTag: 'finalized' }).then(b => b.number, () => null);
  for (let at = 0; at < missing.length; at += HEADER_READS_AT_ONCE) {
    const part = missing.slice(at, at + HEADER_READS_AT_ONCE);
    const hashes = await Promise.all(part.map(async n => (await client.getBlock({ blockNumber: BigInt(n) })).hash));
    part.forEach((n, i) => headers.set(n, hashes[i] ?? null));
  }
  const finalized = await finalizedRead;
  if (remembered !== null && finalized !== null) {
    if (remembered.size + missing.length > FINALIZED_HEADERS_MAX) remembered.clear();
    for (const n of missing) { const hash = headers.get(n); if (hash && BigInt(n) <= finalized) remembered.set(n, hash); }
  }
  return headers;
}
export async function syncMixAccountFlows(client: PublicClient, m: MixFlowAccount, range: { fromBlock: bigint; toBlock: bigint },
  deps = { query, transaction: withTransaction }, portfolioId?: number): Promise<void> {
  if (range.toBlock < 0n || range.fromBlock < 0n || range.fromBlock > range.toBlock + 1n) throw mixUnavailable();
  const anchor = await client.getBlock({ blockNumber: range.toBlock });
  const settings = (await deps.query<{ user_allocation: Record<string, number>; exit_assets: Address[] }>(
    'select user_allocation,exit_assets from mix_strategy_settings where mix_id=$1', [m.id])).rows;
  const assets = [...new Set<Address>([T.contracts.usdt, ...settings.flatMap(s => [...Object.keys(s.user_allocation).map(a => a as Address), ...s.exit_assets])])];
  const saved = (await deps.query<{ id: string; block_number: string; block_hash: Hex; tx_hash: Hex; log_index: string;
    asset_decimals: number; price_usd_e8: string; price_source: string; priced_at: Date }>(`select id,block_number::text,block_hash,
    tx_hash,log_index::text,asset_decimals,price_usd_e8::text,price_source,priced_at
    from mix_cash_flows where mix_id=$1 and state='canonical'`, [m.id])).rows;
  const originalQuotes = new Map(saved.map(s => [`${s.tx_hash}:${s.log_index}:${s.block_hash}`, {
    decimals: s.asset_decimals, priceUsdE8: BigInt(s.price_usd_e8), source: s.price_source, at: s.priced_at }]));
  const changed: string[] = [];
  const headers = await savedFlowHeaders(client, [...new Set(saved.map(s => s.block_number))]);
  for (const s of saved) if (headers.get(s.block_number) !== s.block_hash) changed.push(s.id);
  const flows = changed.length || range.fromBlock > range.toBlock ? [] : await readMixFlows(client, m, range.fromBlock, range.toBlock, { assets,
    savedQuote: (hash, index, block) => originalQuotes.get(`${hash}:${index}:${block}`) });
  if (!anchor.hash || (await client.getBlock({ blockNumber: range.toBlock })).hash !== anchor.hash) throw mixUnavailable();
  await deps.transaction(async db => {
    await db.query('select id from mixes where id=$1 for update', [m.id]);
    if (changed.length) {
      await db.query("update mix_cash_flows set state='reorged' where id=any($1::bigint[]) and state='canonical'", [changed]);
      if (portfolioId !== undefined) {
        const earliest = saved.filter(s => changed.includes(s.id)).reduce((block, s) => BigInt(s.block_number) < block ? BigInt(s.block_number) : block, range.toBlock);
        await db.query('update portfolio_scan_cursors set last_scanned_block=least(last_scanned_block,$2) where portfolio_id=$1', [portfolioId, (earliest - 1n).toString()]);
      }
      return;
    }
    for (const f of flows) {
      const values = [m.id, f.kind, f.amountRaw, f.txHash, f.logIndex, f.blockNumber.toString(), f.blockHash, f.at,
        f.asset, f.quantityRaw, f.quote.decimals, f.quote.priceUsdE8.toString(), f.quote.source, f.quote.at];
      if (!originalQuotes.has(`${f.txHash}:${f.logIndex}:${f.blockHash}`)) await db.query(`insert into mix_cash_flows(mix_id,chain_id,kind,amount_raw,tx_hash,log_index,block_number,block_hash,observed_at,
        asset,quantity_raw,asset_decimals,price_usd_e8,price_source,priced_at)
        values($1,97,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) on conflict(chain_id,tx_hash,log_index) where state='canonical' do nothing`, values);
      const check = (await db.query<{ matches: boolean }>(`select (mix_id=$1 and kind=$2 and amount_raw=$3::numeric and block_number=$6::bigint and block_hash=$7
        and asset=$8 and quantity_raw=$9::numeric) as matches
        from mix_cash_flows where chain_id=97 and tx_hash=$4 and log_index=$5 and state='canonical'`,
        [m.id, f.kind, f.amountRaw, f.txHash, f.logIndex, f.blockNumber.toString(), f.blockHash, f.asset, f.quantityRaw])).rows[0];
      if (check?.matches !== true) throw mixUnavailable();
    }
  });
  if (changed.length) throw new AppErrorForMixReorg();
}
export async function syncMixEnrollmentFlows(client: PublicClient, m: MixFlowAccount, proof: { blockNumber: bigint; blockHash: Hex },
  deps = { query, transaction: withTransaction }): Promise<void> {
  if ((await client.getBlock({ blockNumber: proof.blockNumber })).hash !== proof.blockHash) throw mixUnavailable();
  const history = (await deps.query<{ portfolio_id: string }>('select portfolio_id from mix_portfolio_history where mix_id=$1 and ended_at is null', [m.id])).rows[0];
  const cursor = history ? (await deps.query<{ last_scanned_block: string }>(
    'select last_scanned_block::text from portfolio_scan_cursors where portfolio_id=$1', [history.portfolio_id])).rows[0] : undefined;
  const start = cursor ? BigInt(cursor.last_scanned_block) + 1n :
    (await findDeploymentBlock(client, { account: m.account, head: proof.blockNumber })).block;
  if (start === null) throw mixUnavailable();
  await syncMixAccountFlows(client, m, { fromBlock: start <= proof.blockNumber ? start : proof.blockNumber + 1n, toBlock: proof.blockNumber },
    deps, history ? Number(history.portfolio_id) : undefined);
  if ((await client.getBlock({ blockNumber: proof.blockNumber })).hash !== proof.blockHash) throw mixUnavailable();
}
class AppErrorForMixReorg extends Error {
  constructor() { super('[MIX_FLOW_REORGED] 入出金證據改變，停止交易並保留原始紀錄。'); }
}

/** Principal scanning has already verified these receipts at this snapshot. Only
 * withdrawals after the current enrollment debit its cash; earlier withdrawals
 * were included in the canonical handover balance.
 */
export async function mixCashWithdrawals(portfolioId: number, find: SchedulerQueryFn, blockNumber: bigint): Promise<CashWithdrawal[]> {
  const rows = (await find(`select f.tx_hash,f.log_index::text,f.block_number::text,f.block_hash,f.amount_raw::text
    from mix_cash_flows f join mix_portfolio_history h on h.mix_id=f.mix_id and h.ended_at is null
    where h.portfolio_id=$1 and f.state='canonical' and f.kind='withdrawal' and f.asset='${T.contracts.usdt}' and f.block_number<=$2
      and ((h.previous_history_id is not null and f.block_number>h.enroll_block_number) or
        (h.previous_history_id is null and (f.block_number,f.log_index)>(h.enroll_block_number,h.enroll_log_index)))`, [portfolioId, blockNumber.toString()])).rows;
  return rows.map(r => {
    if (!record(r) || typeof r.tx_hash !== 'string' || !/^0x[0-9a-f]{64}$/.test(r.tx_hash) ||
        typeof r.block_hash !== 'string' || !/^0x[0-9a-f]{64}$/.test(r.block_hash) || typeof r.log_index !== 'string' ||
        typeof r.block_number !== 'string' || typeof r.amount_raw !== 'string' || !Number.isSafeInteger(Number(r.log_index))) throw mixUnavailable();
    return { txHash: r.tx_hash as Hex, blockHash: r.block_hash as Hex, logIndex: Number(r.log_index), blockNumber: BigInt(r.block_number), amount: BigInt(r.amount_raw) };
  });
}
