import { isAddressEqual, WaitForTransactionReceiptTimeoutError } from 'viem';
import type { Address, Hex } from 'viem';
import type { ChainConfig } from './chain.js';
import { activeChain } from './chain-object.js';
import { AppError } from './errors.js';
import { withRelayerLock } from './relayer-lock.js';
import { consumeAccountDeploymentBudget } from './ratelimit.js';
import { loadAccountDeploymentConfig } from './config.js';

// Request coalescing only; this is not a durable broadcast record.
const inProgress = new Set<string>();

export type DeploymentIntent = { address: Address; owner: Address; strategyId: bigint; factory: Address; factoryData: Hex };

/** Direct operator deployment retains the existing CREATE2/getCode semantics. The relayer
 * lock serializes this process with faucet/welcome sends. There is no durable deployment
 * outbox: after an ambiguous broadcast or restart, getCode is the only retry guard.
 */
export async function deployAccount97(intent: DeploymentIntent, chain: ChainConfig,
  deps: { lock?: typeof withRelayerLock; budget?: typeof consumeAccountDeploymentBudget } = {}): Promise<{ address: Address; deployed: boolean }> {
  const { publicClient: client, wallet, account: operator } = chain;
  const key = intent.address.toLowerCase();
  if (inProgress.has(key)) throw new AppError(202, 'ACCOUNT_DEPLOYMENT_PENDING', 'account deployment is in progress; retry later');
  inProgress.add(key);
  try {
    return await (deps.lock ?? withRelayerLock)(97, async assertHeld => {
      if (await client.getChainId() !== 97) throw new AppError(503, 'ACCOUNT_DEPLOYMENT_UNAVAILABLE', 'account deployment requires chain 97');
      const code = await client.getCode({ address: intent.address });
      if (code && code !== '0x') return { address: intent.address, deployed: false };
      if (await client.getBalance({ address: operator.address, blockTag: 'pending' }) < loadAccountDeploymentConfig().minBalanceWei) {
        throw new AppError(503, 'ACCOUNT_DEPLOYMENT_LOW_BALANCE', 'operator balance is below the account deployment threshold');
      }
      const request = await wallet.prepareTransactionRequest({ account: operator, chain: client.chain ?? activeChain(), to: intent.factory, data: intent.factoryData });
      const serializedTransaction = await wallet.signTransaction(request);
      assertHeld();
      await (deps.budget ?? consumeAccountDeploymentBudget)(intent.owner);
      assertHeld();
      const hash = await wallet.sendRawTransaction({ serializedTransaction });
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
      if (receipt.transactionHash !== hash || !isAddressEqual(receipt.from, operator.address) || !receipt.to ||
          !isAddressEqual(receipt.to, intent.factory)) throw new AppError(503, 'ACCOUNT_DEPLOYMENT_RECEIPT_MISMATCH', 'account deployment receipt does not match the submitted transaction');
      if ((await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) {
        throw new AppError(202, 'ACCOUNT_DEPLOYMENT_PENDING', 'account deployment block changed; retry later');
      }
      if (receipt.status !== 'success') throw new AppError(502, 'ACCOUNT_DEPLOYMENT_REVERTED', 'account deployment transaction reverted');
      const deployedCode = await client.getCode({ address: intent.address, blockNumber: receipt.blockNumber });
      if (!deployedCode || deployedCode === '0x') throw new AppError(503, 'ACCOUNT_DEPLOYMENT_CODE_MISSING', 'deployment receipt has no account code');
      assertHeld();
      return { address: intent.address, deployed: true };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof WaitForTransactionReceiptTimeoutError) throw new AppError(202, 'ACCOUNT_DEPLOYMENT_PENDING', 'account deployment is pending; retry later');
    throw new AppError(503, 'ACCOUNT_DEPLOYMENT_UNAVAILABLE', 'account deployment cannot be confirmed; retry later');
  } finally { inProgress.delete(key); }
}
