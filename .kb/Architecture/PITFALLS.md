# Pitfalls

Traps already hit in this repository, with the symptom, the cause and the fix.

Every one of these **typechecks cleanly** and most produce no error message.
They were found by running the thing, not by reading the code. If something
behaves oddly, look here before debugging from scratch.

---

## Postgres and RLS

### Prisma generates ids in the client, so raw SQL inserts violate NOT NULL

**Symptom:** a test that stages a row with `owner.query('INSERT INTO …')` fails
with `null value in column "id" … violates not-null constraint`, even though
every model has `@default(uuid())`.
**Cause:** `@default(uuid())` is a **Prisma-side** default. The column carries
`NOT NULL` and no `DEFAULT` at all, so anything that does not go through the
client — a test fixture, a psql session, a hand-written migration — must supply
one.
**Fix:** `gen_random_uuid()` in the insert.
**Why it matters beyond the error:** this is how a guard measurement silently
measures nothing. A "does this test fail without the guard?" check that fails
identically in both states looks like proof and is not — the guard was never
reached. Read the failure message, not just the red tick. Found while pinning
the `userId` check in `verification.service.ts`.

### An unscoped `_count` over a scoped table returns 0 for every row

**Symptom:** the platform console's clinic list reported `branchCount: 0` and
`memberCount: 0` for a clinic with two branches and four members. 200, no error,
no log line.
**Cause:** `organizations` is on the RLS exemption list — it is the table the
tenant is resolved FROM — so `unsafeDbClient().organization.findMany()` is
correct and returns real rows. But `branches` and `memberships` are **not**
exempt, and the unscoped client sets no session variables, so their policies
evaluate against a NULL `app.current_org` and match nothing. A `_count` over a
relation therefore counts zero, and a count of zero is a plausible-looking
number rather than an error.
**Fix:** the counts were dropped from `platformOrganizationSummary`. Real ones
would need one `withTenant` round trip per organization.
**The general shape:** the exemption is per TABLE, not per query. A join or a
`_count` from an exempt table into a scoped one silently crosses back into RLS,
and aggregates fail closed to a number rather than to an error. Found by curling
the endpoint; nothing in the type system or the test suite would have.

### `FORCE ROW LEVEL SECURITY` breaks migrations

**Symptom:** seeds and migrations insert nothing, apparently succeeding.
**Cause:** `FORCE` subjects the table owner to its own policies, and migrations
run as the owner with no tenant context.
**Fix:** use `ENABLE` + `NO FORCE`, and rely on the `rcln_owner` / `rcln_app`
split. `assertRlsActive()` guards the risk that creates. → ADR-0003

### Scoping the tenant-resolution table is circular

**Symptom:** every request resolves `tenant: null`, no errors anywhere.
**Cause:** `organization_domains` had an RLS policy requiring
`app.current_org` — but reading that table is _how_ `app.current_org` gets set.
**Fix:** exempt it, with the reason recorded in `enable-rls.sql` and
`check-rls.ts`.

### An RLS-scoped table cannot answer "which tenants am I in?"

**Symptom:** `authSession.memberships` is always `[]`. No error, no warning —
login works, the account switcher is simply empty and the branch switcher has
nothing to render.
**Cause:** `memberships` is org-scoped and RLS-enforced. Reading it with the
unscoped client (`@rcln/db/unsafe`) matches no rows, because RLS fails closed
with `app.current_org` unset — and `unsafeDbClient()` is not privileged, it is
the same `rcln_app` connection with the session variables skipped. Reading it
inside `withTenant` needs the organization id you were trying to look up.
**Fix:** a second, deliberately narrow policy rather than an exemption —
`own_membership`, `FOR SELECT USING (user_id = app_current_user() AND
app_current_org() IS NULL)`, migration `20260725170000`. Reached only through
`withUserIdentity()` in `packages/db/src/tenant.ts`, which sets the user variable
and no tenant. The `app_current_org() IS NULL` half is what keeps the blast
radius at zero: permissive policies OR together, so without it this would widen
every ordinary request. Boundaries are pinned in the tenant-isolation suite.

### A new branch is invisible to the person who just created it

**Symptom:** `POST /branches` returns 201, then every follow-up call against that
branch id answers 404 for about a minute. No error, nothing in the logs — the
branch reads as never having been created.
**Cause:** `branchIds` is derived, not stored. An org-wide assignment
(`membership_roles.branch_id IS NULL`) means "every branch in the organization",
so `loadUserAccess` expands it to the full list — and caches the result in Redis
for 60 seconds. Adding a branch changes every org-wide member's effective scope
without touching a single `membership_roles` row, so nothing invalidates it.
Services scope to `ctx.branchIds`, so the new branch is not in scope yet.
**Fix:** `invalidateOrganizationAccess(organizationId)` in `access.service.ts`,
called after COMMIT by `createBranch` and `deleteBranch`. It SCANs rather than
KEYS — the same Redis serves the rate limiters.
**Generalises:** any table whose reachability is derived from a _set_ of rows
rather than a row of its own has this shape. Ask what a write invalidates, not
just what it changes.

### Unique indexes do not constrain nullable columns

**Symptom:** duplicate system roles, or the same "all branches" role granted
twice.
**Cause:** Postgres treats NULLs as distinct, so `UNIQUE (organization_id, code)`
permits many rows with `organization_id = NULL`.
**Fix:** `NULLS NOT DISTINCT` (Postgres 15+), added as raw SQL in migration
`20260725060000`.

