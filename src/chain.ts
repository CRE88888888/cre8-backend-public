import { withRelayerLock } from './relayer-lock.js';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  decodeErrorResult,
  getAddress,
  http,
  keccak256,
  toHex,
  toFunctionSelector,
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { activeChain } from './chain-object.js';
import type { PublicClient, WalletClient, Address, Account, Hex } from 'viem';
import { kernelAddressesForChain } from './addresses.js';
import { getAuthConfig, getConfig, loadSessionKeyConfig } from './config.js';
import { assertKernelInfraDeployed, computeSalt, getKernelAccountParams } from './kernel.js';
import type { KernelAccountOptions } from './kernel.js';
import type { RebalanceSchedule } from './strategies.js';
import type { CanonicalConfig, FundingSchedule } from './strategy-execution.js';
import { numeraireFor } from './strategy-execution.js';
import { AppError } from './errors.js';
import { YIELD_EXECUTOR_ABI } from './yield-abi.js';

/**
 * Chain integration: the backend relayer is the registry operator for enrollment and the provider
 * for strategy registration / version publishing. It is separate from the Safe owner, deployer,
 * and bundler executor; their private keys never enter this process. AtpRegistry is the source of
 * truth for on-chain enrollment state.
 *
 * Every helper fails fast with a clear error when the chain is not configured (no RPC_URL /
 * OPERATOR_PRIVATE_KEY / REGISTRY_ADDRESS), rather than silently skipping the on-chain step.
 */

/** Minimal AtpRegistry ABI: the three write paths this slice drives, plus the events used to read
 *  return values (registerStrategy → id, publishVersion → version) from the receipt. */
