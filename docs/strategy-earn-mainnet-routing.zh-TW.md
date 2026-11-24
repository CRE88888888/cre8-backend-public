# 加息策略主網路由規則（給之後的 executor 照做）

實作：`src/strategy-earn-mainnet.ts`（目前只用來顯示 `GET /strategy-earn/markets` 的 `mainnetRates`）。主網 executor 上線時，開倉與調整都照這份規則選路線，不在程式或設定裡寫死任何資產的借貸場所、穩定幣或市場。

## 1. 每次刷新自動找市場

- 刷新頻率：10 分鐘（`MAINNET_RATES_MS`）。某個來源讀取失敗，就沿用它上一次讀到的值。
- Venus：從 `api.venus.io` 讀核心池全部市場。
  - 能當抵押：`canBeCollateral`，且 `collateralFactorMantissa > 0`，且 MINT／ENTER_MARKET 沒有暫停。
  - 能借：穩定幣市場 `isBorrowable`，且 BORROW 沒有暫停。可借金額用 `liquidityCents`。
- Lista：從 `api.lista.org` 的 borrow/markets 讀 zone=5（bStock）和 zone=0（其他），每頁 50 筆，讀到 `total` 為止。
  - 只取美元穩定幣借款（USDT／USDC／USD1／U）、非固定期限的市場。
  - 淨借款利率＝`rate` − `borrowEmissionApy`（LISTA 激勵），可以是負數。
- 存款 vault，每種穩定幣各取一家年化最高的：
  - Venus：該穩定幣市場的 supply APY ＋ XVS 激勵。
  - Aave v3：`Pool.getReserveData` 的 liquidity rate。
  - Lista：存量 ≥ $1M、名稱不含 Exclusive、激勵 ≤ 3 倍基礎 APY 的 Moolah vault。
- 新市場不用改程式就會出現。被移除、暫停或借光的市場（可借 < $1k）自動不列入。

## 2. 每個資產的選法

把該資產在每個場所（Venus 有上架才算；Lista 該抵押品的每個市場）× 每種穩定幣（借 X 存 X，不換幣）的組合都算一遍：

- 利差 carry ＝ 該幣最佳存款 APY − 淨借款利率
- 比例 ratio ＝ min(類別上限, F / 2)
  - F＝該市場的 collateral factor（Venus）或 LLTV（Lista）。
  - 類別上限：指數與大型股 35%、一般個股 30%、跟幣價連動 20%。這和合約的目標 LTV 規則相同。
- 加息 extra ＝ carry × ratio ＋ 抵押激勵（Venus XVS supply）

在可借 ≥ $1k 的組合裡取 extra 最高的。可借 < $50k 時標 `limited`。carry ≤ 0 時不借（negative_carry）。都沒有可用市場時沒有路線，不借。

程式裡只有兩類常數：門檻（$1k、$50k、vault 篩選條件），以及目標 LTV 規則（類別上限、F/2）。

## 3. 什麼時候重新選（主網 executor）

實作：`src/strategy-earn-routing.ts` 的 `planAccount`（純函式，不讀鏈、不讀時鐘）。門檻全部在同一個 `ROUTING` 常數。測試：`test/strategy-earn-routing.test.ts`。

輸入：一份市場快照（`createMainnetRates().routing()`：每個資產的全部借款選項、全部穩定幣 vault、每個來源上次讀成功的時間）、一個帳戶的持倉與已開部位、搬家成本。輸出：每個資產一筆決定——`open`／`hold`／`migrate`／`reduce`／`close`，附原因代碼和一行說明（排程器 log 直接印）。

- 開倉時用當下的最佳路線；每輪排程和續期時重新評估。
- 路線＝借款市場（場所＋市場＋借哪種幣）＋同一種幣的存款 vault。不換幣。
- 已開的部位只在同時滿足以下三個條件時才搬：
  1. 新路線讓這個持倉的加息（carry × 比例 ＋ 抵押激勵）高至少 **0.50%（年化）**（`MIGRATE_MIN_GAIN_BPS`）；
  2. 搬家後 **30 天**多賺的金額 ≥ **3 倍**搬家成本（`MIGRATE_WINDOW_DAYS`、`MIGRATE_COST_MULTIPLE`）。成本＝gas × 5 筆（還款、取回抵押、換市場抵押、借款、存 vault；只換 vault 是 2 筆）＋滑價；
  3. 現在的路線已持有至少 **7 天**（`MIN_HOLD_MS`）。
- 不受上面限制、當輪就處理：現在的路線變成負利差（carry ≤ 0）、市場或 vault 暫停／被移除／被借光（從快照消失）、vault 可領金額不夠還債。有正利差且容得下整筆債的路線就搬過去，否則平倉。
- LTV 到減倉線：`reduce`，還到目標比例（合約的 `executeDeleverage` 任何人可呼叫，這裡只是同一個判斷）。
- 買入成交後抵押變多：同一條路線補借到目標比例（`open`／`top_up`）。債務低於目標 5% 以上才補（`TOP_UP_MIN_GAP_BPS`）：執行端本來就只借到目標的 98%，小幅價格變動不值得一筆交易。
- 額度：搬家要目標市場容得下整筆債；新開倉借得到多少算多少（低於 $10 不開）。同一輪多個帳戶共用同一份剩餘額度（`liquidityOf`）。
- 資料過期不動作：某個來源超過 30 分鐘沒讀成功（`MAX_SOURCE_AGE_MS`），那個場所既不當目標、也不當成離開的理由。鏈上的減倉線照常保護部位。
- Venus 共用債務：Venus 核心池一個帳戶的所有抵押品背同一筆債，所以一個帳戶的 Venus 部位只用一種借款幣。
  - 新的 Venus 部位加入帳戶現有的那種幣；帳戶還沒有 Venus 部位時，挑讓整個帳戶賺最多的那種。
  - 換幣是整組一起換、算一次搬家：用整組的總增益比三個門檻，持有時間看組裡最新的那個部位。
  - 這種幣本身出問題（全組都負利差或借款市場消失）時整組當輪離開；只有某個抵押品被 Venus 下架時，只有它離開。
  - 輸出的 `venus.debtUsd` 是全部 Venus 部位的計畫總債務：合約拿每個 Venus 市場的上限去比帳戶的整筆債，所以每個 Venus 市場的同意上限都要用這個數。
