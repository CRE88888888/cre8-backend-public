# CRE8 ATP backend（Railway / 任何容器平台）
#
# 為什麼需要它：Railway 的預設 buildpack 會猜 `bun install` + `bun start`，但我們的啟動指令是
# `bun src/index.ts`，而且 `migrate` 必須在啟動前跑一次。寫死在這張 Dockerfile 裡比在平台上
# 點設定可靠（設定會漂移，Dockerfile 進版控）。
FROM oven/bun:1.4-alpine

WORKDIR /app

# 先只複製 manifest：依賴層可以在原始碼變動時重用快取。
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

COPY . .

ENV NODE_ENV=production
# image 裡沒有 ../db/migrations（build context 只有 backend/）→ 啟動時不跑 migration，
# 改由部署步驟套用（見 docs/deploy-railway.zh-TW.md）。
ENV MIGRATIONS_ENABLED=0
EXPOSE 8081

# ⚠ 這裡**刻意不跑 migration**。
#
# `db/migrations` 住在隔壁的 repo（`cre8-protocol/db`），而 Docker 的 build context 只有
# `backend/` —— 建置脈絡裡根本沒有那個目錄，`bun src/migrate.ts` 會在啟動時失敗，
# 容器連不起來（而且錯誤長得像「DB 連不上」，很難查）。
#
# 所以 migration 是**部署步驟**：本機或 CI 用 Railway 的 DATABASE_URL 跑一次
#
#     DATABASE_URL=<railway> bun run src/migrate.ts
#
# （或用 `railway run bun run src/migrate.ts`，見 docs/deploy-railway.zh-TW.md）。
# 若之後要把 migration 一起放進 image，COPY 一份到 /app/migrations 並設 MIGRATIONS_DIR。
CMD ["bun", "src/index.ts"]
