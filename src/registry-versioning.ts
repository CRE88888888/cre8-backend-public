import { decodeErrorResult, encodeAbiParameters, encodeFunctionData, keccak256, toHex } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { REGISTRY_ABI, REGISTRY_VERSION_ABI } from './registry-abi.js';
import { canonicalConfig } from './strategy-execution.js';
import type { CanonicalConfig } from './strategy-execution.js';
import { AppError, ValidationError } from './errors.js';

export const VERSION_NOTICE_SECONDS = 86400;
export const VERSION_INTERVAL_SECONDS = 604800;
/** Leave a minute for signing/mining after the observed block; never persist the contract's zero sentinel. */
export const FIRST_VERSION_LEAD_SECONDS = 60;
export const FOLLOW_VERSIONS_TEXT = 'I agree to follow future strategy versions; changes require at least 24 hours notice during which I can exit. Fee-only decreases may take effect immediately.';
export const FOLLOW_VERSIONS_TERMS = keccak256(toHex(FOLLOW_VERSIONS_TEXT));
export type VersionSettings = { scheduleHash: Hex; settingsHash: Hex; performanceFeeBps: number };

export type BuyVersionWindow = { activeVersion: number; timestamp: bigint; pendingActiveAt: bigint | null };

/** activeVersion includes a pending version that has just matured, even before a keeper writes activation. */
export async function defaultPublicationActiveAt(client: PublicClient, registry: Address, id: number, now = Date.now()): Promise<Date> {
  try {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('invalid strategy');
    const block = await client.getBlock({ blockTag: 'latest' });
    if (typeof block.number !== 'bigint' || block.number < 0n || typeof block.timestamp !== 'bigint' || block.timestamp < 0n ||
        typeof block.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(block.hash)) throw new Error('missing canonical block');
    const active = await client.readContract({ address: registry, abi: REGISTRY_VERSION_ABI,
      functionName: 'activeVersion', args: [BigInt(id)], blockNumber: block.number });
    if (!Number.isInteger(active) || active < 0 || active > 65535) throw new Error('invalid active version');
    if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error('reorg');
    const seconds = active === 0 ? block.timestamp + BigInt(FIRST_VERSION_LEAD_SECONDS)
      : BigInt(Math.floor(now / 1000) + VERSION_NOTICE_SECONDS + FIRST_VERSION_LEAD_SECONDS);
    // JavaScript Date has a narrower range than uint64. Reject before converting bigint to number.
    if (seconds <= 0n || seconds > 8_640_000_000_000n) throw new Error('activation time out of range');
    return new Date(Number(seconds) * 1000);
  } catch { throw new AppError(503, 'VERSION_PUBLICATION_UNAVAILABLE', 'publication activation time unavailable; no new version stored'); }
}

/** Fresh send evidence: every registry read uses the same canonical RPC block. */
export async function readBuyVersionWindow(client: PublicClient, registry: Address, id: bigint): Promise<BuyVersionWindow> {
  try {
    if (id < 1n) throw new Error('invalid strategy');
    const block = await client.getBlock({ blockTag: 'latest' });
    if (typeof block.number !== 'bigint' || block.number < 0n || typeof block.timestamp !== 'bigint' || block.timestamp < 0n || block.hash === null) throw new Error('missing block');
    const params = { address: registry, abi: REGISTRY_VERSION_ABI, blockNumber: block.number };
    const [activeVersion, pending] = await Promise.all([
      client.readContract({ ...params, functionName: 'activeVersion', args: [id] }),
      client.readContract({ ...params, functionName: 'pendingVersion', args: [id] }),
    ]);
    if (activeVersion < 1 || activeVersion > 65535 || pending < 0 || pending > 65535) throw new Error('invalid version');
    const pendingActiveAt = pending === 0 ? null : (await client.readContract({ ...params,
      functionName: 'version', args: [id, pending] })).activeAt;
    if (pendingActiveAt !== null && (pending <= activeVersion || pendingActiveAt <= block.timestamp)) throw new Error('invalid pending version');
    if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error('reorg');
    return { activeVersion, timestamp: block.timestamp, pendingActiveAt };
  } catch { throw new AppError(503, 'VERSION_STATE_UNAVAILABLE', '[VERSION_STATE_UNAVAILABLE] 無法確認送出前生效版本與生效時間，不送買入'); }
}

