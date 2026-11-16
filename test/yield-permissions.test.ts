import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicClient, custom, encodeFunctionData, getAddress, pad, toFunctionSelector } from 'viem';
import type { Address } from 'viem';
import { bscTestnet } from 'viem/chains';
import { encodeCallDataEpV07 } from '@zerodev/sdk';
import { buildSessionPermissions, describePolicies, yieldAuthorization } from '../src/permissions.js';
import { YIELD_EXECUTOR_ABI } from '../src/yield-abi.js';
import { validateSponsoredCalls } from '../src/paymaster.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
import { config, SENDER, TEST_SIGNER, operation } from './fixtures/paymaster.js';
import { yieldFixture } from './fixtures/yield.js';
import { yieldSessionAvailable } from '../src/yield-session.js';

const client = createPublicClient({ chain: bscTestnet, transport: custom({ request: async () => { throw new Error('unexpected RPC'); } }) });
const executor = T.contracts.executor;
const OWNER = getAddress('0x2000000000000000000000000000000000000001');
const validUntil = 1_900_000_000;

test('#112 session availability rejects time boundaries and missing installation; RPC uncertainty never becomes a fallback signal',async()=>{
  const f=yieldFixture(['venus']),now=Math.floor(+f.at/1000);
  for(const until of [0,now-1,now,now+1]){
    const s=await buildSessionPermissions({publicClient:f.client,sessionKeyAddress:f.account,executorAddress:f.executor,validUntil:until,yieldAccount:f.account});
    assert.equal(await yieldSessionAvailable(f.client,s.policySnapshot,f.account,f.executor,f.at),until>now);
    if(until>now){
      f.sessionState.missing=[s.permissionId.slice(2)];
      assert.equal(await yieldSessionAvailable(f.client,s.policySnapshot,f.account,f.executor,f.at),false);
      f.sessionState.missing=[];f.state.fail='eth_call';
      await assert.rejects(yieldSessionAvailable(f.client,s.policySnapshot,f.account,f.executor,f.at));f.state.fail='';
    }
  }
});

test('#112 retained signer does not override a revoked selector, cleared validation or invalidated nonce',async()=>{
  const f=yieldFixture(['venus']);
  const s=await buildSessionPermissions({publicClient:f.client,sessionKeyAddress:f.account,executorAddress:f.executor,validUntil:Math.floor(+f.at/1000)+86400,yieldAccount:f.account});
  const available=()=>yieldSessionAvailable(f.client,s.policySnapshot,f.account,f.executor,f.at);
  for(const kind of ['revoked','cleared','invalidNonce'] as const){
    f.sessionState[kind]=[s.permissionId.slice(2)];assert.equal(await available(),false,kind);f.sessionState[kind]=[];
  }
  assert.equal(await available(),true,'validation nonce exactly equals validNonceFrom');
  f.sessionState.validNonceFrom=2;assert.equal(await available(),false);
  f.sessionState.validNonceFrom=1;
  for(const missing of ['missingNumber','missingHash','reorg'] as const){
    f.sessionState[missing]=true;await assert.rejects(available());f.sessionState[missing]=false;f.state.blockHash=f.blockHash;
  }
});

