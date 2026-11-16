import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicClient, createWalletClient, custom, keccak256, toHex, WaitForTransactionReceiptTimeoutError } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';
import { deployAccount97 } from '../src/account-deployment.js';
import type { DeploymentIntent } from '../src/account-deployment.js';
import { AppError } from '../src/errors.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
import { kernelAddressesForChain } from '../src/addresses.js';
import { loadAccountDeploymentConfig } from '../src/config.js';
const operator = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 4 });
const hash = toHex(1n, { size: 32 });
const intent: DeploymentIntent = { address: operator.address, owner: T.roles.owner, strategyId: 1n, factory: T.contracts.kernelMetaFactory, factoryData: '0x1234' };
function fixture(mode = 'healthy') {
  let sent = 0, signed = 0, charged = 0, current = mode, transactionHash = hash;
  const transport = custom({ request: async ({ method, params }) => {
    if (current === 'rpc-failure') throw new Error('SECRET_RPC');
    if (method === 'eth_chainId') return current === 'wrong-chain' ? '0x38' : '0x61';
    if (method === 'eth_getBalance') {
      if (current === 'balance-rpc') throw new Error('SECRET_BALANCE');
      return toHex(current === 'low-balance' ? 49_999_999_999_999_999n : 50_000_000_000_000_000n);
    }
    if (method === 'eth_getTransactionCount') { signed++; if (current === 'prepare-failure') throw new Error('SECRET_NONCE_RPC'); return '0x0'; }
    if (method === 'eth_maxPriorityFeePerGas' || method === 'eth_gasPrice') return '0x1';
    if (method === 'eth_estimateGas') return '0x100000';
    if (method === 'eth_getCode') return current === 'already-deployed' || (sent > 0 && current === 'healthy') ? '0x6001' : '0x';
    if (method === 'eth_getBlockByNumber') return { hash: current === 'reorg' ? toHex(2n, { size: 32 }) : hash, number: '0x1', timestamp: '0x1', baseFeePerGas: '0x1', gasLimit: '0x1000000', gasUsed: '0x1', transactions: [] };
    if (method === 'eth_sendRawTransaction') {
      const raw = params?.[0]; assert.ok(typeof raw === 'string' && /^0x[0-9a-f]+$/.test(raw));
      sent++; transactionHash = keccak256(raw as `0x${string}`);
      if (current === 'send-failure') throw new Error('SECRET_SEND');
      return transactionHash;
    }
    throw new Error('unexpected RPC ' + method);
  } }, { retryCount: 0 });
  const client = createPublicClient({ chain: bscTestnet, transport });
  const chain = { chainId: 97, rpcUrl: 'http://127.0.0.1:8597', registryAddress: T.contracts.registry, account: operator,
    wallet: createWalletClient({ account: operator, chain: bscTestnet, transport }), publicClient: {
      ...client,
      waitForTransactionReceipt: async () => {
        if (current === 'pending') throw new WaitForTransactionReceiptTimeoutError({ hash: transactionHash });
        if (current === 'receipt-rpc') throw new Error('SECRET_RECEIPT_RPC');
        return { transactionHash, status: current === 'reverted' ? 'reverted' as const : 'success' as const };
      },
    }, kernel: kernelAddressesForChain(97) };
  // Preserve the concrete viem receipt type while overriding only the observed fields.
  const publicClient = { ...client, waitForTransactionReceipt: async () => {
    const receipt = await chain.publicClient.waitForTransactionReceipt();
    return { transactionHash: current === 'wrong-receipt-hash' ? hash : receipt.transactionHash, status: receipt.status, blockNumber: 1n, blockHash: hash,
      from: current === 'wrong-receipt-from' ? T.roles.owner : operator.address, to: current === 'wrong-receipt-to' ? T.roles.owner : intent.factory, transactionIndex: 0, contractAddress: null, logs: [], logsBloom: '0x' as const,
      cumulativeGasUsed: 1n, gasUsed: 1n, effectiveGasPrice: 1n, type: 'eip1559' as const };
  } };
  const deps = { budget: async () => {
    if (current === 'quota-full') throw new AppError(503, 'ACCOUNT_DEPLOYMENT_DAILY_LIMIT', 'daily deployment limit reached');
    if (current === 'quota-db') throw new Error('SECRET_QUOTA_DB');
    charged++;
  }, lock: async <R,>(_id: number, action: (held: () => void) => Promise<R>) => {
    if (current === 'db-failure') throw new Error('SECRET_DB');
    return action(() => { if (current === 'lost-lock') throw new AppError(503, 'RELAYER_BUSY', 'busy'); });
  } };
  return { chain: { ...chain, publicClient }, deps, change: (value: string) => { current = value; }, counts: () => ({ sent, signed, charged }) };
}
const code = (expected: string) => (error: unknown) => error instanceof AppError && error.code === expected && !error.message.includes('SECRET');

test('#124 direct deployment uses getCode and repeated calls skip sending once deployed, without a deployment table', async () => {
  const f = fixture();
  assert.deepEqual(await deployAccount97(intent, f.chain, f.deps), { address: intent.address, deployed: true });
  const first = f.counts(); assert.equal(first.sent, 1); assert.equal(first.signed, 1);
  assert.deepEqual(await deployAccount97(intent, f.chain, f.deps), { address: intent.address, deployed: false });
  assert.deepEqual(f.counts(), first);
});

