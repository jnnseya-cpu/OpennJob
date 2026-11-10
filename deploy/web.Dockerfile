# The candidate web app: a static Next.js export served by Caddy (HTTPS, headers, /api proxy).
# Build from the repository root:  docker build -f deploy/web.Dockerfile -t opennjob-web .
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/extension/package.json apps/extension/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY apps/web apps/web
RUN npm run build -w @opennjob/web

FROM caddy:2-alpine
COPY --from=build /app/apps/web/out /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
# Where the browser finds the API. Same origin by default (Caddy proxies /api to the API).
ENV OPENNJOB_PUBLIC_API_BASE=/api
CMD ["sh", "-c", "printf '{\"apiBase\":\"%s\"}' \"$OPENNJOB_PUBLIC_API_BASE\" > /srv/opennjob-config.json && exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile"]
