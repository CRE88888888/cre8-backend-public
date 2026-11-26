# 部署到 Railway（server + DB + 排程器）

## 為什麼要三個 service

| Service | 啟動指令 | 為什麼不能合併 |
|---|---|---|
| **api** | `bun src/index.ts` | 需要常駐、對外、healthcheck |
| **scheduler** | `bun run scripts/scheduler.ts --loop --live --interval 60 --limit 20` | **必須是獨立進程**：它會長時間佔住一輪（每輪 40–80 秒），跟 API 共用進程會拖慢請求；而且它要能被單獨重啟 |
| **db** | Railway Postgres | `DATABASE_URL` 由平台注入 |

> ⚠ scheduler 的 `--live` 是真正送交易的那個開關。部署時**先不要加**：先跑 `--loop`（dry-run）
> 看一輪的計數（`/operator` 頁面的 `last round`），確認 `claimed/executed` 符合預期再加上 `--live`。

## 環境變數（api 與 scheduler 都要）

```
DATABASE_URL=            # Railway 注入
CHAIN_ID=56              # 主網；本機 fork 是 1337
RPC_URL=                 # BSC RPC（建議付費/有 archive 的）
BUNDLER_URL=             # alto 或第三方 bundler
REGISTRY_ADDRESS=
EXECUTOR_ADDRESS=
OPERATOR_PRIVATE_KEY=    # ← secret
ATP_SAFE=                # 預期接手 registry / router 的 Safe 公開地址
DEPLOYER_ADDRESS=        # 唯讀 preflight：部署者公開地址，不是私鑰
BUNDLER_EXECUTOR_ADDRESS= # 唯讀 preflight：alto executor 公開地址，不是私鑰
SESSION_KEY_MASTER_SEED= # ← secret
AUTH_DOMAIN=             # SIWE 的 domain
AUTH_URI=                # SIWE 的 uri
ENABLE_OPERATOR_REBALANCE=true
TELEGRAM_BOT_TOKEN=       # 選填 secret；與 CHAT_ID 必須一起填或一起留空
TELEGRAM_CHAT_ID=         # 收件私訊／群組 id（負號要保留）
TELEGRAM_API_BASE=        # 正式留空；預設 https://api.telegram.org，本機假伺服器驗收才覆寫
```

**Secret 放 Railway Variables（等同 secret manager），不要放進 repo**。
`.env` 已在 `.gitignore`；`backend/.env.fork` 也是。

### Telegram critical 警示（A 段只做本機設定）

