# cre8-atp-backend

CRE8 ATP 的鏈下後端（第一刀）。Bun + TypeScript + Postgres，直接用 `pg`，**不用 ORM**（與 web app 一致）。
預設鏈是 BNB Chain mainnet（chain 56）。目前做策略資料層、版本發布與 SIWE（EIP-4361）錢包簽章 auth（共七個路由）。

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
| `src/server.ts` | 路由、body 解析（上限 1 MB）、錯誤 → JSON、access log。 |
| `src/index.ts` | 啟動與優雅關閉（SIGINT／SIGTERM）。 |
| `src/migrate.ts` | `bun run migrate`：只跑 migration，不啟 server。 |
| `test/strategies.test.ts` | 校驗純函式與 HTTP 路由單測（路由層可注入 `createStrategy`／`publishVersion`，不需 DB）；DB 整合測試以 `DATABASE_URL` 為 gate。 |
| `test/auth.test.ts` | SIWE nonce／login／session 與 provider ownership；用 viem `createSiweMessage` + 隨機錢包在測試內簽名，走完整 HTTP 流程。 |

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
| `GET` | `/strategies` | 列表；`limit`（1–100，預設 50）、`offset`、`provider`（不分大小寫）、`public=true\|false` | 200 |
| `GET` | `/strategies/:id` | 單一策略 + 版本歷史（新到舊） | 200 |
| `POST` | `/auth/nonce` | 取得一次性 nonce 與 SIWE 欄位（`domain`／`chainId`／`uri`／`statement`／`issuedAt`，TTL 5 分鐘）；不需 body | 200 |
| `POST` | `/auth/login` | body `{message, signature}`（完整 EIP-4361 訊息）；回 `{token, expiresAt}` | 200 |
| `POST` | `/strategies` | 建立策略 metadata；**需** `Authorization: Bearer <token>` | 201 + `Location` |
| `POST` | `/strategies/:id/versions` | 發布新版本；**需** token 且必須是該策略的 provider | 201 |

### Auth（SIWE／EIP-4361 + session token）

沒有密碼、沒有第三方服務。流程是「拿 SIWE 欄位 → 前端用 viem 組 EIP-4361 訊息 → 錢包簽 → 換 token →
帶 token 打寫入路由」。訊息綁住 **domain + chainId + nonce + issuedAt**，被釣到別的站台或別的鏈都簽不出可用的
訊息。

1. `POST /auth/nonce` 取得一次性 nonce（32 bytes hex，TTL 5 分鐘）與組訊息所需的欄位：
   ```bash
   curl -s -X POST localhost:8080/auth/nonce
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
   curl -s -X POST localhost:8080/auth/login -H 'content-type: application/json' -d '{
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
`FORBIDDEN`、`INVALID_AUTH`、`INVALID_NONCE`、`NONCE_EXPIRED`、`INVALID_SIGNATURE`、
`INVALID_SIWE_MESSAGE`、`SIWE_EXPIRED`。

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
