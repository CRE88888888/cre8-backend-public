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

## 第二版（backend#204）

- **買入時自動開啟**：買入確認畫面打開 Earn extra 時，前端打 `POST /portfolios/:id/strategy-earn/auto` 拿 owner 同意的 calls，接在買入 UserOp 後面一起簽（一次確認）：每個協定一次 `updateDelegate`／`setAuthorization`、每個市場 `setBorrowPolicy(上限)` 與抵押品授權、USDT 與策略 vault 份額授權——**全部只給 `AtpBorrowExecutor`**。上限＝（這次投入金額 × 該資產權重＋已持有價值）× 目標 LTV × 98% × 110%。
- **session key 權限**：chain 97 的 owner renewal 現在一併安裝 `AtpBorrowExecutor` 的四個函式（`executeSupplyCollateral`、`executeBorrow`、`executeRepay`、`executeWithdrawCollateral`），第 0 個參數固定是帳戶本身、第 1 個參數只能是五個市場之一（CallPolicy 0.0.4 `ONE_OF`，fork 上對已部署合約驗過）。不含任何授權（approve）、不含 `executeDeleverage`（任何人可呼叫），也不給 `AtpExecutor` 任何新權限。舊 key（沒有這組權限）重建出的 permissionId 不變。`auto` 回 `authorization: "renewal_required"` 時前端要一併簽 renewal。
- **scheduler 自動抵押借款**：投資組合這一輪沒有要交易（noop）時，對 owner 已同意（policy enabled）、市場 gate 開著、持有價值 ≥ 10 USD 的資產，用 session key 送一個 UserOp：抵押全部持股＋借到目標 LTV（不超過 owner 上限的 99%）直接存 vault。沒有新權限的 key 只寫 log。
- **持倉估值**：`planPortfolio`（chain 97、非 My mix）把抵押中的股數加回該資產的持倉（`readPositions` 的 `extraBalances`），漂移與 `portfolio_snapshots` 總值都看得到它；讀不到抵押量就整個 portfolio blocked，不會當 0。
- **賣出先還款**：要賣的數量超過帳戶裡沒抵押的部分時，送出 swap 前先用 session key：還清（`executeRepay(max, fromVault=true)`，vault 先、再用帳戶自己的 USDT）→ 取回全部（`executeWithdrawCollateral(max)`），這一輪 blocked `[STRATEGY_EARN_UNWINDING]`，下一輪再賣。vault＋帳戶 USDT 不夠還時，先還能還的、只取回維持目標 LTV 以外的股數（留 2% 餘裕），賣掉那部分後下一輪再還剩下的。
- **Lista 激勵**：QQQB、MSTRB 用 `MockMoolah.claimReward(listaId, account)`（只付給該帳戶），門檻同樣 0.01 USDT。
- **帳本與活動紀錄**：db 0063 `strategy_earn_events`。keeper 的減倉／收掉／領獎、scheduler 的開啟／賣出前還款，都從成功的 receipt 解析 `AtpBorrowExecutor`（或付獎勵的那個合約）發出的事件寫入，(chain, tx, log) 唯一；deleverage 與 unwind 用事件裡的 `ltvBefore` 對照減倉線區分。帳本寫失敗不會重送鏈上動作，只寫 log。演練帳戶（不在 DB）不記帳。

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
| `POST /portfolios/:id/strategy-earn/auto`（#204） | `{budgetRaw}`（這次要投入的 USDT raw） | `status:"ready"`＋`authorization:"ready"\|"renewal_required"`＋`assets:[{asset, status, maxDebtRaw, extraApyBps}\|{asset, status:"unavailable", reason, message}]`＋`calls`（接在買入 UserOp 後一起簽）；沒有可加息的資產或全部不能用時 `status:"unavailable"`＋`reason`（`no_eligible_asset`、`data_unavailable`） |
| `GET /portfolios/:id/strategy-earn/activity`（#204） | — | `{portfolioId, activity:[{kind:"open"\|"deleverage"\|"unwind"\|"repay"\|"close"\|"claim", asset, amountRaw, collateralRaw, ltvBeforeBps, ltvAfterBps, txHash, blockNumber, createdAt, message}]}`，新到舊最多 50 筆；`message` 是一句英文白話（不出現 collateral／LTV／borrow） |

`GET /portfolios/:id/strategy-earn` 新增 `earnNetUsd`（頂層與每個 position）：vault 價值 − 負債（可為負）。投資組合狀態／快照的總值已經含抵押中的股票，**畫面上的淨值＝投資組合總值＋`earnNetUsd`**，不要再加 `netValueUsd`（那包含抵押品，會重複算）。

`extraApyBps`＝（vault 利率＋vault 激勵−借款利率＋借款激勵）× 比例＋抵押品利率＋抵押激勵；比例在買入前用目標 LTV、已開部位用目前 LTV；可為負。`netValueUsd`＝抵押價值＋vault 價值−負債（USD 18 位小數，USDT≈1）。`reason`：`closed`、`borrow_utilization`、`vault_utilization`、`negative_carry`、`vault_unreadable`、`data_unavailable`。借款金額＝（既有＋新增抵押價值）× 目標 LTV × 98% − 既有負債，同意的負債上限再多 10% 留給利息。

## 這版還沒做

- keeper 減倉時 vault 不夠還（`executeDeleverage` 只還得了一部分）的情況，還不會自動賣抵押品補還；目前靠下一輪再減倉與賣出前還款路徑。
- 還清後若 vault 份額價值大於負債，合約把剩下的贖回成帳戶 USDT（該檔投資組合自己的錢）；若 vault 當下流動性不足，剩下的份額留在帳戶，下次還款時一起處理。
- 帳戶 owner 簽的 `auto` calls 與 renewal 要由前端接進買入流程（cre8-web）。
