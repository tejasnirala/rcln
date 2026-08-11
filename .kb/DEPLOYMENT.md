# Deployment

How to get rcln onto a public URL with a working demo tenant.

> **Status of this document.** Written by reading `docker-compose.yml`, the three
> production Dockerfiles, `infra/postgres/init/01-roles-and-extensions.sql` and
> `apps/api/src/config/index.ts`. **None of it has been executed.** The compose
> file in §5 is derived from the existing dev compose and the production
> Dockerfiles; it is not smoke-tested. Treat the boot guards in §3 as verified
> (they are quoted from source) and the platform steps as a plan.

---

## 1. Why not Vercel or Netlify

Both host one thing well: a Next.js app with serverless functions. This
repository is three long-lived processes plus two stateful services.

| Piece         | What it needs                                         | Vercel / Netlify   |
| ------------- | ----------------------------------------------------- | ------------------ |
| `apps/web`    | Next.js 16 server, Node runtime proxy                 | ✅ fits            |
| `apps/api`    | Express 5, persistent Redis + Postgres pools          | ⚠️ possible, badly |
| `apps/worker` | BullMQ consumer, runs forever, no HTTP surface        | ❌ impossible      |
| Postgres 16   | `CREATE ROLE`, 4 extensions, two-role ownership split | ❌ not offered     |
| Redis         | `noeviction`, AOF, BullMQ queues                      | ❌ not offered     |

The worker is the hard stop. A BullMQ consumer is a process that sleeps on a
Redis connection; there is no request to trigger a function invocation. The
hourly subscription sweep and the dunning ladder simply never run.

So: **containers**. All three Dockerfiles already exist and already build.

You _could_ split — `apps/web` on Vercel, everything else on a container host —
and it would work, because the web app talks to the API over HTTP anyway. It
buys you nothing except a second dashboard and a cross-origin cookie problem,
since sessions are host-only httpOnly cookies set by the Next proxy.

---

## 2. What must be true wherever you deploy

Four requirements. A platform that fails any of them is the wrong platform.

### 2.1 Wildcard DNS and wildcard TLS

`apps/web/src/proxy.ts` resolves the tenant from the `Host` header:

```
rcln.yourdomain.com          → marketing site
alpha.yourdomain.com         → tenant `alpha`, rewritten to /t/alpha
admin.yourdomain.com         → platform console
```

**You need a real domain.** `*.vercel.app` and `*.onrender.com` subdomains
cannot host sub-subdomains, and no free tier issues you a wildcard certificate.
A `.com` is roughly ₹1,000/year; a `.xyz` or `.site` is under ₹300 for the first
year and works identically.

You do not strictly need a _wildcard_ cert if you only ever demo two or three
tenants — naming the hostnames explicitly is simpler and avoids the DNS-01
challenge entirely. See §5.3.

### 2.2 Postgres you control at the role level

`infra/postgres/init/01-roles-and-extensions.sql` creates two roles and this
split is the entire tenant-isolation story (ADR-0003):

- `rcln_owner` — owns every table, runs migrations, **bypasses RLS**
- `rcln_app` — owns nothing, what the API connects as, **RLS enforced**

Plus four extensions: `pgcrypto`, `pg_trgm`, `btree_gist`, `citext`.
`btree_gist` is not optional — the appointment overlap constraint does not
exist without it.

A managed Postgres that will not let you `CREATE ROLE` and `ALTER SCHEMA public
OWNER TO` is unusable here. Neon and Supabase both let you run this SQL, but
their default owner role differs from a vanilla superuser, so expect to adapt
the script. A Postgres container you run yourself has none of that friction.

### 2.3 Redis with `noeviction`

Compose sets `--maxmemory-policy noeviction` deliberately: an evicted BullMQ job
is a lost renewal charge. Upstash's free tier evicts. Run your own Redis
container, or check the policy is configurable.

### 2.4 A migration step that runs as the owner, once, before the API starts

The API refuses to boot against an un-migrated database, and
`assertRlsActive()` (`packages/db/src/client.ts:61`) refuses to boot if its own
connection turns out to bypass RLS. Both are deliberate. §6 has the ordering.

---

## 3. The four production boot guards — read this before you debug anything

