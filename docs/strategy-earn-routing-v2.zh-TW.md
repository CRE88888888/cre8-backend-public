# 加息策略動態路由 v2：後端這一側

合約規格：cre8-contracts `docs/borrow-routing-v2.zh-TW.md`（這裡對的是 **v2.0-draft6**，測試網 2026-11-25 起跑的就是這一版；外掛的 `AtpBorrowCashSwapper` 見規格 §17、§18）。選路線的規則：`docs/strategy-earn-mainnet-routing.zh-TW.md`。激勵代幣：`docs/strategy-earn-rewards.zh-TW.md`。

| 檔案 | 做什麼 |
| --- | --- |
| `deploy/strategy-earn-v2.json` | v2 部署設定：executor／registry／lens／場所／adapter／借款幣／激勵代幣／`cashSwapper`（地址與池子）／金絲雀 owner。**程式裡沒有任何 v2 地址** |
| `src/strategy-earn-v2.ts` | 部署設定與對象（`strategyEarnV2`、`strategyEarnV2For`）、calldata、執行計畫（`planExecution`、`runV2Account`）、UserOp 分批、paymaster 規則、session key 範圍、帳本列 |
| `src/strategy-earn-v2-chain.ts` | 讀鏈：一律 `AtpBorrowLensV2`＋Multicall3，只走公開節點。路線與 vault 從 registry 列舉 |
| `src/strategy-earn-v2-api.ts` | App 用的 owner UserOp：同意、開啟、關閉、救援、My mix 改比例的重新同意、部位 |
| `src/strategy-earn-v2-scheduler.ts` | 排程器：自動開倉與定期重新評估、賣出前還款、keeper（減倉、收激勵） |
| `src/strategy-earn-v2-rates.ts` | `reportRates` 每 12 小時（API 服務的 operator 金鑰） |
| `src/strategy-earn-v2-swap.ts` | USDC／USD1／U ↔ USDT（`AtpBorrowCashSwapper`）：關閉後留在帳戶的借款幣換回 USDT；補差額的計畫在 `strategy-earn-v2.ts` 的 `planTopUp`／`settleRepayment`（見下） |
| `src/strategy-cash-swaps.ts` | 現金帳本的規則：補差額／USDT 路線的還款從投組自己的現金（`allocated_cash_raw`）扣、換回來的加回去，每個事件只記一次；漏記的補記（`recoverCashSwaps`） |

測試：`test/strategy-earn-routing-v2.test.ts`、`test/strategy-earn-v2-chain.test.ts`、`test/sponsor-flows.test.ts`（兩種帳戶的每一種 UserOp 過 `sponsor()`，含 swapper）、`test/strategy-earn.test.ts`（同一組 endpoint 由 v1 或 v2 回答）、`test/strategy-earn-v2.test.ts`（排程器：補現金的小額賣出、全部賣出時先賣閒置的部分）、`test/strategy-cash-swaps.db.test.ts`（真 SQL：現金帳本的規則）、`test/strategy-earn-v2.fork.ts`（chain 97 fork，真合約：含已部署的 CallPolicy 對 swapper 兩個 selector 的放行與其餘的拒絕、非 USDT 路線負利差 → `topUp` → 關閉 → `cashOut`；**帳戶沒有任何帳本外的 USDT** 時的關加息與全部賣出，基金帳戶／自建組合帳戶 × USD1／USDT 路線共四組；補現金的小額賣出另有一組用真的贖回規劃器報價、由真的 `AtpExecutor` 成交：要 1 USDT、賣出約 0.0000147 BTCB、到手 0.9895 USDT）。

## 開關：誰用 v2

兩層，都是設定，不是程式：

1. **v2 在哪裡**：`strategyEarnV2(chainId)` 讀 `STRATEGY_EARN_V2_DEPLOYMENT`（一個 JSON 物件，有設就以它為準），沒設就讀 `deploy/strategy-earn-v2.json`。chain 97 已部署（2026-11-25），chain 56 沒有。session key 範圍、paymaster 允許清單、讀取用的 lens 全部跟著這份設定走；重新部署 executor 只要換這個檔案（或設變數）。格式錯就 throw。
2. **誰可以用**：`strategyEarnV2For(chainId, owner)`。`STRATEGY_EARN_V2_AUDIENCE` 沒設＝部署設定裡的 `canaryOwners`；`all`＝所有人；`off`＝沒有人；或逗號分隔的 owner 地址。

