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

**All project documentation lives in [`.kb/`](.kb/README.md).** The old `docs/`
directory is pointer stubs.

| Doc                                                                    | Read it when                                                                              |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [`.kb/AI/Agent_Instructions.md`](.kb/AI/Agent_Instructions.md)         | **Start here.** How to think, build, verify and what you may not change                   |
| [`.kb/AI/Project_Context.md`](.kb/AI/Project_Context.md)               | The minimum context: what exists, what does not, the request path                         |
| [`.kb/STATUS.md`](.kb/STATUS.md)                                       | What is built, what is next — the honest ledger                                           |
| [`.kb/Architecture/how-it-works.md`](.kb/Architecture/how-it-works.md) | New to the system — the running tour                                                      |
| [`.kb/Architecture/decisions/`](.kb/Architecture/decisions/README.md)  | Before changing anything structural                                                       |
| [`.kb/Architecture/CONVENTIONS.md`](.kb/Architecture/CONVENTIONS.md)   | Writing any code                                                                          |
| [`.kb/Architecture/PITFALLS.md`](.kb/Architecture/PITFALLS.md)         | Something behaves strangely — it may already be documented                                |
| [`.kb/Database/schema-design.md`](.kb/Database/schema-design.md)       | Touching the database. Full ERD for all domains                                           |
| [`.kb/Architecture/architecture.md`](.kb/Architecture/architecture.md) | The **target** infrastructure design — mostly not built. Cite it as intent, never as fact |
| [`.kb/README.md`](.kb/README.md)                                       | The KnowledgeBase index — 17 numbered documents plus the generated indexes                |
| [`README.md`](README.md)                                               | Setup and day-to-day commands                                                             |

## Before you write a function, look for it

`.kb/` indexes every symbol in `apps/` and `packages/`. Before adding **any**
function, constant, component, hook, Zod schema or type:

```bash
pnpm kb:find <what-you-would-call-it>    # add --export, --kind fn to narrow
```

If something already does the job, use it or extend it. A second
`hashInviteToken` is the exact failure this index exists to prevent — and the
one a grep of the diff will never catch.

`.kb/INDEX.md` maps every module to its symbol table;
`.kb/APIs/_index.md` is the HTTP surface with middleware chains and permission
gates; `.kb/Database/_index.md` is every model, column and RLS status;
`.kb/09_Roles_and_Permissions.md` is the 12 × 83 access matrix. Read those
instead of crawling directories.

**Keeping it current is not optional.** `pnpm kb` regenerates in under a second
and runs automatically — a `Stop` hook after any session that touched
`.ts`/`.tsx`/`.prisma`, and the pre-push hook, which rejects a push whose `.kb`
was stale. Never hand-edit a file carrying the generated banner; edit the
source, `.kb/modules.json`, or `.kb/generate.mjs`.

## The seven invariants

Breaking any of these is a correctness or security regression, not a style
choice. Each has an ADR explaining why; read it before arguing with it.

1. **Organization is the tenant, branch is the place.** A solo clinic and a
   three-branch hospital are the same shape. There is no "clinic" entity.
   → [ADR-0001](.kb/Architecture/decisions/0001-organization-is-the-tenant.md)

2. **No role column on `users`.** Roles live on
   `membership_roles (membership × role × branch_id NULLABLE)`, where NULL means
   every branch in the org. → [ADR-0002](.kb/Architecture/decisions/0002-roles-live-on-membership.md)

3. **Tenant isolation is enforced by Postgres.** RLS policies + composite FKs +
   application scoping, three independent layers. The app connects as
   `rcln_app` (RLS enforced); migrations use `rcln_owner` (RLS bypassed).
   → [ADR-0003](.kb/Architecture/decisions/0003-rls-enable-not-force.md),
   [ADR-0004](.kb/Architecture/decisions/0004-composite-foreign-keys.md)

