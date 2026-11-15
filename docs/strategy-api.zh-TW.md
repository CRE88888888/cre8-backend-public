# BE-1 策略 API 與投入／個人指令契約

對應 backend#82、db migration 0031，以及 C3 的 [G0](https://github.com/CRE8Finance/docs/pull/57#issuecomment-6891241586)／[投入來源決定](https://github.com/CRE8Finance/cre8-backend/issues/82#issuecomment-6891564697)。本文是 APP-1／BE-2 的實作契約；BE-1 不送出 hold／stack 買單，`automation` 回 `awaiting_be2`。生息仍關閉。

## 發版與舊格式

`POST /strategies` 仍只建立 metadata；設定放在 `POST /strategies/:id/versions`：

```json
{
  "chainId": 97,
  "allocation": {"assets": [
    {"address": "0x6de69565f250146c67d56be5aa15b6f181fce4d7", "weightBps": 5000},
    {"address": "0xbd7d814e02c9f69af391a8ba4c1787769f2ddd4b", "weightBps": 5000}
  ]},
  "execution": {"kind": "stack"},
  "schedule": {"kind": "funding"},
  "idleYield": {"enabled": false}
}
```

省略 execution 明示補 `{kind:hold}`；schedule 補 `{kind:funding}`；idleYield 補 `{enabled:false}`，三者都存回／回傳。chainId 預設本 API 的 chain，提供時必須完全相同。funding 表示依投入／個人期次觸發，**不是扣款週期或漂移檢查間隔**。舊 scheduler 不認此標記，會 blocked，直到 BE-2 接入；依賴同一scheduler的redeem／close也會blocked，owner直接原樣token轉出仍可；不能把 interval／cron 塞進 typed 版本啟用舊 planner。

額外欄位（含逐資產 play、reinvest、stopLoss、個人金額）、混合／custom／dips／range／trend／lp／carry、target_weight 新 HTTP 發版、生息啟用均回 400。stack 拒絕純 USDT；hold 可純 USDT。allocation 維持最多16項、bps總和10000、chain97白名單及自動補0權重USDT。不改已發布的設定；發新版本也不替既有 enrollment 升版。

讀回新增 `executionSchemaVersion`、`execution`、`executionChainId`、`configHash`、`idleYield`。0031以前的列回 schema0、`{kind:target_weight}`、chain/hash皆null，不捏造舊hash。內部未帶typed欄位的舊 `publishVersion` 呼叫保留原interval／cron編碼，供既有腳本與舊策略測試使用；HTTP一律走typed預設，不以省略欄位降級。

`activeAt` 須為含時區、整秒的RFC3339；省略為第一次發版時的UTC整秒。同設定重試讀回原版本／原activeAt；不覆寫原欄位。先檢查簽名設定並取得relayer admission，再保存不可變設定，成功mirror才回成功；有onchainId但RPC／mirror失敗回503。未知提交的重試只核對原鏈上版本，**不再送新的publish交易**；尚未入塊回 `VERSION_PENDING_RECONCILIATION`。完全未送出但已有DB列，也保持待對帳，由營運核對後修復，不自行刪列或跨過版本序號。onchainId為null的離線策略只保存設定，不能enroll或投入。

## Canonical config v1

檔案 `src/strategy-execution.ts` 與可共享的 [golden vectors](../test/fixtures/strategy-config-golden.json) 定義格式。golden 的JSON以Python產生、hash以Foundry `cast keccak`獨立計算；測試另核對既有publishVersion Solidity ABI的bytes32欄位。

固定鍵順序、UTF-8、無空白、無尾端換行：

```text
{"domain":"cre8.strategy.execution","schemaVersion":1,"chainId":97,"execution":{"kind":"stack"},"allocation":{"assets":[{"address":"0x6de69565f250146c67d56be5aa15b6f181fce4d7","weightBps":5000},{"address":"0xbd7d814e02c9f69af391a8ba4c1787769f2ddd4b","weightBps":5000}]},"schedule":{"kind":"funding"},"idleYield":{"enabled":false},"activeAt":"1794700800"}
```

地址小寫、按地址字典序排序，保留自動USDT列；只承諾address／weightBps，不含展示symbol。chainId／bps是JSON整數，activeAt是Unix秒的十進位字串。`configHash=keccak256(UTF8(canonical))`，直接放入既有 `Version.scheduleHash`，不改合約ABI。個人金額／週期／起訖不屬創作者設定，不放進此hash。

enroll前核對選定版本，enroll後核對真正pinned版本；投入／啟用個人指令再核對DB config hash、chain、鏈上同一區塊的allocation／scheduleHash／activeAt／enrollment。`block.timestamp == activeAt`可；未生效版本拒絕，不用最新DB版本替代pinned。RPC／缺資料回503，設定或版本衝突回409。暫停／停止只需本人與已存設定核驗，RPC不可用也能停止未來授權。

## 個人端點

