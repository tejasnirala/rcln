# How rcln works

A walkthrough of the running system: who signs in where, what happens to a
request, and how one clinic is kept out of another's data.

This is the "read it once to get your bearings" document.
[`architecture.md`](architecture.md) is the design rationale,
[`schema/schema-design.md`](../Database/schema-design.md) is the data model, and
[`STATUS.md`](../STATUS.md) is what is built. This one is the tour.

Everything below describes what the code does **today**. Where something is
designed but not built, it says so.

---

## 1. Three front doors

rcln is one deployment serving three different audiences, told apart by the
**hostname**. `apps/web/src/proxy.ts` reads the `Host` header and rewrites the
URL before any page renders:

| You visit         | Rewritten to  | Who it is for                             |
| ----------------- | ------------- | ----------------------------------------- |
| `rcln.com/`       | _(untouched)_ | The public. Marketing, pricing, demo form |
| `alpha.rcln.com/` | `/t/alpha/`   | Everyone who works at clinic "alpha"      |
| `admin.rcln.com/` | `/platform/`  | rcln staff. The platform console          |

In development the root domain is `lvh.me`, which resolves to `127.0.0.1`
including every subdomain — so `northwind.lvh.me:3000` works with no `/etc/hosts`
editing.

A few subdomains are reserved (`admin`, `api`, `www`, `login`, …) and a clinic
cannot register them. The list lives in `proxy.ts` and must stay in step with
`RESERVED_SLUGS` in `@rcln/contracts`.

> **The URL is load-bearing.** The clinic home page and the marketing landing
> page are both `/`; only the rewrite distinguishes them. This has already caused
> one real bug — see [PITFALLS](PITFALLS.md), "A relative `redirect()` lands on
> the landing page".

---

## 2. Two kinds of account

This is the single most important idea in the system, and it is not the usual
one. There is **no `role` column on `users`**.

**Every human is one row in `users`** — a super admin, a doctor, a receptionist,
a patient. That row holds credentials and exactly one privilege flag:

```
users.is_platform_admin    true = rcln staff, false = everybody else
```

**Belonging to a clinic is a separate row.** A `membership` joins one user to one
organization. Roles hang off the membership, not the user:

```
memberships       user × organization
membership_roles  membership × role × branch_id   (NULL = every branch)
```

So "admin" is not a property of a person. It is a role granted to their
membership, optionally narrowed to one branch. The same doctor can work at two
clinics with different roles at each, from one login and one password.

→ [ADR-0002](decisions/0002-roles-live-on-membership.md)

### What that means in practice

| Person                         | How the system sees them                                         |
| ------------------------------ | ---------------------------------------------------------------- |
| rcln super admin               | `users.is_platform_admin = true`, **no membership anywhere**     |
| Clinic owner                   | membership + `ORG_OWNER` role, `branch_id = NULL` (all branches) |
| Admin over the whole clinic    | membership + `ORG_ADMIN`, `branch_id = NULL`                     |
| Admin of one branch            | membership + `BRANCH_ADMIN`, `branch_id = <that branch>`         |
| Admin of two of three branches | **two rows** in `membership_roles`, one per branch               |

---

## 3. How each person gets in

### The super admin

Created by the database seed, which runs automatically on `docker compose up`.
Credentials come from the environment:

```
SUPERADMIN_EMAIL      defaults to superadmin@rcln.local
SUPERADMIN_PASSWORD   no default in the seed — check your .env
SUPERADMIN_NAME       defaults to Platform Super Admin
```

The seed **skips** creating the account if `SUPERADMIN_PASSWORD` is unset, and
refuses a password under 16 characters in production.

They sign in at **`admin.<root-domain>`**, not at any clinic. Because they hold
no membership, `resolveTenant` finds no tenant on that host — which is correct:
a platform admin belongs to no clinic. Their session simply has no active
organization.

**Everyone else is invisible on that host.** `requirePlatformAdmin` answers a
perfectly valid clinic login with **404, not 403** — a 403 would confirm the
console exists. Verified: a clinic owner's token against
`GET /api/v1/platform/demo-requests` returns 404.

What they can do today: view incoming demo requests, and provision a clinic from
one. Impersonating into a clinic is designed but **not built yet**.

### A clinic owner — self-serve

1. Visit the apex, fill in `/signup` (4 steps, with a live subdomain
   availability check against `GET /public/organizations/check-slug`).
2. `POST /public/organizations/register` runs **one transaction** creating:
   organization → subdomain → first branch → owner user → membership →
   `ORG_OWNER` grant → trial subscription.
3. The response is **not** a session. It is a URL: `https://<slug>.rcln.com/login`.

That last point is deliberate. Session cookies are **host-only** — no `domain`
attribute — so a cookie set on the apex would be useless on the clinic's
subdomain, and a cookie set on the parent domain would be sent to _every_
clinic. The browser is therefore sent to the clinic's own address to sign in
there.

