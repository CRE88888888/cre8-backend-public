# 策略加息（Strategy Earn，backend#199）

依 docs repo `docs/EARN_UX.zh-TW.md` B、D 節；合約是 cre8-contracts#64／#65（手冊 `docs/borrow-97.zh-TW.md`）。只在 chain 97。

## 設計

- 每一檔投資組合自己的帳戶（Kernel smart account）把一個持股存進「該資產固定的那一個」市場當抵押，借 USDT **同一筆直接存進策略 vault**，關閉時從 vault 還款、取回抵押。錢都在那一檔的帳戶裡，不經錢包現金、不跟現金生息（#193）或其他投資組合混算；API 回的數字也不跟它們加總。
- 開啟與關閉是**帳戶 owner 簽的一個 UserOp**（後端只產生 calls，跟 My mix、現金生息同一種做法）。paymaster 只代付這些固定形狀的呼叫：帳戶必須是送出者、市場必須是五個之一、授權只能給 `AtpBorrowExecutor`。
- 自動減倉：scheduler 每輪對每個 chain 97 帳戶讀 `accountMarkets` → `status`，`shouldDeleverage` 或 `shouldUnwind` 為 true 時送 `executeDeleverage`（任何人可呼叫，只用該帳戶自己的 vault 份額還款）。激勵 `claimReward(account)` 只付給該帳戶，達 0.01 USDT 才領，vault 激勵每帳戶一輪只領一次。
  - 測試網 scheduler 已設 `STRATEGY_EARN_KEEPER_PRIVATE_KEY`（backend#207）：獨立的測試網金鑰，地址 `0x4A07CDAC26aFdc89eb47D653A95b8ABf6B1f4b0a`，私鑰只存在本機 `~/.cre8-testnet/strategy-earn-keeper.json` 與 Railway 測試專案。合約沒有 keeper 角色：`executeDeleverage` 與各市場 `claimReward(account)` 任何人可呼叫，只需要 tBNB 付 gas（單筆減倉約 45 萬 gas）。
  - `STRATEGY_EARN_DRILL_ACCOUNTS`（選填，逗號分隔地址，只在 chain 97 讀）：DB 投資組合帳戶以外，keeper 也檢查的演練帳戶，例如 cre8-contracts 的 `BorrowDemoAccount`（OWNER 測試金鑰擁有）。格式錯誤整輪報錯，不會默默略過。
  - 需要 scheduler 設 `STRATEGY_EARN_KEEPER_PRIVATE_KEY`（測試網專用、有少量 tBNB 的獨立金鑰，不能和 operator／price keeper 共用，避免 nonce 衝突）。沒設時只在 log 寫「需要減倉」，不送交易；dry-run 也只寫 log。
- 不開放：槓桿類（合約沒有上架）、私人組合（My mix，回 409 `MIX_NO_STRATEGY_EARN`）。

## 安全限制（cre8-contracts docs/borrow-97 §7）

策略 vault 登記在既有 `AtpYieldRegistry`，而已部署的 `AtpExecutor.executeWithdraw` 沒有「只限現金生息」的檢查。帳戶如果曾把策略 vault 份額授權給 `AtpExecutor`，session key 就能把它贖回成帳戶現金。後端因此：

- `src/strategy-earn-guard.ts`：策略 vault 地址與 market id 的單一來源，`assertNotStrategyVault`。
- `yieldProfile()` 會把策略 vault 從生息市場清單剔除（就算之後同步的 manifest 列出它），現金生息與投資組合生息都看不到它。
- `yield-execution` 組 `executeSupply／executeWithdraw` 前再檢查一次。
- paymaster 拒絕：對策略 vault 的任何授權（除了給 `AtpBorrowExecutor`）、`AtpExecutor` 對策略 vault market 的存領、`setYieldPolicy` 指向策略 vault。
- 開啟的 calls 只授權 `AtpBorrowExecutor`（測試檢查 calldata 裡完全沒有 `AtpExecutor` 地址）。

## API

| 方法與路徑 | body | 回應重點 |
| --- | --- | --- |
| `GET /strategy-earn/markets`（免登入，快取 30 秒） | — | `{chainId, updatedAt, markets:[{asset, marketId, protocol, status:"open"\|"unavailable", reason, message, extraApyBps, breakdown:{vaultBps, vaultIncentiveBps, borrowBps, borrowIncentiveBps, ratioBps, carryBps, collateralBps, collateralIncentiveBps}, targetLtvBps, deleverageLtvBps, updatedAt}]}`，買入前報價（比例＝目標 LTV） |
| `GET /portfolios/:id/strategy-earn` | — | `{portfolioId, account, status, updatedAt, positions:[{asset, status:"on"\|"off"\|"unavailable", collateralRaw, collateralValueUsd, debtRaw, vaultAssetsRaw, netValueUsd, pendingRewardsRaw, ltvBps, targetLtvBps, deleverageLtvBps, liquidationLtvBps, extraApyBps, shouldDeleverage, shouldUnwind, newBorrowing, reason}]}` |
| `POST /portfolios/:id/strategy-earn/open` | `{asset, collateralRaw}` | `status:"ready"`＋`calls`（owner 簽一個 UserOp）、`borrowRaw`、`maxDebtRaw`、`extraApyBps`；不能借時 `status:"unavailable"`＋`reason`（200，不是錯誤碼） |
| `POST /portfolios/:id/strategy-earn/close` | `{asset}` | `calls`：先 `executeRepay(max, fromVault=true)` 再 `executeWithdrawCollateral(max)`；賣出前要先送這組 |

`extraApyBps`＝（vault 利率＋vault 激勵−借款利率＋借款激勵）× 比例＋抵押品利率＋抵押激勵；比例在買入前用目標 LTV、已開部位用目前 LTV；可為負。`netValueUsd`＝抵押價值＋vault 價值−負債（USD 18 位小數，USDT≈1）。`reason`：`closed`、`borrow_utilization`、`vault_utilization`、`negative_carry`、`vault_unreadable`、`data_unavailable`。借款金額＝（既有＋新增抵押價值）× 目標 LTV × 98% − 既有負債，同意的負債上限再多 10% 留給利息。

## 這版還沒做

- 買入確認畫面打開開關後「自動」開啟：要在買完之後由 scheduler 代為抵押與借款，session key 需要新的權限（owner 重簽 renewal），另開單。這版是買完後在該檔頁面由 owner 一次確認開啟。
- 賣出流程自動先還款：目前 scheduler 的賣出不會自己呼叫 close；前端在賣出前要先送 close 的 calls。
- Lista（QQQB、MSTRB）市場的激勵 claim；利率已算進 APY。
- 減倉與激勵的資料庫帳本與活動紀錄文字（目前寫在 scheduler log，鏈上事件可查）。
