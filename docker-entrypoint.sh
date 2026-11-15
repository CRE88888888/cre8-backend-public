#!/bin/sh
# 同一個 image、多種角色。測試網另有 website / price-keeper / points-sync。
#
# 為什麼不用兩個 Dockerfile：api 與 scheduler 的程式碼、依賴、migration 完全相同，
# 只有**啟動指令**不同。維護兩份 Dockerfile 等於維護兩份會漂移的副本
# （這個 repo 已經被「兩份實作分岔」咬過好幾次）。
#
#   SERVICE_ROLE=api        → bun src/index.ts（預設）
#   SERVICE_ROLE=scheduler  → bun run scripts/scheduler.ts --loop …
#
# scheduler 預設是 **dry-run**：`--live` 必須由 SCHEDULER_LIVE=1 明確開啟，
# 因為那是真的會送交易、動真錢的開關。部署時忘記設 → 它只觀察不動手，不會誤傷。
set -eu

ROLE="${SERVICE_ROLE:-api}"

# Explicit staging switch. In hold mode no application/signer/DB module is loaded.
case "${SERVICE_ENABLED:-1}" in
  0) exec bun scripts/service-hold.ts ;;
  1) ;;
  *) echo '[entrypoint] SERVICE_ENABLED must be 0 or 1' >&2; exit 1 ;;
esac

case "$ROLE" in
  api)
    echo "[entrypoint] role=api port=${PORT:-8081}"
    if [ "${CHAIN_ID:-56}" = 97 ]; then
      exec bun scripts/testnet-api.ts
    fi
    exec bun src/index.ts
    ;;
  scheduler)
    # 間隔與批次大小可調；`--live` 只有在 SCHEDULER_LIVE=1 時才附加。
    INTERVAL="${SCHEDULER_INTERVAL:-60}"
    LIMIT="${SCHEDULER_LIMIT:-20}"
    THRESHOLD="${SCHEDULER_THRESHOLD_BPS:-100}"
    set -- --loop --interval "$INTERVAL" --limit "$LIMIT" --threshold-bps "$THRESHOLD"
    if [ "${SCHEDULER_LIVE:-0}" = "1" ]; then
      set -- "$@" --live
      echo "[entrypoint] role=scheduler interval=${INTERVAL}s limit=${LIMIT} LIVE"
    else
      echo "[entrypoint] role=scheduler interval=${INTERVAL}s limit=${LIMIT} dry-run"
    fi
    exec bun run scripts/scheduler.ts "$@"
    ;;
  price-keeper)
    exec bun scripts/price-keeper.ts
    ;;
  points-sync)
    exec bun scripts/points-sync.ts
    ;;
  website)
    exec bun scripts/testnet-web.ts
    ;;
  *)
    echo '[entrypoint] 未知的 SERVICE_ROLE（可用：api / scheduler / price-keeper / points-sync / website）' >&2
    exit 1
    ;;
esac
