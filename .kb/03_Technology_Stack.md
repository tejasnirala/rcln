# 03 · Technology Stack

**Version:** 1.0 · **All versions Verified** from `package.json` files at the
stated paths. Where a technology is _documented but absent_, it is marked.

---

## At a glance

| Layer               | Choice                        | Version                            |
| ------------------- | ----------------------------- | ---------------------------------- |
| Runtime             | Node                          | `>=22` (engines)                   |
| Language            | TypeScript                    | `5.9.3`                            |
| Package manager     | pnpm workspaces               | `10.18.2`                          |
| Build orchestration | Turbo                         | `^2.5.6`                           |
| API framework       | Express                       | `^5.2.1`                           |
| Web framework       | Next.js (App Router)          | `16.2.11`                          |
| UI runtime          | React / React DOM             | `19.2.4`                           |
| ORM                 | Prisma + `@prisma/adapter-pg` | `^7.2.0`                           |
| Database            | PostgreSQL                    | `16` (Docker `postgres:16-alpine`) |
| Cache / queue store | Redis                         | `7` (Docker `redis:7-alpine`)      |
| Queue               | BullMQ                        | `^5.61.0`                          |
| Validation          | Zod                           | pnpm `catalog:` — pinned centrally |
| Tests               | Jest + ts-jest + supertest    | `jest`, `supertest`                |
| Container           | Docker Compose                | Compose v2                         |

---

## Backend — `apps/api`

**Verified.**

| Package              | Version               | Role                                                                    |
| -------------------- | --------------------- | ----------------------------------------------------------------------- |
| `express`            | `^5.2.1`              | HTTP framework                                                          |
| `helmet`             | `^8.1.0`              | Security headers. Also a route-scoped CSP for `/docs`                   |
| `cors`               | `^2.8.5`              | Dynamic per-tenant origin check against the root domain                 |
| `compression`        | `^1.8.1`              | Response compression                                                    |
| `express-rate-limit` | `^8.2.1`              | Rate limiting                                                           |
| `rate-limit-redis`   | `^4.2.3`              | Redis store — the default memory store would not survive two containers |
| `ioredis`            | `^5.9.0`              | Redis client                                                            |
| `jsonwebtoken`       | `^9.0.3`              | Access-token signing and verification                                   |
| `@node-rs/argon2`    | `^2.0.2`              | **Argon2id** password hashing — native, not pure-JS bcrypt              |
| `otplib`             | `^12.0.1`             | TOTP. **Installed; no MFA flow is built**                               |
| `pino` + `pino-http` | `^9.13.1` / `^11.0.0` | Structured logging with PII redaction                                   |
| `dotenv`             | `^17.2.3`             | Config loading                                                          |
| `zod`                | catalog               | Boundary validation                                                     |

Dev: `jest`, `ts-jest`, `supertest`, `tsx`, `pino-pretty`, `pg`, `eslint`,
`prettier`, `typescript`.

API documentation: `@scalar/express-api-reference` renders `/docs`;
`@scalar/api-reference` is a dependency for its prebuilt browser bundle, which is
served from `/docs/assets` rather than a CDN so the page survives helmet's
production CSP and an air-gapped network. `@scalar/openapi-parser` (dev) checks
the generated document against the specification.

**Notable absences:** no OpenTelemetry; no Sentry.

---

## Frontend — `apps/web`

**Verified.**

