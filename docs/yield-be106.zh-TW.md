# BE-106：新版生息 manifest 與 Kernel 驗收

contracts checkout 為 `8abbc61`；該 commit 重產的 manifest 標記 Solidity 來源 `84e70fd`。
executor／registry runtime 以本機部署後的 bytecode 核對 forge artifact，僅忽略編譯器列出的 immutable 槽，
再記錄含 immutable 的實際 codehash。`deploy/testnet-97-codehashes.json` 同時保留兩個 commit 與 capture block/hash。

新 registry 不提供跨交易的 `reserveSupply`／`totalReserved`。reader 只用 DB 的在途預留，
不掃描 bytecode 推測能力；production profile 的 registry hash 不符、空 code 或 RPC 失敗均拒讀。
ABI 直接讀取 forge artifact，不呼叫可能重新編譯、改動來源 checkout 的 `forge inspect`。

## 本機重跑

只用自己的 anvil **8599**、alto **3099**、Postgres **cre8_be106**。
`PORT=8699` 是 lane 防呆；此驗收直接呼叫正式 yield service／scheduler，沒有啟動 HTTP server。
先準備全新的專用 DB，設定自己的 `DATABASE_URL`；不得指向其他 lane 的資料庫。
`MIGRATIONS_DIR` 必須指向 workspace 的 `db/migrations`。

1. 唯讀核對 contracts checkout 在 `8abbc61` 或其後；本次固定以 `git archive 8abbc61` 解到本 worktree
   的 `.bun-cache/contracts-106`，使用 archive 內的固定版本 `lib/`，再把已編譯 `out/`、`cache/` 的內容複製至副本對應目錄。
   所有 forge 執行、broadcast 與編譯輸出留在副本，不在來源 contracts repo 執行部署腳本。
2. anvil 使用 chain 97 的歷史 fork 區塊：部署時間至少比牆鐘早 30 分鐘，且仍在上游可讀歷史範圍內。
   啟動加 `--chain-id 97 --port 8599 --hardfork cancun --prune-history 256`，隨即設定
   `anvil_setBlockTimestampInterval(0)`。只在自己的 fork impersonate manifest 的 deployer／owner 並補假 BNB。
3. 在副本依序跑 `forge script script/DeployTestnet.s.sol --rpc-url http://127.0.0.1:8599 --broadcast --slow
   --gas-estimate-multiplier 300 --unlocked --sender <manifest deployer>`。有 `PENDING_MARKETS`、
   `PENDING_YIELD_MARKETS` 或 `PENDING_HANDOVER` 就用 `evm_setNextBlockTimestamp(目前區塊時間 + 2)`、mine，再跑一次；全部消失才代表 C1 完整部署與交接成功。
   不讀取 `~/.cre8-testnet/`，也不執行 public 模式。
4. 回 backend worktree 對固定副本執行生成。副本沒有 `.git`，以下用原 checkout 的唯讀 git object database，
   搭配明確 `8abbc61` revision 核對 compiler metadata 裡每份 source 的 keccak；不讀正在改動的 `out/`，也不跟著活動 HEAD 漂移。

```sh
GIT_DIR="$(git -C <唯讀 contracts checkout> rev-parse --absolute-git-dir)" \
GIT_WORK_TREE="$PWD/.bun-cache/contracts-106" \
bun --no-env-file scripts/sync-testnet-profile.ts "$PWD/.bun-cache/contracts-106" http://127.0.0.1:8599 fork 8abbc61
```

本次歷史 fork 的 C1 腳本停在 LP-NFT 暖機／交接，最後一次 pool mint 的模擬回裸 revert；**沒有宣稱 C1 完整部署預演通過**。
全部 92 資產、30 市場、380 runtime pins 已存在，executor／registry 也與固定 artifact 一致。
backend 生息驗收不需要 LP-NFT 交接；本機 setup 另以既有 deployer minter 權限補 keeper 1,000 MockUSDT 庫存，
測試會先檢查庫存才做真 swap，沒有修改 minter、合約程式或省略 DB 檢查。