### `Intl.NumberFormat` does not validate a currency code

**Symptom:** `currency: "XYZ"` is accepted and stored.
**Cause:** `new Intl.NumberFormat('en', { style: 'currency', currency })` throws
only when the code is not three ASCII letters. It does **not** check the code
against ISO 4217, so it is useless as a validator — unlike
`new Intl.DateTimeFormat('en', { timeZone })`, which really does throw on an
unknown zone. The two look like the same trick and are not.
**Fix:** `Intl.supportedValuesOf('currency')`. See `packages/contracts/src/common.ts`,
where `timezone` uses the constructor and `currencyCode` deliberately does not.
Both were checked against a deliberately invalid value; the currency one passed
until it was.

### A bare `null` cannot clear a nullable Json column

**Symptom:** `Argument 'allowedValues': Invalid value provided` on an update
that sets a Json field to `null`.
**Cause:** for a `Json?` column Prisma cannot tell "the SQL NULL" from "the JSON
literal `null`", both of which are storable, so it refuses the bare value.
**Fix:** `Prisma.DbNull` for the column being NULL, `Prisma.JsonNull` for the
JSON value. This bites in two directions in the settings code — the seed clears
`allowed_values` with `DbNull`, and `setting.service.ts` writes a JSON null value
with `JsonNull`.

### Prisma cannot target a compound unique containing NULL

**Symptom:** `Argument 'organizationId' must not be null` in an `upsert`.
**Cause:** Prisma will not build a `where` for a compound unique with a null
component.
**Fix:** `findFirst` then `create`/`update`. Uniqueness is still guaranteed by
the `NULLS NOT DISTINCT` index. See `prisma/seed.ts`.

### `audit_logs.entity_id` is a `uuid`, so a non-uuid identifier 500s the write

**Symptom:** an endpoint answers `{"success": false, "message": "Database error"}`
with no field named, and the log shows the failure inside `tx.auditLog.create`,
not inside the mutation you were making.
**Cause:** `recordAudit` takes `entityId` as a `string` because that is what a
uuid is in TypeScript. `audit_logs.entity_id` is `@db.Uuid`, so anything else —
a setting key, a permission code, a slug — fails the cast at the database. It
typechecks perfectly and only the audit row is at fault, which is why the error
message points nowhere useful.
**Fix:** pass the ROW's id. If the natural identifier is not a uuid, put it in
the snapshot instead. Found writing `setting.service.ts`.

**And a second trap in the same call:** `recordAudit` keeps only the fields whose
value moved, so a snapshot of `{ key, value }` loses `key` on every update — the
row then says "20 became 30" about nothing in particular. Name the FIELD after
the subject (`{ [key]: value }`) and both the identity and the diff survive.

### RLS-exempt tables have no second line of defence, and no test will say so

**Symptom:** none. That is the entry.
**Cause:** `organizations`, `setting_values`, `users`, `roles` and the rest of
the `EXEMPT` list in `packages/db/scripts/check-rls.ts` carry no policy, for
reasons that are each individually good. A `where` that forgets the tenant on one
of these returns another clinic's row, commits another clinic's update, and
passes every single-tenant test. `db:rls:check` counts them as handled.
**Fix:** a service touching one states the rule in a header comment, never takes
the scoping id from a request, and ships a two-organization integration case that
is _measured_ to fail with the filter removed. `setting.service.ts` and
`settings.test.ts` are the worked example.

### A RESTRICTIVE policy fails two different ways, and one of them is silent

**Symptom:** an endpoint that writes `membership_roles` or
`membership_permission_overrides` either 500s for no obvious reason, or reports
success having changed nothing.
**Cause:** `branch_isolation` is RESTRICTIVE and ANDs with `tenant_isolation`:

```sql
USING      (branch_id IS NULL OR branch_id = ANY (app_branch_scope()))
WITH CHECK (branch_id IS NULL OR branch_id = ANY (app_branch_scope()))
```

The two halves behave differently, and only the first one is loud:

- **WITH CHECK** refuses an INSERT naming a branch outside the scope. That
  surfaces as a policy violation and reaches the caller as a 500.
- **USING** hides an existing row in a branch outside the scope. An
  `updateMany` / `deleteMany` addressed at it matches nothing and commits, so
  the transaction succeeds having done nothing at all.

**Fix:** check the target branch against `ctx.branchIds` _before_ the write and
answer 404, and read a row before mutating it so an invisible one is a 404 rather
than a no-op. `apps/api/src/services/iam/guards.ts` is the one place this lives.
**Worth knowing:** `branch_id IS NULL` is exempt from the policy by design —
that is what makes "every branch" expressible — so **the database does not refuse
an org-wide grant at all.** A branch-scoped caller who simply omits the branch
gets a working assignment to every branch in the clinic, including ones opened
later. That one is application-layer or it is nothing. Measured both ways in
`tests/integration/iam.test.ts` by deleting the guard: the named-branch case
turns 404 into 500, and the org-wide case turns 403 into 201.

### `date AT TIME ZONE tz` silently means the opposite of what it reads

**Symptom:** the appointment day board came back empty and the availability
engine offered slots that were already booked — for one branch, in IST, with no
error anywhere and both queries returning rows.
**Cause:** `date` casts implicitly to **both** `timestamp` and `timestamptz`, so
Postgres resolves

