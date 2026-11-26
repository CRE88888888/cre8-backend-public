# BE-114：退出代付的未用授權限制

範圍：[backend#114](https://github.com/CRE88888888/backend/issues/114)。前置為 backend `dd04b97`、
DB `d5c6d21`（0001–0042）；不修改 schema、migration、金額結算或其他生息策略。

## 規則

- chain 97 的新 `purpose=exit` 代付授權使用 600 秒效期。明確傳入的 `validUntil` 小於
  請求時間加 600 秒會以 `PAYMASTER_EXPIRED` 拒絕；保留有界效期，最大也為 600 秒。
  ordinary／setup 沿用 300 秒。完整 live hash 重試仍重用原期限與簽章，不延長、不重複收費。
- 每 chain/account/UTC 日最多解除 3 份「到期且 finalized EntryPoint nonce 未消耗」的退出授權。
  第 3 份可以解除，之後的新退出授權以 `PAYMASTER_EXIT_RETRY_LIMIT`（429）拒絕至隔日。
  真正消耗 nonce 的成功與 inner revert 退出不增加此計數；既有完整 live 重試仍可取回。
- 未用退出成本獨立於 ordinary 帳戶額度，gas 與 max-cost wei 都不超過各站台每日額度的
  `floor(cap/10)`。檢查包含所有仍未消耗的退出授權與本次新授權的全部最大成本，
  避免最後一份或並行的未廣播授權越過 10%。
  超過時回 `PAYMASTER_EXIT_UNUSED_BUDGET_EXCEEDED`（429），等號允許；站台的全域 gas／wei
  安全上限及零額度拒絕仍保留。

10% 的保守處理會限制單份新退出授權的最大成本；例如站台 200M gas 時，13.05M 的未用退出
只能授權一次，第二份會被拒絕，其他帳戶仍可使用剩餘站台額度。已消耗的正常退出不計入未用
成本，仍受原站台總額度限制。一般退出也保留未決授權的風險成本；有 receipt 的 confirmed／failed gas ledger 或
已由消耗證據更新的 sponsorship 才解除該風險預留，缺證據時保守保留。每筆歷史
sponsorship 的站台成本一律留帳，不退款。

## 持久化與 UTC 日

沿用 0042 的不可變 `release-<hash>` 證據，與既有 sponsorship／gas ledger 同 transaction 提交；
不新增記憶體計數器、檔案或 DB 欄位。解除證據新增 `utcDay`，取交易開始時的 UTC 日期，
使自動與人工解除即使跨午夜也使用固定日。舊證據沒有 `utcDay` 時取其 DB `created_at` 的 UTC 日。

計數以解除日計算；成本以 sponsorship 原本的 `utc_day` 計算，和站台收費日一致。前一天簽的
授權今天解除會增加今天的次數，但其成本仍留在前一天；今天的新授權另預留今天的 10% 額度。
查詢依原 hash 去重，且不依 sponsorship 後來的 state 退款；同一 executionKey 重簽產生的不同
hash 仍逐份計數與計價。所有 API／scheduler 實例及 paymaster signer 輪替共享相同資料。

既有 chain/account 鎖序列化授權與解除，site/day 鎖序列化站台檢查。RPC 證據仍在短交易外取得，
只有 finalized 嚴格過期、原 nonce 未消耗且 canonical hash 相符才解除。缺證據、過期證據、RPC／DB
失敗及鎖逾時均不發新授權。解除或新授權交易回滾時，證據與兩份 ledger 一起回滾；若同交易
的新授權因配額被拒絕，該次解除也不提交，原在途鎖保留，人工解除仍走同一個受證據保護的入口。

## 驗證

先新增回歸，在修改前實測 **0 pass／0 skip／3 fail**：無廣播連續到期可占用 195.75M／200M
站台 gas；第 3 次解除後仍能申請；1 秒退出期限仍會被接受。

新增測試涵蓋：另一帳戶仍可代付、0／3 次門檻、gas／wei 10% 的前一單位／等號／後一單位、
整數向下取整、UTC 日重設、舊格式證據、正常 nonce 消耗、live 重試、paymaster 輪替、重複解除、
併發申請、交易回滾、DB 鎖逾時及缺漏／損壞統計。RPC／canonical／nonce 錯誤沿用既有回歸。
實際完整測試、CI 清單與 CI run 的最終數字列於 PR。

本次最終結果：三份 tsconfig 通過；完整 suite **1536 pass／16 skip／0 fail**（70 檔），
CI 的 48 檔 no-DB 清單 **1069 pass／27 skip／0 fail**，針對性 4 檔 **35 pass／0 skip／0 fail**。
另以 ignored archive 的原版 `dd04b97` 重跑「他戶仍可代付」回歸，
實測 **0 pass／0 skip／1 fail**：他戶收到 `PAYMASTER_QUOTA_EXCEEDED`。
未啟用的鏈上／fork 測試沿用原 skip，沒有新增 skip。

本機僅使用專用 DB `cre8_be114`；沒有啟動 anvil／alto，沒有公開鏈交易或部署。
