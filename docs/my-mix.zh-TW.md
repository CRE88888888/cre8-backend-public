# 私人組合（My mix，chain 97）

對應 backend#178／#180／#182；schema 依賴 CRE8Finance/cre8-db#77 的 0056、db#79 的 0057 與 db#81 的 0058。部署順序必須先套用 0056、0057、0058，再部署 backend#182；本文件不代表已部署。只開放測試網既有 21 檔目錄的 40 個資產，選 1–10 個，比例以 bp 表示、合計 10000。私人 strategy 不出現在公開基金 API，不能經通用 strategyId 加入。

## 建立、確認與改比例

需現有 SIWE Bearer session。以下地址是 chain 97 的 NVDAB／TSLAB；回應中的 id、calls、hash、日期由實際請求產生，範例省略 calldata 內容。

`POST /me/mixes`，必帶 `Idempotency-Key: <客戶端產生的唯一代碼>`（1–128 個英數字、`_` 或 `-`；建議 UUID）。同一次建立重試須沿用代碼與原始 body，另建組合才換代碼。CORS 允許此 header。

```json
{
  "name": "My tech",
  "assets": [
    {"assetId": "0x5d63b93e50ef9f8851e1de71d8255c2f0beab397", "weightBps": 6000},
    {"assetId": "0x587cb8fe057344490a28390c7986e1beff5ad36e", "weightBps": 4000}
  ],
  "rebalance": {"frequency": "monthly", "startDate": "2026-11-21"},
  "exit": {"takeProfitBps": 3000, "stopLossBps": 2000}
}
```

201 回應形狀：`{mixId, strategyId, account, signingMode:"sudo", expectedVersion:1, nonce, expiresAt, calls:[{to,value:"0",data}], intentId, message, name, shareCode}`。省略名稱會依成分命名；省略 rebalance 是每月／今天 UTC；省略 exit 是不設停利停損。數量不限；建立與改成分合用每錢包 3 次／分鐘、20 次／UTC 日、每 IP 10 次／小時及全域預設 300 次／小時的預算，新的有效請求一旦取得建立預算，即使後續失敗也計次；同 owner／chain／Idempotency-Key 且相同 body 的已保存請求重試不再消耗 IP／全域／錢包建立預算。IP／全域與每分鐘計數目前是單一 process 記憶體，重啟會重置、不同副本各自計數；UTC 日錢包預算則存 Postgres。全域上限可用 RATE_LIMIT_MIX_CREATE_GLOBAL_PER_HOUR 調整；0 會拒絕建立。鏈上名稱固定 CRE8 mix，用戶名稱只存 DB。建立前先保存綁定 owner／chain／key 的原始 body hash，與已解析 Import／預設日期／名稱／門檻的不可變 settings。相同 key 不同 body 回 409；相同 body 重試不再讀來源或重算今日，因此來源後來修改／刪除或跨 UTC 日期不改原設定。mix、初始 owner intent、completed request 同一交易提交；未知提交或回應遺失可重讀同一 mix，已確認的 enrollment 不會重新開啟。

註冊由共用 relayer 鎖保護，先簽一次並驗證 hash／chain／signer／nonce／registry／零 value／精確固定私有 metadata；原簽寫入獨立受限 outbox，再與 submitted request 原子提交，確認 COMMIT 成功後才廣播。DB 失敗、逾時或連線中斷先不送；新連線只讀原 bytes，receipt 明確不存在且沒有外部消耗證據時，也只可重送相同 bytes。後端 reconciler 納入 My mix；沒有 canonical 外部消耗證據的未決註冊仍保留共用 guard；第一版發布則獨立保存 nonce，占用資料也套用到 faucet／welcome／部署與公開註冊／發布入口，先比對 pending nonce 與已保存發布 nonce。若節點尚未看見原簽，就驗證版本仍為 0 並重送持久原 bytes 填補缺口，再重讀 pending nonce 配置下一筆；不以未確認的「最高 nonce + 1」猜測 queued 交易，缺口仍無法確認時才拒絕真正衝突的新簽送，不會只因單筆發布未完成就全域 RELAYER_BUSY。只有 canonical receipt、原交易及 StrategyRegistered 事件全部符合，才保存原 on-chain id，後續帳戶／DB 失敗皆沿用該 id。outbox 原簽只供 relayer，不能回 HTTP、一般序列化或 log；部署時 DB 管理者須授正確角色權限並限制 statement／parameter／error logs。

