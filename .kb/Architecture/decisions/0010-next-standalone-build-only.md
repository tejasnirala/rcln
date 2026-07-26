# ADR-0010 — Next standalone output is build-only

**Status:** Accepted. Decided wrong first, then corrected.

## Context

The production web image needs `output: 'standalone'` so Next emits a
self-contained server instead of requiring the ~1 GB pnpm workspace. In a
monorepo that also needs `outputFileTracingRoot` pointed at the repo root, so
tracing follows workspace symlinks (`@rcln/contracts` and friends).

## The wrong decision, first

Both options were set unconditionally in `next.config.ts`.

`next dev` reads the same config and treats `outputFileTracingRoot` as the
**project root**. The dev server therefore watched the entire monorepo root —
58,347 files, ~1 GB of `node_modules`. CPU pinned, and the container was
OOM-killed on first compile.

The failure was hard to read: the OOM killer took the `next dev` child, the
`pnpm` wrapper above it exited cleanly, and Docker recorded `ExitCode=0`. Only
`docker inspect ... --format '{{.State.OOMKilled}}'` revealed it. The logs showed
`✓ Ready` → `○ Compiling /` → nothing.

## Decision

Gate both options behind an explicit build flag, set only in
`apps/web/Dockerfile`'s build stage:

```ts
const isStandaloneBuild = process.env['NEXT_OUTPUT_STANDALONE'] === '1';
```

Deliberately a dedicated variable rather than a `NODE_ENV` check, so `next dev`
can never switch it on by accident.

The `.next` volume must be deleted after such a change
(`docker volume rm rcln_web_next`) — a cache built against the bad root carries
the problem forward.

## Consequences

- Dev config is minimal; production gets the small image.
- Config that affects the _build_ must be checked against its effect on
  `next dev`. They read the same file.

## How it can be broken

Adding any build-oriented Next option unconditionally. If it changes roots,
tracing or output, gate it behind the flag.

## Related

Next 16 also renamed `middleware.ts` → `proxy.ts` and **removed** the `eslint`
config key. `apps/web/AGENTS.md` instructs reading
`node_modules/next/dist/docs/` before writing Next code; both of these were hit
by not doing so.
