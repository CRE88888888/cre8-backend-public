# Railway 測試網部署（backend#79）

僅限 `accurate-wisdom` 測試專案。使用者 2026-11-14 的 T 段授權不適用其他 Railway 專案、Cloudflare、正式網域或主網。這張沒有送公開 chain 97 交易；合約仍是本機 fork 的地址簿，服務先以停用模式交付。

## 來源與封裝

- contracts：乾淨 `git archive origin/main`，`068d471fc2c4592c12442ef35602ad1d1a7fe9c3`。`deploy/testnet-97.json` 是該版本的原始地址簿，供 keeper 讀取；其中 `gitCommit` 是產生 manifest 的程式版本，與地址簿提交版本分開記錄。
- backend：`src/testnet-profile.ts` 同步 manifest 的每個地址，保留既有 decimals、fee tier 與 admission caps；`src/testnet-codehashes.ts` 記錄同一個本機區塊擷取的 157 項 runtime hash。不能從主 clone 的未提交檔案產生地址，不能跳過 hash／selector 檢查。
- app：唯讀使用 `f531ec639ee0d12402c4189b0089d922cbbc2027`（#76），在家目錄外由 archive 建置。chain、RPC、API base、Privy app ID 都是建置時設定；所有 `VITE_*` 都會出現在公開 bundle，禁止放 secret。
- migration：來源仍是 db repo，這裡只封裝，不新增或修改 SQL。

```sh
bun install --frozen-lockfile
bun run typecheck
bun scripts/prepare-deploy.ts --website-dist "$APP_DIST"
```

執行前設定 `MIGRATIONS_DIR` 與 `APP_DIST`。worktree 的 migration 必須指向共用 db 的絕對路徑。封裝採 runtime 根目錄白名單，排除 `.env*`、log、symlink、套件快取、git 與未列入的檔案；網站不帶 Cloudflare `_worker.js`。`.deploy/` 是產物，禁止 commit。

## 服務與停用狀態

| 服務 | 用途 | 公開入口 | 上線前狀態 |
| --- | --- | --- | --- |
| Postgres | 測試環境獨立資料庫與 volume | 無 | 啟動 |
| api | 原本 HTTP API；啟動時 migrate | 無，僅私網 | 停用 |
| scheduler | 原本排程器 | 無 | 停用，保留 dry-run 預設 |
| alto | pin v1.2.5，自有 bundler | 無，僅 API relay | 停用 |
| price-keeper | 行情劇本與池子成交 | 無 | 停用 |
| points-sync | 定期執行 operator points sync 的同一個 production service | 無 | 停用 |
| website | app 靜態檔、SPA fallback、`/api` 私網代理 | Railway 臨時 HTTPS | 啟動，但 API 回停用 |

停用的應用與 alto 在 entrypoint 最前面攔下：只載入不依賴 DB／RPC／signer 的 readiness server。`/health` 回 HTTP 200 並明示 `disabled`；其他路徑回 503 `TESTNET_NOT_ACTIVATED`。這只證明容器可啟動，**不代表合約、登入或交易已上線**。不能把這個健康檢查當 strict preflight 的替代。

API 的 Railway pre-deploy command 另行執行 `bun src/migrate.ts`，只更新這個測試專案的 DB；本次已套用 30 個既有 migration。它不執行鏈上操作，也不會啟用 API 的交易路由。

每個服務單一副本。先壓低 CPU／記憶體上限，不設定自動擴容或付費外掛；正式啟用 alto／keeper 後需觀察資源與錯誤率，再由 C3 決定調整。Telegram 保持停用。

## 變數清單（只列名稱）

