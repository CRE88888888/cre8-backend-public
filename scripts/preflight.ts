/**
 * 主網/遠端部署的**起飛前檢查**。
 *
 *     bun run scripts/preflight.ts
 *     bun run scripts/preflight.ts --chain 56 --strict
 *
 * ## 為什麼需要一支獨立的腳本
 *
 * `src/config.ts` 的驗證是**逐項、延遲**的：只有真的用到某個設定時才拋錯。那是對的（讓不需要
 * session key 的行程能啟動），但也意味著「部署後才在第 37 分鐘的某一輪才發現 seed 是空的」。
 *
 * 這支腳本把**所有**設定一次檢查完，而且檢查的是「能不能真的跑」，不只是「有沒有填」：
 *
 *   * 設定本身合法（格式、必填）
 *   * 鏈一致（`CHAIN_ID` 與 RPC 實際回的 chainId 相同 —— 不一致時 UserOp 的簽章會對不上，
 *     錯誤訊息只會說 "signature invalid"，看不出是 chainId）
 *   * 合約位址真的有 code（打錯一個字 vs 鏈還沒部署，在這裡就分得出來）
 *   * registry / router 的 Safe 兩步交接與 registry operator 是否正確
 *   * executor 的 oracle / router 有沒有接上
 *   * 營運錢包有沒有 gas、DB 連不連得上、migration 跑過沒
 *
 * ## 為什麼不是測試
 *
 * 測試跑在 fixture 上；這支跑在**真實的環境變數與真實的鏈**上。它讀 `.env`，所以同一支腳本
 * 在 fork（1337）與主網（56）都能用，只是檢查的門檻不同（見 `--strict`）。
 */

import { pathToFileURL } from 'node:url';
import { BaseError, createPublicClient, http, isAddress, getAddress, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, PublicClient } from 'viem';

import { readGlobalPaused, REGISTRY_ABI, EXECUTOR_BUY_ABI, EXECUTOR_ABI, readSecondaryHealth } from '../src/chain.js';
import { TESTNET_97, TESTNET_97_EXECUTOR_DEPLOYMENT_BLOCK, testnetAssets } from '../src/testnet-profile.js';
import { checkTestnetProfile } from '../src/testnet-preflight.js';
import { pancakeRouterForChain } from '../src/addresses.js';
import { activeChain } from '../src/chain-object.js';
import { getConfig, requireSessionKeyConfig } from '../src/config.js';
import { query } from '../src/db.js';
import { inspectSessionKeyDerivation, sessionKeyDerivationDetail } from '../src/scheduler.js';
import type { SessionKeyDerivationReport } from '../src/scheduler.js';
import { rpcTransport, secondaryRpc } from '../src/rpc-transport.js';

const USDT_ADDRESS: Address = '0x55d398326f99059fF775485246999027B3197955';

type Level = 'ok' | 'warn' | 'fail';

export type Check = {
  level: Level;
  /** 一句話說明「檢查了什麼」。 */
  name: string;
  /** 結果（值或原因）。 */
  detail: string;
  /** `warn`/`fail` 時：怎麼辦。 */
  fix?: string;
};

const OWNERSHIP_ABI = ['owner', 'pendingOwner'].map((name) => ({
  type: 'function' as const,
  name,
  stateMutability: 'view' as const,
  inputs: [],
  outputs: [{ type: 'address' as const }],
}));

export function checkGlobalPaused(paused: boolean | null, strict: boolean): Check {
  if (paused === null) return {
    level: 'fail', name: 'executor.globalPaused', detail: '讀不到 globalPaused()：無法確認是否可交易',
    fix: '確認 RPC 與 A10 executor 位址；未知狀態不可送交易',
  };
  return {
    level: paused ? (strict ? 'fail' : 'warn') : 'ok', name: 'executor.globalPaused',
    detail: paused ? 'Safe 已開啟全域暫停（所有再平衡含賣出都停止）' : 'false（未暫停）',
    ...(paused ? { fix: '由 Safe 確認事故已解除後決定是否恢復；backend 不會解除全域暫停' } : {}),
  };
}

/** `expectedMaxBuyBps`: mainnet 10000 (1x the account value per 24-hour window). Chain 97 runs at 20000 (2x, the contract ceiling, set 2026-11-25 tx 0x9946a9cf…10c5) so a sell-all followed by a same-day buy of the same amount fills. */
export function checkBuyConfig(maxBuyBps: number | null, numeraire: Address | null, strict: boolean, expectedNumeraire: Address = USDT_ADDRESS, expectedMaxBuyBps = 10000): Check[] {
  return [
    { name: 'executor.maxBuyBps', level: maxBuyBps === null ? 'fail' : maxBuyBps === expectedMaxBuyBps ? 'ok' : strict ? 'fail' : 'warn',
      detail: maxBuyBps === null ? '讀不到 maxBuyBps()' : `${maxBuyBps}（預期 ${expectedMaxBuyBps}）` },
    { name: 'executor.numeraire', level: numeraire === null ? 'fail' : sameAddress(numeraire, expectedNumeraire) ? 'ok' : strict ? 'fail' : 'warn',
      detail: numeraire === null ? '讀不到 numeraire()' : `${numeraire}（預期 USDT）` },
  ];
}

