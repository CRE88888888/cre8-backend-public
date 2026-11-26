# BE-110：第二輪生息同步與跨區塊驗收

本輪固定 contracts `4c4f845b62f08505bf8f0a852f17340b2cb2ecdf`，manifest 的 Solidity 來源為
`ccf994a813f707dc5ccca570b960b2f1dedcef73`。來源 repo 唯讀；以 `git archive 4c4f845` 解到本 worktree
的 `.bun-cache/contracts-110`，forge／broadcast／cache 都在副本執行。續跑時來源 checkout 已到 `f60dd99`，
仍使用保留的固定 archive，沒有混入後續改動。不讀 `~/.cre8-testnet/`。

## 同步與 minimum 規格

- executor `0xE3725CBdC1B4BE58ed9b49E6f863cDDE654bbfce`。
- registry `0x80d3A6AD26dBE4b33bC6fe4abD38b1E1D78cBd14`。
- YieldView `0xC8EEBa84f9C74B2D879dFaEdb02a0a523aA02657`。
- 重產 92 資產、30 市場、381 runtime pins、ABI 與 owner renewal golden。三份 artifact 的 compiler
  source keccak 均對指定 revision 核對，runtime 僅忽略編譯器宣告的 immutable 槽；registry.reader
  必須等於 manifest 的 YieldView。缺 YieldView、錯 runtime 或讀取失敗都拒絕生成。
- YieldView 的部署 artifact 沒有 library linking 設定；之後的 linked 編譯會改變 metadata。
  生成使用部署時的 unlinked artifact，完整 runtime 必須一致，不刪 metadata。
- backend 使用的 quoteSupply／quoteWithdraw／receiptAssets／refreshHealth 仍是 registry wrapper，
  保留 accrual、identity、rate 與帳戶記帳檢查；沒有需要改讀 stateless YieldView 的呼叫。
