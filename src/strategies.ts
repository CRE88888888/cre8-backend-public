import { withRelayerLock } from './relayer-lock.js';
import { configuredChainId, TESTNET_97, testnetAssets } from './testnet-profile.js';
import { assertVersionOnchain, getChain, isChainConfigured, publishVersionOnchain, registerStrategyOnchain } from './chain.js';
import { isForeignKeyViolation, isUniqueViolation, query, withTransaction } from './db.js';
import { AppError, ForbiddenError, NotFoundError, ValidationError } from './errors.js';
import { canonicalConfigHash, exactKeys, minimumAllocationRaw, record, utcDate, validateExecution, validateFundingSchedule, validateIdleYield, numeraireFor, validateAssetConfig, minimumAssetContribution } from './strategy-execution.js';
import type { FundingSchedule, TypedExecution } from './strategy-execution.js';
import type { Address, Hex } from 'viem';

/** Basis-point denominator. On-chain AtpRegistry uses the same TOTAL_WEIGHT_BPS. */
export const BPS_DENOMINATOR = 10_000;
/** Max output-side swap fee, mirrors AtpRegistry.MAX_SWAP_FEE_BPS (3%). */
export const MAX_SWAP_FEE_BPS = 300;
/** Minimum rebalance interval accepted by validation: anything faster is a keeper/gas footgun. */
export const MIN_INTERVAL_SECONDS = 60;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
/** BSC USDT, the numeraire pinned by DeployAtpMainnet (also used on the local BSC fork). */
const USDT_NUMERAIRE_ADDRESS = '0x55d398326f99059ff775485246999027b3197955';
const MAX_PROVIDER_LENGTH = 200;
const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 2_000;

export type AllocationAsset = {
  /** Lowercase EVM address (0x + 40 hex). Normalised by validateAllocation. */
  address: string;
  /** Optional display ticker, e.g. AAPLB. */
  symbol?: string;
  /** Weight in basis points, 1-10000 (USDT may be 0); weights sum to exactly 10000. */
  weightBps: number;
};

export type Allocation = { assets: AllocationAsset[] };

/** Off-chain encoding of the rebalance schedule; hashed on chain as scheduleHash. */
export type RebalanceSchedule =
  | { kind: 'interval'; intervalSeconds: number }
  | { kind: 'cron'; cron: string };

export type Strategy = {
  id: number;
  provider: string;
  name: string;
  description: string;
  isPublic: boolean;
  swapFeeBps: number;
  /** On-chain AtpRegistry id; null until registerStrategyOnchain() succeeds. */
  onchainId: number | null;
  createdAt: string;
};

export type StrategyVersion = {
  strategyId: number;
  version: number;
  allocation: Allocation;
  schedule: RebalanceSchedule | FundingSchedule;
  executionSchemaVersion: 0 | 1 | 2;
  execution: TypedExecution | { kind: 'target_weight' };
  executionChainId: number | null;
  configHash: Hex | null;
  idleYield: { enabled: false };
  changeLog: string | null;
  activeAt: string | null;
  createdAt: string;
};

export type StrategyDetail = Strategy & { versions: StrategyVersion[] };

export type CreateStrategyInput = {
  provider: string;
  name: string;
  description?: string;
  isPublic?: boolean;
  swapFeeBps?: number;
};

export type PublishVersionInput = {
  allocation: unknown;
  schedule?: unknown;
  execution?: unknown;
  chainId?: unknown;
  idleYield?: unknown;
  changeLog?: string | null;
  /** First instant the version may execute; defaults to now. Accepts ISO-8601 or Date. */
  activeAt?: string | Date | null;
};

export type ListStrategiesParams = {
  limit?: number;
  offset?: number;
  provider?: string;
  isPublic?: boolean;
};

export type StrategyPage = {
  items: Strategy[];
  total: number;
  limit: number;
  offset: number;
};

const STRATEGY_COLUMNS = 'id, provider, name, description, is_public, swap_fee_bps, onchain_id, created_at';
const VERSION_COLUMNS =
  'strategy_id, version, allocation, schedule, change_log, active_at, created_at, execution_schema_version, execution, execution_chain_id, config_hash';

