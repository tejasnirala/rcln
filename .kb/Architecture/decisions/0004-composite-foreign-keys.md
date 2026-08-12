# ADR-0004 — Composite foreign keys on `(organization_id, id)`

**Status:** Accepted

## Context

RLS filters what a _connection_ can see. It does not stop correctly-scoped code
from writing a row that references another tenant's row — for example an
appointment in org A pointing at a branch in org B. That is a data-integrity
problem, not a visibility one.

## Decision

Tenant tables declare `@@unique([organizationId, id])`, and children reference
the pair rather than the bare id:

```prisma
branch Branch? @relation(
  fields:     [organizationId, branchId],
  references: [organizationId, id]
)
```

Generated SQL:

```sql
FOREIGN KEY ("organization_id", "branch_id")
REFERENCES "branches" ("organization_id", "id")
```

## Consequences

- A cross-tenant reference is rejected by the database, for **every** role —
  foreign keys bind the owner and superusers too, unlike RLS. Verified in
  the tenant-isolation suite.
- Child tables must denormalise `organization_id` even when it is derivable.
  `membership_roles` carries it for exactly this reason; it also lets RLS filter
  without a join.

## The nullable-unique trap

Postgres unique indexes treat NULLs as **distinct**, so
`UNIQUE (organization_id, code)` does not prevent two system roles both having
`organization_id = NULL` and `code = 'SUPER_ADMIN'`. The same hole existed on
`membership_roles (membership_id, role_id, branch_id)` — where a NULL
`branch_id` is precisely the row that most needs to be unique.

Fixed with `NULLS NOT DISTINCT` (Postgres 15+) in migration
`20260725060000_null_safe_unique_constraints`. Any new unique index over a
nullable column needs the same treatment.

## How it can be broken

Adding a tenant child table with a plain `id` reference. It will work, tests
will pass, and cross-tenant writes become possible.