- 依 [C3 更正](https://github.com/CRE88888888/backend/issues/110#issuecomment-6903924757)，supply／withdraw
  的簽名 `min = floor(quote × 9995 / 10000)`，必須大於 0。使用 bigint 先乘再除；quote=0 或 1
  均拒送，quote=2 得 min=1，沒有以 1 補值。小額 raw units 的取整可能大於名義 5 bps。
- 同一 canonical block 的 accrued quote、execution preview、calldata、簽名與 journal 使用同一 min。
  合約的 10 bps 執行時 quote 容差留出跨塊緩衝，實收仍由協議決定；不保證任意久的報價可用。
  RPC／資料缺漏／預演失敗仍不送；原有重報價上限與 deadline 保護保留，不逐次降低折扣門檻。

## 本機重現

只用 anvil **8599**（chain 97、歷史 fork、`--prune-history 256`）、alto **3099**、DB **cre8_be110**。
`PORT=8699` 是防呆，此驗收直接呼叫正式 yield service／scheduler，未啟動 HTTP backend。
公開 anvil 測試材料只在記憶體與程序環境使用。

1. 建立固定 archive，使用 archive 的原始碼與 vendored lib；編譯輸出留在副本。
2. fork 的部署時間須比牆鐘早至少 30 分鐘。設定 `anvil_setBlockTimestampInterval(0)`，只在本機
   impersonate manifest deployer／owner 並補假 BNB。先跑 `script/testnet/DeployYieldView.s.sol`，
   保存 unlinked YieldView artifact；再設定 `DAPP_LIBRARIES` 為 manifest 的 YieldView，依序執行
   `script/DeployTestnet.s.sol --broadcast --slow --gas-estimate-multiplier 300 --unlocked --sender <deployer>`。
   有 PENDING 時推進兩秒再重跑。原始部署共六次，最後沒有 PENDING。
3. 若 unlinked artifact 被後續 linked 編譯覆寫，可在副本用 `env -u DAPP_LIBRARIES forge build
   src/atp/yield/YieldView.sol --out out-yield-view --cache-path cache-yield-view` 重建，核對完整 runtime 後
   放回副本的 `out/YieldView.sol/YieldView.json`。不要修改來源 contracts checkout。
4. 使用原 checkout 的唯讀 git object database 與明確 revision 生成：

```sh
GIT_DIR="$(git -C <唯讀 contracts checkout> rev-parse --absolute-git-dir)" \
GIT_WORK_TREE="$PWD/.bun-cache/contracts-110" \
bun --no-env-file scripts/sync-testnet-profile.ts "$PWD/.bun-cache/contracts-110" http://127.0.0.1:8599 fork 4c4f845
```

5. mine 120 個本機區塊。依 #106 文件在 3099 啟動 alto 0.0.18：safe-mode、EntryPoint 0.7、
   timeout 120000、max-block-range 100、min stake／unstake delay 1，executor／utility 使用公開 anvil #4／#5。
6. 專用 DB 設定連線環境與 `MIGRATIONS_DIR=../db/migrations`。
   完整 suite 與 E2E 分別使用清空重建的同一專用 DB，不混用配額或帳戶資料。

```sh
ANVIL_RPC_URL=http://127.0.0.1:8599 bun --no-env-file test --timeout=120000

CHAIN_ID=97 RPC_URL=http://127.0.0.1:8599 BUNDLER_URL=http://127.0.0.1:3099 \
PORT=8699 TEST_DATABASE_NAME=cre8_be110 ENABLE_YIELD_EXECUTION=1 \
bun --no-env-file test ./test/yield-106.fork.ts --timeout=1200000
```

E2E 使用真 service／scheduler／Postgres journal／Kernel／alto／paymaster。
只在 journal.prepare 成功後注入 2.1 秒等待與本機追時 mine；保存後不改 plan／minimum／已簽 calldata。
每筆限制一次 quote attempt，獨立重讀原 canonical quote 並驗證 5 bps min、至少兩區塊差與正時間差。
不凍結同秒價格、不調 APR、不改 PostgreSQL 時鐘或停用 trigger。
先核對全部 runtime pins，才在本機替換 paymaster immutable signer 為公開 anvil #6，結束還原原 code。

## 回歸與診斷紀錄

minimum 回歸修前 **4 pass／0 skip／3 fail**，修後 **7 pass／0 skip／0 fail**；涵蓋兩種操作、
0／1／2、分母整點、取整邊界、uint256 上限，以及 RPC／quote timeout／缺資料／reorg／預演失敗。
缺 YieldView 回歸先得到 **3 pass／0 skip／1 fail**，修後納入完整 suite。
錯 YieldView runtime 的實跑檢查為 **1 pass／0 skip／0 fail**，六份生成產物保持不變。

更正前使用 quote 原值的 E2E 為 **0 pass／0 skip／1 fail**：Venus APR=500 bps，100 USDT 的
quote/min=9999941257，兩區塊／兩秒後協議實收=9999941226，回
`InsufficientOutput(9999941226,9999941257)`。失敗已 canonical 對帳且資產未移動；原始 log、DB dump
與 anvil state 均保留。C3 更正後依同一固定合約版本重新執行整輪，沒有沿用 #106 的歷史成功數字。

續跑第一次完整 suite 為 **1493 pass／16 skip／1 fail**，唯一失敗是既有 #67 積分 12 併發重試測試
回 `POINTS_STORAGE_UNAVAILABLE`，該 fixture 設定 timeout=100 ms。沒有修改積分程式、測試或逾時；
清空專用 DB 後整輪重跑為 **1494 pass／16 skip／0 fail**。此失敗原因未在 #110 內定案。

跨時間 E2E 第一輪為 **0 pass／0 skip／1 fail**（74 個 PASS assertions）：三協議供給、計息、部分領回
與首次全退均成功，但 Aave 在確認下一個 tick 時又領回一筆，原「下一個 tick 完成／固定三筆 snapshot」假設不足。
該帳戶首次全退後剩 95129377126 raw receipts，再領後剩 181 raw／scaled units；原因是簽名的 raw
金額在執行前持續 rebase。正式 reader／writer 已支援 durable 續領，這次只修 E2E：至多八次完成
檢查，每筆額外領回必須嚴格減少 scaled units，仍要求最後 receipt／observed／tracked 全為零。
所有額外操作均逐筆核對原簽名 min、跨塊時間、receipt 與 immutable journal；沒有略過零值或折低門檻。

下一輪 E2E 為 **0 pass／0 skip／1 fail**（79 個 PASS assertions）：Aave 再以兩筆已確認操作領完
計息尾款，鏈上與 DB 的 receipt／scaled units 都已全零，但舊驗收假設本金必定全額回復。
實際分類為 allocated=99999999999999999999、yield=808599699974，尾款逐筆 scaled 取整實損 1 raw。
這符合 #109 既定「實損不補本金」。E2E 改以 canonical RPC 的各筆 scaled units 與實收，獨立計算
單筆存入的耗用成本、逐筆實損及利息，對 DB 本金／利息與鏈上現金作精確相等檢查；不設誤差容忍、
不補本金，也不修改 writer。Venus／Lista 仍須精確恢復原本金。

另一次啟動輪為 **0 pass／0 skip／1 fail**（8 個 PASS assertions），帳戶建立前市場 reader 在
約 15 秒後回 `YIELD_UNAVAILABLE`。沒有供給或領回。以相同 reader 的原預設逾時重讀預熱後，
30／30 市場 known，耗時 **1158 ms**；重建空 DB 後再跑整輪，產品與驗收逾時均未調整。

## 最終本機驗收結果

| 指令／驗收 | pass | skip | fail |
| --- | ---: | ---: | ---: |
| CI no-DB 同清單，48 檔 | 1058 | 27 | 0 |
| 乾淨 Postgres 完整 suite，68 檔 | 1494 | 16 | 0 |
| domain／DB focused | 34 | 0 | 0 |
| execution／reader／generator／golden focused，4 檔 | 27 | 0 | 0 |
| YieldView 錯 runtime 拒絕且六份產物不變 | 1 | 0 | 0 |
| Kernel／alto E2E，1 個整輪測試 | 1 | 0 | 0 |
| E2E 明確 assertions | 147 | 0 | 0 |
| E2E 後全部 runtime checks | 381 | 0 | 0 |

`bun install --frozen-lockfile` 成功（Checked 85 installs across 83 packages，lockfile 未改）；
`bun run typecheck` 三份與 `git diff --check` 通過。16 個完整 suite 的 skip 為既有未啟用的鏈上交易／
chain 56 fork 等測試；沒有新增 skip。GitHub CI 數字與 run 連結另貼 PR。

三協議各完成 owner A10 升權且 Kernel 不變 → max consent → scheduler 供給 → 計息 → 部分領回 →
停止全退 → 鏈／DB 歸零。30 市場 APR 全非零；三個 Kernel 原生 gas 餘額均為 0。
11 筆生息操作全部 confirmed，無 unresolved 操作或未完成退出要求；每筆均使用原簽名 5 bps min，
跨 **2 區塊／2–3 秒** 成功，一次 quote attempt。Aave 的兩筆追加領回各有獨立成功事件與快照。

共 **72 筆成功 UserOp**、72 個 confirmed gas budgets，sponsorship 計數為 **6／6／60**。
第 60 次真代付成功；第 61 次回 `PAYMASTER_QUOTA_EXCEEDED`，計數、預留與 EntryPoint 同一 nonce key
均不變，paymaster 真正支付 EntryPoint gas。

以下為 EntryPoint `actualGasUsed`，非公開鏈費用估算：

| 協議 | supply | partial withdraw | full withdraw | 追加尾款領回 |
| --- | ---: | ---: | ---: | ---: |
| Venus | 1705266 | 500525 | 506450 | — |
| Lista | 1791163 | 544946 | 549406 | — |
| Aave | 1711368 | 490923 | 479967 | 479861、499606 |

本輪每個帳戶初始本金均為 100 USDT（100000000000000000000 raw），精確結算如下：

| 協議 | 歸還本金 raw | 逐筆實損 raw | 利息 raw | 最終 USDT raw |
| --- | ---: | ---: | ---: | ---: |
| Venus | 100000000000000000000 | 0 | 1268290029788 | 100000001268290029788 |
| Lista | 100000000000000000000 | 0 | 713465796984 | 100000000713465796984 |
| Aave | 99999999999999999999 | 1 | 808599699747 | 100000000808599699746 |

本金／利息分類與鏈上現金逐 raw unit 相等；沿用 #109 的逐筆實損規則，沒有以先前利息補回本金。

## 影響與自我 review

自我 review 確認並處理：library unlinked／linked metadata 混用、registry wrappers 的保護需保留、
保存 quote 後須真正跨時間／跨區塊，以及 C3 更正後 min=0 必須在簽名與送出前拒絕。
完整 diff 沒有新增 skip／only／any、放寬型別或停用 DB 檢查。

只更新 chain 97 的 profile／生息簽名 minimum 與測試；chain 56 地址、live 預設、DB schema、
對外 API、#107 再平衡決策與 #108 consented 序列化均未改。新的 executor target 仍須 owner 更新
session 權限；E2E 用真 A10 升權驗證 Kernel 地址不變。未部署、未改 Railway／Cloudflare、未送公開鏈交易。

## 保留證據

ignored `.bun-cache/` 保留 `e2e-final-110.log`、`gas-final-110.json`、`full-c3-clean-110.log`、
`nodb-final-110.log`、`typecheck-final-110.log`、`cre8_be110-final-green-110.dump`、
`anvil-final-green-110.json`，以及更正前與每一輪診斷的 log／DB dump。
本輪只停止自己的 alto 3099 與 `pkill -f "anvil.*--port 8599"`；worktree 與 DB 留給 C3 review。