4. **Never import the raw Prisma client.** Use `withTenant(ctx, …)` from
   `@rcln/db`. An eslint rule enforces it; `@rcln/db/unsafe` is the audited
   escape hatch. → [ADR-0005](.kb/Architecture/decisions/0005-tenant-scoped-prisma-client.md)

   Two narrow exceptions exist, both for genuinely pre-tenant identity work, and
   neither is a general-purpose door: `withUserIdentity()` reads only your own
   `memberships` rows (→ [ADR-0011](.kb/Architecture/decisions/0011-own-membership-identity-bootstrap.md)),
   and `setTenantContext()` lets registration adopt the organization it just
   created, mid-transaction. Nothing in the type system stops you misusing
   either.

5. **No JSON arrays of foreign keys.** Real join tables. Per-specialty variation
   goes through versioned form templates — JSONB as a document, never as a
   foreign key. → [ADR-0006](.kb/Architecture/decisions/0006-no-json-id-arrays.md)

6. **Store time in UTC, display it in the clinic's zone and the clinic's
   format.** `Timestamptz` in Postgres, ISO with a `Z` on the wire — always.
   Rendered in `branches.timezone` (never the browser's, never the container's)
   and in `locale.time_format`, a per-branch setting that is `12H` by default
   and `24H` if the clinic says so. On the web that means `formatClinicTime` and
   friends in `apps/web/src/lib/format.ts`, with the zone from the row or
   `timezoneOf(slug)` and the format from the row's branch or `timeFormatOf(slug)`
   — never a fresh `Intl.DateTimeFormat` and never a bare `toLocaleString()`.
   Billing periods are the one deliberate exception and render in UTC.
   → [CONVENTIONS.md § Dates and times](.kb/Architecture/CONVENTIONS.md)

7. **Reading a patient's record is not writing in it.** Authoring the clinical
   record — `clinical.encounter.create`/`.close`, `clinical.prescription.create`/`.sign`
   — belongs to DOCTOR alone among the system roles, and is stripped from
   ORG_OWNER and ORG_ADMIN by name in `roles.ts` because they are defined as
   "everything except", so a new authoring code would otherwise join them
   silently. Vitals split the same way: `clinical.vitals.read` for anyone who
   consults the chart, `clinical.vitals.record` for whoever actually holds the
   cuff — the front desk and the nurse, not the doctor. Clinics widen this
   themselves by cloning a role or granting a code per membership; that is a
   clinic's decision, not a default.

## Running it

```bash
docker compose up          # everything, hot-reloaded. Needs only Docker.
```

Workspace commands inside the container:
`docker compose exec api pnpm <script>`. See README for the native paths.

## Order of work: write everything, then verify — tests last

This ordering is not a suggestion. Follow it on every task that spans more than
one file, and do not interleave verification with implementation.

1. **Write all the code first.** Every station, every layer of the slice —
   schema, contracts, permissions, service, route, web, worker, tests. Nothing
   is verified until the whole thing is written.
2. **Then lint and format**, both:
   `docker compose exec api pnpm lint` and `pnpm format`.
3. **Then typecheck only** — `docker compose exec api pnpm typecheck`.
   **No production build.** Never run `pnpm build` as a verification step; the
   Docker dev servers and the typecheck already cover what it would tell us.
4. **Then, last, run the tests** — the full split, once, and fix what falls out.
   `docker compose exec api pnpm test`, plus `db:rls:check` if the schema moved.

**Do not run the test suite before step 4** — not between stations, not to
"check one thing", not because a file looked risky. Getting a slice green takes
several rounds regardless; running them early just pays for those rounds twice
in wall-clock and tokens.

Commands that are _implementation_ rather than verification are exempt and
should be run when needed: `prisma generate`, `migrate dev`/`deploy`, `pnpm kb`.

When reporting, say plainly that validation ran once at the end, and never call
a station verified when it was only written.

## Before you finish any task

```bash
docker compose exec api pnpm validate      # typecheck + lint + test
docker compose exec api pnpm db:rls:check  # if you touched the schema
```

The schema is a **folder**, `packages/db/prisma/schema/`, not one file: Prisma
concatenates every `*.prisma` in it. Models live in the file for their domain
(`patients.prisma`, `invoicing.prisma`, …) with their enums beside them, and
`schema.prisma` carries only `generator` and `datasource`. Its `output` path is
relative to that folder, so it is `../../generated/prisma`.

