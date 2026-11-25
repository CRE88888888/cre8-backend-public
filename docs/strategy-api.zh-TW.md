# 逐資產策略 API、投入與排程契約

對應 backend#82／#83／#92／#96／#118、db 0031／0032／0034／0038／0043，以及 [測試網參數總表](https://github.com/CRE8Finance/docs/blob/main/docs/TESTNET_PARAMETERS.zh-TW.md)。schema 2 每批 10 USDT 是**含費總預算**；每資產實際輸入至少 1 USDT，最後一期正數餘額例外。只在 chain 97 開新錢自動化；主網舊 target_weight 行為保留。chain 97 版本不設資產數上限，chain 56 最終含 USDT 最多 16 個；單筆 UserOp 最多 16 步，依持有數縮小並驗總 gas ≤14M。保留完整原投入向量，僅按 confirmed 子批扣減；已配置現金與費用尾款不重算為新本金。

## 發版

`POST /strategies` 與 `POST /strategies/:id/versions` 僅限平台營運錢包：先驗 bearer session
（未登入／無效 token 回 401），再以 `OPERATOR_WALLETS` 比對 session 錢包（不分大小寫），一般登入用戶回
403 `OPERATOR_ONLY`。白名單未設或空白時拒絕所有人；任一項格式錯誤時回 503 `INVALID_OPERATOR_WALLETS`，
不部分放行。授權先於限流及 body 校驗；不受 `ENABLE_OPERATOR_REBALANCE` 影響。
發版仍要求 session 錢包是基金原 provider，營運錢包也不能替其他 provider 發版（403 `FORBIDDEN`）。

`POST /strategies` 建立 metadata。`POST /strategies/:id/versions` 接受：

```json
{
  "chainId": 97,
  "allocation": {"assets": [
    {"address": "0xb9bb138ebe73b16d6b8134724e43cd02d8db395a", "weightBps": 5000},
    {"address": "0x383bd2556f60c04edd1ede4f5a0874da3398f72a", "weightBps": 5000}
  ]},
  "execution": {
    "kind": "per_asset",
    "numeraire": "0x383bd2556f60c04edd1ede4f5a0874da3398f72a",
    "rebalance": "none",
    "assets": [
      {"asset": "0xb9bb138ebe73b16d6b8134724e43cd02d8db395a", "weightBps": 5000,
       "execution": {"kind": "stack", "every": "weekly", "weekday": 1, "timeUtc": "01:00", "slices": 12}, "yield": null},
      {"asset": "0x383bd2556f60c04edd1ede4f5a0874da3398f72a", "weightBps": 5000, "yield": null}
    ]
  },
  "schedule": {"kind": "funding"},
  "idleYield": {"enabled": false}
}
```

地址須符合該鏈 manifest；以上為 profile 範例，部署時以 manifest 為準。allocation 與 execution 必須完整對應、bps 總和 10000。USDT 項**不能有 execution**；其餘每項是 hold 或完整 stack。省略 execution 時明示展開各資產 hold；省略資產模式、yield、rebalance 分別明示套用 hold、null、none，再雜湊。省略 schedule／idleYield 補 funding／disabled。舊 bare `{kind:hold|stack}` 新發版拒絕；未支援功能、多餘欄位及個人金額不能默默丟棄。

上述 schema 2 發版只開放 chain 97。chain 56 HTTP 沿用 interval／cron 的 schema 0 發版，拒絕 execution／idleYield／funding，不會自動轉成 per_asset；顯式 chainId 必須符合 API 部署鏈。

stack 由創作者指定 daily／weekly、UTC 整分時刻、實際原設定 daily 2–365 期、weekly 2–52 期；每天超過 52 期需先套用 db migration 0043。daily 的 weekday 為 null；weekly 為 0–6（週日為 0）。UI 先展示創作者當地預設每週一 09:00、12 期，再換成 UTC 送入；API 不猜時區。固定 UTC 後跨 DST 的當地時刻可能改變。買的人只決定投入總額。

rebalance 僅全非現金資產皆 hold 可選 none／monthly／drift；預設 none。drift 是任一資產偏離目標**超過 500 bps**，等於不觸發；monthly 跨 UTC 月後才再執行。再平衡沿用既有 target_weight quote／refresh／operation／gas 管線。尚有新錢未配置或在途時先處理原工作；再平衡的 USDT 實收付與 operation 同交易更新 allocated_cash，避免再次分類或虛假現金短缺。

