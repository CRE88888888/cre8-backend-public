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

# 啟動前套用 migration：多實例同時啟動時，`migrate` 的 checksum 表會讓後到的實例直接跳過。
ENV NODE_ENV=production
EXPOSE 8081

CMD ["sh", "-c", "bun src/migrate.ts && bun src/index.ts"]