```sql
(:date::date) AT TIME ZONE b.timezone      -- picks the timestamptz overload
```

as _"render this instant as wall-clock in that zone"_ — the inverse of the
intended _"this wall-clock time in that zone, as an instant"_ — and returns a
bare `timestamp`. The IST day then started at 05:30Z instead of 18:30Z the
previous evening, so every morning booking fell outside its own day.
**Fix:** cast the operand explicitly.

```sql
(:date::date)::timestamp AT TIME ZONE b.timezone
```

**Worth knowing:** the sibling expression `(:date::date + start_time)` is safe,
because `date + time` is unambiguously `timestamp` — which is why the slot grid
was correct while the day bounds were wrong, and why the two disagreed rather
than both failing. Pinned by the timezone cases in
`tests/integration/appointments.test.ts`.

### RLS is not applied to tables referenced inside a policy expression

**Symptom:** `appointment_status_history` returned nine rows to a reader whose
branch scope named no real branch, while `SELECT count(*) FROM appointments`
returned 0 in the same transaction.
**Cause:** a policy of the form `EXISTS (SELECT 1 FROM parent p WHERE …)` does
**not** inherit the parent's policies — Postgres evaluates policy expressions
with row security disabled on the tables they reference, or a policy that read
its own table would recurse forever. The `parent_scoped` children in
`enable-rls.sql` are safe only because each predicate spells the organization
test out itself; nothing about the branch boundary carries across.
**Fix:** restate the parent's branch predicate in the child's policy. Two places
to keep in step, and it is the only thing that works; a `branch_id` column on the
child is worse, because it can drift from its parent.
**Worth knowing:** the first fix was defeated immediately by a second one.
Adding the table to the `org_scoped` array as well gave it a PERMISSIVE
`tenant_isolation` beside the hand-written policy, and **permissive policies OR
together** — so the org-only policy re-opened the hole. A second permissive
policy never narrows anything. Both halves are pinned in
`tests/integration/tenant-isolation/`.

### Prisma Migrate offers to drop hand-written indexes it can see

**Symptom:** a `migrate dev` unrelated to patients generated
`DROP INDEX "patients_phone_trgm_idx"` — the GIN trigram index the phone search
depends on — and applying it turned every phone lookup into a sequential scan
whose cost grows with the **platform**, because RLS filters after the scan.
**Cause:** Prisma diffs the database against `schema.prisma`, and an index it
can introspect but cannot find declared is drift to be removed. It affects
indexes on a plain column with a non-default operator class; an EXPRESSION
index (`lower(first_name || ' ' || …)`) is invisible to the introspector and so
is never proposed for dropping.
**Fix:** declare it, rather than deleting the line every time.

```prisma
@@index([phone(ops: raw("gin_trgm_ops"))], map: "patients_phone_trgm_idx", type: Gin)
```

**Worth knowing:** an expression index genuinely cannot be declared, so those
stay hand-written and stay safe. Anything Prisma _can_ express should be
declared even when the migration already creates it — that is what stops the
next migration from offering to undo it.

### Counting join rows is not counting people

**Symptom:** "held by 2 people" for a role one person holds.
**Cause:** `membership_roles` carries one row per (membership, role, branch), so
a doctor working at two branches has two DOCTOR rows — that is the whole point of
the branch column. `_count: { select: { assignments: true } }` counts rows.
**Fix:** `findMany` with `distinct: ['roleId', 'membershipId']` and tally.
**Worth knowing:** this typechecked, and every test passed, because no fixture
had anyone holding the same role at two branches. It was found by curling the
demo clinic. Any "how many members have X" over a branch-scoped join table has
the same shape.

### `prisma migrate reset` leaves the app locked out — and the audit trail rewritable

**Symptom:** every request after a reset fails with `permission denied for
schema public`, reported from whichever Prisma call happens to run first. It
reads as a Prisma or connection-string fault and is neither.
**Cause:** `migrate reset` issues `DROP SCHEMA public CASCADE; CREATE SCHEMA
public`. That takes the `rcln_app` grants down with it **and** the
`ALTER DEFAULT PRIVILEGES` rules that were supposed to cover future tables.
`infra/postgres/init/01-roles-and-extensions.sql` is not re-run — it fires once,
on first boot of an empty volume — so the migrations replay, rebuild every table
owned by `rcln_owner`, and grant them to nobody.
**⚠️ The dangerous half is the fix, not the break.** Restoring access with a
blanket `GRANT … ON ALL TABLES` hands `rcln_app` UPDATE and DELETE on
`audit_logs` and `data_access_logs`, undoing the REVOKEs those tables' own
migrations performed. Nothing fails, no test notices, and the immutability
guarantee quietly drops from two independent layers to one. Both migrations
name this sequence as the thing to watch for; it is easy to do by hand and
forget the second half.
**Fix:** `pnpm db:reset` now runs `scripts/apply-grants.ts` afterwards, which
applies `prisma/rls/grant-app.sql` — grants, default privileges, then the
REVOKEs — and reads the catalogue back to prove the append-only tables are
insert-only. It exits non-zero if they are not. Run `pnpm db:grants` by hand
after any other operation that recreates the schema.
**Also:** `migrate reset` does **not** run the seed in Prisma 7, despite
`migrations.seed` being set in `prisma.config.ts` (and `--skip-seed` is not a
valid flag, which is the giveaway). A reset therefore used to leave zero
permissions, zero roles and zero plans — an empty database that fails every test
for reasons unrelated to whatever was being tested. `pnpm db:reset` now runs the
seed explicitly. It is idempotent, so a future Prisma that starts seeding again
does no harm.