| 服務 | 名稱 |
| --- | --- |
| 共通應用 | `CHAIN_ID`、`PORT`、`SERVICE_ROLE`、`SERVICE_ENABLED`、`NODE_ENV` |
| Postgres | `POSTGRES_USER`、`POSTGRES_PASSWORD`、`POSTGRES_DB`、`PGDATA`、`DATABASE_URL` |
| api | `DATABASE_URL`、`MIGRATIONS_DIR`、`RPC_URL`、`REGISTRY_ADDRESS`、`EXECUTOR_ADDRESS`、`OPERATOR_PRIVATE_KEY`、`SESSION_KEY_MASTER_SEED`、`BUNDLER_URL`、`PAYMASTER_ADDRESS`、`PAYMASTER_MOCK_USDT_ADDRESS`、`PAYMASTER_SIGNER_PRIVATE_KEY`、`AUTH_DOMAIN`、`AUTH_URI`、`PRIVY_APP_ID`、`PRIVY_VERIFICATION_KEY`、`CORS_ALLOWED_ORIGINS`、`WEBSITE_PROXY_HOST`、`RATE_LIMIT_TRUSTED_PROXY_IPS`、`ENABLE_OPERATOR_REBALANCE`、`POINTS_ENABLED` |
| scheduler | `DATABASE_URL`、`MIGRATIONS_DIR`、`RPC_URL`、`REGISTRY_ADDRESS`、`EXECUTOR_ADDRESS`、`SESSION_KEY_MASTER_SEED`、`BUNDLER_URL`、`PAYMASTER_ADDRESS`、`PAYMASTER_MOCK_USDT_ADDRESS`、`PAYMASTER_SIGNER_PRIVATE_KEY`、`SCHEDULER_LIVE`、`SCHEDULER_INTERVAL`、`SCHEDULER_LIMIT`、`SCHEDULER_THRESHOLD_BPS` |
| alto | `SERVICE_ENABLED`、`CHAIN_ID`、`PORT`、`RPC_URL`、`EXECUTOR_PRIVATE_KEY`、`UTILITY_PRIVATE_KEY`、`ENTRYPOINTS`、`SAFE_MODE`、`MIN_EXECUTOR_BALANCE`、`MAX_BLOCK_RANGE` |
| price-keeper | `PRICE_KEEPER_ENABLED`、`PRICE_KEEPER_RPC_URL`、`PRICE_KEEPER_PRIVATE_KEY`、`PRICE_KEEPER_MANIFEST`、`PRICE_KEEPER_SCENARIO`、`PRICE_KEEPER_START_TIMESTAMP`、`PRICE_KEEPER_MIN_INVENTORY_E18`、`PRICE_KEEPER_INVENTORY_E18`、`PRICE_KEEPER_SWAP_BUDGET_E18` |
| points-sync | `DATABASE_URL`、`MIGRATIONS_DIR`、`RPC_URL`、`REGISTRY_ADDRESS`、`EXECUTOR_ADDRESS`、`PAYMASTER_ADDRESS`、`PAYMASTER_MOCK_USDT_ADDRESS`、`POINTS_ENABLED`、`POINTS_FROM_BLOCK`、`POINTS_CONFIRMATIONS`、`POINTS_DELAY_SECONDS`、`POINTS_SYNC_INTERVAL` |
| website | `API_INTERNAL_URL`、`WEBSITE_DIST` |
| app 建置 | `VITE_CHAIN_ID`、`VITE_RPC_URL`、`VITE_API_BASE`、`VITE_PRIVY_APP_ID`、`VITE_WALLETCONNECT_PROJECT_ID`、`VITE_LIVE_FUNDS` |
| 唯讀 preflight | `DEPLOYER_ADDRESS`、`BUNDLER_EXECUTOR_ADDRESS`、`ATP_SAFE`、`EXECUTOR_DEPLOYMENT_BLOCK` |

RPC 使用公開 BSC testnet HTTP 端點。現有 API 與 keeper 各收單一 URL，故障時停下並明確替換端點；不宣稱有自動多 RPC 備援。所有角色必須使用測試網專用金鑰，不把 deployer／owner key 放進任何服務。scheduler 不需要 operator key，points-sync 與 website 不持有任何簽名金鑰。

`SESSION_KEY_MASTER_SEED` 新建於 `~/.cre8-testnet/session-seed.txt`，權限 600；重部署沿用，不能無意輪替。角色金鑰只從 `~/.cre8-testnet/` 讀入程式記憶體，再經 stdin／GraphQL 變數送進服務設定；禁止貼在 CLI 參數、終端輸出或 PR。Privy 只放 app ID 與 verification public key，App Secret 不進 Railway。不要執行會印出 raw variables 的 CLI 查詢。

## 私網代理與限流

