# Waitlist API 與登入閘門（backend#127、#133）

前置：先套用 db#58 的 `0046_waitlist.sql` 與 `0049_auth_session_privy_identity.sql`（`auth_sessions.privy_user_id`）。名單獨立於 `privy_users`，加入不需錢包、SIWE 或 CRE8 session。發 session 與所有需要 CRE8 session 的請求皆須通過下述閘門；不檢查是否已追蹤 @CRE8Finance。

## 登入與 session 閘門

`POST /auth/privy` 離線驗證 identity token 後，只使用已驗證的 `sub`（Privy user ID，最多 256 字元）查 `waitlist.privy_user_id` 唯一鍵；不採信 body 的 user ID、X ID、handle、owner 或 status。首次登入先查核准，再建立唯一有效 EVM 錢包的 owner mapping；未核准不寫任何 owner 綁定或 session。已存在的 owner 綁定仍保留首次登入的錢包，不因後續 linked wallets 改變。

一般錢包的純 SIWE `POST /auth/login` 一律拒絕，即使該錢包曾綁到已核准身分也不能借用資格。須改用 X 的 Privy 登入。未加入、`waiting`、`revoked`、缺少 session 身分與一般 SIWE 統一回 **403 `WAITLIST_PENDING`**，訊息為 `waitlist approval is required; sign in with X`，不透露名單狀態。其他既有的輸入／驗簽錯誤碼保持不變；operator SIWE 例外見下文。

Privy session 持久保存已驗證的 `privy_user_id`；每次驗證有效且未過期的 CRE8 session，只查該身分目前的放行狀態，沒有核准快取、不掃 `privy_users.owner_address`。同錢包的其他身分或歷史綁定不影響此 session。撤銷後，跨實例與重啟前已發出的 session，下一個受保護請求即回 403；重新核准後，尚未過期的 session 可再次使用。

0049 保留舊 session 的 `privy_user_id = NULL`，不從錢包回填身分；只有目前仍在 operator 白名單的錢包能使用 NULL session。一般舊 session 必須重新經 Privy 登入，防止把其他人的核准附加到既有錢包 session。

`OPERATOR_WALLETS` 與 `/operator/*` 共用同一解析函式，每次檢查讀取目前設定。白名單錢包可經 SIWE 或 Privy 登入，並使用既有 session，不需 waitlist；SIWE 不需 Privy 綁定，Privy 本身的 token／owner 驗證與綁定流程仍適用。白名單缺省／空白不豁免任何人；整份有無效項目時回既有 503 `INVALID_OPERATOR_WALLETS`，不部分放行。

閘門內的名單查詢失敗、statement timeout 或缺表，一律拒絕並回 **503 `WAITLIST_UNAVAILABLE`**，不回傳底層 SQL、連線資訊或 token。Privy 的 owner 查詢或核准後綁定建立失敗仍回既有 `PRIVY_UNAVAILABLE`。operator 的名單豁免不會略過 session DB 自身的讀寫要求。

`/waitlist/*` 仍使用 Privy identity token，不受 CRE8 session 閘門影響；`/health`、基金列表／詳情、公開預覽與其他原本公開的唯讀端點維持公開。`/auth/nonce` 與 `/auth/logout` 也不要求 waitlist 核准。邀請碼 #131 只需把該筆名單設為 `approved`，本閘門無須依賴邀請碼實作。

## 使用者

| 端點 | 憑證與輸入 | 成功回應（200） |
| --- | --- | --- |
| `POST /waitlist/join` | JSON `{ "identityToken": "<Privy identity token>" }` | `{ "status": "waiting", "xHandle": "alice", "joinedAt": "2026-11-16T00:00:00.000001Z" }` |
| `GET /waitlist/me` | `Authorization: Bearer <Privy identity token>` | 同上 |

`me` 只讀 header，**前端不要把 token 放 query string**。所有回應 `Cache-Control: no-store`。join／me 與 `/auth/*` 共用既有的 auth IP 每分鐘限額及 trusted-proxy 規則，超限回 429 `RATE_LIMITED` 與 `Retry-After`。

