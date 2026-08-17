# Status

Living document. Update it when a phase completes or direction changes.

**Last updated:** 2026-08-16 · **Current phase:** 0 complete; 1 complete except
the legal sign-off (onboarding, auth, branch CRUD, invitations, role/member
management, email/phone verification, org settings, super-admin impersonation,
one unified shell, remembered scope and per-record history); **2 complete except
usage enforcement, notifications and tax** — subscriptions, payments, pro-rata
upgrades, cancellation and recurring billing all run end to end; **3 in progress
— station 1 stages 1–4 of 5 done, plus vitals and the follow-up chain**
(numbering, PHI read-auditing, the setting resolver; doctors, specialties and
working hours; patients; the availability engine, appointments and the day
board; vitals, event-driven status, follow-ups, and the doctor/front-desk split).
Queue tokens and walk-in are stage 5; prescriptions come after. The consultation
page exists as a route with a deliberate placeholder where the specialty-specific
diagnosis form will go.

**Phase 5 has started out of order, and deliberately: PI-1 through PI-6 are
done** — the product catalogue, the inventory foundation, movements, procurement,
the regulatory framework and now the India rule pack. None of them depends on
anything Phase 3 owns, and everything else in the pharmacy programme waits on
them.

PI-2 brought the append-only `stock_ledger`, a trigger-maintained balance cache
the application cannot write, the first worker processor that changes clinical
state, and four `/stock` screens. PI-3 brings adjustments, transfers and
reservations plus the FEFO allocation engine. PI-4 brings suppliers, purchase
orders, goods receipts, returns and costing. PI-5 brings the regulatory
framework — jurisdictions, versioned rule packs, `@rcln/regulatory` and the
maturity ladder — containing no country's rules at all.

**PI-6 configures the first jurisdiction.** Pack `IN 1.0.0` — 2 authorities, 3
sources, 22 rules — read from CDSCO's own consolidated Drugs Rules, 1945 and the
Pharmacy Act, 1948 on India Code, at maturity `AUTOMATED_TESTED`. Goods receipt
and transfer now consult the engine while posting.

**The Consultation Engine programme is COMPLETE — CE-0 through CE-8** — the clinical vocabulary, the treatment journey, the configuration layer,
the consultation itself and now its content. `@rcln/clinical` is the tested core;
a template resolves from an appointment by walking the doctor's classification up
to the patient's care context, most specific wins. Adding a specialty is meant to
cost a configuration row and never a screen. A consultation opens, autosaves,
signs and amends — a finalized record is immutable, and a correction is a new row
citing it that carries a COPY of its content. And it now holds that content as
real rows: diagnoses, prescriptions, procedures, investigations, advice,
referrals, attachments and a follow-up plan, each with a foreign key the database
checks. **PI-7 has since shipped against them and PI-9 is unblocked.** CE-5 added the read side — visit
history, the episode timeline, the read-only record, the previous-visit panel and
the recall screen — and CE-6 added the chart: `visual_maps`, `visual_regions` and
`clinical_findings`, with the 32-tooth FDI odontogram seeded and ONE generic
renderer in `apps/web` that knows nothing about teeth. CE-7 then added the scalp
and body charts and the dentistry and hair-and-scalp templates as SEED ROWS,
which is the proof the renderer is generic. CE-8 then hardened it: a DATE is a
calendar day and a DATETIME an ISO instant, a stored section document is bounded
at autosave, the lost open race resumes the draft instead of returning a 409,
the recall list's scan is bounded by a partial index, and every clinical route's
permission gate is now audited off the Express stack rather than off a list
somebody maintains. Everything about that programme lives in
[`Consultation/`](Consultation/README.md).

⚠️ **NOTHING BLOCKS ON IT, AND THAT IS THE DESIGN.** One country has a pack, so
every evaluation elsewhere answers `UNDETERMINED` — which refuses — and a call
site that threw on a non-permission would stop every clinic outside India from
receiving stock. Enforcement is gated on `PRODUCTION_ENABLED`, which only a named
human may set. India's sources are `UNVERIFIED` and no qualified person has read
the pack, so nothing here claims compliance with anything.

`db:rls:check` is green at **111** protected tables and **1507 API tests pass
across 73 suites** (1314 integration + 193 unit).

**Both reviewer passes have run and been acted on** for PI-3 and PI-4. See
§ Phase 5 and `.kb/PharmacyInventory/NEXT_SESSION.md`.

⚠️ PHI is live from stage 3 onwards — `patients`, `appointments` and
`appointment_vitals` all carry it, and every read of one that discloses a single
named patient writes a `data_access_logs` row.

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
- [x] **Theming — appearance × accent.** The palette moved out of `globals.css`
      into `apps/web/src/app/theme.css` as runtime variables; `globals.css` now
      maps them with `@theme inline`, so `bg-card` and `text-drape` compile to
      `var(--rcln-*)` and every screen written before the theme became themable
      untouched. Light | Dark | System × five accents (`surgical` — today's
      design, and the default — `ember`, `indigo`, `plum`, `graphite`),
      **composed rather than enumerated**: an accent is one CSS block declaring a
      light and a dark ramp, and the appearance switch is written once. Stored in
      two cookies (ids only, one year, host-only, not `httpOnly` so the boot
      script can read it pre-paint); no database column and no server round trip.
      Applied by a blocking inline script in `<head>`, which is what removes the
      dark-mode flash and keeps the marketing pages statically rendered. Settings
      at `/appearance` on both surfaces, guarded by nothing.
      ⚠️ **The ten combinations were contrast-measured by hand and nothing
      re-checks them.** A test that parsed the stylesheet and asserted every
      accent in both appearances was written and then removed — it was the only
      test in `apps/web`, and it arrived with a jest toolchain that was never
      installed, so it broke `typecheck` for the whole workspace instead of
      guarding anything. Restoring it means setting `apps/web` up for tests
      properly, which is its own task. Until then a new accent is a manual
      measurement — see `apps/web/AGENTS.md`