**現況（2026-11-25）：`canaryOwners` 只有 e2e harness 的測試錢包（`0xD3Ab…D6D9`），其他人全部維持 v1。** 當天在測試網用兩種帳戶跑過的流程與交易見 PR #285–#289 的說明。 測試網已換成 draft6 的修正版（executor `0xeddd…600F`、registry `0x2461…CC0D`、lens `0x4fC6…a27A`）並部署了 `AtpBorrowCashSwapper`（`0x9981…0798`）。舊那套（executor `0x494C…6bB5`）的 registry 已暫停新開倉，66 條路線的本金都是 0（2026-11-25 用公開節點逐條讀 `totalPrincipal`），沒有部位要搬。

不在對象裡的 owner 完全走 v1：續期不裝 v2 權限、paymaster 不贊助任何 v2 呼叫、API 與排程器不會組 v2 的交易，也不會多讀任何鏈上資料（排程器只多一次有快取的 owner 查詢；持倉快照與 My mix 金流對帳只對對象內的 owner 讀 v2）。**對所有人開啟＝把 `STRATEGY_EARN_V2_AUDIENCE` 設成 `all`，這是產品決定，這次沒有做。**

## 一個帳戶只用 v1 或 v2（後端硬擋）

合約的 `ForeignDebt` 擋不住所有路徑（第三輪審查：Venus→Venus 搬家可以繞過），所以規則在後端四個地方各擋一次：

- **API**（`src/strategy-earn.ts` `v2Side`）：對象內的 owner，帳戶在 v2 已經有東西（同意、部位、策略盒有錢）→ v2 回答；v2 沒東西但 v1 有部位、負債或等待成交的同意 → v1 回答，v2 不組任何東西；兩邊都乾淨 → 新的同意與開倉走 v2。讀不到鏈就回「暫時無法使用」，不會猜是哪一代。
- **paymaster**：對象內 owner 的 UserOp 只要會在某一代「增加風險」（同意、抵押、借款、搬家），就先讀另一代；另一代還在用 → `PAYMASTER_CALL_FORBIDDEN`；讀不到 → 503。還款、取回、關閉永遠不檢查。
- **排程器**：帳戶在 v2 有東西 → 只跑 v2 那一步，而且 v1 還有東西時 v2 什麼都不加；v2 沒東西 → 只跑 v1。
- **引擎**：draft5 的 `ForeignDebt`（帳戶在 Venus 欠某個幣，但 v2 沒有這個幣的 Venus 部位）→ 這個幣的 Venus 路線不給這個帳戶。

## 讀鏈

- 路線與 vault：`registry.routeCount／routeIds／route`（vault 同理），10 分鐘重讀。owner 新增路線不用改程式。
- 市場快照（每輪一次，60 秒快取）：每條路線的 `routeStatus(routeId, 0)`、`minLoan`、`minDebt`；每個 vault 的 `vaultStatus`。另外讀：ERC4626 vault 的 `maxDeposit`（0＝存不進去，不當目的地）、Venus 抵押市場的 `supplyCaps` 與已供應量（剩餘額度不夠放這筆抵押就不選）、Venus／Aave vault 的可領現金。轉成跟主網顯示同一個形狀的 `RoutingSnapshot` 給引擎。
- 帳戶：`policy`、`accountRoutes`、`accountVaults`、`boxOf`、每條路線的 `routeStatus(routeId, account)`、每個 vault 的 `vaultStatus`、每種借款幣的 `idleOf`／帳戶餘額／allowance、激勵代幣餘額、可抵押資產的餘額與價格。
- **淨值**＝策略盒各 vault 的 `assets`＋`idleOf`－負債（抵押品算在持倉裡）。
- **負債怎麼讀**（draft6 §5）：帳戶在某個幣的負債用 `lens.tokenDebt(account, token)`，不加總 `routeDebt`。`routeDebt` 只用來決定「這條路線送 `MAX` 會還多少」與畫面上怎麼分：某個幣的 Venus 本金還完只剩利息時，draft5 的 lens 每條同幣路線都回整筆，後端照 `accountRoutes` 的順序把份額壓到不超過 `lens.debt`（等於 draft6 的結果：整筆歸第一條，其餘 0）。`MAX` 只送給份額不為 0 的那條，份額 0 的只取回抵押。
- 路線對新借款關閉（registry 暫停、停用）：可借額度當 0，已開的部位照常持有，不強迫退出；路線被退休（`retired`）才當成市場消失。
- 一律走公開節點（`V2_PUBLIC_RPCS`，可用 `STRATEGY_EARN_V2_RPC_URLS` 換），節點之間自動切換，**不會退回付費 RPC**。公開節點都不回應時那一輪跳過。

