import { MIX_CREATION_COLUMNS, mixRequestKey, mixRequestHash, withMixCreationLock } from './mix-creation.js';
import type { MixCreation } from './mix-creation.js';
import { randomBytes } from 'node:crypto';
import type { Address, Hex } from 'viem';
import { syncMixEnrollmentFlows } from './mix-flows.js';
import { getChain } from './chain.js';
import { query, withTransaction } from './db.js';
import { AppError, ValidationError } from './errors.js';
import { mixSettings, mixChainAllocation, nextMixRebalance, mixKeys } from './mix-domain.js';
import type { MixSettings } from './mix-domain.js';
import { assetsMarketOpen } from './trading-calendar.js';
import { imageUrl } from './user-media.js';
import { nextMixMarketOpen } from './mix-preview.js';
import { createMixPreview } from './mix-preview.js';
import { record } from './strategy-execution.js';
import { computeSalt } from './kernel.js';
import { preparePortfolioEnrollment, enrollPortfolio } from './portfolios.js';
import { planPortfolio } from './snapshot.js';
import { configuredChainId, TESTNET_97 } from './testnet-profile.js';
import { registerMixStrategy, prepareMixCalls, readMixEnrollmentProof, mixIntentContext, findMixEnrollment } from './mix-chain.js';
import { MIX_COLUMNS, currentMixHistory, pendingMixIntent, userMixAssets, mixUnavailable, mixBusy, withMixLock, quiesceMix, confirmMixSegment, logMixFailure } from './mix-store.js';
import type { MixRow, MixSnapshot } from './mix-store.js';
import { mixAnchor, mixValue, saveMixValuation } from './mix-valuation.js';
import type { MixValuation } from './mix-valuation.js';
import { MIX_EXIT_DUST_RAW } from './mix-runtime.js';
import { mixStrategyConsentCalls } from './strategy-earn.js';

export type MixServiceDeps = {
  query: typeof query; transaction: typeof withTransaction; lock: typeof withMixLock; now: () => Date; chainId: () => number;
  creationLock: typeof withMixCreationLock; register: typeof registerMixStrategy; prepareAccount: typeof preparePortfolioEnrollment; enroll: typeof enrollPortfolio;
  calls: typeof prepareMixCalls; proof: typeof readMixEnrollmentProof; plan: typeof planPortfolio;
  preview: ReturnType<typeof createMixPreview>;
  maxAssets: () => Promise<number>; anchor: typeof mixAnchor; context: typeof mixIntentContext; findEnrollment: typeof findMixEnrollment;
  syncFlows: (m: MixRow, proof: import('./mix-store.js').MixEnrollmentProof) => Promise<void>;
  /** Yield strategy consent to re-sign with a weight change (src/strategy-earn.ts mixStrategyConsentCalls); [] when off. */
  strategyConsent: typeof mixStrategyConsentCalls;
};
const defaults: MixServiceDeps = { query, transaction: withTransaction, lock: withMixLock, now: () => new Date(), chainId: configuredChainId,
  creationLock: withMixCreationLock, register: registerMixStrategy, prepareAccount: preparePortfolioEnrollment, enroll: enrollPortfolio, calls: prepareMixCalls,
  proof: readMixEnrollmentProof, plan: planPortfolio, anchor: mixAnchor, context: mixIntentContext, findEnrollment: findMixEnrollment, preview: createMixPreview(), syncFlows: async (m, proof) => {
    await syncMixEnrollmentFlows(getChain().publicClient, m, proof);
  }, strategyConsent: (input) => mixStrategyConsentCalls(input), maxAssets: async () => Number(await getChain().publicClient.readContract({ address: getChain().registryAddress, abi: (await import('./registry-abi.js')).REGISTRY_VERSION_ABI, functionName: 'MAX_STRATEGY_ASSETS' })) };