/** Classify diagnostics only; upstream messages can contain URLs, tokens and request bodies. */
function venueRpcReason(cause: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  for (let current = cause; typeof current === 'object' && current !== null && !seen.has(current);) {
    seen.add(current);
    if (current instanceof BaseError) messages.push(current.shortMessage, current.details);
    else if ('message' in current && typeof current.message === 'string') messages.push(current.message);
    current = 'cause' in current ? current.cause : undefined;
  }
  const diagnostic = messages.join('\n');
  if (/missing trie node|header not found|historical state (?:is )?(?:not available|unavailable)|state (?:has been |is )?pruned|archive requests require a personal token/i.test(diagnostic)) {
    return '歷史狀態不可用';
  }
  if (/timeout|timed out|took too long/i.test(diagnostic)) return 'RPC 逾時';
  if (/block range|range limit|too many (?:blocks|results)|query returned more than/i.test(diagnostic)) return 'block range limit exceeded（事件查詢範圍或結果超限）';
  if (/rate limit|too many requests|\b429\b/i.test(diagnostic)) return 'RPC 限流';
  if (/limit exceeded|exceeds defined limit/i.test(diagnostic)) return 'RPC 節點限制（limit exceeded）';
  if (/method (?:not found|not supported)|method .*does not exist/i.test(diagnostic)) return 'RPC 方法不支援';
  if (/network|connection refused|fetch failed|HTTP request failed/i.test(diagnostic)) return 'RPC 連線失敗';
  return 'RPC 讀取失敗或資料格式錯誤（上游原文不輸出）';
}

/** Enumerate all event pages, then read current state (including removals) at one block. */
export async function checkVenues(client: PublicClient, executor: Address, deploymentBlock: bigint): Promise<Check[]> {
  let stage = 'getBlockNumber';
  const failed = (reason: string): Check[] => [{ name: 'executor venues', level: 'fail',
    detail: `無法完整讀取 venue 事件與白名單；${stage}：${reason}` }];
  try {
    const pancakeRouter = pancakeRouterForChain(client.chain?.id);
    const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
    if (deploymentBlock < 0n || deploymentBlock > blockNumber) return failed('部署區塊必須介於 0 與目前 head 之間');
    let deploymentNote = '';
    try {
      stage = `getCode 部署區塊 ${deploymentBlock}`;
      const deployedCode = await client.getCode({ address: executor, blockNumber: deploymentBlock });
      if (deployedCode === undefined || deployedCode === '0x') return failed('部署區塊沒有 executor code');
      if (deploymentBlock > 0n) {
        stage = `getCode 部署前區塊 ${deploymentBlock - 1n}`;
        const priorCode = await client.getCode({ address: executor, blockNumber: deploymentBlock - 1n });
        if (priorCode !== undefined && priorCode !== '0x') return failed('部署前已存在 executor code，部署區塊不符');
      }
    } catch (cause) {
      if (venueRpcReason(cause) !== '歷史狀態不可用') throw cause;
      stage = `getCode 目前區塊 ${blockNumber}`;
      const currentCode = await client.getCode({ address: executor, blockNumber });
      if (currentCode === undefined || currentCode === '0x') return failed('目前沒有 executor code');
      deploymentNote = `；歷史狀態不可用，已確認目前 code，沿用部署區塊 ${deploymentBlock}`;
    }
    const targets = new Map<string, Address>([[pancakeRouter.toLowerCase(), pancakeRouter]]);
    const pageSize = 5_000n;
    for (let fromBlock = deploymentBlock; fromBlock <= blockNumber; fromBlock += pageSize) {
      const toBlock = fromBlock + pageSize - 1n < blockNumber ? fromBlock + pageSize - 1n : blockNumber;
      stage = `getLogs 區塊 ${fromBlock}–${toBlock}`;
      const events = await client.getContractEvents({ address: executor, abi: EXECUTOR_ABI,
        eventName: 'VenueSet', fromBlock, toBlock, strict: true });
      for (const event of events) targets.set(event.args.target.toLowerCase(), event.args.target);
    }
    const checks: Check[] = [];
    for (const target of targets.values()) {
      stage = `venues(${target}) 區塊 ${blockNumber}`;
      const [kind, spender] = await client.readContract({ address: executor, abi: EXECUTOR_ABI,
        functionName: 'venues', args: [target], blockNumber });
      const pancake = sameAddress(target, pancakeRouter);
      if (!pancake && kind === 0) continue;
      const valid = pancake ? kind === 1 && sameAddress(spender, pancakeRouter)
        : client.chain?.id !== 97 && (kind === 2 || kind === 3) && !sameAddress(spender, zeroAddress);
      checks.push({ name: `executor venue ${target}`, level: valid ? 'ok' : 'fail',
        detail: `kind=${['NONE', 'PANCAKE_UR', 'ERC20_APPROVE', 'PERMIT2'][kind] ?? 'UNKNOWN'} spender=${spender}${deploymentNote}` });
    }
    return checks;
  } catch (cause) {
    return failed(venueRpcReason(cause));
  }
}

