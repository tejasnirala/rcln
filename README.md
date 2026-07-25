# rcln

Multi-tenant healthcare management SaaS. A clinic registers, gets its own
subdomain (`alpha.xyz.com`), and runs appointments, prescriptions, lab, pharmacy
and billing across one or many branches.

- **Schema design** — [`docs/schema/schema-design.md`](docs/schema/schema-design.md)
- **Architecture** — [`docs/architecture.md`](docs/architecture.md)

---

## Quick start

```bash
corepack enable pnpm          # pnpm 10, pinned via packageManager
pnpm install
cp .env.example .env          # then set JWT_SECRET: openssl rand -base64 48

pnpm infra:up                 # postgres + redis + mailpit
pnpm db:migrate               # schema + RLS policies
pnpm db:seed                  # permissions, system roles, plans, super admin

pnpm dev                      # api :5000, web :3000, worker
```

Then:

| URL                                 | What                                                         |
| ----------------------------------- | ------------------------------------------------------------ |
| http://localhost:3000               | marketing / platform root                                    |
| http://alpha.lvh.me:3000            | a tenant (`lvh.me` resolves to 127.0.0.1, no host-file edit) |
| http://admin.lvh.me:3000            | super-admin console                                          |
| http://localhost:5000/api/v1/health | api liveness                                                 |
| http://localhost:8025               | mailpit — every outbound email in dev                        |

---

## Layout

```
apps/
  api/        Express 5 — tenant resolution, auth, RBAC, domain modules
  web/        Next.js 16 — tenant app + platform console
  worker/     BullMQ — notifications, documents, billing, inventory sweeps
packages/
  db/         Prisma schema, migrations, RLS policies, tenant-scoped client
  contracts/  Zod schemas shared by api and web (validation + inferred types)
  permissions/ permission catalogue, system roles, effective-permission resolver
  config/     shared eslint / tsconfig presets
infra/
  postgres/   init SQL — creates the owner/app role split RLS depends on
```

---

## The three things to understand before changing anything

### 1. Organization is the tenant; branch is the place

A solo clinic and a three-branch hospital are the same shape: one
`organization`, one or three `branches`. Opening a location is an INSERT, never
a migration.

### 2. Roles live on the membership, not the user

There is no `role` column on `users`. Access is:

```
memberships       user × organization
membership_roles  membership × role × branch_id NULLABLE
```

`branch_id NULL` means every branch in the org. That single nullable column is
the whole multi-branch admin story:

| Requirement                    | Rows in `membership_roles`                |
| ------------------------------ | ----------------------------------------- |
| One admin over all branches    | 1 row, `branch_id = NULL`                 |
| A separate admin per branch    | 1 row each, `branch_id` set               |
| Admin over A+B, another over A | 2 rows + 1 row                            |
| Doctor at A, receptionist at C | 2 rows, different `role_id` + `branch_id` |

Asserted in `packages/permissions/tests/resolver.test.ts`.

### 3. Tenant isolation is enforced by Postgres, not by the ORM

Three independent layers, because a cross-tenant leak in healthcare ends the
company:

1. **Row-level security.** Every tenant table has a policy on
   `organization_id = app_current_org()`. With no context set, queries return
   nothing — it fails closed.
2. **Composite foreign keys.** Children reference `(organization_id, id)`, so a
   row pointing at another tenant's branch is physically unrepresentable.
3. **Application scoping.** Services pass `organizationId` explicitly.

**The role split matters.** Postgres exempts a table's owner from its own
policies, so:

| Role         | Used by                | RLS      |
| ------------ | ---------------------- | -------- |
| `rcln_owner` | migrations, seeds      | bypassed |
| `rcln_app`   | api, worker at runtime | enforced |

Policies are `ENABLE`, not `FORCE` — the owner needs the bypass to migrate.
The risk that creates (someone pointing `DATABASE_URL` at the owner) is caught
by `assertRlsActive()`, which refuses to boot the API on an owner or superuser
connection. Loud at startup beats silent at query time.

**Never import the raw Prisma client.** Use `withTenant(ctx, …)` from
`@rcln/db`; an eslint rule enforces it. Session variables are set with
`set_config(..., true)`, which is transaction-local, so a pooled connection can
never carry one tenant's context into another's request.

---

## Commands

| Command              | What                                         |
| -------------------- | -------------------------------------------- |
| `pnpm dev`           | all apps in watch mode                       |
| `pnpm validate`      | typecheck + lint + test — run before pushing |
| `pnpm db:migrate`    | create and apply a migration                 |
| `pnpm db:rls:check`  | fail if any tenant table lacks a policy      |
| `pnpm db:studio`     | Prisma Studio                                |
| `pnpm infra:up/down` | local services                               |
| `pnpm infra:nuke`    | drop volumes and start clean                 |

### Adding a tenant table

RLS is not generated by Prisma Migrate, so:

1. Add the model with `organizationId` and `@@unique([organizationId, id])`.
2. `pnpm db:migrate --name your_change`
3. Add the table to the `org_scoped` array in
   `packages/db/prisma/rls/enable-rls.sql`.
4. Append that file's contents to the generated `migration.sql`.
5. `pnpm db:rls:check` — it fails until the policy exists.
6. Add a case to `apps/api/tests/integration/tenant-isolation.test.ts`.

Step 5 is why the check exists: a missing policy throws no error and breaks no
single-tenant test. It just starts returning other clinics' records.

---

## Status

Phase 0 (foundation) is complete: monorepo, schema for tenancy/subscriptions/
identity/RBAC/settings/audit, RLS with CI enforcement, tenant resolution,
seeded system roles and super admin.

Phase 1 is auth endpoints, org registration, branch CRUD and the branch
switcher. See §17 of [`docs/architecture.md`](docs/architecture.md) for the
full sequence.
