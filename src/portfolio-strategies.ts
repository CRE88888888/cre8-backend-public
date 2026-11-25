import { cashDifference } from './yield-domain.js';
import { excludeMixExitBudgets, withMixPortfolioLock } from './mix-store.js';
import { allocateExposure, readAssetExposure } from './asset-exposure.js';
import { planFundingContribution } from './asset-plan.js';
import { minimumFeeReserve } from './rebalance-plan.js';
import { getConfig, loadSessionKeyConfig } from './config.js';
import { getChain } from './chain.js';
import type { Address, Hex, PublicClient } from 'viem';
import { createPublicClient, decodeEventLog, erc20Abi, formatUnits, http } from 'viem';
import type { PoolClient } from 'pg';
import { configuredChainId, TESTNET_97 } from './testnet-profile.js';
import { query, withPortfolioLock, withTransaction } from './db.js';
import { AppError, ForbiddenError, ValidationError } from './errors.js';
import { requireOwnedPortfolio } from './portfolios.js';
import type { OwnedPortfolio } from './portfolios.js';
import { requireTypedVersion } from './strategies.js';
import type { StrategyVersion } from './strategies.js';
import { readFaucetFundingEvidence, settleFaucetClaim } from './faucet.js';
import type { FaucetFundingEvidence } from './faucet.js';
import { createWelcomeService, findWelcomeGrant, readWelcomeFundingEvidence, settleWelcomeGrant } from './welcome-grants.js';
import type { WelcomeGrant } from './welcome-grants.js';
import { readAccountCash } from './chain.js';
import { defaultAmountUsdt, exactKeys, minimumAllocationRaw, record, usdtRaw, utcDate, CONTRIBUTION_FEE_RESERVE_RAW, minimumAssetContribution, minimumDcaTranche, numeraireFor } from './strategy-execution.js';
import type { AssetExecution } from './strategy-execution.js';
import { reservedCash, withdrawableCash } from './withdrawable-cash.js';
import { rpcTransport } from './rpc-transport.js';
import { accountHoldsOnlyCash, pausedBySellAll, RESUME_AFTER_SELL_ALL_SQL } from './sell-all-resume.js';
import { CANCEL_SELL_ALL_SQL, NEW_MONEY_ENDS_SELL_ALL_SQL } from './sell-all-intent.js';

export type FundingSource = { kind: 'faucet_claim'; claimId: string } | { kind: 'welcome_grant'; grantId: string }
  | { kind: 'wallet_transfer'; txHash: Hex }
  /** DCA (定投, db 0064): one tranche the scheduler redeemed from the plan's vault into the account. Internal only, never an HTTP source. */
  | { kind: 'dca_tranche'; evidence: FaucetFundingEvidence };

/** One mined receipt, pinned to its canonical block, as for faucet/welcome funding. */
export async function readWalletFundingEvidence(input: { chainId: number; owner: Address; account: Address; txHash: Hex }, suppliedClient?: PublicClient): Promise<FaucetFundingEvidence> {
  try {
    if (input.chainId !== 97) throw new ValidationError('FUNDING_SOURCE_DISABLED', 'wallet funding is only available on chain 97');
    const txHash = fundingHash(input.txHash);
    const rpcUrl = suppliedClient ? undefined : getConfig().rpcUrl;
    if (!suppliedClient && !rpcUrl) throw new Error('missing RPC');
    const client = suppliedClient ?? createPublicClient({ transport: rpcTransport('portfolio-strategies', rpcUrl ?? undefined, { timeout: 5_000, retryCount: 0 }) });
    if (await client.getChainId() !== 97) throw new Error('wrong RPC chain');
    const receipt = await client.getTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success' || receipt.transactionHash.toLowerCase() !== txHash || receipt.blockNumber < 0n || !/^0x[0-9a-f]{64}$/.test(receipt.blockHash)) {
      throw new AppError(409, 'FUNDING_NOT_CONFIRMED', 'successful wallet transfer receipt is required');
    }
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (block.hash !== receipt.blockHash || block.number !== receipt.blockNumber) throw new AppError(409, 'FUNDING_REORGED', 'wallet funding receipt is not canonical; reconciliation required');
    const matches = receipt.logs.flatMap(log => {
      if (log.address.toLowerCase() !== TESTNET_97.contracts.usdt || log.removed || log.transactionHash?.toLowerCase() !== txHash ||
          log.blockHash !== receipt.blockHash || log.blockNumber !== receipt.blockNumber || log.logIndex === null || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0) return [];
      try {
        const event = decodeEventLog({ abi: erc20Abi, eventName: 'Transfer', data: log.data, topics: log.topics });
        return event.args.from.toLowerCase() === input.owner.toLowerCase() && event.args.to.toLowerCase() === input.account.toLowerCase()
          ? [{ log, amount: event.args.value }] : [];
      } catch { return []; }
    });
    const match = matches[0];
    if (matches.length !== 1 || !match || match.log.logIndex === null || match.amount <= 0n) throw new AppError(409, 'FUNDING_NOT_CONFIRMED', 'one positive owner-to-account USDT Transfer is required');
    const confirmedAt = new Date(Number(block.timestamp) * 1000);
    if (!Number.isSafeInteger(Number(block.timestamp)) || block.timestamp < 0n || !Number.isFinite(confirmedAt.getTime())) throw new Error('invalid confirmation time');
    return { txHash, logIndex: match.log.logIndex, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, amountRaw: match.amount.toString(), confirmedAt };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'FUNDING_RPC_UNAVAILABLE', 'wallet funding confirmation unavailable; no new lot credited');
  }
}

