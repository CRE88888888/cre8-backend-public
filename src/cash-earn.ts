import { createPublicClient, decodeEventLog, encodeFunctionData, http, parseAbi } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { bscTestnet } from 'viem/chains';
import { getConfig } from './config.js';
import { query as dbQuery } from './db.js';
import { AppError, ValidationError } from './errors.js';
import { yieldProfile } from './yield-domain.js';
import type { YieldMarket, YieldProtocol } from './yield-domain.js';
import { TESTNET_97 } from './testnet-profile.js';
import { retryWhileLagging } from './node-lag.js';
import type { NodeLagOptions } from './node-lag.js';

/**
 * Cash Earn (backend#193, docs/EARN_UX A/D). The owner's wallet holds the vault position directly:
 * the backend only reads chain state, prepares calldata the owner signs, and records verified flows.
 * Separate ledger from wallet cash and every portfolio's strategy/yield accounting; never summed with them.
 */
export const SECONDS_PER_YEAR = 365n * 86_400n;
/** docs/EARN_UX D: above 90% utilization no new money; above 95% withdraw part. Equality is still allowed. */
export const DEPOSIT_MAX_UTILIZATION_BPS = 9000;
export const WITHDRAW_ALERT_UTILIZATION_BPS = 9500;
export const MIN_DEPOSIT_RAW = 10n ** 18n;
const UINT256_MAX = (1n << 256n) - 1n;

