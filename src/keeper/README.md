# Chain 97 行情 keeper（backend#70）

獨立執行 `bun run price-keeper`，不啟動 API、scheduler 或 DB。預設停用；只有
`PRICE_KEEPER_ENABLED=1` 才讀取檔案、連線或簽名。只接受實際 RPC chain id 97，
啟動時核對 manifest、38 個池／oracle、minter 和 12 個 feed 的 keeper 權限。

## 設定

| env | 說明／預設 |
| --- | --- |
| `PRICE_KEEPER_ENABLED` | `0`；只接受 `0` 或 `1` |
| `PRICE_KEEPER_RPC_URL` | 必填，獨立於 API 的 RPC 設定 |
| `PRICE_KEEPER_MANIFEST` | `scripts/testnet/deploy-97.sh` 產生的 manifest 檔路徑 |
| `PRICE_KEEPER_SCENARIO` | JSON 劇本路徑；範例在 `scripts/price-scenarios/` |
| `PRICE_KEEPER_START_TIMESTAMP` | 必填、正整數的鏈上 Unix 秒；重啟沿用同一個起點 |
| `PRICE_KEEPER_PRIVATE_KEY` | 只從 env 讀 keeper 的測試網金鑰，不讀 API operator key |
| `PRICE_KEEPER_MIN_INVENTORY_E18` | 每個代幣的 USDT 計價補貨門檻；預設 10,000 × 10^18 |
| `PRICE_KEEPER_INVENTORY_E18` | 補貨後庫存價值；預設 100,000 × 10^18，必須大於門檻 |
| `PRICE_KEEPER_SWAP_BUDGET_E18` | 單筆 input 價值上限；預設 10,000 × 10^18，不能大於門檻 |
| `TELEGRAM_BOT_TOKEN`／`TELEGRAM_CHAT_ID` | 沿用 `src/notify.ts`；留空停用通知 |

這次驗收只允許 `http://127.0.0.1:8557` anvil fork。金鑰只能在本機驗收時由
`~/.cre8-testnet/keeper.json` 的 `data[0].private_key` 讀進子程序 env；不要放命令列參數、
檔案副本、log 或 repo。`--once` 做一輪後退出；常駐每 15 秒檢查區塊進度，依劇本步距執行。
停用 env 後重啟即可關閉；SIGINT／SIGTERM 會完成當前輪次後退出。

## 劇本與 swap

JSON `version=1`，必須完整列出 38 個 `assets`，值固定為 contracts
`f1608ee`（PR #32，與 `f7e5d52` 基準一致）的 `script/testnet/TestnetAssets.sol` 原始 `priceE18`；不套 UI multiplier。
未知欄位、不同基準價、缺漏資產、錯誤型別與超出上限的數值一律拒絕。

- `stepSeconds`：60–300 秒，保守留出 600 observation slots 的容量。
- `maxStepBps`：1–5 bps；60 秒一步時最多 150 bps／30 分鐘。
- `timeline`：依序的 `{steps, mode, stepBps}`；最多 100 段、共 10,080 步。
- `overrides`：單一資產的完整替代時間線；省略則使用共用 timeline。
- `mode`：`rise`／`fall` 每步複利；`sideways` 在段落起點與起點上方 `stepBps` 間交替；
  `closed`／`paused` 不交易但持續更新 feed。後兩者的 `stepBps` 必須為 0。

第 0 步是基準價；第 1..N 步執行該段，最後一步仍屬該段。全部步驟結束後維持價格。
同一起點與鏈上時間得到相同目標價。延遲或重啟時只移動一個 `maxStepBps`，不跳追累積落差。
每池每輪最多一次 swap，且檢查鏈上最後 observation 時間，所以重啟不會提高頻率。
此限制約束 keeper；測試環境仍應限制其他交易者的總交易頻率，以保留 TWAP 歷史。

QuoterV2 先確認預算足夠抵達目標 `sqrtPriceLimitX96`，再透過官方 V3 SwapRouter
執行普通 exact-input swap。router 只收取抵達目標所需的 input；不直接寫 pool storage。
交易後確認原交易 hash 的成功 receipt、canonical block、實際支出和目標 sqrt price；餘額低於門檻才 mint，並核對結果。
USDT 在連續買入間逐筆檢查；所有 mint／approve／swap／push 都記錄交易 hash 與確認區塊。

每輪先讀全體市場、雙向 `previewSwap` 與 feed 健康，再做寫入；交易後重讀 TWAP，
以已形成的 30 分鐘 TWAP 推 11 個 asset/USD feed，USDT/USD 固定 1，持續符合 200 bps secondary 門檻。
休市或暫停期間仍推 feed，避免過期。feed 剛更新、未滿一步時不重複推送。
第一次啟動前，部署池必須已有完整 30 分鐘歷史，且 feed 尚未 stale。

RPC 讀寫或確認逾時、區塊倒退／超過 90 秒未前進／時鐘異常、feed 或 oracle 異常、
庫存／成交驗證失敗都會永久停止當前實例，透過既有 Telegram sender 發一則 critical。
不自動重送未知交易、不自動修復 stale feed；營運者檢查 receipt／nonce、來源與權限後手動重啟。
錯誤原文不進 log 或通知。這個獨立程序不新增 DB alert kind，也不提供 `/health` 的 DB alert 列。

## 驗收

`bun test test/price-keeper.test.ts test/price-keeper.rpc.test.ts` 不需要 DB 或鏈。
完整 `bun test` 仍需 repo 的可拋棄 Postgres 設定。

整合驗收另用 `bun test ./test/price-keeper.fork.ts --timeout=1800000`，需上述本機 env。
先從 contracts **乾淨的 origin/main** 用 `git archive` 建立獨立、乾淨的 git 副本（部署腳本會核對 HEAD 與 origin/main），執行
`FORK_RPC=http://127.0.0.1:8557 scripts/testnet/deploy-97.sh fork`，不能複製主 clone 的未提交程式。
測試會核對 anvil 和 chain id，快轉 2 小時，做 912 次雙向 preview、核對 Swap event 與 60 秒間隔，
再驗跌價、休市與單一資產暫停；結束回復自己的 snapshot。
本機驗收只用 anvil 補原生測試 gas；mock 庫存由合約 mint，所有池價都由正常 swap 改變。
整合測試檔名是 `.fork.ts`，只會在明確指定時執行，不會由預設 `bun test` 送交易。
