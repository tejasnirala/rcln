# ADR-0002 — Roles live on the membership, not the user

**Status:** Accepted

## Context

The predecessor schema put `email` on an `auth.roles` table, and had
`users`, `patients` and `doctors` each foreign-key to it. "Role" was really an
account. One human occupied up to three rows, and a unique email constraint made
"the same doctor at two clinics" literally unrepresentable.

The requirements included: a doctor practising at several clinics; one admin
over three branches; a separate admin per branch; an admin over branches A and B
alongside another over A only.

## Decision

One `users` table for every human — super admin, doctor, receptionist,
pharmacist, patient. It carries credentials and nothing role-shaped except
`is_platform_admin`. Then:

```
memberships       user × organization
membership_roles  membership × role × branch_id NULLABLE
```

`branch_id NULL` means **every branch in the organization**.

| Requirement                      | Rows in `membership_roles`                |
| -------------------------------- | ----------------------------------------- |
| One admin over all branches      | 1 row, `branch_id = NULL`                 |
| A separate admin per branch      | 1 row each, `branch_id` set               |
| Admin over A+B, another over A   | 2 rows + 1 row                            |
| Doctor at A, receptionist at C   | 2 rows, different `role_id` + `branch_id` |
| Same person in two organizations | 2 memberships, one `users` row            |

## Consequences

- The UI branch switcher is a query over `membership_roles` — no extra table.
- Effective permission is: DENY override → GRANT override → role grants whose
  assignment applies to this branch → deny. Implemented in
  `@rcln/permissions/resolver.ts`, asserted by 25 tests.
- The permission list is deliberately **not** in the JWT: it goes stale the
  moment a role changes and is too large for a header.
- Nullable `branch_id` needs `NULLS NOT DISTINCT` on its unique index, or the
  "all branches" row can be inserted twice. See ADR-0004's note on nulls.

## How it can be broken

Adding a `role` column to `users` "just for convenience". The original Prisma
scaffold had exactly that (`role Role @default(USER)`) and it was deleted in the
first commit. Anything that needs a per-user default belongs on the membership.
