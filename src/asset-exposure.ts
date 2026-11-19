import { createPublicClient, http } from 'viem';
import type { Address, PublicClient } from 'viem';
import { getConfig } from './config.js';
import { query as dbQuery } from './db.js';
import { AppError, NotFoundError, ValidationError } from './errors.js';
import { readPositions } from './positions.js';
import type { PriceableAsset } from './positions.js';
import { exactKeys, record } from './strategy-execution.js';
import type { AssetExecution } from './strategy-execution.js';
import { testnetAssets } from './testnet-profile.js';

type Query = (sql: string, params?: readonly unknown[]) => Promise<{ rows: unknown[] }>;
export type AssetExposure = {
  address: string;
  buyPaused: boolean;
  exposureCapUsdtWei: string | null;
  /** null for unchecked, uncapped assets. */
  currentExposureUsdtWei: string | null;
};
/** Public status may be unknown; admission only accepts AssetExposure evidence. */
export type AssetExposureStatus = Omit<AssetExposure, 'buyPaused'> & { buyPaused: boolean | null };
type ExposureDeps = {
  query?: Query;
  client?: PublicClient;
  positions?: typeof readPositions;
  cappedOnly?: boolean;
  timeoutMs?: number;
};
const unavailable = () => new AppError(503, 'EXPOSURE_UNAVAILABLE', 'fund exposure unavailable; no new allocation made');
const address = (value: unknown): Address => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{40}$/.test(value)) throw unavailable();
  return `0x${value.slice(2)}`;
};

/** One observation block for all accounts, using the same balance/TWAP sources as NAV.
 * Cap identity deliberately follows the catalog symbol on every chain (C3 #160).
 * No pending budget reservations: this is an admission-time soft cap, not a trade limit.
 */
export async function readAssetExposure(strategyId: number, chainId: number, assets: readonly string[], deps: ExposureDeps = {}): Promise<AssetExposure[]> {
  const result = await readExposure(strategyId, chainId, assets, deps);
  if (!result.available) throw unavailable();
  return result.states;
}

/** Exposure is optional enrichment for public detail, never an admission decision. */
export async function readAssetExposureStatus(strategyId: number, chainId: number, assets: readonly string[], deps: ExposureDeps = {}): Promise<AssetExposureStatus[]> {
  const result = await readExposure(strategyId, chainId, assets, { ...deps, cappedOnly: true });
  if (result.available) return result.states;
  if (result.states !== null) return result.states.map(s => ({ ...s, currentExposureUsdtWei: null,
    buyPaused: s.exposureCapUsdtWei === null ? false : null }));
  // A failed catalog read cannot establish that any asset is uncapped.
  return [...new Set(assets.map(a => a.toLowerCase()))].map(address => ({ address, buyPaused: null,
    exposureCapUsdtWei: null, currentExposureUsdtWei: null }));
}

