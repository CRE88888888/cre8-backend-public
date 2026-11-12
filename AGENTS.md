# AGENTS.md — cre8-atp-backend

給 AI agent 與新工程師的工作規則。細節以 `README.md` 與 `docs/*.zh-TW.md` 為準；這份只寫查證過的事實與規則。

**開工前必讀：** 誰能在本 repo 工作、怎麼開 issue 與 PR、本機用哪些埠，一律以 [docs/AGENT_COLLABORATION](https://github.com/CRE8Finance/docs/blob/main/docs/AGENT_COLLABORATION.zh-TW.md) 為準（本機在 `~/Desktop/cre8-workspace/docs/docs/AGENT_COLLABORATION.zh-TW.md`）。只有擁有本 repo 的 lane 能開分支、commit、push；其他 lane 只能讀、執行、開 issue。

## 這個 repo 是什麼

CRE8 ATP 的鏈下 API ＋ 排程器。Bun + TypeScript，直接用 `pg`、**不用 ORM**，HTTP 是 `node:http`（`src/server.ts`）。預設鏈 BNB Chain mainnet（`CHAIN_ID=56`），本機 fork 用 1337。
與其他 repo 的介面（只列程式碼裡看得到的）：
- `db`：schema 與 migration **不在這裡**。`src/db.ts` 預設讀 `../db/migrations`（`db/` 要與 `backend/` 並排 checkout），可用 `MIGRATIONS_DIR` 覆寫；`migrate()` 在啟動時與 `bun run migrate` 套用（sha256 checksum + advisory lock，已套用的檔案被改會報錯）。
- `cre8-contracts`：合約位址走 env（`REGISTRY_ADDRESS`、`EXECUTOR_ADDRESS`），主網現況記在 `docs/production-state.zh-TW.md`；ABI 是 `src/chain.ts` 裡手寫的最小 ABI。`src/pricing.ts` 必須與 `src/atp/PancakeV3TwapOracle.sol` 算出同一個數字；`src/rebalance-plan.ts` 產生給 `AtpExecutor` 執行的 `SwapStep[]`。
- `cre8-app`：瀏覽器打這支 API（CORS 預設允許 `http://localhost:5173`，見 `CORS_ALLOWED_ORIGINS`）；登入是 SIWE（EIP-4361）。瀏覽器不能直連 alto bundler，UserOp 一律經 `POST /bundler` relay。
- `alto/`：自架 bundler 的 Railway 設定（pin v1.2.5，理由見 `alto/README.md`）。

## 目錄地圖

- `src/` 程式本體：`index.ts`（啟動：config → migrate → listen）、`server.ts`（路由）、`config.ts`（env）、`db.ts`、`auth.ts`、`strategies.ts`、`portfolios.ts`、`scheduler.ts`、`rebalance-plan.ts`、`pricing.ts`、`addresses.ts`（Kernel／Pancake 主網常數）
- `test/`：`bun test`；`test/fixtures/kernel-golden.json` 是 Kernel 編碼的 golden 資料
- `scripts/`：`scheduler.ts`（排程器入口）、`preflight.ts`（部署前檢查）、`prepare-deploy.ts`（組 `.deploy/`）、fork 整合／資金腳本
- `docs/`：`pitfalls`（踩過的坑）、`decisions`、`deploy-railway`、`mainnet-runbook`、`mainnet-todo`、`production-state`
- `Dockerfile` + `docker-entrypoint.sh`：同一個 image，`SERVICE_ROLE=api|scheduler`

## 常用指令

需求 Bun >= 1.4（CI 用 1.4.4）。bun 直接跑 TS，沒有 build 步驟。
```bash
bun install --frozen-lockfile
cp .env.example .env          # DATABASE_URL 必填，其餘見 .env.example
bun run dev                   # 需 DATABASE_URL + ../db/migrations（啟動會先 migrate）
bun run migrate               # 只套 migration
bun run typecheck             # src + test + scripts 三份 tsconfig，不需 env
bun test                      # 完整測試需要可拋棄的 Postgres（DATABASE_URL），見下
bun run scripts/scheduler.ts --once   # 預設 dry-run；--live 才會送交易
bun run preflight             # 讀 .env、打真鏈與 DB 檢查設定
```
測試與 DB：auth session 存在 Postgres（`auth_sessions`），所以沒有 DB 時 auth／renewal／portfolios／operator／strategies 的 HTTP 測試會失敗（不是 skip）。不需要 DB 的檔案清單在 `.github/workflows/ci.yml`。`RUN_CHAIN_TESTS=1` 會真的送鏈上交易：只對本機 anvil fork 跑，且要加 `--timeout=120000`、不要用 `--concurrent`（README §會送鏈上交易的測試）。
部署：Railway，先 `bun run scripts/prepare-deploy.ts` 組 `.deploy/`（含 migration），再 `cd .deploy && railway up`；細節與陷阱見 `docs/deploy-railway.zh-TW.md`、`docs/mainnet-runbook.zh-TW.md`。

## 開 PR 前必跑（與 CI 一致）

1. `bun install --frozen-lockfile`（lockfile 有變就一起 commit `bun.lock`）
2. `bun run typecheck`
3. CI 的 no-DB 測試清單：`DATABASE_URL=postgres://ci:ci@127.0.0.1:1/unused bun test <ci.yml 裡的檔案>`
4. 動到 DB／auth／路由時，另外對可拋棄的 Postgres 跑完整 `bun test`，在 PR 的「怎麼驗證」寫結果

## 規則與地雷

- 改動只做被要求的部分，不順手重構；不確定就問，不要猜。
- Secret 不進版控：`.env` 已在 `.gitignore`。`OPERATOR_PRIVATE_KEY`、`SESSION_KEY_MASTER_SEED`、`DATABASE_URL`、RPC URL 不寫進 repo、log 或 PR。session key 私鑰永不落 DB（只存派生路徑）。
- 這是**主網、動真錢**的服務：scheduler 預設 dry-run（`SCHEDULER_LIVE=1` 才 `--live`）、`ENABLE_OPERATOR_REBALANCE` 預設關。不要改成預設開；不要對主網跑會送交易的腳本或測試。
- README 裡的 anvil 私鑰是公開測試金鑰，只能用在本機 fork。
- migration 檔屬於 `db` repo，這裡不新增、不修改 SQL；已套用的 migration 不能改（checksum 會擋）。
- 依賴版本：`@scure/bip32`、`@zerodev/permissions` 是精確版本；升級會影響 session key 派生與 Kernel 權限編碼，必須讓 `test/kernel.test.ts`（golden）通過。安裝一律 frozen lockfile。
- `tsconfig.scripts.json` 排除了兩支已知有型別錯誤的 script，修好再拿掉 exclude，不要放寬 strict。
- 先查 `docs/pitfalls.zh-TW.md`：bundler／Kernel／fork 的錯誤訊息常常誤導。
- `.bun-cache/` 是本機套件快取，已排除版控；不要加入 commit。

## Commit / PR 慣例

- commit 標題：繁體中文一句話，直接寫做了什麼或修了什麼（例：`停用 V2 路由：Pancake Universal Router 不認 V2_SWAP_EXACT_IN（實測裸 0x revert）`）。
- 較大的改動在 body 用 `## 問題` / `## 根因` / `## 修法` 說明，並寫測試結果（幾 pass／skip／fail）。
- PR 用 `.github/pull_request_template.md`；「風險」一欄要寫是否影響主網資金、DB schema、對外 API、部署。