### A clinic owner — provisioned by rcln

Same service, same transaction, same invariants. A platform admin fills the form
in the console, optionally converting a demo request. The only difference is who
the audit row records as the actor.

### Clinic staff

Designed: an invitation with a link, which the invitee accepts by setting a
password. **Not built yet** — this is the next slice. Today the only account a
clinic has is the owner created at registration.

### Signing in, either way

Two methods, both at the clinic's own subdomain:

- **Password** — identifier is email _or_ phone.
- **Code by SMS** — a 6-digit OTP, valid 5 minutes, 5 attempts.
  **Delivery is a logging stub** pending TRAI DLT registration; the code appears
  in the API logs, not on a handset. All the logic around it is real.

Two behaviours worth knowing, because they look like bugs and are not:

- **Every failure gives the same message.** Wrong password, unknown email, and
  "you are a real user but not a member of _this_ clinic" are indistinguishable.
  Anything else would let someone enumerate who works where.
- **Five failures locks the account for 15 minutes**, after which even the
  correct password is refused. A success resets the counter.

---

## 4. What happens to one request

The middleware order in `apps/api/src/app.ts` **is** the security model. It is
not a style choice, and reordering it breaks things quietly.

```
helmet / cors            reject before doing any work
  ↓
body parsing             1mb cap
  ↓
request id + logging     pino, with PII redaction
  ↓
rate limit               Redis-backed, so it holds across containers
  ↓
resolveTenant            Host → organization, Redis-cached 300s
  ↓
authenticate             JWT → users.id, and the session row must still be live
  ↓
authorize(PERMISSION)    membership + roles → yes or no, at the active branch
  ↓
withTenant(ctx, …)       BEGIN; set_config(app.current_org, …); … COMMIT
  ↓
handler
```

Two rules that come up constantly:

- **An unknown tenant returns 404, never 403.** So does a token presented to the
  wrong clinic, and so does a branch you hold no assignment for. A 403 confirms
  existence, and existence is the customer list.
- **The permission list is never in the JWT.** It goes stale the moment a role
  changes. It is resolved per request and cached in Redis for 60 seconds.

### One wrinkle worth knowing about

The browser talks to Next, and Next talks to the API server-to-server. That
second hop cannot set a `Host` header — `Host` is a forbidden header name in the
`fetch` spec and is silently dropped. So the BFF sends **`x-forwarded-host`**,
and `resolveTenant` prefers it.

This matters operationally: **the API must not be publicly reachable except
behind an ingress that overwrites `x-forwarded-host`.** See the comment on
`requestedHost()` in `tenant.middleware.ts`.

---

## 5. Sessions and tokens

| Thing              | Lifetime | Where it lives                                      |
| ------------------ | -------- | --------------------------------------------------- |
| Access token (JWT) | 15 min   | `rcln_at` cookie, httpOnly, host-only               |
| Refresh token      | 30 days  | `rcln_rt` cookie, httpOnly, host-only; hashed in DB |
| Session row        | —        | `sessions`, revocable server-side                   |

- **Tokens never reach client JavaScript.** Next is a BFF: cookies are httpOnly,
  and the browser never calls the API directly.
- **Refresh rotates.** Each use issues a new refresh token and retires the old
  one. **Replaying a retired token revokes the entire family** — that is reuse
  detection, and it assumes a stolen token.
- **Revocation is real.** `authenticate` checks the `sessions` row on every
  request, so signing out kills a JWT that has not expired yet.
- **Switching branch** re-issues the access token with the new branch and leaves
  the refresh token alone.

---

## 6. How "can this person do this?" is answered

Permissions are strings like `branch.update`, `iam.user.invite`,
`platform.impersonate` — 83 of them, seeded, in `packages/permissions/src/codes.ts`.
Twelve system roles bundle them (`ORG_OWNER`, `ORG_ADMIN`, `BRANCH_ADMIN`,
`DOCTOR`, `NURSE`, `RECEPTIONIST`, …).

The resolver answers in a fixed order, first match wins:

```
1. an explicit DENY override on this membership   → no
2. an explicit GRANT override on this membership  → yes
3. a role grant whose assignment covers this branch → yes
4. otherwise                                       → no
```

**DENY always beats GRANT, and both beat role grants.** Branch scoping applies at
every step: an assignment with `branch_id = NULL` covers every branch; one naming
a branch covers only that branch.

A platform admin short-circuits all of it — and that bypass is logged every time.

### Which branches you can touch

`branchIds` is **derived, not stored**. An org-wide assignment expands to "every
branch in the organization" at request time.

That has a consequence that has already bitten once: adding a branch changes
every org-wide member's effective scope _without touching a single
`membership_roles` row_, so the 60-second permission cache has to be dropped
explicitly. See [PITFALLS](PITFALLS.md), "A new branch is invisible to the person
who just created it".

---

## 7. Keeping clinics apart