function fundingHash(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new ValidationError('INVALID_FUNDING_SOURCE', 'txHash must be a bytes32 hex string');
  return `0x${value.slice(2).toLowerCase()}`;
}
type LotRow = { id: string; chain_id: string; portfolio_id: string; strategy_id: string; version: number; kind: 'hold' | 'stack' | 'asset'; effective_slices?: Record<string,number>; created_at: Date;
  effective_allocation: Record<string, number> | null; allocation_reason: 'version' | 'exposure_cap'; capped_assets: string[];
  tx_hash: Hex; log_index: string; block_number: string; block_hash: Hex; amount_raw: string; state: string; claim_id?: string | null;
  source_kind: 'faucet_claim' | 'welcome_grant' | null; faucet_claim_id: string | null; welcome_grant_id: string | null };
type InstructionRow = { revision: string; strategy_id: string; version: number; authorized_by: string; amount_raw: string;
  period_seconds: number; start_at: Date; end_at: Date | null; state: string; funding_source: string; next_slot_index: string; next_slot_at: Date };
type Instruction = { expectedRevision: string; amountRaw: string; periodSeconds: number; startAt: Date; endAt: Date | null; enabled: boolean };

export type PortfolioStrategyDeps = {
  query: typeof query;
  transaction: typeof withTransaction;
  lock: typeof withPortfolioLock;
  owned: typeof requireOwnedPortfolio;
  version: typeof requireTypedVersion;
  evidence: typeof readFaucetFundingEvidence;
  walletEvidence: typeof readWalletFundingEvidence;
  cash: typeof readAccountCash;
  settleClaim: typeof settleFaucetClaim;
  welcome: ReturnType<typeof createWelcomeService>;
  welcomeGrant: typeof findWelcomeGrant;
  welcomeEvidence: typeof readWelcomeFundingEvidence;
  settleWelcome: typeof settleWelcomeGrant;
  chainId: () => number;
  now: () => Date;
  feeReserve: (portfolio: OwnedPortfolio, version: StrategyVersion) => Promise<bigint>;
  exposure: typeof readAssetExposure;
  /** The account holds nothing but cash right now (src/sell-all-resume.ts). Read only for a paused portfolio. */
  holdsOnlyCash: (portfolioId: number) => Promise<boolean>;
};

function positiveId(value: unknown, zero = false): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n || (!zero && value === '0')) {
    throw new ValidationError('INVALID_REVISION', 'claimId/revision must be an unsigned bigint decimal string');
  }
  return value;
}

export function validateStackInstruction(input: unknown, version: StrategyVersion): Instruction {
  if (!record(input)) throw new ValidationError('INVALID_INSTRUCTION', 'instruction must be an object');
  exactKeys(input, ['expectedRevision', 'amountUsdt', 'periodSeconds', 'startAt', 'endAt', 'enabled', 'fundingSource'], 'INVALID_INSTRUCTION');
  const expectedRevision = positiveId(input.expectedRevision, true);
  const amount = usdtRaw(input.amountUsdt === undefined ? defaultAmountUsdt(version.allocation, version.executionChainId ?? configuredChainId()) : input.amountUsdt);
  if (amount < minimumAllocationRaw(version.allocation, version.executionChainId ?? configuredChainId())) {
    throw new ValidationError('BELOW_MINIMUM_ALLOCATION', 'amountUsdt cannot meet the complete basket 5/50 minimums');
  }
  const periodSeconds = input.periodSeconds === undefined ? 604800 : input.periodSeconds;
  if (periodSeconds !== 86400 && periodSeconds !== 604800) throw new ValidationError('INVALID_PERIOD', 'periodSeconds must be 86400 or 604800');
  if (input.fundingSource !== undefined && input.fundingSource !== 'prefunded_fund_account') {
    throw new ValidationError('INVALID_FUNDING_SOURCE', 'only prefunded_fund_account is supported');
  }
  if (typeof input.enabled !== 'boolean') throw new ValidationError('AUTHORIZATION_REQUIRED', 'enabled must be explicitly confirmed by the account owner');
  const startAt = utcDate(input.startAt, 'startAt');
  const endAt = input.endAt === undefined || input.endAt === null ? null : utcDate(input.endAt, 'endAt');
  if (endAt !== null && endAt <= startAt) throw new ValidationError('INVALID_TIME', 'endAt must be strictly later than startAt');
  return { expectedRevision, amountRaw: amount.toString(), periodSeconds, startAt, endAt, enabled: input.enabled };
}