export const CASH_EARN_ABI = parseAbi([
  'function aprBps() view returns (uint16)',
  'function incentiveAprBps() view returns (uint16)',
  'function getCash() view returns (uint256)',
  'function totalBorrows() view returns (uint256)',
  'function totalReserves() view returns (uint256)',
  'function supplyPaused() view returns (bool)',
  'function redeemPaused() view returns (bool)',
  'function paused() view returns (bool)',
  'function supplyCapAssets() view returns (uint256)',
  'function supplyCapWhole() view returns (uint256)',
  'function exchangeRateStored() view returns (uint256)',
  'function lastAccrual() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function maxDeposit(address) view returns (uint256)',
  'function maxWithdraw(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function getVirtualUnderlyingBalance(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function mint(uint256) returns (uint256)',
  'function redeem(uint256) returns (uint256)',
  'function deposit(uint256,address) returns (uint256)',
  'function withdraw(uint256,address,address) returns (uint256)',
  'function redeem(uint256,address,address) returns (uint256)',
  'function supply(address,uint256,address,uint16)',
  'function withdraw(address,uint256,address) returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

export type CashVault = { id: string; protocol: YieldProtocol; name: string; description: string; asset: Address;
  /** Where the owner's USDT goes on deposit and comes from on withdraw. */ custody: Address;
  /** Contract the owner approves and calls. */ spender: Address; receipt: Address };
const COPY: Record<YieldProtocol, { name: string; description: string }> = {
  venus: { name: 'Venus', description: 'Long-running lending market on BNB Chain. Withdraw anytime.' },
  lista: { name: 'Lista', description: 'Lending vault by Lista DAO on BNB Chain. Withdraw anytime.' },
  aave_v3: { name: 'Aave', description: 'Aave V3 lending pool on BNB Chain. Withdraw anytime.' },
};

/** Whitelist: the USDT markets of the verified chain-97 profile (no address input from requests). */
export function cashVaults(profile = yieldProfile(), usdt: Address = TESTNET_97.contracts.usdt): CashVault[] {
  if (!profile) return [];
  const asset = usdt.toLowerCase() as Address;
  return profile.markets.filter(m => m.asset === asset).map((m: YieldMarket) => ({
    id: m.id, protocol: m.protocol, ...COPY[m.protocol], asset,
    custody: m.protocol === 'aave_v3' ? m.receipt : m.target, spender: m.target, receipt: m.receipt,
  }));
}

/** Simulated rates accrue on every interaction, so continuous compounding is the closest APY. */
export function apyBpsFromApr(aprBps: number): number {
  if (!Number.isInteger(aprBps) || aprBps < 0 || aprBps > 10_000) throw new RangeError('invalid apr');
  return Math.round((Math.exp(aprBps / 10_000) - 1) * 10_000);
}
export function utilizationBps(totalRaw: bigint, liquidityRaw: bigint): number {
  if (totalRaw < 0n || liquidityRaw < 0n) throw new RangeError('invalid vault totals');
  if (totalRaw === 0n) return 0;
  const used = totalRaw > liquidityRaw ? totalRaw - liquidityRaw : 0n;
  return Number((used * 10_000n + totalRaw - 1n) / totalRaw); // round up: never understate utilization
}

/** incentiveAprBps: reward APR paid on top of the base rate (null = not published / unknown, counted as 0 in the total). */
export type VaultReading = { aprBps: number; incentiveAprBps: number | null; totalRaw: bigint; liquidityRaw: bigint; supplyPaused: boolean;
  redeemPaused: boolean; capRemainingRaw: bigint | null };
export type VaultStatus = 'open' | 'deposits_paused' | 'withdraw_recommended' | 'unavailable';
export type ApyPart = { kind: 'base' | 'incentive'; label: string; bps: number; source: string; updatedAt: string };
export type VaultView = { id: string; protocol: YieldProtocol; name: string; description: string; aprBps: number | null;
  /** Total shown to users = base APY + incentive APR. Breakdown lists each part with its source. */ apyBps: number | null;
  baseApyBps: number | null; incentiveAprBps: number | null; breakdown: ApyPart[];
  utilizationBps: number | null; liquidityRaw: string | null; depositOpen: boolean; status: VaultStatus; reason: string | null;
  message: string | null; bestRate: boolean; simulated: boolean };

const TEMPORARILY = 'Temporarily unavailable.';
export function vaultView(vault: CashVault, reading: VaultReading | null, updatedAt = new Date(0)): Omit<VaultView, 'bestRate'> {
  const base = { id: vault.id, protocol: vault.protocol, name: vault.name, description: vault.description, simulated: true };
  if (!reading) return { ...base, aprBps: null, apyBps: null, baseApyBps: null, incentiveAprBps: null, breakdown: [], utilizationBps: null,
    liquidityRaw: null, depositOpen: false, status: 'unavailable', reason: 'data_unavailable', message: TEMPORARILY };
  const utilization = utilizationBps(reading.totalRaw, reading.liquidityRaw);
  const baseApy = apyBpsFromApr(reading.aprBps), incentive = reading.incentiveAprBps;
  const at = updatedAt.toISOString(), source = `${vault.name} contract (testnet simulated rate)`;
  const breakdown: ApyPart[] = [{ kind: 'base', label: 'Interest', bps: baseApy, source, updatedAt: at },
    ...(incentive ? [{ kind: 'incentive' as const, label: 'Rewards', bps: incentive, source, updatedAt: at }] : [])];
  const common = { ...base, aprBps: reading.aprBps, apyBps: baseApy + (incentive ?? 0), baseApyBps: baseApy, incentiveAprBps: incentive,
    breakdown, utilizationBps: utilization, liquidityRaw: reading.liquidityRaw.toString() };
  if (reading.redeemPaused) return { ...common, depositOpen: false, status: 'unavailable', reason: 'withdrawals_paused', message: TEMPORARILY };
  if (utilization > WITHDRAW_ALERT_UTILIZATION_BPS) return { ...common, depositOpen: false, status: 'withdraw_recommended',
    reason: 'high_utilization', message: 'This vault is almost fully borrowed. We recommend withdrawing while cash is available.' };
  if (utilization > DEPOSIT_MAX_UTILIZATION_BPS) return { ...common, depositOpen: false, status: 'deposits_paused', reason: 'high_utilization', message: TEMPORARILY };
  if (reading.supplyPaused) return { ...common, depositOpen: false, status: 'deposits_paused', reason: 'deposits_paused', message: TEMPORARILY };
  if (reading.capRemainingRaw !== null && reading.capRemainingRaw < MIN_DEPOSIT_RAW) {
    return { ...common, depositOpen: false, status: 'deposits_paused', reason: 'cap_reached', message: TEMPORARILY };
  }
  return { ...common, depositOpen: true, status: 'open', reason: null, message: null };
}
/** "Best rate" marks the highest APY among vaults that accept deposits now (ties: first in list). */
export function markBest(views: Omit<VaultView, 'bestRate'>[]): VaultView[] {
  let best: string | null = null, top = -1;
  for (const v of views) if (v.depositOpen && v.apyBps !== null && v.apyBps > top) { top = v.apyBps; best = v.id; }
  return views.map(v => ({ ...v, bestRate: v.id === best }));
}

export type PositionReading = { sharesRaw: bigint; valueRaw: bigint; maxWithdrawRaw: bigint };
/**
 * `gas` is a suggested limit. Vault calls accrue interest first; a wallet estimate taken in a block with no elapsed
 * time misses the accrual mint and can run out of gas one block later (seen on the chain-97 Venus mock), so send it.
 */
export type Call = { to: Address; data: Hex; value: '0'; gas: string };
export const APPROVE_GAS = '100000';
export const VAULT_CALL_GAS = '400000';
export type CashEarnChain = {
  head(): Promise<{ number: bigint; timestamp: bigint }>;
  vault(vault: CashVault, block: bigint, timestamp: bigint): Promise<VaultReading>;
  position(vault: CashVault, owner: Address, block: bigint, timestamp: bigint, reading: VaultReading): Promise<PositionReading>;
  /** Shares to redeem for an exact USDT amount (Venus only; ERC4626/Aave withdraw by assets). */
  sharesFor(vault: CashVault, assetsRaw: bigint, block: bigint, timestamp: bigint): Promise<bigint>;
  balance(token: Address, owner: Address, block: bigint): Promise<bigint>;
  allowance(token: Address, owner: Address, spender: Address, block: bigint): Promise<bigint>;
  receipt(hash: Hex): Promise<{ status: 'success' | 'reverted'; from: Address; blockNumber: bigint; blockHash: Hex;
    logs: { address: Address; topics: readonly Hex[]; data: Hex; logIndex: number }[] } | null>;
  blockHash(number: bigint): Promise<Hex>;
};

/** Optional reward APR: a vault without the function (or reverting) publishes no incentive. Transport errors still fail the read. */
async function incentive(client: PublicClient, address: Address, blockNumber: bigint): Promise<number | null> {
  try { return apr(await read(client, address, 'incentiveAprBps', blockNumber)); }
  catch (error) {
    if (error instanceof Error && /revert|returned no data|ContractFunctionZeroData|execution reverted/i.test(`${error.name} ${error.message}`)) return null;
    throw error;
  }
}
function read(client: PublicClient, address: Address, functionName: string, blockNumber: bigint, args: readonly unknown[] = []): Promise<unknown> {
  return client.readContract({ address, abi: CASH_EARN_ABI, functionName: functionName as never, args: args as never, blockNumber });
}
const big = (value: unknown): bigint => { if (typeof value !== 'bigint' || value < 0n) throw new Error('invalid chain value'); return value; };
const bool = (value: unknown): boolean => { if (typeof value !== 'boolean') throw new Error('invalid chain value'); return value; };
const apr = (value: unknown): number => { const n = Number(value); if (!Number.isInteger(n) || n < 0 || n > 10_000) throw new Error('invalid apr'); return n; };
/** Mirror MockVenus.accrueInterest: rate grows by apr * elapsed / year since the last accrual. */
export function venusRate(stored: bigint, aprBps: number, elapsed: bigint): bigint {
  return stored + stored * BigInt(aprBps) * (elapsed > 0n ? elapsed : 0n) / (SECONDS_PER_YEAR * 10_000n);
}

export function createCashEarnChain(client: PublicClient): CashEarnChain {
  async function venusState(vault: CashVault, block: bigint, timestamp: bigint) {
    const [rate, last, aprBps] = await Promise.all([read(client, vault.receipt, 'exchangeRateStored', block),
      read(client, vault.receipt, 'lastAccrual', block), read(client, vault.receipt, 'aprBps', block)]);
    return venusRate(big(rate), apr(aprBps), timestamp - big(last));
  }
  return {
    async head() { const b = await client.getBlock(); return { number: b.number, timestamp: b.timestamp }; },
    async vault(vault, block) {
      if (vault.protocol === 'venus') {
        const [aprBps, cash, borrows, reserves, supplyPaused, redeemPaused, cap] = await Promise.all(
          ['aprBps', 'getCash', 'totalBorrows', 'totalReserves', 'supplyPaused', 'redeemPaused', 'supplyCapAssets'].map(f => read(client, vault.receipt, f, block)));
        const total = big(cash) + big(borrows) - big(reserves);
        return { aprBps: apr(aprBps), incentiveAprBps: await incentive(client, vault.receipt, block), totalRaw: total, liquidityRaw: big(cash), supplyPaused: bool(supplyPaused), redeemPaused: bool(redeemPaused),
          capRemainingRaw: big(cap) === 0n ? null : big(cap) > total ? big(cap) - total : 0n };
      }
      if (vault.protocol === 'lista') {
        const [aprBps, total, borrows, paused, supplyPaused, maxDeposit] = await Promise.all([read(client, vault.receipt, 'aprBps', block),
          read(client, vault.receipt, 'totalAssets', block), read(client, vault.receipt, 'totalBorrows', block), read(client, vault.receipt, 'paused', block),
          read(client, vault.receipt, 'supplyPaused', block), read(client, vault.receipt, 'maxDeposit', block, [vault.receipt])]);
        const liquidity = big(total) > big(borrows) ? big(total) - big(borrows) : 0n;
        return { aprBps: apr(aprBps), incentiveAprBps: await incentive(client, vault.receipt, block), totalRaw: big(total), liquidityRaw: liquidity, supplyPaused: bool(paused) || bool(supplyPaused), redeemPaused: bool(paused),
          capRemainingRaw: big(maxDeposit) === UINT256_MAX ? null : big(maxDeposit) };
      }
      const [aprBps, total, liquidity, paused, supplyPaused, capWhole] = await Promise.all([read(client, vault.receipt, 'aprBps', block),
        read(client, vault.receipt, 'totalSupply', block), read(client, vault.spender, 'getVirtualUnderlyingBalance', block, [vault.asset]),
        read(client, vault.spender, 'paused', block), read(client, vault.spender, 'supplyPaused', block), read(client, vault.spender, 'supplyCapWhole', block)]);
      const cap = big(capWhole) * 10n ** 18n;
      return { aprBps: apr(aprBps), incentiveAprBps: await incentive(client, vault.spender, block), totalRaw: big(total), liquidityRaw: big(liquidity), supplyPaused: bool(paused) || bool(supplyPaused), redeemPaused: bool(paused),
        capRemainingRaw: cap === 0n ? null : cap > big(total) ? cap - big(total) : 0n };
    },
    async position(vault, owner, block, timestamp, reading) {
      const shares = big(await read(client, vault.receipt, 'balanceOf', block, [owner]));
      if (vault.protocol === 'venus') {
        const value = shares * await venusState(vault, block, timestamp) / 10n ** 18n;
        return { sharesRaw: shares, valueRaw: value, maxWithdrawRaw: reading.redeemPaused ? 0n : value < reading.liquidityRaw ? value : reading.liquidityRaw };
      }
      if (vault.protocol === 'lista') {
        const [value, max] = await Promise.all([read(client, vault.receipt, 'previewRedeem', block, [shares]), read(client, vault.receipt, 'maxWithdraw', block, [owner])]);
        return { sharesRaw: shares, valueRaw: big(value), maxWithdrawRaw: big(max) };
      }
      return { sharesRaw: shares, valueRaw: shares, maxWithdrawRaw: reading.redeemPaused ? 0n : shares < reading.liquidityRaw ? shares : reading.liquidityRaw };
    },
    async sharesFor(vault, assetsRaw, block, timestamp) {
      if (vault.protocol !== 'venus') throw new Error('shares only for venus');
      const rate = await venusState(vault, block, timestamp);
      return (assetsRaw * 10n ** 18n + rate - 1n) / rate;
    },
    balance: async (token, owner, block) => big(await read(client, token, 'balanceOf', block, [owner])),
    allowance: async (token, owner, spender, block) => big(await read(client, token, 'allowance', block, [owner, spender])),
    async receipt(hash) {
      try {
        const r = await client.getTransactionReceipt({ hash });
        return { status: r.status, from: r.from, blockNumber: r.blockNumber, blockHash: r.blockHash,
          logs: r.logs.map(l => ({ address: l.address, topics: l.topics, data: l.data, logIndex: l.logIndex })) };
      } catch (error) {
        if (error instanceof Error && error.name === 'TransactionReceiptNotFoundError') return null;
        throw error;
      }
    },
    async blockHash(number) { const b = await client.getBlock({ blockNumber: number }); if (!b.hash) throw new Error('pending block'); return b.hash; },
  };
}

const lower = (a: string) => a.toLowerCase() as Address;
const amount = (value: unknown, allowMax: boolean): bigint | 'max' => {
  if (allowMax && value === 'max') return 'max';
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,77}$/.test(value) || BigInt(value) > UINT256_MAX) {
    throw new ValidationError('INVALID_AMOUNT', allowMax ? 'amountRaw 須為正整數字串或 "max"。' : 'amountRaw 須為正整數字串。');
  }
  return BigInt(value);
};
function body(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k)) ||
    keys.some(k => !(k in input))) throw new ValidationError('INVALID_EARN_REQUEST', `請送出 ${keys.join('、')}。`);
  return input as Record<string, unknown>;
}
const usdt = (raw: bigint) => {
  const whole = raw / 10n ** 18n, cents = (raw % 10n ** 18n) / 10n ** 16n;
  return `${whole.toLocaleString('en-US')}.${cents.toString().padStart(2, '0')}`;
};

