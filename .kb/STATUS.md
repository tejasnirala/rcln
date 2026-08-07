# Status

Living document. Update it when a phase completes or direction changes.

**Last updated:** 2026-08-06 · **Current phase:** 0 complete; 1 complete except
the legal sign-off (onboarding, auth, branch CRUD, invitations, role/member
management, email/phone verification, org settings, super-admin impersonation,
one unified shell, remembered scope and per-record history); **2 complete except
usage enforcement, notifications and tax** — subscriptions, payments, pro-rata
upgrades, cancellation and recurring billing all run end to end; **3 started —
station 1 stages 1 and 2 of 5 done** (numbering, PHI read-auditing, the setting
resolver; doctors, specialties and working hours). No PHI table exists yet —
`patients` lands in stage 3

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
      `/join` page. **Email delivery is real** — `EMAIL_PROVIDER=smtp` sends via
      `services/notification/smtp.sender.ts`, and compose points it at Mailpit,
      so the link is a click at http://localhost:8025 rather than a line in the
      API log. A production relay (SES) is still unverified; the code path is
      the same one.
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
      isolation there is. The emailed code now arrives in Mailpit; the phone
      channel is still the logging stub, so a
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

Being built as **station 1 of the six-station journey — "Token"** — in five
stages. Decisions taken: the full §5 Doctors ERD (compensation and payouts stay
in Phase 4), `data_access_logs` ships with the first PHI rather than being
retrofitted, and appointments get a real availability engine — working hours
divided by a resolved slot duration, minus what is already booked.

- [x] **Stage 1 — the cross-cutting spine.** No UI, and deliberately first: both
      halves are things that need a second migration if they are wrong, and
      neither is visible from a screen.
  - [x] `number_sequences` + `issueNumber()` — one mechanism for UHID (per org),
        MRN (per branch), appointment number (per branch, FY-reset) and queue
        token (per doctor per day), generalising "financial year" into a
        `period_key`. A single `ON CONFLICT DO UPDATE` statement whose row lock
        makes concurrent issues gapless. **Not** a Postgres `SEQUENCE`:
        `nextval` is non-transactional, so a booking that rolls back would burn
        a number permanently. ⚠️ Org-scoped RLS **only** — a `branch_isolation`
        policy here would make `ON CONFLICT DO UPDATE` raise 23505 against a
        hidden row instead of incrementing. Measured: 50 parallel issues return
        exactly 1..50, where the same harness running a naive read-then-write
        returns **7 distinct values out of 50**
  - [x] `data_access_logs` — who READ whose chart, the one thing no other table
        records. Ids, enums, counts and a SHA-256 of the search term; never a
        name, never the term, and `route` is the matched pattern rather than the
        URL. One row per request, never per result row, with a 300s Redis dedupe
        on repeat views of one record — but **searches are never deduplicated**,
        because repeatedly searching for the same person is itself the signal.
        Append-only by the same two independent layers as `audit_logs`, both
        measured: the REVOKE refuses with the row visible, and with the grant
        restored the trigger still refuses
  - [x] `resolveSettings()` — the general reader the availability engine needs.
        USER → DOCTOR → BRANCH → ORGANIZATION → PLATFORM → default.
        ⚠️ `setting_values` is RLS-EXEMPT, so the explicit `(scopeType, scopeId)`
        pairs are the **only** tenant isolation there is and `db:rls:check` can
        never notice a missing one. Measured by removing the pin: exactly the
        two cross-tenant cases fail and nothing else
  - [x] 10 new permission codes (`doctor.*`, `appointment.availability.read`),
        granted per role. `doctor.schedule.request` is split from `.approve` so
        a doctor cannot approve their own leave; `appointment.availability.read`
        is split from `doctor.schedule.read` so a patient can see free slots
        without reading caps and leave reasons
  - [x] PHI field names added to `REDACTED_KEYS` as a backstop. Deliberately
        **not** `email`/`phone`: `invitations` records the invited email on
        purpose and `branches` its switchboard number, so a blanket key-name
        deny-list would gut two real trails to protect a column no service
        passes. That stays the patient service's allow-list snapshot to enforce
  - [x] 27 new tests — 14 numbering, 13 resolver — plus 11 isolation cases.
        **338 API tests green**, `db:rls:check` green at 22 protected tables
