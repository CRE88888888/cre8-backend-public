import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { zeroHash } from 'viem';
import { query, withTransaction } from '../../src/db.js';
import { reserveFaucetClaim, settleFaucetClaim } from '../../src/faucet.js';
import { reserveWelcomeGrant, settleWelcomeGrant } from '../../src/welcome-grants.js';
import { WELCOME_AMOUNT_WEI } from '../../src/config.js';
import { validateAssetConfig } from '../../src/strategy-execution.js';
import { validateAllocation } from '../../src/strategies.js';
import { mixSettings } from '../../src/mix-domain.js';
import { TESTNET_97 as T } from '../../src/testnet-profile.js';
import { relayerSigner, signedFundingTx } from './relayer.js';
import { registrationRpc, signedMixRegistration } from './mix-registration.js';
import { foreignNonceRpc } from './mix-publication-nonce.js';

export async function foreignRpc(nonce: number) {
  const base = registrationRpc(); base.state.mode = 'missing';
  const raw = await relayerSigner.signTransaction({ chainId: 97, type: 'eip1559', nonce, gas: 21000n,
    maxFeePerGas: 3n, maxPriorityFeePerGas: 1n, to: relayerSigner.address, value: 1n });
  const rpc = foreignNonceRpc(base, raw);
  rpc.foreignState.head = 17n;
  return rpc;
}
export async function pendingFunding(kind: 'welcome' | 'faucet', nonce = 0) {
  const owner = T.roles.keeper, account = T.roles.operator;
  const signed = await signedFundingTx(kind, account, kind === 'welcome' ? WELCOME_AMOUNT_WEI : 10n ** 18n, { nonce });
  if (kind === 'faucet') {
    const claim = await reserveFaucetClaim({ config: { chainId: 97, amountWei: 10n ** 18n, siteDailyWei: 10n ** 30n, timeoutMs: 5000 }, owner, account });
    await settleFaucetClaim(claim, 'reserved', 'submitted', signed.hash, withTransaction, signed);
    return { kind, source: claim, signed };
  }
  const allocation = validateAllocation({ assets: [{ address: T.assets.NVDAB.token, weightBps: 10000 }] }, 97);
  const s = (await query<{ id: string }>("insert into strategies(provider,name) values($1,'nonce recovery') returning id", [owner])).rows[0]; assert.ok(s);
  await query(`insert into strategy_versions(strategy_id,version,allocation,schedule,active_at,execution_schema_version,execution,execution_chain_id,config_hash)
    values($1,1,$2,'{"kind":"funding"}','2026-01-01Z',2,$3,97,$4)`, [s.id, JSON.stringify(allocation), JSON.stringify(validateAssetConfig(undefined, allocation, 97)), zeroHash]);
  const p = (await query<{ id: string }>("insert into portfolios(user_id,strategy_id,version,schedule_state) values($1,$2,1,'active') returning id", [owner, s.id])).rows[0]; assert.ok(p);
  await query("insert into smart_accounts(portfolio_id,chain_id,address,owner,account_type) values($1,97,$2,$3,'KERNEL')", [p.id, account, owner]);
  const { grant } = await reserveWelcomeGrant({ chainId: 97, owner, account, portfolioId: Number(p.id) }, { chainId: 97, siteDailyWei: 10n ** 30n, timeoutMs: 5000 });
  await settleWelcomeGrant(grant, 'submitted', signed.hash, undefined, withTransaction, signed);
  return { kind, source: grant, signed };
}
export async function pendingRegistration(nonce = 0) {
  const r = (await query<{ id: string }>(`insert into mix_creation_requests(owner,chain_id,request_key,request_hash,settings)
    values($1,97,$2,$3,$4) returning id`, [T.roles.keeper, randomUUID(), zeroHash,
      JSON.stringify(mixSettings({ assets: [{ assetId: T.assets.NVDAB.token, weightBps: 10000 }] }))])).rows[0]; assert.ok(r);
  const signed = await signedMixRegistration({ nonce });
  await withTransaction(async db => {
    await db.query('insert into mix_registration_outbox(request_id,chain_id,tx_hash,signed_raw_tx) values($1,97,$2,$3)', [r.id, signed.hash, signed.raw]);
    await db.query("update mix_creation_requests set state='submitted',registration_tx_hash=$2 where id=$1", [r.id, signed.hash]);
  });
  return { id: r.id, signed };
}
