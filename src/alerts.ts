import { yieldProfile } from './yield-domain.js';
import { SELL_ALL_OVERDUE_SQL } from './sell-all-intent.js';
import { createPublicClient, http } from 'viem';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { PriceSourceObservation } from './chain.js';
import { getAccountGasBalance, getGasPriceWei } from './chain.js';
import { DEFAULT_CHAIN_ID, loadPriceKeeperGasConfig, loadRelayerGasConfig, loadPaymasterConfig } from './config.js';
import type { PaymasterConfig } from './config.js';
import { readPaymasterDeposit } from './paymaster.js';
import { perOperationCostWei } from './funding.js';
import { sendTelegram } from './notify.js';
import { rpcTransport } from './rpc-transport.js';
import { MIN_ASSET_BATCH_RAW } from './strategy-execution.js';

/**
 * 排程器的告警。不靠 process 記憶體；seed 比對由 scheduler 使用同一套 key 選擇規則補入。
 *
 * 為什麼要做這件事（真實證據，詳見 `db/migrations/0013_scheduler_alerts.sql`）
 *   三次長跑（各約 2.5 小時）的實際結果：34 輪只有 1 輪成功、17 輪只有 1 輪成功、1 輪 —— **20+ 輪
 *   失敗，沒有任何東西通知任何人**，是靠人手動翻 log 才發現的。一個沒有告警的排程器不該進生產：
 *   它壞掉的方式不是當掉（當掉會被看見），而是「每一輪都失敗、每一輪都印一行、然後繼續跑」。
 *
 * 本模組刻意分成三個職責，每一層都能單獨測：
 *   * `detectAlerts`  —— 純讀取（SELECT 而已），算出「現在有哪些問題」。不寫 DB。
 *   * `recordAlerts`  —— upsert：同一個 (kind, portfolio) 的未解決警示只有一列，再次偵測到只累加
 *                        `occurrences` 與 `last_seen_at`。不這樣做的話每 60 秒一列，那不是告警是噪音。
 *   * `resolveAlerts` —— 這一輪**沒偵測到**的未解決警示 → 填 `resolved_at`（不刪列：已解決的列是
 *                        「曾經發生過、什麼時候好的」的唯一證據）。
 *
 * ⚠ 呼叫端（排程器）必須把整個流程包在 try/catch 裡：告警是輔助，不是主要流程。偵測失敗只該印一行，
 * 不該讓那一輪的再平衡結果被丟掉。
 */

/** DB 的最小介面：只要 `{ rows }`。`db.query` 與 `scheduler.ts` 的 `SchedulerQueryFn` 都接得上。 */
export type QueryFn = (text: string, params?: readonly unknown[]) => Promise<{ rows: unknown[] }>;

export type RelayerGasChecks = {
  env?: NodeJS.ProcessEnv;
  readNativeBalance?: (address: Address) => Promise<bigint>;
  timeoutMs?: number;
};

export type PaymasterGasChecks = {
  env?: NodeJS.ProcessEnv;
  readDeposit?: (config: PaymasterConfig) => Promise<bigint>;
  timeoutMs?: number;
};

