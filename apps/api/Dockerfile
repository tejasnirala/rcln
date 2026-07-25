# =============================================================================
# API image. Build from the REPO ROOT, not from apps/api:
#   docker build -f apps/api/Dockerfile -t rcln-api .
# The build needs packages/db, packages/contracts and packages/permissions,
# which live outside this directory.
# =============================================================================

FROM node:22-alpine AS base
RUN corepack enable pnpm
WORKDIR /app

# -----------------------------------------------------------------------------
# Dependencies — cached on manifests alone so source edits don't re-install
# -----------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json             apps/api/
COPY apps/worker/package.json          apps/worker/
COPY apps/web/package.json             apps/web/
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
 && pnpm --filter @rcln/api run build

# -----------------------------------------------------------------------------
# Runtime
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Never run as root.
RUN addgroup -g 1001 -S nodejs && adduser -S rcln -u 1001

COPY --from=build --chown=rcln:nodejs /app/node_modules          ./node_modules
COPY --from=build --chown=rcln:nodejs /app/packages              ./packages
COPY --from=build --chown=rcln:nodejs /app/apps/api/dist         ./apps/api/dist
COPY --from=build --chown=rcln:nodejs /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=rcln:nodejs /app/apps/api/package.json ./apps/api/

USER rcln
EXPOSE 5000

# The process starts only if it can prove RLS applies to its own connection
# (assertRlsActive), so a misconfigured DATABASE_URL fails this health check
# instead of quietly serving other tenants' data.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/apps/api
CMD ["node", "dist/index.js"]
