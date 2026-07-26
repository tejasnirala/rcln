---
name: db-migration
description: Change the rcln Prisma schema safely — model conventions, the RLS policy gauntlet, hand-written SQL Prisma Migrate cannot manage, and the tenant-isolation test. Invoke with /db-migration <what you are changing>.
---

# Database Migration (rcln)

**Change:** $ARGUMENTS

The riskiest workflow in this repo. A schema change that forgets one step produces no error, no failing test, and a cross-tenant data leak. Follow the whole sequence.

Read `docs/schema/schema-design.md` for the ERD and `docs/CONVENTIONS.md` for the column rules before editing.

## 1. Model the change — `packages/db/prisma/schema.prisma`

| Concern             | Rule                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------ |
| Primary key         | `uuid`, `@default(uuid())`                                                           |
| Tenant              | `organizationId` on every tenant table; `branchId` where location-scoped             |
| Composite FK target | `@@unique([organizationId, id])` on any table children will reference                |
| Soft delete         | `deletedAt DateTime?` — **never** `isDeleted Boolean`                                |
| Audit               | `createdAt`, `updatedAt`, plus `createdBy`/`updatedBy` where the actor matters       |
| Money               | `Decimal @db.Decimal(14, 2)` + explicit currency. Never float                        |
| Quantities          | `Decimal @db.Decimal(14, 3)` — half a tablet is real                                 |
| Time                | `DateTime @db.Timestamptz(6)`, stored UTC; `branches.timezone` for display           |
| Enums               | Prisma enums for closed sets; lookup tables for anything a tenant may extend         |
| Naming              | `snake_case` columns via `@map`, plural tables via `@@map`, `<singular>Id` relations |
| Uniqueness          | Always tenant-qualified: `@@unique([organizationId, code])`, never bare `code`       |

Children of a tenant table reference `(organization_id, id)`, not `id` alone — that is what makes a cross-tenant row unrepresentable (ADR-0004).

Decide org-scoped vs branch-scoped deliberately. Patients are org-scoped; the branch-local identity is the registration/MRN (ADR-0007).

## 2. Generate the migration

```bash
docker compose exec api pnpm db:migrate --name <snake_case_description>
```

## 3. Hand-edit the generated SQL — before committing

Prisma Migrate does **not** manage policies, triggers, partitions, or exclusion constraints. Open `packages/db/prisma/migrations/<timestamp>_<name>/migration.sql` and append what is needed:

- **RLS policy.** Add the table to the `org_scoped` array in `packages/db/prisma/rls/enable-rls.sql`, then append that file's contents to the migration.
- **Nullable unique columns** need `NULLS NOT DISTINCT` — a plain unique index does not constrain NULLs (ADR-0004).
- **Triggers** — e.g. the guard preventing a tenant from shadowing a system role code; trigger-maintained balances.
- **Partial indexes** — `WHERE deleted_at IS NULL` is cheap and worth it.
- **Backfill** for a new non-nullable column on a populated table: add nullable → backfill → set NOT NULL, in that order, in the same migration.

**Never edit an already-applied migration in place** — Prisma checksums it and CI will fail. Write a new one.

## 4. Prove the isolation

```bash
docker compose exec api pnpm db:rls:check
```

It fails until every tenant table has a policy. That is deliberate: a missing policy breaks no single-tenant test, it just starts returning other clinics' patient records.

Then add a case to **`apps/api/tests/integration/tenant-isolation.test.ts`** — the most important file in the repo. Real Postgres, real migrations, real RLS. Never mock Prisma.

```bash
docker compose exec api pnpm test
```

## 5. Downstream

- `pnpm db:generate` runs as part of migrate, but consumers read `@rcln/db` from `dist/` — rebuild if you changed the package's exported surface.
- Update `packages/db/prisma/seed.ts` if the change needs seed data (permissions, system roles, setting definitions, plans).
- Update `docs/schema/schema-design.md` — the ERD is documentation that is expected to be current.
- If the change touches an invariant, write the ADR in `docs/decisions/`.

## 6. Verify

```bash
docker compose exec api pnpm validate
docker compose exec api pnpm db:rls:check
```

Confirm the container actually stayed up (`assertRlsActive()` refuses to boot on an owner connection — that is a feature). Report real output.

## Checklist before you call it done

- [ ] `organizationId` + `@@unique([organizationId, id])` on every new tenant table
- [ ] Every `@@unique` tenant-qualified
- [ ] Table added to `enable-rls.sql`, and that SQL appended to `migration.sql`
- [ ] `NULLS NOT DISTINCT` for nullable uniques
- [ ] `deletedAt`, `createdAt`, `updatedAt` present
- [ ] Money/quantity/time types correct
- [ ] `db:rls:check` passes
- [ ] A `tenant-isolation.test.ts` case exists for each new table
- [ ] Seed and `docs/schema/schema-design.md` updated
- [ ] No applied migration edited in place
