import { formatUnits, keccak256, toHex } from 'viem';
import type { Hex } from 'viem';
import { ValidationError } from './errors.js';
import type { Allocation } from './strategies.js';
import { TESTNET_97 } from './testnet-profile.js';

export type LegacyExecution = { kind: 'hold' } | { kind: 'stack' };
export type AssetMode = { kind: 'hold' } | { kind: 'stack'; every: 'daily' | 'weekly'; weekday: number | null; timeUtc: string; slices: number };
export type AssetSetting = { asset: string; weightBps: number; execution?: AssetMode; yield: null | { market: string } };
export type AssetExecution = { kind: 'per_asset'; numeraire: string; rebalance: 'none' | 'monthly' | 'drift'; assets: AssetSetting[] };
export type TypedExecution = LegacyExecution | AssetExecution;
/** Funding/slot scheduler marker; never interpreted as a legacy drift interval. */
export type FundingSchedule = { kind: 'funding' };
export const UINT256_MAX = (1n << 256n) - 1n;
const UNIT = 10n ** 18n;
const CENT = UNIT / 100n;

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function exactKeys(value: Record<string, unknown>, allowed: readonly string[], code: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new ValidationError(code, 'request contains unsupported fields');
  }
}

export function validateExecution(value: unknown = { kind: 'hold' }): LegacyExecution {
  if (!record(value) || Object.keys(value).length !== 1 || (value.kind !== 'hold' && value.kind !== 'stack')) {
    throw new ValidationError('INVALID_EXECUTION', 'execution must be exactly { kind: hold | stack }; mixed and other modes are unavailable');
  }
  return { kind: value.kind };
}

export function validateFundingSchedule(value: unknown = { kind: 'funding' }): FundingSchedule {
  if (!record(value) || Object.keys(value).length !== 1 || value.kind !== 'funding') {
    throw new ValidationError('INVALID_SCHEDULE', 'hold/stack require { kind: funding }; creator periods belong to per-asset execution');
  }
  return { kind: 'funding' };
}

export function validateIdleYield(value: unknown = { enabled: false }): { enabled: false } {
  if (!record(value) || Object.keys(value).length !== 1 || value.enabled !== false) {
    throw new ValidationError('YIELD_UNAVAILABLE', 'idleYield must be { enabled: false } until the yield integration is available');
  }
  return { enabled: false };
}

export function numeraireFor(chainId: number): string {
  return chainId === 97 ? TESTNET_97.contracts.usdt : '0x55d398326f99059ff775485246999027b3197955';
}

/** Strict decimal parsing; viem parseUnits rounds excess precision, which is unsuitable here. */
export function usdtRaw(value: unknown): bigint {
  if (typeof value !== 'string' || value.length > 98 || !/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/.test(value)) {
    throw new ValidationError('INVALID_AMOUNT', 'amountUsdt must be a positive decimal string with at most 18 decimals');
  }
  const [whole = '', fraction = ''] = value.split('.');
  const amount = BigInt(whole) * UNIT + BigInt(fraction.padEnd(18, '0'));
  if (amount <= 0n || amount > UINT256_MAX) throw new ValidationError('INVALID_AMOUNT', 'amountUsdt is outside the positive uint256 range');
  return amount;
}

export function minimumAllocationRaw(allocation: Allocation, chainId: number): bigint {
  const weights = allocation.assets.filter((asset) => asset.address !== numeraireFor(chainId)).map((asset) => BigInt(asset.weightBps));
  if (weights.length === 0) return 50n * UNIT;
  const fits = (amount: bigint) => {
    const inputs = weights.map((weight) => amount * weight / 10_000n);
    return inputs.every((input) => input >= 5n * UNIT) && inputs.reduce((sum, input) => sum + input, 0n) >= 50n * UNIT;
  };
  let low = 50n * UNIT;
  let high = low;
  while (!fits(high)) high *= 2n;
  while (low < high) {
    const mid = (low + high) / 2n;
    if (fits(mid)) high = mid;
    else low = mid + 1n;
  }
  return low;
}

export function defaultAmountUsdt(allocation: Allocation, chainId: number): string {
  const minimum = minimumAllocationRaw(allocation, chainId);
  return formatUnits((minimum + CENT - 1n) / CENT * CENT, 18);
}

export type CanonicalConfig = {
  chainId: number;
  execution: TypedExecution;
  allocation: Allocation;
  schedule: FundingSchedule;
  activeAt: Date;
};

/** Fixed key order, sorted lowercase addresses, no display symbols. UTF-8 JSON, no whitespace. */
export function canonicalConfig(config: CanonicalConfig): string {
  if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0 ||
      !Number.isSafeInteger(config.activeAt.getTime()) || config.activeAt.getTime() < 0 || config.activeAt.getTime() % 1000 !== 0) {
    throw new ValidationError('INVALID_CONFIG', 'config requires a positive chainId and whole-second activeAt');
  }
  return JSON.stringify({
    domain: 'cre8.strategy.execution', schemaVersion: config.execution.kind === 'per_asset' ? 2 : 1, chainId: config.chainId,
    execution: config.execution.kind === 'per_asset' ? validateAssetConfig(config.execution, config.allocation, config.chainId) : validateExecution(config.execution),
    allocation: { assets: config.allocation.assets.map(({ address, weightBps }) => ({ address: address.toLowerCase(), weightBps }))
      .sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0) },
    schedule: validateFundingSchedule(config.schedule), idleYield: { enabled: false },
    activeAt: String(config.activeAt.getTime() / 1000),
  });
}

