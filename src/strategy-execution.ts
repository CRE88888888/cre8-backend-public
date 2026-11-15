import { formatUnits, keccak256, toHex } from 'viem';
import type { Hex } from 'viem';
import { ValidationError } from './errors.js';
import type { Allocation } from './strategies.js';
import { TESTNET_97 } from './testnet-profile.js';

export type TypedExecution = { kind: 'hold' } | { kind: 'stack' };
/** Intentionally unsupported by the legacy drift scheduler. BE-2 consumes funding/slots. */
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

export function validateExecution(value: unknown = { kind: 'hold' }): TypedExecution {
  if (!record(value) || Object.keys(value).length !== 1 || (value.kind !== 'hold' && value.kind !== 'stack')) {
    throw new ValidationError('INVALID_EXECUTION', 'execution must be exactly { kind: hold | stack }; mixed and other modes are unavailable');
  }
  return { kind: value.kind };
}

export function validateFundingSchedule(value: unknown = { kind: 'funding' }): FundingSchedule {
  if (!record(value) || Object.keys(value).length !== 1 || value.kind !== 'funding') {
    throw new ValidationError('INVALID_SCHEDULE', 'hold/stack require { kind: funding }; personal periods belong to stack instructions');
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
    domain: 'cre8.strategy.execution', schemaVersion: 1, chainId: config.chainId,
    execution: validateExecution(config.execution),
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