第一版發布（含 PATCH）先保存不可變 mix_publication_jobs，再於短交易保存原簽 attempt 與 submitted，確認 COMMIT 後才廣播；未知 COMMIT 先不送。共用 nonce 臨界區採 15 秒送出期限；逾時不再啟動簽送，已開始的短 DB 交易先完成或回滾再釋放鎖。每次 RPC 最多 5 秒、寫入 statement 5 秒／lock 3 秒；收據查詢在共用鎖外。沒有 canonical receipt 時只重送原 bytes。canonical revert 保留原 attempt／receipt，再核對 versionCount=0 與原設定，才以新 nonce 新增下一個 attempt。成功須核對完整 version/config hash、activeVersion=1、VersionPublished 與 canonical 區塊，receipt／精確 DB mirror／confirmed 同交易提交，只寫入一次。reconciler 主動掃描獨立工作，不依賴 App 或再 POST，PATCH 也不必有 creation request。等待滿 60 秒持久告警；版本／設定／已保存 canonical 證據衝突只隔離該工作，隔離後仍可記錄晚到的 canonical receipt，不再簽新 attempt。每個原簽只在建立後十分鐘內以 nonce floor 阻擋共用 relayer；到期即停止此全域阻擋並保存營運告警，原簽／receipt 不刪改，隔離或 receipt reorg 的工作仍可重送已驗證原 bytes 補洞。十分鐘內節點 pending nonce 落後時，只有連續 nonce 的原簽都已驗證且獲節點接受，才用本地 floor 配置下一筆；RPC 失敗、缺口或未獲接受仍拒絕新簽送。到期後一般 relayer 可使用節點分配的 nonce，若消耗舊原簽 nonce，必須走外部 canonical 消耗證據對帳；不能靠時間推論舊原簽已失效。若原 nonce 尚未廣播，共用協調器先重送原 bytes 填補缺口；faucet、原生 gas faucet 與部署都先確認該 nonce 已被節點承認，再配置新交易。廣播或收據未知仍保留 quota，後續由對帳器確認。註冊的舊 guard／原簽 audit 保留，不以逾時推論註冊失敗。

十分鐘到期告警的查詢、寫入或 alerted_at 標記失敗，只記固定安全 log，不影響共用鎖與 nonce guard。失敗後同 process 至少隔 60 秒才再試，重啟會重設節流；告警成功保存後才標記完成。真正的鎖連線或 nonce 證據讀取故障仍拒絕簽送。

0057 的 `mix_publication_nonce_consumptions` 保存不同 hash 消耗原 signer／nonce 的 canonical 證據，與原交易 receipt 分開。後端只讀已採樣區塊的 nonce，以歷史 nonce 的跨越位置找出區塊，核對完整交易、receipt、鏈／signer／nonce、區塊 hash／時間與再次採樣的 canonical 錨點。僅 pending 前進、RPC 失敗、逾時或缺資料均不釋放原簽；即使原 hash 的 RPC 查詢失敗，也必須有完整獨立 canonical 外部證據才可處理。作廢記錄與 submitted→prepared 在 job 鎖和共用 relayer 鎖下原子提交，COMMIT 不明先不重簽，重連讀原證據續作。新 attempt 必須重查原設定及 version 0，並重新驗證所有舊 resolution 區塊與最新外部證據；已消耗的原簽永不重播。若外部交易已發布匹配 v1，驗完整事件／設定後只 mirror，不另簽；證據 reorg 則保留歷史、隔離及告警。

0058 把相同外部 nonce 消耗驗證延伸至註冊、faucet 與 welcome。先核對完整原簽；新原簽與 immutable nonce identity 同交易保存，舊原簽只在驗證後補 identity。**外部交易所在區塊之後至少再有 15 個 canonical 區塊，才可存證、將 faucet／welcome 改成 failed 或重建註冊。** 確認數定義為 `latest.number - inclusion.number`，所在區塊本身算 0；14 不足，剛好 15 才可處理。歷史 nonce 從 `latest - 15` 的 canonical 區塊向前倍增找跨越區間，再二分定位與核對完整外部交易／收據／穩定錨點。查找預設共用五秒期限；確認不足、歷史讀取不足或只有 pending 前進都不釋放，來源保持未決，對帳器照舊嘗試重送相同原 bytes 並等待。提交與新註冊簽名前再次驗證 canonical 證據、15 區塊深度與鏈頭錨點；RPC／缺資料／逾時或鏈頭倒退不能授權狀態變更。faucet／welcome 在原 UTC 日額度鎖與來源列鎖下，將 consumption 與原請求 failed 同短交易提交；保留原 hash、owner、account、amount、UTC 日，不重簽該請求，沿用現有失敗回應與額度規則。

