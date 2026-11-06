import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  keccak256,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';
import type { PublicClient, WalletClient, Address, Account } from 'viem';
import { getConfig } from './config.js';
import type { RebalanceSchedule } from './strategies.js';

/**
 * Chain integration: the backend acts as a relayer. One operator key signs every on-chain
 * transaction (v1 trust model; user-signed meta-transactions are a later refinement), and the
 * AtpRegistry is the source of truth for on-chain enrollment state.
 *
 * Every helper fails fast with a clear error when the chain is not configured (no RPC_URL /
 * OPERATOR_PRIVATE_KEY / REGISTRY_ADDRESS), rather than silently skipping the on-chain step.
 */

/** Minimal AtpRegistry ABI: the three write paths this slice drives, plus the events used to read
 *  return values (registerStrategy → id, publishVersion → version) from the receipt. */
const REGISTRY_ABI = [
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
    name: 'enroll',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'id', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
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

export type ChainConfig = {
  rpcUrl: string;
  registryAddress: Address;
  account: Account;
  wallet: WalletClient;
  publicClient: PublicClient;
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
  const publicClient = createPublicClient({ chain: bsc, transport: http(config.rpcUrl) });
  const wallet = createWalletClient({ chain: bsc, transport: http(config.rpcUrl), account });

  cached = {
    rpcUrl: config.rpcUrl,
    registryAddress: config.registryAddress as Address,
    account,
    wallet,
    publicClient,
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

  const hash = await wallet.writeContract({
    account: operator,
    chain: bsc,
    address: registryAddress,
    abi: REGISTRY_ABI,
    functionName: 'registerStrategy',
    args: [meta.name, meta.description, meta.isPublic],
  });
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
    schedule: RebalanceSchedule;
    activeAt: Date;
  },
): Promise<number> {
  const { wallet, publicClient, registryAddress, account: operator } = getChain();

  const hash = await wallet.writeContract({
    account: operator,
    chain: bsc,
    address: registryAddress,
    abi: REGISTRY_ABI,
    functionName: 'publishVersion',
    args: [
      BigInt(onchainId),
      version.assets,
      version.weightsBps,
      canonicalScheduleHash(version.schedule),
      BigInt(Math.floor(version.activeAt.getTime() / 1000)),
    ],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  return decodeReturnedId(receipt.logs, 'VersionPublished', 'version');
}

/** Enroll `account` (the authenticated wallet, an EOA for now) into `onchainId`. */
export async function enrollOnchain(account: Address, onchainId: number): Promise<void> {
  const { wallet, publicClient, registryAddress, account: operator } = getChain();

  const hash = await wallet.writeContract({
    account: operator,
    chain: bsc,
    address: registryAddress,
    abi: REGISTRY_ABI,
    functionName: 'enroll',
    args: [account, BigInt(onchainId)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
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