function mapInstruction(row: InstructionRow) {
  return { revision: row.revision, strategyId: Number(row.strategy_id), version: row.version, authorizedBy: row.authorized_by,
    amountRaw: row.amount_raw, amountUsdt: formatUnits(BigInt(row.amount_raw), 18), periodSeconds: row.period_seconds,
    startAt: row.start_at.toISOString(), endAt: row.end_at?.toISOString() ?? null, state: row.state,
    fundingSource: row.funding_source, nextSlotIndex: row.next_slot_index, nextSlotAt: row.next_slot_at.toISOString() };
}
function mapLot(row: LotRow) {
  return { id: row.id, chainId: Number(row.chain_id), portfolioId: Number(row.portfolio_id), strategyId: Number(row.strategy_id),
    version: row.version, kind: row.kind, txHash: row.tx_hash, logIndex: row.log_index,
    effectiveSlices: row.effective_slices ?? null, confirmedAt: row.created_at.toISOString(), blockNumber: row.block_number, blockHash: row.block_hash, amountRaw: row.amount_raw, state: row.state,
    effectiveAllocation: row.effective_allocation, allocationReason: row.allocation_reason, cappedAssets: row.capped_assets,
    source: row.source_kind === 'welcome_grant' ? { kind: 'welcome_grant', grantId: row.welcome_grant_id }
      : row.faucet_claim_id || row.claim_id ? { kind: 'faucet_claim', claimId: row.faucet_claim_id ?? row.claim_id } : null };
}

const storageUnavailable = () => new AppError(503, 'EXECUTION_STORAGE_UNAVAILABLE', 'strategy storage unavailable; retry the original request');
const conflict = () => new AppError(409, 'REVISION_CONFLICT', 'instruction changed; read the current revision before confirming again');