Setting `NODE_ENV=production` switches on five fatal checks in
`apps/api/src/config/index.ts`. Each one throws at startup with a clear message.
They exist because every one of them is a failure that is otherwise silent.

| Guard                                                                   | Source                | What it means for your demo                           |
| ----------------------------------------------------------------------- | --------------------- | ----------------------------------------------------- |
| `JWT_SECRET` contains `change-me`, or is under 32 chars                 | `config/index.ts:39`  | `openssl rand -base64 48`                             |
| `DEV_MASTER_VERIFICATION_CODE` is set at all                            | `config/index.ts:54`  | **Do not set it.** No `123456` shortcut in production |
| `DATABASE_URL` mentions `rcln_owner` or `//postgres:`                   | `config/index.ts:62`  | Runtime URL must be the `rcln_app` role               |
| `SMTP_HOST` is mailpit / localhost / `127.*` with `EMAIL_PROVIDER=smtp` | `config/index.ts:324` | You need a real relay, or `EMAIL_PROVIDER=console`    |
| `PAYMENT_PROVIDER=mock`                                                 | `config/index.ts:331` | **This is the one that will bite you.** See below     |

### 3.1 The payments problem, and the exact way through it

The mock provider is refused in production because a deployment quietly running
it reports every subscription as paid while collecting nothing. Correct
behaviour — and inconvenient, because a portfolio demo has no acquirer account.

Three ways out, in order of how much I'd recommend them:

**(a) Razorpay test keys — the intended path.** The guard refuses `mock`, not a
sandbox. Sign up at Razorpay, take the test keys, and set:

```
PAYMENT_PROVIDER=razorpay
RAZORPAY_KEY_ID=rzp_test_xxxxxxxx
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...      # from Settings → Webhooks, NOT the API secret
RAZORPAY_ENVIRONMENT=sandbox     # ⚠️ MUST be set explicitly — see below
```

⚠️ **`RAZORPAY_ENVIRONMENT` defaults to `production` when `NODE_ENV=production`**
(`config/index.ts:274`), and `assertKeyMatchesEnvironment`
(`razorpay.ts:1536`) refuses to boot when a `rzp_test_` key meets
`environment: production`. So you must set it to `sandbox` by hand. Forget it
and the API dies at startup with a message about key prefixes.

The webhook secret has **no fallback to the API secret** and a blank one fails
the boot. Point the Razorpay webhook at
`https://api.yourdomain.com/api/v1/webhooks/payments/razorpay` (confirm the
exact path against `apps/api/src/routes/v1`) and subscribe the nine events
listed in `.env.example`.

**(b) Leave `NODE_ENV` unset on the API container.** Everything works, the mock
sandbox page is clickable, and the whole subscription lifecycle demos end to
end with no gateway account. The cost: you also lose the other four guards, and
`DEV_MASTER_VERIFICATION_CODE` becomes live on a public host — which is a real
authentication backdoor for email/phone _verification_ (not login).

This is a legitimate choice for a throwaway demo with fake data, but it is a
choice, not a shortcut. If you take it, do not describe the deployment as
production in an interview. I would only do this if (a) is blocking you for
more than an afternoon.

**(c) Write a `sandbox` provider** that is the mock with a different name. Don't.
That defeats a guard you deliberately built, and it's the sort of thing a
reviewer notices.

### 3.2 Email

`EMAIL_PROVIDER=console` logs invitation links instead of sending them, and is
allowed in production. That's fine for a demo where you're the only user — but
invitations become uncopyable for anyone else, which kills the most interesting
flow to show off.

Resend or Postmark free tiers take about ten minutes, want a verified domain,
and turn `SMTP_HOST`/`SMTP_USER`/`SMTP_PASSWORD` into real values. Worth it.

---

## 4. Platform choice

| Option                                           | Cost/mo   | Fits?                                                     |
| ------------------------------------------------ | --------- | --------------------------------------------------------- |
| **VPS + docker compose** (Hetzner, DigitalOcean) | ~₹450–900 | ✅ Best fit. Closest to dev, everything in one file       |
| **Railway**                                      | ~$5–20    | ✅ Postgres + Redis + 3 Docker services, wildcard domains |
| **Render**                                       | ~$0–21    | ⚠️ Free tier sleeps; Redis is a paid add-on               |
| **Fly.io**                                       | ~$5–15    | ⚠️ Works, but Postgres is unmanaged and you own backups   |