/** Report every asset and both push feeds at the same chain block, including invalid/future updates. */
export async function checkSecondarySources(client: PublicClient, oracle: Address, assets: readonly Address[], strict: boolean): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const block = await client.getBlock({ blockTag: 'latest' });
    if (block.number === null) throw new Error('missing block');
    for (const asset of new Map(assets.map((value) => [value.toLowerCase(), value])).values()) {
      try {
        const health = await readSecondaryHealth(client, oracle, asset, { number: block.number, timestamp: block.timestamp });
        checks.push({ name: `secondary ${asset}`, level: 'ok', detail: health.source === zeroAddress
          ? '未設定 secondary（只有 Pancake TWAP）' : `${health.source}；maxAge=${health.maxAge} 秒，maxDeviation=${health.maxDeviationBps} bps` });
        for (const feed of health.feeds) checks.push({ name: `${asset} ${feed.role}`, level: feed.failure === null ? 'ok' : strict ? 'fail' : 'warn',
          detail: feed.failure?.detail ?? `feed ${feed.feed}；updatedAt=${feed.updatedAt}，年齡 ${feed.age} 秒` });
      } catch {
        checks.push({ name: `secondary ${asset}`, level: 'fail', detail: '無法完整讀取 secondary／兩個 feed；不可當成未設定或已恢復' });
      }
    }
  } catch {
    checks.push({ name: 'secondary block', level: 'fail', detail: '無法取得鏈上時間，不能確認 feed 年齡' });
  }
  return checks;
}

export function checkSessionKeySeed(report: SessionKeyDerivationReport): Check {
  const level: Level = report.mismatchedPortfolioIds.length > 0 || report.failedPortfolioIds.length > 0
    ? 'fail' : report.unavailable > 0 ? 'warn' : 'ok';
  return {
    level, name: 'session key seed 與 DB 比對', detail: sessionKeyDerivationDetail(report),
    ...(level === 'ok' ? {} : { fix: '確認 SESSION_KEY_MASTER_SEED 與 scheduler 一致；輪替 seed 後需完成鏈上續期' }),
  };
}

function sameAddress(a: Address | null, b: Address | null): boolean {
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
}

/** 純判斷；null 代表讀取失敗，不可當成零地址或已交接。 */
export function checkOwnership(input: {
  label: 'registry' | 'router';
  owner: Address | null;
  pendingOwner: Address | null;
  safe: Address | null;
  safeHasCode: boolean | null;
  testnet?: boolean;
  strict: boolean;
}): Check[] {
  const { label, owner, pendingOwner, safe, safeHasCode, strict } = input;
  const level = strict ? 'fail' : 'warn';
  const checks: Check[] = [];
  if (owner === null) {
    checks.push({ level: 'fail', name: `${label} owner`, detail: '讀不到 owner()', fix: '確認合約位址與 RPC' });
  } else if (safe === null || sameAddress(safe, zeroAddress)) {
    checks.push({
      level, name: `${label} owner`, detail: `${owner}；ATP_SAFE 未設定或不是合法非零地址`,
      fix: 'ATP_SAFE 填預期接手的 Safe 合約地址（不是私鑰）',
    });
  } else if (!sameAddress(owner, safe)) {
    checks.push({
      level, name: `${label} owner`, detail: `${owner}；預期 ATP_SAFE=${safe}`,
      fix: sameAddress(pendingOwner, safe)
        ? 'Safe 尚未 acceptOwnership；由 Safe 呼叫 acceptOwnership()'
        : '由現任 owner 呼叫 transferOwnership(ATP_SAFE)，再由 Safe 呼叫 acceptOwnership()',
    });
  } else {
    checks.push({ level: 'ok', name: `${label} owner`, detail: `${owner} = ATP_SAFE` });
  }

  if (safe !== null && !sameAddress(safe, zeroAddress)) {
    const testnetOwner = input.testnet === true && safeHasCode === false && sameAddress(safe, TESTNET_97.roles.owner);
    checks.push({
      level: safeHasCode === true || testnetOwner ? 'ok' : level,
      name: `${label} owner code`,
      detail: testnetOwner ? 'chain 97 manifest 測試 owner（EOA）' : safeHasCode === true ? 'ATP_SAFE 有合約 code'
        : safeHasCode === false ? 'ATP_SAFE 沒有合約 code（EOA）' : '讀不到 ATP_SAFE 的 code',
      ...(safeHasCode === true || testnetOwner ? {} : { fix: '確認 ATP_SAFE 是已部署的 Safe 合約，並確認 RPC' }),
    });
  }

  if (pendingOwner === null) {
    checks.push({
      level: 'fail', name: `${label} pendingOwner`, detail: '讀不到 pendingOwner()：不是 v2 合約，或 RPC 讀取失敗',
      fix: '使用 v2 registry / AtpMultiPoolOracle 位址並確認 RPC',
    });
  } else if (!sameAddress(pendingOwner, zeroAddress) && !sameAddress(pendingOwner, safe)) {
    checks.push({
      level, name: `${label} pendingOwner`, detail: `${pendingOwner}；非零且不是 ATP_SAFE`,
      fix: '由現任 owner 取消錯誤交接或重新 transferOwnership(ATP_SAFE)',
    });
  } else {
    checks.push({
      level: 'ok', name: `${label} pendingOwner`,
      detail: sameAddress(pendingOwner, zeroAddress) ? `${pendingOwner}（無待接受交接）` : `${pendingOwner} = ATP_SAFE（待接受）`,
    });
  }
  return checks;
}

