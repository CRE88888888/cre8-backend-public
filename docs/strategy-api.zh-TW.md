# 逐資產策略 API、投入與排程契約

對應 backend#82／#83／#92、db 0031／0032／0034，以及 [測試網參數總表](https://github.com/CRE8Finance/docs/blob/main/docs/TESTNET_PARAMETERS.zh-TW.md)。每批 50 USDT 是**含費總預算**；每資產實際輸入至少 1 USDT。只在 chain 97 開新錢自動化；主網舊 target_weight 行為保留。版本不設資產數上限；單筆 UserOp 最多 16 步，依持有數縮小並驗總 gas ≤14M。保留完整原投入向量，僅按 confirmed 子批扣減；已配置現金與費用尾款不重算為新本金。

## 發版

`POST /strategies` 建立 metadata。`POST /strategies/:id/versions` 接受：

```json
{
  "chainId": 97,
  "allocation": {"assets": [
    {"address": "0x6de69565f250146c67d56be5aa15b6f181fce4d7", "weightBps": 5000},
    {"address": "0xbd7d814e02c9f69af391a8ba4c1787769f2ddd4b", "weightBps": 5000}
  ]},
  "execution": {
    "kind": "per_asset",
    "numeraire": "0xbd7d814e02c9f69af391a8ba4c1787769f2ddd4b",
    "rebalance": "none",
    "assets": [
      {"asset": "0x6de69565f250146c67d56be5aa15b6f181fce4d7", "weightBps": 5000,
       "execution": {"kind": "stack", "every": "weekly", "weekday": 1, "timeUtc": "01:00", "slices": 12}, "yield": null},
      {"asset": "0xbd7d814e02c9f69af391a8ba4c1787769f2ddd4b", "weightBps": 5000, "yield": null}
    ]
  },
  "schedule": {"kind": "funding"},
  "idleYield": {"enabled": false}
}
```

地址須符合該鏈 manifest；以上為 profile 範例，部署時以 manifest 為準。allocation 與 execution 必須完整對應、bps 總和 10000。USDT 項**不能有 execution**；其餘每項是 hold 或完整 stack。省略 execution 時明示展開各資產 hold；省略資產模式、yield、rebalance 分別明示套用 hold、null、none，再雜湊。省略 schedule／idleYield 補 funding／disabled。舊 bare `{kind:hold|stack}` 新發版拒絕；未支援功能、多餘欄位及個人金額不能默默丟棄。

stack 由創作者指定 daily／weekly、UTC 整分時刻、實際原設定 2–52 期。daily 的 weekday 為 null；weekly 為 0–6（週日為 0）。UI 先展示創作者當地預設每週一 09:00、12 期，再換成 UTC 送入；API 不猜時區。固定 UTC 後跨 DST 的當地時刻可能改變。買的人只決定投入總額。

rebalance 僅全非現金資產皆 hold 可選 none／monthly／drift；預設 none。drift 是任一資產偏離目標**超過 500 bps**，等於不觸發；monthly 跨 UTC 月後才再執行。再平衡沿用既有 target_weight quote／refresh／operation／gas 管線。尚有新錢未配置或在途時先處理原工作；再平衡的 USDT 實收付與 operation 同交易更新 allocated_cash，避免再次分類或虛假現金短缺。

yield 可為 null 或 `{market:"平台市場ID"}`；發新版本時須查 `strategy_asset_yield_markets` 同鏈／資產 enabled。初始無市場。市場退休不重寫舊 hash；本張僅保存設定，生息存領由 BE-3／BE-4 接入。

## Canonical config

schema 2 外層固定鍵順序：domain、schemaVersion、chainId、execution、allocation、schedule、idleYield、activeAt。domain 為 `cre8.strategy.execution`；UTF-8 JSON、無空白／換行；activeAt 為整秒 Unix 十進位字串。execution 固定 kind、numeraire、rebalance、assets，各資產固定 asset、weightBps、execution（非現金）、yield；stack 固定 kind、every、weekday、timeUtc、slices。兩組 assets 都按小寫地址排序；展示 symbol 不參與 hash。

`configHash=keccak256(UTF8(canonical))`，交既有 `Version.scheduleHash`，不改合約驗證或 ABI。[schema 2 goldens](../test/fixtures/strategy-config-v2-golden.json) 以 Python JSON＋`cast keccak` 獨立產生。schema 1 舊 canonical 與 [goldens](../test/fixtures/strategy-config-golden.json) 保留；舊 stack 指令與工作只允許歷史讀取／未知結果對帳，不能新增。