export const REGISTRY_ABI = [
  { type: 'function', name: 'numeraire', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'function',
    name: 'registerStrategy',
    inputs: [
      { name: 'name', type: 'string' },
      { name: 'description', type: 'string' },
      { name: 'isPublic', type: 'bool' },
    ],
    outputs: [{ name: 'id', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'publishVersion',
    inputs: [
      { name: 'id', type: 'uint256' },
      { name: 'assets', type: 'address[]' },
      { name: 'weightsBps', type: 'uint16[]' },
      { name: 'scheduleHash', type: 'bytes32' },
      { name: 'activeAt', type: 'uint64' },
    ],
    outputs: [{ name: 'versionNumber', type: 'uint16' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'operator',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'enroll',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'id', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  { type: 'error', name: 'Unauthorized', inputs: [] },
  { type: 'error', name: 'AlreadyEnrolled', inputs: [{ name: 'account', type: 'address' }] },
  { type: 'function', name: 'isEnrolled', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'bool' }] },
  {
    type: 'function', name: 'enrollments', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'strategyId', type: 'uint256' }, { name: 'version', type: 'uint16' }, { name: 'paused', type: 'bool' }],
  },
  { type: 'function', name: 'pauseFlags', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint8' }] },
  {
    type: 'event', name: 'PauseFlagsSet',
    inputs: [{ name: 'account', type: 'address', indexed: true }, { name: 'flags', type: 'uint8', indexed: false }],
  },
  {
    type: 'event',
    name: 'StrategyRegistered',
    inputs: [
      { name: 'id', type: 'uint256', indexed: true },
      { name: 'provider', type: 'address', indexed: true },
      { name: 'name', type: 'string', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'VersionPublished',
    inputs: [
      { name: 'id', type: 'uint256', indexed: true },
      { name: 'version', type: 'uint16', indexed: false },
      { name: 'scheduleHash', type: 'bytes32', indexed: false },
    ],
  },
] as const;

export const REGISTRY_VERSION_ABI = [
  { type: 'function', name: 'activeVersion', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint16' }] },
  { type: 'function', name: 'version', stateMutability: 'view', inputs: [{ type: 'uint256' }, { type: 'uint16' }], outputs: [
    { type: 'tuple', components: [{ name: 'assets', type: 'address[]' }, { name: 'weightsBps', type: 'uint16[]' },
      { name: 'scheduleHash', type: 'bytes32' }, { name: 'activeAt', type: 'uint64' }] },
  ] },
] as const;

export async function readAccountCash(chainId: number, account: Address, suppliedClient?: PublicClient) {
  try {
    const config = getConfig();
    if (!suppliedClient && !config.rpcUrl) throw new Error('missing RPC');
    const client = suppliedClient ?? createPublicClient({ transport: http(config.rpcUrl ?? undefined, { retryCount: 0, timeout: 5_000 }) });
    if (await client.getChainId() !== chainId) throw new Error('wrong chain');
    const block = await client.getBlock({ blockTag: 'latest' });
    if (block.number === null || block.hash === null) throw new Error('missing block');
    const amount = await client.readContract({ address: numeraireFor(chainId) as Address,
      abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
      functionName: 'balanceOf', args: [account], blockNumber: block.number });
    const canonical = await client.getBlock({ blockNumber: block.number });
    if (canonical.hash !== block.hash) throw new Error('block changed');
    return { amountRaw: amount.toString(), blockNumber: block.number.toString(), blockHash: block.hash };
  } catch {
    throw new AppError(503, 'CASH_READ_UNAVAILABLE', 'account cash balance unavailable');
  }
}

/** Read-only, bounded and pinned to one block. No operator key is needed. */
export async function assertVersionOnchain(onchainId: number, version: number,
  expected: Pick<CanonicalConfig, 'chainId' | 'allocation' | 'activeAt'> & { configHash: Hex }, account?: Address,
  deps: { client?: PublicClient; registry?: Address; requireActive?: boolean; blockNumber?: bigint; blockHash?: Hex } = {}): Promise<void> {
  try {
    const config = getConfig();
    const registry = deps.registry ?? config.registryAddress;
    if (!registry || (!deps.client && !config.rpcUrl)) throw new Error('missing chain');
    const client = deps.client ?? createPublicClient({ transport: http(config.rpcUrl ?? undefined, { retryCount: 0, timeout: 5_000 }) });
    if (await client.getChainId() !== expected.chainId) throw new Error('wrong chain');
    const block = await client.getBlock(deps.blockNumber === undefined ? { blockTag: 'latest' } : { blockNumber: deps.blockNumber });
    if (block.number === null || block.hash === null || (deps.blockNumber !== undefined && block.number !== deps.blockNumber)) throw new Error('missing block');
    if (deps.blockHash !== undefined && block.hash !== deps.blockHash) throw new AppError(409, 'FUNDING_REORGED', 'source block changed; reconciliation required');
    const actual = await client.readContract({ address: registry as Address, abi: REGISTRY_VERSION_ABI, functionName: 'version', args: [BigInt(onchainId), version], blockNumber: block.number });
    const pairs = (assets: readonly string[], weights: readonly number[]) => assets.map((asset, index) => `${asset.toLowerCase()}:${weights[index]}`).sort();
    if (actual.scheduleHash.toLowerCase() !== expected.configHash || actual.activeAt !== BigInt(expected.activeAt.getTime() / 1000) ||
        actual.assets.length !== actual.weightsBps.length || JSON.stringify(pairs(actual.assets, actual.weightsBps)) !==
        JSON.stringify(pairs(expected.allocation.assets.map((asset) => asset.address), expected.allocation.assets.map((asset) => asset.weightBps)))) {
      throw new AppError(409, 'CHAIN_CONFIG_MISMATCH', 'chain version does not match the committed config');
    }
    if (deps.requireActive !== false) {
      if (block.timestamp < actual.activeAt) throw new AppError(409, 'VERSION_NOT_ACTIVE', 'version has not reached activeAt');
      if (account === undefined) {
        const active = await client.readContract({ address: registry as Address, abi: REGISTRY_VERSION_ABI, functionName: 'activeVersion', args: [BigInt(onchainId)], blockNumber: block.number });
        if (active !== version) throw new AppError(409, 'CHAIN_VERSION_MISMATCH', 'new enrollment version differs from the selected version');
      }
    }
    if (account !== undefined) {
      const enrolled = await client.readContract({ address: registry as Address, abi: REGISTRY_ABI, functionName: 'isEnrolled', args: [account], blockNumber: block.number });
      const [id, pinned] = await client.readContract({ address: registry as Address, abi: REGISTRY_ABI, functionName: 'enrollments', args: [account], blockNumber: block.number });
      if (!enrolled || id !== BigInt(onchainId) || pinned !== version) throw new AppError(409, 'CHAIN_VERSION_MISMATCH', 'account is not pinned to the authorized version');
    }
    const canonical = await client.getBlock({ blockNumber: block.number });
    if (canonical.hash !== block.hash) throw new AppError(409, 'FUNDING_REORGED', 'version block changed during verification; reconciliation required');
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'VERSION_CHAIN_UNAVAILABLE', 'chain version confirmation unavailable');
  }
}

export const EXECUTOR_PAUSE_ABI = [
  { type: 'function', name: 'globalPaused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'error', name: 'ExecutorPaused', inputs: [] },
] as const;

export const PANCAKE_UR = getAddress('0x1a0a18ac4becddbd6389559687d1a73d8927e416');
export const PANCAKE_DATA_ABI = [{ type: 'bytes' }, { type: 'bytes[]' }] as const;
export const SWAP_STEP_COMPONENTS = [
  { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
  { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' },
  { name: 'venue', type: 'address' }, { name: 'data', type: 'bytes' },
] as const;
export const EXECUTOR_ABI = [
  ...EXECUTOR_PAUSE_ABI,
  { type: 'function', name: 'oracle', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'executeRebalance', stateMutability: 'nonpayable', inputs: [
    { name: 'account', type: 'address' }, { name: 'steps', type: 'tuple[]', components: SWAP_STEP_COMPONENTS },
    { name: 'deadline', type: 'uint256' },
  ], outputs: [] },
  { type: 'function', name: 'venues', stateMutability: 'view', inputs: [{ name: 'target', type: 'address' }],
    outputs: [{ name: 'kind', type: 'uint8' }, { name: 'spender', type: 'address' }] },
  { type: 'event', name: 'VenueSet', inputs: [
    { name: 'target', type: 'address', indexed: true }, { name: 'kind', type: 'uint8', indexed: false },
    { name: 'spender', type: 'address', indexed: false },
  ] },
  ...YIELD_EXECUTOR_ABI,
] as const;
export const EXECUTOR_SELECTOR = toFunctionSelector(EXECUTOR_ABI[3]);
export const YIELD_EXECUTION_SELECTORS: readonly Hex[] = ['executeSupply', 'executeWithdraw'].map(name => {
  const fn = YIELD_EXECUTOR_ABI.find(item => item.type === 'function' && item.name === name);
  if (!fn || fn.type !== 'function') throw new Error('生息 executor ABI 缺少必要函式');
  return toFunctionSelector(fn);
});
export const PLAN_HASH_ABI = [
  { name: 'steps', type: 'tuple[]', components: SWAP_STEP_COMPONENTS }, { name: 'deadline', type: 'uint256' },
] as const;

/** A10 executor buy accounting; values are in numeraire minimal units. */
export const EXECUTOR_BUY_ABI = [
  { type: 'function', name: 'buyAllowance', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'cap', type: 'uint256' }, { name: 'bought', type: 'uint256' }, { name: 'windowEndsAt', type: 'uint64' }] },
  { type: 'function', name: 'maxBuyBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint16' }] },
  { type: 'function', name: 'numeraire', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'error', name: 'BuyLimitExceeded', inputs: [{ name: 'bought', type: 'uint256' }, { name: 'cap', type: 'uint256' }] },
  { type: 'error', name: 'NotNumeraireRoute', inputs: [{ name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }] },
] as const;

export type PauseSource = 'safe' | 'operator' | 'account';

/** A10 registry bits: OWNER=1, OPERATOR=2, ACCOUNT=4. Unknown bits must not look unpaused. */
export function pauseSources(flags: number): PauseSource[] {
  if (!Number.isInteger(flags) || flags < 0 || flags > 7) throw new Error('pauseFlags 不是有效的 A10 暫停來源');
  const sources: PauseSource[] = [];
  if (flags & 1) sources.push('safe');
  if (flags & 2) sources.push('operator');
  if (flags & 4) sources.push('account');
  return sources;
}

export async function readGlobalPaused(executor: Address, client: PublicClient): Promise<boolean> {
  return client.readContract({ address: executor, abi: EXECUTOR_PAUSE_ABI, functionName: 'globalPaused' });
}

export const PLATFORM_STATUS_CACHE_TTL_MS = 10_000;
export const PLATFORM_STATUS_RPC_TIMEOUT_MS = 5_000;

export type PlatformStatus = {
  chainId: number;
  executor: Address | null;
  registry: Address | null;
  globalPaused: boolean | null;
  maxBuyBps: number | null;
  /** ISO observation time; unchanged on cache hits. */
  checkedAt: string;
  /** Decimal string, so block heights never lose precision in JSON. */
  block: string | null;
};

export type PlatformStatusConfig = {
  chainId: number;
  executor: Address | null;
  registry: Address | null;
  rpcUrl: string | null;
};

function platformStatusConfig(): PlatformStatusConfig {
  const config = getConfig();
  let executor: Address | null = null;
  try {
    // This public read needs no signing key or seed, including their parsers.
    executor = loadSessionKeyConfig({ EXECUTOR_ADDRESS: process.env.EXECUTOR_ADDRESS, CHAIN_ID: String(config.chainId) }).executorAddress;
  } catch {
    // An invalid executor is unavailable, never an unpaused platform.
  }
  return {
    chainId: config.chainId,
    executor,
    registry: config.registryAddress === null ? null : getAddress(config.registryAddress),
    rpcUrl: config.rpcUrl,
  };
}

/** Public, read-only snapshot. Cache failures too, and share concurrent RPC work across visitors. */
export function createPlatformStatusReader(deps: {
  config?: () => PlatformStatusConfig;
  publicClient?: PublicClient;
  now?: () => number;
} = {}): () => Promise<PlatformStatus> {
  // Monotonic epoch milliseconds keep clock corrections from extending the public cache TTL.
  const now = deps.now ?? (() => performance.timeOrigin + performance.now());
  let cached: { startedAt: number; value: PlatformStatus } | null = null;
  let pending: Promise<PlatformStatus> | null = null;

  const read = async (startedAt: number): Promise<PlatformStatus> => {
    const unavailable: PlatformStatus = {
      chainId: getAuthConfig().chainId,
      executor: null,
      registry: null,
      globalPaused: null,
      maxBuyBps: null,
      checkedAt: new Date(startedAt).toISOString(),
      block: null,
    };
    try {
      const config = (deps.config ?? platformStatusConfig)();
      Object.assign(unavailable, { chainId: config.chainId, executor: config.executor, registry: config.registry });
      if (!config.rpcUrl || !config.executor || !config.registry ||
          config.executor === zeroAddress || config.registry === zeroAddress) return unavailable;
      const client = deps.publicClient ?? createPublicClient({
        transport: http(config.rpcUrl, { timeout: PLATFORM_STATUS_RPC_TIMEOUT_MS, retryCount: 0 }),
      });
      const [chainId, block] = await Promise.all([
        client.getChainId(),
        client.getBlockNumber({ cacheTime: 0 }),
      ]);
      if (chainId !== config.chainId || typeof block !== 'bigint' || block < 0n) return unavailable;
      const [globalPaused, maxBuyBps] = await Promise.all([
        client.readContract({ address: config.executor, abi: EXECUTOR_PAUSE_ABI, functionName: 'globalPaused', blockNumber: block }),
        client.readContract({ address: config.executor, abi: EXECUTOR_BUY_ABI, functionName: 'maxBuyBps', blockNumber: block }),
      ]);
      if (typeof globalPaused !== 'boolean' || !Number.isInteger(maxBuyBps) || maxBuyBps < 0 || maxBuyBps > 65_535) return unavailable;
      return { ...unavailable, globalPaused, maxBuyBps, block: block.toString() };
    } catch {
      // No raw RPC/config error reaches the public response or logs.
      return unavailable;
    }
  };

  return () => {
    const startedAt = now();
    // Count TTL from the start of the observation, not the end of a slow RPC call.
    if (cached !== null && startedAt >= cached.startedAt && startedAt - cached.startedAt < PLATFORM_STATUS_CACHE_TTL_MS) {
      return Promise.resolve(cached.value);
    }
    if (pending !== null) return pending;
    pending = read(startedAt).then((value) => {
      cached = { startedAt, value };
      return value;
    }).finally(() => { pending = null; });
    return pending;
  };
}

/** Decode structured viem/RPC causes only; never echo an RPC URL, calldata or credentials. */
export function a10ErrorMessage(error: unknown): string | null {
  const messages = {
    ExecutorPaused: 'ExecutorPaused：Safe 已開啟全域暫停，所有再平衡（含賣出）停止；使用者可用錢包直接提領',
    BuyLimitExceeded: 'BuyLimitExceeded：帳戶本窗口的買入額度不足，需重新讀取額度並等待窗口結束；賣出不受買入額度限制',
    NotNumeraireRoute: 'NotNumeraireRoute：買入必須以 executor.numeraire 付款；不允許非計價資產直接互換',
    AlreadyEnrolled: 'AlreadyEnrolled：帳戶已 enroll，策略或版本只能由使用者簽署變更；operator 不會重新 enroll 或清除暫停',
  };
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 12 && typeof current === 'object' && current !== null && !seen.has(current); depth += 1) {
    seen.add(current);
    const data = 'data' in current ? current.data : undefined;
    let name: unknown = typeof data === 'object' && data !== null && 'errorName' in data ? data.errorName : undefined;
    if (typeof data === 'string' && /^0x[0-9a-fA-F]+$/.test(data)) {
      try { name = decodeErrorResult({ abi: [...REGISTRY_ABI, ...EXECUTOR_PAUSE_ABI, ...EXECUTOR_BUY_ABI], data: data as Hex }).errorName; } catch { /* not an A10 revert */ }
    }
    if (name === 'ExecutorPaused' || name === 'AlreadyEnrolled' || name === 'BuyLimitExceeded' || name === 'NotNumeraireRoute') return messages[name];
    current = 'cause' in current ? current.cause : undefined;
  }
  return null;
}

export type ChainConfig = {
  chainId: number;
  rpcUrl: string;
  registryAddress: Address;
  account: Account;
  wallet: WalletClient;
  publicClient: PublicClient;
  /** Kernel v3.3 canonical addresses for `chainId` (throws while resolving an unsupported chain). */
  kernel: ReturnType<typeof kernelAddressesForChain>;
};

let cached: ChainConfig | null = null;

/** Resolve the chain config or throw. Lazy + cached, like getConfig()/getPool(). */
export function getChain(): ChainConfig {
  if (cached) return cached;

  const config = getConfig();
  if (!config.rpcUrl) {
    throw new Error('chain is not configured: RPC_URL is required for on-chain operations');
  }
  if (!config.operatorPrivateKey) {
    throw new Error('chain is not configured: OPERATOR_PRIVATE_KEY is required for on-chain operations');
  }
  if (!config.registryAddress) {
    throw new Error('chain is not configured: REGISTRY_ADDRESS is required for on-chain operations');
  }

  const account = privateKeyToAccount(ensureHex(config.operatorPrivateKey));
  const publicClient = createPublicClient({ chain: activeChain(), transport: http(config.rpcUrl) });
  const wallet = createWalletClient({ chain: activeChain(), transport: http(config.rpcUrl), account });

  cached = {
    chainId: config.chainId,
    rpcUrl: config.rpcUrl,
    registryAddress: config.registryAddress as Address,
    account,
    wallet,
    publicClient,
    kernel: kernelAddressesForChain(config.chainId),
  };
  return cached;
}

/** Reset the cached chain config (tests re-point the clients between runs). */
export function resetChain(): void {
  cached = null;
}

/** Whether the chain is configured (all three env vars set). */
export function isChainConfigured(): boolean {
  const config = getConfig();
  return config.rpcUrl !== null && config.operatorPrivateKey !== null && config.registryAddress !== null;
}

/**
 * Register a strategy on the AtpRegistry and return its on-chain id (decoded from the
 * StrategyRegistered event, so it is race-free even if another registration lands first).
 */
export async function registerStrategyOnchain(meta: {
  name: string;
  description: string;
  isPublic: boolean;
}): Promise<number> {
  const { wallet, publicClient, registryAddress, account: operator } = getChain();

  const hash = await withRelayerLock(getConfig().chainId, () => wallet.writeContract({
    account: operator,
    chain: activeChain(),
    address: registryAddress,
    abi: REGISTRY_ABI,
    functionName: 'registerStrategy',
    args: [meta.name, meta.description, meta.isPublic],
  }));
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  return decodeReturnedId(receipt.logs, 'StrategyRegistered', 'id');
}

/**
 * Publish an allocation version on the AtpRegistry and return its on-chain version number.
 * `scheduleHash` is a deterministic keccak256 over a canonical schedule encoding; `activeAt` is
 * Unix seconds.
 */
export async function publishVersionOnchain(
  onchainId: number,
  version: {
    assets: Address[];
    weightsBps: number[];
    schedule: RebalanceSchedule | FundingSchedule;
    activeAt: Date;
    configHash?: Hex;
    expectedVersion?: number;
    /** False on a stored-config retry: unknown submissions must be reconciled, never re-broadcast. */
    allowPublish?: boolean;
  },
  deps: { chain?: ChainConfig; lock?: typeof withRelayerLock } = {},
): Promise<number> {
  const chainConfig = deps.chain ?? getChain();
  const { wallet, publicClient, registryAddress, account: operator } = chainConfig;

  if (version.configHash !== undefined && version.expectedVersion !== undefined) {
    const expectedVersion = version.expectedVersion;
    const configHash = version.configHash;
    return (deps.lock ?? withRelayerLock)(chainConfig.chainId, async (assertHeld) => {
      try {
        const latest = await publicClient.readContract({ address: registryAddress, abi: REGISTRY_VERSION_ABI, functionName: 'activeVersion', args: [BigInt(onchainId)] });
        if (latest < expectedVersion) {
          if (version.allowPublish === false) throw new AppError(503, 'VERSION_PENDING_RECONCILIATION', 'stored version is not confirmed on chain; no new publish transaction sent');
          if (latest + 1 !== expectedVersion) throw new Error('version sequence mismatch');
          assertHeld();
          const hash = await wallet.writeContract({ account: operator, chain: activeChain(), address: registryAddress, abi: REGISTRY_ABI,
            functionName: 'publishVersion', args: [BigInt(onchainId), version.assets, version.weightsBps, configHash, BigInt(version.activeAt.getTime() / 1000)] });
          const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
          if (receipt.status !== 'success' || decodeReturnedId(receipt.logs, 'VersionPublished', 'version') !== expectedVersion) throw new Error('publish not confirmed');
        }
        // A retry after an unknown receipt verifies the original index instead of publishing again.
        await assertVersionOnchain(onchainId, expectedVersion, { chainId: chainConfig.chainId,
          allocation: { assets: version.assets.map((address, index) => ({ address, weightBps: version.weightsBps[index] ?? 0 })) },
          activeAt: version.activeAt, configHash }, undefined,
          { client: publicClient, registry: registryAddress, requireActive: false });
        return expectedVersion;
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(503, 'VERSION_PUBLISH_UNAVAILABLE', 'version mirror is not confirmed; retry the same config');
      }
    });
  }
  if (version.schedule.kind === 'funding') throw new AppError(400, 'CONFIG_HASH_REQUIRED', 'funding schedule requires a canonical config hash');
  const scheduleHash = canonicalScheduleHash(version.schedule);

  const hash = await withRelayerLock(getConfig().chainId, () => wallet.writeContract({
    account: operator,
    chain: activeChain(),
    address: registryAddress,
    abi: REGISTRY_ABI,
    functionName: 'publishVersion',
    args: [
      BigInt(onchainId),
      version.assets,
      version.weightsBps,
      scheduleHash,
      BigInt(Math.floor(version.activeAt.getTime() / 1000)),
    ],
  }));
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  return decodeReturnedId(receipt.logs, 'VersionPublished', 'version');
}

/** First enrollment only. Same-strategy retries preserve the chain's version and pause sources. */
export async function enrollOnchain(account: Address, onchainId: number, chain?: ChainConfig): Promise<number> {
  const { wallet, publicClient, registryAddress, account: operator } = chain ?? getChain();

  try {
    const readEnrollment = async (blockNumber: bigint): Promise<number | null> => {
      const [enrolled, enrollment] = await Promise.all([
        publicClient.readContract({ address: registryAddress, abi: REGISTRY_ABI, functionName: 'isEnrolled', args: [account], blockNumber }),
        publicClient.readContract({ address: registryAddress, abi: REGISTRY_ABI, functionName: 'enrollments', args: [account], blockNumber }),
      ]);
      const [strategyId, version, paused] = enrollment;
      if (!enrolled && strategyId === 0n && version === 0 && paused === false) return null;
      if (!enrolled || strategyId <= 0n || !Number.isInteger(version) || version < 1 || version > 65535) {
        throw new AppError(503, 'ENROLLMENT_INCONSISTENT', 'enrollment 與 isEnrolled 不一致：拒絕送出 enroll');
      }
      if (strategyId !== BigInt(onchainId)) {
        throw new AppError(409, 'ALREADY_ENROLLED', `AlreadyEnrolled：帳戶已加入策略 ${strategyId}，策略或版本只能由使用者簽署變更；operator 不送交易`);
      }
      return version;
    };
    const version = await readEnrollment(await publicClient.getBlockNumber({ cacheTime: 0 }));
    if (version !== null) return version;

    // ATP v2 does not grant the owner enrollment rights. Read on every attempt so a revoked or
    // rotated operator fails before a transaction is submitted, even with a cached ChainConfig.
    const registryOperator = await publicClient.readContract({
      address: registryAddress,
      abi: REGISTRY_ABI,
      functionName: 'operator',
    });
    if (registryOperator.toLowerCase() !== operator.address.toLowerCase()) {
      throw new AppError(503, 'OPERATOR_MISMATCH',
        `enroll operator mismatch: signer ${operator.address}, registry.operator() ${registryOperator}; ` +
          '需由 owner 呼叫 setOperator 將 registry operator 設為 signer 地址',
      );
    }

    const hash = await withRelayerLock(getConfig().chainId, () => wallet.writeContract({
      account: operator,
      chain: activeChain(),
      address: registryAddress,
      abi: REGISTRY_ABI,
      functionName: 'enroll',
      args: [account, BigInt(onchainId)],
    }));
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new AppError(502, 'ENROLL_REVERTED', 'enroll transaction reverted：未完成 enrollment');
    const enrolledVersion = await readEnrollment(receipt.blockNumber);
    if (enrolledVersion === null) throw new AppError(503, 'ENROLLMENT_MISSING', 'enroll receipt 成功但 enrollment 缺漏：拒絕回報成功');
    return enrolledVersion;
  } catch (error) {
    if (error instanceof AppError) throw error;
    const message = a10ErrorMessage(error);
    if (message !== null) throw new AppError(409, 'ALREADY_ENROLLED', message);
    throw new AppError(503, 'ENROLL_UNAVAILABLE', 'enroll 無法完成確認：鏈上狀態、RPC 或交易回執不可用，請稍後重試');
  }
}

/**
 * `deploySmartAccount` 的選配。
 *
 * 第三個參數從 `ChainConfig` 改成這包物件，是為了讓「帳戶上要裝什麼」擠得進來：`plugins` 決定誰簽，
 * `initConfig` 決定權限有沒有安裝。production 兩者必須一起給（見 src/kernel.ts 的說明）：
 * 只給 `plugins` 會得到「有 validator、但權限沒安裝」的帳戶，而且地址不變、不會有任何錯誤提示。
 */
export type DeploySmartAccountOptions = {
  /** 測試注入用；production 走 `getChain()`。 */
  chain?: ChainConfig;
  /** sudo（owner 的 ECDSA）＋ regular（session key 的 permission validator）。不給 = 只有 owner 的 sudo。 */
  plugins?: KernelAccountOptions['plugins'];
  /** 隨帳戶建立一起安裝的權限 calldata：**唯一**會改變 counterfactual 地址的東西。 */
  initConfig?: Hex[];
};

/**
 * Resolve the caller's Kernel v3.3 counterfactual account, deploying it if the chain has no code
 * there yet. One account per (owner, strategyId): `computeSalt` bakes strategyId into the salt, so
 * the address is a pure function of the pair and a redeploy is impossible.
 *
 * `options.chain` is an injection seam for unit tests; production always uses getChain().
 */
export async function deploySmartAccount(
  owner: Address,
  strategyId: bigint,
  options: DeploySmartAccountOptions = {},
): Promise<{ address: Address; deployed: boolean }> {
  const chain = options.chain ?? getChain();
  const { publicClient, wallet, account: operator } = chain;

  // Fail fast when EntryPoint / MetaFactory are missing: computing the address would revert opaquely.
  await assertKernelInfraDeployed(publicClient);

  // One SDK call yields the address and the deployment bytes, so the address is derived from exactly
  // the calldata that is about to be sent (a second derivation could silently disagree). `initConfig`
  // is part of that derivation: with it the new account also installs the session-key permissions,
  // which is why such an account has a different (and correct) address.
  const salt = computeSalt(owner, strategyId);
  const { address, factory, factoryData } = await getKernelAccountParams(publicClient, owner, salt, {
    plugins: options.plugins,
    initConfig: options.initConfig,
  });

  const code = await publicClient.getCode({ address });
  if (code !== undefined && code !== '0x') return { address, deployed: false };

  // factoryData is the MetaFactory `deployWithFactory(KernelFactory, initData, salt)` calldata, built
  // by the SDK; getKernelAccountParams has already refused anything but the MetaFactory.
  const hash = await withRelayerLock(getConfig().chainId, () => wallet.sendTransaction({ account: operator, chain: activeChain(), to: factory, data: factoryData }));
  await publicClient.waitForTransactionReceipt({ hash });

  return { address, deployed: true };
}

/**
 * 某個地址的 BNB 餘額（wei）。對 smart account 而言這就是 UserOp 的 gas 預付餘額 —— gas 由
 * `sender` 付，不是簽名的 session key 付（見 docs/pitfalls.zh-TW.md §3.10）。
 *
 * `chain` 是單元測試注入用的接縫：production 一律走 `getChain()`，形狀與
 * `deploySmartAccount` 的 `options.chain` 相同。
 */
export async function getAccountGasBalance(address: Address, chain?: ChainConfig): Promise<bigint> {
  const { publicClient } = chain ?? getChain();
  return publicClient.getBalance({ address });
}

/**
 * 當前有效 gas price（wei），用來估「這筆餘額還能跑幾次 op」。
 *
 * 不在這裡吞錯誤：取不到 gas price 的處理方式取決於呼叫端（enroll 選擇讓整包成功、gas 狀態留白，
 * 腳本選擇直接失敗），所以這裡失敗就拋。
 */
export async function getGasPriceWei(chain?: ChainConfig): Promise<bigint> {
  const { publicClient } = chain ?? getChain();
  return publicClient.getGasPrice();
}

/** Deterministic keccak256 of a canonical schedule string, mirroring what a keeper would read. */
export function canonicalScheduleHash(schedule: RebalanceSchedule): `0x${string}` {
  const canonical =
    schedule.kind === 'interval' ? `interval:${schedule.intervalSeconds}` : `cron:${schedule.cron}`;
  return keccak256(toHex(canonical));
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function ensureHex(key: string): `0x${string}` {
  return key.startsWith('0x') ? (key as `0x${string}`) : (`0x${key}` as `0x${string}`);
}

/** Find the first matching event among a receipt's logs and return one numeric arg, or throw. */
function decodeReturnedId(
  logs: readonly { address: `0x${string}`; data: `0x${string}`; topics: readonly `0x${string}`[] }[],
  eventName: string,
  field: string,
): number {
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: REGISTRY_ABI,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      if (decoded.eventName === eventName) {
        const value = (decoded.args as Record<string, unknown>)[field];
        if (typeof value === 'bigint') return Number(value);
        if (typeof value === 'number') return value;
        throw new Error(`${eventName} event missing numeric field ${field}`);
      }
    } catch {
      // not this event; keep scanning
    }
  }
  throw new Error(`${eventName} event not found in receipt logs`);
}

/** #52: shared router/push-feed ABI, including errors that bubble through executor/EntryPoint. */
export const PRICE_SOURCE_ABI = [
  { type: 'error', name: 'TwapUnavailable', inputs: [] },
  { type: 'error', name: 'FailedOpWithRevert', inputs: [{ name: 'opIndex', type: 'uint256' }, { name: 'reason', type: 'string' }, { name: 'inner', type: 'bytes' }] },
  { type: 'error', name: 'StaleFeed', inputs: [{ name: 'feed', type: 'address' }, { name: 'updatedAt', type: 'uint256' }] },
  { type: 'error', name: 'InvalidAnswer', inputs: [{ name: 'feed', type: 'address' }, { name: 'answer', type: 'int256' }] },
  { type: 'error', name: 'SourcesDisagree', inputs: [{ name: 'asset', type: 'address' }, { name: 'poolQuote', type: 'uint256' }, { name: 'secondaryQuote', type: 'uint256' }] },
  { type: 'function', name: 'secondaryOf', stateMutability: 'view', inputs: [{ name: 'asset', type: 'address' }], outputs: [{ name: 'source', type: 'address' }, { name: 'maxDeviationBps', type: 'uint16' }] },
  { type: 'function', name: 'assetFeed', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'numeraireFeed', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'maxAge', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint32' }] },
  { type: 'function', name: 'numeraireMaxAge', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint32' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'latestRoundData', stateMutability: 'view', inputs: [], outputs: [
    { type: 'uint80' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint80' },
  ] },
  { type: 'function', name: 'numeraire', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'previewSwap', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }, { type: 'uint256' }] },
] as const;