瀏覽器只連 website；website 將 `/api` 前綴剝掉後轉送到固定的 API 私網 origin，保留 bearer token、HTTP 狀態與 Retry-After，代理逾時或連線失敗只回安全的 502。API 與 alto 不建立公開 domain。

Railway 的 `X-Forwarded-For` 含額外代理 hop，不能取最右側當使用者。以本專案的正常請求、偽造 XFF 與偽造 X-Real-IP 實測後，website 使用 Railway **覆寫的 `X-Real-IP`**，重建單一 client IP 的 XFF 送給 API；不轉送客戶端提供的 XFF。`scripts/testnet-api.ts` 啟動時解析 `WEBSITE_PROXY_HOST` 的私網 DNS，將**精確 IP**填入 `RATE_LIMIT_TRUSTED_PROXY_IPS`；解析失敗就停止啟動，不信任整段 CIDR 或任意 socket。website 重部署／IP 改變後，必須重啟 API 重新解析。僅允許 Railway edge 作為網站公開入口，不在其他未驗證 header 行為的平台直接使用這個設定。上線前再用兩個不同網路驗證限流沒有共用同一額度。

## 上線前清單與順序（尚需 C3 另行授權公開鏈操作）

- [ ] 使用者在 Privy 開啟 **Return user data in an identity token**。目前尚未開啟；後端 `/auth/privy` 驗的是 identity token。
- [ ] 使用者將 Railway 網站臨時 origin 加入 Privy allowed origins，確認 email／Google／X 的回跳設定；由真使用者在手機走登入驗收。
- [ ] C1 完成公開 chain 97 部署、角色 tBNB、paymaster deposit，交付 `mode: public` 地址簿與 executor 建立區塊。
- [ ] 逐一核對公開 manifest 與這次 fork 的 CREATE2 地址；157 項 codehash／selector 全通過。任一不同即停，重走對應 lane 的同步流程。
- [ ] 先啟 API、套用封裝 migration。API 的交易端點在此階段仍須限制外部使用；下列 alto／keeper 準備好後，再統一跑 chain 97 strict preflight，確認私網、DB、operator、paymaster、bundler、oracle 均正常。
- [ ] **部署後第 30–60 分鐘啟動價格 keeper**，之後每池每小時至少一筆會動到 tick 的成交；超過 1 小時未成交 oracle 會停報價。secondary 維持 1 小時，AVAX 1 天；USDT feed 同樣必須續推。第一次啟用設定新的劇本起始時間，不能沿用 fork 時間。
- [ ] 啟用 alto，確認 safe-mode、不同 executor／utility key 與 EntryPoint v0.7；啟用代付前核對額度與餘額。
- [ ] scheduler 先觀察 dry-run，再由 C3 決定 live；operator rebalance 預設關閉不變。
- [ ] 設定積分掃描起點為活動真正起點，啟用 points 與 points-sync；不需要給 worker operator bearer 或私鑰。
- [ ] 驗證 XFF 防偽與多使用者限流，再走真網站登入 → 加入基金 → 領幣 → 自動買入 → 提領。手機與 Privy 真登入不以 SIWE 本機測試替代。

## 重部署、回滾與停機

每次操作先以 project token 查核專案名稱、ID 與 environment；只允許本張測試專案。不使用全帳號 token，不執行建立新專案的快捷指令。CLI 安裝在任務暫存目錄，完成後清除。

重新由乾淨 app main 建置、用 frozen lockfile 封裝 backend 與 migrations，掃描 `.deploy/` 的 secret，再指定服務上傳：

```sh
railway up .deploy --path-as-root --no-gitignore --detach --service api --project "$TESTNET_PROJECT_ID"
```

其他 backend 角色使用相同產物；alto 的 context 是 `alto/`，不可誤傳到 Postgres。每次部署記錄 backend commit、app commit、manifest commit、migration 版本及 deployment ID。等待 Railway deployment 成功與 `/health` 的內容，不能只看 upload 成功。啟用的 scheduler／keeper／points-sync 沒有 HTTP health endpoint，要移除該服務的 HTTP healthcheck，改看成功輪次、scheduler heartbeat 與故障退出；停用階段則保留 readiness healthcheck。

