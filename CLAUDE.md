# CLAUDE.md

Context for Claude Code sessions on this repository. Read this first, then the
linked doc for whatever you are actually touching.

## What this is

**rcln** — a multi-tenant healthcare management SaaS. A clinic registers, gets
its own subdomain (`alpha.xyz.com`), and runs appointments, prescriptions, lab,
pharmacy, inventory and billing across one or many branches. Subscription-billed.
India-first (GST, HSN codes, ABHA all appear in the domain model).

Stack: pnpm monorepo · Express 5 · Next.js 16 · Postgres 16 · Prisma 7 · Redis ·
BullMQ · TypeScript everywhere.

## Where things are

| Doc                                                            | Read it when                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [`docs/STATUS.md`](docs/STATUS.md)                             | **Start here.** What is built, what is next                              |
| [`docs/decisions/`](docs/decisions/)                           | Before changing anything structural — these are the load-bearing choices |
| [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md)                   | Writing any code                                                         |
| [`docs/PITFALLS.md`](docs/PITFALLS.md)                         | Something behaves strangely — it may already be documented               |
| [`docs/schema/schema-design.md`](docs/schema/schema-design.md) | Touching the database. Full ERD for all domains                          |
| [`docs/architecture.md`](docs/architecture.md)                 | Infrastructure, deployment, third-party choices                          |
| [`README.md`](README.md)                                       | Setup and day-to-day commands                                            |

## The five invariants

Breaking any of these is a correctness or security regression, not a style
choice. Each has an ADR explaining why; read it before arguing with it.

1. **Organization is the tenant, branch is the place.** A solo clinic and a
   three-branch hospital are the same shape. There is no "clinic" entity.
   → [ADR-0001](docs/decisions/0001-organization-is-the-tenant.md)

2. **No role column on `users`.** Roles live on
   `membership_roles (membership × role × branch_id NULLABLE)`, where NULL means
   every branch in the org. → [ADR-0002](docs/decisions/0002-roles-live-on-membership.md)

3. **Tenant isolation is enforced by Postgres.** RLS policies + composite FKs +
   application scoping, three independent layers. The app connects as
   `rcln_app` (RLS enforced); migrations use `rcln_owner` (RLS bypassed).
   → [ADR-0003](docs/decisions/0003-rls-enable-not-force.md),
   [ADR-0004](docs/decisions/0004-composite-foreign-keys.md)

4. **Never import the raw Prisma client.** Use `withTenant(ctx, …)` from
   `@rcln/db`. An eslint rule enforces it; `@rcln/db/unsafe` is the audited
   escape hatch. → [ADR-0005](docs/decisions/0005-tenant-scoped-prisma-client.md)

5. **No JSON arrays of foreign keys.** Real join tables. Per-specialty variation
   goes through versioned form templates — JSONB as a document, never as a
   foreign key. → [ADR-0006](docs/decisions/0006-no-json-id-arrays.md)

## Running it

```bash
docker compose up          # everything, hot-reloaded. Needs only Docker.
```

Workspace commands inside the container:
`docker compose exec api pnpm <script>`. See README for the native paths.

## Before you finish any task

```bash
docker compose exec api pnpm validate      # typecheck + lint + test
docker compose exec api pnpm db:rls:check  # if you touched the schema
```

If you added a tenant table, it needs an RLS policy in
`packages/db/prisma/rls/enable-rls.sql`, appended to the generated migration,
plus a case in `apps/api/tests/integration/tenant-isolation.test.ts`.
`db:rls:check` fails until the policy exists — that is deliberate, because a
missing policy produces no error and breaks no single-tenant test. It just
starts returning other clinics' patient records.

## Working agreements

- **Verify, do not assume.** This codebase has already produced several bugs
  that typecheck cleanly and fail only at runtime (see `docs/PITFALLS.md`).
  Run the thing. Curl the endpoint. Check the container actually stayed up.
- **`apps/web` is Next.js 16**, which renamed `middleware.ts` → `proxy.ts` and
  removed the `eslint` config key. Read `node_modules/next/dist/docs/` before
  writing Next code — `apps/web/AGENTS.md` says so for good reason.
- **Do not commit or push** unless asked.
- Update `docs/STATUS.md` when you finish a phase or change direction.