**Recommendation: a single VPS.** The repo is already a compose file. A 2 GB
Hetzner CX22 runs all five containers with room to spare, you get one `.env` and
one `docker compose up -d`, and nothing about the deployment differs from what
you already debug locally. Railway is the answer if you'd rather not own a
server, at roughly double the price and with per-service env var editing.

The rest of this doc takes the VPS path. §7 sketches Railway.

---

## 5. VPS deployment

### 5.1 Server prep

```bash
# On a fresh Ubuntu 24.04 box, as root
adduser rcln && usermod -aG sudo rcln
apt update && apt install -y docker.io docker-compose-v2 git
usermod -aG docker rcln

# Lock it down — Postgres and Redis must NOT be reachable from the internet
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable
```

The compose file below deliberately publishes **no** database or Redis ports.
Only Caddy binds to the host.

### 5.2 DNS

At your registrar, two A records pointing at the server IP:

```
@       A    203.0.113.10
*       A    203.0.113.10
```

The wildcard is what makes `alpha.yourdomain.com` and `admin.yourdomain.com`
resolve without a record each.

### 5.3 `compose.prod.yml`

Place at the repo root on the server. **Untested — expect to iterate.**

```yaml
name: rcln-prod

x-app-env: &app-env
  NODE_ENV: production
  DATABASE_URL: postgresql://rcln_app:${APP_DB_PASSWORD}@postgres:5432/rcln?schema=public
  REDIS_URL: redis://redis:6379
  ROOT_DOMAIN: ${ROOT_DOMAIN}
  JWT_SECRET: ${JWT_SECRET}
  LOG_LEVEL: info

services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${DB_ROOT_PASSWORD}
      POSTGRES_DB: rcln
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./infra/postgres/init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U postgres -d rcln']
      interval: 5s
      retries: 10
    networks: [rcln]

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: redis-server --appendonly yes --maxmemory-policy noeviction
    volumes:
      - redisdata:/data
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
    networks: [rcln]

  # Runs to completion, then the API starts. See §6 for what it must do.
  migrate:
    build: { context: ., dockerfile: apps/api/Dockerfile }
    environment:
      <<: *app-env
      DIRECT_DATABASE_URL: postgresql://rcln_owner:${OWNER_DB_PASSWORD}@postgres:5432/rcln?schema=public
    command: ['sh', '-c', 'echo "run migrations manually — see §6"']
    depends_on:
      postgres: { condition: service_healthy }
    restart: 'no'
    networks: [rcln]

  api:
    build: { context: ., dockerfile: apps/api/Dockerfile }
    restart: unless-stopped
    environment:
      <<: *app-env
      PORT: '5000'
      WEB_URL: https://${ROOT_DOMAIN}
      API_URL: https://api.${ROOT_DOMAIN}
      CORS_ORIGINS: https://${ROOT_DOMAIN},https://admin.${ROOT_DOMAIN}
      PAYMENT_PROVIDER: razorpay
      PAYMENTS_WEBHOOK_BASE_URL: https://api.${ROOT_DOMAIN}
      RAZORPAY_KEY_ID: ${RAZORPAY_KEY_ID}
      RAZORPAY_KEY_SECRET: ${RAZORPAY_KEY_SECRET}
      RAZORPAY_WEBHOOK_SECRET: ${RAZORPAY_WEBHOOK_SECRET}
      RAZORPAY_ENVIRONMENT: sandbox
      EMAIL_PROVIDER: ${EMAIL_PROVIDER:-console}
      EMAIL_FROM: ${EMAIL_FROM}
      SMTP_HOST: ${SMTP_HOST}
      SMTP_PORT: ${SMTP_PORT}
      SMTP_USER: ${SMTP_USER}
      SMTP_PASSWORD: ${SMTP_PASSWORD}
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    networks: [rcln]

  web:
    build: { context: ., dockerfile: apps/web/Dockerfile }
    restart: unless-stopped
    environment:
      NODE_ENV: production
      PORT: '3000'
      API_INTERNAL_URL: http://api:5000
      NEXT_PUBLIC_ROOT_DOMAIN: ${ROOT_DOMAIN}
      NEXT_PUBLIC_API_URL: https://api.${ROOT_DOMAIN}
      NEXT_PUBLIC_SITE_URL: https://${ROOT_DOMAIN}
    depends_on: [api]
    networks: [rcln]

  worker:
    build: { context: ., dockerfile: apps/worker/Dockerfile }
    restart: unless-stopped
    environment: *app-env
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    networks: [rcln]

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: ['80:80', '443:443']
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddydata:/data
    depends_on: [web, api]
    networks: [rcln]

volumes: { pgdata: {}, redisdata: {}, caddydata: {} }
networks: { rcln: {} }
```