回滾前先停用 scheduler、keeper、alto、points-sync 與 API 的交易能力；保留 DB volume 與 session seed，再回到已記錄的相容 deployment／封裝版本。只把 scheduler 切回 dry-run 不足以停掉其他角色。migration 有 checksum，**不修改已套用 SQL、不刪 DB、不自動降 schema**；舊版不相容時維持停用，由 C3 協調 db lane。不能靠回滾應用撤銷鏈上交易。keep-alive／進程狀態與舊 DNS 必須重驗。

## 驗收紀錄

最終 PR 附實際指令、pass／skip／fail、服務 deployment 與健康狀態。上面未勾選的項目屬公開上線前置，不能宣稱完成公開端到端操作。暫存包含乾淨 archive、依賴、build、fork log、CLI 與部署產物，交付後清除；保留 worktree 供 C3 合併後處理。

本機驗收使用 8556／8092／3056 與 `cre8_x1b`；EOA setup 與 UserOp 分別設定本機 base fee，UserOp 費率取唯讀公開測試網報價。anvil 的建議 tip 與空區塊 base fee 可能不一致，不能靠提高產品每日 gas／美元預算掩蓋。`test/testnet-97.e2e.ts` 額外需要 `TESTNET_ACCEPTANCE_GAS_PRICE_WEI`，僅在確認本機 anvil 後調整本機費率。測試實際包含 owner 清倉、paymaster 代付與完整 USDT 轉出。

本機 points sync 的掃描起點要涵蓋本次部署歷史，但不能包含 fork 所匯入的上游區塊：本次對 fork 區塊查 logs 回 RPC -32603，從第一個本機區塊開始則正常，沒有調高 timeout 或略過既有活動。公開鏈的起點仍由 C3 按實際活動部署區塊設定，不能把本機塊號帶去公開環境。

dry run 揭露 #77 的既有送單回歸：`prepareUserOperation()` 產生的 stub signature 被直接送進 viem，viem 會原樣送出該簽章，alto 因而拒絕 `AA24`。本張必要小修在 `src/scheduler.ts` 明確用 session key 簽最終 gas／paymaster 欄位，再送出；沒有調整 gas 上限或放寬驗證。

2026-11-15 交付：僅此測試專案，Hobby、每服務單一副本、CPU 上限各 0.25 vCPU；網站記憶體上限 0.125 GB、alto 0.5 GB，其餘各 0.25 GB。Postgres 18.6 的 volume 已就緒，所有 7 個 deployment 為 SUCCESS。網站臨時入口：<https://website-production-d8e9f7cc.up.railway.app>；網址中的 production 是測試專案的 environment 名稱。

| 服務 | 已驗證的 deployment ID |
| --- | --- |
| Postgres | `4f3eb87b-fdb7-4854-af3a-7ec718f64150` |
| api | `9fa88320-9dde-47ed-8f12-9b85f20c5690` |
| scheduler | `3adf18c5-74b7-43d7-b3af-27b0ae9fb993` |
| alto | `822a3930-1263-4b1e-9e7c-b5608041f5c8` |
| price-keeper | `d7a82a59-552b-4b67-8781-672cbee4c4c3` |
| points-sync | `b861d01d-d9c2-4055-b398-fc7d4d9586cb` |
| website | `9da135bd-abdf-42a0-bb85-00806f1ea14d` |

本機 backend E2E：22 pass／0 skip／0 fail；strict preflight：254 ok／0 warn／0 fail。Railway HTTP（含入口資產、SPA、代理、停用與禁止檔案）：40 pass／0 skip／0 fail；Railway header 防偽：3 pass／0 skip／0 fail。真 Privy／手機與兩個不同用戶網路的操作沒跑，需使用者完成上線清單；瀏覽器視覺驗收沒跑，這次 browser access host 無法連線。價格 keeper 的兩小時測試另屬原本 8557 驗收環境，這張未重跑該長測試。

keeper 在本張 8556 上另做唯讀設定驗證：3 pass／0 skip／0 fail，涵蓋 38 個市場的地址、minter／keeper 權限、oracle／secondary 接線與即時 observation。`bun scripts/points-sync.ts --once` 也在本機 fork／DB 實際完成一輪（exit 0）；這個 worker 不送鏈上交易。