**welcome 補發：** 外部消耗使原請求 failed 後，終生 owner 身分仍占用，該用戶永遠不會自動再領 welcome；重試原購買或重新預約都不會再發 welcome（後續使用既有每日 faucet 規則）。來源結算 COMMIT 後會嘗試保存 `portfolio_stuck`／critical 營運告警，告警綁定原 portfolio id，detail 含 `WELCOME_NONCE_CONSUMED`、grant id、owner、account、amount wei 與原 hash，不含原簽。告警寫入失敗只記固定安全 log，不回滾已提交的 consumption／failed，也不阻擋共用 nonce；一般 scheduler 從持久來源與消耗證據補寫告警，未知 COMMIT／程序中斷也能續作，不另發或建立第二筆 grant。補發告警不會由一般 resolve 掃描自動解除（包括偵測後、解除前才插入的告警），營運可從 `bun run scripts/scheduler.ts --alerts` 檢視。營運應先核對原 hash、外部消耗證據及 canonical 鏈況，確認未曾發放且沒有其他補發，再依既有簽送協調規則手動補發、保存補發交易紀錄，最後手動將對應 `scheduler_alerts.id` 的 `resolved_at` 設定為核對完成時間。沒有自動補發端點，不得改刪原 grant／outbox／證據或清空終生資格；這段流程不授權公開鏈交易。

註冊則把 consumption 與 prepared／清目前 hash／attempt+1 原子提交。COMMIT 不明先不簽，下一輪重新讀取原證據與來源；reconciler 只為進入該輪前已提交的 prepared attempt 重建，不需 App 再 POST。新簽前重新驗所有歷史 canonical 證據與凍結請求，同 signer、更高 nonce；保存目前 attempt 的 outbox＋identity＋submitted，COMMIT 確認後才廣播。查詢精確綁目前 attempt/hash，所有歷史 raw/hash 保留；consumed hash 從 replay 與全域 guard 一致排除。已消耗 nonce 的 floor 持續防止 reorg 後重用：節點 nonce 已前進時可正常送下一筆，真正缺口無法證明已補齊時仍拒絕新簽。

歷史外部證據區塊 reorg 時，保留原證據並以不可變 quarantine 與營運告警隔離來源，不自動重播／重建／完成該註冊；funding 維持 failed。隔離中的 replacement 若另有晚到外部消耗證據，可保存並維持 submitted，不復活業務狀態；其未解決 nonce 仍受保護。告警偵測會持續納入 quarantine，不能被一般排程掃描清掉。原 hash 的 RPC 錯誤也可由獨立完整外部證據處理，錯誤本身不構成消耗證據。

初次建立會部署既有 Kernel 帳戶並保存第一個 strategyId 的 salt。這版無法延到首次入金才部署：現有 owner enrollment 與 sponsor 明確要求帳戶已部署且 initCode 為空，session permission 亦須先安裝；延後需要另改 counterfactual enrollment／sponsorship 流程。用戶以帳戶 owner 簽回傳的 atomic calls，經既有 sponsor 與 `POST /bundler` 送 UserOp。calls 是必要的新資產 allowance=0 時的 approve(maxUint256)，最後 enroll(account,newStrategyId,1)；已有正數 allowance 沿用現有規則。App 必須使用回傳 nonce。sponsor 比對已保存的 exact calls、完整 nonce、sudo mode／validator 及 EntryPoint 當前序號；回傳授權前保存 user_op_hash 與 submitted 狀態。

確認鏈上收據後，`POST /me/mixes/:id/confirm`：

```json
{"txHash": "0x…64 hex digits…"}
```

