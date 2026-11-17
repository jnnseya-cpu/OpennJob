# syntax=docker/dockerfile:1
#
# OpennJob API. Multi-stage: build with the full toolchain, run with production
# dependencies only, as a non-root user. The Chrome extension is not part of this image.
#
#   docker build -t opennjob-api .
#   docker run --rm -p 8080:8080 --env-file .env opennjob-api
#
# The same image runs the migrations:  docker run --rm --env-file .env opennjob-api node apps/api/dist/migrate-cli.js

ARG NODE_VERSION=22

# ---- build: compile packages/core and apps/api -------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
# Manifests first, so the dependency layer is reused until a package.json changes.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/extension/package.json apps/extension/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/api apps/api
RUN npm run build -w @opennjob/core && npm run build -w @opennjob/api

# ---- deps: production dependencies of the API only ---------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/extension/package.json apps/extension/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --no-audit --no-fund -w @opennjob/core -w @opennjob/api

# ---- runtime -----------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/package.json package.json
COPY --from=build /app/packages/core/package.json packages/core/package.json
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/apps/api/dist apps/api/dist
# The migration files, where apps/api/dist/migrations.js looks for them (../../../db/migrations).
COPY db/migrations db/migrations
# `node` is the unprivileged user (uid 1000) that the official image provides.
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# No shell and no npm in front of node: SIGTERM reaches the process, which shuts down gracefully.
CMD ["node", "apps/api/dist/main.js"]
