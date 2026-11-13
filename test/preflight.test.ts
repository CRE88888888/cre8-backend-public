import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mnemonicToAccount } from 'viem/accounts';
import { zeroAddress } from 'viem';
import type { Address } from 'viem';
import { checkGlobalPaused, checkOwnership, checkRegistryOperator, checkRoleSeparation, checkSessionKeySeed, operatorAddress } from '../scripts/preflight.js';

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
