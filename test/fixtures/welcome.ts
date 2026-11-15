import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { parseTransaction } from 'viem';
import type { Address, Hex } from 'viem';
import { query, migrate } from '../../src/db.js';
import { createPortfolioStrategyService } from '../../src/portfolio-strategies.js';
import type { PortfolioStrategyDeps } from '../../src/portfolio-strategies.js';
import { requireOwnedPortfolio } from '../../src/portfolios.js';
import { requireTypedVersion, validateAllocation } from '../../src/strategies.js';
import { canonicalConfigHash } from '../../src/strategy-execution.js';
import type { AssetExecution, AssetSetting } from '../../src/strategy-execution.js';
import { assertVersionOnchain, readAccountCash } from '../../src/chain.js';
import { createWelcomeService, readWelcomeFundingEvidence, settleWelcomeGrant } from '../../src/welcome-grants.js';
import { readFaucetFundingEvidence } from '../../src/faucet.js';
import { TESTNET_97 } from '../../src/testnet-profile.js';
import { WELCOME_AMOUNT_WEI } from '../../src/config.js';
import { signedFundingTx } from './relayer.js';
import { strategyRpc } from './strategy-rpc.js';

export const address = (): Address => `0x${randomBytes(20).toString('hex')}`;
export const hash = (): Hex => `0x${randomBytes(32).toString('hex')}`;
export const welcomeConfig = { chainId: 97 as const, siteDailyWei: (1n << 256n) - 1n, timeoutMs: 5000 };

/** Real DB/ownership/version/receipt readers; only the RPC transport and signing are controlled. */
export async function welcomeFixture(owner = address(), kind: 'hold' | 'stack' = 'hold') {
  await migrate();
  const account = address();
  const s = (await query<{ id: string }>("insert into strategies(provider,name) values($1,'welcome-91') returning id", [owner])).rows[0];
  assert.ok(s);
  const strategyId = Number(s.id), onchainId = strategyId + 91_000_000;
  await query('update strategies set onchain_id=$2 where id=$1', [strategyId, onchainId]);
  const allocation = validateAllocation({ assets: [{ address: TESTNET_97.assets.AAPLB.token, weightBps: 5000 }, { address: TESTNET_97.contracts.usdt, weightBps: 5000 }] }, 97);
  const execution: AssetExecution = { kind: 'per_asset', numeraire: TESTNET_97.contracts.usdt, rebalance: 'none', assets: allocation.assets.map<AssetSetting>(a =>
    a.address === TESTNET_97.contracts.usdt ? { asset: a.address, weightBps: a.weightBps, yield: null } : {
      asset: a.address, weightBps: a.weightBps, yield: null, execution: kind === 'hold' ? { kind: 'hold' } : { kind: 'stack', every: 'daily', weekday: null, timeUtc: '14:00', slices: 12 },
    }).sort((a, b) => a.asset.localeCompare(b.asset)) };
  const activeAt = new Date('2026-11-15T00:00:00Z');
  const configHash = canonicalConfigHash({ chainId: 97, execution, allocation, schedule: { kind: 'funding' }, activeAt });
  await query(`insert into strategy_versions(strategy_id,version,allocation,schedule,active_at,execution_schema_version,execution,execution_chain_id,config_hash)
    values($1,1,$2,'{"kind":"funding"}',$3,2,$4,97,$5)`, [strategyId, JSON.stringify(allocation), activeAt, JSON.stringify(execution), configHash]);
  const p = (await query<{ id: string }>("insert into portfolios(user_id,strategy_id,version,schedule_state) values($1,$2,1,'paused') returning id", [owner, strategyId])).rows[0];
  assert.ok(p); const id = Number(p.id);
  await query("insert into smart_accounts(portfolio_id,chain_id,address,owner,account_type) values($1,97,$2,$3,'KERNEL')", [id, account, owner]);
  const rpc = strategyRpc(allocation, configHash, activeAt, hash());
  rpc.state.to = account; rpc.state.mint = true; rpc.state.amount = WELCOME_AMOUNT_WEI; rpc.state.cashRaw = 0n; rpc.state.strategyId = BigInt(onchainId);
  let sends = 0;
  const signed = await signedFundingTx('welcome', account, WELCOME_AMOUNT_WEI); rpc.state.txHash = signed.hash; rpc.state.txFrom = signed.operator; rpc.state.txNonce = parseTransaction(signed.raw).nonce ?? 0;
  const settle: typeof settleWelcomeGrant = (g, state, hash, evidence, transaction, submission) =>
    settleWelcomeGrant(g, state, hash, evidence, transaction, submission ? { ...submission, operator: signed.operator } : undefined);
  const welcome = createWelcomeService({ config: welcomeConfig, settle, prepare: async () => ({ ...signed,
    broadcast: async () => { sends++; rpc.state.cashRaw += WELCOME_AMOUNT_WEI; }, wait: async () => {} }) });
  const deps: Partial<PortfolioStrategyDeps> = { chainId: () => 97, welcome, feeReserve: async () => 27n * 10n ** 16n,
    owned: (id, wallet) => requireOwnedPortfolio(id, wallet, { chainId: 97 }),
    version: (sid, v, chainSid, acct, options) => requireTypedVersion(sid, v, chainSid, acct, { ...options, chainId: 97,
      assertOnchain: (sid, v, expected, account, opts) => assertVersionOnchain(sid, v, expected, account, { ...opts, client: rpc.client, registry: TESTNET_97.contracts.registry }) }),
    welcomeEvidence: g => readWelcomeFundingEvidence(g, rpc.client, signed.operator), evidence: g => readFaucetFundingEvidence(g, rpc.client),
    cash: (chain, account) => readAccountCash(chain, account, rpc.client) };
  return { id, owner, account, strategyId, rpc, deps, service: createPortfolioStrategyService(deps), sends: () => sends,
    signed, settle, recipient: { chainId: 97 as const, owner, account, portfolioId: id } };
}