If you added a tenant table, it needs an RLS policy in
`packages/db/prisma/rls/enable-rls.sql`, appended to the generated migration,
plus a case in `apps/api/tests/integration/tenant-isolation/`.
`db:rls:check` fails until the policy exists — that is deliberate, because a
missing policy produces no error and breaks no single-tenant test. It just
starts returning other clinics' patient records.

## The API reference is part of the endpoint, not a follow-up

`/docs` serves a generated OpenAPI 3.1 document. **Every one of the 425 endpoints
carries hand-written prose, and a test enforces that** — so touching the HTTP
surface is not done until the reference matches it.

Half the document is derived and cannot drift: `openapi/introspect.ts` reads the
method, path, permission gate and request schema off the routers themselves. The
half a machine cannot derive lives in `apps/api/src/openapi/registry/<domain>.ts`,
keyed `METHOD /full/path` with the path written as OpenAPI writes it
(`{branchId}`, not `:branchId`).

**When you add an endpoint** — add a registry entry in the same commit. At
minimum a `summary` and a `description`; add `response`, `requestExamples` and
`responseExamples` for anything carrying PHI or money. A new _router_ also needs a
line in `openapi/mounts.ts`, or `assertMountsCover()` fails.

**When you change an endpoint** — update the entry. A renamed field, a tightened
permission or a new failure status breaks no build and leaves the reference
confidently describing something untrue, which is worse than no reference at all:
consumers write against it and find out at runtime.

**When you remove an endpoint** — delete the entry. A key matching no route is a
paragraph about something that no longer exists, and the test fails on it.

Three gates in `apps/api/tests/unit/openapi.test.ts` hold this:

| Case                                                          | Fails when                |
| ------------------------------------------------------------- | ------------------------- |
| `has a registry entry for every route the API serves`         | a route has no prose      |
| `has no registry entry for a route that does not exist`       | prose outlives its route  |
| `draws every identifier in its examples from the fixture set` | an example invents a uuid |

⚠️ **NEVER WRITE A LITERAL UUID IN A REGISTRY FILE.** Every id comes from
`registry/fixtures.ts`, which is one clinic described once — the same patient,
doctor, batch and invoice throughout, so the reference tells one story end to end
rather than 425 unrelated fragments. Add the id there, with a name and a sentence
saying what it is, then import it. A stray uuid is invisible in review because
one uuid looks exactly like another.

Money in examples is **minor units** (`24000` is ₹240.00) and times are UTC with
a `Z`, because that is what the wire carries.

```bash
docker compose exec api pnpm --filter @rcln/api docs:validate   # coverage + 3.1 conformance
```

It prints `<n> endpoints … <n> carry hand-written documentation`. Those two
numbers must be equal.

⚠️ **A failure status must be described before it can be cited.** `errors: [418]` on
an endpoint throws at build time unless `418` is in `ERROR_CASES` in
`openapi/envelope.ts`. That is deliberate — a status nobody has described is a
status a consumer cannot handle.

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
  **Use this for any change under `packages/db/prisma/schema/`.**
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
  migration, and a case in the tenant-isolation suite.
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
- Never add, change or delete an endpoint without updating its entry in
  `apps/api/src/openapi/registry/` — and never write a literal uuid in one;
  import it from `registry/fixtures.ts`.
- Never write a helper without checking `pnpm kb:find` first, and never
  hand-edit a generated file under `.kb/`.

## Working agreements

- **Verify, do not assume.** This codebase has already produced several bugs
  that typecheck cleanly and fail only at runtime (see `.kb/Architecture/PITFALLS.md`).
  Run the thing. Curl the endpoint. Check the container actually stayed up.
- **`apps/web` is Next.js 16**, which renamed `middleware.ts` → `proxy.ts` and
  removed the `eslint` config key. Read `node_modules/next/dist/docs/` before
  writing Next code — `apps/web/AGENTS.md` says so for good reason.
- **Do not commit or push** unless asked.
- Update `.kb/STATUS.md` when you finish a phase or change direction.
