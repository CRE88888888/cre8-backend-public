# cre8-atp-backend

CRE8 ATP 的鏈下後端（第一刀）。Bun + TypeScript + Postgres，直接用 `pg`，**不用 ORM**（與 web app 一致）。
預設鏈是 BNB Chain mainnet（chain 56）。目前做策略資料層、版本發布、SIWE（EIP-4361）錢包簽章 auth、
portfolio 續期，以及 **bundler relay**（`POST /bundler`：瀏覽器不能直連 alto，見 §bundler relay）。

## 架構

```
HTTP → src/index.ts（啟動：config → migrate → listen）
         └─ src/server.ts（node:http 路由、JSON、錯誤映射、auth 守門）
              ├─ src/auth.ts（SIWE nonce、EIP-4361 驗簽、session token）
              └─ src/strategies.ts（領域邏輯 + 純函式校驗）
                   └─ src/db.ts（pg Pool、query、transaction、migrate）
                        └─ Postgres（schema 在 ../db/migrations）
```

| 檔案 | 職責 |
| --- | --- |
| `src/config.ts` | 讀 env；`DATABASE_URL` 必填，`PORT` 預設 8080，`CHAIN_ID` 預設 56，`AUTH_DOMAIN` 預設 `localhost`。 |
| `src/auth.ts` | nonce／session 的 in-memory store、EIP-4361（SIWE）驗簽（viem `parseSiweMessage` + `recoverMessageAddress`）、`authenticate()`。 |
| `src/db.ts` | 單一 `Pool`、`query()`、`withTransaction()`、`migrate()`（checksum + advisory lock）。 |
| `src/errors.ts` | `AppError`／`ValidationError`／`NotFoundError`，讓領域層不必知道 HTTP。 |
| `src/strategies.ts` | `listStrategies`、`getStrategy`、`createStrategy`、`publishVersion`，以及 allocation／schedule 校驗。 |
| `src/portfolios.ts` | `enrollPortfolio`、`listPortfolios`、`requireOwnedPortfolio`：portfolio 的讀寫與擁有者檢查。 |
| `src/renewal.ts` | 續期：派生新 session key（`nextRenewalKeyIndex`／`buildRenewalKey`）、`buildRenewalParams`、`recordRenewalResult`。 |
| `src/server.ts` | 路由、body 解析（上限 1 MB）、錯誤 → JSON、CORS、access log、`POST /bundler` 的 relay 與方法白名單。 |
| `src/index.ts` | 啟動與優雅關閉（SIGINT／SIGTERM）。 |
| `src/migrate.ts` | `bun run migrate`：只跑 migration，不啟 server。 |
| `test/strategies.test.ts` | 校驗純函式與 HTTP 路由測試；路由層可注入 `createStrategy`／`publishVersion`，但登入 session 仍需 DB。部分 DB 整合測試以 `DATABASE_URL` 為 gate。 |
| `test/auth.test.ts` | SIWE nonce／login／session 與 provider ownership；用 viem `createSiweMessage` + 隨機錢包在測試內簽名，走完整 HTTP 流程。 |
| `test/renewal.test.ts` | `/portfolios` 列表、`renewal-params`／`renewal-result`、路由分派、CORS 與 `/bundler` relay（含「白名單外不轉發」）；領域依賴以 DI 換成假替身，登入 session 仍需 DB。 |

選擇 `node:http` 而不是 express：這一刀只有七個路由，少一層依賴；`server.ts` 的 `route()` 是唯一需要換掉的
地方，之後要上 express/Fastify 不會動到領域層。

## 環境變數

| 變數 | 必填 | 預設 | 說明 |
| --- | --- | --- | --- |
| `DATABASE_URL` | ✅ | — | Postgres 連線字串；缺少時 `getConfig()` 直接 throw。 |
| `PORT` | | `8080` | HTTP 埠，1–65535。 |
| `CHAIN_ID` | | `56` | EIP-155 chain id；56 = BSC mainnet，97 = testnet。SIWE 訊息必須綁同一個 chain。 |
| `AUTH_DOMAIN` | | `localhost` | EIP-4361 `domain`：錢包要簽的站台 authority（純 host，可帶 port，不含 scheme／path）。部署時必填自己的網域。 |
| `AUTH_URI` | | `http://<AUTH_DOMAIN>` | EIP-4361 `uri`：這次登入指涉的資源。必須是 http/https 絕對 URI；部署時建議設 `https://app…`。 |
| `RPC_URL` | | 空 | JSON-RPC endpoint；目前只用於 `/health` 回報是否設定。 |
| `OPERATOR_PRIVATE_KEY` | 鏈上功能時 ✅ | 空 | backend 專用 relayer 私鑰：registry operator（`enroll`／`setPaused`），也是策略註冊／發版本的 provider；不可與部署者或 alto bundler 共用。 |
| `DEPLOYER_ADDRESS` | preflight `--strict` 時 ✅ | 空 | 部署者的公開非零地址；私鑰只在 `forge script` 部署時使用，不進 backend 執行期。 |
| `BUNDLER_EXECUTOR_ADDRESS` | preflight `--strict` 時 ✅ | 空 | alto 送 `handleOps` 的公開非零地址；對應私鑰只放 alto 服務的 `EXECUTOR_PRIVATE_KEY`。 |
| `ATP_SAFE` | preflight `--strict` 時 ✅ | 空 | 唯讀檢查的預期 owner（公開 Safe 地址，不是私鑰）；registry 與 `executor.oracle()` 的 AtpMultiPoolOracle 都必須已交接給此地址，且該地址有 code。 |
| `EXECUTOR_ADDRESS` | 續期／enroll 時 ✅ | 空 | session key CallPolicy 允許呼叫的 target（rebalance executor）。缺它時 enroll 與 `renewal-params` 會帶著變數名失敗。 |
| `SESSION_KEY_MASTER_SEED` | 續期／enroll 時 ✅ | 空 | 派生 session key 的 HD master seed（`0x` + 64 hex）。私鑰永不落 DB，DB 只存派生路徑 `m/44'/60'/0'/0/<index>`。 |
| `BUNDLER_URL` | | `http://127.0.0.1:3001` | `POST /bundler` 轉發的上游（alto）。`renewal-params` 也把它回給前端當**資訊**顯示。留空 = 這個預設值。 |
| `CORS_ALLOWED_ORIGINS` | | `http://localhost:5173,http://127.0.0.1:5173` | 逗號分隔的允許 origin（完整 origin，不分大小寫）。未設定 = dev 預設；不支援 `*`。 |
| `OPERATOR_WALLETS` | 營運 HTTP 端點時 ✅ | 空（全部拒絕） | `/operator/*` 的 SIWE 登入錢包白名單，逗號分隔的非零 EVM 公開地址；比對不分大小寫。與 backend 的 relayer 私鑰獨立，這裡不填私鑰。 |
| `ENABLE_OPERATOR_REBALANCE` | | 關閉 | 只有字面值 `true` 才開啟 `POST /portfolios/:id/rebalance` 與 `POST /operator/portfolios/:id/{rebalance,close}`；後兩支另需營運白名單。 |
| `TELEGRAM_BOT_TOKEN` | 與 chat id 成對 | 空 | BotFather 給的 bot 密碼；只放本機 `.env` 或服務的 secret 設定。 |
| `TELEGRAM_CHAT_ID` | 與 token 成對 | 空 | 收件私訊或群組的 id（保留負號）；設定方式見下方。 |
| `TELEGRAM_API_BASE` | | `https://api.telegram.org` | 測試可指向本機假 Telegram 伺服器；正式使用留空。 |

複製 `.env.example` 為 `.env` 即可；`.env` 不進版控。**不要**把真的 RPC URL 或連線字串寫進 repo。

`/operator/*` 先驗 SIWE（未登入／無效 token 回 401）。寫入開關未啟用時，兩支營運 POST 回
403 `OPERATOR_REBALANCE_DISABLED`；其餘情況再驗白名單，非營運錢包回 403 `OPERATOR_FORBIDDEN`，
不讀取投組或觸發交易。白名單留空拒絕所有錢包；任一項格式錯誤（含 `*`、零地址、逗號空項目）
會拒絕整份設定並回 503 `INVALID_OPERATOR_WALLETS`，不會放行部分清單。
營運 GET（overview／activity／plan）只需白名單，不受寫入開關限制。
原本 `/portfolios/*` 的 owner 檢查與 scheduler 行為不變；設定白名單不會自動開啟寫入。
本機 X1 測試可把 anvil #4 公開地址 `0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65` 放入白名單，
以該錢包走 SIWE 後操作 `http://127.0.0.1:8082/operator/*`。

### Telegram 警示

每輪結束後，新開的 critical 或 warn 升成 critical 會發一則；持續存在的同一個 critical 不重複發。
critical 的條件消失時再發一則「已解除」。判斷來自 `scheduler_alerts`，重啟不會重送既有警示。
訊息包含嚴重度、kind、portfolio id、detail、first_seen／last_seen、`CHAIN_ID`；
dry-run 照樣通知並標 `[dry-run]`，live 標 `[live]`。一般 warn 不推。

兩個收件設定都空白時不發送，首次嘗試通知只提示一次；只填一個會在啟動時報錯。
通知逾時（5 秒）、HTTP 或 API 失敗只寫不含憑證的 log，不影響該輪，也不自動重試。
因此通知是盡力送達；收件失敗請看 DB、`--alerts` 與 log，下一輪不會補送同一個 critical。
既有未解除 critical 在啟用 Telegram 時也不補發。不新增資料表或欄位。