- [x] **Stage 2 — doctors.** Eight tables, an end-to-end screen, and the two
      policies that were easiest to get subtly wrong. No PHI: a doctor is staff,
      so this whole surface was built without the read-auditing discipline that
      Stage 3 turns on.
  - [x] `specialties` / `qualifications` — a **platform catalogue with
        per-tenant extension** (`organization_id NULL` = platform row), seeded
        with 48 specialties (14 of them sub-specialties, self-referencing) and
        27 qualifications. ⚠️ **Their RLS policy is read-permissive and
        WRITE-STRICT, and is NOT the `files` policy.** `files` permits a NULL
        org in its `WITH CHECK`; copying that here would let any clinic INSERT a
        platform-wide specialty visible to every tenant on the platform.
        Measured by relaxing the policy to the `files` shape: the write
        succeeds, and only that one test fails
  - [x] `doctor_profiles` — ⚠️ **`@@unique([organizationId, userId])`, not the
        ERD's bare `user_id UK`.** `users` is global here, so a global unique
        would mean a doctor consulting at two clinics can hold one profile, and
        the failure appears only when the second clinic onboards them. There is
        a test that does exactly that
  - [x] `doctor_specialties` / `doctor_qualifications` — org-scoped, because
        they point at TWO parents and the second may be a platform row with no
        `organization_id` to compose with. `tenant_isolation` constrains only the
        doctor side, so a RESTRICTIVE `specialty_visible` / `qualification_visible`
        policy is the entire control on the other — same shape as
        `branch_in_same_org` on `invitation_branches`
  - [x] `doctor_schedules` — org-scoped **plus** RESTRICTIVE `branch_isolation`,
        with a **GiST EXCLUDE** refusing overlapping blocks for one doctor at one
        branch on one weekday over overlapping validity windows. Two blocks a
        day (morning/evening) is normal, so there is no natural unique to lean
        on. Times compared as minutes-since-midnight because GiST has no range
        type for `time`. `'[)'` bounds, so 09:00–13:00 and 13:00–17:00 are
        allowed and 09:00–13:00 with 12:00–17:00 is not — both measured
  - [x] `doctor_schedule_exceptions` — org-scoped, **deliberately no
        `branch_isolation`**. `branch_id` NULL means "every branch", and hiding a
        doctor's leave from a branch-scoped reader would not restrict anything
        useful — it would make the engine offer slots on a day they are away.
        Phantom availability is worse than a visible absence
  - [x] **ADR-0015 — slot duration has one authoritative source.**
        `doctor_schedules.slot_minutes` (nullable override) → the resolved
        `appointment.slot_minutes` setting. `doctor_branch_settings` therefore
        carries **no** `slot_minutes` and **no** `accepts_online_booking`, and
        `branch_operating_hours.slot_minutes` is never read by the engine. Three
        columns claiming one number is how the front desk's calendar and the
        patient portal end up disagreeing about whether 10:20 exists
  - [x] Contracts, `doctor.service.ts` + `doctor-schedule.service.ts`,
        `doctors.routes.ts` (12 endpoints), and a `/doctors` screen whose
        signature is the **week strip adapted to blocks** — the branch version
        holds one span per day, a doctor's holds several across branches, and
        flattening them to "09:00–17:00" would invent a bookable lunch hour.
        Each row states whether its slot length is inherited or set here,
        because inheritance the user cannot see is inheritance they will fight
  - [x] ⚠️ `CREATE EXTENSION btree_gist` sits at the **top of the migration**,
        not only in `infra/postgres/init`. Extensions are per-database and
        `prisma migrate dev` replays into a fresh shadow DB that has never seen
        the init script — without it the EXCLUDE fails there and the symptom is
        "migrations work but `migrate dev` is broken"
  - [x] 26 HTTP cases + 12 isolation cases. **376 API tests green**,
        `db:rls:check` green at 30 protected tables