yield 可為 null 或 `{market:"平台市場ID"}`；發新版本時須查 `strategy_asset_yield_markets` 同鏈／資產 enabled。初始無市場。市場退休不重寫舊 hash；本張僅保存設定，生息存領由 BE-3／BE-4 接入。

## Canonical config

schema 2 外層固定鍵順序：domain、schemaVersion、chainId、execution、allocation、schedule、idleYield、activeAt。domain 為 `cre8.strategy.execution`；UTF-8 JSON、無空白／換行；activeAt 為整秒 Unix 十進位字串。execution 固定 kind、numeraire、rebalance、assets，各資產固定 asset、weightBps、execution（非現金）、yield；stack 固定 kind、every、weekday、timeUtc、slices。兩組 assets 都按小寫地址排序；展示 symbol 不參與 hash。

`configHash=keccak256(UTF8(canonical))`，交既有 `Version.scheduleHash`，不改合約驗證或 ABI。[schema 2 goldens](../test/fixtures/strategy-config-v2-golden.json) 以 Python JSON＋`cast keccak` 獨立產生。schema 1 舊 canonical 與 [goldens](../test/fixtures/strategy-config-golden.json) 保留；舊 stack 指令與工作只允許歷史讀取／未知結果對帳，不能新增。

enroll、投入及執行均核對 pinned 版本、chain、allocation、scheduleHash、生效時間；不使用 latest 取代 pinned。新版本不能改舊設定。相同 publish 重試保留原版本與原 activeAt；未知 mirror 不重送 publish。DB 或 RPC 不完整回 503，衝突回 409。schema 0 target_weight 與內部舊 writer 保留。

## 入金期數預覽（#118）

`POST /strategies/preview-contribution` 不需登入，body 為 `{chainId, execution, amountRaw}`。execution 與發布版本使用相同 schema／純驗證（含完整 cash 項），目前同發布介面只接受 chain 97 的 schema 2。amountRaw 為 uint256 十進位整數字串，預覽上限 **10,000,000 USDT（10^25 raw，含等號）**；實際入帳不受這個預覽上限限制。使用既有 auth IP 每分鐘限流，會先限流再解析 body；計算不讀寫 DB、不呼叫 RPC、不簽名。

計算在 worker 執行，不占用 HTTP 主執行緒。同一 API 程序全站共用最多 **2** 個計算、最多 **4** 個排隊；超額立即回 429／RATE_LIMITED，`Retry-After: 1`。每次計算（含 worker 啟動）預算 **1 秒**，超時終止 worker 並回 503／PREVIEW_TIMEOUT，停止後才釋放計算名額；排隊時間另計，最多等待前面兩輪計算。沒有閒置 worker 常駐。多 API 實例各自維持同一限制。

回 `{minimumRaw, effectiveSlices: {[asset]: n}, slots: [{at, budgetRaw}]}`，raw 為 18 decimals。`at` 是 UTC ISO；至多回前三個合併時點與最後一個（少於四期全回、無重複），budgetRaw 是該時點各非現金資產的含費原預算，非現金 dust 仍按既有規則 defer。confirmedAt 取伺服器現在；實際入帳取 canonical receipt 時間，時點相同時兩者期數相同。無換幣的純現金回空 slots／effectiveSlices。

預覽沒有帳戶／策略 ID，不能讀取已付最低費的帳戶窗口，因此預覽與實際入帳的**期數證書**統一保守預留 0.30 USDT 上界，chain 97 同樣使用每窗口一次 reserve 的算法。真實入帳仍查驗鏈上費用預留，超過此上界回 503／MIN_FEE_UNAVAILABLE。執行、合約最低費與 feeWindow 帳務仍以原即時 RPC／收據為準；期數證書不預留或扣款。其餘發布所需 enabled 生息市場檢查仍在發布時查 DB，本端點僅驗證 yield 欄位格式。

低於 minimum 回 422／BELOW_MINIMUM_ALLOCATION；超過預覽上限回 422／PREVIEW_AMOUNT_TOO_LARGE；無可行完整批次回 422／BELOW_MIN_BATCH；格式錯誤 400、限流或佇列滿 429（Retry-After）、限流儲存失敗 503。計算逾時回 503／PREVIEW_TIMEOUT，worker 啟動或執行失敗回 503／PREVIEW_UNAVAILABLE，不回傳內部例外細節。無法獨立規劃的實際產品入帳仍沿用 waiting_for_merged_budget，等待同時點其他來源，預覽不承諾此類合單。