- [x] Status colours split from the accent while doing it: `success`, `warning`
      and `danger` are fixed in both appearances, `Alert` gained the missing two
      tones plus a glyph and a screen-reader word per tone, and error moved off
      the live-state orange — under a warm accent a failure and a primary button
      were the same colour
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
- [x] **Stage 4b — vitals, the follow-up chain, and the role split.** One table,
      two permission codes, and the point at which the day board stops being one
      screen for everybody.
  - [x] `appointment_vitals` — the observations taken before the doctor sees the
        patient. Org-scoped **and** branch-scoped, the same call as
        `appointments`: vitals are taken at a place, so they follow attendance
        rather than identity. `branch_id` and `patient_id` are copied off the
        appointment and never accepted from the caller. **Many rows per
        appointment, deliberately** — a repeat BP twenty minutes after a high
        first reading is a second observation, not a correction, so there is no
        update endpoint at all. ⚠️ Its audit snapshot records **which**
        observations a row carries and never their values: `REDACTED_KEYS`
        cannot help here, because these column names are PHI only on this table
  - [x] BMI is **derived on read, never stored** — a stored BMI is wrong the
        moment somebody corrects the weight, and nothing would recompute it
  - [x] **Automatic status, driven by clinical events.** Recording vitals moves
        a booking to CHECKED_IN; opening the consultation moves CHECKED_IN to
        IN_PROGRESS. Both commit in the same transaction as the event that
        caused them, both decline silently rather than throwing when the move is
        not a legal forward step, and both write a trail row naming the trigger.
        ⚠️ The idempotence is load-bearing: the consultation POST is issued
        during a Server Component render, which can run more than once
  - [x] **Follow-ups get their own appointment number**, not the parent's. The
        chain is `parent_appointment_id`, composite-FK'd and ON DELETE RESTRICT
        — a stronger link than a reused token string, which would also collide
        with the branch's uniqueness constraint on the second visit. Patient and
        branch are read off the parent and cannot be overridden
  - [x] `appointment.delete` — withdrawing a mis-click, split from
        `appointment.cancel` so the utilisation reports can still tell "the
        patient called off" from "the receptionist mistyped". Future + BOOKED
        only, checked against Postgres' clock, refused when a follow-up hangs
        off it. ⚠️ **A soft delete that ALSO sets status to CANCELLED, and both
        halves are required** — `appointments_no_doctor_overlap` is deliberately
        not partial on `deleted_at`, so `deleted_at` alone would hide the
        booking while blocking its slot forever. Measured: the slot is free again
  - [x] `doctor.directory.read` — split out of `doctor.read`, and it is what
        makes a doctor's navigation **two tabs** rather than three. Reading _a_
        profile and enumerating _all_ of them are different acts. The same code
        decides whether `GET /appointments` and `GET /patients` may read ACROSS
        practitioners, so one rule serves the nav, the roster and both lists, and
        no role is named anywhere (ADR-0002). It **overrides**
        `?doctorProfileId=` rather than defaulting it — a default would leave the
        query parameter as a working way around the boundary
  - [x] `GET /doctors/me` and `GET /doctors/:id`, plus a read-only profile
        screen. A doctor reaches their own profile from the header, not from a
        Doctors tab they do not have; editing stays behind `doctor.update`
  - [x] A consultation page at `/appointments/:id` — real route, real access
        split, real vitals. **The diagnosis and prescription surface is a
        deliberate placeholder**: it is specialty-specific and gets designed on
        its own
  - [x] 5 new isolation cases on `appointment_vitals` (no context, another
        clinic, another branch, branch in scope, and the write side).
        **553 API tests green**, `db:rls:check` green at 42 protected tables.
        Verified end to end against the running stack, not only by typecheck:
        the automatic transitions, the freed slot, and — as a second doctor over
        real HTTP — the refused roster, the own-day-only board, and the
        own-patients-only list
  - [x] **`clinical.vitals.read` split out of `clinical.vitals.record`.** One
        code used to gate both directions, which meant the only way to let
        somebody SEE a blood pressure was to let them type one in — so a DOCTOR
        held the write code purely to read the chart. They now hold the read and
        **not** the write: the cuff belongs to whoever is with the patient before
        the consultation, and a consultation cannot silently amend an observation
        the front desk signed for. The front desk and the nurse hold both; the
        front desk still carries no `clinical.encounter.read`. On an empty visit
        a reader who cannot record is told the readings are taken at the desk,
        rather than being shown a form that will never appear. ⚠️ **The read-only
        view is a separate component, not four `canRecord &&` guards.**
        `VitalsChart` does not import `ReadingForm`, holds no mode state and
        takes no edit handler, so there is nothing in that subtree to leak — the
        recording controls cannot be reintroduced by an edit that forgets one
        condition, which is what the previous shape invited
  - [x] **Authoring the clinical record is DOCTOR-only.** `clinical.encounter.create`,
        `.close`, `clinical.prescription.create` and `.sign` are stripped from
        ORG_OWNER and ORG_ADMIN by name — both are defined as `ALL_PERMISSIONS`
        minus a list, so a new authoring code would otherwise join them silently.
        They keep every clinical READ. ⚠️ `POST /appointments/:id/consultation`
        moved from `encounter.read` to `encounter.create` with it: it MUTATES —
        CHECKED_IN → IN_PROGRESS — so under the read code an administrator
        opening a booking to look at it moved the patient to "with the doctor" on
        the day board. Pinned by `packages/permissions/tests/roles.test.ts`
  - [ ] **Existing org-scoped role CLONES are not migrated.** Re-seeding
        re-syncs the system roles, but a clinic that cloned ORG_ADMIN before this
        change keeps the authoring codes on its clone. That is arguably correct —
        the clinic made that role — but it is not a decision anybody has taken
        yet, and there is no report of which tenants are affected
  - [ ] No time-based sweep. Nothing marks a stale BOOKED as NO_SHOW on its own;
        that stays a manual button
- [x] **Stage 4c — the clock face is the clinic's choice, and the day board reads
      like a board.** Small, but it touches every screen that draws a time.
  - [x] `locale.time_format` — a seeded setting, `12H` by default and `24H` on
        request, allowed at ORGANIZATION and BRANCH so a group can run a hospital
        wing and a walk-in clinic differently. Resolved per branch and carried on
        `GET /auth/session` beside `timezone`, because the front desk and the
        doctors hold no settings permission and fetching it from `GET /settings`
        would 403 on exactly the screens that need it. One query for every branch
        — this is the hottest endpoint in the product
  - [x] The **storage rule written down** at last, in CLAUDE.md, CONTRIBUTING.md,
        `.kb/Architecture/CONVENTIONS.md § Dates and times`, `Project_Context.md`,
        the architect agent and `apps/web/AGENTS.md`: **UTC in the database, the
        clinic's zone and the clinic's format on screen**, with billing periods
        as the one deliberate UTC exception. Every failure it prevents is silent
  - [x] `formatClinicTime` takes the format; the appointment board's private
        `Intl.DateTimeFormat` — `en-IN`, `hour12: false`, hard-wired — is gone.
        A second formatter is how a clinic's choice gets silently ignored
  - [x] **The day tally is fixed-shape**: a Total plus all seven statuses, zeroes
        rendered. It used to drop empty statuses, so the strip was a different
        length on every navigation and "how many have we not seen yet?" was
        invisible precisely when the answer was none
  - [x] **And the tally IS the filter.** Pressing a chip narrows the list to that
        status; Total is the unfiltered state rather than an eighth chip, because
        it is already the sum of the rest. ⚠️ **Client state, not the URL, and it
        never reaches the API** — the counts are derived from the rows the API
        returned, so a server-side status filter would narrow the list AND
        collapse the tally to agree with itself, destroying the only thing the
        strip is for. A zero chip is disabled rather than hidden, and the filter
        clears itself when its count drops to zero — otherwise pressing "Seen" on
        the last With-the-doctor row leaves a full day rendering its empty state
        behind a chip that has just greyed out
  - [x] **The appointment row is one link, over the whole record.** The patient
        name went to the chart and the token went to the visit; a day board is a
        list of visits, so the record opens the visit and the number went back to
        being an identifier. A stretched `<Link>`, not an `onClick` on a div —
        focus, middle-click and the keyboard all still work
  - [ ] Verified by typecheck, lint, 583 API tests and the seeded database, not
        in a browser. The row overlay's z-index layering in particular is the
        kind of thing that reads correctly and misbehaves on a real click