- [x] **Employment record auto-filled on accept.** Three fields land when
      someone accepts an invitation, none of them typed:
  - [x] `employeeCode` — issued from the org-wide `EMPLOYEE` sequence through
        Stage 1's `issueNumber()`, prefixed from a new seeded
        `staff.employee_code_prefix` setting (default `EMP`, so `EMP0001`).
        Concurrency-safe and gapless. **Re-joining keeps the original code** —
        it is how the clinic refers to a person on a badge and in whatever
        spreadsheet predates this system, so reissuing it would break every one
        of those references. `joinedOn` does move to the new stint
  - [x] `designationId` — copied from the invitation. **Not derived from the
        role**: a role is what someone may DO, a designation is what they are
        CALLED, and three consultants can share the DOCTOR role with three
        different titles. Only fills a blank, so an admin's hand-refined title
        is never clobbered by a re-invite
  - [x] `joinedOn` — ⚠️ **today in the CLINIC's timezone, computed in Postgres**
        as `(now() AT TIME ZONE o.timezone)::date`. The column is a bare `date`
        and the API container runs UTC, so `new Date()` would record someone
        accepting at 01:00 IST as having joined _yesterday_ — a one-day error
        nobody notices until payroll disagrees with a contract
  - [x] **`designations`** — a new master table, platform catalogue plus
        per-tenant extension (35 seeded), replacing the free-text
        `staff_profiles.designation` column (which had zero rows, so a clean
        swap rather than a data migration). Free text produced
        "Sr. Consultant" / "Senior Consultant" / "Sr Consultant" as three
        different things and made "how many consultants do we have"
        unanswerable. Same read-permissive / write-strict policy as
        `specialties`, plus RESTRICTIVE `designation_visible` on both
        `invitations` and `staff_profiles`, whose `designation_id` are plain FKs
  - [x] New `iam.designation.manage` code — separate from `iam.role.manage`
        because a role carries permissions and a title does not: the front desk
        can add "Senior Consultant" without gaining the ability to grant access.
        Reading the list sits behind `iam.user.read`, so the invite form can
        render the menu
  - [x] Invite form gets a title select with inline "add a title"; the Staff
        screen's designation becomes a select. 6 new HTTP cases, 6 isolation
        cases. **388 API tests green**, 31 protected tables
  - [x] **A Receptionist is not a Radiologist.** `role_designations` pairs roles
        with the titles that fit them — a real join table, not a JSON array
        (ADR-0006), because the relation is genuinely many-to-many:
        "Consultant" fits only DOCTOR, "Clinic Manager" fits three roles. 43
        platform pairings seeded, and a clinic can add its own.
        ⚠️ **An unmapped title fits EVERY role, deliberately** — "no visible
        pairing" means unrestricted, not forbidden, or a clinic that adds a
        title and forgets to map it watches it vanish from every menu.
        IT_ADMINISTRATOR, HOUSEKEEPING and SECURITY are left unmapped on
        purpose. Enforced in the API, not just the menu: a filtered dropdown is
        a convenience, and the same request posted directly would sail through.
        A title added from the invite form is auto-mapped to the role being
        invited, so it never lands unmapped.
        ⚠️ `roles` is **RLS-EXEMPT**, so the RESTRICTIVE `role_visible` policy's
        `organization_id` test is doing the whole job alone rather than backing
        up a policy that would have caught it anyway. Measured by dropping the
        policy: org A then successfully pairs its title with org B's private
        role, and reads that role's name back through the join
  - [x] **A "Roles and titles" section on `/settings`** (`iam.designation.manage`).
        Pick a role, tick the titles that fit it. Clinic-wide, not per branch —
        a role means the same thing everywhere, and the copy says so. One role
        at a time rather than a 12 × 35 grid, which is a wall rather than a
        screen. `role_designations.is_excluded` lets a clinic switch a platform
        default OFF ("our Receptionists are never Clinic Managers"); the PUT is
        declarative and stores only the **difference** from the defaults, so a
        role returned to its default state leaves no rows behind and keeps
        tracking the platform list as it changes.
        ⚠️ **The eligibility rule has two edges that each cost a bug to find:**
        the clinic's explicit answer must be checked BEFORE the unmapped
        fallback (otherwise a title whose only row is an exclusion has no
        positives, falls through to "unmapped", and comes back eligible for the
        very role it was just excluded from); and the reconciliation baseline
        must treat an unmapped title as _enabled_ (otherwise unticking one
        writes no row and silently does nothing). Both are pinned by tests
  - [ ] ⚠️ Invitations issued **before** this change carry no designation, so
        accepting one fills only the code and the date. Revoke and re-invite to
        set a title
