# =============================================================================
# Worker production image. Build from the REPO ROOT:
#   docker build -f apps/worker/Dockerfile -t rcln-worker .
#
# Same shape as the api image. Kept as a separate service, not a thread inside
# the api, so a slow PDF render or a stalled WhatsApp provider can never occupy
# a request handler — and so the two scale independently.
# =============================================================================

FROM node:25-alpine AS base
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
RUN pnpm install --frozen-lockfile

# -----------------------------------------------------------------------------
# Build
# -----------------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm install --frozen-lockfile --offline \
 && pnpm --filter @rcln/db run generate \
 && pnpm --filter @rcln/permissions --filter @rcln/contracts --filter @rcln/db run build \
 && pnpm --filter @rcln/worker run build \
 && pnpm --filter @rcln/worker --prod --legacy deploy /pruned

# -----------------------------------------------------------------------------
# Runtime
# -----------------------------------------------------------------------------
FROM node:25-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache libc6-compat \
 && addgroup -g 1001 -S nodejs && adduser -S rcln -u 1001

# `pnpm deploy` flattens the workspace into a self-contained tree with only the
# production dependencies this app actually reaches.
COPY --from=build --chown=rcln:nodejs /pruned ./
COPY --from=build --chown=rcln:nodejs /app/packages/db/generated ./node_modules/@rcln/db/generated

USER rcln

# No port and no HTTP healthcheck: the worker only consumes from Redis.
# Liveness is judged by the orchestrator on process exit.
CMD ["node", "dist/index.js"]
