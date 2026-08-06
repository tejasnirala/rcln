# Status

Living document. Update it when a phase completes or direction changes.

**Last updated:** 2026-08-05 · **Current phase:** 0 complete; 1 complete except
the legal sign-off (onboarding, auth, branch CRUD, invitations, role/member
management, email/phone verification, org settings, super-admin impersonation,
one unified shell, remembered scope and per-record history); **2 complete except
usage enforcement, notifications and tax** — subscriptions, payments, pro-rata
upgrades, cancellation and recurring billing all run end to end

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
- [x] Seed: 84 permissions, 12 system roles, 12 setting definitions, 3 plans, super admin

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
- [x] 23 impersonation cases, two of which were measured by deleting the guard
      first: without the cross-host check on the handoff ticket, clinic A's
      ticket opens a working session inside clinic B and files an audit row
      there; without the branch-scope resolution in `authenticate`, the clinic
      reads as empty. Two more measure the session ceiling added with the
      remembered-clinic work — a renewal slides to 30 minutes from now (NOT to the
      ceiling: the first clamp took `min(ceiling, 30 days)`, which always picked the
      ceiling and silently deleted the idle window), the ceiling trims a renewal on
      a session backdated to 7h50m, and an ordinary session still gets 30 days
- [x] 8 audit-diff unit cases
- [x] 8 audit-history cases over HTTP, one of which was measured by disabling RLS
      on `audit_logs` first: without the policy, clinic B reads clinic A's trail
      given only the record id
- [x] 6 append-only cases at the database — the app is refused UPDATE and DELETE
      both by grant and by trigger, in its OWN tenant with the row visible (an
      out-of-context attempt reports 0 rows and proves nothing), and the owner
      exemption still permits the `SET NULL` a user deletion depends on
- **297 tests, all green** (270 API + 27 permissions). `db:rls:check` green,
  14 protected tables, plus the audit-immutability guard — impersonation added no tenant table, and its cross-host
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
      A `/organizations` screen and a non-dismissible ink strip in the `(app)`
      shell.
      **Full access, no write block, no elevation step — this overrules
      `architecture.md` §6.** → [ADR-0012](Architecture/decisions/0012-impersonation-is-full-access-and-audited.md)
      ⚠️ Three things hold it together and each is load-bearing:
      the session renews but is capped at **8 hours from `created_at`**, clamped
      in `rotateRefreshToken` — which is the one function that extends a session
      and therefore the one place it can be bounded (**amended**; it was 30
      minutes with no refresh token at all); `authenticate` resolves a branch
      scope from the organization's own branches, because a platform admin has no
      membership and an empty scope under RESTRICTIVE `branch_isolation` presents
      as an empty clinic rather than as full access; and the handoff between hosts
      is a single-use Redis ticket bound to one organization, because session
      cookies are host-only and `admin.<root>` cannot write one for a clinic's
      subdomain.
- [x] **One shell for the whole application** — `components/shell/`: `AppHeader`,
      `AppNav`, `ScopeSwitcher`/`ScopeLabel`, `SignOutButton`, `PlatformStrip`.
      The platform console had its own dark-header layout; it now wears the same
      light header a clinic does, with the dark strip above it. The header's left
      edge is a **scope chain** — one segment per level of the tenancy model, and
      how many you get is decided by who you are: a branch for a doctor, clinic +
      branch for an owner, a _switchable_ clinic + branch for a super admin.
      `TenantHeader` is no longer a client component; only the switcher and the
      sign-out button are
- [x] **Remembered scope** — a clinic selector in the console header, and two
      nullable columns behind it (`memberships.last_branch_id`,
      `users.last_platform_organization_id`). Both are preferences, never trusted
      on read: `defaultBranchId` filters the remembered branch through the scope
      freshly derived from `membership_roles` and re-checks it is ACTIVE.
      Pre-selected, **not** pre-entered — entering still asks why, because signing
      in is not a stated reason