200：`{mixId, portfolioId, account, message}`。驗證成功且 canonical 的 EntryPoint handleOps／UserOperationEvent／Enrolled、operation hash 及 exact calls，才原子提交 history、帳戶、session key 與 intent。重試不重建段落。scheduler 及明細查詢也會自行掃 Enrolled（帳戶＋目標 strategy＋nonce），不依賴 App 傳回 txHash。未簽 prepared 意圖滿 15 分鐘會自動 expired；submitted／unknown 必須由 canonical 成功、失敗收據或完整掃描加已到期的 paymaster 授權證據釋放。pending 仍評估停利停損，未上鏈時先取消意圖再退出，已上鏈時先對帳；USDT 領回本人仍可 sponsor。

`POST /me/mixes/:id/enrollment-params` 可重讀待簽 calls。既有 `POST /portfolios`、`POST /portfolios/enrollment-params` 也接受 `{mixId}`；`POST /portfolios/enrollment-confirm` 接受 `{mixId,txHash}`，走同一套確認。

`PATCH /me/mixes/:id` 可只帶 name、rebalance 或 exit 的部分欄位；未帶設定保持原值，exit 欄位帶 null 可取消該邊門檻。改成分例如：

```json
{"assets":[{"assetId":"0x587cb8fe057344490a28390c7986e1beff5ad36e","weightBps":10000}]}
```

回應新的 intent/calls，須 owner 確認。切換後地址、salt、原 session key 不變；後端建立新 portfolio 段落，移動原 key 列，停用舊 mapping。未完成或結果未知的鏈上操作會擋切換。移除但餘額大於 0 且有預言機價格的持倉以鏈上 1 bp 出口保留，從最大用戶成分扣除（同權重按地址排序）；實際目標仍用原用戶比例，出口永不買。收盤股票保留預算，開市加密資產先執行。每次確認／restart 會排一次立即檢查，一般期間只要 canonical 完成一批 rebalance，或 rebalance planner 確認不需交易／低於交易門檻，就記為完成，下期才再調整。切換後 last_rebalanced_at 為空且仍持有達門檻的 1 bp 出口時，成交仍不記完成；canonical 即時或晚到收據結算前，先在短 DB 交易外重新讀取實際持倉與組合狀態。所有出口清空或低於門檻後，rebalance 成交便完成當期，不再只因設定仍含 exit_assets 而反覆交易；仍待出售的出口保留每輪檢查，直到完整餘額都低於既有每資產最小步門檻（MIN_STEP_USD_E8，預設 1 USDT；等於門檻仍待賣，設為 0 時須賣至零餘額）。收盤出口保持等待開盤，RPC／缺價不算完成。若全部出口已開市、同帳戶估值完整，planner 明確回非暫時性的最小交易額阻擋，且出口完整名義總值嚴格低於 MIN_BATCH_USD_E8（預設 50 USDT；等於門檻仍待交易），才可完成檢查並記為殘留。不可變 `mix_switch_residual` 通知保存原數量、decimals、oracle 價格／來源、區塊 hash／時間及當時門檻，與完成時間同交易提交；未知提交重讀後不新增事件，後續週期仍檢查該持倉；new_money（承接或入金）的成交不更新 last_rebalanced_at，因此買完後仍會做當期再平衡；收盤及暫時阻擋保留同一期重試。其後依 UTC 日曆頻率執行；月底錨點不漂移（1/31→2/28→3/31）。

## 查詢、分享、試算與退出