test('#124 pre-existing account skips nonce acquisition and deployment', async () => {
  const f = fixture('already-deployed');
  assert.deepEqual(await deployAccount97(intent, f.chain, f.deps), { address: intent.address, deployed: false });
  assert.deepEqual(f.counts(), { sent: 0, signed: 0, charged: 0 });
});

test('#124 deployment enforces balance and persistent quota before sending, and never charges deployed/polling requests', async () => {
  for (const mode of ['low-balance','balance-rpc','quota-full','quota-db']) {
    const f=fixture(mode);
    await assert.rejects(deployAccount97(intent,f.chain,f.deps),code(mode==='low-balance'?'ACCOUNT_DEPLOYMENT_LOW_BALANCE':mode==='quota-full'?'ACCOUNT_DEPLOYMENT_DAILY_LIMIT':'ACCOUNT_DEPLOYMENT_UNAVAILABLE'));
    assert.equal(f.counts().sent,0);assert.equal(f.counts().charged,0);
  }
  const f=fixture();
  await deployAccount97(intent,f.chain,f.deps);assert.equal(f.counts().charged,1,'balance equality is allowed');
  await deployAccount97(intent,f.chain,f.deps);assert.equal(f.counts().charged,1);
});

test('#124 deployment budget config validates inclusive zero/cap and exact wei without exposing invalid values',()=>{
  assert.deepEqual(loadAccountDeploymentConfig({}),{perDay:300,minBalanceWei:50_000_000_000_000_000n});
  assert.deepEqual(loadAccountDeploymentConfig({ACCOUNT_DEPLOYMENTS_PER_DAY:'0',ACCOUNT_DEPLOYMENT_MIN_BALANCE_WEI:'0'}),{perDay:0,minBalanceWei:0n});
  assert.equal(loadAccountDeploymentConfig({ACCOUNT_DEPLOYMENTS_PER_DAY:'1000000',ACCOUNT_DEPLOYMENT_MIN_BALANCE_WEI:'9007199254740993'}).minBalanceWei,9007199254740993n);
  for(const name of ['ACCOUNT_DEPLOYMENTS_PER_DAY','ACCOUNT_DEPLOYMENT_MIN_BALANCE_WEI']){
    for(const raw of ['-1','0.5','Infinity','SECRET_VALUE'])assert.throws(()=>loadAccountDeploymentConfig({[name]:raw}),error=>error instanceof Error&&error.message.includes(name)&&!error.message.includes(raw));
  }
});

test('#124 deployment receipt timeout returns pending; a mined retry uses the code guard', async () => {
  const f = fixture('pending');
  await assert.rejects(deployAccount97(intent, f.chain, f.deps), code('ACCOUNT_DEPLOYMENT_PENDING'));
  assert.equal(f.counts().sent, 1);
  f.change('healthy');
  assert.equal((await deployAccount97(intent, f.chain, f.deps)).deployed, false);
  assert.equal(f.counts().sent, 1);
});

test('#124 direct deployment rejects DB/RPC/chain/lock failures, reverted receipts and missing code', async () => {
  for (const mode of ['db-failure', 'rpc-failure', 'wrong-chain', 'lost-lock', 'prepare-failure', 'send-failure', 'receipt-rpc', 'reverted', 'missing-code', 'wrong-receipt-hash', 'wrong-receipt-from', 'wrong-receipt-to', 'reorg']) {
    const f = fixture(mode);
    const expected = mode.startsWith('wrong-receipt-') ? 'ACCOUNT_DEPLOYMENT_RECEIPT_MISMATCH' : mode === 'reorg' ? 'ACCOUNT_DEPLOYMENT_PENDING' : mode === 'lost-lock' ? 'RELAYER_BUSY' : mode === 'reverted' ? 'ACCOUNT_DEPLOYMENT_REVERTED' : mode === 'missing-code' ? 'ACCOUNT_DEPLOYMENT_CODE_MISSING' : 'ACCOUNT_DEPLOYMENT_UNAVAILABLE';
    await assert.rejects(deployAccount97(intent, f.chain, f.deps), code(expected));
    if (['db-failure', 'rpc-failure', 'wrong-chain', 'lost-lock', 'prepare-failure'].includes(mode)) {
      assert.equal(f.counts().sent, 0); assert.equal(f.counts().charged, 0);
    }
    if (mode === 'send-failure') assert.equal(f.counts().charged, 1, 'an ambiguous broadcast attempt retains its charge');
  }
});

test('#124 a concurrent request for the same account gets 202 while the first deployment is in progress', async () => {
  const f = fixture();
  let release = () => {}, notify = () => {}, locked = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { notify = resolve; });
  f.deps.lock = async <R,>(_id: number, action: (held: () => void) => Promise<R>) => {
    if (locked) throw new AppError(503, 'RELAYER_BUSY', 'busy');
    locked = true; notify(); await held;
    return action(() => {});
  };
  const first = deployAccount97(intent, f.chain, f.deps);
  await started;
  try {
    await assert.rejects(deployAccount97(intent, f.chain, f.deps), code('ACCOUNT_DEPLOYMENT_PENDING'));
    assert.equal(f.counts().sent, 0);
  } finally { release(); await first; }
  assert.equal(f.counts().sent, 1);
});
