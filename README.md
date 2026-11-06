# cre8-atp-backend

CRE8 ATP 的鏈下後端（第一刀）。Bun + TypeScript + Postgres，直接用 `pg`，**不用 ORM**（與 web app 一致）。
預設鏈是 BNB Chain mainnet（chain 56）。目前做策略資料層、版本發布與 v1 錢包簽章 auth（共七個路由）。

## 架構

```
HTTP → src/index.ts（啟動：config → migrate → listen）
         └─ src/server.ts（node:http 路由、JSON、錯誤映射、auth 守門）
              ├─ src/auth.ts（nonce、EIP-191 驗簽、session token）
              └─ src/strategies.ts（領域邏輯 + 純函式校驗）
                   └─ src/db.ts（pg Pool、query、transaction、migrate）
                        └─ Postgres（schema 在 ../db/migrations）
```

| 檔案 | 職責 |
| --- | --- |
| `src/config.ts` | 讀 env；`DATABASE_URL` 必填，`PORT` 預設 8080，`CHAIN_ID` 預設 56。 |
| `src/auth.ts` | nonce／session 的 in-memory store、`personal_sign` 驗簽（viem `recoverMessageAddress`）、`authenticate()`。 |
| `src/db.ts` | 單一 `Pool`、`query()`、`withTransaction()`、`migrate()`（checksum + advisory lock）。 |
| `src/errors.ts` | `AppError`／`ValidationError`／`NotFoundError`，讓領域層不必知道 HTTP。 |
| `src/strategies.ts` | `listStrategies`、`getStrategy`、`createStrategy`、`publishVersion`，以及 allocation／schedule 校驗。 |
| `src/server.ts` | 路由、body 解析（上限 1 MB）、錯誤 → JSON、access log。 |
| `src/index.ts` | 啟動與優雅關閉（SIGINT／SIGTERM）。 |
| `src/migrate.ts` | `bun run migrate`：只跑 migration，不啟 server。 |
| `test/strategies.test.ts` | 校驗純函式與 HTTP 路由單測（路由層可注入 `createStrategy`／`publishVersion`，不需 DB）；DB 整合測試以 `DATABASE_URL` 為 gate。 |
| `test/auth.test.ts` | nonce／login／session 與 provider ownership；用 viem 隨機錢包在測試內簽名，走完整 HTTP 流程。 |

選擇 `node:http` 而不是 express：這一刀只有七個路由，少一層依賴；`server.ts` 的 `route()` 是唯一需要換掉的
地方，之後要上 express/Fastify 不會動到領域層。

## 環境變數

| 變數 | 必填 | 預設 | 說明 |
| --- | --- | --- | --- |
| `DATABASE_URL` | ✅ | — | Postgres 連線字串；缺少時 `getConfig()` 直接 throw。 |
| `PORT` | | `8080` | HTTP 埠，1–65535。 |
| `CHAIN_ID` | | `56` | EIP-155 chain id；56 = BSC mainnet，97 = testnet。 |
| `RPC_URL` | | 空 | JSON-RPC endpoint；目前只用於 `/health` 回報是否設定。 |

複製 `.env.example` 為 `.env` 即可；`.env` 不進版控。**不要**把真的 RPC URL 或連線字串寫進 repo。

## 指令

```bash
bun install
cp .env.example .env       # 填入 DATABASE_URL

bun run dev                # bun --watch src/index.ts（啟動時先 migrate）
bun run migrate            # 只套用 migration
bun run start              # bun src/index.ts
bun run typecheck          # tsc --noEmit（src + test 兩份 tsconfig）
bun test                   # bun 內建 test runner；沒有 DATABASE_URL 時 DB 測試會 skip
```

需求：Bun >= 1.4（`package.json` 的 `engines`）。bun 原生跑 TypeScript，不需 build 步驟、不需 tsx。

### 測試與 DB

```bash
# 純函式 + auth／路由測試（不需 DB）
bun test

# 加上 DB 整合測試；請用可拋棄的資料庫，測試會跑 migration 並建立／刪除資料
DATABASE_URL='postgres://postgres@127.0.0.1:5432/cre8_atp_test' bun test
```