export function checkRegistryOperator(input: {
  operator: Address | null;
  owner: Address | null;
  expectedOperator: Address | null;
}): Check[] {
  const { operator, owner, expectedOperator } = input;
  if (operator === null) {
    return [{
      level: 'fail', name: 'registry operator', detail: '讀不到 operator()：不是 v2 合約，或 RPC 讀取失敗',
      fix: '使用 v2 registry 位址並確認 RPC',
    }];
  }
  const checks: Check[] = [];
  if (sameAddress(operator, zeroAddress)) {
    checks.push({ level: 'fail', name: 'registry operator', detail: '是零地址（未設定）', fix: '由 owner 呼叫 setOperator(<relayer 地址>)' });
  } else if (expectedOperator === null) {
    checks.push({
      level: 'fail', name: 'registry operator', detail: `${operator}；無法從 OPERATOR_PRIVATE_KEY 推導預期地址`,
      fix: '設定合法的 relayer 私鑰；不要將私鑰貼到 log 或 PR',
    });
  } else if (!sameAddress(operator, expectedOperator)) {
    checks.push({
      level: 'fail', name: 'registry operator', detail: `${operator}；OPERATOR_PRIVATE_KEY 的地址為 ${expectedOperator}（不符）`,
      fix: '確認 relayer 設定，或由 owner 呼叫 setOperator(<relayer 地址>)',
    });
  } else {
    checks.push({ level: 'ok', name: 'registry operator', detail: `${operator} = relayer 地址` });
  }
  if (sameAddress(operator, owner)) {
    checks.push({
      level: 'fail', name: 'registry operator / owner', detail: `${operator}；operator == owner`,
      fix: 'Safe 管理 owner，relayer 擔任 operator；兩個角色必須分開',
    });
  }
  return checks;
}

/** 不輸出 key 或底層錯誤（可能夾帶輸入值），只回傳可公開的地址。 */
export function operatorAddress(raw: string | undefined): Address | null {
  const key = raw?.trim().replace(/^0x/, '');
  if (key === undefined || !/^[0-9a-fA-F]{64}$/.test(key)) return null;
  try {
    return privateKeyToAccount(`0x${key}`).address;
  } catch {
    return null;
  }
}