### `P3014` — shadow database

**Symptom:** `prisma migrate dev` fails with "could not create the shadow
database".
**Cause:** `rcln_owner` lacks `CREATEDB`.
**Fix:** `ALTER ROLE rcln_owner CREATEDB;` — already in the init SQL. Only
`migrate dev` needs it; production uses `migrate deploy`, which does not.

---

## Node, pnpm and Prisma

### A hand-dated migration folder sorts before the `migrate dev` one that follows it

**Symptom:** the development database is perfectly healthy and `migrate status`
says "up to date", but building any NEW database from the same folder dies part
way through — `ERROR: index "consumption_lines_organization_id_consumption_id_idx"
does not exist`, or an `ALTER TYPE` naming an enum nothing has created yet. CI's
database job hits it too, because CI always starts from empty.

**Cause:** Prisma applies migrations in **lexicographic folder order**, but
`migrate dev` names a new folder from the **wall clock**. Several migrations here
are hand-named with future dates (`20260911090500_pi_12_online_pharmacy`), so a
folder generated today (`20260902172714_…`) sorts into the MIDDLE of history —
before the migrations that create the objects it alters. The development database
never notices: it applied them in the order they were written, which is recorded
in `_prisma_migrations.started_at`, not in the name.

Four migrations were in this state, and it went unseen for exactly as long as
nobody built a database from scratch.

**Fix:** rename the folder so it sorts last, leaving the file **byte-identical**
so the checksum still matches, then correct the name recorded in the development
database:

```sql
UPDATE _prisma_migrations SET migration_name = '<new>' WHERE migration_name = '<old>';
```

Renaming without the UPDATE is worse than leaving it: Prisma then sees a
migration recorded in the database that no longer exists on disk.

**Prevention:** after adding a migration, check that its folder sorts last —
`ls packages/db/prisma/migrations | sort | tail -3`. `pnpm db:test:setup --fresh`
replays the whole chain from empty in about a minute and fails loudly if it does
not, which is the cheapest standing guard against this.

### Prisma 7 removed `url` from the datasource block

**Symptom:** schema validation error pointing at `datasource db { url = … }`.
**Fix:** the URL moves to `prisma.config.ts`; the runtime client gets it via the
`@prisma/adapter-pg` adapter.

### Prisma 7 requires an explicit adapter

**Symptom:** `new PrismaClient()` throws about a missing adapter or
`accelerateUrl`.
**Fix:** `new PrismaClient({ adapter: new PrismaPg({ connectionString }) })`.
Seeds use `DIRECT_DATABASE_URL` (owner); the app uses `DATABASE_URL` (app role).

### The generated client is not on the root of the workspace

**Symptom:** `Cannot find module '../generated/prisma/index.js'` from `dist/`.
**Cause:** compiled output nests one level deeper than source, breaking the
relative path.
**Fix:** the generated client is exposed through a package self-reference,
`@rcln/db/generated`, so the specifier is identical in `src` and `dist`.

### pnpm does not hoist to the workspace root

**Symptom:** `require('pg')` fails from `/app` even though `pg` is installed.
**Cause:** pnpm's isolated layout only links a dependency into the package that
declares it.
**Fix:** the container's Postgres wait uses Node's built-in `net`, not `pg`.
More generally: import from the package that declares the dependency.

### `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`

**Cause:** pnpm refuses to modify a `node_modules` it considers foreign when it
cannot prompt.
**Fix:** `CI=true`. Set in the dev image.

### `pnpm deploy` needs `--legacy` from pnpm 10

**Symptom:** `ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE`.
**Fix:** `--legacy`. The alternative (`inject-workspace-packages=true`) would
hard-copy workspace deps at install time and break shared-package hot reload.

### `auto-install-peers` inflates production images

**Symptom:** a Node API image at 743 MB.
**Cause:** `@prisma/client` peer-depends on the `prisma` CLI, which pulls in
Studio, pglite, effect and TypeScript — all installed as production deps.
**Fix:** prune them in the build stage. 476 MB after.

---

## Docker

### Deleting files in the runtime stage does not shrink the image

**Symptom:** an aggressive `rm -rf` saves ~20 MB instead of ~250 MB.
**Cause:** the files still exist in the earlier layer.
**Fix:** prune in the stage that created them.

### Each service with a `build:` block gets its own image

**Symptom:** `docker compose build api` fixes one service; the others still run
the old code.
**Fix:** all dev services share `image: rcln-dev:local`, so one build serves all.

### `docker exec` without `-i` silently discards stdin

**Symptom:** a heredoc piped to `psql` reports success and does nothing.
**Fix:** `docker exec -i`. This one wasted real time — the command printed no
error at all.

### OOM kills can report `ExitCode=0`

**Symptom:** a container stops with no error; logs end mid-work.
**Cause:** the OOM killer took a child process; the `pnpm` wrapper above it
exited cleanly.
**Diagnosis:** `docker inspect <c> --format '{{.State.OOMKilled}}'`. Never trust
the exit code alone.

### Bind mounts shadow container `node_modules`

**Symptom:** modules missing, or native modules segfaulting.
**Cause:** mounting the repo over `/app` replaces the image's `node_modules`
with the host's.
**Fix:** a named volume over every `node_modules` path. More specific mounts win.