- `GET /me/mixes`：`{mixes:[...]}`；`GET /me/mixes/:id` 回名稱、建立日期、assets、rebalance、exit、account／portfolioId、status、pendingChange、currentValueRaw、netInputRaw、performanceInputRaw、returnBps、performanceStartedAt、valuedAt、performanceMessage、nextRebalanceAt、residualCash、markets、selling、events。
- 列表不拿組合鎖、不執行 planPortfolio，只讀最近一次估值快照；valuedAt 表示該快照的區塊時間。明細即時估值，忙碌或 RPC 暫時不可用時回舊快照，缺快照回 null。兩條讀取路由共用每錢包 plan 預算。
- `status`：awaiting_enrollment、active、exiting、exited。價值不可確認時 currentValueRaw／returnBps 為 null，不視為零、不觸發停損。events 是永久通知的白話投影，保留跨段落的建立、買入／再平衡、改比例、退出觸發。
- `GET /mixes/shared/:code` 免登入，只回公開設定、建立日期、回測、copies；不含 account、owner、portfolioId 或金額。`POST /me/mixes` 帶 `{"importCode":"分享代碼"}` 建立獨立組合；開始日一律是今天 UTC（即使來源是歷史日期），並複製停利停損；來源被刪或不存在回 404，之後雙方改動不同步。
- `POST /mixes/preview` 免登入，只接受 `{assets:[...]}`。回 minimumDepositRaw、modelReturns／modelNav／modelComponents、estimatedRebalanceCost、markets 與白話 message；沿用 model-returns 歷史價格與新上市規則。最低外部申購沿用既有 50 USDT 規則；估算交易費 10 bp、gasWei 另列、gasSponsored=true。公開分享／preview 合用每 IP 30 次／分鐘預算與 preview 並行／逾時限制。
- oracle 價值與 canonical 入出金取同一觀測區塊。報酬率=(目前價值−淨投入)/淨投入，淨投入=累計外部入金−外部出金。追蹤 mix 歷史白名單所有資產的 Transfer，包含用戶自付 gas 轉往第三方的直接轉出；非 USDT 以偵測時預言機價折成 USDT，這是近似值，保存原數量、價格來源與估值時間。重掃沿用首次保存的價格。mix sponsor 只允許 USDT 轉回本人，其他資產的直接 transfer 不 sponsor。executor 換幣／退款、內部承接不是新入金。100→130 是 +30%；追加100 後 230/200 是 +15%。淨投入≤0 回 null 及原因，暫不觸發。
- 每個 scheduler tick 都先檢查整籃停利停損；達門檻即鎖存退出，全部目標改 USDT，拒絕再買。賣出沿用既有 exit 最小額豁免；休市股票等開盤，剩餘非現金總值嚴格小於 0.01 USD，或逐資產確認完整餘額低於 executor 最小步時，記錄不可變殘留並完成退出；剛好 0.01 USD 仍須賣出。只累計 canonical 已上鏈卻失敗、且非預言機故障的連續賣出失敗；報價阻擋、收盤、StaleFeed／預言機／RPC 錯誤、廣播前失敗與未知收據都不計次。成功賣出任一批即清零。連續 5 次失敗後寫入持久營運告警、通知並冷卻 5 分鐘；再失敗依序退避 15 分鐘、1 小時，之後最多每 6 小時一次。持久連敗計數最多保存 8（代表已到六小時上限）；通知最多每六小時重發一次。成功一批便清除連敗／冷卻及告警節制，scheduler 之後重新確認條件再續作，無須用戶 restart；未知在途操作仍優先對帳，不因冷卻重送。完成後 paused/exited。`POST /me/mixes/:id/restart` 只允許 exited，重設退出鎖存並開新的報酬期間：基準是重新開始當下 canonical 區塊結束的預言機組合價值，本期本金=基準＋之後入金−之後出金。performanceStartedAt 是該塊時間，performanceInputRaw 為本期本金，netInputRaw 保留全歷史淨投入。照原比例再買，不偽造入金；缺價／RPC 失敗不會重新開始。
- 不啟用 yield 或績效費 ledger；私人組合 yield status 為 null，consent／revoke／exit 拒絕。registry 舊版 500 bp 的承諾值沿用合約，不啟用績效費收取；swap fee 沿用 0.1%。

## 承接現金與互斥

0056 在 history INSERT 計算 handover_minimum_raw／residual_cash_raw／residual_cash_reason。承接門檻=max(依用戶比例讓每個成分至少有 1 raw、既有每資產批次 10 USDT)。0 不建 lot；正數低於門檻留 available cash 並記 residual；達門檻（含相等）必須建 mix_handover lot，用 user_allocation，完全不含出口。原現金精確歸零並完整轉到新段落；handover 不增加 principal。residual 計入價值，後續普通現金規則可用。

以穩定 mix id 的 session advisory lock 跨 RPC 保護切換、sponsor、scheduler、新投入與續約結果寫入；DB 連線遺失後簽名／送出前再次探測原鎖連線，拒絕繼續。未知操作保留對帳。閉市來源等待時，日期再平衡只可花 allocated_cash，不能挪用來源預算。pending 期間不在舊 portfolio 新建外部 funding lot；confirm 前的現金全額承接，successor 拒絕 enroll 整個截止區塊（含較晚 log）及之前的外部 funding 重複入帳。flow sync 使用原 holdings cursor 增量掃描。入出金重掃去重；reorg 保留舊證據、回退 cursor 並停止該輪交易。