type ExposureRead = { available: true; states: AssetExposure[] } | { available: false; states: AssetExposure[] | null };
async function readExposure(strategyId: number, chainId: number, assets: readonly string[], deps: ExposureDeps): Promise<ExposureRead> {
  let states: AssetExposure[] | null = null;
  try {
    const query = deps.query ?? dbQuery;
    const catalog = (await query('select address,symbol,usdt_pool,is_numeraire,max_fund_exposure_usdt::text as cap from priceable_assets')).rows;
    const bySymbol = new Map<string, string | null>();
    const mainnet: PriceableAsset[] = [];
    for (const row of catalog) {
      if (!record(row) || typeof row.symbol !== 'string' || !row.symbol || typeof row.is_numeraire !== 'boolean' ||
          (row.cap !== null && (typeof row.cap !== 'string' || !/^[1-9][0-9]{0,37}$/.test(row.cap))) || bySymbol.has(row.symbol)) throw unavailable();
      if (row.is_numeraire && row.cap !== null) throw unavailable();
      bySymbol.set(row.symbol, row.cap);
      mainnet.push({ address: address(row.address), symbol: row.symbol, isNumeraire: row.is_numeraire,
        usdtPool: row.usdt_pool === null ? null : address(row.usdt_pool) });
    }
    const table: PriceableAsset[] = chainId === 97 ? testnetAssets().map(a => ({ address: a.address, symbol: a.symbol,
      usdtPool: a.usdt_pool, isNumeraire: a.is_numeraire })) : mainnet;
    const unique = [...new Set(assets.map(a => address(a.toLowerCase())))];
    states = unique.map(a => {
      const token = table.find(t => t.address === a);
      return { address: a, buyPaused: false, exposureCapUsdtWei: token?.isNumeraire ? null : bySymbol.get(token?.symbol ?? '') ?? null,
        currentExposureUsdtWei: null } satisfies AssetExposure;
    });
    const checked = states.filter(s => !deps.cappedOnly || s.exposureCapUsdtWei !== null);
    // Uncapped admission and public detail make no additional RPC reads.
    if (checked.length === 0) return { available: true, states };
    const accounts = (await query(`select p.id,a.address from portfolios p join smart_accounts a on a.portfolio_id=p.id
      where p.strategy_id=$1 and a.chain_id=$2 order by p.id`, [strategyId, chainId])).rows;
    const totals = new Map<string, bigint>(checked.map(s => [s.address, 0n]));
    if (accounts.length > 0) {
      const tokens = checked.map(s => {
        const token = table.find(t => t.address === s.address);
        if (!token) throw unavailable();
        return token;
      });
      let stopped = false;
      const observe = async () => {
        const config = deps.client ? null : getConfig();
        if (!deps.client && !config?.rpcUrl) throw unavailable();
        const client = deps.client ?? createPublicClient({ transport: http(config?.rpcUrl ?? undefined, { timeout: 5000, retryCount: 0 }) });
        if (await client.getChainId() !== chainId) throw unavailable();
        const block = await client.getBlockNumber({ cacheTime: 0 });
        const seen = new Set<string>();
        // Bound concurrent RPC fanout; every read remains pinned to the same block.
        for (const row of accounts) {
          if (stopped) throw unavailable();
          if (!record(row) || !/^[1-9][0-9]*$/.test(String(row.id)) || !Number.isSafeInteger(Number(row.id))) throw unavailable();
          const account = address(row.address);
          if (seen.has(account)) throw unavailable();
          seen.add(account);
          const snapshot = await (deps.positions ?? readPositions)(client, { portfolioId: Number(row.id), account, tokens, quoteTable: table, block });
          if (snapshot.portfolioId !== Number(row.id) || snapshot.block !== block || snapshot.unpriced.length > 0) throw unavailable();
          const priced = new Set<string>();
          for (const h of snapshot.holdings) {
            if (!totals.has(h.asset) || priced.has(h.asset) || h.amountWei < 0n || h.usdPriceE8 <= 0n || !Number.isInteger(h.decimals) || h.decimals < 0 || h.decimals > 255) throw unavailable();
            priced.add(h.asset);
            const value = h.amountWei * h.usdPriceE8 * 10n ** 10n / 10n ** BigInt(h.decimals);
            totals.set(h.asset, (totals.get(h.asset) ?? 0n) + value);
          }
        }
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([observe(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(unavailable()), deps.timeoutMs ?? 10_000); })]);
      } finally { stopped = true; clearTimeout(timer); }
    }
    return { available: true, states: states.map(s => {
      const value = totals.get(s.address);
      return { ...s, currentExposureUsdtWei: value?.toString() ?? null,
        buyPaused: s.exposureCapUsdtWei !== null && value !== undefined && value >= BigInt(s.exposureCapUsdtWei) };
    }) };
  } catch { return { available: false, states }; }
}

/** Freeze the retained version weights with largest-remainder bps rounding.
 * Retained calendars/yield and the signed version remain unchanged.
 */