| Package                                              | Version    | Role                                                                                      |
| ---------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------- |
| `next`                                               | `16.2.11`  | App Router. `middleware.ts` is renamed **`proxy.ts`**; the `eslint` config key is removed |
| `react` / `react-dom`                                | `19.2.4`   | UI runtime                                                                                |
| `tailwindcss` + `@tailwindcss/postcss`               | dev        | Styling                                                                                   |
| `class-variance-authority`, `clsx`, `tailwind-merge` | —          | Class composition                                                                         |
| `react-hook-form` + `@hookform/resolvers`            | `^7.64.0`  | Forms, wired to Zod contracts                                                             |
| `@tanstack/react-query`                              | `^5.90.4`  | Client data cache                                                                         |
| `@tanstack/react-table`                              | `^8.21.3`  | Tables                                                                                    |
| `recharts`                                           | `^2.15.4`  | Charts                                                                                    |
| `lucide-react`                                       | `^0.545.0` | Icons                                                                                     |
| `sonner`                                             | `^2.0.7`   | Toasts                                                                                    |
| `date-fns`                                           | `^4.1.0`   | Dates                                                                                     |
| `tw-animate-css`                                     | dev        | Animation utilities                                                                       |
| `zod`                                                | catalog    | Shared contracts                                                                          |

**Verified:** `apps/web` does **not** depend on `@rcln/db`. The web tier has no
database access.

**Not used despite being in the target design:** shadcn/ui.
`apps/web/src/components/ui/` contains three hand-written components
(`button`, `field`, `alert`), extracted from duplication rather than generated.

The design system lives in one file: `apps/web/src/app/globals.css` —
surgical-green palette, IBM Plex display/sans/mono with mono reserved for
identifiers, and a spacing and radius scale. `apps/web/AGENTS.md` records the
accessibility rules every screen inherits.

---

## Worker — `apps/worker`

**Verified.** `bullmq` `^5.61.0`, `ioredis`, `pino`, `dotenv`, plus the three
workspace packages.

**Verified:** queues are registered in `apps/worker/src/queues.ts`. **No
processors exist.** A job enqueued today is accepted and never consumed.

---

## Data — `packages/db`

**Verified.**

| Package              | Version   | Role                     |
| -------------------- | --------- | ------------------------ |
| `@prisma/client`     | `^7.2.0`  | Generated client         |
| `@prisma/adapter-pg` | `^7.2.0`  | Driver adapter over `pg` |
| `pg`                 | `^8.17.1` | Postgres driver          |

Exports three entry points: `@rcln/db` (the tenant-scoped client — the only one
you should import), `@rcln/db/unsafe` (the audited escape hatch), and
`@rcln/db/generated` (re-exported types).

**Verified:** no PgBouncer. The target design specifies transaction-mode pooling;
the app connects directly.

---

## Shared packages