export type PriceSourceFailure = { code: 'TwapUnavailable' | 'StaleFeed' | 'InvalidAnswer' | 'SourcesDisagree'; detail: string; asset?: Address; feed?: Address };

/** Shared by ABI failures and the snapshot's typed TWAP pricing failure. Never log raw metadata. */
export function oracleUnavailableTag(asset?: Address, symbol?: string): string {
  const label = symbol !== undefined && /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(symbol) ? symbol : asset ?? 'UNKNOWN';
  return `[ORACLE_UNAVAILABLE:${label}]`;
}

/** Only ABI data is trusted. Message text, URLs and arbitrary errorName strings never reach users. */
export function decodePriceSourceError(error: unknown, context: { asset?: Address; symbol?: string; timestamp?: bigint; maxAge?: number } = {}): PriceSourceFailure | null {
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  for (let depth = 0; depth < 128 && pending.length > 0; depth += 1) {
    const current = pending.shift();
    if (typeof current !== 'object' || current === null || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof PriceSourceError) return current.failure;
    const data: unknown = Reflect.get(current, 'data');
    let name: unknown = Reflect.get(current, 'errorName');
    let args: unknown = Reflect.get(current, 'args');
    if (typeof data === 'string' && /^0x[0-9a-fA-F]+$/.test(data)) {
      try {
        const decoded = decodeErrorResult({ abi: PRICE_SOURCE_ABI, data: data as Hex });
        name = decoded.errorName; args = decoded.args;
      } catch { /* an unrelated revert */ }
    }
    if (name === 'FailedOpWithRevert' && Array.isArray(args) && typeof args[2] === 'string') pending.push({ data: args[2] });
    if (name === 'TwapUnavailable' && (args === undefined || (Array.isArray(args) && args.length === 0))) {
      return { code: name, ...(context.asset === undefined ? {} : { asset: context.asset }),
        detail: `${oracleUnavailableTag(context.asset, context.symbol)} TwapUnavailable：池子閒置或觀測歷史不足，普通再平衡整批不送、下一輪重試；退出保留未售資產` };
    }
    const uint = (value: unknown): value is bigint => typeof value === 'bigint' && value >= 0n && value < (1n << 256n);
    const address = (value: unknown): value is Address => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
    if (Array.isArray(args) && address(args[0])) {
      const label = context.asset === undefined ? '' : `資產 ${context.asset}：`;
      if (name === 'StaleFeed' && uint(args[1])) {
        const at = args[1];
        const age = context.timestamp === undefined ? '鏈上時間未知，年齡無法確認'
          : at === 0n ? 'updatedAt=0（缺少更新）'
          : at > context.timestamp ? `updatedAt 在未來 ${at - context.timestamp} 秒`
          : `年齡 ${context.timestamp - at} 秒${context.maxAge === undefined ? '' : `，上限 ${context.maxAge} 秒，超時 ${context.timestamp - at > BigInt(context.maxAge) ? context.timestamp - at - BigInt(context.maxAge) : 0n} 秒`}`;
        return { code: name, feed: args[0], ...(context.asset === undefined ? {} : { asset: context.asset }), detail: `${label}StaleFeed：secondary push feed ${args[0]}，updatedAt=${at}；${age}，本輪不交易此資產` };
      }
      if (name === 'InvalidAnswer' && typeof args[1] === 'bigint' && args[1] <= 0n && args[1] >= -(1n << 255n)) {
        return { code: name, feed: args[0], ...(context.asset === undefined ? {} : { asset: context.asset }), detail: `${label}InvalidAnswer：secondary push feed ${args[0]} 回傳 ${args[1]}（必須 > 0），本輪不交易此資產` };
      }
      if (name === 'SourcesDisagree' && uint(args[1]) && uint(args[2])) {
        const gap = args[1] > args[2] ? args[1] - args[2] : args[2] - args[1];
        return { code: name, asset: args[0], detail: `資產 ${args[0]}：SourcesDisagree：Pancake TWAP=${args[1]}，secondary=${args[2]}，差距 ${args[2] === 0n ? '無法計算（secondary=0）' : `${gap * 10000n / args[2]} bps`}，本輪不交易此資產` };
      }
    }
    pending.push(data, Reflect.get(current, 'cause'), Reflect.get(current, 'error'), Reflect.get(current, 'originalError'));
  }
  return null;
}

