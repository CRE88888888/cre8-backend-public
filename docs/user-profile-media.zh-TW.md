# 使用者名稱、頭像與 My mix 封面（backend#192）

依賴 db 0059（CRE8Finance/cre8-db#82）。小圖存在 Postgres 的 `user_images`，以 uuid 公開讀取。**前端負責縮圖與轉檔**（canvas `toBlob('image/webp')` 或 JPEG），後端只驗 magic bytes 與檔頭寬高，不解碼像素、不引入原生影像套件。

## 規格

- 格式：`image/webp`（VP8／VP8L／VP8X）或 `image/jpeg`；宣告的 contentType 必須與內容一致。
- 大小：1 byte–256 KiB（262,144 bytes，含等於）；寬高 1–2048（含等於）。建議頭像 256×256、封面 1200×630 以內。
- 上傳 body 是 JSON：`{"contentType":"image/webp","dataBase64":"<標準 base64，含 padding>"}`，不接受其他欄位。
- 名稱：去頭尾空白、NFC 正規化後 1–40 個字（以 Unicode code point 計），不得含控制字元；`null` 清除。
- 換圖時新增一列、新 id，舊圖在沒有引用後刪除，所以 `GET /images/:id` 可以 `immutable` 長期快取。

## API（需 SIWE Bearer，除了讀圖）

| 方法與路徑 | body | 回應 |
| --- | --- | --- |
| `GET /me/profile` | — | `{address, displayName, avatarUrl}`；沒設定過是 `null` |
| `PATCH /me/profile` | `{displayName: string \| null}` | 同上 |
| `PUT /me/profile/avatar` | `{contentType, dataBase64}` | 同上（新的 avatarUrl） |
| `DELETE /me/profile/avatar` | — | 同上（avatarUrl=null） |
| `PUT /me/mixes/:id/cover` | `{contentType, dataBase64}` | `{mixId, coverUrl}` |
| `DELETE /me/mixes/:id/cover` | — | `{mixId, coverUrl: null}` |
| `GET /images/:id`（免登入） | — | 圖檔 bytes；`cache-control: public, max-age=31536000, immutable`、`etag`、`x-content-type-options: nosniff`；`If-None-Match` 相符回 304 |

`avatarUrl`／`coverUrl` 是相對 API base 的路徑（例如 `/images/<uuid>`），前端以 `${API_BASE}${avatarUrl}` 讀。`GET /me/mixes`、`GET /me/mixes/:id`、`GET /mixes/shared/:code` 也回 `coverUrl`（分享頁公開）。別人的組合或已刪除的組合設封面回 404 `MIX_NOT_FOUND`。圖片錯誤回 400 `INVALID_IMAGE`、名稱錯誤回 400 `INVALID_DISPLAY_NAME`。寫入共用每錢包 `plan` 限流。CORS 允許方法加上 `PUT`、`DELETE`。
