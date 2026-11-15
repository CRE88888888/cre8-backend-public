import type { Address, Hex } from 'viem';
import { formatUnits } from 'viem';
import type { PoolClient } from 'pg';
import { configuredChainId } from './testnet-profile.js';
import { query, withPortfolioLock, withTransaction } from './db.js';
import { AppError, ForbiddenError, ValidationError } from './errors.js';
import { requireOwnedPortfolio } from './portfolios.js';
import type { OwnedPortfolio } from './portfolios.js';
import { requireTypedVersion } from './strategies.js';
import type { StrategyVersion } from './strategies.js';
import { readFaucetFundingEvidence, settleFaucetClaim } from './faucet.js';
import { readAccountCash } from './chain.js';
import { defaultAmountUsdt, exactKeys, minimumAllocationRaw, record, usdtRaw, utcDate } from './strategy-execution.js';

export type FundingSource = { kind: 'faucet_claim'; claimId: string };
type LotRow = { id: string; chain_id: string; portfolio_id: string; strategy_id: string; version: number; kind: 'hold' | 'stack';
  tx_hash: Hex; log_index: string; block_number: string; block_hash: Hex; amount_raw: string; state: string; claim_id?: string | null };
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
  cash: typeof readAccountCash;
  settleClaim: typeof settleFaucetClaim;
  chainId: () => number;
  now: () => Date;
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
    blockNumber: row.block_number, blockHash: row.block_hash, amountRaw: row.amount_raw, state: row.state,
    source: row.claim_id ? { kind: 'faucet_claim', claimId: row.claim_id } : null };
}

const storageUnavailable = () => new AppError(503, 'EXECUTION_STORAGE_UNAVAILABLE', 'strategy storage unavailable; retry the original request');
const conflict = () => new AppError(409, 'REVISION_CONFLICT', 'instruction changed; read the current revision before confirming again');