export class PriceSourceError extends Error {
  constructor(readonly failure: PriceSourceFailure) { super(failure.detail); this.name = 'PriceSourceError'; }
}

/** Enrich only a recognized revert, with the chain clock at the same observation block. */
export async function describePriceSourceError(error: unknown, client: PublicClient, context: {
  oracle: Address; blockNumber?: bigint; asset?: Address; tokenIn?: Address; tokenOut?: Address; assets?: readonly Address[];
}): Promise<PriceSourceFailure | null> {
  const decoded = decodePriceSourceError(error);
  if (decoded === null) return null;
  let asset = context.asset ?? decoded.asset;
  let timestamp: bigint | undefined;
  let maxAge: number | undefined;
  let symbol: string | undefined;
  try {
    const block = await client.getBlock(context.blockNumber === undefined ? { blockTag: 'latest' } : { blockNumber: context.blockNumber });
    timestamp = block.timestamp;
    const blockNumber = block.number ?? context.blockNumber;
    if (asset === undefined && context.tokenIn !== undefined && context.tokenOut !== undefined) {
      const numeraire = await client.readContract({ address: context.oracle, abi: PRICE_SOURCE_ABI, functionName: 'numeraire', blockNumber });
      asset = context.tokenIn.toLowerCase() === numeraire.toLowerCase() ? context.tokenOut : context.tokenIn;
    }
    if (asset === undefined && context.assets !== undefined && blockNumber !== undefined) {
      const numeraireForError = decoded.code === 'TwapUnavailable'
        ? await client.readContract({ address: context.oracle, abi: PRICE_SOURCE_ABI, functionName: 'numeraire', blockNumber }) : undefined;
      for (const candidate of new Map(context.assets.map((value) => [value.toLowerCase(), value])).values()) {
        if (candidate.toLowerCase() === numeraireForError?.toLowerCase()) continue;
        try {
          if (decoded.code === 'TwapUnavailable') {
            const decimals = await client.readContract({ address: candidate, abi: PRICE_SOURCE_ABI, functionName: 'decimals', blockNumber });
            if (decimals <= 36 && numeraireForError !== undefined) {
              await client.readContract({ address: context.oracle, abi: PRICE_SOURCE_ABI, functionName: 'previewSwap', args: [candidate, numeraireForError, 10n ** BigInt(decimals)], blockNumber });
            }
          } else {
            const health = await readSecondaryHealth(client, context.oracle, candidate, { number: blockNumber, timestamp: block.timestamp });
            if (health.feeds.some((feed) => feed.feed.toLowerCase() === decoded.feed?.toLowerCase())) { asset = candidate; break; }
          }
        } catch (cause) {
          if (decoded.code === 'TwapUnavailable' && decodePriceSourceError(cause)?.code === 'TwapUnavailable') { asset = candidate; break; }
        }
      }
    }
    if (asset !== undefined) {
      if (decoded.code === 'TwapUnavailable') {
        symbol = await client.readContract({ address: asset, abi: PRICE_SOURCE_ABI, functionName: 'symbol', blockNumber });
      } else if (decoded.code === 'StaleFeed') {
        const [source] = await client.readContract({ address: context.oracle, abi: PRICE_SOURCE_ABI, functionName: 'secondaryOf', args: [asset], blockNumber });
        if (source !== zeroAddress) {
          const numeraireFeed = await client.readContract({ address: source, abi: PRICE_SOURCE_ABI, functionName: 'numeraireFeed', blockNumber });
          const ageFunction = numeraireFeed.toLowerCase() === decoded.feed?.toLowerCase() ? 'numeraireMaxAge' : 'maxAge';
          maxAge = await client.readContract({ address: source, abi: PRICE_SOURCE_ABI,
            functionName: ageFunction, blockNumber });
        }
      }
    }
  } catch { /* keep the decoded cause; unavailable metadata is never invented */ }
  return decodePriceSourceError(error, { ...(asset === undefined ? {} : { asset }),
    ...(symbol === undefined ? {} : { symbol }),
    ...(timestamp === undefined ? {} : { timestamp }), ...(maxAge === undefined ? {} : { maxAge }) });
}