/** A disabled paymaster has no live spending source; an enabled but unreadable deposit is unknown. */
export async function detectPaymasterLowGas(args: PaymasterGasChecks = {}): Promise<{ complete: boolean; finding: AlertFinding | null }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const config = loadPaymasterConfig(args.env ?? process.env);
    if (config === null) return { complete: true, finding: null };
    const timeoutMs = args.timeoutMs ?? config.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('invalid deposit timeout');
    const deposit = await Promise.race([(args.readDeposit ?? readPaymasterDeposit)(config),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('deposit timeout')), timeoutMs); })]);
    if (typeof deposit !== 'bigint' || deposit < 0n) throw new Error('invalid deposit');
    return { complete: true, finding: deposit < config.minDepositWei ? {
      kind: 'gas_low', severity: 'critical', portfolioId: null,
      detail: `paymaster ${config.address}：EntryPoint 存款 ${deposit} wei，低於門檻 ${config.minDepositWei} wei，請補充代付 gas`,
    } : null };
  } catch { throw new Error('paymaster 存款檢查失敗；本輪保留既有全域 gas_low 警示'); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

export type PriceKeeperGasChecks = {
  env?: NodeJS.ProcessEnv;
  readNativeBalance?: (address: Address) => Promise<bigint>;
  timeoutMs?: number;
};

/**
 * backend#213: the testnet price keeper pays its own gas. On 2026-11-22 it ran dry and stopped with RPC -32003
 * (insufficient funds); feeds went stale and API deploys failed preflight before anyone noticed.
 * `PRICE_KEEPER_MIN_GAS_WEI` defaults to 0.1 BNB, about one day of keeper usage at the observed rate
 * (~180 tx/h × ~119k gas × 0.15 gwei ≈ 0.077 BNB/day). No `PRICE_KEEPER_ADDRESS` means no keeper to watch.
 */
export async function detectPriceKeeperLowGas(args: PriceKeeperGasChecks = {}): Promise<{ complete: boolean; finding: AlertFinding | null }> {
  const env = args.env ?? process.env;
  const address = env.PRICE_KEEPER_ADDRESS?.trim();
  if (!address) return { complete: true, finding: null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/i.test(address)) throw new Error('invalid keeper address');
    const minimum = loadPriceKeeperGasConfig(env).minPriceKeeperGasWei;
    const timeoutMs = args.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('invalid balance timeout');
    const balance = await Promise.race([
      (args.readNativeBalance ?? (async (keeper: Address) => {
        const url = env.RPC_URL?.trim();
        if (!url) throw new Error('missing RPC');
        const client = createPublicClient({ transport: rpcTransport('alerts', url, { timeout: timeoutMs, retryCount: 0 }) });
        const expectedChain = Number(env.CHAIN_ID ?? DEFAULT_CHAIN_ID);
        if (!Number.isSafeInteger(expectedChain) || expectedChain < 1 || await client.getChainId() !== expectedChain) throw new Error('RPC chain mismatch');
        return client.getBalance({ address: keeper });
      }))(address as Address),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('balance timeout')), timeoutMs); }),
    ]);
    if (typeof balance !== 'bigint' || balance < 0n) throw new Error('invalid balance');
    return { complete: true, finding: balance < minimum ? {
      kind: 'gas_low', severity: 'critical', portfolioId: null,
      detail: 'price-keeper ' + address + '：BNB 餘額 ' + balance.toString() + ' wei，低於約一天用量 ' + minimum.toString() + ' wei，請補充行情 keeper gas',
    } : null };
  } catch {
    // RPC errors can contain provider secrets; never include the original error.
    throw new Error('price-keeper 餘額檢查失敗；本輪保留既有全域 gas_low 警示');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Unknown is distinct from healthy: callers must preserve the existing global gas_low finding. */
export async function detectRelayerLowGas(args: RelayerGasChecks = {}): Promise<{
  complete: boolean; finding: AlertFinding | null;
}> {
  const env = args.env ?? process.env;
  const rawKey = env.OPERATOR_PRIVATE_KEY?.trim();
  const publicAddress = env.OPERATOR_ADDRESS?.trim();
  if (!rawKey && !publicAddress) return { complete: false, finding: null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const minimum = loadRelayerGasConfig(env).minRelayerGasWei;
    if (publicAddress && (!/^0x[0-9a-fA-F]{40}$/.test(publicAddress) || /^0x0{40}$/i.test(publicAddress))) throw new Error('invalid operator address');
    const key = rawKey ? (rawKey.startsWith('0x') ? rawKey : '0x' + rawKey) : undefined;
    if (key && !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('invalid signing configuration');
    const signer = key ? privateKeyToAccount(key as Hex).address : undefined;
    if (signer && publicAddress && signer.toLowerCase() !== publicAddress.toLowerCase()) throw new Error('operator address mismatch');
    const address = (publicAddress ?? signer) as Address;
    const timeoutMs = args.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('invalid balance timeout');
    const balance = await Promise.race([
      (args.readNativeBalance ?? (async (address: Address) => {
        const url = env.RPC_URL?.trim();
        if (!url) throw new Error('missing RPC');
        const client = createPublicClient({ transport: rpcTransport('alerts', url, { timeout: timeoutMs, retryCount: 0 }) });
        const expectedChain = Number(env.CHAIN_ID ?? DEFAULT_CHAIN_ID);
        if (!Number.isSafeInteger(expectedChain) || expectedChain < 1 || await client.getChainId() !== expectedChain) throw new Error('RPC chain mismatch');
        return client.getBalance({ address });
      }))(address),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('balance timeout')), timeoutMs); }),
    ]);
    if (typeof balance !== 'bigint' || balance < 0n) throw new Error('invalid balance');
    return { complete: true, finding: balance < minimum ? {
      kind: 'gas_low', severity: 'critical', portfolioId: null,
      detail: 'relayer ' + address + '：BNB 餘額 ' + balance.toString() + ' wei，低於門檻 ' + minimum.toString() + ' wei，請補充營運 gas',
    } : null };
  } catch {
    // RPC errors and malformed keys can contain secrets; never include the original error.
    throw new Error('relayer 餘額檢查失敗；本輪保留既有全域 gas_low 警示');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 告警種類的**唯一來源**：型別從這個陣列推導，執行期的白名單也用它。
 *
 * 兩者分開寫過一次，代價是：新增 `portfolio_stuck` 時只加了型別與 DB 的 CHECK，忘了改
 * `asKind` 的執行期判斷 → 一有 stuck 告警，`--alerts` 就拋錯、`/health` 的 alerts 變 null。
 * 也就是說**監控會在「真的有東西要看」的那一刻瞎掉**。用 `typeof ALERT_KINDS[number]` 讓它不可能再分岔。
 */
export const ALERT_KINDS = [
  'portfolio_repeatedly_failing',
  'session_key_expiring',
  'gas_low',
  'portfolio_stuck',
  'session_key_derivation_mismatch',
  'executor_paused',
  'price_source_unavailable',
] as const;

export type AlertKind = (typeof ALERT_KINDS)[number];
export type AlertSeverity = 'warn' | 'critical';

export type AlertFinding = {
  kind: AlertKind;
  severity: AlertSeverity;
  /** `null` = 全域告警，例如多個 portfolio 的 seed 派生不符合併為一筆。 */
  portfolioId: number | null;
  /** 人類可讀的一句話（繁中）。排程器的 stdout 與 `--alerts` 都**原樣**印它。 */
  detail: string;
};

/** Uses an existing DB kind; grant identity survives failure and manual repair. */
export function welcomeNonceConsumedAlert(grant: { id: string; portfolioId: number; owner: Address; account: Address; amountWei: bigint; txHash: Hex }): AlertFinding {
  return { kind: 'portfolio_stuck', severity: 'critical', portfolioId: grant.portfolioId,
    detail: `WELCOME_NONCE_CONSUMED：welcome 原簽 nonce 被外部交易消耗，grant ${grant.id}，owner ${grant.owner}，account ${grant.account}，amount ${grant.amountWei} wei，原 hash ${grant.txHash}。終生資格已保留且不會自動重領；請營運核對 canonical 原交易與消耗證據，確認未發放後手動補發，再手動解除此告警。` };
}

/** 未解決警示的一列（`GET /health` 的計數與 `--alerts` 的清單都來自它）。 */
export type OpenAlert = {
  kind: AlertKind;
  severity: AlertSeverity;
  portfolioId: number | null;
  detail: string;
  occurrences: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
};

/** `/health` 的回應要的計數。`open = critical + warn`（非 critical 一律是 warn，CHECK 綁死兩個值）。 */
export type AlertCounts = { critical: number; warn: number; open: number };

/** 三個閾值，全部從 env 讀（見 `loadAlertThresholds`）。 */
export type AlertThresholds = {
  /** 最近幾筆 operation 全部不是 `confirmed` 才算「連續失敗」。 */
  failingOps: number;
  /** 剩幾天內到期的 active session key 要告警。 */
  keyExpiryDays: number;
  /** smart account 的 BNB 只剩不到幾次操作的 gas 就告警。 */
  minOps: number;
  /** 最新快照仍 `needs_rebalance` 而且已經超過幾小時沒有成功執行就告警（D-25 的「等」沒有終點）。 */
  stuckHours: number;
};

/** 與 `ALERT_*` 沒設時的行為逐字對應（測試釘住它們，改預設值要有意識）。 */
export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = { failingOps: 3, keyExpiryDays: 30, minOps: 10, stuckHours: 6 };

/**
 * session key 剩不到這麼多天 → `critical`（否則 `warn`）。
 *
 * 7 天不是憑感覺：續期要走一筆鏈上交易（`scripts/renew-session-key.ts`），需要有人簽、有人盯，
 * 一天內跑不完；而 key 一過期，這個 portfolio 的每一輪都會 blocked，且**不會自己好**。
 */
export const KEY_CRITICAL_DAYS = 7;

const DAY_MS = 86_400_000;

/** `detail` 裡錯誤訊息的長度上限：一行 log 要看得完，完整的訊息在 `operations.last_error`。 */
const MAX_ERROR_CHARS = 120;

// ---------------------------------------------------------------------------
// 閾值（env）
// ---------------------------------------------------------------------------

/**
 * `ALERT_FAILING_OPS` / `ALERT_KEY_EXPIRY_DAYS` / `ALERT_MIN_OPS`。
 *
 * 格式錯誤時**拋錯**而不是悄悄用預設值：一個打錯的 `ALERT_MIN_OPS=1O` 若被當成 10，告警會用一個
 * 沒人指定的門檻運作，而且看起來一切正常。排程器把偵測包在 try/catch 裡（印 `[ALERT] 偵測失敗`），
 * 所以這裡拋錯不會讓那一輪的再平衡結果消失。
 */
export function loadAlertThresholds(env: NodeJS.ProcessEnv = process.env): AlertThresholds {
  return {
    failingOps: positiveInteger(env, 'ALERT_FAILING_OPS', DEFAULT_ALERT_THRESHOLDS.failingOps),
    keyExpiryDays: positiveInteger(env, 'ALERT_KEY_EXPIRY_DAYS', DEFAULT_ALERT_THRESHOLDS.keyExpiryDays),
    minOps: positiveInteger(env, 'ALERT_MIN_OPS', DEFAULT_ALERT_THRESHOLDS.minOps),
    stuckHours: positiveInteger(env, 'ALERT_STUCK_HOURS', DEFAULT_ALERT_THRESHOLDS.stuckHours),
  };
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} 必須是 >= 1 的整數，收到 "${raw}"`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 偵測（純讀取，不寫 DB）
// ---------------------------------------------------------------------------

/**
 * 全部規則跑一遍。順序固定（連續失敗 → key 到期 → gas 不足），讓 stdout 與 `--alerts` 的輸出穩定。
 *
 * `readNativeBalance` / `readGasPrice` 是**測試用的接縫**：省略就是讀鏈（`chain.ts`）。生產路徑不需要
 * 傳它們；`gas_low` 的測試若沒有這兩個接縫，就只能靠「剛好有一條真的鏈」——那種測試遲早會紅。
 */
export async function detectAlerts(
  query: QueryFn,
  args: {
    now?: Date;
    env?: NodeJS.ProcessEnv;
    readNativeBalance?: (address: Address) => Promise<bigint>;
    readGasPrice?: () => Promise<bigint>;
  } = {},
): Promise<AlertFinding[]> {
  const now = args.now ?? new Date();
  const env = args.env ?? process.env;
  const thresholds = loadAlertThresholds(env);

  const failures = await detectPortfolioFailures(query, thresholds.failingOps);
  const releases = await detectOperationReleases(query, now);
  for (const release of releases) {
    const failure = failures.find((finding) => finding.portfolioId === release.portfolioId);
    // Same (kind, portfolio) key: preserve a real critical rather than upserting a later warn.
    if (failure) failure.detail += `；${release.detail}`;
    else failures.push(release);
  }

  const stuck=await detectPortfolioStuck(query,thresholds.stuckHours,now);
  if (chainIdFromEnv(env) === 97) {
    // Recover even if the immediate alert failed or its COMMIT response was
    // lost. Only a manually resolved matching alert acknowledges the repair.
    const welcomes = await query(`select g.id::text,g.portfolio_id,g.owner,g.account,g.amount_wei::text,g.tx_hash
      from welcome_grants g join relayer_outbox_nonce_consumptions c on c.tx_hash=g.tx_hash
      where g.chain_id=97 and g.state='failed' and not exists(select 1 from scheduler_alerts a
        where a.portfolio_id=g.portfolio_id and a.kind='portfolio_stuck' and a.resolved_at is not null
          and a.detail like '%WELCOME_NONCE_CONSUMED%')`);
    for (const row of welcomes.rows) {
      const fields = row as Record<string, unknown>;
      if (typeof fields.id !== 'string' || !/^[1-9][0-9]*$/.test(fields.id) || typeof fields.amount_wei !== 'string' || !/^[1-9][0-9]*$/.test(fields.amount_wei) ||
          typeof fields.tx_hash !== 'string' || !/^0x[0-9a-f]{64}$/.test(fields.tx_hash)) throw new Error('welcome alert identity unavailable');
      const finding = welcomeNonceConsumedAlert({ id: fields.id, portfolioId: toInteger(fields.portfolio_id, 'portfolio_id'),
        owner: asAddress(fields.owner, 'owner'), account: asAddress(fields.account, 'account'), amountWei: BigInt(fields.amount_wei), txHash: fields.tx_hash as Hex });
      const prior = stuck.find(item => item.portfolioId === finding.portfolioId);
      if (prior) { prior.severity = 'critical'; prior.detail += '；' + finding.detail; }
      else stuck.push(finding);
    }
    const mixes = await query(`select h.portfolio_id,m.exit_retry_count from mixes m join mix_portfolio_history h
      on h.mix_id=m.id and h.ended_at is null where m.chain_id=97 and m.deleted_at is null
      and m.status='active' and m.triggered_at is not null and m.exit_alerted_at is not null`);
    for (const row of mixes.rows) {
      const fields = row as Record<string, unknown>;
      const portfolioId = toInteger(fields.portfolio_id, 'portfolio_id');
      const count = toInteger(fields.exit_retry_count, 'exit_retry_count');
      const detail = `私人組合退出已連續失敗至少 ${count} 次，已告警並依 5 分鐘、15 分鐘、1 小時至每 6 小時上限退避，系統將重新確認條件後續作；持倉與原始證據仍保留。`;
      const prior = stuck.find(finding => finding.portfolioId === portfolioId);
      if (prior) { prior.severity = 'critical'; prior.detail += '；' + detail; }
      else stuck.push({ kind: 'portfolio_stuck', severity: 'critical', portfolioId, detail });
    }
    const publications = (await query(`select strategy_id::text,last_error_code from mix_publication_jobs
      where chain_id=97 and state<>'confirmed' and alerted_at is not null order by strategy_id`)).rows;
    if (publications.length > 0) {
      const ids = publications.map(row => {
        if (typeof row !== 'object' || row === null || !('strategy_id' in row) || typeof row.strategy_id !== 'string' || !/^[1-9][0-9]*$/.test(row.strategy_id)) throw new Error('publication alert identity unavailable');
        return row.strategy_id;
      });
      stuck.push({ kind: 'portfolio_stuck', severity: 'critical', portfolioId: null,
        detail: `私人組合首版發布待營運確認，strategy ${ids.join(', ')}；未決原簽保留，其他組合獨立對帳。` });
    }
    const quarantined = await query(`select 1 from relayer_outbox_nonce_quarantines q
      join relayer_outbox_nonce_identities n using(tx_hash) where n.chain_id=97 limit 1`);
    if (quarantined.rows.length) {
      const detail = 'relayer 外部 nonce 消耗證據已隔離；原簽與歷史保留，請營運對帳。';
      const prior = stuck.find(finding => finding.portfolioId === null);
      if (prior) { prior.severity = 'critical'; prior.detail += '；' + detail; }
      else stuck.push({ kind: 'portfolio_stuck', severity: 'critical', portfolioId: null, detail });
    }
  }
  // Routing v2 cash swapper: a top-up / cash-out refused with PegExceeded (the loan token's USDT pool is off 1:1 by more than
  // the contract allows). Resending cannot fix it: someone has to look at the pool. Same (kind, portfolio) key as the
  // drift alert, so it joins that row (as the exit and yield notes above do) instead of needing a kind of its own.
  for (const finding of strategyPegFindings(now)) {
    const prior = stuck.find(item => item.portfolioId === finding.portfolioId);
    if (prior) { prior.severity = 'critical'; prior.detail += '；' + finding.detail; }
    else stuck.push(finding);
  }
  // An owner's "sell all" the scheduler has not finished within the stuck threshold (src/sell-all-intent.ts). Same key as
  // the drift alert, so it joins that row.
  for (const finding of await detectSellAllOverdue(query, thresholds.stuckHours, now)) {
    const prior = stuck.find(item => item.portfolioId === finding.portfolioId);
    if (prior) { if (finding.severity === 'critical') prior.severity = 'critical'; prior.detail += '；' + finding.detail; }
    else stuck.push(finding);
  }
  if(chainIdFromEnv(env)===97&&yieldProfile()!==null)for(const finding of await detectYieldAttention(query)){
    const prior=stuck.find(s=>s.portfolioId===finding.portfolioId);if(prior)prior.detail+='；'+finding.detail;else stuck.push(finding);
  }
  return [
    ...failures,
    ...(await detectSessionKeyExpiry(query, { now, expiryDays: thresholds.keyExpiryDays })),
    // backend#201: with paymaster sponsorship the smart account never pays gas, so its own balance is not a signal;
    // the paymaster deposit is watched by the global gas_low. Unsponsored (mainnet) keeps the per-account rule.
    ...(paymasterSponsorsGas(env) ? [] : await detectLowGas(query, {
      chainId: chainIdFromEnv(env),
      minOps: thresholds.minOps,
      readNativeBalance: args.readNativeBalance ?? getAccountGasBalance,
      readGasPrice: args.readGasPrice ?? getGasPriceWei,
    })),
    // 卡住：最新快照仍 needs_rebalance 而太久沒有成功執行。放最後是因為它與前三個都不同源
    // （前三個看 operations / session_keys / 鏈上餘額，這個看快照）。
    ...stuck,
  ];
}

/** A misconfigured paymaster (throws) cannot sponsor anything, so the per-account check stays on. */
export function paymasterSponsorsGas(env: NodeJS.ProcessEnv): boolean {
  try { return loadPaymasterConfig(env) !== null; } catch { return false; }
}

/** Safety releases are not failed attempts. Repeated drops still need an operator's attention. */
export async function detectOperationReleases(query: QueryFn, now: Date): Promise<AlertFinding[]> {
  const { rows } = await query(`
    select portfolio_id, count(*)::int as release_count
      from operations
     where type = 'rebalance' and state = 'expired'
       and updated_at >= $1::timestamptz - interval '24 hours'
       and updated_at <= $1::timestamptz
     group by portfolio_id
    having count(*) >= 3
  `, [now.toISOString()]).catch(() => { throw new Error('expired 釋放計數讀取失敗，本輪保留既有警示'); });
  return rows.map((row) => {
    const fields = row as Record<string, unknown>;
    const portfolioId = toInteger(fields.portfolio_id, 'portfolio_id');
    const count = toInteger(fields.release_count, 'release_count');
    return { kind: 'portfolio_repeatedly_failing', severity: 'warn', portfolioId,
      detail: `portfolio ${portfolioId}：24 小時內 ${count} 次安全釋放（expired），請檢查 bundler 丟棄或送出失聯` };
  });
}

/**
 * 規則 1：某個 portfolio 的**最近 N 筆** operation 全部不是 `confirmed`。
 *
 * 為什麼看「最近 N 筆」而不是「過去 N 小時內有幾筆失敗」：排程器自己就是那個寫入者，它的節奏是
 * 間隔驅動的（一天一輪、或跟進的 30 分鐘一輪）。用時間窗會讓「一天一輪的 portfolio 連續失敗 3 天」
 * 與「一分鐘一輪的 portfolio 連續失敗 3 次」長得一樣。用**筆數**才是「它試了 N 次、N 次都沒成」。
 *
 * `N >= 筆數` 是條件的一部分：只有 2 筆 operation 的 portfolio 不會因為「2 筆都失敗」就被報成
 * critical（太少樣本）。查詢用 `having count(*) >= $1` 表達這件事。
 */
export async function detectPortfolioFailures(query: QueryFn, failingOps: number, cleanHours: number = FAILING_TAIL_CLEAN_HOURS): Promise<AlertFinding[]> {
  const { rows } = await query(SQL_FAILING_TAIL, [failingOps, cleanHours]);

  return rows.map((row) => {
    const fields = row as Record<string, unknown>;
    const portfolioId = toInteger(fields.portfolio_id, 'portfolio_id');
    const failedCount = toInteger(fields.failed_count, 'failed_count');
    const state = typeof fields.last_state === 'string' ? fields.last_state : '(unknown)';
    const error = typeof fields.last_error === 'string' ? truncate(fields.last_error, MAX_ERROR_CHARS) : '(no error message)';
    return {
      kind: 'portfolio_repeatedly_failing',
      severity: 'critical',
      portfolioId,
      detail: `portfolio ${portfolioId}: ${failedCount} consecutive operations did not succeed (last one ${state}: ${error})`,
    } satisfies AlertFinding;
  });
}

/**
 * 規則 4：**卡住**。最新一張快照仍 `needs_rebalance`，而且已經超過 N 小時沒有成功執行。
 *
 * 為什麼用快照而不是計數器：成功的執行會寫一張 `after` 快照，所以「最新快照仍需要再平衡而且很舊」
 * 就等於「這段時間內一次都沒成功動過，而上一次觀測說它還需要動」。不需要新的欄位，也不會因為
 * 重啟／`kill -9` 而歸零（記憶體裡的計數器就有那個問題）。
 *
 * 這個告警蓋到兩種對人來說一樣的狀況：**排程器一直 noop**（例如現貨偏離 TWAP 讓 impact 預算
 * 做不了事）與**排程器根本沒在跑**。
 */
export async function detectPortfolioStuck(query: QueryFn, stuckHours: number, now: Date = new Date()): Promise<AlertFinding[]> {
  const { rows } = await query(SQL_STUCK, [stuckHours, now.toISOString()]);

  return rows.flatMap((row) => {
    const fields = row as Record<string, unknown>;
    const portfolioId = toInteger(fields.portfolio_id, 'portfolio_id');
    const hours = Number(fields.hours_since);
    const observed = toInteger(fields.gross_drift_bps, 'gross_drift_bps');
    // Scheduled buying (定投): principal whose periods are not due yet waits in the account as cash on purpose. The snapshot
    // counts it as drift (testnet portfolio 4: 8 weekly periods, 8755 bps, a warn until the last period was bought).
    // Idle cash under the minimum batch (10 USDT with its fee) cannot be bought at all: the planner leaves it as the
    // portfolio's cash on purpose (rebalance-plan [BELOW_MIN_BATCH] ... 留作現金), yet the snapshot counts it as drift
    // (testnet portfolio 7: 8.62 USDT, 2584 bps, a warn forever). Whatever cash is not scheduled principal and is under
    // that minimum is left out the same way.
    const idle = unbuyableIdleCash(fields.cash_raw, fields.pending_raw);
    const pending = pendingScheduleDrift(observed, fields.total_usd_e8, idle === null ? fields.pending_raw : idle.excludedRaw);
    const drift = pending === null ? observed : pending.driftBps;
    if (pending !== null && drift <= thresholdOf(fields.threshold_bps)) return [];
    const left = pending === null ? '' : idle === null ? ` (${observed} bps observed; ${pending.pendingBps} bps of the portfolio is scheduled principal not due yet and is left out)`
      : ` (${observed} bps observed; ${pending.pendingBps} bps of the portfolio is ${idle.scheduled ? 'scheduled principal not due yet and ' : ''}idle cash under the minimum batch, which cannot be bought, and is left out)`;
    // 一天沒進展不是「今天運氣不好」：24 小時是「需要有人去看」的門檻。
    // The scheduler looked at it recently and is waiting for a known, harmless reason (market closed, below the minimum
    // trade, budget used up): nobody has to act, so it is a warn that says why, whatever its age.
    const waiting = waitingReason(portfolioId, now);
    // A private basket between two of its own rebalance dates: the weights are meant to drift until that date, and the
    // scheduler said in its latest round which date it is waiting for. Not a finding at all while that date is ahead
    // (testnet portfolio 7: 1882 bps, a warn every round until 2026-12-21). Once the date has passed and the drift is
    // still there, or the scheduler stops saying it (a failing or silent portfolio), the alert is back as before.
    if (scheduledRebalanceAhead(portfolioId, now) !== null) return [];
    const severity: AlertSeverity = waiting === null && Number.isFinite(hours) && hours >= 24 ? 'critical' : 'warn';
    return [{
      kind: 'portfolio_stuck',
      severity,
      portfolioId,
      detail:
        `portfolio ${portfolioId}: last observation showed ${drift} bps drift${left} (still above the threshold) ` +
        `${Number.isFinite(hours) ? hours.toFixed(1) : '?'} hours ago, with no successful execution since — ` +
        (waiting !== null ? `waiting, nothing to fix: ${waiting}`
          : 'the market may be making the impact budget unusable (see `GET /portfolios/:id/plan`), or the scheduler is not running'),
    } satisfies AlertFinding];
  });
}

/**
 * Idle cash that no buy can use: what the account holds of the cash token at the snapshot (`cashRaw`) less the scheduled
 * principal that is waiting for its periods (`pendingRaw`), when that rest is above zero and under the minimum batch
 * (MIN_ASSET_BATCH_RAW: 10 USDT, fee included — the planner's own rule for leaving cash alone). Returns what to take out of
 * the drift in total (the scheduled principal plus that rest), or null when there is no such cash or the row lacks the
 * number (the alert then behaves exactly as before). Raw units of the cash token (18 decimals on BSC).
 */
export function unbuyableIdleCash(cashRaw: unknown, pendingRaw: unknown): { excludedRaw: string; scheduled: boolean } | null {
  const digits = (v: unknown) => typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : typeof v === 'bigint' && v >= 0n ? v : null;
  const cash = digits(cashRaw);
  if (cash === null) return null;
  const pending = digits(pendingRaw) ?? 0n, rest = cash > pending ? cash - pending : 0n;
  if (rest === 0n || rest >= MIN_ASSET_BATCH_RAW) return null;
  return { excludedRaw: (pending + rest).toString(), scheduled: pending > 0n };
}
/** The snapshot's own threshold; a row without one (older callers / stubs) falls back to the default 100 bps. */
function thresholdOf(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 10_000 ? n : 100;
}
/**
 * Drift with the not-yet-due scheduled principal taken out of the portfolio. `pendingRaw`: numeraire raw units (18 decimals
 * on BSC, mainnet and testnet); `totalUsdE8`: the snapshot's total. The header has no per-asset rows, so this assumes the
 * rest of the drift is spread like the targets — exact for the case it is for (cash waiting next to holdings bought in
 * proportion): cash share c, pending share p -> (c − p) / (1 − p). Returns null when nothing is pending or the row lacks
 * the numbers (the alert then behaves exactly as before).
 */
export function pendingScheduleDrift(observedBps: number, totalUsdE8: unknown, pendingRaw: unknown): { driftBps: number; pendingBps: number } | null {
  const digits = (v: unknown) => typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : typeof v === 'bigint' && v >= 0n ? v : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  const total = digits(totalUsdE8), raw = digits(pendingRaw);
  if (total === null || raw === null || total === 0n) return null;
  const pendingE8 = raw / 10n ** 10n;
  if (pendingE8 === 0n) return null;
  const pendingBps = Number((pendingE8 > total ? total : pendingE8) * 10_000n / total);
  if (pendingBps === 0) return null;
  if (pendingBps >= 10_000 || observedBps <= pendingBps) return { driftBps: 0, pendingBps };
  return { driftBps: Math.round((observedBps - pendingBps) * 10_000 / (10_000 - pendingBps)), pendingBps };
}

/**
 * "Sell all" that is still open after `hours`: the scheduler keeps selling on its own, so a request this old means it
 * cannot. A warn while the latest round waits for a known harmless reason (the stock market is closed); critical
 * otherwise, and always once sends keep failing (the retry guard of sellAllRetryAt is then spacing them out).
 */
export async function detectSellAllOverdue(query: QueryFn, hours: number, now: Date = new Date()): Promise<AlertFinding[]> {
  const { rows } = await query(SELL_ALL_OVERDUE_SQL, [now.toISOString(), hours]);
  return rows.flatMap((row) => {
    const fields = row as Record<string, unknown>;
    const portfolioId = Number(fields.portfolio_id), failures = Number(fields.failures ?? 0);
    if (!Number.isSafeInteger(portfolioId) || portfolioId <= 0 || !(fields.since instanceof Date)) return [];
    const waiting = failures >= SELL_ALL_FAILING ? null : waitingReason(portfolioId, now);
    return [{ kind: 'portfolio_stuck', severity: waiting === null ? 'critical' : 'warn', portfolioId,
      detail: `[SELL_ALL_PENDING] portfolio ${portfolioId} 的全部賣出從 ${fields.since.toISOString()} 起（${((now.getTime() - fields.since.getTime()) / 3_600_000).toFixed(1)} 小時）還沒賣完` +
        (failures > 0 ? `，連續 ${failures} 次送出失敗` : '') +
        (waiting !== null ? `；等待中，不需處理：${waiting}` : '；排程器會繼續重試（連續失敗時拉長間隔），需要人查看原因') } satisfies AlertFinding];
  });
}
/** Failed sends in a row from which an overdue "sell all" is critical whatever the latest round said (the retry guard's line). */
const SELL_ALL_FAILING = 5;

/** A failing tail stops alerting once its newest operation is this old and the scheduler has checked the portfolio since without writing a new one. */
export const FAILING_TAIL_CLEAN_HOURS = 6;
/** A round outcome older than this says nothing about now. */
export const ROUND_OUTCOME_TTL_MS = 2 * 60 * 60_000;
/**
 * Reasons a portfolio can sit above its drift threshold with nothing wrong: the scheduler is waiting, not failing.
 * 下一次再平衡為: a private basket between its own rebalance dates (portfolio 7 after its under-minimum stock leg was
 * closed: the cash is free and the basket simply waits for its date).
 */
const WAITING = /\[(MARKET_CLOSED|BASKET_WAITING|DEFERRED_MIN_ASSET|NO_DUE_SLOT|SLOT_RECORDED|BELOW_MIN_STEP|BELOW_MIN_BATCH|BELOW_MIN_DEPOSIT|[A-Z_]*BUDGET[A-Z_]*)\]|低於最小交易額|低於批次最小額|低於執行器最小步|下一次再平衡為/;
const roundOutcomes = new Map<number, { outcome: string; reason: string; at: number }>();
/**
 * Rounds that never looked at the portfolio: the shared DEX lane or the portfolio's own lock was taken, or the round was
 * blocked whole because the executor's pause flag could not be read. Nothing was read and nothing was decided, so such
 * a round says nothing new about the portfolio: the word of the last round that did look stays, with its own time
 * (it still expires after ROUND_OUTCOME_TTL_MS, so a portfolio nobody has looked at for two hours alerts as before).
 * 2026-11-25: portfolio 7 (waiting for its 2026-12-21 rebalance) went critical at 17:42 and 19:06 UTC, each time right
 * after such a round replaced `下一次再平衡為 …` (17:42 [EXECUTOR_PAUSE_UNAVAILABLE] during an RPC outage, 19:06
 * [DEX_QUEUED] in the first rounds after a restart), and cleared when its next real round said the date again.
 */
const NOT_EXAMINED = /^\[(DEX_QUEUED|PORTFOLIO_LOCK_BUSY|EXECUTOR_PAUSE_UNAVAILABLE)\]/;
/**
 * The scheduler reports every portfolio it processes (same process as the alert evaluation). The heartbeat saves the map
 * every round and a new process takes it back at start (roundOutcomeSnapshot / restoreRoundOutcomes), so alerts keep
 * their reasons across a restart; anything older than the TTL still falls back to the strict form.
 */
export function noteRoundOutcome(portfolioId: number, outcome: string, reason: string | undefined, now: Date): void {
  const last = roundOutcomes.get(portfolioId);
  if (outcome === 'blocked' && NOT_EXAMINED.test(reason ?? '') && last !== undefined && now.getTime() - last.at <= ROUND_OUTCOME_TTL_MS) return;
  roundOutcomes.set(portfolioId, { outcome, reason: reason ?? '', at: now.getTime() });
}
export const resetRoundOutcomes = () => roundOutcomes.clear();
/**
 * Every outcome still inside its TTL, in the shape the scheduler heartbeat stores (scheduler_status.last_summary.outcomes).
 * The map alone made every restart forget why portfolios were waiting: their drift alerts went critical until each was
 * processed again (about 15 minutes after every deploy).
 */
export function roundOutcomeSnapshot(now: Date): Record<string, { outcome: string; reason: string; at: string }> {
  const saved: Record<string, { outcome: string; reason: string; at: string }> = {};
  for (const [portfolioId, last] of roundOutcomes) {
    if (now.getTime() - last.at > ROUND_OUTCOME_TTL_MS) continue;
    // Reasons can quote an upstream error: never store a URL (it may carry a provider key), and keep them short.
    saved[String(portfolioId)] = { outcome: last.outcome, reason: truncate(last.reason.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>'), 300), at: new Date(last.at).toISOString() };
  }
  return saved;
}
/**
 * After a restart: take back the outcomes the previous process saved. A portfolio this process has already seen keeps
 * its own newer outcome; entries that are malformed, from the future or past their TTL are ignored. Returns how many it took.
 */
export function restoreRoundOutcomes(saved: unknown, now: Date): number {
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) return 0;
  let restored = 0;
  for (const [key, value] of Object.entries(saved)) {
    const portfolioId = Number(key);
    if (!Number.isSafeInteger(portfolioId) || portfolioId <= 0 || roundOutcomes.has(portfolioId)) continue;
    if (value === null || typeof value !== 'object') continue;
    const { outcome, reason, at } = value as { outcome?: unknown; reason?: unknown; at?: unknown };
    if (typeof outcome !== 'string' || typeof reason !== 'string' || typeof at !== 'string') continue;
    const time = Date.parse(at);
    if (!Number.isFinite(time) || time > now.getTime() || now.getTime() - time > ROUND_OUTCOME_TTL_MS) continue;
    roundOutcomes.set(portfolioId, { outcome, reason, at: time });
    restored++;
  }
  return restored;
}
/** The waiting reason of the latest round, when that round was recent, did not fail and waits for a known harmless cause. */
export function waitingReason(portfolioId: number, now: Date): string | null {
  const last = roundOutcomes.get(portfolioId);
  if (!last || now.getTime() - last.at > ROUND_OUTCOME_TTL_MS || !['noop', 'blocked'].includes(last.outcome)) return null;
  return WAITING.test(last.reason) ? truncate(last.reason.replace(/^Planner returned noop: /, ''), 160) : null;
}

/** How long one PegExceeded sighting keeps its alert open: the scheduler meets it again every round while the pool is off. */
export const STRATEGY_PEG_TTL_MS = 2 * 60 * 60_000;
const pegSightings = new Map<number, { at: number; count: number; detail: string }>();
/**
 * The scheduler (same process as the alert evaluation) met `PegExceeded` on this portfolio's top-up or cash-out
 * (src/strategy-earn-v2-scheduler.ts). `detail`: the contract's own numbers when the error carried them; never a URL.
 */
export function noteStrategyPegExceeded(portfolioId: number, detail: string, now: Date): void {
  const last = pegSightings.get(portfolioId);
  pegSightings.set(portfolioId, { at: now.getTime(), count: last && now.getTime() - last.at <= STRATEGY_PEG_TTL_MS ? last.count + 1 : 1,
    detail: truncate(detail.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>'), 160) });
}
export const resetStrategyPegSightings = () => pegSightings.clear();
/** One critical finding per portfolio that met PegExceeded within the TTL; older sightings are forgotten (the alert resolves). */
export function strategyPegFindings(now: Date): AlertFinding[] {
  const out: AlertFinding[] = [];
  for (const [portfolioId, seen] of pegSightings) {
    if (now.getTime() - seen.at > STRATEGY_PEG_TTL_MS) { pegSightings.delete(portfolioId); continue; }
    out.push({ kind: 'portfolio_stuck', severity: 'critical', portfolioId,
      detail: `[STRATEGY_PEG_EXCEEDED] 加息策略的借款幣對 USDT 池子偏離 1:1 超過合約上限，補差額／換回現金被擋下（${seen.count} 次，最近 ${new Date(seen.at).toISOString()}）；重送沒有用，需要人查看池子：${seen.detail}` });
  }
  return out.sort((a, b) => (a.portfolioId ?? 0) - (b.portfolioId ?? 0));
}

/**
 * The date the portfolio's own schedule rebalances it next, when its latest round (recent, not failed) said it is waiting
 * for exactly that (src/mix-runtime.ts decideMixTick: `下一次再平衡為 <ISO time>。`) and the date is still ahead of `now`.
 * null otherwise: no recent round, a round that did or failed something, another reason, or a date that has passed.
 */
export function scheduledRebalanceAhead(portfolioId: number, now: Date): Date | null {
  const last = roundOutcomes.get(portfolioId);
  if (!last || now.getTime() - last.at > ROUND_OUTCOME_TTL_MS || !['noop', 'blocked'].includes(last.outcome)) return null;
  const at = /^下一次再平衡為 (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)。$/.exec(last.reason)?.[1];
  if (at === undefined) return null;
  const date = new Date(at);
  return Number.isFinite(date.getTime()) && date.getTime() > now.getTime() ? date : null;
}

/**
 * `pending_raw`: scheduled (stack) principal of this portfolio whose periods are not overdue — per source, the per-period
 * amount × the periods that are neither recorded yet nor overdue (period i is due at first_slot_at + i × daily/weekly, the
 * same calendar as asset-jobs `dueSource`). Overdue = due for more than the alert's own N hours ($1) at $2: a period that
 * came due a minute ago is not "stuck" yet, one still unbought N hours later is exactly what this alert is for and is NOT
 * taken out. Only lots confirmed before the snapshot (their money is in its total).
 * `cash_raw`: the cash token (the version's `execution.numeraire`) the account held at that snapshot, from its detail rows;
 * NULL when the version has no such field or the snapshot has no cash row (nothing is taken out then).
 */
const SQL_STUCK = `
  with latest as (
    select distinct on (portfolio_id) portfolio_id, block, created_at, needs_rebalance, gross_drift_bps, total_usd_e8, threshold_bps
      from portfolio_snapshots
     order by portfolio_id, created_at desc
  )
  select l.portfolio_id,
         l.gross_drift_bps,
         l.threshold_bps,
         l.total_usd_e8::text as total_usd_e8,
         pending.raw::text as pending_raw,
         cash.raw::text as cash_raw,
         extract(epoch from (now() - l.created_at)) / 3600.0 as hours_since
    from latest l
    join portfolios p on p.id = l.portfolio_id
    left join lateral (
      select trunc(ps.amount * 1000000000000000000) as raw
        from positions_snapshots ps
        join strategy_versions sv on (sv.strategy_id, sv.version) = (p.strategy_id, p.version)
       where ps.portfolio_id = l.portfolio_id and ps.block = l.block and lower(ps.asset) = lower(sv.execution->>'numeraire')
       order by ps.ts desc limit 1
    ) cash on true
    left join lateral (
      select coalesce(sum(trunc(a.budget_raw / a.effective_slices) * greatest(0, a.effective_slices - greatest(done.n, due.n))), 0) as raw
        from strategy_funding_lots f
        join strategy_lot_assets a on a.lot_id = f.id
        join strategy_versions v on (v.strategy_id, v.version) = (f.strategy_id, f.version)
        cross join lateral jsonb_array_elements(v.execution->'assets') e
        cross join lateral (select count(*)::int as n from strategy_asset_slices s where s.lot_id = a.lot_id and s.asset = a.asset) done
        cross join lateral (select $2::timestamptz - make_interval(hours => $1::int) as at) cutoff
        cross join lateral (select case when cutoff.at < a.first_slot_at then 0
          else floor(extract(epoch from (cutoff.at - a.first_slot_at))
            / case when e.value->'execution'->>'every' = 'daily' then 86400 else 604800 end)::int + 1 end as n) due
       where f.portfolio_id = l.portfolio_id and f.state = 'confirmed' and f.kind = 'asset' and f.created_at <= l.created_at
         and a.state = 'active' and a.effective_slices > 0 and a.first_slot_at is not null
         and e.value->>'asset' = a.asset and e.value->'execution'->>'kind' = 'stack'
    ) pending on true
   where p.schedule_state = 'active'
     and l.needs_rebalance
     and l.created_at < now() - make_interval(hours => $1::int)
   order by l.created_at asc
`;

/**
 * 規則 2：`status='active'` 且 `expires_at` 在 N 天內的 session key。剩不到 7 天 → `critical`。
 *
 * `portfolioId` **一定要填**：同一帳戶可以有多把 key（本專案的 portfolio 5 就有四把），不帶 portfolio
 * 的警示會讓收到的人不知道該續哪一把。但也因為「一個 portfolio、一把 key」的鍵是 (kind, portfolio)，
 * **同一個 portfolio 的多把 key 會被收斂成一列**（`scheduler_alerts_open_uniq` 的定義）。所以這裡在
 * 偵測端就先依 portfolio 分組、把「幾把、最早哪一把」寫進同一句 detail —— 否則後面的 upsert 會讓
 * 4 把只剩最後寫入的那 1 把，而「還有 3 把也在到期」這件事就在去重的同時被丟掉了。
 *
 * 已經過期的 active key（`expires_at < now`）也算在內並給 `critical`：那代表「DB 說它還活著、其實
 * 已經不能用了」，比快到期更該被看見（排程器會 blocked，而且不會自己好）。
 *
 * ⚠ 視窗（`expiryDays`，來自 `ALERT_KEY_EXPIRY_DAYS`，預設 30）在 detail 裡一定要標成**「門檻」**：
 * 它是設定值，不是「還剩幾天」。一個沒有標記的數字會被讀成「這把 key 400 天內就要到期了」，接著與
 * 預設的 30 天對不上、看起來像 bug（實測踩過：`ALERT_KEY_EXPIRY_DAYS=400` 的一次偵測，輸出被讀成
 * 「門檻 30 卻報 400」）。篩選用的 horizon 與 detail 印的數字是**同一個變數**，兩者不可能不一致；
 * 真的對不上只有一種原因 —— 環境變數覆寫了門檻。
 */
export async function detectSessionKeyExpiry(
  query: QueryFn,
  args: { now: Date; expiryDays: number },
): Promise<AlertFinding[]> {
  const horizon = new Date(args.now.getTime() + args.expiryDays * DAY_MS);
  const { rows } = await query(SQL_EXPIRING_KEYS, [horizon.toISOString()]);

  // 依 portfolio 分組（SQL 已按 expires_at 排序，所以每一組的第一筆就是最早到期的那把）。
  const byPortfolio = new Map<number, { label: string; remainingMs: number; expiresAt: Date }[]>();
  for (const row of rows) {
    const fields = row as Record<string, unknown>;
    const portfolioId = toInteger(fields.portfolio_id, 'portfolio_id');
    const permissionId = typeof fields.permission_id === 'string' && fields.permission_id !== '' ? fields.permission_id : null;
    const keyRef = typeof fields.key_ref === 'string' ? fields.key_ref : '';
    const expiresAt = toDate(fields.expires_at, 'expires_at');
    const entry = {
      label: permissionId ?? (keyRef === '' ? '(未知 session key)' : keyRef),
      remainingMs: expiresAt.getTime() - args.now.getTime(),
      expiresAt,
    };
    const group = byPortfolio.get(portfolioId);
    if (group === undefined) byPortfolio.set(portfolioId, [entry]);
    else group.push(entry);
  }

  return [...byPortfolio].map(([portfolioId, keys]) => {
    // 最早到期的那一把決定嚴重度與措辭：其餘的都在它之後，不會有更急的。
    const [earliest] = keys;
    const remainingMs = earliest?.remainingMs ?? 0;
    const severity: AlertSeverity = remainingMs < KEY_CRITICAL_DAYS * DAY_MS ? 'critical' : 'warn';

    const when =
      remainingMs <= 0
        ? `has already expired (expires_at ${earliest?.expiresAt.toISOString()})`
        : Math.floor(remainingMs / DAY_MS) < 1
          ? 'expires in less than a day'
          : `expires in ${Math.floor(remainingMs / DAY_MS)} day(s)`;

    const detail =
      keys.length === 1
        ? `portfolio ${portfolioId}: session key ${earliest?.label} ${when}`
        : `portfolio ${portfolioId}: all ${keys.length} session keys expire within the ${args.expiryDays} day threshold (earliest ${earliest?.label} ${when})`;

    return { kind: 'session_key_expiring', severity, portfolioId, detail } satisfies AlertFinding;
  });
}

/**
 * 規則 3：smart account 的 BNB 不夠再跑 N 次 op。
 *
 * **嚴重度看「這個 portfolio 有沒有成功執行過」**，不是只看餘額：
 *   * 有過至少一筆 `confirmed` operation → `critical`：這是**回歸**。它本來跑得動、現在沒錢了，
 *     而且不會自己好（下一輪會 blocked）。detail 一定帶「上次成功執行是 …」—— 那是人看到之後
 *     最想知道的第一件事。
 *   * 沒有任何 `confirmed` → `warn`：「還沒開始運作」與「突然缺 gas」都缺 gas，但只有後者是事件。
 *     全部報成 critical 的實際後果是 6 個從沒持倉的空測試 portfolio 讓 `GET /health` **永遠**
 *     degraded —— 而一個永遠 degraded 的健康檢查等於沒有健康檢查（所有人學會忽略它）。
 *
 * 重用 `funding.ts` 的計算（`perOperationCostWei` = `OPS_GAS_PER_OPERATION × gasPrice`），**沒有改它**：
 * 那個模組已經回答了「一次 op 多少 wei」與「餘額還能跑幾次」，告警只是把同一個答案套上門檻。
 *
 * ⚠ 讀鏈失敗（RPC 掛、逾時）**不產生告警**：那會是假警報 —— 「查不到餘額」與「餘額不夠」在
 * 告警面板上看起來一模一樣，而假 critical 會讓人開始忽略真的 critical。gas price 拿不到就整個
 * 規則跳過，單一帳戶讀失敗就跳過那一戶（其餘照報）。被跳過的戶數由呼叫端從 console 看得出來
 * （偵測本身回空陣列，不可區分「沒有問題」與「讀不到」，所以這裡在 `detail` 之外不另做狀態）。
 */
export async function detectLowGas(
  query: QueryFn,
  args: {
    chainId: number;
    minOps: number;
    readNativeBalance: (address: Address) => Promise<bigint>;
    readGasPrice: () => Promise<bigint>;
  },
): Promise<AlertFinding[]> {
  const { rows } = await query(SQL_SMART_ACCOUNTS, [args.chainId]);
  if (rows.length === 0) return [];

  let gasPriceWei: bigint;
  try {
    gasPriceWei = await args.readGasPrice();
  } catch {
    return [];
  }

  const costPerOp = perOperationCostWei(gasPriceWei);
  // gas price 0（查詢失敗／鏈沒設）→ 估不出次數。除以零會拋，猜一個數字會變成假告警，所以跳過。
  if (costPerOp === 0n) return [];

  const findings: AlertFinding[] = [];
  for (const row of rows) {
    const fields = row as Record<string, unknown>;
    const portfolioId = toInteger(fields.portfolio_id, 'portfolio_id');
    const address = asAddress(fields.address, 'smart_accounts.address');

    let balanceWei: bigint;
    try {
      balanceWei = await args.readNativeBalance(address);
    } catch {
      continue;
    }

    const estimatedOps = balanceWei / costPerOp;
    if (estimatedOps >= BigInt(args.minOps)) continue;

    // 「有過成功紀錄」是 severity 的分界（見上方函式註解）。沒帶這兩欄的呼叫端（stub）視為沒有紀錄，
    // 也就是 warn —— 缺資料時選比較不吵的那一邊。
    const confirmedCount = fields.confirmed_count === undefined ? 0 : toInteger(fields.confirmed_count, 'confirmed_count');
    const lastConfirmedAt =
      fields.last_confirmed_at === null || fields.last_confirmed_at === undefined
        ? null
        : toDate(fields.last_confirmed_at, 'last_confirmed_at');
    // 一個變數同時決定 severity 與 detail：兩者不可能說出互相矛盾的話。
    const lastSuccessfulRun = confirmedCount > 0 && lastConfirmedAt !== null ? lastConfirmedAt : null;

    findings.push({
      kind: 'gas_low',
      severity: lastSuccessfulRun === null ? 'warn' : 'critical',
      portfolioId,
      detail:
        `portfolio ${portfolioId}: smart account ${address} has gas left for only ${estimatedOps} operation(s)` +
        ` (threshold ${args.minOps}; balance ${balanceWei} wei, gas price ${gasPriceWei} wei)` +
        (lastSuccessfulRun === null
          ? ' — this portfolio has no successful execution on record; it may not be running yet'
          : ` — last successful execution was ${alertClock(lastSuccessfulRun)}`),
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// 寫入：upsert / resolve
// ---------------------------------------------------------------------------

export type AlertNotificationOptions = {
  dryRun: boolean;
  chainId: number;
  log?: (line: string) => void;
  /** 測試注入；正式呼叫使用 sendTelegram。 */
  send?: (text: string) => Promise<void>;
};

async function notifyAlert(row: Record<string, unknown>, resolved: boolean, options: AlertNotificationOptions): Promise<void> {
  const log = options.log ?? console.warn;
  try {
    const text = [
      `[${options.dryRun ? 'dry-run' : 'live'}][critical] ${resolved ? '已解除' : '警示'}`,
      `kind: ${asKind(row.kind)}`,
      `portfolio id: ${row.portfolio_id ?? '(無)'}`,
      `CHAIN_ID: ${options.chainId}`,
      `first_seen: ${toDate(row.first_seen_at, 'first_seen_at').toISOString()}`,
      `last_seen: ${toDate(row.last_seen_at, 'last_seen_at').toISOString()}`,
      ...(resolved ? [`resolved_at: ${toDate(row.resolved_at, 'resolved_at').toISOString()}`] : []),
      `detail: ${String(row.detail ?? '')}`,
    ].join('\n');
    await (options.send ?? ((message) => sendTelegram(message, { log })))(text);
  } catch {
    log('[Telegram] 通知失敗；警示已保留在 DB，不重送');
  }
}

/**
 * 寫入這一輪的 findings：已存在未解決的 → `occurrences + 1`、更新 `detail` 與 `last_seen_at`；
 * 否則新增一列。
 *
 * 去重靠 `0013` 的部分唯一索引 `(kind, coalesce(portfolio_id, -1)) where resolved_at is null`，
 * 所以 ON CONFLICT **必須把那個運算式與 WHERE 逐字寫出來**（Postgres 用它來推斷索引，寫錯就變成
 * 「找不到能推斷的索引」而不是「去重失效」）。
 *
 * 一筆一條 INSERT 是刻意的：findings 的數量是「有幾個 portfolio 出問題」，正常情況是個位數，
 * 而可讀性換得的是「哪一條失敗了」一眼看得出來。
 */
export async function recordAlerts(
  query: QueryFn,
  findings: readonly AlertFinding[],
  now: Date = new Date(),
  notifications?: AlertNotificationOptions,
): Promise<void> {
  const seenAt = now.toISOString();
  for (const finding of findings) {
    const { rows } = await query(SQL_RECORD_ALERT, [finding.kind, finding.severity, finding.portfolioId, finding.detail, seenAt]);
    for (const row of rows) {
      const fields = row as Record<string, unknown>;
      if (notifications && fields.severity === 'critical' && (fields.inserted === true || fields.previous_severity === 'warn')) {
        await notifyAlert(fields, false, notifications);
      }
    }
  }
}

/**
 * 把**這一輪沒偵測到**的未解決警示標成 resolved，回傳解除了幾筆。
 *
 * 「沒偵測到」= 不在 `present` 裡。所以呼叫端要傳**這一輪的完整 findings**（不是差集）；傳空陣列
 * 等於「現在什麼問題都沒有」，一般未解決警示都會被解除。WELCOME_NONCE_CONSUMED 補發告警
 * 只可由營運核對後手動解除，避免偵測與解除之間才插入的告警被誤認為已修復。
 * 用 (kind, portfolio) 當鍵而不是 id：警示的 id 是 DB 給的，呼叫端不該需要先記住它。
 * 未完成偵測的 kind 要放進 unverifiedKinds：保留既有列，不把「未知」當成「已恢復」。
 */
export async function resolveAlerts(
  query: QueryFn,
  present: readonly AlertFinding[],
  now: Date = new Date(),
  notifications?: AlertNotificationOptions,
  unverifiedKinds: readonly AlertKind[] = [],
  unverifiedKeys: readonly string[] = [],
): Promise<number> {
  const keys = [...present.map((finding) => alertKey(finding.kind, finding.portfolioId)), ...unverifiedKeys];
  const { rows } = await query(SQL_RESOLVE_ALERTS, [now.toISOString(), keys, unverifiedKinds]);
  for (const row of rows) {
    const fields = row as Record<string, unknown>;
    if (notifications && fields.severity === 'critical') await notifyAlert(fields, true, notifications);
  }
  return rows.length;
}

/** 目前未解決的警示，critical 先、再按最後看到的時間新到舊。給 `/health` 與 `--alerts` 用。 */
export async function listOpenAlerts(query: QueryFn): Promise<OpenAlert[]> {
  const { rows } = await query(SQL_OPEN_ALERTS, []);

  return rows.map((row) => {
    const fields = row as Record<string, unknown>;
    return {
      kind: asKind(fields.kind),
      severity: asSeverity(fields.severity),
      portfolioId: fields.portfolio_id === null || fields.portfolio_id === undefined ? null : toInteger(fields.portfolio_id, 'portfolio_id'),
      detail: typeof fields.detail === 'string' ? fields.detail : '',
      occurrences: toInteger(fields.occurrences, 'occurrences'),
      firstSeenAt: toDate(fields.first_seen_at, 'first_seen_at'),
      lastSeenAt: toDate(fields.last_seen_at, 'last_seen_at'),
    } satisfies OpenAlert;
  });
}

// ---------------------------------------------------------------------------
// 輸出：/health 的計數與 stdout 的一行
// ---------------------------------------------------------------------------

/** 未解決警示 → `{ critical, warn, open }`。純函式，`/health` 與測試共用同一份定義。 */
export function alertCounts(alerts: readonly { severity: AlertSeverity }[]): AlertCounts {
  let critical = 0;
  let warn = 0;
  for (const alert of alerts) {
    if (alert.severity === 'critical') critical += 1;
    else warn += 1;
  }
  return { critical, warn, open: critical + warn };
}

/**
 * `/health` 的 `status`。
 *
 * * Postgres 掛掉 → `degraded`（呼叫端此時回 503）。
 * * 有 critical 未解決 → `degraded`，**HTTP 仍是 200**：服務還活著，只是需要人看。把 503 也用在這
 *   裡會讓負載平衡器把一個能服務的實例下線 —— 那會讓一個「該看一下」變成一次「服務中斷」。
 * * 警示讀不到（`null`）→ 不影響 status：health 不該因為告警表壞掉而掛，那只會讓真正的問題更難查。
 */
export function healthStatusFor(db: 'ok' | 'down', alerts: AlertCounts | null): 'ok' | 'degraded' {
  if (db !== 'ok') return 'degraded';
  if (alerts !== null && alerts.critical > 0) return 'degraded';
  return 'ok';
}

/**
 * 一行 stdout：`[ALERT][critical] portfolio 305 連續 3 筆操作沒有成功（…）`。
 *
 * 前綴寬度固定（`[ALERT][warn]` 補到 critical 的寬度），所以連續幾行看下去是對齊的 —— 一眼看得出
 * 嚴重程度，不必逐字讀。`detail` 原樣接在後面，讓 stdout 與 `--alerts`、DB 裡的 `detail` 逐字相同。
 */
export function formatAlert(finding: AlertFinding): string {
  return `${`[ALERT][${finding.severity}]`.padEnd(ALERT_PREFIX_WIDTH, ' ')} ${finding.detail}`;
}

/** `formatAlert` 補齊用的寬度：`[ALERT][critical]` 的長度。 */
const ALERT_PREFIX_WIDTH = '[ALERT][critical]'.length;

/**
 * detail 裡的時間：UTC、到分鐘（`2026-11-07T15:33Z`）。
 *
 * 秒與毫秒對「上次成功是什麼時候」沒有資訊，卻讓一行 log 多 8 個字；而 `Z` 留著是刻意的 ——
 * 沒有時區的時間在跨機器對帳時會被讀錯。
 */
function alertClock(at: Date): string {
  return `${at.toISOString().slice(0, 16)}Z`;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * 每個 portfolio 最近 `$1` 筆 operation，全部不是 confirmed → 一列。
 *
 * `row_number() over (partition by portfolio_id order by id desc)`：`id` 是 bigserial，所以「最近」就是
 * `id desc`（不受時鐘偏移影響；`created_at` 是 transaction 時間，同一個 transaction 裡的多列會相同）。
 * `array_agg(... order by rn)[1]` 取最近那一筆的 state 與 last_error 給 detail 用。
 */
const SQL_FAILING_TAIL = `
  with ranked as (
    select o.portfolio_id as portfolio_id,
           o.state        as state,
           o.last_error   as last_error,
           o.created_at   as created_at,
           row_number() over (partition by o.portfolio_id order by o.id desc) as rn
      from operations o
     where o.state <> 'expired'
  )
  select r.portfolio_id,
         count(*)::int                       as failed_count,
         (array_agg(r.state      order by r.rn))[1] as last_state,
         (array_agg(r.last_error order by r.rn))[1] as last_error
    from ranked r
    join portfolios p on p.id = r.portfolio_id
   where r.rn <= $1
     -- A portfolio nobody runs any more can never replace its last rows: a My mix segment that ended (the mix moved on to
     -- a new portfolio) or an account that was retired. Its old failures are history, not something to act on.
     and (not exists (select 1 from smart_accounts s where s.portfolio_id = p.id)
          or exists (select 1 from smart_accounts s where s.portfolio_id = p.id and s.retired_at is null))
     and not exists (select 1 from mix_portfolio_history h where h.portfolio_id = p.id and h.ended_at is not null)
   group by r.portfolio_id, p.last_checked_at
  having count(*) >= $1 and bool_and(r.state <> 'confirmed')
     -- Aged out: the newest of them is older than $2 hours and the scheduler has checked the portfolio since without
     -- writing another operation (clean rounds). A portfolio that keeps failing keeps writing rows and stays here.
     and not (max(r.created_at) < now() - make_interval(hours => $2::int)
              and p.last_checked_at is not null and p.last_checked_at > max(r.created_at))
   order by r.portfolio_id
`;

/**
 * 到期時間早於 `$1`（= now + N 天）的 active session key。
 *
 * 刻意**沒有下界**：已經過期的 active key 是最該被看見的一種（DB 說它活著、其實不能用），
 * 由呼叫端依 `expires_at` 給 critical。
 */
const SQL_EXPIRING_KEYS = `
  select k.portfolio_id                    as portfolio_id,
         k.key_ref                         as key_ref,
         k.permissions ->> 'permissionId'    as permission_id,
         k.expires_at                      as expires_at
    from session_keys k
   where k.status = 'active'
     and k.expires_at <= $1
   order by k.expires_at asc, k.portfolio_id
`;

/**
 * 這一條鏈上、屬於 active portfolio 的 smart account（暫停的 portfolio 不該製造 gas 告警），
 * 附上「它有沒有成功執行過」：`confirmed` 的筆數與**最後一次的時間**。
 *
 * `cross join lateral` 的聚合子查詢在沒有 group by 時**一定回一列**（0 筆 confirmed 就是 `0` / `null`），
 * 所以沒有成功紀錄的 portfolio 不會被 join 掉 —— 那正是要用 warn 報出來的那一群。
 * `operations_portfolio_state_idx (portfolio_id, state)` 讓這一戶一查是索引查找，不是全表掃描。
 */
const SQL_SMART_ACCOUNTS = `
  select sa.portfolio_id      as portfolio_id,
         sa.address           as address,
         h.confirmed_count     as confirmed_count,
         h.last_confirmed_at   as last_confirmed_at
    from smart_accounts sa
    join portfolios p on p.id = sa.portfolio_id
    cross join lateral (
      select count(*)::int     as confirmed_count,
             max(o.created_at) as last_confirmed_at
        from operations o
       where o.portfolio_id = sa.portfolio_id
         and o.state = 'confirmed'
    ) h
   where sa.chain_id = $1
     and p.schedule_state = 'active'
   order by sa.portfolio_id
`;

/**
 * upsert。先鎖既有列、取更新前 severity；RETURNING 的 xmax 分辨新增與衝突更新。
 * 仍由部分唯一索引去重，不用 process 記憶體，也不增加 DB 欄位（支援 PostgreSQL 17）。
 */
const SQL_RECORD_ALERT = `
  with previous as materialized (
    select severity from scheduler_alerts
     where kind = $1 and coalesce(portfolio_id, -1) = coalesce($3::bigint, -1)
       and resolved_at is null
     for update
  )
  insert into scheduler_alerts as a
         (kind, severity, portfolio_id, detail, occurrences, first_seen_at, last_seen_at)
  select $1, $2, $3, $4, 1, $5, $5 from (select count(*) from previous) as locked where true
  on conflict (kind, (coalesce(portfolio_id, -1))) where resolved_at is null
  do update set severity     = excluded.severity,
                detail       = excluded.detail,
                occurrences  = a.occurrences + 1,
                last_seen_at = excluded.last_seen_at
  returning a.*, (xmax = 0) as inserted, (select severity from previous) as previous_severity
`;

/** Missing findings resolve automatically, except welcome manual-repair alerts. */
const SQL_RESOLVE_ALERTS = `
  update scheduler_alerts
     set resolved_at = $1
   where resolved_at is null
     and (kind || ':' || coalesce(portfolio_id, -1)::text) <> all($2::text[])
     and kind <> all($3::text[])
     and not (kind='portfolio_stuck' and detail like '%WELCOME_NONCE_CONSUMED%')
  returning id, kind, severity, portfolio_id, detail, first_seen_at, last_seen_at, resolved_at
`;

/** critical 先、再按最後看到的時間新到舊：`/health` 的計數與 `--alerts` 的清單都用這個順序。 */
const SQL_OPEN_ALERTS = `
  select kind, severity, portfolio_id, detail, occurrences, first_seen_at, last_seen_at
    from scheduler_alerts
   where resolved_at is null
   order by case severity when 'critical' then 0 else 1 end, last_seen_at desc, id desc
`;

// ---------------------------------------------------------------------------
// 內部小工具（pg 的 bigint 是字串、timestamptz 是 Date）
// ---------------------------------------------------------------------------

/** `scheduler_alerts` 的 (kind, portfolio) 鍵：與 SQL 裡的 `kind || ':' || coalesce(portfolio_id,-1)` 相同。 */
function alertKey(kind: AlertKind, portfolioId: number | null): string {
  return `${kind}:${portfolioId ?? -1}`;
}

/** pg 對 `bigint`／`count(*)::bigint` 回字串；數字也接受（stub DB 直接回 number）。 */
function toInteger(value: unknown, what: string): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed)) throw new Error(`${what} 不是整數（收到 ${JSON.stringify(value)}）`);
  return parsed;
}

function toDate(value: unknown, what: string): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  throw new Error(`${what} 不是時間（收到 ${JSON.stringify(value)}）`);
}

function asAddress(value: unknown, what: string): Address {
  if (typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)) return value as Address;
  throw new Error(`${what} 不是地址（收到 ${JSON.stringify(value)}）`);
}

function asSeverity(value: unknown): AlertSeverity {
  if (value === 'warn' || value === 'critical') return value;
  throw new Error(`scheduler_alerts.severity 不是 warn/critical（收到 ${JSON.stringify(value)}）`);
}

function asKind(value: unknown): AlertKind {
  if (typeof value === 'string' && (ALERT_KINDS as readonly string[]).includes(value)) return value as AlertKind;
  throw new Error(
    `scheduler_alerts.kind 不是已知種類（收到 ${JSON.stringify(value)}；已知：${ALERT_KINDS.join(', ')}）`,
  );
}

/** 鏈 id：與 config.ts 同一個預設（56），但不必為了讀 env 而要求 DATABASE_URL。 */
function chainIdFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env.CHAIN_ID?.trim();
  if (raw === undefined || raw === '') return DEFAULT_CHAIN_ID;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`CHAIN_ID 必須是 >= 1 的整數，收到 "${raw}"`);
  }
  return value;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export const PRICE_SOURCE_FAILURE_ROUNDS = 3;
export type PriceSourceTracker = ReturnType<typeof createPriceSourceTracker>;

/** Pre-alert counters reset on process restart; an existing DB critical stays latched until verified recovery. */
export function createPriceSourceTracker() {
  const counts = new Map<string, number>();
  return (observations: readonly PriceSourceObservation[], previous: AlertFinding | null): { finding: AlertFinding | null; complete: boolean } => {
    const unique = new Map(observations.map((observation) => [observation.asset.toLowerCase(), observation]));
    let complete = true;
    for (const [asset, observation] of unique) {
      if (!observation.verified) { complete = false; counts.delete(asset); }
      else if (observation.failure === null) counts.delete(asset);
      else counts.set(asset, Math.min(PRICE_SOURCE_FAILURE_ROUNDS, (counts.get(asset) ?? 0) + 1));
    }
    if (previous !== null && priceSourceAlertAssets(previous.detail).length === 0) complete = false;
    // Missing observations are unknown too, including assets disabled since the alert opened.
    for (const asset of priceSourceAlertAssets(previous?.detail ?? '')) {
      if (!unique.has(asset.toLowerCase())) complete = false;
    }
    for (const asset of counts.keys()) if (!unique.has(asset)) counts.delete(asset);
    const failures = [...unique.values()].filter((observation) => observation.verified && observation.failure !== null);
    const critical = previous !== null || failures.some((observation) => (counts.get(observation.asset.toLowerCase()) ?? 0) >= PRICE_SOURCE_FAILURE_ROUNDS);
    const lines = failures
      .sort((left, right) => left.asset.toLowerCase().localeCompare(right.asset.toLowerCase()))
      .map((observation) => `asset ${observation.asset.toLowerCase()}: ${observation.failure?.detail}（連續 ${counts.get(observation.asset.toLowerCase()) ?? 0}/${PRICE_SOURCE_FAILURE_ROUNDS} 輪）`);
    // Preserve previous affected assets whose current read is unknown, but remove verified healthy ones.
    for (const line of previous?.detail.split('\n') ?? []) {
      const [asset] = priceSourceAlertAssets(line);
      if (asset !== undefined && unique.get(asset.toLowerCase())?.verified !== true) lines.push(line);
    }
    const finding: AlertFinding | null = critical && lines.length > 0 ? {
      kind: 'price_source_unavailable', severity: 'critical', portfolioId: null,
      detail: '價格來源不可用；全部受影響資產確認恢復後才解除：\n' + lines.join('\n'),
    } : null;
    return { finding: previous !== null && priceSourceAlertAssets(previous.detail).length === 0 ? previous : finding, complete };
  };
}

export function priceSourceAlertAssets(detail: string): Address[] {
  return [...detail.matchAll(/^asset (0x[0-9a-fA-F]{40}):/gm)].map((match) => match[1] as Address);
}

/** A durable receipt/unknown execution needs attention even when direct-asset drift is zero. */
export async function detectYieldAttention(query:QueryFn):Promise<AlertFinding[]>{
  const result=await query(`select distinct p.id::text as portfolio_id from portfolios p where
    exists(select 1 from yield_actions a where a.portfolio_id=p.id and a.state='unknown')
    or exists(select 1 from yield_events e where e.portfolio_id=p.id and e.state='reorged')
    or exists(select 1 from yield_positions yp left join yield_position_snapshots s on s.id=yp.latest_snapshot_id
      where yp.portfolio_id=p.id and (yp.receipt_raw>0 or yp.tracked_units_raw>0) and
      (yp.exit_state='retry' or s.id is null or s.valuation_state='unknown' or s.observed_at<clock_timestamp()-interval '60 seconds'))`);
  return result.rows.map(row=>{const id=typeof row==='object'&&row!==null?Reflect.get(row,'portfolio_id'):null;
    const portfolioId=Number(id);if(!Number.isSafeInteger(portfolioId)||portfolioId<=0)throw new Error('yield alert identity unavailable');
    return {kind:'portfolio_stuck',severity:'warn',portfolioId,detail:'生息部位待領回或原交易／估值證據不足；保留收據與預留，需持續對帳'};
  });
}
