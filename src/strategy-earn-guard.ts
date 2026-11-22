import { parseAbi } from 'viem';
import { AppError } from './errors.js';

/**
 * Chain 97 strategy earn deployment (cre8-contracts#65, deployments/testnet-97.json `borrow`). Kept dependency-free so
 * the yield profile, yield execution and paymaster can all refuse the strategy vault without import cycles.
 *
 * Why the guard exists (cre8-contracts docs/borrow-97 §7): the strategy vault is registered in AtpYieldRegistry, and
 * the deployed AtpExecutor.executeWithdraw has no "Cash Earn only" check. If an account ever approved strategy vault
 * shares to AtpExecutor, a session key could redeem them into account cash, mixing strategy money with cash and
 * removing the loan's repayment source. The backend therefore never approves those shares to AtpExecutor and never
 * builds an AtpExecutor yield call for the strategy vault market.
 */
export const STRATEGY_EARN_97 = {
  executor: '0x16ab59a8bacb578c6437528ac0961e234e4b717b',
  registry: '0x973341a0ba6a725630f2a4f66d7dbba92fea4e00',
  lendingOracle: '0xc5e37dac4b0c662fd9b848e9882a453a00fd2e50',
  venusComptroller: '0x93ab77260c8c62b26698bbb0ee8da3e175b9ad8d',
  vUSDT: '0xc0a352e6aa517910b4f2cfc277b6161042cea366',
  listaMoolah: '0x993237ac050512f3749bfee2de759b6b86aea653',
  earnVault: '0x2e915b874a5a544736f5afd97f3fa1dd45d417a9',
  earnVaultMarketId: '0xb2a013f0c2e1f9e7e5ccab3c3ceda82661e64f3efb736fa9ce9bdca51d98959c',
  markets: [
    { symbol: 'NVDAB', marketId: '0xfa06dd03eff35e3337a8b5b93a8a7943155b4f20e4d19bb0583db20bdd9f5415', protocol: 'venus', collateralVToken: '0x212eb4b5eecb8a089a5079623b7f68a932315476' },
    { symbol: 'TSLAB', marketId: '0x00f2152bbbefde7b3e65c4b7de0af83a87875c02b6c84ef96410ac14edd850fe', protocol: 'venus', collateralVToken: '0xbd0a5eae45c3cb3b477abab2c2cdb266180eff9c' },
    { symbol: 'SPCXB', marketId: '0x4632539a0ba6e5e9843b401d97b66b8b34d23fdab2005feacefd5452055c410e', protocol: 'venus', collateralVToken: '0x45e9cf220a38630a551afe2a10d1f2126a749a5d' },
    { symbol: 'QQQB', marketId: '0xd8def95e75d2489c340ac4d9769646707cf55d17d7aa7f8644c89b64b41844e7', protocol: 'lista', collateralVToken: null },
    { symbol: 'MSTRB', marketId: '0x208d888e7c3d5ef4d9ccc51083daffe7ddfbce978d339ce258544022cfd9804a', protocol: 'lista', collateralVToken: null },
  ],
} as const;
/** Throws if a yield market/target/token is the strategy vault; old AtpExecutor must never touch it. */
export function assertNotStrategyVault(input: { marketId?: string | null; address?: string | null }): void {
  if ((input.marketId && input.marketId.toLowerCase() === STRATEGY_EARN_97.earnVaultMarketId) ||
      (input.address && input.address.toLowerCase() === STRATEGY_EARN_97.earnVault)) {
    throw new AppError(403, 'STRATEGY_VAULT_FORBIDDEN', 'strategy earn vault positions are only moved by AtpBorrowExecutor');
  }
}
export const isStrategyVault = (input: { marketId?: string | null; address?: string | null }) => {
  try { assertNotStrategyVault(input); return false; } catch { return true; }
};


/** Owner/keeper calls into the strategy earn contracts (subset of STRATEGY_EARN_ABI; shared with the paymaster). */
export const BORROW_CALL_ABI = parseAbi([
  'function setBorrowPolicy(bytes32 id, uint256 maxDebt, bool enabled)',
  'function executeSupplyCollateral(address account, bytes32 marketId, uint256 amount, uint256 deadline)',
  'function executeBorrow(address account, bytes32 marketId, uint256 amount, uint256 deadline)',
  'function executeRepay(address account, bytes32 marketId, uint256 amount, bool fromVault, uint256 deadline)',
  'function executeDeleverage(address account, bytes32 marketId)',
  'function executeWithdrawCollateral(address account, bytes32 marketId, uint256 amount, uint256 deadline)',
  'function updateDelegate(address delegate, bool allowBorrows)',
  'function setAuthorization(address authorized, bool newIsAuthorized)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
export const isStrategyMarketId = (id: string) => STRATEGY_EARN_97.markets.some(m => m.marketId === id.toLowerCase());