驗證沿用 `/auth/privy` 的離線 ES256、公鑰、issuer `privy.io`、精確 audience、sub／iat／exp／linked_accounts 規則；設定仍為 `PRIVY_APP_ID`／`PRIVY_VERIFICATION_KEY`，不需要外部 RPC 或 Privy API。本模組保留相同驗證政策，另限制 sub 不超過 DB 的 256 字元。

X 身分只取已驗證 `linked_accounts` JSON 字串內唯一的 `twitter_oauth`：`subject` → X ID、`username` → handle（不含 `@`）。欄位對應依 [Privy 官方 SDK](https://github.com/privy-io/node-sdk/blob/main/src/lib/identity-token.ts)。必須有完整且唯一的 X 帳號；ID 為 1–20 位正整數字串，handle 為 1–15 位英數或底線。前端傳入的 X ID／handle／Privy user ID 一律不採用。

同 Privy user＋同 X ID 的 join 可重試，更新 handle、保留 joinedAt／status／核准紀錄；不建立 CRE8 session 或 wallet mapping。同 X ID 不可由第二個 Privy user 加入；既有 Privy user 改綁另一個 X ID 也拒絕，避免把已核准資格移轉給別人。revoked 對使用者回 `waiting`，重新 join 不會自動復權。`me` 依已驗證 Privy user 查現有名單，不要求目前 token 仍附 X 帳號，也不更新 handle。

| 錯誤 | HTTP／code |
| --- | --- |
| body／token 型態或長度不合法（token 上限 65,536 字元） | 400 `INVALID_AUTH`（JSON 語法錯誤為 `INVALID_JSON`） |
| token 無效、過期、簽章／claims 錯誤；me 缺 bearer | 401 `UNAUTHORIZED` |
| join 未綁唯一有效 X 帳號 | 409 `X_REQUIRED` |
| X ID 已屬他人、或原 Privy user 嘗試更換 X ID | 409 `X_ALREADY_JOINED` |
| me 尚未加入 | 404 `NOT_JOINED` |
| Privy 未設定／公鑰無效 | 503 `PRIVY_UNAVAILABLE` |
| DB 失敗／逾時／缺少 migration | 503 `WAITLIST_UNAVAILABLE` |

## 營運

全部位於既有 `/operator/*` 共用授權之後：以 **CRE8 session** bearer 驗登入（401），並驗 `OPERATOR_WALLETS`（已登入但非白名單時，list／approve／revoke 都回 403 `OPERATOR_FORBIDDEN`）。放行與撤銷只寫 DB，不送鏈上交易；所有 waitlist 營運端點均不受 `ENABLE_OPERATOR_REBALANCE` 影響。此開關仍預設關閉，只限制投組相關營運 POST（包含 close／rebalance），未啟用時回 403 `OPERATOR_REBALANCE_DISABLED`；owner 手動再平衡的既有開關要求不變。

- `GET /operator/waitlist?status=waiting&limit=50&cursor=<nextCursor>`：回 `{ "items": [...], "nextCursor": "..." }`；最後一頁 cursor 為 null。每筆包含字串 `id`、`privyUserId`、`xUserId`、`xHandle`、`joinedAt`、`status`、`approvedAt`（可 null）、`approvedBy`（可 null）。不回任何 token。
- status 可省略（所有狀態），或為 waiting／approved／revoked。limit 預設 50，接受整數 1–100。按 `(joined_at,id)` 由舊到新分頁，保留微秒及完整 bigint 精度；cursor 只能搭配原 status，錯誤參數回 400 `INVALID_QUERY`。cursor 是位置，不是名單快照；翻頁期間若營運改狀態，重新載入可取得目前完整名單。
- `POST /operator/waitlist/:id/approve`：waiting／revoked → approved，記 DB 時間與已登入營運錢包（小寫）為 approvedBy，清除 revoked_at。同狀態重試保留原核准者與時間。回完整營運名單單筆。
- `POST /operator/waitlist/:id/revoke`：approved → revoked，記 DB 時間並保留上次核准資訊。同狀態重試不更改紀錄。waiting → revoked 回 409 `INVALID_WAITLIST_TRANSITION`。回完整營運名單單筆。

id 必須是正的 Postgres bigint 字串，最大 `9223372036854775807`，錯誤為 400 `INVALID_ID`，不存在為 404 `NOT_JOINED`。轉換用 transaction＋row lock；重複或競爭請求不覆寫第一筆相同狀態的核准資訊。DB 鎖／statement timeout 最多 5 秒（連線仍沿用共用設定）；錯誤不回傳底層 SQL、token 或連線資訊。禁止 DELETE／TRUNCATE，由 0046 trigger 保護。

## 驗證

`test/waitlist.test.ts` 覆蓋 token、輸入／邊界、HTTP、授權、限流及錯誤去敏，已由既有 no-DB CI 入口 `test/server.test.ts` 載入。`test/waitlist.db.test.ts` 在已套 0046 的可拋棄 Postgres 驗證並行 join／衝突、核准／撤銷、狀態冪等、微秒／bigint 分頁及真實 row-lock timeout。因表禁止刪除，DB 測試使用獨立身分並保留測試名單；只對專用可拋棄資料庫執行。

`test/waitlist-access.test.ts` 由同一 no-DB CI 入口載入，驗證登入狀態矩陣、operator 例外、撤銷／過期邊界、錯誤去敏與公開端點。`test/waitlist-access.db.test.ts` 用真實 Postgres 驗證實際邀請碼兌換 → Privy 登入、借用核准錢包的 SIWE 拒絕、未核准登入不寫綁定／不影響核准者、session 身分持久化與 NULL 舊 session、跨實例撤銷，以及真實 table-lock 造成的 statement timeout。其他既有 HTTP 測試以離線簽署的 Privy token 與已核准測試名單取得真實 session；SIWE 專用測試明確使用 operator 例外。

## 邀請碼（backend#131）

前置為 db#62 的 `0048_waitlist_invites.sql`（依賴 0046）。與積分系統的 `/invites/me`、`/invites/bind` 分開。

`POST /waitlist/redeem`：JSON `{ "identityToken": "<Privy identity token>", "code": "ABCDEFGH23" }`。
驗 token 與唯一 `twitter_oauth` 的規則與 join 相同，只採用簽章內的 Privy ID／X ID／handle，不需錢包或 CRE8 session。
成功回 200，格式同 join：`{ "status": "approved", "xHandle": "alice", "joinedAt": "2026-11-16T00:00:00.000001Z" }`。
可直接建立 waiting 名單後在同交易核准，或核准既有 waiting；保留原 joinedAt，更新 handle，`approved_by` 記 `invite:<id>`。
依 0048 契約，revoked 名單須由營運重新核准，不可用邀請碼復權（409 `INVALID_WAITLIST_TRANSITION`）。

輸入 code 去除首尾空白並轉大寫，接受 8–10 字元英數碼，排除 `0`、`1`、`I`、`L`、`O`；本版產生 10 字元。
每字元取加密安全亂數，約 49 位元熵；只存正規化 code 的 SHA-256（64 位大寫 hex，0048 的 `code` 欄位），不存明碼、可還原加密值或尾碼。

兌換獨立限額為每個 IP 每分鐘 10 次、每個驗證成功的 Privy user 每分鐘 5 次（錯碼／無 X 也計次）。
IP 在讀 body 前計次，採既有 trusted-proxy 規則；更換來源 IP 不會重設 user 限額。超限回 429 `RATE_LIMITED` 與 `Retry-After`。
限額採與既有 auth 短窗同類的程序內記憶體、UTC 固定分鐘窗與有界容量；重啟會重算，多個 API instance 各自計次，並非跨 instance 的持久化配額。
限額儲存失敗／容量不足時拒絕請求並回 503 `RATE_LIMIT_UNAVAILABLE`。

| 兌換結果 | HTTP／code |
| --- | --- |
| 碼格式錯誤或查無雜湊 | 404 `INVITE_INVALID` |
| 已使用 | 409 `INVITE_USED` |
| 已作廢或到期（期限相等即到期） | 410 `INVITE_EXPIRED` |
| 對應名單已 approved（不消耗新碼） | 409 `ALREADY_APPROVED` |
| revoked 名單 | 409 `INVALID_WAITLIST_TRANSITION` |
| X 未綁／衝突 | 409 `X_REQUIRED`／`X_ALREADY_JOINED` |
| DB 失敗／缺表／逾時 | 503 `INVITES_UNAVAILABLE` |

其餘 token／JSON 錯誤同 join。錯誤只有固定訊息，不回碼、雜湊、收件人、兌換者、SQL 或底層錯誤；名單已 approved 的檢查先於已用／到期檢查。
交易先鎖邀請碼、再鎖名單，0048 trigger 在取得兩個鎖後以 DB 時鐘再次驗期限，並在同交易寫入使用與核准證據。
失敗整筆回滾，不會留下新名單或半次消耗；同一碼並行只有一次成功，同一人用不同碼競爭只消耗一碼。
寫入交易的 lock／statement timeout 各 5 秒，不做 DB 失敗後的自動重試。

### 營運邀請碼

沿用 `/operator/*` 的 CRE8 session 與 `OPERATOR_WALLETS` 白名單，未登入 401、非白名單 403，不受再平衡開關影響。所有回應 `Cache-Control: no-store`。

- `POST /operator/waitlist/invites`：JSON `{ "count": 2, "issuedTo": "@alice", "batchNote": "launch", "expiresAt": "2026-12-01T00:00:00.000Z" }`。count 必須為整數 1–500；issuedTo／batchNote 可省略、null 或空白（存 null），非空最多 256 字元。expiresAt 可省略／null，否則為未來 UTC ISO 日期（秒或三位毫秒）。錯誤回 400 `INVALID_INVITE_INPUT`。整批原子寫入，回 200 `{ "batchId": "<UUID>", "issuedTo": "@alice", "batchNote": "launch", "expiresAt": "2026-12-01T00:00:00.000Z", "items": [{ "id": "1", "code": "ABCDEFGH23" }, ...] }`。**明碼只在這一次回應出現，營運須當次保存／發送，無法再次取回。** 重送 POST 會建立另一批。
- `GET /operator/waitlist/invites?status=unused&batch=<UUID>&cursor=<nextCursor>&limit=50`：回 `{ "items": [...], "nextCursor": "..." }`。每筆為字串 id、固定 `codeMasked: "**********"`、batchId、batchNote、issuedTo、status、createdBy、createdAt、expiresAt、usedByWaitlistId、xHandle、usedAt、revokedAt、revokedBy。尚未使用者的 use 欄位為 null，不回 code 或雜湊。status 可省略或為 unused／used／revoked／expired；expired 是 DB unused 且期限已到的查詢投影。batch 可省略。limit 預設 50、範圍 1–100，按 `(created_at,id)` 由舊到新分頁，cursor 保留微秒／bigint 並綁定 status 與 batch，錯誤回 400 `INVALID_QUERY`。分頁為即時資料位置，不是狀態快照。
- `GET /operator/waitlist/invites/summary?batch=<UUID>`：按 issuedTo 彙總，可選 batch；回 `{ "items": [{ "issuedTo": "@alice", "issued": "2", "used": "1" }] }`。未填收件人的一組 issuedTo 為 null，計數為完整精度十進位字串。issued 包含 used／revoked／已到期，used 只計已成功使用。
- `POST /operator/waitlist/invites/:id/revoke`：回 `{ "id": "1", "status": "revoked" }`。unused（含已到期）可作廢，DB 記已登入營運錢包小寫與 revokedAt；已 revoked 重試不改原紀錄，used 回 409 `INVITE_USED`。id 必須為正 bigint（最大 `9223372036854775807`），錯誤為 400 `INVALID_ID`，不存在為 404 `INVITE_INVALID`。此端點不撤銷使用者資格，既有名單撤銷端點仍獨立運作。

`test/waitlist-invites.test.ts` 由既有 no-DB CI 的 server 測試入口載入；`test/waitlist-invites.db.test.ts` 用已套 0048 的專用可拋棄 Postgres 驗證並行兌換、回滾、過期跨鎖等待、作廢、彙總、微秒／bigint 分頁及真實鎖逾時。測試保留所有邀請與名單，不刪除受保護的資料。