## 排程器

| 時機 | 做什麼 |
| --- | --- |
| 成交後／每次輪到這個投資組合而沒有交易要做（`open` hook） | `v2AutoRound`：引擎決定 → session key 執行。開倉、補借、搬家、只換 vault、還款、關閉。這同時是「定期重新評估」 |
| 賣出前（`unwind` hook） | `v2UnwindForSale`：要賣的資產先還款取回。策略盒＋帳戶同幣現金夠 → 全關；不夠 → 能還多少還多少、按比例少 2% 取回，賣掉之後下一輪還剩下的。全部退出時（賣光／刪除／停利停損）同一把 session key 把激勵代幣送到 owner 錢包 |
| 每輪（keeper，`STRATEGY_EARN_KEEPER_PRIVATE_KEY`，跟 v1 keeper 同一把） | `runV2KeeperRound`：場所說到健康線（`shouldDeleverage`）才送 `executeDeleverage`；策略盒裡的激勵代幣 ≥ 0.01（測試網 0.001）→ `collectRewards`。測試網另外代觸發模擬 vault／模擬場所的激勵發放 |

搬家規則（已定案，`ROUTING` 常數）：新路線加息高 ≥ 0.50%、30 天多賺 ≥ 3× 搬家成本、現路線已持有 ≥ 7 天。負利差、市場消失、vault 領不出來當輪處理。借款市場使用率上限 95% 由合約的 gate 擋。

UserOp：一筆最多 3 個 executor 呼叫，估計 gas 合計 ≤ 600 萬（送出時乘 2，單筆上限 1,400 萬）。整筆失敗就一個一個重送。`executeMigrate` 永遠自己一筆，失敗改走「先關再開」兩筆。碰 Lista vault 的呼叫在主網很重（240–670 萬），自然會各自一筆。

小額部位（規格 §5）：Lista 部位的負債 ≤ `lens.minDebt` 而策略盒的錢不夠還 → 第三方減倉不了。排程器用帳戶裡的同幣現金補足、一次全關；帳戶沒有那個幣就記一行「需要多少」。部分還款若會留下低於 `minDebt` 的負債，改成全還。

## paymaster 與 session key

- session key：v2 executor 上六個函式（`executeOpen／Reduce／Migrate／SwitchVault／Release／SweepRewards`），第一個參數釘死是這個帳戶。加在既有權限最後面。部署設定有 `cashSwapper` 時再加兩條：target＝swapper，selector 只有 `topUp`、`cashOut`（沒有帳戶參數可釘；**絕不放 `setPool`／`setLimits`**）。
- 權限變了就是新的 permissionId：裝在 swapper 之前（或舊 executor）的 key 對今天的部署算「還沒準備好」（`v2Authorized` 要兩段都有），API 回 `renewal_required`、排程器只回報不送，owner 續期後才裝上今天的範圍。**排程器重建 key 的 policy 時，v2 範圍是從 key 自己的快照讀回來的（`v2InstalledScope`），不是拿今天的部署設定去猜**：換過 executor 之後，舊 key 仍然重建得出自己的 permissionId（v1 的動作照常簽），只是送不了 v2 的呼叫。
- **`executeRescue` 只給 owner**（draft5 `rescueIsOwnerOnlyByPolicy` 三條都做了）：(1) 不在 session key 的允許清單（fork 測試在已部署的 CallPolicy 上驗過會被拒）；(2) paymaster 只在 UserOp 是帳戶 root validator 簽的時候贊助（看 Kernel nonce：mode 0、type 0），session key 簽的一律拒絕；(3) keeper 送出前過 `v2KeeperCall`，只放行 `executeDeleverage`、`collectRewards`。
- 其餘規則不變：第一個參數是自己、要有 deadline、編碼標準、`setStrategyPolicy` 的收款人只能是 owner／帳戶／0、approve 給 v2 executor 只允許投資組合資產／借款幣／激勵代幣。
- swapper（`v2SponsoredCall`）：只代付 `topUp`／`cashOut`，token 必須是 USDT 以外的借款幣、數量不是 0、要有 deadline、編碼標準，`topUp` 不接受 `MAX`。兩個都歸類為**結清**（`settle`）：不借錢、錢不離開帳戶與它自己的策略盒，所以 My mix 退出中／已退出／刪除中、v1／v2 互斥檢查都不擋。`approve(swapper)` 只允許 USDT 與借款幣（投資組合資產、激勵代幣都不行），同樣算結清；My mix 改比例的檢查（`assertMixV2Reconsent`）也放行這一種。

