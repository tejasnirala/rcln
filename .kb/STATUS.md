# Status

Living document. Update it when a phase completes or direction changes.

**Last updated:** 2026-07-26 · **Current phase:** 0 complete, **1 complete
except the legal sign-off** (onboarding, auth, branch CRUD, invitations,
role/member management, email/phone verification, org settings and super-admin
impersonation all shipped)

---

## Where we are

Phase 0 (foundation) is done and verified. Nothing product-facing ships in
Phase 0, and that is correct — every shortcut taken in tenancy or access control
becomes a data breach later.

The repository is a working monorepo that starts with one command, isolates
tenants at the database level, and proves it with tests.

**A clinic can now register and sign in.** Self-serve at the apex, or provisioned
by a platform admin from a demo request — both go through one transaction that
creates organization, subdomain, first branch, owner, membership, `ORG_OWNER`
grant and a trial subscription. Password and phone-OTP login both work, with
refresh rotation and reuse detection behind them.

**And a clinic can now be run.** It can open branches and set their opening
hours, invite colleagues and have them accept, define its own roles by cloning
the built-in ones, hand those roles out per branch or clinic-wide, make
per-person exceptions to them, and suspend someone's access — with every one of
those changes on an audit row carrying ids and permission codes, never names.

---

## Done

### Repository and tooling

- [x] pnpm workspace + turbo; `apps/{api,web,worker}`, `packages/{db,contracts,permissions,config}`
- [x] Merged the two predecessor repos (`expresswithpsql` → `apps/api`, `frontend` → `apps/web`)
- [x] Shared eslint / tsconfig / prettier presets in `@rcln/config`
- [x] Husky: prettier on commit, typecheck + lint + RLS check on push, protected-branch guard
- [x] GitHub Actions: static job (lint/typecheck/format) + database job (migrations, RLS, tests)
- [x] Remote set to `git@gp:tejasnirala/rcln.git` — **not yet pushed**

### Database (Phase 0 scope only)

- [x] Prisma schema: tenancy, subscriptions, identity, RBAC, settings, files, audit — 31 models
- [x] Composite FKs on `(organization_id, id)` so cross-tenant rows are unrepresentable
- [x] `NULLS NOT DISTINCT` indexes — plain unique indexes do not constrain nullable columns
- [x] Trigger preventing a tenant from shadowing a system role code
- [x] RLS policies on all 10 tenant tables, failing closed with no context
- [x] `rcln_owner` / `rcln_app` role split; `assertRlsActive()` refuses to boot on an owner connection
- [x] `db:rls:check` — CI guard against a tenant table shipping without a policy
- [x] Seed: 83 permissions, 12 system roles, 12 setting definitions, 3 plans, super admin

### Application

- [x] Tenant resolution from the `Host` header, Redis-cached, negative-cached
- [x] `withTenant()` / `forTenant()` — transaction-local session vars, pool-safe
- [x] Permission resolver: DENY > GRANT > role grants, branch-scoped, validity windows
- [x] Redis-backed rate limiting (general, auth, per-phone OTP)
- [x] pino logging with PII redaction; health + readiness endpoints
- [x] Next.js 16 `proxy.ts` — subdomain → `/t/<slug>`, `admin.` → `/platform`

### Infrastructure

- [x] `docker compose up` runs the whole stack with hot reload, Docker as the only prerequisite
- [x] Shared dev image; entrypoint reconciles deps, generates Prisma, waits for Postgres
- [x] `.dockerignore` — build context 996 MB → 1.4 MB (58,347 files → 110)
- [x] Production Dockerfiles for api, web, worker; api image 476 MB, smoke-tested

### Marketing surface (apex domain)

Out of phase order, but it is the first product-facing thing and it fixes the
design system every later screen inherits.

- [x] Landing page at the apex domain — hero, the six-station journey rail,
      modules, multi-branch, isolation, India-first, pricing, demo form, footer
- [x] **The design system**: surgical-green palette, IBM Plex display/sans/mono
      with mono reserved for identifiers, spacing and radius scale — all in
      `apps/web/src/app/globals.css`. Read it before building any screen; do not
      start a second system (`apps/web/AGENTS.md`)
- [x] `app/` split into `(marketing)` / `(tenant)` / `(platform)` route groups.
      URLs unchanged, so `proxy.ts` needed no edit
