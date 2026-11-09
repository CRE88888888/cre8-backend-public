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
SESSION_KEY_MASTER_SEED= # ← secret
AUTH_DOMAIN=             # SIWE 的 domain
AUTH_URI=                # SIWE 的 uri
ENABLE_OPERATOR_REBALANCE=true
```

**Secret 放 Railway Variables（等同 secret manager），不要放進 repo**。
`.env` 已在 `.gitignore`；`backend/.env.fork` 也是。

## 排程器的健康狀態從哪裡看

`/operator` 頁面的 `scheduler` 列：

```
scheduler   [alive] · LIVE · every 60s · limit 20 · threshold 100 bps · round 137 · pid 1
last round  claimed 3  executed 2  noop 1  blocked 0  failed 0   · finished 42s ago
```

心跳落後超過 **180 秒**（`HEARTBEAT_STALE_SECONDS`）就會顯示 `stale` —— 那代表進程死了或卡住，
Railway 的 `restartPolicyType: ON_FAILURE` 會重啟它。

## 首次部署順序

1. 建 Postgres → 拿到 `DATABASE_URL`
2. 部署 **api**（Dockerfile 會先跑 `src/migrate.ts`）→ `/health` 應回 `status: ok`
3. 部署 **scheduler**，先不帶 `--live`，確認 `/operator` 的 `last round` 有數字
4. 確認無誤後把 `--live` 加上，並觀察第一輪的 `executed`
