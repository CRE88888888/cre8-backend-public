import { config as loadDotenv } from 'dotenv';

// Validate on import so API and scheduler fail before accepting work, including .env settings.
// This setting lives here because config.ts is owned by the parallel #56 change.
loadDotenv({ override: false, quiet: true });
const raw = process.env.SWAP_SLIPPAGE_BPS;
const parsed = raw === undefined ? 50 : Number(raw);
if ((raw !== undefined && !/^\d+$/.test(raw)) || !Number.isInteger(parsed) || parsed < 10 || parsed > 200) {
  throw new Error('SWAP_SLIPPAGE_BPS must be an integer in 10..200 (default 50)');
}
export const SWAP_SLIPPAGE_BPS = parsed;

/** Gross output units throughout; fee-adjusted oracle minimum is supplied by the caller. */
export function quoteBoundMinimum(minimum: bigint, quoted: bigint, pancakeOut?: bigint | null): bigint {
  const reference = pancakeOut !== undefined && pancakeOut !== null && pancakeOut > 0n && pancakeOut < quoted
    ? pancakeOut : quoted;
  const discounted = reference * BigInt(10_000 - SWAP_SLIPPAGE_BPS) / 10_000n;
  return discounted > minimum ? discounted : minimum;
}