- [x] `POST /api/v1/public/demo-requests` — pre-tenant, rate-limited, honeypot +
      timing check, silent discard, deduplicated. Writes `demo_requests`, which
      is **deliberately outside RLS** with the reason recorded in
      `enable-rls.sql` and `check-rls.ts`
- [x] `allowedDevOrigins` — without it nothing hydrates on any hostname off the
      root domain, silently. → PITFALLS
- [x] **Accessibility pass, measured**: contrast (the accent was darkened to
      clear 4.5:1 on every light surface), 24×24 targets, skip link, a pause
      control for the auto-advancing rail, `aria-describedby` on every field
      with focus moved to the first error, `inert` honeypot, and a focus ring
      that stays visible on the dark section. Rules recorded in
      `apps/web/AGENTS.md` so later screens inherit them
- [x] Responsive verified 320–1600px: no page overflow at any width, including
      with the rail driven to its last station (which used to drag five sixths
      of the page off the right edge above 640px)
- [ ] Not verified by machine: screen-reader behaviour in a real AT, and the OS
      reduced-motion toggle. Both are implemented and code-reviewed, neither has
      been exercised end to end
- [ ] Legal pages (`/legal/privacy`, `/terms`, `/dpa`) — footer links are dead
- [ ] Analytics provider — `src/lib/analytics.ts` is a no-op seam pending a DPDP
      consent decision
- [ ] Real OG image, and the placeholder brand facts in the footer

### Onboarding and auth (Phase 1)

- [x] `authenticate` / `requireAuth` / `authorize` / `requirePlatformAdmin` /
      `tenantContextFrom` — the prerequisite the rest of Phase 1 was blocked on
- [x] `POST /public/organizations/register` — org + domain + first branch + owner + membership + `ORG_OWNER` + trial, **one transaction**. Pre-tenant, so it
      sets the tenant session vars _mid-transaction_ once the org row exists:
      three of its tables are RLS-exempt and four are not. See the header comment
      in `register.service.ts` before touching it
- [x] `GET /public/organizations/check-slug` — rate-limited hard; it is a
      customer-list oracle by construction
- [x] `POST /platform/organizations` — same service, admin as the audited actor,
      optionally converting a `demo_request`
- [x] `POST /auth/login` — password, identifier is email or phone. Constant-time
      failure and one message for every cause, including "not a member here"
- [x] `POST /auth/otp/request` + `/otp/verify` — hashed, single-use, attempt-capped.
      **Delivery is a logging stub** behind `services/notification/sender.ts`
      pending TRAI DLT; all the logic is real
- [x] `POST /auth/refresh` — rotation, and replaying a rotated token revokes the
      whole family
- [x] `POST /auth/verify/{email,phone}/{request,confirm}` — self-service, no
      permission code, metered per account and channel. Shares the code
      mechanics with OTP login via `services/auth/challenge.service.ts`, and is
      idempotent with the `phoneVerifiedAt` that a successful OTP login already
      writes
- [x] `POST /auth/logout`, `GET /auth/session`, `POST /auth/switch-branch`,
      `POST /auth/switch-organization`
- [x] Account lockout after 5 failures
- [x] Web: `/signup` (4 steps, live slug check), tenant login (password + code),
      authenticated shell with branch switcher, platform console with the
      demo-request pipeline and provisioning
- [x] Session in httpOnly, **host-only** cookies — no `domain` attribute, so a
      session at alpha is useless at beta. Next is the BFF; tokens never reach
      client JS
- [x] `own_membership` RLS policy — without it `authSession.memberships` is
      silently always empty. → [ADR-0011](Architecture/decisions/0011-own-membership-identity-bootstrap.md)

### Tests

- [x] 25 permission-resolver cases (the whole multi-branch admin matrix)
- [x] 17 tenant-isolation cases, including the six that pin the `own_membership`
      boundaries
- [x] 10 registration cases — the load-bearing ones, proving the four
      RLS-enforced tables land scoped and invisible to the other tenant
- [x] 11 session-rotation cases, including reuse detection revoking the family
- [x] 18 auth cases over real HTTP via supertest — cross-tenant token → 404,
      revoked session → 401, enumeration resistance
- [x] 7 `POST /public/demo-requests` cases (the gap noted here previously)
- [x] 23 branch cases, 25 invitation cases, 40 role/member cases — all over real
      HTTP through the full middleware chain
