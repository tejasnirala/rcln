# Pitfalls

Traps already hit in this repository, with the symptom, the cause and the fix.

Every one of these **typechecks cleanly** and most produce no error message.
They were found by running the thing, not by reading the code. If something
behaves oddly, look here before debugging from scratch.

---

## Postgres and RLS

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
every ordinary request. Boundaries are pinned in `tenant-isolation.test.ts`.

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

### Prisma cannot target a compound unique containing NULL

**Symptom:** `Argument 'organizationId' must not be null` in an `upsert`.
**Cause:** Prisma will not build a `where` for a compound unique with a null
component.
**Fix:** `findFirst` then `create`/`update`. Uniqueness is still guaranteed by
the `NULLS NOT DISTINCT` index. See `prisma/seed.ts`.

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

### `P3014` — shadow database

**Symptom:** `prisma migrate dev` fails with "could not create the shadow
database".
**Cause:** `rcln_owner` lacks `CREATEDB`.
**Fix:** `ALTER ROLE rcln_owner CREATEDB;` — already in the init SQL. Only
`migrate dev` needs it; production uses `migrate deploy`, which does not.

---

## Node, pnpm and Prisma

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
