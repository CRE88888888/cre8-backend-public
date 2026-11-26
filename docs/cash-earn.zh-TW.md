# 現金生息（Cash Earn，backend#193）

依 `docs/EARN_UX.zh-TW.md`（docs repo）A、D 節。依賴 db 0060（`cash_earn_flows`）。

## 設計

- **現金帳戶＝用戶錢包直接持有白名單 USDT vault 的部位**。非託管、不經 AtpExecutor（executor 生息需要基金 enrollment、每資產 24 小時冷卻、50 USDT 下限），不需要新合約。
- 存入／領出都是用戶自己的錢包送出（後端只產生 calldata）：存入＝`approve`（額度不足才有）＋協議存入；領出＝一筆。錢不會在用戶沒按的情況下被移動。測試網錢包沒有 tBNB 時沿用既有 gas faucet（同 My mix 轉帳）。
- 每個 call 帶建議 `gas`（approve 100k、vault 呼叫 400k）。vault 會先計息：錢包在「沒有經過時間」的區塊估 gas，下一個區塊才執行時會多一次計息 mint，chain-97 Venus mock 實測會 out of gas，所以前端要送這個 gas。
- 白名單：chain-97 profile 裡 asset=USDT 的三個市場 `venus_usdt`、`lista_usdt`、`aave_v3_usdt`，不接受請求帶地址。
- 帳本 `cash_earn_flows` 只記「錢包 ↔ vault custody 地址」的 USDT 轉帳，由 `POST /me/earn/confirm` 驗證後寫入（交易必須成功、canonical、由本人錢包送出；`(chain, tx, log)` 唯一）。累計收益＝現值＋已領出−已存入；算出負值代表有沒確認的存入，回 `null`，不回負數。
- 三種錢分開：回應裡 `wallet.availableRaw`（錢包 USDT）與 `cashEarn.*` 分開，不提供兩者加總；投資組合的生息（`/yield/*`、`/portfolios/:id/yield/*`）是另一套帳本。

## 利率與門檻

- `apyBps`＝基礎 APY＋激勵 APR。基礎 APY 由 vault 的 APR 以連續複利換算（模擬市場每次互動計息）；激勵讀 vault 的 `incentiveAprBps()`，沒有這個函式（目前的模擬市場）時為 `null`、不加。`breakdown` 逐項回 `{kind:'base'|'incentive', label, bps, source, updatedAt}`，前端只顯示合計、可展開。
- 使用率 U＝(總存款−可領現金)/總存款，無條件進位。**U > 90%** 不收新錢（`deposits_paused`、`high_utilization`）；**U > 95%** 標 `withdraw_recommended`；剛好 90%／95% 仍算前一級。暫停、額度滿、讀不到資料也不收新錢。
- 「Best rate」標在目前可存入的 vault 中合計 APY 最高者。
- D 節「超過 95% 主動領出一部分」：錢包直接持有的部位後端無權移動，第一版只回狀態讓前端提醒用戶領出；自動領出需要另外的帳戶授權設計。

## API

| 方法與路徑 | body | 回應重點 |
| --- | --- | --- |
| `GET /earn/vaults`（免登入，快取 30 秒） | — | `{chainId, block, updatedAt, vaults:[{id, protocol, name, description, apyBps, baseApyBps, incentiveAprBps, breakdown, aprBps, utilizationBps, liquidityRaw, depositOpen, status, reason, message, bestRate, simulated}]}` |
| `GET /me/earn` | — | `{wallet:{availableRaw}, cashEarn:{earningRaw, earnedTodayRaw, earnedTotalRaw, positions:[{vaultId, name, valueRaw, maxWithdrawRaw, apyBps, earnedTodayRaw, earnedTotalRaw, status, message}]}, updatedAt}` |
| `POST /me/earn/deposit` | `{vaultId, amountRaw}` | `status:"ready"`＋`calls`；`"unavailable"`＋`reason/message`（200，不是錯誤碼）；`"limited"`＋`maxDepositRaw`（額度不足） |
| `POST /me/earn/withdraw` | `{vaultId, amountRaw \| "max"}` | `ready`＋`calls`（`all:true` 表示全部含利息）；流動性不足回 `limited`＋`maxWithdrawRaw`＋`message:"You can withdraw up to X USDT right now."`，`max` 時另附 `partial:{amountRaw, calls}` 可直接領目前最多的部分 |
| `POST /me/earn/confirm` | `{txHash}` | `confirmed`＋`recorded:[{vaultId, kind, amountRaw}]`；未上鏈或不在 canonical 鏈回 `pending`；失敗交易 409、非本人送出 403 |

金額一律 USDT raw（18 位小數）字串。`earnedTodayRaw` 是估計值（現值在今天 UTC 00:00 以來按基礎利率累積的部分），前端以 `~` 顯示；激勵另計，不含在現值裡。錯誤：`INVALID_VAULT`、`INVALID_AMOUNT`、`AMOUNT_TOO_SMALL`（最少 1 USDT）、`INSUFFICIENT_BALANCE`、`AMOUNT_EXCEEDS_BALANCE`、`NOTHING_TO_WITHDRAW`（400）。讀鏈失敗不回錯誤碼：`/earn/vaults` 每個 vault 回 `status:"unavailable"`、`reason:"data_unavailable"`（`block`／`updatedAt` 為 null）；`/me/earn` 整體讀不到回 `status:"unavailable"`＋`reason`，單一 vault 讀不到時該列 `status:"unavailable"`、`cashEarn` 的三個加總回 `null`（不回偏小的數字）；存入／領出回 `status:"unavailable"`；`confirm` 回 `pending` 讓前端稍後重試。正常時 `/me/earn` 帶 `status:"ok"`。

## 驗證紀錄

本機 anvil fork（chain 97、127.0.0.1:8596，impersonate 持有模擬 USDT 的地址，不送公開鏈交易）：三個 vault 各存 100 USDT、時間快轉 30 天後全部領出，Venus 收益 0.4110（5% APR）、Lista／Aave 0.2466（3% APR），錢包增加量與帳本計算一致；各領 40 USDT 的部分領出也成功（Venus 需送建議 gas）。
