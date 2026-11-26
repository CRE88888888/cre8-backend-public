# BE-112：部署前生息審查修正

範圍為 backend#112 與指定審查報告的 11 項。backend 基底 `f60e364`；DB 的 0041 由 X2 在
[db#49](https://github.com/CRE88888888/db/pull/49) 完成並合併，本 PR 不修改 migration。

## 逐項處理

| 項目 | 修正與回歸 |
| --- | --- |
| 1. 自動全退後再存 | 合法新 supply 的 prepare，以及成功 supply 結算，同交易把零部位的 completed 轉 none。回歸完整存入→風險退出→零→恢復→再存→結算／重播；prepare 回滾保留 completed 與現金。 |
| 2. unknown 壟斷名額 | recovery、owner 退出、持倉風險、新供給各有獨立 limit；持久游標在嘗試帳戶鎖前前進，unknown／失敗／鎖忙也輪轉。預設每類 20，整輪最多 80 個帳戶。21 個 unknown、20 個 owner exit 與 risk 三輪（第三輪新程序）皆可輪到；原 unknown 與預留不變。 |
| 3. rate 上跳誤退出 | supplyOpen 需要供給 refreshHealth 成功；退出健康度另在同一 eth_call 先做 lenient quoteWithdraw 補息，再讀 health／rateCheckpoint／目前換算率。只有上跳不產生 unknown 風險；下跌、讀值失敗與 U=9000 仍退出。三協議皆覆蓋，Aave 先將 ray 換成 checkpoint 的 WAD 單位比較。 |
| 4. 空市場退出 | 成功且唯一的 exit event、已停 policy，加同一新鮮 canonical observation 的零 receipt／observed／tracked 證據，可以接受 exiting=false。空市場、持倉混合退出及重播皆覆蓋；非零、缺資料、過期或重新啟用 policy 仍拒絕。 |
| 5. 舊有效 session fallback | 逐把核對 owner 綁定的完整生息 policy、有效時間、permission signer／三層 policies、validation hook、有效 nonce 與 execute selector。未安裝、撤銷 selector、清掉 validation 或 nonce 失效會改選舊有效 key。只有 prepare 開始前的明確授權拒絕可 fallback；GasPolicy 剩餘 allowance=0 也排除；估 gas 失敗後、prepare 前重新驗證為確定失效才換 key。RPC／unknown／prepare 後拒絕不換 key。 |
| 6. 退出代付濫用 | 授予豁免前驗新鮮收據與 tracked units、當前 EntryPoint nonce，以及精確完整 Kernel calldata 預演；重複市場累加 shares 不得超過持倉。未對帳 exit gas 預留跨 UTC 日／paymaster 輪替保持阻擋；expiry 需 finalized 未消耗 nonce 證據才解除，完整 live hash 重試只重用原授權。chain/account 鎖不含日期；站台成本永不退款。普通／setup 未廣播請求不阻擋合法退出。 |
| 7. 過期 key 誤報 ok | DB expires_at 與鏈／牆鐘有效時間共同過濾；status 與實際執行共用 availability。0、剛好到期、前一秒、未到期、缺區塊資料與 canonical hash 改變都有回歸。 |
| 8. 首筆失敗無紀錄 | yield round 記 portfolioId 與固定安全 code，scheduler 保存 checked／blocked 統計。無 receipt／action 的第一筆 quote 失敗也有紀錄；不輸出 RPC 原文、連線資訊或 UserOp。 |
| 9. minimum 文件 | 現行規格為 floor(quote×9995/10000)，結果必須大於 0；quote 0／1 拒送。舊固定 timestamp 驗收明標歷史，由 #110 跨區塊驗收取代。 |
| 10. APR=null 文件 | 更正為前端接受 null 並顯示「—」，而非丟掉市場。 |
| 11. Aave rebase／reorg | 沿用原事件更新方式，整合 0041。先結算、正常 rebase，再遇 reorg，永久 tombstone 可以提交；重播不得復活，現金與既有債權保留，後續 tick 阻擋。 |

## 代付消耗證據與保守邊界

退出豁免沿用既有 ordinary／exit gas ledger。新的授權不能用到期、換 deadline／minimum 或新
executionKey，消除尚未對帳的 exit 預留。檢查在插入本次預留之前，且處於既有 site/day 與新增
chain/account 互斥鎖內；同一份 live 授權重試仍是冪等。ordinary 的 60 次／gas 限制用盡後，
真正退出仍可豁免；站台 gas／wei 與 deposit 上限保留。

若原授權已成交但 gas ledger 尚未更新，唯讀回溯最多 1024 個區塊取得 EntryPoint 事件，核對
canonical block、tx、成功外層 receipt 與原始 event；解 handleOps／handleAggregatedOps，重算
原 packed UserOp hash，再由該筆原 nonce／initCode／calldata 計算 executionKey。只有完全相符
才將原 sponsorship 與 gas ledger 標為已消耗，所有成本仍留帳；不修改 action／operation 的
unknown，也不據此做本金或利息結算。inner revert 也消耗 nonce，但保留失敗 gas 成本。

### 複審四項修正與持久化（C3 定案）

1. 新授權先保存 chain/account、hash、executionKey、nonce、validUntil、purpose；不保存任何簽章／金鑰。
   自動解除要求 `finalized` 區塊的 timestamp **嚴格大於** validUntil，該 nonce key 的 EntryPoint
   nonce **仍等於原 nonce**，且回讀同區塊 hash 相符。EntryPoint v0.7 在等於 validUntil 時仍可接受，
   所以等號不解除。RPC／finalized 不支援／證據缺漏均保留鎖。已消耗者仍先走前述 receipt 對帳。
   **2026-11-26 修訂（nonce 已改變）：** 原本「nonce 已改變」一律保留鎖，靠 receipt 對帳解除。但 receipt 回溯只有
   1024 個區塊（每塊 0.45 秒，不到 8 分鐘），而 owner 自己送的退出（全部領回錢包的 USDT 轉帳算 exit）沒有人替它
   對帳，預留永遠停在 `reserved`。超過 8 分鐘後同一帳戶的下一筆退出（例如定投每期領出）就永遠被
   `PAYMASTER_EXIT_AUTHORIZATION_PENDING` 擋住：receipt 找不到，nonce 又已經變了。portfolio 50 在 01:31 領回，
   01:53 起的定投因此買不了。現在 `finalized` 區塊上該 nonce key 的 EntryPoint nonce **已超過**原 nonce 時也解除
   （不必等到期）：nonce 只會往上，原授權不可能再被 EntryPoint 接受。解除證據寫 `reason:"finalized_nonce_consumed"`
   與當時的 nonce；**不算「未使用」**（`unusedExitUsage` 的每日三次與 10% 未使用額度只數
   `expired_finalized_nonce_unchanged`），成本照樣留帳。receipt 對帳先套用，找得到 receipt 的仍照成功／失敗記。
   代價：這種解除不知道原授權是成交了還是被別的操作占掉 nonce，ledger 記為 `failed`／`expired`；有人可以領一張
   退出授權不送、再用一筆一般操作占掉同一個 nonce 來換下一張，每換一張要花一筆一般操作的每日額度。
   取得證據後，在 chain/account 鎖內重讀全部仍在途授權；同 executionKey 的所有在途授權均須有證據。
   同 SQL transaction 寫入不可變解除證據、將 sponsorship 標 expired、gas lock 標 failed；原成本／UTC 日不變，
   不觸碰 yield action 的 unknown、本金或利息。相同 executionKey 再簽時重新取得 reserved 鎖。
2. 四組各有持久輪轉游標；整批選取在 DB advisory lock 下先提交游標，再嘗試 portfolio lock。
   owner exit 與 risk 分開名額。dry-run 使用另一組游標，不干擾 live。第一次沒有游標時隨機選起點；
   已有但損壞或不可寫時停止該輪，不把錯誤當成新游標。
3. availability 與 API status 共用同一新鮮區塊的 `gasPolicyConfig(permissionId,account)` 讀值。
   allowance=0 不可用；1 wei 不屬於「確定耗盡」，仍交實際估算。pre-prepare 估算錯誤只在重驗證明
   key 已失效時 fallback；RPC 不確定、unknown、prepare 開始後都不 fallback。
4. SDK 的 executeUserOp 前綴依 EntryPoint 重新 ABI encode 完整 packed UserOp 與最終 paymaster
   授權對應的 userOpHash。Kernel 0.3.3 在 validation 寫的 `executionHook[userOpHash]`，以 eth_call
   stateDiff 補入**鏈上原 validationConfig 的 hook**；不跳過實際 pre/post hook，也不改鏈上 storage。
   nonce 的 root／permission／validator ID 解碼沿用 Kernel 語意。一般／包裝退出均驗新鮮持倉與精確 batch。
   原始碼依據：[EntryPoint v0.7](https://github.com/eth-infinitism/account-abstraction/blob/v0.7.0/contracts/core/EntryPoint.sol)、
   [Kernel v3.3](https://github.com/zerodevapp/kernel/blob/v3.3/src/Kernel.sol)。

依 [C3 最新定案](https://github.com/CRE88888888/backend/pull/113#issuecomment-6905683386)，狀態統一存入
DB 0042 的 `yield_runtime_state`（[db#50](https://github.com/CRE88888888/db/issues/50)），backend 不修改 migration。
API、scheduler、人工指令只需共用同一個 PostgreSQL；部署前須先套用 **0001–0042**，不需要共享磁碟。

- `auth-<hash>`／`fact-…` 的 kind 為 fact；`release-<hash>` 的 kind 為 release。兩者只做 INSERT，
  `ON CONFLICT DO NOTHING` 後以 jsonb 相等核對原值；相同內容重試成功，不同內容拒絕，物件欄位順序不影響比較。
- 新授權事實與 sponsorship／gas ledger 使用同一筆 transaction；解除證據也與 expired／failed 狀態原子提交。
  DB 回滾不留事實或解除證據，避免重試撞到過往已回滾嘗試的不可變證據。歷史成本仍保留。
- `cursor-97-{dry|live}-{queue}` 用 upsert；updated_at 取原時間與 clock_timestamp 的較大值，不倒退。
  cursor value 是最後嘗試的 portfolio ID，輪轉繞回時可變小；不是時間或累進序號。
- 既有 DB advisory lock 繼續序列化授權／解除與各組游標。DB 不可用、逾時、資料損壞一律拒絕處理；
  缺授權事實不解鎖，首次缺游標才隨機起點。DB 禁止 fact／release 改刪與敏感 top-level 欄位。

先前檔案式實作的事實不會自動載入 DB。仍在途的舊授權需透過以下人工補證流程，以原始最終
UserOp 重算並驗證後寫入；未補齊時維持鎖定。本次未改 Railway／Cloudflare，也未啟用生息。

### 可稽核的人工補證／解除

舊授權只有 opaque hash，無法推回 nonce。人工指令可從原始 **最終 packed UserOp** 重算
EntryPoint hash、executionKey、有效時間與 paymaster，逐項對回兩份 DB 預留，再保存不含簽章的事實。
為了不猜 opaque hash 屬於哪筆 execution，同帳戶任何仍在途的舊 sponsorship 缺 metadata 時都不自動解除；
須在同份證據提供其原始 UserOp（包括 ordinary／setup），完成所有綁定。指令只讀鏈，仍要求 finalized
到期＋nonce 未消耗，不提供任意 force unlock 或以「沒 receipt」解鎖的選項。nonce 已消耗而缺 receipt
時，保留鎖並另行對帳；不捏造失敗／不自動釋放 unknown action。

由 operator 私下準備權限 0600 的 evidence JSON（不進 git／log）：

```json
{"account":"小寫帳戶地址","operator":"C3","reference":"PR113-or-ticket-id","userOperations":[]}
```

`userOperations` 放原始最終 packed UserOp，所有 uint 用十進位或 hex 字串；已有 metadata 時可為空陣列。
`operator`／`reference` 必填，只放稽核識別，不放任何 key、seed、token 或連線字串。環境先設定
同一個 DB 連線、chain 97 與唯讀 RPC，再執行：

```sh
bun --no-env-file scripts/reconcile-yield-exit.ts --evidence /private/path/evidence.json
```

輸出只有 `released` 數量；0 表示沒有可證明可解除的鎖，不代表授權已消耗。拒絕只輸出固定 code。
DB `yield_runtime_state` 的 `release-<userOpHash去掉0x>` 保存 reason、operator/reference、原 nonce、期限、finalized block/hash/time，
DB 保留原 gas、wei、價格、UTC 日與所有 sponsorship；原始簽章不寫入 runtime state。

## 驗證方法

新增回歸放入既有 CI 清單中的檔案，DB 回歸沿用 yield-store／paymaster 的真 Postgres 測試。
將新增回歸複製到本 worktree ignored archive，用 backend `f60e364`、db `471f191` 的
0001–0040 執行 13 項回歸，實測 **0 pass／13 fail**。0041 已合併後的 backend 舊版則是
1 pass／12 fail，通過的那項正是 DB tombstone 修正。沒有新增 skip／only、放寬型別或停用 trigger。

本機只使用 anvil 8599（chain 97、prune-history 256）、alto 3099（safe-mode）、防呆 PORT 8699
與 cre8_be112。恢復 #110 審核過的部署快照後，先核對全部 381 runtime／selector checks；
公開 RPC 僅讀取 fork 上游狀態。所有 UserOp 都送本機 anvil，公開測試助記詞只在程序內使用。

驗收使用下列指令；DB 連線只由環境提供，migration 本輪使用 `MIGRATIONS_DIR=../db-wt-50/migrations`。完整 suite 與 E2E 各自重建同一專用 DB，避免日額度互相污染。

```sh
bun install --frozen-lockfile
bun run typecheck
bun --no-env-file test --timeout=120000
# CI no-DB：逐一使用 .github/workflows/ci.yml 的 48 個檔案
CHAIN_ID=97 RPC_URL=http://127.0.0.1:8599 BUNDLER_URL=http://127.0.0.1:3099 \
PORT=8699 TEST_DATABASE_NAME=cre8_be112 ENABLE_YIELD_EXECUTION=1 \
bun --no-env-file test ./test/yield-106.fork.ts --timeout=1200000
```

第一輪 full suite 為 1506 pass／16 skip／0 fail。fork 第一輪冷快取 reader 超過原 15 秒上限，
0 pass／1 fail，當時尚未建立驗收帳戶；同預設 reader 預熱後 30/30 市場 known，沒有改產品逾時。
fork 第二輪為 1 pass／0 fail，147 個明確 assertions，三協議完整生命週期與真實 60／61 次邊界皆通過。
獨立 review 補強後的完整 suite 為 **1509 pass／16 skip／0 fail**（68 檔），CI no-DB 同清單為 **1064 pass／27 skip／0 fail**（48 檔）；三份 tsconfig 與 frozen install 通過，lockfile 未變。最終 fork 再跑為 **1 pass／0 skip／0 fail、147 個明確 assertions**；11 筆生息 action、72 筆 gas reservation 全數 confirmed，未完成退出與非零部位均為 0，還原 signer 後 381 項部署檢查全過。GitHub CI run 另列 PR。

## 複審四項修正的驗收（2026-11-16，DB 儲存改版前）

- frozen install：Checked 85 installs across 83 packages，無變更；三份 tsconfig 全過。
- 新鮮 `cre8_be112`、已合併 0001–0041、`bun --no-env-file test --timeout=120000`：
  **1515 pass／16 skip／0 fail**，68 檔。既有 opt-in 公開／其他鏈寫入測試沒跑；16 skip 未新增。
- CI 同一份 48 檔清單、明確無效 DB／fork 端點：**1067 pass／27 skip／0 fail**。
- `--test-name-pattern='#112'`、5 個重點檔：**20 pass／37 filtered out／0 fail**；filtered out 不是 skip。
- 三協議 `yield-106.fork.ts`：**1 pass／0 skip／0 fail、159 個明確 assertions**。三協議的真 GasPolicy
  餘額讀取、一般／包裝退出、部分／完整退出、計息／scaled units 及真實 60／61 邊界通過。
  **11 actions、72 gas reservations 全 confirmed**；open exits／非零部位皆 0；還原 signer 後 **381 checks 全過**。
- 修前回歸：GasPolicy／包裝退出的兩檔為 **3 pass／2 fail**；真 SQL 公平回歸 **0 pass／1 fail**；
  人工／過期對帳入口的新增回歸 **0 pass／1 fail**。修法加入前先觀察失敗，沒有新增 skip／only。
- E2E 最初使用沒有明確 localhost 的 DB URL，被既有 lane guard 拒絕（**0 pass／1 fail／1 error**）；
  改正本機連線格式後完成上述真實驗收，未改 guard。一輪跨日 fixture 尚未補正時完整 suite 為
  **1514 pass／16 skip／1 fail**；將歷史 gas fixture 設為已失敗後，才測新簽名重新上鎖，最終全綠。

本輪自我 review 另補：跨 UTC 日重簽同 executionKey 要鎖**原 gas 預留日**，以真 Postgres blocker
驗 timeout／回滾；已結算歷史授權不應再要求 RPC，故先查是否真的有 outstanding exit；測試假 hash
納入 sender，避免不同帳戶在重跑時撞同一假 hash。解除回歸亦涵蓋 finalized 等號、已消耗 nonce、
RPC／reorg、缺／壞 metadata、過期證據、交易回滾、冪等、原成本不變及人工 nonce 偽造拒絕。
跨程序公平回歸第三輪用全新 Bun 程序，unknown／失敗／鎖忙都持續前進。完整 diff、秘密輸出及範圍檢查通過。

## DB 狀態儲存續修（2026-11-16）

依 C3 最新留言將狀態改存 0042；只改 backend，migration 由 X2 的 `db-wt-50` 提供。
保留 readYieldState／writeYieldState 呼叫介面，另可傳入呼叫端 SQL query，確保三類狀態參與原交易。

- 修前單元回歸 **0 pass／1 fail**：檔案版在 DB 故障時沒有拒絕。修前 DB 儲存／回滾回歸
  **0 pass／4 fail**（當時 0042 尚未出現）；其中回滾回歸明確顯示檔案殘留，與 SQL rollback 不一致。
- frozen install：**Checked 85 installs across 83 packages，無變更**；三份 tsconfig 全過。
- DB 重點 3 檔首輪：**50 pass／0 fail**；之後補的 cursor 故障停止帳戶嘗試回歸納入完整 suite。
- 重建專用 `cre8_be112`、套用 db-wt-50 的 **0001–0042**，完整
  `bun --no-env-file test --timeout=120000`：**1523 pass／16 既有 skip／0 fail（69 檔）**。
- CI 同一份 48 檔清單：**1067 pass／27 既有 skip／0 fail**。公開鏈寫入測試沒跑，本次禁止。
- `yield-106.fork.ts`：**1 pass／0 skip／0 fail，159 個明確 assertions**。三協議完整 Kernel／alto
  生命週期及真實 60／61 次邊界通過。**11 actions、72 gas reservations 全 confirmed，72 筆授權皆有相符 DB fact**；
  持久 cursor 可讀，未完成退出／非零部位皆 0；還原 signer 後 **381 項部署檢查全過**。
- 0042 實際檔案與 DB 記錄 checksum 相同：`ee9040131b355898eef0f46d47b2033341574afadf63d10ccc74e19e0223323e`。
- 新回歸包含 fact／release 並行相同／衝突寫入、jsonb 欄位排序相等、全新程序讀寫、cursor 0／
  最大 safe integer／繞回／未來時間戳、name 200／201 長度、禁用敏感欄位、缺 schema、DB 讀寫 timeout，
  以及事實／解除證據／游標隨同交易回滾。正常授權與解除的 ledger 也驗證原子性；DB 故障不回授權或解鎖。

自我 review 修正了舊檔案版與 SQL transaction 分離的問題：新事實、release 證據與 cursor 都明確使用
呼叫端 client；故障／rollback 不會留下不可變證據，後續新 finalized 證據可正常重試。保留原帳戶／
日期鎖與歷史成本。已檢查完整 branch diff、秘密輸出及範圍，沒有新增 skip／only、型別抑制、除錯碼或其他 repo 改動。

## 自我 review 與影響

review 找到並修正：供給／退出健康度混用、保留 signer 的 selector 撤銷、expiry 後重簽仍累積
site charge、UTC 午夜互斥鎖需不含日期，以及未消耗 ordinary 不應阻擋退出。額外測試核對
兩種 EntryPoint batch、hash／nonce／tx／receipt／canonical 不符與 inner revert，不會用錯 executionKey。

只影響 chain 97 的生息及代付授權事實／退出安全判斷；主網生息仍未准入，執行開關仍預設關閉。
API 欄位形狀不變，permission 與退出證據判斷更嚴謹；新拒絕 code 為 PAYMASTER_EXIT_INVALID、
PAYMASTER_EXIT_UNAVAILABLE、PAYMASTER_EXIT_AUTHORIZATION_PENDING。backend 無 DB schema 變更，
部署需已套用 0042。沒有改 Railway／Cloudflare、其他 repo 或部署設定。

保留 ignored `.bun-cache/` 的完整／CI／fork／修前回歸 log、最終 DB dump 與 anvil state。已精準停止自己的 8599／3099 程序，worktree 與 cre8_be112 留給總管 review。