seed 與 session key 不符會產生全域 `session_key_derivation_mismatch` critical，同輪多個帳戶合併為一筆，
detail 列出檢查／不符把數與最多 10 個 portfolio id；`/health` 會顯示 critical 並回 `degraded`。
需先套用 db migration 0020。每輪會檢查本鏈所有 active Kernel 帳戶未過期的 active key，
即使帳戶尚未到 `next_run_at` 也會持續偵測；seed 換回或完成鏈上續期後，下一輪自動解除。
與執行前檢查共用「由新到舊挑鏈上已安裝的 key」規則，舊 seed 留下的歷史 key 不會蓋過已完成續期的新 key。
seed 未設或無法派生也會產生同種 critical。單戶 DB／RPC 讀取失敗會記入報告，並繼續檢查其他帳戶；
seed 比對未完成時只印一行診斷，不新增或解除 seed 警示，其他警示照常記錄與解除。
此檢查只讀鏈與 DB，不寫 `operations`、不簽名、不送交易。

`bun run preflight --strict` 也做相同的 seed 比對，任何一把不符、派生失敗或單戶讀取失敗都 fail，訊息包含計數。
沒有可檢查的 active key 時明列「檢查 0 把」；有候選 key 卻沒有一把已安裝時 warn（strict 會擋）。
API 與 scheduler 是不同行程時，兩邊都要使用各自的環境執行 preflight，確認設定一致。

設定步驟（由使用者本人操作，不把 token 貼到 issue、PR、截圖或聊天）：

