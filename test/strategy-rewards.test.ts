import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, erc20Abi } from 'viem';
import type { Address, Hex, Log } from 'viem';
import { claimCalls, fetchListaProofs, parseRewardSignature, REWARD_MESSAGE, REWARDS, REWARDS_ABI, REWARD_TOKENS, resetRewardsRoundClock, rewardEvents, rewardExitCalls,
  runStrategyRewardsRound, signatureUsable, sponsoredRewardTokens, strategyRewardsEnabled } from '../src/strategy-rewards.js';
import type { Claimable, RewardEvent, RewardsStore, RewardSignature } from '../src/strategy-rewards.js';
import { createStrategyEarn } from '../src/strategy-earn.js';
import { AppError } from '../src/errors.js';

const NOW = new Date('2026-11-24T12:00:00.000Z');
const account = '0x1000000000000000000000000000000000000005' as Address, box = '0x1000000000000000000000000000000000000b0c' as Address;
const owner = '0x2000000000000000000000000000000000000002' as Address, stranger = '0x3000000000000000000000000000000000000003' as Address;
const OTHER = '0x4000000000000000000000000000000000000004' as Address; // a second token paid by the multi distributor
const proof = ['0x' + '11'.repeat(32), '0x' + '22'.repeat(32)] as Hex[];
const sig: RewardSignature = { message: REWARD_MESSAGE(NOW.toISOString()), signature: ('0x' + 'ab'.repeat(65)) as Hex, signedAt: NOW };
const E = 10n ** 18n;
const transferLog = (token: Address, from: Address, to: Address, value: bigint, logIndex: number): Log =>
  ({ address: token, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } }), data: encodeAbiParameters([{ type: 'uint256' }], [value]), logIndex } as unknown as Log);

/** api.lista.org shapes read from Lista's own frontend (2026-11-24): userProof -> { amountWei, proof }, userMultiProof -> [{ token, tokenSymbol, amountWei, proof }]. */
function listaApi(by: Record<string, { one?: bigint; multi?: bigint }>, seen: string[] = []) {
  return async (url: string) => {
    seen.push(url);
    const u = new URL(url), who = u.searchParams.get('address')!;
    assert.equal(u.searchParams.get('type'), 'safe'); assert.equal(u.searchParams.get('message'), sig.message); assert.equal(u.searchParams.get('signature'), sig.signature);
    const d = by[who] ?? {};
    if (url.includes('userMultiProof')) return new Response(JSON.stringify({ code: '000000', data: d.multi ? [{ token: OTHER, tokenSymbol: 'slisBNB', amountWei: d.multi.toString(), proof }] : [] }));
    return new Response(JSON.stringify({ code: '000000', data: d.one ? { amountWei: d.one.toString(), proof } : null }));
  };
}
function memoryStore(signed = [{ portfolioId: 7, account, owner, sig }]) {
  const pending = new Map<string, { total: bigint; claimed: bigint }>(), events: RewardEvent[] = [];
  const store = { signed: async () => signed, saveSignature: async () => {}, view: async () => ({ tokens: [], signature: { needed: true, signedAt: null } }),
    savePending: async (_c: number, _p: number, _a: Address, c: Pick<Claimable, 'holder' | 'source' | 'token'> & { totalRaw: bigint }, claimed: bigint) => { pending.set(`${c.holder}:${c.source}:${c.token}`, { total: c.totalRaw, claimed }); },
    record: async (_c: number, e: readonly RewardEvent[]) => { events.push(...e); } } as unknown as RewardsStore;
  return { store, pending, events };
}

test('off by default and never on testnet: no round, no sponsored reward transfer', async () => {
  assert.equal(strategyRewardsEnabled(97, { STRATEGY_REWARDS_ENABLED: '1' }), false);
  assert.equal(strategyRewardsEnabled(56, {}), false);
  assert.equal(strategyRewardsEnabled(56, { STRATEGY_REWARDS_ENABLED: '1' }), true);
  assert.deepEqual(sponsoredRewardTokens(97, { STRATEGY_REWARDS_ENABLED: '1' }), []);
  assert.deepEqual(sponsoredRewardTokens(56, { STRATEGY_REWARDS_ENABLED: '1' }), [REWARDS.LISTA, REWARDS.XVS]);
  const none = () => { throw new Error('must not be touched'); };
  for (const [chainId, env] of [[97, { STRATEGY_REWARDS_ENABLED: '1' }], [56, {}]] as const) {
    assert.equal(await runStrategyRewardsRound({ dryRun: false, log: none, force: true }, { chainId, env, fetch: none, store: new Proxy({}, { get: none }) as never }), null);
  }
});

