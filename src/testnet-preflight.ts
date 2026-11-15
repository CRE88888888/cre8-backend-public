import { getAddress, isAddress, isAddressEqual, keccak256, parseAbi, toFunctionSelector } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, PublicClient } from 'viem';
import { TESTNET_97 } from './testnet-profile.js';
import hashes from './testnet-codehashes.js';
import { loadFaucetConfig, loadPaymasterConfig, loadTradingConfig, loadWelcomeConfig, WELCOME_AMOUNT_WEI } from './config.js';
type Check = { name: string; level: 'ok' | 'warn' | 'fail'; detail: string };
type ReadinessOptions = { strict?: boolean; env?: NodeJS.ProcessEnv; timeoutMs?: number };

/** Every address from the contracts manifest, plus SDK-pinned Kernel/policies and the 97 Quoter. */
export function testnetProfileTargets(): { name: string; address: Address }[] {
  return [
    ...Object.entries(TESTNET_97.contracts).map(([name, address]) => ({ name, address })),
    ...Object.entries(TESTNET_97.assets).flatMap(([symbol, asset]) => Object.entries(asset)
      .flatMap(([field, value]) => typeof value === 'string' && isAddress(value)
        ? [{ name: `asset.${symbol}.${field}`, address: getAddress(value) }] : [])),
  ];
}

const selectors: Record<string, readonly string[]> = {
  registry: ['enroll(address,uint256)', 'operator()', 'owner()', 'numeraire()'],
  executor: ['executeRebalance(address,(address,address,uint256,uint256,address,bytes)[],uint256)', 'numeraire()', 'oracle()', 'venues(address)'],
  router: ['oracleOf(address)', 'previewSwap(address,address,uint256)'],
  usdt: ['claimFor(address,uint256)', 'claimable(address)', 'isFaucet(address)', 'welcomeFor(address)', 'decimals()'],
  paymaster: ['getDeposit()', 'verifyingSigner()'],
};

/** Hashes were captured from a clean worktree of contracts 71870a7, never the main clone's WIP.
 * Pin every read to one block. Missing code/hash/selector and RPC errors always fail closed.
 */
export async function checkTestnetProfile(client: PublicClient, expected: Readonly<Record<string, string>> = hashes, options: ReadinessOptions = {}): Promise<Check[]> {
  try {
    if (await client.getChainId() !== 97) return [{ name: 'chain 97 profile', level: 'fail', detail: 'RPC chain id is not 97' }];
    const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
    const targets = testnetProfileTargets();
    const checks: Check[] = [];
    for (let offset = 0; offset < targets.length; offset += 8) {
      checks.push(...await Promise.all(targets.slice(offset, offset + 8).map(async ({ name, address }): Promise<Check> => {
        try {
          const code = await client.getCode({ address, blockNumber });
          if (!code || code === '0x' || !/^0x[0-9a-f]{64}$/.test(expected[name] ?? '') || keccak256(code) !== expected[name]) {
            return { name: `97 ${name}`, level: 'fail', detail: 'missing code or runtime codehash differs from pinned clean deployment' };
          }
          if ((selectors[name] ?? []).some((signature) => !code.toLowerCase().includes(toFunctionSelector(signature).slice(2)))) {
            return { name: `97 ${name}`, level: 'fail', detail: 'required ABI selector absent' };
          }
          return { name: `97 ${name}`, level: 'ok', detail: `${address} codehash / selectors verified` };
        } catch { return { name: `97 ${name}`, level: 'fail', detail: 'RPC code read unavailable' }; }
      })));
    }
    if (options.strict) checks.push(...await checkReadiness(client, blockNumber, options));
    return checks;
  } catch { return [{ name: 'chain 97 profile', level: 'fail', detail: 'RPC chain or block unavailable' }]; }
}