enroll、投入及執行均核對 pinned 版本、chain、allocation、scheduleHash、生效時間；不使用 latest 取代 pinned。新版本不能改舊設定。相同 publish 重試保留原版本與原 activeAt；未知 mirror 不重送 publish。DB 或 RPC 不完整回 503，衝突回 409。schema 0 target_weight 與內部舊 writer 保留。

## 個人端點

全部沿用 bearer 本人認證、portfolio 與 smart account owner 比對、跨程序帳戶鎖及短 READ COMMITTED cash-row 鎖。RPC 不在記帳交易內。忙碌 409、DB／commit 未知 503，重試同一來源即可。

| 端點 | 契約 |
| --- | --- |
| GET `/portfolios/:id/execution` | pinned config/hash、enabled、automation、建議投入、cash／balances、最近 100 lots／jobs、lotAssets 與 slices 執行狀態 |
| POST `/portfolios/:id/buy-funding` | 首次買入先呼叫，body `{}`；chain 97 無 USDT 且未有迎新時自動發 10,000 並建 lot。回 `{state:"ready",funding,lot}`（200）或 `{state:"pending",grantId,txHash,lot:null,funding:"welcome_grant"}`（202）；pending 只重試同一請求，不可當成已投入 |
| POST `/portfolios/:id/funding-lots` | `{source:{kind:"faucet_claim",claimId:"123"}}` 或 `{source:{kind:"welcome_grant",grantId:"123"}}`；回永久事件、effectiveSlices、confirmedAt、fundingStatus、replayed |
| POST `/portfolios/:id/execution-state` | `{enabled:false}` 暫停新買入；true 恢復；漏期不追扣，未知先對帳 |

`stack-instructions`／`stack-instruction-state` HTTP 路由已移除（404）；持有人不能覆寫創作者排程。舊 revision 仍供歷史稽核。

cash 讀同一區塊的 USDT，顯示未分類與短缺，不憑 balance 差造 lot。所有 raw 為 USDT 原生 18 decimals 字串；token received／fee 向量用該 token 自己 decimals。ID／block 等大整數用字串。

### 本金與合單

核准來源為 chain 97 本人請求的每日 `faucet_claim` 與首次買入的 `welcome_grant`。每日領取仍是一鍵 `POST /faucet/usdt {account}`，預設 1,000／owner／UTC 日，全站每日 1,000,000。服務端核對已保存 claim 的 owner／account／金額／txHash、canonical receipt 及唯一 `Claimed`、receipt 區塊的 enrollment 與前後 block hash。普通 Transfer、捐入、利息、領回款不能成為本金，可由 owner 原樣轉出。

迎新固定 10,000（18 decimals），operator 用 manifest USDT 的 `mint`；不使用 `claimFor`，不占每日領取的額度或合約 rolling 24h 限額，同一天仍可另領每日 1,000。迎新全站每日上限預設 5,000,000（500 人），`WELCOME_USDT_SITE_DAILY_WEI` 可調，0 停止新預留、等號允許；與每日水龍頭分開。`POINTS_ENABLED` 未設或為 0 時，積分、任務、排行榜、邀請與相關 operator API 均回 503／`POINTS_DISABLED`，資料及程式保留。

APP 在已完成 enrollment 的基金買入前呼叫 `buy-funding`。有原迎新交易時先驗證／恢復原 lot，再讀鏈上現金；未有迎新且鏈上現金為 0 才自動 mint。有既存轉入款則回 `funding:"existing_cash",lot:null`，不把餘額當成本金。迎新已指派另一檔基金、終態 failed，或同基金的迎新已用盡／提空，且現金為 0 時，回 409／`DAILY_FAUCET_REQUIRED`，畫面提供每日領取；原 lot 與終生鍵保留，不再次 mint。RPC／DB 不可用回 503；缺成功證據回 409／503，不重發。

`welcome_grants` 需要 db 0033（per-asset 使用 0032／0034）。`(chain_id,owner)` 終生唯一包含 reserved／submitted／unknown／confirmed／failed，不能換基金、跨日或重啟再領；failed 只釋放原日站上額度。原日獨立日期鎖、READ COMMITTED 鎖後才讀額度；先確認 reservation commit，再準備簽名，先確認 submitted＋原 hash commit，再廣播一次。DB commit 回應未知時不廣播，重試讀原鍵；reserved 無 hash 也不推定可以再發，需營運對帳。submitted／unknown hash 會阻擋所有共用 relayer 新 nonce，直到原 portfolio 以 `buy-funding` 或明確來源 `funding-lots` 完成對帳。未知 hash 無 receipt 時保持未決，不自動重簽／重送／釋放。

