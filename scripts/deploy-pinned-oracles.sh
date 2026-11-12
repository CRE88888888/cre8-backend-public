#!/usr/bin/env bash
# 為 Elon Universe 的成分資產部署 TWAP oracle，**池子是明確釘住的**（不自動挑）。
#
# 為什麼不用自動挑：`deploy-elon-oracles.sh` 會按 `liquidity()` 選最大的池子，但實測它在
# 鏈狀態剛重建、RPC 讀取失敗時會退化成「全部 0 → 取第一個候選」，於是綁到**流動性 0 的死池**
# （TSLAB fee=500 的 liq 就是 0）。死池的 `slot0` 停在 MAX_TICK，報價會變天文數字，
# 而合約的下限檢查會讓整批 rebalance revert（`V3TooLittleReceived`）。
#
# 所以這裡把「哪個資產用哪個池子」寫死，並在部署前**斷言該池有流動性** ——
# 選錯就立刻報錯，不要靜默地部署一顆註定失敗的 oracle。
#
# 用法：RPC=http://127.0.0.1:8546 ROUTER=<v2 router> bash backend/scripts/deploy-pinned-oracles.sh
set -uo pipefail
export PATH="$HOME/.foundry/bin:$PATH"

RPC="${RPC:-http://127.0.0.1:8545}"
if [[ ! "$RPC" =~ ^https?://(127\.0\.0\.1|localhost)(:[0-9]+)?(/[^[:space:]]*)?$ ]]; then
  echo "只允許 127.0.0.1／localhost 的 anvil fork RPC" >&2
  exit 1
fi
ROUTER="${ROUTER:?請以 ROUTER 指定 fork 上的 v2 router 地址}"
KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
TWAP_WINDOW=1800
MAX_SLIPPAGE="${MAX_SLIPPAGE:-300}"
MAX_AGE=3600

# asset:pool:fee:symbol —— 池子與 fee 都是實測有流動性的那一層
TRIPLES=(
  "0x5b1910eaad6450e50f816082aa078c41f10c292f:0xB0f5E5400E8F0F7C242F2b7740C004f020579c41:2500:TSLAB"
  "0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1:0x977DaFFC095b33872E2741c19568925015C35b4d:2500:SPCXB"
  "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c:0x46Cf1cF8c69595804ba91dFdd8d6b960c9B0a7C4:500:BTCB"
  "0x2170Ed0880ac9A755fd29B2688956BD959F933F8:0xBe141893E4c6AD9272e8C04BAB7E6a10604501a5:500:ETH"
)

echo "  router = $ROUTER"
failures=0

for triple in "${TRIPLES[@]}"; do
  asset="$(echo "$triple" | cut -d: -f1)"
  pool="$(echo "$triple" | cut -d: -f2)"
  fee="$(echo "$triple" | cut -d: -f3)"
  sym="$(echo "$triple" | cut -d: -f4)"

  liq="$(cast call "$pool" "liquidity()(uint128)" --rpc-url "$RPC" 2>/dev/null | perl -pe 's/ \[.*//' | tr -dc '0-9')"
  if [ -z "$liq" ] || [ "$liq" = "0" ]; then
    echo "  ✗ ${sym}: 池 $pool (fee $fee) 的 liquidity 是 0 或讀不到 —— 拒絕部署（死池會讓報價爆掉）"
    failures=$((failures + 1)); continue
  fi

  if ! oracle="$(cast call "$ROUTER" "oracleOf(address)(address)" "$asset" --rpc-url "$RPC")"; then
    echo "  ✗ ${sym}：讀取 oracleOf 失敗"; failures=$((failures + 1)); continue
  fi
  # 已註冊的資產先 clearOracle；失敗必須顯示，不能把未更新的 oracle 當成成功。
  if [ "$oracle" != "0x0000000000000000000000000000000000000000" ]; then
    clear="$(cast send --rpc-url "$RPC" --private-key "$KEY" --json "$ROUTER" "clearOracle(address)" "$asset" 2>&1)"
    status="$(echo "$clear" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status','?'))" 2>/dev/null)"
    if [ "$status" != "0x1" ] && [ "$status" != "1" ]; then
      echo "  ✗ ${sym}：clearOracle 失敗 → $clear" >&2
      failures=$((failures + 1)); continue
    fi
  fi
  reg="$(cast send --rpc-url "$RPC" --private-key "$KEY" --json "$ROUTER" "setOracle(address,address,uint32,uint16,uint32)" \
    "$asset" "$pool" "$TWAP_WINDOW" "$MAX_SLIPPAGE" "$MAX_AGE" 2>&1)"
  status="$(echo "$reg" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status','?'))" 2>/dev/null)"
  if [ "$status" != "0x1" ] && [ "$status" != "1" ]; then
    echo "  ✗ ${sym}：setOracle 失敗 → $reg" >&2
    failures=$((failures + 1)); continue
  fi
  if ! oracle="$(cast call "$ROUTER" "oracleOf(address)(address)" "$asset" --rpc-url "$RPC")" || \
    [ -z "$oracle" ] || [ "$oracle" = "0x0000000000000000000000000000000000000000" ]; then
    echo "  ✗ ${sym}：setOracle 後讀不到 oracle 地址" >&2
    failures=$((failures + 1)); continue
  fi
  echo "  ✓ ${sym}  pool=$pool fee=$fee  liq>0  oracle=$oracle  setOracle=$status"
done

[ "$failures" -eq 0 ]
