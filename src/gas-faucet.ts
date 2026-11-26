import { createPublicClient, createWalletClient, http, isAddress, keccak256 } from 'viem';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';
import { getConfig, loadGasFaucetConfig } from './config.js';
import type { Config, GasFaucetConfig } from './config.js';
import { AppError } from './errors.js';
import { RequestRateLimiter } from './ratelimit.js';
import { withRelayerLock, relayerNonce } from './relayer-lock.js';
import { rpcTransport } from './rpc-transport.js';

type PreparedTransfer = { hash: Hex; broadcast: () => Promise<void>;
  receipt: () => Promise<{ status: string; transactionHash: string }> };
export type GasFaucetChain = { chainId: () => Promise<number>; balance: (owner: Address) => Promise<bigint>;
  prepare: (owner: Address, amountWei: bigint) => Promise<PreparedTransfer> };
export type GasFaucetDeps = { config?: GasFaucetConfig | null; chain?: (config: GasFaucetConfig) => GasFaucetChain;
  lock?: typeof withRelayerLock; limiter?: Pick<RequestRateLimiter, 'gasFaucet'>; now?: () => number };
export type GasFaucetResult = { txHash: Hex | null; amountWei: string };
const quota = () => new AppError(429, 'GAS_FAUCET_QUOTA', 'gas faucet daily quota reached; retry next UTC day');
const unavailable = () => new AppError(503, 'GAS_FAUCET_UNAVAILABLE', 'gas faucet unavailable; retry later');

/** Reuse the configured relayer key; never introduce a faucet signing key. Preparation cannot broadcast. */
export function createGasFaucetChain(c: GasFaucetConfig,
  config: Pick<Config, 'chainId' | 'rpcUrl' | 'operatorPrivateKey'> = getConfig()): GasFaucetChain {
  if (config.chainId !== 97 || !config.rpcUrl || !config.operatorPrivateKey || !/^0x[0-9a-fA-F]{64}$/.test(config.operatorPrivateKey)) throw unavailable();
  const operator = privateKeyToAccount(config.operatorPrivateKey as Hex);
  const transport = rpcTransport('gas-faucet', config.rpcUrl, { retryCount: 0, timeout: c.timeoutMs });
  const client = createPublicClient({ chain: bscTestnet, transport });
  const wallet = createWalletClient({ account: operator, chain: bscTestnet, transport });
  return { chainId: () => client.getChainId(), balance: owner => client.getBalance({ address: owner }),
    prepare: async (owner, amountWei) => {
      const request = await wallet.prepareTransactionRequest({ to: owner, value: amountWei, data: '0x', ...(await relayerNonce(client, operator.address)) });
      const raw = await wallet.signTransaction(request);
      const hash = keccak256(raw);
      return { hash,
        broadcast: async () => { if (await client.sendRawTransaction({ serializedTransaction: raw }) !== hash) throw unavailable(); },
        receipt: () => client.waitForTransactionReceipt({ hash, timeout: c.timeoutMs, confirmations: 1, pollingInterval: 1_000 }),
      };
    },
  };
}

async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(unavailable()), ms); })]); }
  finally { clearTimeout(timer); }
}

export function createGasFaucetService(deps: GasFaucetDeps = {}) {
  const now = deps.now ?? Date.now;
  const limiter = deps.limiter ?? new RequestRateLimiter(undefined, undefined, now);
  // C3 #149 accepts per-process UTC-day quotas for this small testnet subsidy:
  // restart resets both budgets; replicas each have their own cap. No DB/outbox.
  // Count broadcast attempts, including ambiguous failures, without refunding.
  let site = { day: -1, used: 0n };
  return { async claim(input: unknown, wallet: string): Promise<GasFaucetResult> {
    const c = deps.config === undefined ? loadGasFaucetConfig() : deps.config;
    if (c === null) throw new AppError(503, 'GAS_FAUCET_DISABLED', 'gas faucet requires chain 97 and GAS_FAUCET_ENABLED=1');
    if (typeof input !== 'object' || input === null || Array.isArray(input) || Object.keys(input).length !== 0 ||
        !isAddress(wallet, { strict: false }) || /^0x0{40}$/i.test(wallet)) {
      throw new AppError(400, 'GAS_FAUCET_INVALID_REQUEST', 'expected {} and an authenticated owner wallet');
    }
    const owner = wallet.toLowerCase() as Address;
    try {
      return await (deps.lock ?? withRelayerLock)(c.chainId, async assertHeld => {
        assertHeld();
        const chain = (deps.chain ?? createGasFaucetChain)(c);
        if (await bounded(chain.chainId(), c.timeoutMs) !== 97) throw unavailable();
        const readBalance = async () => {
          const value = await bounded(chain.balance(owner), c.timeoutMs);
          if (typeof value !== 'bigint' || value < 0n || value >= 1n << 256n) throw unavailable();
          return value;
        };
        const balance = await readBalance();
        if (balance >= c.thresholdWei) return { txHash: null, amountWei: '0' };
        const amountWei = c.targetWei - balance;
        const prepared = await bounded(chain.prepare(owner, amountWei), c.timeoutMs);
        const clock = now();
        if (!Number.isSafeInteger(clock) || clock < 0) throw unavailable();
        const day = Math.floor(clock / 86_400_000);
        if (site.day !== day) site = { day, used: 0n };
        const budget = site;
        if (budget.used + amountWei > c.siteDailyWei) throw quota();
        await limiter.gasFaucet(owner);
        assertHeld();
        // Recheck after the asynchronous owner budget so concurrent requests cannot overspend.
        if (budget.used + amountWei > c.siteDailyWei) throw quota();
        budget.used += amountWei;
        await bounded(prepared.broadcast(), c.timeoutMs);
        const receipt = await bounded(prepared.receipt(), c.timeoutMs);
        if (receipt.status !== 'success' || receipt.transactionHash.toLowerCase() !== prepared.hash.toLowerCase()) throw unavailable();
        // The owner may already spend the subsidy while waiting; do not require exact target equality.
        await readBalance();
        return { txHash: prepared.hash, amountWei: amountWei.toString() };
      });
    } catch (error) {
      if (error instanceof AppError && error.code === 'GAS_FAUCET_QUOTA') throw error;
      throw unavailable(); // Never expose RPC URLs, DB credentials or signing material.
    }
  } };
}

const service = createGasFaucetService();
export async function claimFaucetGas(input: unknown, wallet: string): Promise<GasFaucetResult> { return service.claim(input, wallet); }
