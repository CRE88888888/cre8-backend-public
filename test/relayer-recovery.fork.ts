/** Explicit local acceptance with contracts main's manifest. Run only on the lane's anvil.
 * The production profile/address sync is deferred by C3; this isolated process binds the
 * supplied manifest after the localhost/anvil/chain guards. No production config override.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createPublicClient, createTestClient, createWalletClient, encodeFunctionData, erc20Abi, getAddress, http, keccak256, parseAbi } from 'viem';
import { bscTestnet } from 'viem/chains';
import { localAcceptanceEnv } from './fixtures/local-acceptance.js';
import { relayerSigner } from './fixtures/relayer.js';
import { welcomeFixture } from './fixtures/welcome.js';
import { closePool, query, withTransaction } from '../src/db.js';
import { TESTNET_97 } from '../src/testnet-profile.js';
import { createWelcomeService, findWelcomeGrant, WELCOME_ABI } from '../src/welcome-grants.js';
import { createFaucetService, FAUCET_ABI, settleFaucetClaim } from '../src/faucet.js';
import { reconcileRelayerTransactions } from '../src/relayer-reconciliation.js';
import { WELCOME_AMOUNT_WEI } from '../src/config.js';

const endpoints = localAcceptanceEnv(process.env);
assert.ok(endpoints.rpcUrl);
const RPC = endpoints.rpcUrl;
const transport = http(RPC, { timeout: 5000, retryCount: 0 });
const client = createPublicClient({ chain: bscTestnet, transport });
const local = createTestClient({ chain: bscTestnet, mode: 'anvil', transport });

test('#97 contracts main local fork: committed welcome/claim recover only the original signed transaction after reconnect', { timeout: 120000 }, async () => {
  const response = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_nodeInfo', params: [] }), signal: AbortSignal.timeout(5000) });
  const info: unknown = await response.json(); assert.ok(info && typeof info === 'object' && 'result' in info && info.result);
  assert.equal(await client.getChainId(), 97);
  assert.ok(process.env.TESTNET_MANIFEST);
  const manifest: unknown = JSON.parse(await readFile(process.env.TESTNET_MANIFEST, 'utf8'));
  assert.ok(manifest && typeof manifest === 'object' && 'contracts' in manifest && manifest.contracts && typeof manifest.contracts === 'object');
  const usdt = Reflect.get(manifest.contracts, 'usdt'), registry = Reflect.get(manifest.contracts, 'registry');
  assert.equal(typeof usdt, 'string'); assert.equal(typeof registry, 'string');
  const token = getAddress(String(usdt));
  const saved = { ...TESTNET_97.contracts };
  const snapshot = await local.snapshot();
  try {
    // Test-process-only profile, using the exact manifest from the clean contracts archive.
    Object.assign(TESTNET_97.contracts, { usdt: token.toLowerCase(), registry: String(registry).toLowerCase() });
    const abi = parseAbi(['function owner() view returns(address)', 'function setFaucet(address,bool)', 'function isFaucet(address) view returns(bool)',
      'function isMinter(address) view returns(bool)', 'function numeraire() view returns(address)']);
    assert.equal((await client.readContract({ address: getAddress(String(registry)), abi, functionName: 'numeraire' })).toLowerCase(), token.toLowerCase());
    assert.equal(await client.readContract({ address: token, abi, functionName: 'isMinter', args: [TESTNET_97.roles.operator] }), false);
    assert.equal(await client.readContract({ address: token, abi, functionName: 'isMinter', args: [TESTNET_97.roles.keeper] }), false);
    assert.equal(await client.readContract({ address: token, abi, functionName: 'isFaucet', args: [TESTNET_97.roles.operator] }), true);
    const owner = await client.readContract({ address: token, abi, functionName: 'owner' });
    await local.impersonateAccount({ address: owner }); await local.setBalance({ address: owner, value: 10n ** 20n });
    const admin = createWalletClient({ chain: bscTestnet, account: owner, transport });
    const appointed = await admin.writeContract({ address: token, abi, functionName: 'setFaucet', args: [relayerSigner.address, true] });
    await client.waitForTransactionReceipt({ hash: appointed });
    await local.stopImpersonatingAccount({ address: owner });
    await local.setBalance({ address: relayerSigner.address, value: 10n ** 20n });
    assert.equal(await client.readContract({ address: token, abi, functionName: 'isMinter', args: [relayerSigner.address] }), false);
    const f = await welcomeFixture();
    let broadcasts = 0;
    for (const kind of ['welcome', 'faucet'] as const) {
      const nonce = await client.getTransactionCount({ address: relayerSigner.address });
      const amountWei = kind === 'welcome' ? WELCOME_AMOUNT_WEI : 1000n * 10n ** 18n;
      const data = kind === 'welcome' ? encodeFunctionData({ abi: WELCOME_ABI, functionName: 'welcomeFor', args: [f.account] })
        : encodeFunctionData({ abi: FAUCET_ABI, functionName: 'claimFor', args: [f.account, amountWei] });
      const raw = await relayerSigner.signTransaction({ type: 'eip1559', chainId: 97, nonce, gas: 200000n, maxFeePerGas: 20_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n, to: token, data, value: 0n });
      const hash = keccak256(raw);
      const prepare = async () => ({ hash, raw, broadcast: async () => { broadcasts++; }, wait: async () => {}, receipt: async () => 'unknown' as const });
      const lost: typeof withTransaction = async fn => { await withTransaction(fn); throw new Error('simulated lost commit response'); };
      if (kind === 'welcome') {
        const service = createWelcomeService({ config: { chainId: 97, siteDailyWei: 10n ** 30n, timeoutMs: 5000 }, prepare,
          settle: (g, state, hash, evidence, _tx, signed) => f.settle(g, state, hash, evidence, lost, signed) });
        await assert.rejects(service.issue(f.recipient), { code: 'WELCOME_STORAGE_UNAVAILABLE' });
      } else {
        const service = createFaucetService({ config: { chainId: 97, amountWei, siteDailyWei: 10n ** 30n, timeoutMs: 5000 }, prepare,
          settle: (claim, from, to, hash, _tx, signed) => settleFaucetClaim(claim, from, to, hash, lost, signed ? { ...signed, operator: relayerSigner.address } : undefined) });
        await assert.rejects(service.claim({ account: f.account }, f.owner), { code: 'FAUCET_STORAGE_UNAVAILABLE' });
      }
      assert.equal(broadcasts, 0); assert.equal(await client.getTransactionCount({ address: relayerSigner.address }), nonce);
      await closePool(); // process/service reconnection reads the durable original bytes
      const replay = await reconcileRelayerTransactions({ client, operator: relayerSigner.address, replay: true });
      assert.equal(replay.replayed, 1);
      await client.waitForTransactionReceipt({ hash });
      assert.equal((await reconcileRelayerTransactions({ client, operator: relayerSigner.address, replay: true })).confirmed, 1);
      assert.equal(await client.getTransactionCount({ address: relayerSigner.address }), nonce + 1);
      const stored = (await query<{ signed_raw_tx: string }>('select signed_raw_tx from relayer_transaction_outbox where tx_hash=$1', [hash])).rows[0];
      assert.equal(stored?.signed_raw_tx, raw);
      if (kind === 'welcome') assert.equal((await findWelcomeGrant(97, f.owner))?.state, 'confirmed');
    }
    assert.equal(await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [f.account] }), 11000n * 10n ** 18n);
  } finally {
    Object.assign(TESTNET_97.contracts, saved);
    await local.revert({ id: snapshot }); await closePool();
  }
});
