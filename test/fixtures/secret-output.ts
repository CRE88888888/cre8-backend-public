import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 不讓失敗斷言把測試用的秘密再次印出來；逐一檢查所有 8 字元片段。 */
export function assertNoSecretSlices(output: string, secret: string): void {
  for (let index = 0; index + 8 <= secret.length; index += 1) {
    assert.ok(!output.includes(secret.slice(index, index + 8)), 'output contains a secret fragment');
  }
}

/** 隔離 config cache、console 與 Bun mock，所有連線預設只指向不可達的本機端點。 */
export async function runScript(path: string, env: NodeJS.ProcessEnv = {}, setup = '') {
  const target = new URL(`../../${path}`, import.meta.url);
  const child = spawn(process.execPath, ['--eval', `
    process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(target))}];
    ${setup}
    await import(${JSON.stringify(target.href)});
  `], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: {
      ...process.env,
      DATABASE_URL: 'postgres://ci:ci@127.0.0.1:1/unused',
      PORT: '8092', CHAIN_ID: '1337', MIGRATIONS_ENABLED: '0',
      RPC_URL: '', ANVIL_RPC_URL: '', BUNDLER_URL: '',
      EXECUTOR_ADDRESS: '', REGISTRY_ADDRESS: '', SESSION_KEY_MASTER_SEED: '', OPERATOR_PRIVATE_KEY: '',
      TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '', TELEGRAM_API_BASE: '',
      AUTH_DOMAIN: '', AUTH_URI: '', ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    return { code, output };
  } finally {
    clearTimeout(timer);
  }
}
