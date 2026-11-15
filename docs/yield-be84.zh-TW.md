# BE-3 生息讀值、風控與 API（backend#84）

依賴 db 0036／0040 與 BE-4（backend#85，PR #102 已合併）；0040 已由 db PR #46 合併。整合順序為 contracts#49 最新修正 → db#45／0040 → BE-4 的最新 manifest／ABI／profile → 本 PR。本分支已接上含 #102 的 main，CI 清單、scheduler imports 保留雙方內容。本 PR 不複製或修改 profile、部署地址、ABI 檔、session selector 或 UserOp 送出實作。

C1 的 `eafc1a6` 已移除 `reserveSupply`／`totalReserved` 等跨交易鏈上預留；最新版本 R 只有 DB unresolved supply。#102 已合併的 profile 目前仍是 `2052c82`，因此讀值端先核對 registry runtime 與 BE-4 codehash，再辨識是否存在鏈上預留：舊版明確讀取 `totalReserved`，失敗即 unknown；新版確認沒有該 API 才將 `external_reserved_raw` 寫 0。BE-3／BE-4 不建立鏈上預留，因此舊鏈上 R 全屬外部來源，不與本 writer 的 DB R 鏡像重扣。開啟送出前仍須 C3 同步 #49 最新版 profile／codehash。主網不准入；目前僅支援已審核 chain 97 的模擬市場。

## 執行開關與排程

`ENABLE_YIELD_EXECUTION=0` 為預設。市場清單、讀值、同意與全退通知可用；自動送出仍關閉。C3 完成 BE-4＋本 PR 的 Kernel 整合驗收後才設為 1，scheduler 仍須明示 `--live`。本 PR 的三協議本機驗收是 owner smoke account，沒有把它當作 BE-4 Kernel／bundler 驗收。

每輪 `runSchedulerOnce` 先執行獨立的 yield round，再檢查買入／價格／DEX gate。yield round 包含 paused／舊版部位、未決操作及全退要求，使用既有 `withPortfolioLock`。dry-run 不寫生息表、不預留、不送出。CLI 可用 `--loop --interval 30`；RPC observation 超過 60 秒、來自未來或整輪讀值超時，均不得新增供給。負載或 RPC 不足以保持新鮮時，回 unknown，不能沿用舊數字供給。

讀值先核對 executor→yieldRegistry、鏈、完整 marketCount／marketIds 與 profile 的市場身分。每個共享 group 在同一個 `eth_call` 先補息，再讀健康度、換算率、部位及協議 cap。Lista queue 去重並取保守最小 S／L，不累加共享 core 現金。Aave 保留完整 ray 與 scaled units。`refreshHealth`／registry 自己驗 identity、configuration、rate；後端不採 API APY，也不從 manifest 初始 APR 推算收益。

U=8000 bps 允許；8001 不供給；9000 開始退出。退出黏住至零，不能因 U 降低就撤銷。重新同意需新的本人鏈上 policy 證據，且不能清掉非空退出。資料失效或外部收據異動仍保留部位／未知預留，並由既有 `portfolio_stuck` 警示呈現。已確認業務事件的原區塊若不再 canonical，留下 reorg tombstone，停止該帳戶自動對帳／送出，交給人工處理。

## API 與前端 #95

- `GET /yield/markets?chainId=97`：`{ chainId, registry, markets }`，每市場含 `id`（平台 slug）、`marketId`（bytes32）、`protocol: venus|lista|aave_v3`、`asset`、`symbol`、`receipt`、`aprBps`、`simulated`、`supplyOpen`；另附 `is_simulated`、`dataAt`。APR 直接讀目前 mock 的 APR，**不是 APY**。讀不到時 `aprBps=null`／`supplyOpen=false`；前端現有嚴格 parser 會丟掉無利率市場。
- `GET /portfolios/:id/execution` 新增 `yield: { permission, accountValue, assets }`。只列目前選的市場、有同意或持有歷史債權的市場，不列全部空市場。`receiptValue`、`pending.value`、`accountValue` 都是 **USDT raw 字串**，未知為 null。另附 `claimAssets`／`maxWithdraw`（underlying raw）、`valuationState`、`simulated`／`is_simulated`。`pending.reason` 可為既有的三種原因或 `unknown`。沒有生息 profile 時不附 yield。`cash.reconciliationPending` 為新增布林值；生息在途時 unclassifiedRaw／deficitRaw 都為 null，不能把未扣／已扣但未結算的供給誤作新投入。
- `POST /portfolios/:id/yield/consent`、`/yield/exit`：沿用 `{ markets, txHash }`，markets 接受 API 的 slug 或 bytes32。本人先簽 policy／requestExit，再通知；後端驗成功 receipt、canonical block、唯一 account／market 事件、目前 policy 與 enrollment。未知 DB commit 重試原 txHash，不假稱尚未上鏈。
- **新增** `POST /portfolios/:id/yield/revoke`：同一 body；owner 先簽 `setYieldPolicy(...,false)`。只停止新供給，既有債權持續估值；要全部領回用 `/yield/exit`。
- `/yield/exit` 是全帳戶全退：body 的 markets 是本次鏈上證據，DB intent 涵蓋所有市場、舊版及退休市場。未完成不接受新的 consent。只有全市場新鮮零 receipt／observed／tracked 且無未決操作，才 completed。
- 不提供 `dailyAssets`；依前端契約由 owner 帶 uint256 max。