export function createPortfolioStrategyService(overrides: Partial<PortfolioStrategyDeps> = {}) {
  const deps: PortfolioStrategyDeps = { query, transaction: withTransaction, lock: withPortfolioLock, owned: requireOwnedPortfolio,
    version: requireTypedVersion, evidence: readFaucetFundingEvidence, cash: readAccountCash, settleClaim: settleFaucetClaim,
    chainId: configuredChainId, now: () => new Date(), ...overrides };

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
  async function context(id: number, wallet: string, verifyChain = true) {
    const portfolio = await ownedContext(id, wallet);
    const onchainId = (await deps.query<{ onchain_id: string | null }>('select onchain_id from strategies where id=$1', [portfolio.strategyId])).rows[0]?.onchain_id;
    if (!onchainId) throw new AppError(409, 'STRATEGY_NOT_ON_CHAIN', 'strategy has no chain identity');
    const version = await deps.version(portfolio.strategyId, portfolio.version, Number(onchainId), portfolio.accountAddress as Address, { verifyChain });
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
      return { portfolioId: id, chainId: p.chainId, version: p.version, execution: version.execution, configHash: version.configHash,
        enabled: p.scheduleState === 'active', automation: 'awaiting_be2', defaultAmountUsdt: defaultAmountUsdt(version.allocation, p.chainId),
        cash: { ...observed, unclassifiedRaw: difference >= 0n ? difference.toString() : null, deficitRaw: difference < 0n ? (-difference).toString() : '0' },
        balances, instructions: instructions.rows.map(mapInstruction), lots: lots.rows.map(mapLot) };
      });
    }),

    funding: (id: number, wallet: string, input: unknown) => safe(async () => {
      if (!record(input)) throw new ValidationError('INVALID_FUNDING_SOURCE', 'expected { source: { kind, claimId } }');
      exactKeys(input, ['source'], 'INVALID_FUNDING_SOURCE');
      if (!record(input.source)) throw new ValidationError('INVALID_FUNDING_SOURCE', 'source must identify an approved product event');
      exactKeys(input.source, ['kind', 'claimId'], 'INVALID_FUNDING_SOURCE');
      if (input.source.kind !== 'faucet_claim' || deps.chainId() !== 97) throw new ValidationError('FUNDING_SOURCE_DISABLED', 'only chain 97 faucet_claim is currently approved');
      const source: FundingSource = { kind: 'faucet_claim', claimId: positiveId(input.source.claimId) };
      const p = await ownedContext(id, wallet);
      return locked(id, async () => {
        const claim = (await deps.query<{ owner: string; account: string; amount_wei: string; tx_hash: Hex | null; state: string; day: string }>(
          "select owner,account,amount_wei::text,tx_hash,state,to_char(utc_day,'YYYY-MM-DD') as day from faucet_claims where id=$1 and chain_id=$2", [source.claimId, p.chainId])).rows[0];
        if (!claim || claim.owner !== wallet.toLowerCase() || claim.account !== p.accountAddress) throw new ForbiddenError('claim is not an authenticated input to this account');
        const from = claim.state;
        if (!claim.tx_hash || (from !== 'submitted' && from !== 'unknown' && from !== 'confirmed')) throw new AppError(409, 'FUNDING_NOT_CONFIRMED', 'claim has no submitted product transaction');
        const reconcileReorg = async (error: unknown) => {
          if (error instanceof AppError && error.code === 'FUNDING_REORGED') {
            await deps.transaction(async (client) => {
              await cashLock(client, p);
              await client.query(`update strategy_funding_lots set state='reorged',updated_at=clock_timestamp()
                where chain_id=$1 and portfolio_id=$2 and tx_hash=$3 and state='confirmed'`, [p.chainId, id, claim.tx_hash]);
            });
          }
        };
        let evidence;
        try { evidence = await deps.evidence({ chainId: p.chainId, account: p.accountAddress as Address, amountWei: BigInt(claim.amount_wei), txHash: claim.tx_hash }); }
        catch (error) {
          await reconcileReorg(error);
          throw error;
        }
        // A canonical successful faucet transaction is resolved even if its lot is ineligible.
        // Do not leave the shared signer blocked on a known result from an older version.
        if (from !== 'confirmed') await deps.settleClaim({ id: source.claimId, chainId: p.chainId, day: claim.day,
          owner: p.ownerAddress as Address, account: p.accountAddress as Address, amountWei: BigInt(claim.amount_wei) }, from, 'confirmed', claim.tx_hash);
        // The source belongs to its receipt-time enrollment, not a later owner upgrade.
        const onchainId = (await deps.query<{ onchain_id: string }>('select onchain_id from strategies where id=$1', [p.strategyId])).rows[0]?.onchain_id;
        if (!onchainId) throw new AppError(409, 'STRATEGY_NOT_ON_CHAIN', 'strategy has no chain identity');
        const version = await deps.version(p.strategyId, p.version, Number(onchainId), p.accountAddress as Address);
        try { await deps.version(p.strategyId, p.version, Number(onchainId), p.accountAddress as Address, { blockNumber: evidence.blockNumber, blockHash: evidence.blockHash }); }
        catch (error) { await reconcileReorg(error); throw error; }
        const result = await deps.transaction(async (client) => {
          await cashLock(client, p);
          await checkReorg(client, p);
          const original = (await client.query<LotRow>('select * from strategy_funding_lots where chain_id=$1 and tx_hash=$2', [p.chainId, evidence.txHash])).rows[0];
          if (original && (original.log_index !== String(evidence.logIndex) || original.block_hash !== evidence.blockHash || original.block_number !== evidence.blockNumber.toString())) {
            if (Number(original.portfolio_id) !== id) throw new AppError(409, 'FUNDING_EVENT_CONFLICT', 'funding source belongs to another portfolio');
            await client.query("update strategy_funding_lots set state='reorged',updated_at=clock_timestamp() where id=$1", [original.id]);
            return null;
          }
          const kind = version.execution.kind;
          if (kind !== 'hold' && kind !== 'stack') throw new Error('non-typed funding');
          const inserted = await client.query<LotRow>(`insert into strategy_funding_lots
            (chain_id,portfolio_id,strategy_id,version,kind,tx_hash,log_index,block_number,block_hash,amount_raw)
            values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(chain_id,tx_hash,log_index) do nothing returning *`,
            [p.chainId, id, p.strategyId, p.version, kind, evidence.txHash, evidence.logIndex, evidence.blockNumber.toString(), evidence.blockHash, evidence.amountRaw]);
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
            const bucket = kind === 'hold' ? 'unallocated_hold_raw' : 'stack_prefund_raw';
            await client.query(`update strategy_cash_balances set ${bucket}=${bucket}+$3::numeric,updated_at=clock_timestamp() where chain_id=$1 and portfolio_id=$2`,
              [p.chainId, id, evidence.amountRaw]);
          }
          return { ...mapLot(lot), source, replayed: inserted.rows.length === 0 };
        });
        if (result === null) throw new AppError(409, 'FUNDING_REORGED', 'original funding event moved; reconciliation required');
        return result;
      });
    }),

    instruct: (id: number, wallet: string, input: unknown) => safe(async () => {
      const { portfolio: p, version } = await context(id, wallet);
      if (version.execution.kind !== 'stack') throw new ValidationError('NOT_STACK', 'personal stack instructions require a stack version');
      const instruction = validateStackInstruction(input, version);
      return locked(id, () => deps.transaction(async (client) => {
        await cashLock(client, p);
        await checkReorg(client, p);
        const previous = (await client.query<InstructionRow>('select * from stack_instructions where chain_id=$1 and portfolio_id=$2 order by revision desc limit 1', [p.chainId, id])).rows[0];
        const previousRevision = previous?.revision ?? '0';
        if (previous && BigInt(previousRevision) === BigInt(instruction.expectedRevision) + 1n &&
            previous.amount_raw === instruction.amountRaw && previous.period_seconds === instruction.periodSeconds &&
            previous.start_at.getTime() === instruction.startAt.getTime() && (previous.end_at?.getTime() ?? null) === (instruction.endAt?.getTime() ?? null) &&
            previous.version === p.version && previous.state === (instruction.enabled ? 'active' : 'paused')) return mapInstruction(previous);
        if (previousRevision !== instruction.expectedRevision) throw conflict();
        if (instruction.startAt <= deps.now()) throw new ValidationError('START_NOT_FUTURE', 'startAt must be strictly in the future; no immediate first purchase');
        const busy = await client.query(`select id from strategy_jobs where chain_id=$1 and portfolio_id=$2 and state in ('reserved','running','unknown','paused')
          union all select id from operations where portfolio_id=$2 and (state in ('pending','submitted') or (state='failed' and (tx_hash is not null or user_op_hash is not null))) limit 1`, [p.chainId, id]);
        if (busy.rows.length) throw new AppError(409, 'PREVIOUS_INFLIGHT', 'reconcile or cancel the previous work before starting a new revision');
        if (previous && ['active', 'paused'].includes(previous.state)) await client.query("update stack_instructions set state='superseded',updated_at=clock_timestamp() where chain_id=$1 and portfolio_id=$2 and revision=$3", [p.chainId, id, previousRevision]);
        const next = (BigInt(previousRevision) + 1n).toString();
        positiveId(next);
        const created = (await client.query<InstructionRow>(`insert into stack_instructions
          (chain_id,portfolio_id,revision,strategy_id,version,authorized_by,amount_raw,period_seconds,start_at,end_at,funding_source,state,created_at,updated_at)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'prefunded_fund_account',$11,$12,$12) returning *`,
          [p.chainId, id, next, p.strategyId, p.version, p.ownerAddress, instruction.amountRaw, instruction.periodSeconds, instruction.startAt, instruction.endAt,
            instruction.enabled ? 'active' : 'paused', deps.now()])).rows[0];
        if (!created) throw storageUnavailable();
        return mapInstruction(created);
      }));
    }),

    instructionState: (id: number, wallet: string, input: unknown) => safe(async () => {
      if (!record(input)) throw new ValidationError('INVALID_INSTRUCTION', 'expected { revision, state: paused | stopped }');
      exactKeys(input, ['revision', 'state'], 'INVALID_INSTRUCTION');
      const revision = positiveId(input.revision);
      const state = input.state;
      if (state !== 'paused' && state !== 'stopped') throw new ValidationError('INVALID_INSTRUCTION_STATE', 'resume by authorizing a new future revision');
      const { portfolio: p } = await context(id, wallet, false);
      return locked(id, () => deps.transaction(async (client) => {
        await cashLock(client, p);
        const row = (await client.query<InstructionRow>('select * from stack_instructions where chain_id=$1 and portfolio_id=$2 and revision=$3', [p.chainId, id, revision])).rows[0];
        if (!row || !['active', 'paused', state].includes(row.state)) throw conflict();
        if (row.state === state) return mapInstruction(row);
        const updated = (await client.query<InstructionRow>('update stack_instructions set state=$4,updated_at=clock_timestamp() where chain_id=$1 and portfolio_id=$2 and revision=$3 returning *', [p.chainId, id, revision, state])).rows[0];
        if (!updated) throw storageUnavailable();
        return mapInstruction(updated);
      }));
    }),

    executionState: (id: number, wallet: string, input: unknown) => safe(async () => {
      if (!record(input) || typeof input.enabled !== 'boolean') throw new ValidationError('INVALID_EXECUTION_STATE', 'enabled must be a boolean');
      exactKeys(input, ['enabled'], 'INVALID_EXECUTION_STATE');
      const enabled = input.enabled;
      const { portfolio: p, version } = await context(id, wallet, enabled);
      if (version.execution.kind !== 'hold') throw new ValidationError('NOT_HOLD', 'stack must pause/stop its own instruction');
      return locked(id, () => deps.transaction(async (client) => {
        await cashLock(client, p);
        if (enabled) await checkReorg(client, p);
        await client.query('update portfolios set schedule_state=$2 where id=$1', [id, enabled ? 'active' : 'paused']);
        return { portfolioId: id, enabled };
      }));
    }),
  };
}