- [ ] Stage 5 — queue tokens, walk-in, check-in
- [ ] Encounters proper (vitals landed early, above, because the front desk
      needed them and they are what checks a patient in)
- [ ] Prescriptions + masters (symptoms, diagnoses, procedures). The follow-up
      chain is in place and nothing yet carries a prescription along it
- [x] The extension point for per-specialty forms — shipped as CE-2's
      `consultation_templates`, not as `clinical_form_templates`. See below.

### Consultation engine (CE)

Its own programme, with its own tracker. Full detail in
[`Consultation/`](Consultation/README.md) — the phases in
[MASTER_PLAN](Consultation/MASTER_PLAN.md), the reasoning in
[DECISIONS](Consultation/DECISIONS.md), the per-phase report in
[CHANGELOG](Consultation/CHANGELOG.md).

- [x] **CE-1 — clinical foundation.** `clinical_master_items` (one table, a
      `kind` discriminator) with codings and scopes that RANK and never FILTER;
      `clinical_episodes` and `appointments.clinical_episode_id` with the
      backfill; the follow-up recommendation table; `/clinical-data` and
      `/clinical-episodes`; the `/clinical-terms` screen.
- [x] **CE-2 — templates and the configuration resolver.**
      `consultation_templates` + `_versions`, `@rcln/clinical` (74 unit tests),
      `GET /appointments/:id/consultation-config`, `clinical.template.manage`,
      the `/consultation-templates` admin surface, and a published GENERAL
      template per care context so a clinic can consult on day one.
- [x] **CE-3 — the encounter and its lifecycle.** `encounters` +
      `encounter_sections`; DRAFT → FINALIZED → AMENDED/CANCELLED with the
      amendment as a NEW ROW; `clinical.encounter.amend`; the debounced autosave
      Server Action; `validate.ts` in `@rcln/clinical` (89 unit tests); the
      `ConsultationEngine` and `FieldRenderer` on the visit screen. The
      configuration is frozen onto the encounter when it opens, so a record
      renders through the form it was written on for ever.
- [x] **CE-4 — the clinical content sections.** Eight tables — symptoms,
      diagnoses, procedures, prescriptions, investigations, advice, referrals,
      attachments — all org + branch scoped and all PHI, plus the follow-up
      recommendation's writer and the recall-list endpoint (CD-13).
      `db:rls:check` at **108**, including seven `*_visible` policies standing in
      for composite FKs that cannot be drawn into a platform-extensible parent.
      **No new permission codes**: recording a diagnosis IS writing up the
      consultation. **PI-7 shipped against `encounter_prescriptions`; PI-9 is
      unblocked** — `encounter_procedures` exists.
- [x] **CE-5 — visit history and episodes.** No schema at all: read surfaces
      over CE-1…CE-4's tables. `GET /patients/:id/visit-history`,
      `GET /clinical-episodes/:id`, `GET /appointments/:id/previous-visit`,
      `GET /doctors/referral-targets`; the `/recall` screen and the follow-up
      booking form. **No new permission codes** — two disclosure classes over one
      journey (CD-14), and the referral lookup reuses an authoring code (CD-15).
- [x] **CE-6 — the visual mapping engine and `HUMAN_DENTAL`.** `visual_maps` and
      `visual_regions` (platform-extensible, no PHI) and `clinical_findings`
      (org + branch scoped, PHI), plus the `encounter_procedures.visual_region_id`
      column CE-4 deferred. `db:rls:check` at **111**.
      `clinical.visual_map.manage` configures a chart; drawing on one is
      `clinical.encounter.create`, because a finding IS writing up the
      consultation (CD-7). **The geometry is data on the regions (CD-17)** — one
      generic renderer in `apps/web`, no tooth in it, so CE-7's second map is a
      seed rather than a screen. `PENDING_SECTIONS` is now empty: every section
      type has a component over a real table.
- [x] **CE-7 — the reference configurations.** `HUMAN_SCALP` and `HUMAN_BODY`,
      and the `DENTAL_HUMAN` and `HAIR_SCALP_HUMAN` templates that cite them —
      all four **seed rows**. No model, no migration, no route, no contract, no
      permission and no second renderer: one doctor reclassified between `DEN`,
      `TRICHOLOGY` and nothing gets three genuinely different consultations out
      of the same engine, which was the phase's whole definition of done (CD-18).
      `db:rls:check` unchanged at **111**. The one piece of code was the region
      picker on a procedure that CE-6 deferred here.
- [x] **CE-8 — hardening.** No endpoint, no permission code, no table. DATE and
      DATETIME are validated as what they are (invariant 6 inside a JSONB
      document); `documentProblems` bounds a stored section at AUTOSAVE, which is
      the one engine rule that does not wait for the signature; the LOST
      open-consultation race resumes the existing draft instead of 409-ing the
      doctor; `authorize()` stamps its codes so `route-gates.test.ts` can audit
      every clinical route; and one partial index bounds the recall list's scan,
      confirmed with `EXPLAIN`. Plus the §40 journey, walked end to end in one
      suite. `db:rls:check` unchanged at **111**.

### Consultation fees and doctor compensation

What a clinic charges for an appointment, and what it pays the doctor who takes
it. Requirements settled 2026-08-10, nothing built. Progress and every decision
live in
[`Architecture/fee-schedule-implementation.md`](Architecture/fee-schedule-implementation.md).

A fee schedule keyed by the existing `AppointmentVisitType` — clinic defaults and
per-doctor overrides, both per branch — resolved once and **frozen onto the
appointment at booking**, plus a reschedule charge for patient-initiated moves.
Separately, an agreed salary recorded against each doctor behind its own
permission pair. ⚠️ **It retires
`doctor_branch_settings.{consultation_fee,follow_up_fee}`**, which today are the
only thing pricing a consultation; `follow_up_free_days` stays. ⚠️ **Payout runs
remain deferred** — this records what was agreed and computes nothing.