/** 只接收角色地址；不回顯未驗證的 env 值，避免誤填私鑰時洩漏。 */
export function checkRoleSeparation(input: {
  relayer: Address | null;
  deployer: string | undefined;
  bundler: string | undefined;
  safe: Address | null;
  strict: boolean;
}): Check[] {
  const checks: Check[] = [];
  const roles = [
    { name: 'relayer', address: input.relayer },
    { name: 'DEPLOYER_ADDRESS', address: asAddressOrNull(input.deployer) },
    { name: 'BUNDLER_EXECUTOR_ADDRESS', address: asAddressOrNull(input.bundler) },
  ];

  checks.push(input.relayer === null
    ? { level: 'fail', name: 'OPERATOR_PRIVATE_KEY', detail: '未設定或不是合法的 secp256k1 私鑰', fix: '設定 relayer 私鑰；只在本機 fork 使用 anvil 公開測試金鑰' }
    : { level: 'ok', name: 'OPERATOR_PRIVATE_KEY', detail: `relayer 地址 ${input.relayer}；用於 registry operator 與策略註冊／發版本的 provider` });

  for (const [name, raw] of [
    ['DEPLOYER_ADDRESS', input.deployer],
    ['BUNDLER_EXECUTOR_ADDRESS', input.bundler],
  ] as const) {
    const address = asAddressOrNull(raw);
    if (address === null || sameAddress(address, zeroAddress)) {
      const missing = raw === undefined || raw.trim() === '';
      checks.push({
        level: missing && !input.strict ? 'warn' : 'fail', name,
        detail: missing ? '未設定' : '不是合法的非零地址',
        fix: '只填該角色的公開地址，不要把私鑰放進 backend',
      });
    } else {
      checks.push({ level: 'ok', name, detail: address });
    }
  }

  for (const [i, role] of roles.entries()) {
    if (role.address === null || sameAddress(role.address, zeroAddress)) continue;
    const peers = roles.slice(i + 1);
    if (input.safe !== null && !sameAddress(input.safe, zeroAddress)) {
      peers.push({ name: 'ATP_SAFE', address: input.safe });
    }
    for (const peer of peers) {
      if (peer.address === null || sameAddress(peer.address, zeroAddress)) continue;
      const duplicate = sameAddress(role.address, peer.address);
      checks.push({
        level: duplicate ? 'fail' : 'ok', name: `${role.name} / ${peer.name}`,
        detail: duplicate ? `${role.address}；兩個角色使用相同地址` : '角色地址不同',
        ...(duplicate ? { fix: 'relayer、bundler、部署者必須各用不同金鑰，且都不能是 ATP_SAFE' } : {}),
      });
    }
  }
  return checks;
}

const results: Check[] = [];

function record(check: Check): void {
  results.push(check);
}

function ok(name: string, detail: string): void {
  record({ level: 'ok', name, detail });
}

function warn(name: string, detail: string, fix: string): void {
  record({ level: 'warn', name, detail, fix });
}

function fail(name: string, detail: string, fix: string): void {
  record({ level: 'fail', name, detail, fix });
}

/** viem 的完整 message 含 URL／request body；只取摘要並在輸出前移除憑證。 */
function oneLine(cause: unknown): string {
  let message = cause instanceof BaseError ? cause.shortMessage
    : cause instanceof Error ? cause.message : '檢查失敗（未知錯誤）';
  for (const name of [
    'RPC_URL', 'ANVIL_RPC_URL', 'BUNDLER_URL', 'DATABASE_URL',
    'OPERATOR_PRIVATE_KEY', 'SESSION_KEY_MASTER_SEED', 'TELEGRAM_BOT_TOKEN',
  ]) {
    const value = process.env[name]?.trim();
    if (value) message = message.split(value).join('[redacted]');
  }
  return message.replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s]+/gi, '[redacted URL]')
    .replace(/\b(?:0x)?[0-9a-f]{64}\b/gi, '[redacted]')
    .split(/[\r\n]/)[0]?.slice(0, 400) ?? '';
}

// ---------------------------------------------------------------------------
// 參數
// ---------------------------------------------------------------------------

type Args = { chain: number | null; strict: boolean };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { chain: null, strict: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--strict') {
      args.strict = true;
      continue;
    }
    if (token === '--chain') {
      const raw = argv[i + 1];
      if (raw === undefined) throw new Error('--chain 需要一個數字');
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`--chain 必須是正整數，得到 "${raw}"`);
      args.chain = parsed;
      i += 1;
      continue;
    }
    if (token === '--help' || token === '-h') {
      console.log('用法: bun run scripts/preflight.ts [--chain <id>] [--strict]');
      process.exit(0);
    }
    throw new Error(`未知的參數 "${token}"（--help 看用法）`);
  }
  return args;
}

// ---------------------------------------------------------------------------
// 檢查
// ---------------------------------------------------------------------------

