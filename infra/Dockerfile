# syntax=docker/dockerfile:1.7
# Staging / production images (week 2, ADR 0019). One build, three targets:
#   api   — the API bundle (node dist/server.js) with Chromium for the PDFs; one process, tini as PID 1
#   staff — the staff app's Next standalone server
#   tools — migrations and the setu_app password (pnpm --filter @setu/db migrate:deploy; pnpm db:set-app-password)
# Every image runs as a non-root user; the orchestrator restarts a container whose health check fails.
ARG NODE=node:22.20-bookworm-slim

FROM ${NODE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo

FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
# the staff app proxies /api to the API: Next bakes the rewrite at build time
ARG API_URL=http://api:4000
RUN pnpm --filter @setu/domain --filter @setu/contracts --filter @setu/i18n build \
 && pnpm --filter @setu/db exec prisma generate \
 && pnpm --filter @setu/api build \
 && cd apps/staff && API_URL=${API_URL} NEXT_TELEMETRY_DISABLED=1 pnpm exec next build
# the API's production node_modules, on its own
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm --filter @setu/api deploy --prod --legacy /out/api

# ── api ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
FROM ${NODE} AS api
RUN apt-get update && apt-get install -y --no-install-recommends tini chromium ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /out/api/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
COPY --from=build --chown=node:node /repo/apps/api/package.json ./package.json
COPY --from=build --chown=node:node /repo/packages/ui/fonts ./fonts
COPY --from=build --chown=node:node /repo/packages/db/prisma/schema.prisma ./prisma/schema.prisma
# Prisma's generated client goes beside the deployed @prisma/client (the CLI is fetched for this step only)
RUN npm install -g --no-fund --no-audit prisma@6.19.3 && prisma generate --schema ./prisma/schema.prisma \
 && npm rm -g prisma && rm -rf /root/.npm /root/.cache
ENV NODE_ENV=production API_PORT=4000 FONT_DIR=/app/fonts CHROMIUM_PATH=/usr/bin/chromium
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 CMD curl -fsS http://127.0.0.1:4000/ready || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/server.js"]

# ── staff ───────────────────────────────────────────────────────────────────────────────────────────────────────────
FROM ${NODE} AS staff
RUN apt-get update && apt-get install -y --no-install-recommends tini curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/staff/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/staff/.next/static ./apps/staff/.next/static
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 CMD curl -fsS http://127.0.0.1:3000/login -o /dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/staff/server.js"]

# ── tools (migrate) ─────────────────────────────────────────────────────────────────────────────────────────────────
FROM build AS tools
USER node
CMD ["sh", "-c", "pnpm --filter @setu/db migrate:deploy && pnpm db:set-app-password"]
