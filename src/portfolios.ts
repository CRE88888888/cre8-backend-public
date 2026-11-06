import { enrollOnchain } from './chain.js';
import { getConfig } from './config.js';
import { query, withTransaction } from './db.js';
import { NotFoundError, ValidationError } from './errors.js';

export type Portfolio = {
  id: number;
  userId: string;
  strategyId: number;
  version: number;
  scheduleState: string;
  createdAt: string;
  smartAccounts: SmartAccount[];
};

export type SmartAccount = {
  chainId: number;
  address: string;
  owner: string;
  accountType: string;
};

type StrategyOnchainRow = { onchain_id: string | null; active_version: number | null };
type PortfolioRow = {
  id: string;
  user_id: string;
  strategy_id: string;
  version: number;
  schedule_state: string;
  created_at: Date;
};
type SmartAccountRow = {
  chain_id: string;
  address: string;
  owner: string;
  account_type: string;
};

/**
 * Enroll `wallet` (the authenticated session wallet, an EOA for now) into a strategy.
 *
 * Order matters: the on-chain enroll happens before the DB write, so a chain revert leaves no DB
 * row claiming an enrollment that never happened (the reverse — an on-chain enrollment without a
 * DB row — is harmless and self-heals on retry). The account is the wallet's EOA; smart-account
 * deployment is a later slice.
 */
export async function enrollPortfolio(strategyId: number, wallet: string): Promise<Portfolio> {
  const strategy = await query<StrategyOnchainRow>(
    `select s.onchain_id, coalesce(max(v.version), 0) as active_version
       from strategies s
       left join strategy_versions v on v.strategy_id = s.id
      where s.id = $1
      group by s.id`,
    [strategyId],
  );
  const row = strategy.rows[0];
  if (row === undefined) throw new NotFoundError(`strategy ${strategyId} not found`);

  if (row.onchain_id === null) {
    throw new ValidationError('STRATEGY_NOT_ON_CHAIN', `strategy ${strategyId} is not yet mirrored to chain`);
  }
  const version = row.active_version ?? 0;
  if (version < 1) {
    throw new ValidationError('STRATEGY_NO_VERSION', `strategy ${strategyId} has no published version`);
  }

  const onchainId = Number(row.onchain_id);
  const account = wallet.toLowerCase();

  // On-chain first: fail here on a revert, before any DB row exists.
  await enrollOnchain(account as `0x${string}`, onchainId);

  const config = getConfig();
  const portfolio = await withTransaction(async (client) => {
    const inserted = await client.query<PortfolioRow>(
      `insert into portfolios (user_id, strategy_id, version, schedule_state)
       values ($1, $2, $3, 'active')
       returning id, user_id, strategy_id, version, schedule_state, created_at`,
      [account, strategyId, version],
    );
    const portfolioRow = inserted.rows[0];
    if (!portfolioRow) throw new Error('insert into portfolios returned no row');
    const portfolioId = Number(portfolioRow.id);

    await client.query(
      `insert into smart_accounts (portfolio_id, chain_id, address, owner, account_type)
       values ($1, $2, $3, $4, 'EOA')`,
      [portfolioId, config.chainId, account, account],
    );

    const accounts = await client.query<SmartAccountRow>(
      `select chain_id, address, owner, account_type
         from smart_accounts
        where portfolio_id = $1`,
      [portfolioId],
    );

    return { portfolioRow, accounts: accounts.rows };
  });

  return {
    id: Number(portfolio.portfolioRow.id),
    userId: portfolio.portfolioRow.user_id,
    strategyId: Number(portfolio.portfolioRow.strategy_id),
    version: portfolio.portfolioRow.version,
    scheduleState: portfolio.portfolioRow.schedule_state,
    createdAt: portfolio.portfolioRow.created_at.toISOString(),
    smartAccounts: portfolio.accounts.map((a) => ({
      chainId: Number(a.chain_id),
      address: a.address,
      owner: a.owner,
      accountType: a.account_type,
    })),
  };
}