沒有 `DATABASE_URL` 時，`node:test` 會把 DB 測試標成 skipped（不是 passed）。整合測試會自己
`migrate()`，並在 `finally` 清掉建立的 strategy（versions 由 FK cascade）。

## API

所有回應都是 `application/json; charset=utf-8`，錯誤格式固定為
`{"error":{"code":"...","message":"..."}}`。

| Method | Path | 說明 | 成功碼 |
| --- | --- | --- | --- |
| `GET` | `/health` | Postgres 可連線時 200，否則 503（`db: "down"`） | 200 |
| `GET` | `/strategies` | 列表；`limit`（1–100，預設 50）、`offset`、`provider`、`public=true\|false` | 200 |
| `GET` | `/strategies/:id` | 單一策略 + 版本歷史（新到舊） | 200 |
| `POST` | `/auth/nonce` | 取得一次性 nonce（32 bytes hex，TTL 5 分鐘）；不需 body | 200 |
| `POST` | `/auth/login` | body `{wallet, nonce, signature}`；回 `{token, expiresAt}` | 200 |
| `POST` | `/strategies` | 建立策略 metadata；**需** `Authorization: Bearer <token>` | 201 + `Location` |
| `POST` | `/strategies/:id/versions` | 發布新版本；**需** token 且必須是該策略的 provider | 201 |

### Auth（v1：錢包簽章 + session token）

沒有密碼、沒有第三方服務。流程是「拿 nonce → 錢包簽 → 換 token → 帶 token 打寫入路由」：

1. `POST /auth/nonce` 取得一次性 nonce（32 bytes hex，TTL 5 分鐘）：
   ```bash
   curl -s -X POST localhost:8080/auth/nonce
   # {"nonce":"<64 hex>","expiresAt":"..."}
   ```
2. 錢包用 EIP-191 `personal_sign` 簽這段**完全相同**的 UTF-8 字串（viem：`account.signMessage({ message })`）：
   ```
   Sign in to CRE8 ATP

   Nonce: <nonce>
   ```
   （第一行、空行、`Nonce: ` 加一個空格、nonce 值；換行是 `\n\n`。）
3. `POST /auth/login`，body 是 `{"wallet":"0x…","nonce":"…","signature":"0x…"}`：
   ```bash
   curl -s -X POST localhost:8080/auth/login -H 'content-type: application/json' -d '{
     "wallet": "0xYourWallet",
     "nonce": "<nonce>",
     "signature": "0x<65-byte signature>"
   }'
   # {"token":"<64 hex>","expiresAt":"..."}
   ```
   後端用 `recoverMessageAddress({ message, signature })` 解出地址，轉小寫後必須等於 `wallet`，
   否則 401 `INVALID_SIGNATURE`；nonce 成功後立即刪除（再重用 → 400 `INVALID_NONCE`，過期 → 400 `NONCE_EXPIRED`）。
   token TTL 24 小時。
4. 寫入路由帶 `Authorization: Bearer <token>`；伺服器把 token 換回錢包地址，**provider 一律由 session 推導**，
   body 裡的 `provider` 會被忽略。不是策略 owner 卻發布版本 → 403 `FORBIDDEN`。

nonce 與 session 目前是**單一 process 的 in-memory Map**：重啟即失效，也只能跑單實例。水平擴展前必須換成
Redis 或其它共享 store（見 TODO）。