## 本機驗證

使用可拋棄的 `cre8_x1_180`，`MIGRATIONS_DIR` 指向 X2 worktree 的 migrations。已套用舊版未合併 0056 的測試庫要重建，不改 checksum。CI no-DB 清單在 `.github/workflows/ci.yml`；DB suite 須另外跑完整 `bun --no-env-file test --timeout=120000`。

fork 測試刻意命名 `test/mix-switch.fork.ts`，必須明確執行；只認 localhost:8580 的 anvil、chain 97，用公開測試帳戶。每輪記錄當次 fork 區塊，合約來源固定 `cbc671d395e89357b7bf3726c37775ba1f42ef35`。測試使用該版 VerifyingPaymaster 本機公開 signer 替身；registry／executor／oracle／Kernel／policy 保留 fork 真實 bytecode。另外用真 DB 保存原簽，驗證 COMMIT 後、廣播前中斷可重送原交易，仍只有一份 strategy／version 1。`mix-residual-risks.fork.ts` 再驗 receipt reorg 隔離後補洞與下一筆 relayer 真實入帳，以及外部 canonical nonce 消耗後的新 attempt；原 audit 保留。這是帳戶切換、session 與註冊恢復驗證，並非正式 sponsor signer 或部署驗收。

```bash
mkdir -p .bun-cache/issue-180/contracts-cbc671d
git -C ../cre8-contracts archive cbc671d395e89357b7bf3726c37775ba1f42ef35 | tar -x -C .bun-cache/issue-180/contracts-cbc671d
forge build --root .bun-cache/issue-180/contracts-cbc671d
# 在 8580 啟動自己的 chain 97 anvil fork；上游唯讀 RPC 由本機環境提供。
bun --no-env-file test ./test/mix-residual-risks.fork.ts --timeout=120000
# 重啟自己的 8580 為全新 fork，再跑既有帳戶／faucet 回歸。
bun --no-env-file test ./test/mix-switch.fork.ts --timeout=120000
```

每次重跑須重設自己的 8580 為乾淨 fork，並記錄實際唯讀採樣區塊。不得對公開鏈執行測試或使用真私鑰。

本次 #182 使用 `cre8_x1_182`。0058 尚在 db#81 時，驗收的 `MIGRATIONS_DIR` 指向本工作樹 `.bun-cache/issue-182/migrations`：指定 `../db/migrations` 的 0057 以前檔案加上 db#81 固定 commit `fea198d5ef341ac14627de8b578dd729b650c297` 的 0058，只作逐位元相同的本地副本、不修改 db repo；部署前須先合併並套用 0058。新增 `test/relayer-nonce-consumption.fork.ts` 只接受固定 localhost:8582、anvil／chain 97：保存未廣播 faucet 原簽，以公開 anvil key 的另一筆交易消耗原 nonce；0／14 確認保持未決，剛好 15 確認才對帳原子存證／failed，再用下一 nonce 真正 mint 1 USDT 並核對餘額增量及原 raw/hash 不變。替換消耗證據所在分支後，保留證據與 failed、隔離告警，不自動重發。只在自己的全新測試網 fork 明確執行：

```bash
bun --no-env-file test ./test/relayer-nonce-consumption.fork.ts --timeout=120000
```

## 共用 operator 的營運腳本

執行會以共用 operator EOA 簽名的手動腳本前，**必須先暫停所有 scheduler／API 副本及其他同 EOA 的簽送程序**，等已開始的簽送結束，並對帳既有 outbox／未決交易；執行後核對 canonical receipt，再恢復服務及 reconciler。不要與服務同時從 RPC 取得 nonce。這也適用於 `scripts/fund-account.ts`，以及 `approve-assets.ts` 的直接 EntryPoint 代送模式、`integration-fork.ts`、`demo-flow.ts` 等工具若設定成同一 EOA 的情況。僅讀取的 preflight 不需要暫停。走既有 chain writer 的 `testnet-launch-funds.ts` 有共用鎖／relayerNonce；直接寫 wallet 的工具不具此保證，不能因為設了相同 env 就視為已協調。這些說明不授權公開鏈交易、部署或使用真私鑰。