- [x] **Stage 3 — patients.** Seven tables, the first PHI in the product, and
      the one place the branch boundary deliberately falls somewhere other than
      where it falls everywhere else.
  - [x] **ADR-0016 — identity is org-wide, attendance is branch-local.**
        `patients` carries org-scoped RLS and ⚠️ **NO `branch_isolation`**;
        `patient_registrations` carries both. This looks like a missing policy
        and is the opposite. A branch-scoped `patients` makes the duplicate
        check impossible — the front desk cannot see that head office registered
        this person last week, so it registers them again, and **the second
        record has no allergies on it**. That is a clinical safety failure with
        a clean audit trail and no error anywhere. The privacy question a branch
        policy would have answered is answered instead by `data_access_logs`,
        which is what a cross-branch read is _for_ surfacing. Both halves are
        pinned by isolation tests, including one that asserts the ABSENCE
  - [x] `patients` — org-wide UHID from Stage 1's `issueNumber` with the seeded
        `patient.uhid_prefix`. ⚠️ **`date_of_birth` is nullable and
        `approx_age_years` exists for the reason**: a walk-in who knows they are
        "about 60" is the common OPD case, and storing a fabricated 1st-January
        birthday to satisfy a NOT NULL is how a paediatric dose gets calculated
        from a lie. A CHECK constraint refuses both columns at once, the
        contract mirrors it so the error names a field, and setting either one
        clears the other
  - [x] `patient_registrations` — branch-local MRN from the same mechanism with
        a new BRANCH-scoped `patient.mrn_prefix` setting, so two branches both
        start at 1 and a group can style them separately. RESTRICTIVE
        `branch_isolation`, `branch_id` NOT NULL, so the policy is absolute
  - [x] **Duplicate detection, org-wide by construction** — phone, ABHA,
        national id, or name AND date of birth together, never name alone. It
        reaches branches the caller cannot see, which is the entire point, but
        `branchNames` comes back empty for a match out of scope: the desk learns
        "already registered here" without learning where. ABHA and the national
        id also get partial unique indexes (`WHERE … IS NOT NULL`), so a second
        record carrying one is refused by Postgres, not warned about
  - [x] **Search is a POST-shaped GET and never a URL.** ⚠️ The term is
        somebody's surname, so it is a server ACTION into component state — not
        a query parameter, which would land in browser history, the referrer of
        the next request, and every proxy log in between. The screen therefore
        opens EMPTY and stays empty until asked: a patient list is a lookup, not
        a browse, and rendering twenty records on navigation discloses twenty
        people to answer a question nobody asked. The duplicate probe is a POST
        for the same reason. A hand-written GIN trigram index over
        `lower(first_name || ' ' || coalesce(last_name, ''))` backs the search —
        Prisma cannot express an expression index, and without it every search
        is a sequential scan whose cost grows with the **platform**, because RLS
        filters after the scan
  - [x] `patient_allergies` / `_conditions` / `_medications` — ⚠️ **no
        `medicine_id` or `diagnosis_id` yet, deliberately.** The §6 ERD has both
        and the catalogues arrive in Phase 5; a nullable uuid with no foreign
        key behind it is a column that looks like a reference and accepts any
        uuid, including another tenant's. Free text carries the answer until
        there is a real row to point at. Soft delete, because "recorded and
        later withdrawn" is clinically different from "never recorded".
        ⚠️ `AllergySeverity` and `PatientConditionStatus` declaration order is
        **load-bearing** — it is the Postgres sort order, and the lists are read
        `severity DESC` / `status ASC` so SEVERE leads and RESOLVED never sits
        above ACTIVE
  - [x] `patient_addresses` / `patient_contacts` — org-scoped, because an
        address follows the person. `is_guardian` is a separate flag from
        `is_emergency` and frequently a different human being: the neighbour
        with a car is not the parent who can sign
  - [x] **Every read writes a `data_access_logs` row**, inside the transaction
        that read it. A detail view names the patient; a search names nobody and
        carries a SHA-256 of the term with a result count. Searches are never
        deduplicated. `route` is the matched PATTERN — `GET /v1/patients/:id` —
        never `req.originalUrl`, which carries the surname with it. Opening a
        chart writes two rows, identity and history, because they are two
        permissions and two disclosures
  - [x] ⚠️ **NO PHI REACHES `audit_logs`**, enforced by an allow-list snapshot
        that passes `uhid`, the six enums, and `hasPhone`/`hasAbhaNumber`-style
        booleans — that an identifier EXISTS is auditable, what it is is not.
        `reaction` and `dosage` join `REDACTED_KEYS` as the backstop. Measured:
        a test greps every audit row the suite writes for the subject's name,
        phone, date of birth, ABHA number, allergen, dose, address and next of
        kin, and expects zero
  - [x] A `/patients` lookup screen and a patient chart whose signature is the
        **allergy band** — full width, above every panel, severity spelled out
        in words beside each allergen, and "None recorded. Ask before
        prescribing." stated rather than left as a blank, because an empty list
        and an unasked question look identical on screen and are not the same
        fact. The tab title is "Patient record", never the patient's name
  - [x] 31 HTTP cases + 23 isolation cases. **462 API tests green**,
        `db:rls:check` green at 39 protected tables
  - [ ] No merge flow. `status = MERGED` and `merged_into_id` exist, tied
        together by a CHECK constraint, and nothing writes them yet — this
        design reduces duplicates rather than making them impossible
  - [ ] `DECEASED` and `deceased_on` are storable and no screen sets them
  - [ ] Family history, insurances, documents and the consent pair from the §6
        ERD are not built
