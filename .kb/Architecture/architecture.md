# Production Architecture — Multi-Tenant Healthcare SaaS

Companion to `.kb/Database/schema-design.md`. Assumes India-first (GST, HSN, ABHA all appear in the schema), Postgres 16, and the existing `expresswithpsql` scaffold as the backend seed.

---

## 0. The stack, in one table

| Layer                      | Choice                                               | Why this and not the alternative                                                                                                                       |
| -------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Backend runtime            | **Node 22 LTS + TypeScript 5.9**                     | Already scaffolded; one language across the stack; the team's existing product is Python/FastAPI but nothing here needs Python                         |
| HTTP framework             | **Express 5**                                        | Already scaffolded. Fastify is ~2× faster on synthetic benchmarks, which is irrelevant when every request makes 3 DB round-trips. Not worth a rewrite. |
| ORM                        | **Prisma 7 + `@prisma/adapter-pg`**                  | Already scaffolded. See §5 for the RLS integration, which is the one place Prisma needs help.                                                          |
| Database                   | **PostgreSQL 16**                                    | RLS, partitioning, `gist` exclusion constraints, JSONB, `pg_trgm` — the schema design depends on all four                                              |
| Pooling                    | **PgBouncer** (transaction mode)                     | Node + Prisma opens connections greedily; RDS Postgres tops out ~500                                                                                   |
| Cache / locks / rate limit | **Redis 7 (Valkey)**                                 | See §7 — five distinct jobs, not just caching                                                                                                          |
| Queue                      | **BullMQ** (on the same Redis)                       | See §8                                                                                                                                                 |
| Frontend                   | **Next.js 16 (App Router) + React 19 + TypeScript**  | Proxy-based subdomain routing is the single feature that makes tenant resolution trivial. See §3.                                                      |
| UI                         | **Tailwind + shadcn/ui + TanStack Table + Recharts** | Copy-in components, no runtime dependency you can't patch                                                                                              |
| Client data                | **TanStack Query**                                   | Cache invalidation on branch switch is one `queryClient.clear()`                                                                                       |
| Object storage             | **S3 (ap-south-1)** + CloudFront signed URLs         | Lab reports and scans never touch the app server                                                                                                       |
| Deploy                     | **AWS ECS Fargate** behind ALB, ap-south-1 (Mumbai)  | Data residency; Fargate avoids running Kubernetes with a small team                                                                                    |
| CI/CD                      | **GitHub Actions** → ECR → ECS rolling deploy        | Already have `.github/`                                                                                                                                |
| Observability              | **Sentry + OpenTelemetry → Grafana Cloud**           | §14                                                                                                                                                    |

---

## 1. Verdict on the existing scaffold

Keep: Express 5, TypeScript, Prisma 7, Zod, Winston, Helmet, `express-rate-limit`, Jest + supertest, Husky + commitlint, Dockerfile, docker-compose.

**Three things in it must change before you write a single feature:**

1. **`User.role` enum must be deleted.** The current `prisma/schema.prisma` has `role Role @default(USER)` on `User`. That is exactly the mistake the new schema exists to fix — a role column on the user makes "doctor at branch A, receptionist at branch C" unrepresentable. Roles live on `membership_roles`.
2. **`express-rate-limit`'s default memory store won't survive two containers.** Swap to `rate-limit-redis`.
3. **`docker-compose.yml` needs Redis** and the `version:` key can go (obsolete in Compose v2).

