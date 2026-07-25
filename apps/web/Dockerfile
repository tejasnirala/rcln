# =============================================================================
# Web production image. Build from the REPO ROOT:
#   docker build -f apps/web/Dockerfile -t rcln-web .
#
# Relies on `output: 'standalone'` in next.config.ts, which traces the modules
# the build actually reaches and emits a self-contained server. Without it this
# image would have to carry the whole ~1 GB pnpm workspace.
# =============================================================================

FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat && corepack enable pnpm
WORKDIR /app

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
ENV HUSKY=0
RUN pnpm install --frozen-lockfile

# -----------------------------------------------------------------------------
# Build
# -----------------------------------------------------------------------------
FROM base AS build
# Switches on `output: 'standalone'` + outputFileTracingRoot in next.config.ts.
# Only ever set here, never in dev.
ENV HUSKY=0 NEXT_TELEMETRY_DISABLED=1 NEXT_OUTPUT_STANDALONE=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm install --frozen-lockfile --offline \
 && pnpm --filter @rcln/contracts --filter @rcln/permissions run build \
 && pnpm --filter @rcln/web run build

# -----------------------------------------------------------------------------
# Runtime — standalone output only
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# standalone preserves the monorepo layout, so server.js sits under apps/web.
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/apps/web/.next/static     ./apps/web/.next/static
COPY --from=build --chown=nextjs:nodejs /app/apps/web/public           ./apps/web/public

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
