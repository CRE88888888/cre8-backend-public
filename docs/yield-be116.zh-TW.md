# 定投預留本金生息（backend #116）

## 下一期流動保留

`yield-prefund.ts` 從已確認投入的 `strategy_lot_assets` 與永久期次紀錄計算每個進行中定投來源的下一期預算，再加總為帳戶保留額。逐資產預算原本已含手續費，不另外重複加費；沿用原始本金除有效期數、最後一期尾差與尚未預留的遞延零頭。已過期但未記錄的窗口不補扣，已預留期次的 input／fee 仍單獨保留。

可存入的 prefund 為 `max(stack_prefund_raw − 下一期保留額, 0)`。資料缺漏、無效期數／日曆、reorg 或無法確認費用的 legacy instruction，均保留全部 prefund。供給 journal 在鎖住現金列的同一交易內重算保留額，避免規劃後的新投入或跨期變化吃掉下一期現金。

## 期前領回與失敗

既有生息 scheduler 在 DEX／新期次認領前執行。原操作對帳、owner／風險退出仍優先；一般輪次若 prefund 低於下一期需求，僅從仍有 prefund 成本基礎的現金市場，依名目缺口換算領回 receipt。領回沿用既有 session、quote、paymaster、不可變快照與 canonical receipt 對帳，不受供給的 24 小時冷卻限制。

補 prefund 缺口的領回採定向歸屬：實收先返還該市場尚未償還的 prefund 本金，上限為原缺口與未償本金，剩餘才用 FIFO／Aave scaled 規則。目的、需求與現金快照以 `fact-prefund-withdraw-<execution key>` 在 action／operation／gas／原始快照的同一交易保存；來源重建與入帳共用同一份 canonical 歷史及目的。無目的的既有領回維持原規則。

定向本金與尚存 receipt 之間只交換來源成本，不改總成本或鏈上收據。receipt 已增值時，優先退還的原本金會消耗尚存來源成本，對應利息留待後續領回實現；已實現利息仍只進 `yield_raw`。實損照原收據消耗成本，不用 allocated／hold／利息補回損失。Aave 的原始 scaled 快照缺漏、衝突或 reorg 一律保留在途，不重送、不重複入帳。

仍有本金待領回時，新期次回傳 `[YIELD_PREFUND_PENDING]`，不先寫成備款不足略過。現金提領先在同一交易、現金鎖內完成 canonical 對帳，再判斷缺口；未開始舊工作到期取消時，先按既有規則返還原來源，再檢查下一期尾差。市場暫停、流動性不足、來源／快照不全、RPC／DB 失敗都不開新買單；若最後已無可領回的 prefund 成本，沿用既有備款不足／過期處理。

等待、請求領回與失敗記錄為 `yield_runtime_state` 的不可變 `fact-prefund-97-<portfolio>-<內容雜湊>`。包含帳戶、lot／asset／slot、marketId、需求、現金與固定原因碼；同一期同市場同原因只留首次事實，不同窗口或市場分別保存。`runYieldRound` 對 pending 結果輸出固定 `YIELD_PREFUND_PENDING` 碼與帳戶識別，不輸出 RPC 原文。沒有 schema 變更，依賴 db main `d5c6d21`（0042）。

## 驗收

所有環境值僅由程序環境提供。一般測試使用專用 `cre8_be116` 與 db repo 的 migration；fork 僅使用本機 anvil 8599、alto 3099、防呆 PORT 8699，與公開 anvil 測試助記詞。

混合來源案例保留 400 USDT 的原始 faucet funding receipt；另由 keeper 真實 Transfer 1,000 mock USDT 作 allocated 現金，避免同一 Kernel 累計申領超過 24 小時額度。keeper 須在 1,000 USDT 池子 poke 之外另留這筆庫存；本機 impersonated 角色也需有測試 gas。

- `bun install --frozen-lockfile`
- `bun run typecheck`
- CI `.github/workflows/ci.yml` 的 no-DB 48 檔清單
- `bun --no-env-file test --timeout=120000`
- `bun --no-env-file test ./test/yield-106.fork.ts --timeout=1200000`

新增回歸涵蓋保留額加總／0／相等／上限、尾差／遞延／日週期、未知資料、原子預留重驗、領回失敗／暫停與永久紀錄、實損／利息／重播、Aave rebase 與缺漏 scaled 證據。fork 保留三協議與 60／61 次代付驗收，另驗證 Venus 混合 allocated 1,000 ＋ prefund 400 USDT → 留 100、存 1,300 → 第一期預留後一次精確補回下期 100 缺口、剩餘 prefund 本金 200。DB 回歸另含 Venus／Aave allocated 1,000,000 ＋ prefund 300、重啟／replay／reorg、現金提領後延後期次與 DB 回滾。實際執行數字與環境限制列在 PR。