---

## Next.js 16

### It is not the Next you remember

`middleware.ts` is now **`proxy.ts`**, and the `eslint` config key was
**removed**. `apps/web/AGENTS.md` says to read `node_modules/next/dist/docs/`
before writing Next code. Both of these were hit by not doing so.

### `request.url` in a Route Handler follows the connection, not the Host header

**Symptom:** `NextResponse.redirect(new URL('/', request.url))` in the
impersonation handoff handler answered `Location: http://localhost:3000/` for a
request carrying `Host: northwind.lvh.me`.
**Cause:** `NextRequest.url` is built from the address the server was reached on,
not from the header the app resolves its tenant with. Everything in this product
is addressed by subdomain, so the two differ whenever the connection is
terminated anywhere else.
**Why it is worse here than a wrong-looking URL:** that response carries the
session cookie. Cookies are host-only by design, so a redirect that leaves the
clinic's origin drops the session the redirect exists to deliver — and the user
lands signed out, on the wrong host, with nothing in any log.
**Fix:** a relative `Location`. It is legal HTTP and the browser resolves it
against the address it actually asked for, which is the only host that can be
right:

```ts
new NextResponse(null, { status: 303, headers: { location: '/' } });
```

### `react-hooks/purity` and `set-state-in-effect` rule out the obvious clock

**Symptom:** three separate lint failures building one countdown. `Date.now()`
during render is `react-hooks/purity` — **including in a Server Component**, the
rule does not distinguish. Seeding the state from the effect body is
`react-hooks/set-state-in-effect`. Computing it in the layout and passing it down
fails the first rule in the layout instead.
**Fix, in the end, not a workaround:** pass the ISO instant down and render the
absolute end time — `new Date(iso).toLocaleTimeString()` is pure, needs no state,
no effect and no interval, and it is the fact someone plans around anyway. The
server and the browser format it in different zones, which is a hydration
difference on purpose: `suppressHydrationWarning` on the `<time>`, because the
reader's clock is the correct one.
**When a ticking value is genuinely needed:** anchor an absolute deadline inside
the effect and set state only from the interval callback — never from the effect
body, and never by decrementing, which drifts when the tab is throttled.

### `next build` inside the dev container blames the wrong page entirely

**Symptom:** `pnpm --filter @rcln/web build` dies during the export pass with

```
Error occurred prerendering page "/legal/dpa".
TypeError: Cannot read properties of null (reading 'useContext')
```

The page it names is an ordinary static server component with no hooks in it,
and **the name changes between runs** — `/billing/sandbox` one time, `/legal/dpa`
the next. Chasing the named page leads nowhere: it is whichever route the
prerender workers reached first.
**Cause:** the dev containers export `NODE_ENV=development`, and `docker compose
exec api pnpm … build` inherits it. `next build` respects an already-set
`NODE_ENV` instead of forcing `production`, so the server bundle is compiled for
production while parts of React resolve to the development condition. The
dispatcher ends up null inside Next's own `OuterLayoutRouter`, which is why the
stack points at `next/dist` and not at anything in this repository. The only
honest hint is one line near the top of the output: `⚠ You are using a
non-standard "NODE_ENV" value`.
**Fix:** the `build` script pins it — `NODE_ENV=production next build`. The
Dockerfile's build stage never had the problem, because it leaves `NODE_ENV`
unset and Next then chooses `production` itself.
**Worth knowing:** `next build --debug-prerender` runs the whole thing in
development mode, so it **succeeds** here and reports unrelated warnings on the
way. That is a very convincing wrong answer — reach for it to unminify a real
prerender error, not to decide whether one exists. `pnpm validate` does not run
a build at all, so nothing in the normal pipeline exercises this path.

### Build-only config affects `next dev`

**Symptom:** CPU pinned, web container OOM-killed on first compile.
**Cause:** `outputFileTracingRoot` pointed at the monorepo root, so `next dev`
watched 58,347 files and ~1 GB of `node_modules`.
**Fix:** gate standalone options behind `NEXT_OUTPUT_STANDALONE=1`, set only in
the Dockerfile. Delete the `.next` volume afterwards — a cache built against the
bad root carries the problem forward. → ADR-0010

### Nothing hydrates on `lvh.me`, and the page looks perfect

**Symptom:** every page renders correctly and **no button does anything**. No
browser console error, no failed request in the network tab, no visible clue.
**Cause:** Next 16 blocks cross-origin requests to dev-only assets. The dev
server is initialised on `localhost`, but every URL in this product is a
hostname off the root domain — `lvh.me:3000`, `alpha.lvh.me:3000` — so the HMR
and client chunks are refused and React never hydrates. The only evidence is one
line in the dev server log: `Blocked cross-origin request to Next.js dev
resource`.
**Fix:** `allowedDevOrigins: [rootDomain, '*.' + rootDomain]` in
`next.config.ts`, driven by `NEXT_PUBLIC_ROOT_DOMAIN`. Development only;
production is same-origin. **Check the web container's log before debugging a
dead click handler** — this affects every tenant subdomain, not just the apex.

### `fetch` silently drops the `Host` header, so the BFF addressed no tenant

