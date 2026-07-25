# Status

Living document. Update it when a phase completes or direction changes.

**Last updated:** 2026-07-25 · **Current phase:** 0 complete, 1 not started

---

## Where we are

Phase 0 (foundation) is done and verified. Nothing product-facing ships in
Phase 0, and that is correct — every shortcut taken in tenancy or access control
becomes a data breach later.

The repository is a working monorepo that starts with one command, isolates
tenants at the database level, and proves it with tests.

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

### Tests

- [x] 25 permission-resolver cases (the whole multi-branch admin matrix)
- [x] 11 tenant-isolation cases against real Postgres with real migrations

---

## Not done

### Phase 1 — Tenancy and auth (next)

The first product-facing work. Contracts already exist in `@rcln/contracts`;
the endpoints do not.

- [ ] `POST /auth/login` — password, identifier is email or phone
- [ ] `POST /auth/otp/request` + `/auth/otp/verify` — phone-first, non-negotiable in Indian healthcare
- [ ] `POST /auth/refresh` — rotation with reuse detection
- [ ] `POST /auth/switch-branch` — validate against `membership_roles`, re-issue token, audit it
- [ ] `POST /organizations/register` — org + domain + first branch + owner + membership + trial, one transaction
- [ ] Branch CRUD, operating hours
- [ ] Invitations + accept flow
- [ ] Roles and permission-override management
- [ ] Super-admin impersonation with audit trail and a persistent UI banner
- [ ] Web: login, branch switcher, org settings

**Prerequisite for all of it:** an `authenticate` + `authorize` middleware pair
that populates `req.auth` (the shape is already declared in
`apps/api/src/types/express.d.ts`) and builds the `TenantContext`.

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
- [ ] **Decision: DPDP erasure vs medical retention.** They conflict. Resolve as anonymisation, and write the decision down.

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
