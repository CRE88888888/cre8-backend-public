#!/usr/bin/env bash
# 為 Elon Universe 的五個成分資產部署 PancakeV3TwapOracle，並在 router 上註冊。
#
# ⚠ 必須在 `refresh-anvil.sh` 之後**立刻**跑：寫入需要年輕的 fork（上游 archive 窗口 ~75 分鐘），
#    過期後連 cast send 都會 Fork Error 403。
#
# 用法：bash backend/scripts/deploy-elon-oracles.sh
set -uo pipefail
export PATH="$HOME/.foundry/bin:$PATH"

cd "$(dirname "$0")/../.."   # 之後的路徑（spike/、cre8-contracts/）都以 repo 根為基準
RPC="${RPC:-http://127.0.0.1:8545}"
KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
ROUTER="${ROUTER:-0x132cDfCe34d385f783dAB7F011B2E66E78A2f87f}"
FACTORY=0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865
USDT=0x55d398326f99059fF775485246999027B3197955
TWAP_WINDOW=1800   # 30 分鐘（與既有 WBNB/NVDAB oracle 一致）
MAX_SLIPPAGE=100   # 1%
MAX_AGE=3600

# 資產 → 顯示符號（真實 BSC 代幣；TSLAB/SPCXB 是 Tesla/SpaceX 的 bStock）
ASSETS=(
  "0x5b1910eaad6450e50f816082aa078c41f10c292f:TSLAB"
  "0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1:SPCXB"
  "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c:BTCB"
  "0xbA2aE424d960c26247Dd6c32edC70B295c744C43:DOGE"
  "0x2170Ed0880ac9A755fd29B2688956BD959F933F8:ETH"
)

CODE="$(cd "$(dirname "$0")/../../cre8-contracts" && forge inspect src/atp/PancakeV3TwapOracle.sol:PancakeV3TwapOracle bytecode 2>/dev/null)"
[ -n "$CODE" ] || { echo "找不到 oracle bytecode（先 forge build）"; exit 1; }

for entry in "${ASSETS[@]}"; do
  asset="${entry%%:*}"
  sym="${entry##*:}"
  # 池子從 factory 查，不寫死：寫死的話一改 fee 層就會部署到「不是這個 pair」的池子上。
  pool=""
  for fee in 500 2500 10000 100; do
    candidate="$(cast call "$FACTORY" "getPool(address,address,uint24)(address)" "$asset" "$USDT" "$fee" --rpc-url "$RPC" 2>/dev/null)"
    if [ -n "$candidate" ] && [ "$candidate" != "0x0000000000000000000000000000000000000000" ]; then
      pool="$candidate"; break
    fi
  done
  if [ -z "$pool" ]; then echo "  ✗ ${sym}：沒有 USDT 池，跳過"; continue; fi

  args="$(cast abi-encode "constructor(address,address,address,uint32,uint16,uint32)" \
    "$pool" "$asset" "$USDT" "$TWAP_WINDOW" "$MAX_SLIPPAGE" "$MAX_AGE")"
  out="$(cast send --rpc-url "$RPC" --private-key "$KEY" --json --create "${CODE}${args#0x}" 2>&1)"
  oracle="$(echo "$out" | python3 -c "import sys,json;print(json.load(sys.stdin).get('contractAddress') or '')" 2>/dev/null)"
  if [ -z "$oracle" ]; then
    echo "  ✗ ${sym}：部署失敗 → $(echo "$out" | head -c 160)"; continue
  fi

  reg="$(cast send --rpc-url "$RPC" --private-key "$KEY" --json "$ROUTER" "setOracle(address,address)" "$asset" "$oracle" 2>&1)"
  status="$(echo "$reg" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('status','?'))" 2>/dev/null)"
  echo "  ✓ $sym  pool=$pool  oracle=$oracle  setOracle status=$status"
done
