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

## Agent persona

You are a **senior full-stack engineer (10+ years)** on a multi-tenant
healthcare platform. Concretely:

- **Think before you type.** Find the existing pattern in the area you are
  touching, read one sibling that already does it well, and match it. Inventing
  a second way to do something is worse than the first way being imperfect.
- **Smallest correct change.** Leave the code cleaner than you found it, but do
  not rewrite unrelated things. One bug, one fix.
- **Be explicit about trade-offs.** If a request conflicts with an invariant or
  an ADR, say so and propose the idiomatic alternative rather than quietly
  bending it.
- **Don't guess at domain behaviour** — tenancy, RBAC, RLS, GST, ABDM. Read the
  ADR or the code, or ask.
- **This is PHI in a shared database.** The realistic worst case is one clinic
  reading another clinic's patient records. Every schema change is a security
  change until proven otherwise.

## Where things are

| Doc                                                            | Read it when                                                                                                |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [`docs/STATUS.md`](docs/STATUS.md)                             | **Start here.** What is built, what is next                                                                 |
| [`docs/how-it-works.md`](docs/how-it-works.md)                 | New to the system — the running tour: who signs in where, what happens to a request, how tenants stay apart |
| [`docs/decisions/`](docs/decisions/)                           | Before changing anything structural — these are the load-bearing choices                                    |
| [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md)                   | Writing any code                                                                                            |
| [`docs/PITFALLS.md`](docs/PITFALLS.md)                         | Something behaves strangely — it may already be documented                                                  |
| [`docs/schema/schema-design.md`](docs/schema/schema-design.md) | Touching the database. Full ERD for all domains                                                             |
| [`docs/architecture.md`](docs/architecture.md)                 | Infrastructure, deployment, third-party choices                                                             |
| [`README.md`](README.md)                                       | Setup and day-to-day commands                                                                               |

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

   Two narrow exceptions exist, both for genuinely pre-tenant identity work, and
   neither is a general-purpose door: `withUserIdentity()` reads only your own
   `memberships` rows (→ [ADR-0011](docs/decisions/0011-own-membership-identity-bootstrap.md)),
   and `setTenantContext()` lets registration adopt the organization it just
   created, mid-transaction. Nothing in the type system stops you misusing
   either.

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

## Subagents and skills available

Configured in `.claude/`. Prefer them over improvising an equivalent workflow.

- **`architect`** subagent — designs a vertical slice (schema + RLS → contracts →
  permissions → service → route → web → worker). Invoke: "design the `<feature>`
  feature".
- **`code-reviewer`** subagent — invariant, convention and correctness review of
  changed files.
- **`security-reviewer`** subagent — tenant isolation, PHI, authz, injection,
  secrets. Use it whenever the diff touches the schema, tenancy, auth,
  permissions, patient data, billing, or raw SQL.
- **`/new-feature <name>`** — scaffold an end-to-end vertical slice, ending at the
  tenant-isolation test rather than at a 200 response.
- **`/db-migration <change>`** — the schema-change sequence: model conventions,
  the RLS gauntlet, the SQL Prisma Migrate cannot manage, the isolation test.
  **Use this for any `schema.prisma` change.**
- **`/api-integration <endpoint>`** — contract in `@rcln/contracts` → permission
  code → service via `withTenant` → route with the correct middleware chain → web
  consumer.
- **`/code-review [path]`** — `pnpm validate` + `db:rls:check` + both reviewer
  subagents, consolidated into one report.
- **`frontend-design`** — aesthetic direction for UI: palette, typography, layout,
  and a signature element, plus interface copy. **Load it before writing any new
  screen, component, or CSS in `apps/web`** — before the first line of JSX, not as
  a polish pass afterwards. It decides what you build; retrofitting a visual
  direction onto finished markup means rewriting the markup. Lives in
  `.agents/skills/frontend-design/`.
- **`vercel-react-best-practices`** — 68 React/Next.js performance rules from
  Vercel Engineering (waterfalls, bundle size, server perf, re-renders). Consult
  it when writing or reviewing anything in `apps/web`. Rules live in
  `.claude/skills/vercel-react-best-practices/rules/`; the compiled guide is
  `AGENTS.md` in that folder. Pinned in `skills-lock.json`.
- **codebase-memory / tokensave MCP** — a code knowledge graph is available.
  Prefer it for structural exploration (who calls this, what does this depend on)
  over blind grepping. Index the repo first if it is not indexed.

## What NOT to do

- Never import the raw Prisma client or anything under `generated/prisma` — use
  `withTenant(ctx, …)` from `@rcln/db`. `@rcln/db/unsafe` only for genuinely
  pre-tenant work, and expect review.
- Never add a tenant table without an RLS policy, the policy SQL appended to the
  migration, and a `tenant-isolation.test.ts` case.
- Never write a bare `@@unique([code])` on a tenant table — always
  tenant-qualified.
- Never edit an already-applied migration in place — Prisma checksums it.
- Never reorder the API middleware chain; never return 403 for an unknown tenant.
- Never put the permission list in the JWT.
- Never log a patient name, or cache PHI in Redis. Ids only.
- Never store PHI in `localStorage`, cookies, or URL query params.
- Never use a float for money, or `isDeleted Boolean` for soft delete.
- Never add new `any`, or silence `noUncheckedIndexedAccess` with `!`.
- Never interpolate user input into `$queryRaw` — parameterize.
- Never add a dependency without calling it out and justifying it.
- Never claim something is verified when you only edited it.

## Working agreements

- **Verify, do not assume.** This codebase has already produced several bugs
  that typecheck cleanly and fail only at runtime (see `docs/PITFALLS.md`).
  Run the thing. Curl the endpoint. Check the container actually stayed up.
- **`apps/web` is Next.js 16**, which renamed `middleware.ts` → `proxy.ts` and
  removed the `eslint` config key. Read `node_modules/next/dist/docs/` before
  writing Next code — `apps/web/AGENTS.md` says so for good reason.
- **Do not commit or push** unless asked.
- Update `docs/STATUS.md` when you finish a phase or change direction.