export function createPortfolioStrategyService(overrides: Partial<PortfolioStrategyDeps> = {}) {
  const deps: PortfolioStrategyDeps = { query, transaction: withTransaction, lock: withMixPortfolioLock, owned: requireOwnedPortfolio,
    version: requireTypedVersion, evidence: readFaucetFundingEvidence, walletEvidence: readWalletFundingEvidence, cash: readAccountCash, settleClaim: settleFaucetClaim,
    welcome: createWelcomeService(), welcomeGrant: findWelcomeGrant, welcomeEvidence: readWelcomeFundingEvidence, settleWelcome: settleWelcomeGrant,
    chainId: configuredChainId, now: () => new Date(), exposure: readAssetExposure, holdsOnlyCash: accountHoldsOnlyCash, feeReserve: async (p) => {
      const chain = getChain();
      const block = await chain.publicClient.getBlockNumber({cacheTime:0});
      const sid = (await query<{onchain_id:string}>('select onchain_id from strategies where id=$1',[p.strategyId])).rows[0];
      if(!sid)throw storageUnavailable();
      return minimumFeeReserve(chain.publicClient, loadSessionKeyConfig().executorAddress ?? (()=>{throw storageUnavailable();})(), BigInt(sid.onchain_id), block,p.accountAddress as Address,p.chainId===97);
    }, ...overrides };

  async function safe<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); }
    catch (error) { if (error instanceof AppError) throw error; throw storageUnavailable(); }
  }
  async function ownedContext(id: number, wallet: string) {
    const portfolio = await deps.owned(id, wallet);
    if (portfolio.chainId !== deps.chainId()) throw new AppError(409, 'CHAIN_MISMATCH', 'portfolio belongs to another chain');
    if (portfolio.ownerAddress.toLowerCase() !== wallet.toLowerCase()) throw new ForbiddenError('smart account belongs to another owner');
    return portfolio;
  }
  async function context(id: number, wallet: string, verifyChain = true, requireLatest = false) {
    const portfolio = await ownedContext(id, wallet);
    const onchainId = (await deps.query<{ onchain_id: string | null }>('select onchain_id from strategies where id=$1', [portfolio.strategyId])).rows[0]?.onchain_id;
    if (!onchainId) throw new AppError(409, 'STRATEGY_NOT_ON_CHAIN', 'strategy has no chain identity');
    const version = await deps.version(portfolio.strategyId, portfolio.version, Number(onchainId), portfolio.accountAddress as Address, { verifyChain, requireLatest });
    return { portfolio, version };
  }
  async function locked<T>(id: number, run: () => Promise<T>): Promise<T> {
    const result = await deps.lock(id, run);
    if (result === null) throw new AppError(409, 'PORTFOLIO_BUSY', 'portfolio is being processed; retry the same request');
    return result;
  }
  async function cashLock(client: PoolClient, p: OwnedPortfolio) {
    await client.query("set transaction isolation level read committed");
    await client.query("set local lock_timeout='5s'");
    await client.query(`insert into strategy_cash_balances(chain_id,portfolio_id,account) values($1,$2,$3)
      on conflict(chain_id,portfolio_id) do nothing`, [p.chainId, p.id, p.accountAddress]);
    // Separate statement: a waiter must see the winner's committed buckets on the next read.
    await client.query('select portfolio_id from strategy_cash_balances where chain_id=$1 and portfolio_id=$2 for update', [p.chainId, p.id]);
    const current = (await client.query<{ version: number; strategy_id: string }>('select version,strategy_id from portfolios where id=$1 for update', [p.id])).rows[0];
    if (!current || current.version !== p.version || Number(current.strategy_id) !== p.strategyId) throw new AppError(409, 'PINNED_VERSION_CHANGED', 'portfolio version changed; confirm again');
  }
  async function checkReorg(client: PoolClient, p: OwnedPortfolio) {
    const rows = await client.query("select id from strategy_funding_lots where chain_id=$1 and portfolio_id=$2 and state='reorged' limit 1", [p.chainId, p.id]);
    if (rows.rows.length) throw new AppError(409, 'FUNDING_REORGED', 'funding reconciliation is required before new authorization');
  }

  async function reconcileFundingReorg(p: OwnedPortfolio, txHash: Hex, error: unknown) {
    if (error instanceof AppError && error.code === 'FUNDING_REORGED') {
      await deps.transaction(async (client) => {
        await cashLock(client, p);
        await client.query(`update strategy_funding_lots set state='reorged',updated_at=clock_timestamp()
          where chain_id=$1 and portfolio_id=$2 and tx_hash=$3 and state='confirmed'`, [p.chainId, p.id, txHash]);
      });
    }
  }

  async function fundingEvidence(p: OwnedPortfolio, wallet: string, source: FundingSource) {
    if (source.kind === 'dca_tranche') return source.evidence;
    if (source.kind === 'wallet_transfer') {
      try { return await deps.walletEvidence({ chainId: p.chainId, owner: p.ownerAddress as Address, account: p.accountAddress as Address, txHash: source.txHash }); }
      catch (error) { await reconcileFundingReorg(p, source.txHash, error); throw error; }
    }
    const welcomeGrant = source.kind === 'welcome_grant' ? await deps.welcomeGrant(p.chainId, wallet) : null;
    if (source.kind === 'welcome_grant' && (!welcomeGrant || welcomeGrant.id !== source.grantId || welcomeGrant.portfolioId !== p.id || welcomeGrant.account !== p.accountAddress)) throw new ForbiddenError('welcome is not an authenticated input to this account');
    const claim = welcomeGrant ? { owner: welcomeGrant.owner, account: welcomeGrant.account, amount_wei: welcomeGrant.amountWei.toString(), tx_hash: welcomeGrant.txHash, state: welcomeGrant.state, day: welcomeGrant.day } : (await deps.query<{ owner: string; account: string; amount_wei: string; tx_hash: Hex | null; state: string; day: string }>(
      "select owner,account,amount_wei::text,tx_hash,state,to_char(utc_day,'YYYY-MM-DD') as day from faucet_claims where id=$1 and chain_id=$2", [source.kind === 'faucet_claim' ? source.claimId : '', p.chainId])).rows[0];
    if (!claim || claim.owner !== wallet.toLowerCase() || claim.account !== p.accountAddress) throw new ForbiddenError('claim is not an authenticated input to this account');
    const from = claim.state;
    if (!claim.tx_hash || (from !== 'submitted' && from !== 'unknown' && from !== 'confirmed')) throw new AppError(409, 'FUNDING_NOT_CONFIRMED', 'claim has no submitted product transaction');
    const claimHash = claim.tx_hash;
    const reconcileReorg = (error: unknown) => reconcileFundingReorg(p, claimHash, error);
    let evidence;
    try { evidence = await (welcomeGrant ? deps.welcomeEvidence : deps.evidence)({ chainId: p.chainId, account: p.accountAddress as Address, amountWei: BigInt(claim.amount_wei), txHash: claim.tx_hash }); }
    catch (error) {
      if (welcomeGrant && from === 'confirmed' && error instanceof AppError && error.code === 'WELCOME_REVERTED') {
        const reorg = new AppError(409, 'FUNDING_REORGED', 'confirmed welcome mint reverted; reconciliation required');
        await reconcileReorg(reorg);
        throw reorg;
      }
      if (welcomeGrant && error instanceof AppError && error.code === 'WELCOME_REVERTED' && from !== 'confirmed') await deps.settleWelcome(welcomeGrant, 'failed', claim.tx_hash);
      await reconcileReorg(error);
      throw error;
    }
    // A canonical successful faucet transaction is resolved even if its lot is ineligible.
    // Do not leave the shared signer blocked on a known result from an older version.
    if (welcomeGrant) {
      if (from === 'confirmed' && (welcomeGrant.logIndex !== evidence.logIndex || welcomeGrant.blockHash !== evidence.blockHash || welcomeGrant.blockNumber !== evidence.blockNumber)) {
        const error = new AppError(409, 'FUNDING_REORGED', 'original welcome evidence moved; reconciliation required');
        await reconcileReorg(error); throw error;
      }
      if (from !== 'confirmed') await deps.settleWelcome(welcomeGrant, 'confirmed', claim.tx_hash, evidence);
    } else if (from !== 'confirmed' && source.kind === 'faucet_claim') await deps.settleClaim({ id: source.claimId, chainId: p.chainId, day: claim.day,
      owner: p.ownerAddress as Address, account: p.accountAddress as Address, amountWei: BigInt(claim.amount_wei) }, from, 'confirmed', claim.tx_hash);
    return evidence;
  }

  async function creditFunding(p: OwnedPortfolio, wallet: string, source: FundingSource) {
    const id = p.id;
    const evidence = await fundingEvidence(p, wallet, source);
    // The source belongs to its receipt-time enrollment, not a later owner upgrade.
    const onchainId = (await deps.query<{ onchain_id: string }>('select onchain_id from strategies where id=$1', [p.strategyId])).rows[0]?.onchain_id;
    if (!onchainId) throw new AppError(409, 'STRATEGY_NOT_ON_CHAIN', 'strategy has no chain identity');
    const version = await deps.version(p.strategyId, p.version, Number(onchainId), p.accountAddress as Address);
    try { await deps.version(p.strategyId, p.version, Number(onchainId), p.accountAddress as Address, { requireLatest: true, blockNumber: evidence.blockNumber, blockHash: evidence.blockHash }); }
    catch (error) { await reconcileFundingReorg(p, evidence.txHash, error); throw error; }
    const confirmedAt = evidence.confirmedAt;
    const feeReserve = version.execution.kind === 'per_asset' && version.execution.assets.some(a=>a.asset!==numeraireFor(p.chainId)) ? await deps.feeReserve(p,version) : 0n;
    if(feeReserve<0n||feeReserve>CONTRIBUTION_FEE_RESERVE_RAW)throw new AppError(503,'MIN_FEE_UNAVAILABLE','contribution fee bound unavailable');
    // "Sell all" paused this portfolio and the scheduler only claims active ones: the owner's new money resumes it
    // (src/sell-all-resume.ts). A DCA tranche is not the owner putting money in, so it never does.
    const resume = source.kind !== 'dca_tranche' && await pausedBySellAll(p, deps.holdsOnlyCash);
    const result = await deps.transaction(async (client) => {
      await cashLock(client, p);
      await checkReorg(client, p);
      if (p.personalMix) {
        if ((await client.query(`select 1 from mix_switch_intents i join mix_portfolio_history h on h.mix_id=i.mix_id
          where h.portfolio_id=$1 and h.ended_at is null and i.state in ('prepared','submitted','unknown')`, [id])).rows.length) {
          throw new AppError(409, 'MIX_SWITCH_PENDING', '組合變更確認後，這筆入金會在新組合處理。');
        }
        const segment = (await client.query<{ previous_history_id: string | null; enroll_block_number: string }>(
          'select previous_history_id,enroll_block_number::text from mix_portfolio_history where portfolio_id=$1 and ended_at is null', [id])).rows[0];
        if (!segment) throw new AppError(503, 'MIX_HISTORY_UNAVAILABLE', '目前無法確認私人組合的入金期間。');
        if (segment.previous_history_id !== null && evidence.blockNumber <= BigInt(segment.enroll_block_number)) {
          throw new AppError(409, 'MIX_FUNDING_ALREADY_CARRIED', '這筆入金已包含在改比例的承接現金，不會重複計入。');
        }
      }
      const original = (source.kind === 'wallet_transfer' || source.kind === 'dca_tranche'
        ? await client.query<LotRow>(`select * from strategy_funding_lots where chain_id=$1 and tx_hash=$2
            and (log_index=$3 or portfolio_id=$4) order by (log_index=$3) desc limit 1`, [p.chainId, evidence.txHash, evidence.logIndex, id])
        : await client.query<LotRow>('select * from strategy_funding_lots where chain_id=$1 and tx_hash=$2', [p.chainId, evidence.txHash])).rows[0];
      if (original && (original.log_index !== String(evidence.logIndex) || original.block_hash !== evidence.blockHash || original.block_number !== evidence.blockNumber.toString())) {
        if (Number(original.portfolio_id) !== id) throw new AppError(409, 'FUNDING_EVENT_CONFLICT', 'funding source belongs to another portfolio');
        await client.query("update strategy_funding_lots set state='reorged',updated_at=clock_timestamp() where id=$1", [original.id]);
        return null;
      }
      const kind = version.execution.kind === 'per_asset' ? 'asset' : version.execution.kind;
      if (kind !== 'asset' && kind !== 'hold') throw new Error('non-typed funding');
      if(original){
        if (original.source_kind !== null && (original.source_kind !== source.kind || (source.kind === 'welcome_grant' ? original.welcome_grant_id !== source.grantId : source.kind === 'faucet_claim' && original.faucet_claim_id !== source.claimId))) throw new AppError(409, 'FUNDING_EVENT_CONFLICT', 'funding source identity conflicts with the saved origin');
        if(Number(original.portfolio_id)!==id||Number(original.strategy_id)!==p.strategyId||original.version!==p.version||original.kind!==kind||original.amount_raw!==evidence.amountRaw||original.state!=='confirmed')throw new AppError(409,'FUNDING_EVENT_CONFLICT','funding event conflicts with its original authorization');
        return { ...mapLot(original), source, replayed:true, fundingStatus:'recorded' };
      }
      const allocation = version.execution.kind === 'per_asset' ? allocateExposure(version.execution,
        await deps.exposure(p.strategyId, p.chainId, version.execution.assets.map(a => a.asset), {
          query: (sql, params) => client.query(sql, params === undefined ? [] : [...params]), cappedOnly: true,
        })) : null;
      const execution = allocation?.execution;
      // DCA (db 0064): one tranche only has to form a complete 10 USDT fee-inclusive batch; one-time buys keep 50.
      const dca = source.kind === 'dca_tranche';
      const floor = (config: AssetExecution) => dca ? minimumDcaTranche(config) : minimumAssetContribution(config);
      const standalone = execution ? planFundingContribution(BigInt(evidence.amountRaw),execution,confirmedAt,p.chainId,dca?minimumDcaTranche(execution):undefined) : null;
      // Subscription minimum is distinct from the eventual account/time batch.
      // An individually small source may join another lot at the same creator slot.
      // Preserve the signed subscription minimum, even if redistribution would lower it.
      const originalMinimum=version.execution.kind==='per_asset'?floor(version.execution):0n;
      const effectiveMinimum=execution?floor(execution):0n;
      const minimum=originalMinimum>effectiveMinimum?originalMinimum:effectiveMinimum;
      if(kind==='asset'&&BigInt(evidence.amountRaw)<minimum)throw new ValidationError('BELOW_MINIMUM_ALLOCATION',`minimum total contribution is ${formatUnits(minimum,18)} USDT including fees`);
      const contribution=standalone?{...standalone,minimum}:(execution?{minimum,effectiveSlices:Object.fromEntries(execution.assets.filter(a=>a.asset!==numeraireFor(p.chainId)).map(a=>[a.asset,1]))}:null);
      const inserted = await client.query<LotRow>(`insert into strategy_funding_lots
        (chain_id,portfolio_id,strategy_id,version,kind,tx_hash,log_index,block_number,block_hash,amount_raw,minimum_contribution_raw,effective_slices,created_at,updated_at,source_kind,faucet_claim_id,welcome_grant_id,effective_allocation,allocation_reason,capped_assets)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14,$15,$16,$17,$18,$19) on conflict(chain_id,tx_hash,log_index) do nothing returning *`,
        [p.chainId, id, p.strategyId, p.version, kind, evidence.txHash, evidence.logIndex, evidence.blockNumber.toString(), evidence.blockHash, evidence.amountRaw, contribution?.minimum.toString() ?? null, contribution ? JSON.stringify(contribution.effectiveSlices) : null, confirmedAt, source.kind === 'wallet_transfer' || source.kind === 'dca_tranche' ? null : source.kind, source.kind === 'faucet_claim' ? source.claimId : null, source.kind === 'welcome_grant' ? source.grantId : null,
          allocation?.effectiveAllocation ? JSON.stringify(allocation.effectiveAllocation) : null, allocation?.allocationReason ?? 'version', JSON.stringify(allocation?.cappedAssets ?? [])]);
      // New money wakes an idle-backed-off portfolio (scheduler IDLE_BACKOFF_SECONDS) for the next round.
      if (inserted.rows.length === 1) await client.query('update portfolios set next_run_at=null where id=$1', [id]);
      if (inserted.rows.length === 1 && resume) await client.query(RESUME_AFTER_SELL_ALL_SQL, [id]);
      // The same new money while a "sell all" is still unfinished ends that request (src/sell-all-intent.ts).
      if (inserted.rows.length === 1 && source.kind !== 'dca_tranche') await client.query(NEW_MONEY_ENDS_SELL_ALL_SQL, [id]);
      const lot = (await client.query<LotRow>('select * from strategy_funding_lots where chain_id=$1 and tx_hash=$2 and log_index=$3',
        [p.chainId, evidence.txHash, evidence.logIndex])).rows[0];
      if (!lot || Number(lot.portfolio_id) !== id || Number(lot.strategy_id) !== p.strategyId || lot.version !== p.version || lot.kind !== kind ||
          lot.amount_raw !== evidence.amountRaw || lot.block_number !== evidence.blockNumber.toString() || lot.block_hash !== evidence.blockHash || lot.state !== 'confirmed') {
        if (lot && Number(lot.portfolio_id) === id && lot.block_hash !== evidence.blockHash) {
          await client.query("update strategy_funding_lots set state='reorged',updated_at=clock_timestamp() where id=$1", [lot.id]);
          return null;
        }
        throw new AppError(409, 'FUNDING_EVENT_CONFLICT', 'funding event identity conflicts with the saved source');
      }
      if (inserted.rows.length === 1) {
        if(kind==='asset' && version.execution.kind==='per_asset') {
          const amounts = (await client.query<{asset:string;budget_raw:string}>('select asset,budget_raw::text from strategy_lot_assets where lot_id=$1',[lot.id])).rows;
          let hold=0n,stack=0n,cash=0n;
          for(const a of amounts){
            const setting=version.execution.assets.find(e=>e.asset===a.asset);
            if(!setting)throw storageUnavailable();
            if(a.asset===version.execution.numeraire)cash+=BigInt(a.budget_raw);
            else if(setting.execution?.kind==='stack')stack+=BigInt(a.budget_raw);else hold+=BigInt(a.budget_raw);
          }
          if(hold+stack+cash!==BigInt(evidence.amountRaw))throw storageUnavailable();
          await client.query(`update strategy_cash_balances set unallocated_hold_raw=unallocated_hold_raw+$3::numeric,stack_prefund_raw=stack_prefund_raw+$4::numeric,allocated_cash_raw=allocated_cash_raw+$5::numeric,updated_at=clock_timestamp() where chain_id=$1 and portfolio_id=$2`,[p.chainId,id,hold.toString(),stack.toString(),cash.toString()]);
        } else {
        const bucket = 'unallocated_hold_raw';
        await client.query(`update strategy_cash_balances set ${bucket}=${bucket}+$3::numeric,updated_at=clock_timestamp() where chain_id=$1 and portfolio_id=$2`,
          [p.chainId, id, evidence.amountRaw]);
        }
      }
      if (inserted.rows.length === 1 && p.personalMix) await excludeMixExitBudgets(client, id);
      return { ...mapLot(lot), source, replayed: inserted.rows.length === 0, fundingStatus:standalone===null?'waiting_for_merged_budget':'scheduled' };
    });
    if (result === null) throw new AppError(409, 'FUNDING_REORGED', 'original funding event moved; reconciliation required');
    return result;
  }

  return {
    read: (id: number, wallet: string) => safe(async () => {
      const { portfolio: p, version } = await context(id, wallet);
      return locked(id, async () => {
      const balances = (await deps.query(`select unallocated_hold_raw::text,stack_prefund_raw::text,allocated_cash_raw::text,
        reserved_input_raw::text,reserved_fee_raw::text,withdrawal_raw::text,yield_raw::text,unclassified_raw::text
        from strategy_cash_balances where chain_id=$1 and portfolio_id=$2`, [p.chainId, id])).rows[0] ?? null;
      const instructions = await deps.query<InstructionRow>('select * from stack_instructions where chain_id=$1 and portfolio_id=$2 order by revision desc limit 100', [p.chainId, id]);
      const lots = await deps.query<LotRow>(`select l.*,(select f.id::text from faucet_claims f where f.chain_id=l.chain_id and f.tx_hash=l.tx_hash) as claim_id
        from strategy_funding_lots l where l.chain_id=$1 and l.portfolio_id=$2 order by l.id desc limit 100`, [p.chainId, id]);
      const observed = await deps.cash(p.chainId, p.accountAddress as Address);
      const classified = Object.entries(balances ?? {}).filter(([key]) => key !== 'unclassified_raw')
        .reduce((sum, [, value]) => { if (typeof value !== 'string' || !/^\d+$/.test(value)) throw storageUnavailable(); return sum + BigInt(value); }, 0n);
      const difference = BigInt(observed.amountRaw) - classified;
      const yieldPending=(await deps.query("select execution_key from yield_actions where chain_id=$1 and portfolio_id=$2 and state in ('reserved','submitted','unknown') limit 1",[p.chainId,id])).rows.length>0;
      const lotAssets = await deps.query(`select a.* from strategy_lot_assets a join strategy_funding_lots l on l.id=a.lot_id where l.chain_id=$1 and l.portfolio_id=$2 order by a.lot_id,a.asset`,[p.chainId,id]);
      const slices = await deps.query(`select s.* from strategy_asset_slices s join strategy_funding_lots l on l.id=s.lot_id where l.chain_id=$1 and l.portfolio_id=$2 order by s.lot_id,s.asset,s.slice_index`,[p.chainId,id]);
      const jobs = await deps.query(`select id::text,kind,lot_id::text,instruction_revision::text,slot_index::text,through_slot_index::text,
        slot_at,window_end_at,amount_raw::text,fee_reserve_raw::text,allocated_cash_raw::text,original_input,remaining_input,
        remaining_fee_raw::text,state,failure_count,next_check_at from strategy_jobs where chain_id=$1 and portfolio_id=$2 order by id desc limit 100`,[p.chainId,id]);
      return { portfolioId: id, chainId: p.chainId, version: p.version, execution: version.execution, configHash: version.configHash,
        lotAssets: lotAssets.rows, slices:slices.rows, enabled: p.scheduleState === 'active', automation: p.chainId===97?'enabled':'testnet_only', jobs:jobs.rows,
        defaultAmountUsdt: version.execution.kind==='per_asset'?formatUnits(minimumAssetContribution(version.execution),18):defaultAmountUsdt(version.allocation, p.chainId),
        // The owner's withdraw sheet caps at this (never cash a running buy has reserved).
        cash: { ...observed, ...cashDifference(difference,yieldPending), withdrawableRaw: withdrawableCash(BigInt(observed.amountRaw), balances).toString(),
          reservedRaw: reservedCash(balances).toString() },
        balances, instructions: instructions.rows.map(mapInstruction), lots: lots.rows.map(mapLot) };
      });
    }),

    funding: (id: number, wallet: string, input: unknown) => safe(async () => {
      if (!record(input)) throw new ValidationError('INVALID_FUNDING_SOURCE', 'expected { source: { kind, claimId/grantId/txHash } }');
      exactKeys(input, ['source'], 'INVALID_FUNDING_SOURCE');
      if (!record(input.source)) throw new ValidationError('INVALID_FUNDING_SOURCE', 'source must identify an approved product event');
      const welcome = input.source.kind === 'welcome_grant';
      const transfer = input.source.kind === 'wallet_transfer';
      exactKeys(input.source, welcome ? ['kind', 'grantId'] : transfer ? ['kind', 'txHash'] : ['kind', 'claimId'], 'INVALID_FUNDING_SOURCE');
      if (!welcome && !transfer && input.source.kind !== 'faucet_claim' || deps.chainId() !== 97) throw new ValidationError('FUNDING_SOURCE_DISABLED', 'only chain 97 product funding is approved');
      const source: FundingSource = transfer ? { kind: 'wallet_transfer', txHash: fundingHash(input.source.txHash) }
        : welcome ? { kind: 'welcome_grant', grantId: positiveId(input.source.grantId) }
        : { kind: 'faucet_claim', claimId: positiveId(input.source.claimId) };
      const p = await ownedContext(id, wallet);
      return locked(id, async () => {
        return creditFunding(p, wallet, source);
      });
    }),

    /** DCA (db 0064): credit exactly one redeemed tranche as an ordinary funding lot of the account's current portfolio. */
    creditDcaTranche: (id: number, owner: string, evidence: FaucetFundingEvidence) => safe(async () => {
      const p = await ownedContext(id, owner);
      return locked(id, async () => creditFunding(p, owner, { kind: 'dca_tranche', evidence }));
    }),

    buyFunding: (id: number, wallet: string, input: unknown) => safe(async () => {
      if (!record(input)) throw new ValidationError('INVALID_PURCHASE', 'expected an empty purchase funding request');
      exactKeys(input, [], 'INVALID_PURCHASE');
      if (deps.chainId() !== 97) throw new ValidationError('FUNDING_SOURCE_DISABLED', 'purchase funding is only available on chain 97');
      const { portfolio: p } = await context(id, wallet);
      return locked(id, async () => {
        await deps.transaction(async client => { await checkReorg(client, p); });
        let grant: WelcomeGrant | null = await deps.welcomeGrant(p.chainId, wallet);
        // Reconcile the original mint before looking at balance: a successful mint may
        // already be visible on chain while its lot/COMMIT acknowledgement is missing.
        if (grant?.portfolioId === id && grant.txHash && ['submitted', 'unknown', 'confirmed'].includes(grant.state)) {
          const lot = await creditFunding(p, wallet, { kind: 'welcome_grant', grantId: grant.id });
          const cash = await deps.cash(p.chainId, p.accountAddress as Address);
          if (!/^\d+$/.test(cash.amountRaw)) throw storageUnavailable();
          if (BigInt(cash.amountRaw) === 0n) throw new AppError(409, 'DAILY_FAUCET_REQUIRED', 'welcome spent; claim daily 1000 test USDT via POST /faucet/usdt for this account');
          return { state: 'ready' as const, lot, funding: 'welcome_grant' as const };
        }
        const cash = await deps.cash(p.chainId, p.accountAddress as Address);
        if (!/^\d+$/.test(cash.amountRaw)) throw storageUnavailable();
        if (grant && BigInt(cash.amountRaw) > 0n) return { state: 'ready' as const, lot: null, funding: 'existing_cash' as const };
        if (!grant) {
          // Existing receipts above must still reconcile against their original block/version.
          // A fresh mint must never fund a version the scheduler can no longer buy.
          await context(id, wallet, true, true);
          grant = await deps.welcome.issue({ chainId: 97, owner: p.ownerAddress as Address, portfolioId: id, account: p.accountAddress as Address });
        }
        if (grant.portfolioId !== id || grant.state === 'failed') {
          throw new AppError(409, 'DAILY_FAUCET_REQUIRED', 'welcome already assigned; claim daily 1000 test USDT via POST /faucet/usdt for this account');
        }
        if (!grant.txHash || grant.state === 'unknown') return { state: 'pending' as const, grantId: grant.id, txHash: grant.txHash, funding: 'welcome_grant' as const, lot: null };
        const lot = await creditFunding(p, wallet, { kind: 'welcome_grant', grantId: grant.id });
        return { state: 'ready' as const, lot, funding: 'welcome_grant' as const };
      });
    }),

    instruct: async (_id: number, _wallet: string, _input: unknown): Promise<never> => { throw new AppError(410,'STACK_INSTRUCTIONS_RETIRED','creator per-asset parameters replace personal instructions'); },
    instructionState: async (_id: number, _wallet: string, _input: unknown): Promise<never> => { throw new AppError(410,'STACK_INSTRUCTIONS_RETIRED','creator per-asset parameters replace personal instructions'); },

    executionState: (id: number, wallet: string, input: unknown) => safe(async () => {
      if (!record(input) || typeof input.enabled !== 'boolean') throw new ValidationError('INVALID_EXECUTION_STATE', 'enabled must be a boolean');
      exactKeys(input, ['enabled'], 'INVALID_EXECUTION_STATE');
      const enabled = input.enabled;
      const { portfolio: p, version } = await context(id, wallet, enabled);
      if (version.execution.kind !== 'hold' && version.execution.kind !== 'per_asset') throw new ValidationError('EXECUTION_RETIRED', 'legacy stack is read-only');
      return locked(id, () => deps.transaction(async (client) => {
        await cashLock(client, p);
        if (enabled) await checkReorg(client, p);
        await client.query('update portfolios set schedule_state=$2 where id=$1', [id, enabled ? 'active' : 'paused']);
        // The owner sets the state by hand: an unfinished "sell all" no longer decides it (src/sell-all-intent.ts).
        await client.query(CANCEL_SELL_ALL_SQL, [id]);
        return { portfolioId: id, enabled };
      }));
    }),
  };
}
