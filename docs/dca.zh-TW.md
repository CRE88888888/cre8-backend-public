# 定投（DCA）

依使用者 2026-11-23 定案：買入畫面切換「一次買入／定投」；定投輸入**總額**、**期數**、頻率（daily／weekly／biweekly／monthly），每期＝總額 ÷ 期數。只在 chain 97。依賴 db 0064（`dca_plans`、`dca_actions`）。合約不用改。

## 可行性（查證結果）

- **存入**：已部署的 `AtpExecutor.executeSupply` 要求生息資產（USDT）是該策略版本的鏈上資產、owner 先 `setYieldPolicy`，且有每資產 24 小時冷卻與 50 USDT 下限。首發 21 檔的鏈上資產沒有 USDT，所以**走不通**。改由組合帳戶自己（owner 簽一個 UserOp）直接存進白名單 vault，跟 Cash Earn 同一組 vault 與 calldata，只是存款人是組合帳戶。
- **每期領出**：`AtpExecutor.executeWithdraw` 是「純領出」，不看 enrollment、同意、冷卻、預算；帳戶自己存的（registry 沒追蹤的）份額也能領，前提是帳戶把 vault 份額 `approve` 給 executor。scheduler 的 session key 在 chain 97 owner renewal 後已經有 `executeWithdraw` 權限（第 0 個參數鎖帳戶本身），**不用新的 session 權限、不用改合約**。
- **paymaster**：原本只代付「registry 有追蹤份額」的領出（`accountUnits>0`），這次放寬為：帳戶有進行中的定投且是該定投的 vault 市場也可以。另外允許 owner UserOp：USDT `approve` 給定投 vault、存入時收款人必須是帳戶本身、領回時收款人必須是 owner 錢包。
- **只花一期的錢**：既有買入只花「已確認的 funding lot」（`strategy_cash_balances` 的分類），不是整個餘額；未分類的 USDT 不會被買。所以每期領出的金額＝一個新 funding lot（來源是那筆 `executeWithdraw` 的 USDT Transfer），其餘留在 vault。My mix 同一套 funding lot，也支援。
- **每期最低 10 USDT**（使用者 2026-11-23 決定）：一次買入的 50 USDT 認購下限不適用於定投的每一期；定投 lot 的門檻是「一整批含費 10 USDT」（`minimumDcaTranche`＝ceil(10 ÷ 非現金權重)，首發基金與 My mix 都是 10）。逐資產新錢的執行門檻本來就是每批含費 10、單期 hold 豁免每資產 1 USDT（`assetTradeMinimumReason` 用 `MIN_ASSET_BATCH_RAW`），測試確認 10 U、含三個 5% 衛星的 9 資產組合可以成一批（0.3 費用預留、最小一項 0.485 U）。一次買入仍是 50。
- **估值與既有生息**：帳戶自己存的份額在 registry 看來是「未追蹤」，原本的生息讀取會把它判成 unknown、讓整檔估值未知（全部交易停住）。改成讀取時排除定投的 vault 市場（`readYieldAccount({ignore})`，snapshot 與逐資產生息都用）。定投餘額不算投資組合價值、也不會被再平衡拿去買（三種錢不混）。
- **Venus、Lista、Aave 都用，自動選合計 APY 最高的**。「領回剩餘」：Lista `redeem(shares, owner, account)`、Aave `withdraw(USDT, max, owner)` 直接精準付到 owner 錢包；Venus 模擬市場只付給呼叫者，所以是 `redeem(全部份額)` 回帳戶＋同一個 UserOp 裡 `USDT.transfer(owner, 報價當下的價值)`。報價到上鏈之間多出的利息（零頭，實測 1,000 U 約 0.00004 U）在 confirm 時從同一筆交易的 log 算出精確數字，記成這個組合的已配置現金（`allocated_cash_raw`），帳戶裡不留未分類 USDT（My mix 的現金核對要剛好相等）。每期領出走 executor，Venus 也是精準金額。Venus 的存入／領回 call 帶建議 gas 400k（模擬市場先計息，同 Cash Earn）。

## 流程

