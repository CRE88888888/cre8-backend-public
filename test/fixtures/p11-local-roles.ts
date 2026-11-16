/** Opt-in preload for full local acceptance without opening deployment key files.
 * Only known public anvil identities replace roles in memory; generated manifests stay untouched.
 * First prove the original paymaster runtime, then alter only its compiler immutable signer word.
 */
import assert from 'node:assert/strict';
import { createPublicClient, createTestClient, createWalletClient, http, keccak256, parseAbi } from 'viem';
import type { Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';
import { TESTNET_97 as T } from '../../src/testnet-profile.js';
import hashes from '../../src/testnet-codehashes.js';
import { localAcceptanceEnv } from './local-acceptance.js';
const lane = localAcceptanceEnv(process.env, true);
assert.equal(process.env.P11_LOCAL_ROLES, '1');
assert.equal(lane.rpcUrl, 'http://127.0.0.1:8597');
assert.equal(lane.bundler?.url, 'http://127.0.0.1:3097');
assert.equal(lane.databaseName, 'cre8_be124');
const client = createPublicClient({ chain: bscTestnet, transport: http(lane.rpcUrl, { timeout: 120000, retryCount: 0 }) });
const local = createTestClient({ mode: 'anvil', chain: bscTestnet, transport: http(lane.rpcUrl) });
await local.getAutomine(); assert.equal(await client.getChainId(), 97);
const mnemonic = 'test test test test test test test test test test test junk';
const operator = mnemonicToAccount(mnemonic, { addressIndex: 4 }), sponsor = mnemonicToAccount(mnemonic, { addressIndex: 6 });
const originalSigner = T.roles.paymasterSigner.slice(2).padStart(64, '0');
const localSigner = sponsor.address.slice(2).toLowerCase().padStart(64, '0');
const code = await client.getCode({ address: T.contracts.paymaster }); assert.ok(code);
const restored = code.toLowerCase().replaceAll(localSigner, originalSigner) as Hex;
assert.equal(keccak256(restored), hashes.paymaster, 'local signer fixture must reconstruct the exact pinned original runtime');
assert.ok(restored.includes(originalSigner));
const patched = restored.replaceAll(originalSigner, localSigner) as Hex;
await local.setCode({ address: T.contracts.paymaster, bytecode: patched });
Object.defineProperty(hashes, 'paymaster', { value: keccak256(patched) });
Object.defineProperty(T.roles, 'paymasterSigner', { value: sponsor.address.toLowerCase() });
await local.impersonateAccount({ address: T.roles.owner });
await local.setBalance({ address: T.roles.owner, value: 100n * 10n ** 18n });
const owner = createWalletClient({ chain: bscTestnet, account: T.roles.owner, transport: http(lane.rpcUrl) });
const abi = parseAbi(['function setOperator(address)', 'function setFaucet(address,bool)']);
for (const hash of [
  await owner.writeContract({ address: T.contracts.registry, abi, functionName: 'setOperator', args: [operator.address] }),
  await owner.writeContract({ address: T.contracts.usdt, abi, functionName: 'setFaucet', args: [operator.address, true] }),
]) {
  await local.mine({ blocks: 1 });
  assert.equal((await client.waitForTransactionReceipt({ hash })).status, 'success');
}
Object.defineProperty(T.roles, 'operator', { value: operator.address.toLowerCase() });
console.log('P11 local roles: exact original runtime verified; public anvil operator/sponsor selected in memory');

// Direct operator deployment must work without third-party EntryPoint staking.
const stakeAbi = parseAbi(['function getDepositInfo(address) view returns((uint256 deposit,bool staked,uint112 stake,uint32 unstakeDelaySec,uint48 withdrawTime))']);
const factoryStake = await client.readContract({ address: T.contracts.entryPoint, abi: stakeAbi, functionName: 'getDepositInfo', args: [T.contracts.kernelMetaFactory] });
assert.equal(factoryStake.staked, false);
assert.equal(factoryStake.stake, 0n);
console.log('P11 local factory fixture: MetaFactory remains unstaked; safe mode retained');
