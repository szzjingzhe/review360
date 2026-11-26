# 应用镜像：api / worker / migrate 共用同一镜像，靠 command 区分。
#
# 说明（本地部署取向）：
# - 单阶段构建，保留 devDependencies —— 迁移脚本用 `tsx` 运行，需要它。
#   若要做生产镜像，应拆出 runner 阶段并 prune，同时把迁移编译成 JS。
# - 不把 .env 打进镜像（见 .dockerignore）；运行时全部走环境变量注入。
FROM node:22-alpine

# Render Office monthly materials locally; files never leave this service.
ARG APK_MIRROR=https://dl-cdn.alpinelinux.org/alpine
RUN --mount=type=cache,target=/var/cache/apk sed -i "s|https://dl-cdn.alpinelinux.org/alpine|${APK_MIRROR}|g" /etc/apk/repositories \
 && apk add --update-cache libreoffice-writer libreoffice-impress libreoffice-calc font-noto-cjk

WORKDIR /app

# pnpm 走 corepack，版本取自 package.json 的 packageManager 字段。
# 非交互构建下 corepack 会因下载确认提示而卡住，必须显式关闭。
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# 先只拷清单，利用层缓存：依赖未变时不重复 install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/domain/package.json packages/domain/
COPY packages/database/package.json packages/database/

RUN pnpm install --frozen-lockfile

# 再拷源码并构建（domain 必须先于 api/worker，api/worker 从 @360/domain/dist 引用）
COPY . .
RUN pnpm --filter @360/domain build \
 && pnpm --filter @360/api build \
 && pnpm --filter @360/worker build

ENV NODE_ENV=development
EXPOSE 3000

# 默认启动 API；worker 与迁移任务由 compose 覆盖 command
CMD ["node", "apps/api/dist/main.js"]
