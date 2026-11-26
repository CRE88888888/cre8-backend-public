import type { Address } from 'viem';
import { ValidationError } from './errors.js';
import { record } from './strategy-execution.js';
import { TESTNET_97, testnetAssets } from './testnet-profile.js';
import { MODEL_ASSETS } from './model-returns/catalogue.js';
import { testnetAssetKind } from './trading-calendar.js';
import type { TestnetAssetKind } from './trading-calendar.js';

export type MixFrequency = 'daily' | 'weekly' | 'monthly' | 'quarterly';
export type MixAsset = { assetId: Address; weightBps: number };
export type MixSettings = { name: string; assets: MixAsset[]; rebalance: { frequency: MixFrequency; startDate: string };
  exit: { takeProfitBps: number | null; stopLossBps: number | null }; importCode?: string };
const DAY = 86_400_000;
const frequencies: readonly MixFrequency[] = ['daily', 'weekly', 'monthly', 'quarterly'];
/** Stablecoins are cash, not a mix constituent (USDT is the numeraire; USDC/DAI would only re-wrap cash). */
export const MIX_EXCLUDED_SYMBOLS: ReadonlySet<string> = new Set(['USDC', 'DAI']);
/** Every chain-97 manifest asset except cash-like ones (#189: 103 of 105). */
export const MIX_ASSETS = testnetAssets().filter(asset => !asset.is_numeraire && !MIX_EXCLUDED_SYMBOLS.has(asset.symbol));
export type MixAssetListing = { assetId: Address; symbol: string; kind: TestnetAssetKind; hasBacktest: boolean };
/** Public, static list for the picker. hasBacktest means a model-returns price source exists, not that today's data is ready. */
export function mixAssetListing(): MixAssetListing[] {
  return MIX_ASSETS.map(asset => ({ assetId: asset.address, symbol: asset.symbol, kind: testnetAssetKind(asset.symbol),
    hasBacktest: MODEL_ASSETS.some(model => model.symbol === asset.symbol.toUpperCase()) }));
}
const invalid = (code: string, message: string): never => { throw new ValidationError(code, message); };
export function mixKeys(input: Record<string, unknown>, allowed: readonly string[], code: string): void {
  if (Object.keys(input).some(key => !allowed.includes(key))) invalid(code, '組合設定含有不支援的欄位，請重新確認。');
}