test('#85 legacy deployment policies stay byte-identical; owner renewal adds exactly two self-account calls', async () => {
  const legacy = describePolicies({ executorAddress: executor, validUntil, chainId: 97 });
  assert.equal(legacy.call.permissions.length, 1);
  assert.equal(yieldAuthorization(legacy, SENDER, executor).status, 'authorization_required');
  const session = await buildSessionPermissions({ publicClient: client, sessionKeyAddress: SENDER,
    executorAddress: executor, validUntil, yieldAccount: SENDER });
  assert.equal(session.policySnapshot.call.permissions.length, 3);
  assert.equal(yieldAuthorization(session.policySnapshot, SENDER, executor).status, 'ready');
  assert.equal(yieldAuthorization(session.policySnapshot, OWNER, executor).status, 'authorization_required');
  assert.equal(yieldAuthorization(session.policySnapshot, SENDER, OWNER).status, 'authorization_required');
  for (const permission of session.policySnapshot.call.permissions.slice(1)) {
    assert.equal(permission.target, executor);
    assert.equal(permission.valueLimit, '0');
    assert.deepEqual(permission.rules, [{ condition: 0, offset: 0, params: [pad(SENDER)] }]);
  }
  const c = config({ CHAIN_ID: '97', RPC_URL: 'http://127.0.0.1:8592', PAYMASTER_SIGNER_PRIVATE_KEY: TEST_SIGNER });
  const data = await encodeCallDataEpV07(session.initConfig.map(data => ({ to: SENDER, data, value: 0n })));
  validateSponsoredCalls(operation({ callData: data }), c);
  const unsafe = structuredClone(session.policySnapshot);
  const permission = unsafe.call.permissions[1]; assert.ok(permission);
  permission.rules = [];
  assert.equal(yieldAuthorization(unsafe, SENDER, executor).status, 'authorization_required');
  for (const snapshot of [null, {}, { call: { permissions: [] } }]) {
    assert.equal(yieldAuthorization(snapshot, SENDER, executor).status, 'authorization_required');
  }
});

test('#85 ABI selectors and canonical paymaster allow only positive self supply/withdraw in known markets', () => {
  const supply = YIELD_EXECUTOR_ABI.find(fn => fn.type === 'function' && fn.name === 'executeSupply');
  assert.ok(supply && supply.type === 'function');
  assert.equal(toFunctionSelector(supply), '0x5728db07');
  const c = config({ CHAIN_ID: '97', RPC_URL: 'http://127.0.0.1:8592', PAYMASTER_SIGNER_PRIVATE_KEY: TEST_SIGNER });
  const market = T.yieldMarkets[0]; assert.ok(market);
  for (const functionName of ['executeSupply', 'executeWithdraw'] as const) {
    const data = encodeFunctionData({ abi: YIELD_EXECUTOR_ABI, functionName, args: [SENDER, market.marketId, 1n, 1n, 2_000_000_000n] });
    const call = (data: `0x${string}`, target: Address = executor) => operation({ callData: encodeFunctionData({
      abi: [{ type: 'function', name: 'execute', stateMutability: 'payable', inputs: [{ type: 'bytes32' }, { type: 'bytes' }], outputs: [] }],
      functionName: 'execute', args: [`0x${'0'.repeat(64)}`, `${target}${'0'.repeat(64)}${data.slice(2)}`] }) });
    validateSponsoredCalls(call(data), c);
    for (const args of [[OWNER, market.marketId, 1n, 1n, 1n], [SENDER, market.marketId, 0n, 1n, 1n],
      [SENDER, market.marketId, 1n, 0n, 1n], [SENDER, pad('0x01'), 1n, 1n, 1n]] as const) {
      assert.throws(() => validateSponsoredCalls(call(encodeFunctionData({ abi: YIELD_EXECUTOR_ABI, functionName, args })), c), /PAYMASTER_CALL_FORBIDDEN/);
    }
    assert.throws(() => validateSponsoredCalls(call(`${data}00`), c), /PAYMASTER_CALL_FORBIDDEN/);
    assert.throws(() => validateSponsoredCalls(call(data, T.contracts.registry), c), /PAYMASTER_CALL_FORBIDDEN/);
  }
});


test('#112-r2 GasPolicy zero is unavailable, one wei remains live, and unknown allowance fails closed',async()=>{
  const f=yieldFixture(['venus']);
  const s=await buildSessionPermissions({publicClient:f.client,sessionKeyAddress:f.account,executorAddress:f.executor,validUntil:Math.floor(+f.at/1000)+86400,yieldAccount:f.account});
  const available=()=>yieldSessionAvailable(f.client,s.policySnapshot,f.account,f.executor,f.at);
  assert.equal(await available(),true);
  f.sessionState.exhausted=[s.permissionId.slice(2)];assert.equal(await available(),false);
  f.sessionState.exhausted=[];f.sessionState.gasFailure=true;await assert.rejects(available());
});
