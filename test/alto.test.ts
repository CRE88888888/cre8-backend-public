import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve('.bun-cache'); mkdirSync(root, { recursive: true });
const bin = mkdtempSync(path.join(root, 'alto-test-'));
writeFileSync(path.join(bin, 'node'), `#!/usr/bin/env python3
import os, sys, json
args=sys.argv[1:]
def value(flag): return args[args.index(flag)+1]
assert value('--executor-private-keys') == os.environ['EXECUTOR_PRIVATE_KEY']
assert value('--utility-private-key') == os.environ.get('UTILITY_PRIVATE_KEY', os.environ['EXECUTOR_PRIVATE_KEY'])
print(json.dumps({'entrypoint':value('--entrypoints'),'safe':'--safe-mode' in args,'balance':value('--min-executor-balance'),'localRange':'--max-block-range' in args}))
`, { mode: 0o700 });
const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, RPC_URL: 'rpc-secret', EXECUTOR_PRIVATE_KEY: 'executor-secret' };

test('#69 alto 97 requires separate env keys, safe mode and EntryPoint v0.7; invalid settings do not echo secrets', () => {
  for (const override of [{}, { UTILITY_PRIVATE_KEY: env.EXECUTOR_PRIVATE_KEY }, { UTILITY_PRIVATE_KEY: 'utility-secret', SAFE_MODE: 'false' }, { UTILITY_PRIVATE_KEY: 'utility-secret', ENTRYPOINTS: 'entrypoint-secret' }]) {
    const result = spawnSync('sh', ['alto/entrypoint.sh'], { env: { ...env, CHAIN_ID: '97', ...override }, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /executor-secret|utility-secret|entrypoint-secret|rpc-secret/);
  }
});

test('#69 alto mainnet defaults preserved; 97 uses v0.7 and bounded logs with env threshold override', () => {
  for (const chain of ['56', '97']) {
    const output = execFileSync('sh', ['alto/entrypoint.sh'], { env: { ...env, CHAIN_ID: chain, ...(chain === '97' ? { UTILITY_PRIVATE_KEY: 'utility-secret' } : {}) }, encoding: 'utf8' });
    const flags: unknown = JSON.parse(output.trim().split('\n').at(-1) ?? 'null');
    assert.deepEqual(flags, { entrypoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032', safe: true, balance: chain === '97' ? '10000000000000000' : '50000000000000000', localRange: chain === '97' });
    assert.doesNotMatch(output, /executor-secret|utility-secret|rpc-secret/);
  }
  const output = execFileSync('sh', ['alto/entrypoint.sh'], { env: { ...env, CHAIN_ID: '97', UTILITY_PRIVATE_KEY: 'utility-secret', MIN_EXECUTOR_BALANCE: '0' }, encoding: 'utf8' });
  assert.match(output, /"balance": "0"/);
});