export function depositCalls(vault: CashVault, owner: Address, amountRaw: bigint, allowance: bigint): Call[] {
  const calls: Call[] = [];
  if (allowance < amountRaw) calls.push({ to: vault.asset, value: '0', gas: APPROVE_GAS, data: encodeFunctionData({ abi: CASH_EARN_ABI, functionName: 'approve', args: [vault.spender, amountRaw] }) });
  const data = vault.protocol === 'venus' ? encodeFunctionData({ abi: CASH_EARN_ABI, functionName: 'mint', args: [amountRaw] })
    : vault.protocol === 'lista' ? encodeFunctionData({ abi: CASH_EARN_ABI, functionName: 'deposit', args: [amountRaw, owner] })
      : encodeFunctionData({ abi: CASH_EARN_ABI, functionName: 'supply', args: [vault.asset, amountRaw, owner, 0] });
  calls.push({ to: vault.spender, value: '0', gas: VAULT_CALL_GAS, data });
  return calls;
}
/** `all` redeems the whole position (interest included); otherwise an exact USDT amount (Venus via shares). */
export function withdrawCall(vault: CashVault, owner: Address, plan: { all: true; sharesRaw: bigint } | { all: false; assetsRaw: bigint; sharesRaw?: bigint }): Call {
  if (vault.protocol === 'venus') {
    const shares = plan.sharesRaw;
    if (shares === undefined || shares <= 0n) throw new RangeError('venus withdraw needs shares');
    return { to: vault.spender, value: '0', gas: VAULT_CALL_GAS, data: encodeFunctionData({ abi: CASH_EARN_ABI, functionName: 'redeem', args: [shares] }) };
  }
  if (vault.protocol === 'lista') {
    return { to: vault.spender, value: '0', gas: VAULT_CALL_GAS, data: plan.all
      ? encodeFunctionData({ abi: CASH_EARN_ABI, functionName: 'redeem', args: [plan.sharesRaw, owner, owner] })
      : encodeFunctionData({ abi: CASH_EARN_ABI, functionName: 'withdraw', args: [plan.assetsRaw, owner, owner] }) };
  }
  return { to: vault.spender, value: '0', gas: VAULT_CALL_GAS, data: encodeFunctionData({ abi: CASH_EARN_ABI, functionName: 'withdraw',
    args: [vault.asset, plan.all ? UINT256_MAX : plan.assetsRaw, owner] }) };
}

