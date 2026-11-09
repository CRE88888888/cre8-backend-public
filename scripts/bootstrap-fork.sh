#!/usr/bin/env bash
# 一次把 fork 環境拉起來：開機 → 載入 dump → 部署 5 顆 oracle + setOracle。
#
# 為什麼必須「一次做完」：dataseed 的歷史狀態窗口只有約 1 分鐘。過了之後任何**沒被本地碰過**的
# 合約讀寫都會 `missing trie node`；publicnode 則是反過來（讀得到、寫不進去，要走 archive token）。
# 所以流程是「開機後立刻把要用的合約都碰過一次」，之後它們就在本地狀態裡。
#
# 用法：bash backend/scripts/bootstrap-fork.sh
set -uo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/../.."

RPC=http://127.0.0.1:8545
UPSTREAM="${BSC_RPC_URL:-https://bsc-dataseed.bnbchain.org}"
DUMP="$(ls -t spike/anvil/state-dump-*.json | head -1)"

echo "  [1/4] 停掉舊 anvil…"
pkill -f "anvil --fork-url" 2>/dev/null || true
sleep 2

echo "  [2/4] 起新 anvil（$UPSTREAM, --hardfork cancun）"
# `--hardfork cancun` 是必要的：BSC 最新的 Bpo1 會在每個區塊觸發 blockhash 系統合約呼叫，
# 而在 fork 上那個呼叫會因為取不到歷史 storage 而失敗（實測：registerStrategy revert）。
nohup anvil --fork-url "$UPSTREAM" --chain-id 56 --port 8545 --hardfork cancun > .shots/logs/anvil-boot.log 2>&1 &
sleep 9

echo "  [3/4] 載入 dump：$(basename "$DUMP")"
python3 - "$DUMP" <<'PY'
import json, pathlib, sys
d = json.loads(pathlib.Path(sys.argv[1]).read_text())
pathlib.Path('.shots/logs/loadstate.json').write_text(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'anvil_loadState', 'params': [d['result']]}))
PY
curl -s --max-time 180 -X POST -H 'content-type: application/json' --data-binary @.shots/logs/loadstate.json "$RPC" | head -c 60
echo " ← loadState"

echo "  [4/4] 部署 oracle 並註冊"
bash backend/scripts/deploy-elon-oracles.sh