規劃縮減次數至多「非現金資產數 ×365」，每次日曆至多同樣數量的槽位；容量分批先檢查單批是否可容納，僅在需要分批時使用 bigint 對數搜尋，預覽與實際入帳共用相同演算法及結果判定。缺期記錄每資產最多 daily 365／weekly 52，prefund 的下一期本金與費用預留支援同一上限。

## 個人端點

全部沿用 bearer 本人認證、portfolio 與 smart account owner 比對、跨程序帳戶鎖及短 READ COMMITTED cash-row 鎖。RPC 不在記帳交易內。忙碌 409、DB／commit 未知 503，重試同一來源即可。

| 端點 | 契約 |
| --- | --- |
| GET `/portfolios/:id/execution` | pinned config/hash、enabled、automation、建議投入、cash／balances、最近 100 lots／jobs、lotAssets 與 slices 執行狀態 |
| POST `/portfolios/:id/buy-funding` | 首次買入先呼叫，body `{}`；chain 97 無 USDT 且未有迎新時自動發 10,000 並建 lot。回 `{state:"ready",funding,lot}`（200）或 `{state:"pending",grantId,txHash,lot:null,funding:"welcome_grant"}`（202）；pending 只重試同一請求，不可當成已投入 |
| POST `/portfolios/:id/funding-lots` | `{source:{kind:"faucet_claim",claimId:"123"}}` 或 `{source:{kind:"welcome_grant",grantId:"123"}}`；回永久事件、effectiveSlices、confirmedAt、fundingStatus、replayed |
| POST `/portfolios/:id/execution-state` | `{enabled:false}` 暫停新買入；true 恢復；漏期不追扣，未知先對帳 |

「全部賣出」（`/close`）成功後組合是暫停的。之後本人再放錢進來（`funding-lots`／`buy-funding` 建出新的 lot、或定投存入確認），帳戶鏈上只剩 USDT（其他資產含抵押中與生息中合計不到 0.01 USDT）時自動恢復，不必再呼叫 `/rebalance`；帳戶還有資產的暫停組合（例如用 `execution-state` 暫停的）、已退出／刪除中的自建組合、重送同一個來源、定投領出的那一筆都不會恢復（`src/sell-all-resume.ts`）。

「全部賣出」的要求會留在後端（`src/sell-all-intent.ts`，2026-11-25 testnet portfolio 33）：`/close` 在第一輪之前把要求記成一列（`user_notifications`，kind `sell_all_requested`，`pending`＝還在賣、`delivered`＝賣完、`failed`＝本人中途又放錢進來）。呼叫端還在一批一批呼叫 `/close` 時排程器不插手（每次呼叫把下一輪排到 90 秒後，免得鎖住組合讓下一批回 `[PORTFOLIO_LOCK_BUSY]`）；呼叫端斷線、逾時、沒有再呼叫滿 90 秒後，排程器每一輪看到這一列就只做賣出（與 `/close` 同一份計畫與管線），不做再平衡、不買新入金或定投、不重新開加息；`/close` 第一批成交後組合就是暫停的，有這一列的暫停組合照樣會被認領。某一輪看到帳戶只剩現金（其他資產合計不到 0.01 USDT，或剩下的不到 1 USDT 且執行器地板為 0）就結束這一列，組合維持暫停，等本人把 USDT 領回。再呼叫 `/close` 只是接續，不會重複賣；回應多一個 `sellAllPending`（true＝後端會自己做完）。本人再買（`/rebalance`）、新的入金 lot、定投存入確認、`execution-state` 都會結束這一列並照常管理。送出連續失敗 5 次後依 5 分鐘、15 分鐘、1 小時、6 小時拉長間隔（從 `operations` 算，重啟不歸零）；沒送出的輪次（休市、沒有報價、抵押品還取不回）每輪重試不計次；超過 `ALERT_STUCK_HOURS`（預設 6 小時）還沒賣完進 `portfolio_stuck` 告警（休市等待是 warn，其餘 critical）。沒有現金帳列的舊式組合、自己在退出／刪除的自建組合不記這一列，行為同以前。

`stack-instructions`／`stack-instruction-state` HTTP 路由已移除（404）；持有人不能覆寫創作者排程。舊 revision 仍供歷史稽核。

