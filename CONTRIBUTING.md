# Contributing to rcln

Thanks for your interest. rcln is a multi-tenant healthcare platform, which
means most changes are security changes whether or not they look like it. This
document covers the mechanics; the reasoning lives in
[`.kb/`](.kb/README.md).

By contributing you agree that your contribution is licensed under the
[GNU AGPL v3](LICENSE), and you follow the [Code of Conduct](CODE_OF_CONDUCT.md).

**Security bugs do not go here.** See [SECURITY.md](SECURITY.md).

---

## Before you start

- **Open an issue first** for anything beyond a typo or an obvious bug fix.
  A schema change, a new domain, or a new endpoint is worth agreeing on before
  it is written.
- **Read [`.kb/AI/Project_Context.md`](.kb/AI/Project_Context.md)** — the
  minimum context: what exists, what does not, and how a request flows.
- **Check [`.kb/STATUS.md`](.kb/STATUS.md)** — the project is pre-1.0 and moves
  in phases. Something missing is often "not built yet", not "a bug".

## Getting it running

```bash
git clone https://github.com/tejasnirala/rcln.git
cd rcln
docker compose up          # everything, hot-reloaded. Needs only Docker.
```

That's api on `:5000`, web on `:3000`, worker on Redis, database migrated and
seeded. [`README.md`](README.md) documents the hybrid and fully-native paths if
you would rather not run everything in Docker.

## The seven invariants

Breaking any of these is a correctness or security regression, not a style
disagreement. The first five have an ADR in
[`.kb/Architecture/decisions/`](.kb/Architecture/decisions/README.md) explaining
why — read it before arguing with it.

1. **Organization is the tenant, branch is the place.** A solo clinic and a
   three-branch hospital are the same shape. There is no "clinic" entity.
2. **No role column on `users`.** Roles live on
   `membership_roles (membership × role × branch_id NULLABLE)`, where NULL means
   every branch in the organization.
3. **Tenant isolation is enforced by Postgres.** RLS policies, composite foreign
   keys and application scoping — three independent layers.
4. **Never import the raw Prisma client.** Use `withTenant(ctx, …)` from
   `@rcln/db`. An eslint rule enforces it; `@rcln/db/unsafe` is the audited
   escape hatch and will be reviewed as one.
5. **No JSON arrays of foreign keys.** Real join tables. Per-specialty variation
   goes through versioned form templates — JSONB as a document, never as a
   foreign key.
6. **UTC in the database, the clinic's zone and format on screen.**
   `Timestamptz(6)` in Postgres and ISO with a `Z` on the wire, always; rendered
   in `branches.timezone` and `locale.time_format` — `12H` by default, `24H` if
   the clinic chooses, resolved per branch. On the web that means
   `formatClinicTime` and friends in `apps/web/src/lib/format.ts`: never a bare
   `toLocaleString()`, never a second `Intl.DateTimeFormat`. Billing periods
   render in UTC, deliberately — see CONVENTIONS.md § Dates and times.
7. **Reading the clinical record is not writing it.** Authoring it —
   `clinical.encounter.create`/`.close`, `clinical.prescription.create`/`.sign` —
   is DOCTOR-only, and stripped from ORG_OWNER and ORG_ADMIN by name because
   those roles are defined as "everything except". Vitals split the same way:
   `clinical.vitals.read` for anyone consulting the chart,
   `clinical.vitals.record` for whoever holds the cuff. A clinic widens this
   itself by cloning a role or granting a code per membership.

## Before you write a function, look for it

`.kb/` indexes every symbol in `apps/` and `packages/`:

```bash
pnpm kb:find <what-you-would-call-it>    # --export, --kind fn to narrow
```

If something already does the job, use it or extend it. A second
`hashInviteToken` is exactly what this index exists to prevent.

## Working on a change

```bash
git checkout -b feat/short-description
```

Branch prefixes: `feat/ fix/ hotfix/ docs/ refactor/ test/ chore/`. Direct
pushes to `main`, `develop`, `stage` and their aliases are rejected by a hook.

### Conventions worth knowing

- **TypeScript everywhere.** No new `any`; don't silence
  `noUncheckedIndexedAccess` with `!`.
- **Money is never a float.** Soft delete is never `isDeleted Boolean`.
- **Never log a patient name or cache PHI in Redis.** Ids only. No PHI in
  `localStorage`, cookies, or URL query params.
- **Never interpolate user input into `$queryRaw`.** Parameterize.
- **Tenant-scoped uniqueness.** A bare `@@unique([code])` on a tenant table is a
  bug — qualify it with the tenant.
- **New dependencies need justification** in the pull request description.
- Full list: [`.kb/Architecture/CONVENTIONS.md`](.kb/Architecture/CONVENTIONS.md).
  Strange behaviour is often already documented in
  [`.kb/Architecture/PITFALLS.md`](.kb/Architecture/PITFALLS.md).

### Changing the database

Every schema change is a security change until proven otherwise. If you add a
table carrying `organization_id`, it needs **all** of:

1. An RLS policy in `packages/db/prisma/rls/enable-rls.sql`
2. That policy SQL appended to the generated migration
3. A case in `apps/api/tests/integration/tenant-isolation/`

`pnpm db:rls:check` fails until the policy exists. That is deliberate: a missing
policy produces no error and breaks no single-tenant test — it simply starts
returning other clinics' patient records.

Never edit an already-applied migration in place; Prisma checksums them.

## Before you open a pull request

```bash
docker compose exec api pnpm validate      # typecheck + lint + test
docker compose exec api pnpm db:rls:check  # if you touched the schema
pnpm kb                                    # refresh the symbol index
```

The `.kb` index is committed, and the pre-push hook rejects a push whose index
is stale. Regenerate and commit it (`chore(kb): refresh index`) rather than
hand-editing anything carrying the generated banner.

### Commit messages

[Conventional Commits](https://www.conventionalcommits.org/), enforced by
commitlint:

```
feat(patients): add ABHA number to registration
fix(billing): round GST to two decimals before persisting
docs(kb): correct the RLS section of how-it-works
```

Types: `feat fix docs style refactor perf test build ci chore revert`. Lowercase
type and subject, no trailing period, header ≤ 100 characters. `pnpm commit`
walks you through it.

### Pull requests

- One logical change per PR. Smallest correct change wins.
- Fill in the template — reviewers rely on the tenancy and schema checkboxes.
- Link the issue it closes.
- CI runs static checks plus a full migrate → seed → RLS check → tenant
  isolation suite against real Postgres and Redis. The database job is never
  optional.
- Expect review comments on anything touching tenancy, auth, permissions,
  patient data, billing, or raw SQL.

## Questions

Open a [discussion or issue](https://github.com/tejasnirala/rcln/issues). If the
answer turns out to live in `.kb/`, a PR improving that page is very welcome.