**Symptom:** every server-side call from `apps/web` reached the API with no
tenant resolved. Visible only once a route sat behind `requireTenant`, which
answered a flat `404 TENANT_NOT_FOUND` — indistinguishable from a missing route.
Before that it was _completely_ silent, and worse than silent at login:
`auth.routes.ts` reads `req.tenant?.organizationId ?? null`, so signing in
through the browser minted a session scoped to **no organization** and reported
success.
**Cause:** `Host` is a forbidden header name in the fetch spec. undici drops it
with no error and no warning. `lib/api.ts` set it on every call, and it had
never once been transmitted.
**Why no test caught it:** supertest sets `Host` normally, so the entire
integration suite exercised a path the browser never takes.
**Fix:** the BFF sends `x-forwarded-host`; `resolveTenant` prefers it and falls
back to `Host`. Pinned by two cases in `branches.test.ts` that set
`Host: api:5000` deliberately, so a regression fails rather than passing on
supertest's more generous behaviour.
**Trust note:** the API must not be publicly reachable except behind an ingress
that overwrites `x-forwarded-host`. See the comment on `requestedHost()`.

### A relative `redirect()` lands on the landing page, and a refresh fixes it

**Symptom:** signing in at `alpha.lvh.me/login` succeeds, the address bar reads
`alpha.lvh.me/`, and the **marketing landing page** renders — on the clinic's own
domain, signed in. Pressing reload shows the correct clinic home.
**Cause:** `proxy.ts` rewrites `/` to `/t/<slug>` from the Host header, so on a
tenant subdomain the clinic home and the landing page are the same URL and only
the rewrite tells them apart. A relative `redirect('/')` out of a Server Action
hands the destination to the client router, and a client-side navigation can
resolve `/` against the route tree — which maps it to `(marketing)/page.tsx`. A
reload is a real document load, so proxy runs and it corrects itself. That
"refresh fixes it" asymmetry is the signature.
**Why an absolute URL does NOT fix it:** the first attempt redirected to
`http://alpha.lvh.me:3000/` instead of `/`, and behaved identically. Next
normalises a same-origin absolute URL back to a path and resolves it the same
way. Only leaving the router helps.
**Fix:** the Server Actions do not navigate at all. `signIn` / `otpSignIn`
return `{ status: 'signed-in' }`, `signOut` and `switchBranch` just return, and
the client component calls `hardNavigate()` (`lib/hard-navigate.ts`), which is
`window.location.assign` — a browser navigation, not a router one, so proxy.ts
always runs. It also drops the client router cache, whose entries were built
under the previous session. The login form additionally renders a plain `<a>`
"Continue to your clinic" for the case where the effect cannot run; it needs an
`eslint-disable` for `no-html-link-for-pages`, because `<Link>` is exactly the
thing that breaks here.
**Same trap, different route:** `/login` collides too (the apex serves a clinic
finder there), and the admin console was worse — `redirect('/platform')` on
`admin.<root>` rewrites to `/platform/platform` and **404s on any real load**. It
only ever worked as a client navigation.

### Every rate limit was one bucket for the whole platform

**Symptom:** the eleventh person to do anything auth-shaped in fifteen minutes —
anywhere, in any clinic — is told their password is wrong or their invitation has
expired. Clears up on its own after a while, so it reads as flakiness.
**Cause:** every call from the web app is server-to-server, so the API saw the
BFF's address. `trust proxy` was `false` outside production and the BFF sent no
`x-forwarded-for`, so `req.ip` was the web container for every user of every
tenant. `authLimiter` allows 10 per 15 minutes. `rl:auth:172.19.0.7 = 14` is what
it looks like in Redis.
**Why no test caught it:** supertest connects to the app directly, so each test
client already looks like a distinct address. The bug only exists on the path
through the BFF, which the integration suite does not use.
**Fix:** the BFF forwards `x-forwarded-for` (`clientAddress` in `lib/api.ts`, and
again in `proxy.ts` for the renewal call), and the API sets `trust proxy` to `1`
in **every** environment — `1` rather than `true`, so a client cannot pick its own
address by prepending one. Same trust boundary as `x-forwarded-host`: the API
must stay private behind an ingress that overwrites both.
**Also:** a per-address budget cannot see a password spray, which is one guess
per account from a new address every time — and it punishes a clinic behind one
office NAT for having staff. `identityLimiter` adds a per-account budget on
`/auth/login`; both must pass. It is not the account lockout in
`password.service.ts`, which counts only FAILED attempts, and it refuses the
request before argon2 runs.

### A constant exported from a `'use server'` module is `undefined` in the browser

**Symptom:** a runtime `TypeError` deep inside a Client Component, on a value
that plainly has a default — `Cannot read properties of undefined (reading
'length')` where the initial state was declared as `{ patients: [], … }`.
**Cause:** every export from a `'use server'` file is compiled into a callable
server reference. That is right for the actions and wrong for anything else: a
`export const EMPTY_SEARCH = { … }` sitting beside them does not survive the
boundary, and the Client Component's `useActionState(action, EMPTY_SEARCH)`
receives `undefined` as its initial state.
**⚠️ It typechecks perfectly.** `tsc` sees an ordinary module-to-module import
and the correct type; the transformation happens after it. Nor does the failure
land at the import — it lands wherever the value is first dereferenced, which on
this screen was a different file and about a hundred lines away.
**Fix:** keep values in the Client Component. `doctor-list.tsx` declares its own
`IDLE` and `patient-search.tsx` its own `EMPTY_SEARCH`, each typed by a `type`
exported from the actions file — types erase at compile time, so they cross the
boundary safely and keep the two in step. Only async functions may be exported
from a `'use server'` module.
**Sweep for it:**
`grep -rl "^'use server'" apps/web/src` then check each file for
`export const|let|var|class|enum`.

