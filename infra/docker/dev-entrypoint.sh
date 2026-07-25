#!/bin/sh
set -e

# =============================================================================
# Dev container entrypoint.
#
# Runs before every service (api, web, worker, migrate). Brings the container's
# installed tree in step with the bind-mounted source without a rebuild, then
# hands off to the service's own command.
# =============================================================================

log() { echo "[dev-entrypoint] $*"; }

# pnpm refuses to modify a node_modules directory it considers foreign unless it
# knows it is non-interactive. Without this it aborts with
# ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY.
export CI=true

LOCK=/app/pnpm-lock.yaml
STAMP=/app/node_modules/.rcln-lock-hash

# ---------------------------------------------------------------------------
# 1. Dependencies.
#
# node_modules lives in a named volume seeded from the image, so it is already
# correct on first boot. It can drift from the lockfile after a git pull, so we
# hash the lockfile and reinstall only when that hash changes — reinstalling on
# every boot would cost ~50s for nothing.
# ---------------------------------------------------------------------------
current_hash=$(md5sum "$LOCK" 2>/dev/null | cut -d' ' -f1)
stored_hash=$(cat "$STAMP" 2>/dev/null || echo "none")

if [ ! -d /app/node_modules/.pnpm ]; then
  log "node_modules volume is empty — installing"
  pnpm install --frozen-lockfile
  echo "$current_hash" > "$STAMP"
elif [ "$current_hash" != "$stored_hash" ]; then
  log "lockfile changed — reinstalling"
  pnpm install --frozen-lockfile
  echo "$current_hash" > "$STAMP"
else
  log "dependencies up to date"
fi

# ---------------------------------------------------------------------------
# 2. Prisma client.
#
# Generated inside the container so the query engine matches this image's libc,
# never the host's. Lives in a named volume for the same reason.
# ---------------------------------------------------------------------------
if [ ! -f /app/packages/db/generated/prisma/index.js ]; then
  log "generating prisma client"
  pnpm --filter @rcln/db run generate
fi

# ---------------------------------------------------------------------------
# 3. Shared packages.
#
# api/web/worker import @rcln/db, @rcln/contracts and @rcln/permissions from
# their dist output, so it must exist before any service starts.
# ---------------------------------------------------------------------------
if [ ! -f /app/packages/permissions/dist/index.js ] || [ ! -f /app/packages/db/dist/index.js ]; then
  log "building workspace packages"
  pnpm --filter @rcln/permissions --filter @rcln/contracts --filter @rcln/db run build
fi

# ---------------------------------------------------------------------------
# 4. Wait for Postgres.
#
# compose healthchecks cover the common case, but a container restarting faster
# than the database recovers would otherwise crash-loop.
# ---------------------------------------------------------------------------
if [ -n "$DATABASE_URL" ] && [ "$WAIT_FOR_DB" != "false" ]; then
  log "waiting for postgres"
  i=0
  # Uses node's built-in net, NOT the pg package: pnpm's isolated node_modules
  # layout does not hoist pg to /app/node_modules, so require('pg') from here
  # fails and the loop would spin until timeout with the error swallowed.
  until node -e "
    const net = require('net');
    const u = new URL(process.env.DATABASE_URL);
    const s = net.connect({ host: u.hostname, port: u.port || 5432 });
    s.on('connect', () => { s.end(); process.exit(0); });
    s.on('error', () => process.exit(1));
    setTimeout(() => process.exit(1), 2000);
  " 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -ge 60 ]; then
      log "postgres did not become reachable in 60s"
      exit 1
    fi
    sleep 1
  done
  log "postgres reachable"
fi

log "starting: $*"
exec "$@"
