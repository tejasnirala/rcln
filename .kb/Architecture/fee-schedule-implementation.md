# Consultation Fees & Doctor Compensation — implementation log

What a clinic charges for an appointment, and what it pays the doctor who takes
it. A fee schedule with clinic defaults and per-doctor overrides, frozen onto the
appointment at booking, charged again when a patient moves the slot.

Living document. Every station appends a section: Completed · Files changed ·
Database changes · API changes · Tests added · Known issues · Next station.

- **Branch:** `feat/phase-3-clinical-core`
- **Started:** 2026-08-10
- **Status:** **All five stations shipped and validated** (2026-08-10). The one
  gap left on purpose is a reschedule screen — see station 5.

---

## Resuming this work in a new session

**Read, in this order:** `CLAUDE.md` → §0.1 below (what already exists — roughly
half of this feature is a generalisation of something that is already there) →
§0.2 (the twelve decisions, all of them made by the product owner and none of
them re-litigable without asking) → §0.6 (the station table) → the last
completed station's section → its "Next station".

⚠️ **VERIFY AGAINST THE CODE BEFORE TRUSTING ANY CLAIM HERE.** This document is
written ahead of the work, which the invoice engine's log was not. A line saying
"station 2 does X" is a plan until a station section below says it shipped.

### State of the tree

⚠️ **Nothing is committed.** This work starts on top of two other uncommitted
bodies of work on the same branch: the clinical taxonomy, and the invoice engine
through Phase 10. `git status` before assuming anything about the base.

⚠️ **The invoice engine is at Phase 10 of 11 and this feature reaches into it.**
`services/invoicing/appointment-billing.service.ts` is the only consumer of the
fees today, and station 3 changes what it reads. Read
[`invoice-engine-implementation.md`](invoice-engine-implementation.md) §0.1 first
— in particular that `invoices` and `subscription_invoices` are two different
things that must never be merged.

### The five things most likely to trip up a fresh session

1. ⚠️ **`AppointmentVisitType` ALREADY HAS EXACTLY THE RIGHT VALUES.** `NEW`,
   `FOLLOW_UP`, `WALK_IN`, `TELECONSULT`, `PROCEDURE`. Every appointment already
   carries one, chosen by the receptionist at booking. Do not invent a parallel
   "appointment type" — the visit type IS the fee type.
2. ⚠️ **THE SETTINGS RESOLVER ALREADY DOES CLINIC → DOCTOR INHERITANCE** —
   precedence `USER → DOCTOR → BRANCH → ORGANIZATION → PLATFORM → default`, in
   `apps/api/src/services/settings/resolver.service.ts`. It is **not** being used
   for fees, and §0.2 decision 1 says why: its `DOCTOR` scope is single-axis and
   cannot express "this doctor, at this branch", which is a capability
   `doctor_branch_settings` has today and which the product owner kept.
3. ⚠️ **THE FEES THAT EXIST TODAY LIVE ON `doctor_branch_settings`** and are read
   by exactly one function, `resolveCharge()` in
   `appointment-billing.service.ts`. Station 1 migrates them out and drops the
   columns. Nothing else reads them — verified by grep, not assumed.
4. ⚠️ **"Clinic" IN THE NAV IS `/settings`.** The screen the product owner calls
   the Clinic section is `apps/web/src/app/(tenant)/t/[slug]/(app)/settings/`,
   labelled "Clinic" in `tenant-header.tsx`. The fee grid goes there.
5. ⚠️ **COMPENSATION IS A DEFERRED DOMAIN BEING PARTLY OPENED.** `STATUS.md` says
   "compensation and payouts stay in Phase 4", and the permission code
   `billing.doctor_payout.manage` is already seeded, held by BRANCH_ADMIN and
   ACCOUNTANT, with no table and no module behind it. This work records an agreed
   salary and **does not** build payouts (§0.3). Do not let it grow into one.

### Commands that actually work here

These are the invoice engine log's, unchanged — the same container limits apply.

