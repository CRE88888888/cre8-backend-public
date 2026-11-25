import { getGasPriceWei } from './chain.js';
import { AppError } from './errors.js';
import { perOperationCostWei } from './funding.js';
import { minimumAssetContributionFromAllocation } from './asset-plan.js';
import { createModelReader } from './model-returns/service.js';
import type { ModelResult } from './model-returns/calculation.js';
import { emptyModel } from './model-returns/calculation.js';
import { mixAssetListing, mixAssets, mixKeys, MIX_ASSETS } from './mix-domain.js';
import type { MixAssetListing } from './mix-domain.js';
import { record } from './strategy-execution.js';
import { assetsMarketOpen } from './trading-calendar.js';
import { configuredChainId } from './testnet-profile.js';
import type { MixAsset } from './mix-domain.js';

/** The existing calendar fails closed outside its published years. */
export function nextMixMarketOpen(asset: string, now: Date): Date | null {
  if (!Number.isFinite(now.getTime())) throw new RangeError('invalid mix calendar clock');
  if (assetsMarketOpen(97, [asset], now)) return now;
  const step = 30 * 60_000;
  const start = Math.ceil(now.getTime() / step) * step;
  for (let time = start; time <= start + 10 * 86_400_000; time += step) {
    const candidate = new Date(time);
    if (assetsMarketOpen(97, [asset], candidate)) return candidate;
  }
  return null;
}

export type MixPreviewDeps = {
  chainId?: number;
  now?: () => Date;
  gasPrice?: () => Promise<bigint>;
  model?: (assets: readonly MixAsset[], now: Date) => Promise<ModelResult>;
  timeoutMs?: number;
};
/** Account-free preview reuses the exact hold admission and historical-price reader.
 * Cost is a rate and native-gas estimate: no imaginary turnover or claimed all-in USD cost.
 * The testnet sponsors gas; the estimate still shows its real native cost separately.
 * `viewer`: who is asking, when the request carried a session (the route passes it lazily). It is only asked for while
 * some picked asset is outside its session, and only decides the chain-97 market-hours bypass list (trading-calendar.ts):
 * a listed test wallet sees every market as open, like its trades do. Anyone else gets the same answer as before.
 */
export function createMixPreview(deps: MixPreviewDeps = {}) {
  let active = 0;
  const timeoutMs = deps.timeoutMs ?? 2000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) throw new RangeError('invalid mix preview timeout');
  return async (input: unknown, viewer?: () => Promise<string | null>) => {
    if ((deps.chainId ?? configuredChainId()) !== 97) throw new AppError(503, 'MIX_CHAIN_UNAVAILABLE', '私人組合目前僅開放測試網。');
    if (!record(input)) throw new AppError(400, 'INVALID_MIX_PREVIEW', '請選擇組合的資產與比例。');
    mixKeys(input, ['assets'], 'INVALID_MIX_PREVIEW');
    const assets = mixAssets(input.assets);
    const now = (deps.now ?? (() => new Date()))();
    if (!Number.isFinite(now.getTime())) throw new RangeError('invalid mix preview clock');
    if (active >= 2) throw new AppError(429, 'MIX_PREVIEW_BUSY', '目前試算的人較多，請稍後重試。');
    active++;
    const model = deps.model ?? (async (selected: readonly MixAsset[], at: Date) => {
      const reader = createModelReader({ chainId: 97, now: () => at });
      return (await reader([{ id: 0, onchainId: null, versions: [{ version: 1, activeAt: at.toISOString(),
        allocation: { assets: selected.map(asset => ({ address: asset.assetId, weightBps: asset.weightBps })) } }] }])).get(0) ?? emptyModel();
    });
    const work = Promise.allSettled([Promise.resolve().then(() => model(assets, now)), Promise.resolve().then(() => (deps.gasPrice ?? getGasPriceWei)())] as const)
      .then(([history, gas]) => {
        if (history.status === 'rejected') throw new AppError(503, 'MIX_PREVIEW_UNAVAILABLE', '目前無法取得試算資料，請稍後重試。');
        return [history.value, gas.status === 'fulfilled' ? gas.value : null] as const;
      }).finally(() => { active--; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const [history, gasPrice] = await Promise.race([work, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AppError(503, 'MIX_PREVIEW_TIMEOUT', '試算逾時，請稍後重試。')), timeoutMs);
      })]);
      const minimumRaw = minimumAssetContributionFromAllocation({ assets: assets.map(asset => ({ address: asset.assetId, weightBps: asset.weightBps })) }, 97);
      let owner: string | null = null;
      if (viewer && !assetsMarketOpen(97, assets.map(asset => asset.assetId), now)) try { owner = await viewer(); } catch { /* anonymous */ }
      const markets = assets.map(asset => {
        const open = assetsMarketOpen(97, [asset.assetId], now, owner);
        return { assetId: asset.assetId, symbol: MIX_ASSETS.find(candidate => candidate.address === asset.assetId)?.symbol,
          open, nextOpenAt: open ? null : nextMixMarketOpen(asset.assetId, now)?.toISOString() ?? null };
      });
      const closed = markets.filter(market => !market.open);
      return { minimumDepositRaw: minimumRaw.toString(), modelReturns: history.modelReturns,
        modelNav: history.modelNav.filter(point => Date.parse(point.date) >= now.getTime() - 366 * 86_400_000),
        modelComponents: history.modelComponents,
        estimatedRebalanceCost: { swapFeeBps: 10, gasWei: gasPrice !== null && gasPrice > 0n ? perOperationCostWei(gasPrice).toString() : null,
          gasSponsored: true, message: '交易費為成交金額的 0.1%；gas 依實際用量計算，測試網由平台支付。' },
        markets, message: closed.length ? (closed.every(market => market.nextOpenAt !== null)
          ? '美股收盘中，开盘后完成买入。' : '目前無法確認美股的下次開盤時間，股票部分暫不交易。') : '所有成分目前都在可交易時段。' };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(503, 'MIX_PREVIEW_UNAVAILABLE', '目前無法取得試算資料，請稍後重試。');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

/** GET /mixes/assets: the static picker list (testnet only), no chain or DB reads. */
export function createMixAssetList(deps: { chainId?: number } = {}) {
  return (): { assets: MixAssetListing[] } => {
    if ((deps.chainId ?? configuredChainId()) !== 97) throw new AppError(503, 'MIX_CHAIN_UNAVAILABLE', '私人組合目前僅開放測試網。');
    return { assets: mixAssetListing() };
  };
}
