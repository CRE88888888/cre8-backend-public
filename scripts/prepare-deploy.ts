/**
 * 準備一個「自足」的部署目錄 `.deploy/`。
 *
 *     bun run scripts/prepare-deploy.ts
 *     cd .deploy && railway up
 *
 * ## 為什麼需要它
 *
 * `db/migrations` 住在**隔壁的 repo**（`cre8-protocol/db`），而 Docker 的 build context 只有
 * 一個目錄。直接把 `backend/` 當 context 的話，image 裡沒有 migration 檔 —— 而 Railway 的
 * Postgres 只在**私有網路**（`postgres.railway.internal`）上，本地連不到，所以「migration 當成
 * 本地部署步驟」這條路在 Railway 上行不通（實測 DNS 失敗）。
 *
 * 結論：**容器必須自己跑 migration**，因此 image 必須含 migration 檔。
 *
 * ## 做法
 *
 * 複製 `backend/`（排除 node_modules / .git / .env / .railway*）到 `.deploy/`，
 * 再把 `../db/migrations` 放到 `.deploy/db/migrations`。
 * 在那個目錄裡 `railway up`，build context 就同時有程式與 migration。
 *
 * 為什麼不直接改 build context 成 repo 根目錄：那裡有 `cre8-app/node_modules`（數百 MB），
 * 上傳與建置都會被拖垮，而且根目錄不是 git repo（`.gitignore` 過濾不生效）。
 *
 * ## 單一真相
 *
 * migrations 仍然只有一份（`db/` repo），`.deploy/` 是**產物**、每次部署前重生，
 * 不進版控（`.gitignore`）。不做兩份手抄，避免漂移。
 */

import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(HERE, '..');
const REPO = resolve(BACKEND, '..');
const MIGRATIONS_SRC = join(REPO, 'db', 'migrations');
const DEPLOY = join(BACKEND, '.deploy');

/** 不該進 image 的東西。比 `.gitignore` 精確（那個還管著別的事）。 */
const EXCLUDE = new Set([
  'node_modules',
  '.git',
  '.deploy',
  '.railway-home',
  '.railway',
  '.env',
  '.env.fork',
  '.bun-cache',
  'dist',
  // 不複製 `.gitignore`：它裡面有 `.deploy/` 這條規則，而 `railway up` 會拿它過濾上傳
  // —— 上傳根目錄自己符合那條規則時，**整個目錄會被排除**（實測：image 裡沒有 db/migrations，
  // 容器啟動 ENOENT，但本地 docker build 完全正常）。
  '.gitignore',
]);
const INCLUDE = ['src', 'scripts', 'deploy', 'alto', 'package.json', 'bun.lock', 'Dockerfile', 'docker-entrypoint.sh', 'railway.json'];

async function copyDir(from: string, to: string): Promise<number> {
  let count = 0;
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name) || entry.name.startsWith('.env') || entry.name.endsWith('.log')) continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      count += await copyDir(source, target);
    } else if (entry.isFile()) {
      await cp(source, target);
      count += 1;
    }
  }
  return count;
}

export async function prepareDeploy(backend = BACKEND, migrationsSrc = process.env.MIGRATIONS_DIR || MIGRATIONS_SRC, deploy = DEPLOY, website?: string): Promise<void> {
  if (!existsSync(migrationsSrc)) {
    throw new Error(
      `找不到 migration 目錄：${migrationsSrc}\n` +
        'db/ repo 必須 checkout 在 backend/ 旁邊（見 backend/README.md）',
    );
  }

  // Validate inputs before removing the old artifact. Only explicit runtime roots are uploaded.
  if (website && !existsSync(join(website, 'index.html'))) throw new Error('website index.html missing');
  await rm(deploy, { recursive: true, force: true });
  await mkdir(deploy, { recursive: true });
  let copied = 0;
  for (const name of INCLUDE) {
    const source = join(backend, name);
    const info = await stat(source);
    if (info.isDirectory()) copied += await copyDir(source, join(deploy, name));
    else { await cp(source, join(deploy, name)); copied++; }
  }
  if (website) {
    await copyDir(website, join(deploy, 'website'));
    // Cloudflare's Worker is not this deployment's router and must not be served as a public file.
    await rm(join(deploy, 'website', '_worker.js'), { force: true });
  }

  // migration 放進 image 裡，路徑與 Dockerfile 的 MIGRATIONS_DIR 對應。
  await cp(migrationsSrc, join(deploy, 'migrations'), { recursive: true });
  const migrations = (await readdir(join(deploy, 'migrations'))).filter((f) => f.endsWith('.sql'));

  // 讓人一眼看出這是產物、不要手改。
  await writeFile(
    join(deploy, 'README-DEPLOY.txt'),
    [
      '這是 prepare-deploy.ts 產生的部署目錄，不要手改、不要進版控。',
      '',
      `來源：${backend}`,
      `migration：${migrations.length} 個（來自 ${migrationsSrc}）`,
      '',
      '部署：cd .deploy && railway up',
      '',
    ].join('\n'),
    'utf8',
  );

  const size = await stat(deploy);
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'deploy dir ready',
      dir: deploy,
      files: copied,
      migrations: migrations.length,
      exists: size.isDirectory(),
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--website-dist')) throw new Error('usage: prepare-deploy [--website-dist PATH]');
  prepareDeploy(BACKEND, process.env.MIGRATIONS_DIR || MIGRATIONS_SRC, DEPLOY, args[1]).catch(() => {
    console.error('[prepare-deploy] failed; check source, migration and website directories');
    process.exitCode = 1;
  });
}