export function canonicalConfigHash(config: CanonicalConfig): Hex {
  return keccak256(toHex(canonicalConfig(config)));
}

/** Zoned RFC3339 only; reject local/normalized invalid dates and fractional milliseconds. */
export function utcDate(value: unknown, field: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new ValidationError('INVALID_TIME', `${field} must be an RFC3339 timestamp with an explicit timezone`);
  }
  const date = new Date(value);
  const day = Number(value.slice(8, 10));
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  if (!Number.isFinite(date.getTime()) || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
      Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) {
    throw new ValidationError('INVALID_TIME', `${field} must be a valid timestamp`);
  }
  return date;
}

/** G0-4: creator-owned per-asset parameters. Explicit defaults precede signing. */
export function validateAssetConfig(value: unknown, allocation: Allocation, chainId: number): AssetExecution {
  const cash = numeraireFor(chainId);
  if (value === undefined) value = { kind: 'per_asset', numeraire: cash, assets: allocation.assets.map(a => ({ asset: a.address, weightBps: a.weightBps, ...(a.address === cash ? {} : { execution: { kind: 'hold' } }), yield: null })) };
  if (!record(value) || value.kind !== 'per_asset') throw new ValidationError('INVALID_EXECUTION', 'execution must use per_asset creator parameters');
  exactKeys(value, ['kind','numeraire','rebalance','assets'], 'INVALID_EXECUTION');
  if (value.numeraire !== cash || !Array.isArray(value.assets) || value.assets.length < 1 || value.assets.length !== allocation.assets.length || value.assets.length > 16) throw new ValidationError('INVALID_EXECUTION', 'execution must match the chain numeraire and complete allocation');
  const rebalance = value.rebalance === undefined ? 'none' : value.rebalance;
  if (rebalance !== 'none' && rebalance !== 'monthly' && rebalance !== 'drift') throw new ValidationError('INVALID_EXECUTION', 'rebalance must be none, monthly or drift');
  const seen = new Set<string>();
  const assets: AssetSetting[] = value.assets.map((entry: unknown) => {
    if (!record(entry) || typeof entry.asset !== 'string') throw new ValidationError('INVALID_EXECUTION', 'invalid asset setting');
    const asset = entry.asset.toLowerCase();
    exactKeys(entry, asset === cash ? ['asset','weightBps','yield'] : ['asset','weightBps','execution','yield'], 'INVALID_EXECUTION');
    if (seen.has(asset) || !allocation.assets.some(a => a.address === asset && a.weightBps === entry.weightBps)) throw new ValidationError('INVALID_EXECUTION', 'asset settings must match allocation exactly');
    seen.add(asset);
    let selected: AssetSetting['yield'] = null;
    if (entry.yield !== undefined && entry.yield !== null) {
      if (!record(entry.yield) || typeof entry.yield.market !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.yield.market) || Object.keys(entry.yield).length !== 1) throw new ValidationError('YIELD_UNAVAILABLE', 'yield requires an enabled platform market ID');
      selected = { market: entry.yield.market };
    }
    if (asset === cash) return { asset, weightBps: Number(entry.weightBps), yield: selected };
    const mode = entry.execution === undefined ? { kind: 'hold' } : entry.execution;
    if (!record(mode)) throw new ValidationError('INVALID_EXECUTION', 'asset execution is required');
    let execution: AssetMode;
    if (mode.kind === 'hold' && Object.keys(mode).length === 1) execution = { kind: 'hold' };
    else if (mode.kind === 'stack') {
      exactKeys(mode, ['kind','every','weekday','timeUtc','slices'], 'INVALID_EXECUTION');
      // UTC is mandatory: the UI converts the creator's displayed local defaults before signing.
      if ((mode.every !== 'daily' && mode.every !== 'weekly') || typeof mode.timeUtc !== 'string' || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(mode.timeUtc) || !Number.isInteger(mode.slices) || Number(mode.slices) < 2 || Number(mode.slices) > 52 || (mode.every === 'daily' ? mode.weekday !== null : !Number.isInteger(mode.weekday) || Number(mode.weekday) < 0 || Number(mode.weekday) > 6)) throw new ValidationError('INVALID_EXECUTION', 'stack requires daily/weekly, UTC time, weekday and 2..52 slices');
      execution = { kind: 'stack', every: mode.every, weekday: mode.weekday === null ? null : Number(mode.weekday), timeUtc: mode.timeUtc, slices: Number(mode.slices) };
    } else throw new ValidationError('INVALID_EXECUTION', 'only hold and stack are available');
    if (rebalance !== 'none' && execution.kind !== 'hold') throw new ValidationError('INVALID_EXECUTION', 'rebalancing requires every noncash asset to use hold');
    return { asset, weightBps: Number(entry.weightBps), execution, yield: selected };
  }).sort((a,b) => a.asset.localeCompare(b.asset));
  return { kind: 'per_asset', numeraire: cash, rebalance, assets };
}

export function minimumAssetContribution(config: AssetExecution): bigint {
  const weight = config.assets.filter(a => a.asset !== config.numeraire).reduce((s,a) => s+BigInt(a.weightBps),0n);
  return weight === 0n ? 50n * UNIT : (50n * UNIT * 10000n + weight - 1n) / weight;
}