export type SecondaryFeedHealth = { role: 'asset/USD' | 'numeraire/USD'; feed: Address; updatedAt: bigint; age: bigint; failure: PriceSourceFailure | null };
export type SecondaryHealth = { asset: Address; source: Address; maxAge: number | null; numeraireMaxAge: number | null; maxDeviationBps: number; feeds: SecondaryFeedHealth[] };

/** Two feeds at one pinned block. Missing RPC/ABI data throws; it is never a healthy/absent source. */
export async function readSecondaryHealth(client: PublicClient, oracle: Address, asset: Address, block: { number: bigint; timestamp: bigint }): Promise<SecondaryHealth> {
  const [source, maxDeviationBps] = await client.readContract({ address: oracle, abi: PRICE_SOURCE_ABI, functionName: 'secondaryOf', args: [asset], blockNumber: block.number });
  if (source === zeroAddress) return { asset, source, maxAge: null, numeraireMaxAge: null, maxDeviationBps, feeds: [] };
  const [assetFeed, numeraireFeed, maxAge, numeraireMaxAge] = await Promise.all([
    client.readContract({ address: source, abi: PRICE_SOURCE_ABI, functionName: 'assetFeed', blockNumber: block.number }),
    client.readContract({ address: source, abi: PRICE_SOURCE_ABI, functionName: 'numeraireFeed', blockNumber: block.number }),
    client.readContract({ address: source, abi: PRICE_SOURCE_ABI, functionName: 'maxAge', blockNumber: block.number }),
    client.readContract({ address: source, abi: PRICE_SOURCE_ABI, functionName: 'numeraireMaxAge', blockNumber: block.number }),
  ]);
  if (maxAge < 60 || maxAge > 86400 || numeraireMaxAge < 60 || numeraireMaxAge > 86400 || assetFeed === zeroAddress || numeraireFeed === zeroAddress) throw new Error('secondary metadata invalid');
  const feeds: SecondaryFeedHealth[] = [];
  for (const [role, feed, feedMaxAge] of [['asset/USD', assetFeed, maxAge], ['numeraire/USD', numeraireFeed, numeraireMaxAge]] as const) {
    const [, answer, , updatedAt] = await client.readContract({ address: feed, abi: PRICE_SOURCE_ABI, functionName: 'latestRoundData', blockNumber: block.number });
    const code = answer <= 0n ? 'InvalidAnswer' : updatedAt === 0n || updatedAt > block.timestamp || block.timestamp - updatedAt > BigInt(feedMaxAge) ? 'StaleFeed' : null;
    const failure = code === null ? null : decodePriceSourceError({ errorName: code, args: [feed, code === 'InvalidAnswer' ? answer : updatedAt] }, { asset, timestamp: block.timestamp, maxAge: feedMaxAge });
    feeds.push({ role, feed, updatedAt, age: block.timestamp - updatedAt, failure });
  }
  return { asset, source, maxAge, numeraireMaxAge, maxDeviationBps, feeds };
}