/** Lifetime earnings from the separate ledger: value + withdrawn - deposited. A negative result means the ledger is incomplete. */
export function earnings(valueRaw: bigint, depositedRaw: bigint, withdrawnRaw: bigint): bigint | null {
  const earned = valueRaw + withdrawnRaw - depositedRaw;
  return earned < 0n ? null : earned;
}
/** "~ today": the share of the current value accrued since UTC midnight (or since the first deposit, if later). */
export function earnedTodayEstimate(valueRaw: bigint, aprBps: number, secondsToday: bigint): bigint {
  if (valueRaw <= 0n || aprBps <= 0 || secondsToday <= 0n) return 0n;
  const growth = SECONDS_PER_YEAR * 10_000n + BigInt(aprBps) * secondsToday;
  return valueRaw - valueRaw * SECONDS_PER_YEAR * 10_000n / growth;
}

export type Flow = { vaultId: string; kind: 'deposit' | 'withdraw'; assetsRaw: bigint; logIndex: number };
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** Only USDT transfers between the sender's wallet and a whitelisted vault custody address count. */
export function flowsFromLogs(vaults: readonly CashVault[], owner: Address, logs: readonly { address: Address; topics: readonly Hex[]; data: Hex; logIndex: number }[]): Flow[] {
  const flows: Flow[] = [];
  for (const log of logs) {
    if (log.topics[0] !== TRANSFER_TOPIC) continue;
    const vault = vaults.find(v => lower(log.address) === v.asset);
    if (!vault) continue;
    let decoded;
    try { decoded = decodeEventLog({ abi: CASH_EARN_ABI, eventName: 'Transfer', topics: log.topics as [Hex, ...Hex[]], data: log.data }); } catch { continue; }
    const { from, to, value } = decoded.args;
    if (value <= 0n) continue;
    for (const v of vaults) {
      if (lower(from) === lower(owner) && lower(to) === v.custody) flows.push({ vaultId: v.id, kind: 'deposit', assetsRaw: value, logIndex: log.logIndex });
      else if (lower(from) === v.custody && lower(to) === lower(owner)) flows.push({ vaultId: v.id, kind: 'withdraw', assetsRaw: value, logIndex: log.logIndex });
    }
  }
  return flows;
}