const MIX_CASH = TESTNET_97.contracts.usdt.toLowerCase();
const notFound = () => new AppError(404, 'MIX_NOT_FOUND', '找不到這個私人組合或分享連結。');
export function createMixService(overrides: Partial<MixServiceDeps> = {}) {
  const deps = { ...defaults, ...overrides };
  const db = { query: deps.query };
  async function safe<T>(work: () => Promise<T>): Promise<T> {
    try {
      if (deps.chainId() !== 97) throw new AppError(503, 'MIX_CHAIN_UNAVAILABLE', '私人組合目前僅開放測試網。');
      return await work();
    } catch (e) {
      const error = e instanceof AppError ? e : mixUnavailable('mixes', e);
      if (error.status >= 500) logMixFailure('mixes', error);
      throw error;
    }
  }
  async function owned(id: number, wallet: string): Promise<MixRow> {
    const m = (await deps.query<MixRow>(`select ${MIX_COLUMNS} from mixes m where m.id=$1 and m.owner=$2 and m.deleted_at is null`, [id, wallet.toLowerCase()])).rows[0];
    if (!m) throw notFound();
    return m;
  }
  async function snapshot(m: MixRow): Promise<MixSnapshot> {
    const h = await currentMixHistory(m.id, db);
    const s = (await deps.query<MixSnapshot>('select * from mix_strategy_settings where mix_id=$1 and strategy_id=$2', [m.id, h?.strategy_id ?? m.initial_strategy_id])).rows[0];
    if (!s) throw mixUnavailable(); return s;
  }
  async function publicData(m: MixRow) {
    const s = await snapshot(m);
    return { name: m.name, assets: userMixAssets(s), rebalance: { frequency: m.frequency, startDate: m.start_date },
      createdAt: m.created_at.toISOString(), exit: { takeProfitBps: m.take_profit_bps, stopLossBps: m.stop_loss_bps },
      coverUrl: imageUrl(m.cover_image_id) };
  }
  async function detail(m: MixRow, live = true) {
    const h = await currentMixHistory(m.id, db), intent = await pendingMixIntent(m.id, db), settings = await snapshot(m);
    const cached = async () => (await deps.query<MixValuation>('select * from mix_valuation_snapshots where mix_id=$1', [m.id])).rows[0];
    let valuation = await cached();
    let valuedHoldings: Awaited<ReturnType<typeof planPortfolio>>['snapshot']['holdings'] | null = null;
    if (live && h) {
      try {
        if (m.performance_start_block !== null && (await deps.anchor(BigInt(m.performance_start_block))).hash !== m.performance_start_block_hash) {
          valuation = undefined; throw mixUnavailable();
        }
        const plan = await deps.plan(Number(h.portfolio_id));
        mixValue(plan);
        const anchor = await deps.anchor(plan.snapshot.block);
        if ((await deps.anchor(plan.snapshot.block)).hash !== anchor.hash) throw mixUnavailable();
        await saveMixValuation(deps.query, m.id, Number(h.portfolio_id), plan, anchor);
        valuedHoldings = plan.snapshot.holdings;
        valuation = await cached();
      } catch { /* Keep the last verified estimate, including its observation time. */ }
    }
    const value = valuation ? BigInt(valuation.value_raw) : null;
    const events = (await deps.query<{ id: string; created_at: Date; kind: string; payload: { message?: string } }>(`select id,created_at,kind,payload
      from user_notifications where owner=$1 and portfolio_id in (select portfolio_id from mix_portfolio_history where mix_id=$2)
      and kind like 'mix_%' order by id desc limit 30`, [m.owner, m.id])).rows;
    return { id: Number(m.id), ...await publicData(m), shareCode: m.share_code, account: m.account, portfolioId: h ? Number(h.portfolio_id) : null,
      strategyId: Number(h?.strategy_id ?? m.initial_strategy_id), status: m.delete_requested_at ? (m.status === 'exited' ? 'ready_to_delete' : 'deleting')
        : m.status === 'exited' ? 'exited' : m.triggered_at ? 'exiting' : h ? 'active' : 'awaiting_enrollment',
      pendingChange: intent !== null, currentValueRaw: value?.toString() ?? null,
      netInputRaw: valuation?.net_input_raw ?? null, returnBps: valuation?.return_bps ?? null,
      performanceInputRaw: valuation?.performance_input_raw ?? null,
      performanceStartedAt: (valuation?.performance_started_at ?? m.performance_started_at ?? m.created_at).toISOString(),
      valuedAt: valuation?.valued_at.toISOString() ?? null,
      performanceMessage: value === null ? '目前無法確認組合價值，停利停損暫不觸發。' : valuation?.return_bps === null ? '本期淨投入為零或負數，停利停損暫不觸發。' : null,
      nextRebalanceAt: m.status === 'exited' || m.triggered_at || m.delete_requested_at ? null : nextMixRebalance({ frequency: m.frequency, startDate: m.start_date }, m.last_rebalanced_at).toISOString(),
      residualCash: h && h.residual_cash_raw !== '0' ? { amountRaw: h.residual_cash_raw, reason: h.residual_cash_reason,
        message: '這筆承接現金低於交易門檻，保留在帳戶，計入組合價值，不算新入金。' } : null,
      markets: userMixAssets(settings).map(a => {
        const open = assetsMarketOpen(97, [a.assetId], deps.now());
        return { assetId: a.assetId, open, nextOpenAt: open ? null : nextMixMarketOpen(a.assetId, deps.now())?.toISOString() ?? null };
      }),
      selling: settings.exit_assets.filter(asset => valuedHoldings === null || valuedHoldings.some(h => h.asset.toLowerCase() === asset &&
        h.amountWei > 0n)).map(assetId => ({ assetId,
        message: valuedHoldings === null ? '正在確認舊資產是否已賣出。' : '正在賣出移除的資產；美股於開盤時處理。' })),
      events: events.map(e => ({ id: e.id, at: e.created_at.toISOString(), kind: e.kind, message: e.payload.message ?? '組合狀態已更新。' })) };
  }
  async function complete(m: MixRow, intent: import('./mix-store.js').MixIntent, proof: import('./mix-store.js').MixEnrollmentProof): Promise<number> {
    await deps.syncFlows(m, proof);
    let portfolioId: number;
    if (intent.from_history_id === null) {
      const initial = await deps.enroll(Number(intent.strategy_id), m.owner, { personalMixOwner: m.owner,
        afterWrite: async (client, id) => {
          await confirmMixSegment(m, intent, proof, { initialPortfolioId: id, transaction: fn => fn(client) });
        } });
      const confirmed = await currentMixHistory(m.id, db);
      if (!confirmed || Number(confirmed.portfolio_id) !== initial.id || confirmed.strategy_id !== intent.strategy_id ||
          confirmed.enroll_tx_hash !== proof.txHash || confirmed.enroll_block_hash !== proof.blockHash) throw mixUnavailable();
      portfolioId = initial.id;
    } else portfolioId = await confirmMixSegment(m, intent, proof, { transaction: deps.transaction });
    return portfolioId;
  }
  async function reconcile(m: MixRow, exit = false): Promise<boolean> {
    const intent = await pendingMixIntent(m.id, db);
    if (!intent) return false;
    const result = await deps.findEnrollment(m, intent);
    if (result.kind === 'confirmed') { await complete(m, intent, result.proof); return true; }
    if (result.kind === 'failed') {
      await deps.query("update mix_switch_intents set state='failed',failure_code=$2,updated_at=clock_timestamp() where id=$1 and state in ('prepared','submitted','unknown')", [intent.id, result.code]);
      return true;
    }
    if (intent.state === 'prepared' && intent.user_op_hash === null && (exit || deps.now() >= intent.expires_at)) {
      await deps.query("update mix_switch_intents set state=$2,updated_at=clock_timestamp() where id=$1 and state='prepared' and user_op_hash is null",
        [intent.id, exit ? 'cancelled' : 'expired']);
      return true;
    }
    return false;
  }
  function notDeleting(m: MixRow): void {
    if (m.delete_requested_at) throw new AppError(409, 'MIX_DELETING', '組合正在刪除，不能再變更。');
  }
  /** 刪除：空的組合直接軟刪除；還有資產就沿用整籃退出（加密資產立即、美股開盤時）全部賣成 USDT。
   * session key 只能呼叫 executor，不能把 USDT 轉回 owner，所以 USDT 一律由 owner 簽名領回後再呼叫一次完成刪除。 */
  async function remove(id: number, wallet: string) {
    const m = await owned(id, wallet);
    await reconcile(m, true);
    if (await pendingMixIntent(m.id, db)) throw mixBusy();
    const h = await currentMixHistory(m.id, db);
    if (h) {
      const plan = await deps.plan(Number(h.portfolio_id));
      if (plan.blocked.length || plan.report === null || plan.snapshot.unpriced.some(x => x.amountWei > 0n)) throw mixUnavailable();
      const value = (x: (typeof plan.snapshot.holdings)[number]) => x.amountWei * x.usdPriceE8 * 10n ** 10n / 10n ** BigInt(x.decimals);
      const cash = plan.snapshot.holdings.filter(x => x.asset.toLowerCase() === MIX_CASH).reduce((sum, x) => sum + x.amountWei, 0n);
      const assets = plan.snapshot.holdings.filter(x => x.asset.toLowerCase() !== MIX_CASH).reduce((sum, x) => sum + value(x), 0n);
      // 已退出（停利停損或先前的刪除）的組合，剩下的非現金是退出時記錄的殘留，不再賣。
      if (m.status !== 'exited' && assets >= MIX_EXIT_DUST_RAW) {
        const at = deps.now(), valued = (await deps.query<{ return_bps: string | null }>('select return_bps::text from mix_valuation_snapshots where mix_id=$1', [m.id])).rows[0];
        await deps.transaction(async client => {
          await client.query('select id from mixes where id=$1 for update', [m.id]);
          await client.query(`update mixes set triggered_at=coalesce(triggered_at,$2),triggered_return_bps=coalesce(triggered_return_bps,$3),
            delete_requested_at=coalesce(delete_requested_at,$2) where id=$1`, [m.id, at, valued?.return_bps ?? '0']);
          await client.query(`insert into user_notifications(chain_id,portfolio_id,owner,kind,dedup_key,payload)
            values(97,$1,$2,'mix_delete_requested',$3,$4) on conflict(chain_id,kind,dedup_key) do nothing`,
            [h.portfolio_id, m.owner, String(m.id), JSON.stringify({ message: '已要求刪除：加密資產立即賣出，美股於開盤時賣出；賣完後領回 USDT 即完成刪除。' })]);
          await client.query('update portfolios set next_run_at=null where id=$1', [h.portfolio_id]);
        });
        return { mixId: id, status: 'deleting' as const };
      }
      if (cash >= MIX_EXIT_DUST_RAW) throw new AppError(409, 'MIX_HAS_CASH', '組合帳戶裡還有 USDT，請先領回錢包再刪除。');
    }
    await deps.transaction(async client => {
      await client.query('update mixes set deleted_at=$2 where id=$1 and deleted_at is null', [m.id, deps.now()]);
      if (h) await client.query("update portfolios set schedule_state='paused' where id=$1", [h.portfolio_id]);
    });
    return { mixId: id, status: 'deleted' as const };
  }
  async function prepare(id: number, wallet: string) {
    const m = await owned(id, wallet);
    notDeleting(m);
    await reconcile(m, m.triggered_at !== null);
    let intent = await pendingMixIntent(m.id, db);
    if (!intent && !await currentMixHistory(m.id, db)) {
      const calls = await deps.calls(m, Number(m.initial_strategy_id), []), context = await deps.context(m.account);
      await deps.query('insert into mix_switch_intents(request_key,mix_id,strategy_id,owner_calls,nonce,enroll_from_block) values($1,$2,$3,$4,$5,$6)',
        [randomBytes(24).toString('base64url'), m.id, m.initial_strategy_id, JSON.stringify(calls), context.nonce.toString(), context.fromBlock.toString()]);
      intent = await pendingMixIntent(m.id, db);
    }
    if (!intent) throw new AppError(409, 'MIX_NO_PENDING_CHANGE', '目前沒有需要簽名的組合變更。');
    return { mixId: Number(m.id), strategyId: Number(intent.strategy_id), account: m.account, signingMode: 'sudo' as const,
      expectedVersion: 1, nonce: intent.nonce, expiresAt: intent.expires_at.toISOString(), calls: intent.owner_calls, intentId: intent.id, message: '確認後立即套用新比例；收盤中的股票會在開盤時交易。' };
  }
  async function creationResult(m: MixRow) {
    const intent = (await deps.query<import('./mix-store.js').MixIntent>('select * from mix_switch_intents where mix_id=$1 and strategy_id=$2 order by id desc limit 1', [m.id, m.initial_strategy_id])).rows[0];
    if (!intent) throw mixUnavailable();
    const pending = ['prepared','submitted','unknown'].includes(intent.state);
    return { mixId: Number(m.id), strategyId: Number(m.initial_strategy_id), account: m.account, signingMode: 'sudo' as const,
      expectedVersion: 1, nonce: intent.nonce, expiresAt: intent.expires_at.toISOString(), calls: pending ? intent.owner_calls : [], intentId: intent.id,
      message: pending ? '確認後立即套用新比例；收盤中的股票會在開盤時交易。' : '組合已建立，請開啟組合查看目前狀態。',
      name: m.name, shareCode: m.share_code };
  }
  return {
    reconcileId: (id: string) => safe(async () => {
      const m = (await deps.query<MixRow>(`select ${MIX_COLUMNS} from mixes m where m.id=$1 and m.deleted_at is null`, [id])).rows[0];
      return m ? reconcile(m, m.triggered_at !== null) : false;
    }),
    reconcilePortfolio: (portfolioId: number, exit = false) => safe(async () => {
      const m = (await deps.query<MixRow>(`select ${MIX_COLUMNS} from mixes m join mix_portfolio_history h on h.mix_id=m.id
        where h.portfolio_id=$1 and h.ended_at is null and m.deleted_at is null`, [portfolioId])).rows[0];
      return m ? reconcile(m, exit || m.triggered_at !== null) : false;
    }),
    create: (input: unknown, wallet: string, key?: unknown, consumeBudget: () => Promise<void> = async () => {}) => safe(async () => {
      const requestKey = mixRequestKey(key), hash = mixRequestHash(input), owner = wallet.toLowerCase();
      if (!record(input)) throw new ValidationError('INVALID_MIX', '請選擇組合的資產與比例。');
      return deps.creationLock(`${owner}:97:${requestKey}`, async () => {
        let request = (await deps.query<MixCreation>(`select ${MIX_CREATION_COLUMNS} from mix_creation_requests where owner=$1 and chain_id=97 and request_key=$2`, [owner, requestKey])).rows[0];
        if (!request) {
          let source: MixRow | null = null, copied: unknown = input;
          if (input.importCode !== undefined) {
            if (typeof input.importCode !== 'string' || !/^[A-Za-z0-9_-]{22,128}$/.test(input.importCode)) throw notFound();
            source = (await deps.query<MixRow>(`select ${MIX_COLUMNS} from mixes m where m.share_code=$1 and m.deleted_at is null`, [input.importCode])).rows[0] ?? null;
            if (!source) throw notFound();
            if (input.rebalance !== undefined && !record(input.rebalance)) throw new ValidationError('INVALID_MIX_FREQUENCY', '請選擇每天、每週、每月或每季再平衡。');
            const settings = await publicData(source);
            copied = { assets: settings.assets, exit: settings.exit, ...input,
              rebalance: { frequency: settings.rebalance.frequency, ...(record(input.rebalance) ? input.rebalance : {}),
                startDate: deps.now().toISOString().slice(0, 10) } };
          }
          const settings = { ...mixSettings(copied, deps.now()), ...(source ? { importedFromMixId: source.id } : {}) };
          await consumeBudget();
          request = (await deps.query<MixCreation>(`insert into mix_creation_requests(owner,chain_id,request_key,request_hash,settings)
            values($1,97,$2,$3,$4) on conflict(owner,chain_id,request_key) do nothing returning ${MIX_CREATION_COLUMNS}`,
            [owner, requestKey, hash, JSON.stringify(settings)])).rows[0] ??
            (await deps.query<MixCreation>(`select ${MIX_CREATION_COLUMNS} from mix_creation_requests where owner=$1 and chain_id=97 and request_key=$2`, [owner, requestKey])).rows[0];
        }
        if (!request) throw mixUnavailable();
        if (request.request_hash !== hash) throw new AppError(409, 'MIX_REQUEST_CONFLICT', '這個建立代碼已用於不同設定，請用原設定重試或另選代碼。');
        const requestId = request.id;

        const current = (await deps.query<MixCreation>(`select ${MIX_CREATION_COLUMNS} from mix_creation_requests where id=$1`, [requestId])).rows[0];
        if (!current) throw mixUnavailable();
        const { importedFromMixId: _sourceId, ...frozen } = current.settings;
        const settings = mixSettings(frozen, deps.now());
        if (current.mix_id !== null) {
          const m = await owned(Number(current.mix_id), wallet);
          return creationResult(m);
        }
        const allocation = mixChainAllocation(settings.assets, [], 128);
        const strategyId = await deps.register(owner as Address, settings.name, { assets: allocation.assets }, requestId);
        const preparation = await deps.prepareAccount(strategyId, wallet, { personalMixOwner: wallet });
        // RPC completes before the short transaction. No orphan mix can commit
        // without its immutable initial owner intent and completed request link.
        const account = preparation.account.toLowerCase() as Address;
        const calls = await deps.calls({ account }, strategyId, []), context = await deps.context(account);
        const created = await deps.transaction(async client => {
          await client.query('select id from mix_creation_requests where id=$1 for update', [requestId]);
          const m = (await client.query<MixRow>(`insert into mixes(owner,name,chain_id,account,initial_strategy_id,account_salt,
            frequency,start_date,take_profit_bps,stop_loss_bps) values($1,$2,97,$3,$4,$5,$6,$7,$8,$9) returning *`,
            [owner, settings.name, account, strategyId, computeSalt(owner as Address, BigInt(strategyId)), settings.rebalance.frequency,
              settings.rebalance.startDate, settings.exit.takeProfitBps, settings.exit.stopLossBps])).rows[0];
          if (!m) throw mixUnavailable();
          await client.query(`insert into mix_strategy_settings(strategy_id,mix_id,user_allocation,exit_assets) values($1,$2,$3,'[]')`,
            [strategyId, m.id, JSON.stringify(Object.fromEntries(settings.assets.map(a => [a.assetId, a.weightBps])))]);
          await client.query(`insert into mix_switch_intents(request_key,mix_id,strategy_id,owner_calls,nonce,enroll_from_block) values($1,$2,$3,$4,$5,$6)`,
            [randomBytes(24).toString('base64url'), m.id, strategyId, JSON.stringify(calls), context.nonce.toString(), context.fromBlock.toString()]);
          await client.query("update mix_creation_requests set state='completed',mix_id=$2,updated_at=clock_timestamp() where id=$1", [requestId, m.id]);
          return m;
        });
        return creationResult(created);
      });
    }),
    list: (wallet: string) => safe(async () => {
      const rows = (await deps.query<MixRow>(`select ${MIX_COLUMNS} from mixes m where m.owner=$1 and m.deleted_at is null order by m.created_at desc,m.id desc`, [wallet.toLowerCase()])).rows;
      const mixes = [];
      for (const row of rows) mixes.push(await detail(row, false));
      return { mixes };
    }),
    get: (id: number, wallet: string) => safe(async () => {
      try { return await deps.lock(String(id), async () => {
        const m = await owned(id, wallet);
        try { await reconcile(m); } catch { return detail(m, false); }
        return detail(await owned(id, wallet));
      }); }
      catch (error) {
        if (error instanceof AppError && error.code === 'MIX_BUSY') return detail(await owned(id, wallet), false);
        throw error;
      }
    }),
    prepare: (id: number, wallet: string) => safe(() => deps.lock(String(id), () => prepare(id, wallet))),
    patch: (id: number, wallet: string, input: unknown) => safe(async () => deps.lock(String(id), async () => {
      if (!record(input)) throw new ValidationError('INVALID_MIX', '請填寫要變更的組合設定。');
      mixKeys(input, ['name', 'assets', 'rebalance', 'exit'], 'INVALID_MIX');
      const m = await owned(id, wallet), h = await currentMixHistory(m.id, db), prior = await snapshot(m);
      notDeleting(m);
      if (input.assets !== undefined && (await pendingMixIntent(m.id, db) || m.triggered_at || m.status === 'exited')) throw mixBusy();
      const settings = mixSettings({ name: m.name, ...input,
        rebalance: record(input.rebalance) ? { frequency: m.frequency, startDate: m.start_date, ...input.rebalance } : input.rebalance === undefined ? { frequency: m.frequency, startDate: m.start_date } : input.rebalance,
        exit: record(input.exit) ? { takeProfitBps: m.take_profit_bps, stopLossBps: m.stop_loss_bps, ...input.exit } : input.exit === undefined ? { takeProfitBps: m.take_profit_bps, stopLossBps: m.stop_loss_bps } : input.exit,
        assets: input.assets ?? userMixAssets(prior) }, deps.now());
      const persistMetadata = (client: Pick<import('pg').PoolClient, 'query'>) => client.query('update mixes set name=$2,frequency=$3,start_date=$4,take_profit_bps=$5,stop_loss_bps=$6 where id=$1',
        [m.id, settings.name, settings.rebalance.frequency, settings.rebalance.startDate, settings.exit.takeProfitBps, settings.exit.stopLossBps]);
      if (input.assets !== undefined) {
        if (!h) throw mixBusy();
        const plan = await deps.plan(Number(h.portfolio_id));
        if (plan.blocked.length || !plan.report) throw mixUnavailable();
        const max = await deps.maxAssets();
        const allocation = mixChainAllocation(settings.assets, plan.snapshot.holdings.filter(a => prior.user_allocation[a.asset] !== undefined || prior.exit_assets.includes(a.asset as Address))
          .map(a => ({ assetId: a.asset as Address, balanceRaw: a.amountWei })), Number(max));
        const previous = [...Object.keys(prior.user_allocation), ...prior.exit_assets];
        // Yield strategy on: the enroll voids its consent, so the same signature re-consents for the new weights (after the
        // enroll). Read before anything is published, so an unreadable chain leaves no orphan strategy behind.
        const consent = await deps.strategyConsent({ account: m.account, previousAssets: previous,
          assets: allocation.assets.filter(a => !allocation.sellOnlyAssets.includes(a.address)), totalValueUsd: plan.report.totalUsdE8 * 10n ** 10n })
          .catch(error => { throw mixUnavailable('strategy-consent', error); });
        // Cancel only known, unsent remaining work before preparing the owner intent.
        await deps.transaction(client => quiesceMix(client, 97, Number(h.portfolio_id)));
        const strategyId = await deps.register(m.owner, settings.name, { assets: allocation.assets });
        const calls = [...await deps.calls(m, strategyId, previous as Address[]), ...consent], context = await deps.context(m.account);
        await deps.transaction(async client => {
          await client.query('select id from mixes where id=$1 for update', [m.id]);
          await client.query('insert into mix_strategy_settings(strategy_id,mix_id,user_allocation,exit_assets) values($1,$2,$3,$4)',
            [strategyId, m.id, JSON.stringify(Object.fromEntries(settings.assets.map(a => [a.assetId, a.weightBps]))), JSON.stringify(allocation.sellOnlyAssets)]);
          await client.query('insert into mix_switch_intents(request_key,mix_id,from_history_id,strategy_id,owner_calls,nonce,enroll_from_block) values($1,$2,$3,$4,$5,$6,$7)',
            [randomBytes(24).toString('base64url'), m.id, h.id, strategyId, JSON.stringify(calls), context.nonce.toString(), context.fromBlock.toString()]);
          await persistMetadata(client);
        });
      }
      if (input.assets === undefined) await deps.transaction(async client => { await persistMetadata(client); });
      return input.assets === undefined ? detail(await owned(id, wallet)) : prepare(id, wallet);
    })),
    confirm: (id: number, wallet: string, input: unknown) => safe(async () => deps.lock(String(id), async () => {
      if (!record(input) || typeof input.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(input.txHash)) throw new ValidationError('INVALID_MIX_PROOF', '請提供已確認的組合交易。');
      mixKeys(input, ['txHash'], 'INVALID_MIX_PROOF');
      const m = await owned(id, wallet), intent = await pendingMixIntent(m.id, db);
      if (!intent) return detail(m);
      const proof = await deps.proof(m, intent, input.txHash.toLowerCase() as Hex);
      const portfolioId = await complete(m, intent, proof);
      return { mixId: id, portfolioId, account: m.account, message: '組合已生效，將依新比例處理交易。' };
    })),
    restart: (id: number, wallet: string) => safe(async () => deps.lock(String(id), async () => {
      const m = await owned(id, wallet), h = await currentMixHistory(m.id, db);
      notDeleting(m);
      if (m.status !== 'exited' || !h || await pendingMixIntent(m.id, db)) throw new AppError(409, 'MIX_NOT_EXITED', '組合尚未完成退出，請等交易確認後再重新開始。');
      const plan = await deps.plan(Number(h.portfolio_id)), baseline = mixValue(plan);
      const anchor = await deps.anchor(plan.snapshot.block);
      if ((await deps.anchor(plan.snapshot.block)).hash !== anchor.hash) throw mixUnavailable();
      await deps.transaction(async client => {
        await quiesceMix(client, 97, Number(h.portfolio_id));
        await client.query(`update mixes set status='active',triggered_at=null,triggered_return_bps=null,last_rebalanced_at=null,
          performance_started_at=$2,performance_baseline_raw=$3,performance_start_block=$4,performance_start_block_hash=$5,
          exit_retry_count=0,exit_last_attempt_at=null,exit_alerted_at=null where id=$1`,
          [m.id, anchor.at, baseline.toString(), plan.snapshot.block.toString(), anchor.hash]);
        await client.query("update portfolios set schedule_state='active',next_run_at=null where id=$1", [h.portfolio_id]);
      });
      return { mixId: id, status: 'active', message: '已重新開始，將依原比例買入。' };
    })),
    remove: (id: number, wallet: string) => safe(() => deps.lock(String(id), () => remove(id, wallet))),
    shared: (code: string) => safe(async () => {
      if (!/^[A-Za-z0-9_-]{22,128}$/.test(code)) throw notFound();
      const m = (await deps.query<MixRow>(`select ${MIX_COLUMNS} from mixes m where m.share_code=$1 and m.deleted_at is null`, [code])).rows[0];
      if (!m) throw notFound();
      const settings = await publicData(m), preview = await deps.preview({ assets: settings.assets });
      const copies = (await deps.query<{ count: string }>('select count(*)::text as count from mixes where imported_from_share_code=$1', [code])).rows[0];
      return { name: settings.name, assets: settings.assets, rebalance: settings.rebalance, createdAt: settings.createdAt,
        exit: settings.exit, coverUrl: settings.coverUrl, modelReturns: preview.modelReturns, modelNav: preview.modelNav, modelComponents: preview.modelComponents, copies: Number(copies?.count ?? 0) };
    }),
  };
}

export async function reconcilePendingMixes(find: import('./scheduler.js').SchedulerQueryFn, limit: number): Promise<void> {
  const rows = (await find(`select m.id from mixes m where m.deleted_at is null and exists(select 1 from mix_switch_intents i
    where i.mix_id=m.id and i.state in ('prepared','submitted','unknown')) order by m.id limit $1`, [limit])).rows;
  for (const row of rows) {
    if (!record(row) || typeof row.id !== 'string' || !/^[1-9][0-9]*$/.test(row.id)) continue;
    const id = row.id;
    try { await withMixLock(id, () => createMixService().reconcileId(id)); }
    catch { /* Preserve pending exclusion. Each later tick retries independently. */ }
  }
}