cash 讀同一區塊的 USDT，顯示未分類與短缺，不憑 balance 差造 lot。所有 raw 為 USDT 原生 18 decimals 字串；token received／fee 向量用該 token 自己 decimals。ID／block 等大整數用字串。

### 本金與合單

核准來源為 chain 97 本人請求的每日 `faucet_claim` 與首次買入的 `welcome_grant`。每日領取仍是一鍵 `POST /faucet/usdt {account}`，預設 1,000／owner／UTC 日，全站每日 1,000,000。服務端核對已保存 claim 的 owner／account／金額／txHash、canonical receipt 及唯一 `Claimed`、receipt 區塊的 enrollment 與前後 block hash。普通 Transfer、捐入、利息、領回款不能成為本金，可由 owner 原樣轉出。

迎新固定 10,000（18 decimals），operator 用 manifest USDT 的 `mint`；不使用 `claimFor`，不占每日領取的額度或合約 rolling 24h 限額，同一天仍可另領每日 1,000。迎新全站每日上限預設 5,000,000（500 人），`WELCOME_USDT_SITE_DAILY_WEI` 可調，0 停止新預留、等號允許；與每日水龍頭分開。`POINTS_ENABLED` 未設或為 0 時，積分、任務、排行榜、邀請與相關 operator API 均回 503／`POINTS_DISABLED`，資料及程式保留。

APP 在已完成 enrollment 的基金買入前呼叫 `buy-funding`。有原迎新交易時先驗證／恢復原 lot，再讀鏈上現金；未有迎新且鏈上現金為 0 才自動 mint。有既存轉入款則回 `funding:"existing_cash",lot:null`，不把餘額當成本金。迎新已指派另一檔基金、終態 failed，或同基金的迎新已用盡／提空，且現金為 0 時，回 409／`DAILY_FAUCET_REQUIRED`，畫面提供每日領取；原 lot 與終生鍵保留，不再次 mint。RPC／DB 不可用回 503；缺成功證據回 409／503，不重發。

`welcome_grants` 需要 db 0033（per-asset 使用 0032／0034）。`(chain_id,owner)` 終生唯一包含 reserved／submitted／unknown／confirmed／failed，不能換基金、跨日或重啟再領；failed 只釋放原日站上額度。原日獨立日期鎖、READ COMMITTED 鎖後才讀額度；先確認 reservation commit，再準備簽名，先確認 submitted＋原 hash commit，再廣播一次。DB commit 回應未知時不廣播，重試讀原鍵；reserved 無 hash 也不推定可以再發，需營運對帳。submitted／unknown hash 會阻擋所有共用 relayer 新 nonce，直到原 portfolio 以 `buy-funding` 或明確來源 `funding-lots` 完成對帳。未知 hash 無 receipt 時保持未決，不自動重簽／重送／釋放。

迎新入帳必須核對 chain 97、manifest token、原 operator 的精確 mint calldata、零 value、receipt-time minter、成功且 canonical 的 receipt，以及唯一 `Transfer(0x0,基金帳戶,10000e18)`。grant confirmed 後才以 portfolio／cash-row 鎖原子建立明示來源的 lot 和正確現金桶。grant 已確認但 lot commit 未知時重試沿用原來源；不再 mint、不重加現金。reorg／原證據搬動會凍結 lot 與新工作，保留終生鍵和原證據待對帳。

投入全額是**本金與費用的總預算**。新 lot 按原權重一次固定逐資產預算；非現金 floor(total×bps/10000)，尾差歸 cash。hold／stack 分別進 unallocated_hold／stack_prefund，cash 立即 allocated 且完成，不再乘權重。純現金無費用、無空買單。永久鍵 `(chain,txHash,logIndex)`；重播保留原確認時間，不重加桶。重組保留原預留並停止新工作，不復活來源。

最低認購為 `max(50, ceil(10 / (1 − w0)))` USDT（整 USDT 向上取整，w0 為現金比例）；純現金仍為 50。50% 現金最低 50，90% 最低 100，99% 最低 1,000。不因最小資產權重另外提高最低認購，0.5% 權重的 50 投入可在最後一期併入零碎額。來源日曆使用驗證過的 canonical block 確認時間，API 延遲不改首期期次。依實際各資產時點合單縮減該 lot 的期數，原版本 N／hash 不變。單資產 N12：50→M5、100→M10、120→M12。縮成一期的 stack 仍嚴格等確認後的下一指定點，等號等下次。