/** Calendar dates are UTC, anchored to the original day (Jan 31 → Feb 28 → Mar 31). */
export function mixDate(value: unknown): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return invalid('INVALID_MIX_DATE', '請選擇有效的開始日期。');
  const date = new Date(value + 'T00:00:00.000Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value || date.getUTCFullYear() < 1) {
    return invalid('INVALID_MIX_DATE', '請選擇有效的開始日期。');
  }
  return date;
}
function checkedNow(now: Date): void {
  if (!Number.isFinite(now.getTime())) throw new RangeError('invalid mix clock');
}
export function mixAssets(input: unknown): MixAsset[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 10) return invalid('INVALID_MIX_ASSETS', '請選擇 1 至 10 個資產。');
  const assets = input.map((asset): MixAsset => {
    if (!record(asset)) return invalid('INVALID_MIX_ASSETS', '請重新選擇資產與比例。');
    mixKeys(asset, ['assetId', 'weightBps'], 'INVALID_MIX_ASSETS');
    const assetId = asset.assetId;
    const identity = typeof assetId === 'string' ? MIX_ASSETS.find(candidate => candidate.address === assetId.toLowerCase()) : undefined;
    if (!identity) return invalid('INVALID_MIX_ASSET', '這個資產暫時無法加入私人組合。');
    if (typeof asset.weightBps !== 'number' || !Number.isInteger(asset.weightBps) || asset.weightBps < 1 || asset.weightBps > 10000) {
      return invalid('INVALID_MIX_WEIGHT', '每個資產的比例須為 0.01% 至 100%。');
    }
    // Identity was checked against the chain manifest, not a request symbol.
    return { assetId: identity.address, weightBps: asset.weightBps };
  });
  if (new Set(assets.map(asset => asset.assetId)).size !== assets.length) return invalid('DUPLICATE_MIX_ASSET', '同一個資產只能選擇一次。');
  if (assets.reduce((sum, asset) => sum + asset.weightBps, 0) !== 10000) return invalid('INVALID_MIX_TOTAL', '所有資產的比例加起來必須剛好是 100%。');
  return assets;
}
export function mixExit(input: unknown = {}): MixSettings['exit'] {
  if (!record(input)) return invalid('INVALID_MIX_EXIT', '請設定停利或停損比例，也可以都不設定。');
  mixKeys(input, ['takeProfitBps', 'stopLossBps'], 'INVALID_MIX_EXIT');
  const threshold = (value: unknown, maximum: number, label: string): number | null => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > maximum) {
      return invalid('INVALID_MIX_EXIT', `${label}比例須介於 0.01% 與 ${maximum / 100}%。`);
    }
    return value;
  };
  return { takeProfitBps: threshold(input.takeProfitBps, 2147483647, '停利'), stopLossBps: threshold(input.stopLossBps, 10000, '停損') };
}
export function mixRebalance(input: unknown = {}, now = new Date()): MixSettings['rebalance'] {
  checkedNow(now);
  if (!record(input)) return invalid('INVALID_MIX_FREQUENCY', '請選擇每天、每週、每月或每季再平衡。');
  mixKeys(input, ['frequency', 'startDate'], 'INVALID_MIX_FREQUENCY');
  const frequency = frequencies.find(candidate => candidate === (input.frequency ?? 'monthly'));
  if (!frequency) return invalid('INVALID_MIX_FREQUENCY', '請選擇每天、每週、每月或每季再平衡。');
  const startDate = input.startDate ?? now.toISOString().slice(0, 10);
  mixDate(startDate);
  if (typeof startDate !== 'string') return invalid('INVALID_MIX_DATE', '請選擇有效的開始日期。');
  return { frequency, startDate };
}
export function mixSettings(input: unknown, now = new Date()): MixSettings {
  if (!record(input)) return invalid('INVALID_MIX', '請選擇組合的資產與比例。');
  mixKeys(input, ['name', 'assets', 'rebalance', 'exit', 'importCode'], 'INVALID_MIX');
  const assets = mixAssets(input.assets);
  const symbols = assets.map(asset => testnetAssets().find(candidate => candidate.address === asset.assetId)?.symbol);
  if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 100)) {
    return invalid('INVALID_MIX_NAME', '組合名稱請填寫 1 至 100 個字。');
  }
  const name = typeof input.name === 'string' ? input.name.trim() : symbols.slice(0, 2).join(' + ') + (symbols.length > 2 ? ` + ${symbols.length - 2} more` : '');
  if (input.importCode !== undefined && (typeof input.importCode !== 'string' || !/^[A-Za-z0-9_-]{22,128}$/.test(input.importCode))) {
    return invalid('INVALID_MIX_IMPORT', '分享連結無效，請重新開啟連結。');
  }
  return { name, assets, rebalance: mixRebalance(input.rebalance, now), exit: mixExit(input.exit),
    ...(typeof input.importCode === 'string' ? { importCode: input.importCode } : {}) };
}

function occurrence(start: Date, frequency: MixFrequency, index: number): Date {
  if (frequency === 'daily' || frequency === 'weekly') return new Date(start.getTime() + index * DAY * (frequency === 'daily' ? 1 : 7));
  const month = start.getUTCMonth() + index * (frequency === 'monthly' ? 1 : 3);
  const first = new Date(0);
  first.setUTCFullYear(start.getUTCFullYear(), month, 1);
  const end = new Date(first);
  end.setUTCMonth(first.getUTCMonth() + 1, 0);
  first.setUTCDate(Math.min(start.getUTCDate(), end.getUTCDate()));
  return first;
}
/** Last *successful* rebalance consumes its calendar occurrence; overdue work remains due.
 * API callers may display a past due date while a closed market defers the trade.
 */