1. 前端先把總額從錢包轉進該組合帳戶（跟一般買入的轉帳一樣），**不要**呼叫 `POST /portfolios/:id/funding-lots`。
2. `POST /portfolios/:id/dca` → 回 `calls`（帳戶 owner 簽一個 UserOp）：USDT approve（不足才有）＋存入 vault＋vault 份額 approve 給 executor（只第一次）。`authorization:"renewal_required"` 時同時簽 renewal（同策略加息）。
3. 上鏈後 `POST /portfolios/:id/dca/confirm {txHash}`：核對同一筆交易裡「帳戶 → vault」的 USDT 剛好等於總額，定投開始。
4. scheduler 每輪（`runDcaRound`，在買入之前）：到期的期數（第一期＝使用者選的開始日 `startAt`；選今天就是下一輪，美股成分等開盤）用 session key 領出 `每期 × 到期期數`；最後一期領出全部（含利息）。美股成分在休市時**不領**，開盤後一次補齊到期的期數。領出確認後記成一筆 funding lot，並把組合 `next_run_at` 拉到現在，由原本的買入流程照權重買。
5. 暫停／恢復隨時可以；暫停時錢留在 vault。組合本身暫停（execution-state enabled=false）時也不領。「全部賣出」留下的暫停不算：帳戶裡只剩 USDT 的暫停組合，在第 3 步存入確認時自動恢復（`src/sell-all-resume.ts`），之後照期數買；帳戶還有資產的暫停組合維持暫停。
6. 領回剩餘：`POST /portfolios/:id/dca/withdraw` → 定投轉暫停並回 `calls`（owner 簽），把 vault 裡全部直接領回錢包；上鏈後 `POST /dca/confirm {txHash}`，帳戶份額歸零就結束（`closed`）。

一個帳戶同時只有一個進行中的定投。My mix 換組合會換 portfolio id，但帳戶不變；定投綁帳戶，scheduler 每次用帳戶目前的 portfolio 記 funding lot。

## API（金額一律 USDT raw，18 位小數字串）

| 方法與路徑 | body | 回應重點 |
| --- | --- | --- |
| `GET /portfolios/:id/dca` | — | `{portfolioId, account, status:"none"\|"awaiting_deposit"\|"active"\|"paused"\|"completed"\|"closed", minimumPerPeriodRaw, frequencies, minPeriods:2, maxPeriods:365, offer:{vaultId,name,apyBps}\|null, plan, updatedAt}`；`plan`＝`{id, state, vaultId, vaultName, apyBps, frequency, periods, periodsDone, totalRaw, trancheRaw, startAt, nextRunAt, waitingForMarket, waitingReason, buying, depositedRaw, investedRaw, returnedRaw, remainingRaw, maxWithdrawRaw, earnedRaw, authorization:"ready"\|"renewal_required", createdAt, closedAt, closeReason}` |
| `GET /me/dca` | — | 登入錢包在這條鏈上所有投組的定投，一次回完：`{owner, portfolios:{"<portfolioId>": <與 GET /portfolios/:id/dca 完全相同的物件>}, updatedAt}`。沒有投組回空的 `portfolios`。App 載入時用這支，不要每個投組各打一次 |
| `POST /portfolios/:id/dca` | `{totalRaw, periods, frequency, startAt?, vaultId?}`；`startAt`＝第一期日期（ISO），可選今天（不早於現在 24 小時，容許各時區的「今天」；早於現在視為現在）到一年內，省略＝現在；之後各期沿用它的時刻 | `{status:"ready", planId, authorization, vaultId, vaultName, apyBps, totalRaw, periods, frequency, trancheRaw, startAt, calls}`；vault 不收新錢回 `{status:"unavailable", reason, message}`（200） |
| `POST /portfolios/:id/dca/confirm` | `{txHash}` | 存入：`{status:"confirmed", state:"active"}`；領回：`{status:"confirmed", state:"closed", returnedRaw}`；還沒上鏈／非 canonical／份額還在：`{status:"pending", state}` |
| `POST /portfolios/:id/dca/pause`、`/resume` | `{}` | `{status:"ok", state}` |
| `POST /portfolios/:id/dca/withdraw` | `{}` | `{status:"ready", amountRaw, calls}`；流動性不足 `{status:"limited", maxWithdrawRaw, message}`；vault 已空或還沒存入 `{status:"closed", calls:[]}` |