每個 lot 不獨立要求達到一整批 10：不同時點的小來源可保存一期計畫，`fundingStatus=waiting_for_merged_budget`，等同帳戶同版本同時點其他 lot 合單。這代表記帳成功，未承諾立即可成交。重播回 recorded。若目前窗口仍不達門檻就等待；過期略過、不把該期 base 補扣到下一期。

## 執行、零碎額與未知狀態

同帳戶同 slot 所有到期資產／lot 先收齊成一個 asset job，window 取來源最早截止；一次估 k×R 並分攤所有來源。保留現金不進工作。非終期資產合單後實際輸入 <1 則 deferred_min_asset，無預留；下期攜帶前筆未掛 job 的零碎預算。最後一期（含 hold 唯一期）將正數餘額一起買入，豁免單資產 1 USDT，整批仍須含費 ≥10。略過只保留更早的 carry，不補扣該期 base；已掛 job／未知的預留永不再次 carry。既有已落終態 dust 不回補，只能提領退出。

子批同比例分各成分，實際最小輸入 1、含費總預算 10；10 預算可輸入 9.73＋R0.27。k 批預留 k×R，未使用費用回已配置現金，實際收費依 receipt，不重複收。逐來源 raw 尾差後重查全部 cap／buyAllowance。任一成分缺報價、oracle、深度或休市，整個子批等候，不跳掉資產。全 hold 再平衡也使用每資產 1／含費 50，賣出以同塊 oracle 名義額計算；新投入及部分成交不標記 monthly 完成，重啟續作到全數完成才記當月。legacy 最低步預設改為 1 USDT，仍保留原本環境變數覆寫與名義額口徑。

股票使用 [NYSE 2026–2028 官方日曆](https://ir.theice.com/press/news-details/2025/NYSE-Group-Announces-2026-2027-and-2028-Holiday-and-Early-Closings-Calendar/default.aspx) 與 America/New_York DST，開盤含等號、收盤不含；未知年份不買股票。加密資產無股票日曆限制。跨基金共用每鏈保守 DEX 隊列：未知 operation 持久占位，成交後等下一區塊再取新報價。

所有 gates 後以即時 clock 驗 `[slot,window_end)`，同交易寫 actual start、batch、operation payload／nonce／deadline；commit 成功才簽名廣播。receipt 成功需交易狀態、UserOp success、預期 swap／費用事件及實際 token transfers 全部吻合；operation、batch、remaining 向量、來源終態、cash buckets 同 commit。

來源不足記 skipped_insufficient_funds，並在同一交易寫入 user_notifications 的 pending 事件；跨期停機記 skipped_window，在途跨期記 skipped_previous_inflight。補款不追扣。確定失敗按 1／5／30 分鐘退避，連續 3 次暫停原 job；gas 額度不足不算交易失敗。本人暫停可釋放尚未開始的預留，已送未知先對帳；剩餘向量不消失。

hashless 或 receipt 查無的 typed 操作保持未決：nonce 前進與 deadline 過期不能證明**過去沒有成交**，不能釋放重送。同一帳戶只一個未決 attempt。DB commit 回應遺失與重啟都回原鍵對帳；無法取得原成交證據時需營運對帳，不能用新鍵避開。


## 不足跳期通知事件（db 0038）

在 portfolio／cash-row 鎖內，先保存 skipped slice，再使用同一 client／交易寫 `stack_slot_skipped_insufficient_funds`。收件人取對應 smart account 的 owner 快照；永久鍵為 `(chain_id,kind,lot_id:小寫asset:零起算slice_index)`，包含 delivered／failed 終態。重試先讀來源期次，不重插 terminal slice；通知衝突以獨立 statement 讀回並核對不可變欄位，不覆寫 payload 或重設 state。任一步失敗皆回滾；未知 commit 重連後查原來源／事件。

payload 僅含 `budgetRaw`（該來源當期含 carry 的 raw 整數字串）、`slotAt`、`windowEndAt`（UTC ISO 時間）。不接受外部任意欄位，不包含憑證、原始 RPC／DB 錯誤。可負擔、休市、暫停、過期或在途跳期不建立此通知。

此介面將已 commit 的 pending 事件交給後續通知流程；本修正不新增渠道、不呼叫營運 Telegram、不回填歷史 skipped，也不宣告已外部送達。consumer 須以永久通知 ID 去重／對帳，外部發送在交易外；只有確認結果才條件更新 pending → delivered／failed，暫時或未知結果保持 pending。DB 去重不代表外部投遞 exactly-once。
