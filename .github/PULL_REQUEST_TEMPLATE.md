<!--
Security fixes do not go through public pull requests.
See SECURITY.md — report privately first.
-->

## What and why

<!-- One paragraph. What changes, and what problem it solves. -->

Closes #

## How to verify

<!-- The commands or clicks a reviewer runs to see it work. -->

## Checklist

- [ ] `pnpm validate` passes (typecheck + lint + test)
- [ ] Commits follow Conventional Commits (commitlint passes)
- [ ] `pnpm kb` run and the refreshed `.kb` index committed
- [ ] No new `any`, no `!` silencing `noUncheckedIndexedAccess`
- [ ] Checked `pnpm kb:find` before adding any new helper, type or component
- [ ] No new dependency, or it is justified below

## Tenancy and data

- [ ] No raw Prisma client imported — all access goes through `withTenant`
      (or `@rcln/db/unsafe`, justified below)
- [ ] No PHI in logs, Redis, URLs, `localStorage`, or cookies
- [ ] Any new tenant-table uniqueness constraint is tenant-qualified
- [ ] No user input interpolated into `$queryRaw`

## Schema changes

<!-- Delete this section if packages/db/prisma/schema/ is untouched. -->

- [ ] RLS policy added to `packages/db/prisma/rls/enable-rls.sql`
- [ ] Policy SQL appended to the generated migration
- [ ] Case added to `apps/api/tests/integration/tenant-isolation.test.ts`
- [ ] `pnpm db:rls:check` passes
- [ ] No already-applied migration was edited in place

## Notes for the reviewer

<!-- Trade-offs, anything deliberately left out, new dependencies and why. -->
