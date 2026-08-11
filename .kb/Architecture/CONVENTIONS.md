# Conventions

How to write code that matches what is already here.

---

## Database

| Concern             | Rule                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| Primary key         | `uuid`, `@default(uuid())`                                                                                    |
| Tenant              | `organizationId` on every tenant table; `branchId` where location-scoped                                      |
| Composite FK target | `@@unique([organizationId, id])` on any table children will reference                                         |
| Soft delete         | `deletedAt DateTime?`. **Never** `isDeleted Boolean` — it loses _when_, and partial indexes on NULL are cheap |
| Audit               | `createdAt`, `updatedAt`, and `createdBy`/`updatedBy` where the actor matters                                 |
| Money               | `Decimal @db.Decimal(14, 2)` plus an explicit currency. Never float                                           |
| Quantities          | `Decimal @db.Decimal(14, 3)` — half a tablet is real                                                          |
| Time                | `DateTime @db.Timestamptz(6)`, stored UTC; `branches.timezone` for display                                    |
| Enums               | Prisma enums for closed sets; lookup tables for anything a tenant may extend                                  |
| Naming              | `snake_case` columns via `@map`, plural table names via `@@map`, `<singular>Id` relations                     |
| Uniqueness          | Always tenant-qualified: `@@unique([organizationId, code])`, never bare `code`                                |
| Nullable unique     | Needs `NULLS NOT DISTINCT` — add it as raw SQL in the migration (see ADR-0004)                                |

### Adding a tenant table

1. Model with `organizationId` + `@@unique([organizationId, id])`.
2. `pnpm db:migrate --name your_change`
3. Add the table to the `org_scoped` array in `packages/db/prisma/rls/enable-rls.sql`.
4. Append that file's contents to the generated `migration.sql` **before committing**.
5. `pnpm db:rls:check` — fails until the policy exists.
6. Add a case to `apps/api/tests/integration/tenant-isolation.test.ts`.

Prisma Migrate does not manage policies, triggers, partitions or exclusion
constraints. They live in hand-edited SQL blocks inside the migration.

---

## Dates and times

**One rule, three parts, no exceptions:**

1. **Store in UTC.** Every instant is `DateTime @db.Timestamptz(6)` in Postgres
   and an ISO-8601 string with a `Z` on the wire. Nothing is ever stored in a
   local zone, and no column carries a naive wall-clock time except where it
   genuinely is one (`branch_operating_hours` holds `09:00` as an opening time,
   not as an instant — a rule about every Monday cannot be an instant).
2. **Display in the clinic's zone.** Never the browser's, never the container's.
   `branches.timezone` is the answer; `organizations.timezone` is the fallback
   when no branch is in play. A row that will be rendered as a clock face
   carries its own branch's zone with it, because an org-wide admin can open a
   booking made at a clinic in a different one.
3. **Display in the clinic's chosen format.** `locale.time_format` —
   `12H` (the default) or `24H` — resolved at BRANCH scope over ORGANIZATION.
   Display only: nothing parses it, nothing stores against it, no arithmetic
   reads it.

**Why it is written down.** Every failure this rule prevents is silent. A
`toLocaleString()` with no zone is the browser's zone in the browser and the
container's UTC on the server — that is how a 16:40 IST booking rendered as
11:10 on the consultation page, plausibly, with nothing on screen saying it had
shifted. `new Date().toISOString().slice(0, 10)` is today in UTC, which from
17:30 IST onwards opened every Indian clinic's day board on YESTERDAY. Neither
throws, neither fails a test, and both look right to whoever wrote them.

**In practice**

| Where                | Use                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| Web, clinical times  | `formatClinicTime` / `formatClinicDate` / `formatClinicDateTime` in `lib/format.ts`              |
| Web, the zone        | The row's own `timezone` if it has one, else `timezoneOf(slug)`                                  |
| Web, the format      | The row's branch `timeFormat` if in hand, else `timeFormatOf(slug)`                              |
| Web, billing periods | `formatDate` / `formatLongDate` — UTC and pinned, deliberately NOT the clinic's zone             |
| API, date arithmetic | Postgres, `AT TIME ZONE b.timezone`. Never rebuilt from local components in Node                 |
| Anywhere             | A pinned locale (`en-GB`). `undefined` renders differently on the two sides and breaks hydration |

