# BE-4 生息 UserOp 管線（#85）

本次只交付 chain 97 的 ABI、owner 升權、代付分類、報價、送出與對帳。沒有新增 HTTP 路由、排程讀值／市場監測或生息開關，也不寫尚未完成的 db 0036。BE-3（#84）整合、0036 adapter 與 APP-3 驗收完成前維持關閉。

## 部署與重產

來源是 contracts PR #49 的 `deployments/testnet-97.json`，manifest `gitCommit=2052c828b0c8afddfd8d98bd0b5fc6207268fc05`；驗收 checkout 為 `74d22927f7399da8f3f4d320a784e99379305084`，兩者只差 manifest／文件，Solidity 相同。完整取代舊 chain-97 部署，沒有混用舊 registry／USDT／資產。主網 profile 不變。

```bash
bun scripts/sync-testnet-profile.ts <固定版本的 contracts checkout> http://127.0.0.1:8592 fork
```

輸入必須是 chainId 97、指定 mode（預設 `fork`；`public` 需顯式指定）、92 資產、30 個不重複市場。會核對角色／地址、資產配對、marketId 的 protocol／underlying 承諾及模擬利率標示；不符即失敗。補充的 decimals／pool fee 與既有上架 cap 使用 backend 已核對的 92 資產規格及 38 個 launch cap，沒有在執行期讀主網 DB。

codehash 來源是本機 anvil 上 `forge DeployTestnet` 部署後的完整 runtime（包含 immutable），保存於 `deploy/testnet-97-codehashes.json`。executor 與 yield registry 另與 forge artifact 的 `deployedBytecode` 比對，只遮掉 compiler 宣告的 `immutableReferences`；來源 commit、實際 forge checkout、區塊號／hash 一起保存。**不是對未填 immutable 的 runtime template 直接取 hash。** 所有 manifest 合約、資產 token／pool／oracle／feed／secondary，以及 30 市場 target／receipt 共 380 個檢查點都會釘 hash。ABI 由 `forge inspect AtpExecutor abi --json`、`forge inspect AtpYieldRegistry abi --json` 產生。

腳本重產 `deploy/testnet-97.json`、codehash 證據、`src/testnet-profile-data.ts`、`src/testnet-codehashes.ts`、`src/yield-abi.ts` 與 `test/fixtures/yield-golden.json`。讀取／驗證完成後才寫產物；只接受沒有 credentials／query 的 localhost anvil，不讀金鑰。

APP（C2）需同步整份 manifest 的 roles、contracts（含 registry／router／USDT／paymaster／oracle／executor／yieldRegistry）、92 個 assets、30 個 yieldMarkets 及相同的 runtime pins／來源版本。`mode=fork` 表示本機驗證，不能顯示成已公開部署。

## 權限與介面

- `executeSupply(address,bytes32,uint256,uint256,uint256)`：`0x5728db07`，ordinary。
- `executeWithdraw(address,bytes32,uint256,uint256,uint256)`：`0x63f865c0`，exit。
- `buildSessionPermissions({yieldAccount})` 只支援 chain 97 的 owner 升權；額外兩條 CALL 都鎖 target=executor、value=0、argument 0=既有 account。approve／policy／reserve 不加入 session 權限。
- 原始 enrollment 的 initConfig、salt 與派生規則不加新權限；既有帳戶經 `GET /portfolios/:id/renewal-params` → owner 安裝兩筆 initConfig → `renewal-result`。帳戶地址直接使用 DB 值，不重新部署／推導。
- `yieldAuthorization(snapshot,account,executor)` 回 `ready` 或 `authorization_required`。`submitYieldAction` 對舊權限拋 HTTP-compatible `409 SESSION_AUTHORIZATION_REQUIRED`，訊息「需要更新授權」，不先排送失敗交易；鏈上仍需安裝且與派生的 permissionId 相符。
- APP-3 共用 `test/fixtures/yield-golden.json` 的 permissionId、完整 policy／initConfig、三協議 calldata。這些是編碼向量，`amountRaw=minimumRaw=1` **不是協議報價**。可用 `bun scripts/gen-yield-golden.ts` 重產。

## 報價、gas 與退出

`quoteYieldAction` 將 market 身分、non-view `quoteSupply`／`quoteWithdraw` 的 eth_call、餘額與 executor 預演釘在同一 canonical block。依 #110 現行規格，min = floor(quote × 9995 / 10000)，以 bigint 先乘再除且必須正數；quote=0 或 1 均拒送，不能補成 1；deadline 取鏈上時間加 1–300 秒，預設 300。Aave 另保存 scaled receipt balance，公開 amount／min／事件仍使用 raw aToken／underlying，不混用單位。

`submitYieldAction` 用既有 Kernel 派生器、自架 bundler 與 `schedulerPaymaster`。call gas 是實際估算 **200%**，不裁掉餘裕；和既有分批共用 `assertUserOpCapacity`／`userOpGasOverhead`，含 verification／preVerification／paymaster 的整筆 gas 不超過 **14M**。paymaster 再檢查最終 gas；超過就拒絕，不強送。