1. 在 Telegram 找官方 [@BotFather](https://t.me/BotFather)，輸入 `/newbot`，照提示取顯示名稱及以 `bot` 結尾的帳號。拿到的 token 就是這個 bot 的密碼，只填進本機 `.env` 的 `TELEGRAM_BOT_TOKEN=` 後方。
2. 打開剛建立的 bot 對話，按「開始／Start」，傳一句「測試」。若要發到群組，先把 bot 加進群組，再在群組傳 `/start@你的bot帳號`。
3. 在 backend 目錄貼上以下指令。它從 `.env` 讀 token，呼叫官方 `getUpdates`，只顯示 chat id 和私訊／群組名稱，不印 token 或完整回應。不要把 token 填進命令列或瀏覽器網址。

   ```bash
   bun -e 'import "dotenv/config"; const token = process.env.TELEGRAM_BOT_TOKEN?.trim(); if (!token) { console.error("請先填本機 .env 的 TELEGRAM_BOT_TOKEN"); process.exit(1); } try { const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, { signal: AbortSignal.timeout(5000) }); const b = await r.json(); if (!r.ok || !b.ok) throw new Error(); for (const u of b.result) { const c = u.message?.chat; if (c) console.log(c.id, c.type, c.title ?? "私訊"); } } catch { console.error("無法取得 chat id；請確認 token，並先對 bot 傳訊息。已有 webhook 的 bot 請另建一個專用 bot。"); process.exitCode = 1; }'
   ```

4. 找到目標對話，把左邊的數字填到 `.env` 的 `TELEGRAM_CHAT_ID=` 後方；群組的負號要一起保留。沒有任何輸出時，重新傳一則訊息，再跑一次。`TELEGRAM_API_BASE` 保持空白。
5. 儲存後，先用以下一行指令確認 Telegram 收到測試訊息；再重啟本機 scheduler 讓設定生效。A 段不改 Railway、不部署。

   ```bash
   bun -e 'import "dotenv/config"; import { sendTelegram } from "./src/notify.ts"; await sendTelegram("[dry-run][critical] CRE8 Telegram 手動驗收通知");'
   ```

建立 bot 的步驟參考 [Telegram 官方教學](https://core.telegram.org/bots/tutorial#obtain-your-bot-token)，
收件與送件參數參考 [getUpdates](https://core.telegram.org/bots/api#getupdates) 與
[sendMessage](https://core.telegram.org/bots/api#sendmessage)。

## 指令

程式的 HTTP 埠預設是 **8080**（`src/config.ts` 的 `DEFAULT_PORT` 與 `.env.example`）。
本機協作以 [AGENT_COLLABORATION §4](https://github.com/CRE8Finance/docs/blob/main/docs/AGENT_COLLABORATION.zh-TW.md#4-本機環境)
為準：A3／cre8-app 用 **8081**，X1 用 **8082**。以下先以 X1 示範，curl 統一使用 `$API`：

```bash
bun install --frozen-lockfile
cp .env.example .env       # 填入 DATABASE_URL

export PORT=8082            # X1；A3／cre8-app 改成 8081
export API="http://localhost:$PORT"
bun run dev                # bun --watch src/index.ts（啟動時先 migrate）
bun run migrate            # 只套用 migration
bun run start              # bun src/index.ts
bun run typecheck          # tsc --noEmit（src + test + scripts 三份 tsconfig）
bun test                   # 完整測試需要可拋棄的 Postgres；見「測試與 DB」
```

需求：Bun >= 1.4（`package.json` 的 `engines`）。bun 原生跑 TypeScript，不需 build 步驟、不需 tsx。

容器的 API 同樣由 `src/config.ts` 讀取 `PORT`，未設定時監聽 **8080**。
`Dockerfile` 的 `EXPOSE 8081` 與 `docker-entrypoint.sh` 的 `port=${PORT:-8081}` 日誌都不會設定
`PORT`；entrypoint 直接執行 `bun src/index.ts`，`railway.json` 也沒有指定埠。
因此不能由 repo 判定 Railway 環境實際傳入的 `PORT`，也不能只靠這行日誌判斷監聽埠。

### ATP v2 起飛前角色檢查（唯讀）

設定 `.env` 的 `ATP_SAFE` 後執行 `bun run preflight --strict`；腳本只讀鏈上狀態，不簽名、不送交易。
registry 與 router（由 `executor.oracle()` 取得）的 `owner()` 必須等於 `ATP_SAFE`，且 Safe 地址有 code。
部署者呼叫 `transferOwnership(ATP_SAFE)` 後，若 owner 尚未改變且 `pendingOwner() == ATP_SAFE`，
會提示「Safe 尚未 acceptOwnership」；必須由 Safe 對兩個合約各呼叫 `acceptOwnership()` 才算交接完成。
`pendingOwner()` 非零且不是 Safe 也會失敗。非 strict 模式下，這些 Safe 設定／交接問題降為 warn。

registry 的 `operator()` 必須非零、等於 `OPERATOR_PRIVATE_KEY` 推導的 relayer 地址，且不能等於 owner；
不符在兩種模式都 fail。讀不到 `operator()` 或 `pendingOwner()` 也一律 fail，提示「不是 v2 合約」並要求確認 RPC。
設定 `DEPLOYER_ADDRESS`、`BUNDLER_EXECUTOR_ADDRESS` 後，preflight 會檢查 relayer、部署者、bundler
三者兩兩不同，且都不等於 `ATP_SAFE`；任何重複一律 fail。兩個角色地址缺少時，strict 下 fail，
非 strict 下 warn；格式錯誤或零地址一律 fail。輸出只列公開地址，不回顯誤填到地址欄位的私鑰。
這三個公開地址設定僅供 preflight 使用，不改 API 或 scheduler 的設定。

backend 執行期只持有 relayer 這一把營運私鑰（另以 `SESSION_KEY_MASTER_SEED` 派生受限的 session key）。
bundler 私鑰只放 alto 的 `EXECUTOR_PRIVATE_KEY`；`UTILITY_PRIVATE_KEY` 未設定時沿用 executor 的 fallback。
部署者只負責 `forge script` 部署與交接，Safe 接受 ownership 後不再有 owner 權限；其私鑰不放 backend 或 alto。
本機 fork 驗證使用 anvil #0（部署者）、#4（relayer）、#5（bundler）的公開測試帳號。

### A10 全域暫停、首次 enroll 與來源

scheduler 每輪認領前讀 `executor.globalPaused()`。Safe 開啟時，該輪所有認領項目都記 `blocked`，
不規劃、不寫 `operations`、不送交易（包含 redeem／close 的賣出）。RPC 讀不到也一律阻擋，
不把未知當成已恢復。live blocked 仍依原有認領規則推進 `next_run_at`；恢復後等下次到期再跑。
`preflight --strict` 在全域暫停時 fail，非 strict 則 warn；讀不到時兩種模式都 fail。

先套用 db migration `0021_alert_executor_paused.sql`。全域暫停用 `executor_paused` critical 警示，
`portfolio_id = NULL`；同一暫停期間去重，持續累加 occurrences，只有成功讀到 `false` 才解除。
空輪次與 dry-run 也會偵測；RPC 失敗保留既有警示。Telegram 沿用既有的新開／解除通知規則。

operator 只會送第一次 enroll。送前在同一塊讀 `isEnrolled` 與 `enrollments`：同策略重試直接成功，
保留鏈上原版本與暫停；不同策略回 409 `ALREADY_ENROLLED`，不送交易。新投組 DB 版本採鏈上實際值，
provider 發布新版不替既有帳戶升版；換策略／換版本須由使用者在 app 簽署，scheduler 只同步版本鏡像。
`ExecutorPaused()`、`AlreadyEnrolled(address)` 會轉為可讀訊息，RPC 原始錯誤不進 enrollment 回應。

`GET /portfolios/:id/status` 增加 `pauseFlags` 與 `pauseSources`，在回應的 `block` 讀鏈：
Safe = 1（`safe`）、operator = 2（`operator`）、帳戶本人 = 4（`account`），可以同時存在。
0 對應空陣列；讀不到時兩欄都是 `null`。backend 沒有鏈上解除暫停端點，也不會用重新 enroll 清除暫停。
營運端重新啟用 DB 排程不會解除 Safe 或使用者設的鏈上暫停。

獨立 fork 驗收（只接受本機 8566、`cre8_x1c`，API 使用 8102）：依 docs 的 A3 步驟用合約最新 main
`DeployAtpMainnet` 部署並讓 Safe 接手，設定本機環境與 `MIGRATIONS_DIR` 後執行
`bun test ./test/a10-pause-operator.fork.ts --timeout=120000`。它驗證真實 CLI 的暫停／恢復、
警示、重試不送交易、三種來源與版本鏡像；恢復案例使用空的 USDT-only 帳戶，結果應為 noop。

### A10 每帳戶買入額度

規劃器在持倉與報價的同一區塊讀 `executor.numeraire()`、`buyAllowance(account)`。
整批買入可用量是 `max(floor(cap × 98 / 100) − bought, 0)`，以**總 cap** 保留 2% 餘裕。
先賣後買；每筆買入先夾到現金與剩餘買入額度，再依實際量報價並重建 router payload。
買入額度／numeraire 讀取失敗或資料缺漏會 blocked，不用舊值推測。

可用量為 0 時整輪 blocked，不寫 operations、不送買單。live 的 `next_run_at` 改為有效的未來
`windowEndsAt`；`windowEndsAt = 0`（例如 Safe 設 `maxBuyBps = 0` 且沒有開著的窗）、已到期或
排程寫回失敗時，沿用認領時的正常間隔。dry-run 不寫排程。未決 UserOp 仍先依 #34 對帳，
不能因為額度歸零或跨窗而解除 pending／submitted 保護。

redeem／close 只有賣成 numeraire，不消耗買入額度；Safe 的全域暫停仍阻擋賣出。
含買入的批次用 `max(alto 估算 × 1.5, 600000) + 145000 × N` 作為 call gas 預算，
`N` 是交換前已持有的非 numeraire 策略資產數，增加 prefund 以涵蓋鏈上估值。
strict preflight 檢查 `maxBuyBps() = 10000` 與 `numeraire() = BSC USDT`；讀不到一律 fail。
`BuyLimitExceeded(uint256,uint256)`、`NotNumeraireRoute(address,address)` 會轉為可讀診斷。

#36 獨立 fork 驗收：依 [A3](https://github.com/CRE8Finance/docs/blob/main/docs/A3_INTEGRATION.zh-TW.md)
用 contracts main 的 `DeployAtpMainnet` 部署並由 Safe 接手。此測試只接受 anvil **8576**、
bundler **3036**、DB **cre8_x1d**，API 使用 **8112**；worktree 要明設
`MIGRATIONS_DIR="$HOME/Desktop/cre8-workspace/db/migrations"`。載入這套本機環境後執行：

```bash
RUN_CHAIN_TESTS=1 bun test ./test/a10-buy-allowance.fork.ts --timeout=120000
```

測試以公開 anvil owner／operator 與只供本機的測試 session key，直接向 bundler 送 Kernel UserOp，
不經 API／scheduler 跑來回買賣，驗證 `BuyLimitExceeded`、賣出仍可用與跨 24 小時窗口後恢復。
另驗 100000 USDT 首次配置、Safe 降低 cap 後縮量、耗盡的窗口排程與實際 redeem／close。

### 每個資產的單筆上限與提領續作（#40／#42）

先套用 db migration `0022_priceable_assets_max_leg.sql`。`priceable_assets.max_leg_usdt`
以 USDT 為單位，`NULL` 不限、`0` 阻擋該資產並記錄原因；DOGE 的直接池上限是 **150 USDT**。
DB numeric 以字串轉為 E8，超出八位的小數向下取整。資料缺漏／DB 失敗會 blocked。
規劃器本身預設讀 DB，因此 scheduler 與直接呼叫規劃器的 CLI 都套用上限。

買入先取資產上限、現金與買入額度中較嚴者，再報價及編碼。賣出用持倉同區塊 oracle
`quoted` 換算 USDT 名義額（不使用折價的 `minimum`），縮量後重新核對；同資產每輪最多一步。
大單的餘量留到下一輪，成功後沿用 `min(intervalSeconds, PARTIAL_FOLLOW_UP_SECONDS)` 跟進。
若已知限額留下批次，即使新建倉無法估算剩餘漂移，也會跟進；其他無法估漂移的計畫保持完整間隔。
限額不保證可成交，每批仍須通過原有 oracle 地板及送出前檢查。

`POST /portfolios/:id/redeem`（需登入）：

- 首批 `{ "usd": 2000 }` 保留原行為：每個非現金部位賣 `balance × usd / total`，分母含現金。
- 續作 `{ "sellUsdE8": "5000000000" }` 表示還要賣 **50 USDT 的非現金名義額**。
  `sellUsdE8` 是正整數字串、1e8 定點；提供時忽略 `usd`。兩者都沒給或有效欄位格式錯誤回 400。
  續作依當下非現金 oracle 名義額重新按比例分配，不承諾維持首批各資產原始待賣量。
- 回應保留原有欄位，新增 `remainingUsdE8` 與 `batched`。已確認的本批名義額才從剩餘量扣除；
  `remainingUsdE8` 可直接帶回下一次的 `sellUsdE8`，`"0"` 表示完成。未能規劃的首批為 `null`
  （未知），blocked／交易未確認不代表完成。金額取整以 E8 為精度、已賣名義額向上取整。
- 例：1,800 USDT ＋ 200 USDT 的 DOGE，首批 `usd: 2000` 賣 150、剩餘 50；續批使用
  `sellUsdE8: "5000000000"`。每批成功後，以 DB 時鐘將 `next_run_at` 延後到至少現在＋30 分鐘，
  已更晚的時間保留。由 API 呼叫者續作，scheduler 不自動接續提領意圖。

`POST /portfolios/:id/close` 每次最多清一批，第一批成功後暫停 DB 排程。DB paused 仍可繼續 close，
但不會解除全域／鏈上暫停，也不改 #38 在途對帳。已無非現金部位回 HTTP 200，
`outcome: "noop"`、`reason: "nothing to sell"`、`remainingUsdE8: "0"`，不送交易。
DB 延後／暫停失敗時仍回報已確認交易與進度，並在 `reason` 提示排程更新失敗，避免把成交當作未成交重做。

獨立 DOGE fork 驗收只接受 anvil **8586**、DB **cre8_x1e**（此 lane 的 API 埠 **8122**）：
在本 worktree 的 `.bun-cache/contracts-40` 解出 contracts 已合併的 `d62d1c3` 並執行 `forge build`，
用 `https://bsc-mainnet.public.blastapi.io` 起 BSC fork（chain 56、cancun），再執行：

```bash
RUN_CHAIN_TESTS=1 RPC_URL=http://127.0.0.1:8586 \
  DATABASE_URL=postgres:///cre8_x1e \
  MIGRATIONS_DIR=../db/migrations \
  bun test ./test/max-leg-batching.fork.ts --timeout=120000
```

測試自行部署該固定版本的 registry／oracle／executor 與測試帳戶，僅用 anvil 公開測試助記詞；
真實交換走 DOGE 直接池，2,000 USDT、DOGE 10% 目標，每輪至多 150，逐批驗 `SwapExecuted` 與地板。
為獨立驗證直接池限額／合約地板，測試關閉可選的 80bps impact 估算（該池費用本身為 100bps）；
不改生產規劃器預設，也不宣稱此測試涵蓋 Kernel／bundler 權限整合。

### 測試與 DB

完整 `bun test` 需要可拋棄的 Postgres 與 `../db/migrations`（或以 `MIGRATIONS_DIR` 指向該目錄）。
auth／renewal／portfolios／operator／strategies 的 HTTP 測試會讀寫 `auth_sessions`，
即使其他依賴已注入假替身，沒有 DB 仍會失敗，**不會自動全部 skip**。
未設 `DATABASE_URL` 時還會出現 `DATABASE_URL is required`，以及測試之間的 unhandled error；
設成不可連線的假值也無法讓完整測試通過，登入等 HTTP 請求會回 503。
只有明確設 gate 的 DB／fork／鏈上寫入測試會依條件 skip。

```bash
# 完整測試：X1 使用可拋棄的 cre8_x1，測試會跑 migration 並建立／刪除資料
DATABASE_URL='postgres://postgres@127.0.0.1:5432/cre8_x1' bun test
```

沒有 Postgres 時，照 [.github/workflows/ci.yml](.github/workflows/ci.yml) 的
`Unit tests (no DB)` **完整檔案清單**跑；該檔是清單的依據。必須保留不可連線的假 `DATABASE_URL`，
讓 scheduler／snapshot 的清理 hook 能處理連線失敗；完全不設會同步 throw，產生 unhandled error。
這個假值只適用於以下清單，不能換成不指定檔案的 `bun test`：

```bash
DATABASE_URL=postgres://ci:ci@127.0.0.1:1/unused bun test \
  test/alerts.test.ts \
  test/chain.enroll.test.ts \
  test/drift.test.ts \
  test/funding.test.ts \
  test/holdings-scan.test.ts \
  test/kernel.test.ts \
  test/notify.test.ts \
  test/permissions.test.ts \
  test/positions.test.ts \
  test/preflight.test.ts \
  test/pricing.test.ts \
  test/pricing.crosscheck.test.ts \
  test/rebalance-plan.test.ts \
  test/scheduler.test.ts \
  test/server.test.ts \
  test/snapshot.integration.test.ts \
  test/snapshot.scan.test.ts
```

### 會送鏈上交易的測試（`RUN_CHAIN_TESTS=1`）

有四個測試會**真的送出鏈上交易**：`createStrategy` 會 mirror 到 `AtpRegistry`、`publishVersion`
會上鏈、`enrollPortfolio` 會走 counterfactual deploy。它們預設**關閉**，就算 `.env` 齊全也一樣：

| 測試 | 檔案 |
| --- | --- |
| `DB: strategy and version round trip` | `test/strategies.test.ts` |
| `DB: POST /strategies/:id/versions publishes a version over HTTP` | `test/strategies.test.ts` |
| `DB: provider ownership is enforced end to end over HTTP` | `test/auth.test.ts` |
| `enrollPortfolio mirrors to chain and writes portfolio + smart account` | `test/portfolios.test.ts` |

為什麼要另外一個開關：「後端設定齊全」（`RPC_URL` / `OPERATOR_PRIVATE_KEY` / `REGISTRY_ADDRESS`）
只代表**伺服器**能用，不代表**測試**可以動鏈。把 `.env` 補齊就自動開跑，等於讓 `bun test` 變成一支
會寫鏈的腳本，而這幾條測試共用同一個 operator 帳號的 nonce。

ATP v2 的 fork 前置：部署 registry 後，先由 owner（anvil #0）呼叫
`setOperator(<anvil #4 地址>)`，再用 anvil #4 的公開測試金鑰設定 `OPERATOR_PRIVATE_KEY`。
owner 身分本身不能代替 smart account enroll；operator 未設定（零地址）或與 signer 不同時，
backend 會在送出 enroll 交易前報錯，列出 signer 與鏈上 operator 地址，提示「需由 owner 呼叫 setOperator」。
以下指令只對 X1 本機 fork（8546）執行；`REGISTRY_ADDRESS` 是該 fork 剛部署的 registry，
`ANVIL_OWNER_KEY` 只可填 anvil #0 的公開測試金鑰：

```bash
cast send "$REGISTRY_ADDRESS" 'setOperator(address)' \
  0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65 \
  --rpc-url http://127.0.0.1:8546 --private-key "$ANVIL_OWNER_KEY"
cast call "$REGISTRY_ADDRESS" 'operator()(address)' --rpc-url http://127.0.0.1:8546
```

```bash
# 已備妥 Postgres 與 migration：預設四個鏈上寫入測試 skip，其餘照跑
bun test

# 真的跑鏈上寫入：一定要給足 timeout，而且不要開 --concurrent
RUN_CHAIN_TESTS=1 bun test --timeout=120000
```

兩個細節，都是實測踩出來的：

- **`--timeout` 不能省。** 每筆送交易 + 等 receipt 是幾秒的事（`enrollPortfolio` 那條整體實測 13–15
  秒），bun 預設每測試 5 秒一定逾時。而逾時的測試**底層的送交易不會停**，於是下一個測試用同一個
  operator 帳號讀到舊 nonce，就變成 `NonceTooLowError`。實測：`RUN_CHAIN_TESTS=1 bun test`
  （不加 `--timeout`）是 4 fail，加上 `--timeout=120000` 連兩輪都是 410 pass / 0 fail。
- **不要用 `--concurrent`。** 它會讓同一檔案內的測試並行，nonce 直接對撞。順帶一提
  `bun test --concurrent 1` 在 bun 1.4 是**無效**的寫法：`--concurrent` 不吃值，那個 `1` 會被當成
  檔名 filter，結果是「The following filters did not match any test files: 1」。bun 預設就是一個檔案
  跑完再換下一個，所以正確做法是**只給 `--timeout`、不要碰 `--concurrent`**。

⚠ 這四個測試會把交易送到 `RPC_URL` 指的鏈，並且在 `DATABASE_URL` 的資料庫留下 strategy 資料列。
**只對著本機 anvil fork（例如 `http://127.0.0.1:8545`）跑，不要對著主網跑。**

只**讀**鏈的測試（`test/pricing.crosscheck.test.ts`、`test/rebalance-plan.test.ts` 的真鏈驗證、
`test/snapshot.integration.test.ts`）不受這個開關影響：它們不送交易、不佔 nonce，可以安全並行，
skip 條件只看 fork 可不可用。

### Fork 鏈上整合測試（Anvil fork BSC mainnet）

ATP v2 的部署與串接步驟統一維護在
[A3_INTEGRATION](https://github.com/CRE8Finance/docs/blob/main/docs/A3_INTEGRATION.zh-TW.md)。
依該文件第 2–5 節啟動 fork、部署 `script/DeployAtpMainnet.s.sol`、讓 Safe 接手 registry 與
router，再設定 alto 和 backend；完整瀏覽器流程見第 6–8 節。本機工具使用 PATH 上的
`anvil`／`forge`／`cast`，不依賴特定使用者的安裝路徑或既有 state dump。

埠與 DB 依 [AGENT_COLLABORATION §4](https://github.com/CRE8Finance/docs/blob/main/docs/AGENT_COLLABORATION.zh-TW.md#4-本機環境)：

| 環境 | fork | backend | Postgres DB |
| --- | --- | --- | --- |
| A3／cre8-app（A3 文件預設） | 8545 | 8081 | `cre8_integration` |
| X1 後端獨立驗證 | 8546 | 8082 | `cre8_x1` |

X1 執行時替換 A3 指令中的 RPC、backend 埠與 DB 名稱，不占用 C3 的服務；cre8-app dev proxy
固定接 A3 的 8545／8081，瀏覽器整套串接由 C3 執行。fork、backend 與 app 的 chain id 均須為 **56**
（`DeployAtpMainnet` 不接受 1337）。anvil 使用 `--hardfork cancun --block-time 2`；
上游 RPC 與 alto `--max-block-range 100` 的原因見 [pitfalls §2](docs/pitfalls.zh-TW.md#二anvil-fork本機開發環境)。

角色固定分開：部署者用 anvil #0、backend relayer 用 #4、alto bundler executor 用 #5。
`DeployAtpMainnet` 已設定 `operator = #4`，Safe 必須對 registry 與 router 各呼叫一次
`acceptOwnership()`。交接後 owner 是 `ATP_SAFE`，anvil #0 已無 owner 權限，
不需再執行上方測試前置示範的 `setOperator`。交接與角色設定完成後可唯讀驗證：

```bash
# 先載入 A3 第 3 步產生的 contracts.env；以下使用 X1 fork
export ETH_RPC_URL=http://127.0.0.1:8546
cast chain-id                                              # 56
cast call "$REGISTRY_ADDRESS" 'owner()(address)'            # ATP_SAFE
cast call "$REGISTRY_ADDRESS" 'pendingOwner()(address)'     # 0x000…000
cast call "$REGISTRY_ADDRESS" 'operator()(address)'         # anvil #4
cast call "$ROUTER_ADDRESS" 'owner()(address)'              # ATP_SAFE
cast call "$ROUTER_ADDRESS" 'pendingOwner()(address)'       # 0x000…000
cast call "$EXECUTOR_ADDRESS" 'oracle()(address)'           # ROUTER_ADDRESS
# backend env 依 A3 第 5 步設定後：
bun run preflight --strict                                 # 0 warn · 0 fail
```

舊的 fork 還原與自動選池腳本已移除：還原腳本依賴不在 repo 的 v1 dump／baseline，且重載的 state
與 DB／alto 不保證一致；自動選池腳本會改掉 `DeployAtpMainnet` 已註冊的
7 個固定池 oracle，Safe 接手後也沒有權限執行。fork 過期時，停止自己這套服務，依 A3 從新 fork
重新部署並重建測試 DB、重啟 alto 與 backend；舊 DB 的 onchain id 與 smart account 不可沿用。

所有簽名與交易都只在本機 anvil fork 上執行，只使用 anvil 公開測試金鑰。

部分 DB 整合測試會依 `DATABASE_URL` 的 gate 標成 skipped；這不涵蓋需要真 DB session 的 HTTP 測試
（見「測試與 DB」）。DB 整合測試會自己 `migrate()`，並在 `finally` 清掉建立的 strategy
（versions 由 FK cascade）。

## API

所有回應都是 `application/json; charset=utf-8`，一般錯誤格式為
`{"error":{"code":"...","message":"..."}}`；`/platform/status` 讀鏈不可用時仍回傳下述狀態物件。

| Method | Path | 說明 | 成功碼 |
| --- | --- | --- | --- |
| `GET` | `/health` | Postgres 可連線時 200，否則 503（`db: "down"`） | 200 |
| `GET` | `/platform/status` | 公開、免登入的平台鏈上狀態；讀鏈失敗 503，`globalPaused: null` | 200 |
| `GET` | `/strategies` | 列表；`limit`（1–100，預設 50）、`offset`、`provider`（不分大小寫）、`public=true\|false` | 200 |
| `GET` | `/strategies/:id` | 單一策略 + 版本歷史（新到舊） | 200 |
| `POST` | `/auth/nonce` | 取得一次性 nonce 與 SIWE 欄位（`domain`／`chainId`／`uri`／`statement`／`issuedAt`，TTL 5 分鐘）；不需 body | 200 |
| `POST` | `/auth/login` | body `{message, signature}`（完整 EIP-4361 訊息）；回 `{token, expiresAt}` | 200 |
| `POST` | `/strategies` | 建立策略 metadata；**需** `Authorization: Bearer <token>` | 201 + `Location` |
| `POST` | `/strategies/:id/versions` | 發布新版本；**需** token 且必須是該策略的 provider | 201 |
| `GET` | `/portfolios` | 目前登入錢包的 portfolio 列表（含 gas 狀態與現行 session key）；**需** token | 200 |
| `POST` | `/portfolios` | enroll 一個策略；**需** token，body `{strategyId}` | 201 + `Location` |
| `GET` | `/portfolios/:id/renewal-params` | 派生一把新的 session key，回傳前端組續期 UserOp 所需的全部材料；**需** token 且必須是擁有者 | 200 |
| `POST` | `/portfolios/:id/renewal-result` | 前端回報續期 UserOp 已上鏈，後端記進 `session_keys`；**需** token 且必須是擁有者 | 200 |
| `POST` | `/bundler` | bundler relay：把 JSON-RPC 原樣轉給 `BUNDLER_URL` 並原樣回傳；**需** token，方法必須在白名單內 | 上游的 status |

所有需要 token 的路徑都在讀 body **之前**驗證：沒帶 token 的請求即使 body 不合法也是 401，不是 400。

### 公開平台狀態（`GET /platform/status`）

供所有訪客顯示全站暫停橫幅，不需要登入或 portfolio。獨立於 `/health`，因為這是鏈上狀態，
不應依賴健康檢查的 DB／警示查詢；不查 DB，也不需要 operator 私鑰或 session key seed。

```bash
curl -s "$API/platform/status"
# {"chainId":56,"executor":"0x…","registry":"0x…","globalPaused":false,"maxBuyBps":10000,
#  "checkedAt":"2026-11-13T06:00:00.000Z","block":"123456789"}
```

- `executor`、`registry` 來自 `EXECUTOR_ADDRESS`、`REGISTRY_ADDRESS`；`chainId` 來自設定，並核對 RPC 的鏈。
- `globalPaused` 與 `maxBuyBps` 在同一個 `block` 讀取；`block` 是十進位字串，`checkedAt` 是開始查詢的 ISO 時間。
- 成功與失敗都在 process 內快取 **10 秒**，從開始查詢時計算；同時到達的請求共用一次讀鏈。
  快取命中不更新 `checkedAt`。HTTP 使用 `Cache-Control: no-store`，不延長狀態的新鮮度。
- RPC 每次請求逾時 **5 秒**、不重試。缺設定、RPC 失敗／逾時、鏈不符或回傳資料缺漏都回 **503**，
  `globalPaused`、`maxBuyBps`、`block` 都是 `null`；能解析的公開地址仍會回傳，缺少／無效的地址為 `null`。
  `null` 表示未知，前端不能當成 `false`。回應與 log 不包含 RPC URL、私鑰、seed 或內部錯誤原文。

### Auth（SIWE／EIP-4361 + session token）

沒有密碼、沒有第三方服務。流程是「拿 SIWE 欄位 → 前端用 viem 組 EIP-4361 訊息 → 錢包簽 → 換 token →
帶 token 打寫入路由」。訊息綁住 **domain + chainId + nonce + issuedAt**，被釣到別的站台或別的鏈都簽不出可用的
訊息。

1. `POST /auth/nonce` 取得一次性 nonce（32 bytes hex，TTL 5 分鐘）與組訊息所需的欄位：
   ```bash
   curl -s -X POST "$API/auth/nonce"
   # {"nonce":"<64 hex>","domain":"localhost","chainId":56,"uri":"http://localhost",
   #  "statement":"Sign in to CRE8 ATP","version":"1",
   #  "issuedAt":"2026-11-06T01:00:00.000Z","expiresAt":"2026-11-06T01:05:00.000Z"}
   ```
   `domain`／`chainId`／`uri`／`statement` 來自伺服器設定（`AUTH_DOMAIN`、`CHAIN_ID`、`AUTH_URI`）；
   `issuedAt` 是伺服器時間，前端直接拿來用就不會被本機時鐘偏差影響。
2. 前端用 viem 把這些欄位加上**自己的地址**組成完整 EIP-4361 訊息並簽名
   （`viem/siwe` 的 `createSiweMessage`，`version: "1"`）：
   ```ts
   import { createSiweMessage } from 'viem/siwe';

   const challenge = await (await fetch('/auth/nonce', { method: 'POST' })).json();
   const message = createSiweMessage({
     address: account.address,          // 簽名者自己填
     chainId: challenge.chainId,
     domain: challenge.domain,
     uri: challenge.uri,
     statement: challenge.statement,
     version: '1',
     nonce: challenge.nonce,
     issuedAt: new Date(challenge.issuedAt),   // 或用 new Date()
   });
   const signature = await walletClient.signMessage({ account, message });
   ```
   錢包顯示的是標準 SIWE 版面（`<domain> wants you to sign in with your Ethereum account:` + 地址 +
   `Sign in to CRE8 ATP` + `URI`／`Version`／`Chain ID`／`Nonce`／`Issued At`）。
3. `POST /auth/login`，body 只有 `{"message":"<完整 EIP-4361 訊息>","signature":"0x…"}`：
   ```bash
   curl -s -X POST "$API/auth/login" -H 'content-type: application/json' -d '{
     "message": "<完整 SIWE 訊息，含換行>",
     "signature": "0x<65-byte signature>"
   }'
   # {"token":"<64 hex>","expiresAt":"..."}
   ```
   後端依序檢查（順序刻意如此：先驗信封，再燒 nonce）：
   - 訊息可解析，且 `version=1`、`statement`、`domain`、`uri`、`chainId` 都等於本伺服器設定，
     否則 400 `INVALID_SIWE_MESSAGE`（**此時不消耗 nonce**，釣魚訊息燒不掉使用者的 challenge）。
   - 訊息裡的 nonce 存在（否則 400 `INVALID_NONCE`）且未過 TTL（否則 400 `NONCE_EXPIRED`）。
   - `issuedAt` 不在未來、不超過 nonce TTL + 2 分鐘時鐘容差，`expirationTime`／`notBefore` 若填了也要成立，
     否則 400 `SIWE_EXPIRED`／`INVALID_SIWE_MESSAGE`。
   - `recoverMessageAddress({ message, signature })` 解出的地址必須等於**訊息內**的地址，
     否則 401 `INVALID_SIGNATURE`。
   - 通過後立即刪除 nonce（重放 → 400 `INVALID_NONCE`），簽發 TTL 24 小時的 token。
4. 寫入路由帶 `Authorization: Bearer <token>`；伺服器把 token 換回錢包地址，**provider 一律由 session 推導**，
   body 裡的 `provider` 會被忽略。不是策略 owner 卻發布版本 → 403 `FORBIDDEN`。

驗簽只用 `recoverMessageAddress`（EOA），**不支援 EIP-1271 合約錢包**：那需要 RPC 去問合約。
要支援就得把 `verifySiweMessage`（viem，帶 `publicClient`）接上 `RPC_URL`，屬於下一刀。

nonce 與 session 目前是**單一 process 的 in-memory Map**：重啟即失效，也只能跑單實例。水平擴展前必須換成
Redis 或其它共享 store（見 TODO）。

```bash
curl -s "$API/health"
# {"status":"ok","service":"cre8-atp-backend","chainId":56,"rpcConfigured":false,"db":"ok","uptimeSeconds":3}

curl -s -X POST "$API/strategies" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "name": "Index 500",
  "description": "BSC bStock index",
  "isPublic": true,
  "swapFeeBps": 25
}'
# {"id":1,"provider":"0x<session wallet, lowercase>",...,"swapFeeBps":25,"createdAt":"..."}

curl -s -X POST "$API/strategies/1/versions" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "allocation": {"assets": [
    {"address": "0x00000000000000000000000000000000000000a1", "symbol": "AAPLB", "weightBps": 6000},
    {"address": "0x00000000000000000000000000000000000000b2", "weightBps": 4000}
  ]},
  "schedule": {"kind": "interval", "intervalSeconds": 86400},
  "changeLog": "initial weights"
}'
# {"strategyId":1,"version":1,"allocation":{...},"schedule":{...},"changeLog":"initial weights","activeAt":"...","createdAt":"..."}
```

`POST /strategies/:id/versions` 回傳的是**建立的版本紀錄本身**（`strategyId`、`version`、`allocation`、
`schedule`、`changeLog`、`activeAt`、`createdAt`），不是 strategy detail。版本號由後端配置
（`max(version)+1`，併發時靠唯一鍵重試），策略不存在回 404、allocation／schedule 校驗失敗回 400。

列表回傳 `{ items, total, limit, offset }`；`total` 是符合條件的總筆數，不是本頁筆數。

### 校驗規則（與鏈上 `AtpRegistry` 對齊）

`POST /strategies`：

- `name` 必填、去空白後非空、≤ 120 字。`provider` **不從 body 讀**：由 `Authorization` 的 session 推導
  （body 帶了也忽略），長度上限 200 字。
- `description` ≤ 2000 字，預設 `""`。
- `isPublic` 必須是 boolean，預設 `true`。
- `swapFeeBps` 必須是 0–300 的整數（3% 上限，對齊 `MAX_SWAP_FEE_BPS`），預設 0。

`POST /strategies/:id/versions`（`publishVersion()`）：

- 請求 body 必須是物件；`allocation`、`schedule` 必填，`changeLog`、`activeAt` 選填。
- `allocation` 必須是 `{"assets":[{"address":"0x…","symbol"?:"  ≤32 字","weightBps":2500}]}`。
- 1–16 個資產（`MAX_VERSION_ASSETS`，包含自動補入的 USDT）；address 必須是 0x + 40 hex，入庫前轉小寫。
- 同一版本內資產不可重複（address 不分大小寫）。
- `weightBps` 必須是 1–10000 的整數，USDT 另允許 0；總和**必須剛好 10000**。
- 未提供 BSC USDT（`0x55d398326f99059fF775485246999027B3197955`）時，自動在最後補上
  `{ address: "0x55d398326f99059ff775485246999027b3197955", symbol: "USDT", weightBps: 0 }`，不調整原有權重。
  回傳、DB 與鏈上 `version.assets` 都包含此列，讓存入的 USDT 能被核准並配置到目標資產。
  已提供 USDT 時保留其權重、不重複補列；16 個資產且缺 USDT 時回 400 `TOO_MANY_ASSETS`。
  建立基金的初版與後續版本皆走此發布規則；不修改既有版本或既有投組固定的版本。
- `schedule` 是 `{"kind":"interval","intervalSeconds":>=60}` 或 `{"kind":"cron","cron":"…"}`。
- `changeLog` 選填，≤ 2000 字；`activeAt` 選填，預設 `now()`。
- 必須帶 token，且該策略 DB 的 `provider` 必須等於 session 錢包（不分大小寫），否則 403 `FORBIDDEN`。

錯誤碼：`INVALID_ALLOCATION`、`ALLOCATION_EMPTY`、`TOO_MANY_ASSETS`、`INVALID_ASSET`、
`DUPLICATE_ASSET`、`WEIGHT_OUT_OF_RANGE`、`WEIGHT_SUM`、`INVALID_SCHEDULE`、`INVALID_VERSION`、
`INVALID_STRATEGY`、`INVALID_SWAP_FEE`、`INVALID_ID`、`INVALID_QUERY`、`INVALID_JSON`、`NOT_FOUND`、
`METHOD_NOT_ALLOWED`、`PAYLOAD_TOO_LARGE`、`DB_UNAVAILABLE`、`INTERNAL`、`UNAUTHORIZED`、
`FORBIDDEN`、`INVALID_AUTH`、`INVALID_NONCE`、`NONCE_EXPIRED`、`INVALID_SIGNATURE`、
`INVALID_SIWE_MESSAGE`、`SIWE_EXPIRED`、`INVALID_RENEWAL`、`KEY_REF_CONFLICT`、`SESSION_KEY_CONFIG`、
`BUNDLER_METHOD_NOT_ALLOWED`、`BUNDLER_UNAVAILABLE`。


## Portfolio 與 session key 續期

三支 endpoint，全部需要 `Authorization: Bearer <token>`。設計原則：**後端只做前端做不到的事** ——
派生新的 session key（要 master seed，絕不進瀏覽器）。UserOp 的組裝、簽章、送 bundler 全在前端。

### `GET /portfolios`

目前登入錢包的所有 portfolio。只回 token 對應錢包的列（`lower(portfolios.user_id) = token 的錢包`），
沒有任何「查誰」的參數，所以不存在改一個 query string 就讀到別人 portfolio 這條路。

```bash
curl -s "$API/portfolios" -H "authorization: Bearer $TOKEN"
```

```json
{ "portfolios": [
  { "id": 3, "userId": "0xabc…", "strategyId": 11, "version": 1, "scheduleState": "active",
    "createdAt": "2026-11-06T00:00:00.000Z",
    "smartAccounts": [ { "chainId": 56, "address": "0xdef…", "owner": "0xabc…", "accountType": "KERNEL" } ],
    "gas": { "address": "0xdef…", "balanceWei": "50000000000000000", "minimumWei": "10000000000000000",
             "ready": true, "shortfallWei": "0", "estimatedOps": 163, "gasPriceKnown": true },
    "sessionKey": { "permissionId": "0xc0449df6", "sessionKeyAddress": "0x123…",
                    "keyRef": "m/44'/60'/0'/0/787718448", "expiresAt": "2028-01-15T08:00:00.000Z",
                    "status": "active" } }
] }
```

- `gas` 與 `sessionKey` 取不到時是 **`null`**，不是整個請求失敗：`null` 代表「暫時查不到」，不是
  「餘額 0」或「沒有 key」。
- `sessionKey` 是**現行**的那一把（`status = 'active'` 優先，其次到期日新到舊）。
- 錯誤：401 `UNAUTHORIZED`；DB 不可用 503 `DB_UNAVAILABLE`。

### `GET /portfolios/:id/renewal-params`

**派生一把新的 session key，回傳前端組 UserOp 所需的一切。不簽章、不上鏈、不寫 DB。**

```bash
curl -s "$API/portfolios/3/renewal-params" -H "authorization: Bearer $TOKEN"
```

```json
{
  "portfolioId": 3,
  "strategyId": 11,
  "chainId": 56,
  "ownerAddress": "0xabc…",
  "accountAddress": "0xdef…",
  "executorAddress": "0x6069…",
  "entryPoint": "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  "kernelVersion": "0.3.3",
  "sessionKeyAddress": "0x123…",
  "keyRef": "m/44'/60'/0'/0/787718449",
  "validUntil": 1825512345,
  "expiresAt": "2027-11-06T00:00:00.000Z",
  "permissionId": "0x9ab4cdef",
  "policySnapshot": { "version": 1, "entryPoint": "0x…", "kernelVersion": "0.3.3", "flag": "0x0000",
                      "call": { "…": "…" }, "gas": { "…": "…" }, "timestamp": { "…": "…" },
                      "permissionId": "0x9ab4cdef", "sessionKeyAddress": "0x123…",
                      "expiresAt": "2027-11-06T00:00:00.000Z" },
  "initConfig": ["0x9198bdf5…", "0xe9ae5c53…"],
  "bundlerUrl": "http://127.0.0.1:3001"
}
```

- `accountAddress` 是 **DB `smart_accounts.address` 的權威值，不是重新推導**：已部署帳戶的位址取決於
  當初那組 `initConfig`，重算會落到另一個（沒部署過）的地址，見 `docs/pitfalls` §4.7。
- `initConfig` 是兩筆 calldata，`to` 都是**帳戶自己**（帳戶內的 `msg.sender == self`）。
- `validUntil` 是 `sessionValidUntil()` = now + 365 天（Unix 秒，uint48），`expiresAt` 是同一個瞬間的 ISO。
- `policySnapshot` 前端不需要解，但**必須原樣回傳**給 `renewal-result`。
- **新 key 的索引一定與既有那把不同**：`max(既有所有 key_ref 的索引, base) + 1`，其中
  `base = keccak256(owner, strategyId) % 2^31`。同一秒內重打這支 endpoint 會回**完全相同**的 key
  （索引只依賴 DB 狀態、`validUntil` 只到秒），所以前端逾時重試不會拿到另一把 key 去簽前一個 op。
- 錯誤：401 `UNAUTHORIZED`；404 `NOT_FOUND`（portfolio 不存在，或它沒有任何 smart account）；
  403 `FORBIDDEN`（不是你的）；400 `INVALID_ID`；500 `SESSION_KEY_CONFIG`（缺 `EXECUTOR_ADDRESS` 或
  `SESSION_KEY_MASTER_SEED`，訊息會指出缺哪一個）。

### `POST /portfolios/:id/renewal-result`

前端把已上鏈的續期結果記回 DB。**鏈是權威**，所以這裡不驗證 txHash 是否真的上鏈，只記錄。

```bash
curl -s -X POST "$API/portfolios/3/renewal-result" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "txHash": "0x…", "userOpHash": "0x…",
  "permissionId": "0x9ab4cdef", "sessionKeyAddress": "0x123…",
  "keyRef": "m/44'\''/60'\''/0'\''/0/787718449", "validUntil": 1825512345,
  "policySnapshot": { "…": "…" }
}'
# {"ok":true,"recorded":{"keyRef":"m/44'/60'/0'/0/787718449","permissionId":"0x9ab4cdef"}}
# 重複提交（同一個 keyRef 再送一次）：
# {"ok":true,"recorded":{"…":"…"},"duplicate":true}
```

寫入的是一列**新的** `session_keys`（`permissions` = `policySnapshot`，`expires_at` = `validUntil`，
`status = 'active'`），SQL 是 `insert … on conflict (key_ref) do nothing`：

- **舊的那一列一個字都不動**：舊權限在鏈上仍然有效到它自己的 `expires_at`，改它的 status 會讓 DB 說一件
  鏈上不成立的事。
- 重複提交不是錯誤：`on conflict do nothing` 之後 `returning` 是空的，回應帶 `duplicate: true`，列的數量
  不變。
- 同一個 `keyRef` 已屬於**別的** portfolio 時回 409 `KEY_REF_CONFLICT`（那不是重複提交，是兩個 portfolio
  搶同一把 key）。
- 錯誤：401 `UNAUTHORIZED`；404 `NOT_FOUND`；403 `FORBIDDEN`；400 `INVALID_RENEWAL`（缺 `keyRef`／
  `permissionId`、`validUntil` 不在 uint48 內、`policySnapshot` 不是物件）、`INVALID_ID`、`INVALID_JSON`。

### 本機 seed 輪替／撤銷演練（維運工具）

`scripts/renew-session-key.ts` **只供本機 anvil fork 使用**，由 owner 的公開測試金鑰簽 sudo UserOp。
RPC 與 bundler 必須是 loopback，節點必須回報 anvil；不可帶真實 owner 私鑰執行。
X1 使用 anvil 8546、backend 8082、資料庫 `cre8_x1`；帳戶須已部署並有完整 DB permission 快照。

先設定本機 `DATABASE_URL`、`RPC_URL=http://127.0.0.1:8546`、`BUNDLER_URL`、`CHAIN_ID`、
`REGISTRY_ADDRESS`、`EXECUTOR_ADDRESS` 與 `SUDO_PRIVATE_KEY`（anvil 公開測試金鑰）。
`SID` 是 **DB strategy id**，`OLD_PID` 是該帳戶舊 key 的 bytes4 permissionId。

```bash
# seed A 建好帳戶後，先保存舊 key 簽好的 UserOp（僅 eth_call，不送交易）。
# TEST_SEED_A / TEST_SEED_B 只用測試值；proof-file 放在 repo 內的忽略目錄，不能進版控。
mkdir -p .deploy/seed-rotation
SESSION_KEY_MASTER_SEED="$TEST_SEED_A" bun run scripts/renew-session-key.ts \
  --strategy-id "$SID" --prepare-revoke-proof "$OLD_PID" --proof-file .deploy/seed-rotation/old-op.json

# 換 seed B：續期仍能核對原部署地址；--no-prove 只跳過新 key 的實際再平衡交易。
SESSION_KEY_MASTER_SEED="$TEST_SEED_B" bun run scripts/renew-session-key.ts --strategy-id "$SID" --no-prove

# 只帶 seed B 即可撤銷 seed A 的 key；撤銷本身也可以完全不帶 seed。
SESSION_KEY_MASTER_SEED="$TEST_SEED_B" bun run scripts/renew-session-key.ts \
  --strategy-id "$SID" --revoke-only "$OLD_PID" --proof-file .deploy/seed-rotation/old-op.json
```

撤銷從 **DB 的完整公開快照**重建 deinitData，核對 permissionId；不讀舊 seed，也不接受手填舊 index／到期日。
成功須同時有 UserOp 執行成功、鏈上 `permissionConfig(pid).signer = 0`、policy 清空，之後才把唯一對應的
`session_keys` 列更新為 `revoked` 並填 `revoked_at`。若鏈上早已撤銷，重跑只同步 DB，不重送交易。
`--revoke-old` 可在續期後撤銷上一把 active key；`--account` 可進一步限縮 DB 帳戶，不能繞過 owner／strategy／chain 核對。
帳戶暫停時也能做維運，腳本不解除暫停；續期請加 `--no-prove`，因為執行再平衡仍會被 paused 擋下。

`--proof-file` 在撤銷前重驗一次有效性，再用**同一份舊簽章**跑 EntryPoint `handleOps` 的 `eth_call`。
只接受解碼後的 `FailedOpWithRevert(AA23 reverted)`（inner revertData 為空，或 Kernel `InvalidNonce`）為拒絕證明；
RPC、SDK、壞簽章、nonce 過期、權限到期等錯誤會失敗退出。撤銷成功後若 proof 驗證失敗，DB 仍如實記錄已撤銷。
沒有 proof-file 仍能撤銷，但明確回報「未驗證舊 UserOp 拒絕」。
舊 seed 已遺失且沒有事先簽好的 UserOp 時，無法補造舊 key 簽章；只能驗證鏈上撤銷狀態。
proof-file 含可提交的簽署資料，雖無私鑰，仍須保護並在演練後刪除；不要在準備 proof 後再用舊 key 送交易消耗 nonce。

### 前端拿到 `renewal-params` 之後還缺什麼

缺兩樣，而且**全部刻意放在前端**：`ownerAddress` 的 **sudo 簽章者**（後端沒有使用者的 owner 私鑰，
也不該有）、以及 **gas 參數**（`maxFeePerGas`／`maxPriorityFeePerGas`，前端讀鏈現況）。UserOp 的
`sender` 是 `accountAddress`、`callData` 由 `initConfig` 那兩筆 call 組成 —— 這些都在前端組，後端不碰。

**送 bundler 的傳輸層是後端的 `POST /bundler`**，不是前端自己連 alto：回應裡的 `bundlerUrl` 只是
「後端會打哪裡」的資訊，前端不拿它發請求（原因見下一節）。

## CORS

瀏覽器從別的 origin（vite dev 的 `http://localhost:5173`）打這支 API 時，preflight 由
`src/server.ts` 回答：

- 允許的 origin 來自 `CORS_ALLOWED_ORIGINS`（逗號分隔的**完整 origin**；未設定 = 上面那組 dev 預設）。
- `OPTIONS` → `204`，帶 `Access-Control-Allow-Methods`（`GET, POST, OPTIONS`）、
  `Access-Control-Allow-Headers`（`authorization, content-type`）、`Access-Control-Max-Age`（600）、
  `Access-Control-Allow-Origin`（**回具體 origin**）與 `Access-Control-Allow-Credentials: true`。
- 每個回應（含 401／404／405）都帶 `Access-Control-Allow-Origin` 與 `Vary: Origin`：同一條 URL 會因為
  Origin 不同而回應不同標頭，快取必須按 Origin 分開。
- **不在清單裡的 origin 不會拿到任何 CORS 標頭**（讓瀏覽器自己擋），但請求照常處理完 —— CORS 是瀏覽器的
  規則，不是認證；能不能存取由 `Authorization` 決定。
- 刻意不支援 `*`：請求帶 `Authorization`，而 `*` 不能與 credentials 併用。

## bundler relay（`POST /bundler`）

### 為什麼需要

**alto v1.2.5 完全沒有 CORS 支援**：`--help` 沒有相關選項，`OPTIONS` 請求回 404 且回應不帶任何
`access-control-*` 標頭（v1.2.8 才有 `enable-cors`，但它對 EntryPoint v0.7 的 SafeValidator 是壞的）。
所以瀏覽器直連 bundler 一律被 preflight 擋掉：

```
Access to fetch at 'http://127.0.0.1:3001/' from origin 'http://localhost:5173'
has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header
```

**這不是 dev 問題 —— 生產環境一樣。** 瀏覽器永遠無法直連 bundler，所以 UserOp 只能由這支 API 代送。
這支 API 自己已經有 CORS（上一節），前端只需要一個 same-origin（或已列入允許清單）的 `/bundler`。

### 契約

```bash
curl -s -X POST "$API/bundler"   -H "authorization: Bearer $TOKEN" -H 'content-type: application/json'   -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
# {"jsonrpc":"2.0","id":1,"result":"0x38"}
```

- 請求 body **就是** JSON-RPC 信封（`{jsonrpc, id, method, params}`），後端**原樣轉發**收到的 bytes
  （不重新序列化），到 `BUNDLER_URL`。
- 回應也是**上游的 status 與原始 bytes**，含 `result` 或 `error`。**JSON-RPC 的錯誤形狀不改寫**——
  前端要靠 `{code, message, data}` 的原文診斷 AA 錯誤，重新包一層等於把唯一有用的線索丟掉。
- 需要 `Authorization: Bearer <token>`（順序與其他寫入路由一致：先驗 token，再讀 body）。
- 上游 timeout 30 秒。

### 方法白名單

只有這六個會被轉發，其餘一律 `403` 且**不轉發**（檢查在 `fetch` 之前）：

```
eth_sendUserOperation   eth_estimateUserOperationGas   eth_getUserOperationReceipt
eth_getUserOperationByHash   eth_supportedEntryPoints   eth_chainId
```

是**白名單**而不是黑名單：這支 relay 帶著使用者的 session token，能碰到 bundler 就等於能代替使用者發
UserOp；黑名單永遠會漏一個方法，白名單漏掉的代價只是一個 403。

### 錯誤碼

| 情況 | status | code |
| --- | --- | --- |
| 沒帶／帶錯 token | 401 | `UNAUTHORIZED` |
| body 不是合法 JSON、或不是物件 | 400 | `INVALID_JSON` |
| `method` 不在白名單、或沒有 `method` | **403** | `BUNDLER_METHOD_NOT_ALLOWED` |
| 上游連不上／timeout | **502** | `BUNDLER_UNAVAILABLE` |

502 的訊息帶上游位址（例：`bundler http://127.0.0.1:3001/ 無法連上（eth_chainId，timeout 30000ms）：…`），
但 URL 的 userinfo 會被剝掉——bundler 的 API key 常常就嵌在那裡，印出去等於寫進 log 與瀏覽器。
這條路徑不碰任何私鑰，回應裡也不會出現 `0x` + 64 hex 這種東西。

## Migration

- SQL 在 **`../db/migrations`**（`db/` 必須與 `backend/` 並排 checkout）。路徑由 `src/db.ts` 以
  `import.meta.url` 解析，`src/`（tsx）與 `dist/`（tsc）都指向同一個資料夾。
- 啟動時與 `bun run migrate` 都會跑：依檔名排序、每個檔案一個交易、`schema_migrations` 記錄
  filename + sha256、已套用就跳過、已套用檔案被改動則報錯。
- `pg_advisory_lock` 避免多個 instance 同時 migrate。
- 檔案內不要寫 `BEGIN`/`COMMIT`，也不要用 `CREATE INDEX CONCURRENTLY`。細節見 [`../db/README.md`](../db/README.md)。
- 目前兩個檔案：`0001_init.sql`（初始 schema）、`0002_normalize_provider.sql`（既有 `provider` 轉小寫，
  並加上 `strategies_provider_lowercase` CHECK，之後插入／更新都只能是小寫）。

## 設計取捨

- **config / pool 延遲載入**：`getConfig()`、`getPool()` 在第一次使用時才初始化，所以測試可以 import
  `strategies.ts` 而不需要 `DATABASE_URL`；同時 `DATABASE_URL` 仍會在啟動時 fail fast。
- **id 轉型**：`bigserial` 經 `pg` 回來是字串；mapper 明確 `Number()` 成 number（遠低於 2^53），
  `numeric` 欄位則維持字串，避免精度流失。
- **版本號配置**：`max(version)+1` + PK `(strategy_id, version)`。併發發布時靠唯一鍵衝突重試（最多 3 次），
  不需要額外鎖。
- **jsonb 不另開表**：allocation／schedule 是「版本的一份快照」，用 jsonb 保留原樣；形狀由 DB CHECK
  ＋ 應用層校驗兩道把關。
- **路由依賴注入**：`createServer(deps)` 的 deps 是 `Partial<ServerDeps>`（`createStrategy`、`publishVersion`），
  讓路由層測試（201／401／403／404／405）不需要 DB；正式啟動用預設 deps，跑真正的實作。
- **auth 用記憶體 store ＋ SIWE**：nonce／session 都是 process 內的 Map，訊息是標準 EIP-4361，
  驗簽用 `parseSiweMessage` ＋ `recoverMessageAddress`，不引入 JWT 或 session 資料表。好處是零額外基礎設施、
  auth 測試不必連 DB；代價是重啟後 token 全失效、不能水平擴展——單實例 v1 成立，多實例要換共享 store（TODO）。
- **SIWE 訊息由前端組**：`/auth/nonce` 只回欄位，地址由錢包自己填。若後端代填一個示範地址，前端就得重組
  訊息，等於多一份可能不同步的字串樣板；而 `createSiweMessage` 本來就是 viem 的公開 API。
- **不用 `verifySiweMessage`**：它需要 `publicClient`／RPC（合約錢包走 ERC-6492），而這一刀不保證有
  `RPC_URL`；EOA + `recoverMessageAddress` 對目前的使用者足夠，合約錢包列在 TODO。
- **provider 一律小寫**：寫入時 `validateCreateStrategyInput` 轉小寫，DB 再加
  `check (provider = lower(provider))`（0002）當第二道；查詢參數也先轉小寫再精確比對，走得到索引。
- **provider 由 session 推導**：`createStrategy(body, provider)`、`publishVersion(id, body, provider)` 的
  provider 是參數，不採信 body；`publishVersion` 先讀策略列比對 owner 再寫入，不符回 403。

## TODO（後續硬化）

1. 合約錢包（EIP-1271／ERC-6492）：現在只認 EOA 的 `recoverMessageAddress`；接 `RPC_URL` 後改用 viem
   `verifySiweMessage`，讓 smart account 也能登入。
2. Session／nonce 共享 store：in-memory Map 只支援單實例；多實例前換 Redis（或 Postgres），處理 TTL 與併發。
3. CORS、rate limit、request id（`correlation_id` 已有欄位）、body size 以外的防護。
4. `GET /strategies/:id` 要不要把 private 策略也公開？目前是；已有 auth，可據此收斂可見性。
5. operations／positions／performance 的讀寫 API（schema 已就緒，尚無程式）。
6. 錯誤回應加上 `details`（哪個 asset 出錯），方便 web app 顯示。
7. 用 OpenAPI 描述 API；現在 README 是唯一契約。
8. `portfolios.version` 的複合 FK（見 `db/README.md` 的已知缺口）。

### A11 executor ABI 與聚合器

`SwapStep` 為 `{ tokenIn, tokenOut, amountIn, amountOutMin, venue, data }`；
`executeRebalance` selector 是 `0xc52fc5da`。Pancake 的 `venue` 是 Universal Router，
`data = abi.encode(bytes commands, bytes[] inputs)`；KyberSwap 的 data 是 opaque calldata。
舊 session key 的 CallPolicy 不接受新 selector；新 executor 上線前必須重新安裝／續期權限。

規劃器在既有買入額度、單筆限額之內，向 Kyber APIv1 GET routes、POST route/build；sender 與
recipient 固定 executor，不附 native value。只使用鏈上白名單的 ERC20_APPROVE／PERMIT2 venue，
並驗證 build target 與 route router 一致。依相同平台費率比較整數淨得量，平手保留 Pancake；
API／白名單 RPC 失敗或整段超過 5 秒時退回 Pancake。OpenOcean 未接入。
送出前重新讀 oracle 地板並重建 payload；聚合器刷新失敗或 venue 改變時，本輪阻擋，不送舊 calldata。
API 的 steps 與 scheduler log 帶 venue，DB schema 不變。

preflight 需要 `EXECUTOR_DEPLOYMENT_BLOCK`（executor 部署 receipt 的 blockNumber），用來從部署開始
讀 `VenueSet`，再讀各 venue 的當前狀態，已移除的 venue 不列出。UR 必須為 PANCAKE_UR 且 spender=UR。
讀取不完整直接 fail；RPC 必須支援部署至今的事件範圍。

fork 驗收必須從乾淨 fork 開始。先唯讀取得已合併合約 main 的固定 commit，解到 backend
快取再編譯，避免混入 C1 正在修改的工作目錄：

```bash
CONTRACTS_MAIN=$(git -C ../cre8-contracts rev-parse origin/main)
mkdir -p .bun-cache/contracts-47-main
git -C ../cre8-contracts archive "$CONTRACTS_MAIN" | tar -x -C .bun-cache/contracts-47-main
forge build --root .bun-cache/contracts-47-main
```

#47 僅使用 anvil 8616、alto 3076、DB `cre8_x1h`，backend 若啟動僅用 8152。
mixed mining 同時保留即時交易與定時產塊；測試在一般部署交易後明確挖一塊，
再查 receipt，避免尚未入塊的本機 hash 被轉送上游而收到 archive 403。
每次重跑先停止這兩個專用測試服務，再以最新 BSC 主網區塊建立 fork；不要重用已成交過的池子狀態。
`BSC_FORK_RPC` 是唯讀上游，`--silent` 避免印出 anvil 測試金鑰：

```bash
anvil --host 127.0.0.1 --port 8616 --chain-id 56 \
  --fork-url "$BSC_FORK_RPC" --block-time 0.1 --mixed-mining --timeout 120000 --silent
```

alto 使用與 A3 相同的 `@pimlico/alto@0.0.18`（`ALTO_CLI` 指向其 `esm/cli/alto.js`）。
下列啟動僅由公開 anvil 助記詞派生 index 5 帳號；safe-mode 保持開啟，估算採預設，僅 fork RPC 逾時放寬到 120 秒：

```bash
bun -e '
import { spawn } from "node:child_process";
import { mnemonicToAccount } from "viem/accounts";
import { toHex } from "viem";
if (!process.env.ALTO_CLI) throw new Error("set ALTO_CLI to the pinned alto CLI");
const key = mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: 5 }).getHdKey().privateKey;
if (!key) throw new Error("missing public anvil key");
const proc = spawn("node", [process.env.ALTO_CLI,
  "--rpc-url", "http://127.0.0.1:8616", "--port", "3076",
  "--entrypoints", "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  "--executor-private-keys", toHex(key), "--utility-private-key", toHex(key),
  "--deploy-simulations-contract", "--safe-mode", "--timeout", "120000", "--max-block-range", "100",
  "--min-entity-stake", "1", "--min-entity-unstake-delay", "1",
  "--min-executor-balance", "50000000000000000"], { stdio: "inherit" });
proc.on("exit", code => { process.exitCode = code ?? 1; });
'
```

先把 `DATABASE_URL` 指向本機專用的 `cre8_x1h`，不使用其他服務的 `.env`，套用 migration 後執行：

```bash
export MIGRATIONS_DIR=../db/migrations
bun run migrate
RUN_CHAIN_TESTS=1 CHAIN_ID=56 PORT=8152 \
  RPC_URL=http://127.0.0.1:8616 ANVIL_RPC_URL=http://127.0.0.1:8616 \
  BUNDLER_URL=http://127.0.0.1:3076 CONTRACT_ARTIFACTS_DIR=.bun-cache/contracts-47-main/out \
  bun test ./test/a11-venue.fork.ts --timeout=480000
```

測試部署固定 main artifact、建立 Safe 與 Kyber 白名單、送出 DOGE 1,000 USDT 買入，
再由 Safe 撤除 Kyber，預熱 Pancake 候選池並讀 ETH/USDT 雙向實際報價，
驗證規劃器因白名單移除自然退回 Pancake、真的成交並過地板；之後 Safe 恢復 Kyber。
測試先預熱 scheduler 同批持倉的 Multicall3；測試 client／anvil 上游／alto 的 RPC 逾時為 120 秒，
CLI 驗收等待上限 240 秒，整個 fork 測試上限 480 秒；產品預設不變。
Kyber calldata 在交給 alto 前以 `from=Kernel` 的 `eth_call` 預熱；UserOp 仍由 alto 估 gas，
加上既有 1.5 倍餘裕。之後執行原版 scheduler `--once --live`，核對 confirmed operation、
原 session UserOp／permission nonce、新 selector 與完整 venue/data planHash、canonical receipt。
一般 `bun test` 不會選取 `.fork.ts`，必須顯式執行。


完整 suite 要使用同一組本機 RPC／DB，並把 fork 測試最後印出的 registry／executor 地址
設為 `REGISTRY_ADDRESS`／`EXECUTOR_ADDRESS`（測試子程序內的 env 不會傳回 shell）。
router 已同時設定 WBNB oracle，讓 pricing crosscheck 有實際部署可比；然後執行
`RUN_CHAIN_TESTS= bun test --timeout=120000`，一般 suite 的送交易測試維持原有 opt-in 條件。

### 第二價格來源：錯誤、警示與起飛前檢查（#52）

router 掛上 secondary 後，`StaleFeed`、`InvalidAnswer`、`SourcesDisagree` 都會阻擋該資產。
後端從 ABI revert data 解碼，列出資產、secondary feed、updatedAt／鏈上年齡，或 TWAP 與
secondary 報價及差距；拿不到診斷用鏈上時間時會明說未知，不用牆鐘猜，也不回顯 RPC 原文。
hub 規劃會跳過故障資產，在 rationale 記原因，其他可用資產照常規劃。送出前刷新若失敗，
保留整批不送，下一輪重新規劃，避免移除一步後破壞原來的現金預算。已送出的 UserOp 仍先對帳，
不能因來源故障把結果未知的操作當成未送出。

每輪（含 dry-run、沒有到期投組的輪次）檢查 enabled 資產與既有警示中的資產。
同一資產連續 **3 輪**出現以上任一錯誤，建立一筆 `price_source_unavailable` critical，
`portfolio_id = null`，detail 合併受影響資產及原因。DB 需先套用 **0025**。
單一資產恢復不解除全域警示；全部確認恢復才解除。RPC／DB 失敗或缺少觀測不算恢復，
也不累計為一次價格來源故障。三輪門檻前的計數存在 scheduler 程序中，重啟後重新累積；
已建立的 critical 保存在 DB，重啟後仍保留到全部確認恢復。

`bun run preflight --strict` 逐資產列出有無 secondary、maxAge、maxDeviation，並列出
asset/USD 與 numeraire/USD 兩個 feed 的 updatedAt 和鏈上年齡。年齡剛好等於 maxAge 可用；
超過、updatedAt 為 0／未來時間、answer ≤ 0 都 fail；讀取失敗也 fail。
未設定 secondary 會明列「只有 Pancake TWAP」，不自行要求所有資產都必須配置 secondary。

提領續作與 close 可保留其他有價資產的賣出；close 有資產無價時，剩餘名義額維持 null。
首批按 usd 比例提領若不能確認完整待賣名義額，會 blocked，避免把未知剩餘量報成已完成。

獨立 fork 驗收使用 anvil **8636**、DB **cre8_x1j**，backend 若啟動只用 **8172**。
從 contracts main `08ed3453316b9665623a3d39fab49444cd0df1e8` 建立唯讀副本到
`.bun-cache/contracts-52`，使用該版本依賴並 `forge build --root .bun-cache/contracts-52`。
設定上述本機環境及 `MIGRATIONS_DIR` 後執行：

```bash
RUN_CHAIN_TESTS=1 bun test ./test/secondary-price.fork.ts --timeout=120000
```

測試部署真正的 router／PushFeedPriceSource 與可更新的測試 feeds，以 `evm_increaseTime`
製造過期，檢查第三輪全域 critical、健康 ETH 的真實 SwapExecuted 與地板，最後用 snapshot
恢復鏈上時間，驗證警示解除與兩資產重新可規劃。只用 anvil 公開測試助記詞。