1. 使用者本人在 Telegram 的官方 [@BotFather](https://t.me/BotFather) 傳 `/newbot`，照提示建立 bot。把拿到的 token 當密碼，只填進 backend 本機 `.env` 的 `TELEGRAM_BOT_TOKEN`。
2. 對新 bot 按「開始／Start」並傳一句話。收件要用群組時，先加 bot 到群組，再在群組傳 `/start@你的bot帳號`。
3. 照 [README 的 chat id 指令與說明](../README.md#telegram-警示) 執行 `getUpdates`，找到對話數字 id，連同負號填進 `TELEGRAM_CHAT_ID`。該指令只印 chat id，不印 token；不要在瀏覽器網址或命令列直接貼 token。
4. 跑 README 的一行手動測試，確認收到訊息，再重啟本機 scheduler。兩個值都空白就停用；只填一個會在啟動時報錯。

新 critical／warn 升級會通知一次，critical 解除再通知一次；持續存在不重送，重啟也不補發。
dry-run 仍會通知並標 `[dry-run]`；live 標 `[live]`，通知含 `CHAIN_ID` 與 first_seen／last_seen。
5 秒逾時或送件失敗只留安全 log，不影響排程器、不重試；請搭配 DB 與 `--alerts` 查閱。
設定本功能不需要 migration。真的 token 不進 repo、log、PR 或 issue。

B 段才由使用者本人在 Railway 的 scheduler Variables 填相同兩個值並重啟服務；
API 若有設定也必須成對，否則保持兩個都空白。**A 段不改 Railway 變數、不部署。**

### ATP v2 的三把金鑰

| 角色 | 用途 | 私鑰放在哪裡 |
|---|---|---|
| relayer | registry operator：`enroll`／`setPaused`；也是策略註冊／發版本的 provider | api／scheduler 的 `OPERATOR_PRIVATE_KEY` |
| bundler | alto 送 `handleOps` | 只在 alto 的 `EXECUTOR_PRIVATE_KEY`；`UTILITY_PRIVATE_KEY` 未設定時沿用此 key |
| 部署者 | `forge script` 部署及交接；Safe 接受 ownership 後不再有 owner 權限 | 只在部署時使用，不進 backend 或 alto 執行期 |

backend 只持有 relayer 營運私鑰與派生受限 session key 的 seed。另兩個角色只以
`DEPLOYER_ADDRESS`、`BUNDLER_EXECUTOR_ADDRESS` 公開地址供 preflight 驗證；三者必須兩兩不同，
也都不能等於 `ATP_SAFE`。不要把三個服務的 secrets 全部複製給彼此。
這是 B 段由使用者本人套用的設定；A 段只在本機 fork 用 anvil #0／#4／#5 驗證，不改 Railway。

## 排程器的健康狀態從哪裡看

`/operator` 頁面的 `scheduler` 列：

```
scheduler   [alive] · LIVE · every 60s · limit 20 · threshold 100 bps · round 137 · pid 1
last round  claimed 3  executed 2  noop 1  blocked 0  failed 0   · finished 42s ago
```

心跳落後超過 **180 秒**（`HEARTBEAT_STALE_SECONDS`）就會顯示 `stale` —— 那代表進程死了或卡住，
Railway 的 `restartPolicyType: ON_FAILURE` 會重啟它。

## ⚠ `railway up` 上傳的是「連結時的專案根目錄」，不是當前目錄

實測踩了很久：在 `.deploy/` 裡跑 `railway up`，上傳的卻是 `backend/`（`railway link` 記錄的根目錄），
於是 image 裡**永遠沒有 migration**，容器啟動時：

    ENOENT: no such file or directory, scandir '/app/migrations'

本地 `docker build` 完全正常，所以這個錯誤很容易被誤判成 Dockerfile 有問題。

正確做法（`--path-as-root` 讓 PATH 成為 archive 根）：

```bash
bun run scripts/prepare-deploy.ts                      # 產生 .deploy/（含 migrations）
railway up .deploy --path-as-root -d --service api     # 注意這三個參數
```

其他踩過的坑，一併記在這裡：

| 症狀 | 原因 |
|---|---|
| 部署到 Postgres 服務、把資料庫打掉 | `railway up` 預設部署到**已連結的服務**；建完 Postgres 後它就是唯一服務。**先 `railway add --service api`，再 `--service api`** |
| 上傳被過濾成空 | `.gitignore` 會參與上傳過濾；`.deploy/.gitignore` 若含 `.deploy/` 規則會把整個目錄排除 → 用 `--no-gitignore`，且 `prepare-deploy` 不複製 `.gitignore` |
| `railway` 一直 `Failed to set permissions on ~/.railway` | 沙箱不能寫家目錄 → `HOME=<可寫目錄> railway ...` |
| `postgres.railway.internal` 解析失敗（本地） | Railway 私有網路只在平台內可解析；migration 必須由**容器**執行，不能當本機步驟 |

## ⚠ migration 不在容器裡跑（實測踩過）

`db/migrations` 住在**隔壁的 repo**（`cre8-protocol/db`），而 Docker / Railway 的 build context
只有 `backend/` —— image 裡沒有那些 .sql。所以：

* `Dockerfile` 設 `MIGRATIONS_ENABLED=0`
* migration 是**部署步驟**，用 Railway 的 DATABASE_URL 跑：

```bash
railway run bun run src/migrate.ts      # 用服務的環境變數跑（不需要把連線字串貼出來）
# 或
DATABASE_URL=<railway-postgres-url> bun run src/migrate.ts
```

`railway run` 是首選：它把 Railway 服務的環境變數注入本地指令，連線字串不必經過終端機歷史。

## 首次部署順序

1. 建 Postgres → 拿到 `DATABASE_URL`
2. **先跑 migration**：`railway run bun run src/migrate.ts`（在 image 部署之前跑也可以，
   migration 只依賴 DB）
3. 部署 **api** → `/health` 應回 `status: ok`
4. 部署 **scheduler**，先不帶 `--live`，確認 `/operator` 的 `last round` 有數字
5. 確認無誤後把 `--live` 加上，並觀察第一輪的 `executed`

## 部署前後都要跑一次

```bash
MIGRATIONS_ENABLED=0 railway run bun run scripts/preflight.ts --strict
```

`--strict`：任何 warn 都算失敗（主網不接受「知道但先不管」）。它會檢查
RPC 的 chainId 是否與 CHAIN_ID 一致、合約位址上是否真的有 code、registry／router 是否已交接給
`ATP_SAFE`、registry operator 是否符合 relayer、executor.oracle 是否為零位址、DB migration 套了幾個。
此外，strict 要求 `DEPLOYER_ADDRESS` 與 `BUNDLER_EXECUTOR_ADDRESS` 都是非零合法地址；
relayer、部署者、bundler 必須兩兩不同且都不是 Safe。缺少角色地址時 strict fail（非 strict warn），
重複、零地址或格式錯誤則一律 fail。檢查全程唯讀，只輸出公開地址。