- [x] **Per-record history** — `GET /api/v1/audit?entityType=&entityId=` behind the
      new `audit.record.read` code, and one `RecordHistory` drawer reused on
      branches, staff and custom roles. Shows what moved field by field, who did
      it, and — when it was rcln staff inside the clinic — who was really behind
      it. Actor names are joined on the way out; the row stores an id only.
      ⚠️ **`audit_logs` is append-only, enforced by Postgres in two independent
      layers**: `rcln_app` holds no UPDATE or DELETE (the blanket grant in
      `infra/postgres/init` is carved out), and a trigger refuses both even if that
      grant is restored — which a re-run of the init script would do silently. The
      trigger exempts the table owner, deliberately: `actor_user_id` is ON DELETE
      SET NULL from `users` and `organization_id` is ON DELETE CASCADE, so a
      blanket refusal would make deleting any user who ever touched a record fail.
      `db:rls:check` asserts both layers. There is deliberately **no delete path
      through the application, for anyone including a platform admin** — removing
      history is an owner-credential operation, outside the app. A super admin can
      enter any clinic and change anything (ADR-0012), and this trail is the only
      control over that; a button that erases it would be handed to exactly the
      actor it exists to constrain
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

**Built and verified end to end against the mock provider.** Registration →
checkout → webhook → active; pro-rata upgrade; mandate authorisation;
auto-renewal debited off-session by the worker; cancel and resume. A replayed
webhook is refused by the ledger, and a declined charge grants nothing.

- [x] **Provider abstraction** (`@rcln/payments`). `PaymentProvider` is the only
      seam: normalised statuses, no provider strings above it, integer minor
      units, no FX. Swapping acquirer is one file under `providers/`, one line
      in the registry and an environment variable — no migration, no contract
      change, no screen
- [x] **Cashfree adapter** — orders for hosted checkout, `ON_DEMAND`
      subscriptions used purely as mandate holders, refunds, HMAC webhook
      verification with replay protection. ⚠️ Written from the documentation and
      **not yet exercised against a live sandbox**; reconcile the field names
      before pointing production at it
- [x] **Razorpay adapter** — payment links for hosted checkout, auth links
      (`frequency: as_presented`) as mandate holders, recurring debits against
      the resulting token, refunds, and hex-HMAC webhook verification. Amounts
      are already minor units, so there is no decimal round-trip. Three things
      differ from Cashfree and each is a guard: test and live share one URL, so
      the key prefix is checked against `RAZORPAY_ENVIRONMENT` at construction;
      the webhook secret is separate from the API secret with **no fallback**, so
      a blank one fails the boot; and the signature covers no timestamp, so
      replay protection is the `(provider, provider_event_id)` ledger rather than
      a time window. ⚠️ Same caveat as Cashfree — **request shapes are from the
      documentation, not a live sandbox**. The signature scheme and the event
      mapping _are_ covered by tests
- [x] **Checkout on our own page** (`PAYMENTS_CHECKOUT_PRESENTATION=embedded`,
      the default). The provider's widget is mounted on the clinic's own billing
      screen instead of the browser being sent away. Card entry still happens
      inside the provider's overlay, so cardholder data never touches our markup
      or our servers and **PCI DSS stays at SAQ-A** — Razorpay's Custom Checkout,
      which would put those fields in our markup, is deliberately not used.
      A provider that declares no widget degrades to the hosted page on its own
      (`presentationFor`), so this and `PAYMENT_PROVIDER` move independently. The
      widget's own success callback is **not** treated as evidence; the return
      page reconciles against the provider exactly as before. `apps/web` learns
      which acquirer is configured in one component directory
      (`components/tenant/checkout/`) and nowhere else
