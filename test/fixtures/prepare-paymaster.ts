/** Reproducible local-only Solidity fixtures. Downloads source code from GitHub, never a chain RPC. */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../.bun-cache/paymaster-aa/', import.meta.url));
mkdirSync(root + '/lib/openzeppelin', { recursive: true });
mkdirSync(root + '/verify', { recursive: true });
for (const [repo, ref, destination] of [
  ['eth-infinitism/account-abstraction', '7af70c8993a6f42973f520ae0752386a5032abe7', root],
  ['OpenZeppelin/openzeppelin-contracts', 'v5.0.0', root + '/lib/openzeppelin'],
] as const) {
  const archive = execFileSync('gh', ['api', `repos/${repo}/tarball/${ref}`], { maxBuffer: 32 * 1024 * 1024 });
  const path = destination + '/fixture-source.tgz';
  writeFileSync(path, archive);
  execFileSync('tar', ['-xzf', path, '-C', destination, '--strip-components=1']);
}
copyFileSync(new URL('./PaymasterAccount.sol', import.meta.url), root + '/verify/PaymasterAccount.sol');
writeFileSync(root + '/verify/Imports.sol', 'pragma solidity ^0.8.23;\nimport "../contracts/core/EntryPoint.sol";\nimport "../contracts/samples/VerifyingPaymaster.sol";\nimport "./PaymasterAccount.sol";\n');
writeFileSync(root + '/foundry.toml', `[profile.default]
src = "verify"
solc = "0.8.23"
evm_version = "paris"
optimizer = true
optimizer_runs = 200
remappings = ["@openzeppelin/contracts/=lib/openzeppelin/contracts/", "aa/=contracts/"]
`);
execFileSync('forge', ['build'], { cwd: root, stdio: 'inherit' });
