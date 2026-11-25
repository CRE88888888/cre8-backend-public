# Chain 97 行情 keeper（backend#70）

獨立執行 `bun run price-keeper`，不啟動 API、scheduler 或 DB。預設停用；只有
`PRICE_KEEPER_ENABLED=1` 才讀取檔案、連線或簽名。只接受實際 RPC chain id 97，
啟動時核對 manifest、92 個池／oracle、minter 和 12 個 feed 的 keeper 權限。

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
| `PRICE_KEEPER_MAINTENANCE_SECONDS` | 休市／暫停／劇本結束時的維護成交間隔；預設 1,800，只接受 600–3,000 的整數（oracle `maxOracleAge` 為 3,600） |
| `PRICE_KEEPER_RPC_FAILURE_TIMEOUT_SECONDS` | 連續失敗多久後發一則 critical；預設 1,800 秒，只接受 1–86,400 的整數。**不會停止**，發完繼續重試 |
| `PRICE_KEEPER_PUBLIC_FALLBACK` | `1`（預設）：主要 RPC 故障時改走公開節點清單；`0` 關閉。只接受 `0` 或 `1` |
| `TELEGRAM_BOT_TOKEN`／`TELEGRAM_CHAT_ID` | 沿用 `src/notify.ts`；留空停用通知 |

這次驗收只允許 `http://127.0.0.1:8562` anvil fork。金鑰只能在本機驗收時由
`~/.cre8-testnet/keeper.json` 的 `data[0].private_key` 讀進子程序 env；不要放命令列參數、
檔案副本、log 或 repo。`--once` 做一輪後退出；常駐每 15 秒檢查區塊進度，依劇本步距執行。
停用 env 後重啟即可關閉；SIGINT／SIGTERM 會完成當前輪次後退出。

## 劇本與 swap

JSON `version=1`，必須完整列出 92 個 `assets`，值固定為 contracts
`b767bf6`（PR #43）的 `script/testnet/TestnetAssets.sol` 原始 `priceE18`；不套 UI multiplier。
未知欄位、不同基準價、缺漏資產、錯誤型別與超出上限的數值一律拒絕。

- `stepSeconds`：60–300 秒，保守留出 600 observation slots 的容量。
- `maxStepBps`：1–5 bps；60 秒一步時最多 150 bps／30 分鐘。
- `timeline`：依序的 `{steps, mode, stepBps}`；最多 100 段、共 10,080 步。
- `overrides`：單一資產的完整替代時間線；省略則使用共用 timeline。
- `mode`：`rise`／`fall` 每步複利；`sideways` 在段落起點與起點上方 `stepBps` 間交替；
  `closed`／`paused` 凍結劇本目標價，仍每 30 分鐘維持 observation 並更新 feed。後兩者的 `stepBps` 必須為 0。

第 0 步是基準價；第 1..N 步執行該段，最後一步仍屬該段。全部步驟結束後維持價格。
同一起點與鏈上時間得到相同目標價。延遲或重啟時只移動一個 `maxStepBps`，不跳追累積落差。
每池每輪最多一次 swap，且檢查鏈上最後 observation 時間，所以重啟不會提高頻率。
休市、暫停、劇本結束，或目標與現價僅有 sub-ppm 差距時，鏈上最後 observation 滿 `PRICE_KEEPER_MAINTENANCE_SECONDS`（預設 1,800 秒）才做維護成交：
以凍結目標上下 1 bps 為交替方向，仍受 `maxStepBps` 約束；方向由現價相對目標決定，
重啟沿用鏈上 observation 時間，不額外加速。劇本價格不改；真實池價會有小幅擺動。
這更新 #70 的「完全不成交」語義；使用者的交易時段規則不變。
此限制約束 keeper；測試環境仍應限制其他交易者的總交易頻率，以保留 TWAP 歷史。

QuoterV2 先確認預算足夠抵達目標 `sqrtPriceLimitX96`，再透過官方 V3 SwapRouter
執行普通 exact-input swap。router 只收取抵達目標所需的 input；不直接寫 pool storage。
交易後確認原交易 hash 的成功 receipt、canonical block、實際支出和目標 sqrt price；餘額低於門檻才 mint，並核對結果。
USDT 在連續買入間逐筆檢查；所有 mint／approve／swap／push 都記錄交易 hash 與確認區塊。