```bash
curl -s localhost:8080/health
# {"status":"ok","service":"cre8-atp-backend","chainId":56,"rpcConfigured":false,"db":"ok","uptimeSeconds":3}

curl -s -X POST localhost:8080/strategies -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "name": "Index 500",
  "description": "BSC bStock index",
  "isPublic": true,
  "swapFeeBps": 25
}'
# {"id":1,"provider":"0x<session wallet, lowercase>",...,"swapFeeBps":25,"createdAt":"..."}

curl -s -X POST localhost:8080/strategies/1/versions -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
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
- 1–16 個資產（`MAX_VERSION_ASSETS`）；address 必須是 0x + 40 hex，入庫前轉小寫。
- 同一版本內資產不可重複（address 不分大小寫）。
- `weightBps` 必須是 1–10000 的整數，總和**必須剛好 10000**。
- `schedule` 是 `{"kind":"interval","intervalSeconds":>=60}` 或 `{"kind":"cron","cron":"…"}`。
- `changeLog` 選填，≤ 2000 字；`activeAt` 選填，預設 `now()`。
- 必須帶 token，且該策略 DB 的 `provider` 必須等於 session 錢包（不分大小寫），否則 403 `FORBIDDEN`。

錯誤碼：`INVALID_ALLOCATION`、`ALLOCATION_EMPTY`、`TOO_MANY_ASSETS`、`INVALID_ASSET`、
`DUPLICATE_ASSET`、`WEIGHT_OUT_OF_RANGE`、`WEIGHT_SUM`、`INVALID_SCHEDULE`、`INVALID_VERSION`、
`INVALID_STRATEGY`、`INVALID_SWAP_FEE`、`INVALID_ID`、`INVALID_QUERY`、`INVALID_JSON`、`NOT_FOUND`、
`METHOD_NOT_ALLOWED`、`PAYLOAD_TOO_LARGE`、`DB_UNAVAILABLE`、`INTERNAL`、`UNAUTHORIZED`、
`FORBIDDEN`、`INVALID_AUTH`、`INVALID_NONCE`、`NONCE_EXPIRED`、`INVALID_SIGNATURE`。

## Migration

- SQL 在 **`../db/migrations`**（`db/` 必須與 `backend/` 並排 checkout）。路徑由 `src/db.ts` 以
  `import.meta.url` 解析，`src/`（tsx）與 `dist/`（tsc）都指向同一個資料夾。
- 啟動時與 `bun run migrate` 都會跑：依檔名排序、每個檔案一個交易、`schema_migrations` 記錄
  filename + sha256、已套用就跳過、已套用檔案被改動則報錯。
- `pg_advisory_lock` 避免多個 instance 同時 migrate。
- 檔案內不要寫 `BEGIN`/`COMMIT`，也不要用 `CREATE INDEX CONCURRENTLY`。細節見 [`../db/README.md`](../db/README.md)。

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
- **auth 用記憶體 store**：nonce／session 都是 process 內的 Map，驗簽用 viem 的 `recoverMessageAddress`，
  不引入 JWT 或 session 資料表。好處是零額外基礎設施、auth 測試不必連 DB；代價是重啟後 token 全失效、
  不能水平擴展——單實例 v1 成立，多實例要換共享 store（TODO）。
- **provider 由 session 推導**：`createStrategy(body, provider)`、`publishVersion(id, body, provider)` 的
  provider 是參數，不採信 body；`publishVersion` 先讀策略列比對 owner 再寫入，不符回 403。

## TODO（後續硬化）

1. SIWE（EIP-4361）：目前訊息是自訂的 `Sign in to CRE8 ATP` + nonce；改用 EIP-4361 可帶 domain、uri、
   chainId、issuedAt、expirationTime，防釣魚與跨站重用。在此之前，錢包顯示的訊息無法自我描述來源。
2. Session／nonce 共享 store：in-memory Map 只支援單實例；多實例前換 Redis（或 Postgres），處理 TTL 與併發。
3. CORS、rate limit、request id（`correlation_id` 已有欄位）、body size 以外的防護。
4. `GET /strategies/:id` 要不要把 private 策略也公開？目前是；已有 auth，可據此收斂可見性。
5. operations／positions／performance 的讀寫 API（schema 已就緒，尚無程式）。
6. 錯誤回應加上 `details`（哪個 asset 出錯），方便 web app 顯示。
7. 用 OpenAPI 描述 API；現在 README 是唯一契約。
8. `portfolios.version` 的複合 FK（見 `db/README.md` 的已知缺口）。
