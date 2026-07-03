# syntax=docker/dockerfile:1
#
# Production image for the CDP app (services/local-api): one container that serves
# the admin SPA + the API + the public endpoints (unsubscribe / tracking / assets),
# and — in APP_MODE=worker — the background sweeps + send drain. Deployed on AWS
# App Runner (a `web` service + a single `worker` service, both from THIS image).
#
# Build for App Runner's architecture:  docker build --platform linux/amd64 ...
# Required runtime env (App Runner):  DATABASE_URL, SESSION_JWT_SECRET,
#   UNSUBSCRIBE_LINK_SECRET, CDP_MASTER_KEY (32-byte base64), APP_BASE_URL,
#   UNSUBSCRIBE_BASE_URL, LINK_TRACKING_BASE_URL, APP_MODE (web|worker).

# ---------- build stage ----------
FROM node:22-slim AS build
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN corepack enable
# Copy the whole monorepo (node_modules/dist excluded via .dockerignore) and install.
COPY . .
RUN pnpm install --frozen-lockfile
# Build local-api + its full dependency tree (topological). Clean + correct now
# that stale .tsbuildinfo is excluded from the context.
RUN pnpm --filter "@cdp/service-local-api..." run build
# Build the SPA with the PRODUCTION api base. Empty = same-origin (the SPA + API are
# served from the same container/domain); assetsDir='static'.
ARG VITE_API_BASE=""
RUN VITE_API_BASE="$VITE_API_BASE" pnpm --filter "@cdp/web..." run build

# ---------- runtime stage ----------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
# Bring the built monorepo across (source + node_modules + dists + web/dist).
COPY --from=build /app /app
# The single-container server serves the SPA from here and listens on $PORT.
ENV WEB_DIST_DIR=/app/web/dist
ENV PORT=8080
EXPOSE 8080
WORKDIR /app/services/local-api
CMD ["node", "--import", "tsx/esm", "src/server.ts"]