迎新入帳必須核對 chain 97、manifest token、原 operator 的精確 mint calldata、零 value、receipt-time minter、成功且 canonical 的 receipt，以及唯一 `Transfer(0x0,基金帳戶,10000e18)`。grant confirmed 後才以 portfolio／cash-row 鎖原子建立明示來源的 lot 和正確現金桶。grant 已確認但 lot commit 未知時重試沿用原來源；不再 mint、不重加現金。reorg／原證據搬動會凍結 lot 與新工作，保留終生鍵和原證據待對帳。

投入全額是**本金與費用的總預算**。新 lot 按原權重一次固定逐資產預算；非現金 floor(total×bps/10000)，尾差歸 cash。hold／stack 分別進 unallocated_hold／stack_prefund，cash 立即 allocated 且完成，不再乘權重。純現金無費用、無空買單。永久鍵 `(chain,txHash,logIndex)`；重播保留原確認時間，不重加桶。重組保留原預留並停止新工作，不復活來源。

最低認購 50（含費）；現金權重不算換幣批次，因此 50% 現金至少投入 100。依實際各資產時點合單縮減該 lot 的期數，原版本 N／hash 不變。單資產 N12：50→M1、100→M2、600→M12。縮成一期的 stack 仍嚴格等確認後的下一指定點，等號等下次。

每個 lot 不獨立要求達到一整批 50：不同時點的小來源可保存一期計畫，`fundingStatus=waiting_for_merged_budget`，等同帳戶同版本同時點其他 lot 合單。這代表記帳成功，未承諾立即可成交。重播回 recorded。若目前窗口仍不達門檻就等待；過期略過、不把該期 base 補扣到下一期。

## 執行、零碎額與未知狀態

同帳戶同 slot 所有到期資產／lot 先收齊成一個 asset job，window 取來源最早截止；一次估 k×R 並分攤所有來源。保留現金不進工作。每資產合單後實際輸入 <1 則 deferred_min_asset，無預留；下期攜帶前筆未掛 job 的零碎預算。略過只保留更早的 carry，不補扣該期 base；已掛 job／未知的預留永不再次 carry。最後剩餘零碎額仍可領出。

子批同比例分各成分，實際最小輸入 1、含費總預算 50；50 投入可輸入 49.73＋R0.27。k 批預留 k×R，未使用費用回已配置現金，實際收費依 receipt，不重複收。逐來源 raw 尾差後重查全部 cap／buyAllowance。任一成分缺報價、oracle、深度或休市，整個子批等候，不跳掉資產。舊 target_weight 維持原最低步／實際名目額口徑。

股票使用 [NYSE 2026–2028 官方日曆](https://ir.theice.com/press/news-details/2025/NYSE-Group-Announces-2026-2027-and-2028-Holiday-and-Early-Closings-Calendar/default.aspx) 與 America/New_York DST，開盤含等號、收盤不含；未知年份不買股票。加密資產無股票日曆限制。跨基金共用每鏈保守 DEX 隊列：未知 operation 持久占位，成交後等下一區塊再取新報價。

所有 gates 後以即時 clock 驗 `[slot,window_end)`，同交易寫 actual start、batch、operation payload／nonce／deadline；commit 成功才簽名廣播。receipt 成功需交易狀態、UserOp success、預期 swap／費用事件及實際 token transfers 全部吻合；operation、batch、remaining 向量、來源終態、cash buckets 同 commit。

來源不足記 skipped_insufficient_funds，跨期停機記 skipped_window，在途跨期記 skipped_previous_inflight；GET slices 提供持久原因供畫面通知。補款不追扣。確定失敗按 1／5／30 分鐘退避，連續 3 次暫停原 job；gas 額度不足不算交易失敗。本人暫停可釋放尚未開始的預留，已送未知先對帳；剩餘向量不消失。

hashless 或 receipt 查無的 typed 操作保持未決：nonce 前進與 deadline 過期不能證明**過去沒有成交**，不能釋放重送。同一帳戶只一個未決 attempt。DB commit 回應遺失與重啟都回原鍵對帳；無法取得原成交證據時需營運對帳，不能用新鍵避開。