type StrategyRow = {
  id: string;
  provider: string;
  name: string;
  description: string;
  is_public: boolean;
  swap_fee_bps: number;
  onchain_id: string | null;
  created_at: Date;
  total_count?: string;
};

type VersionRow = {
  strategy_id: string;
  version: number;
  allocation: unknown;
  schedule: unknown;
  change_log: string | null;
  active_at: Date | null;
  created_at: Date;
  execution_schema_version: 0 | 1 | 2;
  execution: TypedExecution | { kind: 'target_weight' };
  execution_chain_id: string | null;
  config_hash: Hex | null;
};

/** HTTP always uses this path. Untagged internal legacy writers retain their existing encoding. */
export function typedVersionInput(input: unknown): PublishVersionInput {
  if (!record(input)) throw new ValidationError('INVALID_VERSION', 'request body must be a JSON object');
  exactKeys(input, ['allocation', 'schedule', 'execution', 'chainId', 'idleYield', 'changeLog', 'activeAt'], 'INVALID_VERSION');
  const chainId = input.chainId === undefined ? configuredChainId() : input.chainId;
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId <= 0) throw new ValidationError('CHAIN_MISMATCH', 'invalid chainId');
  if(!record(input.allocation))throw new ValidationError('INVALID_ALLOCATION','allocation must be an object');
  exactKeys(input.allocation,['assets'],'INVALID_ALLOCATION');
  if(Array.isArray(input.allocation.assets))for(const a of input.allocation.assets)if(record(a))exactKeys(a,['address','weightBps','symbol'],'INVALID_ASSET');
  const allocation = validateAllocation(input.allocation, chainId);
  if (chainId !== 97) {
    if (chainId !== configuredChainId()) throw new ValidationError('CHAIN_MISMATCH','chainId must match this API deployment');
    if (input.execution !== undefined || input.idleYield !== undefined || (record(input.schedule) && input.schedule.kind === 'funding')) {
      throw new ValidationError('EXECUTION_UNAVAILABLE', 'per-asset funding is only available on chain 97');
    }
    return { allocation, schedule: validateSchedule(input.schedule),
      ...(input.changeLog === undefined ? {} : { changeLog: validateChangeLog(input.changeLog) }),
      ...(input.activeAt === undefined ? {} : { activeAt: validateActiveAt(input.activeAt) }) };
  }
  return { ...input, allocation, execution: validateAssetConfig(input.execution, allocation, chainId),
    schedule: validateFundingSchedule(input.schedule), idleYield: validateIdleYield(input.idleYield) };
}

// ---------------------------------------------------------------------------
// Pure validation (no DB) — also the contract the HTTP layer relies on.
// ---------------------------------------------------------------------------

/**
 * Validate and normalise an allocation:
 *   - exactly the shape { assets: [{ address, symbol?, weightBps }] }
 *   - one or more assets including USDT, addresses unique (case-insensitive), stored lowercase
 *   - integer weights in 1..10000 (USDT may be 0) summing to exactly 10000
 *   - append USDT at weight 0 if absent, so deposits can be spent by the executor
 */