## API（App 用）

同一組 endpoint，回應形狀跟 v1 一樣（`status`、`calls`、`batches`、`authorization`），v2 多 `version: 2`。App 把拿到的 `calls` 原樣送出即可。

| Endpoint | v2 的內容 |
| --- | --- |
| `POST /portfolios/:id/strategy-earn/auto` `{ budgetRaw }` | 同意（`v2ConsentCalls`）：路線會用到、而且帳戶**還沒委託**的借貸場所的授權（讀 `approvedDelegates`／`isAuthorized`；已委託的不重送，主網的 Venus／Moolah 對沒有改變的委託會 revert）、一次 `setStrategyPolicy(maxDebt, owner, true)`、抵押品／借款幣／激勵代幣 approve 給 v2 executor。`authorization: 'renewal_required'` 時連 `GET /renewal-params` 的續期一起簽（會裝上 v2 權限） |
| `POST …/open` `{ asset, collateralRaw }` | 同意＋一筆 `executeOpen`（當下最好的路線）。也會回 `authorization` |
| `POST …/close` `{ assets }` 或 `{ asset }`，可加 `exit: true` | `v2ExitCalls` 切成 `batches`：關閉、放回剩餘、（`exit` 時）激勵送到 owner 錢包；全部關掉時最後一筆撤回同意。補不了差額的路線（投組沒有可動用的 USDT、或 24 小時視窗用完）不給會 revert 的關閉：先還策略盒還得起的部分並取回對應抵押品，其餘由排程器接手收乾淨（見「USDT 不夠時怎麼收乾淨」） |
| `POST …/rescue` `{ vaultId }` | owner 專用。該幣別還有負債時回 `debt_outstanding` |
| `POST …/confirm` `{ txHash }` | 把 v2 事件寫進帳本（db 0069）與激勵帳本（db 0068） |
| `GET …/strategy-earn`（`/me/overview` 裡的加息狀態是同一份） | 每個部位的 `route.source` 是 `onchain`（實際所在的路線與 vault）；`earnNetUsd` 含策略盒閒置的錢；`rewards` 是策略盒與帳戶裡的激勵代幣；`strategyV2: { registry, executor, cashSwapper }` 是這個部位所在的合約（跟簽名資料同一個物件、同一個來源 `strategyV2Addresses`；v1 的回應沒有這一項） |
| `GET …/strategy-earn/rewards` | 測試網沒有 proof API：直接回帳本，`signature.needed` 永遠是 false |
| My mix 改比例 | 後端組 owner calls 時，帳戶在 v2 就在 enroll 後面接 `setStrategyPolicy`＋新增資產的 approve（`mixStrategyConsent`）；新比例的路線用到、但帳戶還沒委託給 v2 executor 的借貸場所（新增的資產只走另一個場所），前面再加該場所的委託（Venus `updateDelegate`／Moolah `setAuthorization`，只補缺的：讀 `approvedDelegates`／`isAuthorized`）。paymaster 的改比例檢查（`assertMixOwnerCalls`）對 v2 對象內的 owner 認得這段尾巴（`assertMixV2Reconsent`）。簽名資料（`GET /me/mixes/:id/enrollment-params`、PATCH 的回應）對 v2 對象內的 owner 多 `strategyV2: { registry, executor, cashSwapper }`（部署沒有 swapper 就沒有 `cashSwapper`；**欄位名是跟 App 的約定，不要改**）：App 沒有自己的 v2 地址，簽名前用這些地址核對 v2 的呼叫（cre8-app `mix-chain.ts`），並在鏈上確認 `registry.executor()` 就是它；`cashSwapper` 必須等於 App 依 chainId 釘住的地址 |

