# ADR-0009 — Docker-first development environment

**Status:** Accepted

## Context

Onboarding should not require installing Node, pnpm, Postgres and Redis, and
"works on my machine" divergence is expensive. Native modules make it worse:
`@node-rs/argon2` and the Prisma query engine are compiled per platform, so a
macOS binary cannot run in a Linux container.

## Decision

`docker compose up` starts everything, with source bind-mounted for hot reload.
Docker is the only prerequisite. Native and hybrid paths remain documented in
the README for people who want them.

Key mechanics:

- **One shared image** (`rcln-dev:local`) for api, web, worker and migrate —
  identical workspace, only the command differs. Sharing the `image:` tag also
  avoids a real footgun: `docker compose build api` would otherwise leave the
  other three services on a stale image.
- **Named volumes over every `node_modules` path.** The repo bind mount would
  otherwise shadow the container's modules with the host's — empty at best,
  macOS binaries at worst. A more specific mount path wins over a less specific
  one, which is what makes this work.
- **Prisma client generated in-container** into a volume, so the query engine
  matches the image's libc rather than the host's.
- **Entrypoint reconciles state**: hashes `pnpm-lock.yaml` and reinstalls only
  when it changes, generates the client if missing, builds shared packages,
  waits for Postgres.
- **`migrate` is a one-shot service.** Migrations must run exactly once, not
  once per replica, and they connect as the owner role while the api connects as
  the app role.

## Build context

`.dockerignore` reduces it from **996 MB / 58,347 files to 1.4 MB / 110 files**.
Without it every build uploads the entire `node_modules` to the daemon before
running a single instruction.

Production images use `pnpm deploy --prod --legacy`, which resolves workspace
symlinks into a self-contained tree of only the dependencies that app reaches.
`--legacy` is required from pnpm 10; the alternative
(`inject-workspace-packages=true`) would hard-copy workspace deps at install
time and break shared-package hot reload in development.

**Prune in the build stage, never the runtime stage.** Deleting files in a later
layer leaves them in the earlier one and the image does not shrink — that
mistake cost 240 MB before it was caught.

## Watching and memory

File watching uses **native events, not polling**. Polling was the default
initially; a polling watcher stats the whole bind-mounted tree on every tick and
was a contributing factor in an OOM kill. `WATCH_POLL=true` remains available if
a machine genuinely needs it.

Each service has a `mem_limit` (web 3g, api 1g, worker 768m) so a runaway build
fails one container with a clear signal instead of starving the host.

## How it can be broken

- Removing a `node_modules` volume from a service — it will then use the host's.
- Adding a `build:` block without the shared `image:` tag.
- Adding a heavy path to `outputFileTracingRoot` or similar (see ADR-0010).