export function validateAllocation(input: unknown, chainId = configuredChainId()): Allocation {
  const numeraire = chainId === 97 ? TESTNET_97.contracts.usdt : USDT_NUMERAIRE_ADDRESS;
  const allowed = chainId === 97 ? new Set<string>(testnetAssets().map((asset) => asset.address)) : null;
  if (!isRecord(input)) {
    throw new ValidationError('INVALID_ALLOCATION', 'allocation must be an object: { assets: [...] }');
  }

  const { assets } = input;
  if (!Array.isArray(assets)) {
    throw new ValidationError('INVALID_ALLOCATION', 'allocation.assets must be an array');
  }
  if (assets.length === 0) {
    throw new ValidationError('ALLOCATION_EMPTY', 'allocation.assets must contain at least one asset');
  }

  const seen = new Set<string>();
  const normalised: AllocationAsset[] = [];
  let sum = 0;

  assets.forEach((entry: unknown, index: number) => {
    if (!isRecord(entry)) {
      throw new ValidationError('INVALID_ASSET', `allocation.assets[${index}] must be an object`);
    }

    const rawAddress = entry.address;
    if (typeof rawAddress !== 'string' || !ADDRESS_PATTERN.test(rawAddress.trim())) {
      throw new ValidationError(
        'INVALID_ASSET',
        `allocation.assets[${index}].address must be a 0x-prefixed 20-byte hex address`,
      );
    }
    const address = rawAddress.trim().toLowerCase();
    if (allowed !== null && !allowed.has(address)) throw new ValidationError('INVALID_ASSET', 'asset is not in the chain 97 profile');
    if (seen.has(address)) {
      throw new ValidationError('DUPLICATE_ASSET', `allocation.assets[${index}] duplicates asset ${address}`);
    }
    seen.add(address);

    const weightBps = entry.weightBps;
    const minWeightBps = address === numeraire ? 0 : 1;
    if (
      typeof weightBps !== 'number' ||
      !Number.isInteger(weightBps) ||
      weightBps < minWeightBps ||
      weightBps > BPS_DENOMINATOR
    ) {
      throw new ValidationError(
        'WEIGHT_OUT_OF_RANGE',
        `allocation.assets[${index}].weightBps must be an integer in ${minWeightBps}..${BPS_DENOMINATOR}`,
      );
    }
    sum += weightBps;

    const asset: AllocationAsset = { address, weightBps };
    if (entry.symbol !== undefined) {
      if (
        typeof entry.symbol !== 'string' ||
        entry.symbol.trim() === '' ||
        entry.symbol.trim().length > 32
      ) {
        throw new ValidationError(
          'INVALID_ASSET',
          `allocation.assets[${index}].symbol must be a non-empty string of at most 32 characters`,
        );
      }
      asset.symbol = entry.symbol.trim();
    }
    normalised.push(asset);
  });

  if (sum !== BPS_DENOMINATOR) {
    throw new ValidationError(
      'WEIGHT_SUM',
      `allocation weights must sum to ${BPS_DENOMINATOR} bps, got ${sum}`,
    );
  }

  if (!seen.has(numeraire)) {
    normalised.push({ address: numeraire, symbol: 'USDT', weightBps: 0 });
  }

  if (chainId === 56 && normalised.length > 16) throw new ValidationError('TOO_MANY_ASSETS', 'chain 56 supports at most 16 assets including USDT');

  return { assets: normalised };
}

/** Validate a rebalance schedule: { kind: "interval", intervalSeconds >= 60 } or { kind: "cron", cron }. */
export function validateSchedule(input: unknown): RebalanceSchedule {
  if (!isRecord(input)) {
    throw new ValidationError(
      'INVALID_SCHEDULE',
      'schedule must be an object: { kind: "interval" | "cron", ... }',
    );
  }

  if (input.kind === 'interval') {
    const intervalSeconds = input.intervalSeconds;
    if (
      typeof intervalSeconds !== 'number' ||
      !Number.isInteger(intervalSeconds) ||
      intervalSeconds < MIN_INTERVAL_SECONDS
    ) {
      throw new ValidationError(
        'INVALID_SCHEDULE',
        `schedule.intervalSeconds must be an integer >= ${MIN_INTERVAL_SECONDS}`,
      );
    }
    return { kind: 'interval', intervalSeconds };
  }

  if (input.kind === 'cron') {
    const cron = input.cron;
    if (typeof cron !== 'string' || cron.trim() === '' || cron.trim().length > 120) {
      throw new ValidationError(
        'INVALID_SCHEDULE',
        'schedule.cron must be a non-empty string of at most 120 characters',
      );
    }
    return { kind: 'cron', cron: cron.trim() };
  }

  throw new ValidationError('INVALID_SCHEDULE', 'schedule.kind must be "interval" or "cron"');
}

