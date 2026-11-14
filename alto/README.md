# alto bundler（自架於 Railway）

```
Railway service: alto
URL:             https://alto-production-c309.up.railway.app
image:           ghcr.io/pimlicolabs/alto:v1.2.5
```

## 為什麼 pin v1.2.5

v1.2.8 的 `SafeValidator` 對 EntryPoint v0.7 **是壞的**：它用零 error 條目的
`pimlicoSimulationsAbi` 做 `decodeErrorResult`，導致任何 UserOp 都失敗。
v1.2.8 + `safe-mode=false` 雖然能跑，但那等於用「不強制 ERC-4337 規則」的環境驗證護欄 ——
實測 v1.2.5 + `safe-mode=true` 能正確擋下偽造簽章（`AA23 reverted - 0x8baa579f`，OZ `ECDSA.InvalidSignature()`）。
完整驗證見 `spike/alto/V125-VERDICT.md`。

## 為什麼用 entrypoint 轉參數而不掛 config 檔

Railway 的 image 部署沒有地方放檔案，而 v1.2.5 的 `--config` 需要實際路徑。
`entrypoint.sh` 把環境變數轉成 CLI flags（v1.2.5 全部支援），機密留在 Railway Variables。

## 部署

```bash
cd backend
railway up ../alto --path-as-root -d --service alto --no-gitignore
```

⚠ `--path-as-root` 必要：`railway up` 預設上傳「連結時的專案根目錄」。

## 環境變數

| 變數 | 說明 |
|---|---|
| `RPC_URL` | BSC 主網 RPC |
| `EXECUTOR_PRIVATE_KEY` | bundler 專用錢包（需 BNB），由 alto 送 `handleOps`；必須與 backend relayer、部署者及 Safe 分開，只放 alto 服務 |
| `UTILITY_PRIVATE_KEY` | 選填；補 executor 餘額／部署 helper 的 utility key，未設定時沿用 `EXECUTOR_PRIVATE_KEY`（既有 fallback） |
| `SAFE_MODE` | 預設 `true`；關掉等於不強制 ERC-4337 驗證規則 |
| `MIN_EXECUTOR_BALANCE` | refill 門檻，預設 0.02 BNB（BSC 上 1 BNB 太高） |

ATP v2 的 backend 只放 relayer 的 `OPERATOR_PRIVATE_KEY`（registry operator 的 `enroll`／`setPaused`，
以及策略註冊／發版本的 provider）；部署者私鑰只在 `forge script` 部署時使用，Safe 接手後不再有 owner 權限。
這兩把私鑰都不放 alto；bundler 私鑰也不放 backend。
backend 的 preflight 只讀 `DEPLOYER_ADDRESS`、`BUNDLER_EXECUTOR_ADDRESS` 公開地址，檢查三個角色
兩兩不同且都不是 `ATP_SAFE`。`--strict` 缺地址會 fail；任何重複都 fail。
本機 fork 使用 anvil #0（部署者）、#4（relayer）、#5（bundler）的公開測試帳號。
A 段只更新本機設定與文件；Railway 的實際金鑰輪替由使用者在 B 段執行。

## 已知限制

* `--deploy-simulations-contract` 會在啟動時部署一個 helper 合約（花一點 gas）
* publicnode 對 archive 查詢需要 token，某些 debug 端點會 403

## Chain 97（backend#69）

測試網另起一個 alto，設定 `CHAIN_ID=97`、97 的 `RPC_URL`、`EXECUTOR_PRIVATE_KEY` 與不同的
`UTILITY_PRIVATE_KEY`。程式只讀 env，不讀金鑰檔；本機 launcher 可以把測試網金鑰載入 env，不能印出。
97 強制 `SAFE_MODE=true` 和 EntryPoint v0.7；executor refill 預設 0.01 tBNB，可用
`MIN_EXECUTOR_BALANCE` 覆寫（56 仍是 0.05 BNB）。`MAX_BLOCK_RANGE` 在 97 預設 100，讓本機
fork 的 receipt 查詢留在本機區塊範圍。Docker image 維持 v1.2.5；本機 npm 安裝可用
`ALTO_CLI_PATH` 指向 CLI（合約驗收用 `@pimlico/alto@0.0.18`）。

backend 設 `CHAIN_ID=97` 後採用 `src/testnet-profile.ts` 的固定地址與 39 個資產（38 + MockUSDT），
來源是 contracts `f7e5d52` 的已提交 manifest；不要從 contracts 主 clone 的未提交工作樹複製部署輸入。
registry／executor／paymaster 的 env 可以留空；顯式填入不同地址會拒絕啟動。97 不讀主網資產 seed、
不呼叫 KyberSwap／OpenOcean，session GasPolicy 強制使用自己的 paymaster。

`POST /faucet/usdt` 的 body 是 `{ "account": "<已 enroll、屬於登入 owner 的 Kernel 地址>" }`。
每個 owner 每個 UTC 日固定一次，預設 1,000 USDT；全站每 UTC 日預設 1,000,000 USDT。
只有 `FAUCET_USDT_AMOUNT_WEI` 與 `FAUCET_USDT_SITE_DAILY_WEI` 可以覆寫（18 decimals 的整數 base units）；
任一設 0 就不發幣，每次不能超過合約的 10,000 USDT，收款地址仍受合約 24 小時窗限制。
需要 db 0028；先 commit 配額及簽名交易 hash，再廣播。成功回 200，未知結果回 202 並保留額度，
已用額度回 429。交易結果未知／程序中斷的紀錄必須人工對帳，不能刪列、逾時釋放或另取 nonce 重送。
API 多實例與 enroll 共用 relayer session lock，忙碌時回 503。已保存 hash 但結果未知的 faucet 交易會擋住新的 97 relayer 工作，直到人工對帳完成；不能重新取 nonce 重送。

本機驗收只用 8556／8092／3056 和 `cre8_x1b`：先以 `git archive f7e5d52` 取得乾淨 contracts 副本，
跑 `scripts/testnet/deploy-97.sh fork`、TWAP 暖機與 `PushFeedsTestnet`，再依
`test/testnet-97.e2e.ts` 檔頭設定 env 執行：

```bash
bun run test/testnet-97.e2e.ts
bun run preflight --chain 97 --strict
```

E2E 會起本機 alto／backend，走 SIWE → 發佈策略 → enroll → HTTP faucet → owner approve →
scheduler 自有 paymaster 再平衡 → snapshot／status／redeem plan → strict preflight，並移除自己建立的 DB fixture。
owner approve 仍由 owner 簽名並自付 gas（#66 白名單不代付 approve）；scheduler 的 smart account BNB 為 0。
暖機會推進 fork 時間，因此 E2E 只在驗收行程中對齊模擬時鐘，沒有修改正式 signer 的短效期限。
preflight 會核對 157 個地址的 codehash 與必要 selector；`EXECUTOR_DEPLOYMENT_BLOCK` 要填該次 fork
真正的 executor 建立區塊。整套驗收拒絕公開 RPC、其他埠或其他 DB。
