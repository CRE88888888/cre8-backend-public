# 加息策略動態路由 v2：後端這一側

合約規格：cre8-contracts `docs/borrow-routing-v2.zh-TW.md`（這裡對的是 **v2.0-draft3**）。選路線的規則：`docs/strategy-earn-mainnet-routing.zh-TW.md`。激勵代幣：`docs/strategy-earn-rewards.zh-TW.md`。
實作：`src/strategy-earn-v2.ts`。測試：`test/strategy-earn-routing-v2.test.ts`、`test/sponsor-flows.test.ts`、`test/strategy-route-events.db.test.ts`。

## 開關

`strategyEarnV2(chainId)` 讀 `STRATEGY_EARN_V2_DEPLOYMENT`（JSON：`chainId`、`executor`、`registry`、`venusComptroller`、`moolah`、`loanTokens`、`rewardTokens`）。
沒設（現在所有環境都沒設）就回 null：renewal 不多裝權限、paymaster 不贊助任何 v2 呼叫、排程器不重建 v2 權限。chain 97 的 v1 流程完全照舊。
格式錯就 throw，不會用半套設定去組交易。

## 已經做好、有測試的

| 項目 | 位置 |
| --- | --- |
| route id／vault id（規格 §3） | `routeIdOf`、`vaultIdOf`、`routeIds` |
| owner 簽一次的同意：帳戶層級上限（美元，所有借款幣合計）＋需要的借貸授權＋抵押品 approve | `v2ConsentCalls`、`maxDebtFor`（計畫總債務 +10%） |
| 開倉、補借、還款、平倉、搬家、只換 vault、放回剩餘、送出激勵、減倉 | `v2Calls` |
| 引擎的決定 → 交易 | `planExecution` |
| 關閉加息／全部賣出／刪除（owner 一筆 UserOp） | `v2ExitCalls` |
| 賣出前還款取回（session key） | `v2PreSellCalls` |
| 一個帳戶一輪：決定＋執行＋每個決定一行 log | `runV2Account` |
| paymaster 規則（基金帳戶與 My mix 帳戶同一支函式） | `v2SponsoredCall`，接在 `validateSponsoredCalls`、`mixStrategyCall` |
| session key 權限範圍 | `v2SessionPermissions`、`v2Authorized`，接在 `sessionCallPermissions`／renewal／排程器重建 |
| 利率回報（rateReporter＝operator） | `v2RateReport` |
| 帳本與活動紀錄的一句話 | `v2RouteEvents`、`routeLedger`（db 0069）、`routeMessage` |

### `planExecution` 的規則

- 順序：平倉、還款先（釋放上限、不增加風險），再搬家，最後開倉。
- 借款金額＝目標 × 98%（留 2% 給送出前累積的利息）。引擎只在債務低於目標 5% 以上才補借，所以不會每輪為了這 2% 送交易。
- owner 的上限不夠：把新借款縮到上限以內，不送一筆會 `DebtAboveConsent` 的交易；`consentShort` 為 true，App 下次請 owner 重新同意。
- 搬家：先送一筆 `executeMigrate`（整筆成功或整筆還原）。還原時（舊 vault 不夠還、新路線沒過條件）走兩步：`executeReduce` 全關（可用帳戶自己的同幣現金）→ `executeOpen`。關了之後開不成，就停在「沒借款」，下一輪再看。
- 同一個借款市場、只換 vault：`executeSwitchVault`。
- 減倉線：`executeDeleverage` 任何人可呼叫，由 operator 送（不經帳戶、不用贊助）。
- Lista：部分還款後剩下的債不能低於 15 美元，會低於就改成全還。

### paymaster 規則

- v2 executor：只有六個帳戶函式（`executeOpen`／`Reduce`／`Migrate`／`SwitchVault`／`Release`／`SweepRewards`），第一個參數必須是送出的帳戶，要有 deadline，編碼必須標準；空的開倉／還款、搬到同一條路線、換到同一個 vault、送出非激勵代幣都拒絕。`executeDeleverage` 不贊助。route id／vault id 不限制，白名單在合約。
- v2 registry：只有 `setStrategyPolicy`；開啟時上限不能是 0；激勵收款人只能是 owner、帳戶自己或 0。
- Venus／Moolah：只有授權給（或取消）v2 executor。
- `approve(v2 executor)`：只允許投資組合資產、白名單借款幣、激勵代幣。
- My mix：正在退出／已退出／刪除中只能做「還款類」；有待簽的組合變更時等待（409 `MIX_BUSY`）；改比例會重新 enroll 到新策略，同一筆 owner UserOp 裡重新同意。

### session key 權限

v2 executor 上那六個函式，第一個參數釘死是這個帳戶。沒有市場清單（白名單在合約，新增市場不用續期）。不含 `setStrategyPolicy`、借貸授權、任何 approve。
加在既有權限的最後面，所以 v2 之前安裝的 key 重建出來的 permissionId 不變。

## 等合約部署後才能接的

這些需要真的合約（至少 fork）才驗得了，沒有盲寫：

