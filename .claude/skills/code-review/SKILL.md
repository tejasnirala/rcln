---
name: code-review
description: Run a comprehensive review on changed rcln files — automated checks (validate + RLS check) plus the code-reviewer and security-reviewer subagents — and produce a consolidated report. Invoke with /code-review or /code-review <path>.
---

# Code Review (rcln)

**Target:** $ARGUMENTS (defaults to all changed files)

## 1. Identify Files to Review

```bash
git status --short
git diff --name-only HEAD
```

Note which workspaces are affected — `apps/api`, `apps/web`, `apps/worker`, `packages/db`, `packages/contracts`, `packages/permissions` — because it decides which passes below are relevant.

## 2. Run Automated Checks (blocking)

```bash
docker compose exec api pnpm validate      # typecheck + lint + test
docker compose exec api pnpm db:rls:check  # if packages/db changed
```

Report real failures with their output. `validate` is the merge gate. If the schema changed and `db:rls:check` was not run, the review is incomplete — say so.

## 3. Schema & migration pass (if `packages/db` changed)

Before delegating, check by hand:

- New tenant table → `organizationId` + `@@unique([organizationId, id])`?
- Policy added to `packages/db/prisma/rls/enable-rls.sql` **and appended to the generated `migration.sql`**?
- A case added to `apps/api/tests/integration/tenant-isolation.test.ts`?
- Hand-written SQL present for anything Prisma does not manage (triggers, `NULLS NOT DISTINCT`, partial indexes)?
- No already-applied migration edited in place?

A missing RLS policy is the highest-value finding this review can produce: it throws no error, fails no single-tenant test, and starts returning other clinics' patient records.

## 4. Run the `code-reviewer` subagent

Delegate the invariant/quality review, passing the file list and diffs. It checks: raw Prisma imports, `withTenant` usage and granularity, explicit `organizationId`, tenant-qualified uniques, middleware order, 404-not-403, Zod at the boundary from `@rcln/contracts`, permission codes, typed errors and structural Prisma narrowing, strict-TS compliance (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), ESM `.js` extensions, Next 16 specifics, logging and Redis rules.

## 5. Run the `security-reviewer` subagent

Delegate — especially if the diff touches the schema, tenancy, auth, permissions, patient data, billing, or raw SQL. It checks: RLS coverage, `rcln_app` vs `rcln_owner`, tenant-context leakage across the pool, composite FKs, IDOR, tenant enumeration, token/permission-in-JWT issues, PHI in logs/Redis/URLs, missing PHI-read audit, `$queryRaw` interpolation, mass assignment, webhook signature verification, secrets and `NEXT_PUBLIC_*`.

## 5b. Performance pass — `apps/web` only

If the diff touches components, data fetching, or rendering, check it against the `vercel-react-best-practices` rules (`.claude/skills/vercel-react-best-practices/rules/`). Prioritize `async-*` (waterfalls, missing `Promise.all`), `bundle-*` (barrel imports, heavy components not dynamically imported), `server-*` (parallel fetching, no shared module state), then `rerender-*`. Cite the rule id.

For `apps/api`, the equivalent performance questions are: N+1 queries, `withTenant` called in a loop (one transaction round-trip each), a missing index behind a new query predicate, and work in the request path that belongs on a BullMQ queue.

## 6. Consolidated Report

```
## Code Review Summary

### Automated Checks
- typecheck: PASS / FAIL (N errors)
- lint:      PASS / FAIL (N issues)
- test:      PASS / FAIL (N failing)
- db:rls:check: PASS / FAIL / N/A

### Tenancy & Schema
[CRITICAL] ...

### Invariants & Quality (code-reviewer)
[CRITICAL] ...
[WARNING]  ...

### Security & PHI (security-reviewer)
[CRITICAL] ...
[HIGH]     ...

### Performance
[async-parallel] ...
[api] N+1 in ...

### Must Fix Before Merge
1. ...

### Suggested Improvements
1. ...
```

## Review Priorities (in order)

1. **Cross-tenant exposure** — missing RLS policy, missing composite FK, tenant context outside a transaction, raw Prisma client. Always blocks merge.
2. **PHI exposure** — in logs, Redis, URLs, or an unaudited read.
3. **Authz bypass** — middleware order, missing `authorize`, DENY dropped from resolution.
4. **Correctness bugs**, especially money arithmetic and anything read-then-write without a constraint or lock.
5. **Invariant violations** (the five in `CLAUDE.md`) — block merge; each has an ADR.
6. **Test gaps** — a new tenant table with no `tenant-isolation.test.ts` case.
7. **Typecheck / lint failures.**

Also flag when a change contradicts an ADR: the fix is either a different design or a new ADR superseding it, never a silent deviation.