export function nextMixRebalance(settings: MixSettings['rebalance'], last: Date | null): Date {
  const start = mixDate(settings.startDate);
  if (!frequencies.includes(settings.frequency)) throw new RangeError('invalid mix frequency');
  if (last === null || last < start) return start;
  checkedNow(last);
  let index = settings.frequency === 'daily' || settings.frequency === 'weekly'
    ? Math.floor((last.getTime() - start.getTime()) / DAY / (settings.frequency === 'daily' ? 1 : 7))
    : Math.floor(((last.getUTCFullYear() - start.getUTCFullYear()) * 12 + last.getUTCMonth() - start.getUTCMonth()) / (settings.frequency === 'monthly' ? 1 : 3));
  if (index < 0) index = 0;
  let next = occurrence(start, settings.frequency, index);
  if (next <= last) next = occurrence(start, settings.frequency, index + 1);
  if (!Number.isFinite(next.getTime())) throw new RangeError('mix schedule overflow');
  return next;
}

/** Exact cross multiplication decides thresholds; rounded display values never trigger an exit. */
export function mixPerformance(valueRaw: bigint, depositsRaw: bigint, withdrawalsRaw: bigint, settings: MixSettings['exit']) {
  if (valueRaw < 0n || depositsRaw < 0n || withdrawalsRaw < 0n) throw new RangeError('negative mix value or cash flow');
  const exit = mixExit(settings);
  const netInputRaw = depositsRaw - withdrawalsRaw;
  if (netInputRaw <= 0n) return { netInputRaw, profitRaw: valueRaw - netInputRaw, returnBps: null, trigger: null,
    message: '淨投入為零或負數，暫時無法計算報酬率，停利停損暫不觸發。' };
  const profitRaw = valueRaw - netInputRaw;
  const numerator = profitRaw * 10000n;
  const trigger = exit.takeProfitBps !== null && numerator >= netInputRaw * BigInt(exit.takeProfitBps) ? 'take_profit' as const
    : exit.stopLossBps !== null && numerator <= -netInputRaw * BigInt(exit.stopLossBps) ? 'stop_loss' as const : null;
  return { netInputRaw, profitRaw, returnBps: (numerator / netInputRaw).toString(), trigger, message: null };
}

/** Retain every positive priced removed holding. The planner must also forbid buying these exits. */
export function mixChainAllocation(userAssets: readonly MixAsset[], removed: readonly { assetId: Address; balanceRaw: bigint }[], maxAssets: number) {
  const selected = mixAssets(userAssets), selectedIds = new Set<string>(selected.map(asset => asset.assetId));
  if (!Number.isInteger(maxAssets) || maxAssets < 1 || removed.some(asset => asset.balanceRaw < 0n ||
      !MIX_ASSETS.some(candidate => candidate.address === asset.assetId.toLowerCase()))) throw new RangeError('invalid mix exit valuation');
  const exits = [...new Set(removed.filter(asset => !selectedIds.has(asset.assetId.toLowerCase()) && asset.balanceRaw > 0n)
    .map(asset => asset.assetId.toLowerCase()))].sort();
  if (selected.length + exits.length + 1 > maxAssets) return invalid('MIX_ASSET_LIMIT', '舊資產尚未賣完，請等出售完成後再變更組合。');
  const biggest = selected.reduce((best, asset, index) => {
    const previous = selected[best];
    return previous && (asset.weightBps > previous.weightBps || asset.weightBps === previous.weightBps && asset.assetId < previous.assetId) ? index : best;
  }, 0);
  const largest = selected[biggest];
  if (!largest || largest.weightBps <= exits.length) return invalid('MIX_ASSET_LIMIT', '舊資產尚未賣完，請等出售完成後再變更組合。');
  return { assets: [...selected.map((asset, index) => ({ address: asset.assetId, weightBps: asset.weightBps - (index === biggest ? exits.length : 0) })),
    ...exits.map(address => ({ address, weightBps: 1 })), { address: TESTNET_97.contracts.usdt, weightBps: 0 }], sellOnlyAssets: exits };
}