- [x] **Stage 4 — the availability engine, appointments, status history.** Two
      tables, one engine every booking path goes through, and the first place in
      the product where Postgres refuses a clinical mistake outright.
  - [x] `appointments` — org-scoped **plus** RESTRICTIVE `branch_isolation`,
        which is the ⚠️ **OPPOSITE call from `patients` and the same one as
        `patient_registrations`.** Identity follows the person across a hospital
        group; attendance belongs to the clinic it happened at, and a booking is
        attendance. Composite-FK'd to patient, registration, branch and doctor,
        so a cross-tenant booking is unrepresentable
  - [x] ⚠️ **Double-booking is refused by a GiST EXCLUDE constraint, not by the
        service.** `appointments_no_doctor_overlap` over
        `(organization_id, doctor_profile_id, tstzrange(start, end))`
        `WHERE status NOT IN ('CANCELLED','NO_SHOW')`. **The predicate is the
        semantics:** cancelling frees the slot with no release step anywhere,
        and adding a status to the enum without deciding which side of that
        WHERE it belongs on is how a released slot stays blocked forever. The
        engine checks first so the ordinary case gets a sentence rather than a
        constraint name; the constraint is what makes the two-receptionists-one
        -millisecond case impossible rather than rare, and it is also the only
        thing covering a booking for the same doctor at a branch out of scope,
        which RLS correctly hides from the engine
  - [x] **The availability engine** (`availability.service.ts`) — recurring
        blocks, APPROVED exceptions only, EXTRA_SHIFT as a one-day block, branch
        closures, `maxPatients` as the advisory cap it is documented to be, and
        past slots. Slot length resolves through the ONE chain of ADR-0015 and
        the engine imports `effectiveSlotMinutes` rather than re-deriving it.
        ⚠️ **The response never names who holds a taken slot** — `BOOKED` is the
        whole answer, because on the portal that name would be a stranger's.
        `notWorking` is a separate field from an empty list: "no hours today" and
        "every slot has gone" read differently and send the desk to different
        places
  - [x] ⚠️ **Every timezone conversion happens in Postgres**, and the cast is
        load-bearing: `date` coerces to BOTH `timestamp` and `timestamptz`, so
        bare `(:date::date) AT TIME ZONE tz` picks the wrong overload and returns
        wall-clock instead of an instant. In IST the day started at 05:30Z rather
        than 18:30Z the previous evening, so **every morning booking fell outside
        its own day** — the board came back empty and the engine offered taken
        slots, with nothing raised. `::timestamp` is the fix and it is commented
        as such in both files. See PITFALLS
  - [x] `appointment_status_history` — append-only by the same two layers as
        `audit_logs` (owner-exempt trigger + REVOKE), because
        "seen at 10:41, not 11:55" is a claim a clinic may have to stand behind.
        ⚠️ **A `DO INSTEAD NOTHING` rule was the wrong instrument** and shipped
        first: it swallows the DELETE that `ON DELETE CASCADE` issues, so an
        organization could never be hard-deleted again, and a forbidden UPDATE
        "succeeds" having changed nothing
  - [x] ⚠️ **RLS IS NOT APPLIED INSIDE A POLICY EXPRESSION'S SUBQUERY**, which
        the `parent_scoped` comment in `enable-rls.sql` claimed it was. The org
        half survived only because each predicate spells the tenant test out
        itself; the branch half did not carry across at all, and the trail leaked
        across branches inside one clinic. The branch predicate is now RESTATED
        in the child's policy. The first fix was then defeated by a second
        mistake — adding the table to `org_scoped` too gave it a PERMISSIVE
        org-only policy beside it, and **permissive policies OR together**. Both
        halves are pinned by isolation cases
  - [x] **The transition map holds in the service and the timestamps in the
        database.** NO_SHOW is unreachable after a check-in — somebody standing
        at the desk cannot retrospectively not have turned up, and marking them
        absent is how a no-show fee reaches a patient who was there. CHECK
        constraints refuse a CHECKED_IN row with no `checked_in_at` and a
        cancellation with nobody's name on it
  - [x] **Booking registers the patient at the branch if this is their first
        visit there**, reusing the same MRN issue `registerAtBranch` does.
        Refusing instead is a dead end that ends in a second `patients` row —
        the exact failure the org-wide duplicate check exists to prevent
  - [x] ⚠️ **The day board writes NO `data_access_logs` row, deliberately**, and
        the detail view does. A polled list of who is expected at one branch
        today is neither clinical content nor singling out one record; logging it
        would turn that table into a per-refresh firehose. So the board carries
        the patient's NAME and never `reason` — name plus reason on a screen
        anyone can glance at is a diagnosis with extra steps
  - [x] A `/appointments` day board whose signature is the **time rail**: times
        down one column with the bookings hanging off them and a stated
        "20 min free" where the gaps are, because what the front desk needs at a
        glance is where the space is, and a table hides that. Status is spelled
        out in words on every row
  - [x] 32 HTTP cases + 8 isolation cases. **502 API tests green**,
        `db:rls:check` green at 41 protected tables
  - [ ] No queue tokens and no walk-in — that is Stage 5. `QUEUE_TOKEN` numbering
        already exists and nothing writes it
  - [ ] Reschedule writes no status-history row (the status did not change); the
        move is in `audit_logs` only
  - [ ] `maxPatients` remains advisory — two concurrent bookings into different
        free slots can still take a block one over its cap
  - [ ] Nothing sends a reminder. `appointment.reminder_hours_before` is seeded
        and no worker reads it
- [ ] Stage 5 — queue tokens, walk-in, check-in
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