export type PriceSourceObservation = { asset: Address; verified: boolean; failure: PriceSourceFailure | null };

export async function inspectPriceSources(client: PublicClient, oracle: Address, assets: readonly Address[]): Promise<PriceSourceObservation[]> {
  const block = await client.getBlock({ blockTag: 'latest' });
  if (block.number === null) throw new Error('price source block unavailable');
  const blockNumber = block.number;
  const numeraire = await client.readContract({ address: oracle, abi: PRICE_SOURCE_ABI, functionName: 'numeraire', blockNumber });
  const observations: PriceSourceObservation[] = [];
  for (const asset of new Map(assets.map((value) => [value.toLowerCase(), value])).values()) {
    if (asset.toLowerCase() === numeraire.toLowerCase()) continue;
    try {
      // TWAP freshness/cardinality applies even when no secondary feed is configured.
      const decimals = await client.readContract({ address: asset, abi: PRICE_SOURCE_ABI, functionName: 'decimals', blockNumber });
      if (decimals > 36) throw new Error('invalid asset decimals');
      const [quoted, minimum] = await client.readContract({ address: oracle, abi: PRICE_SOURCE_ABI, functionName: 'previewSwap', args: [asset, numeraire, 10n ** BigInt(decimals)], blockNumber });
      if (quoted <= 0n || minimum <= 0n) throw new Error('price source quote incomplete');
      const health = await readSecondaryHealth(client, oracle, asset, { number: blockNumber, timestamp: block.timestamp });
      const failure = health.feeds.find((feed) => feed.failure !== null)?.failure;
      if (failure) { observations.push({ asset, verified: true, failure }); continue; }
      observations.push({ asset, verified: true, failure: null });
    } catch (error) {
      const failure = await describePriceSourceError(error, client, { oracle, asset, blockNumber });
      observations.push({ asset, verified: failure !== null, failure });
    }
  }
  return observations;
}
