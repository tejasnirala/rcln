# 14 · Configuration Reference

**Version:** 1.0 · **Verified** from `.env.example`, `apps/api/src/config/index.ts`,
`docker-compose.yml` and `.github/workflows/ci.yml`.

---

## How configuration loads

**Verified.** There is **one `.env` at the repository root**. Each app runs with
its own working directory, so `apps/api/src/config/index.ts` resolves the path
explicitly rather than relying on `process.cwd()`:

```ts
loadEnv({ path: new URL('../../../../.env', import.meta.url).pathname });
```

CI writes a `.env` for the same reason. If you add an app, it must resolve the
root `.env` the same way.

Access config through the exported `config` object, never `process.env`
directly — that is where the validation lives.

---

## Fail-fast validation

**Verified** in `apps/api/src/config/index.ts`. The process refuses to start
rather than running misconfigured. Four checks:

| Check                                                             | Behaviour                                      |
| ----------------------------------------------------------------- | ---------------------------------------------- |
| Any required variable missing                                     | `Missing required environment variable: <KEY>` |
| A numeric variable that is not a number                           | `Environment variable <KEY> must be a number`  |
| `JWT_SECRET` shorter than 32 characters                           | Throws                                         |
| `JWT_SECRET` still contains `change-me` **in production**         | Throws — "generate one before deploying"       |
| `DATABASE_URL` looks like an owner or superuser **in production** | Throws — "RLS would be bypassed"               |

The last one is a cheap string check; `assertRlsActive()` does the authoritative
check against the live connection at boot. Two independent guards on the same
catastrophic misconfiguration, which is proportionate.

---

## Environment variables

Every variable in `.env.example`, grouped as the file groups them.

### Server

| Variable   | Default       | Required | Notes                                           |
| ---------- | ------------- | -------- | ----------------------------------------------- |
| `NODE_ENV` | `development` | no       | `production` switches on the extra guards above |
| `PORT`     | `5000`        | no       |                                                 |
| `HOST`     | `0.0.0.0`     | no       |                                                 |

### Tenancy

| Variable                  | Default              | Required | Notes                                                                                                                                                                                                                  |
| ------------------------- | -------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ROOT_DOMAIN`             | `lvh.me`             | no       | Tenant subdomains hang off this. `lvh.me` and any subdomain resolve to `127.0.0.1` publicly, so local multi-tenant routing needs no `/etc/hosts` edit                                                                  |
| `WEB_URL`                 | `http://lvh.me:3000` | no       |                                                                                                                                                                                                                        |
| `API_URL`                 | —                    | no       |                                                                                                                                                                                                                        |
| `API_INTERNAL_URL`        | `http://api:5000`    | no       | **How the web container reaches the API inside the compose network.** Server Actions use it; the browser never sees it                                                                                                 |
| `NEXT_PUBLIC_API_URL`     | —                    | no       | How a **browser** reaches the API. **Not interchangeable with the above** — pointing at localhost inside the web container means the web container. Same string, different machine: it typechecks and fails at runtime |
| `NEXT_PUBLIC_ROOT_DOMAIN` | `lvh.me`             | no       | Client-side copy of the root domain                                                                                                                                                                                    |

### Database

| Variable              | Required                  | Notes                                                                                                            |
| --------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`        | **yes**                   | The **app** role — `rcln_app`. RLS **enforced**. Used by api and worker at runtime                               |
| `DIRECT_DATABASE_URL` | **yes** for migrations    | The **owner** role — `rcln_owner`. RLS **bypassed**. Migrations, seeds and `db:rls:check` only                   |
| `DATABASE_POOL_SIZE`  | no, default `10`          |                                                                                                                  |
| `TEST_DATABASE_NAME`  | no, default `rcl_testing` | The database the test suite runs against. Only the NAME — host, port and roles are taken from the two URLs above |

> **The tests do not run against the development database.** `apps/api/tests/setup-env.ts`
> rewrites both URLs above to `rcl_testing` before any module loads, and moves the
> cache onto Redis logical database 2, so a run cannot bury the records a human
> created in the browser or flush the dev server's rate limiters. Build it with
> `pnpm db:test:setup` — the `migrate` compose service does that on every
> `docker compose up`, which is what keeps it from falling a migration behind.

> **These must be different roles.** If the app connects as the table owner,
> Postgres silently skips every RLS policy and tenant isolation becomes a no-op
> with no error and no log line. This is the single most dangerous
> misconfiguration in the system.

### Redis

| Variable         | Default                  | Notes                                                            |
| ---------------- | ------------------------ | ---------------------------------------------------------------- |
| `REDIS_URL`      | `redis://localhost:6379` | Cache, rate limits, locks, BullMQ                                |
| `REDIS_CACHE_DB` | `0`                      | Should be `allkeys-lru`                                          |
| `REDIS_QUEUE_DB` | `1`                      | Must be **`noeviction`** — evicting a job is a lost notification |

