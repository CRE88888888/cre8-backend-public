# 加息策略的激勵代幣（LISTA／XVS）

實作：`src/strategy-rewards.ts`；資料表：db 0068；測試：`test/strategy-rewards.test.ts`、`test/strategy-rewards.db.test.ts`、`test/sponsor-flows.test.ts`。
只在 BSC 主網（chain 56）而且 `STRATEGY_REWARDS_ENABLED=1` 時運作，預設關。chain 97 沒有 merkle 發放合約，測試網永遠不跑，只有測試在用假資料跑。

## 錢從哪來、到哪去

| 來源 | 合約 | 怎麼領 | 付給誰 |
| --- | --- | --- | --- |
| Lista 借款／存款激勵（LISTA） | `LendingRewardsDistributor` `0x665410ee…3d29` | `claim(account, totalAmount, proof)`，任何人可呼叫 | `account` |
| Lista 其他代幣激勵 | V2 `0x2993E9eA…aE76` | `batchClaim(accounts, tokens, totalAmounts, proofs)`，任何人可呼叫 | 各 `account` |
| Venus（XVS） | core comptroller | `claimVenus(holder)`，任何人可呼叫 | `holder` |

- 金額是累計值：可領＝`totalAmount − claimed(account)`。
- 都是任何人可呼叫、只會付給那個地址，所以由 operator 的 key 直接送交易：不用 session key、不用 UserOp、不用 paymaster 規則。key 是 `STRATEGY_REWARDS_KEEPER_PRIVATE_KEY`；沒設時每輪只更新待領金額，不送交易。
- 收款地址有兩個：投資組合帳戶（借款激勵），以及路由 v2 的策略盒 `boxOf(account)`（vault 存款激勵）。
- 代幣留在投資組合帳戶，按投資組合顯示；全部賣出／領回／刪除時原樣轉回 owner 錢包。

## 證明要簽名：誰簽

Lista 的證明 API（`/api/moolah/emission/userProof`、`/userMultiProof`）要「被查詢的那個地址」的簽名：
訊息 `"<ISO 時間>\nThank you for your support of listaDAO."`，personal_sign，7 天有效；合約帳戶帶 `type=safe`，用 ERC-1271 驗。

**選定：owner 每 7 天在 App 裡簽一次**（內嵌錢包直接簽，不跳確認頁；打開投資組合頁時 `signature.needed` 為 true 就簽，`POST /portfolios/:id/strategy-earn/reward-signature { signedAt, signature }`）。

沒選「讓 session key 簽 ERC-1271」的原因：能替帳戶產生有效簽名的 key，可以簽任何接受 ERC-1271 的東西（Permit2、掛單協議），權限遠大於「讀我的激勵證明」。要安全地開放，得另外寫一個只認這段訊息的簽名 policy 合約並審計。owner 沒來也不會少拿：merkle 金額是累計的，下次有新簽名就一次領完。

策略盒（v2）：盒子要能回答 ERC-1271（把驗證轉給它所屬的帳戶），同一個 owner 簽名才能同時查帳戶和盒子。這點已回報給合約端。

## 每輪做什麼（排程器，`runStrategyRewardsRound`）

每 24 小時最多一輪（merkle root 每週更新，但每天看一次，新簽名隔天就看得到待領金額）：

1. 找出簽名還在 7 天內的帳戶。
2. 每個收款地址向 Lista 拿兩份證明，用公開節點讀 `claimed`（不走付費 RPC）。
3. 把累計與已領寫進 `strategy_reward_pending`。
4. 可領 ≥ 0.1 顆（`MIN_CLAIM_RAW`）才送 claim；小於的留到下一輪。
5. 從收據裡代幣自己的 Transfer 事件寫帳本 `strategy_reward_events`（實際到帳多少記多少）。
6. 每個帳戶印一行 log；單一帳戶失敗不影響其他帳戶，下一輪重試。

## API

- `GET /portfolios/:id/strategy-earn/rewards`：`{ tokens: [{ token, symbol, balanceRaw, pendingRaw }], signature: { needed, signedAt } }`。全部來自帳本，不讀鏈。`balanceRaw`＝已領進帳戶的（claim − sweep），`pendingRaw`＝已賺到還沒領的。
- `POST /portfolios/:id/strategy-earn/reward-signature`：存 owner 的簽名。`signedAt` 必須是當下（±10 分鐘）。
- 功能關閉時兩支都回 404 `STRATEGY_REWARDS_NOT_CONFIGURED`。

## 轉回錢包

`rewardExitCalls(balances, owner)`：每個有餘額的代幣一筆 `transfer(owner, amount)`，原樣轉、不換幣（自動賣 LISTA／XVS 需要另外的滑價規則與價格來源，金額也小）。
paymaster 規則（基金帳戶與 My mix 帳戶都測過）：激勵代幣只允許「transfer 給這個帳戶的 owner、金額 > 0」；approve、轉給別人、其他函式一律拒絕。功能關閉時連這筆也不贊助。

## 上主網前要驗的（現在驗不了）

- Lista API 對 Kernel 帳戶的 ERC-1271 簽名實際接不接受（`type=safe`；用一個主網帳戶試一次）。

已用公開節點查證（2026-11-24）：LISTA／XVS 代幣地址的 `symbol()`、兩個發放合約的 `claimed(...)`、comptroller 的 `venusAccrued(...)` 都讀得到，V1 發放合約的 `token()` 就是 LISTA。
