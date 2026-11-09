# 生產環境現況（主網）

> 最後更新：2026-11-09

## 已上線

| 元件 | 位置 | 狀態 |
|---|---|---|
| **AtpRegistry** | `0xf429929c9fc89446c08fd4c201543b40d7d3d67a` | 主網，有 bytecode |
| **AtpExecutor** | `0x547764c2a6f789986f0f3e532c115ffc7e3ac9e7` | 主網，有 bytecode |
| **AtpMultiPoolOracle** | `0x6a31f0c5180e5d25accf5775da98e2404a46d869` | 主網 |
| Oracle WBNB/USDT | `0x7c7df82b4c27251db247af363f99e595d42a8d78` | 主網 |
| Oracle NVDAB/USDT | `0xebf5a243e79436b49dcfb8092968b161e323d873` | 主網 |
| **api 服務** | `https://api-production-7f13.up.railway.app` | Railway，SUCCESS |
| **Postgres** | Railway（私有網路） | SUCCESS，18 個 migration |

健康檢查實測：

```json
{"status":"ok","service":"cre8-atp-backend","chainId":56,"rpcConfigured":true,
 "db":"ok","alerts":{"critical":0,"warn":0,"open":0}}
```

部署者：`0x70fc55f8BF3BE3E599566417A1a58c9bf6a7c60c`（全新錢包，非 anvil 測試帳號）
部署成本：0.000299 BNB（7 筆交易）

## 還沒做

| # | 項目 | 阻礙 |
|---|---|---|
| 1 | **alto bundler** | 使用者決定自架在 Railway；尚未建立服務。沒有 bundler 就送不出 UserOp |
| 2 | **scheduler 服務** | 等 bundler（`--live` 需要它） |
| 3 | 前端部署 | `VITE_CHAIN_ID=56` + `VITE_RPC_URL` + `VITE_API_BASE` |
| 4 | 第一筆真錢驗證 | 等 1–3 |
| 5 | registry owner → Safe | 主網前 TODO §4 |
| 6 | alert 投遞 | TODO §3 |

## 部署紀錄的重要教訓

* `railway up` 上傳「連結時的專案根目錄」，不是 CWD → 必須 `railway up .deploy --path-as-root`
* `railway up` 預設用**已連結的服務** → 先 `railway add --service api` 再指定
* 沙箱不能寫 `~/.railway` → `HOME=<工作區> railway ...`
* publicnode 對 archive 查詢要 token：`forge` 驗證 receipt 時噴 403，但交易成功
