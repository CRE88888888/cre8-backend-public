/** backend#204 fork acceptance (opt-in, not in CI): FORK_RPC_URL=http://127.0.0.1:<port> bun test ./test/strategy-earn-204.fork.ts --timeout=600000
 * Needs a local anvil fork of chain 97 (cre8-contracts#65 deployed). Uses impersonation only; never touches a public chain.
 * Account: cre8-contracts BorrowDemoAccount (enrolled in AtpRegistry, holds NVDAB). Each call is sent from the account itself,
 * exactly the calldata the owner's consent / the scheduler's session-key UserOp would carry.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicClient, createTestClient, createWalletClient, http, parseAbi, parseEther } from 'viem';
import type { Address, Hex, Log } from 'viem';
import { bscTestnet } from 'viem/chains';
import { mnemonicToAccount } from 'viem/accounts';
import { consentCalls, createStrategyEarnChain, runStrategyEarnRound, STRATEGY_EARN_97 as S, STRATEGY_EARN_ABI, strategyEarnAutoOpen,
  strategyEarnUnwindForSale, strategyMarkets } from '../src/strategy-earn.js';
import type { Call, StrategyEarnEvent, StrategyEarnTx } from '../src/strategy-earn.js';
import { readStrategyEarnCollateral } from '../src/snapshot.js';

const rpc = process.env.FORK_RPC_URL;
const A = '0x5683cf2f1e038e8c4444bf853a31dbf4c841bf54' as Address;
const ORACLE_OWNER = '0x09bbb9a06a0c49ad24bddb18808944041783054e' as Address;
const nvda = strategyMarkets()[0]!;

test('#204 fork: consent -> auto-open -> price drop -> keeper deleverage -> repay-first unwind before a sale', { skip: rpc ? false : 'FORK_RPC_URL not set' }, async () => {
  const transport = http(rpc, { timeout: 120_000 });
  const client = createPublicClient({ chain: bscTestnet, transport, pollingInterval: 100 });
  assert.equal(await client.getChainId(), 97);
  const local = createTestClient({ chain: bscTestnet, mode: 'anvil', transport });
  const chain = createStrategyEarnChain(client as never);
  for (const who of [A, ORACLE_OWNER]) { await local.impersonateAccount({ address: who }); await local.setBalance({ address: who, value: parseEther('1') }); }
  const asAccount = createWalletClient({ chain: bscTestnet, account: A, transport });
  const ledger: StrategyEarnEvent[] = [];
  const record = { record: async (_c: number, e: readonly StrategyEarnEvent[]) => { ledger.push(...e); } };
  // One "UserOp" = the calls in order from the account; logs re-indexed as if in one transaction.
  const send = async (calls: Call[]): Promise<StrategyEarnTx> => {
    const logs: Log[] = []; let last: Hex = '0x'; let block = 0n;
    for (const c of calls) {
      const hash = await asAccount.sendTransaction({ to: c.to, data: c.data, gas: 3_000_000n });
      const r = await client.waitForTransactionReceipt({ hash });
      assert.equal(r.status, 'success', `${c.to} ${c.data.slice(0, 10)}`);
      for (const l of r.logs) logs.push({ ...l, logIndex: logs.length });
      last = hash; block = r.blockNumber;
    }
    return { hash: last, blockNumber: block, logs };
  };
  const now = async () => new Date(Number((await client.getBlock()).timestamp) * 1000);
  const status = async () => chain.status(nvda.marketId, A, await client.getBlockNumber());

  // Start clean: any earlier position on this account is closed by the same unwind path.
  const held0 = await chain.balance(nvda.collateral, A, await client.getBlockNumber());
  assert.ok(held0 > 0n, 'demo account holds NVDAB');

  // 1. Owner consent (buy confirmation with Earn extra on): delegate + ceiling + approvals to AtpBorrowExecutor only.
  await send(consentCalls([{ market: nvda, maxDebtRaw: parseEther('1000') }]));
  const policy = await chain.policy(A, nvda.marketId, await client.getBlockNumber());
  assert.deepEqual(policy, { maxDebt: parseEther('1000'), enabled: true });

  // 2. Scheduler auto-open after the buy filled.
  const opened = await strategyEarnAutoOpen({ chain, account: A, portfolioId: 1, now: await now(), dryRun: false, send, ledger: record, log: () => {} });
  assert.match(opened ?? '', /已自動開啟：NVDAB/);
  let s = await status();
  const posted = await chain.collateral(nvda.marketId, A, await client.getBlockNumber());
  assert.equal(posted, held0);
  assert.ok(s.ltv > 29n * 10n ** 16n && s.ltv <= 30n * 10n ** 16n, `ltv ${s.ltv}`);
  assert.equal(await chain.balance(nvda.collateral, A, await client.getBlockNumber()), 0n);
  assert.deepEqual((await readStrategyEarnCollateral(client as never, A, await client.getBlockNumber())).map(c => [c.asset, c.amount]), [[nvda.collateral, posted]]);
  assert.equal(ledger.at(-1)?.kind, 'open'); assert.equal(ledger.at(-1)?.collateralRaw, posted); assert.equal(ledger.at(-1)?.amountRaw, s.debt);

  // 3. Price drop on the lending oracle -> keeper deleverages from the vault back to target.
  const price = await chain.price(nvda.collateral, await client.getBlockNumber());
  const oracle = createWalletClient({ chain: bscTestnet, account: ORACLE_OWNER, transport });
  await client.waitForTransactionReceipt({ hash: await oracle.writeContract({ address: S.lendingOracle, abi: parseAbi(['function setPrice(address,uint256)']),
    functionName: 'setPrice', args: [nvda.collateral, price * 70n / 100n] }) });
  s = await status();
  assert.equal(s.shouldDeleverage, true);
  const keeperKey = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 7 });
  await local.setBalance({ address: keeperKey.address, value: parseEther('1') });
  const keeper = createWalletClient({ chain: bscTestnet, account: keeperKey, transport });
  const writer = {
    deleverage: async (account: Address, id: Hex) => {
      const hash = await keeper.writeContract({ address: S.executor, abi: STRATEGY_EARN_ABI, functionName: 'executeDeleverage', args: [account, id], gas: 1_500_000n });
      const r = await client.waitForTransactionReceipt({ hash }); assert.equal(r.status, 'success');
      return { hash, blockNumber: r.blockNumber, logs: r.logs };
    },
    claim: async () => { throw new Error('no claim expected right after opening'); },
    claimLista: async () => { throw new Error('no claim expected'); },
  };
  const round = await runStrategyEarnRound({ dryRun: false, log: () => {} }, { chainId: 97, chain, writer, accounts: async () => [{ account: A, portfolioId: 1 }], ledger: record });
  assert.equal(round?.deleveraged, 1);
  s = await status();
  assert.ok(s.ltv <= 30n * 10n ** 16n + 10n ** 14n, `after deleverage ${s.ltv}`);
  assert.equal(ledger.at(-1)?.kind, 'deleverage');
  assert.ok((ledger.at(-1)?.ltvBeforeBps ?? 0) >= 4000 && (ledger.at(-1)?.ltvAfterBps ?? 0) <= 3001);

  // 4. A sale of the posted shares: repay first (vault), then take them back; the sale itself waits for the next round.
  const reason = await strategyEarnUnwindForSale({ chain, account: A, portfolioId: 1, now: await now(), dryRun: false, send, ledger: record, log: () => {},
    steps: [{ tokenIn: nvda.collateral, amountIn: posted }] });
  assert.match(reason ?? '', /^\[STRATEGY_EARN_UNWINDING\] 賣出前已還款取回：NVDAB 先還清再取回/);
  s = await status();
  assert.equal(s.debt, 0n);
  assert.equal(await chain.collateral(nvda.marketId, A, await client.getBlockNumber()), 0n);
  assert.equal(await chain.balance(nvda.collateral, A, await client.getBlockNumber()), held0);
  assert.equal(ledger.at(-1)?.kind, 'close'); assert.equal(ledger.at(-1)?.collateralRaw, held0);
  // Strategy vault shares never stay approved to AtpExecutor, and nothing is left in the vault for the account.
  console.log(JSON.stringify(ledger.map(e => ({ kind: e.kind, amount: e.amountRaw.toString(), collateral: e.collateralRaw.toString(), ltv: [e.ltvBeforeBps, e.ltvAfterBps] }))));
});

test('#204 fork: the deployed CallPolicy (0.0.4) enforces the borrow rules — account pinned, five markets, AtpBorrowExecutor only', { skip: rpc ? false : 'FORK_RPC_URL not set' }, async () => {
  const { toCallPolicy, CallPolicyVersion } = await import('@zerodev/permissions/policies');
  const { encodeCallDataEpV07 } = await import('@zerodev/sdk');
  const { sessionCallPermissions } = await import('../src/permissions.js');
  const { TESTNET_97: T } = await import('../src/testnet-profile.js');
  const { encodeFunctionData, concatHex, pad, maxUint256 } = await import('viem');
  const transport = http(rpc, { timeout: 120_000 });
  const client = createPublicClient({ chain: bscTestnet, transport, pollingInterval: 100 });
  const local = createTestClient({ chain: bscTestnet, mode: 'anvil', transport });
  const wallet = '0x' + '5a'.repeat(20) as Address; // any wallet: CallPolicy state is per (id, msg.sender)
  await local.impersonateAccount({ address: wallet }); await local.setBalance({ address: wallet, value: parseEther('1') });
  const policy = toCallPolicy({ policyAddress: T.contracts.callPolicy as Address, policyVersion: CallPolicyVersion.V0_0_4,
    permissions: sessionCallPermissions(T.contracts.executor as Address, wallet, wallet) });
  // Fresh id per run: CallPolicy refuses a second install for the same (id, wallet).
  const id = pad(`0x${Date.now().toString(16).slice(-8).padStart(8, '0')}`, { size: 32, dir: 'right' });
  const abi = parseAbi(['function onInstall(bytes data) payable',
    'struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }',
    'function checkUserOpPolicy(bytes32 id, PackedUserOperation userOp) payable returns (uint256)']);
  const w = createWalletClient({ chain: bscTestnet, account: wallet, transport });
  const r = await client.waitForTransactionReceipt({ hash: await w.writeContract({ address: T.contracts.callPolicy as Address, abi, functionName: 'onInstall',
    args: [concatHex([id, policy.getPolicyData()])], gas: 3_000_000n }) });
  assert.equal(r.status, 'success');
  const check = async (calls: { to: Address; data: Hex }[]) => {
    const callData = await encodeCallDataEpV07(calls.map(c => ({ to: c.to, data: c.data, value: 0n })));
    try {
      const { result } = await client.simulateContract({ account: wallet, address: T.contracts.callPolicy as Address, abi, functionName: 'checkUserOpPolicy',
        args: [id, { sender: wallet, nonce: 0n, initCode: '0x', callData, accountGasLimits: pad('0x', { size: 32 }), preVerificationGas: 0n, gasFees: pad('0x', { size: 32 }), paymasterAndData: '0x', signature: '0x' }] });
      return result === 0n ? 'ok' : 'denied';
    } catch { return 'denied'; }
  };
  const enc = (fn: string, args: readonly unknown[]) => encodeFunctionData({ abi: STRATEGY_EARN_ABI, functionName: fn as never, args: args as never });
  const supply = (acct: Address, market: Hex) => ({ to: S.executor as Address, data: enc('executeSupplyCollateral', [acct, market, 1n, 2n]) });
  const deadline = 2_000_000_000n;
  const markets = strategyMarkets();
  assert.equal(await check([supply(wallet, nvda.marketId), { to: S.executor, data: enc('executeBorrow', [wallet, nvda.marketId, 1n, deadline]) }]), 'ok');
  for (const m of markets) assert.equal(await check([supply(wallet, m.marketId)]), 'ok', m.symbol);
  assert.equal(await check([{ to: S.executor, data: enc('executeRepay', [wallet, markets[3]!.marketId, maxUint256, true, deadline]) },
    { to: S.executor, data: enc('executeWithdrawCollateral', [wallet, markets[3]!.marketId, maxUint256, deadline]) }]), 'ok');
  // Another account, an unknown market, the strategy vault market id, an approval, and AtpExecutor are all refused.
  assert.equal(await check([supply('0x' + '66'.repeat(20) as Address, nvda.marketId)]), 'denied');
  assert.equal(await check([supply(wallet, ('0x' + '77'.repeat(32)) as Hex)]), 'denied');
  assert.equal(await check([supply(wallet, S.earnVaultMarketId as Hex)]), 'denied');
  assert.equal(await check([{ to: S.earnVault as Address, data: enc('approve', [T.contracts.executor, maxUint256]) }]), 'denied');
  assert.equal(await check([{ to: S.executor, data: enc('setBorrowPolicy', [nvda.marketId, 1n, true]) }]), 'denied');
  assert.equal(await check([{ to: T.contracts.executor as Address, data: enc('executeSupplyCollateral', [wallet, nvda.marketId, 1n, deadline]) }]), 'denied');
});
