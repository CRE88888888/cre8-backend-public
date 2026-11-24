# 加息策略動態路由 v2：後端這一側

合約規格：cre8-contracts `docs/borrow-routing-v2.zh-TW.md`（這裡對的是 **v2.0-draft6**；ABI 與 draft5 相同。測試網目前跑的是 draft5 的程式，後端的讀法兩版都對）。選路線的規則：`docs/strategy-earn-mainnet-routing.zh-TW.md`。激勵代幣：`docs/strategy-earn-rewards.zh-TW.md`。

| 檔案 | 做什麼 |
| --- | --- |
| `deploy/strategy-earn-v2.json` | v2 部署設定：executor／registry／lens／場所／adapter／借款幣／激勵代幣／金絲雀 owner。**程式裡沒有任何 v2 地址** |
| `src/strategy-earn-v2.ts` | 部署設定與對象（`strategyEarnV2`、`strategyEarnV2For`）、calldata、執行計畫（`planExecution`、`runV2Account`）、UserOp 分批、paymaster 規則、session key 範圍、帳本列 |
| `src/strategy-earn-v2-chain.ts` | 讀鏈：一律 `AtpBorrowLensV2`＋Multicall3，只走公開節點。路線與 vault 從 registry 列舉 |
| `src/strategy-earn-v2-api.ts` | App 用的 owner UserOp：同意、開啟、關閉、救援、My mix 改比例的重新同意、部位 |
| `src/strategy-earn-v2-scheduler.ts` | 排程器：自動開倉與定期重新評估、賣出前還款、keeper（減倉、收激勵） |
| `src/strategy-earn-v2-rates.ts` | `reportRates` 每 12 小時（API 服務的 operator 金鑰） |
| `src/strategy-earn-v2-swap.ts` | USDC／USD1／U ↔ USDT：需求計算與計畫（執行要等合約端開放，見下） |

測試：`test/strategy-earn-routing-v2.test.ts`、`test/strategy-earn-v2-chain.test.ts`、`test/sponsor-flows.test.ts`、`test/strategy-earn.test.ts`（同一組 endpoint 由 v1 或 v2 回答）、`test/strategy-earn-v2.fork.ts`（chain 97 fork，真合約）。

## 開關：誰用 v2

兩層，都是設定，不是程式：

1. **v2 在哪裡**：`strategyEarnV2(chainId)` 讀 `STRATEGY_EARN_V2_DEPLOYMENT`（一個 JSON 物件，有設就以它為準），沒設就讀 `deploy/strategy-earn-v2.json`。chain 97 已部署（2026-11-25），chain 56 沒有。session key 範圍、paymaster 允許清單、讀取用的 lens 全部跟著這份設定走；重新部署 executor 只要換這個檔案（或設變數）。格式錯就 throw。
2. **誰可以用**：`strategyEarnV2For(chainId, owner)`。`STRATEGY_EARN_V2_AUDIENCE` 沒設＝部署設定裡的 `canaryOwners`；`all`＝所有人；`off`＝沒有人；或逗號分隔的 owner 地址。

**現況（2026-11-25）：`canaryOwners` 是空的，v2 對所有人關閉。** 測試網這套 v2（draft5 程式）即將換成 draft6 的修正版重新部署，地址會全部換掉，所以先不在舊合約上留任何部位。重新部署後把新地址寫進 `deploy/strategy-earn-v2.json`，同時把 e2e harness 的測試錢包放回 `canaryOwners`，再跑上鏈驗證。

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

- session key：v2 executor 上六個函式（`executeOpen／Reduce／Migrate／SwitchVault／Release／SweepRewards`），第一個參數釘死是這個帳戶。加在既有權限最後面。
- **`executeRescue` 只給 owner**（draft5 `rescueIsOwnerOnlyByPolicy` 三條都做了）：(1) 不在 session key 的允許清單（fork 測試在已部署的 CallPolicy 上驗過會被拒）；(2) paymaster 只在 UserOp 是帳戶 root validator 簽的時候贊助（看 Kernel nonce：mode 0、type 0），session key 簽的一律拒絕；(3) keeper 送出前過 `v2KeeperCall`，只放行 `executeDeleverage`、`collectRewards`。
- 其餘規則不變：第一個參數是自己、要有 deadline、編碼標準、`setStrategyPolicy` 的收款人只能是 owner／帳戶／0、approve 給 v2 executor 只允許投資組合資產／借款幣／激勵代幣。

## API（App 用）

同一組 endpoint，回應形狀跟 v1 一樣（`status`、`calls`、`batches`、`authorization`），v2 多 `version: 2`。App 把拿到的 `calls` 原樣送出即可。