### A Server Action re-renders the page, which can unmount the effect that was going to navigate

**Symptom:** a form submits, the work succeeds — row written, cookies set — and
the browser just sits on the same URL. Typing the destination by hand works.
**Cause:** a Server Action's response re-renders the current route's Server
Components. The invitation accept page fetches a preview of the token it is
about to consume, so on that re-render the preview 404s, the page swaps to its
"link is dead" branch, and `JoinForm` unmounts **in the same commit** — taking
its pending `useEffect` with it. The effect that was going to call
`hardNavigate()` never runs. Nothing errors; the page is simply now a different
page.
**The shape of the trap:** any page whose own server render depends on state its
Server Action mutates. The action succeeds and destroys the evidence it
succeeded.
**Fix:** navigate from a component that the re-render _creates_ rather than one
it destroys. `JoinedRedirect` is rendered by the new tree, so it mounts fresh and
its effect is the first thing to run. The page distinguishes "token spent and the
visitor has a session here" (a join that just completed) from "token spent and
nobody is signed in" (a genuinely dead link).
**Do not** reach for `redirect()` in the action instead — that is the separate
trap two entries down, and it lands on the marketing page.
**Diagnosis shortcut:** `docker compose logs api` and look for the action's own
endpoint returning 2xx immediately followed by a read of the same resource
returning 404.

### Renewing a session in a Server Component 500s the page and revokes the family

**Symptom:** every clinic page returns **500** with
`Cookies can only be modified in a Server Action or Route Handler`, roughly
fifteen minutes after signing in — i.e. exactly one access-token lifetime. It
works again after signing in, then breaks again.
**Cause:** `getSession` renewed an expired access token and wrote the result with
`cookies().set()`. HTTP cannot add a `Set-Cookie` header once a render has begun
streaming, so Next refuses it outright — this is documented behaviour, not a
quirk (`next/dist/docs/01-app/03-api-reference/04-functions/cookies.md`).
**The second, worse half:** the refresh SUCCEEDED before the write threw. So the
API rotated the token, the browser never received the new one, and the next
request replayed the spent one — which is precisely what `rotateRefreshToken`
treats as theft. Reuse detection revoked the whole session family. A
`sessions` row with `previous_token_hash` set and `revoked_at` set is the
fingerprint.
**Fix:** renewal moved to `proxy.ts`, which runs before the render and can set
cookies (Next 16 runs Proxy in the Node runtime). It mutates `request.cookies`
as well as the response, so the render in the same pass sees the new token
instead of waiting a round trip. `getSession` and `getPlatformSession` are now
strictly read-only: a usable access token or `null`.
**The trigger is the cookie, not the JWT.** The access cookie is written with
`maxAge` equal to the token's own expiry, so "cookie absent, refresh cookie
present" means "expired" without decoding anything.
**Do not** delete the cookies when the API is merely unreachable — that signs
everyone out over a deploy. Only a refusal from the API counts as spent.
**Rule of thumb:** `setSessionCookies` / `clearSessionCookies` are for Server
Actions and Route Handlers. If a page or layout calls either, it is this bug.

### `Date.now()` in a render is a lint error, not a style note

**Symptom:** `eslint` fails with `Cannot call impure function during render`
(`react-hooks/purity`) on an ordinary-looking line in a **Server** Component.
**Cause:** the React compiler's purity rule applies to server renders too. It is
right: a value derived from the clock at render time has no reason to update, so
"3 days left" stays on screen after it has become "2 days left", and two renders
of the same data disagree.
**Fix:** derive it where the data comes from. The invitations screen shows a
countdown, and `daysLeft` is computed by the API alongside the `status` word it
has to agree with — see `invitationSummary` in `@rcln/contracts`. Reach for
`useEffect` + state only when the value must actually tick.

### A stale host `.next` breaks `pnpm validate` from another container

**Symptom:** `pnpm validate` fails with
`.next/types/validator.ts: Cannot find module '../../src/app/page.js'` for
routes that were moved or renamed, while `pnpm typecheck` inside the web
container passes.
**Cause:** `web_next:/app/apps/web/.next` is a named volume mounted **only** on
the `web` service. Every other container bind-mounts the repo at `/app` and so
sees the _host's_ `apps/web/.next` — a directory nothing writes to any more.
Next's generated route types there are frozen at whatever the routes were when
it was last written.
**Fix:** delete the stale contents
(`docker compose exec -u root api rm -rf /app/apps/web/.next/dev /app/apps/web/.next/types`).
Run web's typecheck in the `web` container when in doubt — that is the copy the
dev server actually maintains.

---

### `getPropertyValue('--color-drape')` returns an empty string

**Symptom:** reading a design token in JavaScript gives `''`, so a chart, a
canvas or a dynamically-built style silently paints black or nothing. The class
`bg-drape` works perfectly on the same page, which is what makes this baffling.
**Cause:** `globals.css` maps the palette onto Tailwind's names with
`@theme inline`. The `inline` keyword means Tailwind substitutes the value at
build time and **never emits `--color-*` as a real custom property**. Nothing
with that name exists at runtime to be read.
**Fix:** read the underlying variable, `--rcln-drape`. Those are real custom
properties published by `theme.css`, which is the only reason the theme can
change without a rebuild. → [ADR-0017](decisions/0017-theme-is-a-device-preference.md)

