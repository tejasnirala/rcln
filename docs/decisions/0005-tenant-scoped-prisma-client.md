# ADR-0005 — All queries go through `withTenant()`

**Status:** Accepted

## Context

RLS policies read `current_setting('app.current_org')`. Postgres session
settings live on the **connection**. Prisma pools connections. A connection
still holding org A's setting, handed to a request for org B, leaks patient data
across clinics — silently.

## Decision

Set the variables with `set_config(key, value, true)`. The third argument makes
them **transaction-local**: they revert on COMMIT or ROLLBACK. Every
tenant-scoped operation therefore runs inside a transaction that sets them
first. `packages/db/src/tenant.ts` exposes two forms:

- `withTenant(ctx, fn)` — **preferred.** Wraps a unit of work. The session
  round-trip is paid once per transaction, so group related queries into one
  call.
- `forTenant(ctx)` — a Prisma client extension wrapping every operation
  individually. Convenient, but pays the cost per query. Use only when the call
  site cannot be restructured.

The raw client is not exported from the package index. An eslint rule
(`no-restricted-imports` in `@rcln/config/eslint-node`) bans importing
`@prisma/client` or the generated client directly.

## Consequences

- Roughly two extra round-trips per transaction. Mitigated by grouping queries
  and by caching tenant/permission lookups in Redis.
- PgBouncer **transaction** pooling mode is safe, which it would not be with
  session-level settings.
- Legitimate unscoped access exists: hostname → tenant resolution, login by
  email, platform-admin reads. Those import from `@rcln/db/unsafe`, a separate
  path so `grep -r "@rcln/db/unsafe"` lists every bypass for review.

## How it can be broken

- Importing the generated client directly (guard: eslint rule).
- Using `SET` instead of `SET LOCAL` / `set_config(..., true)` — the setting
  then persists on the pooled connection. This is the actual leak.
- Adding a repository that takes a `PrismaClient` parameter and letting a caller
  pass the unscoped one.
