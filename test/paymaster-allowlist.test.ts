import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PolicyFlags, toInitConfig, toPermissionValidator } from '@zerodev/permissions';
import { CallPolicyVersion, CallType, toCallPolicy, toGasPolicy, toTimestampPolicy } from '@zerodev/permissions/policies';
import { toEmptyECDSASigner } from '@zerodev/permissions/signers';
import { encodeCallDataEpV07, KernelV3_3AccountAbi } from '@zerodev/sdk';
import { KERNEL_V3_3 } from '@zerodev/sdk/constants';
import { concatHex, createPublicClient, decodeFunctionData, defineChain, encodeFunctionData, erc20Abi, http, slice, toHex, zeroAddress } from 'viem';
import type { Address, Hex } from 'viem';
import { EXECUTOR_SELECTOR } from '../src/chain.js';
import { AppError } from '../src/errors.js';
import { createPaymasterService, KERNEL_EXECUTE_ABI, validateSponsoredCalls } from '../src/paymaster.js';
import type { PaymasterDeps } from '../src/paymaster.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
import { TEST_SIGNER, OWNER, SENDER, NOW, operation, config } from './fixtures/paymaster.js';

const C = T.contracts;
const c = config({ CHAIN_ID: '97', RPC_URL: 'http://127.0.0.1:8558', PAYMASTER_SIGNER_PRIVATE_KEY: TEST_SIGNER });
const asset = T.assets.WBNB.token;
const max = (1n << 256n) - 1n;
type Call = { to: Address; data: Hex; value: bigint };
const call = (data: Hex, to: Address = asset, value = 0n): Call => ({ to, data, value });
const approve = (spender: Address = C.executor, amount = max) => encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] });
const transfer = (recipient: Address = OWNER as Address, amount = 1n) => encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [recipient, amount] });
const forbidden = (error: unknown) => error instanceof AppError && error.code === 'PAYMASTER_CALL_FORBIDDEN';
const client = createPublicClient({ chain: defineChain({ id: 97, name: 'local fixture', nativeCurrency: { name: 'tBNB', symbol: 'tBNB', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8558'] } } }), transport: http('http://127.0.0.1:8558') });

function service(deps: PaymasterDeps = {}) {
  return createPaymasterService({ config: c, now: () => NOW,
    query: async () => ({ rows: [{ owner: OWNER, user_id: OWNER }] }), checkChain: async () => {}, reserve: async () => {}, ...deps });
}
type RenewalOptions = {
  callPolicy?: Partial<Parameters<typeof toCallPolicy>[0]>;
  gas?: Partial<Parameters<typeof toGasPolicy>[0]>;
  timestamp?: Partial<Parameters<typeof toTimestampPolicy>[0]>;
  signerContract?: Address;
  signerAddress?: Address;
  flag?: PolicyFlags;
  omitPolicy?: number;
};
async function renewalCalls(options: RenewalOptions = {}): Promise<Call[]> {
  // Same SDK, policies and initConfig as kernel-smoke and backend renewal-params; no RPC is needed.
  const permission = await toPermissionValidator(client, {
    signer: toEmptyECDSASigner(options.signerAddress ?? SENDER, options.signerContract ?? C.ecdsaSigner), entryPoint: { address: C.entryPoint, version: '0.7' }, kernelVersion: KERNEL_V3_3,
    flag: options.flag ?? PolicyFlags.FOR_ALL_VALIDATION,
    policies: [toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, policyAddress: C.callPolicy,
      permissions: [{ target: C.executor, selector: EXECUTOR_SELECTOR }], ...options.callPolicy }),
    toGasPolicy({ policyAddress: C.gasPolicy, allowed: 10n ** 18n, enforcePaymaster: true, allowedPaymaster: C.paymaster, ...options.gas }),
    toTimestampPolicy({ policyAddress: C.timestampPolicy, validAfter: 0, validUntil: NOW + 365 * 86400, ...options.timestamp })]
      .filter((_policy, index) => index !== options.omitPolicy),
  });
  return (await toInitConfig(permission)).map((data) => call(data, SENDER));
}

test('#71 approve: SDK single and batch, including zero and uint256 maximum', async () => {
  for (const calls of [[call(approve())], [call(approve(C.executor, 0n), C.usdt), call(approve(C.executor, 1n))]]) {
    const result = await service().sponsor({ userOperation: operation({ callData: await encodeCallDataEpV07(calls) }) }, OWNER);
    assert.equal(result.paymaster, C.paymaster);
  }
});

test('#71 transfer: owner single and multiple assets use the authenticated sponsorship service', async () => {
  for (const calls of [[call(transfer())], [call(transfer(OWNER as Address, max), C.usdt), call(transfer())]]) {
    const result = await service().sponsor({ userOperation: operation({ callData: await encodeCallDataEpV07(calls) }) }, OWNER);
    assert.equal(result.paymaster, C.paymaster);
  }
});

test('#71 renewal: the SDK installValidations + nested grantAccess pair is sponsored', async () => {
  const result = await service().sponsor({ userOperation: operation({ callData: await encodeCallDataEpV07(await renewalCalls()) }) }, OWNER);
  assert.equal(result.paymaster, C.paymaster);
});

test('#71 renewal permits canonical nonzero uint48 expiry boundaries and a different ECDSA session signer', async () => {
  for (const validUntil of [1, 2 ** 48 - 1]) {
    const calls = await renewalCalls({ timestamp: { validUntil }, signerAddress: asset });
    validateSponsoredCalls(operation({ callData: await encodeCallDataEpV07(calls) }), c);
  }
});

test('#71 transfers require an owner context; chain 97 cannot be broadened with foreign address-book rows', async () => {
  const callData = await encodeCallDataEpV07([call(transfer())]);
  assert.throws(() => validateSponsoredCalls(operation({ callData }), c), forbidden);
  const foreign = await encodeCallDataEpV07([call(approve(), '0x55d398326f99059ff775485246999027b3197955')]);
  assert.throws(() => validateSponsoredCalls(operation({ callData: foreign }), c, { assets: ['0x55d398326f99059ff775485246999027b3197955'] }), forbidden);
});

for (const [name, calls] of [
  ['wrong spender', [call(approve(SENDER))]],
  ['unknown token', [call(approve(), SENDER)]],
  ['mainnet token on chain 97', [call(approve(), '0x55d398326f99059ff775485246999027b3197955')]],
  ['foreign recipient', [call(transfer(SENDER))]],
  ['zero recipient', [call(transfer(zeroAddress))]],
  ['zero withdrawal', [call(transfer(OWNER as Address, 0n))]],
  ['unknown withdrawal token', [call(transfer(), C.router)]],
  ['native value', [call(approve(), asset, 1n)]],
  ['native withdrawal', [call('0x', OWNER as Address, 1n)]],
  ['trailing approve bytes', [call(concatHex([approve(), '0x00']))]],
  ['trailing transfer bytes', [call(concatHex([transfer(), '0x00']))]],
  ['truncated approve', [call(slice(approve(), 0, 67))]],
  ['truncated transfer', [call(slice(transfer(), 0, 67))]],
  ['transferFrom', [call(encodeFunctionData({ abi: erc20Abi, functionName: 'transferFrom', args: [SENDER, OWNER as Address, 1n] }))]],
  ['bad spender hidden after valid transfer', [call(transfer()), call(approve(SENDER))]],
  ['bad recipient hidden after valid approve', [call(approve()), call(transfer(SENDER))]],
] satisfies [string, Call[]][]) {
  test('#71 token rejection: ' + name, async () => {
    let reserved = false;
    await assert.rejects(service({ reserve: async () => { reserved = true; } })
      .sponsor({ userOperation: operation({ callData: await encodeCallDataEpV07(calls) }) }, OWNER), forbidden);
    assert.equal(reserved, false);
  });
}

test('#71 every profile asset and numeraire is allowed; batch limit is exactly 32', async () => {
  for (const token of [C.usdt, ...Object.values(T.assets).map((a) => a.token)]) {
    await service().sponsor({ userOperation: operation({ callData: await encodeCallDataEpV07([call(approve(), token), call(transfer(), token)]) }) }, OWNER);
  }
  const calls = Array.from({ length: 32 }, () => call(transfer()));
  await service().sponsor({ userOperation: operation({ callData: await encodeCallDataEpV07(calls) }) }, OWNER);
  await assert.rejects(service().sponsor({ userOperation: operation({ callData: await encodeCallDataEpV07([...calls, call(transfer())]) }) }, OWNER), forbidden);
});

for (const [name, options] of [
  ['foreign call policy contract', { callPolicy: { policyAddress: SENDER } }],
  ['call policy skips UserOp validation', { callPolicy: { policyFlag: PolicyFlags.NOT_FOR_VALIDATE_USEROP } }],
  ['foreign executor', { callPolicy: { permissions: [{ target: SENDER, selector: EXECUTOR_SELECTOR }] } }],
  ['wrong selector', { callPolicy: { permissions: [{ target: C.executor, selector: '0xa9059cbb' }] } }],
  ['wildcard target', { callPolicy: { permissions: [{ target: zeroAddress, selector: EXECUTOR_SELECTOR }] } }],
  ['delegatecall permission', { callPolicy: { permissions: [{ target: C.executor, selector: EXECUTOR_SELECTOR, callType: CallType.DELEGATE_CALL }] } }],
  ['native permission', { callPolicy: { permissions: [{ target: C.executor, selector: EXECUTOR_SELECTOR, valueLimit: 1n }] } }],
  ['extra permission', { callPolicy: { permissions: [{ target: C.executor, selector: EXECUTOR_SELECTOR }, { target: asset, selector: '0xa9059cbb' }] } }],
  ['missing call policy', { omitPolicy: 0 }],
  ['missing gas policy', { omitPolicy: 1 }],
  ['missing timestamp policy', { omitPolicy: 2 }],
  ['foreign gas policy contract', { gas: { policyAddress: SENDER } }],
  ['paymaster enforcement off', { gas: { enforcePaymaster: false } }],
  ['foreign paymaster', { gas: { allowedPaymaster: SENDER } }],
  ['gas policy skips UserOp validation', { gas: { policyFlag: PolicyFlags.NOT_FOR_VALIDATE_USEROP } }],
  ['zero gas allowance', { gas: { allowed: 0n } }],
  ['gas allowance above configured budget', { gas: { allowed: 10n ** 18n + 1n } }],
  ['unbounded timestamp', { timestamp: { validUntil: 0 } }],
  ['unexpected validAfter', { timestamp: { validAfter: 1 } }],
  ['foreign timestamp policy', { timestamp: { policyAddress: SENDER } }],
  ['timestamp policy skips UserOp validation', { timestamp: { policyFlag: PolicyFlags.NOT_FOR_VALIDATE_USEROP } }],
  ['foreign signer contract', { signerContract: asset }],
  ['zero session signer', { signerAddress: zeroAddress }],
  ['signer skips UserOp validation', { flag: PolicyFlags.NOT_FOR_VALIDATE_USEROP }],
] satisfies [string, RenewalOptions][]) {
  test('#71 renewal rejects ' + name, async () => {
    const callData = await encodeCallDataEpV07(await renewalCalls(options));
    assert.throws(() => validateSponsoredCalls(operation({ callData }), c), forbidden);
  });
}

test('#71 renewal rejects altered installation, hooks, IDs and canonical encodings', async () => {
  const calls = await renewalCalls();
  const first = calls[0];
  const second = calls[1];
  assert.ok(first && second);
  const decoded = decodeFunctionData({ abi: KernelV3_3AccountAbi, data: first.data });
  assert.equal(decoded.functionName, 'installValidations');
  if (decoded.functionName !== 'installValidations') assert.fail('fixture is not installValidations');
  const [ids, configs, enable, hook] = decoded.args;
  const data = enable[0];
  const id = ids[0];
  assert.ok(data && id);
  const malformed: Hex[] = [
    encodeFunctionData({ abi: KernelV3_3AccountAbi, functionName: 'installValidations', args: [ids, [{ nonce: 0, hook: zeroAddress }], enable, hook] }),
    encodeFunctionData({ abi: KernelV3_3AccountAbi, functionName: 'installValidations', args: [ids, [{ nonce: 1, hook: asset }], enable, hook] }),
    encodeFunctionData({ abi: KernelV3_3AccountAbi, functionName: 'installValidations', args: [ids, configs, enable, ['0x01']] }),
    encodeFunctionData({ abi: KernelV3_3AccountAbi, functionName: 'installValidations', args: [[toHex(0n, { size: 21 })], configs, enable, hook] }),
    encodeFunctionData({ abi: KernelV3_3AccountAbi, functionName: 'installValidations', args: [[id, id], configs, enable, hook] }),
    encodeFunctionData({ abi: KernelV3_3AccountAbi, functionName: 'installValidations', args: [ids, configs, [concatHex([data, '0x00'])], hook] }),
    concatHex([first.data, '0x00']), slice(first.data, 0, 10),
  ];
  for (const install of malformed) {
    const callData = await encodeCallDataEpV07([call(install, SENDER), second]);
    assert.throws(() => validateSponsoredCalls(operation({ callData }), c), forbidden);
  }
  const invalidPairs = [[first], [second], [second, first], [first, first], [first, { ...second, to: asset }],
    [{ ...first, to: asset }, second], [first, { ...second, value: 1n }], [first, { ...second, data: concatHex([second.data, '0x00']) }]];
  for (const pair of invalidPairs) {
    const callData = await encodeCallDataEpV07(pair);
    assert.throws(() => validateSponsoredCalls(operation({ callData }), c), forbidden);
  }
  const nested = decodeFunctionData({ abi: KERNEL_EXECUTE_ABI, data: second.data });
  for (const mode of [toHex(0n, { size: 32 }), toHex(BigInt(nested.args[0]) + 1n, { size: 32 })]) {
    const altered = encodeFunctionData({ abi: KERNEL_EXECUTE_ABI, functionName: 'execute', args: [mode, nested.args[1]] });
    const callData = await encodeCallDataEpV07([first, call(altered, SENDER)]);
    assert.throws(() => validateSponsoredCalls(operation({ callData }), c), forbidden);
  }
  const grant = decodeFunctionData({ abi: KernelV3_3AccountAbi, data: slice(nested.args[1], 20) });
  if (grant.functionName !== 'grantAccess') assert.fail('fixture is not grantAccess');
  const badGrants = [
    encodeFunctionData({ abi: KernelV3_3AccountAbi, functionName: 'grantAccess', args: [grant.args[0], grant.args[1], false] }),
    encodeFunctionData({ abi: KernelV3_3AccountAbi, functionName: 'grantAccess', args: [grant.args[0], '0xa9059cbb', true] }),
    encodeFunctionData({ abi: KernelV3_3AccountAbi, functionName: 'grantAccess', args: [toHex(0n, { size: 21 }), grant.args[1], true] }),
  ];
  for (const bad of [...badGrants.map((data) => concatHex([C.kernelImplV33, data])), concatHex([asset, slice(nested.args[1], 20)])]) {
    const altered = encodeFunctionData({ abi: KERNEL_EXECUTE_ABI, functionName: 'execute', args: [nested.args[0], bad] });
    const callData = await encodeCallDataEpV07([first, call(altered, SENDER)]);
    assert.throws(() => validateSponsoredCalls(operation({ callData }), c), forbidden);
  }
});

test('#71 wrappers: hooks preserve checks; outer delegatecall and extended modes stay forbidden', async () => {
  for (const calls of [[call(approve())], [call(transfer())], await renewalCalls()]) {
    await service().sponsor({ userOperation: operation({ callData: await encodeCallDataEpV07(calls, 'call', true) }) }, OWNER);
    const delegate = await encodeCallDataEpV07([calls[0] ?? call(approve())], 'delegatecall');
    assert.throws(() => validateSponsoredCalls(operation({ callData: delegate }), c), forbidden);
    const canonical = decodeFunctionData({ abi: KERNEL_EXECUTE_ABI, data: await encodeCallDataEpV07(calls) });
    const extended = encodeFunctionData({ abi: KERNEL_EXECUTE_ABI, functionName: 'execute', args: [toHex(BigInt(canonical.args[0]) + 1n, { size: 32 }), canonical.args[1]] });
    assert.throws(() => validateSponsoredCalls(operation({ callData: extended }), c), forbidden);
  }
});

test('#71 DB owner binding and dependency failures block all three new sponsorship classes before reservation', async () => {
  for (const calls of [[call(approve())], [call(transfer())], await renewalCalls()]) {
    const input = { userOperation: operation({ callData: await encodeCallDataEpV07(calls) }) };
    for (const phase of ['owner', 'user', 'missing', 'db', 'db-timeout', 'rpc', 'rpc-timeout']) {
      let reserved = false;
      const deps: PaymasterDeps = { config: { ...c, timeoutMs: 5 },
        query: phase === 'db-timeout' ? () => new Promise<{ rows: unknown[] }>(() => {}) : async () => {
          if (phase === 'db') throw new Error('sensitive-db');
          return { rows: phase === 'missing' ? [] : [{ owner: phase === 'owner' ? SENDER : OWNER, user_id: phase === 'user' ? SENDER : OWNER }] };
        },
        checkChain: phase === 'rpc-timeout' ? () => new Promise<void>(() => {}) : async () => { if (phase === 'rpc') throw new Error('sensitive-rpc'); },
        reserve: async () => { reserved = true; } };
      await assert.rejects(service(deps).sponsor(input, OWNER), (error: unknown) => error instanceof AppError &&
        error.code === (['owner', 'user', 'missing'].includes(phase) ? 'PAYMASTER_SENDER_FORBIDDEN' : 'PAYMASTER_DEPENDENCY_UNAVAILABLE'));
      assert.equal(reserved, false);
    }
  }
});

test('#71 local forks require the enabled address book; empty, malformed, failed or timed out lookups fail closed', async () => {
  for (const phase of ['healthy', 'empty', 'malformed', 'failure', 'timeout']) {
    let reserved = false;
    const local = service({ config: { ...config(), timeoutMs: 5 },
      query: async (sql) => {
        if (!sql.includes('priceable_assets')) return { rows: [{ owner: OWNER, user_id: OWNER }] };
        assert.equal(sql, 'select address from priceable_assets where enabled');
        if (phase === 'failure') throw new Error('sensitive-asset-db');
        if (phase === 'timeout') return new Promise<{ rows: unknown[] }>(() => {});
        return { rows: phase === 'empty' ? [] : [{ address: phase === 'malformed' ? 'invalid' : asset }] };
      }, reserve: async () => { reserved = true; } });
    const input = { userOperation: operation({ callData: await encodeCallDataEpV07([call(encodeFunctionData({ abi: erc20Abi,
      functionName: 'approve', args: [config().executor, max] }))]) }) };
    if (phase === 'healthy') await local.sponsor(input, OWNER);
    else await assert.rejects(local.sponsor(input, OWNER), (error: unknown) => error instanceof AppError &&
      error.code === (phase === 'empty' ? 'PAYMASTER_CALL_FORBIDDEN' : 'PAYMASTER_DEPENDENCY_UNAVAILABLE'));
    assert.equal(reserved, phase === 'healthy');
  }
});
