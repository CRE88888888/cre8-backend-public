/** #168. Defaults to a read-only plan. --execute is deliberately explicit.
 * Read the reviewed old IDs from the dry-run inventory; never infer identity from a name.
 * OPERATOR_PRIVATE_KEY is read only by the existing chain writer, never from argv or output.
 */
import { readFile, mkdir, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPublicClient, http } from 'viem';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { closePool, query, withConnection, withTransaction } from '../src/db.js';
import { getConfig } from '../src/config.js';
import { getChain, assertVersionOnchain, REGISTRY_ABI, REGISTRY_VERSION_ABI } from '../src/chain.js';
import { createStrategy, getStrategy, publishVersion, typedVersionInput, validateAllocation, validateCreateStrategyInput } from '../src/strategies.js';
import type { StrategyCategory, StrategyDetail, Strategy, PublishVersionInput } from '../src/strategies.js';
import { record, validateAssetConfig } from '../src/strategy-execution.js';
import type { AssetExecution } from '../src/strategy-execution.js';
import { registryConfigHash, typedVersionSettings } from '../src/registry-versioning.js';
import { resolveOperatorWallets } from '../src/waitlist-access.js';
import { TESTNET_97 } from '../src/testnet-profile.js';
import { AppError } from '../src/errors.js';

export type LaunchFund = { key: string; category: StrategyCategory; name: string; description: string;
  input: PublishVersionInput; configHash: Hex };
export type LaunchOptions = { execute: boolean; mag7Id?: number; hideIds: number[] };
export type LaunchEntry = { fund: LaunchFund; existing: StrategyDetail | null; publish: boolean };
export type LaunchPlan = { entries: LaunchEntry[]; hide: StrategyDetail[]; inventory: StrategyDetail[] };
const CATEGORIES = ['theme', 'person', 'leveraged'];
const MIN_PERFORMANCE_FEE_BPS = 500; // Registry constraint only; this does not deploy/enable the fee ledger.
/** C3 #171: rebalance on a new UTC month or a maximum deviation strictly above 500 bps. */
export const LAUNCH_REBALANCE_MODE: Exclude<AssetExecution['rebalance'], 'none'> = 'monthly_drift';

/** Addresses always come from the merged backend testnet profile, not stale research snapshots. */
export function launchFunds(value: unknown): LaunchFund[] {
  if (!record(value) || value.schema_version !== 1 || !Array.isArray(value.funds) || value.funds.length !== 21) {
    throw new Error('lineup must contain schema 1 and exactly 21 funds');
  }
  const tokens = new Map(Object.entries(TESTNET_97.assets).map(([symbol, asset]) => [symbol.toLowerCase(), asset.token]));
  const seen = new Set<string>();
  let components = 0;
  const funds = value.funds.map((raw): LaunchFund => {
    if (!record(raw) || typeof raw.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(raw.id) || seen.has(raw.id) ||
        typeof raw.name !== 'string' || !raw.name.trim() || !CATEGORIES.includes(String(raw.category)) ||
        !Array.isArray(raw.components) || !raw.components.length) throw new Error('invalid or duplicate lineup fund');
    const category = raw.category;
    if (category !== 'theme' && category !== 'person' && category !== 'leveraged') throw new Error('invalid category');
    seen.add(raw.id);
    const assets = raw.components.map((part: unknown) => {
      if (!record(part) || typeof part.asset_id !== 'string' || !Number.isSafeInteger(part.weight_bps) ||
          Number(part.weight_bps) < 1 || Number(part.weight_bps) > 10000 || (part.role !== 'core' && part.role !== 'satellite')) {
        throw new Error('invalid lineup component');
      }
      const address = tokens.get(part.asset_id.toLowerCase());
      if (!address) throw new Error('lineup component is missing from the testnet profile');
      if (part.role === 'satellite' && part.weight_bps !== 500) throw new Error('satellite weight must be 500 bps');
      return { address, symbol: part.asset_id, weightBps: Number(part.weight_bps) };
    });
    components += assets.length;
    const allocation = validateAllocation({ assets }, 97);
    const execution = validateAssetConfig({ ...validateAssetConfig(undefined, allocation, 97), rebalance: LAUNCH_REBALANCE_MODE }, allocation, 97);
    const input = typedVersionInput({ allocation, chainId: 97, execution, schedule: { kind: 'funding' },
      performanceFeeBps: MIN_PERFORMANCE_FEE_BPS, changeLog: '首發名單：所有成分一次買齊，依核准權重配置。' });
    const settings = typedVersionSettings({ allocation, execution, chainId: 97, schedule: { kind: 'funding' }, activeAt: new Date(0) }, MIN_PERFORMANCE_FEE_BPS);
    const name = raw.id === 'mag7' ? '美股七巨頭 Mag7' : raw.id === 'pelosi' ? '佩洛西持倉' : raw.name;
    const description = `${name}：${assets.map(a => a.symbol).join('、')}，所有成分一次買齊，最低存入 50 USDT。` +
      (category === 'leveraged' ? '高風險槓桿基金，每日重設倍數可能產生耗損。' : '');
    const metadata = validateCreateStrategyInput({ name, description, category, catalogKey: raw.id }, TESTNET_97.roles.operator);
    return { key: raw.id, category, name: metadata.name, description: metadata.description, input,
      configHash: registryConfigHash(allocation.assets.map(a => a.address as Address), allocation.assets.map(a => a.weightBps), settings) };
  });
  if (!seen.has('mag7') || components !== 80 || funds.filter(f => f.category === 'theme').length !== 15 ||
      funds.filter(f => f.category === 'person').length !== 4 || funds.filter(f => f.category === 'leveraged').length !== 2) {
    throw new Error('lineup must contain Mag7, 80 components and categories 15/4/2');
  }
  return funds;
}