test('signature: the exact message Lista checks, current datetime only, usable for 7 days', () => {
  assert.equal(REWARD_MESSAGE('2026-11-24T12:00:00.000Z'), '2026-11-24T12:00:00.000Z\nThank you for your support of listaDAO.');
  const ok = parseRewardSignature({ signedAt: NOW.toISOString(), signature: '0x' + 'AB'.repeat(65) }, NOW);
  assert.deepEqual([ok.message, ok.signature], [sig.message, sig.signature]);
  // Kernel wraps the ECDSA signature with its validator id: longer than 65 bytes is fine.
  assert.ok(parseRewardSignature({ signedAt: NOW.toISOString(), signature: '0x' + 'ab'.repeat(86) }, NOW));
  const bad = (input: unknown) => assert.throws(() => parseRewardSignature(input, NOW), (e: unknown) => e instanceof AppError && e.status === 400);
  bad({}); bad({ signedAt: '2026-11-24 12:00', signature: sig.signature }); bad({ signedAt: NOW.toISOString(), signature: '0x12' });
  bad({ signedAt: new Date(NOW.getTime() - 11 * 60_000).toISOString(), signature: sig.signature }); // pre-dated
  bad({ signedAt: new Date(NOW.getTime() + 11 * 60_000).toISOString(), signature: sig.signature }); // post-dated: cannot stretch the 7 days
  assert.equal(signatureUsable(NOW, new Date(NOW.getTime() + 7 * 86_400_000 - 1)), true);
  assert.equal(signatureUsable(NOW, new Date(NOW.getTime() + 7 * 86_400_000)), false);
});

test('proofs: both distributors, for the address asked about; empty and zero entries drop out; a refusal is an error', async () => {
  const claims = await fetchListaProofs(listaApi({ [account]: { one: 5n * E, multi: 2n * E } }) as never, account, sig);
  assert.deepEqual(claims.map(c => [c.source, c.holder, c.token, c.symbol, c.totalRaw, c.proof.length]),
    [['lista', account, REWARDS.LISTA, 'LISTA', 5n * E, 2], ['lista_multi', account, OTHER, 'slisBNB', 2n * E, 2]]);
  assert.deepEqual(await fetchListaProofs(listaApi({}) as never, account, sig), []);
  await assert.rejects(fetchListaProofs((async () => new Response(JSON.stringify({ code: '1005', msg: 'Invalid signature' }))) as never, account, sig), /Invalid signature/);
  await assert.rejects(fetchListaProofs((async () => new Response('x', { status: 502 })) as never, account, sig), /HTTP 502/);
  await assert.rejects(fetchListaProofs((async () => new Response(JSON.stringify({ code: '000000', data: { amountWei: '5', proof: ['0x12'] } }))) as never, account, sig), /bad proof/);
});

test('claim transactions: claim(account, total, proof) per LISTA claim, one batchClaim for the rest, claimVenus per holder', () => {
  const claims: Claimable[] = [{ source: 'lista', holder: account, token: REWARDS.LISTA as Address, symbol: 'LISTA', totalRaw: 5n * E, proof },
    { source: 'lista_multi', holder: account, token: OTHER, symbol: 'slisBNB', totalRaw: 2n * E, proof }, { source: 'lista_multi', holder: box, token: OTHER, symbol: 'slisBNB', totalRaw: 3n * E, proof }];
  const calls = claimCalls(claims, [account]);
  assert.deepEqual(calls.map(c => c.to), [REWARDS.LISTA_DISTRIBUTOR, REWARDS.LISTA_MULTI_DISTRIBUTOR, REWARDS.VENUS_COMPTROLLER]);
  assert.deepEqual(decodeFunctionData({ abi: REWARDS_ABI, data: calls[0]!.data }).args, [account, 5n * E, proof].map(x => typeof x === 'string' ? x : x));
  const batch = decodeFunctionData({ abi: REWARDS_ABI, data: calls[1]!.data });
  assert.equal(batch.functionName, 'batchClaim');
  assert.deepEqual((batch.args as readonly unknown[]).slice(0, 3).map(a => (a as unknown[]).map(x => typeof x === 'string' ? x.toLowerCase() : x)), [[account, box], [OTHER, OTHER], [2n * E, 3n * E]]);
  assert.deepEqual(decodeFunctionData({ abi: REWARDS_ABI, data: calls[2]!.data }), { functionName: 'claimVenus', args: [account] });
  assert.deepEqual(claimCalls([]), []);
});