### Auth

| Variable                       | Default        | Notes                                                                                                                                                                                                                                                                                                                            |
| ------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`                   | — **required** | ≥32 chars. `openssl rand -base64 48`                                                                                                                                                                                                                                                                                             |
| `JWT_ACCESS_TOKEN_EXPIRES_IN`  | `15m`          | Short because a stateless token cannot be revoked                                                                                                                                                                                                                                                                                |
| `JWT_REFRESH_TOKEN_EXPIRES_IN` | `30d`          |                                                                                                                                                                                                                                                                                                                                  |
| `OTP_LENGTH`                   | `6`            |                                                                                                                                                                                                                                                                                                                                  |
| `OTP_TTL_SECONDS`              | `300`          |                                                                                                                                                                                                                                                                                                                                  |
| `OTP_MAX_ATTEMPTS`             | `5`            |                                                                                                                                                                                                                                                                                                                                  |
| `VERIFICATION_TTL_SECONDS`     | `900`          | Email/phone verification codes. Longer than an OTP — it has to survive a mail queue                                                                                                                                                                                                                                              |
| `DEV_MASTER_VERIFICATION_CODE` | `123456`       | ⚠️ **Development only.** Confirms any email address or phone number, because neither SES nor TRAI DLT can deliver a real code yet. Never read when `NODE_ENV=production`, and the API **refuses to boot** if it is set there. Does **not** log anyone in — only `/auth/verify/*` consults it. Delete it when a real sender lands |

### CORS

| Variable       | Default                                    | Notes                                                                                                                                                                                                                   |
| -------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CORS_ORIGINS` | `http://localhost:3000,http://lvh.me:3000` | The **static** allowlist, for local dev and the marketing site. Per-tenant origins are validated dynamically: any subdomain of `ROOT_DOMAIN` is allowed and the tenant's actual existence is settled by `resolveTenant` |

### Rate limiting

| Variable                       | Default  | Notes           |
| ------------------------------ | -------- | --------------- |
| `RATE_LIMIT_WINDOW_MS`         | `900000` | 15 minutes      |
| `RATE_LIMIT_MAX_REQUESTS`      | `100`    | General limiter |
| `RATE_LIMIT_AUTH_MAX_REQUESTS` | `10`     | Auth endpoints  |

### Logging

| Variable    | Default | Notes                                                                 |
| ----------- | ------- | --------------------------------------------------------------------- |
| `LOG_LEVEL` | `debug` | pino. Redaction paths are in `apps/api/src/utils/logger.ts`, not here |

### Super admin seed

| Variable              | Notes                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `SUPERADMIN_EMAIL`    | Used **once** by `pnpm db:seed`                                                              |
| `SUPERADMIN_PASSWORD` | **Change before any real deploy.** This account holds all 83 permissions across every tenant |
| `SUPERADMIN_NAME`     |                                                                                              |

### Third-party — all blank, all stubbed

Leave blank locally; every adapter falls back to a console stub.

| Group          | Variables                                                                           |
| -------------- | ----------------------------------------------------------------------------------- |
| Object storage | `S3_REGION` (`ap-south-1`), `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` |
| Payments       | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`                 |
| WhatsApp       | `WHATSAPP_PROVIDER` (`console`), `WHATSAPP_API_KEY`, `WHATSAPP_PHONE_NUMBER_ID`     |
| SMS            | `SMS_PROVIDER` (`console`), `SMS_API_KEY`, `SMS_SENDER_ID`, `SMS_DLT_ENTITY_ID`     |
| Email          | `EMAIL_PROVIDER` (`console`), `EMAIL_FROM`, `SES_REGION` (`ap-south-1`)             |
| Observability  | `SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT`                                         |

---

## Configuration files

| File                              | Purpose                                                    |
| --------------------------------- | ---------------------------------------------------------- |
| `.env`                            | **Gitignored.** The only place real values live locally    |
| `.env.example`                    | The committed template. No real values                     |
| `docker-compose.yml`              | Local stack; sets `API_INTERNAL_URL` for the web container |
| `turbo.json`                      | Task graph and caching                                     |
| `pnpm-workspace.yaml`             | Workspace globs and the dependency `catalog:`              |
| `tsconfig.base.json`              | Strict TypeScript, extended by every package               |
| `commitlint.config.js`            | Conventional commits                                       |
| `.prettierrc` / `.prettierignore` | Formatting. The generated `.kb` output is ignored          |
| `packages/db/prisma.config.ts`    | Prisma config                                              |
| `apps/*/jest.config.ts`           | Test config. The api one pins **one worker** deliberately  |
| `apps/web/next.config.ts`         | Next config, including `allowedDevOrigins`                 |
| `.claude/settings.json`           | Agent permissions and hooks                                |

---

## Feature flags

**None exist.** There is no flag system, no `LaunchDarkly`, no Unleash, no
database-backed toggles. `architecture.md` suggests Unleash or PostHog flags
later.

The nearest thing today is the `*_PROVIDER=console` pattern, which selects a
stub adapter rather than toggling a feature.

---

## Runtime settings

**Verified.** `SettingDefinition` and `SettingValue` exist in the schema, scoped
by `(scope_type, scope_id)` rather than by `organization_id` — which is why they
are RLS-exempt. **12 setting definitions are seeded.**

There is **no settings UI and no service reading them.** The mechanism exists;
nothing uses it yet.

**Never put gateway credentials or any secret in `setting_values`** — that is
called out explicitly in the architecture document.

---

## Browser-held preferences

Two cookies configure the interface itself. They are the only configuration that
lives on the device rather than in the environment or the database.

| Cookie            | Values                                                | Default    |
| ----------------- | ----------------------------------------------------- | ---------- |
| `rcln_appearance` | `light` · `dark` · `system`                           | `light`    |
| `rcln_accent`     | `surgical` · `ember` · `indigo` · `plum` · `graphite` | `surgical` |

Defined in `apps/web/src/lib/theme.ts`. One year, `Path=/`, `SameSite=Lax`,
`Secure` off plain http, **host-only — no `Domain`**, so a clinic's preference
stays on that clinic's subdomain exactly as its session does. Anything not on the
list resolves to the default rather than throwing; a hand-edited cookie gives you
the light surgical theme, not a 500 on every page.

They are written entirely in the browser and read by a blocking inline script
before the first paint. **There is no environment variable, no database column
and no API endpoint for either** — see
[ADR-0017](Architecture/decisions/0017-theme-is-a-device-preference.md) for why a
theme is a property of the device and not of the user or the organization.

⚠️ **Deliberately not `httpOnly`**, unlike the session cookies, because the boot
script must read them before React exists. Safe here and only here: each value is
one word from a closed list, validated on both sides, never interpolated into
markup or SQL, and it authorises nothing. Do not copy the pattern for anything
the server trusts.

The defaults are load-bearing, not arbitrary. `light` rather than `system` means
a clinic that never opens the screen does not have its interface turn dark
overnight because a laptop is in dark mode; `surgical` is the palette the product
shipped with, unchanged to the byte, so the default reproduces today's screens
exactly.

---

## Adding a variable

1. Add it to `.env.example` in the right group, with a comment explaining what
   breaks without it and a safe default.
2. Read it through `config` in `apps/api/src/config/index.ts`, using
   `getEnvVar` / `getEnvNumber` so a missing or malformed value fails at boot
   rather than at 3am.
3. If it is required in production, add a guard next to the existing
   `JWT_SECRET` and `DATABASE_URL` checks.
4. Add it to the CI `.env` block in `.github/workflows/ci.yml` if tests need it.
5. Add it to `docker-compose.yml` if a container needs it.
6. Add the row to this file.

**Never commit a real value.** A `PreToolUse` hook blocks agent edits to `.env`
files, and `.claude/settings.json` denies reading them.