## reportRates

`registry.rateReporter` 是 OPERATOR（`0xd8CE…9d7F`），這把金鑰只在 **API 服務**（`OPERATOR_PRIVATE_KEY`，水龍頭與開戶用的同一把），所以工作跑在 API：每小時檢查一次，任何一筆回報滿 12 小時、從沒回報過、或數字變動 ≥ 0.25% 就整批送一筆（跟水龍頭共用 relayer lock 與 nonce 規則）。回報時間與數值從 `registry.reports(id)` 讀，重啟不會重送也不會漏。排程器沒有新增任何金鑰。服務的 operator 不是 reporter 時只記一行、不送。`STRATEGY_EARN_V2_RATE_REPORTS=0` 可關。

數值來源：測試網讀模擬合約的公開參數（Moolah 每個市場的借款／抵押激勵、vToken 的激勵、earn vault 的利率與激勵）；主網用顯示同一份快照（`fromMainnetRates`）。

## 補差額與換回現金（`AtpBorrowCashSwapper`，規格 §17）

executor 自己不換幣。借 USDC／USD1／U 的路線，vault 長得比負債慢（或剛開倉、利息先跑了幾個區塊）就關不掉；關閉後多出來的借款幣也變不回 USDT。swapper 是唯一能把帳戶的 USDT 換成它欠的借款幣（`topUp`，直接進策略盒）與換回來（`cashOut`，回帳戶）的合約；呼叫者就是帳戶，沒有帳戶參數也沒有收款人。

**owner 多簽的授權（一次）**：`USDT.approve(swapper)` 與每個非 USDT 借款幣的 `approve(swapper)`。`auto`／`open` 的同意會帶上帳戶還缺的那幾筆（讀 allowance，已經給過的不重送），所以在 swapper 之前同意過的帳戶，下次同意時補簽；owner 自己關閉（`close`）時如果這一筆用得到 swapper，缺的授權也包在同一組 batches 最前面。My mix 改比例的重新同意也帶上帳戶還缺的這幾筆（`reconsent` → `v2ReconsentCalls` 的 `swapperApprovals`；paymaster 的 `assertMixV2Reconsent` 放行；App 依簽名資料的 `strategyV2.cashSwapper` 核對，cre8-app#146）；授權不綁 enrollment，改比例之後仍然有效。

**何時 `topUp`**（`settleRepayment`，跟它服務的那筆還款放同一個 UserOp）：關閉、部分還款、搬離一條非 USDT 路線之前，以及賣出前的還款取回。