/** Strict deployment covers the enabled chain 97 product, beyond immutable runtime bytecode. */
async function checkReadiness(client: PublicClient, blockNumber: bigint, options: ReadinessOptions): Promise<Check[]> {
  const env = options.env ?? process.env;
  const checks: Check[] = [];
  const result = (name: string, healthy: boolean, detail: string) => checks.push({ name: '97 ' + name, level: healthy ? 'ok' : 'fail', detail });
  try {
    const c = loadPaymasterConfig(env);
    const faucet = loadFaucetConfig(env), welcome = loadWelcomeConfig(env), trading = loadTradingConfig(env, 97);
    if (!c || c.chainId !== 97) throw new Error('missing signer');
    result('feature budgets', c.accountDailyCount > 0n && c.accountDailyGas > 0n && (c.accountDailyWei === null || c.accountDailyWei > 0n) &&
      c.siteDailyGas > 0n && c.siteDailyWei > 0n && c.minDepositWei > 0n && trading.dailyGas > 0n && (trading.dailyUsdE8 === null || trading.dailyUsdE8 > 0n) &&
      faucet !== null && faucet.amountWei > 0n && faucet.siteDailyWei >= faucet.amountWei && welcome !== null && welcome.siteDailyWei >= WELCOME_AMOUNT_WEI,
    'paymaster / ordinary gas / faucet / welcome budgets must permit at least one operation');
    const abi = parseAbi(['function verifyingSigner() view returns(address)', 'function entryPoint() view returns(address)', 'function getDeposit() view returns(uint256)']);
    const [signer, entryPoint, deposit] = await bounded(Promise.all([
      client.readContract({ address: c.address, abi, functionName: 'verifyingSigner', blockNumber }),
      client.readContract({ address: c.address, abi, functionName: 'entryPoint', blockNumber }),
      client.readContract({ address: c.address, abi, functionName: 'getDeposit', blockNumber }),
    ]), options.timeoutMs ?? c.timeoutMs);
    result('paymaster signer / EntryPoint', isAddressEqual(signer, privateKeyToAccount(c.signerPrivateKey).address) &&
      isAddressEqual(entryPoint, TESTNET_97.contracts.entryPoint), 'on-chain signer and EntryPoint must match sponsorship configuration');
    result('paymaster deposit', deposit > 0n && deposit >= c.minDepositWei, `EntryPoint deposit must reach the configured low-water threshold (${c.minDepositWei} wei)`);
  } catch {
    result('paymaster readiness', false, 'signer / budget configuration or on-chain paymaster reads unavailable; verify settings and RPC');
  }
  try {
    const configuredOperator = env.OPERATOR_ADDRESS?.trim();
    const rawKey = env.OPERATOR_PRIVATE_KEY?.trim();
    const signingOperator = rawKey ? privateKeyToAccount(`0x${rawKey.replace(/^0x/, '')}`).address : undefined;
    if ((configuredOperator && (!isAddress(configuredOperator, { strict: false }) || !isAddressEqual(configuredOperator, TESTNET_97.roles.operator))) ||
        (signingOperator && !isAddressEqual(signingOperator, TESTNET_97.roles.operator))) throw new Error('operator mismatch');
    const faucet = await bounded(client.readContract({ address: TESTNET_97.contracts.usdt,
      abi: parseAbi(['function isFaucet(address) view returns(bool)']), functionName: 'isFaucet', args: [TESTNET_97.roles.operator], blockNumber }), options.timeoutMs ?? 5000);
    result('operator faucet', faucet, 'profile operator must be authorized for claimFor / welcomeFor');
    const numeraire = await bounded(client.readContract({ address: TESTNET_97.contracts.registry,
      abi: parseAbi(['function numeraire() view returns(address)']), functionName: 'numeraire', blockNumber }), options.timeoutMs ?? 5000);
    result('registry numeraire', isAddressEqual(numeraire, TESTNET_97.contracts.usdt), 'registry cash asset must match the chain 97 USDT profile');
  } catch { result('operator / registry readiness', false, 'operator faucet or registry numeraire unavailable; verify profile and RPC'); }
  return checks;
}

async function bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('invalid readiness timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('readiness timeout')), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
