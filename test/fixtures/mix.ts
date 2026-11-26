import { computeDrift } from '../../src/drift.js';
import type { PortfolioPlan } from '../../src/snapshot.js';
import type { MixRuntime } from '../../src/mix-runtime.js';
import { TESTNET_97 as T } from '../../src/testnet-profile.js';
export const WAD = 10n ** 18n;
export const mixClock = new Date('2026-11-21T12:00:00Z');
export function mixRuntimeFixture(): { state: MixRuntime; plan: PortfolioPlan } {
  const targets = [{ asset: T.assets.NVDAB.token, weightBps: 5000, symbol: 'NVDA' },
    { asset: T.assets.WBNB.token, weightBps: 5000, symbol: 'WBNB' }, { asset: T.contracts.usdt, weightBps: 0, symbol: 'USDT' }];
  const holdings = targets.map(t => ({ asset: t.asset, amountWei: t.weightBps > 0 ? 65n * WAD : 0n,
    decimals: 18, usdPriceE8: 100000000n, priceSource: 'numeraire' as const }));
  const plan: PortfolioPlan = { portfolioId: 1, strategyId: 1, account: T.roles.keeper, chainId: 97,
    snapshot: { portfolioId: 1, block: 20n, nativeBalanceWei: 0n, holdings, unpriced: [] },
    targets, report: computeDrift(holdings, targets, 100), thresholdBps: 100, blocked: [],
    pinnedVersion: { version: 1, onchainStrategyId: 1, paused: false }, allocationCheck: { consistent: true, chain: [], mismatches: [] },
    scan: { portfolioId: 1, block: 20n, cursor: { portfolioId: 1, startBlock: 1n, lastScannedBlock: 20n }, scannedRange: null,
      candidateCount: 0, unknownHoldings: [], zeroBalanceCount: 0, unreadableCandidates: [],
      deployment: { block: 1n, reason: 'resolved', detail: 'fixture' }, universeComplete: true, incompleteReasons: [] } };
  const state: MixRuntime = { userAllocation: Object.fromEntries(targets.filter(t => t.weightBps > 0).map(t => [t.asset, t.weightBps])), id: '1', owner: T.roles.keeper, status: 'active', triggered: false, frequency: 'monthly',
    startDate: '2026-11-01', last: new Date('2026-11-01Z'), takeProfit: 3000, stopLoss: 2000, deposits: 100n * WAD,
    withdrawals: 0n, pending: false, exits: new Set(), newMoney: false, retries: 0, lastExitAttempt: null };
  return { state, plan };
}