- 讀值：`swapper.shortfall(account, token)` → `(gap, cap)`、`topUpCap`、`topUpWindowOf`，只對有負債的幣讀，自己一個 eth_call、gas 給 3,000 萬（規格：不要低於 1,000 萬；gas 不夠它會 revert，不會回錯的數字）。`shortfall` revert（有 vault 讀不到）→ `gap` 當成未知，vault 的存款不算數，改用 `cap`。
- 買多少：照讀到的數字，策略盒（閒置＋vault）加帳戶自己的借款幣**夠還就不買**（差額 0：照舊直接還，這筆還款完全不依賴池子）；不夠才買「差額 + 還款額的 0.02%（接下來幾分鐘的利息）+ max(前兩者的 1%, 還款額的 0.04%)」，不超過 `cap`。USDT 不夠買到這麼多、但夠補差額本身時，買得起多少買多少。`maxUsdtIn = 數量 × 1.003`。數量一定明確（合約的 `topUp` 沒有 `MAX`）。
- 用哪些 USDT：**投組自己的現金（`strategy_cash_balances.allocated_cash_raw`：現金權重與賣出所得）加上帳本沒有任何一格認領的 USDT**（`src/withdrawable-cash.ts` `strategySpendableCash`）。其餘六格絕不動用：等著買的入金、定投備款、買入工作的本金與費用、提領與生息保留。錢包現金、現金 Earn、別的投組在別的帳戶與別的表，完全不在這條路上（三種錢不混用）。帳本讀不到這一輪就不補。USDT 路線的還款（合約可以直接拿帳戶 USDT 的 `maxCashIn`）用同一個數字。
- 記帳（`src/strategy-cash-swaps.ts` `settleCashSwaps`）：每一筆成功的 UserOp 從收據讀出「這個帳戶的 USDT 經由策略進出了多少」——`ToppedUp.usdtIn`（補差額）、`CashedOut.usdtOut`（換回現金），USDT 路線則是帳戶 → executor 的 USDT 轉帳（`repay_cash`，fork 實測等於 `Reduced.fromCash`）與 executor／vault adapter／策略盒 → 帳戶的 USDT 轉帳（`vault_cash`）。花掉的從 `allocated_cash_raw` 扣（扣到 0 為止：超過的部分用的是帳本本來就沒認領的 USDT），回來的加回去。**每個事件只記一次**：標記與帳本變更在同一個交易裡，標記是 `strategy_route_events` 的一列（`kind = 'release'`——活動列表本來就不顯示的記帳列；`reason` 是 `top_up`／`cash_out`／`repay_cash`／`vault_cash`，`vault_id` 是 swapper 或 executor 的地址補零，`loan` 是幣別，`amount_raw` 是 USDT 數量），靠 `(chain_id, tx_hash, log_index)` 唯一。排程器送出的每一筆自己記；owner 簽的由 `confirm` 記，重複呼叫不會重複記。所以鏈上少多少、帳本就少多少，不會出現 `[CASH_DEFICIT]`；自建組合「帳本 = 鏈上餘額」的檢查也維持成立。
- 漏記的補記（`recoverCashSwaps`）：owner 簽完沒呼叫 `confirm`、或排程器在收據與記帳之間掛掉，帳本會比鏈上多。排程器每一輪讀到「帳本認領的比帳戶實際有的多」就掃這個帳戶最近約兩天的 swapper 事件與 USDT 轉帳，把沒記過的補記（同一個標記，所以絕不重複）；同一個投組十分鐘最多掃一次。部署設定的 `cashSwapper.ledgerFromBlock` 之前的事件不補（那時花的是帳本外的 USDT），沒設這個欄位就不掃。
- **USDT 不夠時怎麼收乾淨**（目標：帳戶裡沒有任何帳本外的 USDT，關加息與全部賣出都收到負債 0、抵押品 0）：
  - **全部賣出／刪除／停利停損（加息開著）**：第 1 輪用策略盒現有的錢還得起的部分、按比例少 2% 取回抵押品（`partialRepayment`；還不到負債 1% 就不送，免得每輪空轉）；第 2 輪策略盒空了、補差額沒有 USDT → 排程器**不擋賣出**，改用「扣掉還抵押著的部分」重新規劃，先把帳戶裡閒置的賣掉（`V2UnwindWait`、`withoutPosted`）；賣出所得進 `allocated_cash_raw`；第 3 輪 `[topUp, 關閉, cashOut]`（USDT 路線就是一筆帶 `maxCashIn` 的關閉）；第 4 輪賣掉剩下的。每一輪都從鏈上重新讀、重新規劃，任何一步失敗下一輪照同樣的規則接續，不會重複動錢。
  - **單純關加息（不賣）**：owner 的 `close` 不再回 `top_up_unavailable`。補不了差額的路線，owner 那一筆先還策略盒還得起的部分並取回對應的抵押品，同意照樣撤回；剩下的一小段由排程器接手：安靜的那一輪回報「還差多少 USDT」（`onCashNeed`），排程器用同一條交易管線賣一點閒置資產補上（**補現金的小額賣出**，`planCashRaise`：需求的 2 倍、最少 1 USDT，挑閒置價值最高、市場開著的資產），所得記成投組自己的現金，下一輪 `[topUp, 關閉, cashOut]` 收乾淨。排程器自己決定的關閉（負利差、已撤回同意）同一套。
  - 一般再平衡要賣的資產還抵押著而補不了差額：同樣先做補現金的小額賣出，下一輪再還款取回。
  - 補現金的賣出不套用資產之間的最小交易額（單步 1 USDT、整批 50 USDT；買入批次的每筆 10 USDT 規則本來就只管買入）：它刻意很小。鏈上只有 executor 的報價地板要 > 0，以及最低費（上限是成交額的固定比例，小額不會被吃光）。同一個投組 30 分鐘最多一次；它是一筆正常記錄的賣出（`operations`、所得進帳本），但不算自建組合的一次再平衡（不動再平衡日期、不發「已再平衡」通知）。
  - 限制：美股休市時沒有可賣的閒置資產就等開盤；帳戶的 session key 沒有 v2 範圍（owner 還沒續期）時排程器接不了手，剩下的要等續期；剩餘抵押品的價值低於 executor 最小步時，全部賣出會照既有規則記成尾差結束。
