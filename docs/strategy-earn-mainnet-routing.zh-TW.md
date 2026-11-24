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

- 開倉時用當下的最佳路線。
- 續期（session key renewal）和再平衡時重新評估；平常不追著利率搬家。
- 遲滯（提議，待使用者確認）：已開的部位只在同時滿足以下三個條件時才搬：
  1. 新路線的 extra 比現在高至少 **0.50%（年化）**；
  2. 搬家後 30 天多賺的金額 ≥ **3 倍搬家成本**（還款、取回抵押、換市場抵押、借款、存 vault，約 5 筆交易的 gas，加上換幣的滑價）；
  3. 現在的路線已持有至少 **7 天**。
- 不受遲滯限制、要立刻處理的情況：現在的路線變成負利差、市場暫停或被移除、可借額度不足以撐住部位（照合約的減倉與平倉規則處理）。