| Package             | Dependencies | Purpose                                                                                                                                                     |
| ------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@rcln/contracts`   | `zod` only   | Zod schemas + inferred types, shared by api and web                                                                                                         |
| `@rcln/permissions` | **none**     | Permission catalogue, 12 system roles, pure resolver. Zero runtime dependencies is deliberate — it lets 25 unit tests pin the whole matrix with no database |
| `@rcln/config`      | —            | eslint and tsconfig presets                                                                                                                                 |

Packages build to `dist/` and are consumed from there. A consumer needs the
package built; the dev entrypoint does this on boot.

---

## Database

**Verified.** PostgreSQL 16. Features the schema actively depends on:

- **Row-level security** — `ENABLE`, deliberately not `FORCE`
- **`set_config(…, true)`** — transaction-local session variables
- **Composite unique constraints** for composite foreign keys
- **`NULLS NOT DISTINCT`** indexes — plain unique indexes do not constrain NULLs
- **Triggers** — one prevents a tenant shadowing a system role code
- **PL/pgSQL** — the RLS policies are generated by `DO $$ … $$` loops

**Role split**, provisioned by `infra/postgres/init/01-roles-and-extensions.sql`:

| Role         | RLS                          | Used by                                   |
| ------------ | ---------------------------- | ----------------------------------------- |
| `rcln_app`   | **Enforced** (`NOBYPASSRLS`) | api, worker at runtime — `DATABASE_URL`   |
| `rcln_owner` | Bypassed (table owner)       | migrations, seeds — `DIRECT_DATABASE_URL` |

If these are ever the same role, Postgres silently skips every policy and tenant
isolation becomes a no-op. `assertRlsActive()` refuses to boot on an owner
connection for exactly this reason.

Schema: 32 models, 18 enums, 14 RLS-protected tables.
Detail: [`04_Database_Schema.md`](04_Database_Schema.md) ·
[`Database/_index.md`](Database/_index.md) ·
[`Database/schema-design.md`](Database/schema-design.md).

---

## Authentication mechanisms

**Verified.**

| Mechanism         | Implementation                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password hashing  | Argon2id via `@node-rs/argon2`                                                                                                                          |
| Access token      | JWT, 15 min default, HS256 via `jsonwebtoken`. Claims are short keys (`sub`, `sid`, `pa`, `mid`, `oid`, `bid`, `imp`) because it rides on every request |
| Refresh token     | Opaque 256-bit random, stored **only** as a SHA-256 hash in `sessions.refresh_token_hash`. Rotated on use; replaying a rotated token revokes the family |
| OTP               | Numeric, configurable length, hashed at rest, single-use, attempt-capped                                                                                |
| Invitation token  | Same treatment as a refresh token — hashed, single-use                                                                                                  |
| Session transport | httpOnly, **host-only** cookies set by Next. No `domain` attribute                                                                                      |
| Lockout           | 5 failed attempts                                                                                                                                       |
| MFA               | **Not built.** `otplib` is installed                                                                                                                    |
| SSO               | **Not built.** `user_identities` table exists                                                                                                           |

Never in the token: the permission list. It is resolved per request from
`membership_roles`, cached in Redis.

---

## Third-party services

**Verified as configured-but-inert.** Every adapter falls back to a console stub
when the key is blank, and every key is blank.

| Service                     | Env prefix                    | State                                                |
| --------------------------- | ----------------------------- | ---------------------------------------------------- |
| AWS S3 (`ap-south-1`)       | `S3_*`                        | Not integrated. `StoredFile` model only              |
| Razorpay                    | `RAZORPAY_*`                  | Not integrated                                       |
| WhatsApp (Meta Cloud / BSP) | `WHATSAPP_*`                  | `console` provider                                   |
| SMS (MSG91)                 | `SMS_*`                       | `console` provider. Blocked on TRAI DLT registration |
| Email (SMTP → AWS SES)      | `EMAIL_*`, `SMTP_*`, `SES_*`  | **Sending** via nodemailer. Mailpit locally          |
| Sentry                      | `SENTRY_DSN`                  | Not integrated                                       |
| OpenTelemetry               | `OTEL_EXPORTER_OTLP_ENDPOINT` | Not integrated                                       |

Detail: [`13_Integration_Guide.md`](13_Integration_Guide.md).

---

## Tooling

**Verified.**

| Concern        | Tool                                                                          |
| -------------- | ----------------------------------------------------------------------------- |
| Monorepo       | pnpm workspaces + Turbo                                                       |
| Formatting     | Prettier, on commit via lint-staged                                           |
| Linting        | ESLint 9 flat config, per package                                             |
| Commits        | commitlint (conventional) + commitizen                                        |
| Hooks          | Husky — commit-msg, pre-commit, pre-push                                      |
| CI             | GitHub Actions, two jobs                                                      |
| Local stack    | Docker Compose — api, web, worker, postgres, redis, mailpit                   |
| Knowledge base | `.kb/generate.mjs`, using the TypeScript compiler API — **no new dependency** |

---

## Version constraints worth knowing

- **Node `>=22`, pnpm `>=10`** are enforced by `engines`.
- **TypeScript is strict**, including `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. Array access yields `T | undefined`; you cannot
  pass `{ key: undefined }` where the property is optional.
- **ESM throughout.** Relative imports need the `.js` extension even from `.ts`
  source. Jest needs `NODE_OPTIONS=--experimental-vm-modules`.
- **Zod is pinned via the pnpm `catalog:`** so api, web and contracts cannot
  drift onto different majors.
- **Next.js 16 renamed `middleware.ts` → `proxy.ts`** and removed the `eslint`
  config key. Read `node_modules/next/dist/docs/` before writing Next code.
