import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// tst 2026-11-21：scheduler 刻意不放 OPERATOR_PRIVATE_KEY，但私人組合對帳只讀鏈，
// getChain() 卻一律要求金鑰，組合每輪都被擋。現在只有用到 account／wallet 才要金鑰。
// getConfig() 是整個 process 快取，所以在子行程裡用乾淨的 env 跑。

const script = `
const { getChain } = await import(${JSON.stringify(new URL('../src/chain.ts', import.meta.url).pathname)});
const chain = getChain();
const out = { registry: chain.registryAddress, hasPublic: typeof chain.publicClient.readContract === 'function' };
try { chain.account; out.account = 'no error'; } catch (e) { out.account = e.message; }
try { chain.wallet; out.wallet = 'no error'; } catch (e) { out.wallet = e.message; }
console.log(JSON.stringify(out));
`;

function run(env: Record<string, string>) {
  const result = spawnSync(process.execPath, ['-e', script], {
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', DATABASE_URL: 'postgres://ci:ci@127.0.0.1:1/unused', CHAIN_ID: '1337',
      RPC_URL: 'http://127.0.0.1:1', REGISTRY_ADDRESS: '0x1111111111111111111111111111111111111111', ...env },
    cwd: '/',
  });
  assert.equal(result.status, 0, String(result.stderr));
  return JSON.parse(String(result.stdout).trim().split('\n').at(-1)!) as Record<string, unknown>;
}

test('without OPERATOR_PRIVATE_KEY the read-only parts work and only account/wallet throw', () => {
  const out = run({});
  assert.equal(out.registry, '0x1111111111111111111111111111111111111111');
  assert.equal(out.hasPublic, true);
  assert.equal(out.account, 'chain is not configured: OPERATOR_PRIVATE_KEY is required for on-chain operations');
  assert.equal(out.wallet, 'chain is not configured: OPERATOR_PRIVATE_KEY is required for on-chain operations');
});

test('with OPERATOR_PRIVATE_KEY account and wallet are available as before', () => {
  // anvil 公開測試金鑰 #0（只用在本機），不是任何真金鑰。
  const out = run({ OPERATOR_PRIVATE_KEY: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' });
  assert.equal(out.account, 'no error');
  assert.equal(out.wallet, 'no error');
});
