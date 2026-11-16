# Waitlist API（backend#127）

前置：先套用 db#58 的 migration `0046_waitlist.sql`。名單獨立於 `privy_users`，加入不需錢包、SIWE 或 CRE8 session。這一版只管理名單，**未加入／未 approved 不會阻擋其他既有 API**，也不檢查是否已追蹤 @CRE8Finance。

## 使用者

| 端點 | 憑證與輸入 | 成功回應（200） |
| --- | --- | --- |
| `POST /waitlist/join` | JSON `{ "identityToken": "<Privy identity token>" }` | `{ "status": "waiting", "xHandle": "alice", "joinedAt": "2026-11-16T00:00:00.000001Z" }` |
| `GET /waitlist/me` | `Authorization: Bearer <Privy identity token>` | 同上 |

`me` 只讀 header，**前端不要把 token 放 query string**。所有回應 `Cache-Control: no-store`。join／me 與 `/auth/*` 共用既有的 auth IP 每分鐘限額及 trusted-proxy 規則，超限回 429 `RATE_LIMITED` 與 `Retry-After`。

驗證沿用 `/auth/privy` 的離線 ES256、公鑰、issuer `privy.io`、精確 audience、sub／iat／exp／linked_accounts 規則；設定仍為 `PRIVY_APP_ID`／`PRIVY_VERIFICATION_KEY`，不需要外部 RPC 或 Privy API。為避免變更既有登入行為，本模組保留相同驗證政策，沒有修改 `src/privy.ts`；另限制 sub 不超過 DB 的 256 字元。

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