每輪先讀全體市場、雙向 `previewSwap` 與 feed 健康，再做寫入；交易後重讀 TWAP，
以已形成的 30 分鐘 TWAP 推 11 個 asset/USD feed，USDT/USD 固定 1，持續符合 200 bps secondary 門檻。
休市或暫停期間仍推 feed，避免過期。backend#187 起 feed 不再每一步都推（原本每小時約 720 筆，是 keeper gas 的大宗）：整組（USDT/USD＋11 個 asset feed）只在最舊的 feed 年齡達到 `min(maxFeedAge, 3600) / 2`（目前 1,800 秒），或某個 TWAP 與已發布值偏離 ≥ 100 bps（secondary 門檻 200 bps 的一半）且距上次推送已滿一步時才推送。所有寫入改用 legacy `gasPrice = eth_gasPrice`（chain 97 為 0.1 gwei），不用 viem 預估的 EIP-1559 小費；讀 gas price 失敗發生在簽名前，視為暫時性讀取故障。
第一次啟動前，部署池必須已有完整 30 分鐘歷史，且 feed 尚未 stale。

### 失敗時怎麼處理（2026-11-25 之後）

11/17、11/20、11/25 三次停擺都是一次暫時性錯誤就讓行程停掉（最後一次是 RPC 回 HTTP 403）；
11/25 還看到另一個使用者的成交讓 keeper 以 `pool changed since inspection` 停止。keeper 一停，feed 過期，全站交易被擋。
所以現在只有 `fatal` 會停；其餘一律重試（`network`／`retry` 的差別只是 log 上的類別）：

| 類別 | 內容 | 處理 |
| --- | --- | --- |
| `fatal` | 設定錯、劇本／manifest 不一致、鏈上角色不對（keeper／minter／feed keeper）、RPC 不是 chain 97、預撥 USDT 低於門檻、gas 餘額不足 | 發 critical、停止、行程以非零結束；修好後重啟 |
| `network` | RPC／網路層：任何 HTTP 狀態（403、429、5xx…）、回傳不是 JSON、timeout、連線錯誤、節點端的 JSON-RPC 錯誤（限流、額度、內部錯誤） | 退避重試，不停止 |
| `retry` | 其他全部：合約 revert、與其他交易者的競態（`pool changed since inspection`、`swap result mismatch`）、舊區塊／區塊不前進、觀測值不合理、未知錯誤 | 同上，退避重試，不停止 |

主迴圈裡會走到「已停止，請手動重啟」的只剩這幾條（`classifyKeeperError` 回 `fatal`）：RPC 回報的 chain id 不是 97（`chain 97 only`）、
預撥 USDT 低於門檻（`prefunded USDT inventory below minimum`／`USDT inventory must be prefunded`）、gas 餘額不足（`insufficient funds`）。
設定、劇本、manifest、鏈上角色的錯誤只會在啟動時出現，同樣是 `fatal`。

其餘執行中的原因全部重試，包含檢查完池子到送出成交之間被別人動過的良性競態（2026-11-25 16:43、18:55 UTC 各讓舊版停一次）：
`pool changed since inspection`、報價／估 gas 因價格變動而 revert、`swap budget cannot reach target`、成交上鏈但因滑價 revert（`transaction not confirmed`）、
`swap result mismatch`，以及 nonce 衝突／replacement 被拒（當成寫入結果不明處理）。這一檔這一輪跳過，其他市場與 feed 照常，下一輪重新檢查再做。

- 退避：5 秒 → 15 秒 → 60 秒 → 90 秒 → 之後每 120 秒。每次重試都從新的 head 與全體 inspection 開始，
  成交頻率仍由鏈上 observation 時間限制，不重播原本的指令。
- 啟動時的鏈上核對（verify）用同一套：RPC 拒絕或逾時就等，不讓行程結束（不會變成 CRASHED）。
- 連續失敗超過 `PRICE_KEEPER_RPC_FAILURE_TIMEOUT_SECONDS`（預設 30 分鐘）發**一則** critical（寫明階段、原因、類別、已失敗多久），
  之後照樣每 60–120 秒重試；恢復時 log `recovered after …`，發過 critical 的話再發一則「已恢復」。