export function planLaunch(funds: LaunchFund[], inventory: StrategyDetail[], provider: string, options: LaunchOptions): LaunchPlan {
  const own = (s: Strategy) => {
    if (s.provider.toLowerCase() !== provider.toLowerCase()) throw new Error('strategy is not owned by the launch operator');
  };
  if (new Set(options.hideIds).size !== options.hideIds.length || options.hideIds.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('invalid old strategy IDs');
  const byKey = new Map<string, StrategyDetail>();
  for (const s of inventory) if (s.catalogKey !== null) {
    if (byKey.has(s.catalogKey)) throw new Error('duplicate catalog key');
    byKey.set(s.catalogKey, s);
  }
  const mag7 = options.mag7Id === undefined ? null : inventory.find(s => s.id === options.mag7Id);
  if (options.mag7Id !== undefined && (!mag7 || (mag7.catalogKey !== null && mag7.catalogKey !== 'mag7'))) throw new Error('invalid existing Mag7 ID');
  if (mag7 && byKey.has('mag7') && byKey.get('mag7')?.id !== mag7.id) throw new Error('Mag7 catalog identity conflicts');
  if (mag7) { own(mag7); byKey.set('mag7', mag7); }
  if (!byKey.has('mag7') && inventory.some(s => s.provider.toLowerCase() === provider.toLowerCase() && s.catalogKey === null)) {
    throw new Error('identify the existing Mag7 explicitly with --mag7-id before launch');
  }
  const entries = funds.map(fund => {
    const existing = byKey.get(fund.key) ?? null;
    if (existing) {
      own(existing);
      if (existing.onchainId === null) throw new Error('catalog strategy has no onchain identity; reconcile before launch');
    }
    return { fund, existing, publish: !existing || existing.versions[0]?.configHash !== fund.configHash };
  });
  const kept = new Set(entries.flatMap(e => e.existing ? [e.existing.id] : []));
  const hide = options.hideIds.map(id => {
    const old = inventory.find(s => s.id === id);
    if (!old || kept.has(id) || old.catalogKey !== null) throw new Error('old strategy ID missing or belongs to a catalogue fund');
    own(old); return old;
  });
  // Force an explicit review of all existing public, uncatalogued operator funds.
  // The caller supplies the IDs; this tool never decides which old fund is Mag7 by name.
  const unresolved = inventory.filter(s => s.isPublic && s.provider.toLowerCase() === provider.toLowerCase() &&
    s.catalogKey === null && !kept.has(s.id) && !options.hideIds.includes(s.id));
  if (unresolved.length) throw new Error('review old public inventory and provide --mag7-id / --hide-ids before launch');
  return { entries, hide, inventory };
}

export function launchSummary(plan: LaunchPlan) {
  return { mode: 'dry-run', funds: plan.entries.map(({ fund, existing, publish }) => ({ catalogKey: fund.key,
    category: fund.category, name: fund.name, strategyId: existing?.id ?? null,
    action: existing === null ? 'create' : publish ? 'publish-version' : 'skip', input: fund.input })),
    hideIds: plan.hide.filter(s => s.isPublic).map(s => s.id), hiddenUsing: 'strategies.is_public=false' };
}

export type LaunchDeps = {
  authorize: () => Promise<void>;
  create: (fund: LaunchFund) => Promise<Strategy>;
  publish: (id: number, fund: LaunchFund) => Promise<void>;
  verify: (strategy: StrategyDetail, fund: LaunchFund) => Promise<void>;
  finalize: (entries: { id: number; fund: LaunchFund }[], hideIds: number[]) => Promise<void>;
  beforeCreate: (key: string) => Promise<void>;
  afterCreate: (key: string, id: number) => Promise<void>;
};

export async function executeLaunch(plan: LaunchPlan, options: LaunchOptions, deps: LaunchDeps): Promise<void> {
  if (!options.execute) return;
  await deps.authorize();
  // Confirm every existing identity before any metadata or chain write.
  for (const entry of plan.entries) if (entry.existing && !entry.publish) await deps.verify(entry.existing, entry.fund);
  const published: { id: number; fund: LaunchFund }[] = [];
  for (const { fund, existing, publish } of plan.entries) {
    const strategy: Strategy = existing ?? await (async () => {
      await deps.beforeCreate(fund.key);
      const created = await deps.create(fund);
      await deps.afterCreate(fund.key, created.id);
      return created;
    })();
    if (publish) await deps.publish(strategy.id, fund);
    if (!existing || existing.category !== fund.category || existing.catalogKey !== fund.key || !existing.isPublic) published.push({ id: strategy.id, fund });
  }
  // Publish the public catalogue atomically only after all chain confirmations.
  const hideIds = plan.hide.filter(s => s.isPublic).map(s => s.id);
  if (published.length || hideIds.length) await deps.finalize(published, hideIds);
}

export function validateLaunchSigner(signer: string, provider: string, registryOperator: string, wallets: readonly string[]): void {
  const normalized = signer.toLowerCase();
  if (normalized !== provider.toLowerCase() || normalized !== registryOperator.toLowerCase() ||
      !wallets.some(wallet => wallet.toLowerCase() === normalized)) throw new Error('launch signer is not an authorized operator');
}

/** Registration is chain-first in createStrategy. A durable intent prevents a second
 * registration after an unknown RPC result or a DB failure. Never silently discard this file.
 * A persisted catalog row is sufficient to resume; otherwise C3 must reconcile chain and DB.
 */
export class RegistrationJournal {
  constructor(private readonly directory: string) {}
  async before(key: string): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    let file: FileHandle;
    try { file = await open(resolve(this.directory, key + '.json'), 'wx', 0o600); }
    catch { throw new Error('registration intent exists or cannot be persisted; reconcile chain and DB before retrying'); }
    try { await file.writeFile(JSON.stringify({ catalogKey: key, state: 'registration-started' })); await file.sync(); }
    finally { await file.close(); }
  }
  async after(key: string, id: number): Promise<void> {
    const file = await open(resolve(this.directory, key + '.json'), 'r+');
    try { await file.truncate(); await file.writeFile(JSON.stringify({ catalogKey: key, strategyId: id, state: 'registered' })); await file.sync(); }
    finally { await file.close(); }
  }
}