type Query = typeof dbQuery;
export type CashEarnDeps = { chainId: number; vaults: CashVault[]; chain: () => CashEarnChain; query: Query; now: () => Date; nodeLag?: NodeLagOptions };
const BEHIND = new Error('rpc head is behind the last recorded flow');
const unavailable = () => new AppError(503, 'EARN_UNAVAILABLE', '目前無法讀取生息資料，請稍後再試。');

export function createCashEarn(overrides: Partial<CashEarnDeps> = {}) {
  let cached: CashEarnChain | undefined;
  const deps: CashEarnDeps = {
    chainId: overrides.chainId ?? getConfigChainId(), vaults: overrides.vaults ?? cashVaults(), query: dbQuery, now: () => new Date(),
    chain: () => {
      if (cached) return cached;
      const rpc = getConfig().rpcUrl;
      if (!rpc) throw unavailable();
      cached = createCashEarnChain(createPublicClient({ chain: bscTestnet, transport: http(rpc, { retryCount: 1, timeout: 8_000 }) }) as PublicClient);
      return cached;
    },
    ...overrides,
  };
  const ready = () => { if (deps.chainId !== 97 || deps.vaults.length === 0) throw new AppError(503, 'EARN_CHAIN_UNAVAILABLE', '現金生息目前僅開放測試網。'); };
  const find = (id: unknown) => {
    const vault = deps.vaults.find(v => v.id === id);
    if (!vault) throw new ValidationError('INVALID_VAULT', '請選擇一個 vault。');
    return vault;
  };
  async function readings(chain: CashEarnChain, block: bigint, timestamp: bigint) {
    return Promise.all(deps.vaults.map(async v => { try { return await chain.vault(v, block, timestamp); } catch { return null; } }));
  }
  /** `minBlock`: the owner's last recorded deposit/withdraw. A load-balanced RPC node can still be behind it right after
   * the transaction (the position would read as empty), so wait briefly for a head at or past it (src/node-lag.ts). */
  async function vaultList(minBlock = 0n) {
    ready();
    // docs/EARN_UX D: an RPC outage is a "temporarily unavailable" state per vault, not an error code.
    let live: { chain: CashEarnChain; head: { number: bigint; timestamp: bigint } } | null = null;
    try {
      const chain = deps.chain();
      const head = await retryWhileLagging(async () => { const h = await chain.head(); if (h.number < minBlock) throw BEHIND; return h; }, e => e === BEHIND, deps.nodeLag);
      live = { chain, head };
    } catch { live = null; }
    const states = live ? await readings(live.chain, live.head.number, live.head.timestamp) : deps.vaults.map(() => null);
    const at = live ? new Date(Number(live.head.timestamp) * 1000) : deps.now();
    return { live, states, vaults: markBest(deps.vaults.map((v, i) => vaultView(v, states[i] ?? null, at))) };
  }
  async function ledger(owner: Address) {
    const rows = (await deps.query<{ vault_id: string; deposited: string; withdrawn: string; first_at: Date; last_block?: string | null }>(`select vault_id,
      coalesce(sum(assets_raw) filter (where kind='deposit'),0)::text as deposited, coalesce(sum(assets_raw) filter (where kind='withdraw'),0)::text as withdrawn,
      min(created_at) as first_at, max(block_number)::text as last_block from cash_earn_flows where chain_id=$1 and owner=$2 group by vault_id`, [deps.chainId, owner])).rows;
    return new Map(rows.map(r => [r.vault_id, { deposited: BigInt(r.deposited), withdrawn: BigInt(r.withdrawn), firstAt: r.first_at,
      lastBlock: typeof r.last_block === 'string' && /^\d+$/.test(r.last_block) ? BigInt(r.last_block) : 0n }]));
  }
  const lastBlock = (book: Awaited<ReturnType<typeof ledger>>, vaultId?: string) =>
    [...book.entries()].filter(([id]) => vaultId === undefined || id === vaultId).reduce((max, [, f]) => f.lastBlock > max ? f.lastBlock : max, 0n);
  return {
    async vaults() {
      const { live, vaults } = await vaultList();
      return { chainId: deps.chainId, block: live ? live.head.number.toString() : null,
        updatedAt: live ? new Date(Number(live.head.timestamp) * 1000).toISOString() : null, vaults };
    },
    /** Wallet cash and Cash Earn are separate fields; nothing here sums them. */
    async account(wallet: string) {
      const owner = lower(wallet);
      const book = await ledger(owner);
      const { live, states, vaults } = await vaultList(lastBlock(book));
      let available: bigint | null = null;
      if (live) try { available = await live.chain.balance(deps.vaults[0]?.asset ?? TESTNET_97.contracts.usdt, owner, live.head.number); } catch { available = null; }
      if (!live || available === null) {
        return { chainId: deps.chainId, owner, status: 'unavailable' as const, reason: 'data_unavailable', message: TEMPORARILY, updatedAt: null,
          wallet: { availableRaw: null }, cashEarn: { earningRaw: null, earnedTodayRaw: null, earnedTotalRaw: null, positions: [] } };
      }
      const { chain, head } = live;
      const now = deps.now(), midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const positions = [];
      // A position we cannot read makes every Cash Earn sum unknown (null), never an understated number.
      let earning = 0n, today = 0n, total = 0n, totalKnown = true, sumsKnown = true;
      for (const [i, vault] of deps.vaults.entries()) {
        const state = states[i] ?? null, view = vaults[i];
        if (!view) continue;
        const flows = book.get(vault.id);
        let p: PositionReading | null = null;
        if (state) try { p = await chain.position(vault, owner, head.number, head.timestamp, state); } catch { p = null; }
        if (!state || !p) {
          if (flows) {
            positions.push({ vaultId: vault.id, name: vault.name, valueRaw: null, maxWithdrawRaw: null, apyBps: null, earnedTodayRaw: null,
              earnedTotalRaw: null, status: 'unavailable' as const, message: TEMPORARILY });
            totalKnown = false; sumsKnown = false;
          }
          continue;
        }
        if (p.sharesRaw === 0n && !flows) continue;
        const since = BigInt(Math.max(0, Math.floor((now.getTime() - Math.max(midnight, flows?.firstAt.getTime() ?? midnight)) / 1000)));
        const todayRaw = earnedTodayEstimate(p.valueRaw, state.aprBps, since);
        const earned = flows ? earnings(p.valueRaw, flows.deposited, flows.withdrawn) : null;
        earning += p.valueRaw; today += todayRaw;
        if (earned === null) totalKnown = false; else total += earned;
        const limited = p.maxWithdrawRaw < p.valueRaw;
        positions.push({ vaultId: vault.id, name: vault.name, valueRaw: p.valueRaw.toString(), maxWithdrawRaw: p.maxWithdrawRaw.toString(),
          apyBps: view.apyBps, earnedTodayRaw: todayRaw.toString(), earnedTotalRaw: earned?.toString() ?? null,
          status: view.status, message: limited ? `You can withdraw up to ${usdt(p.maxWithdrawRaw)} USDT right now.` : view.message });
      }
      return { chainId: deps.chainId, owner, status: 'ok' as const, reason: null, message: null, updatedAt: new Date(Number(head.timestamp) * 1000).toISOString(),
        wallet: { availableRaw: available.toString() },
        cashEarn: { earningRaw: sumsKnown ? earning.toString() : null, earnedTodayRaw: sumsKnown ? today.toString() : null,
          earnedTotalRaw: totalKnown && sumsKnown ? total.toString() : null, positions } };
    },
    async deposit(wallet: string, input: unknown) {
      ready();
      const b = body(input, ['vaultId', 'amountRaw']), vault = find(b.vaultId), owner = lower(wallet);
      const amountRaw = amount(b.amountRaw, false);
      if (amountRaw === 'max') throw new ValidationError('INVALID_AMOUNT', 'amountRaw 須為正整數字串。');
      const { live, states, vaults } = await vaultList();
      const i = deps.vaults.indexOf(vault), view = vaults[i], state = states[i];
      if (!live || !view || !state || !view.depositOpen) return { status: 'unavailable' as const, vaultId: vault.id, reason: view?.reason ?? 'data_unavailable', message: view?.message ?? TEMPORARILY };
      if (amountRaw < MIN_DEPOSIT_RAW) throw new ValidationError('AMOUNT_TOO_SMALL', '最少存入 1 USDT。');
      const { chain, head } = live;
      let balance: bigint, allowance: bigint;
      try { [balance, allowance] = await Promise.all([chain.balance(vault.asset, owner, head.number), chain.allowance(vault.asset, owner, vault.spender, head.number)]); }
      catch { return { status: 'unavailable' as const, vaultId: vault.id, reason: 'data_unavailable', message: TEMPORARILY }; }
      if (amountRaw > balance) throw new ValidationError('INSUFFICIENT_BALANCE', `錢包可用 ${usdt(balance)} USDT，不足存入金額。`);
      if (state.capRemainingRaw !== null && amountRaw > state.capRemainingRaw) {
        return { status: 'limited' as const, vaultId: vault.id, maxDepositRaw: state.capRemainingRaw.toString(),
          message: `This vault can take up to ${usdt(state.capRemainingRaw)} USDT right now.` };
      }
      return { status: 'ready' as const, vaultId: vault.id, amountRaw: amountRaw.toString(), apyBps: view.apyBps, calls: depositCalls(vault, owner, amountRaw, allowance) };
    },
    async withdraw(wallet: string, input: unknown) {
      ready();
      const b = body(input, ['vaultId', 'amountRaw']), vault = find(b.vaultId), owner = lower(wallet);
      const requested = amount(b.amountRaw, true);
      const { live, states, vaults } = await vaultList(lastBlock(await ledger(owner), vault.id));
      const i = deps.vaults.indexOf(vault), state = states[i], view = vaults[i];
      const dataUnavailable = { status: 'unavailable' as const, vaultId: vault.id, reason: 'data_unavailable', message: TEMPORARILY };
      if (!live || !state || !view) return dataUnavailable;
      const { chain, head } = live;
      let p: PositionReading;
      try { p = await chain.position(vault, owner, head.number, head.timestamp, state); } catch { return dataUnavailable; }
      if (p.sharesRaw === 0n || p.valueRaw === 0n) throw new ValidationError('NOTHING_TO_WITHDRAW', '這個 vault 沒有可領出的部位。');
      if (p.maxWithdrawRaw === 0n) return { status: 'unavailable' as const, vaultId: vault.id, reason: state.redeemPaused ? 'withdrawals_paused' : 'no_liquidity', message: TEMPORARILY };
      const limited = (max: bigint) => ({ status: 'limited' as const, vaultId: vault.id, maxWithdrawRaw: max.toString(),
        message: `You can withdraw up to ${usdt(max)} USDT right now.` });
      try {
        if (requested === 'max') {
          if (p.maxWithdrawRaw >= p.valueRaw) {
            return { status: 'ready' as const, vaultId: vault.id, amountRaw: p.valueRaw.toString(), all: true, calls: [withdrawCall(vault, owner, { all: true, sharesRaw: p.sharesRaw })] };
          }
          const shares = vault.protocol === 'venus' ? await chain.sharesFor(vault, p.maxWithdrawRaw, head.number, head.timestamp) : undefined;
          return { ...limited(p.maxWithdrawRaw), partial: { amountRaw: p.maxWithdrawRaw.toString(),
            calls: [withdrawCall(vault, owner, { all: false, assetsRaw: p.maxWithdrawRaw, ...(shares === undefined ? {} : { sharesRaw: shares < p.sharesRaw ? shares : p.sharesRaw }) })] } };
        }
        if (requested > p.valueRaw) throw new ValidationError('AMOUNT_EXCEEDS_BALANCE', `最多可領 ${usdt(p.valueRaw)} USDT。`);
        if (requested > p.maxWithdrawRaw) return limited(p.maxWithdrawRaw);
        const shares = vault.protocol === 'venus' ? await chain.sharesFor(vault, requested, head.number, head.timestamp) : undefined;
        return { status: 'ready' as const, vaultId: vault.id, amountRaw: requested.toString(), all: false,
          calls: [withdrawCall(vault, owner, { all: false, assetsRaw: requested, ...(shares === undefined ? {} : { sharesRaw: shares < p.sharesRaw ? shares : p.sharesRaw }) })] };
      } catch (error) { if (error instanceof AppError) throw error; return dataUnavailable; }
    },
    /** Records verified wallet<->vault USDT transfers of a successful, canonical tx sent by the owner. Idempotent. */
    async confirm(wallet: string, input: unknown) {
      ready();
      const b = body(input, ['txHash']), owner = lower(wallet);
      if (typeof b.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(b.txHash)) throw new ValidationError('INVALID_TX_HASH', 'txHash 格式不正確。');
      const hash = b.txHash.toLowerCase() as Hex;
      let receipt: Awaited<ReturnType<CashEarnChain['receipt']>>, canonical: Hex;
      try {
        const chain = deps.chain();
        receipt = await chain.receipt(hash);
        if (!receipt) return { status: 'pending' as const, recorded: [] };
        canonical = await chain.blockHash(receipt.blockNumber);
      } catch { return { status: 'pending' as const, recorded: [] }; } // RPC outage: retry later, nothing recorded
      if (canonical.toLowerCase() !== receipt.blockHash.toLowerCase()) return { status: 'pending' as const, recorded: [] };
      if (receipt.status !== 'success') throw new AppError(409, 'TX_FAILED', '這筆交易沒有成功，金額沒有移動。');
      if (lower(receipt.from) !== owner) throw new AppError(403, 'TX_NOT_OWNER', '只能確認自己錢包送出的交易。');
      const flows = flowsFromLogs(deps.vaults, owner, receipt.logs);
      if (!flows.length) throw new AppError(409, 'NO_EARN_FLOW', '這筆交易沒有存入或領出 vault 的 USDT。');
      for (const f of flows) {
        await deps.query(`insert into cash_earn_flows(chain_id,owner,vault_id,kind,assets_raw,tx_hash,log_index,block_number,block_hash)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(chain_id,tx_hash,log_index) do nothing`,
          [deps.chainId, owner, f.vaultId, f.kind, f.assetsRaw.toString(), hash, f.logIndex, receipt.blockNumber.toString(), receipt.blockHash.toLowerCase()]);
      }
      return { status: 'confirmed' as const, recorded: flows.map(f => ({ vaultId: f.vaultId, kind: f.kind, amountRaw: f.assetsRaw.toString() })) };
    },
  };
}
function getConfigChainId(): number {
  const id = Number(process.env.CHAIN_ID?.trim() || '56');
  return Number.isSafeInteger(id) && id > 0 ? id : 56;
}