test('exit: reward tokens go to the owner wallet as they are, one plain transfer per token with a balance', () => {
  const calls = rewardExitCalls([{ token: REWARDS.LISTA as Address, balanceRaw: 7n * E }, { token: REWARDS.XVS as Address, balanceRaw: 0n }], owner);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.to, REWARDS.LISTA);
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: calls[0]!.data }), { functionName: 'transfer', args: [owner, 7n * E] });
});

test('ledger rows come from the token Transfer logs: claim = paid to a holder, sweep = account to its owner; nothing else counts', () => {
  const lista = REWARDS.LISTA as Address, xvs = REWARDS.XVS as Address;
  const tx = { hash: ('0x' + 'aa'.repeat(32)) as Hex, blockNumber: 9n, logs: [
    transferLog(lista, REWARDS.LISTA_DISTRIBUTOR as Address, account, 5n * E, 0), transferLog(lista, REWARDS.LISTA_MULTI_DISTRIBUTOR as Address, box, 2n * E, 1),
    transferLog(xvs, REWARDS.VENUS_COMPTROLLER as Address, account, E, 2), transferLog(lista, REWARDS.LISTA_DISTRIBUTOR as Address, stranger, 9n * E, 3), // someone else's claim in the same tx
    transferLog(OTHER, stranger, account, 4n * E, 4), // not a reward token
    transferLog(lista, account, owner, 7n * E, 5), transferLog(lista, account, stranger, E, 6), transferLog(lista, box, account, 2n * E, 7)] };
  const events = rewardEvents(tx, { portfolioId: 7, account, holders: [account, box], owner, tokens: REWARD_TOKENS });
  assert.deepEqual(events.map(e => [e.kind, e.source, e.holder, e.symbol, e.amountRaw, e.recipient, e.logIndex]), [
    ['claim', 'lista', account, 'LISTA', 5n * E, null, 0], ['claim', 'lista_multi', box, 'LISTA', 2n * E, null, 1], ['claim', 'venus', account, 'XVS', E, null, 2],
    ['sweep', null, account, 'LISTA', 7n * E, owner, 5]]); // box -> account is an internal move: balance unchanged
});

test('round: stores pending for the account and its box, claims only what is worth it, writes the ledger from the receipt', async () => {
  resetRewardsRoundClock();
  const m = memoryStore(), seen: string[] = [], sent: { to: Address; data: Hex }[] = [], lines: string[] = [];
  const claimedOnChain: Record<string, bigint> = { [`lista:${account}`]: 1n * E, [`lista:${box}`]: 0n, [`lista_multi:${account}`]: 2n * E };
  const deps = { chainId: 56, env: { STRATEGY_REWARDS_ENABLED: '1' }, now: () => NOW, store: m.store,
    fetch: listaApi({ [account]: { one: 5n * E, multi: 2n * E }, [box]: { one: E / 100n } }, seen) as never,
    chain: { claimed: async (s: string, h: Address) => claimedOnChain[`${s}:${h}`] ?? 0n, venusAccrued: async () => 3n * E },
    extraHolders: async () => [box], venusHolders: async () => true,
    writer: { send: async (to: Address, data: Hex) => { sent.push({ to, data });
      const logs = to === REWARDS.LISTA_DISTRIBUTOR ? [transferLog(REWARDS.LISTA as Address, to, account, 4n * E, 0)] : [transferLog(REWARDS.XVS as Address, to, account, 3n * E, 0)];
      return { hash: ('0x' + (to === REWARDS.LISTA_DISTRIBUTOR ? 'a1' : 'b2').repeat(32)) as Hex, blockNumber: 1n, logs }; } } };
  const r = await runStrategyRewardsRound({ dryRun: false, log: l => lines.push(l) }, deps);
  // account LISTA 5 − 1 paid = 4 (claim); account multi 2 − 2 = 0; box LISTA 0.01 < 0.1 minimum (waits); XVS 3 (claim)
  assert.deepEqual(r, { accounts: 1, holders: 2, pending: 3, claimed: 2, failed: 0, writer: true });
  assert.deepEqual(sent.map(s => s.to), [REWARDS.LISTA_DISTRIBUTOR, REWARDS.VENUS_COMPTROLLER]);
  assert.deepEqual(m.events.map(e => [e.kind, e.source, e.symbol, e.amountRaw, e.portfolioId]), [['claim', 'lista', 'LISTA', 4n * E, 7], ['claim', 'venus', 'XVS', 3n * E, 7]]);
  assert.deepEqual(m.pending.get(`${account}:lista:${REWARDS.LISTA}`), { total: 5n * E, claimed: 5n * E }); // nothing pending after the claim
  assert.deepEqual(m.pending.get(`${box}:lista:${REWARDS.LISTA}`), { total: E / 100n, claimed: 0n });
  assert.equal(seen.length, 4); // 2 holders × 2 endpoints, nothing else
  assert.ok(lines.every(l => l.startsWith('[strategy-rewards] portfolio 7')));
  // Not due again within a day; a failing API marks the account failed and does not throw.
  assert.equal(await runStrategyRewardsRound({ dryRun: false, log: () => {} }, deps), null);
  const failed = await runStrategyRewardsRound({ dryRun: false, log: () => {}, force: true }, { ...deps, fetch: (async () => new Response('x', { status: 500 })) as never });
  assert.deepEqual([failed?.failed, failed?.claimed], [1, 0]);
});