- 24 小時視窗用完／`PegExceeded`：不是 USDT 的問題，不會觸發補現金的賣出。全部賣出照上面先賣閒置的部分，還抵押著的那一段等視窗重開（或池子回到 1:1）後的輪次自動接續。
- vault 讀得到但領不出來：第一筆 `[topUp, 關閉, cashOut]` 整筆 revert 時，改送 `[topUp（只算閒置，買到負債 − 閒置，最多 cap）, 關閉]`（`Step.fallback`）；USDT 不夠買這麼多就只重送不帶 `cashOut` 的那一組。
- **賣出不會被 swapper 擋住**：賣出前那一筆裡的 `topUp`／`cashOut` 送不出去（`PegExceeded`、`WindowExceeded`、預估落空）時，同一輪改用「沒有 swapper」的算法重排一次（重新讀鏈；還得起多少還多少、按比例取回），剩下的借款幣留給之後的輪次。
- `WindowExceeded`（這個幣 24 小時的額度用完）：計畫階段讀到 `cap` 不夠就不送，log 寫明 `topUpWindowOf.start + 86400` 的時間；真的送出才撞到的話記一次原因、這一輪不算失敗（不進 back-off），下一輪由計畫自己等視窗，**不會每輪重送**。
- `PegExceeded`：池子偏離 1:1 超過合約上限，重送沒有用。寫一行結構化 log（`{"level":"error","msg":"strategy_peg_exceeded",…}`），定期重新評估那條路以 `[STRATEGY_PEG_EXCEEDED]` 開頭的錯誤失敗，記成 `[STRATEGY_EARN_OPEN_FAILED] … [STRATEGY_PEG_EXCEEDED]` 並照既有的間隔退避（5、10、20、40、60 分鐘）；賣出前那條路寫完這行 log 之後照上一點改走不補差額的還款取回，賣出不會被擋。**告警**：除了這行 error log，排程器把這次遇到的事交給告警（`src/alerts.ts` `noteStrategyPegExceeded`），`/api/health` 會在這個投組的 `portfolio_stuck` 列看到 critical 的 `[STRATEGY_PEG_EXCEEDED] …`（跟退出失敗、生息注意事項一樣併進同一列，不需要新的 `kind`）；兩小時沒再遇到就自動解除。

**何時 `cashOut`**：
- 跟關閉放同一個 UserOp：關掉的是這個幣的最後一條路線，而且「關完帳戶裡一定有剩」（帳戶原有的借款幣＋策略盒＋補進去的 − 負債 − 0.02% ≥ 0.000001）才帶。`cashOut(token, MAX, minUsdtOut = 這個下限 × 0.997)`；合約自己的錨定上限（0.25%）管其餘的部分。
- 之後補做：每一輪（含加息已經關掉、帳戶沒有任何路線的帳戶）看到帳戶裡有 USDC／USD1／U、而且這個幣已經沒有負債，就用 session key 換回（`leftoverCashOuts`，`minUsdtOut = 餘額 × 0.997`）。全部賣出／刪除／停利停損的那一輪也會做，owner 領回的就只有 USDT。
- 換回之前，`earnNetUsd` 把帳戶裡的這些幣當 1 美元算（USDT 本來就是投資組合的現金，不算在這裡）。

