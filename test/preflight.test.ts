// The existing CI entry point also runs chain 97 profile and alto configuration checks.
import './testnet-profile.test.js';
import './alto.test.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { mnemonicToAccount } from 'viem/accounts';
import { createPublicClient, custom, getAddress, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, zeroAddress } from 'viem';
import { EXECUTOR_ABI, PANCAKE_UR } from '../src/chain.js';
import type { Address } from 'viem';
import { checkSecondarySources, checkVenues, checkBuyConfig, checkGlobalPaused, checkOwnership, checkRegistryOperator, checkRoleSeparation, checkSessionKeySeed, operatorAddress } from '../scripts/preflight.js';
import { assertNoSecretSlices, runScript } from './fixtures/secret-output.js';

test('#56 scheduler startup describes configured endpoints without credentials', async () => {
  for (const rpc of ['https://bsc.example/v1/SECRETKEY', 'https://SECRETKEY.example/v1', 'malformed-SECRETKEY']) {
    const result = await runScript('scripts/scheduler.ts', { RPC_URL: rpc, BUNDLER_URL: 'https://user:password@bundler.example/SECRETKEY?token=SECRETKEY' }, `
      const { mock } = await import('bun:test');
      mock.module(${JSON.stringify(new URL('../src/scheduler.ts', import.meta.url).pathname)}, () => ({
        DEFAULT_ROUND_LIMIT: 25,
        runSchedulerOnce: async () => ({ claimed: 0, dryRun: true, results: [] }),
      }));
    `);
    assert.equal(result.code, 0);
    assert.match(result.output, /RPC\s+\(configured\)/);
    assert.match(result.output, /BUNDLER\s+\(configured\)/);
    assert.doesNotMatch(result.output, /SECRETKEY|password|https:\/\//);
  }
});

test('#56 alto startup logs no URL or key characters while forwarding the same CLI flags', async () => {
  await mkdir('.bun-cache', { recursive: true });
  const directory = await mkdtemp(join(process.cwd(), '.bun-cache/alto-log-'));
  try {
    await writeFile(join(directory, 'node'), `#!${process.execPath}
      const value = flag => process.argv[process.argv.indexOf(flag) + 1];
      console.log(JSON.stringify({
        rpc: value('--rpc-url') === process.env.RPC_URL,
        executor: value('--executor-private-keys') === process.env.EXECUTOR_PRIVATE_KEY,
        utility: value('--utility-private-key') === (process.env.UTILITY_PRIVATE_KEY || process.env.EXECUTOR_PRIVATE_KEY),
        safeMode: process.argv.includes('--safe-mode'),
      }));
    `, { mode: 0o755 });
    for (const safeMode of ['true', 'false']) {
      const key = `0x${'0123456789abcdef'.repeat(4)}`;
      const { stdout, stderr } = await promisify(execFile)('/bin/sh', ['alto/entrypoint.sh'], {
        cwd: process.cwd(), timeout: 5_000,
        env: { PATH: `${directory}:${process.env.PATH}`, RPC_URL: 'https://bsc.example/v1/SECRETKEY',
          EXECUTOR_PRIVATE_KEY: key, UTILITY_PRIVATE_KEY: safeMode === 'true' ? '' : `0x${'ab'.repeat(32)}`,
          SAFE_MODE: safeMode, PORT: '3001' },
      });
      assert.doesNotMatch(stdout + stderr, /SECRETKEY|bsc\.example|0x0123/);
      assertNoSecretSlices(stdout + stderr, key);
      assert.deepEqual(JSON.parse(stdout.trim().split('\n').at(-1) ?? ''), {
        rpc: true, executor: true, utility: true, safeMode: safeMode === 'true',
      });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('#56 scheduler config failure cannot log malformed seed fragments', async () => {
  const seed = '0123456789abcdef'.repeat(4);
  for (const raw of [seed, `0x${seed.slice(1)}`, `"0x${seed}"`]) {
    const result = await runScript('scripts/scheduler.ts', { SESSION_KEY_MASTER_SEED: raw });
    assert.equal(result.code, 1);
    assert.match(result.output, /SESSION_KEY_MASTER_SEED/);
    assertNoSecretSlices(result.output, seed);
  }
});

test('#56 preflight RPC network, timeout and missing data errors never log endpoint keys', async () => {
  for (const mode of ['network', 'timeout', 'missing']) {
    const result = await runScript('scripts/preflight.ts', { RPC_URL: 'https://bsc.example/v1/SECRETKEY' }, `
      globalThis.fetch = async () => {
        if (${JSON.stringify(mode)} === 'timeout') throw new DOMException('https://bsc.example/v1/SECRETKEY', 'TimeoutError');
        if (${JSON.stringify(mode)} === 'missing') return Response.json({ error: { code: -32000, message: 'https://bsc.example/v1/SECRETKEY' } });
        throw new Error('https://bsc.example/v1/SECRETKEY');
      };
    `);
    assert.equal(result.code, 1);
    assert.match(result.output, /RPC 連線/);
    assert.doesNotMatch(result.output, /SECRETKEY|bsc\.example/);
  }
});

test('#56 preflight later RPC, bundler and DB failures hide URLs and upstream error text', async () => {
  for (const bundlerFailure of ['network', 'timeout', 'json', 'api']) {
    const result = await runScript('scripts/preflight.ts', {
      RPC_URL: 'https://bsc.example/v1/SECRETKEY', BUNDLER_URL: 'https://bundler.example/SECRETKEY',
      REGISTRY_ADDRESS: OWNER, EXECUTOR_ADDRESS: OTHER,
    }, `
      globalThis.fetch = async (url, init) => {
        if (String(url).includes('bundler.example')) {
          if (${JSON.stringify(bundlerFailure)} === 'timeout') throw new DOMException('https://bundler.example/SECRETKEY', 'TimeoutError');
          if (${JSON.stringify(bundlerFailure)} === 'json') return new Response('https://bundler.example/SECRETKEY');
          if (${JSON.stringify(bundlerFailure)} === 'api') return Response.json({ error: { message: 'SECRETKEY' } });
          throw new Error('https://bundler.example/SECRETKEY');
        }
        const body = JSON.parse(init.body);
        if (body.method === 'eth_chainId') return Response.json({ jsonrpc: '2.0', id: body.id, result: '0x539' });
        if (body.method === 'eth_blockNumber') return Response.json({ jsonrpc: '2.0', id: body.id, result: '0x2a' });
        return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'https://bsc.example/v1/SECRETKEY' } });
      };
    `);
    assert.equal(result.code, 1);
    for (const label of ['RPC 連線', 'registry 的 code', 'executor 的 code', 'executor.oracle', 'bundler', 'DB 連線']) {
      assert.ok(result.output.includes(label), `missing check: ${label}`);
    }
    assert.doesNotMatch(result.output, /SECRETKEY|bsc\.example|bundler\.example|postgres:\/\//);
  }
});

test('#56 preflight logs only validated bundler entrypoint addresses', async () => {
  const entrypoint = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
  for (const result of [[entrypoint], ['https://bundler.example/SECRETKEY'], [entrypoint, 'SECRETKEY'], [null], [], null]) {
    const run = await runScript('scripts/preflight.ts', {
      RPC_URL: 'https://bsc.example/v1/SECRETKEY', BUNDLER_URL: 'https://bundler.example/SECRETKEY',
    }, `
      globalThis.fetch = async (url, init) => {
        if (String(url).includes('bundler.example')) return Response.json({ result: ${JSON.stringify(result)} });
        const body = JSON.parse(init.body);
        return Response.json({ jsonrpc: '2.0', id: body.id, result: body.method === 'eth_chainId' ? '0x539' : '0x2a' });
      };
    `);
    assert.equal(run.code, 1, 'unconfigured contracts and DB still fail the overall preflight');
    assert.doesNotMatch(run.output, /SECRETKEY|bsc\.example|bundler\.example/);
    if (result?.length === 1 && result[0] === entrypoint) {
      assert.match(run.output, /entryPoints: 0x0000000071727De22E5E9d8BAf0edAc6f37da032/);
    } else {
      assert.match(run.output, /沒有回 entryPoints/);
    }
  }
});

for (const strict of [true, false]) {
  test(`executor pause preflight (strict=${strict}) distinguishes false, true and unreadable`, () => {
    assert.equal(checkGlobalPaused(false, strict).level, 'ok');
    assert.equal(checkGlobalPaused(true, strict).level, strict ? 'fail' : 'warn');
    assert.match(checkGlobalPaused(true, strict).detail, /Safe.*全域暫停/);
    assert.equal(checkGlobalPaused(null, strict).level, 'fail');
    assert.match(checkGlobalPaused(null, strict).detail, /讀不到.*globalPaused/);
  });
}

const OWNER: Address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const SAFE: Address = '0x000000000000000000000000000000000000aBcD';
const OTHER: Address = '0x0000000000000000000000000000000000001234';
const OPERATOR: Address = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65';
const BUNDLER: Address = '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc';

const separatedRoles = { relayer: OPERATOR, deployer: OWNER, bundler: BUNDLER, safe: SAFE, strict: true };

test('seed 比對：部分或全部不符都 fail，訊息帶實際把數，無 key 時明說檢查 0 把', () => {
  const report = { complete: true, checked: 3, mismatchedPortfolioIds: [5, 7], failedPortfolioIds: [], unavailable: 0 };
  assert.equal(checkSessionKeySeed(report).level, 'fail');
  assert.match(checkSessionKeySeed(report).detail, /檢查 3 把 session key：2 把不符/);
  assert.equal(checkSessionKeySeed({ ...report, checked: 2 }).level, 'fail');
  assert.equal(checkSessionKeySeed({ ...report, mismatchedPortfolioIds: [] }).level, 'ok');
  const empty = checkSessionKeySeed({ ...report, checked: 0, mismatchedPortfolioIds: [] });
  assert.equal(empty.level, 'ok');
  assert.match(empty.detail, /檢查 0 把/);
});

test('seed 比對：不能派生必須 fail，沒有已安裝 key 必須 warn（strict 會擋）', () => {
  const report = { complete: true, checked: 1, mismatchedPortfolioIds: [], failedPortfolioIds: [5], unavailable: 0 };
  assert.equal(checkSessionKeySeed(report).level, 'fail');
  assert.match(checkSessionKeySeed(report).detail, /1 個帳戶派生或讀取失敗/);
  assert.equal(checkSessionKeySeed({ ...report, checked: 0, failedPortfolioIds: [], unavailable: 1 }).level, 'warn');
});

test('three distinct anvil roles separate from the Safe pass all nine key checks', () => {
  const checks = checkRoleSeparation(separatedRoles);
  assert.equal(checks.length, 9);
  assert.ok(checks.every((c) => c.level === 'ok'));
});

for (const strict of [true, false]) {
  for (const name of ['deployer', 'bundler'] as const) {
    const envName = name === 'deployer' ? 'DEPLOYER_ADDRESS' : 'BUNDLER_EXECUTOR_ADDRESS';
    test(`${strict ? 'strict' : 'non-strict'}: missing ${name} is ${strict ? 'fail' : 'warn'}`, () => {
      for (const raw of [undefined, '', '   ']) {
        const checks = checkRoleSeparation({ ...separatedRoles, strict, [name]: raw });
        assert.equal(checks.find((c) => c.name === envName)?.level, strict ? 'fail' : 'warn');
      }
    });
    test(`${strict ? 'strict' : 'non-strict'}: malformed or zero ${name} fails without echoing input`, () => {
      for (const raw of ['not-an-address', zeroAddress, `0x${'ff'.repeat(32)}`]) {
        const checks = checkRoleSeparation({ ...separatedRoles, strict, [name]: raw });
        assert.equal(checks.find((c) => c.name === envName)?.level, 'fail');
        assert.ok(!JSON.stringify(checks).includes(raw));
      }
    });
  }

  for (const [name, change] of [
    ['relayer / deployer', { deployer: OPERATOR.toLowerCase() }],
    ['relayer / bundler', { bundler: OPERATOR.toLowerCase() }],
    ['deployer / bundler', { bundler: OWNER.toLowerCase() }],
  ] as const) {
    test(`${strict ? 'strict' : 'non-strict'}: ${name} collision always fails ignoring case`, () => {
      const checks = checkRoleSeparation({ ...separatedRoles, strict, ...change });
      assert.equal(checks.filter((c) => c.level === 'fail').length, 1);
      assert.match(checks.find((c) => c.level === 'fail')?.detail ?? '', /相同地址/);
    });
  }

  for (const name of ['relayer', 'deployer', 'bundler'] as const) {
    test(`${strict ? 'strict' : 'non-strict'}: ${name} equal to ATP_SAFE always fails`, () => {
      const checks = checkRoleSeparation({ ...separatedRoles, strict, [name]: SAFE.toLowerCase() });
      assert.equal(checks.filter((c) => c.level === 'fail').length, 1);
      assert.match(checks.find((c) => c.level === 'fail')?.name ?? '', /ATP_SAFE/);
    });
  }

  test(`${strict ? 'strict' : 'non-strict'}: missing or invalid relayer cannot pass`, () => {
    assert.equal(checkRoleSeparation({ ...separatedRoles, strict, relayer: null })[0]?.level, 'fail');
  });
}

test('role address parsing trims surrounding whitespace', () => {
  assert.ok(checkRoleSeparation({
    ...separatedRoles, deployer: `  ${OWNER} `, bundler: ` ${BUNDLER.toLowerCase()} `,
  }).every((c) => c.level === 'ok'));
});

test('a private key pasted into a public role address never appears in the check output', () => {
  const account = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 4 });
  const key = Buffer.from(account.getHdKey().privateKey!).toString('hex');
  const checks = checkRoleSeparation({
    ...separatedRoles, relayer: operatorAddress(key), deployer: `0x${key}`, bundler: key,
  });
  assert.equal(checks.filter((c) => c.level === 'fail').length, 2);
  assert.ok(!JSON.stringify(checks).includes(key));
});

for (const label of ['registry', 'router'] as const) {
  for (const strict of [true, false]) {
    const level = strict ? 'fail' : 'warn';
    const input = { label, owner: SAFE, pendingOwner: zeroAddress, safe: SAFE, safeHasCode: true, strict };
    const prefix = `${label} ${strict ? 'strict' : 'non-strict'}`;

    test(`${prefix}: freshly deployed owner has not begun the Safe handover`, () => {
      const checks = checkOwnership({ ...input, owner: OWNER });
      assert.equal(checks.find((c) => c.name === `${label} owner`)?.level, level);
      assert.match(checks[0]?.fix ?? '', /transferOwnership/);
    });

    test(`${prefix}: pending Safe is not accepted ownership`, () => {
      const checks = checkOwnership({ ...input, owner: OWNER, pendingOwner: SAFE });
      assert.equal(checks[0]?.level, level);
      assert.match(checks[0]?.fix ?? '', /Safe 尚未 acceptOwnership/);
    });

    test(`${prefix}: accepted ownership and cleared pendingOwner pass`, () => {
      assert.ok(checkOwnership(input).every((c) => c.level === 'ok'));
    });

    test(`${prefix}: an unexpected nonzero pendingOwner is rejected even after acceptance`, () => {
      const checks = checkOwnership({ ...input, pendingOwner: OTHER });
      assert.equal(checks.find((c) => c.name === `${label} pendingOwner`)?.level, level);
      assert.match(checks.at(-1)?.detail ?? '', /非零且不是 ATP_SAFE/);
    });

    test(`${prefix}: Safe must have deployed code, and a failed code read cannot pass`, () => {
      for (const safeHasCode of [false, null]) {
        const checks = checkOwnership({ ...input, safeHasCode });
        assert.equal(checks.find((c) => c.name === `${label} owner code`)?.level, level);
      }
    });

    test(`${prefix}: missing, invalid or zero ATP_SAFE cannot pass`, () => {
      for (const safe of [null, zeroAddress]) {
        assert.equal(checkOwnership({ ...input, safe })[0]?.level, level);
      }
    });

    test(`${prefix}: unreadable pendingOwner is a v2 failure in both modes`, () => {
      const checks = checkOwnership({ ...input, pendingOwner: null });
      const pending = checks.find((c) => c.name === `${label} pendingOwner`);
      assert.equal(pending?.level, 'fail');
      assert.match(pending?.detail ?? '', /不是 v2 合約/);
    });

    test(`${prefix}: unreadable owner fails without hiding the pendingOwner result`, () => {
      const checks = checkOwnership({ ...input, owner: null, pendingOwner: OTHER });
      assert.equal(checks[0]?.level, 'fail');
      assert.equal(checks.at(-1)?.level, level);
    });
  }
}

test('ownership comparisons ignore address case', () => {
  const checks = checkOwnership({
    label: 'registry', owner: SAFE.toLowerCase() as Address, pendingOwner: zeroAddress,
    safe: SAFE, safeHasCode: true, strict: true,
  });
  assert.ok(checks.every((c) => c.level === 'ok'));
});

test('an already accepted Safe may also be the pending owner of a repeated transfer', () => {
  assert.ok(checkOwnership({
    label: 'router', owner: SAFE, pendingOwner: SAFE, safe: SAFE, safeHasCode: true, strict: true,
  }).every((c) => c.level === 'ok'));
});

test('registry operator matches the relayer independently of the Safe owner', () => {
  assert.deepEqual(checkRegistryOperator({ operator: OPERATOR, owner: SAFE, expectedOperator: OPERATOR }).map((c) => c.level), ['ok']);
  assert.ok(checkRegistryOperator({ operator: OPERATOR.toLowerCase() as Address, owner: SAFE, expectedOperator: OPERATOR }).every((c) => c.level === 'ok'));
});

for (const [name, operator, expectedOperator] of [
  ['zero operator', zeroAddress, OPERATOR],
  ['wrong relayer (anvil #5)', OPERATOR, '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc'],
  ['missing or invalid relayer key', OPERATOR, null],
  ['v1 or unreadable operator()', null, OPERATOR],
] as const) {
  test(`registry operator always fails: ${name}`, () => {
    const checks = checkRegistryOperator({ operator, owner: SAFE, expectedOperator });
    assert.equal(checks[0]?.level, 'fail');
    if (operator === null) assert.match(checks[0]?.detail ?? '', /不是 v2 合約/);
  });
}

test('operator equal to owner fails even when it matches the configured key', () => {
  const checks = checkRegistryOperator({ operator: OPERATOR, owner: OPERATOR.toLowerCase() as Address, expectedOperator: OPERATOR });
  assert.equal(checks.find((c) => c.name === 'registry operator / owner')?.level, 'fail');
});

test('operatorAddress only returns the address derived from the public anvil test key', () => {
  const account = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 4 });
  const key = account.getHdKey().privateKey;
  assert.ok(key);
  const hex = Buffer.from(key).toString('hex');
  assert.equal(operatorAddress(`0x${hex}`), OPERATOR);
  assert.equal(operatorAddress(`  ${hex}  `), OPERATOR);
  assert.ok(!JSON.stringify(checkRegistryOperator({ operator: OTHER, owner: SAFE, expectedOperator: operatorAddress(hex) })).includes(hex));
});

test('operatorAddress rejects empty, malformed, zero and out-of-range keys without throwing or echoing input', () => {
  for (const raw of [undefined, '', 'not-a-key', `0x${'01'.repeat(31)}`, `0x${'00'.repeat(32)}`, `0x${'ff'.repeat(32)}`]) {
    assert.equal(operatorAddress(raw), null);
  }
});

for (const strict of [false, true]) {
  test(`A10 preflight buy config strict=${strict}: zero, below, exact cap and missing data`, () => {
    const usdt: Address = '0x55d398326f99059fF775485246999027B3197955';
    assert.ok(checkBuyConfig(10000, usdt, strict).every((check) => check.level === 'ok'));
    for (const bps of [0, 9999]) assert.equal(checkBuyConfig(bps, usdt, strict)[0]?.level, strict ? 'fail' : 'warn');
    assert.equal(checkBuyConfig(10000, zeroAddress, strict)[1]?.level, strict ? 'fail' : 'warn');
    assert.ok(checkBuyConfig(null, null, strict).every((check) => check.level === 'fail'));
  });
}

function venuePreflightFixture() {
  const state = { urKind: 1, urSpender: PANCAKE_UR, otherKind: 2, wrongDeployment: false, fail: '', blocks: [] as unknown[] };
  const client = createPublicClient({ transport: custom({ request: async ({ method, params }) => {
    if (state.fail === method) throw new Error('RPC secret-token');
    if (method === 'eth_blockNumber') return '0x2a';
    if (method === 'eth_getCode') {
      assert.ok(Array.isArray(params));
      return params[1] === '0x27' && !state.wrongDeployment ? '0x' : '0x1234';
    }
    if (method === 'eth_getLogs') return [PANCAKE_UR, OTHER, OTHER].map((target, index) => ({
      address: SAFE, blockNumber: '0x29', blockHash: `0x${'a'.repeat(64)}`, transactionHash: `0x${'b'.repeat(64)}`,
      transactionIndex: '0x0', logIndex: `0x${index}`, removed: false,
      topics: encodeEventTopics({ abi: EXECUTOR_ABI, eventName: 'VenueSet', args: { target } }),
      data: encodeAbiParameters([{ type: 'uint8' }, { type: 'address' }], [2, OTHER]),
    }));
    assert.equal(method, 'eth_call'); assert.ok(Array.isArray(params));
    const call: unknown = params[0]; assert.ok(typeof call === 'object' && call !== null);
    const data: unknown = Reflect.get(call, 'data');
    assert.ok(typeof data === 'string' && /^0x[0-9a-f]+$/i.test(data));
    // ABI selector + padded address: all calls here are venues(target).
    state.blocks.push(params[1]);
    const ur = data.slice(-40).toLowerCase() === PANCAKE_UR.slice(2).toLowerCase();
    return encodeFunctionResult({ abi: EXECUTOR_ABI, functionName: 'venues',
      result: ur ? [state.urKind, state.urSpender] : [state.otherKind, OTHER] });
  } }, { retryCount: 0 }) });
  return { state, client };
}

test('#47 preflight lists current venues once at one block and requires canonical PANCAKE_UR', async () => {
  const f = venuePreflightFixture();
  const checks = await checkVenues(f.client, getAddress(SAFE.toLowerCase()), 40n);
  assert.equal(checks.length, 2);
  assert.ok(checks.every((check) => check.level === 'ok'));
  assert.match(checks[1]?.detail ?? '', /ERC20_APPROVE/);
  assert.deepEqual(f.state.blocks, ['0x2a', '0x2a']);
  f.state.otherKind = 0;
  assert.equal((await checkVenues(f.client, getAddress(SAFE.toLowerCase()), 40n)).length, 1, 'removed venue is omitted');
  for (const kind of [0, 2, 3, 255]) {
    f.state.urKind = kind;
    assert.equal((await checkVenues(f.client, getAddress(SAFE.toLowerCase()), 40n))[0]?.level, 'fail');
  }
  f.state.urKind = 1; f.state.urSpender = zeroAddress;
  assert.equal((await checkVenues(f.client, getAddress(SAFE.toLowerCase()), 40n))[0]?.level, 'fail');
});

for (const method of ['eth_blockNumber', 'eth_getCode', 'eth_getLogs', 'eth_call']) {
  test(`#47 preflight ${method} failure is not an empty successful venue list`, async () => {
    const f = venuePreflightFixture(); f.state.fail = method;
    const checks = await checkVenues(f.client, getAddress(SAFE.toLowerCase()), 40n);
    assert.equal(checks.length, 1);
    assert.equal(checks[0]?.level, 'fail');
    assert.ok(!JSON.stringify(checks).includes('secret-token'));
  });
}

test('#47 preflight deployment block accepts zero and rejects negative or future heights', async () => {
  const f = venuePreflightFixture();
  assert.ok((await checkVenues(f.client, getAddress(SAFE.toLowerCase()), 0n)).every((check) => check.level === 'ok'));
  for (const block of [-1n, 43n]) {
    assert.equal((await checkVenues(f.client, getAddress(SAFE.toLowerCase()), block))[0]?.level, 'fail');
  }
});

test('#47 preflight rejects a scan starting after deployment to avoid omitting old venues', async () => {
  const f = venuePreflightFixture(); f.state.wrongDeployment = true;
  assert.equal((await checkVenues(f.client, getAddress(SAFE.toLowerCase()), 40n))[0]?.level, 'fail');
});

// #52 regression: a structured secondary revert must survive the pre-send quote boundary.
test('#52 stale feed refresh returns the feed and reason without RPC credentials', async () => {
  const { refreshFloors } = await import('../src/rebalance-plan.js');
  const { ContractFunctionRevertedError, encodeErrorResult, parseAbi } = await import('viem');
  const abi = parseAbi(['error StaleFeed(address feed,uint256 updatedAt)']);
  const error = new ContractFunctionRevertedError({ abi, functionName: 'previewSwap', data: encodeErrorResult({ abi,
    errorName: 'StaleFeed', args: [OTHER, 100n] }) });
  const client = createPublicClient({ transport: custom({ request: async ({ method }) => {
    if (method === 'eth_getBlockByNumber') return { number: '0x2a', timestamp: '0xc8', transactions: [] };
    throw new Error('https://rpc.invalid/private-token', { cause: error });
  } }, { retryCount: 0 }) });
  const result = await refreshFloors({ publicClient: client, oracle: getAddress(SAFE.toLowerCase()), feeBps: 0,
    steps: [{ tokenIn: OWNER, tokenOut: OTHER, amountIn: 10n, amountOutMin: 9n,
      oracleFloor: 9n, venue: OTHER, data: '0x' }] });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('stale feed was accepted');
  assert.match(result.reason, /StaleFeed/);
  assert.match(result.reason, new RegExp(OTHER, 'i'));
  assert.match(result.reason, /100.*秒/);
  assert.doesNotMatch(result.reason, /private-token|rpc.invalid/);
});


import { decodePriceSourceError, inspectPriceSources, readSecondaryHealth } from '../src/chain.js';
import { ASSET, ASSET_FEED, CASH, CASH_FEED, ORACLE, secondaryFixture, secondaryRevert, twapRevert } from './fixtures/secondary-price.js';

test('#76 TWAP ABI errors include a safe symbol; forged messages and malformed args are not evidence', async () => {
  const { describePriceSourceError } = await import('../src/chain.js');
  const f = secondaryFixture();
  const failure = await describePriceSourceError(twapRevert(), f.client, { oracle: ORACLE, asset: ASSET, blockNumber: 42n });
  assert.equal(failure?.code, 'TwapUnavailable');
  assert.match(failure?.detail ?? '', /\[ORACLE_UNAVAILABLE:TEST\]/);
  assert.doesNotMatch(failure?.detail ?? '', /private-token/);
  for (const error of [new Error('TwapUnavailable private-token'), { errorName: 'TwapUnavailable', args: [1n] }]) {
    assert.equal(decodePriceSourceError(error), null);
  }
  f.state.symbol = 'private-token\n[spoof]';
  const safe = await describePriceSourceError(twapRevert(), f.client, { oracle: ORACLE, asset: ASSET });
  assert.match(safe?.detail ?? '', new RegExp(`ORACLE_UNAVAILABLE:${ASSET}`, 'i'));
  assert.doesNotMatch(safe?.detail ?? '', /private-token|spoof/);
});

test('#76 monitor checks TWAP without a secondary, retries after recovery, and keeps RPC failures unknown', async () => {
  const f = secondaryFixture(); f.state.source = zeroAddress; f.state.quoteError = twapRevert();
  let observation = (await inspectPriceSources(f.client, ORACLE, [ASSET]))[0];
  assert.equal(observation?.verified, true); assert.equal(observation?.failure?.code, 'TwapUnavailable');
  assert.match(observation?.failure?.detail ?? '', /ORACLE_UNAVAILABLE:TEST/);
  f.state.quoteError = null;
  observation = (await inspectPriceSources(f.client, ORACLE, [ASSET]))[0];
  assert.equal(observation?.verified, true); assert.equal(observation?.failure, null);
  f.state.quoteError = new Error('timeout private-token');
  observation = (await inspectPriceSources(f.client, ORACLE, [ASSET]))[0];
  assert.equal(observation?.verified, false); assert.equal(observation?.failure, null);
  assert.ok(f.state.calls.every((call) => call.block === '0x2a'));
});

test('#76 the final floor refresh decodes nested TWAP data, identifies the symbol and refuses the whole batch', async () => {
  const { refreshFloors } = await import('../src/rebalance-plan.js');
  const f = secondaryFixture(); f.state.quoteError = new Error('RPC private-token', { cause: twapRevert() });
  const step = { tokenIn: ASSET, tokenOut: CASH, amountIn: 10n, amountOutMin: 9n, oracleFloor: 9n, venue: CASH, data: '0x' as const };
  const result = await refreshFloors({ publicClient: f.client, oracle: ORACLE, steps: [step, step], feeBps: 0, blockNumber: 42n });
  assert.ok(!result.ok); assert.match(result.reason, /ORACLE_UNAVAILABLE:TEST/);
  assert.doesNotMatch(result.reason, /private-token/);
  assert.equal(f.state.calls.filter((call) => call.name === 'previewSwap').length, 1);
});

test('#76 monitoring handles token/quote boundaries and missing metadata without claiming recovery', async () => {
  const f = secondaryFixture(); f.state.source = zeroAddress;
  for (const decimals of [0, 36, 37]) {
    f.state.decimals = decimals;
    assert.equal((await inspectPriceSources(f.client, ORACLE, [ASSET]))[0]?.verified, decimals <= 36);
  }
  f.state.decimals = 18;
  for (const [quoted, minimum] of [[0n, 1n], [1n, 0n]] as const) {
    f.state.quoted = quoted; f.state.minimum = minimum;
    assert.equal((await inspectPriceSources(f.client, ORACLE, [ASSET]))[0]?.verified, false);
  }
  f.state.quoted = 1n; f.state.minimum = 1n;
  for (const fail of ['decimals', 'previewSwap', 'secondaryOf']) {
    f.state.fail = fail;
    const observation = (await inspectPriceSources(f.client, ORACLE, [ASSET]))[0];
    assert.equal(observation?.verified, false); assert.equal(observation?.failure, null);
  }
  f.state.fail = 'symbol'; f.state.quoteError = twapRevert();
  const observation = (await inspectPriceSources(f.client, ORACLE, [ASSET]))[0];
  assert.equal(observation?.verified, true); assert.equal(observation?.failure?.code, 'TwapUnavailable');
  assert.match(observation?.failure?.detail ?? '', new RegExp(`ORACLE_UNAVAILABLE:${ASSET}`, 'i'));
  assert.doesNotMatch(observation?.failure?.detail ?? '', /private-token/);
});

test('#76 each feed has its own age limit, including equality, zero, future and invalid metadata', async () => {
  const { describePriceSourceError } = await import('../src/chain.js');
  const f = secondaryFixture(); f.state.timestamp = 3000n; f.state.assetAt = 2940n; f.state.numeraireMaxAge = 2700;
  for (const at of [0n, 299n, 300n, 301n, 3001n]) {
    f.state.cashAt = at;
    const health = await readSecondaryHealth(f.client, ORACLE, ASSET, { number: 42n, timestamp: 3000n });
    assert.equal(health.feeds[0]?.failure, null);
    assert.equal(health.feeds[1]?.failure?.code ?? null, at >= 300n && at <= 3000n ? null : 'StaleFeed');
  }
  const failure = await describePriceSourceError({ errorName: 'StaleFeed', args: [CASH_FEED, 299n] }, f.client, { oracle: ORACLE, asset: ASSET });
  assert.match(failure?.detail ?? '', /上限 2700 秒.*超時 1 秒/);
  for (const maxAge of [60, 86400]) {
    f.state.numeraireMaxAge = maxAge;
    await readSecondaryHealth(f.client, ORACLE, ASSET, { number: 42n, timestamp: 3000n });
  }
  for (const maxAge of [0, 59, 86401]) {
    f.state.numeraireMaxAge = maxAge;
    await assert.rejects(readSecondaryHealth(f.client, ORACLE, ASSET, { number: 42n, timestamp: 3000n }));
  }
  f.state.numeraireMaxAge = 2700; f.state.fail = 'numeraireMaxAge';
  await assert.rejects(readSecondaryHealth(f.client, ORACLE, ASSET, { number: 42n, timestamp: 3000n }));
});

for (const [code, value, pattern] of [
  ['StaleFeed', 900n, /年齡 100 秒/], ['InvalidAnswer', 0n, /回傳 0/],
  ['InvalidAnswer', -1n, /回傳 -1/], ['SourcesDisagree', 10101n, /101 bps/],
] as const) {
  test(`#52 ${code} ABI and nested RPC decode retains safe facts`, () => {
    const failure = decodePriceSourceError(new Error('private-token', { cause: secondaryRevert(code, value) }), { asset: ASSET, timestamp: 1000n });
    assert.equal(failure?.code, code); assert.match(failure?.detail ?? '', pattern);
    assert.doesNotMatch(failure?.detail ?? '', /private-token/);
    assert.match(failure?.detail ?? '', new RegExp(ASSET, 'i'));
  });
}

test('#52 malformed, cyclic, forged message and unknown reverts cannot disclose RPC text', () => {
  const cyclic: { cause?: unknown } = {}; cyclic.cause = cyclic;
  for (const error of [cyclic, new Error('StaleFeed private-token'), { data: '0x12345678' },
    { data: { errorName: 'StaleFeed', args: ['private-token', 1n] } }, { errorName: 'InvalidAnswer', args: [ASSET_FEED, 1n] }]) {
    assert.equal(decodePriceSourceError(error), null);
  }
  assert.match(decodePriceSourceError(secondaryRevert('SourcesDisagree', 0n))?.detail ?? '', /10000 bps/);
});

for (const strict of [true, false]) {
  for (const at of [0n, 939n, 940n, 941n, 1001n]) {
    test(`#52 preflight strict=${strict}, feed updatedAt=${at} (zero/exact age/future)`, async () => {
      const f = secondaryFixture(); f.state.cashAt = at;
      const checks = await checkSecondarySources(f.client, ORACLE, [ASSET], strict);
      assert.equal(checks.length, 3);
      const good = at >= 940n && at <= 1000n;
      assert.equal(checks[2]?.level, good ? 'ok' : strict ? 'fail' : 'warn');
      assert.match(checks[1]?.detail ?? '', /年齡 60 秒/);
      assert.ok(f.state.calls.every((call) => call.block === '0x2a'));
    });
  }
}

for (const method of ['eth_getBlockByNumber', 'secondaryOf', 'assetFeed', 'numeraireFeed', 'maxAge', 'latestRoundData']) {
  test(`#52 preflight ${method} missing/RPC failure fails closed and hides credentials`, async () => {
    const f = secondaryFixture(); f.state.fail = method;
    const checks = await checkSecondarySources(f.client, ORACLE, [ASSET], true);
    assert.ok(checks.some((check) => check.level === 'fail'));
    assert.doesNotMatch(JSON.stringify(checks), /private-token/);
  });
}

test('#52 absent secondary is explicit; both invalid answers and maxAge limits are checked', async () => {
  const f = secondaryFixture(); f.state.source = zeroAddress;
  assert.match((await checkSecondarySources(f.client, ORACLE, [ASSET], true))[0]?.detail ?? '', /未設定 secondary/);
  f.state.source = (await import('./fixtures/secondary-price.js')).SOURCE;
  for (const answer of [0n, -1n]) {
    f.state.assetAnswer = answer;
    assert.equal((await checkSecondarySources(f.client, ORACLE, [ASSET], true))[1]?.level, 'fail');
  }
  f.state.assetAnswer = 1n;
  for (const maxAge of [60, 86400]) {
    f.state.maxAge = maxAge;
    assert.equal((await readSecondaryHealth(f.client, ORACLE, ASSET, { number: 42n, timestamp: 1000n })).maxAge, maxAge);
  }
  for (const maxAge of [0, 59, 86401]) {
    f.state.maxAge = maxAge;
    await assert.rejects(readSecondaryHealth(f.client, ORACLE, ASSET, { number: 42n, timestamp: 1000n }));
  }
});

test('#52 monitor identifies stale/disagree/invalid and preserves unknown RPC state', async () => {
  const f = secondaryFixture();
  let observations = await inspectPriceSources(f.client, ORACLE, [ASSET, ASSET, CASH]);
  assert.equal(observations.length, 1); assert.equal(observations[0]?.failure, null);
  f.state.assetAt = 939n;
  assert.equal((await inspectPriceSources(f.client, ORACLE, [ASSET]))[0]?.failure?.code, 'StaleFeed');
  f.state.assetAt = 940n; f.state.assetAnswer = 0n;
  assert.equal((await inspectPriceSources(f.client, ORACLE, [ASSET]))[0]?.failure?.code, 'InvalidAnswer');
  f.state.assetAnswer = 1n; f.state.quoteError = secondaryRevert('SourcesDisagree', 12000n);
  assert.equal((await inspectPriceSources(f.client, ORACLE, [ASSET]))[0]?.failure?.code, 'SourcesDisagree');
  f.state.quoteError = new Error('private-token timeout');
  observations = await inspectPriceSources(f.client, ORACLE, [ASSET]);
  assert.equal(observations[0]?.verified, false); assert.equal(observations[0]?.failure, null);
});


test('#52 EntryPoint wrapper and deep viem causes decode only the inner ABI error', async () => {
  const { encodeErrorResult } = await import('viem');
  const { PRICE_SOURCE_ABI, describePriceSourceError } = await import('../src/chain.js');
  const raw = secondaryRevert('StaleFeed', 900n).raw; assert.ok(raw);
  let error: unknown = { data: encodeErrorResult({ abi: PRICE_SOURCE_ABI, errorName: 'FailedOpWithRevert', args: [0n, 'RPC private-token', raw] }) };
  for (let index = 0; index < 12; index += 1) error = new Error('RPC private-token', { cause: error });
  assert.equal(decodePriceSourceError(error)?.code, 'StaleFeed');
  const f = secondaryFixture();
  const detailed = await describePriceSourceError(error, f.client, { oracle: ORACLE, assets: [CASH, ASSET] });
  assert.equal(detailed?.asset, ASSET); assert.match(detailed?.detail ?? '', /年齡 100 秒.*上限 60 秒.*超時 40 秒/);
  assert.doesNotMatch(detailed?.detail ?? '', /private-token/);
  f.state.fail = 'eth_getBlockByNumber';
  assert.match((await describePriceSourceError(error, f.client, { oracle: ORACLE }))?.detail ?? '', /鏈上時間未知/);
});

test('#52 malformed structured integer args cannot masquerade as valid oracle evidence', () => {
  for (const error of [{ errorName: 'StaleFeed', args: [ASSET_FEED, -1n] },
    { errorName: 'StaleFeed', args: [ASSET_FEED, 1n << 256n] },
    { errorName: 'InvalidAnswer', args: [ASSET_FEED, -(1n << 255n) - 1n] },
    { errorName: 'SourcesDisagree', args: [ASSET, 1n, 1n << 256n] }]) assert.equal(decodePriceSourceError(error), null);
  assert.equal(decodePriceSourceError(secondaryRevert('InvalidAnswer', -(1n << 255n)))?.code, 'InvalidAnswer');
});

test('#52 disagreement zero denominator, exact 100 bps and uint256 upper bound stay integer-safe', () => {
  const zero = decodePriceSourceError({ data: { errorName: 'SourcesDisagree', args: [ASSET, 1n, 0n] } });
  assert.match(zero?.detail ?? '', /無法計算（secondary=0）/);
  assert.match(decodePriceSourceError({ data: { errorName: 'SourcesDisagree', args: [ASSET, 10100n, 10000n] } })?.detail ?? '', /差距 100 bps/);
  assert.equal(decodePriceSourceError({ data: { errorName: 'SourcesDisagree', args: [ASSET, (1n << 256n) - 1n, 1n] } })?.code, 'SourcesDisagree');
});

test('#69 preflight accepts only the pinned testnet EOA owner; unreadable owner code still fails closed', async () => {
  const { TESTNET_97 } = await import('../src/testnet-profile.js');
  const { zeroAddress } = await import('viem');
  const base = { label: 'registry' as const, owner: TESTNET_97.roles.owner, safe: TESTNET_97.roles.owner, pendingOwner: zeroAddress, safeHasCode: false, strict: true };
  assert.ok(checkOwnership({ ...base, testnet: true }).every((check) => check.level === 'ok'));
  assert.ok(checkOwnership(base).some((check) => check.level === 'fail'));
  assert.ok(checkOwnership({ ...base, safeHasCode: null, testnet: true }).some((check) => check.level === 'fail'));
});

test('#69 chain 56 preflight preserves the raw-address checksum validation', async () => {
  const result = await runScript('scripts/preflight.ts', { CHAIN_ID: '56', REGISTRY_ADDRESS: '0x55D398326f99059fF775485246999027B3197955' });
  assert.equal(result.code, 1);
  assert.match(result.output, /✗ REGISTRY_ADDRESS[^\n]*未設定或不是合法/);
});