/**
 * Validate POST /strategies input and apply defaults (public, 0 bps, empty description).
 *
 * `provider` comes from the authenticated session, never from the body: any `provider` field in
 * the payload is ignored, so a client cannot create a strategy under another wallet's address.
 * It is lowercased here — migration 0002 makes lowercase the only storable form
 * (`check (provider = lower(provider))`), so this is the single normalisation point for writes.
 */
export function validateCreateStrategyInput(
  input: unknown,
  provider: string,
): Required<CreateStrategyInput> {
  if (!isRecord(input)) {
    throw new ValidationError('INVALID_STRATEGY', 'request body must be a JSON object');
  }
  exactKeys(input, ['provider', 'name', 'description', 'isPublic', 'swapFeeBps'], 'INVALID_STRATEGY');

  const owner = requireString(provider, 'provider', MAX_PROVIDER_LENGTH).toLowerCase();
  const name = requireString(input.name, 'name', MAX_NAME_LENGTH);

  let description = '';
  if (input.description !== undefined && input.description !== null) {
    if (typeof input.description !== 'string') {
      throw new ValidationError('INVALID_STRATEGY', 'description must be a string');
    }
    if (input.description.length > MAX_DESCRIPTION_LENGTH) {
      throw new ValidationError(
        'INVALID_STRATEGY',
        `description must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
      );
    }
    description = input.description;
  }

  let isPublic = true;
  if (input.isPublic !== undefined) {
    if (typeof input.isPublic !== 'boolean') {
      throw new ValidationError('INVALID_STRATEGY', 'isPublic must be a boolean');
    }
    isPublic = input.isPublic;
  }

  let swapFeeBps = 0;
  if (input.swapFeeBps !== undefined && input.swapFeeBps !== null) {
    if (
      typeof input.swapFeeBps !== 'number' ||
      !Number.isInteger(input.swapFeeBps) ||
      input.swapFeeBps < 0 ||
      input.swapFeeBps > MAX_SWAP_FEE_BPS
    ) {
      throw new ValidationError(
        'INVALID_SWAP_FEE',
        `swapFeeBps must be an integer in 0..${MAX_SWAP_FEE_BPS}`,
      );
    }
    swapFeeBps = input.swapFeeBps;
  }

  return { provider: owner, name, description, isPublic, swapFeeBps };
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

/**
 * Ownership gate shared by every provider-scoped write: the session wallet must be the strategy's
 * provider. Addresses are compared case-insensitively because EIP-55 casing is cosmetic.
 */
export function assertProviderOwns(strategyProvider: string, provider: string): void {
  if (strategyProvider.trim().toLowerCase() !== provider.trim().toLowerCase()) {
    throw new ForbiddenError('strategy belongs to another provider');
  }
}

/**
 * Create a strategy owned by `provider` (the authenticated session wallet). The body is validated
 * for everything else; a `provider` field inside it is ignored.
 *
 * When the chain is configured (RPC_URL / OPERATOR_PRIVATE_KEY / REGISTRY_ADDRESS), the strategy is
 * also registered on the on-chain AtpRegistry first, and its on-chain id is stored on the row. When
 * the chain is not configured the row is created with `onchainId: null` (offline mode); enrollment
 * of such a strategy fails until it is mirrored.
 */
export async function createStrategy(rawInput: unknown, provider: string): Promise<Strategy> {
  const input = validateCreateStrategyInput(rawInput, provider);

  let onchainId: number | null = null;
  if (isChainConfigured()) {
    onchainId = await registerStrategyOnchain({
      name: input.name,
      description: input.description,
      isPublic: input.isPublic,
    });
  }

  const { rows } = await query<StrategyRow>(
    `insert into strategies (provider, name, description, is_public, swap_fee_bps, onchain_id)
     values ($1, $2, $3, $4, $5, $6)
     returning ${STRATEGY_COLUMNS}`,
    [input.provider, input.name, input.description, input.isPublic, input.swapFeeBps, onchainId],
  );

  const row = rows[0];
  if (!row) throw new Error('insert into strategies returned no row');
  return mapStrategy(row);
}

/**
 * Paginated list. `total` is the row count matching the filter, not the page size.
 *
 * The `provider` filter is case-insensitive: the parameter is lowercased and matched exactly,
 * which stays index-friendly and agrees with the lowercase-only storage enforced by migration 0002.
 */
export async function listStrategies(params: ListStrategiesParams = {}): Promise<StrategyPage> {
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ValidationError('INVALID_PAGINATION', 'limit must be an integer in 1..100');
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ValidationError('INVALID_PAGINATION', 'offset must be an integer >= 0');
  }

  const provider = params.provider === undefined ? null : params.provider.trim().toLowerCase();

  const { rows } = await query<StrategyRow>(
    `select ${STRATEGY_COLUMNS}, count(*) over() as total_count
       from strategies
      where ($1::text is null or provider = $1)
        and ($2::boolean is null or is_public = $2)
      order by created_at desc, id desc
      limit $3 offset $4`,
    [provider, params.isPublic ?? null, limit, offset],
  );

  const first = rows[0];
  return {
    items: rows.map(mapStrategy),
    total: first?.total_count === undefined ? 0 : Number(first.total_count),
    limit,
    offset,
  };
}

/** One strategy plus its version history, newest version first. */
export async function getStrategy(id: number): Promise<StrategyDetail> {
  const { rows } = await query<StrategyRow>(`select ${STRATEGY_COLUMNS} from strategies where id = $1`, [
    id,
  ]);
  const row = rows[0];
  if (!row) throw new NotFoundError(`strategy ${id} not found`);

  const versions = await query<VersionRow>(
    `select ${VERSION_COLUMNS}
       from strategy_versions
      where strategy_id = $1
      order by version desc`,
    [id],
  );

  return { ...mapStrategy(row), versions: versions.rows.map(mapVersion) };
}

/**
 * Append a new version. Version numbers are assigned here (max + 1) and protected by the
 * (strategy_id, version) primary key: on a concurrent publish the unique violation is retried.
 *
 * The strategy row stays untouched; existing portfolios keep the version they pinned.
 *
 * `provider` is the authenticated session wallet: publishing requires ownership, so a caller can
 * only append versions to its own strategies (403 FORBIDDEN otherwise).
 */
export type TypedPublishDeps = {
  isChainConfigured: typeof isChainConfigured;
  validateChain: () => void;
  publishOnchain: typeof publishVersionOnchain;
  relayerLock: typeof withRelayerLock;
};

export async function publishVersion(
  strategyId: number,
  input: PublishVersionInput,
  provider: string,
  deps: Partial<TypedPublishDeps> = {},
): Promise<StrategyVersion> {
  exactKeys(input, ['allocation', 'schedule', 'execution', 'chainId', 'idleYield', 'changeLog', 'activeAt'], 'INVALID_VERSION');
  if (input.execution !== undefined || input.chainId !== undefined || input.idleYield !== undefined || (record(input.schedule) && input.schedule.kind === 'funding')) return publishTypedVersion(strategyId, input, provider, deps);
  const allocation = validateAllocation(input.allocation);
  const schedule = validateSchedule(input.schedule);
  const changeLog = validateChangeLog(input.changeLog);
  const activeAt = validateActiveAt(input.activeAt);

  const owner = await query<{ provider: string; onchain_id: string | null }>(
    'select provider, onchain_id from strategies where id = $1',
    [strategyId],
  );
  const ownerRow = owner.rows[0];
  if (ownerRow === undefined) throw new NotFoundError(`strategy ${strategyId} not found`);
  assertProviderOwns(ownerRow.provider, provider);
  const onchainId = ownerRow.onchain_id === null ? null : Number(ownerRow.onchain_id);

  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const version = await nextVersion(strategyId);
    try {
      const { rows } = await query<VersionRow>(
        `insert into strategy_versions (strategy_id, version, allocation, schedule, change_log, active_at)
         values ($1, $2, $3::jsonb, $4::jsonb, $5, $6)
         returning ${VERSION_COLUMNS}`,
        [
          strategyId,
          version,
          JSON.stringify(allocation),
          JSON.stringify(schedule),
          changeLog,
          activeAt,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error('insert into strategy_versions returned no row');
      const mapped = mapVersion(row);

      // Mirror to chain when the strategy is already registered on-chain (onchain_id set).
      if (onchainId !== null && isChainConfigured()) {
        await publishVersionOnchain(onchainId, {
          assets: allocation.assets.map((a) => a.address as `0x${string}`),
          weightsBps: allocation.assets.map((a) => a.weightBps),
          schedule,
          activeAt,
        });
      }

      return mapped;
    } catch (err) {
      if (isUniqueViolation(err)) continue;
      if (isForeignKeyViolation(err)) throw new NotFoundError(`strategy ${strategyId} not found`);
      throw err;
    }
  }

  throw new Error(`could not allocate a version for strategy ${strategyId} after ${attempts} attempts`);
}

async function publishTypedVersion(strategyId: number, raw: PublishVersionInput, provider: string, overrides: Partial<TypedPublishDeps>): Promise<StrategyVersion> {
  const deps: TypedPublishDeps = { isChainConfigured, validateChain: () => { getChain(); }, publishOnchain: publishVersionOnchain, relayerLock: withRelayerLock, ...overrides };
  if(raw.chainId!==undefined&&raw.chainId!==configuredChainId())throw new ValidationError('CHAIN_MISMATCH','chainId must match this API deployment');
  if(configuredChainId()!==97)throw new ValidationError('EXECUTION_UNAVAILABLE','per-asset funding is only available on chain 97');
  const input = typedVersionInput(raw);
  const chainId = input.chainId === undefined ? configuredChainId() : input.chainId;
  if (chainId !== configuredChainId()) throw new ValidationError('CHAIN_MISMATCH', 'chainId must match this API deployment');
  const execution = validateAssetConfig(input.execution, validateAllocation(input.allocation, chainId), chainId);
  if (!record(input.allocation)) throw new ValidationError('INVALID_ALLOCATION', 'allocation must be an object');
  exactKeys(input.allocation, ['assets'], 'INVALID_ALLOCATION');
  if (Array.isArray(input.allocation.assets)) for (const asset of input.allocation.assets) {
    if (record(asset)) exactKeys(asset, ['address', 'weightBps', 'symbol'], 'INVALID_ASSET');
  }
  const allocation = validateAllocation(input.allocation);
  if (execution.assets.some(a => a.execution?.kind === 'stack') && allocation.assets.every((asset) => asset.address === numeraireFor(chainId))) {
    throw new ValidationError('STACK_CASH_ONLY', 'stack requires at least one non-cash asset; choose hold for pure cash');
  }
  const schedule = validateFundingSchedule(input.schedule);
  const changeLog = validateChangeLog(input.changeLog);
  const suppliedAt = input.activeAt === undefined || input.activeAt === null ? null :
    input.activeAt instanceof Date ? input.activeAt : utcDate(input.activeAt, 'activeAt');
  if (suppliedAt !== null && (!Number.isFinite(suppliedAt.getTime()) || suppliedAt.getTime() < 0 || suppliedAt.getTime() % 1000 !== 0)) {
    throw new ValidationError('INVALID_ACTIVE_AT', 'activeAt must be a nonnegative whole-second timestamp');
  }
  try {
    const preflight = (await query<{ provider: string; onchain_id: string | null }>('select provider,onchain_id from strategies where id=$1', [strategyId])).rows[0];
    if (!preflight) throw new NotFoundError(`strategy ${strategyId} not found`);
    assertProviderOwns(preflight.provider, provider);
    if (preflight.onchain_id !== null) {
      if (!deps.isChainConfigured()) throw new AppError(503, 'VERSION_UNAVAILABLE', 'chain mirror configuration unavailable; no new version stored');
      deps.validateChain();
    }
    for (const asset of execution.assets) if (asset.yield !== null) {
      const market = await query(`select 1 from strategy_asset_yield_markets a join yield_markets m on m.chain_id=a.chain_id and m.underlying=a.asset and m.platform_market_id=a.market_id where a.chain_id=$1 and a.asset=$2 and a.market_id=$3 and a.enabled and m.state='active'`, [chainId,asset.asset,asset.yield.market]);
      if (!market.rows.length) throw new ValidationError('YIELD_UNAVAILABLE', 'market is not enabled for this chain and asset');
    }
    // Admit the shared signer before persisting a new immutable version. Busy is safely retryable.
    const saveAndMirror = async (assertHeld: () => void) => {
      assertHeld();
      const written = await withTransaction(async (client) => {
        await client.query("set local lock_timeout='5s'");
        const owner = (await client.query<{ provider: string; onchain_id: string | null }>(
          'select provider, onchain_id from strategies where id=$1 for update', [strategyId])).rows[0];
        if (owner === undefined) throw new NotFoundError(`strategy ${strategyId} not found`);
        assertProviderOwns(owner.provider, provider);
        if (owner.onchain_id !== preflight.onchain_id) throw new AppError(409, 'STRATEGY_CHANGED', 'strategy chain identity changed; retry before publishing');
        const previous = (await client.query<VersionRow>(`select ${VERSION_COLUMNS} from strategy_versions where strategy_id=$1 order by version desc limit 1`, [strategyId])).rows[0];
        // Retry a failed/unknown mirror with the same immutable config, including its original default time.
        const retryAt = previous?.active_at;
        const retry = suppliedAt === null && retryAt !== undefined && retryAt !== null && previous?.config_hash ===
          canonicalConfigHash({ chainId, execution, allocation, schedule, activeAt: retryAt });
        const activeAt = suppliedAt ?? (retry && retryAt ? retryAt : new Date(Math.floor(Date.now() / 1000) * 1000));
        const configHash = canonicalConfigHash({ chainId, execution, allocation, schedule, activeAt });
        if (previous?.config_hash === configHash) return { row: previous, onchainId: owner.onchain_id, created: false };
        const version = (previous?.version ?? 0) + 1;
        if (version > 65535) throw new ValidationError('VERSION_LIMIT', 'strategy version exceeds uint16');
        const row = (await client.query<VersionRow>(`insert into strategy_versions
          (strategy_id,version,allocation,schedule,change_log,active_at,execution_schema_version,execution,execution_chain_id,config_hash)
          values($1,$2,$3::jsonb,$4::jsonb,$5,$6,2,$7::jsonb,$8,$9) returning ${VERSION_COLUMNS}`,
          [strategyId, version, JSON.stringify(allocation), JSON.stringify(schedule), changeLog, activeAt, JSON.stringify(execution), chainId, configHash])).rows[0];
        if (!row) throw new Error('missing version');
        return { row, onchainId: owner.onchain_id, created: true };
      });
      const version = mapVersion(written.row);
      if (written.onchainId !== null) {
        assertHeld();
        await deps.publishOnchain(Number(written.onchainId), { assets: allocation.assets.map((asset) => asset.address as Address),
          weightsBps: allocation.assets.map((asset) => asset.weightBps), schedule, activeAt: written.row.active_at ?? new Date(0),
          configHash: written.row.config_hash ?? undefined, expectedVersion: version.version, allowPublish: written.created }, { lock: async (_chainId, action) => action(assertHeld) });
      }
      return version;
    };
    return preflight.onchain_id === null ? await saveAndMirror(() => {}) : await deps.relayerLock(chainId, saveAndMirror);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'VERSION_UNAVAILABLE', 'version storage or chain confirmation unavailable; retry the same config');
  }
}

/** Pinned version only; latest DB version is never a substitute for chain enrollment. */
export async function requireTypedVersion(strategyId: number, version: number, onchainId: number, account?: Address,
  deps: { chainId?: number; assertOnchain?: typeof assertVersionOnchain; verifyChain?: boolean; blockNumber?: bigint; blockHash?: Hex } = {}): Promise<StrategyVersion> {
  const detail = await getStrategy(strategyId);
  const pinned = detail.versions.find((candidate) => candidate.version === version);
  if (!pinned || ![1,2].includes(pinned.executionSchemaVersion) || pinned.configHash === null || pinned.activeAt === null || pinned.executionChainId !== (deps.chainId ?? configuredChainId())) {
    throw new AppError(409, 'EXECUTION_VERSION_MISMATCH', 'a typed version on this chain is required');
  }
  const config = { chainId: pinned.executionChainId, execution: pinned.execution.kind === 'per_asset' ? validateAssetConfig(pinned.execution,pinned.allocation,pinned.executionChainId) : validateExecution(pinned.execution), allocation: pinned.allocation,
    schedule: validateFundingSchedule(pinned.schedule), activeAt: new Date(pinned.activeAt) };
  if (canonicalConfigHash(config) !== pinned.configHash) throw new AppError(409, 'CONFIG_HASH_MISMATCH', 'stored config hash does not match the pinned version');
  if (deps.verifyChain !== false) await (deps.assertOnchain ?? assertVersionOnchain)(onchainId, version, { ...config, configHash: pinned.configHash }, account, { blockNumber: deps.blockNumber, blockHash: deps.blockHash });
  return pinned;
}

export function typedMinimumDeposit(version: StrategyVersion): string {
  if (version.execution.kind === 'per_asset') return minimumAssetContribution(version.execution).toString();
  return minimumAllocationRaw(version.allocation, version.executionChainId ?? configuredChainId()).toString();
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function mapStrategy(row: StrategyRow): Strategy {
  return {
    id: Number(row.id),
    provider: row.provider,
    name: row.name,
    description: row.description,
    isPublic: row.is_public,
    swapFeeBps: row.swap_fee_bps,
    onchainId: row.onchain_id === null ? null : Number(row.onchain_id),
    createdAt: row.created_at.toISOString(),
  };
}

function mapVersion(row: VersionRow): StrategyVersion {
  return {
    strategyId: Number(row.strategy_id),
    version: row.version,
    // jsonb comes back already parsed; the DB shape check and validateAllocation guard the contents.
    allocation: row.allocation as Allocation,
    schedule: row.schedule as RebalanceSchedule | FundingSchedule,
    executionSchemaVersion: row.execution_schema_version,
    execution: row.execution,
    executionChainId: row.execution_chain_id === null ? null : Number(row.execution_chain_id),
    configHash: row.config_hash,
    idleYield: { enabled: false },
    changeLog: row.change_log,
    activeAt: row.active_at ? row.active_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

async function nextVersion(strategyId: number): Promise<number> {
  const { rows } = await query<{ next_version: number }>(
    'select coalesce(max(version), 0) + 1 as next_version from strategy_versions where strategy_id = $1',
    [strategyId],
  );
  const next = rows[0]?.next_version;
  if (next === undefined) throw new Error(`could not compute next version for strategy ${strategyId}`);
  return Number(next);
}

// ---------------------------------------------------------------------------
// Small validators
// ---------------------------------------------------------------------------

function validateChangeLog(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new ValidationError('INVALID_CHANGE_LOG', 'changeLog must be a string');
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    throw new ValidationError(
      'INVALID_CHANGE_LOG',
      `changeLog must be at most ${MAX_DESCRIPTION_LENGTH} characters`,
    );
  }
  return trimmed;
}

function validateActiveAt(value: unknown): Date {
  if (value === undefined || value === null) return new Date();
  if(typeof value!=='string'&&!(value instanceof Date))throw new ValidationError('INVALID_ACTIVE_AT','activeAt must be a valid ISO-8601 timestamp');
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError('INVALID_ACTIVE_AT', 'activeAt must be a valid ISO-8601 timestamp');
  }
  return parsed;
}

function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError('INVALID_STRATEGY', `${field} is required and must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new ValidationError('INVALID_STRATEGY', `${field} must be at most ${maxLength} characters`);
  }
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