**記帳**：每一筆 `ToppedUp`／`CashedOut`（與 USDT 路線的 `repay_cash`／`vault_cash`）在 `strategy_route_events` 留一列（見上「記帳」），同時寫一行結構化 log：`{"msg":"strategy_cash_swap","kind":"top_up"|"cash_out"|"repay_cash"|"vault_cash","portfolioId",…,"usdtRaw","tokenRaw","needRaw","txHash","logIndex"}`（排程器與 `confirm` 都寫）。記帳失敗（鏈上已完成）寫 `{"level":"error","msg":"strategy_cash_swap_unbooked",…,"txHash"}`，之後由補記接手。My mix 的金流對帳把 swapper 的池子當成內部地址（USDT 付進池子、池子付回 USDT 都不算入金／出金）。

**gas**：`topUp` 實測（chain 97 fork）跟 `executeReduce`、`cashOut` 同一個 UserOp 沒有問題。`executeOpen`（借款存 Lista vault）在新合約上 `eth_estimateGas` 92 萬、實際用 82 萬；後端送出時是「bundler 估計的 callGasLimit × 2、單筆上限 1,400 萬」，夠用。

## 激勵

- 策略盒的簽名：`abi.encode(bytes message, bytes accountSignature)`，Lista 只呼叫 `isValidSignature(bytes32,bytes)`＋EIP-191（主網實測）。激勵工作把策略盒當成另一個領取對象（`v2RewardHolders`），回應碼照實測處理（`000000000`／`1005`／401／沒帶 `type=safe` 的 500）。
- 領到策略盒之後由 keeper `collectRewards` 搬進帳戶；全部退出時 `executeSweepRewards` 送到 owner 錢包（同意時已 approve 激勵代幣，所以帳戶裡的也一起送）。單純關掉加息不送，留在投資組合帳戶；撤回同意時**保留收款人**（`setStrategyPolicy(0, 原收款人, false)`），之後全部賣出／刪除／停利停損時，就算已經沒有路線也沒有 vault，排程器仍會用 session key 把策略盒與帳戶裡的激勵送到 owner 錢包（只送激勵這一步失敗不擋賣出，下一輪再試）。收款人是 0 的帳戶只會做「策略盒 → 帳戶」。
- 測試網沒有 Lista proof API：模擬 earn vault 的 `claimReward(box)` 任何人可呼叫，keeper 代觸發後再 `collectRewards`。

## 還沒做／要注意

- 測試網的模擬 Lista 市場把場所激勵（抵押／借款激勵）以測試 USDT 發到帳戶（keeper 代觸發），不是 LISTA；只有 earn vault 的激勵是 LISTA、先到策略盒。主網兩者都走 Lista 的領取流程。
- 健康度接近減倉線、策略盒不夠還時「先 `topUp` 讓第三方的 `executeDeleverage` 有錢可還」（規格 §17 第 5 點）還沒做：keeper 那一輪只有任何人可呼叫的交易，`topUp` 要 session key。
- 補差額／USDT 還款動用的是投組自己的現金，花掉的每一筆都記進帳本（見「用哪些 USDT」「記帳」）。**沒有記帳的錢不動用**：呼叫端沒有接上記帳（`ledger.swaps`／`bookSwaps`）時退回只用帳本外的 USDT。
- 補現金的小額賣出走排程器的正常交易管線：美股休市、session key 沒有 v2 範圍、或帳戶裡沒有任何閒置資產（全部抵押著而且策略盒是空的，例如 vault 壞了）時做不了，會等條件恢復；這幾種情況 log 都寫明原因。
- 測試網的模擬場所激勵是 keeper 代觸發、以測試 USDT 直接發到帳戶：那筆錢不經過策略的交易，帳本不認領（留作帳本外的 USDT，owner 可以領走、補差額也可以用）。
- 主網：可抵押資產的價格來源（測試網用共用的借貸 oracle）；Lista USD1 vault 的單筆操作約 670 萬 gas，乘 2 之後貼近單筆上限；`shortfall` 的 eth_call 在主網約 560–590 萬 gas（已給 3,000 萬）。
