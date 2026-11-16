# P11 版本介面與本人加入流程

對應 cre8-contracts main `e699bd8`（已含 PR #54 最終版及獨立績效費 ledger）。合約不可升級；七欄 `Version`、三參數 enroll 與新 executor 必須整套重新部署。ABI 集中於 `src/registry-abi.ts`。ledger 的可選 `performanceFeeLedger` manifest 欄位可原樣解析保留；本單不實作其收費／本金流程。

依 C3 加速定案，轉版重排移出本 PR，由 db#60 與後續 backend 單完成；本 PR 保留轉版停買守衛，見下方執行邊界。

## 加入與確認

chain 97 的 `POST /portfolios` 與 `POST /portfolios/enrollment-params` 先由 operator 直接呼叫固定 MetaFactory 部署 Kernel；owner、salt、initConfig 與派生地址不變。部署確認後回 `accountDeployed:true`、expectedVersion、設定 hash 與本人 sudo enroll calldata，不回 factory／factoryData。owner 的 UserOp 不帶 initCode，只呼叫 `enroll(account,id,expectedVersion)` 與 approve；後端不代簽同意、不先建 portfolio，session key 的 CallPolicy 沒有 registry 權限。

部署沿用 `deploySmartAccount` 的 CREATE2／`getCode` 守衛與既有 relayer 鎖，不新增資料表。已部署跳過；同程序同帳戶的部署中請求或 receipt 等待逾時回 `202`、`accountDeployed:false`、`retryAfterSeconds:3` 和 `Retry-After: 3`。RPC／DB 錯誤、revert、receipt 後缺少帳戶 code 都有明確錯誤碼。部署沒有持久 outbox；廣播結果未知或重啟／並行重試時，鏈上 code 尚未出現仍可能多送部署交易並消耗 gas（最壞 revert），這是 C3 接受的測試網既有語意。

首次部署廣播前以既有 `daily_operation_counts` 原子扣全站每日 300 次與 owner 每日 20 次嘗試額度，並核對 operator pending 原生幣餘額至少 0.05 tBNB；設定與錯誤碼見 [測試網部署說明](testnet-deploy.zh-TW.md)。準備與確認各自使用每 owner 每分鐘 30 次短期限流，輪詢及已部署重試不重扣每日額度。未知 COMMIT 不廣播、不退款；nonce／簽名前的失敗不扣額。

`POST /portfolios/enrollment-confirm` 唯讀核對 canonical block 的 `isEnrolled`、strategyId、接受版本與 paused，通過才建立 portfolio。RPC 錯誤、reorg、未加入或版本不符都拒絕。原 owner `approveEnrollment(uint256,uint16)` → operator 首次 enroll 的合約路徑保留；app 使用直接 sudo enroll。

首次 setup 尚無 smart account DB 列時，paymaster 以登入 owner 的既有 enrollment intent 與鏈上 strategyId 查詢，再唯讀重導帳戶、確認已部署與核對 calldata／有效預期版本；只允許一筆 enroll 與可選 USDT approve 給 executor。已知但屬於外人的 DB 帳戶不進 fallback；原 chain、14M gas、代付額度與持久化預留檢查照常執行。

paymaster 只允許 setup 中 account 等於 UserOp sender、非零 strategyId／expectedVersion、可重新編碼為相同 calldata 的 enroll；額度與生息已審行為不變。

## 發布與查詢

設定 hash 是 Solidity `keccak256(abi.encode(assets,weightsBps,scheduleHash,settingsHash,performanceFeeBps))`，保留資產順序。typed 設定使用完整 canonical execution；生效時間與費率獨立，才能表示只降費。效期、七天間隔、單一 pending 與 128 個歷史／候選資產聯集上限由合約驗證；golden 覆蓋完整設定編碼。

發布預設 now+24h+60 秒，也接受符合合約門檻的明確 activeAt；只有相同設定的績效費調降可立即生效。保存的 immutable 設定重試只確認原版本，不以新交易掩蓋未知結果。

`GET /strategies/:id` 保留 execution 設定，資產／權重／hash／績效費／activeAt 以鏈上為準；versions 包含 active、pending、historical、cancelled 與 nextPublishAt。認證的 `GET /strategies/:id/versions/:version` 提供相同版本狀態。

依 #124 最新 C3 定案，**測試網首發沒有取消版本 API，canCancel 一律 false**。原型 writer 已移除，`/strategies/:id/versions/cancel` 回 404。合約取消 ABI／歷史事件仍保留以讀取狀態；後續取消功能須連同 durable intent/outbox schema 另案實作。

