# rcln

[![CI](https://github.com/tejasnirala/rcln/actions/workflows/ci.yml/badge.svg)](https://github.com/tejasnirala/rcln/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](package.json)
[![Status: pre-1.0](https://img.shields.io/badge/status-pre--1.0-orange.svg)](.kb/STATUS.md)

**Practice software for clinics and hospitals — one patient record, from the
front-desk token to the GST invoice, across every branch.**

A clinic signs up, gets its own address (`sunrise.rcln.com`), and runs its day
on it: appointments and the day board, the consultation and the prescription,
the pharmacy counter, stock, purchasing and billing. A solo practice and a
six-branch hospital are the same shape — opening a second location is a form,
not a project. It is subscription-billed and India-first: GST, HSN codes, ABHA
and the CDSCO drug schedules are part of the model, not a plug-in.

<img alt="The appointments day board on desktop, with a patient record open on a phone" src="./.github/assets/screenshots/00-hero-clinic-light.webp" width="100%">

> **Pre-1.0 and under active development.** No external security audit, no
> penetration test, no healthcare compliance certification. Do not run it
> against real patient data without your own review. See
> [`.kb/STATUS.md`](.kb/STATUS.md) for what actually works today.

**Contents** — [What it does](#what-it-does) · [A look around](#a-look-around) ·
[How it is built](#how-it-is-built) · [Quick start](#quick-start) ·
[Setup in depth](#setup-in-depth) · [Repository layout](#repository-layout) ·
[Commands](#commands) · [Documentation](#documentation) · [Status](#status) ·
[Contributing](#contributing) · [License](#license)

---

## What it does

| Area                   | What a clinic gets                                                                                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Getting started**    | Self sign-up on its own subdomain, then a seven-step setup wizard: who you are, who you treat, which modules you run, opening hours, billing, your team. Staff join by emailed invitation.                              |
| **Front desk**         | Doctors with weekly schedules and per-visit fees; an availability engine; booking, rescheduling and follow-ups; a day board that moves each visit from booked → arrived → with the doctor → seen.                       |
| **Consultation**       | A specialty-aware consultation that autosaves: complaint, symptoms, vitals, diagnoses, prescriptions, investigations, advice, referrals and body/dental charts. Signing makes it immutable; corrections are amendments. |
| **Patient record**     | One record per person across every branch — allergies up front, conditions, current medicines, the visit history and the treatment journey.                                                                             |
| **Pharmacy**           | A prescription queue, dispensing against the signed prescription, counter sales and returns — every supply checked against a versioned regulatory rule pack (India: Drugs Rules 1945, Pharmacy Act 1948).               |
| **Stock & purchasing** | An append-only stock ledger with batch and expiry tracking, first-expiry-first-out allocation, transfers, recalls, suppliers, purchase orders, goods receipts and returns.                                              |
| **Billing**            | GST invoices raised from the visit or from approved charges, credit notes and voids, per-branch numbering, PDF generation — and the clinic's own rcln subscription, with upgrades and recurring payments.               |
| **Access**             | Twelve built-in roles, assignable per branch, that a clinic can clone and tune. A doctor writes in the clinical record; an administrator can read it but not author it. Every change is audited.                        |

---

## A look around

These are real captures of the running app, holding a **fictional demo clinic** —
every name, number and record is made up. Every screen also exists in dark mode
and on a phone — see the full set linked at the end of this section.

<table>
  <tr>
    <td width="50%">
      <img alt="Appointments day board" src="./.github/assets/screenshots/05-appointments-desktop-light.webp" width="100%">
      <p><b>The day board.</b> Every visit at the branch, by status, with what has been billed.</p>
    </td>
    <td width="50%">
      <img alt="A consultation being written" src="./.github/assets/screenshots/06-consultation-desktop-light.webp" width="100%">
      <p><b>The consultation.</b> Laid out by the doctor's specialty; it autosaves until it is signed.</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img alt="A patient record with an allergy alert" src="./.github/assets/screenshots/07-patient-desktop-light.webp" width="100%">
      <p><b>The patient record.</b> Allergies first, then conditions, current medicines and history.</p>
    </td>
    <td width="50%">
      <img alt="A GST bill of supply" src="./.github/assets/screenshots/08-invoice-desktop-light.webp" width="100%">
      <p><b>The invoice.</b> A GST document with its own statutory number, rendered to PDF.</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img alt="Doctors with their weekly schedules" src="./.github/assets/screenshots/10-doctors-desktop-light.webp" width="100%">
      <p><b>Doctors.</b> Specialty, registration and the working week that decides which slots exist.</p>
    </td>
    <td width="50%">
      <img alt="Pharmacy prescription queue" src="./.github/assets/screenshots/12-pharmacy-queue-desktop-light.webp" width="100%">
      <p><b>The pharmacy queue.</b> Signed prescriptions waiting at the counter, longest wait first.</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img alt="Setup wizard, choosing modules" src="./.github/assets/screenshots/04-setup-modules-desktop-light.webp" width="100%">
      <p><b>Setup.</b> A new clinic picks what it runs; only those modules appear in its menu.</p>
    </td>
    <td width="50%">
      <img alt="Appearance settings" src="./.github/assets/screenshots/11-appearance-desktop-light.webp" width="100%">
      <p><b>Appearance.</b> Light, dark or system, and five accents — chosen per device, not per account.</p>
    </td>
  </tr>
</table>

**On a phone** — the same screens, nothing hidden:

<table>
  <tr>
    <td width="25%">
      <img alt="Day board on a phone" src="./.github/assets/screenshots/05-appointments-mobile-light.webp" width="100%">
    </td>
    <td width="25%">
      <img alt="Patient record on a phone" src="./.github/assets/screenshots/07-patient-mobile-light.webp" width="100%">
    </td>
    <td width="25%">
      <img alt="Consultation on a phone" src="./.github/assets/screenshots/06-consultation-mobile-light.webp" width="100%">
    </td>
    <td width="25%">
      <img alt="Invoice on a phone" src="./.github/assets/screenshots/08-invoice-mobile-light.webp" width="100%">
    </td>
  </tr>
</table>

**The public site** — the landing page, clinic sign-up and per-clinic sign-in:

<img alt="The rcln landing page on desktop and phone" src="./.github/assets/screenshots/00-hero-marketing-light.webp" width="100%">

Every capture — all twelve screens on desktop and phone, in light and dark,
including the ones not shown here — is in
[`.github/assets/screenshots/`](.github/assets/screenshots/). Phone numbers, tax
and medical-council registration numbers and street addresses are masked in
them, even though the data behind them is invented.

---

## How it is built

**Stack:** pnpm monorepo · TypeScript everywhere · Express 5 API · Next.js 16
web app · PostgreSQL 16 with Prisma 7 · Redis · BullMQ worker. Validation is one
set of Zod contracts shared by the API and the web app; the API serves a
generated OpenAPI 3.1 reference at `/docs` in which every one of its 462
endpoints carries hand-written documentation.

```
browser ─► sunrise.rcln.com ─► Next.js (apps/web) ─► Express API (apps/api) ─► Postgres (RLS)
                                                          │                       ▲
                                                          └─► Redis ─► BullMQ worker (apps/worker)
                                                                       PDFs · email · billing · stock sweeps
```

### The three ideas to understand before changing anything

**1. The organization is the tenant; the branch is the place.** A solo clinic
and a three-branch hospital are the same shape: one `organization`, one or three
`branches`. Opening a location is an `INSERT`, never a migration.

**2. Roles live on the membership, not the user.** There is no `role` column on
`users`. Access is:

```
memberships       user × organization
membership_roles  membership × role × branch_id NULLABLE
```

`branch_id NULL` means every branch in the organization. That single nullable
column is the whole multi-branch admin story:

| Requirement                    | Rows in `membership_roles`                |
| ------------------------------ | ----------------------------------------- |
| One admin over all branches    | 1 row, `branch_id = NULL`                 |
| A separate admin per branch    | 1 row each, `branch_id` set               |
| Admin over A+B, another over A | 2 rows + 1 row                            |
| Doctor at A, receptionist at C | 2 rows, different `role_id` + `branch_id` |

**3. Tenant isolation is enforced by Postgres, not by the ORM.** This is patient
data in a shared database, and the realistic worst case is one clinic reading
another's records. So there are three independent layers:

1. **Row-level security.** Every tenant table has a policy on
   `organization_id = app_current_org()` — 136 of the 160 tables are under RLS,
   and CI fails if one ships without it. With no context set, queries return
   nothing: it fails closed.
2. **Composite foreign keys.** Children reference `(organization_id, id)`, so a
   row pointing at another tenant's branch cannot be represented at all.
3. **Application scoping.** Services pass the tenant explicitly, through
   `withTenant(ctx, …)` from `@rcln/db`. Importing the raw Prisma client is an
   eslint error.

The role split is what makes the first layer real. Postgres exempts a table's
owner from its own policies, so:

| Role         | Used by                | RLS      |
| ------------ | ---------------------- | -------- |
| `rcln_owner` | migrations, seeds      | bypassed |
| `rcln_app`   | api, worker at runtime | enforced |

Policies are `ENABLE`, not `FORCE` — the owner needs the bypass to migrate. The
risk that creates (someone pointing `DATABASE_URL` at the owner) is caught by
`assertRlsActive()`, which refuses to boot the API on an owner or superuser
connection. Loud at startup beats silent at query time. Session variables are set
with `set_config(..., true)`, which is transaction-local, so a pooled connection
can never carry one tenant's context into another's request.

These are three of the project's **seven invariants**; the other four — no JSON
arrays of foreign keys, time stored in UTC and shown in the clinic's zone, the
clinical record authored only by doctors, and the never-import-Prisma rule above —
are in [`CONTRIBUTING.md`](CONTRIBUTING.md), each backed by an
[architecture decision record](.kb/Architecture/decisions/README.md).

---

## Quick start

All you need is Docker (give it at least 6 GB of memory).

```bash
git clone https://github.com/tejasnirala/rcln.git
cd rcln
docker compose up
```

The first start takes 3–4 minutes; later ones about 15 seconds. When the api
reports healthy:

1. Open **http://lvh.me:3000/signup** and register a clinic. `lvh.me` and every
   subdomain of it resolve to `127.0.0.1`, so no hosts-file edits are needed.
2. You land on your clinic's own address — say `http://sunrise.lvh.me:3000` —
   and the setup wizard walks you through the rest.
3. Invite staff from the wizard or from **Members**. The invitations arrive in
   **Mailpit at http://localhost:8025**, which catches every outbound email in
   development and delivers none.

Everything else — other setup paths, every URL, troubleshooting — is below.

---

## Setup in depth

Pick one. **A** is recommended and needs nothing but Docker.

| Path                                          | Needs on your machine                  | Best for                                          |
| --------------------------------------------- | -------------------------------------- | ------------------------------------------------- |
| **A — Everything in Docker**                  | Docker only                            | Onboarding, matching CI, keeping a laptop clean   |
| **B — Hybrid** (apps native, infra in Docker) | Docker, Node 22+, pnpm                 | Day-to-day work; fastest reloads, native debugger |
| **C — Fully native**                          | Node 22+, pnpm, PostgreSQL 16, Redis 7 | No Docker at all                                  |

All three end at the same place: api on `:5000`, web on `:3000`, worker
consuming from Redis, database migrated and seeded.

### Path A — Everything in Docker

**Prerequisites:** Docker Desktop (or Docker Engine + Compose v2). Allocate at
least 6 GB of memory to Docker — the web container is capped at 3 GB and
Turbopack will use most of it during a cold compile.

**Environment (optional).** Compose supplies working defaults for every
variable, so the stack starts with no `.env` at all. Create one only to override
something:

```bash
cp .env.example .env
```

Compose **overrides** `DATABASE_URL`, `DIRECT_DATABASE_URL` and `REDIS_URL` with
container hostnames (`postgres`, `redis`) regardless of what `.env` says — the
values in `.env.example` point at `localhost` and are meant for paths B and C.

**Start:** `docker compose up`. On first run the stack:

1. builds the shared dev image (~2 min)
2. installs dependencies into a named volume
3. generates the Prisma client against the container's libc
4. builds the shared packages the apps import
5. creates the `rcln_owner` / `rcln_app` roles and the required extensions
6. applies migrations and the RLS policies
7. seeds the permission catalogue, the 12 system roles, setting definitions,
   the 3 subscription plans, the clinical vocabulary and consultation templates,
   the regulatory rule packs, and the super admin
8. verifies every tenant table is protected, builds the test database, then
   starts api, web and worker

**Verify:**

```bash
curl http://localhost:5000/api/v1/health/ready   # database + redis connected
open http://localhost:3000
```

Source is bind-mounted, so editing any file reloads the running service.

### Path B — Hybrid (recommended for daily development)

Infrastructure in Docker, apps on the host. Reloads are faster than Path A and
you can attach a native debugger.

**1 — Prerequisites**

```bash
node --version        # must be >= 22
corepack enable pnpm  # pnpm is pinned by packageManager — do not npm i -g pnpm
```

**2 — Clone and install**

```bash
git clone https://github.com/tejasnirala/rcln.git
cd rcln
pnpm install
```

**3 — Environment**

```bash
cp .env.example .env
```

The defaults work as-is for local development except `JWT_SECRET`, which is
validated at boot and must be at least 32 characters:

```bash
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

Those two database URLs **must stay different roles**. Pointing `DATABASE_URL`
at `rcln_owner` would silently disable tenant isolation, so the API refuses to
boot if you do — see `assertRlsActive()`.

**4 — Start infrastructure**

```bash
pnpm infra          # postgres + redis + mailpit only
```

Postgres runs `infra/postgres/init/01-roles-and-extensions.sql` on first boot,
which creates both roles and the `pgcrypto`, `pg_trgm`, `btree_gist` and
`citext` extensions.

**5 — Database**

```bash
pnpm db:generate    # Prisma client
pnpm db:migrate     # schema + RLS policies
pnpm db:seed        # permissions, roles, settings, plans, vocabulary, rule packs, super admin
pnpm db:rls:check   # fails if any tenant table lacks a policy
pnpm db:test:setup  # builds `rcl_testing`, the database the test suite writes to
```

The tests never touch `rcln`. `pnpm test` rewrites both database URLs to
`rcl_testing` — same server, same roles, different database — so a run cannot
bury the records you created in the browser. Re-run `pnpm db:test:setup` after
any migration (on Path A the `migrate` service does it on every start). Add
`--fresh` to drop and rebuild it — the right move after a setup that failed
halfway, because Prisma refuses to apply anything to a database holding a failed
migration record.

**6 — Run**

```bash
pnpm dev            # api :5000, web :3000, worker — all in watch mode
```

Single service instead: `pnpm dev:api`, `pnpm dev:web`, `pnpm dev:worker`.

### Path C — Fully native (no Docker)

Same as Path B, but you provide Postgres and Redis yourself.

```bash
# macOS
brew install postgresql@16 redis
brew services start postgresql@16
brew services start redis

# Debian / Ubuntu
sudo apt install postgresql-16 redis-server
sudo systemctl start postgresql redis-server
```

Then create the database and run the same role script Docker runs — the role
split is what makes RLS effective:

```bash
createdb rcln
psql -d rcln -f infra/postgres/init/01-roles-and-extensions.sql
```

That script needs superuser rights. On a default Homebrew install your own user
is one; on Linux use `sudo -u postgres psql -d rcln -f ...`. Both roles must
show `f` here:

```bash
psql -d rcln -c "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'rcln%';"
```

From there, follow Path B steps 2, 3, 5 and 6, skipping `pnpm infra`. Without
Docker there is no Mailpit, so set `EMAIL_PROVIDER=console` in `.env` and
outbound mail is logged instead of sent.

### Once it is running

| URL                                 | What                                                              |
| ----------------------------------- | ----------------------------------------------------------------- |
| http://lvh.me:3000                  | the public site: landing page, sign-up (`/signup`), clinic finder |
| http://&lt;slug&gt;.lvh.me:3000     | a clinic — its sign-in, setup wizard and the app itself           |
| http://admin.lvh.me:3000            | the platform console (super admin)                                |
| http://localhost:5000/docs          | the API reference — OpenAPI 3.1, every endpoint documented        |
| http://localhost:5000/api/v1/health | api liveness (`/health/ready` also checks Postgres and Redis)     |
| http://localhost:8025               | Mailpit — every outbound email in development (paths A and B)     |

- **Getting a clinic.** A fresh database has no clinics. Register one at
  `/signup`; you are taken to `http://<slug>.lvh.me:3000` and signed in as its
  owner.
- **Invitations and verification codes arrive in Mailpit.** The invitation token
  is shown to nobody else — the database holds only a digest — so Mailpit is
  where you open one. It delivers to nobody, so no address you type can receive
  a real message. Set `EMAIL_PROVIDER=console` to log messages instead.
- **The super admin** is `superadmin@rcln.local` with whatever
  `SUPERADMIN_PASSWORD` you set (default `ChangeMe!SuperAdmin1`). Sign in at
  `admin.lvh.me:3000` to manage clinics, platform taxes and the regulatory packs.
- **Tenant lookups are cached** in Redis for 5 minutes. After renaming or
  removing a clinic's domain by hand, clear it with
  `docker compose exec redis redis-cli DEL tenant:host:<slug>.lvh.me`.

### Troubleshooting

| Symptom                                                      | Cause and fix                                                                                                                                        |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| API exits with "Refusing to start: role … owns N RLS tables" | `DATABASE_URL` points at `rcln_owner`. Point it at `rcln_app`. This guard is deliberate — the alternative is silent loss of tenant isolation.        |
| `pnpm db:rls:check` fails                                    | A tenant table shipped without a policy. Add it to `packages/db/prisma/rls/enable-rls.sql` and re-run the migration.                                 |
| `P3014 … shadow database`                                    | `rcln_owner` lacks `CREATEDB`. Run `ALTER ROLE rcln_owner CREATEDB;`. Only `migrate dev` needs it; production uses `migrate deploy`, which does not. |
| Web container is killed, high CPU                            | Docker has too little memory. Give it ≥6 GB. The `mem_limit` values cap each service so one cannot starve the host.                                  |
| `pnpm typecheck` in the container ends in `exited (137)`     | The container ran out of memory compiling every package at once — not a type error. Use `npx turbo run typecheck --concurrency=2`.                   |
| Edits do not trigger a reload                                | Native fs events are not propagating. Start with `WATCH_POLL=true docker compose up`. Polling costs CPU, so leave it off unless you need it.         |
| `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`                 | pnpm run non-interactively without `CI=true`. The dev image sets it; if you hit this on the host, prefix the command with `CI=true`.                 |
| Port already in use                                          | Override per run: `API_PORT=5001 WEB_PORT=3001 DB_PORT=5433 docker compose up`.                                                                      |

Start completely fresh at any time:

```bash
docker compose down -v     # drops the database and all volumes
docker compose up
```

---

## Repository layout

```
apps/
  api/            Express 5 — tenant resolution, auth, RBAC, every domain module, the OpenAPI reference
  web/            Next.js 16 — public site, the clinic app, the platform console
  worker/         BullMQ — notifications, documents, billing, inventory sweeps, reports
packages/
  db/             Prisma schema (one file per domain), migrations, RLS policies, tenant-scoped client
  contracts/      Zod schemas shared by api and web — validation and inferred types
  permissions/    permission catalogue, the 12 system roles, effective-permission resolver
  clinical/       consultation engine: template resolution, sections, validation — pure logic
  regulatory/     "may this be done with this product, here, today?" — the rule-pack evaluator
  inventory/      the stock-ledger writer and unit/packaging conversion
  invoicing/      what a patient invoice comes to, line by line, and in what order
  tax/            may this issuer charge tax here, and at what rate
  billing/        the clinic's own rcln subscription: periods, upgrades, dunning
  payments/       talking to payment providers, and nothing about subscriptions
  documents/      how a document (invoice, receipt) is rendered — preview and PDF
  notifications/  the outbound-message seam shared by the api and the worker
  queue/          queue definitions both ends of every job agree on
  storage/        object storage behind one interface — local disk in dev, S3 in production
  config/         shared eslint and tsconfig presets
infra/
  postgres/       init SQL — the owner/app role split RLS depends on
  docker/         the dev image and its entrypoint
.kb/              all project documentation — see below
```

---

## Commands

The same workspace scripts exist on every path. On Path A prefix them with
`docker compose exec api`; on B and C run them directly.

| Task                      | Path A (Docker)                                                 | Paths B / C (host)                      |
| ------------------------- | --------------------------------------------------------------- | --------------------------------------- |
| Start everything          | `docker compose up`                                             | `pnpm infra` then `pnpm dev`            |
| One service               | `docker compose up api`                                         | `pnpm dev:api`                          |
| Follow logs               | `docker compose logs -f api`                                    | in the `pnpm dev` output                |
| Shell                     | `docker compose exec api sh`                                    | —                                       |
| Stop                      | `docker compose down`                                           | Ctrl-C, `pnpm infra:stop`               |
| Wipe the database         | `docker compose down -v`                                        | `pnpm db:reset --force`                 |
| Typecheck + lint + test   | `docker compose exec api pnpm validate`                         | `pnpm validate`                         |
| New migration             | `docker compose exec api pnpm db:migrate --name x`              | `pnpm db:migrate --name x`              |
| RLS enforcement check     | `docker compose exec api pnpm db:rls:check`                     | `pnpm db:rls:check`                     |
| API reference check       | `docker compose exec api pnpm --filter @rcln/api docs:validate` | `pnpm --filter @rcln/api docs:validate` |
| Prisma Studio             | `docker compose exec api pnpm db:studio`                        | `pnpm db:studio`                        |
| Re-seed                   | `docker compose exec api pnpm db:seed`                          | `pnpm db:seed`                          |
| Build the test database   | `docker compose exec api pnpm db:test:setup`                    | `pnpm db:test:setup`                    |
| Restore `rcln_app` grants | `docker compose exec api pnpm db:grants`                        | `pnpm db:grants`                        |
| Find an existing symbol   | `pnpm kb:find <name>`                                           | `pnpm kb:find <name>`                   |

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

1. Add the model, in the schema file for its domain under
   `packages/db/prisma/schema/`, with `organizationId` and
   `@@unique([organizationId, id])`.
2. `docker compose exec api pnpm db:migrate --name your_change`
3. Add the table to `packages/db/prisma/rls/enable-rls.sql`.
4. Append that policy SQL to the generated `migration.sql`.
5. `docker compose exec api pnpm db:rls:check` — it fails until the policy exists.
6. Add a case to `apps/api/tests/integration/tenant-isolation/`.

Step 5 is why the check exists: a missing policy throws no error and breaks no
single-tenant test. It just starts returning other clinics' records.

### Production images

Built from the repo root, one per app:

```bash
docker build -f apps/api/Dockerfile    -t rcln-api .
docker build -f apps/web/Dockerfile    -t rcln-web .
docker build -f apps/worker/Dockerfile -t rcln-worker .
```

`.dockerignore` cuts the build context from about 1 GB to under 2 MB, and
`pnpm deploy --prod --legacy` resolves the workspace symlinks into a
self-contained tree of only the dependencies each app actually reaches. Pruning
happens in the **build** stage — deleting files in the runtime stage leaves them
in the earlier layer and the image does not shrink.

---

## Documentation

**All project documentation lives in [`.kb/`](.kb/README.md)** — numbered
documents plus generated indexes of every symbol, endpoint, table and
permission, which a pre-push hook keeps from going stale.

| Read                                                                   | When                                                                   |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [`.kb/README.md`](.kb/README.md)                                       | Start here — the index                                                 |
| [`.kb/Architecture/how-it-works.md`](.kb/Architecture/how-it-works.md) | The running tour of the system                                         |
| [`.kb/STATUS.md`](.kb/STATUS.md)                                       | What is built and what is next — the honest ledger                     |
| [`.kb/Architecture/decisions/`](.kb/Architecture/decisions/README.md)  | The architecture decision records, before changing anything structural |
| [`.kb/Architecture/CONVENTIONS.md`](.kb/Architecture/CONVENTIONS.md)   | Before writing any code                                                |
| [`.kb/Architecture/PITFALLS.md`](.kb/Architecture/PITFALLS.md)         | When something behaves strangely                                       |
| [`.kb/Database/schema-design.md`](.kb/Database/schema-design.md)       | The full ERD, before touching the database                             |
| [`.kb/09_Roles_and_Permissions.md`](.kb/09_Roles_and_Permissions.md)   | Who may do what — the role × permission matrix                         |
| [`.kb/Architecture/architecture.md`](.kb/Architecture/architecture.md) | The **target** infrastructure — mostly not built yet                   |

Before writing a new function, component or schema, check it does not already
exist:

```bash
pnpm kb:find <name>        # add --export or --kind fn to narrow
```

Working with Claude Code? [`CLAUDE.md`](CLAUDE.md) is its briefing, and
`.claude/` holds the project's subagents and skills — including `/new-feature`,
`/db-migration`, `/api-integration`, `/code-review` and `/verify`.

---

## Status

Pre-1.0. Built and working end to end today:

- **Platform** — clinic sign-up and the setup wizard, sign-in by password or SMS
  code, branches, invitations, roles and members, per-record history, and the
  super-admin console with impersonation.
- **rcln's own billing** — subscriptions, payments, pro-rata upgrades,
  cancellation and recurring billing.
- **Front desk** — doctors, schedules and fees, patients, availability,
  appointments and the day board, vitals and follow-ups.
- **Clinical** — the full consultation engine: specialty templates, signing and
  amendment, prescriptions, body and dental charts, visit history and recall.
- **Pharmacy and stock** — catalogue, the stock ledger, procurement, dispensing,
  recalls and the India regulatory rule pack.
- **Patient billing** — GST invoices, credit notes and PDF documents.

Not yet: queue tokens and walk-ins, the lab module, outbound notifications to
patients, and usage limits per plan. [`.kb/STATUS.md`](.kb/STATUS.md) is the
living ledger and is always more current than this section; released versions
are in [`CHANGELOG.md`](CHANGELOG.md).

---

## Contributing

Issues and pull requests are welcome. Start with
[`CONTRIBUTING.md`](CONTRIBUTING.md) — it covers the seven invariants, the
schema-change sequence and what CI checks. Participation is governed by the
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
domain model (GST, HSN codes, ABHA, the CDSCO schedules) are implementation
details, not a claim of compliance or certification.
