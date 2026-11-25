import { decodeEventLog, decodeFunctionData, erc20Abi } from 'viem';
import type { Address, Hex } from 'viem';
import { entryPoint07Abi } from 'viem/account-abstraction';
import { getChain, registerStrategyOnchain, REGISTRY_ABI, REGISTRY_VERSION_ABI } from './chain.js';
import { withRelayerLock } from './relayer-lock.js';
import { query, withTransaction } from './db.js';
import { registerMixCreation } from './mix-registration.js';
import { mixOwnerCalls } from './mix-approval.js';
import { assertMixOwnerCalls, assertMixSudoNonce, MIX_SUDO_NONCE_KEY } from './mix-sponsorship.js';
import { canonicalKernelCalls, packedOperationHash } from './paymaster.js';
import { mixUnavailable } from './mix-store.js';
import type { MixEnrollmentProof, MixIntent, MixRow } from './mix-store.js';
import type { ChainConfig } from './chain.js';
import type { Allocation } from './strategies.js';
import { TESTNET_97 as T } from './testnet-profile.js';
import { publishMixStrategy } from './mix-publication.js';
import { AppError } from './errors.js';
import { validateAssetConfig } from './strategy-execution.js';
import { strategyEarnV2For } from './strategy-earn-v2.js';

/** Private, first-version hold. No performance-fee service or yield calls are installed.
 * The existing registry's 500-bps legacy commitment is inert without the optional fee ledger.
 */
type MixStrategyDeps = { chain?: ChainConfig; query?: typeof query; transaction?: typeof withTransaction; lock?: typeof withRelayerLock };
export async function registerMixStrategy(owner: Address, name: string, allocation: Allocation, creationId?: string, deps: MixStrategyDeps = {}): Promise<number> {
  const chain = deps.chain ?? getChain(), db = deps.query ?? query, transaction = deps.transaction ?? withTransaction, lock = deps.lock ?? withRelayerLock;
  if (chain.chainId !== 97) throw new AppError(503, 'MIX_CHAIN_UNAVAILABLE', '私人組合目前僅開放測試網。');
  const creation = creationId === undefined ? null : await registerMixCreation(creationId, { chain, query: db, transaction, lock });
  const onchainId = creation ? Number(creation.onchain_strategy_id) : await registerStrategyOnchain({ name: 'CRE8 mix', description: 'My mix', isPublic: false });
  const strategyId = creation?.strategy_id ?? await transaction(async client => {
    const row = (await client.query<{ id: string }>(`insert into strategies(provider,name,description,is_public,swap_fee_bps,onchain_id,is_personal_mix)
      values($1,$2,'My mix',false,10,$3,true) returning id`, [owner, name, onchainId])).rows[0];
    if (!row) throw mixUnavailable();
    if (creation) await client.query('update mix_creation_requests set strategy_id=$2,updated_at=clock_timestamp() where id=$1', [creation.id, row.id]);
    return row.id;
  });
  const execution = validateAssetConfig({ kind: 'per_asset', numeraire: T.contracts.usdt, rebalance: 'none',
    assets: allocation.assets.map(a => ({ asset: a.address, weightBps: a.weightBps,
      ...(a.address === T.contracts.usdt ? {} : { execution: { kind: 'hold' } }), yield: null })) }, allocation, 97);
  await publishMixStrategy(String(strategyId), onchainId, creationId, allocation, execution,
    { chain, client: chain.publicClient, operator: chain.account.address, query: db, transaction, lock });
  return Number(strategyId);
}

export async function prepareMixCalls(m: Pick<MixRow, 'account'>, strategyId: number, previousAssets: readonly Address[]) {
  const chain = getChain(), client = chain.publicClient;
  if (chain.chainId !== 97 || await client.getChainId() !== 97) throw mixUnavailable();
  const row = (await query<{ onchain_id: string; allocation: Allocation }>(`select s.onchain_id,v.allocation from strategies s
    join strategy_versions v on v.strategy_id=s.id and v.version=1 where s.id=$1 and s.is_personal_mix`, [strategyId])).rows[0];
  if (!row) throw mixUnavailable();
  const block = await client.getBlock({ blockTag: 'latest' });
  const assets = row.allocation.assets.map(a => a.address as Address);
  const allowances = new Map<string, bigint>();
  for (const token of assets.filter(a => !previousAssets.includes(a))) allowances.set(token,
    await client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [m.account, T.contracts.executor], blockNumber: block.number }));
  if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw mixUnavailable();
  return mixOwnerCalls({ account: m.account, registry: chain.registryAddress, executor: T.contracts.executor,
    onchainId: BigInt(row.onchain_id), previousAssets, assets, allowances });
}