### Tax registrations, coverage and where tax meets billing

**Shipped 2026-08-11.** Organization, branch and tax registration as three
separate concepts: an organization holds zero, one or many registrations
independently of its branch count; coverage is **stated** by the clinic rather
than inferred from addresses, so one registration may cover several branches,
branches may differ, and some may share one while another uses another; lapsed
registrations are kept beside their successors. The clinic's tax number has one
authoritative home — `organizations.tax_id` is now derived and read-only, and
`branches.tax_id` is dead. Branch tax jurisdiction became settable and inherits
from the organization instead of defaulting to India.

Full model, selection order, the open decisions, and the checklist for wiring a
new billable module live in
[`Architecture/tax-registration-implementation.md`](Architecture/tax-registration-implementation.md).
**Read it before touching `issuer_tax_registrations`, `tax_rules` or branch
jurisdiction, and before adding pharmacy, lab or inventory billing.**

### Phase 4 — Billing (patient invoicing)

Being built as the **centralized Invoice & Billing Engine** — one engine, many
billable sources, country-configurable tax, immutable issued documents. Progress
and every decision live in
[`Architecture/invoice-engine-implementation.md`](Architecture/invoice-engine-implementation.md);
this is the summary.

⚠️ **This is NOT `subscription_invoices`.** That table is rcln billing the
clinic, and it is complete. This one is the clinic billing a patient — different
issuer, different tax registration, different lifecycle, different RLS shape.
They must never be merged. Naming: `invoices`/`invoice_items` here,
`subscription_*` there; `services/invoicing/` here, `services/billing/` there.

- [x] **Phase 0 — existing-system analysis.** Recorded, including the three
      things already built that are being reused rather than rebuilt:
      `issueNumber()` (already the concurrency-safe sequencer, needs one new
      enum value), the tax engine in `@rcln/billing` (already refuses to guess a
      rate it holds no registration for), and `@rcln/payments`' integer
      minor-unit money. `billing.invoice.*` permission codes were already seeded
- [x] **Phase 1 — document & storage infrastructure.** New `@rcln/storage`
      package: `StorageProvider`, `LocalStorageProvider`, key validation, a
      config-driven factory. `DocumentService` in `apps/api`, generic over
      document type and deliberately knowing nothing about invoices. `files`
      extended into the generic document table with a status lifecycle, so
      "the invoice is issued" and "the PDF exists" can be two different facts.
      ⚠️ Three layers stop a key escaping the storage root, and the third — a
      **real-path** check — is the only one that sees a symlinked directory;
      measured by removing it. ⚠️ The explicit `organizationId` pin in
      `getDocument` is the ONLY thing stopping a tenant reading a platform-owned
      document, because `files`' policy permits a NULL `organization_id` on
      purpose; measured, and RLS does not cover it. 13 HTTP-free integration
      cases + 34 package tests. **666 API tests green**, 42 protected tables
- [x] **Phase 2 — tax engine generalisation.** New `@rcln/tax` package, extracted
      from `@rcln/billing` and proved by its 18 subscription cases passing
      untouched. The supplier is now an **issuer**: the same `resolveTax` serves
      rcln billing a clinic and a clinic billing a patient. Org-scoped
      `issuer_tax_registrations` + effective-dated `tax_rules` per item tax
      category; `branches` learnt an ISO `country_code`/`region_code`.
      ⚠️ **Place of supply is now explicit** — the customer for a digital
      service, the **issuing branch** for a consultation. Reading the patient's
      address instead makes a Karnataka clinic's supply inter-state because the
      patient lives in Kerala, and the state's half of the tax never reaches the
      state. ⚠️ **A category with no rule is `UNRATED`, never the registration's
      standard rate** — a clinic registration deliberately has no such column,
      because a rate nobody chose on an insurance claim is worse than a refusal.
      Phase 5's `finalizeInvoice` refuses to ISSUE an `UNRATED` invoice, which
      is that guard. ⚠️ These two tables take the **opposite** RLS decision from
      `tax_registrations`, and exempting them by analogy would leak a
      competitor's GSTIN and rate card with nothing failing.
- [x] **Phase 2b — country neutrality.** Found by sweeping every supported
      country through the engine: `GST` still meant _India_, so an Australian
      invoice printed `IGST` for an "inter-state supply" at exactly the right
      rate. ⚠️ **Correct arithmetic on a non-compliant document — every
      total-based assertion passed.** A rate and a line are now separate things:
      `tax_rules` carries `line_name`, `split` and `stacks`, so India splits
      CGST/SGST/IGST, Australia prints one `GST`, Ontario prints one `HST`, and
      British Columbia stacks federal `GST` + provincial `PST` — which an engine
      that picks a single rule cannot bill at all. `PROVIDER_REQUIRED` replaces
      the false `NOT_REGISTERED` for US sales tax and EU One Stop Shop, and
      `TaxProviderQuote` is the seam Avalara plugs into. `gst_number` → `tax_id`
      ⚠️ hand-written as `RENAME COLUMN`, because Prisma's DROP+ADD would have
      silently emptied every clinic's tax identifier.
- [x] **Phase 2c — the defaults catalogue.** `tax_rule_defaults`: the rate cards
      rcln maintains per country, plus four platform routes to maintain them.
      ⚠️ **Inherited at read time, never copied into a tenant** — the
      copy-at-signup design turns a rate change into a migration across every
      tenant and permanently destroys the difference between "this clinic chose
      12%" and "this is a stale copy of our old default". Same shape as
      `setting_definitions`/`setting_values`. A tenant rule beats a platform
      default before specificity, all-or-nothing per category. ⚠️ **Only
      healthcare-service exemptions are seeded, deliberately** — a medicine's
      rate varies by product within a country, so any seeded figure is wrong for
      much of what a pharmacy dispenses and wrong _invisibly_, because an
      inherited default looks configured. Goods resolve UNRATED until a clinic
      enters a rate it has checked. ⚠️ **Removing a rule is an end date, never a
      DELETE** — the row that priced last year's invoice is what explains it.
      692 API tests, 63 tax-package tests, 44 protected tables