- [x] 17 verification cases, including the one measured to return 200 without the
      `userId` pin on the challenge lookup, the OTP-login idempotency sequence run
      for real rather than simulated, and the master code proven not to satisfy
      `/auth/otp/verify` while a live LOGIN_OTP token is waiting
- [x] 40 org-settings cases, of which four were measured to fail with the
      `scopeId` pin removed — `setting_values` and `organizations` are both
      RLS-exempt, so those four are the entire tenant boundary on that screen
- [x] 20 impersonation cases, two of which were measured by deleting the guard
      first: without the cross-host check on the handoff ticket, clinic A's
      ticket opens a working session inside clinic B and files an audit row
      there; without the branch-scope resolution in `authenticate`, the clinic
      reads as empty
- [x] 8 audit-diff unit cases
- **279 tests, all green** (252 API + 27 permissions). `db:rls:check` green,
  14 protected tables — impersonation added no tenant table, and its cross-host
  boundary is application code by necessity
- [ ] Not verified by machine: the signup → login flow in a real browser

---

## Not done

### Phase 1 — remaining

- [x] Branch CRUD, operating hours — `branches.routes.ts`, the week strip screen
- [x] Invitations + accept flow — issue, revoke, resend, and an unauthenticated
      `/join` page. Delivery is the same logging stub
- [x] Roles and permission-override management — `/roles` and `/members`, custom
      roles cloned from the read-only system ones, per-person GRANT/DENY
      exceptions, suspension. Four escalation guards, none of which the database
      enforces; see `services/iam/guards.ts` and the PITFALLS entry on
      RESTRICTIVE policies
- [x] Super-admin impersonation — `POST /platform/organizations/:id/impersonate`
      (reason required, min 10 chars), redeemed at the clinic's own host by
      `POST /auth/impersonation/claim`, ended by `POST /auth/impersonation/stop`.
      A platform console layout, a `/organizations` screen, and a
      non-dismissible ink banner in the `(app)` shell.
      **Full access, no write block, no elevation step — this overrules
      `architecture.md` §6.** → [ADR-0012](Architecture/decisions/0012-impersonation-is-full-access-and-audited.md)
      ⚠️ Three things hold it together and each is load-bearing:
      the session is 30 minutes with **no refresh token**, so nothing can renew
      it; `authenticate` resolves a branch scope from the organization's own
      branches, because a platform admin has no membership and an empty scope
      under RESTRICTIVE `branch_isolation` presents as an empty clinic rather
      than as full access; and the handoff between hosts is a single-use Redis
      ticket bound to one organization, because session cookies are host-only
      and `admin.<root>` cannot write one for a clinic's subdomain.
      `effectivePermissions` now bypasses for a platform admin, matching `can` —
      it previously returned `[]` for a caller every endpoint says yes to
- [x] Org settings — `GET/PATCH /organization` and
      `GET/PUT/DELETE /organization/settings[/:key]`, plus a `/settings` screen
      whose signature is the inheritance line: every row states whether the
      clinic set the value, rcln set it, or nobody did, and what clearing would
      restore. ⚠️ **Both tables are RLS-EXEMPT** — `organizations` because the
      tenant is resolved from it, `setting_values` because it is keyed by
      `(scope_type, scope_id)` — so the explicit `where` in
      `organization.service.ts` / `setting.service.ts` is the only isolation
      there is, and `db:rls:check` will never notice a missing one. Editing the
      org drops the host → tenant cache, because currency and timezone live in
      it. The slug is deliberately not editable.
      Settings whose values are a closed set carry `allowed_values` on
      `setting_definitions` (migration `20260726100316`), so the API refuses an
      off-list value and the screen renders its `<select>` from the same column
      — adding a choice stays an INSERT. `help_text` is the per-setting
      explanation. Time zone and currency are validated against `Intl` rather
      than a hand-kept list
- [x] Legal pages — `/legal/{privacy,terms,dpa}` written and linked from the
      footer and the signup consent checkbox. **Drafts.** Each carries a visible
      "not yet in force" banner and 30 unfilled placeholders; they are structured
      correctly (clinic = Data Fiduciary, rcln = Data Processor; erasure resolved
      as anonymisation per the decision below) but are not counsel-reviewed
- [ ] **Fill the legal placeholders and get sign-off.** Entity name, CIN,
      registered address, DPO, grievance contact, notice periods, real
      subprocessor list, uptime target. Then remove the draft banner.
      `grep -rn "Placeholder>" "apps/web/src/app/(marketing)/legal"`