### A white flash on every reload, for dark-mode users only

**Symptom:** the page paints light, then snaps dark. Reproducible on every hard
reload; invisible to anyone testing in light mode, which is most people.
**Cause:** the document is served with no theme attributes — it must be, or the
marketing pages could not stay statically rendered. Anything that applies the
theme from React (a provider, `useEffect`, even `useLayoutEffect`) runs _after_
the browser has painted its first frame, and that frame is the flash.
**Fix:** it is applied by `ThemeScript`, a **blocking inline `<script>`** in
`<head>`. Keep it blocking and keep it inline. `next/script` with any strategy,
or moving the logic into a component, restores the flash — and the change will
look like a tidy-up.

### An accent renders as the previous one, and the setting looks broken

**Symptom:** picking an accent in `/appearance` appears to do nothing, or reverts
to whatever was showing before. No error anywhere.
**Cause:** an id was added to `ACCENTS` in `lib/theme.ts` without a matching
`[data-accent='…']` block in `app/theme.css`. The attribute is set on
`<html>` correctly; there is simply no rule that matches it, so the custom
properties keep their inherited values.
**Fix:** add the CSS block. ⚠️ Nothing catches this — one side is TypeScript and
the other is CSS, so it neither typechecks nor lints, and `apps/web` has no
tests. The pairing is a string match maintained by hand.

### A colour literal that reviews cleanly and is unreadable in nine themes

**Symptom:** text vanishes, or a button loses its border, but only for users on a
non-default accent or in dark mode. Nobody can reproduce it.
**Cause:** a raw colour — `bg-white`, `text-neutral-900`, a hex in a `style`
prop, `text-white` on an accent surface — instead of a token. There are ten
appearance × accent combinations and a literal is correct in exactly one. Review
happens in that one.
**Fix:** tokens only. `bg-card`, `text-ink`, `border-rule`; the pair for a solid
accent is `bg-drape text-paper`. Note `--rcln-scrim` is the deliberate exception
and does not invert: a modal veil is dark in both appearances, so `bg-scrim/60`,
never `bg-ink/40`.

---

## Express and tooling

### `express-rate-limit` v8 rejects a naive `keyGenerator`

**Symptom:** `ERR_ERL_KEY_GEN_IPV6` at startup.
**Cause:** a custom key generator using raw `req.ip` — a single IPv6 host owns
astronomically many addresses and could sidestep the limit.
**Fix:** `ipKeyGenerator(req.ip, 56)`.

### Assigning to `req.query` in Express 5 fails silently

**Symptom:** a route validated with `validate(schema, 'query')` reads raw strings
where the schema promised numbers, and `undefined` where it promised a
`.default()`. No error, and it typechecks — the middleware casts through `any` to
do the assignment, which erases the evidence.
**Cause:** Express 5 made `req.query` a getter with no setter. This file is not
in strict mode, so `req.query = parsed` is a no-op rather than a `TypeError`.
Nothing had used the `'query'` source before, so it went unnoticed.
**Fix:** `Object.defineProperty(req, 'query', { value, writable: true, … })` in
`validate.middleware.ts`. `req.body` and `req.params` are plain properties and
assign normally.
**Worth knowing:** the first schema this would have silently broken is
`paginationQuery`, which uses `z.coerce.number()` and `.default()` throughout.

### The default rate-limit store is per-process

**Symptom:** limits are effectively N× looser with N containers.
**Fix:** `rate-limit-redis`.

### Turbo filters the environment

**Symptom:** a test suite passes via `pnpm --filter X test` but every case fails
under `pnpm validate`, with `Connection terminated unexpectedly`.
**Cause:** Turbo 2 passes through only the variables declared in `globalEnv` /
`globalPassThroughEnv`, for cache correctness. Undeclared ones are simply absent,
so the tenant-isolation suite fell back to the `.env` file's `localhost` and
found no Postgres inside the container. Postgres logged nothing, because no
connection was ever attempted.
**Fix:** declare runtime variables in `globalPassThroughEnv` in `turbo.json`
(passThrough, not `env`, so machine-specific values do not bust the cache).
**Diagnosis shortcut:** if `--env-mode=loose` makes it pass, it is this.

### Parallel Jest workers share one Redis, so rate-limit tests fail at random

**Symptom:** `auth.test.ts`'s rate-limit cases fail under `pnpm validate` but
pass when that file is run on its own.
**Cause:** several integration suites call `redis.keys('rl:*')` and delete the
lot before making a request, so that the limiters do not count another suite's
traffic. Jest runs suites in parallel by default, so one suite's flush lands in
the middle of another suite's deliberate count. Latent from the moment a second
suite started flushing; adding a ninth suite made it reproducible.
**Fix:** `maxWorkers: 1` in `apps/api/jest.config.ts`. These are integration
suites sharing one Postgres and one Redis; the shared state is real.

### Jest 30 needs a flag for ESM

**Symptom:** `SyntaxError: Cannot use import statement outside a module`.
**Fix:** `NODE_OPTIONS=--experimental-vm-modules` (already in the test scripts).

### `instanceof` is unreliable across pnpm symlinks

**Symptom:** a Prisma error is not caught by `instanceof
Prisma.PrismaClientKnownRequestError`.
**Cause:** the generated client and the app can resolve to separate class
identities.
**Fix:** narrow structurally on `err.name` and the presence of `code`.
