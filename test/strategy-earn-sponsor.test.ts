import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicClient, custom, encodeFunctionData, erc20Abi, maxUint256 } from 'viem';
import type { Address, Hex } from 'viem';
import { bscTestnet } from 'viem/chains';
import { encodeCallDataEpV07 } from '@zerodev/sdk';
import { AppError } from '../src/errors.js';
import { createPaymasterService, MAX_SPONSORED_CALLS, validateSponsoredCalls } from '../src/paymaster.js';
import { buildSessionPermissions } from '../src/permissions.js';
import { closeCalls, consentCalls, openCalls, strategyMarkets } from '../src/strategy-earn.js';
import { STRATEGY_EARN_97 as S } from '../src/strategy-earn-guard.js';
import { TESTNET_97 as T } from '../src/testnet-profile.js';
import { config, NOW, operation, OWNER, SENDER, TEST_SIGNER } from './fixtures/paymaster.js';

/**
 * Portfolio 8: a buy with Strategy Earn on sent buy calls + the /renewal-params initConfig + /strategy-earn/auto
 * consent calls in one UserOp, and POST /paymaster/sponsor answered 403. The renewal on chain 97 installs yield AND
 * Strategy Earn permissions (src/renewal.ts, backend#204), but the paymaster only recognised the plain and
 * yield-only renewals; a many-asset consent set also exceeded the fixed 32-call batch bound.
 */
const c = config({ CHAIN_ID: '97', RPC_URL: 'http://127.0.0.1:8558', PAYMASTER_SIGNER_PRIVATE_KEY: TEST_SIGNER });
const account = SENDER.toLowerCase() as Address;
const markets = strategyMarkets();
const offline = createPublicClient({ chain: bscTestnet, transport: custom({ request: async () => { throw new Error('no rpc in this test'); } }) });
type Call = { to: Address; data: Hex; value: bigint };
const asCall = (x: { to: Address; data: Hex }): Call => ({ to: x.to, data: x.data, value: 0n });
const forbidden = (error: unknown) => error instanceof AppError && error.code === 'PAYMASTER_CALL_FORBIDDEN';
const reasonOf = (error: unknown) => error instanceof AppError && error.cause instanceof Error ? error.cause.message : '';

async function renewal(scope: { yieldAccount?: Address; borrowAccount?: Address } = { yieldAccount: account, borrowAccount: account }): Promise<Call[]> {
  const session = await buildSessionPermissions({ publicClient: offline as never, sessionKeyAddress: '0x2000000000000000000000000000000000000002',
    executorAddress: T.contracts.executor as Address, validUntil: NOW + 30 * 86400, ...scope });
  return session.initConfig.map((data) => ({ to: SENDER as Address, data: data as Hex, value: 0n }));
}
const buy = (): Call[] => [{ to: T.contracts.usdt as Address, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [T.contracts.executor as Address, maxUint256] }) }];
const op = async (calls: Call[]) => operation({ callData: await encodeCallDataEpV07(calls) });

const sponsored = async (calls: Call[]) => { validateSponsoredCalls(await op(calls), c); };

test('portfolio 8: buy + yield/Strategy Earn renewal + /auto consent calls in one UserOp are sponsored', async () => {
  const consent = consentCalls(markets.slice(0, 6).map((market) => ({ market, maxDebtRaw: 10n ** 21n }))).map(asCall);
  await sponsored([...buy(), ...await renewal(), ...consent]);
  // Every market at once (the largest /auto answer) still fits the batch bound.
  const all = [...buy(), ...await renewal(), ...consentCalls(markets.map((market) => ({ market, maxDebtRaw: 1n }))).map(asCall)];
  assert.ok(all.length > 32 && all.length <= MAX_SPONSORED_CALLS, `${all.length} calls`);
  await sponsored(all);
  // /open and /close call sets, and the older plain / yield-only renewals, stay sponsored.
  const deadline = BigInt(NOW + 600);
  await sponsored(openCalls(markets[0]!, account, 10n ** 18n, 10n ** 17n, 10n ** 18n, deadline).map(asCall));
  await sponsored(closeCalls(markets[3]!, account, deadline).map(asCall));
  await sponsored([...buy(), ...await renewal({})]);
  await sponsored([...buy(), ...await renewal({ yieldAccount: account })]);
});

test('a foreign spender, a foreign target or a renewal for another account is still rejected, with the reason logged', async () => {
  const stranger = '0x3000000000000000000000000000000000000003' as Address;
  const base = [...buy(), ...await renewal()];
  const cases: [string, Call[], RegExp][] = [
    ['collateral approved to a stranger', [...base, { to: markets[0]!.collateral, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [stranger, maxUint256] }) }], /invalid spender/],
    ['strategy vault approved to AtpExecutor', [...base, { to: S.earnVault as Address, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [T.contracts.executor as Address, maxUint256] }) }], /strategy vault approval/],
    ['delegate on a foreign comptroller', [...base, { ...asCall(consentCalls([{ market: markets[0]!, maxDebtRaw: 1n }])[0]!), to: stranger }], /unknown target/],
    ['Strategy Earn renewal pinned to another account', [...buy(), ...await renewal({ yieldAccount: stranger, borrowAccount: stranger })], /renewal matches no allowed session scope/],
  ];
  for (const [name, calls, reason] of cases) {
    let caught: unknown;
    try { validateSponsoredCalls(await op(calls), c); } catch (error) { caught = error; }
    assert.ok(forbidden(caught), name);
    assert.match(reasonOf(caught), reason, name);
    assert.match(reasonOf(caught), /^call \d+\/\d+ to 0x[0-9a-fA-F]{40} 0x[0-9a-f]{8}: /, name);
  }
});

test('every 403 from /paymaster/sponsor logs its code and reason', async () => {
  const lines: string[] = [];
  const warn = console.warn;
  console.warn = (line: unknown) => { lines.push(String(line)); };
  try {
    const service = createPaymasterService({ readBudgetContext: async () => ({ purpose: 'ordinary', nativePrice: 60000000000n, priceSource: 'fixture:oracle' }),
      config: c, now: () => NOW, query: async () => ({ rows: [{ owner: OWNER, user_id: OWNER }] }), checkChain: async () => {}, reserve: async () => {} });
    const stranger = '0x3000000000000000000000000000000000000003' as Address;
    const bad = [{ to: T.contracts.usdt as Address, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [stranger, 1n] }) }];
    await assert.rejects(service.sponsor({ userOperation: await op(bad) }, OWNER), forbidden);
  } finally { console.warn = warn; }
  const line = JSON.parse(lines.find((l) => l.includes('paymaster_rejected')) ?? '{}') as { code?: string; status?: number; reason?: string };
  assert.equal(line.code, 'PAYMASTER_CALL_FORBIDDEN');
  assert.equal(line.status, 403);
  assert.match(line.reason ?? '', /call 0\/1 .*invalid spender/);
});