- [x] **Tax**, built for many countries and charging in none of them yet.
      `resolveTax` starts from `tax_registrations` — which is empty and
      deliberately unseeded — so every supply resolves to `NOT_REGISTERED`, no
      tax is charged, and the reason is recorded on the invoice. Registering
      somewhere is then a data change, not a deploy. India GST is implemented
      properly (CGST/SGST within our own state, IGST across, zero-rated exports,
      halves that sum exactly); VAT does reverse charge on a **validated** number
      only. Cross-border EU consumer VAT and US sales tax **refuse to guess** —
      they return nothing charged with a reason naming the missing tax provider,
      because a plausible invoice at the wrong rate remitted to the wrong
      authority is worse than an untaxed one. Rates, place of supply and both
      tax numbers are snapshotted onto the invoice, never re-read
- [x] **Tax registrations are managed from the platform console** (`/taxes`,
      `platform.tax.manage`). Country-wide and region-specific are both
      first-class — one national VAT number, or a GSTIN per Indian state — and
      the screen lists them as the hierarchy the engine actually resolves, with
      regions indented under their country. Adding one starts charging on the
      next checkout with no publish step, which the copy states plainly;
      `effectiveFrom`/`effectiveTo` schedule a change, and removal is soft so an
      already-issued invoice can still explain its number. A second registration
      for the same place is refused by the unique index with a readable message
- [x] **Country and time zone are asked for at signup**, and the billing
      currency is derived from the country against the currencies the plan
      actually publishes (`currencyForCountry`). Before this, `country_code` had
      no field on the register contract at all, so every organization took the
      column default `IN` and the hard `INR` default — every clinic looked Indian
      for tax and was billed in rupees, and none of the other six published
      currencies could be reached. Verified: a clinic registering as `IE` now
      lands EUR / Europe/Dublin. The zone is defaulted from the country and stays
      editable; the currency is shown on the form but decided server-side, so the
      client cannot pick one the catalogue has no price in
- [x] **Mock provider** — not a stub. Same HMAC scheme, a real sandbox page an
      operator clicks, and it can decline, stall, abandon, or deliver the same
      event twice. `PAYMENT_PROVIDER=mock` is the tested path
- [x] **Billing engine** (`@rcln/billing`) — period arithmetic with a
      non-drifting anchor, proration, upgrade classification by entitlement,
      invoice numbering, entitlement resolution, and the state machine. In
      `packages/` because the worker runs the same engine the API does
- [x] Entitlement gate: `subscription_feature_overrides` → `plan_features` →
      hard default, resolved in one place (`resolveEntitlements`). `isEntitled`
      reads the clock as well as the status, so a trial that ended an hour ago
      is not entitled even before the sweep runs
- [x] **Upgrade only, prorated, renewal date unmoved** (ADR-0014). Direction is
      decided by comparing entitlements, never prices — a monthly→annual switch
      is otherwise a downgrade in one direction and an upgrade in the other
- [x] **Cancel** at period end (default) or immediately, and **resume**
- [x] **Recurring**: hourly BullMQ sweep → per-subscription jobs. Dunning
      d1/d3/d7/d12 → `PAST_DUE` → **14-day** grace → `EXPIRED`, never deleted.
      Fourteen not seven, because what is behind this paywall is a waiting room
- [x] **Country → currency**, seven published currencies, priced per currency
      rather than converted. A subscription's currency is fixed at first payment
- [x] Webhook ingestion: signature verified over the raw bytes, global
      deduplication ledger, and a narrow `SELECT`-only RLS policy so a verified
      delivery can find the one intent it names and nothing else
- [x] Tenant billing screen, checkout return page, platform-console read view
- [ ] Usage counters enforcing `max_branches` / `max_users` at write time —
      the entitlement values resolve, but nothing consults them on a branch or
      membership create yet
- [ ] Notifications: the invoice email, the dunning emails and the
      "your card is about to expire" nudge. The engine reaches the right states;
      nothing tells the customer about them, because delivery is still a stub
- [ ] Tax. Invoice lines carry a `TAX` kind and `tax_amount` is on the invoice,
      both deliberately unused — GST for Indian clinics is a real calculation
      and faking it as a flat percentage would be worse than leaving it at zero
- [ ] Refunds are implemented at the provider seam and not wired to a route.
      There is no downgrade, so nothing currently needs one

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
