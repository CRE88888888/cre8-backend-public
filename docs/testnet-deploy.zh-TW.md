# Railway 測試網部署（backend#79）

僅限 `accurate-wisdom` 測試專案。使用者 2026-11-14 的 T 段授權不適用其他 Railway 專案、Cloudflare、正式網域或主網。下列 #79／#87 是停用階段的歷史紀錄；#136 已同步公開 chain 97 地址簿，啟用狀態以部署回報為準。

## #136 公開 manifest 同步

來源是 contracts main `6b9b6a45391eb3afa70ffc880a59ef3bfa10e3ec` 的完整 manifest，
`mode=public`、`gitCommit=92e6963848d106ab9dc86334928af11b708c1dfa`。
使用該 commit 的乾淨暫時 checkout，先編譯並保存 unlinked YieldView artifact，
再以 manifest 的 YieldView 地址連結編譯其餘合約。只讀公開 chain 97 RPC，
本機 anvil 固定在公開區塊 **143099686**（不挖礦、不部署、不改 state）：

```sh
bun --no-env-file scripts/sync-testnet-profile.ts "$CONTRACTS_CHECKOUT" \
  http://127.0.0.1:8566 public 6b9b6a4 "$UNLINKED_YIELD_VIEW_ARTIFACT"
```

腳本核對 artifact 全部 source hashes、registry／executor／yieldRegistry／YieldView 的
完整 runtime（僅遮 compiler-declared immutable slots）、P11 selectors 與 registry reader。
其後 `checkTestnetProfile` 對同一個固定區塊核對全部 **381** 項 codehash／必要 selectors，
結果 **381 ok／0 warn／0 fail**。公開 CREATE2 地址與先前 fork 相同，所有 runtime pins
也相同；仍重新讀取、產生來源證據、profile、ABI 與 golden，沒有沿用未驗證結果。
這是 profile 同步驗證，不能代替部署後含 DB、oracle、餘額與角色設定的 strict preflight。

#136 啟用設定沿用下列 #97 額度，僅將帳戶部署餘額門檻按 C3 派工設為
`ACCOUNT_DEPLOYMENT_MIN_BALANCE_WEI=10000000000000000`。scheduler 維持 dry-run、
operator rebalance 與 points 關閉，points-sync 維持停用。SIWE 目前只接受單一 domain／URI，
使用 `tst.cre8.finance`／`https://tst.cre8.finance`；加入 CORS origin 不會擴大 SIWE domain。
本次部署結果與 deployment IDs 寫在 `/tmp/cre8-codex/railway-report.md`，不含秘密。
依 #136 最新 C3 指示，測試專案不使用 config-as-code 或 IaC；`railwayConfigFile` 維持 null，
以 `serviceInstanceUpdate` 設定 healthcheck／restart policy。封裝加 `--no-config-as-code`，
排除所有 `railway.json`／`railway.toml`，避免上傳檔覆蓋服務設定；正式環境的既有設定不變。
平台若無法清除 worker 的 healthcheck，保留 `/health`；啟用的 chain 97 scheduler loop／keeper
提供 process readiness，結束或啟動失敗時關閉。這不取代成功輪次、heartbeat、
keeper 成交與 strict preflight；`--once`／`--alerts` 不啟 HTTP。

## 來源與封裝

