# =============================================================================
# Worker production image. Build from the REPO ROOT:
#   docker build -f apps/worker/Dockerfile -t rcln-worker .
#
# Same shape as the api image. Kept as a separate service, not a thread inside
# the api, so a slow PDF render or a stalled WhatsApp provider can never occupy
# a request handler — and so the two scale independently.
# =============================================================================

FROM node:26-alpine AS base
RUN apk add --no-cache libc6-compat && corepack enable pnpm
WORKDIR /app
ENV HUSKY=0

# -----------------------------------------------------------------------------
# Dependencies — cached on manifests alone
# -----------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json             apps/api/
COPY apps/web/package.json             apps/web/
COPY apps/worker/package.json          apps/worker/
COPY packages/db/package.json          packages/db/
COPY packages/contracts/package.json   packages/contracts/
COPY packages/permissions/package.json packages/permissions/
COPY packages/config/package.json      packages/config/
COPY packages/documents/package.json   packages/documents/
COPY packages/queue/package.json       packages/queue/
COPY packages/storage/package.json     packages/storage/
COPY packages/payments/package.json    packages/payments/
COPY packages/billing/package.json     packages/billing/
COPY packages/tax/package.json         packages/tax/
COPY packages/invoicing/package.json   packages/invoicing/
RUN pnpm install --frozen-lockfile

# -----------------------------------------------------------------------------
# Build
# -----------------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm install --frozen-lockfile --offline \
 && pnpm --filter @rcln/db run generate \
 && pnpm --filter @rcln/permissions --filter @rcln/contracts --filter @rcln/db \
      --filter @rcln/payments --filter @rcln/tax --filter @rcln/invoicing \
      --filter @rcln/storage --filter @rcln/queue --filter @rcln/documents \
      --filter @rcln/billing run build \
 && pnpm --filter @rcln/worker run build \
 && pnpm --filter @rcln/worker --prod --legacy deploy /pruned

# -----------------------------------------------------------------------------
# Runtime
# -----------------------------------------------------------------------------
FROM node:26-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# ⚠️ CHROMIUM IS IN THE WORKER IMAGE AND IN NEITHER OF THE OTHER TWO. It is here
#   because this is the process that renders invoice PDFs, and it is NOT in the
#   api image because that container serves requests under a memory cap — see
#   apps/worker/src/documents/browser.ts. It is the distribution's build, not one
#   Playwright downloaded: Playwright's is glibc and this base is musl, so its
#   binary installs fine and then cannot start.
RUN apk add --no-cache libc6-compat chromium nss freetype harfbuzz ttf-freefont \
 && addgroup -g 1001 -S nodejs && adduser -S rcln -u 1001
ENV CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# `pnpm deploy` flattens the workspace into a self-contained tree with only the
# production dependencies this app actually reaches.
COPY --from=build --chown=rcln:nodejs /pruned ./
COPY --from=build --chown=rcln:nodejs /app/packages/db/generated ./node_modules/@rcln/db/generated

USER rcln

# No port and no HTTP healthcheck: the worker only consumes from Redis.
# Liveness is judged by the orchestrator on process exit.
CMD ["node", "dist/index.js"]