⚠️ **`NEXT_PUBLIC_*` variables are baked in at build time, not read at runtime.**
Next inlines them into the client bundle during `next build`. Changing
`ROOT_DOMAIN` therefore requires `docker compose build web`, not a restart. This
catches everyone once.

### 5.4 `Caddyfile`

Two hostnames plus one demo tenant. Caddy fetches certificates automatically.

```caddyfile
{$ROOT_DOMAIN} {
    reverse_proxy web:3000
}

api.{$ROOT_DOMAIN} {
    reverse_proxy api:5000
}

admin.{$ROOT_DOMAIN}, alpha.{$ROOT_DOMAIN}, beta.{$ROOT_DOMAIN} {
    reverse_proxy web:3000
}
```

Add a hostname per demo tenant you create. For genuinely unlimited tenants you
want either a wildcard cert (Caddy with a DNS-provider plugin, needs a registrar
API token) or `on_demand_tls` with an `ask` endpoint that validates the slug
against `organization_domains`. Both are more machinery than a portfolio demo
needs — three named hosts is fine.

### 5.5 `.env` on the server

```bash
ROOT_DOMAIN=yourdomain.com
DB_ROOT_PASSWORD=<openssl rand -hex 24>
OWNER_DB_PASSWORD=<openssl rand -hex 24>
APP_DB_PASSWORD=<openssl rand -hex 24>
JWT_SECRET=<openssl rand -base64 48>
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...
EMAIL_PROVIDER=console
```

⚠️ The passwords in `infra/postgres/init/01-roles-and-extensions.sql` are
**hardcoded** as `owner_password` and `app_password`. Either edit that file
before first boot to read from the environment, or `ALTER ROLE ... PASSWORD`
immediately after and keep `.env` in step. Do not ship the defaults.

---

## 6. First boot — order matters

The init SQL runs **once**, on an empty volume. If you get it wrong, the fix is
`docker compose down -v` and start over, so get it right the first time.

```bash
git clone <repo> && cd rcln
# write .env, Caddyfile, compose.prod.yml first — the init script runs on step 2

docker compose -f compose.prod.yml build                       # 1. build all three images
docker compose -f compose.prod.yml up -d postgres redis        # 2. init SQL creates the two roles + 4 extensions

# 3. migrate as the OWNER (RLS bypassed — this is the only step that may)
docker compose -f compose.prod.yml run --rm \
  -e DIRECT_DATABASE_URL="postgresql://rcln_owner:$OWNER_DB_PASSWORD@postgres:5432/rcln?schema=public" \
  migrate sh -c "pnpm db:migrate:prod && pnpm db:grants && pnpm db:seed"

# 4. prove isolation is actually on before anything serves traffic
docker compose -f compose.prod.yml run --rm migrate pnpm db:rls:check

docker compose -f compose.prod.yml up -d                       # 5. api, web, worker, caddy
```

Notes on step 3, each of which is a real trap:

- **`db:migrate:prod` is `prisma migrate deploy`**, which needs no shadow
  database. Do **not** grant `CREATEDB` to `rcln_owner` in production — the init
  script grants it for local `migrate dev` and the comment says so.
- **`db:grants` is not optional.** Migrations run as the owner and create tables
  granted to nobody. Skip it and `rcln_app` gets `permission denied for schema
public` on its first query, which reads as a Prisma fault and isn't one. The
  script also verifies its own work, because it re-grants `UPDATE`/`DELETE` on
  the append-only tables and then revokes them again.