| Endpoint | v2 的內容 |
| --- | --- |
| `POST /portfolios/:id/strategy-earn/auto` `{ budgetRaw }` | 同意（`v2ConsentCalls`）：兩個場所的授權、一次 `setStrategyPolicy(maxDebt, owner, true)`、抵押品／借款幣／激勵代幣 approve 給 v2 executor。`authorization: 'renewal_required'` 時連 `GET /renewal-params` 的續期一起簽（會裝上 v2 權限） |
| `POST …/open` `{ asset, collateralRaw }` | 同意＋一筆 `executeOpen`（當下最好的路線）。也會回 `authorization` |
| `POST …/close` `{ assets }` 或 `{ asset }`，可加 `exit: true` | `v2ExitCalls` 切成 `batches`：關閉、放回剩餘、（`exit` 時）激勵送到 owner 錢包；全部關掉時最後一筆撤回同意 |
| `POST …/rescue` `{ vaultId }` | owner 專用。該幣別還有負債時回 `debt_outstanding` |
| `POST …/confirm` `{ txHash }` | 把 v2 事件寫進帳本（db 0069）與激勵帳本（db 0068） |
| `GET …/strategy-earn` | 每個部位的 `route.source` 是 `onchain`（實際所在的路線與 vault）；`earnNetUsd` 含策略盒閒置的錢；`rewards` 是策略盒與帳戶裡的激勵代幣 |
| `GET …/strategy-earn/rewards` | 測試網沒有 proof API：直接回帳本，`signature.needed` 永遠是 false |
| My mix 改比例 | 後端組 owner calls 時，帳戶在 v2 就在 enroll 後面接 `setStrategyPolicy`＋新增資產的 approve（`mixStrategyConsent`）。簽名資料（`GET /me/mixes/:id/enrollment-params`、PATCH 的回應）對 v2 對象內的 owner 多 `strategyV2: { registry, executor }`：App 沒有自己的 v2 地址，簽名前用這兩個地址核對 v2 的呼叫（cre8-app `mix-chain.ts`），並在鏈上確認 `registry.executor()` 就是它 |

## reportRates

`registry.rateReporter` 是 OPERATOR（`0xd8CE…9d7F`），這把金鑰只在 **API 服務**（`OPERATOR_PRIVATE_KEY`，水龍頭與開戶用的同一把），所以工作跑在 API：每小時檢查一次，任何一筆回報滿 12 小時、從沒回報過、或數字變動 ≥ 0.25% 就整批送一筆（跟水龍頭共用 relayer lock 與 nonce 規則）。回報時間與數值從 `registry.reports(id)` 讀，重啟不會重送也不會漏。排程器沒有新增任何金鑰。服務的 operator 不是 reporter 時只記一行、不送。`STRATEGY_EARN_V2_RATE_REPORTS=0` 可關。

數值來源：測試網讀模擬合約的公開參數（Moolah 每個市場的借款／抵押激勵、vToken 的激勵、earn vault 的利率與激勵）；主網用顯示同一份快照（`fromMainnetRates`）。

## 換匯（USDC／USD1／U ↔ USDT）

`loanTokenNeeds` 從一次讀鏈算出兩種需求：零頭（路線關掉後留在帳戶的非 USDT 借款幣，≥ 1 顆才處理）與缺口（策略盒＋帳戶的錢不夠還某個幣的負債，多買 0.5%）。`planLoanTokenSwaps` 接報價函式產生交易。

**執行還沒接**：換幣要走 `AtpExecutor.executeRebalance`，合約要求賣出的幣曾是該策略的資產、買入的幣現在是，而且 TWAP oracle 要有價。四種借款幣現在都不是策略資產，測試網的模擬 USDC／USD1／U 也沒有池子。排程器目前只把需求與原因記進 log。

## 激勵

- 策略盒的簽名：`abi.encode(bytes message, bytes accountSignature)`，Lista 只呼叫 `isValidSignature(bytes32,bytes)`＋EIP-191（主網實測）。激勵工作把策略盒當成另一個領取對象（`v2RewardHolders`），回應碼照實測處理（`000000000`／`1005`／401／沒帶 `type=safe` 的 500）。
- 領到策略盒之後由 keeper `collectRewards` 搬進帳戶；全部退出時 `executeSweepRewards` 送到 owner 錢包（同意時已 approve 激勵代幣，所以帳戶裡的也一起送）。單純關掉加息不送，留在投資組合帳戶。
- 測試網沒有 Lista proof API：模擬 earn vault 的 `claimReward(box)` 任何人可呼叫，keeper 代觸發後再 `collectRewards`。

## 還沒做／要注意

- 換匯的執行（見上）。
- App：`open` 回 `renewal_required` 時要像 `auto` 一樣帶續期；My mix 改比例的簽名前檢查（`checkStrategyConsent`）要認得 v2 的三種呼叫。
- 主網：可抵押資產的價格來源（測試網用共用的借貸 oracle）；Lista USD1 vault 的單筆操作約 670 萬 gas，乘 2 之後貼近單筆上限。