export function launchArgs(argv: string[]) {
  const result: LaunchOptions & { lineup: string; journal: string } = { execute: false, hideIds: [],
    lineup: resolve('../docs/research/2026-11-20-launch-lineup/lineup.json'), journal: resolve('.bun-cache/testnet-launch-97') };
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag || seen.has(flag)) throw new Error('unknown or duplicate launch option');
    seen.add(flag);
    if (flag === '--execute') { result.execute = true; continue; }
    if (!['--lineup', '--mag7-id', '--hide-ids', '--journal'].includes(flag)) throw new Error('unknown launch option');
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error('missing launch option value');
    const id = (raw: string) => { const n = Number(raw); if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(n)) throw new Error('invalid strategy ID'); return n; };
    if (flag === '--lineup') result.lineup = resolve(value);
    if (flag === '--journal') result.journal = resolve(value);
    if (flag === '--mag7-id') result.mag7Id = id(value);
    if (flag === '--hide-ids') result.hideIds = value.split(',').map(id);
  }
  return result;
}

async function main() {
  const options = launchArgs(process.argv.slice(2));
  const config = getConfig();
  if (config.chainId !== 97) throw new Error('launch tool requires CHAIN_ID=97');
  const allowed = resolveOperatorWallets();
  if (allowed.length !== 1) throw new Error('set exactly one reviewed launch OPERATOR_WALLETS address');
  const provider = allowed[0];
  if (!provider || !config.rpcUrl || !config.registryAddress) throw new Error('launch RPC and registry configuration required');
  const client = createPublicClient({ transport: http(config.rpcUrl, { retryCount: 0, timeout: 15000 }) });
  if (await client.getChainId() !== 97) throw new Error('launch RPC must use chain 97');
  const registryOperator = await client.readContract({ address: config.registryAddress as Address, abi: REGISTRY_ABI, functionName: 'operator' });
  if (registryOperator.toLowerCase() !== provider) throw new Error('launch operator must match registry.operator');
  const funds = launchFunds(JSON.parse(await readFile(options.lineup, 'utf8')));
  await withConnection(async (connection, discard) => {
    // Serializes this catalogue launcher across processes, including dry-run inventory reads.
    if ((await connection.query<{ locked: boolean }>('select pg_try_advisory_lock($1) as locked', [81680097])).rows[0]?.locked !== true) throw new Error('another catalogue launch is running');
    try {
      // Resolve 0054 columns even when the table is empty, before registering anything.
      const ids = (await query<{ id: string }>('select id, category, catalog_key from strategies order by id')).rows;
      const inventory: StrategyDetail[] = [];
      for (const row of ids) inventory.push(await getStrategy(Number(row.id)));
      console.log(JSON.stringify({ inventory: inventory.map(s => ({ id: s.id, provider: s.provider, name: s.name, isPublic: s.isPublic, catalogKey: s.catalogKey })) }));
      const plan = planLaunch(funds, inventory, provider, options);
      console.log(JSON.stringify(launchSummary(plan)));
      const journal = new RegistrationJournal(options.journal);
      await executeLaunch(plan, options, {
        authorize: async () => {
          if (!config.operatorPrivateKey || !/^0x[0-9a-fA-F]{64}$/.test(config.operatorPrivateKey)) throw new Error('launch signer is not an authorized operator');
          const freshOperator = await client.readContract({ address: config.registryAddress as Address, abi: REGISTRY_ABI, functionName: 'operator' });
          validateLaunchSigner(privateKeyToAccount(config.operatorPrivateKey as Hex).address, provider, freshOperator, resolveOperatorWallets());
          getChain();
        },
        create: fund => createStrategy({ name: fund.name, description: fund.description, isPublic: false, category: fund.category, catalogKey: fund.key }, provider),
        publish: async (id, fund) => {
          console.log(JSON.stringify({ action: 'publish', strategyId: id, catalogKey: fund.key }));
          await publishVersion(id, fund.input, provider);
        },
        verify: async (s, fund) => {
          const version = s.versions[0];
          if (s.onchainId === null || !version?.activeAt || version.execution.kind !== 'per_asset') throw new Error('catalog version unavailable');
          const allocation = validateAllocation(fund.input.allocation, 97);
          if (await client.readContract({ address: config.registryAddress as Address, abi: REGISTRY_VERSION_ABI, functionName: 'cancelledVersion', args: [BigInt(s.onchainId), version.version] })) throw new Error('catalogue version was cancelled; reconcile before launch');
          await assertVersionOnchain(s.onchainId, version.version, { allocation, chainId: 97,
            activeAt: new Date(version.activeAt), configHash: fund.configHash, versionSettings: version.versionSettings },
          undefined, { client, registry: config.registryAddress as Address, requireActive: false });
        },
        finalize: (entries, ids) => withTransaction(async connection => {
          for (const { id, fund } of entries) {
            const result = await connection.query(`update strategies set category=$3,catalog_key=$4,is_public=true
              where id=$1 and provider=$2 and (catalog_key is null or catalog_key=$4) returning id`, [id, provider, fund.category, fund.key]);
            if (result.rows.length !== 1) throw new Error('catalog metadata changed; stop and reconcile');
          }
          if (ids.length) {
            const result = await connection.query('update strategies set is_public=false where id=any($1::bigint[]) and provider=$2 and catalog_key is null returning id', [ids, provider]);
            if (result.rows.length !== ids.length) throw new Error('old catalogue changed; stop and reconcile');
          }
        }),
        beforeCreate: async key => { console.log(JSON.stringify({ action: 'register', catalogKey: key })); await journal.before(key); },
        afterCreate: (key, id) => journal.after(key, id),
      });
      if (options.execute) console.log(JSON.stringify({ mode: 'executed', funds: plan.entries.length, hidden: plan.hide.filter(s => s.isPublic).length }));
    } finally {
      try { if ((await connection.query<{ unlocked: boolean }>('select pg_advisory_unlock($1) as unlocked', [81680097])).rows[0]?.unlocked !== true) discard(); }
      catch { discard(); }
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error('[testnet-launch] launch failed' + (error instanceof AppError ? ' (' + error.code + ')' : '') + '; review plan, operator, registration journal and chain/DB state before retrying'); process.exitCode = 1; })
    .finally(closePool);
}