- [x] Email/phone verification — four routes on the auth router, a `/verify`
      screen and a prompt in the `(app)` shell. ⚠️ `users` is RLS-EXEMPT, so the
      explicit `where id = :userId` in `verification.service.ts` is the only
      isolation there is. Delivery is the same logging stub, so a
      **development-only master code** (`DEV_MASTER_VERIFICATION_CODE`, default
      `123456`) confirms either channel — null in production, fatal at boot if
      set there, and it logs nobody in. Delete it with the stub

### Phase 2 — Subscriptions

- [ ] Razorpay integration (UPI Autopay / e-mandate; Stripe is weak for Indian recurring)
- [ ] Entitlement gate: `subscription_feature_overrides` → `plan_features` → default
- [ ] Usage counters enforcing `max_branches` / `max_users` at write time
- [ ] Dunning: retry d1/d3/d7 → `PAST_DUE` → 7-day grace → `SUSPENDED` (read-only, never delete)

### Phase 3 — Core clinical

- [ ] Patients, `patient_registrations` (branch-local MRN), allergies/conditions/medications
- [ ] Appointments, status history, queue tokens
- [ ] Encounters, vitals
- [ ] Prescriptions + masters (symptoms, diagnoses, procedures)
- [ ] `clinical_form_templates` — the extension point for per-specialty forms

### Phase 4 — Billing

- [ ] `billable_items`, `invoices`, `invoice_items`, GST tax lines
- [ ] `payments` + `payment_allocations` (one payment across several invoices)
- [ ] `number_sequences` with financial-year reset
- [ ] Credit notes, refunds, patient ledger

### Phase 5 — Pharmacy and inventory

Strictly in this order; dispensing depends on batches existing.

- [ ] Catalogue: generics, medicines, manufacturers, HSN + versioned tax rates
- [ ] Suppliers → purchase orders → goods receipts → returns
- [ ] Batches, `stock_ledger` (append-only), `stock_balances` (trigger-maintained)
- [ ] Stock transfers between branches, adjustments, reorder rules
- [ ] Dispensing with FEFO batch selection

### Phase 6 — Lab

- [ ] Labs, tests, `lab_test_parameters` (a CBC has 20+ measured values)
- [ ] Orders → samples → results → verification → release

### Phase 7 — Cross-cutting

- [ ] Notification templates + providers (WhatsApp via BSP, MSG91 SMS, SES email)
- [ ] Worker processors — every queue is registered but only stubs exist
- [ ] `daily_branch_metrics` rollup + dashboards
- [ ] Settings UI over `setting_definitions` / `setting_values`
- [ ] Audit log viewer, `data_access_logs` on PHI reads

---

## Blocked / needs a human

- [ ] **TRAI DLT registration** — entity, header, per-template. 1–2 weeks, hard-blocks SMS. Start early.
- [ ] **Meta WhatsApp template approval** — ~2–3 days per template.
- [ ] **Razorpay account** + webhook secret.
- [ ] **Decision: patient payments.** Acting as merchant of record (Razorpay Route) makes you a payment aggregator with RBI implications. The v1 escape hatch is each clinic connecting their own gateway.
- [x] **Decision: DPDP erasure vs medical retention.** Resolved as irreversible anonymisation rather than deletion — identifying fields destroyed, the clinical record retained for the statutory period without a subject. Written down in the privacy policy (clause 7) and the DPA (clause 5). **Not yet implemented:** no anonymisation routine exists in code, and those documents now promise one.

---

## Deliberately deferred

Recorded so a future session does not "discover" them as gaps.

| Not built                  | Why                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| IPD / beds / OT scheduling | `encounters.encounter_type = 'IPD'` is the hook; the module is additive                           |
| Insurance claims / TPA     | `patient_insurances` holds the policy; adjudication is its own subsystem                          |
| ABDM / ABHA integration    | `patients.abha_number` + consents only. Session state belongs in Redis, not Postgres              |
| Schema-per-tenant          | Shared schema + RLS scales without migration fan-out; `organization_id` keeps extraction possible |
| `packages/ui`              | An empty shadcn package is noise until there are components                                       |
| tRPC / ts-rest             | Zod contracts in `@rcln/contracts` cover it; revisit if a mobile app appears                      |