- [x] **Phase 3 — invoice data model.** `invoices`, `invoice_items`,
      `invoice_taxes`, `invoice_documents`, plus `issueInvoiceNumber()` on the
      existing gapless counter. Org **and** branch scoped, composite-FK'd, every
      tax field snapshotted. ⚠️ **The invoice number carries the BRANCH CODE** —
      `INV-2026-APP-MAIN-000001`. A per-branch series with the brief's format is
      a compliance failure: two branches sharing one GSTIN both start at 1 and
      both issue `INV-2026-APP-000001`, which is the one thing a GST series may
      not do. ⚠️ **The children carry `organization_id` and `branch_id`
      themselves** — the `subscription_invoice_lines` parent-scoped shape asks
      the org question only, and their parent is branch-scoped, so a cashier at
      one branch would read another's lines. ⚠️ **`invoice_documents.file_id` is
      a plain FK**, because `files.organization_id` is nullable; a RESTRICTIVE
      `file_in_same_org` policy is what stops an invoice citing another tenant's
      PDF. ⚠️ **What an invoice bills for is an ENFORCED, typed column per
      source** — `appointment_id` today, composite-keyed so it can never cite
      another clinic's visit — never a generic `source_id`. A polymorphic uuid
      cannot be foreign-keyed, and the risk was never "that appointment does not
      exist" but "that appointment belongs to somebody else". Stub tables for the
      absent modules were rejected: a table with only an id proves existence and
      says nothing about ownership. ⚠️ **Nothing enforces immutability yet** — an
      ISSUED invoice's totals can still be rewritten; that guard landed in
      Phase 5.
      Found by running it: `number_sequences.prefix` was VARCHAR(16) and the
      first invoice ever numbered failed on it with a raw 22001. 714 API tests,
      48 protected tables, all 36 migrations verified against an empty database
- [x] **Phase 4 — calculation engine.** New `@rcln/invoicing` package: pure, no
      Prisma, no clock, integer minor units, and now the **only** code allowed to
      decide what goes in a money column. ⚠️ **It is NOT in `packages/billing`,
      which is what the plan said** — §0.1 of the log had already fixed the
      naming (`invoicing` is the clinic billing a patient, `billing` is rcln
      billing the clinic) and §0.8 contradicted it; `@rcln/tax` was split out of
      `@rcln/billing` in Phase 2 on the same argument. ⚠️ **The invoice-level
      discount is apportioned onto the lines BEFORE tax**, largest-remainder, and
      the test for it asserts the **tax** rather than the total — the brief's
      order gives ₹1080 against this engine's ₹1062 and both totals are arguable,
      while the ₹180 of GST inside the first is tax remitted on ₹100 the patient
      never paid. ⚠️ **Apportionment is weighted by what is LEFT of a line**, not
      its gross, or a line already discounted to zero goes negative. ⚠️ **Cash
      rounding applies to the total and never to a line** — rounding a line makes
      the stated tax stop being the rate times the base. ⚠️ **Quantity is an
      integer count of thousandths**, matching `Decimal(14,3)`; a fourth decimal
      place throws rather than truncating. ⚠️ **`TaxLine` now cites the rule that
      priced it**, which is the only way `invoice_taxes`' two audit columns can
      ever be non-NULL. Four deliberate breakages were applied and reverted to
      prove the suite bites — and one of them (taking `quote.total` instead of
      summing the printed lines) failed nothing until a test was added for an
      external provider's disagreeing quote. 723 API tests, 35 invoicing-package
      tests, 48 protected tables. Nothing persists a priced invoice yet
- [x] **Phase 5 — lifecycle and immutability.** DRAFT → FINALIZING → ISSUED →
      PARTIALLY_PAID/PAID, VOID from any issued state, CANCELLED from DRAFT
      only — enforced by **three triggers**, not by the service, because the
      service is one of several paths a write can take and a silently rewritten
      invoice is not an error at all. ⚠️ **The frozen set is an ALLOW-LIST of
      what may still move** (status, `amount_paid`, the cancel/void columns,
      `updated_at`), so a column added tomorrow is immutable after issue by
      default; `deleted_at` is deliberately not on it. ⚠️ **The lines needed
      their own guard** — a frozen `grand_total` over editable lines is an
      invoice stating a total that is not the sum of what it prints. ⚠️ **The
      `region_code` check Phase 2 deferred cannot be a null check**:
      `registrationFor()` ends `?? inCountry[0]`, so a Kerala branch under a
      Karnataka-only clinic prices perfectly and issues under the wrong GSTIN —
      the check has to mirror the selection rule and ask whether that fallback
      was taken. Writing it the obvious way refuses nothing at all, measured.
      ⚠️ **Taking the invoice number last buys the LOCK WINDOW and not the
      serial** — moving it ahead of the issuable check fails no test, because the
      transaction rolls the counter back; the comment claiming otherwise was
      corrected. A draft is now priced from the moment it exists, and
      finalisation re-prices from the stored inputs rather than trusting stored
      totals. ⚠️ **Credit notes deferred** — no table, no series, no
      `CREDIT_NOTE` source type, and with no patient-payments table no void can
      yet involve money. 744 API tests, 48 protected tables
- [x] **Phase 6 — document rendering.** ⚠️ **The screen and the PDF are the same
      document because they are the same string.** `renderInvoiceHtml(data)` in
      the new `@rcln/documents` produces one self-contained HTML document; the
      web puts it in an `<iframe srcdoc>` and the worker hands it to Chromium.
      The alternative — a PDF library plus a matching React screen — is two
      templates kept alike by hand, with no test for "these still look the same".
      ⚠️ **Chromium is in the WORKER and never in the api**, which is capped at
      1g and already exits 137 running its own suite; the worker went 768m → 2g.
      The PDF is therefore asynchronous, and that costs nothing because the UI
      renders from data — only Download waits. ⚠️ **The typefaces are committed
      as base64**, not read from `node_modules`: every failure of a runtime read
      is silent in one of the three runtimes, and a missing `@font-face` does not
      throw, it just prints the wrong typeface. ⚠️ **`latin-ext` is where ₹
      lives** (U+20AD-20C0) — the `latin` subset stops at the euro. ⚠️ **What the
      document calls itself is derived**: a Bill of Supply for an exempt Indian
      supply, a plain Invoice for an unregistered clinic, a Tax Invoice in
      AU/NZ/SG/AE and not in the UK. ⚠️ **No `timeFormat`** — an invoice is dated,
      not timestamped. `DocumentService` moved out of `apps/api` into
      `@rcln/documents/store` because the worker writes what the API serves, and
      `queues.ts` became `@rcln/queue` because a queue has two ends. Verified end
      to end: issue → job → Chromium → bytes on the host → an
      `invoice_documents` row whose checksum matches the file. 757 API tests, 21
      documents-package and 10 queue-package tests, 48 protected tables
