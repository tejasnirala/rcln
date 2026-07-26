# 12 · Testing Strategy

**Version:** 1.0 · **Verified** from `apps/api/jest.config.ts`,
`packages/permissions/jest.config.ts` and the test files themselves.

---

## Where the tests are

**Verified.** 200 tests total — 175 API, 25 permissions.

| Suite                                                 | Cases                | Kind        | What it protects                                                                                                    |
| ----------------------------------------------------- | -------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------- |
| `packages/permissions/tests/resolver.test.ts`         | 22 blocks / 25 cases | Unit        | The whole multi-branch permission matrix, DENY > GRANT > role, validity windows                                     |
| `apps/api/tests/unit/audit-diff.test.ts`              | 8                    | Unit        | The before/after diff logic                                                                                         |
| `apps/api/tests/integration/tenant-isolation.test.ts` | 22                   | Integration | **The most important file in the repo.** Cross-tenant access, including six pinning the `own_membership` boundaries |
| `apps/api/tests/integration/iam.test.ts`              | 41                   | Integration | Roles, members, overrides, suspension, the escalation guards                                                        |
| `apps/api/tests/integration/invitations.test.ts`      | 26                   | Integration | Issue, revoke, resend, accept                                                                                       |
| `apps/api/tests/integration/branches.test.ts`         | 24                   | Integration | Branch CRUD and operating hours                                                                                     |
| `apps/api/tests/integration/auth.test.ts`             | 22                   | Integration | Login, OTP, enumeration resistance, rate limits, cross-tenant token → 404                                           |
| `apps/api/tests/integration/session-rotation.test.ts` | 12                   | Integration | Rotation, and reuse revoking the family                                                                             |
| `apps/api/tests/integration/registration.test.ts`     | 11                   | Integration | The one-transaction registration, and that the four RLS-enforced tables land scoped                                 |
| `apps/api/tests/integration/demo-requests.test.ts`    | 8                    | Integration | Honeypot, timing, dedupe, silent discard                                                                            |

Run them:

```bash
docker compose exec api pnpm test                       # everything
docker compose exec api pnpm --filter @rcln/api test
docker compose exec api pnpm --filter @rcln/permissions test
docker compose exec api pnpm test:coverage
```

---

## The philosophy

**Verified** from `Architecture/CONVENTIONS.md` and the code.

> **Integration tests run against real Postgres, real migrations and real RLS.
> Never mock Prisma.**

The reason is specific rather than dogmatic: **a mocked Prisma client cannot
fail an RLS policy.** The failure mode this system most needs to catch — a query
that returns another tenant's rows — is invisible to any test that does not talk
to a real database with real policies as a real non-owner role.

Integration tests go over **real HTTP via supertest**, through the full
middleware chain. Testing the service directly would skip `resolveTenant`,
`authenticate` and `authorize` — which is where most of the security lives.

---

## The tenant-isolation suite

**Treat it as the most important file in the repository.** Every new tenant
table gets a case. The pattern: seed two organizations, then assert that org B
gets nothing when reaching for org A's rows — and that the answer is **404, not
403**.

`db:rls:check` and this suite are complementary and neither replaces the other:

| Check                      | Catches                               |
| -------------------------- | ------------------------------------- |
| `pnpm db:rls:check`        | A table that has **no policy at all** |
| `tenant-isolation.test.ts` | A policy that exists and is **wrong** |

---

## Configuration worth knowing

**Verified** in `apps/api/jest.config.ts`.

- **ESM natively**, via `ts-jest/presets/default-esm` and
  `NODE_OPTIONS=--experimental-vm-modules`. A `moduleNameMapper` rewrites the
  `.js` specifiers that ESM source uses back onto `.ts` files.
- **One worker.** These share one Postgres and one Redis, and several suites
  flush `rl:*` before a request so the rate limiters do not count another
  suite's traffic. In parallel that is exactly backwards — one suite's flush
  lands mid-count in another, and the rate-limit cases fail depending on which
  worker got there first. **Do not "speed up the tests" by re-enabling
  parallelism.**
- **30-second timeout**, because these are integration suites.
- Coverage is collected from `src/**` excluding `index.ts`, `*.d.ts` and
  `types/`.

---

## What is measured, and what is not

**Verified as tested:**

- Permission resolution across the full multi-branch matrix
- Tenant isolation at the database level
- Auth: enumeration resistance, lockout, rotation, reuse detection, cross-tenant
  tokens
- Every shipped endpoint, over real HTTP, through the real chain
- The escalation guards — `iam.test.ts` contains cases that were **measured to
  fail** with a guard removed (one returns 500 instead of 404; another succeeds
  with 201 and a real escalated grant)

**Verified as NOT tested** — `STATUS.md` is explicit about these:

| Gap                                                                                                                      | Why it matters                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **No E2E tests.** No Playwright, no browser automation                                                                   | The signup → login flow has never been exercised in a real browser                                                                          |
| **No screen-reader verification.** The accessibility work is implemented and code-reviewed, never exercised in a real AT | An accessibility claim that has not been tested with the tool it is for                                                                     |
| **No reduced-motion verification** against the OS toggle                                                                 | Same                                                                                                                                        |
| **No load testing.** No k6, no baseline, no p95                                                                          | And multi-tenant failure modes differ from single-tenant ones — 50 concurrent _tenants_ is the interesting test, not 50 users on one tenant |
| **No property-based tests.** `fast-check` is specified for billing maths                                                 | Billing does not exist yet, so this is a debt being taken deliberately                                                                      |
| **No frontend tests at all.** No component, hook or Server Action tests                                                  | `apps/web` has meaningful logic in Server Actions and form state                                                                            |
| **No coverage threshold enforced**                                                                                       | Coverage is collected on demand and never gated                                                                                             |
| **No mutation testing, no fuzzing, no contract tests**                                                                   |                                                                                                                                             |

---

## Test gaps by risk

| #   | Gap                              | Risk     | Note                                                                                                                 |
| --- | -------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | No E2E                           | **High** | Every user-facing flow is verified only at the API layer. A working API and a broken screen look identical from here |
| 2   | No frontend tests                | **High** | Server Actions carry real logic — auth handling, error mapping, redirects                                            |
| 3   | No load test                     | Medium   | Nothing has run on more than one instance, and PgBouncer is absent                                                   |
| 4   | AT and reduced-motion unverified | Medium   | A published accessibility claim with no evidence                                                                     |
| 5   | No coverage gate                 | Low      | Coverage is good where it exists; the gate would mostly prevent regression                                           |
| 6   | No dependency/image scanning     | Medium   | Not a test gap strictly, but the same class of missing gate                                                          |

---

## Adding tests

**A new tenant table** — a case in `tenant-isolation.test.ts` is mandatory, not
optional. `db:rls:check` will pass with a policy that is subtly wrong; only the
test catches that.

**A new endpoint** — an integration case over real HTTP covering the happy path,
the permission denial, and a cross-tenant attempt returning 404.

**A new permission or role change** — a case in `resolver.test.ts`. It needs no
database, so it is cheap.

**A new business rule** — the rule in
[`07_Business_Rules.md`](07_Business_Rules.md) should name the test that pins
it. A rule with no test is a comment.

### The pattern to copy

`apps/api/tests/integration/branches.test.ts` is the cleanest example of the
house style: local `hostFor`, `asOrg`, `tokenFor` and `payload` helpers, two
seeded organizations, and assertions through supertest against the real app.
Read it before writing a new suite.