export function allocateExposure(config: AssetExecution, exposure: readonly AssetExposure[]) {
  for (const asset of config.assets.filter(a => a.asset !== config.numeraire && a.weightBps > 0)) {
    const matches = exposure.filter(e => e.address === asset.asset);
    const e = matches[0];
    if (matches.length !== 1 || !e || (e.exposureCapUsdtWei === null ? e.buyPaused :
      !/^[1-9][0-9]*$/.test(e.exposureCapUsdtWei) || e.currentExposureUsdtWei === null || !/^[0-9]+$/.test(e.currentExposureUsdtWei) ||
      e.buyPaused !== (BigInt(e.currentExposureUsdtWei) >= BigInt(e.exposureCapUsdtWei)))) throw unavailable();
  }
  const cappedAssets = config.assets.filter(a => a.asset !== config.numeraire && a.weightBps > 0 && exposure.some(e => e.address === a.asset && e.buyPaused)).map(a => a.asset).sort();
  if (cappedAssets.length === 0) return { execution: config, effectiveAllocation: null, allocationReason: 'version' as const, cappedAssets };
  const retained = config.assets.filter(a => !cappedAssets.includes(a.asset) && a.weightBps > 0);
  if (!retained.some(a => a.asset !== config.numeraire)) throw new AppError(409, 'FUND_FULL', '這檔基金暫時額滿');
  const denominator = retained.reduce((sum, a) => sum + a.weightBps, 0);
  const rounded = retained.map(a => ({ asset: a.asset, bps: Math.floor(a.weightBps * 10000 / denominator), remainder: a.weightBps * 10000 % denominator }))
    .sort((a, b) => b.remainder - a.remainder || a.asset.localeCompare(b.asset));
  const dust = 10000 - rounded.reduce((sum, a) => sum + a.bps, 0);
  const effectiveAllocation = Object.fromEntries(rounded.map((a, i) => [a.asset, a.bps + (i < dust ? 1 : 0)]));
  const execution: AssetExecution = { ...config, assets: config.assets.filter(a => !cappedAssets.includes(a.asset))
    .map(a => ({ ...a, weightBps: effectiveAllocation[a.asset] ?? 0 })) };
  return { execution, effectiveAllocation, allocationReason: 'exposure_cap' as const, cappedAssets };
}

export async function setAssetExposureCap(symbol: string, input: unknown, query: Query = dbQuery) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(symbol) || !record(input)) throw new ValidationError('INVALID_EXPOSURE_CAP', 'expected an asset symbol and { exposureCapUsdtWei, source }');
  exactKeys(input, ['exposureCapUsdtWei', 'source'], 'INVALID_EXPOSURE_CAP');
  const cap = input.exposureCapUsdtWei;
  if ((cap !== null && (typeof cap !== 'string' || !/^[1-9][0-9]{0,37}$/.test(cap))) || typeof input.source !== 'string' || !input.source.trim() || input.source.length > 500 || /[\u0000-\u001f\u007f]/.test(input.source)) {
    throw new ValidationError('INVALID_EXPOSURE_CAP', 'cap must be null or a positive integer USDT wei string (up to 38 digits); source is required (1..500 characters)');
  }
  try {
    const result = await query(`update priceable_assets set max_fund_exposure_usdt=$2,max_fund_exposure_source=$3,
      max_fund_exposure_updated_at=clock_timestamp() where symbol=$1 and (not is_numeraire or $2::numeric is null)
      returning symbol,max_fund_exposure_usdt::text as "exposureCapUsdtWei",max_fund_exposure_source as source,max_fund_exposure_updated_at as "updatedAt"`, [symbol, cap, input.source.trim()]);
    if (result.rows[0]) return result.rows[0];
    const existing = await query('select symbol from priceable_assets where symbol=$1', [symbol]);
    if (!existing.rows.length) throw new NotFoundError('asset symbol not found');
    throw new ValidationError('INVALID_EXPOSURE_CAP', 'numeraire cannot have an exposure cap');
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'EXPOSURE_STORAGE_UNAVAILABLE', 'exposure cap storage unavailable');
  }
}
