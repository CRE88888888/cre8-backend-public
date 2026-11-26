/** Encoding vectors shared with APP-3. These are not protocol quotes or executable trade plans. */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, custom, encodeFunctionData } from 'viem';
import { bscTestnet } from 'viem/chains';
import { mnemonicToAccount } from 'viem/accounts';
import { buildSessionPermissions } from '../src/permissions.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
import { YIELD_EXECUTOR_ABI } from '../src/yield-abi.js';

export async function yieldGoldenVector() {
  const account = '0x1000000000000000000000000000000000000005';
  const sessionKey = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 3 }).address;
  const validUntil = 1_900_000_000;
  const client = createPublicClient({ chain: bscTestnet, transport: custom({ request: async () => { throw new Error('encoding vector must not use RPC'); } }) });
  const session = await buildSessionPermissions({ publicClient: client, sessionKeyAddress: sessionKey,
    executorAddress: T.contracts.executor, yieldAccount: account, validUntil });
  return { encodingOnly: true, chainId: 97, sourceCommit: T.sourceCommit, account, sessionKey, validUntil,
    executor: T.contracts.executor, yieldRegistry: T.contracts.yieldRegistry, yieldView: T.contracts.yieldView,
    permissionId: session.permissionId, policySnapshot: session.policySnapshot, initConfig: session.initConfig,
    calls: T.yieldMarkets.slice(0, 3).flatMap(market => ['executeSupply', 'executeWithdraw'].map(functionName => {
      const kind = functionName === 'executeSupply' ? 'executeSupply' : 'executeWithdraw';
      const data = encodeFunctionData({ abi: YIELD_EXECUTOR_ABI, functionName: kind, args: [account, market.marketId, 1n, 1n, BigInt(validUntil)] });
      return { protocol: market.protocol, marketId: market.marketId, functionName: kind, amountRaw: '1', minimumRaw: '1', deadline: String(validUntil), selector: data.slice(0, 10), data };
    })) };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  writeFileSync('test/fixtures/yield-golden.json', JSON.stringify(await yieldGoldenVector(), null, 2) + '\n');
}