Also add: `pino` in place of `winston` (Winston's async transports drop logs on crash; pino is faster and pairs with `pino-http` for request logging) — this one is optional, Winston is fine if you'd rather not churn.

---

## 2. Repo layout — one pnpm monorepo

```
rcln/
├─ apps/
│  ├─ api/                    ← the existing expresswithpsql, renamed
│  ├─ web/                    ← Next.js tenant app (alpha.xyz.com)
│  ├─ admin/                  ← platform super-admin console (admin.xyz.com)
│  └─ worker/                 ← BullMQ processors, own container, shares packages
├─ packages/
│  ├─ db/                     ← prisma schema, migrations, generated client, seeds
│  ├─ contracts/              ← Zod schemas + inferred types, shared by api & web
│  ├─ permissions/            ← permission code constants + effective-permission resolver
│  ├─ ui/                     ← shadcn components
│  └─ config/                 ← eslint, tsconfig, tailwind presets
└─ infra/                     ← terraform, docker, github actions
```

`packages/contracts` is the highest-leverage piece: define every request/response with Zod once, `z.infer` the type on both sides. You get runtime validation on the server and compile-time types on the client without codegen. Consider `ts-rest` or `@ts-rest/express` if you want typed route contracts without moving to tRPC (tRPC is excellent but makes a future mobile app or third-party API harder).

**Keep the super-admin console a separate app.** Different auth path, different risk profile, different deploy cadence. It should never share a bundle with the tenant app.

---

## 3. Subdomain routing — the part that's easy to get wrong

**DNS.** Wildcard `*.xyz.com` → ALB. One record, every tenant.

**TLS.** ACM wildcard cert for `*.xyz.com` — free, auto-renewing, covers every tenant subdomain. Note it covers exactly one level: `alpha.xyz.com` yes, `a.b.xyz.com` no. If you later sell custom domains (`portal.pmcs.com`), that's a _separate_ mechanism: per-domain certs issued on demand via ACM DNS validation or Caddy's on-demand TLS. Design `organization_domains` for it now (already done), build it later.

**Reserved subdomains.** Block at registration: `www admin api app static cdn mail smtp ftp blog docs status help support dev staging test demo`. A tenant claiming `api` breaks your platform.

**The Next.js proxy** resolves the tenant before any page renders. Note that Next 16 renamed `middleware.ts` to `proxy.ts`; behaviour is unchanged:

```ts
// apps/web/src/proxy.ts   (was middleware.ts before Next 16)
export function proxy(req: NextRequest) {
  const host = req.headers.get('host')!.split(':')[0];
  const sub = host.endsWith(ROOT_DOMAIN) ? host.slice(0, -(ROOT_DOMAIN.length + 1)) : null;

  if (!sub || RESERVED.has(sub)) return NextResponse.next();

  const res = NextResponse.rewrite(new URL(`/_tenant/${sub}${req.nextUrl.pathname}`, req.url));
  res.headers.set('x-tenant-slug', sub);
  return res;
}
```

**Cookies.** Set the session cookie on `.xyz.com` (leading dot) only if you want SSO across tenants — you almost certainly _don't_. Scope the cookie to the exact subdomain so a session at `alpha.xyz.com` is useless at `beta.xyz.com`. `SameSite=Lax`, `HttpOnly`, `Secure`, `__Host-` prefix where possible.

**Local dev.** `alpha.localhost:3000` works in Chrome and Firefox without hosts-file edits. Or use `*.lvh.me` / `*.localtest.me`, which resolve to 127.0.0.1 publicly.

---

## 4. Request lifecycle

```
Browser (alpha.xyz.com)
  ↓  Cloudflare (DNS, WAF, DDoS, bot rules)
  ↓  ALB  ─ TLS termination (ACM wildcard)
  ↓  ECS Fargate: web (Next.js) — SSR/RSC, no DB access
  ↓  ALB /api/* → ECS Fargate: api (Express)
      1. helmet, cors (dynamic origin check vs organization_domains), compression
      2. request-id + pino-http
      3. tenant resolver:   host → organizations (Redis-cached, 5 min TTL)
      4. authn:             verify JWT → users.id
      5. authz:             load membership + membership_roles (Redis-cached)
      6. entitlement:       plan_features gate for module access
      7. tx wrapper:        BEGIN; SET LOCAL app.current_org/branch_scope/user
      8. zod validate → controller → service → prisma
      9. COMMIT; audit_logs write; outbox_events insert
  ↓  PgBouncer → RDS Postgres 16 (Multi-AZ) + read replica
  ↓  ElastiCache Redis (cache, locks, rate limits, BullMQ)
  ↓  ECS Fargate: worker (BullMQ) — notifications, PDFs, reports, cron
  ↓  S3 + CloudFront (files, signed URLs)
```

Steps 3–7 are one middleware chain and they are the entire security model. Write them once, test them hard, never let a route bypass them.

---

## 5. Prisma + Row-Level Security — the highest-risk integration

This is the one place your stack fights your schema, so get it right on day one.

**The problem.** RLS reads `current_setting('app.current_org')`. Postgres session settings persist on a connection. Prisma pools connections. A connection that keeps `app.current_org = <org A>` and is then handed to a request for org B leaks data.

**The solution.** `SET LOCAL` is transaction-scoped — it reverts on COMMIT/ROLLBACK. So every tenant-scoped request runs inside a transaction:

```ts
// packages/db/src/tenant-client.ts
export function forTenant(ctx: TenantContext) {
  return prisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          return prisma.$transaction(async (tx) => {
            await tx.$executeRaw`
              SELECT set_config('app.current_org',   ${ctx.orgId},   true),
                     set_config('app.branch_scope',  ${ctx.branchIds.join(',')}, true),
                     set_config('app.current_user',  ${ctx.userId},  true)`;
            return query(args);
          });
        },
      },
    },
  });
}
```

The `true` third argument to `set_config` is what makes it transaction-local. This is also why PgBouncer **transaction** pooling mode is safe here and **session** mode is not necessary.

**Three consequences to accept:**

1. Every query becomes a transaction — roughly 2 extra round-trips. Mitigate by batching related reads into one explicit `$transaction` per request rather than per query, and by caching permission/tenant lookups in Redis.
2. The app must connect as a **non-superuser, non-table-owner** role. Postgres silently bypasses RLS for table owners and superusers — the single most common way teams ship RLS that does nothing. Migrations run as the owner; the app runs as `app_user` with `NOLOGIN`-derived grants only.
3. Prisma's `migrate` does not manage policies. Keep RLS policies, triggers, partitions, and exclusion constraints in `prisma/migrations/*/migration.sql` hand-edited blocks, and add a CI check that every table in `information_schema.tables` has `relrowsecurity = true`.

**Belt and braces:** RLS is the last line, not the only line. Services still pass `organizationId` explicitly. Composite FKs (§D3 of the schema doc) catch what both miss. Three independent mechanisms, because a cross-tenant leak in healthcare is a company-ending event.

**Test it:** a fixture that seeds two orgs and asserts every single endpoint returns 404/empty for the wrong tenant. Run it in CI. Make it impossible to merge without it.

---

## 6. Auth — build it, don't buy it

**Recommendation: build on the schema you already have.** Auth0/Clerk/WorkOS are excellent when the model is "user belongs to one organization with one role." Yours is `user × organization × role × branch` with branch-scoped permission overrides and a super admin who impersonates across tenants. You would end up storing all of that in your own DB anyway, and paying per MAU (patients are MAUs — that gets expensive fast) for a login box.

What to build:

- **Argon2id** for password hashing (`@node-rs/argon2`), not bcrypt. `bcryptjs` in the current scaffold is pure-JS bcrypt and is both slow and weaker — replace it.
- **Access token**: JWT, 15 min, contains `sub`, `org_id`, `branch_id`, `membership_id`, `roles[]`, `jti`. Never put the permission list in the token — it gets stale on a role change and blows up header size.
- **Refresh token**: opaque random 256-bit, hashed in `sessions.refresh_token_hash`, 7–30 days, **rotated on every use** with reuse detection (if an already-rotated token is presented, revoke the whole family — that's a stolen-token signal).
- **Branch switch**: `POST /auth/switch-branch` → validate the target branch is in the user's `membership_roles` → update `sessions.active_branch_id` → issue new access token → client calls `queryClient.clear()`. Write an `audit_logs` row every time.
- **OTP login** for patients and front-desk staff via `auth_tokens` — phone-first is non-negotiable in Indian healthcare. Rate-limit hard: 3 sends per phone per 15 min, 5 verify attempts per token, exponential backoff.
- **MFA (TOTP)** mandatory for `is_platform_admin` and org owners. `otplib`.
- **Impersonation** for super admin: separate short-lived token, `sessions.impersonated_by_user_id` set, a persistent banner in the UI, every request audited, and a hard block on write operations unless explicitly elevated.

**Buy instead if:** an enterprise hospital chain demands SAML/SCIM. Then add WorkOS _just_ for the SSO handshake and keep your own membership model behind it.

---

## 7. Redis — five jobs, one cluster

Yes, you need it. Not for "caching" vaguely — for these specifically:

1. **Tenant resolution cache.** `host → org` on every single request. 5-min TTL, invalidated on domain change. Without this you add a DB round-trip to every request including static-ish ones.
2. **Permission cache.** `membership_id → {roles, branches, permissions}`. 5-min TTL, invalidated on any `membership_roles` write. This is the hottest read in the system.
3. **Distributed rate limiting.** `rate-limit-redis`. Per-IP for auth endpoints, per-org for API usage, per-phone for OTP.
4. **Distributed locks.** Critical for: invoice number generation (though prefer a DB sequence or `SELECT … FOR UPDATE` on `number_sequences` — the DB is more correct here), appointment slot booking, and stock deduction at dispense. Use `redlock` only where a DB lock genuinely doesn't fit.
5. **BullMQ backing store.** §8.

**Do not** cache patient clinical data in Redis. Keep PHI out of it entirely — cache IDs and permission metadata only. It reduces your breach surface and your compliance paperwork.

Run it as **ElastiCache Redis with encryption in transit and at rest**, single-node with a replica. `maxmemory-policy allkeys-lru` for the cache DB, `noeviction` for the BullMQ DB — use separate logical DBs or separate instances, because evicting a job is a lost notification.

---

## 8. Background jobs — BullMQ

A separate `worker` container, same image, different entrypoint. Never process jobs in the API container; a slow PDF render must not eat a request thread.

| Queue           | Jobs                                                                                                      | Notes                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `notifications` | appointment booked/reminder/cancelled, lab report ready, invoice issued, low stock, subscription expiring | Rate-limited per provider; exponential backoff, 5 attempts                            |
| `documents`     | prescription PDF, invoice PDF, lab report PDF, GST returns export                                         | Puppeteer/Playwright in a dedicated container (it's heavy); or Gotenberg as a sidecar |
| `reports`       | dashboard rollups, `daily_branch_metrics` refresh, month-end revenue                                      | Cron via BullMQ repeatable jobs                                                       |
| `billing`       | subscription renewal, dunning (retry failed payment on d1/d3/d7), grace-period suspension, usage counters | Idempotency keys mandatory                                                            |
| `inventory`     | expiry alerts (T-90/60/30/7), reorder-point alerts, stock reconciliation                                  | Daily cron                                                                            |
| `integrations`  | ABDM sync, webhook delivery to tenants, outbox drain                                                      | With retry + dead-letter                                                              |
| `outbox`        | drain `outbox_events` → publish                                                                           | Transactional outbox pattern; guarantees at-least-once delivery of side effects       |

**Idempotency is not optional.** Every job takes a deterministic `jobId` (e.g. `reminder:${appointmentId}:24h`) so a retry can't double-send a WhatsApp message. Every payment webhook handler checks a processed-events table before acting.

**Scheduled jobs** (BullMQ repeatable): appointment reminders (hourly sweep), expiry check (daily 6am IST), subscription renewals (daily), metrics rollup (nightly 1am IST), DB backup verification (weekly).

---

## 9. Notifications — India stack

| Channel      | Provider                                                          | Notes                                                                                                                                                                                |
| ------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **WhatsApp** | Meta Cloud API direct, or **AiSensy / Gupshup / Interakt** as BSP | This is the primary channel in Indian healthcare. Templates need pre-approval by Meta — budget 2–3 days per template. Session windows are 24h; outside that only approved templates. |
| **SMS**      | **MSG91** or Kaleyra                                              | DLT registration with TRAI is **mandatory** and takes 1–2 weeks: register entity, register header (sender ID), register each template. Start this on day one — it blocks launch.     |
| **Email**    | **AWS SES** (ap-south-1)                                          | Cheapest at volume; needs domain verification + DKIM + SPF + DMARC. Resend or Postmark if you want better deliverability tooling out of the box.                                     |
| **Push**     | Firebase Cloud Messaging                                          | Only when you build mobile                                                                                                                                                           |
| **In-app**   | Your own `notifications` table + SSE or polling                   | Don't reach for websockets until you need them                                                                                                                                       |

Design them behind one interface: `NotificationService.send(eventCode, recipient, payload)` resolves `notification_templates` → `notification_preferences` → provider adapter. Swapping MSG91 for Kaleyra should be one file.

**Every send writes a `notifications` row before dispatch** and updates status on the provider webhook. When a doctor says "the patient never got the reminder," you need the answer in one query.

---

## 10. Payments

**Two completely separate flows — do not share code between them:**

**A. Platform subscriptions (clinic pays you).** **Razorpay Subscriptions** — supports UPI Autopay and e-mandate on cards/netbanking, which is what Indian B2B actually uses. Stripe still has limited India support for recurring domestic collection. Webhooks drive `subscriptions.status`; never trust the client redirect. Handle: `subscription.charged`, `subscription.halted`, `payment.failed`. Dunning: retry d1/d3/d7, then `PAST_DUE` → 7-day grace with a banner → `SUSPENDED` (read-only access, never delete data).

**B. Patient payments (patient pays clinic).** Razorpay Route or Cashfree Easy Split if you want to be the merchant of record and settle to clinics — **but understand this makes you a payment aggregator with RBI implications.** The much simpler path for v1: each clinic connects their _own_ gateway account, you store credentials encrypted per org, and money never touches you. Most clinics also take cash and UPI QR at the counter, so `payments.method` must support offline modes with a `received_by` staff attribution regardless.

Store gateway keys in **AWS Secrets Manager**, per-org, encrypted. Never in the `settings_values` table.

---

## 11. Files & PDFs

- **S3 ap-south-1**, one bucket, keys prefixed `org/{org_id}/branch/{branch_id}/{entity}/{uuid}`. Block all public access.
- **Uploads** go direct browser → S3 via presigned POST, never through your API. Constrain content-type and size in the policy.
- **Downloads** via CloudFront signed URLs, 5-minute expiry. A lab report URL that works forever is a breach.
- **Virus scan** on upload (ClamAV in a Lambda triggered by S3 event) — clinics upload whatever the patient handed them.
- **PDF generation**: Playwright rendering React templates gives you designers-can-edit invoices. Run it in the worker, never the API. Cache generated PDFs in S3 keyed by a content hash.
- **Versioning + lifecycle**: S3 versioning on, transition to Glacier after 1 year, and _never_ auto-delete — Indian medical record retention is 3 years minimum for outpatient records, longer for medico-legal.

---

## 12. Deployment topology

**Recommendation: AWS ap-south-1 (Mumbai), ECS Fargate.**

```
Route53 (*.xyz.com)
  → Cloudflare (proxy, WAF, DDoS)
    → ALB (ACM wildcard cert)
      → ECS Fargate service: web     (2 tasks, 0.5 vCPU / 1 GB, autoscale 2–10)
      → ECS Fargate service: api     (2 tasks, 1 vCPU / 2 GB,   autoscale 2–20)
      → ECS Fargate service: worker  (2 tasks, 1 vCPU / 2 GB,   autoscale on queue depth)
  → RDS Postgres 16, db.t4g.medium Multi-AZ (→ r7g as you grow) + 1 read replica
  → ElastiCache Redis 7, cache.t4g.small with replica
  → S3 + CloudFront
  → Secrets Manager, Parameter Store
  → ECR
```

**Why not the alternatives:**

- **Vercel for the frontend** is tempting and works well with Next.js — but wildcard subdomains on Vercel need a Pro plan with wildcard domain support, and you'll want the frontend in the same VPC/region as the API to avoid a cross-continent hop on every SSR data fetch. If you do use Vercel, keep the API on AWS Mumbai and accept the latency, or use it only for marketing pages.
- **Kubernetes (EKS)** — no. Three services and a small team do not need a control plane to babysit. Revisit at ~15 services.
- **Railway / Render / Fly.io** — genuinely fine for the first 6 months and much less work. But India data residency under the DPDP Act is real for health data; verify the region before committing. Fly has a Mumbai region, Render does not.
- **Self-hosted VPS (Hetzner/DigitalOcean)** — 5× cheaper, and you become the DBA, the SRE, and the on-call. For healthcare data with backup/PITR/audit requirements, the managed premium is worth it.

**Environments:** `dev` (docker-compose, local), `staging` (single-task, real AWS, seeded demo tenants), `production`. Staging must be a real environment with real RLS and a real tenant — RLS bugs don't show up in local single-tenant testing.

**Zero-downtime migrations:** expand → deploy → contract. Never rename a column in one migration. Prisma migrations run as a one-off ECS task before the service update, gated on success.

---

## 13. Security & compliance

**Non-negotiable technical controls:**

- TLS 1.2+ everywhere, HSTS, secure headers via Helmet (already there — add CSP explicitly).
- **Encryption at rest**: RDS + S3 + ElastiCache all with KMS. Additionally **column-level encryption** (`pgcrypto` or app-side AES-GCM with a KMS data key) for `patients.abha_number`, `national_id`, and `patient_documents` metadata.
- **Audit everything**: the `audit_logs` table is written on every mutation via a Prisma middleware, and `data_access_logs` on every PHI _read_. Yes, reads. "Who looked at this patient's file" is the question that gets asked after an incident.
- **Backups**: RDS automated backups, 30-day retention, PITR enabled, plus a monthly logical dump to a separate account/region. **Test the restore quarterly** — an untested backup is a rumour.
- **Secrets**: AWS Secrets Manager with rotation. Nothing in `.env` in production. Note the current repo has `.env` committed alongside `.env.example` — verify it's gitignored and rotate anything that leaked.
- **Dependency scanning**: Dependabot + `pnpm audit` in CI + Trivy on the container image.
- **PII in logs**: pino redaction paths for `password`, `token`, `authorization`, `phone`, `abha_number`. Log the patient _id_, never the name.

**Regulatory (India):**

- **DPDP Act 2023** — health data is sensitive personal data. You need: explicit consent capture (your `patient_consents` table does this), purpose limitation, a Data Protection Officer named, breach notification within the prescribed window, and data principal rights (access, correction, erasure). Erasure conflicts with medical retention law — resolve it as anonymization, not deletion, and document that decision.
- **Data residency** — keep everything in ap-south-1/ap-south-2. This constrains your provider choices; check it before signing anything.
- **ABDM/ABHA** — if you want the NHA integration badge, you need M1/M2/M3 milestone certification. Plan it as a later phase; the schema has the hooks.
- **You are a Data Processor, your clinics are Data Fiduciaries.** Get a DPA template drafted; enterprise clinics will ask.
- **HIPAA is irrelevant** unless you sell to US customers. Don't let a vendor upsell you a "HIPAA-compliant" tier you don't need.

---

## 14. Observability

| Concern           | Tool                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Errors            | **Sentry** — both API and web, with `org_id`/`branch_id`/`user_id` tags on every event                                                                 |
| Traces            | **OpenTelemetry** SDK → Grafana Tempo or Datadog. Auto-instrument Express, Prisma, BullMQ, Redis                                                       |
| Metrics           | Prometheus format from the API → Grafana Cloud. Track: p95 latency by route, queue depth, job failure rate, DB connection saturation, RLS-denied count |
| Logs              | pino JSON → CloudWatch → Grafana Loki. Correlate by `request_id`                                                                                       |
| Uptime            | BetterStack or Checkly, hitting `/health` on a real tenant subdomain                                                                                   |
| Product analytics | PostHog (self-hostable — matters for PHI adjacency)                                                                                                    |

**Business dashboards you'll want from week one:** signups per day, trial→paid conversion, MRR, churn, active tenants, appointments booked per tenant (your engagement proxy), and per-tenant DB row counts (your noisy-neighbour early warning).

**Alerts that page someone:** API 5xx rate >1%, p95 >2s, queue depth >1000, DB CPU >80%, replication lag >30s, failed payments >5 in an hour, any RLS policy violation.

---

## 15. Testing

- **Unit** (Jest, already there) — services, permission resolver, invoice math, FEFO batch selection, tax computation. The billing calculations deserve property-based tests (`fast-check`); rounding errors compound.
- **Integration** (supertest + Testcontainers Postgres) — real DB, real migrations, real RLS. Not mocked Prisma.
- **The tenant-isolation suite** — described in §5. Treat it as the most important test file in the repo.
- **E2E** (Playwright) — the flows that lose money if broken: register clinic → onboard branch → book appointment → consult → prescribe → dispense → invoice → pay. Plus branch switching. Plus super-admin impersonation.
- **Load** (k6) — before launch, and specifically test 50 concurrent tenants, not 50 concurrent users on one tenant. Multi-tenant failure modes are different.

---

## 16. Buy vs build — the complete list

**Buy (don't waste weeks):**

| Need           | Service                                            | Rough cost                  |
| -------------- | -------------------------------------------------- | --------------------------- |
| WhatsApp       | AiSensy / Gupshup                                  | ₹2–5k/mo + per-conversation |
| SMS            | MSG91                                              | ~₹0.15/SMS + DLT setup      |
| Email          | AWS SES                                            | $0.10/1000                  |
| Payments       | Razorpay                                           | 2% + GST                    |
| Error tracking | Sentry                                             | Free → $26/mo               |
| Monitoring     | Grafana Cloud                                      | Free tier is generous       |
| PDF            | Gotenberg (self-host) or Playwright                | infra only                  |
| Search (later) | Postgres `pg_trgm` first; Typesense if it outgrows | free → $30/mo               |
| Support chat   | Crisp / Intercom                                   | $25+/mo                     |
| Status page    | BetterStack                                        | $30/mo                      |
| Feature flags  | Unleash (self-host) or PostHog flags               | free                        |

**Build (this is your product):** the tenancy model, RBAC, clinical workflows, pharmacy/inventory, billing, the dashboard. Anything a competitor could differentiate on.

**Estimated infra cost at 50 tenants / ~2000 daily active users:** ~$400–600/month on AWS Mumbai. At 500 tenants, ~$2000–3000 with a bigger RDS and more Fargate tasks. Budget another ~$300/mo for SaaS tooling.

---

## 17. Build order (maps to the schema doc's §16)

**Phase 0 — foundation (2–3 weeks).** Monorepo, `packages/db` with the full Prisma schema, RLS policies + the CI check that enforces them, tenant/auth/authz middleware chain, the tenant-isolation test suite, CI/CD to staging. **Nothing product-facing ships in this phase, and that is correct.** Every shortcut taken here becomes a data breach later.

**Phase 1 — tenancy (2 weeks).** Org registration, subdomain provisioning, branch CRUD, user invite, roles/permissions UI, branch switcher, super-admin console.

**Phase 2 — subscriptions (1–2 weeks).** Plans, Razorpay integration, entitlement gating, dunning.

**Phase 3 — core clinical (4–6 weeks).** Patients, registrations, appointments, queue, encounters, vitals, prescriptions.

**Phase 4 — billing (2–3 weeks).** Billable items, invoices, payments, number sequences, GST.

**Phase 5 — pharmacy + inventory (4–5 weeks).** Catalogue → suppliers/PO/GRN → batches → stock ledger → dispensing. In that order.

**Phase 6 — lab (2–3 weeks).**

**Phase 7 — dashboards, settings, notifications (3 weeks).** Cross-cutting, but seed `setting_definitions` from Phase 0.

Roughly 5–6 months to a sellable v1 with 2–3 engineers. Get one design partner clinic using Phase 3 in production before you build Phase 5.
