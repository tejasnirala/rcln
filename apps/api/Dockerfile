# =============================================================================
# API production image. Build from the REPO ROOT, not from apps/api:
#   docker build -f apps/api/Dockerfile -t rcln-api .
# The build needs packages/db, packages/contracts and packages/permissions,
# which live outside this directory.
# =============================================================================

FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat && corepack enable pnpm
WORKDIR /app
ENV HUSKY=0

# -----------------------------------------------------------------------------
# Dependencies — cached on manifests alone so source edits never reinstall
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
# Build, then prune.
#
# `pnpm deploy --prod` is what keeps this image small: it resolves the workspace
# symlinks into a real, self-contained tree containing only the production
# dependencies this app actually reaches. Copying /app/node_modules instead
# would drag in the entire ~1 GB pnpm store, including every dev dependency and
# the other apps' packages.
#
# --legacy is required from pnpm 10: without it, deploy demands
# inject-workspace-packages=true, which would hard-copy workspace deps at
# install time and break shared-package hot reload in development.
# -----------------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm install --frozen-lockfile --offline \
 && pnpm --filter @rcln/db run generate \
 && pnpm --filter @rcln/permissions --filter @rcln/contracts --filter @rcln/db run build \
 && pnpm --filter @rcln/api run build \
 && pnpm --filter @rcln/api --prod --legacy deploy /pruned \
 # Pruned HERE, not in the runtime stage: deleting files in a later layer
 # leaves them in the earlier one and the image does not get smaller.
 # auto-install-peers=true drags these in as peers of @prisma/client. The
 # runtime needs @prisma/client and its engine; it never needs the CLI,
 # Studio, Studio's embedded pglite, or the TypeScript compiler.
 && rm -rf /pruned/node_modules/.pnpm/prisma@* \
           /pruned/node_modules/.pnpm/@prisma+studio-core@* \
           /pruned/node_modules/.pnpm/@electric-sql+pglite@* \
           /pruned/node_modules/.pnpm/effect@* \
           /pruned/node_modules/.pnpm/elkjs@* \
           /pruned/node_modules/.pnpm/typescript@* \
           /pruned/node_modules/prisma \
           /pruned/node_modules/typescript \
 && find /pruned/node_modules \( -name '*.md' -o -name '*.map' -o -name '*.ts' \) -delete 2>/dev/null || true

# -----------------------------------------------------------------------------
# Runtime
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache libc6-compat \
 && addgroup -g 1001 -S nodejs && adduser -S rcln -u 1001

COPY --from=build --chown=rcln:nodejs /pruned ./
# The Prisma client is generated, not installed, so `deploy` does not carry it.
COPY --from=build --chown=rcln:nodejs /app/packages/db/generated ./node_modules/@rcln/db/generated


USER rcln
EXPOSE 5000

# The process starts only if it can prove RLS applies to its own connection
# (assertRlsActive), so a misconfigured DATABASE_URL fails this health check
# instead of quietly serving other tenants' data.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