/** Inspect structured causes only; RPC messages can contain credentials. */
export function p11Error(error: unknown): AppError | null {
  const names = ['ConsentRequired', 'UnexpectedVersion', 'PendingVersionExists', 'NoPendingVersion', 'PublicationTooSoon', 'ActivationTooSoon', 'PerformanceFeeOutOfRange', 'StrategyAssetLimitExceeded'];
  const seen = new Set<unknown>();
  for (let value = error, depth = 0; depth < 12 && typeof value === 'object' && value !== null && !seen.has(value); depth++) {
    seen.add(value);
    const data: unknown = 'data' in value ? value.data : undefined;
    let name: unknown = typeof data === 'object' && data !== null && 'errorName' in data ? data.errorName : undefined;
    if (typeof data === 'string' && /^0x[0-9a-fA-F]+$/.test(data)) {
      try { name = decodeErrorResult({ abi: REGISTRY_ABI, data: data as Hex }).errorName; } catch { /* unknown selector */ }
    }
    if (typeof name === 'string' && names.includes(name)) return new AppError(409, 'VERSION_CONTRACT_REJECTED', `registry rejected ${name}; refresh effective/pending version and owner consent before retrying`);
    value = 'cause' in value ? value.cause : undefined;
  }
  return null;
}

/** Metadata lives in the existing immutable allocation JSON; no database migration is needed. */
export function storedVersionSettings(allocation: unknown): VersionSettings | undefined {
  if (typeof allocation !== 'object' || allocation === null || !('p11' in allocation)) return undefined;
  const value: unknown = allocation.p11;
  if (typeof value !== 'object' || value === null || !('settingsHash' in value) || !('scheduleHash' in value) || !('performanceFeeBps' in value) ||
      typeof value.settingsHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(value.settingsHash) ||
      typeof value.scheduleHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(value.scheduleHash)) throw new AppError(409, 'CONFIG_HASH_MISMATCH', 'invalid P11 version metadata');
  return { scheduleHash: value.scheduleHash as Hex, settingsHash: value.settingsHash as Hex, performanceFeeBps: performanceFee(value.performanceFeeBps) };
}

export function performanceFee(value: unknown = 500): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 500 || value > 2000) {
    throw new ValidationError('INVALID_PERFORMANCE_FEE', 'performanceFeeBps must be an integer in 500..2000');
  }
  return value;
}

/** Matches Solidity abi.encode, preserving the submitted basket's order. */
export function registryConfigHash(assets: readonly Address[], weights: readonly number[], settings: VersionSettings): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'address[]' }, { type: 'uint16[]' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint16' }],
    [assets, weights, settings.scheduleHash, settings.settingsHash, performanceFee(settings.performanceFeeBps)],
  ));
}

/** Time and fees are separate on-chain fields; a fee-only decrease keeps these commitments stable. */
export function typedVersionSettings(config: CanonicalConfig, fee: unknown = 500): VersionSettings {
  return { scheduleHash: keccak256(toHex('funding')),
    settingsHash: keccak256(toHex(canonicalConfig({ ...config, activeAt: new Date(0) }))), performanceFeeBps: performanceFee(fee) };
}

export function enrollmentApprovalHash(id: bigint, version: number, configHash: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'uint16' }, { type: 'bytes32' }, { type: 'bytes32' }],
    [id, version, configHash, FOLLOW_VERSIONS_TERMS]));
}