限流：`GET /me/dca`、`GET /portfolios/:id/dca` 屬於顯示用讀取，算在 `read` 額度（每個錢包每分鐘 120 次，`RATE_LIMIT_READ_PER_MINUTE`）；`POST` 的開始／確認／暫停／領回算在 `plan` 額度（每分鐘 30 次，與其他寫入、代付共用）。

`calls` 的格式同 Cash Earn：`{to, data, value:"0", gas}`，由組合帳戶（Kernel）送出，不是錢包。`vaultId` 省略時用目前合計 APY 最高、可存入的那個（Venus／Lista／Aave）。`earnedRaw`＝剩餘＋已投入＋已領回−存入，負數（帳本不完整）回 `null`。`waitingForMarket:true`＝這期到了、在等美股開盤。`waitingReason`＝這期到了但沒在買的原因，順序同排程器：`"portfolio_paused"`（組合暫停，或「全部賣出」還沒賣完）→ `"market_closed"`（等美股開盤）→ `"authorization_required"`（要 owner 更新授權）；以上三種看現在的狀態。其餘是排程器上一輪實際試了、沒過的原因（十分鐘內、同一期才算數，每一輪都會再試）：`"account_busy"`（帳戶有別的操作還沒對完帳，或正被別的流程鎖住）、`"vault_liquidity"`（vault 現在領不出這一期）、`"approval_required"`（帳戶還沒授權 executor 領 vault 的份額）、`"sponsorship_unavailable"`（代付被拒）、`"temporarily_unavailable"`（讀取或依賴失敗）；`null`＝沒有在等（還沒到期、正在買，或下一輪排程器就會買）。App 不認得的值當成一般等待。完整原因在排程器 log（`[dca] plan N: …`）。這個紀錄存在 `yield_runtime_state` 的 `cursor-dca-plan-<id>`（API 與排程器是兩個進程），沒有新 schema。

錯誤：`INVALID_AMOUNT`、`INVALID_PERIODS`（2–365）、`INVALID_FREQUENCY`、`INVALID_START`（早於今天或超過一年）、`INVALID_VAULT`、`DCA_PERIOD_TOO_SMALL`（每期低於 `minimumPerPeriodRaw`，首發基金與 My mix 是 10 USDT）、`INVALID_DCA_REQUEST`（400）；`DCA_FUNDS_NOT_IN_ACCOUNT`（帳戶裡沒被其他用途占用的 USDT 不夠總額）、`DCA_ALREADY_ACTIVE`、`DCA_BUSY`（這期正在領出）、`DCA_DEPOSIT_MISMATCH`、`NO_DCA_DEPOSIT`、`NO_DCA_RETURN`、`TX_FAILED`（409）；`DCA_NOT_FOUND`（404）。

## 帳本與安全

- `dca_plans` 記總額、期數、頻率、每期、已完成期數、已投入、已領回；`dca_actions` 是每一筆 session key 領出的日誌：簽名前先寫 `prepared`（含完整 calldata、nonce、UserOp hash、報價），送出、確認、失敗、未知都留紀錄，一個定投同時只有一筆在途；重啟用保存的原始資料對帳（`reconcileYieldOperation`），不重新規劃舊單。結果未知時不重送；過了 deadline 十分鐘、份額沒變才判定沒執行。
- 確認的領出才記 funding lot（`dca_actions.lot_id`，唯一），記 lot 失敗（例如基金版本要升級、My mix 換組合中）下輪重試，不會重複記。
- 定投的錢只在「帳戶 ↔ 該 vault」之間移動；session key 只能把 vault 份額贖回帳戶自己，不能轉走。領回錢包一定是 owner 簽的。

## 待決

- 主網：paymaster 放寬與 vault 白名單只在 chain 97；主網前要重新審 vault、執行器與 session 權限。
- 期數上限 365（使用者看得到，尚未確認）。