/** `0x` 開頭、20 bytes。用 viem 的判斷而不是自己寫正則。 */
function asAddressOrNull(raw: string | undefined): Address | null {
  if (raw === undefined || raw.trim() === '') return null;
  return isAddress(raw.trim()) ? getAddress(raw.trim()) : null;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  // --- 1. 設定本身 -------------------------------------------------------
  let config: ReturnType<typeof getConfig>;
  try {
    config = getConfig();
    ok('config 載入', `CHAIN_ID=${config.chainId} PORT=${config.port}`);
  } catch (cause) {
    fail('config 載入', oneLine(cause), '補齊 backend/.env（對照 .env.example）');
    print();
    return 1;
  }

  const expectedChain = args.chain ?? config.chainId;
  if (args.chain !== null && args.chain !== config.chainId) {
    warn(
      'chain 參數與設定不一致',
      `--chain ${args.chain} 但 CHAIN_ID=${config.chainId}`,
      '兩者要一樣；否則下面檢查的是另一條鏈',
    );
  }

  // --- 2. session key / executor ----------------------------------------
  try {
    const session = requireSessionKeyConfig();
    ok('session key 設定', `EXECUTOR_ADDRESS=${session.executorAddress}`);
    if (session.masterSeed === '0x' + '00'.repeat(32)) {
      // 全零 seed 是最容易被誤用的「看起來有填」。它會產生可預測的私鑰。
      fail('SESSION_KEY_MASTER_SEED', '是全零 seed（可預測的私鑰）', '換一個真的隨機 32 bytes');
    } else {
      ok('SESSION_KEY_MASTER_SEED', '已設定且不是全零');
    }
  } catch (cause) {
    fail('session key 設定', oneLine(cause), '設定 EXECUTOR_ADDRESS 與 SESSION_KEY_MASTER_SEED');
  }

  // --- 3. 合約位址格式 ---------------------------------------------------
  const registry = config.chainId === 97 ? TESTNET_97.contracts.registry : asAddressOrNull(process.env.REGISTRY_ADDRESS);
  if (registry === null) {
    fail('REGISTRY_ADDRESS', '未設定或不是合法的 20-byte 位址', '部署合約後填入');
  } else {
    ok('REGISTRY_ADDRESS', registry);
  }
  const executor = config.chainId === 97 ? TESTNET_97.contracts.executor : asAddressOrNull(process.env.EXECUTOR_ADDRESS);
  if (executor === null) {
    fail('EXECUTOR_ADDRESS', '未設定或不是合法的 20-byte 位址', '部署合約後填入');
  } else {
    ok('EXECUTOR_ADDRESS', executor);
  }

  // 地址與金鑰分離不依賴 RPC；即使鏈連不上也先回報設定問題。
  const safe = config.chainId === 97 ? TESTNET_97.roles.owner : asAddressOrNull(process.env.ATP_SAFE);
  const expectedOperator = operatorAddress(process.env.OPERATOR_PRIVATE_KEY);
  checkRoleSeparation({
    relayer: expectedOperator,
    deployer: process.env.DEPLOYER_ADDRESS ?? (config.chainId === 97 ? TESTNET_97.roles.deployer : undefined),
    bundler: process.env.BUNDLER_EXECUTOR_ADDRESS ?? (config.chainId === 97 ? TESTNET_97.roles.bundlerExecutor : undefined),
    safe,
    strict: args.strict,
  }).forEach(record);

  // --- 4. RPC 與鏈一致 ---------------------------------------------------
  const rpcUrl = process.env.RPC_URL?.trim();
  if (rpcUrl === undefined || rpcUrl === '') {
    fail('RPC_URL', '未設定', '主網要用付費/有 archive 的 BSC RPC');
    print();
    return 1;
  }

  const chain = activeChain();
  // The services read through the same primary + public fallback (src/rpc-transport.ts): a quota or rate limit on
  // RPC_URL is a warning, not a failed deploy, as long as one transport answers.
  const client = createPublicClient({ chain, transport: rpcTransport('preflight', rpcUrl) });
  try {
    await createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 0, timeout: 10_000 }) }).getBlockNumber();
  } catch (cause) {
    const secondary = secondaryRpc(rpcUrl, expectedChain);
    if (secondary === null) {
      fail('RPC 連線', oneLine(cause), '確認 RPC_URL 可達');
      print();
      return 1;
    }
    warn('RPC_URL（主要）', `讀不到：${oneLine(cause)}`, '服務會自動改走公開節點；確認 RPC_URL 額度或金鑰');
  }

  try {
    const actualChainId = await client.getChainId();
    if (actualChainId !== expectedChain) {
      // 這個不一致最貴：userOpHash 含 chainId，簽章對不上時 EntryPoint 只會說 signature invalid。
      fail(
        'RPC 的 chainId',
        `RPC 回 ${actualChainId}，但設定是 ${expectedChain}`,
        '改 CHAIN_ID 或換 RPC —— 不一致時 UserOp 簽章會無聲失敗',
      );
    } else {
      ok('RPC 的 chainId', `${actualChainId}（與設定一致）`);
    }

    const blockNumber = await client.getBlockNumber();
    ok('RPC 連線', `head = ${blockNumber}`);
  } catch (cause) {
    fail('RPC 連線', oneLine(cause), '確認 RPC_URL 可達');
    print();
    return 1;
  }

  if (config.chainId === 97) (await checkTestnetProfile(client, undefined, { strict: args.strict })).forEach(record);

  // --- 5. 合約上真的有 code ---------------------------------------------
  for (const [label, address] of [
    ['registry', registry],
    ['executor', executor],
  ] as const) {
    if (address === null) continue;
    try {
      const code = await client.getCode({ address });
      if (code === undefined || code === '0x') {
        fail(`${label} 的 code`, `${address} 上沒有合約`, '位址打錯，或這條鏈還沒部署');
      } else {
        ok(`${label} 的 code`, `${(code.length - 2) / 2} bytes`);
      }
    } catch (cause) {
      warn(`${label} 的 code`, `讀不到：${oneLine(cause)}`, 'RPC 可能不支援 eth_getCode');
    }
  }

  // --- 6. v2 Safe 交接與 registry operator（全部唯讀）-------------------
  let safeHasCode: boolean | null = null;
  if (safe !== null && !sameAddress(safe, zeroAddress)) {
    try {
      const code = await client.getCode({ address: safe });
      safeHasCode = code !== undefined && code !== '0x';
    } catch {
      // null 與沒有 code 分開，純函式會依 strict 決定 fail / warn。
    }
  }
  async function readOwnership(address: Address) {
    const read = async (functionName: 'owner' | 'pendingOwner'): Promise<Address | null> => {
      try {
        return await client.readContract({ address, abi: OWNERSHIP_ABI, functionName });
      } catch {
        return null;
      }
    };
    return { owner: await read('owner'), pendingOwner: await read('pendingOwner') };
  }

  if (registry !== null) {
    const ownership = await readOwnership(registry);
    checkOwnership({ label: 'registry', ...ownership, safe, safeHasCode, testnet: config.chainId === 97, strict: args.strict }).forEach(record);
    let operator: Address | null = null;
    try {
      operator = await client.readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'operator' });
    } catch {
      // 舊版合約或 RPC 錯誤一律 fail，不把讀不到當作未設定。
    }
    checkRegistryOperator({ operator, owner: ownership.owner, expectedOperator }).forEach(record);
  }

  // --- 7. executor 的 oracle / router 接上了嗎 --------------------------
  if (executor !== null) {
    let paused: boolean | null = null;
    try { paused = await readGlobalPaused(executor, client); } catch { /* unreadable is fail, never false */ }
    record(checkGlobalPaused(paused, args.strict));
    let maxBuyBps: number | null = null;
    let numeraire: Address | null = null;
    try { maxBuyBps = await client.readContract({ address: executor, abi: EXECUTOR_BUY_ABI, functionName: 'maxBuyBps' }); } catch { /* unreadable fails */ }
    try { numeraire = await client.readContract({ address: executor, abi: EXECUTOR_BUY_ABI, functionName: 'numeraire' }); } catch { /* unreadable fails */ }
    checkBuyConfig(maxBuyBps, numeraire, args.strict, config.chainId === 97 ? TESTNET_97.contracts.usdt : USDT_ADDRESS, config.chainId === 97 ? 20000 : 10000).forEach(record);
    // Chain 97 pins its executor in the profile, and with it the block it was deployed in (cre8-contracts#76 replaced it).
    const deploymentBlock = config.chainId === 97 ? TESTNET_97_EXECUTOR_DEPLOYMENT_BLOCK.toString() : process.env.EXECUTOR_DEPLOYMENT_BLOCK?.trim();
    if (deploymentBlock === undefined || !/^\d+$/.test(deploymentBlock)) {
      fail('executor venues', '缺少合法的 EXECUTOR_DEPLOYMENT_BLOCK', '填 executor 部署 receipt 的 blockNumber，才能完整列出 venue 並避免從 genesis 掃描');
    } else {
      (await checkVenues(client, executor, BigInt(deploymentBlock))).forEach(record);
    }
    try {
      const oracle = await client.readContract({
        address: executor,
        abi: [
          {
            type: 'function',
            name: 'oracle',
            stateMutability: 'view',
            inputs: [],
            outputs: [{ type: 'address' }],
          },
        ] as const,
        functionName: 'oracle',
      });
      if (config.chainId === 97 && !sameAddress(oracle, TESTNET_97.contracts.router)) {
        fail('executor.oracle profile', '不符合 chain 97 manifest router', '確認 executor oracle 設定');
      }
      if (oracle === '0x0000000000000000000000000000000000000000') {
        fail('executor.oracle', '是零位址', '_checkStep 會 re-quote 失敗，所有再平衡都會 revert');
      } else {
        const oracleCode = await client.getCode({ address: oracle });
        if (oracleCode === undefined || oracleCode === '0x') {
          fail('executor.oracle', `${oracle} 上沒有合約`, '重新部署 oracle 並呼叫 setOracle');
        } else {
          ok('executor.oracle', oracle);
          try {
            const rows = config.chainId === 97 ? testnetAssets() : (await query<{ address: string }>('select address from priceable_assets where enabled order by address')).rows;
            const assets = rows.map((row) => {
              const asset = asAddressOrNull(row.address);
              if (asset === null) throw new Error('invalid asset address');
              return asset;
            });
            (await checkSecondarySources(client, oracle, assets, args.strict)).forEach(record);
          } catch {
            fail('secondary assets', '資產清單讀取失敗，無法完整檢查 secondary', '確認 DB migration 與資產資料');
          }
          const ownership = await readOwnership(oracle);
          checkOwnership({ label: 'router', ...ownership, safe, safeHasCode, testnet: config.chainId === 97, strict: args.strict }).forEach(record);
        }
      }
    } catch (cause) {
      warn('executor.oracle', `讀不到：${oneLine(cause)}`, '確認 executor ABI');
    }
  }

  // --- 8. bundler -------------------------------------------------------
  const bundler = process.env.BUNDLER_URL?.trim() ?? '';
  if (bundler === '') {
    warn('BUNDLER_URL', '未設定（只有 dry-run 能跑）', 'live 需要一個 ERC-4337 bundler');
  } else {
    try {
      const response = await fetch(bundler, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_supportedEntryPoints', params: [] }),
        signal: AbortSignal.timeout(5_000),
      });
      const body: unknown = await response.json();
      const result = typeof body === 'object' && body !== null && 'result' in body ? body.result : undefined;
      if (Array.isArray(result) && result.length > 0 && result.every((value: unknown) => typeof value === 'string' && isAddress(value)) && (config.chainId !== 97 || result.some((value: string) => value.toLowerCase() === TESTNET_97.contracts.entryPoint))) {
        ok('bundler', `entryPoints: ${result.join(', ')}`);
      } else {
        warn('bundler', '沒有回 entryPoints（上游錯誤內容不輸出）', '確認 alto / 第三方 bundler 的版本與設定');
      }
    } catch (cause) {
      warn('bundler', `連不上：${oneLine(cause)}`, 'live 模式需要它');
    }
  }

  // --- 9. DB 與 migration ----------------------------------------------
  try {
    const { rows } = await query<{ version: string }>('select version()');
    ok('DB 連線', String(rows[0]?.version ?? 'ok').slice(0, 40));
    const { rows: applied } = await query<{ count: string }>('select count(*)::text as count from schema_migrations');
    ok('migration', `${applied[0]?.count ?? '?'} 個已套用`);
    try {
      record(checkSessionKeySeed(await inspectSessionKeyDerivation(config.chainId)));
    } catch {
      fail('session key seed 與 DB 比對', '無法完成 key 比對', '確認 DB migration、session key 資料與 RPC；未完成比對不可上線');
    }
  } catch (cause) {
    fail('DB 連線', oneLine(cause), '確認 DATABASE_URL；Railway 上由平台注入');
  }

  // --- 10. auth --------------------------------------------------------
  if (process.env.AUTH_DOMAIN === undefined || process.env.AUTH_DOMAIN.trim() === '') {
    warn('AUTH_DOMAIN', '未設定', 'SIWE 需要它；用真實網域（不要 localhost）');
  } else {
    ok('AUTH_DOMAIN', process.env.AUTH_DOMAIN);
  }
  if (process.env.AUTH_URI === undefined || process.env.AUTH_URI.trim() === '') {
    warn('AUTH_URI', '未設定', 'SIWE 的 uri 欄位；https://<你的網域>');
  } else {
    ok('AUTH_URI', process.env.AUTH_URI);
  }

  print();
  return exitCode();
}

function print(): void {
  const icons: Record<Level, string> = { ok: '✓', warn: '!', fail: '✗' };
  const width = Math.max(...results.map((r) => r.name.length), 10);

  console.log('\n=== preflight ===\n');
  for (const entry of results) {
    console.log(`  ${icons[entry.level]} ${entry.name.padEnd(width)}  ${entry.detail}`);
    if (entry.fix !== undefined) console.log(`    ${' '.repeat(width)}  → ${entry.fix}`);
  }

  const fails = results.filter((r) => r.level === 'fail').length;
  const warns = results.filter((r) => r.level === 'warn').length;
  console.log(`\n  ${results.length - fails - warns} ok · ${warns} warn · ${fails} fail\n`);
}

/** `--strict`（主網）時 warn 也算失敗 —— 上線前不接受「知道但先不管」。 */
function exitCode(): number {
  const args = parseArgs(process.argv.slice(2));
  const fails = results.filter((r) => r.level === 'fail').length;
  if (fails > 0) return 1;
  if (args.strict && results.some((r) => r.level === 'warn')) return 1;
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((cause: unknown) => {
      console.error(`\n  preflight 自己壞了：${oneLine(cause)}\n`);
      process.exit(1);
    });
}
