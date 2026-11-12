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