⚠️ **Billing is the one deliberate exception to part 2.** A billing period is a
contractual interval, not an event in somebody's day: "this period ends on 25
July" must read identically to the clinic owner in Kolkata, the accountant in
Dublin and the support engineer looking over their shoulder, and it has to match
the invoice, which was generated in UTC. Those render in UTC and say so. An
appointment is the opposite — 09:00 means 09:00 where the clinic is.

⚠️ **Never add a second clock formatter.** `formatClinicTime` is the only place
the zone and the 12/24 choice are decided. A local `Intl.DateTimeFormat` in a
component typechecks perfectly and silently ignores whatever the clinic chose.

---

## API

Middleware order is the security model. Do not reorder casually:

```
helmet / cors  →  body parsing  →  request id + logging  →  rate limit
  →  resolveTenant   (host → organization, Redis-cached)
  →  authenticate    (JWT → users.id)
  →  authorize       (membership + membership_roles → permissions)
  →  withTenant      (BEGIN; set_config; …; COMMIT)
  →  handler
```

- **Unknown tenant returns 404, never 403.** A 403 confirms the subdomain
  exists and leaks the customer list.
- **Validate with Zod at the boundary**, using schemas from `@rcln/contracts` so
  the web app infers the same types.
- **Never put the permission list in the JWT** — stale on role change, too large
  for a header. Serve it from an endpoint, cache in Redis.
- **Audit every mutation** and every PHI _read_. "Who looked at this patient's
  file" is the question asked after an incident.

## Services and data access

- Always `withTenant(ctx, …)` from `@rcln/db`. Group related queries into one
  call — the session round-trip is per transaction, not per query.
- Pass `organizationId` explicitly in service signatures even though RLS also
  enforces it. Defence in depth; see ADR-0005.
- `@rcln/db/unsafe` only for genuinely pre-tenant work, and expect review.

## Redis

Cache **ids and permission metadata only**. No PHI. It shrinks the breach
surface and the compliance paperwork. Keys carry TTLs; negative results are
cached too so unknown hosts cannot hammer the database.

## Logging

pino, with redaction configured in `apps/api/src/utils/logger.ts`. Log the
patient _id_, never the name. Add any new PII-bearing field to the redact paths.

## Errors

Throw typed errors from `apps/api/src/utils/errors.ts`. The error middleware
maps them; Prisma errors are narrowed **structurally** (by `err.name`), not with
`instanceof`, because pnpm's symlinked layout can give the generated client and
the app separate class identities.

---

## TypeScript

`tsconfig.base.json` is strict, including `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`. Two consequences worth knowing:

- Array and record access yields `T | undefined`. Destructuring
  `const [row] = rows` needs a null check.
- You cannot pass `{ key: undefined }` where the property is optional. Use a
  conditional spread: `...(cond ? { key: value } : {})`.

ESM throughout: relative imports need the `.js` extension even from `.ts`
source.

## Workspace packages

| Package             | Holds                                                             |
| ------------------- | ----------------------------------------------------------------- |
| `@rcln/db`          | Prisma schema, migrations, RLS SQL, tenant-scoped client          |
| `@rcln/contracts`   | Zod schemas + inferred types, shared by api and web               |
| `@rcln/permissions` | Permission catalogue, system roles, effective-permission resolver |
| `@rcln/config`      | eslint and tsconfig presets                                       |

Packages build to `dist/` and are consumed from there, so a consumer needs the
package built. The dev entrypoint does this on boot.

## Tests

- **Unit** — services, permission resolution, billing maths, FEFO selection.
  Billing deserves property-based tests; rounding compounds.
- **Integration** — real Postgres, real migrations, real RLS. Never mock Prisma.
- **`tenant-isolation.test.ts` is the most important file in the repo.** Every
  new tenant table gets a case.

Jest runs native ESM, which needs `NODE_OPTIONS=--experimental-vm-modules`
(already in the test scripts).

## Commits

Conventional commits, enforced by commitlint. Subject must be **lowercase** and
the type from: feat, fix, docs, style, refactor, perf, test, build, ci, chore,
revert. Pre-commit runs prettier; pre-push runs typecheck, lint and the RLS
check, and blocks direct pushes to protected branches.