- contracts：目前 repo 地址簿由 #85 完整同步 contracts PR #49，manifest `gitCommit=2052c828b0c8afddfd8d98bd0b5fc6207268fc05`，forge 驗收 checkout 為 `74d22927f7399da8f3f4d320a784e99379305084`（92 資產、30 個生息市場）。`deploy/testnet-97.json` 是原始地址簿，供 keeper 讀取；目前 `mode=fork`，不代表公開部署。#79 已部署的舊產物來源仍是乾淨 archive `068d471fc2c4592c12442ef35602ad1d1a7fe9c3`，#85 沒有更新 Railway。
- backend：`scripts/sync-testnet-profile.ts` 重產 `src/testnet-profile-data.ts`，由 `src/testnet-profile.ts` 匯出；同步 manifest 的每個地址與 decimals／fee tier，原 38 個 admission caps 不變，其餘 54 個各 5,000 MockUSDT。`deploy/testnet-97-codehashes.json` 與 `src/testnet-codehashes.ts` 記錄同一個本機區塊擷取的 380 項 runtime hash，包含生息 target／receipt；重產與來源核對見 [BE-4 交接](yield-userops.zh-TW.md#部署與重產)。不能從主 clone 的未提交檔案產生地址，不能跳過 hash／selector 檢查。
- app：唯讀使用 `f531ec639ee0d12402c4189b0089d922cbbc2027`（#76），在家目錄外由 archive 建置。chain、RPC、API base、Privy app ID 都是建置時設定；所有 `VITE_*` 都會出現在公開 bundle，禁止放 secret。
- migration：來源仍是 db repo，這裡只封裝，不新增或修改 SQL。

```sh
bun install --frozen-lockfile
bun run typecheck
bun scripts/prepare-deploy.ts --website-dist "$APP_DIST" --no-config-as-code
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

## 變數清單（只列名稱與非秘密值）

| 服務 | 名稱 |
| --- | --- |
| 共通應用 | `CHAIN_ID`、`PORT`、`SERVICE_ROLE`、`SERVICE_ENABLED`、`NODE_ENV` |
| Postgres | `POSTGRES_USER`、`POSTGRES_PASSWORD`、`POSTGRES_DB`、`PGDATA`、`DATABASE_URL` |
| api | `DATABASE_URL`、`MIGRATIONS_DIR`、`RPC_URL`、`REGISTRY_ADDRESS`、`EXECUTOR_ADDRESS`、`OPERATOR_PRIVATE_KEY`、`SESSION_KEY_MASTER_SEED`、`BUNDLER_URL`、`PAYMASTER_ADDRESS`、`PAYMASTER_MOCK_USDT_ADDRESS`、`PAYMASTER_SIGNER_PRIVATE_KEY`、`AUTH_DOMAIN`、`AUTH_URI`、`PRIVY_APP_ID`、`PRIVY_VERIFICATION_KEY`、`CORS_ALLOWED_ORIGINS`、`WEBSITE_PROXY_HOST`、`RATE_LIMIT_TRUSTED_PROXY_IPS`、`OPERATOR_WALLETS`、`ENABLE_OPERATOR_REBALANCE`、`POINTS_ENABLED` |
| scheduler | `DATABASE_URL`、`MIGRATIONS_DIR`、`RPC_URL`、`REGISTRY_ADDRESS`、`EXECUTOR_ADDRESS`、`SESSION_KEY_MASTER_SEED`、`BUNDLER_URL`、`PAYMASTER_ADDRESS`、`PAYMASTER_MOCK_USDT_ADDRESS`、`PAYMASTER_SIGNER_PRIVATE_KEY`、`SCHEDULER_LIVE`、`SCHEDULER_INTERVAL`、`SCHEDULER_LIMIT`、`SCHEDULER_THRESHOLD_BPS`、`OPERATOR_ADDRESS`、`MIN_RELAYER_GAS_WEI` |
| alto | `SERVICE_ENABLED`、`CHAIN_ID`、`PORT`、`RPC_URL`、`EXECUTOR_PRIVATE_KEY`、`UTILITY_PRIVATE_KEY`、`ENTRYPOINTS`、`SAFE_MODE`、`MIN_EXECUTOR_BALANCE`、`MAX_BLOCK_RANGE` |
| price-keeper | `PRICE_KEEPER_ENABLED`、`PRICE_KEEPER_RPC_URL`、`PRICE_KEEPER_PRIVATE_KEY`、`PRICE_KEEPER_MANIFEST`、`PRICE_KEEPER_SCENARIO`、`PRICE_KEEPER_START_TIMESTAMP`、`PRICE_KEEPER_MIN_INVENTORY_E18`、`PRICE_KEEPER_INVENTORY_E18`、`PRICE_KEEPER_SWAP_BUDGET_E18` |
| points-sync | `DATABASE_URL`、`MIGRATIONS_DIR`、`RPC_URL`、`REGISTRY_ADDRESS`、`EXECUTOR_ADDRESS`、`PAYMASTER_ADDRESS`、`PAYMASTER_MOCK_USDT_ADDRESS`、`POINTS_ENABLED`、`POINTS_FROM_BLOCK`、`POINTS_CONFIRMATIONS`、`POINTS_DELAY_SECONDS`、`POINTS_SYNC_INTERVAL` |
| website | `API_INTERNAL_URL`、`WEBSITE_DIST` |
| app 建置 | `VITE_CHAIN_ID`、`VITE_RPC_URL`、`VITE_API_BASE`、`VITE_PRIVY_APP_ID`、`VITE_WALLETCONNECT_PROJECT_ID`、`VITE_LIVE_FUNDS` |
| 唯讀 preflight／選配警示 | `DEPLOYER_ADDRESS`、`BUNDLER_EXECUTOR_ADDRESS`、`ATP_SAFE`、`EXECUTOR_DEPLOYMENT_BLOCK`、`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID` |

RPC 使用公開 BSC testnet HTTP 端點。API／scheduler 與 keeper 各收單一 URL，另有一份免金鑰的公開節點清單備援（`src/rpc-transport.ts` 的 `PUBLIC_RPCS_97`，四個節點；keeper 見 `src/keeper/README.md`「失敗時怎麼處理」）：某個節點回 403／429／5xx、逾時或回傳不是 JSON 時，該請求改問下一個節點，壞掉的節點 60 秒內排到最後；全部節點都失敗才算失敗。scheduler 的大量讀取只用公開節點，不會落到 RPC_URL。所有角色必須使用測試網專用金鑰，不把 deployer／owner key 放進任何服務。scheduler 不需要 operator key；relayer 監控設定公開 `OPERATOR_ADDRESS`（chain 97 profile 的 operator）及 `RPC_URL`，以唯讀 client 查餘額。points-sync 與 website 不持有任何簽名金鑰。Telegram 兩個變數必須成對設定或全部留空。

`SESSION_KEY_MASTER_SEED` 新建於 `~/.cre8-testnet/session-seed.txt`，權限 600；重部署沿用，不能無意輪替。角色金鑰只從 `~/.cre8-testnet/` 讀入程式記憶體，再經 stdin／GraphQL 變數送進服務設定；禁止貼在 CLI 參數、終端輸出或 PR。Privy 只放 app ID 與 verification public key，App Secret 不進 Railway。不要執行會印出 raw variables 的 CLI 查詢。

## chain 97 額度與安全開關（backend#97）

API 與 scheduler 核對下列相同值；設定只在 C3 授權的部署步驟套用，本次沒有更動 Railway。
`ACCOUNT_DAILY_GAS_USD_E8`、`PAYMASTER_ACCOUNT_DAILY_WEI` 必須留空；填 `0` 會阻擋正成本普通操作。

```dotenv
CHAIN_ID=97
NODE_ENV=production
MIGRATIONS_DIR=/app/migrations
ACCOUNT_DAILY_GAS=100000000
ACCOUNT_DAILY_GAS_USD_E8=
PAYMASTER_ACCOUNT_DAILY_COUNT=60
PAYMASTER_ACCOUNT_DAILY_GAS=100000000
PAYMASTER_ACCOUNT_DAILY_WEI=
PAYMASTER_SITE_DAILY_GAS=200000000
PAYMASTER_SITE_DAILY_WEI=100000000000000000
PAYMASTER_MIN_DEPOSIT_WEI=10000000000000000
FAUCET_USDT_AMOUNT_WEI=1000000000000000000000
FAUCET_USDT_SITE_DAILY_WEI=1000000000000000000000000
WELCOME_USDT_SITE_DAILY_WEI=5000000000000000000000000
MIN_STEP_USD_E8=100000000
MIN_BATCH_USD_E8=5000000000
MIN_DEPOSIT_USD_E8=5000000000
POINTS_ENABLED=0
SCHEDULER_LIVE=0
ENABLE_OPERATOR_REBALANCE=0
RATE_LIMIT_STRATEGIES_PER_DAY=10
RATE_LIMIT_VERSIONS_PER_DAY=50
RATE_LIMIT_PORTFOLIOS_PER_DAY=20
ACCOUNT_DEPLOYMENTS_PER_DAY=300
ACCOUNT_DEPLOYMENT_MIN_BALANCE_WEI=50000000000000000
RATE_LIMIT_ENROLLMENT_PER_MINUTE=30
```

`SERVICE_ROLE`、`PORT` 依服務設定；未完成啟用驗收前 `SERVICE_ENABLED=0`。
代付 signer 仍由 API／scheduler 的秘密變數提供；不能把 signer 私鑰換成公開地址。
strict preflight 除 codehash 外還查 signer／EntryPoint、deposit 低水位、operator isFaucet、registry numeraire 與非零額度；缺資料或 RPC 失敗都拒絕通過。
執行 `bun scripts/preflight.ts --chain 97 --strict` 只查詢、不送交易。

代付授權有效 5 分鐘。同一筆 nonce、initCode、calldata 與 gas／fee 欄位的重試，
在原有效期內重建原授權並回原 UserOp hash；API 重啟、跨秒或 UTC 日期切換都不新增保留額。
client 重送的 validUntil 不會延長原授權。到期續簽新增一次 paymaster 帳戶次數／gas／全站保留額，
原保留額不退款；execution gas budget 仍維持同一筆。低水位警示由 scheduler 既有 gas_low 路徑送出。

本機 opt-in 驗收 `test/welcome-grants.fork.ts`、`test/testnet-97.e2e.ts` 必須明設
`CHAIN_ID=97`、`RPC_URL`、`PORT`、`DATABASE_URL`、`TEST_DATABASE_NAME`（須與 DB 名稱一致）。
E2E 另需 `BUNDLER_URL`；三個服務埠必須互異，RPC／bundler／DB 都限 localhost。
腳本仍驗 `anvil_nodeInfo` 與 RPC chain 97 後才操作；只使用分配給本 worktree 的埠與 DB。
worktree 的 `MIGRATIONS_DIR` 指向共用 db 的絕對路徑，不修改 db repo。

`POST /faucet/usdt` 先驗登入與帳戶擁有者。同一 owner／同一帳戶／同一 UTC 日重送時，
回 HTTP 200、`replayed=true` 及原 claimId／txHash／state／amountWei；reserved、submitted、unknown、confirmed、failed 都不另準備交易。
reserved／unknown 等狀態仍代表未完成，200 只表示成功讀回原紀錄。首次新送單結果 unknown 仍回 202，首次 definitive failed 仍回 502。
當天有非 failed claim 卻換另一個帳戶時回 429。failed 釋放的額度只允許新的領取語意（另一個帳戶）；同帳戶同日仍回原 failed，不自動再 mint。
全站 cap／當日一次額度只限制新 reservation；DB 讀取失敗不 fallback 或發新交易。

**0037 部署前置：** 本單需先套用 db#41 的 0037，再啟動新版 writer；舊 writer 的 submitted/hash 更新會被 guard 拒絕。原始已簽交易與 submitted/hash 在同一個短交易內提交，commit 回應遺失時不廣播。outbox 是可廣播授權資料，部署帳號僅授予後端所需 SELECT／INSERT；不得暴露到 HTTP、通用查詢、log 或 DB statement／parameter logging。稽核資料永久保留，不清除或替換原交易。

scheduler 每輪先對帳 chain 97 relayer，不需要 operator key。預設 dry-run 只查原交易的 canonical receipt 並結算已知結果；只有明確 `--live`／`SCHEDULER_LIVE=1` 才重播 DB 保存的同一筆 signed bytes。hash、簽章、chain、nonce、token、recipient、calldata、amount 或 receipt 證據不符時保留未決；RPC／DB 失敗、逾時、舊 hash-only 資料也不解鎖、不退款、不準備替代交易。失敗輪次下輪再試。迎新走 `welcomeFor(account)`，operator 須有 `isFaucet`，無 USDT minter 權限；每日走 `claimFor(account, amount)`，上限 1,000。

每日建基金／發版本限額預設 10／50，由 `RATE_LIMIT_STRATEGIES_PER_DAY`、`RATE_LIMIT_VERSIONS_PER_DAY` 設定。依登入 owner／action／DB UTC 日原子記錄到 `daily_operation_counts`，重啟與多實例共用；等於上限允許，0 禁止，超過回 429 與 Retry-After。這是 action 前消耗的嘗試額度，body 或 action 失敗也計數；DB 錯誤／逾時／未知 commit 回 503，不自動重試扣額或 fallback。scheduler live 只清除七個完整 UTC 日以前的計數，未啟 live 時舊資料保留，不影響正確性。短窗口的登入／查詢限額仍使用記憶體。

Chain 97 的加入額度在 operator 首次實際嘗試廣播帳戶部署前才消耗：每 owner／UTC 日預設 20 次（`RATE_LIMIT_PORTFOLIOS_PER_DAY`），全站預設 300 次（`ACCOUNT_DEPLOYMENTS_PER_DAY`）。兩者在同一 DB 交易原子扣額；拒絕時整筆回滾，未知 COMMIT 不廣播、不自動退款。全站計數沿用 `daily_operation_counts`，以固定 MetaFactory 合約地址＋`join` 作保留 namespace，不因登入 owner 或 operator 輪替重置。每錢包超限回 429；全站超限回 503 `ACCOUNT_DEPLOYMENT_DAILY_LIMIT`。送出前以 pending 區塊讀 operator 原生幣餘額，低於 `ACCOUNT_DEPLOYMENT_MIN_BALANCE_WEI`（預設 0.05 tBNB）回 503 `ACCOUNT_DEPLOYMENT_LOW_BALANCE`，等於門檻允許。DB／餘額 RPC 不可用皆不廣播；已部署直接跳過。已簽名但尚未廣播的交易只有程序內副本，重啟後仍沿用 getCode 守衛，不是部署 outbox。

`enrollment-params`（含 `POST /portfolios`）與 `enrollment-confirm` 各有獨立每 owner／分鐘預設 30 次的短期限流（`RATE_LIMIT_ENROLLMENT_PER_MINUTE`）。同 intent 輪詢、部署中的 202、已部署重試與確認不再重扣每日部署額度；短窗口超過回 429。非 97 的加入路由維持既有每日 20 次語意。

**contracts#48／#49 與地址同步：** #85 已完整替換本 repo 的 chain 97 manifest、profile、ABI 與 380 項 runtime pins，含新 executor／yieldRegistry。DB 資產資料與 APP 仍須由各 lane 同步；生息須等 0036 adapter、BE-3 整合及 APP-3 驗收，沒有新增開關或 HTTP 路由。不得把本單 CI／本機測試視為可公開部署，公開啟用仍須下列清單。`test/relayer-recovery.fork.ts` 的隔離 manifest override 是既有驗收方式，不代表目前 repo 仍使用舊地址簿。

keeper 不再查 USDT isMinter，也不 mint USDT；使用合約部署時預撥的 2,000,000 USDT，低於庫存門檻即停止並告警，需由營運補庫存後手動重啟。其他 mock 資產仍檢查 minter 並補庫存。1 小時最低費窗口的預留／釋放不在本單，另單對齊。

## 私網代理與限流

瀏覽器只連 website；website 將 `/api` 前綴剝掉後轉送到固定的 API 私網 origin，保留 bearer token、HTTP 狀態與 Retry-After，代理逾時或連線失敗只回安全的 502。API 與 alto 不建立公開 domain。

Railway 的 `X-Forwarded-For` 含額外代理 hop，不能取最右側當使用者。以本專案的正常請求、偽造 XFF 與偽造 X-Real-IP 實測後，website 使用 Railway **覆寫的 `X-Real-IP`**，重建單一 client IP 的 XFF 送給 API；不轉送客戶端提供的 XFF。`scripts/testnet-api.ts` 啟動時解析 `WEBSITE_PROXY_HOST` 的私網 DNS，將**精確 IP**填入 `RATE_LIMIT_TRUSTED_PROXY_IPS`；解析失敗就停止啟動，不信任整段 CIDR 或任意 socket。website 重部署／IP 改變後，必須重啟 API 重新解析。僅允許 Railway edge 作為網站公開入口，不在其他未驗證 header 行為的平台直接使用這個設定。上線前再用兩個不同網路驗證限流沒有共用同一額度。

## 上線前清單與順序（尚需 C3 另行授權公開鏈操作）

- [ ] 使用者在 Privy 開啟 **Return user data in an identity token**。目前尚未開啟；後端 `/auth/privy` 驗的是 identity token。
- [ ] 使用者將 Railway 網站臨時 origin 加入 Privy allowed origins，確認 email／Google／X 的回跳設定；由真使用者在手機走登入驗收。
- [ ] C1 完成公開 chain 97 部署、角色 tBNB、paymaster deposit，交付 `mode: public` 地址簿與 executor 建立區塊。
- [ ] 逐一核對公開 manifest 與目前 fork 的 CREATE2 地址；380 項 runtime pins 與必要 selector 全通過。任一不同即停，重走對應 lane 的同步流程。
- [ ] 先啟 API、套用封裝 migration。API 的交易端點在此階段仍須限制外部使用；下列 alto／keeper 準備好後，再統一跑 chain 97 strict preflight，確認私網、DB、operator、paymaster、bundler、oracle 均正常。
- [ ] **部署後第 30–60 分鐘啟動價格 keeper**，之後每池每小時至少一筆會動到 tick 的成交；超過 1 小時未成交 oracle 會停報價。secondary 維持 1 小時，AVAX 1 天；USDT feed 同樣必須續推。第一次啟用設定新的劇本起始時間，不能沿用 fork 時間。
- [ ] 啟用 alto，確認 safe-mode、不同 executor／utility key 與 EntryPoint v0.7；啟用代付前核對額度與餘額。
- [ ] scheduler 先觀察 dry-run，再由 C3 決定 live；operator rebalance 預設關閉不變。
- [ ] 維持 `POINTS_ENABLED=0`、points-sync 停用；測試網不做積分、任務與邀請碼。
- [ ] 驗證 XFF 防偽與多使用者限流，再走真網站登入 → 加入基金 → 領幣 → 自動買入 → 提領。手機與 Privy 真登入不以 SIWE 本機測試替代。

## 重部署、回滾與停機

每次操作先以 project token 查核專案名稱、ID 與 environment；只允許本張測試專案。不使用全帳號 token，不執行建立新專案的快捷指令。CLI 安裝在任務暫存目錄，完成後清除。

重新由乾淨 app main 建置、用 frozen lockfile 封裝 backend 與 migrations，掃描 `.deploy/` 的 secret，再指定服務上傳：

```sh
railway up .deploy --path-as-root --no-gitignore --detach --service api --project "$TESTNET_PROJECT_ID"
```

其他 backend 角色使用相同產物；alto 的 context 是 `alto/`，不可誤傳到 Postgres。每次部署記錄 backend commit、app commit、manifest commit、migration 版本及 deployment ID。等待 Railway deployment 成功與 `/health` 的內容，不能只看 upload 成功。啟用的 scheduler／keeper 優先移除 HTTP healthcheck；平台無法清除時，依上節保留 process readiness，另驗成功輪次、scheduler heartbeat 與故障退出。points-sync 維持停用。

回滾前先停用 scheduler、keeper、alto、points-sync 與 API 的交易能力；保留 DB volume 與 session seed，再回到已記錄的相容 deployment／封裝版本。只把 scheduler 切回 dry-run 不足以停掉其他角色。migration 有 checksum，**不修改已套用 SQL、不刪 DB、不自動降 schema**；舊版不相容時維持停用，由 C3 協調 db lane。不能靠回滾應用撤銷鏈上交易。keep-alive／進程狀態與舊 DNS 必須重驗。

## #79 驗收紀錄（歷史交付，#87 結果見末節）

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

## 92 資產同步（backend#87）

來源是 contracts 乾淨 main `b767bf6b22bb697a0b86abf8ed683916fe81502d` 的
`deployments/testnet-97.json` 與 `script/testnet/TestnetAssets.sol`。原 38 個資產與核心地址、
單筆上限不變；新增 54 個資產的 `maxLegUsdt` 依 C3 決定統一 **5,000 MockUSDT／筆**。
這是測試網值，主網仍需各自准入，不會讀寫主網資產表。共 92 個市場＋MockUSDT，
profile 的 319 個 runtime targets 均須有 codehash；11 個 secondary 的設定不變。
三份劇本完整涵蓋 92 個 raw 基準價；休市劇本也包含新增 40 個股票／ETF 的 closed override。

keeper 每輪巡查全部 92 池；休市、暫停、劇本結束仍在 observation 滿 30 分鐘後
以正常 swap 維護，凍結目標價上下 1 bps 交替，沿用每輪每池一次、步距及庫存限制。
不修改劇本價格，也不改使用者交易時段規則。故障仍 fail closed，人工核對後重啟。

本次只改 repo；沒有重新部署或啟用 Railway 服務，也沒有送公開鏈交易。
本機使用 anvil 8562（`--prune-history`）、API 3062、alto 3162、DB `cre8_be87`；
MIGRATIONS_DIR 指向共用 db 的絕對路徑。C3 授權的測試網角色金鑰僅載入子程序 env，
不讀 deployer／owner 私鑰，不保存 env 檔。驗收完成清除自己的程序與 contracts 暫時 worktree；
backend worktree 留給總管。strict preflight 的 `EXECUTOR_DEPLOYMENT_BLOCK` 取真實部署 receipt，
避免 prune-history 環境用過期歷史 state 搜尋建立區塊。

#86 已把 HTTP 新版本建立改為 hold／stack＋funding；BE-2 尚未實作，既有 drift scheduler
會明確拒絕 funding schedule。因此 #87 E2E 使用保留的 production `publishVersion()`
建立 legacy interval fixture，再走真實 HTTP enroll／faucet、production scheduler 代付與
owner 清倉提領。它驗證 97 地址簿與新 TONCOIN（9 decimals）成交，不宣稱 hold／stack 已自動執行。

本張本機正路徑使用 `--prune-history 3072 --gas-price 10000000 --disable-min-priority-fee`，只保留 3,072 個記憶體
state、不持久化完整歷史；SDK 的近期區塊讀取仍可驗證。UserOp 階段的
`TESTNET_ACCEPTANCE_GAS_PRICE_WEI=100000000` 是明確的 **本機 0.1 gwei base fee 情境**，
不是公開鏈費率通過的證據；EOA setup 仍用獨立的高 base fee 情境。

2026-11-15 唯讀公開 RPC 的 `eth_gasPrice` 是 1 gwei。在本機照該報價試跑，
單一 TONCOIN 的普通再平衡也被原有 `GAS_BUDGET_EXCEEDED` 正常擋下；
`ACCOUNT_DAILY_GAS`／`ACCOUNT_DAILY_GAS_USD_E8` 都未調高（預設 1,000 萬 gas／0.30 USDT）。
**公開啟用前需 C3 決定測試網費率／每日預算策略**，不能把本機低費率 E2E 當作公開網已可持續代付。

本機沿用 contracts 驗收的 `@pimlico/alto@0.0.18`，`ALTO_CLI_PATH` 指向套件的
`esm/cli/alto.js`；目前 Node 將套件視為 ESM，不能誤指向 CommonJS 的 `lib/cli/alto.js`。
產品 Docker image 仍 pin v1.2.5，`SAFE_MODE=true` 不變。

keeper fork fixture 在每次 EOA 寫入前維持本機 10 gwei 的下一塊 base fee，
容納 anvil 固定建議的 1 gwei tip；不改 keeper 的報價、步距、receipt 或 source guard。
這和 UserOp 的低費率預算情境分開，兩者都只在自己的本機 anvil 使用。

strict preflight 仍核對 executor 建立區塊及前一塊的 code，不能只靠 receipt 區塊號
略過該檢查。92 市場部署約 1,300 多筆交易；因此 E2E 用 `--prune-history 3072`
保留有界歷史，覆蓋部署與驗收所需區間。先前 keeper 獨立驗收用 128 也通過；
128 不足以在整套部署後回讀 executor 的建立 state，不能宣稱 strict preflight 通過。
本機必須明設 `AUTH_DOMAIN=localhost:3062`、`AUTH_URI=http://localhost:3062`，不沿用隱含預設。

### #87 實際驗收結果（2026-11-15）

| 指令／檢查 | 結果 |
| --- | --- |
| `bun install --frozen-lockfile` | Checked 85 installs／83 packages，no changes |
| `bun run typecheck` | src／test／scripts 0 錯 |
| CI 相同 23 檔 no-DB 清單 | 861 pass／27 skip／0 fail（888 tests） |
| 專用 DB，`bun test --timeout=15000` | 1218 pass／16 skip／0 fail（1234 tests／42 files） |
| profile／keeper 單元與 RPC 測試 | 39 pass／0 skip／0 fail |
| `bun test ./test/testnet-92.fork.ts --timeout=600000` | 1 pass／0 skip／0 fail；92 池、276 swaps、368 previews、兩輪維護、0 source errors／alerts |
| `bun run test/testnet-97.e2e.ts` | 24 pass／0 skip／0 fail；TONCOIN 買入、清倉、完整 USDT 轉出、真 paymaster 付 gas |
| E2E 內 `scripts/preflight.ts --chain 97 --strict` | 470 ok／0 warn／0 fail，含 319 codehash／selectors、建立區塊與 venue 檢查 |
| diff／secret scan | `git diff --check` 通過；角色金鑰、當次 seed 與實際 DB URL 0 命中 |

預設 `bun test` 的 5 秒上限會撞上既有 #82 測試的 5 秒 DB lock timeout；
上列完整 suite 用 15 秒測試上限，保留產品的 DB timeout。沒有新增 skip／only 或放寬型別。
原兩小時 keeper 長測試沒跑：本張以新增 92 池＋兩輪維護驗收覆蓋要求；
公開鏈交易、Railway／Cloudflare、Privy／手機驗收沒跑，均非本張授權範圍。