- [x] **Phase 7 — invoice APIs.** Nine routes at `/v1/invoices`:
      list/detail/document/PDF/create/replace/issue/cancel/void. ⚠️ **Which
      invoices a caller sees is DERIVED from the modules they work in**, not
      granted per source — a pharmacist holds `pharmacy.dispense.read`, and that
      is what makes a pharmacy invoice their business.
      `billing.invoice.read_all` is the single escape for the accountant and the
      branch administrator, so a source added later needs no re-grant anywhere.
      ⚠️ **Applied in the QUERY and intersected with the caller's own
      `?sourceType=`** — a filter the client controls is not a boundary — and
      where it says no it says **404, not 403**, because a 403 on an id confirms
      both that the invoice exists and what kind it is. ⚠️ **A calendar date
      becomes local MIDDAY**: UTC midnight prints as the previous day west of
      Greenwich, and local midnight falls before a `DATE`-typed
      `effective_from` east of it, so the new tax rate silently misses its first
      day. ⚠️ **The list's date filter is two branches of an `OR`** because a
      draft has no issue date and would vanish from every range. ⚠️ **A write's
      read-back files no disclosure row** — a creation is a write, and logging
      the echo would fill `data_access_logs` with cashiers reading their own
      work. ⚠️ **No `?q=`**, ever: a customer name in a query string is a name in
      the proxy log, the browser history and the referrer. Found and fixed a
      Phase 5 bug this surface made visible — a whole-bill discount was stored
      and not priced until something re-priced the draft, so only the number the
      cashier decided from was wrong. Verified end to end over HTTP: issue →
      worker → 63,907 bytes of `%PDF-`. 785 API tests, 48 protected tables
- [x] **Phase 8 — appointment billing.** The first integrated source:
      `GET /v1/appointments/:id/billing` previews the fee and
      `POST /v1/appointments/:id/invoice` raises the draft, and the day board and
      appointment detail carry a `liveInvoice`. ⚠️ **No migration and no new
      permission code** — the rate card
      (`doctor_branch_settings.consultation_fee` / `follow_up_fee` /
      `follow_up_free_days`) has existed since the doctors phase with nothing
      reading it, so a service catalogue here would have been a second one.
      ⚠️ **"Is this visit billed?" is a question about the LIVE invoice**, never
      about `appointment_id`, which is non-unique so a void can keep its
      reference — cancelled and voided invoices leave the visit billable and stay
      in its history. ⚠️ **And because there is no unique index the check is a
      race**, so the appointment row is locked `FOR UPDATE`: two cashiers on one
      visit is an ordinary Monday. ⚠️ **The date of supply is the visit's
      branch-local day, not `now()`** — it selects the effective-dated tax rule,
      and `now()` would pass every other assertion in the suite. ⚠️ **A null
      `follow_up_fee` falls back to the consultation fee and does not mean
      free**, and a free review inside the window is a charge of ZERO rather than
      an absent charge — "we waive this" and "we have not decided" must not be
      the same value. ⚠️ **An unpriced visit refuses rather than billing zero**;
      `unitPriceMinor` is the way through and confers nothing
      `billing.invoice.create` did not already carry. ⚠️ **`liveInvoice` is
      ABSENT, not null, for a caller without `billing.invoice.read`** — null would
      read as "nothing has been billed today". Found while testing: the seeded
      DOCTOR role _does_ hold `billing.invoice.read`, so the first version of that
      assertion passed against an empty board. 806 API tests, 48 protected tables
- [x] **Phase 9 — frontend invoice module.** The ledger at `/invoices` with
      URL-param filters, the detail screen with the document in a sandboxed
      iframe, the draft editor, the Raise invoice path on the consultation screen
      and the billing column on the day board — plus the two Phase 7 known issues
      this phase was the right home for. ⚠️ **The Phase 6 preview frame had never
      been imported, and the first screen to import it failed `next build`
      outright** — `renderInvoiceHtml` reaches `react-dom/server`, which Next
      declines in a Server Component's module graph and in an App Route's alike,
      with typecheck clean throughout. The render moved to the API as
      `GET /v1/invoices/:id/preview`, which is the better home: the web is now a
      conduit for both representations of an invoice rather than the renderer of
      one and the proxy of the other. ⚠️ **`cashRoundingMinor` was not merely a
      parameter that should have been a setting — it was silently broken.** Never
      stored, so finalisation re-priced without it: a clinic rounding to the rupee
      approved a rounded draft and handed the patient an unrounded document. Now
      `billing.cash_rounding_minor`, resolved inside `priceDraftInvoice` so every
      pricing path agrees, and gone from the wire. ⚠️ **`.partial()` keeps
      `.default()`**, so a description-only PATCH rewrote `treatment`, `split` and
      `stacks` — including on the platform's own catalogue, where unsplitting
      India's GST rule changes what every clinic in the country charges. Found by
      a test asserting a rename still saves. ⚠️ **The tenant rate card is the
      first write path `issuer_tax_registrations` and `tax_rules` have ever
      had** — every clinic until now ran entirely on rcln's published catalogue,
      which is a defensible default and not a configuration. `billing.tax.read` /
      `.manage`, not a settings code: a preference annoys somebody, a rate decides
      what every patient is charged. ⚠️ **Ending a rule falls back to the
      catalogue only where the catalogue covers the category** — goods
      deliberately have no default, so ending a medicine rate leaves it UNRATED
      and unissuable. Both outcomes asserted; the first version of the code and
      the test both assumed the fallback was universal. 833 API tests, 48
      protected tables. ⚠️ `next build` fails on the marketing sandbox page,
      unrelated and pre-existing as far as its module graph shows
- [x] **Phase 10 — audit.** ⚠️ **Not one invoice write had ever written an audit
      row.** The phase was planned as "the screen that reads the trail back";
      `services/invoicing/` imported `recordDataAccess` and never `recordAudit`,
      so a bill could be opened, re-priced, issued, cancelled and voided with
      nothing anywhere naming who did it — and `invoices.test.ts` asserted the
      opposite in prose at the top of the file. All five writes now file a row
      from one allow-list snapshot, plus the history drawer on the invoice detail
      and on the rate card's rows, which have been auditable since Phase 9 with
      nothing reading them. ⚠️ **The snapshot is read from the ROW on both sides,
      never built from the request** — the interesting half of an invoice is
      derived, so a snapshot from the request body would be silent about
      finalisation's re-price, which is the one change on this surface no human
      makes. ⚠️ **And the create's snapshot is taken after the PRICING**: the row
      between the INSERT and the pricing has every money column at `@default(0)`,
      and filing that would record a ₹1,120 invoice as costing nothing,
      permanently. ⚠️ **`lineCount`, not the lines** — `invoice_items.description`
      is "Ultrasound, obstetric". ⚠️ **`hasNotes` / `hasCancellationReason`, and
      `notes` and `cancellation_reason` are now in `REDACTED_KEYS` as the schema
      has claimed since Phase 3 without it being true.** ⚠️ **`billing.invoice.read`
      does NOT imply `audit.record.read`**: the audit endpoint keys on
      `(entityType, entityId)` and knows nothing about an invoice's source, so
      the obvious widening would hand a receptionist the trail of a lab invoice
      the ledger hides from them. ⚠️ **The PHI sweep expects ONE hit and the hit
      is the finding** — a tax rule's `description` is free text recorded
      verbatim, correctly, and no allow-list can stop a clinic typing a patient's
      name into a field whose contents are the record. No migration, no
      permission code, no seed row. 847 API tests, 48 protected tables