- **`db:seed` writes the super admin** from `SUPERADMIN_EMAIL` /
  `SUPERADMIN_PASSWORD`. Change both from the `.env.example` defaults before
  running it — that account can enter any tenant (ADR-0012).
- The production Dockerfile prunes the Prisma CLI out of the runtime image
  (`rm -rf /pruned/node_modules/prisma`). **So the `migrate` service above cannot
  actually run `prisma migrate deploy` as written.** Either give the migrate
  service its own image built to the `build` stage
  (`target: build` in its `build:` block), or run migrations from a one-off
  `node:22-alpine` container with the repo mounted. This is the single most
  likely thing to fail on your first attempt.

---

## 7. Railway, briefly

If you'd rather not own a server: one project, five services.

1. Add **Postgres** and **Redis** plugins. Railway's Postgres gives you a
   superuser, so open its console and run
   `infra/postgres/init/01-roles-and-extensions.sql` by hand — the plugin has no
   `docker-entrypoint-initdb.d`.
2. Add three services from the same repo, each with a custom Dockerfile path
   (`apps/api/Dockerfile`, `apps/web/Dockerfile`, `apps/worker/Dockerfile`) and
   **root directory set to the repo root** — all three build contexts are the
   monorepo root, not the app directory.
3. Env vars per §5.3. Use Railway's `${{Postgres.DATABASE_URL}}` references, but
   **rewrite the user to `rcln_app`** — the plugin hands you the superuser URL,
   and the API's own guard will refuse to boot on it.
4. Run migrations once via `railway run` against the owner URL.
5. Custom domain `yourdomain.com` on `web`, `api.yourdomain.com` on `api`, and a
   wildcard `*.yourdomain.com` on `web`. Verify wildcard support on your plan
   before committing to this path — it's the one Railway feature I'd check first.

The worker needs no domain and no port.

---

## 8. Verifying the deployment

Do not trust a green container. Check these in order:

```bash
curl https://api.yourdomain.com/api/v1/health          # API up
curl https://api.yourdomain.com/api/v1/ready           # DB + Redis reachable
docker compose -f compose.prod.yml logs api | grep -i rls   # assertRlsActive passed
docker compose -f compose.prod.yml run --rm migrate pnpm db:rls:check
```

Then, in a browser:

1. `https://yourdomain.com` — marketing page renders **and buttons work**. If
   the page looks perfect and nothing responds, hydration failed — check
   `NEXT_PUBLIC_ROOT_DOMAIN` matches the actual host (it's baked in at build).
2. `/signup` — register a clinic with slug `alpha`. Add `alpha.yourdomain.com`
   to the Caddyfile _before_ this if it isn't there.
3. `https://alpha.yourdomain.com` — sign in. A 404 on every tenant call means
   the `Host` header isn't reaching the API; see `apps/web/src/lib/api.ts`.
4. `https://admin.yourdomain.com` — super admin console, impersonate `alpha`.
5. Create a doctor, a patient, an appointment. Try to double-book the same
   doctor — Postgres should refuse it.

---

## 9. Before you put the link on a résumé

- **Seed demo data.** An empty clinic demonstrates nothing. A doctor with a
  schedule, five patients and a day's appointments makes the appointment board
  legible in ten seconds.
- **Publish demo credentials** on the marketing page or the README. A reviewer
  who has to register an account will not register an account.
- **This is a public database with an open signup form.** Even with synthetic
  data, don't put anything real in it — not your own phone number, not a
  friend's name. It is PHI-shaped by design.
- **Keep a 60-second path.** Land → sign in as the demo clinic → appointment
  board → patient chart with the allergy band. That's the tour.
- Cheapest honest setup: ₹300 domain + ₹450/mo Hetzner ≈ **₹800 for the first
  month**, and you can stop it any time.

---

## Related

- [`STATUS.md`](STATUS.md) — what is actually built
- [`Architecture/PITFALLS.md`](Architecture/PITFALLS.md) — runtime failures that typecheck cleanly
- [ADR-0003](Architecture/decisions/0003-rls-enable-not-force.md) — why the two-role split is non-negotiable
- [`README.md`](../README.md) — local development
