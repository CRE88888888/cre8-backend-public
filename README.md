# cre8-atp-backend

CRE8 ATP 的鏈下後端（第一刀）。Bun + TypeScript + Postgres，直接用 `pg`，**不用 ORM**（與 web app 一致）。
預設鏈是 BNB Chain mainnet（chain 56）。目前只做策略資料層與四個唯讀／建立路由，**尚無 auth**。

## 架構

```
HTTP → src/index.ts（啟動：config → migrate → listen）
         └─ src/server.ts（node:http 路由、JSON、錯誤映射）
              └─ src/strategies.ts（領域邏輯 + 純函式校驗）
                   └─ src/db.ts（pg Pool、query、transaction、migrate）
                        └─ Postgres（schema 在 ../db/migrations）
```

| 檔案 | 職責 |
| --- | --- |
| `src/config.ts` | 讀 env；`DATABASE_URL` 必填，`PORT` 預設 8080，`CHAIN_ID` 預設 56。 |
| `src/db.ts` | 單一 `Pool`、`query()`、`withTransaction()`、`migrate()`（checksum + advisory lock）。 |
| `src/errors.ts` | `AppError`／`ValidationError`／`NotFoundError`，讓領域層不必知道 HTTP。 |
| `src/strategies.ts` | `listStrategies`、`getStrategy`、`createStrategy`、`publishVersion`，以及 allocation／schedule 校驗。 |
| `src/server.ts` | 路由、body 解析（上限 1 MB）、錯誤 → JSON、access log。 |
| `src/index.ts` | 啟動與優雅關閉（SIGINT／SIGTERM）。 |
| `src/migrate.ts` | `bun run migrate`：只跑 migration，不啟 server。 |
| `test/strategies.test.ts` | 校驗純函式單測；DB 整合測試以 `DATABASE_URL` 為 gate。 |

選擇 `node:http` 而不是 express：這一刀只有四個路由，少一層依賴；`server.ts` 的 `route()` 是唯一需要換掉的
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
# 純函式測試（不需 DB）
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
| `POST` | `/strategies` | 建立策略 metadata | 201 + `Location` |

```bash
curl -s localhost:8080/health
# {"status":"ok","service":"cre8-atp-backend","chainId":56,"rpcConfigured":false,"db":"ok","uptimeSeconds":3}

curl -s -X POST localhost:8080/strategies -H 'content-type: application/json' -d '{
  "provider": "0xprovider",
  "name": "Index 500",
  "description": "BSC bStock index",
  "isPublic": true,
  "swapFeeBps": 25
}'
# {"id":1,...,"swapFeeBps":25,"createdAt":"..."}
```

列表回傳 `{ items, total, limit, offset }`；`total` 是符合條件的總筆數，不是本頁筆數。

### 校驗規則（與鏈上 `AtpRegistry` 對齊）

`POST /strategies`：

- `provider`、`name` 必填、去空白後非空；`name` ≤ 120 字、`provider` ≤ 200 字。
- `description` ≤ 2000 字，預設 `""`。
- `isPublic` 必須是 boolean，預設 `true`。
- `swapFeeBps` 必須是 0–300 的整數（3% 上限，對齊 `MAX_SWAP_FEE_BPS`），預設 0。

`publishVersion()`（目前只有函式與測試，尚無 HTTP 路由）：

- `allocation` 必須是 `{"assets":[{"address":"0x…","symbol"?:"  ≤32 字","weightBps":2500}]}`。
- 1–16 個資產（`MAX_VERSION_ASSETS`）；address 必須是 0x + 40 hex，入庫前轉小寫。
- 同一版本內資產不可重複（address 不分大小寫）。
- `weightBps` 必須是 1–10000 的整數，總和**必須剛好 10000**。
- `schedule` 是 `{"kind":"interval","intervalSeconds":>=60}` 或 `{"kind":"cron","cron":"…"}`。
- `changeLog` 選填，≤ 2000 字；`activeAt` 選填，預設 `now()`。

錯誤碼：`INVALID_ALLOCATION`、`ALLOCATION_EMPTY`、`TOO_MANY_ASSETS`、`INVALID_ASSET`、
`DUPLICATE_ASSET`、`WEIGHT_OUT_OF_RANGE`、`WEIGHT_SUM`、`INVALID_SCHEDULE`、`INVALID_STRATEGY`、
`INVALID_SWAP_FEE`、`INVALID_ID`、`INVALID_QUERY`、`INVALID_JSON`、`NOT_FOUND`、
`METHOD_NOT_ALLOWED`、`PAYLOAD_TOO_LARGE`、`DB_UNAVAILABLE`、`INTERNAL`。

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
- **無 auth**：`provider`、`user_id` 目前是宣稱值；API 對外開放前必須補錢包簽章／session。

## TODO（下一刀）

1. **`POST /strategies/:id/versions`**：`publishVersion()` 已完成並有測試，但尚未接路由。
2. Auth：provider 只能發布／修改自己的策略；`user_id` 由 session 推導，不由 body 傳入。
3. CORS、rate limit、request id（`correlation_id` 已有欄位）、body size 以外的防護。
4. `GET /strategies/:id` 要不要把 private 策略也公開？目前是；需要 auth 後再收斂可見性。
5. operations／positions／performance 的讀寫 API（schema 已就緒，尚無程式）。
6. 錯誤回應加上 `details`（哪個 asset 出錯），方便 web app 顯示。
7. 用 OpenAPI 描述 API；現在 README 是唯一契約。
8. `portfolios.version` 的複合 FK（見 `db/README.md` 的已知缺口）。