- 單一市場失敗只跳過那個市場，其他市場照常成交與推 feed；同一輪有 3 個市場都是 `network` 失敗就結束這一輪（RPC 整個不通時不逐一等逾時）。
- 寫入：廣播或等 receipt 時出錯，交易可能已上鏈也可能沒有（`transaction outcome unknown`）。這一輪立刻結束、不再送任何交易；
  下一輪先確認 keeper 帳戶沒有交易還在 pool 裡（mined nonce＝pending nonce）才繼續，而且是重新讀鏈上狀態再決定，**不重送原交易**。
  已上鏈但失敗（receipt 為 revert）記為 `transaction not confirmed`，下一輪重來。
  mint／swap 確認後的核對讀取失敗只記名（`… verification unavailable`），下一輪重讀餘額與池價，不會重複補貨。
- 停擺超過 1 小時後（feed 過期、池子觀測過期）的自我恢復沿用 #139：RPC 回來後的第一輪對 TWAP 不可用的池子各做 1 bp 成交，
  下一輪推完整組 feed，不需要人重啟。
- 備用 RPC：主要 RPC 出現 `network` 類失敗時，該請求改送公開節點清單（`src/rpc-transport.ts` 的 `PUBLIC_RPCS_97`，api／scheduler 共用同一份；
  keeper 自己的 URL 若就在清單裡會被排除），之後 60 秒都走公開節點，再回頭試主要 RPC。公開節點依序嘗試，失敗的那個排到最後。
  revert 與被拒的請求不會換節點。已簽名交易改送另一個節點是同一筆交易（同 nonce、同 hash），不會執行兩次。
  主要 RPC 連續失敗超過上述門檻另發一則 critical（這時報價靠公開節點維持）。本機 fork（127.0.0.1）不啟用。
- log 每行都有階段、白名單原因（本機原因、HTTP status／RPC code）、`class=`、`failing=…s`、`attempt=`、`retryMs=`；
  上游原文、檔案內容／路徑、私鑰與 RPC URL 不進 log 或通知。
- `--once` 仍只嘗試一輪，失敗記 warning 後退出；常駐模式才持續重試。
- 這個獨立程序沒有 DB，不寫 `/health` 的 alert 列。`/api/health` 看得到的是 scheduler 的 `price_source_unavailable`
  （feed 過期或 TWAP 不可用連續數輪後亮）。

## 驗收

`bun test test/price-keeper.test.ts test/price-keeper.rpc.test.ts` 不需要 DB 或鏈。
完整 `bun test` 仍需 repo 的可拋棄 Postgres 設定。

整合驗收另用 `bun test ./test/price-keeper.fork.ts --timeout=1800000`，需上述本機 env。
先從 contracts **乾淨的 origin/main** 用 `git worktree add --detach /tmp/cre8-c97-be87 origin/main` 建立獨立乾淨副本（部署腳本會核對 HEAD 與 origin/main），執行
`FORK_RPC=http://127.0.0.1:8562 scripts/testnet/deploy-97.sh fork`，不能複製主 clone 的未提交程式。
測試會核對 anvil 和 chain id，快轉 2 小時，做 2,208 次雙向 preview、核對 Swap event 與 60 秒間隔，
再驗跌價、休市與單一資產暫停；結束回復自己的 snapshot。
本機驗收只用 anvil 補原生測試 gas；mock 庫存由合約 mint，所有池價都由正常 swap 改變。
整合測試檔名是 `.fork.ts`，只會在明確指定時執行，不會由預設 `bun test` 送交易。

#87 的短驗收：`bun test ./test/testnet-92.fork.ts --timeout=600000`，只接受 8562、固定 chain 97
及 anvil。先從乾淨 contracts main 用 `deploy-97.sh fork` 部署，anvil 必須加 `--prune-history 3072`。
它在 snapshot 內暖機，92 池各做一次漲價成交，再驗兩輪休市／暫停／劇本結束的 30 分鐘維護，
共 276 筆真實 swap、368 次雙向 preview；每池核對 Swap event 的 tick 改變和 observation 時間。
所有寫入只送本機，最後回復 snapshot；執行結果與完整 E2E 見 `docs/testnet-deploy.zh-TW.md`。
