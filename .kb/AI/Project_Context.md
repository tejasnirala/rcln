# Project Context

The minimum an agent needs before touching anything. Read this, then
[Agent_Instructions](Agent_Instructions.md).

---

## What rcln is

**Verified.** A multi-tenant healthcare management SaaS for Indian clinics. A
clinic registers, receives its own subdomain (`alpha.rcln.com`), and runs
appointments, prescriptions, lab, pharmacy, inventory and billing across one or
many branches. Subscription-billed. India-first — GST, HSN codes and ABHA all
appear in the data model.

**Verified.** The name of the tenant is **organization**. A branch is a place
the organization operates from. There is no "clinic" entity in the schema; a
solo practitioner and a three-branch hospital are the same shape.

---

## What actually exists today

**Verified** from [`STATUS.md`](../STATUS.md) and source, as of 2026-07-26.

| Area                                                   | State                                        |
| ------------------------------------------------------ | -------------------------------------------- |
| Monorepo, Docker dev stack, CI                         | Complete                                     |
| Schema — 32 models, RLS on 14 tables, composite FKs    | Complete                                     |
| Tenant resolution, `withTenant`, permission resolver   | Complete                                     |
| Registration, password + OTP login, refresh rotation   | Complete                                     |
| Branch CRUD + operating hours                          | Complete                                     |
| Invitations + accept flow                              | Complete                                     |
| Roles, members, per-person permission overrides        | Complete                                     |
| Marketing site, signup, tenant shell, platform console | Complete                                     |
| Impersonation, org settings, verification flows        | **Not built**                                |
| Subscriptions / payments (Phase 2)                     | **Not built**                                |
| Patients, appointments, clinical (Phase 3)             | **Not built**                                |
| Billing, pharmacy, inventory, lab (Phases 4–6)         | **Not built**                                |
| Notification delivery                                  | **Logging stub only**                        |
| Worker processors                                      | **Queues registered, nothing consumes them** |

**The product name suggests far more than is built.** Roughly Phase 1 of seven
is done. Everything clinical is schema-only. If a request assumes patients or
appointments exist as working features, they do not.

---

## Shape of the repository

```
rcln/
├─ apps/
│  ├─ api/       Express 5 — the only thing that talks to Postgres
│  ├─ web/       Next.js 16 App Router — marketing, tenant app, platform console
│  └─ worker/    BullMQ — queues registered, processors are stubs
├─ packages/
│  ├─ db/        Prisma schema, migrations, RLS SQL, tenant-scoped client
│  ├─ contracts/ Zod schemas + inferred types, shared by api and web
│  ├─ permissions/ Permission catalogue, 12 system roles, resolver
│  └─ config/    eslint and tsconfig presets
├─ infra/        Dockerfiles, Postgres init SQL
└─ .kb/          this KnowledgeBase
```

Three route groups in `apps/web`, and which one you are in determines the auth
model: `(marketing)` is the apex domain and pre-tenant, `(tenant)` is
`/t/<slug>` reached via subdomain rewriting, `(platform)` is the `admin.`
subdomain.

---

## The five invariants

Breaking any of these is a correctness or security regression, not a style
choice. Each has an ADR; read it before arguing with it.

1. **Organization is the tenant, branch is the place.**
   → [ADR-0001](../Architecture/decisions/0001-organization-is-the-tenant.md)
2. **No role column on `users`.** Roles live on `membership_roles`.
   → [ADR-0002](../Architecture/decisions/0002-roles-live-on-membership.md)
3. **Tenant isolation is enforced by Postgres.** RLS + composite FKs +
   application scoping, three independent layers.
   → [ADR-0003](../Architecture/decisions/0003-rls-enable-not-force.md),
   [ADR-0004](../Architecture/decisions/0004-composite-foreign-keys.md)
4. **Never import the raw Prisma client.** Use `withTenant(ctx, …)`.
   → [ADR-0005](../Architecture/decisions/0005-tenant-scoped-prisma-client.md)
5. **No JSON arrays of foreign keys.**
   → [ADR-0006](../Architecture/decisions/0006-no-json-id-arrays.md)

---

## Mental model of a request

**Verified** from `apps/api/src/app.ts` and the route files.

```mermaid
sequenceDiagram
    participant B as Browser (alpha.lvh.me)
    participant W as Next.js (BFF)
    participant A as Express API
    participant R as Redis
    participant P as Postgres

    B->>W: request with httpOnly host-only cookie
    W->>A: fetch with Host: alpha.lvh.me + Bearer token
    A->>A: helmet, cors, body, request-id, pino
    A->>A: generalLimiter
    A->>R: resolveTenant — host → organization (cached, negative-cached)
    R-->>A: organizationId (or miss → Postgres → cache)
    A->>A: authenticate — verify JWT, no DB round trip
    A->>R: authorize — load resolved access for (user, org)
    R-->>A: roles, branches, effective permissions
    A->>A: validate — Zod, from @rcln/contracts
    A->>P: withTenant → BEGIN; set_config(app.current_org, …, true); query; COMMIT
    P-->>A: rows the RLS policy allows and no others
    A-->>W: { success, data } envelope
    W-->>B: rendered HTML / Server Action result
```

Two details that catch people:

- `set_config(…, true)` is **transaction-local**. That is the only reason a
  pooled connection cannot leak tenant context between requests.
- The web container reaching the API server-to-server has `Host: api:5000`,
  which resolves to **no tenant**. `apps/web/src/lib/api.ts` sets the Host
  header from the slug for this reason. Forget it and every tenant call 404s,
  indistinguishably from a missing route.

---

## Technology, verified

Node 22 · TypeScript 5.9 (strict, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`) · Express 5 · Next.js 16 (App Router; note
`middleware.ts` is renamed `proxy.ts`) · React 19 · Prisma 7 · PostgreSQL 16 ·
Redis 7 · BullMQ · Zod · Jest + supertest · pnpm 10 workspaces + Turbo ·
Docker Compose for the entire dev environment.

ESM throughout: relative imports need the `.js` extension even from `.ts`
source.

Full detail with what is _not_ installed: [`03_Technology_Stack.md`](../03_Technology_Stack.md).

---

## Where the truth lives

| Question                        | Authority                                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Does this symbol already exist? | `pnpm kb:find <name>`                                                                                       |
| What is built vs planned?       | [`STATUS.md`](../STATUS.md)                                                                                 |
| Why is it built this way?       | [`Architecture/decisions/`](../Architecture/decisions/README.md)                                            |
| How do I write it?              | [`Architecture/CONVENTIONS.md`](../Architecture/CONVENTIONS.md)                                             |
| Why is it behaving oddly?       | [`Architecture/PITFALLS.md`](../Architecture/PITFALLS.md)                                                   |
| What does the request do?       | [`Architecture/how-it-works.md`](../Architecture/how-it-works.md)                                           |
| What is the data model?         | [`Database/schema-design.md`](../Database/schema-design.md) + [`Database/_index.md`](../Database/_index.md) |
| Is this table RLS-covered?      | [`Database/_index.md`](../Database/_index.md) — and `pnpm db:rls:check` for the live answer                 |

`Architecture/architecture.md` is the exception: it is a **target design**, not
a description of the running system.
