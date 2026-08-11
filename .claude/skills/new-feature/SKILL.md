---
name: new-feature
description: Scaffold a complete end-to-end vertical slice for rcln following existing patterns — schema + RLS, contracts, permissions, service, route, web screen, tests. Invoke with /new-feature <feature-name>.
---

# New Feature Scaffold (rcln vertical slice)

You are scaffolding a new feature across the monorepo. A feature here is a **vertical slice**: it is not done when the endpoint returns 200, it is done when the tenant-isolation test proves another clinic cannot see it.

**Feature name:** $ARGUMENTS

Read `docs/STATUS.md` first — the feature may be part of a phase whose prerequisites do not exist yet (e.g. Phase 1's `authenticate`/`authorize` middleware pair). Say so rather than inventing them.

## 1. Clarify (ask only if not obvious)

- What entity does this manage, and which operations (list / detail / create / update / delete)?
- **Org-scoped or branch-scoped?** A patient is org-scoped (ADR-0007); a registration/MRN is branch-local. Getting this wrong is a migration later.
- Does it hold PHI? Which fields?
- Which roles may use it, and is the check org-wide or per-branch?
- Anything that must not run in the request path (notification, PDF, rollup)?

## 2. Design First

Use the `architect` subagent:

```
design the <feature-name> feature
```

Present the design before writing code. If it touches an invariant, it needs an ADR in `docs/decisions/`, not a comment.

## 3. Schema — `packages/db/prisma/schema/<domain>.prisma`

The schema is a folder of domain files that Prisma concatenates. Add the model
to the file for its domain (or a new `<domain>.prisma`), with its enums beside
it; `schema.prisma` holds only `generator` and `datasource`.

```prisma
model Example {
  id             String    @id @default(uuid())
  organizationId String    @map("organization_id")
  branchId       String?   @map("branch_id")
  // ... domain columns
  deletedAt      DateTime? @map("deleted_at") @db.Timestamptz(6)
  createdAt      DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt      DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)

  organization Organization @relation(fields: [organizationId], references: [id])

  @@unique([organizationId, id])          // composite-FK target for children
  @@unique([organizationId, code])        // uniqueness is always tenant-qualified
  @@map("examples")
}
```

Money `Decimal @db.Decimal(14, 2)` + currency. Quantities `Decimal(14, 3)`. Time `Timestamptz(6)`. Soft delete `deletedAt`, never `isDeleted`.

## 4. Migration + RLS — the part that is easy to skip and expensive to miss

```bash
docker compose exec api pnpm db:migrate --name add_<feature>
```

Then, **before committing**:

1. Add the table to the `org_scoped` array in `packages/db/prisma/rls/enable-rls.sql`.
2. Append that file's contents to the generated `migration.sql`.
3. Add any hand-written SQL Prisma does not manage: triggers, partial indexes, `NULLS NOT DISTINCT` for nullable uniques (ADR-0004), exclusion constraints.
4. `docker compose exec api pnpm db:rls:check` — it fails until the policy exists. That is deliberate.

Never edit an already-applied migration in place.

## 5. Contracts — `packages/contracts/src/<domain>.ts`

Zod schemas for request, params, and response; export the inferred types. Both api and web import from `@rcln/contracts` — do not redefine the shape on either side. Export from `packages/contracts/src/index.ts`.

## 6. Permissions — `packages/permissions/src/`

Add codes to `codes.ts` and grant them to the right system roles in `roles.ts`. Codes are referenced by constant, never as a string literal at the call site.

## 7. Service — `apps/api/src/services/<feature>.service.ts`

```ts
import { withTenant } from '@rcln/db';
import type { TenantContext } from '@rcln/db';

export async function listExamples(ctx: TenantContext, organizationId: string) {
  return withTenant(ctx, async (db) => {
    return db.example.findMany({
      where: { organizationId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  });
}
```

- Never import the raw Prisma client. eslint enforces it.
- `organizationId` explicit in the signature even though RLS also enforces it (ADR-0005).
- Group related queries into **one** `withTenant` call; the session round-trip is per transaction, not per query. Never `withTenant` inside a loop.
- Throw typed errors from `apps/api/src/utils/errors.ts`. Narrow Prisma errors by `err.name`, not `instanceof`.

## 8. Routes — `apps/api/src/routes/v1/<feature>.routes.ts`

Mount in `routes/v1/index.ts`. Middleware order is the security model:

```
resolveTenant → authenticate → authorize(PERMISSION_CODE) → withTenant → handler
```

- Validate with `validate.middleware.ts` using the `@rcln/contracts` schema.
- Respond through `apps/api/src/utils/response.ts`.
- Unknown tenant is **404, never 403**.
- Audit every mutation, and every PHI **read**.

## 9. Web — `apps/web/src/app/`

**If this slice has a UI, load the `frontend-design` skill now — before any JSX.** It sets palette, type, layout and the signature element; a visual direction retrofitted onto finished markup means rewriting the markup. Read `apps/web/AGENTS.md` for the two calibrations that matter here: clinical screens optimise for legibility and speed over expressiveness, and the design direction is set once by the first screen and inherited by every screen after it. If screens already exist, match them rather than inventing a second direction.

Under `t/[slug]/` for tenant screens, `platform/` for super-admin. Types from `@rcln/contracts`. Server components by default; `"use client"` only where interactivity needs it. Remember this is Next.js 16 — `proxy.ts` not `middleware.ts`, and read `node_modules/next/dist/docs/` rather than assuming Next 14/15 behaviour (`apps/web/AGENTS.md`).

Design the empty, loading and error states as part of the screen, not afterwards — an empty patient list is an invitation to act, and every clinical screen is empty on day one of a new clinic. Never use a real-looking patient name in placeholder copy.

## 10. Worker — `apps/worker/`

Anything slow, external, or retryable goes on a BullMQ queue with an idempotency key. Queues are registered but most processors are stubs — check before assuming one exists.

## 11. Tests

- **`apps/api/tests/integration/tenant-isolation.test.ts` — add a case for every new tenant table.** Non-negotiable. Real Postgres, real migrations, real RLS; never mock Prisma.
- Unit tests for service logic, permission resolution, and any arithmetic. Billing maths deserves property-based tests — rounding compounds.

## 12. Verify

```bash
docker compose exec api pnpm validate      # typecheck + lint + test
docker compose exec api pnpm db:rls:check
```

Then exercise it for real — `curl` the endpoint, load the page, check the container stayed up. This codebase has produced several bugs that typecheck cleanly and fail only at runtime (`docs/PITFALLS.md`). Report actual output; never claim a passing run you did not perform.

## 13. Update `docs/STATUS.md`

Move the item from "Not done" to "Done" when the slice is complete, including its tests.
