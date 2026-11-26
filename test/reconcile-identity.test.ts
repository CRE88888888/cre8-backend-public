import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Address } from 'viem';
import { reconcileIdentity } from '../src/relayer-reconciliation.js';
import type { ChainConfig } from '../src/chain.js';
import { TESTNET_97 } from '../src/testnet-profile.js';

// 2026-11-23: every scheduler round logged `OPERATOR_PRIVATE_KEY is required` for strategy 54 — the scheduler has
// only OPERATOR_ADDRESS by design, but publication reconcile called getChain() and read its signing account.
const signer = '0x00000000000000000000000000000000000000aa' as Address;
const signing = () => ({ account: { address: signer } }) as unknown as ChainConfig;

test('without a key the scheduler reconciles read-only with the public operator and never builds a signing chain', () => {
  let built = 0;
  const id = reconcileIdentity({}, { OPERATOR_ADDRESS: TESTNET_97.roles.operator }, () => { built++; return signing(); });
  assert.equal(id.chain, undefined);
  assert.equal(id.operator.toLowerCase(), TESTNET_97.roles.operator.toLowerCase());
  assert.equal(built, 0);
  assert.equal(reconcileIdentity({}, {}, () => { built++; return signing(); }).operator.toLowerCase(), TESTNET_97.roles.operator.toLowerCase());
  assert.equal(built, 0);
});

test('only a process with OPERATOR_PRIVATE_KEY gets a signing chain; a wrong OPERATOR_ADDRESS is refused', () => {
  const api = reconcileIdentity({}, { OPERATOR_PRIVATE_KEY: '0x01' }, signing);
  assert.ok(api.chain); assert.equal(api.operator, signer);
  assert.equal(reconcileIdentity({ client: {} as never }, { OPERATOR_PRIVATE_KEY: '0x01' }, signing).chain, undefined, 'an injected client stays read-only');
  assert.throws(() => reconcileIdentity({}, { OPERATOR_ADDRESS: '0x00000000000000000000000000000000000000bb' }, signing), /profile operator/);
  assert.equal(reconcileIdentity({ operator: signer }, {}, signing).operator, signer);
});