test('round: dry run and a missing keeper key only refresh pending amounts — nothing is sent', async () => {
  for (const [dryRun, writer] of [[true, { send: async () => { throw new Error('must not send'); } }], [false, null]] as const) {
    resetRewardsRoundClock();
    const m = memoryStore(), lines: string[] = [];
    const r = await runStrategyRewardsRound({ dryRun, log: l => lines.push(l) }, { chainId: 56, env: { STRATEGY_REWARDS_ENABLED: '1' }, now: () => NOW, store: m.store,
      fetch: listaApi({ [account]: { one: 5n * E } }) as never, chain: { claimed: async () => 0n, venusAccrued: async () => 0n }, writer: writer as never });
    assert.deepEqual([r?.pending, r?.claimed, m.events.length], [1, 0, 0]);
    assert.deepEqual(m.pending.get(`${account}:lista:${REWARDS.LISTA}`), { total: 5n * E, claimed: 0n });
    assert.match(lines[0]!, dryRun ? /skipped \(dry run\)/ : /waiting for a keeper key/);
  }
});

test('API: GET rewards and POST reward-signature are 404 while the feature is off, owner-only on this chain when on', async () => {
  const saved: unknown[] = [];
  const store = { view: async () => ({ tokens: [{ token: REWARDS.LISTA, symbol: 'LISTA', balanceRaw: '4', pendingRaw: '1' }], signature: { needed: true, signedAt: null } }),
    saveSignature: async (...a: unknown[]) => { saved.push(a); } } as unknown as RewardsStore;
  const owned = (chainId: number) => (async () => ({ chainId, ownerAddress: owner, accountAddress: account })) as never;
  const base = { chain: () => { throw new Error('down'); }, now: () => NOW, rewards: store };
  const off = createStrategyEarn({ ...base, chainId: 97, owned: owned(97) });
  assert.equal('rewards' in await off.portfolio(7, owner), false);
  await assert.rejects(off.rewards(7, owner), (e: unknown) => e instanceof AppError && e.status === 404);
  await assert.rejects(off.rewardSignature(7, owner, { signedAt: NOW.toISOString(), signature: sig.signature }), (e: unknown) => e instanceof AppError && e.status === 404);
  const on = createStrategyEarn({ ...base, chainId: 56, rewardsEnabled: true, owned: owned(56) });
  await assert.rejects(on.rewards(7, stranger), (e: unknown) => e instanceof AppError && e.status === 403);
  await assert.rejects(createStrategyEarn({ ...base, chainId: 56, rewardsEnabled: true, owned: owned(97) }).rewards(7, owner), (e: unknown) => e instanceof AppError && e.status === 403);
  const view = await on.rewards(7, owner);
  assert.deepEqual(view.tokens, [{ token: REWARDS.LISTA, symbol: 'LISTA', balanceRaw: '4', pendingRaw: '1' }]);
  assert.deepEqual(await on.rewardSignature(7, owner, { signedAt: NOW.toISOString(), signature: sig.signature }), { status: 'saved', signedAt: NOW.toISOString() });
  assert.deepEqual((saved[0] as unknown[]).slice(0, 3), [56, 7, account]);
});