以下全部要求原有bearer session；portfolio.user與smart account.owner都須是本人，創作者不能指定別人的portfolio。沿用portfolio advisory lock與0031的cash-row鎖順序。寫入以短READ COMMITTED交易提交，RPC不放在DB交易中；忙碌回409，DB／lock timeout／未知commit回503，原請求可重試。

| Method／路徑 | body／回應 |
| --- | --- |
| GET `/portfolios/:id/execution` | pinned execution/hash、enabled、automation、建議金額、現金分類、最近100筆lot與revision |
| POST `/portfolios/:id/funding-lots` | `{source:{kind:"faucet_claim",claimId:"123"}}`；回lot永久事件身分、source及replayed |
| POST `/portfolios/:id/stack-instructions` | 下方新revision；回保存的完整個人指令 |
| POST `/portfolios/:id/stack-instruction-state` | `{revision:"1",state:"paused"}`或`stopped`；不能傳active恢復 |
| POST `/portfolios/:id/execution-state` | hold專用 `{enabled:false}`暫停新買入，true恢復；不阻擋owner原樣領出 |

`GET execution` 的 `balances` 是0031分類帳，沒有列時為null。`cash`是同區塊實讀USDT（含區塊hash／number）：`unclassifiedRaw=鏈上現金−已分類本金／預留／現金／收益`，只顯示、不憑此造lot；若為負則unclassifiedRaw=null、deficitRaw為短缺量，需對帳。RPC失敗回503，不把未知餘額回0。新增的lot.id／claimId／revision／slotIndex／blockNumber與所有raw均為十進位字串；portfolioId／strategyId／version沿用既有number。

### 投入來源

目前唯一核准來源為**chain97本人請求的faucet claim**。後端從faucet_claims讀原owner、account、amount、已保存txHash（submitted／unknown／confirmed），再核對TestnetUSDT成功receipt、canonical區塊、該receipt區塊的enrollment／版本／activeAt及前後區塊hash、唯一且未removed的`Claimed(to,amount,by)`，收款方須為該基金帳戶、by須為核准operator。client不能自報本金、receipt、區塊或普通Transfer。

lot保存實轉全額（包含之後配置本金及費用備款）；hold只加unallocated_hold_raw，stack只加stack_prefund_raw，不在備款時買入。永久鍵 `(chain,txHash,logIndex)`；同一交易內插入、重讀比較完整來源、新lot才加桶。重播／重啟／未知commit不重加；成功證據亦透過原UTC-day lock／CAS將submitted／unknown faucet claim確認，保留配額並解除該來源對relayer的阻擋；receipt重組或同一claim的事件移動時，舊lot標reorged、保留原桶與工作供對帳，拒絕新授權，不復活、不自動釋放。

主網56不開此來源。一般owner轉帳、第三方捐入、利息或領回款不算lot，可沿用owner原樣領出。未來現金帳戶入口新增一種 `source.kind` 與其服務端驗證／來源讀回映射；永久鏈上事件鍵和lot API不變。本批沒有把一般Transfer或balance差額當備援來源。

### Stack revision

```json
{
  "expectedRevision": "0",
  "enabled": true,
  "amountUsdt": "100",
  "periodSeconds": 604800,
  "startAt": "2027-03-13T09:00:00-05:00",
  "endAt": null,
  "fundingSource": "prefunded_fund_account"
}
```

第一次expectedRevision="0"，之後填最後revision以防覆寫別人的新確認。完全相同請求重播回原revision；修改／恢復必須新revision、新未來startAt，舊active／paused轉superseded，終態不回頭。enabled必填boolean，本人明示確認；省略amountUsdt則回傳A_min向上到分，periodSeconds預設每週604800，只另允許每日86400。fundingSource只允許prefunded_fund_account；外部錢包／銀行／自動現金扣款拒絕。

startAt要求含時區RFC3339且嚴格晚於建立時間，等號拒絕；前端先以使用者當地時區顯示下一個09:00並取得確認，再傳UTC／offset，不由server猜時區。endAt省略為null，提供時須嚴格晚於startAt；BE-2依排除式截止處理slotAt>=endAt。nextSlotAt由DB固定start+n×period生成，跨DST不改錨點；next_run_at不是期次。

金額只收正十進位字串，最多18位小數、不得超uint256；不四捨五入、不收number／指數。逐成分floor(A×bps/10000)須>=5、非現金總和>=50，A至少50；50%現金最少A=100、1%成分最少A=500，純現金不除0。API金額A不含最低費補差R；例如10bps／0.30設定下A=50需另備至多0.27。BE-2送出前仍須重讀費率、現金、allowance、容量與gas，不因保存指令就宣稱可執行。

任何種類的未決operation或舊job阻止新revision；pause／stop保留原未知attempt，不把它當成未送出或刪除。BE-2負責取消未送子批、釋放已證實可釋放的剩餘預留、略過漏期及後續對帳；本API不建立slot／job／買單，也不追扣過去期次。