所有供給沿用 0030 的 ordinary ledger 與既有 paymaster 每帳戶每日 60 次／每日 gas、站台 gas／wei 上限。purpose 以最終 canonical Kernel calldata 判斷；混入 supply 就不能冒充純 exit。純 withdraw（包含部分退出）不讀買入配額、最低換幣量、供給 cooldown／節流；ordinary 用盡仍可送，仍保留站台安全額度。BE-3 認領時須先處理退出 intent，再做新供給；不能把買入／供給的 blocked 狀態拿來阻擋此獨立退出入口。

Venus／Lista 補息可能讓舊區塊的 min 失效。只對 ABI 已證明的 `YieldMinimum` 重取完整 quote，總共最多 3 次；每次都重新編碼 payload。送出後只有 canonical EntryPoint 失敗、無業務／資產異動且已記錄 reverted，才可新 quote 重試。RPC timeout、送出未取得 hash、DB commit 未知及證據缺漏一律保留在途。**不降低舊 min，也不以任意 bps 或 rounding tolerance 解鎖。** 三次仍失敗會回 `YIELD_QUOTE_RETRY_EXHAUSTED`。

以下為 #85 歷史驗收；已由 [#110 跨區塊驗收](yield-be110.zh-TW.md) 取代。當時 fork 成功路徑固定 anvil timestamp，以可重現地驗同狀態 min；另實際推進時間驗舊 quote 拒絕，以及連續三次補息後重報價達上限、沒有送出。這不保證公開鏈跨區塊一定成交，尤其真 Venus 按區塊補息；若產品要求保證執行，需要 C3／C1 另定同交易原子 quote 介面。本 PR 不擴充合約或放寬 min。Aave 的固定 raw aToken 領出額不因 index 上升而改變該 raw 額的 underlying quote，退出全額需重讀最新 raw balance。

## 0036／BE-3 的持久化契約

`YieldOperationJournal` 是必要依賴，沒有記憶體 production fallback：

1. `prepare`：在同帳戶／市場鎖下排除未決操作，原子保存 chain/account/market、kind、raw amount/min、quote block/hash、deadline、資產／收據餘額（Aave 含 scaled balance）、最終 canonical calldata、完整 nonce、executionKey、預算對應及預先算出的 UserOp hash。金額／nonce lossless 序列化。commit 未知不能另開 attempt。
2. `sending`／`submitted`：send RPC 前先標在途；拿到 hash 後保存，且必須與預先保存的 hash 相符。任何 timeout／寫入不確定走 `unknown`，不釋放供給預留或允許重送。
3. `confirmed`／`reverted`：CAS 終態，`unknown` 不可覆寫已提交的終態。部分領出 `remainingReceipts>0` 保留退出 intent 與剩餘部位；剩餘不明不能當 0。失敗／未知 gas 預留仍計入同一份 0030 ledger。
4. 重啟以保存的 `SavedYieldOperation` 呼叫 `reconcileYieldOperation`，不重新規劃舊單。核對原 UserOp hash／nonce／完整 payload、canonical tx／block、獨立鏈上 EntryPoint event、限定該 UserOp 的業務事件及 token 差額；再 CAS 落庫、settle 既有 gas ledger，才允許下一筆。

Aave 的 Transfer 是名目 raw action amount，與 floor/ceil 後的實際 aToken balance 可能不同。對帳另外讀同 receipt block 的完整 ray index、scaledBalanceOf、balanceOf，精確重算 mint floor／transfer burn ceil 與剩餘值；沒有「差 1 就放過」的規則。

本次不對現有 `operations.type` 塞供給／領出、不新增 SQL／第二套 gas 帳本。0036 的 DB adapter、供給預留／job 鍵、同帳戶／共池認領、退出優先隊列、掃描／API／告警與開關屬 BE-3。

## 本機驗收

只用 anvil 公開測試助記詞，不讀 `~/.cre8-testnet/`。固定 contracts checkout 放本 worktree 的 `.bun-cache/`，先用 contracts 的 `deploy-97.sh fork` 部署到 **8592**，暖 TWAP／推 feeds；alto 用 **3092**（safe-mode），backend 若啟動只用 **8692**，DB 只用 **cre8_be85**。

```bash
CHAIN_ID=97 RPC_URL=http://127.0.0.1:8592 BUNDLER_URL=http://127.0.0.1:3092 PORT=8692 \
DATABASE_URL=postgres://localhost/cre8_be85 \
MIGRATIONS_DIR=../db/migrations \
bun test ./test/yield-85.fork.ts --timeout=1200000
```

fixture 對三個 USDT 市場建立各自的真 Kernel 帳戶，避免同 underlying 24 小時供給限制；只在已確認的本機 anvil 替換 paymaster immutable signer 為公開測試 signer，finally 還原並核對。驗 backend 舊 session 明確拒絕、鏈上 CallPolicy 拒絕、owner 升權、三協議存領、暫停／ordinary 用盡仍退出、部分領出成功但 DB commit 未知的對帳恢復。實際測試數字與 UserOp gas 以 PR「怎麼驗證」為準。