export async function mixIntentContext(account: Address): Promise<{ nonce: bigint; fromBlock: bigint }> {
  const chain = getChain(), client = chain.publicClient;
  if (chain.chainId !== 97 || await client.getChainId() !== 97) throw mixUnavailable();
  const header = await client.getBlock({ blockTag: 'latest' });
  const nonce = await client.readContract({ address: T.contracts.entryPoint, abi: entryPoint07Abi, functionName: 'getNonce',
    args: [account, MIX_SUDO_NONCE_KEY], blockNumber: header.number });
  assertMixSudoNonce(nonce);
  if ((await client.getBlock({ blockNumber: header.number })).hash !== header.hash) throw mixUnavailable();
  return { nonce, fromBlock: header.number };
}

/** Exact persisted approval+enroll only. The current nonce is chain authority;
 * neither a fresh body nor a caller-provided spender/amount can replace this intent.
 */
export async function verifyMixOwnerCalls(m: MixRow, intent: MixIntent, calls: readonly { target: Address; value: bigint; callData: Hex }[], nonce: bigint) {
  const chain = getChain(), client = chain.publicClient;
  if (chain.chainId !== 97 || await client.getChainId() !== 97 || calls.length !== intent.owner_calls.length) throw mixUnavailable();
  if (intent.nonce === null || nonce !== BigInt(intent.nonce) || intent.state === 'prepared' && intent.expires_at <= new Date()) throw mixUnavailable();
  const settings = (await query<{ user_allocation: Record<string, number>; exit_assets: Address[]; onchain_id: string }>(`select ms.user_allocation,ms.exit_assets,s.onchain_id
    from mix_strategy_settings ms join strategies s on s.id=ms.strategy_id where ms.mix_id=$1 and ms.strategy_id=$2`, [m.id, intent.strategy_id])).rows[0];
  if (!settings) throw mixUnavailable();
  const previous = intent.from_history_id === null ? [] : (await query<{ allocation: Allocation }>(`select v.allocation from mix_portfolio_history h
    join strategy_versions v on (v.strategy_id,v.version)=(h.strategy_id,h.version) where h.id=$1 and h.mix_id=$2 and h.ended_at is null`, [intent.from_history_id, m.id])).rows[0]?.allocation.assets.map(a => a.address) ?? null;
  if (previous === null) throw mixUnavailable();
  assertMixOwnerCalls({ account: m.account, onchainId: BigInt(settings.onchain_id), previousAssets: previous,
    selectedAssets: Object.keys(settings.user_allocation), stored: intent.owner_calls, calls, nonce, v2: strategyEarnV2For(97, m.owner), owner: m.owner });
  const block = await client.getBlock({ blockTag: 'latest' });
  // Kernel's sudo nonce occupies a distinct key. The SDK packs validator mode in
  // the upper 192 bits, so compare that complete key instead of assuming key=0.
  const key = nonce >> 64n;
  const expected = await client.readContract({ address: T.contracts.entryPoint, abi: entryPoint07Abi, functionName: 'getNonce',
    args: [m.account, key], blockNumber: block.number });
  if (nonce !== expected || (await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw mixUnavailable();
}

type MixProofDeps = { chain?: Pick<ChainConfig, 'publicClient' | 'registryAddress' | 'chainId'>; onchainId?: (strategyId: string) => Promise<string | null> };
export async function readMixEnrollmentProof(m: Pick<MixRow, 'account'>, intent: Pick<MixIntent, 'strategy_id' | 'owner_calls' | 'user_op_hash'> & { nonce?: string | null }, txHash: Hex,
  deps: MixProofDeps = {}): Promise<MixEnrollmentProof> {
  const { publicClient: client, registryAddress, chainId } = deps.chain ?? getChain();
  if (chainId !== 97 || await client.getChainId() !== 97) throw mixUnavailable();
  const onchainId = await (deps.onchainId ?? (async id => (await query<{ onchain_id: string }>('select onchain_id from strategies where id=$1 and is_personal_mix', [id])).rows[0]?.onchain_id ?? null))(intent.strategy_id);
  if (!onchainId) throw mixUnavailable();
  const receipt = await client.getTransactionReceipt({ hash: txHash }), block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (receipt.status !== 'success' || block.hash !== receipt.blockHash) throw mixUnavailable();
  const events = receipt.logs.flatMap(log => {
    if (log.address.toLowerCase() !== registryAddress.toLowerCase() || log.removed || log.logIndex === null) return [];
    try {
      const event = decodeEventLog({ abi: REGISTRY_ABI, data: log.data, topics: log.topics });
      return event.eventName === 'Enrolled' && event.args.account.toLowerCase() === m.account && event.args.id === BigInt(onchainId) && event.args.version === 1 ? [log] : [];
    } catch { return []; }
  });
  const operations = receipt.logs.flatMap(log => {
    if (log.address.toLowerCase() !== T.contracts.entryPoint || log.removed) return [];
    try {
      const event = decodeEventLog({ abi: entryPoint07Abi, data: log.data, topics: log.topics });
      return event.eventName === 'UserOperationEvent' && event.args.sender.toLowerCase() === m.account && event.args.success ? [event] : [];
    } catch { return []; }
  });
  const event = events[0], operation = operations[0];
  if (events.length !== 1 || operations.length !== 1 || !event || !operation || event.logIndex === null || operation.eventName !== 'UserOperationEvent') throw mixUnavailable();
  if (intent.user_op_hash !== null && intent.user_op_hash !== operation.args.userOpHash) throw mixUnavailable();
  const tx = await client.getTransaction({ hash: txHash });
  if (tx.to?.toLowerCase() !== T.contracts.entryPoint || tx.blockHash !== receipt.blockHash) throw mixUnavailable();
  const outer = decodeFunctionData({ abi: entryPoint07Abi, data: tx.input });
  if (outer.functionName !== 'handleOps') throw mixUnavailable();
  const packed = outer.args[0].filter(op => op.sender.toLowerCase() === m.account && op.nonce === operation.args.nonce);
  const original = packed[0];
  if (packed.length !== 1 || !original || original.initCode !== '0x' || packedOperationHash(original, 97) !== operation.args.userOpHash) throw mixUnavailable();
  if (intent.nonce !== undefined && intent.nonce !== null && original.nonce !== BigInt(intent.nonce)) throw mixUnavailable();
  assertMixSudoNonce(original.nonce);
  const exact = canonicalKernelCalls(original.callData);
  if (exact.length !== intent.owner_calls.length || exact.some((call, i) => {
    const saved = intent.owner_calls[i];
    return !saved || saved.value !== '0' || call.value !== 0n || call.target.toLowerCase() !== saved.to.toLowerCase() || call.callData.toLowerCase() !== saved.data.toLowerCase();
  })) throw mixUnavailable();
  const operationLog = receipt.logs.find(log => {
    try { const e = decodeEventLog({ abi: entryPoint07Abi, data: log.data, topics: log.topics });
      return log.address.toLowerCase() === T.contracts.entryPoint && e.eventName === 'UserOperationEvent' && e.args.userOpHash === operation.args.userOpHash;
    } catch { return false; }
  });
  if (!operationLog || operationLog.logIndex === null || event.logIndex >= operationLog.logIndex ||
      receipt.logs.some(log => {
        if (log.logIndex === null || log.logIndex <= event.logIndex || log.logIndex >= operationLog.logIndex || log.address.toLowerCase() !== T.contracts.entryPoint) return false;
        try { return decodeEventLog({ abi: entryPoint07Abi, data: log.data, topics: log.topics }).eventName === 'UserOperationEvent'; } catch { return false; }
      })) throw mixUnavailable();
  const latest = await client.readContract({ address: registryAddress, abi: REGISTRY_ABI, functionName: 'enrollments', args: [m.account] });
  if (latest[0] !== BigInt(onchainId) || latest[1] !== 1) throw mixUnavailable();
  const cashRaw = (await client.readContract({ address: T.contracts.usdt, abi: erc20Abi, functionName: 'balanceOf', args: [m.account], blockNumber: block.number })).toString();
  if ((await client.getBlock({ blockNumber: block.number })).hash !== receipt.blockHash) throw mixUnavailable();
  return { txHash, logIndex: event.logIndex, blockNumber: block.number, blockHash: receipt.blockHash,
    at: new Date(Number(block.timestamp) * 1000), userOpHash: operation.args.userOpHash,
    cashRaw, nonce: original.nonce };
}

/** Reconcile without a client txHash. Complete canonical log scans are required
 * before expiry/cancellation; RPC errors never mean the intent was unused. */
export async function findMixEnrollment(m: Pick<MixRow, 'account'>, intent: Pick<MixIntent, 'strategy_id' | 'owner_calls' | 'user_op_hash' | 'nonce' | 'enroll_from_block'>,
  deps: MixProofDeps & { authorizationUntil?: (hash: Hex, account: Address) => Promise<Date | null> } = {}): Promise<
  { kind: 'confirmed'; proof: MixEnrollmentProof } | { kind: 'absent' } | { kind: 'failed'; code: string }> {
  const chain = deps.chain ?? getChain(), client = chain.publicClient;
  if (chain.chainId !== 97 || await client.getChainId() !== 97 || intent.nonce === null) throw mixUnavailable();
  const onchainId = await (deps.onchainId ?? (async id => (await query<{ onchain_id: string }>('select onchain_id from strategies where id=$1 and is_personal_mix', [id])).rows[0]?.onchain_id ?? null))(intent.strategy_id);
  if (!onchainId) throw mixUnavailable();
  const head = await client.getBlock({ blockTag: 'latest' });
  if (BigInt(intent.enroll_from_block) > head.number) throw mixUnavailable();
  for (let from = BigInt(intent.enroll_from_block); from <= head.number; from += 2000n) {
    const to = from + 1999n < head.number ? from + 1999n : head.number;
    const logs = await client.getLogs({ address: chain.registryAddress, event: REGISTRY_ABI.find(e => e.type === 'event' && e.name === 'Enrolled'),
      args: { account: m.account }, fromBlock: from, toBlock: to, strict: true });
    for (const log of logs) {
      if (log.removed || log.transactionHash === null) throw mixUnavailable();
      const event = decodeEventLog({ abi: REGISTRY_ABI, data: log.data, topics: log.topics });
      if (event.eventName === 'Enrolled' && event.args.id === BigInt(onchainId)) {
        const proof = await readMixEnrollmentProof(m, intent, log.transactionHash, { ...deps, onchainId: async () => onchainId });
        return { kind: 'confirmed', proof };
      }
    }
    if (intent.user_op_hash) {
      const events = await client.getLogs({ address: T.contracts.entryPoint,
        event: entryPoint07Abi.find(e => e.type === 'event' && e.name === 'UserOperationEvent'),
        args: { userOpHash: intent.user_op_hash, sender: m.account }, fromBlock: from, toBlock: to, strict: true });
      for (const log of events) {
        if (log.removed || log.blockNumber === null || log.blockHash === null || log.transactionHash === null) throw mixUnavailable();
        const event = decodeEventLog({ abi: entryPoint07Abi, data: log.data, topics: log.topics });
        const receipt = await client.getTransactionReceipt({ hash: log.transactionHash });
        if ((await client.getBlock({ blockNumber: log.blockNumber })).hash !== log.blockHash || receipt.blockHash !== log.blockHash || receipt.status !== 'success' ||
            !receipt.logs.some(e => !e.removed && e.address.toLowerCase() === T.contracts.entryPoint && e.logIndex === log.logIndex && e.data === log.data && e.topics.join() === log.topics.join())) throw mixUnavailable();
        if (event.eventName !== 'UserOperationEvent' || event.args.nonce !== BigInt(intent.nonce) || event.args.success ||
            event.args.userOpHash !== intent.user_op_hash || event.args.sender.toLowerCase() !== m.account) throw mixUnavailable();
        return { kind: 'failed', code: 'USER_OPERATION_REVERTED' };
      }
    }
  }
  if ((await client.getBlock({ blockNumber: head.number })).hash !== head.hash) throw mixUnavailable();
  if (intent.user_op_hash) {
    const until = await (deps.authorizationUntil ?? (async (hash, account) => (await query<{ valid_until: Date }>(`select valid_until from paymaster_sponsorships where chain_id=97
      and sender=$1 and user_op_hash=$2`, [account, hash])).rows[0]?.valid_until ?? null))(intent.user_op_hash, m.account);
    if (until && BigInt(Math.floor(until.getTime() / 1000)) < head.timestamp) {
      const nonce = await client.readContract({ address: T.contracts.entryPoint, abi: entryPoint07Abi, functionName: 'getNonce',
        args: [m.account, BigInt(intent.nonce) >> 64n], blockNumber: head.number });
      if (nonce < BigInt(intent.nonce) || nonce >> 64n !== BigInt(intent.nonce) >> 64n ||
          (await client.getBlock({ blockNumber: head.number })).hash !== head.hash) throw mixUnavailable();
      return { kind: 'failed', code: 'AUTHORIZATION_EXPIRED' };
    }
  }
  return { kind: 'absent' };
}