```bash
# typecheck + lint, whole repo. 35 of 36 tasks pass; apps/api's typecheck OOMs
# and is run separately below. That is not a code failure.
docker compose run --rm --no-deps api sh -c 'pnpm exec turbo run typecheck lint --concurrency=1'

docker compose run --rm --no-deps api sh -c \
  'cd apps/api && NODE_OPTIONS=--max-old-space-size=3072 npx tsc -p tsconfig.test.json'

# API tests, in the two documented splits — one jest process is killed by the
# container's memory limit and reports as `Killed` with no failing test.
docker compose run --rm --no-deps api sh -c \
  'cd apps/api && NODE_OPTIONS="--experimental-vm-modules --max-old-space-size=3072" \
   npx jest tests/unit tests/integration/a tests/integration/b tests/integration/c \
   tests/integration/de tests/integration/do tests/integration/i --runInBand --silent'   # 537

# ⚠️ `tests/integration/f` (the fee suite) belongs in THIS split. Adding it to the
#    first one takes that jest process over the container's memory limit.
docker compose run --rm --no-deps api sh -c \
  'cd apps/api && NODE_OPTIONS="--experimental-vm-modules --max-old-space-size=3072" \
   npx jest tests/integration/f tests/integration/n tests/integration/p tests/integration/r \
   tests/integration/s tests/integration/t tests/integration/v --runInBand --silent'     # 347

docker compose exec api pnpm --filter @rcln/db run rls:check   # 51 tables today

# ⚠️ AFTER ANY PERMISSION-CODE CHANGE. The codes are rows, and a route gated on
#    an unseeded one answers 403 to the owner with nothing in the logs saying why.
docker compose exec api pnpm --filter @rcln/db run seed              # 106 permissions
docker compose run --rm --no-deps web sh -c 'cd apps/web && npx tsc --noEmit'
docker compose run --rm --no-deps web sh -c 'cd apps/web && npx eslint src --max-warnings 0'
```

⚠️ `prisma migrate dev` fails in this environment (non-interactive). Write the
migration by hand: `prisma migrate diff --from-config-datasource --to-schema
prisma/schema.prisma --script`, review it, put it in a timestamped folder, then
`prisma migrate deploy`. ⚠️ Running `prisma generate` while the dev server is up
wedges the tsx watcher and leaves api **unhealthy with no error** — `docker
compose restart api`.

### Green baseline to return to

**884 API tests** (537 + 347) · 63 tax · 35 invoicing · 40 billing · 34 storage ·
21 documents · 10 queue · 39 permissions · 95 payments · `db:rls:check` at **51**
protected tables · repo typecheck and lint clean · api and worker healthy.
(The 847/48 figures were the pre-fee-schedule baseline.)

⚠️ `next build` is NOT in this baseline and currently FAILS on
`/(marketing)/billing/sandbox` — pre-existing since Phase 9, unrelated, and a
prerender error rather than a compile one. Do not treat it as a regression from
this work; do check it has not gained a SECOND failing page.

---

## §0 What this is

An admin who runs a clinic sets what an appointment costs, by kind of
appointment. A doctor added to that clinic inherits those prices, and an admin
may override any of them for that doctor. When a patient books, the price that
applies is worked out and **frozen onto the appointment**, so what the patient is
quoted at the desk is what the invoice bills. Moving the appointment costs extra
— unless the clinic is the one moving it.

Separately and unrelated to what patients pay: an admin records what the clinic
has agreed to pay each doctor, and over what interval. It is a record, not a
payroll run.

### §0.1 What already exists and must NOT be rebuilt