- [ ] **Phase 11 (next)** — S3 provider + final QA, and running the pre-existing
      `next build` failure on the marketing sandbox page to ground
- [ ] ⚠️ **Lab, pharmacy and inventory invoice integration is deferred and cannot
      be done yet** — those modules do not exist (Phases 5–6 below). Their source
      types and `LAB`/`PHA`/`INV` codes ship with the engine so they land later
      as integration rather than redesign, but there are no `lab_orders` or
      `pharmacy_sales` tables for an invoice to reference. Each gains its typed,
      enforced `invoices` column in the migration that creates its own table
- [ ] `billable_items`, GST tax lines on patient invoices
- [ ] `payments` + `payment_allocations` (one payment across several invoices)
- [ ] `number_sequences` with financial-year reset
- [ ] Credit notes, refunds, patient ledger

### Phase 5 — Pharmacy and inventory

➡️ **Planned in full at [`.kb/PharmacyInventory/`](PharmacyInventory/README.md).**
That directory supersedes the five lines below, which understate the scope: the
programme is a global Product + Inventory + Pharmacy + Clinical Consumption +
Procurement + Regulatory platform serving clinical, dental, veterinary and lab
workflows across ten jurisdictions, not a pharmacy module. Start at
`PharmacyInventory/NEXT_SESSION.md`.

**PI-0 through PI-8 are complete.** PI-1..PI-6 are merged to `main`; PI-7 and
PI-8 are on the programme branch and have NOT been through `/code-review` or
`security-reviewer` yet — required before merge, because between them they add
twelve tenant tables, the credit-note kind on `invoices`, and three new
permission codes.

**PI-9 (Clinical Consumption) remains blocked** on `encounters`/`procedures`.
**PI-10 (Recall) and PI-12 (Online Pharmacy) are unblocked** as of PI-8.

What PI-1 built: the catalogue, and nothing with a quantity in it.

- [x] `units_of_measure` + `unit_conversions`, with an exact-rational conversion
      engine in `apps/api/src/services/product/units.ts` — integer ratios over
      `bigint`, never a float, and a `{ quantity, exact }` result so a lossy
      conversion is an event a caller has to handle rather than a silent round
- [x] `products` as the root with a `ProductType` discriminator (PI-ADR-001):
      medicines, gloves, implants, reagents and dental materials in ONE table,
      so there is one inventory engine rather than two
- [x] Categories (a `parent_id` tree, same shape as the clinical taxonomy),
      manufacturers, active ingredients, compositions with per-ingredient
      strengths, storage profiles
- [x] Product packaging ladders, identifiers, per-jurisdiction tax
      classification resolving to a `tax_category` string — and **no tax logic
      whatsoever**, per PI-ADR-006
- [x] **Thirteen tables in `platform_extensible`, plus ten RESTRICTIVE
      `*_visible` policies.** A tenant cannot attach another clinic's private
      category, unit, ingredient or composition to its own row; a tenant cannot
      edit a platform row; and a tenant cannot attach a child to a platform
      product at all, because the composite FK makes it unrepresentable. That
      last one is what turns "clone, don't edit" from documentation into a
      constraint
- [x] New `product` permission module (PI-ADR-011), so a lab manager maintains
      reagents without holding a pharmacy code
- [x] Seed: 35 units, 10 conversions, 32 categories, 9 storage profiles.
      **Zero medicines** — see OD-4, and the warning in
      `seed/data/product-masters.ts` about why no agent may invent any
- [x] Screens at `/products` — server-paginated list, create form, detail with
      six tabs. Nav entry reads "Catalogue", not "Pharmacy"
- [x] 983 API tests green; `db:rls:check` green at 65 protected tables
- [x] `/code-review` and `security-reviewer` on the diff — both run, two
      CRITICALs and five findings, all fixed. Merged as PR #30
- [ ] The screens have not been opened in a browser

⚠️ One RLS bug was written and caught by the isolation suite in this phase: a
`parent_visible` policy on `product_categories` self-referenced its own table,
raised `infinite recursion detected in policy`, and — because
`products.category_visible` reads that table — took down every read of `products`
for every tenant. Removed in `drop_category_parent_visible`; `specialties` has
carried the identical gap since it shipped, for the identical reason.

⚠️ Its pharmacy-dispensing and clinical-consumption phases are hard-blocked on
`prescriptions` and `encounters`/`procedures`, which Phase 3 owns. Its product,
inventory, procurement and regulatory phases are not blocked and can start now.

What PI-2 built: everything with a quantity in it.

- [x] **`stock_ledger` — append-only, and the only source of quantity truth**
      (PI-ADR-004). `rcln_app` holds no UPDATE or DELETE on it and a trigger
      refuses both anyway — the same two independent layers `audit_logs` has
- [x] **`stock_balances` — a cache the application cannot write.** `rcln_app`
      holds SELECT and nothing else; a SECURITY DEFINER trigger maintains it.
      That is rule 2 as a grant rather than as an agreement, and
      `verifyBalances()` replays the ledger to prove the two agree
- [x] `inventory_locations` → `storage_areas` → `storage_bins` (PI-ADR-012). A
      branch has MANY locations: a pharmacy, a fridge, a controlled cabinet and a
      trolley per procedure room are four different answers to "where is it"
- [x] `batches` (lot, expiry, cost per BASE unit, recall and quarantine columns)
      and `serials` — whose `assigned_patient_id` is **PHI**, and every read of
      it writes a `data_access_logs` row under the new `INVENTORY_SERIAL`
      resource (PI-ADR-016)
- [x] **Seven tables in BOTH the `org_scoped` and `branch_scoped` arrays** — the
      opposite tenancy class from the catalogue, and deliberately so: there is no
      such thing as a platform batch. Plus seven RESTRICTIVE `*_visible`
      policies, because `batches.product_id` cannot be a composite FK when a
      clinic legitimately stocks a PLATFORM product
- [x] The sign of a movement is a property of its TYPE and is CHECKed, never
      chosen by a caller; the tracking mode is enforced in the database
      (PI-ADR-014); a balance may never go negative
- [x] **`@rcln/inventory`** — the ledger writer, extracted into a package because
      the expiry sweep runs in the worker and "only one writer" had to survive it
- [x] **The expiry sweep — the first worker processor that changes clinical
      state.** Hourly, not nightly, because "midnight" is a different instant in
      every clinic: each tick asks every branch whether the date has rolled over
      IN ITS OWN ZONE (invariant 6)
