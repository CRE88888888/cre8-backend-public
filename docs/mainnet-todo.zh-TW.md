# 主網上線前的待辦（2026-11）

依「什麼會先咬到我們」排序。狀態：`[x]` 已完成、`[ ]` 未做。

## 1. 排程器 supervisor `[x]`

- `scheduler_status` 表（migration 0018）：每輪寫心跳（`started_at` / `last_finished_at` /
  `rounds` / `dry_run` / `limit` / `threshold` / `last_summary` / `last_error` / `pid`）
- `/operator/overview` 回傳 `scheduler`；`/operator` 頁面顯示 alive / dry-run / LIVE / 上一輪計數
- **為什麼不從 `portfolios.last_checked_at` 推算**：所有投組都還沒到期時那個時間是舊的，
  看起來像排程器死了 —— 而「死掉」與「沒事做」是兩種完全不同的處置
- Railway 上以 `bun run scripts/scheduler.ts --loop --live --interval 60 --limit 20` 作為獨立 service；
  進程死掉由 Railway 重啟（`restartPolicyType: ON_FAILURE`）

## 2. Secrets 外移 `[ ]`

- `OPERATOR_PRIVATE_KEY`、`SESSION_KEY_MASTER_SEED`、`DATABASE_URL` 目前在 `backend/.env`
- 部署到 Railway 時改用它的 Variables（等同 secret manager），`.env` 不進版控（已在 `.gitignore`）
- 待辦：**seed 輪替程序**（換 seed 等於所有 session key 失效，需要一次全量 renew）

## 3. Alert 投遞 `[ ]`（使用者說先放 todo）

- 現在只有 `scheduler_alerts` 表 + `GET /health` + `--alerts` CLI
- 缺 email / Slack / pager。至少要有 critical 的主動通知，不然沒人會去看

## 4. registry owner 換 multisig / timelock `[ ]` — 延後到主網測試結束

- 現在 `AtpRegistry` owner 是單一 EOA（部署者 `0x70fc55f8…7c60c`）
- 合約層面：owner 可以 `setFee`、`registerStrategy`、`pause`

### 決策（2026-11，使用者裁定）

**先維持單一 EOA，等主網測試全部跑完再轉 Safe。** 理由：

* 測試階段會頻繁改設定（fee、策略註冊、pause），每次都要走 multisig 流程會拖垮迭代速度
* 轉移之後要再改回來很麻煩，而現在還沒有真實使用者資金
* 私鑰目前只存在 `backend/.env.mainnet`（chmod 600、gitignored），風險可控

### 轉移前必須記得的三件事

1. **轉移後 `setPaused` 這條緊急通道要還走得通** —— 如果 Safe 的簽名門檻設太高（例如 3/5 但只有 2 個 signer 在線），
   出事時反而停不下來。緊急暫停應該是低門檻（1/2 或 2/3），日常設定變更才是高門檻。
2. 轉移前先確認 `OPERATOR_PRIVATE_KEY`（部署者）不再需要任何 owner 權限，
   否則轉移後會出現「合約 owned by Safe，但某支腳本還假設 EOA 是 owner」的隱性失敗。
3. 轉移後跑一次 `preflight --strict` —— 它會檢查 registry owner 並在 `--strict` 下對單一 EOA 報 warn，
   轉移完成後那個 warn 應該消失（這也是這個檢查存在的理由）。

### 為什麼這條不能忘

單一 EOA 的 owner 等於「一把私鑰控制整個協議」。現在可以接受，是因為**還沒有真實使用者資金**並且
我們在密集測試。一旦開始對外，這條就是最高優先的風險項。

## 5. 真 BSC 部署驗證 + 第一筆小額真錢 `[ ]`

- `DeployAtp.s.sol` 已在 fork 上反覆驗證；主網要確認 pool fee tier / permit2 / universal router 位址
- 第一筆用最小金額（例如 20 USDT）走完 deposit → rebalance → withdraw，並對帳 gas

## 6. 文件進版控 `[x]`

- `backend/docs/pitfalls.zh-TW.md`（43 條踩坑記錄）
- `backend/docs/decisions.zh-TW.md`（35 條架構決策）

## 7. 擴容：多使用者同時再平衡 `[ ]`

- 現況：`--limit 20`、**循序**處理，一輪約 40–80 秒；100 個訂閱者要 5 批
- 認領是交易式（`claimDuePortfolios` + 推進 `next_run_at`），所以**多進程並行是安全的**
- 待辦：決定「提高 limit」還是「多個 scheduler 進程」，並在 supervisor 裡把並行度變成設定