| Thing                                             | Where                                                     | Verdict                                                                                                             |
| ------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| The five appointment kinds                        | `AppointmentVisitType` in `schema.prisma:500`             | **Reuse as the fee types.** Already on every appointment, already chosen at booking                                 |
| Per-doctor-per-branch fees                        | `doctor_branch_settings.{consultation_fee,follow_up_fee}` | **Migrate and drop.** Superseded by the fee schedule; one reader                                                    |
| The free-follow-up window                         | `doctor_branch_settings.follow_up_free_days`              | **Leave exactly where it is.** Decision 11 — it works, it has tests, it is not money                                |
| Fee resolution for a visit                        | `resolveCharge()` in `appointment-billing.service.ts`     | **Rewrite in place.** The only reader of the old columns                                                            |
| The unpriced reasons the billing panel renders    | `NO_RATE_CARD` / `NO_FEE_SET` in `contracts/invoices.ts`  | **Keep both, re-point them.** `NO_RATE_CARD` = nothing resolved at any level; `NO_FEE_SET` = this fee type is blank |
| The per-visit price override the cashier can type | `unitPriceMinor` on `createAppointmentInvoiceRequest`     | **Untouched.** The escape hatch stays the escape hatch                                                              |
| Settings inheritance, clinic → branch → doctor    | `services/settings/resolver.service.ts`                   | **Not used here.** See decision 1                                                                                   |
| `billing.doctor_payout.manage`                    | `permissions/src/codes.ts:282`                            | **Not reused.** See decision 8                                                                                      |
| Money conversion, `numeric(14,2)` ↔ minor units   | `services/invoicing/money.ts`                             | **The only boundary.** Do not add a second                                                                          |
| Rescheduling, which can also change the doctor    | `rescheduleAppointment()` in `appointment.service.ts`     | **Extend.** Records no reason, no count and no initiator today                                                      |

### §0.2 The decisions taken

All twelve were answered by the product owner on 2026-08-10. **Do not quietly
reverse one because it is inconvenient to build — ask.**

1. **Fees vary by branch, at both levels.** Clinic defaults per branch, doctor
   overrides per branch. ⚠️ This is why the settings resolver is not the
   mechanism: its `DOCTOR` scope is single-axis and cannot say "this doctor, at
   this branch", which `doctor_branch_settings` can today. Rejected: org-wide
   only, and clinic-per-branch-with-doctor-org-wide.
2. **Fee types are the five visit types now, string-keyed for later.** The column
   is a `varchar`, not an enum, so a clinic-defined catalogue can arrive without a
   migration. Rejected: a clinic-defined catalogue now — it needs a new field on
   `appointments` and a second thing for the receptionist to pick, which can then
   disagree with the visit type.
3. **The old columns migrate and are dropped.** (Product owner deferred to me.)
   `consultation_fee` → a `NEW` entry, `follow_up_fee` → a `FOLLOW_UP` entry.
   Two places that look like the fee is how a clinic bills a number nobody set.
4. **Null means inherit, zero means free.** (Mine.) Already the rule here — a
   null `follow_up_fee` falls back rather than billing zero, because reading a
   blank as free bills every review at nothing, silently.
5. **Admins set fees; the doctor may only view them.** Both the fee overrides and
   the salary are filled in by the admin, at the point the doctor is added or
   later. A doctor sees their own and changes nothing.
6. **Compensation is recorded, not paid out.** An amount and an interval against
   the doctor. No payout runs, no periods, no reconciliation. See §0.3.
7. **One salary per doctor, organization-wide.** A person has one employment
   contract; splitting it across branches is cost allocation, not payroll.
8. **Compensation gets its own permission pair**, `doctor.compensation.read` /
   `.manage`. ⚠️ NOT `doctor.update`, which every BRANCH_ADMIN holds — whoever can
   fix a typo in a bio would then read everyone's pay. NOT
   `billing.doctor_payout.manage` either: it was named for running payouts.
   ⚠️ **BRANCH_ADMIN is excluded** (mine, within the option chosen): pay is not a
   branch manager's business by default, and a clinic can grant the code per
   membership, which is a smaller decision than a role change. ORG_OWNER and
   ORG_ADMIN receive it automatically, being "everything except".