/** Owner signs this call through Kernel sudo; the backend never signs it. */
export async function prepareEnrollmentApproval(client: PublicClient, registry: Address, account: Address, id: number, direct = false) {
  if (!Number.isSafeInteger(id) || id < 1) throw new ValidationError('INVALID_ID', 'invalid strategy id');
  try {
    const block = await client.getBlock({ blockTag: 'latest' });
    if (block.number === null || block.hash === null) throw new Error('missing block');
    const blockNumber = block.number;
    const version = await client.readContract({ address: registry, abi: REGISTRY_VERSION_ABI, functionName: 'activeVersion', args: [BigInt(id)], blockNumber });
    if (version === 0) throw new AppError(409, 'VERSION_NOT_ACTIVE', 'strategy has no effective version');
    const config = await client.readContract({ address: registry, abi: REGISTRY_VERSION_ABI, functionName: 'version', args: [BigInt(id), version], blockNumber });
    if ((await client.getBlock({ blockNumber })).hash !== block.hash) throw new Error('reorg');
    return { account, expectedVersion: version, configHash: config.configHash, activeAt: new Date(Number(config.activeAt) * 1000).toISOString(),
      performanceFeeBps: config.performanceFeeBps, terms: FOLLOW_VERSIONS_TEXT, termsHash: FOLLOW_VERSIONS_TERMS,
      signingMode: 'sudo' as const, call: { to: registry, value: '0', data: encodeFunctionData({ abi: REGISTRY_ABI,
        ...(direct ? { functionName: 'enroll' as const, args: [account, BigInt(id), version] as const } :
          { functionName: 'approveEnrollment' as const, args: [BigInt(id), version] as const }) }) } };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'ENROLLMENT_APPROVAL_UNAVAILABLE', 'enrollment approval preparation unavailable');
  }
}

export async function readVersionState(client: PublicClient, registry: Address, id: number, version: number) {
  if (!Number.isSafeInteger(id) || id < 1 || !Number.isInteger(version) || version < 1 || version > 65535) throw new ValidationError('INVALID_ID', 'strategy id and uint16 version are required');
  try {
    const block = await client.getBlock({ blockTag: 'latest' });
    if (block.number === null || block.hash === null) throw new Error('missing canonical block');
    const params = { address: registry, abi: REGISTRY_VERSION_ABI, blockNumber: block.number };
    const [active, pending, cancelled, lastPublishedAt, value, maxStrategyAssets] = await Promise.all([
      client.readContract({ ...params, functionName: 'activeVersion', args: [BigInt(id)] }),
      client.readContract({ ...params, functionName: 'pendingVersion', args: [BigInt(id)] }),
      client.readContract({ ...params, functionName: 'cancelledVersion', args: [BigInt(id), version] }),
      client.readContract({ ...params, functionName: 'lastPublishedAt', args: [BigInt(id)] }),
      client.readContract({ ...params, functionName: 'version', args: [BigInt(id), version] }),
      client.readContract({ ...params, functionName: 'MAX_STRATEGY_ASSETS' }),
    ]);
    if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error('reorg');
    return { status: cancelled ? 'cancelled' : version === active ? 'active' : version === pending ? 'pending' : 'historical',
      activeVersion: active, pendingVersion: pending, activeAt: new Date(Number(value.activeAt) * 1000).toISOString(),
      // Cancellation requires a durable outbox; the launch API deliberately exposes no writer.
      canCancel: false,
      nextPublishAt: (lastPublishedAt + BigInt(VERSION_INTERVAL_SECONDS)).toString(),
      maxStrategyAssets: maxStrategyAssets.toString(),
      assets: value.assets, weightsBps: value.weightsBps, scheduleHash: value.scheduleHash,
      configHash: value.configHash, settingsHash: value.settingsHash, performanceFeeBps: value.performanceFeeBps };
  } catch (cause) { throw new AppError(503, 'VERSION_STATE_UNAVAILABLE', 'version state unavailable', { cause }); }
}