- [x] Screens at `/stock` — overview, lots, locations and the movement ledger.
      Nav entry reads "Stock", beside "Catalogue"
- [x] 1087 API tests green across 39 suites, including ledger/cache agreement
      under 50 parallel writes; `db:rls:check` green at **72** protected tables
- [x] `/code-review` and `security-reviewer` on the diff. Two CRITICALs — a
      `REVOKE ... FROM PUBLIC` that left `rcln_app`'s role-specific EXECUTE grant
      on a SECURITY DEFINER, RLS-bypassing write into the balance cache, and a
      display helper that rendered every quantity an order of magnitude small —
      plus a HIGH and eleven WARNINGs. All fixed bar two accepted; see
      `.kb/PharmacyInventory/CHANGELOG.md`
- [ ] The screens read and do not write: no form for a location, a lot or a
      movement, and no `/stock/serials` screen. Nothing clicked in a browser

What PI-3 built: the three documents a store actually needs.

- [x] **`stock_reason_codes` — the controlled vocabulary an adjustment must
      cite**, and the ONE platform-extensible table in the inventory domain. A
      reason code is a word, not a fact about a clinic; thirteen ship in the
      migration so a clinic can record its first adjustment without inventing a
      vocabulary. The ledger still stores the code as a STRING, because a row
      must outlive whatever explained it
- [x] **`stock_transfers` + `stock_transfer_lines`** — intra-branch (one atomic
      pair of legs, one transaction) and inter-branch (dispatch, receive in full
      or in part, cancel with a compensating movement)
- [x] **IN-TRANSIT STOCK IS HELD BY THE DOCUMENT, NOT BY A BUCKET**, which
      refines `INVENTORY_ARCHITECTURE.md` and was forced by `branch_isolation`:
      a sender-owned `IN_TRANSIT` bucket makes the RECEIVER write against a
      branch RLS hides from them, fixable only by widening their tenant context
      or by adding a second ledger writer. Each leg is a single-branch write and
      no context is ever widened. ⚠️ The cost — in-transit quantity is not in
      `stock_balances` — is recorded for PI-22 and pinned by a test
- [x] **The lot's identity and the shelf names travel ON the document.** Two
      migrations exist because `batches` and `inventory_locations` are
      branch-scoped and a receiving storekeeper could read NEITHER: the detail
      response threw on a NULL join, and receipt raised `Batch not found` while
      somebody held the boxes. Both found by a test, neither visible from
      reading, and neither fixed by weakening a policy
- [x] **`stock_reservations` — `RESERVED` made real**, with a 90-day cap and an
      hourly worker sweep that gives back what nobody came for. The row is the
      paperwork; the `RESERVATION` movement is the fact, and they commit together
- [x] **FEFO allocation as a PURE function in `@rcln/inventory`**, with a
      per-product `FEFO`/`FIFO`/`LIFO` override where NULL means "nobody has
      thought about it" and PI-5's rule packs NARROW the candidates rather than
      reordering them. A lot with no expiry sorts LAST
- [x] `inventory.stock.reserve` and `inventory.reason_code.manage`; routes on
      `/v1/stock/*` and `/v1/stock-transfers/*`
- [x] Screens: `/stock/transfers` (list, new, detail with the action that is
      actually yours), `/stock/reservations`, `/stock/adjustments/new`
- [x] 1159 API tests green across 41 suites — transfer atomicity, no negative
      balance, FEFO ties, the two-ended RLS policy seen from a third branch;
      `db:rls:check` green at **76** protected tables
- [x] `/code-review` and `security-reviewer` on the diff. Three CRITICALs, all
      one class of mistake — a receipt loop reading its bounds from a snapshot
      loaded once (a duplicate line minted stock, and `verifyBalances()` agreed
      with the inflated figure), unlocked state transitions under READ
      COMMITTED, and a manual release racing the sweep. Plus a serial fitted to
      a patient between draft and dispatch still being transferable. All fixed;
      see `.kb/PharmacyInventory/CHANGELOG.md`
- [ ] Nothing clicked in a browser

Strictly in this order; dispensing depends on batches existing.

- [x] Catalogue: generics, medicines, manufacturers, HSN + versioned tax rates
- [x] Batches, `stock_ledger` (append-only), `stock_balances` (trigger-maintained)
- [x] Stock transfers between branches, adjustments, reservations, FEFO — PI-3
- [x] Suppliers → purchase orders → goods receipts → returns, costing — PI-4
- [x] Regulatory FRAMEWORK — jurisdictions, rule packs, `@rcln/regulatory`, the
      maturity ladder — PI-5. The framework only: it contains no country's rules
- [x] India rule pack, cited to real sources — PI-6. 22 rules from the Drugs
      Rules, 1945 and the Pharmacy Act, 1948; goods receipt and transfer consult
      the engine. ⚠️ Enforcement is gated on a human sign-off, so nothing blocks
      yet, and most of India's matrix cells are still `RESEARCH_REQUIRED` — NDPS
      above all. See `COUNTRY_SUPPORT_MATRIX.md` for what was deliberately not
      written
- [x] Dispensing with FEFO batch selection — PI-7. The queue, pharmacist
      verification, the supply, returns, counter sales and equivalents. Eight
      tables including `regulatory_decisions`, PI-ADR-008's snapshot: every
      supplied line cites the decision that permitted it, and nothing ever
      re-evaluates a historical supply. ⚠️ A dispense has no draft — the record,
      the ledger legs, the snapshot and the audit row are one transaction, and
      the number is taken last so a refusal burns none. ⚠️ Enforcement is still
      gated on a human sign-off, so a refusal is recorded and reported and stops
      nothing. Pharmacy owns no money: billing is PI-8
- [x] Billing and tax integration — PI-8. `charge_requests` is the structured
      hand-off a dispense writes in its OWN transaction; the charge POLICY
      decides whether a supply reaches a bill at all (a consumed glove produces
      no invoice line, an implant does); `product_prices` is what a clinic sells
      for, with a branch override beating an organization default. `POST
/v1/invoices/from-charges` raises an ordinary `sourceType: PHARMACY`
      invoice through the engine Phases 3–7 built, and nothing in the programme
      inserts an `invoice_item` or computes a tax figure.
      ⚠️ **The credit-note engine landed here** — the gap `voidInvoice`'s header
      recorded as deliberate. A credit note is an `invoices` row with
      `kind: CREDIT_NOTE` and its own consecutive `CRN-` series, so it inherits
      `invoices_lifecycle_guard` rather than needing a second copy of it. It
      moves no money: there is still no patient-payments table, so
      `billing.refund.process` remains unreachable.
      ⚠️ A charge request can never STOP a supply — every configuration gap is a
      nullable column shown on the review screen, never an exception thrown at a
      pharmacist mid-dispense.

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