## 金額、估值與保守策略

所有金額／shares／nonce 以 bigint 計算、raw 十進位字串寫 DB。收據本金與利息已包含在保守 claim，不能再加 accrued interest。receipt NAV 與直接資產在 valuation vector 合計一次，交易 planner 的 holdings 仍是實際可花餘額。`portfolio_snapshots` 加上獨立 receipt 明細；raw 精度證據在 0036 快照，既有 E8 總額按各列向下取整。execution／status 的 accountValue 額外核對 executor 的 canonical NAV 與直接資產價格缺漏。

供給需目前 owner consent、enrollment／version、逐資產市場選擇、U／容量、24 小時及 50 USDT 下限都通過。USDT 僅使用 allocated cash／已實收 yield；本次**保留全部 stack_prefund**，因此一定保留下一期本金及費用。unallocated hold、買入／費用／在途／待領款與未辨識款不得供給。非 USDT 用已持有的實際資產，不借用 USDT 現金桶。

基金 monthly／drift 再平衡改由 scheduler 自動領回本批缺少的資產（backend#104）：先以同區塊債權投影詢問既有 planner，保留單筆限額、深度、交易時段與容量分批，再從批次 input 扣除實際可花餘額及前面賣出的保證 floor；USDT 同時保留最低費補差。投影不寫回 spendable holdings，也不作為餘額證明。只領回所需 nominal receipts（向上取整至能覆蓋缺口），不足時最多領回該資產全部部位；其他資產市場與剩餘收據不動，不建立全退 request、不撤銷 consent。新投入仍走既有現金／期次帳。

一次只送一筆 BE-4 withdraw，使用既有 exit purpose／共用 gas 安全額度，無新送出管線。領回確認當輪不做賣買、不更新 last_rebalance_at；下一輪重新讀實際餘額、NAV 及市場狀態，再規劃既有再平衡。市場暫停／缺現金時保留債權及既有排程重試；可部分領回時先領目前可領量，缺口尚未備妥前整批不賣買。RPC／DB 失敗、送出／commit 未知仍由 0036／0040 原 execution key 與快照對帳，不重送；canonical 來源重組沿用永久 tombstone 凍結。純粹再平衡等待不寫入全退的 sticky exit_state。

monthly 的持久化月份錨點或 drift 的新鮮 >500 bps 報告尚待完成時，yield round 暫緩新供給，避免重啟後把剛領回的 input 又存入。資料不完整也暫緩；完成或偏離回到 ≤500 後，剩餘同意、24 小時、50 USDT 與原風控規則繼續適用。保守取捨：領回與賣買分輪，等待期間價格可能改變，下一輪按新價格重算；planner 因買入額度／深度／時段而 blocked 時，先不領回。沒有預測可領時間、沒有替用戶墊付。

領回採可對帳來源的 FIFO 收據成本，最後一份還原 raw 尾差。實收收益進 yield_raw；已配置現金仍回 allocated_cash。若已驗證的 canonical 贖回有損失，僅將實收本金按來源比例與最大餘數分配，不補造現金或負利息；原事件與來源足以重算損失。未知／缺歷史來源維持待對帳，不按餘額差自動造本金。

## Journal 與鎖序

帳戶 session lock → cash 獨立 statement FOR UPDATE → 排序市場 → 排序 bucket → position／action → site/day → account/day。RPC 在短交易外。

BE-4 準備 paymaster 時，注入既有 reserve callback 暫存 request；journal.prepare 再核對報價區塊號／hash、新鮮度及 deadline，透過既有 `reserveSponsorship` 的 transaction 參數，將 gas／sponsorship、來源扣款、action、pending operation、0040 原始快照提交到**同一 client／同一 commit**。沒有簽名或私鑰進快照。prepare commit 不明確成功就不廣播；原 execution key 再進 prepare 一律轉對帳，不允許第二次廣播。

sending 前已保存原始 hash，保守標 unknown；未知不逾時釋放。重啟只用 0040 的原 plan／Kernel calldata／原 nonce／原餘額與 UserOp hash 呼叫 BE-4 reconcile。成功時 event、operation、position 與新風控快照同交易將 R→C。withdraw 不走供給／買入 gate；部分退出保留 remaining receipts 與 retry。revert 只按 canonical 證據還原來源，gas 歷史成本不退。

## 本機三協議驗收

`bun scripts/verify-yield-read.ts` 只接受 `127.0.0.1:8595` 的 anvil chain 97，使用公開 anvil 測試金鑰與 contracts#49 編譯產物，所有部署／寫入均在本機 fork。`YIELD_CONTRACT_ARTIFACTS` 可覆寫 read-only artifacts 目錄；不讀 `~/.cre8-testnet`、不修改合約 repo。

加 `YIELD_VERIFY_DATABASE=1` 時只允許本機資料庫 `cre8_be84`：三個 owner smoke account 的真 receipt／tracked units 寫入 0036 與既有帳戶快照並核對。之後用受控鏈時鐘模擬一小時補息，測 ≥90% 使用率、部分領回、恢復流動性及全退歸零。此階段只在受控時鐘下讀取／比對，不把未來資料寫入真 DB。Kernel／UserOp 三層驗收仍需 BE-4 整合，不把 owner smoke 當成已通過。
