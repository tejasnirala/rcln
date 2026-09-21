# rcln

[![CI](https://github.com/tejasnirala/rcln/actions/workflows/ci.yml/badge.svg)](https://github.com/tejasnirala/rcln/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](package.json)
[![Status: pre-1.0](https://img.shields.io/badge/status-pre--1.0-orange.svg)](.kb/STATUS.md)

Multi-tenant healthcare management SaaS. A clinic registers, gets its own
subdomain (`alpha.xyz.com`), and runs appointments, prescriptions, lab, pharmacy
and billing across one or many branches.

> **Pre-1.0 and under active development.** No external security audit, no
> penetration test, no healthcare compliance certification. Do not run it
> against real patient data without your own review. See
> [`.kb/STATUS.md`](.kb/STATUS.md) for what actually works today.

**All documentation lives in [`.kb/`](.kb/README.md)** — 17 numbered documents
plus generated indexes of every symbol, endpoint, table and permission. The old
`docs/` directory is pointer stubs.

- **Start here** — [`.kb/README.md`](.kb/README.md)
- **How it works — the tour** — [`.kb/Architecture/how-it-works.md`](.kb/Architecture/how-it-works.md)
- **Status — what is built, what is next** — [`.kb/STATUS.md`](.kb/STATUS.md)
- **Schema design** — [`.kb/Database/schema-design.md`](.kb/Database/schema-design.md)
- **Architecture (target design)** — [`.kb/Architecture/architecture.md`](.kb/Architecture/architecture.md)
- **Decisions (ADRs)** — [`.kb/Architecture/decisions/`](.kb/Architecture/decisions/README.md)
- **Conventions** — [`.kb/Architecture/CONVENTIONS.md`](.kb/Architecture/CONVENTIONS.md)
- **Known pitfalls** — [`.kb/Architecture/PITFALLS.md`](.kb/Architecture/PITFALLS.md)

Looking for an existing function, component, route or column?

```bash
pnpm kb:find <name>        # search the symbol index before writing anything
```

---

## Setup

Pick one. **A** is recommended and needs nothing but Docker.

| Path                                          | Needs on your machine                  | Best for                                          |
| --------------------------------------------- | -------------------------------------- | ------------------------------------------------- |
| **A — Everything in Docker**                  | Docker only                            | Onboarding, matching CI, keeping a laptop clean   |
| **B — Hybrid** (apps native, infra in Docker) | Docker, Node 22+, pnpm                 | Day-to-day work; fastest reloads, native debugger |
| **C — Fully native**                          | Node 22+, pnpm, PostgreSQL 16, Redis 7 | No Docker at all                                  |

All three end at the same place: api on `:5000`, web on `:3000`, worker
consuming from Redis, database migrated and seeded.

---

### Path A — Everything in Docker

**Prerequisites:** Docker Desktop (or Docker Engine + Compose v2). Allocate at
least 6 GB of memory to Docker — the web container is capped at 3 GB and
Turbopack will use most of it during a cold compile.

**Step 1 — Clone**

```bash
git clone git@gp:tejasnirala/rcln.git
cd rcln
```

**Step 2 — Environment (optional here)**

Compose supplies working defaults for every variable, so the stack starts with
no `.env` at all. Create one only if you want to override something:

```bash
cp .env.example .env
```

Note that compose **overrides** `DATABASE_URL`, `DIRECT_DATABASE_URL` and
`REDIS_URL` with container hostnames (`postgres`, `redis`) regardless of what
`.env` says — the values in `.env.example` point at `localhost` and are meant
for paths B and C.

**Step 3 — Start**

```bash
docker compose up
```

That is the entire setup. On first run the stack:

1. builds the shared dev image (~2 min)
2. installs dependencies into a named volume
3. generates the Prisma client against the container's libc
4. builds `@rcln/db`, `@rcln/contracts`, `@rcln/permissions`
5. creates the `rcln_owner` / `rcln_app` roles and the required extensions
6. applies migrations and the RLS policies
7. seeds 83 permissions, 12 system roles, 12 settings, 3 plans, the super admin
8. verifies every tenant table is protected, then starts api, web and worker

Roughly 3–4 minutes cold; about 15 seconds on subsequent starts.

**Step 4 — Verify**

```bash
curl http://localhost:5000/api/v1/health/ready   # database + redis connected
open http://localhost:3000
```

Editing any file in VS Code reloads the running service — source is
bind-mounted, so `tsx watch` and `next dev` see host edits immediately.

---

### Path B — Hybrid (recommended for daily development)

Infrastructure in Docker, apps on the host. Reloads are faster than Path A and
you can attach a native debugger.

**Step 1 — Prerequisites**

```bash
node --version        # must be >= 22
corepack enable pnpm  # pnpm 10.18.2, pinned by packageManager — do not npm i -g pnpm
```

**Step 2 — Clone and install**

```bash
git clone git@gp:tejasnirala/rcln.git
cd rcln
pnpm install
```

**Step 3 — Environment**

```bash
cp .env.example .env
```

Now populate it. The defaults work as-is for local development except
`JWT_SECRET`, which is validated at boot and must be at least 32 characters:

```bash
# macOS / Linux
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Paste that into `JWT_SECRET`. The variables that matter:

| Variable              | Local value                                                                | Why                                                               |
| --------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `DATABASE_URL`        | `postgresql://rcln_app:app_password@localhost:5432/rcln?schema=public`     | App role. **RLS is enforced** for it                              |
| `DIRECT_DATABASE_URL` | `postgresql://rcln_owner:owner_password@localhost:5432/rcln?schema=public` | Owner role. Migrations and seeds only — **RLS is bypassed**       |
| `REDIS_URL`           | `redis://localhost:6379`                                                   | Cache, rate limits, BullMQ                                        |
| `JWT_SECRET`          | generate one                                                               | Rejected at boot if under 32 chars                                |
| `ROOT_DOMAIN`         | `lvh.me`                                                                   | `*.lvh.me` resolves to 127.0.0.1 publicly — no `/etc/hosts` edits |
| `SUPERADMIN_EMAIL`    | `superadmin@rcln.local`                                                    | Seeded once; the only account never created through the UI        |
| `SUPERADMIN_PASSWORD` | change it                                                                  | Seed refuses anything under 16 chars when `NODE_ENV=production`   |

Those two database URLs **must stay different roles**. Postgres exempts a
table's owner from its own RLS policies, so pointing `DATABASE_URL` at
`rcln_owner` silently disables tenant isolation. The API refuses to boot if you
do — see `assertRlsActive()`.

**Step 4 — Start infrastructure**

```bash
pnpm infra          # postgres + redis + mailpit only
```

Postgres runs `infra/postgres/init/01-roles-and-extensions.sql` on first boot,
which creates both roles and the `pgcrypto`, `pg_trgm`, `btree_gist` and
`citext` extensions.

**Step 5 — Database**

```bash
pnpm db:generate    # Prisma client
pnpm db:migrate     # schema + RLS policies
pnpm db:seed        # permissions, system roles, settings, plans, super admin
pnpm db:rls:check   # fails if any tenant table lacks a policy
pnpm db:test:setup  # builds `rcl_testing`, the database the test suite writes to
```

The tests never touch `rcln`. `pnpm test` rewrites `DATABASE_URL` and
`DIRECT_DATABASE_URL` to `rcl_testing` — same server, same roles, different
database — so a run cannot bury the records you created in the browser. Re-run
`pnpm db:test:setup` after any migration; on Path A the `migrate` service does it
for you on every `docker compose up`. Add `--fresh` to drop and rebuild it — the
right move after a setup that failed halfway, because Prisma refuses to apply
anything to a database holding a failed migration record.

**Step 6 — Run**

```bash
pnpm dev            # api :5000, web :3000, worker — all in watch mode
```

Single service instead: `pnpm dev:api`, `pnpm dev:web`, `pnpm dev:worker`.

---

### Path C — Fully native (no Docker)

Same as Path B, but you provide Postgres and Redis yourself.

**Step 1 — Install services**

```bash
# macOS
brew install postgresql@16 redis
brew services start postgresql@16
brew services start redis

# Debian / Ubuntu
sudo apt install postgresql-16 redis-server
sudo systemctl start postgresql redis-server
```

**Step 2 — Create the database and roles**

The role split is not optional — it is what makes RLS effective. Run the same
script Docker runs:

```bash
createdb rcln
psql -d rcln -f infra/postgres/init/01-roles-and-extensions.sql
```

That script needs superuser rights (it creates extensions and roles). On a
default Homebrew install your own user is a superuser; on Linux use
`sudo -u postgres psql -d rcln -f ...`.

Verify the roles landed correctly — both must be `f`:

```bash
psql -d rcln -c "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'rcln%';"
```

**Step 3 onwards** — identical to Path B steps 2, 3, 5 and 6 (clone, install,
`.env`, `db:*`, `pnpm dev`). Skip `pnpm infra`; you already have the services.

Without Docker there is no Mailpit, so set `EMAIL_PROVIDER=console` in `.env`
and outbound mail is logged instead of sent.

---

### Once it is running

| URL                                 | What                                                         |
| ----------------------------------- | ------------------------------------------------------------ |
| http://localhost:3000               | marketing / platform root                                    |
| http://alpha.lvh.me:3000            | a tenant (`lvh.me` resolves to 127.0.0.1, no host-file edit) |
| http://admin.lvh.me:3000            | super-admin console                                          |
| http://localhost:5000/api/v1/health | api liveness                                                 |
| http://localhost:8025               | mailpit — every outbound email in dev (paths A and B)        |

**Invitations arrive in Mailpit.** The invitation token is handed to the sender
and to nobody else — the column holds a digest — so http://localhost:8025 is
where you open one. Same for email verification codes. Mailpit delivers to
nobody, so no address you type into the product can receive a real message.
Compose points the API at it (`EMAIL_PROVIDER=smtp`, `SMTP_HOST=mailpit`);
set `EMAIL_PROVIDER=console` to go back to logging the message instead.

The seeded super admin is `superadmin@rcln.local` with whatever
`SUPERADMIN_PASSWORD` you set (default `ChangeMe!SuperAdmin1`). Login endpoints
arrive in Phase 1; for now the account exists in the database only.

A fresh database has **no organizations**, so tenant resolution has nothing to
find. In Phase 0 that shows up as:

- `alpha.lvh.me:3000` → **200**. The web proxy rewrites any subdomain to
  `/t/<slug>`, and the placeholder route renders without checking. It is the API
  that decides whether a tenant exists.
- `curl -H 'Host: alpha.lvh.me' localhost:5000/` → `"tenant": null`.

To see resolution actually working, insert one:

```bash
docker compose exec -T postgres psql -U rcln_owner -d rcln <<'SQL'
INSERT INTO organizations (id, slug, legal_name, display_name, org_type, status, updated_at)
VALUES (gen_random_uuid(), 'alpha', 'Alpha Clinic Pvt Ltd', 'Alpha Clinic', 'CLINIC', 'ACTIVE', now());
INSERT INTO organization_domains (id, organization_id, domain, is_primary, verified_at)
SELECT gen_random_uuid(), id, 'alpha.lvh.me', true, now() FROM organizations WHERE slug = 'alpha';
SQL

curl -H 'Host: alpha.lvh.me' http://localhost:5000/   # -> "tenant":"alpha"
```

Tenant lookups are cached in Redis for 5 minutes, so allow for that or run
`docker compose exec redis redis-cli DEL tenant:host:alpha.lvh.me`.

---

### Troubleshooting

| Symptom                                                      | Cause and fix                                                                                                                                        |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| API exits with "Refusing to start: role … owns N RLS tables" | `DATABASE_URL` points at `rcln_owner`. Point it at `rcln_app`. This guard is deliberate — the alternative is silent loss of tenant isolation.        |
| `pnpm db:rls:check` fails                                    | A tenant table shipped without a policy. Add it to `packages/db/prisma/rls/enable-rls.sql` and re-run the migration.                                 |
| `P3014 … shadow database`                                    | `rcln_owner` lacks `CREATEDB`. Run `ALTER ROLE rcln_owner CREATEDB;`. Only `migrate dev` needs it; production uses `migrate deploy`, which does not. |
| Web container is killed, high CPU                            | Docker has too little memory. Give it ≥6 GB. The `mem_limit` values cap each service so one cannot starve the host.                                  |
| Edits do not trigger a reload                                | Native fs events are not propagating. Start with `WATCH_POLL=true docker compose up`. Polling costs CPU, so leave it off unless you need it.         |
| `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`                 | pnpm run non-interactively without `CI=true`. The dev image sets it; if you hit this on the host, prefix the command with `CI=true`.                 |
| Port already in use                                          | Override per run: `API_PORT=5001 WEB_PORT=3001 DB_PORT=5433 docker compose up`.                                                                      |

Start completely fresh at any time:

```bash
docker compose down -v     # drops the database and all volumes
docker compose up
```

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

The same workspace scripts exist on every path. On Path A prefix them with
`docker compose exec api`; on B and C run them directly.

| Task                      | Path A (Docker)                                        | Paths B / C (host)             |
| ------------------------- | ------------------------------------------------------ | ------------------------------ |
| Start everything          | `docker compose up`                                    | `pnpm infra` then `pnpm dev`   |
| One service               | `docker compose up api`                                | `pnpm dev:api`                 |
| Follow logs               | `docker compose logs -f api`                           | in the `pnpm dev` output       |
| Shell                     | `docker compose exec api sh`                           | —                              |
| Stop                      | `docker compose down`                                  | Ctrl-C, `pnpm infra:stop`      |
| Wipe the database         | `docker compose down -v`                               | `pnpm db:reset --force`        |
| Typecheck + lint + test   | `docker compose exec api pnpm validate`                | `pnpm validate`                |
| New migration             | `docker compose exec api pnpm db:migrate --name x`     | `pnpm db:migrate --name x`     |
| RLS enforcement check     | `docker compose exec api pnpm db:rls:check`            | `pnpm db:rls:check`            |
| Prisma Studio             | `docker compose exec api pnpm db:studio`               | `pnpm db:studio`               |
| Tenant-isolation suite    | `docker compose exec api pnpm --filter @rcln/api test` | `pnpm --filter @rcln/api test` |
| Re-seed                   | `docker compose exec api pnpm db:seed`                 | `pnpm db:seed`                 |
| Build the test database   | `docker compose exec api pnpm db:test:setup`           | `pnpm db:test:setup`           |
| Restore `rcln_app` grants | `docker compose exec api pnpm db:grants`               | `pnpm db:grants`               |

Convenience aliases exist for the Docker verbs: `pnpm up`, `pnpm down`,
`pnpm nuke`, `pnpm logs`, `pnpm sh`, `pnpm rebuild`.

### How the dev container works

| Concern          | Handling                                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source           | Bind-mounted at `/app`, so host edits reload instantly                                                                                                                                       |
| `node_modules`   | Named volumes over every workspace path. Never the host's — native modules (`@node-rs/argon2`, Prisma engines) are compiled per platform and macOS binaries would crash in a Linux container |
| Prisma client    | Generated in-container into a volume, so the query engine matches the image's libc                                                                                                           |
| Dependency drift | The entrypoint hashes `pnpm-lock.yaml` and reinstalls only when it changes                                                                                                                   |
| File watching    | Polling is on by default, since bind mounts do not reliably deliver inotify events on macOS. On Linux set `WATCH_POLL=false` for lower CPU                                                   |
| One image        | api, web, worker and migrate share `rcln-dev:local`; only the command differs                                                                                                                |

### Adding a tenant table

RLS is not generated by Prisma Migrate, so:

1. Add the model with `organizationId` and `@@unique([organizationId, id])`.
2. `docker compose exec api pnpm db:migrate --name your_change`
3. Add the table to the `org_scoped` array in
   `packages/db/prisma/rls/enable-rls.sql`.
4. Append that file's contents to the generated `migration.sql`.
5. `docker compose exec api pnpm db:rls:check` — it fails until the policy exists.
6. Add a case to `apps/api/tests/integration/tenant-isolation/`.

Step 5 is why the check exists: a missing policy throws no error and breaks no
single-tenant test. It just starts returning other clinics' records.

---

## Production images

Built from the repo root, one per app:

```bash
docker build -f apps/api/Dockerfile    -t rcln-api .
docker build -f apps/web/Dockerfile    -t rcln-web .
docker build -f apps/worker/Dockerfile -t rcln-worker .
```

Two things keep them small. `.dockerignore` cuts the build context from **996 MB
to 1.4 MB** (58,347 files to 110) — without it, every build uploads the entire
`node_modules` to the daemon before running a single instruction. And
`pnpm deploy --prod --legacy` resolves the workspace symlinks into a
self-contained tree of only the dependencies that app actually reaches, instead
of copying the ~1 GB pnpm store.

Note that pruning has to happen in the **build** stage. Deleting files in the
runtime stage leaves them in the earlier layer and the image does not shrink —
that mistake cost 240 MB before it was caught.

---

## Status

Phase 0 (foundation) is complete: monorepo, schema for tenancy/subscriptions/
identity/RBAC/settings/audit, RLS with CI enforcement, tenant resolution,
seeded system roles and super admin.

Phase 1 is auth endpoints, org registration, branch CRUD and the branch
switcher. See §17 of [`.kb/Architecture/architecture.md`](.kb/Architecture/architecture.md) for the
full sequence.

[`.kb/STATUS.md`](.kb/STATUS.md) is the living ledger and is more current than
this section. Released versions are recorded in [`CHANGELOG.md`](CHANGELOG.md).

---

## Contributing

Issues and pull requests are welcome. Start with
[`CONTRIBUTING.md`](CONTRIBUTING.md) — it covers the five invariants, the schema
change sequence, and what CI will check. Participation is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md).

**Found a security problem?** Do not open an issue. Follow
[`SECURITY.md`](SECURITY.md) and report it through GitHub's private
vulnerability reporting. This is multi-tenant software holding protected health
information; the realistic worst case is one clinic reading another clinic's
patient records.

---

## License

Copyright © 2026 Tejas Nirala.

rcln is free software, licensed under the
**[GNU Affero General Public License v3.0](LICENSE)**.

In short: you may use, study, modify and redistribute it, and if you run a
modified version as a network service, you must make your modified source
available to its users under the same license. There is **no warranty** — see
sections 15 and 16 of the license.

Third-party dependencies remain under their own licenses.

---

## Disclaimer

rcln is software for administering a clinic. It is **not a medical device**, it
does not provide clinical decision support, and nothing it produces is medical
advice. Deploying it to handle real patient data makes you responsible for your
own regulatory obligations — data protection, retention, consent, and any
healthcare-specific rules in your jurisdiction. The India-first elements in the
domain model (GST, HSN codes, ABHA) are implementation details, not a claim of
compliance or certification.