5. mine 120 個本機區塊，讓 alto 的最近 100 塊 logs 範圍留在本機。參照 contracts
   `scripts/testnet/kernel-smoke/run-fork.sh`，在 **3099** 起 `@pimlico/alto@0.0.18`：safe-mode 開啟、
   EntryPoint 0.7、timeout 120000、max-block-range 100、min stake／unstake delay 1。
   executor／utility 分別用公開 anvil 助記詞的 #4／#5，透過 `ALTO_EXECUTOR_PRIVATE_KEYS`／
   `ALTO_UTILITY_PRIVATE_KEY` 環境變數傳遞，不印出、不放命令列參數。
6. 在專用 DB 與指定 migration 環境下執行：

```sh
CHAIN_ID=97 RPC_URL=http://127.0.0.1:8599 BUNDLER_URL=http://127.0.0.1:3099 \
PORT=8699 TEST_DATABASE_NAME=cre8_be106 ENABLE_YIELD_EXECUTION=1 \
bun --no-env-file test ./test/yield-106.fork.ts --timeout=1200000
```

測試會把鏈時間追到當下牆鐘，維持正常 DB freshness／future-time trigger，使用實際經過的秒數計息。
不替換 PostgreSQL 時鐘、不停用 trigger、不調整模擬 APR、不折減生息 minimum。
追時後以 keeper 真正交換 1,000 USDT 更新 WBNB 池的 observation，並推新 WBNB／USDT feed，供既有 gas budget oracle 讀價。
只在本機替換 paymaster immutable signer 為公開 anvil #6；先核對原始全部 runtime pins，結束後還原原 code。
paymaster 的驗簽、EntryPoint 存款扣款、DB sponsorship 與 gas budget 都照正式路徑執行。
owner／session 私鑰只由公開測試材料在記憶體產生，DB snapshot 只保存公開 payload／nonce／hash。

三協議各使用一個 USDT 市場，依序驗 owner 升權且 Kernel 地址不變、max policy 同意、正式 scheduler 供給、
原始快照重建與獨立 receipt 對帳、計息、流動性不足的部分領回、owner 停止生息、全退及鏈／DB 歸零。
同時核對實收利息僅入帳一次、本金復原、Kernel 無原生 gas 資金。最後在 Aave 帳戶把真實代付操作累計到 60，
第 61 次須拒絕且不新增預留、不改 nonce。輸出 `YIELD_106_GAS` 與 `YIELD_106_ACCEPTANCE` 實際結果。

結束只停這次啟動的 alto PID，並使用 `pkill -f "anvil.*--port 8599"` 停自己的 fork；不清其他 lane 的程序。

## 合併與部署影響

本分支已以包含 #104／#107 與 #105／#108 的 `fe4d146` 為基礎；不修改它們的再平衡領回決策或 execution consented 序列化。
唯一重疊是測試 fixture，保留兩邊需要的欄位；本 PR 排在 #107／#108 之後合併。
本次更新 chain 97 executor／registry 地址及 codehash，依新 executor 重產 owner renewal golden；舊 target 的 session
必須由 owner 更新權限。不調整 chain 56 的位址與啟用條件；不修改 DB schema、Railway／Cloudflare。
`ENABLE_YIELD_EXECUTION` 仍預設關閉；本機驗收的開關不構成部署授權。

## Aave 結算（C3 擴大範圍）

本次原始 fork 的 raw aToken 供給 shares 為 `99999999999999999999`，兩次領回 raw shares 合計
`100000000428082192684`，原固定份額 FIFO 因 rebasing 耗盡 lot。DB 回歸先重現 **0 pass／1 fail**，
再改為 Aave 專用 scaled 比例分配：使用原始 plan 的 scaled balance 與同 canonical block/hash 的
append-only position snapshot，按 `(scaledBefore - scaledAfter) / scaledBefore` 消耗剩餘來源本金。
全退（scaledAfter=0）取完剩餘來源，只有實收超過消耗本金的部分才進 `yield_raw`；實損不補本金。
Venus／Lista 保持原本 FIFO。依鏈序重播供給與領回，後來的供給不會補前次領回。