9. **The fee is frozen onto the appointment at booking.** Not resolved at invoice
   time (today's behaviour) and not effective-dated. A fee change reaches visits
   booked afterwards and no others.
10. **No pro rata on a fee change.** Explicitly withdrawn by the product owner
    after being asked: _"it gave a very bad impression for a clinic"_. A frozen
    fee stands even if the fee has since risen. ⚠️ Do not reintroduce this as a
    "correctness fix" — it was considered and rejected on customer-experience
    grounds.
11. **The free-follow-up window stays as it is**, per doctor per branch, on
    `doctor_branch_settings`. A reschedule charge still applies on top of a free
    follow-up: the charge is for moving the slot, not for the consultation.
12. **Rescheduling:**
    - A **clinic-initiated** move is never charged. Who initiated it is recorded,
      because the system cannot currently tell — and billing a patient because
      your doctor took leave is the bill that ends up on Google Reviews.
    - A **patient-initiated** move is charged **once per move** — three moves,
      three lines — and **records a reason**.
    - A move to a **different doctor re-resolves the fee** to the new doctor's.
      ⚠️ This is not decision 10 reappearing: that was one doctor's price moving
      over time; this is a different practitioner giving a different
      consultation. Billing a consultant at a junior's rate loses real money.
    - A move that changes only the time keeps the frozen fee.
    - The charge itself is a fee type in the same grid (`RESCHEDULE`), so a
      clinic sets a default and a doctor can override it, like every other row.
13. **The front desk sees the fee while booking**, as the doctor and visit type
    are chosen. A fee frozen at booking that nobody sees until the invoice is a
    quote the patient was never given.
14. **Payout intervals: all six** — `MONTHLY`, `FORTNIGHTLY`, `WEEKLY`, `DAILY`,
    `HOURLY`, `PER_SESSION`. ⚠️ `PER_SESSION` overlaps conceptually with the
    consultation fee, which is also per appointment; they are different facts
    (what the clinic pays vs what the patient pays) and both were wanted.

### §0.3 Deliberately NOT in scope

- **Payout runs, payslips, periods, or reconciliation against collections.** That
  is the deferred Phase 4 compensation module. Decision 6.
- **Fee-share compensation** (a doctor taking a percentage of what they billed).
  Offered and not chosen.
- **Effective-dated fees.** Decision 9 — a fee change applies from now on.
- **Pro rata top-ups on a reschedule.** Decision 10, withdrawn deliberately.
- **A clinic-defined fee catalogue.** Decision 2 leaves the door open; nobody is
  walking through it yet.
- **Anything that charges a patient at booking.** The fee is frozen and shown; no
  money moves until an invoice is raised, and there is still no payments table.

### §0.4 The data model, as agreed

```
fee_schedule_entries                       (new, tenant table → needs RLS)
  organization_id
  branch_id          NULL = every branch   ← the membership_roles idiom, ADR-0002
  doctor_profile_id  NULL = clinic default
  fee_type           varchar               ← not an enum; decision 2
  amount             numeric(14,2)
  UNIQUE (organization_id, doctor_profile_id, branch_id, fee_type) NULLS NOT DISTINCT

appointment_reschedules                    (new, tenant table → needs RLS)
  organization_id, branch_id, appointment_id
  from_start, to_start
  from_doctor_profile_id, to_doctor_profile_id
  initiated_by       PATIENT | CLINIC      ← decision 12
  reason             text                  ← ⚠️ PHI-capable; REDACTED_KEYS
  charge_amount      numeric(14,2)
  created_at, created_by

doctor_compensation                        (new, tenant table → needs RLS)
  organization_id, doctor_profile_id UNIQUE
  amount             numeric(14,2)
  interval           PayoutInterval        ← the six of decision 14
  created_at, updated_at, updated_by

appointments                               (altered)
  + booked_fee       numeric(14,2) NULL    ← frozen at booking; decision 9

doctor_branch_settings                     (altered)
  − consultation_fee                       ← migrated to a NEW entry
  − follow_up_fee                          ← migrated to a FOLLOW_UP entry
    follow_up_free_days                    ← STAYS; decision 11
```

⚠️ **Three new tenant tables means three RLS policies in
`packages/db/prisma/rls/enable-rls.sql`, appended to the generated migration, and
three cases in `tenant-isolation.test.ts`.** `db:rls:check` goes 48 → 51 and
fails until they exist — deliberately, because a missing policy produces no error
and breaks no single-tenant test.

⚠️ **Composite FKs, not simple ones** (ADR-0004): `appointment_reschedules` reaches
`appointments` through `(organization_id, id)`, and every doctor reference goes
through the org. A cross-tenant child must be unrepresentable.

### §0.5 The resolution rule

One function, one place. Most specific wins:

```
1. doctor + branch          this doctor, at this branch
2. doctor + branch NULL     this doctor, anywhere
3. branch, doctor NULL      the clinic's default at this branch
4. both NULL                the clinic's default everywhere
5. nothing                  unpriced → NO_RATE_CARD / NO_FEE_SET
```

⚠️ **A resolved row holding zero is a resolved row.** Free is a price. Only the
absence of a row falls through to the next level — decision 4.

⚠️ **ONE IMPLEMENTATION.** The booking screen, the freeze at booking, the
reschedule re-resolve and the invoice engine all ask the same function. A second
copy is how a screen quotes a patient one number and the bill states another.

### §0.6 Station plan

Every station leaves typecheck, lint, tests and `db:rls:check` green.

| #   | Station                      | Delivers                                                                  | Status   |
| --- | ---------------------------- | ------------------------------------------------------------------------- | -------- |
| 1   | Schema, RLS, data migration  | The four tables above, policies, isolation cases, old columns retired     | **Done** |
| 2   | Resolution engine + fee APIs | §0.5 in one function; clinic-default and doctor-override endpoints        | **Done** |
| 3   | Booking freeze + reschedule  | `booked_fee` written at booking; reschedule charge, reason, initiator     | **Done** |
| 4   | Compensation                 | Table, permission pair, endpoints, the doctor's own read                  | **Done** |
| 5   | Web                          | Fee grid on Clinic, fees + pay on the doctor, the fee on the booking form | **Done** |

Detail on each:

- **Station 1** — `/db-migration` is the prescribed skill and this is exactly what
  it is for. The data migration is the interesting half: copy the two columns into
  `fee_schedule_entries` rows scoped to `(doctor, branch)` before dropping them,
  in the same migration, or a clinic loses its prices. ⚠️ Never edit an applied
  migration in place — Prisma checksums it.
- **Station 2** — the resolver, plus `GET/PUT` for the clinic grid and the
  doctor's overrides. Reuses `billing.invoice.*`? **No** — fees are configuration,
  not invoicing. Expect a new pair or an existing settings code; decide it here
  and write the reasoning down.
- **Station 3** — touches `bookAppointment` and `rescheduleAppointment`, and
  rewrites `resolveCharge()` to read `appointments.booked_fee` plus the sum of
  patient-initiated reschedule charges. ⚠️ The invoice engine's
  `appointment-billing.test.ts` (22 cases) is the regression net; expect several
  of its expectations to move, and read Phase 8's section of the invoice log
  before changing them.
- **Station 4** — small, and separable from everything above. Could be done first
  if the fee work stalls.
- **Station 5** — ⚠️ **load the `frontend-design` skill BEFORE writing any JSX**,
  per CLAUDE.md, and read `apps/web/AGENTS.md`: this is Next.js 16, where
  `middleware.ts` is `proxy.ts`. Phase 9 of the invoice engine learned that a
  clean typecheck says nothing about `next build`.

---

## Station 1 — Schema, RLS, data migration

**Done.** Migration `20260812090000_fee_schedule_and_doctor_compensation`
applied; `db:rls:check` 48 → **51**; grants re-applied (70 readable tables); api
healthy. ⚠️ **Not yet typechecked or tested** — validation is batched to the end.

- `fee_schedule_entries`, `doctor_compensation`, `appointment_reschedules`;
  `appointments.booked_fee`; enums `PayoutInterval`, `RescheduleInitiator`.
- `doctor_branch_settings.{consultation_fee,follow_up_fee}` copied into
  `NEW`/`FOLLOW_UP` entries at the (doctor, branch) level, then dropped.
  `follow_up_free_days` kept.
- ⚠️ **WALK_IN, TELECONSULT and PROCEDURE are now unpriced** for every existing
  clinic. They had no column, so the migration has nothing to copy; they were
  previously billed at the consultation rate. Deliberate — a teleconsult billed
  as an in-person visit is a wrong bill that looks right.
- `fee_schedule_entries_scope_key` is `NULLS NOT DISTINCT` (both scope columns
  are nullable by design). Prisma's plain unique index was replaced.
- RLS: `fee_schedule_entries` is in BOTH loops and is the only table in the repo
  where a NULL `branch_id` is meaningful — the branch policy's `IS NULL OR`
  branch is what makes clinic-wide inheritance visible to a branch-scoped
  caller. `doctor_compensation` is org-scoped only.
- 14 `tenant-isolation.test.ts` cases added, including both directions of the
  NULL-branch rule and the duplicate-clinic-wide-price refusal.
- Callers updated off the dropped columns: `doctorBranchSettingRequest` and
  `doctorBranchSettingDetail` in contracts, `doctor.service.ts` (select, mapper,
  `setBranchSetting`), and the web doctor profile's panel (now "Clinics").
- ⚠️ The migration's comment was corrected AFTER it was applied, so its
  `_prisma_migrations.checksum` was updated by hand to match. Safe only because
  nothing is committed and no other database has it.

## Station 2 — Resolution engine and fee APIs

**Done.**

- `services/fees/fee-schedule.service.ts` — the ONLY implementation of §0.5.
  `resolveFee` takes a `tx`; one query fetches every candidate row for a fee type
  and `pick()` ranks it. `hasAnyFee` is what separates `NO_RATE_CARD` from
  `NO_FEE_SET`.
- Contracts: `packages/contracts/src/fees.ts`. Amounts are minor units on the
  wire, converted at the single boundary (`invoicing/money.ts`).
  `KNOWN_FEE_TYPES` is advisory — the column stays `varchar`.
- **Permission decision** (§0.6 asked for one and here it is): a new pair,
  `billing.fee_schedule.read` / `.manage`. Not `billing.invoice.*` (that governs
  a bill that exists; this decides what every future bill says) and not a
  settings code (a wrong setting annoys, a wrong fee overcharges). Read is held
  by BRANCH_ADMIN, DOCTOR, RECEPTIONIST and ACCOUNTANT — the desk is quoted the
  fee while booking. Manage lands only on ORG_OWNER/ORG_ADMIN through their
  "everything except" definition, mirroring `BILLING_TAX_MANAGE`.
- Routes: `GET|PUT /v1/fee-schedule`, `GET /v1/fee-schedule/quote`,
  `GET /v1/fee-schedule/entries`, and `GET|PUT /v1/doctors/:doctorId/fees`.
  A `null` amount deletes the row; a fee type not named is left alone.
- ⚠️ `PUT` is read-then-write rather than `upsert`: two of the four unique
  columns are nullable and Prisma cannot express `NULLS NOT DISTINCT` in a
  compound-unique input. The index is what refuses a racing duplicate.

## Station 3 — Booking freeze and reschedule charge

**Done.**

- `freezeFee()` in `appointment.service.ts` writes `appointments.booked_fee` at
  `createAppointment` and `createFollowUp`. `FOLLOW_UP` falls back to `NEW`;
  nothing else falls back to anything.
- `rescheduleAppointment` gained `initiatedBy` (defaults to `CLINIC` — the
  un-charged direction) and `reason` (required when `PATIENT`, enforced in the
  contract). It writes an `appointment_reschedules` row every time, re-resolves
  `booked_fee` only when the DOCTOR changes, and resolves a `RESCHEDULE` charge
  only for a patient-initiated move.
- ⚠️ **`updateAppointment` re-freezes when the VISIT TYPE changes.** Not in the
  original plan; a booking corrected NEW → TELECONSULT still carrying the
  in-person fee is the wrong bill that looks right. Same narrow exception to
  decision 9 as the doctor swap, for the same reason.
- `resolveCharge()` now reads `booked_fee` and only resolves live when it is
  null (visits booked before this feature). The free-follow-up window is
  unchanged and still on `doctor_branch_settings`; its ABSENCE now means "no free
  window" rather than "no rate card".
- Reschedule charges are **separate invoice lines**, one per charged move, added
  by `resolveLines()`. `unitPriceMinor` overrides the consultation only.
  `appointmentBilling` gained `rescheduleChargeMinor` / `rescheduleCount`.
- ⚠️ **The move line is rated `CONSULTATION`**, deliberately. A category of its
  own resolves to `UNRATED` at every clinic on the platform, and an UNRATED line
  refuses to issue — so a rescheduling fee would block the bill it appears on.

## Station 4 — Doctor compensation

**Done.**

- `services/doctor/doctor-compensation.service.ts`, `GET|PUT
/v1/doctors/:doctorId/compensation`.
- `doctor.compensation.read` / `.manage` per decision 8. BRANCH_ADMIN holds
  neither; ACCOUNTANT holds the read only (they already hold
  `billing.doctor_payout.manage` and cannot pay a figure they cannot see).
- The GET is authorized on `DOCTOR_READ` and narrowed in the service:
  `callerHasPermission(COMPENSATION_READ)` **or** the profile is your own.
  ⚠️ It refuses with **403, not 404** — the only such place in that router. The
  doctor's existence is not the secret; the number is.
- Clearing writes nulls rather than deleting the row, so `updated_by` survives.

## Station 5 — Web

**Done.**

- `components/tenant/fee-schedule-grid.tsx` — one component, both scopes. Every
  row states its provenance; an inherited value is the input's PLACEHOLDER, not
  its value, so saving an untouched row cannot pin the clinic's price onto a
  doctor. The sheet is re-read after every save rather than patched, because
  what a box now inherits is a server answer.
- `components/tenant/doctor-pay-panel.tsx` — read-only without `.manage`,
  including for the doctor themselves.
- Server actions in `app/(tenant)/t/[slug]/(app)/fees/actions.ts` (no `page.tsx`
  — shared by the Clinic screen, both doctor screens and the board).
- Wired into: the Clinic screen (`What a visit costs`), `/doctors/[doctorId]`
  and `/profile` (both money panels), and the booking form's `FeeLine`, which
  calls the quote endpoint so the desk sees the price it is about to freeze.
- The billing panel now shows the move charge and the reworded unpriced copy.
- ⚠️ **There is still no reschedule UI.** The endpoint takes `initiatedBy` and
  `reason`; nothing in `apps/web` calls it yet — there was no reschedule screen
  before this work either. A future one must ask who requested the move, or
  every move silently defaults to `CLINIC` and is free.

## Validation — one batched round, 2026-08-10

Everything below was run after all four stations, not per station.

- `turbo run typecheck lint` — 35/36; `@rcln/api#typecheck` OOMs in the runner
  and passes standalone (`tsc -p tsconfig.test.json`, exit 0). Documented.
- API tests: **884 pass** (537 + 347), up from the 847 baseline.
  `db:rls:check` **51**. `apps/web` typecheck and `eslint --max-warnings 0`
  clean. `pnpm kb` regenerated: 2802 symbols, 221 routes. api healthy.
- Fixed while validating:
  - **The new permission codes have to be seeded.** `pnpm --filter @rcln/db seed`
    → 106 permissions. Without it every new route answers 403 to the owner, and
    nothing says why. Any environment taking this branch needs the reseed.
  - `doctors.test.ts` still asserted the dropped `consultation_fee` column
    (station 1 left it stale). Rewritten as "where a doctor consults"; the money
    cases moved to the new suite.
  - `appointment-billing.test.ts` seeded fees through `branch-settings`. Now uses
    `PUT /doctors/:id/fees`. ⚠️ Its unpriced block also has to NULL
    `appointments.booked_fee`, because the visit is booked while the grid is
    still filled in and the freeze is doing exactly its job.
  - Station 1's 14 `tenant-isolation` cases had never been run: four fixture
    UUIDs contained non-hex characters (`…u1`, `…r2`, `…p2`, `…g2`) and the
    whole block errored. All 183 cases pass now.
  - An unused `money` schema left in `contracts/doctors.ts` by station 1.
- New suite: `tests/integration/fee-schedule.test.ts`, **25 cases** — the four
  scopes in order, zero-is-a-price, clearing an override, partial saves, the
  quote, the freeze surviving a price rise, the doctor-swap re-resolve, both
  unpriced reasons, the FOLLOW_UP→NEW fallback, clinic vs patient moves, the
  reason requirement, and the reason staying out of `audit_logs`.
- ⚠️ Discovered, NOT introduced by this work, and left alone:
  `doctor_profiles_organization_id_registration_number_key` is `NULLS NOT
DISTINCT`, so a clinic may hold exactly **one** doctor with no registration
  number. The seeding helper in the new suite works around it. Worth a decision
  of its own.
- `next build` was not re-run; it was already failing on
  `/(marketing)/billing/sandbox` before this work.