## 執行與資金邊界

snapshot 在同一塊讀 activeVersion、version 與 historicalAssets，以最新已生效目標規劃。曾生效但已移除的資產去重、以零權重納入估值與賣回，不能再買；pending／取消／空投不擴張准入宇宙。缺少 DB 版本鏡像、價格或 RPC 證據時保守拒絕規劃。

typed lot 的版本與本金身分保持 immutable；新版生效後，舊版 typed 工作停止買入，不重綁舊本金。首次 welcome mint 前另核對最新生效版本，拒絕把新資金記到不能買入的舊版本。原 mint 不論 submitted／unknown／confirmed，仍先按原收據區塊核對、結清原 signer 狀態；不因版本跨界跳過對帳。funding lot 的 receipt-time 檢查同時核對當時有效版本與 owner 接受版本。

依 [C3 加速定案](https://github.com/CRE8Finance/cre8-backend/pull/126#issuecomment-6917662008)，上述停止為本 PR 的驗收行為：版本不一致即回報／記錄 `[PINNED_VERSION_CHANGED]`，在讀取買入額度、報價或預留期次前停住；重試不修改本金、原 lot、資產預算、期次或工作。已在途交易先按原證據結清，再停買。這個守衛也保守擋住純降費與原工作已完成的舊投組，不以修改 portfolio.version 繞過；新加入且接受目前生效版本的投組以該版建立新入金計畫。

轉版重排由 db#60 與後續 backend 單完成，不是本 PR 的阻擋前置。後續要求：新版生效時所有資產尚未花用的預算合計，視同該時點的新入金，依新版權重與 hold／stack 設定重排；純降費不重排，在途單先結清，已買持倉保留且不自動賣出。現有 DB trigger 鎖住 lot 身分、原資產預算／期次，且要求 job/slice 的版本等於 lot.version；必須由 X2 增加保留原入金證據的轉版計畫／來源關聯後才能接線。不能修改原 lot 或以同 tx/log 再造入金代替。

生息 NAV 的普通資產估值使用同區塊 `historicalAssets` 去重聯集，包含加入後新版新增代幣；生息 policy 仍依本人授權的原版本。歷史清單／餘額／報價缺漏或與 executor NAV 差一 wei 仍回 unknown，避免因版本變更放寬資金核對。

typed 新工作入場預算保守計入全部非現金歷史資產數；歷史達 127 個時，入場容量會是 0，即使多數已賣清仍拒絕新的買入工作。實際技術子批次與 legacy 排程則按正持有的完整歷史資產數重算相同容量，避免規劃後被另一處截斷，也避免對零持倉反覆過度拆分；最終仍檢查實際 prepared UserOp 總 gas ≤14M 與每日 100M。純賣出不使用買入估值預算，可繼續退出。沒有放寬額度以隱藏此限制。

## 本機 pins 與驗收

`deploy/testnet-97.json`、runtime pins、ABI／golden 由 C3 指定的 main revision `e699bd8` 的**本機 chain 97 fork** 重新部署及 `scripts/sync-testnet-profile.ts` 產生。同步核對 registry／executor／yieldRegistry／YieldView 的 compiler runtime、immutableReferences、原始碼 revision 與 selectors；YieldView 使用部署前保存的未連結 artifact，以完整 metadata 比對。公開部署後由 C3 以新 manifest 再同步；本次 pins 不能宣稱已公開部署。

本單只用 anvil 8597、alto 3097、backend 8697、可拋棄 DB `cre8_be124`。合約 checkout 唯讀，編譯／部署副本放 `/tmp`。`MIGRATIONS_DIR` 指向已 pull 的 db repo，不修改 migration。

- `test/registry-versioning.fork.ts`：chain 1337 上以真 registry／executor artifact 驗本人同意、買入、新版、24h 前／等於邊界、舊資產禁買／可賣、降費、合約取消、七天限制及 128／129 聯集上限。此 fixture 使用 owner-only sudo 測試帳戶。
- `test/testnet-97.e2e.ts`：真 Kernel／EntryPoint／alto，SIWE → 發版 → 等待 → HTTP 準備 → operator 預部署 → owner 無 initCode 的 enroll／approve UserOp → canonical 確認 → faucet → session 排程買入 → 全額賣回／提領與 strict preflight。
- `test/welcome-grants.fork.ts`、`test/yield-85.fork.ts`、`test/yield-106.fork.ts`、`test/no-asset-cap.fork.ts`：遷移本人 sudo 三參數 enroll／24h 準備。使用真 keeper swap／feed push 更新等待期間老化的價格來源，不修改 oracle storage。
- `test/fixtures/p11-local-roles.ts` 是顯式 opt-in preload，只接受 8597／3097／cre8_be124／chain 97。不讀金鑰檔；用公開 anvil operator／sponsor 取代本機角色，先還原驗證精確原 paymaster runtime，再只替換 signer immutable。profile／expected hash 只改程序記憶體；backend 與 preflight 子程序繼承相同 preload。本機明確斷言 MetaFactory `staked=false`、`stake=0`，不 impersonate factory owner、不補質押，保留 alto safe mode、factory 地址與權限。這層本機替身和 sync 的原 runtime 驗證分開記錄，不改 tracked manifest。

Kernel fixture 可用 `localAcceptanceEnv` 顯式選擇隔離的 localhost 埠／DB。#124 的 preload 固定為本單埠；原 yield-106 的 durable receipt 驗證要求 fork 舊於完整 24h 通知期，先發布所有測試版本，再追上牆鐘，避免未來的 DB 證據。這次 fork 使用 `--prune-history 4096 --transaction-block-keeper 4096`：保留記憶體歷史、真實部署前後區塊與部署事件，避免歷史報價重驗時遇到落盤快照的 Kernel bytecode 缺漏，並避免快取塞滿磁碟。固定 revision 若已落後 origin/main，只在本機 fork 顯式使用 `TESTNET_ALLOW_UNMERGED=1`；不混入其他合約版本。執行結束精準停掉自己的服務並刪除本次 anvil-state-*。

休市日期的 ordinary scheduler／贖回測試透過既有 `now` 參數選擇實際開市時段與對應排程期次；RPC、報價、代付及資金收據保持真實牆鐘，不關閉市場或新鮮度檢查。

**公開部署前置：** operator 需有支付首次部署的原生 gas；不新增部署紀錄 schema。正常 safe-mode alto 只接收已部署帳戶的 setup UserOp，strict preflight 保留固定 factory 的 runtime／selector 檢查，不要求第三方 MetaFactory 質押。本單只在未質押的本機 fork 驗證，不送公開交易。

實際測試指令與 pass／skip／fail 數字記在 PR #126；`.fork.ts`／`.e2e.ts` 必須顯式執行，一般 `bun test` 不會涵蓋它們。

## 廣播邊界與使用者停買狀態

買單在刷新 router calldata／計算 plan hash 前，以及 pending 寫入前，重新讀取最新 RPC 區塊的 `activeVersion`、`pendingVersion` 與 pending `version.activeAt`；所有讀取固定同一塊並核對 block hash。估 gas、代付與簽名完成後，在真正送出 UserOp RPC 前再次核對。生效版本與規劃時不同回 `[PINNED_VERSION_CHANGED]`；讀不到完整證據回 `[VERSION_STATE_UNAVAILABLE]`，均不廣播。

若已有 pending 版本，買單使用 `min(原 deadline, activeAt − 60 秒)`，截短後的 deadline 同時用於 router calldata、plan hash、DB 與 executor 呼叫。截短後不晚於鏈上時間或牆鐘時，回 `[VERSION_ACTIVATION_IMMINENT]`。簽名期間若另有更早的 pending，會拒絕原簽名，下一輪重新規劃，不能直接改 signed payload。已寫入 pending 但尚未廣播的拒送嘗試記為 failed；原 lot、本金、資產預算與期次證據不變。已廣播在途交易沿用原收據對帳。

`GET /portfolios/:id/status` 新增獨立欄位：

```json
{"buyingPaused":{"reason":"NEW_VERSION_ACTIVE","joinedVersion":1,"activeVersion":2}}
```

`joinedVersion` 來自 portfolio 保存的接受版本，`activeVersion` 來自本次 status 觀測區塊。兩者相同回 `buyingPaused:null`；不同表示等待後續轉版重排。基金頁可用 `NEW_VERSION_ACTIVE` 顯示「新版已生效，暫停買入，持倉仍可賣出或退出」。此欄位不加入 `blocked`，不改 `complete`、估值、持倉、registry pause flags 或退出能力。沿用 status 10 秒快取，因此畫面不是廣播守衛的替代品。讀鏈或 DB 失敗沿用 503，不回假的正常空狀態。本 PR 只提供 backend 介面，app 顯示由 C2 接線。