缺原始 scaled balance、斷裂的 scaled 歷史或互相矛盾的同塊快照，都回滾結算並保留 unknown；
不以 raw aToken 差額猜本金。DB 回歸另外覆蓋 RPC 逾時、DB transaction 失敗、重啟／重複對帳及原子回滾。
外來未分類的 scaled receipt 變動也會保守保留在途，需要取得完整來源證據後才能入帳。

保留 prune 模式時，E2E 的事後 Aave receipt 對帳需要有限歷史狀態，因此本輪使用 `--prune-history 256`。
未帶數字的 prune 會刪掉先前部分領回區塊，後續查 ray index／scaled balance 會讀不到；
第一次續跑已完成三協議鏈與 DB 歸零，但在此歷史讀取失敗，未列為整輪通過。

每日次數的 nonce 證據直接讀 EntryPoint 的同一個 `uint192` key，並把原 nonce 帶入第 61 次嘗試。
SDK 的無參數 `getNonce()` 每次消耗新的 nonce key，不能連叫兩次比較；先前測試因此在第 61 次已拒絕、
DB 仍為 60 筆時誤判 nonce 改變。最終測試另外確認拒絕不新增 gas reservation。

## 最終驗收結果

| 驗證 | pass | skip | fail |
| --- | ---: | ---: | ---: |
| CI no-DB 同清單（48 檔） | 1054 | 27 | 0 |
| 乾淨專用 Postgres 完整 suite（68 檔） | 1490 | 16 | 0 |
| domain＋DB focused（含缺證據、矛盾快照、RPC／DB 回滾） | 34 | 0 | 0 |
| Kernel／alto 完整 E2E（1 個整輪測試） | 1 | 0 | 0 |
| E2E 明確 assertion | 123 | 0 | 0 |

`bun install --frozen-lockfile` 成功（85 installs／83 packages，lockfile 無變更）；
`bun run typecheck` 的 src／test／scripts 全部通過。
完整 suite 使用 `ANVIL_RPC_URL=http://127.0.0.1:8599 bun --no-env-file test --timeout=120000`，
CI no-DB 依 `.github/workflows/ci.yml` 的同一份 48 檔清單執行。16 個既有 skip 是未啟用的鏈上交易／chain 56 fork 等測試；沒有新增 skip。

三協議均完成 A10 升權、max consent、scheduler 代付供給、計息、部分領回、停止全退、鏈／DB 歸零，
本金復原且實收利息只入帳一次。共 **72 筆成功 UserOp**；三個帳戶的 sponsorship 計數是 **6／6／60**。
第 60 次真代付成功，第 61 次回 `PAYMASTER_QUOTA_EXCEEDED`，DB 計數、gas 預留及 EntryPoint 同一 nonce key 均不變。
最終 **9 confirmed／0 unresolved** 生息操作，72 個 gas budget 均 confirmed，Kernel 原生 gas 餘額為 0。

以下為 EntryPoint `actualGasUsed`（本機 gas，非公開鏈費用估算）：

| 協議 | supply | partial withdraw | final withdraw |
| --- | ---: | ---: | ---: |
| Venus | 1687281 | 463349 | 491559 |
| Lista | 1779941 | 515414 | 535097 |
| Aave | 1711249 | 478383 | 484845 |

完整 suite 與 E2E 分開重建同一個專用 DB；前一次混用 E2E 資料的 suite 是 **1489 pass／16 skip／1 fail**，
原因為既有每日 site 配額資料污染，清空專用 DB 後重跑得到上表結果，未改配額或斷言。
prune 歷史與 SDK nonce key 的兩次 E2E 診斷輪各為 **0 pass／1 fail**，均未冒充通過；最終整輪已真正重跑。
C1 的 LP-NFT 暖機／交接預演仍未列為通過，contracts#49 第二輪介面依 C3 另行通知同步。

證據留在本 worktree 的 `.bun-cache/`：`e2e-final-106.log`、`gas-final-106.json`、
`full-clean-c3-106.log`、`nodb-final-c3-106.log`、`cre8_be106-final-green.dump`、`anvil-final-green-106.json`。
原始失敗 dump 與事件證據也保留。這些本機檔案不進版控；完成後只停自己的 8599／3099 程序。
