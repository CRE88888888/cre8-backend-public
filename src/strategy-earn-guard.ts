import { parseAbi, toFunctionSelector } from 'viem';
import type { Hex } from 'viem';
import { AppError } from './errors.js';

/**
 * Chain 97 strategy earn deployment (cre8-contracts#65 and #67, deployments/testnet-97.json `borrow`). Kept dependency-free so
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
    { symbol: 'NVDAB', marketId: '0xfa06dd03eff35e3337a8b5b93a8a7943155b4f20e4d19bb0583db20bdd9f5415', protocol: 'venus', collateralVToken: '0x212eb4b5eecb8a089a5079623b7f68a932315476', listaId: null },
    { symbol: 'TSLAB', marketId: '0x00f2152bbbefde7b3e65c4b7de0af83a87875c02b6c84ef96410ac14edd850fe', protocol: 'venus', collateralVToken: '0xbd0a5eae45c3cb3b477abab2c2cdb266180eff9c', listaId: null },
    { symbol: 'SPCXB', marketId: '0x4632539a0ba6e5e9843b401d97b66b8b34d23fdab2005feacefd5452055c410e', protocol: 'venus', collateralVToken: '0x45e9cf220a38630a551afe2a10d1f2126a749a5d', listaId: null },
    { symbol: 'QQQB', marketId: '0xd8def95e75d2489c340ac4d9769646707cf55d17d7aa7f8644c89b64b41844e7', protocol: 'lista', collateralVToken: null, listaId: '0x1ad1b2495b972b0f26018a815b001aff4dd21c4c5104b52ad9d0128d5913ea0f' },
    { symbol: 'MSTRB', marketId: '0x208d888e7c3d5ef4d9ccc51083daffe7ddfbce978d339ce258544022cfd9804a', protocol: 'lista', collateralVToken: null, listaId: '0x63c1f20824f66781a9c171d1056bae697cc47b26337c6aab8b49380463d6f966' },
    // cre8-contracts#67: the other non-leveraged holdings of the 21 launch funds, all Lista (registry holds at most 32).
    { symbol: 'BTCB', marketId: '0x8d48b0483eb33d02f26569ab02c254eac8ac10be954fdbb157243bd09e85d2fb', protocol: 'lista', collateralVToken: null, listaId: '0xd3ed38ad197ab80fc1b1ee0a5fd9f1cdac3d0afeff73cc320f26cc845b223c87' },
    { symbol: 'WBNB', marketId: '0x88ca3237e09f509dd0919d6fb3c3acc3e481a174ab584dc1166db05e13addd1b', protocol: 'lista', collateralVToken: null, listaId: '0x3e388ba36391d6d529740fa253e872cf65aa99253dd8e62aa8b9a52fa7abf7f3' },
    { symbol: 'SPYB', marketId: '0x51b9790c89e3f45fd09429a276cc3993d150efbd931929a2efb5246ff5b2dbea', protocol: 'lista', collateralVToken: null, listaId: '0x320dacf24bd3275e0b53bc2aa2a675845615af8c84c055de43c2f84b7c466752' },
    { symbol: 'EWYB', marketId: '0xf18d92ea0ab3910af1b41c7fa590e1782c3c360272885c8654c5553ae1b5aec0', protocol: 'lista', collateralVToken: null, listaId: '0x6788c22e967ac7414485ee5af2f1a2b3e0ab61fd71eebae6474dd87d22cabe16' },
    { symbol: 'XAUt', marketId: '0xdc90c169476591d0bdaf94c8604483851a71f6f968cc6e715caaa44bc5343ddf', protocol: 'lista', collateralVToken: null, listaId: '0xfe3887ad126f50f3edfc84600cd95443676c749503dfda8ccee7cd28ba175ad4' },
    { symbol: 'AAPLB', marketId: '0x5d49d81cb9a6ad5100cc45fea95acba206f8c2d430de244b56bd1b37c26052dc', protocol: 'lista', collateralVToken: null, listaId: '0x6b52b9b7c618abbdda6bf1d89164b6e516ac7af8d0de60d7aa5685078e90692d' },
    { symbol: 'MSFTB', marketId: '0x0011e09537679494eab5cf79e82e709c512444aace283a42af962de31caa9d6d', protocol: 'lista', collateralVToken: null, listaId: '0x466fe2ba0139a7636cbe28eeb726004263615b4da0db6ceabe4990a47c494858' },
    { symbol: 'GOOGLB', marketId: '0x689d5419e2cfe939bd0eeca62624dba7d1169bf119071f6b5692af3373ecee86', protocol: 'lista', collateralVToken: null, listaId: '0x8916367036401d1883e27c9e4dd808a26c527a666c3c0771f035ab669082765e' },
    { symbol: 'AMZNB', marketId: '0xcb0b5108bfac66dc1b0ceb41dff04d840999a64a65557be8cffdf220c5a7c638', protocol: 'lista', collateralVToken: null, listaId: '0x43fa17c359dd3d3efb2fff91d80727a7275e61faba55c81cf2c39b5abab81182' },
    { symbol: 'METAB', marketId: '0x46b15315b0d7a132ab8c1d3951dc129924f35a65cc6d362fd916ea043efc967e', protocol: 'lista', collateralVToken: null, listaId: '0x75998b235d0006ac4c5345d43efe8a9e9bd2b02b9fe53cd9e2629f1dc9000040' },
    { symbol: 'TSMB', marketId: '0x4089dd869febe66e083235a22ddc27aa974608c37706e09b7c9f58d886309207', protocol: 'lista', collateralVToken: null, listaId: '0x480777b3dcf9bca71001e3d31d7078d60373d0d57cc6d65fa745838416a793c7' },
    { symbol: 'AVGOB', marketId: '0x22e0e2119c0a4fbc0c511fb32e9119935da28f53891d72a7b2e42ed0a19c8acb', protocol: 'lista', collateralVToken: null, listaId: '0xbe635fb820f889164d633b455a6955e9a8da656a1eac38673e75ef81f7329d8c' },
    { symbol: 'NFLXB', marketId: '0x45a53fd0ab814504600a9d3e853a5c00fb37ca236e0dcaeb228999a0647763a9', protocol: 'lista', collateralVToken: null, listaId: '0x9e66a47cde279e703cc7938dd51d6fa5f18cc3f331f8f14ccb066c6ae2f49e29' },
    { symbol: 'INTCB', marketId: '0x7ef21622fbb4199611e5c89b5c9c7f1aba3e007f69cee91dd93d877d04a16a6e', protocol: 'lista', collateralVToken: null, listaId: '0xa7cf4e5a8c410af451bf9032191025434535a8d8048a41ec3f5115d5a60e839a' },
    { symbol: 'SKHYB', marketId: '0xdfd536b4566dabdece5a60e14d8767f609ed2c12b718495336de4502e30ddf21', protocol: 'lista', collateralVToken: null, listaId: '0x48bbc0a770eb55a4752ccb1fcf4a952ef451c87be7e1b766f0705bb561d60396' },
    { symbol: 'MUB', marketId: '0x8e55d0583de7b419e1d6bd4f862a23e415f13390f8f422cef7d5869380882cb9', protocol: 'lista', collateralVToken: null, listaId: '0xc14ede603181674358411b52c4e3dbed7b7b22c2249373a62fdf224ea749acab' },
    { symbol: 'SNDKB', marketId: '0x26a12b6c8cb5088c7b1a7565a305d615b4a10a6f7b14dc7292f9b66d1f4573a5', protocol: 'lista', collateralVToken: null, listaId: '0xdcfdf2af95e7e17be4726c6b306362099166bf81dc088bcaa9ca261dd2e7512c' },
    { symbol: 'ANTB', marketId: '0x17cf8ebc51ff714d19d45dc586262ae95acfa859bfbe66936917421aef9f1ccc', protocol: 'lista', collateralVToken: null, listaId: '0x3d9f73ea1aff570c2fb650840d0d2ac242e286318de93a7a4fc5ac0cd7c2b431' },
    { symbol: 'BABAB', marketId: '0x0d94a872df3df2ed65010cdef0fff4b52be888a41879252f5422b51dcf849600', protocol: 'lista', collateralVToken: null, listaId: '0x12f6a5af2981c4a505de59c7377e99e88357ad155386c926df694911bcb497e6' },
    { symbol: 'PDDB', marketId: '0xe387a4f77009e8b616e63fa02da3b600104bd4bb57f8cabad624622dea78a287', protocol: 'lista', collateralVToken: null, listaId: '0x1a039af7bb72c460304f19c543f8520a4be8212717f0f7e3ce8d9ec0d469157b' },
    { symbol: 'CRCLB', marketId: '0x41fe2e63f5c26f448cd67dd3b651304c6fbc36345b4ead814d76ce76f51d3fe7', protocol: 'lista', collateralVToken: null, listaId: '0x389fc52265108d0de475c5d997d835eab9eecbab704c3ff962c37c866d5d7d59' },
    { symbol: 'HOODB', marketId: '0xc917a20897841a10d848200e0aab4696ba797b43b8d32ca25635ff373bdbb870', protocol: 'lista', collateralVToken: null, listaId: '0x1065813a7aa67322c13ace6b54e66b5f81e744fc42629e5a7b6af6b9175ab1f6' },
    { symbol: 'GMEB', marketId: '0xb4d9a1acb4b5cfe346b540b2aaa901c25ded7bd33d376a1721c259e13f217728', protocol: 'lista', collateralVToken: null, listaId: '0x58dd0e7ad68f4b23f81a54beb1b6df14aa7828f9525ac95ba99d46d6f40a78e7' },
    { symbol: 'COINB', marketId: '0x656cf332a101a485a7e87d5877f92c555edc4929568aad341900b2ae633ca6c9', protocol: 'lista', collateralVToken: null, listaId: '0x8ee0ef5cc40d25bb227ee82b1d1d17ccdfcf4c51cbc8ddc5b143a7c6907bc359' },
    { symbol: 'BMNRB', marketId: '0x2dd522761a2d39270426cd13075002b480bfcb137442a9b261762620e6b6148b', protocol: 'lista', collateralVToken: null, listaId: '0x3614b0ed7b8605d4b6d1bfad25b58fe5d2dc53985317e73e9484b97fdf049371' },
    { symbol: 'BNCB', marketId: '0xf0a9425ffd3c0b4f472854252db963cd714ae711c2ceeb84647f1bbd444e5283', protocol: 'lista', collateralVToken: null, listaId: '0xa3d1fc392b31e5d9942997306374ba6c767a123b3be45f7e11ec56db106a292b' },
  ],
} as const;
/**
 * The five #65 markets, in order: session keys renewed before cre8-contracts#67 carry exactly this ONE_OF list. They stay
 * usable for these markets (the policy is rebuilt as installed); a buy that wants the newer markets asks for a renewal.
 */
export const STRATEGY_EARN_LEGACY_MARKET_IDS = STRATEGY_EARN_97.markets.slice(0, 5).map(m => m.marketId);
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
/** The four AtpBorrowExecutor calls a session key may make (backend#204). Deleverage is anyone-callable and needs no key. */
export const BORROW_SESSION_SELECTORS: readonly Hex[] = [
  'function executeSupplyCollateral(address account, bytes32 marketId, uint256 amount, uint256 deadline)',
  'function executeBorrow(address account, bytes32 marketId, uint256 amount, uint256 deadline)',
  'function executeRepay(address account, bytes32 marketId, uint256 amount, bool fromVault, uint256 deadline)',
  'function executeWithdrawCollateral(address account, bytes32 marketId, uint256 amount, uint256 deadline)',
].map(signature => toFunctionSelector(signature));