Three independent layers. Any one failing should not leak data.

**1. Postgres row-level security.** Every tenant table carries a policy:

```sql
USING (organization_id = app_current_org())
```

`app.current_org` is a transaction-local session variable set by `withTenant()`.
With no tenant context the policies match nothing — they **fail closed**.

The app connects as `rcln_app`, which owns nothing and cannot bypass RLS.
Migrations connect as `rcln_owner`, which can. `assertRlsActive()` refuses to
boot the API on an owner connection.

Fourteen tables are protected. Four of them have no `organization_id` of their
own (`branch_operating_hours`, `branch_closures`, `invitation_branches`,
`staff_profiles`) and are isolated through their parent with an `EXISTS` check.

**2. Composite foreign keys.** Child rows reference `(organization_id, id)`, so a
row pointing at another tenant's branch is not merely forbidden — it is
unrepresentable. Foreign keys bind every role, including the owner.

**3. Application scoping.** Services pass `organizationId` explicitly even though
RLS also enforces it. Defence in depth.

`pnpm db:rls:check` fails CI if a tenant table ships without a policy — because a
missing policy produces **no error and breaks no single-tenant test**. It just
starts returning other clinics' records.

---

## 8. What you can actually do today

Working end to end:

- Register a clinic (self-serve, or provisioned by an admin from a demo request)
- Sign in by password or by SMS code; refresh, sign out, switch branch
- **Branches**: list, create, edit, retire (soft delete), and set opening hours
  for the week
- The public marketing site and the demo-request form
- The platform console: demo-request pipeline and provisioning

Not built yet — designed, with the schema already in place:

- Invitations and the accept flow
- Roles and permission-override management in the UI
- Super-admin impersonation
- Organization settings
- Email and phone verification

Every mutation writes an **audit row** carrying the actor and a field-level
before/after diff. Credentials are recorded as changed, never recorded.

---

## 9. See it for yourself

Start everything (this also migrates and seeds):

```bash
docker compose up
```

Then, with the demo clinic already registered:

```bash
# The clinic. Sign in, then look at Branches.
open http://northwind.lvh.me:3000
#   asha@northwind.test / CorrectHorse9Battery

# The platform console. Your super-admin password is in .env.
open http://admin.lvh.me:3000

# The public site.
open http://lvh.me:3000
```

Prove tenant isolation from the command line — this is the whole product in four
commands:

```bash
# Sign in to the clinic.
TOKEN=$(curl -s -X POST http://localhost:5000/api/v1/auth/login \
  -H 'X-Forwarded-Host: northwind.lvh.me' -H 'Content-Type: application/json' \
  -d '{"identifier":"asha@northwind.test","password":"CorrectHorse9Battery"}' \
  | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')

# Its own branches: 200.
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5000/api/v1/branches \
  -H 'X-Forwarded-Host: northwind.lvh.me' -H "Authorization: Bearer $TOKEN"

# The same token against a clinic that does not exist: 404, not 403.
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5000/api/v1/branches \
  -H 'X-Forwarded-Host: nosuchclinic.lvh.me' -H "Authorization: Bearer $TOKEN"

# The clinic owner reaching for the platform console: 404, not 403.
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5000/api/v1/platform/demo-requests \
  -H 'X-Forwarded-Host: admin.lvh.me' -H "Authorization: Bearer $TOKEN"
```

Watch RLS fail closed with no tenant context:

```bash
docker compose exec postgres psql -U rcln_app -d rcln \
  -c 'SELECT count(*) FROM branches;'      # 0 rows, no error
```

---

## 10. Where the code lives

| Looking for                       | Go to                                                                   |
| --------------------------------- | ----------------------------------------------------------------------- |
| Hostname → tenant                 | `apps/web/src/proxy.ts`, `apps/api/src/middleware/tenant.middleware.ts` |
| Who is this / may they do it      | `apps/api/src/middleware/auth.middleware.ts`                            |
| Permission resolution             | `packages/permissions/src/resolver.ts`                                  |
| Registration, the one transaction | `apps/api/src/services/organization/register.service.ts`                |
| Sign-in, OTP, refresh rotation    | `apps/api/src/services/auth/`                                           |
| Branch CRUD + opening hours       | `apps/api/src/services/branch/branch.service.ts`                        |
| Tenant-scoped database access     | `packages/db/src/tenant.ts`                                             |
| RLS policies                      | `packages/db/prisma/rls/enable-rls.sql`                                 |
| The isolation proof               | `apps/api/tests/integration/tenant-isolation/`                          |
| Session cookies, the BFF          | `apps/web/src/lib/session.ts`, `apps/web/src/lib/api.ts`                |

Before changing anything structural, read the relevant
[ADR](decisions/). Before debugging something odd, read
[PITFALLS](PITFALLS.md) — most of the strange behaviour in this codebase is
already written down there, and almost all of it typechecked cleanly.