1. **讀鏈**：`V2AccountState`（`routeStatus`／`vaultStatus`／`policy`／`accountRoutes`／`boxOf`）的讀取器。批次讀、只走公開節點、每輪快取。
2. **排程器接線**：成交後自動開（`open` hook）、賣出前還款（`unwind` hook）、每輪重新評估（keeper round）改呼叫 `runV2Account`／`v2PreSellCalls`；`record` 寫 db 0069。
3. **My mix 改比例的重新同意**：`mixes.ts` 目前組的是 v1 的 `mixStrategyConsentCalls`，要加 v2 版本（paymaster 這邊已經會放行）。
4. **App 送的 owner UserOp**：開啟／關閉加息改用 `v2ConsentCalls`／`v2ExitCalls`（由 API 回傳 calls，跟 v1 一樣）。
5. **策略盒的激勵簽名**：`boxRewardSignature` 的編碼是草稿，等合約端把盒子的 ERC-1271 格式寫進規格再對。
6. **利率回報的排程**：`v2RateReport` 48 小時過期，operator 每天送一次。

介面如果改版：`test/fixtures/borrow-routing-v2.signatures.json` 是從規格的 interface.json 抽出來的函式與事件簽名，測試會逐一比對這裡用到的每個簽名，改了會直接紅。

## API（App 用）

- `GET /portfolios/:id/strategy-earn`：每個部位多一個 `route`：
  `{ source, venue, loan, marketId, borrowBps, borrowIncentiveBps, vault: { venue, name, token, address, apyBps }, ratioBps, since }`。
  健康度仍是原本的 `ltvBps`／`targetLtvBps`／`deleverageLtvBps`／`liquidationLtvBps`。
  - `source: 'simulated'`：chain 97 的 v1 部位。鏈上是固定的模擬市場，這裡給的是 App 本來就顯示的那條主網路線（同一份 10 分鐘快取，這支請求不等主網 API、不讀鏈；快取還沒有時 `route` 是 null）。
  - `source: 'onchain'`：路由 v2 的部位實際所在的路線（v2 部署後才會出現）。App 的示意圖只在這種情況改用部位自己的路線，其餘跟買入前一樣。
- `GET /portfolios/:id/strategy-earn/activity`：有 v2 部署設定時，多回 db 0069 的事件（`migrate`、`switch_vault`、`reduce`…），附 `message`（英文）與 `messageZh`（簡體）。沒有設定時不讀那張表。
- `GET /portfolios/:id/strategy-earn/rewards`：待領與已在帳戶裡的 LISTA／XVS（見 `docs/strategy-earn-rewards.zh-TW.md`）。

## draft3 對齊（2026-11-24）

已改：
- `Opened` 事件最後一欄改成 `debtValue, budgetValue`；新增 `collectRewards(account, token)`（任何人可呼叫，策略盒 → 帳戶，`v2Calls.collectRewards`，由 operator 送）、`lens()`、`RewardsCollected` 事件。
- 策略盒簽名 `boxRewardSignature`＝`abi.encode(bytes message, bytes accountSignature)`（規格 §9）。
- 碰到 Lista vault 的交易一筆要 6–10M gas（會走完整個提領佇列），估算乘 2 後兩筆放不進 14M：`v2ExitBatches`／`v2PreSellBatches` 一個 executor 呼叫一筆 UserOp；`planExecution` 的每個 step 本來就各自一筆。
- Lista 最低借款約 15 美元：開倉後總債務低於它就不送（`below the Lista minimum loan`）。
- 簽名比對用的 fixture 重新從 interface.json 產生（含 `AtpBorrowLensV2`）。

還沒做（都要等部署或另外的資料來源）：
- 讀取改走 `AtpBorrowLensV2`（`routeStatus`／`vaultStatus`／`quote`／`health`／`debt`／`routeDebt`／`tokenDebt`／`minLoan`）；持有時間改讀 `registry.openedAt`、`vaultSince`。
- 非 USDT 的零頭與差額：合約不換幣，還款不足要用同一種幣補。後端需要 USDC／USD1／U ↔ USDT 的換幣路徑（走既有交易路徑），兩步搬家的中間那一步也用得到。
- 路線挑選要排除不能存入的 vault（Lista Gauntlet USDT vault 的 supply queue 是空的）與已達供給上限的 Venus 市場（主網 vNVDAB 已滿）。現在的 `mainnetRates` 還沒有這兩個條件。
- Lista vault 那一側的 LISTA 激勵：策略盒簽名流程在主網驗過之前，不應該算進顯示的收益。目前顯示仍有算（見下）。
- `reportRates` 每 12 小時一次（48 小時過期；40 條路線＋10 個 vault 約 322k gas）。

### 顯示數字若排除 Lista vault 激勵（2026-11-24 13:45 UTC 的實際利率，僅試算、顯示沒改）

USDC 最佳 vault 會從 Lista USDC Vault（1.41% 基礎 + 3.66% 激勵 = 5.07%）變成 Aave（3.39%）。借款那一側的 LISTA 激勵兩邊都照算。

| 基金 | 現在顯示的加息 | 排除後 |
| --- | --- | --- |
| Mag7 | 0.99% | 0.68% |
| Pelosi | 0.74% | 0.53% |
| US Market | 1.41% | 1.15% |
